/**
 * The two HTML pages served on the storefront origin through the app proxy:
 * the offline fallback, and the installability self-test.
 *
 * Both are built as strings rather than templates because they are small, they
 * have no shared layout with the admin, and keeping them dependency-free means
 * the storefront surface of this app pulls in nothing but express and sharp.
 */

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
    <h1>You are offline</h1>
    <p>${escapeHtml(settings.name)} needs a connection to show this page. It will load as soon as you are back online.</p>
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

  function report(state, label, detail) {
    var mark = state === 'pass' ? '&#10003;' : (state === 'warn' ? '!' : '&#10007;');
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

  /* 1. Secure context. Everything else is moot without it. */
  if (window.isSecureContext) {
    report('pass', 'Secure context', 'Served over HTTPS on <code>' + esc(location.host) + '</code>.');
  } else {
    report('fail', 'Secure context', 'This page is not a secure context. A PWA cannot install over plain HTTP.');
  }

  /* 2. Manifest: fetched, parsed, and same-origin where it must be. */
  fetch(CFG.manifest, { credentials: 'omit' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var type = r.headers.get('content-type') || '';
    return r.json().then(function (m) { return { manifest: m, type: type }; });
  }).then(function (res) {
    var m = res.manifest;
    report('pass', 'Manifest loads',
      '<code>' + esc(CFG.manifest) + '</code> returned <code>' + esc(res.type) + '</code>.');

    report('pass', 'Identity',
      'name <code>' + esc(m.name) + '</code>, short_name <code>' + esc(m.short_name) +
      '</code>, display <code>' + esc(m.display) + '</code>.');

    /* The rule this whole app exists to satisfy. */
    var startAbsolute = new URL(m.start_url, CFG.manifest);
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
      img.src = new URL(icon.src, CFG.manifest).href;
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
    report('fail', 'Manifest loads',
      'Could not load <code>' + esc(CFG.manifest) + '</code>: ' + esc(err.message) +
      '. Check that the app proxy is configured and the app is installed on this shop.');
  });

  /* 3. Service worker scope — the finding that shapes this app. */
  if (!CFG.swEnabled) {
    report('warn', 'Service worker', 'Turned off in the app admin. Installing does not need one; offline browsing does.');
  } else if (!('serviceWorker' in navigator)) {
    report('warn', 'Service worker', 'This browser has no service worker support.');
  } else {
    navigator.serviceWorker.register(CFG.sw, { scope: '/' }).then(function (reg) {
      report('pass', 'Service worker controls the whole site',
        'Registered with scope <code>' + esc(reg.scope) + '</code>. Shopify forwarded ' +
        '<code>Service-Worker-Allowed</code>, so offline browsing and a custom install button both work.');
    }).catch(function () {
      return navigator.serviceWorker.register(CFG.sw).then(function (reg) {
        report('warn', 'Service worker is scope-limited',
          'Registered, but only for <code>' + esc(reg.scope) + '</code>. Shopify strips the ' +
          '<code>Service-Worker-Allowed</code> header, so the worker cannot control storefront pages. ' +
          'Installing is unaffected; offline browsing is not available.');
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
      report('warn', 'No beforeinstallprompt',
        'Expected on Shopify: Chrome only fires it when a service worker with a fetch handler controls the page. ' +
        'Installing from the browser menu or the address-bar icon still works, and the app shows those directions instead.');
    }
  }, 3000);
})();
</script>
</body>
</html>
`;
}

module.exports = { check, escapeHtml, jsonForScript, offline };
