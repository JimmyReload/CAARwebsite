// 赛事时间的展示格式：上游 pzc 给的是 UTC，本站统一按东八区墙钟显示。
//
// 服务端（hunts.js）已把时间换算成 "+08:00" 的墙钟串；这里再按绝对时刻兜一层，
// 目的是让旧快照（不带时区的 UTC 串，如 "2026-11-27T10:00:00"）也能显示成北京时间，
// 不会退化成 UTC+0。
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "2026-11-27T18:00:00+08:00" / "2026-11-27T10:00:00" → "11/27 18:00" */
export function fmtHuntDay(iso) {
  const s = String(iso || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return '';
  const dayOnly = m[2] + '/' + m[3];
  if (!m[4]) return dayOnly;
  // 不带时区的一律按 UTC 解释（上游口径），带了就按它自己的声明
  const naive = !/([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(naive ? s.replace(' ', 'T') + 'Z' : s);
  if (!Number.isFinite(ms)) return dayOnly + ' ' + m[4] + ':' + m[5];
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate())
    + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}
