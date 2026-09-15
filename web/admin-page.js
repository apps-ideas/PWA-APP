/**
 * The embedded admin: a plain server-rendered shell plus one script.
 *
 * No React, no Polaris, no build step — on purpose. This app has one settings
 * screen, and the fleet's other Node apps each carry a Vite + React + Polaris
 * toolchain to render forms not much larger than this one. Hand-written HTML
 * keeps the deploy to "copy the repo, run node", which is the whole reason this
 * app has no OAuth flow and no session store either.
 *
 * Styling follows Polaris closely enough to sit in the admin without jarring,
 * and honours the admin's light and dark themes.
 */

const { CATEGORIES: CATEGORY_CHOICES } = require('./validate.js');

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const STYLES = `
  :root { color-scheme: light dark; --bg:#f1f1f1; --card:#fff; --line:#e1e3e5; --text:#303030;
          --muted:#616161; --accent:#303030; --accent-fg:#fff; --field:#fff; --warn-bg:#fff6e0;
          --warn-line:#e0b44a; --ok:#0c8a5f; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1a1a; --card:#222; --line:#3a3a3a; --text:#e3e3e3; --muted:#a0a0a0;
            --accent:#e3e3e3; --accent-fg:#1a1a1a; --field:#2b2b2b; --warn-bg:#3a3212;
            --warn-line:#7a6a20; --ok:#3fbf8f; --bad:#ff7b6b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 16px 80px; background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size:19px; margin:0 0 4px; }
  .sub { margin:0 0 20px; color:var(--muted); }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:18px 20px; margin-bottom:14px; }
  h2 { font-size:14px; margin:0 0 4px; }
  .hint { margin:0 0 16px; color:var(--muted); font-size:13px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; }
  label { display:block; font-weight:500; margin-bottom:5px; }
  .sublabel { display:block; font-weight:400; color:var(--muted); font-size:12.5px; margin-top:4px; }
  input[type=text], input[type=url], input[type=number], select, textarea {
    width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
    background:var(--field); color:var(--text); font:inherit; }
  textarea { resize:vertical; min-height:64px; }
  input[type=color] { width:52px; height:36px; padding:2px; border:1px solid var(--line);
    border-radius:8px; background:var(--field); cursor:pointer; vertical-align:middle; }
  .colorrow { display:flex; gap:8px; align-items:center; }
  .colorrow input[type=text] { flex:1; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .check { display:flex; gap:9px; align-items:flex-start; margin-bottom:12px; }
  .check input { margin-top:3px; flex:0 0 auto; }
  .check label { font-weight:400; margin:0; }
  button { font:inherit; font-weight:600; cursor:pointer; border-radius:8px; border:1px solid transparent;
    padding:9px 16px; background:var(--accent); color:var(--accent-fg); }
  button.secondary { background:transparent; color:var(--text); border-color:var(--line); }
  button:disabled { opacity:.55; cursor:default; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .savebar { position:sticky; bottom:0; margin-top:16px; padding:12px 16px; background:var(--card);
    border:1px solid var(--line); border-radius:12px; display:flex; gap:12px; align-items:center; }
  .savebar .status { flex:1; color:var(--muted); }
  .banner { border-radius:10px; padding:11px 14px; margin-bottom:14px; border:1px solid; }
  .banner.warn { background:var(--warn-bg); border-color:var(--warn-line); }
  .banner.bad { background:transparent; border-color:var(--bad); color:var(--bad); }
  .banner ul { margin:6px 0 0; padding-left:20px; }
  .preview { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .preview img { width:72px; height:72px; border-radius:16px; border:1px solid var(--line);
    background:var(--field); object-fit:cover; }
  .shot { width:auto; max-width:180px; height:96px; border-radius:8px; }
  /* The same icon under each platform's mask. A logo that survives a square
     but loses its edges in a circle is the commonest icon mistake there is,
     and it is invisible until you look at it cropped. */
  .masks { display:flex; gap:20px; flex-wrap:wrap; margin-bottom:14px; }
  .mask { text-align:center; width:84px; }
  .mask img { width:72px; height:72px; border:1px solid var(--line); background:var(--field);
    object-fit:cover; display:block; margin:0 auto; }
  .mask .sq { border-radius:16px; }
  .mask .squircle { border-radius:22%; }
  .mask .circle { border-radius:50%; }
  .mask span { display:block; margin-top:7px; font-size:12px; color:var(--muted); line-height:1.3; }
  /* Install figures. The tiles are a plain auto-fit grid so four of them sit
     in a row on a desktop admin and stack in pairs on a phone, with no
     breakpoint to keep in step with the section width. */
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(124px,1fr)); gap:10px;
    margin-bottom:16px; }
  .tile { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:var(--field); }
  .tile .n { font-size:23px; font-weight:600; line-height:1.2; font-variant-numeric:tabular-nums; }
  .tile .k { color:var(--muted); font-size:12.5px; margin-top:3px; }
  /* Bars are drawn with divs rather than an SVG or a chart library: thirty
     rectangles is the whole requirement, and this way the chart inherits the
     admin's dark mode for free. */
  .chart { display:flex; align-items:flex-end; gap:2px; height:74px; padding:0 1px;
    border-bottom:1px solid var(--line); }
  .chart .bar { flex:1 1 0; min-width:0; height:100%; display:flex; align-items:flex-end; }
  .chart .bar i { display:block; width:100%; background:var(--accent); border-radius:2px 2px 0 0;
    min-height:1px; opacity:.85; }
  .chart .bar.zero i { background:var(--line); opacity:1; }
  .axis { display:flex; justify-content:space-between; color:var(--muted); font-size:12px;
    margin:6px 0 0; }
  /* What a forced refresh does and does not reach. A table rather than prose
     because the useful thing is the per-cache verdict, and four of those in a
     paragraph is four sentences nobody finishes. */
  .what { border-collapse:collapse; width:100%; font-size:13px; }
  .what td { border-top:1px solid var(--line); padding:8px 0; vertical-align:top; }
  .what tr:first-child td { border-top:0; }
  .what td:first-child { color:var(--muted); padding-right:16px; width:36%; }
  @media (max-width:560px) {
    .what td { display:block; border-top:0; padding:2px 0; }
    .what td:first-child { width:auto; padding-top:10px; border-top:1px solid var(--line); }
    .what tr:first-child td:first-child { border-top:0; }
  }
  .cats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:2px 14px; }
  .cats .check { margin-bottom:4px; }
  .off { opacity:.5; }
  .shortcut { display:grid; grid-template-columns:1fr 1.4fr; gap:10px; margin-bottom:10px; }
  a { color:inherit; }
  code { background:rgba(128,128,128,.16); border-radius:4px; padding:1px 5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .muted { color:var(--muted); }
  @media (max-width:560px) { .shortcut { grid-template-columns:1fr; } }
`;

function field(id, label, input, sublabel) {
  return (
    '<div><label for="' + id + '">' + escapeHtml(label) + '</label>' + input +
    (sublabel ? '<span class="sublabel">' + sublabel + '</span>' : '') + '</div>'
  );
}

function text(id, placeholder) {
  return '<input type="text" id="' + id + '" placeholder="' + escapeHtml(placeholder || '') + '">';
}

function select(id, options) {
  return (
    '<select id="' + id + '">' +
    options.map((o) => '<option value="' + escapeHtml(o[0]) + '">' + escapeHtml(o[1]) + '</option>').join('') +
    '</select>'
  );
}

function colorField(id, label, sublabel) {
  return field(
    id,
    label,
    '<div class="colorrow"><input type="color" id="' + id + 'Picker" aria-label="' + escapeHtml(label) + ' picker">' +
      '<input type="text" id="' + id + '" placeholder="#111111" spellcheck="false"></div>',
    sublabel
  );
}

function checkbox(id, label) {
  return '<div class="check"><input type="checkbox" id="' + id + '"><label for="' + id + '">' + label + '</label></div>';
}

/**
 * The icon block: upload controls plus the same icon under each platform's mask.
 *
 * The previews are the real renders the server will serve, not the file the
 * merchant picked, so the placeholder shows here too before anything is
 * uploaded — and a logo that will lose its edges under Android's circular mask
 * shows it here rather than on a customer's home screen.
 */
function iconSection() {
  const masks = [
    ['iconPreview', 'sq', 'Desktop &amp; iOS'],
    ['iconMaskableSquirclePreview', 'squircle', 'Android squircle'],
    ['iconMaskableCirclePreview', 'circle', 'Android circle'],
  ];

  return (
    '<h2>App icon</h2>' +
    '<p class="hint">One square PNG, at least 512&times;512. Every size the manifest needs is generated ' +
    'from it, including the Android maskable pair. Until you upload one, a placeholder with your ' +
    'initial is used so the store is still installable.</p>' +
    '<div class="masks">' +
    masks.map(([id, cls, label]) =>
      '<div class="mask"><img id="' + id + '" class="' + cls + '" alt=""><span>' + label + '</span></div>'
    ).join('') +
    '</div>' +
    '<div class="row">' +
    '<input type="file" id="iconFile" accept="image/png,image/jpeg,image/webp" hidden>' +
    '<button type="button" class="secondary" data-upload="icon">Choose image</button>' +
    '<button type="button" class="secondary" data-remove="icon">Remove</button>' +
    '<span class="muted" id="iconMeta"></span>' +
    '</div>'
  );
}

function assetBlock(kind, label, hint, previewClass) {
  return (
    '<div>' +
    '<h2>' + escapeHtml(label) + '</h2><p class="hint">' + hint + '</p>' +
    '<div class="preview">' +
    '<img id="' + kind + 'Preview" class="' + previewClass + '" alt="">' +
    '<div class="row">' +
    '<input type="file" id="' + kind + 'File" accept="image/png,image/jpeg,image/webp" hidden>' +
    '<button type="button" class="secondary" data-upload="' + kind + '">Choose image</button>' +
    '<button type="button" class="secondary" data-remove="' + kind + '">Remove</button>' +
    '<span class="muted" id="' + kind + 'Meta"></span>' +
    '</div></div></div>'
  );
}

function html(shop, apiKey) {
  const storeHandle = shop ? shop.replace(/\.myshopify\.com$/, '') : null;

  const themeEditorLink = storeHandle
    ? 'https://admin.shopify.com/store/' + escapeHtml(storeHandle) + '/themes/current/editor?context=apps'
    : null;
  const checkLink = shop ? 'https://' + escapeHtml(shop) + '/apps/pwa/check' : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storefront PWA</title>
${apiKey ? '<meta name="shopify-api-key" content="' + escapeHtml(apiKey) + '">' : ''}
${shop && apiKey ? '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>' : ''}
<style>${STYLES}</style>
</head>
<body>
<main>
  <h1>Storefront PWA</h1>
  <p class="sub">Makes ${escapeHtml(shop || 'your store')} installable as an app on desktop, Android and iOS.</p>

  ${!shop ? '<div class="banner bad">Open this app from the Shopify admin. Loaded directly it has no shop context and cannot read settings.</div>' : ''}
  ${!apiKey ? '<div class="banner bad">SHOPIFY_API_KEY is not set on the server, so App Bridge cannot load and settings cannot be saved.</div>' : ''}

  <div id="banners"></div>

  <section data-static>
    <h2>Two things to do by hand</h2>
    <p class="hint">Neither can be done from here — both live in the theme, which this app does not have permission to edit.</p>
    <ol style="margin:0;padding-left:20px">
      <li style="margin-bottom:8px">Turn on the <strong>Storefront PWA</strong> app embed in
        ${themeEditorLink ? '<a href="' + themeEditorLink + '" target="_blank" rel="noopener">Theme editor &rsaquo; App embeds</a>' : 'Theme editor &rsaquo; App embeds'}.
        Nothing below has any effect until that is on.</li>
      <li>Then ${checkLink ? '<a href="' + checkLink + '" target="_blank" rel="noopener">run the storefront check</a>' : 'open <code>/apps/pwa/check</code> on your storefront'}
        to confirm the manifest, the icons and the install path on a real page.</li>
    </ol>
  </section>

  <section data-static>
    <h2>Status</h2>
    <p class="hint">Two switches control this app, and they do different jobs. The theme app embed
      decides whether the tags are on the page at all — that is a theme change, made in the theme
      editor. The switch below leaves the theme alone and makes the manifest non-installable, which
      is the one to reach for if something looks wrong on a live store.</p>
    ${checkbox('enabled', 'Storefront PWA is active — customers can install the store as an app')}
    <p class="hint" id="enabledNote" style="margin:0"></p>
  </section>

  <section data-static>
    <div class="row" style="justify-content:space-between;margin-bottom:4px">
      <h2 style="margin:0">Installs</h2>
      <button type="button" class="secondary" id="statsReload" style="padding:5px 11px;font-size:13px">Refresh</button>
    </div>
    <p class="hint">How many customers have added your store to a home screen or a desktop, counted on
      the storefront itself. Nothing about the customer is recorded — the app keeps four numbers per
      day and nothing else. Days run midnight to midnight UTC.</p>
    <div class="stats" id="statTiles"></div>
    <div class="chart" id="statChart"></div>
    <p class="axis" id="statAxis"></p>
    <p class="hint" id="statNote" style="margin:14px 0 0"></p>
  </section>

  <section>
    <h2>App identity</h2>
    <p class="hint">What the installed app is called, and how it describes itself in install dialogs.</p>
    <div class="grid">
      ${field('name', 'App name', text('name', 'Your store'), 'Shown in the install dialog and the app window title.')}
      ${field('shortName', 'Short name', text('shortName', 'Store'), 'Under the home screen icon. Android truncates past about 12 characters.')}
    </div>
    <div style="margin-top:14px">
      ${field('description', 'Description', '<textarea id="description" placeholder="What customers can do in the app"></textarea>', 'Shown in the richer install dialogs on desktop.')}
    </div>
    <div class="grid" style="margin-top:14px">
      ${field('lang', 'Language', text('lang', 'en'), 'A BCP&nbsp;47 tag, e.g. <code>en</code>, <code>ur</code>, <code>ar-AE</code>.')}
      ${field('dir', 'Text direction', select('dir', [['auto', 'Automatic'], ['ltr', 'Left to right'], ['rtl', 'Right to left']]))}
    </div>
    <div style="margin-top:18px">
      <label>Categories</label>
      <span class="sublabel" style="margin:0 0 10px">What kind of app this is. Up to five; anything
        beyond that is dropped. Only some app catalogues read them, so this is low-stakes.</span>
      <div class="cats">
        ${CATEGORY_CHOICES.map((c) =>
          '<div class="check"><input type="checkbox" id="cat-' + c + '" data-category="' + c + '">' +
          '<label for="cat-' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</label></div>'
        ).join('')}
      </div>
    </div>
  </section>

  <section>
    ${iconSection()}
  </section>

  <section>
    <h2>Appearance</h2>
    <p class="hint">How the installed window looks before your storefront has painted.</p>
    <div class="grid">
      ${colorField('themeColor', 'Theme colour', 'Tints the title bar and the Android status bar. Also the install button colour.')}
      ${colorField('backgroundColor', 'Background colour', 'The splash screen while the store loads, and the padding around the Android home screen icon. Match your storefront background, not your brand colour.')}
    </div>
    <div class="grid" style="margin-top:14px">
      ${field('display', 'Display mode', select('display', [['standalone', 'Standalone — own window, no browser UI'], ['minimal-ui', 'Minimal UI — a back and reload control'], ['fullscreen', 'Fullscreen — no system UI at all'], ['browser', 'Browser — an ordinary tab']]), 'Standalone is what makes it feel like an app.')}
      ${field('orientation', 'Orientation', select('orientation', [['any', 'Any'], ['natural', 'Natural'], ['portrait', 'Portrait'], ['landscape', 'Landscape']]))}
    </div>
  </section>

  <section>
    <h2>Launch behaviour</h2>
    <p class="hint">Where the app opens, and which pages count as part of it.</p>
    <div class="grid">
      ${field('startUrl', 'Start URL', text('startUrl', '/?source=pwa'), 'Opened on launch. Keeping a query parameter here lets you see app traffic separately in analytics.')}
      ${field('scope', 'Scope', text('scope', '/'), 'Pages outside this open in a browser tab instead of the app window. <code>/</code> is almost always right.')}
    </div>
    <div style="margin-top:18px">
      <h2>Shortcuts</h2>
      <p class="hint">Up to four. Long-press the icon on Android, right-click it on desktop. Leave a row blank to skip it.</p>
      <div id="shortcuts"></div>
    </div>
  </section>

  <section>
    <h2>Install prompt</h2>
    <p class="hint">A card inviting customers to install. Where the browser allows it, the card opens the native install dialog; everywhere else it shows that browser's own directions. You can also add <code>data-pwa-install</code> to any element in your theme to trigger it.</p>
    ${checkbox('installEnabled', 'Show the install card to visitors who have not installed yet')}
    <div class="grid">
      ${field('installDelaySeconds', 'Delay before showing', '<input type="number" id="installDelaySeconds" min="0" max="120">', 'Seconds after the page loads. 0 shows it immediately.')}
      ${field('installPosition', 'Position', select('installPosition', [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['bottom-bar', 'Full-width bar']]))}
      ${field('installDismissDays', 'Hide for, after dismissal', '<input type="number" id="installDismissDays" min="0" max="365">', 'Days. 0 means show again on the next page view.')}
      ${field('installButtonLabel', 'Button label', text('installButtonLabel', 'Install'))}
    </div>
    <div style="margin-top:14px">
      ${field('installTitle', 'Card title', text('installTitle', 'Install our app'))}
    </div>
    <div style="margin-top:14px">
      ${field('installBody', 'Card text', '<textarea id="installBody"></textarea>')}
    </div>
  </section>

  <section>
    <h2>iOS</h2>
    <p class="hint">Safari ignores most of the manifest and uses its own tags, so these are separate settings rather than duplicates.</p>
    ${checkbox('iosSplash', 'Generate iOS launch screens (nineteen sizes, from your icon and background colour)')}
    ${field('iosStatusBarStyle', 'Status bar style', select('iosStatusBarStyle', [['default', 'Default — dark text on light'], ['black', 'Black'], ['black-translucent', 'Translucent — content runs under the status bar']]))}
  </section>

  <section>
    <h2>Install dialog screenshots</h2>
    <p class="hint">Optional. With a screenshot present, Chrome shows a larger install dialog with a preview instead of a plain one-line prompt.</p>
    <div class="grid">
      ${assetBlock('screenshotWide', 'Wide (desktop)', 'Landscape, e.g. 1280&times;800.', 'shot')}
      ${assetBlock('screenshotNarrow', 'Narrow (mobile)', 'Portrait, e.g. 750&times;1334.', 'shot')}
    </div>
  </section>

  <section>
    <h2>Offline browsing</h2>
    <p class="hint">
      Off, and on a stock Shopify storefront it cannot be made to work. A service worker may only control the
      pages below the folder it is served from, and widening that needs a <code>Service-Worker-Allowed</code>
      header that Shopify strips when it proxies <code>/apps/pwa/</code>. So the worker can only ever control
      <code>/apps/pwa/</code>, never your product pages. <strong>Installing does not depend on this</strong> —
      desktop and mobile install fine without it. Turn it on only to re-test whether Shopify's behaviour has
      changed; the storefront check will tell you which case you are in.
    </p>
    ${checkbox('swEnabled', 'Register a service worker')}
    ${checkbox('swOfflinePage', 'Precache an offline fallback page')}
  </section>

  <section data-static>
    <h2>Not seeing your changes?</h2>
    <p class="hint">Saving is instant here, but four different caches sit between this screen and a
      customer's phone. This forces the two that can be forced.</p>
    <table class="what">
      <tr><td>App icon, launch screens</td><td><strong>Refreshed now.</strong> Every image gets a new
        address, so nothing can serve the old one.</td></tr>
      <tr><td>Service worker cache</td><td><strong>Cleared on each visitor's next page view.</strong>
        The new worker deletes the old cache when it takes over.</td></tr>
      <tr><td>Manifest and storefront script</td><td>Expire on their own within
        <strong>5 and 10 minutes</strong>. Shopify has no way to purge these early, so no button can.</td></tr>
      <tr><td>Apps already on a home screen</td><td>Keep the name and icon captured when they were
        installed. Android may pick up a change eventually; <strong>iOS needs a reinstall</strong>.</td></tr>
    </table>
    <div class="row" style="margin-top:14px">
      <button type="button" class="secondary" id="clearCache">Force a refresh</button>
      <span class="muted" id="clearCacheNote"></span>
    </div>
  </section>

  <div class="savebar">
    <span class="status" id="status">Loading…</span>
    <button type="button" class="secondary" id="reload">Discard changes</button>
    <button type="button" id="save" disabled>Save</button>
  </div>
</main>
<script src="/admin.js"></script>
</body>
</html>
`;
}

/**
 * The admin's client script.
 *
 * Every request carries a fresh App Bridge session token. There is no cookie
 * and no server session — App Bridge mints a token per call, the server
 * verifies it against the app secret, and the shop comes from inside the token.
 */
function script() {
  return `
(function () {
  'use strict';

  var FIELDS = [
    ['enabled', 'enabled'],
    ['name', 'name'], ['shortName', 'shortName'], ['description', 'description'],
    ['lang', 'lang'], ['dir', 'dir'], ['startUrl', 'startUrl'], ['scope', 'scope'],
    ['display', 'display'], ['orientation', 'orientation'],
    ['themeColor', 'themeColor'], ['backgroundColor', 'backgroundColor'],
    ['install.enabled', 'installEnabled'], ['install.delaySeconds', 'installDelaySeconds'],
    ['install.position', 'installPosition'], ['install.dismissDays', 'installDismissDays'],
    ['install.title', 'installTitle'], ['install.body', 'installBody'],
    ['install.buttonLabel', 'installButtonLabel'],
    ['ios.splash', 'iosSplash'], ['ios.statusBarStyle', 'iosStatusBarStyle'],
    ['serviceWorker.enabled', 'swEnabled'], ['serviceWorker.offlinePage', 'swOfflinePage']
  ];

  var state = null;
  var previews = {};
  var el = function (id) { return document.getElementById(id); };

  function get(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }

  function set(obj, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (o, k) { o[k] = o[k] || {}; return o[k]; }, obj);
    target[last] = value;
  }

  /* App Bridge mints a short-lived token per request; there is nothing to cache. */
  function token() {
    if (window.shopify && window.shopify.idToken) return window.shopify.idToken();
    return Promise.reject(new Error('App Bridge is not available. Open this app from the Shopify admin.'));
  }

  function api(path, options) {
    return token().then(function (t) {
      var opts = options || {};
      opts.headers = opts.headers || {};
      opts.headers.Authorization = 'Bearer ' + t;
      return fetch(path, opts);
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || ('Request failed: HTTP ' + res.status));
        return body;
      });
    });
  }

  function banner(kind, title, items) {
    var box = el('banners');
    box.innerHTML = '';
    if (!items || !items.length) return;
    var div = document.createElement('div');
    div.className = 'banner ' + kind;
    var strong = document.createElement('strong');
    strong.textContent = title;
    div.appendChild(strong);
    var ul = document.createElement('ul');
    items.forEach(function (item) {
      var li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
    div.appendChild(ul);
    box.appendChild(div);
  }

  function status(message) { el('status').textContent = message; }

  /* ------------------------------------------------------------- rendering */

  function renderShortcuts() {
    var box = el('shortcuts');
    box.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      var row = state.shortcuts[i] || { name: '', url: '' };
      var wrap = document.createElement('div');
      wrap.className = 'shortcut';
      wrap.innerHTML =
        '<input type="text" data-sc-name="' + i + '" placeholder="Label, e.g. Sale">' +
        '<input type="text" data-sc-url="' + i + '" placeholder="/collections/sale">';
      wrap.querySelector('[data-sc-name]').value = row.name || '';
      wrap.querySelector('[data-sc-url]').value = row.url || '';
      box.appendChild(wrap);
    }
  }

  function renderCategories() {
    var chosen = state.categories || [];
    var boxes = document.querySelectorAll('[data-category]');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = chosen.indexOf(boxes[i].getAttribute('data-category')) !== -1;
    }
  }

  function renderEnabled() {
    var on = el('enabled').checked;
    var note = el('enabledNote');
    note.textContent = on
      ? 'Active. Customers who have not installed yet will be offered the app.'
      : 'Switched off. The manifest is still served, but it asks for a plain browser tab, so no ' +
        'browser will offer to install the store. Existing installs keep working.';
    // Dim every section the switch governs: nothing in them has any effect
    // while the app is off, and saying so visually beats a banner. The three
    // marked data-static are exempt — the setup steps, this switch itself, and
    // the install figures, which are history and do not stop being true
    // because the app was turned off this morning.
    var sections = document.querySelectorAll('section:not([data-static])');
    for (var i = 0; i < sections.length; i++) sections[i].className = on ? '' : 'off';
  }

  /* The icon previews are the real renders, so the same image appears three
   * times under the three masks a platform may apply to it. */
  function renderIconPreviews() {
    var pairs = [
      ['iconPreview', previews.icon],
      ['iconMaskableSquirclePreview', previews.iconMaskable],
      ['iconMaskableCirclePreview', previews.iconMaskable]
    ];
    for (var i = 0; i < pairs.length; i++) {
      var node = el(pairs[i][0]);
      if (pairs[i][1]) {
        node.src = pairs[i][1];
        node.style.visibility = '';
      } else {
        node.removeAttribute('src');
        node.style.visibility = 'hidden';
      }
    }

    var asset = state.assets.icon;
    el('iconMeta').textContent = asset.present
      ? asset.width + ' x ' + asset.height + ' uploaded'
      : 'No icon uploaded — showing the generated placeholder';
  }

  function renderAsset(kind, emptyText) {
    var asset = state.assets[kind];
    var preview = el(kind + 'Preview');
    var meta = el(kind + 'Meta');
    // The stored files live behind the storefront proxy, on a different origin
    // from this admin, so the server sends a small inline thumbnail instead.
    var src = previews[kind];

    if (asset.present && src) {
      preview.style.display = '';
      preview.src = src;
      meta.textContent = asset.width + ' x ' + asset.height;
    } else {
      preview.style.display = 'none';
      preview.removeAttribute('src');
      meta.textContent = asset.present ? 'Uploaded, but the preview could not be rendered' : emptyText;
    }
  }

  function renderAssets() {
    renderIconPreviews();
    renderAsset('screenshotWide', 'Not set');
    renderAsset('screenshotNarrow', 'Not set');
  }

  /* ---------------------------------------------------------------- stats */

  function tile(value, label) {
    var box = document.createElement('div');
    box.className = 'tile';

    var n = document.createElement('div');
    n.className = 'n';
    n.textContent = String(value);

    var k = document.createElement('div');
    k.className = 'k';
    k.textContent = label;

    box.appendChild(n);
    box.appendChild(k);
    return box;
  }

  function shortDate(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  /* Bars are scaled to the busiest day in the window, not to a fixed ceiling.
   * A shop with two installs a week and a shop with two hundred both want to
   * see the shape of their own traffic. */
  function renderChart(series) {
    var chart = el('statChart');
    var axis = el('statAxis');
    chart.innerHTML = '';
    axis.innerHTML = '';

    var peak = 0;
    series.forEach(function (row) { if (row.installed > peak) peak = row.installed; });

    series.forEach(function (row) {
      var bar = document.createElement('div');
      bar.className = row.installed ? 'bar' : 'bar zero';
      bar.title = shortDate(row.date) + ': ' + row.installed +
        (row.installed === 1 ? ' install' : ' installs');

      var fill = document.createElement('i');
      // Floored at 6% so a day with one install against a peak of two hundred
      // is still a visible mark rather than a rounding error.
      fill.style.height = peak && row.installed
        ? Math.max(6, Math.round((row.installed / peak) * 100)) + '%'
        : '2px';

      bar.appendChild(fill);
      chart.appendChild(bar);
    });

    var first = document.createElement('span');
    first.textContent = series.length ? shortDate(series[0].date) : '';
    var last = document.createElement('span');
    last.textContent = 'Today' + (peak ? ' — busiest day: ' + peak : '');
    axis.appendChild(first);
    axis.appendChild(last);
  }

  function renderStats(data) {
    var window_ = data.windowDays;
    var tiles = el('statTiles');
    tiles.innerHTML = '';

    tiles.appendChild(tile(data.totals.installed, 'Installs, all time'));
    tiles.appendChild(tile(data.recent.installed, 'Installs, last ' + window_ + ' days'));
    tiles.appendChild(tile(data.recent.launch, 'App opens, last ' + window_ + ' days'));
    tiles.appendChild(tile(data.recent.shown, 'Install card shown'));

    renderChart(data.series);

    var note = el('statNote');
    if (!data.totals.installed && !data.totals.shown && !data.totals.launch) {
      note.textContent = 'Nothing counted yet. Figures appear once the app embed is on and a ' +
        'customer has seen the install card on your storefront.';
      return;
    }

    var parts = [];
    if (data.recent.shown) {
      parts.push('The install card was shown ' + data.recent.shown + ' times and tapped ' +
        data.recent.clicked + ' (' + Math.round((data.recent.clicked / data.recent.shown) * 100) + '%).');
    }
    if (data.lastEventAt) {
      parts.push('Last activity ' + new Date(data.lastEventAt).toLocaleString() + '.');
    }
    // Said plainly rather than buried: the counters are keyed on browser
    // storage, so a customer who installs on a phone and a laptop is two, and
    // one who clears their storage and reinstalls is two as well.
    parts.push('Counted once per browser, so these are close but not exact — clearing site data ' +
      'or installing on a second device counts again. iOS installs appear the first time the ' +
      'app is opened, not when it is added.');
    note.textContent = parts.join(' ');
  }

  function loadStats() {
    api('/api/stats').then(renderStats).catch(function (err) {
      el('statNote').textContent = 'Could not load install figures: ' + err.message;
    });
  }

  el('statsReload').addEventListener('click', loadStats);

  /* --------------------------------------------------------------- render */

  function render() {
    FIELDS.forEach(function (pair) {
      var node = el(pair[1]);
      if (!node) return;
      var value = get(state, pair[0]);
      if (node.type === 'checkbox') node.checked = Boolean(value);
      else node.value = value == null ? '' : value;
    });

    ['themeColor', 'backgroundColor'].forEach(function (id) {
      var picker = el(id + 'Picker');
      var value = state[id] || '#000000';
      // <input type=color> only accepts six-digit hex; a three-digit value from
      // the text field would silently reset the picker to black.
      picker.value = value.length === 4
        ? '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3]
        : value;
    });

    renderShortcuts();
    renderCategories();
    renderEnabled();
    renderAssets();
    el('save').disabled = false;
    status(state.updatedAt ? 'Last saved ' + new Date(state.updatedAt).toLocaleString() : 'Not saved yet');
  }

  function collect() {
    var out = JSON.parse(JSON.stringify(state));
    FIELDS.forEach(function (pair) {
      var node = el(pair[1]);
      if (!node) return;
      if (node.type === 'checkbox') set(out, pair[0], node.checked);
      else if (node.type === 'number') set(out, pair[0], Number(node.value));
      else set(out, pair[0], node.value);
    });

    out.categories = [];
    var boxes = document.querySelectorAll('[data-category]');
    for (var c = 0; c < boxes.length; c++) {
      if (boxes[c].checked) out.categories.push(boxes[c].getAttribute('data-category'));
    }

    out.shortcuts = [];
    for (var i = 0; i < 4; i++) {
      var name = document.querySelector('[data-sc-name="' + i + '"]').value.trim();
      var url = document.querySelector('[data-sc-url="' + i + '"]').value.trim();
      if (name && url) out.shortcuts.push({ name: name, url: url });
    }
    return out;
  }

  /* ---------------------------------------------------------------- events */

  el('enabled').addEventListener('change', renderEnabled);

  ['themeColor', 'backgroundColor'].forEach(function (id) {
    el(id + 'Picker').addEventListener('input', function (e) { el(id).value = e.target.value; });
    el(id).addEventListener('change', function (e) {
      var value = e.target.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(value)) el(id + 'Picker').value = value;
    });
  });

  document.querySelectorAll('[data-upload]').forEach(function (button) {
    var kind = button.getAttribute('data-upload');
    button.addEventListener('click', function () { el(kind + 'File').click(); });

    el(kind + 'File').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;

      status('Uploading ' + file.name + '…');
      // Raw bytes with the file's own content type — the server takes the body
      // as the image, so there is no multipart envelope to build or parse.
      api('/api/assets/' + kind, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      }).then(function (body) {
        state = body.settings;
        previews = body.previews || {};
        renderAssets();
        banner('warn', 'Uploaded, with notes:', body.warnings);
        status('Image saved');
      }).catch(function (err) {
        banner('bad', 'Upload failed', [err.message]);
        status('Upload failed');
      }).then(function () { event.target.value = ''; });
    });
  });

  document.querySelectorAll('[data-remove]').forEach(function (button) {
    button.addEventListener('click', function () {
      var kind = button.getAttribute('data-remove');
      status('Removing…');
      api('/api/assets/' + kind, { method: 'DELETE' }).then(function (body) {
        state = body.settings;
        previews = body.previews || {};
        renderAssets();
        status('Image removed');
      }).catch(function (err) {
        banner('bad', 'Could not remove the image', [err.message]);
      });
    });
  });

  el('save').addEventListener('click', function () {
    el('save').disabled = true;
    status('Saving…');

    api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect())
    }).then(function (body) {
      state = body.settings;
      render();
      // The server reports what it changed rather than what it rejected
      // outright, so these are worth surfacing even on a successful save.
      banner('warn', 'Saved, with changes:', body.warnings);
      status('Saved ' + new Date().toLocaleTimeString() + '. Manifest changes reach visitors within five minutes.');
    }).catch(function (err) {
      banner('bad', 'Could not save', [err.message]);
      status('Not saved');
      el('save').disabled = false;
    });
  });

  el('reload').addEventListener('click', function () { load(); });

  el('clearCache').addEventListener('click', function () {
    var button = el('clearCache');
    var note = el('clearCacheNote');
    button.disabled = true;
    note.textContent = 'Refreshing…';

    api('/api/cache/clear', { method: 'POST' }).then(function (body) {
      // The whole settings object comes back, so re-render rather than patching
      // state: the refresh moved renderVersion and the cache version, and the
      // icon previews are now at new URLs.
      state = body.settings;
      previews = body.previews || {};
      render();
      note.textContent = 'Done at ' + new Date().toLocaleTimeString() +
        '. Images are refreshed; the rest follows within ten minutes.';
    }).catch(function (err) {
      note.textContent = '';
      banner('bad', 'Could not force a refresh', [err.message]);
    }).then(function () {
      button.disabled = false;
    });
  });

  function load() {
    status('Loading…');
    api('/api/settings').then(function (body) {
      state = body.settings;
      previews = body.previews || {};
      banner('', '', []);
      render();
    }).catch(function (err) {
      status('Could not load settings');
      banner('bad', 'Could not load settings', [err.message]);
    });
  }

  load();
  // Fired alongside, not chained: the figures are read-only and unrelated to
  // the settings form, so a slow or failing stats read must not hold up the
  // screen a merchant actually came here to edit.
  loadStats();
})();
`;
}

module.exports = { html, script };
