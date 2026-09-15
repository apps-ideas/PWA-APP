/**
 * Icon, screenshot and iOS splash rendering.
 *
 * A merchant uploads one square logo. Everything a manifest needs is derived
 * from it on first request and cached on disk, keyed by `renderRev` — a hash of
 * the upload *and* the settings that affect rendering — so a re-upload or a
 * colour change invalidates every derivative at once, URLs included.
 *
 * Only sizes on the allow-lists below are ever rendered. The render routes are
 * public (they are reached through the app proxy, where a signature cannot be
 * relied on), and an attacker who could ask for arbitrary dimensions would have
 * a cheap way to burn CPU and fill the disk.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { assetDir } = require('./settings.js');

/** Square icon sizes we are willing to render. */
const ICON_SIZES = [48, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512, 1024];

/**
 * The manifest advertises only these. 192 and 512 are what Chrome actually
 * requires; the maskable pair is what stops Android from drawing a white
 * rounded rectangle around the logo on the home screen.
 */
const MANIFEST_ICON_SIZES = [192, 512];

/**
 * How much of a maskable canvas the logo may occupy.
 *
 * The maskable safe zone is a circle covering 80% of the icon's width. A square
 * logo only fits inside that circle at 0.8 / sqrt(2) = 0.566 of the width, but
 * real logos are rarely square to their bounding box and 0.57 looks lost, so
 * 0.64 is the usual compromise: safe under a circular mask for anything with a
 * little natural padding, and still legible.
 */
const MASKABLE_SCALE = 0.64;

/**
 * iOS startup images. Safari matches these by exact media query, so the table
 * is CSS dimensions plus device pixel ratio rather than raw pixels.
 *
 * Portrait only for phones: a customer browsing a store in landscape on a phone
 * is rare, and each extra entry is another <link> in the <head> of every page.
 * Tablets get both, where landscape is normal.
 */
const IOS_DEVICES = [
  { w: 375, h: 667, dpr: 2, label: 'iPhone SE / 8', landscape: false },
  { w: 414, h: 736, dpr: 3, label: 'iPhone 8 Plus', landscape: false },
  { w: 375, h: 812, dpr: 3, label: 'iPhone X / XS / 11 Pro', landscape: false },
  { w: 414, h: 896, dpr: 2, label: 'iPhone XR / 11', landscape: false },
  { w: 414, h: 896, dpr: 3, label: 'iPhone XS Max / 11 Pro Max', landscape: false },
  { w: 390, h: 844, dpr: 3, label: 'iPhone 12 / 13 / 14', landscape: false },
  { w: 428, h: 926, dpr: 3, label: 'iPhone 12-14 Pro Max', landscape: false },
  { w: 393, h: 852, dpr: 3, label: 'iPhone 14 Pro / 15 / 16', landscape: false },
  { w: 430, h: 932, dpr: 3, label: 'iPhone 15 Plus / 16 Plus', landscape: false },
  { w: 402, h: 874, dpr: 3, label: 'iPhone 16 Pro', landscape: false },
  { w: 440, h: 956, dpr: 3, label: 'iPhone 16 Pro Max', landscape: false },
  { w: 810, h: 1080, dpr: 2, label: 'iPad 10.2', landscape: true },
  { w: 820, h: 1180, dpr: 2, label: 'iPad Air 10.9', landscape: true },
  { w: 834, h: 1194, dpr: 2, label: 'iPad Pro 11', landscape: true },
  { w: 1024, h: 1366, dpr: 2, label: 'iPad Pro 12.9', landscape: true },
];

/** Every splash size we will render, as "WxH" in device pixels. */
const SPLASH_SIZES = new Set(
  IOS_DEVICES.flatMap((d) => {
    const px = [d.w * d.dpr + 'x' + d.h * d.dpr];
    if (d.landscape) px.push(d.h * d.dpr + 'x' + d.w * d.dpr);
    return px;
  })
);

const MIN_ICON_EDGE = 512;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** What sharp is allowed to decode. SVG is excluded deliberately: librsvg will
 *  follow external references, and this is an unauthenticated-ish upload. */
const ACCEPTED_FORMATS = ['png', 'jpeg', 'jpg', 'webp', 'avif', 'gif', 'tiff'];

function derivedDir(shop) {
  return path.join(assetDir(shop), 'derived');
}

/**
 * The cache key for everything derived from the icon.
 *
 * Not just the uploaded file's hash: the maskable icons are padded with the
 * background colour, the splash screens are drawn on it, and the placeholder
 * icon is drawn from the theme colour and the store's initial. All of those are
 * settings, not pixels. Keying on the upload alone would leave a merchant who
 * changes their background colour serving last month's renders out of a
 * year-long immutable cache, with no way to flush it.
 */
function renderRev(settings) {
  const icon = settings.assets.icon;
  const seed = [
    icon.rev || 'placeholder',
    settings.themeColor,
    settings.backgroundColor,
    // Only the placeholder depends on the name, but including it always is
    // cheaper than reasoning about when it matters.
    (settings.shortName || settings.name || '?').trim().charAt(0).toUpperCase(),
    // The manual escape hatch. Nothing reads it but this hash — it is here so
    // that "Force a refresh" in the admin can move every derived URL without
    // the merchant having to change a colour they are happy with.
    settings.renderVersion || 1,
  ].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/** Drops every derived render. Cheap: they are all regenerated on demand. */
function clearDerived(shop) {
  try {
    fs.rmSync(derivedDir(shop), { recursive: true, force: true });
  } catch (err) {
    console.error('could not clear derived images for ' + shop + ':', err.message);
  }
}

function sourcePath(shop, kind) {
  return path.join(assetDir(shop), kind + '.src.png');
}

/**
 * Write to a temp file and rename, so a reader never sees a half-written PNG.
 * Two requests racing to render the same derivative both win; the rename is
 * atomic and the bytes are identical.
 */
function writeAtomic(target, buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
}

async function cached(target, produce) {
  try {
    return fs.readFileSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const buffer = await produce();
  writeAtomic(target, buffer);
  return buffer;
}

/**
 * Validate and store an upload. Returns the metadata the settings store keeps.
 *
 * Everything is re-encoded to PNG rather than stored as received: it normalises
 * the derivative pipeline, and re-encoding through sharp discards any EXIF,
 * colour profile or trailing payload that came in with the original file.
 */
async function saveUpload(shop, kind, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('No image data was received'), { status: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('Image is larger than 8 MB'), { status: 413 });
  }

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50e6 }).metadata();
  } catch (err) {
    throw Object.assign(new Error('That file is not an image sharp can read'), { status: 400 });
  }

  if (!ACCEPTED_FORMATS.includes(meta.format)) {
    throw Object.assign(new Error('Unsupported image format: ' + meta.format), { status: 400 });
  }

  const width = meta.width || 0;
  const height = meta.height || 0;

  if (kind === 'icon') {
    if (Math.min(width, height) < MIN_ICON_EDGE) {
      throw Object.assign(
        new Error('The icon must be at least ' + MIN_ICON_EDGE + 'x' + MIN_ICON_EDGE + ' pixels. Yours is ' + width + 'x' + height + '.'),
        { status: 400 }
      );
    }
    // A non-square logo is not fatal — it is centre-cropped below — but it
    // will lose its ends, so `squareish` goes back to the caller to warn about.
  }

  const normalised = await sharp(buffer, { limitInputPixels: 50e6 })
    .rotate() // apply EXIF orientation before we strip it
    .png({ compressionLevel: 9 })
    .toBuffer();

  const rev = crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 12);

  fs.mkdirSync(assetDir(shop), { recursive: true });
  writeAtomic(sourcePath(shop, kind), normalised);

  // Old derivatives are keyed by the previous rev, so they are unreachable the
  // moment settings are saved. Delete them anyway: nothing else ever will.
  clearDerived(shop);

  return {
    present: true,
    rev,
    width,
    height,
    type: 'image/png',
    squareish: Math.abs(width - height) / Math.max(width, height) <= 0.02,
  };
}

function removeUpload(shop, kind) {
  try {
    fs.rmSync(sourcePath(shop, kind), { force: true });
  } catch (err) {
    console.error('could not remove ' + kind + ' for ' + shop + ':', err.message);
  }
  clearDerived(shop);
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * The icon a store gets before anyone uploads a logo: its initial on the theme
 * colour. It exists so that enabling the app embed is enough to make the store
 * installable — an icon-less manifest is rejected by Chrome, and "install is
 * broken until you visit the admin" is a worse first run than a plain letter.
 */
function placeholderSvg(settings, size) {
  const letter = (settings.shortName || settings.name || '?').trim().charAt(0).toUpperCase() || '?';
  const fg = settings.backgroundColor || '#ffffff';
  const bg = settings.themeColor || '#111111';
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
      '<rect width="' + size + '" height="' + size + '" fill="' + escapeXml(bg) + '"/>' +
      '<text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="' + escapeXml(fg) + '" ' +
      'font-family="Helvetica,Arial,sans-serif" font-weight="600" ' +
      'font-size="' + Math.round(size * 0.52) + '">' + escapeXml(letter) + '</text>' +
      '</svg>'
  );
}

async function baseIcon(shop, settings, size) {
  const asset = settings.assets.icon;
  if (!asset.present) {
    return sharp(placeholderSvg(settings, size)).png().toBuffer();
  }
  // `cover` centre-crops, which is right for a logo that is not quite square:
  // squashing it to fit would be worse than trimming a few pixels of margin.
  return sharp(sourcePath(shop, 'icon'))
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Renders `size` x `size`. `maskable` insets the logo into the Android safe zone. */
async function renderIcon(shop, settings, size, maskable) {
  if (!ICON_SIZES.includes(size)) {
    throw Object.assign(new Error('Unsupported icon size'), { status: 404 });
  }

  const rev = renderRev(settings);
  const name = 'icon-' + rev + '-' + size + (maskable ? '-maskable' : '') + '.png';
  const target = path.join(derivedDir(shop), name);

  return cached(target, async () => {
    if (!maskable) return baseIcon(shop, settings, size);

    const inner = Math.max(1, Math.round(size * MASKABLE_SCALE));
    const logo = await baseIcon(shop, settings, inner);
    const offset = Math.round((size - inner) / 2);

    // Padded with the background colour rather than the theme colour, for the
    // same reason the splash screen uses it: an uploaded logo usually carries
    // its own light background, and padding it with a bold brand colour puts a
    // white square inside a coloured circle. Matching the splash also makes
    // launching the app look continuous with its icon.
    //
    // A maskable icon must be opaque to the edges: the platform crops it to its
    // own shape, and any transparency there shows as a hole in the mask.
    return sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: settings.backgroundColor || '#ffffff',
      },
    })
      .composite([{ input: logo, top: offset, left: offset }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  });
}

/** iOS startup image: the logo centred on the background colour. */
/*
 * Logo height on the iOS launch images, in the canvas's own pixels.
 *
 * A fixed height rather than a fraction of the canvas, so the logo is the same
 * number of pixels on every one of the nineteen sizes.
 *
 * Worth knowing when tuning this: these canvases are device pixels, not CSS
 * pixels. The short edges run 750 to 2048, so 100 here is 13% of the short edge
 * on the smallest launch image and 4.9% on a 12.9" iPad — and on a 3x iPhone it
 * lands at roughly 33 CSS pixels on screen. If the intent is "100 CSS pixels as
 * the customer sees it", this wants multiplying by the device pixel ratio; the
 * DPR is known per device in IOS_DEVICES.
 */
const SPLASH_LOGO_HEIGHT = 75;

async function renderSplash(shop, settings, width, height) {
  if (!SPLASH_SIZES.has(width + 'x' + height)) {
    throw Object.assign(new Error('Unsupported splash size'), { status: 404 });
  }

  const rev = renderRev(settings);
  const target = path.join(derivedDir(shop), 'splash-' + rev + '-' + width + 'x' + height + '.png');

  return cached(target, async () => {
    const logo = await baseIcon(shop, settings, SPLASH_LOGO_HEIGHT);

    return sharp({
      create: {
        width,
        height: SPLASH_LOGO_HEIGHT,
        channels: 4,
        background: settings.backgroundColor || '#ffffff',
      },
    })
      .composite([{ input: logo, gravity: 'centre' }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  });
}

/** Screenshots are served at their uploaded size — Chrome wants the real image. */
function screenshotPath(shop, kind) {
  return sourcePath(shop, kind);
}

const THUMB_ICON_SIZE = 96;
const THUMB_SCREENSHOT_WIDTH = 240;

/**
 * A small data URL of an uploaded image, for the admin to display.
 *
 * A data URL rather than a URL to fetch, because the stored files are only
 * reachable through the storefront app proxy — the admin runs on a different
 * origin and an <img src> cannot carry the session token that would be needed
 * to serve them from here. A few tens of kilobytes inline is a fair price for
 * a merchant being able to see the icon they uploaded last month.
 */
async function renderThumbnail(shop, settings, kind) {
  if (!settings.assets[kind].present) return null;

  const rev = settings.assets[kind].rev;
  const target = path.join(derivedDir(shop), 'thumb-' + kind + '-' + rev + '.png');

  try {
    const buffer = await cached(target, () =>
      sharp(sourcePath(shop, kind))
        .resize({ width: THUMB_SCREENSHOT_WIDTH, withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer()
    );
    return 'data:image/png;base64,' + buffer.toString('base64');
  } catch (err) {
    // A missing source file means the settings and the disk disagree. Show no
    // preview rather than failing the whole settings request over a thumbnail.
    console.error('thumbnail failed for ' + shop + '/' + kind + ':', err.message);
    return null;
  }
}

/**
 * Previews for the admin.
 *
 * `icon` and `iconMaskable` are the real renders a browser will receive, not
 * the raw upload, and they are produced even when nothing has been uploaded so
 * the placeholder is visible too. That difference is the point: the commonest
 * way a PWA icon goes wrong is a logo whose edges disappear under Android's
 * circular mask, and a merchant cannot see that coming from a flat square
 * thumbnail of the file they picked.
 *
 * The screenshot entries stay raw thumbnails — nothing crops those.
 */
async function thumbnails(shop, settings) {
  const [icon, iconMaskable, screenshotWide, screenshotNarrow] = await Promise.all([
    renderIcon(shop, settings, THUMB_ICON_SIZE, false)
      .then((b) => 'data:image/png;base64,' + b.toString('base64'))
      .catch(() => null),
    renderIcon(shop, settings, THUMB_ICON_SIZE, true)
      .then((b) => 'data:image/png;base64,' + b.toString('base64'))
      .catch(() => null),
    renderThumbnail(shop, settings, 'screenshotWide'),
    renderThumbnail(shop, settings, 'screenshotNarrow'),
  ]);

  return { icon, iconMaskable, screenshotWide, screenshotNarrow };
}

module.exports = {
  ICON_SIZES,
  IOS_DEVICES,
  MANIFEST_ICON_SIZES,
  SPLASH_SIZES,
  clearDerived,
  removeUpload,
  renderIcon,
  renderRev,
  renderSplash,
  saveUpload,
  screenshotPath,
  thumbnails,
};
