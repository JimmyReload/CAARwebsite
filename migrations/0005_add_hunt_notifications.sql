-- 赛事动态通知：别人标记了「我已标记」的 hunt 时，给我留一条提醒
-- UNIQUE(user_id, hunt_id, actor_id) 保证同一人对同一赛事只提醒一次（取消后再标记也不会重复）
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
