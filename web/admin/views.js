/**
 * The admin's markup: one document, ten pages, one of them visible at a time.
 *
 * Every page is in the DOM from the first paint and the router only toggles
 * `hidden`. That is what makes the single Save honest — the client's collect()
 * reads every field on every page, so a merchant who edits their install copy,
 * clicks through to Configuration and presses Save there saves both. A
 * router that mounted and unmounted pages would quietly drop the first edit.
 *
 * Data never arrives in this HTML. It is fetched over /api/settings after the
 * page loads, which keeps this a static string the server can send before it has
 * read anything, and keeps merchant values out of the document the CSP applies
 * to.
 */

const {
  area, checkbox, colorField, counted, escapeHtml, field,
  navItem, saveBar, select, text, toggleStrip,
} = require('./markup.js');

const { STYLES } = require('./styles.js');
const { CATEGORIES, MAX_BENEFITS, BENEFIT_LENGTH, MAX_PRECACHE } = require('../validate.js');

/* ------------------------------------------------------------------ pieces */

function sidebar() {
  return (
    '<aside class="nav" id="nav">' +
    '<div class="navcount"><span>Total installs</span><b id="navInstalls">—</b></div>' +
    '<p class="navgroup">Dashboard</p>' +
    navItem('home', 'home', 'Home') +

    '<p class="navgroup">Settings</p>' +
    navItem('configuration', 'config', 'Configuration') +
    navItem('install-message', 'message', 'Install message') +
    navItem('cache-assets', 'cache', 'Cache assets') +
    navItem('offline-page', 'offline', 'Offline page') +
    navItem('offline-browsing', 'cache', 'Offline browsing', 'settings') +
    navItem('settings', 'settings', 'Settings') +

    '<p class="navgroup">Reports</p>' +
    navItem('reports', 'report', 'PWA / Performance') +
    navItem('analytics', 'analytics', 'Analytics') +

    '<p class="navgroup">Help &amp; support</p>' +
    navItem('setup', 'wizard', 'Quick setup wizard') +
    navItem('faqs', 'faq', 'FAQs') +

    '<div class="spacer"></div>' +
    '<div class="navfoot" id="navFoot"></div>' +
    '</aside>'
  );
}

/** A page wrapper. `head` is the title row; `body` the sections under it. */
function page(route, title, subtitle, body, actions) {
  return (
    '<section class="page" data-page="' + route + '" hidden>' +
    '<div class="pagehead"><div><h1>' + escapeHtml(title) + '</h1>' +
    '<p class="sub">' + subtitle + '</p></div>' +
    (actions || '') + '</div>' + body + '</section>'
  );
}

/** The phone sketch the preview panes share. `inner` fills the screen. */
function phone(id, inner) {
  return '<div class="phone"><div class="screen" id="' + id + '">' + inner + '</div></div>';
}

function tabs(group, items) {
  return (
    '<div class="tabs">' +
    items.map((item, i) =>
      '<button type="button" data-tab="' + group + '" data-tab-value="' + item[0] + '"' +
      (i === 0 ? ' class="on"' : '') + '>' + escapeHtml(item[1]) + '</button>'
    ).join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------- pages */

function homePage() {
  return page('home', 'Home', 'Everything the app is doing for this store, at a glance.',
    '<div id="homeBanners"></div>' +

    '<section>' +
    '<div class="between" style="margin-bottom:12px">' +
    '<div><h2 style="margin:0">Installs</h2>' +
    '<p class="hint" style="margin:2px 0 0">Counted on your storefront. Days run midnight to midnight UTC.</p></div>' +
    '<button type="button" class="secondary small" id="homeStatsReload">Refresh</button>' +
    '</div>' +
    '<div class="stats" id="homeTiles"></div>' +
    '<div class="chart" id="homeChart" style="margin-top:16px"></div>' +
    '<p class="axis" id="homeAxis"></p>' +
    '</section>' +

    '<section>' +
    '<h2>Two things to do by hand</h2>' +
    '<p class="hint">Neither can be done from here — both live in the theme, which this app has no ' +
    'permission to edit.</p>' +
    '<ol style="margin:0;padding-left:20px">' +
    '<li style="margin-bottom:8px">Turn on the <strong>Storefront PWA</strong> app embed in ' +
    '<span id="themeEditorLink">Theme editor &rsaquo; App embeds</span>. Nothing else has any effect until that is on.</li>' +
    '<li>Then <span id="checkLink">open <code>/apps/pwa/check</code> on your storefront</span> ' +
    'to confirm the manifest, the icons and the install path on a real page.</li>' +
    '</ol>' +
    '<p class="hint" style="margin-top:14px">The <a href="#/setup">Quick setup wizard</a> checks both ' +
    'of these against your live storefront and tells you which one is missing.</p>' +
    '</section>' +

    '<section>' +
    '<h2>Where to go</h2>' +
    '<p class="hint">What each page changes.</p>' +
    '<table class="what2">' +
    '<tr><td><a href="#/configuration">Configuration</a></td><td>The app\'s name, icon and colors — what a customer sees on their home screen.</td></tr>' +
    '<tr><td><a href="#/install-message">Install message</a></td><td>The card that invites customers to install, and what it says.</td></tr>' +
    '<tr><td><a href="#/cache-assets">Cache assets</a></td><td>What the service worker keeps, and the list it fetches ahead of time.</td></tr>' +
    '<tr><td><a href="#/offline-page">Offline page</a></td><td>What a customer sees with no connection.</td></tr>' +
    '<tr><td><a href="#/settings">Settings</a></td><td>Launch behaviour, shortcuts, iOS, screenshots, and the master switch.</td></tr>' +
    '<tr><td><a href="#/reports">Reports</a></td><td>Page speed and installability, measured against the live store.</td></tr>' +
    '</table>' +
    '</section>'
  );
}

function configurationPage() {
  const masks = [
    ['iconPreview', 'sq', 'Desktop &amp; iOS'],
    ['iconMaskableSquirclePreview', 'squircle', 'Android squircle'],
    ['iconMaskableCirclePreview', 'circle', 'Android circle'],
  ];

  return page('configuration', 'Configuration',
    'How your store looks as an installed app — its name, its icon and the colors it launches in.',
    '<div class="split">' +
    '<div>' +

    '<section>' +
    '<h2>Home screen</h2>' +
    '<p class="hint">What the app is called once it is installed.</p>' +
    '<div class="grid">' +
    field('name', 'App name', counted('name', 45, 'Your store'),
      'Shown in the install dialog and the app window title.') +
    field('shortName', 'Short name', counted('shortName', 12, 'Store'),
      'Under the home screen icon. Android truncates past about 12 characters.') +
    '</div>' +
    '<div style="margin-top:14px">' +
    field('description', 'Description', area('description', 300, 'What customers can do in the app'),
      'Shown in the richer install dialogs on desktop.') +
    '</div>' +
    '</section>' +

    '<section>' +
    '<h2>Logo</h2>' +
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
    '<button type="button" class="secondary" data-upload="icon">Add image</button>' +
    '<button type="button" class="secondary" data-remove="icon">Remove</button>' +
    '<span class="muted" id="iconMeta"></span>' +
    '</div>' +
    '</section>' +

    '<section>' +
    '<h2>Splash screen</h2>' +
    '<p class="hint">The window a customer sees before your storefront has painted.</p>' +
    '<div class="grid">' +
    colorField('themeColor', 'Theme color',
      'Tints the title bar and the Android status bar, and is the install button\'s default color.') +
    colorField('backgroundColor', 'Background color',
      'The splash screen while the store loads, and the padding around the Android icon. ' +
      'Match your storefront background, not your brand color.') +
    '</div>' +
    '</section>' +

    saveBar() +
    '</div>' +

    '<div class="previewpane">' +
    '<section>' +
    tabs('config', [['home', 'Home screen'], ['splash', 'Splash screen']]) +
    phone('configPhone', '') +
    '<p class="hint" style="margin-top:12px;text-align:center">A sketch, not a render. Wallpaper and ' +
    'icon corners are the device\'s, not yours.</p>' +
    '</section>' +
    '</div>' +
    '</div>'
  );
}

function installMessagePage() {
  return page('install-message', 'Install message',
    'The card that invites a customer to install. Where the browser allows it, the button opens the ' +
    'native install dialog; everywhere else it shows that browser\'s own directions.',
    '<div class="split">' +
    '<div>' +

    toggleStrip('installEnabled', 'Install message') +

    '<section>' +
    '<h2>Header</h2>' +
    field('installTitle', 'Title', counted('installTitle', 60, 'Install our app')) +
    '</section>' +

    '<section>' +
    '<h2>Benefits</h2>' +
    '<p class="hint">Up to ' + MAX_BENEFITS + ' short lines, shown as bullets above the message. ' +
    BENEFIT_LENGTH + ' characters each — longer than that and the card grows tall enough to cover ' +
    'the page it is sitting on. Leave them all empty for a compact card.</p>' +
    '<div id="benefits"></div>' +
    '<button type="button" class="secondary small" id="addBenefit">Add benefit</button>' +
    '</section>' +

    '<section>' +
    '<h2>Message</h2>' +
    field('installBody', 'Install message', area('installBody', 200,
      'Doesn\'t take up storage space. Just tap add to install.')) +
    '</section>' +

    '<section>' +
    '<h2>Button</h2>' +
    '<div class="grid">' +
    field('installButtonLabel', 'Install button text', counted('installButtonLabel', 24, 'Install')) +
    colorField('installButtonFg', 'Button text color', 'Leave blank to pick black or white automatically.') +
    colorField('installButtonBg', 'Button background color', 'Leave blank to use your theme color.') +
    '</div>' +
    '</section>' +

    '<section>' +
    '<h2>When it appears</h2>' +
    '<div class="grid">' +
    field('installDelaySeconds', 'Delay before showing',
      '<input type="number" id="installDelaySeconds" min="0" max="120">',
      'Seconds after the page loads. 0 shows it immediately.') +
    field('installPosition', 'Position', select('installPosition', [
      ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['bottom-bar', 'Full-width bar'],
    ])) +
    field('installDismissDays', 'Hide for, after dismissal',
      '<input type="number" id="installDismissDays" min="0" max="365">',
      'Days. 0 means show again on the next page view.') +
    '</div>' +
    '<p class="hint" style="margin-top:14px">You can also add <code>data-pwa-install</code> to any ' +
    'element in your theme — a nav link, a footer button — and it will open the same prompt.</p>' +
    '<div class="banner" style="margin-top:14px" id="previewStrip">' +
    '<strong>Checking it works?</strong> <span id="previewLink">Open your storefront with ' +
    '<code>?pwa-preview=1</code></span> and the card appears at once — no delay, and whatever this ' +
    'browser has dismissed before. Preview is not counted in your analytics.</div>' +
    '</section>' +

    saveBar() +
    '</div>' +

    '<div class="previewpane">' +
    '<section>' +
    tabs('install', [['android', 'Android screen'], ['ios', 'iOS screen']]) +
    phone('installPhone', '') +
    '<p class="hint" style="margin-top:12px">' +
    '<span id="installPreviewNote"></span></p>' +
    '</section>' +
    '</div>' +
    '</div>'
  );
}

function cachePage() {
  return page('cache-assets', 'Cache assets',
    'What the service worker keeps a copy of, so a returning customer downloads less.',
    '<div class="banner info" style="margin-bottom:14px">' +
    '<strong>These only bite where the worker has scope.</strong>' +
    '<p>On a stock Shopify storefront the worker is scoped to <code>/apps/pwa/</code> and never sees a ' +
    'product page, because Shopify strips the <code>Service-Worker-Allowed</code> header a proxy-served ' +
    'worker needs. Installing does not depend on any of this. ' +
    '<a href="#/offline-browsing">Offline browsing</a> gives the worker the whole storefront, and ' +
    'shows which case your store is in.</p>' +
    '</div>' +

    '<section>' +
    '<h2>Cache</h2>' +
    '<p class="hint">Reduce the time it takes to move from page to page by keeping your Shopify assets ' +
    '— CSS, images, Google Fonts — instead of fetching them on every visit.</p>' +
    toggleStrip('cacheEnabled', 'Cache assets') +
    '<div id="cacheRules">' +
    checkbox('cacheHomePage', 'Home page') +
    checkbox('cacheGoogleFonts', 'Google Fonts') +
    checkbox('cacheStorefront', 'Storefront pages — products, collections, blogs') +
    checkbox('cacheCssFiles', 'CSS and JavaScript files') +
    checkbox('cacheImages', 'Images') +
    '</div>' +
    '<p class="hint" style="margin:0">Carts, checkouts, accounts and search are never cached, whatever ' +
    'is ticked here. A stale price or a stale cart is worse than a slow one.</p>' +
    '</section>' +

    '<section>' +
    '<h2>Precache</h2>' +
    '<p class="hint">A list of specific files to fetch into the cache the first time a customer visits, ' +
    'rather than the first time each one is needed. Up to ' + MAX_PRECACHE + '. Every entry is a ' +
    'download that first visit pays for, so keep it to the files every page uses.</p>' +

    '<div id="precacheBlock">' +
    toggleStrip('precacheEnabled', 'Precache') +
    '<label>File URLs to precache</label>' +
    '<span class="sublabel" style="margin-bottom:10px">Paths on your storefront (<code>/cdn/shop/t/1/assets/base.css</code>) ' +
    'or full URLs on <code>cdn.shopify.com</code> or Google Fonts. Anything else is dropped when you save.</span>' +
    '<div id="precacheUrls"></div>' +
    '<button type="button" class="secondary small" id="addPrecache">Add file URL</button>' +
    '</div>' +
    '</section>' +

    '<section>' +
    '<h2>Not seeing your changes?</h2>' +
    '<p class="hint">Saving is instant here, but four different caches sit between this screen and a ' +
    'customer\'s phone. This forces the two that can be forced.</p>' +
    '<table class="what2">' +
    '<tr><td>App icon, launch screens</td><td><strong>Refreshed now.</strong> Every image gets a new ' +
    'address, so nothing can serve the old one.</td></tr>' +
    '<tr><td>Service worker cache</td><td><strong>Cleared on each visitor\'s next page view.</strong> ' +
    'The new worker deletes the old cache when it takes over.</td></tr>' +
    '<tr><td>Manifest and storefront script</td><td>Expire on their own within <strong>5 and 10 ' +
    'minutes</strong>. Shopify has no way to purge these early, so no button can.</td></tr>' +
    '<tr><td>Apps already on a home screen</td><td>Keep the name and icon captured when they were ' +
    'installed. Android may pick up a change eventually; <strong>iOS needs a reinstall</strong>.</td></tr>' +
    '</table>' +
    '<div class="row" style="margin-top:14px">' +
    '<button type="button" class="secondary" id="clearCache">Force a refresh</button>' +
    '<span class="muted" id="clearCacheNote"></span>' +
    '</div>' +
    '</section>' +

    saveBar()
  );
}

function offlinePage() {
  return page('offline-page', 'Offline page',
    'What a customer sees when the connection drops. Served from the cache, so it appears even when ' +
    'nothing else can load.',
    '<div class="split">' +
    '<div>' +

    toggleStrip('swOfflinePage', 'Offline page') +

    '<section>' +
    field('offlineTitle', 'Title', counted('offlineTitle', 60, 'You are offline')) +
    '<div style="margin-top:14px">' +
    field('offlineMessage', 'Message', area('offlineMessage', 200,
      'Unable to detect an internet connection. Please check your connectivity and try again.')) +
    '</div>' +
    '<p class="hint" style="margin-top:14px">The page carries a Try again button and reloads by itself ' +
    'the moment the connection returns, so neither needs saying here. Your wording is also used by the ' +
    'launch screen when the installed app is opened with no connection.</p>' +
    '</section>' +

    '<section>' +
    '<h2>Where it comes from</h2>' +
    '<p class="hint" style="margin:0">Turning this off stops the page being precached, so a customer ' +
    'with no connection gets the browser\'s own error instead. It costs one small HTML file per ' +
    'visitor, which is why it is on by default. Changing the wording bumps the cache version, so ' +
    'returning visitors pick it up on their next page view.</p>' +
    '</section>' +

    saveBar() +
    '</div>' +

    '<div class="previewpane">' +
    '<section>' +
    '<h2 style="margin-bottom:12px">Preview</h2>' +
    phone('offlinePhone', '') +
    '</section>' +
    '</div>' +
    '</div>'
  );
}

/*
 * Full offline browsing. Nothing here is a setting — the worker is the same
 * file either way. What changes is where it is served from, and that is decided
 * by something in front of Shopify, so this page checks, deploys and hands out
 * configs rather than saving anything. See web/edge.js.
 */
function offlineBrowsingPage() {
  const codeBlock = (id, label) =>
    '<div style="margin-top:12px">' +
    '<div class="between"><label style="margin:0">' + label + '</label>' +
    '<button type="button" class="secondary small" data-copy="' + id + '">Copy</button></div>' +
    '<textarea id="' + id + '" class="codebox" readonly spellcheck="false" rows="12"></textarea>' +
    '</div>';

  return page('offline-browsing', 'Offline browsing',
    'Let customers open pages they have already visited with no connection — product pages, ' +
    'collections, the home page.',

    '<section>' +
    '<div class="between">' +
    '<h2 style="margin:0">Status</h2>' +
    '<button type="button" class="secondary small" id="edgeCheck">Check again</button>' +
    '</div>' +
    '<div id="edgeStatus" style="margin-top:12px"><p class="hint" style="margin:0">Checking your storefront…</p></div>' +
    '</section>' +

    '<section>' +
    '<h2>Why this needs one extra step</h2>' +
    '<p class="hint" style="margin:0">A service worker only controls pages below the folder it is served ' +
    'from. Through Shopify it can only be served from <code>/apps/pwa/</code>, and Shopify strips the ' +
    'header that would widen it — so it never sees a product page. Served from <code>/sw.js</code> on ' +
    'your own domain it controls every page. Shopify cannot serve that file; something in front of your ' +
    'store has to. The storefront script detects it by itself the moment it is there — nothing to save ' +
    'here afterwards.</p>' +
    '</section>' +

    '<section>' +
    '<h2>Set it up with Cloudflare — one click</h2>' +
    '<p class="hint">For a store whose domain is on Cloudflare with the orange cloud (proxied) on its ' +
    'Shopify record. This uploads a small Worker and routes <strong>only</strong> ' +
    '<code>/sw.js</code> to it — nothing else on your storefront goes through it.</p>' +
    '<ol class="hint" style="padding-left:20px">' +
    '<li>In Cloudflare open <strong>My Profile › API Tokens › Create Token › Custom token</strong>.</li>' +
    '<li>Permissions: <code>Account › Workers Scripts › Edit</code>, <code>Zone › Workers Routes › ' +
    'Edit</code>, <code>Zone › Zone › Read</code>, and optionally <code>Zone › DNS › Read</code> so ' +
    'the app can warn you about a grey-cloud record.</li>' +
    '<li>Limit it to your store\'s zone, create it, and paste it below.</li>' +
    '</ol>' +
    '<div class="row" style="align-items:flex-end">' +
    '<div style="flex:1 1 280px">' +
    '<label for="cfToken">Cloudflare API token</label>' +
    '<input type="password" id="cfToken" autocomplete="off" spellcheck="false" placeholder="Paste the token">' +
    '</div>' +
    '<button type="button" id="cfDeploy">Deploy to Cloudflare</button>' +
    '</div>' +
    '<p class="hint" style="margin:10px 0 0">The token is used for this one request and never saved. ' +
    'You can delete it in Cloudflare as soon as this finishes; running this again later needs a new one.</p>' +
    '<div id="cfResult" style="margin-top:12px"></div>' +
    '</section>' +

    '<section>' +
    '<h2>Or set it up by hand</h2>' +
    '<p class="hint">The same thing, to paste yourself. Each one serves this app\'s worker at ' +
    '<code>/sw.js</code> with the <code>X-PWA-Root-Worker</code> header the storefront looks for.</p>' +
    '<details><summary>Cloudflare Worker (manual)</summary>' +
    '<p class="hint">Workers &amp; Pages › Create › Hello World › Edit code, replace everything with ' +
    'this, Deploy. Then Settings › Domains &amp; Routes › Add route <code id="edgeRouteHint">yourstore.com/sw.js</code>.</p>' +
    codeBlock('edgeCloudflare', 'worker.js') +
    '</details>' +
    '<details><summary>nginx (your own reverse proxy)</summary>' +
    '<p class="hint">Only if your domain already points at an nginx you run in front of Shopify. Goes ' +
    'inside that <code>server { }</code> block.</p>' +
    codeBlock('edgeNginx', 'nginx location') +
    '</details>' +
    '<details><summary>Apache .htaccess (your own reverse proxy)</summary>' +
    '<p class="hint">Only if Apache serves your domain and proxies it to Shopify. A store hosted by ' +
    'Shopify never reads an .htaccess.</p>' +
    codeBlock('edgeApache', '.htaccess') +
    '</details>' +
    '</section>' +

    '<section>' +
    '<h2>What gets cached</h2>' +
    '<p class="hint" style="margin:0">Pages are fetched from the network first and only served from the ' +
    'cache when there is no connection, so a customer online always sees live prices and stock. Carts, ' +
    'checkout and accounts are never cached. Which page types are kept is set on ' +
    '<a href="#/cache-assets">Cache assets</a>.</p>' +
    '</section>'
  );
}

function settingsPage() {
  return page('settings', 'Settings',
    'Launch behaviour, shortcuts, iOS, install-dialog screenshots — and the switch that turns the ' +
    'whole thing off.',

    '<section>' +
    '<h2>Status</h2>' +
    '<p class="hint">Two switches control this app, and they do different jobs. The theme app embed ' +
    'decides whether the tags are on the page at all — that is a theme change, made in the theme ' +
    'editor. The switch below leaves the theme alone and makes the manifest non-installable, which is ' +
    'the one to reach for if something looks wrong on a live store.</p>' +
    checkbox('enabled', 'Storefront PWA is active — customers can install the store as an app') +
    '<p class="hint" id="enabledNote" style="margin:0"></p>' +
    '</section>' +

    '<section>' +
    '<h2>Launch behaviour</h2>' +
    '<p class="hint">Where the app opens, and which pages count as part of it.</p>' +
    '<div class="grid">' +
    field('startUrl', 'Start URL', text('startUrl', '/?source=pwa'),
      'Opened on launch. Keeping a query parameter here lets you see app traffic separately in analytics.') +
    field('scope', 'Scope', text('scope', '/'),
      'Pages outside this open in a browser tab instead of the app window. <code>/</code> is almost always right.') +
    '</div>' +
    '<div class="grid" style="margin-top:14px">' +
    field('display', 'Display mode', select('display', [
      ['standalone', 'Standalone — own window, no browser UI'],
      ['minimal-ui', 'Minimal UI — a back and reload control'],
      ['fullscreen', 'Fullscreen — no system UI at all'],
      ['browser', 'Browser — an ordinary tab'],
    ]), 'Standalone is what makes it feel like an app.') +
    field('orientation', 'Orientation', select('orientation', [
      ['any', 'Any'], ['natural', 'Natural'], ['portrait', 'Portrait'], ['landscape', 'Landscape'],
    ])) +
    '</div>' +
    '</section>' +

    '<section>' +
    '<h2>Shortcuts</h2>' +
    '<p class="hint">Up to four. Long-press the icon on Android, right-click it on desktop.</p>' +
    '<div id="shortcuts"></div>' +
    '<button type="button" class="secondary small" id="addShortcut">Add shortcut</button>' +
    '</section>' +

    '<section>' +
    '<h2>Language and listing</h2>' +
    '<div class="grid">' +
    field('lang', 'Language', text('lang', 'en'),
      'A BCP&nbsp;47 tag, e.g. <code>en</code>, <code>ur</code>, <code>ar-AE</code>.') +
    field('dir', 'Text direction', select('dir', [
      ['auto', 'Automatic'], ['ltr', 'Left to right'], ['rtl', 'Right to left'],
    ])) +
    '</div>' +
    '<div style="margin-top:18px">' +
    '<label>Categories</label>' +
    '<span class="sublabel" style="margin:0 0 10px">What kind of app this is. Up to five; anything ' +
    'beyond that is dropped. Only some app catalogues read them, so this is low-stakes.</span>' +
    '<div class="cats">' +
    CATEGORIES.map((c) =>
      '<div class="check"><input type="checkbox" id="cat-' + c + '" data-category="' + c + '">' +
      '<label for="cat-' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</label></div>'
    ).join('') +
    '</div></div>' +
    '</section>' +

    '<section>' +
    '<h2>iOS</h2>' +
    '<p class="hint">Safari ignores most of the manifest and uses its own tags, so these are separate ' +
    'settings rather than duplicates.</p>' +
    checkbox('iosSplash', 'Generate iOS launch screens (nineteen sizes, from your icon and background color)') +
    field('iosStatusBarStyle', 'Status bar style', select('iosStatusBarStyle', [
      ['default', 'Default — dark text on light'],
      ['black', 'Black'],
      ['black-translucent', 'Translucent — content runs under the status bar'],
    ])) +
    '</section>' +

    '<section>' +
    '<h2>Install dialog screenshots</h2>' +
    '<p class="hint">Optional. With a screenshot present, Chrome shows a larger install dialog with a ' +
    'preview instead of a plain one-line prompt.</p>' +
    '<div class="grid">' +
    assetBlock('screenshotWide', 'Wide (desktop)', 'Landscape, e.g. 1280&times;800.', 'shot') +
    assetBlock('screenshotNarrow', 'Narrow (mobile)', 'Portrait, e.g. 750&times;1334.', 'shot') +
    '</div>' +
    '</section>' +

    '<section>' +
    '<h2>Service worker</h2>' +
    '<p class="hint">Registers a worker on your storefront. On a stock Shopify store its scope stays ' +
    '<code>/apps/pwa/</code>, which is enough to make a cold offline launch land on the app shell and ' +
    'not enough to serve your catalogue. <strong>Installing does not depend on it.</strong></p>' +
    checkbox('swEnabled', 'Register a service worker') +
    '</section>' +

    saveBar()
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

function reportsPage() {
  return page('reports', 'PWA / Performance reports',
    'Page speed measured by Google PageSpeed Insights, and installability measured by this app ' +
    'against your live storefront.',

    '<div id="reportsBody">' +

    '<section>' +
    '<div class="between">' +
    '<div class="row">' +
    // The page comes before the device on purpose: which page you measure
    // changes the score far more than mobile versus desktop does, and a
    // merchant who has only ever seen a home page score does not know that.
    field('reportTarget', 'Page to measure',
      select('reportTarget', [
        ['start', 'App start URL'],
        ['home', 'Home page'],
        ['collection', 'Collection page'],
        ['product', 'Product page'],
        ['page', 'Page'],
        ['custom', 'Custom path'],
      ])) +
    field('reportStrategy', 'Measure as',
      select('reportStrategy', [['mobile', 'Mobile'], ['desktop', 'Desktop']])) +
    '</div>' +
    '<button type="button" id="generateReport">Generate report</button>' +
    '</div>' +

    // Hidden for the two targets that need no input. The prefix is shown
    // rather than typed, so a merchant can paste the handle straight from
    // their own admin without working out what goes in front of it.
    '<div id="reportPathRow" hidden style="margin-top:14px">' +
    field('reportPath', 'Which one',
      '<div class="row" style="gap:0;align-items:stretch">' +
      '<span class="prefix" id="reportPathPrefix">/collections/</span>' +
      text('reportPath', 'summer-sale') +
      '</div>',
      '<span id="reportPathHint">The handle from your Shopify admin, or a full path. ' +
      'You can also paste the whole URL from your storefront.</span>') +
    '</div>' +

    '<p class="hint" style="margin:14px 0 0" id="reportNote">A run takes up to a minute — PageSpeed ' +
    'loads your store on a throttled connection, which is the point of it.</p>' +
    '</section>' +

    '<section>' +
    '<h2>History</h2>' +
    '<p class="hint">The most recent runs. Older ones drop off the bottom.</p>' +
    '<div id="reportList"></div>' +
    '</section>' +

    '<section id="reportDetail" hidden></section>' +
    '</div>'
  );
}

function analyticsPage() {
  const rangePicker =
    '<div class="row">' +
    // 30 to match the server's own default, and the Home page copy that quotes
    // it. A selector that opened on a different window than the dashboard next
    // to it would have the two pages disagreeing on the same store.
    field('statsRange', 'Period', select('statsRange', [
      ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 180 days'],
    ], '30')) +
    '<button type="button" class="secondary small" id="statsReload" style="margin-top:22px">Refresh</button>' +
    '</div>';

  return page('analytics', 'Analytics',
    'Installs and dismissals, split by device. Counted on your storefront — nothing about the ' +
    'customer is recorded.',

    '<div id="analyticsBody">' +

    '<section>' +
    '<h2>App installed</h2>' +
    '<div class="stats" id="installedTiles"></div>' +
    '</section>' +

    '<section>' +
    '<h2>App dismissed</h2>' +
    '<p class="hint">A customer who was shown the card and said no. The corner &times; is not counted ' +
    '— that one means "not on this screen", and the card comes back on the next page view.</p>' +
    '<div class="stats" id="dismissedTiles"></div>' +
    '</section>' +

    '<section>' +
    '<h2>Total app installed</h2>' +
    '<div class="chart" id="statChart"></div>' +
    '<p class="axis" id="statAxis"></p>' +
    '</section>' +

    '<section>' +
    '<h2>The funnel</h2>' +
    '<p class="hint">Every step from "the card appeared" to "the app was opened again".</p>' +
    '<div class="stats" id="funnelTiles"></div>' +
    '<p class="hint" id="statNote" style="margin:14px 0 0"></p>' +
    '</section>' +
    '</div>',

    rangePicker
  );
}

function setupPage() {
  return page('setup', 'Quick setup wizard',
    'The same checks a report scores you on, run against your live storefront.',
    '<section>' +
    '<div class="between">' +
    '<p class="hint" style="margin:0" id="setupWhen">Not run yet.</p>' +
    '<button type="button" id="runSetup">Run the checks</button>' +
    '</div>' +
    '</section>' +
    '<div id="setupResult"></div>'
  );
}

function faqsPage() {
  const faqs = [
    ['Why does my store need the app embed turned on?',
      'The embed is what puts this app\'s two tags on your storefront pages. Without it there is no ' +
      'manifest link and no script, so no browser has any idea the store is installable. It lives in ' +
      'Theme editor › App embeds because adding tags to a theme is a theme change, and this app has no ' +
      'permission to edit your theme.'],

    ['Why can\'t my customers browse offline?',
      'A service worker may only control pages below the folder it is served from. Widening that needs ' +
      'a Service-Worker-Allowed header, and Shopify strips that header when it proxies /apps/pwa/. So ' +
      'the worker\'s scope stays /apps/pwa/ and it never sees a product page. The fix is to serve the ' +
      'worker at /sw.js on your own domain, which needs something in front of Shopify — the Offline ' +
      'browsing page sets that up on Cloudflare in one click, or gives you the config to paste.'],

    ['Why is my iOS install count lower than I expected?',
      'Safari has no install event of any kind. An iOS install is invisible until the app is first ' +
      'opened, and it is counted then. A customer who adds the app to their home screen and does not ' +
      'open it for a week appears a week late.'],

    ['I changed the name and icon. Why does my phone still show the old one?',
      'An installed app keeps the name and icon it captured at install time. Android may pick up a ' +
      'change eventually; iOS needs the app removed and added again. For customers who have not ' +
      'installed yet, Force a refresh on the Cache assets page moves every image URL at once.'],

    ['What does the PWA score actually measure?',
      'Ours, not Google\'s — Lighthouse dropped its PWA category in 2024. It is the share of the ' +
      'installability conditions this app is responsible for that your live storefront currently ' +
      'meets: the manifest reachable through the proxy, the icon sizes Chrome insists on, the embed ' +
      'on the page. The Quick setup wizard lists them one by one.'],

    ['Does any of this track my customers?',
      'No. The storefront script sends five counters — shown, clicked, dismissed, installed, launched ' +
      '— with the device family and nothing else. No IP, no user agent, no customer, no session is ' +
      'stored or derivable from the file. The counters live in one small JSON file per store and are ' +
      'deleted when the app is uninstalled.'],

    ['Why are there two ways to turn the app off?',
      'They do different things. The app embed decides whether the tags are on the page at all, and ' +
      'turning it off is a theme change. The switch on the Settings page leaves the theme alone and ' +
      'makes the manifest non-installable, which takes two seconds and is the one to reach for when ' +
      'something looks wrong on a live store.'],

    ['Do I need a PageSpeed API key?',
      'Not to start. Without one the app uses Google\'s unauthenticated quota, which is fine for the ' +
      'occasional run and will start refusing if you lean on it. Set PAGESPEED_API_KEY on the server ' +
      'to use your own.'],
  ];

  return page('faqs', 'FAQs', 'The questions this app actually gets asked.',
    '<section>' +
    faqs.map(([q, a]) =>
      '<details><summary>' + escapeHtml(q) + '</summary><p>' + escapeHtml(a) + '</p></details>'
    ).join('') +
    '</section>'
  );
}

/* ------------------------------------------------------------------- shell */

function html(shop, apiKey) {
  const storeHandle = shop ? shop.replace(/\.myshopify\.com$/, '') : null;

  // Both are absolute URLs to admin.shopify.com and the storefront, built here
  // because the client script has neither the shop nor the handle — it only
  // ever learns the shop from a signed token, and that arrives later.
  const themeEditorLink = storeHandle
    ? 'https://admin.shopify.com/store/' + escapeHtml(storeHandle) + '/themes/current/editor?context=apps'
    : '';
  const checkLink = shop ? 'https://' + escapeHtml(shop) + '/apps/pwa/check' : '';
  const previewLink = shop ? 'https://' + escapeHtml(shop) + '/?pwa-preview=1' : '';

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
<body data-shop="${escapeHtml(shop || '')}" data-theme-editor="${themeEditorLink}" data-check="${checkLink}" data-preview="${previewLink}">
<div class="shell" id="shell">
  ${sidebar()}
  <button type="button" class="navtoggle" id="navToggle" aria-label="Collapse the menu">&#8249;</button>
  <div class="content">
    ${!shop ? '<div class="banner bad">Open this app from the Shopify admin. Loaded directly it has no shop context and cannot read settings.</div>' : ''}
    ${!apiKey ? '<div class="banner bad">SHOPIFY_API_KEY is not set on the server, so App Bridge cannot load and settings cannot be saved.</div>' : ''}
    <div id="banners"></div>
    ${homePage()}
    ${configurationPage()}
    ${installMessagePage()}
    ${cachePage()}
    ${offlinePage()}
    ${offlineBrowsingPage()}
    ${settingsPage()}
    ${reportsPage()}
    ${analyticsPage()}
    ${setupPage()}
    ${faqsPage()}
  </div>
</div>
<script src="/admin.js"></script>
</body>
</html>
`;
}

module.exports = { html };
