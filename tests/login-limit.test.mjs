// 登录节流的不变量测试
//
// 用 node:sqlite 实现一个最小 D1 适配层（prepare/bind/first/all/run），
// 直接驱动 src/loginLimit.js 里的真实 SQL —— 不复制 SQL，避免测试与实现漂移。
//
// 覆盖的是前几轮审计里"只能靠手工构造并发和时钟才能发现"的三类问题：
// 阈值语义、封禁期内只读、退避阶梯与复位，以及缺列时的 fail-closed 信号。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// ---------- 最小 D1 适配层 ----------
function makeD1() {
  const db = new DatabaseSync(':memory:')
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      const row = db.prepare(sql).get(...args)
      return row === undefined ? null : { ...row }
    },
    async all() {
      return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }
    },
    async run() {
      const r = db.prepare(sql).run(...args)
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
    }
  })
  return {
    _raw: db,
    prepare: (sql) => stmt(sql, []),
    async batch(list) { return Promise.all(list.map((s) => s.run())) }
  }
}

// ensureLoginSchema 在模块内缓存就绪状态，各用例需要独立实例
let bust = 0
const fresh = () => import('../src/loginLimit.js?case=' + (++bust))

const T0 = 1_700_000_000_000
const COMBO = 'lf:ipu:203.0.113.7:alice'

// 与生产一致：先 ensureLoginSchema，再用 hitLimit
async function setup() {
  const mod = await fresh()
  const env = { DB: makeD1() }
  await mod.ensureLoginSchema(env)
  return { ...mod, env }
}

const row = (env, key) => env.DB.prepare('SELECT * FROM login_fails WHERE key = ?').bind(key).first()

// 一轮"打到被封"：阈值 max 时第 max+1 次触发封禁，返回 retry 秒数与封禁到期时间
async function roundUntilBlocked(hitLimit, env, key, max, startAt) {
  let t = startAt
  for (let i = 1; i <= max; i++) {
    const r = await hitLimit(env, key, max, t)
    assert.equal(r.blocked, false, `第 ${i} 次应放行（阈值 ${max}）`)
    t += 1000
  }
  const blocked = await hitLimit(env, key, max, t)
  assert.equal(blocked.blocked, true, `第 ${max + 1} 次应被封`)
  return { retry: blocked.retry, at: t, until: t + blocked.retry * 1000 }
}

test('阈值：前 5 次放行，第 6 次封 60 秒', async () => {
  const { hitLimit, env } = await setup()
  const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, T0)
  assert.equal(r.retry, 60)
})

test('封禁期内重试：只读，不改 n / updated_at', async () => {
  const { hitLimit, env } = await setup()
  const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, T0)
  const before = await row(env, COMBO)

  for (let i = 1; i <= 5; i++) {
    const again = await hitLimit(env, COMBO, 5, r.at + i * 1000)
    assert.equal(again.blocked, true, '封禁期内应继续拒绝')
    assert.ok(again.retry > 0)
  }

  const after = await row(env, COMBO)
  assert.deepEqual(after, before, '封禁期内不应写库（否则计数永远清不掉，用户被永久锁死）')
})

test('退避阶梯：60 → 120 → 240 → 480 → 900 → 900（封顶）', async () => {
  const { hitLimit, env } = await setup()
  const seen = []
  let startAt = T0
  for (let k = 0; k < 6; k++) {
    const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, startAt)
    seen.push(r.retry)
    startAt = r.until + 1000 // 封禁到期后立刻再来
  }
  assert.deepEqual(seen, [60, 120, 240, 480, 900, 900])
})

test('封禁到期即可重试：计数复位，不残留锁死', async () => {
  const { hitLimit, env } = await setup()
  const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, T0)
  const afterExpiry = await hitLimit(env, COMBO, 5, r.until + 1)
  assert.equal(afterExpiry.blocked, false, '封禁到期后应放行')
  const rec = await row(env, COMBO)
  assert.equal(Number(rec.n), 1, '到期后 n 复位为 1')
  assert.equal(Number(rec.until), 0)
})

test('静默超过 1 小时：阶梯归零，重新从 60 秒开始', async () => {
  const { hitLimit, env } = await setup()
  let startAt = T0
  for (let k = 0; k < 3; k++) {
    const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, startAt)
    startAt = r.until + 1000
  }
  assert.equal(Number((await row(env, COMBO)).blocks), 3, '应累积到第 3 次封禁')

  const quietAt = startAt + 61 * 60 * 1000 // 静默超过 1 小时窗口
  const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, quietAt)
  assert.equal(r.retry, 60, '窗口滑过后阶梯应归零')
})

test('成功登录只清本人键：IP 计数不受影响', async () => {
  const { hitLimit, clearLimit, env } = await setup()
  const ipKey = 'lf:ip:203.0.113.7'
  const userKey = 'lf:u:alice'

  await hitLimit(env, COMBO, 50, T0)
  await hitLimit(env, userKey, 20, T0)
  await hitLimit(env, ipKey, 50, T0)

  await clearLimit(env, [COMBO, userKey])

  assert.equal(await row(env, COMBO), null, '组合键应被清掉')
  assert.equal(await row(env, userKey), null, '账号键应被清掉')
  const ip = await row(env, ipKey)
  assert.ok(ip, 'IP 计数必须保留：否则登录一次就成了攻击者的计数器重置开关')
  assert.equal(Number(ip.n), 1)
})

test('缺 blocks 列：抛 schemaMismatch（调用方据此 fail-closed，而不是静默放行）', async () => {
  const env = { DB: makeD1() }
  // 模拟旧结构：没有 blocks 列
  env.DB._raw.exec(`CREATE TABLE login_fails (
    key TEXT PRIMARY KEY,
    n INTEGER NOT NULL DEFAULT 0,
    until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`)

  const { ensureLoginSchema } = await fresh()
  await assert.rejects(
    () => ensureLoginSchema(env),
    (err) => {
      assert.equal(err.schemaMismatch, true, '必须带 schemaMismatch 标记，否则调用方无法区分降级方式')
      return true
    }
  )
})

test('全新库建表后结构完整，可正常限流', async () => {
  const { ensureLoginSchema, hitLimit, env } = await setup()
  const cols = (await env.DB.prepare('PRAGMA table_info(login_fails)').all()).results.map((c) => c.name)
  assert.deepEqual(cols, ['key', 'n', 'blocks', 'until', 'updated_at'])
  const r = await roundUntilBlocked(hitLimit, env, COMBO, 5, T0)
  assert.equal(r.retry, 60)
  assert.equal(typeof ensureLoginSchema, 'function')
})

test('Cron 清理：只删 24 小时未动的行', async () => {
  const { hitLimit, pruneLoginFails, env } = await setup()
  await hitLimit(env, 'lf:u:old', 20, T0)
  await hitLimit(env, 'lf:u:fresh', 20, T0 + 23 * 60 * 60 * 1000)

  await pruneLoginFails(env, T0 + 24 * 60 * 60 * 1000 + 1000)

  assert.equal(await row(env, 'lf:u:old'), null, '超过 24 小时的应被清掉')
  assert.ok(await row(env, 'lf:u:fresh'), '仍在保留期内的不能被清')
})
