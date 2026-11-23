import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'
import { readHuntsCache, writeHuntsCache, fetchHunts } from '../huntsCache'

/* 上游时间是带时区的本地时间（默认 Asia/Shanghai），按墙上时间展示，不做时区换算 */
function fmtDay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return ''
  const day = m[2] + '/' + m[3]
  return m[4] ? day + ' ' + m[4] + ':' + m[5] : day
}

function rangeText(h) {
  const start = fmtDay(h.startAt)
  if (!start) return t('hunts.dateUnknown')
  if (!h.endAt) return start + ' ' + t('hunts.startSuffix')
  return start + ' – ' + fmtDay(h.endAt)
}

function clockOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// D1 存的是 UTC 的 'YYYY-MM-DD HH:MM:SS'
function timeAgo(s) {
  const t0 = Date.parse(String(s || '').replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t0)) return ''
  const diff = Math.max(0, (Date.now() - t0) / 1000)
  if (diff < 60) return t('hunts.notif.justNow')
  if (diff < 3600) return t('hunts.notif.minutesAgo', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('hunts.notif.hoursAgo', { n: Math.floor(diff / 3600) })
  return t('hunts.notif.daysAgo', { n: Math.floor(diff / 86400) })
}

const STATUS_TONE = { running: 'running', ended: 'ended', upcoming: 'upcoming' }

// 无封面时用全名占位：按视觉宽度（CJK 记 2）选字号，避免长标题撑破卡片
function fallbackClass(title) {
  let w = 0
  for (const ch of String(title || '')) w += ch.charCodeAt(0) > 255 ? 2 : 1
  if (w <= 12) return ' is-xl'
  if (w <= 20) return ' is-lg'
  if (w <= 34) return ' is-md'
  return ' is-sm'
}

function HuntCard({ hunt, pending, onToggle }) {
  const status = STATUS_TONE[hunt.status] || ''
  const statusLabel = status ? t('hunts.status.' + status) : t('hunts.longTerm')
  const shown = hunt.interested.slice(0, 5)
  const rest = hunt.interested.length - shown.length

  return (
    <article id={'hunt-' + hunt.id} className={'hunt' + (hunt.mine ? ' hunt--mine' : '') + (hunt.missing ? ' hunt--missing' : '')}>
      <a className="hunt-thumb" href={hunt.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
        <span className="hunt-thumb-fallback">
          <span className={'hunt-fallback-text' + fallbackClass(hunt.title)}>{hunt.title || '?'}</span>
        </span>
        {hunt.thumb && (
          <img
            src={hunt.thumb}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
        )}
        <span className={'hunt-badge' + (status ? ' hunt-badge--' + status : '')}>{statusLabel}</span>
      </a>

      <div className="hunt-body">
        <div className="hunt-meta">
          {!hunt.missing && <span>{hunt.type === 'long_term' ? t('hunts.longTerm') : t('hunts.regular')}</span>}
          {hunt.rating > 0 && <span>★ {hunt.rating.toFixed(1)}</span>}
          {hunt.lang === 'zh-CN' && <span>中文</span>}
          {hunt.external && <span>EXTERNAL</span>}
        </div>

        <h3 className="hunt-title">
          <a href={hunt.url} target="_blank" rel="noreferrer">{hunt.title}</a>
        </h3>
        <p className="hunt-date">{rangeText(hunt)}</p>
        {hunt.missing && <p className="hunt-note">{t('hunts.missing')}</p>}
        {hunt.summary && <p className="hunt-summary">{hunt.summary}</p>}
        {hunt.tags.length > 0 && (
          <div className="hunt-tags">{hunt.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
        )}

        <div className="hunt-people">
          {hunt.interested.length === 0 && <span className="hunt-nobody">{t('hunts.nobodyYet')}</span>}
          {shown.map((p, i) => (
            <span key={i} className={'hunt-person' + (p.me ? ' hunt-person--me' : '')}>
              {p.me ? t('hunts.me') : p.name}
            </span>
          ))}
          {rest > 0 && <span className="hunt-person hunt-person--more">{t('hunts.more', { n: rest })}</span>}
        </div>

        <button
          type="button"
          className={'hunt-toggle' + (hunt.mine ? ' on' : '')}
          aria-pressed={hunt.mine}
          disabled={pending}
          onClick={() => onToggle(hunt)}
        >
          {pending ? t('hunts.marking') : hunt.mine ? t('hunts.marked') : t('hunts.mark')}
        </button>
      </div>
    </article>
  )
}

const EMPTY = { list: [], mineCount: 0, updatedAt: 0, total: 0 }

// 只改动一张卡的标记状态，mineCount 由列表重算，避免并发点击时计数漂移
function withMine(data, huntId, mine, myName) {
  const list = data.list.map((h) => {
    if (h.id !== huntId) return h
    const others = h.interested.filter((p) => !p.me)
    return { ...h, mine, interested: mine ? others.concat({ name: myName, me: true }) : others }
  })
  return { ...data, list, mineCount: list.filter((h) => h.mine).length }
}

export default function HuntsView({ user, onNotifRead }) {
  const userId = user && user.id
  // 命中预加载缓存时首帧就有内容，loading 只留给真正没数据的首次访问
  const [data, setData] = useState(() => readHuntsCache(userId) || EMPTY)
  const [loading, setLoading] = useState(() => !readHuntsCache(userId))
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [pending, setPending] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [notifs, setNotifs] = useState([])
  const [notifUnread, setNotifUnread] = useState(0)
  const [feedSource, setFeedSource] = useState('')
  const dataRef = useRef(data)

  const myName = (user && (user.nickname || user.username)) || t('hunts.me')

  const commit = (next) => {
    dataRef.current = next
    setData(next)
    writeHuntsCache(userId, next)
  }

  const load = useCallback(async (force) => {
    if (force || !dataRef.current.list.length) setBusy(true)
    setError('')
    try {
      const d = await fetchHunts(userId, force)
      commit({ list: d.list || [], mineCount: d.mineCount || 0, updatedAt: d.updatedAt || 0, total: d.total || 0 })
      setFeedSource(d.source || '')
    } catch (err) {
      setError(err.message || t('hunts.loadFailed'))
    } finally {
      setLoading(false)
      setBusy(false)
    }
  }, [userId])

  useEffect(() => { load(false) }, [load])

  // 动态：别人标记了我已标记的 hunt
  useEffect(() => {
    let alive = true
    api('/notifications')
      .then((d) => {
        if (!alive) return
        setNotifs(d.list || [])
        setNotifUnread(d.unread || 0)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const markAllRead = async () => {
    try {
      await api('/notifications/read', { method: 'POST' })
      setNotifs((old) => old.map((n) => ({ ...n, read_at: n.read_at || 'read' })))
      setNotifUnread(0)
      if (onNotifRead) onNotifRead()
    } catch (err) {
      setError(err.message)
    }
  }

  // 点动态跳到对应卡片：先复位筛选与搜索，等重渲染后再滚动
  const focusHunt = (huntId) => {
    setFilter('all')
    setQ('')
    setTimeout(() => {
      const el = document.getElementById('hunt-' + huntId)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('hunt--flash')
      setTimeout(() => el.classList.remove('hunt--flash'), 1400)
    }, 90)
  }

  const toggle = async (hunt) => {
    if (pending.has(hunt.id)) return
    const next = !hunt.mine
    setPending((old) => new Set(old).add(hunt.id))
    setError('')
    // 先改本地状态，请求失败只回滚这一张卡
    commit(withMine(dataRef.current, hunt.id, next, myName))
    try {
      await api('/hunts/interest', { method: 'POST', body: { hunt_id: hunt.id, interested: next } })
    } catch (err) {
      commit(withMine(dataRef.current, hunt.id, !next, myName))
      setError(err.message)
    } finally {
      setPending((old) => { const s = new Set(old); s.delete(hunt.id); return s })
    }
  }

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase()
    return data.list.filter((h) => {
      if (filter === 'mine' && !h.mine) return false
      if (filter === 'open' && h.status === 'ended') return false
      if (!key) return true
      return (
        h.title.toLowerCase().includes(key) ||
        h.summary.toLowerCase().includes(key) ||
        h.tags.some((tag) => String(tag).toLowerCase().includes(key)) ||
        h.authors.some((name) => String(name).toLowerCase().includes(key))
      )
    })
  }, [data.list, filter, q])

  const peopleCount = useMemo(() => {
    const names = new Set()
    for (const h of data.list) for (const p of h.interested) names.add(p.name)
    return names.size
  }, [data.list])

  const filters = [
    { key: 'all', label: t('hunts.filterAll'), n: data.list.length },
    { key: 'mine', label: t('hunts.filterMine'), n: data.mineCount },
    { key: 'open', label: t('hunts.filterOpen'), n: data.list.filter((h) => h.status !== 'ended').length }
  ]

  return (
    <div className="panel-page panel-page--hunts">
      <div className="panel-head">
        <p className="auth-kicker">{t('hunts.kicker')}</p>
        <h1 className="panel-title">{t('hunts.title')}</h1>
        <Link className="panel-back" to="/">{t('common.backHome')}</Link>
      </div>

      <section className="panel-sec hunt-board">
        <p className="hunt-intro">{t('hunts.intro')}</p>
        <p className="hunt-summary-line">
          {t('hunts.summary', { total: data.total, mine: data.mineCount, people: peopleCount })}
          {data.updatedAt > 0 && <span className="hunt-updated">{t('hunts.updatedAt', { time: clockOf(data.updatedAt) })}</span>}
          {feedSource === 'stale-timeout' && <span className="hunt-slow">{t('hunts.refreshSlow')}</span>}
        </p>

        {notifs.length > 0 && (
          <section className="notif" aria-live="polite">
            <div className="notif-head">
              <span className="notif-kicker">{t('hunts.notif.title')}</span>
              {notifUnread > 0 && <span className="notif-count">{t('hunts.notif.unread', { n: notifUnread })}</span>}
              {notifUnread > 0 && (
                <button type="button" className="mini-btn notif-read" onClick={markAllRead}>{t('hunts.notif.markAllRead')}</button>
              )}
            </div>
            <ul className="notif-list">
              {notifs.slice(0, 4).map((n) => (
                <li key={n.id} className={'notif-item' + (n.read_at ? '' : ' notif-item--new')}>
                  <button type="button" onClick={() => focusHunt(n.hunt_id)}>
                    <span className="notif-text">{t('hunts.notif.body', { name: n.actor_name, hunt: n.hunt_title })}</span>
                    <span className="notif-time">{timeAgo(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {notifs.length > 4 && <p className="notif-more">{t('hunts.notif.more', { n: notifs.length - 4 })}</p>}
          </section>
        )}

        <div className="hunt-bar">
          <input
            className="hunt-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('hunts.searchPlaceholder')}
            aria-label={t('hunts.searchPlaceholder')}
          />
          <div className="hunt-filters">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                className={'hunt-filter' + (filter === f.key ? ' on' : '')}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
              >
                {f.label} <b>{f.n}</b>
              </button>
            ))}
          </div>
          <button type="button" className="mini-btn" onClick={() => load(true)} disabled={busy}>
            {busy ? t('hunts.loading') : t('hunts.refresh')}
          </button>
        </div>

        {error && <p className="auth-msg" role="alert">{error}</p>}

        {loading && <p className="panel-empty">{t('hunts.loading')}</p>}

        {!loading && filtered.length === 0 && (
          <p className="panel-empty">{filter === 'mine' && !q ? t('hunts.emptyMine') : t('hunts.empty')}</p>
        )}

        <div className="hunt-grid">
          {filtered.map((h) => (
            <HuntCard key={h.id} hunt={h} pending={pending.has(h.id)} onToggle={toggle} />
          ))}
        </div>
      </section>
    </div>
  )
}
