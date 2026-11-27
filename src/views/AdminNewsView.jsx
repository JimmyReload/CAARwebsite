import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../api'
import { t } from '../i18n'
import { fmtDateTime } from '../time'
import NewsContent from './NewsContent'

const statuses = ['pending', 'published', 'rejected']

export default function AdminNewsView() {
  const [status, setStatus] = useState('pending')
  const [articles, setArticles] = useState([])
  const [active, setActive] = useState(null)
  const [reviewNote, setReviewNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reviewingId, setReviewingId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const listRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const reviewRequestRef = useRef(0)
  const reviewInFlightRef = useRef(false)
  const selectedIdRef = useRef(null)
  const mountedRef = useRef(false)

  const load = useCallback(async () => {
    const requestId = ++listRequestRef.current
    setLoading(true); setError('')
    try {
      const data = await api('/admin/news?status=' + status)
      if (!mountedRef.current || requestId !== listRequestRef.current) return
      setArticles(data.list || [])
      setActive((old) => old ? (data.list || []).find((item) => item.id === old.id) || null : null)
      if (selectedIdRef.current && !(data.list || []).some((item) => item.id === selectedIdRef.current)) {
        selectedIdRef.current = null
      }
    } catch (err) {
      if (mountedRef.current && requestId === listRequestRef.current) setError(err.message)
    } finally {
      if (mountedRef.current && requestId === listRequestRef.current) setLoading(false)
    }
  }, [status])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      listRequestRef.current++
      detailRequestRef.current++
    }
  }, [])

  useEffect(() => {
    listRequestRef.current++
    detailRequestRef.current++
    selectedIdRef.current = null
    setActive(null)
    load()
  }, [load])

  const select = async (item) => {
    if (saving) return
    const requestId = ++detailRequestRef.current
    selectedIdRef.current = item.id
    setActive(null)
    setError(''); setNotice(''); setReviewNote(item.review_note || '')
    try {
      const data = await api('/admin/news/' + item.id)
      if (!mountedRef.current || requestId !== detailRequestRef.current || selectedIdRef.current !== item.id) return
      setActive(data.article)
      setReviewNote(data.article.review_note || '')
    } catch (err) {
      if (mountedRef.current && requestId === detailRequestRef.current && selectedIdRef.current === item.id) setError(err.message)
    }
  }
  const backToList = () => {
    if (saving) return
    detailRequestRef.current++
    selectedIdRef.current = null
    setActive(null)
    setError('')
  }
  const changeStatus = (nextStatus) => {
    if (saving) return
    selectedIdRef.current = null
    detailRequestRef.current++
    setActive(null)
    setStatus(nextStatus)
    setError('')
  }
  const review = async (nextStatus) => {
    const articleId = active && active.id
    if (!articleId || reviewInFlightRef.current || selectedIdRef.current !== articleId) return
    if (nextStatus === 'rejected' && !reviewNote.trim()) { setError(t('news.reviewNoteRequired')); return }
    const requestId = detailRequestRef.current
    const reviewId = ++reviewRequestRef.current
    reviewInFlightRef.current = true
    setSaving(true); setReviewingId(articleId); setError(''); setNotice('')
    try {
      await api('/admin/news/' + articleId, { method: 'PATCH', body: { status: nextStatus, review_note: reviewNote } })
      if (!mountedRef.current || reviewId !== reviewRequestRef.current) return
      const stillViewingArticle = requestId === detailRequestRef.current && selectedIdRef.current === articleId
      setNotice(nextStatus === 'published' ? t('news.published') : t('news.rejected') )
      if (stillViewingArticle) {
        selectedIdRef.current = null
        setActive(null); setReviewNote('')
      }
      await load()
    } catch (err) {
      if (mountedRef.current && reviewId === reviewRequestRef.current && requestId === detailRequestRef.current && selectedIdRef.current === articleId) setError(err.message)
    } finally {
      reviewInFlightRef.current = false
      if (mountedRef.current && reviewId === reviewRequestRef.current) {
        setSaving(false)
        setReviewingId(null)
      }
    }
  }

  return (
    <section className="panel-sec admin-news">
      <div className="news-admin-heading">
        <div><h2 className="panel-sec-title">{t('news.adminTitle')}</h2><p className="acct-note">{t('news.adminHint')}</p></div>
      </div>
      <div className="admin-tabs news-status-tabs" role="tablist" aria-label={t('news.filterLabel')}>
        {statuses.map((key) => <button key={key} role="tab" aria-selected={status === key} className={status === key ? 'on' : ''} disabled={saving} onClick={() => changeStatus(key)}>{t('news.status.' + key)}</button>)}
      </div>
      {error && <p className="auth-msg" role="alert">{error}</p>}
      {notice && <p className="auth-msg auth-msg--ok" role="status">{notice}</p>}

      {active ? (
        <article className="news-review-detail">
          <button className="mini-btn" disabled={saving} onClick={backToList}>← {t('news.reviewBack')}</button>
          <span className={'news-status news-status--' + active.status}>{t('news.status.' + active.status)}</span>
          <h3 className="news-review-title">{active.title}</h3>
          <p className="news-review-meta">{active.author_name || active.author_username} · @{active.author_username} · {fmtDateTime(active.created_at)}</p>
          {active.summary && <p className="news-article-summary">{active.summary}</p>}
          {active.coverUrl && <img className="news-review-cover" src={active.coverUrl} alt={t('news.coverLabel')} decoding="async" />}
          <div className="news-review-content"><NewsContent value={active.content} /></div>
          {active.status === 'pending' && <label className="news-review-label">{t('news.reviewNote')} <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows="3" maxLength="500" placeholder={t('news.reviewNotePlaceholder')} /></label>}
          {active.status !== 'pending' && active.review_note && <p className="news-review-note"><strong>{t('news.reviewNote')}：</strong>{active.review_note}</p>}
          <div className="btn-row">
            {active.status === 'pending' && <>
              <button className="auth-btn news-approve" disabled={saving || reviewingId === active.id} onClick={() => review('published')}>{saving && reviewingId === active.id ? t('news.reviewing') : t('news.approvePublish')}</button>
              <button className="mini-btn mini-btn--danger" disabled={saving || reviewingId === active.id} onClick={() => review('rejected')}>{t('news.returnToAuthor')}</button>
            </>}
            {active.status !== 'pending' && <span className="acct-note">{active.published_at ? t('news.publishedAt', { date: fmtDateTime(active.published_at) }) : active.reviewed_at ? t('news.reviewedAt', { date: fmtDateTime(active.reviewed_at) }) : ''}</span>}
          </div>
        </article>
      ) : loading ? <p className="panel-empty">{t('news.loading')}</p> : articles.length === 0 ? <p className="panel-empty">{t('news.adminEmpty')}</p> : (
        <div className="admin-list">
          {articles.map((item) => <button type="button" className="admin-row admin-row--msg admin-news-row" key={item.id} disabled={saving} onClick={() => select(item)}>
            <span className="admin-news-row-head"><strong>{item.title}</strong><span className={'news-status news-status--' + item.status}>{t('news.status.' + item.status)}</span></span>
            <span className="msg-content">{item.summary || item.excerpt}</span>
            <span className="msg-date">{item.author_name || item.author_username} · @{item.author_username} · {fmtDateTime(item.created_at)}</span>
          </button>)}
        </div>
      )}
    </section>
  )
}
