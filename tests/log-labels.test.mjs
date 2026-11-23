// 审计事件中文名
//
// 两件事要守住：
// 1) eventLabel 对已知事件给中文，对未知事件原样返回 id（不能出现空白标签）；
// 2) 源码里新增的事件 id 必须配文案 —— 否则面板上会突然冒出一串英文 id。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { eventLabel } from '../src/i18n.js'
import zhCN from '../src/locales/zh-CN.js'

const LABELS = zhCN.logEventLabels

test('已知事件返回中文名', () => {
  assert.equal(eventLabel('auth.login.ok'), '登录成功')
  assert.equal(eventLabel('admin.user.password_reset'), '重置用户口令')
  assert.equal(eventLabel('client.error'), '客户端报错')
})

test('未知事件原样返回 id，不返回空串', () => {
  assert.equal(eventLabel('some.new.event'), 'some.new.event')
  assert.equal(eventLabel(''), '')
  assert.equal(eventLabel(null), '')
})

test('源码中出现的每一个审计事件 id 都配了中文名', () => {
  // 只扫会写审计/日志的两个文件；匹配形如 auth.login.ok 的点分 id
  const files = ['../src/worker.js', '../src/log.js']
  const re = /['"]((?:auth|admin|announcement|client|request|http|support|cron|audit|verify|mail)\.[a-z0-9._]+)['"]/g
  const missing = new Set()
  const seen = new Set()

  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    for (const m of src.matchAll(re)) {
      seen.add(m[1])
      if (!LABELS[m[1]]) missing.add(m[1])
    }
  }

  assert.ok(seen.size > 20, '扫描到的事件数异常，正则可能失效了')
  assert.deepEqual([...missing].sort(), [], '以下事件缺少中文名：' + [...missing].sort().join(', '))
})
