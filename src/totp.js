'use strict';
/**
 * Time-based one-time codes, RFC 6238, with nothing pulled in to do it.
 *
 * This is the machinery an authenticator app runs: a shared secret, the clock
 * cut into windows, and an HMAC of the window number truncated to a few
 * digits. Both sides compute it from the same two things, so nothing is ever
 * sent anywhere - which is the whole appeal, and why the code on the phone
 * matches the one here without the phone and the server ever talking.
 *
 * What this is NOT used for here is worth stating, because it is the thing
 * everybody assumes. A code cannot be a Linux password. /etc/shadow holds one
 * fixed value until something changes it, while a code is only alive for its
 * window, so a password set to the current code stops matching the moment the
 * window turns. The usual answer - verify the code live, in PAM, when the
 * login happens - is not something this file does either; it edits nothing
 * outside the panel.
 *
 * What it does do is let the stored password BE the code for a long window,
 * with the rotation lined up on the window edge. Then the app and the server
 * agree for the whole window, and the admin reads their password off their
 * phone without opening the panel. That is the part of the idea that works.
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new shared secret, as the base32 an authenticator app expects. */
function secret(bytes) {
  return encode(crypto.randomBytes(Math.max(10, Number(bytes) || 20)));
}

/** Raw bytes to base32, no padding - which is what every app wants. */
function encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 back to bytes, forgiving about spaces, case and padding. */
function decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Which window a moment falls in, counted from the Unix epoch like the RFC. */
function windowOf(atMs, periodSeconds) {
  const period = Math.max(1, Number(periodSeconds) || 30);
  return Math.floor(Number(atMs || Date.now()) / 1000 / period);
}

/** When the window holding this moment ends, in milliseconds. */
function windowEnd(atMs, periodSeconds) {
  const period = Math.max(1, Number(periodSeconds) || 30);
  return (windowOf(atMs, period) + 1) * period * 1000;
}

/**
 * The code for a window.
 *
 * The counter goes in as eight bytes big-endian; the last nibble of the HMAC
 * picks where to read four bytes from, the top bit is cleared so the number
 * is never negative, and what is left is taken modulo ten to the digits. That
 * dynamic offset is the part people leave out, and leaving it out gives codes
 * that look right and never match anything.
 */
function code(key, options) {
  const opts = options || {};
  const digits = Math.min(10, Math.max(6, Number(opts.digits) || 6));
  const period = Math.max(1, Number(opts.period) || 30);
  const counter = opts.counter !== undefined
    ? Number(opts.counter)
    : windowOf(opts.at || Date.now(), period);

  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const mac = crypto.createHmac(opts.algorithm || 'sha1', decode(key)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const slice = ((mac[offset] & 0x7f) << 24)
    | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8)
    | (mac[offset + 3] & 0xff);
  return String(slice % 10 ** digits).padStart(digits, '0');
}

/**
 * The otpauth:// line an app reads out of a QR.
 *
 * `period` and `digits` are in there because the RFC says so, but an app is
 * free to ignore them and Google Authenticator does: it shows a six-digit
 * code every thirty seconds whatever the URI asks for. So a QR made with a
 * long window is read correctly by Aegis, 2FAS and FreeOTP, and misread by
 * Google's own app - which the panel says out loud rather than leaving to be
 * discovered at a login prompt.
 */
function uri(key, options) {
  const opts = options || {};
  const label = encodeURIComponent(opts.label || 'server');
  const issuer = encodeURIComponent(opts.issuer || 'NexV');
  const params = new URLSearchParams({
    secret: String(key || '').replace(/\s+/g, ''),
    issuer: opts.issuer || 'NexV',
    algorithm: (opts.algorithm || 'sha1').toUpperCase(),
    digits: String(Math.min(10, Math.max(6, Number(opts.digits) || 6))),
    period: String(Math.max(1, Number(opts.period) || 30))
  });
  return `otpauth://totp/${issuer}:${label}?${params.toString()}`;
}

module.exports = { secret, encode, decode, code, uri, windowOf, windowEnd };
