/* 审计预算与丢弃留痕的行为测试（假 D1，零依赖）
   用假 DB 记录每次 bind 的入参，验证三个承诺：
   1) 普通 120 / 关键 600 两条线各自截断，互不侵占；
   2) 丢弃时按 kind 各放行一行 audit.dropped，且带触发它的请求上下文；
   3) 分钟翻页补写上一分钟的汇总，能回答"丢了多少"。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { audit, auditBudgetSnapshot } from '../src/log.js'

function fakeEnv() {
  const rows = []
  return {
    rows,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return { run: async () => { rows.push({ sql: String(sql), args }) } }
          }
        }
      }
    }
  }
}

const eventOf = (row) => row.args[2]

test('预算与丢弃留痕：普通 120 / 关键 600', async () => {
  const env = fakeEnv()
  const realNow = Date.now
  let clock = 1_700_000_000_000
  Date.now = () => clock
  try {
    // 130 条普通事件：120 落库 + 1 行 dropped（kind=normal）
    for (let i = 0; i < 130; i++) {
      await audit(env, null, { event: 'announcement.create', ip: '10.0.0.9', path: '/api/announcements', rid: 'r-normal' })
    }
    let snap = auditBudgetSnapshot()
    assert.equal(env.rows.filter((r) => eventOf(r) === 'announcement.create').length, 120)
    const droppedNormal = env.rows.filter((r) => eventOf(r) === 'audit.dropped')
    assert.equal(droppedNormal.length, 1, '同一分钟同 kind 只放行一条')
    assert.equal(snap.droppedNormal, 10)
    assert.equal(snap.droppedCritical, 0)

    // 丢弃行必须带触发它的请求上下文
    const meta = JSON.parse(droppedNormal[0].args[13])
    assert.equal(meta.kind, 'normal')
    assert.equal(droppedNormal[0].args[7], '10.0.0.9')
    assert.equal(droppedNormal[0].args[9], '/api/announcements')
    assert.equal(droppedNormal[0].args[11], 'r-normal')

    // 同一分钟 3 条关键事件不受普通预算影响
    for (let i = 0; i < 3; i++) await audit(env, null, { event: 'admin.user.ban' })
    assert.equal(env.rows.filter((r) => eventOf(r) === 'admin.user.ban').length, 3)

    // 601 条 request.error：关键额度 600 已被上面 3 条封禁占用 3 条，这里落 597 +
    // 1 行 dropped（kind=critical，不因普通已丢而被吞）
    for (let i = 0; i < 601; i++) await audit(env, null, { event: 'request.error', path: '/api/boom' })
    snap = auditBudgetSnapshot()
    const errors = env.rows.filter((r) => eventOf(r) === 'request.error').length
    assert.equal(errors, 597)
    assert.equal(errors + 3, 600, '关键额度是两种关键事件共用的 600')
    assert.equal(snap.droppedCritical, 601 - errors)
    assert.equal(env.rows.filter((r) => eventOf(r) === 'audit.dropped').length, 2, '普通与关键各一条')
    const kinds = env.rows.filter((r) => eventOf(r) === 'audit.dropped').map((r) => JSON.parse(r.args[13]).kind)
    assert.deepEqual(kinds.sort(), ['critical', 'normal'])

    // 分钟翻页：先触发一次写入，补写上一分钟汇总
    clock += 60 * 1000
    await audit(env, null, { event: 'auth.login.ok' })
    const summaries = env.rows
      .filter((r) => eventOf(r) === 'audit.dropped')
      .map((r) => JSON.parse(r.args[13]))
      .filter((m) => m.kind === 'summary')
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].dropped, snap.dropped)
    assert.equal(summaries[0].droppedNormal, 10)
    assert.equal(summaries[0].droppedCritical, 601 - errors)
    assert.equal(auditBudgetSnapshot().dropped, 0)
  } finally {
    Date.now = realNow
  }
})

test('写入不抛异常：DB 报错只降级', async () => {
  const env = {
    DB: {
      prepare() {
        return { bind() { return { run: async () => { throw new Error('no such table: audit_logs') } } } }
      }
    }
  }
  await assert.doesNotReject(() => audit(env, null, { event: 'auth.logout' }))
})
