/* ==========================================================
   前端异常上报
   ----------------------------------------------------------
   浏览器里的报错只有用户遇到，服务端看不到：不收集就等于没发生。
   约束：
   - 每 10 分钟最多 8 条，按 message 去重 —— 渲染循环里的同一个错会反复触发，
     不去重会把接口刷满。用时间窗而不是「整页 8 条」，否则长会话后段真正的错误发不出去。
   - 节奏必须低于服务端阈值（120 次/小时），被 429 后整页闭嘴：
     否则一个持续报错的页面会把自己这个出口（可能是共享 NAT）封掉。
   - 用 keepalive：页面正在卸载时也能把最后一条发出去。
   - 上报失败必须静默：日志系统不能把页面再搞崩一次。
   ========================================================== */

const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 8

let windowStart = 0
let sent = 0
let disabled = false
const seen = new Set()

function resetIfNeeded(now) {
  if (now - windowStart < WINDOW_MS) return
  windowStart = now
  sent = 0
  seen.clear()
}

export function reportError(err, extra = {}) {
  try {
    if (disabled) return
    const now = Date.now()
    resetIfNeeded(now)
    if (sent >= MAX_PER_WINDOW) return

    const message = String((err && err.message) || err || '').slice(0, 300)
    if (!message) return
    const where = String(extra.where || '')
    const key = where + '|' + message
    if (seen.has(key)) return
    seen.add(key)
    sent += 1

    const body = JSON.stringify({
      level: extra.level === 'warn' ? 'warn' : 'error',
      message,
      stack: String((err && err.stack) || extra.stack || '').slice(0, 1200),
      // 只带路径：查询串里可能有邮箱、邀请码或将来的 token，不该在库里躺 90 天
      url: location.pathname,
    })

    fetch('/api/log/client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: true,
    }).then((r) => {
      // 被限流就整页停用：继续重试会把封禁阶梯一路刷上去
      if (r && (r.status === 429 || r.status === 413)) disabled = true
    }).catch(() => {})
  } catch {
    /* 上报失败就放弃 */
  }
}

if (typeof window !== 'undefined') {
  // capture: true —— 资源（img/script/link）的 error 不冒泡，只在捕获阶段可见
  window.addEventListener('error', (e) => {
    if (e && e.error) {
      reportError(e.error, { where: 'window.error' })
    } else {
      // 资源加载失败没有 Error 对象，只能拿到 message + 文件名/行号
      reportError((e && e.message) || 'resource load failed', {
        where: 'window.error',
        stack: e && e.filename ? e.filename + ':' + e.lineno : '',
      })
    }
  }, true)

  window.addEventListener('unhandledrejection', (e) => {
    reportError((e && e.reason) || 'unhandled rejection', { where: 'unhandledrejection' })
  })
}

export default reportError
