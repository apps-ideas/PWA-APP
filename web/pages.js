/**
 * The two HTML pages served on the storefront origin through the app proxy:
 * the offline fallback, and the installability self-test.
 *
 * Both are built as strings rather than templates because they are small, they
 * have no shared layout with the admin, and keeping them dependency-free means
 * the storefront surface of this app pulls in nothing but express and sharp.
 */

// The launch target has to be worked out the same way the manifest works it
// out, or the check page will cheerfully pass a store whose app launches
// somewhere the worker cannot reach.
const manifestBuilder = require('./manifest.js');

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/**
 * JSON safe to embed in an inline <script>. Escaping "<" is what stops a value
 * containing "</script>" from ending the block early — the one way a merchant's
 * own app name could turn into markup.
 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function offline(settings) {
  const bg = settings.backgroundColor;
  const fg = settings.themeColor;

  return `<!doctype html>
<html lang="${escapeHtml(settings.lang)}" dir="${escapeHtml(settings.dir)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — ${escapeHtml(settings.name)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: ${escapeHtml(bg)}; color: ${escapeHtml(fg)};
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .box { max-width: 380px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; opacity: 0.75; }
  button { font: inherit; font-weight: 600; padding: 11px 22px; border: 0; border-radius: 10px;
    cursor: pointer; background: ${escapeHtml(fg)}; color: ${escapeHtml(bg)}; }
</style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(settings.offline.title)}</h1>
    <p>${escapeHtml(settings.offline.message)}</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </div>
  <script>
    // Reload the moment connectivity returns, rather than making someone who is
    // already back online press a button to find out.
    addEventListener('online', function () { location.reload(); });
  </script>
</body>
</html>
`;
}

/**
 * The launch shell, served at the proxy root.
 *
 * This is the page the installed app opens, and it exists for one reason: it is
 * the only kind of page the service worker is allowed to control. A worker
 * served through the app proxy is scoped to /apps/pwa/, so a manifest pointing
 * start_url straight at the storefront launches into a page the worker has
 * never seen and cannot serve from cache. Pointing start_url here instead means
 * a cold launch with no connection lands on something we cached, rather than on
 * the browser's dinosaur.
 *
 * Online it is invisible: the redirect fires within a beat, and the customer
 * lands on the storefront exactly as before. `storeUrl` is the merchant's own
 * startUrl setting, never this page, so there is no way to build a loop.
 *
 * It registers the worker itself rather than leaving that to pwa.js on the
 * storefront. pwa.js only runs on storefront pages, so a shell that did not
 * register would be cacheable only for someone who had already browsed the shop
 * online in this browser — and the whole point of the shell is the launch that
 * happens when nothing else is available.
 */
function shell(settings, storeUrl, sw) {
  const bg = settings.backgroundColor;
  const fg = settings.themeColor;

  return `<!doctype html>
<html lang="${escapeHtml(settings.lang)}" dir="${escapeHtml(settings.dir)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(settings.name)}</title>
<meta name="robots" content="noindex">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: ${escapeHtml(bg)}; color: ${escapeHtml(fg)};
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .box { max-width: 380px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; opacity: 0.75; }
  a.go, button { font: inherit; font-weight: 600; padding: 11px 22px; border: 0; border-radius: 10px;
    cursor: pointer; background: ${escapeHtml(fg)}; color: ${escapeHtml(bg)};
    text-decoration: none; display: inline-block; }
  /* Hidden until the script decides which of the two states applies, so a
     cached shell never flashes "you are offline" at someone who is online. */
  #states { visibility: hidden; }
</style>
</head>
<body>
  <div class="box" id="states">
    <div id="offline" hidden>
      <h1>${escapeHtml(settings.offline.title)}</h1>
      <p>${escapeHtml(settings.offline.message)}</p>
      <button type="button" onclick="location.reload()">Try again</button>
    </div>
    <div id="going">
      <h1>${escapeHtml(settings.name)}</h1>
      <p>Opening the store\u2026</p>
      <a class="go" href="${escapeHtml(storeUrl)}">Continue</a>
    </div>
  </div>
  <script>
    (function () {
      var store = ${jsonForScript(storeUrl)};
      var swUrl = ${jsonForScript(sw && sw.enabled ? sw.url : '')};
      var states = document.getElementById('states');

      function offline() {
        document.getElementById('going').hidden = true;
        document.getElementById('offline').hidden = false;
        states.style.visibility = 'visible';
      }

      if (navigator.onLine === false) {
        offline();
        // The launch happened with no connection; go the moment one returns.
        addEventListener('online', function () { location.replace(store); });
        return;
      }

      states.style.visibility = 'visible';

      // replace(), not assign(): the shell must not sit in history behind the
      // store, or Back from the first storefront page returns here and bounces
      // the customer straight forward again.
      var gone = false;
      function go() {
        if (gone) return;
        gone = true;
        location.replace(store);
      }

      if (!swUrl || !('serviceWorker' in navigator)) {
        go();
        return;
      }

      // Hold the launch only until the worker is actually running, so that THIS
      // visit is the one that caches the shell — but never for long. A slow
      // registration must not be the reason the store feels slow to open, so
      // whichever finishes first wins and the cache catches up next launch.
      setTimeout(go, 1500);
      navigator.serviceWorker.register(swUrl)
        .then(function () { return navigator.serviceWorker.ready; })
        .then(go, go);
    })();
  </script>
</body>
</html>
`;
}

/**
 * Installability self-test, served same-origin with the storefront.
 *
 * Same-origin is the whole point: a service worker's real scope, and whether
 * beforeinstallprompt fires, can only be observed from a page on the origin the
 * worker claims to control. Running these checks from the admin iframe would
 * measure admin.shopify.com and tell the merchant nothing.
 */
function check(settings, proxyBase) {
  const config = {
    base: proxyBase,
    manifest: proxyBase + '/manifest.json',
    sw: proxyBase + '/sw.js',
    swEnabled: settings.serviceWorker.enabled,
    startUrl: manifestBuilder.startUrlFor(settings, proxyBase),
    name: settings.name,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PWA check — ${escapeHtml(settings.name)}</title>
<link rel="manifest" href="${escapeHtml(proxyBase)}/manifest.json">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px 16px; background: #f6f6f7; color: #1a1a1a;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { margin: 0 0 20px; color: #6d7175; }
  .check { background: #fff; border: 1px solid #e1e3e5; border-radius: 10px;
    padding: 13px 16px; margin-bottom: 10px; display: flex; gap: 12px; align-items: flex-start; }
  .mark { font-size: 16px; line-height: 1.4; flex: 0 0 auto; width: 18px; text-align: center; }
  .pass .mark { color: #007f5f; } .warn .mark { color: #b98900; } .fail .mark { color: #b42318; }
  /* Neutral on both grounds: a statement of fact, not something to act on. */
  .info .mark { color: #8c9196; }
  .label { font-weight: 600; margin: 0 0 2px; }
  .detail { margin: 0; color: #6d7175; overflow-wrap: anywhere; }
  code { background: rgba(128,128,128,0.14); border-radius: 4px; padding: 1px 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .icons { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .icons img { width: 56px; height: 56px; border-radius: 10px; border: 1px solid #e1e3e5; background: #fff; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e3e3e3; }
    .check { background: #212121; border-color: #3a3a3a; }
    .sub, .detail { color: #a0a0a0; }
    .icons img { border-color: #3a3a3a; background: #262626; }
  }
</style>
</head>
<body>
<main>
  <h1>PWA check</h1>
  <p class="sub">Run from the storefront origin, which is the only place these answers are real.</p>
  <div id="results"></div>
  <div class="icons" id="icons"></div>
</main>
<script>
(function () {
  var CFG = ${jsonForScript(config)};
  var out = document.getElementById('results');

  /*
   * The manifest URL in absolute form.
   *
   * CFG.manifest is root-relative ("/apps/pwa/manifest.json"), which fetch()
   * resolves happily — but new URL() will not take a relative string as a base,
   * it throws "Invalid base URL". Resolving it once here is what lets start_url
   * and every icon src be resolved against it below.
   */
  var MANIFEST_URL = new URL(CFG.manifest, location.href).href;

  /*
   * Four states, and the fourth is the one that matters here.
   *
   * "info" is for a condition that is permanent, expected and outside anyone's
   * control — reporting one of those as a warning sends merchants hunting for a
   * setting that does not exist. A warning has to mean "you can do something
   * about this" or it trains people to ignore the whole page.
   */
  function report(state, label, detail) {
    var mark = state === 'pass' ? '&#10003;'
      : state === 'warn' ? '!'
      : state === 'info' ? '&#8226;'
      : '&#10007;';
    var el = document.createElement('div');
    el.className = 'check ' + state;
    el.innerHTML = '<div class="mark">' + mark + '</div><div><p class="label"></p><p class="detail"></p></div>';
    el.querySelector('.label').textContent = label;
    el.querySelector('.detail').innerHTML = detail;
    out.appendChild(el);
    return el;
  }

  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /*
   * An error that already knows what it means.
   *
   * The catch below cannot tell a storefront that is locked from one whose
   * proxy is not routing from a genuine network failure, and guessing wrong
   * sends the reader to change a setting that was never the problem. So
   * whoever can tell writes the sentence, and the catch only prints it. The
   * message is trusted HTML: build it with esc() around anything from outside.
   */
  function problem(message) {
    var err = new Error(message);
    err.explained = true;
    return err;
  }

  /* 1. Secure context. Everything else is moot without it. */
  if (window.isSecureContext) {
    report('pass', 'Secure context', 'Served over HTTPS on <code>' + esc(location.host) + '</code>.');
  } else {
    report('fail', 'Secure context', 'This page is not a secure context. A PWA cannot install over plain HTTP.');
  }

  /* 2. Manifest: fetched, parsed, and same-origin where it must be. */
  fetch(MANIFEST_URL, { credentials: 'omit' }).then(function (r) {
    var type = r.headers.get('content-type') || '';

    /*
     * A password-protected storefront redirects every URL to /password.
     *
     * This fetch omits credentials deliberately, and so does the browser's own
     * manifest fetch — the spec requires it. That is the whole point: having
     * typed the password into this tab does NOT make the store installable,
     * because the install never carries the cookie that unlocked it. So the
     * lock is the finding, not a symptom of some other problem, and no amount
     * of checking the proxy will move it.
     */
    if (r.redirected && /\\/password(?:$|[?#])/.test(r.url)) {
      throw problem('The storefront is password protected, so this URL answers with the password ' +
        'page instead of the manifest. A browser fetches a manifest without cookies, so entering ' +
        'the password in this tab does not help — the store cannot be installed by anyone until ' +
        'the password is removed under Online Store &gt; Preferences.');
    }

    if (!r.ok) {
      throw problem('It answered <code>HTTP ' + r.status + '</code>. Check that the app proxy is ' +
        'configured and the app is installed on this shop.');
    }

    /*
     * HTML with a 200 means something other than this app answered — the theme,
     * or a Shopify page. Worth separating from a parse failure: the manifest is
     * not malformed, it was never served.
     */
    if (/text\\/html/i.test(type)) {
      throw problem('It answered with a web page rather than the manifest. Check that the app proxy ' +
        'is configured and the app is installed on this shop.');
    }

    return r.json().then(function (m) { return { manifest: m, type: type }; });
  }).catch(function (err) {
    /*
     * Load and parse failures only.
     *
     * This catch used to sit at the end of the whole chain, which meant any bug
     * in the analysis below surfaced here as "could not load the manifest —
     * check that the app proxy is configured", sending the reader off to
     * investigate a proxy that was working perfectly. A diagnostic page that
     * misattributes its own failures is worse than one that has none.
     */
    report('fail', 'Manifest loads',
      'Could not load <code>' + esc(CFG.manifest) + '</code>. ' +
      (err.explained ? err.message
        : 'It answered with something that is not JSON (<code>' + esc(err.message) + '</code>). ' +
          'Check that the app proxy is configured and the app is installed on this shop.'));
    return null;
  }).then(function (res) {
    if (!res) return;
    var m = res.manifest;
    report('pass', 'Manifest loads',
      '<code>' + esc(CFG.manifest) + '</code> returned <code>' + esc(res.type) + '</code>.');

    report('pass', 'Identity',
      'name <code>' + esc(m.name) + '</code>, short_name <code>' + esc(m.short_name) +
      '</code>, display <code>' + esc(m.display) + '</code>.');

    /* The rule this whole app exists to satisfy. */
    var startAbsolute = new URL(m.start_url, MANIFEST_URL);
    if (startAbsolute.origin === location.origin) {
      report('pass', 'start_url is same-origin',
        '<code>' + esc(startAbsolute.href) + '</code> is on the storefront origin, so it is installable.');
    } else {
      report('fail', 'start_url is same-origin',
        'start_url resolves to <code>' + esc(startAbsolute.origin) + '</code>, not <code>' +
        esc(location.origin) + '</code>. Chrome will refuse to install.');
    }

    var sizes = (m.icons || []).map(function (i) { return i.sizes; });
    var has192 = sizes.indexOf('192x192') !== -1;
    var has512 = sizes.indexOf('512x512') !== -1;
    var maskable = (m.icons || []).some(function (i) { return (i.purpose || '').indexOf('maskable') !== -1; });

    report(has192 && has512 ? 'pass' : 'fail', 'Icons declared',
      (m.icons || []).length + ' entries; 192 ' + (has192 ? 'yes' : 'NO') +
      ', 512 ' + (has512 ? 'yes' : 'NO') + ', maskable ' + (maskable ? 'yes' : 'no') + '.');

    /* Declaring an icon and serving it are different things. */
    var box = document.getElementById('icons');
    var failures = 0, checked = 0;
    (m.icons || []).forEach(function (icon) {
      var img = new Image();
      img.alt = icon.sizes + ' ' + (icon.purpose || 'any');
      img.title = img.alt;
      img.onload = function () { done(); };
      img.onerror = function () { failures++; done(); };
      img.src = new URL(icon.src, MANIFEST_URL).href;
      box.appendChild(img);
      function done() {
        if (++checked !== (m.icons || []).length) return;
        report(failures ? 'fail' : 'pass', 'Icons load',
          failures ? failures + ' of ' + checked + ' icon URLs failed.' : 'All ' + checked + ' icon URLs returned an image.');
      }
    });

    report((m.screenshots || []).length ? 'pass' : 'warn', 'Screenshots',
      (m.screenshots || []).length
        ? (m.screenshots || []).length + ' present, so install dialogs show the richer card.'
        : 'None set. Installing still works; the dialog is just the plain one. Upload a wide and a narrow screenshot in the app admin.');
  }).catch(function (err) {
    // The manifest loaded; this page failed to finish checking it. Said plainly,
    // with no advice about the proxy, because the proxy is not implicated.
    report('fail', 'Manifest check incomplete',
      'The manifest loaded, but this page could not finish inspecting it: <code>' +
      esc(err.message) + '</code>. This is a fault in the check page, not in your store.');
  });

  /* 3. Service worker scope — the finding that shapes this app. */
  if (!CFG.swEnabled) {
    report('info', 'Service worker is off',
      'Turned off in the app admin, which is the default. Installing does not need one. ' +
      'Offline browsing does, but Shopify strips the header a proxy-served worker needs in ' +
      'order to control storefront pages, so turning it on would not deliver offline browsing either.');
  } else if (!('serviceWorker' in navigator)) {
    report('info', 'Service worker unsupported here',
      'This browser has no service worker support. That affects offline browsing only, which is ' +
      'not available on a Shopify storefront in any case. Installing is unaffected.');
  } else {
    navigator.serviceWorker.register(CFG.sw, { scope: '/' }).then(function (reg) {
      report('pass', 'Service worker controls the whole site',
        'Registered with scope <code>' + esc(reg.scope) + '</code>. Shopify forwarded ' +
        '<code>Service-Worker-Allowed</code>, so offline browsing and a custom install button both work.');
    }).catch(function () {
      return navigator.serviceWorker.register(CFG.sw).then(function (reg) {
        // Shopify stripped the header, so the scope is the proxy directory. That
        // is only a failure if the app launches outside it — which is exactly
        // what the launch shell exists to prevent.
        var launch = '';
        try { launch = new URL(CFG.startUrl, location.origin).href; } catch (e) { launch = ''; }
        var covered = launch && launch.indexOf(reg.scope) === 0;

        if (covered) {
          report('pass', 'Service worker controls the installed app',
            'Registered for <code>' + esc(reg.scope) + '</code>, and the app launches at ' +
            '<code>' + esc(CFG.startUrl) + '</code>, which sits inside it. A cold launch with no ' +
            'connection is served from cache instead of failing. ' +
            'Storefront pages are still outside the worker: Shopify strips the ' +
            '<code>Service-Worker-Allowed</code> header from every app-proxy response, so browsing ' +
            'the catalogue offline is not available and cannot be made available from this app.');
          return;
        }

        report('info', 'Service worker is scope-limited — expected, nothing to fix',
          'Registered for <code>' + esc(reg.scope) + '</code>. Shopify strips the ' +
          '<code>Service-Worker-Allowed</code> header from every app-proxy response, so a worker ' +
          'served through this path can never control storefront pages. No setting in this app, ' +
          'your theme or your Shopify admin changes that. ' +
          'Installing, the home screen icon and the splash screen are all unaffected — only offline ' +
          'browsing is out of reach. If Shopify ever forwards the header, this row turns green on its own.');
      }).catch(function (err) {
        report('fail', 'Service worker', 'Registration failed: ' + esc(err.message));
      });
    });
  }

  /* 4. Whether Chrome will hand us a programmatic install prompt. */
  var gotPrompt = false;
  addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); gotPrompt = true; });

  setTimeout(function () {
    var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (standalone) {
      report('pass', 'Already installed', 'This page is running in an installed window.');
    } else if (gotPrompt) {
      report('pass', 'Custom install button available',
        'The browser fired <code>beforeinstallprompt</code>, so the in-page Install button opens the native dialog.');
    } else {
      report('info', 'No beforeinstallprompt — expected, nothing to fix',
        'Chrome only fires it when a service worker with a fetch handler controls the page, which the row ' +
        'above explains cannot happen here. This is the normal state on a Shopify storefront, not a fault. ' +
        'Installing from the browser menu or the address-bar icon still works, and the install card shows ' +
        'those directions instead of a dialog it cannot open.');
    }
  }, 3000);
})();
</script>
</body>
</html>
`;
}

module.exports = { check, escapeHtml, jsonForScript, offline, shell };
