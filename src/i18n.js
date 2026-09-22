/* ==========================================================
   CAAR · 极简 i18n
   用法：import { t } from './i18n'  →  t('nav.about')
   插值：t('nav.logout', { name: 'Tom' })  ← 文案里写 {name}
   切换语言：setLocale('en-US')（需先在 locales 里注册）
   ========================================================== */
import zhCN from './locales/zh-CN'

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
