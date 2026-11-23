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
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

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
