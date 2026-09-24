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
const stats = require('./stats.js');
const images = require('./images.js');
const manifestBuilder = require('./manifest.js');
const validate = require('./validate.js');
const auth = require('./auth.js');
const pages = require('./pages.js');
const reports = require('./reports.js');
const adminPage = require('./admin-page.js');

const PORT = parseInt(process.env.PORT || '3007', 10);
const VERIFY_PROXY = String(process.env.PWA_VERIFY_PROXY || '').toLowerCase() === 'true';
const DEFAULT_PROXY_BASE = '/apps/pwa';
const APP_VERSION = require('../package.json').version;

/**
 * This app's handle, as it appears in its admin URL.
 *
 * Read from shopify.app.toml rather than repeated here, because the two
 * drifting apart has no visible symptom on this side: /api/auth keeps building
 * a URL that looks right and every merchant who follows it lands on Shopify's
 * own 404 with nothing in this app's log to say why.
 *
 * This lived in web/billing.js until the paid plans were removed, and moved
 * here rather than going with them — it was never about billing, it just
 * happened to be what built the pricing links.
 */
const APP_HANDLE = (function () {
  const fromEnv = String(process.env.PWA_APP_HANDLE || '').trim();
  if (fromEnv) return fromEnv;

  // A one-line regex rather than a TOML parser: `handle` is a top-level scalar
  // in a file this repo owns, and a dependency to read one string is not a
  // trade worth making.
  try {
    const toml = fs.readFileSync(path.join(__dirname, '..', 'shopify.app.toml'), 'utf8');
    const match = /^\s*handle\s*=\s*["']([^"']+)["']/m.exec(toml);
    if (match) return match[1].trim();
    console.warn('shopify.app.toml has no `handle`; /api/auth will fall back to a shop-scoped reload.');
  } catch (err) {
    console.warn('could not read shopify.app.toml (' + err.message + '); set PWA_APP_HANDLE.');
  }

  return '';
})();

const app = express();
app.disable('x-powered-by');

/* ------------------------------------------------------------------ helpers */

const STOREFRONT_DIR = path.join(__dirname, 'storefront');

/**
 * Load a storefront script template and prove its config placeholder is unique.
 *
 * This check earns its keep: `String.replace` with a string pattern substitutes
 * only the FIRST occurrence, so a second mention of the token — in a header
 * comment, say — silently swallows the config and leaves the real assignment as
 * a bare identifier. The served file is then valid JavaScript that throws
 * ReferenceError on the first line of every storefront page. Failing at boot is
 * the only good time to find that out.
 */
function loadTemplate(file, token) {
  const source = fs.readFileSync(path.join(STOREFRONT_DIR, file), 'utf8');
  const occurrences = source.split(token).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      'web/storefront/' + file + ' must contain ' + token + ' exactly once, found ' + occurrences +
      '. Mentioning the token in a comment breaks the substitution.'
    );
  }
  return { source, token };
}

function render(template, config) {
  return template.source.split(template.token).join(JSON.stringify(config));
}

const SW_TEMPLATE = loadTemplate('sw.js', '__SW_CONFIG__');
const PWA_TEMPLATE = loadTemplate('pwa.js', '__PWA_CONFIG__');

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
 * The install button's background and label colors, with the blanks filled in.
 *
 * Either may be left empty in the admin, and empty means "follow the theme
 * color" rather than "black". A merchant who sets only the background gets a
 * label picked for legibility against it, which is the case worth getting right
 * — a dark brand color with the default dark label is an invisible button, and
 * it would be invisible only once it was live.
 */
function installButtonColors(settings) {
  const background = settings.install.buttonBackgroundColor || settings.themeColor;
  return {
    buttonBackgroundColor: background,
    buttonTextColor: settings.install.buttonTextColor || readableOn(background),
  };
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

/**
 * A ceiling on how fast one shop's install counters can move.
 *
 * The counter endpoint is public and unauthenticated — it has to be, it is
 * called from a storefront page with no session — so without a cap the numbers
 * are whatever anyone with the URL cares to type. This bounds the damage: an
 * abused counter flattens out at the ceiling for that minute instead of running
 * away, which a merchant can at least recognise as wrong.
 *
 * Keyed on the shop, not the caller, because there is no usable caller here.
 * The app sits behind nginx, so the socket address is 127.0.0.1 for every
 * request; and even reading X-Forwarded-For would only reveal Shopify's app
 * proxy, which is the origin of every legitimate storefront event from every
 * store. A per-address limit would therefore either throttle one shared bucket
 * for the whole fleet or do nothing at all.
 *
 * The ceiling is set far above real traffic. The storefront script sends at
 * most a handful of events per visit — `installed` once per browser ever — so a
 * store would need roughly twenty install-card impressions a second to reach
 * it.
 */
const RATE_WINDOW_MS = 60000;
const RATE_MAX_PER_SHOP = 1200;
const rateWindow = new Map();

function withinRate(shop) {
  const now = Date.now();

  // The key space is "anything shaped like a myshopify domain", which is not a
  // bounded set — someone enumerating names would otherwise grow this map for
  // as long as they cared to. Cleared wholesale rather than swept: the entries
  // are counters with no value past the current minute, so a full clear costs
  // one allocation instead of a walk, and the worst it does is give every shop
  // a fresh window. stats.js applies its own, stricter bound before any of
  // those names reaches the disk.
  if (rateWindow.size > 5000) rateWindow.clear();

  const entry = rateWindow.get(shop);

  if (!entry || now > entry.resetAt) {
    rateWindow.set(shop, { count: 1, resetAt: now + RATE_WINDOW_MS, warned: false });
    return true;
  }

  entry.count += 1;
  if (entry.count <= RATE_MAX_PER_SHOP) return true;

  // Once per window, not per request: a rejected flood must not turn into a
  // flood of log lines, but a merchant asking why their chart has a flat top
  // deserves something in the log to find.
  if (!entry.warned) {
    entry.warned = true;
    console.warn('install events for ' + shop + ' hit the ' + RATE_MAX_PER_SHOP + '/min ceiling; dropping the rest of this minute');
  }
  return false;
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
  const rev = images.renderRev(s);

  // Switched off in the admin. The theme app embed still requests this file, so
  // answer with something valid and inert rather than a 404 in every console.
  if (!s.enabled) {
    cacheFor(res, 60);
    res.type('application/javascript; charset=utf-8');
    return res.send('/* Storefront PWA is switched off in the app admin. */\n');
  }

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
    // The button's two colors are resolved here rather than on the storefront.
    // Blank means "follow the theme color", and working that out needs the
    // luminance check below — which is worth doing once per request on a server
    // instead of on every page view in every visitor's browser.
    install: {
      ...s.install,
      ...installButtonColors(s),
    },
    sw: { enabled: s.serviceWorker.enabled, url: req.proxyBase + '/sw.js' },
    eventUrl: req.proxyBase + '/event',
    origin: '',
  };

  cacheFor(res, 600);
  res.type('application/javascript; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(render(PWA_TEMPLATE, config));
});

proxy.get('/sw.js', (req, res) => {
  const s = req.settings;
  // The shell is precached unconditionally: it is the app's launch URL, and a
  // launch URL that is not in the cache is the one page whose absence is
  // guaranteed to be noticed.
  const precache = [req.proxyBase + '/'];
  if (s.serviceWorker.offlinePage) precache.push(req.proxyBase + '/offline');

  // The merchant's own list goes last, so that if the browser gives up partway
  // through the install the two entries the app cannot work without are already
  // in the cache.
  if (s.serviceWorker.precache.enabled) {
    precache.push(...s.serviceWorker.precache.urls);
  }

  const config = {
    cachePrefix: 'shopify-pwa',
    version: s.serviceWorker.cacheVersion,
    offlineUrl: req.proxyBase + '/offline',
    shellUrl: req.proxyBase + '/',
    offlineText: s.offline.title + '\n\n' + s.offline.message,
    cache: s.serviceWorker.cache,
    precache,
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
  res.send(render(SW_TEMPLATE, config));
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

proxy.get(/^\/screenshot-(wide|narrow)\.png$/, (req, res, next) => {
  const kind = req.params[0] === 'wide' ? 'screenshotWide' : 'screenshotNarrow';
  if (!req.settings.assets[kind].present) return res.status(404).type('text/plain').send('not set');

  // Served straight off disk rather than re-encoded: Chrome wants the real
  // image at the exact size the manifest declares. The caching options go
  // through sendFile rather than a header set beforehand — sendFile writes its
  // own Cache-Control and would overwrite one set here.
  return res.sendFile(images.screenshotPath(req.shop, kind), {
    maxAge: '1y',
    immutable: true,
    headers: { 'Content-Type': 'image/png' },
  }, (err) => {
    if (err) next(err);
  });
});

/**
 * The launch shell. This is what the installed app opens, and the only page in
 * the whole product the service worker is permitted to control — see
 * pages.shell and manifest.startUrlFor for why the app launches here rather
 * than straight at the storefront.
 */
proxy.get('/', (req, res) => {
  // Short, but not zero: the shell is the app's front door, so a stale copy for
  // a few minutes is fine while a redeploy still reaches people the same day.
  cacheFor(res, 300, false);
  res.set('X-Content-Type-Options', 'nosniff');
  res.type('text/html; charset=utf-8').send(pages.shell(req.settings, req.settings.startUrl, {
    enabled: req.settings.serviceWorker.enabled,
    url: req.proxyBase + '/sw.js',
  }));
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

/**
 * The install counter. Called from the storefront by navigator.sendBeacon.
 *
 * POST only, and everything it needs is in the query string: a beacon has no
 * body worth parsing, and a GET would be cached by Shopify's CDN — the second
 * install of the day would be served a 204 from the edge and never reach here.
 *
 * Answers 204 whatever happens, including for an unknown event name or a
 * client over its rate limit. A beacon is fired from a page that is often
 * already unloading; there is nobody left to read an error, and a 4xx would
 * only put a red line in a merchant's console for a counter that does not
 * matter that much.
 */
proxy.post('/event', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // `p` is the device family the storefront script placed itself in — ios,
  // android or desktop. It is sent by the page rather than derived from the
  // User-Agent here because the script already had to know, to decide which
  // install directions to show; asking twice would risk the two disagreeing.
  // Anything unrecognised lands in `other` — see stats.platformKey.
  if (withinRate(req.shop)) {
    stats.record(req.shop, String(req.query.type || ''), String(req.query.p || ''));
  }
  res.status(204).end();
});

proxy.get('/health', (req, res) => {
  const s = req.settings;

  res.set('Cache-Control', 'no-store');
  res.type('application/json').send(JSON.stringify({
    ok: true,
    shop: req.shop,
    proxyBase: req.proxyBase,
    enabled: s.enabled,
    installCardOffered: s.install.enabled,
    configured: Boolean(s.updatedAt),
    iconUploaded: s.assets.icon.present,
    manifest: req.proxyBase + '/manifest.json',
    serviceWorkerEnabled: s.serviceWorker.enabled,
    signatureVerification: VERIFY_PROXY ? 'enforced' : 'disabled',
  }, null, 2));
});

app.use('/pwa/proxy', proxy);

/* --------------------------------------------------------------- webhooks */

/**
 * Body parser + HMAC gate, in that order, for every webhook route.
 *
 * express.raw comes first because the signature covers the exact bytes Shopify
 * sent; a parsed-and-reserialised body is not those bytes. A request that fails
 * the check gets 401 and never reaches a handler — this is also precisely what
 * the automated review check probes, by posting a deliberately wrong signature.
 */
const webhook = [
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res, next) => {
    if (!auth.verifyWebhook(req.body, req.get('x-shopify-hmac-sha256'))) {
      return res.status(401).send('invalid hmac');
    }
    req.webhookShop = String(req.get('x-shopify-shop-domain') || '').toLowerCase();
    req.webhookTopic = String(req.get('x-shopify-topic') || '').toLowerCase();
    return next();
  },
];

/**
 * Erase everything the app holds for one shop. Shared by app/uninstalled and
 * shop/redact, which differ only in when Shopify sends them — the uninstall
 * arrives at once, the redact 48 hours later — never in what has to go.
 *
 * Returns whether the header named a shop at all, not whether anything was
 * found to delete: every remove() below is already idempotent, so a shop that
 * was cleared 48 hours ago and one that never existed take the same path.
 */
function eraseShop(shop) {
  if (!settingsStore.isValidShop(shop)) return false;
  settingsStore.remove(shop);
  stats.remove(shop);
  reports.removeShop(shop);
  return true;
}

/**
 * Answer Shopify first; erase once the response is off the socket.
 *
 * Shopify allows a webhook endpoint about five seconds and records anything
 * slower as "No response from app" — which on a compliance topic is held
 * against the app even though the erasure itself would have succeeded. The
 * erasure is local disk, and one part of it is not bounded: settingsStore.remove
 * does a recursive, *synchronous* fs.rmSync over the shop's asset directory,
 * which holds the uploaded icon plus every derived render — twelve icon sizes
 * and twenty iOS splash screens, the largest of them 2048x2732. That is
 * milliseconds on an idle box and something else entirely on a 1 GB VPS that is
 * swapping because sharp is rendering one of those splashes for another shop.
 * Leaving it inside the five second budget makes the reply time a function of
 * how busy the image pipeline happens to be.
 *
 * Deferring costs nothing. Every remove() is idempotent and none of them can
 * fail in a way a Shopify retry would repair, so there is no outcome worth
 * reporting in the status code — the 200 only ever meant "received". If the
 * process dies in the gap, app/uninstalled and the next shop/redact are each
 * still a backstop for the other.
 *
 * 'close' rather than 'finish' on purpose: it fires both on a completed
 * response and on one whose connection was cut, and the obligation to erase
 * does not depend on Shopify having heard the answer.
 */
function eraseWhenSent(res, shop, topic) {
  res.on('close', () => {
    if (eraseShop(shop)) {
      console.log(topic + ': removed settings, assets, install counts and reports for ' + shop);
    } else {
      console.log(topic + ': ignored, not a shop domain: ' + JSON.stringify(shop));
    }
  });
}

app.post('/webhooks/app/uninstalled', webhook, (req, res) => {
  // The plan record goes with the rest. Shopify cancels the subscription on
  // uninstall, so keeping it would mean a merchant who reinstalled next year
  // arrived already entitled to a plan they had stopped paying for.
  eraseWhenSent(res, req.webhookShop, 'uninstalled');

  // Always 200 once the HMAC is good. A non-2xx makes Shopify retry, and a
  // retry cannot make an already-deleted shop any more deleted.
  return res.status(200).send('ok');
});

/**
 * The three mandatory privacy webhooks, on one route because Shopify sends the
 * topic in a header and the work splits cleanly on it.
 *
 * What this app actually holds per shop: the PWA settings, the uploaded icon
 * and its derived sizes, install/dismissal counts, saved reports and the plan
 * record. Install events are counted, never attributed — no customer id, no
 * email, no IP, no order or address is written anywhere (see web/stats.js,
 * which increments a per-day, per-platform integer and nothing else). So the
 * two customer topics have nothing to look up and nothing to erase, and they
 * say so rather than pretending to work; shop/redact erases the shop outright.
 *
 * Every branch answers 200 without touching the disk first — shop/redact hands
 * its erasure to eraseWhenSent, so the reply goes out in the same tick the
 * request arrived in. Shopify retries a non-2xx for 48 hours and treats
 * persistent failure as a compliance breach, so "I had no such record" must be
 * a 200, not a 404.
 */
app.post('/webhooks/compliance', webhook, (req, res) => {
  const shop = req.webhookShop;
  const topic = req.webhookTopic;

  if (topic === 'shop/redact') {
    // Sent ~48 hours after uninstall, by which time app/uninstalled has usually
    // cleared this shop already and there is nothing left to remove — the
    // correct outcome, not a failure. If that earlier webhook was ever missed,
    // this is the backstop that makes the erasure actually happen.
    eraseWhenSent(res, shop, 'shop/redact');
    return res.status(200).send('ok');
  }

  if (topic === 'customers/data_request' || topic === 'customers/redact') {
    console.log(topic + ': no customer data is stored by this app (' + shop + ')');
    return res.status(200).json({ shop, topic, customer_data_stored: false });
  }

  // A signed request for a topic this route was never subscribed to. The
  // signature was valid, so this is not an attack — 200 and drop it, because a
  // retry would not produce a topic we understand any better.
  console.log('compliance webhook: ignoring unexpected topic ' + JSON.stringify(topic) + ' from ' + shop);
  return res.status(200).send('ok');
});

/* ------------------------------------------------------------ admin surface */

app.use(express.json({ limit: '256kb' }));

app.get('/api/settings', auth.requireSession, async (req, res, next) => {
  try {
    const settings = settingsStore.read(req.shop);
    res.set('Cache-Control', 'no-store');
    res.json({ settings, shop: req.shop, previews: await images.thumbnails(req.shop, settings) });
  } catch (err) {
    next(err);
  }
});

/**
 * Install counts for the shop in the session token. Read-only — the counters
 *  are only ever written from the storefront.
 *
 * Everything the summary holds, including the per-device breakdown the
 * Analytics page draws. This used to withhold the platform fields from shops on
 * the free plan; the app has no paid plan any more, so there is nothing to
 * withhold and no caller left that expects a partial response.
 */
app.get('/api/stats', auth.requireSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(stats.summary(req.shop, req.query.days));
});

app.post('/api/settings', auth.requireSession, (req, res) => {
  const current = settingsStore.read(req.shop);
  const { settings, warnings } = validate.sanitise(req.body, current);

  // Bumping the cache version on every save would discard a returning
  // visitor's cache for a color change. Only the things the worker actually
  // bakes in warrant it — the cache rules and the precache list among them,
  // because a merchant who has just switched image caching off means "stop
  // serving those from cache", not "stop adding new ones".
  const swChanged =
    settings.serviceWorker.offlinePage !== current.serviceWorker.offlinePage ||
    settings.backgroundColor !== current.backgroundColor ||
    JSON.stringify(settings.serviceWorker.cache) !== JSON.stringify(current.serviceWorker.cache) ||
    JSON.stringify(settings.serviceWorker.precache) !== JSON.stringify(current.serviceWorker.precache) ||
    JSON.stringify(settings.offline) !== JSON.stringify(current.offline);
  settings.serviceWorker.cacheVersion = current.serviceWorker.cacheVersion + (swChanged ? 1 : 0);

  const saved = settingsStore.write(req.shop, settings);

  // The colors and the store's initial are baked into the maskable icons, the
  // splash screens and the placeholder icon, so a change to any of them means
  // the renders on disk are stale. Their URLs change with them (renderRev
  // covers the same inputs), so this is only housekeeping — without it the
  // superseded files would sit in the data directory forever.
  if (images.renderRev(saved) !== images.renderRev(current)) {
    images.clearDerived(req.shop);
  }

  res.set('Cache-Control', 'no-store');
  res.json({ settings: saved, warnings });
});

/**
 * Force every cache this app can reach to let go.
 *
 * Three layers hold a copy of something this app serves, and only two of them
 * can be reached from here. Both are reached by moving a version, because
 * nothing else works: you cannot reach into a browser's cache, and a merchant
 * who changed nothing has no other way to change a URL.
 *
 *   Derived renders   `renderVersion` feeds renderRev, so a bump moves every
 *                     icon, maskable, splash and thumbnail URL at once. They
 *                     are served immutable for a year, so a new URL is the only
 *                     flush there is. The files on disk go too, or the old
 *                     renders sit there forever under keys nothing will ask for
 *                     again.
 *   Service worker    `cacheVersion` names the worker's two Cache Storage
 *                     buckets, and sw.js deletes every `shopify-pwa-*` cache
 *                     that is not the current pair when it activates. sw.js is
 *                     served no-cache and pwa.js re-registers on every page
 *                     view, so a bump reaches a visitor on their next one.
 *
 * What it cannot do, and what the admin says plainly rather than implying
 * otherwise: purge the browser and CDN copies of manifest.json and pwa.js.
 * There is no purge API for app proxy responses. They carry max-age of 300 and
 * 600, so they expire on their own within ten minutes — which is why those two
 * are cached for minutes and not for the year the icons get.
 */
app.post('/api/cache/clear', auth.requireSession, async (req, res, next) => {
  try {
    const current = settingsStore.read(req.shop);
    const saved = settingsStore.write(req.shop, {
      ...current,
      renderVersion: current.renderVersion + 1,
      serviceWorker: {
        ...current.serviceWorker,
        cacheVersion: current.serviceWorker.cacheVersion + 1,
      },
    });

    // After the write, not before: if the write throws, the renders on disk
    // still match the settings that are still in force.
    images.clearDerived(req.shop);

    res.set('Cache-Control', 'no-store');
    res.json({ settings: saved, previews: await images.thumbnails(req.shop, saved) });
  } catch (err) {
    next(err);
  }
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
      return res.json({ settings: saved, warnings, previews: await images.thumbnails(req.shop, saved) });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('asset upload failed for ' + req.shop + ':', err);
      return res.status(status).json({ error: err.message });
    }
  }
);

app.delete('/api/assets/:kind', auth.requireSession, (req, res, next) => {
  const kind = req.params.kind;
  if (!settingsStore.ASSET_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'Unknown asset: ' + kind });
  }

  images.removeUpload(req.shop, kind);
  const current = settingsStore.read(req.shop);
  current.assets[kind] = { present: false, rev: null, width: 0, height: 0, type: null };

  const saved = settingsStore.write(req.shop, current);
  // removeUpload clears every derivative, including the other assets' thumbs,
  // so they are re-rendered here rather than left as stale data URLs.
  return images.thumbnails(req.shop, saved)
    .then((previews) => res.json({ settings: saved, previews }))
    .catch(next);
});

/* -------------------------------------------------------- reports & setup */

/**
 * The proxy subpath, as this app's server has to guess it.
 *
 * On a storefront request Shopify sends it as `path_prefix`, so nothing there
 * has to guess. The admin has no such luxury: it is an iframe on
 * admin.shopify.com with no idea what subpath the app proxy is mounted at, and
 * this app has no Admin API scopes to look it up with. So the checks below use
 * the configured default and say which URL they tried, which turns a merchant
 * who changed the subpath from confused into informed.
 */
const ADMIN_PROXY_BASE = process.env.PWA_PROXY_BASE || DEFAULT_PROXY_BASE;

/**
 * What the Quick setup wizard reads: the same installability checks a report
 * scores, run against the live storefront, with no Lighthouse call.
 *
 * Slow by nature — it makes two cross-network fetches — so it is its own route
 * rather than part of /api/settings, which the admin blocks on at load.
 */
app.get('/api/setup', auth.requireSession, async (req, res, next) => {
  try {
    const settings = settingsStore.read(req.shop);
    res.set('Cache-Control', 'no-store');
    res.json(await reports.checkSetup(req.shop, settings, ADMIN_PROXY_BASE));
  } catch (err) {
    next(err);
  }
});

app.get('/api/reports', auth.requireSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ reports: reports.list(req.shop), max: reports.MAX_REPORTS });
});

app.get('/api/reports/:id', auth.requireSession, (req, res) => {
  const report = reports.read(req.shop, String(req.params.id));
  res.set('Cache-Control', 'no-store');
  if (!report) return res.status(404).json({ error: 'No such report.' });
  return res.json({ report });
});

app.post('/api/reports', auth.requireSession, async (req, res) => {
  try {
    const settings = settingsStore.read(req.shop);
    const body = req.body || {};
    const report = await reports.generate(
      req.shop,
      settings,
      ADMIN_PROXY_BASE,
      String(body.strategy || 'mobile'),
      String(body.target || 'start'),
      // Left as the raw string. reports.resolveTarget is the one place that
      // decides what a valid page is, and a second opinion here would be a
      // second thing to keep in step with it.
      String(body.path || '')
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ report, reports: reports.list(req.shop) });
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error('report generation failed for ' + req.shop + ':', err);
    return res.status(status).json({ error: err.message });
  }
});

app.delete('/api/reports/:id', auth.requireSession, (req, res) => {
  const removed = reports.remove(req.shop, String(req.params.id));
  res.set('Cache-Control', 'no-store');
  if (!removed) return res.status(404).json({ error: 'No such report.' });
  return res.json({ reports: reports.list(req.shop) });
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

/**
 * The URL declared as `[auth] redirect_urls` in shopify.app.toml.
 *
 * This app has no OAuth flow — `scopes = ""`, so Shopify's managed install
 * grants it without an authorization code and the embedded admin authenticates
 * with App Bridge session tokens instead. Shopify should therefore never send a
 * merchant here.
 *
 * It exists because "should never" is not "cannot", and a declared redirect URL
 * that answers 404 is a dead end at exactly the moment a merchant is being
 * handed to the app for the first time. App Store review also reads the route
 * as the install destination and has nothing to follow without it. So the
 * route's whole job is to put the merchant in the app UI inside Shopify admin,
 * which is where the install should have landed them anyway.
 *
 * Top-level, not embedded: whatever sent a merchant here did so in the top
 * frame, and admin.shopify.com re-embeds the app itself with the `host` and
 * `shop` parameters App Bridge needs — parameters this route cannot mint.
 */
app.get('/api/auth', (req, res) => {
  const shop = String(req.query.shop || '').toLowerCase();

  // Unvalidated, this would be an open redirect: `shop` arrives from the query
  // string and is about to become the host part of a Location header.
  if (!settingsStore.isValidShop(shop)) {
    return res.redirect(302, '/');
  }

  const storeHandle = shop.replace(/\.myshopify\.com$/, '');

  // APP_HANDLE is read from shopify.app.toml, so there is no second copy of the
  // handle to drift. Empty only if that read failed, and a shop scoped reload
  // of the admin shell still beats a 404.
  const target = APP_HANDLE
    ? 'https://admin.shopify.com/store/' + storeHandle + '/apps/' + APP_HANDLE
    : '/?shop=' + encodeURIComponent(shop);

  res.set('Cache-Control', 'no-store');
  return res.redirect(302, target);
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

stats.start();

app.listen(PORT, '127.0.0.1', () => {
  console.log('storefront-pwa listening on 127.0.0.1:' + PORT);
  console.log('  data dir: ' + settingsStore.DATA_DIR);
  console.log('  api key: ' + (auth.API_KEY ? 'set' : 'NOT SET — the embedded admin will not load App Bridge'));
  console.log('  api secret: ' + (auth.API_SECRET ? 'set' : 'NOT SET — settings will be read-only'));
  console.log('  proxy signature verification: ' + (VERIFY_PROXY ? 'enforced' : 'disabled'));
});
