// M-2 的日预算与管理端折叠
//
// 客户端上报未认证、内容可控，所以：① 默认不进审计主列表；② 全局日上限后只进控制台。
// 这里锁住这两条，避免以后有人"顺手把 client.error 加回默认列表"或删掉闸门。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, api, ctx } from './helpers/d1.mjs'
import { resetClientDayGate } from '../src/log.js'

const worker = (await import('../src/worker.js')).default
const ADMIN = 'a'.repeat(32)

async function seedAdmin(env) {
  await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .bind(1, 'admin1', 'deadbeef:deadbeef', 'admin1', 'admin').run()
  await env.SESSIONS.put('s:' + ADMIN, '1:0')
}

async function report(env, message = 'boom') {
  const res = await worker.fetch(new Request('https://caar.test/api/log/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.90', origin: 'https://caar.test' },
    body: JSON.stringify({ message, level: 'error' })
  }), env, ctx)
  return res.status
}

const countClient = async (env) => Number(
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'client.error'").all()).results[0].n
)

test('未达日上限：正常落库并带 source=client', async () => {
  resetClientDayGate()
  const env = makeEnv({ fullSchema: true })
  assert.equal(await report(env), 200)
  const row = await env.DB.prepare("SELECT meta FROM audit_logs WHERE event = 'client.error'").first()
  assert.ok(row, '应有记录')
  assert.equal(JSON.parse(row.meta).source, 'client', '必须带来源标记，管理端据此灰底与折叠')
})

test('达到日上限：不再落库，但请求仍返回 200（不影响页面）', async () => {
  resetClientDayGate()
  const env = makeEnv({ fullSchema: true })
  // 直接把当天额度写满（2000 行），比发 2000 次请求快得多
  env.DB._raw.exec(`INSERT INTO audit_logs (ts, level, event, ip, meta)
    SELECT ${Date.now()}, 'error', 'client.error', '198.51.100.1', '{"source":"client"}'
    FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000) SELECT x FROM c)`)

  const before = await countClient(env)
  assert.equal(before, 2000)

  assert.equal(await report(env, 'flood'), 200, '超限只丢日志，不能把错误上报变成失败')
  assert.equal(await countClient(env), 2000, '超出上限后不能再写 D1')
})

test('管理端默认折叠客户端上报，显式 client=all 才出现', async () => {
  resetClientDayGate()
  const env = makeEnv({ fullSchema: true })
  await seedAdmin(env)
  await report(env, 'client-side-oops')
  await env.DB.prepare("INSERT INTO audit_logs (ts, level, event, ip, meta) VALUES (?, 'info', 'auth.login.ok', '', '{}')")
    .bind(Date.now()).run()

  const def = await api(worker, env, 'admin/logs', { token: ADMIN })
  assert.equal(def.status, 200)
  assert.ok(def.body.list.length >= 1)
  assert.equal(def.body.list.some((r) => r.event === 'client.error'), false, '默认列表不应混入客户端自述')
  assert.ok(def.body.list.some((r) => r.event === 'auth.login.ok'), '事实性记录仍应可见')

  const withClient = await api(worker, env, 'admin/logs?client=all', { token: ADMIN })
  assert.equal(withClient.body.list.some((r) => r.event === 'client.error'), true)

  const onlyClient = await api(worker, env, 'admin/logs?client=only', { token: ADMIN })
  assert.equal(onlyClient.body.list.every((r) => r.event === 'client.error'), true)
})
