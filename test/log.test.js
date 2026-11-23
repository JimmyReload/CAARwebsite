/* 日志模块的纯函数单测（零依赖，node --test）
   目的：把审计报告里「脱敏覆盖」「转义」「meta 必须是合法 JSON」这几条承诺固定下来，
   以后改正则或截断逻辑时先跑一遍，避免规则悄悄退化。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  redact, isSensitiveKey, escapeLike, maskEmail,
  describeError, auditKeepDays, metaJson, AUDIT_KEEP_DAYS
} from '../src/log.js'

test('敏感键全被脱敏', () => {
  const keys = [
    'password', 'old_password', 'new_password', 'confirmPassword', 'passwd', 'pwd',
    'secret', 'token', 'authToken', 'refreshToken', 'code', 'emailCode', 'verificationCode',
    'code_hash', 'salt', 'hash', 'authorization', 'cookie', 'api_key', 'apiKey',
    'otp', 'csrf', 'csrfToken', 'jwt', 'sessionId', 'session_id'
  ]
  const input = {}
  for (const k of keys) input[k] = 'leak-me'
  const out = redact(input)
  for (const k of keys) assert.equal(out[k], '***', k + ' 未被脱敏')
})

test('非凭据的 code 字段保留', () => {
  const out = redact({ error_code: 'E_BAD', status_code: 400, errCode: 'x', username: 'bob', message: 'hi' })
  assert.equal(out.error_code, 'E_BAD')
  assert.equal(out.status_code, 400)
  assert.equal(out.errCode, 'x')
  assert.equal(out.username, 'bob')
  assert.equal(out.message, 'hi')
})

test('嵌套与数组里的敏感键同样生效', () => {
  const out = redact({ a: { password: 'x', nested: { token: 'y' } }, list: [{ pwd: 'z' }] })
  assert.equal(out.a.password, '***')
  assert.equal(out.a.nested.token, '***')
  assert.equal(out.list[0].pwd, '***')
})

test('超长字符串被截断并带长度提示', () => {
  const out = redact({ s: 'a'.repeat(1000) })
  assert.ok(out.s.length < 1000)
  assert.match(out.s, /…\(\+\d+\)$/)
})

test('循环引用不会抛错', () => {
  const o = { name: 'x' }
  o.self = o
  assert.doesNotThrow(() => redact(o))
})

test('isSensitiveKey 边界', () => {
  assert.equal(isSensitiveKey('password'), true)
  assert.equal(isSensitiveKey('verificationCode'), true)
  assert.equal(isSensitiveKey('error_code'), false)
  assert.equal(isSensitiveKey('nickname'), false)
})

test('LIKE 转义覆盖 % _ \\', () => {
  assert.equal(escapeLike('100%'), '100\\%')
  assert.equal(escapeLike('a_b'), 'a\\_b')
  assert.equal(escapeLike('c\\d'), 'c\\\\d')
})

test('邮箱脱敏保留域名', () => {
  assert.equal(maskEmail('alice@example.com'), 'al***@example.com')
  assert.equal(maskEmail('a@b.c'), 'a***@b.c')
  assert.equal(maskEmail(''), '')
})

test('错误描述只留类型/消息/前几帧', () => {
  const d = describeError(new TypeError('boom'))
  assert.equal(d.name, 'TypeError')
  assert.equal(d.message, 'boom')
  assert.ok(d.stack.split('\n').length <= 6)
  assert.equal(describeError(null), null)
})

test('meta 超限仍是合法 JSON', () => {
  // 单个字符串会被 redact 截到 400，要靠「多字段」才能撑过 2000
  const wide = {}
  for (let i = 0; i < 40; i++) wide['k' + i] = 'y'.repeat(300)
  const big = metaJson(wide)
  const parsed = JSON.parse(big)
  assert.equal(parsed._truncated, true)
  assert.ok(parsed._size > 2000)
  assert.ok(big.length <= 2000)
})

test('meta 截断在转义膨胀下也不越界', () => {
  // 引号和反斜杠在序列化时翻倍：只算原始长度会在最终字符串上突破上限
  for (const filler of ['"', '\\\\']) {
    const wide = {}
    for (let i = 0; i < 40; i++) wide['k' + i] = filler.repeat(200)
    const out = metaJson(wide)
    assert.ok(out.length <= 2000, '超长: ' + out.length)
    assert.doesNotThrow(() => JSON.parse(out))
  }
})

test('meta 为空时返回空串', () => {
  assert.equal(metaJson({}), '')
  assert.equal(metaJson(null), '')
  assert.equal(metaJson({ a: 1 }), '{"a":1}')
})

test('保留天数下限兜底', () => {
  assert.equal(auditKeepDays({ AUDIT_KEEP_DAYS: '30' }), 30)
  assert.equal(auditKeepDays({ AUDIT_KEEP_DAYS: '3' }), AUDIT_KEEP_DAYS)
  assert.equal(auditKeepDays({}), AUDIT_KEEP_DAYS)
})
