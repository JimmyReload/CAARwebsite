// 新闻封面图的约定：格式白名单、字节数上限、对象键形状。
// Worker 用它做校验与存储，前端用它做提交前预检——同一份规则，避免两边漂移。
//
// 图片存在 MEDIA（KV）里，键形如 news/u3-1f0c…a7.webp：
//   - u<id> 前缀把对象绑定到上传者，别人不能把别人的图挂到自己的稿件上；
//   - 扩展名即 Content-Type 的唯一来源（KV 不给对象存元数据，读时按后缀反推）；
//   - 32 位十六进制随机名，不可枚举，未发布的稿件的图也猜不到。
export const COVER_MAX_BYTES = 2 * 1024 * 1024

// 只接受这三种：浏览器都能直接显示、体积可控、无需转码。
// 注意不含 SVG——它是可执行文档，同源托管等于给自己开一个 XSS 入口。
export const COVER_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
})

const EXT_CONTENT_TYPE = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' })

// 按文件头判断真实格式：声明的 Content-Type 由客户端给，不可信。
// 只需要认出白名单里的三种；其余一律视为不支持。
export function detectCoverExt(bytes) {
  if (!bytes || bytes.length < 12) return ''
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  // "RIFF" .... "WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return ''
}

export function coverContentType(ext) {
  return EXT_CONTENT_TYPE[String(ext || '').toLowerCase()] || ''
}

const HEX32 = '[0-9a-f]{32}'

// 键的形状校验（不查存储）：只认本模块生成出来的那一种。
export function isCoverKey(key) {
  return typeof key === 'string' && new RegExp('^news/u[1-9]\\d{0,15}-' + HEX32 + '\\.(png|jpg|webp)$').test(key)
}

// 这个键是不是该用户上传的。提交稿件时要挡住「引用别人的图」。
export function isCoverKeyOwnedBy(key, userId) {
  const id = Number(userId)
  if (!Number.isSafeInteger(id) || id < 1) return false
  return isCoverKey(key) && key.startsWith('news/u' + id + '-')
}

export function makeCoverKey(userId, ext) {
  const id = Number(userId)
  if (!Number.isSafeInteger(id) || id < 1) return ''
  const type = String(ext || '').toLowerCase()
  if (!EXT_CONTENT_TYPE[type]) return ''
  const rand = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')
  return 'news/u' + id + '-' + rand + '.' + type
}

// 库里存键、前端要 URL：只在读接口出口做这一次转换。
export function coverUrlFromKey(key) {
  return isCoverKey(key) ? '/media/' + key : ''
}
