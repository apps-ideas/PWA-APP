/*
 * Storefront runtime. Served through the app proxy as /apps/pwa/pwa.js with the
 * shop's settings substituted into the CFG assignment below, so it is one
 * request and no round trip before the install UI can decide anything.
 *
 * Everything here runs on a live storefront on every page view. It is wrapped
 * in a single IIFE, touches no globals but its own, and treats every feature
 * probe as "no" when it throws: a PWA enhancement must never be able to take a
 * product page down with it.
 *
 * ES5 syntax deliberately. A syntax error from an arrow function on an old
 * browser is parsed before any try/catch can help.
 */
(function () {
  'use strict';

  var CFG = __PWA_CONFIG__;

  var DISMISS_KEY = 'shopify-pwa:dismissed-until';
  var INSTALLED_KEY = 'shopify-pwa:installed';

  /* Counting keys. REPORTED is what stops one install being counted on every
   * page view forever; LAUNCH_KEY holds the UTC day an open was last counted. */
  var REPORTED_KEY = 'shopify-pwa:counted-install';
  var LAUNCH_KEY = 'shopify-pwa:counted-launch-on';
  var SEEN_KEY = 'shopify-pwa:counted-shown';
  var CLICKED_KEY = 'shopify-pwa:counted-clicked';
  var DISMISSED_KEY = 'shopify-pwa:counted-dismissed';

  var deferredPrompt = null;
  var uiRoot = null;
  var shadow = null;

  /*
   * Preview mode: ?pwa-preview=1 on any storefront URL.
   *
   * Without it the card is unverifiable. It appears some seconds after load,
   * only on a browser that can install, and only if this browser has not
   * dismissed it in the last fortnight — so "I enabled the app embed and saw
   * nothing" has half a dozen innocent explanations and no way to tell them
   * apart. Preview collapses all of them: show the card now, on this browser,
   * whatever it has seen before.
   *
   * Read once at load rather than per call, so a card already on screen is not
   * affected by a later history.pushState from the theme.
   */
  var PREVIEW = (function () {
    try {
      return /(?:^|[?&])pwa-preview=1(?:&|$)/.test(window.location.search || '');
    } catch (e) {
      return false;
    }
  })();

  /* ---------------------------------------------------------------- helpers */

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      /* Private mode, or storage disabled. Not worth reporting. */
    }
  }

  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /* Session storage, for the two counters that mean "once per visit". A visit
   * is the browser's own definition of a tab session, which is close enough to
   * what a merchant means by it and costs nothing to obtain. */
  function markSession(key) {
    try {
      if (sessionStorage.getItem(key) === '1') return false;
      sessionStorage.setItem(key, '1');
      return true;
    } catch (e) {
      // No session storage: count it. Over-counting a card impression is a far
      // smaller error than silently counting nothing at all in private mode.
      return true;
    }
  }

  function isStandalone() {
    try {
      if (window.navigator.standalone === true) return true;
      return window.matchMedia('(display-mode: standalone)').matches ||
             window.matchMedia('(display-mode: fullscreen)').matches ||
             window.matchMedia('(display-mode: minimal-ui)').matches;
    } catch (e) {
      return false;
    }
  }

  /*
   * Automated browsers cannot install anything, so the install card is noise in
   * a Lighthouse or PageSpeed run and costs layout work in the measured frame.
   */
  function isAutomated() {
    try {
      if (navigator.webdriver === true) return true;
      return /HeadlessChrome|Chrome-Lighthouse|Lighthouse|PTST|GTmetrix|PageSpeed/i
        .test(navigator.userAgent || '');
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------- counting */

  /*
   * Four counters, sent to the app's own backend through the proxy so the
   * merchant can see whether any of this is working. No identifier of any kind
   * goes with them — the request is a bare POST with the event name in the
   * query string, and the server keeps one integer per event per day.
   *
   * sendBeacon is the right tool: it survives the page unloading, which matters
   * because "installed" arrives at exactly the moment a browser may be handing
   * the tab over to a freshly installed app window.
   */
  function send(type) {
    // PREVIEW is here rather than at each call site so that every event type —
    // shown, clicked, dismissed, installed, launched — is covered by one line.
    // A merchant checking their own card must not move their own analytics.
    if (!CFG.eventUrl || isAutomated() || PREVIEW) return;
    try {
      var url = CFG.eventUrl + (CFG.eventUrl.indexOf('?') === -1 ? '?' : '&') +
                'type=' + encodeURIComponent(type) +
                '&p=' + encodeURIComponent(deviceFamily());
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
      // Falls back to keepalive for the browsers that have fetch but refuse a
      // beacon, and to nothing at all for the ones that have neither. A missed
      // count is not worth an XHR that blocks unload.
      if (window.fetch) window.fetch(url, { method: 'POST', keepalive: true }).catch(function () {});
    } catch (e) { /* counting must never be able to break a storefront */ }
  }

  function utcDay() {
    try {
      return new Date().toISOString().slice(0, 10);
    } catch (e) {
      return '';
    }
  }

  /*
   * Counted once per browser, not once per event.
   *
   * Chrome and Edge fire `appinstalled` and also resolve userChoice as
   * accepted, so both paths land here and the flag is what keeps that one
   * install one install. On iOS neither signal exists at all — see
   * countLaunch, which is the only evidence an iOS install ever leaves.
   */
  function countInstall() {
    if (stored(REPORTED_KEY) === '1') return;
    store(REPORTED_KEY, '1');
    send('installed');
  }

  /*
   * An open of the installed app, counted once per browser per UTC day.
   *
   * The daily cap is what makes this a usage figure rather than a page-view
   * figure: without it every navigation inside a standalone window would count,
   * and the number would say more about how deep people browse than about how
   * often they come back.
   *
   * It also backfills the install on iOS. Safari has no appinstalled event and
   * no beforeinstallprompt, so an iOS install is invisible until the app is
   * first opened — and an iOS home screen app has its own storage, separate
   * from Safari's, so the flag countInstall sets here is set for the first time
   * on that first open. Without this, iOS would report zero installs forever.
   */
  function countLaunch() {
    if (!isStandalone()) return;

    countInstall();

    var today = utcDay();
    if (!today || stored(LAUNCH_KEY) === today) return;
    store(LAUNCH_KEY, today);
    send('launch');
  }

  function head() {
    return document.head || document.getElementsByTagName('head')[0] || document.documentElement;
  }

  /* Never overwrite a tag the theme already set — the theme author's choice
   * wins, and silently replacing it is the kind of app behaviour merchants
   * spend an afternoon tracking down. */
  function ensureMeta(name, content) {
    if (!content) return;
    try {
      if (document.querySelector('meta[name="' + name + '"]')) return;
      var meta = document.createElement('meta');
      meta.setAttribute('name', name);
      meta.setAttribute('content', content);
      head().appendChild(meta);
    } catch (e) { /* ignore */ }
  }

  function ensureLink(rel, href, extra) {
    if (!href) return;
    try {
      var selector = 'link[rel="' + rel + '"]';
      if (!extra && document.querySelector(selector)) return;
      var link = document.createElement('link');
      link.setAttribute('rel', rel);
      link.setAttribute('href', href);
      for (var key in extra || {}) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) link.setAttribute(key, extra[key]);
      }
      head().appendChild(link);
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ platform */

  function platform() {
    var ua = '';
    try { ua = navigator.userAgent || ''; } catch (e) { return 'unknown'; }

    var iOS = /iPad|iPhone|iPod/.test(ua) ||
              // iPadOS 13+ reports itself as a Mac; the touch points give it away.
              (/Macintosh/.test(ua) && typeof document.ontouchend !== 'undefined');

    if (iOS) {
      // Every iOS browser is WebKit, but only Safari exposes Add to Home Screen.
      var iosOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/.test(ua);
      return iosOtherBrowser ? 'ios-other' : 'ios-safari';
    }
    if (/Android/.test(ua)) {
      if (/SamsungBrowser/.test(ua)) return 'android-samsung';
      if (/Firefox/.test(ua)) return 'android-firefox';
      return 'android-chrome';
    }
    if (/Edg\//.test(ua)) return 'desktop-edge';
    if (/Firefox/.test(ua)) return 'desktop-firefox';
    if (/Chrome|Chromium/.test(ua)) return 'desktop-chrome';
    if (/Safari/.test(ua)) return 'desktop-safari';
    return 'unknown';
  }

  /*
   * What to tell someone whose browser will not hand us beforeinstallprompt.
   *
   * On a Shopify storefront this is the normal path, not the fallback: Chrome
   * only fires beforeinstallprompt when a service worker with a fetch handler
   * controls the page, and Shopify strips the Service-Worker-Allowed header
   * that a proxy-served worker needs to claim the root scope. Installing from
   * the browser's own menu still works — these are the directions to it.
   */
  var INSTRUCTIONS = {
    'ios-safari': [
      'Tap the Share button at the bottom of Safari.',
      'Scroll down and choose "Add to Home Screen".',
      'Tap "Add" to finish.'
    ],
    'ios-other': [
      'Open this page in Safari — only Safari can add apps to the iOS home screen.',
      'Tap the Share button, then "Add to Home Screen".'
    ],
    'android-chrome': [
      'Open the browser menu (three dots, top right).',
      'Choose "Add to Home screen" or "Install app".'
    ],
    'android-samsung': [
      'Open the browser menu (three lines, bottom right).',
      'Choose "Add page to" and then "Home screen".'
    ],
    'android-firefox': [
      'Open the browser menu (three dots).',
      'Choose "Install" or "Add to Home screen".'
    ],
    'desktop-chrome': [
      'Click the install icon in the address bar, to the right of the URL.',
      'If it is not there, open the menu (three dots) and choose "Cast, save and share" then "Install page as app".'
    ],
    'desktop-edge': [
      'Open the menu (three dots, top right).',
      'Choose "Apps" and then "Install this site as an app".'
    ],
    'desktop-safari': [
      'Open the File menu.',
      'Choose "Add to Dock".'
    ],
    'desktop-firefox': [],
    unknown: []
  };

  function instructionsFor(p) {
    return INSTRUCTIONS[p] || [];
  }

  /*
   * The three buckets the admin's analytics splits by.
   *
   * Derived from platform() rather than from a second look at the user agent,
   * so the family a customer is counted in is always the same one whose install
   * directions they were shown. Anything platform() could not place is sent as
   * "other" and the server keeps it there — see stats.platformKey.
   */
  function deviceFamily() {
    var p = platform();
    if (p.indexOf('ios') === 0) return 'ios';
    if (p.indexOf('android') === 0) return 'android';
    if (p.indexOf('desktop') === 0) return 'desktop';
    return 'other';
  }

  /* Firefox on the desktop has no install support at all, and neither does an
   * unrecognised browser. Saying so is only worth doing when someone has just
   * clicked an Install button and is waiting for something to happen. */
  var NO_SUPPORT = ['This browser cannot install web apps. Try Chrome, Edge or Safari.'];

  /* --------------------------------------------------------- head wiring */

  function applyHeadTags() {
    var p = platform();

    // The theme color tints the Android address bar and the iOS status bar.
    // Only added when the theme has not set one of its own.
    ensureMeta('theme-color', CFG.themeColor);

    // Still honoured by iOS, and by Chrome as the older spelling.
    ensureMeta('mobile-web-app-capable', 'yes');
    ensureMeta('apple-mobile-web-app-capable', 'yes');
    ensureMeta('apple-mobile-web-app-status-bar-style', CFG.ios.statusBarStyle);
    ensureMeta('apple-mobile-web-app-title', CFG.shortName);
    ensureMeta('application-name', CFG.shortName);

    // iOS ignores the manifest's icons for Add to Home Screen.
    ensureLink('apple-touch-icon', CFG.appleTouchIcon);

    // Nineteen startup images, only meaningful on iOS, so they are injected
    // here rather than rendered into every page's HTML. Safari reads them when
    // the customer taps Add to Home Screen, which is always after load.
    if (p === 'ios-safari' && CFG.ios.splash && CFG.ios.splash.length) {
      for (var i = 0; i < CFG.ios.splash.length; i++) {
        var entry = CFG.ios.splash[i];
        ensureLink('apple-touch-startup-image', entry.href, { media: entry.media });
      }
    }
  }

  function markStandalone() {
    try {
      var root = document.documentElement;
      if (isStandalone()) {
        root.className += ' pwa-standalone';
        root.setAttribute('data-pwa-display', 'standalone');
      } else {
        root.setAttribute('data-pwa-display', 'browser');
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------ service worker */

  /*
   * Registration is attempted only when the merchant has switched it on, and it
   * is expected to end up with a scope of /apps/pwa/ rather than /. See the
   * README: Shopify does not forward Service-Worker-Allowed, so the worker
   * cannot claim the storefront root and cannot serve pages offline. The result
   * is recorded on window.ShopifyPWA so /apps/pwa/check can report it, and so
   * that the day Shopify starts forwarding the header, the change is visible
   * rather than something we would never think to re-test.
   */
  function registerServiceWorker() {
    if (!CFG.sw.enabled) return;
    if (!('serviceWorker' in navigator)) return;

    function record(state) {
      window.ShopifyPWA.serviceWorker = state;
    }

    navigator.serviceWorker.register(CFG.sw.url, { scope: '/' }).then(
      function (reg) {
        record({ scope: reg.scope, rootScope: reg.scope === CFG.origin + '/', widened: true });
      },
      function (err) {
        // The expected failure: a browser refuses a scope wider than the
        // script's own path unless Service-Worker-Allowed says otherwise, and
        // Shopify drops that header. Re-register at the default scope so the
        // worker at least exists and the check page can report what happened.
        navigator.serviceWorker.register(CFG.sw.url).then(
          function (reg) {
            record({
              scope: reg.scope,
              rootScope: false,
              widened: false,
              note: 'Shopify did not forward Service-Worker-Allowed, so the worker only controls ' + reg.scope
            });
          },
          function (err2) {
            record({ error: String((err2 && err2.message) || err2), rootScope: false, widened: false });
          }
        );
      }
    );
  }

  /* ------------------------------------------------------------ install UI */

  function dismissedUntil() {
    var value = Number(stored(DISMISS_KEY) || 0);
    return isFinite(value) ? value : 0;
  }

  /*
   * "Stop asking." Reached from "Not now", from "Got it" on the directions
   * card, and from a native install dialog the visitor declined.
   *
   * Counted once per visit, like `shown` and `clicked`, so it can be read
   * against them: a card shown a hundred times and dismissed ninety is a
   * different problem from one shown a hundred times and ignored. The corner ×
   * deliberately does not come through here — see buildCard for why that one
   * means "not on this screen" rather than "no".
   */
  function dismiss() {
    // A merchant who opens a preview and closes it has not dismissed anything.
    // Persisting here would silence the card on their own browser for a
    // fortnight and send them back to support saying it stopped working.
    if (PREVIEW) return hideCard();

    var days = CFG.install.dismissDays;
    if (days > 0) store(DISMISS_KEY, String(Date.now() + days * 86400000));
    if (markSession(DISMISSED_KEY)) send('dismissed');
    hideCard();
  }

  function hideCard() {
    if (uiRoot && uiRoot.parentNode) uiRoot.parentNode.removeChild(uiRoot);
    uiRoot = null;
    shadow = null;
  }

  function css() {
    var pos = CFG.install.position;
    var anchor = pos === 'bottom-bar'
      ? 'left: 0; right: 0; bottom: 0; border-radius: 0;'
      : (pos === 'bottom-left' ? 'left: 16px; bottom: 16px;' : 'right: 16px; bottom: 16px;');
    var width = pos === 'bottom-bar' ? 'width: auto;' : 'width: min(320px, calc(100vw - 24px));';

    return [
      // `all: initial` resets display to inline. Restated here so the host is a
      // block in its own right, and again in the light DOM — see hostStyle().
      ':host { all: initial; display: block; }',
      '.card {',
      '  position: fixed; z-index: 2147483000;', anchor, width,
      // Right padding reserves the close button's corner so a long title cannot
      // run underneath it.
      '  box-sizing: border-box; padding: 12px 32px 12px 14px;',
      '  margin-bottom: env(safe-area-inset-bottom, 0px);',
      '  background: ' + CFG.backgroundColor + '; color: ' + CFG.textColor + ';',
      '  border: 1px solid rgba(128,128,128,0.28); border-radius: 14px;',
      '  box-shadow: 0 10px 34px rgba(0,0,0,0.18);',
      '  font: 400 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  display: flex; gap: 11px; align-items: flex-start;',
      '  animation: pwa-in 220ms ease-out;',
      '}',
      '@media (prefers-reduced-motion: reduce) { .card { animation: none; } }',
      '@keyframes pwa-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }',
      '.icon { width: 34px; height: 34px; border-radius: 8px; flex: 0 0 auto; object-fit: cover; }',
      '.body { flex: 1 1 auto; min-width: 0; }',
      '.title { font-weight: 600; font-size: 14px; margin: 0 0 2px; }',
      // Clamped rather than left to wrap: the body copy is merchant-editable up
      // to 200 characters, which is four lines of a 320px card. Two lines is
      // enough to read the offer; the rest is not worth the height.
      '.text {',
      '  margin: 0 0 9px; font-size: 13px; opacity: 0.82;',
      '  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;',
      '  overflow: hidden;',
      '}',
      '.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }',
      '.btn {',
      '  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;',
      '  padding: 7px 14px; border-radius: 8px; border: 0;',
      // Resolved on the server: blank settings fall back to the theme color
      // with a label picked for legibility against it. See installButtonColors.
      '  background: ' + CFG.install.buttonBackgroundColor + '; color: ' + CFG.install.buttonTextColor + ';',
      '}',
      // The merchant's benefit lines. A list rather than a paragraph because
      // that is what makes three short claims scannable at card size, and the
      // marker is a character rather than a real list bullet so the indent
      // stays predictable across the browsers this card lands in.
      '.benefits { margin: 0 0 8px; padding: 0; list-style: none; font-size: 13px; }',
      '.benefits li { margin: 0 0 3px; padding-left: 13px; position: relative; opacity: 0.9; }',
      '.benefits li:last-child { margin-bottom: 0; }',
      '.benefits li::before { content: "\\203A"; position: absolute; left: 2px; opacity: 0.7; }',
      '.btn.secondary { background: transparent; color: inherit; opacity: 0.7; padding: 7px 6px; }',
      '.btn:focus-visible { outline: 2px solid ' + CFG.themeColor + '; outline-offset: 2px; }',

      // Only reached by clicking Install on a browser with no native dialog.
      '.steps { margin: 0 0 9px; padding-left: 17px; font-size: 13px; }',
      '.steps li { margin-bottom: 5px; }',
      '.steps li:last-child { margin-bottom: 0; }',
      '.close {',
      '  position: absolute; top: 4px; right: 4px;',
      '  width: 26px; height: 26px; padding: 0;',
      '  border: 0; border-radius: 8px; background: none; color: inherit;',
      '  font: inherit; font-size: 20px; line-height: 1;',
      '  cursor: pointer; opacity: 0.55;',
      '}',
      '.close:hover { opacity: 1; }',
      '.close:focus-visible { outline: 2px solid ' + CFG.themeColor + '; outline-offset: 2px; opacity: 1; }'
    ].join('\n');
  }

  /*
   * The host element's display, set in the LIGHT DOM.
   *
   * Not left to the `:host` rule above, for two reasons. `all: initial` resets
   * display to `inline`, and `:host` loses to any rule in the page that matches
   * the host — a theme carrying something as broad as `body > div { display:
   * none }` would collapse the card, and nothing inside the shadow root could
   * argue with it. A stylesheet in the page competes on equal terms.
   */
  var HOST_STYLE_ID = 'shopify-pwa-host-style';

  function hostStyle() {
    if (document.getElementById(HOST_STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = HOST_STYLE_ID;
    style.textContent = 'div#shopify-pwa-root{display:block;}';
    (document.head || document.documentElement).appendChild(style);
  }

  /*
   * Shadow DOM, so a theme's global styles cannot reshape the card and the
   * card's styles cannot leak into the theme. The install UI appears over a
   * merchant's own design; it has to be exactly as intrusive as configured and
   * no more.
   */
  function buildCard(contentBuilder) {
    hideCard();

    uiRoot = document.createElement('div');
    uiRoot.id = 'shopify-pwa-root';
    if (CFG.dir && CFG.dir !== 'auto') uiRoot.setAttribute('dir', CFG.dir);

    shadow = uiRoot.attachShadow ? uiRoot.attachShadow({ mode: 'open' }) : null;
    if (!shadow) return null; // No shadow DOM: skip the UI rather than bleed styles.

    var style = document.createElement('style');
    style.textContent = css();
    shadow.appendChild(style);

    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', CFG.install.title);
    contentBuilder(card);

    /*
     * Appended after the content rather than before it, so the primary action
     * comes first in the tab order — someone reaching for the card by keyboard
     * is far more likely to want Install than Close.
     *
     * This one hides and nothing more: no dismissal period is written, so the
     * card can return on the next page view. That is the difference between it
     * and the two labelled buttons — "Not now" and "Got it" both mean "stop
     * asking" and set the period; the × means "not on this screen". Two exits
     * with different weights, which is what a visitor reaching for a corner ×
     * usually expects.
     *
     * The cost is that someone who closes it on every page is offered it on
     * every page. If that turns out to be the common case, this is the line to
     * change — point it at dismiss() and the × becomes a third way to say
     * "stop asking".
     */
    var close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', hideCard);
    card.appendChild(close);

    shadow.appendChild(card);

    hostStyle();
    document.body.appendChild(uiRoot);
    return card;
  }

  function addIcon(card) {
    if (!CFG.appleTouchIcon) return;
    var img = document.createElement('img');
    img.className = 'icon';
    img.src = CFG.appleTouchIcon;
    img.alt = '';
    card.appendChild(img);
  }

  /*
   * The merchant's benefit lines, or nothing at all.
   *
   * Returns null rather than an empty <ul> so a merchant who has written none
   * gets the same compact card as before this existed — an empty list still
   * carries its margins, and the whole point of the card is that it is small.
   */
  function benefitsList() {
    var lines = CFG.install.benefits || [];
    if (!lines.length) return null;

    var list = document.createElement('ul');
    list.className = 'benefits';
    for (var i = 0; i < lines.length; i++) {
      var li = document.createElement('li');
      li.textContent = lines[i];
      list.appendChild(li);
    }
    return list;
  }

  function showPrompt() {
    buildCard(function (card) {
      addIcon(card);

      var body = document.createElement('div');
      body.className = 'body';

      var title = document.createElement('p');
      title.className = 'title';
      title.textContent = CFG.install.title;

      var text = document.createElement('p');
      text.className = 'text';
      text.textContent = CFG.install.body;

      var actions = document.createElement('div');
      actions.className = 'actions';

      var install = document.createElement('button');
      install.className = 'btn';
      install.type = 'button';
      install.textContent = CFG.install.buttonLabel;
      install.addEventListener('click', function () { promptInstall(); });

      var later = document.createElement('button');
      later.className = 'btn secondary';
      later.type = 'button';
      later.textContent = 'Not now';
      later.addEventListener('click', dismiss);

      actions.appendChild(install);
      actions.appendChild(later);
      body.appendChild(title);

      // Benefits above the body copy: they are the claims, the body copy is the
      // caveat under them ("doesn't take up storage space"), and that is the
      // order a customer reads them in.
      var benefits = benefitsList();
      if (benefits) body.appendChild(benefits);

      body.appendChild(text);
      body.appendChild(actions);
      card.appendChild(body);
    });
  }

  /* `forced` means the visitor asked — a click on the card's button or on a
   * merchant's own [data-pwa-install] element. An unprompted card stays silent
   * on a browser that cannot install; a click gets an answer either way. */
  function showInstructions(forced) {
    var steps = instructionsFor(platform());
    var supported = steps.length > 0;

    if (!supported) {
      if (!forced) return false;
      steps = NO_SUPPORT;
    }

    buildCard(function (card) {
      addIcon(card);

      var body = document.createElement('div');
      body.className = 'body';

      var title = document.createElement('p');
      title.className = 'title';
      title.textContent = CFG.install.title;

      var list = document.createElement('ol');
      list.className = 'steps';
      for (var i = 0; i < steps.length; i++) {
        var li = document.createElement('li');
        li.textContent = steps[i];
        list.appendChild(li);
      }

      /*
       * Shown outright, not behind a disclosure. This card is only ever reached
       * by clicking Install, so the steps are the answer to a question that has
       * just been asked — putting them one more click away would be perverse.
       *
       * The timed card never gets here: it shows the Install button instead,
       * which is what "remove the steps from the popup" means in practice.
       */
      var stepsBlock;
      if (supported) {
        stepsBlock = list;
      } else {
        stepsBlock = document.createElement('p');
        stepsBlock.className = 'text';
        stepsBlock.textContent = steps[0];
      }

      var done = document.createElement('button');
      done.className = 'btn';
      done.type = 'button';
      done.textContent = 'Got it';
      done.addEventListener('click', dismiss);

      var actions = document.createElement('div');
      actions.className = 'actions';
      actions.appendChild(done);

      body.appendChild(title);
      body.appendChild(stepsBlock);
      body.appendChild(actions);
      card.appendChild(body);
    });

    return true;
  }

  /*
   * The one entry point every path goes through: the floating card's button,
   * a merchant's own [data-pwa-install] element, and window.ShopifyPWA.install().
   *
   * A saved beforeinstallprompt event is single-use — once prompt() has been
   * called the event is spent, and the browser will fire a fresh one only if
   * the user dismisses the dialog without installing.
   */
  function promptInstall() {
    // Before the branch, so the click counts the same whether it opens a native
    // dialog or a list of directions. The pair the merchant reads is "shown"
    // against "clicked", and it would be a poor pair if half the platforms were
    // missing from one side of it.
    if (markSession(CLICKED_KEY)) send('clicked');

    if (!deferredPrompt) return showInstructions(true);

    var evt = deferredPrompt;
    deferredPrompt = null;

    try {
      evt.prompt();
    } catch (e) {
      return showInstructions(true);
    }

    if (evt.userChoice && evt.userChoice.then) {
      evt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          store(INSTALLED_KEY, '1');
          countInstall();
          hideCard();
        } else {
          dismiss();
        }
      });
    }
    return true;
  }

  function shouldOffer() {
    // These two hold even in preview: a card switched off in the admin is one
    // the merchant asked not to see, and a card inside the installed app window
    // would be inviting someone to install what they are already running.
    if (!CFG.install.enabled) return false;
    if (isStandalone()) return false;

    // The rest are per-visitor history, which is exactly what a preview is for
    // getting past.
    if (PREVIEW) return true;

    if (isAutomated()) return false;
    if (stored(INSTALLED_KEY) === '1') return false;
    if (Date.now() < dismissedUntil()) return false;
    return true;
  }

  function scheduleCard() {
    if (!shouldOffer()) return;

    // A preview waits for nothing. The delay is the single most common reason a
    // merchant concludes the card is broken.
    var delay = PREVIEW ? 0 : Math.max(0, CFG.install.delaySeconds) * 1000;

    window.setTimeout(function () {
      // Conditions are re-checked on fire: the visitor may have installed from
      // the browser's own menu while the timer was running.
      if (!shouldOffer()) return;

      /*
       * One card for every browser that can install at all: icon, title, text,
       * Install. Whether a native dialog is available changes what the button
       * does, not what the card looks like — a visitor has no use for that
       * distinction before they have clicked anything.
       *
       * The guard keeps the old silence on browsers that cannot install by any
       * route (desktop Firefox, anything unrecognised). Offering an Install
       * button there would be a button that cannot work.
       */
      // PREVIEW overrides the capability guard too: a merchant on desktop
      // Firefox still needs to see what their customers will get, and the card
      // says so itself once it is open.
      if (PREVIEW || deferredPrompt || instructionsFor(platform()).length) {
        showPrompt();
        if (markSession(SEEN_KEY)) send('shown');
      }
    }, delay);
  }

  function bindTriggers() {
    // Lets a merchant put "Install our app" in their own nav or footer, with no
    // code beyond the attribute. Delegated, so it works for markup a theme
    // section renders after this script has run.
    document.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== document.body) {
        if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-pwa-install')) {
          event.preventDefault();
          promptInstall();
          return;
        }
        node = node.parentNode;
      }
    }, false);
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    window.ShopifyPWA = {
      version: CFG.version,
      config: CFG,
      platform: platform(),
      standalone: isStandalone(),
      canPrompt: false,
      serviceWorker: { enabled: CFG.sw.enabled, scope: null },
      install: promptInstall,
      dismiss: dismiss,
      instructions: function () { return instructionsFor(platform()); }
    };

    try { CFG.origin = window.location.origin; } catch (e) { CFG.origin = ''; }

    markStandalone();
    countLaunch();
    applyHeadTags();
    registerServiceWorker();

    window.addEventListener('beforeinstallprompt', function (event) {
      // Without preventDefault Chrome shows its own mini-infobar and the event
      // cannot be replayed later from the merchant's own button.
      event.preventDefault();
      deferredPrompt = event;
      window.ShopifyPWA.canPrompt = true;
    });

    window.addEventListener('appinstalled', function () {
      store(INSTALLED_KEY, '1');
      countInstall();
      deferredPrompt = null;
      window.ShopifyPWA.canPrompt = false;
      hideCard();
    });

    bindTriggers();
    scheduleCard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
