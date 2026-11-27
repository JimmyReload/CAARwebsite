// 赛事时间：pzc 的 startAt/endAt 是**不带时区**的墙钟时间（timezone 默认 Asia/Shanghai），
// 例如 "2026-11-27T10:00:00"。抓取时必须补 +08:00，否则下游 new Date() 在 UTC 运行时
// （Worker）会按 UTC+0 解析，整块早 8 小时。这里锁住补后缀、不重复、不误改墙钟。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHuntTime, fetchHuntList } from '../src/hunts.js'

test('无时区的墙钟时间补 +08:00，墙钟值保持不变', () => {
  const out = normalizeHuntTime('2026-11-27T10:00:00', 'Asia/Shanghai')
  assert.equal(out, '2026-11-27T10:00:00+08:00')
  // 绝对时刻确实是北京时间 10:00（即 UTC 02:00），不再是 UTC 10:00
  assert.equal(new Date(out).toISOString(), '2026-11-27T02:00:00.000Z')
})

test('已带时区标记的原样保留，不重复追加', () => {
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00Z', 'Asia/Shanghai'), '2026-11-27T10:00:00Z')
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00+00:00', 'Asia/Shanghai'), '2026-11-27T10:00:00+00:00')
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00-05:00', 'Asia/Shanghai'), '2026-11-27T10:00:00-05:00')
})

test('空值返回 null；空格分隔统一成 T', () => {
  assert.equal(normalizeHuntTime(null), null)
  assert.equal(normalizeHuntTime(''), null)
  assert.equal(normalizeHuntTime('   '), null)
  assert.equal(normalizeHuntTime('2026-11-27 10:00:00'), '2026-11-27T10:00:00+08:00')
})

test('未知时区回落到 +08:00', () => {
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00', 'Mars/Base'), '2026-11-27T10:00:00+08:00')
  assert.equal(normalizeHuntTime('2026-11-27T10:00:00'), '2026-11-27T10:00:00+08:00')
})

test('fetchHuntList 端到端：规范化后 startAt 带 +08:00', async () => {
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
    assert.equal(list[0].startAt, '2026-11-27T10:00:00+08:00')
    assert.equal(list[0].endAt, null, '没有结束时间时保持 null，不要凭空造')
  } finally {
    globalThis.fetch = saved
  }
})
