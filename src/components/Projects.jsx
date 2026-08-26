import { projects } from '../data/content'

import ImageSlot from './ImageSlot'

import Reveal from './Reveal'



export default function Projects() {

  return (

    <section id="projects" className="section projects">

      <div className="wrap">

        <Reveal className="sec-head">

          <span className="sec-index">02</span>

          <h2 className="sec-title">精选项目</h2>

          <span className="sec-desc">我们参加过的比赛</span>

        </Reveal>



        <div className="projects-grid">

          {projects.map((p, i) => (

            <Reveal

              key={i}

              className={`project-card ${i === 0 ? 'project-card--wide' : ''}`}

              delay={(i % 2) * 80}

            >

              <ImageSlot

                src={p.image}

                ratio={i === 0 ? '21/9' : '16/10'}

                label="请填写作品图"

                className="project-img"

              />

              <div className="project-info">

                <div className="project-meta">

                  <span>{p.year}</span>

                  <span>{p.tag}</span>

                </div>

                <h3 className="project-title">{p.title}</h3>

                <p className="project-desc">{p.desc}</p>

              </div>

            </Reveal>

          ))}

        </div>

      </div>

    </section>

  )

}


