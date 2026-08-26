import { contact, site } from '../data/content'

import Reveal from './Reveal'



export default function Contact() {

  return (

    <section id="contact" className="contact">

      <div className="wrap contact-inner">

        <Reveal className="sec-head sec-head--light">

          <span className="sec-index">05</span>

          <h2 className="sec-title">联系我们</h2>

          <span className="sec-desc">CONTACT</span>

        </Reveal>



        <Reveal>

          <a className="contact-big" href={`mailto:${contact.email}`}>{contact.email}</a>

          <p className="contact-sub">{contact.note}</p>

        </Reveal>



        <Reveal className="contact-row" delay={120}>

          <div><span>电话</span>{contact.phone}</div>

          <div><span>地址</span>{contact.location}</div>

          <div><span>QQ</span>{contact.wechat}</div>

        </Reveal>

      </div>



      <footer className="contact-footer">

        <div className="wrap">{contact.footer} · {site.name}</div>

      </footer>

    </section>

  )

}
