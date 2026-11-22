/* ==========================================================
   时间显示
   D1 的 datetime('now') 存的是 UTC 文本 "YYYY-MM-DD HH:MM:SS"，
   不带时区标记。直接 slice 会在东八区差 8 小时（晚上发的公告日期变前一天），
   所以统一按 UTC 解析再转本地时区输出。
   ========================================================== */

function parse(s) {
  if (!s) return null
  const raw = String(s).trim()
  // 已带 Z 或 ±HH:MM 的按原样解析；否则补 Z 视为 UTC
  const iso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? raw.replace(' ', 'T') : raw.replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

const pad = (n) => String(n).padStart(2, '0')

/** 2026-11-22 */
export function fmtDate(s) {
  const d = parse(s)
  if (!d) return ''
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 11-22 14:56 */
export function fmtDateTime(s) {
  const d = parse(s)
  if (!d) return ''
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 14:56 */
export function fmtTime(s) {
  const d = parse(s)
  if (!d) return ''
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 11-22 14:56 */
export function fmtRelative(s) {
  const d = parse(s)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
  return fmtDateTime(s)
}

export default { fmtDate, fmtDateTime, fmtTime, fmtRelative }
