// 轻量 API 封装（同域 /api/*，自动带 cookie；15s 超时防挂起）
import { t } from './i18n'

export async function api(path, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || t('api.failed'))
    return data
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(t('api.timeout'))
    throw err
  } finally {
    clearTimeout(timer)
  }
}
export default api

// 二进制上传（目前只有新闻封面用）：正文是文件本身，Content-Type 就是文件类型。
// 服务端只对 news/cover 放开非 JSON 正文，其他路由仍要求 JSON。
export async function apiUpload(path, blob, timeoutMs = 60000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'content-type': blob.type },
      body: blob,
      credentials: 'same-origin',
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || t('api.failed'))
    return data
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(t('api.timeout'))
    throw err
  } finally {
    clearTimeout(timer)
  }
}
