
import { hero } from '../data/content'

import Reveal from './Reveal'



export default function Hero() {

  return (

    <section id="top" className="hero">

      <div className="hero-media">

        <div className="hero-bg" />

        {hero.videoSrc && (

          <video src={hero.videoSrc} poster={hero.videoPoster || undefined} autoPlay muted loop playsInline />

        )}

      </div>

      <div className="hero-overlay" />

      <div className="wrap hero-inner">

        <Reveal>

          <p className="hero-file">FILE No.CAAR-2023 // STATUS: ACTIVE</p>

        </Reveal>

        <Reveal>

          <p className="hero-kicker">{hero.kicker}</p>

        </Reveal>

        <Reveal delay={120}>

          <h1 className="hero-title">

            {hero.title1}

            {hero.title2 && (

              <>

                <br />

                <span className="hero-title-l2">{hero.title2}</span>

              </>

            )}

          </h1>

        </Reveal>

        <Reveal delay={240}>

          <p className="hero-sub">{hero.subtitle}</p>

        </Reveal>

        <Reveal delay={360}>

          <a className="hero-cta" href="#contact">{hero.cta}</a>

        </Reveal>

      </div>

      <div className="hero-scroll">SCROLL</div>

    </section>

  )

}

