/**
 * Full offline browsing: the root service worker, and the edge that serves it.
 *
 * Shopify strips Service-Worker-Allowed from app-proxy responses, so the worker
 * at /apps/pwa/sw.js can never control a product page. The way round it is to
 * serve the same file at /sw.js, where its default scope is already "/" — and
 * only something in front of Shopify on the store's own domain can do that.
 * See edge/ in the repo, and registerServiceWorker in storefront/pwa.js, which
 * looks for the X-PWA-Root-Worker marker these edges add.
 *
 * Three jobs, one per export:
 *   check    Is /sw.js live on the storefront, with the marker? Read from the
 *            real domain, never inferred from anything this app stored.
 *   snippets The Cloudflare, nginx and Apache configs, with this app's proxy
 *            path filled in, for a merchant who would rather paste them.
 *   deploy   Put the Cloudflare Worker and its route in place with a token the
 *            merchant pastes. The token is used for this one request and is
 *            never written anywhere — this app stores no credentials, and a
 *            Cloudflare token that can edit Workers is not the one to start with.
 */

const fs = require('fs');
const path = require('path');

const EDGE_DIR = path.join(__dirname, '..', 'edge');
const CF_API = 'https://api.cloudflare.com/client/v4';
const SCRIPT_NAME = 'pocketfront-pwa-sw';
const TIMEOUT_MS = 12000;
const MARKER = 'x-pwa-root-worker';

function readEdge(file) {
  return fs.readFileSync(path.join(EDGE_DIR, file), 'utf8');
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'follow', ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function why(err) {
  return err && err.name === 'AbortError' ? 'timed out' : String((err && err.message) || err);
}

/* ------------------------------------------------------------------ check */

/**
 * The storefront's primary domain, as a customer reaches it.
 *
 * This app has no Admin API scopes to ask Shopify, but it does not need them:
 * the myshopify.com address redirects to the primary domain, so following that
 * one redirect is the answer. Falls back to the myshopify host when the fetch
 * fails, which is also the right answer for a store with no custom domain.
 */
async function storefrontHost(shop) {
  try {
    const res = await fetchWithTimeout('https://' + shop + '/', { method: 'GET', headers: { Accept: 'text/html' } });
    return new URL(res.url).host;
  } catch (err) {
    return shop;
  }
}

async function check(shop) {
  const host = await storefrontHost(shop);
  const url = 'https://' + host + '/sw.js';
  const result = {
    host,
    url,
    active: false,
    customDomain: !/\.myshopify\.com$/i.test(host),
    status: null,
    detail: '',
  };

  try {
    const res = await fetchWithTimeout(url, { method: 'GET', cache: 'no-store', headers: { Accept: '*/*' } });
    result.status = res.status;
    const type = res.headers.get('content-type') || '';

    if (res.ok && res.headers.get(MARKER) === '1' && /javascript/i.test(type)) {
      result.active = true;
      result.detail = 'Your storefront serves the app\'s worker at /sw.js, so it controls every page. ' +
        'Pages a customer has visited open with no connection.';
    } else if (res.ok && res.headers.get(MARKER) !== '1') {
      result.detail = 'Something answers at /sw.js, but it is not this app\'s worker (no ' +
        'X-PWA-Root-Worker header). The storefront will not register it.';
    } else if (res.status === 404) {
      result.detail = 'Nothing is served at /sw.js yet — the store is on the stock Shopify route, where ' +
        'only the app shell works offline.';
    } else {
      result.detail = '/sw.js answered HTTP ' + res.status + '.';
    }
  } catch (err) {
    result.detail = 'Could not reach ' + url + ': ' + why(err);
  }

  return result;
}

/* --------------------------------------------------------------- snippets */

function workerSource(proxyBase) {
  return readEdge('cloudflare-worker.js')
    .replace(/const PROXY_SW_PATH = '[^']*';/, 'const PROXY_SW_PATH = ' + JSON.stringify(proxyBase + '/sw.js') + ';');
}

function snippets(proxyBase) {
  const swPath = proxyBase + '/sw.js';
  return {
    cloudflare: workerSource(proxyBase),
    nginx: readEdge('nginx.conf').split('/apps/pwa/sw.js').join(swPath),
    apache: readEdge('.htaccess').split('/apps/pwa/sw.js').join(swPath),
  };
}

/* ----------------------------------------------------------------- deploy */

function failure(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function cf(token, method, route, body) {
  const headers = { Authorization: 'Bearer ' + token };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchWithTimeout(CF_API + route, { method, headers, body: payload });
  } catch (err) {
    throw failure(502, 'Could not reach Cloudflare: ' + why(err));
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const messages = (json.errors || []).map((e) => e.message).filter(Boolean);
    const err = failure(res.status === 401 || res.status === 403 ? 400 : 502,
      'Cloudflare refused ' + method + ' ' + route.split('?')[0] + ': ' +
      (messages.join('; ') || 'HTTP ' + res.status));
    err.cfStatus = res.status;
    throw err;
  }
  return json.result;
}

/** The zone a host lives in: www.shop.co.uk may be in shop.co.uk. Tried from
 *  the full host down, so the most specific zone wins. */
async function findZone(token, host) {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    const zones = await cf(token, 'GET', '/zones?name=' + encodeURIComponent(name));
    if (zones && zones.length) return zones[0];
  }
  return null;
}

/**
 * Upload the Worker, point <host>/sw.js at it, and re-check the storefront.
 *
 * Idempotent: the script is replaced in place under one fixed name, and a
 * route that already exists is updated rather than duplicated. Running it again
 * after a settings change, or after pasting a better token, is always safe.
 */
async function deploy(shop, proxyBase, token) {
  const host = await storefrontHost(shop);
  if (/\.myshopify\.com$/i.test(host)) {
    throw failure(400, 'Your store has no custom domain — it is served at ' + host + ', which only ' +
      'Shopify controls. Connect your own domain (through Cloudflare) first.');
  }

  const zone = await findZone(token, host);
  if (!zone) {
    throw failure(400, 'No Cloudflare zone for ' + host + ' is visible to this token. Either the domain ' +
      'is not on your Cloudflare account, or the token is missing Zone › Zone › Read for it.');
  }
  const accountId = zone.account && zone.account.id;
  if (!accountId) throw failure(502, 'Cloudflare did not say which account owns ' + zone.name + '.');

  const steps = [];

  // 1. The script, as an ES module.
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: '2024-09-23',
  })], { type: 'application/json' }));
  form.append('worker.js', new Blob([workerSource(proxyBase)], { type: 'application/javascript+module' }), 'worker.js');
  await cf(token, 'PUT', '/accounts/' + accountId + '/workers/scripts/' + SCRIPT_NAME, form);
  steps.push('Uploaded the Worker "' + SCRIPT_NAME + '" to your Cloudflare account.');

  // 2. The route. Only /sw.js — nothing else on the storefront goes through it.
  const pattern = host + '/sw.js';
  const routes = await cf(token, 'GET', '/zones/' + zone.id + '/workers/routes');
  const existing = (routes || []).find((r) => r.pattern === pattern);
  if (!existing) {
    await cf(token, 'POST', '/zones/' + zone.id + '/workers/routes', { pattern, script: SCRIPT_NAME });
    steps.push('Added the route ' + pattern + '.');
  } else if (existing.script !== SCRIPT_NAME) {
    await cf(token, 'PUT', '/zones/' + zone.id + '/workers/routes/' + existing.id, { pattern, script: SCRIPT_NAME });
    steps.push('Pointed the existing route ' + pattern + ' at this Worker (it ran "' +
      (existing.script || 'nothing') + '" before).');
  } else {
    steps.push('The route ' + pattern + ' was already in place.');
  }

  // 3. Is the domain actually proxied? A route on a grey-cloud record never
  // runs. Needs DNS read, which the token may not have — so best effort only.
  const warnings = [];
  try {
    const records = await cf(token, 'GET', '/zones/' + zone.id + '/dns_records?name=' + encodeURIComponent(host));
    if (records && records.length && !records.some((r) => r.proxied)) {
      warnings.push('The DNS record for ' + host + ' is "DNS only" (grey cloud). Workers only run on ' +
        'proxied records — turn on the orange cloud for it in Cloudflare › DNS.');
    }
  } catch (err) {
    // No DNS permission: say nothing rather than guess.
  }

  return { host, zone: zone.name, steps, warnings, check: await check(shop) };
}

module.exports = { check, snippets, deploy, SCRIPT_NAME };
