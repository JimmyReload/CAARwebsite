import { useEffect, useState } from 'react'

import { site } from '../data/content'



export default function Nav() {

  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {

    const onScroll = () => setScrolled(window.scrollY > 40)

    onScroll()

    window.addEventListener('scroll', onScroll, { passive: true })

    return () => window.removeEventListener('scroll', onScroll)

  }, [])



  return (

    <header className={`nav ${scrolled ? 'scrolled' : ''}`}>

      <div className="wrap nav-inner">

        <a className="nav-logo" href="#top">{site.logoText}</a>

        <nav className="nav-links">

          {site.nav.map((n) => (

            <a key={n.href} href={n.href}>{n.label}</a>

          ))}

          <a className="nav-cta" href="#contact">{site.navCta}</a>

        </nav>

      </div>

    </header>

  )

}
