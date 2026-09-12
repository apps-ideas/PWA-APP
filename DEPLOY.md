# Deploying Storefront PWA to a Hostinger VPS

A standalone runbook for putting **this app alone** on a fresh Hostinger VPS.

If you are deploying the whole `gaapps.cloud` fleet, use the workspace-level
[`DEPLOY.md`](../../DEPLOY.md) instead — steps 1–5 there are shared setup that
this guide repeats in single-app form. Everything here is consistent with it:
same service account, same paths, same port, so an app deployed with this guide
slots into the fleet later without being moved.

---

## What you are deploying

One Node process. No database, no frontend build step, no Redis, no queue.

```
browser / Shopify ──▶ nginx :443 (TLS)  ──▶ node :3007 (127.0.0.1 only)
                      pwa.gaapps.cloud       /opt/gaapps/pwa-app
                                                     │
                                                     ▼
                                          /var/lib/gaapps/pwa-app
                                          shops/*.json + assets/<shop>/
```

| | |
|---|---|
| Runtime | Node 20+ (this guide installs 22 LTS) |
| Dependencies | `express`, `sharp` (native — see step 5) |
| Port | `3007`, bound to `127.0.0.1` only |
| Code | `/opt/gaapps/pwa-app` — replaced on every deploy |
| State | `/var/lib/gaapps/pwa-app` — **must survive** a deploy |
| Secrets | `/etc/gaapps/pwa-app.env`, `640 root:gaapps` |
| Hostname | `pwa.gaapps.cloud` |
| Build step | none — the admin page is server-rendered |

Two HTTP surfaces on that one port, with different trust models:

- **`/pwa/proxy/*`** — public, no session. Shopify's app proxy forwards
  `https://<shop>/apps/pwa/*` here. This is the manifest, the icons, the iOS
  splash images and the storefront script.
- **`/` and `/api/*`** — the embedded admin, authorised per request by an App
  Bridge session token.

The app requests **no Admin API scopes** and stores no access token, so there is
no OAuth token database to provision or back up.

### Sizing

Hostinger's smallest KVM plan is enough. One Express process with two
dependencies, serving a few dozen settings fields per storefront and a handful
of cached PNGs — it idles at roughly what a bare Node process costs.

The only real load is `sharp` rendering the nineteen iOS launch images the first
time a shop is configured, the largest at 2048×2732: CPU- and memory-bound for a
few seconds, then cached to disk forever. Two vCPU and 4 GB is comfortable;
1 vCPU / 1 GB works, but add swap (step 1) or that first render can OOM.

---

## Before you start

Have these in hand:

- A Hostinger VPS running **Ubuntu 24.04**, root SSH access, and its IPv4.
- DNS control for `gaapps.cloud` (or whichever domain you are using).
- From the Shopify Partner dashboard, this app's **Client ID** and **Client
  secret**. The Client ID is already in [`shopify.app.toml`](shopify.app.toml)
  as `client_id`; the secret is only ever shown in the dashboard.
- The Shopify CLI on your workstation (`npm i -g @shopify/cli`), for pushing the
  app config and the theme extension.

Replace `pwa.gaapps.cloud` throughout if you are hosting elsewhere — it appears
in `shopify.app.toml`, the nginx vhost and the Partner dashboard, and all three
must agree.

---

## Handing the deploy to an agent

Steps 3–11 are mechanical and all happen on one box, which makes them a
reasonable thing to delegate to Claude Code or another coding agent with SSH
access. Steps 1, 2, 12 and 13 are not: they happen in GitHub's settings, your
DNS provider, the Partner dashboard and the theme editor, and they need a human
in a browser.

Fill in the four values and paste this:

```text
Deploy the Storefront PWA Shopify app to my Hostinger VPS by following
apps/pwa-app/DEPLOY.md in this repo. Work through steps 3 to 11 only.

  VPS        <VPS_IP>, Ubuntu 24.04, root over ssh
  Hostname   pwa.gaapps.cloud
  Client ID  <CLIENT_ID>
  Repo       git@github.com:apps-ideas/PWA-APP.git

How I want this run:

- Steps in order. After each one, run that step's Check and show me the
  output. If a Check fails, stop and tell me — do not work around it and
  do not continue to the next step.
- I have already done steps 1 and 2 (token revoked, DNS pointed). Still
  confirm DNS with `dig +short pwa.gaapps.cloud` before step 10.
- Ask me for SHOPIFY_API_SECRET when you reach step 6. Do not echo it back
  to me, do not write it anywhere but /etc/gaapps/pwa-app.env, and do not
  put it in a command line that lands in shell history.

Stop and ask me first before:

- running certbot — Let's Encrypt rate-limits failures at 5 per hostname
  per hour, so a blind retry can lock the host out for the rest of the hour;
- any command that writes to or deletes anything under
  /var/lib/gaapps/pwa-app — that is live merchant data, not build output;
- overwriting /etc/gaapps/pwa-app.env if it already exists.

Never do these, even if something seems to call for it:

- setting PWA_VERIFY_PROXY=true (it can silently un-install the PWA for
  every visitor);
- adding an X-Frame-Options header anywhere in the nginx config;
- pointing DATA_DIR anywhere but /var/lib/gaapps/pwa-app.

When step 11 is done, stop. Steps 12 and 13 are mine — tell me exactly what
to do in the Partner dashboard and the theme editor.
```

The prohibitions are there because each one is a failure an agent cannot see the
consequences of: `PWA_VERIFY_PROXY` breaks storefronts silently rather than
erroring, `X-Frame-Options` produces a blank panel whose console error never
mentions nginx, and a `DATA_DIR` under `/opt` looks fine until the first
redeploy takes the merchants' settings with it.

---

# The short version

Fourteen steps, in order, with a check after each one. Every command is
copy-paste except the four placeholders below. If a check fails, the numbered
step further down this document explains that step in full — and the
[Troubleshooting](#troubleshooting) table names the usual cause.

| Placeholder | Where it comes from |
|---|---|
| `<VPS_IP>` | Hostinger panel → your VPS → IPv4 address |
| `<CLIENT_ID>` | Partner dashboard → Storefront PWA → Client credentials (already in `shopify.app.toml`) |
| `<CLIENT_SECRET>` | Partner dashboard → same page. Shown there only |
| `<your-store>` | Your storefront domain, e.g. `www.example.com` |

Steps 1–2 are on your own machine. Steps 3–11 are on the VPS as `root`.
Steps 12–14 are back on your machine and in the browser.

### 1 · Revoke the leaked GitHub token — on your machine

This repo's remote has a personal access token in the URL. Revoke it at GitHub →
**Settings → Developer settings → Personal access tokens**, then:

```bash
git remote set-url origin git@github.com:apps-ideas/PWA-APP.git
```

**Check:** `git remote -v` shows no `ghp_…` in the URL. → [detail](#step-0--rotate-the-leaked-github-token)

### 2 · Point DNS at the VPS — at your DNS provider

Add one A record: name `pwa`, value `<VPS_IP>`, TTL 300. Add AAAA too if the VPS
has IPv6.

```bash
dig +short pwa.gaapps.cloud
```

**Check:** it prints `<VPS_IP>`. Do not go past step 9 until it does — certbot
fails otherwise, and five failures per hour locks you out. → [detail](#step-2--dns)

### 3 · Install the base system — ssh in as root

```bash
apt update && apt upgrade -y
apt install -y curl git nginx ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

**Check:** `node -v` prints `v22.x`. Anything below v20 makes step 6 fail
outright. → [detail](#step-1--server-base)

### 4 · Create the service account and directories

```bash
adduser --system --group --no-create-home --home /opt/gaapps gaapps
mkdir -p /opt/gaapps /etc/gaapps /var/lib/gaapps/pwa-app
chown -R gaapps:gaapps /opt/gaapps /var/lib/gaapps
chmod 750 /etc/gaapps
```

On a 1 GB plan add swap now, or the first splash render can OOM-kill the app:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Check:** `ls -ld /var/lib/gaapps/pwa-app` shows `gaapps gaapps`. → [detail](#step-1--server-base)

### 5 · Get the code onto the server

```bash
mkdir -p /opt/gaapps/.ssh && chown gaapps:gaapps /opt/gaapps/.ssh
sudo -u gaapps ssh-keygen -t ed25519 -f /opt/gaapps/.ssh/id_ed25519 -N "" -C "pwa-app-vps"
cat /opt/gaapps/.ssh/id_ed25519.pub
```

Add that key to the repo on GitHub under **Settings → Deploy keys** (read-only),
then:

```bash
cd /opt/gaapps
sudo -u gaapps git clone git@github.com:apps-ideas/PWA-APP.git pwa-app
```

No repo access? `scp -r` the folder instead — see
[the fallback](#without-a-repo-first-deploy-or-repo-not-reachable), and delete
the `.env` and `node_modules` that ride along with it.

**Check:** `ls /opt/gaapps/pwa-app/web/server.js` exists. The directory name must
be exactly `pwa-app`. → [detail](#step-3--get-the-code-onto-the-server)

### 6 · Write the secrets file

```bash
cat > /etc/gaapps/pwa-app.env <<'EOF'
NODE_ENV=production
PORT=3007
SHOPIFY_API_KEY=<CLIENT_ID>
SHOPIFY_API_SECRET=<CLIENT_SECRET>
DATA_DIR=/var/lib/gaapps/pwa-app
PWA_VERIFY_PROXY=false
EOF

nano /etc/gaapps/pwa-app.env          # replace the two placeholders
chown root:gaapps /etc/gaapps/pwa-app.env
chmod 640 /etc/gaapps/pwa-app.env
```

No quotes around the values — systemd would make the quote marks part of the
secret. Leave `PWA_VERIFY_PROXY=false`; turning it on before step 13 passes can
silently un-install the PWA for every visitor.

**Check:** `grep -c '<CLIENT' /etc/gaapps/pwa-app.env` returns `0` — i.e. both
placeholders are gone. → [detail](#step-4--the-environment-file)

### 7 · Install dependencies and prove the data directory

```bash
cd /opt/gaapps/pwa-app
sudo -u gaapps npm install
install -d -o gaapps -g gaapps /var/lib/gaapps/pwa-app
sudo -u gaapps env DATA_DIR=/var/lib/gaapps/pwa-app \
  node -e "require('./web/settings.js'); console.log('data dir writable')"
```

`sharp` failed to install? `apt install -y build-essential libvips-dev`, then
re-run `npm install`.

**Check:** it prints `data dir writable`, and `ls /var/lib/gaapps/pwa-app` shows
`shops` and `assets`. There is no build step — that is correct, not an omission.
→ [detail](#step-5--install-dependencies)

### 8 · Start the service

Write the unit from [step 6 below](#step-6--systemd-service) (copy the whole
`cat > /etc/systemd/system/pwa-app.service` block), then:

```bash
systemctl daemon-reload
systemctl enable --now pwa-app
curl -s localhost:3007/healthz
```

**Check:** the JSON shows `"apiKey":true`, `"apiSecret":true`, and
`"dataDir":"/var/lib/gaapps/pwa-app"`. A `false` means step 6 did not take —
`systemctl restart pwa-app` (a *reload* will not re-read the env file).
→ [detail](#step-6--systemd-service)

### 9 · Put nginx in front

Write the vhost from [step 7 below](#step-7--nginx-and-tls) (copy the whole
`cat > /etc/nginx/sites-available/…` block), then:

```bash
ln -sf /etc/nginx/sites-available/pwa.gaapps.cloud.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
for l in /etc/nginx/sites-enabled/*; do [ -e "$l" ] || echo "BROKEN: $l"; done
nginx -t && systemctl reload nginx
```

**Check:** the loop prints nothing, and `curl -sI http://pwa.gaapps.cloud/healthz`
returns 200. `nginx -t` passing is *not* sufficient — it reports "syntax is ok"
even when every vhost symlink dangles. → [detail](#step-7--nginx-and-tls)

### 10 · Issue the certificate

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx --agree-tos -m you@example.com --redirect -d pwa.gaapps.cloud
```

**Check:** `curl -s https://pwa.gaapps.cloud/healthz` returns the same JSON as
step 8. HTTPS is mandatory — a manifest is only honoured in a secure context,
and Shopify rejects an `http://` app URL. → [detail](#step-7--nginx-and-tls)

### 11 · Do not add X-Frame-Options

Nothing to run. Just never add that header at the nginx layer — the app sends
its own `frame-ancestors` CSP naming the requesting shop, and an
`X-Frame-Options` overrides it, turning the admin into a blank panel with a
console error that never mentions nginx. → [detail](#never-add-x-frame-options)

### 12 · Register the app with Shopify — on your machine

Confirm `application_url`, `redirect_urls` and `[app_proxy] url` in
[`shopify.app.toml`](shopify.app.toml) all name `pwa.gaapps.cloud`, and that the
proxy URL still ends in **`/pwa/proxy`** — without that suffix every storefront
page links to a 404 manifest. Then, in this directory:

```bash
npm install
shopify app config push
shopify app deploy
```

**Check:** the Partner dashboard shows the new URLs under **Configuration** and
**App proxy**. Then install (or reinstall) the app once from the Shopify admin —
changing redirect URLs invalidates existing grants. → [detail](#step-8--register-the-app-with-shopify)

### 13 · Turn it on in the store and verify — in the browser

1. **Theme editor → App embeds → enable "Storefront PWA".** Nothing reaches the
   storefront until this is on.
2. **Apps → Storefront PWA** in the Shopify admin. Set the name and short name,
   upload a square logo of 512×512 or larger, save.
3. Open `https://<your-store>/apps/pwa/check` **on the storefront**, not in the
   admin iframe.

From a terminal:

```bash
curl -s  https://<your-store>/apps/pwa/health
curl -s  https://<your-store>/apps/pwa/manifest.json | head -40
curl -sI https://<your-store>/apps/pwa/icon-512.png
```

**Check:** the admin renders inside the iframe rather than blank; `/check` passes
every row; the icon returns `200` and `image/png`. A 404 here while
`/healthz` works means the proxy URL lost its `/pwa/proxy` suffix.

Offline browsing failing is expected, not a deploy fault — Shopify strips
`Service-Worker-Allowed`. Installing is unaffected. → [detail](#step-9--verify)

### 14 · Install it, then set up backups

Install the store from the browser menu on desktop and Android, and via
**Share → Add to Home Screen** on iOS. Then, on the VPS:

```bash
tar czf /root/pwa-app-$(date +%F).tar.gz -C /var/lib/gaapps pwa-app
```

**Check:** the tarball contains `shops/` and `assets/`. The code is in git; the
data directory is the only thing on that box you cannot recreate. Put this on a
nightly cron with an off-box copy. → [detail](#backups)

---

Redeploying later is three commands — `git pull`, `npm install`,
`systemctl restart pwa-app`. See [step 10](#step-10--redeploying-after-a-code-change).

---

# The long version

The same procedure with the reasoning behind it, grouped by subject rather than
by keystroke — so one section here can cover two of the steps above (server base
is steps 3 and 4; nginx and TLS is steps 9, 10 and 11). Every step above links
straight to its section.

---

## Step 0 — Rotate the leaked GitHub token

**Do this first.** This checkout's `origin` remote has a GitHub personal access
token embedded in the URL:

```
https://ghp_…@github.com/apps-ideas/PWA-APP.git
```

A token in a remote URL is a token in every copy of the repo, including the one
you are about to put on a public-facing server, and `git remote -v` prints it in
full to anyone with shell access.

1. GitHub → **Settings → Developer settings → Personal access tokens** → revoke
   that token.
2. Repoint this checkout at a clean URL:

   ```bash
   git remote set-url origin git@github.com:apps-ideas/PWA-APP.git
   ```

3. Use a **deploy key** for the server (step 3), not a PAT. A deploy key is
   scoped to one repository and can be read-only.

Nothing else in this app carries a secret in source — `SHOPIFY_API_SECRET` is
read from the environment and is not in git.

---

## Step 1 — Server base

SSH in as root and set the machine up.

```bash
apt update && apt upgrade -y
apt install -y curl git nginx ufw

# Node 22 LTS. Ubuntu's own nodejs package is older than this app's engines
# field (">=20"), and .npmrc sets engine-strict=true, so npm install will
# refuse outright rather than warn.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v    # must print v22.x
```

Firewall. Port 3007 is deliberately **not** opened — the app binds to
`127.0.0.1` and is reachable only through nginx:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

On a 1 GB plan, add swap so the first splash render cannot OOM-kill the service:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Service account and directory layout. The split between `/opt` and `/var/lib` is
the load-bearing part of this whole guide:

```bash
adduser --system --group --no-create-home --home /opt/gaapps gaapps

mkdir -p /opt/gaapps               # code — replaced on every deploy
mkdir -p /etc/gaapps               # secrets, root-owned
mkdir -p /var/lib/gaapps/pwa-app   # state — must survive a deploy

chown -R gaapps:gaapps /opt/gaapps /var/lib/gaapps
chmod 750 /etc/gaapps
```

`/var/lib/gaapps/pwa-app` holds every merchant's settings, their uploaded logo
and screenshots, and the icons and splash screens rendered from them. Put it
under `/opt` and the next deploy wipes it.

> **Hostinger panel note:** if you use the panel's own firewall as well as
> `ufw`, allow 22, 80 and 443 there too. The two firewalls are independent, and
> a rule missing from either blocks the traffic. A panel firewall that omits 80
> is a common reason certbot fails in step 7 with no obvious cause.

---

## Step 2 — DNS

One A record at your DNS provider:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `pwa` | `<VPS_IPv4>` | 300 |

Add an AAAA record too if the VPS has IPv6 — the nginx vhost listens on both.

**Wait for it to resolve before step 7.** Certbot fails when the name does not
yet point at this box, and failed attempts count against Let's Encrypt's rate
limit of five failures per hostname per hour.

```bash
dig +short pwa.gaapps.cloud     # must return the VPS IP
```

Raise the TTL once everything is verified.

---

## Step 3 — Get the code onto the server

### With a deploy key (preferred)

On the server:

```bash
mkdir -p /opt/gaapps/.ssh && chown gaapps:gaapps /opt/gaapps/.ssh
sudo -u gaapps ssh-keygen -t ed25519 -f /opt/gaapps/.ssh/id_ed25519 -N "" -C "pwa-app-vps"
cat /opt/gaapps/.ssh/id_ed25519.pub
```

Add that public key to the repo on GitHub under **Settings → Deploy keys**,
read-only. Then clone:

```bash
cd /opt/gaapps
sudo -u gaapps git clone git@github.com:apps-ideas/PWA-APP.git pwa-app
```

The directory name must be exactly `pwa-app` — the systemd unit and the nginx
vhost reference it literally.

### Without a repo (first deploy, or repo not reachable)

From your Windows machine. Delete `node_modules` from the copy first or the
transfer takes hours; step 5 reinstalls it on the server anyway:

```powershell
# PowerShell, from d:\app\01-hostinger-apps\apps
scp -r pwa-app root@<VPS_IP>:/opt/gaapps/
```

Then on the server:

```bash
rm -rf /opt/gaapps/pwa-app/node_modules /opt/gaapps/pwa-app/.env
chown -R gaapps:gaapps /opt/gaapps/pwa-app
```

Deleting the local `.env` matters. It is gitignored, so a clone never has one —
but `scp -r` copies it, and `web/load-env.js` reads it. Real environment
variables win over it, so it is not a functional problem; it is a stale copy of
your secrets sitting on a public-facing server for no reason.

---

## Step 4 — The environment file

Secrets live in `/etc/gaapps/pwa-app.env`, read by systemd and injected into the
process. They are never deployed as a file inside the checkout.

```bash
cat > /etc/gaapps/pwa-app.env <<'EOF'
NODE_ENV=production
PORT=3007

SHOPIFY_API_KEY=REPLACE_WITH_CLIENT_ID
SHOPIFY_API_SECRET=REPLACE_WITH_CLIENT_SECRET

DATA_DIR=/var/lib/gaapps/pwa-app

PWA_VERIFY_PROXY=false
EOF

chown root:gaapps /etc/gaapps/pwa-app.env
chmod 640 /etc/gaapps/pwa-app.env
```

Fill in both Shopify values from **Partner dashboard → Apps → Storefront PWA →
Client credentials**. The annotated template, with the reasoning behind each
value, is at [`deploy/env/pwa-app.env.example`](../../deploy/env/pwa-app.env.example)
in the workspace.

| Variable | Required | Consequence of getting it wrong |
|---|---|---|
| `SHOPIFY_API_KEY` | yes | App Bridge never initialises; the embedded admin is a blank frame in Shopify admin |
| `SHOPIFY_API_SECRET` | yes | Session tokens cannot be verified — the admin loads but every save is rejected, and the uninstall webhook is ignored, so merchant logos are never deleted |
| `DATA_DIR` | yes | Defaults to `<app>/data`, which is inside the read-only `/opt` — settings vanish on the first redeploy |
| `PORT` | no | Defaults to 3007; must match the nginx `proxy_pass` |
| `PWA_VERIFY_PROXY` | no | See below |

**systemd env files are not shell scripts.** `KEY=value`, no `export`, no
quotes. A stray quote becomes part of the value and then fails exactly as though
the secret were wrong.

### Leave `PWA_VERIFY_PROXY=false` for the first deploy

It is off by default on purpose. Everything under `/apps/pwa/` is a public
static file the browser fetches with no session — a `<link rel="manifest">`
fetch is uncredentialed by spec — so there is nothing there to authenticate.
More to the point, a signature mismatch would not fail loudly: it would
un-install the PWA for every visitor at once, with nothing on the storefront to
explain why. Turn it on only after step 9 proves the signature passes against a
live storefront, and recheck `/apps/pwa/health` immediately afterwards.

---

## Step 5 — Install dependencies

```bash
cd /opt/gaapps/pwa-app
sudo -u gaapps npm install
```

Two dependencies: `express` and `sharp`. There is **no build step** — the admin
page is server-rendered and reads `SHOPIFY_API_KEY` at request time. Unlike the
other apps in this fleet, nothing needs the key present at install time, and
rotating the key later takes a restart rather than a rebuild.

**If `sharp` fails to install**, it is the prebuilt native binary download being
blocked:

```bash
apt install -y build-essential libvips-dev
cd /opt/gaapps/pwa-app && sudo -u gaapps npm install --build-from-source sharp
```

Now create the data directory and prove the service account can write to it.
`ProtectSystem=strict` in the unit makes `/opt` read-only, so a missing data
directory is not a warning at runtime — it is a crash on the first merchant
save:

```bash
install -d -o gaapps -g gaapps /var/lib/gaapps/pwa-app
sudo -u gaapps env DATA_DIR=/var/lib/gaapps/pwa-app \
  node -e "require('./web/settings.js'); console.log('data dir writable')"

ls -la /var/lib/gaapps/pwa-app    # expect shops/ and assets/, owned by gaapps
```

> **Lockfile:** this repo has no `package-lock.json`, so `npm install` resolves
> fresh on every deploy and the server can end up on different patch versions
> from your machine. Run `npm install` locally once, commit the generated
> lockfile, and switch the command above to `npm ci` for reproducible deploys.

---

## Step 6 — systemd service

The annotated unit lives at
[`deploy/systemd/pwa-app.service`](../../deploy/systemd/pwa-app.service) in the
workspace. Copy it if you have it; otherwise write it directly:

```bash
cat > /etc/systemd/system/pwa-app.service <<'EOF'
[Unit]
Description=Storefront PWA (Shopify embedded app)
Documentation=https://pwa.gaapps.cloud/healthz
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gaapps
Group=gaapps

# No /web suffix: server.js resolves everything from __dirname, and require()
# needs node_modules at the repo root. Do NOT run this from inside web/.
WorkingDirectory=/opt/gaapps/pwa-app
EnvironmentFile=/etc/gaapps/pwa-app.env
ExecStart=/usr/bin/node web/server.js

Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pwa-app

# ProtectSystem=strict makes /opt read-only, which is what we want: everything
# this app writes lives under DATA_DIR in /var/lib so it survives a redeploy.
# If a merchant's settings vanish after a deploy, check that DATA_DIR still
# points inside ReadWritePaths.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/gaapps/pwa-app
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pwa-app
systemctl --no-pager status pwa-app
```

Prove it is listening locally before involving nginx:

```bash
curl -s localhost:3007/healthz
```

Expect JSON with `"ok":true` and — this is the part worth actually reading —
`"apiKey":true`, `"apiSecret":true`, and the right `dataDir`. A `false` on
either key means step 4 did not take effect: `systemctl restart pwa-app`, since
systemd re-reads `EnvironmentFile` only on a restart, never on a reload.

```bash
journalctl -u pwa-app -n 50 --no-pager
```

Startup logs the same four facts in plain text. `EROFS` or `EACCES` here means a
write is landing outside `ReadWritePaths` — recheck `DATA_DIR` in step 4.

---

## Step 7 — nginx and TLS

The annotated vhost is at
[`deploy/nginx/pwa.gaapps.cloud.conf`](../../deploy/nginx/pwa.gaapps.cloud.conf).
HTTP only here on purpose — `certbot --nginx` adds the TLS block itself:

```bash
cat > /etc/nginx/sites-available/pwa.gaapps.cloud.conf <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name pwa.gaapps.cloud;

    access_log /var/log/nginx/pwa.gaapps.cloud.access.log;
    error_log  /var/log/nginx/pwa.gaapps.cloud.error.log;

    # The app sets its own frame-ancestors CSP naming the requesting shop, so
    # nginx must stay out of the framing decision entirely. See below.

    # Merchants upload a logo and up to two screenshots. The app caps the body
    # at 8 MB in express.raw; keep the two in step or nginx rejects the upload
    # first, with an HTML error page the admin cannot parse.
    client_max_body_size 9m;

    location / {
        proxy_pass http://127.0.0.1:3007;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Connection        "";

        # sharp renders icons and the nineteen iOS launch images on first
        # request. Each is CPU-bound and cached to disk afterwards, but a cold
        # store asked for a 2048x2732 splash can outlast a tight timeout.
        proxy_read_timeout 60s;

        # The app picks Cache-Control per route — a year for content-addressed
        # icons, no-cache for the service worker. Let them through untouched.
        proxy_pass_header Cache-Control;
    }
}
EOF

ln -sf /etc/nginx/sites-available/pwa.gaapps.cloud.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# `ln -sf` creates dangling links without complaining and nginx skips them
# silently, so verify rather than trusting the reload:
for l in /etc/nginx/sites-enabled/*; do [ -e "$l" ] || echo "BROKEN: $l"; done

nginx -t && systemctl reload nginx
```

The `.conf` suffix must appear on **both** sides of the symlink. Mismatch it and
the link dangles; nginx omits broken symlinks from a glob include without an
error, so `nginx -t` reports `syntax is ok` and the reload succeeds while no
vhost is loaded at all. The first symptom is usually certbot saying
`Could not automatically find a matching server block`.

Certificate:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx --agree-tos -m you@example.com --redirect -d pwa.gaapps.cloud

systemctl status certbot.timer     # renewal is automatic
```

HTTPS is not optional here. A web app manifest and a service worker are only
honoured in a secure context, and Shopify will not accept an `http://` app URL.

### Never add X-Frame-Options

The app renders inside the Shopify admin iframe and sends its own
`Content-Security-Policy: frame-ancestors` naming the requesting shop. An
`X-Frame-Options` header added at the nginx layer overrides that, and the app
becomes a blank panel in Shopify admin with a browser console error that never
mentions nginx. Do not add one, and check that no snippet you include adds one.

---

## Step 8 — Register the app with Shopify

The server is answering now, but Shopify still has to be told to send traffic to
it.

Confirm [`shopify.app.toml`](shopify.app.toml) matches the host you just set up:

```toml
application_url = "https://pwa.gaapps.cloud"

[auth]
redirect_urls = [ "https://pwa.gaapps.cloud/api/auth" ]

[app_proxy]
url = "https://pwa.gaapps.cloud/pwa/proxy"
subpath = "pwa"
prefix = "apps"
```

**The `/pwa/proxy` suffix on the proxy URL is not decorative.** Shopify forwards
only the path *after* the subpath, and the backend mounts its storefront router
at `/pwa/proxy`, so `/apps/pwa/manifest.json` on the storefront must resolve to
`https://pwa.gaapps.cloud/pwa/proxy/manifest.json`. Drop the suffix and every
storefront page links to a 404 manifest — which Chrome reports as a broken site
rather than simply an uninstallable one.

Push it from your workstation, in this directory:

```bash
npm install
shopify app config link      # only if client_id is not already correct
shopify app config push
shopify app deploy           # uploads the theme app embed extension
```

Or set the same four values by hand in the Partner dashboard under
**Configuration** and **App proxy**.

Then **install or reinstall the app once** from the Shopify admin — changing
redirect URLs invalidates existing grants.

---

## Step 9 — Verify

Against the server directly:

```bash
curl -s https://pwa.gaapps.cloud/healthz
```

`ok`, `apiKey: true`, `apiSecret: true`, correct `dataDir`.

```bash
# Hitting a proxy route directly has no shop, and the app says so in plain English
curl -s https://pwa.gaapps.cloud/pwa/proxy/manifest.json
```

Through Shopify's app proxy, from the storefront domain — this is the test that
actually matters, because it exercises the path Shopify rewrites:

```bash
curl -s  https://<your-store>/apps/pwa/health
curl -s  https://<your-store>/apps/pwa/manifest.json | head -40
curl -sI https://<your-store>/apps/pwa/icon-512.png     # 200, image/png
```

A 404 on these while `/healthz` works means the `[app_proxy] url` is missing its
`/pwa/proxy` suffix — back to step 8.

Then, in a browser:

1. **Theme editor → App embeds → enable "Storefront PWA".** Nothing appears on
   the storefront until this is on — it is what puts `<link rel="manifest">` in
   `<head>`.
2. **Apps → Storefront PWA** in the Shopify admin. It must render inside the
   iframe, not as a blank panel. Set the name and short name, upload a square
   logo of at least 512×512, save. A blank panel is almost always a missing
   `SHOPIFY_API_KEY` or an `X-Frame-Options` header.
3. **`https://<your-store>/apps/pwa/check`** — the built-in self-test. Run it on
   the storefront, not from the admin iframe: a service worker's real scope and
   whether `beforeinstallprompt` fires can only be observed from the origin in
   question. It reports secure context, whether the manifest loads and parses,
   whether `start_url` is same-origin, and whether every declared icon actually
   returns an image.
4. Install the store from the browser menu on desktop and Android, and via
   **Share → Add to Home Screen** on iOS.

Confirm state actually landed on disk:

```bash
ls -la /var/lib/gaapps/pwa-app/shops/
cat /var/lib/gaapps/pwa-app/shops/<shop>.myshopify.com.json
```

Watch the logs during the first real traffic:

```bash
journalctl -u pwa-app -f
```

> Offline browsing will not work, and that is expected rather than a deployment
> fault. Shopify strips the `Service-Worker-Allowed` header, so the worker's
> scope stays `/apps/pwa/` and it never sees a storefront navigation. Installing
> is unaffected. The full measurement is in
> [`README.md`](README.md#why-shopify-strips-service-worker-allowed).

---

## The install prompt

Once the app is deployed and the embed is on, this is the part merchants and
their customers actually see: a card that offers to install the store.

### What the admin controls

**Apps → Storefront PWA → Install prompt.**

| Setting | Default | Range |
|---|---|---|
| Show the install card | on | — |
| Delay before it appears | 8 seconds | 0–120 |
| Position | bottom-right | `bottom-right`, `bottom-left`, `bottom-bar` |
| Title | "Install our app" | ≤ 60 characters |
| Body | "Add the store to your home screen…" | ≤ 200 characters |
| Button label | "Install" | ≤ 24 characters |
| Dismiss period | 14 days | 0–365 |

The delay is not decoration — a card that appears on first paint is a card
customers dismiss reflexively. The dismissal is remembered in the visitor's
`localStorage` under `shopify-pwa:dismissed-until`, so setting the period to 0
means the card returns on the next page view, which is worth doing only while
testing.

Conditions are re-checked when the timer fires, not just when it is set: a
visitor who installs from the browser's own menu during those eight seconds
never sees the card.

The card closes three ways, and they do not all mean the same thing:

| Control | Effect |
|---|---|
| **×** in the corner | Hides the card. No dismissal period — it can return on the next page view |
| **Not now** | Starts the dismissal period |
| **Got it** (instructions card) | Starts the dismissal period |

The two labelled buttons mean "stop asking"; the × means "not on this screen".
A visitor reaching for a corner × is usually closing the thing in front of them,
not opting out for a fortnight — but the trade is that someone who closes it on
every page is offered it on every page.

### Two switches, and they do different things

The **app embed** in the theme editor decides whether the manifest link and the
runtime are in the page at all. It is a theme change.

The **Status** switch in the app admin is the one to reach for when something
looks wrong on a live store: it leaves the embed alone and makes the manifest
non-installable instead. A merchant can flip it in two seconds without opening
the theme editor.

### Putting an Install button in the theme

Any element with `data-pwa-install` triggers the install flow:

```liquid
<button type="button" data-pwa-install>Install our app</button>
```

Handled by event delegation, so it works for markup rendered after the script
runs — a drawer, a modal, anything a section loads later.

The runtime also puts `pwa-standalone` on `<html>` when the store is already
running as an installed app, which is the hook for hiding that button from
customers who no longer need it:

```css
.pwa-standalone .site-header__install { display: none; }
```

### Why the button usually does not open the native dialog

Chrome fires `beforeinstallprompt` — the event a custom Install button needs —
only when a service worker with a `fetch` handler controls the page. As covered
in [the README](README.md#why-shopify-strips-service-worker-allowed), Shopify
strips the header that would let this app's worker control the storefront, so
that event generally never arrives. Safari has never exposed a programmatic
install API on any platform.

So the app detects what the browser will actually allow and shows that browser's
own directions instead — which is why installing still works everywhere in the
capability table, just not through a single click.

The popup looks the same either way: icon, title, text, **Install**. What
changes is what the button *does* — it opens the native dialog where one is
available, and replaces the card with that browser's own directions where there
isn't. A visitor has no use for that distinction before they have clicked
anything, so the card does not expose it.

There is a deliberate asymmetry in when it speaks up. The **timed card stays
silent** on a browser that cannot install, because an unprompted card offering
something impossible is worse than no card. A **click always gets an answer**,
even on a browser with no install path at all, because someone who clicked
deserves to be told why nothing happened.

### `window.ShopifyPWA`

The runtime exposes its state for theme code and for
`/apps/pwa/check` to report on:

| Member | What it is |
|---|---|
| `install()` | Opens the native dialog where available, otherwise the instructions card |
| `dismiss()` | Hides the card and starts the dismissal period |
| `platform` | `ios-safari`, `ios-other`, `android-samsung`, `android`, desktop, or `unknown` |
| `standalone` | Whether the store is running as an installed app right now |
| `canPrompt` | Whether a native prompt is actually available |
| `serviceWorker.scope` | The worker's **real** scope, once registered |
| `instructions()` | The steps this browser needs, as data |
| `config`, `version` | The settings baked into this copy of `pwa.js` |

`canPrompt` is the honest one to branch on. A saved `beforeinstallprompt` event
is single-use — once `prompt()` has been called it cannot be replayed, so
`canPrompt` goes back to `false` after a visitor dismisses the dialog without
installing.

---

## Step 10 — Redeploying after a code change

```bash
cd /opt/gaapps/pwa-app
sudo -u gaapps git pull
sudo -u gaapps npm install     # or npm ci, once a lockfile is committed
systemctl restart pwa-app

curl -s localhost:3007/healthz
journalctl -u pwa-app -n 30 --no-pager
```

No build step, so that is the whole procedure. Downtime is the restart, about a
second, and `Restart=always` covers a crash on the way up.

- **After editing `/etc/gaapps/pwa-app.env`:** `systemctl restart`, not
  `reload` — systemd re-reads `EnvironmentFile` only on a restart.
- **After changing the theme extension** in `extensions/`: `shopify app deploy`
  from your workstation. The server does not serve that code; Shopify does.
- **After changing `shopify.app.toml`:** `shopify app config push`, then
  `git pull` on the server so the checkout matches what Shopify has registered.

### Backups

The code is in git. The thing that is not recoverable is the data directory —
merchant settings and their uploaded logos:

```bash
tar czf /root/pwa-app-$(date +%F).tar.gz -C /var/lib/gaapps pwa-app
```

Worth a nightly cron and an off-box copy. Hostinger's snapshot feature covers
the whole disk and is a reasonable second layer, but a snapshot restore is an
all-or-nothing rollback of the entire VPS — it is not a way to recover one
merchant's logo.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Blank panel in Shopify admin | `SHOPIFY_API_KEY` unset, or an `X-Frame-Options` header added at the nginx layer | Check `/healthz` shows `apiKey: true`; remove the header (step 7) |
| Admin loads, every save fails | `SHOPIFY_API_SECRET` unset — session tokens cannot be verified | Set it, `systemctl restart pwa-app` |
| `/apps/pwa/*` 404s but `/healthz` works | `[app_proxy] url` missing its `/pwa/proxy` suffix | Step 8 |
| Nothing at all on the storefront | The theme app embed is not enabled | Theme editor → App embeds |
| Manifest loads, store still not installable | `start_url` not same-origin, or a declared icon 404s | Run `/apps/pwa/check` — it names the failing check |
| Settings vanished after a deploy | `DATA_DIR` pointed inside `/opt` | Step 4, then restore from backup |
| `EROFS` / `EACCES` in the journal | A write landing outside `ReadWritePaths` | Confirm `DATA_DIR=/var/lib/gaapps/pwa-app` and that the unit lists it |
| Logo upload fails with an HTML parse error in the admin | nginx `client_max_body_size` below the app's 8 MB cap | Keep it at `9m` (step 7) |
| Splash images time out on a cold store | `sharp` rendering 2048×2732 exceeded the proxy timeout | `proxy_read_timeout 60s`; on 1 GB plans confirm swap exists (step 1) |
| `npm install` refuses outright | Node older than 20, and `.npmrc` sets `engine-strict=true` | Install Node 22 (step 1) |
| certbot: "could not find a matching server block" | Dangling `sites-enabled` symlink, or DNS not yet resolving | Run the symlink check in step 7; `dig +short pwa.gaapps.cloud` |
| PWA silently un-installs for every visitor | `PWA_VERIFY_PROXY=true` and the signature is failing | Set it back to `false`, restart, recheck `/apps/pwa/health` |

Useful one-liners:

```bash
systemctl status pwa-app
journalctl -u pwa-app -f
journalctl -u pwa-app --since "10 min ago" --no-pager
curl -s localhost:3007/healthz
nginx -t && systemctl reload nginx
tail -f /var/log/nginx/pwa.gaapps.cloud.error.log
```

---

## Adding this app to an existing fleet VPS

If the box already runs the other `gaapps.cloud` apps, most of the above is
done. What remains:

1. **Port 3007** is already reserved for this app in the fleet table — confirm
   nothing else took it (`ss -ltnp | grep 3007`). Two services on one port fail
   confusingly: the loser exits and systemd restarts it in a loop.
2. `mkdir /var/lib/gaapps/pwa-app` + `chown gaapps:gaapps` (step 1).
3. Clone into `/opt/gaapps/pwa-app` (step 3), write
   `/etc/gaapps/pwa-app.env` (step 4), `npm install` (step 5).
4. Unit and vhost from `deploy/` (steps 6–7).
5. `certbot --nginx -d pwa.gaapps.cloud --expand` to add the name to the
   existing certificate rather than issuing a second one.
