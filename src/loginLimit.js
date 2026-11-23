// 登录节流（D1 原子计数）
//
// 三层：并发原子性（单语句自增）、归因（按什么键计数）、复位语义（何时清零、封多久）。
//
// 计数键：
//   lf:ipu:<ip>:<user>  同一出口对同一账号 —— 主闸门，阈值低，不牵连同网段其他人
//   lf:u:<user>         同一账号（跨 IP）—— 防分布式爆破；staff 阈值放宽
//   lf:ip:<ip>          同一出口总量 —— 防洪泛；阈值高，避免线下共用 Wi-Fi 互相伤害
//
// 复位语义：
//   - 窗口 1 小时 ≫ 封禁上限 15 分钟，保证"按提示等完再试"必然落在重置条件内
//   - 封禁期内只读不写：否则每次重试都刷新 updated_at，计数永远清不掉（会锁死用户）
//   - 成功登录只清"本人"的键，不清 IP 计数：否则登录一次就成了攻击者的计数器重置开关
//
// 本文件不依赖 Workers 运行时（只用 env.DB 的 prepare/bind/first/all/run 接口），
// 因此可以在 tests/ 里用 sqlite 驱动直接验证上面这些不变量。
export const LOGIN_IP_MAX = 50;
export const LOGIN_COMBO_MAX = 5;
export const LOGIN_USER_MAX = 20;
export const LOGIN_STAFF_MAX = 60;
export const LOGIN_BLOCK_BASE_MS = 60 * 1000;
export const LOGIN_BLOCK_MAX_MS = 15 * 60 * 1000;
export const LOGIN_WINDOW_MS = 60 * 60 * 1000;
export const LOGIN_KEEP_MS = 24 * 60 * 60 * 1000; // 计数行保留 24 小时，Cron 清理

// 结构变更只走 migrations/：这里**不再执行 ALTER**。
//
// 运行时补列表面上是"提高可用性"，实际制造三件事：迁移状态不可知、失败被静默、
// 以及部署窗口内的竞态——多个 isolate 同时 PRAGMA 读到"无 blocks"，同时 ALTER，
// 只有一个成功，其余报 duplicate column；若那批请求因此跳过限流，就等于在
// "部署后第一波突发流量"上开了一个无保护的窗口（实测 20 并发放行 19 次）。
//
// 所以这里只做检测：缺列就抛带标记的错误，由调用方决定降级方式。
export function loginSchemaMismatch(detail) {
  const err = new Error('login_fails schema not ready: ' + detail);
  err.schemaMismatch = true;
  return err;
}

let loginSchemaReady = null;
export function ensureLoginSchema(env) {
  if (!loginSchemaReady) {
    loginSchemaReady = (async () => {
      // 全新库（本地/全新环境）直接按最终结构建表；表已存在时是空操作，不会报错
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_fails (
        key TEXT PRIMARY KEY,
        n INTEGER NOT NULL DEFAULT 0,
        blocks INTEGER NOT NULL DEFAULT 0,
        until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`).run();
      const info = await env.DB.prepare('PRAGMA table_info(login_fails)').all();
      const cols = (info.results || []).map((c) => c.name);
      if (!cols.includes('blocks')) {
        console.error('[login] login_fails 缺 blocks 列，限流无法工作；请先执行 migrations/0009_add_login_fails_blocks.sql');
        throw loginSchemaMismatch('missing column blocks');
      }
    })().catch((err) => { loginSchemaReady = null; throw err; });
  }
  return loginSchemaReady;
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

/**
 * 记录一次尝试并判断是否超限。返回 { blocked, retry, fresh }（retry 为秒）。
 * 1) 已被封禁：只读返回，不写库（fresh=false：这次请求没有产生新封禁）；
 * 2) 未封禁：单语句原子自增（并发不丢计数）；
 * 3) 越过阈值：用 blocks 计"第几次被封"决定时长，`WHERE until <= now` 保证并发下只发一次。
 *
 * fresh 供调用方决定要不要写审计：封禁期内每次重试都写一行，等于把未认证端点
 * 变成 D1 写入放大器。一次封禁只记一行，证据价值不变。
 *
 * now 可注入，仅供测试控制时钟；生产调用不传。
 */
export async function hitLimit(env, key, max, now = Date.now()) {
  const rec = await env.DB.prepare('SELECT until FROM login_fails WHERE key = ?').bind(key).first();
  if (rec && Number(rec.until) > now) {
    return { blocked: true, fresh: false, retry: Math.max(1, Math.ceil((Number(rec.until) - now) / 1000)) };
  }

  const row = await env.DB.prepare(
    `INSERT INTO login_fails (key, n, blocks, until, updated_at) VALUES (?, 1, 0, 0, ?)
     ON CONFLICT(key) DO UPDATE SET
       n = CASE WHEN ? - login_fails.updated_at > ? OR (login_fails.until > 0 AND login_fails.until <= ?)
                THEN 1 ELSE login_fails.n + 1 END,
       blocks = CASE WHEN ? - login_fails.updated_at > ? THEN 0 ELSE login_fails.blocks END,
       until = CASE WHEN ? - login_fails.updated_at > ? OR (login_fails.until > 0 AND login_fails.until <= ?)
                    THEN 0 ELSE login_fails.until END,
       updated_at = ?
     RETURNING n`
  ).bind(key, now, now, LOGIN_WINDOW_MS, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now, now).first();

  const n = Number(row && row.n) || 0;
  if (n <= max) return { blocked: false, fresh: false, retry: 0 };

  // 阶梯按"第几次被封"增长：60s → 120s → 240s → …（封禁期内不会重复触发，见上面的只读判断）
  const upd = await env.DB.prepare(
    `UPDATE login_fails
        SET blocks = blocks + 1,
            until = ? + MIN(?, ? * (1 << MIN(blocks, 8)))
      WHERE key = ? AND until <= ?
      RETURNING until`
  ).bind(now, LOGIN_BLOCK_MAX_MS, LOGIN_BLOCK_BASE_MS, key, now).first();

  if (upd) return { blocked: true, fresh: true, retry: Math.ceil((Number(upd.until) - now) / 1000) };
  const again = await env.DB.prepare('SELECT until FROM login_fails WHERE key = ?').bind(key).first();
  const until = Number(again && again.until) || 0;
  return { blocked: true, fresh: false, retry: Math.max(1, Math.ceil((until - now) / 1000)) };
}

export async function clearLimit(env, keys) {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  const marks = list.map(() => '?').join(',');
  try {
    await env.DB.prepare(`DELETE FROM login_fails WHERE key IN (${marks})`).bind(...list).run();
  } catch { /* 清理失败不影响主流程 */ }
}

// Cron：清掉 24 小时没动过的计数行，避免被随机用户名/扫描撑大
export async function pruneLoginFails(env, now = Date.now()) {
  try {
    await env.DB.prepare('DELETE FROM login_fails WHERE updated_at < ?').bind(now - LOGIN_KEEP_MS).run();
  } catch { /* 表不存在或清理失败都忽略 */ }
}
