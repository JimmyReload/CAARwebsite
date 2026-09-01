import { useEffect, useState } from 'react'
import { site } from '../data/content'

export default function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const close = () => setOpen(false)

  return (
    <header className={"nav " + (scrolled ? 'scrolled' : '')}>
      <div className="wrap nav-inner">
        <a className="nav-logo" href="#top" onClick={close}>{site.logoText}</a>

        <nav className="nav-links">
          {site.nav.map((n) => (
            <a key={n.href} href={n.href}>{n.label}</a>
          ))}
          <a className="nav-cta" href="#contact">{site.navCta}</a>
        </nav>

        <button
          className={"nav-burger " + (open ? 'open' : '')}
          aria-label="菜单"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <span /><span /><span />
        </button>
      </div>

      <div className={"nav-mobile " + (open ? 'open' : '')}>
        {site.nav.map((n) => (
          <a key={n.href} href={n.href} onClick={close}>{n.label}</a>
        ))}
        <a className="nav-mobile-cta" href="#contact" onClick={close}>{site.navCta}</a>
      </div>
    </header>
  )
}
