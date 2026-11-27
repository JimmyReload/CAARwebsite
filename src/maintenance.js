// 维护页：页面导航遇到 5xx / 超时时的统一出口
//
// 目标：浏览器永远不该看到裸错误码（Cloudflare 的 1102、浏览器的"连接超时"）。
// 只要请求还进了 Worker，就把它换成一张说得清楚的维护页。
//
// 做不到的部分要说清：如果 Cloudflare 边缘在请求进入 Worker 之前就失败
// （模块加载失败、Worker 被强杀、CPU 超限），那个错误页由平台返回，Worker 无权改写。

/** 维护页建议的重试间隔（秒），同时用于 Retry-After 与 meta refresh */
export const RETRY_AFTER = 20

/** 页面导航的响应期限：超过就当作上游卡住，先给维护页，不让浏览器干等到自己超时 */
export const NAVIGATION_DEADLINE_MS = 10000

// 这些前缀是页面要加载的子资源（脚本/样式/字体/图片）。
// 给它们回 HTML 会让浏览器把 HTML 当 JS/CSS 解析，反而更糟，所以只认页面导航。
const SUBRESOURCE_PREFIXES = ['/assets/', '/fonts/', '/images/']
const SUBRESOURCE_PATHS = new Set(['/favicon.ico', '/favicon.svg', '/robots.txt', '/sitemap.xml'])

/**
 * 是否是"用户能看到地址栏"的页面导航。
 * 判据：GET + Accept 含 text/html + 不是 API + 不是静态子资源。
 */
export function isPageNavigation(request, url) {
  if (!request || request.method !== 'GET') return false
  const path = url.pathname
  if (path.startsWith('/api/')) return false
  if (SUBRESOURCE_PATHS.has(path)) return false
  if (SUBRESOURCE_PREFIXES.some((p) => path.startsWith(p))) return false
  const accept = String(request.headers.get('accept') || '')
  return accept.includes('text/html')
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

function pageHtml({ retryAfter, href, rid }) {
  // 纯静态、无外部资源：断网/资源缺失时也能正常显示
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="${esc(retryAfter)}" />
<meta name="robots" content="noindex" />
<title>维护中 · 中不正协</title>
<style>
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #fff; color: #000;
    font-family: Inter, -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 520px; border: 3px solid #000; background: #fff;
    box-shadow: 8px 8px 0 #000; padding: 32px 28px;
  }
  .badge {
    display: inline-block; border: 3px solid #000; background: #ffde59; padding: 2px 8px;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 11px;
    font-weight: 900; letter-spacing: .08em; text-transform: uppercase;
  }
  h1 { margin: 18px 0 10px; font-size: 30px; font-weight: 900; line-height: 1.15; letter-spacing: -.01em; }
  p { font-size: 14px; line-height: 1.7; color: #3a3a3a; }
  p + p { margin-top: 8px; }
  .actions { margin-top: 22px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .retry {
    display: inline-block; border: 3px solid #000; background: #000; color: #fff;
    padding: 9px 16px; font-size: 13px; font-weight: 700; text-decoration: none;
    box-shadow: 4px 4px 0 #000; transition: transform .12s ease, box-shadow .12s ease;
  }
  .retry:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 #000; }
  .hint {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 11px;
    color: #555; margin-top: 18px; word-break: break-all;
  }
  @media (prefers-color-scheme: dark) {
    /* 站点是浅色主题；这里不跟随系统深色，避免与品牌观感割裂 */
  }
</style>
</head>
<body>
  <main class="card" role="status">
    <span class="badge">Maintenance</span>
    <h1>维护中，马上回来</h1>
    <p>站点正在更新或暂时繁忙。本页会在 <strong>${esc(retryAfter)} 秒</strong>后自动重试，也可以点下面的按钮立刻重试。</p>
    <p>如果长时间一直停在这里，请稍后再来，或者通过邮件联系我们。</p>
    <div class="actions">
      <a class="retry" href="${esc(href)}">立即重试</a>
    </div>
    <p class="hint">请求编号：${esc(rid || '未提供')}</p>
  </main>
</body>
</html>
`
}

/**
 * 维护页响应：503 + Retry-After，明确告知代理与爬虫这是暂时状态。
 * 不带 SECURITY_HEADERS —— 由调用方统一 harden()，避免两处维护同一份头。
 */
export function maintenanceResponse({ retryAfter = RETRY_AFTER, href = '/', rid = '' } = {}) {
  return new Response(pageHtml({ retryAfter, href, rid }), {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
      'retry-after': String(retryAfter),
      'x-robots-tag': 'noindex'
    }
  })
}

/**
 * 子资源（JS/CSS/字体/图片）的兜底：不能回 HTML，只给一个短文本，
 * 仍然是"有正文"，不会让浏览器展示裸状态码。
 */
export function subresourceFailureResponse({ retryAfter = RETRY_AFTER } = {}) {
  return new Response('Service temporarily unavailable\n', {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
      'retry-after': String(retryAfter)
    }
  })
}

/** 给一个 promise 套上期限；超时抛 name='RequestTimeout' 的错误，便于上层区分日志 */
export function withDeadline(work, ms) {
  if (!ms || ms <= 0) return work
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('request deadline exceeded')
      err.name = 'RequestTimeout'
      reject(err)
    }, ms)
  })
  return Promise.race([work, guard]).finally(() => clearTimeout(timer))
}
