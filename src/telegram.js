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
  /*
   * A bot saved by an older panel - or brought back in a restored backup - can
   * be missing whole sections that arrived later. Fill in whatever is absent
   * here, in the one place everything goes through, rather than letting the
   * first .filter on an array that is not there take the Bot page down.
   */
  const base = defaults();
  for (const key of Object.keys(base)) {
    if (d.bot[key] === undefined || d.bot[key] === null) d.bot[key] = base[key];
  }
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

/*
 * "My usage" was a screen of its own that repeated what the config list could
 * have said in the same breath, so the usage figures moved into the config
 * list and the button became the free trial. Any bot still carrying the old
 * button is swapped over - the action always, the label only while it is still
 * one of the two it shipped with, because an admin who renamed it meant it.
 */
const OLD_USAGE_LABELS = ['📊 مصرف من', '📊 My usage', 'مصرف من', 'My usage'];

function migrateUsageButton() {
  const b = bot();
  let touched = false;
  for (const screen of b.screens || []) {
    for (const row of screen.buttons || []) {
      for (const button of row) {
        if (button.action !== 'usage') continue;
        button.action = 'trial';
        if (OLD_USAGE_LABELS.includes(button.label)) button.label = '🎁 کانفیگ تست';
        touched = true;
      }
    }
  }
  if (touched) db.saveNow();
  return touched;
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
    channel: {
      enable: false,
      id: '',
      link: '',
      text: 'برای استفاده از ربات، ابتدا در کانال زیر عضو شوید 👇'
    },
    ai: { provider: 'anthropic', apiKey: '', model: '', baseUrl: '' },

    /* what a gigabyte sells for, which is the whole of custom-volume pricing */
    pricePerGB: 0,

    /* the free sample. Small and short on purpose: it is there to prove the
       server works from the buyer's own phone, not to be a plan. */
    trial: { enable: true, mb: 100, days: 1, inboundId: '', oncePerUser: true },

    /* buying by the gigabyte instead of from the fixed list */
    custom: { enable: false, minGB: 1, maxGB: 0, days: 30, inboundId: '' }
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
        [{ label: '🔑 کانفیگ‌های من', action: 'configs' }, { label: '🎁 کانفیگ تست', action: 'trial' }],
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

function answer(queryId, text, alert) {
  return call('answerCallbackQuery', {
    callback_query_id: queryId,
    text: text || undefined,
    show_alert: !!alert
  }).catch(() => {});
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

/*
 * Step up a unit on what will be printed, not on the raw figure: a gigabyte
 * less 512 bytes is 1023.9995 MB, which a customer is told is "1024 MB".
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function bytes(n) {
  let value = Math.max(0, Number(n) || 0);
  let i = 0;
  const print = (v, unit) => (unit === 0
    ? String(Math.round(v))
    : v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, ''));

  while (i < UNITS.length - 1 && Number(print(value, i)) >= 1024) {
    value /= 1024;
    i++;
  }
  return `${print(value, i)} ${UNITS[i]}`;
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

function customSettings() {
  const c = bot().custom || {};
  return {
    enable: !!c.enable,
    minGB: Math.max(1, Number(c.minGB) || 1),
    maxGB: Math.max(0, Number(c.maxGB) || 0),      // 0 is no ceiling
    days: Math.max(1, Number(c.days) || 30),
    inboundId: c.inboundId || ''
  };
}

function pricePerGB() { return Math.max(0, Number(bot().pricePerGB) || 0); }

/** Custom volume is only on offer once there is a price to put on a gigabyte. */
function customOn() {
  const c = customSettings();
  return c.enable && pricePerGB() > 0;
}

async function showPlans(ctx) {
  const b = bot();
  const plans = b.plans.filter((p) => p.enable !== false && !p.custom);
  const rows = plans.map((p) => ([{ text: planLine(p).replace(/<[^>]+>/g, ''), callback_data: `b:buy:${p.id}` }]));
  if (customOn()) rows.push([{ text: '🎚 حجم دلخواه', callback_data: 'b:custom:' }]);
  if (!rows.length) return reply(ctx, 'فعلاً اشتراکی برای فروش تعریف نشده است.', backRow());
  rows.push(backRow()[0]);
  return reply(ctx, '<b>اشتراک‌ها</b>\nیکی را انتخاب کنید:', rows);
}

/* --------------------------- buying by the gigabyte ---------------------- */

async function startCustom(ctx) {
  if (!customOn()) return reply(ctx, 'خرید حجم دلخواه فعلاً فعال نیست.', backRow());
  const c = customSettings();
  const per = pricePerGB();
  expect(ctx.userId, 'customGB');
  return reply(ctx, [
    '<b>حجم دلخواه</b>',
    `هر گیگابایت ${per.toLocaleString('en-US')} ${escapeHtml(bot().currency || '')}`,
    `حداقل ${c.minGB} گیگ${c.maxGB ? ` و حداکثر ${c.maxGB} گیگ` : ''} · ${c.days} روز`,
    '',
    'چند گیگابایت می‌خواهید؟ فقط عدد بفرستید.'
  ].join('\n'), backRow());
}

async function takeCustomGB(ctx, raw) {
  const c = customSettings();
  const per = pricePerGB();
  const gb = Math.floor(Number(String(raw).replace(/[^\d.]/g, '')));
  if (!Number.isFinite(gb) || gb <= 0) return send(ctx.chatId, 'یک عدد بفرستید، مثلاً 20');
  if (gb < c.minGB) return send(ctx.chatId, `حداقل ${c.minGB} گیگابایت است.`);
  if (c.maxGB && gb > c.maxGB) return send(ctx.chatId, `حداکثر ${c.maxGB} گیگابایت است.`);

  forget(ctx.userId);
  /*
   * A custom purchase is an ordinary order with a plan made up on the spot, so
   * everything downstream - the receipt, the admin's approve button, delivery -
   * works on it without knowing it was not from the list.
   */
  const b = bot();
  const plan = {
    id: `custom-${db.id()}`,
    name: `${gb} گیگابایت`,
    gb,
    days: c.days,
    price: String(gb * per),
    inboundId: c.inboundId || (db.data.inbounds.find((i) => i.enable !== false) || {}).id || '',
    enable: true,
    custom: true
  };
  if (!plan.inboundId) return send(ctx.chatId, 'اینباندی برای فروش تنظیم نشده است.');
  /* kept with the plans so deliverOrder can find it later, and pruned so a
     year of one-off purchases does not pile up in the settings file */
  b.plans.push(plan);
  const customs = b.plans.filter((p) => p.custom);
  if (customs.length > 200) {
    const drop = new Set(customs.slice(0, customs.length - 200).map((p) => p.id));
    b.plans = b.plans.filter((p) => !drop.has(p.id));
  }
  db.saveNow();
  return placeOrder(ctx, plan.id);
}

/*
 * One screen, not two. What somebody wants to know about a config is its link
 * AND how much of it is left - asking them to go back and open a second screen
 * to learn the second half was never worth a tap.
 */
function usageLines(c) {
  const used = (c.up || 0) + (c.down || 0);
  const quota = (c.totalGB || 0) * 1024 ** 3;
  const out = [`مصرف: ${bytes(used)}${quota ? ` از ${bytes(quota)}` : ' (نامحدود)'}`];
  if (!c.expiryTime && c.startAfterFirstUse && c.expiryDays) {
    // bought but never opened: the clock has not started yet
    out.push(`${c.expiryDays} روز، از اولین استفاده`);
  } else if (!c.expiryTime) {
    out.push('بدون تاریخ انقضا');
  } else {
    const left = Math.ceil((c.expiryTime - Date.now()) / 86400000);
    out.push(left > 0 ? `${left} روز باقی مانده` : 'منقضی شده');
  }
  if (c.enable === false || c.autoDisabled) out.push('⛔️ غیرفعال');
  return out.join(' · ');
}

async function showConfigs(ctx) {
  const mine = clientsOf(ctx.userId);
  if (!mine.length) {
    return reply(ctx, 'هنوز کانفیگی به حساب شما وصل نشده است. یک اشتراک بخرید یا از پشتیبانی بخواهید کانفیگتان را وصل کند.', backRow());
  }
  const subUrl = require('./routes/api').subUrl;
  const lines = mine.map((c) => {
    const inb = db.data.inbounds.find((i) => i.id === c.inboundId);
    return [
      `<b>${escapeHtml(c.email)}</b>${inb ? ` · ${escapeHtml(inb.remark)}` : ''}`,
      usageLines(c),
      `<code>${escapeHtml(subUrl(c.subId))}</code>`
    ].join('\n');
  });
  return reply(ctx, `<b>کانفیگ‌های شما</b>\n\n${lines.join('\n\n')}\n\nلینک را در برنامه‌تان به عنوان Subscription اضافه کنید.`, backRow());
}

/* ---------------------------- the free trial ----------------------------- */

/*
 * Whatever somebody is part-way through typing, and nothing more: a name for a
 * trial, or a number of gigabytes. It lives in memory because it is worth
 * seconds, not days, and it is swept so a conversation abandoned half-way does
 * not sit here for the life of the process.
 */
const pending = new Map();
const PENDING_TTL = 10 * 60 * 1000;

function expect(userId, kind, data) {
  pending.set(String(userId), { kind, data: data || {}, at: Date.now() });
}

function expected(userId) {
  const entry = pending.get(String(userId));
  if (!entry) return null;
  if (Date.now() - entry.at > PENDING_TTL) { pending.delete(String(userId)); return null; }
  return entry;
}

function forget(userId) { pending.delete(String(userId)); }

function trialSettings() {
  const t = bot().trial || {};
  return {
    enable: t.enable !== false,
    mb: Math.max(1, Number(t.mb) || 100),
    days: Math.max(1, Number(t.days) || 1),
    inboundId: t.inboundId || '',
    oncePerUser: t.oncePerUser !== false
  };
}

/** The config this person was already given, if any. */
function trialOf(userId) {
  return db.data.clients.find((c) => String(c.tgId || '') === String(userId) && c.isTrial);
}

async function startTrial(ctx) {
  const t = trialSettings();
  if (!t.enable) return reply(ctx, 'کانفیگ تست فعلاً ارائه نمی‌شود.', backRow());

  const inbound = db.data.inbounds.find((i) => i.id === t.inboundId)
    || db.data.inbounds.find((i) => i.enable !== false);
  if (!inbound) return reply(ctx, 'هنوز اینباندی برای کانفیگ تست تنظیم نشده است.', backRow());

  if (t.oncePerUser) {
    const had = trialOf(ctx.userId);
    if (had) {
      const subUrl = require('./routes/api').subUrl;
      return reply(ctx, [
        'شما قبلاً کانفیگ تست گرفته‌اید 🙂',
        '',
        `<b>${escapeHtml(had.email)}</b>`,
        usageLines(had),
        `<code>${escapeHtml(subUrl(had.subId))}</code>`
      ].join('\n'), backRow());
    }
  }

  expect(ctx.userId, 'trialName');
  return reply(ctx, [
    `<b>کانفیگ تست</b> · ${t.mb} مگابایت · ${t.days} روز`,
    '',
    'یک اسم برای کانفیگتان بفرستید (مثلاً اسم خودتان یا اسم گوشی‌تان).',
    'فقط حروف انگلیسی، عدد و خط تیره.'
  ].join('\n'), backRow());
}

/*
 * The name goes into the client list and into the share link, so it has to be
 * something Xray and every client app will carry: letters, digits, dot, dash
 * and underscore. Anything else is dropped rather than rejected, because
 * bouncing somebody back to retype their own name over a space is unkind.
 */
function cleanName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 24);
}

async function takeTrialName(ctx, raw) {
  const t = trialSettings();
  const wanted = cleanName(raw);
  if (wanted.length < 2) {
    return send(ctx.chatId, 'این اسم کار نمی‌کند. با حروف انگلیسی و عدد بفرستید، حداقل دو کاراکتر.');
  }

  const inbound = db.data.inbounds.find((i) => i.id === t.inboundId)
    || db.data.inbounds.find((i) => i.enable !== false);
  if (!inbound) { forget(ctx.userId); return send(ctx.chatId, 'اینباندی برای کانفیگ تست تنظیم نشده است.'); }

  // a name already in use would be refused outright, so it is made unique here
  let email = wanted;
  let n = 2;
  while (db.data.clients.some((c) => c.email === email)) email = `${wanted}-${n++}`;

  forget(ctx.userId);
  try {
    const client = await require('./routes/api').createClient(inbound, {
      email,
      totalGB: t.mb / 1024,                 // the quota is held in gigabytes
      startAfterFirstUse: true,
      expiryDays: t.days,
      expiryTime: 0,
      tgId: String(ctx.userId),
      isTrial: true,
      comment: 'کانفیگ تست - ربات'
    });
    const url = require('./routes/api').subUrl(client.subId);
    return send(ctx.chatId, [
      '<b>کانفیگ تست شما آماده شد ✅</b>',
      `${escapeHtml(email)} · ${t.mb} مگابایت · ${t.days} روز`,
      '',
      'لینک اشتراک:',
      `<code>${escapeHtml(url)}</code>`,
      '',
      'این لینک را در برنامه‌تان به عنوان Subscription اضافه کنید.'
    ].join('\n'), backRow());
  } catch (err) {
    return send(ctx.chatId, `ساخت کانفیگ تست ممکن نشد: ${escapeHtml(err.message)}`, backRow());
  }
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

  /*
   * Hand the config over now, check the receipt afterwards.
   *
   * A buyer who has paid should be connected in the next few seconds, not
   * whenever the admin next looks at their phone - and the admin loses nothing
   * by it, because rejecting a receipt later cuts the config off and tells the
   * buyer why. Waiting only ever cost the honest customer.
   */
  const handed = await deliverOrder(order);
  if (handed.ok) {
    order.status = 'delivered';
    order.clientId = handed.client.id;
    db.saveNow();
    await send(ctx.chatId, [
      '<b>اشتراک شما آماده است ✅</b>',
      `${escapeHtml(order.planName)}`,
      '',
      'لینک اشتراک:',
      `<code>${escapeHtml(handed.url)}</code>`,
      '',
      'این لینک را در برنامه‌تان به‌عنوان Subscription اضافه کنید.',
      'رسید شما در حال بررسی است؛ در صورت تایید نشدن، اشتراک قطع می‌شود.'
    ].join('\n'), backRow());
  } else {
    order.status = 'pending';
    order.error = handed.error;
    db.saveNow();
    await send(ctx.chatId, 'رسید شما دریافت شد ✅\nپس از بررسی، کانفیگ همینجا برایتان ارسال می‌شود.');
  }

  const admin = adminChat();
  if (!admin) return true;
  const caption = [
    '<b>رسید پرداخت</b>',
    `اشتراک: ${escapeHtml(order.planName)}`,
    `مبلغ: ${escapeHtml(String(order.price))} ${escapeHtml(b.currency)}`,
    `روش: ${order.method === 'crypto' ? 'ارز دیجیتال' : order.method === 'card' ? 'کارت به کارت' : '-'}`,
    ...buyerLines(order),
    '',
    handed.ok
      ? `کانفیگ همین حالا تحویل داده شد: <code>${escapeHtml(handed.client.email)}</code>\nاگر رسید درست نبود، «رد» بزنید تا قطع شود.`
      : `تحویل خودکار انجام نشد: ${escapeHtml(handed.error || 'نامشخص')}`
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

/**
 * Cut a real client on the plan's inbound and work out its subscription link.
 * Shared by the delivery that happens the moment a receipt arrives and by the
 * admin approving an order that could not be delivered then.
 */
async function deliverOrder(order) {
  const b = bot();
  const plan = b.plans.find((p) => p.id === order.planId);
  const inbound = db.data.inbounds.find((i) => i.id === (plan && plan.inboundId));
  if (!plan || !inbound) return { ok: false, error: 'اشتراک یا اینباند آن پیدا نشد' };

  try {
    const client = await require('./routes/api').createClient(inbound, {
      email: `tg-${order.userId}-${String(order.id).slice(0, 4)}`,
      totalGB: plan.gb || 0,
      /* the clock starts when they first use it, not when they paid: a buyer
         who installs tomorrow has not lost a day of what they bought */
      startAfterFirstUse: true,
      expiryDays: plan.days || 0,
      expiryTime: 0,
      tgId: String(order.userId),
      comment: `${plan.name} - فروش ربات`
    });
    return { ok: true, client, plan, url: require('./routes/api').subUrl(client.subId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The admin looked at the receipt and it was good. */
async function approveOrder(ctx, orderId) {
  const b = bot();
  const order = b.orders.find((o) => o.id === orderId);
  if (!order) return send(ctx.chatId, 'این سفارش پیدا نشد.');
  if (order.status === 'done') return send(ctx.chatId, 'این سفارش قبلاً تایید شده است.');

  /* delivered on receipt: approving only lifts the hold and, if it had been
     rejected in between, puts the config back */
  if (order.clientId) {
    const client = db.data.clients.find((c) => c.id === order.clientId);
    if (client) {
      const wasOff = client.blockedReason;
      client.blockedReason = '';
      client.enable = true;
      db.saveNow();
      await require('./xray').apply();
      order.status = 'done';
      db.saveNow();
      if (wasOff) {
        await send(order.userId, 'پرداخت شما تایید شد ✅ اشتراکتان دوباره فعال است.');
      } else {
        await send(order.userId, 'پرداخت شما تایید شد ✅ ممنون از خریدتان.');
      }
      return send(ctx.chatId, `تایید شد. کلاینت ${escapeHtml(client.email)} فعال است.`);
    }
  }

  // not delivered at the time - do it now
  const handed = await deliverOrder(order);
  if (!handed.ok) {
    order.status = 'failed';
    order.error = handed.error;
    db.saveNow();
    return send(ctx.chatId, `ساخت کلاینت ناموفق بود: ${escapeHtml(handed.error)}`);
  }

  order.status = 'done';
  order.clientId = handed.client.id;
  db.saveNow();

  await send(order.userId, [
    '<b>اشتراک شما آماده شد ✅</b>',
    `${escapeHtml(handed.plan.name)} · ${handed.plan.gb ? `${handed.plan.gb} گیگ` : 'نامحدود'} · ${handed.plan.days} روز`,
    '',
    'لینک اشتراک:',
    `<code>${escapeHtml(handed.url)}</code>`,
    '',
    'این لینک را در برنامه‌تان به عنوان Subscription اضافه کنید و هر وقت لازم شد آن را به‌روز کنید.'
  ].join('\n'));
  return send(ctx.chatId, `تایید شد. کلاینت ${escapeHtml(handed.client.email)} ساخته و برای خریدار ارسال شد.`);
}

/**
 * The receipt did not hold up.
 *
 * The config was handed over the moment it arrived, so rejecting has to take
 * it back: the client stops working, and its name in the buyer's app becomes
 * the reason. A config that simply vanishes is a support message; one that
 * says why is not.
 */
const REJECTED_NOTICE = '\u26d4 پرداخت شما تایید نشد';

async function rejectOrder(ctx, orderId) {
  const order = bot().orders.find((o) => o.id === orderId);
  if (!order || order.status === 'rejected') {
    return send(ctx.chatId, 'چیزی برای رد کردن نیست.');
  }
  order.status = 'rejected';

  let cut = false;
  if (order.clientId) {
    const client = db.data.clients.find((c) => c.id === order.clientId);
    if (client) {
      client.enable = false;
      client.blockedReason = REJECTED_NOTICE;
      cut = true;
    }
  }
  db.saveNow();
  if (cut) await require('./xray').apply();

  await send(order.userId, [
    'پرداخت شما تایید نشد.',
    cut ? 'اشتراکتان غیرفعال شد.' : '',
    'اگر فکر می‌کنید اشتباهی رخ داده با پشتیبانی تماس بگیرید.'
  ].filter(Boolean).join('\n'));
  return send(ctx.chatId, cut
    ? 'رد شد. کانفیگ خریدار قطع شد و دلیلش روی نام کانفیگ نوشته شد.'
    : 'رد شد و به خریدار اطلاع داده شد.');
}


/* --------------------------- the channel gate ---------------------------- */

/* userId -> { member, at }; a membership check per message would be rude. */
const members = new Map();
const MEMBER_TTL = 60 * 1000;

function channel() {
  const b = bot();
  if (!b.channel) b.channel = defaults().channel;
  return b.channel;
}

/** Is the gate switched on and pointed at something? */
function gateOn() {
  const c = channel();
  return !!(c.enable && String(c.id || '').trim());
}

/** Where someone joins: an @name needs no lookup, an id needs an invite link. */
function joinLink() {
  const c = channel();
  const id = String(c.id || '').trim();
  if (c.link) return c.link;
  if (id.startsWith('@')) return `https://t.me/${id.slice(1)}`;
  return '';
}

/**
 * Has this user joined? Telegram answers for a channel only when the bot is an
 * administrator there, which is why the Bot page insists on that and tests it.
 */
async function isMember(userId, force) {
  const c = channel();
  const cached = members.get(userId);
  if (!force && cached && Date.now() - cached.at < MEMBER_TTL) return cached.member;

  let member = false;
  try {
    const result = await call('getChatMember', { chat_id: c.id, user_id: userId });
    member = ['creator', 'administrator', 'member'].includes(result.status)
      || (result.status === 'restricted' && result.is_member);
  } catch (err) {
    // the bot was removed, or was never an admin: do not lock everyone out
    runtime.error = `channel check failed: ${err.message}`;
    warnAdminAboutChannel(err.message);
    member = true;
  }
  members.set(userId, { member, at: Date.now() });
  return member;
}

/*
 * Tell the admin their gate has stopped working.
 *
 * Telegram will only say who is in a channel if the bot is an administrator
 * there. When it is not, every check fails and the gate quietly lets everyone
 * through - which is the right way to fail, but silently is not: the admin
 * believes the channel is mandatory and it is not. Said once an hour, and
 * again whenever the reason changes, so a broken gate cannot go unnoticed and
 * a working bot cannot be drowned in it either.
 */
const channelWarning = { at: 0, reason: '' };
const WARN_AGAIN = 60 * 60 * 1000;

function warnAdminAboutChannel(reason) {
  const b = bot();
  if (!b.adminChatId) return;
  const now = Date.now();
  if (reason === channelWarning.reason && now - channelWarning.at < WARN_AGAIN) return;
  channelWarning.at = now;
  channelWarning.reason = reason;

  const c = channel();
  send(b.adminChatId, [
    '⚠️ <b>عضویت اجباری کانال کار نمی‌کند</b>',
    '',
    `کانال: <code>${escapeHtml(c.id || '—')}</code>`,
    `پاسخ تلگرام: <code>${escapeHtml(reason)}</code>`,
    '',
    'ربات باید در کانال <b>ادمین</b> باشد تا بتواند عضویت را بررسی کند.',
    'تا وقتی درست نشود، ربات همه را بدون عضویت رد می‌کند.'
  ].join('\n'));
}

/** The wall: the admin's own text, a join button, and a button to re-check. */
function gateScreen(ctx) {
  const c = channel();
  const link = joinLink();
  const rows = [];
  if (link) rows.push([{ text: '📢 عضویت در کانال', url: link }]);
  rows.push([{ text: '✅ بررسی عضویت', callback_data: 'b:joined:' }]);
  return reply(ctx, fill(c.text || 'برای استفاده از ربات، ابتدا در کانال زیر عضو شوید 👇', ctx), rows);
}

/** Returns true when the gate handled this update and nothing else should. */
async function gate(ctx, force) {
  if (!gateOn() || ctx.isAdmin) return false;
  if (await isMember(ctx.userId, force)) return false;
  await gateScreen(ctx);
  return true;
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
    /* the usage screen folded into the config list; an old button still works */
    case 'usage': return showConfigs(ctx);
    case 'trial': return startTrial(ctx);
    case 'custom': return startCustom(ctx);
    case 'support': {
      const screen = screenByKey('support');
      if (screen) return showScreen(ctx, 'support');
      return reply(ctx, `به ${escapeHtml(adminHandle())} پیام بدهید.`, backRow());
    }
    case 'joined': {
      const ok = await isMember(ctx.userId, true);
      if (!ok) {
        if (ctx.answer) ctx.answer('هنوز عضو کانال نشده‌اید. بعد از عضویت دوباره بزنید.', true);
        return null;
      }
      if (ctx.answer) ctx.answer('عضویت تایید شد ✅');
      return showScreen(ctx, 'start');
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
    case 'noop': return ctx.answer ? ctx.answer('این فقط یک پیام آزمایشی است.', true) : undefined;
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

    /*
     * Something was asked for and this is the answer - a name for a trial, or
     * a number of gigabytes. It is read before the command lookup below, since
     * somebody naming their config "start" means the word, not the screen; a
     * real command still gets out, so nobody is trapped in the prompt.
     */
    const waitingFor = expected(ctx.userId);
    if (waitingFor && !text.startsWith('/')) {
      if (await gate(ctx)) return null;
      if (waitingFor.kind === 'trialName') return takeTrialName(ctx, text);
      if (waitingFor.kind === 'customGB') return takeCustomGB(ctx, text);
    }
    if (waitingFor && text.startsWith('/')) forget(ctx.userId);
    if (text === '/stats' && ctx.isAdmin) {
      const d = db.data;
      return send(ctx.chatId, [
        '<b>پنل</b>',
        `اینباندها: ${d.inbounds.length}`,
        `کلاینت‌ها: ${d.clients.length}`,
        `سفارش در انتظار: ${b.orders.filter((o) => o.status === 'pending').length}`
      ].join('\n'));
    }
    if (await gate(ctx)) return null;

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
    // held until the gate has spoken, so its message can be the alert
    ctx.answer = (text, alert) => answer(query.id, text, alert);
    const [, action, ...rest] = String(query.data || '').split(':');
    // the re-check button has to work from behind the gate
    if (action !== 'joined' && await gate(ctx)) {
      if (ctx.answer) ctx.answer();
      return null;
    }
    if (action !== 'joined' && ctx.answer) ctx.answer();
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
  migrateUsageButton();
  if (b.enabled && b.token) start().catch((err) => { runtime.error = err.message; });
}

module.exports = {
  bot, defaults, starterScreens, migrateStarter, migrateUsageButton, start, stop, status, whoAmI, resume,
  send, escapeHtml, payWays, call, channel, gateOn, joinLink, adminChat, buyerLines,
  /* the entry point for one update: what the polling loop feeds, and what a
     webhook would feed if this ever grows one */
  handle
};
