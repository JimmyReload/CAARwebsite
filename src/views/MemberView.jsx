import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'
import { fmtDate, fmtDateTime } from '../time'
import { readInboxCache, writeInboxCache, fetchInbox } from '../panelCache'

/* 私信轮询间隔：10 秒。页面切到后台时暂停，切回来立即补一次 */
const POLL_MS = 10000

/* 客户端消息上限：轮询是增量拼接的，面板长期开着会一直涨（审计「消息无界增长」）。
   只保留最近 MAX_MESSAGES 条：服务端首屏本身只给最近 50 条，更早的历史不进列表，
   缓存里也不会无限膨胀。 */
export const MAX_MESSAGES = 200

function capMsgs(list) {
  return list.length > MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES) : list
}

/* 按 id 合并两批消息（本地已渲染的不会被服务端响应覆盖掉），并对总数封顶 */
export function mergeMsgs(a, b) {
  if (!b || !b.length) return capMsgs(a)
  const seen = new Set(a.map((x) => x.id))
  const add = b.filter((x) => !seen.has(x.id))
  if (!add.length) return capMsgs(a)
  return capMsgs(a.concat(add).sort((x, y) => x.id - y.id))
}

export default function MemberView({ user }) {
  const userId = user && user.id
  /* 首屏直接用预取缓存渲染：进入面板不再等一次网络往返 */
  const [cached] = useState(() => readInboxCache(userId))
  const [anns, setAnns] = useState((cached && cached.announcements) || [])
  const [conv, setConv] = useState((cached && cached.conv) || null)
  const [msgs, setMsgs] = useState(() => capMsgs((cached && cached.list) || []))
  const [content, setContent] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(!cached)
  const [showLoading, setShowLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const boxRef = useRef(null)
  const msgsRef = useRef(msgs)
  const annsRef = useRef(anns)
  const convRef = useRef(conv)
  const lastIdRef = useRef(msgs.length ? msgs[msgs.length - 1].id : 0)
  const annVerRef = useRef(cached && cached.annVersion != null ? cached.annVersion : -1)
  /* 账号代次：userId 一变就 +1；所有异步响应回来先比对，旧账号的响应一律丢弃 */
  const genRef = useRef(0)
  const userIdRef = useRef(userId)

  useEffect(() => { msgsRef.current = msgs }, [msgs])
  useEffect(() => { annsRef.current = anns }, [anns])
  useEffect(() => { convRef.current = conv }, [conv])
  useEffect(() => { userIdRef.current = userId }, [userId])

  /* 「加载中」延迟出现：请求通常几十毫秒就回来了，不该闪一下文案 */
  useEffect(() => {
    if (!loading) { setShowLoading(false); return }
    const timer = setTimeout(() => setShowLoading(true), 180)
    return () => clearTimeout(timer)
  }, [loading])

  /* 换账号：先彻底丢掉上一个账号的私信状态，再用当前账号自己的缓存占位。
     这样 A 的消息既不会留在 B 的界面里，也不会被 B 的后续操作写进 B 的缓存。 */
  useEffect(() => {
    genRef.current += 1
    const c = userId ? readInboxCache(userId) : null
    const list = capMsgs((c && c.list) || [])
    const announcements = (c && c.announcements) || []
    setAnns(announcements); annsRef.current = announcements
    annVerRef.current = c && c.annVersion != null ? c.annVersion : -1
    const nextConv = (c && c.conv) || null
    setConv(nextConv); convRef.current = nextConv
    setMsgs(list); msgsRef.current = list
    lastIdRef.current = list.length ? list[list.length - 1].id : 0
    setLoading(!c)
    setMsg('')
  }, [userId])

  const scrollDown = () => {
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }

  /* 本地状态回写缓存，下次进面板/刷新时首屏仍是最新的 */
  const persist = (next) => {
    writeInboxCache(userId, {
      announcements: next.announcements !== undefined ? next.announcements : annsRef.current,
      annVersion: annVerRef.current,
      conv: next.conv !== undefined ? next.conv : convRef.current,
      list: next.list !== undefined ? next.list : msgsRef.current
    })
  }

  /* 进入面板：先用缓存渲染，再静默回源对齐服务端。
     fetchInbox 在身份切换/登出后会解析为 null —— 这份响应不属于当前账号，必须整份丢掉。 */
  useEffect(() => {
    if (!userId) return
    const gen = genRef.current
    let alive = true
    fetchInbox(userId)
      .then((d) => {
        if (!alive || !d || gen !== genRef.current || userId !== userIdRef.current) return
        if (d.announcements) { setAnns(d.announcements); annsRef.current = d.announcements }
        if (d.annVersion != null) annVerRef.current = d.annVersion
        setConv(d.conv || null)
        const merged = mergeMsgs(msgsRef.current, d.list || [])
        msgsRef.current = merged
        setMsgs(merged)
        lastIdRef.current = merged.length ? merged[merged.length - 1].id : 0
        scrollDown()
      })
      .catch((err) => {
        if (alive && gen === genRef.current) setMsg(String(err.message))
      })
      .finally(() => {
        if (alive && gen === genRef.current) setLoading(false)
      })
    return () => { alive = false }
  }, [userId])

  /* 增量轮询：只取比本地最新一条更新的消息 */
  useEffect(() => {
    if (!userId) return
    const gen = genRef.current
    let stopped = false
    const tick = async () => {
      if (stopped || document.hidden || gen !== genRef.current) return
      try {
        const d = await api('/inbox?after=' + lastIdRef.current)
        // 身份切换/组件卸载后到达的响应：不写状态、不写缓存
        if (stopped || gen !== genRef.current || userId !== userIdRef.current) return
        // 公告变了才重新拉正文，平时只比对版本号
        if (d.annVersion != null && d.annVersion !== annVerRef.current) {
          annVerRef.current = d.annVersion
          const a = await api('/announcements')
          if (stopped || gen !== genRef.current || userId !== userIdRef.current) return
          setAnns(a.list || [])
          annsRef.current = a.list || []
          persist({})
        }
        if (d.convId) setConv((c) => c || { id: d.convId })
        if (d.list && d.list.length) {
          const merged = mergeMsgs(msgsRef.current, d.list)
          msgsRef.current = merged
          setMsgs(merged)
          lastIdRef.current = Math.max(lastIdRef.current, d.list[d.list.length - 1].id)
          persist({ list: merged })
          scrollDown()
        }
      } catch { /* 网络抖动下一轮再试 */ }
    }
    const timer = setInterval(tick, POLL_MS)
    const onVisible = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [userId])

  const send = async (e) => {
    e.preventDefault()
    if (sending || !content.trim()) return
    const uid = userId
    setMsg('')
    setSending(true)
    const text = content
    try {
      const r = await api('/conversation/message', { method: 'POST', body: { content: text } })
      // 请求在途时换了账号：这次发送的结果不属于当前账号，不能追加到当前列表
      if (uid !== userIdRef.current) return
      setContent('')
      // 服务端返回整行，直接追加，不再为确认而多跑一次查询
      if (r.msg && r.msg.id) {
        const merged = mergeMsgs(msgsRef.current, [r.msg])
        msgsRef.current = merged
        setMsgs(merged)
        lastIdRef.current = Math.max(lastIdRef.current, r.msg.id)
        persist({ list: merged })
      }
      if (r.conv_id) setConv((c) => c || { id: r.conv_id })
      scrollDown()
    } catch (err) {
      setMsg(err.message)
      setContent(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="panel-page">
      <div className="panel-head">
        <p className="auth-kicker">{t('member.kicker')}</p>
        <h1 className="panel-title">{t('member.title')}</h1>
        <Link className="panel-back" to="/account">{t('account.title')}</Link>
        <Link className="panel-back" to="/">{t('common.backHome')}</Link>
      </div>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('member.announcements')}</h2>
        {anns.length === 0 && <p className="panel-empty">{t('member.noAnnouncements')}</p>}
        {anns.map((a) => (
          <article key={a.id} className={"ann " + (a.pinned ? 'ann--pinned' : '')}>
            <div className="ann-meta"><span>{a.pinned ? t('member.pinned') : a.author}</span><span>{fmtDate(a.created_at)}</span></div>
            <h3 className="ann-title">{a.title}</h3>
            <p className="ann-content">{a.content}</p>
          </article>
        ))}
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('member.inbox')}</h2>
        <div className="chat">
          <div className="chat-box" ref={boxRef}>
            {showLoading && msgs.length === 0 && <div className="chat-skel" aria-hidden="true"><i /><i /><i /></div>}
            {!loading && !conv && msgs.length === 0 && <p className="panel-empty">{t('member.inboxEmpty')}</p>}
            {msgs.map((m) => (
              <div key={m.id} className={"chat-msg " + (m.direction === 'to_staff' ? 'chat-msg--me' : 'chat-msg--staff')}>
                <div className="chat-bubble">{m.content}</div>
                <span className="chat-meta">{m.direction === 'to_staff' ? t('member.me') : t('member.staff')} · {fmtDateTime(m.created_at)}</span>
              </div>
            ))}
          </div>
          <form onSubmit={send} className="chat-form">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows="2" maxLength="1000" placeholder={t('member.messagePlaceholder')} required />
            {msg && <p className="auth-msg">{msg}</p>}
            <button className="auth-btn" disabled={sending}>{sending ? t('member.sending') : t('member.send')}</button>
          </form>
        </div>
      </section>
    </div>
  )
}
