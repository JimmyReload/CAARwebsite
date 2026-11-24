import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeEnv, api } from './helpers/d1.mjs'
import worker from '../src/worker.js'

const TTL = 10 * 60 * 1000
const codeHash = (email, code, issuedAt) =>
  createHash('sha256').update(`${email}:${code}:${issuedAt}`).digest('hex')

async function seedUser(env, { username, email = null }) {
  return env.DB.prepare(
    'INSERT INTO users (username, password, nickname, role, email) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, 'deadbeef:deadbeef', username, 'user', email).run()
}

async function seedCode(env, email, code = '123456', purpose = 'register') {
  const issuedAt = Date.now()
  const row = await env.DB.prepare(
    'INSERT INTO email_codes (email, purpose, code_hash, expires_at, ip) VALUES (?, ?, ?, ?, ?)'
  ).bind(email, purpose, codeHash(email, code, issuedAt), issuedAt + TTL, 'test').run()
  return row.meta.last_row_id
}

async function register(env, { username, email, code = '123456', password = 'N0tWeak!Passphrase' }) {
  return api(worker, env, 'register', {
    method: 'POST',
    body: { username, email, code, password }
  })
}

async function bindEmail(env, token, email, code) {
  return api(worker, env, 'profile/email', {
    method: 'POST', token, body: { email, code }
  })
}

function fakeMail(env, { fail = false } = {}) {
  env.RESEND_API_KEY = 'test-key'
  env.MAIL_API_BASE = 'https://mail.test'
  let attempts = 0
  const delivered = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://mail.test/')) {
      attempts += 1
      if (fail) return new Response('{}', { status: 503 })
      delivered.push(JSON.parse(init.body || '{}'))
      return new Response('{}', { status: 200 })
    }
    return originalFetch(url, init)
  }
  return {
    count: () => delivered.length,
    attempts: () => attempts,
    lastCode: () => {
      const match = String(delivered.at(-1)?.text || '').match(/你的验证码是 (\d+)/)
      return match ? match[1] : null
    },
    restore: () => { globalThis.fetch = originalFetch }
  }
}

async function postCode(env, email, ip = '192.0.2.1', purpose = 'register', token = null) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip }
  if (token) {
    headers.cookie = 'caar_session=' + token
    headers.origin = 'https://caar.test'
  }
  const res = await worker.fetch(new Request('https://caar.test/api/email-code', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, purpose })
  }), env, { waitUntil() {}, passThroughOnException() {} })
  return { status: res.status, body: await res.json() }
}

test('重复邮箱与新邮箱 register 发码响应一致；占用地址dummy记额度但不发信', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = fakeMail(env)
  await seedUser(env, { username: 'mail_owner', email: 'taken@example.test' })
  try {
    const occupied = await postCode(env, 'taken@example.test', '192.0.2.11')
    const available = await postCode(env, 'available@example.test', '192.0.2.12')
    assert.deepEqual(occupied, available)
    assert.deepEqual(occupied, { status: 200, body: { ok: true, ttl: 600 } })
    const rows = await env.DB.prepare(
      'SELECT email, used, ip FROM email_codes ORDER BY id'
    ).all()
    assert.equal(rows.results.length, 2)
    assert.deepEqual(rows.results.map((r) => Number(r.used)), [1, 0])
    assert.equal(mail.count(), 1, '只有可用邮箱收到邮件')

    const limited = await postCode(env, 'taken@example.test', '192.0.2.11')
    assert.equal(limited.status, 429, 'dummy reservation 同样占用邮箱冷却')
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first()
    assert.equal(Number(after.n), 2, '限流请求不应再写 reservation')
  } finally {
    mail.restore()
  }
})

test('重复邮箱dummy与新邮箱邮件上游失败响应一致，均作废码且占用注册限流', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = fakeMail(env, { fail: true })
  await seedUser(env, { username: 'mail_owner', email: 'taken-fail@example.test' })
  try {
    const occupied = await postCode(env, 'taken-fail@example.test', '192.0.2.31')
    const providerFailed = await postCode(env, 'new-fail@example.test', '192.0.2.32')
    assert.deepEqual(providerFailed, occupied)
    assert.deepEqual(occupied, { status: 200, body: { ok: true, ttl: 600 } })
    assert.equal(mail.attempts(), 1, '占用邮箱不触发邮件请求；新邮箱触发一次上游失败')
    assert.equal(mail.count(), 0, '失败的上游请求未实际送达邮件')

    const rows = await env.DB.prepare(
      'SELECT email, used, ip FROM email_codes ORDER BY id'
    ).all()
    assert.equal(rows.results.length, 2, '两个请求均写入限流 reservation')
    assert.deepEqual(rows.results.map((r) => Number(r.used)), [1, 1], '失败邮件对应的验证码必须作废')
    assert.deepEqual(rows.results.map((r) => r.email), ['taken-fail@example.test', 'new-fail@example.test'])

    const occupiedLimited = await postCode(env, 'taken-fail@example.test', '192.0.2.31')
    const failedLimited = await postCode(env, 'new-fail@example.test', '192.0.2.32')
    assert.equal(occupiedLimited.status, 429)
    assert.equal(failedLimited.status, 429, '失败发信的 reservation 仍占冷却')
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first()
    assert.equal(Number(count.n), 2, '重试不应产生可重放验证码或额外 reservation')
  } finally {
    mail.restore()
  }
})

test('bind 对他人已占用邮箱返回相同成功响应、不发信且仍占用冷却', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = fakeMail(env)
  const ownerId = await seedUser(env, { username: 'bind_owner', email: 'bound@example.test' })
  const requesterId = await seedUser(env, { username: 'bind_requester', email: null })
  await env.SESSIONS.put('s:' + 'b'.repeat(32), `${requesterId.meta.last_row_id}:0`)
  try {
    const occupied = await postCode(env, 'bound@example.test', '192.0.2.21', 'bind', 'b'.repeat(32))
    const available = await postCode(env, 'free-bind@example.test', '192.0.2.22', 'bind', 'b'.repeat(32))
    assert.deepEqual(occupied, available)
    assert.deepEqual(occupied, { status: 200, body: { ok: true, ttl: 600 } })
    const dummy = await env.DB.prepare(
      "SELECT used FROM email_codes WHERE email = 'bound@example.test' AND purpose = 'bind'"
    ).first()
    assert.equal(Number(dummy.used), 1)
    assert.equal(mail.count(), 1, '已被他人占用的邮箱不能收到绑定验证码')

    const limited = await postCode(env, 'bound@example.test', '192.0.2.21', 'bind', 'b'.repeat(32))
    assert.equal(limited.status, 429, '不发信的冲突 reservation 仍占冷却')
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_codes WHERE purpose = 'bind'").first()
    assert.equal(Number(count.n), 2)
  } finally {
    mail.restore()
  }
})

test('bind 发信失败与占用邮箱dummy响应一致，均作废 reservation 且占用限流', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = fakeMail(env, { fail: true })
  await seedUser(env, { username: 'bind_owner', email: 'bind-taken-fail@example.test' })
  const requester = await seedUser(env, { username: 'bind_requester', email: null })
  const token = 'f'.repeat(32)
  await env.SESSIONS.put('s:' + token, `${requester.meta.last_row_id}:0`)
  try {
    const occupied = await postCode(env, 'bind-taken-fail@example.test', '192.0.2.41', 'bind', token)
    const providerFailed = await postCode(env, 'bind-new-fail@example.test', '192.0.2.42', 'bind', token)
    assert.deepEqual(providerFailed, occupied)
    assert.deepEqual(occupied, { status: 200, body: { ok: true, ttl: 600 } })
    assert.equal(mail.attempts(), 1, 'occupied dummy skips mail; only available address reaches the failing provider')
    assert.equal(mail.count(), 0, 'provider failure sends no email')

    const rows = await env.DB.prepare(
      "SELECT email, used FROM email_codes WHERE purpose = 'bind' ORDER BY id"
    ).all()
    assert.deepEqual(rows.results.map((r) => r.email), ['bind-taken-fail@example.test', 'bind-new-fail@example.test'])
    assert.deepEqual(rows.results.map((r) => Number(r.used)), [1, 1], 'both reservation rows are unusable')
    const occupiedLimited = await postCode(env, 'bind-taken-fail@example.test', '192.0.2.41', 'bind', token)
    const failedLimited = await postCode(env, 'bind-new-fail@example.test', '192.0.2.42', 'bind', token)
    assert.equal(occupiedLimited.status, 429)
    assert.equal(failedLimited.status, 429)
  } finally {
    mail.restore()
  }
})

test('bind dummy与真实验证码记录在错误码请求时响应一致', async () => {
  const env = makeEnv({ fullSchema: true })
  const mail = fakeMail(env)
  await seedUser(env, { username: 'bind_owner', email: 'occupied-otp@example.test' })
  const requester = await seedUser(env, { username: 'bind_requester', email: null })
  const token = 'g'.repeat(32)
  await env.SESSIONS.put('s:' + token, `${requester.meta.last_row_id}:0`)
  try {
    const occupiedSend = await postCode(env, 'occupied-otp@example.test', '192.0.2.51', 'bind', token)
    const availableSend = await postCode(env, 'available-otp@example.test', '192.0.2.52', 'bind', token)
    assert.deepEqual(occupiedSend, availableSend)
    assert.equal(mail.count(), 1, 'only the available address receives a real OTP')
    const realOtp = mail.lastCode()
    assert.equal(typeof realOtp, 'string')
    assert.equal(realOtp.length, 6)
    assert.ok([...realOtp].every((digit) => digit >= '0' && digit <= '9'))

    const wrongOtp = realOtp === '000000' ? '000001' : '000000'
    const wrongForOccupiedDummy = await bindEmail(env, token, 'occupied-otp@example.test', wrongOtp)
    const wrongForAvailableRealCode = await bindEmail(env, token, 'available-otp@example.test', wrongOtp)
    assert.deepEqual(wrongForOccupiedDummy, wrongForAvailableRealCode)
    assert.deepEqual(wrongForOccupiedDummy, {
      status: 400,
      body: { error: '验证码无效，请重新检查邮箱和验证码后重试' }
    })
    const unchanged = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
      .bind(requester.meta.last_row_id).first()
    assert.equal(unchanged.email, null)
  } finally {
    mail.restore()
  }
})

test('绑定请求无/错误验证码时，已占用与可用邮箱响应完全一致', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env, { username: 'bind_owner', email: 'claimed@example.test' })
  const requester = await seedUser(env, { username: 'bind_requester', email: 'requester_old@example.test' })
  const token = 'c'.repeat(32)
  await env.SESSIONS.put('s:' + token, `${requester.meta.last_row_id}:0`)

  const noCodeTaken = await bindEmail(env, token, 'claimed@example.test', '')
  const noCodeAvailable = await bindEmail(env, token, 'available@example.test', '')
  assert.deepEqual(noCodeTaken, noCodeAvailable)
  assert.deepEqual(noCodeTaken, { status: 400, body: { error: '请填写邮箱验证码' } })

  const takenCodeId = await seedCode(env, 'claimed@example.test', '654321', 'bind')
  const availableCodeId = await seedCode(env, 'available@example.test', '654321', 'bind')
  const wrongTaken = await bindEmail(env, token, 'claimed@example.test', '000000')
  const wrongAvailable = await bindEmail(env, token, 'available@example.test', '000000')
  assert.deepEqual(wrongTaken, wrongAvailable)
  assert.equal(wrongTaken.status, 400)
  assert.deepEqual(wrongTaken, {
    status: 400,
    body: { error: '验证码无效，请重新检查邮箱和验证码后重试' }
  })
  const codeRows = await env.DB.prepare('SELECT id, attempts, used FROM email_codes WHERE id IN (?, ?) ORDER BY id')
    .bind(takenCodeId, availableCodeId).all()
  assert.deepEqual(codeRows.results.map((r) => Number(r.attempts)), [1, 1])
  assert.deepEqual(codeRows.results.map((r) => Number(r.used)), [0, 0])
  const unchanged = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(requester.meta.last_row_id).first()
  assert.equal(unchanged.email, 'requester_old@example.test')
})

test('有效验证码冲突时给出可操作提示但不改绑，并消费验证码', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env, { username: 'bind_owner', email: 'claimed@example.test' })
  const requester = await seedUser(env, { username: 'bind_requester', email: 'requester_old@example.test' })
  const token = 'e'.repeat(32)
  await env.SESSIONS.put('s:' + token, `${requester.meta.last_row_id}:0`)
  const codeId = await seedCode(env, 'claimed@example.test', '123456', 'bind')

  const result = await bindEmail(env, token, 'claimed@example.test', '123456')
  const unchanged = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(requester.meta.last_row_id).first()
  const code = await env.DB.prepare('SELECT used, attempts FROM email_codes WHERE id = ?').bind(codeId).first()
  assert.equal(result.status, 409)
  assert.match(result.body.error, /邮箱已被其他账号使用/)
  assert.equal(unchanged.email, 'requester_old@example.test')
  assert.equal(Number(code.used), 1, '有效验证码必须一次性消费，即使邮箱占用导致绑定拒绝')
  assert.equal(Number(code.attempts), 0)
})

test('绑定本人持有验证码的邮箱仍成功并单次消费', async () => {
  const env = makeEnv({ fullSchema: true })
  const requester = await seedUser(env, { username: 'bind_requester' })
  const token = 'd'.repeat(32)
  await env.SESSIONS.put('s:' + token, `${requester.meta.last_row_id}:0`)
  const email = 'controlled@example.test'
  const codeId = await seedCode(env, email, '123456', 'bind')

  const result = await bindEmail(env, token, email, '123456')
  const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(requester.meta.last_row_id).first()
  const code = await env.DB.prepare('SELECT used, attempts FROM email_codes WHERE id = ?').bind(codeId).first()
  assert.deepEqual(result, { status: 200, body: { ok: true, email } })
  assert.equal(row.email, email)
  assert.equal(Number(code.used), 1)
  assert.equal(Number(code.attempts), 0)
})

test('正常注册创建一个账户并消费验证码', async () => {
  const env = makeEnv({ fullSchema: true })
  const email = 'new-user@example.test'
  const codeId = await seedCode(env, email)
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()
  const result = await register(env, { username: 'fresh_user', email })
  const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()
  const code = await env.DB.prepare('SELECT used, attempts FROM email_codes WHERE id = ?').bind(codeId).first()
  const created = await env.DB.prepare('SELECT username, email FROM users WHERE username = ?').bind('fresh_user').first()
  assert.deepEqual(result, { status: 200, body: { ok: true } })
  assert.equal(Number(after.n), Number(before.n) + 1)
  assert.deepEqual(created, { username: 'fresh_user', email })
  assert.equal(Number(code.used), 1)
  assert.equal(Number(code.attempts), 0)
})

test('register dummy 与真实验证码记录遇到错误码时响应一致并不建号', async () => {
  const env = makeEnv({ fullSchema: true })
  await seedUser(env, { username: 'registered_owner', email: 'occupied-register@example.test' })
  const occupiedId = await env.DB.prepare(
    "INSERT INTO email_codes (email, purpose, code_hash, expires_at, ip, used) VALUES (?, 'register', ?, ?, ?, 1)"
  ).bind('occupied-register@example.test', 'dummy-hash', Date.now() + TTL, 'test-dummy').run()
  const realEmail = 'available-register@example.test'
  const realCodeId = await seedCode(env, realEmail, '654321', 'register')
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()

  const dummyResult = await register(env, {
    username: 'dummy_attempt', email: 'occupied-register@example.test', code: '000000'
  })
  const realResult = await register(env, {
    username: 'real_attempt', email: realEmail, code: '000000'
  })
  assert.deepEqual(dummyResult, realResult)
  assert.deepEqual(dummyResult, {
    status: 400,
    body: { error: '验证码无效，请重新检查邮箱和验证码后重试' }
  })

  const attempts = await env.DB.prepare('SELECT id, attempts, used FROM email_codes WHERE id = ? OR id = ? ORDER BY id')
    .bind(occupiedId.meta.last_row_id, realCodeId).all()
  assert.equal(attempts.results.length, 2)
  assert.deepEqual(attempts.results.map((row) => Number(row.used)), [1, 0])
  assert.deepEqual(attempts.results.map((row) => Number(row.attempts)), [0, 1], 'dummy 不计错码尝试；真实验证码仍原子计次')
  const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()
  assert.equal(Number(after.n), Number(before.n), '任一错误码都不能创建账户')
})

test('错误验证码保持原有失败响应且不创建账户', async () => {
  const env = makeEnv({ fullSchema: true })
  const email = 'wrong-code@example.test'
  const codeId = await seedCode(env, email)
  const result = await register(env, { username: 'wrong_code_user', email, code: '000000' })
  const code = await env.DB.prepare('SELECT used, attempts FROM email_codes WHERE id = ?').bind(codeId).first()
  const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()
  assert.equal(result.status, 400)
  assert.equal(result.body.error, '验证码无效，请重新检查邮箱和验证码后重试')
  assert.equal(Number(code.used), 0)
  assert.equal(Number(code.attempts), 1)
  assert.equal(Number(users.n), 0)
})

for (const conflict of ['username', 'email']) {
  test(`有效验证码遇到${conflict}冲突：与成功注册响应相同、消费验证码且不建号`, async () => {
    const env = makeEnv({ fullSchema: true })
    const conflictEmail = 'owner@example.test'
    await seedUser(env, { username: 'existing_user', email: conflictEmail })
    const submittedEmail = conflict === 'email' ? conflictEmail : 'new-target@example.test'
    const submittedUsername = conflict === 'username' ? 'existing_user' : 'new_account'
    const codeId = await seedCode(env, submittedEmail)
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()

    const conflictResult = await register(env, {
      username: submittedUsername,
      email: submittedEmail
    })
    const normalEmail = `${conflict}-normal@example.test`
    const normalCodeId = await seedCode(env, normalEmail)
    const normalResult = await register(env, { username: `${conflict}_normal`, email: normalEmail })
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()
    const conflictCode = await env.DB.prepare('SELECT used, attempts FROM email_codes WHERE id = ?').bind(codeId).first()
    const normalCode = await env.DB.prepare('SELECT used FROM email_codes WHERE id = ?').bind(normalCodeId).first()
    const unexpected = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND email = ?')
      .bind(submittedUsername, submittedEmail).all()

    assert.deepEqual(conflictResult, normalResult)
    assert.deepEqual(conflictResult, { status: 200, body: { ok: true } })
    assert.equal(Number(after.n), Number(before.n) + 1, '只有并行的正常注册创建了账户')
    assert.equal(Number(conflictCode.used), 1, '冲突分支仍消费验证码')
    assert.equal(Number(conflictCode.attempts), 0)
    assert.equal(Number(normalCode.used), 1)
    assert.equal(unexpected.results.length, 0, '冲突分支不能创建同时匹配本次提交用户名与邮箱的新账号')
    if (conflict === 'username') {
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').bind(submittedUsername).first()
      assert.equal(Number(count.n), 1)
    } else {
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind(submittedEmail).first()
      assert.equal(Number(count.n), 1)
    }
  })
}
