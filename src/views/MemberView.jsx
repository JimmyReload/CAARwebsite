import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

export default function MemberView() {
  const [anns, setAnns] = useState([])
  const [staff, setStaff] = useState([])
  const [sent, setSent] = useState([])
  const [to, setTo] = useState('')
  const [content, setContent] = useState('')
  const [msg, setMsg] = useState('')
  const [op, setOp] = useState('')
  const [np, setNp] = useState('')
  const [pwMsg, setPwMsg] = useState('')

  const load = async () => {
    try {
      const [a, s, m] = await Promise.all([api('/announcements'), api('/staff'), api('/messages')])
      setAnns(a.list || []); setStaff(s.list || []); setSent(m.sent || [])
      if (!to && s.list && s.list.length) setTo(String(s.list[0].id))
    } catch { /* 401 由 Layout 处理跳转 */ }
  }
  useEffect(() => { load() }, [])

  const changePw = async (e) => {
    e.preventDefault(); setPwMsg('')
    try { await api('/change-password', { method: 'POST', body: { old_password: op, new_password: np } }); setOp(''); setNp(''); setPwMsg('✓ 密码已更新') }
    catch (err) { setPwMsg(err.message) }
  }

  const send = async (e) => {
    e.preventDefault()
    setMsg('')
    try { await api('/messages', { method: 'POST', body: { to_user: Number(to), content } }); setContent(''); setMsg('已发送，等待回复'); load() }
    catch (err) { setMsg(err.message) }
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
            <div className="ann-meta">
              <span>{a.pinned ? '📌 置顶' : a.author}</span>
              <span>{String(a.created_at).slice(0, 10)}</span>
            </div>
            <h3 className="ann-title">{a.title}</h3>
            <p className="ann-content">{a.content}</p>
          </article>
        ))}
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">给 Staff 留言</h2>
        {staff.length === 0 ? (
          <p className="panel-empty">暂无 staff</p>
        ) : (
          <form onSubmit={send} className="msg-form">
            <label>收件人
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.nickname || s.username}（{s.username}）</option>)}
              </select>
            </label>
            <label>内容
              <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="4" maxLength="2000" placeholder="向 staff 反馈、提问或闲聊（≤2000 字）" required />
            </label>
            {msg && <p className="auth-msg">{msg}</p>}
            <button className="auth-btn">发送</button>
          </form>
        )}
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">我发出的信</h2>
        {sent.length === 0 && <p className="panel-empty">还没有发过信</p>}
        {sent.map((m) => (
          <div key={m.id} className="msg-row">
            <span className="msg-to">致 {m.to_name}</span>
            <span className="msg-content">{m.content}</span>
            <span className="msg-date">{String(m.created_at).slice(5, 16)}</span>
            {m.read ? <span className="msg-state msg-state--ok">已读</span> : <span className="msg-state">未读</span>}
          </div>
        ))}
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">修改密码</h2>
        <form onSubmit={changePw} className="msg-form">
          <label>原密码 <input type="password" value={op} onChange={(e) => setOp(e.target.value)} required /></label>
          <label>新密码 <input type="password" value={np} onChange={(e) => setNp(e.target.value)} minLength="6" placeholder="至少 6 位" required /></label>
          {pwMsg && <p className={"auth-msg " + (pwMsg.startsWith('✓') ? 'auth-msg--ok' : '')}>{pwMsg}</p>}
          <button className="auth-btn">保存新密码</button>
        </form>
      </section>
    </div>
  )
}