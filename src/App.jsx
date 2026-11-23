import { useCallback, useEffect, useRef, useState } from 'react'
import { HashRouter, Routes, Route, Link, useNavigate, useLocation, Navigate } from 'react-router-dom'
import AuthView, { OAUTH_ERROR_KEY } from './views/AuthView'
import MemberView from './views/MemberView'
import AdminView from './views/AdminView'
import HuntsView from './views/HuntsView'
import AccountView from './views/AccountView'
import NewsView from './views/NewsView'
import MemberNewsView from './views/MemberNewsView'
import { t } from './i18n'
import api from './api'
import { prefetchHunts, clearHuntsCache, syncHuntsAuth, adoptHuntsIdentity } from './huntsCache'
import {
  prefetchPanel, clearPanelCache, readUserCache, writeUserCache,
  syncPanelAuth, adoptPanelIdentity, markPanelAuthUnverified
} from './panelCache'

/* 角色：admin 与 superadmin 都算职员 */
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'superadmin')

/* 认证代次守卫（auth epoch）
   · 每次身份落定（登录、退出、/me 确认）都会 bump：任何更早发出的 /me 随即过期。
   · refresh 发起时 bump() 取号，回调里用 commit(snap, fn) 提交：
     代次变了就整份忽略 —— mount 时发出的 /me 不会在用户随后登录后才返回、
     把新登录的身份覆盖回旧值；两个并发 /me 也只有最后发起的那一个能落地。
   · 导出仅用于回归测试；页面里由 useUser 的 ref 持有。 */
export function createAuthGate() {
  let seq = 0
  return {
    snapshot: () => seq,
    bump: () => { seq += 1; return seq },
    commit: (snap, fn) => (snap === seq ? fn() : null)
  }
}

/* 用户态
   · 先用上次的登录态快照渲染外壳，但 verified 保持 false：私信/管理这类敏感内容
     必须等 /me 确认身份后才渲染（审计 F-03）。
   · /me 网络失败或服务端错误 → 身份未确认：保留快照供外壳使用，隐藏敏感内容并提供重试；
     只有正常的 200 {user:null} 才算「未登录」，此时清掉缓存身份与数据。
   · 身份一变就同步给缓存层（syncPanelAuth/syncHuntsAuth），旧在途请求随之作废。 */
function useUser() {
  // 快照只用来占位；顺手登记「这些缓存属于谁」，但不作废它（刚打开页面，缓存本就是这人的）
  const [initial] = useState(() => {
    const u = readUserCache()
    if (u && u.id) {
      adoptPanelIdentity(u.id)
      adoptHuntsIdentity(u.id)
    }
    return u
  })
  const [user, setUserState] = useState(() => initial)
  const [notifUnread, setNotifUnread] = useState(0)
  const [ready, setReady] = useState(false)      // /me 的这一次尝试是否结束
  const [verified, setVerified] = useState(false) // 当前身份是否已被服务端确认
  const [authError, setAuthError] = useState('')
  /* 认证代次：ref 跨渲染稳定；每次身份落定都 bump，旧 /me 响应随之过期 */
  const authGate = useRef(createAuthGate())

  /* 把「已确认的身份」落进 React 状态与缓存层；身份变化会作废旧缓存与旧请求 */
  const adopt = useCallback((u, isVerified) => {
    // 先推进代次：从这一刻起，期间在途的 /me 响应（成功或失败）全部过期
    authGate.current.bump()
    const id = u && u.id ? u.id : null
    syncPanelAuth(id, isVerified)
    syncHuntsAuth(id)
    writeUserCache(u || null)
    setUserState(u || null)
    setVerified(isVerified)
  }, [])

  // 拉一次 /me 并把结果写回状态；OAuth 回跳后需要重跑一次（Cookie 刚种下）
  const refresh = useCallback(() => {
    // 发起时就推进代次：并发的两个 /me 里，先发起的那一个立刻过期；
    // 回调只认自己这一代，且期间发生登录/退出也会让它整份失效
    const snap = authGate.current.bump()
    return api('/me')
      .then((d) => authGate.current.commit(snap, () => {
        adopt(d.user || null, true)
        setNotifUnread(d.notifUnread || 0)
        setAuthError('')
        return d.user || null
      }))
      .catch((err) => authGate.current.commit(snap, () => {
        // 身份没有被确认：不清缓存（可能只是断网），但绝不能把它当已认证状态
        markPanelAuthUnverified()
        setVerified(false)
        setAuthError((err && err.message) || t('api.failed'))
        return null
      }))
  }, [adopt])

  useEffect(() => { refresh().finally(() => setReady(true)) }, [refresh])
  // 所有改用户态的地方（登录、改昵称、退出）都同步写快照
  const setUser = (u) => adopt(u, true)
  return { user, setUser, notifUnread, setNotifUnread, ready, verified, authError, refresh }
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

/* ============ 身份确认闸门 ============ */

/* /me 还没回来：不渲染任何会话内容（此前这里是 null，直接空白，行为保持一致） */
function IdentityPending() {
  return (
    <div className="panel-page">
      <p className="panel-empty">{t('common.loading')}</p>
    </div>
  )
}

/* /me 网络失败 / 服务端错误：身份未确认。
   旧快照还在，但这不等于「已登录」——不渲染私信、管理数据，只给重试。
   文案直接写在这里：src/locales 不在本次修复允许改动的范围内。 */
function IdentityUnverified({ error, onRetry }) {
  const [retrying, setRetrying] = useState(false)
  const retry = () => {
    setRetrying(true)
    Promise.resolve(onRetry()).finally(() => setRetrying(false))
  }
  return (
    <div className="panel-page">
      <div className="panel-head">
        <p className="auth-kicker">{t('site.name')}</p>
        <h1 className="panel-title">身份尚未确认</h1>
      </div>
      <p className="auth-msg" role="alert">{error || t('api.failed')}</p>
      <p className="acct-note">当前登录状态还没得到服务器确认，为免在共享设备上显示他人数据，私信与管理内容暂时隐藏。</p>
      <div className="btn-row">
        <button type="button" className="mini-btn" onClick={retry} disabled={retrying}>
          {retrying ? t('common.loading') : '重试'}
        </button>
      </div>
    </div>
  )
}

/* 受保护页面统一入口：未就绪 → 加载中；未确认 → 隐藏 + 重试；未登录 → 去登录。
   render(user) 只在身份确认后才执行，所以页面组件可以直接写 key={user.id}：账号一换就卸载旧实例，不会用上一个账号的组件 state 渲染任何一帧。导出是为了让回归测试能断言「未确认时不渲染受保护内容」。 */
export function gate({ ready, verified, user, authError, refresh, children, render }) {
  if (!ready) return <IdentityPending />
  if (!verified) return <IdentityUnverified error={authError} onRetry={refresh} />
  if (!user) return <Navigate to="/login" replace />
  return render ? render(user) : children
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
  const { user, setUser, notifUnread, setNotifUnread, ready, verified, authError, refresh } = useUser()
  // OAuth 回跳：后端已经种好会话 Cookie，这里把用户态补上并清掉查询串
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('oauth')
    if (!result) return
    // 清掉 ?oauth=：结果只该被处理一次，刷新不应重复提示
    window.history.replaceState(null, '', window.location.pathname + window.location.hash)
    if (result === 'ok') {
      refresh()
    } else {
      try { sessionStorage.setItem(OAUTH_ERROR_KEY, result) } catch { /* 隐私模式忽略 */ }
      window.location.hash = '#/login'
    }
  }, [])
  // 登录且身份确认后，才在后台预取赛事列表与面板数据：点开「赛事总览 / 成员面板 / 管理后台」时直接出内容。
  // 身份未确认（verified=false）时既不预取也不渲染敏感缓存：无身份请求不能绑定到某个账号。
  useEffect(() => {
    if (!ready) return
    if (!verified) return
    if (user) {
      prefetchHunts(user.id)
      prefetchPanel(user)
    } else {
      // 正常的 200 {user:null}：缓存层已随身份变化作废，这里再兜底清一次
      clearHuntsCache()
      clearPanelCache()
    }
  }, [user, ready, verified])

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
          <Route path="/news" element={<NewsView />} />
          <Route path="/news/:id" element={<NewsView />} />
          {/* key={user.id}：账号一换就强制卸载旧实例、用新实例重新初始化。
               只靠组件内的 useEffect 重置的话，切换后的首个 render 仍会短暂沿用
               A 的 state 渲染一帧；key 让这条窗口在渲染阶段就消失。 */}
          <Route path="/hunts" element={gate({ ready, verified, user, authError, refresh, render: (user) => <HuntsView key={user.id} user={user} onNotifRead={() => setNotifUnread(0)} /> })} />
          <Route path="/member" element={gate({ ready, verified, user, authError, refresh, render: (user) => <MemberView key={user.id} user={user} /> })} />
          <Route path="/member/news" element={gate({ ready, verified, user, authError, refresh, render: (user) => <MemberNewsView key={user.id} /> })} />
          <Route path="/admin" element={!ready ? <IdentityPending /> : !verified ? <IdentityUnverified error={authError} onRetry={refresh} /> : !isStaff(user) ? <Navigate to="/login" replace /> : <AdminView key={user.id} user={user} />} />
          <Route path="/account" element={gate({ ready, verified, user, authError, refresh, render: (user) => <AccountView key={user.id} user={user} setUser={setUser} /> })} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </>
  )
}
