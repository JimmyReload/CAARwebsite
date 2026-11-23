-- 登录节流：增加"本窗口内被封次数"，用于驱动退避阶梯
--
-- 背景：原实现用累计失败数 n 计算等待时长，10 次失败就打满 15 分钟；
-- 改为按 blocks（第几次被封）计算：60s → 120s → 240s → …
--
-- 注意：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，本文件是一次性迁移，重复执行会报错。
ALTER TABLE login_fails ADD COLUMN blocks INTEGER NOT NULL DEFAULT 0;
