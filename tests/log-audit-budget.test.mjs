// M-2 的日预算与管理端折叠
//
// 客户端上报未认证、内容可控，所以：① 默认不进审计主列表；② 全局日上限后只进控制台。
// 这里锁住这两条，避免以后有人"顺手把 client.error 加回默认列表"或删掉闸门。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, api } from './helpers/d1.mjs'
import { audit } from '../src/log.js'

const worker = (await import('../src/worker.js')).default
const ADMIN = 'a'.repeat(32)

async function seedAdmin(env) {
  await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .bind(1, 'admin1', 'deadbeef:deadbeef', 'admin1', 'admin').run()
  await env.SESSIONS.put('s:' + ADMIN, '1:0')
}

async function report(env, message = 'boom') {
  const pending = []
  const res = await worker.fetch(new Request('https://caar.test/api/log/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.90', origin: 'https://caar.test' },
    body: JSON.stringify({ message, level: 'error' })
  }), env, { waitUntil(promise) { pending.push(promise) } })
  // Worker returns before waitUntil work; explicitly settle it before asserting DB state.
  await Promise.all(pending)
  return res.status
}

const countClient = async (env) => Number(
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'client.error'").all()).results[0].n
)

test('未达日上限：正常落库并带 source=client', async () => {
  const env = makeEnv({ fullSchema: true })
  assert.equal(await report(env), 200)
  const row = await env.DB.prepare("SELECT meta FROM audit_logs WHERE event = 'client.error'").first()
  assert.ok(row, '应有记录')
  assert.equal(JSON.parse(row.meta).source, 'client', '必须带来源标记，管理端据此灰底与折叠')
})

test('并发逼近日上限：INSERT 原子条件保证 client.error 不超过 2000', async () => {
  const env = makeEnv({ fullSchema: true })
  const now = Date.now()
  // 预填当天 cap-1，再并发从多个独立 audit 调用争抢最后一个名额。
  env.DB._raw.prepare(`INSERT INTO audit_logs (ts, level, event, ip, meta)
    SELECT ?, 'error', 'client.error', '198.51.100.1', '{"source":"client"}'
    FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1999) SELECT x FROM c)`)
    .run(now)
  assert.equal(await countClient(env), 1999)

  // Give each caller its own module instance to model independent isolate-local budgets.
  const isolates = await Promise.all(Array.from({ length: 32 }, (_, i) =>
    import('../src/log.js?audit-isolate=' + i)
  ))
  const capRace = await Promise.all(isolates.map(({ audit: isolatedAudit }, i) => isolatedAudit(env, null, {
    event: 'client.error', level: 'error', ip: '198.51.100.' + (i + 1),
    meta: { source: 'client', message: 'concurrent-' + i }
  })))
  assert.equal(capRace.length, 32, '每个 audit promise 都应正常完成')
  assert.equal(await countClient(env), 2000, '并发 client.error 最多只能写入最后一个名额')

  // 达限后的真实客户端请求仍成功，且其审计写入不再增加计数。
  assert.equal(await report(env, 'after-cap'), 200, '达限不能令请求抛异常或失败')
  assert.equal(await countClient(env), 2000, '达限后不继续写 client.error')

  // 日额度只针对 client.error；其它审计事件即使总数已达上限仍可写。
  await audit(env, null, { event: 'auth.login.ok', level: 'info', meta: { test: 'not-day-capped' } })
  const other = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'auth.login.ok'").first()
  assert.equal(Number(other.n), 1, '其他事件不受 client.error 日限额影响')
})

test('无 pending 时普通事件同步预占预算，不被后续达日限 client.error 误丢', async () => {
  const env = makeEnv({ fullSchema: true })
  const now = Date.now()
  env.DB._raw.prepare(`INSERT INTO audit_logs (ts, level, event, ip, meta)
    SELECT ?, 'error', 'client.error', '198.51.100.1', '{"source":"client"}'
    FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000) SELECT x FROM c)`)
    .run(now)

  const { audit: isolatedAudit } = await import('../src/log.js?audit-immediate-budget=' + now)
  // 119/120 normal slots used; with no pending cap writes, audit() must reserve
  // the final slot synchronously before the next client.error call can run.
  await Promise.all(Array.from({ length: 119 }, () => isolatedAudit(env, null, {
    event: 'auth.login.ok', level: 'info'
  })))

  const ordinaryWrite = isolatedAudit(env, null, { event: 'test.ordinary.immediate', level: 'info' })
  const clientWrite = isolatedAudit(env, null, { event: 'client.error', level: 'error', meta: { source: 'client' } })
  await Promise.all([ordinaryWrite, clientWrite])

  assert.equal(await countClient(env), 2000, 'client.error 不得突破已满的日额度')
  const ordinary = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'test.ordinary.immediate'").first()
  assert.equal(Number(ordinary.n), 1, '普通事件应同步取得最后一个分钟预算名额并落库')
})

test('日额度满时等待 client.error 条件 INSERT 后重新评估普通事件预算', async () => {
  const env = makeEnv({ fullSchema: true })
  const now = Date.now()
  env.DB._raw.prepare(`INSERT INTO audit_logs (ts, level, event, ip, meta)
    SELECT ?, 'error', 'client.error', '198.51.100.1', '{"source":"client"}'
    FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000) SELECT x FROM c)`)
    .run(now)

  const { audit: isolatedAudit } = await import('../src/log.js?audit-budget-barrier=' + now)
  // Leave exactly one per-minute normal-event slot for the provisional client.error.
  await Promise.all(Array.from({ length: 119 }, () => isolatedAudit(env, null, {
    event: 'auth.login.ok', level: 'info'
  })))

  const originalDb = env.DB
  let releaseInsert
  let markInsertStarted
  const insertStarted = new Promise((resolve) => { markInsertStarted = resolve })
  env.DB = {
    prepare(sql) {
      const statement = originalDb.prepare(sql)
      if (!sql.includes('INSERT INTO audit_logs') || !sql.includes('SELECT')) return statement
      return {
        bind(...params) {
          const bound = statement.bind(...params)
          return {
            run() {
              markInsertStarted()
              return new Promise((resolve, reject) => {
                releaseInsert = () => bound.run().then(resolve, reject)
              })
            }
          }
        }
      }
    }
  }

  const clientWrite = isolatedAudit(env, null, { event: 'client.error', level: 'error', meta: { source: 'client' } })
  await insertStarted
  let ordinarySettled = false
  const ordinaryWrite = isolatedAudit(env, null, { event: 'test.ordinary.pending-cap', level: 'info' })
    .then(() => { ordinarySettled = true })
  assert.equal(ordinarySettled, false, '普通事件必须等待 cap INSERT 结果')

  releaseInsert()
  await Promise.all([clientWrite, ordinaryWrite])
  assert.equal(await countClient(env), 2000, '日额度满时 client.error 不能超写')
  const ordinary = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'test.ordinary.pending-cap'").first()
  assert.equal(Number(ordinary.n), 1, 'cap no-op 返还预算后普通事件应写入')
})

test('数据库写失败按写失败降级，不误报为日额度耗尽', async () => {
  const env = makeEnv({ fullSchema: true })
  const db = env.DB
  env.DB = {
    prepare(sql) {
      if (sql.includes('INSERT INTO audit_logs') && sql.includes('SELECT')) {
        return { bind() { return { async run() { throw new Error('simulated D1 write failure') } } } }
      }
      return db.prepare(sql)
    }
  }

  const warnings = []
  const originalWarn = console.warn
  console.warn = (line) => warnings.push(String(line))
  try {
    await assert.doesNotReject(audit(env, null, { event: 'client.error', level: 'error', meta: { source: 'client' } }))
  } finally {
    console.warn = originalWarn
  }

  assert.ok(warnings.some((line) => line.includes('audit.write.fail')), '写失败仍应走原有降级日志')
  assert.equal(warnings.some((line) => line.includes('daily-cap')), false, '写失败不能混作达限')
})

test('管理端默认折叠客户端上报，显式 client=all 才出现', async () => {
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
