import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api'
import { t } from '../i18n'

export default function AuthView({ mode, onLogin }) {
  const isLogin = mode === 'login'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState('')
  const [codeMsg, setCodeMsg] = useState('')
  const [codeOk, setCodeOk] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [sendingCode, setSendingCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  /* 验证码重发倒计时 */
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const sendCode = async () => {
    setCodeMsg(''); setCodeOk(false)
    const addr = email.trim()
    if (!addr) { setCodeMsg(t('errors.emailInvalid')); return }
    setSendingCode(true)
    try {
      await api('/email-code', { method: 'POST', body: { email: addr, purpose: 'register' } })
      setCooldown(60)
      setCodeOk(true)
      setCodeMsg(t('auth.codeSent'))
    } catch (err) {
      setCodeMsg(err.message)
    } finally {
      setSendingCode(false)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setMsg('')
    try {
      const body = isLogin ? { username, password } : { username, password, nickname, email: email.trim(), code: code.trim() }
      const d = await api(isLogin ? '/login' : '/register', { method: 'POST', body })
      if (isLogin) {
        if (onLogin) onLogin(d.user)
        nav(d.user && (d.user.role === 'admin' || d.user.role === 'superadmin') ? '/admin' : '/member')
      } else { setMsg(t('auth.registerOk')); setPassword(''); setCode('') }
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
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('auth.passwordPlaceholder')} minLength="6" autoComplete={isLogin ? 'current-password' : 'new-password'} required />
          </label>
          {!isLogin && (
            <>
              <label>{t('auth.emailLabel')}
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('auth.emailPlaceholder')} autoComplete="email" maxLength="100" required />
              </label>
              <div className="field">
                <span>{t('auth.codeLabel')}</span>
                <span className="code-row">
                  <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder={t('auth.codePlaceholder')} inputMode="numeric" maxLength="6" required />
                  <button type="button" className="mini-btn" onClick={sendCode} disabled={sendingCode || cooldown > 0}>
                    {sendingCode ? t('auth.sendingCode') : cooldown > 0 ? t('auth.resendIn', { s: cooldown }) : t('auth.sendCode')}
                  </button>
                </span>
              </div>
              {codeMsg && <p className={"auth-msg " + (codeOk ? 'auth-msg--ok' : '')}>{codeMsg}</p>}
              <p className="auth-note">{t('auth.emailHint')}</p>
            </>
          )}
          {msg && <p className={"auth-msg " + (msg === t('auth.registerOk') ? 'auth-msg--ok' : '')}>{msg}</p>}
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
