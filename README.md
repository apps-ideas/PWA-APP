# Storefront PWA — Shopify app

Makes a Shopify storefront installable as an app on desktop (Chrome, Edge,
Safari), Android and iOS, without touching theme code.

A merchant enables one app embed, sets a name and uploads a logo, and the store
gains an install prompt, a home screen icon, a splash screen and a standalone
window.

---

## Read this first: what works, and what cannot

Install works. Offline browsing does not, and on a stock Shopify storefront it
cannot be made to.

| | Desktop Chrome / Edge | Android Chrome | iOS Safari 16.4+ |
|---|---|---|---|
| Installable | yes | yes | yes |
| Home screen / dock icon | yes | yes, maskable | yes |
| Standalone window | yes | yes | yes |
| Splash screen | yes | yes | yes, generated |
| Shortcuts (right-click / long-press) | yes | yes | no |
| In-page Install button opens the native dialog | no¹ | no¹ | never² |
| Offline browsing | no³ | no³ | no³ |

1. Chrome fires `beforeinstallprompt` — the event a custom Install button needs
   — only when a service worker with a `fetch` handler controls the page. See
   the next section for why that cannot happen here. The app detects this and
   shows that browser's own install directions instead, which is why installing
   still works.
2. Safari has never exposed a programmatic install API on any platform.
3. Same root cause as 1.

### Why: Shopify strips `Service-Worker-Allowed`

A service worker can only control pages at or below the path it is served from.
This app's files are served through a Shopify app proxy at `/apps/pwa/`, so a
worker at `/apps/pwa/sw.js` controls `/apps/pwa/` and nothing else — not
`/products/…`, not the home page.

Widening that is what the `Service-Worker-Allowed: /` response header is for.
The server sends it. **Shopify removes it before the response reaches the
browser.** This was measured against a live storefront for
[`apps/izooto-push`](../izooto-push/README.md#worker-scope-confirmed-stripped):
present on a direct request to the backend, absent on the same response through
`/apps/<subpath>/`.

There is no way around it from inside an app:

- A theme asset is served from `cdn.shopify.com` — a different origin, so it
  cannot control the storefront at all, and its `<THEME_ID>` path changes on
  every publish.
- Shopify does not let anyone put a file at the domain root.
- No Liquid template can be served with a JavaScript content type.

So the worker is scope-limited to `/apps/pwa/`, and always will be through this
route. What changed is what lives at that path: the app's manifest now launches
at a **shell** served from the proxy root, inside the one directory the worker
is allowed to control.

- Online the shell is invisible. It registers the worker, then replaces itself
  with the merchant's own start URL, so the customer lands on the storefront
  exactly as before.
- Offline it is the difference between the app opening and the app failing. A
  cold launch with no connection is served from cache and shows a branded
  "you are offline" screen that reloads itself the moment a connection returns,
  instead of the browser's error page.

**The catalogue is still out of reach** — `/products/…`, `/collections/…` and
the cart are outside the worker's scope and no setting changes that. Offline
covers the launch, not browsing. The storefront check reports which case a given
store is in. If Shopify ever forwards the header, full offline browsing becomes
a checkbox rather than a project, and `manifest.startUrlFor` is the one function
that has to change.

**None of this affects installing.** Chrome dropped the service worker
requirement for installing from the browser menu in Chrome 108 (Android) and 112
(desktop) — a manifest over HTTPS is enough, which is exactly what this app
serves.

---

## Why the app exists at all

One rule: a manifest's `start_url` must be same-origin with the manifest.

Upload `manifest.json` as a theme asset and it is served from
`cdn.shopify.com`, where `start_url: "/"` resolves to the CDN root. Chrome
rejects it and the store is not installable — and the asset path contains a
theme ID that changes every time the theme is published or duplicated.

An **app proxy** fixes it. `/apps/pwa/*` is a permanent, same-origin path on the
storefront's own domain that survives every theme change. The manifest, icons,
iOS launch images and storefront script are all served from there.

---

## Layout

```
shopify.app.toml                  app config + [app_proxy]
test/smoke.js                     npm test — boots the server, exercises both surfaces
extensions/storefront-pwa/        theme app embed — injects the manifest link
  blocks/pwa.liquid
web/
  server.js                       routes: proxy surface + embedded admin
  settings.js                     per-shop JSON store
  stats.js                        per-shop install counters (in memory, flushed to JSON)
  validate.js                     coercion for everything the admin sends
  manifest.js                     manifest construction + iOS splash table
  images.js                       sharp: icon, maskable, splash rendering
  auth.js                         session tokens, proxy signature, webhook HMAC
  pages.js                        offline page + storefront self-test
  admin-page.js                   embedded admin (no build step)
  storefront/pwa.js               runs on every storefront page
  storefront/sw.js                service worker (dormant — see above)
```

Two surfaces with different trust models:

- **`/pwa/proxy/*`** — public, cacheable, no session. Reached from the storefront
  as `/apps/pwa/*`. A `<link rel="manifest">` fetch is uncredentialed by spec, so
  there is nothing here to authenticate.
- **`/` and `/api/*`** — the embedded admin. Every write is authorised by an App
  Bridge session token, and the shop comes from the token's `dest` claim, never
  from the request.

The app requests **no Admin API scopes** and stores no access token.

---

## Setup

### 1. Link the app

```bash
cd apps/pwa-app
npm install
shopify app config link       # writes the real client_id into shopify.app.toml
shopify app deploy            # uploads the theme app embed
```

### 2. Environment

| Variable | Required | What it does |
|---|---|---|
| `SHOPIFY_API_KEY` | yes | Client ID. Without it App Bridge cannot load and the admin will not open. |
| `SHOPIFY_API_SECRET` | yes | Verifies session tokens. Without it the admin is read-only. |
| `DATA_DIR` | yes in production | Where settings and images are written. Must survive a redeploy. |
| `PORT` | no | Defaults to 3007. |
| `PWA_VERIFY_PROXY` | no | `true` enforces Shopify's proxy signature. **Default off** — see below. |

Proxy signature verification is off by default because everything under
`/apps/pwa/` is a public static file fetched without a session, and a mismatch
would not fail loudly. It would un-install the PWA for every visitor at once,
with nothing on the storefront to say why. Turn it on only after confirming it
passes.

### 3. Turn on the app embed

Theme editor → **App embeds** → enable **Storefront PWA**. Nothing works until
this is on: it is what puts `<link rel="manifest">` in `<head>`.

### 4. Configure

Apps → Storefront PWA. Set the name and short name, upload a square logo of at
least 512×512, and set the theme and background colours. Everything else has a
working default.

Until a logo is uploaded the app generates a placeholder icon from the store's
initial, so the store is installable from the moment the embed is on.

The admin has eleven sections:

| Section | What it sets |
|---|---|
| **Status** | Master switch. Off leaves the theme untouched and makes the manifest non-installable. |
| **Installs** | Read-only. How many customers installed, how often they open the app, and how the install card is performing. |
| **App identity** | Name, short name, description, language, text direction, categories. |
| **App icon** | Upload, and the live render shown under all three platform masks. |
| **Appearance** | Theme and background colours, display mode, orientation. |
| **Launch behaviour** | Start URL, scope, and up to four shortcuts. |
| **Install prompt** | Whether to show the card, its delay, position, wording and dismissal period. |
| **iOS** | Launch screens, status bar style. |
| **Screenshots** | A wide and a narrow image for the richer install dialogs. |
| **Offline browsing** | The service worker toggle, and why it cannot work here. |

Two of those are worth knowing about before you use them.

**The icon previews are the real renders, not the file you picked.** The same
icon is shown three times — square for desktop and iOS, squircle and circle for
Android — because the commonest way a PWA icon goes wrong is a logo whose edges
vanish under Android's circular mask, and that is invisible in a flat thumbnail.
The placeholder is rendered here too, so the previews are never empty.

**There are two off switches, and they do different jobs.** The theme app embed
decides whether the tags are on the page at all; that is a theme change, made in
the theme editor, and it needs the theme published. The Status switch leaves the
theme alone and serves a manifest asking for a plain browser tab, which no
browser offers to install — it is the one to reach for when something looks
wrong on a live store. Existing installs keep working either way.

### 5. Verify on the storefront

```
https://<your-store>/apps/pwa/check
```

Run it on the storefront, not from the admin iframe — a service worker's real
scope and whether `beforeinstallprompt` fires can only be observed from the
origin in question. The page reports secure context, whether the manifest loads
and parses, whether `start_url` is same-origin, whether every declared icon
actually returns an image, the worker's real scope, and whether a programmatic
install prompt is available.

```bash
# Or from a terminal:
curl -s  "https://<your-store>/apps/pwa/manifest.json" | head -40
curl -sI "https://<your-store>/apps/pwa/icon-512.png"
curl -s  "https://<your-store>/apps/pwa/health"
```

---

## How settings are split

Almost everything lives in the **app admin**, because the app generates the
manifest and a second copy of those values in the theme editor would drift from
it within a week. The **theme app embed** only decides whether and where the PWA
loads, which is a theme decision.

The one deliberate exception is the theme colour override in the block:
`<meta name="theme-color">` has to be in the HTML at first paint to tint the
address bar before any script runs. Left blank — the default — the runtime
injects the admin's value, and it never overwrites a `theme-color` the theme
already set.

## Adding an install button to a theme

Any element with `data-pwa-install` triggers the install flow:

```liquid
<button type="button" data-pwa-install>Install our app</button>
```

Handled by delegation, so it works for markup rendered after the script runs.
Where the browser allows it, this opens the native dialog; everywhere else it
shows that browser's own directions.

The runtime also puts `pwa-standalone` on `<html>` when the store is running as
an installed app, which is the hook for hiding an "install" banner or a browser
chrome affordance from customers who already installed:

```css
.pwa-standalone .site-header__install { display: none; }
```

`window.ShopifyPWA` exposes `install()`, `dismiss()`, `platform`, `standalone`,
`canPrompt` and the service worker's real scope.

---

## Install figures

The admin's **Installs** section answers the question the app exists to answer:
is anyone actually installing this. Four counters, sent from `storefront/pwa.js`
as a `navigator.sendBeacon` POST to `/apps/pwa/event?type=<event>`, held in
memory and flushed to `DATA_DIR/stats/<shop>.json` every five seconds.

| Event | Fired when | Deduplicated |
|---|---|---|
| `shown` | The install card appears | Once per tab session |
| `clicked` | The visitor asks to install, by the card's button or a theme's `data-pwa-install` element | Once per tab session |
| `installed` | `appinstalled` fires, or `userChoice` resolves as accepted | Once per browser, forever |
| `launch` | A page loads in standalone display mode | Once per browser per UTC day |

Three things about these numbers are worth stating plainly, and the admin states
them too rather than presenting a count that looks more exact than it is:

- **They are keyed on browser storage.** One customer installing on a phone and a
  laptop is two; one who clears site data and reinstalls is also two.
- **iOS installs are counted late.** Safari fires neither `appinstalled` nor
  `beforeinstallprompt`, so an iOS install leaves no trace at the moment it
  happens. The first *launch* of the installed app is the only evidence there
  will ever be, and an iOS home screen app has its own storage separate from
  Safari's — so the install is counted then, by `countLaunch`. Without that, iOS
  would read as zero installs forever.
- **The endpoint is public, and has to be.** It is called from a storefront page
  with no session, so the counts are a number anyone with the URL can add to.
  There is a per-address cap of 60 events a minute, which makes inflating them
  cost more than a loop, and that is as far as a counter is worth defending.

Nothing that identifies a person is sent or stored — the beacon carries an event
name and nothing else, and the file holds four integers per day.

Days are bucketed **midnight to midnight UTC**, not in the shop's timezone: the
server does not know what timezone the shop trades in, and a bucket boundary
that moves with the reader is worse than one that is stated. Buckets are kept for
180 days.

## Caching

| Path | Cache-Control | Why |
|---|---|---|
| `manifest.json` | `max-age=300` | Short enough that a renamed app appears within a coffee break. |
| `pwa.js` | `max-age=600` | Config is baked in, so it must not be pinned for long. |
| `sw.js` | `no-cache` | A long-cached service worker is a fix you cannot ship. |
| icons, splash, screenshots | `max-age=31536000, immutable` | Content-addressed by `?v=<rev>`. The rev hashes the upload *and* the colours and initial that the maskable, splash and placeholder renders are drawn from, so changing any of them changes every URL. |
| `/offline`, `/check`, `/health` | `no-store` | A CDN copy of "you are offline" served to an online visitor is memorable. |
| `/event` | `no-store`, POST only | A cacheable GET would have the edge answering the second install of the day and never reaching the counter. |

## Tests

```bash
npm test
```

Boots the real server on a scratch `DATA_DIR` and makes 120 assertions across
both surfaces: manifest shape and the same-origin `start_url` rule, icon and
splash rendering, the size allow-lists, session-token rejection (no token, wrong
secret, expired, wrong `aud`), settings coercion, the master switch, icon upload
limits, cache-busting on a colour change, the install counters and their event
allow-list, and the uninstall webhook's HMAC and data deletion.

Two of those are there because they caught real bugs during development, and
both would have reached a storefront silently:

- **The served `pwa.js` and `sw.js` are parsed, not just checked for the
  placeholder.** The config token also appeared in each template's header
  comment, and `String.replace` with a string pattern substitutes only the first
  occurrence — so the config landed in the comment and the real assignment
  stayed a bare identifier. The result was valid JavaScript that threw
  `ReferenceError` on the first line of every storefront page. `loadTemplate` in
  `web/server.js` now refuses to boot if the token is not unique.
- **A colour change must move every icon URL.** Derived renders are served
  `immutable` for a year but were keyed only on the uploaded file's hash, so
  changing the background colour — which pads the maskable icons and paints the
  splash screens — would have served stale renders forever.

## Data

`DATA_DIR` holds `shops/<shop>.json`, `assets/<shop>/` and `stats/<shop>.json`.
Uploads are re-encoded to PNG through sharp, which also discards EXIF and any
trailing payload. Derived renders are cached beside the source, keyed by content
hash.

The `app/uninstalled` webhook deletes all three, and the stats cache entry goes
with the file — a surviving entry would be flushed straight back onto disk on
the next timer tick. Leaving a merchant's logo on disk after they remove the app
is not something to be casual about.

The counters assume a single process. The app listens on one port on 127.0.0.1
and is not clustered; two processes sharing a `DATA_DIR` would each hold their
own copy of a shop's counts and the last flush would win.
