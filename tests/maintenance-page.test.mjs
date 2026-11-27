// 页面导航不该看到裸错误码：任何 5xx/超时都换成维护页
// API 仍回 JSON（前端要读 error），静态子资源回 text/plain（HTML 会被当脚本解析）
import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/worker.js'
import { makeEnv, ctx } from './helpers/d1.mjs'
import { isPageNavigation } from '../src/maintenance.js'

const navReq = (path = '/') => new Request('https://caar.test' + path, {
  headers: { accept: 'text/html,application/xhtml+xml' }
})
const u = (p) => new URL('https://caar.test' + p)

test('页面导航判定：只认 HTML 页面，API / 静态子资源 / 非 GET 都不算', () => {
  assert.equal(isPageNavigation(navReq('/'), u('/')), true)
  assert.equal(isPageNavigation(navReq('/hunts?x=1'), u('/hunts?x=1')), true)
  assert.equal(isPageNavigation(navReq('/api/hunts'), u('/api/hunts')), false)
  assert.equal(isPageNavigation(navReq('/assets/index-abc.js'), u('/assets/index-abc.js')), false)
  assert.equal(isPageNavigation(navReq('/fonts/inter-900.woff2'), u('/fonts/inter-900.woff2')), false)
  assert.equal(isPageNavigation(navReq('/images/og-cover.png'), u('/images/og-cover.png')), false)
  assert.equal(isPageNavigation(navReq('/favicon.ico'), u('/favicon.ico')), false)
  assert.equal(isPageNavigation(
    new Request('https://caar.test/', { method: 'POST', headers: { accept: 'text/html' } }), u('/')
  ), false)
  // 没有 Accept: text/html 的客户端（curl / 脚本）不当作页面导航
  assert.equal(isPageNavigation(new Request('https://caar.test/'), u('/')), false)
})

test('静态层抛错：页面导航返回 503 维护页，而不是裸 5xx', async () => {
  const env = makeEnv({ fullSchema: true })
  env.ASSETS = { async fetch() { throw new Error('assets backend down') } }

  const res = await worker.fetch(navReq('/hunts'), env, ctx)
  assert.equal(res.status, 503)
  assert.match(res.headers.get('content-type') || '', /text\/html/)
  assert.equal(res.headers.get('retry-after'), '20')
  assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate')
  assert.ok(res.headers.get('x-request-id'), '维护页也要带请求编号，便于对照日志')
  assert.ok(res.headers.get('content-security-policy'), '安全响应头不能因为换页面而丢失')

  const html = await res.text()
  assert.match(html, /维护中/)
  assert.match(html, /http-equiv="refresh"/)
  assert.doesNotMatch(html, /assets backend down/, '不把内部错误暴露给浏览器')
})

test('静态层返回 5xx：同样换成维护页', async () => {
  const env = makeEnv({ fullSchema: true })
  env.ASSETS = { async fetch() { return new Response('oops', { status: 500 }) } }

  const res = await worker.fetch(navReq('/'), env, ctx)
  assert.equal(res.status, 503)
  assert.match(await res.text(), /维护中/)
})

test('页面导航超时：先给维护页，不让浏览器自己报连接超时', async () => {
  const env = makeEnv({ fullSchema: true })
  env.NAVIGATION_DEADLINE_MS = '1000'
  env.ASSETS = { fetch: () => new Promise(() => {}) }

  const started = Date.now()
  const res = await worker.fetch(navReq('/'), env, ctx)
  const elapsed = Date.now() - started

  assert.equal(res.status, 503)
  assert.match(await res.text(), /维护中/)
  assert.ok(elapsed >= 900, '应当等满期限再放弃，实际 ' + elapsed + 'ms')
})

test('API 出错仍返回 JSON，不换成维护页', async () => {
  const env = makeEnv({ fullSchema: true })
  env.DB = {
    prepare() { throw new Error('db down') },
    batch() { throw new Error('db down') }
  }

  const res = await worker.fetch(new Request('https://caar.test/api/news', {
    headers: { accept: 'application/json' }
  }), env, ctx)

  assert.ok(res.status >= 500, '预期 5xx，实际 ' + res.status)
  assert.match(res.headers.get('content-type') || '', /application\/json/)
  assert.ok((await res.json()).error, 'API 必须继续给 JSON 里的可读错误')
})

test('子资源 5xx 不回 HTML（HTML 会被浏览器当脚本解析）', async () => {
  const env = makeEnv({ fullSchema: true })
  env.ASSETS = { async fetch() { throw new Error('assets backend down') } }

  const res = await worker.fetch(new Request('https://caar.test/assets/index-abc.js', {
    headers: { accept: '*/*' }
  }), env, ctx)

  assert.equal(res.status, 503)
  assert.match(res.headers.get('content-type') || '', /text\/plain/)
  assert.equal(res.headers.get('retry-after'), '20')
})

test('入口 HTML 都取不到时给维护页，而不是空白 404', async () => {
  const env = makeEnv({ fullSchema: true })
  env.ASSETS = { async fetch() { return new Response('missing', { status: 404 }) } }

  const res = await worker.fetch(navReq('/account'), env, ctx)
  assert.equal(res.status, 503)
  assert.match(await res.text(), /维护中/)
})

test('未知路径的 SPA 兜底仍是 404，不会被误判成故障', async () => {
  const env = makeEnv({ fullSchema: true })
  env.ASSETS = {
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/index.html') {
        return new Response('<html><body>spa</body></html>', { headers: { 'content-type': 'text/html' } })
      }
      return new Response('missing', { status: 404 })
    }
  }

  const res = await worker.fetch(navReq('/nope'), env, ctx)
  assert.equal(res.status, 404)
  assert.match(await res.text(), /spa/)
})
