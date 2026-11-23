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

// 命中即整体替换为 ***。键名小写比较，覆盖 password / old_password / new_password /
// token / code / code_hash / salt / hash / authorization / cookie / api_key …
const SENSITIVE_KEY = /^(pass(word)?|pwd|old_?pass(word)?|new_?pass(word)?|secret|token|session|cookie|authorization|api_?key|apikey|salt|hash|code|code_hash)$/i

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
      out[k] = SENSITIVE_KEY.test(k) ? '***' : redact(value[k], depth + 1)
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

let auditSchemaReady = null
export function ensureAuditSchema(env) {
  if (!auditSchemaReady) {
    auditSchemaReady = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    })().catch((err) => { auditSchemaReady = null; throw err })
  }
  return auditSchemaReady
}

// 每个 isolate 每分钟的写入预算：防止被刷的路径把审计表撑爆（超出只留控制台日志）
let auditBudget = { minute: -1, n: 0 }

export function auditBudgetSnapshot() {
  return { minute: auditBudget.minute, n: auditBudget.n }
}

function clampStr(v, n) {
  return String(v == null ? '' : v).slice(0, n)
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
    const minute = Math.floor(Date.now() / 60000)
    if (auditBudget.minute !== minute) auditBudget = { minute, n: 0 }
    if (auditBudget.n >= AUDIT_BUDGET_PER_MIN) return
    auditBudget.n += 1

    const level = ['debug', 'info', 'warn', 'error'].includes(rec.level) ? rec.level : 'info'
    let meta = ''
    try {
      const raw = typeof rec.meta === 'string' ? rec.meta : JSON.stringify(redact(rec.meta || {}))
      meta = raw === '{}' ? '' : raw.slice(0, AUDIT_MAX_META)
    } catch { meta = '' }

    try {
      await ensureAuditSchema(env)
      await env.DB.prepare(
        `INSERT INTO audit_logs
           (ts, level, event, actor_id, actor_name, target_type, target_id, ip, method, path, status, rid, ua, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        Date.now(),
        level,
        clampStr(rec.event || 'unknown', 64),
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
        meta
      ).run()
    } catch (err) {
      // 审计失败只能降级成控制台日志：不能把异常抛回请求路径
      try {
        console.warn(safeStringify({ ts: new Date().toISOString(), level: 'warn', event: 'audit.write.fail', err: describeError(err) }))
      } catch { /* 彻底放弃 */ }
    }
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

// 按保留期清理；返回删除行数
export async function pruneAuditLogs(env, days) {
  const keep = Number(days) > 0 ? Number(days) : auditKeepDays(env)
  await ensureAuditSchema(env)
  const cutoff = Date.now() - keep * 24 * 60 * 60 * 1000
  const r = await env.DB.prepare('DELETE FROM audit_logs WHERE ts < ?').bind(cutoff).run()
  return (r.meta && r.meta.changes) || 0
}

// LIKE 里的通配符要转义，否则搜 "100%" 会命中所有记录
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m)
}
