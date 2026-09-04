import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api'

export default function AuthView({ mode }) {
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
      await api(isLogin ? '/login' : '/register', { method: 'POST', body: { username, password, nickname } })
      if (isLogin) { nav('/member') } else { setMsg('注册成功，请登录'); setPassword('') }
    } catch (err) { setMsg(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <p className="auth-kicker">{isLogin ? 'MEMBER LOGIN' : 'JOIN US'}</p>
        <h1 className="auth-title">{isLogin ? '成员登录' : '申请入会'}</h1>
        <p className="auth-sub">{isLogin ? '欢迎回来，继续解谜。' : '开放注册——读完《入会协定》即可申请。'}</p>
        <form onSubmit={submit} className="auth-form">
          {!isLogin && (
            <label>昵称（选填）
              <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="怎么称呼你" maxLength="20" />
            </label>
          )}
          <label>用户名
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="2-20 位，中文/字母/数字/下划线" maxLength="20" required />
          </label>
          <label>密码
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" minLength="6" required />
          </label>
          {msg && <p className="auth-msg">{msg}</p>}
          <button className="auth-btn" disabled={busy}>{busy ? '处理中…' : (isLogin ? '登录' : '注册')}</button>
        </form>
        <p className="auth-alt">
          {isLogin ? (
            <span>还没有账号？<Link to="/register">申请入会</Link></span>
          ) : (
            <span>已有账号？<Link to="/login">直接登录</Link></span>
          )}
          <Link to="/">← 返回首页</Link>
        </p>
      </div>
    </div>
  )
}
