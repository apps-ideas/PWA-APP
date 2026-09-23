/**
 * Minimal .env loader. Zero dependencies on purpose, and the same loader the
 * other Node apps in this fleet use (see apps/customer-restrictions/web).
 *
 * Real environment variables always win, so this is a no-op in production —
 * systemd injects the vars from /etc/gaapps/storefront-pwa-live.env and no .env is deployed.
 * It only covers running `node web/server.js` locally, where nothing else would
 * read the .env sitting at the app root.
 */
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

for (const envPath of [join(__dirname, '.env'), join(__dirname, '..', '.env')]) {
  if (!existsSync(envPath)) continue;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;

    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    // Quotes are stripped after trimming, so a quoted value keeps any
    // significant leading or trailing whitespace inside the quotes.
    const trimmed = rawValue.trim();
    process.env[key] = /^(".*"|'.*')$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  }

  break;
}
