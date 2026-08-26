import Intro from './components/Intro'

import Nav from './components/Nav'

import Hero from './components/Hero'

import About from './components/About'

import Projects from './components/Projects'

import Members from './components/Members'

import Faq from './components/Faq'

import Contact from './components/Contact'



export default function App() {

  return (

    <>
      <Intro />

      <Nav />

      <main>

        <Hero />

        <About />

        <Projects />

        <Members />

        <Faq />

      </main>

      <Contact />

    </>

  )

}
