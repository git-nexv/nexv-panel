'use strict';
/**
 * The server's own login password, set from the panel.
 *
 * One thing this cannot do, and it is the first thing anybody asks for:
 * show the password the server already has. Linux does not keep it. What is
 * in /etc/shadow is a one-way hash - the system checks a login by hashing
 * what was typed and comparing, and there is no step that runs backwards. No
 * program on the box can read that password out, this one included, and any
 * panel that claims to show you your current root password is either lying or
 * stored it in the clear beforehand.
 *
 * So the rule here is: the panel can only show a password it set itself. Set
 * one from the panel, or let the rotation set one, and it is shown from then
 * on. Until then there is nothing honest to display and the page says so.
 *
 * That does mean a password the panel set is kept in the clear in db.json.
 * It is worth being plain about what that is and is not worth. Anybody who
 * can already read db.json can also write it, and the panel runs as root -
 * they could add themselves an inbound, or a reseller, or simply set the
 * password themselves. So this is not the thing that hands the box over.
 * What it would change is a backup: those leave the machine, they go to
 * Telegram, and one sitting in a chat must not carry the root password. The
 * backup strips it for exactly that reason.
 *
 * There was briefly a choice of what the automatic password should be made
 * of - the Tehran clock, an authenticator code - and both are gone. The clock
 * had 1440 possible values and was written on every watch in the country; the
 * authenticator could not be a stored password at all, because a code lives
 * for its window while /etc/shadow holds one value until something changes
 * it. What is left is the one that was always right: a long random password,
 * shown here, changed as often as the admin asks.
 */
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const db = require('./db');

/* No l/I/1 or O/0: this gets read off a phone screen and typed into a
   terminal, and a password nobody can transcribe is a lockout. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const ZONE = 'Asia/Tehran';
/* Iran stopped putting its clocks forward in 2022, so +03:30 is right all
   year. Only used if this Node was built without the timezone data. */
const FALLBACK_OFFSET_MINUTES = 210;
const DEFAULT_LENGTH = 20;
const MIN_LENGTH = 8;
const DEFAULT_EVERY_HOURS = 5;
/* an hour at the short end and a month at the long: below an hour this stops
   being a password and becomes a nuisance, and beyond a month "automatic" is
   not really what is happening */
const MIN_EVERY_HOURS = 1;
const MAX_EVERY_HOURS = 24 * 30;

/** Where this lives in the store, with its parents made if they are missing. */
function settings() {
  const d = db.data;
  if (!d.server || typeof d.server !== 'object') d.server = {};
  const s = d.server;
  if (typeof s.user !== 'string' || !s.user) s.user = 'root';
  if (typeof s.autoRotate !== 'boolean') s.autoRotate = false;
  if (!(Number(s.everyHours) > 0)) s.everyHours = DEFAULT_EVERY_HOURS;
  if (typeof s.notifyBot !== 'boolean') s.notifyBot = false;
  if (typeof s.notifyError !== 'string') s.notifyError = '';
  if (typeof s.password !== 'string') s.password = '';
  if (!(Number(s.setAt) >= 0)) s.setAt = 0;
  /* settings written while the clock and authenticator styles existed carry
     fields that mean nothing now; dropped on the first read rather than left
     to puzzle whoever opens db.json next */
  for (const gone of ['style', 'secret', 'totpSecret', 'totpDigits']) delete s[gone];
  return s;
}

/** The whole Tehran date and time, for the panel to show. */
function tehranStamp(at) {
  if (!at) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date(at));
  } catch (_) {
    const shifted = new Date(Number(at) + FALLBACK_OFFSET_MINUTES * 60000);
    return shifted.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * A password worth having, from the system's own randomness.
 *
 * randomInt rather than a byte modulo an alphabet length: the modulo makes
 * the first few letters fractionally likelier than the last, which is a silly
 * way to weaken something whose whole job is to be unguessable.
 */
function generate(length) {
  const want = Math.max(MIN_LENGTH, Number(length) || DEFAULT_LENGTH);
  let out = '';
  for (let i = 0; i < want; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** Whether this box can have its password set from here at all. */
function canManage() {
  if (process.platform !== 'linux') return { ok: false, why: 'this is not a Linux server' };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { ok: false, why: 'the panel is not running as root' };
  }
  const tool = ['/usr/sbin/chpasswd', '/sbin/chpasswd', '/usr/bin/chpasswd']
    .find((p) => fs.existsSync(p));
  if (!tool) return { ok: false, why: 'chpasswd is not installed on this server' };
  return { ok: true, tool };
}

/**
 * Hand the password to chpasswd on its standard input.
 *
 * Never as an argument: every process on the box can read another's command
 * line out of /proc, so a password passed that way is a password published to
 * anybody with a shell for as long as the command runs.
 */
function apply(user, password) {
  const can = canManage();
  if (!can.ok) return Promise.reject(new Error(can.why));
  return new Promise((resolve, reject) => {
    const child = execFile(can.tool, [], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        /* whatever chpasswd said, minus anything that could be the password
           itself coming back in an error */
        const why = String(stderr || err.message).split('\n')[0].trim();
        return reject(new Error(why.replace(password, '***') || 'chpasswd refused it'));
      }
      return resolve(true);
    });
    child.stdin.on('error', reject);
    child.stdin.end(`${user}:${password}\n`);
  });
}

/** Set it to something the admin chose. */
async function setPassword(password, user) {
  const want = String(password == null ? '' : password);
  if (want.length < MIN_LENGTH) throw new Error(`a password of at least ${MIN_LENGTH} characters, please`);
  if (/[\s:]/.test(want)) throw new Error('no spaces or colons: chpasswd reads a colon as the end of the name');
  const s = settings();
  const who = String(user || s.user || 'root');
  await apply(who, want);
  s.user = who;
  s.password = want;
  s.setAt = Date.now();
  db.saveNow();
  const told = await announce('manual');
  return { user: who, at: s.setAt, sentToBot: !!told.sent };
}

/** Set it to something nobody has ever seen, including whoever asked. */
async function rotate(reason) {
  const s = settings();
  const next = generate(DEFAULT_LENGTH);
  await apply(s.user || 'root', next);
  s.password = next;
  s.setAt = Date.now();
  db.saveNow();
  const told = await announce(reason || 'manual');
  return { user: s.user, at: s.setAt, sentToBot: !!told.sent };
}

/**
 * Send the new password to the bot's admin, when the admin has asked for it.
 *
 * Worth being plain about what this is: it puts the server's root password in
 * a Telegram chat. That is a chat on a phone that can be lost, on an account
 * that can be taken over, and the message sits there until somebody deletes
 * it - which is exactly why a backup strips this password out before it is
 * sent anywhere. It is off unless it is switched on, it goes only to the one
 * chat id the bot calls its admin, and nowhere else.
 *
 * What it buys is the thing it was asked for: a password that changes itself
 * every few hours is no use at all if the only place to read it is a panel
 * you cannot reach without it, and this is the way back in.
 *
 * It never throws. A password that was changed on the server and could not be
 * announced is still changed, and the caller must not be made to think
 * otherwise - the failure goes in the settings and onto the page instead.
 */
async function announce(reason) {
  const s = settings();
  if (!s.notifyBot || !s.password) return { sent: false };
  let telegram;
  try { telegram = require('./telegram'); } catch (_) { return { sent: false }; }

  const lines = [
    '🔐 <b>رمز ورود سرور عوض شد</b>',
    '',
    `کاربر: <code>${telegram.escapeHtml(s.user || 'root')}</code>`,
    `رمز تازه: <code>${telegram.escapeHtml(s.password)}</code>`,
    `زمان: ${telegram.escapeHtml(tehranStamp(s.setAt))} (به وقت ایران)`,
    '',
    reason === 'auto' ? 'این تغییر خودکار بود.' : 'این تغییر از داخل پنل انجام شد.',
    '',
    '⚠️ این پیام رمز سرور شما را دارد. بعد از ذخیره‌کردنش پاکش کنید.'
  ];

  /* the admin's own chat id, which the bot only has once they have pressed
     Start: a bot cannot open a conversation, so there is nowhere to send to
     until they have said hello once */
  const chat = telegram.adminChat();
  if (!chat) {
    s.notifyError = 'the bot does not know the admin chat yet - press Start in the bot once';
    db.save();
    return { sent: false, error: s.notifyError };
  }

  try {
    /* call rather than send: send swallows the error and answers undefined,
       which would have this reporting a password as delivered when Telegram
       had refused it - and this is the message somebody locked out of their
       server is relying on */
    await telegram.call('sendMessage', {
      chat_id: chat,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    s.notifyError = '';
    db.save();
    return { sent: true };
  } catch (err) {
    s.notifyError = err.message;
    db.save();
    return { sent: false, error: err.message };
  }
}

/** When the next automatic change falls due, or 0 when none does. */
function nextDue() {
  const s = settings();
  if (!s.autoRotate) return 0;
  const every = hoursOf(s.everyHours) * 3600000;
  /* counted from the last change of any kind, so setting one by hand puts the
     clock back to the start rather than being overwritten minutes later */
  const since = Number(s.setAt) || 0;
  return since ? since + every : Date.now();
}

/** A sane number of hours, whatever arrived. */
function hoursOf(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVERY_HOURS;
  return Math.min(MAX_EVERY_HOURS, Math.max(MIN_EVERY_HOURS, n));
}

/**
 * Change it if it is due. Called on a short timer rather than a long one: an
 * interval of five hours starts again from zero every time the panel
 * restarts, so on a box that reboots often it would never come round at all.
 * A stored timestamp and a frequent look at it does not care about restarts.
 */
async function rotateIfDue() {
  const s = settings();
  if (!s.autoRotate) return { rotated: false };
  if (!canManage().ok) return { rotated: false };
  const due = nextDue();
  if (!due || Date.now() < due) return { rotated: false };
  await rotate('auto');
  const d = db.data;
  d.logs = d.logs || [];
  d.logs.unshift({ at: Date.now(), type: 'system',
    message: `the ${s.user} password was changed automatically - the new one is on the dashboard` });
  if (d.logs.length > 500) d.logs.length = 500;
  db.saveNow();
  return { rotated: true };
}

/**
 * What the dashboard shows. `known` is the honest part: false means the panel
 * has never set this password and therefore cannot show it, which is the
 * normal state of a server nobody has done this on yet.
 */
function status() {
  const s = settings();
  const can = canManage();
  const due = nextDue();
  return {
    user: s.user,
    manageable: can.ok,
    why: can.ok ? '' : can.why,
    known: !!s.password,
    password: s.password || '',
    setAt: Number(s.setAt) || 0,
    autoRotate: !!s.autoRotate,
    notifyBot: !!s.notifyBot,
    notifyError: s.notifyError || '',
    everyHours: hoursOf(s.everyHours),
    minHours: MIN_EVERY_HOURS,
    maxHours: MAX_EVERY_HOURS,
    nextAt: due,
    // the admin reads these on an Iranian clock, so they are written on one
    setAtText: tehranStamp(Number(s.setAt) || 0),
    nextAtText: tehranStamp(due)
  };
}

/**
 * Turn the Telegram message on or off.
 *
 * Switching it on sends the password it has right now, which is the only way
 * to find out whether it works before the admin is relying on it to get back
 * into a server they have locked themselves out of.
 */
async function setNotifyBot(on) {
  const s = settings();
  s.notifyBot = !!on;
  s.notifyError = '';
  db.saveNow();
  if (s.notifyBot && s.password) await announce('manual');
  return status();
}

/** Turn the automatic change on or off, and say how often. */
function setAutoRotate(on, everyHours) {
  const s = settings();
  s.autoRotate = !!on;
  if (everyHours !== undefined && everyHours !== null && everyHours !== '') {
    s.everyHours = hoursOf(everyHours);
  }
  if (s.autoRotate && !s.setAt) s.setAt = Date.now();
  db.saveNow();
  return status();
}

module.exports = {
  settings, generate, canManage, setPassword, rotate, rotateIfDue,
  setAutoRotate, setNotifyBot, announce, status, nextDue, tehranStamp, hoursOf,
  MIN_LENGTH, DEFAULT_EVERY_HOURS, MIN_EVERY_HOURS, MAX_EVERY_HOURS
};
