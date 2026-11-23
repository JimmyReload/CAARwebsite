// 客户端错误上报端点（/api/log/client）的来源校验
//
// 渗透测试 M-2 的剩余部分：该端点未认证即可写审计表，页面虽有"客户端上报"标签，
// 但仍应挡掉明显的跨站刷量。这里锁的是同源判断，以及"没有 Origin 时不误伤"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, ctx } from './helpers/d1.mjs'

const worker = (await import('../src/worker.js')).default

async function report(env, headers = {}) {
  const res = await worker.fetch(new Request('https://caar.test/api/log/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.77', ...headers },
    body: JSON.stringify({ message: 'boom', level: 'error' })
  }), env, ctx)
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

test('跨站 Origin 上报被拒（403），不写入审计表', async () => {
  const env = makeEnv({ fullSchema: true })
  const r = await report(env, { origin: 'https://evil.example' })
  assert.equal(r.status, 403)

  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_logs').all()
  assert.equal(Number(rows.results[0].n), 0, '被拒的上报不应落库')
})

test('同源 Origin 正常接受', async () => {
  const env = makeEnv({ fullSchema: true })
  const r = await report(env, { origin: 'https://caar.test' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
})

test('没有 Origin（非浏览器客户端/老浏览器）时不误伤，仍接受', async () => {
  const env = makeEnv({ fullSchema: true })
  const r = await report(env)
  assert.equal(r.status, 200, '去掉 Origin 一律拒绝会让真实错误上报整体失效')
})

test('畸形 Origin 不会被当成同源', async () => {
  const env = makeEnv({ fullSchema: true })
  const r = await report(env, { origin: 'not-a-url' })
  assert.equal(r.status, 403)
})
