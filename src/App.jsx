import { useEffect, useRef, useState } from 'react'
import { HashRouter, Routes, Route, Link, useNavigate, useLocation, Navigate } from 'react-router-dom'
import AuthView from './views/AuthView'
import MemberView from './views/MemberView'
import AdminView from './views/AdminView'
import HuntsView from './views/HuntsView'
import AccountView from './views/AccountView'
import { t } from './i18n'
import api from './api'
import { prefetchHunts, clearHuntsCache } from './huntsCache'
import { prefetchPanel, clearPanelCache, startInboxPrefetch, readUserCache, writeUserCache } from './panelCache'

/* 角色：admin 与 superadmin 都算职员 */
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'superadmin')

/* 用户态 */
function useUser() {
  // 先用上次的登录态快照渲染，避免刷新时先干等一次 /me；随后再用 /me 校验
  const [user, setUserState] = useState(() => readUserCache())
  const [notifUnread, setNotifUnread] = useState(0)
  const [ready, setReady] = useState(() => !!readUserCache())
  useEffect(() => {
    api('/me')
      .then((d) => {
        const u = d.user || null
        writeUserCache(u)
        setUserState(u)
        setNotifUnread(d.notifUnread || 0)
      })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])
  // 所有改用户态的地方（登录、改昵称、退出）都同步写快照
  const setUser = (u) => { writeUserCache(u); setUserState(u) }
  return { user, setUser, notifUnread, setNotifUnread, ready }
}

/* 首页锚点链接（兼容 HashRouter） */
function Anchor({ to, id, className, children }) {
  const nav = useNavigate()
  const loc = useLocation()
  return (
    <a className={className} href={'#' + id} onClick={(e) => {
      e.preventDefault()
      if (loc.pathname !== '/') nav('/', { state: { scrollTo: id } })
      else document.getElementById(id) && document.getElementById(id).scrollIntoView({ behavior: 'smooth' })
    }}>{children}</a>
  )
}

/* ============ 首页 ============ */
function Home() {
  const loc = useLocation()
  const pagesRef = useRef(null)
  const animRef = useRef(0)
  const [pageIndex, setPageIndex] = useState(0)
  const pageCount = 5
  // 固定 200ms 的自行缓动：CSS scroll-behavior: smooth 的时长由浏览器决定（整屏约 500ms），不可控。
  const goToPage = (index) => {
    const pages = pagesRef.current
    if (!pages) return
    const target = Math.max(0, Math.min(pageCount - 1, index)) * pages.clientHeight
    const from = pages.scrollTop
    cancelAnimationFrame(animRef.current)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || Math.abs(target - from) < 2) {
      pages.style.scrollBehavior = ''
      pages.style.scrollSnapType = ''
      pages.scrollTop = target
      return
    }
    // 动画期间关掉平滑与吸附，否则每帧赋值会被浏览器再套一层缓动/回弹。
    pages.style.scrollBehavior = 'auto'
    pages.style.scrollSnapType = 'none'
    const start = performance.now()
    const duration = 200
    const ease = (p) => 1 - Math.pow(1 - p, 3)
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration)
      pages.scrollTop = from + (target - from) * ease(p)
      if (p < 1) { animRef.current = requestAnimationFrame(step); return }
      pages.scrollTop = target
      pages.style.scrollBehavior = ''
      pages.style.scrollSnapType = ''
      animRef.current = 0
    }
    animRef.current = requestAnimationFrame(step)
  }
  useEffect(() => () => cancelAnimationFrame(animRef.current), [])
  const onPageKey = (e) => {
    if (e.target !== e.currentTarget) return
    const next = { PageDown: pageIndex + 1, PageUp: pageIndex - 1, Home: 0, End: pageCount - 1 }[e.key]
    if (next !== undefined) { e.preventDefault(); goToPage(next) }
  }
  useEffect(() => {
    const pages = pagesRef.current
    let lastWheel = -Infinity
    let lockedUntil = 0
    let handled = false
    let innerGesture = false
    let distance = 0
    const onWheel = (event) => {
      // Keep browser zoom and horizontal gestures native.
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return
      const now = performance.now()
      if (now - lastWheel > 120 && now >= lockedUntil) {
        handled = false
        innerGesture = false
        distance = 0
      }
      lastWheel = now
      if (handled || now < lockedUntil) { event.preventDefault(); return }
      const index = Math.round(pages.scrollTop / pages.clientHeight)
      const page = pages.children[index]
      const down = event.deltaY > 0
      const canScrollInside = down
        ? page.scrollTop + page.clientHeight < page.scrollHeight - 2
        : page.scrollTop > 2
      if (canScrollInside) {
        innerGesture = true
        return
      }
      event.preventDefault()
      // Reaching the end of long content must not spill into the next page.
      if (innerGesture) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pages.clientHeight : 1)
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0
      distance += delta
      if (Math.abs(distance) < 24) return
      handled = true
      lockedUntil = now + 150
      goToPage(index + (down ? 1 : -1))
    }
    pages.addEventListener('wheel', onWheel, { passive: false })
    return () => pages.removeEventListener('wheel', onWheel)
  }, [])
  useEffect(() => {
    const t2 = loc.state && loc.state.scrollTo
    if (t2) setTimeout(() => { const el = document.getElementById(t2); el && el.scrollIntoView({ behavior: 'smooth' }) }, 60)
  }, [loc])

  const heroMeta = t('hero.meta')
  const aboutIntro = t('about.intro')
  const aboutStats = t('about.stats')
  const projects = t('projects')
  const members = t('members')
  const faqs = t('faqs')
  const contact = t('contact')
  // 05 的标题拆成「问句 + 填空答案」两段：第二段压在高亮块上
  const joinTitle = t('sections.contact.title')
  const joinCut = joinTitle.indexOf('，')
  const joinHead = joinCut > -1 ? joinTitle.slice(0, joinCut + 1) : joinTitle
  const joinAnswer = joinCut > -1 ? joinTitle.slice(joinCut + 1) : ''

  return (
    <>
    <main ref={pagesRef} className="home-pages" tabIndex={0} aria-label={t('pageNavigation.label')} onKeyDown={onPageKey} onScroll={(e) => { if (e.target === e.currentTarget) setPageIndex(Math.round(e.currentTarget.scrollTop / e.currentTarget.clientHeight)) }}>
      <div className="home-intro home-page">
      <section id="top" className="cover">
        <div className="cover-meta">{heroMeta.map((m, i) => <span key={i}>{m}</span>)}</div>
        <h1 className="cover-title">{t('hero.title1')}</h1>
        <p className="cover-eng">{t('hero.title2')}</p>
        <p className="cover-sub">{t('hero.subtitle')}</p>
        <button type="button" className="cover-cta" onClick={() => goToPage(pageCount - 1)}>
          <span>{t('hero.cta')}</span><span className="cover-cta-arrow" aria-hidden="true">↓</span>
        </button>
      </section>

      <section id="about" className="sec">
        <div className="rail">
          <span className="rail-no">{t('sections.about.no')}</span>
          <span className="rail-line" aria-hidden="true" />
          <span className="rail-en">{t('sections.about.en')}</span>
        </div>
        <div className="sec-head">
          <h2 className="sec-title">{t('sections.about.title')}</h2>
          <p className="sec-lead">{t('about.role')}</p>
        </div>
        <div className="about-grid">
          <div className="about-portrait">
            {t('about.image') ? (
              <picture>
                <source srcSet="/images/caar-seal.webp" type="image/webp" />
                <img src={t('about.image')} alt={t('about.name')} width={760} height={760} />
              </picture>
            ) : <span className="about-seal">{t('about.name')}</span>}
          </div>
          <ol className="about-intro">
            {aboutIntro.map((p, i) => (
              <li key={i}><span className="about-intro-no" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><p>{p}</p></li>
            ))}
          </ol>
          <div className="about-stats">
            {aboutStats.map((s, i) => (
              <div key={i} className="stat"><span className="stat-v">{s.value}</span><span className="stat-l">{s.label}</span></div>
            ))}
          </div>
        </div>
      </section>

      </div>

      <section id="projects" className="sec sec--dark home-page">
        <div className="rail rail--dark">
          <span className="rail-no">{t('sections.projects.no')}</span>
          <span className="rail-line" aria-hidden="true" />
          <span className="rail-en">{t('sections.projects.en')}</span>
        </div>
        <div className="sec-head">
          <h2 className="sec-title">{t('sections.projects.title')}</h2>
          <p className="sec-lead">{t('recordsNote')}</p>
        </div>
        <div className="record-list">
          {projects.map((p, i) => (
            <article className="record" key={i}>
              <span className="record-no" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <div className="record-meta"><span>{p.year}</span><span>{p.tag}</span></div>
              <h3 className="record-title">{p.title}</h3>
              <p className="record-desc">{p.desc}</p>
            </article>
          ))}
          <div className="record-end"><b>{t('recordsEnd')}</b><span aria-hidden="true">…</span></div>
        </div>
      </section>

      <section id="members" className="sec home-page">
        <div className="rail">
          <span className="rail-no">{t('sections.members.no')}</span>
          <span className="rail-line" aria-hidden="true" />
          <span className="rail-en">{t('sections.members.en')}</span>
        </div>
        <div className="sec-head">
          <h2 className="sec-title">{t('sections.members.title')}</h2>
          <p className="sec-lead">{t('membersNote')}</p>
        </div>
        <div className="staff-grid">
          {members.map((m, i) => (
            <article className="staff" key={i}>
              <div className="staff-avatar">{m.avatar ? <img src={m.avatar} alt={m.name} /> : <span>{m.name.slice(0, 1)}</span>}</div>
              <div className="staff-body">
                <span className="staff-no" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="staff-name">{m.name}</h3>
                <p className="staff-role">{m.role}</p>
                <p className="staff-desc">{m.desc}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="faq" className="sec sec--tint home-page">
        <div className="rail">
          <span className="rail-no">{t('sections.faq.no')}</span>
          <span className="rail-line" aria-hidden="true" />
          <span className="rail-en">{t('sections.faq.en')}</span>
        </div>
        <div className="sec-head">
          <h2 className="sec-title">{t('sections.faq.title')}</h2>
        </div>
        <div className="letter-list">
          {faqs.map((f, i) => (
            <article className="letter" key={i}>
              <span className="letter-no" aria-hidden="true">Q{i + 1}</span>
              <h3 className="letter-q">{f.q}</h3>
              <p className="letter-a">{f.a}</p>
            </article>
          ))}
        </div>
      </section>

      <footer id="contact" className="colophon home-page">
        <div className="rail rail--dark">
          <span className="rail-no">{t('sections.contact.no')}</span>
          <span className="rail-line" aria-hidden="true" />
          <span className="rail-en">{t('sections.contact.en')}</span>
        </div>

        <div className="join-stage">
          <div className="join-lead">
            <p className="join-label">{contact.answerLabel}</p>
            <h2 className="join-head">
              <span className="join-head-a">{joinHead}</span>
              <span className="join-blank">{joinAnswer}</span>
            </h2>
            <p className="join-note">{contact.note.split('\n').map((line, i) => <span key={i}>{line}</span>)}</p>
            <a className="join-cta" href={contact.joinUrl} target="_blank" rel="noreferrer">
              <span>{contact.joinLabel}</span>
              <span className="join-cta-arrow" aria-hidden="true">↗</span>
            </a>
          </div>

          <aside className="join-ticket">
            <div className="join-ticket-head">
              <span>{contact.ticket.kicker}</span>
              <span>{contact.ticket.no}</span>
            </div>
            <div className="join-ticket-perf" aria-hidden="true" />
            <div className="join-ticket-body">
              <p className="join-ticket-title">{contact.ticket.title}</p>
              <p className="join-ticket-meta">{contact.ticket.meta}</p>
              <div className="join-ticket-mail">
                <span>{t('contact.labels.email')}</span>
                <strong>{contact.email}</strong>
              </div>
              <div className="join-ticket-code" aria-hidden="true" />
            </div>
          </aside>
        </div>

        <div className="join-foot">
          <span>{contact.footer}</span>
          {/* 隐私说明：折叠在页脚，不抢视觉，但比藏在条款页里更容易被看到 */}
          <details className="privacy">
            <summary>{t('privacy.title')}</summary>
            <p>{t('privacy.body')}</p>
          </details>
        </div>
      </footer>
    </main>
    <nav className="page-dots" aria-label={t('pageNavigation.label')}>
      <span className="page-dots-count" aria-live="polite">{pageIndex + 1}/{pageCount}</span>
      {Array.from({ length: pageCount }, (_, i) => (
        <button
          key={i}
          type="button"
          className={'page-dot' + (i === pageIndex ? ' on' : '')}
          onClick={() => goToPage(i)}
          aria-label={t('pageNavigation.dot', { n: i + 1 })}
          aria-current={i === pageIndex ? 'true' : undefined}
        />
      ))}
    </nav>
    </>
  )
}

/* ============ 布局（刊头导航） ============ */
function Shell({ user, setUser, ready, notifUnread }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={"mast " + (scrolled ? 'on' : '')}>
      <div className="mast-in">
        <Link className="mast-name" to="/">{t('site.name')}</Link>
        <nav className="mast-nav">
          <Anchor to="/" id="about" className="mast-anchor">{t('nav.about')}</Anchor>
          <Anchor to="/" id="projects" className="mast-anchor">{t('nav.projects')}</Anchor>
          <Anchor to="/" id="members" className="mast-anchor">{t('nav.members')}</Anchor>
          <Anchor to="/" id="faq" className="mast-anchor">{t('nav.faq')}</Anchor>
          {ready && !user && <Link className="mast-cta" to="/login">{t('nav.login')}</Link>}
          {ready && user && (
            <>
              <Link to="/hunts" className="mast-hunts">
                {t('nav.hunts')}
                {notifUnread > 0 && <span className="mast-badge" aria-label={t('hunts.notif.badgeLabel')}>{notifUnread > 99 ? '99+' : notifUnread}</span>}
              </Link>
              <Link to="/member">{t('nav.memberPanel')}</Link>
              {isStaff(user) && <Link to="/admin">{t('nav.adminPanel')}</Link>}
              <Link to="/account">{t('nav.account')}</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}

export default function App() {
  const { user, setUser, notifUnread, setNotifUnread, ready } = useUser()
  // 冷启动先并行抓一次收件箱：不必等 /me 回来才知道用户是谁
  useEffect(() => { startInboxPrefetch() }, [])
  // 登录后立刻在后台预取赛事列表与面板数据：点开「赛事总览 / 成员面板 / 管理后台」时直接出内容
  // 注意：必须等 /me 回来（ready）再决定清不清缓存。首屏 user 还是 null 时清缓存，
  // 会把上一次访问写进 sessionStorage 的数据抹掉，刷新就永远命中不了缓存。
  useEffect(() => {
    if (!ready) return
    if (user) {
      prefetchHunts(user.id)
      prefetchPanel(user)
    } else {
      clearHuntsCache()
      clearPanelCache()
    }
  }, [user, ready])

  // 切回标签页时刷新未读动态数（不轮询，避免常驻请求）
  useEffect(() => {
    if (!user) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      api('/me').then((d) => setNotifUnread(d.notifUnread || 0)).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [user, setNotifUnread])

  return (
    <>
      <HashRouter>
        <Shell user={user} setUser={setUser} ready={ready} notifUnread={notifUnread} />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthView mode="login" onLogin={setUser} />} />
          <Route path="/register" element={<AuthView mode="register" onLogin={setUser} />} />
          <Route path="/hunts" element={!ready ? null : !user ? <Navigate to="/login" replace /> : <HuntsView user={user} onNotifRead={() => setNotifUnread(0)} />} />
          <Route path="/member" element={!ready ? null : !user ? <Navigate to="/login" replace /> : <MemberView user={user} />} />
          <Route path="/admin" element={!ready ? null : !isStaff(user) ? <Navigate to="/login" replace /> : <AdminView user={user} />} />
          <Route path="/account" element={!ready ? null : !user ? <Navigate to="/login" replace /> : <AccountView user={user} setUser={setUser} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </>
  )
}
