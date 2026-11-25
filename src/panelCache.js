// 面板数据（站内信 / 管理台）的客户端预加载缓存
//
// 目的：登录后只要访问站内任意页面，就在后台把 /api/inbox（管理台再加 /api/admin/overview）
// 取回来；用户点开「成员面板 / 管理后台」时直接渲染，不再等一次网络往返。
// 两层缓存：模块内存（同一次会话内的路由切换）+ sessionStorage（刷新后仍可用）。
// 进入面板时仍会静默回源一次，所以是「先出内容，再刷新」，不会卡在旧数据上。
//
// 账号隔离（审计 F-02 / F-03 的修复点）：
//   · 在途请求按 userId（+ 读/只读语义）分区，同一账号同一代才复用；
//     不同账号永远不会拿到同一个 Promise —— 这是 F-02 的直接成因。
//   · 每次身份变化（换号 / 登出 / 首次确认）都推进 epoch。响应回来先比对 epoch 与 userId，
//     对不上就整份丢弃：既不写缓存，也不交给调用者（Promise 解析为 null）。
//   · 冷启动不再发「无身份预取」。预取只在 /me 确认身份之后发起，
//     避免把匿名请求的响应绑定到后来登录的某个账号。
//   · 身份未经 /me（或登录接口）确认时（verified=false）缓存只保留、不展示，
//     页面层据此隐藏私信与管理内容；正常 200 {user:null} 与网络失败在 App 层区分处理。
import api from './api'

const KEY_INBOX = 'caar:inbox:v1'
const KEY_OVERVIEW = 'caar:overview:v1'
const KEY_USER = 'caar:me:v1'
const TTL_MS = 5 * 60 * 1000

const memory = { inbox: null, overview: null } // { userId, at, data }

/* ── 认证代次 ────────────────────────────────────────────────────────
   epoch：身份一变就 +1。所有在途请求都带着发起时的 epoch，回来先比对。
   identity：当前身份（userId 或 null）；null 既可能是「还没确认」，也可能是「已确认未登录」，
   由 verified 区分。
   verified：当前身份是否已由服务端确认（/me 成功、登录成功、退出成功）。 */
let epoch = 0
let identity = null
let verified = false

// key -> { promise, epoch, userId }
const flights = { inbox: new Map(), overview: new Map() }

const norm = (id) => (id == null || id === '' ? null : Number(id))

function fresh(entry, userId) {
  return !!entry && entry.userId === userId && Date.now() - Number(entry.at || 0) < TTL_MS
}

function read(key, userId, slot) {
  if (!userId) return null
  if (fresh(memory[slot], userId)) return memory[slot].data
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (fresh(parsed, userId)) { memory[slot] = parsed; return parsed.data }
  } catch { /* 隐私模式下 sessionStorage 可能不可用 */ }
  return null
}

function write(key, userId, data, slot) {
  if (!userId || !data) return
  // 只允许写当前已确认账号的缓存：旧账号的迟到响应即使绕过 epoch 检查也写不进来
  if (identity !== norm(userId)) return
  const entry = { userId, at: Date.now(), data }
  memory[slot] = entry
  try { sessionStorage.setItem(key, JSON.stringify(entry)) } catch { /* 超配额时只用内存 */ }
}

/** 响应是否仍然属于「当前账号这一次认证」 */
function adoptable(ep, userId) {
  return ep === epoch && identity === norm(userId)
}

/** 清数据与在途请求，并推进代次。不动身份状态（谁在登录由 syncPanelAuth 负责）。 */
function invalidate() {
  epoch += 1
  flights.inbox.clear()
  flights.overview.clear()
  memory.inbox = null
  memory.overview = null
  try {
    sessionStorage.removeItem(KEY_INBOX)
    sessionStorage.removeItem(KEY_OVERVIEW)
    sessionStorage.removeItem(KEY_USER)
  } catch { /* ignore */ }
  return epoch
}

export function currentEpoch() { return epoch }
export function currentIdentity() { return identity }
export function isIdentityVerified() { return verified }

/** 页面刚打开时把「这份缓存属于谁」登记下来，但保留缓存本身（不应在启动时清掉自己的缓存）。
 *  只推进在途请求的代次，不动 sessionStorage。 */
export function adoptPanelIdentity(userId) {
  const next = norm(userId)
  if (next === identity) return false
  identity = next
  epoch += 1
  flights.inbox.clear()
  flights.overview.clear()
  return true
}

/** 身份确认结果同步进缓存层（App 在 /me、登录、退出时调用）。
 *  userId 变化即作废旧缓存与在途请求；同一账号只更新 verified。
 *  返回 true 表示发生了会作废缓存的身份变更。 */
export function syncPanelAuth(userId, isVerified) {
  const next = norm(userId)
  if (typeof isVerified === 'boolean') verified = isVerified
  if (next === identity) return false
  identity = next
  invalidate()
  return true
}

/** /me 网络失败或服务端错误：身份没有被确认，但也不能因此清掉缓存身份（可能只是断网）。
 *  只把 verified 置 false，页面层会隐藏敏感内容。 */
export function markPanelAuthUnverified() { verified = false }

/** 只清数据与在途请求（登出、换号时会由 syncPanelAuth/clearPanelCache 触发） */
export function clearPanelCache() { return invalidate() }

/** 彻底重置（含身份状态）；供登出流程与测试使用 */
export function resetPanelAuth() {
  identity = null
  verified = false
  return invalidate()
}

/* ── 站内信 ────────────────────────────────────────────────────────── */

export function readInboxCache(userId) { return read(KEY_INBOX, userId, 'inbox') }
export function writeInboxCache(userId, data) { write(KEY_INBOX, userId, data, 'inbox') }

/** 本地补丁：发送/收到消息后同步缓存，避免下次进面板看到旧的 */
export function patchInboxCache(userId, fn) {
  const cur = readInboxCache(userId)
  if (!cur) return
  const next = fn(cur)
  if (next) writeInboxCache(userId, next)
}

const inboxKey = (userId, mark) => (mark ? 'r:' : 'p:') + userId

/**
 * 全量拉取。mark=0 走只读预取（不推进已读位），mark=1（默认）进入面板时使用。
 * 同一账号同一语义且同一 epoch 才复用；跨账号一定另发请求。
 * 被身份变更作废的响应解析为 null，调用方必须当作「本次结果不可用」。
 */
export function fetchInbox(userId, opts = {}) {
  const uid = norm(userId)
  if (!uid) return Promise.resolve(null)
  const mark = opts.mark !== 0
  const key = inboxKey(uid, mark)
  const hit = flights.inbox.get(key)
  if (hit && hit.epoch === epoch) return hit.promise

  const ep = epoch
  const req = api('/inbox' + (mark ? '' : '?mark=0'))
    .then((d) => {
      if (!adoptable(ep, uid)) return null
      writeInboxCache(uid, d)
      return d
    })
    .finally(() => {
      const cur = flights.inbox.get(key)
      if (cur && cur.promise === req) flights.inbox.delete(key)
    })
  flights.inbox.set(key, { promise: req, epoch: ep, userId: uid })
  return req
}

/** 后台只读预取（mark=0：用户还没打开面板，不把消息标成已读） */
export function prefetchInbox(userId) {
  return fetchInbox(userId, { mark: 0 }).catch(() => null)
}

/**
 * 冷启动预取：只有身份已经确认时才有意义。
 * 未确认身份时不再发匿名 /inbox（审计 F-02：无身份预取不得绑定/复用给后来登录的账号）。
 */
export function startInboxPrefetch() {
  if (!verified || identity == null) return Promise.resolve(null)
  return prefetchInbox(identity)
}

/* ── 管理台 ────────────────────────────────────────────────────────── */

export function readOverviewCache(userId) { return read(KEY_OVERVIEW, userId, 'overview') }
export function writeOverviewCache(userId, data) { write(KEY_OVERVIEW, userId, data, 'overview') }

export function patchOverviewCache(userId, fn) {
  const cur = readOverviewCache(userId)
  if (!cur) return
  const next = fn(cur)
  if (next) writeOverviewCache(userId, next)
}

export function fetchOverview(userId) {
  const uid = norm(userId)
  if (!uid) return Promise.resolve(null)
  const hit = flights.overview.get(uid)
  if (hit && hit.epoch === epoch) return hit.promise

  const ep = epoch
  const req = api('/admin/overview')
    .then((d) => {
      if (!adoptable(ep, uid)) return null
      writeOverviewCache(uid, d)
      return d
    })
    .finally(() => {
      const cur = flights.overview.get(uid)
      if (cur && cur.promise === req) flights.overview.delete(uid)
    })
  flights.overview.set(uid, { promise: req, epoch: ep, userId: uid })
  return req
}

/* ── 预取 ──────────────────────────────────────────────────────────── */

/** 后台预取：已有新鲜缓存或正在请求时直接复用，失败静默
    只在身份已确认时执行；否则宁可不预取，也不把数据绑到不确定的账号上。 */
export function prefetchPanel(user) {
  if (!user || !user.id) return Promise.resolve(null)
  const uid = norm(user.id)
  if (!verified || identity !== uid) return Promise.resolve(null)

  const jobs = []
  if (!readInboxCache(uid)) jobs.push(prefetchInbox(uid))
  // admin 与 superadmin 都进管理台，预取条件必须与路由守卫一致
  if (user.role !== 'user' && !readOverviewCache(uid)) jobs.push(fetchOverview(uid).catch(() => null))
  return Promise.all(jobs).then(() => null)
}

/* ── 退出登录 ──────────────────────────────────────────────────────── */

/**
 * 退出登录：服务端确认之后才清本地身份与缓存。
 * 请求失败会抛错 —— 调用方必须提示重试，不能把「没清掉 Cookie」说成已退出。
 */
export async function logoutSession() {
  // Worker 要求带会话 Cookie 的写请求使用 application/json。
  // 即使登出没有业务字段也发送空对象，否则浏览器无正文 POST 可能被 Fetch 适配层
  // 表示成一个 body stream，却没有 Content-Type，触发 CSRF 闸门 415。
  await api('/logout', { method: 'POST', body: {} })
  clearPanelCache()
  identity = null
  verified = true // 已由服务端确认处于未登录状态
  return true
}

/* ── 登录态快照 ────────────────────────────────────────────────────── */

/* 刷新时先按上次的登录态渲染，再等 /me 校验。否则每次刷新都要先等一次 /me，
   面板再快也快不过这一次往返。快照只作占位：/me 确认前 verified=false，
   敏感内容不展示（审计 F-03）。 */

export function readUserCache() {
  try {
    const raw = sessionStorage.getItem(KEY_USER)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.data || !parsed.data.id) return null
    if (Date.now() - Number(parsed.at || 0) > TTL_MS) return null
    return parsed.data
  } catch { return null }
}

export function writeUserCache(user) {
  try {
    if (!user) sessionStorage.removeItem(KEY_USER)
    else sessionStorage.setItem(KEY_USER, JSON.stringify({ at: Date.now(), data: user }))
  } catch { /* 隐私模式忽略 */ }
}
