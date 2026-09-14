'use strict';
/**
 * Reseller panels.
 *
 * The person who runs this server - the leader - can hand out panels of their
 * own to people who sell on their behalf. A reseller signs in at their own
 * address, sees three pages and nothing else, and spends a balance the leader
 * credits. Every gigabyte they hand out costs them, so the leader is selling
 * capacity rather than trust.
 *
 * A reseller is an ordinary user with role 'reseller' plus a record here: that
 * way sessions, password hashing and sign-out are the ones already in use and
 * not a second implementation with its own holes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');

const DATA_DIR = process.env.NEXV_DATA_DIR || '/etc/nexv/data';
const BOT_DIR = path.join(DATA_DIR, 'bots');

/** Toman per gigabyte, unless the leader sets otherwise for one reseller. */
const DEFAULT_PRICE_PER_GB = 3000;

function all() {
  const d = db.data;
  if (!Array.isArray(d.resellers)) d.resellers = [];
  return d.resellers;
}

function codes() {
  const d = db.data;
  if (!Array.isArray(d.codes)) d.codes = [];
  return d.codes;
}

function byId(id) {
  return all().find((r) => r.id === id) || null;
}

/** The address a reseller signs in at: their slug, nothing else in it. */
function bySlug(slug) {
  const clean = String(slug || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  return all().find((r) => r.slug === clean) || null;
}

function forUser(user) {
  if (!user || user.role !== 'reseller' || !user.resellerId) return null;
  return byId(user.resellerId);
}

/**
 * A slug nobody can guess, and which cannot collide with the leader's own
 * path - somebody who reached the leader's panel through a reseller's link
 * would be a hole with no bottom.
 */
function freeSlug() {
  for (let i = 0; i < 50; i++) {
    const slug = `r-${crypto.randomBytes(7).toString('base64url')}`;
    const leader = String(db.settings.webBasePath || '').replace(/^\/+|\/+$/g, '');
    if (slug !== leader && !bySlug(slug)) return slug;
  }
  throw new Error('could not find a free address');
}

function create({ name, inboundId, balance, pricePerGB, note }) {
  const reseller = {
    id: db.id(),
    name: String(name || '').trim() || 'reseller',
    slug: freeSlug(),
    userId: '',                       // set when they register
    balance: Number(balance) || 0,
    pricePerGB: Number(pricePerGB) > 0 ? Number(pricePerGB) : DEFAULT_PRICE_PER_GB,
    inboundId: inboundId || '',
    enable: true,
    note: String(note || ''),
    spent: 0,
    createdAt: Date.now(),
    lastLoginAt: 0
  };
  all().push(reseller);
  db.saveNow();
  return reseller;
}

function remove(id) {
  const reseller = byId(id);
  if (!reseller) return null;
  db.data.resellers = all().filter((r) => r.id !== id);
  // their sign-in stops working, and so does any session they hold
  if (reseller.userId) {
    db.data.users = db.data.users.filter((u) => u.id !== reseller.userId);
    db.data.sessions = db.data.sessions.filter((s) => s.userId !== reseller.userId);
  }
  db.data.codes = codes().filter((c) => c.resellerId !== id);
  db.saveNow();
  return reseller;
}

/* ------------------------------- the wallet ------------------------------ */

/**
 * What a client costs its reseller. Priced on the quota, because that is the
 * thing being sold; a client with no quota cannot be priced at all and so is
 * not something a reseller may make.
 */
function costOf(totalGB, reseller) {
  const gb = Number(totalGB) || 0;
  return Math.round(gb * (Number(reseller.pricePerGB) || DEFAULT_PRICE_PER_GB));
}

function adjust(reseller, amount, reason) {
  reseller.balance = Math.round((Number(reseller.balance) || 0) + Number(amount));
  logLine(reseller, amount, reason);
  db.saveNow();
  return reseller.balance;
}

/** Every movement of money, kept on the reseller so the leader can read it. */
function logLine(reseller, amount, reason) {
  if (!Array.isArray(reseller.ledger)) reseller.ledger = [];
  reseller.ledger.unshift({ at: Date.now(), amount: Number(amount), reason: String(reason || '') });
  if (reseller.ledger.length > 200) reseller.ledger.length = 200;
}

/** Take the cost of a client, or say why it cannot be taken. */
function charge(reseller, totalGB, label) {
  const cost = costOf(totalGB, reseller);
  if (cost <= 0) return { ok: true, cost: 0 };
  if ((reseller.balance || 0) < cost) {
    return {
      ok: false,
      cost,
      error: `not enough balance: this needs ${cost.toLocaleString()} and you have ${(reseller.balance || 0).toLocaleString()}`
    };
  }
  reseller.balance -= cost;
  reseller.spent = (reseller.spent || 0) + cost;
  logLine(reseller, -cost, label || 'client created');
  db.saveNow();
  return { ok: true, cost };
}

/* ------------------------------ charge codes ----------------------------- */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0, no I/1

function makeCode(length = 16) {
  const size = Math.min(24, Math.max(12, Number(length) || 16));
  let out = '';
  const bytes = crypto.randomBytes(size);
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * A code worth money. Tied to one reseller when the leader is topping that
 * person up, or loose when it is a gift anybody may redeem once.
 */
function issueCode({ amount, resellerId, note, length }) {
  const code = {
    id: db.id(),
    code: makeCode(length),
    amount: Math.round(Number(amount) || 0),
    resellerId: resellerId || '',
    note: String(note || ''),
    createdAt: Date.now(),
    usedAt: 0,
    usedBy: ''
  };
  codes().unshift(code);
  db.saveNow();
  return code;
}

/**
 * Spend a code. Wrong code, spent code, and somebody else's code all give the
 * same answer on purpose: a reseller poking at codes learns nothing from it.
 */
function redeem(reseller, typed) {
  const wanted = String(typed || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!wanted) return { ok: false, error: 'enter a code' };

  const entry = codes().find((c) => c.code === wanted);
  const usable = entry
    && !entry.usedAt
    && (!entry.resellerId || entry.resellerId === reseller.id);
  if (!usable) return { ok: false, error: 'that code is not valid' };

  entry.usedAt = Date.now();
  entry.usedBy = reseller.id;
  adjust(reseller, entry.amount, `code ${entry.code}`);
  return { ok: true, amount: entry.amount, balance: reseller.balance };
}

/* ---------------------------- their own bot ------------------------------ */

/**
 * Each reseller's bot lives in a file of its own.
 *
 * Not in db.json beside the leader's: the leader's bot is the one selling on
 * this server every day, and a reseller editing screens, plans and a token has
 * no business sharing a record with it. One file per reseller also means a
 * broken one is one broken file.
 */
function botFile(reseller) {
  return path.join(BOT_DIR, `${reseller.id}.json`);
}

function readBot(reseller) {
  try {
    return JSON.parse(fs.readFileSync(botFile(reseller), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeBot(reseller, value) {
  fs.mkdirSync(BOT_DIR, { recursive: true, mode: 0o750 });
  fs.writeFileSync(botFile(reseller), JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
}

/* --------------------------- their sign-in ------------------------------- */

/**
 * A reseller signs in as an ordinary user, so their account is one of
 * db.data.users with role 'reseller' pointing back here. Two ways one comes
 * into being: the leader fills it in from the Admins page, or - when the
 * leader leaves it blank - whoever opens the address first chooses it.
 */
function userOf(reseller) {
  if (!reseller || !reseller.userId) return null;
  return (db.data.users || []).find((u) => u.id === reseller.userId) || null;
}

function usernameOf(reseller) {
  const user = userOf(reseller);
  return user ? user.username : '';
}

/** Free for this reseller to take: not in use by anybody but themselves. */
function usernameTaken(name, reseller) {
  const wanted = String(name || '').trim();
  return (db.data.users || []).some(
    (u) => u.username === wanted && u.id !== (reseller && reseller.userId)
  );
}

/**
 * Set or change what a reseller signs in with.
 *
 * The password is only ever kept as a bcrypt hash, here as everywhere else, so
 * there is nothing to read back later - the leader sees the username and sets
 * a new password when they need one. Changing the password drops that person's
 * sessions, which is the whole point of changing it.
 */
async function setCredentials(reseller, { username, password }) {
  const name = username === undefined ? usernameOf(reseller) : String(username || '').trim();
  const pass = password === undefined || password === null ? '' : String(password);
  const existing = userOf(reseller);

  if (name.length < 3) return { ok: false, error: 'pick a username of at least three characters' };
  if (usernameTaken(name, reseller)) return { ok: false, error: 'that username is taken' };
  if (pass && pass.length < 8) return { ok: false, error: 'pick a password of at least eight characters' };
  if (!existing && !pass) return { ok: false, error: 'a new account needs a password' };

  if (!existing) {
    const user = await auth.createUser(name, pass, 'reseller');
    user.resellerId = reseller.id;
    reseller.userId = user.id;
    db.saveNow();
    return { ok: true, created: true, username: name };
  }

  const renamed = existing.username !== name;
  existing.username = name;
  existing.resellerId = reseller.id;              // repairs a half-made link
  db.saveNow();
  if (pass) await auth.setPassword(existing.id, pass);   // also ends their sessions
  return { ok: true, created: false, renamed, passwordChanged: !!pass, username: name };
}

/**
 * Throw the account away and put the panel back to how it started: the address
 * offers to make an account again. For when the leader hands a panel to
 * somebody else.
 */
function clearCredentials(reseller) {
  const user = userOf(reseller);
  if (!user) return false;
  db.data.users = db.data.users.filter((u) => u.id !== user.id);
  db.data.sessions = db.data.sessions.filter((s) => s.userId !== user.id);
  reseller.userId = '';
  db.saveNow();
  return true;
}

/** Something readable to hand over, when the leader cannot think of one. */
function suggestPassword() {
  const pool = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < 14; i++) out += pool[bytes[i] % pool.length];
  return out;
}

/* ------------------------------ what they see ---------------------------- */

/** Their own clients, and nobody else's. */
function clientsOf(reseller) {
  return (db.data.clients || []).filter((c) => c.resellerId === reseller.id);
}

/** The figures the leader wants in front of them for one reseller. */
function summary(reseller) {
  const clients = clientsOf(reseller);
  const used = clients.reduce((a, c) => a + (c.up || 0) + (c.down || 0), 0);
  const sold = clients.reduce((a, c) => a + (Number(c.totalGB) || 0), 0);
  return {
    id: reseller.id,
    name: reseller.name,
    slug: reseller.slug,
    enable: reseller.enable !== false,
    registered: !!reseller.userId,
    username: usernameOf(reseller),
    balance: reseller.balance || 0,
    spent: reseller.spent || 0,
    pricePerGB: reseller.pricePerGB || DEFAULT_PRICE_PER_GB,
    inboundId: reseller.inboundId || '',
    note: reseller.note || '',
    createdAt: reseller.createdAt,
    lastLoginAt: reseller.lastLoginAt || 0,
    clients: clients.length,
    active: clients.filter((c) => c.enable !== false).length,
    soldGB: sold,
    usedBytes: used,
    hasBot: !!readBot(reseller)
  };
}

module.exports = {
  DEFAULT_PRICE_PER_GB, BOT_DIR,
  all, codes, byId, bySlug, forUser, create, remove,
  costOf, charge, adjust, issueCode, redeem, makeCode,
  readBot, writeBot, botFile, clientsOf, summary,
  userOf, usernameOf, setCredentials, clearCredentials, suggestPassword
};
