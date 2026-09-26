/*
 * Cloudflare Worker: serves the app's service worker at the storefront root.
 *
 * Shopify strips Service-Worker-Allowed from app-proxy responses, so the
 * worker at /apps/pwa/sw.js can never claim "/". Served from /sw.js instead,
 * its default scope *is* "/", and the header stops mattering. This Worker
 * fetches the real file through the app proxy (so every shop still gets its own
 * settings baked in) and hands it back from the root.
 *
 * Setup — the storefront domain must be on your Cloudflare account, proxied
 * (orange cloud) to Shopify, i.e. Cloudflare's Shopify "O2O" setup:
 *   1. Workers & Pages → Create → paste this file → Deploy.
 *   2. Worker → Settings → Domains & Routes → Add route:
 *        yourstore.com/sw.js        (and www.yourstore.com/sw.js if used)
 *      Route only this one path. Nothing else on the storefront goes through it.
 *   3. Open https://yourstore.com/sw.js — it should be JavaScript and the
 *      response should carry X-PWA-Root-Worker: 1.
 *
 * pwa.js looks for that header and registers /sw.js ahead of the proxy copy.
 */

// The app-proxy path configured in shopify.app.toml ([app_proxy] prefix/subpath).
const PROXY_SW_PATH = '/apps/pwa/sw.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/sw.js') return fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    // A subrequest to a different path on the same zone goes to the origin
    // (Shopify), not back through this route, so there is no loop.
    const upstream = await fetch(new URL(PROXY_SW_PATH, url.origin).toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/javascript, */*;q=0.1',
        'User-Agent': request.headers.get('User-Agent') || 'shopify-pwa-edge',
      },
      redirect: 'follow',
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!upstream.ok) {
      // Never hand the browser an HTML error page under /sw.js: pass the
      // failure through without the marker, so pwa.js falls back cleanly.
      return new Response('Upstream service worker unavailable: HTTP ' + upstream.status, {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const headers = new Headers();
    headers.set('Content-Type', 'application/javascript; charset=utf-8');
    headers.set('Service-Worker-Allowed', '/');
    headers.set('X-PWA-Root-Worker', '1');
    headers.set('Cache-Control', 'no-cache, must-revalidate');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
  },
};
