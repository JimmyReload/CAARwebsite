// 后台权限与输入上限的回归测试
//
// 对应 2026-11-23 渗透测试报告的三条：M-1（admin 可重置同级口令）、
// L-1（昵称写入路径口径不一致）、L-2（公告标题无上限，编辑还绕过正文上限）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, api } from './helpers/d1.mjs'

const worker = (await import('../src/worker.js')).default

const ADMIN = 'a'.repeat(32)
const ADMIN2 = 'b'.repeat(32)
const SUPER = 'c'.repeat(32)
const MEMBER = 'd'.repeat(32)

async function seed(env) {
  const ins = (id, username, role) =>
    env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username, 'deadbeef:deadbeef', username, role).run()
  await ins(1, 'super1', 'superadmin')
  await ins(2, 'admin1', 'admin')
  await ins(3, 'admin2', 'admin')
  await ins(4, 'member1', 'user')
  await env.SESSIONS.put('s:' + SUPER, '1:0')
  await env.SESSIONS.put('s:' + ADMIN, '2:0')
  await env.SESSIONS.put('s:' + ADMIN2, '3:0')
  await env.SESSIONS.put('s:' + MEMBER, '4:0')
}

const version = async (env, id) =>
  Number((await env.DB.prepare('SELECT session_version FROM users WHERE id = ?').bind(id).first()).session_version)

test('M-1：管理员不能重置同级管理员的口令', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const r = await api(worker, env, 'admin/users/3', {
    method: 'PATCH', token: ADMIN, body: { new_password: 'Another-Strong-9' }
  })
  assert.equal(r.status, 403, 'admin 不得通过改密横向接管另一个 admin')
  assert.match(r.body.error, /超管/)

  // 目标账号的口令与会话版本都不应变
  assert.equal(await version(env, 3), 0)
})

test('M-1：管理员仍可重置普通成员口令，且会话被踢', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const r = await api(worker, env, 'admin/users/4', {
    method: 'PATCH', token: ADMIN, body: { new_password: 'Another-Strong-9' }
  })
  assert.equal(r.status, 200, '重置普通成员口令属于正常管理操作')
  assert.equal(await version(env, 4), 1, '改密必须递增 session_version，踢掉旧会话')
})

test('M-1：超管可以重置管理员口令', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const r = await api(worker, env, 'admin/users/3', {
    method: 'PATCH', token: SUPER, body: { new_password: 'Another-Strong-9' }
  })
  assert.equal(r.status, 200)
  assert.equal(await version(env, 3), 1)
})

test('L-1：后台改昵称拒绝超长、空白、控制字符', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const tooLong = await api(worker, env, 'admin/users/4', { method: 'PATCH', token: ADMIN, body: { nickname: '长'.repeat(300) } })
  assert.equal(tooLong.status, 400, '超长昵称会进所有人的赛事列表，必须拒绝')

  const blank = await api(worker, env, 'admin/users/4', { method: 'PATCH', token: ADMIN, body: { nickname: '   ' } })
  assert.equal(blank.status, 400, '空白昵称不能写进库（报告中真实账号被误写成空串）')

  const bidi = await api(worker, env, 'admin/users/4', { method: 'PATCH', token: ADMIN, body: { nickname: 'abc\u202Edef' } })
  assert.equal(bidi.status, 400, '双向文本覆盖符能伪造列表显示顺序')

  const ok = await api(worker, env, 'admin/users/4', { method: 'PATCH', token: ADMIN, body: { nickname: '新名字' } })
  assert.equal(ok.status, 200)
  const row = await env.DB.prepare('SELECT nickname FROM users WHERE id = 4').first()
  assert.equal(row.nickname, '新名字')
})

test('L-1：用户自助改昵称与后台同一口径', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const tooLong = await api(worker, env, 'profile', { method: 'PATCH', token: MEMBER, body: { nickname: '长'.repeat(300) } })
  assert.equal(tooLong.status, 400)

  const blank = await api(worker, env, 'profile', { method: 'PATCH', token: MEMBER, body: { nickname: '' } })
  assert.equal(blank.status, 400)

  const ctrl = await api(worker, env, 'profile', { method: 'PATCH', token: MEMBER, body: { nickname: 'a\u0007b' } })
  assert.equal(ctrl.status, 400)

  const ok = await api(worker, env, 'profile', { method: 'PATCH', token: MEMBER, body: { nickname: '阿伟' } })
  assert.equal(ok.status, 200)
})

test('L-2：公告标题有上限，编辑不能绕过正文上限', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const longTitle = await api(worker, env, 'announcements', {
    method: 'POST', token: ADMIN, body: { title: '标'.repeat(300), content: '正文' }
  })
  assert.equal(longTitle.status, 400, '超长标题会撑大成员端列表响应')

  const created = await api(worker, env, 'announcements', {
    method: 'POST', token: ADMIN, body: { title: '正常标题', content: '正文' }
  })
  assert.equal(created.status, 200)
  const id = created.body.id

  const longContent = await api(worker, env, `admin/announcements/${id}`, {
    method: 'PATCH', token: ADMIN, body: { content: '正'.repeat(6000) }
  })
  assert.equal(longContent.status, 400, '创建限 5000，编辑不能成为绕过通道')

  const longTitlePatch = await api(worker, env, `admin/announcements/${id}`, {
    method: 'PATCH', token: ADMIN, body: { title: '标'.repeat(300) }
  })
  assert.equal(longTitlePatch.status, 400)

  const ok = await api(worker, env, `admin/announcements/${id}`, {
    method: 'PATCH', token: ADMIN, body: { title: '改后的标题' }
  })
  assert.equal(ok.status, 200)
})
