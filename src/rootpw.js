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
  return { user: who, at: s.setAt };
}

/** Set it to something nobody has ever seen, including whoever asked. */
async function rotate() {
  const s = settings();
  const next = generate(DEFAULT_LENGTH);
  await apply(s.user || 'root', next);
  s.password = next;
  s.setAt = Date.now();
  db.saveNow();
  return { user: s.user, at: s.setAt };
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
  await rotate();
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
    everyHours: hoursOf(s.everyHours),
    minHours: MIN_EVERY_HOURS,
    maxHours: MAX_EVERY_HOURS,
    nextAt: due,
    // the admin reads these on an Iranian clock, so they are written on one
    setAtText: tehranStamp(Number(s.setAt) || 0),
    nextAtText: tehranStamp(due)
  };
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
  setAutoRotate, status, nextDue, tehranStamp, hoursOf,
  MIN_LENGTH, DEFAULT_EVERY_HOURS, MIN_EVERY_HOURS, MAX_EVERY_HOURS
};
