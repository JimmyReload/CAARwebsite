-- 赛事总览：成员对 puzzle.cat hunt 的「我想参加」标记
-- hunt_title / hunt_url / hunt_start 是上游快照，保证赛事从上游列表消失后仍能展示
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
