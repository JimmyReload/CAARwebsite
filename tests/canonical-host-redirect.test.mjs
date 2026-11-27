// www.caar.fun is a legacy alias; all HTTP methods and paths permanently canonicalize to apex.
import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/worker.js'
import { makeEnv, ctx } from './helpers/d1.mjs'

const env = makeEnv({ fullSchema: true })

test('www homepage redirects permanently to apex', async () => {
  const res = await worker.fetch(new Request('https://www.caar.fun/'), env, ctx)
  assert.equal(res.status, 308)
  assert.equal(res.headers.get('location'), 'https://caar.fun/')
})

test('www path and query are preserved on canonical redirect', async () => {
  const cases = [
    ['/news/article?id=17&from=www', 'https://caar.fun/news/article?id=17&from=www'],
    ['/normal/path?x=1&next=%2Faccount', 'https://caar.fun/normal/path?x=1&next=%2Faccount']
  ]

  for (const [path, expected] of cases) {
    const res = await worker.fetch(new Request('https://www.caar.fun' + path), env, ctx)
    assert.equal(res.status, 308, path)
    const location = res.headers.get('location')
    assert.equal(location, expected)
    assert.equal(new URL(location).origin, 'https://caar.fun', path)
  }
})

test('authority-like path variants stay on the canonical origin', async () => {
  const inputs = [
    'https://www.caar.fun//attacker.example/path?x=1',
    'https://www.caar.fun///attacker.example/path?x=1',
    String.raw`https://www.caar.fun/\\attacker.example/path?x=1`,
    String.raw`https://www.caar.fun/\\\\attacker.example/path?x=1`,
    'https://www.caar.fun/@attacker.example/path?x=1',
    'https://www.caar.fun/user@attacker.example/path?x=1',
    'https://www.caar.fun//user:pass@attacker.example/path?x=1',
    'https://www.caar.fun/normal/path?x=1'
  ]

  for (const input of inputs) {
    const res = await worker.fetch(new Request(input), env, ctx)
    assert.equal(res.status, 308, input)
    const location = res.headers.get('location')
    assert.ok(location, `missing Location for ${input}`)
    const redirected = new URL(location)
    assert.equal(redirected.origin, 'https://caar.fun', input)
    assert.equal(redirected.search, '?x=1', input)
  }
})

test('www OAuth start redirects to apex before setting state cookie', async () => {
  const oauthEnv = {
    ...env,
    PUZZLECAT_CLIENT_ID: 'app_test_id',
    PUZZLECAT_CLIENT_SECRET: 'app_test_secret',
    PUZZLECAT_REDIRECT_URI: 'https://caar.fun/api/oauth/puzzlecat/callback'
  }
  const res = await worker.fetch(new Request(
    'https://www.caar.fun/api/oauth/puzzlecat/start?next=%2Faccount'
  ), oauthEnv, ctx)
  assert.equal(res.status, 308)
  assert.equal(res.headers.get('location'), 'https://caar.fun/api/oauth/puzzlecat/start?next=%2Faccount')
  assert.equal(res.headers.get('set-cookie'), null, 'alias request should not create an unusable www host-only state cookie')
})

test('canonical apex is not redirected', async () => {
  const res = await worker.fetch(new Request('https://caar.fun/'), env, ctx)
  assert.notEqual(res.status, 308)
})
