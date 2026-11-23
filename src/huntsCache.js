// 赛事列表的客户端预加载缓存
//
// 目的：登录后只要访问站内任意页面，就在后台把 /api/hunts 取回来，
// 用户点开「赛事总览」时直接渲染，不再等一次网络往返。
// 两层缓存：模块内存（同一次会话内的路由切换）+ sessionStorage（刷新后仍可用）。
// 打开页面时仍会静默回源一次，所以看到的是「先出内容，再刷新」而不是旧数据卡住。
//
// 账号隔离（与 panelCache 同一套机制）：
//   · 在途请求按 userId 分区，不同账号不共享 Promise；
//   · 身份变化（换号 / 登出）推进 epoch，旧响应回来一律丢弃，不写缓存；
//   · 身份未确认时 prefetch 直接跳过。
import api from './api'

const KEY = 'caar:hunts:v1'
const TTL_MS = 5 * 60 * 1000
const PRELOAD_IMAGES = 6

let memory = null // { userId, at, data }
let epoch = 0
let identity = null
let seq = 0
const flights = new Map() // userId -> { promise, epoch }
const latest = new Map() // userId -> 最新一次请求的序号（旧响应不得覆盖新数据）

const norm = (id) => (id == null || id === '' ? null : Number(id))

function fresh(entry, userId) {
  return !!entry && entry.userId === userId && Date.now() - Number(entry.at || 0) < TTL_MS
}

export function readHuntsCache(userId) {
  if (!userId) return null
  if (fresh(memory, userId)) return memory.data
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (fresh(parsed, userId)) { memory = parsed; return parsed.data }
  } catch { /* 隐私模式下 sessionStorage 可能不可用 */ }
  return null
}

export function writeHuntsCache(userId, data) {
  if (!userId || !data) return
  // 只允许写当前账号的缓存：迟到响应即使绕过 epoch 检查也写不进来
  if (identity !== norm(userId)) return
  const entry = { userId, at: Date.now(), data }
  memory = entry
  try { sessionStorage.setItem(KEY, JSON.stringify(entry)) } catch { /* 超配额时只用内存 */ }
}

function invalidate() {
  epoch += 1
  flights.clear()
  latest.clear()
  memory = null
  try { sessionStorage.removeItem(KEY) } catch { /* ignore */ }
  return epoch
}

/** 页面启动时登记缓存归属，保留现有缓存（不当作身份变化处理） */
export function adoptHuntsIdentity(userId) {
  const next = norm(userId)
  if (next === identity) return false
  identity = next
  epoch += 1
  flights.clear()
  return true
}

/** 身份变化时调用（换号/登出）：推进 epoch、清缓存与在途请求 */
export function syncHuntsAuth(userId) {
  const next = norm(userId)
  if (next === identity) return false
  identity = next
  invalidate()
  return true
}

export function isHuntsIdentity(userId) {
  return identity !== null && identity === norm(userId)
}

export function currentHuntsEpoch() { return epoch }

export function clearHuntsCache() { return invalidate() }

// 首屏几张缩略图提前进浏览器缓存，卡片出现时不再逐张闪
function preloadThumbs(list) {
  if (typeof Image === 'undefined') return
  for (const h of list.slice(0, PRELOAD_IMAGES)) {
    if (!h || !h.thumb) continue
    const img = new Image()
    img.decoding = 'async'
    img.src = h.thumb
  }
}

/**
 * 真正发起请求。同一账号同一时刻只跑一个（force 另起一路），不同账号互不影响。
 * 被身份变更作废的响应解析为 null，调用方不得把它当成当前账号的数据。
 */
export function fetchHunts(userId, force) {
  const uid = norm(userId)
  if (!uid) return Promise.resolve(null)
  const hit = flights.get(uid)
  if (hit && hit.epoch === epoch && !force) return hit.promise

  const ep = epoch
  const mySeq = ++seq
  latest.set(uid, mySeq)
  const req = api('/hunts' + (force ? '?refresh=1' : ''))
    .then((d) => {
      // 换号（epoch）、账号不符（identity）、或已被更新的一次请求取代（seq）：整份丢弃
      if (ep !== epoch || identity !== uid || latest.get(uid) !== mySeq) return null
      writeHuntsCache(uid, d)
      preloadThumbs(d.list || [])
      return d
    })
    .finally(() => {
      const cur = flights.get(uid)
      if (cur && cur.promise === req) flights.delete(uid)
    })
  flights.set(uid, { promise: req, epoch: ep })
  return req
}

/** 后台预取；已有新鲜缓存或正在请求时直接复用，身份未确认时不发请求 */
export function prefetchHunts(userId) {
  const uid = norm(userId)
  if (!uid || identity !== uid) return Promise.resolve(null)
  const cached = readHuntsCache(uid)
  if (cached) return Promise.resolve(cached)
  return fetchHunts(uid, false).catch(() => null)
}

export { preloadThumbs }