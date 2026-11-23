-- 登录节流：login_fails.blocks（"本窗口内被封次数"，用于驱动退避阶梯）
--
-- 背景：原实现用累计失败数 n 计算等待时长，10 次失败就打满 15 分钟；
-- 改为按 blocks（第几次被封）计算：60s → 120s → 240s → … → 900s 封顶。
--
-- ⚠️ 2026-11-23 实况：cdcfb83 部署时线上 login_fails 仍是**没有 blocks 的旧结构**，
--    该列是部署后由运行时兜底 ALTER 补上的（即"代码先于迁移到位"）。
--    因此列现在已经存在，再执行 ADD COLUMN 会 duplicate column 并中断整批。
--
--    → 本文件因此改为「版本登记」，不再执行 ALTER。可安全重复执行。
--
-- 对确实还没有该列的环境（早于 cdcfb83 的库），先手工执行一次：
--    ALTER TABLE login_fails ADD COLUMN blocks INTEGER NOT NULL DEFAULT 0;
-- 再执行本文件登记版本。新版代码检测到缺列会直接拒绝登录（503）并打日志，
-- 不会像旧版那样静默放行——漏列的库会立刻暴露，而不是悄悄失去限流。

INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0009_add_login_fails_blocks');
