// 登录"成功"路径——这条此前一个用例都没走过
//
// 变异测试暴露的空洞：G-1（成功登录时连 IP 计数一起清，超管可被无限爆破）
// 和 M-1（Cookie 缺 Secure/HttpOnly）都属于"登录成功之后"的回归，
// 而此前所有用例只走到 401，所以注入这两个 bug 测试全绿。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, postLogin, pbkdf2Hash, ctx } from './helpers/d1.mjs'

const IP = '203.0.113.50'
const worker = (await import('../src/worker.js')).default

async function seedUser(env, { id, username, password, role = 'user' }) {
  const hash = await pbkdf2Hash(password)
  await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .bind(id, username, hash, username, role).run()
}

const row = (env, key) => env.DB.prepare('SELECT * FROM login_fails WHERE key = ?').bind(key).first()

test('登录成功：签发可用会话，只清本人键，IP 计数保留（G-1）', async () => {
  const env = makeEnv({ fullSchema: true })
  const password = 'correct-horse-battery'
  await seedUser(env, { id: 1, username: 'alice', password })

  // 先攒三次失败，让三个键都有计数
  for (let i = 0; i < 3; i++) {
    const bad = await postLogin(worker, env, { username: 'alice', password: 'wrong-password-x', ip: IP })
    assert.equal(bad.status, 401)
  }

  const ok = await postLogin(worker, env, { username: 'alice', password, ip: IP })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)

  // 会话签发：Cookie 必须同时是 HttpOnly + Secure（M-1 的回归会被这几条抓住）
  assert.match(ok.setCookie, /caar_session=/)
  assert.match(ok.setCookie, /HttpOnly/)
  assert.match(ok.setCookie, /Secure/)
  assert.match(ok.setCookie, /SameSite=Lax/)
  assert.match(ok.setCookie, /Max-Age=\d+/)

  // 计数复位语义：只清"本人"的键
  assert.equal(await row(env, 'lf:ipu:' + IP + ':alice'), null, '组合键应被清掉')
  assert.equal(await row(env, 'lf:u:alice'), null, '账号键应被清掉')
  const ip = await row(env, 'lf:ip:' + IP)
  assert.ok(ip, 'IP 计数必须保留：清掉它，登录一次就成了攻击者的计数器重置开关（G-1）')
  assert.equal(Number(ip.n), 4, '3 次失败 + 1 次成功尝试，各记一次')

  // 会话真能用，且不泄露口令哈希
  const token = ok.setCookie.split(';')[0].split('=').slice(1).join('=')
  const me = await worker.fetch(new Request('https://caar.test/api/me', {
    headers: { cookie: 'caar_session=' + token }
  }), env, ctx)
  const meBody = await me.json()
  assert.equal(meBody.user.username, 'alice')
  assert.equal(meBody.user.password, undefined)
})

test('登录成功后清的是本人键，不影响同一出口的其他账号', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env, { id: 1, username: 'alice', password: 'alice-password-1' })
  await seedUser(env, { id: 2, username: 'bob', password: 'bob-password-1' })

  // bob 在同一出口留下失败计数
  await postLogin(worker, env, { username: 'bob', password: 'nope-nope-nope', ip: IP })
  const bobBefore = await row(env, 'lf:u:bob')
  assert.ok(bobBefore, 'bob 应有计数')

  const ok = await postLogin(worker, env, { username: 'alice', password: 'alice-password-1', ip: IP })
  assert.equal(ok.status, 200)

  const bobAfter = await row(env, 'lf:u:bob')
  assert.ok(bobAfter, 'alice 登录成功不能把 bob 的计数一起清掉')
  assert.equal(Number(bobAfter.n), Number(bobBefore.n))
})
