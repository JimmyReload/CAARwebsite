-- 审计流水：登录 / 注册 / 改密、管理操作、公告变更、未捕获异常、前端报错
--
-- 与控制台日志（src/log.js 输出的单行 JSON）互补：
--   控制台 = 全量、有采样、随平台保留期消失，适合排障；
--   本表   = 精选事件、结构固定、可按人/按事件检索，适合事后追责。
--
-- 注意：worker.js 的 ensureAuditSchema 会兜底建同样的表和索引，
-- 让「代码先上线、迁移后补」也不会 500；本文件是正式来源。

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,                 -- 行号即可做游标：不需要 AUTOINCREMENT 的永不复用保证，省一次序列写
  ts INTEGER NOT NULL,                       -- 毫秒时间戳：排序与保留期清理都靠它
  level TEXT NOT NULL DEFAULT 'info',        -- info | warn | error
  event TEXT NOT NULL,                       -- auth.login.ok / admin.user.ban / request.error …
  actor_id INTEGER,                          -- 操作者用户 id；匿名事件为 NULL
  actor_name TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',      -- user | announcement | conversation | email | ip
  target_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  rid TEXT NOT NULL DEFAULT '',              -- 对应 cf-ray / 响应头 x-request-id
  ua TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT ''              -- JSON，写入前已脱敏，上限 2000 字符
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_level_ts ON audit_logs(level, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit_logs(event, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, ts DESC);

INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0010_add_audit_logs');
