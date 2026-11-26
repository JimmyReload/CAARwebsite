import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, api } from './helpers/d1.mjs'

const worker = (await import('../src/worker.js')).default
const TOKEN = 'm'.repeat(32)

async function setup() {
  const env = makeEnv({ fullSchema: true })
  await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (1, ?, ?, ?, ?)')
    .bind('member', 'deadbeef:deadbeef', 'member', 'user').run()
  await env.SESSIONS.put('s:' + TOKEN, '1:0')
  return env
}

test('工单消息按 user 原子限流：窗口内仅放行 5 条，并安全复用唯一会话', async () => {
  const env = await setup()
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    api(worker, env, 'conversation/message', {
      method: 'POST', token: TOKEN, body: { content: '并发消息 ' + i }
    })
  ))
  assert.equal(results.filter((r) => r.status === 200).length, 5)
  assert.equal(results.filter((r) => r.status === 429).length, 15)
  assert.ok(results.filter((r) => r.status === 429).every((r) => r.body.error))
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id = 1').first()).n), 1)
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n), 5)

  await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (2, ?, ?, ?, ?)')
    .bind('member2', 'deadbeef:deadbeef', 'member2', 'user').run()
  const token2 = 'n'.repeat(32)
  await env.SESSIONS.put('s:' + token2, '2:0')
  const otherUser = await api(worker, env, 'conversation/message', {
    method: 'POST', token: token2, body: { content: '另一个用户的独立额度' }
  })
  assert.equal(otherUser.status, 200, 'user 维度的限额互不影响')
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n), 6)
})
