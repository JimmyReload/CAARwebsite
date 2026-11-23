// puzzle.cat 赛事列表：服务端代理 + 规范化 + D1 缓存（stale-while-revalidate）
//
// 上游 GET /api/hunts?sortBy=newest 返回 { code, data: { items, page, pageSize, total } }
// 上游 CORS 仅允许 https://puzzle.cat，浏览器无法直连，必须由 Worker 取回。
//
// 上游实测 TTFB 0.6s、总耗时 1–6s 抖动，因此请求路径上绝不等待跨站抓取：
//   - 新鲜（<10min）：直接返回 D1 里的快照
//   - 过期：立刻返回旧快照，同时用 waitUntil 后台刷新
//   - 无快照：仅冷启动同步抓取一次（带 6s 超时）
// 另有 Cron Trigger 每 10 分钟预热，正常情况下用户永远命中快照。

const UPSTREAM = 'https://puzzle.cat/api/hunts';
export const TTL_MS = 10 * 60 * 1000; // 快照视为新鲜的时间
const MIN_REFRESH_MS = 60 * 1000; // 两次抓取的最小间隔，避免刷新按钮打穿上游
const FETCH_TIMEOUT_MS = 6000;
const MAX_PAGES = 4;
const PAGE_SIZE = 48; // 上游上限

const HUNT_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

export function isValidHuntId(id) {
  return HUNT_ID_RE.test(String(id || ''));
}

function text(v, max) {
  const s = v == null ? '' : String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalize(h) {
  const id = text(h && h.id, 32);
  if (!id) return null;
  const slug = text(h.slug, 80);
  // 有 slug 时用规范路径，否则回落到 id 路径；外部赛（originalUrl）直接跳原站
  const original = text(h.originalUrl, 500);
  const url = /^https?:\/\//i.test(original)
    ? original
    : slug
      ? 'https://puzzle.cat/hunt/' + encodeURIComponent(slug)
      : 'https://puzzle.cat/hunts/' + encodeURIComponent(id);
  return {
    id,
    title: text(h.title, 160),
    summary: text(h.summary, 400),
    url,
    startAt: h.startAt || null,
    endAt: h.endAt || null,
    status: text(h.status, 20),
    type: text(h.huntType, 20),
    tags: Array.isArray(h.tags) ? h.tags.slice(0, 8).map((x) => text(x, 40)).filter(Boolean) : [],
    lang: text(h.primaryLanguage, 20),
    rating: num(h.avgRating),
    thumb: text(h.headerImageThumbUrl, 900),
    authors: Array.isArray(h.authors)
      ? h.authors.slice(0, 8).map((a) => text(a && a.nickname, 40)).filter(Boolean)
      : [],
    external: /^https?:\/\//i.test(original)
  };
}

/** 纯抓取 + 规范化，不碰存储；供预热脚本复用 */
export async function fetchHuntList() {
  const items = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES && items.length < total; page++) {
    const url = UPSTREAM + '?sortBy=newest&page=' + page + '&pageSize=' + PAGE_SIZE;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'CAAR-Site/1.0 (+https://caar.fun; member hunt board)'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheTtl: 120, cacheEverything: true }
    });
    if (!res.ok) throw new Error('upstream_http_' + res.status);
    const body = await res.json().catch(() => null);
    if (!body || Number(body.code) !== 200 || !body.data) throw new Error('upstream_payload');
    const batch = Array.isArray(body.data.items) ? body.data.items : [];
    total = num(body.data.total);
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  const seen = new Set();
  const list = [];
  for (const raw of items) {
    const h = normalize(raw);
    if (!h || seen.has(h.id)) continue;
    seen.add(h.id);
    list.push(h);
  }
  return list;
}

async function readFeed(env) {
  const row = await env.DB.prepare('SELECT payload, fetched_at FROM hunt_feed WHERE id = 1').first();
  if (!row) return null;
  let items;
  try { items = JSON.parse(row.payload); } catch { return null; }
  // 空数组也是有效快照：上游真的没有赛事时，不能当成"没缓存"反复打上游
  if (!Array.isArray(items)) return null;
  return { at: Number(row.fetched_at) || 0, items };
}

async function writeFeed(env, feed) {
  await env.DB.prepare(
    `INSERT INTO hunt_feed (id, payload, fetched_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).bind(JSON.stringify(feed.items), feed.at).run();
}

export async function refreshFeed(env) {
  const items = await fetchHuntList();
  const feed = { at: Date.now(), items };
  try { await writeFeed(env, feed); } catch { /* 写失败不影响本次响应 */ }
  return feed;
}

// 同一 isolate 内合并并发刷新
let inFlight = null;
export function scheduleRefresh(env, ctx) {
  if (!inFlight) {
    inFlight = refreshFeed(env).catch(() => null).finally(() => { inFlight = null; });
  }
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(inFlight);
  return inFlight;
}

/**
 * 取赛事列表。返回 { at, items, source }，source 用于排查：
 * cache / stale / stale-error / throttled / upstream
 */
export async function getHuntFeed(env, opts = {}) {
  const { force = false, ctx = null } = opts;
  const cached = await readFeed(env).catch(() => null);
  const age = cached ? Date.now() - cached.at : Infinity;

  if (cached && !force && age < TTL_MS) return { ...cached, source: 'cache' };
  if (cached && age < MIN_REFRESH_MS) return { ...cached, source: 'throttled' };

  // 有旧数据且不是用户显式刷新：先给旧数据，后台补新
  if (cached && !force) {
    scheduleRefresh(env, ctx);
    return { ...cached, source: 'stale' };
  }

  // 显式刷新：最多等 8 秒，超时就先返回旧快照，抓取继续在后台跑完
  if (force && cached) {
    const pending = refreshFeed(env).catch(() => null);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
    const fresh = await Promise.race([pending, timeout]);
    if (fresh) return { ...fresh, source: 'upstream' };
    return { ...cached, source: 'stale-timeout' };
  }

  try {
    const feed = await refreshFeed(env);
    return { ...feed, source: 'upstream' };
  } catch (err) {
    if (cached) return { ...cached, source: 'stale-error' };
    throw err;
  }
}
