// PuzzleCat OAuth 登录：整条授权码流程的行为锁
//
// 这里不连真上游：把全局 fetch 换成假服务，测的是「我们这一侧」的协议正确性与安全边界——
// state 校验、授权码换令牌、账号绑定/首登建号、封禁与拒绝分支、令牌用完即撤销。
// 上游契约（错误体形状、data 包装）来自 2026-11-23 实测：
//   POST /api/oauth/token     失败 → { error, error_description }
//   GET  /api/oauth/userinfo  失败 → { code, message, data: null, timestamp }
//                             成功 → { code: 200, data: { id, email, nickname, avatar, bio } }
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv } from './helpers/d1.mjs'
import {
  authorizeUrl, redirectUri, safeNext, usernameSeed, usernameCandidate,
  makeOauthOnlyPassword, isOauthOnly, exchangeCode, fetchUserinfo
} from '../src/oauth.js'

const worker = (await import('../src/worker.js')).default
const ctx = { waitUntil() {}, passThroughOnException() {} }

const ENV_OAUTH = {
  PUZZLECAT_CLIENT_ID: 'app_test_id',
  PUZZLECAT_CLIENT_SECRET: 'app_test_secret'
}

/* ---------- 假上游 ---------- */

// 记录每次调用的 { url, method, body, headers }，用于断言"我们发了什么"
function fakeUpstream({ profile, tokenError = null, userinfoStatus = 200, userinfoBody = null } = {}) {
  const calls = []
  const fn = async (url, init = {}) => {
    const href = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: href, method: init.method || 'GET', body, headers: init.headers || {} })

    if (href.includes('/api/oauth/token/revoke')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/api/oauth/token')) {
      if (tokenError) {
        return new Response(JSON.stringify({ error: tokenError, error_description: 'x' }), {
          status: tokenError === 'invalid_client' ? 401 : 400,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        access_token: 'at_1', refresh_token: 'rt_1', token_type: 'Bearer', expires_in: 7200
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/api/oauth/userinfo')) {
      if (userinfoBody) {
        return new Response(JSON.stringify(userinfoBody), {
          status: userinfoStatus, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        code: 200, message: 'success', data: profile, timestamp: 1700000000
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }
  return { fn, calls }
}

// 在 withUpstream 期间替换全局 fetch
async function withUpstream(up, run) {
  const orig = globalThis.fetch
  globalThis.fetch = up.fn
  try { return await run() } finally { globalThis.fetch = orig }
}

function oauthEnv(extra = {}) {
  return { ...makeEnv({ fullSchema: true }), ...ENV_OAUTH, ...extra }
}

async function start(env, { next = '/account' } = {}) {
  const res = await worker.fetch(new Request(
    'https://caar.fun/api/oauth/puzzlecat/start?next=' + encodeURIComponent(next)
  ), env, ctx)
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const state = (cookies.join(';').match(/caar_oauth_state=([^;]+)/) || [])[1]
  return { res, state, cookies: cookies.join('; ') }
}

async function callback(env, { state, code = 'authcode_1', cookies = '', error = '' }) {
  const q = new URLSearchParams()
  if (code) q.set('code', code)
  if (state) q.set('state', state)
  if (error) q.set('error', error)
  const res = await worker.fetch(new Request(
    'https://caar.fun/api/oauth/puzzlecat/callback?' + q.toString(),
    { headers: cookies ? { cookie: cookies } : {} }
  ), env, ctx)
  return { res, location: res.headers.get('location') || '', setCookie: res.headers.get('set-cookie') || '' }
}

/* ---------- 纯函数 ---------- */

test('safeNext 只放行站内相对路径', () => {
  assert.equal(safeNext('/account'), '/account')
  assert.equal(safeNext('/member?x=1'), '/member?x=1')
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'account', '', '  /a b', 'javascript:alert(1)']) {
    assert.equal(safeNext(bad), '/account', JSON.stringify(bad) + ' 必须被拒')
  }
})

test('OAuth 占位口令格式合法且不可推导', () => {
  const pw = makeOauthOnlyPassword()
  assert.ok(isOauthOnly(pw))
  // 登录按 "<saltHex>:<hashHex>" 拆分：占位值不能含冒号，否则会把 hash 解析成空串
  assert.equal(pw.indexOf(':'), -1, '占位值不能含冒号，否则登录时 salt/hash 拆分错位')
  assert.match(pw, /^oauth\$[0-9a-f]{64}$/)
  assert.notEqual(makeOauthOnlyPassword(), pw, '每次都必须不同')
})

test('用户名推导：昵称 → 邮箱前缀 → pc<id>，并守住 2-20 码点', () => {
  assert.equal(usernameSeed({ nickname: '缪月', email: 'a@b.c', id: '9' }), '缪月')
  assert.equal(usernameSeed({ nickname: 'a', email: 'alice@b.c', id: '9' }), 'alice', '昵称太短时用邮箱前缀')
  assert.equal(usernameSeed({ nickname: '', email: 'x@b.c', id: '1024' }), 'pc1024')
  // 非法字符被清掉：用户名只允许中文/字母/数字/下划线
  assert.equal(usernameSeed({ nickname: 'a b!c-d', email: '', id: '1' }), 'abcd')
  const long = usernameCandidate('x'.repeat(40), 1)
  assert.equal([...long].length, 20)
  assert.equal(usernameCandidate('x'.repeat(40), 12), 'x'.repeat(17) + '_12', '后缀必须挤进 20 码点内')
})

test('authorizeUrl 带齐上游要求的参数', () => {
  const u = new URL(authorizeUrl(ENV_OAUTH, { redirect: 'https://caar.fun/cb', state: 's1' }))
  assert.equal(u.origin + u.pathname, 'https://puzzle.cat/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), 'app_test_id')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('scope'), 'profile')
  assert.equal(u.searchParams.get('state'), 's1')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://caar.fun/cb')
  // 上游未定义 PKCE：多送 code_challenge 反而会被严格校验拒绝
  assert.equal(u.searchParams.get('code_challenge'), null)
})

test('redirectUri 默认按站点推导，可用变量覆盖', () => {
  assert.equal(
    redirectUri(ENV_OAUTH, 'https://caar.fun/api/oauth/puzzlecat/start'),
    'https://caar.fun/api/oauth/puzzlecat/callback'
  )
  assert.equal(
    redirectUri({ ...ENV_OAUTH, PUZZLECAT_REDIRECT_URI: 'https://x.test/cb' }, 'https://caar.fun/a'),
    'https://x.test/cb'
  )
})

/* ---------- 上游客户端 ---------- */

test('exchangeCode 成功取到 access_token；失败带上游 error 码', async () => {
  const up = fakeUpstream()
  await withUpstream(up, async () => {
    const t = await exchangeCode(ENV_OAUTH, { code: 'c1', redirect: 'https://caar.fun/cb' })
    assert.equal(t.access_token, 'at_1')
  })
  assert.equal(up.calls[0].url, 'https://puzzle.cat/api/oauth/token')
  assert.equal(up.calls[0].body.grant_type, 'authorization_code')
  assert.equal(up.calls[0].body.redirect_uri, 'https://caar.fun/cb')
  assert.equal(up.calls[0].body.client_secret, 'app_test_secret', '机密客户端必须带 secret')

  const bad = fakeUpstream({ tokenError: 'invalid_grant' })
  await withUpstream(bad, async () => {
    await assert.rejects(
      () => exchangeCode(ENV_OAUTH, { code: 'c1', redirect: 'https://caar.fun/cb' }),
      (err) => err.code === 'invalid_grant'
    )
  })
})

test('fetchUserinfo 解上游统一包装；403 归为 access_denied', async () => {
  const up = fakeUpstream({ profile: { id: 7, email: 'A@B.com', nickname: '缪月', avatar: 'x', bio: 'b' } })
  await withUpstream(up, async () => {
    const p = await fetchUserinfo(ENV_OAUTH, 'at_1')
    assert.equal(p.id, '7')
    assert.equal(p.email, 'a@b.com', '邮箱必须归一化为小写，否则会建出两个账号')
    assert.equal(p.nickname, '缪月')
  })
  assert.equal(up.calls[0].headers.authorization, 'Bearer at_1')

  // 上游失败形状：code/data 包装，不是 error 字段
  const denied = fakeUpstream({ userinfoBody: { code: 403, message: '账号已被禁用', data: null }, userinfoStatus: 403 })
  await withUpstream(denied, async () => {
    await assert.rejects(() => fetchUserinfo(ENV_OAUTH, 'at_1'), (err) => err.code === 'access_denied')
  })
})

/* ---------- 端点 ---------- */

test('未配置凭据：/oauth/config 回 false，start 直接 503 且不跳外站', async () => {
  const env = makeEnv({ fullSchema: true })
  const cfg = await worker.fetch(new Request('https://caar.fun/api/oauth/config'), env, ctx)
  assert.equal((await cfg.json()).puzzlecat, false)

  const res = await worker.fetch(new Request('https://caar.fun/api/oauth/puzzlecat/start'), env, ctx)
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('location'), null)
})

test('start：302 到授权页，state 落 HttpOnly Cookie 且不回显在跳转里以外的地方', async () => {
  const env = oauthEnv()
  const { res, state, cookies } = await start(env, { next: '/member' })
  assert.equal(res.status, 302)
  const loc = new URL(res.headers.get('location'))
  assert.equal(loc.origin + loc.pathname, 'https://puzzle.cat/oauth/authorize')
  assert.equal(loc.searchParams.get('state'), state)
  assert.ok(state && state.length >= 20, 'state 必须足够长')
  assert.match(cookies, /caar_oauth_state=[^;]+/, 'state 必须写进 Cookie')
  assert.match(cookies, /HttpOnly/i)
  assert.match(cookies, /SameSite=Lax/i, '回跳是同站顶层导航，Lax 才带得上')
  assert.match(cookies, /caar_oauth_next=%2Fmember/)
})

test('callback：state 不匹配/缺失一律拒绝，且不发起任何上游请求', async () => {
  const env = oauthEnv()
  const up = fakeUpstream({ profile: { id: 1, email: 'a@b.com', nickname: 'a' } })
  await withUpstream(up, async () => {
    // 没有 Cookie（或没有 state）
    const noCookie = await callback(env, { state: 'abc' })
    assert.match(noCookie.location, /oauth=state/)
    // Cookie 里有 state，但回调带来的不一样
    const mismatch = await callback(env, { state: 'other', cookies: 'caar_oauth_state=expected' })
    assert.match(mismatch.location, /oauth=state/)
  })
  assert.equal(up.calls.length, 0, 'state 没过就不该去换令牌')
  // 失败也要清 Cookie，避免下一次登录沿用旧 state
  const clear = await callback(env, { state: 'x', cookies: 'caar_oauth_state=y' })
  assert.match(clear.res.headers.get('set-cookie') || '', /Max-Age=0/i)
})

test('callback：用户拒绝授权 → 归到 denied，不换令牌', async () => {
  const env = oauthEnv()
  const up = fakeUpstream()
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s', code: '', error: 'access_denied' })
    assert.match(r.location, /oauth=denied/)
  })
  assert.equal(up.calls.length, 0)
})

test('首登建号：邮箱不存在 → 建号 + 会话 Cookie + 撤销令牌', async () => {
  const env = oauthEnv()
  const up = fakeUpstream({ profile: { id: 42, email: 'New@Example.com', nickname: '新人', avatar: '', bio: '' } })
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s; caar_oauth_next=%2Faccount' })
    assert.equal(r.res.status, 302)
    assert.match(r.location, /^\/\?oauth=ok#\/account$/)
    assert.match(r.setCookie, /caar_session=[^;]+/, '必须种下会话 Cookie')

    const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('new@example.com').first()
    assert.ok(row, '邮箱归一化后建号')
    assert.equal(row.nickname, '新人')
    assert.equal(row.role, 'user')
    assert.ok(isOauthOnly(row.password), '首登账号必须标记为"未设口令"')
  })
  // 上游调用顺序：token → userinfo → revoke（用完即撤销，本站不长期持有凭据）
  const urls = up.calls.map((c) => c.url)
  assert.equal(urls.length, 3)
  assert.match(urls[0], /\/api\/oauth\/token$/)
  assert.match(urls[1], /\/api\/oauth\/userinfo$/)
  assert.match(urls[2], /\/api\/oauth\/token\/revoke$/)
  assert.equal(up.calls[2].body.token, 'at_1')
})

test('二次登录：同邮箱命中已有账号，不重复建号，昵称不被上游覆盖', async () => {
  const env = oauthEnv()
  await env.DB.prepare('INSERT INTO users (username, password, nickname, role, email) VALUES (?, ?, ?, ?, ?)')
    .bind('local', 'deadbeef:deadbeef', '站内昵称', 'user', 'same@example.com').run()

  const up = fakeUpstream({ profile: { id: 42, email: 'same@example.com', nickname: '上游昵称' } })
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s' })
    assert.match(r.location, /oauth=ok/)
  })
  const rows = (await env.DB.prepare('SELECT id, username, nickname FROM users').all()).results
  assert.equal(rows.length, 1, '同邮箱不应建第二个账号')
  assert.equal(rows[0].nickname, '站内昵称', 'OAuth 只用来认人，不改站内资料')
})

test('封禁账号不能借 OAuth 绕过封禁', async () => {
  const env = oauthEnv()
  await env.DB.prepare('INSERT INTO users (username, password, nickname, role, banned, email) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('banned', 'deadbeef:deadbeef', 'b', 'user', 1, 'b@example.com').run()

  const up = fakeUpstream({ profile: { id: 5, email: 'b@example.com', nickname: 'b' } })
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s' })
    assert.match(r.location, /oauth=banned/)
    assert.equal(r.setCookie.indexOf('caar_session='), -1, '被封禁就不该拿到会话')
  })
})

test('上游没有邮箱：不建号，避免每次登录都新建一个', async () => {
  const env = oauthEnv()
  const up = fakeUpstream({ profile: { id: 8, email: '', nickname: '无邮箱' } })
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s' })
    assert.match(r.location, /oauth=noemail/)
  })
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n
  assert.equal(Number(n), 0)
})

test('令牌交换失败：归到 failed，不建号、不发会话', async () => {
  const env = oauthEnv()
  const up = fakeUpstream({ tokenError: 'invalid_grant' })
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s' })
    assert.match(r.location, /oauth=failed/)
    assert.equal(r.setCookie.indexOf('caar_session='), -1)
  })
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n
  assert.equal(Number(n), 0)
})

test('用户名冲突时顺延，且不超长', async () => {
  const env = oauthEnv()
  await env.DB.prepare('INSERT INTO users (username, password, nickname, role, email) VALUES (?, ?, ?, ?, ?)')
    .bind('新人', 'deadbeef:deadbeef', 'x', 'user', 'other@example.com').run()

  const up = fakeUpstream({ profile: { id: 99, email: 'fresh@example.com', nickname: '新人' } })
  await withUpstream(up, async () => {
    await callback(env, { state: 's', cookies: 'caar_oauth_state=s' })
  })
  const row = await env.DB.prepare('SELECT username FROM users WHERE email = ?').bind('fresh@example.com').first()
  assert.equal(row.username, '新人_2')
})

test('OAuth 建的账号可以用「设口令」把密码补上（占位值不是有效口令）', async () => {
  const env = oauthEnv()
  const up = fakeUpstream({ profile: { id: 3, email: 'setpw@example.com', nickname: 'setpw' } })
  let token = ''
  await withUpstream(up, async () => {
    const r = await callback(env, { state: 's', cookies: 'caar_oauth_state=s' })
    token = (r.setCookie.match(/caar_session=([^;]+)/) || [])[1]
  })
  assert.ok(token)

  // 占位口令无法用于登录：任何口令都不该匹配
  const login = await worker.fetch(new Request('https://caar.fun/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'setpw', password: 'oauth:' + '0'.repeat(64) })
  }), env, ctx)
  assert.equal(login.status, 401, '占位口令必须不能登录')

  // 已登录用户设口令：不需要旧密码（旧密码根本不存在），但要挡住"给已有口令的账号重置"
  // 带 Cookie 的写操作受 CSRF 闸门约束：必须显式带精确同源 Origin + JSON 正文
  const set = await worker.fetch(new Request('https://caar.fun/api/password/set', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://caar.fun', cookie: 'caar_session=' + token },
    body: JSON.stringify({ new_password: 'a-good-passphrase' })
  }), env, ctx)
  assert.equal(set.status, 200)
  const after = await worker.fetch(new Request('https://caar.fun/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'setpw', password: 'a-good-passphrase' })
  }), env, ctx)
  assert.equal(after.status, 200, '设过口令后应能用密码登录')
})
