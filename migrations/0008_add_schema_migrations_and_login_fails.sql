-- 迁移版本记录 + 登录节流计数
--
-- 1) schema_migrations：此前只在 schema.sql 里定义，生产库并没有这张表，
--    按 migrations/README.md 插入版本记录会报 no such table。这里补上。
-- 2) login_fails：登录/改密的尝试计数。KV 无原子自增，并发下会丢计数，
--    改用 D1 单条 UPSERT（SQLite 语句级原子）。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0008_add_schema_migrations_and_login_fails');
