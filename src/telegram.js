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
const membership = require('./membership');

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

/* the support screen used to send people away; while it still says so, say the
   new thing instead - an admin who rewrote it is left alone */
const OLD_SUPPORT_TEXTS = [
  'سوال خود را برای {admin} بفرستید، در اولین فرصت پاسخ می‌دهیم.',
  'Send your question to {admin} and we will answer shortly.'
];
const NEW_SUPPORT_TEXT = 'سوال یا مشکلتان را همین‌جا بنویسید و بفرستید — عکس و فایل هم می‌توانید بفرستید. پاسخ در همین چت می‌آید.';

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
    if (screen.key === 'support' && OLD_SUPPORT_TEXTS.includes(screen.text)) {
      screen.text = NEW_SUPPORT_TEXT;
      touched = true;
    }
  }
  /*
   * Converting an existing button only helps a bot that had one. A menu that
   * never carried "My usage" - or whose admin had already removed it - came
   * out of the migration with no trial button at all, which is exactly what
   * "you didn't add the test config option" was. If nothing offers it by the
   * time we get here, it is put on the start screen.
   */
  if (!hasAction(b.screens, 'trial')) {
    if (addToStart(b.screens, { label: '🎁 کانفیگ تست', action: 'trial' })) touched = true;
  }

  if (touched) db.saveNow();
  return touched;
}

function hasAction(screens, action) {
  return (screens || []).some((screen) => (screen.buttons || [])
    .some((row) => row.some((button) => button.action === action)));
}

/**
 * Put a button on the start screen, beside the configs button when that row
 * has space - two to a row is how this menu is laid out - and on a row of its
 * own just above support otherwise.
 */
function addToStart(screens, button) {
  const start = (screens || []).find((screen) => screen.key === 'start');
  if (!start) return false;
  start.buttons = start.buttons || [];

  const beside = start.buttons.find((row) => row.length === 1 && row[0].action === 'configs');
  if (beside) { beside.push(button); return true; }

  const supportAt = start.buttons.findIndex((row) => row.some((b2) => b2.action === 'support'));
  if (supportAt >= 0) start.buttons.splice(supportAt, 0, [button]);
  else start.buttons.push([button]);
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
    custom: { enable: false, minGB: 1, maxGB: 0, days: 30, inboundId: '' },

    /* what the buyer is allowed to decide for themselves rather than be given */
    access: { chooseName: true }
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
      text: 'سوال یا مشکلتان را همین‌جا بنویسید و بفرستید — عکس و فایل هم می‌توانید بفرستید. پاسخ در همین چت می‌آید.',
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

/*
 * How a plan is put to a buyer, everywhere: the name the admin typed, and what
 * it costs. Nothing else.
 *
 * It used to spell out the quota and the days as well, so a button read
 * "50 گیگ | 30 روزه — 50 گیگ / 30 روز · 25000 تومان": the admin's own name had
 * already said all of that once, and Telegram then cut the line off before the
 * price - the one part of it they could not have written into the name
 * themselves. What the name says is the admin's business; the price is ours.
 */
function planPrice(plan) {
  const price = String(plan.price || '').trim();
  if (!price) return '';
  return `${price} ${String(bot().currency || '').trim()}`.trim();
}

/** For a message, where the name is marked up. */
function planLine(plan) {
  const price = planPrice(plan);
  return `<b>${escapeHtml(plan.name)}</b>${price ? ` — ${escapeHtml(price)}` : ''}`;
}

/** The same thing for a button, where Telegram parses no markup at all. */
function planButton(plan) {
  const price = planPrice(plan);
  return `${plan.name}${price ? ` — ${price}` : ''}`;
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

/** What the buyer gets to decide. Older settings files have none of this. */
function accessSettings() {
  const a = bot().access || {};
  return { chooseName: a.chooseName !== false };
}

/** Custom volume is only on offer once there is a price to put on a gigabyte. */
function customOn() {
  const c = customSettings();
  return c.enable && pricePerGB() > 0;
}

/*
 * The plan list, which doubles as the renewal list.
 *
 * `renewId` is the config being topped up, carried through the buttons so that
 * whatever is picked lands on that same config instead of cutting a new one.
 * Everything downstream - the order, the receipt, the admin's approve button -
 * is identical either way; only delivery looks at it.
 */
async function showPlans(ctx, renewId) {
  const b = bot();
  const plans = b.plans.filter((p) => p.enable !== false && !p.custom);
  const tail = renewId ? `:${renewId}` : '';
  const rows = plans.map((p) => ([{ text: planButton(p), callback_data: `b:buy:${p.id}${tail}` }]));
  if (customOn()) rows.push([{ text: '🎚 حجم دلخواه', callback_data: `b:custom:${renewId || ''}` }]);
  if (!rows.length) {
    return reply(ctx, 'فعلاً اشتراکی برای فروش تعریف نشده است.', renewId ? [[{ text: '⬅️ بازگشت', callback_data: `b:cfg:${renewId}` }]] : backRow());
  }
  rows.push(renewId
    ? [{ text: '⬅️ بازگشت', callback_data: `b:cfg:${renewId}` }]
    : backRow()[0]);

  const head = renewId
    ? '<b>تمدید اشتراک</b>\nحجم یا پلن تازه را انتخاب کنید — روی همین کانفیگ اعمال می‌شود:'
    : '<b>اشتراک‌ها</b>\nیکی را انتخاب کنید:';
  return reply(ctx, head, rows);
}

/* --------------------------- buying by the gigabyte ---------------------- */

async function startCustom(ctx, renewId) {
  if (!customOn()) return reply(ctx, 'خرید حجم دلخواه فعلاً فعال نیست.', backRow());
  const c = customSettings();
  const per = pricePerGB();
  expect(ctx.userId, 'customGB', { renewId: renewId || '' });
  return reply(ctx, [
    '<b>حجم دلخواه</b>',
    `هر گیگابایت ${per.toLocaleString('en-US')} ${escapeHtml(bot().currency || '')}`,
    `حداقل ${c.minGB} گیگ${c.maxGB ? ` و حداکثر ${c.maxGB} گیگ` : ''} · ${c.days} روز`,
    '',
    'چند گیگابایت می‌خواهید؟ فقط عدد بفرستید.'
  ].join('\n'), backRow());
}

async function takeCustomGB(ctx, raw, waiting) {
  const c = customSettings();
  const per = pricePerGB();
  const renewId = (waiting && waiting.data && waiting.data.renewId) || '';
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
  return askName(ctx, plan.id, renewId);
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

/*
 * The config list: one numbered button per config, and nothing else.
 *
 * It used to print every config, its usage and its whole subscription link
 * into one message. Three configs made a wall of text with two links in it
 * that were easy to copy the wrong one of. Now the list is just the names,
 * numbered, and tapping one opens it on its own.
 */
async function showConfigs(ctx) {
  const mine = clientsOf(ctx.userId);
  if (!mine.length) {
    return reply(ctx, 'هنوز کانفیگی به حساب شما وصل نشده است. یک اشتراک بخرید یا از پشتیبانی بخواهید کانفیگتان را وصل کند.', backRow());
  }
  const rows = mine.map((c, i) => ([{
    text: `${i + 1}  ${dead(c) ? '⛔️' : '✅'}  ${c.email}`,
    callback_data: `b:cfg:${shortId(c)}`
  }]));
  rows.push(backRow()[0]);
  return reply(ctx, [
    '<b>🔑 کانفیگ‌های شما</b>',
    '',
    mine.length === 1 ? 'یک کانفیگ دارید. برای دیدن جزئیاتش روی آن بزنید.'
      : `${mine.length} کانفیگ دارید. روی هرکدام بزنید تا جزئیاتش را ببینید.`
  ].join('\n'), rows);
}

/** Is this config unusable right now, for any of the reasons it can be? */
function dead(c) {
  if (c.enable === false || c.autoDisabled) return true;
  if (c.expiryTime && c.expiryTime < Date.now()) return true;
  const quota = (c.totalGB || 0) * 1024 ** 3;
  return !!(quota && (c.up || 0) + (c.down || 0) >= quota);
}

/*
 * A config's id, short enough to travel in a button.
 *
 * Telegram gives callback_data sixty-four bytes and refuses the whole message
 * if a single button is over it - and refuses it with an error nobody sees,
 * so the button simply does nothing. A plan button carrying both a plan id and
 * a config id was 79 bytes of two full UUIDs, which is why renew looked dead.
 * Eight characters is what clientTag already puts in the Xray config, and it
 * leaves room for whatever else a button has to say.
 */
function shortId(client) {
  return String(client.id || '').slice(0, 8);
}

/** One config, whoever it belongs to - or nothing, if it is not theirs. */
function myConfig(ctx, token) {
  const want = String(token || '');
  if (!want) return null;
  const mine = clientsOf(ctx.userId);
  // the whole id still works, so a button made before this keeps working
  return mine.find((c) => c.id === want) || mine.find((c) => c.id.startsWith(want)) || null;
}

/** What this config cost, if it came through the bot and we still know. */
function priceOf(client) {
  const b = bot();
  const order = (b.orders || []).find((o) => o.clientId === client.id);
  if (order && order.price) return `${order.price} ${b.currency || ''}`.trim();
  return '';
}

/** How long is left, in words, with the "not started yet" case spelled out. */
function timeLeft(c) {
  if (!c.expiryTime && c.startAfterFirstUse && c.expiryDays) return `${c.expiryDays} روز (از اولین اتصال)`;
  if (!c.expiryTime) return 'بدون محدودیت زمانی';
  const ms = c.expiryTime - Date.now();
  if (ms <= 0) return 'منقضی شده';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days >= 1) return `${days} روز و ${hours} ساعت`;
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours} ساعت و ${minutes} دقیقه`;
}

/*
 * One config, laid out so it can be read at a glance.
 *
 * Every line is a label, a value and the emoji that tells them apart, with the
 * blank lines kept in: on a phone this is read in a second between other
 * things, not studied.
 */
async function showConfig(ctx, clientId) {
  const c = myConfig(ctx, clientId);
  if (!c) return showConfigs(ctx);

  const subUrl = require('./routes/api').subUrl;
  const used = (c.up || 0) + (c.down || 0);
  const quota = (c.totalGB || 0) * 1024 ** 3;
  const price = priceOf(c);
  const where = membership.inboundsOf(c, db.data.inbounds).map((i) => i.remark).join(' + ');
  const off = c.enable === false || c.autoDisabled;

  const lines = [
    `🔑  <b>${escapeHtml(c.email)}</b>`,
    '',
    `📊  مصرف‌شده:  <b>${bytes(used)}</b>`,
    `💾  حجم کل:  <b>${quota ? bytes(quota) : 'نامحدود'}</b>`
  ];
  if (quota) lines.push(`📉  باقی‌مانده:  <b>${bytes(Math.max(0, quota - used))}</b>`);
  lines.push(`⏳  زمان باقی‌مانده:  <b>${timeLeft(c)}</b>`);
  if (price) lines.push(`💰  قیمت سرویس:  <b>${escapeHtml(price)}</b>`);
  if (where) lines.push(`🌐  سرور:  <b>${escapeHtml(where)}</b>`);
  lines.push(
    `${off ? '⛔️' : '✅'}  وضعیت:  <b>${off ? 'غیرفعال' : 'فعال'}</b>`,
    '',
    '🔗  <b>لینک اشتراک</b>',
    `<code>${escapeHtml(subUrl(c.subId))}</code>`,
    '',
    'این لینک را در برنامه‌تان به عنوان Subscription اضافه کنید.'
  );

  const id = shortId(c);
  return reply(ctx, lines.join('\n'), [
    [{ text: '🔄 تمدید / ارتقا اشتراک', callback_data: `b:renew:${id}` }],
    [
      { text: off ? '🔛 روشن کردن' : '⏸ خاموش کردن', callback_data: `b:power:${id}` },
      { text: '✏️ تغییر نام', callback_data: `b:rename:${id}` }
    ],
    [{ text: '🔗 لینک جدید', callback_data: `b:newlink:${id}` }],
    [{ text: '⬅️ بازگشت', callback_data: 'b:configs:' }]
  ]);
}

/** Turn one of their own configs off, or back on. */
async function powerConfig(ctx, clientId) {
  const c = myConfig(ctx, clientId);
  if (!c) return showConfigs(ctx);
  /* a config switched off for not being paid for is not theirs to switch on */
  if (c.blockedReason) {
    if (ctx.answer) ctx.answer('این کانفیگ توسط پشتیبانی غیرفعال شده است.', true);
    return null;
  }
  c.enable = c.enable === false;
  c.autoDisabled = false;
  db.saveNow();
  await require('./xray').apply();
  if (ctx.answer) ctx.answer(c.enable ? 'روشن شد ✅' : 'خاموش شد ⏸');
  return showConfig(ctx, clientId);
}

/** A fresh subscription link for the same config; the old one stops working. */
async function newLink(ctx, clientId) {
  const c = myConfig(ctx, clientId);
  if (!c) return showConfigs(ctx);
  const api = require('./routes/api');
  c.subId = require('crypto').randomBytes(6).toString('base64url');
  db.saveNow();
  if (ctx.answer) ctx.answer('لینک تازه ساخته شد ✅');
  await send(ctx.chatId, [
    '🔗 <b>لینک تازه‌ی شما</b>',
    '',
    `<code>${escapeHtml(api.subUrl(c.subId))}</code>`,
    '',
    '⚠️ لینک قبلی از این لحظه کار نمی‌کند. این یکی را در برنامه‌تان جایگزین کنید.'
  ].join('\n'));
  return showConfig(ctx, clientId);
}

/** Ask for a new name for a config they already own. */
async function startRename(ctx, clientId) {
  const c = myConfig(ctx, clientId);
  if (!c) return showConfigs(ctx);
  expect(ctx.userId, 'renameConfig', { clientId: c.id });
  return reply(ctx, [
    '✏️ <b>تغییر نام</b>',
    '',
    `نام فعلی: <b>${escapeHtml(c.email)}</b>`,
    '',
    'نام تازه را بفرستید. با حروف انگلیسی و عدد، حداقل دو کاراکتر.'
  ].join('\n'), [[{ text: '⬅️ بازگشت', callback_data: `b:cfg:${shortId(c)}` }]]);
}

async function takeRename(ctx, raw, waiting) {
  const clientId = waiting && waiting.data && waiting.data.clientId;
  const c = myConfig(ctx, clientId);
  if (!c) { forget(ctx.userId); return showConfigs(ctx); }
  const wanted = uniqueName(cleanName(raw), c.id);
  if (!wanted) return send(ctx.chatId, 'این اسم کار نمی‌کند. با حروف انگلیسی و عدد بفرستید، حداقل دو کاراکتر.');
  forget(ctx.userId);
  c.email = wanted;
  db.saveNow();
  await require('./xray').apply();
  await send(ctx.chatId, `نام کانفیگ به <b>${escapeHtml(wanted)}</b> تغییر کرد ✅`);
  return showConfig(ctx, c.id);
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

/** The config this person was given, if it is still there. */
function trialOf(userId) {
  return db.data.clients.find((c) => String(c.tgId || '') === String(userId) && c.isTrial);
}

/*
 * Who has had their one, kept as a record of its own rather than inferred from
 * the client list.
 *
 * Looking for an existing trial client was not the same question: a trial is a
 * hundred megabytes for a day, so it expires almost immediately, and the panel
 * has a "delete expired clients" button that sweeps exactly those. Every sweep
 * handed the whole audience a fresh trial. The config can come and go; the
 * record of having taken one stays until the admin clears it on purpose.
 */
function trialLedger() {
  const b = bot();
  b.trial = b.trial || {};
  if (!b.trial.taken || typeof b.trial.taken !== 'object') b.trial.taken = {};
  return b.trial;
}

function hasTakenTrial(userId) {
  const t = trialLedger();
  if (t.taken[String(userId)]) return true;
  /* bots that were handing trials out before this record existed have nothing
     in it, so their clients still count - but only the ones made since the
     last reset, or a reset would not actually reset anything */
  const since = Number(t.resetAt) || 0;
  return db.data.clients.some((c) => String(c.tgId || '') === String(userId)
    && c.isTrial && (c.createdAt || 0) > since);
}

function markTrialTaken(userId) {
  const t = trialLedger();
  t.taken[String(userId)] = Date.now();
  db.saveNow();
}

/** Let everybody have another one. Configs already handed out are left alone. */
function resetTrials() {
  const t = trialLedger();
  const count = Object.keys(t.taken).length;
  t.taken = {};
  t.resetAt = Date.now();
  db.saveNow();
  return count;
}

/** How many people have taken one since the last reset. */
function trialsTaken() {
  const t = trialLedger();
  const ids = new Set(Object.keys(t.taken));
  const since = Number(t.resetAt) || 0;
  for (const c of db.data.clients) {
    if (c.isTrial && c.tgId && (c.createdAt || 0) > since) ids.add(String(c.tgId));
  }
  return ids.size;
}

async function startTrial(ctx) {
  const t = trialSettings();
  if (!t.enable) return reply(ctx, 'کانفیگ تست فعلاً ارائه نمی‌شود.', backRow());

  const inbound = db.data.inbounds.find((i) => i.id === t.inboundId)
    || db.data.inbounds.find((i) => i.enable !== false);
  if (!inbound) return reply(ctx, 'هنوز اینباندی برای کانفیگ تست تنظیم نشده است.', backRow());

  if (t.oncePerUser && hasTakenTrial(ctx.userId)) {
    // the record outlives the config, so there may be nothing left to show them
    const had = trialOf(ctx.userId);
    if (!had) {
      return reply(ctx, 'شما قبلاً کانفیگ تست گرفته‌اید 🙂 برای ادامه، یکی از اشتراک‌ها را تهیه کنید.', backRow());
    }
    const subUrl = require('./routes/api').subUrl;
    return reply(ctx, [
      'شما قبلاً کانفیگ تست گرفته‌اید 🙂',
      '',
      `<b>${escapeHtml(had.email)}</b>`,
      usageLines(had),
      `<code>${escapeHtml(subUrl(had.subId))}</code>`
    ].join('\n'), backRow());
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

/*
 * A name nobody else is using. Two people may both want "ali", and refusing
 * the second one outright helps nobody, so the clash is settled here with a
 * number rather than handed back as an error.
 */
function uniqueName(wanted, exceptId) {
  if (!wanted || wanted.length < 2) return '';
  let name = wanted;
  let n = 2;
  while (db.data.clients.some((c) => c.email === name && c.id !== exceptId)) name = `${wanted}-${n++}`;
  return name;
}

/*
 * The name the buyer picks for what they are about to buy.
 *
 * Asked once the plan is settled and before any money is mentioned, because
 * it is the last thing about the config that is theirs to decide. When the
 * panel has that switched off, or when they are topping up a config that
 * already has a name, this falls straight through to the order.
 */
async function askName(ctx, planId, renewId) {
  if (renewId || !accessSettings().chooseName) return placeOrder(ctx, planId, '', renewId);
  const plan = bot().plans.find((p) => p.id === planId);
  if (!plan) return reply(ctx, 'این اشتراک دیگر موجود نیست.', backRow());
  expect(ctx.userId, 'orderName', { planId });
  return reply(ctx, [
    planLine(plan),
    '',
    '✏️ یک <b>نام</b> برای کانفیگتان بفرستید.',
    'با حروف انگلیسی و عدد، حداقل دو کاراکتر — مثلاً <code>ali-phone</code>.'
  ].join('\n'), [[{ text: '⬅️ بازگشت', callback_data: 'b:plans:' }]]);
}

async function takeOrderName(ctx, raw, waiting) {
  const planId = waiting && waiting.data && waiting.data.planId;
  const name = uniqueName(cleanName(raw));
  if (!name) return send(ctx.chatId, 'این اسم کار نمی‌کند. با حروف انگلیسی و عدد بفرستید، حداقل دو کاراکتر.');
  forget(ctx.userId);
  return placeOrder(ctx, planId, name, '');
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
  const email = uniqueName(wanted);

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
    markTrialTaken(ctx.userId);
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

/* ------------------------------- support --------------------------------- */

/*
 * Support was a screen that said "message the admin" and then did nothing with
 * what anybody typed. It is a relay now: the buyer writes here, the admin gets
 * it with a name and a number attached, and replying to that in their own chat
 * goes back to the buyer.
 *
 * Which buyer a reply belongs to is worked out from the message being replied
 * to rather than from anything held in memory. The id is written into the
 * header in plain sight, so this keeps working after the panel restarts - and
 * a map is kept as well, only so that replying to the copy of the message
 * works as naturally as replying to the header.
 */
const relayed = new Map();
const RELAY_MAX = 500;

function rememberRelay(messageId, userId) {
  if (!messageId) return;
  relayed.set(String(messageId), String(userId));
  if (relayed.size > RELAY_MAX) {
    // oldest first; Map keeps insertion order
    for (const key of relayed.keys()) {
      relayed.delete(key);
      if (relayed.size <= RELAY_MAX) break;
    }
  }
}

/** Who a message in the admin's chat is about, if anybody. */
function relayTarget(replied) {
  if (!replied) return '';
  const known = relayed.get(String(replied.message_id));
  if (known) return known;
  /* the forwarded copy still carries its author when their privacy allows it */
  if (replied.forward_from && replied.forward_from.id) return String(replied.forward_from.id);
  // written into the header, which is what makes this survive a restart
  const body = `${replied.text || ''}\n${replied.caption || ''}`;
  const tagged = /#id(\d{3,})/.exec(body);
  if (tagged) return tagged[1];
  // a payment receipt names the buyer the same way, so replying to one works too
  const buyer = /آیدی عددی:\s*(\d{3,})/.exec(body);
  return buyer ? buyer[1] : '';
}

function whoLine(ctx) {
  return [
    `از: ${escapeHtml(ctx.name || '-')}`,
    ctx.username ? `یوزرنیم: @${escapeHtml(ctx.username)}` : 'یوزرنیم: ندارد',
    `#id${ctx.userId}`
  ].join(' · ');
}

async function openSupport(ctx) {
  expect(ctx.userId, 'support');
  const screen = screenByKey('support');
  if (screen) return showScreen(ctx, 'support');
  return reply(ctx, 'پیامتان را همین‌جا بنویسید و بفرستید؛ به پشتیبانی می‌رسد.', backRow());
}

/** Pass one message from a buyer through to the admin. Returns false if nobody is there. */
async function toSupport(ctx, message) {
  const admin = adminChat();
  if (!admin) {
    await send(ctx.chatId, 'پشتیبانی فعلاً در دسترس نیست. کمی بعد دوباره امتحان کنید.');
    return false;
  }

  /*
   * Two ways to answer, because replying to a message is not obvious on every
   * client and is awkward on a phone: the button puts the admin straight into
   * answering this person, and a plain reply still works as it always did.
   */
  const header = await send(admin, [
    '<b>💬 پیام پشتیبانی</b>',
    whoLine(ctx),
    '',
    'برای پاسخ، دکمه‌ی زیر را بزنید یا روی همین پیام ریپلای کنید.'
  ].join('\n'), [[{ text: '✍️ پاسخ به این کاربر', callback_data: `b:answer:${ctx.userId}` }]]);
  rememberRelay(header && header.message_id, ctx.userId);

  /*
   * copyMessage rather than a hand-written re-send: it carries whatever was
   * sent - text, a screenshot, a voice note, a file - without this having to
   * know about every kind Telegram has.
   */
  try {
    const copy = await call('copyMessage', {
      chat_id: admin,
      from_chat_id: ctx.chatId,
      message_id: message.message_id
    });
    rememberRelay(copy && copy.message_id, ctx.userId);
  } catch (err) {
    runtime.error = err.message;
    await send(admin, `<i>(پیام کپی نشد: ${escapeHtml(err.message)})</i>`);
  }

  // the window stays open, so a follow-up does not need another tap
  expect(ctx.userId, 'support');
  await send(ctx.chatId, 'پیام شما برای پشتیبانی ارسال شد ✅ پاسخ همین‌جا می‌آید.');
  return true;
}

/** The admin pressed answer on somebody's message; the next thing they send goes there. */
async function startAnswer(ctx, userId) {
  if (!ctx.isAdmin) return null;
  expect(ctx.userId, 'supportReply', { target: String(userId) });
  return send(ctx.chatId, [
    `✍️ در حال پاسخ به <code>${escapeHtml(String(userId))}</code>`,
    '',
    'پیامتان را بفرستید — متن، عکس یا فایل. برای انصراف /start بزنید.'
  ].join('\n'));
}

/**
 * The admin answered somebody; carry it back to them.
 *
 * `target` is either worked out from the message being replied to, or held
 * from the answer button. The buyer gets a button to carry on, so a
 * conversation does not end just because the admin spoke last: pressing it
 * opens the same support window and their next message comes straight back
 * here.
 */
async function fromSupport(ctx, message, target) {
  const to = target || relayTarget(message.reply_to_message);
  if (!to) return false;
  const text = (message.text || '').trim();
  if (text.startsWith('/')) return false;        // a command is not an answer

  await send(to, '<b>💬 پاسخ پشتیبانی</b>');
  try {
    await call('copyMessage', {
      chat_id: to,
      from_chat_id: ctx.chatId,
      message_id: message.message_id
    });
  } catch (err) {
    runtime.error = err.message;
    await send(ctx.chatId, `پاسخ فرستاده نشد: ${escapeHtml(err.message)}`);
    return true;
  }
  await send(to, 'اگر هنوز سوالی دارید، همین‌جا بنویسید یا دکمه‌ی زیر را بزنید.', [
    [{ text: '💬 ادامه‌ی گفتگو', callback_data: 'b:support:' }],
    [{ text: '⬅️ بازگشت به منو', callback_data: 'b:screen:start' }]
  ]);
  await send(ctx.chatId, '✅ پاسخ فرستاده شد.');
  return true;
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
async function placeOrder(ctx, planId, clientName, renewId) {
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
    /* what the buyer asked their config be called, and - for a top-up - which
       config this is being added to rather than cut fresh */
    clientName: clientName || '',
    renewClientId: renewId || '',
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

  /* both ways are on, so the buyer says which. The rows are built from what
     is actually configured rather than written out, so a third method later
     appears here without this having to be touched again. */
  const label = { card: '💳 کارت به کارت', crypto: '🪙 ارز دیجیتال' };
  return reply(ctx, [
    planLine(plan),
    order.clientName ? `نام کانفیگ: <b>${escapeHtml(order.clientName)}</b>` : '',
    '',
    '💰 پرداخت را چطور انجام می‌دهید؟'
  ].filter(Boolean).join('\n'),
  ways.map((way) => ([{ text: label[way] || way, callback_data: `b:pay:${order.id}:${way}` }]))
    .concat([[{ text: '⬅️ بازگشت', callback_data: 'b:plans:' }]]));
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

  /*
   * A top-up lands on the config the buyer was looking at when they pressed
   * renew: the volume is added to what is left rather than replacing it, and
   * the days are added to whatever is still to run. Nothing about the config
   * changes - same link, same name - so the app on their phone keeps working
   * and simply has more in it.
   */
  if (order.renewClientId) {
    const client = db.data.clients.find((c) => c.id === order.renewClientId
      && String(c.tgId || '') === String(order.userId));
    if (client) {
      try {
        return { ok: true, renewed: true, plan, client: await topUp(client, plan) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    // the config went away between buying and delivering; cut a new one instead
  }

  try {
    const client = await require('./routes/api').createClient(inbound, {
      // what the buyer called it, if they were asked and the name is still free
      email: uniqueName(cleanName(order.clientName)) || `tg-${order.userId}-${String(order.id).slice(0, 4)}`,
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

/**
 * Add a plan's worth of volume and days to a config that already exists.
 *
 * Both are added rather than set: somebody who tops up with a week still to
 * run keeps that week. An expired or used-up config starts its new allowance
 * from now, which is the only reading that is not a cheat either way.
 */
async function topUp(client, plan) {
  const now = Date.now();
  if (plan.gb) {
    const used = (client.up || 0) + (client.down || 0);
    const hadGB = Number(client.totalGB) || 0;
    // an unlimited config stays unlimited; there is nothing to add to
    if (hadGB) {
      const leftBytes = Math.max(0, hadGB * 1024 ** 3 - used);
      client.totalGB = (used + leftBytes) / 1024 ** 3 + plan.gb;
    }
  } else {
    client.totalGB = 0;
  }
  if (plan.days) {
    if (client.expiryTime && client.expiryTime > now) client.expiryTime += plan.days * 86400000;
    else if (!client.expiryTime && client.startAfterFirstUse && !client.startedAt) {
      client.expiryDays = (Number(client.expiryDays) || 0) + plan.days;
    } else {
      client.expiryTime = now + plan.days * 86400000;
    }
  }
  // a top-up is also a reprieve: whatever had switched it off is settled now
  client.autoDisabled = false;
  client.blockedReason = '';
  client.enable = true;
  db.saveNow();
  await require('./xray').apply();
  return client;
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
    case 'cfg': return showConfig(ctx, value);
    case 'power': return powerConfig(ctx, value);
    case 'rename': return startRename(ctx, value);
    case 'newlink': return newLink(ctx, value);
    case 'renew': return showPlans(ctx, value);
    case 'trial': return startTrial(ctx);
    case 'custom': {
      const renewing = value ? myConfig(ctx, value) : null;
      return startCustom(ctx, renewing ? renewing.id : '');
    }
    case 'support': return openSupport(ctx);
    case 'answer': return startAnswer(ctx, value);
    case 'joined': {
      const ok = await isMember(ctx.userId, true);
      if (!ok) {
        if (ctx.answer) ctx.answer('هنوز عضو کانال نشده‌اید. بعد از عضویت دوباره بزنید.', true);
        return null;
      }
      if (ctx.answer) ctx.answer('عضویت تایید شد ✅');
      return showScreen(ctx, 'start');
    }
    /* `planId` on its own is a new purchase; a second part is the short id of
       the config being topped up, which skips the name question. It is turned
       back into the real id here so nothing downstream deals in prefixes. */
    case 'buy': {
      const [planId, token] = String(value).split(':');
      const renewing = token ? myConfig(ctx, token) : null;
      return askName(ctx, planId, renewing ? renewing.id : '');
    }
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

    /*
     * The admin answering somebody. This comes first: an admin replying to a
     * relayed message means that reply for that person, not a command for the
     * bot, and anything after this point would read it as one.
     */
    if (ctx.isAdmin && message.reply_to_message) {
      if (await fromSupport(ctx, message)) return null;
    }
    /* or via the answer button, which named who they are answering */
    const answering = expected(ctx.userId);
    if (ctx.isAdmin && answering && answering.kind === 'supportReply' && !text.startsWith('/')) {
      forget(ctx.userId);
      if (await fromSupport(ctx, message, answering.data.target)) return null;
    }

    const waiting = openOrder(ctx.userId);
    const looksLikeHash = /^[A-Za-z0-9:_-]{12,}$/.test(text);
    if (waiting && (message.photo || message.document
      || (waiting.method === 'crypto' && looksLikeHash))) {
      if (await takeReceipt(ctx, message)) return null;
    }

    /*
     * A support conversation is open, so this is for the admin - whatever it
     * is. Checked before the empty-text return, because a screenshot of an
     * error is the most useful thing somebody can send to support and it
     * carries no text at all.
     */
    const inSupport = expected(ctx.userId);
    if (inSupport && inSupport.kind === 'support' && !ctx.isAdmin && !text.startsWith('/')) {
      if (await gate(ctx)) return null;
      await toSupport(ctx, message);
      return null;
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
      if (waitingFor.kind === 'customGB') return takeCustomGB(ctx, text, waitingFor);
      if (waitingFor.kind === 'orderName') return takeOrderName(ctx, text, waitingFor);
      if (waitingFor.kind === 'renameConfig') return takeRename(ctx, text, waitingFor);
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
    /*
     * Walking away ends the support conversation. Without this, somebody who
     * taps Support, changes their mind, goes to look at their configs and then
     * types anything at all has it land in the admin's chat.
     */
    if (action !== 'support') {
      const open = expected(ctx.userId);
      if (open && open.kind === 'support') forget(ctx.userId);
    }
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
  /* also here, not only on a panel restart: somebody whose menu lost a button
     should get it back by pressing Start, which is the obvious thing to try */
  migrateUsageButton();
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
/*
 * Put back the inbound on configs that were sold without one.
 *
 * Between the change that let a client sit on several inbounds and this, a
 * client created by the bot came out attached to none at all: the caller named
 * the inbound as an argument and put nothing in the body, and only the body
 * was read. Xray never heard of those configs, their subscription link came
 * back empty, and what the buyer paid for would not import into anything.
 *
 * Only configs the bot made are touched - they carry the buyer's Telegram id -
 * and only ones on no inbound whatever. A client the admin detached on purpose
 * has no Telegram id on it and is left exactly where they left it. The inbound
 * is the one the plan it was sold on names, or the one test configs are made
 * on, or failing both the first inbound that is switched on.
 */
async function repairOrphanClients() {
  const d = db.data;
  const b = bot();
  const fallback = (d.inbounds.find((i) => i.enable !== false) || d.inbounds[0] || {}).id || '';
  if (!fallback) return { fixed: 0, reason: 'there are no inbounds to attach them to' };

  const inboundFor = (client) => {
    const order = (b.orders || []).find((o) => o.clientId === client.id);
    const plan = order && (b.plans || []).find((p) => p.id === order.planId);
    const known = [
      plan && plan.inboundId,
      client.isTrial && (b.trial || {}).inboundId,
      fallback
    ];
    return known.find((id) => id && d.inbounds.some((i) => i.id === id)) || '';
  };

  let fixed = 0;
  for (const client of d.clients) {
    if (!String(client.tgId || '').trim()) continue;
    if (membership.inboundIdsOf(client).length) continue;
    const id = inboundFor(client);
    if (!id) continue;
    membership.setInbounds(client, [id]);
    fixed++;
  }
  if (!fixed) return { fixed: 0 };

  db.saveNow();
  d.logs.unshift({ at: Date.now(), type: 'client',
    message: `${fixed} config(s) sold by the bot had no inbound and have been put back on one` });
  await require('./xray').apply();
  return { fixed };
}

function resume() {
  const b = bot();
  migrateStarter();
  migrateUsageButton();
  if (b.enabled && b.token) start().catch((err) => { runtime.error = err.message; });
}

module.exports = {
  bot, defaults, starterScreens, migrateStarter, migrateUsageButton, start, stop, status, whoAmI, resume,
  resetTrials, trialsTaken, repairOrphanClients,
  send, escapeHtml, payWays, call, channel, gateOn, joinLink, adminChat, buyerLines,
  /* the entry point for one update: what the polling loop feeds, and what a
     webhook would feed if this ever grows one */
  handle
};
