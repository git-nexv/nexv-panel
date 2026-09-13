'use strict';
/**
 * Who is connected right now, and from where.
 *
 * Xray writes one line per accepted connection to its access log:
 *
 *   2026/01/01 00:00:00 from tcp:1.2.3.4:53122 accepted tcp:example.com:443 \
 *     [inbound >> direct] email: alice#1a2b3c4d
 *
 * That line is the only place the source address appears, so the log is the
 * only way to answer "which IPs is this client using" - the stats API counts
 * bytes and nothing else. The file is read forward from wherever the last read
 * stopped, so a long-running server is not re-parsed every few seconds.
 */
const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.NEXV_XRAY_ACCESS_LOG || '/var/log/xray/access.log';
const DATA_DIR = process.env.NEXV_DATA_DIR || '/etc/nexv/data';
const SITE_FILE = path.join(DATA_DIR, 'sites.json');

const EVERY = 10000;          // how often the tail is read
const IP_TTL = 5 * 60 * 1000; // an address is "current" for this long
const ONLINE_TTL = 60 * 1000; // and a client counts as online for this long

/*
 * Where a client's traffic went is worth keeping for longer than five minutes -
 * it is the answer to "what is this account being used for" - so destinations
 * live for a week and survive a restart in a file of their own. They are not
 * in db.json: that is written on every traffic poll and this is far too chatty
 * to ride along with it.
 */
const SITE_TTL = 7 * 24 * 60 * 60 * 1000;
const SITES_PER_TAG = 250;    // most-recent wins once a client is past this
const SAVE_EVERY = 60 * 1000;

/* tag -> { lastSeen, ips: Map(ip -> lastSeen), sites: Map(host -> {hits, at}) } */
const seen = new Map();
const state = { offset: 0, size: 0, reads: 0, lines: 0, error: '', dirty: false };

/*
 * Xray's own format:
 *   from tcp:1.2.3.4:53122 accepted tcp:example.com:443 [inbound >> direct] email: alice#1a2b3c4d
 * Source address, destination, and the client it belongs to. The destination
 * is a hostname only when the inbound has sniffing on; without it Xray knows
 * nothing but the address it dialled, and that is what gets recorded.
 */
const LINE = /from\s+(?:\w+:)?(\[[0-9a-fA-F:]+\]|[0-9a-fA-F.:]+):\d+\s+accepted\s+(?:(\w+):)?([^\s]+?)(?::(\d+))?\s+\[.*?email:\s*(.+?)\s*$/;

function entryFor(tag) {
  let entry = seen.get(tag);
  if (!entry) {
    entry = { lastSeen: 0, ips: new Map(), sites: new Map() };
    seen.set(tag, entry);
  }
  if (!entry.sites) entry.sites = new Map();   // loaded from an older file
  return entry;
}

function note(tag, ip, host, at) {
  const entry = entryFor(tag);
  entry.lastSeen = at;
  entry.ips.set(ip, at);

  if (!host) return;
  const site = entry.sites.get(host);
  if (site) {
    site.hits++;
    site.at = at;
  } else {
    entry.sites.set(host, { hits: 1, at });
    /* a client that touches thousands of hosts must not grow without end;
       the oldest entry is the least interesting one to keep */
    if (entry.sites.size > SITES_PER_TAG) {
      let oldest = null;
      for (const [name, value] of entry.sites) {
        if (!oldest || value.at < oldest[1]) oldest = [name, value.at];
      }
      if (oldest) entry.sites.delete(oldest[0]);
    }
  }
  state.dirty = true;
}

function prune(now) {
  for (const [tag, entry] of seen) {
    for (const [ip, at] of entry.ips) {
      if (now - at > IP_TTL) entry.ips.delete(ip);
    }
    for (const [host, site] of entry.sites) {
      if (now - site.at > SITE_TTL) entry.sites.delete(host);
    }
    if (!entry.ips.size && !entry.sites.size && now - entry.lastSeen > IP_TTL) seen.delete(tag);
  }
}

/* ------------------------- keeping it across restarts -------------------- */

function load() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')); } catch (_) { return; }
  const now = Date.now();
  for (const [tag, sites] of Object.entries(raw.tags || {})) {
    const entry = entryFor(tag);
    for (const [host, value] of Object.entries(sites)) {
      if (now - value.at > SITE_TTL) continue;
      entry.sites.set(host, { hits: Number(value.hits) || 0, at: Number(value.at) || 0 });
    }
  }
}

function save() {
  if (!state.dirty) return;
  const tags = {};
  for (const [tag, entry] of seen) {
    if (!entry.sites || !entry.sites.size) continue;
    tags[tag] = Object.fromEntries(entry.sites);
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${SITE_FILE}.tmp`, JSON.stringify({ savedAt: Date.now(), tags }), { mode: 0o600 });
    fs.renameSync(`${SITE_FILE}.tmp`, SITE_FILE);
    state.dirty = false;
  } catch (err) {
    state.error = `cannot save the site history: ${err.message}`;
  }
}

/** Read whatever has been appended since the last pass. */
function read() {
  let stat;
  try { stat = fs.statSync(LOG_FILE); } catch (_) {
    state.error = 'no access log yet';
    return;
  }
  state.error = '';

  // rotated or truncated under us, so start again from the top
  if (stat.size < state.offset) state.offset = 0;
  state.size = stat.size;
  if (stat.size === state.offset) return;

  // never read more than the last stretch: a log nobody has rotated can be huge
  const from = Math.max(state.offset, stat.size - 4 * 1024 * 1024);
  let text = '';
  try {
    const fd = fs.openSync(LOG_FILE, 'r');
    const length = stat.size - from;
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(fd, buffer, 0, length, from);
    fs.closeSync(fd);
    text = buffer.toString('utf8');
  } catch (err) {
    state.error = err.message;
    return;
  }
  state.offset = stat.size;
  state.reads++;

  const now = Date.now();
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    state.lines++;
    // m: 1 source address, 2 network, 3 destination, 4 port, 5 client tag
    note(m[5], m[1].replace(/^\[|\]$/g, ''), (m[3] || '').toLowerCase(), now);
  }
  prune(now);
}

/** What the panel shows: is this tag live, and which addresses is it using. */
function forTag(tag) {
  const entry = seen.get(tag);
  if (!entry) return { online: false, ips: [] };
  const now = Date.now();
  return {
    online: now - entry.lastSeen < ONLINE_TTL,
    lastSeen: entry.lastSeen,
    ips: [...entry.ips.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ip, at]) => ({ ip, at }))
  };
}

/** Forget the addresses recorded for one client, so the list starts over. */
function forget(tag) {
  const entry = seen.get(tag);
  if (!entry) return 0;
  const count = entry.ips.size;
  entry.ips.clear();
  return count;
}

/**
 * Where this client's connections went.
 *
 * Counts of connections, not bytes: Xray's log records that a connection to a
 * host was accepted and never how much went through it, and no amount of
 * counting connections turns into gigabytes - one video stream is a single
 * connection carrying two gigabytes, and a page of adverts is two hundred
 * connections carrying nothing. So this answers "what is this account used
 * for", which is the question worth asking of it.
 */
function sitesFor(tag) {
  const entry = seen.get(tag);
  if (!entry || !entry.sites || !entry.sites.size) return { sites: [], hits: 0, since: 0 };

  let hits = 0;
  let since = Infinity;
  const sites = [];
  for (const [host, site] of entry.sites) {
    hits += site.hits;
    since = Math.min(since, site.at);
    sites.push({ host, hits: site.hits, at: site.at });
  }
  sites.sort((a, b) => b.hits - a.hits || b.at - a.at);
  return { sites, hits, since: since === Infinity ? 0 : since };
}

/** Start one client's site history over. */
function forgetSites(tag) {
  const entry = seen.get(tag);
  if (!entry || !entry.sites) return 0;
  const count = entry.sites.size;
  entry.sites.clear();
  state.dirty = true;
  save();
  return count;
}

function status() {
  return {
    file: LOG_FILE,
    exists: fs.existsSync(LOG_FILE),
    directory: fs.existsSync(path.dirname(LOG_FILE)),
    tracked: seen.size,
    parsed: state.lines,
    bytes: state.size,
    error: state.error
  };
}

function start() {
  load();
  read();
  const timer = setInterval(read, EVERY);
  timer.unref?.();
  const writer = setInterval(save, SAVE_EVERY);
  writer.unref?.();
  // a clean shutdown should not throw away the last minute of history
  process.once('SIGTERM', save);
  process.once('SIGINT', save);
  return timer;
}

module.exports = {
  start, read, save, load, forTag, forget, sitesFor, forgetSites, status, LOG_FILE, SITE_FILE
};
