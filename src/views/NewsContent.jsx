import { Fragment } from 'react'
import { normalizeNewsDocument, safeNewsHref } from '../newsContent'

function Inline({ nodes = [] }) {
  return nodes.map((node, index) => {
    if (node.type === 'hardBreak') return <br key={index} />
    let content = node.text || ''
    for (const mark of node.marks || []) {
      if (mark === 'bold') content = <strong key={'b' + index}>{content}</strong>
      else if (mark === 'italic') content = <em key={'i' + index}>{content}</em>
      else if (mark === 'underline') content = <u key={'u' + index}>{content}</u>
      else if (mark === 'strike') content = <s key={'s' + index}>{content}</s>
      else if (mark === 'code') content = <code key={'c' + index}>{content}</code>
    }
    const href = safeNewsHref(node.href)
    if (href) content = <a key={'a' + index} href={href} target="_blank" rel="noopener noreferrer">{content}</a>
    return <Fragment key={index}>{content}</Fragment>
  })
}

export default function NewsContent({ value }) {
  const document = normalizeNewsDocument(value)
  if (!document) return null
  return <div className="news-article-body">{document.children.map((block, index) => {
    if (block.type === 'heading') return block.level === 3
      ? <h3 key={index}><Inline nodes={block.children} /></h3>
      : <h2 key={index}><Inline nodes={block.children} /></h2>
    if (block.type === 'quote') return <blockquote key={index}><Inline nodes={block.children} /></blockquote>
    if (block.type === 'bulletList') return <ul key={index}>{block.children.map((item, i) => <li key={i}><Inline nodes={item.children} /></li>)}</ul>
    if (block.type === 'orderedList') return <ol key={index}>{block.children.map((item, i) => <li key={i}><Inline nodes={item.children} /></li>)}</ol>
    return <p key={index}><Inline nodes={block.children} /></p>
  })}</div>
}
