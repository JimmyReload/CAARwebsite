import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'
import { fmtDateTime } from '../time'
import NewsContent from './NewsContent'

/* 列表卡片：头图 + 标题 + 简介，作者与发布时间压成一行小字。
   没有封面的稿件不占位（直接省略图区），避免出现一块空白框。 */
function ArticleCard({ article }) {
  return (
    <article className={article.coverUrl ? 'news-card news-card--cover' : 'news-card'}>
      {article.coverUrl && (
        <div className="news-card-cover">
          <img src={article.coverUrl} alt="" loading="lazy" decoding="async" />
        </div>
      )}
      <div className="news-card-body">
        <h2 className="news-card-title"><Link to={'/news/' + article.id}>{article.title}</Link></h2>
        {article.summary && <p className="news-card-summary">{article.summary}</p>}
        <div className="news-card-meta"><span>{article.author_name || t('news.author')}</span><time>{fmtDateTime(article.published_at)}</time></div>
      </div>
    </article>
  )
}

export default function NewsView() {
  const { id } = useParams()
  const [list, setList] = useState([])
  const [article, setArticle] = useState(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    if (id) {
      setArticle(null)
      api('/news/' + encodeURIComponent(id))
        .then((d) => { if (alive) setArticle(d.article || null) })
        .catch((err) => { if (alive) setError(err.message) })
        .finally(() => { if (alive) setLoading(false) })
    } else {
      api('/news?page=' + page)
        .then((d) => { if (alive) { setList(d.list || []); setTotal(d.total || 0) } })
        .catch((err) => { if (alive) setError(err.message) })
        .finally(() => { if (alive) setLoading(false) })
    }
    return () => { alive = false }
  }, [id, page])

  return (
    <main className="news-page">
      <header className="news-masthead">
        <div className="news-kicker"><span>CAAR / PRESS</span><span>新闻与成员来稿</span></div>
        <h1 className="news-headline">{id ? t('news.detailTitle') : t('news.title')}</h1>
        <p className="news-deck">{t('news.subtitle')}</p>
      </header>

      {error && <p className="auth-msg news-message" role="alert">{error}</p>}
      {loading && <div className="news-grid" aria-label={t('news.loading')}>{[1, 2, 3].map((x) => <div className="news-skeleton" key={x} />)}</div>}

      {id && !loading && article && (
        <article className="news-article">
          <Link className="news-back" to="/news">← {t('news.back')}</Link>
          <div className="news-card-meta"><span>{article.author_name || t('news.author')}</span><time>{fmtDateTime(article.published_at)}</time></div>
          <h2 className="news-article-title">{article.title}</h2>
          {article.summary && <p className="news-article-summary">{article.summary}</p>}
          {article.coverUrl && <img className="news-article-cover" src={article.coverUrl} alt="" decoding="async" />}
          <NewsContent value={article.content} />
        </article>
      )}
      {id && !loading && !article && !error && <p className="news-empty">{t('news.notFound')}</p>}

      {!id && !loading && !error && list.length === 0 && (
        <div className="news-empty"><strong>{t('news.emptyTitle')}</strong><p>{t('news.emptyBody')}</p></div>
      )}
      {!id && !loading && list.length > 0 && <>
        <div className="news-grid">{list.map((item, i) => <div className="news-item" key={item.id}><span className="news-index">{String((page - 1) * 20 + i + 1).padStart(2, '0')}</span><ArticleCard article={item} /></div>)}</div>
        <div className="news-pagination">
          <span>{t('news.total', { n: total })}</span>
          <div className="btn-row">
            <button className="mini-btn" disabled={page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); window.scrollTo(0, 0) }}>{t('news.previous')}</button>
            <span className="news-page-count">{page}</span>
            <button className="mini-btn" disabled={page * 20 >= total} onClick={() => { setPage((p) => p + 1); window.scrollTo(0, 0) }}>{t('news.next')}</button>
          </div>
        </div>
      </>}
    </main>
  )
}
