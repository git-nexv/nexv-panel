'use strict';
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');

const db = require('../db');
const auth = require('../auth');
const xray = require('../xray');
const links = require('../links');
const transfer = require('../transfer');
const version = require('../version');
const update = require('../update');
const telegram = require('../telegram');
const online = require('../online');
const sitekind = require('../sitekind');
const parselink = require('../parselink');
const resellers = require('../reseller');
const probe = require('../probe');
const botai = require('../botai');
const system = require('../system');

const router = express.Router();

/*
 * Express 4 does not catch a rejected promise from an async handler: the
 * request simply hangs and the browser waits forever. A failing disk write
 * used to look like "the panel ignored me", so every handler is wrapped and
 * every failure is answered.
 */
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map((handler) => (
    handler.length >= 4 ? handler : (req, res, next) => {
      try { return Promise.resolve(handler(req, res, next)).catch(next); } catch (err) { return next(err); }
    }
  )));
}

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
  const mine = resellers.forUser(result.user);
  if (mine) {
    mine.lastLoginAt = Date.now();
    db.saveNow();
  }
  logEvent('auth', `login: ${result.user.username} from ${ip}`);
  res.json({ ok: true, user: { username: result.user.username, role: result.user.role } });
});

/**
 * A reseller making their own account, once.
 *
 * The leader hands over an address and nothing else; whoever opens it first
 * chooses the username and password. The address is the secret, so this works
 * exactly once per panel - after that the form is a sign-in like any other.
 */
router.post('/register', async (req, res) => {
  const { slug, username, password } = req.body || {};
  const reseller = resellers.bySlug(slug);
  if (!reseller || reseller.enable === false) return bad(res, 'this address is not open', 404);
  if (reseller.userId) return bad(res, 'this panel already has an account - sign in instead');

  const name = String(username || '').trim();
  if (name.length < 3) return bad(res, 'pick a username of at least three characters');
  if (String(password || '').length < 8) return bad(res, 'pick a password of at least eight characters');
  if (db.data.users.some((u) => u.username === name)) return bad(res, 'that username is taken');

  const user = await auth.createUser(name, String(password), 'reseller');
  user.resellerId = reseller.id;
  reseller.userId = user.id;
  db.saveNow();

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const result = await auth.login(name, String(password), ip);
  if (result) res.cookie(auth.COOKIE, result.token, auth.cookieOptions(req));
  logEvent('admin', `"${reseller.name}" opened their panel and made an account`);
  res.json({ ok: true, user: { username: name, role: 'reseller' } });
});

router.post('/logout', (req, res) => {
  auth.logout(req);
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return bad(res, 'unauthorized', 401);

  /* a reseller's panel is drawn from this: what they may see, what they may
     spend, and what they have already sold */
  const mine = resellers.forUser(user);
  if (mine) {
    const view = resellers.summary(mine);
    return res.json({
      username: user.username,
      role: 'reseller',
      reseller: {
        name: view.name,
        balance: view.balance,
        spent: view.spent,
        pricePerGB: view.pricePerGB,
        clients: view.clients,
        active: view.active,
        soldGB: view.soldGB,
        usedBytes: view.usedBytes,
        enable: view.enable,
        hasBot: view.hasBot,
        ledger: (mine.ledger || []).slice(0, 20)
      }
    });
  }
  res.json({ username: user.username, role: user.role || 'admin' });
});

/** Unauthenticated liveness probe, used by the nexv CLI to report panel state. */
router.get('/health', (req, res) => res.json({
  ok: true,
  uptime: Math.floor(process.uptime()),
  version: require('../../package.json').version
}));

// everything below requires a session
router.use(auth.requireAuth);

/*
 * What a reseller may touch.
 *
 * Deny by default, and list what is allowed rather than what is not: a route
 * added next month is then closed to them until somebody decides otherwise,
 * which is the way round that fails safely. Their own clients, their own bot,
 * their own wallet, and nothing that belongs to the server itself - no
 * inbounds, no outbounds, no routing, no settings, no backup, no Xray
 * controls, and not the pages showing which sites another person visited.
 */
const RESELLER_ALLOWS = [
  [/^\/me$/, ['GET']],
  [/^\/logout$/, ['POST']],
  [/^\/account$/, ['POST']],
  [/^\/status$/, ['GET']],
  [/^\/protocols$/, ['GET']],
  [/^\/clients$/, ['GET', 'POST']],
  [/^\/clients\/[^/]+$/, ['PUT', 'DELETE']],
  [/^\/clients\/[^/]+\/(toggle|reset-traffic|forget-ips)$/, ['POST']],
  [/^\/clients\/[^/]+\/(qrcode|sub)$/, ['GET']],
  [/^\/wallet\/redeem$/, ['POST']],
  [/^\/reseller\/bot$/, ['GET', 'PUT']]
];

router.use((req, res, next) => {
  req.reseller = resellers.forUser(req.user);
  if (!req.reseller) return next();
  if (req.reseller.enable === false) {
    return bad(res, 'this panel has been suspended - talk to whoever sold it to you', 403);
  }
  const path = req.path.replace(/\/+$/, '') || '/';
  const allowed = RESELLER_ALLOWS.some(([re, methods]) => re.test(path) && methods.includes(req.method));
  if (!allowed) return bad(res, 'not available on this panel', 403);
  next();
});

router.post('/account', async (req, res) => {
  const { username, password, currentPassword } = req.body || {};
  const bcrypt = require('bcryptjs');
  if (!currentPassword || !(await bcrypt.compare(String(currentPassword), req.user.password))) {
    return bad(res, 'current password is incorrect', 403);
  }
  try {
    if (username && username !== req.user.username) {
      if (db.data.users.some((u) => u.username === username)) return bad(res, 'username already taken');
      req.user.username = String(username).trim();
      db.saveNow();
    }
    if (password) await auth.setPassword(req.user.id, password);
  } catch (err) {
    // an unwritable data directory is the usual cause, and silence looked like
    // the panel ignoring the change
    return bad(res, `could not save the account: ${err.message}`, 500);
  }
  logEvent('auth', `account updated for ${req.user.username}`);
  res.json({ ok: true });
});


/* ------------------------------- the bot -------------------------------- */

/** The bot's own settings, without handing the token back out in full. */
function botView() {
  const b = telegram.bot();
  return {
    enabled: !!b.enabled,
    hasToken: !!b.token,
    tokenHint: b.token ? `${b.token.slice(0, 8)}…${b.token.slice(-4)}` : '',
    adminId: b.adminId || '',
    adminLinked: !!b.adminChatId,
    brand: b.brand || 'NexV',
    currency: b.currency || 'Toman',
    screens: b.screens || [],
    plans: b.plans || [],
    orders: (b.orders || []).slice(0, 60),
    pay: b.pay || telegram.defaults().pay,
    payWays: telegram.payWays(),
    channel: telegram.channel(),
    ai: {
      hasKey: !!(b.ai && b.ai.apiKey),
      provider: (b.ai && b.ai.provider) || 'anthropic',
      model: (b.ai && b.ai.model) || '',
      baseUrl: (b.ai && b.ai.baseUrl) || ''
    },
    providers: Object.entries(botai.PROVIDERS).map(([value, meta]) => ({
      value, label: meta.label, model: meta.model, needsUrl: !!meta.needsUrl
    })),
    status: telegram.status()
  };
}

router.get('/bot', (req, res) => res.json(botView()));

router.put('/bot', async (req, res) => {
  const b = telegram.bot();
  const body = req.body || {};
  // an empty token field means "leave the one you have"
  if (typeof body.token === 'string' && body.token.trim()) b.token = body.token.trim();
  if (body.token === null) b.token = '';
  if (body.adminId !== undefined) b.adminId = String(body.adminId).trim();
  if (body.brand !== undefined) b.brand = String(body.brand).slice(0, 40);
  if (body.currency !== undefined) b.currency = String(body.currency).slice(0, 16);
  if (Array.isArray(body.screens)) b.screens = botai.sanitise({ screens: body.screens });
  if (Array.isArray(body.plans)) {
    b.plans = body.plans.map((p) => ({
      id: p.id || db.id(),
      name: String(p.name || 'Plan').slice(0, 40),
      gb: Number(p.gb) || 0,
      days: Number(p.days) || 30,
      price: String(p.price || '0').slice(0, 20),
      inboundId: p.inboundId || '',
      enable: p.enable !== false
    }));
  }
  if (body.pay && typeof body.pay === 'object') {
    const pay = b.pay || telegram.defaults().pay;
    if (body.pay.card) {
      pay.card = {
        enable: body.pay.card.enable !== false,
        number: String(body.pay.card.number || '').slice(0, 40),
        holder: String(body.pay.card.holder || '').slice(0, 60),
        note: String(body.pay.card.note || '').slice(0, 300)
      };
    }
    if (body.pay.crypto) {
      pay.crypto = {
        enable: body.pay.crypto.enable !== false,
        note: String(body.pay.crypto.note || '').slice(0, 300),
        wallets: (Array.isArray(body.pay.crypto.wallets) ? body.pay.crypto.wallets : [])
          .map((w) => ({
            asset: String(w.asset || 'USDT').slice(0, 20),
            network: String(w.network || '').slice(0, 30),
            address: String(w.address || '').slice(0, 120)
          }))
          .filter((w) => w.address)
      };
    }
    b.pay = pay;
  }
  if (body.channel && typeof body.channel === 'object') {
    const c = telegram.channel();
    if (body.channel.enable !== undefined) c.enable = !!body.channel.enable;
    if (body.channel.id !== undefined) c.id = String(body.channel.id).trim().slice(0, 80);
    if (body.channel.link !== undefined) c.link = String(body.channel.link).trim().slice(0, 200);
    if (body.channel.text !== undefined) c.text = String(body.channel.text).slice(0, 1000);
  }
  if (body.ai && typeof body.ai === 'object') {
    b.ai = b.ai || {};
    if (typeof body.ai.apiKey === 'string' && body.ai.apiKey.trim()) b.ai.apiKey = body.ai.apiKey.trim();
    if (body.ai.apiKey === null) b.ai.apiKey = '';
    if (body.ai.provider !== undefined && botai.PROVIDERS[body.ai.provider]) b.ai.provider = body.ai.provider;
    if (body.ai.model !== undefined) b.ai.model = String(body.ai.model).slice(0, 60);
    if (body.ai.baseUrl !== undefined) b.ai.baseUrl = String(body.ai.baseUrl).slice(0, 200);
  }
  db.saveNow();
  logEvent('bot', 'bot settings saved');
  res.json(botView());
});

/** Does this token belong to a real bot? Answers without starting anything. */
router.post('/bot/test', async (req, res) => {
  const token = (req.body && req.body.token) || telegram.bot().token;
  if (!token) return bad(res, 'no token to test');
  try {
    const me = await telegram.whoAmI(token);
    res.json({ ok: true, username: me.username, name: me.first_name });
  } catch (err) { bad(res, err.message); }
});

router.post('/bot/start', async (req, res) => {
  try {
    const status = await telegram.start();
    logEvent('bot', `bot started (@${status.username || 'unknown'})`);
    res.json(status);
  } catch (err) { bad(res, err.message); }
});

router.post('/bot/stop', (req, res) => {
  logEvent('bot', 'bot stopped');
  res.json(telegram.stop());
});

router.get('/bot/status', (req, res) => res.json(telegram.status()));

/** Throw the screens away and start from the Persian starter again. */
router.post('/bot/reset-screens', (req, res) => {
  const b = telegram.bot();
  b.screens = telegram.starterScreens();
  db.saveNow();
  logEvent('bot', 'bot screens reset to the starter');
  res.json({ screens: b.screens });
});

/**
 * Prove the path a real sale takes.
 *
 * "Test the token" only proves Telegram knows the bot. The thing that silently
 * fails is the next step: the admin has never messaged the bot, so there is no
 * chat to send an order to, and the first anyone learns of it is a sale that
 * nobody was told about. This sends the admin the message a real receipt would
 * send, buttons and all - which also shows them what to expect.
 */
router.post('/bot/test-message', async (req, res) => {
  const b = telegram.bot();
  if (!b.token) return bad(res, 'set the bot token first');

  const chat = b.adminChatId || b.adminId;
  if (!chat) {
    return bad(res, 'no admin chat yet - open the bot in Telegram from your own account and send it /start, then try again');
  }

  try {
    await telegram.call('sendMessage', {
      chat_id: chat,
      parse_mode: 'HTML',
      text: [
        '<b>پیام آزمایشی</b>',
        '',
        'اگر این را می‌بینید، ربات می‌تواند به شما پیام بدهد و سفارش‌های واقعی هم به همین‌جا می‌آیند.',
        '',
        'یک سفارش واقعی این شکلی می‌رسد:',
        'اشتراک: نمونه · مبلغ: ۱۰۰٬۰۰۰ ' + telegram.escapeHtml(b.currency || ''),
        'خریدار: @example (۱۲۳۴۵۶۷۸۹)',
        '',
        'کانفیگ در همان لحظه به خریدار داده می‌شود؛ اگر رسید درست نبود «رد» را بزنید تا قطع شود.'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ تایید (آزمایشی)', callback_data: 'b:noop:' },
          { text: '✖️ رد (آزمایشی)', callback_data: 'b:noop:' }
        ]]
      }
    });
  } catch (err) {
    return bad(res, `Telegram refused it: ${err.message}`);
  }

  logEvent('bot', 'sent a test message to the admin');
  res.json({ ok: true, chat: String(chat) });
});

/**
 * Is the gate actually going to work?
 *
 * Telegram only answers "is this user in that channel" for a bot that is an
 * administrator there, so a gate on a channel the bot cannot see would lock
 * every user out. This says which of the two is wrong before it can happen.
 */
router.post('/bot/channel/test', async (req, res) => {
  const c = telegram.channel();
  const id = String((req.body && req.body.id) || c.id || '').trim();
  if (!id) return bad(res, 'enter the channel id or @username first');
  if (!telegram.bot().token) return bad(res, 'set the bot token first');

  let chat;
  try {
    chat = await telegram.call('getChat', { chat_id: id });
  } catch (err) {
    return bad(res, `the bot cannot see that channel: ${err.message}. Add it to the channel as an administrator.`);
  }

  let me;
  try { me = await telegram.whoAmI(telegram.bot().token); } catch (err) { return bad(res, err.message); }

  let membership;
  try {
    membership = await telegram.call('getChatMember', { chat_id: id, user_id: me.id });
  } catch (err) {
    return bad(res, `the bot is not in that channel: ${err.message}`);
  }
  const isAdmin = ['administrator', 'creator'].includes(membership.status);

  res.json({
    ok: isAdmin,
    title: chat.title || '',
    username: chat.username ? `@${chat.username}` : '',
    link: chat.invite_link || (chat.username ? `https://t.me/${chat.username}` : ''),
    status: membership.status,
    message: isAdmin
      ? `The bot is an administrator of "${chat.title || id}" and can check members.`
      : `The bot is in "${chat.title || id}" but only as "${membership.status}". Make it an administrator, or membership cannot be checked.`
  });
});

router.post('/bot/ai', async (req, res) => {
  const b = telegram.bot();
  const ready = botai.ready(b.ai);
  if (!ready.ok) return bad(res, ready.reason, 409);
  const description = (req.body && req.body.description) || '';
  if (!description.trim()) return bad(res, 'describe the bot you want');
  try {
    const result = await botai.generate(b.ai, description, req.body.useCurrent ? b.screens : null);
    res.json(result);
  } catch (err) { bad(res, err.message, 502); }
});

/* ------------------------------ dashboard ------------------------------- */

router.get('/status', async (req, res) => {
  const d = db.data;

  /*
   * A reseller is told about their own business and nothing about the machine
   * it runs on. Load, disk, the Xray version and how many other people are on
   * here are the leader's to know.
   */
  if (req.reseller) {
    const mine = resellers.clientsOf(req.reseller);
    return res.json({
      reseller: true,
      counts: {
        clients: mine.length,
        active: mine.filter((c) => c.enable !== false && !xray.isExpired(c) && !xray.isOverQuota(c)).length
      },
      balance: req.reseller.balance || 0,
      pricePerGB: req.reseller.pricePerGB || resellers.DEFAULT_PRICE_PER_GB,
      soldGB: mine.reduce((a, c) => a + (Number(c.totalGB) || 0), 0),
      traffic: mine.reduce((acc, c) => {
        acc.up += c.up || 0;
        acc.down += c.down || 0;
        return acc;
      }, { up: 0, down: 0 }),
      bot: { configured: !!resellers.readBot(req.reseller) }
    });
  }

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
      clientsDepleted: clients.filter((c) => xray.isOverQuota(c)).length,
      outbounds: (d.outbounds || []).length,
      routingRules: (d.routing || []).length
    },
    traffic: totals,
    settings: { domain: d.settings.domain, subPath: d.settings.subPath, subPort: d.settings.subPort }
  });
});

router.get('/logs', (req, res) => res.json(db.data.logs.slice(0, 200)));

/** Whether a newer panel has been published. Never fails the page. */
router.get('/version', async (req, res) => {
  const ready = update.available();
  try {
    res.json({ ...await version.check(req.query.force === '1'), canUpdate: ready.ok, updateBlockedBy: ready.reason });
  } catch (_) {
    res.json({ current: version.current, latest: version.current, updateAvailable: false, canUpdate: ready.ok });
  }
});

/**
 * Update the panel in place. The updater runs in its own systemd unit and
 * restarts the panel when it is done, so this answers as soon as it is
 * started - the browser watches /health for the new version.
 */
router.post('/update', async (req, res) => {
  let info;
  try { info = await version.check(true); } catch (_) { info = { current: version.current, latest: null }; }
  if (!info.updateAvailable && req.body?.force !== true) return bad(res, 'the panel is already up to date');

  const ready = update.available();
  if (!ready.ok) return bad(res, ready.reason, 409);

  try {
    update.start({ from: info.current, to: info.latest });
  } catch (err) {
    return bad(res, `could not start the update: ${err.message}`, 500);
  }
  logEvent('panel', `update to ${info.latest} started from the panel`);
  res.json({ ok: true, from: info.current, to: info.latest });
});

/** Progress of the running - or last - update, for the dialog to show. */
router.get('/update/log', (req, res) => res.json(update.state()));

/**
 * Ports the panel itself owns. An inbound on one of these passes `xray -test`
 * and then kills the service on start, because the address is already taken.
 */
function reservedPorts() {
  const s = db.settings;
  return [
    { port: Number(s.panelPort || 2087), what: 'the panel' },
    // NEXV_PORT overrides the stored setting at run time; reserve both, since a
    // restart can move the panel back onto the configured one
    { port: Number(process.env.NEXV_PORT || 0), what: 'the panel' },
    { port: Number(s.subPort || 0), what: 'the subscription server' },
    { port: xray.API_PORT, what: "Xray's own stats API" }
  ].filter((entry) => entry.port > 0);
}

function portConflict(port, listen, selfId) {
  const taken = reservedPorts().find((entry) => entry.port === Number(port));
  if (taken) return `port ${port} is used by ${taken.what}; pick another one`;
  const clash = db.data.inbounds.find(
    (i) => i.id !== selfId && i.port === Number(port) && (i.listen || '0.0.0.0') === (listen || '0.0.0.0')
  );
  if (clash) return `port ${port} is already used by inbound "${clash.remark}"`;
  return null;
}

router.get('/protocols', (req, res) => res.json({
  inbound: xray.INBOUND_PROTOCOLS,
  outbound: xray.OUTBOUND_PROTOCOLS,
  withClients: xray.CLIENT_PROTOCOLS,
  withLinks: xray.LINK_PROTOCOLS
}));

/* ------------------------------- inbounds ------------------------------- */

/** Accept a list either as an array or as a comma-separated string. */
function toList(value, existingValue, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  if (Array.isArray(existingValue)) return existingValue;
  return fallback;
}

function normalizeInbound(body, existing) {
  const inb = Object.assign({}, existing || {}, {
    remark: transfer.clean(body.remark ?? existing?.remark) || 'inbound',
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
    udp: body.udp ?? existing?.udp ?? true,
    kcpSeed: body.kcpSeed ?? existing?.kcpSeed ?? '',
    kcpHeader: body.kcpHeader ?? existing?.kcpHeader ?? 'none',
    targetAddress: body.targetAddress ?? existing?.targetAddress ?? '127.0.0.1',
    targetPort: Number(body.targetPort ?? existing?.targetPort ?? 0),
    targetNetwork: body.targetNetwork ?? existing?.targetNetwork ?? 'tcp,udp',
    followRedirect: body.followRedirect ?? existing?.followRedirect ?? false,
    wgPrivateKey: body.wgPrivateKey ?? existing?.wgPrivateKey ?? '',
    wgMtu: Number(body.wgMtu ?? existing?.wgMtu ?? 1420),
    xhttpMaxUploadSize: body.xhttpMaxUploadSize ?? existing?.xhttpMaxUploadSize ?? '',
    xhttpMaxBufferedUpload: body.xhttpMaxBufferedUpload ?? existing?.xhttpMaxBufferedUpload ?? '',
    xhttpMinUploadInterval: body.xhttpMinUploadInterval ?? existing?.xhttpMinUploadInterval ?? '',
    xhttpMaxHeaderBytes: body.xhttpMaxHeaderBytes ?? existing?.xhttpMaxHeaderBytes ?? '',
    tlsMinVersion: body.tlsMinVersion ?? existing?.tlsMinVersion ?? '1.2',
    tlsMaxVersion: body.tlsMaxVersion ?? existing?.tlsMaxVersion ?? '1.3',
    cipherSuites: body.cipherSuites ?? existing?.cipherSuites ?? '',
    rejectUnknownSni: body.rejectUnknownSni ?? existing?.rejectUnknownSni ?? false,
    alpn: toList(body.alpn, existing?.alpn, ['h2', 'http/1.1']),
    curvePreferences: toList(body.curvePreferences, existing?.curvePreferences, []),
    masterKeyLog: body.masterKeyLog ?? existing?.masterKeyLog ?? '',
    echServerKeys: body.echServerKeys ?? existing?.echServerKeys ?? '',
    echConfigList: body.echConfigList ?? existing?.echConfigList ?? '',
    certContent: body.certContent ?? existing?.certContent ?? '',
    keyContent: body.keyContent ?? existing?.keyContent ?? '',
    ocspStapling: Number(body.ocspStapling ?? existing?.ocspStapling ?? 0),
    certUsage: body.certUsage ?? existing?.certUsage ?? 'encipherment',
    certOneTimeLoading: body.certOneTimeLoading ?? existing?.certOneTimeLoading ?? false,
    sniffDestOverride: toList(body.sniffDestOverride, existing?.sniffDestOverride, ['http', 'tls', 'quic']),
    sniffMetadataOnly: body.sniffMetadataOnly ?? existing?.sniffMetadataOnly ?? false,
    sniffRouteOnly: body.sniffRouteOnly ?? existing?.sniffRouteOnly ?? false,
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
  const clash = portConflict(inb.port, inb.listen, null);
  if (clash) return bad(res, clash);
  inb.id = db.id();
  inb.tag = `inbound-${inb.port}-${inb.id.slice(0, 4)}`;
  inb.createdAt = Date.now();

  // Nothing is filled in silently: the form offers a Generate button for each
  // of these, so an empty field is a mistake worth naming rather than papering
  // over with a value the admin never saw.
  if (inb.protocol === 'shadowsocks' && !inb.password) {
    return bad(res, 'a Shadowsocks password is required - use Generate to make one');
  }
  if (inb.security === 'reality' && !inb.reality.privateKey) {
    return bad(res, 'REALITY needs a key pair - use Generate next to the private key');
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
  const clash = portConflict(updated.port, updated.listen, updated.id);
  if (clash) return bad(res, clash);
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
  /*
   * By default the clients outlive it. Deleting an inbound used to delete
   * everybody on it, which is not what "delete this inbound" means to anyone:
   * the people, their quotas and - above all - their subId stay, so a new
   * inbound can take them over and every subscription link they hold keeps
   * working. ?withClients=1 is the admin saying otherwise, in so many words.
   */
  const withClients = ['1', 'true', 'yes'].includes(String(req.query.withClients || ''));
  d.inbounds = d.inbounds.filter((i) => i.id !== inb.id);

  let detached = 0;
  let deleted = 0;
  if (withClients) {
    const doomed = d.clients.filter((c) => c.inboundId === inb.id);
    deleted = doomed.length;
    for (const c of doomed) online.forget(xray.clientTag(c));
    d.clients = d.clients.filter((c) => c.inboundId !== inb.id);
  } else {
    for (const client of d.clients) {
      if (client.inboundId === inb.id) { client.inboundId = ''; detached++; }
    }
  }

  db.saveNow();
  await xray.apply();
  const fate = deleted
    ? ` - ${deleted} client(s) deleted with it`
    : detached ? ` - ${detached} client(s) kept, now unattached` : '';
  logEvent('inbound', `deleted inbound ${inb.remark}${fate}`);
  res.json({ ok: true, detached, deleted });
});

/**
 * Move clients onto this inbound, or off it.
 *
 * A client belongs to one inbound at a time. Moving does not touch their subId,
 * so a subscription link that was working before keeps working afterwards - it
 * is how you rebuild an inbound without reissuing anyone's config.
 */
router.post('/inbounds/:id/attach', async (req, res) => {
  const d = db.data;
  const inb = d.inbounds.find((i) => i.id === req.params.id);
  if (!inb) return bad(res, 'inbound not found', 404);

  const body = req.body || {};
  const wanted = body.all
    ? d.clients
    : d.clients.filter((c) => (body.clientIds || []).includes(c.id));
  if (!wanted.length) return bad(res, 'no clients to attach');

  let moved = 0;
  for (const client of wanted) {
    if (client.inboundId === inb.id) continue;
    client.inboundId = inb.id;
    moved++;
  }
  db.saveNow();
  const applied = await xray.apply();
  if (!applied.ok) return bad(res, applied.error);
  logEvent('client', `attached ${moved} client(s) to ${inb.remark}`);
  res.json({ ok: true, moved });
});

router.post('/inbounds/:id/detach', async (req, res) => {
  const d = db.data;
  const inb = d.inbounds.find((i) => i.id === req.params.id);
  if (!inb) return bad(res, 'inbound not found', 404);

  const body = req.body || {};
  const mine = d.clients.filter((c) => c.inboundId === inb.id);
  const wanted = body.all ? mine : mine.filter((c) => (body.clientIds || []).includes(c.id));
  for (const client of wanted) client.inboundId = '';
  db.saveNow();
  await xray.apply();
  logEvent('client', `detached ${wanted.length} client(s) from ${inb.remark}`);
  res.json({ ok: true, moved: wanted.length });
});

router.post('/inbounds/:id/toggle', async (req, res) => {
  const inb = db.data.inbounds.find((i) => i.id === req.params.id);
  if (!inb) return bad(res, 'inbound not found', 404);
  inb.enable = inb.enable === false;
  db.saveNow();
  await xray.apply();
  res.json(inb);
});

/** Values the inbound form can generate on demand, one field at a time. */
router.get('/generate/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (kind === 'uuid') return res.json({ value: crypto.randomUUID() });
  if (kind === 'password') return res.json({ value: randomPass() });
  if (kind === 'shortid') {
    // REALITY short IDs are hex, 0-8 bytes; 8 hex chars is the common choice
    return res.json({ value: crypto.randomBytes(4).toString('hex') });
  }
  if (kind === 'sskey') {
    return res.json({ value: ssKey(String(req.query.method || '')) });
  }
  if (kind === 'ech') {
    // a missing SNI is the caller's mistake, not the server's
    if (!String(req.query.sni || '').trim()) {
      return bad(res, 'fill in the SNI first, then generate the ECH keys');
    }
    try {
      return res.json(await xray.generateECH(req.query.sni));
    } catch (err) {
      return bad(res, err.message, 500);
    }
  }
  if (kind === 'reality') {
    try {
      const keys = await xray.generateReality();
      return res.json(keys);
    } catch (err) {
      return bad(res, `xray could not generate a key pair: ${err.message}`, 500);
    }
  }
  if (kind === 'wireguard') {
    // x25519 private key; the peer supplies its own public key
    return res.json({ value: crypto.randomBytes(32).toString('base64') });
  }
  return bad(res, `nothing to generate for "${kind}"`);
});

router.get('/reality-keys', async (req, res) => {
  try {
    res.json(await xray.generateReality());
  } catch (err) {
    bad(res, `xray binary unavailable: ${err.message}`, 500);
  }
});

/* ------------------------- import / export ------------------------------ */

/** Every share link for one inbound, newest client last. */
function inboundLinks(inb) {
  return db.data.clients
    .filter((c) => c.inboundId === inb.id)
    .map((c) => links.buildLink(inb, c))
    .filter(Boolean);
}

router.get('/inbounds/:id/export', (req, res) => {
  const inb = db.data.inbounds.find((i) => i.id === req.params.id);
  if (!inb) return bad(res, 'inbound not found', 404);
  const clients = db.data.clients.filter((c) => c.inboundId === inb.id);
  /*
   * Both shapes, because the two things you might do with it want different
   * ones: reading it, or pasting it where another panel's export would go,
   * wants the objects 3x-ui's own export prints; posting it to that panel's
   * API wants them encoded as strings, which is how its Go model is declared.
   */
  res.json({
    panel: JSON.stringify(transfer.exportInbound(inb, clients, { asObjects: true }), null, 2),
    api: JSON.stringify(transfer.exportInbound(inb, clients), null, 2),
    clients: clients.length
  });
});

router.post('/inbounds/import', async (req, res) => {
  const body = req.body || {};
  // the panel sends what was pasted into the box; an object still works
  let source = body;
  if (typeof body.text === 'string') {
    try { source = JSON.parse(body.text); } catch (_) { return bad(res, 'that is not valid JSON'); }
  }

  let parsed;
  try {
    parsed = transfer.importInbound(source);
  } catch (err) {
    return bad(res, err.message);
  }
  const { inbound, clients } = parsed;

  if (!inbound.port || inbound.port < 1 || inbound.port > 65535) {
    return bad(res, 'there is no usable port in that text');
  }
  const clash = portConflict(inbound.port, inbound.listen, null);
  if (clash) return bad(res, clash);

  /*
   * A client name is unique across the panel. Renaming people silently would
   * break the links they already hold, so by default a clash stops the import;
   * `replace` is for the case the admin means - the same people, moved here.
   */
  const taken = new Set(db.data.clients.map((c) => c.email));
  const collisions = clients.filter((c) => taken.has(c.email)).map((c) => c.email);
  if (collisions.length && !body.replace) {
    return bad(res, `these client names already exist: ${collisions.slice(0, 5).join(', ')}${collisions.length > 5 ? '…' : ''}. Tick "replace" to move them here.`);
  }
  if (collisions.length) {
    const names = new Set(collisions);
    db.data.clients = db.data.clients.filter((c) => !names.has(c.email));
  }

  inbound.id = db.id();
  inbound.tag = `inbound-${inbound.port}-${inbound.id.slice(0, 4)}`;
  inbound.createdAt = Date.now();
  const stored = clients.map((c) => Object.assign(c, {
    id: db.id(),
    inboundId: inbound.id,
    createdAt: Date.now()
  }));

  db.data.inbounds.push(inbound);
  db.data.clients.push(...stored);
  db.saveNow();

  const applied = await xray.apply();
  if (!applied.ok) {
    db.data.inbounds = db.data.inbounds.filter((i) => i.id !== inbound.id);
    db.data.clients = db.data.clients.filter((c) => c.inboundId !== inbound.id);
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('inbound', `imported ${inbound.protocol} inbound on port ${inbound.port} with ${stored.length} client(s)`);
  res.json({
    ok: true,
    inbound,
    clients: stored.length,
    replaced: collisions.length,
    // worth saying out loud: their address was not one this machine can bind
    movedAddress: inbound.address || ''
  });
});

/** Share links as plain text, for one inbound or for all of them. */
router.get('/urls', (req, res) => {
  const wanted = req.query.inboundId;
  const list = db.data.inbounds
    .filter((inb) => !wanted || inb.id === wanted)
    .flatMap(inboundLinks);
  res.type('text/plain').send(list.join('\n'));
});

/** Subscription URLs, one per client. */
router.get('/sub-urls', (req, res) => {
  const wanted = req.query.inboundId;
  const seen = new Set();
  const list = [];
  for (const c of db.data.clients) {
    if (wanted && c.inboundId !== wanted) continue;
    if (!c.subId || seen.has(c.subId)) continue;
    seen.add(c.subId);
    list.push(`${c.email}: ${subUrl(c.subId)}`);
  }
  res.type('text/plain').send(list.join('\n'));
});

/** Zero the counters of every client of an inbound, or of all inbounds. */
router.post('/inbounds/reset-traffic', async (req, res) => {
  const wanted = req.body && req.body.inboundId;
  let count = 0;
  for (const c of db.data.clients) {
    if (wanted && c.inboundId !== wanted) continue;
    c.up = 0;
    c.down = 0;
    c.autoDisabled = false;
    count += 1;
  }
  db.saveNow();
  await xray.apply();
  logEvent('client', `reset traffic for ${count} client(s)`);
  res.json({ ok: true, count });
});

/* -------------------------------- clients ------------------------------- */

/*
 * Whose client is this? The leader owns everything; a reseller owns what they
 * sold. Answering "not found" rather than "not yours" keeps one reseller from
 * learning that another reseller's client exists by guessing at ids.
 */
function owns(req, client) {
  if (!req.reseller) return true;
  return client.resellerId === req.reseller.id;
}

function normalizeClient(body, existing, inbound) {
  const c = Object.assign({}, existing || {}, {
    // a newline in a name makes the export unreadable to other panels
    email: transfer.clean(body.email ?? existing?.email),
    uuid: body.uuid || existing?.uuid || crypto.randomUUID(),
    password: body.password || existing?.password || randomPass(),
    flow: body.flow ?? existing?.flow ?? '',
    totalGB: Number(body.totalGB ?? existing?.totalGB ?? 0),
    expiryTime: Number(body.expiryTime ?? existing?.expiryTime ?? 0),
    /*
     * Sold but not started. Somebody who buys on Monday and installs on Friday
     * has lost four days of a month they paid for, so the clock can be left
     * unwound until the config is first used: expiryDays is held here and
     * turned into a real expiryTime the moment traffic first moves.
     */
    resellerId: body.resellerId ?? existing?.resellerId ?? '',
    startAfterFirstUse: body.startAfterFirstUse ?? existing?.startAfterFirstUse ?? false,
    expiryDays: Number(body.expiryDays ?? existing?.expiryDays ?? 0),
    /* set when a sale was reversed; turning the client back on clears it */
    blockedReason: body.blockedReason ?? existing?.blockedReason ?? '',
    limitIp: Number(body.limitIp ?? existing?.limitIp ?? 0),
    tgId: body.tgId ?? existing?.tgId ?? '',
    comment: transfer.clean(body.comment ?? existing?.comment),
    wgPublicKey: body.wgPublicKey ?? existing?.wgPublicKey ?? '',
    wgAllowedIPs: Array.isArray(body.wgAllowedIPs)
      ? body.wgAllowedIPs
      : (body.wgAllowedIPs !== undefined
        ? String(body.wgAllowedIPs).split(',').map((s) => s.trim()).filter(Boolean)
        : (existing?.wgAllowedIPs ?? [])),
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
  let list = req.query.inboundId
    ? d.clients.filter((c) => c.inboundId === req.query.inboundId)
    : d.clients;
  // a reseller sees the people they sold to and nobody else
  if (req.reseller) list = d.clients.filter((c) => c.resellerId === req.reseller.id);
  res.json(list.map((c) => {
    const inb = d.inbounds.find((i) => i.id === c.inboundId);
    const live = online.forTag(xray.clientTag(c));
    const rate = xray.rateFor(c.id);
    return Object.assign({}, c, {
      inboundRemark: inb ? inb.remark : 'not attached',
      protocol: inb ? inb.protocol : '',
      expired: xray.isExpired(c),
      depleted: xray.isOverQuota(c),
      overIps: xray.isOverIpLimit(c),
      link: inb ? links.buildLink(inb, c) : '',
      /* what the copy key hands over: a subscription link keeps working when
         the config behind it is changed, where a pasted vless:// does not */
      subLink: c.subId ? subUrl(c.subId) : '',
      // moving traffic right now counts as online even before a new connection
      // shows up in the access log, which is only read every ten seconds
      online: live.online || rate.up + rate.down > 0,
      speed: { up: Math.round(rate.up), down: Math.round(rate.down) },
      ips: live.ips,
      ipCount: live.ips.length
    });
  }));
});

/**
 * Add a client to an inbound and push the new Xray config, rolling the client
 * back if Xray refuses it. Shared with the Telegram bot, which sells the same
 * thing this route creates by hand.
 */
async function createClient(inbound, body) {
  const client = normalizeClient(body, null, inbound);
  if (!client.email) throw new Error('a client name (email) is required');
  if (db.data.clients.some((c) => c.email === client.email)) {
    throw new Error('that client name is already in use');
  }
  client.id = db.id();
  client.inboundId = inbound.id;
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
    throw new Error(applied.error);
  }
  logEvent('client', `added client ${client.email} to ${inbound.remark}`);
  return Object.assign({}, client, { link: links.buildLink(inbound, client) });
}

router.post('/clients', async (req, res) => {
  const body = req.body || {};

  /*
   * A reseller does not choose an inbound and does not choose to pay nothing:
   * the inbound is the one the leader put them on, and the quota is what their
   * balance is spent on. Both are settled here rather than trusted from the
   * form, which is the only place it can be settled safely.
   */
  let charged = null;
  if (req.reseller) {
    const gb = Number(body.totalGB) || 0;
    if (gb <= 0) return bad(res, 'set a quota - an unlimited client cannot be priced');
    body.inboundId = req.reseller.inboundId;
    body.resellerId = req.reseller.id;
    const bill = resellers.charge(req.reseller, gb, `client ${body.email || ''}`.trim());
    if (!bill.ok) return bad(res, bill.error);
    charged = bill.cost;
  }

  const inb = db.data.inbounds.find((i) => i.id === body.inboundId);
  if (!inb) {
    if (charged) resellers.adjust(req.reseller, charged, 'refund - inbound missing');
    return bad(res, req.reseller ? 'this panel has no inbound set up yet - talk to whoever sold it to you' : 'inbound not found', 404);
  }

  try {
    const made = await createClient(inb, body);
    if (req.reseller) made.balance = req.reseller.balance;
    res.json(made);
  } catch (err) {
    // the money goes back if the client did not happen
    if (charged) resellers.adjust(req.reseller, charged, 'refund - client not created');
    bad(res, err.message);
  }
});

router.put('/clients/:id', async (req, res) => {
  const d = db.data;
  const idx = d.clients.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return bad(res, 'client not found', 404);
  const before = d.clients[idx];
  if (!owns(req, before)) return bad(res, 'client not found', 404);

  /* raising a quota costs the difference; lowering one gives it back, because
     otherwise a reseller who mistypes a number has simply lost the money */
  if (req.reseller) {
    const wasGB = Number(before.totalGB) || 0;
    const nowGB = Number(req.body.totalGB ?? wasGB) || 0;
    if (nowGB <= 0) return bad(res, 'set a quota - an unlimited client cannot be priced');
    if (nowGB > wasGB) {
      const bill = resellers.charge(req.reseller, nowGB - wasGB, `${before.email}: quota raised`);
      if (!bill.ok) return bad(res, bill.error);
    } else if (nowGB < wasGB) {
      resellers.adjust(req.reseller, resellers.costOf(wasGB - nowGB, req.reseller), `${before.email}: quota lowered`);
    }
    req.body.inboundId = req.reseller.inboundId;
    req.body.resellerId = req.reseller.id;
  }
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
  if (!client || !owns(req, client)) return bad(res, 'client not found', 404);
  d.clients = d.clients.filter((c) => c.id !== client.id);
  online.forget(xray.clientTag(client));
  db.saveNow();
  await xray.apply();
  logEvent('client', `deleted client ${client.email}`);
  res.json({ ok: true });
});

/*
 * Clearing out the dead wood. Picking off finished clients one row at a time is
 * the chore this replaces, so each scope is deliberately narrow and the server
 * decides who matches - the browser's copy of the list can be minutes old.
 */
const PURGE_SCOPES = {
  expired: { label: 'expired', match: (c) => xray.isExpired(c) },
  depleted: { label: 'out of quota', match: (c) => xray.isOverQuota(c) },
  finished: { label: 'expired or out of quota', match: (c) => xray.isExpired(c) || xray.isOverQuota(c) },
  disabled: { label: 'disabled', match: (c) => c.enable === false },
  all: { label: '', match: () => true }
};

router.post('/clients/purge', async (req, res) => {
  const body = req.body || {};
  const scope = PURGE_SCOPES[body.scope];
  if (!scope) return bad(res, `unknown scope - use one of ${Object.keys(PURGE_SCOPES).join(', ')}`);

  const d = db.data;
  const scoped = body.inboundId
    ? d.clients.filter((c) => c.inboundId === body.inboundId)
    : d.clients;
  const doomed = scoped.filter(scope.match);
  if (!doomed.length) return res.json({ ok: true, deleted: 0, names: [] });

  const ids = new Set(doomed.map((c) => c.id));
  for (const c of doomed) online.forget(xray.clientTag(c));
  d.clients = d.clients.filter((c) => !ids.has(c.id));
  db.saveNow();
  await xray.apply();

  const names = doomed.map((c) => c.email);
  const kind = scope.label ? `${scope.label} ` : '';
  logEvent('client', `deleted ${doomed.length} ${kind}client(s): ${names.slice(0, 8).join(', ')}${names.length > 8 ? '\u2026' : ''}`);
  res.json({ ok: true, deleted: doomed.length, names });
});

router.post('/clients/:id/toggle', async (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client || !owns(req, client)) return bad(res, 'client not found', 404);
  client.enable = client.enable === false;
  // switching one back on is the admin overruling whatever cut it off
  if (client.enable) client.blockedReason = '';
  db.saveNow();
  await xray.apply();
  res.json(client);
});

router.post('/clients/:id/reset-traffic', async (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client || !owns(req, client)) return bad(res, 'client not found', 404);
  client.up = 0;
  client.down = 0;
  client.autoDisabled = false;
  db.saveNow();
  await xray.apply();
  logEvent('client', `reset traffic for ${client.email}`);
  res.json(client);
});

/**
 * What this client's traffic has been going to.
 *
 * The honest shape of it: connection counts per host, grouped into kinds, with
 * a note about what is missing. Xray's access log never records how much went
 * through a connection, so there is no byte figure to show per site and none
 * is invented - the client's total is what the panel measures, and this is
 * what that total was spent on.
 */
router.get('/clients/:id/sites', (req, res) => {
  const d = db.data;
  const client = d.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);

  const raw = online.sitesFor(xray.clientTag(client));
  const labels = sitekind.labels();
  const byKind = new Map();
  const byApp = new Map();

  const sites = raw.sites.map((site) => {
    const kind = sitekind.kindOf(site.host);
    const app = sitekind.appOf(site.host);

    const group = byKind.get(kind.kind) || { kind: kind.kind, label: kind.label, hits: 0, hosts: 0 };
    group.hits += site.hits;
    group.hosts++;
    byKind.set(kind.kind, group);

    /* one row per app rather than per CDN hostname: forty googlevideo.com
       machines are one thing to a person, and that thing is YouTube */
    const name = app || site.host;
    const entry = byApp.get(name) || { app: name, known: !!app, kind: kind.kind, kindLabel: kind.label, hits: 0, hosts: 0, at: 0 };
    entry.hits += site.hits;
    entry.hosts++;
    entry.at = Math.max(entry.at, site.at);
    byApp.set(name, entry);

    return {
      host: site.host,
      app,
      kind: kind.kind,
      kindLabel: kind.label,
      hits: site.hits,
      share: raw.hits ? (site.hits / raw.hits) * 100 : 0,
      at: site.at
    };
  });

  const kinds = [...byKind.values()]
    .map((group) => Object.assign(group, { share: raw.hits ? (group.hits / raw.hits) * 100 : 0 }))
    .sort((a, b) => b.hits - a.hits);

  const apps = [...byApp.values()]
    .map((entry) => Object.assign(entry, { share: raw.hits ? (entry.hits / raw.hits) * 100 : 0 }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 60);

  /* names come from sniffing; without it the log holds addresses and nothing
     else, which is worth saying rather than leaving the admin to wonder */
  const inbound = d.inbounds.find((i) => i.id === client.inboundId);
  const sniffing = inbound ? inbound.sniffing !== false : true;

  res.json({
    apps,
    sites: sites.slice(0, 120),
    kinds,
    labels,
    hits: raw.hits,
    hostCount: raw.sites.length,
    since: raw.since,
    sniffing,
    used: (client.up || 0) + (client.down || 0)
  });
});

/** Start this client's site history over. */
router.post('/clients/:id/forget-sites', (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client) return bad(res, 'client not found', 404);
  const cleared = online.forgetSites(xray.clientTag(client));
  logEvent('client', `cleared the site history for ${client.email} (${cleared} host(s))`);
  res.json({ ok: true, cleared });
});

/** Start this client's address list over, after the admin has seen it. */
router.post('/clients/:id/forget-ips', (req, res) => {
  const client = db.data.clients.find((c) => c.id === req.params.id);
  if (!client || !owns(req, client)) return bad(res, 'client not found', 404);
  const cleared = online.forget(xray.clientTag(client));
  logEvent('client', `cleared ${cleared} recorded address(es) for ${client.email}`);
  res.json({ ok: true, cleared });
});

/** Is the address tracking actually working? The Clients page says so. */
router.get('/online/status', (req, res) => res.json(online.status()));

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

/* ------------------------------- outbounds ------------------------------ */

/** direct and blocked are generated by the panel and may not be redefined. */
const RESERVED_TAGS = ['api', 'direct', 'blocked'];

function normalizeOutbound(body, existing) {
  return Object.assign({}, existing || {}, {
    tag: String(body.tag ?? existing?.tag ?? '').trim(),
    protocol: body.protocol || existing?.protocol || 'freedom',
    address: body.address ?? existing?.address ?? '',
    port: Number(body.port ?? existing?.port ?? 0),
    uuid: body.uuid ?? existing?.uuid ?? '',
    password: body.password ?? existing?.password ?? '',
    username: body.username ?? existing?.username ?? '',
    method: body.method ?? existing?.method ?? 'aes-256-gcm',
    encryption: body.encryption ?? existing?.encryption ?? 'auto',
    flow: body.flow ?? existing?.flow ?? '',
    uot: body.uot ?? existing?.uot ?? false,
    domainStrategy: body.domainStrategy ?? existing?.domainStrategy ?? 'AsIs',
    redirect: body.redirect ?? existing?.redirect ?? '',
    blackholeResponse: body.blackholeResponse ?? existing?.blackholeResponse ?? 'none',
    network: body.network || existing?.network || 'tcp',
    security: body.security || existing?.security || 'none',
    wsPath: body.wsPath ?? existing?.wsPath ?? '/',
    wsHost: body.wsHost ?? existing?.wsHost ?? '',
    grpcServiceName: body.grpcServiceName ?? existing?.grpcServiceName ?? '',
    sni: body.sni ?? existing?.sni ?? '',
    fingerprint: body.fingerprint ?? existing?.fingerprint ?? 'chrome',
    allowInsecure: body.allowInsecure ?? existing?.allowInsecure ?? false,
    alpn: Array.isArray(body.alpn) ? body.alpn : (existing?.alpn ?? []),
    xhttpMode: body.xhttpMode ?? existing?.xhttpMode ?? 'auto',
    grpcMultiMode: body.grpcMultiMode ?? existing?.grpcMultiMode ?? false,
    kcpSeed: body.kcpSeed ?? existing?.kcpSeed ?? '',
    kcpHeader: body.kcpHeader ?? existing?.kcpHeader ?? 'none',
    /* the peer's REALITY details - a public key and one short id, which is the
       client's half of what the inbound on the other server holds */
    realityPublicKey: body.realityPublicKey ?? existing?.realityPublicKey ?? '',
    realityShortId: body.realityShortId ?? existing?.realityShortId ?? '',
    realitySpiderX: body.realitySpiderX ?? existing?.realitySpiderX ?? '/',
    wgPrivateKey: body.wgPrivateKey ?? existing?.wgPrivateKey ?? '',
    wgPeerPublicKey: body.wgPeerPublicKey ?? existing?.wgPeerPublicKey ?? '',
    wgPreSharedKey: body.wgPreSharedKey ?? existing?.wgPreSharedKey ?? '',
    wgMtu: Number(body.wgMtu ?? existing?.wgMtu ?? 1420),
    wgAddress: Array.isArray(body.wgAddress)
      ? body.wgAddress
      : (body.wgAddress !== undefined
        ? String(body.wgAddress).split(',').map((s) => s.trim()).filter(Boolean)
        : (existing?.wgAddress ?? ['10.0.0.2/32'])),
    enable: body.enable ?? existing?.enable ?? true
  });
}

function validateOutbound(out, selfId) {
  if (!out.tag) return 'a tag is required';
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(out.tag)) {
    return 'the tag may contain only letters, digits, dots, dashes and underscores';
  }
  if (RESERVED_TAGS.includes(out.tag)) return `"${out.tag}" is a reserved tag`;
  if (db.data.outbounds.some((o) => o.id !== selfId && o.tag === out.tag)) {
    return `an outbound tagged "${out.tag}" already exists`;
  }
  if (!xray.OUTBOUND_PROTOCOLS.includes(out.protocol)) return `unsupported protocol "${out.protocol}"`;
  const needsServer = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'wireguard'];
  if (needsServer.includes(out.protocol)) {
    if (!out.address) return 'a server address is required';
    if (!out.port || out.port < 1 || out.port > 65535) return 'port must be between 1 and 65535';
  }
  if ((out.protocol === 'vless' || out.protocol === 'vmess') && !out.uuid) return 'a UUID is required';
  if (out.protocol === 'trojan' && !out.password) return 'a password is required';
  return null;
}

router.get('/outbounds', (req, res) => res.json(db.data.outbounds));

/**
 * Read a config from the other server and turn it into an outbound here.
 *
 * Chaining two servers is the reason this exists: the far server hands out a
 * link for one of its clients, and that link carries every field this end
 * needs to dial it - including the REALITY public key and short id, which are
 * the two things nobody gets right by hand.
 */
router.post('/outbounds/import', (req, res) => {
  const text = String((req.body || {}).text || '');
  let parsed;
  try { parsed = parselink.parseShareLink(text); } catch (err) { return bad(res, err.message); }

  /* a tag from the link's own name, made safe and made unique */
  const base = (parsed.remark || `${parsed.protocol}-${parsed.address}`)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'proxy';
  let tag = base;
  let n = 2;
  while (knownTags().includes(tag)) tag = `${base}-${n++}`;

  delete parsed.remark;
  res.json(Object.assign({ tag }, parsed));
});

/**
 * Try this outbound for real and say how long it took.
 *
 * The outbound is tested as it is stored, whether or not it has been saved,
 * so a chain can be proved before it is committed to.
 */
router.post('/outbounds/test', async (req, res) => {
  const body = req.body || {};
  const stored = body.id ? (db.data.outbounds || []).find((o) => o.id === body.id) : null;
  const draft = stored || normalizeOutbound(body, null);
  if (!draft.protocol) return bad(res, 'nothing to test');

  const rendered = xray.outboundConfig(draft);
  if (!rendered) return bad(res, `the panel cannot build a ${draft.protocol} outbound`);

  const result = await probe.testOutbound(rendered, { address: draft.address, port: draft.port });
  if (result.ok) logEvent('outbound', `tested ${draft.tag}: ${result.ms} ms`);
  res.json(result);
});

router.post('/outbounds', async (req, res) => {
  const out = normalizeOutbound(req.body || {}, null);
  const problem = validateOutbound(out, null);
  if (problem) return bad(res, problem);
  out.id = db.id();
  out.createdAt = Date.now();
  db.data.outbounds.push(out);
  db.saveNow();

  const applied = await xray.apply();
  if (!applied.ok) {
    db.data.outbounds = db.data.outbounds.filter((o) => o.id !== out.id);
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('outbound', `created ${out.protocol} outbound "${out.tag}"`);
  res.json(out);
});

router.put('/outbounds/:id', async (req, res) => {
  const d = db.data;
  const idx = d.outbounds.findIndex((o) => o.id === req.params.id);
  if (idx < 0) return bad(res, 'outbound not found', 404);
  const before = d.outbounds[idx];
  const updated = normalizeOutbound(req.body || {}, before);
  updated.id = before.id;
  const problem = validateOutbound(updated, before.id);
  if (problem) return bad(res, problem);

  d.outbounds[idx] = updated;
  db.saveNow();
  const applied = await xray.apply();
  if (!applied.ok) {
    d.outbounds[idx] = before;
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('outbound', `updated outbound "${updated.tag}"`);
  res.json(updated);
});

router.delete('/outbounds/:id', async (req, res) => {
  const d = db.data;
  const out = d.outbounds.find((o) => o.id === req.params.id);
  if (!out) return bad(res, 'outbound not found', 404);
  const used = d.routing.filter((r) => r.outboundTag === out.tag);
  if (used.length) {
    return bad(res, `"${out.tag}" is still used by ${used.length} routing rule(s)`);
  }
  d.outbounds = d.outbounds.filter((o) => o.id !== out.id);
  if (d.settings.defaultOutbound === out.tag) d.settings.defaultOutbound = 'direct';
  db.saveNow();
  await xray.apply();
  logEvent('outbound', `deleted outbound "${out.tag}"`);
  res.json({ ok: true });
});

router.post('/outbounds/:id/toggle', async (req, res) => {
  const out = db.data.outbounds.find((o) => o.id === req.params.id);
  if (!out) return bad(res, 'outbound not found', 404);
  out.enable = out.enable === false;
  db.saveNow();
  await xray.apply();
  res.json(out);
});

/* -------------------------------- routing ------------------------------- */

function normalizeRule(body, existing) {
  const text = (value, fallback) => (value === undefined ? fallback : String(value).trim());
  return Object.assign({}, existing || {}, {
    name: text(body.name, existing?.name ?? 'rule'),
    outboundTag: text(body.outboundTag, existing?.outboundTag ?? 'direct'),
    domain: text(body.domain, existing?.domain ?? ''),
    ip: text(body.ip, existing?.ip ?? ''),
    port: text(body.port, existing?.port ?? ''),
    sourcePort: text(body.sourcePort, existing?.sourcePort ?? ''),
    network: text(body.network, existing?.network ?? ''),
    protocol: text(body.protocol, existing?.protocol ?? ''),
    source: text(body.source, existing?.source ?? ''),
    user: text(body.user, existing?.user ?? ''),
    inboundTag: text(body.inboundTag, existing?.inboundTag ?? ''),
    enable: body.enable ?? existing?.enable ?? true
  });
}

function knownTags() {
  return ['direct', 'blocked'].concat(db.data.outbounds.map((o) => o.tag));
}

function validateRule(rule) {
  if (!knownTags().includes(rule.outboundTag)) {
    return `unknown outbound "${rule.outboundTag}"`;
  }
  const conditions = ['domain', 'ip', 'port', 'sourcePort', 'network', 'protocol', 'source', 'user', 'inboundTag'];
  if (!conditions.some((key) => rule[key])) {
    return 'a rule needs at least one condition, otherwise it would match every connection';
  }
  return null;
}

router.get('/routing', (req, res) => res.json({
  rules: db.data.routing,
  outboundTags: knownTags(),
  /* the rule editor offers these rather than asking the admin to remember and
     retype a tag that is generated - getting one character wrong there made a
     rule that silently never matched */
  inboundTags: (db.data.inbounds || []).map((i) => ({
    tag: i.tag,
    label: `${i.remark || i.tag} · ${i.protocol}:${i.port}`
  })),
  defaultOutbound: db.settings.defaultOutbound || 'direct',
  domainStrategy: db.settings.domainStrategy || 'AsIs'
}));

router.post('/routing', async (req, res) => {
  const rule = normalizeRule(req.body || {}, null);
  const problem = validateRule(rule);
  if (problem) return bad(res, problem);
  rule.id = db.id();
  rule.createdAt = Date.now();
  db.data.routing.push(rule);
  db.saveNow();

  const applied = await xray.apply();
  if (!applied.ok) {
    db.data.routing = db.data.routing.filter((r) => r.id !== rule.id);
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('routing', `added rule "${rule.name}" to ${rule.outboundTag}`);
  res.json(rule);
});

router.put('/routing/:id', async (req, res) => {
  const d = db.data;
  const idx = d.routing.findIndex((r) => r.id === req.params.id);
  if (idx < 0) return bad(res, 'rule not found', 404);
  const before = d.routing[idx];
  const updated = normalizeRule(req.body || {}, before);
  updated.id = before.id;
  const problem = validateRule(updated);
  if (problem) return bad(res, problem);

  d.routing[idx] = updated;
  db.saveNow();
  const applied = await xray.apply();
  if (!applied.ok) {
    d.routing[idx] = before;
    db.saveNow();
    await xray.apply();
    return bad(res, applied.error);
  }
  logEvent('routing', `updated rule "${updated.name}"`);
  res.json(updated);
});

router.delete('/routing/:id', async (req, res) => {
  const d = db.data;
  const rule = d.routing.find((r) => r.id === req.params.id);
  if (!rule) return bad(res, 'rule not found', 404);
  d.routing = d.routing.filter((r) => r.id !== rule.id);
  db.saveNow();
  await xray.apply();
  logEvent('routing', `deleted rule "${rule.name}"`);
  res.json({ ok: true });
});

router.post('/routing/:id/toggle', async (req, res) => {
  const rule = db.data.routing.find((r) => r.id === req.params.id);
  if (!rule) return bad(res, 'rule not found', 404);
  rule.enable = rule.enable === false;
  db.saveNow();
  await xray.apply();
  res.json(rule);
});

/** Rules are evaluated top to bottom, so their order is part of the config. */
router.post('/routing/reorder', async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return bad(res, 'an array of rule ids is required');
  const d = db.data;
  const byId = new Map(d.routing.map((r) => [r.id, r]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== d.routing.length) return bad(res, 'the list must contain every rule exactly once');
  d.routing = reordered;
  db.saveNow();
  await xray.apply();
  res.json({ ok: true });
});

/* ------------------------------- settings ------------------------------- */

router.get('/settings', (req, res) => {
  const s = Object.assign({}, db.settings);
  delete s.sessionSecret;
  s.remarkTemplate = s.remarkTemplate || links.DEFAULT_REMARK;
  s.remarkTokens = links.REMARK_TOKENS;
  res.json(s);
});

/*
 * What a template would actually name things, run against a real client so the
 * admin sees their own data rather than a made-up example. The rendering lives
 * on the server because the links do: a preview drawn in the browser would be
 * a second implementation, free to drift from the one that counts.
 */
router.post('/settings/remark-preview', (req, res) => {
  const template = String((req.body || {}).template || '');
  const d = db.data;

  const client = d.clients.find((c) => c.inboundId && d.inbounds.some((i) => i.id === c.inboundId))
    || d.clients[0];
  const inbound = (client && d.inbounds.find((i) => i.id === client.inboundId)) || d.inbounds[0];

  /* nothing to draw on yet: show the shape with a stand-in */
  const sampleInbound = inbound || { remark: 'Main', protocol: 'vless', port: 443 };
  const sampleClient = client || {
    email: 'sample', up: 700 * 1024 ** 2, down: 800 * 1024 ** 2,
    totalGB: 10, expiryTime: Date.now() + 30 * 86400000
  };

  res.json({
    preview: links.remarkFor(sampleInbound, sampleClient, template),
    from: client ? client.email : '',
    sample: !client
  });
});

router.put('/settings', async (req, res) => {
  const allowed = ['panelPort', 'webBasePath', 'domain', 'subDomain', 'subPort', 'subPath',
    'tgBotToken', 'tgAdminId', 'theme', 'lang', 'certFile', 'keyFile', 'xrayLogLevel',
    'blockTorrent', 'serverIP', 'trafficResetDay', 'defaultOutbound', 'domainStrategy', 'trackIps',
    'subTitle', 'panelCertFile', 'panelKeyFile', 'httpRedirect', 'remarkTemplate'];
  // TLS material is read once when the listener is created
  const restartKeys = ['panelPort', 'panelCertFile', 'panelKeyFile', 'certFile', 'keyFile', 'httpRedirect'];
  const s = db.settings;
  let restartNeeded = false;

  if (req.body.webBasePath !== undefined) {
    const clean = String(req.body.webBasePath).trim().replace(/^\/+|\/+$/g, '');
    if (clean && !/^[A-Za-z0-9_\-/]{1,64}$/.test(clean)) {
      return bad(res, 'the panel path may contain only letters, digits, dashes, underscores and slashes');
    }
    const reserved = ['api', 'sub', 'login', 'assets'];
    if (reserved.includes(clean.split('/')[0])) {
      return bad(res, `"${clean}" is a reserved path; choose another one`);
    }
    req.body.webBasePath = clean ? `/${clean}` : '';
  }

  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    if (restartKeys.includes(key) && String(req.body[key]) !== String(s[key] ?? '')) restartNeeded = true;
    s[key] = req.body[key];
  }
  if (s.subPath && !s.subPath.startsWith('/')) s.subPath = `/${s.subPath}`;
  db.saveNow();
  const webBasePath = s.webBasePath || '';
  await xray.apply();
  logEvent('settings', 'panel settings updated');
  res.json({ ok: true, restartNeeded, webBasePath });
});

/* ---------------------------- reseller panels ---------------------------- */

/** Only the leader may look at any of this. */
function leaderOnly(req, res, next) {
  if (req.reseller) return bad(res, 'not available on this panel', 403);
  next();
}

router.get('/admins', leaderOnly, (req, res) => {
  res.json({
    admins: resellers.all().map(resellers.summary),
    codes: resellers.codes().slice(0, 200),
    defaultPricePerGB: resellers.DEFAULT_PRICE_PER_GB,
    inbounds: db.data.inbounds.map((i) => ({ id: i.id, label: `${i.remark} · ${i.protocol}:${i.port}` }))
  });
});

/** A password the leader can hand over without inventing one. */
router.get('/admins/suggest-password', leaderOnly, (req, res) => {
  res.json({ password: resellers.suggestPassword() });
});

/** Everything the leader could want about one of their people. */
router.get('/admins/:id', leaderOnly, (req, res) => {
  const reseller = resellers.byId(req.params.id);
  if (!reseller) return bad(res, 'not found', 404);
  const clients = resellers.clientsOf(reseller);
  res.json({
    admin: resellers.summary(reseller),
    loginPath: `/${reseller.slug}/`,
    ledger: (reseller.ledger || []).slice(0, 100),
    codes: resellers.codes().filter((c) => c.resellerId === reseller.id),
    clients: clients.map((c) => ({
      id: c.id, email: c.email, totalGB: c.totalGB || 0,
      up: c.up || 0, down: c.down || 0,
      expiryTime: c.expiryTime || 0, expiryDays: c.expiryDays || 0,
      startAfterFirstUse: !!c.startAfterFirstUse,
      enable: c.enable !== false, createdAt: c.createdAt || 0
    }))
  });
});

router.post('/admins', leaderOnly, async (req, res) => {
  const body = req.body || {};
  if (!String(body.name || '').trim()) return bad(res, 'give this panel a name');
  const reseller = resellers.create(body);

  /* the leader may set the sign-in here and hand over a username and password
     instead of an address that makes its own account */
  if (String(body.username || '').trim() || body.password) {
    const made = await resellers.setCredentials(reseller, {
      username: body.username, password: body.password
    });
    if (!made.ok) {
      resellers.remove(reseller.id);           // no half-made panel left behind
      return bad(res, made.error);
    }
  }
  logEvent('admin', `created the reseller panel "${reseller.name}"`);
  res.json(resellers.summary(reseller));
});

/**
 * The leader setting, renaming or resetting what a reseller signs in with.
 *
 * There is no reading a password back - it is a bcrypt hash and nothing else -
 * so this is how a forgotten one is dealt with: set a new one and hand it over.
 */
router.post('/admins/:id/credentials', leaderOnly, async (req, res) => {
  const reseller = resellers.byId(req.params.id);
  if (!reseller) return bad(res, 'not found', 404);
  const body = req.body || {};
  const result = await resellers.setCredentials(reseller, {
    username: body.username, password: body.password
  });
  if (!result.ok) return bad(res, result.error);

  const what = result.created ? 'made the account for'
    : result.passwordChanged ? 'set a new password for' : 'renamed the account of';
  logEvent('admin', `${what} the reseller panel "${reseller.name}"`);
  res.json({ ok: true, ...result, admin: resellers.summary(reseller) });
});

/** Throw the account away: the address goes back to making its own. */
router.delete('/admins/:id/credentials', leaderOnly, (req, res) => {
  const reseller = resellers.byId(req.params.id);
  if (!reseller) return bad(res, 'not found', 404);
  if (!resellers.clearCredentials(reseller)) return bad(res, 'this panel has no account yet');
  logEvent('admin', `removed the account of "${reseller.name}" - the address will make a new one`);
  res.json({ ok: true, admin: resellers.summary(reseller) });
});


router.put('/admins/:id', leaderOnly, (req, res) => {
  const reseller = resellers.byId(req.params.id);
  if (!reseller) return bad(res, 'not found', 404);
  const body = req.body || {};
  if (body.name !== undefined) reseller.name = String(body.name).trim() || reseller.name;
  if (body.note !== undefined) reseller.note = String(body.note);
  if (body.inboundId !== undefined) reseller.inboundId = String(body.inboundId);
  if (body.pricePerGB !== undefined) reseller.pricePerGB = Math.max(0, Number(body.pricePerGB) || 0);
  if (body.enable !== undefined) reseller.enable = !!body.enable;
  db.saveNow();
  logEvent('admin', `updated the reseller panel "${reseller.name}"`);
  res.json(resellers.summary(reseller));
});

router.delete('/admins/:id', leaderOnly, (req, res) => {
  const reseller = resellers.remove(req.params.id);
  if (!reseller) return bad(res, 'not found', 404);
  logEvent('admin', `deleted the reseller panel "${reseller.name}" - their clients are kept`);
  res.json({ ok: true });
});

/** Money in or out by hand, for when somebody paid outside the codes. */
router.post('/admins/:id/balance', leaderOnly, (req, res) => {
  const reseller = resellers.byId(req.params.id);
  if (!reseller) return bad(res, 'not found', 404);
  const amount = Math.round(Number((req.body || {}).amount) || 0);
  if (!amount) return bad(res, 'give an amount - a positive one to add, a negative one to take back');
  const balance = resellers.adjust(reseller, amount, String((req.body || {}).reason || 'adjusted by the leader'));
  logEvent('admin', `${amount > 0 ? 'credited' : 'debited'} ${Math.abs(amount)} to ${reseller.name}`);
  res.json({ ok: true, balance });
});

/** A code worth money: tied to one panel, or loose as a gift. */
router.post('/admins/codes', leaderOnly, (req, res) => {
  const body = req.body || {};
  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) return bad(res, 'a code has to be worth something');
  const code = resellers.issueCode(body);
  logEvent('admin', `issued a code worth ${amount}${body.resellerId ? '' : ' (gift, anyone may use it)'}`);
  res.json(code);
});

router.delete('/admins/codes/:id', leaderOnly, (req, res) => {
  const before = resellers.codes().length;
  db.data.codes = resellers.codes().filter((c) => c.id !== req.params.id);
  if (db.data.codes.length === before) return bad(res, 'not found', 404);
  db.saveNow();
  res.json({ ok: true });
});

/** The reseller's own end of it: type the code in, get the balance. */
router.post('/wallet/redeem', (req, res) => {
  if (!req.reseller) return bad(res, 'not available on this panel', 403);
  const result = resellers.redeem(req.reseller, (req.body || {}).code);
  if (!result.ok) return bad(res, result.error);
  logEvent('admin', `${req.reseller.name} redeemed a code worth ${result.amount}`);
  res.json(result);
});

/** Their bot, in their own file, never the leader's. */
router.get('/reseller/bot', (req, res) => {
  if (!req.reseller) return bad(res, 'not available on this panel', 403);
  const stored = resellers.readBot(req.reseller) || {};
  res.json({
    brand: stored.brand || req.reseller.name,
    currency: stored.currency || 'تومان',
    adminId: stored.adminId || '',
    hasToken: !!stored.token,
    plans: stored.plans || [],
    live: false
  });
});

router.put('/reseller/bot', (req, res) => {
  if (!req.reseller) return bad(res, 'not available on this panel', 403);
  const body = req.body || {};
  const stored = resellers.readBot(req.reseller) || {};
  if (typeof body.token === 'string' && body.token.trim()) stored.token = body.token.trim();
  if (body.brand !== undefined) stored.brand = String(body.brand).slice(0, 40);
  if (body.currency !== undefined) stored.currency = String(body.currency).slice(0, 16);
  if (body.adminId !== undefined) stored.adminId = String(body.adminId).trim();
  if (Array.isArray(body.plans)) stored.plans = body.plans;
  stored.updatedAt = Date.now();
  resellers.writeBot(req.reseller, stored);
  res.json({ ok: true });
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
  d.outbounds = Array.isArray(incoming.outbounds) ? incoming.outbounds : [];
  d.routing = Array.isArray(incoming.routing) ? incoming.routing : [];
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

// eslint-disable-next-line no-unused-vars -- express needs the 4-argument shape
router.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: err.message || 'the panel hit an unexpected error' });
});

module.exports = router;
module.exports.subUrl = subUrl;
module.exports.createClient = createClient;
