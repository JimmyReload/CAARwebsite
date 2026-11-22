// 赛事列表的客户端预加载缓存
//
// 目的：登录后只要访问站内任意页面，就在后台把 /api/hunts 取回来，
// 用户点开「赛事总览」时直接渲染，不再等一次网络往返。
// 两层缓存：模块内存（同一次会话内的路由切换）+ sessionStorage（刷新后仍可用）。
// 打开页面时仍会静默回源一次，所以看到的是「先出内容，再刷新」而不是旧数据卡住。
import api from './api'

const KEY = 'caar:hunts:v1'
const TTL_MS = 5 * 60 * 1000
const PRELOAD_IMAGES = 6

let memory = null // { userId, at, data }
let inFlight = null

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
  const entry = { userId, at: Date.now(), data }
  memory = entry
  try { sessionStorage.setItem(KEY, JSON.stringify(entry)) } catch { /* 超配额时只用内存 */ }
}

export function clearHuntsCache() {
  memory = null
  try { sessionStorage.removeItem(KEY) } catch { /* ignore */ }
}

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

/** 真正发起请求（同一时刻只允许一个），结果写缓存 */
export function fetchHunts(userId, force) {
  if (inFlight && !force) return inFlight
  const req = api('/hunts' + (force ? '?refresh=1' : ''))
    .then((d) => {
      writeHuntsCache(userId, d)
      preloadThumbs(d.list || [])
      return d
    })
    .finally(() => { if (inFlight === req) inFlight = null })
  inFlight = req
  return req
}

/** 后台预取；已有新鲜缓存或正在请求时直接复用 */
export function prefetchHunts(userId) {
  if (!userId) return Promise.resolve(null)
  const cached = readHuntsCache(userId)
  if (cached) return Promise.resolve(cached)
  return fetchHunts(userId, false).catch(() => null)
}

export { preloadThumbs }
