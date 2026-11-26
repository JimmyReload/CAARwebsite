-- ============================================================
-- CAAR · 全新建库脚本（仅用于本地或全新环境）
--
-- ⚠️ 禁止在生产库执行本文件。
--    生产库的结构演进一律走 migrations/，并且每次变更前先导出备份：
--      wrangler d1 export caar-db --remote --output=backup-$(date +%F-%H%M).sql
--
--    本文件只做 CREATE TABLE IF NOT EXISTS，不含任何 DROP；
--    历史版本曾在此处 DROP conversations/messages，误执行会清空全部私信。
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin | superadmin
  banned INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  puzzlecat_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_puzzlecat_id ON users(puzzlecat_id) WHERE puzzlecat_id IS NOT NULL;

-- 邮箱验证码（只存哈希，不存明文）
CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,                      -- register | bind
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,                -- unix ms
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_codes ON email_codes(email, purpose, id);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 工单会话（每个会员一个对话线程）
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  user_last_read_id INTEGER NOT NULL DEFAULT 0,
  staff_last_read_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 消息（会员 to_staff / staff to_user 双向）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);

-- 赛事总览：成员对 puzzle.cat hunt 的「我想参加」标记
-- hunt_title / hunt_url / hunt_start 为上游快照，赛事从上游列表消失后仍可展示
CREATE TABLE IF NOT EXISTS hunt_interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  hunt_id TEXT NOT NULL,
  hunt_title TEXT NOT NULL DEFAULT '',
  hunt_url TEXT NOT NULL DEFAULT '',
  hunt_start TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, hunt_id)
);
CREATE INDEX IF NOT EXISTS idx_hunt_interests_hunt ON hunt_interests(hunt_id);

-- 赛事列表快照（单行 JSON）：由 Cron Trigger 与 stale-while-revalidate 刷新，
-- 用户请求只读这张表，不在请求路径上访问 puzzle.cat
CREATE TABLE IF NOT EXISTS hunt_feed (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- 赛事动态通知：别人标记了我已标记的 hunt
CREATE TABLE IF NOT EXISTS hunt_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  hunt_id TEXT NOT NULL,
  hunt_title TEXT NOT NULL DEFAULT '',
  actor_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  read_at TEXT,
  UNIQUE(user_id, hunt_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_hunt_notif_user ON hunt_notifications(user_id, id DESC);

-- 0013 建立公开完赛记录缓存；0014 增加 retry_after。只存 profile 可见的 Hunt key 与站内用户显示名。
CREATE TABLE IF NOT EXISTS hunt_completion_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  refresh_until INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);

-- 迁移版本记录：与 migrations/ 下的文件对应，用于确认线上跑到第几号
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- 登录/改密尝试计数：D1 单条 UPSERT 原子自增（KV 没有原子自增，并发会丢计数）
CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 审计流水：登录/注册/改密、管理操作、公告变更、异常与前端报错
-- 控制台日志负责「全量排障」，这张表负责「事后追责」，按保留期清理（默认 90 天）
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,                 -- 行号即可做游标：不需要 AUTOINCREMENT 的永不复用保证，省一次序列写
  ts INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  event TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  rid TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_level_ts ON audit_logs(level, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit_logs(event, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, ts DESC);

-- 新闻投稿与审核：会员仅能提交和查看自己的稿件，公开端仅显示 published。
CREATE TABLE IF NOT EXISTS news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'plain',
  author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_public ON news_articles(status, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_news_author ON news_articles(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_news_review ON news_articles(status, id DESC);

-- ============================================================
-- 迁移版本登记（仅全新环境）
--
-- 上面建出的结构已覆盖迁移 0002–0014 的最终表结构；全新库在此逐版登记
-- 0002–0014（不含不存在的 0001），避免「全新环境」与「生产环境」的 schema_migrations 对不上。
-- 0007 是数据迁移（把 admin 升为 superadmin），新库里没有 admin 账号、
-- 执行也是空操作，同样登记，避免之后被重复执行。
-- ============================================================
INSERT OR REPLACE INTO schema_migrations (version) VALUES
  ('0002_add_session_version'),
  ('0003_add_hunt_interests'),
  ('0004_add_hunt_feed'),
  ('0005_add_hunt_notifications'),
  ('0006_add_email_verification'),
  ('0007_superadmin'),
  ('0008_add_schema_migrations_and_login_fails'),
  ('0009_add_login_fails_blocks'),
  ('0010_add_audit_logs'),
  ('0011_news_articles'),
  ('0012_add_puzzlecat_id'),
  ('0013_hunt_completion_cache'),
  ('0014_hunt_completion_retry_after');
