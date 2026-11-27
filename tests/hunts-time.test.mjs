// 赛事时间：pzc 的 startAt/endAt 是**不带时区的 UTC**（判据见 src/hunts.js 注释：
// 上游 status 在 UTC 08:45 时仍把 startAt=10:00 的场次判为 scheduled）。
// 要用北京时间展示必须换算，只贴 +08:00 后缀是错的——墙钟值仍是 UTC 的那个数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHuntTime, fetchHuntList } from '../src/hunts.js'
import { fmtHuntDay } from '../src/huntTime.js'

test('无时区的值按 UTC 解释，换算成 +08:00 墙钟', () => {
  const out = normalizeHuntTime('2026-11-27T10:00:00', 'Asia/Shanghai')
  assert.equal(out, '2026-11-27T18:00:00+08:00')
  // 绝对时刻不变：仍是 UTC 10:00，只是改用北京时间表达
  assert.equal(new Date(out).toISOString(), '2026-11-27T10:00:00.000Z')
})

test('跨日进位', () => {
  assert.equal(normalizeHuntTime('2026-11-27T16:00:00'), '2026-11-28T00:00:00+08:00')
  assert.equal(normalizeHuntTime('2026-11-27T20:00:00'), '2026-11-28T04:00:00+08:00')
})

test('带时区的按自身口径换算到 +08:00，且幂等', () => {
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00Z', 'Asia/Shanghai'), '2026-11-27T18:00:00+08:00')
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00+00:00', 'Asia/Shanghai'), '2026-11-27T18:00:00+08:00')
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00-05:00', 'Asia/Shanghai'), '2026-11-27T23:00:00+08:00')
  // 已经是 +08:00 的再跑一遍不能又加 8 小时
  assert.equal(normalizeHuntTime('2026-11-27T18:00:00+08:00', 'Asia/Shanghai'), '2026-11-27T18:00:00+08:00')
})

test('空值返回 null；空格分隔统一成 T', () => {
  assert.equal(normalizeHuntTime(null), null)
  assert.equal(normalizeHuntTime(''), null)
  assert.equal(normalizeHuntTime('   '), null)
  assert.equal(normalizeHuntTime('2026-11-27 10:00:00'), '2026-11-27T18:00:00+08:00')
})

test('未知时区回落到 +08:00', () => {
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00', 'Mars/Base'), '2026-11-27T18:00:00+08:00')
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00'), '2026-11-27T18:00:00+08:00')
})

test('展示层：带时区和裸 UTC 两种写法都显示北京时间', () => {
  assert.equal(fmtHuntDay('2026-11-27T18:00:00+08:00'), '11/27 18:00')
  // 旧快照里存的是裸 UTC 串，不能被当成东八区原样显示成 10:00
  assert.equal(fmtHuntDay('2026-11-27T10:00:00'), '11/27 18:00')
  assert.equal(fmtHuntDay('2026-11-27T10:00:00Z'), '11/27 18:00')
})

test('展示层：跨日与只有日期的情况', () => {
  assert.equal(fmtHuntDay('2026-11-27T20:00:00Z'), '11/28 04:00')
  assert.equal(fmtHuntDay('2026-11-27'), '11/27')
  assert.equal(fmtHuntDay(''), '')
  assert.equal(fmtHuntDay(null), '')
})

test('fetchHuntList 端到端：startAt 换算成 +08:00，endAt 缺失保持 null', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 200,
    data: {
      total: 1,
      items: [{
        id: 'abcd',
        title: '示例赛',
        startAt: '2026-11-27T10:00:00',
        endAt: null,
        timezone: 'Asia/Shanghai'
      }]
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const list = await fetchHuntList()
    assert.equal(list.length, 1)
    assert.equal(list[0].startAt, '2026-11-27T18:00:00+08:00')
    assert.equal(list[0].endAt, null, '没有结束时间时保持 null，不要凭空造')
  } finally {
    globalThis.fetch = saved
  }
})
