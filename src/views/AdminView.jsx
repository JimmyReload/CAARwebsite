import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

export default function AdminView() {
  const [tab, setTab] = useState('conv')
  const [users, setUsers] = useState([])
  const [anns, setAnns] = useState([])
  const [convs, setConvs] = useState([])
  const [active, setActive] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [reply, setReply] = useState('')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [msg, setMsg] = useState('')

  const loadAll = async () => {
    try {
      const [a, u, c] = await Promise.all([api('/announcements'), api('/admin/users'), api('/conversation')])
      setAnns(a.list || []); setUsers(u.list || []); setConvs(c.list || [])
      if (active) {
        const m = await api('/conversation/' + active.id + '/messages')
        setMsgs(m.list || [])
        await api('/conversation/' + active.id + '/read', { method: 'POST' })
      }
    } catch (err) { if (String(err.message).includes('登录') || String(err.message).includes('401')) setMsg('需要管理员权限') }
  }
  useEffect(() => { loadAll() }, [])

  const openConv = async (cv) => {
    setActive(cv)
    const m = await api('/conversation/' + cv.id + '/messages')
    setMsgs(m.list || [])
    await api('/conversation/' + cv.id + '/read', { method: 'POST' })
  }

  const doReply = async (e) => {
    e.preventDefault(); setMsg('')
    try { await api('/conversation/reply', { method: 'POST', body: { conv_id: active.id, content: reply } }); setReply(''); loadAll() }
    catch (err) { setMsg(err.message) }
  }

  const postAnn = async (e) => {
    e.preventDefault(); setMsg('')
    try { await api('/announcements', { method: 'POST', body: { title, content, pinned } }); setTitle(''); setContent(''); setPinned(false); loadAll() }
    catch (err) { setMsg(err.message) }
  }
  const delAnn = async (id) => { try { await api('/admin/announcements/' + id, { method: 'DELETE' }); loadAll() } catch (err) { setMsg(err.message) } }
  const setRole = async (u, role) => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { role } }); loadAll() } catch (err) { setMsg(err.message) } }

  const totalUnread = convs.reduce((s, c) => s + (c.unread || 0), 0)

  return (
    <div className="panel-page panel-page--admin">
      <div className="panel-head">
        <p className="auth-kicker">ADMIN CONSOLE</p>
        <h1 className="panel-title">管理后台</h1>
        <Link className="panel-back" to="/">← 返回首页</Link>
      </div>

      <div className="admin-tabs">
        <button className={tab === 'conv' ? 'on' : ''} onClick={() => setTab('conv')}>来信{totalUnread > 0 ? ' (' + totalUnread + ')' : ''}</button>
        <button className={tab === 'ann' ? 'on' : ''} onClick={() => setTab('ann')}>公告</button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>用户权限</button>
      </div>

      {msg && <p className="auth-msg">{msg}</p>}

      {tab === 'conv' && !active && (
        <div className="admin-list">
          {convs.length === 0 && <p className="panel-empty">还没有会员来信</p>}
          {convs.map((c) => (
            <button key={c.id} className={"conv-row " + (c.unread > 0 ? 'conv-row--unread' : '')} onClick={() => openConv(c)}>
              <span className="conv-name">{c.nickname || c.username}（@{c.username}）</span>
              <span className="conv-unread">{c.unread > 0 ? c.unread + ' 条未读' : '已读'}</span>
              <span className="msg-date">{String(c.updated_at).slice(5, 16)}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'conv' && active && (
        <div className="conv-detail">
          <button className="mini-btn" onClick={() => setActive(null)}>← 返回工单列表</button>
          <h3 className="conv-title">与 {active.nickname || active.username}（@{active.username}）的对话</h3>
          <div className="chat chat--inadmin">
            <div className="chat-box">
              {msgs.map((m) => (
                <div key={m.id} className={"chat-msg " + (m.direction === 'to_user' ? 'chat-msg--me' : 'chat-msg--staff')}>
                  <div className="chat-bubble">{m.content}</div>
                  <span className="chat-meta">{m.direction === 'to_user' ? 'STAFF 我' : m.sender_name + '（会员）'} · {String(m.created_at).slice(5, 16)}</span>
                </div>
              ))}
            </div>
            <form onSubmit={doReply} className="chat-form">
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows="2" maxLength="1000" placeholder="回复该会员…" required />
              <button className="auth-btn">回复</button>
            </form>
          </div>
        </div>
      )}

      {tab === 'ann' && (
        <>
          <form onSubmit={postAnn} className="msg-form ann-form">
            <label>标题 <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength="60" required /></label>
            <label>内容 <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="4" required /></label>
            <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 置顶</label>
            <button className="auth-btn">发布公告</button>
          </form>
          <div className="admin-list">
            {anns.map((a) => (
              <div key={a.id} className="admin-row">
                <div><strong>{a.pinned ? '📌 ' : ''}{a.title}</strong><span className="msg-date"> {String(a.created_at).slice(0, 10)} · {a.author}</span></div>
                <button className="mini-btn mini-btn--danger" onClick={() => delAnn(a.id)}>删除</button>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'users' && (
        <div className="admin-list">
          {users.map((u) => (
            <div key={u.id} className="admin-row">
              <div>
                <strong>{u.nickname || u.username}</strong>
                <span className="msg-date"> @{u.username} · {String(u.created_at).slice(0, 10)}</span>
                <span className={"role-tag " + (u.role === 'admin' ? 'role-tag--admin' : '')}>{u.role === 'admin' ? 'STAFF' : '会员'}</span>
              </div>
              <button className="mini-btn" onClick={() => setRole(u, u.role === 'admin' ? 'user' : 'admin')}>
                {u.role === 'admin' ? '降为会员' : '设为 STAFF'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
