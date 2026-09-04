var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var enc = new TextEncoder();
var dec = new TextDecoder();
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
__name(json, "json");
async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
__name(readBody, "readBody");
async function hashPassword(pw, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 1e5 },
    key,
    256
  );
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
}
__name(hashPassword, "hashPassword");
function hexToBytes(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}
__name(hexToBytes, "hexToBytes");
function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex, "bytesToHex");
async function verifyPassword(pw, saltHex, hashHex) {
  const { hash } = await hashPassword(pw, saltHex);
  return hash === hashHex;
}
__name(verifyPassword, "verifyPassword");
var SESSION_COOKIE = "caar_session";
var SESSION_TTL = 60 * 60 * 24 * 7;
async function createSession(env, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await env.SESSIONS.put("s:" + token, String(userId), { expirationTtl: SESSION_TTL });
  return token;
}
__name(createSession, "createSession");
async function getSessionUser(env, cookie) {
  if (!cookie) return null;
  const m = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + "="));
  if (!m) return null;
  const token = m.slice(SESSION_COOKIE.length + 1);
  const uid = await env.SESSIONS.get("s:" + token);
  if (!uid) return null;
  const user = await env.DB.prepare("SELECT id, username, nickname, role, created_at FROM users WHERE id = ?").bind(Number(uid)).first();
  return user || null;
}
__name(getSessionUser, "getSessionUser");
function sessionCookie(token) {
  return SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_TTL;
}
__name(sessionCookie, "sessionCookie");
function clearCookie() {
  return SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}
__name(clearCookie, "clearCookie");
function getCookie(req) {
  return req.headers.get("cookie") || "";
}
__name(getCookie, "getCookie");
async function allAdmins(env) {
  return (await env.DB.prepare("SELECT id, username, nickname FROM users WHERE role = 'admin' ORDER BY id").all()).results;
}
__name(allAdmins, "allAdmins");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) {
        const idx = await env.ASSETS.fetch(new Request("https://placeholder/index.html"));
        return new Response(idx.body, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return res;
    }
    const path = url.pathname.slice(5);
    const method = request.method;
    const user = await getSessionUser(env, getCookie(request));
    if (path === "register" && method === "POST") {
      const b = await readBody(request);
      const username = String(b.username || "").trim();
      const password = String(b.password || "");
      const nickname = String(b.nickname || "").trim() || username;
      if (username.length < 2 || username.length > 20) return json({ error: "\u7528\u6237\u540D\u9700 2-20 \u4E2A\u5B57\u7B26" }, 400);
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) return json({ error: "\u7528\u6237\u540D\u53EA\u80FD\u542B\u4E2D\u6587/\u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF" }, 400);
      if (password.length < 6) return json({ error: "\u5BC6\u7801\u81F3\u5C11 6 \u4F4D" }, 400);
      const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
      if (exists) return json({ error: "\u8BE5\u7528\u6237\u540D\u5DF2\u88AB\u6CE8\u518C" }, 409);
      const { salt, hash } = await hashPassword(password);
      await env.DB.prepare("INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)").bind(username, salt + ":" + hash, nickname, "user").run();
      return json({ ok: true });
    }
    if (path === "login" && method === "POST") {
      const b = await readBody(request);
      const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(String(b.username || "")).first();
      if (!row) return json({ error: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" }, 401);
      const [salt, hash] = String(row.password).split(":");
      if (!await verifyPassword(String(b.password || ""), salt, hash)) return json({ error: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" }, 401);
      const token = await createSession(env, row.id);
      return okWithCookie({ ok: true, user: { id: row.id, username: row.username, nickname: row.nickname, role: row.role } }, token);
    }
    if (path === "logout" && method === "POST") {
      const m = (getCookie(request) || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + "="));
      if (m) {
        const t = m.slice(SESSION_COOKIE.length + 1);
        await env.SESSIONS.delete("s:" + t);
      }
      return okWithCookie({ ok: true }, null);
    }
    if (path === "change-password" && method === "POST") {
      const b = await readBody(request);
      const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
      const [salt, hash] = String(row.password).split(":");
      if (!await verifyPassword(String(b.old_password || ""), salt, hash)) return json({ error: "\u539F\u5BC6\u7801\u9519\u8BEF" }, 400);
      const np = String(b.new_password || "");
      if (np.length < 6) return json({ error: "\u65B0\u5BC6\u7801\u81F3\u5C11 6 \u4F4D" }, 400);
      const { salt: s2, hash: h2 } = await hashPassword(np);
      await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(s2 + ":" + h2, user.id).run();
      return json({ ok: true });
    }
    if (path === "me" && method === "GET") {
      return json({ user });
    }
    if (!user) return json({ error: "\u672A\u767B\u5F55" }, 401);
    if (path === "announcements" && method === "GET") {
      const list = (await env.DB.prepare("SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 50").all()).results;
      return json({ list });
    }
    if (path === "announcements" && method === "POST") {
      if (user.role !== "admin") return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
      const b = await readBody(request);
      if (!String(b.title || "").trim() || !String(b.content || "").trim()) return json({ error: "\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
      const r = await env.DB.prepare("INSERT INTO announcements (title, content, author, pinned) VALUES (?, ?, ?, ?)").bind(String(b.title).trim(), String(b.content).trim(), user.nickname || user.username, b.pinned ? 1 : 0).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if (path === "staff" && method === "GET") {
      return json({ list: await allAdmins(env) });
    }
    if (path === "messages" && method === "GET") {
      const sent = (await env.DB.prepare(
        "SELECT m.*, u.username AS to_name FROM messages m JOIN users u ON u.id = m.to_user WHERE m.from_user = ? ORDER BY m.id DESC LIMIT 50"
      ).bind(user.id).all()).results;
      let inbox = [];
      if (user.role === "admin") {
        inbox = (await env.DB.prepare(
          "SELECT m.*, u.username AS from_name FROM messages m JOIN users u ON u.id = m.from_user WHERE m.to_user = ? ORDER BY m.id DESC LIMIT 50"
        ).bind(user.id).all()).results;
      }
      return json({ sent, inbox });
    }
    if (path === "messages" && method === "POST") {
      const b = await readBody(request);
      const toId = Number(b.to_user);
      const content = String(b.content || "").trim();
      if (!toId || !content) return json({ error: "\u6536\u4EF6\u4EBA\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
      if (content.length > 2e3) return json({ error: "\u5185\u5BB9\u8FC7\u957F\uFF08\u22642000 \u5B57\uFF09" }, 400);
      const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(toId).first();
      if (!target) return json({ error: "\u6536\u4EF6\u4EBA\u4E0D\u5B58\u5728" }, 404);
      await env.DB.prepare("INSERT INTO messages (from_user, to_user, content) VALUES (?, ?, ?)").bind(user.id, toId, content).run();
      return json({ ok: true });
    }
    if (path === "messages/read" && method === "POST") {
      const b = await readBody(request);
      if (user.role !== "admin") return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
      await env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ? AND to_user = ?").bind(Number(b.id), user.id).run();
      return json({ ok: true });
    }
    if (path === "admin/users" && method === "GET") {
      if (user.role !== "admin") return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
      const list = (await env.DB.prepare("SELECT id, username, nickname, role, created_at FROM users ORDER BY id").all()).results;
      return json({ list });
    }
    if (path.startsWith("admin/users/") && method === "PATCH") {
      if (user.role !== "admin") return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
      const id = Number(path.split("/")[2]);
      const b = await readBody(request);
      if (b.role && !["user", "admin"].includes(b.role)) return json({ error: "\u975E\u6CD5\u89D2\u8272" }, 400);
      if (id === user.id && b.role && b.role !== "admin") return json({ error: "\u4E0D\u80FD\u64A4\u9500\u81EA\u5DF1\u7684\u7BA1\u7406\u5458" }, 400);
      if (b.role) {
        await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(b.role, id).run();
      }
      if (b.nickname !== void 0) {
        await env.DB.prepare("UPDATE users SET nickname = ? WHERE id = ?").bind(String(b.nickname).trim(), id).run();
      }
      return json({ ok: true });
    }
    if (path.startsWith("admin/announcements/") && method === "DELETE") {
      if (user.role !== "admin") return json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" }, 403);
      await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(Number(path.split("/")[2])).run();
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }
};
function okWithCookie(data, token) {
  const res = json(data);
  if (token) res.headers.set("set-cookie", sessionCookie(token));
  else if (token === null) res.headers.set("set-cookie", clearCookie());
  return res;
}
__name(okWithCookie, "okWithCookie");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
