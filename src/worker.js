// CAAR 用户系统 API —— Cloudflare Worker（D1 + KV）
// 密码哈希：PBKDF2-SHA256（Web Crypto）
// 会话：随机令牌存 KV，HttpOnly Cookie
// 所有面向用户的提示文案统一取自 locales/zh-CN.js
import { t } from './i18n'
import { getHuntFeed, refreshFeed, isValidHuntId } from './hunts'

const enc = new TextEncoder();
const dec = new TextDecoder();

// 统一安全响应头（全站出口统一附加）
// CSP 说明：脚本与连接仅同源；样式需 'unsafe-inline'（首页等用了内联 style）；
// 图片允许 https:（赛事缩略图来自 puzzle.cat 的第三方 CDN）。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'content-security-policy': CSP
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS
    }
  });
}
function harden(res) {
  const headers = new Headers(res.headers);
  for (const k in SECURITY_HEADERS) if (!headers.has(k)) headers.set(k, SECURITY_HEADERS[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

// ---------- 密码 ----------
async function hashPassword(pw, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key, 256
  );
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
}
function hexToBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return a; }
function bytesToHex(b) { return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''); }
const DUMMY_SALT = '00000000000000000000000000000000';
async function verifyPassword(pw, saltHex, hashHex) {
  const { hash } = await hashPassword(pw, saltHex);
  return hash === hashHex;
}

// ---------- 口令强度 ----------
const PASSWORD_MIN = 8;
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'passw0rd',
  'qwertyui', 'qwerty123', 'abc12345', 'iloveyou', 'admin123', 'caar1234'
]);
// 返回错误文案 key，合法时返回 null
function passwordProblem(pw, username) {
  if (String(pw).length < PASSWORD_MIN) return 'errors.passwordLength';
  const low = String(pw).toLowerCase();
  if (WEAK_PASSWORDS.has(low)) return 'errors.passwordWeak';
  if (username && low === String(username).toLowerCase()) return 'errors.passwordWeak';
  return null;
}

// ---------- 登录节流 ----------
// IP 5 次失败后按 60s 起指数退避（上限 15 分钟）；用户名阈值更高，避免被轻易锁号。
const LOGIN_IP_MAX = 5;
const LOGIN_USER_MAX = 20;
const LOGIN_BLOCK_BASE_MS = 60 * 1000;
const LOGIN_BLOCK_MAX_MS = 15 * 60 * 1000;
const LOGIN_FAIL_TTL = 60 * 60;

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

async function readFail(env, key) {
  try { return await env.SESSIONS.get(key, 'json'); } catch { return null; }
}

function failBlocked(rec, threshold) {
  const n = Number(rec && rec.n) || 0;
  if (n < threshold) return 0;
  const until = Number(rec && rec.until) || 0;
  return until > Date.now() ? until : 0;
}

async function bumpFail(env, key, rec, threshold) {
  const n = (Number(rec && rec.n) || 0) + 1;
  const step = n - threshold;
  const wait = n >= threshold ? Math.min(LOGIN_BLOCK_MAX_MS, LOGIN_BLOCK_BASE_MS * Math.pow(2, step)) : 0;
  try {
    await env.SESSIONS.put(key, JSON.stringify({ n, until: wait ? Date.now() + wait : 0 }), { expirationTtl: LOGIN_FAIL_TTL });
  } catch { /* 计数失败不阻断登录流程 */ }
}

// ---------- 邮箱验证码 ----------
const CODE_TTL_MS = 10 * 60 * 1000;      // 验证码 10 分钟有效
const CODE_COOLDOWN_MS = 60 * 1000;      // 同一邮箱 60 秒内只能发一次
const CODE_MAX_PER_HOUR = 5;             // 同一邮箱每小时最多 5 封
const CODE_MAX_ATTEMPTS = 5;             // 同一验证码最多试 5 次
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

// 表结构与 users.email 由 migrations/0006 补；这里兜底建一次，
// 让「代码先上线、迁移后补」也不会 500。每个 isolate 只执行一次。
let emailSchemaReady = null;
function ensureEmailSchema(env) {
  if (!emailSchemaReady) {
    emailSchemaReady = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used INTEGER NOT NULL DEFAULT 0,
        ip TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_email_codes ON email_codes(email, purpose, id)').run();
      try { await env.DB.prepare('ALTER TABLE users ADD COLUMN email TEXT').run(); } catch { /* 列已存在 */ }
      await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL').run();
    })().catch((err) => { emailSchemaReady = null; throw err; });
  }
  return emailSchemaReady;
}

// 验证码不落明文：email + code + 签发时间戳 做 SHA-256
async function hashCode(email, code, issuedAt) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(email + ':' + code + ':' + issuedAt));
  return bytesToHex(new Uint8Array(buf));
}

function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(100000 + n);
}

async function sendMail(env, to, subject, text, html) {
  if (!env.RESEND_API_KEY) throw new Error('MAIL_NOT_CONFIGURED');
  // MAIL_API_BASE 便于本地用假邮件服务联调，生产不配即走 Resend
  const base = (env.MAIL_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  const res = await fetch(base + '/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'CAAR 中不正协 <noreply@caar.fun>',
      to: [to],
      subject,
      text,
      html
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('MAIL_' + res.status);
}

async function sendCodeMail(env, email, code, purpose) {
  const isBind = purpose === 'bind';
  const subject = (isBind ? '绑定邮箱验证码' : '注册验证码') + ' · CAAR 中不正协';
  const text = `你的验证码是 ${code}，10 分钟内有效。\n\n${isBind ? '用于给账号绑定这个邮箱' : '用于注册 CAAR 账号'}。如果这不是你本人操作，忽略本邮件即可。`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:28px;border:3px solid #000">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;font-weight:700">CAAR · 中国不正常推理协会</p>
    <h2 style="margin:0 0 18px;font-size:20px">${isBind ? '绑定邮箱' : '注册'}验证码</h2>
    <p style="margin:0 0 14px;font-size:32px;font-weight:900;letter-spacing:.28em;background:#ffe94a;display:inline-block;padding:10px 16px;border:3px solid #000">${code}</p>
    <p style="margin:14px 0 0;font-size:14px;line-height:1.7">10 分钟内有效，仅可使用一次。</p>
    <p style="margin:10px 0 0;font-size:13px;color:#555;line-height:1.7">如果这不是你本人操作，忽略本邮件即可，你的账号不受影响。</p>
  </div>`;
  await sendMail(env, email, subject, text, html);
}

// 校验验证码；成功即标记已用，失败累计尝试次数
async function verifyCode(env, email, purpose, code) {
  const row = await env.DB.prepare(
    'SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).bind(email, purpose).first();
  if (!row) return { ok: false, error: 'errors.codeMissing' };
  if (Number(row.expires_at) < Date.now()) return { ok: false, error: 'errors.codeExpired' };
  if (Number(row.attempts) >= CODE_MAX_ATTEMPTS) return { ok: false, error: 'errors.codeTooMany' };
  const issuedAt = Number(row.expires_at) - CODE_TTL_MS;
  const hash = await hashCode(email, String(code), issuedAt);
  if (hash !== row.code_hash) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    return { ok: false, error: 'errors.codeWrong' };
  }
  await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').bind(row.id).run();
  return { ok: true };
}

// ---------- 会话 ----------
const SESSION_COOKIE = 'caar_session';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 天

async function createSession(env, userId, version = 0) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.SESSIONS.put('s:' + token, String(userId) + ':' + Number(version || 0), { expirationTtl: SESSION_TTL });
  return token;
}
const SESSION_TOKEN_RE = /^[A-Za-z0-9-]{20,100}$/;

async function getSessionUser(env, cookie) {
  if (!cookie) return null;
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
  if (!m) return null;
  const token = m.slice(SESSION_COOKIE.length + 1);
  // 令牌格式先校验：避免超长/畸形值拼进 KV 键（KV 键有长度上限，会抛未捕获异常）
  if (!SESSION_TOKEN_RE.test(token)) return null;
  const uid = await env.SESSIONS.get('s:' + token);
  if (!uid) return null;
  const userId = Number(String(uid).split(':')[0]);
  if (!Number.isFinite(userId)) return null;
  const user = await env.DB.prepare('SELECT id, username, nickname, role, banned, session_version, created_at FROM users WHERE id = ?').bind(userId).first();
  if (!user) return null;
  // 封禁即时生效：不依赖用户重新登录
  if (user.banned) { await env.SESSIONS.delete('s:' + token); return null; }
  // 改密后旧会话失效（compare 版本号）
  if (Number(user.session_version) !== Number(sessVersion(uid))) {
    await env.SESSIONS.delete('s:' + token);
    return null;
  }
  return user;
}
// 会话记录形如 "<userId>:<sessionVersion>"；兼容早期只存 userId 的旧值
function sessVersion(v) { const s = String(v); const i = s.indexOf(':'); return i < 0 ? 0 : Number(s.slice(i + 1)); }
function sessionCookie(token) {
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=' + SESSION_TTL;
}
function clearCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}

function getCookie(req) { return req.headers.get('cookie') || ''; }

// ---------- 管理员工具 ----------
async function allAdmins(env) {
  return (await env.DB.prepare("SELECT id, username, nickname FROM users WHERE role = 'admin' ORDER BY id").all()).results;
}

// ---------- 角色 ----------
// user < admin < superadmin。superadmin 只有一个，负责授权与删号
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'superadmin');
const isSuper = (u) => !!u && u.role === 'superadmin';

// ---------- 公告 ----------
// 公告列表与管理端列表共用同一查询，避免两处排序口径不一致
async function loadAnnouncements(env) {
  return (await env.DB.prepare('SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 50').all()).results;
}
// 公告版本号（最大 id）：成员端轮询只比这个数，变了才重新拉正文
async function announcementVersion(env) {
  const row = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM announcements').first();
  return row ? Number(row.v) || 0 : 0;
}

// ---------- 会话 ----------
// 已读位只前进不后退，避免并发请求把游标写小
async function markRead(env, convId, lastId, isOwner) {
  if (!lastId) return;
  const col = isOwner ? 'user_last_read_id' : 'staff_last_read_id';
  await env.DB.prepare(`UPDATE conversations SET ${col} = MAX(${col}, ?) WHERE id = ?`).bind(lastId, convId).run();
}

// ---------- 管理统计 ----------
// 6 个 COUNT 合成一条语句：原来是 6 次串行往返
async function adminStats(env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS total,
            (SELECT COUNT(*) FROM users WHERE role IN ('admin','superadmin')) AS admins,
            (SELECT COUNT(*) FROM conversations) AS convs,
            (SELECT COUNT(*) FROM conversations c WHERE EXISTS (
               SELECT 1 FROM messages m
                WHERE m.conv_id = c.id AND m.direction = 'to_staff' AND m.id > c.staff_last_read_id)) AS unreadConvs,
            (SELECT COUNT(*) FROM announcements) AS anns,
            (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS new7`
  ).first();
  const n = (k) => (row ? Number(row[k]) || 0 : 0);
  return { total: n('total'), admins: n('admins'), convs: n('convs'), unreadConvs: n('unreadConvs'), anns: n('anns'), new7: n('new7') };
}

// ---------- 赛事总览 ----------
// 表结构见 migrations/0003_add_hunt_interests.sql；这里再兜底建一次，
// 让「代码先上线、迁移后补」也不会 500。每个 isolate 只执行一次。
let huntSchemaReady = null;
function ensureHuntSchema(env) {
  if (!huntSchemaReady) {
    huntSchemaReady = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS hunt_interests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        hunt_id TEXT NOT NULL,
        hunt_title TEXT NOT NULL DEFAULT '',
        hunt_url TEXT NOT NULL DEFAULT '',
        hunt_start TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, hunt_id)
      )`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_hunt_interests_hunt ON hunt_interests(hunt_id)').run();
      // 上游赛事快照（单行），避免每次请求都跨站抓取
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS hunt_feed (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )`).run();
      // 别人标记了我已标记的 hunt → 给我留一条动态
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS hunt_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        hunt_id TEXT NOT NULL,
        hunt_title TEXT NOT NULL DEFAULT '',
        actor_id INTEGER NOT NULL,
        actor_name TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        read_at TEXT,
        UNIQUE(user_id, hunt_id, actor_id)
      )`).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_hunt_notif_user ON hunt_notifications(user_id, id DESC)').run();
    })().catch((err) => { huntSchemaReady = null; throw err; });
  }
  return huntSchemaReady;
}

// 所有「我想参加」记录（封禁账号不计入展示）
async function loadInterests(env) {
  const rows = (await env.DB.prepare(
    `SELECT hi.hunt_id, hi.hunt_title, hi.hunt_url, hi.hunt_start, hi.created_at,
            u.id AS user_id, u.nickname, u.username
       FROM hunt_interests hi
       JOIN users u ON u.id = hi.user_id
      WHERE u.banned = 0
      ORDER BY hi.created_at, hi.id`
  ).all()).results;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.hunt_id)) map.set(r.hunt_id, { people: [], title: '', url: '', startAt: null });
    const bucket = map.get(r.hunt_id);
    bucket.people.push({ id: r.user_id, name: r.nickname || r.username });
    if (!bucket.title) {
      bucket.title = r.hunt_title;
      bucket.url = r.hunt_url;
      bucket.startAt = r.hunt_start;
    }
  }
  return map;
}

async function huntInterestCount(env, huntId) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM hunt_interests hi JOIN users u ON u.id = hi.user_id WHERE hi.hunt_id = ? AND u.banned = 0'
  ).bind(huntId).first();
  return row ? Number(row.n) || 0 : 0;
}

// ---------- 主路由 ----------
export default {
  // Cron Trigger：每 10 分钟把 puzzle.cat 的快照写进 D1，用户请求只读库
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureHuntSchema(env);
          await refreshFeed(env);
        } catch { /* 上游抖动时保留旧快照，下个周期再试 */ }
      })()
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // 静态资源 + SPA 兜底（HTML 不缓存，带 hash 的资源长缓存）
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) {
        // 只有页面导航才回落到 index.html；缺失的静态资源保持 404
        const accept = request.headers.get('accept') || '';
        if (!accept.includes('text/html')) return harden(res);
        // SPA 兜底：页面能打开，但状态码保持 404，避免未知路径伪装成正常页面
        const idx = await env.ASSETS.fetch(new Request(url.origin + '/index.html'));
        return harden(new Response(idx.body, {
          status: 404,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache, no-store, must-revalidate'
          }
        }));
      }
      const ctype = res.headers.get('content-type') || '';
      const headers = new Headers(res.headers);
      if (ctype.includes('text/html')) {
        headers.set('cache-control', 'no-cache, no-store, must-revalidate');
      } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
        // 带内容 hash，可无限缓存
        headers.set('cache-control', 'public, max-age=31536000, immutable');
      } else if (url.pathname === '/favicon.ico' || url.pathname.startsWith('/images/')) {
        // 文件名固定、内容极少变：给 1 天缓存 + 后台校验，避免每次访问都重新下载
        headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
      }
      return harden(new Response(res.body, { status: res.status, headers }));
    }

    const path = url.pathname.slice(5); // 去掉 /api/
    const method = request.method;
    const user = await getSessionUser(env, getCookie(request));

    // ---------- 公开 ----------
    // 发送邮箱验证码（注册 / 绑定邮箱共用）
    if (path === 'email-code' && method === 'POST') {
      const b = await readBody(request);
      const email = String(b.email || '').trim().toLowerCase();
      const purpose = b.purpose === 'bind' ? 'bind' : 'register';
      if (!EMAIL_RE.test(email) || email.length > 100) return json({ error: t('errors.emailInvalid') }, 400);
      if (purpose === 'bind' && !user) return json({ error: t('errors.unauthorized') }, 401);
      try {
        await ensureEmailSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      // 邮箱已被别的账号占用：不发码，直接说清楚
      const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').bind(email, user ? user.id : 0).first();
      if (taken) return json({ error: t('errors.emailTaken') }, 409);

      const now = Date.now();
      // 同邮箱冷却
      const last = await env.DB.prepare('SELECT expires_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1').bind(email, purpose).first();
      if (last) {
        const wait = CODE_COOLDOWN_MS - (now - (Number(last.expires_at) - CODE_TTL_MS));
        if (wait > 0) return json({ error: t('errors.codeCooldown', { s: Math.ceil(wait / 1000) }) }, 429);
      }
      // 同邮箱每小时上限
      const hourly = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND purpose = ? AND expires_at > ?')
        .bind(email, purpose, now - 60 * 60 * 1000 + CODE_TTL_MS).first();
      if (hourly && Number(hourly.n) >= CODE_MAX_PER_HOUR) return json({ error: t('errors.codeRateLimit') }, 429);
      // 同 IP 每小时上限（防批量刷别人的邮箱）
      const ip = request.headers.get('cf-connecting-ip') || '';
      if (ip) {
        const byIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE ip = ? AND expires_at > ?')
          .bind(ip, now - 60 * 60 * 1000 + CODE_TTL_MS).first();
        if (byIp && Number(byIp.n) >= 15) return json({ error: t('errors.codeRateLimit') }, 429);
      }

      const code = randomCode();
      const issuedAt = now;
      const expiresAt = now + CODE_TTL_MS;
      await env.DB.prepare(
        'INSERT INTO email_codes (email, purpose, code_hash, expires_at, ip) VALUES (?, ?, ?, ?, ?)'
      ).bind(email, purpose, await hashCode(email, code, issuedAt), expiresAt, ip).run();

      try {
        await sendCodeMail(env, email, code, purpose);
      } catch (err) {
        // 发信失败：把刚写入的码作废，避免用户拿着收不到的码干等
        await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE email = ? AND purpose = ? AND expires_at = ?').bind(email, purpose, expiresAt).run();
        const reason = String(err && err.message || '');
        return json({ error: reason === 'MAIL_NOT_CONFIGURED' ? t('errors.mailNotConfigured') : t('errors.mailFailed') }, 502);
      }
      return json({ ok: true, ttl: Math.round(CODE_TTL_MS / 1000) });
    }

    if (path === 'register' && method === 'POST') {
      const b = await readBody(request);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      const nickname = String(b.nickname || '').trim() || username;
      const email = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').trim();
      if (username.length < 2 || username.length > 20) return json({ error: t('errors.usernameLength') }, 400);
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) return json({ error: t('errors.usernameCharset') }, 400);
      const pwErr = passwordProblem(password, username);
      if (pwErr) return json({ error: t(pwErr) }, 400);
      if (!EMAIL_RE.test(email) || email.length > 100) return json({ error: t('errors.emailInvalid') }, 400);
      if (!code) return json({ error: t('errors.codeRequired') }, 400);
      const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) return json({ error: t('errors.usernameTaken') }, 409);
      try {
        await ensureEmailSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (taken) return json({ error: t('errors.emailTaken') }, 409);
      const v = await verifyCode(env, email, 'register', code);
      if (!v.ok) return json({ error: t(v.error) }, 400);
      const { salt, hash } = await hashPassword(password);
      await env.DB.prepare('INSERT INTO users (username, password, nickname, role, email) VALUES (?, ?, ?, ?, ?)')
        .bind(username, salt + ':' + hash, nickname, 'user', email).run();
      return json({ ok: true });
    }

    if (path === 'login' && method === 'POST') {
      const b = await readBody(request);
      const username = String(b.username || '').trim();
      // 登录节流：IP 与用户名两路计数，命中任一即 429（不透露账号是否存在）
      const ipKey = 'lf:ip:' + clientIp(request);
      const userKey = 'lf:u:' + username.toLowerCase();
      const [ipRec, userRec] = await Promise.all([readFail(env, ipKey), readFail(env, userKey)]);
      const blockedUntil = Math.max(failBlocked(ipRec, LOGIN_IP_MAX), failBlocked(userRec, LOGIN_USER_MAX));
      if (blockedUntil > Date.now()) {
        const retry = Math.ceil((blockedUntil - Date.now()) / 1000);
        return json({ error: t('errors.tooManyAttempts', { n: retry }) }, 429);
      }
      const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
      if (!row) {
        // 枚举防护：用户名不存在时也执行一次等价的 PBKDF2，使响应耗时与"存在但密码错"一致
        await hashPassword(String(b.password || ''), DUMMY_SALT);
        await Promise.all([
          bumpFail(env, ipKey, ipRec, LOGIN_IP_MAX),
          bumpFail(env, userKey, userRec, LOGIN_USER_MAX)
        ]);
        return json({ error: t('errors.badCredentials') }, 401);
      }
      const [salt, hash] = String(row.password).split(':');
      if (!(await verifyPassword(String(b.password || ''), salt, hash))) {
        await Promise.all([
          bumpFail(env, ipKey, ipRec, LOGIN_IP_MAX),
          bumpFail(env, userKey, userRec, LOGIN_USER_MAX)
        ]);
        return json({ error: t('errors.badCredentials') }, 401);
      }
      if (row.banned) return json({ error: t('errors.banned') }, 403);
      // 登录成功清零计数
      await Promise.all([env.SESSIONS.delete(ipKey), env.SESSIONS.delete(userKey)]);
      const token = await createSession(env, row.id, row.session_version);
      return okWithCookie({ ok: true, user: { id: row.id, username: row.username, nickname: row.nickname, role: row.role, created_at: row.created_at, email: row.email || null } }, token);
    }

    if (path === 'logout' && method === 'POST') {
      const m = (getCookie(request) || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
      if (m) { const t = m.slice(SESSION_COOKIE.length + 1); await env.SESSIONS.delete('s:' + t); }
      return okWithCookie({ ok: true }, null);
    }

    if (path === 'me' && method === 'GET') {
      // 顺带带回未读动态数，导航角标首屏就能显示，省一次请求
      let notifUnread = 0;
      let email = null;
      if (user) {
        try {
          const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM hunt_notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id).first();
          notifUnread = row ? Number(row.n) || 0 : 0;
        } catch { notifUnread = 0; }
        // email 列由迁移补，未迁移时也不能让 /me 500
        try {
          const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(user.id).first();
          email = row ? (row.email || null) : null;
        } catch { /* 列不存在 */ }
      }
      return json({ user: user ? { ...user, email } : null, notifUnread });
    }

    // ---------- 以下需要登录 ----------
    if (!user) return json({ error: t('errors.unauthorized') }, 401);

    if (path === 'change-password' && method === 'POST') {
      const b = await readBody(request);
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      if (!row) return json({ error: t('errors.unauthorized') }, 401);
      const [salt, hash] = String(row.password).split(':');
      if (!(await verifyPassword(String(b.old_password || ''), salt, hash))) return json({ error: t('errors.wrongOldPassword') }, 400);
      const np = String(b.new_password || '');
      const pwErr = passwordProblem(np, user.username);
      if (pwErr) return json({ error: t(pwErr === 'errors.passwordLength' ? 'errors.newPasswordLength' : pwErr) }, 400);
      const { salt: s2, hash: h2 } = await hashPassword(np);
      await env.DB.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?').bind(s2 + ':' + h2, user.id).run();
      return json({ ok: true });
    }

    // 修改自己的昵称（管理员改他人昵称走 admin/users/:id）
    if (path === 'profile' && method === 'PATCH') {
      const b = await readBody(request);
      const nickname = String(b.nickname || '').trim();
      if (!nickname) return json({ error: t('errors.nicknameEmpty') }, 400);
      if ([...nickname].length > 20) return json({ error: t('errors.nicknameTooLong') }, 400);
      await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nickname, user.id).run();
      return json({ ok: true, nickname });
    }

    // 绑定 / 更换自己的邮箱（需验证码；老账号自愿补绑走这里）
    if (path === 'profile/email' && method === 'POST') {
      const b = await readBody(request);
      const email = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').trim();
      if (!EMAIL_RE.test(email) || email.length > 100) return json({ error: t('errors.emailInvalid') }, 400);
      if (!code) return json({ error: t('errors.codeRequired') }, 400);
      try {
        await ensureEmailSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').bind(email, user.id).first();
      if (taken) return json({ error: t('errors.emailTaken') }, 409);
      const v = await verifyCode(env, email, 'bind', code);
      if (!v.ok) return json({ error: t(v.error) }, 400);
      await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, user.id).run();
      return json({ ok: true, email });
    }

    // 公告
    if (path === 'announcements' && method === 'GET') {
      return json({ list: await loadAnnouncements(env) });
    }

    if (path === 'announcements' && method === 'POST') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const b = await readBody(request);
      if (!String(b.title || '').trim() || !String(b.content || '').trim()) return json({ error: t('errors.announceEmpty') }, 400);
      // 返回完整行：前端可直接插入列表，不必依赖紧随其后的刷新
      const rows = (await env.DB.prepare(
        'INSERT INTO announcements (title, content, author, pinned) VALUES (?, ?, ?, ?) RETURNING *'
      ).bind(String(b.title).trim(), String(b.content).trim(), user.nickname || user.username, b.pinned ? 1 : 0).all()).results;
      const ann = rows && rows[0];
      return json({ ok: true, id: ann ? ann.id : null, ann: ann || null });
    }

    // ---------- 收件箱（成员一次取全） ----------
    // 一次请求返回 公告 + 会话 + 消息 + 未读数，替代原先的 4 次串行往返
    // after>0 时只取增量消息（公告只回版本号，变了前端再单独拉）
    if (path === 'inbox' && method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      // mark=0：只取数据、不推进已读位。用于「登录后在首页后台预取」，避免用户还没看就把消息标成已读
      const mark = url.searchParams.get('mark') !== '0';
      const conv = await env.DB.prepare('SELECT * FROM conversations WHERE user_id = ?').bind(user.id).first();
      const annVersionP = announcementVersion(env);

      if (!conv) {
        const [anns, annVersion] = await Promise.all([loadAnnouncements(env), annVersionP]);
        return json({ announcements: anns, annVersion, conv: null, list: [], unread: 0 });
      }

      if (after > 0) {
        const [msgs, annVersion] = await Promise.all([
          env.DB.prepare('SELECT m.*, COALESCE(u.nickname, \'已注销用户\') AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conv_id = ? AND m.id > ? ORDER BY m.id LIMIT 50').bind(conv.id, after).all(),
          annVersionP
        ]);
        const list = msgs.results;
        if (list.length && mark) {
          const last = list[list.length - 1].id;
          // 已读标记放到响应之后执行，不占用户等待时间
          if (ctx && ctx.waitUntil) ctx.waitUntil(markRead(env, conv.id, last, true));
          else await markRead(env, conv.id, last, true);
        }
        return json({ annVersion, convId: conv.id, list, unread: 0 });
      }

      const [anns, annVersion, msgs, unreadRow] = await Promise.all([
        loadAnnouncements(env),
        annVersionP,
        env.DB.prepare('SELECT m.*, COALESCE(u.nickname, \'已注销用户\') AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conv_id = ? ORDER BY m.id DESC LIMIT 50').bind(conv.id).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND direction = 'to_user' AND id > ?").bind(conv.id, conv.user_last_read_id).first()
      ]);
      const list = msgs.results.reverse();
      const last = list.length ? list[list.length - 1].id : 0;
      if (last && mark) {
        if (ctx && ctx.waitUntil) ctx.waitUntil(markRead(env, conv.id, last, true));
        else await markRead(env, conv.id, last, true);
      }
      return json({
        announcements: anns,
        annVersion,
        conv: { id: conv.id, user_id: conv.user_id, created_at: conv.created_at, updated_at: conv.updated_at },
        list,
        unread: unreadRow ? Number(unreadRow.n) || 0 : 0
      });
    }

    // ---------- 赛事总览（登录可见） ----------
    // 列表来自 puzzle.cat；「我想参加」标记对所有登录成员可见
    if (path === 'hunts' && method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      try {
        await ensureHuntSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      const started = Date.now();
      let feed;
      try {
        feed = await getHuntFeed(env, { force, ctx });
      } catch {
        return json({ error: t('errors.huntsUnavailable') }, 502);
      }
      const feedMs = Date.now() - started;
      const marks = await loadInterests(env);
      const seen = new Set();
      const list = feed.items.map((h) => {
        seen.add(h.id);
        const m = marks.get(h.id);
        const people = m ? m.people : [];
        return {
          ...h,
          interested: people.map((p) => ({ name: p.name, me: p.id === user.id })),
          mine: people.some((p) => p.id === user.id)
        };
      });
      // 已标记但上游列表里没有的赛事：保留展示，避免标记无声消失
      for (const [huntId, m] of marks) {
        if (seen.has(huntId)) continue;
        list.push({
          id: huntId,
          title: m.title || huntId,
          summary: '',
          url: m.url || 'https://puzzle.cat/hunts/' + encodeURIComponent(huntId),
          startAt: m.startAt || null,
          endAt: null,
          timezone: 'Asia/Shanghai',
          status: '',
          type: '',
          tags: [],
          lang: '',
          rating: 0,
          difficulty: 0,
          thumb: '',
          authors: [],
          external: false,
          missing: true,
          interested: m.people.map((p) => ({ name: p.name, me: p.id === user.id })),
          mine: m.people.some((p) => p.id === user.id)
        });
      }
      const res = json({
        updatedAt: feed.at,
        list,
        total: list.length,
        mineCount: list.filter((h) => h.mine).length
      });
      // 便于线上排查：快照来源与读库耗时
      res.headers.set('x-feed-source', feed.source || 'unknown');
      res.headers.set('server-timing', 'feed;desc=' + (feed.source || 'unknown') + ';dur=' + feedMs);
      return res;
    }

    // 标记 / 取消标记「我想参加」
    if (path === 'hunts/interest' && method === 'POST') {
      const b = await readBody(request);
      const huntId = String(b.hunt_id || '');
      if (!isValidHuntId(huntId)) return json({ error: t('errors.badParams') }, 400);
      const interested = !(b.interested === false || b.interested === 0 || b.interested === '0');
      try {
        await ensureHuntSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      if (interested) {
        let feed;
        try {
          feed = await getHuntFeed(env, { ctx });
        } catch {
          return json({ error: t('errors.huntsUnavailable') }, 502);
        }
        const h = feed.items.find((x) => x.id === huntId);
        // 只允许标记上游真实存在的赛事，标题等快照一律取服务端数据
        if (!h) return json({ error: t('errors.huntNotFound') }, 404);
        const existed = await env.DB.prepare('SELECT 1 AS x FROM hunt_interests WHERE user_id = ? AND hunt_id = ?')
          .bind(user.id, h.id).first();
        await env.DB.prepare(
          `INSERT INTO hunt_interests (user_id, hunt_id, hunt_title, hunt_url, hunt_start)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, hunt_id) DO UPDATE SET
             hunt_title = excluded.hunt_title,
             hunt_url = excluded.hunt_url,
             hunt_start = excluded.hunt_start`
        ).bind(user.id, h.id, h.title, h.url, h.startAt || null).run();
        // 新标记才通知：给同一赛事下已经标记过的其他成员各留一条动态
        if (!existed) {
          try {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO hunt_notifications (user_id, hunt_id, hunt_title, actor_id, actor_name)
               SELECT hi.user_id, ?, ?, ?, ?
                 FROM hunt_interests hi
                 JOIN users u ON u.id = hi.user_id AND u.banned = 0
                WHERE hi.hunt_id = ? AND hi.user_id <> ?`
            ).bind(h.id, h.title, user.id, user.nickname || user.username, h.id, user.id).run();
          } catch { /* 通知失败不影响标记本身 */ }
        }
      } else {
        await env.DB.prepare('DELETE FROM hunt_interests WHERE user_id = ? AND hunt_id = ?').bind(user.id, huntId).run();
      }
      return json({ ok: true, interested, count: await huntInterestCount(env, huntId) });
    }

    // ---------- 赛事动态（别人标记了我已标记的 hunt） ----------
    if (path === 'notifications' && method === 'GET') {
      try {
        await ensureHuntSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      const [rows, unreadRow] = await Promise.all([
        env.DB.prepare(
          `SELECT id, hunt_id, hunt_title, actor_name, created_at, read_at
             FROM hunt_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`
        ).bind(user.id).all(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM hunt_notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id).first()
      ]);
      return json({ list: rows.results, unread: unreadRow ? Number(unreadRow.n) || 0 : 0 });
    }

    if (path === 'notifications/read' && method === 'POST') {
      await env.DB.prepare("UPDATE hunt_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").bind(user.id).run();
      return json({ ok: true });
    }

    // ---------- 工单会话（会员↔STAFF 双向） ----------
    if (path === 'conversation' && method === 'GET') {
      if (isStaff(user)) {
        const list = (await env.DB.prepare("SELECT c.*, u.username, u.nickname, (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id AND m.direction = 'to_staff' AND m.id > c.staff_last_read_id) AS unread FROM conversations c JOIN users u ON u.id = c.user_id ORDER BY c.updated_at DESC").all()).results;
        return json({ list });
      }
      const conv = await env.DB.prepare('SELECT * FROM conversations WHERE user_id = ?').bind(user.id).first();
      if (!conv) return json({ conv: null, unread: 0 });
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND direction = 'to_user' AND id > ?").bind(conv.id, conv.user_last_read_id).first();
      return json({ conv, unread: row ? row.n : 0 });
    }

    // 会员发消息（自动建会话）
    if (path === 'conversation/message' && method === 'POST') {
      const b = await readBody(request);
      const content = String(b.content || '').trim();
      if (!content) return json({ error: t('errors.contentEmpty') }, 400);
      if (content.length > 1000) return json({ error: t('errors.contentTooLong') }, 400);
      let conv = await env.DB.prepare('SELECT * FROM conversations WHERE user_id = ?').bind(user.id).first();
      if (!conv) {
        const cr = await env.DB.prepare('INSERT INTO conversations (user_id) VALUES (?)').bind(user.id).run();
        conv = { id: cr.meta.last_row_id };
      }
      const ins = await env.DB.prepare("INSERT INTO messages (conv_id, sender_id, direction, content) VALUES (?, ?, 'to_staff', ?) RETURNING id, created_at").bind(conv.id, user.id, content).all();
      await env.DB.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").bind(conv.id).run();
      const row = (ins.results && ins.results[0]) || {};
      return json({
        ok: true,
        conv_id: conv.id,
        msg_id: row.id || null,
        msg: {
          id: row.id, conv_id: conv.id, sender_id: user.id, direction: 'to_staff',
          content, created_at: row.created_at || null, sender_name: user.nickname || user.username
        }
      });
    }

    // STAFF 回复
    if (path === 'conversation/reply' && method === 'POST') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const b = await readBody(request);
      const convId = Number(b.conv_id);
      const content = String(b.content || '').trim();
      if (!convId || !content) return json({ error: t('errors.badParams') }, 400);
      if (content.length > 1000) return json({ error: t('errors.contentTooLong') }, 400);
      const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
      if (!conv) return json({ error: t('errors.convNotFound') }, 404);
      const ins = await env.DB.prepare("INSERT INTO messages (conv_id, sender_id, direction, content) VALUES (?, ?, 'to_user', ?) RETURNING id, created_at").bind(convId, user.id, content).all();
      await env.DB.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").bind(convId).run();
      const row = (ins.results && ins.results[0]) || {};
      return json({
        ok: true,
        msg_id: row.id || null,
        msg: {
          id: row.id, conv_id: convId, sender_id: user.id, direction: 'to_user',
          content, created_at: row.created_at || null, sender_name: user.nickname || user.username
        }
      });
    }

    // 拉取消息（after=增量，默认最近 50 条）
    if (path.indexOf('conversation/') === 0 && path.endsWith('/messages') && method === 'GET') {
      const convId = Number(path.split('/')[1]);
      const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
      if (!conv) return json({ error: t('errors.convNotFound') }, 404);
      const isOwner = conv.user_id === user.id;
      if (!isOwner && !isStaff(user)) return json({ error: t('errors.forbidden') }, 403);
      const after = Number(url.searchParams.get('after') || 0);
      let msgs;
      if (after > 0) {
        msgs = (await env.DB.prepare('SELECT m.*, COALESCE(u.nickname, \'已注销用户\') AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conv_id = ? AND m.id > ? ORDER BY m.id LIMIT 50').bind(convId, after).all()).results;
      } else {
        msgs = (await env.DB.prepare('SELECT m.*, COALESCE(u.nickname, \'已注销用户\') AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conv_id = ? ORDER BY m.id DESC LIMIT 50').bind(convId).all()).results;
        msgs.reverse();
      }
      return json({ conv: { id: conv.id, user_id: conv.user_id }, list: msgs });
    }

    // 标记已读
    if (path.indexOf('conversation/') === 0 && path.endsWith('/read') && method === 'POST') {
      const convId = Number(path.split('/')[1]);
      const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
      if (!conv) return json({ error: t('errors.convNotFound') }, 404);
      const isOwner = conv.user_id === user.id;
      if (!isOwner && !isStaff(user)) return json({ error: t('errors.forbidden') }, 403);
      const last = await env.DB.prepare('SELECT MAX(id) AS n FROM messages WHERE conv_id = ?').bind(convId).first();
      if (isOwner) await env.DB.prepare('UPDATE conversations SET user_last_read_id = ? WHERE id = ?').bind(last.n || 0, convId).run();
      else await env.DB.prepare('UPDATE conversations SET staff_last_read_id = ? WHERE id = ?').bind(last.n || 0, convId).run();
      return json({ ok: true });
    }
    // 管理概览
    if (path === 'admin/stats' && method === 'GET') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      return json(await adminStats(env));
    }

    // 管理端一次取全：公告 + 用户 + 会话 + 统计
    // 原先管理台首屏要 4 个请求（每个都要重新验一次会话），这里合并成 1 个
    if (path === 'admin/overview' && method === 'GET') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const [anns, users, convs, stats] = await Promise.all([
        loadAnnouncements(env),
        env.DB.prepare('SELECT id, username, nickname, role, banned, created_at FROM users ORDER BY id').all(),
        env.DB.prepare("SELECT c.*, u.username, u.nickname, (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id AND m.direction = 'to_staff' AND m.id > c.staff_last_read_id) AS unread FROM conversations c JOIN users u ON u.id = c.user_id ORDER BY c.updated_at DESC").all(),
        adminStats(env)
      ]);
      return json({ anns, users: users.results, convs: convs.results, stats });
    }

    // 管理员：用户管理
    if (path === 'admin/users' && method === 'GET') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const q = String(url.searchParams.get('q') || '').trim();
      let list;
      if (q) {
        list = (await env.DB.prepare("SELECT id, username, nickname, role, banned, created_at FROM users WHERE username LIKE ? OR nickname LIKE ? ORDER BY id").bind('%' + q + '%', '%' + q + '%').all()).results;
      } else {
        list = (await env.DB.prepare('SELECT id, username, nickname, role, banned, created_at FROM users ORDER BY id').all()).results;
      }
      return json({ list });
    }

    if (path.startsWith('admin/users/') && method === 'PATCH') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const id = Number(path.split('/')[2]);
      if (!id) return json({ error: t('errors.badParams') }, 400);
      const target = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?').bind(id).first();
      if (!target) return json({ error: t('errors.userNotFound') }, 404);
      const targetIsSuper = target.role === 'superadmin';
      const b = await readBody(request);

      // 授权（设为/撤销管理员）只给超管
      if (b.role !== undefined) {
        if (!isSuper(user)) return json({ error: t('errors.superOnly') }, 403);
        if (!['user', 'admin'].includes(b.role)) return json({ error: t('errors.invalidRole') }, 400);
        if (targetIsSuper || id === user.id) return json({ error: t('errors.cannotEditSuper') }, 400);
        await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run();
      }
      // 其余改动不允许落到超管账号上（自己改自己除外）
      const guarded = targetIsSuper && id !== user.id;
      if (b.nickname !== undefined) {
        if (guarded) return json({ error: t('errors.cannotEditSuper') }, 400);
        await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(String(b.nickname).trim(), id).run();
      }
      if (b.banned !== undefined) {
        if (id === user.id) return json({ error: t('errors.cannotBanSelf') }, 400);
        if (targetIsSuper) return json({ error: t('errors.cannotEditSuper') }, 400);
        await env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(b.banned ? 1 : 0, id).run();
      }
      if (b.new_password !== undefined) {
        if (guarded) return json({ error: t('errors.cannotEditSuper') }, 400);
        const np = String(b.new_password);
        const pwErr = passwordProblem(np, null);
        if (pwErr) return json({ error: t(pwErr === 'errors.passwordLength' ? 'errors.newPasswordLength' : pwErr) }, 400);
        const { salt: s2, hash: h2 } = await hashPassword(np);
        await env.DB.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?').bind(s2 + ':' + h2, id).run();
      }
      return json({ ok: true });
    }

    // 删除账号：仅超管，且不能删自己或另一个超管
    if (path.startsWith('admin/users/') && method === 'DELETE') {
      if (!isSuper(user)) return json({ error: t('errors.superOnly') }, 403);
      const id = Number(path.split('/')[2]);
      if (!id) return json({ error: t('errors.badParams') }, 400);
      if (id === user.id) return json({ error: t('errors.cannotDeleteSelf') }, 400);
      const target = await env.DB.prepare('SELECT id, username, role, email FROM users WHERE id = ?').bind(id).first();
      if (!target) return json({ error: t('errors.userNotFound') }, 404);
      if (target.role === 'superadmin') return json({ error: t('errors.cannotEditSuper') }, 400);
      // 没有外键级联，手动按顺序清：消息 → 会话 → 赛事标记/通知（含他人列表里以他为主角的动态）→ 用户
      await env.DB.batch([
        env.DB.prepare('DELETE FROM messages WHERE conv_id IN (SELECT id FROM conversations WHERE user_id = ?)').bind(id),
        env.DB.prepare('DELETE FROM conversations WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM hunt_interests WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM hunt_notifications WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM hunt_notifications WHERE actor_id = ?').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
      ]);
      if (target.email) {
        try { await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(target.email).run(); } catch { /* 表未建 */ }
      }
      return json({ ok: true, id });
    }

    if (path.startsWith('admin/announcements/') && method === 'PATCH') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const id = Number(path.split('/')[2]);
      const b = await readBody(request);
      if (b.title !== undefined && !String(b.title).trim()) return json({ error: t('errors.titleEmpty') }, 400);
      const r = await env.DB.prepare('UPDATE announcements SET title = COALESCE(?, title), content = COALESCE(?, content), pinned = COALESCE(?, pinned) WHERE id = ?')
        .bind(b.title !== undefined ? String(b.title).trim() : null, b.content !== undefined ? String(b.content) : null, b.pinned !== undefined ? (b.pinned ? 1 : 0) : null, id).run();
      // 影响 0 行 = 这条公告已不存在（可能被别的管理员删了）：必须报错，不能静默返回 ok
      if (!r.meta.changes) return json({ error: t('errors.announceGone') }, 404);
      return json({ ok: true, id });
    }

    if (path.startsWith('admin/announcements/') && method === 'DELETE') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const r = await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(Number(path.split('/')[2])).run();
      if (!r.meta.changes) return json({ error: t('errors.announceGone') }, 404);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  }
}

function okWithCookie(data, token) {
  const res = json(data);
  if (token) res.headers.set('set-cookie', sessionCookie(token));
  else if (token === null) res.headers.set('set-cookie', clearCookie());
  return res;
}