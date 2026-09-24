import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Link, useNavigate, useLocation, Navigate } from 'react-router-dom'
import Reveal from './components/Reveal'
import AuthView from './views/AuthView'
import MemberView from './views/MemberView'
import AdminView from './views/AdminView'
import { t } from './i18n'
import api from './api'

/* 用户态 */
function useUser() {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    api('/me').then((d) => setUser(d.user || null)).catch(() => {}).finally(() => setReady(true))
  }, [])
  return { user, setUser, ready }
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
  const aboutContact = t('about.contact')
  const contact = t('contact')

  return (
    <main>
      <section id="top" className="cover">
        <div className="cover-meta">{heroMeta.map((m, i) => <span key={i}>{m}</span>)}</div>
        <h1 className="cover-title">{t('hero.title1')}</h1>
        <p className="cover-eng">{t('hero.title2')}</p>
        <p className="cover-sub">{t('hero.subtitle')}</p>
        <a className="cover-cta" href="#/login">{t('hero.cta')}</a>
        <div className="cover-scroll">{t('hero.scroll')}</div>
      </section>

      <section id="about" className="col">
        <div className="col-head"><span className="col-no">{t('sections.about.no')}</span><h2 className="col-title">{t('sections.about.title')}</h2><span className="col-en">{t('sections.about.en')}</span></div>
        <div className="about-grid">
          <Reveal className="about-left">
            <div className="about-portrait">
              {t('about.image') ? (
                <picture>
                  <source srcSet="/images/caar-hero-portrait.webp" type="image/webp" />
                  <img src={t('about.image')} alt={t('about.name')} width={480} height={640} />
                </picture>
              ) : <span className="about-seal">{t('about.name')}</span>}
            </div>
          </Reveal>
          <div className="about-right">
            <Reveal><h3 className="about-name">{t('about.name')}</h3><p className="about-role">{t('about.role')}</p></Reveal>
            <Reveal className="about-intro">{aboutIntro.map((p, i) => <p key={i}>{p}</p>)}</Reveal>
            <Reveal className="about-contact">
              <div><span>{t('about.labels.email')}</span>{aboutContact.email}</div>
              <div><span>{t('about.labels.phone')}</span>{aboutContact.phone}</div>
              <div><span>{t('about.labels.location')}</span>{aboutContact.location}</div>
              <div><span>{t('about.labels.qq')}</span>{aboutContact.qq}</div>
            </Reveal>
            <Reveal className="about-stats">
              {aboutStats.map((s, i) => (
                <div key={i} className="stat"><span className="stat-v">{s.value}</span><span className="stat-l">{s.label}</span></div>
              ))}
            </Reveal>
          </div>
        </div>
      </section>

      <section id="projects" className="col col--dark">
        <div className="col-head"><span className="col-no">{t('sections.projects.no')}</span><h2 className="col-title">{t('sections.projects.title')}</h2><span className="col-en">{t('sections.projects.en')}</span></div>
        <div className="record-list">
          {projects.map((p, i) => (
            <Reveal key={i} className="record" delay={i * 90}>
              <div className="record-meta"><span>{p.year}</span><span>{p.tag}</span></div>
              <div><h3 className="record-title">{p.title}</h3><p className="record-desc">{p.desc}</p></div>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="members" className="col">
        <div className="col-head"><span className="col-no">{t('sections.members.no')}</span><h2 className="col-title">{t('sections.members.title')}</h2><span className="col-en">{t('sections.members.en')}</span></div>
        <div className="staff-grid">
          {members.map((m, i) => (
            <Reveal key={i} className="staff" delay={i * 80}>
              <div className="staff-avatar">{m.avatar ? <img src={m.avatar} alt={m.name} /> : <span>{m.name.slice(0, 1)}</span>}</div>
              <h3 className="staff-name">{m.name}</h3>
              <p className="staff-role">{m.role}</p>
              <p className="staff-desc">{m.desc}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="faq" className="col col--tint">
        <div className="col-head"><span className="col-no">{t('sections.faq.no')}</span><h2 className="col-title">{t('sections.faq.title')}</h2><span className="col-en">{t('sections.faq.en')}</span></div>
        <div className="letter-list">
          {faqs.map((f, i) => (
            <Reveal key={i} className="letter" delay={i * 60}>
              <h3 className="letter-q">{f.q}</h3>
              <p className="letter-a">{f.a}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <footer id="contact" className="colophon">
        <div className="col-head col-head--light"><span className="col-no">{t('sections.contact.no')}</span><h2 className="col-title">{t('sections.contact.title')}</h2><span className="col-en">{t('sections.contact.en')}</span></div>
        <Reveal>
          <a className="colophon-mail" href={"mailto:" + contact.email}>{contact.email}</a>
          <p className="colophon-note">{contact.note}</p>
        </Reveal>
        <Reveal className="colophon-row" delay={120}>
          <div><span>{t('contact.labels.phone')}</span>{contact.phone}</div>
          <div><span>{t('contact.labels.address')}</span>{contact.location}</div>
          <div><span>{t('contact.labels.qq')}</span>{contact.qq}</div>
        </Reveal>
        <div className="colophon-foot">{contact.footer} · {t('site.name')}</div>
      </footer>
    </main>
  )
}

/* ============ 布局（刊头导航） ============ */
function Shell({ user, setUser, ready }) {
  const [scrolled, setScrolled] = useState(false)
  const nav = useNavigate()
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const logout = async () => { try { await api('/logout', { method: 'POST' }) } catch {} setUser(null); nav('/') }

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
              <Link to="/member">{t('nav.memberPanel')}</Link>
              {user.role === 'admin' && <Link to="/admin">{t('nav.adminPanel')}</Link>}
              <Link to="/" onClick={logout}>{t('nav.logout', { name: user.nickname || user.username })}</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}

export default function App() {
  const { user, setUser, ready } = useUser()
  return (
    <>
      <HashRouter>
        <Shell user={user} setUser={setUser} ready={ready} />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthView mode="login" onLogin={setUser} />} />
          <Route path="/register" element={<AuthView mode="register" onLogin={setUser} />} />
          <Route path="/member" element={ready && !user ? <Navigate to="/login" replace /> : <MemberView />} />
          <Route path="/admin" element={ready && (!user || user.role !== 'admin') ? <Navigate to="/login" replace /> : <AdminView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </>
  )
}
