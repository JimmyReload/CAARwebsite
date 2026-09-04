import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

export default function AdminView() {
  const [tab, setTab] = useState('ann')
  const [users, setUsers] = useState([])
  const [anns, setAnns] = useState([])
  const [inbox, setInbox] = useState([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [msg, setMsg] = useState('')

  const loadAll = async () => {
    try {
      const [a, u, m] = await Promise.all([api('/announcements'), api('/admin/users'), api('/messages')])
      setAnns(a.list || []); setUsers(u.list || []); setInbox(m.inbox || [])
    } catch (err) { if (String(err.message).includes('401') || String(err.message).includes('未登录')) setMsg('需要管理员权限') }
  }
  useEffect(() => { loadAll() }, [])

  const postAnn = async (e) => {
    e.preventDefault(); setMsg('')
    try { await api('/announcements', { method: 'POST', body: { title, content, pinned } }); setTitle(''); setContent(''); setPinned(false); loadAll() }
    catch (err) { setMsg(err.message) }
  }
  const delAnn = async (id) => { try { await api('/admin/announcements/' + id, { method: 'DELETE' }); loadAll() } catch (err) { setMsg(err.message) } }
  const setRole = async (u, role) => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { role } }); loadAll() } catch (err) { setMsg(err.message) } }
  const markRead = async (id) => { try { await api('/messages/read', { method: 'POST', body: { id } }); loadAll() } catch {} }

  return (
    <div className="panel-page panel-page--admin">
      <div className="panel-head">
        <p className="auth-kicker">ADMIN CONSOLE</p>
        <h1 className="panel-title">管理后台</h1>
        <Link className="panel-back" to="/">← 返回首页</Link>
      </div>

      <div className="admin-tabs">
        <button className={tab === 'ann' ? 'on' : ''} onClick={() => setTab('ann')}>公告</button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>用户权限</button>
        <button className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>收件箱{inbox.filter(m => !m.read).length > 0 ? ' (' + inbox.filter(m => !m.read).length + ')' : ''}</button>
      </div>

      {msg && <p className="auth-msg">{msg}</p>}

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
                <div>
                  <strong>{a.pinned ? '📌 ' : ''}{a.title}</strong>
                  <span className="msg-date"> {String(a.created_at).slice(0, 10)} · {a.author}</span>
                </div>
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

      {tab === 'inbox' && (
        <div className="admin-list">
          {inbox.length === 0 && <p className="panel-empty">收件箱为空</p>}
          {inbox.map((m) => (
            <div key={m.id} className={"admin-row admin-row--msg " + (m.read ? '' : 'unread')} onClick={() => !m.read && markRead(m.id)}>
              <div>
                <strong>{m.from_name}</strong>
                <span className="msg-date"> {String(m.created_at).slice(0, 16)}</span>
                {!m.read && <span className="role-tag role-tag--new">新</span>}
                <p className="msg-content">{m.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
