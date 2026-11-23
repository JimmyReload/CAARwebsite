// 面板数据（站内信 / 管理台）的客户端预加载缓存
//
// 目的：登录后只要访问站内任意页面，就在后台把 /api/inbox（管理台再加 /api/admin/overview）
// 取回来；用户点开「成员面板 / 管理后台」时直接渲染，不再等一次网络往返。
// 两层缓存：模块内存（同一次会话内的路由切换）+ sessionStorage（刷新后仍可用）。
// 进入面板时仍会静默回源一次，所以是「先出内容，再刷新」，不会卡在旧数据上。
import api from './api'

const KEY_INBOX = 'caar:inbox:v1'
const KEY_OVERVIEW = 'caar:overview:v1'
const KEY_USER = 'caar:me:v1'
const TTL_MS = 5 * 60 * 1000

const memory = { inbox: null, overview: null } // { userId, at, data }
const inFlight = { inbox: null, overview: null }

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
  const entry = { userId, at: Date.now(), data }
  memory[slot] = entry
  try { sessionStorage.setItem(key, JSON.stringify(entry)) } catch { /* 超配额时只用内存 */ }
}

/* ---------- 登录态快照 ----------
   刷新时先按上次的登录态渲染，再等 /me 校验。否则每次刷新都要先等一次 /me，
   面板再快也快不过这一次往返。校验回来若是未登录/换了人，立刻清缓存并跳登录。 */

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

/* ---------- 站内信 ---------- */

export function readInboxCache(userId) { return read(KEY_INBOX, userId, 'inbox') }
export function writeInboxCache(userId, data) { write(KEY_INBOX, userId, data, 'inbox') }

/** 本地补丁：发送/收到消息后同步缓存，避免下次进面板看到旧的 */
export function patchInboxCache(userId, fn) {
  const cur = readInboxCache(userId)
  if (!cur) return
  const next = fn(cur)
  if (next) writeInboxCache(userId, next)
}

/** 全量拉取（同一时刻只允许一个），结果写缓存；会推进已读位
    冷启动时若预取请求还在路上，直接复用它，避免 /me 回来后又发一次同样的请求 */
export function fetchInbox(userId) {
  if (inFlight.inbox) return inFlight.inbox
  const boot = bootPromise
  const req = (boot || Promise.resolve(null))
    .then((d) => d || api('/inbox'))
    .then((d) => {
      writeInboxCache(userId, d)
      // 复用的是 mark=0 的预取数据，补一次已读推进（不阻塞渲染）
      if (boot && d && d.convId) api('/conversation/' + d.convId + '/read', { method: 'POST' }).catch(() => null)
      return d
    })
    .finally(() => { if (inFlight.inbox === req) inFlight.inbox = null })
  inFlight.inbox = req
  return req
}

/* ---------- 管理台 ---------- */

export function readOverviewCache(userId) { return read(KEY_OVERVIEW, userId, 'overview') }
export function writeOverviewCache(userId, data) { write(KEY_OVERVIEW, userId, data, 'overview') }

export function patchOverviewCache(userId, fn) {
  const cur = readOverviewCache(userId)
  if (!cur) return
  const next = fn(cur)
  if (next) writeOverviewCache(userId, next)
}

export function fetchOverview(userId) {
  if (inFlight.overview) return inFlight.overview
  const req = api('/admin/overview')
    .then((d) => { writeOverviewCache(userId, d); return d })
    .finally(() => { if (inFlight.overview === req) inFlight.overview = null })
  inFlight.overview = req
  return req
}

/* ---------- 预取 ---------- */

let bootPromise = null

/** 冷启动就和 /me 并行发出（不等 userId 回来），把首屏那一次往返也省掉 */
export function startInboxPrefetch() {
  if (!bootPromise) {
    bootPromise = api('/inbox?mark=0').catch(() => {
      // 未登录会 401：把标记清掉，登录后还能重新预取
      bootPromise = null
      return null
    })
  }
  return bootPromise
}

/** 后台预取：已有新鲜缓存或正在请求时直接复用，失败静默
    走 mark=0（只读），避免用户还没打开面板就把消息标成已读 */
export function prefetchPanel(user) {
  if (!user || !user.id) return
  if (!readInboxCache(user.id)) {
    const p = bootPromise || startInboxPrefetch()
    p.then((d) => {
      if (d) writeInboxCache(user.id, d)
      else if (!readInboxCache(user.id)) {
        api('/inbox?mark=0').then((x) => writeInboxCache(user.id, x)).catch(() => null)
      }
    })
  }
  // admin 与 superadmin 都进管理台，预取条件必须与路由守卫一致
  if (user.role !== 'user' && !readOverviewCache(user.id)) fetchOverview(user.id).catch(() => null)
}

export function clearPanelCache() {
  memory.inbox = null
  memory.overview = null
  bootPromise = null
  try {
    sessionStorage.removeItem(KEY_INBOX)
    sessionStorage.removeItem(KEY_OVERVIEW)
    sessionStorage.removeItem(KEY_USER)
  } catch { /* ignore */ }
}
