import { about } from '../data/content'
import ImageSlot from './ImageSlot'
import Reveal from './Reveal'

export default function About() {
  return (
    <section id="about" className="section about">
      <div className="wrap">
        <Reveal className="sec-head">
          <span className="sec-index">01</span>
          <h2 className="sec-title">协会经历</h2>
          <span className="sec-desc">ABOUT</span>
        </Reveal>

        <div className="about-grid">
          <Reveal className="about-media">
            <ImageSlot src={about.image} ratio="3/4" label="请填写头像 / 人物图" className="about-img" />
          </Reveal>

          <div className="about-body">
            <Reveal>
              <h3 className="about-name">{about.name}</h3>
              <p className="about-role">{about.role}</p>
            </Reveal>

            <Reveal className="about-intro">
              {about.intro.map((p, i) => <p key={i}>{p}</p>)}
            </Reveal>

            <Reveal className="about-contact">
              <div><span>邮箱</span>{about.contact.email}</div>
              <div><span>电话</span>{about.contact.phone}</div>
              <div><span>所在</span>{about.contact.location}</div>
              <div><span>QQ</span>{about.contact.wechat}</div>
            </Reveal>

            <Reveal className="about-stats">
              {about.stats.map((s, i) => (
                <div key={i} className="stat">
                  <span className="stat-value">{s.value}</span>
                  <span className="stat-label">{s.label}</span>
                </div>
              ))}
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}