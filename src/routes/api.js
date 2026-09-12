'use strict';
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');

const db = require('../db');
const auth = require('../auth');
const xray = require('../xray');
const links = require('../links');
const system = require('../system');

const router = express.Router();

function bad(res, message, code = 400) { return res.status(code).json({ error: message }); }
function randomPass(bytes = 16) { return crypto.randomBytes(bytes).toString('base64url'); }

/** Shadowsocks-2022 needs a standard-base64 PSK whose length matches the cipher. */
function ssKey(method) {
  const bits = /aes-256|chacha20/.test(method || '') ? 32 : 16;
  return crypto.randomBytes(bits).toString('base64');
}
function isSS2022(method) { return String(method || '').startsWith('2022-'); }

function logEvent(type, message) {
  const d = db.data;
  d.logs.unshift({ at: Date.now(), type, message });
  if (d.logs.length > 500) d.logs.length = 500;
  db.save();
}

/* ------------------------------- auth ---------------------------------- */

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return bad(res, 'username and password are required');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const result = await auth.login(username, password, String(ip).split(',')[0].trim());
  if (!result) {
    logEvent('auth', `failed login for "${username}" from ${ip}`);
    return bad(res, 'invalid credentials', 401);
  }
  res.cookie(auth.COOKIE, result.token, auth.cookieOptions(req));
  logEvent('auth', `login: ${result.user.username} from ${ip}`);
  res.json({ ok: true, user: { username: result.user.username, role: result.user.role } });
});

router.post('/logout', (req, res) => {
  auth.logout(req);
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return bad(res, 'unauthorized', 401);
  res.json({ username: user.username, role: user.role });
});

// everything below requires a session
router.use(auth.requireAuth);

router.post('/account', async (req, res) => {
  const { username, password, currentPassword } = req.body || {};
  const bcrypt = require('bcryptjs');
  if (!currentPassword || !(await bcrypt.compare(String(currentPassword), req.user.password))) {
    return bad(res, 'current password is incorrect', 403);
  }
  if (username && username !== req.user.username) {
    if (db.data.users.some((u) => u.username === username)) return bad(res, 'username already taken');
    req.user.username = String(username).trim();
    db.saveNow();
  }
  if (password) await auth.setPassword(req.user.id, password);
  logEvent('auth', `account updated for ${req.user.username}`);
  res.json({ ok: true });
});

/* ------------------------------ dashboard ------------------------------- */

router.get('/status', async (req, res) => {
  const d = db.data;
  const clients = d.clients;
  const totals = clients.reduce((acc, c) => {
    acc.up += c.up || 0;
    acc.down += c.down || 0;
    return acc;
  }, { up: 0, down: 0 });

  res.json({
    system: await system.snapshot(),
    xray: await xray.serviceStatus(),
    counts: {
      inbounds: d.inbounds.length,
      inboundsEnabled: d.inbounds.filter((i) => i.enable !== false).length,
      clients: clients.length,
      clientsActive: clients.filter((c) => c.enable !== false && !xray.isExpired(c) && !xray.isOverQuota(c)).length,
      clientsExpired: clients.filter((c) => xray.isExpired(c)).length,
      clientsDepleted: clients.filter((c) => xray.isOverQuota(c)).length
    },
    traffic: totals,
    settings: { domain: d.settings.domain, subPath: d.settings.subPath, subPort: d.settings.subPort }
  });
});

router.get('/logs', (req, res) => res.json(db.data.logs.slice(0, 200)));

/* ------------------------------- inbounds ------------------------------- */

function normalizeInbound(body, existing) {
  const inb = Object.assign({}, existing || {}, {
    remark: String(body.remark || existing?.remark || 'inbound').trim(),
    protocol: body.protocol || existing?.protocol || 'vless',
    port: Number(body.port || existing?.port || 0),
    listen: body.listen ?? existing?.listen ?? '0.0.0.0',
    network: body.network || existing?.network || 'tcp',
    security: body.security || existing?.security || 'none',
    wsPath: body.wsPath ?? existing?.wsPath ?? '/',
    wsHost: body.wsHost ?? existing?.wsHost ?? '',
    grpcServiceName: body.grpcServiceName ?? existing?.grpcServiceName ?? '',
    grpcMultiMode: !!(body.grpcMultiMode ?? existing?.grpcMultiMode),
    xhttpMode: body.xhttpMode ?? existing?.xhttpMode ?? 'auto',
    sni: body.sni ?? existing?.sni ?? '',
    fingerprint: body.fingerprint ?? existing?.fingerprint ?? 'chrome',
    certFile: body.certFile ?? existing?.certFile ?? '',
    keyFile: body.keyFile ?? existing?.keyFile ?? '',
    method: body.method ?? existing?.method ?? '2022-blake3-aes-128-gcm',
    password: body.password ?? existing?.password ?? '',
    address: body.address ?? existing?.address ?? '',
    sniffing: body.sniffing ?? existing?.sniffing ?? true,
    enable: body.enable ?? existing?.enable ?? true,
    reality: Object.assign({
      dest: 'www.cloudflare.com:443',
      serverNames: ['www.cloudflare.com'],
      privateKey: '', publicKey: '', shortIds: [''], fingerprint: 'chrome'
    }, existing?.reality || {}, body.reality || {})
  });

  if (Array.isArray(inb.reality.serverNames) === false) {
    inb.reality.serverNames = String(inb.reality.serverNames || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(inb.reality.shortIds) === false) {
    inb.reality.shortIds = String(inb.reality.shortIds || '').split(',').map((s) => s.trim());
  }
  return inb;
}

router.get('/inbounds', (req, res) => {
  const d = db.data;
  res.json(d.inbounds.map((inb) => {
    const clients = d.clients.filter((c) => c.inboundId === inb.id);
    return Object.assign({}, inb, {
      clientCount: clients.length,
      up: clients.reduce((a, c) => a + (c.up || 0), 0),
      down: clients.reduce((a, c) => a + (c.down || 0), 0)
    });
  }));
});

router.post('/inbounds', async (req, res) => {
  const body = req.body || {};
  const inb = normalizeInbound(body, null);
  if (!inb.port || inb.port < 1 || inb.port > 65535) return bad(res, 'port must be between 1 and 65535');
  if (db.data.inbounds.some((i) => i.port === inb.port && (i.listen || '0.0.0.0') === inb.listen)) {
    return bad(res, `port ${inb.port} is already used by another inbound`);
  }
  inb.id = db.id();
  inb.tag = `inbound-${inb.port}-${inb.id.slice(0, 4)}`;
  if (inb.protocol === 'shadowsocks' && !inb.password) inb.password = ssKey(inb.method);
  inb.createdAt = Date.now();

  if (inb.security === 'reality' && !inb.reality.privateKey) {
    try {
      const keys = await xray.generateReality();
      inb.reality.privateKey = keys.privateKey;
      inb.reality.publicKey = keys.publicKey;
    } catch (err) {
      return bad(res, `could not generate reality keys: ${err.message}`);
    }
  }

  db.data.inbounds.push(inb);
  db.saveNow();
  const applied = await xray.apply();
  if (!applied.ok) {
    db.data.inbounds = db.data.inbounds.filter((i) => i.id !== inb.id);
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('inbound', `created ${inb.protocol} inbound on port ${inb.port}`);
  res.json(inb);
});

router.put('/inbounds/:id', async (req, res) => {
  const d = db.data;
  const idx = d.inbounds.findIndex((i) => i.id === req.params.id);
  if (idx < 0) return bad(res, 'inbound not found', 404);
  const before = d.inbounds[idx];
  const updated = normalizeInbound(req.body || {}, before);
  updated.id = before.id;
  updated.tag = before.tag;
  if (d.inbounds.some((i) => i.id !== updated.id && i.port === updated.port)) {
    return bad(res, `port ${updated.port} is already used by another inbound`);
  }
  d.inbounds[idx] = updated;
  db.saveNow();
  const applied = await xray.apply();
  if (!applied.ok) {
    d.inbounds[idx] = before;
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('inbound', `updated inbound ${updated.remark}`);
  res.json(updated);
});

router.delete('/inbounds/:id', async (req, res) => {
  const d = db.data;
  const inb = d.inbounds.find((i) => i.id === req.params.id);
  if (!inb) return bad(res, 'inbound not found', 404);
  d.inbounds = d.inbounds.filter((i) => i.id !== inb.id);
  d.clients = d.clients.filter((c) => c.inboundId !== inb.id);
  db.saveNow();
  await xray.apply();
  logEvent('inbound', `deleted inbound ${inb.remark}`);
  res.json({ ok: true });
});

router.post('/inbounds/:id/toggle', async (req, res) => {
  const inb = db.data.inbounds.find((i) => i.id === req.params.id);
  if (!inb) return bad(res, 'inbound not found', 404);
  inb.enable = inb.enable === false;
  db.saveNow();
  await xray.apply();
  res.json(inb);
});

router.get('/reality-keys', async (req, res) => {
  try {
    res.json(await xray.generateReality());
  } catch (err) {
    bad(res, `xray binary unavailable: ${err.message}`, 500);
  }
});

/* -------------------------------- clients ------------------------------- */

function normalizeClient(body, existing, inbound) {
  const c = Object.assign({}, existing || {}, {
    email: String(body.email || existing?.email || '').trim(),
    uuid: body.uuid || existing?.uuid || crypto.randomUUID(),
    password: body.password || existing?.password || randomPass(),
    flow: body.flow ?? existing?.flow ?? '',
    totalGB: Number(body.totalGB ?? existing?.totalGB ?? 0),
    expiryTime: Number(body.expiryTime ?? existing?.expiryTime ?? 0),
    limitIp: Number(body.limitIp ?? existing?.limitIp ?? 0),
    tgId: body.tgId ?? existing?.tgId ?? '',
    comment: body.comment ?? existing?.comment ?? '',
    enable: body.enable ?? existing?.enable ?? true,
    subId: body.subId || existing?.subId || randomPass(8)
  });
  // xtls-rprx-vision only makes sense on raw TCP with TLS or REALITY
  if (c.flow && !(inbound.protocol === 'vless' && (inbound.network || 'tcp') === 'tcp')) c.flow = '';
  // an ss-2022 user key must be base64 of the cipher's exact key size
  if (inbound.protocol === 'shadowsocks' && isSS2022(inbound.method) && !body.password) {
    if (!existing || !existing.ssMethod || existing.ssMethod !== inbound.method) {
      c.password = ssKey(inbound.method);
      c.ssMethod = inbound.method;
    }
  }
  return c;
}

router.get('/clients', (req, res) => {
  const d = db.data;
  const list = req.query.inboundId
    ? d.clients.filter((c) => c.inboundId === req.query.inboundId)
    : d.clients;
  res.json(list.map((c) => {
    const inb = d.inbounds.find((i) => i.id === c.inboundId);
    return Object.assign({}, c, {
      inboundRemark: inb ? inb.remark : '(deleted)',
      protocol: inb ? inb.protocol : '',
      expired: xray.isExpired(c),
      depleted: xray.isOverQuota(c),
      link: inb ? links.buildLink(inb, c) : ''
    });
  }));
});

router.post('/clients', async (req, res) => {
  const body = req.body || {};
  const inb = db.data.inbounds.find((i) => i.id === body.inboundId);
  if (!inb) return bad(res, 'inbound not found', 404);
  const client = normalizeClient(body, null, inb);
  if (!client.email) return bad(res, 'a client name (email) is required');
  if (db.data.clients.some((c) => c.email === client.email)) {
    return bad(res, 'that client name is already in use');
  }
  client.id = db.id();
  client.inboundId = inb.id;
  client.up = 0;
  client.down = 0;
  client.createdAt = Date.now();
  db.data.clients.push(client);
  db.saveNow();

  const applied = await xray.apply();
  if (!applied.ok) {
    db.data.clients = db.data.clients.filter((c) => c.id !== client.id);
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('client', `added client ${client.email} to ${inb.remark}`);
  res.json(Object.assign({}, client, { link: links.buildLink(inb, client) }));
});

router.put('/clients/:id', async (req, res) => {
  const d = db.data;
  const idx = d.clients.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return bad(res, 'client not found', 404);
  const before = d.clients[idx];
  const inb = d.inbounds.find((i) => i.id === (req.body.inboundId || before.inboundId));
  if (!inb) return bad(res, 'inbound not found', 404);
  const updated = normalizeClient(req.body || {}, before, inb);
  updated.id = before.id;
  updated.inboundId = inb.id;
  if (d.clients.some((c) => c.id !== updated.id && c.email === updated.email)) {
    return bad(res, 'that client name is already in use');
  }
  d.clients[idx] = updated;
  db.saveNow();
  await xray.apply();
  logEvent('client', `updated client ${updated.email}`);
  res.json(Object.assign({}, updated, { link: links.buildLink(inb, updated) }));
});

router.delete('/clients/:id', async (req, res) => {
  const d = db.data;
  const client = d.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);
  d.clients = d.clients.filter((c) => c.id !== client.id);
  db.saveNow();
  await xray.apply();
  logEvent('client', `deleted client ${client.email}`);
  res.json({ ok: true });
});

router.post('/clients/:id/toggle', async (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);
  client.enable = client.enable === false;
  db.saveNow();
  await xray.apply();
  res.json(client);
});

router.post('/clients/:id/reset-traffic', async (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);
  client.up = 0;
  client.down = 0;
  client.autoDisabled = false;
  db.saveNow();
  await xray.apply();
  logEvent('client', `reset traffic for ${client.email}`);
  res.json(client);
});

router.get('/clients/:id/qrcode', async (req, res) => {
  const d = db.data;
  const client = d.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);
  const inb = d.inbounds.find((i) => i.id === client.inboundId);
  if (!inb) return bad(res, 'inbound not found', 404);
  const target = req.query.sub === '1' ? subUrl(client.subId) : links.buildLink(inb, client);
  const dataUrl = await QRCode.toDataURL(target, { margin: 1, width: 380, errorCorrectionLevel: 'M' });
  res.json({ dataUrl, content: target });
});

function subUrl(subId) {
  const s = db.settings;
  const host = s.domain || s.serverIP || 'YOUR-SERVER';
  const scheme = s.domain ? 'https' : 'http';
  const port = s.domain && Number(s.subPort) === 443 ? '' : `:${s.subPort}`;
  const path = s.subPath.endsWith('/') ? s.subPath : `${s.subPath}/`;
  return `${scheme}://${host}${port}${path}${subId}`;
}

router.get('/clients/:id/sub-url', (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);
  res.json({ url: subUrl(client.subId) });
});

/* ------------------------------- settings ------------------------------- */

router.get('/settings', (req, res) => {
  const s = Object.assign({}, db.settings);
  delete s.sessionSecret;
  res.json(s);
});

router.put('/settings', async (req, res) => {
  const allowed = ['panelPort', 'webBasePath', 'domain', 'subDomain', 'subPort', 'subPath',
    'tgBotToken', 'tgAdminId', 'theme', 'lang', 'certFile', 'keyFile', 'xrayLogLevel',
    'blockTorrent', 'serverIP', 'trafficResetDay'];
  const s = db.settings;
  let restartNeeded = false;

  if (req.body.webBasePath !== undefined) {
    const clean = String(req.body.webBasePath).trim().replace(/^\/+|\/+$/g, '');
    if (clean && !/^[A-Za-z0-9_\-/]{1,64}$/.test(clean)) {
      return bad(res, 'مسیر پنل فقط می‌تواند شامل حروف، عدد، خط تیره و اسلش باشد');
    }
    const reserved = ['api', 'sub', 'login', 'assets'];
    if (reserved.includes(clean.split('/')[0])) {
      return bad(res, `مسیر «${clean}» رزرو شده است؛ نام دیگری انتخاب کنید`);
    }
    req.body.webBasePath = clean ? `/${clean}` : '';
  }

  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    if (key === 'panelPort' && Number(req.body[key]) !== Number(s[key])) restartNeeded = true;
    s[key] = req.body[key];
  }
  if (s.subPath && !s.subPath.startsWith('/')) s.subPath = `/${s.subPath}`;
  db.saveNow();
  const webBasePath = s.webBasePath || '';
  await xray.apply();
  logEvent('settings', 'panel settings updated');
  res.json({ ok: true, restartNeeded, webBasePath });
});

/* ------------------------------ xray control ---------------------------- */

router.get('/xray/config', (req, res) => res.json(xray.buildConfig()));

router.post('/xray/:action', async (req, res) => {
  const action = req.params.action;
  if (action === 'restart') {
    const result = await xray.apply();
    logEvent('xray', `restart: ${result.ok ? 'ok' : result.error}`);
    return result.ok ? res.json({ ok: true }) : bad(res, result.error);
  }
  if (action === 'start' || action === 'stop') {
    const result = await xray[action]();
    logEvent('xray', `${action}: ${result.ok ? 'ok' : result.stderr}`);
    return result.ok ? res.json({ ok: true }) : bad(res, result.stderr || `${action} failed`);
  }
  return bad(res, 'unknown action');
});

/* --------------------------- backup / restore --------------------------- */

router.get('/backup', (req, res) => {
  const dump = JSON.parse(JSON.stringify(db.data));
  delete dump.settings.sessionSecret;
  dump.sessions = [];
  res.setHeader('Content-Disposition', `attachment; filename="nexv-backup-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(dump, null, 2));
});

router.post('/restore', async (req, res) => {
  const incoming = req.body || {};
  if (!Array.isArray(incoming.inbounds) || !Array.isArray(incoming.clients)) {
    return bad(res, 'that file is not a NexV backup');
  }
  const d = db.data;
  const keepSecret = d.settings.sessionSecret;
  const keepUsers = d.users;
  const keepSessions = d.sessions;
  d.inbounds = incoming.inbounds;
  d.clients = incoming.clients;
  d.settings = Object.assign({}, incoming.settings || {}, { sessionSecret: keepSecret });
  d.users = (Array.isArray(incoming.users) && incoming.users.length) ? incoming.users : keepUsers;
  // keep only sessions whose admin survived the restore, so the caller is not
  // signed out by restoring a backup that still contains their own account
  const userIds = new Set(d.users.map((u) => u.id));
  d.sessions = keepSessions.filter((session) => userIds.has(session.userId));
  db.saveNow();
  await xray.apply();
  logEvent('settings', 'configuration restored from backup');
  res.json({ ok: true });
});

module.exports = router;
module.exports.subUrl = subUrl;
