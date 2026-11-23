-- 会员新闻投稿与管理审核。
-- 公开端只查询 status='published'；待审/退回记录只对作者和管理员开放。
CREATE TABLE IF NOT EXISTS news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'plain',
  author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_public ON news_articles(status, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_news_author ON news_articles(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_news_review ON news_articles(status, id DESC);

INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0011_news_articles');
