// PuzzleCat OAuth2.0（授权码模式）客户端
//
// 协议见 https://puzzle.cat/platform/oauth —— 这里只实现 CAAR 用得到的部分：
//   · 拼授权地址（state 由调用方生成并自行保管）
//   · 用授权码换 access_token（机密客户端，带 client_secret；上游未定义 PKCE，
//     不要额外送 code_challenge，避免严格校验时报 invalid_request）
//   · 用 access_token 取用户信息（上游统一包装：{ code, message, data, timestamp }）
//   · 用完即撤销（本站只用它做一次登录，不长期持有 PuzzleCat 的凭据）
//
// 本文件不碰 D1/KV，也不依赖 Workers 运行时（只用 fetch + Web Crypto），
// 因此 tests/ 可以直接 stub 全局 fetch 来驱动整条流程。
export const PROVIDER = 'puzzlecat';

const DEFAULT_BASE = 'https://puzzle.cat';
const TIMEOUT_MS = 8000;

// 只覆盖域名，便于本地/测试指向假服务；路径按上游文档固定
export function apiBase(env) {
  const raw = String((env && env.PUZZLECAT_BASE) || DEFAULT_BASE).trim();
  return (raw || DEFAULT_BASE).replace(/\/+$/, '');
}

export function clientId(env) {
  return String((env && env.PUZZLECAT_CLIENT_ID) || '').trim();
}

export function clientSecret(env) {
  return String((env && env.PUZZLECAT_CLIENT_SECRET) || '').trim();
}

// 两个变量都到位才算配置好：只配一半时登录按钮应当直接给出可读的提示，
// 而不是把用户送到上游再拿一个 invalid_client。
export function oauthConfigured(env) {
  return !!(clientId(env) && clientSecret(env));
}

// 回调地址必须与申请时登记的完全一致（上游会逐字比对）。
// 默认按当前站点推导，部署到别的域名或走 workers.dev 时用 PUZZLECAT_REDIRECT_URI 覆盖。
export function redirectUri(env, requestUrl) {
  const fixed = String((env && env.PUZZLECAT_REDIRECT_URI) || '').trim();
  if (fixed) return fixed;
  const origin = new URL(requestUrl).origin;
  return origin + '/api/oauth/' + PROVIDER + '/callback';
}

export function authorizeUrl(env, { redirect, state }) {
  const q = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'profile',
    state
  });
  return apiBase(env) + '/oauth/authorize?' + q.toString();
}

// 24 字节随机 → 32 字符 base64url，用作 state
export function randomState() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

/**
 * 授权码 → 令牌。失败抛 Error，err.code 取上游 error 字段（invalid_grant / access_denied …）。
 * 注意：上游每次成功都会轮换 refresh_token；本站只做登录，不保存 refresh_token。
 */
export async function exchangeCode(env, { code, redirect }) {
  const res = await fetch(apiBase(env) + '/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: clientId(env),
      client_secret: clientSecret(env),
      redirect_uri: redirect
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const data = await readJson(res);
  if (!res.ok || !data || !data.access_token) {
    const err = new Error('oauth_token_failed');
    err.code = (data && data.error) || 'http_' + res.status;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 取用户信息：成功返回 { id, email, nickname, avatar, bio }（上游 data 字段） */
export async function fetchUserinfo(env, accessToken) {
  const res = await fetch(apiBase(env) + '/api/oauth/userinfo', {
    headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const data = await readJson(res);
  // 统一包装：{ code, message, data, timestamp }，用户字段在 data 里
  const profile = data && data.data;
  if (!res.ok || Number(data && data.code) !== 200 || !profile) {
    const err = new Error('oauth_userinfo_failed');
    err.code = res.status === 403 ? 'access_denied' : 'userinfo_' + res.status;
    err.status = res.status;
    throw err;
  }
  const profileId = String(profile.id == null ? '' : profile.id).trim();
  if (!profileId || profileId.length > 128 || /[\u0000-\u001f\u007f]/.test(profileId)) {
    const err = new Error('oauth_userinfo_invalid_id');
    err.code = 'invalid_user_id';
    err.status = 502;
    throw err;
  }
  return {
    id: profileId,
    email: String(profile.email || '').trim().toLowerCase(),
    nickname: String(profile.nickname || '').trim(),
    avatar: String(profile.avatar || '').trim(),
    bio: String(profile.bio || '').trim()
  };
}

/** 撤销令牌：本站登录完成后即撤销，尽力而为，失败不影响登录结果 */
export async function revokeToken(env, token) {
  if (!token) return false;
  try {
    const res = await fetch(apiBase(env) + '/api/oauth/token/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        token_type_hint: 'access_token',
        client_id: clientId(env),
        client_secret: clientSecret(env)
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------- 只走 OAuth 的账号 ---------- */

// users.password 是 NOT NULL，且登录按 "<saltHex>:<hashHex>" 拆分后做 PBKDF2 比对。
// 用 OAuth 首次登录建出来的账号没有口令，这里写一个**格式合法但不可推导**的占位值：
//   · 前缀 oauth$ 是唯一标记，isOauthOnly() 据此判断"还没设过密码"
//   · 随机 32 字节哈希，任何口令都不可能匹配（概率 2^-256）
//   · 前缀里**不能有冒号**：登录按冒号拆 salt/hash，多一个冒号会让 hash 变 undefined，
//     虽然仍不会放行，但 hexToBytes 会拿到奇数长度串，属于自找的边界情况
// 好处是零 schema 变更：既有库不需要 ALTER，登录/改密路径的既有逻辑原样成立。
const OAUTH_PREFIX = 'oauth$';

export function makeOauthOnlyPassword() {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((x) => x.toString(16).padStart(2, '0')).join('');
  return OAUTH_PREFIX + hex;
}

export function isOauthOnly(password) {
  return String(password == null ? '' : password).indexOf(OAUTH_PREFIX) === 0;
}

/* ---------- 用户名 ---------- */

const USERNAME_RE = /[^a-zA-Z0-9_\u4e00-\u9fa5]/g;
const USERNAME_MAX = 20;

// 从 PuzzleCat 资料推导一个站内用户名：昵称 → 邮箱前缀 → pc<id>。
// 结果必须满足注册时的字符集与长度规则，否则新账号无法用 /api/profile 之外的方式维护。
export function usernameSeed(profile) {
  const nick = String(profile.nickname || '').replace(USERNAME_RE, '').slice(0, USERNAME_MAX);
  if ([...nick].length >= 2) return nick;
  const mail = String(profile.email || '').split('@')[0].replace(USERNAME_RE, '').slice(0, USERNAME_MAX);
  if ([...mail].length >= 2) return mail;
  const digits = String(profile.id || '').replace(/[^0-9]/g, '').slice(0, 10);
  return digits ? 'pc' + digits : 'pcmember';
}

/** 在 base 上追加 _2/_3… 直到不超长；调用方负责查重 */
export function usernameCandidate(base, n) {
  const suffix = n > 1 ? '_' + n : '';
  const room = USERNAME_MAX - suffix.length;
  const chars = [...base].slice(0, room).join('');
  return chars + suffix;
}

/* ---------- 回跳路径 ---------- */

// 只接受站内相对路径：挡掉 //evil.com、https://…、/\evil.com 这类跳转外站的写法
export function safeNext(next, fallback = '/account') {
  const s = String(next == null ? '' : next).trim();
  if (!s || s.length > 200) return fallback;
  if (s[0] !== '/') return fallback;
  if (s[1] === '/' || s[1] === '\\') return fallback;
  if (/[\s\\]/.test(s)) return fallback;
  return s;
}
