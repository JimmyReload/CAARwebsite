import { useEffect, useRef, useState } from 'react'
import HanziWriter from 'hanzi-writer'

/* 写完最后一笔的轻“笔落”声，被浏览器拦就自动静默 */
let audioCtx = null
function playInk() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const t = audioCtx.currentTime + 0.02
    const mk = (freq, dur, type, gain, when = 0) => {
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.type = type
      o.frequency.setValueAtTime(freq, t + when)
      g.gain.setValueAtTime(0.0001, t + when)
      g.gain.exponentialRampToValueAtTime(gain, t + when + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t + when + dur)
      o.connect(g); g.connect(audioCtx.destination)
      o.start(t + when); o.stop(t + when + dur + 0.05)
    }
    mk(180, 0.14, 'triangle', 0.18)
    mk(96, 0.22, 'sine', 0.14, 0.03)
  } catch { /* 静默 */ }
}

const CHARS = ['中', '不', '正', '协']
const TRI_END = 2300   // 三角动画结束后开始写字
const GONE_AFTER = 900 // 写完到整幕消失

function getToday() {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

export default function Intro() {
  const [startHidden] = useState(() => {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true
      return localStorage.getItem('abnormal-intro-date') === getToday()
    } catch { return true }
  })
  const [phase, setPhase] = useState(startHidden ? 'gone' : 'tri') // tri | writing | out | gone
  const wordsRef = useRef(null)
  const writersRef = useRef([])

  /* 阶段1：三角 → 开始写字 */
  useEffect(() => {
    if (startHidden) return
    document.documentElement.classList.add('intro-lock')
    const t1 = setTimeout(() => setPhase('writing'), TRI_END)
    return () => {
      clearTimeout(t1)
      document.documentElement.classList.remove('intro-lock')
    }
  }, [startHidden])

  /* 阶段2：用 hanzi-writer 按真笔顺写字 */
  useEffect(() => {
    if (phase !== 'writing') return
    const host = wordsRef.current
    if (!host) return

    // 先清掉可能残留的旧 writer（覆盖开发模式的双执行）
    writersRef.current.forEach((w) => { try { w.destroy() } catch {} })
    writersRef.current = []

    const size = Math.min(180, Math.floor(window.innerHeight * 0.22))
    writersRef.current = CHARS.map((ch) => {
      const el = document.createElement('div')
      el.className = 'intro-char'
      el.style.width = `${size}px`
      el.style.height = `${size}px`
      host.appendChild(el)
      return HanziWriter.create(el, ch, {
        width: size,
        height: size,
        padding: 8,
        showOutline: true,    // 先显示极淡轮廓，再一笔笔写
        showCharacter: false,
        strokeColor: '#f4eddf',
        highlightColor: '#c96a4c',
        // 字形数据本地化（不依赖国外 CDN，国内秒载）
        charDataLoader: (char, onComplete) => {
          fetch('/hanzi-data/' + char + '.json')
            .then((r) => { if (!r.ok) throw new Error('no local data') ; return r.json() })
            .then(onComplete)
            .catch(() => {
              // 本地缺失时回退官方 CDN
              HanziWriter.loadCharacterData(char).then(onComplete)
            })
        },
      })
    })

    const finish = () => {
      playInk()
      setPhase('out')
    }

    const animateNext = (i) => {
      if (i >= writersRef.current.length) { finish(); return }
      writersRef.current[i].animateCharacter({
        duration: 280, // 每笔 280ms
        delay: 30,     // 笔间停顿
        onComplete: () => animateNext(i + 1),
      })
    }
    animateNext(0)

    // 保险丝：无论动画是否完成，12 秒后强制进入淡出（防止卡在开场）
    const safety = setTimeout(() => setPhase('out'), 12000)
    return () => { clearTimeout(safety) }
    // 这里故意不销毁 writer，让写好的字保留到整幕淡出完
  }, [phase])

  /* 阶段 out：淡出结束后移除滚动锁并收尾 */
  useEffect(() => {
    if (phase !== 'out') return
    const t = setTimeout(() => {
      try { localStorage.setItem('abnormal-intro-date', getToday()) } catch {}
      document.documentElement.classList.remove('intro-lock')
      setPhase('gone')
    }, GONE_AFTER)
    return () => clearTimeout(t)
  }, [phase])

  /* 阶段3：整幕消失后再销毁 writer */
  useEffect(() => {
    if (phase !== 'gone') return
    writersRef.current.forEach((w) => { try { w.destroy() } catch {} })
    writersRef.current = []
    if (wordsRef.current) wordsRef.current.innerHTML = ''
  }, [phase])

  /* 组件卸载兜底清理 */
  useEffect(() => () => {
    writersRef.current.forEach((w) => { try { w.destroy() } catch {} })
    writersRef.current = []
    document.documentElement.classList.remove('intro-lock')
  }, [])

  const skip = () => {
    try { localStorage.setItem('abnormal-intro-date', getToday()) } catch {}
    document.documentElement.classList.remove('intro-lock')
    setPhase('gone')
  }

  if (phase === 'gone') return null
  const showTri = phase === 'tri'
  const showWords = phase === 'writing' || phase === 'out'

  return (
    <div className={`intro ${phase}`}>
      {showTri && (
        <div className="intro-tri-wrap">
          <svg className="intro-tri" viewBox="0 0 320 300">
            <g className="tri-rot">
              <path className="tri-line" pathLength="1" d="M160 42 L30 267 L290 267 Z" />
              <path className="tri-comet" pathLength="1" d="M160 42 L30 267 L290 267 Z" />
              <circle className="tri-dot" cx="160" cy="42" r="8" />
              <circle className="tri-dot" cx="30" cy="267" r="8" />
              <circle className="tri-dot" cx="290" cy="267" r="8" />
            </g>
          </svg>
          <p className="intro-tag">CHINA ABNORMAL REASONING ASSOCIATION</p>
        </div>
      )}

      {showWords && <div className="intro-words" ref={wordsRef} />}

      <button className="intro-skip" onClick={skip}>跳过 SKIP</button>
    </div>
  )
}