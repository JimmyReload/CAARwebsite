// 本地端到端冒烟：真 Worker + 真 D1(sqlite) + 假 PuzzleCat 上游
//
// tests/oauth.test.mjs 已经把每条分支锁住了；这个脚本只做一件事：
// 用和线上完全相同的调用顺序跑一遍「start → 上游授权 → callback → 已登录」，
// 并把每一步实际发出的请求打出来，便于人工核对协议细节。
//
// 用法：node scripts/smoke-oauth.mjs
import { makeEnv } from '../tests/helpers/d1.mjs'

const worker = (await import('../src/worker.js')).default
const ctx = { waitUntil() {}, passThroughOnException() {} }
const ORIGIN = 'https://caar.fun'

const env = {
  ...makeEnv({ fullSchema: true }),
  PUZZLECAT_CLIENT_ID: 'smoke_id',
  PUZZLECAT_CLIENT_SECRET: 'smoke_secret'
}

// 假上游：只实现 OAuth 三个端点
const seen = []
globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  const body = init.body ? JSON.parse(init.body) : null
  seen.push({ href, method: init.method || 'GET', body })
  const json = (o, status = 200) => new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json' }
  })
  if (href.endsWith('/api/oauth/token')) {
    return json({ access_token: 'smoke_at', refresh_token: 'smoke_rt', token_type: 'Bearer', expires_in: 7200 })
  }
  if (href.endsWith('/api/oauth/token/revoke')) return json({ ok: true })
  if (href.endsWith('/api/oauth/userinfo')) {
    return json({
      code: 200, message: 'success', timestamp: 1,
      data: { id: '9001', email: 'Smoke@Test.com', nickname: '冒烟', avatar: '', bio: '' }
    })
  }
  return json({ error: 'not_found' }, 404)
}

const step = (n, s) => console.log('\n[' + n + '] ' + s)

step(1, 'GET /api/oauth/config')
{
  const r = await worker.fetch(new Request(ORIGIN + '/api/oauth/config'), env, ctx)
  console.log('   ', r.status, await r.text())
}

step(2, 'GET /api/oauth/puzzlecat/start?next=/member')
let cookies = ''
let state = ''
{
  const r = await worker.fetch(new Request(ORIGIN + '/api/oauth/puzzlecat/start?next=%2Fmember'), env, ctx)
  console.log('   ', r.status, r.headers.get('location'))
  const jar = r.headers.getSetCookie()
  cookies = jar.map((c) => c.split(';')[0]).join('; ')
  state = (cookies.match(/caar_oauth_state=([^;]+)/) || [])[1]
  console.log('    cookies:', cookies)
}

step(3, '模拟用户在上游点「授权」→ 回调带 code + state')
{
  const url = ORIGIN + '/api/oauth/puzzlecat/callback?code=smoke_code&state=' + encodeURIComponent(state)
  const r = await worker.fetch(new Request(url, { headers: { cookie: cookies } }), env, ctx)
  console.log('   ', r.status, r.headers.get('location'))
  const session = (r.headers.getSetCookie().find((c) => c.startsWith('caar_session=')) || '').split(';')[0]
  console.log('    session cookie:', session.slice(0, 40) + '…')

  step(4, 'GET /api/me（用回调种下的会话）')
  const me = await worker.fetch(new Request(ORIGIN + '/api/me', { headers: { cookie: session } }), env, ctx)
  const body = await me.json()
  console.log('   ', me.status, JSON.stringify(body.user), 'notifUnread=' + body.notifUnread)
}

step(5, '上游实际收到的请求')
for (const c of seen) console.log('   ', c.method, c.href, c.body ? JSON.stringify(c.body) : '')

step(6, '库里的账号')
{
  const row = await env.DB.prepare('SELECT id, username, nickname, role, email, password FROM users').first()
  console.log('   ', JSON.stringify({ ...row, password: String(row.password).slice(0, 12) + '…' }))
}
