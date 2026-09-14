'use strict';
/**
 * Who a request is really from, and which addresses the IP limit ignores.
 *
 * Both questions come down to the same thing: an address in a header is a
 * claim, not a fact. `x-forwarded-for` was read unconditionally, which meant
 * anybody could put whatever they liked in it and have the panel write that
 * into its own audit log as where they signed in from. A header is only worth
 * believing when the machine that sent it is one you put there yourself, so
 * the panel is told which those are and believes nobody else.
 */
const db = require('./db');

/** Parse "a.b.c.d/nn, ::1/128" into something testable. */
function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [addr, bitsRaw] = entry.split('/');
      const ip = normalize(addr);
      if (!ip) return null;
      const full = ip.includes(':') ? 128 : 32;
      const bits = bitsRaw === undefined ? full : Number(bitsRaw);
      if (!Number.isFinite(bits) || bits < 0 || bits > full) return null;
      return { ip, bits, v6: ip.includes(':') };
    })
    .filter(Boolean);
}

/**
 * One address, in a form two of them can be compared in.
 *
 * ::ffff:1.2.3.4 is how a v4 address arrives on a dual-stack socket, and it
 * has to become 1.2.3.4 or a v4 rule will never match the very connections it
 * was written for.
 */
function normalize(raw) {
  let ip = String(raw || '').trim().toLowerCase();
  if (!ip) return '';
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return mapped[1];
  return ip;
}

/** An address as bytes, so a prefix can be compared a bit at a time. */
function bytesOf(ip) {
  if (!ip.includes(':')) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return Uint8Array.from(parts);
  }
  // expand the :: shorthand before reading the groups
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined && left.length !== 8) return null;
  const middle = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...middle, ...right];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i] || '0', 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

/** Is this address inside that range? */
function inRange(ip, rule) {
  const a = bytesOf(normalize(ip));
  const b = bytesOf(rule.ip);
  if (!a || !b || a.length !== b.length) return false;
  let bits = rule.bits;
  for (let i = 0; i < a.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

function matchesAny(ip, rules) {
  return rules.some((rule) => inRange(ip, rule));
}

/** The proxies whose forwarded headers are worth believing. */
function trusted() {
  const raw = db.settings.trustedProxies;
  // loopback by default: a panel behind nginx on the same box is the usual case
  return parseList(raw === undefined || raw === null || raw === '' ? '127.0.0.1/32, ::1/128' : raw);
}

/**
 * Where a request actually came from.
 *
 * The socket address is the truth. A forwarded header replaces it only when
 * the socket itself belongs to a proxy the admin has vouched for, and then it
 * is read right to left - the rightmost entry a trusted hop added is the last
 * one that could not have been forged by the client.
 */
function clientIp(req) {
  const socket = normalize((req.socket && req.socket.remoteAddress) || '');
  const rules = trusted();
  if (!rules.length || !matchesAny(socket, rules)) return socket;

  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => normalize(s)).filter(Boolean);
  if (!chain.length) return socket;

  // walk back through hops we trust; the first one we do not is the client
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!matchesAny(chain[i], rules)) return chain[i];
  }
  return chain[0];
}

/**
 * Addresses the concurrent-IP limit never counts and never cuts off.
 *
 * A shared office or campus address is one address to the server and thirty
 * people to the person paying for it; without this, one client on a limit of
 * two is unusable from anywhere with NAT in front of it.
 */
function ipLimitExempt(ip) {
  const rules = parseList(db.settings.ipLimitAllowlist);
  if (!rules.length) return false;
  return matchesAny(ip, rules);
}

module.exports = { clientIp, ipLimitExempt, parseList, inRange, normalize, matchesAny };
