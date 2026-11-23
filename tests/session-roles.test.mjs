// 会话与角色：登录之后这条路径此前完全没有测试覆盖
//
// 历史上与它相关的两个修复（"封禁即时生效"、"改密后旧会话失效"）都是先出问题再补的。
// 这些断言不依赖具体实现细节，只锁行为：会话有效/失效、封禁是否立刻踢下线、
// 非管理员能不能碰到管理端接口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv } from './helpers/d1.mjs'

const TOKEN = 'a'.repeat(32)
const ctx = { waitUntil() {}, passThroughOnException() {} }

async function addUser(env, { id, username, role = 'user', banned = 0, version = 0 }) {
  await env.DB.prepare(
    'INSERT INTO users (id, username, password, nickname, role, banned, session_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, username, 'deadbeef:deadbeef', username, role, banned, version).run()
}

async function call(worker, env, path, { token, method = 'GET' } = {}) {
  const headers = {}
  if (token) headers.cookie = 'caar_session=' + token
  const res = await worker.fetch(new Request('https://caar.test/api/' + path, { method, headers }), env, ctx)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, headers: res.headers }
}

const worker = (await import('../src/worker.js')).default

test('无 Cookie 访问 /api/me：返回空用户，不报错', async () => {
  const env = makeEnv({ fullSchema: true })
  const r = await call(worker, env, 'me')
  assert.equal(r.status, 200)
  assert.equal(r.body.user, null)
})

test('有效会话：返回用户信息，且不泄露口令哈希', async () => {
  const env = makeEnv({ fullSchema: true })
  await addUser(env, { id: 1, username: 'alice' })
  await env.SESSIONS.put('s:' + TOKEN, '1:0')

  const r = await call(worker, env, 'me', { token: TOKEN })
  assert.equal(r.body.user.id, 1)
  assert.equal(r.body.user.username, 'alice')
  assert.equal(r.body.user.role, 'user', 'role 必须与库中一致')
  assert.equal(r.body.user.password, undefined, '响应绝不能带出 password 字段')
})

test('降权即时生效：不依赖重新登录，下一个请求就按新角色判权限', async () => {
  const env = makeEnv({ fullSchema: true })
  await addUser(env, { id: 7, username: 'exadmin', role: 'admin' })
  await env.SESSIONS.put('s:' + TOKEN, '7:0')

  const before = await call(worker, env, 'admin/stats', { token: TOKEN })
  assert.equal(before.status, 200, '降权前应能进管理端')

  // 直接改库里的角色（等价于超管把他降回普通用户），会话不动
  await env.DB.prepare("UPDATE users SET role = 'user' WHERE id = 7").bind().run()

  const after = await call(worker, env, 'admin/stats', { token: TOKEN })
  assert.equal(after.status, 403, '角色每次都从库里读，降权应立刻生效')

  const me = await call(worker, env, 'me', { token: TOKEN })
  assert.equal(me.body.user.role, 'user')
})

test('封禁即时生效：会话仍在 KV 里，下一个请求就被踢下线', async () => {
  const env = makeEnv({ fullSchema: true })
  await addUser(env, { id: 2, username: 'bob', banned: 1 })
  await env.SESSIONS.put('s:' + TOKEN, '2:0')

  const r = await call(worker, env, 'me', { token: TOKEN })
  assert.equal(r.body.user, null, '封禁账号不应拿到用户信息')
  assert.equal(await env.SESSIONS.get('s:' + TOKEN), null, '顺手删掉会话，避免反复走库')
})

test('改密后旧会话失效：session_version 不一致即拒绝', async () => {
  const env = makeEnv({ fullSchema: true })
  await addUser(env, { id: 3, username: 'carol', version: 2 }) // 已改过一次密码
  await env.SESSIONS.put('s:' + TOKEN, '3:1')                   // 旧会话记的是版本 1

  const r = await call(worker, env, 'me', { token: TOKEN })
  assert.equal(r.body.user, null)
  assert.equal(await env.SESSIONS.get('s:' + TOKEN), null)
})

test('畸形令牌：不抛错，按未登录处理', async () => {
  const env = makeEnv({ fullSchema: true })
  await addUser(env, { id: 4, username: 'dave' })
  for (const bad of ['short', 'a'.repeat(32) + '=', 'a b'.repeat(20)]) {
    const r = await call(worker, env, 'me', { token: bad })
    assert.equal(r.status, 200, `畸形令牌 ${JSON.stringify(bad.slice(0, 8))} 不应导致 500`)
    assert.equal(r.body.user, null)
  }
})

test('管理端接口：普通用户 403，staff 可以访问', async () => {
  const env = makeEnv({ fullSchema: true })
  await addUser(env, { id: 5, username: 'member', role: 'user' })
  await addUser(env, { id: 6, username: 'staff', role: 'admin' })
  await env.SESSIONS.put('s:' + 'b'.repeat(32), '5:0')
  await env.SESSIONS.put('s:' + 'c'.repeat(32), '6:0')

  const denied = await call(worker, env, 'admin/stats', { token: 'b'.repeat(32) })
  assert.equal(denied.status, 403)
  assert.match(denied.body.error, /管理员/)

  const allowed = await call(worker, env, 'admin/stats', { token: 'c'.repeat(32) })
  assert.equal(allowed.status, 200, 'staff 应能看到统计')
})

test('API 响应带安全头与 no-store', async () => {
  const env = makeEnv({ fullSchema: true })
  const r = await call(worker, env, 'me')
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.match(r.headers.get('cache-control') || '', /no-store/)
})
