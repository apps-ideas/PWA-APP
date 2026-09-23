/**
 * The authorization code grant.
 *
 * shopify.app.toml has always declared https://pwa.gaapps.cloud/api/auth as
 * this app's redirect URL, and nothing has ever answered there — the app
 * authenticated with session tokens alone and had no scopes to grant, so the
 * route was never built and a request to it returned 404. That is a rejection
 * under App Store requirements 2.3.2 and 2.3.3: install must authenticate
 * through OAuth and then land the merchant in the app UI, not on an error.
 *
 * Most installs never come through here. Shopify-managed installation shows the
 * grant screen itself and drops the merchant straight into the embedded admin,
 * where web/admin-api.js exchanges the App Bridge ID token for an access token.
 * This file covers everything that path does not: an install that starts
 * outside the admin, a merchant who opens the install link directly, and any
 * review of the documented redirect URL.
 *
 * STATE IS SIGNED, NOT STORED
 * ------------------------------------------------------------------
 * The usual CSRF nonce goes in a cookie and is compared on the way back. This
 * app puts the shop and a timestamp in the `state` parameter and signs the pair
 * with the app secret instead, so the callback can verify it without a cookie,
 * a session or a store. Requirement 1.1.1 asks that the app work with
 * third-party cookies blocked; the simplest way to keep that promise is to have
 * no cookie to block.
 */

const crypto = require('crypto');

const auth = require('./auth.js');
const adminApi = require('./admin-api.js');
const settingsStore = require('./settings.js');

/**
 * The access scopes this app needs, and the reason for each one.
 *
 *   read_themes  web/admin-api.js reads config/settings_data.json from the
 *                published theme to report whether the app embed is switched
 *                on. Nothing this app serves has any effect until it is, so
 *                without this the admin can only tell a merchant to go and look.
 *
 * Must match `scopes` in shopify.app.toml. Shopify grants what the TOML says;
 * a mismatch here only changes what the authorize screen asks for, which is a
 * confusing way to fail.
 */
const SCOPES = 'read_themes';

/** Long enough for a slow grant screen, short enough that a leaked URL is
 *  worthless by the time anyone finds it. */
const STATE_TTL_MS = 10 * 60 * 1000;

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload) {
  return base64Url(crypto.createHmac('sha256', auth.API_SECRET).update(payload).digest());
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeState(shop) {
  const payload = base64Url(JSON.stringify({
    shop,
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  }));
  return payload + '.' + sign(payload);
}

/** Returns the shop the state was minted for, or null. */
function readState(state) {
  const [payload, signature] = String(state || '').split('.');
  if (!payload || !signature) return null;
  if (!safeEqual(sign(payload), signature)) return null;

  let claims;
  try {
    claims = JSON.parse(fromBase64Url(payload).toString('utf8'));
  } catch (err) {
    return null;
  }

  if (typeof claims.ts !== 'number' || Date.now() - claims.ts > STATE_TTL_MS) return null;
  if (!settingsStore.isValidShop(claims.shop)) return null;

  return claims.shop;
}

/**
 * Verify the `hmac` Shopify appends to the callback.
 *
 * Signed over every other query parameter, sorted, joined with & — a different
 * encoding from the app proxy signature, which is why auth.js cannot be reused
 * here.
 */
function verifyCallbackHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(',') : rest[key];
      return key + '=' + value;
    })
    .join('&');

  const digest = crypto.createHmac('sha256', auth.API_SECRET).update(message).digest('hex');
  return safeEqual(digest, hmac);
}

/**
 * Where a merchant goes once the grant is complete.
 *
 * The embedded app's home inside the admin, which is what requirement 2.3.3
 * asks for — not this backend's own URL, which outside an iframe is a bare
 * settings page with no admin around it.
 */
function appHomeFor(shop, appHandle) {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, '');
  return 'https://admin.shopify.com/store/' + encodeURIComponent(storeHandle) +
    '/apps/' + encodeURIComponent(appHandle);
}

/**
 * Mount /api/auth and /api/auth/callback.
 *
 * `appHandle` is the handle from shopify.app.toml — it decides the admin URL
 * the merchant lands on, and getting it wrong sends them to a 404 inside the
 * admin rather than to this app.
 */
function mount(app, options) {
  const appHandle = (options && options.appHandle) || 'storefront-pwa';
  const appUrl = String((options && options.appUrl) || '').replace(/\/$/, '');
  const redirectUri = appUrl + '/api/auth/callback';

  /** Step 1: send the merchant to Shopify's grant screen. */
  app.get('/api/auth', (req, res) => {
    if (!auth.API_KEY || !auth.API_SECRET) {
      return res.status(500).type('text/plain')
        .send('This app is not configured: SHOPIFY_API_KEY and SHOPIFY_API_SECRET are not both set.\n');
    }

    const shop = String(req.query.shop || '').toLowerCase();
    if (!settingsStore.isValidShop(shop)) {
      // Requirement 2.3.1 forbids asking a merchant to type their shop domain,
      // so this is a plain explanation rather than a form.
      return res.status(400).type('text/plain').send(
        'Install this app from the Shopify App Store or your Partner dashboard.\n' +
        'Opening this URL directly has no store attached to it.\n'
      );
    }

    const authorizeUrl = 'https://' + shop + '/admin/oauth/authorize' +
      '?client_id=' + encodeURIComponent(auth.API_KEY) +
      '&scope=' + encodeURIComponent(SCOPES) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&state=' + encodeURIComponent(makeState(shop));

    res.set('Cache-Control', 'no-store');
    return res.redirect(302, authorizeUrl);
  });

  /** Step 2: trade the code for a token, then land in the app UI. */
  app.get('/api/auth/callback', async (req, res) => {
    if (!auth.API_SECRET) {
      return res.status(500).type('text/plain').send('SHOPIFY_API_SECRET is not set.\n');
    }

    if (!verifyCallbackHmac(req.query)) {
      return res.status(400).type('text/plain').send('This request did not come from Shopify.\n');
    }

    const shop = String(req.query.shop || '').toLowerCase();
    const stateShop = readState(req.query.state);

    // The state must be ours, unexpired, and minted for this same shop — the
    // last check is what stops a grant for one store being replayed against
    // another.
    if (!stateShop || !settingsStore.isValidShop(shop) || stateShop !== shop) {
      return res.status(400).type('text/plain').send('This authorization request has expired. Please install again.\n');
    }

    const code = String(req.query.code || '');
    if (!code) {
      return res.status(400).type('text/plain').send('Shopify did not return an authorization code.\n');
    }

    try {
      const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: auth.API_KEY,
          client_secret: auth.API_SECRET,
          code,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        console.error('oauth: token request for ' + shop + ' returned HTTP ' + response.status);
        return res.status(502).type('text/plain').send('Shopify refused the authorization code. Please install again.\n');
      }

      const body = await response.json().catch(() => ({}));
      if (!body.access_token) {
        return res.status(502).type('text/plain').send('Shopify returned no access token. Please install again.\n');
      }

      // Seed the same in-memory cache the embedded admin uses, so the first
      // screen after install does not immediately re-authenticate.
      adminApi.remember(shop, body.access_token, body.expires_in);

      // Make sure the shop has settings on disk before its first screen. A
      // brand-new install otherwise renders defaults that nothing has saved,
      // and the manifest would 404 nothing but still look unconfigured.
      settingsStore.read(shop);
    } catch (err) {
      console.error('oauth: token exchange for ' + shop + ' failed:', err.message);
      return res.status(502).type('text/plain').send('Could not complete the installation. Please try again.\n');
    }

    res.set('Cache-Control', 'no-store');
    return res.redirect(302, appHomeFor(shop, appHandle));
  });
}

module.exports = { SCOPES, mount };
