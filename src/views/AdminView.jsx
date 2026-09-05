import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

export default function AdminView() {
  const [tab, setTab] = useState('dash')
  const [users, setUsers] = useState([])
  const [anns, setAnns] = useState([])
  const [convs, setConvs] = useState([])
  const [stats, setStats] = useState(null)
  const [active, setActive] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [reply, setReply] = useState('')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [editId, setEditId] = useState(null)
  const [q, setQ] = useState('')
  const [op, setOp] = useState('')
  const [np, setNp] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [msg, setMsg] = useState('')

  const loadAll = async () => {
    try {
      const [a, u, c, s] = await Promise.all([api('/announcements'), api('/admin/users'), api('/conversation'), api('/admin/stats')])
      setAnns(a.list || []); setUsers(u.list || []); setConvs(c.list || []); setStats(s)
      if (active) {
        const m = await api('/conversation/' + active.id + '/messages')
        setMsgs(m.list || [])
        await api('/conversation/' + active.id + '/read', { method: 'POST' })
      }
    } catch (err) { setMsg(String(err.message)) }
  }
  useEffect(() => { loadAll() }, [])

  const searchUsers = async (e) => { e && e.preventDefault(); try { const u = await api('/admin/users' + (q ? '?q=' + encodeURIComponent(q) : '')); setUsers(u.list || []) } catch {} }

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
    try {
      if (editId) { await api('/admin/announcements/' + editId, { method: 'PATCH', body: { title, content, pinned } }) }
      else { await api('/announcements', { method: 'POST', body: { title, content, pinned } }) }
      setTitle(''); setContent(''); setPinned(false); setEditId(null); loadAll()
    } catch (err) { setMsg(err.message) }
  }
  const startEdit = (a) => { setEditId(a.id); setTitle(a.title); setContent(a.content); setPinned(!!a.pinned); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const cancelEdit = () => { setEditId(null); setTitle(''); setContent(''); setPinned(false) }
  const delAnn = async (id) => { try { await api('/admin/announcements/' + id, { method: 'DELETE' }); loadAll() } catch (err) { setMsg(err.message) } }
  const setRole = async (u, role) => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { role } }); loadAll() } catch (err) { setMsg(err.message) } }
  const setBanned = async (u, banned) => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { banned } }); loadAll() } catch (err) { setMsg(err.message) } }

  const changeMyPw = async (e) => {
    e.preventDefault(); setPwMsg('')
    try { await api('/change-password', { method: 'POST', body: { old_password: op, new_password: np } }); setOp(''); setNp(''); setPwMsg('✓ 密码已更新') }
    catch (err) { setPwMsg(err.message) }
  }
  const resetUserPw = async (u) => {
    const npw = window.prompt('为 ' + (u.nickname || u.username) + ' 设置新密码（至少 6 位）：')
    if (!npw) return
    try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { new_password: npw } }); setMsg('已重置 ' + u.username + ' 的密码') } catch (err) { setMsg(err.message) }
  }

  const totalUnread = convs.reduce((s, c) => s + (c.unread || 0), 0)

  return (
    <div className="panel-page panel-page--admin">
      <div className="panel-head">
        <p className="auth-kicker">ADMIN CONSOLE</p>
        <h1 className="panel-title">管理后台</h1>
        <Link className="panel-back" to="/">← 返回首页</Link>
      </div>

      <div className="admin-tabs">
        <button className={tab === 'dash' ? 'on' : ''} onClick={() => setTab('dash')}>概览</button>
        <button className={tab === 'conv' ? 'on' : ''} onClick={() => setTab('conv')}>来信{totalUnread > 0 ? ' (' + totalUnread + ')' : ''}</button>
        <button className={tab === 'ann' ? 'on' : ''} onClick={() => setTab('ann')}>公告{editId ? '（编辑中）' : ''}</button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>用户权限</button>
      </div>

      {msg && <p className="auth-msg">{msg}</p>}

      {/* ===== 概览 ===== */}
      {tab === 'dash' && stats && (
        <>
          <div className="dash-grid">
            <div className="dash-card"><span className="dash-n">{stats.total}</span><span className="dash-l">会员总数</span></div>
            <div className="dash-card"><span className="dash-n">{stats.new7}</span><span className="dash-l">近 7 日新增</span></div>
            <div className="dash-card"><span className="dash-n">{stats.admins}</span><span className="dash-l">STAFF</span></div>
            <div className="dash-card"><span className="dash-n">{stats.convs}</span><span className="dash-l">工单总数</span></div>
            <div className="dash-card"><span className="dash-n">{stats.unreadConvs}</span><span className="dash-l">未读工单</span></div>
            <div className="dash-card"><span className="dash-n">{stats.anns}</span><span className="dash-l">公告</span></div>
          </div>
          <div className="dash-pw">
            <h3 className="panel-sec-title">修改我的密码</h3>
            <form onSubmit={changeMyPw} className="msg-form">
              <label>原密码 <input type="password" value={op} onChange={(e) => setOp(e.target.value)} required /></label>
              <label>新密码 <input type="password" value={np} onChange={(e) => setNp(e.target.value)} minLength="6" placeholder="至少 6 位" required /></label>
              {pwMsg && <p className={"auth-msg " + (pwMsg.indexOf('✓') === 0 ? 'auth-msg--ok' : '')}>{pwMsg}</p>}
              <button className="auth-btn">保存新密码</button>
            </form>
          </div>
        </>
      )}

      {/* ===== 来信 ===== */}
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
                  <span className="chat-meta">{m.direction === 'to_user' ? 'STAFF' : m.sender_name + '（会员）'} · {String(m.created_at).slice(5, 16)}</span>
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

      {/* ===== 公告 ===== */}
      {tab === 'ann' && (
        <>
          <form onSubmit={postAnn} className="msg-form ann-form">
            <label>标题 <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength="60" required /></label>
            <label>内容 <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="4" required /></label>
            <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 置顶</label>
            <div className="btn-row">
              <button className="auth-btn">{editId ? '保存修改' : '发布公告'}</button>
              {editId && <button type="button" className="mini-btn" onClick={cancelEdit}>取消编辑</button>}
            </div>
          </form>
          <div className="admin-list">
            {anns.map((a) => (
              <div key={a.id} className="admin-row">
                <div>
                  <strong>{a.pinned ? '📌 ' : ''}{a.title}</strong>
                  <span className="msg-date"> {String(a.created_at).slice(0, 10)} · {a.author}</span>
                </div>
                <div className="btn-row">
                  <button className="mini-btn" onClick={() => startEdit(a)}>编辑</button>
                  <button className="mini-btn mini-btn--danger" onClick={() => delAnn(a.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ===== 用户 ===== */}
      {tab === 'users' && (
        <>
          <form onSubmit={searchUsers} className="search-bar">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索用户名 / 昵称…" />
            <button className="mini-btn" type="submit">搜索</button>
            {q && <button className="mini-btn" type="button" onClick={() => { setQ(''); searchUsers() }}>清空</button>}
          </form>
          <div className="admin-list">
            {users.map((u) => (
              <div key={u.id} className={"admin-row " + (u.banned ? 'admin-row--banned' : '')}>
                <div>
                  <strong>{u.nickname || u.username}</strong>
                  <span className="msg-date"> @{u.username} · {String(u.created_at).slice(0, 10)}</span>
                  <span className={"role-tag " + (u.role === 'admin' ? 'role-tag--admin' : '')}>{u.role === 'admin' ? 'STAFF' : '会员'}</span>
                  {u.banned ? <span className="role-tag role-tag--ban">已封禁</span> : null}
                </div>
                <div className="btn-row">
                  <button className="mini-btn" onClick={() => setRole(u, u.role === 'admin' ? 'user' : 'admin')}>
                    {u.role === 'admin' ? '降为会员' : '设为 STAFF'}
                  </button>
                  <button className="mini-btn" onClick={() => resetUserPw(u)}>重置密码</button>
                  {u.username !== 'admin' && (
                    <button className={"mini-btn " + (u.banned ? '' : 'mini-btn--danger')} onClick={() => setBanned(u, !u.banned)}>
                      {u.banned ? '解封' : '封禁'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}