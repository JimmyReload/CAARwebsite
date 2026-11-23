import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { t, eventLabel } from '../i18n'
import { fmtDate, fmtDateTime } from '../time'
import { readOverviewCache, writeOverviewCache, fetchOverview, currentEpoch } from '../panelCache'
import AdminNewsView from './AdminNewsView'

export default function AdminView({ user }) {
  const userId = user && user.id
  /* 首屏直接用预取缓存渲染，进入后台不再等一次往返 */
  const [cached] = useState(() => readOverviewCache(userId))
  const [tab, setTab] = useState('dash')
  const [users, setUsers] = useState((cached && cached.users) || [])
  const [anns, setAnns] = useState((cached && cached.anns) || [])
  const [convs, setConvs] = useState((cached && cached.convs) || [])
  const [stats, setStats] = useState((cached && cached.stats) || null)
  const [active, setActive] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [msgsLoading, setMsgsLoading] = useState(false)
  const [showMsgsLoading, setShowMsgsLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [editId, setEditId] = useState(null)
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)

  /* 审计日志：筛选条件 + 游标分页（before=上一页最小的 id，不用 offset） */
  const [logs, setLogs] = useState([])
  const [logStats, setLogStats] = useState(null)
  const [logEvents, setLogEvents] = useState([])
  const [logKeepDays, setLogKeepDays] = useState(90)
  const [logLevel, setLogLevel] = useState('')
  const [logEvent, setLogEvent] = useState('')
  const [logQ, setLogQ] = useState('')
  // 「输入中」和「已应用」分开：输入框里还没提交的字不该影响 IP/level/event 的即时筛选
  const [logQApplied, setLogQApplied] = useState('')
  const [logIp, setLogIp] = useState('')
  const [logShowClient, setLogShowClient] = useState(false)
  const [logNext, setLogNext] = useState(0)
  const [logBudget, setLogBudget] = useState(null)
  const [logLoading, setLogLoading] = useState(false)

  /* 两个"只有最新那份能落地"的守卫：
     · genRef：换账号后，上一个账号在途的概览/日志/会话响应必须整份丢弃；
     · logSeqRef：日志筛选会被连续点击（级别 / IP / 清 chip），慢的旧查询不能覆盖新结果。 */
  const genRef = useRef(0)
  const userIdRef = useRef(userId)
  const logSeqRef = useRef(0)
  const convSeqRef = useRef(0)
  useEffect(() => { userIdRef.current = userId }, [userId])

  /* 换账号：先清掉上一个账号的后台状态，再用当前账号自己的缓存占位 */
  useEffect(() => {
    genRef.current += 1
    const c = userId ? readOverviewCache(userId) : null
    setAnns((c && c.anns) || [])
    setUsers((c && c.users) || [])
    setConvs((c && c.convs) || [])
    setStats((c && c.stats) || null)
    setActive(null)
    setMsgs([])
    setMsgsLoading(false)
    setLogs([])
    setLogNext(0)
    setLogStats(null)
    setLogEvents([])
    setLogBudget(null)
    setMsg('')
    setNotice('')
  }, [userId])

  /* 首屏一次请求取全（公告 / 用户 / 会话 / 统计），原来是 4 个并行请求各验一次会话 */
  const loadOverview = async () => {
    if (!userId) return
    const gen = genRef.current
    const ep = currentEpoch()
    try {
      const d = await fetchOverview(userId)
      // null = 身份已切换（或已被登出），这份概览不属于当前账号
      if (!d || gen !== genRef.current || ep !== currentEpoch() || userId !== userIdRef.current) return
      setAnns(d.anns || [])
      setUsers(d.users || [])
      setConvs(d.convs || [])
      setStats(d.stats || null)
    } catch (err) {
      if (gen === genRef.current) setMsg(String(err.message))
    }
  }
  useEffect(() => { loadOverview() }, [userId])

  /* 本地改动同步进缓存，下次进后台首屏仍是新的 */
  const syncCache = (patch) => {
    const cur = readOverviewCache(userId)
    if (!cur) return
    writeOverviewCache(userId, { ...cur, ...patch })
  }

  /* 「加载中」延迟出现，避免几十毫秒的请求也闪一下文案 */
  useEffect(() => {
    if (!msgsLoading) { setShowMsgsLoading(false); return }
    const timer = setTimeout(() => setShowMsgsLoading(true), 180)
    return () => clearTimeout(timer)
  }, [msgsLoading])

  const flash = (text) => {
    setNotice(text)
    setMsg('')
    window.setTimeout(() => setNotice(''), 2600)
  }

  /* 日志查询：filters 显式传入，避免 setState 之后还没生效就发请求 */
  const loadLogs = async (opts = {}) => {
    const f = { level: logLevel, event: logEvent, q: logQApplied, ip: logIp, client: logShowClient ? 'all' : '', ...(opts.filters || {}) }
    // 这里不校验 q 长度：IP 按钮、清 chip、切页签都走这个函数，拦住会让人以为筛选失效。
    // 用的是"已应用"的 q，输入框里没提交的字不参与（否则点 IP 会悄悄叠加一个搜索条件）。
    const q = String(f.q || '').trim()
    const seq = ++logSeqRef.current
    const gen = genRef.current
    const ep = currentEpoch()
    setLogLoading(true)
    try {
      const qs = new URLSearchParams()
      if (f.level) qs.set('level', f.level)
      if (f.event) qs.set('event', f.event)
      if (f.ip) qs.set('ip', f.ip)
      if (f.client) qs.set('client', f.client)
      if (q.length >= 3) qs.set('q', q)
      if (opts.append && logNext) qs.set('before', String(logNext))
      const d = await api('/admin/logs' + (qs.toString() ? '?' + qs.toString() : ''))
      // 只有"最后一次发出的筛选"和"当前账号"的响应能落地：
      // 否则慢的旧查询/上一个账号的响应会覆盖新的筛选结果（审计「旧响应覆盖新数据」）。
      if (seq !== logSeqRef.current || gen !== genRef.current || ep !== currentEpoch()) return
      setLogs((old) => (opts.append ? old.concat(d.list || []) : (d.list || [])))
      setLogNext(d.nextBefore || 0)
      setLogStats(d.stats || null)
      setLogEvents(d.events || [])
      setLogBudget(d.budget || null)
      if (d.keepDays) setLogKeepDays(d.keepDays)
    } catch (err) {
      if (seq === logSeqRef.current && gen === genRef.current) setMsg(String(err.message))
    } finally {
      if (seq === logSeqRef.current) setLogLoading(false)
    }
  }

  useEffect(() => { if (tab === 'logs') loadLogs() }, [tab])

  /* 只有主动搜索才校验长度：1–2 字此前会让 IP 筛选/清 chip/切页签全部早退 */
  const submitSearch = (e) => {
    e.preventDefault()
    const q = logQ.trim()
    if (q && q.length < 3) { setMsg(t('admin.logs.qTooShort')); return }
    setLogQApplied(q)
    loadLogs({ filters: { q } })
  }

  /* 清理旧日志：不可恢复，天数与后果都要问清楚。范围与服务端保持一致（7–3650），
     否则服务端静默截断、弹窗里却还是用户输入的值 */
  const purgeLogs = async () => {
    const input = window.prompt(t('admin.logs.purgePrompt', { days: logKeepDays }), String(logKeepDays))
    if (!input) return
    const days = Number(input)
    if (!Number.isFinite(days) || days < 7 || days > 3650) { setMsg(t('admin.logs.purgeBadDays')); return }
    if (!window.confirm(t('admin.logs.purgeConfirm', { days }))) return
    try {
      const r = await api('/admin/logs/purge', { method: 'POST', body: { days } })
      flash(t('admin.logs.purged', { n: r.removed || 0 }))
      loadLogs()
    } catch (err) { setMsg(String(err.message)) }
  }

  const metaOf = (raw) => {
    if (!raw) return null
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : null
    } catch { return null }
  }

  const prettyMeta = (raw) => {
    if (!raw) return ''
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return String(raw) }
  }

  const searchUsers = async (e) => {
    e && e.preventDefault()
    try {
      const u = await api('/admin/users' + (q ? '?q=' + encodeURIComponent(q) : ''))
      setUsers(u.list || [])
    } catch (err) { setMsg(String(err.message)) }
  }

  /* 打开会话：消息与已读并行发出，不再串行等两次往返 */
  const openConv = async (cv) => {
    const seq = ++convSeqRef.current
    const gen = genRef.current
    setActive(cv)
    setMsgs([])
    setMsgsLoading(true)
    try {
      const [m] = await Promise.all([
        api('/conversation/' + cv.id + '/messages'),
        api('/conversation/' + cv.id + '/read', { method: 'POST' })
      ])
      // 期间换了会话或换了账号：这份消息不能显示在当前会话里
      if (seq !== convSeqRef.current || gen !== genRef.current) return
      setMsgs(m.list || [])
      setConvs((old) => {
        const next = old.map((c) => (c.id === cv.id ? { ...c, unread: 0 } : c))
        syncCache({ convs: next })
        return next
      })
    } catch (err) {
      if (seq === convSeqRef.current && gen === genRef.current) setMsg(String(err.message))
    } finally {
      if (seq === convSeqRef.current) setMsgsLoading(false)
    }
  }

  /* 返回来信列表：让还在途的消息请求作废，避免它回来后又把详情塞进列表页 */
  const closeConv = () => {
    convSeqRef.current += 1
    setActive(null)
    setMsgs([])
    setMsgsLoading(false)
  }

  /* 回复：本地追加，不再整页重载（原来一次回复要重跑 6 个请求） */
  const doReply = async (e) => {
    e.preventDefault()
    if (sending || !reply.trim() || !active) return
    const seq = convSeqRef.current
    const gen = genRef.current
    setMsg(''); setSending(true)
    const text = reply
    try {
      const r = await api('/conversation/reply', { method: 'POST', body: { conv_id: active.id, content: text } })
      // 期间换了会话/账号：回复已经发到服务端，但不能再追加到当前会话的界面
      if (seq !== convSeqRef.current || gen !== genRef.current) return
      setReply('')
      if (r.msg && r.msg.id) setMsgs((old) => old.concat([r.msg]))
      setConvs((old) => {
        const next = old.map((c) => (c.id === active.id ? { ...c, updated_at: r.msg ? r.msg.created_at : c.updated_at } : c))
        syncCache({ convs: next })
        return next
      })
    } catch (err) { setMsg(String(err.message)); setReply(text) } finally { setSending(false) }
  }

  /* 公告发布/保存：先用服务端返回的行直接插进列表，再后台对齐
     这样即使后续刷新失败，也不会出现"点了发布却什么都没发生"的假象 */
  const postAnn = async (e) => {
    e.preventDefault()
    if (saving) return
    setMsg(''); setNotice('')
    if (!title.trim() || !content.trim()) { setMsg(t('errors.announceEmpty')); return }
    setSaving(true)
    try {
      if (editId) {
        await api('/admin/announcements/' + editId, { method: 'PATCH', body: { title, content, pinned } })
        setAnns((old) => {
          const next = old.map((a) => (a.id === editId
            ? { ...a, title: title.trim(), content: content.trim(), pinned: pinned ? 1 : 0 }
            : a))
          syncCache({ anns: next })
          return next
        })
        flash(t('admin.annForm.saved'))
      } else {
        const r = await api('/announcements', { method: 'POST', body: { title, content, pinned } })
        const ann = r.ann || {
          id: r.id, title: title.trim(), content: content.trim(),
          author: '', pinned: pinned ? 1 : 0, created_at: new Date().toISOString()
        }
        setAnns((old) => {
          const next = [ann, ...old.filter((a) => a.id !== ann.id)]
            .sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id))
          syncCache({ anns: next })
          return next
        })
        flash(t('admin.annForm.published'))
      }
      setTitle(''); setContent(''); setPinned(false); setEditId(null)
      loadOverview()
    } catch (err) { setMsg(String(err.message)) } finally { setSaving(false) }
  }

  const startEdit = (a) => {
    setEditId(a.id); setTitle(a.title); setContent(a.content); setPinned(!!a.pinned)
    setMsg(''); setNotice('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelEdit = () => { setEditId(null); setTitle(''); setContent(''); setPinned(false) }

  /* 切换标签时退出编辑态：否则下次点"发布"会静默覆盖上一条公告 */
  const switchTab = (k) => {
    if (k !== 'ann' && editId) cancelEdit()
    setTab(k)
  }

  const delAnn = async (id) => {
    if (!window.confirm(t('admin.annForm.confirmDelete'))) return
    try {
      await api('/admin/announcements/' + id, { method: 'DELETE' })
      setAnns((old) => {
        const next = old.filter((a) => a.id !== id)
        syncCache({ anns: next })
        return next
      })
      if (editId === id) cancelEdit()
      setStats((s) => (s ? { ...s, anns: Math.max(0, (s.anns || 1) - 1) } : s))
    } catch (err) { setMsg(String(err.message)); loadOverview() }
  }

  const setRole = async (u, role) => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { role } }); loadOverview() } catch (err) { setMsg(err.message) } }
  const setBanned = async (u, banned) => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { banned } }); loadOverview() } catch (err) { setMsg(err.message) } }

  /* 删号：不可恢复，二次确认写清会连带删除什么 */
  const delUser = async (u) => {
    const label = u.nickname || u.username
    if (!window.confirm(t('admin.users.confirmDelete', { name: label, username: u.username }))) return
    try {
      await api('/admin/users/' + u.id, { method: 'DELETE' })
      setUsers((old) => old.filter((x) => x.id !== u.id))
      setConvs((old) => old.filter((c) => c.user_id !== u.id))
      flash(t('admin.users.deleted', { username: u.username }))
      loadOverview()
    } catch (err) { setMsg(err.message) }
  }

  const resetUserPw = async (u) => {
    const npw = window.prompt(t('admin.users.promptNewPassword', { name: u.nickname || u.username }))
    if (!npw) return
    try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { new_password: npw } }); setMsg(t('admin.users.resetDone', { username: u.username })) } catch (err) { setMsg(err.message) }
  }

  const totalUnread = convs.reduce((s, c) => s + (c.unread || 0), 0)
  const me = user
  const iAmSuper = !!(user && user.role === 'superadmin')

  return (
    <div className="panel-page panel-page--admin">
      <div className="panel-head">
        <p className="auth-kicker">{t('admin.kicker')}</p>
        <h1 className="panel-title">{t('admin.title')}</h1>
        <Link className="panel-back" to="/account">{t('account.title')}</Link>
        <Link className="panel-back" to="/">{t('common.backHome')}</Link>
      </div>

      <div className="admin-tabs">
        <button className={tab === 'dash' ? 'on' : ''} onClick={() => switchTab('dash')}>{t('admin.tabs.dash')}</button>
        <button className={tab === 'conv' ? 'on' : ''} onClick={() => switchTab('conv')}>{totalUnread > 0 ? t('admin.tabs.convUnread', { n: totalUnread }) : t('admin.tabs.conv')}</button>
        <button className={tab === 'ann' ? 'on' : ''} onClick={() => switchTab('ann')}>{editId ? t('admin.tabs.annEditing') : t('admin.tabs.ann')}</button>
        <button className={tab === 'news' ? 'on' : ''} onClick={() => switchTab('news')}>{t('news.adminTitle')}</button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => switchTab('users')}>{t('admin.tabs.users')}</button>
        <button className={tab === 'logs' ? 'on' : ''} onClick={() => switchTab('logs')}>{t('admin.tabs.logs')}</button>
      </div>

      {msg && <p className="auth-msg">{msg}</p>}
      {notice && <p className="auth-msg auth-msg--ok">{notice}</p>}
      {tab === 'news' && <AdminNewsView />}

      {/* ===== 概览 ===== */}
      {tab === 'dash' && stats && (
        <>
          <div className="dash-grid">
            <div className="dash-card"><span className="dash-n">{stats.total}</span><span className="dash-l">{t('admin.stats.total')}</span></div>
            <div className="dash-card"><span className="dash-n">{stats.new7}</span><span className="dash-l">{t('admin.stats.new7')}</span></div>
            <div className="dash-card"><span className="dash-n">{stats.admins}</span><span className="dash-l">{t('admin.stats.admins')}</span></div>
            <div className="dash-card"><span className="dash-n">{stats.convs}</span><span className="dash-l">{t('admin.stats.convs')}</span></div>
            <div className="dash-card"><span className="dash-n">{stats.unreadConvs}</span><span className="dash-l">{t('admin.stats.unreadConvs')}</span></div>
            <div className="dash-card"><span className="dash-n">{stats.anns}</span><span className="dash-l">{t('admin.stats.anns')}</span></div>
          </div>
        </>
      )}

      {/* ===== 来信 ===== */}
      {tab === 'conv' && !active && (
        <div className="admin-list">
          {convs.length === 0 && <p className="panel-empty">{t('admin.noConversations')}</p>}
          {convs.map((c) => (
            <button key={c.id} className={"conv-row " + (c.unread > 0 ? 'conv-row--unread' : '')} onClick={() => openConv(c)}>
              <span className="conv-name">{c.nickname || c.username}（@{c.username}）</span>
              <span className="conv-unread">{c.unread > 0 ? t('admin.unreadCount', { n: c.unread }) : t('admin.read')}</span>
              <span className="msg-date">{fmtDateTime(c.updated_at)}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'conv' && active && (
        <div className="conv-detail">
          <button className="mini-btn" onClick={closeConv}>{t('admin.backToList')}</button>
          <h3 className="conv-title">{t('admin.conversationWith', { name: active.nickname || active.username, username: active.username })}</h3>
          <div className="chat chat--inadmin">
            <div className="chat-box">
              {showMsgsLoading && <div className="chat-skel" aria-hidden="true"><i /><i /><i /></div>}
              {msgs.map((m) => (
                <div key={m.id} className={"chat-msg " + (m.direction === 'to_user' ? 'chat-msg--me' : 'chat-msg--staff')}>
                  <div className="chat-bubble">{m.content}</div>
                  <span className="chat-meta">{m.direction === 'to_user' ? t('member.staff') : m.sender_name + t('admin.roleMemberSuffix')} · {fmtDateTime(m.created_at)}</span>
                </div>
              ))}
            </div>
            <form onSubmit={doReply} className="chat-form">
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows="2" maxLength="1000" placeholder={t('admin.replyPlaceholder')} required />
              <button className="auth-btn" disabled={sending}>{sending ? t('admin.replying') : t('admin.reply')}</button>
            </form>
          </div>
        </div>
      )}

      {/* ===== 公告 ===== */}
      {tab === 'ann' && (
        <>
          <form onSubmit={postAnn} className="msg-form ann-form">
            <label>{t('admin.annForm.titleLabel')} <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength="60" required /></label>
            <label>{t('admin.annForm.contentLabel')} <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="4" maxLength="5000" required /></label>
            <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> {t('admin.annForm.pinnedLabel')}</label>
            <div className="btn-row">
              <button className="auth-btn" disabled={saving}>
                {saving
                  ? t('admin.annForm.publishing')
                  : (editId ? t('admin.annForm.save') : t('admin.annForm.publish'))}
              </button>
              {editId && <button type="button" className="mini-btn" onClick={cancelEdit}>{t('admin.annForm.cancelEdit')}</button>}
            </div>
          </form>
          <div className="admin-list">
            {anns.map((a) => (
              <div key={a.id} className="admin-row">
                <div>
                  <strong>{a.pinned ? '📌 ' : ''}{a.title}</strong>
                  <span className="msg-date"> {fmtDate(a.created_at)} · {a.author}</span>
                </div>
                <div className="btn-row">
                  <button className="mini-btn" onClick={() => startEdit(a)}>{t('admin.annForm.edit')}</button>
                  <button className="mini-btn mini-btn--danger" onClick={() => delAnn(a.id)}>{t('admin.annForm.delete')}</button>
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
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.users.searchPlaceholder')} />
            <button className="mini-btn" type="submit">{t('admin.users.search')}</button>
            {q && <button className="mini-btn" type="button" onClick={() => { setQ(''); searchUsers() }}>{t('admin.users.clear')}</button>}
          </form>
          <p className="acct-note">{iAmSuper ? t('admin.users.superHint') : t('admin.users.staffHint')}</p>
          <div className="admin-list">
            {users.map((u) => {
              const isSuperRow = u.role === 'superadmin'
              const isSelf = !!(me && me.id === u.id)
              const locked = isSuperRow || isSelf          // 超管账号与自己都不给动
              return (
                <div key={u.id} className={"admin-row " + (u.banned ? 'admin-row--banned' : '')}>
                  <div>
                    <strong>{u.nickname || u.username}</strong>
                    <span className="msg-date"> @{u.username} · {fmtDate(u.created_at)}</span>
                    <span className={"role-tag " + (isSuperRow ? 'role-tag--super' : u.role === 'admin' ? 'role-tag--admin' : '')}>
                      {isSuperRow ? t('admin.users.roleSuper') : u.role === 'admin' ? t('admin.users.roleStaff') : t('admin.users.roleMember')}
                    </span>
                    {u.banned ? <span className="role-tag role-tag--ban">{t('admin.users.banned')}</span> : null}
                    {isSelf ? <span className="role-tag">{t('admin.users.self')}</span> : null}
                  </div>
                  <div className="btn-row">
                    {iAmSuper && !locked && (
                      <button className="mini-btn" onClick={() => setRole(u, u.role === 'admin' ? 'user' : 'admin')}>
                        {u.role === 'admin' ? t('admin.users.demote') : t('admin.users.promote')}
                      </button>
                    )}
                    {!locked && <button className="mini-btn" onClick={() => resetUserPw(u)}>{t('admin.users.resetPassword')}</button>}
                    {!locked && (
                      <button className={"mini-btn " + (u.banned ? '' : 'mini-btn--danger')} onClick={() => setBanned(u, !u.banned)}>
                        {u.banned ? t('admin.users.unban') : t('admin.users.ban')}
                      </button>
                    )}
                    {iAmSuper && !locked && (
                      <button className="mini-btn mini-btn--danger" onClick={() => delUser(u)}>{t('admin.users.deleteAccount')}</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ===== 日志（审计流水） ===== */}
      {tab === 'logs' && (
        <>
          <form className="log-filter" onSubmit={submitSearch}>
            <select
              value={logLevel}
              onChange={(e) => { setLogLevel(e.target.value); loadLogs({ filters: { level: e.target.value } }) }}
              aria-label={t('admin.logs.allLevels')}
            >
              <option value="">{t('admin.logs.allLevels')}</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
            </select>
            <select
              value={logEvent}
              onChange={(e) => { setLogEvent(e.target.value); loadLogs({ filters: { event: e.target.value } }) }}
              aria-label={t('admin.logs.allEvents')}
            >
              <option value="">{t('admin.logs.allEvents')}</option>
              {logEvents.map((ev) => (
                <option key={ev.event} value={ev.event} title={ev.event}>{eventLabel(ev.event)}（{ev.n}）</option>
              ))}
            </select>
            <input
              value={logQ}
              onChange={(e) => setLogQ(e.target.value)}
              maxLength="80"
              placeholder={t('admin.logs.searchPlaceholder')}
            />
            <button className="mini-btn" type="submit" disabled={logLoading}>
              {logLoading ? t('admin.logs.loading') : t('admin.logs.query')}
            </button>
            {/* 客户端自述上报默认不进主列表（后端默认也是排除），要看得显式打开 */}
            <label className="check log-client-toggle">
              <input
                type="checkbox"
                checked={logShowClient}
                onChange={(e) => { setLogShowClient(e.target.checked); loadLogs({ filters: { client: e.target.checked ? 'all' : '' } }) }}
              />
              {t('admin.logs.showClient')}
            </label>
            {logIp ? (
              <button
                className="mini-btn"
                type="button"
                onClick={() => { setLogIp(''); loadLogs({ filters: { ip: '' } }) }}
              >
                {t('admin.logs.ipChip', { ip: logIp })}
              </button>
            ) : null}
            {iAmSuper && (
              <button className="mini-btn mini-btn--danger" type="button" onClick={purgeLogs}>
                {t('admin.logs.purge')}
              </button>
            )}
          </form>

          <p className="acct-note">
            {logStats
              ? t('admin.logs.summary', {
                total: logStats.total, error: logStats.error, warn: logStats.warn, info: logStats.info, days: logKeepDays
              })
              : t('admin.logs.hint')}
            {logBudget && logBudget.dropped > 0 ? ' · ' + t('admin.logs.dropped', { n: logBudget.dropped }) : ''}
          </p>

          <div className="log-list">
            {!logLoading && logs.length === 0 && <p className="panel-empty">{t('admin.logs.empty')}</p>}
            {logs.map((row) => {
              const meta = metaOf(row.meta)
              const isClient = !!(meta && meta.source === 'client')
              return (
                <div key={row.id} className={'log-row log-row--' + row.level + (isClient ? ' log-row--client' : '')}>
                  <span className={'log-badge log-badge--' + row.level}>{row.level}</span>
                  <div className="log-main">
                    <div className="log-head">
                      <strong className="log-event" title={row.event}>{eventLabel(row.event)}</strong>
                      {isClient ? <span className="log-src">{t('admin.logs.clientTag')}</span> : null}
                      <span className="log-when">{row.ts ? fmtDateTime(new Date(row.ts).toISOString()) : ''}</span>
                    </div>
                    <div className="log-meta">
                      {row.actor_name || t('admin.logs.anon')}
                      {row.actor_id ? ' #' + row.actor_id : ''}
                      {row.status ? ' · ' + row.status : ''}
                      {row.path ? ' · ' + (row.method || 'GET') + ' ' + row.path : ''}
                      {row.ip ? ' · ' : ''}
                      {row.ip ? (
                        <button
                          type="button"
                          className="log-ip"
                          title={t('admin.logs.filterByIp')}
                          onClick={() => { setLogIp(row.ip); loadLogs({ filters: { ip: row.ip } }) }}
                        >
                          {row.ip}
                        </button>
                      ) : null}
                      {row.target_type ? ' · ' + row.target_type + (row.target_id ? ':' + row.target_id : '') : ''}
                    </div>
                    {/* rid 是和控制台日志（wrangler tail / Workers Logs）对账的唯一钥匙，必须能看到 */}
                    <div className="log-rid">
                      {row.rid ? 'rid ' + row.rid : ''}
                      {row.ua ? (row.rid ? ' · ' : '') + row.ua : ''}
                    </div>
                    {row.meta ? (
                      <details className="log-json">
                        <summary>{t('admin.logs.detail')}</summary>
                        <pre>{prettyMeta(row.meta)}</pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>

          {logNext > 0 && (
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="mini-btn" onClick={() => loadLogs({ append: true })} disabled={logLoading}>
                {t('admin.logs.more')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
