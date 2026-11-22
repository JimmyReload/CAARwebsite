-- 邮箱验证码：注册验证 + 自愿绑定邮箱
-- 验证码不落明文，只存 SHA-256(email:code:issuedAt)；users.email 允许为空（老账号未绑定）

CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,            -- register | bind
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- unix ms，签发时间 = expires_at - 600000
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_codes ON email_codes(email, purpose, id);

ALTER TABLE users ADD COLUMN email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
