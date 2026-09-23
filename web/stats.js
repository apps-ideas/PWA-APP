/**
 * Install counters, one JSON file per shop under DATA_DIR/stats/.
 *
 * The storage is shaped like settings.js — a JSON file per shop, written to a
 * temp file and renamed over the target — but the write pattern is the
 * opposite. Settings change when a merchant clicks Save; counters change on
 * storefront traffic. So the counts are held in memory and flushed on a timer
 * rather than written once per event: a crash or a redeploy loses at most
 * FLUSH_MS of counts, which is a better trade than a disk write per visitor.
 *
 * Single process by design — the app listens on one port on 127.0.0.1 and is
 * not clustered. Two processes sharing a DATA_DIR would each hold their own
 * copy of a shop's counts and the last flush would win.
 *
 * Nothing here identifies a person: four counters per UTC day per shop, and no
 * IP, user agent, customer or session is recorded or derivable from the file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const settingsStore = require('./settings.js');

const STATS_DIR = path.join(settingsStore.DATA_DIR, 'stats');

fs.mkdirSync(STATS_DIR, { recursive: true });

/**
 * The five things worth counting, and what each one means.
 *
 *   shown      the install card appeared, once per visit
 *   clicked    the visitor asked to install, once per visit
 *   dismissed  the visitor said no — "Not now", or the native dialog refused
 *   installed  the app reached a home screen or desktop, once per browser
 *   launch     the installed app was opened, once per browser per day
 *
 * `installed` is the headline number and the only one that is not a rate.
 * `dismissed` is its opposite number and is what makes the admin's two rows of
 * tiles a comparison rather than a single figure with no denominator.
 */
const EVENTS = ['shown', 'clicked', 'dismissed', 'installed', 'launch'];

/**
 * The device families the counters are split by.
 *
 * Coarse on purpose. A merchant deciding whether their iOS install copy is
 * working needs three buckets, not a browser matrix — and the narrower the
 * buckets, the closer this gets to being a fingerprint of a visitor rather than
 * a count of an event. `other` catches anything the storefront script could not
 * place, including a missing or nonsense value on a public endpoint.
 */
const PLATFORMS = ['ios', 'android', 'desktop', 'other'];

/** Six months of daily buckets. Long enough to show a season, short enough
 *  that a busy shop's file stays a few kilobytes. */
const RETAIN_DAYS = 180;

/** How long counts may sit in memory before they reach disk. */
const FLUSH_MS = 5000;

/**
 * How many shops may have counters created in one process.
 *
 * The event endpoint is public and takes the shop from the proxy's query
 * string, so the set of names that can reach record() is "anything shaped like
 * a myshopify domain" — not a bounded set, and every new name would otherwise
 * become a file on disk. This app serves a handful of storefronts; a thousand
 * is far past that and still bounds the damage to a few hundred kilobytes.
 *
 * A shop that already has a file on disk is always admitted, so a real merchant
 * is never locked out of their own counters by a flood of invented names.
 */
const MAX_SHOPS = 1000;

/** shop -> { data, dirty }. Loaded lazily, kept for the life of the process. */
const cache = new Map();

function statsFile(shop) {
  // isValidShop has already rejected anything with a slash or a dot segment;
  // basename is the same second line of defence settings.js keeps.
  return path.join(STATS_DIR, path.basename(shop.toLowerCase()) + '.json');
}

/**
 * UTC, deliberately. A merchant reading "yesterday" wants the same bucket
 * boundary the server used, and the server has no idea what timezone the shop
 * trades in. The admin says which it is rather than leaving it to be guessed.
 */
function dayKey(at) {
  return (at || new Date()).toISOString().slice(0, 10);
}

function emptyCounts() {
  const counts = {};
  for (const event of EVENTS) counts[event] = 0;
  return counts;
}

function emptyPlatforms() {
  const out = {};
  for (const platform of PLATFORMS) out[platform] = emptyCounts();
  return out;
}

function emptyDay() {
  return { ...emptyCounts(), platforms: emptyPlatforms() };
}

/** Normalise whatever arrived on the public endpoint to one of PLATFORMS. */
function platformKey(value) {
  const key = String(value || '').toLowerCase();
  return PLATFORMS.includes(key) ? key : 'other';
}

function blank(shop) {
  return {
    version: 2,
    shop: shop || null,
    totals: emptyCounts(),
    platformTotals: emptyPlatforms(),
    days: {},
    firstEventAt: null,
    lastEventAt: null,
  };
}

/**
 * Merge a stored file over a blank record, so a file written by an older
 * version of this app can never hand an undefined counter to the admin.
 *
 * A version 1 file has no platform breakdown at all, and there is no way to
 * invent one after the fact — those days stay split entirely into `other`,
 * which is honest about what was recorded rather than guessing.
 */
function hydrate(shop, stored) {
  const base = blank(shop);
  const days = {};

  for (const [day, counts] of Object.entries((stored && stored.days) || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    const platforms = emptyPlatforms();
    for (const platform of PLATFORMS) {
      const saved = (counts && counts.platforms && counts.platforms[platform]) || {};
      platforms[platform] = { ...emptyCounts(), ...saved };
    }

    days[day] = { ...emptyCounts(), ...counts, platforms };
  }

  const platformTotals = emptyPlatforms();
  for (const platform of PLATFORMS) {
    const saved = (stored && stored.platformTotals && stored.platformTotals[platform]) || {};
    platformTotals[platform] = { ...emptyCounts(), ...saved };
  }

  return {
    ...base,
    ...stored,
    version: 2,
    shop,
    totals: { ...base.totals, ...((stored && stored.totals) || {}) },
    platformTotals,
    days,
  };
}

function load(shop) {
  const hit = cache.get(shop);
  if (hit) return hit;

  let data;
  try {
    data = hydrate(shop, JSON.parse(fs.readFileSync(statsFile(shop), 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('stats read failed for ' + shop + ':', err.message);
    data = blank(shop);
  }

  const entry = { data, dirty: false };
  cache.set(shop, entry);
  return entry;
}

/** Drop buckets past the retention window. Only ever runs on the path that is
 *  about to write the file anyway. */
function prune(data) {
  const days = Object.keys(data.days);
  if (days.length <= RETAIN_DAYS) return;
  for (const day of days.sort().slice(0, days.length - RETAIN_DAYS)) delete data.days[day];
}

/**
 * Count one event.
 *
 * An unknown event name is dropped rather than stored. This is reached from a
 * public storefront endpoint, and an open-ended key space inside a file we keep
 * for six months is not something to hand to the internet.
 */
function record(shop, event, platform) {
  if (!settingsStore.isValidShop(shop) || !EVENTS.includes(event)) return false;

  // Only consulted once the cache is full, and only for a shop not already in
  // it — so the extra stat() costs nothing on the path this normally takes.
  if (!cache.has(shop) && cache.size >= MAX_SHOPS && !fs.existsSync(statsFile(shop))) {
    return false;
  }

  const entry = load(shop);
  const now = new Date();
  const day = dayKey(now);
  const device = platformKey(platform);

  if (!entry.data.days[day]) entry.data.days[day] = emptyDay();
  entry.data.days[day][event] += 1;
  entry.data.days[day].platforms[device][event] += 1;
  entry.data.totals[event] += 1;
  entry.data.platformTotals[device][event] += 1;
  entry.data.lastEventAt = now.toISOString();
  if (!entry.data.firstEventAt) entry.data.firstEventAt = entry.data.lastEventAt;
  entry.dirty = true;

  return true;
}

function writeFile(shop, data) {
  const target = statsFile(shop);
  const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

/** Write every shop whose counts have moved. Safe to call at any time. */
function flush() {
  for (const [shop, entry] of cache) {
    if (!entry.dirty) continue;
    try {
      prune(entry.data);
      writeFile(shop, entry.data);
      entry.dirty = false;
    } catch (err) {
      // Left dirty on purpose: a disk that fills and then clears should not
      // have cost the counts recorded while it was full.
      console.error('stats flush failed for ' + shop + ':', err.message);
    }
  }
}

/**
 * The admin's view: all-time totals plus a dense daily series.
 *
 * The series carries a row for every day in the window, including the empty
 * ones — a chart drawn only from the days that had traffic is a chart that
 * lies about the gaps.
 */
function summary(shop, windowDays) {
  const days = Math.min(Math.max(parseInt(windowDays, 10) || 30, 1), RETAIN_DAYS);
  const data = settingsStore.isValidShop(shop) ? load(shop).data : blank(shop);

  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const series = [];
  const recent = emptyCounts();
  const platformRecent = emptyPlatforms();

  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(new Date(midnight - i * 86400000));
    const bucket = data.days[day] || emptyDay();

    for (const event of EVENTS) {
      recent[event] += bucket[event];
      for (const platform of PLATFORMS) {
        platformRecent[platform][event] += bucket.platforms[platform][event];
      }
    }

    // The per-platform detail is dropped from the series: the chart plots one
    // bar per day, and shipping four times the rows for a breakdown nothing
    // reads would quadruple the payload of the busiest response this app has.
    const { platforms, ...counts } = bucket;
    series.push({ date: day, ...counts });
  }

  return {
    shop,
    windowDays: days,
    retainDays: RETAIN_DAYS,
    events: EVENTS,
    platforms: PLATFORMS,
    totals: data.totals,
    platformTotals: data.platformTotals,
    recent,
    platformRecent,
    series,
    firstEventAt: data.firstEventAt,
    lastEventAt: data.lastEventAt,
  };
}

/** Called on app/uninstalled, alongside the settings and asset deletes. The
 *  cache entry goes first: a surviving entry would be flushed straight back
 *  onto disk on the next timer tick. */
function remove(shop) {
  if (!settingsStore.isValidShop(shop)) return;
  cache.delete(shop);
  try {
    fs.rmSync(statsFile(shop), { force: true });
  } catch (err) {
    console.error('stats delete failed for ' + shop + ':', err.message);
  }
}

/**
 * Start flushing. Unref'd so it never keeps the process alive on its own, and
 * paired with handlers that write one last time on the way out — a graceful
 * restart should not cost the last few seconds of counts.
 */
function start() {
  const timer = setInterval(flush, FLUSH_MS);
  if (timer.unref) timer.unref();

  process.on('exit', flush);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      flush();
      process.exit(0);
    });
  }

  return timer;
}

module.exports = {
  EVENTS,
  FLUSH_MS,
  PLATFORMS,
  RETAIN_DAYS,
  STATS_DIR,
  flush,
  record,
  remove,
  start,
  summary,
};
