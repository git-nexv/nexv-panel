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
const crypto = require('crypto');
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

  if (pairStartRows(b.screens)) touched = true;

  if (touched) db.saveNow();
  return touched;
}

/**
 * Put the pairs back beside each other on the first screen.
 *
 * The menu is meant to read as three short rows - buy, then the two keys
 * about a config somebody already has, then the two about getting help - and
 * a bot whose screens were stored before that shape existed, or which picked
 * a key up from one of these migrations, ends up with them stacked one per
 * row. That is four taps' worth of scrolling for a menu with six keys in it.
 *
 * Only these two pairs, only on the start screen, and only when the two keys
 * are already alone on rows of their own: a menu the admin has arranged some
 * other way is theirs, and this leaves it alone.
 */
const START_PAIRS = [['configs', 'trial'], ['screen:help', 'support']];

function pairStartRows(screens) {
  const start = (screens || []).find((screen) => screen.key === 'start');
  if (!start || !Array.isArray(start.buttons)) return false;
  const nameOf = (btn) => (btn.action === 'screen' ? `screen:${btn.value || ''}` : String(btn.action || ''));
  let touched = false;

  for (const pair of START_PAIRS) {
    const where = pair.map((want) => start.buttons
      .findIndex((row) => Array.isArray(row) && row.length === 1 && nameOf(row[0]) === want));
    // both present, both alone, and in that order
    if (where.some((i) => i < 0) || where[0] >= where[1]) continue;
    const second = start.buttons[where[1]][0];
    start.buttons[where[0]].push(second);
    start.buttons.splice(where[1], 1);
    touched = true;
  }
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

    /* a sale, across the shop or one plan at a time. The plans keep their own
       prices; this is applied on top wherever money is shown or taken */
    offer: { enable: false, percent: 0, plans: {}, custom: true, label: '' },

    /* bring people to the bot, get a subscription. Off until the admin picks
       which plan it hands over - there is no sensible default for that */
    reward: { enable: false, need: 5, planId: '', label: '🎁 اشتراک رایگان', text: '' },

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
 *
 * The free subscription is the third. It is the other thing the shop wants
 * pressed - somebody who will not buy today may still bring five people who
 * will - so it carries the same colour as buying does.
 */
const COLOURED = /^b:(plans|reward)\b/;
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

/*
 * The same thing for a message that is a photo.
 *
 * An order arrives as the buyer's receipt - a picture with the details as its
 * caption - and a photo has no text to edit. editMessageText on one is
 * refused, which is why marking an order handled had to know which of the two
 * it was looking at. It tries the caption first and the text second, so the
 * caller does not have to care.
 */
async function editCaptionOrText(chatId, messageId, text, keyboard) {
  const markup = keyboard ? { inline_keyboard: styled(keyboard) } : undefined;
  try {
    return await call('editMessageCaption', {
      chat_id: chatId, message_id: messageId, caption: text, parse_mode: 'HTML', reply_markup: markup
    });
  } catch (_) { /* not a photo, then */ }
  try {
    return await call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: markup
    });
  } catch (err) {
    runtime.error = err.message;
    return null;
  }
}

/**
 * An order has been dealt with: say so on the order itself.
 *
 * Three things at once, because an admin working through a morning's receipts
 * needs all three. The alert on the button is instant feedback that the tap
 * registered at all. The order message is rewritten with the verdict on top
 * and its buttons taken away, so a list of receipts shows at a glance which
 * are done and none can be approved twice by a stray tap. And the plain
 * message in the chat stays, because that is the one that survives scrolling
 * back.
 */
async function markHandled(ctx, verdict, line) {
  if (ctx.answer) ctx.answer(verdict, true);
  if (ctx.messageId) {
    const body = String(ctx.sourceText || '').trim();
    await editCaptionOrText(ctx.chatId, ctx.messageId,
      `${verdict}
${body ? `
${body}` : ''}`.trim(), null);
  }
  return send(ctx.chatId, line || verdict);
}

function edit(chatId, messageId, text, keyboard) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: styled(keyboard) } : undefined
  }).catch((err) => {
    /*
     * "message is not modified" is Telegram saying the screen is already what
     * we asked for - which is a success, not a failure. Falling back to send()
     * on it posted the same screen again underneath, so a button that redraws
     * what is already there - the reward's own check button - looked like it
     * was spamming the chat instead of answering.
     */
    if (/message is not modified/i.test(err.message || '')) return null;
    return send(chatId, text, keyboard);
  });
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

/* -------------------------------- the offer ------------------------------ */
/*
 * A discount, either across the shop or on one plan at a time.
 *
 * Two levels, because both are things a shop actually wants to say: "ten per
 * cent off everything" is a sale, and "ten off the small one, twenty off the
 * big one" is pushing people up the list. A plan with its own figure uses it;
 * everything else falls back to the shop-wide one; with the offer switched
 * off nothing is discounted at all, and the plans' own prices - which are
 * never rewritten - are what is charged again.
 *
 * Nothing stores a discounted price. The plan keeps the price the admin
 * typed and the discount is worked out wherever a price is shown or taken, so
 * ending the sale is one switch and not a migration back through every plan.
 */
function offerSettings() {
  const o = bot().offer || {};
  const perPlan = {};
  if (o.plans && typeof o.plans === 'object') {
    for (const [id, value] of Object.entries(o.plans)) {
      const n = Math.round(Number(value) || 0);
      if (n > 0) perPlan[id] = Math.min(95, n);
    }
  }
  return {
    enable: !!o.enable,
    percent: Math.min(95, Math.max(0, Math.round(Number(o.percent) || 0))),
    plans: perPlan,
    /* buying by the gigabyte is a sale like any other, so the shop-wide
       figure reaches it too unless the admin says otherwise */
    custom: o.custom !== false,
    label: String(o.label || '').slice(0, 80)
  };
}

/** How much off this plan, as a whole number of per cent. */
function offerFor(plan) {
  if (!plan) return 0;
  const o = offerSettings();
  if (!o.enable) return 0;
  const mine = o.plans[plan.id];
  if (mine > 0) return mine;
  if (plan.custom && !o.custom) return 0;
  return o.percent;
}

/** Is anything at all on offer right now? */
function offerOn() {
  const o = offerSettings();
  if (!o.enable) return false;
  return o.percent > 0 || Object.keys(o.plans).length > 0;
}

/* a price somebody reads: 90,000 rather than 89,999.99 */
function tidyPrice(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  if (value >= 10000) return Math.round(value / 1000) * 1000;
  if (value >= 1000) return Math.round(value / 100) * 100;
  return value;
}

/**
 * What a plan costs now, and what it cost before.
 *
 * `was` is only set when there is really a discount, so every caller can use
 * its presence to decide whether to show the old price struck through.
 */
function planCost(plan) {
  const raw = Number(String(plan && plan.price || '').replace(/[^\d.]/g, '')) || 0;
  const percent = offerFor(plan);
  if (!raw || !percent) return { now: raw, was: 0, percent: 0 };
  const now = tidyPrice(raw * (1 - percent / 100));
  if (now >= raw) return { now: raw, was: 0, percent: 0 };
  return { now, was: raw, percent };
}

/** The number an order is actually written for. */
function chargeFor(plan) {
  const p = planCost(plan);
  return String(p.now || plan.price || '0');
}

const money = (n) => Number(n || 0).toLocaleString('en-US');

/** For a message, where the name is marked up. */
function planLine(plan) {
  const cur = String(bot().currency || '').trim();
  const p = planCost(plan);
  if (!p.now && !p.was) return `<b>${escapeHtml(plan.name)}</b>`;
  if (!p.was) return `<b>${escapeHtml(plan.name)}</b> — ${money(p.now)} ${escapeHtml(cur)}`.trim();
  return `<b>${escapeHtml(plan.name)}</b> — <s>${money(p.was)}</s> <b>${money(p.now)}</b> ${escapeHtml(cur)}`
    + ` 🔥 ${p.percent}٪`;
}

/** The same thing for a button, where Telegram parses no markup at all. */
function planButton(plan) {
  const cur = String(bot().currency || '').trim();
  const p = planCost(plan);
  if (!p.now && !p.was) return plan.name;
  if (!p.was) return `${plan.name} — ${money(p.now)} ${cur}`.trim();
  return `${plan.name} — ${money(p.now)} ${cur} (🔥${p.percent}٪)`.trim();
}

/** The line at the top of the plan list while a sale is on. */
function offerBanner() {
  if (!offerOn()) return '';
  const o = offerSettings();
  if (o.label) return `🔥 <b>${escapeHtml(o.label)}</b>`;
  if (o.percent > 0) return `🔥 <b>تخفیف ویژه: ${o.percent}٪ روی اشتراک‌ها</b>`;
  return '🔥 <b>تخفیف ویژه روی بعضی اشتراک‌ها</b>';
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
  const out = rows
    .map((row) => (Array.isArray(row) ? row : [row])
      .filter((btn) => btn && btn.label)
      .map((btn) => (btn.action === 'url'
        ? { text: btn.label, url: btn.value || 'https://t.me' }
        : { text: btn.label, callback_data: `b:${btn.action}:${btn.value || ''}`.slice(0, 64) })))
    .filter((row) => row.length);

  /*
   * The reward button, added to the first screen rather than stored in it.
   *
   * The screens are the admin's: they are kept in the store and edited on the
   * Bot page, so a button written into the starter set would never appear on
   * a bot that already exists. Switching the reward on in the panel should put
   * the button there, and switching it off should take it away, which is what
   * deciding it here does. An admin who has already placed a reward button of
   * their own gets no second one.
   */
  if (screen.key === 'start' && rewardOn()) {
    const already = out.some((row) => row.some((b) => String(b.callback_data || '').startsWith('b:reward')));
    /* at the bottom, on a row of its own: it is the last thing on the menu
       rather than the second, so the keys somebody opens the bot to use stay
       where they were and this sits under them where it reads as an offer */
    if (!already) out.push([{ text: rewardSettings().label, callback_data: 'b:reward:' }]);
  }
  return out;
}

function clientsOf(userId) {
  return db.data.clients.filter((c) => String(c.tgId || '') === String(userId));
}

/* ------------------------------- the actions ----------------------------- */

async function showScreen(ctx, key) {
  let screen = screenByKey(key) || screenByKey('start');
  if (!screen) return reply(ctx, 'This bot has no screens yet.');

  /*
   * A screen that has lost its keys, repaired at the moment it is shown.
   *
   * The guide is "choose your device" above a row of devices, and a bot whose
   * stored copy has only the back key shows the sentence above nothing at
   * all - which is what somebody pressing "connection guide" after paying was
   * looking at. There is a migration that puts the keys back, but it runs
   * when the bot starts, so a bot that has been up since before it existed
   * never got it, and the screen stays broken for as long as nobody restarts.
   *
   * Checked here instead: if what we are about to draw is a screen with
   * nothing on it but a way back, and the starter set has more than that for
   * this key, the migration runs now and the screen is read again. It costs a
   * comparison on screens that are fine, which is all of them after the first
   * time.
   */
  const bare = (one) => keyboardFor(one).every((row) => row.every((b) => BACK_ARROW.test(String(b.text || ''))));
  if (bare(screen)) {
    const fresh = starterScreens().find((one) => one.key === screen.key);
    if (fresh && !bare(fresh)) {
      migrateHelp();
      screen = screenByKey(key) || screen;
    }
  }

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

  const banner = offerBanner();
  const head = [
    banner,
    renewId
      ? '<b>تمدید اشتراک</b>\nحجم یا پلن تازه را انتخاب کنید — روی همین کانفیگ اعمال می‌شود:'
      : '<b>اشتراک‌ها</b>\nیکی را انتخاب کنید:'
  ].filter(Boolean).join('\n\n');
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

  const id = shortId(c);
  const off = c.enable === false || c.autoDisabled;
  const keys = [
    [{ text: '❓ راهنمای اتصال', callback_data: 'b:screen:help' }],
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
  ];

  /*
   * Sent as its own card rather than written over the list.
   *
   * This used to edit the message into a block of text, which is why it never
   * carried the QR: a text message cannot become a photo. Somebody opening
   * their own config should see what the buyer saw - the code to scan, the
   * subscription, the direct links in their box - and the only way to do that
   * is to send it. The management keys ride along underneath.
   */
  return sendConfig(ctx.chatId, c, '', '', { usage: true, keys });
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


/**
 * What the dashboard shows about the bot.
 *
 * "How many clicks" is really three different numbers and they are worth
 * telling apart: how many times anybody has pressed Start, how many separate
 * people that was, and how many of them have bought something. A bot with
 * four hundred starts from forty people is a different bot from one with four
 * hundred people, and one figure cannot say which you have.
 */
function botStats() {
  const b = bot();
  const d = db.data;
  const stats = b.stats && typeof b.stats === 'object' ? b.stats : {};
  const people = Object.keys(knownPeople());
  const today = new Date().toISOString().slice(0, 10);

  const buyers = new Set();
  let revenue = 0;
  let orders = 0;
  for (const o of (b.orders || [])) {
    if (o.status !== 'done' && o.status !== 'approved' && o.status !== 'delivered') continue;
    orders += 1;
    revenue += Number(String(o.price || '0').replace(/[^\d.]/g, '')) || 0;
    const id = String(o.userId || '').trim();
    if (id) buyers.add(id);
  }
  for (const c of (d.clients || [])) {
    const id = String(c.tgId || '').trim();
    if (id && !c.isTrial) buyers.add(id);
  }

  /* how many arrived in the last week, which is the only one of these that
     says whether the bot is growing */
  const weekAgo = Date.now() - 7 * 86400000;
  const fresh = people.filter((id) => Number(knownPeople()[id]) > weekAgo).length;

  return {
    running: runtime.running,
    username: (runtime.me && runtime.me.username) || b.username || '',
    people: people.length,
    newThisWeek: fresh,
    starts: Number(stats.starts) || 0,
    startsToday: String(stats.day) === today ? (Number(stats.dayStarts) || 0) : 0,
    buyers: buyers.size,
    orders,
    revenue,
    currency: b.currency || '',
    trials: Object.keys((b.trial && b.trial.taken) || {}).length,
    blocked: Object.keys((b.blocked && typeof b.blocked === 'object') ? b.blocked : {}).length,
    rewardsGiven: rewardStats().given,
    seen: runtime.seen,
    sent: runtime.sent,
    adminLinked: !!b.adminChatId,
    adminError: runtime.adminError || ''
  };
}

/** One press of Start, written down so the dashboard can count them. */
function countStart() {
  const b = bot();
  if (!b.stats || typeof b.stats !== 'object') b.stats = {};
  const today = new Date().toISOString().slice(0, 10);
  b.stats.starts = (Number(b.stats.starts) || 0) + 1;
  if (String(b.stats.day) !== today) { b.stats.day = today; b.stats.dayStarts = 0; }
  b.stats.dayStarts = (Number(b.stats.dayStarts) || 0) + 1;
  db.save();
}

/* ------------------------------ broadcasting ----------------------------- */
/*
 * A message to everybody, or to the people who have bought something.
 *
 * Three things make this more than a loop over a list of ids.
 *
 * Telegram's own limit is about thirty messages a second to different chats,
 * and a bot that ignores it is answered with 429 and a retry_after - so there
 * is a gap between sends, and a 429 is waited out rather than counted as a
 * failure. A broadcast that goes out slowly and arrives is better than one
 * that goes out fast and gets the bot rate-limited for everybody else.
 *
 * It cannot be done inside the HTTP request either: a thousand people at
 * thirty a second is half a minute, and the panel would be holding a request
 * open the whole time. It runs in the background and the page asks how it is
 * going.
 *
 * And somebody who has blocked the bot answers 403 for every message, forever.
 * They are counted as blocked rather than failed, and written down, so the
 * next broadcast does not spend its time on them again.
 */
const BROADCAST_GAP_MS = 40;          // ~25 a second, under Telegram's ~30
const BROADCAST_MAX = 20000;

const broadcast = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  total: 0,
  sent: 0,
  blocked: 0,
  failed: 0,
  audience: '',
  text: '',
  error: '',
  lastError: ''
};

/** Everybody the bot could write to, by the group the admin picked. */
function audienceIds(which) {
  const d = db.data;
  const b = bot();
  const known = Object.keys(knownPeople());

  const buyers = new Set();
  for (const c of (d.clients || [])) {
    const id = String(c.tgId || '').trim();
    if (id && !c.isTrial) buyers.add(id);
  }
  for (const o of (b.orders || [])) {
    if (o.status !== 'done' && o.status !== 'approved' && o.status !== 'delivered') continue;
    const id = String(o.userId || '').trim();
    if (id) buyers.add(id);
  }

  /* somebody who blocked the bot is not written to again - every send to them
     fails the same way and the time is better spent on everybody else */
  const blocked = new Set(Object.keys((b.blocked && typeof b.blocked === 'object') ? b.blocked : {}));
  const keep = (id) => !blocked.has(String(id));

  if (which === 'buyers') return [...buyers].filter(keep);
  if (which === 'nonbuyers') return known.filter((id) => !buyers.has(id)).filter(keep);
  return known.filter(keep);
}

/** How many people each choice would reach, for the page to show. */
function audienceCounts() {
  return {
    all: audienceIds('all').length,
    buyers: audienceIds('buyers').length,
    nonbuyers: audienceIds('nonbuyers').length,
    blocked: Object.keys((bot().blocked && typeof bot().blocked === 'object') ? bot().blocked : {}).length
  };
}

function markBlocked(userId) {
  const b = bot();
  if (!b.blocked || typeof b.blocked !== 'object') b.blocked = {};
  b.blocked[String(userId)] = Date.now();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Send it. Returns as soon as the sending has started; the page watches
 * `broadcastStatus()` for the rest.
 */
async function startBroadcast(text, which, opts) {
  const body = String(text || '').trim();
  if (!body) throw new Error('write the message first');
  if (!bot().token) throw new Error('the bot has no token');
  if (broadcast.running) throw new Error('a broadcast is already going out');

  const ids = audienceIds(which).slice(0, BROADCAST_MAX);
  if (!ids.length) throw new Error('there is nobody in that group yet');

  Object.assign(broadcast, {
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    total: ids.length,
    sent: 0,
    blocked: 0,
    failed: 0,
    audience: which || 'all',
    text: body,
    error: '',
    lastError: ''
  });

  const keyboard = (opts && opts.button && opts.button.text && opts.button.url)
    ? [[{ text: String(opts.button.text).slice(0, 40), url: String(opts.button.url) }]]
    : null;

  /* deliberately not awaited: the caller is an HTTP request and this takes as
     long as it takes */
  (async () => {
    for (const id of ids) {
      if (!broadcast.running) break;
      try {
        await call('sendMessage', {
          chat_id: id,
          text: body,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: keyboard ? { inline_keyboard: styled(keyboard) } : undefined
        });
        broadcast.sent += 1;
        runtime.sent += 1;
      } catch (err) {
        const said = String(err.message || '');
        const retry = /retry[_ ]after[^0-9]*(\d+)/i.exec(said);
        if (retry) {
          /* too fast: wait exactly as long as Telegram asked, then try this
             same person again rather than writing them off */
          await sleep((Number(retry[1]) + 1) * 1000);
          try {
            await call('sendMessage', { chat_id: id, text: body, parse_mode: 'HTML', disable_web_page_preview: true });
            broadcast.sent += 1;
            continue;
          } catch (second) { err.message = second.message; }
        }
        if (/bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(String(err.message))) {
          markBlocked(id);
          broadcast.blocked += 1;
        } else {
          broadcast.failed += 1;
          broadcast.lastError = String(err.message).slice(0, 200);
        }
      }
      await sleep(BROADCAST_GAP_MS);
    }

    broadcast.running = false;
    broadcast.finishedAt = Date.now();
    db.data.logs.unshift({ at: Date.now(), type: 'bot',
      message: `broadcast to ${broadcast.audience}: ${broadcast.sent} sent, `
        + `${broadcast.blocked} blocked, ${broadcast.failed} failed` });
    if (db.data.logs.length > 500) db.data.logs.length = 500;
    db.saveNow();
  })().catch((err) => {
    broadcast.running = false;
    broadcast.error = err.message;
  });

  return broadcastStatus();
}

function stopBroadcast() {
  if (!broadcast.running) return broadcastStatus();
  broadcast.running = false;
  broadcast.finishedAt = Date.now();
  return broadcastStatus();
}

function broadcastStatus() {
  return {
    running: broadcast.running,
    total: broadcast.total,
    sent: broadcast.sent,
    blocked: broadcast.blocked,
    failed: broadcast.failed,
    audience: broadcast.audience,
    startedAt: broadcast.startedAt,
    finishedAt: broadcast.finishedAt,
    error: broadcast.error,
    lastError: broadcast.lastError,
    counts: audienceCounts()
  };
}

/* ------------------------------ the reward ------------------------------- */
/*
 * Bring people to the bot, get a subscription.
 *
 * The admin names a plan and a number. Somebody taps the button, the bot gives
 * them a link to itself with their own code in it, and when that many people
 * have started the bot through their link they are handed that plan for
 * nothing - the same config a buyer gets, cut the same way, so there is no
 * second kind of subscription to maintain.
 *
 * Three rules decide whether an arrival counts, and all three matter:
 *
 *   it must be somebody new     the whole point is new people, so anybody the
 *                               bot has already met - or who already has a
 *                               config, or has ever ordered - is not one
 *   it must not be themselves   an invite link opened by its own owner is the
 *                               oldest trick there is
 *   it counts once              the same person arriving again, through the
 *                               same link or another one, is still one person
 *
 * The first rule needs a record of who the bot has met, and there was none -
 * the bot knew its buyers and nobody else. So one is kept from now on, seeded
 * once from everybody already visible in the store. That seeding is what stops
 * the reward being farmed with an existing customer list on the first day.
 */
function rewardSettings() {
  const r = bot().reward || {};
  return {
    enable: !!r.enable,
    need: Math.max(1, Math.min(1000, Math.round(Number(r.need) || 5))),
    planId: String(r.planId || ''),
    label: String(r.label || '🎁 اشتراک رایگان'),
    text: String(r.text || '')
  };
}

/**
 * The bot's own @name, which the invite link is built from.
 *
 * `runtime.me` is filled in when the bot is started and is normally all this
 * needs - but a reward link that reads "the bot is not ready" because one
 * lookup never happened is a dead end on the one screen that cannot have one.
 * So it is asked for when it is missing and kept in the store afterwards,
 * where it survives a restart.
 */
async function botUsername() {
  if (runtime.me && runtime.me.username) return runtime.me.username;
  const b = bot();
  if (b.username) return b.username;
  if (!b.token) return '';
  try {
    const me = await whoAmI(b.token);
    if (me && me.username) {
      runtime.me = me;
      b.username = me.username;
      db.save();
      return me.username;
    }
  } catch (_) { /* the screen says it is not ready, which is true */ }
  return '';
}

/** The plan the reward hands over, if it is still there and still on sale. */
function rewardPlan() {
  const r = rewardSettings();
  if (!r.planId) return null;
  return (bot().plans || []).find((p) => p.id === r.planId) || null;
}

/** Is the reward actually offerable right now? */
function rewardOn() {
  const r = rewardSettings();
  return !!(r.enable && rewardPlan());
}

function rewardLedger() {
  const b = bot();
  b.reward = b.reward || {};
  if (!b.reward.people || typeof b.reward.people !== 'object') b.reward.people = {};
  if (!b.reward.codes || typeof b.reward.codes !== 'object') b.reward.codes = {};
  return b.reward;
}

/**
 * Everybody the bot has ever met.
 *
 * Seeded once from the store, because an install that has been selling for
 * months has hundreds of people the bot plainly knows and an empty ledger
 * would call every one of them a new arrival. After that it is written to on
 * every update the bot handles.
 */
function knownPeople() {
  const b = bot();
  if (!b.known || typeof b.known !== 'object') {
    b.known = {};
    const at = Date.now();
    for (const c of (db.data.clients || [])) {
      const id = String(c.tgId || '').trim();
      if (id) b.known[id] = Number(c.createdAt) || at;
    }
    for (const o of (b.orders || [])) {
      const id = String(o.userId || '').trim();
      if (id && !b.known[id]) b.known[id] = Number(o.at) || at;
    }
    for (const id of Object.keys((b.trial && b.trial.taken) || {})) {
      if (!b.known[id]) b.known[id] = Number(b.trial.taken[id]) || at;
    }
    b.knownSeededAt = at;
    db.saveNow();
  }
  return b.known;
}

function hasMetBefore(userId) {
  return !!knownPeople()[String(userId)];
}

/** Write somebody down, and say whether this was the first time. */
function meetPerson(userId) {
  if (!userId) return false;
  const known = knownPeople();
  const key = String(userId);
  if (known[key]) return false;
  known[key] = Date.now();
  db.save();
  return true;
}

/** One person's reward record, made on demand. */
function rewardRecord(userId) {
  const led = rewardLedger();
  const key = String(userId);
  if (!led.people[key]) led.people[key] = { code: '', invited: [], claimed: 0, at: Date.now() };
  const rec = led.people[key];
  if (!Array.isArray(rec.invited)) rec.invited = [];
  if (!(Number(rec.claimed) >= 0)) rec.claimed = 0;
  return rec;
}

/**
 * The code that travels in the link.
 *
 * Random rather than the user's own id: a start payload is visible to
 * everybody the link is forwarded to, and a Telegram id is not the bot's to
 * publish. Made once and kept, so a link handed out stays good.
 */
function rewardCode(userId) {
  const led = rewardLedger();
  const rec = rewardRecord(userId);
  if (rec.code && led.codes[rec.code] === String(userId)) return rec.code;
  let code = '';
  for (let i = 0; i < 20 && !code; i += 1) {
    const candidate = crypto.randomBytes(6).toString('base64url');
    if (!led.codes[candidate]) code = candidate;
  }
  if (!code) code = crypto.randomBytes(9).toString('base64url');
  rec.code = code;
  led.codes[code] = String(userId);
  db.saveNow();
  return code;
}

function ownerOfCode(code) {
  const led = rewardLedger();
  return led.codes[String(code || '')] || '';
}

/**
 * Where somebody stands, and whether they may have it.
 *
 * One reward per account, until the admin resets - so this is not a running
 * balance that spends five arrivals and carries the rest. Somebody who has
 * taken theirs has taken it, and the screen says so instead of inviting them
 * to collect a second.
 */
function rewardStanding(userId) {
  const rec = rewardRecord(userId);
  const need = rewardSettings().need;
  const credited = rec.invited.length;
  const taken = Number(rec.claimed) > 0;
  return {
    credited,
    need,
    taken,
    takenAt: Number(rec.claimedAt) || 0,
    ready: !taken && credited >= need,
    left: Math.max(0, need - credited)
  };
}

/**
 * Somebody arrived through a link. Count them, if they count.
 *
 * Called from the start handler before anything else is done with the update,
 * because the one fact this depends on - whether the bot had met this person
 * before - stops being true the moment the update is handled.
 */
function creditReferral(ctx, code, wasNew) {
  if (!rewardOn()) return null;
  const owner = ownerOfCode(code);
  if (!owner) return null;
  if (String(owner) === String(ctx.userId)) return { self: true };
  if (!wasNew) return { known: true };
  /* never met by the bot, but a config or an order would still make them an
     existing customer: the ledger is seeded from both, so this is belt and
     braces for anybody added in between */
  const hasConfig = db.data.clients.some((c) => String(c.tgId || '') === String(ctx.userId));
  if (hasConfig) return { known: true };

  const rec = rewardRecord(owner);
  if (rec.invited.includes(String(ctx.userId))) return { already: true };
  rec.invited.push(String(ctx.userId));
  db.saveNow();
  return { counted: true, owner, standing: rewardStanding(owner) };
}

/**
 * Somebody arrived. Tell the inviter - and if that was the last one they
 * needed, hand the reward over there and then.
 *
 * Waiting for them to come back and press a button was one step too many: the
 * bot already knows they have earned it and already has them in a chat. So
 * the config arrives by itself, the moment it is due, and the only thing left
 * for the button to do is say where somebody stands.
 */
async function tellInviter(owner) {
  const standing = rewardStanding(owner);
  const plan = rewardPlan();
  if (!plan) return;

  if (standing.ready) {
    await send(owner, [
      '🎉 <b>آفرین! جایزه‌تان را بردید</b>',
      '',
      `${standing.need} نفر با لینک شما وارد ربات شدند.`,
      `<b>${escapeHtml(plan.name)}</b> همین حالا برایتان ساخته می‌شود…`
    ].join('\n'));
    await grantReward(owner, owner).catch((err) => {
      if (process.env.NEXV_TG_DEBUG) console.error('[bot] reward:', err.message);
    });
    return;
  }

  await send(owner, [
    '👤 <b>یک نفر با لینک شما وارد ربات شد</b>',
    '',
    `تا اینجا <b>${standing.credited}</b> نفر از <b>${standing.need}</b> نفر.`,
    standing.left === 1
      ? `فقط <b>۱ نفر</b> دیگر مانده تا <b>${escapeHtml(plan.name)}</b> رایگان مال شما شود 🎁`
      : `<b>${standing.left}</b> نفر دیگر تا <b>${escapeHtml(plan.name)}</b> رایگان.`
  ].join('\n'), [[{ text: '🔄 بررسی وضعیت', callback_data: 'b:rewardget:' }]]);
}

/**
 * What the panel shows about the reward: who is inviting, and what it has
 * cost. Sorted by who has brought the most, because that is the only ordering
 * anybody asks for.
 */
function rewardStats() {
  const led = rewardLedger();
  const need = rewardSettings().need;
  const rows = [];
  let invited = 0;
  let given = 0;
  for (const [userId, rec] of Object.entries(led.people || {})) {
    const count = Array.isArray(rec.invited) ? rec.invited.length : 0;
    const claimed = Number(rec.claimed) || 0;
    if (!count && !claimed) continue;
    invited += count;
    given += claimed;
    const client = db.data.clients.find((c) => String(c.tgId || '') === String(userId));
    rows.push({
      userId,
      username: client ? (client.tgUsername || '') : '',
      invited: count,
      taken: claimed > 0,
      takenAt: Number(rec.claimedAt) || 0,
      /* one per account, so what is left to say is how far off the next one
         they are - not a balance they can spend again */
      left: claimed > 0 ? 0 : Math.max(0, need - count)
    });
  }
  rows.sort((a, b) => b.invited - a.invited);
  return {
    need,
    invited,
    given,
    resetAt: Number(led.resetAt) || 0,
    people: rows.slice(0, 100),
    known: Object.keys(knownPeople()).length
  };
}

/**
 * What the invite link says when it is forwarded.
 *
 * This is the one piece of the whole feature a stranger reads. It is not a
 * caption on a link, it is the pitch: somebody is receiving it from a friend
 * with no idea what it is, and "come to this bot" persuades nobody. So it
 * says what the service is, what they get for nothing by turning up, and that
 * the same offer is waiting for them afterwards.
 */
function shareText(link) {
  const r = rewardSettings();
  const b = bot();
  const brand = b.brand || 'NexV';
  const plan = rewardPlan();
  const lines = [
    `🚀 ${brand} — اینترنت بدون محدودیت، ساده و سریع`,
    '',
    'من از این سرویس استفاده می‌کنم و راضی‌ام، گفتم به تو هم بگم 👇',
    '',
    '✅ سرعت بالا و اتصال پایدار، مخصوص ایران',
    '✅ مناسب موبایل، کامپیوتر و تلویزیون',
    '🎁 کانفیگ تست رایگان، همین اول کار',
    '💳 خرید مستقیم داخل ربات، چند ثانیه‌ای',
    '🎉 جایزه: با دعوت دوستانت اشتراک رایگان بگیر',
    '💬 پشتیبانی همیشه در دسترس'
  ];
  if (plan) lines.push('', `همین حالا وارد شو و ببین: با دعوت ${r.need} نفر، «${plan.name}» رایگان است.`);
  /* the link last, on its own line, with the arrow pointing at it and nothing
     after it - see shareUrl for why it cannot be left to Telegram */
  if (link) lines.push('', '👇 روی لینک بزن و استارت کن', '', link);
  else lines.push('', '👇 روی لینک بزن و استارت کن');
  return lines.join('\n');
}

/**
 * The share composer, with the link where somebody will read it.
 *
 * Telegram builds the shared message as the `url` parameter, then a newline,
 * then `text` - always in that order. So passing the link as `url` and the
 * pitch as `text` puts the link at the very top, above everything that
 * explains it, and the "tap the link below" line at the bottom points at
 * nothing. That is what it was doing.
 *
 * There is no parameter for the other order, so the whole message goes in as
 * `url` with the link written into its last line, and `text` is left out
 * entirely. The composer inserts that string as it is, Telegram links the
 * address inside it the way it links any address in any message, and the
 * message reads top to bottom the way it was written.
 */
function shareUrl(link) {
  return `https://t.me/share/url?url=${encodeURIComponent(shareText(link))}`;
}

/** The friendly default, when the admin has not written their own. */
function rewardBlurb(plan, need) {
  return [
    'سلام 👋',
    '',
    `اگر از ${escapeHtml(bot().brand || 'ما')} راضی هستید، می‌توانید بدون پرداخت هیچ هزینه‌ای یک اشتراک کامل هدیه بگیرید.`,
    '',
    `کافی است لینک اختصاصی زیر را برای دوستانتان بفرستید. وقتی <b>${need}</b> نفر با همین لینک وارد ربات شوند و استارت بزنند، `
      + `<b>${escapeHtml(plan.name)}</b> به‌صورت خودکار و رایگان برای شما ساخته می‌شود — لازم نیست کار دیگری بکنید.`,
    '',
    '📌 فقط کسانی حساب می‌شوند که تا به حال وارد این ربات نشده‌اند.'
  ].join('\n');
}

/**
 * The reward screen.
 *
 * Three states, and they look different on purpose: not started, part way
 * there, and done. Somebody who has already taken theirs is not shown a link
 * to share or a button to press - there is nothing left for them to do until
 * the admin opens it again, and leaving the buttons there would be an
 * invitation to go and collect something that is not coming.
 */
async function showReward(ctx) {
  const r = rewardSettings();
  const plan = rewardPlan();
  if (!r.enable) return reply(ctx, 'فعلاً جایزه‌ای تعریف نشده است.', backRow());
  if (!plan) {
    return reply(ctx, 'جایزه فعال است اما اشتراکش تنظیم نشده. لطفاً به پشتیبانی بگویید.', backRow());
  }

  const standing = rewardStanding(ctx.userId);

  /* already taken: the whole screen is a thank-you, with nothing to press */
  if (standing.taken) {
    return reply(ctx, [
      '🎁 <b>جایزه شما قبلاً تحویل داده شده است</b>',
      '',
      `اشتراک <b>${escapeHtml(plan.name)}</b> به حساب شما اضافه شد${standing.takenAt ? ` (${faDate(standing.takenAt)})` : ''}.`,
      'آن را در بخش <b>🔑 کانفیگ‌های من</b> می‌بینید.',
      '',
      'هر حساب فقط یک بار می‌تواند جایزه بگیرد. اگر دوباره باز شد، همین‌جا خبردار می‌شوید 🙂',
      '',
      'ممنون که ما را به دوستانتان معرفی کردید ❤️'
    ].join('\n'), [
      [{ text: '🔑 کانفیگ‌های من', callback_data: 'b:configs:' }],
      backRow()[0]
    ]);
  }

  const me = await botUsername();
  if (!me) {
    return reply(ctx, 'ربات هنوز آماده نیست. چند لحظه بعد دوباره امتحان کنید.', backRow());
  }

  const code = rewardCode(ctx.userId);
  const link = `https://t.me/${me}?start=ref_${code}`;

  /*
   * The link first, then where they stand, then the explanation.
   *
   * It was the other way round, with a paragraph above it, so the one thing
   * somebody opened this screen to get was below the fold on a phone. What
   * they came for goes at the top; the words that explain it are still there
   * for whoever reads on.
   */
  const lines = [
    `<b>${escapeHtml(r.label)}</b>`,
    '',
    '🔗 <b>لینک اختصاصی شما</b> — برای کپی روی آن بزنید:',
    `<code>${escapeHtml(link)}</code>`,
    '',
    `👥 تا اینجا <b>${standing.credited}</b> نفر از <b>${standing.need}</b> نفر`,
    standing.left === 1
      ? '🔥 فقط یک نفر دیگر مانده!'
      : `هنوز <b>${standing.left}</b> نفر دیگر لازم است.`,
    '',
    '━━━━━━━━━━━━━━',
    r.text ? escapeHtml(r.text) : rewardBlurb(plan, standing.need),
    '',
    '⚡️ به‌محض رسیدن به عدد لازم، اشتراک خودکار برایتان ساخته و همین‌جا فرستاده می‌شود.'
  ];

  return reply(ctx, lines.join('\n'), [
    [{ text: '📤 فرستادن لینک برای دوستان', url: shareUrl(link) }],
    [{ text: '🔄 بررسی وضعیت', callback_data: 'b:rewardget:' }],
    backRow()[0]
  ]);
}

/*
 * There was a bar of ten squares here, and it is gone.
 *
 * It read as a row of empty boxes rather than as progress - the green and the
 * grey are two emoji that many clients draw at different widths and some draw
 * as the same plain square, so what the admin saw was a line of grey boxes
 * above the number that already said the same thing. The number says it.
 */

/** A date somebody reads, on their own calendar. */
function faDate(at) {
  try {
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'Asia/Tehran' }).format(new Date(at));
  } catch (_) { return ''; }
}

/**
 * Hand the reward over.
 *
 * The config is cut by the same function a sale uses, with an order written
 * down at a price of zero - so it shows up in the admin's list as what it was,
 * and so the config carries the plan's quota and term without any of that
 * being worked out a second time here.
 *
 * Called from the arrival that completes the count, and from the button for
 * anybody who earned it before this was automatic.
 */
async function grantReward(userId, chatId, ctx) {
  const plan = rewardPlan();
  if (!rewardOn() || !plan) return { ok: false, reason: 'no reward on offer' };

  const standing = rewardStanding(userId);
  if (standing.taken) return { ok: false, reason: 'already taken' };
  if (!standing.ready) return { ok: false, reason: 'not enough yet' };

  const b = bot();
  const order = {
    id: db.id(),
    at: Date.now(),
    planId: plan.id,
    planName: plan.name,
    price: 0,
    userId,
    chatId: chatId || userId,
    username: (ctx && ctx.username) || '',
    name: (ctx && ctx.name) || '',
    clientName: '',
    renewClientId: '',
    method: 'reward',
    status: 'reward'
  };
  b.orders.unshift(order);
  if (b.orders.length > 500) b.orders.length = 500;

  /* marked taken before the config is cut, not after: two arrivals landing at
     the same moment would otherwise each find the count complete */
  const rec = rewardRecord(userId);
  rec.claimed = Number(rec.claimed) + 1;
  rec.claimedAt = Date.now();
  db.saveNow();

  const handed = await deliverOrder(order);
  if (!handed.ok) {
    rec.claimed = Math.max(0, Number(rec.claimed) - 1);
    rec.claimedAt = 0;
    order.status = 'failed';
    order.error = handed.error;
    db.saveNow();
    await send(order.chatId, `ساخت کانفیگ جایزه ممکن نشد: ${escapeHtml(handed.error)}\nلطفاً به پشتیبانی بگویید.`);
    return { ok: false, reason: handed.error };
  }

  order.status = 'done';
  order.clientId = handed.client.id;
  db.saveNow();

  await tellAdmin([
    '<b>جایزه دعوت تحویل شد</b>',
    `اشتراک: ${escapeHtml(plan.name)}`,
    ...buyerLines(order)
  ].join('\n')).catch(() => {});

  await sendConfig(order.chatId, handed.client,
    '<b>🎁 جایزه شما آماده شد</b>',
    `${escapeHtml(plan.name)} — رایگان، بابت دعوت ${standing.need} نفر`);
  return { ok: true, client: handed.client };
}

/**
 * The check button, which has to say something.
 *
 * Pressing it used to redraw the same screen, and Telegram answers an edit
 * that changes nothing with an error - so the screen was posted a second
 * time underneath and the tap itself said nothing at all. Whatever the
 * answer is, it is now given as an alert on the button: the reward is on its
 * way, or nobody has come in yet, or this many are still needed. The screen
 * is refreshed afterwards, which does nothing visible when nothing changed.
 *
 * It still hands the reward over when it is due. The delivery is automatic,
 * so this only ever catches somebody who crossed the line while the bot was
 * down - but that is exactly the person most likely to come and press it.
 */
async function claimReward(ctx) {
  const plan = rewardPlan();
  const alert = (text) => { if (ctx.answer) ctx.answer(text, true); };

  if (!rewardOn() || !plan) {
    alert('این بخش فعلاً فعال نیست.');
    return showReward(ctx);
  }

  const standing = rewardStanding(ctx.userId);

  if (standing.taken) {
    alert('شما جایزه‌تان را قبلاً گرفته‌اید 🎁\nدر بخش «کانفیگ‌های من» ببینیدش.');
    return showReward(ctx);
  }

  if (standing.ready) {
    alert(`تایید شد ✅\n«${plan.name}» همین حالا برایتان ساخته و فرستاده می‌شود.`);
    const out = await grantReward(ctx.userId, ctx.chatId, ctx);
    if (out.ok) return null;
    await send(ctx.chatId, 'ساخت کانفیگ جایزه ممکن نشد. لطفاً به پشتیبانی بگویید.');
    return null;
  }

  if (!standing.credited) {
    alert('هنوز هیچ‌کس با لینک شما وارد ربات نشده است.\n'
      + `لینکتان را برای دوستانتان بفرستید — با ${standing.need} نفر، جایزه برایتان ارسال می‌شود.`);
  } else {
    alert(`تا اینجا ${standing.credited} نفر از ${standing.need} نفر ✅\n`
      + `${standing.left} نفر دیگر مانده تا «${plan.name}» رایگان برایتان ارسال شود.`);
  }
  return showReward(ctx);
}

/**
 * Let everybody have another one.
 *
 * Both halves are cleared, not just the "taken" mark: leaving the arrivals
 * behind would mean everybody who had already earned one qualified again the
 * instant the reset ran, off invitations they were paid for once already. The
 * codes stay, so the links people are holding keep working.
 */
function resetRewards() {
  const led = rewardLedger();
  let people = 0;
  for (const rec of Object.values(led.people || {})) {
    if (Number(rec.claimed) > 0 || (rec.invited || []).length) people += 1;
    rec.claimed = 0;
    rec.claimedAt = 0;
    rec.invited = [];
  }
  led.resetAt = Date.now();
  db.saveNow();
  return { people };
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
    /*
     * There is nowhere to send it, and the admin is the only one who can fix
     * that - so it is written down for them rather than only apologised for
     * to the buyer. A bot cannot open a chat with an @username: until the
     * person behind that name has pressed Start on this bot once, there is no
     * chat id to send to and no way to find one out.
     */
    const b = bot();
    runtime.adminError = b.adminId
      ? `the admin (${b.adminId}) has never messaged this bot, so there is no chat to send to`
      : 'no admin is set on the Bot page';
    db.data.logs.unshift({ at: Date.now(), type: 'bot',
      message: `a support message from ${ctx.userId} went nowhere: ${runtime.adminError}` });
    if (db.data.logs.length > 500) db.data.logs.length = 500;
    db.save();
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
    /* what is actually owed: the plan keeps the price the admin typed, and
       the discount is applied here, once, where the money is decided */
    price: chargeFor(plan),
    listPrice: String(plan.price || ''),
    offerPercent: offerFor(plan),
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

/**
 * Everything about one config, in the order somebody reads it.
 *
 * Written once and used twice - by the delivery a buyer gets and by the card
 * behind "my configs" - because they were two different screens showing the
 * same thing, and the one you got after paying was the better of the two. A
 * config somebody comes back to look at is the same config; there is no
 * reason for it to arrive stripped of its QR, its direct links and its
 * explanation just because the asking was done with a button.
 *
 * `usage` adds the figures - what is spent, what is left, how long - which
 * belong on the card somebody opens on purpose and would only be noise on the
 * one that arrives the second they have paid.
 */
function configCard(client, opts) {
  const o = opts || {};
  const api = require('./routes/api');
  const url = api.subUrl(client.subId);
  const lines = [];

  if (o.title) lines.push(o.title);
  lines.push(`🔑  <b>${escapeHtml(client.email)}</b>`, '');
  if (o.extra) lines.push(o.extra, '');

  if (o.usage) {
    const used = (client.up || 0) + (client.down || 0);
    const quota = (client.totalGB || 0) * 1024 ** 3;
    const plan = planOf(client);
    const where = membership.inboundsOf(client, db.data.inbounds).map((i) => i.remark).join(' + ');
    const off = client.enable === false || client.autoDisabled;

    if (plan) lines.push(`📦  اشتراک:  <b>${escapeHtml(plan)}</b>`);
    lines.push(`📊  مصرف‌شده:  <b>${bytes(used)}</b>`);
    lines.push(`💾  حجم کل:  <b>${quota ? bytes(quota) : 'نامحدود'}</b>`);
    if (quota) {
      const left = Math.max(0, quota - used);
      lines.push(`📉  باقی‌مانده:  <b>${bytes(left)}</b>  (${Math.max(0, 100 - Math.min(100, Math.round((used / quota) * 100)))}٪)`);
    }
    lines.push(`⏳  زمان باقی‌مانده:  <b>${timeLeft(client)}</b>`);
    if (where) lines.push(`🌐  سرور:  <b>${escapeHtml(where)}</b>`);
    lines.push(`${off ? '⛔️' : '✅'}  وضعیت:  <b>${off ? 'غیرفعال' : 'فعال'}</b>`, '');
  }

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
  lines.push('', '❓ اگر بلد نیستید، دکمه <b>راهنمای اتصال</b> را بزنید.');
  return { text: lines.join('\n'), url };
}

/** What this config was sold as, when we can still tell. */
function planOf(client) {
  const order = (bot().orders || []).find((o) => o.clientId === client.id);
  if (order && order.planName) return order.planName;
  if (client.isTrial) return 'کانفیگ تست';
  return '';
}

async function sendConfig(chatId, client, title, extra, opts) {
  const o = opts || {};
  const built = configCard(client, { title, extra, usage: !!o.usage });
  const url = built.url;
  const text = built.text;
  const keys = o.keys || [[{ text: '❓ راهنمای اتصال', callback_data: 'b:screen:help' }], ...backRow()];

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
  /*
   * A caption is not a message, and that is why the fold never appeared.
   *
   * Telegram gives a photo's whole caption its own "show more" and renders
   * what is inside it flat: an expandable quote in a caption comes out as
   * ordinary text with no bar and nothing to tap. The fold only works when it
   * is a top-level entity of a message of its own.
   *
   * So the single bubble is kept only when there is nothing to fold. Once
   * there is, the picture goes first with a line of its own and the configs
   * follow as a real message - two bubbles, and the thing actually folds.
   */
  /*
   * One bubble: the QR and everything about the config in a single message.
   *
   * This is a straight trade and it is worth writing down, because it was
   * made the other way round once already. Telegram renders a photo's caption
   * flat - a quote in one keeps its bar but not its fold, since the caption
   * already has a "show more" of its own. So the configs can be folded, or
   * they can be in the same bubble as the picture, and not both. Together is
   * what was asked for, so the quote stays in the markup and does whatever
   * the client does with it, and the picture carries the words.
   *
   * Two messages only when the caption cannot hold it: Telegram caps one at
   * 1024 characters of visible text, and a config too long for that is still
   * a config that has to arrive.
   */
  const deliver = async (body, withQr) => {
    if (withQr) {
      try {
        const png = await qrPng(url);
        if (png && visibleLength(body) <= 1000) {
          return await uploadPhoto(chatId, 'sub.png', png, body, keys);
        }
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
   * renew: the volume is added to what is left, the time is replaced by the
   * term they just bought. Nothing about the config changes - same link, same
   * name - so the app on their phone keeps working and simply has more in it.
   *
   * The config is found by its id and nothing else. It used to have to match
   * the buyer's Telegram id as well, which reads like a sensible check and is
   * not one: the id in the order came from this buyer's own list of configs in
   * the first place, so the only thing the second half could do was fail on a
   * config whose tgId had since been edited in the panel - and failing here
   * does not stop the delivery, it cuts a brand new config instead. That is
   * exactly the "I renewed and got a second service" that this is about.
   */
  if (order.renewClientId) {
    const client = db.data.clients.find((c) => c.id === order.renewClientId);
    if (client) {
      try {
        // whoever paid owns it now, so a renewed config answers to their id
        if (!client.tgId) client.tgId = String(order.userId);
        if (!client.tgUsername && order.username) client.tgUsername = order.username;
        return { ok: true, renewed: true, plan, client: await topUp(client, plan) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    /* the config really is gone - deleted between buying and delivering. A new
       one is the only thing left to hand over, and the admin is told, because
       from the buyer's side this looks like the bug we just fixed. */
    await tellAdmin([
      '<b>تمدید روی کانفیگ قبلی انجام نشد</b>',
      'کانفیگی که خریدار تمدیدش کرده بود پیدا نشد (حذف شده) — یک کانفیگ تازه تحویل داده شد.',
      ...buyerLines(order)
    ].join('\n')).catch(() => {});
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
 * Put a plan onto a config that already exists.
 *
 * Volume is added and time is replaced, which is not an inconsistency - it is
 * what each of the two is. Gigabytes a buyer paid for and did not use are
 * theirs, so five left over plus ten bought is fifteen. A month is not a
 * quantity like that: it is how long the service runs for, and somebody who
 * buys a month gets a month. Adding the ten days still on the old clock to it
 * would mean the same thousand tomans bought a different amount of time
 * depending on when it was spent, and would pay anybody who renews early.
 *
 * So one month bought with ten days left is one month from now, two months is
 * two, three is three.
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
    if (!client.expiryTime && client.startAfterFirstUse && !client.startedAt) {
      /* never opened, so there is no clock running to replace - the new term
         simply becomes the term it will start with on first use */
      client.expiryDays = plan.days;
    } else {
      client.expiryTime = now + plan.days * 86400000;
      client.expiryDays = plan.days;
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
  /* the same tolerant lookup the gateway buttons use: a button built by an
     older build of this carries a shortened id, and a button that does
     nothing is worse than one that works */
  const order = orderByToken(orderId);
  if (!order) {
    return markHandled(ctx, '❓ این سفارش پیدا نشد',
      'این سفارش پیدا نشد — شاید پاک شده باشد.');
  }
  if (order.status === 'done') {
    return markHandled(ctx, '✅ قبلاً تایید شده بود', 'این سفارش قبلاً تایید شده است.');
  }

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
      return markHandled(ctx, '✅ تایید شد', [
        `<b>✅ سفارش تایید شد</b> — ${escapeHtml(order.planName || '')}`,
        `کانفیگ <code>${escapeHtml(client.email)}</code> فعال است.`,
        'به خریدار اطلاع داده شد.'
      ].join('\n'));
    }
  }

  // not delivered at the time - do it now
  const handed = await deliverOrder(order);
  if (!handed.ok) {
    order.status = 'failed';
    order.error = handed.error;
    db.saveNow();
    /* the buttons stay: this is worth trying again once whatever stopped it
       is sorted, and taking them away would leave nothing to press */
    if (ctx.answer) ctx.answer(`ساخت کانفیگ ناموفق بود:\n${handed.error}`, true);
    return send(ctx.chatId, `ساخت کلاینت ناموفق بود: ${escapeHtml(handed.error)}`);
  }

  order.status = 'done';
  order.clientId = handed.client.id;
  db.saveNow();

  await sendConfig(order.chatId || order.userId, handed.client,
    '<b>اشتراک شما آماده شد ✅</b>',
    `${escapeHtml(handed.plan.name)} · ${handed.plan.gb ? `${handed.plan.gb} گیگ` : 'نامحدود'} · ${handed.plan.days} روز`);
  return markHandled(ctx, '✅ تایید شد — کانفیگ ساخته شد', [
    `<b>✅ سفارش تایید شد</b> — ${escapeHtml(order.planName || '')}`,
    `کانفیگ <code>${escapeHtml(handed.client.email)}</code> ساخته و برای خریدار ارسال شد.`
  ].join('\n'));
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
  const order = orderByToken(orderId);
  if (!order) {
    return markHandled(ctx, '❓ این سفارش پیدا نشد',
      'این سفارش پیدا نشد — شاید پاک شده باشد.');
  }
  if (order.status === 'rejected') {
    return markHandled(ctx, '✖️ قبلاً رد شده بود', 'این سفارش قبلاً رد شده است.');
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

  return markHandled(ctx,
    cut ? '✖️ رد شد — کانفیگ حذف شد' : '✖️ رد شد',
    [
      `<b>✖️ سفارش رد شد</b> — ${escapeHtml(order.planName || '')}`,
      cut ? 'کانفیگ خریدار حذف شد.' : 'کانفیگی برای حذف نبود.',
      'به خریدار اطلاع داده شد.'
    ].join('\n'));
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
    case 'reward': return showReward(ctx);
    case 'rewardget': return claimReward(ctx);
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
    case 'ok':
    case 'no': {
      if (!ctx.isAdmin) {
        if (ctx.answer) ctx.answer('فقط ادمین می‌تواند این کار را انجام دهد.', true);
        return send(ctx.chatId, 'فقط ادمین می‌تواند این کار را انجام دهد.');
      }
      return action === 'ok' ? approveOrder(ctx, value) : rejectOrder(ctx, value);
    }
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
    /*
     * Whether the bot had met this person before, decided here and nowhere
     * else. It is the one fact the reward rests on, and it stops being true
     * the moment anything writes them down - so it is read first, before the
     * update is handled at all.
     */
    const firstEver = meetPerson(ctx.userId);
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
    if (inSupport && inSupport.kind === 'support' && !text.startsWith('/')) {
      /*
       * The admin testing their own support button.
       *
       * This used to fall straight through to the command lookup, so the
       * message vanished and the main menu appeared - which looks exactly
       * like support being broken, and is the first thing anybody does to
       * check that it works. It cannot be relayed: the admin is the person it
       * would be relayed to. So it is answered.
       */
      if (ctx.isAdmin) {
        forget(ctx.userId);
        await send(ctx.chatId, [
          '🛟 <b>این‌جا پیام‌های پشتیبانی به شما می‌رسد</b>',
          '',
          'شما ادمین این ربات هستید، پس پیامتان جایی برای رفتن ندارد —'
          + ' پیام‌های مشتری‌ها به همین چت می‌آید و با دکمه‌ی «پاسخ» جواب می‌دهید.',
          '',
          'برای امتحان‌کردن، از یک اکانت دیگر به ربات پیام بدهید.'
        ].join('\n'), backRow());
        return null;
      }
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
    /* the start payload, read once: two things below look at it */
    const started = /^\/start\s+(\S+)/.exec(text);
    if (/^\/start\b/.test(text)) countStart();

    /*
     * Somebody arriving on an invite link.
     *
     * Counted before the channel gate, not after. They have started the bot,
     * which is the thing being counted, and whether they then go and join a
     * channel is a different question with its own screen - leaving the
     * credit on the far side of the gate would mean an admin who runs one
     * quietly gets no reward counts at all.
     *
     * The inviter is told while their friend is still looking at the bot, and
     * a link opened a second time does not count twice. Either way the
     * arrival goes on to the ordinary start screen, through the gate if there
     * is one: they came here to use the bot, not to be a statistic.
     */
    if (started && /^ref_/i.test(started[1])) {
      const out = creditReferral(ctx, started[1].slice(4), firstEver);
      if (out && out.counted) await tellInviter(out.owner).catch(() => {});
      if (await gate(ctx)) return null;
      return showScreen(ctx, 'start');
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
    meetPerson(ctx.userId);
    /* what the message being acted on says, so an action that rewrites it
       with its verdict can keep the details underneath */
    ctx.sourceText = query.message.caption || query.message.text || '';
    // held until the gate has spoken, so its message can be the alert
    ctx.answer = (text, alert) => answer(query.id, text, alert);
    const [, action, ...rest] = String(query.data || '').split(':');
    /* these answer the tap themselves, with something worth reading: the
       membership re-check and the reward check both have a verdict to give,
       and a callback may only be answered once */
    const SPEAKS = ['joined', 'rewardget', 'ok', 'no'];
    if (!SPEAKS.includes(action) && await gate(ctx)) {
      if (ctx.answer) ctx.answer();
      return null;
    }
    if (!SPEAKS.includes(action) && ctx.answer) ctx.answer();
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
  /* ones whose term had already run out: reported, never backdated */
  let noted = 0;

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
     * sold plus what was paid for.
     *
     * Unless that deadline is already behind us. This used to write it anyway,
     * on the grounds that it was the true answer for a config that had been
     * running free - and the result was a client the admin had deliberately
     * left without a limit, or one sold long enough ago, turning up in the
     * list as Expired with no quota and no date the admin had ever set. The
     * config was working; the panel decided on its own that it was not.
     *
     * A date in the past is not a repair, it is a deletion with extra steps.
     * So it is left alone and said out loud instead, and whoever reads the log
     * decides whether that config should end or be renewed.
     */
    if (Number(c.expiryDays) > 0) continue;
    const term = soldTerm(c);
    if (!term) continue;
    const from = Number(c.createdAt) || now;
    const until = from + term.days * 86400000;
    if (until <= now) {
      noted++;
      d.logs.unshift({ at: now, type: 'client',
        message: `${c.email} was sold with no time limit; the ${term.days} days from `
          + `${term.how} ran out on ${new Date(until).toISOString().slice(0, 10)}. `
          + 'Left running - set a date on it or renew it if it should end.' });
      continue;
    }
    c.expiryDays = term.days;
    c.expiryTime = until;
    c.startAfterFirstUse = false;
    c.startedAt = c.startedAt || from;
    rebuilt++;
    d.logs.unshift({ at: now, type: 'client',
      message: `${c.email} was sold with no time limit at all; ${term.days} days read back from `
        + `${term.how}, counting from the day it was sold` });
  }

  if (!dated && !rebuilt && !noted) return { dated: 0, rebuilt: 0, noted: 0 };
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
  // nothing to push at Xray when all we did was write in the log
  if (dated || rebuilt) await require('./xray').apply();
  return { dated, rebuilt, noted };
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
  if (typeof s.onChange !== 'boolean') s.onChange = false;
  return s;
}

/*
 * How long a change is left alone before the backup goes, and the shortest
 * gap between two of them.
 *
 * Saving a plan touches the store three or four times in as many seconds, and
 * a buyer going through checkout touches it again at every step. Sending on
 * each one would be a dozen files for one piece of work, in a chat where the
 * useful thing is being able to find the latest. So a change waits for things
 * to go quiet, and a burst arrives as one file.
 */
const CHANGE_QUIET_MS = 90000;
const CHANGE_FLOOR_MS = 300000;

/**
 * A fingerprint of everything worth backing up.
 *
 * Everything in the store changes constantly - traffic counters tick on every
 * poll, a client's last-seen moves whenever somebody connects, the log grows.
 * A backup on every one of those is a backup every thirty seconds and nobody
 * reads any of them. What counts as a change here is what an admin or a buyer
 * did: an inbound, a client, a plan, a setting, an order, a reseller, an
 * account. The volatile fields are dropped before the hash, so a quiet server
 * carrying traffic produces the same fingerprint all day.
 */
function stateFingerprint() {
  const d = db.data;
  const b = d.bot || {};
  const clients = (d.clients || []).map((c) => Object.assign({}, c, {
    up: 0, down: 0, ips: undefined, lastSeen: 0, lastSeenAt: 0, onlineAt: 0
  }));
  const server = Object.assign({}, d.server || {});
  // the login password rotates on a timer and is stripped from the file
  // anyway, so a rotation is not a reason to send one
  delete server.password;
  delete server.setAt;
  const slim = {
    settings: d.settings,
    users: d.users,
    inbounds: d.inbounds,
    clients,
    outbounds: d.outbounds,
    routing: d.routing,
    resellers: d.resellers,
    server,
    bot: Object.assign({}, b, { backup: undefined })
  };
  return crypto.createHash('sha256').update(JSON.stringify(slim)).digest('hex');
}

/**
 * Send one when something has actually changed and then settled.
 *
 * Returns quietly when it is switched off, when nothing has moved, while a
 * burst is still arriving, or while the floor since the last one has not
 * passed - so this is safe to call on a short timer.
 */
async function backupOnChange() {
  const s = backupSettings();
  if (!s.onChange) return false;
  const now = Date.now();
  const fp = stateFingerprint();

  // the first run after it is switched on only learns where things stand
  if (!s.changeFp) { s.changeFp = fp; db.save(); return false; }
  if (fp === s.changeFp) {
    if (s.changedAt) { s.changedAt = 0; db.save(); }
    return false;
  }

  if (!s.changedAt) { s.changedAt = now; db.save(); return false; }
  if (now - s.changedAt < CHANGE_QUIET_MS) return false;
  if (now - Number(s.changeSentAt || 0) < CHANGE_FLOOR_MS) return false;

  await sendBackup('پشتیبان خودکار - بعد از تغییر');
  s.changeFp = fp;
  s.changedAt = 0;
  s.changeSentAt = Date.now();
  db.saveNow();
  return true;
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

/* the scheduled slots and the after-a-change one share the same minute tick;
   each decides for itself whether anything is due */
async function backupBeat() {
  await backupTick();
  try {
    await backupOnChange();
  } catch (err) {
    const s = backupSettings();
    s.lastError = err.message;
    db.save();
    if (process.env.NEXV_TG_DEBUG) console.error('[bot] change backup:', err);
  }
}

function watchBackups() {
  if (backupTimer) return backupTimer;
  backupTimer = setInterval(backupBeat, 60000);
  if (typeof backupTimer.unref === 'function') backupTimer.unref();
  return backupTimer;
}

/** What the Bot page shows about backups. */
function backupStatus() {
  const s = backupSettings();
  return {
    enable: !!s.enable,
    onChange: !!s.onChange,
    changeSentAt: Number(s.changeSentAt) || 0,
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
  /* the reward: its settings, where everybody stands, and the admin's view */
  rewardSettings, rewardPlan, rewardOn, rewardStanding, rewardRecord, rewardCode,
  creditReferral, showReward, claimReward, grantReward, resetRewards, shareText, shareUrl,
  knownPeople, meetPerson, hasMetBefore,
  rewardStats, keyboardFor, pairStartRows,
  offerSettings, offerFor, offerOn, planCost, chargeFor, offerBanner, planButton, planLine,
  startBroadcast, stopBroadcast, broadcastStatus, audienceCounts, audienceIds,
  botStats,
  send, escapeHtml, payWays, call, channel, gateOn, joinLink, adminChat, buyerLines,
  sendBackup, backupStatus, backupSettings, backupTimes, watchBackups, minutesOf, nextBackupAt, backupTick,
  backupOnChange, stateFingerprint, backupBeat,
  payLabel, customLabel, picksTerm, deliverOrder, topUp, settleGateway, sweepGateway, watchGateway, orderByToken,
  /* the entry point for one update: what the polling loop feeds, and what a
     webhook would feed if this ever grows one */
  handle
};
