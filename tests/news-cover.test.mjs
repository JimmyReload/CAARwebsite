// 新闻封面：上传 → 存储（KV）→ 稿件引用 → 公开读取 的整条链路
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, api, ctx } from './helpers/d1.mjs'
import worker from '../src/worker.js'
import { COVER_MAX_BYTES, isCoverKey, detectCoverExt } from '../src/newsCover.js'

const MEMBER = 'm'.repeat(32)
const OTHER = 'o'.repeat(32)
const ADMIN = 'a'.repeat(32)

// 只要文件头够长就能被判型，后面补零当像素数据
function fakePng(extra = 64) {
  const b = new Uint8Array(12 + extra)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return b
}
function fakeJpeg(extra = 64) {
  const b = new Uint8Array(12 + extra)
  b.set([0xff, 0xd8, 0xff, 0xe0], 0)
  return b
}
function fakeWebp(extra = 64) {
  const b = new Uint8Array(12 + extra)
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0)
  return b
}

async function setup() {
  const env = makeEnv({ fullSchema: true })
  for (const [id, username, role] of [[1, 'admin', 'admin'], [3, 'member', 'user'], [4, 'other', 'user']]) {
    await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username, 'deadbeef:deadbeef', username + '昵称', role).run()
  }
  for (const [token, id] of [[ADMIN, 1], [MEMBER, 3], [OTHER, 4]]) await env.SESSIONS.put('s:' + token, id + ':0')
  return env
}

async function upload(env, { token = MEMBER, bytes = fakePng(), type = 'image/png', origin = 'https://caar.test' } = {}) {
  const headers = { 'content-type': type }
  if (token) headers.cookie = 'caar_session=' + token
  if (origin !== null) headers.origin = origin
  const res = await worker.fetch(new Request('https://caar.test/api/news/cover', { method: 'POST', headers, body: bytes }), env, ctx)
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const doc = () => ({ type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: '现场记录', marks: [] }] }] })

test('封面图头识别：只认 PNG / JPEG / WebP', () => {
  assert.equal(detectCoverExt(fakePng()), 'png')
  assert.equal(detectCoverExt(fakeJpeg()), 'jpg')
  assert.equal(detectCoverExt(fakeWebp()), 'webp')
  assert.equal(detectCoverExt(new Uint8Array([1, 2, 3])), '')
  // RIFF 但不是 WEBP（例如 wav）
  const wav = new Uint8Array(16); wav.set([0x52, 0x49, 0x46, 0x46], 0); wav.set([0x57, 0x41, 0x56, 0x45], 8);
  assert.equal(detectCoverExt(wav), '')
})

test('上传封面：返回绑定上传者的键与站内地址', async () => {
  const env = await setup()
  const res = await upload(env)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(isCoverKey(res.body.key), true, res.body.key)
  assert.match(res.body.key, /^news\/u3-[0-9a-f]{32}\.png$/)
  assert.equal(res.body.url, '/media/' + res.body.key)
  // 对象真的落到 MEDIA 里了，且存的长度与上传一致
  const stored = await env.MEDIA.get(res.body.key, { type: 'arrayBuffer' })
  assert.equal(stored.byteLength, fakePng().byteLength)
})

test('声明的类型与文件头不一致时拒绝（不信 Content-Type）', async () => {
  const env = await setup()
  const res = await upload(env, { bytes: fakeJpeg(), type: 'image/png' })
  assert.equal(res.status, 415)
})

test('非图片类型直接拒绝：text/plain 与 SVG 都不行', async () => {
  const env = await setup()
  assert.equal((await upload(env, { type: 'text/plain' })).status, 415)
  // SVG 是可执行文档，即使文件头伪装成 PNG 且声明 image/svg+xml 也不会通过
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  assert.equal((await upload(env, { bytes: svg, type: 'image/svg+xml' })).status, 415)
})

test('超过 2 MiB 拒绝；未登录拒绝', async () => {
  const env = await setup()
  const big = new Uint8Array(COVER_MAX_BYTES + 1)
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  assert.equal((await upload(env, { bytes: big })).status, 413)
  assert.equal((await upload(env, { token: null })).status, 401)
})

test('跨站来源的二进制上传仍被 CSRF 闸门挡住', async () => {
  const env = await setup()
  const res = await upload(env, { origin: 'https://evil.test' })
  assert.equal(res.status, 403)
})

test('稿件可引用自己的封面，公开列表与详情都带 coverUrl', async () => {
  const env = await setup()
  const up = await upload(env)
  const created = await api(worker, env, 'news', { method: 'POST', token: MEMBER, body: { title: '赛事现场', summary: '摘要', content: doc(), cover: up.body.key } })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.article.coverUrl, up.body.url)
  const id = created.body.article.id
  await api(worker, env, `admin/news/${id}`, { method: 'PATCH', token: ADMIN, body: { status: 'published' } })

  const list = await api(worker, env, 'news')
  assert.equal(list.body.list[0].coverUrl, up.body.url)
  const detail = await api(worker, env, `news/${id}`)
  assert.equal(detail.body.article.coverUrl, up.body.url)
  // 审核端也要能看见图，否则管理员不知道自己在批什么
  const review = await api(worker, env, `admin/news/${id}`, { token: ADMIN })
  assert.equal(review.body.article.coverUrl, up.body.url)
})

test('不能引用别人的封面，也不能引用不存在的键', async () => {
  const env = await setup()
  const up = await upload(env, { token: MEMBER })
  const stolen = await api(worker, env, 'news', { method: 'POST', token: OTHER, body: { title: 't', summary: '', content: doc(), cover: up.body.key } })
  assert.equal(stolen.status, 400)

  const ghost = 'news/u4-' + 'a'.repeat(32) + '.png'
  const missing = await api(worker, env, 'news', { method: 'POST', token: OTHER, body: { title: 't', summary: '', content: doc(), cover: ghost } })
  assert.equal(missing.status, 400)
})

test('没有封面的稿件照常提交，coverUrl 为空串', async () => {
  const env = await setup()
  const created = await api(worker, env, 'news', { method: 'POST', token: MEMBER, body: { title: '无图稿', summary: '', content: doc() } })
  assert.equal(created.status, 200)
  assert.equal(created.body.article.coverUrl, '')
})

test('公开读取封面：正确 Content-Type、可长缓存、支持 ETag 304', async () => {
  const env = await setup()
  const up = await upload(env, { bytes: fakeWebp(), type: 'image/webp' })
  const url = 'https://caar.test' + up.body.url
  const res = await worker.fetch(new Request(url), env, ctx)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/webp')
  assert.match(res.headers.get('cache-control'), /immutable/)
  const bytes = new Uint8Array(await res.arrayBuffer())
  assert.equal(bytes.byteLength, fakeWebp().byteLength)

  const cached = await worker.fetch(new Request(url, { headers: { 'if-none-match': res.headers.get('etag') } }), env, ctx)
  assert.equal(cached.status, 304)
})

test('非法键与不存在的键都回 404，不会去 KV 里乱翻', async () => {
  const env = await setup()
  for (const path of [
    '/media/news/nope.png',
    '/media/news/../users.sql',
    '/media/news/u3-' + 'b'.repeat(32) + '.png',
    '/media/news/u3-' + 'b'.repeat(32) + '.gif'
  ]) {
    const res = await worker.fetch(new Request('https://caar.test' + path), env, ctx)
    assert.equal(res.status, 404, path)
  }
})
