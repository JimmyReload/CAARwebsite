-- 赛事列表快照：单行 JSON，避免每次请求跨站抓取 puzzle.cat
-- 由 Cron Trigger（每 10 分钟）与请求侧的 stale-while-revalidate 刷新
CREATE TABLE IF NOT EXISTS hunt_feed (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
