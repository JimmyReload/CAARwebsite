// CAAR 用户系统 API —— Cloudflare Worker（D1 + KV）
// 密码哈希：PBKDF2-SHA256（Web Crypto）
// 会话：随机令牌存 KV，HttpOnly Cookie

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
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
async function verifyPassword(pw, saltHex, hashHex) {
  const { hash } = await hashPassword(pw, saltHex);
  return hash === hashHex;
}

// ---------- 会话 ----------
const SESSION_COOKIE = 'caar_session';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 天

async function createSession(env, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.SESSIONS.put('s:' + token, String(userId), { expirationTtl: SESSION_TTL });
  return token;
}
async function getSessionUser(env, cookie) {
  if (!cookie) return null;
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
  if (!m) return null;
  const token = m.slice(SESSION_COOKIE.length + 1);
  const uid = await env.SESSIONS.get('s:' + token);
  if (!uid) return null;
  const user = await env.DB.prepare('SELECT id, username, nickname, role, created_at FROM users WHERE id = ?').bind(Number(uid)).first();
  return user || null;
}
function sessionCookie(token) {
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_TTL;
}
function clearCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function getCookie(req) { return req.headers.get('cookie') || ''; }

// ---------- 管理员工具 ----------
async function allAdmins(env) {
  return (await env.DB.prepare("SELECT id, username, nickname FROM users WHERE role = 'admin' ORDER BY id").all()).results;
}

// ---------- 主路由 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // SPA 兜底：先试静态资源，未命中返回 index.html
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) {
        const idx = await env.ASSETS.fetch(new Request('https://placeholder/index.html'));
        return new Response(idx.body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return res;
    }

    const path = url.pathname.slice(5); // 去掉 /api/
    const method = request.method;
    const user = await getSessionUser(env, getCookie(request));

    // ---------- 公开 ----------
    if (path === 'register' && method === 'POST') {
      const b = await readBody(request);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      const nickname = String(b.nickname || '').trim() || username;
      if (username.length < 2 || username.length > 20) return json({ error: '用户名需 2-20 个字符' }, 400);
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) return json({ error: '用户名只能含中文/字母/数字/下划线' }, 400);
      if (password.length < 6) return json({ error: '密码至少 6 位' }, 400);
      const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) return json({ error: '该用户名已被注册' }, 409);
      const { salt, hash } = await hashPassword(password);
      await env.DB.prepare('INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)')
        .bind(username, salt + ':' + hash, nickname, 'user').run();
      return json({ ok: true });
    }

    if (path === 'login' && method === 'POST') {
      const b = await readBody(request);
      const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(b.username || '')).first();
      if (!row) return json({ error: '用户名或密码错误' }, 401);
      const [salt, hash] = String(row.password).split(':');
      if (!(await verifyPassword(String(b.password || ''), salt, hash))) return json({ error: '用户名或密码错误' }, 401);
      const token = await createSession(env, row.id);
      return okWithCookie({ ok: true, user: { id: row.id, username: row.username, nickname: row.nickname, role: row.role } }, token);
    }

    if (path === 'logout' && method === 'POST') {
      const m = (getCookie(request) || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
      if (m) { const t = m.slice(SESSION_COOKIE.length + 1); await env.SESSIONS.delete('s:' + t); }
      return okWithCookie({ ok: true }, null);
    }

    if (path === 'change-password' && method === 'POST') {
      const b = await readBody(request);
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      const [salt, hash] = String(row.password).split(':');
      if (!(await verifyPassword(String(b.old_password || ''), salt, hash))) return json({ error: '原密码错误' }, 400);
      const np = String(b.new_password || '');
      if (np.length < 6) return json({ error: '新密码至少 6 位' }, 400);
      const { salt: s2, hash: h2 } = await hashPassword(np);
      await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(s2 + ':' + h2, user.id).run();
      return json({ ok: true });
    }

    if (path === 'me' && method === 'GET') {
      return json({ user });
    }

    // ---------- 以下需要登录 ----------
    if (!user) return json({ error: '未登录' }, 401);

    // 公告
    if (path === 'announcements' && method === 'GET') {
      const list = (await env.DB.prepare('SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 50').all()).results;
      return json({ list });
    }

    if (path === 'announcements' && method === 'POST') {
      if (user.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
      const b = await readBody(request);
      if (!String(b.title || '').trim() || !String(b.content || '').trim()) return json({ error: '标题和内容不能为空' }, 400);
      const r = await env.DB.prepare('INSERT INTO announcements (title, content, author, pinned) VALUES (?, ?, ?, ?)')
        .bind(String(b.title).trim(), String(b.content).trim(), user.nickname || user.username, b.pinned ? 1 : 0).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }

    // 私信
    if (path === 'staff' && method === 'GET') {
      return json({ list: await allAdmins(env) });
    }

    if (path === 'messages' && method === 'GET') {
      // 用户视角：自己发出的信（可看 staff 是否已读/回复）
      const sent = (await env.DB.prepare(
        'SELECT m.*, u.username AS to_name FROM messages m JOIN users u ON u.id = m.to_user WHERE m.from_user = ? ORDER BY m.id DESC LIMIT 50'
      ).bind(user.id).all()).results;
      // admin 视角：收件箱
      let inbox = [];
      if (user.role === 'admin') {
        inbox = (await env.DB.prepare(
          'SELECT m.*, u.username AS from_name FROM messages m JOIN users u ON u.id = m.from_user WHERE m.to_user = ? ORDER BY m.id DESC LIMIT 50'
        ).bind(user.id).all()).results;
      }
      return json({ sent, inbox });
    }

    if (path === 'messages' && method === 'POST') {
      const b = await readBody(request);
      const toId = Number(b.to_user);
      const content = String(b.content || '').trim();
      if (!toId || !content) return json({ error: '收件人和内容不能为空' }, 400);
      if (content.length > 2000) return json({ error: '内容过长（≤2000 字）' }, 400);
      const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(toId).first();
      if (!target) return json({ error: '收件人不存在' }, 404);
      await env.DB.prepare('INSERT INTO messages (from_user, to_user, content) VALUES (?, ?, ?)')
        .bind(user.id, toId, content).run();
      return json({ ok: true });
    }

    if (path === 'messages/read' && method === 'POST') {
      const b = await readBody(request);
      if (user.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
      await env.DB.prepare('UPDATE messages SET read = 1 WHERE id = ? AND to_user = ?').bind(Number(b.id), user.id).run();
      return json({ ok: true });
    }

    // 管理员：用户管理
    if (path === 'admin/users' && method === 'GET') {
      if (user.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
      const list = (await env.DB.prepare('SELECT id, username, nickname, role, created_at FROM users ORDER BY id').all()).results;
      return json({ list });
    }

    if (path.startsWith('admin/users/') && method === 'PATCH') {
      if (user.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
      const id = Number(path.split('/')[2]);
      const b = await readBody(request);
      if (b.role && !['user', 'admin'].includes(b.role)) return json({ error: '非法角色' }, 400);
      if (id === user.id && b.role && b.role !== 'admin') return json({ error: '不能撤销自己的管理员' }, 400);
      if (b.role) {
        await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run();
      }
      if (b.nickname !== undefined) {
        await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(String(b.nickname).trim(), id).run();
      }
      return json({ ok: true });
    }

    if (path.startsWith('admin/announcements/') && method === 'DELETE') {
      if (user.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
      await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(Number(path.split('/')[2])).run();
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