/**
 * The three separate things Shopify asks an app to verify, and nothing else.
 *
 *   1. Session tokens  — App Bridge hands the embedded admin a short-lived JWT
 *                        signed with the app secret. This is what authorises a
 *                        settings write, and it is why the app needs no OAuth
 *                        flow and no stored access token.
 *   2. Proxy signature — storefront requests forwarded through /apps/pwa.
 *   3. Webhook HMAC    — app/uninstalled, so we can delete the merchant's data.
 *
 * All three are HMAC-SHA256 with SHOPIFY_API_SECRET; they differ only in what
 * is signed and how the digest is encoded.
 */

const crypto = require('crypto');

const API_KEY = process.env.SHOPIFY_API_KEY || '';
const API_SECRET = process.env.SHOPIFY_API_SECRET || '';

const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/** Constant-time compare that does not leak length through an exception. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function base64UrlDecode(segment) {
  return Buffer.from(String(segment).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify an App Bridge session token and return the shop domain it belongs to,
 * or null.
 *
 * Checked: the HS256 signature, `aud` against our own client ID (so a token
 * minted for a different app is not accepted), `exp`/`nbf` with a small skew
 * allowance, and that `dest` names a real myshopify domain. `dest` is the
 * authoritative shop — never trust a shop passed alongside the token in a query
 * string or body, or one merchant could write another's settings.
 */
function verifySessionToken(token) {
  if (!API_SECRET || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;

  const expected = crypto
    .createHmac('sha256', API_SECRET)
    .update(header + '.' + payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (!safeEqual(expected, signature)) return null;

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString('utf8'));
  } catch (err) {
    return null;
  }

  // 10 seconds of clock skew. Session tokens live about a minute, so anything
  // more generous starts to matter.
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + 10 < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - 10 > now) return null;

  if (API_KEY && claims.aud !== API_KEY) return null;

  let shop;
  try {
    shop = new URL(claims.dest).hostname.toLowerCase();
  } catch (err) {
    return null;
  }
  if (!SHOP_PATTERN.test(shop)) return null;

  return shop;
}

/**
 * Express middleware for the admin API. Populates req.shop.
 *
 * The token arrives as `Authorization: Bearer <jwt>`, which App Bridge refreshes
 * for every request — there is no session to keep and nothing to store.
 */
function requireSession(req, res, next) {
  if (!API_SECRET) {
    return res.status(500).json({
      error: 'SHOPIFY_API_SECRET is not set, so session tokens cannot be verified. Settings are read-only.',
    });
  }

  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const shop = verifySessionToken(token);

  if (!shop) return res.status(401).json({ error: 'Invalid or expired session token' });

  req.shop = shop;
  return next();
}

/**
 * Verify a Shopify app proxy request. Shopify appends `signature`: a hex
 * HMAC-SHA256 over the sorted query parameters, with no separators.
 *
 * Off by default — see PWA_VERIFY_PROXY in .env.example for why.
 */
function verifyProxySignature(req) {
  if (!API_SECRET) return false;

  const { signature, ...params } = req.query;
  if (!signature) return false;

  const message = Object.keys(params)
    .sort()
    .map((k) => k + '=' + (Array.isArray(params[k]) ? params[k].join(',') : params[k]))
    .join('');

  const digest = crypto.createHmac('sha256', API_SECRET).update(message).digest('hex');
  return safeEqual(digest, signature);
}

/** Verify a webhook against the raw request body. `body` must be a Buffer. */
function verifyWebhook(body, hmacHeader) {
  if (!API_SECRET || !hmacHeader || !Buffer.isBuffer(body)) return false;
  const digest = crypto.createHmac('sha256', API_SECRET).update(body).digest('base64');
  return safeEqual(digest, hmacHeader);
}

module.exports = {
  API_KEY,
  API_SECRET,
  SHOP_PATTERN,
  requireSession,
  verifyProxySignature,
  verifySessionToken,
  verifyWebhook,
};
