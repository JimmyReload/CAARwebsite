import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'

export default function AuthView({ mode, onLogin }) {
  const isLogin = mode === 'login'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setMsg('')
    try {
      const d = await api(isLogin ? '/login' : '/register', { method: 'POST', body: { username, password, nickname } })
      if (isLogin) {
        if (onLogin) onLogin(d.user)
        nav(d.user && d.user.role === 'admin' ? '/admin' : '/member')
      } else { setMsg(t('auth.registerOk')); setPassword('') }
    } catch (err) { setMsg(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <p className="auth-kicker">{isLogin ? t('auth.loginKicker') : t('auth.registerKicker')}</p>
        <h1 className="auth-title">{isLogin ? t('auth.loginTitle') : t('auth.registerTitle')}</h1>
        <p className="auth-sub">{isLogin ? t('auth.loginSub') : t('auth.registerSub')}</p>
        <form onSubmit={submit} className="auth-form">
          {!isLogin && (
            <label>{t('auth.nicknameLabel')}
              <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder={t('auth.nicknamePlaceholder')} maxLength="20" />
            </label>
          )}
          <label>{t('auth.usernameLabel')}
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('auth.usernamePlaceholder')} maxLength="20" required />
          </label>
          <label>{t('auth.passwordLabel')}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('auth.passwordPlaceholder')} minLength="6" required />
          </label>
          {msg && <p className="auth-msg">{msg}</p>}
          <button className="auth-btn" disabled={busy}>{busy ? t('auth.busy') : (isLogin ? t('auth.login') : t('auth.register'))}</button>
        </form>
        <p className="auth-alt">
          {isLogin ? (
            <span>{t('auth.noAccount')}<Link to="/register">{t('auth.goRegister')}</Link></span>
          ) : (
            <span>{t('auth.hasAccount')}<Link to="/login">{t('auth.goLogin')}</Link></span>
          )}
          <Link to="/">{t('common.backHome')}</Link>
        </p>
      </div>
    </div>
  )
}
