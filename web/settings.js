/**
 * Per-shop settings store.
 *
 * One JSON file per shop under DATA_DIR/shops/. No database on purpose: this
 * app stores a few dozen fields for a handful of storefronts, the values are
 * read once per manifest request and written only when a merchant clicks Save.
 * A JSON file gives us atomic replace, zero native dependencies and a store a
 * human can read during an incident.
 *
 * Writes go to a temp file and are renamed over the target, so a crash mid-save
 * leaves the previous settings intact rather than a truncated file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SHOPS_DIR = path.join(DATA_DIR, 'shops');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');

fs.mkdirSync(SHOPS_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

/**
 * Shop domains reach us from query strings and JWT claims and are then used to
 * build file paths. Validate hard rather than sanitising: anything that is not
 * a real myshopify domain is a bug or an attack, and both deserve a rejection.
 */
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function isValidShop(shop) {
  return typeof shop === 'string' && shop.length <= 120 && SHOP_PATTERN.test(shop);
}

function shopFile(shop) {
  // Safe because isValidShop has already rejected anything with a slash or a
  // dot segment, but keep basename as a second line of defence — everything
  // below turns a shop domain into a filesystem path.
  return path.join(SHOPS_DIR, path.basename(shop.toLowerCase()) + '.json');
}

function assetDir(shop) {
  return path.join(ASSETS_DIR, path.basename(shop.toLowerCase()));
}

/** The three uploadable images, and what each one is for. */
const ASSET_KINDS = ['icon', 'screenshotWide', 'screenshotNarrow'];

function emptyAsset() {
  return { present: false, rev: null, width: 0, height: 0, type: null };
}

/**
 * Defaults are deliberately installable on their own. A merchant who enables
 * the app embed and uploads nothing still gets a valid manifest and a generated
 * placeholder icon, so the store is installable before anyone opens the admin.
 * Nothing here may be blank in a way that produces an invalid manifest.
 */
function defaults(shop) {
  const handle = shop ? shop.replace(/\.myshopify\.com$/i, '') : 'store';
  return {
    version: 1,
    shop: shop || null,
    updatedAt: null,

    // Master switch, separate from the theme app embed on purpose. The embed
    // decides whether the tags are in the page at all, which is a theme change
    // and needs the theme editor. This is the one a merchant can flip in two
    // seconds when something looks wrong on a live store — it leaves the embed
    // alone and makes the manifest non-installable instead.
    enabled: true,

    // Manifest identity
    name: handle,
    shortName: handle.slice(0, 12),
    description: '',
    lang: 'en',
    dir: 'auto',
    categories: ['shopping'],

    // Manifest behaviour
    startUrl: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    themeColor: '#111111',
    backgroundColor: '#ffffff',

    // Up to 4 app shortcuts (long-press or right-click the installed icon)
    shortcuts: [],

    // Uploaded images, all optional. `rev` is a content hash that busts the
    // browser cache for every derived render of that asset at once.
    //
    // Chrome shows a richer install dialog when the manifest carries a
    // screenshot: `screenshotWide` drives the desktop dialog, `screenshotNarrow`
    // the Android one. Dimensions are measured at upload rather than typed by
    // the merchant, because a `sizes` value that disagrees with the real image
    // makes Chrome drop the screenshot without saying why.
    assets: {
      icon: emptyAsset(),
      screenshotWide: emptyAsset(),
      screenshotNarrow: emptyAsset(),
    },

    // Bumped only by the admin's "Force a refresh" button, and folded into
    // renderRev so that pressing it moves every icon and splash URL.
    //
    // It exists because the other inputs to renderRev are all things a merchant
    // might not want to change. The renders are served immutable for a year, so
    // without a value that can be moved on demand there is no way to flush a
    // render that is stale for some reason we did not anticipate — a half-
    // written file, a sharp upgrade that draws differently. A counter is the
    // whole fix.
    renderVersion: 1,

    // iOS: Safari ignores most of the manifest before 16.4, and even now it
    // prefers apple-touch-icon and its own startup images.
    ios: { splash: true, statusBarStyle: 'default' },

    install: {
      enabled: true,
      delaySeconds: 8,
      position: 'bottom-right',
      title: 'Install our app',
      body: 'Add the store to your home screen for a faster, full-screen experience.',
      buttonLabel: 'Install',
      dismissDays: 14,
    },

    // On by default. It was dormant while its only possible scope was a
    // directory nothing ever visited; now the app launches inside that
    // directory, so the worker earns its keep by making a cold offline launch
    // land on the shell instead of a browser error. It still cannot touch the
    // catalogue — see "Service worker" in the README.
    serviceWorker: { enabled: true, offlinePage: true, cacheVersion: 1 },
  };
}

function mergeAssets(base, stored) {
  const out = {};
  for (const kind of ASSET_KINDS) {
    out[kind] = { ...base[kind], ...((stored && stored[kind]) || {}) };
  }
  return out;
}

function read(shop) {
  if (!isValidShop(shop)) return defaults(null);

  let raw;
  try {
    raw = fs.readFileSync(shopFile(shop), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('settings read failed for ' + shop + ':', err.message);
    return defaults(shop);
  }

  try {
    // Merge over defaults so a file written by an older version of this app can
    // never hand an undefined field to the manifest builder.
    const stored = JSON.parse(raw);
    const base = defaults(shop);
    return {
      ...base,
      ...stored,
      assets: mergeAssets(base.assets, stored.assets),
      ios: { ...base.ios, ...(stored.ios || {}) },
      install: { ...base.install, ...(stored.install || {}) },
      serviceWorker: { ...base.serviceWorker, ...(stored.serviceWorker || {}) },
      shop,
    };
  } catch (err) {
    console.error('settings for ' + shop + ' are not valid JSON — using defaults:', err.message);
    return defaults(shop);
  }
}

function write(shop, settings) {
  if (!isValidShop(shop)) throw new Error('invalid shop');
  const payload = { ...settings, shop, updatedAt: new Date().toISOString() };
  const target = shopFile(shop);
  const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return payload;
}

/** Called on app/uninstalled. Leaving a merchant's logo on disk after they
 *  remove the app is not something to be casual about. */
function remove(shop) {
  if (!isValidShop(shop)) return;
  for (const [label, fn] of [
    ['settings', () => fs.rmSync(shopFile(shop), { force: true })],
    ['assets', () => fs.rmSync(assetDir(shop), { recursive: true, force: true })],
  ]) {
    try {
      fn();
    } catch (err) {
      console.error(label + ' delete failed for ' + shop + ':', err.message);
    }
  }
}

module.exports = {
  ASSET_KINDS,
  ASSETS_DIR,
  DATA_DIR,
  assetDir,
  defaults,
  isValidShop,
  read,
  remove,
  write,
};
