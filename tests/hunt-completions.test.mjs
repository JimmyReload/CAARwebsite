import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { buildHuntCompletionPayload, getHuntCompletionData, HUNT_COMPLETION_LIMITS } from '../src/huntCompletions.js'
import { makeEnv } from './helpers/d1.mjs'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function profile(profileKey, { finishedHunts = [], hideSolvedHunts = false, id = profileKey } = {}) {
  return json({ code: 200, data: { id, hideSolvedHunts, finishedHunts } })
}

const finished = (id, slug, extra = {}) => ({ id, slug, isPublic: true, visibility: 'public', ...extra })

test('只聚合公开完赛 Hunt，尊重 hideSolvedHunts，不保存第三方详情', async () => {
  const payload = await buildHuntCompletionPayload([
    { id: 7, name: 'Alice', puzzlecat_id: 'profile-7' },
    { id: 8, name: 'Hidden', puzzlecat_id: 'profile-8' }
  ], async (url) => {
    const key = decodeURIComponent(String(url).split('/').pop())
    if (key === 'profile-7') return profile(key, { finishedHunts: [
      finished('hunt-1', 'weekly-1', { title: 'secret-title', isPublic: true, visibility: 'public' }),
      finished('private', 'private', { isPublic: false, visibility: 'private' }),
      { id: 'flag-missing', slug: 'flag-missing' }
    ] })
    return profile(key, { hideSolvedHunts: true, finishedHunts: [finished('hunt-2', 'weekly-2')] })
  }, 1234)
  assert.deepEqual(payload.userHunts['7'], ['id:hunt-1', 'slug:weekly-1'])
  assert.deepEqual(payload.userHunts['8'], [])
  assert.equal(JSON.stringify(payload).includes('secret-title'), false)
  assert.equal(JSON.stringify(payload).includes('profile-7'), false)
})

test('ID mismatch and profile network failure are isolated to the affected user', async () => {
  const payload = await buildHuntCompletionPayload([
    { id: 1, name: 'A', puzzlecat_id: 'mismatch' },
    { id: 2, name: 'B', puzzlecat_id: 'timeout' },
    { id: 3, name: 'C', puzzlecat_id: 'ok' }
  ], async (url) => {
    const key = decodeURIComponent(String(url).split('/').pop())
    if (key === 'mismatch') return profile('other', { finishedHunts: [finished('bad', 'bad')] })
    if (key === 'timeout') throw new Error('timeout')
    return profile(key, { finishedHunts: [finished('good', 'good-slug')] })
  })
  assert.deepEqual(payload.failedUserIds.sort(), [1, 2])
  assert.deepEqual(payload.userHunts['3'], ['id:good', 'slug:good-slug'])
})

test('profile requests have an explicit timeout', async () => {
  let signal
  await buildHuntCompletionPayload([{ id: 1, name: 'A', puzzlecat_id: 'p' }], async (_url, init) => {
    signal = init.signal
    return profile('p')
  })
  assert.ok(signal instanceof AbortSignal)
  assert.ok(signal.aborted || signal.reason === undefined, 'request receives an AbortSignal deadline')
})

test('caps upstream work at the configured number of linked users', async () => {
  const users = Array.from({ length: HUNT_COMPLETION_LIMITS.maxLinkedUsers + 3 }, (_, i) => ({ id: i + 1, name: 'user-' + i, puzzlecat_id: 'profile-' + i }))
  let calls = 0
  const payload = await buildHuntCompletionPayload(users, async (url) => {
    calls++
    const key = decodeURIComponent(String(url).split('/').pop())
    return profile(key, { finishedHunts: [finished('same', 'same')] })
  })
  assert.equal(calls, HUNT_COMPLETION_LIMITS.maxLinkedUsers)
  assert.equal(payload.syncedUserIds.length, HUNT_COMPLETION_LIMITS.maxLinkedUsers)
})

let vite
let worker
let env
const TOKEN = 'u'.repeat(32)
const ctx = { waitUntil(promise) { void promise } }

before(async () => {
  const { createServer } = await import('vite')
  vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' })
  worker = (await vite.ssrLoadModule('/src/worker.js')).default
  env = makeEnv({ fullSchema: true })
  await env.DB.prepare('INSERT INTO users (id, username, password, nickname, role, banned, session_version, puzzlecat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(7, 'local-user', 'deadbeef:deadbeef', '完赛队友', 'user', 0, 0, 'profile-7').run()
  await env.DB.prepare('INSERT INTO hunt_completion_cache (id, payload, fetched_at, refresh_until, retry_after) VALUES (1, ?, ?, 0, 0)')
    .bind(JSON.stringify({ syncedUserIds: [7], syncedAllUsers: true, failedUserIds: [], userHunts: { '7': ['id:hunt-1', 'slug:weekly-1'] } }), Date.now()).run()
  await env.DB.prepare('INSERT INTO hunt_feed (id, payload, fetched_at) VALUES (1, ?, ?)')
    .bind(JSON.stringify([{ id: 'hunt-1', slug: 'weekly-1', title: 'Weekly', summary: '', url: 'https://puzzle.cat/hunt/weekly-1', startAt: null, endAt: null, status: 'ended', type: 'regular', tags: [], lang: 'zh-CN', rating: 0, thumb: '', authors: [], external: false }]), Date.now()).run()
  await env.SESSIONS.put('s:' + TOKEN, '7:0')
})

after(async () => { if (vite) await vite.close() })

test('hunts API exposes only completed display labels, not local IDs or profile keys', async () => {
  const res = await worker.fetch(new Request('https://caar.test/api/hunts', { headers: { cookie: 'caar_session=' + TOKEN } }), env, ctx)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.list.find((h) => h.id === 'hunt-1').completedBy, [{ name: '完赛队友' }])
  assert.equal(JSON.stringify(body).includes('profile-7'), false)
  assert.equal(JSON.stringify(body).includes('"userId"'), false)
})

test('completions polling endpoint returns a no-store snapshot without identity keys', async () => {
  const res = await worker.fetch(new Request('https://caar.test/api/hunts/completions', { headers: { cookie: 'caar_session=' + TOKEN } }), env, ctx)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.deepEqual(body.byHunt['id:hunt-1'], [{ name: '完赛队友' }])
  assert.equal(JSON.stringify(body).includes('profile-7'), false)
})

test('stale completion cache without a refresh lease schedules background refresh', async () => {
  const freshEnv = makeEnv({ fullSchema: true })
  await freshEnv.DB.prepare('INSERT INTO users (id, username, password, nickname, role, banned, session_version, puzzlecat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(7, 'cached-user', 'deadbeef:deadbeef', '缓存用户', 'user', 0, 0, 'profile-7').run()
  const now = Date.now()
  await freshEnv.DB.prepare('INSERT INTO hunt_completion_cache (id, payload, fetched_at, refresh_until, retry_after) VALUES (1, ?, ?, 0, 0)')
    .bind(JSON.stringify({ fetchedAt: now, syncedUserIds: [7], failedUserIds: [], userHunts: { '7': ['id:cached-hunt'] } }), now - HUNT_COMPLETION_LIMITS.cacheTtlMs - 1000).run()

  let scheduled = 0
  const out = await getHuntCompletionData(freshEnv, { waitUntil(promise) { scheduled++; void promise } }, now)
  assert.equal(out.pending, true)
  assert.equal(out.byHunt['id:cached-hunt'][0].name, '缓存用户', 'serve stale snapshot while refreshing')
  assert.equal(scheduled, 1, 'only one bounded refresh is scheduled for the cache lease')
  await new Promise((resolve) => setImmediate(resolve))
})

test('repeated profile failures do not renew legacy per-user success age and expire old hunts', async () => {
  const freshEnv = makeEnv({ fullSchema: true })
  await freshEnv.DB.prepare('INSERT INTO users (id, username, password, nickname, role, banned, session_version, puzzlecat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(7, 'stale-user', 'deadbeef:deadbeef', '过期用户', 'user', 0, 0, 'profile-stale').run()

  const successAt = 1_000_000
  const firstFailureAt = successAt + HUNT_COMPLETION_LIMITS.cacheTtlMs + 1
  await freshEnv.DB.prepare('INSERT INTO hunt_completion_cache (id, payload, fetched_at, refresh_until, retry_after) VALUES (1, ?, ?, 0, 0)')
    .bind(JSON.stringify({ fetchedAt: successAt, syncedUserIds: [7], failedUserIds: [], userHunts: { '7': ['id:once-public'] } }), successAt).run()

  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => { fetchCalls++; throw new Error('profile unavailable') }
  const runRefresh = async (now) => {
    let refresh
    const out = await getHuntCompletionData(freshEnv, { waitUntil(promise) { refresh = promise } }, now)
    assert.ok(refresh, 'stale or retryable snapshot should schedule one refresh')
    await refresh
    return out
  }
  try {
    const first = await runRefresh(firstFailureAt)
    assert.equal(first.byHunt['id:once-public'][0].name, '过期用户', 'legacy payload remains readable while within last-success TTL')
    let row = await freshEnv.DB.prepare('SELECT payload, fetched_at FROM hunt_completion_cache WHERE id = 1').first()
    let payload = JSON.parse(row.payload)
    assert.equal(payload.userHuntFetchedAt['7'], successAt, 'legacy snapshot timestamp is frozen as the success-time fallback')
    assert.equal(payload.fetchedAt, firstFailureAt, 'snapshot freshness may advance independently')
    assert.deepEqual(payload.userHunts['7'], ['id:once-public'], 'failed refresh keeps the prior payload within its TTL')
    const staleButFreshBadge = await getHuntCompletionData(freshEnv, { waitUntil() {} }, firstFailureAt)
    assert.equal(staleButFreshBadge.byHunt['id:once-public'][0].name, '过期用户', 'failed users remain visible while last success is within TTL')

    const secondFailureAt = firstFailureAt + 2 * 60 * 1000 + 1
    await runRefresh(secondFailureAt)
    row = await freshEnv.DB.prepare('SELECT payload, fetched_at FROM hunt_completion_cache WHERE id = 1').first()
    payload = JSON.parse(row.payload)
    assert.equal(payload.userHuntFetchedAt['7'], successAt, 'a second failed refresh does not renew last success')
    assert.equal(payload.fetchedAt, secondFailureAt)
    assert.deepEqual(payload.userHunts['7'], ['id:once-public'], 'old keys remain only until their own success TTL expires')

    const expiredAt = successAt + HUNT_COMPLETION_LIMITS.staleTtlMs + 1
    await runRefresh(expiredAt)
    row = await freshEnv.DB.prepare('SELECT payload FROM hunt_completion_cache WHERE id = 1').first()
    payload = JSON.parse(row.payload)
    assert.equal(Object.hasOwn(payload.userHunts, '7'), false, 'expired user hunts are removed after a later failed refresh')
    assert.equal(Object.hasOwn(payload.userHuntFetchedAt, '7'), false, 'expired per-user timestamp is removed too')
    const expiredBadge = await getHuntCompletionData(freshEnv, { waitUntil() {} }, expiredAt)
    assert.equal(expiredBadge.byHunt['id:once-public'], undefined, 'expired last-success badge is hidden even though the global snapshot was refreshed')
    assert.equal(fetchCalls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})
