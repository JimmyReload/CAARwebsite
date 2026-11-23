// A small structured rich-text format shared by the Worker and React UI.
// User HTML is never stored or rendered; only this allow-listed document tree is persisted.
export const NEWS_CONTENT_MAX = 10000
export const EMPTY_NEWS_DOCUMENT = Object.freeze({ type: 'doc', children: [] })

const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code'])
const BLOCKS = new Set(['paragraph', 'heading', 'quote', 'bulletList', 'orderedList'])
const SAFE_HREF = /^(https?:\/\/|mailto:)/i

export function safeNewsHref(value) {
  const href = String(value || '').trim()
  if (href.length > 2048 || /[\u0000-\u0020\\]/.test(href) || !SAFE_HREF.test(href)) return ''
  return href
}

export function normalizeNewsDocument(input) {
  if (!input || typeof input !== 'object' || input.type !== 'doc' || !Array.isArray(input.children)) return null
  if (input.children.length > 300) return null
  let chars = 0
  let nodes = 0

  const inline = (list, depth = 0) => {
    if (!Array.isArray(list) || depth > 8 || list.length > 2000) return null
    const out = []
    for (const item of list) {
      if (!item || typeof item !== 'object' || ++nodes > 6000) return null
      if (item.type === 'text') {
        const text = typeof item.text === 'string' ? item.text : ''
        chars += [...text].length
        if (chars > NEWS_CONTENT_MAX) return null
        const marks = Array.isArray(item.marks)
          ? [...new Set(item.marks.filter((mark) => MARKS.has(mark)))].slice(0, MARKS.size)
          : []
        const node = { type: 'text', text, marks }
        const href = safeNewsHref(item.href)
        if (href) node.href = href
        out.push(node)
      } else if (item.type === 'hardBreak') {
        out.push({ type: 'hardBreak' })
      } else return null
    }
    return out
  }

  const blocks = (list, depth = 0) => {
    if (!Array.isArray(list) || depth > 6) return null
    const out = []
    for (const item of list) {
      if (!item || typeof item !== 'object' || !BLOCKS.has(item.type) || ++nodes > 6000) return null
      if (item.type === 'bulletList' || item.type === 'orderedList') {
        if (!Array.isArray(item.children) || item.children.length > 500) return null
        const children = []
        for (const li of item.children) {
          if (!li || li.type !== 'listItem') return null
          nodes++
          const content = inline(li.children, depth + 1)
          if (!content) return null
          children.push({ type: 'listItem', children: content })
        }
        out.push({ type: item.type, children })
      } else {
        const children = inline(item.children, depth + 1)
        if (!children) return null
        const block = { type: item.type, children }
        if (item.type === 'heading') block.level = item.level === 3 ? 3 : 2
        out.push(block)
      }
    }
    return out
  }

  const children = blocks(input.children)
  return children ? { type: 'doc', children } : null
}

export function newsDocumentText(document) {
  const safe = normalizeNewsDocument(document)
  if (!safe) return ''
  const inlineText = (nodes) => nodes.map((node) => node.type === 'text' ? node.text : '\n').join('')
  const blockText = (blocks) => blocks.map((block) => {
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      return block.children.map((item) => inlineText(item.children)).join('\n')
    }
    return inlineText(block.children)
  }).join('\n\n')
  return blockText(safe.children)
}

function escapeNewsText(text) {
  return String(text).replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char])
}

// Convert clipboard/drop data into safe HTML for execCommand('insertHTML').
// HTML always goes through the same structured allowlist parser; plain text is escaped.
export function sanitizedNewsHtmlFromTransfer(transfer) {
  const html = transfer && transfer.getData('text/html')
  if (html) {
    const parsed = newsDocumentFromHtml(html)
    if (parsed) {
      const inline = (nodes) => nodes.map((node) => {
        if (node.type === 'hardBreak') return '<br>'
        let value = escapeNewsText(node.text || '')
        for (const [mark, tag] of [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strike', 's'], ['code', 'code']]) {
          if (node.marks && node.marks.includes(mark)) value = `<${tag}>${value}</${tag}>`
        }
        const href = safeNewsHref(node.href)
        if (href) value = `<a href=\"${escapeNewsText(href)}\">${value}</a>`
        return value
      }).join('')
      return parsed.children.map((block) => {
        if (block.type === 'bulletList' || block.type === 'orderedList') {
          const tag = block.type === 'bulletList' ? 'ul' : 'ol'
          return `<${tag}>${block.children.map((item) => `<li>${inline(item.children)}</li>`).join('')}</${tag}>`
        }
        const content = inline(block.children)
        if (!content) return ''
        if (block.type === 'heading') return `<h${block.level}>${content}</h${block.level}>`
        if (block.type === 'quote') return `<blockquote>${content}</blockquote>`
        return `<p>${content}</p>`
      }).join('')
    }
  }
  const text = transfer && transfer.getData('text/plain') || ''
  return text ? '<p>' + escapeNewsText(text).replace(/\r\n|\r|\n/g, '<br>') + '</p>' : ''
}

// Browser helper: parse the editable DOM into the allow-listed structured tree.
// DOMParser does not execute scripts; unsupported elements are flattened to text.
export function newsDocumentFromHtml(html) {
  if (typeof DOMParser === 'undefined') return null
  const source = String(html || '')
  if (source.length > NEWS_CONTENT_MAX * 4) return null
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  let visited = 0
  const blocked = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template'])
  const marksFor = (element, inherited) => {
    const marks = new Set(inherited)
    const tag = element.tagName.toLowerCase()
    if (tag === 'b' || tag === 'strong') marks.add('bold')
    if (tag === 'i' || tag === 'em') marks.add('italic')
    if (tag === 'u') marks.add('underline')
    if (tag === 's' || tag === 'del' || tag === 'strike') marks.add('strike')
    if (tag === 'code') marks.add('code')
    return [...marks]
  }
  const readInline = (node, inherited = [], depth = 0) => {
    if (++visited > 6000 || depth > 32) return []
    if (node.nodeType === 3) return node.nodeValue ? [{ type: 'text', text: node.nodeValue, marks: inherited }] : []
    if (node.nodeType !== 1) return []
    const tag = node.tagName.toLowerCase()
    if (blocked.has(tag)) return []
    if (tag === 'br') return [{ type: 'hardBreak' }]
    const marks = marksFor(node, inherited)
    const href = tag === 'a' ? safeNewsHref(node.getAttribute('href')) : ''
    const children = [...node.childNodes].flatMap((child) => readInline(child, marks, depth + 1))
    if (!href) return children
    return children.map((child) => child.type === 'text' ? { ...child, href } : child)
  }
  const result = []
  const flushParagraph = (nodes) => {
    const content = nodes.flatMap((node) => readInline(node))
    if (content.length) result.push({ type: 'paragraph', children: content })
  }
  const readBlocks = (nodes) => {
    if (nodes.length > 12000) return
    let paragraph = []
    const flush = () => { if (paragraph.length) flushParagraph(paragraph); paragraph = [] }
    for (const node of nodes) {
      if (++visited > 6000 || result.length > 300) break
      if (node.nodeType === 3) { if (node.nodeValue) paragraph.push(node); continue }
      if (node.nodeType !== 1) continue
      const tag = node.tagName.toLowerCase()
      if (blocked.has(tag)) continue
      if (tag === 'br' || !['p', 'div', 'h2', 'h3', 'blockquote', 'ul', 'ol'].includes(tag)) {
        paragraph.push(node)
        continue
      }
      flush()
      if (tag === 'ul' || tag === 'ol') {
        const children = [...node.children].filter((child) => child.tagName.toLowerCase() === 'li').slice(0, 500).map((li) => ({ type: 'listItem', children: [...li.childNodes].flatMap((child) => readInline(child)) }))
        result.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', children })
      } else {
        const children = [...node.childNodes].flatMap((child) => readInline(child))
        if (tag === 'blockquote') result.push({ type: 'quote', children })
        else if (tag === 'h2' || tag === 'h3') result.push({ type: 'heading', level: tag === 'h3' ? 3 : 2, children })
        else result.push({ type: 'paragraph', children })
      }
    }
    flush()
  }
  readBlocks([...parsed.body.childNodes])
  if (result.length > 300) return null
  return normalizeNewsDocument({ type: 'doc', children: result })
}
