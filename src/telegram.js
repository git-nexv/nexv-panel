'use strict';
/**
 * The panel's Telegram bot.
 *
 * It long-polls getUpdates rather than taking a webhook, so it needs no public
 * URL, no certificate and no open port - it works from behind any NAT. The bot
 * itself is data: a list of screens, each with text and rows of inline
 * buttons, kept in the panel's database and edited in the Bot page. This file
 * only walks that structure and talks to Telegram.
 */
const https = require('https');
const db = require('./db');

/* A mirror can be set when api.telegram.org itself is filtered on the server. */
const [API_HOST, API_PORT] = String(process.env.NEXV_TG_API || 'api.telegram.org').split(':');

const runtime = {
  running: false,
  stopping: false,
  offset: 0,
  me: null,
  error: '',
  startedAt: 0,
  sent: 0,
  seen: 0
};

/** Per-chat breadcrumb, so a Back button knows where it came from. */
const trail = new Map();

function bot() {
  const d = db.data;
  if (!d.bot) d.bot = defaults();
  return d.bot;
}

function defaults() {
  return {
    enabled: false,
    token: '',
    adminId: '',
    adminChatId: '',
    brand: 'NexV',
    currency: 'Toman',
    screens: starterScreens(),
    plans: [],
    orders: [],
    ai: { apiKey: '', model: '' }
  };
}

/** What a brand-new bot says before anyone has edited it. */
function starterScreens() {
  return [
    {
      key: 'start',
      title: 'Welcome',
      text: 'Hello {name} 👋\n\nWelcome to {brand}. Pick something below.',
      buttons: [
        [{ label: '🛒 Buy a plan', action: 'plans' }],
        [{ label: '🔑 My configs', action: 'configs' }, { label: '📊 My usage', action: 'usage' }],
        [{ label: '💬 Support', action: 'support' }]
      ]
    },
    {
      key: 'support',
      title: 'Support',
      text: 'Send your question to {admin} and we will answer shortly.',
      buttons: [[{ label: '⬅️ Back', action: 'screen', value: 'start' }]]
    }
  ];
}

/* ------------------------------ Telegram API ----------------------------- */

function call(method, payload, token) {
  const body = JSON.stringify(payload || {});
  const key = token || bot().token;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST,
      port: API_PORT ? Number(API_PORT) : 443,
      path: `/bot${key}/${method}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 40000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { return reject(new Error('Telegram sent something that is not JSON')); }
        if (!parsed.ok) return reject(new Error(parsed.description || `Telegram refused ${method}`));
        resolve(parsed.result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Check a token without starting anything: the Bot page's Test button. */
async function whoAmI(token) {
  return call('getMe', {}, token);
}

function send(chatId, text, keyboard) {
  runtime.sent++;
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
  }).catch((err) => { runtime.error = err.message; });
}

function edit(chatId, messageId, text, keyboard) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
  }).catch(() => send(chatId, text, keyboard));
}

/* -------------------------------- helpers -------------------------------- */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function adminHandle() {
  const id = bot().adminId || '';
  return /^\d+$/.test(id) ? 'the admin' : (id || 'the admin');
}

function isAdmin(from) {
  const id = String(bot().adminId || '').trim();
  if (!id) return false;
  if (/^\d+$/.test(id)) return String(from.id) === id;
  return `@${String(from.username || '').toLowerCase()}` === id.toLowerCase();
}

/** Text placeholders, so a screen can greet by name and quote real numbers. */
function fill(text, ctx) {
  const b = bot();
  return String(text || '')
    .replace(/{name}/g, escapeHtml(ctx.name || 'there'))
    .replace(/{brand}/g, escapeHtml(b.brand || 'NexV'))
    .replace(/{admin}/g, escapeHtml(adminHandle()))
    .replace(/{id}/g, String(ctx.userId || ''));
}

function screenByKey(key) {
  return bot().screens.find((s) => s.key === key);
}

/** One screen's inline keyboard, as Telegram wants it. */
function keyboardFor(screen) {
  const rows = Array.isArray(screen.buttons) ? screen.buttons : [];
  return rows
    .map((row) => (Array.isArray(row) ? row : [row])
      .filter((btn) => btn && btn.label)
      .map((btn) => (btn.action === 'url'
        ? { text: btn.label, url: btn.value || 'https://t.me' }
        : { text: btn.label, callback_data: `b:${btn.action}:${btn.value || ''}`.slice(0, 64) })))
    .filter((row) => row.length);
}

function clientsOf(userId) {
  return db.data.clients.filter((c) => String(c.tgId || '') === String(userId));
}

/* ------------------------------- the actions ----------------------------- */

async function showScreen(ctx, key) {
  const screen = screenByKey(key) || screenByKey('start');
  if (!screen) return reply(ctx, 'This bot has no screens yet.');
  trail.set(ctx.chatId, key);
  return reply(ctx, fill(screen.text, ctx), keyboardFor(screen));
}

async function showPlans(ctx) {
  const b = bot();
  const plans = b.plans.filter((p) => p.enable !== false);
  if (!plans.length) return reply(ctx, 'No plans are on sale yet.', backRow());
  const rows = plans.map((p) => ([{
    text: `${p.name} — ${p.gb ? `${p.gb} GB` : 'unlimited'} / ${p.days} days · ${p.price} ${b.currency}`,
    callback_data: `b:buy:${p.id}`
  }]));
  rows.push(backRow()[0]);
  return reply(ctx, '<b>Plans</b>\nPick the one you want:', rows);
}

async function showConfigs(ctx) {
  const mine = clientsOf(ctx.userId);
  if (!mine.length) {
    return reply(ctx, 'No config is linked to your account yet. Buy a plan, or ask the admin to link one.', backRow());
  }
  const subUrl = require('./routes/api').subUrl;
  const lines = mine.map((c) => {
    const inb = db.data.inbounds.find((i) => i.id === c.inboundId);
    return `<b>${escapeHtml(c.email)}</b>${inb ? ` · ${escapeHtml(inb.remark)}` : ''}\n<code>${escapeHtml(subUrl(c.subId))}</code>`;
  });
  return reply(ctx, `<b>Your configs</b>\n\n${lines.join('\n\n')}\n\nPaste the link into your app as a subscription.`, backRow());
}

async function showUsage(ctx) {
  const mine = clientsOf(ctx.userId);
  if (!mine.length) return reply(ctx, 'Nothing is linked to your account yet.', backRow());
  const lines = mine.map((c) => {
    const used = (c.up || 0) + (c.down || 0);
    const quota = (c.totalGB || 0) * 1024 ** 3;
    const left = c.expiryTime ? Math.ceil((c.expiryTime - Date.now()) / 86400000) : null;
    return [
      `<b>${escapeHtml(c.email)}</b>`,
      `Used: ${bytes(used)}${quota ? ` of ${bytes(quota)}` : ' (unlimited)'}`,
      left === null ? 'Never expires' : (left > 0 ? `${left} days left` : 'Expired')
    ].join('\n');
  });
  return reply(ctx, lines.join('\n\n'), backRow());
}

function backRow() {
  return [[{ text: '⬅️ Back', callback_data: 'b:screen:start' }]];
}

/** A purchase request: the buyer waits, the admin gets a card to act on. */
async function placeOrder(ctx, planId) {
  const b = bot();
  const plan = b.plans.find((p) => p.id === planId);
  if (!plan) return reply(ctx, 'That plan is gone.', backRow());

  const order = {
    id: db.id(),
    at: Date.now(),
    planId: plan.id,
    planName: plan.name,
    userId: ctx.userId,
    username: ctx.username || '',
    name: ctx.name || '',
    status: 'pending'
  };
  b.orders.unshift(order);
  if (b.orders.length > 500) b.orders.length = 500;
  db.saveNow();

  await reply(ctx, [
    `<b>${escapeHtml(plan.name)}</b>`,
    `${plan.gb ? `${plan.gb} GB` : 'Unlimited'} · ${plan.days} days · ${plan.price} ${b.currency}`,
    '',
    'Your request is with the admin. You will get your config here once it is approved.'
  ].join('\n'), backRow());

  const admin = b.adminChatId || (/^\d+$/.test(b.adminId || '') ? b.adminId : '');
  if (!admin) return;
  await send(admin, [
    '<b>New order</b>',
    `Plan: ${escapeHtml(plan.name)} — ${plan.gb ? `${plan.gb} GB` : 'unlimited'} / ${plan.days} days`,
    `Price: ${plan.price} ${b.currency}`,
    `From: ${escapeHtml(ctx.name || '')} ${ctx.username ? `(@${escapeHtml(ctx.username)})` : ''}`,
    `Telegram id: <code>${ctx.userId}</code>`
  ].join('\n'), [[
    { text: '✅ Approve', callback_data: `b:ok:${order.id}` },
    { text: '✖️ Reject', callback_data: `b:no:${order.id}` }
  ]]);
}

/** The admin approved: cut a real client on the plan's inbound and deliver it. */
async function approveOrder(ctx, orderId) {
  const b = bot();
  const order = b.orders.find((o) => o.id === orderId);
  if (!order) return reply(ctx, 'That order is gone.');
  if (order.status !== 'pending') return reply(ctx, `That order is already ${order.status}.`);

  const plan = b.plans.find((p) => p.id === order.planId);
  const inbound = db.data.inbounds.find((i) => i.id === (plan && plan.inboundId));
  if (!plan || !inbound) {
    order.status = 'failed';
    db.saveNow();
    return reply(ctx, 'The plan or its inbound is missing - fix it in the panel and ask the buyer to order again.');
  }

  let client;
  try {
    client = await require('./routes/api').createClient(inbound, {
      email: `tg-${order.userId}-${String(order.id).slice(0, 4)}`,
      totalGB: plan.gb || 0,
      expiryTime: plan.days ? Date.now() + plan.days * 86400000 : 0,
      tgId: String(order.userId),
      comment: `${plan.name} sold by bot`
    });
  } catch (err) {
    order.status = 'failed';
    order.error = err.message;
    db.saveNow();
    return reply(ctx, `Could not create the client: ${escapeHtml(err.message)}`);
  }

  order.status = 'done';
  order.clientId = client.id;
  db.saveNow();

  const url = require('./routes/api').subUrl(client.subId);
  await send(order.userId, [
    '<b>Your plan is ready ✅</b>',
    `${escapeHtml(plan.name)} · ${plan.gb ? `${plan.gb} GB` : 'unlimited'} · ${plan.days} days`,
    '',
    'Subscription link:',
    `<code>${escapeHtml(url)}</code>`,
    '',
    'Add it to your app as a subscription and refresh whenever you need the latest servers.'
  ].join('\n'));
  return reply(ctx, `Approved. ${escapeHtml(client.email)} was created and sent to the buyer.`);
}

async function rejectOrder(ctx, orderId) {
  const order = bot().orders.find((o) => o.id === orderId);
  if (!order || order.status !== 'pending') return reply(ctx, 'Nothing to reject.');
  order.status = 'rejected';
  db.saveNow();
  await send(order.userId, 'Your order was not approved. Talk to the admin if you think this is a mistake.');
  return reply(ctx, 'Rejected, and the buyer has been told.');
}

/* ------------------------------ the dispatcher --------------------------- */

/** Answer in place when the tap came from a button, otherwise send anew. */
function reply(ctx, text, keyboard) {
  if (ctx.messageId) return edit(ctx.chatId, ctx.messageId, text, keyboard);
  return send(ctx.chatId, text, keyboard);
}

async function act(ctx, action, value) {
  switch (action) {
    case 'screen': return showScreen(ctx, value || 'start');
    case 'plans': return showPlans(ctx);
    case 'configs': return showConfigs(ctx);
    case 'usage': return showUsage(ctx);
    case 'support': {
      const screen = screenByKey('support');
      if (screen) return showScreen(ctx, 'support');
      return reply(ctx, `Message ${escapeHtml(adminHandle())}.`, backRow());
    }
    case 'buy': return placeOrder(ctx, value);
    case 'ok': return ctx.isAdmin ? approveOrder(ctx, value) : reply(ctx, 'Only the admin can do that.');
    case 'no': return ctx.isAdmin ? rejectOrder(ctx, value) : reply(ctx, 'Only the admin can do that.');
    case 'text': return reply(ctx, fill(value, ctx), backRow());
    default: return showScreen(ctx, 'start');
  }
}

async function handle(update) {
  runtime.seen++;
  const b = bot();

  if (update.message && update.message.text) {
    const from = update.message.from || {};
    const ctx = {
      chatId: update.message.chat.id,
      userId: from.id,
      username: from.username || '',
      name: from.first_name || from.username || '',
      isAdmin: isAdmin(from)
    };
    // remembering the admin's chat is what lets an @username admin be reached
    if (ctx.isAdmin && String(b.adminChatId) !== String(ctx.chatId)) {
      b.adminChatId = String(ctx.chatId);
      db.saveNow();
    }
    const text = update.message.text.trim();
    if (text === '/id') return send(ctx.chatId, `Your Telegram id is <code>${ctx.userId}</code>`);
    if (text === '/stats' && ctx.isAdmin) {
      const d = db.data;
      return send(ctx.chatId, [
        '<b>Panel</b>',
        `Inbounds: ${d.inbounds.length}`,
        `Clients: ${d.clients.length}`,
        `Orders waiting: ${b.orders.filter((o) => o.status === 'pending').length}`
      ].join('\n'));
    }
    const command = text.split(' ')[0].replace('/', '');
    const screen = screenByKey(command);
    return showScreen(ctx, screen ? screen.key : 'start');
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const from = query.from || {};
    const ctx = {
      chatId: query.message.chat.id,
      messageId: query.message.message_id,
      userId: from.id,
      username: from.username || '',
      name: from.first_name || from.username || '',
      isAdmin: isAdmin(from)
    };
    call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    const [, action, ...rest] = String(query.data || '').split(':');
    return act(ctx, action, rest.join(':'));
  }
  return null;
}

/* --------------------------------- polling ------------------------------- */

async function loop() {
  let backoff = 1000;
  while (!runtime.stopping) {
    try {
      const updates = await call('getUpdates', {
        offset: runtime.offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      backoff = 1000;
      runtime.error = '';
      for (const update of updates) {
        runtime.offset = update.update_id + 1;
        try { await handle(update); } catch (err) { runtime.error = err.message; }
      }
    } catch (err) {
      if (runtime.stopping) break;
      runtime.error = err.message;
      // a wrong token or a blocked network must not spin the CPU
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
  runtime.running = false;
}

async function start() {
  const b = bot();
  if (!b.token) throw new Error('set the bot token first');
  if (runtime.running) return status();
  runtime.me = await whoAmI(b.token);
  runtime.stopping = false;
  runtime.running = true;
  runtime.startedAt = Date.now();
  runtime.error = '';
  b.enabled = true;
  db.saveNow();
  loop();
  return status();
}

function stop() {
  runtime.stopping = true;
  runtime.running = false;
  const b = bot();
  b.enabled = false;
  db.saveNow();
  return status();
}

function status() {
  return {
    running: runtime.running,
    username: runtime.me ? runtime.me.username : '',
    error: runtime.error,
    startedAt: runtime.startedAt,
    updates: runtime.seen,
    sent: runtime.sent,
    pendingOrders: bot().orders.filter((o) => o.status === 'pending').length
  };
}

/** Bring the bot back up after a panel restart, if it was running before. */
function resume() {
  const b = bot();
  if (b.enabled && b.token) start().catch((err) => { runtime.error = err.message; });
}

module.exports = { bot, defaults, starterScreens, start, stop, status, whoAmI, resume, send, escapeHtml };
