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
    /*
     * Where the pay button takes the buyer.
     *
     * 'page' is the gateway's payment page itself, which is the short way:
     * one tap and they are choosing how to pay. 'telegram' is the gateway's
     * own Telegram bot, which keeps them in the app but adds a bot, a message
     * and a page in front of the same choice - four taps to reach what the
     * first one reaches in one. The short way is the default; the other is
     * there because staying inside Telegram is worth those taps to some shops.
     */
    openIn: 'page',
    apiKey: '',
    callbackUrl: '',
    /*
     * The key the gateway signs its webhooks with.
     *
     * The gateway's key, not ours. It is made in the gateway's own panel and
     * shown once, and we store it to check the signature on what arrives -
     * inventing one here and hoping the gateway uses it was the mistake that
     * made every payment fail with WEBHOOK_NOT_CONFIGURED.
     */
    webhookSecret: '',
    /* and whether the gateway has actually been set up to send one. Until the
       admin says so, the address is not offered to it at all: a gateway handed
       a webhook address it has no key for refuses the whole payment. */
    webhookReady: false,
    webhookNote: '',
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

/**
 * Did the gateway refuse the webhook, rather than the payment?
 *
 * Told apart by the gateway's own code where it gives one, and by its words
 * otherwise - because the answer decides whether the buyer gets a payment
 * link or an apology, and only one of those is right for a feature nobody
 * asked them about.
 */
function webhookRefused(res) {
  const err = (res.body || {}).error || {};
  const code = String(err.code || '');
  if (/WEBHOOK/i.test(code)) return true;
  const fields = [].concat(err.fields || [], err.field || []);
  if (fields.some((f) => /webhook/i.test(String(f)))) return true;
  return /webhook/i.test(String(err.message || ''));
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

/**
 * The order, in the only form Telegram will carry it home.
 *
 * When the buyer is sent back to a t.me link, Telegram hands the bot the
 * `start` payload and nothing else - not the token the gateway appended to
 * the address, not the status. So the order has to travel inside that
 * payload, and the payload is narrower than an order id is allowed to be:
 * letters, digits, underscore and dash, up to 64 characters. A dot or a colon
 * in there is silently dropped by Telegram and the buyer comes back to a bot
 * that cannot tell which order they mean.
 */
function startPayload(order) {
  return `paid-${orderRef(order)}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/**
 * Where the gateway should send the buyer back to, for this one order.
 *
 * A shop whose return address is its Telegram bot gets the order appended, so
 * the bot knows which payment the person coming back has just made. Anything
 * else - a website - is left exactly as the admin set it, because the gateway
 * matches it against what it has registered for them.
 */
function callbackFor(g, order) {
  const base = String(g.callbackUrl || '');
  if (!order || !order.id || !/^https:\/\/t\.me\//i.test(base)) return base;
  return `${base.split('?')[0]}?start=${startPayload(order)}`;
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
  if (field.callback) body[field.callback] = callbackFor(g, order);
  if (field.description && order.planName) body[field.description] = String(order.planName).slice(0, 200);
  /*
   * The webhook address rides along only when the gateway has been set up for
   * one at its end - `webhookReady` is the admin saying so after registering
   * the key there. It is not enough that we hold a key: the gateway refuses
   * the entire payment if it is handed an address it has no key for.
   */
  const wantWebhook = !!(field.webhook && g.webhookReady && g.webhookSecret && g.webhookUrl);
  if (wantWebhook) body[field.webhook] = g.webhookUrl;

  let res = await request(profile.create.method || 'POST',
    urlFor(profile, profile.create), body, authHeaders(g));

  /*
   * A sale must never fail over something optional.
   *
   * The webhook is a convenience - it tells us a payment landed without
   * waiting for the buyer to come back - and the buyer's own button and the
   * sweep both work without it. So a gateway that rejects the *webhook*
   * rather than the payment gets asked again with the address left off,
   * rather than the customer being told the gateway is unavailable. The
   * admin is told once, through lastError, that their webhook is not set up.
   */
  if (res.status >= 400 && wantWebhook && webhookRefused(res)) {
    delete body[field.webhook];
    g.webhookReady = false;
    g.webhookNote = errorText(res);
    db.saveNow();
    res = await request(profile.create.method || 'POST',
      urlFor(profile, profile.create), body, authHeaders(g));
  }

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
  checkSignature, newSecret, amountFor, orderRef, startPayload, callbackFor, payUrlOf
};

/**
 * Which of the two addresses the gateway handed back to send the buyer to.
 *
 * Falls through either way: a gateway with no Telegram page of its own still
 * has a payment page, and a shop that asked for the Telegram one must not end
 * up with no button at all because this gateway does not offer it.
 */
function payUrlOf(link) {
  const g = settings();
  if (g.openIn === 'telegram') return link.botUrl || link.url;
  return link.url || link.botUrl;
}
