import { useEffect, useRef, useState } from 'react'
import { EMPTY_NEWS_DOCUMENT, NEWS_CONTENT_MAX, newsDocumentFromHtml, newsDocumentText, normalizeNewsDocument, safeNewsHref, sanitizedNewsHtmlFromTransfer } from '../newsContent'
import { t } from '../i18n'

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

function inlineHtml(nodes = []) {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '<br>'
    let html = escapeHtml(node.text || '')
    for (const [mark, tag] of [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strike', 's'], ['code', 'code']]) {
      if (node.marks && node.marks.includes(mark)) html = `<${tag}>${html}</${tag}>`
    }
    const href = safeNewsHref(node.href)
    if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`
    return html
  }).join('')
}

export function newsDocumentToSafeHtml(value) {
  const doc = normalizeNewsDocument(value)
  if (!doc) return ''
  return doc.children.map((block) => {
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      const tag = block.type === 'bulletList' ? 'ul' : 'ol'
      return `<${tag}>${block.children.map((item) => `<li>${inlineHtml(item.children)}</li>`).join('')}</${tag}>`
    }
    const html = inlineHtml(block.children)
    if (block.type === 'heading') {
      const tag = block.level === 3 ? 'h3' : 'h2'
      return `<${tag}>${html}</${tag}>`
    }
    if (block.type === 'quote') return `<blockquote>${html}</blockquote>`
    return `<p>${html}</p>`
  }).join('')
}

const initialHtml = (value) => newsDocumentToSafeHtml(value) || '<p><br></p>'

function caretTextOffset(root) {
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount || !selection.focusNode || !root.contains(selection.focusNode)) return null
  try {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(selection.focusNode, selection.focusOffset)
    return range.toString().length
  } catch { return null }
}

function restoreCaretTextOffset(root, offset) {
  const selection = window.getSelection()
  if (!selection) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, Number(offset) || 0)
  let node
  let last = null
  while ((node = walker.nextNode())) {
    last = node
    const length = node.nodeValue.length
    if (remaining <= length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    remaining -= length
  }
  const range = document.createRange()
  if (last) range.setStart(last, last.nodeValue.length)
  else range.selectNodeContents(root)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function placeCaretAtDropPoint(root, event) {
  let range = null
  if (typeof document.caretRangeFromPoint === 'function') {
    range = document.caretRangeFromPoint(event.clientX, event.clientY)
  } else if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY)
    if (position) {
      range = document.createRange()
      range.setStart(position.offsetNode, position.offset)
      range.collapse(true)
    }
  }
  const selection = window.getSelection()
  if (!selection) return
  if (range && root.contains(range.startContainer)) {
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}

export default function RichTextEditor({ initialValue = EMPTY_NEWS_DOCUMENT, onChange, label, placeholder, disabled, resetKey }) {
  const editorRef = useRef(null)
  const lastHtmlRef = useRef('')
  const initializedRef = useRef(false)
  const [charCount, setCharCount] = useState(() => [...newsDocumentText(initialValue)].length)

  useEffect(() => {
    const element = editorRef.current
    if (!element || initializedRef.current) return
    const html = initialHtml(initialValue)
    element.innerHTML = html
    lastHtmlRef.current = html
    setCharCount([...newsDocumentText(initialValue)].length)
    initializedRef.current = true
  }, [initialValue])

  useEffect(() => {
    const element = editorRef.current
    if (!element) return
    const html = initialHtml(initialValue)
    element.innerHTML = html
    lastHtmlRef.current = html
    setCharCount([...newsDocumentText(initialValue)].length)
    initializedRef.current = true
  }, [resetKey])

  const sync = () => {
    const element = editorRef.current
    if (!element) return
    const caretOffset = caretTextOffset(element)
    const parsedDocument = newsDocumentFromHtml(element.innerHTML)
    if (!parsedDocument) {
      element.innerHTML = lastHtmlRef.current || '<p><br></p>'
      restoreCaretTextOffset(element, caretOffset)
      return
    }
    const safeHtml = newsDocumentToSafeHtml(parsedDocument) || '<p><br></p>'
    // Rebuild the live editor from the allow-list document. This also strips unsafe nodes from
    // native editing paths, not just the persisted payload; restore a text-offset caret afterward.
    if (element.innerHTML !== safeHtml) {
      element.innerHTML = safeHtml
      restoreCaretTextOffset(element, caretOffset)
    }
    lastHtmlRef.current = safeHtml
    setCharCount([...newsDocumentText(parsedDocument)].length)
    onChange(parsedDocument)
  }

  const command = (name, value) => {
    const element = editorRef.current
    if (!element || disabled) return
    element.focus()
    if (name === 'link') {
      const raw = window.prompt(t('news.linkPrompt'))
      if (raw === null) return
      const href = safeNewsHref(raw)
      if (!href) { window.alert(t('news.linkInvalid')); return }
      document.execCommand('createLink', false, href)
    } else if (name === 'formatBlock') {
      document.execCommand(name, false, value)
    } else document.execCommand(name, false, value)
    sync()
  }

  const insertTransfer = (transfer) => {
    const safeHtml = sanitizedNewsHtmlFromTransfer(transfer)
    if (!safeHtml) return false
    document.execCommand('insertHTML', false, safeHtml)
    sync()
    return true
  }

  const paste = (event) => {
    event.preventDefault()
    if (!disabled) insertTransfer(event.clipboardData)
  }

  const drop = (event) => {
    // Never allow the browser to insert native HTML directly into contentEditable.
    event.preventDefault()
    if (disabled) return
    const editor = editorRef.current
    if (!editor) return
    placeCaretAtDropPoint(editor, event)
    insertTransfer(event.dataTransfer)
  }

  const toolbar = [
    { key: 'bold', command: 'bold', glyph: 'B', className: 'editor-bold' },
    { key: 'italic', command: 'italic', glyph: 'I', className: 'editor-italic' },
    { key: 'underline', command: 'underline', glyph: 'U', className: 'editor-underline' },
    { key: 'strike', command: 'strikeThrough', glyph: 'S', className: 'editor-strike' },
    { key: 'heading2', command: 'formatBlock', value: 'h2', glyph: 'H2' },
    { key: 'heading3', command: 'formatBlock', value: 'h3', glyph: 'H3' },
    { key: 'quote', command: 'formatBlock', value: 'blockquote', glyph: '❞' },
    { key: 'bulletList', command: 'insertUnorderedList', glyph: '• ≡' },
    { key: 'orderedList', command: 'insertOrderedList', glyph: '1 ≡' },
    { key: 'link', command: 'link', glyph: '↗' },
    { key: 'paragraph', command: 'formatBlock', value: 'p', glyph: '¶' },
  ]

  return (
    <div className="rich-editor">
      <span className="rich-editor-label">{label}</span>
      <div className="rich-editor-toolbar" role="toolbar" aria-label={t('news.toolbarLabel')}>
        {toolbar.map((item) => <button
          key={item.key} type="button" title={t('news.toolbar.' + item.key)} aria-label={t('news.toolbar.' + item.key)}
          className={'rich-editor-tool ' + (item.className || '')} disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command(item.command, item.value)}
        >{item.glyph}</button>)}
      </div>
      <div
        ref={editorRef} className="rich-editor-input" contentEditable={!disabled}
        role="textbox" aria-label={label} aria-multiline="true" aria-placeholder={placeholder}
        data-placeholder={placeholder} data-empty={charCount === 0 ? 'true' : 'false'} suppressContentEditableWarning
        onInput={sync} onPaste={paste} onDrop={drop} onDragOver={(event) => event.preventDefault()}
      />
      <p className="rich-editor-help">{t('news.editorHelp')} · {t('news.characterCount', { n: charCount, max: NEWS_CONTENT_MAX })}</p>
    </div>
  )
}
