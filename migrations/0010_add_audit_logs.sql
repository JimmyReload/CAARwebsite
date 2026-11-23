-- 审计流水：登录 / 注册 / 改密、管理操作、公告变更、未捕获异常、前端报错
--
-- 与控制台日志（src/log.js 输出的单行 JSON）互补：
--   控制台 = 全量、有采样、随平台保留期消失，适合排障；
--   本表   = 精选事件、结构固定、可按人/按事件检索，适合事后追责。
--
-- 注意：运行时**默认不建表**（日志系统不该在请求路径上跑 DDL）。未执行本迁移时：
--   · /api/admin/logs 返回 500 并提示执行本文件；
--   · audit() 写库失败，只打一行 audit.table.missing 到控制台（每 10 分钟一次）。
-- 仅在「代码先上线、迁移还没跑」的窗口期，可临时设 AUDIT_BOOTSTRAP=1 让代码兜底建表，
-- 建表后立刻取消该变量——否则表结构从此由代码而非 migrations 决定。
--
-- 若某个环境跑过早期版本（e3978d8，当时代码默认建表），它的 id 列仍是
-- AUTOINCREMENT；CREATE TABLE IF NOT EXISTS 不会改已有表，功能无差异，
-- 只是与全新环境存在这一点定义分叉。

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
