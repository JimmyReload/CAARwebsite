// 端到端：登录接口的限流行为（走真实 worker.fetch 路由）
//
// 单元测试证明了 SQL 的不变量，这里补的是"接线"——路由真的把 401 攒够 5 次
// 之后返回 429，而不是各自为政。第 6 轮审计里"20 并发放行 19 次"就是这类接线问题。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, postLogin } from './helpers/d1.mjs'

const IP = '198.51.100.23'

test('同一出口同一账号：前 5 次 401，第 6 次 429 并带 retry-after', async () => {
  const worker = (await import('../src/worker.js')).default
  const env = makeEnv()

  const seen = []
  for (let i = 0; i < 6; i++) {
    const r = await postLogin(worker, env, { username: 'nobody-here', password: 'wrong-password-1', ip: IP })
    seen.push(r.status)
  }
  assert.deepEqual(seen, [401, 401, 401, 401, 401, 429])

  const blocked = await postLogin(worker, env, { username: 'nobody-here', password: 'wrong-password-1', ip: IP })
  assert.equal(blocked.status, 429)
  assert.match(blocked.body.error, /尝试次数过多/, '应返回可读文案而不是裸 key')
  assert.ok(Number(blocked.retryAfter) > 0, '应带 retry-after 头')
})

test('同一出口换账号：账号维度仍独立计数', async () => {
  const worker = (await import('../src/worker.js')).default
  const env = makeEnv()

  for (let i = 0; i < 5; i++) {
    await postLogin(worker, env, { username: 'user-a', password: 'wrong-password-1', ip: IP })
  }
  // user-a 的第 6 次被组合键拦下
  const a6 = await postLogin(worker, env, { username: 'user-a', password: 'wrong-password-1', ip: IP })
  assert.equal(a6.status, 429)

  // 同一出口的另一个账号：主闸门是"出口+账号"，不该被 a 的手滑波及
  const b1 = await postLogin(worker, env, { username: 'user-b', password: 'wrong-password-1', ip: IP })
  assert.equal(b1.status, 401, '同网段其他账号不应被牵连（G-5）')
})
