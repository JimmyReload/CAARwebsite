-- CAAR 用户系统
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 工单会话（每个会员一个对话线程）
DROP TABLE IF EXISTS conversations;
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  user_last_read_id INTEGER NOT NULL DEFAULT 0,
  staff_last_read_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 消息（会员 to_staff / staff to_user 双向）
DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
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
