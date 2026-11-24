// F-04 / F-05 并发回归：验证码的尝试上限、单次消费、发信冷却与小时额度必须原子
//
// 这些用例用 barrier 把并发请求卡在「都读到同一份旧状态」的位置，再一起放行：
//   · 8 个并发错误码：attempts 最多到 5（旧实现会到 8）
//   · 8 个并发正确码：只有 1 个成功消费（used 只能 0 → 1）
//   · 20 个并发发码（同邮箱）：只有 1 封真的发出（冷却 + 原子占位）
//   · 邮箱/小时额度与 IP/小时额度用预置历史行占满，并发请求不得越过上限多写一行、多发一封
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeEnv } from './helpers/d1.mjs'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const worker = (await import('../src/worker.js')).default
const BASE = 'https://caar.test'
const TOKEN = 'd'.repeat(32)
const TTL = 10 * 60 * 1000
const COOLDOWN = 60 * 1000

const codeHash = (email, code, issuedAt) =>
  createHash('sha256').update(email + ':' + code + ':' + issuedAt).digest('hex')

// 把某个 SQL 的第一次执行卡住：等 count 个请求都到达后再一起放行。
// 这样测的是真正的并发时序（所有请求都持着同一份旧读），而不是 Promise.all 的假并发。
function gatedDb(db, match, count) {
  let arrived = 0
  let opened = false
  let release
  const gate = new Promise((r) => { release = r })
  async function before(sql) {
    if (opened || !match.test(sql)) return
    arrived += 1
    if (arrived >= count) { opened = true; release() }
    const timeout = new Promise((r) => { const h = setTimeout(r, 3000); if (h.unref) h.unref() })
    await Promise.race([gate, timeout])
  }
  const wrap = (stmt, sql) => ({
    bind: (...a) => wrap(stmt.bind(...a), sql),
    async first() { await before(sql); return stmt.first() },
    async all() { await before(sql); return stmt.all() },
    async run() { await before(sql); return stmt.run() }
  })
  return { ...db, prepare: (sql) => wrap(db.prepare(sql), sql) }
}

async function seedUser(env) {
  await env.DB.prepare(
    'INSERT INTO users (id, username, password, nickname, role, banned, session_version) VALUES (1, ?, ?, ?, ?, 0, 0)'
  ).bind('alice', 'deadbeef:deadbeef', 'alice', 'user').run()
  await env.SESSIONS.put('s:' + TOKEN, '1:0')
}

async function seedCode(env, { email, purpose = 'bind', code, issuedAt = Date.now(), ip = '', used = 0, attempts = 0 }) {
  const row = await env.DB.prepare(
    'INSERT INTO email_codes (email, purpose, code_hash, expires_at, attempts, used, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(email, purpose, codeHash(email, code, issuedAt), issuedAt + TTL, attempts, used, ip).run()
  return row.meta.last_row_id
}

function bindRequest(email, code) {
  return new Request(BASE + '/api/profile/email', {
    method: 'POST',
    headers: { cookie: 'caar_session=' + TOKEN, origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email, code })
  })
}

function emailCodeRequest(email, ip) {
  return new Request(BASE + '/api/email-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, purpose: 'register' })
  })
}

async function run(env, request) {
  const res = await worker.fetch(request, env, ctx)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function withFakeMail(env) {
  const state = { mails: 0 }
  env.RESEND_API_KEY = 'test-key'
  env.MAIL_API_BASE = 'https://mail.test'
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://mail.test/')) {
      state.mails += 1
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return original(url)
  }
  state.restore = () => { globalThis.fetch = original }
  return state
}

// ---------------------------------------------------------------- F-05

test('8 个并发错误码：attempts 最终等于 5，不因竞态超额', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const email = 'target@example.com'
  const id = await seedCode(env, { email, code: '123456' })
  env.DB = gatedDb(env.DB, /FROM email_codes WHERE email = \? AND purpose = \? AND used = 0/, 8)

  const results = await Promise.all(
    Array.from({ length: 8 }, () => run(env, bindRequest(email, '000000')))
  )
  const row = await env.DB.prepare('SELECT attempts FROM email_codes WHERE id = ?').bind(id).first()
  assert.equal(Number(row.attempts), 5, '错误尝试必须被原子地卡在 5 次，不能到 8 次')
  assert.equal(results.filter((r) => r.status === 400).length, 8, '错误码一律失败')
  assert.ok(results.every((r) => r.body.error === '验证码无效，请重新检查邮箱和验证码后重试'), 'bind 验证失败原因统一，不根据响应区分有效尝试数')
})

test('8 个并发正确码：最多消费一次，邮箱只绑定一次', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env)
  const email = 'winner@example.com'
  const id = await seedCode(env, { email, code: '654321' })
  env.DB = gatedDb(env.DB, /FROM email_codes WHERE email = \? AND purpose = \? AND used = 0/, 8)

  const results = await Promise.all(
    Array.from({ length: 8 }, () => run(env, bindRequest(email, '654321')))
  )
  assert.equal(results.filter((r) => r.status === 200).length, 1, '正确码只能被一个请求消费')
  const row = await env.DB.prepare('SELECT used, attempts FROM email_codes WHERE id = ?').bind(id).first()
  assert.equal(Number(row.used), 1, '验证码必须标记为已用')
  assert.equal(Number(row.attempts), 0, '成功路径不应该累计错误次数')
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = 1').first()
  assert.equal(user.email, email)
})

// ---------------------------------------------------------------- F-04

test('20 个并发发码（同一邮箱/IP）：只成功 1 次、只发 1 封、只落 1 行', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = withFakeMail(env)
  env.DB = gatedDb(env.DB, /INSERT INTO email_codes/, 20)
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => run(env, emailCodeRequest('flood@example.com', '10.1.1.1')))
    )
    assert.equal(results.filter((r) => r.status === 200).length, 1, '同一邮箱的冷却与额度必须原子占位')
    assert.equal(results.filter((r) => r.status === 429).length, 19)
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_codes WHERE email = 'flood@example.com'").first()
    assert.equal(Number(rows.n), 1, '超额请求不得写入验证码行')
    assert.equal(mail.mails, 1, '超额请求不得发送邮件')
  } finally {
    mail.restore()
  }
})

test('邮箱小时额度（已用 4/5）在并发下最多再放 1 封', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = withFakeMail(env)
  const email = 'quota@example.com'
  // 4 封历史（2 分钟前签发：不在 60 秒冷却内，但在 1 小时额度内）
  for (let i = 0; i < 4; i++) {
    await seedCode(env, { email, purpose: 'register', code: '111111', issuedAt: Date.now() - 2 * 60 * 1000, ip: '10.9.9.' + i })
  }
  env.DB = gatedDb(env.DB, /INSERT INTO email_codes/, 10)
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => run(env, emailCodeRequest(email, '10.3.3.3')))
    )
    assert.equal(results.filter((r) => r.status === 200).length, 1, '只剩最后 1 个额度')
    assert.equal(results.filter((r) => r.status === 429).length, 9)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ?').bind(email).first()
    assert.equal(Number(rows.n), 5, '邮箱小时上限 5 封不得被并发突破')
    assert.equal(mail.mails, 1)
  } finally {
    mail.restore()
  }
})

test('IP 小时额度（已用 14/15）在并发下最多再放 1 封', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = withFakeMail(env)
  const ip = '10.2.2.2'
  for (let i = 0; i < 14; i++) {
    await seedCode(env, {
      email: 'bulk' + i + '@example.com', purpose: 'register', code: '222222',
      issuedAt: Date.now() - 2 * 60 * 1000, ip
    })
  }
  env.DB = gatedDb(env.DB, /INSERT INTO email_codes/, 10)
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => run(env, emailCodeRequest('fresh' + i + '@example.com', ip)))
    )
    assert.equal(results.filter((r) => r.status === 200).length, 1, '同一 IP 只剩最后 1 个额度')
    assert.equal(results.filter((r) => r.status === 429).length, 9)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE ip = ?').bind(ip).first()
    assert.equal(Number(rows.n), 15, 'IP 小时上限 15 封不得被并发突破')
    assert.equal(mail.mails, 1)
  } finally {
    mail.restore()
  }
})
