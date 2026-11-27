import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../api'
import { logoutSession } from '../panelCache'
import { t } from '../i18n'
import { fmtDate } from '../time'

/* 个人主页：账号信息 + 绑定邮箱 + 修改昵称 + 修改密码 + 退出登录
   修改密码原来在「成员面板」和「管理后台」各有一份，现在统一收到这里 */
export default function AccountView({ user, setUser }) {
  const nav = useNavigate()
  const [nick, setNick] = useState((user && (user.nickname || user.username)) || '')
  const [nickMsg, setNickMsg] = useState('')
  const [nickSaving, setNickSaving] = useState(false)
  const [mail, setMail] = useState((user && user.email) || '')
  const [mailCode, setMailCode] = useState('')
  const [mailMsg, setMailMsg] = useState('')
  const [mailOk, setMailOk] = useState(false)
  const [mailSaving, setMailSaving] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [sendingCode, setSendingCode] = useState(false)
  const [op, setOp] = useState('')
  const [np, setNp] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutMsg, setLogoutMsg] = useState('')

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const sendCode = async () => {
    setMailMsg(''); setMailOk(false)
    const addr = mail.trim()
    if (!addr) { setMailMsg(t('errors.emailInvalid')); return }
    setSendingCode(true)
    try {
      await api('/email-code', { method: 'POST', body: { email: addr, purpose: 'bind' } })
      setCooldown(60)
      setMailOk(true)
      setMailMsg(t('auth.codeSent'))
    } catch (err) {
      setMailMsg(err.message)
    } finally {
      setSendingCode(false)
    }
  }

  const saveMail = async (e) => {
    e.preventDefault()
    if (mailSaving) return
    setMailMsg(''); setMailOk(false)
    setMailSaving(true)
    try {
      const r = await api('/profile/email', { method: 'POST', body: { email: mail.trim(), code: mailCode.trim() } })
      const saved = r.email || mail.trim()
      setUser({ ...user, email: saved })
      setMail(saved)
      setMailCode('')
      setMailOk(true)
      setMailMsg(t('account.emailOk'))
    } catch (err) {
      setMailMsg(err.message)
    } finally {
      setMailSaving(false)
    }
  }

  const saveNick = async (e) => {
    e.preventDefault()
    if (nickSaving) return
    setNickMsg('')
    const next = nick.trim()
    if (!next) { setNickMsg(t('errors.nicknameEmpty')); return }
    setNickSaving(true)
    try {
      const r = await api('/profile', { method: 'PATCH', body: { nickname: next } })
      const saved = r.nickname || next
      setUser({ ...user, nickname: saved })
      setNick(saved)
      setNickMsg(t('account.nickOk'))
    } catch (err) {
      setNickMsg(err.message)
    } finally {
      setNickSaving(false)
    }
  }

  const changePw = async (e) => {
    e.preventDefault()
    if (saving) return
    setPwMsg('')
    setSaving(true)
    try {
      // 只走过 PuzzleCat 登录的账号没有旧口令可验，走「首次设置口令」这条路径
      const needOld = user.hasPassword !== false
      const r = await api(needOld ? '/change-password' : '/password/set', {
        method: 'POST',
        body: needOld ? { old_password: op, new_password: np } : { new_password: np }
      })
      setOp(''); setNp('')
      if (!needOld) setUser({ ...user, hasPassword: true })
      setPwMsg(t('password.ok'))
      return r
    } catch (err) {
      setPwMsg(err.message)
    } finally {
      setSaving(false)
    }
  }

  /* 退出登录：服务端确认后才清本地身份与缓存。
     请求失败（网络/服务端错误）时 Cookie 可能仍然有效，此时宣称「已退出」会让人以为
     会话已经结束；这里保留登录态并给出可重试的错误。 */
  const logout = async () => {
    if (loggingOut) return
    setLogoutMsg('')
    setLoggingOut(true)
    try {
      await logoutSession()
      setUser(null)
      nav('/')
    } catch (err) {
      setLogoutMsg((err && err.message) || t('api.failed'))
    } finally {
      setLoggingOut(false)
    }
  }

  if (!user) return null
  const name = user.nickname || user.username
  const isSuper = user.role === 'superadmin'
  const isAdmin = isSuper || user.role === 'admin'

  return (
    <div className="panel-page">
      <div className="panel-head">
        <p className="auth-kicker">{t('account.kicker')}</p>
        <h1 className="panel-title">{t('account.title')}</h1>
        <div className="panel-actions">
          <Link className="panel-back" to="/">{t('common.backHome')}</Link>
        </div>
      </div>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('account.profile')}</h2>
        <div className="acct-grid">
          <div className="acct-item">
            <span className="acct-label">{t('account.nickname')}</span>
            <span className="acct-value">{name}</span>
          </div>
          <div className="acct-item">
            <span className="acct-label">{t('account.username')}</span>
            <span className="acct-value">@{user.username}</span>
          </div>
          <div className="acct-item">
            <span className="acct-label">{t('account.role')}</span>
            <span className="acct-value">{isSuper ? t('account.roleSuper') : isAdmin ? t('account.roleAdmin') : t('account.roleMember')}</span>
          </div>
          <div className="acct-item">
            <span className="acct-label">{t('account.joined')}</span>
            <span className="acct-value">{fmtDate(user.created_at)}</span>
          </div>
          <div className="acct-item">
            <span className="acct-label">{t('auth.emailLabel')}</span>
            <span className="acct-value">{user.email || t('account.emailUnbound')}</span>
          </div>
        </div>
        <div className="btn-row acct-links">
          <Link className="mini-btn" to="/member">{t('nav.memberPanel')}</Link>
          {isAdmin && <Link className="mini-btn" to="/admin">{t('nav.adminPanel')}</Link>}
          <Link className="mini-btn" to="/hunts">{t('nav.hunts')}</Link>
        </div>
      </section>

      {!user.email && <section className="panel-sec acct-form">
        <h2 className="panel-sec-title">{t('account.emailTitle')}</h2>
        <form onSubmit={saveMail} className="msg-form">
          <label>{t('auth.emailLabel')}
            <input type="email" value={mail} onChange={(e) => setMail(e.target.value)} placeholder={t('auth.emailPlaceholder')} autoComplete="email" maxLength="100" required />
          </label>
          <div className="field">
            <span>{t('auth.codeLabel')}</span>
            <span className="code-row">
              <input value={mailCode} onChange={(e) => setMailCode(e.target.value.replace(/\D/g, ''))} placeholder={t('auth.codePlaceholder')} inputMode="numeric" maxLength="6" required />
              <button type="button" className="mini-btn" onClick={sendCode} disabled={sendingCode || cooldown > 0}>
                {sendingCode ? t('auth.sendingCode') : cooldown > 0 ? t('auth.resendIn', { s: cooldown }) : t('auth.sendCode')}
              </button>
            </span>
          </div>
          {mailMsg && <p className={"auth-msg " + (mailOk ? 'auth-msg--ok' : '')}>{mailMsg}</p>}
          <button className="auth-btn" disabled={mailSaving}>{mailSaving ? t('account.saving') : t('account.bindEmail')}</button>
        </form>
        <p className="acct-note">{t('account.emailNote')}</p>
      </section>}

      <section className="panel-sec acct-form">
        <h2 className="panel-sec-title">{t('account.nicknameEdit')}</h2>
        <form onSubmit={saveNick} className="msg-form">
          <label>{t('account.nickname')} <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={20} autoComplete="nickname" required /></label>
          {nickMsg && <p className={"auth-msg " + (nickMsg.indexOf('✓') === 0 ? 'auth-msg--ok' : '')}>{nickMsg}</p>}
          <button className="auth-btn" disabled={nickSaving}>{nickSaving ? t('account.saving') : t('account.saveNick')}</button>
        </form>
        <p className="acct-note">{t('account.nicknameNote')}</p>
      </section>

      <section className="panel-sec acct-form">
        <h2 className="panel-sec-title">{t('account.password')}</h2>
        <form onSubmit={changePw} className="msg-form">
          {/* 首登建号（PuzzleCat）的账号没有旧口令：只显示新口令一栏 */}
          {user.hasPassword !== false && (
            <label>{t('password.old')} <input type="password" value={op} onChange={(e) => setOp(e.target.value)} autoComplete="current-password" required /></label>
          )}
          <label>{t('password.next')} <input type="password" value={np} onChange={(e) => setNp(e.target.value)} minLength="6" autoComplete="new-password" placeholder={t('password.placeholder')} required /></label>
          {pwMsg && <p className={"auth-msg " + (pwMsg.indexOf('✓') === 0 ? 'auth-msg--ok' : '')}>{pwMsg}</p>}
          <button className="auth-btn" disabled={saving}>{saving ? t('password.saving') : (user.hasPassword === false ? t('password.setFirst') : t('password.save'))}</button>
        </form>
        <p className="acct-note">{user.hasPassword === false ? t('account.passwordSetNote') : t('account.passwordNote')}</p>
      </section>
      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('account.session')}</h2>
        <div className="acct-logout">
          <p className="acct-note">{t('account.logoutNote')}</p>
          <button type="button" className="mini-btn mini-btn--danger" onClick={logout} disabled={loggingOut}>
            {loggingOut ? t('common.loading') : t('account.logout')}
          </button>
          {/* 失败时明确说明登录态仍然有效：文案直接写在这里，src/locales 不在本次改动范围 */}
          {logoutMsg && <p className="auth-msg" role="alert">退出失败：{logoutMsg}。登录状态仍然有效，请重试。</p>}
        </div>
      </section>
    </div>
  )
}
