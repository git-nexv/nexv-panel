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
const http = require('http');
const db = require('./db');
const membership = require('./membership');
const paygate = require('./paygate');
const links = require('./links');

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

/**
 * The guide, on a bot that was set up before there was one.
 *
 * Every one of these questions - which app, where do I paste this - arrives
 * after the sale and the answer never changes, so a menu without it is a menu
 * that sends them to support instead. The screens are added if they are not
 * there and the button is put on the start menu; a screen the admin has since
 * edited is left exactly as they left it.
 */
function migrateHelp() {
  const b = bot();
  const starter = starterScreens();
  let touched = false;

  for (const key of ['help', 'help-android', 'help-ios', 'help-tv']) {
    if ((b.screens || []).some((screen) => screen.key === key)) continue;
    const fresh = starter.find((screen) => screen.key === key);
    if (fresh) { b.screens.push(JSON.parse(JSON.stringify(fresh))); touched = true; }
  }

  /*
   * The keys that pick a device, on a guide that has lost them.
   *
   * A guide screen that already existed was left exactly as it was, which is
   * right for the wording - those are the admin's words - but not for the way
   * out of it. A bot whose help screen carried only a back key showed its
   * buyers "choose your device" above no devices to choose, and nothing ever
   * put them back, because the screen existed and so was skipped. Each device
   * key is checked for on its own and added above the back row if it is gone;
   * one the admin has deliberately rearranged is already there, so this does
   * nothing to it.
   */
  const help = (b.screens || []).find((screen) => screen.key === 'help');
  if (help) {
    if (help.text === OLD_HELP_TEXT) { help.text = HELP_TEXT; touched = true; }
    help.buttons = help.buttons || [];
    const links = (value) => help.buttons
      .some((row) => row.some((x) => x.action === 'screen' && x.value === value));
    const missing = [
      { label: '📱 اندروید', action: 'screen', value: 'help-android' },
      { label: '🍎 آیفون', action: 'screen', value: 'help-ios' },
      { label: '📺 تلویزیون', action: 'screen', value: 'help-tv' }
    ].filter((x) => !links(x.value));
    if (missing.length) {
      const backAt = help.buttons.findIndex((row) => row.some((x) => x.value === 'start'));
      const rows = [];
      // two to a row, the way the rest of this menu is laid out
      for (let i = 0; i < missing.length; i += 2) rows.push(missing.slice(i, i + 2));
      help.buttons.splice(backAt >= 0 ? backAt : help.buttons.length, 0, ...rows);
      touched = true;
    }
  }

  /*
   * A button that opens the guide, however the admin has rearranged the menu.
   *
   * Only the start screen counts. Looking at every screen found the "back"
   * buttons inside the guide itself - they point at `help` too - decided the
   * menu already offered it, and added nothing. The screens appeared and the
   * way in never did, which is exactly "the guide was not added to the menu".
   */
  const start = (b.screens || []).find((screen) => screen.key === 'start');
  const offersHelp = ((start || {}).buttons || [])
    .some((row) => row.some((x) => x.action === 'screen' && x.value === 'help'));
  if (!offersHelp) {
    if (addToStart(b.screens, { label: '❓ راهنما', action: 'screen', value: 'help' })) touched = true;
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
      crypto: { enable: false, wallets: [] },
      /* the online gateway, built from whatever API description the admin
         imported rather than from any one provider's names */
      gateway: require('./paygate').blank()
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

    /*
     * Buying by the gigabyte instead of from the fixed list.
     *
     * `terms` is how long they may buy it for. The first one is the base - the
     * volume's own price and nothing else - and each of the others adds what
     * the admin put against it, so six months at a discount or a premium is
     * theirs to set. Any of them can be switched off and then it is not
     * offered.
     */
    custom: {
      enable: false, minGB: 1, maxGB: 0, days: 30, inboundId: '',
      terms: [
        { months: 1, enable: true, extra: 0 },
        { months: 3, enable: true, extra: 0 },
        { months: 6, enable: true, extra: 0 },
        { months: 12, enable: true, extra: 0 }
      ]
    },

    /*
     * Whether a config's days start when it is paid for or when it is first
     * used.
     *
     * At the sale, by default. Waiting for first use is kinder in theory -
     * somebody who buys on Monday and installs on Friday has not lost four
     * days - but what it does in practice is sell a "60 day" service that has
     * no expiry date anywhere, in the panel or in the bot, until the buyer
     * happens to move some traffic. If they never do, or the stats poll never
     * sees it, the config runs for ever. A shop that sells by the month needs
     * the month to start when it is paid for; the other way round is here for
     * anyone who wants it, but it is not what you get by asking for nothing.
     */
    startOnFirstUse: false,

    /*
     * The colour of the keyboard buttons in the bot.
     *
     * Telegram added this in 2026: 'success' is green, 'primary' blue,
     * 'danger' red, and a client older than that simply draws the button the
     * way it always did - so there is nothing to lose by asking for a colour.
     * Green by default, because that is what a shop looks like; '' leaves
     * every button the app's own colour.
     */
    buttonStyle: 'success',

    /* what the buyer is allowed to decide for themselves rather than be given */
    access: { chooseName: true },

    /*
     * The panel's own backup, sent to the admin's chat.
     *
     * A backup that only exists on the server it is a backup of is not a
     * backup - it goes down with the machine. Telegram is the one place the
     * admin already has, on a phone, off this server, so the file goes there.
     *
     * `times` are wall-clock times of day in the admin's own day, which is
     * what `tzOffset` is for: a server set to UTC would otherwise send the
     * "three in the morning" backup at half past six in the evening in Tehran.
     * Tehran is the default because that is who asked for this.
     */
    backup: {
      enable: false,
      times: ['03:00'],
      tzOffset: 210,
      lastKey: '',
      lastAt: 0,
      lastError: ''
    }
  };
}

/** What a brand-new bot says before anyone has edited it. */
/* -------------------------------- the guide ------------------------------- */
/*
 * What to install and what to do with the link, per device.
 *
 * Written out rather than left to support, because every one of these
 * questions arrives after the sale and the answer is always the same. One app
 * leads on each device - the one that gives the fewest people trouble - and
 * the others are there for when it does.
 */
/* the guide's front page used to carry the whole subscription explanation, with
   the device keys below all of it; while a bot still has those exact words,
   give it the short page instead - an admin who rewrote it is left alone */
const OLD_HELP_TEXT = [
  '<b>راهنمای اتصال</b>',
  '',
  'دستگاهتان را انتخاب کنید تا بگویم کدام برنامه را نصب کنید و چطور وصل شوید.',
  '',
  '🔗 <b>لینک اشتراک چیست؟</b>',
  'همان خطی که بعد از خرید برایتان فرستادیم و با <code>https://</code> شروع می‌شود.',
  'آن را در برنامه به‌عنوان <b>Subscription</b> اضافه می‌کنید و برنامه خودش همه‌ی سرورها را می‌گیرد.',
  'اگر سرورها عوض شوند، فقط کافی است داخل برنامه آپدیت بزنید — لینک همان می‌ماند.',
  '',
  '⚙️ <b>کانفیگ مستقیم چیست؟</b>',
  'خطی که با <code>vless://</code> یا <code>vmess://</code> شروع می‌شود و فقط <b>یک</b> سرور است.',
  'وقتی به کارتان می‌آید که برنامه‌تان ساب قبول نکند. در برنامه دنبال «افزودن از کلیپ‌بورد» بگردید.',
  '',
  'همیشه اول ساب را امتحان کنید؛ کانفیگ مستقیم فقط جایگزین است.'
].join('\n');

const HELP_TEXT = [
  '<b>راهنمای اتصال</b>',
  '',
  'دستگاهتان را انتخاب کنید 👇'
].join('\n');

/*
 * What a subscription link is, on top of each device's page.
 *
 * This used to be the whole front page of the guide, so the buyer met three
 * paragraphs about links before being told which app to install - and the
 * device keys sat under all of it. The question is only ever asked while
 * following the steps, so it is answered where the steps are: each page now
 * stands on its own and the front page is one line and three keys.
 */
const HELP_LINKS = [
  '🔗 <b>لینک اشتراک</b> همان خطی است که بعد از خرید برایتان فرستادیم و با <code>https://</code> شروع می‌شود.',
  'آن را به‌عنوان <b>Subscription</b> اضافه می‌کنید و برنامه خودش همه‌ی سرورها را می‌گیرد.',
  '',
  '⚙️ <b>کانفیگ مستقیم</b> خطی است که با <code>vless://</code> شروع می‌شود و فقط یک سرور است؛ فقط وقتی لازم است که برنامه ساب قبول نکند.',
  '',
  '━━━━━━━━━━'
].join('\n');

const HELP_ANDROID = [
  '<b>📱 اندروید</b>',
  '',
  HELP_LINKS,
  '',
  '<b>۱) V2Box</b> — پیشنهاد اول',
  '۱. از Google Play برنامه <b>V2Box</b> را نصب کنید.',
  '۲. لینک اشتراک را کپی کنید.',
  '۳. در برنامه به تب <b>Configs</b> بروید.',
  '۴. بالا سمت راست <b>+</b> را بزنید و <b>Add Subscription</b> را انتخاب کنید.',
  '۵. لینک را در کادر URL بچسبانید، یک اسم دلخواه بگذارید و <b>SAVE</b> بزنید.',
  '۶. روی سروری که آمد بزنید تا تیک بخورد، بعد به تب <b>Home</b> بروید و دکمه‌ی وسط را بزنید.',
  '',
  '<b>۲) v2rayNG</b> — اگر V2Box مشکل داشت',
  '۱. برنامه <b>v2rayNG</b> را نصب کنید.',
  '۲. <b>+</b> بالای صفحه ← <b>Import config from clipboard</b> برای کانفیگ مستقیم،',
  '   یا <b>+</b> ← <b>Subscription group</b> برای لینک ساب.',
  '۳. از منوی سه‌خط ← <b>Subscription group update</b> بزنید تا سرورها بیایند.',
  '۴. یک سرور را انتخاب و دکمه‌ی پایین راست (V) را بزنید.',
  '',
  '<b>۳) Happ</b> — ساده‌ترین',
  '۱. برنامه <b>Happ</b> را نصب کنید.',
  '۲. لینک اشتراک را کپی کنید؛ برنامه را باز کنید و <b>+</b> را بزنید.',
  '۳. لینک را بچسبانید و وصل شوید.',
  '',
  '⚠️ اولین بار اندروید اجازه‌ی VPN می‌خواهد — <b>OK</b> را بزنید.'
].join('\n');

const HELP_IOS = [
  '<b>🍎 آیفون و آیپد</b>',
  '',
  HELP_LINKS,
  '',
  '<b>۱) V2Box</b> — پیشنهاد اول',
  '۱. از App Store برنامه <b>V2Box - V2ray Client</b> را نصب کنید.',
  '۲. لینک اشتراک را کپی کنید.',
  '۳. در برنامه به تب <b>Configs</b> بروید.',
  '۴. بالا سمت راست <b>+</b> ← <b>Add Subscription</b>.',
  '۵. لینک را بچسبانید، یک اسم بگذارید و <b>SAVE</b> بزنید.',
  '۶. روی سرور بزنید تا تیک بخورد، بعد تب <b>Home</b> و دکمه‌ی وسط.',
  '',
  '<b>۲) Streisand</b> — اگر V2Box مشکل داشت',
  '۱. برنامه <b>Streisand</b> را نصب کنید.',
  '۲. بالا سمت راست <b>+</b> ← <b>افزودن از کلیپ‌بورد</b> (لینک را از قبل کپی کنید).',
  '۳. از بالا <b>Subscription</b> را آپدیت کنید و یک سرور را انتخاب کنید.',
  '۴. دکمه‌ی اتصال را بزنید.',
  '',
  '<b>۳) Happ</b> — ساده‌ترین',
  '۱. برنامه <b>Happ</b> را نصب کنید.',
  '۲. لینک را کپی کنید، <b>+</b> را بزنید و بچسبانید.',
  '',
  '⚠️ اولین بار آیفون می‌پرسد VPN اضافه شود — <b>Allow</b> و بعد رمز/Face ID.',
  'اگر برنامه در App Store ایران پیدا نشد، اکانت App Store را روی کشور دیگری بگذارید.'
].join('\n');

const HELP_TV = [
  '<b>📺 تلویزیون (اندروید تی‌وی)</b>',
  '',
  HELP_LINKS,
  '',
  '<b>Happ</b> — روی تلویزیون از همه راحت‌تر است.',
  '',
  '۱. در تلویزیون وارد <b>Google Play</b> شوید و <b>Happ</b> را نصب کنید.',
  '   اگر نبود، فایل APK آن را با <b>Downloader</b> نصب کنید.',
  '۲. برنامه را باز کنید و <b>+</b> را بزنید.',
  '۳. تایپ لینک با ریموت سخت است — دو راه ساده‌تر:',
  '   • گزینه‌ی <b>Scan QR</b> را بزنید و کیو‌آری که در همین چت فرستادیم را جلوی دوربین بگیرید؛',
  '   • یا برنامه‌ی <b>Remote</b> گوگل روی گوشی را به تلویزیون وصل کنید و با کیبورد گوشی بچسبانید.',
  '۴. سرور را انتخاب و وصل شوید.',
  '',
  '⚠️ تلویزیون باید به همان اینترنتی وصل باشد که گوشی‌تان کار می‌کند.'
].join('\n');

function starterScreens() {
  return [
    {
      key: 'start',
      title: 'خوش‌آمد',
      text: 'سلام {name} 👋\n\nبه {brand} خوش آمدید. یکی از گزینه‌های زیر را انتخاب کنید.',
      buttons: [
        [{ label: '🛒 خرید اشتراک', action: 'plans' }],
        [{ label: '🔑 کانفیگ‌های من', action: 'configs' }, { label: '🎁 کانفیگ تست', action: 'trial' }],
        [{ label: '❓ راهنما', action: 'screen', value: 'help' }, { label: '💬 پشتیبانی', action: 'support' }]
      ]
    },
    {
      key: 'help',
      title: 'راهنما',
      text: HELP_TEXT,
      buttons: [
        [{ label: '📱 اندروید', action: 'screen', value: 'help-android' },
          { label: '🍎 آیفون', action: 'screen', value: 'help-ios' }],
        [{ label: '📺 تلویزیون', action: 'screen', value: 'help-tv' }],
        [{ label: '⬅️ بازگشت', action: 'screen', value: 'start' }]
      ]
    },
    {
      key: 'help-android',
      title: 'راهنمای اندروید',
      text: HELP_ANDROID,
      buttons: [[{ label: '⬅️ بازگشت', action: 'screen', value: 'help' }]]
    },
    {
      key: 'help-ios',
      title: 'راهنمای آیفون',
      text: HELP_IOS,
      buttons: [[{ label: '⬅️ بازگشت', action: 'screen', value: 'help' }]]
    },
    {
      key: 'help-tv',
      title: 'راهنمای تلویزیون',
      text: HELP_TV,
      buttons: [[{ label: '⬅️ بازگشت', action: 'screen', value: 'help' }]]
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

/*
 * Reaching Telegram from a server that cannot reach Telegram.
 *
 * A box in Iran has api.telegram.org filtered, so the bot never starts: it is
 * not that messages are slow, it is that getMe never answers and nothing comes
 * up. The same box is usually already selling its way out - an outbound abroad
 * that its clients use all day - so the bot is sent through that one too.
 *
 * Xray carries it. When an outbound is chosen, the config grows a plain HTTP
 * proxy on the loopback whose every connection is pinned to that outbound, and
 * the request below is opened through it with a CONNECT rather than straight
 * out. CONNECT is used in preference to a SOCKS library because it needs
 * nothing that is not already in Node: the panel installs with no build step
 * and that is worth keeping.
 */
function viaProxy() {
  const tag = String(bot().viaOutbound || '').trim();
  return tag && tag !== 'direct' ? tag : '';
}

/**
 * A socket already tunnelled to host:port through the local proxy.
 *
 * The error says which outbound was being used and that Xray has to be up,
 * because those are the two things that are ever wrong here and neither is
 * guessable from "connect ECONNREFUSED 127.0.0.1:62790".
 */
function tunnel(host, port) {
  const tag = viaProxy();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: require('./xray').BOT_PROXY_PORT,
      method: 'CONNECT',
      path: `${host}:${port}`,
      timeout: 20000
    });
    const fail = (why) => reject(new Error(
      `could not reach Telegram through outbound "${tag}": ${why}. `
      + 'Xray has to be running for the bot to use an outbound.'
    ));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(`the proxy answered ${res.statusCode}`);
      }
      resolve(socket);
    });
    req.on('timeout', () => { req.destroy(); fail('it did not answer in time'); });
    req.on('error', (err) => fail(err.message));
    req.end();
  });
}

/**
 * The options every call to Telegram is made with - plus, when an outbound is
 * chosen, the already-connected socket to run the TLS over.
 */
async function apiOptions(extra) {
  const host = API_HOST;
  const port = API_PORT ? Number(API_PORT) : 443;
  const options = Object.assign({ host, port, method: 'POST' }, extra);
  if (viaProxy()) {
    const socket = await tunnel(host, port);
    options.socket = socket;
    options.agent = false;
    // the certificate is still checked, against the name we asked for
    options.servername = host;
  }
  return options;
}



async function call(method, payload, token) {
  const body = JSON.stringify(payload || {});
  const key = token || bot().token;
  const options = await apiOptions({
    path: `/bot${key}/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: 40000
  });
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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

/*
 * Anything that undoes, cuts off or refuses, which must never be green.
 *
 * Matched on the action in the callback rather than on the label, because the
 * label is the admin's to rewrite and the action is not.
 */
const DESTRUCTIVE = /^b:(cancel|del|delyes|no|power)\b/;

/*
 * The keys that get the colour, and they are few.
 *
 * Two only: the buy entry in the menu, and going back. Colouring every key was
 * worse than colouring none - when everything is green nothing stands out, and
 * the one key the shop actually wants pressed looks like all the others.
 *
 * The plans behind that entry (b:buy) were green too and are not any more.
 * Once the buyer is looking at a list of sizes they have already decided to
 * buy; painting 10 GB and 30 GB the same green says nothing about which to
 * pick, and spends the colour that was meant to carry them into the list.
 */
const COLOURED = /^b:plans\b/;
const BACK_ARROW = /^\s*⬅️/;

/**
 * Paint the keyboard.
 *
 * One place, so every message the bot sends is coloured the same way without
 * each caller remembering to. A button that already names its own style keeps
 * it, and a shop that wants no colour at all sets the style to nothing.
 */
function styled(keyboard) {
  const want = bot().buttonStyle;
  if (!Array.isArray(keyboard)) return keyboard;
  return keyboard.map((row) => (Array.isArray(row) ? row.map((button) => {
    if (!button || button.style) return button;
    const data = String(button.callback_data || '');

    // anything that undoes or refuses is red whatever the shop chose
    if (DESTRUCTIVE.test(data)) return Object.assign({}, button, { style: 'danger' });
    if (!want) return button;

    /* back is matched on the arrow rather than the action: every back key
       carries it, and the same action behind a different label - the guide's
       own entry on the start menu - is not one */
    const isBack = BACK_ARROW.test(String(button.text || ''));
    if (COLOURED.test(data) || isBack) return Object.assign({}, button, { style: want });
    return button;
  }) : row));
}

function send(chatId, text, keyboard) {
  runtime.sent++;
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: styled(keyboard) } : undefined
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
    reply_markup: keyboard ? { inline_keyboard: styled(keyboard) } : undefined
  }).catch((err) => { runtime.error = err.message; });
}

function sendDocument(chatId, fileId, caption, keyboard) {
  runtime.sent++;
  return call('sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption,
    parse_mode: 'HTML',
    reply_markup: keyboard ? { inline_keyboard: styled(keyboard) } : undefined
  }).catch((err) => { runtime.error = err.message; });
}

/**
 * Send a file the panel made, rather than one Telegram already holds.
 *
 * `sendDocument` above takes a file_id - a file Telegram has seen before. A
 * backup has never been anywhere, so it has to be uploaded, and uploading
 * means multipart/form-data, which is the one request here that is not JSON.
 */
function uploadDocument(chatId, filename, content, caption) {
  return upload('sendDocument', 'document', 'application/json',
    chatId, filename, content, caption);
}

/**
 * A picture the panel drew, with a caption and keys under it.
 *
 * A QR code has never been anywhere near Telegram, so like a backup it has to
 * be uploaded rather than named by file_id.
 */
function uploadPhoto(chatId, filename, content, caption, keyboard) {
  return upload('sendPhoto', 'photo', 'image/png',
    chatId, filename, content, caption, keyboard);
}

/** The one multipart request in a module where everything else is JSON. */
async function upload(method, field, contentType, chatId, filename, content, caption, keyboard) {
  const boundary = `----nexv${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const part = (name, value) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const body = Buffer.concat([
    part('chat_id', chatId),
    part('caption', caption || ''),
    part('parse_mode', 'HTML'),
    ...(keyboard ? [part('reply_markup', JSON.stringify({ inline_keyboard: styled(keyboard) }))] : []),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const options = await apiOptions({
    path: `/bot${bot().token}/${method}`,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length
    },
    // a big store over a slow link needs longer than a message does
    timeout: 120000
  });
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { return reject(new Error('Telegram sent something that is not JSON')); }
        if (!parsed.ok) return reject(new Error(parsed.description || 'Telegram refused the file'));
        runtime.sent++;
        resolve(parsed.result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

function edit(chatId, messageId, text, keyboard) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: styled(keyboard) } : undefined
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

/* a month, as this panel counts one */
const DAYS_PER_MONTH = 30;

/**
 * How long a custom config may be bought for, and what each length adds.
 *
 * Settings written before this have no terms at all; they get the four the
 * panel ships with, the first of which costs nothing extra by definition - it
 * is the volume's own price. One with no months on it is dropped rather than
 * offered as a button that means nothing.
 */
function customTerms() {
  const raw = (bot().custom || {}).terms;
  const list = Array.isArray(raw) && raw.length ? raw : defaults().custom.terms;
  return list
    .map((t) => ({
      months: Math.max(1, Math.round(Number(t.months) || 0)),
      enable: t.enable !== false,
      // the first month is the base price; nothing is added to it
      extra: Math.max(0, Math.round(Number(t.extra) || 0))
    }))
    .filter((t) => t.months > 0)
    .sort((a, b) => a.months - b.months);
}

/** The ones a buyer actually sees. */
function offeredTerms() {
  return customTerms().filter((t) => t.enable);
}

/**
 * What the custom-volume option is called, which depends on what it offers.
 *
 * With more than one length switched on the buyer really does choose both,
 * and the button should say so. With one - or none - the length is fixed and
 * the only thing they pick is the volume, so promising a choice of time would
 * be a promise the next screen does not keep.
 */
function customLabel() {
  return offeredTerms().length > 1 ? 'حجم و زمان دلخواه' : 'حجم دلخواه';
}

/** Does the buyer get to pick how long, as well as how much? */
function picksTerm() {
  return offeredTerms().length > 1;
}

/*
 * What a length adds on top of the volume.
 *
 * One month adds nothing - it is the volume's own price, which is the rate the
 * admin already set per gigabyte. Every other length carries whatever they
 * wrote against it. Tied to the month and not to "whichever is shortest on the
 * list", so switching the one-month option off does not silently make three
 * months free.
 */
function extraFor(term) {
  return term.months <= 1 ? 0 : term.extra;
}

/** Whether a config sold now should start its clock now or on first use. */
function startsOnFirstUse() {
  return bot().startOnFirstUse === true;
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
  if (customOn()) rows.push([{ text: `🎚 ${customLabel()}`, callback_data: `b:custom:${renewId || ''}` }]);
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
  if (!customOn()) return reply(ctx, `خرید ${customLabel()} فعلاً فعال نیست.`, backRow());
  const c = customSettings();
  const per = pricePerGB();
  expect(ctx.userId, 'customGB', { renewId: renewId || '' });
  return reply(ctx, [
    `<b>${customLabel()}</b>`,
    `هر گیگابایت ${per.toLocaleString('en-US')} ${escapeHtml(bot().currency || '')}`,
    `حداقل ${c.minGB} گیگ${c.maxGB ? ` و حداکثر ${c.maxGB} گیگ` : ''}`,
    '',
    'چند گیگابایت می‌خواهید؟ فقط عدد بفرستید.',
    /* only when there is really a second question coming */
    picksTerm() ? 'بعد از حجم، مدت را هم خودتان انتخاب می‌کنید.' : ''
  ].filter(Boolean).join('\n'), backRow());
}

/*
 * The volume is settled; now for how long.
 *
 * The gigabytes are held rather than turned into a plan straight away, because
 * what a plan costs is the volume plus whatever the chosen length adds, and
 * neither number is worth writing down until both are known. Only the lengths
 * the admin left switched on are offered, and the shortest of them is the base
 * - it is the volume's own price and adds nothing.
 */
async function takeCustomGB(ctx, raw, waiting) {
  const c = customSettings();
  const renewId = (waiting && waiting.data && waiting.data.renewId) || '';
  const gb = Math.floor(Number(String(raw).replace(/[^\d.]/g, '')));
  if (!Number.isFinite(gb) || gb <= 0) return send(ctx.chatId, 'یک عدد بفرستید، مثلاً 20');
  if (gb < c.minGB) return send(ctx.chatId, `حداقل ${c.minGB} گیگابایت است.`);
  if (c.maxGB && gb > c.maxGB) return send(ctx.chatId, `حداکثر ${c.maxGB} گیگابایت است.`);

  const terms = offeredTerms();
  // nothing to choose between: keep the old single-length behaviour
  if (terms.length <= 1) {
    forget(ctx.userId);
    const only = terms[0];
    return makeCustomPlan(ctx, gb, only ? only.months * DAYS_PER_MONTH : c.days, 0, renewId);
  }

  expect(ctx.userId, 'customTerm', { gb, renewId });
  const per = pricePerGB();
  const cur = escapeHtml(bot().currency || '');
  /* two to a row: four lengths stacked made a column of buttons taller than
     the message that asked the question */
  const keys = terms.map((t) => {
    const total = gb * per + extraFor(t);
    return { text: `${monthWord(t.months)} — ${total.toLocaleString('en-US')} ${bot().currency || ''}`.trim(),
      callback_data: `b:term:${t.months}` };
  });
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2));
  rows.push(backRow()[0]);
  return reply(ctx, [
    `<b>${gb} گیگابایت</b>`,
    `هر گیگابایت ${per.toLocaleString('en-US')} ${cur}`,
    '',
    '🗓 برای چه مدتی می‌خواهید؟'
  ].join('\n'), rows);
}

/** "۳ ماهه", in words a buyer reads rather than a number of days. */
function monthWord(months) {
  if (months === 1) return '۱ ماهه';
  const fa = { 2: '۲', 3: '۳', 4: '۴', 5: '۵', 6: '۶', 9: '۹', 12: '۱۲' }[months];
  return `${fa || months} ماهه`;
}

/** The length was picked: now there is a price, so there is a plan. */
async function takeCustomTerm(ctx, months, waiting) {
  const data = (waiting && waiting.data) || {};
  const gb = Number(data.gb) || 0;
  if (!gb) { forget(ctx.userId); return showPlans(ctx); }
  const terms = offeredTerms();
  const term = terms.find((t) => t.months === Number(months));
  if (!term) return null;
  forget(ctx.userId);
  return makeCustomPlan(ctx, gb, term.months * DAYS_PER_MONTH, extraFor(term), data.renewId || '');
}

/*
 * A custom purchase is an ordinary order with a plan made up on the spot, so
 * everything downstream - the receipt, the admin's approve button, delivery -
 * works on it without knowing it was not from the list.
 */
async function makeCustomPlan(ctx, gb, days, extra, renewId) {
  const c = customSettings();
  const b = bot();
  const months = Math.max(1, Math.round(days / DAYS_PER_MONTH));
  const plan = {
    id: `custom-${db.id()}`,
    name: `${gb} گیگابایت · ${monthWord(months)}`,
    gb,
    days,
    price: String(gb * pricePerGB() + (Number(extra) || 0)),
    enable: true,
    custom: true
  };
  if (!sellingInbounds().length) return send(ctx.chatId, 'اینباندی برای فروش تنظیم نشده است.');
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
    [
      { text: '🔗 لینک جدید', callback_data: `b:newlink:${id}` },
      { text: '🗑 حذف کانفیگ', callback_data: `b:del:${id}` }
    ],
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

/*
 * Deleting a config, which is the one thing here that cannot be undone.
 *
 * So it is asked first, plainly, with what is about to be lost spelled out -
 * how much of the volume is still unused and how long it still had to run -
 * and the two answers as buttons rather than a word to type.
 */
async function askDelete(ctx, clientId) {
  const c = myConfig(ctx, clientId);
  if (!c) return showConfigs(ctx);
  const used = (c.up || 0) + (c.down || 0);
  const quota = (c.totalGB || 0) * 1024 ** 3;
  const id = shortId(c);

  const lines = [
    '⚠️ <b>حذف کانفیگ</b>',
    '',
    `کانفیگ <b>${escapeHtml(c.email)}</b> برای همیشه حذف می‌شود.`
  ];
  if (quota && used < quota) lines.push(`• ${bytes(quota - used)} حجم استفاده‌نشده از بین می‌رود`);
  if (c.expiryTime && c.expiryTime > Date.now()) lines.push(`• ${timeLeft(c)} از اعتبارش باقی مانده`);
  lines.push('• لینک اشتراکش دیگر کار نمی‌کند', '', 'این کار برگشت‌پذیر نیست. مطمئنید؟');

  return reply(ctx, lines.join('\n'), [
    [{ text: '✅ بله، حذف کن', callback_data: `b:delyes:${id}` }],
    [{ text: '❌ خیر، بازگشت', callback_data: `b:cfg:${id}` }]
  ]);
}

/**
 * Gone, not switched off.
 *
 * A config left disabled is still a client Xray carries, a row the panel draws
 * and a tag the address tracker keeps counting. Somebody who has finished with
 * one - or whose volume has run out - is better served by it being removed,
 * and so is the server.
 */
async function deleteConfig(ctx, clientId) {
  const c = myConfig(ctx, clientId);
  if (!c) return showConfigs(ctx);
  const name = c.email;
  await removeClient(c.id);
  if (ctx.answer) ctx.answer('حذف شد');
  await send(ctx.chatId, `کانفیگ <b>${escapeHtml(name)}</b> حذف شد.`);
  return showConfigs(ctx);
}

/**
 * Take one client out of the panel for good: the row, whatever the address
 * tracker remembers about it, and its place in the Xray config.
 */
async function removeClient(clientId) {
  const d = db.data;
  const client = d.clients.find((c) => c.id === clientId);
  if (!client) return false;
  const xray = require('./xray');
  try { require('./online').forget(xray.clientTag(client)); } catch (_) { /* nothing tracked */ }
  d.clients = d.clients.filter((c) => c.id !== clientId);
  db.saveNow();
  await xray.apply();
  return true;
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
    'نام تازه را بفرستید. فارسی یا انگلیسی، با فاصله هم اشکالی ندارد.'
  ].join('\n'), [[{ text: '⬅️ بازگشت', callback_data: `b:cfg:${shortId(c)}` }]]);
}

async function takeRename(ctx, raw, waiting) {
  const clientId = waiting && waiting.data && waiting.data.clientId;
  const c = myConfig(ctx, clientId);
  if (!c) { forget(ctx.userId); return showConfigs(ctx); }
  const wanted = uniqueName(cleanName(raw), c.id);
  if (!wanted) return send(ctx.chatId, 'یک اسم بفرستید.');
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

  if (!sellingInbounds().length) {
    return reply(ctx, 'هنوز اینباند فعالی برای کانفیگ تست وجود ندارد.', backRow());
  }

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
    'فارسی یا انگلیسی، با فاصله هم اشکالی ندارد.'
  ].join('\n'), backRow());
}

/*
 * The name the buyer typed, kept as they typed it.
 *
 * This used to throw away everything that was not a letter, a digit or one of
 * ._- which meant a Persian name came back empty and the bot then told its own
 * customer their name "does not work". Xray carries whatever is put here -
 * checked against the binary: a name with Persian letters, spaces and a # in
 * it configures, passes traffic and comes back correctly in the stats rows -
 * so there is nothing to strip for Xray's sake.
 *
 * Two things still go. Control characters, because a newline makes the export
 * unreadable to other panels. And '>', because the traffic counters are read
 * out of lines shaped user>>>name>>>traffic>>>uplink, and a name carrying
 * '>>>' would be read as the end of itself and lose its traffic.
 */
function cleanName(raw) {
  return String(raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/>/g, '')
    // runs of space become one space; the space itself stays
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
    .trim();
}

/*
 * A name nobody else is using. Two people may both want "ali", and refusing
 * the second one outright helps nobody, so the clash is settled here with a
 * number rather than handed back as an error.
 */
function uniqueName(wanted, exceptId) {
  if (!wanted) return '';
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
    'فارسی یا انگلیسی، هرطور دوست دارید — مثلاً <code>گوشی علی</code>.'
  ].join('\n'), [[{ text: '⬅️ بازگشت', callback_data: 'b:plans:' }]]);
}

async function takeOrderName(ctx, raw, waiting) {
  const planId = waiting && waiting.data && waiting.data.planId;
  const name = uniqueName(cleanName(raw));
  if (!name) return send(ctx.chatId, 'یک اسم بفرستید.');
  forget(ctx.userId);
  return placeOrder(ctx, planId, name, '');
}

async function takeTrialName(ctx, raw) {
  const t = trialSettings();
  const wanted = cleanName(raw);
  if (!wanted) return send(ctx.chatId, 'یک اسم بفرستید.');

  /* every inbound that is switched on, the same as a sale gets: one inbound
     is one thing that can be blocked, and the taster is what decides whether
     anybody buys at all */
  const selling = sellingInbounds();
  if (!selling.length) { forget(ctx.userId); return send(ctx.chatId, 'هیچ اینباند فعالی برای کانفیگ تست وجود ندارد.'); }
  const inbound = selling[0];

  // a name already in use would be refused outright, so it is made unique here
  const email = uniqueName(wanted);

  forget(ctx.userId);
  try {
    const client = await require('./routes/api').createClient(inbound, {
      email,
      inboundIds: selling.map((i) => i.id),
      totalGB: t.mb / 1024,                 // the quota is held in gigabytes
      /*
       * The same rule a sale gets, and not a rule of its own.
       *
       * This said "wait for first use" outright, whatever the panel was set
       * to - so a test config came out with no expiry date at all and ran
       * until somebody noticed. The days start at the sale by default, which
       * is what every other config here does.
       */
      startAfterFirstUse: startsOnFirstUse(),
      expiryDays: t.days,
      expiryTime: startsOnFirstUse() || !t.days ? 0 : Date.now() + t.days * 86400000,
      tgId: String(ctx.userId),
      tgUsername: ctx.username || '',
      isTrial: true,
      comment: 'کانفیگ تست - ربات'
    });
    markTrialTaken(ctx.userId);
    const url = require('./routes/api').subUrl(client.subId);
    return sendConfig(ctx.chatId, client,
      '<b>کانفیگ تست شما آماده شد ✅</b>',
      `${t.mb} مگابایت · ${t.days} روز`);
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

/*
 * What this person already has, for the admin about to answer them.
 *
 * Nearly every support message is about a config, and the first thing the
 * admin did was go and look up whether the sender had bought anything and
 * whether it had run out. That lookup is the answer to most of these messages,
 * so it arrives with the message instead: the live ones first, then the
 * finished ones, with the usage and the days each already carries elsewhere.
 *
 * Somebody who has bought nothing is worth saying out loud too - it is what
 * tells the admin they are talking to a stranger rather than a customer.
 */
function servicesLine(userId) {
  const mine = clientsOf(userId);
  if (!mine.length) return '<i>سرویس فعالی ندارد (چیزی از ربات نخریده).</i>';

  const live = mine.filter((c) => !dead(c));
  const gone = mine.filter((c) => dead(c));
  const out = [];
  if (live.length) {
    out.push(`<b>سرویس‌های فعال (${live.length}):</b>`);
    for (const c of live) out.push(`• ${escapeHtml(c.email)} — ${usageLines(c)}`);
  } else {
    out.push('<b>سرویس فعالی ندارد.</b>');
  }
  if (gone.length) {
    out.push(`<b>تمام‌شده (${gone.length}):</b>`);
    /* a long tail of dead configs would bury the live ones, so only the last
       few are named and the rest are counted */
    for (const c of gone.slice(-3)) out.push(`• ${escapeHtml(c.email)} — ${usageLines(c)}`);
    if (gone.length > 3) out.push(`• و ${gone.length - 3} مورد دیگر`);
  }
  return out.join('\n');
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
  /*
   * Sent through call() rather than send(), because send() swallows whatever
   * Telegram says and hands back nothing. That is what made this look broken:
   * the message to the admin failed, the failure went nowhere, and the buyer
   * was told their message had been delivered with a tick. A buyer who is
   * told it arrived does not send it again, and the admin never learns there
   * was anything to answer.
   *
   * The usual reason is Telegram's own rule: a bot may not open a chat with
   * somebody who has never pressed Start on it. An admin id that was typed
   * into the panel and never used to message the bot is unreachable, and no
   * amount of retrying changes that - which is why the reason is kept and
   * shown on the Bot page rather than just logged.
   */
  let header;
  try {
    header = await call('sendMessage', {
      chat_id: admin,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: [
        '<b>💬 پیام پشتیبانی</b>',
        whoLine(ctx),
        '',
        servicesLine(ctx.userId),
        '',
        'برای پاسخ، دکمه‌ی زیر را بزنید یا روی همین پیام ریپلای کنید.'
      ].join('\n'),
      reply_markup: { inline_keyboard: styled([[{ text: '✍️ پاسخ به این کاربر', callback_data: `b:answer:${ctx.userId}` }]]) }
    });
    runtime.sent++;
    runtime.adminError = '';
  } catch (err) {
    runtime.error = err.message;
    runtime.adminError = err.message;
    db.data.logs.unshift({ at: Date.now(), type: 'bot',
      message: `a support message could not be delivered to the admin (${admin}): ${err.message}` });
    if (db.data.logs.length > 500) db.data.logs.length = 500;
    db.save();
    await send(ctx.chatId, 'پیام شما فرستاده نشد — پشتیبانی در دسترس نیست. کمی بعد دوباره امتحان کنید.');
    return false;
  }
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
  /* the gateway first: it is the one that finishes by itself, and a buyer
     offered it alongside a card number will nearly always take it */
  if (paygate.ready()) ways.push('gateway');
  if (pay.card && pay.card.enable !== false && pay.card.number) ways.push('card');
  if (pay.crypto && pay.crypto.enable !== false && (pay.crypto.wallets || []).some((w) => w.address)) ways.push('crypto');
  return ways;
}

/**
 * The inbounds a sale is handed over on: every one that is switched on.
 *
 * It used to be one, named on the plan. That made the plan list an inbound
 * list as well, left the admin re-pointing every plan whenever an inbound was
 * replaced, and gave each buyer a single way in - so the day one inbound was
 * blocked, everybody on it was stuck until somebody moved them by hand. There
 * is nothing to choose here: a buyer gets all of them, and the admin takes one
 * away from a client afterwards if they ever want to.
 */
function sellingInbounds() {
  return (db.data.inbounds || []).filter((i) => i.enable !== false);
}

/** What each way is called on its button. */
function payLabel(way) {
  if (way === 'gateway') return paygate.settings().label || '🌐 پرداخت آنلاین';
  return { card: '💳 کارت به کارت', crypto: '🪙 ارز دیجیتال' }[way] || way;
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
    /* where to write back to. In a private chat it is the same number as the
       user id, which is why nothing missed it before - but an order settled
       minutes later by a webhook has no ctx to ask, and guessing is how a
       delivered config gets sent into the void */
    chatId: ctx.chatId || ctx.userId,
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
  return reply(ctx, [
    planLine(plan),
    order.clientName ? `نام کانفیگ: <b>${escapeHtml(order.clientName)}</b>` : '',
    '',
    '💰 پرداخت را چطور انجام می‌دهید؟'
  ].filter(Boolean).join('\n'),
  ways.map((way) => ([{ text: payLabel(way), callback_data: `b:pay:${order.id}:${way}` }]))
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

  if (method === 'gateway') return showGateway(ctx, order, lines);

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

/**
 * The online gateway: a link to pay at, and a key to say it is done.
 *
 * The link is asked for here rather than when the plan was chosen, so a buyer
 * who never gets this far never costs the shop one of its daily links. Asking
 * again for an order that already has one is safe - a gateway hands back the
 * bill it already made - so a buyer who comes back to a stale message gets the
 * same page rather than a second charge.
 *
 * Nothing is delivered on this screen. The buyer pressing "I have paid" only
 * makes the panel ask the gateway; the gateway's answer is what decides.
 */
async function showGateway(ctx, order, lines) {
  let link;
  try {
    link = await paygate.createLink(order);
  } catch (err) {
    order.status = 'awaiting';
    order.error = err.message;
    db.saveNow();
    await warnAdminAboutGateway(err.message);
    const other = payWays().filter((w) => w !== 'gateway');
    return reply(ctx, [
      '❌ درگاه پرداخت در دسترس نیست.',
      other.length ? 'می‌توانید از روش دیگری پرداخت کنید:' : 'کمی بعد دوباره تلاش کنید.'
    ].join('\n'),
    other.map((way) => ([{ text: payLabel(way), callback_data: `b:pay:${order.id}:${way}` }]))
      .concat([[{ text: '⬅️ بازگشت', callback_data: 'b:screen:start' }]]));
  }

  order.payToken = link.token;
  order.payRef = link.ref;
  order.payUrl = link.url;
  order.payAt = Date.now();
  db.saveNow();

  /* and from here it is watched closely, so a buyer who pays gets their
     config within seconds rather than on the next sweep */
  watchOrder(order.id);

  /* straight to the gateway's payment page, unless the shop has asked to go
     through the gateway's own Telegram bot instead */
  const url = paygate.payUrlOf(link);
  lines.push(
    `${escapeHtml(paygate.settings().label || '🌐 پرداخت آنلاین')}`,
    '',
    'روی دکمه زیر بزنید و پرداخت را انجام دهید. روش پرداخت را در همان صفحه انتخاب می‌کنید.',
    '',
    'پس از پرداخت، دکمه «پرداخت کردم» را بزنید تا بررسی شود — اگر هم نزدید، چند لحظه بعد خودکار بررسی می‌شود.'
  );

  return reply(ctx, lines.join('\n'), [
    [{ text: '💳 پرداخت', url }],
    [{ text: '✅ پرداخت کردم', callback_data: `b:paid:${shortOrder(order)}` }],
    [{ text: '✖️ انصراف', callback_data: `b:cancel:${order.id}` }]
  ]);
}

/*
 * An order id short enough to ride in a button.
 *
 * Telegram refuses a whole message over one callback_data above 64 bytes, and
 * says so in an error nobody sees - the message simply never arrives. Eight
 * characters of a uuid is plenty to tell a few hundred orders apart.
 */
function shortOrder(order) { return String(order.id).slice(0, 8); }

/**
 * The order a returning buyer's start payload names.
 *
 * The payload is what the gateway was handed as the return address, so it is
 * matched back through the very same function that built it rather than by
 * taking the string apart - one way to write it, one way to read it.
 */
function orderByPayRef(payload) {
  const wanted = String(payload || '').trim();
  if (!wanted) return null;
  return (bot().orders || []).find((o) => paygate.startPayload(o) === wanted) || null;
}

function orderByToken(token) {
  const key = String(token || '');
  const orders = bot().orders || [];
  return orders.find((o) => o.id === key) || orders.find((o) => String(o.id).startsWith(key)) || null;
}

/**
 * Ask the gateway whether this order was really paid, and hand it over if so.
 *
 * Shared by the buyer's button, the signed webhook and the sweep, because all
 * three mean the same thing and must not mean it three different ways. It is
 * safe to run twice: an order already delivered is left exactly as it is.
 */
async function settleGateway(order, how) {
  if (!order || order.method !== 'gateway') return { ok: false, reason: 'not a gateway order' };
  if (order.status === 'delivered' || order.status === 'approved') {
    return { ok: true, already: true };
  }

  let result;
  try {
    result = await paygate.verify(order);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!result.paid) return { ok: false, pending: result.ok, reason: result.reason || result.state || '' };

  order.paidAt = Date.now();
  order.paidVia = how || 'verify';
  db.saveNow();

  const handed = await deliverOrder(order);
  if (!handed.ok) {
    order.status = 'pending';
    order.error = handed.error;
    db.saveNow();
    await tellAdmin([
      '<b>پرداخت آنلاین انجام شد ولی تحویل نشد</b>',
      `اشتراک: ${escapeHtml(order.planName)}`,
      `مبلغ: ${escapeHtml(String(order.price))} ${escapeHtml(bot().currency)}`,
      ...buyerLines(order),
      '',
      `خطا: ${escapeHtml(handed.error || 'نامشخص')}`
    ].join('\n'), [[{ text: '✅ تحویل دستی', callback_data: `b:ok:${order.id}` }]]);
    return { ok: false, paid: true, reason: handed.error };
  }

  order.status = 'delivered';
  order.clientId = handed.client.id;
  db.saveNow();

  await sendConfig(order.chatId || order.userId, handed.client,
    '<b>پرداخت شما تایید شد ✅</b>', escapeHtml(order.planName));

  await tellAdmin([
    '<b>فروش آنلاین</b>',
    `اشتراک: ${escapeHtml(order.planName)}`,
    `مبلغ: ${escapeHtml(String(order.price))} ${escapeHtml(bot().currency)}`,
    ...buyerLines(order),
    '',
    `کانفیگ تحویل شد: <code>${escapeHtml(handed.client.email)}</code>`
  ].join('\n'));

  return { ok: true, delivered: true };
}

/**
 * Hand a config over the way somebody actually uses it.
 *
 * A link in a message is a link to be copied, and on a phone that is a long
 * press, a drag of two handles and a paste into the right box. The QR beside
 * it is one scan. Both go out, because the QR is useless on the device the
 * message is being read on and the text is what gets pasted there.
 *
 * The subscription is what leads. A subscription keeps working when an
 * inbound is replaced and carries every way in at once; a single config link
 * is one server that can stop working on its own. The config links go
 * underneath for anyone whose app will not take a subscription.
 */
/*
 * A block that arrives folded up and opens when it is tapped.
 *
 * A vless:// line is longer than a phone screen and there may be four of
 * them, so the message that mattered - the name, the subscription link, what
 * to do with it - was pushed off the top by a wall of characters nobody reads
 * and everybody scrolls past. Telegram folds a long quote by default and
 * opens it on a tap, which is exactly the shape this wants: out of the way
 * until it is wanted, and all there when it is.
 *
 * `expandable` is the attribute Telegram's own documentation names for it.
 */
function collapsed(lines) {
  return `<blockquote expandable>${lines.join('\n')}</blockquote>`;
}

/* the same message with the folding taken out, for the retry below */
function unfolded(text) {
  return text.replace(/<blockquote expandable>/g, '').replace(/<\/blockquote>/g, '');
}

/*
 * What Telegram counts towards a caption's 1024 characters is the text a
 * person sees, not the markup around it - so measuring the markup made long
 * messages fall out of the picture and into a second bubble for no reason.
 */
function visibleLength(text) {
  return text.replace(/<[^>]+>/g, '').length;
}

async function sendConfig(chatId, client, title, extra) {
  const api = require('./routes/api');
  const url = api.subUrl(client.subId);

  const lines = [
    title,
    `<b>${escapeHtml(client.email)}</b>`,
    ''
  ];
  if (extra) lines.push(extra, '');
  lines.push(
    '🔗  <b>لینک اشتراک</b>',
    `<code>${escapeHtml(url)}</code>`,
    '',
    'این لینک را در برنامه‌تان به‌عنوان <b>Subscription</b> اضافه کنید — بهترین راه، چون با تغییر سرورها خودش به‌روز می‌شود.'
  );

  /* the single links, for an app that will not take a subscription. Kept to a
     few: a message Telegram refuses for length is a config nobody received */
  const direct = directLinks(client).slice(0, 4);
  if (direct.length) {
    lines.push('', '⚙️  <b>کانفیگ مستقیم</b> — برای دیدن، روی کادر زیر بزنید');
    lines.push(collapsed(direct.map((one) => `<code>${escapeHtml(one)}</code>`)));
  }
  lines.push('', '❓ اگر بلد نیستید، از منوی اصلی <b>راهنما</b> را بزنید.');

  const text = lines.join('\n');
  const keys = [[{ text: '❓ راهنمای اتصال', callback_data: 'b:screen:help' }], ...backRow()];

  /*
   * The picture carries the message when it can - one bubble, not two - and
   * Telegram caps a caption at 1024 characters, so a long one falls back to
   * the QR on its own followed by the text.
   */
  /*
   * Never let the folding be the reason a config does not arrive. It is worth
   * a retry rather than a refusal: a buyer who has paid and received nothing
   * is a different kind of problem from a message that looks bulky.
   */
  const deliver = async (body, withQr) => {
    if (withQr) {
      try {
        const png = await qrPng(url);
        if (png && visibleLength(body) <= 1000) return await uploadPhoto(chatId, 'sub.png', png, body, keys);
        if (png) await uploadPhoto(chatId, 'sub.png', png, '🔗 لینک اشتراک شما');
      } catch (err) {
        if (process.env.NEXV_TG_DEBUG) console.error('[bot] qr:', err.message);
      }
    }
    return send(chatId, body, keys);
  };

  try {
    return await deliver(text, true);
  } catch (err) {
    const flat = unfolded(text);
    if (flat === text) throw err;
    /* the picture may already be there from the attempt that failed, so the
       retry is the words alone rather than a second QR of the same link */
    runtime.error = err.message;
    return deliver(flat, false);
  }
}

/** The QR for a subscription, as PNG bytes. */
async function qrPng(text) {
  const QRCode = require('qrcode');
  return QRCode.toBuffer(String(text), { margin: 1, width: 440, errorCorrectionLevel: 'M' });
}

/** Every single-server link this client has, newest inbound first. */
function directLinks(client) {
  const d = db.data;
  const out = [];
  for (const inb of membership.inboundsOf(client, d.inbounds)) {
    if (inb.enable === false) continue;
    for (const where of links.addressesFor(inb)) {
      const one = links.buildLink(inb, client, where);
      if (one) out.push(one);
    }
  }
  return out;
}

/** The buyer pressing "I have paid". */
async function confirmGateway(ctx, token) {
  const order = orderByToken(token);
  if (!order) return reply(ctx, 'این سفارش پیدا نشد.', backRow());
  if (order.status === 'delivered' || order.status === 'approved') {
    return reply(ctx, 'این سفارش قبلاً تحویل داده شده است ✅', backRow());
  }

  if (ctx.answer) ctx.answer('در حال بررسی پرداخت…');
  const out = await settleGateway(order, 'button');
  if (out.ok) return true;
  if (out.paid) {
    return reply(ctx, 'پرداخت شما ثبت شد ✅ اما تحویل خودکار انجام نشد؛ پشتیبانی همین حالا در جریان است.', backRow());
  }
  return reply(ctx, [
    'هنوز پرداختی برای این سفارش ثبت نشده است.',
    '',
    'اگر همین الان پرداخت کردید، چند لحظه صبر کنید و دوباره بزنید.'
  ].join('\n'), [
    [{ text: '💳 رفتن به صفحه پرداخت', url: order.payUrl || 'https://t.me' }],
    [{ text: '✅ دوباره بررسی کن', callback_data: `b:paid:${shortOrder(order)}` }],
    [{ text: '⬅️ بازگشت', callback_data: 'b:screen:start' }]
  ]);
}

/** Say something to the admin, when there is an admin to say it to. */
async function tellAdmin(text, keyboard) {
  const admin = adminChat();
  if (!admin) return;
  await send(admin, text, keyboard);
}

/*
 * The gateway failing is the admin's problem, not the buyer's, and it has to
 * reach them without filling their chat: a gateway that is down fails for
 * every buyer at once, and one message an hour is enough to act on.
 */
let gatewayWarnedAt = 0;
const GATEWAY_WARN_GAP = 60 * 60 * 1000;

async function warnAdminAboutGateway(reason) {
  if (Date.now() - gatewayWarnedAt < GATEWAY_WARN_GAP) return;
  gatewayWarnedAt = Date.now();
  await tellAdmin([
    '⚠️ <b>درگاه پرداخت جواب نداد</b>',
    escapeHtml(reason || 'نامشخص'),
    '',
    'تا رفع مشکل، خریدارها روش‌های دیگر را می‌بینند.'
  ].join('\n'));
}

/*
 * The minutes right after somebody is sent to pay.
 *
 * The sweep every three minutes is the safety net, and three minutes is a
 * long time to sit looking at a screen that says nothing after paying. So an
 * order that has just been handed a payment link is asked about often while
 * the buyer is likely to still be on the page - every five seconds at first,
 * easing off - and the watch stops the moment it is settled, or after a few
 * minutes when the sweep takes back over.
 *
 * It costs nothing when nobody is buying: there is no timer at all unless an
 * order is actually waiting, and one order has one watcher however many times
 * the buyer reopens the screen.
 */
const watching = new Map();
const WATCH_STEPS = [5, 5, 5, 5, 10, 10, 10, 15, 15, 20, 30, 30, 45, 60, 60];

function watchOrder(orderId) {
  if (watching.has(orderId)) return;
  let step = 0;

  const look = async () => {
    const order = (bot().orders || []).find((o) => o.id === orderId);
    const done = !order
      || order.status === 'delivered' || order.status === 'approved'
      || order.status === 'cancelled' || order.status === 'rejected';
    if (done || step >= WATCH_STEPS.length || !runtime.running) {
      watching.delete(orderId);
      return;
    }
    try { await settleGateway(order, 'watch'); } catch (_) { /* the next tick */ }

    /* settled on that pass? then there is nothing left to watch */
    const after = (bot().orders || []).find((o) => o.id === orderId);
    if (!after || after.status === 'delivered' || after.status === 'approved') {
      watching.delete(orderId);
      return;
    }
    const wait = WATCH_STEPS[step++] * 1000;
    const timer = setTimeout(look, wait);
    if (typeof timer.unref === 'function') timer.unref();
    watching.set(orderId, timer);
  };

  const first = setTimeout(look, WATCH_STEPS[step++] * 1000);
  if (typeof first.unref === 'function') first.unref();
  watching.set(orderId, first);
}

/*
 * Orders paid for but never confirmed.
 *
 * A buyer who pays and then closes Telegram, or whose "I have paid" never
 * arrives, has paid all the same - and before this they would simply have
 * been left with nothing until they thought to complain. Every few minutes
 * the open gateway orders of the last day are asked about, oldest first, and
 * whichever the gateway says is paid is handed over.
 */
const SWEEP_MS = 3 * 60 * 1000;
const SWEEP_WINDOW = 24 * 3600 * 1000;
let sweepTimer = null;

async function sweepGateway() {
  if (!runtime.running || !paygate.ready()) return;
  const now = Date.now();
  const open = (bot().orders || []).filter((o) => o.method === 'gateway'
    && o.payToken
    && o.status !== 'delivered' && o.status !== 'approved'
    && o.status !== 'cancelled' && o.status !== 'rejected'
    && now - (o.payAt || o.at || 0) < SWEEP_WINDOW);

  // a handful at a time: the gateway counts requests per minute, and an order
  // missed on this pass is picked up on the next one three minutes later
  for (const order of open.slice(0, 8)) {
    try { await settleGateway(order, 'sweep'); } catch (_) { /* next time round */ }
  }
}

function watchGateway() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => { sweepGateway().catch(() => {}); }, SWEEP_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  return sweepTimer;
}

/** The order the buyer still owes a receipt for, if any. A day is long enough. */
function openOrder(userId) {
  return bot().orders.find((o) => String(o.userId) === String(userId)
    && o.status === 'awaiting'
    // an online order is settled by the gateway's answer; a photo sent while
    // one is open is a photo, not a receipt to forward to the admin
    && o.method !== 'gateway'
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
    await sendConfig(ctx.chatId, handed.client,
      '<b>اشتراک شما آماده است ✅</b>',
      `${escapeHtml(order.planName)}\nرسید شما در حال بررسی است؛ در صورت تایید نشدن، اشتراک قطع می‌شود.`);
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
  const selling = sellingInbounds();
  if (!plan || !selling.length) return { ok: false, error: 'اشتراک یا اینباند آن پیدا نشد' };
  const inbound = selling[0];

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
      /* every way in, not one. A buyer who gets a single inbound has a single
         thing that can be blocked, and the admin ends up moving people by hand
         the first time one is; handing over all of them costs nothing and the
         subscription simply carries more entries. */
      inboundIds: selling.map((i) => i.id),
      totalGB: plan.gb || 0,
      /* when the days start is the admin's call: unwound until the config is
         first used, which is kinder, or from the sale, which is the one that
         shows an expiry date on the panel the moment it is sold */
      startAfterFirstUse: startsOnFirstUse(),
      expiryDays: plan.days || 0,
      expiryTime: startsOnFirstUse() || !plan.days ? 0 : Date.now() + plan.days * 86400000,
      tgId: String(order.userId),
      tgUsername: order.username || '',
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

  await sendConfig(order.chatId || order.userId, handed.client,
    '<b>اشتراک شما آماده شد ✅</b>',
    `${escapeHtml(handed.plan.name)} · ${handed.plan.gb ? `${handed.plan.gb} گیگ` : 'نامحدود'} · ${handed.plan.days} روز`);
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

  /*
   * Removed rather than parked. A rejected order was never paid for, so the
   * config it produced has no reason to go on existing - and one left switched
   * off is still a client Xray carries, a row in the panel and a tag the
   * address tracker keeps counting.
   */
  let cut = false;
  if (order.clientId) cut = await removeClient(order.clientId);
  db.saveNow();

  await send(order.userId, [
    'پرداخت شما تایید نشد.',
    cut ? 'کانفیگی که ساخته شده بود حذف شد.' : '',
    'اگر فکر می‌کنید اشتباهی رخ داده با پشتیبانی تماس بگیرید.'
  ].filter(Boolean).join('\n'));
  return send(ctx.chatId, cut
    ? 'رد شد. کانفیگ خریدار حذف شد.'
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
    case 'del': return askDelete(ctx, value);
    case 'delyes': return deleteConfig(ctx, value);
    case 'term': {
      const waiting = expected(ctx.userId);
      if (!waiting || waiting.kind !== 'customTerm') return showPlans(ctx);
      return takeCustomTerm(ctx, value, waiting);
    }
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
      const ways = payWays();
      return showPayment(ctx, order, ways.includes(method) ? method : (ways[0] || 'card'));
    }
    case 'paid': return confirmGateway(ctx, value);
    case 'cancel': return cancelOrder(ctx, value);
    // approval buttons live in the admin's own chat, never in the buyer's
    case 'ok': return ctx.isAdmin ? approveOrder(ctx, value) : send(ctx.chatId, 'فقط ادمین می‌تواند این کار را انجام دهد.');
    case 'no': return ctx.isAdmin ? rejectOrder(ctx, value) : send(ctx.chatId, 'فقط ادمین می‌تواند این کار را انجام دهد.');
    case 'noop': return ctx.answer ? ctx.answer('این فقط یک پیام آزمایشی است.', true) : undefined;
    case 'text': return reply(ctx, fill(value, ctx), backRow());
    default: return showScreen(ctx, 'start');
  }
}

/*
 * Keep the @name on this person's configs fresh.
 *
 * A username is the only part of a Telegram account that its owner can change
 * whenever they like, and the admin reaching for it in the panel weeks later
 * needs the one that works now, not the one from the day of the sale. It is
 * written only when it has actually changed, so this costs nothing on the
 * overwhelming majority of updates.
 */
function rememberUser(ctx) {
  const name = String(ctx.username || '');
  if (!name || !ctx.userId) return;
  let changed = false;
  for (const c of db.data.clients) {
    if (String(c.tgId || '') !== String(ctx.userId)) continue;
    if (String(c.tgUsername || '') === name) continue;
    c.tgUsername = name;
    changed = true;
  }
  if (changed) db.saveNow();
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
    rememberUser(ctx);
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

    /*
     * The buyer coming back from the gateway.
     *
     * When the return address is this bot, the gateway sends them to
     * t.me/<bot>?start=paid-<order>, and Telegram hands us the start payload
     * and nothing else - not the token the gateway put in the address, not
     * the status. So the order travels in the payload, and this is where it
     * is read. Without it the payload was dropped on the floor and somebody
     * who had just paid was shown the main menu, with no sign their money had
     * arrived until the sweep caught up minutes later.
     */
    const started = /^\/start\s+(\S+)/.exec(text);
    if (started && /^paid-/i.test(started[1])) {
      const order = orderByPayRef(started[1]);
      if (!order) return reply(ctx, 'این سفارش پیدا نشد. اگر پرداخت کرده‌اید، چند لحظه دیگر خودکار بررسی می‌شود.', backRow());
      await send(ctx.chatId, 'در حال بررسی پرداخت شما…');
      const out = await settleGateway(order, 'return');
      if (out.ok) return true;
      if (out.paid) {
        return reply(ctx, 'پرداخت شما ثبت شد ✅ اما تحویل خودکار انجام نشد؛ پشتیبانی در جریان است.', backRow());
      }
      return reply(ctx, [
        'هنوز پرداختی برای این سفارش ثبت نشده است.',
        '',
        'اگر همین الان پرداخت کردید، چند لحظه صبر کنید و دوباره بررسی بزنید.'
      ].join('\n'), [
        [{ text: '✅ دوباره بررسی کن', callback_data: `b:paid:${shortOrder(order)}` }],
        [{ text: '⬅️ بازگشت', callback_data: 'b:screen:start' }]
      ]);
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
    rememberUser(ctx);
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
  migrateHelp();
  runtime.me = await whoAmI(b.token);
  runtime.stopping = false;
  runtime.running = true;
  runtime.startedAt = Date.now();
  runtime.error = '';
  b.enabled = true;
  db.saveNow();
  loop();
  // and from here the scheduled backup has something to send through
  watchBackups();
  // and an online payment nobody confirmed still gets delivered
  watchGateway();
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
  const b = bot();
  return {
    running: runtime.running,
    username: runtime.me ? runtime.me.username : '',
    error: runtime.error,
    startedAt: runtime.startedAt,
    updates: runtime.seen,
    sent: runtime.sent,
    pendingOrders: b.orders.filter((o) => o.status === 'pending').length,
    /* where support mail goes, and whether the last attempt to reach it
       worked - an admin id the bot cannot message is the single most common
       reason a panel looks like it is dropping support messages */
    adminChat: adminChat(),
    adminError: runtime.adminError || ''
  };
}

/**
 * Can the bot actually message the admin?
 *
 * getChat is the cheap way to ask: it answers for a chat the bot is allowed
 * to open and refuses for one it is not, without sending anybody anything.
 * The refusal is the useful part - Telegram will not let a bot write to
 * somebody who has never pressed Start on it, and that is a thing the admin
 * has to go and do, not something the panel can fix for them.
 */
async function checkAdmin() {
  const b = bot();
  if (!b.token) return { ok: false, why: 'no bot token is set' };
  const who = adminChat();
  if (!who) {
    return {
      ok: false,
      why: b.adminId
        ? 'the admin is set by @username, which a bot cannot message. Put the numeric id here, or open the bot as the admin and press Start.'
        : 'no admin has been set'
    };
  }
  try {
    const chat = await call('getChat', { chat_id: who });
    runtime.adminError = '';
    return { ok: true, who, name: chat.first_name || chat.title || chat.username || String(who) };
  } catch (err) {
    runtime.adminError = err.message;
    return {
      ok: false,
      who,
      why: /not found|chat not found|initiate/i.test(err.message)
        ? `the bot cannot open a chat with ${who}. Open the bot as that account and press Start - Telegram does not let a bot message somebody who never has.`
        : err.message
    };
  }
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
/*
 * Give a date to configs that were sold without one.
 *
 * A config sold while the clock waited for first use carries its length as a
 * number of days and no date at all. If the buyer never moved traffic the
 * panel has nothing to show and nothing to enforce, so a "60 day" service runs
 * for ever - which is what "the time limit is not applied" has meant all
 * along.
 *
 * The term starts now rather than from the sale. Not from the sale because
 * that would silently take days off somebody who has not used any of them;
 * now, because that is the first moment the config has a deadline, and they
 * still get the whole of what they paid for.
 *
 * Only configs the bot sold - they carry a Telegram id - and only while the
 * panel is set to start the clock at the sale. An admin who has deliberately
 * chosen to wait for first use keeps their configs waiting.
 */
/**
 * How long a config was sold for, worked out after the fact.
 *
 * A config sold by the bot before it knew how to set a date carries no length
 * at all - not a date, not a number of days - so nothing could ever expire it,
 * and no amount of fixing the sale helps the ones already out there. But the
 * order that sold it is still in the settings file, and the order names the
 * plan. The plan is where the length lives.
 *
 * Three ways, in order of how sure each one is: the order whose buyer and
 * chosen name both match this config; the plan named in the config's own
 * comment, which is what delivery writes there; and failing those, the most
 * recent order this buyer placed before the config was cut. Nothing found
 * means nothing is changed - a guessed length is worse than none.
 */
function soldTerm(c) {
  const b = bot();
  const plans = b.plans || [];
  const daysOf = (plan) => (plan && Number(plan.days) > 0 ? Number(plan.days) : 0);
  const mine = (b.orders || []).filter((o) => String(o.userId || '') === String(c.tgId || ''));

  const named = mine.find((o) => o.clientName && o.clientName === c.email);
  if (named) {
    const days = daysOf(plans.find((p) => p.id === named.planId));
    if (days) return { days, how: 'its own order' };
  }

  const comment = String(c.comment || '');
  const byName = plans.find((p) => p.name && comment.startsWith(`${p.name} -`));
  if (daysOf(byName)) return { days: daysOf(byName), how: 'the plan named on it' };

  const made = Number(c.createdAt || 0);
  if (made) {
    const before = mine
      .filter((o) => Number(o.at || 0) <= made + 600000)
      .sort((x, y) => Number(y.at || 0) - Number(x.at || 0))[0];
    const days = daysOf(plans.find((p) => p.id === (before || {}).planId));
    if (days) return { days, how: 'the order placed when it was cut' };
  }
  return null;
}

async function dateUndatedClients() {
  const d = db.data;
  const now = Date.now();
  const waiting = startsOnFirstUse();
  let dated = 0;
  let rebuilt = 0;

  for (const c of d.clients) {
    if (!String(c.tgId || '').trim()) continue;
    if (c.expiryTime) continue;

    /*
     * Sold with a length but no date, while the panel was set to start at the
     * sale. Its days start today. Left alone while the panel is set to wait
     * for first use, because then waiting is what was meant.
     */
    if (c.startAfterFirstUse && Number(c.expiryDays) > 0) {
      if (waiting) continue;
      c.expiryTime = now + Number(c.expiryDays) * 86400000;
      c.startAfterFirstUse = false;
      c.startedAt = c.startedAt || now;
      dated++;
      continue;
    }

    /*
     * Sold with no length at all, which no setting and no first use can ever
     * repair: there is nothing to count. The term is read back off the order
     * and the deadline put where it always should have been - the day it was
     * sold plus what was paid for. One already past that comes out expired,
     * which is the true answer: it is a config that has been running free.
     */
    if (Number(c.expiryDays) > 0) continue;
    const term = soldTerm(c);
    if (!term) continue;
    const from = Number(c.createdAt) || now;
    c.expiryDays = term.days;
    c.expiryTime = from + term.days * 86400000;
    c.startAfterFirstUse = false;
    c.startedAt = c.startedAt || from;
    rebuilt++;
    d.logs.unshift({ at: now, type: 'client',
      message: `${c.email} was sold with no time limit at all; ${term.days} days read back from `
        + `${term.how}, counting from the day it was sold`
        + (c.expiryTime < now ? ' - which has already passed' : '') });
  }

  if (!dated && !rebuilt) return { dated: 0, rebuilt: 0 };
  db.saveNow();
  if (dated) {
    d.logs.unshift({ at: now, type: 'client',
      message: `${dated} config(s) sold without an expiry date now have one, starting today` });
  }
  if (rebuilt) {
    d.logs.unshift({ at: now, type: 'client',
      message: `${rebuilt} config(s) had no time limit at all; their term was read back from the orders that sold them` });
  }
  if (d.logs.length > 500) d.logs.length = 500;
  await require('./xray').apply();
  return { dated, rebuilt };
}

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
  migrateHelp();
  if (b.enabled && b.token) start().catch((err) => { runtime.error = err.message; });
}

/* ------------------------------- backups --------------------------------- */

const backup = require('./backup');

/** The backup settings, with the defaults filled in. */
function backupSettings() {
  const b = bot();
  if (!b.backup || typeof b.backup !== 'object') b.backup = defaults().backup;
  const s = b.backup;
  if (!Array.isArray(s.times)) s.times = [];
  if (!Number.isFinite(Number(s.tzOffset))) s.tzOffset = 210;
  return s;
}

/**
 * "03:00" -> 180 minutes past midnight, or -1 when it is not a time.
 *
 * Persian and Arabic digits come back as digits first. A keyboard set to
 * Persian types ۰۳:۰۰, which looks like a time to the person who typed it and
 * like nothing at all to a regular expression.
 */
function minutesOf(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

/** The times the admin set, cleaned up and in order, with no repeats. */
function backupTimes() {
  const seen = new Set();
  return backupSettings().times
    .map((t) => minutesOf(t))
    .filter((n) => n >= 0 && !seen.has(n) && seen.add(n))
    .sort((a, b) => a - b);
}

/**
 * Where in the admin's own day it is now.
 *
 * Everything about a schedule is in their day, not the server's: a box set to
 * UTC would otherwise send the 3am backup in the middle of their evening.
 */
function localNow(at) {
  const s = backupSettings();
  const shifted = new Date((at || Date.now()) + Number(s.tzOffset || 0) * 60000);
  return {
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    day: `${shifted.getUTCFullYear()}-${backup.pad(shifted.getUTCMonth() + 1)}-${backup.pad(shifted.getUTCDate())}`
  };
}

/**
 * Take a backup and send it to the admin's chat.
 *
 * The caption carries what is in the file, because a stream of identical
 * documents in a chat is one nobody checks: a backup that suddenly holds no
 * clients is worth noticing before it is the only one left.
 */
async function sendBackup(reason) {
  const chat = adminChat();
  if (!chat) throw new Error('no admin chat is linked, so there is nowhere to send it');
  if (!bot().token) throw new Error('set the bot token first');

  const at = Date.now();
  const s = backupSettings();
  const counts = backup.summary();
  const caption = [
    `<b>${escapeHtml(bot().brand || 'NexV')}</b> — پشتیبان پنل`,
    `${counts.inbounds} این‌باند · ${counts.clients} کانفیگ · ${counts.plans} پلن`,
    reason ? `<i>${escapeHtml(reason)}</i>` : ''
  ].filter(Boolean).join('\n');

  await uploadDocument(chat, backup.filename(at, s.tzOffset), backup.text(), caption);
  s.lastAt = at;
  s.lastError = '';
  db.saveNow();
  return { ok: true, at, counts };
}

/*
 * One timer for the whole thing, checked once a minute.
 *
 * A missed minute - the panel restarting across one, a check that ran long -
 * must not mean a skipped backup, so a slot counts as due for the hour that
 * follows it and `lastKey` is what stops it being sent twice. The key is the
 * admin's own day and the slot, so moving the clock or the offset cannot
 * replay a backup that already went.
 */
let backupTimer = null;
const SLOT_GRACE = 60;        // minutes a missed slot is still worth sending

async function backupTick() {
  try {
    const s = backupSettings();
    if (!s.enable || !runtime.running) return;
    const times = backupTimes();
    if (!times.length) return;

    const now = localNow();
    // the latest slot that has come round today and is still within its grace
    let due = -1;
    for (const t of times) {
      if (now.minutes >= t && now.minutes - t <= SLOT_GRACE) due = t;
    }
    if (due < 0) return;

    const key = `${now.day}@${due}`;
    if (s.lastKey === key) return;
    s.lastKey = key;
    db.saveNow();

    await sendBackup('پشتیبان خودکار');
  } catch (err) {
    const s = backupSettings();
    s.lastError = err.message;
    db.saveNow();
    if (process.env.NEXV_TG_DEBUG) console.error('[bot] backup:', err);
  }
}

function watchBackups() {
  if (backupTimer) return backupTimer;
  backupTimer = setInterval(backupTick, 60000);
  if (typeof backupTimer.unref === 'function') backupTimer.unref();
  return backupTimer;
}

/** What the Bot page shows about backups. */
function backupStatus() {
  const s = backupSettings();
  return {
    enable: !!s.enable,
    times: s.times.slice(),
    tzOffset: Number(s.tzOffset) || 0,
    lastAt: Number(s.lastAt) || 0,
    lastError: s.lastError || '',
    chatLinked: !!adminChat(),
    // the schedule only runs while the bot does, which is worth saying on the
    // page rather than leaving as a backup that quietly never arrives
    botRunning: !!runtime.running,
    nextAt: nextBackupAt()
  };
}

/** When the next one goes, as a timestamp, or 0 when none is scheduled. */
function nextBackupAt() {
  const s = backupSettings();
  const times = backupTimes();
  if (!s.enable || !times.length) return 0;
  const now = Date.now();
  const here = localNow(now);
  const next = times.find((t) => t > here.minutes);
  const minutesAway = next === undefined ? (24 * 60 - here.minutes) + times[0] : next - here.minutes;
  return now + minutesAway * 60000;
}

module.exports = {
  bot, defaults, starterScreens, checkAdmin, migrateStarter, migrateUsageButton, migrateHelp, start, stop, status, whoAmI, resume,
  resetTrials, trialsTaken, repairOrphanClients, dateUndatedClients, customTerms,
  send, escapeHtml, payWays, call, channel, gateOn, joinLink, adminChat, buyerLines,
  sendBackup, backupStatus, backupSettings, backupTimes, watchBackups, minutesOf, nextBackupAt, backupTick,
  payLabel, customLabel, picksTerm, settleGateway, sweepGateway, watchGateway, orderByToken,
  /* the entry point for one update: what the polling loop feeds, and what a
     webhook would feed if this ever grows one */
  handle
};
