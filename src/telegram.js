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
  if (!d.bot.pay) d.bot.pay = defaults().pay;
  return d.bot;
}

/*
 * The first bots shipped with an English starter. An install that never edited
 * those two screens gets the Persian ones instead; anything the admin touched
 * is left exactly as they left it.
 */
const ENGLISH_STARTER = JSON.stringify([
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
]);

function migrateStarter() {
  const b = bot();
  const current = JSON.stringify((b.screens || []).map((screen) => ({
    key: screen.key,
    title: screen.title,
    text: screen.text,
    buttons: (screen.buttons || []).map((row) => row.map((btn) => (btn.value
      ? { label: btn.label, action: btn.action, value: btn.value }
      : { label: btn.label, action: btn.action })))
  })));
  if (current !== ENGLISH_STARTER) return false;
  b.screens = starterScreens();
  db.saveNow();
  return true;
}

function defaults() {
  return {
    enabled: false,
    token: '',
    adminId: '',
    adminChatId: '',
    brand: 'NexV',
    currency: 'تومان',
    screens: starterScreens(),
    plans: [],
    orders: [],
    pay: {
      card: { enable: true, number: '', holder: '', note: '' },
      crypto: { enable: false, wallets: [] }
    },
    ai: { provider: 'anthropic', apiKey: '', model: '', baseUrl: '' }
  };
}

/** What a brand-new bot says before anyone has edited it. */
function starterScreens() {
  return [
    {
      key: 'start',
      title: 'خوش‌آمد',
      text: 'سلام {name} 👋\n\nبه {brand} خوش آمدید. یکی از گزینه‌های زیر را انتخاب کنید.',
      buttons: [
        [{ label: '🛒 خرید اشتراک', action: 'plans' }],
        [{ label: '🔑 کانفیگ‌های من', action: 'configs' }, { label: '📊 مصرف من', action: 'usage' }],
        [{ label: '💬 پشتیبانی', action: 'support' }]
      ]
    },
    {
      key: 'support',
      title: 'پشتیبانی',
      text: 'سوال خود را برای {admin} بفرستید، در اولین فرصت پاسخ می‌دهیم.',
      buttons: [[{ label: '⬅️ بازگشت', action: 'screen', value: 'start' }]]
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

function sendPhoto(chatId, fileId, caption, keyboard) {
  runtime.sent++;
  return call('sendPhoto', {
    chat_id: chatId,
    photo: fileId,
    caption,
    parse_mode: 'HTML',
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
  }).catch((err) => { runtime.error = err.message; });
}

function sendDocument(chatId, fileId, caption, keyboard) {
  runtime.sent++;
  return call('sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption,
    parse_mode: 'HTML',
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
  // a per-second rate is rarely a whole number, and 833.3333333333334 B/s
  // is not something anyone wants to read; rounding first also stops 1023.7
  // printing as "1024 B" instead of tipping over into KB
  if (Math.round(n) < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function adminHandle() {
  const id = bot().adminId || '';
  return /^\d+$/.test(id) ? 'پشتیبانی' : (id || 'پشتیبانی');
}

/** The chat orders and receipts are sent to, once it is known. */
function adminChat() {
  const b = bot();
  return b.adminChatId || (/^\d+$/.test(b.adminId || '') ? b.adminId : '');
}

/** Who the buyer is, spelled out for the admin: name, @username and id. */
function buyerLines(order) {
  return [
    `خریدار: ${escapeHtml(order.name || '-')}`,
    `یوزرنیم: ${order.username ? `@${escapeHtml(order.username)}` : 'ندارد'}`,
    `آیدی عددی: <code>${order.userId}</code>`
  ];
}

function planLine(plan) {
  const b = bot();
  return `${escapeHtml(plan.name)} — ${plan.gb ? `${plan.gb} گیگ` : 'نامحدود'} / ${plan.days} روز · ${plan.price} ${escapeHtml(b.currency)}`;
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
    .replace(/{name}/g, escapeHtml(ctx.name || 'دوست عزیز'))
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
  if (!plans.length) return reply(ctx, 'فعلاً اشتراکی برای فروش تعریف نشده است.', backRow());
  const rows = plans.map((p) => ([{ text: planLine(p).replace(/<[^>]+>/g, ''), callback_data: `b:buy:${p.id}` }]));
  rows.push(backRow()[0]);
  return reply(ctx, '<b>اشتراک‌ها</b>\nیکی را انتخاب کنید:', rows);
}

async function showConfigs(ctx) {
  const mine = clientsOf(ctx.userId);
  if (!mine.length) {
    return reply(ctx, 'هنوز کانفیگی به حساب شما وصل نشده است. یک اشتراک بخرید یا از پشتیبانی بخواهید کانفیگتان را وصل کند.', backRow());
  }
  const subUrl = require('./routes/api').subUrl;
  const lines = mine.map((c) => {
    const inb = db.data.inbounds.find((i) => i.id === c.inboundId);
    return `<b>${escapeHtml(c.email)}</b>${inb ? ` · ${escapeHtml(inb.remark)}` : ''}\n<code>${escapeHtml(subUrl(c.subId))}</code>`;
  });
  return reply(ctx, `<b>کانفیگ‌های شما</b>\n\n${lines.join('\n\n')}\n\nلینک را در برنامه‌تان به عنوان Subscription اضافه کنید.`, backRow());
}

async function showUsage(ctx) {
  const mine = clientsOf(ctx.userId);
  if (!mine.length) return reply(ctx, 'هنوز چیزی به حساب شما وصل نشده است.', backRow());
  const lines = mine.map((c) => {
    const used = (c.up || 0) + (c.down || 0);
    const quota = (c.totalGB || 0) * 1024 ** 3;
    const left = c.expiryTime ? Math.ceil((c.expiryTime - Date.now()) / 86400000) : null;
    return [
      `<b>${escapeHtml(c.email)}</b>`,
      `مصرف: ${bytes(used)}${quota ? ` از ${bytes(quota)}` : ' (نامحدود)'}`,
      left === null ? 'بدون تاریخ انقضا' : (left > 0 ? `${left} روز باقی مانده` : 'منقضی شده')
    ].join('\n');
  });
  return reply(ctx, lines.join('\n\n'), backRow());
}

function backRow() {
  return [[{ text: '⬅️ بازگشت', callback_data: 'b:screen:start' }]];
}

/* -------------------------------- payment -------------------------------- */

function payWays() {
  const pay = bot().pay || {};
  const ways = [];
  if (pay.card && pay.card.enable !== false && pay.card.number) ways.push('card');
  if (pay.crypto && pay.crypto.enable !== false && (pay.crypto.wallets || []).some((w) => w.address)) ways.push('crypto');
  return ways;
}

/** A purchase starts here: pick how to pay, or go straight there if only one way. */
async function placeOrder(ctx, planId) {
  const b = bot();
  const plan = b.plans.find((p) => p.id === planId);
  if (!plan) return reply(ctx, 'این اشتراک دیگر موجود نیست.', backRow());

  const order = {
    id: db.id(),
    at: Date.now(),
    planId: plan.id,
    planName: plan.name,
    price: plan.price,
    userId: ctx.userId,
    username: ctx.username || '',
    name: ctx.name || '',
    method: '',
    status: 'awaiting'
  };
  b.orders.unshift(order);
  if (b.orders.length > 500) b.orders.length = 500;
  db.saveNow();

  const ways = payWays();
  // nothing is configured to take money, so it goes straight to the admin
  if (!ways.length) return submitOrder(ctx, order, null);
  if (ways.length === 1) return showPayment(ctx, order, ways[0]);

  return reply(ctx, [
    `<b>${escapeHtml(plan.name)}</b>`,
    planLine(plan),
    '',
    'روش پرداخت را انتخاب کنید:'
  ].join('\n'), [
    [{ text: '💳 کارت به کارت', callback_data: `b:pay:${order.id}:card` }],
    [{ text: '🪙 ارز دیجیتال', callback_data: `b:pay:${order.id}:crypto` }],
    [{ text: '⬅️ بازگشت', callback_data: 'b:plans:' }]
  ]);
}

/** Show where to send the money, then wait for the receipt. */
async function showPayment(ctx, order, method) {
  const b = bot();
  const pay = b.pay || {};
  order.method = method;
  order.status = 'awaiting';
  db.saveNow();

  const lines = [
    `<b>${escapeHtml(order.planName)}</b>`,
    `مبلغ: <b>${escapeHtml(String(order.price))} ${escapeHtml(b.currency)}</b>`,
    ''
  ];

  if (method === 'card') {
    const card = pay.card || {};
    lines.push(
      '💳 <b>کارت به کارت</b>',
      `شماره کارت: <code>${escapeHtml(card.number)}</code>`,
      `به نام: ${escapeHtml(card.holder || '-')}`
    );
    if (card.note) lines.push('', escapeHtml(card.note));
    lines.push('', '📸 پس از واریز، <b>عکس رسید</b> را همینجا بفرستید تا بررسی شود.');
  } else {
    const crypto = pay.crypto || {};
    lines.push('🪙 <b>ارز دیجیتال</b>');
    for (const wallet of (crypto.wallets || []).filter((w) => w.address)) {
      lines.push(
        '',
        `${escapeHtml(wallet.asset || 'USDT')} — شبکه: <b>${escapeHtml(wallet.network || '-')}</b>`,
        `<code>${escapeHtml(wallet.address)}</code>`
      );
    }
    if (crypto.note) lines.push('', escapeHtml(crypto.note));
    lines.push('', '📸 پس از انتقال، <b>عکس رسید</b> یا <b>هش تراکنش</b> را همینجا بفرستید.');
  }

  return reply(ctx, lines.join('\n'), [
    [{ text: '✖️ انصراف', callback_data: `b:cancel:${order.id}` }]
  ]);
}

/** The order the buyer still owes a receipt for, if any. A day is long enough. */
function openOrder(userId) {
  return bot().orders.find((o) => String(o.userId) === String(userId)
    && o.status === 'awaiting'
    && Date.now() - o.at < 24 * 3600 * 1000);
}

/**
 * A receipt arrived - a photo, a file, or a transaction hash typed out. Pass it
 * to the admin with the buyer spelled out, and the buttons to settle it.
 */
async function takeReceipt(ctx, message) {
  const order = openOrder(ctx.userId);
  if (!order) return false;

  const b = bot();
  order.status = 'pending';
  order.receiptAt = Date.now();
  db.saveNow();

  await send(ctx.chatId, 'رسید شما دریافت شد ✅\nپس از تایید، کانفیگ همینجا برایتان ارسال می‌شود.');

  const admin = adminChat();
  if (!admin) return true;
  const caption = [
    '<b>رسید پرداخت</b>',
    `اشتراک: ${escapeHtml(order.planName)}`,
    `مبلغ: ${escapeHtml(String(order.price))} ${escapeHtml(b.currency)}`,
    `روش: ${order.method === 'crypto' ? 'ارز دیجیتال' : order.method === 'card' ? 'کارت به کارت' : '-'}`,
    ...buyerLines(order)
  ].join('\n');
  const keys = [[
    { text: '✅ تایید', callback_data: `b:ok:${order.id}` },
    { text: '✖️ رد', callback_data: `b:no:${order.id}` }
  ]];

  if (message.photo && message.photo.length) {
    // the last entry is the biggest size Telegram kept
    await sendPhoto(admin, message.photo[message.photo.length - 1].file_id, caption, keys);
  } else if (message.document) {
    await sendDocument(admin, message.document.file_id, caption, keys);
  } else {
    await send(admin, `${caption}\n\nمتن ارسالی:\n<code>${escapeHtml(message.text || '')}</code>`, keys);
  }
  return true;
}

/** No payment method is set up, so the admin just gets the request. */
async function submitOrder(ctx, order, _method) {
  const b = bot();
  order.status = 'pending';
  db.saveNow();
  await reply(ctx, [
    `<b>${escapeHtml(order.planName)}</b>`,
    '',
    'درخواست شما برای پشتیبانی ارسال شد. پس از تایید، کانفیگ همینجا برایتان ارسال می‌شود.'
  ].join('\n'), backRow());

  const admin = adminChat();
  if (!admin) return;
  await send(admin, [
    '<b>سفارش جدید</b>',
    `اشتراک: ${escapeHtml(order.planName)}`,
    `مبلغ: ${escapeHtml(String(order.price))} ${escapeHtml(b.currency)}`,
    ...buyerLines(order)
  ].join('\n'), [[
    { text: '✅ تایید', callback_data: `b:ok:${order.id}` },
    { text: '✖️ رد', callback_data: `b:no:${order.id}` }
  ]]);
}

async function cancelOrder(ctx, orderId) {
  const order = bot().orders.find((o) => o.id === orderId);
  if (order && order.status === 'awaiting') {
    order.status = 'cancelled';
    db.saveNow();
  }
  return showScreen(ctx, 'start');
}

/** The admin approved: cut a real client on the plan's inbound and deliver it. */
async function approveOrder(ctx, orderId) {
  const b = bot();
  const order = b.orders.find((o) => o.id === orderId);
  if (!order) return send(ctx.chatId, 'این سفارش پیدا نشد.');
  if (order.status === 'done') return send(ctx.chatId, 'این سفارش قبلاً تایید شده است.');
  if (order.status === 'rejected') return send(ctx.chatId, 'این سفارش قبلاً رد شده است.');

  const plan = b.plans.find((p) => p.id === order.planId);
  const inbound = db.data.inbounds.find((i) => i.id === (plan && plan.inboundId));
  if (!plan || !inbound) {
    order.status = 'failed';
    db.saveNow();
    return send(ctx.chatId, 'اشتراک یا اینباند آن پیدا نشد — در پنل درستش کنید و از خریدار بخواهید دوباره سفارش بدهد.');
  }

  let client;
  try {
    client = await require('./routes/api').createClient(inbound, {
      email: `tg-${order.userId}-${String(order.id).slice(0, 4)}`,
      totalGB: plan.gb || 0,
      expiryTime: plan.days ? Date.now() + plan.days * 86400000 : 0,
      tgId: String(order.userId),
      comment: `${plan.name} - فروش ربات`
    });
  } catch (err) {
    order.status = 'failed';
    order.error = err.message;
    db.saveNow();
    return send(ctx.chatId, `ساخت کلاینت ناموفق بود: ${escapeHtml(err.message)}`);
  }

  order.status = 'done';
  order.clientId = client.id;
  db.saveNow();

  const url = require('./routes/api').subUrl(client.subId);
  await send(order.userId, [
    '<b>اشتراک شما آماده شد ✅</b>',
    `${escapeHtml(plan.name)} · ${plan.gb ? `${plan.gb} گیگ` : 'نامحدود'} · ${plan.days} روز`,
    '',
    'لینک اشتراک:',
    `<code>${escapeHtml(url)}</code>`,
    '',
    'این لینک را در برنامه‌تان به عنوان Subscription اضافه کنید و هر وقت لازم شد آن را به‌روز کنید.'
  ].join('\n'));
  return send(ctx.chatId, `تایید شد. کلاینت ${escapeHtml(client.email)} ساخته و برای خریدار ارسال شد.`);
}

async function rejectOrder(ctx, orderId) {
  const order = bot().orders.find((o) => o.id === orderId);
  if (!order || order.status === 'done' || order.status === 'rejected') {
    return send(ctx.chatId, 'چیزی برای رد کردن نیست.');
  }
  order.status = 'rejected';
  db.saveNow();
  await send(order.userId, 'پرداخت شما تایید نشد. اگر فکر می‌کنید اشتباهی رخ داده با پشتیبانی تماس بگیرید.');
  return send(ctx.chatId, 'رد شد و به خریدار اطلاع داده شد.');
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
      return reply(ctx, `به ${escapeHtml(adminHandle())} پیام بدهید.`, backRow());
    }
    case 'buy': return placeOrder(ctx, value);
    case 'pay': {
      const [orderId, method] = String(value).split(':');
      const order = bot().orders.find((o) => o.id === orderId);
      if (!order) return reply(ctx, 'این سفارش پیدا نشد.', backRow());
      return showPayment(ctx, order, method === 'crypto' ? 'crypto' : 'card');
    }
    case 'cancel': return cancelOrder(ctx, value);
    // approval buttons live in the admin's own chat, never in the buyer's
    case 'ok': return ctx.isAdmin ? approveOrder(ctx, value) : send(ctx.chatId, 'فقط ادمین می‌تواند این کار را انجام دهد.');
    case 'no': return ctx.isAdmin ? rejectOrder(ctx, value) : send(ctx.chatId, 'فقط ادمین می‌تواند این کار را انجام دهد.');
    case 'text': return reply(ctx, fill(value, ctx), backRow());
    default: return showScreen(ctx, 'start');
  }
}

async function handle(update) {
  runtime.seen++;
  const b = bot();

  if (update.message) {
    const message = update.message;
    const from = message.from || {};
    const ctx = {
      chatId: message.chat.id,
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

    /*
     * A picture or a file sent while an order is waiting is its receipt. Plain
     * text counts only for a crypto order, where a transaction hash is the
     * receipt - a card buyer is asked for the photo, so their chatter stays
     * chatter rather than being forwarded to the admin as a payment.
     */
    const text = (message.text || '').trim();
    const waiting = openOrder(ctx.userId);
    const looksLikeHash = /^[A-Za-z0-9:_-]{12,}$/.test(text);
    if (waiting && (message.photo || message.document
      || (waiting.method === 'crypto' && looksLikeHash))) {
      if (await takeReceipt(ctx, message)) return null;
    }
    if (!text) return null;

    if (text === '/id') return send(ctx.chatId, `آیدی عددی شما: <code>${ctx.userId}</code>`);
    if (text === '/stats' && ctx.isAdmin) {
      const d = db.data;
      return send(ctx.chatId, [
        '<b>پنل</b>',
        `اینباندها: ${d.inbounds.length}`,
        `کلاینت‌ها: ${d.clients.length}`,
        `سفارش در انتظار: ${b.orders.filter((o) => o.status === 'pending').length}`
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
        try { await handle(update); } catch (err) { runtime.error = err.message; if (process.env.NEXV_TG_DEBUG) console.error("[bot]", err); }
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
  migrateStarter();
  if (b.enabled && b.token) start().catch((err) => { runtime.error = err.message; });
}

module.exports = { bot, defaults, starterScreens, migrateStarter, start, stop, status, whoAmI, resume, send, escapeHtml, payWays };
