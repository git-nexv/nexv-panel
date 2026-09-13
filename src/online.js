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
const EVERY = 10000;          // how often the tail is read
const IP_TTL = 5 * 60 * 1000; // an address is "current" for this long
const ONLINE_TTL = 60 * 1000; // and a client counts as online for this long

/* tag -> { lastSeen, ips: Map(ip -> lastSeen) } */
const seen = new Map();
const state = { offset: 0, size: 0, reads: 0, lines: 0, error: '' };

/* Xray's own format, and the same line for an IPv6 source in brackets. */
const LINE = /from\s+(?:\w+:)?(\[[0-9a-fA-F:]+\]|[0-9a-fA-F.:]+):\d+\s+accepted\b.*?email:\s*(.+?)\s*$/;

function note(tag, ip, at) {
  let entry = seen.get(tag);
  if (!entry) {
    entry = { lastSeen: 0, ips: new Map() };
    seen.set(tag, entry);
  }
  entry.lastSeen = at;
  entry.ips.set(ip, at);
}

function prune(now) {
  for (const [tag, entry] of seen) {
    for (const [ip, at] of entry.ips) {
      if (now - at > IP_TTL) entry.ips.delete(ip);
    }
    if (!entry.ips.size && now - entry.lastSeen > IP_TTL) seen.delete(tag);
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
    note(m[2], m[1].replace(/^\[|\]$/g, ''), now);
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
  read();
  const timer = setInterval(read, EVERY);
  timer.unref?.();
  return timer;
}

module.exports = { start, read, forTag, forget, status, LOG_FILE };
