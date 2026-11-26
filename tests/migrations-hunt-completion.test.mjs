import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const readSql = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')
const MIGRATIONS = [
  ['0013_hunt_completion_cache', '../migrations/0013_hunt_completion_cache.sql'],
  ['0014_hunt_completion_retry_after', '../migrations/0014_hunt_completion_retry_after.sql']
]
const EXPECTED_CACHE_COLUMNS = ['id', 'payload', 'fetched_at', 'refresh_until', 'retry_after']

function makeMigrationDb() {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))")
  return db
}

function cacheColumns(db) {
  return db.prepare('PRAGMA table_info(hunt_completion_cache)').all().map((column) => column.name)
}

test('0013/0014 按序迁移完赛缓存且逐版登记', () => {
  const db = makeMigrationDb()
  try {
    db.exec(readSql(MIGRATIONS[0][1]))
    assert.deepEqual(cacheColumns(db), ['id', 'payload', 'fetched_at', 'refresh_until'])
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version),
      ['0013_hunt_completion_cache']
    )

    // 真正以前序版本刚创建的结构运行 0014，捕获重名列导致迁移与版本登记一起中断的问题。
    db.exec(readSql(MIGRATIONS[1][1]))
    assert.deepEqual(cacheColumns(db), EXPECTED_CACHE_COLUMNS)
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version),
      MIGRATIONS.map(([version]) => version)
    )

    db.prepare('INSERT INTO hunt_completion_cache (id, payload, fetched_at, refresh_until) VALUES (1, ?, ?, ?)')
      .run('{}', 123, 456)
    assert.equal(db.prepare('SELECT retry_after FROM hunt_completion_cache WHERE id = 1').get().retry_after, 0)
  } finally {
    db.close()
  }
})

test('fresh schema 提供相同完赛缓存最终结构并登记迁移 0002–0014', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readSql('../schema.sql'))
    assert.deepEqual(cacheColumns(db), EXPECTED_CACHE_COLUMNS)

    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version)
    assert.deepEqual(versions, [
      '0002_add_session_version',
      '0003_add_hunt_interests',
      '0004_add_hunt_feed',
      '0005_add_hunt_notifications',
      '0006_add_email_verification',
      '0007_superadmin',
      '0008_add_schema_migrations_and_login_fails',
      '0009_add_login_fails_blocks',
      '0010_add_audit_logs',
      '0011_news_articles',
      '0012_add_puzzlecat_id',
      '0013_hunt_completion_cache',
      '0014_hunt_completion_retry_after'
    ])
  } finally {
    db.close()
  }
})
