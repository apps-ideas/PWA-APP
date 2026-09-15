/**
 * End-to-end smoke test: boots the real server and exercises both surfaces.
 *
 * Run with the app directory as cwd:  node smoke.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = 3457;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOP = 'demo-store.myshopify.com';
const API_KEY = 'test-client-id';
const API_SECRET = 'test-client-secret';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-smoke-'));

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a session token the way App Bridge would. */
function sessionToken(overrides) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = Object.assign({
    iss: 'https://' + SHOP + '/admin',
    dest: 'https://' + SHOP,
    aud: API_KEY,
    sub: '1',
    exp: now + 60,
    nbf: now - 10,
    iat: now,
    jti: '1',
    sid: 'abc',
  }, overrides || {});
  const payload = b64url(JSON.stringify(claims));
  const secret = (overrides && overrides.__secret) || API_SECRET;
  const sig = b64url(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest());
  return header + '.' + payload + '.' + sig;
}

function proxyUrl(p) {
  return BASE + '/pwa/proxy' + p + (p.includes('?') ? '&' : '?') +
    'shop=' + SHOP + '&path_prefix=%2Fapps%2Fpwa';
}

function admin(p, options) {
  const opts = options || {};
  opts.headers = Object.assign({ Authorization: 'Bearer ' + sessionToken() }, opts.headers || {});
  return fetch(BASE + p, opts);
}

const isPng = (buf) => buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

async function run() {
  console.log('\n== storefront proxy surface ==');

  let res = await fetch(BASE + '/healthz');
  const health = await res.json();
  ok('GET /healthz is 200', res.status === 200, 'got ' + res.status);
  ok('/healthz reports the api key and secret are set', health.apiKey === true && health.apiSecret === true);

  res = await fetch(proxyUrl('/manifest.json'));
  const manifest = await res.json();
  ok('manifest is 200', res.status === 200, 'got ' + res.status);
  ok('manifest content type', (res.headers.get('content-type') || '').includes('application/manifest+json'),
    res.headers.get('content-type'));
  ok('manifest launches at the shell, inside the worker scope',
    manifest.start_url === '/apps/pwa/', manifest.start_url);
  ok('manifest scope is still the whole storefront', manifest.scope === '/', manifest.scope);
  ok('manifest id is pinned to scope, so the move does not orphan installs',
    manifest.id === '/', manifest.id);
  ok('manifest display is standalone', manifest.display === 'standalone');
  ok('manifest has 192 and 512 icons',
    manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  ok('manifest has maskable icons', manifest.icons.some((i) => i.purpose === 'maskable'));
  ok('icon srcs use the forwarded proxy base',
    manifest.icons.every((i) => i.src.startsWith('/apps/pwa/')), manifest.icons[0].src);
  ok('manifest is cached briefly', (res.headers.get('cache-control') || '').includes('max-age=300'),
    res.headers.get('cache-control'));

  console.log('\n== launch shell ==');

  res = await fetch(proxyUrl('/'));
  const shell = await res.text();
  ok('the proxy root serves the shell', res.status === 200, 'got ' + res.status);
  ok('the shell is html',
    (res.headers.get('content-type') || '').includes('text/html'), res.headers.get('content-type'));
  ok('the shell forwards to the merchant store URL, not to itself',
    shell.includes('"/?source=pwa"') && !shell.includes('location.replace("/apps/pwa/")'));
  ok('the shell replaces rather than pushes history', shell.includes('location.replace'));
  ok('the shell has an offline state to fall back on', shell.includes('You are offline'));
  ok('the shell is kept out of search results', shell.includes('name="robots" content="noindex"'));

  res = await fetch(proxyUrl('/sw.js'));
  const swSource = await res.text();
  const swCfg = JSON.parse(swSource.match(/var CFG = (\{.*?\});/)[1]);
  ok('the worker is told where its shell is', swCfg.shellUrl === '/apps/pwa/', swCfg.shellUrl);
  ok('the shell is precached, so a cold offline launch has something to show',
    swCfg.precache.includes('/apps/pwa/'), JSON.stringify(swCfg.precache));
  ok('the offline page is precached too',
    swCfg.precache.includes('/apps/pwa/offline'), JSON.stringify(swCfg.precache));
  ok('the worker exempts its own pages from the blanket /apps/ exclusion',
    swSource.includes('var OURS = [CFG.shellUrl, CFG.offlineUrl]'));
  ok('but still refuses to cache the cart and checkout',
    swSource.includes('/^\\/cart/') && swSource.includes('/^\\/checkout/'));
  ok('the header is still sent, for the day Shopify stops stripping it',
    res.headers.get('service-worker-allowed') === '/', res.headers.get('service-worker-allowed'));

  console.log('\n== turning the worker off falls back to the store ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceWorker: { enabled: false, offlinePage: true, cacheVersion: 1 } }),
  });
  ok('the worker can be switched off', res.status === 200, 'got ' + res.status);

  res = await fetch(proxyUrl('/manifest.json'));
  const plain = await res.json();
  ok('with no worker the app launches straight at the store',
    plain.start_url === '/?source=pwa', plain.start_url);
  ok('and its identity is unchanged either way', plain.id === '/', plain.id);

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceWorker: { enabled: true, offlinePage: true, cacheVersion: 1 } }),
  });
  ok('and back on again', res.status === 200, 'got ' + res.status);

  // A manifest fetched without a shop is the "hit the backend directly" case.
  res = await fetch(BASE + '/pwa/proxy/manifest.json');
  ok('manifest without ?shop is 400', res.status === 400, 'got ' + res.status);

  res = await fetch(proxyUrl('/icon-512.png'));
  let body = Buffer.from(await res.arrayBuffer());
  ok('placeholder icon-512 renders a PNG', res.status === 200 && isPng(body), 'status ' + res.status);
  ok('icons are immutable-cached', (res.headers.get('cache-control') || '').includes('immutable'));

  res = await fetch(proxyUrl('/icon-192-maskable.png'));
  body = Buffer.from(await res.arrayBuffer());
  ok('maskable icon renders a PNG', res.status === 200 && isPng(body), 'status ' + res.status);

  res = await fetch(proxyUrl('/apple-touch-icon.png'));
  ok('apple-touch-icon renders', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())));

  res = await fetch(proxyUrl('/splash-1170x2532.png'));
  ok('iOS splash renders for a known device', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())),
    'status ' + res.status);

  res = await fetch(proxyUrl('/splash-13x17.png'));
  ok('an unlisted splash size is 404', res.status === 404, 'got ' + res.status);

  res = await fetch(proxyUrl('/icon-999.png'));
  ok('an unlisted icon size is 404', res.status === 404, 'got ' + res.status);

  res = await fetch(proxyUrl('/sw.js'));
  const sw = await res.text();
  ok('sw.js is 200', res.status === 200);
  ok('sw.js sends Service-Worker-Allowed', res.headers.get('service-worker-allowed') === '/');
  ok('sw.js is not long-cached', (res.headers.get('cache-control') || '').includes('no-cache'));
  ok('sw.js config is substituted', !sw.includes('__SW_CONFIG__') && sw.includes('cachePrefix'));

  res = await fetch(proxyUrl('/pwa.js'));
  const pwa = await res.text();
  ok('pwa.js is 200', res.status === 200);
  ok('pwa.js config is substituted', !pwa.includes('__PWA_CONFIG__'));
  ok('pwa.js carries the iOS splash table', pwa.includes('-webkit-device-pixel-ratio'));
  ok('pwa.js js content type', (res.headers.get('content-type') || '').includes('javascript'));

  // Parse what is actually served, not the template. A substitution that lands
  // in the wrong place still yields parseable JavaScript, so also assert the
  // config reached the assignment the script reads at runtime.
  for (const [label, source, token] of [['pwa.js', pwa, 'var CFG = {'], ['sw.js', sw, 'var CFG = {']]) {
    try {
      new (require('vm').Script)(source, { filename: label });
      ok('served ' + label + ' parses', true);
    } catch (err) {
      ok('served ' + label + ' parses', false, err.message);
    }
    ok('served ' + label + ' assigns a real config object', source.includes(token));
  }

  res = await fetch(proxyUrl('/offline'));
  ok('offline page is 200 and not stored', res.status === 200 && (res.headers.get('cache-control') || '').includes('no-store'));

  res = await fetch(proxyUrl('/check'));
  const check = await res.text();
  ok('check page is 200', res.status === 200);
  ok('check page links the manifest', check.includes('<link rel="manifest" href="/apps/pwa/manifest.json">'));

  res = await fetch(proxyUrl('/health'));
  ok('proxy health is 200', res.status === 200);

  console.log('\n== admin authentication ==');

  res = await fetch(BASE + '/api/settings');
  ok('settings with no token is 401', res.status === 401, 'got ' + res.status);

  res = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + sessionToken({ __secret: 'wrong' }) } });
  ok('settings with a token signed by the wrong secret is 401', res.status === 401, 'got ' + res.status);

  res = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + sessionToken({ exp: 1 }) } });
  ok('an expired token is 401', res.status === 401, 'got ' + res.status);

  res = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + sessionToken({ aud: 'someone-else' }) } });
  ok('a token minted for another app is 401', res.status === 401, 'got ' + res.status);

  res = await admin('/api/settings');
  const loaded = await res.json();
  ok('a valid token loads settings', res.status === 200 && loaded.shop === SHOP, 'status ' + res.status);

  console.log('\n== settings validation ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Demo Store',
      shortName: 'Demo',
      startUrl: 'https://evil.example/steal',
      scope: '/',
      themeColor: '#0a5c36',
      backgroundColor: '#ffffff',
      display: 'standalone',
      shortcuts: [{ name: 'Sale', url: '/collections/sale' }, { name: 'Bad', url: '//evil.example' }],
      assets: { icon: { present: true, rev: 'forged' } },
    }),
  });
  const saved = await res.json();
  ok('save is 200', res.status === 200, 'got ' + res.status);
  ok('an external start_url is rejected', saved.settings.startUrl === '/?source=pwa', saved.settings.startUrl);
  ok('the rejection is reported', saved.warnings.some((w) => w.includes('Start URL')));
  ok('a protocol-relative shortcut is dropped', saved.settings.shortcuts.length === 1);
  ok('a client cannot forge an uploaded icon', saved.settings.assets.icon.present === false);
  ok('the name is saved', saved.settings.name === 'Demo Store');

  res = await fetch(proxyUrl('/manifest.json'));
  const m2 = await res.json();
  ok('the manifest reflects the saved name', m2.name === 'Demo Store', m2.name);
  ok('the manifest reflects the saved shortcut', (m2.shortcuts || []).length === 1);
  ok('the manifest theme colour is saved', m2.theme_color === '#0a5c36', m2.theme_color);

  console.log('\n== master switch ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, saved.settings, { enabled: false })),
  });
  const off = await res.json();
  ok('the app can be switched off', off.settings.enabled === false);

  res = await fetch(proxyUrl('/manifest.json'));
  const mOff = await res.json();
  ok('a disabled manifest is still served', res.status === 200);
  ok('a disabled manifest is not installable', mOff.display === 'browser', mOff.display);
  ok('display_override drops to browser only', JSON.stringify(mOff.display_override) === '["browser"]');

  res = await fetch(proxyUrl('/pwa.js'));
  const offScript = await res.text();
  ok('a disabled pwa.js is inert but valid', res.status === 200 && !offScript.includes('beforeinstallprompt'));

  res = await fetch(proxyUrl('/health'));
  ok('health reports the switch', (await res.json()).enabled === false);

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, saved.settings, { enabled: true, categories: ['shopping', 'lifestyle'] })),
  });
  const backOn = await res.json();
  ok('the app can be switched back on', backOn.settings.enabled === true);
  ok('categories are saved', backOn.settings.categories.join(',') === 'shopping,lifestyle');

  res = await fetch(proxyUrl('/manifest.json'));
  const mOn = await res.json();
  ok('re-enabling restores the display mode', mOn.display === 'standalone', mOn.display);
  ok('the manifest carries the categories', (mOn.categories || []).join(',') === 'shopping,lifestyle');

  console.log('\n== icon upload ==');

  const sharp = require(path.join(APP, 'node_modules', 'sharp'));
  const logo = await sharp({
    create: { width: 600, height: 600, channels: 3, background: '#c0392b' },
  }).png().toBuffer();

  res = await admin('/api/assets/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: logo,
  });
  const uploaded = await res.json();
  ok('icon upload is 200', res.status === 200, 'got ' + res.status + ' ' + JSON.stringify(uploaded).slice(0, 120));
  ok('the icon is recorded as present', uploaded.settings.assets.icon.present === true);
  ok('the icon dimensions are measured', uploaded.settings.assets.icon.width === 600);
  ok('a preview thumbnail comes back', typeof uploaded.previews.icon === 'string' &&
    uploaded.previews.icon.startsWith('data:image/png;base64,'));
  ok('a maskable preview comes back too', typeof uploaded.previews.iconMaskable === 'string' &&
    uploaded.previews.iconMaskable.startsWith('data:image/png;base64,'));
  ok('the two previews differ', uploaded.previews.icon !== uploaded.previews.iconMaskable);

  // The placeholder must preview as well, or the admin looks broken before the
  // first upload — which is exactly when a merchant needs to see something.
  res = await admin('/api/assets/icon', { method: 'DELETE' });
  const cleared = await res.json();
  ok('the icon can be removed', cleared.settings.assets.icon.present === false);
  ok('the placeholder still previews', typeof cleared.previews.icon === 'string' &&
    cleared.previews.icon.startsWith('data:image/png;base64,'));

  // Put it back for the remaining checks.
  await admin('/api/assets/icon', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: logo });

  res = await fetch(proxyUrl('/manifest.json'));
  const m3 = await res.json();
  // The URL rev is renderRev, not the upload's own hash: it also covers the
  // colours the maskable and splash renders are drawn from. So assert that it
  // moved, not what it equals.
  ok('uploading an icon changes every icon URL',
    m3.icons[0].src !== manifest.icons[0].src, m3.icons[0].src);

  res = await fetch(proxyUrl('/icon-512.png'));
  ok('the uploaded icon renders at 512', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())));

  // A too-small logo must be refused rather than upscaled into a blurry icon.
  const small = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#000' } }).png().toBuffer();
  res = await admin('/api/assets/icon', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: small });
  ok('a logo under 512px is rejected', res.status === 400, 'got ' + res.status);

  res = await admin('/api/assets/icon', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('not an image') });
  ok('a non-image body is rejected', res.status === 400, 'got ' + res.status);

  res = await admin('/api/assets/nonsense', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: logo });
  ok('an unknown asset kind is rejected', res.status === 400, 'got ' + res.status);

  console.log('\n== colour changes bust the year-long icon cache ==');

  // The maskable icons are padded with the background colour and the splash
  // screens are drawn on it, so a colour change must move their URLs — they are
  // served immutable for a year and there is no other way to flush them.
  const beforeColour = await (await fetch(proxyUrl('/manifest.json'))).json();
  const beforePwa = await (await fetch(proxyUrl('/pwa.js'))).text();

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, backOn.settings, { backgroundColor: '#123456' })),
  });
  ok('the background colour saves', (await res.json()).settings.backgroundColor === '#123456');

  const afterColour = await (await fetch(proxyUrl('/manifest.json'))).json();
  const afterPwa = await (await fetch(proxyUrl('/pwa.js'))).text();

  ok('the maskable icon URL changes with the background colour',
    beforeColour.icons[1].src !== afterColour.icons[1].src, afterColour.icons[1].src);
  ok('the splash URLs in pwa.js change too',
    beforePwa !== afterPwa && afterPwa.includes('/splash-'));
  ok('background_color is reflected in the manifest', afterColour.background_color === '#123456');

  res = await fetch(proxyUrl('/icon-192-maskable.png'));
  ok('the recoloured maskable icon renders', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())));

  console.log('\n== forcing a refresh ==');

  const swVersion = async () =>
    JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text()).match(/var CFG = (\{.*?\});/)[1]).version;

  const derivedDir = path.join(DATA_DIR, 'assets', SHOP, 'derived');

  // Ask for a splash and an icon first, so there is something on disk to clear.
  await fetch(proxyUrl('/splash-1170x2532.png'));
  await fetch(proxyUrl('/icon-512.png'));
  ok('derived renders are cached on disk', fs.existsSync(derivedDir) &&
    fs.readdirSync(derivedDir).length > 0);

  const iconsBefore = (await (await fetch(proxyUrl('/manifest.json'))).json()).icons[0].src;
  const swBefore = await swVersion();
  const renderVersionBefore = (await (await admin('/api/settings')).json()).settings.renderVersion;

  res = await fetch(BASE + '/api/cache/clear', { method: 'POST' });
  ok('forcing a refresh needs a session token', res.status === 401, 'got ' + res.status);

  res = await admin('/api/cache/clear', { method: 'POST' });
  const refreshed = await res.json();
  ok('forcing a refresh is 200', res.status === 200, 'got ' + res.status);
  ok('it bumps the render version',
    refreshed.settings.renderVersion === renderVersionBefore + 1, String(refreshed.settings.renderVersion));
  ok('it bumps the service worker cache version',
    (await swVersion()) === swBefore + 1, String(await swVersion()));
  // Not "the directory is empty": the response re-renders the admin's preview
  // thumbnails, so it legitimately holds fresh files at the new rev by the time
  // we look. What must be gone is everything keyed on the old one, or the
  // superseded renders would sit there forever under keys nothing asks for.
  const oldRev = new URL('http://x' + iconsBefore).searchParams.get('v');
  const survivors = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((f) => f.includes(oldRev))
    : [];
  ok('it clears the superseded renders off disk', survivors.length === 0, survivors.join(','));
  ok('and the rev it cleared was a real one', Boolean(oldRev), String(oldRev));
  ok('previews are re-rendered for the admin', typeof refreshed.previews.icon === 'string' &&
    refreshed.previews.icon.startsWith('data:image/png;base64,'));

  const iconsAfter = (await (await fetch(proxyUrl('/manifest.json'))).json()).icons[0].src;
  ok('every icon URL moves, so the year-long cache cannot serve the old one',
    iconsAfter !== iconsBefore, iconsBefore + ' -> ' + iconsAfter);

  res = await fetch(proxyUrl('/icon-512.png'));
  ok('icons still render at the new address',
    res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())), 'status ' + res.status);

  // Nothing the merchant chose may move: a refresh is a cache operation, not an
  // edit, and a button that quietly reset a colour would be worse than no
  // button at all.
  ok('the merchant’s own settings are untouched',
    refreshed.settings.name === backOn.settings.name &&
    refreshed.settings.backgroundColor === '#123456' &&
    refreshed.settings.enabled === true,
    JSON.stringify({ n: refreshed.settings.name, b: refreshed.settings.backgroundColor }));

  // The subtle one. sanitise() builds its result by spreading defaults(), so a
  // counter that is not carried across explicitly is silently reset to 1 by the
  // merchant's next save — undoing the refresh they just asked for.
  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, refreshed.settings, { name: 'Renamed After Refresh' })),
  });
  const afterSave = await res.json();
  ok('an ordinary save does not undo the refresh',
    afterSave.settings.renderVersion === renderVersionBefore + 1,
    String(afterSave.settings.renderVersion));
  ok('and a client cannot forge the render version',
    (await (await admin('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, refreshed.settings, { renderVersion: 9999 })),
    })).json()).settings.renderVersion === renderVersionBefore + 1);

  console.log('\n== install counters ==');

  // The storefront sends these as a bare beacon: POST, no body, event name in
  // the query string, shop supplied by the proxy.
  function event(type) {
    return fetch(proxyUrl('/event?type=' + type), { method: 'POST' });
  }

  res = await event('shown');
  ok('an event beacon is 204', res.status === 204, 'got ' + res.status);
  ok('the beacon is never cached', (res.headers.get('cache-control') || '').includes('no-store'));

  await event('shown');
  await event('clicked');
  await event('installed');
  await event('installed');
  await event('launch');

  res = await event('not-an-event');
  ok('an unknown event name is still 204', res.status === 204, 'got ' + res.status);

  res = await fetch(BASE + '/pwa/proxy/event?type=installed', { method: 'POST' });
  ok('an event without ?shop is 400', res.status === 400, 'got ' + res.status);

  res = await admin('/api/stats');
  const counts = await res.json();
  ok('stats need a session token', (await fetch(BASE + '/api/stats')).status === 401);
  ok('stats are 200 for a valid token', res.status === 200, 'got ' + res.status);
  ok('installs are counted', counts.totals.installed === 2, JSON.stringify(counts.totals));
  ok('card impressions are counted', counts.totals.shown === 2, JSON.stringify(counts.totals));
  ok('taps are counted', counts.totals.clicked === 1);
  ok('app opens are counted', counts.totals.launch === 1);
  ok('an unknown event name is not stored',
    Object.keys(counts.totals).length === 4, JSON.stringify(counts.totals));
  ok('the window defaults to 30 days', counts.windowDays === 30, String(counts.windowDays));
  ok('the series has a row per day, including the empty ones', counts.series.length === 30,
    String(counts.series.length));
  ok('today is the last row of the series',
    counts.series[29].date === new Date().toISOString().slice(0, 10), counts.series[29].date);
  ok('today carries the installs just recorded', counts.series[29].installed === 2);
  ok('the window is clamped to the retention period',
    (await (await admin('/api/stats?days=9999')).json()).windowDays === 180);

  // The ceiling is per shop, not per address: behind nginx every request comes
  // from 127.0.0.1, and behind Shopify's app proxy every legitimate storefront
  // event in the fleet shares a handful of edge addresses.
  const flood = [];
  for (let i = 0; i < 1400; i++) flood.push(event('shown'));
  await Promise.all(flood);

  const capped = await (await admin('/api/stats')).json();
  ok('a flood is capped rather than counted',
    capped.totals.shown > 1000 && capped.totals.shown <= 1202, String(capped.totals.shown));
  ok('the cap does not disturb the other counters',
    capped.totals.installed === 2 && capped.totals.launch === 1, JSON.stringify(capped.totals));

  // The storefront script has to be told where to send them, or nothing above
  // ever happens on a real store.
  res = await fetch(proxyUrl('/pwa.js'));
  const counting = await res.text();
  ok('pwa.js carries the event endpoint', counting.includes('"eventUrl":"/apps/pwa/event"'));
  ok('pwa.js counts installs off appinstalled', counting.includes("addEventListener('appinstalled'"));
  ok('pwa.js sends by beacon so an unloading page still counts',
    counting.includes('navigator.sendBeacon'));

  console.log('\n== uninstall webhook ==');

  const payload = Buffer.from(JSON.stringify({ shop_domain: SHOP }));
  res = await fetch(BASE + '/webhooks/app/uninstalled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': 'wrong', 'X-Shopify-Shop-Domain': SHOP },
    body: payload,
  });
  ok('a webhook with a bad HMAC is 401', res.status === 401, 'got ' + res.status);
  ok('settings survive a rejected webhook', fs.existsSync(path.join(DATA_DIR, 'shops', SHOP + '.json')));

  const hmac = crypto.createHmac('sha256', API_SECRET).update(payload).digest('base64');
  res = await fetch(BASE + '/webhooks/app/uninstalled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Shop-Domain': SHOP },
    body: payload,
  });
  ok('a valid uninstall webhook is 200', res.status === 200, 'got ' + res.status);
  ok('settings are deleted on uninstall', !fs.existsSync(path.join(DATA_DIR, 'shops', SHOP + '.json')));
  ok('uploaded assets are deleted on uninstall', !fs.existsSync(path.join(DATA_DIR, 'assets', SHOP)));

  // Asserted through the API rather than off the disk: the counts are held in
  // memory between flushes, so a file that is absent proves nothing. What has
  // to be true is that the in-memory copy went with the file — otherwise the
  // next flush would write the departed merchant's counts straight back.
  const afterUninstall = await (await admin('/api/stats')).json();
  ok('install counts are deleted on uninstall',
    afterUninstall.totals.installed === 0 && afterUninstall.lastEventAt === null,
    JSON.stringify(afterUninstall.totals));
  ok('the stats file is gone too', !fs.existsSync(path.join(DATA_DIR, 'stats', SHOP + '.json')));
}

const server = spawn(process.execPath, ['web/server.js'], {
  cwd: APP,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    PWA_VERIFY_PROXY: 'false',
    NODE_ENV: 'test',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer(attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  try {
    if (!(await waitForServer(40))) throw new Error('server did not start\n' + serverLog);
    await run();
  } catch (err) {
    failures.push('threw: ' + err.message);
    console.error(err);
  } finally {
    server.kill();
    console.log('\n--- server log ---\n' + serverLog.trim());
    console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(failures.length ? 1 : 0);
  }
})();
