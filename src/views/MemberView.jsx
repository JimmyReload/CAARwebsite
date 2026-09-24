import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'

export default function MemberView() {
  const [anns, setAnns] = useState([])
  const [conv, setConv] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [content, setContent] = useState('')
  const [msg, setMsg] = useState('')
  const [op, setOp] = useState('')
  const [np, setNp] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const boxRef = useRef(null)

  const scrollDown = () => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight }

  const loadConv = async () => {
    try {
      const d = await api('/conversation')
      setConv(d.conv)
      if (d.conv) {
        const m = await api('/conversation/' + d.conv.id + '/messages')
        setMsgs(m.list || [])
        await api('/conversation/' + d.conv.id + '/read', { method: 'POST' })
        scrollDown()
      }
    } catch {}
  }

  useEffect(() => {
    const load = async () => {
      try {
        const [a] = await Promise.all([api('/announcements')])
        setAnns(a.list || [])
      } catch {}
      loadConv()
    }
    load()
  }, [])

  /* 增量轮询：新消息自动出现
     用 ref 持有最新消息 id，避免把 msgs 放进依赖导致每次新消息都重建定时器 */
  const lastIdRef = useRef(0)
  useEffect(() => { lastIdRef.current = msgs.length ? msgs[msgs.length - 1].id : 0 }, [msgs])

  useEffect(() => {
    if (!conv) return
    const timer = setInterval(async () => {
      try {
        const m = await api('/conversation/' + conv.id + '/messages?after=' + lastIdRef.current)
        if (m.list && m.list.length) {
          setMsgs((old) => {
            const seen = new Set(old.map((x) => x.id))
            return old.concat(m.list.filter((x) => !seen.has(x.id)))
          })
          await api('/conversation/' + conv.id + '/read', { method: 'POST' })
          scrollDown()
        }
      } catch {}
    }, 8000)
    return () => clearInterval(timer)
  }, [conv])

  const send = async (e) => {
    e.preventDefault()
    setMsg('')
    try {
      const r = await api('/conversation/message', { method: 'POST', body: { content } })
      setContent('')
      if (!conv) return loadConv()
      const m = await api('/conversation/' + (conv ? conv.id : r.conv_id) + '/messages?after=' + (msgs.length ? msgs[msgs.length - 1].id : 0))
      if (m.list && m.list.length) { setMsgs((old) => old.concat(m.list)); scrollDown() }
    } catch (err) { setMsg(err.message) }
  }

  const changePw = async (e) => {
    e.preventDefault(); setPwMsg('')
    try { await api('/change-password', { method: 'POST', body: { old_password: op, new_password: np } }); setOp(''); setNp(''); setPwMsg(t('password.ok')) }
    catch (err) { setPwMsg(err.message) }
  }

  return (
    <div className="panel-page">
      <div className="panel-head">
        <p className="auth-kicker">{t('member.kicker')}</p>
        <h1 className="panel-title">{t('member.title')}</h1>
        <Link className="panel-back" to="/">{t('common.backHome')}</Link>
      </div>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('member.announcements')}</h2>
        {anns.length === 0 && <p className="panel-empty">{t('member.noAnnouncements')}</p>}
        {anns.map((a) => (
          <article key={a.id} className={"ann " + (a.pinned ? 'ann--pinned' : '')}>
            <div className="ann-meta"><span>{a.pinned ? t('member.pinned') : a.author}</span><span>{String(a.created_at).slice(0, 10)}</span></div>
            <h3 className="ann-title">{a.title}</h3>
            <p className="ann-content">{a.content}</p>
          </article>
        ))}
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('member.inbox')}</h2>
        <div className="chat">
          <div className="chat-box" ref={boxRef}>
            {!conv && msgs.length === 0 && <p className="panel-empty">{t('member.inboxEmpty')}</p>}
            {msgs.map((m) => (
              <div key={m.id} className={"chat-msg " + (m.direction === 'to_staff' ? 'chat-msg--me' : 'chat-msg--staff')}>
                <div className="chat-bubble">{m.content}</div>
                <span className="chat-meta">{m.direction === 'to_staff' ? t('member.me') : t('member.staff')} · {String(m.created_at).slice(5, 16)}</span>
              </div>
            ))}
          </div>
          <form onSubmit={send} className="chat-form">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="2" maxLength="1000" placeholder={t('member.messagePlaceholder')} required />
            {msg && <p className="auth-msg">{msg}</p>}
            <button className="auth-btn">{t('member.send')}</button>
          </form>
        </div>
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('member.changePassword')}</h2>
        <form onSubmit={changePw} className="msg-form">
          <label>{t('password.old')} <input type="password" value={op} onChange={(e) => setOp(e.target.value)} required /></label>
          <label>{t('password.next')} <input type="password" value={np} onChange={(e) => setNp(e.target.value)} minLength="6" placeholder={t('password.placeholder')} required /></label>
          {pwMsg && <p className={"auth-msg " + (pwMsg.indexOf('✓') === 0 ? 'auth-msg--ok' : '')}>{pwMsg}</p>}
          <button className="auth-btn">{t('password.save')}</button>
        </form>
      </section>
    </div>
  )
}
