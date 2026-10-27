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

async function login(username, password, ip) {
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
    createdAt: Date.now(),
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

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const sid = unsign(token || '');
  if (!sid) return null;
  const session = db.data.sessions.find((s) => s.id === sid);
  if (!session || session.expiresAt < Date.now()) return null;
  return db.data.users.find((u) => u.id === session.userId) || null;
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
  currentUser, requireAuth, cookieOptions, parseCookies
};
