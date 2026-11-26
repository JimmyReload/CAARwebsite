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

test('M-1 同族：管理员不能封禁同级管理员（拒绝服务）', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const r = await api(worker, env, 'admin/users/3', { method: 'PATCH', token: ADMIN, body: { banned: 1 } })
  assert.equal(r.status, 403, '封禁同级 admin 等于把对方踢下线且需他人解封，只能由超管做')

  const row = await env.DB.prepare('SELECT banned FROM users WHERE id = 3').first()
  assert.equal(Number(row.banned), 0, '被拒的请求不能改库')
})

test('M-1 同族：管理员不能改同级管理员的昵称', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const r = await api(worker, env, 'admin/users/3', { method: 'PATCH', token: ADMIN, body: { nickname: '被改名' } })
  assert.equal(r.status, 403)

  const row = await env.DB.prepare('SELECT nickname FROM users WHERE id = 3').first()
  assert.equal(row.nickname, 'admin2', '昵称不应被同级改写')
})

test('同族边界的另一侧：管理员可封禁普通成员，超管可封禁管理员', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  const banMember = await api(worker, env, 'admin/users/4', { method: 'PATCH', token: ADMIN, body: { banned: 1 } })
  assert.equal(banMember.status, 200, '封禁普通成员属于正常管理操作')

  const banAdmin = await api(worker, env, 'admin/users/3', { method: 'PATCH', token: SUPER, body: { banned: 1 } })
  assert.equal(banAdmin.status, 200, '超管可以封禁管理员')
})

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

test('管理员与超管都不能用 PATCH 重置自己的密码（必须走旧密码校验流程）', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)

  for (const [id, token] of [[1, SUPER], [2, ADMIN]]) {
    const r = await api(worker, env, `admin/users/${id}`, {
      method: 'PATCH', token, body: { new_password: 'Another-Strong-9' }
    })
    assert.equal(r.status, 403, '自助改密必须走 /change-password')
    assert.equal(await version(env, id), 0, '拒绝时不得增加会话版本')
  }
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

test('删号时同时清理该会员的新闻投稿（含已发布稿件），保留其他作者', async () => {
  const env = makeEnv({ fullSchema: true })
  await seed(env)
  const insert = async (authorId, title, status) => env.DB.prepare(
    'INSERT INTO news_articles (title, summary, content, author_id, author_name, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(title, '', '正文', authorId, 'member-' + authorId, status).run()
  await insert(4, '会员待审稿', 'pending')
  await insert(4, '会员已发布稿', 'published')
  await insert(3, '其他会员稿', 'published')

  const r = await api(worker, env, 'admin/users/4', { method: 'DELETE', token: SUPER })
  assert.equal(r.status, 200)
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM news_articles WHERE author_id = 4').first()).n), 0)
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM news_articles WHERE author_id = 3').first()).n), 1)
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
