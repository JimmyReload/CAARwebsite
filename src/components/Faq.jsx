import { useState } from 'react'

import { faqs } from '../data/content'

import Reveal from './Reveal'



export default function Faq() {

  const [open, setOpen] = useState(0)



  return (

    <section id="faq" className="section faq">

      <div className="wrap">

        <Reveal className="sec-head">

          <span className="sec-index">04</span>

          <h2 className="sec-title">常见问题</h2>

          <span className="sec-desc">Q&amp;A</span>

        </Reveal>



        <div className="faq-list">

          {faqs.map((f, i) => (

            <Reveal key={i} delay={i * 60}>

              <div className={`faq-item ${open === i ? 'open' : ''}`}>

                <button className="faq-q" onClick={() => setOpen(open === i ? -1 : i)}>

                  <span>{f.q}</span>

                  <span className="faq-mark">{open === i ? '−' : '+'}</span>

                </button>

                <div className="faq-a">

                  <div><p>{f.a}</p></div>

                </div>

              </div>

            </Reveal>

          ))}

        </div>

      </div>

    </section>

  )

}

