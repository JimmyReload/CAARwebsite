import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'
import { fmtDate } from '../time'

/* 个人主页：账号信息 + 修改密码 + 退出登录
   修改密码原来在「成员面板」和「管理后台」各有一份，现在统一收到这里 */
export default function AccountView({ user, setUser }) {
  const nav = useNavigate()
  const [nick, setNick] = useState((user && (user.nickname || user.username)) || '')
  const [nickMsg, setNickMsg] = useState('')
  const [nickSaving, setNickSaving] = useState(false)
  const [op, setOp] = useState('')
  const [np, setNp] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [saving, setSaving] = useState(false)

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
      await api('/change-password', { method: 'POST', body: { old_password: op, new_password: np } })
      setOp(''); setNp('')
      setPwMsg(t('password.ok'))
    } catch (err) {
      setPwMsg(err.message)
    } finally {
      setSaving(false)
    }
  }

  const logout = async () => {
    try { await api('/logout', { method: 'POST' }) } catch { /* 网络异常也按已退出处理 */ }
    setUser(null)
    nav('/')
  }

  if (!user) return null
  const name = user.nickname || user.username
  const isAdmin = user.role === 'admin'

  return (
    <div className="panel-page">
      <div className="panel-head">
        <p className="auth-kicker">{t('account.kicker')}</p>
        <h1 className="panel-title">{t('account.title')}</h1>
        <Link className="panel-back" to="/">{t('common.backHome')}</Link>
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
            <span className="acct-value">{isAdmin ? t('account.roleAdmin') : t('account.roleMember')}</span>
          </div>
          <div className="acct-item">
            <span className="acct-label">{t('account.joined')}</span>
            <span className="acct-value">{fmtDate(user.created_at)}</span>
          </div>
        </div>
        <div className="btn-row acct-links">
          <Link className="mini-btn" to="/member">{t('nav.memberPanel')}</Link>
          {isAdmin && <Link className="mini-btn" to="/admin">{t('nav.adminPanel')}</Link>}
          <Link className="mini-btn" to="/hunts">{t('nav.hunts')}</Link>
        </div>
      </section>

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
          <label>{t('password.old')} <input type="password" value={op} onChange={(e) => setOp(e.target.value)} autoComplete="current-password" required /></label>
          <label>{t('password.next')} <input type="password" value={np} onChange={(e) => setNp(e.target.value)} minLength="6" autoComplete="new-password" placeholder={t('password.placeholder')} required /></label>
          {pwMsg && <p className={"auth-msg " + (pwMsg.indexOf('✓') === 0 ? 'auth-msg--ok' : '')}>{pwMsg}</p>}
          <button className="auth-btn" disabled={saving}>{saving ? t('password.saving') : t('password.save')}</button>
        </form>
        <p className="acct-note">{t('account.passwordNote')}</p>
      </section>

      <section className="panel-sec">
        <h2 className="panel-sec-title">{t('account.session')}</h2>
        <div className="acct-logout">
          <p className="acct-note">{t('account.logoutNote')}</p>
          <button type="button" className="mini-btn mini-btn--danger" onClick={logout}>{t('account.logout')}</button>
        </div>
      </section>
    </div>
  )
}
