# 数据库迁移

## 规则

1. **生产库只走本目录**，不要执行仓库根目录的 `schema.sql`（那是全新环境的建库脚本）。
2. 每次改动前先备份：
   ```bash
   npx wrangler d1 export caar-db --remote --output=backup-$(date +%F-%H%M).sql
   ```
3. 文件按序号执行，**不要重跑已应用的迁移**。部署时请从当前环境实际已应用的版本继续执行；若版本缺口或记录与数据库结构不一致，先核对再部署，不要盲目跳号。
4. 新增迁移时，在本文件的「执行记录」里补一行，并同步更新 `schema.sql`（让全新环境一次建好）。

## 为什么不能重跑

SQLite 的 `ALTER TABLE ... ADD COLUMN` 没有 `IF NOT EXISTS`，重复执行会直接报错并中断整批。
`0002`、`0006` 都含 `ALTER TABLE`，属于**一次性**迁移。

`worker.js` 的 `ensureEmailSchema` / `ensureHuntSchema` 是兜底：只在表/列缺失时补建，
用来避免「代码先上线、迁移还没跑」的窗口期 500。它们**不能替代**迁移，也不处理 `ALTER` 失败。

审计表不一样：`log.js` 默认**不建表**（日志系统不该在请求路径上跑 DDL）。没跑 `0010` 时，
`/api/admin/logs` 会返回 500 并提示执行迁移，写入只落控制台。确实需要先上线后补迁移时，
可临时设 `AUDIT_BOOTSTRAP=1` 让代码兜底建表，建完立刻取消。

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
| `0009_add_login_fails_blocks.sql` | `login_fails.blocks`（退避阶梯按"第几次被封"计） | 列已由 `cdcfb83` 部署时的 runtime 补上；文件改为版本登记，可安全执行 |
| `0010_add_audit_logs.sql` | `audit_logs`（审计流水，默认保留 90 天） | 待应用 |
| `0011_news_articles.sql` | 会员新闻投稿、富文本稿件与管理员审核状态 | 待应用 |

> `0010` 只依赖 `0008` 建好的 `schema_migrations`，与 `0009` 互不依赖，应用顺序不分先后。

> `schema_migrations` 由 **0008** 建立（`schema.sql` 里也有，但那是全新环境用的）。
> 生产库请先执行 0008，再往里写版本记录：
> ```sql
> INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0009_xxx');
> ```
> 0002–0007 是手工执行的，没有写入记录；上表状态以 2026-11-23 的实际库结构为准（逐表/逐列核对）。

## 运维：登录返回 503 怎么办

登录或改密返回 **`503 登录服务暂时不可用`** 时，不是前端问题，也不是限流误伤，而是
`login_fails` 缺 `blocks` 列：代码检测到结构不一致会**拒绝接收口令**，不再降级放行
（旧版会静默跳过限流，等于在无保护状态下收密码）。Worker 日志里同时有一条
`[login] login_fails 缺 blocks 列…`。

这种状态**无法从界面自救**（所有人都会被挡住），只能走 CLI：

```bash
# 1) 补列
npx wrangler d1 execute caar-db --remote --command \
  "ALTER TABLE login_fails ADD COLUMN blocks INTEGER NOT NULL DEFAULT 0;"
# 2) 登记版本（0009 现在只做版本登记，不含 ALTER，可安全重复执行）
npx wrangler d1 execute caar-db --remote --file=migrations/0009_add_login_fails_blocks.sql
```

全新环境用 `schema.sql` 建库则不需要这两步：结构直接到位，并且会一并登记 0002–0009
的版本记录，不会出现"新库结构全、版本表空"的不一致。
