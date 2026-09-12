/**
 * Web app manifest construction.
 *
 * The one rule that dictates this app's whole architecture lives here: a
 * manifest's `start_url` and `scope` must be same-origin with the manifest
 * itself. Serving the manifest from the Shopify CDN (as a theme asset) puts it
 * on cdn.shopify.com, where `start_url: "/"` resolves to the CDN root and the
 * store is not installable. Served through the app proxy it is on the
 * storefront's own origin, and everything resolves the way a merchant expects.
 *
 * `proxyBase` is the storefront path the proxy is mounted at, normally
 * "/apps/pwa". It is taken from Shopify's own `path_prefix` query parameter
 * rather than hard-coded, so a merchant who changes the proxy subpath does not
 * silently end up with a manifest full of 404s.
 */

const { IOS_DEVICES, MANIFEST_ICON_SIZES, renderRev } = require('./images.js');

function iconEntry(proxyBase, size, rev, maskable) {
  return {
    src: proxyBase + '/icon-' + size + (maskable ? '-maskable' : '') + '.png?v=' + rev,
    sizes: size + 'x' + size,
    type: 'image/png',
    purpose: maskable ? 'maskable' : 'any',
  };
}

function screenshots(settings, proxyBase) {
  const out = [];
  const wide = settings.assets.screenshotWide;
  const narrow = settings.assets.screenshotNarrow;

  // `sizes` must match the real image or Chrome drops the entry without
  // logging anything, which is why the dimensions are measured at upload.
  if (wide.present) {
    out.push({
      src: proxyBase + '/screenshot-wide.png?v=' + wide.rev,
      sizes: wide.width + 'x' + wide.height,
      type: 'image/png',
      form_factor: 'wide',
    });
  }
  if (narrow.present) {
    out.push({
      src: proxyBase + '/screenshot-narrow.png?v=' + narrow.rev,
      sizes: narrow.width + 'x' + narrow.height,
      type: 'image/png',
      form_factor: 'narrow',
    });
  }
  return out;
}

/**
 * Where the installed app opens.
 *
 * With the worker running, that is the launch shell at the proxy root, because
 * the worker's scope is the proxy directory and nothing outside it can be
 * served from cache on a cold offline launch. The shell forwards to the
 * merchant's own startUrl before paint, so this is invisible online.
 *
 * With the worker off there is nothing to stay inside, and the extra hop would
 * only cost a redirect, so the store URL is used directly.
 */
function startUrlFor(settings, proxyBase) {
  return settings.serviceWorker.enabled ? proxyBase + '/' : settings.startUrl;
}

function build(settings, proxyBase) {
  const rev = renderRev(settings);

  const icons = [];
  for (const size of MANIFEST_ICON_SIZES) {
    icons.push(iconEntry(proxyBase, size, rev, false));
    // Without a maskable pair, Android draws the "any" icon shrunk inside a
    // white rounded square, which looks broken next to native app icons.
    icons.push(iconEntry(proxyBase, size, rev, true));
  }

  const manifest = {
    // Pinned to the scope rather than left to default to start_url. `id` is the
    // installed app's identity: if it tracked start_url, changing the launch
    // URL later would register as a different app and existing installs would
    // stop updating.
    id: settings.scope,

    name: settings.name,
    short_name: settings.shortName,
    lang: settings.lang,
    dir: settings.dir,

    start_url: startUrlFor(settings, proxyBase),
    // Deliberately still the whole storefront, not the proxy directory: scope
    // is what stays inside the installed window, and a customer who taps
    // through to a product should not be thrown into a browser tab. It is also
    // this app's manifest `id`, so narrowing it would orphan every install.
    scope: settings.scope,

    // Switched off in the admin, the manifest is still served, and still valid
    // — it just asks for a plain browser tab, which no browser offers to
    // install. Withdrawing the file instead would put a 404 on a <link> tag
    // that the theme app embed still renders on every storefront page, and
    // Chrome reports that as a broken site rather than an uninstallable one.
    display: settings.enabled ? settings.display : 'browser',
    // Ordered fallbacks. A browser that does not know the primary value walks
    // this list rather than dropping straight to a plain browser tab.
    display_override: settings.enabled ? [settings.display, 'minimal-ui', 'browser'] : ['browser'],
    orientation: settings.orientation,

    theme_color: settings.themeColor,
    background_color: settings.backgroundColor,

    icons,

    // Tells Android not to prefer a Play Store listing over this manifest.
    prefer_related_applications: false,
  };

  if (settings.description) manifest.description = settings.description;
  if (settings.categories.length) manifest.categories = settings.categories;

  if (settings.shortcuts.length) {
    manifest.shortcuts = settings.shortcuts.map((s) => ({
      name: s.name,
      url: s.url,
      icons: [iconEntry(proxyBase, 192, rev, false)],
    }));
  }

  const shots = screenshots(settings, proxyBase);
  if (shots.length) manifest.screenshots = shots;

  return manifest;
}

/**
 * The <link rel="apple-touch-startup-image"> set, as data for the storefront
 * script to inject.
 *
 * Safari matches a startup image by exact media query, so each entry carries
 * the device's CSS size and pixel ratio rather than just its pixel dimensions.
 * These are injected at runtime by pwa.js instead of rendered into the page:
 * there are nineteen of them, they matter only on iOS, and iOS reads them when
 * the customer taps "Add to Home Screen" — long after load.
 */
function iosSplashLinks(settings, proxyBase) {
  if (!settings.ios.splash) return [];

  const rev = renderRev(settings);
  const links = [];

  for (const device of IOS_DEVICES) {
    const orientations = device.landscape ? ['portrait', 'landscape'] : ['portrait'];
    for (const orientation of orientations) {
      const portrait = orientation === 'portrait';
      const pxW = (portrait ? device.w : device.h) * device.dpr;
      const pxH = (portrait ? device.h : device.w) * device.dpr;
      links.push({
        href: proxyBase + '/splash-' + pxW + 'x' + pxH + '.png?v=' + rev,
        media:
          '(device-width: ' + device.w + 'px) and (device-height: ' + device.h + 'px) ' +
          'and (-webkit-device-pixel-ratio: ' + device.dpr + ') ' +
          'and (orientation: ' + orientation + ')',
      });
    }
  }

  return links;
}

module.exports = { build, iosSplashLinks, startUrlFor };
