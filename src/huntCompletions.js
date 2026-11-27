// Cached badges for explicitly public finished Hunt entries from linked profiles.
// The cache stores only local user ids and public Hunt ids/slugs, never tokens or emails.
const PROFILE_API = 'https://puzzle.cat/api/users/'
const CACHE_ID = 1
const CACHE_TTL_MS = 10 * 60 * 1000
const STALE_TTL_MS = 12 * 60 * 60 * 1000
const REFRESH_LEASE_MS = 2 * 60 * 1000
const RETRY_BACKOFF_MS = 2 * 60 * 1000
const PROFILE_TIMEOUT_MS = 2500
const MAX_LINKED_USERS = 40
const MAX_ITEMS_PER_PROFILE = 100
const MAX_KEYS_PER_PROFILE = MAX_ITEMS_PER_PROFILE * 2
const MAX_BADGES_PER_HUNT = 8
const MAX_LABEL_LENGTH = 40
const CONCURRENCY = 8

function activeUserIdsSql() {
  return 'SELECT CAST(id AS TEXT) FROM users WHERE banned = 0 AND puzzlecat_id IS NOT NULL'
}

export function prepareHuntCompletionCacheCleanup(db, userId = null) {
  // Deletion and zero-bound-user cleanup share one JSON1 read-modify-write. The
  // single UPDATE reads the live row in SQLite, so no stale JS snapshot can
  // overwrite another user's concurrently refreshed map entry.
  const hasUserId = userId !== null && userId !== undefined
  const params = [CACHE_ID]
  let sourceCte = 'SELECT cache_source.payload FROM cache_source'
  if (hasUserId) {
    const id = Number(userId)
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('userId must be a positive safe integer')
    sourceCte = 'SELECT json_remove(cache_source.payload, ?, ?) AS payload FROM cache_source'
    params.push('$.userHunts.' + JSON.stringify(String(id)), '$.userHuntFetchedAt.' + JSON.stringify(String(id)))
  }
  params.push(CACHE_ID)
  const objectMap = (property) => {
    const alias = 'entry'
    const value = `CASE WHEN ${alias}.type IN ('object', 'array') THEN json(${alias}.value) ELSE ${alias}.value END`
    return `json(COALESCE((SELECT json_group_object(${alias}.key, ${value})
      FROM json_each(source.payload, '$.${property}') AS ${alias}
      WHERE ${alias}.key IN (${activeUserIdsSql()})), '{}'))`
  }
  const idArray = (property) => `json(COALESCE((SELECT json_group_array(value)
    FROM json_each(source.payload, '$.${property}')
    WHERE CAST(value AS TEXT) IN (${activeUserIdsSql()})), '[]'))`
  return db.prepare(`
    WITH cache_source(payload) AS (
      SELECT CASE WHEN json_valid(payload) THEN payload ELSE '{}' END
        FROM hunt_completion_cache WHERE id = ?
    ), source(payload) AS (${sourceCte}), cleaned(payload) AS (
      SELECT json_set(source.payload,
        '$.userHunts', ${objectMap('userHunts')},
        '$.userHuntFetchedAt', ${objectMap('userHuntFetchedAt')},
        '$.syncedUserIds', ${idArray('syncedUserIds')},
        '$.failedUserIds', ${idArray('failedUserIds')},
        '$.syncedAllUsers', json('false')
      ) FROM source
    )
    UPDATE hunt_completion_cache
       SET payload = json_remove((SELECT payload FROM cleaned), '$._refreshLease'),
           refresh_until = 0, retry_after = 0
     WHERE id = ?
  `).bind(...params)
}

function prepareRefreshCommit(db, payload, now, retryAt, leaseUntil, leaseToken) {
  // The JS merge is based on the lease owner's snapshot; commit filters current
  // linked users and requires that exact lease, so delete/refresh interleavings
  // cannot resurrect a deleted key or overwrite a newer cache generation.
  const objectMap = (property) => {
    const alias = 'entry'
    const value = `CASE WHEN ${alias}.type IN ('object', 'array') THEN json(${alias}.value) ELSE ${alias}.value END`
    return `json(COALESCE((SELECT json_group_object(${alias}.key, ${value})
      FROM json_each(source.payload, '$.${property}') AS ${alias}
      WHERE ${alias}.key IN (${activeUserIdsSql()})), '{}'))`
  }
  const idArray = (property) => `json(COALESCE((SELECT json_group_array(value)
    FROM json_each(source.payload, '$.${property}')
    WHERE CAST(value AS TEXT) IN (${activeUserIdsSql()})), '[]'))`
  return db.prepare(`
    WITH source(payload) AS (SELECT json(?))
    UPDATE hunt_completion_cache
       SET payload = json_remove(json_set(source.payload,
             '$.userHunts', ${objectMap('userHunts')},
             '$.userHuntFetchedAt', ${objectMap('userHuntFetchedAt')},
             '$.syncedUserIds', ${idArray('syncedUserIds')},
             '$.failedUserIds', ${idArray('failedUserIds')}
           ), '$._refreshLease'),
           fetched_at = ?, refresh_until = 0, retry_after = ?
      FROM source
     WHERE hunt_completion_cache.id = ?
       AND hunt_completion_cache.refresh_until = ?
       AND json_extract(hunt_completion_cache.payload, '$._refreshLease') = ?
  `).bind(JSON.stringify(payload), now, retryAt, CACHE_ID, leaseUntil, leaseToken)
}

export const HUNT_COMPLETION_LIMITS = Object.freeze({
  maxLinkedUsers: MAX_LINKED_USERS,
  maxItemsPerProfile: MAX_ITEMS_PER_PROFILE,
  maxBadgesPerHunt: MAX_BADGES_PER_HUNT,
  concurrency: CONCURRENCY,
  profileTimeoutMs: PROFILE_TIMEOUT_MS,
  cacheTtlMs: CACHE_TTL_MS,
  staleTtlMs: STALE_TTL_MS
})

function safeKey(raw, max = 128) {
  const value = String(raw == null ? '' : raw).trim()
  return value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : ''
}

function safeName(raw) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LABEL_LENGTH) || '成员'
}

function itemKeys(item) {
  const keys = []
  const id = safeKey(item && item.id)
  const slug = safeKey(item && item.slug, 200)
  if (id) keys.push('id:' + id)
  if (slug) keys.push('slug:' + slug.toLowerCase())
  return keys
}

function parsePayload(raw) {
  try {
    const payload = JSON.parse(String(raw || ''))
    if (!payload || !Array.isArray(payload.syncedUserIds) || !payload.userHunts || typeof payload.userHunts !== 'object') return null
    return payload
  } catch { return null }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function timestamp(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function isWithinStaleTtl(value, now) {
  const at = timestamp(value)
  const current = timestamp(now)
  return at !== null && current !== null && current >= at && current - at <= STALE_TTL_MS
}

async function fetchPublicFinishedKeys(profileKey, fetcher) {
  const response = await fetcher(PROFILE_API + encodeURIComponent(profileKey), {
    headers: { accept: 'application/json', 'user-agent': 'CAAR-Site/1.0 (+https://caar.fun; public Hunt completion badges)' },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    cf: { cacheTtl: 120, cacheEverything: true }
  })
  if (!response.ok) throw new Error('profile_http_' + response.status)
  const payload = await response.json().catch(() => null)
  const profile = payload && payload.data
  if (!payload || Number(payload.code) !== 200 || !profile) throw new Error('profile_payload')
  if (String(profile.id || '') !== profileKey) throw new Error('profile_id_mismatch')
  if (profile.hideSolvedHunts === true) return []

  const items = Array.isArray(profile.finishedHunts) ? profile.finishedHunts.slice(0, MAX_ITEMS_PER_PROFILE) : []
  const keys = new Set()
  for (const item of items) {
    if (!item || item.isPublic !== true || item.visibility !== 'public') continue
    for (const key of itemKeys(item)) keys.add(key)
    if (keys.size >= MAX_KEYS_PER_PROFILE) break
  }
  return [...keys]
}

/** Testable bounded fetcher; profile keys and provider response fields never leave this module. */
export async function buildHuntCompletionPayload(users, fetcher = fetch, now = Date.now()) {
  const rows = []
  const seen = new Set()
  for (const raw of Array.isArray(users) ? users : []) {
    const id = Number(raw && raw.id)
    const profileKey = safeKey(raw && raw.puzzlecat_id)
    if (!Number.isSafeInteger(id) || id <= 0 || !profileKey || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, profileKey })
    if (rows.length >= MAX_LINKED_USERS) break
  }

  const userHunts = Object.create(null)
  const userHuntFetchedAt = Object.create(null)
  const failedUserIds = []
  const fetchedAt = Number(now) || Date.now()
  let cursor = 0
  async function consume() {
    while (cursor < rows.length) {
      const row = rows[cursor++]
      try {
        const key = String(row.id)
        userHunts[key] = await fetchPublicFinishedKeys(row.profileKey, fetcher)
        userHuntFetchedAt[key] = fetchedAt
      } catch { failedUserIds.push(row.id) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => consume()))
  return { fetchedAt, syncedUserIds: rows.map((row) => row.id), failedUserIds, userHunts, userHuntFetchedAt }
}

async function refreshSnapshot(env, now, leaseUntil, leaseToken) {
  try {
    const [{ count }, usersResult] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE banned = 0 AND puzzlecat_id IS NOT NULL').first(),
      env.DB.prepare(
        `SELECT id, puzzlecat_id FROM users
          WHERE banned = 0 AND puzzlecat_id IS NOT NULL
          ORDER BY id LIMIT ?`
      ).bind(MAX_LINKED_USERS).all()
    ])
    const users = usersResult.results || []
    const totalLinkedUsers = Number(count) || 0
    const payload = await buildHuntCompletionPayload(users, fetch, now)
    payload.syncedAllUsers = users.length === totalLinkedUsers
    const prior = await env.DB.prepare('SELECT payload, fetched_at FROM hunt_completion_cache WHERE id = ?').bind(CACHE_ID).first()
    const merged = parsePayload(prior && prior.payload)
    const retryAt = payload.failedUserIds.length ? now + RETRY_BACKOFF_MS : 0
    if (merged) {
      // Legacy JSON only has a whole-snapshot time. Use it once as the best
      // available last-success estimate; never refresh it on a profile failure.
      const legacyFetchedAt = timestamp(merged.fetchedAt) ?? timestamp(prior && prior.fetched_at)
      const userHuntFetchedAt = isRecord(merged.userHuntFetchedAt) ? { ...merged.userHuntFetchedAt } : Object.create(null)
      for (const key of Object.keys(merged.userHunts)) {
        if (!Object.prototype.hasOwnProperty.call(userHuntFetchedAt, key)) userHuntFetchedAt[key] = legacyFetchedAt
      }
      const currentUserIds = new Set(payload.syncedUserIds.map(Number))
      // Drop unlinked/deleted ids immediately. For still-linked ids, retain failed
      // users' last known rows only inside their per-user success TTL.
      for (const key of Object.keys(merged.userHunts)) {
        const userId = Number(key)
        if (!currentUserIds.has(userId) || !isWithinStaleTtl(userHuntFetchedAt[key], now)) {
          delete merged.userHunts[key]
          delete userHuntFetchedAt[key]
        }
      }
      for (const userId of payload.syncedUserIds) {
        const key = String(userId)
        if (payload.failedUserIds.includes(userId)) {
          if (Object.prototype.hasOwnProperty.call(merged.userHunts, key)) {
            payload.userHunts[key] = merged.userHunts[key]
            payload.userHuntFetchedAt[key] = userHuntFetchedAt[key]
          }
        } else {
          userHuntFetchedAt[key] = payload.userHuntFetchedAt[key]
        }
      }
      Object.assign(merged.userHunts, payload.userHunts)
      Object.assign(userHuntFetchedAt, payload.userHuntFetchedAt)
      // Keep timestamps only for currently linked users and non-expired results.
      for (const key of Object.keys(userHuntFetchedAt)) {
        if (!currentUserIds.has(Number(key)) || !isWithinStaleTtl(userHuntFetchedAt[key], now)) delete userHuntFetchedAt[key]
      }
      merged.userHuntFetchedAt = userHuntFetchedAt
      merged.syncedUserIds = [...new Set([...merged.syncedUserIds, ...payload.syncedUserIds])].sort((a, b) => a - b)
      const previousFailedUserIds = Array.isArray(merged.failedUserIds) ? merged.failedUserIds : []
      merged.failedUserIds = [...new Set([
        ...previousFailedUserIds.filter((id) => !payload.syncedUserIds.includes(id)),
        ...payload.failedUserIds
      ])]
      merged.fetchedAt = now
      payload.fetchedAt = now
      payload.userHunts = merged.userHunts
      payload.userHuntFetchedAt = merged.userHuntFetchedAt
      payload.syncedUserIds = merged.syncedUserIds
      payload.failedUserIds = merged.failedUserIds
    } else {
      payload.fetchedAt = now
    }
    // Commit only while this refresh still owns its lease. The SQL re-filters all
    // cached ids against current linked users at commit time, closing delete-vs-fetch races.
    await prepareRefreshCommit(env.DB, payload, now, retryAt, leaseUntil, leaseToken).run()
  } catch {
    try {
      await env.DB.prepare(`UPDATE hunt_completion_cache
         SET refresh_until = 0, retry_after = ?,
             payload = json_remove(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$._refreshLease')
       WHERE id = ? AND refresh_until = ? AND json_extract(payload, '$._refreshLease') = ?`)
        .bind(Date.now() + RETRY_BACKOFF_MS, CACHE_ID, leaseUntil, leaseToken).run()
    } catch { /* migration or DB unavailable: optional labels remain absent */ }
  }
}

/** Remove a deleted account's public completion keys using one atomic JSON1 update. */
export async function removeHuntCompletionUser(env, userId = null) {
  if (!env || !env.DB) return false
  try {
    await prepareHuntCompletionCacheCleanup(env.DB, userId).run()
    return true
  } catch {
    // Cache cleanup is best-effort; account deletion itself remains authoritative.
    return false
  }
}

function publicMap(payload, users, now, legacyFetchedAt) {
  const activeNames = new Map(users.map((u) => [String(u.id), safeName(u.name)]))
  const fetchedAtByUser = isRecord(payload.userHuntFetchedAt) ? payload.userHuntFetchedAt : Object.create(null)
  const fallbackFetchedAt = timestamp(payload.fetchedAt) ?? timestamp(legacyFetchedAt)
  const byHunt = Object.create(null)
  const seenByHunt = new Map()
  for (const [userId, keys] of Object.entries(payload.userHunts || {})) {
    // Fail closed when we cannot re-check current public visibility/privacy preferences.
    const fetchedAt = Object.prototype.hasOwnProperty.call(fetchedAtByUser, userId)
      ? fetchedAtByUser[userId]
      : fallbackFetchedAt
    if (!isWithinStaleTtl(fetchedAt, now)) continue
    const name = activeNames.get(userId)
    if (!name || !Array.isArray(keys)) continue
    for (const key of keys) {
      if (typeof key !== 'string' || !/^(?:id|slug):/.test(key)) continue
      const list = byHunt[key] || (byHunt[key] = [])
      let seen = seenByHunt.get(key)
      if (!seen) { seen = new Set(); seenByHunt.set(key, seen) }
      if (seen.has(userId)) continue
      seen.add(userId)
      if (list.length < MAX_BADGES_PER_HUNT) list.push({ name })
    }
  }
  return byHunt
}

/** Serve a bounded stale cache while one request holds the cross-isolate refresh lease. */
export async function getHuntCompletionData(env, ctx, now = Date.now()) {
  let users
  try {
    users = (await env.DB.prepare(
      `SELECT id, COALESCE(NULLIF(nickname, ''), username) AS name, puzzlecat_id
         FROM users WHERE banned = 0 AND puzzlecat_id IS NOT NULL ORDER BY id LIMIT ?`
    ).bind(MAX_LINKED_USERS).all()).results || []
  } catch { return { byHunt: Object.create(null), pending: false, source: 'unavailable' } }
  if (!users.length) {
    // No active profile means the cache is not displayable. Still prune orphaned
    // JSON keys atomically without deleting/rewriting other users' valid data.
    try { await removeHuntCompletionUser(env, null) } catch { /* optional cache cleanup */ }
    return { byHunt: Object.create(null), pending: false, source: 'empty' }
  }

  let row = null
  let payload = null
  try {
    row = await env.DB.prepare('SELECT payload, fetched_at, refresh_until, retry_after FROM hunt_completion_cache WHERE id = ?').bind(CACHE_ID).first()
    payload = row && parsePayload(row.payload)
  } catch { return { byHunt: Object.create(null), source: 'unavailable' } }

  const age = row && Number.isFinite(Number(row.fetched_at)) ? now - Number(row.fetched_at) : Infinity
  // The global timestamp controls whether the snapshot is stale; per-user
  // timestamps independently bound each badge's last-known success age.
  const usable = !!payload && age >= 0 && age <= STALE_TTL_MS
  const cacheHasAllUsers = usable && users.every((u) => payload.syncedUserIds.includes(Number(u.id)))
  const haveAllUsers = cacheHasAllUsers && payload.syncedAllUsers === true
  const hasFailures = !!(payload && Array.isArray(payload.failedUserIds) && payload.failedUserIds.length)
  const fresh = usable && haveAllUsers && !hasFailures && age <= CACHE_TTL_MS
  const retryDeferred = row && Number(row.retry_after) > now
  const refreshInProgress = row && Number(row.refresh_until) > now
  if (!fresh && !retryDeferred && !refreshInProgress) {
    try {
      const leaseUntil = now + REFRESH_LEASE_MS
      const leaseToken = crypto.randomUUID()
      const lease = await env.DB.prepare(
        `INSERT INTO hunt_completion_cache (id, payload, fetched_at, refresh_until, retry_after)
         VALUES (?, json_object('_refreshLease', ?), 0, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           payload = json_set(CASE WHEN json_valid(hunt_completion_cache.payload) THEN hunt_completion_cache.payload ELSE '{}' END, '$._refreshLease', ?),
           refresh_until = excluded.refresh_until
         WHERE hunt_completion_cache.refresh_until <= ? AND hunt_completion_cache.retry_after <= ?
         RETURNING id`
      ).bind(CACHE_ID, leaseToken, leaseUntil, leaseToken, now, now).first()
      if (lease) {
        const job = refreshSnapshot(env, now, leaseUntil, leaseToken)
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job)
        else job.catch(() => null)
      }
    } catch { /* missing migration or transient D1 failure: keep serving stale/empty */ }
  }
  return {
    byHunt: usable ? publicMap(payload, users, now, row && row.fetched_at) : Object.create(null),
    // Pending only means an actual refresh is in flight or can be acquired now.
    // A provider retry backoff is not polled by the client; next page entry retries it.
    pending: refreshInProgress || (!fresh && !retryDeferred),
    retryAfter: retryDeferred ? Number(row.retry_after) : 0,
    source: fresh ? 'cache' : usable ? 'stale' : 'pending'
  }
}
