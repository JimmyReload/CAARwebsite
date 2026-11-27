import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, api, ctx } from './helpers/d1.mjs'
import worker from '../src/worker.js'

const SUPER = 's'.repeat(32)
const ADMIN = 'a'.repeat(32)
const MEMBER = 'm'.repeat(32)
const OTHER = 'o'.repeat(32)

async function setup() {
  const env = makeEnv({ fullSchema: true })
  const users = [
    [1, 'super', 'superadmin'], [2, 'admin', 'admin'], [3, 'member', 'user'], [4, 'other', 'user']
  ]
  for (const [id, username, role] of users) {
    await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username, 'deadbeef:deadbeef', username + '昵称', role).run()
  }
  for (const [token, id] of [[SUPER, 1], [ADMIN, 2], [MEMBER, 3], [OTHER, 4]]) await env.SESSIONS.put('s:' + token, id + ':0')
  return env
}

const richDoc = (text = '会员来稿') => ({ type: 'doc', children: [
  { type: 'heading', level: 2, children: [{ type: 'text', text: '现场记录', marks: ['bold'] }] },
  { type: 'paragraph', children: [{ type: 'text', text, marks: ['italic'] }] }
] })

async function submit(env, token = MEMBER, title = '赛事现场') {
  return api(worker, env, 'news', { method: 'POST', token, body: {
    title, summary: '一段摘要', content: richDoc()
  } })
}

test('仅已发布稿件出现在公开列表和详情；详情以结构化富文本返回', async () => {
  const env = await setup()
  const created = await submit(env)
  assert.equal(created.status, 200)
  const id = created.body.article.id

  const before = await api(worker, env, 'news')
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.list, [])
  const guestPreview = await worker.fetch(new Request('https://caar.test/api/news'), env, ctx)
  assert.equal(guestPreview.status, 200, 'anonymous list endpoint must be dispatched before auth gate')
  assert.deepEqual((await guestPreview.json()).list, [])
  const hidden = await api(worker, env, `news/${id}`)
  assert.equal(hidden.status, 404)

  const publish = await api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: ADMIN, body: { status: 'published' } })
  assert.equal(publish.status, 200)
  const after = await api(worker, env, 'news')
  assert.equal(after.body.total, 1)
  assert.equal(after.body.list[0].excerpt.type, 'doc')
  assert.equal(after.body.list[0].excerpt.children[0].type, 'heading')
  assert.equal(after.body.list[0].excerpt.children[0].children[0].text, '现场记录')
  assert.equal(after.body.list[0].excerpt.children[0].children[0].marks[0], 'bold')
  const detail = await api(worker, env, `news/${id}`)
  assert.equal(detail.status, 200)
  assert.equal((await api(worker, env, `news/${id}/extra`)).status, 404)
  assert.equal(detail.body.article.content.children[0].type, 'heading')
  assert.equal(detail.body.article.content.children[0].children[0].text, '现场记录')
})

test('投稿须登录；会员隔离只能读自己的稿，不能操作管理审核接口', async () => {
  const env = await setup()
  const anonymous = await api(worker, env, 'news', { method: 'POST', body: { title: '无会话', content: richDoc() } })
  assert.equal(anonymous.status, 401)
  const created = await submit(env)
  const other = await submit(env, OTHER, '另一份稿')
  assert.equal(created.status, 200)
  assert.equal(other.status, 200)
  const mine = await api(worker, env, 'news/mine', { token: MEMBER })
  assert.equal(mine.body.list.length, 1)
  assert.equal(mine.body.list[0].content_format, 'rich-v1')
  const privateDetail = await api(worker, env, `news/mine/${created.body.article.id}`, { token: MEMBER })
  assert.equal(privateDetail.status, 200)
  assert.equal(privateDetail.body.article.content.children[0].type, 'heading')
  assert.equal((await api(worker, env, `news/mine/${created.body.article.id}`, { token: OTHER })).status, 404)
  assert.equal((await api(worker, env, 'news/mine', { token: OTHER })).body.list.length, 1)
  assert.equal((await api(worker, env, 'admin/news', { token: MEMBER })).status, 403)
  assert.equal((await api(worker, env, `admin/news/${created.body.article.id}`, { method: 'PATCH', token: MEMBER, body: { status: 'published' } })).status, 403)
})

test('退回必须有审核意见；作者可修改后重投，状态回到待审核', async () => {
  const env = await setup()
  const created = await submit(env)
  const id = created.body.article.id
  const noNote = await api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: ADMIN, body: { status: 'rejected' } })
  assert.equal(noNote.status, 400)
  const rejected = await api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: ADMIN, body: { status: 'rejected', review_note: '请补充比赛日期' } })
  assert.equal(rejected.status, 200)
  const wrongOwner = await api(worker, env, `news/${id}/resubmit`, { method: 'POST', token: OTHER, body: { title: '冒领', summary: '', content: richDoc('改稿') } })
  assert.equal(wrongOwner.status, 409)
  const updated = await api(worker, env, `news/${id}/resubmit`, { method: 'POST', token: MEMBER, body: { title: '补充日期后的稿件', summary: '', content: richDoc('补充后的正文') } })
  assert.equal(updated.status, 200)
  const mine = await api(worker, env, 'news/mine', { token: MEMBER })
  assert.equal(mine.body.list[0].status, 'pending')
  assert.equal(mine.body.list[0].review_note, '')
  assert.equal(mine.body.list[0].title, '补充日期后的稿件')
  assert.equal((await api(worker, env, 'news')).body.total, 0)
})

test('并发审核同一稿件时只有一次状态迁移成功', async () => {
  const env = await setup()
  const created = await submit(env)
  const id = created.body.article.id
  const results = await Promise.all([
    api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: ADMIN, body: { status: 'published' } }),
    api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: SUPER, body: { status: 'rejected', review_note: '请修订' } }),
  ])
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.equal(results.filter((result) => result.status === 409).length, 1)
  const row = await env.DB.prepare('SELECT status FROM news_articles WHERE id = ?').bind(id).first()
  assert.ok(['published', 'rejected'].includes(row.status))
})

test('并发管理员审核同一待审稿时只允许一次状态迁移', async () => {
  const env = await setup()
  const created = await submit(env)
  const id = created.body.article.id
  const results = await Promise.all([
    api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: ADMIN, body: { status: 'published' } }),
    api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: SUPER, body: { status: 'rejected', review_note: '请修订' } }),
  ])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  const row = await env.DB.prepare('SELECT status FROM news_articles WHERE id = ?').bind(id).first()
  assert.ok(['published', 'rejected'].includes(row.status))
})

test('富文本请求体超过字节上限时及时拒绝', async () => {
  const env = await setup()
  const response = await api(worker, env, 'news', {
    method: 'POST', token: MEMBER, body: { content: ' '.repeat(140 * 1024) }
  })
  assert.equal(response.status, 413)
})

test('投稿待审队列达到五篇后拒绝新稿和退回稿重投', async () => {
  const env = await setup()
  const rejected = await submit(env, MEMBER, '先退回的稿件')
  const rejectedId = rejected.body.article.id
  await api(worker, env, `admin/news/${rejectedId}`, { method: 'PATCH', token: ADMIN, body: { status: 'rejected', review_note: '请修订' } })
  for (let i = 0; i < 5; i++) {
    const created = await submit(env, MEMBER, '赛事现场 ' + i)
    assert.equal(created.status, 200)
  }
  const blocked = await submit(env, MEMBER, '队列已满的稿件')
  assert.equal(blocked.status, 429)
  const resubmit = await api(worker, env, `news/${rejectedId}/resubmit`, { method: 'POST', token: MEMBER, body: { title: '修改后稿件', summary: '', content: richDoc() } })
  assert.equal(resubmit.status, 429)
  const mine = await api(worker, env, 'news/mine', { token: MEMBER })
  assert.equal(mine.body.list.length, 6)
  assert.equal(mine.body.list.find((item) => item.id === rejectedId).status, 'rejected')
})


test('迁移 0013/0014 建立完赛快照和退避字段', async () => {
  const { readFileSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))")
  db.exec(readFileSync(new URL('../migrations/0013_hunt_completion_cache.sql', import.meta.url), 'utf8'))
  let cols = db.prepare('PRAGMA table_info(hunt_completion_cache)').all().map((row) => row.name)
  assert.deepEqual(cols, ['id', 'payload', 'fetched_at', 'refresh_until'])
  db.prepare('INSERT INTO hunt_completion_cache (id, payload, fetched_at, refresh_until) VALUES (1, ?, ?, ?)').run('{}', 1, 0)
  db.exec(readFileSync(new URL('../migrations/0014_hunt_completion_retry_after.sql', import.meta.url), 'utf8'))
  cols = db.prepare('PRAGMA table_info(hunt_completion_cache)').all().map((row) => row.name)
  assert.ok(cols.includes('retry_after'))
  assert.equal(db.prepare('SELECT retry_after FROM hunt_completion_cache WHERE id=1').get().retry_after, 0, '既有单行缓存通过默认值平滑升级')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (?, ?)').get('0013_hunt_completion_cache', '0014_hunt_completion_retry_after').n, 2)
  db.close()
})


test('迁移 0012 在生产前序结构上保存唯一 puzzlecat_id', async () => {
  const { readFileSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT);`)
  const sql = readFileSync(new URL('../migrations/0012_add_puzzlecat_id.sql', import.meta.url), 'utf8')
  db.exec(sql)
  const columns = db.prepare('PRAGMA table_info(users)').all().map((row) => row.name)
  assert.ok(columns.includes('puzzlecat_id'))
  db.prepare('INSERT INTO users (id, username, email, puzzlecat_id) VALUES (?, ?, ?, ?)').run(1, 'a', 'a@example.test', 'profile-key')
  assert.throws(() => db.prepare('INSERT INTO users (id, username, email, puzzlecat_id) VALUES (?, ?, ?, ?)').run(2, 'b', 'b@example.test', 'profile-key'))
  // 旧账号和密码注册账号保持 NULL 可用，唯一索引只约束非 NULL 的已绑定值。
  db.prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(3, 'legacy', 'legacy@example.test')
  db.prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(4, 'password-user', 'pw@example.test')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE puzzlecat_id IS NULL').get().n, 2)
  assert.equal(db.prepare('SELECT version FROM schema_migrations').get().version, '0012_add_puzzlecat_id')
  db.close()
})

test('迁移 0011 在 schema_migrations 已存在时可完整执行', async () => {
  const { readFileSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const sql = readFileSync(new URL('../migrations/0011_news_articles.sql', import.meta.url), 'utf8')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))')
  db.exec(sql)
  const columns = db.prepare('PRAGMA table_info(news_articles)').all().map((row) => row.name)
  assert.ok(columns.includes('content_format'))
  assert.ok(columns.includes('review_note'))
  assert.equal(db.prepare('SELECT version FROM schema_migrations').get().version, '0011_news_articles')
  db.close()
})

test('富文本拖放/粘贴转换只输出安全标签并过滤危险元素和链接', async () => {
  const { sanitizedNewsHtmlFromTransfer } = await import('../src/newsContent.js')
  const previousParser = globalThis.DOMParser
  class FakeNode {
    constructor({ type, text = '', tag = '', attrs = {}, children = [] }) {
      this.nodeType = type
      this.nodeValue = text
      this.tagName = tag.toUpperCase()
      this.attrs = attrs
      this.childNodes = children
      this.children = children.filter((child) => child.nodeType === 1)
    }
    getAttribute(name) { return this.attrs[name] || null }
  }
  const text = (value) => new FakeNode({ type: 3, text: value })
  const el = (tag, attrs, ...children) => new FakeNode({ type: 1, tag, attrs, children })
  globalThis.DOMParser = class {
    parseFromString() {
      return { body: { childNodes: [
        el('h2', {}, text('Safe title')),
        el('p', {}, el('strong', {}, text('Safe text')), el('a', { href: 'javascript:alert(1)' }, text('bad link'))),
        el('p', {}, el('img', { src: 'x', onerror: 'alert(1)' }), el('script', {}, text('nested evil()'))),
        el('img', { src: 'x', onerror: 'alert(1)' }),
        el('script', {}, text('evil()')),
        el('p', {}, el('a', { href: 'https://example.test/path' }, text('safe link'))),
      ] } }
    }
  }
  try {
    const transfer = { getData: (type) => type === 'text/html' ? '<untrusted clipboard html>' : '' }
    const html = sanitizedNewsHtmlFromTransfer(transfer)
    assert.equal(html, '<h2>Safe title</h2><p><strong>Safe text</strong>bad link</p><p><a href="https://example.test/path">safe link</a></p>')
    const plain = sanitizedNewsHtmlFromTransfer({ getData: (type) => type === 'text/plain' ? '<img onerror=\"alert(1)\">' : '' })
    assert.equal(plain, '<p>&lt;img onerror=&quot;alert(1)&quot;&gt;</p>')
  } finally {
    if (previousParser === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = previousParser
  }
})

test('公开新闻摘录保留格式并严格限制文本长度', async () => {
  const { NEWS_CONTENT_MAX, newsDocumentExcerpt, newsDocumentText, normalizeNewsDocument } = await import('../src/newsContent.js')
  const excerpt = newsDocumentExcerpt({ type: 'doc', children: [
    { type: 'heading', level: 2, children: [{ type: 'text', text: '标题', marks: ['bold'] }] },
    { type: 'paragraph', children: [{ type: 'text', text: '甲乙丙丁戊己庚辛', marks: ['italic'], href: 'javascript:alert(1)' }] },
  ] }, 6)
  assert.deepEqual(excerpt.children[0].children[0].marks, ['bold'])
  assert.equal(Object.hasOwn(excerpt.children[1].children[0], 'href'), false)
  const long = { type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: '甲'.repeat(NEWS_CONTENT_MAX), marks: [] }] }] }
  const teaser = newsDocumentText(newsDocumentExcerpt(long, 240))
  assert.equal([...teaser].length, 240)
  assert.doesNotThrow(() => normalizeNewsDocument(newsDocumentExcerpt(long, 240)))
})

test('拒绝非 allow-list 富文本结构、不安全链接及超长内容', async () => {
  const { normalizeNewsDocument, NEWS_CONTENT_MAX } = await import('../src/newsContent.js')
  assert.equal(normalizeNewsDocument({ type: 'doc', children: [{ type: 'script', children: [] }] }), null)
  const doc = normalizeNewsDocument({ type: 'doc', children: [{ type: 'paragraph', children: [
    { type: 'text', text: '安全', marks: ['bold', 'unknown'], href: 'javascript:alert(1)' }
  ] }] })
  assert.deepEqual(doc.children[0].children[0].marks, ['bold'])
  assert.equal(Object.hasOwn(doc.children[0].children[0], 'href'), false)
  assert.equal(normalizeNewsDocument({ type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: '超'.repeat(NEWS_CONTENT_MAX + 1), marks: [] }] }] }), null)

  const env = await setup()
  const bad = await api(worker, env, 'news', { method: 'POST', token: MEMBER, body: { title: '坏数据', content: { type: 'doc', children: [{ type: 'script', children: [] }] } } })
  assert.equal(bad.status, 400)
})

test('已发布稿件可退回下线，作者修改后可重投；状态不符时 409 不误伤', async () => {
  const env = await setup()
  const created = await submit(env)
  const id = created.body.article.id
  const patch = (body, token = ADMIN) => api(worker, env, `admin/news/${id}`, { method: 'PATCH', token, body })

  assert.equal((await patch({ status: 'published' })).status, 200)
  assert.equal((await api(worker, env, 'news')).body.total, 1)

  // 没声明 from 的退回只作用于待审稿：已发布的稿子不该被顺手退掉
  assert.equal((await patch({ status: 'rejected', review_note: '内容过期' })).status, 409)
  // 退回必须写意见
  assert.equal((await patch({ status: 'rejected', from: 'published' })).status, 400)
  // 已发布稿件不能借 from:'published' 再发一次
  assert.equal((await patch({ status: 'published', from: 'published', review_note: 'x' })).status, 400)
  assert.equal((await api(worker, env, 'news')).body.total, 1, '失败的请求不应改动线上内容')

  const off = await patch({ status: 'rejected', from: 'published', review_note: '内容过期，请更新后重投' })
  assert.equal(off.status, 200)
  assert.equal(off.body.from, 'published')
  assert.equal((await api(worker, env, 'news')).body.total, 0, '下线后不应留在公开列表')
  assert.equal((await api(worker, env, `news/${id}`)).status, 404, '下线后详情页对匿名者 404')

  const adminRejected = await api(worker, env, 'admin/news?status=rejected', { token: ADMIN })
  assert.ok(adminRejected.body.list.some((item) => item.id === id), '退回的稿子应出现在「退回修改」分类里')

  // 重复退回：它已经不在 published，按状态不符拒绝
  assert.equal((await patch({ status: 'rejected', from: 'published', review_note: '再退一次' })).status, 409)

  // 作者侧能看到退回意见，并重新提交
  const mine = await api(worker, env, 'news/mine', { token: MEMBER })
  assert.equal(mine.body.list[0].status, 'rejected')
  assert.equal(mine.body.list[0].review_note, '内容过期，请更新后重投')
  const again = await api(worker, env, `news/${id}/resubmit`, { method: 'POST', token: MEMBER, body: { title: '赛事现场（修订）', summary: '一段摘要', content: richDoc('修订后') } })
  assert.equal(again.status, 200)

  // 重新审核通过后能再次上线
  assert.equal((await patch({ status: 'published' })).status, 200)
  assert.equal((await api(worker, env, 'news')).body.total, 1)
})
