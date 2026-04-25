/**
 * img-proxy-worker
 * Cloudflare Worker — 代理任意圖片 URL，加上 CORS headers 並強制快取 30 天。
 *
 * 存取控制：檢查 Origin / Referer，只允許你自己的網站使用。
 * 新增網站只需在 ALLOWED_SITE_ORIGINS 加一行，不需要管圖片來自哪個 CDN。
 *
 * 部署後用法：
 *   https://img-proxy.xxx.workers.dev/?url=https://thumbnail.image.rakuten.co.jp/...
 */

// ── 只需維護這裡：你自己的網站網域 ──────────────────────────────────────────
const ALLOWED_SITE_ORIGINS = [
  'bibian.co.jp',
  // 'your-other-site.co.jp',
];

const CACHE_TTL = 60 * 60 * 24 * 30; // 30 天

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    if (!isAllowedCaller(request)) {
      return err(403, 'Forbidden');
    }

    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get('url');

    if (!targetUrl) {
      return err(400, 'Missing ?url=');
    }

    try { new URL(targetUrl); } catch {
      return err(400, 'Invalid URL');
    }

    // 先查 CF CDN 快取
    const cache = caches.default;
    const cacheKey = new Request(request.url);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // 快取 miss，從來源抓圖
    let originRes;
    try {
      originRes = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
          'Referer': refererForUrl(targetUrl),
        },
      });
    } catch (e) {
      return err(502, 'Fetch failed: ' + e.message);
    }

    if (!originRes.ok) {
      return err(originRes.status, 'Origin returned ' + originRes.status);
    }

    const response = new Response(originRes.body, {
      status: 200,
      headers: {
        'Content-Type': originRes.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },
};

// 檢查 Origin 或 Referer 是否來自你自己的網站
function isAllowedCaller(request) {
  const origin  = request.headers.get('Origin')  || '';
  const referer = request.headers.get('Referer') || '';
  return ALLOWED_SITE_ORIGINS.some(function(site) {
    return origin.includes(site) || referer.includes(site);
  });
}

// 根據圖片 URL 猜測合適的 Referer（讓 CDN 覺得是正常瀏覽）
function refererForUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (hostname.includes('rakuten')) return 'https://www.rakuten.co.jp/';
    if (hostname.includes('yahoo'))   return 'https://shopping.yahoo.co.jp/';
    if (hostname.includes('amazon'))  return 'https://www.amazon.co.jp/';
    return 'https://' + hostname + '/';
  } catch {
    return '';
  }
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function err(status, message) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain' } });
}
