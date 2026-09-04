import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

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

  /* 增量轮询：新消息自动出现 */
  useEffect(() => {
    if (!conv) return
    const t = setInterval(async () => {
      try {
        const lastId = msgs.length ? msgs[msgs.length - 1].id : 0
        const m = await api('/conversation/' + conv.id + '/messages?after=' + lastId)
        if (m.list && m.list.length) {
          setMsgs((old) => old.concat(m.list))
          await api('/conversation/' + conv.id + '/read', { method: 'POST' })
          scrollDown()
        }
      } catch {}
    }, 8000)
    return () => clearInterval(t)
  }, [conv, msgs])

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
    try { await api('/change-password', { method: 'POST', body: { old_password: op, new_password: np } }); setOp(''); setNp(''); setPwMsg('✓ 密码已更新') }
    catch (err) { setPwMsg(err.message) }
  }

  return (
    <div className="panel-page">
      <div className="panel-head">
        <p className="auth-kicker">MEMBER DESK</p>
        <h1 className="panel-title">成员面板</h1>
        <Link className="panel-back" to="/">← 返回首页</Link>
      </div>

      <section className="panel-sec">
        <h2 className="panel-sec-title">协会公告</h2>
        {anns.length === 0 && <p className="panel-empty">暂无公告</p>}
        {anns.map((a) => (
          <article key={a.id} className={"ann " + (a.pinned ? 'ann--pinned' : '')}>
            <div className="ann-meta"><span>{a.pinned ? '📌 置顶' : a.author}</span><span>{String(a.created_at).slice(0, 10)}</span></div>
            <h3 className="ann-title">{a.title}</h3>
            <p className="ann-content">{a.content}</p>
          </article>
        ))}
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">联系 STAFF</h2>
        <div className="chat">
          <div className="chat-box" ref={boxRef}>
            {!conv && msgs.length === 0 && <p className="panel-empty">还没有联系过 STAFF——有问题、有想法，直接发消息（STAFF 会在此回复你）</p>}
            {msgs.map((m) => (
              <div key={m.id} className={"chat-msg " + (m.direction === 'to_staff' ? 'chat-msg--me' : 'chat-msg--staff')}>
                <div className="chat-bubble">{m.content}</div>
                <span className="chat-meta">{m.direction === 'to_staff' ? '我' : 'STAFF'} · {String(m.created_at).slice(5, 16)}</span>
              </div>
            ))}
          </div>
          <form onSubmit={send} className="chat-form">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="2" maxLength="1000" placeholder="输入消息…（≤1000 字）" required />
            {msg && <p className="auth-msg">{msg}</p>}
            <button className="auth-btn">发送</button>
          </form>
        </div>
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">修改密码</h2>
        <form onSubmit={changePw} className="msg-form">
          <label>原密码 <input type="password" value={op} onChange={(e) => setOp(e.target.value)} required /></label>
          <label>新密码 <input type="password" value={np} onChange={(e) => setNp(e.target.value)} minLength="6" placeholder="至少 6 位" required /></label>
          {pwMsg && <p className={"auth-msg " + (pwMsg.indexOf('✓') === 0 ? 'auth-msg--ok' : '')}>{pwMsg}</p>}
          <button className="auth-btn">保存新密码</button>
        </form>
      </section>
    </div>
  )
}
