/*
 * Storefront service worker. Served through the app proxy as /apps/pwa/sw.js,
 * with the shop's settings substituted into the CFG assignment below.
 *
 * READ THIS BEFORE DEBUGGING IT
 * ----------------------------------------------------------------------
 * On a stock Shopify storefront this worker is registered but effectively
 * dormant, and that is expected. A worker's scope defaults to the directory it
 * is served from; widening it to "/" requires the response to carry
 * Service-Worker-Allowed: /, and Shopify strips that header when it proxies
 * /apps/pwa/* (measured, not assumed — see the README and the same finding in
 * apps/izooto-push). So this worker's scope stays /apps/pwa/, it never sees a
 * storefront navigation, and nothing below runs for a real page view.
 *
 * What it does control is its own directory, and that is no longer nothing:
 * the app's manifest launches at the shell under this same path, so a cold
 * launch with no connection is served from cache rather than failing. The
 * catalogue is still beyond reach and always will be through this route.
 *
 * The rest ships anyway because it is the half of the work that cannot be done
 * later: the day Shopify forwards the header, or the store moves behind a
 * reverse proxy that can serve /sw.js from the root, full offline support is a
 * settings toggle rather than a project. /apps/pwa/check reports which case a
 * given storefront is actually in.
 *
 * The caching rules below are written for that day, and are deliberately timid.
 * Serving a stale cart, a stale price or a stale checkout step is far worse
 * than being online-only, so the exclusion list wins over every other rule.
 */

var CFG = __SW_CONFIG__;

var PAGE_CACHE = CFG.cachePrefix + '-pages-v' + CFG.version;
var ASSET_CACHE = CFG.cachePrefix + '-assets-v' + CFG.version;
var MAX_PAGES = 40;
var MAX_ASSETS = 120;
var NETWORK_TIMEOUT_MS = 4000;

/*
 * Anything that is per-customer, transactional, or a Shopify internal endpoint.
 * A cached response on any of these paths is a support ticket at best and a
 * wrong order at worst.
 */
/*
 * Our own pages under the proxy, which the blanket /apps/ exclusion below would
 * otherwise throw out along with the API endpoints. Exact matches only: /check
 * and /health must keep going to the network every time, and a prefix test
 * would quietly swallow them.
 */
var OURS = [CFG.shellUrl, CFG.offlineUrl].filter(Boolean);

var NEVER_CACHE = [
  /^\/checkout/,
  /^\/checkouts\//,
  /^\/cart/,
  /^\/account/,
  /^\/orders\//,
  /^\/apps\//,          // app proxies, including this app's own endpoints
  /^\/a\//,             // Shopify's short app-proxy prefix
  /^\/admin/,
  /^\/services\//,
  /^\/tools\//,
  /^\/wpm/,             // web pixels manager
  /^\/password/,
  /^\/challenge/,
  /^\/localization/,
  /^\/recommendations\//,
  /^\/search\/suggest/,
  /^\/\.well-known/
];

function isExcluded(url) {
  for (var o = 0; o < OURS.length; o++) {
    if (url.pathname === OURS[o]) return false;
  }
  for (var i = 0; i < NEVER_CACHE.length; i++) {
    if (NEVER_CACHE[i].test(url.pathname)) return true;
  }
  // A preview or editor session must always be live, or a merchant will spend
  // an hour wondering why their theme edit has not appeared.
  if (url.searchParams.has('preview_theme_id')) return true;
  if (url.searchParams.has('_ab') || url.searchParams.has('_fd')) return true;
  return false;
}

function isCacheableAsset(request, url) {
  if (url.origin !== self.location.origin && url.hostname !== 'cdn.shopify.com') return false;
  var d = request.destination;
  return d === 'style' || d === 'script' || d === 'font' || d === 'image';
}

/** Opaque responses report status 0 and an unknown size; storing them is how a
 *  cache quietly eats a quota. Store only responses we can actually inspect. */
function isStorable(response) {
  if (!response) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  if (!response.ok) return false;
  var cc = response.headers.get('cache-control') || '';
  return cc.indexOf('no-store') === -1 && cc.indexOf('private') === -1;
}

/** Crude FIFO trim. Good enough: these caches are a courtesy, not a database. */
function trim(cacheName, max) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= max) return null;
      return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return cache.delete(k); }));
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(PAGE_CACHE)
      .then(function (cache) { return cache.addAll(CFG.precache); })
      // A failed precache must not block activation: the worker is still useful
      // without an offline page, and a permanently installing worker is not.
      .catch(function (err) { console.warn('[pwa] precache failed:', err); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) {
          var ours = name.indexOf(CFG.cachePrefix + '-') === 0;
          if (ours && name !== PAGE_CACHE && name !== ASSET_CACHE) return caches.delete(name);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/**
 * Navigations: network first, with a timeout.
 *
 * Network-first rather than cache-first because storefront HTML carries prices,
 * stock and cart state. The cache is a fallback for a dead connection, never a
 * speed optimisation — the few hundred milliseconds are not worth showing
 * someone a sold-out product as available.
 */
function handleNavigation(request) {
  var timer;
  var timeout = new Promise(function (resolve) {
    timer = setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT_MS);
  });

  var network = fetch(request).then(function (response) {
    clearTimeout(timer);
    if (isStorable(response)) {
      var copy = response.clone();
      caches.open(PAGE_CACHE).then(function (cache) {
        return cache.put(request, copy).then(function () { return trim(PAGE_CACHE, MAX_PAGES); });
      });
    }
    return response;
  }).catch(function () {
    clearTimeout(timer);
    return null;
  });

  function fallback() {
    return caches.match(CFG.offlineUrl).then(function (offline) {
      return offline || new Response('You are offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    });
  }

  return Promise.race([network, timeout]).then(function (response) {
    if (response) return response;

    // The network either failed or is past the timeout. A cached copy is worth
    // showing now; if there is none, keep waiting on the request that is still
    // in flight rather than declaring the visitor offline while it may yet
    // answer — only a genuine failure reaches the offline page.
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return network.then(function (late) { return late || fallback(); });
    });
  });
}

/**
 * Static assets: stale-while-revalidate.
 *
 * Safe here in a way it is not for HTML — Shopify fingerprints theme asset URLs,
 * so a given URL's bytes never change.
 */
function handleAsset(request) {
  return caches.open(ASSET_CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (isStorable(response)) {
          cache.put(request, response.clone()).then(function () { return trim(ASSET_CACHE, MAX_ASSETS); });
        }
        return response;
      }).catch(function () { return cached || Response.error(); });

      return cached || network;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Never touch anything that changes state. A cached or replayed POST is the
  // one bug in a service worker that can cost a merchant money.
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.origin === self.location.origin && isExcluded(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isCacheableAsset(request, url)) {
    event.respondWith(handleAsset(request));
  }
});

/** Lets the page activate a waiting worker without a second reload. */
self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
