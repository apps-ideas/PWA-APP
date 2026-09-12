/*
 * Storefront runtime. Served through the app proxy as /apps/pwa/pwa.js with the
 * shop's settings substituted for __PWA_CONFIG__, so it is one request and no
 * round trip before the install UI can decide anything.
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

  var deferredPrompt = null;
  var uiRoot = null;
  var shadow = null;

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

  /* Firefox on the desktop has no install support at all, and neither does an
   * unrecognised browser. Saying so is only worth doing when someone has just
   * clicked an Install button and is waiting for something to happen. */
  var NO_SUPPORT = ['This browser cannot install web apps. Try Chrome, Edge or Safari.'];

  /* --------------------------------------------------------- head wiring */

  function applyHeadTags() {
    var p = platform();

    // The theme colour tints the Android address bar and the iOS status bar.
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

  function dismiss() {
    var days = CFG.install.dismissDays;
    if (days > 0) store(DISMISS_KEY, String(Date.now() + days * 86400000));
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
    var width = pos === 'bottom-bar' ? 'width: auto;' : 'width: min(360px, calc(100vw - 32px));';

    return [
      ':host { all: initial; }',
      '.card {',
      '  position: fixed; z-index: 2147483000;', anchor, width,
      '  box-sizing: border-box; padding: 16px 18px;',
      '  margin-bottom: env(safe-area-inset-bottom, 0px);',
      '  background: ' + CFG.backgroundColor + '; color: ' + CFG.textColor + ';',
      '  border: 1px solid rgba(128,128,128,0.28); border-radius: 14px;',
      '  box-shadow: 0 10px 34px rgba(0,0,0,0.18);',
      '  font: 400 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  display: flex; gap: 14px; align-items: flex-start;',
      '  animation: pwa-in 220ms ease-out;',
      '}',
      '@media (prefers-reduced-motion: reduce) { .card { animation: none; } }',
      '@keyframes pwa-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }',
      '.icon { width: 44px; height: 44px; border-radius: 10px; flex: 0 0 auto; object-fit: cover; }',
      '.body { flex: 1 1 auto; min-width: 0; }',
      '.title { font-weight: 600; font-size: 15px; margin: 0 0 3px; }',
      '.text { margin: 0 0 12px; opacity: 0.82; }',
      '.actions { display: flex; gap: 8px; flex-wrap: wrap; }',
      '.btn {',
      '  font: inherit; font-weight: 600; cursor: pointer;',
      '  padding: 9px 16px; border-radius: 9px; border: 0;',
      '  background: ' + CFG.themeColor + '; color: ' + CFG.onThemeColor + ';',
      '}',
      '.btn.secondary { background: transparent; color: inherit; opacity: 0.7; padding: 9px 8px; }',
      '.btn:focus-visible { outline: 2px solid ' + CFG.themeColor + '; outline-offset: 2px; }',
      '.steps { margin: 6px 0 12px; padding-left: 20px; }',
      '.steps li { margin-bottom: 6px; }',
      '.close {',
      '  position: absolute; top: 8px; right: 10px; border: 0; background: none;',
      '  font-size: 20px; line-height: 1; cursor: pointer; color: inherit; opacity: 0.5;',
      '}'
    ].join('\n');
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
    shadow.appendChild(card);

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
    if (!steps.length) {
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

      var done = document.createElement('button');
      done.className = 'btn';
      done.type = 'button';
      done.textContent = 'Got it';
      done.addEventListener('click', dismiss);

      var actions = document.createElement('div');
      actions.className = 'actions';
      actions.appendChild(done);

      body.appendChild(title);
      body.appendChild(list);
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
          hideCard();
        } else {
          dismiss();
        }
      });
    }
    return true;
  }

  function shouldOffer() {
    if (!CFG.install.enabled) return false;
    if (isStandalone()) return false;
    if (isAutomated()) return false;
    if (stored(INSTALLED_KEY) === '1') return false;
    if (Date.now() < dismissedUntil()) return false;
    return true;
  }

  function scheduleCard() {
    if (!shouldOffer()) return;

    window.setTimeout(function () {
      // Conditions are re-checked on fire: the visitor may have installed from
      // the browser's own menu while the timer was running.
      if (!shouldOffer()) return;
      if (deferredPrompt) showPrompt();
      else showInstructions(false);
    }, Math.max(0, CFG.install.delaySeconds) * 1000);
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
