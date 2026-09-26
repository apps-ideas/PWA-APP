/**
 * The admin's browser script, served from /admin.js.
 *
 * Every request carries a fresh App Bridge session token. There is no cookie and
 * no server session — App Bridge mints a token per call, the server verifies it
 * against the app secret, and the shop comes from inside the token.
 *
 * The script below is a JavaScript string. It must therefore contain no
 * backticks and no dollar-brace, or it would terminate the template literal it
 * is embedded in; string concatenation throughout is deliberate, not a style.
 * ES5 syntax for the same reason the storefront runtime uses it — consistency
 * with the rest of this app's hand-written front end, and nothing here is worth
 * a build step.
 */

const { MAX_BENEFITS, BENEFIT_LENGTH, MAX_PRECACHE } = require('../validate.js');

function script() {
  return `
(function () {
  'use strict';

  /* ------------------------------------------------------------- plumbing */

  var el = function (id) { return document.getElementById(id); };
  var all = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };

  function get(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }

  function set(obj, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (o, k) { o[k] = o[k] || {}; return o[k]; }, obj);
    target[last] = value;
  }

  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  /*
   * Whether black or white text is legible on a background.
   *
   * The same sRGB luminance check the server runs for the real install card, so
   * the preview's button label matches what a customer will actually see rather
   * than being a guess that happens to agree most of the time.
   */
  function readableOn(hex) {
    var full = hex;
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
      full = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    if (!/^#[0-9a-f]{6}$/i.test(full)) return '#ffffff';

    function channel(i) {
      var v = parseInt(full.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    var l = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    return l > 0.55 ? '#111111' : '#ffffff';
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
    clear(box);
    if (!items || !items.length) return;

    var div = node('div', 'banner ' + kind);
    if (title) div.appendChild(node('strong', null, title));

    var ul = node('ul');
    items.forEach(function (item) { ul.appendChild(node('li', null, item)); });
    div.appendChild(ul);
    box.appendChild(div);

    // The banner sits at the top of a scrolling column; announcing a failure
    // below the fold is the same as not announcing it.
    if (kind === 'bad') window.scrollTo(0, 0);
  }

  /* --------------------------------------------------------------- state */

  var state = null;
  var previews = {};
  var dirty = false;
  var statsData = null;
  var tabState = { config: 'home', install: 'android' };

  /*
   * Fields that map one input to one settings path.
   *
   * The four switches with an Enable/Disable strip are deliberately absent: they
   * write straight to state and save on click, so reading them back out of the
   * DOM would be a second source of truth for the same value. See TOGGLES.
   */
  var FIELDS = [
    ['enabled', 'enabled'],
    ['name', 'name'], ['shortName', 'shortName'], ['description', 'description'],
    ['lang', 'lang'], ['dir', 'dir'], ['startUrl', 'startUrl'], ['scope', 'scope'],
    ['display', 'display'], ['orientation', 'orientation'],
    ['themeColor', 'themeColor'], ['backgroundColor', 'backgroundColor'],

    ['install.delaySeconds', 'installDelaySeconds'],
    ['install.position', 'installPosition'], ['install.dismissDays', 'installDismissDays'],
    ['install.title', 'installTitle'], ['install.body', 'installBody'],
    ['install.buttonLabel', 'installButtonLabel'],
    ['install.buttonBackgroundColor', 'installButtonBg'],
    ['install.buttonTextColor', 'installButtonFg'],

    ['offline.title', 'offlineTitle'], ['offline.message', 'offlineMessage'],

    ['ios.splash', 'iosSplash'], ['ios.statusBarStyle', 'iosStatusBarStyle'],

    ['serviceWorker.enabled', 'swEnabled'],
    ['serviceWorker.cache.homePage', 'cacheHomePage'],
    ['serviceWorker.cache.googleFonts', 'cacheGoogleFonts'],
    ['serviceWorker.cache.storefront', 'cacheStorefront'],
    ['serviceWorker.cache.cssFiles', 'cacheCssFiles'],
    ['serviceWorker.cache.images', 'cacheImages']
  ];

  var TOGGLES = {
    installEnabled: 'install.enabled',
    cacheEnabled: 'serviceWorker.cache.enabled',
    precacheEnabled: 'serviceWorker.precache.enabled',
    swOfflinePage: 'serviceWorker.offlinePage'
  };

  var COLOR_FIELDS = ['themeColor', 'backgroundColor', 'installButtonBg', 'installButtonFg'];

  function value(id) {
    var n = el(id);
    return n ? n.value.trim() : '';
  }

  /* -------------------------------------------------------------- routing */

  var ROUTES = ['home', 'configuration', 'install-message', 'cache-assets', 'offline-page',
                'offline-browsing', 'settings', 'reports', 'analytics', 'setup', 'faqs'];

  function currentRoute() {
    var hash = String(location.hash || '').replace(/^#\\//, '');
    return ROUTES.indexOf(hash) === -1 ? 'home' : hash;
  }

  /*
   * Show one page and hide the rest.
   *
   * Nothing is unmounted. Every page's inputs stay in the document with their
   * values, which is what makes a single Save able to post the whole settings
   * object however the merchant navigated to the button they pressed.
   */
  function showRoute() {
    var route = currentRoute();

    all('.page').forEach(function (p) { p.hidden = p.getAttribute('data-page') !== route; });

    all('[data-route]').forEach(function (a) {
      a.className = a.getAttribute('data-route') === route ? 'on' : '';
    });

    window.scrollTo(0, 0);

    // Each report is a network call a merchant should not pay for until they
    // ask to see it, so these load on arrival rather than at boot.
    if (route === 'analytics' && !statsData) loadStats();
    if (route === 'reports') loadReports();
    if (route === 'setup' && !el('setupResult').firstChild) runSetup();
    if (route === 'offline-browsing' && !edgeLoaded) loadEdge();
  }

  window.addEventListener('hashchange', showRoute);

  el('navToggle').addEventListener('click', function () {
    var shell = el('shell');
    var collapsed = shell.className.indexOf('collapsed') !== -1;
    shell.className = collapsed ? 'shell' : 'shell collapsed';
    el('navToggle').innerHTML = collapsed ? '&#8249;' : '&#8250;';
  });

  all('[data-tab]').forEach(function (button) {
    button.addEventListener('click', function () {
      var group = button.getAttribute('data-tab');
      tabState[group] = button.getAttribute('data-tab-value');
      all('[data-tab="' + group + '"]').forEach(function (b) { b.className = b === button ? 'on' : ''; });
      renderPreviews();
    });
  });

  /* ---------------------------------------------------------- dirty state */

  /* Five save bars, one message. The merchant can only see one of them, and
   * which one depends on where they are standing, so all five say the same
   * thing rather than the app guessing which is on screen. */
  function status(message, kind) {
    all('[data-savestatus]').forEach(function (n) { n.textContent = message; });
    all('[data-savedot]').forEach(function (n) { n.className = 'dot' + (kind ? ' ' + kind : ''); });
  }

  function saveEnabled(on) {
    all('[data-save]').forEach(function (b) { b.disabled = !on; });
  }

  function markDirty() {
    if (dirty) return;
    dirty = true;
    status('Unsaved changes', 'dirty');
  }

  /* Every Save button on every page is the same button. */
  function bindSaveBars() {
    all('[data-save]').forEach(function (b) { b.addEventListener('click', save); });
    all('[data-discard]').forEach(function (b) { b.addEventListener('click', function () { load(); }); });
  }

  /* --------------------------------------------------------- repeatables */

  /*
   * A list of single-value rows — install benefits, precache URLs.
   *
   * Rendered from the settings once and then owned by the DOM: typing in a row
   * does not write back to state, because collect() reads the rows at save
   * time. Adding and removing rows re-renders from what is on screen, so an
   * edit is never lost to a click on Add.
   */
  function renderRepeat(boxId, values, placeholder, max, countMax) {
    var box = el(boxId);
    if (!box) return;
    clear(box);

    values.slice(0, max).forEach(function (v, i) {
      var row = node('div', 'repeat');

      var wrap = node('div', countMax ? 'counted' : null);
      var input = document.createElement('input');
      input.type = 'text';
      input.value = v;
      input.placeholder = placeholder;
      input.setAttribute('data-row', boxId);
      if (countMax) {
        input.maxLength = countMax;
        input.setAttribute('data-count', countMax);
        input.id = boxId + '-' + i;
      }
      wrap.appendChild(input);

      if (countMax) {
        var counter = node('span', 'counter');
        counter.setAttribute('data-counter-for', input.id);
        wrap.appendChild(counter);
      }

      var remove = node('button', 'secondary icon', '\\u2715');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove');
      remove.addEventListener('click', function () {
        var kept = rowValues(boxId);
        kept.splice(i, 1);
        renderRepeat(boxId, kept, placeholder, max, countMax);
        markDirty();
        renderPreviews();
      });

      row.appendChild(wrap);
      row.appendChild(remove);
      box.appendChild(row);
    });

    updateCounters();
  }

  function rowValues(boxId) {
    return all('[data-row="' + boxId + '"]').map(function (i) { return i.value; });
  }

  function addRow(boxId, placeholder, max, countMax) {
    var values = rowValues(boxId);
    if (values.length >= max) return;
    values.push('');
    renderRepeat(boxId, values, placeholder, max, countMax);
    markDirty();

    var inputs = all('[data-row="' + boxId + '"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function renderShortcuts() {
    var box = el('shortcuts');
    clear(box);

    var rows = (state.shortcuts || []).slice(0, 4);
    if (!rows.length) rows = [{ name: '', url: '' }];

    rows.forEach(function (row, i) {
      var wrap = node('div', 'shortcut');

      var name = document.createElement('input');
      name.type = 'text';
      name.placeholder = 'Label, e.g. Sale';
      name.value = row.name || '';
      name.setAttribute('data-sc-name', String(i));

      var url = document.createElement('input');
      url.type = 'text';
      url.placeholder = '/collections/sale';
      url.value = row.url || '';
      url.setAttribute('data-sc-url', String(i));

      var remove = node('button', 'secondary icon', '\\u2715');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove shortcut');
      remove.addEventListener('click', function () {
        var kept = collectShortcuts(true);
        kept.splice(i, 1);
        state.shortcuts = kept;
        renderShortcuts();
        markDirty();
      });

      wrap.appendChild(name);
      wrap.appendChild(url);
      wrap.appendChild(remove);
      box.appendChild(wrap);
    });
  }

  /** keepBlank is for the remove path: splicing by index only lines up if the
   *  blank rows are still in the list being spliced. */
  function collectShortcuts(keepBlank) {
    var out = [];
    all('[data-sc-name]').forEach(function (nameInput) {
      var i = nameInput.getAttribute('data-sc-name');
      var urlInput = document.querySelector('[data-sc-url="' + i + '"]');
      var name = nameInput.value.trim();
      var url = urlInput ? urlInput.value.trim() : '';
      if (keepBlank || (name && url)) out.push({ name: name, url: url });
    });
    return out;
  }

  el('addBenefit').addEventListener('click', function () {
    addRow('benefits', 'Faster shopping', ${MAX_BENEFITS}, ${BENEFIT_LENGTH});
  });
  el('addPrecache').addEventListener('click', function () {
    addRow('precacheUrls', '/cdn/shop/t/1/assets/base.css', ${MAX_PRECACHE}, 0);
  });
  el('addShortcut').addEventListener('click', function () {
    var rows = collectShortcuts(true);
    if (rows.length >= 4) return;
    rows.push({ name: '', url: '' });
    state.shortcuts = rows;
    renderShortcuts();
    markDirty();
  });

  /* ------------------------------------------------------------ counters */

  function updateCounters() {
    all('[data-count]').forEach(function (input) {
      var max = parseInt(input.getAttribute('data-count'), 10);
      var counter = document.querySelector('[data-counter-for="' + input.id + '"]');
      if (!counter || !max) return;
      var used = input.value.length;
      counter.textContent = used + '/' + max;
      counter.className = (counter.className.indexOf('counter') === 0 ? 'counter' : 'sublabel') +
        (used >= max ? ' over' : '');
    });
  }

  /* ------------------------------------------------------------- toggles */

  function renderToggles() {
    Object.keys(TOGGLES).forEach(function (id) {
      var on = Boolean(get(state, TOGGLES[id]));
      var label = document.querySelector('[data-toggle-state="' + id + '"]');
      var button = document.querySelector('[data-toggle="' + id + '"]');
      if (!label || !button) return;

      label.textContent = on ? 'Enabled' : 'Disabled';
      label.className = 'state ' + (on ? 'on' : 'off');
      button.textContent = on ? 'Disable' : 'Enable';
      button.className = 'small ' + (on ? 'danger' : '');
    });

    // The cache rules mean nothing while caching is off. Dimming them says so
    // without a sentence nobody reads.
    var rules = el('cacheRules');
    if (rules) rules.className = get(state, 'serviceWorker.cache.enabled') ? '' : 'off';
  }

  all('[data-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      // The strips are on screen before /api/settings has answered, and a click
      // in that first second has nothing to toggle.
      if (!state) return;

      var path = TOGGLES[button.getAttribute('data-toggle')];
      set(state, path, !get(state, path));
      renderToggles();
      renderPreviews();
      // Saved on click, not on Save: the strip reports a state, and a state
      // that is only true after a second click somewhere else is a lie.
      save();
    });
  });

  /* ------------------------------------------------------------ previews */

  function statusBar(color) {
    var bar = node('div', 'statusbar');
    bar.style.background = color;
    bar.appendChild(node('span', null, '09:41'));
    bar.appendChild(node('span', null, '\\u25CF \\u25CF \\u25CF'));
    return bar;
  }

  function fakePage() {
    var page = node('div', 'fakepage');
    page.appendChild(node('div', 'fakebar w60'));
    page.appendChild(node('div', 'fakeblock'));
    page.appendChild(node('div', 'fakebar w80'));
    page.appendChild(node('div', 'fakebar w40'));
    return page;
  }

  function renderConfigPreview() {
    var screen = el('configPhone');
    if (!screen) return;

    clear(screen);
    var theme = value('themeColor') || '#111111';
    var bg = value('backgroundColor') || '#ffffff';
    var icon = previews.icon;

    if (tabState.config === 'splash') {
      screen.style.background = bg;
      screen.appendChild(statusBar(bg));

      var splash = node('div', 'splashscreen');
      splash.style.color = readableOn(bg);
      if (icon) {
        var splashIcon = document.createElement('img');
        splashIcon.src = icon;
        splashIcon.alt = '';
        splash.appendChild(splashIcon);
      }
      splash.appendChild(node('span', null, value('name') || 'Your store'));
      screen.appendChild(splash);
      return;
    }

    screen.style.background = '';
    screen.appendChild(statusBar('rgba(0,0,0,.25)'));

    var home = node('div', 'homescreen');
    if (icon) {
      var homeIcon = document.createElement('img');
      homeIcon.src = icon;
      homeIcon.alt = '';
      home.appendChild(homeIcon);
    }
    home.appendChild(node('span', null, value('shortName') || value('name') || 'Store'));
    screen.appendChild(home);
  }

  /* The install card, drawn from the same values the storefront script is
   * handed — including the blank-means-theme-color rule, so a merchant who
   * leaves both color fields empty sees here what a customer will see. */
  function installCard() {
    var bg = value('backgroundColor') || '#ffffff';
    var buttonBg = value('installButtonBg') || value('themeColor') || '#111111';
    var buttonFg = value('installButtonFg') || readableOn(buttonBg);
    var position = value('installPosition') || 'bottom-right';

    var card = node('div', 'cardpreview' +
      (position === 'bottom-bar' ? ' bar' : '') +
      (position === 'bottom-left' ? ' left' : ''));
    card.style.background = bg;
    card.style.color = readableOn(bg);

    card.appendChild(node('p', 'ct', value('installTitle') || 'Install our app'));

    var lines = rowValues('benefits').filter(function (v) { return v.trim(); });
    if (lines.length) {
      var list = node('ul');
      lines.forEach(function (line) { list.appendChild(node('li', null, line)); });
      card.appendChild(list);
    }

    var body = el('installBody');
    card.appendChild(node('p', 'cb', (body && body.value.trim()) || ''));

    var button = node('span', 'cbtn', value('installButtonLabel') || 'Install');
    button.style.background = buttonBg;
    button.style.color = buttonFg;
    card.appendChild(button);

    return card;
  }

  /* iOS gets its own tab because it gets its own card. Safari has no install
   * dialog to open, so the button shows directions instead — and a preview that
   * pretended otherwise would be the one screen a merchant could not trust. */
  function iosCard() {
    var bg = value('backgroundColor') || '#ffffff';
    var card = node('div', 'cardpreview');
    card.style.background = bg;
    card.style.color = readableOn(bg);

    card.appendChild(node('p', 'ct', value('installTitle') || 'Install our app'));

    var list = node('ul');
    ['Tap the Share button in Safari.', 'Choose "Add to Home Screen".', 'Tap "Add" to finish.']
      .forEach(function (step) { list.appendChild(node('li', null, step)); });
    card.appendChild(list);

    var buttonBg = value('installButtonBg') || value('themeColor') || '#111111';
    var button = node('span', 'cbtn', 'Got it');
    button.style.background = buttonBg;
    button.style.color = value('installButtonFg') || readableOn(buttonBg);
    card.appendChild(button);

    return card;
  }

  function renderInstallPreview() {
    var screen = el('installPhone');
    if (!screen) return;

    clear(screen);
    screen.style.background = '';
    screen.appendChild(statusBar(value('themeColor') || '#111111'));
    screen.appendChild(fakePage());

    var enabled = Boolean(get(state, 'install.enabled'));
    var note = el('installPreviewNote');

    if (!enabled) {
      if (note) note.textContent = 'The install message is switched off, so no card is shown to anyone.';
      return;
    }

    screen.appendChild(tabState.install === 'ios' ? iosCard() : installCard());

    if (note) {
      note.textContent = tabState.install === 'ios'
        ? 'Safari cannot open an install dialog, so on iOS the button shows these directions instead.'
        : 'Chrome and Edge open their own install dialog when the button is tapped.';
    }
  }

  function renderOfflinePreview() {
    var screen = el('offlinePhone');
    if (!screen) return;

    clear(screen);
    var bg = value('backgroundColor') || '#ffffff';
    var theme = value('themeColor') || '#111111';

    screen.style.background = bg;
    screen.appendChild(statusBar(theme));

    var box = node('div', 'offlinescreen');
    box.style.color = theme;
    box.appendChild(node('b', null, value('offlineTitle') || 'You are offline'));

    var message = el('offlineMessage');
    box.appendChild(node('span', null, (message && message.value.trim()) || ''));

    var button = node('span', 'cbtn', 'Try again');
    button.style.background = theme;
    button.style.color = bg;
    button.style.marginTop = '6px';
    box.appendChild(button);

    screen.appendChild(box);
  }

  /* Guarded because the input listener is delegated on the document and is
   * therefore live before /api/settings has answered — a merchant who starts
   * typing into a field during that first second must not get an exception. */
  function renderPreviews() {
    if (!state) return;
    renderConfigPreview();
    renderInstallPreview();
    renderOfflinePreview();
  }

  /* -------------------------------------------------------------- assets */

  function renderIconPreviews() {
    var pairs = [
      ['iconPreview', previews.icon],
      ['iconMaskableSquirclePreview', previews.iconMaskable],
      ['iconMaskableCirclePreview', previews.iconMaskable]
    ];

    pairs.forEach(function (pair) {
      var n = el(pair[0]);
      if (!n) return;
      if (pair[1]) {
        n.src = pair[1];
        n.style.visibility = '';
      } else {
        n.removeAttribute('src');
        n.style.visibility = 'hidden';
      }
    });

    var asset = state.assets.icon;
    el('iconMeta').textContent = asset.present
      ? asset.width + ' x ' + asset.height + ' uploaded'
      : 'No logo uploaded — showing the generated placeholder';
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
    renderPreviews();
  }

  all('[data-upload]').forEach(function (button) {
    var kind = button.getAttribute('data-upload');
    button.addEventListener('click', function () { el(kind + 'File').click(); });

    el(kind + 'File').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;

      status('Uploading ' + file.name + '\\u2026');
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
        status('Image saved', 'ok');
      }).catch(function (err) {
        banner('bad', 'Upload failed', [err.message]);
        status('Upload failed');
      }).then(function () { event.target.value = ''; });
    });
  });

  all('[data-remove]').forEach(function (button) {
    button.addEventListener('click', function () {
      var kind = button.getAttribute('data-remove');
      status('Removing\\u2026');
      api('/api/assets/' + kind, { method: 'DELETE' }).then(function (body) {
        state = body.settings;
        previews = body.previews || {};
        renderAssets();
        status('Image removed', 'ok');
      }).catch(function (err) {
        banner('bad', 'Could not remove the image', [err.message]);
      });
    });
  });

  /* ---------------------------------------------------------- stats pages */

  function tile(value_, label, className) {
    var box = node('div', 'tile' + (className ? ' ' + className : ''));
    box.appendChild(node('div', 'n', String(value_)));
    box.appendChild(node('div', 'k', label));
    return box;
  }

  function shortDate(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  /* Bars are scaled to the busiest day in the window, not to a fixed ceiling. A
   * shop with two installs a week and a shop with two hundred both want to see
   * the shape of their own traffic. */
  function renderChart(chartId, axisId, series) {
    var chart = el(chartId);
    var axis = el(axisId);
    if (!chart) return;

    clear(chart);
    clear(axis);

    var peak = 0;
    series.forEach(function (row) { if (row.installed > peak) peak = row.installed; });

    series.forEach(function (row) {
      var bar = node('div', row.installed ? 'bar' : 'bar zero');
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

    axis.appendChild(node('span', null, series.length ? shortDate(series[0].date) : ''));
    axis.appendChild(node('span', null, 'Today' + (peak ? ' \\u2014 busiest day: ' + peak : '')));
  }

  function platformTiles(boxId, counts, event, good) {
    var box = el(boxId);
    if (!box) return;
    clear(box);

    var total = 0;
    ['ios', 'android', 'desktop', 'other'].forEach(function (p) { total += counts[p][event]; });

    box.appendChild(tile(counts.ios[event], 'iOS', good ? 'good' : 'cool'));
    box.appendChild(tile(counts.android[event], 'Android', good ? 'good' : 'cool'));
    box.appendChild(tile(counts.desktop[event], 'Desktop', good ? 'good' : 'cool'));
    box.appendChild(tile(total, 'Total', good ? 'good' : 'cool'));

    // Only shown when it is not zero. A row of four tiles plus a fifth that
    // always reads 0 is a column of noise on every well-behaved store.
    if (counts.other[event]) box.appendChild(tile(counts.other[event], 'Unrecognised'));
  }

  function renderStats(data) {
    statsData = data;

    el('navInstalls').textContent = String(data.totals.installed);

    platformTiles('installedTiles', data.platformRecent, 'installed', true);
    platformTiles('dismissedTiles', data.platformRecent, 'dismissed', false);

    var funnel = el('funnelTiles');
    if (funnel) {
      clear(funnel);
      funnel.appendChild(tile(data.recent.shown, 'Card shown'));
      funnel.appendChild(tile(data.recent.clicked, 'Install tapped'));
      funnel.appendChild(tile(data.recent.installed, 'Installed'));
      funnel.appendChild(tile(data.recent.dismissed, 'Dismissed'));
      funnel.appendChild(tile(data.recent.launch, 'App opens'));
      funnel.appendChild(tile(data.totals.installed, 'Installs, all time'));
    }

    renderChart('statChart', 'statAxis', data.series);

    var home = el('homeTiles');
    if (home) {
      clear(home);
      home.appendChild(tile(data.totals.installed, 'Installs, all time'));
      home.appendChild(tile(data.recent.installed, 'Installs, last ' + data.windowDays + ' days'));
      home.appendChild(tile(data.recent.launch, 'App opens, last ' + data.windowDays + ' days'));
      home.appendChild(tile(data.recent.shown, 'Install card shown'));
      renderChart('homeChart', 'homeAxis', data.series);
    }

    var note = el('statNote');
    if (!note) return;

    if (!data.totals.installed && !data.totals.shown && !data.totals.launch) {
      note.textContent = 'Nothing counted yet. Figures appear once the app embed is on and a customer ' +
        'has seen the install card on your storefront.';
      return;
    }

    var parts = [];
    if (data.recent.shown) {
      parts.push('The install card was shown ' + data.recent.shown + ' times and tapped ' +
        data.recent.clicked + ' (' + Math.round((data.recent.clicked / data.recent.shown) * 100) + '%).');
    }
    if (data.lastEventAt) parts.push('Last activity ' + new Date(data.lastEventAt).toLocaleString() + '.');

    // Said plainly rather than buried: the counters are keyed on browser
    // storage, so a customer who installs on a phone and a laptop is two, and
    // one who clears their storage and reinstalls is two as well.
    parts.push('Counted once per browser, so these are close but not exact — clearing site data or ' +
      'installing on a second device counts again. iOS installs appear the first time the app is ' +
      'opened, not when it is added. Days run midnight to midnight UTC.');

    note.textContent = parts.join(' ');
  }

  function loadStats() {
    var range = value('statsRange') || '30';
    return api('/api/stats?days=' + encodeURIComponent(range))
      .then(renderStats)
      .catch(function (err) {
        // Said in both places the figures appear, rather than in a banner: this
        // is a read-only panel, and a failure to draw it is not a reason to put
        // a red bar over the settings screen a merchant came here to use.
        var message = 'Could not load install figures: ' + err.message;
        var note = el('statNote');
        if (note) note.textContent = message;

        var axis = el('homeAxis');
        if (axis) {
          clear(axis);
          axis.appendChild(node('span', null, message));
        }
      });
  }

  el('statsReload').addEventListener('click', loadStats);
  el('statsRange').addEventListener('change', loadStats);
  el('homeStatsReload').addEventListener('click', loadStats);

  /* ------------------------------------------------------------- reports */

  /* How a stored report's target reads in the history. Keys match TARGETS in
   * web/reports.js; an unknown one falls back rather than showing a raw key. */
  var REPORT_TARGET_LABELS = {
    start: 'App start URL', home: 'Home page', collection: 'Collection page',
    product: 'Product page', page: 'Page', custom: 'Custom path'
  };

  function scoreClass(n) {
    if (n == null) return '';
    if (n >= 90) return 'g';
    if (n >= 50) return 'a';
    return 'r';
  }

  function scoreBadge(n) {
    var badge = node('span', 'score ' + scoreClass(n), n == null ? '\\u2013' : String(n));
    return badge;
  }

  /* A Lighthouse-style ring, drawn with a conic gradient rather than an SVG so
   * there is no second palette to keep in step with the stylesheet. */
  function dial(label, n) {
    var wrap = node('div', 'dial');
    var color = n == null ? '#9aa0a6' : (n >= 90 ? '#0c8a5f' : (n >= 50 ? '#d69e2e' : '#c0392b'));

    var ring = node('div', 'ring');
    ring.style.background = 'conic-gradient(' + color + ' ' + (n || 0) + '%, rgba(128,128,128,.22) 0)';
    ring.style.color = color;

    var inner = node('i', null, n == null ? '\\u2013' : String(n));
    ring.appendChild(inner);

    wrap.appendChild(ring);
    wrap.appendChild(node('small', null, label));
    return wrap;
  }

  function renderReportList(rows) {
    var box = el('reportList');
    clear(box);

    if (!rows.length) {
      box.appendChild(node('p', 'hint', 'No reports yet. Generate one to see how your storefront scores.'));
      return;
    }

    var table = node('table', 'data');
    var head = node('tr');
    ['Created', 'Page', 'Device', 'PWA score', 'Performance', ''].forEach(function (h) {
      head.appendChild(node('th', null, h));
    });
    table.appendChild(head);

    rows.forEach(function (row) {
      var tr = node('tr');

      var when = node('td');
      when.appendChild(node('div', null, new Date(row.createdAt).toLocaleString()));
      if (row.error) when.appendChild(node('div', 'why muted', row.error));
      tr.appendChild(when);

      // The path, not the whole URL: every row shares the same host, and the
      // part that differs is the part worth reading. Reports stored before
      // this column existed have no path, so they are labelled by what they
      // were — a run against the start URL — rather than left blank.
      var where = node('td');
      where.appendChild(node('div', 'mono', row.path || '/'));
      where.appendChild(node('div', 'why muted', REPORT_TARGET_LABELS[row.target] || 'App start URL'));
      tr.appendChild(where);

      tr.appendChild(node('td', null, row.strategy === 'desktop' ? 'Desktop' : 'Mobile'));

      var pwa = node('td');
      pwa.appendChild(scoreBadge(row.pwaScore));
      tr.appendChild(pwa);

      var perf = node('td');
      perf.appendChild(scoreBadge(row.scores ? row.scores.performance : null));
      tr.appendChild(perf);

      var actions = node('td');
      var view = node('button', 'secondary small', 'View');
      view.type = 'button';
      view.addEventListener('click', function () { openReport(row.id); });

      var del = node('button', 'secondary small', 'Delete');
      del.type = 'button';
      del.style.marginLeft = '6px';
      del.addEventListener('click', function () {
        api('/api/reports/' + row.id, { method: 'DELETE' }).then(function (body) {
          el('reportDetail').hidden = true;
          renderReportList(body.reports);
        }).catch(function (err) { banner('bad', 'Could not delete the report', [err.message]); });
      });

      actions.appendChild(view);
      actions.appendChild(del);
      tr.appendChild(actions);

      table.appendChild(tr);
    });

    box.appendChild(table);
  }

  function checkList(checks) {
    var list = node('ul', 'checks');
    checks.forEach(function (c) {
      var li = node('li');
      li.appendChild(node('span', 'flag ' + (c.ok ? 'ok' : 'no'), c.ok ? '\\u2713' : '!'));

      var body = node('div');
      body.appendChild(node('div', 'what', c.label));
      body.appendChild(node('div', 'why', c.detail));
      li.appendChild(body);

      list.appendChild(li);
    });
    return list;
  }

  function renderReportDetail(report) {
    var box = el('reportDetail');
    clear(box);
    box.hidden = false;

    box.appendChild(node('h2', null, 'Report \\u2014 ' + new Date(report.createdAt).toLocaleString()));
    box.appendChild(node('p', 'hint', report.url + ' \\u2014 measured as ' +
      (report.strategy === 'desktop' ? 'desktop' : 'mobile') +
      (report.lighthouseVersion ? ', Lighthouse ' + report.lighthouseVersion : '')));

    if (report.error) {
      var warn = node('div', 'banner warn');
      warn.appendChild(node('strong', null, 'PageSpeed could not measure this run'));
      warn.appendChild(node('p', null, report.error));
      warn.appendChild(node('p', null, 'The installability checks below ran anyway — they are this ' +
        'app\\u2019s own and do not depend on Google.'));
      box.appendChild(warn);
    }

    var dials = node('div', 'dials');
    dials.appendChild(dial('Performance', report.scores.performance));
    dials.appendChild(dial('Accessibility', report.scores.accessibility));
    dials.appendChild(dial('Best practices', report.scores.bestPractices));
    dials.appendChild(dial('SEO', report.scores.seo));
    dials.appendChild(dial('PWA', report.pwa ? report.pwa.score : null));
    box.appendChild(dials);

    var legend = node('div', 'legend');
    [['0\\u201349', '#c0392b'], ['50\\u201389', '#d69e2e'], ['90\\u2013100', '#0c8a5f']]
      .forEach(function (pair) {
        var item = node('span');
        var swatch = node('b');
        swatch.style.background = pair[1];
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(pair[0]));
        legend.appendChild(item);
      });
    box.appendChild(legend);

    if (report.metrics && report.metrics.length) {
      box.appendChild(node('h2', null, 'Metrics'));
      var table = node('table', 'data');
      report.metrics.forEach(function (m) {
        var tr = node('tr');
        tr.appendChild(node('td', null, m.label));
        tr.appendChild(node('td', null, m.display));
        table.appendChild(tr);
      });
      box.appendChild(table);
    }

    if (report.opportunities && report.opportunities.length) {
      box.appendChild(node('h2', null, 'What to fix first'));
      box.appendChild(node('p', 'hint', 'Biggest estimated saving first. Most of these live in your ' +
        'theme rather than in this app.'));

      var list = node('ul', 'checks');
      report.opportunities.forEach(function (o) {
        var li = node('li');
        li.appendChild(node('span', 'flag no', '!'));
        var body = node('div');
        body.appendChild(node('div', 'what', o.title + ' \\u2014 about ' +
          (o.savingsMs >= 1000 ? (o.savingsMs / 1000).toFixed(1) + 's' : o.savingsMs + 'ms')));
        body.appendChild(node('div', 'why', o.detail));
        li.appendChild(body);
        list.appendChild(li);
      });
      box.appendChild(list);
    }

    if (report.pwa) {
      box.appendChild(node('h2', null, 'Installability \\u2014 ' + report.pwa.passed + ' of ' +
        report.pwa.total + ' checks passed'));
      box.appendChild(node('p', 'hint', 'This app\\u2019s own checks, run against your live storefront. ' +
        'Lighthouse dropped its PWA category in 2024, so there is nothing left to defer to.'));
      box.appendChild(checkList(report.pwa.checks));
    }

    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openReport(id) {
    api('/api/reports/' + id)
      .then(function (body) { renderReportDetail(body.report); })
      .catch(function (err) { banner('bad', 'Could not open the report', [err.message]); });
  }

  function loadReports() {
    return api('/api/reports')
      .then(function (body) { renderReportList(body.reports); })
      .catch(function (err) {
        el('reportList').textContent = 'Could not load reports: ' + err.message;
      });
  }

  /*
   * What each page target asks the merchant for.
   *
   * Mirrors TARGETS in web/reports.js, which is the half that enforces it —
   * this is only what to show. The prefix in particular is presentation: the
   * server adds it to a bare handle regardless of what this field displayed.
   */
  var REPORT_TARGETS = {
    start: { prefix: '', placeholder: '', hint: '' },
    home: { prefix: '', placeholder: '', hint: '' },
    collection: {
      prefix: '/collections/', placeholder: 'summer-sale',
      hint: 'The collection handle from your Shopify admin, or a full path.'
    },
    product: {
      prefix: '/products/', placeholder: 'blue-hat',
      hint: 'The product handle from your Shopify admin, or a full path.'
    },
    page: {
      prefix: '/pages/', placeholder: 'about-us',
      hint: 'The page handle from your Shopify admin, or a full path.'
    },
    custom: {
      prefix: '', placeholder: '/search?q=hat',
      hint: 'Any path on your storefront — a blog post, a search, a filtered collection.'
    }
  };

  function renderReportTarget() {
    var spec = REPORT_TARGETS[value('reportTarget')] || REPORT_TARGETS.start;
    var row = el('reportPathRow');
    var prefix = el('reportPathPrefix');

    // A target that needs no path hides the whole row rather than disabling it:
    // there is nothing to type, so an empty box would only raise the question.
    row.hidden = !spec.placeholder;
    if (row.hidden) return;

    prefix.hidden = !spec.prefix;
    prefix.textContent = spec.prefix;
    el('reportPath').placeholder = spec.placeholder;
    el('reportPathHint').textContent = spec.hint +
      ' You can also paste the whole URL from your storefront.';
  }

  el('reportTarget').addEventListener('change', renderReportTarget);
  renderReportTarget();

  el('generateReport').addEventListener('click', function () {
    var button = el('generateReport');
    var note = el('reportNote');

    button.disabled = true;
    note.textContent = 'Running\\u2026 PageSpeed loads your store on a throttled connection, so this ' +
      'takes up to a minute.';

    api('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy: value('reportStrategy') || 'mobile',
        target: value('reportTarget') || 'start',
        path: value('reportPath')
      })
    }).then(function (body) {
      renderReportList(body.reports);
      renderReportDetail(body.report);
      note.textContent = body.report.error
        ? 'Finished, but PageSpeed could not measure the page. The installability checks still ran.'
        : 'Finished at ' + new Date().toLocaleTimeString() + '.';
    }).catch(function (err) {
      note.textContent = '';
      banner('bad', 'Could not generate a report', [err.message]);
    }).then(function () {
      button.disabled = false;
    });
  });

  /* --------------------------------------------------------------- setup */

  function renderSetup(data) {
    var box = el('setupResult');
    clear(box);

    el('setupWhen').textContent = 'Last run ' + new Date(data.checkedAt).toLocaleString() + '.';

    if (data.storefront.notes && data.storefront.notes.length) {
      var notes = node('div', 'banner warn');
      notes.appendChild(node('strong', null, 'Worth knowing before you read these'));
      var ul = node('ul');
      data.storefront.notes.forEach(function (n) { ul.appendChild(node('li', null, n)); });
      notes.appendChild(ul);
      box.appendChild(notes);
    }

    var summary = node('section');
    summary.appendChild(node('h2', null, data.pwa.passed + ' of ' + data.pwa.total + ' checks passed'));
    summary.appendChild(node('p', 'hint', 'Run against ' + data.storefront.homeUrl + '. Every failing ' +
      'check below says what to do about it.'));
    summary.appendChild(checkList(data.pwa.checks));
    box.appendChild(summary);
  }

  function runSetup() {
    var button = el('runSetup');
    button.disabled = true;
    el('setupWhen').textContent = 'Checking your storefront\\u2026';

    return api('/api/setup').then(renderSetup).catch(function (err) {
      el('setupWhen').textContent = '';
      banner('bad', 'Could not run the checks', [err.message]);
    }).then(function () {
      button.disabled = false;
    });
  }

  el('runSetup').addEventListener('click', runSetup);
  
  /* ----------------------------------------------------- offline browsing */

  var edgeLoaded = false;

  function renderEdgeStatus(s) {
    var box = el('edgeStatus');
    clear(box);

    var div = node('div', 'banner ' + (s.active ? 'good' : (s.customDomain ? 'warn' : 'info')));
    div.appendChild(node('strong', null, s.active
      ? 'Full offline browsing is on'
      : 'Only the app shell works offline'));
    div.appendChild(node('p', null, s.detail));
    if (!s.active && !s.customDomain) {
      div.appendChild(node('p', null, 'Your store is served at ' + s.host + ', a Shopify address. ' +
        'Offline browsing needs your own domain, routed through Cloudflare or a server you run.'));
    }
    var meta = node('p', 'hint', 'Checked ' + s.url + (s.status ? ' \\u2014 HTTP ' + s.status : '') +
      ' at ' + new Date().toLocaleTimeString() + '.');
    meta.style.margin = '8px 0 0';
    div.appendChild(meta);
    box.appendChild(div);

    el('edgeRouteHint').textContent = s.host + '/sw.js';
  }

  function loadEdge() {
    var button = el('edgeCheck');
    button.disabled = true;
    clear(el('edgeStatus'));
    el('edgeStatus').appendChild(node('p', 'hint', 'Checking your storefront\\u2026'));

    return api('/api/offline-edge').then(function (body) {
      edgeLoaded = true;
      renderEdgeStatus(body.status);
      el('edgeCloudflare').value = body.snippets.cloudflare;
      el('edgeNginx').value = body.snippets.nginx;
      el('edgeApache').value = body.snippets.apache;
    }).catch(function (err) {
      clear(el('edgeStatus'));
      banner('bad', 'Could not check offline browsing', [err.message]);
    }).then(function () {
      button.disabled = false;
    });
  }

  el('edgeCheck').addEventListener('click', loadEdge);

  el('cfDeploy').addEventListener('click', function () {
    var button = el('cfDeploy');
    var input = el('cfToken');
    var out = el('cfResult');
    var token = input.value.trim();

    clear(out);
    if (!token) {
      out.appendChild(node('p', 'hint', 'Paste a Cloudflare API token first.'));
      return;
    }

    button.disabled = true;
    out.appendChild(node('p', 'hint', 'Deploying to Cloudflare\\u2026'));

    api('/api/offline-edge/cloudflare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (body) {
      // The token has done its job; keeping it in the field only invites a
      // second paste somewhere it should not go.
      input.value = '';
      clear(out);

      var done = node('div', 'banner ' + (body.check.active ? 'good' : 'warn'));
      done.appendChild(node('strong', null, body.check.active
        ? 'Deployed \\u2014 offline browsing is live on ' + body.host
        : 'Deployed to ' + body.zone + ', but /sw.js is not answering yet'));
      var ul = node('ul');
      body.steps.concat(body.warnings || []).forEach(function (line) { ul.appendChild(node('li', null, line)); });
      if (!body.check.active) {
        ul.appendChild(node('li', null, 'Cloudflare can take a minute to roll a new route out. ' +
          'Press Check again shortly. ' + body.check.detail));
      }
      done.appendChild(ul);
      out.appendChild(done);

      renderEdgeStatus(body.check);
    }).catch(function (err) {
      clear(out);
      var bad = node('div', 'banner bad');
      bad.appendChild(node('strong', null, 'Cloudflare deploy failed'));
      bad.appendChild(node('p', null, err.message));
      out.appendChild(bad);
    }).then(function () {
      button.disabled = false;
    });
  });

  all('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var box = el(button.getAttribute('data-copy'));
      var label = button.textContent;
      function copied() {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = label; }, 1500);
      }
      // The admin is an iframe, where the async clipboard may be refused. The
      // old selection route works there, so it is the fallback, not an error.
      function fallback() {
        box.focus();
        box.select();
        try { if (document.execCommand('copy')) copied(); } catch (e) { /* selected; Ctrl+C works */ }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).then(copied, fallback);
      } else {
        fallback();
      }
    });
  });

  /* -------------------------------------------------------- cache refresh */

  el('clearCache').addEventListener('click', function () {
    var button = el('clearCache');
    var note = el('clearCacheNote');

    button.disabled = true;
    note.textContent = 'Refreshing\\u2026';

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

  /* --------------------------------------------------------------- render */

  function renderEnabled() {
    var on = el('enabled').checked;
    el('enabledNote').textContent = on
      ? 'Active. Customers who have not installed yet will be offered the app.'
      : 'Switched off. The manifest is still served, but it asks for a plain browser tab, so no ' +
        'browser will offer to install the store. Existing installs keep working.';
  }

  function renderCategories() {
    var chosen = state.categories || [];
    all('[data-category]').forEach(function (box) {
      box.checked = chosen.indexOf(box.getAttribute('data-category')) !== -1;
    });
  }

  function render() {
    FIELDS.forEach(function (pair) {
      var n = el(pair[1]);
      if (!n) return;
      var v = get(state, pair[0]);
      if (n.type === 'checkbox') n.checked = Boolean(v);
      else n.value = v == null ? '' : v;
    });

    COLOR_FIELDS.forEach(function (id) {
      var picker = el(id + 'Picker');
      if (!picker) return;
      var v = el(id).value || '#000000';
      // <input type=color> only accepts six-digit hex; a three-digit value from
      // the text field would silently reset the picker to black.
      picker.value = v.length === 4 ? '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v;
    });

    renderRepeat('benefits', state.install.benefits || [], 'Faster shopping',
      ${MAX_BENEFITS}, ${BENEFIT_LENGTH});
    renderRepeat('precacheUrls', state.serviceWorker.precache.urls || [],
      '/cdn/shop/t/1/assets/base.css', ${MAX_PRECACHE}, 0);

    renderShortcuts();
    renderCategories();
    renderEnabled();
    renderToggles();
    renderAssets();
    updateCounters();

    saveEnabled(true);

    dirty = false;
    status(state.updatedAt ? 'Last saved ' + new Date(state.updatedAt).toLocaleString() : 'Not saved yet',
      state.updatedAt ? 'ok' : '');
  }

  function collect() {
    var out = JSON.parse(JSON.stringify(state));

    FIELDS.forEach(function (pair) {
      var n = el(pair[1]);
      if (!n) return;
      if (n.type === 'checkbox') set(out, pair[0], n.checked);
      else if (n.type === 'number') set(out, pair[0], Number(n.value));
      else set(out, pair[0], n.value);
    });

    out.categories = all('[data-category]')
      .filter(function (b) { return b.checked; })
      .map(function (b) { return b.getAttribute('data-category'); });

    out.install.benefits = rowValues('benefits')
      .map(function (v) { return v.trim(); })
      .filter(function (v) { return v; });

    out.serviceWorker.precache.urls = rowValues('precacheUrls')
      .map(function (v) { return v.trim(); })
      .filter(function (v) { return v; });

    out.shortcuts = collectShortcuts(false);

    return out;
  }

  function save() {
    saveEnabled(false);
    status('Saving\\u2026');

    return api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect())
    }).then(function (body) {
      state = body.settings;
      render();
      // The server reports what it changed rather than what it rejected
      // outright, so these are worth surfacing even on a successful save.
      banner('warn', 'Saved, with changes:', body.warnings);
      status('Saved ' + new Date().toLocaleTimeString() +
        '. Manifest changes reach visitors within five minutes.', 'ok');
    }).catch(function (err) {
      banner('bad', 'Could not save', [err.message]);
      status('Not saved');
      saveEnabled(true);
    });
  }

  function load() {
    status('Loading\\u2026');
    return api('/api/settings').then(function (body) {
      state = body.settings;
      previews = body.previews || {};
      banner('', '', []);
      render();

      var foot = el('navFoot');
      if (foot) foot.textContent = body.shop || '';
    }).catch(function (err) {
      status('Could not load settings');
      banner('bad', 'Could not load settings', [err.message]);
    });
  }

  /* --------------------------------------------------------------- events */

  // One delegated listener rather than one per field: there are about forty
  // inputs across ten pages, and every one of them wants the same three things
  // to happen.
  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!target || !target.tagName) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(target.tagName) === -1) return;

    markDirty();
    updateCounters();
    renderPreviews();
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.tagName) return;
    if (target.id === 'enabled') renderEnabled();
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(target.tagName) !== -1) markDirty();
  });

  COLOR_FIELDS.forEach(function (id) {
    var picker = el(id + 'Picker');
    if (!picker) return;

    picker.addEventListener('input', function (e) {
      el(id).value = e.target.value;
      markDirty();
      renderPreviews();
    });

    el(id).addEventListener('change', function (e) {
      var v = e.target.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) picker.value = v;
    });
  });

  // A merchant who navigates away mid-edit loses the edit. Warning is the only
  // thing this app can do about it — the alternative, saving on every keystroke,
  // would write a half-typed app name to a live manifest.
  window.addEventListener('beforeunload', function (event) {
    if (!dirty) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  });

  /* ----------------------------------------------------------------- boot */

  // Links that need the shop domain, which only the server knows at render time.
  var body = document.body;
  var themeEditor = body.getAttribute('data-theme-editor');
  var check = body.getAttribute('data-check');
  var preview = body.getAttribute('data-preview');

  if (themeEditor) {
    var themeLink = el('themeEditorLink');
    clear(themeLink);
    var a = node('a', null, 'Theme editor \\u203A App embeds');
    a.href = themeEditor;
    a.target = '_blank';
    a.rel = 'noopener';
    themeLink.appendChild(a);
  }

  if (check) {
    var checkBox = el('checkLink');
    clear(checkBox);
    var b = node('a', null, 'run the storefront check');
    b.href = check;
    b.target = '_blank';
    b.rel = 'noopener';
    checkBox.appendChild(b);
  }

  // _blank, not _top: the merchant is mid-edit on this page and should come back
  // to it with their unsaved changes intact.
  if (preview) {
    var previewBox = el('previewLink');
    clear(previewBox);
    var c = node('a', null, 'Preview the card on your storefront');
    c.href = preview;
    c.target = '_blank';
    c.rel = 'noopener';
    previewBox.appendChild(c);
  }

  bindSaveBars();
  showRoute();
  load();
  // Fired alongside, not chained: the figures are read-only and unrelated to the
  // settings form, so a slow or failing stats read must not hold up the screen a
  // merchant actually came here to edit. The sidebar's total comes from here.
  loadStats();

})();
`;
}

module.exports = { script };
