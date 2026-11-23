import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { EMPTY_NEWS_DOCUMENT } from '../newsContent'
import { t } from '../i18n'
import { fmtDateTime } from '../time'
import RichTextEditor from './RichTextEditor'

const blank = { title: '', summary: '', content: EMPTY_NEWS_DOCUMENT }

function toDocument(article) {
  if (article.content_format === 'rich-v1' && article.content && typeof article.content === 'object') return article.content
  const text = String(article.content || '')
  return { type: 'doc', children: text ? text.split(/\n{2,}/).map((part) => ({
    type: 'paragraph', children: part.split('\n').flatMap((line, i) => i ? [{ type: 'hardBreak' }, { type: 'text', text: line, marks: [] }] : [{ type: 'text', text: line, marks: [] }])
  })) : [] }
}

export default function MemberNewsView() {
  const [form, setForm] = useState(blank)
  const [articles, setArticles] = useState([])
  const [editing, setEditing] = useState(null)
  const [editorReset, setEditorReset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api('/news/mine')
      setArticles(data.list || [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const change = (key) => (event) => setForm((old) => ({ ...old, [key]: event.target.value }))
  const edit = async (item) => {
    setError(''); setNotice('')
    try {
      const data = await api('/news/mine/' + item.id)
      const article = data.article
      if (!article || article.status !== 'rejected') { await load(); return }
      setEditing(article.id)
      setForm({ title: article.title, summary: article.summary || '', content: toDocument(article) })
      setEditorReset((v) => v + 1)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) { setError(err.message) }
  }
  const cancel = () => {
    setEditing(null); setForm(blank); setEditorReset((v) => v + 1)
  }
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    const payload = { title: form.title, summary: form.summary, content: form.content }
    try {
      if (editing) await api('/news/' + editing + '/resubmit', { method: 'POST', body: payload })
      else await api('/news', { method: 'POST', body: payload })
      setNotice(editing ? t('news.resubmitted') : t('news.submitted'))
      setForm(blank); setEditing(null); setEditorReset((v) => v + 1)
      await load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <main className="panel-page member-news-page">
      <div className="panel-head">
        <p className="auth-kicker">{t('news.memberKicker')}</p>
        <h1 className="panel-title">{t('news.memberTitle')}</h1>
        <Link className="panel-back" to="/news">{t('news.backToNews')}</Link>
        <Link className="panel-back" to="/member">{t('member.title')}</Link>
      </div>

      <section className="panel-sec news-compose">
        <h2 className="panel-sec-title">{editing ? t('news.editSubmission') : t('news.newSubmission')}</h2>
        <p className="news-compose-note">{t('news.reviewNotice')}</p>
        {error && <p className="auth-msg" role="alert">{error}</p>}
        {notice && <p className="auth-msg auth-msg--ok" role="status">{notice}</p>}
        <form onSubmit={submit} className="msg-form">
          <label>{t('news.titleLabel')} <input value={form.title} onChange={change('title')} maxLength="100" required /></label>
          <label>{t('news.summaryLabel')} <textarea value={form.summary} onChange={change('summary')} rows="2" maxLength="280" /></label>
          <RichTextEditor
            key={editorReset} resetKey={editorReset} initialValue={form.content} disabled={busy}
            label={t('news.contentLabel')} placeholder={t('news.editorPlaceholder')}
            onChange={(content) => setForm((old) => ({ ...old, content }))}
          />
          <div className="btn-row">
            <button className="auth-btn" disabled={busy}>{busy ? t('news.submitting') : editing ? t('news.resubmitButton') : t('news.submitButton')}</button>
            {editing && <button type="button" className="mini-btn" onClick={cancel}>{t('common.cancel')}</button>}
          </div>
        </form>
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('news.mySubmissions')}</h2>
        {loading && <p className="panel-empty" aria-live="polite">{t('news.loading')}</p>}
        {!loading && articles.length === 0 && <p className="panel-empty">{t('news.myEmpty')}</p>}
        <div className="admin-list">
          {articles.map((item) => (
            <article className="admin-row admin-row--msg member-news-row" key={item.id}>
              <div className="member-news-row-head">
                <div><strong>{item.title}</strong><span className="msg-date"> · {fmtDateTime(item.updated_at || item.created_at)}</span></div>
                <span className={'news-status news-status--' + item.status}>{t('news.status.' + item.status)}</span>
              </div>
              {item.review_note && <p className="news-review-note"><strong>{t('news.reviewNote')}：</strong>{item.review_note}</p>}
              {item.status === 'rejected' && <button type="button" className="mini-btn" onClick={() => edit(item)}>{t('news.editAndResubmit')}</button>}
              {item.status === 'published' && <Link className="news-read-more" to={'/news/' + item.id}>{t('news.viewPublished')} →</Link>}
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
