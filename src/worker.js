// CAAR 用户系统 API —— Cloudflare Worker（D1 + KV）
// 密码哈希：PBKDF2-SHA256（Web Crypto）
// 会话：随机令牌存 KV，HttpOnly Cookie
// 所有面向用户的提示文案统一取自 locales/zh-CN.js
import { t } from './i18n.js'
import { NEWS_CONTENT_MAX as NEWS_TEXT_MAX, normalizeNewsDocument, newsDocumentText } from './newsContent.js'
import { getHuntFeed, refreshFeed, isValidHuntId } from './hunts.js'
// 登录节流单独成模块：不依赖 Workers 运行时，可被 tests/ 直接驱动
import {
  LOGIN_COMBO_MAX, LOGIN_IP_MAX, LOGIN_USER_MAX, LOGIN_STAFF_MAX,
  ensureLoginSchema, hitLimit, clearLimit, pruneLoginFails, clientIp
} from './loginLimit.js'
import {
  createLogger, describeError, requestMeta, maskEmail,
  audit, auditBudgetSnapshot, pruneAuditLogs, auditKeepDays, escapeLike
} from './log.js'
// PuzzleCat OAuth2.0：协议细节单独成模块（只用 fetch + Web Crypto，便于测试直接驱动）
import {
  PROVIDER as OAUTH_PROVIDER, oauthConfigured, redirectUri, authorizeUrl, randomState,
  exchangeCode, fetchUserinfo, revokeToken, makeOauthOnlyPassword, usernameSeed, usernameCandidate,
  isOauthOnly, safeNext
} from './oauth.js'

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

// 429 同时给出 Retry-After，便于网关与自动化客户端遵循
function jsonRetry(data, status, retry) {
  const res = json(data, status);
  res.headers.set('retry-after', String(Math.max(1, Number(retry) || 1)));
  return res;
}

const MAX_BODY_BYTES = 64 * 1024;
const NEWS_BODY_MAX_BYTES = 128 * 1024;
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { __tooLarge: true };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
      const value = JSON.parse(dec.decode(bytes));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  } catch { return {}; }
  finally { try { reader.releaseLock(); } catch { /* stream was already released */ } }
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
const PASSWORD_MAX = 200;
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'passw0rd',
  'qwertyui', 'qwerty123', 'abc12345', 'iloveyou', 'admin123', 'caar1234'
]);
// 返回错误文案 key，合法时返回 null
function passwordProblem(pw, username) {
  const s = String(pw);
  if (s.length < PASSWORD_MIN) return 'errors.passwordLength';
  // 上限防止超长输入拖慢 PBKDF2（CPU 放大）
  if (s.length > PASSWORD_MAX) return 'errors.passwordTooLong';
  const low = s.toLowerCase();
  if (WEAK_PASSWORDS.has(low)) return 'errors.passwordWeak';
  if (username && low === String(username).toLowerCase()) return 'errors.passwordWeak';
  return null;
}

// ---------- 昵称与标题长度 ----------
// 昵称会出现在赛事列表（interested[].name）、工单发送者、公告作者等处，
// 上限必须在**所有写入路径**统一，否则一个超长昵称能让所有人的列表响应体膨胀。
const NICKNAME_MAX = 20;
const ANNOUNCE_TITLE_MAX = 100;
const NEWS_TITLE_MAX = 100;
const NEWS_SUMMARY_MAX = 280;
const NEWS_CONTENT_MAX = NEWS_TEXT_MAX;
const NEWS_PAGE_SIZE = 20;

// 返回 { value } 或 { error: 文案 key }；注册、后台改名、用户自助改名三条路径共用
function normalizeNickname(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'errors.nicknameEmpty' };
  if ([...s].length > NICKNAME_MAX) return { error: 'errors.nicknameTooLong' };
  // 控制字符与双向文本覆盖符：前者会截断/串行显示，后者能伪造列表里的显示顺序
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s)) return { error: 'errors.nicknameInvalid' };
  return { value: s };
}

// ---------- 登录节流 ----------
// 实现与常量见 src/loginLimit.js（单独成模块，便于 tests/ 用 sqlite 驱动验证不变量）。
// 这里只负责调用：三层键 lf:ipu / lf:u / lf:ip，成功登录只清本人键。

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
async function verifyCode(env, email, purpose, code, log) {
  // 失败只进控制台：单码有 5 次上限，但「换邮箱/换码继续试」的行为需要可见，
  // 又不值得为每次猜测写一行 D1（那正是被放大的路径）
  const fail = (reason) => {
    if (log) log.warn('verify.code.fail', { purpose, email: maskEmail(email), reason });
    return { ok: false, error: reason };
  };
  const row = await env.DB.prepare(
    'SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).bind(email, purpose).first();
  if (!row) return fail('errors.codeMissing');
  if (Number(row.expires_at) < Date.now()) return fail('errors.codeExpired');
  if (Number(row.attempts) >= CODE_MAX_ATTEMPTS) return fail('errors.codeTooMany');
  const issuedAt = Number(row.expires_at) - CODE_TTL_MS;
  const hash = await hashCode(email, String(code), issuedAt);
  if (hash !== row.code_hash) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    return fail('errors.codeWrong');
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

// ---------- PuzzleCat OAuth ----------
// state 放 HttpOnly Cookie（SameSite=Lax，回跳是同站顶层导航，Lax 会带上）：
// 不放 KV —— 未登录端点不该有写放大，而 state 只需活过"跳出去再回来"这一分钟。
const OAUTH_STATE_COOKIE = 'caar_oauth_state';
const OAUTH_STATE_TTL = 10 * 60;
const OAUTH_NEXT_COOKIE = 'caar_oauth_next';

function oauthStateCookie(state) {
  return OAUTH_STATE_COOKIE + '=' + state + '; Path=/api/oauth; HttpOnly; SameSite=Lax; Secure; Max-Age=' + OAUTH_STATE_TTL;
}
function oauthNextCookie(next) {
  return OAUTH_NEXT_COOKIE + '=' + encodeURIComponent(next) + '; Path=/api/oauth; HttpOnly; SameSite=Lax; Secure; Max-Age=' + OAUTH_STATE_TTL;
}
function oauthClearCookies() {
  const kill = '; Path=/api/oauth; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
  return [OAUTH_STATE_COOKIE + '=' + kill, OAUTH_NEXT_COOKIE + '=' + kill];
}
function readCookie(req, name) {
  const m = (getCookie(req) || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}
// cookie 值来自客户端，畸形百分号编码会让 decodeURIComponent 抛 URIError；
// 解不开就当没带，回落到默认路径，不要让整个回调 500
function decodeCookieValue(raw) {
  try { return decodeURIComponent(String(raw || '')); } catch { return ''; }
}

// 用户名冲突时按 _2/_3… 顺延；上限 20 码点（与注册口径一致）
async function uniqueUsername(env, base) {
  for (let i = 1; i <= 50; i++) {
    const candidate = usernameCandidate(base, i);
    const hit = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(candidate).first();
    if (!hit) return candidate;
  }
  // 极端情况：同名太多，退回带随机后缀的兜底名
  return usernameCandidate('pc' + crypto.randomUUID().slice(0, 8).replace(/-/g, ''), 1);
}

/**
 * 按 PuzzleCat 身份找账号，没有就建一个。
 *
 * 身份绑定用 users.email —— 本站邮箱列已有 UNIQUE 索引（0006 迁移），
 * 且 PuzzleCat 的 userinfo 必带 email，因此不新增表、不新增列就能把
 * 「同一邮箱 = 同一个人」这件事落到库约束上。
 *
 * 两种情况要分开：
 *   1) 邮箱已存在 → 直接登录该账号（PuzzleCat 已验证过这个邮箱，等价于邮箱持有证明）
 *   2) 邮箱不存在 → 建号，password 写 oauth$ 前缀的随机占位值（见 oauth.js 注释）
 *
 * 邮箱缺失时不建号：没有稳定标识，重复登录会无限建号。
 */
async function findOrCreateOauthUser(env, profile) {
  const email = String(profile.email || '').trim().toLowerCase();
  if (!email) return { error: 'errors.oauthNoEmail' };
  try {
    await ensureEmailSchema(env);
  } catch {
    return { error: 'errors.serverError' };
  }

  const existing = await env.DB.prepare(
    'SELECT id, username, nickname, role, banned, session_version, created_at, email FROM users WHERE email = ?'
  ).bind(email).first();
  if (existing) return { user: existing, created: false };

  // 昵称：上游昵称合规就用，否则沿用用户名（注册路径同样允许不填昵称）
  const nick = normalizeNickname(profile.nickname);
  const username = await uniqueUsername(env, usernameSeed(profile));
  const nickname = nick.error ? username : nick.value;
  try {
    const ins = await env.DB.prepare(
      'INSERT INTO users (username, password, nickname, role, email) VALUES (?, ?, ?, ?, ?)'
    ).bind(username, makeOauthOnlyPassword(), nickname, 'user', email).run();
    const id = ins.meta && ins.meta.last_row_id;
    const row = await env.DB.prepare(
      'SELECT id, username, nickname, role, banned, session_version, created_at, email FROM users WHERE id = ?'
    ).bind(id).first();
    return { user: row, created: true };
  } catch (err) {
    // 并发首登：两个请求同时看到"邮箱不存在"，其中一个会撞 UNIQUE 索引。
    // 这不是错误，重查一次即可拿到对方刚建的那一行。
    const again = await env.DB.prepare(
      'SELECT id, username, nickname, role, banned, session_version, created_at, email FROM users WHERE email = ?'
    ).bind(email).first();
    if (again) return { user: again, created: false };
    throw err;
  }
}

// 回跳页：302 回前端路由，把结果放在查询串里（?oauth=ok#/account）。
//
// 不用内联 <script> 跳转：站点 CSP 是 script-src 'self'，内联脚本会被浏览器拦掉，
// 页面会停在白屏。302 之后由前端读 location.search 决定提示文案并清掉参数，
// 这样授权码/令牌从不进地址栏历史，回跳目标也只能是站内路径。
function oauthLanding(next, code) {
  const target = '/' + (code ? '?oauth=' + encodeURIComponent(code) : '') + '#' + safeNext(next);
  const res = new Response(null, {
    status: 302,
    headers: { location: target, 'cache-control': 'no-store' }
  });
  for (const c of oauthClearCookies()) res.headers.append('set-cookie', c);
  return harden(res);
}

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

function newsDocumentFromRow(row) {
  if (row.content_format === 'rich-v1') {
    try { return normalizeNewsDocument(JSON.parse(row.content)) || { type: 'doc', children: [] }; }
    catch { return { type: 'doc', children: [] }; }
  }
  const text = String(row.content || '');
  return { type: 'doc', children: text ? text.split(/\n{2,}/).map((part) => ({
    type: 'paragraph', children: part.split('\n').flatMap((line, i) => i ? [{ type: 'hardBreak' }, { type: 'text', text: line, marks: [] }] : [{ type: 'text', text: line, marks: [] }])
  })) : [] };
}

function parseNewsSubmission(body) {
  const title = String(body.title || '').trim();
  const summary = String(body.summary || '').trim();
  const document = normalizeNewsDocument(body.content);
  const plainText = document ? newsDocumentText(document).trim() : '';
  if (!title || !plainText) return { error: 'errors.newsEmpty' };
  if ([...title].length > NEWS_TITLE_MAX) return { error: 'errors.newsTitleTooLong' };
  if ([...summary].length > NEWS_SUMMARY_MAX) return { error: 'errors.newsSummaryTooLong' };
  if (!document || [...plainText].length > NEWS_CONTENT_MAX || JSON.stringify(document).length > 60000) return { error: 'errors.newsContentTooLong' };
  return { title, summary, document, content: JSON.stringify(document), excerpt: plainText.slice(0, 300), length: [...plainText].length };
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

// 日志页「近 24 小时 / 事件下拉」的全局口径缓存（60 秒），以及"谁翻过日志"的限频表
let logsSummaryCache = { at: 0, data: null };
const logsReadSeen = new Map();

// 审计表按保留期清理：每个 isolate 最多 6 小时做一次，避免每 10 分钟的 Cron 都发删除语句
let lastAuditPrune = 0;
async function maybePruneAudit(env, log) {
  if (Date.now() - lastAuditPrune < 6 * 60 * 60 * 1000) return;
  lastAuditPrune = Date.now();
  try {
    const removed = await pruneAuditLogs(env);
    if (removed) log.info('audit.prune', { removed, keepDays: auditKeepDays(env) });
  } catch (err) {
    // 迁移没跑时表不存在，属预期窗口：不刷日志（audit() 自己会在首次写入时提醒一次）
    if (!/no such table/i.test(String((err && err.message) || ''))) {
      log.warn('audit.prune.fail', { err: describeError(err) });
    }
  }
}

// ---------- 主路由 ----------
const app = {
  // Cron Trigger：每 10 分钟把 puzzle.cat 的快照写进 D1，用户请求只读库
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const log = createLogger(env, { job: 'cron' });
        try {
          await ensureHuntSchema(env);
          await refreshFeed(env);
        } catch (err) {
          // 上游抖动时保留旧快照、下个周期再试，但错误必须留档：
          // 否则「赛事列表一直不更新」只能靠猜
          log.error('cron.feed.fail', { err: describeError(err) });
          await audit(env, null, {
            event: 'cron.feed.fail', level: 'error', path: '/__scheduled', meta: { err: describeError(err) }
          });
        }
        await pruneLoginFails(env);
        await maybePruneAudit(env, log);
      })()
    );
  },

  /**
   * 所有请求的统一入口：注入 request id、捕获未处理异常、输出访问日志。
   * 业务逻辑在 handle() 里；除日志/响应头外不要往这里加东西。
   */
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url = new URL(request.url);
    // cf-ray 与 Cloudflare 平台日志天然对得上；本地调试没有就自己生成
    const rid = String(request.headers.get('cf-ray') || '').trim() || crypto.randomUUID();
    const log = createLogger(env, { rid });
    const meta = requestMeta(request);

    // 业务代码用 io.audit(...) 记账：自动补齐请求上下文与操作者，调用处只写业务字段
    const io = {
      rid,
      log,
      actor: null,
      audit(event, rec = {}) {
        const { actor, ...rest } = rec;
        const who = actor || io.actor;
        return audit(env, ctx, {
          event,
          rid,
          ...meta,
          actor_id: who ? who.id : null,
          actor_name: who ? (who.nickname || who.username || '') : '',
          ...rest
        });
      }
    };

    let res;
    try {
      res = await app.handle(request, env, ctx, io);
    } catch (err) {
      // 兜底：未捕获异常必须留痕，同时给用户一个体面的响应（不泄露堆栈）
      log.error('http.unhandled', { err: describeError(err), uid: io.actor ? io.actor.id : 0 });
      io.audit('request.error', { level: 'error', status: 500, meta: { err: describeError(err) } });
      res = json({ error: t('errors.serverError') }, 500);
    }

    const ms = Date.now() - started;
    const isApi = url.pathname.startsWith('/api/');
    const status = res.status;
    const line = { status, ms, uid: io.actor ? io.actor.id : 0, role: io.actor ? io.actor.role : '' };
    // 静态资源 2xx 不写访问日志（量大且无信息量）；慢请求与错误一律留痕
    if (isApi || status >= 400 || ms >= 800) log.info('http.request', line);
    else log.debug('http.request', line);

    // 只给 API 与 HTML 加 rid：/assets/* 是 immutable 缓存，把 rid 写进被缓存的响应会
    // 让同一个 id 反复出现在不同请求上，反而失去唯一的排障意义
    const wantsRid = isApi || String(res.headers.get('content-type') || '').includes('text/html');
    if (wantsRid) {
      try {
        res.headers.set('x-request-id', rid);
        const prev = res.headers.get('server-timing');
        res.headers.set('server-timing', (prev ? prev + ', ' : '') + 'app;dur=' + ms);
      } catch { /* 响应头不可写（极少见）时放弃，不影响正文 */ }
    }

    return res;
  },

  // 业务实现：入口（上面的 fetch）只负责 request id、异常兜底与访问日志，
  // 真正的路由逻辑都在这里。拆成两个方法是为了让入口保持"薄"，不掺业务。
  async handle(request, env, ctx, io) {
    const log = io.log;
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
    // 请求体上限：未认证即可触发的 CPU 放大（超长口令喂给 PBKDF2）
    if (method !== 'GET' && method !== 'HEAD') {
      const len = Number(request.headers.get('content-length') || 0);
      const bodyMax = url.pathname === '/api/news' || /\/api\/news\/\d+\/resubmit$/.test(url.pathname) ? NEWS_BODY_MAX_BYTES : MAX_BODY_BYTES;
      if (len > bodyMax) return json({ error: t('errors.bodyTooLarge') }, 413);
    }
    const user = await getSessionUser(env, getCookie(request));
    // 让访问日志与审计记录带上操作者（未登录则为 null）
    io.actor = user;

    // ---------- 公开 ----------
    // 前端异常上报：浏览器里的报错只有用户遇到，不收集就等于没有
    // 限流按 IP 计（同一出口 20 次后封 1 分钟起），并受审计写入预算保护
    if (path === 'log/client' && method === 'POST') {
      // 只接受同源页面自报：挡掉第三方页面/嵌入 iframe 的刷量。
      // 注意这只能提高门槛——非浏览器客户端可以伪造 Origin，真正的兜底是下面的
      // per-IP 限流与 log.js 里的每分钟预算。所以校验失败直接 403，但不作为唯一防线。
      const origin = request.headers.get('origin');
      if (origin) {
        let sameOrigin = false;
        try { sameOrigin = new URL(origin).host === new URL(request.url).host; } catch { sameOrigin = false; }
        if (!sameOrigin) return json({ ok: false }, 403);
      }
      const ipHead = clientIp(request);
      try {
        await ensureLoginSchema(env);
        // 阈值要和客户端节奏匹配：前端 8 条/10 分钟 ≈ 48 条/小时，这里给 120。
        // 用 20 的话，一个持续报错的页面 7 分钟就把自己封掉，反而挡掉真实错误。
        const hit = await hitLimit(env, 'cl:ip:' + ipHead, 120);
        if (hit.blocked) return json({ ok: false }, 429);
      } catch { /* 限流表不可用不拦上报 */ }

      const b = await readBody(request);
      const message = String(b.message || '').slice(0, 300);
      if (!message) return json({ ok: true });
      const level = b.level === 'warn' ? 'warn' : 'error';
      const payload = {
        // 来源标记：这张行是客户端自述，不是服务端观察到的事实，追责时不能同等看待
        source: 'client',
        message,
        stack: String(b.stack || '').slice(0, 1200),
        url: String(b.url || '').slice(0, 200)
      };
      log.warn('client.error', payload);
      io.audit('client.error', { level, status: 0, meta: payload });
      return json({ ok: true });
    }

    // ---------- PuzzleCat OAuth 登录（公开） ----------
    // 0) 前端据此决定要不要显示「用 PuzzleCat 登录」：未配置时直接不出现，
    //    而不是点了才报错。只回布尔值，不泄露任何凭据。
    if (path === 'oauth/config' && method === 'GET') {
      return json({ puzzlecat: oauthConfigured(env) });
    }

    // 1) 跳去 PuzzleCat 授权页。state 落 HttpOnly Cookie，回跳时逐字比对。
    if (path === 'oauth/' + OAUTH_PROVIDER + '/start' && method === 'GET') {
      if (!oauthConfigured(env)) return json({ error: t('errors.oauthNotConfigured') }, 503);
      const redirect = redirectUri(env, url.href);
      const next = safeNext(url.searchParams.get('next'), '/account');
      const state = randomState();
      const res = new Response(null, {
        status: 302,
        headers: { location: authorizeUrl(env, { redirect, state }), 'cache-control': 'no-store' }
      });
      res.headers.append('set-cookie', oauthStateCookie(state));
      res.headers.append('set-cookie', oauthNextCookie(next));
      return harden(res);
    }

    // 2) 回调：校验 state → 换令牌 → 取用户信息 → 建/找账号 → 建会话 → 撤销令牌
    if (path === 'oauth/' + OAUTH_PROVIDER + '/callback' && method === 'GET') {
      const next = safeNext(decodeCookieValue(readCookie(request, OAUTH_NEXT_COOKIE)), '/account');
      const expected = readCookie(request, OAUTH_STATE_COOKIE);
      const gotState = url.searchParams.get('state') || '';
      const denied = url.searchParams.get('error') || '';
      const code = url.searchParams.get('code') || '';

      // state 必须非空且逐字一致：挡 CSRF 与"把别人的授权码塞给我"的登录 CSRF
      if (!expected || !gotState || expected !== gotState) {
        io.audit('auth.oauth.fail', { level: 'warn', status: 400, meta: { reason: 'state_mismatch' } });
        return oauthLanding(next, 'state');
      }
      if (denied) {
        // 用户在授权页点了拒绝（或上游判定账号被禁用）
        io.audit('auth.oauth.fail', { level: 'warn', status: 403, meta: { reason: 'denied' } });
        return oauthLanding(next, 'denied');
      }
      if (!code) {
        io.audit('auth.oauth.fail', { level: 'warn', status: 400, meta: { reason: 'no_code' } });
        return oauthLanding(next, 'failed');
      }
      if (!oauthConfigured(env)) {
        log.error('auth.oauth.not_configured', {});
        return oauthLanding(next, 'unconfigured');
      }

      const redirect = redirectUri(env, url.href);
      let tokens = null;
      try {
        tokens = await exchangeCode(env, { code, redirect });
      } catch (err) {
        log.warn('auth.oauth.token_fail', { code: err && err.code, status: err && err.status });
        io.audit('auth.oauth.fail', {
          level: 'warn', status: 400, meta: { reason: 'token', code: err && err.code }
        });
        return oauthLanding(next, 'failed');
      }

      let profile = null;
      try {
        profile = await fetchUserinfo(env, tokens.access_token);
      } catch (err) {
        log.warn('auth.oauth.userinfo_fail', { code: err && err.code, status: err && err.status });
        io.audit('auth.oauth.fail', {
          level: 'warn', status: 400, meta: { reason: 'userinfo', code: err && err.code }
        });
        return oauthLanding(next, 'failed');
      } finally {
        // 本站只用它做一次登录：不保存 PuzzleCat 的令牌，用完即撤销
        if (tokens && tokens.access_token) revokeToken(env, tokens.access_token).catch(() => {});
      }

      const found = await findOrCreateOauthUser(env, profile);
      if (found.error) {
        io.audit('auth.oauth.fail', {
          level: 'warn', status: 400, meta: { reason: 'account', code: found.error }
        });
        return oauthLanding(next, found.error === 'errors.oauthNoEmail' ? 'noemail' : 'failed');
      }
      const row = found.user;
      if (!row) {
        io.audit('auth.oauth.fail', { level: 'warn', status: 500, meta: { reason: 'account_missing' } });
        return oauthLanding(next, 'failed');
      }
      if (row.banned) {
        // 被封禁的站内账号不能借 OAuth 绕过封禁
        io.audit('auth.oauth.fail', { level: 'warn', status: 403, meta: { reason: 'banned' }, target_type: 'user', target_id: row.id });
        return oauthLanding(next, 'banned');
      }

      const token = await createSession(env, row.id, row.session_version);
      io.audit(found.created ? 'auth.oauth.register' : 'auth.oauth.login', {
        actor: row,
        status: 200,
        target_type: 'user',
        target_id: row.id,
        meta: { provider: OAUTH_PROVIDER, created: found.created, email: maskEmail(profile.email) }
      });
      const res = new Response(null, {
        status: 302,
        headers: {
          location: '/' + '?oauth=ok#' + next,
          'cache-control': 'no-store',
          'set-cookie': sessionCookie(token)
        }
      });
      for (const c of oauthClearCookies()) res.headers.append('set-cookie', c);
      return harden(res);
    }

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
        // 邮件通道挂了是「用户注册不了」的常见原因，必须能在日志里一眼看到
        log.error('mail.send.fail', { purpose, reason });
        io.audit('mail.send.fail', {
          level: 'error', status: 502, target_type: 'email', target_id: maskEmail(email),
          meta: { purpose, reason }
        });
        return json({ error: reason === 'MAIL_NOT_CONFIGURED' ? t('errors.mailNotConfigured') : t('errors.mailFailed') }, 502);
      }
      return json({ ok: true, ttl: Math.round(CODE_TTL_MS / 1000) });
    }

    if (path === 'register' && method === 'POST') {
      const b = await readBody(request);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      let nickname = username; // 未填昵称时沿用用户名；填了则在下面统一校验
      const email = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').trim();
      if (username.length < 2 || username.length > 20) return json({ error: t('errors.usernameLength') }, 400);
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) return json({ error: t('errors.usernameCharset') }, 400);
      const pwErr = passwordProblem(password, username);
      if (pwErr) return json({ error: t(pwErr) }, 400);
      if (!EMAIL_RE.test(email) || email.length > 100) return json({ error: t('errors.emailInvalid') }, 400);
      if (!code) return json({ error: t('errors.codeRequired') }, 400);
      // 昵称可选；填了就必须合规（与 /api/profile、后台改名同一口径）
      if (String(b.nickname || '').trim()) {
        const nick = normalizeNickname(b.nickname);
        if (nick.error) return json({ error: t(nick.error) }, 400);
        nickname = nick.value;
      }
      const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) return json({ error: t('errors.usernameTaken') }, 409);
      try {
        await ensureEmailSchema(env);
      } catch {
        return json({ error: t('errors.serverError') }, 500);
      }
      const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (taken) return json({ error: t('errors.emailTaken') }, 409);
      const v = await verifyCode(env, email, 'register', code, log);
      if (!v.ok) return json({ error: t(v.error) }, 400);
      const { salt, hash } = await hashPassword(password);
      const ins = await env.DB.prepare('INSERT INTO users (username, password, nickname, role, email) VALUES (?, ?, ?, ?, ?)')
        .bind(username, salt + ':' + hash, nickname, 'user', email).run();
      const newId = ins.meta && ins.meta.last_row_id;
      io.audit('auth.register', {
        target_type: 'user',
        target_id: newId,
        status: 200,
        meta: { username, email: maskEmail(email) }
      });
      return json({ ok: true });
    }

    if (path === 'login' && method === 'POST') {
      const b = await readBody(request);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      // 超长输入直接拒绝：既防 DB 键异常，也防超长口令拖慢 PBKDF2
      if (username.length > 64 || password.length > PASSWORD_MAX) return json({ error: t('errors.badParams') }, 400);

      const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
      const lower = username.toLowerCase();
      const ip = clientIp(request);
      const comboKey = 'lf:ipu:' + ip + ':' + lower;
      const ipKey = 'lf:ip:' + ip;
      const userKey = 'lf:u:' + lower;

      // 限流不可用时降级放行：防御措施不该成为可用性单点（登录仍要靠口令校验兜底）
      try {
        await ensureLoginSchema(env);
        const combo = await hitLimit(env, comboKey, LOGIN_COMBO_MAX);
        if (combo.blocked) {
          log.warn('auth.login.blocked', { layer: 'combo', fresh: combo.fresh, retry: combo.retry });
          // 只在"这次请求真的触发了一次新封禁"时落库：封禁期内每次重试都写一行，
          // 等于把未认证端点变成 D1 写入放大器
          if (combo.fresh) {
            io.audit('auth.login.blocked', {
              level: 'warn', status: 429, target_type: 'user', target_id: lower,
              meta: { layer: 'combo', retry: combo.retry }
            });
          }
          return jsonRetry({ error: t('errors.tooManyAttempts', { n: combo.retry }) }, 429, combo.retry);
        }
        const userMax = row && isStaff(row) ? LOGIN_STAFF_MAX : LOGIN_USER_MAX;
        const [ipHit, uHit] = await Promise.all([
          hitLimit(env, ipKey, LOGIN_IP_MAX),
          hitLimit(env, userKey, userMax)
        ]);
        if (ipHit.blocked) {
          log.warn('auth.login.blocked', { layer: 'ip', fresh: ipHit.fresh, retry: ipHit.retry });
          if (ipHit.fresh) {
            io.audit('auth.login.blocked', { level: 'warn', status: 429, target_type: 'ip', meta: { layer: 'ip', retry: ipHit.retry } });
          }
          return jsonRetry({ error: t('errors.tooManyAttempts', { n: ipHit.retry }) }, 429, ipHit.retry);
        }
        if (uHit.blocked) {
          log.warn('auth.login.blocked', { layer: 'user', fresh: uHit.fresh, retry: uHit.retry });
          if (uHit.fresh) {
            io.audit('auth.login.blocked', {
              level: 'warn', status: 429, target_type: 'user', target_id: lower,
              meta: { layer: 'user', retry: uHit.retry }
            });
          }
          return jsonRetry({ error: t('errors.tooManyAttempts', { n: uHit.retry }) }, 429, uHit.retry);
        }
      } catch (err) {
        if (err && err.schemaMismatch) {
          // 结构没就位：宁可暂时不可用，也不在"限流失效"的状态下接收口令
          log.error('auth.login.schema_mismatch', { err: describeError(err) });
          io.audit('auth.login.schema_mismatch', { level: 'error', status: 503, meta: { err: describeError(err) } });
          return json({ error: t('errors.throttleUnavailable') }, 503);
        }
        // 其他失败（D1 抖动等）仍降级放行：限流不该成为可用性单点
        console.error('[login] throttle unavailable, fallback to password check:', err && err.message);
      }

      if (!row) {
        // 枚举防护：用户名不存在时也执行一次等价的 PBKDF2，使响应耗时与"存在但密码错"一致
        await hashPassword(password, DUMMY_SALT);
        // 失败只进控制台：这条路径可被随机用户名刷，写库会被放大成 D1 写压力
        log.warn('auth.login.fail', { user: lower, reason: 'no_user' });
        return json({ error: t('errors.badCredentials') }, 401);
      }
      const [salt, hash] = String(row.password).split(':');
      if (!(await verifyPassword(password, salt, hash))) {
        log.warn('auth.login.fail', { user: lower, uid: row.id, reason: 'bad_password' });
        return json({ error: t('errors.badCredentials') }, 401);
      }
      if (row.banned) {
        log.warn('auth.login.fail', { user: lower, uid: row.id, reason: 'banned' });
        return json({ error: t('errors.banned') }, 403);
      }
      // 只清本人的计数：IP 计数若被清掉，登录一次就成了攻击者的"重置开关"
      await clearLimit(env, [comboKey, userKey]);
      const token = await createSession(env, row.id, row.session_version);
      io.audit('auth.login.ok', { actor: row, status: 200, target_type: 'user', target_id: row.id });
      return okWithCookie({ ok: true, user: { id: row.id, username: row.username, nickname: row.nickname, role: row.role, created_at: row.created_at, email: row.email || null } }, token);
    }

    if (path === 'logout' && method === 'POST') {
      const m = (getCookie(request) || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
      if (m) { const t = m.slice(SESSION_COOKIE.length + 1); await env.SESSIONS.delete('s:' + t); }
      io.audit('auth.logout', { status: 200 });
      return okWithCookie({ ok: true }, null);
    }

    if (path === 'me' && method === 'GET') {
      // 顺带带回未读动态数，导航角标首屏就能显示，省一次请求
      let notifUnread = 0;
      let email = null;
      // 有没有本地口令：PuzzleCat 首登建出来的账号没有，前端据此显示「设置密码」而不是「修改密码」
      let hasPassword = true;
      if (user) {
        try {
          const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM hunt_notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id).first();
          notifUnread = row ? Number(row.n) || 0 : 0;
        } catch { notifUnread = 0; }
        // email 列由迁移补，未迁移时也不能让 /me 500
        try {
          const row = await env.DB.prepare('SELECT email, password FROM users WHERE id = ?').bind(user.id).first();
          email = row ? (row.email || null) : null;
          hasPassword = !(row && isOauthOnly(row.password));
        } catch { /* 列不存在 */ }
      }
      return json({ user: user ? { ...user, email, hasPassword } : null, notifUnread });
    }

    // 新闻公开接口放在鉴权闸门之前；只查询已发布文章，私有审核状态永不外泄。
    if (path === 'news' && method === 'GET') {
      const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page') || 1) || 1));
      const rows = await env.DB.prepare(
        "SELECT id, title, summary, excerpt, author_name, published_at FROM news_articles WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?"
      ).bind(NEWS_PAGE_SIZE, (page - 1) * NEWS_PAGE_SIZE).all();
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM news_articles WHERE status = 'published'").first();
      return json({ list: rows.results, page, pageSize: NEWS_PAGE_SIZE, total: Number(count && count.n) || 0 });
    }
    if (path.startsWith('news/') && path !== 'news/mine' && !path.startsWith('news/mine/') && method === 'GET') {
      const parts = path.split('/');
      const id = Number(parts[1]);
      if (parts.length !== 2 || !Number.isSafeInteger(id) || id < 1) return json({ error: t('errors.newsNotFound') }, 404);
      const row = await env.DB.prepare("SELECT * FROM news_articles WHERE id = ? AND status = 'published'").bind(id).first();
      if (!row) return json({ error: t('errors.newsNotFound') }, 404);
      return json({ article: {
        id: row.id, title: row.title, summary: row.summary, excerpt: row.excerpt,
        author_name: row.author_name, published_at: row.published_at,
        content: newsDocumentFromRow(row)
      } });
    }

    // ---------- 以下需要登录 ----------
    if (!user) return json({ error: t('errors.unauthorized') }, 401);

    // 给「只走过 PuzzleCat 登录」的账号补设口令。
    //
    // 这类账号的 password 是 oauth$ 前缀的随机占位值，没有旧口令可验，
    // 所以不能走 change-password。两道闸门：
    //   · 只允许占位值账号调用 —— 已有真口令的账号必须走 change-password 验旧口令，
    //     否则任何拿到会话的人都能静默改密、把真正的账号主人踢下线
    //   · 设完口令立刻递增 session_version，其他设备上的旧会话随之失效
    // 这里不节流：它不校验任何秘密（没有可比对的口令），节流只会让正常用户被挡。
    if (path === 'password/set' && method === 'POST') {
      const row = await env.DB.prepare('SELECT password FROM users WHERE id = ?').bind(user.id).first();
      if (!row) return json({ error: t('errors.unauthorized') }, 401);
      if (!isOauthOnly(row.password)) return json({ error: t('errors.passwordSetNotNeeded') }, 400);
      const b = await readBody(request);
      const np = String(b.new_password || '');
      const pwErr = passwordProblem(np, user.username);
      if (pwErr) return json({ error: t(pwErr === 'errors.passwordLength' ? 'errors.newPasswordLength' : pwErr) }, 400);
      const { salt: s2, hash: h2 } = await hashPassword(np);
      // 签发新会话：设完口令后当前设备不掉线，其他设备（若有）被踢
      const upd = await env.DB.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ? RETURNING session_version')
        .bind(s2 + ':' + h2, user.id).first();
      const token = await createSession(env, user.id, upd ? upd.session_version : Number(row.session_version) + 1);
      io.audit('auth.password.set', { status: 200, target_type: 'user', target_id: user.id });
      return okWithCookie({ ok: true }, token);
    }

    if (path === 'change-password' && method === 'POST') {
      const b = await readBody(request);
      try {
        await ensureLoginSchema(env);
      } catch (err) {
        // 与登录同一口径：缺列是可解释的部署问题，报 503 + 可读文案，
        // 不要混成 500「服务器异常」——那会让人去翻代码而不是去查迁移。
        if (err && err.schemaMismatch) return json({ error: t('errors.throttleUnavailable') }, 503);
        return json({ error: t('errors.serverError') }, 500);
      }
      // 改密也校验旧密码：不节流就是一条绕过登录限流的口令猜测通道
      const cpKey = 'cp:u:' + user.id;
      const cpHit = await hitLimit(env, cpKey, LOGIN_COMBO_MAX);
      if (cpHit.blocked) return jsonRetry({ error: t('errors.tooManyAttempts', { n: cpHit.retry }) }, 429, cpHit.retry);

      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      if (!row) return json({ error: t('errors.unauthorized') }, 401);
      const [salt, hash] = String(row.password).split(':');
      if (!(await verifyPassword(String(b.old_password || ''), salt, hash))) {
        // 旧密码错误不计审计（防刷）；控制台留痕便于判断是否有人在试口令
        log.warn('auth.password.change.fail', { uid: user.id, reason: 'wrong_old_password' });
        return json({ error: t('errors.wrongOldPassword') }, 400);
      }
      const np = String(b.new_password || '');
      const pwErr = passwordProblem(np, user.username);
      if (pwErr) return json({ error: t(pwErr === 'errors.passwordLength' ? 'errors.newPasswordLength' : pwErr) }, 400);
      const { salt: s2, hash: h2 } = await hashPassword(np);
      // 顺手签发新会话：其他设备被踢，当前设备不掉线（避免"界面显示已登录、点什么都 401"）
      const upd = await env.DB.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ? RETURNING session_version')
        .bind(s2 + ':' + h2, user.id).first();
      await clearLimit(env, [cpKey]);
      const token = await createSession(env, user.id, upd ? upd.session_version : Number(row.session_version) + 1);
      // 改密是账号接管的关键动作：记下来，事后能对上"谁在哪台机器上改了密码"
      io.audit('auth.password.change', { status: 200, target_type: 'user', target_id: user.id });
      return okWithCookie({ ok: true }, token);
    }

    // 修改自己的昵称（管理员改他人昵称走 admin/users/:id）
    if (path === 'profile' && method === 'PATCH') {
      const b = await readBody(request);
      const nick = normalizeNickname(b.nickname);
      if (nick.error) return json({ error: t(nick.error) }, 400);
      const nickname = nick.value;
      await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nickname, user.id).run();
      io.audit('auth.profile.update', { status: 200, meta: { nickname } });
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
      const v = await verifyCode(env, email, 'bind', code, log);
      if (!v.ok) return json({ error: t(v.error) }, 400);
      await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, user.id).run();
      // 邮箱是找回口令的唯一凭据，变更必须留档；只记脱敏地址
      io.audit('auth.email.bind', { status: 200, meta: { email: maskEmail(email) } });
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
      if (String(b.content).length > 5000) return json({ error: t('errors.announceTooLong') }, 400);
      // 标题会出现在成员端列表，不设上限同样能被拿来放大响应体（实测 30000 字可通过）
      if ([...String(b.title).trim()].length > ANNOUNCE_TITLE_MAX) return json({ error: t('errors.announceTitleTooLong') }, 400);
      // 返回完整行：前端可直接插入列表，不必依赖紧随其后的刷新
      const rows = (await env.DB.prepare(
        'INSERT INTO announcements (title, content, author, pinned) VALUES (?, ?, ?, ?) RETURNING *'
      ).bind(String(b.title).trim(), String(b.content).trim(), user.nickname || user.username, b.pinned ? 1 : 0).all()).results;
      const ann = rows && rows[0];
      io.audit('announcement.create', {
        status: 200, target_type: 'announcement', target_id: ann ? ann.id : null,
        meta: { title: String(b.title).trim(), pinned: !!b.pinned, len: String(b.content).length }
      });
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

    // 投稿管理需要登录；会员只能读取自己的稿件。拒绝稿件允许修改后重新提交。
    if (path === 'news/mine' && method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, title, summary, excerpt, content_format, status, review_note, reviewed_at, published_at, created_at, updated_at FROM news_articles WHERE author_id = ? ORDER BY id DESC LIMIT 100'
      ).bind(user.id).all();
      return json({ list: rows.results });
    }

    if (path.startsWith('news/mine/') && method === 'GET') {
      const parts = path.split('/');
      const id = Number(parts[2]);
      if (parts.length !== 3 || !Number.isSafeInteger(id) || id < 1) return json({ error: t('errors.newsNotFound') }, 404);
      const row = await env.DB.prepare('SELECT * FROM news_articles WHERE id = ? AND author_id = ?').bind(id, user.id).first();
      if (!row) return json({ error: t('errors.newsNotFound') }, 404);
      return json({ article: { ...row, content: newsDocumentFromRow(row) } });
    }

    if (path === 'news' && method === 'POST') {
      const b = await readBody(request, NEWS_BODY_MAX_BYTES);
      if (b.__tooLarge) return json({ error: t('errors.bodyTooLarge') }, 413);
      const parsed = parseNewsSubmission(b);
      if (parsed.error) return json({ error: t(parsed.error) }, 400);
      const authorName = String(user.nickname || user.username).trim().slice(0, NICKNAME_MAX);
      const ins = await env.DB.prepare(
        `INSERT INTO news_articles (title, summary, excerpt, content, content_format, author_id, author_name, status)
         SELECT ?, ?, ?, ?, 'rich-v1', ?, ?, 'pending'
         WHERE (SELECT COUNT(*) FROM news_articles WHERE author_id = ? AND status = 'pending') < 5
         RETURNING id, title, summary, excerpt, status, created_at`
      ).bind(parsed.title, parsed.summary, parsed.excerpt, parsed.content, user.id, authorName, user.id).all();
      const article = (ins.results || [])[0] || null;
      if (!article) return json({ error: t('errors.newsTooManyPending') }, 429);
      io.audit('news.submit', { status: 200, target_type: 'news', target_id: article.id, meta: { title: parsed.title, len: parsed.length } });
      return json({ ok: true, article });
    }

    if (path.startsWith('news/') && path.endsWith('/resubmit') && method === 'POST') {
      const parts = path.split('/');
      const id = Number(parts[1]);
      if (parts.length !== 3 || !Number.isSafeInteger(id) || id < 1) return json({ error: t('errors.newsNotFound') }, 404);
      const b = await readBody(request, NEWS_BODY_MAX_BYTES);
      if (b.__tooLarge) return json({ error: t('errors.bodyTooLarge') }, 413);
      const parsed = parseNewsSubmission(b);
      if (parsed.error) return json({ error: t(parsed.error) }, 400);
      const upd = await env.DB.prepare(
        `UPDATE news_articles SET title = ?, summary = ?, excerpt = ?, content = ?, content_format = 'rich-v1',
           status = 'pending', review_note = '', reviewed_by = NULL, reviewed_at = NULL, published_at = NULL,
           updated_at = datetime('now') WHERE id = ? AND author_id = ? AND status = 'rejected'
           AND (SELECT COUNT(*) FROM news_articles WHERE author_id = ? AND status = 'pending') < 5`
      ).bind(parsed.title, parsed.summary, parsed.excerpt, parsed.content, id, user.id, user.id).run();
      if (!upd.meta.changes) {
        const rejected = await env.DB.prepare("SELECT id FROM news_articles WHERE id = ? AND author_id = ? AND status = 'rejected'").bind(id, user.id).first();
        return json({ error: t(rejected ? 'errors.newsTooManyPending' : 'errors.newsResubmitUnavailable') }, rejected ? 429 : 409);
      }
      io.audit('news.resubmit', { status: 200, target_type: 'news', target_id: id, meta: { title: parsed.title, len: parsed.length } });
      return json({ ok: true });
    }

    // 管理端审核队列与发布状态变更；所有状态跃迁均在服务端按 id + 原状态约束。
    if (path === 'admin/news' && method === 'GET') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const status = ['pending', 'published', 'rejected'].includes(url.searchParams.get('status'))
        ? url.searchParams.get('status') : 'pending';
      const rows = await env.DB.prepare(
        `SELECT n.id, n.title, n.summary, n.excerpt, n.status, n.review_note, n.reviewed_at,
                n.published_at, n.created_at, n.author_name, u.username AS author_username
           FROM news_articles n LEFT JOIN users u ON u.id = n.author_id
          WHERE n.status = ? ORDER BY n.id DESC LIMIT 100`
      ).bind(status).all();
      return json({ list: rows.results, status });
    }

    if (path.startsWith('admin/news/') && method === 'GET') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const parts = path.split('/');
      const id = Number(parts[2]);
      if (parts.length !== 3 || !Number.isSafeInteger(id) || id < 1) return json({ error: t('errors.newsNotFound') }, 404);
      const row = await env.DB.prepare('SELECT n.*, u.username AS author_username FROM news_articles n LEFT JOIN users u ON u.id = n.author_id WHERE n.id = ?').bind(id).first();
      if (!row) return json({ error: t('errors.newsNotFound') }, 404);
      return json({ article: { ...row, content: newsDocumentFromRow(row) } });
    }

    if (path.startsWith('admin/news/') && method === 'PATCH') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const parts = path.split('/');
      const id = Number(parts[2]);
      if (parts.length !== 3 || !Number.isSafeInteger(id) || id < 1) return json({ error: t('errors.newsNotFound') }, 404);
      const b = await readBody(request);
      if (!['published', 'rejected'].includes(b.status)) return json({ error: t('errors.badParams') }, 400);
      const note = String(b.review_note || '').trim();
      if (b.status === 'rejected' && !note) return json({ error: t('errors.newsReviewNoteRequired') }, 400);
      if ([...note].length > 500) return json({ error: t('errors.newsReviewNoteTooLong') }, 400);
      const nowExpr = "datetime('now')";
      const upd = await env.DB.prepare(
        `UPDATE news_articles SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ${nowExpr},
           published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ${nowExpr}) ELSE NULL END,
           updated_at = ${nowExpr} WHERE id = ? AND status = 'pending'`
      ).bind(b.status, note, user.id, b.status, id).run();
      if (!upd.meta.changes) return json({ error: t('errors.newsReviewUnavailable') }, 409);
      io.audit(b.status === 'published' ? 'news.publish' : 'news.reject', {
        level: b.status === 'published' ? 'info' : 'warn', status: 200,
        target_type: 'news', target_id: id, meta: { review_note: note.slice(0, 200) }
      });
      return json({ ok: true, status: b.status });
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
        mineCount: list.filter((h) => h.mine).length,
        // 前端据此提示「刷新没生效」：stale-timeout 表示上游慢、已转后台更新
        source: feed.source || 'unknown'
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
      // 客服回复是"以官方身份对外发声"，留档但不存正文（内容已在 messages 表）
      io.audit('support.reply', { status: 200, target_type: 'conversation', target_id: convId, meta: { len: content.length } });
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

    // ---------- 审计日志（管理员可读） ----------
    if (path === 'admin/logs' && method === 'GET') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);

      const levelParam = url.searchParams.get('level');
      const level = ['info', 'warn', 'error'].includes(levelParam) ? levelParam : '';
      const event = String(url.searchParams.get('event') || '').trim().slice(0, 64);
      const ip = String(url.searchParams.get('ip') || '').trim().slice(0, 64);
      // 前导通配的全文检索是全表扫：短于 3 个字等于没有选择性，直接忽略
      const qRaw = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      const q = qRaw.length >= 3 ? qRaw : '';
      const before = Number(url.searchParams.get('before') || 0);
      const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit') || 50) || 50));

      const where = [];
      const args = [];
      if (level) { where.push('level = ?'); args.push(level); }
      if (event) { where.push("event LIKE ? ESCAPE '\\'"); args.push(escapeLike(event) + '%'); }
      if (ip) { where.push('ip = ?'); args.push(ip); }
      if (q) {
        const like = '%' + escapeLike(q) + '%';
        // 覆盖「按 IP 查这个人都干了什么」「拿 rid 去对 wrangler tail」两个最常用的取数场景
        where.push("(event LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'" +
          " OR ip LIKE ? ESCAPE '\\' OR rid LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\'" +
          " OR ua LIKE ? ESCAPE '\\' OR meta LIKE ? ESCAPE '\\')");
        for (let i = 0; i < 8; i++) args.push(like);
      }
      if (before > 0) { where.push('id < ?'); args.push(before); }
      // 客户端自述上报默认不进主列表：它不是服务端观察到的事实，混在一起会稀释证据链。
      // 需要时用 client=all（连主列表一起看）或 client=only（只看这些）显式打开。
      const clientParam = String(url.searchParams.get('client') || '');
      if (clientParam === 'only') where.push("event = 'client.error'");
      else if (clientParam !== 'all') where.push("event <> 'client.error'");
      const sql = 'SELECT * FROM audit_logs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?';

      let rows;
      try {
        // 多取一条用来判断"还有没有下一页"，省掉一次 COUNT
        rows = (await env.DB.prepare(sql).bind(...args, limit + 1).all()).results;
      } catch (err) {
        // 表不存在（迁移没跑）要说清楚；其他错误不把 SQL 细节暴露给前端
        if (/no such table/i.test(String((err && err.message) || ''))) {
          return json({ error: t('errors.logsTableMissing') }, 500);
        }
        log.error('admin.logs.fail', { err: describeError(err) });
        return json({ error: t('errors.serverError') }, 500);
      }
      const list = rows.slice(0, limit);

      // 统计与事件下拉是全局口径，不随筛选变化：60 秒内复用，避免每次切页都跑 7 天 GROUP BY
      const now = Date.now();
      if (!logsSummaryCache.data || now - logsSummaryCache.at > 60 * 1000) {
        const dayAgo = now - 24 * 60 * 60 * 1000;
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const [statRow, eventRows] = await Promise.all([
          env.DB.prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(level = 'error'), 0) AS err,
                    COALESCE(SUM(level = 'warn'), 0) AS warn,
                    COALESCE(SUM(level = 'info'), 0) AS info
               FROM audit_logs WHERE ts >= ?`
          ).bind(dayAgo).first(),
          env.DB.prepare('SELECT event, COUNT(*) AS n FROM audit_logs WHERE ts >= ? GROUP BY event ORDER BY n DESC LIMIT 40').bind(weekAgo).all()
        ]);
        logsSummaryCache = {
          at: now,
          data: {
            stats: {
              total: Number(statRow && statRow.total) || 0,
              error: Number(statRow && statRow.err) || 0,
              warn: Number(statRow && statRow.warn) || 0,
              info: Number(statRow && statRow.info) || 0
            },
            events: eventRows.results || []
          }
        };
      }

      // 谁翻过日志本身也要留痕；按人每分钟最多 1 条，避免翻页把自己写成洪水
      const uid = user.id;
      if (now - (logsReadSeen.get(uid) || 0) > 60 * 1000) {
        logsReadSeen.set(uid, now);
        if (logsReadSeen.size > 500) {
          for (const [k, v] of logsReadSeen) if (now - v > 10 * 60 * 1000) logsReadSeen.delete(k);
        }
        io.audit('admin.logs.read', {
          status: 200,
          meta: { level, event, ip, q: q ? q.slice(0, 40) : '', before, n: list.length }
        });
      }

      return json({
        list,
        nextBefore: rows.length > limit && list.length ? list[list.length - 1].id : 0,
        stats: logsSummaryCache.data.stats,
        events: logsSummaryCache.data.events,
        keepDays: auditKeepDays(env),
        // 本实例本分钟丢弃了多少条（多 isolate 下每个实例各自计数，用来判断"少的那行"是丢了还是没发生）
        budget: auditBudgetSnapshot()
      });
    }

    // 手动清理：删保留期之外的记录。仅超管，且清理动作本身也要留痕
    if (path === 'admin/logs/purge' && method === 'POST') {
      if (!isSuper(user)) return json({ error: t('errors.superOnly') }, 403);
      const b = await readBody(request);
      const days = Math.max(7, Math.min(3650, Number(b.days) || auditKeepDays(env)));
      let removed = 0;
      try {
        removed = await pruneAuditLogs(env, days);
      } catch (err) {
        // 与 admin/logs 保持一致：同一个根因给同一句可操作的提示
        if (/no such table/i.test(String((err && err.message) || ''))) {
          return json({ error: t('errors.logsTableMissing') }, 500);
        }
        log.error('admin.logs.purge.fail', { err: describeError(err) });
        return json({ error: t('errors.serverError') }, 500);
      }
      io.audit('admin.logs.purge', { level: 'warn', status: 200, meta: { days, removed } });
      return json({ ok: true, removed, keepDays: days });
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
      // 同族收口：对"另一个管理员"的任何改动都要求超管。
      // 否则平权的 admin 之间可以互相压制——改密（接管）、封禁（拒服）、改昵称（篡改他人展示）。
      // 三处分支共用这一个判定，避免只堵了一条路径又从前门进来。
      const peerAdmin = target.role === 'admin' && !isSuper(user) && id !== user.id;
      const b = await readBody(request);

      // 授权（设为/撤销管理员）只给超管
      if (b.role !== undefined) {
        if (!isSuper(user)) return json({ error: t('errors.superOnly') }, 403);
        if (!['user', 'admin'].includes(b.role)) return json({ error: t('errors.invalidRole') }, 400);
        if (targetIsSuper || id === user.id) return json({ error: t('errors.cannotEditSuper') }, 400);
        await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run();
        io.audit('admin.user.role', {
          level: 'warn', status: 200, target_type: 'user', target_id: id,
          meta: { username: target.username, from: target.role, to: b.role }
        });
      }
      // 其余改动不允许落到超管账号上（自己改自己除外）
      const guarded = targetIsSuper && id !== user.id;
      if (b.nickname !== undefined) {
        if (guarded) return json({ error: t('errors.cannotEditSuper') }, 400);
        if (peerAdmin) return json({ error: t('errors.superOnly') }, 403);
        // 与 /api/profile 同一口径：非空、≤20 码点、无控制字符。
        // 昵称会进入所有人的赛事列表与工单，这里漏了上限就能被拿来放大响应体。
        const nick = normalizeNickname(b.nickname);
        if (nick.error) return json({ error: t(nick.error) }, 400);
        await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nick.value, id).run();
        io.audit('admin.user.nickname', {
          status: 200, target_type: 'user', target_id: id,
          meta: { username: target.username, nickname: nick.value }
        });
      }
      if (b.banned !== undefined) {
        if (id === user.id) return json({ error: t('errors.cannotBanSelf') }, 400);
        if (targetIsSuper) return json({ error: t('errors.cannotEditSuper') }, 400);
        // 封禁同级 admin = 拒绝服务攻击（对方被踢下线、需他人解封），只能由超管做
        if (peerAdmin) return json({ error: t('errors.superOnly') }, 403);
        await env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(b.banned ? 1 : 0, id).run();
        io.audit(b.banned ? 'admin.user.ban' : 'admin.user.unban', {
          level: 'warn', status: 200, target_type: 'user', target_id: id,
          meta: { username: target.username }
        });
      }
      if (b.new_password !== undefined) {
        if (guarded) return json({ error: t('errors.cannotEditSuper') }, 400);
        // 管理员之间平权：admin 不得重置同级的口令，否则可横向接管对方账号
        if (peerAdmin) return json({ error: t('errors.superOnly') }, 403);
        const np = String(b.new_password);
        const pwErr = passwordProblem(np, target.username);
        if (pwErr) return json({ error: t(pwErr === 'errors.passwordLength' ? 'errors.newPasswordLength' : pwErr) }, 400);
        const { salt: s2, hash: h2 } = await hashPassword(np);
        await env.DB.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?').bind(s2 + ':' + h2, id).run();
        // 代改他人口令等于临时接管账号：必须留档
        io.audit('admin.user.password_reset', {
          level: 'warn', status: 200, target_type: 'user', target_id: id,
          meta: { username: target.username }
        });
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
        env.DB.prepare('DELETE FROM news_articles WHERE author_id = ?').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
      ]);
      if (target.email) {
        try { await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(target.email).run(); } catch { /* 表未建 */ }
      }
      // 删号不可恢复：审计里保留被删账号的标识，便于日后追查
      io.audit('admin.user.delete', {
        level: 'warn', status: 200, target_type: 'user', target_id: id,
        meta: { username: target.username, email: maskEmail(target.email) }
      });
      return json({ ok: true, id });
    }

    if (path.startsWith('admin/announcements/') && method === 'PATCH') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const id = Number(path.split('/')[2]);
      const b = await readBody(request);
      if (b.title !== undefined) {
        const title = String(b.title).trim();
        if (!title) return json({ error: t('errors.titleEmpty') }, 400);
        if ([...title].length > ANNOUNCE_TITLE_MAX) return json({ error: t('errors.announceTitleTooLong') }, 400);
      }
      // 编辑路径此前没有 content 上限：创建时限 5000，改一次就能绕过
      if (b.content !== undefined && String(b.content).length > 5000) return json({ error: t('errors.announceTooLong') }, 400);
      const r = await env.DB.prepare('UPDATE announcements SET title = COALESCE(?, title), content = COALESCE(?, content), pinned = COALESCE(?, pinned) WHERE id = ?')
        .bind(b.title !== undefined ? String(b.title).trim() : null, b.content !== undefined ? String(b.content) : null, b.pinned !== undefined ? (b.pinned ? 1 : 0) : null, id).run();
      // 影响 0 行 = 这条公告已不存在（可能被别的管理员删了）：必须报错，不能静默返回 ok
      if (!r.meta.changes) return json({ error: t('errors.announceGone') }, 404);
      io.audit('announcement.update', {
        status: 200, target_type: 'announcement', target_id: id,
        meta: { fields: Object.keys(b).sort(), title: b.title !== undefined ? String(b.title).trim() : undefined }
      });
      return json({ ok: true, id });
    }

    if (path.startsWith('admin/announcements/') && method === 'DELETE') {
      if (!isStaff(user)) return json({ error: t('errors.adminOnly') }, 403);
      const id = Number(path.split('/')[2]);
      const r = await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();
      if (!r.meta.changes) return json({ error: t('errors.announceGone') }, 404);
      io.audit('announcement.delete', { level: 'warn', status: 200, target_type: 'announcement', target_id: id });
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  }
};

export default app;

function okWithCookie(data, token) {
  const res = json(data);
  if (token) res.headers.set('set-cookie', sessionCookie(token));
  else if (token === null) res.headers.set('set-cookie', clearCookie());
  return res;
}