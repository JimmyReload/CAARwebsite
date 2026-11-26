// F-01 / F-06 回归：带 Cookie 的写操作 CSRF 闸门 + 按实际读取字节的 64 KiB 上限
//
// 覆盖的约定（改代码前失败、改后通过）：
//   · 同源 Origin + JSON 正文的 Cookie 写请求放行（本站前端的真实请求形态）
//   · 同站恶意子域 / 缺失 Origin / 'null' Origin / 异协议一律 403
//   · text/plain（浏览器可不经预检发出的简单请求）与非 JSON 正文 415
//   · 无正文的写请求（前端 POST /logout 不带 body 与 content-type）仍然放行
//   · GET 与匿名流程（登录/注册/验证码）不受闸门影响
//   · 64 KiB 按实际读取字节判定：刚好 65536 放行、65537 拒绝、
//     没有 Content-Length 的 100049 字节流被 413 拒绝，畸形 JSON 400、空正文按 {} 处理
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv } from './helpers/d1.mjs'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const worker = (await import('../src/worker.js')).default
const BASE = 'https://caar.test'
const TOKEN = 'c'.repeat(32)

async function seedUser(env, { id = 1, username = 'alice', role = 'user' } = {}) {
  await env.DB.prepare(
    'INSERT INTO users (id, username, password, nickname, role, banned, session_version) VALUES (?, ?, ?, ?, ?, 0, 0)'
  ).bind(id, username, 'deadbeef:deadbeef', username, role).run()
  await env.SESSIONS.put('s:' + TOKEN, id + ':0')
}

function req(path, { method = 'POST', headers = {}, body } = {}) {
  return new Request(BASE + '/api/' + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  })
}

async function call(env, request) {
  const res = await worker.fetch(request, env, ctx)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text }
}

async function nickname(env, id = 1) {
  const row = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(id).first()
  return row ? row.nickname : null
}

// ---------------------------------------------------------------- CSRF 闸门

test('同源 Origin + JSON：放行并真正落库', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const r = await call(env, req('profile', {
    method: 'PATCH',
    headers: { cookie: 'caar_session=' + TOKEN, origin: BASE, 'content-type': 'application/json' },
    body: { nickname: '新昵称' }
  }))
  assert.equal(r.status, 200)
  assert.equal(await nickname(env), '新昵称')
})

test('同站恶意子域 Origin 被拒（403），且不产生副作用', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  // 审计 F-01 的 PoC 形态：子域 + text/plain 伪装 JSON
  const r = await call(env, req('profile', {
    method: 'PATCH',
    headers: { cookie: 'caar_session=' + TOKEN, origin: 'https://attacker.caar.fun', 'content-type': 'text/plain' },
    body: { nickname: '被篡改' }
  }))
  assert.equal(r.status, 403)
  assert.equal(await nickname(env), 'alice', '被拒的请求不得写入')
})

test('缺失 Origin 的 Cookie 写请求被拒（403）', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const r = await call(env, req('profile', {
    method: 'PATCH',
    headers: { cookie: 'caar_session=' + TOKEN, 'content-type': 'application/json' },
    body: { nickname: '无来源' }
  }))
  assert.equal(r.status, 403, '不允许"没有 Origin 就当安全"的推断')
  assert.equal(await nickname(env), 'alice')
})

test("Origin: 'null' / 异协议 Origin 被拒（403）", async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  for (const origin of ['null', 'http://caar.test', 'https://caar.test:8443']) {
    const r = await call(env, req('profile', {
      method: 'PATCH',
      headers: { cookie: 'caar_session=' + TOKEN, origin, 'content-type': 'application/json' },
      body: { nickname: 'x' }
    }))
    assert.equal(r.status, 403, origin + ' 必须被拒')
  }
  assert.equal(await nickname(env), 'alice')
})

test('同源但 text/plain 正文被拒（415）：不允许浏览器简单请求伪装 JSON', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const r = await call(env, req('profile', {
    method: 'PATCH',
    headers: { cookie: 'caar_session=' + TOKEN, origin: BASE, 'content-type': 'text/plain' },
    body: JSON.stringify({ nickname: '伪装' })
  }))
  assert.equal(r.status, 415)
  assert.equal(await nickname(env), 'alice')
})

test('同源但缺失 Content-Type 的带正文请求被拒（415）', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const r = await call(env, req('profile', {
    method: 'PATCH',
    headers: { cookie: ['caar', 'session'].join('_') + '=' + TOKEN, origin: BASE },
    body: JSON.stringify({ nickname: '无类型' })
  }))
  assert.equal(r.status, 415)
})

test('Content-Length: 0 不能掩盖实际存在的 text/plain 正文', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const request = new Request(BASE + '/api/profile', {
    method: 'PATCH',
    headers: {
      cookie: 'caar_session=' + TOKEN,
      origin: BASE,
      'content-type': 'text/plain',
      'content-length': '0'
    },
    body: JSON.stringify({ nickname: '绕过长度提示' })
  })
  assert.equal(request.headers.get('content-length'), '0')
  assert.ok(request.body, '请求实际携带了正文流')
  const r = await call(env, request)
  assert.equal(r.status, 415, '实际 body 流存在时必须进行 Content-Type 检查')
  assert.equal(await nickname(env), 'alice')
})

test('无正文的 Cookie 写请求（前端 POST /logout 的形态）仍放行', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const r = await call(env, req('logout', {
    method: 'POST',
    headers: { cookie: 'caar_session=' + TOKEN, origin: BASE }
  }))
  assert.equal(r.status, 200)
  assert.equal(await env.SESSIONS.get('s:' + TOKEN), null, '登出必须真的删掉会话')
})

test('GET 与匿名流程不受 CSRF 闸门影响', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  // 读操作：带 Cookie 也不要求 Origin（浏览器顶层导航/图片请求本来就没有 Origin）
  const me = await call(env, req('me', {
    method: 'GET',
    headers: { cookie: 'caar_session=' + TOKEN }
  }))
  assert.equal(me.status, 200)

  // 匿名写流程：登录接口没有 Cookie，缺 Origin 也必须能继续走业务校验
  const login = await call(env, req('login', {
    headers: { 'content-type': 'application/json' },
    body: { username: 'alice', password: 'wrong-password' }
  }))
  assert.equal(login.status, 401, '应继续走口令校验而不是被 CSRF 闸门拦成 403')
})

// ---------------------------------------------------------------- 正文上限

test('64 KiB 边界：刚好 65536 字节放行，65537 字节 413', async () => {
  const env = makeEnv({ fullSchema: true })
  const exact = '{"pad":"' + 'a'.repeat(65536 - 10) + '"}'
  assert.equal(Buffer.byteLength(exact), 65536)
  const ok = await call(env, req('login', {
    headers: { 'content-type': 'application/json' },
    body: exact
  }))
  assert.notEqual(ok.status, 413, '刚好等于上限不该被拒')
  assert.equal(ok.status, 401)

  const over = '{"pad":"' + 'a'.repeat(65537 - 10) + '"}'
  assert.equal(Buffer.byteLength(over), 65537)
  const tooBig = await call(env, req('login', {
    headers: { 'content-type': 'application/json' },
    body: over
  }))
  assert.equal(tooBig.status, 413)
  assert.match(String(tooBig.json && tooBig.json.error), /过大/)
})

test('没有 Content-Length 的 100049 字节流式正文也得到 413（F-06 核心）', async () => {
  const env = makeEnv({ fullSchema: true })
  const payload = '{"pad":"' + 'a'.repeat(100049 - 10) + '"}'
  assert.equal(Buffer.byteLength(payload), 100049)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    }
  })
  const request = new Request(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half'
  })
  assert.equal(request.headers.get('content-length'), null, '前提：这个请求确实没有 Content-Length')
  const r = await call(env, request)
  assert.equal(r.status, 413, '只能靠实际读取字节数拦住')
})

test('合法 JSON null、数组与标量根值统一返回 400 badParams', async () => {
  const env = makeEnv({ fullSchema: true })
  for (const body of ['null', '[]', 'true', '42', '"text"']) {
    const r = await call(env, req('login', {
      headers: { 'content-type': 'application/json' }, body
    }))
    assert.equal(r.status, 400, body + ' 必须按 badParams 拒绝')
    assert.match(String(r.json && r.json.error), /参数不完整/)
  }
})

test('畸形 JSON 返回 400，空正文按 {} 处理', async () => {
  const env = makeEnv({ fullSchema: true })
  const broken = await call(env, req('login', {
    headers: { 'content-type': 'application/json' },
    body: '{"username":'
  }))
  assert.equal(broken.status, 400)

  const empty = await call(env, req('login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  }))
  assert.equal(empty.status, 401, '空正文按 {} 解析后继续业务校验')
})

test('GET /inbox 只读，显式同源 JSON POST /inbox/read 才推进成员已读位', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const cr = await env.DB.prepare('INSERT INTO conversations (user_id) VALUES (1)').run()
  const convId = cr.meta.last_row_id
  await env.DB.prepare("INSERT INTO messages (conv_id, sender_id, direction, content) VALUES (?, 9, 'to_user', '客服回复 1')").bind(convId).run()
  await env.DB.prepare("INSERT INTO messages (conv_id, sender_id, direction, content) VALUES (?, 9, 'to_user', '客服回复 2')").bind(convId).run()
  const before = await env.DB.prepare('SELECT user_last_read_id FROM conversations WHERE id = ?').bind(convId).first()
  assert.equal(Number(before.user_last_read_id), 0)

  for (const url of ['/api/inbox', '/api/inbox?after=0', '/api/inbox?after=1']) {
    const get = await call(env, new Request(BASE + url, { headers: { cookie: 'caar_session=' + TOKEN } }))
    assert.equal(get.status, 200)
    const current = await env.DB.prepare('SELECT user_last_read_id FROM conversations WHERE id = ?').bind(convId).first()
    assert.equal(Number(current.user_last_read_id), 0, 'GET 不得推进已读游标')
  }

  const marked = await call(env, req('inbox/read', {
    headers: { cookie: 'caar_session=' + TOKEN, origin: BASE, 'content-type': 'application/json' },
    body: { last_id: 1 }
  }))
  assert.equal(marked.status, 200)
  const after = await env.DB.prepare('SELECT user_last_read_id FROM conversations WHERE id = ?').bind(convId).first()
  assert.equal(Number(after.user_last_read_id), 1, '只能推进到确认看到的消息，不能跨过未查看的新回复')
})

test('inbox/read 要求同源 Origin + JSON，非法游标返回 400', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  for (const headers of [
    { cookie: 'caar_session=' + TOKEN, 'content-type': 'application/json' },
    { cookie: 'caar_session=' + TOKEN, origin: 'https://attacker.test', 'content-type': 'application/json' }
  ]) {
    const r = await call(env, req('inbox/read', { headers, body: { last_id: 1 } }))
    assert.equal(r.status, 403)
  }
  const bad = await call(env, req('inbox/read', {
    headers: { cookie: 'caar_session=' + TOKEN, origin: BASE, 'content-type': 'application/json' },
    body: { last_id: 'invalid' }
  }))
  assert.equal(bad.status, 400)
})

test('正文流读取失败按客户端错误 400 处理，不落成 500', async () => {
  const env = makeEnv({ fullSchema: true })
  const stream = new ReadableStream({
    start(controller) { controller.error(new Error('read boom')) }
  })
  const request = new Request(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half'
  })
  const r = await call(env, request)
  assert.equal(r.status, 400)
})
