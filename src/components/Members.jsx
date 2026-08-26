import { members } from '../data/content'

import ImageSlot from './ImageSlot'

import Reveal from './Reveal'



export default function Members() {

  return (

    <section id="members" className="section members">

      <div className="wrap">

        <Reveal className="sec-head">

          <span className="sec-index">03</span>

          <h2 className="sec-title">核心成员</h2>

          <span className="sec-desc">TEAM</span>

        </Reveal>



        <div className="members-grid">

          {members.map((m, i) => (

            <Reveal key={i} delay={i * 80} className="member-card">

              <ImageSlot src={m.avatar} ratio="1/1" label="请填写成员照片" className="member-avatar" />

              <h3 className="member-name">{m.name}</h3>

              <p className="member-role">{m.role}</p>

              <p className="member-desc">{m.desc}</p>

            </Reveal>

          ))}

        </div>

      </div>

    </section>

  )

}
