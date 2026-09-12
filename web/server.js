/**
 * Storefront PWA — app proxy backend and embedded admin.
 *
 * Two surfaces, with different trust models:
 *
 *   /pwa/proxy/*  reached from the storefront as https://<shop>/apps/pwa/*.
 *                 Public, cacheable, no session. Everything it serves is a
 *                 static file a browser fetches without credentials — a
 *                 <link rel="manifest"> fetch is uncredentialed by spec, so
 *                 there is nothing here to authenticate against.
 *
 *   /  and /api/* the embedded admin. Every write is authorised by an App
 *                 Bridge session token (web/auth.js). The shop comes from the
 *                 token's `dest` claim and never from the request.
 *
 * The app has no Admin API scopes and stores no access token. See
 * shopify.app.toml for why that is possible.
 */

require('./load-env.js');

const fs = require('fs');
const path = require('path');
const express = require('express');

const settingsStore = require('./settings.js');
const images = require('./images.js');
const manifestBuilder = require('./manifest.js');
const validate = require('./validate.js');
const auth = require('./auth.js');
const pages = require('./pages.js');
const adminPage = require('./admin-page.js');

const PORT = parseInt(process.env.PORT || '3007', 10);
const VERIFY_PROXY = String(process.env.PWA_VERIFY_PROXY || '').toLowerCase() === 'true';
const DEFAULT_PROXY_BASE = '/apps/pwa';
const APP_VERSION = require('../package.json').version;

const app = express();
app.disable('x-powered-by');

/* ------------------------------------------------------------------ helpers */

const STOREFRONT_DIR = path.join(__dirname, 'storefront');
const SW_TEMPLATE = fs.readFileSync(path.join(STOREFRONT_DIR, 'sw.js'), 'utf8');
const PWA_TEMPLATE = fs.readFileSync(path.join(STOREFRONT_DIR, 'pwa.js'), 'utf8');

/**
 * Whether black or white text is legible on a given background.
 *
 * Used for the install card's button label. sRGB relative luminance with the
 * usual 0.55 cut, which is a shade above the mathematical midpoint because mid
 * greys read darker than they measure.
 */
function readableOn(hex) {
  const full = hex.length === 4
    ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex;
  const channel = (i) => {
    const v = parseInt(full.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.55 ? '#111111' : '#ffffff';
}

/**
 * The storefront path this app's proxy is mounted at.
 *
 * Shopify sends it as `path_prefix` on every proxy request, so a merchant who
 * changes the subpath in the Partner dashboard does not end up with a manifest
 * full of 404s. Validated before use: it is interpolated into URLs that the
 * browser then fetches.
 */
function proxyBaseFrom(req) {
  const raw = String(req.query.path_prefix || '');
  if (/^\/[a-z0-9/_-]{1,60}$/i.test(raw) && !raw.includes('//')) {
    return raw.replace(/\/$/, '');
  }
  return DEFAULT_PROXY_BASE;
}

/** Resolves the shop for a proxy request, or null. */
function proxyShop(req) {
  const shop = String(req.query.shop || '').toLowerCase();
  return settingsStore.isValidShop(shop) ? shop : null;
}

function cacheFor(res, seconds, immutable) {
  res.set('Cache-Control', 'public, max-age=' + seconds + (immutable ? ', immutable' : ''));
}

/* ----------------------------------------------------------- proxy surface */

const proxy = express.Router();

/*
 * Signature verification is off by default. These are public static files, and
 * a signature mismatch would not fail loudly — it would un-install the PWA for
 * every visitor at once, with nothing in the storefront to say why. Turn it on
 * only after confirming it passes. See PWA_VERIFY_PROXY in .env.example.
 */
proxy.use((req, res, next) => {
  if (!VERIFY_PROXY) return next();
  if (auth.verifyProxySignature(req)) return next();
  return res.status(401).type('text/plain').send('invalid app proxy signature');
});

/**
 * Loads the shop's settings onto the request, or answers 400.
 *
 * Requests arrive without `shop` when someone hits the backend URL directly
 * rather than through a storefront, which is a useful thing to be told plainly.
 */
proxy.use((req, res, next) => {
  const shop = proxyShop(req);
  if (!shop) {
    return res.status(400).type('text/plain').send(
      'This endpoint is served through a Shopify app proxy and needs a shop parameter.\n' +
      'Open it from a storefront instead: https://<your-store>' + DEFAULT_PROXY_BASE + req.path + '\n'
    );
  }
  req.shop = shop;
  req.settings = settingsStore.read(shop);
  req.proxyBase = proxyBaseFrom(req);
  return next();
});

proxy.get('/manifest.json', (req, res) => {
  const manifest = manifestBuilder.build(req.settings, req.proxyBase);

  // Five minutes: long enough that the manifest is not refetched on every page
  // view, short enough that a merchant who changes their app name sees it
  // within a coffee break rather than filing a bug.
  cacheFor(res, 300);
  res.type('application/manifest+json; charset=utf-8');
  res.send(JSON.stringify(manifest, null, 2));
});

proxy.get('/pwa.js', (req, res) => {
  const s = req.settings;
  const rev = s.assets.icon.rev || 'placeholder';

  const config = {
    version: APP_VERSION,
    dir: s.dir,
    name: s.name,
    shortName: s.shortName,
    themeColor: s.themeColor,
    backgroundColor: s.backgroundColor,
    textColor: readableOn(s.backgroundColor),
    onThemeColor: readableOn(s.themeColor),
    appleTouchIcon: req.proxyBase + '/apple-touch-icon.png?v=' + rev,
    ios: {
      statusBarStyle: s.ios.statusBarStyle,
      splash: manifestBuilder.iosSplashLinks(s, req.proxyBase),
    },
    install: s.install,
    sw: { enabled: s.serviceWorker.enabled, url: req.proxyBase + '/sw.js' },
    origin: '',
  };

  cacheFor(res, 600);
  res.type('application/javascript; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(PWA_TEMPLATE.replace('__PWA_CONFIG__', JSON.stringify(config)));
});

proxy.get('/sw.js', (req, res) => {
  const s = req.settings;
  const config = {
    cachePrefix: 'shopify-pwa',
    version: s.serviceWorker.cacheVersion,
    offlineUrl: req.proxyBase + '/offline',
    precache: s.serviceWorker.offlinePage ? [req.proxyBase + '/offline'] : [],
  };

  // Service-Worker-Allowed asks the browser to let a worker served from
  // /apps/pwa/ control the whole origin. Shopify strips it — measured, see the
  // README — so the worker's scope stays /apps/pwa/ and it never sees a
  // storefront navigation. Sent anyway: it costs one header, and it is what
  // makes the day Shopify changes its mind a config change rather than a
  // rewrite. /apps/pwa/check reports which case a given storefront is in.
  res.set('Service-Worker-Allowed', '/');

  // A long-cached service worker is a fix you cannot ship. Browsers revalidate
  // workers on their own schedule regardless; this makes it explicit.
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type('application/javascript; charset=utf-8');
  res.send(SW_TEMPLATE.replace('__SW_CONFIG__', JSON.stringify(config)));
});

/** Icons. `?v=<rev>` makes every URL content-addressed, so a year is safe. */
proxy.get(/^\/icon-(\d+)(-maskable)?\.png$/, async (req, res, next) => {
  try {
    const size = parseInt(req.params[0], 10);
    const buffer = await images.renderIcon(req.shop, req.settings, size, Boolean(req.params[1]));
    cacheFor(res, 31536000, true);
    res.type('image/png').send(buffer);
  } catch (err) {
    next(err);
  }
});

proxy.get('/apple-touch-icon.png', async (req, res, next) => {
  try {
    const buffer = await images.renderIcon(req.shop, req.settings, 180, false);
    cacheFor(res, 31536000, true);
    res.type('image/png').send(buffer);
  } catch (err) {
    next(err);
  }
});

proxy.get(/^\/splash-(\d+)x(\d+)\.png$/, async (req, res, next) => {
  try {
    const buffer = await images.renderSplash(
      req.shop,
      req.settings,
      parseInt(req.params[0], 10),
      parseInt(req.params[1], 10)
    );
    cacheFor(res, 31536000, true);
    res.type('image/png').send(buffer);
  } catch (err) {
    next(err);
  }
});

proxy.get(/^\/screenshot-(wide|narrow)\.png$/, (req, res) => {
  const kind = req.params[0] === 'wide' ? 'screenshotWide' : 'screenshotNarrow';
  if (!req.settings.assets[kind].present) return res.status(404).type('text/plain').send('not set');

  cacheFor(res, 31536000, true);
  res.type('image/png');
  res.sendFile(images.screenshotPath(req.shop, kind));
});

proxy.get('/offline', (req, res) => {
  // Must not be cached by anything but the service worker, which precaches it
  // explicitly. A CDN copy of "you are offline" served to an online visitor is
  // a memorable bug.
  res.set('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8').send(pages.offline(req.settings));
});

/**
 * Storefront self-test.
 *
 * Same-origin with the storefront, which is what makes it worth having: the
 * only place a service worker's real scope can be observed is a page on the
 * origin it claims to control. Answers the three questions that actually
 * decide whether a store is installable, rather than asserting them.
 */
proxy.get('/check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8').send(pages.check(req.settings, req.proxyBase));
});

proxy.get('/health', (req, res) => {
  const s = req.settings;
  res.set('Cache-Control', 'no-store');
  res.type('application/json').send(JSON.stringify({
    ok: true,
    shop: req.shop,
    proxyBase: req.proxyBase,
    configured: Boolean(s.updatedAt),
    iconUploaded: s.assets.icon.present,
    manifest: req.proxyBase + '/manifest.json',
    serviceWorkerEnabled: s.serviceWorker.enabled,
    signatureVerification: VERIFY_PROXY ? 'enforced' : 'disabled',
  }, null, 2));
});

app.use('/pwa/proxy', proxy);

/* --------------------------------------------------------------- webhooks */

/*
 * Mounted before express.json: HMAC verification needs the exact bytes Shopify
 * signed, and a parsed-and-reserialised body is not those bytes.
 */
app.post('/webhooks/app/uninstalled', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  if (!auth.verifyWebhook(req.body, req.get('x-shopify-hmac-sha256'))) {
    return res.status(401).send('invalid hmac');
  }

  const shop = String(req.get('x-shopify-shop-domain') || '').toLowerCase();
  if (settingsStore.isValidShop(shop)) {
    settingsStore.remove(shop);
    console.log('uninstalled: removed settings and assets for ' + shop);
  }

  // Always 200 once the HMAC is good. A non-2xx makes Shopify retry, and a
  // retry cannot make an already-deleted shop any more deleted.
  return res.status(200).send('ok');
});

/* ------------------------------------------------------------ admin surface */

app.use(express.json({ limit: '256kb' }));

app.get('/api/settings', auth.requireSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ settings: settingsStore.read(req.shop), shop: req.shop });
});

app.post('/api/settings', auth.requireSession, (req, res) => {
  const current = settingsStore.read(req.shop);
  const { settings, warnings } = validate.sanitise(req.body, current);

  // Bumping the cache version on every save would discard a returning
  // visitor's cache for a colour change. Only the things the worker actually
  // bakes in warrant it.
  const swChanged =
    settings.serviceWorker.offlinePage !== current.serviceWorker.offlinePage ||
    settings.backgroundColor !== current.backgroundColor;
  settings.serviceWorker.cacheVersion = current.serviceWorker.cacheVersion + (swChanged ? 1 : 0);

  const saved = settingsStore.write(req.shop, settings);
  res.set('Cache-Control', 'no-store');
  res.json({ settings: saved, warnings });
});

/**
 * Image upload. Raw bytes with an image/* content type rather than multipart:
 * one field, no dependency, and nothing to parse but the body.
 */
app.post(
  '/api/assets/:kind',
  auth.requireSession,
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: '8mb' }),
  async (req, res) => {
    const kind = req.params.kind;
    if (!settingsStore.ASSET_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'Unknown asset: ' + kind });
    }

    try {
      const meta = await images.saveUpload(req.shop, kind, req.body);
      const current = settingsStore.read(req.shop);
      current.assets[kind] = {
        present: true,
        rev: meta.rev,
        width: meta.width,
        height: meta.height,
        type: meta.type,
      };

      const warnings = [];
      if (kind === 'icon' && !meta.squareish) {
        warnings.push(
          'That logo is ' + meta.width + 'x' + meta.height + ', not square. It has been centre-cropped, ' +
          'so anything near the long edges will be cut off on a home screen.'
        );
      }
      if (kind === 'screenshotWide' && meta.width <= meta.height) {
        warnings.push('A wide screenshot should be landscape, or Chrome will ignore it on desktop.');
      }
      if (kind === 'screenshotNarrow' && meta.width >= meta.height) {
        warnings.push('A narrow screenshot should be portrait, or Chrome will ignore it on Android.');
      }

      const saved = settingsStore.write(req.shop, current);
      return res.json({ settings: saved, warnings });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('asset upload failed for ' + req.shop + ':', err);
      return res.status(status).json({ error: err.message });
    }
  }
);

app.delete('/api/assets/:kind', auth.requireSession, (req, res) => {
  const kind = req.params.kind;
  if (!settingsStore.ASSET_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'Unknown asset: ' + kind });
  }

  images.removeUpload(req.shop, kind);
  const current = settingsStore.read(req.shop);
  current.assets[kind] = { present: false, rev: null, width: 0, height: 0, type: null };
  return res.json({ settings: settingsStore.write(req.shop, current) });
});

app.get('/admin.js', (req, res) => {
  cacheFor(res, 300);
  res.type('application/javascript; charset=utf-8').send(adminPage.script());
});

app.get('/healthz', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    ok: true,
    version: APP_VERSION,
    apiKey: Boolean(auth.API_KEY),
    apiSecret: Boolean(auth.API_SECRET),
    dataDir: settingsStore.DATA_DIR,
  }));
});

/** The embedded admin shell. Data arrives over /api/settings, not in the HTML. */
app.get('/', (req, res) => {
  const rawShop = String(req.query.shop || '').toLowerCase();
  const shop = settingsStore.isValidShop(rawShop) ? rawShop : null;

  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    // Without a frame-ancestors naming the requesting shop, the browser refuses
    // to render the admin iframe at all. Hitting this host directly is not an
    // embed, so framing is denied outright.
    'Content-Security-Policy': shop
      ? 'frame-ancestors https://' + shop + ' https://admin.shopify.com'
      : "frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });

  res.send(adminPage.html(shop, auth.API_KEY));
});

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(req.method + ' ' + req.originalUrl + ' failed:', err);
  res.status(status).type('text/plain').send(status === 404 ? 'not found' : 'server error');
});

app.listen(PORT, '127.0.0.1', () => {
  console.log('storefront-pwa listening on 127.0.0.1:' + PORT);
  console.log('  data dir: ' + settingsStore.DATA_DIR);
  console.log('  api key: ' + (auth.API_KEY ? 'set' : 'NOT SET — the embedded admin will not load App Bridge'));
  console.log('  api secret: ' + (auth.API_SECRET ? 'set' : 'NOT SET — settings will be read-only'));
  console.log('  proxy signature verification: ' + (VERIFY_PROXY ? 'enforced' : 'disabled'));
});
