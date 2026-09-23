/**
 * Performance and installability reports.
 *
 * Two halves that answer two different questions, stored together because a
 * merchant reads them as one verdict on "is my app any good".
 *
 *   Lighthouse   Performance, Accessibility, Best Practices and SEO, measured
 *                by Google's PageSpeed Insights on the live storefront. This
 *                app cannot run Lighthouse itself — that needs a headless
 *                browser, which is a different deployment than "copy the repo,
 *                run node" — so it asks the service that already does.
 *
 *   PWA score    Ours, not Google's, and labelled as ours in the admin. It is a
 *                count of the installability conditions this app is actually
 *                responsible for, checked against the live storefront: is the
 *                manifest reachable through the proxy, does it carry the icons
 *                Chrome insists on, is the theme app embed on the page at all.
 *                Lighthouse dropped its own PWA category in 2024, so there is
 *                nothing left to defer to here.
 *
 * Reports are kept per shop in one JSON file, newest first, capped — see
 * MAX_REPORTS. They are a history a merchant scrolls, not a dataset.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const settingsStore = require('./settings.js');

const REPORTS_DIR = path.join(settingsStore.DATA_DIR, 'reports');

fs.mkdirSync(REPORTS_DIR, { recursive: true });

/** Twenty is a scrollable history. Past that the file grows without anyone
 *  ever reading the bottom of it. */
const MAX_REPORTS = 20;

/** PageSpeed is slow by nature — it loads the page on a throttled connection.
 *  Ninety seconds is past its usual worst case and short of a merchant
 *  assuming the button is broken. */
const PSI_TIMEOUT_MS = 90000;

/** Fetches against the merchant's own storefront, which should answer fast. */
const STOREFRONT_TIMEOUT_MS = 12000;

/**
 * The floor between two runs for one shop.
 *
 * Each run costs a PageSpeed quota unit and two storefront fetches, and the
 * button is the kind that gets clicked twice. This is not a security control —
 * the route is behind a session token — it is a courtesy to the quota.
 */
const COOLDOWN_MS = 30000;

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const PSI_KEY = process.env.PAGESPEED_API_KEY || '';

/** shop -> timestamp of the last run that started. */
const lastRun = new Map();

/** shop -> the promise of a run already in flight, so a double click waits on
 *  the first rather than starting a second. */
const inFlight = new Map();

function reportsFile(shop) {
  return path.join(REPORTS_DIR, path.basename(shop.toLowerCase()) + '.json');
}

function blank(shop) {
  return { version: 1, shop, reports: [] };
}

function readAll(shop) {
  if (!settingsStore.isValidShop(shop)) return blank(shop);

  try {
    const stored = JSON.parse(fs.readFileSync(reportsFile(shop), 'utf8'));
    return {
      ...blank(shop),
      ...stored,
      reports: Array.isArray(stored.reports) ? stored.reports : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('reports read failed for ' + shop + ':', err.message);
    return blank(shop);
  }
}

/** Same temp-file-and-rename as settings.js: a crash mid-write must not cost a
 *  merchant the history they already had. */
function writeAll(shop, data) {
  const target = reportsFile(shop);
  const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * The list view's rows. Deliberately not the whole report: a detail carries
 * every Lighthouse audit that fired, and twenty of those is a payload the list
 * has no use for.
 */
function summarise(report) {
  return {
    id: report.id,
    createdAt: report.createdAt,
    url: report.url,
    strategy: report.strategy,
    ok: report.ok,
    error: report.error || null,
    scores: report.scores,
    pwaScore: report.pwa ? report.pwa.score : null,
  };
}

function list(shop) {
  return readAll(shop).reports.map(summarise);
}

function read(shop, id) {
  return readAll(shop).reports.find((r) => r.id === id) || null;
}

function remove(shop, id) {
  const data = readAll(shop);
  const before = data.reports.length;
  data.reports = data.reports.filter((r) => r.id !== id);
  if (data.reports.length === before) return false;
  writeAll(shop, data);
  return true;
}

/** Called on app/uninstalled, alongside the settings, asset and stats deletes. */
function removeShop(shop) {
  if (!settingsStore.isValidShop(shop)) return;
  try {
    fs.rmSync(reportsFile(shop), { force: true });
  } catch (err) {
    console.error('reports delete failed for ' + shop + ':', err.message);
  }
}

/* ------------------------------------------------------------------ fetching */

/**
 * fetch with a deadline.
 *
 * Every call here is to somebody else's server, on a route a merchant is
 * waiting on. Without a timeout a hung connection holds the request open until
 * the proxy in front of this app gives up, and the merchant is told nothing.
 */
async function fetchWithTimeout(url, ms, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** Lighthouse reports scores as 0-1, and null for a category it could not
 *  run. Percentages are what the admin shows, so convert once, here. */
function pct(category) {
  if (!category || typeof category.score !== 'number') return null;
  return Math.round(category.score * 100);
}

/**
 * The six metrics worth a row in the detail view.
 *
 * Taken from the audits rather than from `loadingExperience`, because the
 * audits are what this run measured; loadingExperience is a 28-day field
 * average of other people's visits and would not move when a merchant fixes
 * something today.
 */
const METRIC_AUDITS = [
  ['first-contentful-paint', 'First Contentful Paint'],
  ['largest-contentful-paint', 'Largest Contentful Paint'],
  ['total-blocking-time', 'Total Blocking Time'],
  ['cumulative-layout-shift', 'Cumulative Layout Shift'],
  ['speed-index', 'Speed Index'],
  ['interactive', 'Time to Interactive'],
];

function metricsFrom(audits) {
  const out = [];
  for (const [id, label] of METRIC_AUDITS) {
    const audit = audits[id];
    if (!audit) continue;
    out.push({
      id,
      label,
      display: audit.displayValue || '-',
      score: typeof audit.score === 'number' ? Math.round(audit.score * 100) : null,
    });
  }
  return out;
}

/**
 * The audits worth acting on, worst first.
 *
 * Filtered to the ones that failed and carry an estimated saving: a merchant
 * reading a report wants the three things to change, not the ninety that
 * passed. Capped at eight for the same reason.
 */
function opportunitiesFrom(audits) {
  const out = [];

  for (const audit of Object.values(audits || {})) {
    if (!audit || typeof audit.score !== 'number' || audit.score >= 0.9) continue;
    const savings = audit.details && typeof audit.details.overallSavingsMs === 'number'
      ? Math.round(audit.details.overallSavingsMs)
      : 0;
    if (!savings) continue;
    out.push({
      id: audit.id,
      title: audit.title,
      // Lighthouse descriptions are markdown with a "Learn more" link on the
      // end. The admin renders text, so the link text is kept and the URL
      // dropped rather than showing a merchant a raw markdown link.
      detail: String(audit.description || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
      savingsMs: savings,
    });
  }

  out.sort((a, b) => b.savingsMs - a.savingsMs);
  return out.slice(0, 8);
}

async function runPageSpeed(url, strategy) {
  const query = new URLSearchParams({ url, strategy });
  for (const category of ['performance', 'accessibility', 'best-practices', 'seo']) {
    query.append('category', category);
  }
  if (PSI_KEY) query.set('key', PSI_KEY);

  const res = await fetchWithTimeout(PSI_ENDPOINT + '?' + query.toString(), PSI_TIMEOUT_MS);
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // PageSpeed puts the useful half of a failure in the body — "Lighthouse
    // returned error: ERRORED_DOCUMENT_REQUEST" says far more than "HTTP 400".
    const detail = body && body.error && body.error.message ? body.error.message : 'HTTP ' + res.status;
    throw new Error(detail);
  }

  const lighthouse = (body && body.lighthouseResult) || {};
  const categories = lighthouse.categories || {};
  const audits = lighthouse.audits || {};

  return {
    scores: {
      performance: pct(categories.performance),
      accessibility: pct(categories.accessibility),
      bestPractices: pct(categories['best-practices']),
      seo: pct(categories.seo),
    },
    metrics: metricsFrom(audits),
    opportunities: opportunitiesFrom(audits),
    lighthouseVersion: lighthouse.lighthouseVersion || null,
  };
}

/* -------------------------------------------------------------- pwa checks */

function check(label, ok, detail) {
  return { label, ok: Boolean(ok), detail };
}

/*
 * Shopify serves its own pages on the storefront domain, at HTTP 200 as often
 * as not, and they are the three most likely things to come back from a proxy
 * path that is not working. Telling them apart is the whole value of this
 * check: "not valid JSON" is true of all three and useful for none.
 *
 * Markers rather than status codes, because the status lies. A password-
 * protected store answers 200 with the password page, and a storefront with no
 * proxy route answers 404 with an HTML body that is not an error as far as
 * fetch is concerned.
 */
function isPasswordPage(res, body) {
  if (res && res.url && /\/password\b/.test(res.url)) return true;
  // `storefront_password` is the form_type on Shopify's own password form;
  // `template-password` is the body class the theme renders it under.
  return /storefront_password|template-password/i.test(body || '');
}

function isShopifyNotFound(res, body) {
  return (res && res.status === 404) || /class="shop-404"|class='shop-404'/i.test(body || '');
}

/**
 * Say what actually answered the manifest URL, and what to do about it.
 *
 * Each branch names one cause and one action. A merchant reading this has a
 * storefront that is not installable and no way to see why from the outside —
 * the manifest URL looks fine in a browser if you do not notice that what came
 * back was a login form.
 */
function explainManifestFailure(res, body, url) {
  if (isPasswordPage(res, body)) {
    return 'The storefront is password protected, so ' + url + ' answers with the password page ' +
      'rather than the manifest. No browser can install a store it cannot read: remove the password ' +
      'under Online Store > Preferences.';
  }

  if (isShopifyNotFound(res, body)) {
    return 'Shopify answered its own 404 page for ' + url + ', which means the app proxy is not ' +
      'routing on this store. Confirm the app version carrying the app proxy has been released, and ' +
      'that its subpath is "pwa" under the "apps" prefix.';
  }

  if (/^\s*<(?:!doctype|html)/i.test(body || '')) {
    return url + ' answered with a web page rather than the manifest (HTTP ' + res.status + '). ' +
      'That is the theme answering, which means the app proxy is not routing this path.';
  }

  if (!res.ok) return 'The manifest URL answered HTTP ' + res.status + '.';

  return 'The manifest URL answered, but not with valid JSON.';
}

async function inspectStorefront(shop, proxyBase) {
  const result = {
    manifest: null,
    manifestUrl: 'https://' + shop + proxyBase + '/manifest.json',
    homeUrl: 'https://' + shop + '/',
    embedFound: false,
    passwordProtected: false,
    notes: [],
  };

  /*
   * The home page is read first, and deliberately so. Whether the store is
   * locked decides how to read everything after it — a password-protected store
   * answers every storefront URL with the password page at HTTP 200, so a
   * manifest check running first would report "not valid JSON" and send a
   * merchant looking for a bug in a manifest they were never served.
   */
  try {
    const res = await fetchWithTimeout(result.homeUrl, STOREFRONT_TIMEOUT_MS, {
      headers: { Accept: 'text/html' },
    });
    const html = await res.text();

    if (isPasswordPage(res, html)) {
      result.passwordProtected = true;
      result.notes.push('The storefront is password protected, so these checks could only see the ' +
        'password page. Remove it under Online Store > Preferences — the store is not installable ' +
        'by anyone while it is on.');
    }

    result.embedFound = html.includes(proxyBase + '/pwa.js') ||
      html.includes('/apps/pwa/pwa.js') ||
      html.includes('shopify-pwa');
  } catch (err) {
    result.notes.push('Could not load the storefront home page: ' + (err.name === 'AbortError' ? 'timed out' : err.message));
  }

  try {
    const res = await fetchWithTimeout(result.manifestUrl, STOREFRONT_TIMEOUT_MS, {
      headers: { Accept: 'application/manifest+json, application/json' },
    });

    // Read as text and parse here rather than calling res.json(): the body is
    // the only evidence of what went wrong, and res.json() throws it away.
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (err) { parsed = null; }

    if (res.ok && parsed) {
      result.manifest = parsed;
    } else if (result.passwordProtected && isPasswordPage(res, body)) {
      // Already said once, at the top, in the same words. Repeating it per
      // check is how a report stops being read.
    } else {
      result.notes.push(explainManifestFailure(res, body, result.manifestUrl));
    }
  } catch (err) {
    result.notes.push('Could not reach the manifest: ' + (err.name === 'AbortError' ? 'timed out' : err.message));
  }

  return result;
}

/**
 * The installability conditions, scored.
 *
 * Every check is something a merchant can act on, and the detail on a failing
 * one says what to do rather than only what is wrong. The manifest ones are
 * read from the live manifest, not from the settings that produced it, so a
 * proxy misconfiguration shows up as a failure instead of passing on the
 * strength of a settings file nobody is serving.
 */
function pwaChecksFor(settings, storefront) {
  const manifest = storefront.manifest || {};
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];

  const hasSize = (size) =>
    icons.some((icon) => String(icon.sizes || '').split(/\s+/).includes(size + 'x' + size));
  const hasMaskable = icons.some((icon) => String(icon.purpose || '').split(/\s+/).includes('maskable'));
  const hasShot = settings.assets.screenshotWide.present || settings.assets.screenshotNarrow.present;

  const checks = [
    check('App embed is on in your theme', storefront.embedFound,
      storefront.embedFound
        ? 'The storefront is loading the app.'
        : 'Turn on the Storefront PWA app embed in Theme editor > App embeds. Nothing else works until this is on.'),

    check('Manifest is reachable', Boolean(storefront.manifest),
      storefront.manifest
        ? storefront.manifestUrl
        : 'The app proxy is not answering at ' + storefront.manifestUrl + '. Check the proxy subpath in your Partner dashboard.'),

    check('App is switched on here', settings.enabled,
      settings.enabled
        ? 'Active.'
        : 'The master switch on the Settings page is off, so the manifest asks for a plain browser tab.'),

    check('Installable display mode', Boolean(manifest.display && manifest.display !== 'browser'),
      manifest.display ? 'display: ' + manifest.display : 'No display mode in the manifest.'),

    check('192px icon', hasSize(192),
      hasSize(192) ? 'Present.' : 'Chrome will not offer to install without one.'),

    check('512px icon', hasSize(512),
      hasSize(512) ? 'Present.' : 'Chrome will not offer to install without one.'),

    check('Maskable icon for Android', hasMaskable,
      hasMaskable ? 'Present.' : 'Without one Android draws your square logo inside a white circle.'),

    check('Name and short name', Boolean(manifest.name && manifest.short_name),
      manifest.name ? manifest.name + ' / ' + manifest.short_name : 'Set these on the Configuration page.'),

    check('Start URL is inside the scope',
      Boolean(manifest.start_url && manifest.scope && String(manifest.start_url).startsWith(manifest.scope)),
      manifest.start_url ? manifest.start_url + ' in ' + manifest.scope : 'Set these on the Settings page.'),

    check('Theme and background colors', Boolean(manifest.theme_color && manifest.background_color),
      manifest.theme_color
        ? manifest.theme_color + ' / ' + manifest.background_color
        : 'Set these on the Configuration page.'),

    check('Your own icon, not the placeholder', settings.assets.icon.present,
      settings.assets.icon.present
        ? settings.assets.icon.width + 'x' + settings.assets.icon.height + ' uploaded'
        : 'A generated placeholder with your initial is being used. Upload a logo on the Configuration page.'),

    check('Install prompt is on', settings.install.enabled,
      settings.install.enabled
        ? 'Shown after ' + settings.install.delaySeconds + 's.'
        : 'Customers are never invited to install. Turn it on on the Install message page.'),

    check('Screenshot for the rich install dialog', hasShot,
      hasShot
        ? 'Present.'
        : 'Optional, but with one Chrome shows a large install dialog with a preview instead of a one-line prompt.'),
  ];

  const passed = checks.filter((c) => c.ok).length;
  return { score: Math.round((passed / checks.length) * 100), passed, total: checks.length, checks };
}

/* ------------------------------------------------------------------ running */

/**
 * The Quick setup wizard's data, and the PWA half of a report.
 *
 * Shared on purpose: the wizard is the same checks with the Lighthouse run left
 * off, so a merchant working through the setup steps is looking at exactly what
 * a report will score them on rather than a second, slightly different list.
 */
async function checkSetup(shop, settings, proxyBase) {
  const storefront = await inspectStorefront(shop, proxyBase);
  return {
    checkedAt: new Date().toISOString(),
    storefront: {
      homeUrl: storefront.homeUrl,
      manifestUrl: storefront.manifestUrl,
      embedFound: storefront.embedFound,
      manifestFound: Boolean(storefront.manifest),
      passwordProtected: storefront.passwordProtected,
      notes: storefront.notes,
    },
    pwa: pwaChecksFor(settings, storefront),
  };
}

function cooldownRemaining(shop) {
  const last = lastRun.get(shop) || 0;
  return Math.max(0, COOLDOWN_MS - (Date.now() - last));
}

async function build(shop, settings, proxyBase, strategy) {
  const url = 'https://' + shop + settings.startUrl;
  const storefront = await inspectStorefront(shop, proxyBase);

  const report = {
    id: crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    url,
    strategy,
    ok: true,
    error: null,
    scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
    metrics: [],
    opportunities: [],
    lighthouseVersion: null,
    notes: storefront.notes,
    pwa: pwaChecksFor(settings, storefront),
  };

  try {
    Object.assign(report, await runPageSpeed(url, strategy));
  } catch (err) {
    // The PWA half is still worth storing. A merchant whose store is password
    // protected, or who is over the PageSpeed quota, gets the installability
    // verdict rather than an empty row and no explanation.
    report.ok = false;
    report.error = err.name === 'AbortError'
      ? 'PageSpeed took longer than ' + Math.round(PSI_TIMEOUT_MS / 1000) + ' seconds and was given up on.'
      : String(err.message || err);
  }

  return report;
}

/**
 * Run a report and store it.
 *
 * Rejects with a `status` on the error for the two cases the admin should
 * phrase differently from a plain failure: too soon after the last run, and a
 * run already under way — the second of which is not an error at all, it is the
 * first run's own promise handed back.
 */
function generate(shop, settings, proxyBase, strategy) {
  if (!settingsStore.isValidShop(shop)) {
    return Promise.reject(Object.assign(new Error('invalid shop'), { status: 400 }));
  }

  const running = inFlight.get(shop);
  if (running) return running;

  const wait = cooldownRemaining(shop);
  if (wait > 0) {
    return Promise.reject(Object.assign(
      new Error('A report was just run. Try again in ' + Math.ceil(wait / 1000) + ' seconds.'),
      { status: 429 }
    ));
  }

  lastRun.set(shop, Date.now());

  const run = build(shop, settings, proxyBase, strategy === 'desktop' ? 'desktop' : 'mobile')
    .then((report) => {
      const data = readAll(shop);
      data.reports.unshift(report);
      data.reports = data.reports.slice(0, MAX_REPORTS);
      writeAll(shop, data);
      return report;
    })
    .finally(() => {
      inFlight.delete(shop);
    });

  inFlight.set(shop, run);
  return run;
}

module.exports = {
  COOLDOWN_MS,
  MAX_REPORTS,
  REPORTS_DIR,
  checkSetup,
  // Exported for the tests. What a merchant is told when the storefront serves
  // something other than the manifest is the whole point of this check, and it
  // is not reachable through generate() without standing up a fake storefront.
  explainManifestFailure,
  generate,
  list,
  read,
  remove,
  removeShop,
};
