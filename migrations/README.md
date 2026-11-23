# 数据库迁移

## 规则

1. **生产库只走本目录**，不要执行仓库根目录的 `schema.sql`（那是全新环境的建库脚本）。
2. 每次改动前先备份：
   ```bash
   npx wrangler d1 export caar-db --remote --output=backup-$(date +%F-%H%M).sql
   ```
3. 文件按序号执行，**不要跳号、不要重跑已应用的迁移**。
4. 新增迁移时，在本文件的「执行记录」里补一行，并同步更新 `schema.sql`（让全新环境一次建好）。

## 为什么不能重跑

SQLite 的 `ALTER TABLE ... ADD COLUMN` 没有 `IF NOT EXISTS`，重复执行会直接报错并中断整批。
`0002`、`0006` 都含 `ALTER TABLE`，属于**一次性**迁移。

代码里 `worker.js` 的 `ensureEmailSchema` / `ensureHuntSchema` / `log.js` 的 `ensureAuditSchema` 是兜底：
只在表/列缺失时补建，用来避免「代码先上线、迁移还没跑」的窗口期 500。
它们**不能替代**迁移，也不处理 `ALTER` 失败。

## 执行记录（截至 2026-11-23）

| 文件 | 内容 | 线上状态 |
|---|---|---|
| `0002_add_session_version.sql` | `users.session_version` | 已应用 |
| `0003_add_hunt_interests.sql` | 赛事标记表 | 已应用 |
| `0004_add_hunt_feed.sql` | 赛事快照表 | 已应用 |
| `0005_add_hunt_notifications.sql` | 赛事动态通知表 | 已应用 |
| `0006_add_email_verification.sql` | `email_codes` + `users.email` | 已应用 |
| `0007_superadmin.sql` | 把 `admin` 升为 `superadmin` | 已应用 |
| `0008_add_schema_migrations_and_login_fails.sql` | `schema_migrations` + `login_fails` | 已应用 |
| `0009_add_login_fails_blocks.sql` | `login_fails.blocks`（退避阶梯按"第几次被封"计） | 待应用 |
| `0010_add_audit_logs.sql` | `audit_logs`（审计流水，默认保留 90 天） | 待应用 |

> `0010` 只依赖 `0008` 建好的 `schema_migrations`，与 `0009` 互不依赖，应用顺序不分先后。

> `schema_migrations` 由 **0008** 建立（`schema.sql` 里也有，但那是全新环境用的）。
> 生产库请先执行 0008，再往里写版本记录：
> ```sql
> INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0009_xxx');
> ```
> 0002–0007 是手工执行的，没有写入记录；上表状态以 2026-11-23 的实际库结构为准（逐表/逐列核对）。
