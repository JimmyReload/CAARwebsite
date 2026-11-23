/* ==========================================================
   CAAR · 极简 i18n
   用法：import { t } from './i18n'  →  t('nav.about')
   插值：t('nav.logout', { name: 'Tom' })  ← 文案里写 {name}
   切换语言：setLocale('en-US')（需先在 locales 里注册）
   ========================================================== */
import zhCN from './locales/zh-CN.js'

export const locales = {
  'zh-CN': zhCN,
}

export const DEFAULT_LOCALE = 'zh-CN'

let current = DEFAULT_LOCALE

export function setLocale(code) {
  if (locales[code]) current = code
}

export function getLocale() {
  return current
}

function lookup(dict, path) {
  return String(path).split('.').reduce((node, key) => (node == null ? undefined : node[key]), dict)
}

export function t(path, vars) {
  const dict = locales[current] || locales[DEFAULT_LOCALE]
  let value = lookup(dict, path)
  if (value === undefined) {
    // 缺文案时把 key 原样显示，便于一眼发现漏项（不会静默渲染成 undefined）
    if (typeof console !== 'undefined') console.warn('[i18n] 缺少文案: ' + path)
    return path
  }
  if (typeof value === 'string' && vars) {
    value = value.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])))
  }
  return value
}

export default t

// 审计事件名 → 中文名
// 事件 id 是点分字符串（auth.login.fail），走 t() 会被当成嵌套路径拆开，
// 所以这里在 locale 的 logEventLabels 表里做整串精确匹配。
// 查不到就返回原始 id：新增事件忘配文案时，界面上仍能认出来，而不是空白。
export function eventLabel(name) {
  const id = String(name == null ? '' : name)
  if (!id) return ''
  const dict = locales[current] || locales[DEFAULT_LOCALE]
  const map = dict && dict.logEventLabels
  if (map && typeof map[id] === 'string') return map[id]
  return id
}
