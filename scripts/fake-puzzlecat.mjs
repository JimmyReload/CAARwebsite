// 本地假 PuzzleCat 上游，只为在浏览器里跑通完整登录回跳
// 用法：node scripts/fake-puzzlecat.mjs [port]
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] || 8791)
const LOG = process.argv[3] || ''
const PROFILE = { id: '4242', email: 'Smoke@Browser.test', nickname: '冒烟用户', avatar: '', bio: '' }
const log = (line) => { if (LOG) { try { appendFileSync(LOG, line + '\n') } catch { /* ignore */ } } }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port)
  console.log('[fake] ' + req.method + ' ' + url.pathname + url.search)
  log(req.method + ' ' + url.pathname + url.search)
  const json = (o, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(o))
  }
  if (url.pathname === '/oauth/authorize') {
    // 模拟用户点了「授权」：直接带 code + 原样带回 state 跳回回调地址
    const redirect = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const back = new URL(redirect)
    back.searchParams.set('code', 'fake_code_1')
    back.searchParams.set('state', state)
    res.writeHead(302, { location: back.toString() })
    return res.end()
  }
  if (url.pathname === '/api/oauth/token') {
    return json({ access_token: 'fake_at', refresh_token: 'fake_rt', token_type: 'Bearer', expires_in: 7200 })
  }
  if (url.pathname === '/api/oauth/token/revoke') return json({ ok: true })
  if (url.pathname === '/api/oauth/userinfo') {
    return json({ code: 200, message: 'success', data: PROFILE, timestamp: 1 })
  }
  json({ error: 'not_found' }, 404)
})
server.listen(port, '127.0.0.1', () => console.log('fake puzzlecat on http://127.0.0.1:' + port))