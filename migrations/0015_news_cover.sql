-- 新闻封面图（头图）
--
-- 只存 KV 里的对象键（形如 news/u3-<32hex>.webp），图本身在 MEDIA 命名空间。
-- 空串表示没有封面，前端卡片退化为纯文字版式，不会留白框。
-- 不存完整 URL：换域名/换存储时不用回填数据库。
ALTER TABLE news_articles ADD COLUMN cover_key TEXT NOT NULL DEFAULT '';

INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0015_news_cover');
