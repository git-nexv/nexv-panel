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
 */
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const db = require('./db');
const totp = require('./totp');

/* No l/I/1 or O/0: this gets read off a phone screen and typed into a
   terminal, and a password nobody can transcribe is a lockout. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const ZONE = 'Asia/Tehran';
/* Iran stopped putting its clocks forward in 2022, so +03:30 is right all
   year. Only used if this Node was built without the timezone data. */
const FALLBACK_OFFSET_MINUTES = 210;
const DEFAULT_LENGTH = 20;
const MIN_LENGTH = 8;
/* what the admin asked for; kept as a number so it can be changed later
   without the stored settings meaning something different */
const DEFAULT_EVERY_HOURS = 5;

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
  /* 'random' is twenty unguessable characters; 'clock' is the Tehran time it
     was set at; 'totp' is the authenticator code for the current window,
     which the admin reads off their phone without opening the panel */
  if (!['clock', 'random', 'totp'].includes(s.style)) s.style = 'random';
  if (typeof s.secret !== 'string') s.secret = '';
  if (typeof s.totpSecret !== 'string') s.totpSecret = '';
  if (!(Number(s.totpDigits) >= 6)) s.totpDigits = 8;
  return s;
}

/** The window length the authenticator is set up for, in seconds. */
function totpPeriod() {
  const s = settings();
  return Math.max(1, Number(s.everyHours) || DEFAULT_EVERY_HOURS) * 3600;
}

/**
 * The code that is the password for the window holding this moment.
 *
 * Eight digits rather than six: this one stands for hours rather than thirty
 * seconds, so a hundred million beats a million by the only margin that
 * matters against somebody knocking on the SSH port.
 */
function totpPassword(at) {
  const s = settings();
  if (!s.totpSecret) return '';
  return totp.code(s.totpSecret, {
    at: at || Date.now(), period: totpPeriod(), digits: Number(s.totpDigits) || 8
  });
}

/** The hour and minute in Tehran, whatever this server's own clock is set to. */
function tehranClock(at) {
  const when = new Date(at || Date.now());
  try {
    const text = new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE, hour: 'numeric', minute: '2-digit', hourCycle: 'h23'
    }).format(when);
    const [h, m] = text.split(':');
    return { hour: Number(h), minute: m };
  } catch (_) {
    // a Node without timezone data: do the arithmetic by hand
    const shifted = new Date(when.getTime() + FALLBACK_OFFSET_MINUTES * 60000);
    return { hour: shifted.getUTCHours(), minute: String(shifted.getUTCMinutes()).padStart(2, '0') };
  }
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
 * The clock as a password: the Tehran time it was set at, written the way a
 * watch shows it - 20/30, 2/38 - with no leading zero on the hour.
 *
 * This is worth being blunt about, because it is not a password in the sense
 * the rest of this file means. There are 1440 of them, the format is obvious
 * once anybody sees one, and the answer is written on every clock in the
 * country: somebody who knows the scheme does not have to guess at all. On a
 * server with a public address and password logins open, that is not a long
 * wait - it is the first thing an automated scan tries.
 *
 * The secret word is what makes it a password again. It sits in front of the
 * time and never changes, so the admin still works the whole thing out from
 * their own watch, while somebody who does not know the word gets nothing
 * from knowing the time. Empty, this is exactly what was asked for, and the
 * panel says plainly what that costs.
 */
function clockPassword(at) {
  const s = settings();
  const { hour, minute } = tehranClock(at);
  return `${s.secret || ''}${hour}/${minute}`;
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
  s.rotatedAt = 0;
  db.saveNow();
  return { user: who, at: s.setAt };
}

/**
 * Set it to the next one, whichever way the admin asked for.
 *
 * The length floor that setPassword enforces is not applied here: a clock
 * password is five characters by design and the admin chose that knowingly.
 */
async function rotate() {
  const s = settings();
  let next;
  if (s.style === 'clock') next = clockPassword(Date.now());
  else if (s.style === 'totp') next = totpPassword(Date.now()) || generate(DEFAULT_LENGTH);
  else next = generate(DEFAULT_LENGTH);
  await apply(s.user || 'root', next);
  s.password = next;
  s.setAt = Date.now();
  s.rotatedAt = s.setAt;
  db.saveNow();
  return { user: s.user, at: s.setAt };
}

/** When the next automatic change falls due, or 0 when none does. */
function nextDue() {
  const s = settings();
  if (!s.autoRotate) return 0;
  /*
   * An authenticator's windows are counted from the Unix epoch, not from
   * whenever this server last changed anything - so the change has to land on
   * the window edge. Counting five hours from the last change instead would
   * drift the server out of step with the phone, and the code on screen would
   * stop being the password for minutes or hours at a time.
   */
  if (s.style === 'totp' && s.totpSecret) return totp.windowEnd(Date.now(), totpPeriod());
  const every = Math.max(1, Number(s.everyHours) || DEFAULT_EVERY_HOURS) * 3600000;
  /* counted from the last change of any kind, so setting one by hand puts the
     clock back to the start rather than being overwritten minutes later */
  const since = Number(s.setAt) || 0;
  return since ? since + every : Date.now();
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
  const now = Date.now();
  /*
   * The stored password belongs to the window it was set in. If the panel was
   * stopped across a window edge, waiting for the next one would leave the
   * phone showing a code the server has never heard of for hours. So the
   * window it was set in, not the clock, decides whether it is stale.
   */
  if (s.style === 'totp' && s.totpSecret) {
    const period = totpPeriod();
    if (totp.windowOf(Number(s.setAt) || 0, period) === totp.windowOf(now, period)) {
      return { rotated: false };
    }
    await rotate();
    return { rotated: true };
  }
  const due = nextDue();
  if (!due || now < due) return { rotated: false };
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
    everyHours: Number(s.everyHours) || DEFAULT_EVERY_HOURS,
    nextAt: due,
    style: s.style,
    secret: s.secret || '',
    /* the authenticator side: the secret to scan, what to scan it with, and
       the code that is the password right now */
    totp: {
      ready: !!s.totpSecret,
      secret: s.totpSecret || '',
      digits: Number(s.totpDigits) || 8,
      periodHours: Math.max(1, Number(s.everyHours) || DEFAULT_EVERY_HOURS),
      uri: s.totpSecret ? totp.uri(s.totpSecret, {
        label: `${s.user}@${require('os').hostname()}`,
        issuer: 'NexV Panel',
        digits: Number(s.totpDigits) || 8,
        period: totpPeriod()
      }) : '',
      now: totpPassword(Date.now()),
      windowEndsAt: s.totpSecret ? totp.windowEnd(Date.now(), totpPeriod()) : 0
    },
    /* what the next clock password would look like, so the choice can be
       shown rather than described */
    sample: clockPassword(Date.now()),
    /* a clock password with no secret word in front of it is public: the
       panel shows this as a warning rather than leaving it to be discovered */
    weak: s.style === 'clock' && !s.secret,
    // the admin reads these on an Iranian clock, so they are written on one
    setAtText: tehranStamp(Number(s.setAt) || 0),
    nextAtText: tehranStamp(due)
  };
}

/** Turn the automatic change on or off. On, it starts counting from now. */
function setAutoRotate(on, everyHours) {
  const s = settings();
  s.autoRotate = !!on;
  if (Number(everyHours) > 0) s.everyHours = Math.min(24 * 30, Math.round(Number(everyHours)));
  if (s.autoRotate && !s.setAt) s.setAt = Date.now();
  db.saveNow();
  return status();
}

/** Which kind of password the automatic change makes, and the secret word. */
function setStyle(style, secret) {
  const s = settings();
  if (['clock', 'random', 'totp'].includes(style)) s.style = style;
  // the authenticator needs something to be set up with, the moment it is picked
  if (s.style === 'totp' && !s.totpSecret) s.totpSecret = totp.secret(20);
  if (secret !== undefined && secret !== null) {
    /* no colon or whitespace, for the same reason a typed password may not
       have one: chpasswd reads a colon as the end of the user name */
    s.secret = String(secret).replace(/[\s:]/g, '').slice(0, 32);
  }
  db.saveNow();
  return status();
}

module.exports = {
  settings, generate, canManage, setPassword, rotate, rotateIfDue,
  setAutoRotate, setStyle, status, nextDue, clockPassword, totpPassword, totpPeriod, tehranClock, tehranStamp,
  MIN_LENGTH, DEFAULT_EVERY_HOURS
};
