/* ==========================================================
   日志与审计 · 统一出口
   ----------------------------------------------------------
   两条通道，职责分开，不要混用：

   1) 控制台（console）—— 运行时日志
      单行 JSON，字段固定，供 wrangler tail / Workers Logs / Logpush 检索。
      只描述"发生了什么"，不承担举证责任；有采样、会随平台保留期消失。

   2) D1 audit_logs —— 审计流水
      只写需要事后追责的事件：注册/登录/改密、管理操作、公告变更、
      未捕获异常、前端报错。每次写入都带 request id，可与控制台日志对上。

   约束（写在这里比写在注释里可靠）：
   - 绝不写入口令、验证码、令牌、Cookie；redact() 按 key 兜底再拦一道。
   - 审计写入必须"绝不抛异常"：日志系统不能成为故障源。
   - 审计写入有每分钟预算：登录失败这类可被刷的路径只能打 console，
     否则 random 用户名扫描会把 D1 写放大。
   ========================================================== */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

const MAX_DEPTH = 3
const MAX_STRING = 400
const MAX_ARRAY = 20
const MAX_STACK = 1200

// 命中即整体替换为 ***。
// 两段式：精确名单负责普通词，后缀规则负责 camelCase / snake_case 变体
// （confirmPassword / verificationCode / authToken / apiKey 这类），
// 同时放过 error_code / status_code 这类"叫 code 但不是凭据"的字段。
//
// 这是**约定式**覆盖，不是完备的：按 key 结尾识别，所以 `newPasswordConfirm`
// 这类"敏感词在中间"的命名仍会漏。新字段请沿用 password/passwd/pwd/token/
// secret/code/salt/hash/cookie/jwt/otp/csrf 结尾，这条约定比正则更可靠。
// 误伤方向（postcode、decode 被打码）是安全的，不用处理。
const SENSITIVE_KEY = /^(password|passwd|pwd|secret|token|session|session_?id|code|code_hash|salt|hash|authorization|cookie|jwt|otp|csrf)$/i
const SENSITIVE_SUFFIX = /(password|passwd|pwd|token|secret|code|salt|hash|cookie|api[_-]?key|jwt|otp|csrf)$/i
const SAFE_CODE = /^(error|err|status|http|result)_?code$/i

export function isSensitiveKey(key) {
  const k = String(key)
  if (SENSITIVE_KEY.test(k)) return true
  if (!SENSITIVE_SUFFIX.test(k)) return false
  return !SAFE_CODE.test(k)
}

export const AUDIT_KEEP_DAYS = 90
const AUDIT_MAX_META = 2000
const AUDIT_BUDGET_PER_MIN = 120

function truncate(s, n = MAX_STRING) {
  const str = String(s)
  return str.length > n ? str.slice(0, n) + '…(+' + (str.length - n) + ')' : str
}

// 任意值 → 可安全序列化、无敏感字段、长度可控的结构
export function redact(value, depth = 0) {
  if (value == null) return value
  if (typeof value === 'string') return truncate(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return String(value)
  if (value instanceof Error) return describeError(value)
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return '[array:' + value.length + ']'
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1))
    if (value.length > MAX_ARRAY) head.push('…(+' + (value.length - MAX_ARRAY) + ')')
    return head
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[object]'
    const out = {}
    for (const k of Object.keys(value)) {
      out[k] = isSensitiveKey(k) ? '***' : redact(value[k], depth + 1)
    }
    return out
  }
  return String(value)
}

// 错误只留可复现的部分：类型、消息、前若干帧。不透传整个对象（可能含请求体）
export function describeError(err) {
  if (!err) return null
  if (!(err instanceof Error)) return redact(err)
  const stack = String(err.stack || '').split('\n').slice(0, 6).join('\n')
  return {
    name: truncate(err.name || 'Error', 60),
    message: truncate(err.message || '', 300),
    stack: stack.length > MAX_STACK ? stack.slice(0, MAX_STACK) + '…' : stack
  }
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj)
  } catch {
    try {
      return JSON.stringify({ level: obj.level, event: obj.event, ts: obj.ts, err: 'stringify_failed' })
    } catch { return '{"level":"error","event":"log.stringify_failed"}' }
  }
}

/**
 * 创建带固定上下文的 logger。
 * @param {object} env  Worker env（读 LOG_LEVEL，默认 info；debug 在线上默认关闭）
 * @param {object} fields 每条日志都会带的字段，如 { rid }
 */
export function createLogger(env, fields = {}) {
  const conf = String((env && env.LOG_LEVEL) || 'info').toLowerCase()
  const min = LEVELS[conf] == null ? LEVELS.info : LEVELS[conf]
  const base = { ...fields }

  function emit(level, event, extra) {
    if (LEVELS[level] < min) return
    // 业务字段在前，时间/级别/事件名在后：外部传入的同名字段不能覆盖元信息
    const rec = { ...(extra ? redact(extra) : {}), ...base, ts: new Date().toISOString(), level, event }
    const line = safeStringify(rec)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  return {
    fields: base,
    debug: (event, extra) => emit('debug', event, extra),
    info: (event, extra) => emit('info', event, extra),
    warn: (event, extra) => emit('warn', event, extra),
    error: (event, extra) => emit('error', event, extra),
    child: (extra) => createLogger(env, { ...base, ...extra })
  }
}

// 请求元信息：只取与排障/追责相关的最小集合，不碰 query 与 body
export function requestMeta(request) {
  try {
    const url = new URL(request.url)
    return {
      ip: String(request.headers.get('cf-connecting-ip') || '').slice(0, 64),
      ua: String(request.headers.get('user-agent') || '').slice(0, 160),
      method: String(request.method || '').slice(0, 12),
      path: url.pathname.slice(0, 160)
    }
  } catch {
    return { ip: '', ua: '', method: '', path: '' }
  }
}

// 邮箱只留域名与前两位，够定位账号又不把整串落库
export function maskEmail(email) {
  const s = String(email || '')
  const at = s.indexOf('@')
  if (at <= 0) return s ? '***' : ''
  return s.slice(0, Math.min(2, at)) + '***' + s.slice(at)
}

// ---------- D1 审计流水 ----------
//
// 表结构以 migrations/0010_add_audit_logs.sql 为唯一来源。
// 默认不在运行时建表：日志系统不该在请求路径上跑 DDL（多 isolate 冷启动会争 D1 写锁，
// 且兜底建出来的库不会写 schema_migrations，版本状态与事实不符）。
// 只有显式设置 AUDIT_BOOTSTRAP=1 时才兜底建表，用于「代码先上线、迁移还没跑」的窗口期。

let bootstrapReady = null
export function bootstrapAuditSchema(env) {
  if (String((env && env.AUDIT_BOOTSTRAP) || '') !== '1') return Promise.resolve(false)
  if (!bootstrapReady) {
    bootstrapReady = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        event TEXT NOT NULL,
        actor_id INTEGER,
        actor_name TEXT NOT NULL DEFAULT '',
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 0,
        rid TEXT NOT NULL DEFAULT '',
        ua TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT ''
      )`).run()
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC)').run()
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_audit_level_ts ON audit_logs(level, ts DESC)').run()
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit_logs(event, ts DESC)').run()
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, ts DESC)').run()
      return true
    })().catch((err) => { bootstrapReady = null; throw err })
  }
  return bootstrapReady
}

// 写入预算（每个 isolate、每分钟）：
//   非关键事件 120 条；关键事件 600 条 —— **有上限，不是"不限"**：
//   request.error 可以由外部请求触发，完全放行就等于留了一条不限速的 D1 写通道。
//
// 丢弃必须留痕，且要能回答两个问题：
//   「丢了没有」→ 每分钟每种 kind 的第一条丢弃立刻写一行 audit.dropped（带请求上下文）；
//   「丢了多少」→ 分钟翻页时补一行汇总（上一分钟的总数），否则计数只活在 isolate 内存里。
// 只打 console 等于回到静默：console 有采样与保留期，事后查不到那个窗口丢了多少。
const CRITICAL_EVENT = /^(admin\.|auth\.password\.|request\.error|cron\.)/
const DROPPED_EVENT = 'audit.dropped'
const AUDIT_CRITICAL_PER_MIN = 600

let auditBudget = {
  minute: -1,
  n: 0, crit: 0,
  dropped: 0, droppedNormal: 0, droppedCritical: 0
}

export function auditBudgetSnapshot() {
  return { ...auditBudget }
}

// 表缺失只在首次与每 10 分钟提醒一次，避免迁移没跑时每个请求刷一行
let auditMissingAt = 0

function clampStr(v, n) {
  return String(v == null ? '' : v).slice(0, n)
}

// meta 必须是合法 JSON，且长度必须真的收敛在 AUDIT_MAX_META 内。
// 注意 preview 在序列化时会把 " 和 \ 翻倍，所以要在"最终字符串"上收敛，不能只算原始长度。
export function metaJson(value) {
  let raw
  try {
    raw = JSON.stringify(redact(value || {}))
  } catch {
    return ''
  }
  if (!raw || raw === '{}') return ''
  if (raw.length <= AUDIT_MAX_META) return raw

  const size = raw.length
  // 切点可能落在转义序列中间，先把尾部半截的 " 或 \ 去掉
  let head = raw.slice(0, AUDIT_MAX_META - 80).replace(/[\\"]+$/, '')
  let out = JSON.stringify({ _truncated: true, _size: size, preview: head })
  while (out.length > AUDIT_MAX_META && head.length > 0) {
    const excess = out.length - AUDIT_MAX_META
    head = head.slice(0, Math.max(0, head.length - Math.ceil(excess / 2) - 8)).replace(/[\\"]+$/, '')
    out = JSON.stringify({ _truncated: true, _size: size, preview: head })
  }
  return out.length <= AUDIT_MAX_META ? out : JSON.stringify({ _truncated: true, _size: size })
}

// 单条落库。所有写入（含 audit.dropped）都走这里，异常一律降级成控制台日志。
async function writeRow(env, rec, event, level) {
  try {
    if (String(env.AUDIT_BOOTSTRAP || '') === '1') await bootstrapAuditSchema(env)
    await env.DB.prepare(
      `INSERT INTO audit_logs
         (ts, level, event, actor_id, actor_name, target_type, target_id, ip, method, path, status, rid, ua, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      Date.now(),
      level,
      event,
      rec.actor_id == null || rec.actor_id === '' ? null : Number(rec.actor_id) || null,
      clampStr(rec.actor_name, 40),
      clampStr(rec.target_type, 24),
      clampStr(rec.target_id, 64),
      clampStr(rec.ip, 64),
      clampStr(rec.method, 12),
      clampStr(rec.path, 160),
      Number(rec.status) || 0,
      clampStr(rec.rid, 80),
      clampStr(rec.ua, 160),
      metaJson(rec.meta)
    ).run()
    auditMissingAt = 0
  } catch (err) {
    // 审计失败只能降级成控制台日志：不能把异常抛回请求路径
    const msg = String((err && err.message) || '')
    if (/no such table/i.test(msg)) {
      if (Date.now() - auditMissingAt > 10 * 60 * 1000) {
        auditMissingAt = Date.now()
        try {
          console.warn(safeStringify({
            ts: new Date().toISOString(), level: 'warn', event: 'audit.table.missing',
            hint: '执行 migrations/0010_add_audit_logs.sql（或临时设 AUDIT_BOOTSTRAP=1）'
          }))
        } catch { /* 彻底放弃 */ }
      }
      return
    }
    try {
      console.warn(safeStringify({ ts: new Date().toISOString(), level: 'warn', event: 'audit.write.fail', err: describeError(err) }))
    } catch { /* 彻底放弃 */ }
  }
}

/**
 * 写一条审计记录。**永不抛异常**。
 *
 * 传 ctx 时用 ctx.waitUntil 异步写（不占请求时延）；Cron 等已返回的上下文
 * 请传 null 并 await 返回值——此时再调用 waitUntil 会报错。
 *
 * @param {object} env
 * @param {object|null} ctx
 * @param {object} rec { event, level, actor_id, actor_name, target_type, target_id,
 *                       status, ip, method, path, rid, ua, meta }
 */
export function audit(env, ctx, rec) {
  const task = (async () => {
    if (!env || !env.DB) return

    const event = clampStr(rec.event || 'unknown', 64)
    const minute = Math.floor(Date.now() / 60000)

    if (auditBudget.minute !== minute) {
      const prev = auditBudget
      auditBudget = { minute, n: 0, crit: 0, dropped: 0, droppedNormal: 0, droppedCritical: 0 }
      // 分钟翻页时补写上一分钟的汇总：单个 isolate 在翻页前崩掉会丢这条，
      // 但比"只在内存里"强——至少常态下能回答"那个窗口丢了多少"
      if (prev.minute >= 0 && prev.dropped > 0) {
        await writeRow(env, {
          level: 'warn',
          meta: {
            minute: prev.minute, kind: 'summary', dropped: prev.dropped,
            droppedNormal: prev.droppedNormal, droppedCritical: prev.droppedCritical,
            budgetPerMin: AUDIT_BUDGET_PER_MIN, criticalPerMin: AUDIT_CRITICAL_PER_MIN
          }
        }, DROPPED_EVENT, 'warn')
      }
    }

    const level = ['debug', 'info', 'warn', 'error'].includes(rec.level) ? rec.level : 'info'

    // audit.dropped 自己不受预算约束，否则丢弃记录会被丢弃（递归）
    if (event !== DROPPED_EVENT) {
      const critical = CRITICAL_EVENT.test(event)
      const cap = critical ? AUDIT_CRITICAL_PER_MIN : AUDIT_BUDGET_PER_MIN
      const used = critical ? auditBudget.crit : auditBudget.n
      if (used >= cap) {
        auditBudget.dropped += 1
        const firstOfKind = critical
          ? (auditBudget.droppedCritical += 1) === 1
          : (auditBudget.droppedNormal += 1) === 1
        // 普通与关键各自放行第一条：同分钟里"普通先打满"不该掩盖"关键也被丢"
        if (firstOfKind) {
          try {
            console.warn(safeStringify({
              ts: new Date().toISOString(), level: 'warn', event: DROPPED_EVENT,
              kind: critical ? 'critical' : 'normal', path: rec.path || '',
              budgetPerMin: AUDIT_BUDGET_PER_MIN, criticalPerMin: AUDIT_CRITICAL_PER_MIN, minute
            }))
          } catch { /* 彻底放弃 */ }
          await writeRow(env, {
            level: 'warn',
            // 带上触发丢弃的这次请求上下文：洪水最该回答的是"哪条路径、哪个出口打满的"
            ip: rec.ip, method: rec.method, path: rec.path, rid: rec.rid,
            actor_id: rec.actor_id, actor_name: rec.actor_name,
            meta: {
              minute, kind: critical ? 'critical' : 'normal',
              budgetPerMin: AUDIT_BUDGET_PER_MIN, criticalPerMin: AUDIT_CRITICAL_PER_MIN
            }
          }, DROPPED_EVENT, 'warn')
        }
        return
      }
      if (critical) auditBudget.crit += 1
      else auditBudget.n += 1
    }

    await writeRow(env, rec, event, level)
  })()

  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task) } catch { /* 事件已结束：让任务自己跑完 */ }
  }
  return task
}

export function auditKeepDays(env) {
  const n = Number(env && env.AUDIT_KEEP_DAYS)
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : AUDIT_KEEP_DAYS
}

// 按保留期清理；返回删除行数。表不存在时抛错，由调用方决定是否降级。
export async function pruneAuditLogs(env, days) {
  const keep = Number(days) > 0 ? Number(days) : auditKeepDays(env)
  const cutoff = Date.now() - keep * 24 * 60 * 60 * 1000
  const r = await env.DB.prepare('DELETE FROM audit_logs WHERE ts < ?').bind(cutoff).run()
  return (r.meta && r.meta.changes) || 0
}

// LIKE 里的通配符要转义，否则搜 "100%" 会命中所有记录
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m)
}
