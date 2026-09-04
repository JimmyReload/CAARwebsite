import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Link, useNavigate, useLocation, Navigate } from 'react-router-dom'
import Intro from './components/Intro'
import Reveal from './components/Reveal'
import AuthView from './views/AuthView'
import MemberView from './views/MemberView'
import AdminView from './views/AdminView'
import { site, hero, about, projects, members, faqs, contact } from './data/content'
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
    const t = loc.state && loc.state.scrollTo
    if (t) setTimeout(() => { const el = document.getElementById(t); el && el.scrollIntoView({ behavior: 'smooth' }) }, 60)
  }, [loc])

  return (
    <main>
      <section id="top" className="cover">
        <div className="cover-meta"><span>VOL.01</span><span>EST. 2023</span><span>CAAR</span></div>
        <h1 className="cover-title">{hero.title1}</h1>
        <p className="cover-eng">{hero.title2}</p>
        <p className="cover-sub">{hero.subtitle}</p>
        <a className="cover-cta" href="#/login">{hero.cta}</a>
        <div className="cover-scroll">SCROLL</div>
      </section>

      <section id="about" className="col">
        <div className="col-head"><span className="col-no">01</span><h2 className="col-title">编者按</h2><span className="col-en">ABOUT</span></div>
        <div className="about-grid">
          <Reveal className="about-left">
            <div className="about-portrait">
              {about.image ? <img src={about.image} alt={about.name} /> : <span className="about-seal">{about.name}</span>}
            </div>
          </Reveal>
          <div className="about-right">
            <Reveal><h3 className="about-name">{about.name}</h3><p className="about-role">{about.role}</p></Reveal>
            <Reveal className="about-intro">{about.intro.map((p, i) => <p key={i}>{p}</p>)}</Reveal>
            <Reveal className="about-contact">
              <div><span>邮箱</span>{about.contact.email}</div>
              <div><span>电话</span>{about.contact.phone}</div>
              <div><span>所在</span>{about.contact.location}</div>
              <div><span>QQ</span>{about.contact.wechat}</div>
            </Reveal>
            <Reveal className="about-stats">
              {about.stats.map((s, i) => (
                <div key={i} className="stat"><span className="stat-v">{s.value}</span><span className="stat-l">{s.label}</span></div>
              ))}
            </Reveal>
          </div>
        </div>
      </section>

      <section id="projects" className="col col--dark">
        <div className="col-head"><span className="col-no">02</span><h2 className="col-title">本期报道</h2><span className="col-en">RECORDS</span></div>
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
        <div className="col-head"><span className="col-no">03</span><h2 className="col-title">作者名录</h2><span className="col-en">STAFF</span></div>
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
        <div className="col-head"><span className="col-no">04</span><h2 className="col-title">读者来信</h2><span className="col-en">Q&amp;A</span></div>
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
        <div className="col-head col-head--light"><span className="col-no">05</span><h2 className="col-title">联系我们</h2><span className="col-en">CONTACT</span></div>
        <Reveal>
          <a className="colophon-mail" href={"mailto:" + contact.email}>{contact.email}</a>
          <p className="colophon-note">{contact.note}</p>
        </Reveal>
        <Reveal className="colophon-row" delay={120}>
          <div><span>电话</span>{contact.phone}</div>
          <div><span>地址</span>{contact.location}</div>
          <div><span>QQ</span>{contact.wechat}</div>
        </Reveal>
        <div className="colophon-foot">{contact.footer} · {site.name}</div>
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
        <Link className="mast-name" to="/">{site.name}</Link>
        <nav className="mast-nav">
          <Anchor to="/" id="about" className="mast-anchor">档案</Anchor>
          <Anchor to="/" id="projects" className="mast-anchor">项目</Anchor>
          <Anchor to="/" id="members" className="mast-anchor">成员</Anchor>
          <Anchor to="/" id="faq" className="mast-anchor">Q&amp;A</Anchor>
          {ready && !user && <Link className="mast-cta" to="/login">登录 / 入会</Link>}
          {ready && user && (
            <>
              <Link to="/member">成员面板</Link>
              {user.role === 'admin' && <Link to="/admin">管理后台</Link>}
              <Link to="/" onClick={logout}>退出（{user.nickname || user.username}）</Link>
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
      <Intro />
      <HashRouter>
        <Shell user={user} setUser={setUser} ready={ready} />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthView mode="login" />} />
          <Route path="/register" element={<AuthView mode="register" />} />
          <Route path="/member" element={ready && !user ? <Navigate to="/login" replace /> : <MemberView />} />
          <Route path="/admin" element={ready && (!user || user.role !== 'admin') ? <Navigate to="/login" replace /> : <AdminView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </>
  )
}
