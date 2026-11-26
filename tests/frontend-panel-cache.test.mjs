// 前端缓存层的账号隔离回归测试（审计 F-02 / F-03 的修复验收）
//
// 用「可控延迟的 fetch」精确制造审计里的时序：账号 A 的私信请求还在路上，
// 用户在同一页面上下文换成 B，然后 A 的响应才回来。断言：
//   · A / B 不会拿到同一条在途 Promise；
//   · B 收到的只有 B 的数据，A 的迟到响应被整份丢弃（Promise 解析为 null）；
//   · A 的数据不会写进 B 的缓存（内存 + sessionStorage）；
//   · 登出/换号推进 epoch 后旧响应一律作废；
//   · 退出登录失败时不得清本地身份（不假装已登出）；
//   · 身份未确认（/me 失败）时受保护页面不渲染缓存的私信内容。
//
// 只替换 fetch 与 sessionStorage，模块本身走真实实现（src/panelCache.js / src/huntsCache.js，
// 由 Vite SSR 加载，与审计时的探针方式一致）。
import test, { before, after } from 'node:test'
import path from 'node:path'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

function installSessionStorage() {
  const store = new Map()
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  return store
}

function installFetch() {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    let settle
    const gate = new Promise((resolve) => { settle = resolve })
    calls.push({
      url: String(url),
      init,
      ok: (payload) => settle({ ok: true, status: 200, json: async () => payload }),
      fail: (status, error) => settle({ ok: false, status, json: async () => ({ error }) }),
    })
    return gate
  }
  return calls
}

const store = installSessionStorage()
const calls = installFetch()
let server
let panel
let hunts
let huntsView

// src 里的相对 import 没写扩展名（Vite 负责解析），所以统一用 Vite SSR 加载真实模块。
before(async () => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
    plugins: [react()],
    // react-router 的 exports 在 node 条件下指向 CJS，SSR 里拿不到具名导出；
    // 直接指到 ESM 构建（只影响这个测试用的 Vite 实例）。用精确正则，避免误伤 react-router/dom 子路径。
    resolve: {
      alias: [
        { find: /^react-router-dom$/, replacement: path.resolve('node_modules/react-router-dom/dist/index.mjs') },
        { find: /^react-router$/, replacement: path.resolve('node_modules/react-router/dist/development/index.mjs') },
      ],
    },
  })
  panel = await server.ssrLoadModule('/src/panelCache.js')
  hunts = await server.ssrLoadModule('/src/huntsCache.js')
  huntsView = await server.ssrLoadModule('/src/views/HuntsView.jsx')
})

after(async () => { await server.close() })

test('HuntCard：缩略图主体放大裁切，且仅无图时显示标题占位', () => {
  const hunt = {
    id: 'tph', title: "Let's Try Puzzle Hunt", url: 'https://puzzle.cat/hunt/tph',
    thumb: 'https://cdn.example.test/tph.png', status: 'running', interested: [],
    tags: [], completedBy: [], mine: false, missing: false, type: 'regular',
    rating: 0, lang: 'en', external: false, startAt: '2026-11-01', endAt: null,
  }
  const markup = renderToStaticMarkup(React.createElement(huntsView.HuntCard, {
    hunt, pending: false, onToggle() {},
  }))
  assert.match(markup, /<img[^>]+src="https:\/\/cdn\.example\.test\/tph\.png"/)
  assert.doesNotMatch(markup, /hunt-thumb-fallback|hunt-fallback-text/)

  const css = readFileSync('src/index.css', 'utf8')
  assert.match(css, /\.hunt-thumb img\s*\{[^}]*object-fit:\s*cover[^}]*transform:\s*scale\(1\.5\)[^}]*transform-origin:\s*center/s)

  const noThumbMarkup = renderToStaticMarkup(React.createElement(huntsView.HuntCard, {
    hunt: { ...hunt, thumb: '' }, pending: false, onToggle() {},
  }))
  assert.match(noThumbMarkup, /hunt-thumb-fallback/)
  assert.match(noThumbMarkup, /Let&#x27;s Try Puzzle Hunt/)
})

function reset() {
  calls.length = 0
  store.clear()
  panel.resetPanelAuth()
  hunts.adoptHuntsIdentity(null)
}

const inbox = (convId, userId, text, id) => ({
  announcements: [],
  annVersion: 1,
  conv: { id: convId, user_id: userId },
  list: [{ id, direction: 'to_staff', content: text, created_at: '2026-11-23 10:00:00' }],
})

test('F-02：A 在途时切到 B，A/B 不共享 Promise，B 收不到 A 的私信', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  const pA = panel.fetchInbox(101)
  assert.equal(calls.length, 1)

  // 同一个页面上下文里登出再登录成 B
  panel.syncPanelAuth(202, true)
  const pB = panel.fetchInbox(202)
  assert.notEqual(pA, pB, 'A/B 不能共享同一条在途 Promise')
  assert.equal(calls.length, 2, 'B 必须自己发一条请求，不能复用 A 的在途请求')

  // A 的响应在切号之后才回来
  calls[0].ok(inbox(9001, 101, 'A-private-message', 11))
  assert.equal(await pA, null, 'A 的迟到响应必须被丢弃')
  assert.equal(panel.readInboxCache(101), null, 'A 的响应不能写进任何缓存')

  calls[1].ok(inbox(9002, 202, 'B-message', 21))
  const dB = await pB
  assert.equal(dB.conv.user_id, 202)
  assert.deepEqual(dB.list.map((m) => m.content), ['B-message'])

  const cacheB = panel.readInboxCache(202)
  assert.ok(cacheB, 'B 自己的响应要正常写进 B 的缓存')
  assert.equal(cacheB.conv.user_id, 202)
  assert.equal(JSON.stringify(cacheB).includes('A-private-message'), false, 'B 的缓存里不能出现 A 的私信')
  const stored = store.get('caar:inbox:v1') || ''
  assert.equal(stored.includes('A-private-message'), false, 'sessionStorage 里也不能留下 A 的私信')
  assert.equal(stored.includes('B-message'), true)
})

test('同一账号同一时刻只发一条 inbox 请求（按账号分区后仍复用）', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  const p1 = panel.fetchInbox(101)
  const p2 = panel.fetchInbox(101)
  assert.equal(p1, p2)
  assert.equal(calls.length, 1)
  calls[0].ok(inbox(9001, 101, 'hello', 1))
  assert.equal((await p1).conv.user_id, 101)
  assert.equal((await p2).conv.user_id, 101)
})

test('管理台概览同样按账号隔离：A 的 overview 不会交给 B', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  const pA = panel.fetchOverview(101)
  panel.syncPanelAuth(202, true)
  const pB = panel.fetchOverview(202)
  assert.notEqual(pA, pB)
  assert.equal(calls.length, 2)
  calls[0].ok({ users: [{ id: 101, username: 'alice-secret' }] })
  assert.equal(await pA, null)
  assert.equal(panel.readOverviewCache(101), null)
  calls[1].ok({ users: [{ id: 202, username: 'bob' }] })
  await pB
  assert.deepEqual(panel.readOverviewCache(202).users.map((u) => u.username), ['bob'])
  assert.equal(JSON.stringify(panel.readOverviewCache(202)).includes('alice-secret'), false)
})

test('正常的 200 {user:null}：清掉身份与面板缓存（与网络失败区分）', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  panel.writeInboxCache(101, inbox(9001, 101, 'cached', 1))
  panel.writeUserCache({ id: 101, username: 'alice' })
  assert.ok(panel.readInboxCache(101))

  // /me 成功返回 user:null → App 会这样同步
  panel.syncPanelAuth(null, true)
  assert.equal(panel.readInboxCache(101), null)
  assert.equal(panel.readUserCache(), null)
  assert.equal(store.size, 0)
  assert.equal(panel.isIdentityVerified(), true)
})

test('/me 网络失败：身份标记为未确认，但不把缓存当成已登录数据（也不清掉可重试的缓存）', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  panel.writeInboxCache(101, inbox(9001, 101, 'cached-private', 1))

  panel.markPanelAuthUnverified()
  assert.equal(panel.isIdentityVerified(), false, '身份未确认必须能被页面层观察到')
  // 缓存留着（重试成功后还能复用），但未经确认不会被渲染
  assert.ok(panel.readInboxCache(101))
})

test('退出登录失败：抛错、保留登录态与缓存，不能假装已登出', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  panel.writeInboxCache(101, inbox(9001, 101, 'still-here', 1))
  const p = panel.logoutSession()
  calls[0].fail(500, '服务异常')
  await assert.rejects(p, /服务异常/)
  assert.equal(panel.currentIdentity(), 101, '服务端没确认就不能把身份清掉')
  assert.equal(panel.isIdentityVerified(), true)
  assert.ok(panel.readInboxCache(101), '失败时不应清缓存')
})

test('退出登录成功：使用空 JSON 请求体，服务端确认后才清身份与缓存', async () => {
  reset()
  panel.syncPanelAuth(101, true)
  panel.writeInboxCache(101, inbox(9001, 101, 'to-be-cleared', 1))
  panel.writeUserCache({ id: 101, username: 'alice' })
  const p = panel.logoutSession()
  assert.equal(calls[0].url, '/api/logout')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.body, '{}', '需有 JSON Content-Type 满足 Worker CSRF 请求体检查')
  calls[0].ok({ ok: true })
  await p
  assert.equal(panel.currentIdentity(), null)
  assert.equal(panel.isIdentityVerified(), true)
  assert.equal(panel.readInboxCache(101), null)
  assert.equal(panel.readUserCache(), null)
})

test('冷启动无身份时不发匿名 /inbox（不得把匿名预取绑定到后来登录的账号）', async () => {
  reset()
  panel.resetPanelAuth()
  assert.equal(await panel.startInboxPrefetch(), null)
  assert.equal(calls.length, 0, '身份未确认时不应发出任何 inbox 预取')
  // 身份确认之后才允许预取
  panel.syncPanelAuth(101, true)
  const p = panel.startInboxPrefetch()
  assert.equal(calls.length, 1)
  calls[0].ok(inbox(9001, 101, 'after-confirm', 1))
  const d = await p
  assert.equal(d.conv.user_id, 101)
})

test('赛事请求：旧响应不覆盖新数据，也不跨账号写入', async () => {
  reset()
  hunts.syncHuntsAuth(101)
  const slow = hunts.fetchHunts(101)
  const fresh = hunts.fetchHunts(101, true) // 用户点了「刷新」
  assert.equal(calls.length, 2)

  calls[0].ok({ list: [{ id: 'old', title: 'OLD' }], total: 1 })
  assert.equal(await slow, null, '被更新请求取代的旧响应必须丢弃')
  calls[1].ok({ list: [{ id: 'new', title: 'NEW' }], total: 1 })
  const d = await fresh
  assert.equal(d.list[0].title, 'NEW')
  assert.equal(hunts.readHuntsCache(101).list[0].title, 'NEW')

  // 换账号后，A 还在途的响应也不得写进 B
  hunts.syncHuntsAuth(202)
  const pA = hunts.fetchHunts(101)
  hunts.syncHuntsAuth(202)
  calls[2].ok({ list: [{ id: 'a', title: 'A-HUNT' }], total: 1 })
  assert.equal(await pA, null)
  assert.equal(hunts.readHuntsCache(202), null)
})

test('客户端消息列表有上限（轮询拼接不会无界增长）', async () => {
  const view = await server.ssrLoadModule('/src/views/MemberView.jsx')
  const many = Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }))
  const merged = view.mergeMsgs([], many)
  assert.equal(merged.length, view.MAX_MESSAGES, '首次载入就应按上限截断')
  assert.equal(merged[merged.length - 1].id, 500, '截断必须保留最新的消息')

  const grown = view.mergeMsgs(merged, [{ id: 501 }])
  assert.equal(grown.length, view.MAX_MESSAGES, '增量拼接后仍然有界')
  assert.equal(grown[grown.length - 1].id, 501)
})

test('F-03 竞态：mount 时发出的旧 /me 不能覆盖随后登录的身份（auth epoch）', async () => {
  const app = await server.ssrLoadModule('/src/App.jsx')
  const gate = app.createAuthGate()
  let identity = null
  let verified = false

  // mount：refresh 发出，捕获当时的代次
  const snap = gate.snapshot()
  const delayed = new Promise((resolve) => setTimeout(resolve, 5))
    .then(() => gate.commit(snap, () => { identity = 'A-from-stale-me'; verified = true }))

  // 用户在此期间登录成功（useUser.adopt 会先 bump）
  gate.bump()
  identity = 'B-login'
  verified = true

  await delayed
  assert.equal(identity, 'B-login', '迟到的 /me 不能把身份覆盖回 A')
  assert.equal(gate.commit(snap, () => 'stale'), null, '过期代次的回调必须不执行')

  // 旧 /me 的失败回调同样过期：不能把刚登录的身份标记成「未确认」
  const snapFail = gate.snapshot()
  gate.bump()
  let markedUnverified = false
  gate.commit(snapFail, () => { verified = false; markedUnverified = true })
  assert.equal(markedUnverified, false)
  assert.equal(verified, true)

  // 当前代次的 refresh 正常生效
  const snapOk = gate.snapshot()
  gate.commit(snapOk, () => { identity = 'B-confirmed' })
  assert.equal(identity, 'B-confirmed')
})

test('F-03 竞态：并发 /me 只有最后发起的那一个能落地（旧先回/后回都不改写）', async () => {
  const app = await server.ssrLoadModule('/src/App.jsx')
  const gate = app.createAuthGate()
  let identity = null
  let verified = false

  // 两次 refresh 先后发起：各自 bump 取号，先发起的那次立即过期
  const snapA = gate.bump()
  const snapB = gate.bump()

  // 情况一：旧请求 A 先返回 —— 不得把自己（可能已被服务端踢下线）的 null 身份写进去
  gate.commit(snapA, () => { identity = null; verified = true })
  assert.equal(identity, null, 'A 已过期，不能提交任何结果')
  // 新请求 B 返回并落地
  gate.commit(snapB, () => { identity = 'B-ok'; verified = true })
  assert.equal(identity, 'B-ok')

  // 情况二：新请求先返回，旧请求后返回 —— 旧结果仍须忽略
  const snapC = gate.bump()
  const snapD = gate.bump()
  gate.commit(snapD, () => { identity = 'D-ok' })
  gate.commit(snapC, () => { identity = 'C-stale' })
  assert.equal(identity, 'D-ok', '晚回的旧请求不得改写新结果')

  // 旧请求的失败回调同样过期，不能把刚确认的身份标记成未确认
  const snapE = gate.bump()
  gate.bump()
  let marked = false
  gate.commit(snapE, () => { verified = false; marked = true })
  assert.equal(marked, false)
  assert.equal(verified, true)
})

test('visibilitychange 身份复核：先隐藏旧身份，再只在 /me 确认后采纳新身份', async () => {
  const app = await server.ssrLoadModule('/src/App.jsx')
  const authGate = app.createAuthGate()
  const events = []
  let identity = 'A'
  let user = { id: 'A' }
  let verified = true
  let ready = true
  let unread = 3
  let resolveRequest
  const request = () => new Promise((resolve) => { resolveRequest = resolve })
  const refresh = app.createAuthRefresher({
    authGate,
    request,
    adopt: (nextUser, isVerified) => { user = nextUser; identity = nextUser && nextUser.id; verified = isVerified; events.push(['adopt', identity]) },
    markUnverified: () => { events.push(['hide', identity]); verified = false },
    setVerified: (value) => { verified = value },
    setReady: (value) => { ready = value },
    setNotifUnread: (value) => { unread = value },
    setAuthError: () => {}
  })
  let listener
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { assert.equal(name, 'visibilitychange'); listener = fn },
    removeEventListener: (name, fn) => { assert.equal(name, 'visibilitychange'); listener = null }
  }
  const cleanup = app.bindVisibilityRefresh(doc, refresh)
  const pending = listener()
  assert.deepEqual(events, [['hide', 'A']], '请求期间必须先屏蔽旧身份内容')
  assert.equal(verified, false)
  assert.equal(ready, true, 'visibility refresh 不改动初始加载 ready 状态，避免加载 UI 竞态')
  assert.equal(app.gate({ ready, verified, user, children: 'private A' }).type.name, 'IdentityUnverified', '旧用户的保护页面必须在确认期间卸载')
  assert.equal(identity, 'A', '尚未确认时不能把快照身份当成新确认身份')
  resolveRequest({ user: { id: 'B' }, notifUnread: 9 })
  assert.deepEqual(await pending, { id: 'B' })
  assert.deepEqual(events, [['hide', 'A'], ['adopt', 'B']])
  assert.equal(identity, 'B')
  assert.equal(verified, true)
  assert.equal(unread, 9)
  cleanup()
  assert.equal(listener, null)
})

test('身份复核开始立即作废私有缓存在途请求，即使 /me 失败也不缓存跨标签账号数据', async () => {
  reset()
  const app = await server.ssrLoadModule('/src/App.jsx')
  panel.syncPanelAuth(101, true)
  hunts.syncHuntsAuth(101)
  panel.writeInboxCache(101, inbox(9001, 101, 'old-cache', 1))
  const inboxFlight = panel.fetchInbox(101)
  const huntsFlight = hunts.fetchHunts(101)
  let rejectMe
  const refresh = app.createAuthRefresher({
    authGate: app.createAuthGate(),
    request: () => new Promise((_resolve, reject) => { rejectMe = reject }),
    adopt: () => assert.fail('failed /me must not adopt an identity'),
    invalidate: () => { panel.clearPanelCache(); hunts.clearHuntsCache() },
    markUnverified: panel.markPanelAuthUnverified,
    setVerified: () => {},
    setNotifUnread: () => {},
    setAuthError: () => {}
  })
  const verifying = refresh()
  assert.equal(panel.readInboxCache(101), null)
  calls[0].ok(inbox(9002, 202, 'other-tab-private', 21))
  calls[1].ok({ list: [{ id: 'other-tab-hunt' }] })
  assert.equal(await inboxFlight, null)
  assert.equal(await huntsFlight, null)
  rejectMe(new Error('offline'))
  assert.equal(await verifying, null)
  assert.equal(panel.isIdentityVerified(), false)
  assert.equal(panel.readInboxCache(101), null)
  assert.equal(hunts.readHuntsCache(101), null)
  assert.equal([...store.values()].some((value) => value.includes('other-tab-private')), false)
})

test('HuntsView：成功加载 pending 快照会启用轮询，不触发未声明变量错误', async () => {
  const committed = []
  const pendingStates = []
  const next = huntsView.applyHuntsResponse({ list: [], mineCount: 0, total: 2, completionsPending: true }, (value) => committed.push(value), (value) => pendingStates.push(value))
  assert.equal(next.completionsPending, true)
  assert.equal(committed[0].total, 2)
  assert.deepEqual(pendingStates, [true])

  const scheduled = []
  const cancelled = []
  const results = []
  let requests = 0
  const cleanup = huntsView.startCompletionPolling({
    userId: 101,
    isCurrent: () => true,
    request: async () => { requests += 1; return { pending: true } },
    onResult: (result) => results.push(result),
    onError: (error) => { throw error },
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length },
    cancel: (id) => cancelled.push(id)
  })
  assert.equal(scheduled.length, 1, 'pending 状态应启动首轮轮询')
  assert.equal(scheduled[0].delay, 1000)
  await scheduled[0].fn()
  assert.equal(requests, 1)
  assert.deepEqual(results, [{ pending: true }])
  assert.equal(scheduled.length, 2, '服务端仍 pending 时继续轮询')
  // Finish the bounded retry window; it must cover the 12.5s worst-case provider batch.
  for (let index = 1; index < 12; index += 1) await scheduled[index].fn()
  assert.equal(requests, 12)
  assert.equal(scheduled.length, 12, '达到上限后不再安排无限轮询')
  assert.ok(scheduled.reduce((total, item) => total + item.delay, 0) >= 12500)
  assert.equal(results.at(-1).pending, false)
  cleanup()
  assert.deepEqual(cancelled, [12])
})

test('F-03：/me 未确认时受保护页面渲染重试界面，不把缓存的私信内容交给 children', async () => {
  const React = (await import('react')).default
  const app = await server.ssrLoadModule('/src/App.jsx')
  const secret = React.createElement('div', null, 'A-private-message')
  const base = { ready: true, user: { id: 101, username: 'alice' }, refresh: () => {} }

  const unverified = app.gate({ ...base, verified: false, authError: '请求超时', children: secret })
  assert.equal(unverified.type.name, 'IdentityUnverified')
  assert.equal(unverified.props.children, undefined, '未确认时不能把受保护内容渲染出去')

  const pending = app.gate({ ...base, ready: false, verified: false, authError: '', children: secret })
  assert.equal(pending.type.name, 'IdentityPending')

  const verified = app.gate({ ...base, verified: true, authError: '', children: secret })
  assert.equal(verified, secret, '确认之后正常渲染页面')

  const loggedOut = app.gate({ ...base, user: null, verified: true, authError: '', children: secret })
  assert.notEqual(loggedOut, secret)
  assert.equal(loggedOut.type.name, 'Navigate')

  // key={user.id}：受保护组件只在身份确认后才构造，且一定带账号 key（账号切换=卸载重建）
  let rendered = 0
  const renderer = (user) => {
    rendered += 1
    return React.createElement('div', { key: user.id }, user.username)
  }
  const blocked = app.gate({ ...base, verified: false, authError: '请求超时', render: renderer })
  assert.equal(blocked.type.name, 'IdentityUnverified')
  assert.equal(rendered, 0, '未确认时不能执行页面渲染函数')
  const built = app.gate({ ...base, verified: true, authError: '', render: renderer })
  assert.equal(rendered, 1)
  assert.equal(built.key, String(base.user.id), '页面实例必须按账号 id 加 key')
})
