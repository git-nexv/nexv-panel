'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

/**
 * How long a sign-in lasts. Seven days unless the admin says otherwise - a
 * panel on a shared machine wants hours, one on a laptop wants a fortnight,
 * and neither should have to be talked out of it.
 */
const DEFAULT_TTL = 1000 * 60 * 60 * 24 * 7;
function sessionTtl() {
  const hours = Number(db.settings.sessionHours) || 0;
  if (hours > 0) return Math.min(hours, 24 * 365) * 60 * 60 * 1000;
  return DEFAULT_TTL;
}
const COOKIE = 'nexv_session';

function secret() {
  const d = db.data;
  if (!d.settings.sessionSecret) {
    d.settings.sessionSecret = crypto.randomBytes(32).toString('hex');
    db.saveNow();
  }
  return d.settings.sessionSecret;
}

function sign(value) {
  const mac = crypto.createHmac('sha256', secret()).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function pruneSessions() {
  const now = Date.now();
  const d = db.data;
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => s.expiresAt > now);
  if (d.sessions.length !== before) db.save();
}

async function createUser(username, password, role = 'admin') {
  const d = db.data;
  const user = {
    id: db.id(),
    username: String(username).trim(),
    password: await bcrypt.hash(String(password), 10),
    role,
    createdAt: Date.now()
  };
  d.users.push(user);
  db.saveNow();
  return user;
}

async function setPassword(userId, password) {
  const user = db.data.users.find((u) => u.id === userId);
  if (!user) return false;
  user.password = await bcrypt.hash(String(password), 10);
  // every other session of this user is invalidated
  db.data.sessions = db.data.sessions.filter((s) => s.userId !== userId);
  db.saveNow();
  return true;
}

/**
 * What a browser says it is, trimmed to something a person can read.
 *
 * Kept verbatim rather than parsed into "Chrome on Android": the string is
 * the only evidence of which device this was, and a tidier guess made from it
 * is worth less than the thing itself when the question is "is one of these
 * not mine". Capped, because a user agent is attacker-controlled text that
 * ends up on the admin's own page.
 */
function deviceOf(req) {
  return String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200);
}

async function login(username, password, ip, device) {
  const user = db.data.users.find((u) => u.username === String(username).trim());
  // compare against a dummy hash when the user is unknown so timing does not leak existence
  const hash = user ? user.password : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
  const ok = await bcrypt.compare(String(password), hash);
  if (!user || !ok) return null;

  pruneSessions();
  const session = {
    id: crypto.randomBytes(24).toString('base64url'),
    userId: user.id,
    ip,
    /* where it is now as well as where it started: a session that signed in
       from one address and is being used from another is the thing worth
       seeing, and only the first was ever recorded */
    lastIp: ip,
    device: String(device || '').slice(0, 200),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + sessionTtl()
  };
  db.data.sessions.push(session);
  db.saveNow();
  return { user, token: sign(session.id) };
}

function logout(req) {
  const token = parseCookies(req)[COOKIE];
  const sid = unsign(token || '');
  if (!sid) return;
  db.data.sessions = db.data.sessions.filter((s) => s.id !== sid);
  db.saveNow();
}

/**
 * How stale a session's "last seen" may get before it is written again.
 *
 * This runs on every authenticated request, and the dashboard polls every
 * eight seconds - so writing the store each time would be a disk write per
 * poll per open tab, for a number nobody reads to the second. A minute is
 * close enough to answer "is this session being used right now".
 */
const TOUCH_EVERY_MS = 60000;

/** The session behind this request, or null. */
function sessionFor(req) {
  const token = parseCookies(req)[COOKIE];
  const sid = unsign(token || '');
  if (!sid) return null;
  const session = db.data.sessions.find((s) => s.id === sid);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

function currentUser(req) {
  const session = sessionFor(req);
  if (!session) return null;
  const user = db.data.users.find((u) => u.id === session.userId) || null;
  if (user) touch(session, req);
  return user;
}

/** Record that this session is still in use, and from where. */
function touch(session, req) {
  const now = Date.now();
  const where = require('./netfilter').clientIp(req);
  const moved = where && where !== session.lastIp;
  if (!moved && now - Number(session.lastSeenAt || 0) < TOUCH_EVERY_MS) return;
  session.lastSeenAt = now;
  if (where) session.lastIp = where;
  if (!session.device) session.device = deviceOf(req);
  // debounced: this is a note about activity, not something to flush at once
  db.save();
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionTtl(),
    secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  };
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

module.exports = {
  COOKIE, createUser, setPassword, login, logout,
  currentUser, requireAuth, cookieOptions, parseCookies,
  sessionFor, deviceOf
};
