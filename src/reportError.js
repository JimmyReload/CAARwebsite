/* ==========================================================
   前端异常上报
   ----------------------------------------------------------
   浏览器里的报错只有用户遇到，服务端看不到：不收集就等于没发生。
   约束：
   - 单页最多 8 条，按 message 去重 —— 渲染循环里的同一个错会反复触发，
     不去重会把接口刷满（服务端还有按 IP 的限流兜底）。
   - 用 keepalive：页面正在卸载时也能把最后一条发出去。
   - 上报失败必须静默：日志系统不能把页面再搞崩一次。
   ========================================================== */

const MAX_REPORTS = 8
const seen = new Set()
let sent = 0

export function reportError(err, extra = {}) {
  try {
    if (sent >= MAX_REPORTS) return
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
      url: location.pathname + String(location.search || '').slice(0, 120),
    })

    fetch('/api/log/client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* 上报失败就放弃 */
  }
}

if (typeof window !== 'undefined') {
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
  })

  window.addEventListener('unhandledrejection', (e) => {
    reportError((e && e.reason) || 'unhandled rejection', { where: 'unhandledrejection' })
  })
}

export default reportError
