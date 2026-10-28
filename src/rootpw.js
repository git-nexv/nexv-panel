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

/* No l/I/1 or O/0: this gets read off a phone screen and typed into a
   terminal, and a password nobody can transcribe is a lockout. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
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
  return s;
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

/** Set it to something nobody has ever seen, including whoever asked. */
async function rotate() {
  const s = settings();
  const next = generate(DEFAULT_LENGTH);
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
  return {
    user: s.user,
    manageable: can.ok,
    why: can.ok ? '' : can.why,
    known: !!s.password,
    password: s.password || '',
    setAt: Number(s.setAt) || 0,
    autoRotate: !!s.autoRotate,
    everyHours: Number(s.everyHours) || DEFAULT_EVERY_HOURS,
    nextAt: nextDue()
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

module.exports = {
  settings, generate, canManage, setPassword, rotate, rotateIfDue,
  setAutoRotate, status, nextDue, MIN_LENGTH, DEFAULT_EVERY_HOURS
};
