'use strict';
/**
 * Taking money through whatever gateway the admin imported.
 *
 * Everything provider-specific lives in the profile `payapi.js` built out of
 * the gateway's own OpenAPI file - the addresses, the header the key goes in,
 * and what each field is called. Nothing here knows the name of any gateway,
 * which is the whole point: a different provider is a different file, not a
 * different release of the panel.
 *
 * The one rule that is not configurable is the one that matters: an order is
 * only ever delivered on a *verify* that says paid, with the order id and the
 * amount checked against what we asked for. A buyer coming back to the bot
 * saying they paid is not evidence, and neither is the status call.
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const db = require('./db');
const payapi = require('./payapi');

const TIMEOUT = 20000;

/**
 * The gateway settings, with the shape the rest of this file expects.
 *
 * It has to reach into the store rather than through telegram.js: the bot
 * needs this module to offer the method at all, so asking it back would be a
 * circle. Which means creating the parents when they are not there - without
 * that, the first call on a panel whose bot has never been opened edits an
 * object nobody holds, and every setting written through it is lost.
 */
function settings() {
  const d = db.data;
  if (!d.bot || typeof d.bot !== 'object') d.bot = {};
  const b = d.bot;
  if (!b.pay || typeof b.pay !== 'object') b.pay = {};
  if (!b.pay.gateway || typeof b.pay.gateway !== 'object') b.pay.gateway = blank();
  const g = b.pay.gateway;
  if (!g.profile || typeof g.profile !== 'object') g.profile = null;
  if (!Number.isFinite(Number(g.multiplier))) g.multiplier = 10;
  return g;
}

/**
 * What a gateway looks like before anything has been imported.
 *
 * `multiplier` is ten because the panel sells in Toman and every Iranian
 * gateway is priced in Rial. It is a number rather than a fact so a shop
 * selling in Rial already, or in anything else, can set it to one.
 */
function blank() {
  return {
    enable: false,
    label: '🌐 پرداخت آنلاین',
    apiKey: '',
    callbackUrl: '',
    webhookSecret: '',
    /* where the gateway should send the signed result. Empty until the panel
       has a domain to be reached on, which is the usual state of a fresh
       install - and the bot asks the gateway itself in that case. */
    webhookUrl: '',
    multiplier: 10,
    profile: null,
    lastError: '',
    lastOkAt: 0
  };
}

/** Is the gateway ready to be offered to a buyer? '' when it is. */
function blockedReason() {
  const g = settings();
  if (!g.enable) return 'the gateway is switched off';
  if (!g.apiKey) return 'no API key has been set';
  if (!g.profile) return 'no gateway description has been imported';
  const problem = payapi.usable(g.profile);
  if (problem) return problem;
  if (!g.callbackUrl) return 'no return address has been set';
  return '';
}

function ready() { return !blockedReason(); }

/* ------------------------------ the transport ---------------------------- */

/**
 * One request to the gateway.
 *
 * Plain http is accepted only for a base address that says so, which in
 * practice means a test server on the same machine; no real gateway is
 * reachable that way and nothing here will quietly downgrade one that is not.
 */
function request(method, url, body, headers) {
  const target = new URL(url);
  const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
  const driver = target.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = driver.request({
      protocol: target.protocol,
      host: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method,
      headers: Object.assign({
        accept: 'application/json'
      }, payload ? {
        'content-type': 'application/json',
        'content-length': payload.length
      } : {}, headers || {}),
      timeout: TIMEOUT
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = null; }
        if (parsed === null) {
          return reject(new Error(`the gateway answered with something that is not JSON (HTTP ${res.statusCode})`));
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('the gateway did not answer in time')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The message a gateway's error body is trying to convey, in its own words -
 * and, where its own words leave the admin with nothing to do, what to do.
 *
 * "کلید API نامعتبر یا باطل‌شده است" is accurate and completely unactionable:
 * it does not say whether the key was mistyped, revoked, or belongs to another
 * gateway, and it does not say where to go and look. The gateway's sentence is
 * kept, because it is the gateway's answer, and the next step is added to it.
 */
function errorText(res) {
  const body = res.body || {};
  const err = body.error || body;
  if (typeof err === 'string') return err;
  const message = err.message || err.detail || err.description || '';
  const code = err.code || err.status || '';
  const said = message && code ? `${message} (${code})` : (message || code || `HTTP ${res.status}`);

  if (res.status === 401 || /unauthor/i.test(String(code))) {
    return `${said} — کلید API را در پنل خود درگاه بسازید یا دوباره کپی کنید و در پنل، بخش ربات ← پرداخت، جایگزینش کنید.`;
  }
  if (res.status === 403) {
    return `${said} — این مربوط به حساب شما نزد درگاه است، نه به پنل؛ با پشتیبانی درگاه تماس بگیرید.`;
  }
  return said;
}

/** The address of one operation in the profile, with the token filled in. */
function urlFor(profile, op, token) {
  let path = op.path;
  if (token && op.tokenIn === 'path') {
    path = path.replace(/\{[^}]+\}/, encodeURIComponent(token));
  }
  const url = new URL(profile.baseUrl.replace(/\/+$/, '') + path);
  if (token && op.tokenIn === 'query') url.searchParams.set(op.tokenParam || 'token', token);
  return url.toString();
}

/**
 * The key, as it can safely go in a header.
 *
 * A key is copied out of somebody else's panel and pasted, and a paste brings
 * whatever came with it. Spaces around it were sent as part of the header and
 * the gateway refused them; a newline in it threw "Invalid character in header
 * content", which names nothing anybody can act on. Neither is ever part of a
 * key, so both are taken off here - at the point of use, so a key that arrived
 * through a restored file or an API call is cleaned too, not only one typed
 * into the panel.
 */
function cleanKey(raw) {
  return String(raw === undefined || raw === null ? '' : raw).replace(/[\s​-‏﻿]/g, '');
}

function authHeaders(g) {
  const auth = (g.profile && g.profile.auth) || { kind: 'bearer', header: 'Authorization', prefix: 'Bearer ' };
  return { [auth.header || 'Authorization']: `${auth.prefix || ''}${cleanKey(g.apiKey)}` };
}

/* -------------------------------- the money ------------------------------ */

/**
 * What the gateway should charge, in the gateway's own unit.
 *
 * The panel's prices are in whatever the admin sells in - Toman, by default -
 * and the gateway is priced in Rial. Getting this wrong by a factor of ten in
 * either direction is the worst bug this file could have, so it is one
 * multiplication in one place and it is rounded, never truncated.
 */
function amountFor(price) {
  const g = settings();
  const n = Math.round(Number(price) * (Number(g.multiplier) || 1));
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

/**
 * An order id the gateway will accept.
 *
 * Our own ids are UUIDs, which fit the usual "letters, digits, dot, colon,
 * dash, underscore, up to 64" rule, but a gateway with a stricter one would
 * reject them silently at the till. Anything outside that set is replaced
 * rather than dropped, so two different orders cannot collapse into one id.
 */
function orderRef(order) {
  return `nexv-${String(order.id).replace(/[^A-Za-z0-9_.:-]/g, '-')}`.slice(0, 64);
}

/* ------------------------------- the calls ------------------------------- */

/**
 * Ask for a payment link.
 *
 * Asking twice for the same order is safe and expected: a gateway that
 * follows the usual convention hands back the link it already made, and a
 * buyer who pressed the button twice must not end up with two bills.
 */
async function createLink(order) {
  const g = settings();
  const blocked = blockedReason();
  if (blocked) throw new Error(blocked);

  const profile = g.profile;
  const field = profile.create.send;
  const amount = amountFor(order.price);
  if (!amount) throw new Error('that order has no price to charge');

  const body = {};
  body[field.amount] = amount;
  body[field.orderId] = orderRef(order);
  if (field.callback) body[field.callback] = g.callbackUrl;
  if (field.description && order.planName) body[field.description] = String(order.planName).slice(0, 200);
  /* only when the admin has a webhook key: a gateway that is told where to
     send one without having been given a key refuses the whole request */
  if (field.webhook && g.webhookSecret && g.webhookUrl) body[field.webhook] = g.webhookUrl;

  const res = await request(profile.create.method || 'POST',
    urlFor(profile, profile.create), body, authHeaders(g));

  if (res.status >= 400) {
    g.lastError = errorText(res);
    db.saveNow();
    throw new Error(g.lastError);
  }

  const got = profile.create.receive;
  const token = String(res.body[got.token] || '');
  if (!token) throw new Error('the gateway did not return a payment token');

  g.lastError = '';
  g.lastOkAt = Date.now();
  db.saveNow();

  return {
    token,
    url: String(res.body[got.payUrl] || ''),
    botUrl: got.botPayUrl ? String(res.body[got.botPayUrl] || '') : '',
    payable: got.payable ? String(res.body[got.payable] || '') : amount,
    expiresAt: got.expiresAt ? String(res.body[got.expiresAt] || '') : '',
    amount,
    ref: body[field.orderId]
  };
}

/**
 * The only answer an order may be delivered on.
 *
 * Three things have to line up, not one: the gateway says paid, the order it
 * is talking about is the order we asked about, and the amount is the amount
 * we asked for. A gateway answering about somebody else's order, or about a
 * smaller payment than the bill, is not a sale.
 */
async function verify(order) {
  const g = settings();
  const blocked = blockedReason();
  if (blocked) throw new Error(blocked);
  if (!order.payToken) throw new Error('that order has no payment to confirm');

  const profile = g.profile;
  const op = profile.verify;
  const body = op.tokenIn === 'body' ? { [op.tokenParam || 'token']: order.payToken } : undefined;
  const res = await request(op.method || 'POST', urlFor(profile, op, order.payToken), body, authHeaders(g));

  if (res.status >= 400) {
    return { ok: false, paid: false, reason: errorText(res) };
  }

  const got = op.receive || {};
  const state = String(res.body[got.status] || '').toLowerCase();
  const paid = (op.paidValues || ['paid']).some((v) => String(v).toLowerCase() === state);
  if (!paid) return { ok: true, paid: false, state };

  /* the order it answered about has to be the order we asked about */
  if (got.orderId) {
    const theirs = String(res.body[got.orderId] || '');
    if (theirs && theirs !== orderRef(order) && theirs !== String(order.id)) {
      return { ok: false, paid: false, reason: 'the gateway answered about a different order' };
    }
  }

  /* and for the money we billed. A gateway that allows a short payment will
     say so here, and a short payment is not a paid order. */
  const wanted = Number(amountFor(order.price));
  const settled = Number(res.body[got.paidAmount] || res.body[got.amount] || wanted);
  if (Number.isFinite(settled) && Number.isFinite(wanted) && settled + 1 < wanted) {
    return { ok: false, paid: false, reason: `only ${settled} of ${wanted} was paid` };
  }

  return { ok: true, paid: true, state, amount: settled, raw: res.body };
}

/** Where the payment has got to, for showing - never for delivering on. */
async function look(order) {
  const g = settings();
  const profile = g.profile;
  if (!profile || !profile.status || !order.payToken) return { state: '' };
  try {
    const op = profile.status;
    const res = await request(op.method || 'GET', urlFor(profile, op, order.payToken), undefined, authHeaders(g));
    if (res.status >= 400) return { state: '' };
    return { state: String(res.body[(op.receive || {}).status] || '') };
  } catch (_) {
    return { state: '' };
  }
}

/* ------------------------------- the webhook ----------------------------- */

/**
 * Is this really from the gateway?
 *
 * The signature is over the raw bytes exactly as they arrived - re-encoding
 * the parsed JSON would change a space or a key order and fail every time -
 * and compared in constant time, because a comparison that returns early
 * leaks the signature one byte at a time to anybody willing to ask often
 * enough. A timestamp more than five minutes old is refused so a signature
 * captured once cannot be replayed for ever.
 */
function checkSignature(rawBody, header, secret, maxAgeMs) {
  if (!secret) return { ok: false, reason: 'no webhook key has been set' };
  const text = String(header || '');
  const parts = {};
  for (const piece of text.split(',')) {
    const [key, value] = piece.split('=');
    if (key && value !== undefined) parts[key.trim()] = value.trim();
  }
  const when = Number(parts.t);
  const given = parts.v1 || '';
  if (!when || !given) return { ok: false, reason: 'the signature header is not in the expected form' };

  const age = Math.abs(Date.now() - when * 1000);
  if (age > (maxAgeMs || 5 * 60 * 1000)) return { ok: false, reason: 'the signature is too old' };

  const mine = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(mine, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'the signature does not match' };
  }
  return { ok: true };
}

/** A fresh webhook key, for the admin to paste into the gateway's own panel. */
function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  settings, blank, ready, blockedReason,
  createLink, verify, look,
  checkSignature, newSecret, amountFor, orderRef
};
