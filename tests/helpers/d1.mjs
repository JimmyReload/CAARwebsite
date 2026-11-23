// 最小 D1 适配层：把 env.DB 的 prepare/bind/first/all/run 映射到 node:sqlite
//
// 只实现限流与登录路径用到的子集，够 tests/ 直接驱动 src/ 里的真实 SQL，
// 不必为了测试复制一份 SQL（复制必然漂移，测出来的就不是线上那段语句了）。
import { DatabaseSync } from 'node:sqlite'

export function makeD1() {
  const db = new DatabaseSync(':memory:')
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      const row = db.prepare(sql).get(...args)
      return row === undefined ? null : { ...row }
    },
    async all() {
      return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }
    },
    async run() {
      const r = db.prepare(sql).run(...args)
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
    }
  })
  return {
    _raw: db,
    prepare: (sql) => stmt(sql, []),
    async batch(list) { return Promise.all(list.map((s) => s.run())) }
  }
}

// 登录路径会 SELECT * FROM users，失败分支还需要 users 表存在
export const USERS_DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`

const LOGIN_FAILS_CURRENT = `CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`
// cdcfb83 之前的旧结构：没有 blocks 列
const LOGIN_FAILS_LEGACY = `CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`

// 注意：ensureLoginSchema 的就绪状态按模块缓存，一个进程里只对第一个 env 执行建表。
// 所以这里直接把目标结构建好，等价于"线上已经跑过迁移的库"，别依赖那个缓存。
export function makeEnv({ loginFails = 'current' } = {}) {
  const DB = makeD1()
  DB._raw.exec(USERS_DDL)
  DB._raw.exec(loginFails === 'legacy' ? LOGIN_FAILS_LEGACY : LOGIN_FAILS_CURRENT)
  return {
    DB,
    // 失败路径不碰 KV；成功路径需要，这里给个空实现以免误用时报 undefined
    SESSIONS: {
      async get() { return null },
      async put() {},
      async delete() {}
    },
    ASSETS: { async fetch() { return new Response('', { status: 404 }) } }
  }
}

export const ctx = { waitUntil() {}, passThroughOnException() {} }

// 调用 Worker 的 /api/login
export async function postLogin(worker, env, { username, password, ip }) {
  const res = await worker.fetch(new Request('https://caar.test/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ username, password })
  }), env, ctx)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
}
