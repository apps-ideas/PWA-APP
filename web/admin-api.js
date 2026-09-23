/**
 * The GraphQL Admin API client, and the two things this app asks it for.
 *
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------------------
 * For a long time it did not. The app served a manifest through a proxy and
 * injected a link tag through a theme app embed, and neither of those needs an
 * access token — so the app requested no scopes and stored none. That is a
 * rejection under App Store requirement 2.2.1: an app that needs no Shopify API
 * is not permitted, however well it works.
 *
 * The fix is not a token acquired to satisfy a checkbox. Two things this app
 * genuinely could not do before are now done here:
 *
 *   1. themeEmbedStatus() reads the published theme's settings and reports
 *      whether the Storefront PWA app embed is actually switched on. Until now
 *      the admin could only tell the merchant to go and look, because nothing
 *      the app served could see the theme. Every setting below that switch is
 *      inert while it is off, which made it the single most common support
 *      question this app has.
 *
 *   2. shopProfile() reads the store's real name and primary domain, so a new
 *      install prefills the manifest with "Fifth Avenue Bikes" and that store's
 *      own URL instead of the myshopify subdomain, which is what the app had to
 *      guess from before.
 *
 * AUTHENTICATION
 * ------------------------------------------------------------------
 * Token exchange, not the authorization code grant: the embedded admin already
 * holds a fresh App Bridge ID token on every request, and exchanging it for an
 * access token costs one round trip and no redirects. See web/oauth.js for the
 * authorization code grant, which covers installs that do not start inside the
 * admin.
 *
 * Access tokens are cached in memory and never written to disk. This app makes
 * no API call outside an interactive admin request, so there is no background
 * job that would need a token when no merchant is present — which is the only
 * reason to persist one, and the only reason to handle refresh token rotation.
 * A restart re-exchanges on the next request and nobody notices.
 */

const fs = require('fs');
const path = require('path');

const auth = require('./auth.js');

/** Matches the webhook api_version in shopify.app.toml — keep the two together. */
const API_VERSION = '2026-07';

const TOKEN_URL = (shop) => 'https://' + shop + '/admin/oauth/access_token';
const GRAPHQL_URL = (shop) => 'https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json';

/** Shopify's own timeout is far longer than anything an admin screen should
 *  wait on. A merchant staring at a spinner is worse than a stale answer. */
const REQUEST_TIMEOUT_MS = 10000;

/** Re-exchange a minute early rather than discover expiry mid-request. */
const EXPIRY_SKEW_MS = 60000;

/** shop -> { token, expiresAt }. Deliberately not persisted; see the header. */
const tokenCache = new Map();

/**
 * The theme app embed this app ships, as it appears in a theme's settings.
 *
 * A merchant's settings_data.json names an embed by
 * `shopify://apps/<app-handle>/blocks/<block-file>/<extension-uid>`, so
 * recognising our own block needs the block file name plus one of the two ids.
 * The uid is read from the extension's own TOML rather than copied here,
 * because the CLI rewrites it and a stale copy would silently report every
 * correctly configured store as misconfigured.
 */
const BLOCK_FILE = 'pwa';
const APP_HANDLE = 'storefront-pwa';
const EXTENSION_UID = readExtensionUid();

function readExtensionUid() {
  const toml = path.join(__dirname, '..', 'extensions', 'storefront-pwa', 'shopify.extension.toml');
  try {
    const match = /^\s*uid\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(toml, 'utf8'));
    return match ? match[1] : null;
  } catch (err) {
    // Not fatal: the app handle alone still identifies the block, and a missing
    // extension TOML means someone is running the backend on its own.
    console.warn('[pwa] could not read the extension uid:', err.message);
    return null;
  }
}

/**
 * An Admin API failure that the route layer can turn into a response.
 *
 * `retrySession` is the one case worth distinguishing: an ID token that Shopify
 * rejects is a routine client condition, not a server fault — they live about a
 * minute. The admin surface answers it with a 401 and the
 * X-Shopify-Retry-Invalid-Session-Request header, which makes App Bridge fetch
 * a fresh token and replay the request once. A 502 would tell it the opposite.
 */
class AdminApiError extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'AdminApiError';
    this.status = (options && options.status) || 502;
    this.retrySession = Boolean(options && options.retrySession);
  }
}

function postForm(url, params) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Exchange an App Bridge ID token for an expiring offline access token.
 *
 * `expiring: '1'` is not optional for a new public app — non-expiring offline
 * tokens are refused for GraphQL Admin API requests.
 */
async function exchangeIdToken(shop, idToken) {
  if (!auth.API_KEY || !auth.API_SECRET) {
    throw new AdminApiError('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must both be set.', { status: 500 });
  }

  let response;
  try {
    response = await postForm(TOKEN_URL(shop), {
      client_id: auth.API_KEY,
      client_secret: auth.API_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
  } catch (err) {
    throw new AdminApiError('Could not reach Shopify to authenticate: ' + err.message);
  }

  // 400 here means the ID token is expired or malformed. Ask for a fresh one
  // rather than reporting a server fault.
  if (response.status === 400) {
    throw new AdminApiError('The session token was rejected.', { status: 401, retrySession: true });
  }

  if (!response.ok) {
    throw new AdminApiError('Token exchange failed with HTTP ' + response.status + '.');
  }

  const body = await response.json().catch(() => ({}));
  if (!body.access_token) {
    throw new AdminApiError('Token exchange returned no access token.');
  }

  // Trust expires_in over any hard-coded lifetime, per Shopify's guidance.
  const lifetimeMs = (Number(body.expires_in) || 3600) * 1000;
  return { token: body.access_token, expiresAt: Date.now() + lifetimeMs - EXPIRY_SKEW_MS };
}

async function accessTokenFor(shop, idToken) {
  const cached = tokenCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const fresh = await exchangeIdToken(shop, idToken);
  tokenCache.set(shop, fresh);
  return fresh.token;
}

/**
 * Cache a token obtained somewhere other than token exchange.
 *
 * Only web/oauth.js calls this, with the token from the authorization code
 * grant, so that the first screen after an install does not immediately
 * re-authenticate against a cache that knows nothing yet.
 */
function remember(shop, token, expiresInSeconds) {
  if (!token) return;
  const lifetimeMs = (Number(expiresInSeconds) || 3600) * 1000;
  tokenCache.set(shop, { token, expiresAt: Date.now() + lifetimeMs - EXPIRY_SKEW_MS });
}

/** Called on app/uninstalled. A token for a store that removed the app is not
 *  something to keep sitting in memory until it happens to expire. */
function forget(shop) {
  tokenCache.delete(shop);
}

/**
 * Run a GraphQL query, retrying once without the cached token on a 401.
 *
 * The retry matters because a token can be revoked — by an uninstall, a scope
 * change, or a secret rotation — long before the expiry we cached alongside it.
 */
async function graphql(shop, idToken, query, variables) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessTokenFor(shop, idToken);

    let response;
    try {
      response = await fetch(GRAPHQL_URL(shop), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables: variables || {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AdminApiError('Could not reach the Shopify Admin API: ' + err.message);
    }

    if (response.status === 401 && attempt === 0) {
      tokenCache.delete(shop);
      continue;
    }

    if (response.status === 401) {
      throw new AdminApiError('Shopify rejected the access token.', { status: 401, retrySession: true });
    }

    if (!response.ok) {
      throw new AdminApiError('The Shopify Admin API returned HTTP ' + response.status + '.');
    }

    const body = await response.json().catch(() => ({}));

    // A GraphQL error arrives with HTTP 200, so the status check above proves
    // nothing on its own.
    if (Array.isArray(body.errors) && body.errors.length) {
      const first = body.errors[0] || {};
      throw new AdminApiError('Shopify Admin API error: ' + (first.message || 'unknown'));
    }

    return body.data || {};
  }

  /* Unreachable: the loop either returns or throws. */
  throw new AdminApiError('Token exchange did not settle.');
}

/* --------------------------------------------------------------- the queries */

const SHOP_PROFILE_QUERY = `
  query PwaShopProfile {
    shop {
      name
      myshopifyDomain
      primaryDomain { url host }
    }
  }
`;

const THEME_EMBED_QUERY = `
  query PwaThemeEmbed {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        name
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes {
            body {
              ... on OnlineStoreThemeFileBodyText { content }
            }
          }
        }
      }
    }
  }
`;

/**
 * The store's real name and storefront URL.
 *
 * Needs no access scope beyond a valid token — shop identity is readable by any
 * installed app — which is why this is the prefill source rather than something
 * the merchant has to type.
 */
async function shopProfile(shop, idToken) {
  const data = await graphql(shop, idToken, SHOP_PROFILE_QUERY);
  const info = data.shop || {};
  const domain = info.primaryDomain || {};
  return {
    name: info.name || null,
    myshopifyDomain: info.myshopifyDomain || shop,
    primaryUrl: domain.url || null,
    primaryHost: domain.host || null,
  };
}

/**
 * Whether a settings_data.json block entry is this app's embed.
 *
 * Matching on the block file name alone would claim any other app's block that
 * happens to be called "pwa", so the app handle or the extension uid has to
 * agree as well.
 */
function isOurEmbed(type) {
  const match = /^shopify:\/\/apps\/([^/]+)\/blocks\/([^/]+)\/(.+)$/.exec(String(type || ''));
  if (!match) return false;

  const [, appHandle, blockFile, uid] = match;
  if (blockFile !== BLOCK_FILE) return false;
  return appHandle === APP_HANDLE || (Boolean(EXTENSION_UID) && uid === EXTENSION_UID);
}

/**
 * The blocks a theme's settings_data.json has enabled.
 *
 * `current` is usually the live settings object, but a theme that has never
 * been customised leaves it as the name of a preset instead, and the blocks
 * then live under that preset. Reading only the object form reports a perfectly
 * configured store as switched off, so both shapes are handled.
 */
function blocksFrom(settingsData) {
  const current = settingsData && settingsData.current;
  if (current && typeof current === 'object') return current.blocks || {};

  if (typeof current === 'string') {
    const presets = (settingsData && settingsData.presets) || {};
    const preset = presets[current];
    if (preset && typeof preset === 'object') return preset.blocks || {};
  }

  return {};
}

/**
 * Report whether the app embed is switched on in the published theme.
 *
 * The three outcomes are deliberately distinct. "missing" means the merchant
 * has never added the embed; "disabled" means they added it and then turned it
 * off, which is a different conversation; and an `unknown` result means the app
 * could not tell, which must never be rendered as "off" — telling a merchant
 * their working setup is broken is worse than saying nothing.
 */
async function themeEmbedStatus(shop, idToken) {
  const data = await graphql(shop, idToken, THEME_EMBED_QUERY);

  const theme = ((data.themes || {}).nodes || [])[0];
  if (!theme) return { state: 'unknown', reason: 'No published theme was returned.' };

  const file = ((theme.files || {}).nodes || [])[0];
  const content = file && file.body && file.body.content;
  if (!content) {
    return { state: 'unknown', theme: theme.name, reason: 'The theme has no readable settings file.' };
  }

  let settingsData;
  try {
    settingsData = JSON.parse(content);
  } catch (err) {
    return { state: 'unknown', theme: theme.name, reason: 'The theme settings file is not valid JSON.' };
  }

  const blocks = blocksFrom(settingsData);
  for (const key of Object.keys(blocks)) {
    const block = blocks[key] || {};
    if (!isOurEmbed(block.type)) continue;
    // `disabled` is absent on an enabled block rather than set to false.
    return { state: block.disabled === true ? 'disabled' : 'enabled', theme: theme.name };
  }

  return { state: 'missing', theme: theme.name };
}

module.exports = {
  API_VERSION,
  AdminApiError,
  forget,
  graphql,
  remember,
  shopProfile,
  themeEmbedStatus,
};
