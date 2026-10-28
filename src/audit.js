'use strict';
/**
 * Has somebody been in this server.
 *
 * This reports and never removes, and that is a decision rather than caution.
 * On a box you suspect, the files are the evidence: what was added, when, and
 * by what. Deleting a backdoor the moment it is seen destroys the only record
 * of how it got in, usually leaves the way in open, and on a false positive
 * takes a working system with it. So every check here reads, and the admin
 * decides.
 *
 * The checks are the ones that actually catch people, in roughly the order an
 * intruder reaches for them: a second account that is really root, a key
 * added to authorized_keys, a cron line, a systemd unit, a changed system
 * binary, something listening that should not be. The one that answers "is
 * there something planted in the OS itself" is dpkg --verify, which compares
 * every packaged file on disk against the checksum the distribution shipped -
 * the same question, asked of the package manager that already knows.
 *
 * Nothing here is a guarantee. A good enough intruder edits the package
 * database too, and the only answer to a server you genuinely cannot trust is
 * a new server with the data moved across by hand. That is said plainly in
 * the panel rather than implied by a green tick.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SEV = { high: 'high', medium: 'medium', low: 'low', info: 'info' };

/*
 * Everything file-based is read through here. In production it is empty and
 * these are the real paths; pointed at a directory it reads that instead,
 * which is how the checks are tested against a filesystem that looks broken
 * into without breaking into anything.
 */
const ROOT = process.env.NEXV_AUDIT_ROOT || '';
const at = (p) => (ROOT ? path.join(ROOT, p) : p);

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeout || 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        ok: !err, out: String(stdout || ''), err: String(stderr || ''),
        timedOut: !!(err && err.killed)
      }));
  });
}

function readText(file, cap) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return cap ? text.slice(0, cap) : text;
  } catch (_) { return ''; }
}

function stamp(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}

/* ------------------------- accounts that are root ------------------------ */

/**
 * Anybody who is root without being called root.
 *
 * Adding a second uid-0 line to /etc/passwd is the oldest backdoor there is,
 * and it survives a password change on the real root account.
 */
function rootAccounts() {
  const items = [];
  for (const line of readText(at('/etc/passwd')).split('\n')) {
    const bits = line.split(':');
    if (bits.length < 7) continue;
    if (Number(bits[2]) !== 0) continue;
    if (bits[0] === 'root') continue;
    items.push({ what: bits[0], detail: line.trim() });
  }
  return {
    id: 'root-accounts',
    title: 'Accounts with root powers',
    severity: items.length ? SEV.high : SEV.info,
    clean: !items.length,
    summary: items.length
      ? `${items.length} account(s) besides root have user id 0 - they are root under another name`
      : 'Only root has user id 0',
    items
  };
}

/* ---------------------------- ways in over SSH --------------------------- */

function homeDirs() {
  const homes = [{ user: 'root', dir: at('/root') }];
  for (const line of readText(at('/etc/passwd')).split('\n')) {
    const bits = line.split(':');
    if (bits.length < 7) continue;
    const dir = bits[5];
    if (!dir || dir === '/root' || !dir.startsWith('/home/')) continue;
    homes.push({ user: bits[0], dir: at(dir) });
  }
  return homes;
}

/** Every key that can log in without a password, and when it was put there. */
function sshKeys() {
  const items = [];
  for (const { user, dir } of homeDirs()) {
    const file = path.join(dir, '.ssh', 'authorized_keys');
    const text = readText(file, 40000);
    if (!text.trim()) continue;
    const when = stamp(file);
    for (const line of text.split('\n')) {
      const key = line.trim();
      if (!key || key.startsWith('#')) continue;
      const bits = key.split(/\s+/);
      items.push({
        what: `${user}: ${bits[bits.length - 1] || 'no comment'}`,
        // the key type and the comment, never the key material itself
        detail: `${bits[0] || ''} … ${file} (changed ${new Date(when).toISOString().slice(0, 16).replace('T', ' ')})`
      });
    }
  }
  return {
    id: 'ssh-keys',
    title: 'Keys that can log in without a password',
    severity: items.length ? SEV.medium : SEV.info,
    clean: !items.length,
    summary: items.length
      ? `${items.length} SSH key(s) can log in. Every one you do not recognise is a way in that a password change does not close.`
      : 'No SSH keys are authorised anywhere',
    items
  };
}

/* ------------------------------ things that run -------------------------- */

const CRON_PLACES = ['/etc/crontab', '/etc/cron.d', '/var/spool/cron/crontabs', '/etc/cron.hourly',
  '/etc/cron.daily', '/etc/cron.weekly', '/etc/cron.monthly'];

/** Anything scheduled to run, which is how a backdoor comes back. */
function cronJobs() {
  const items = [];
  const add = (file) => {
    const text = readText(file, 20000);
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (/^[A-Z_]+=/.test(t)) continue;
      items.push({ what: file, detail: t.slice(0, 300) });
    }
  };
  for (const raw of CRON_PLACES) {
    const place = at(raw);
    let st;
    try { st = fs.statSync(place); } catch (_) { continue; }
    if (st.isFile()) { add(place); continue; }
    let names = [];
    try { names = fs.readdirSync(place); } catch (_) { continue; }
    for (const name of names) {
      const full = path.join(place, name);
      try { if (!fs.statSync(full).isFile()) continue; } catch (_) { continue; }
      // the run-parts directories hold scripts, not crontab lines
      if (raw.startsWith('/etc/cron.') && !raw.endsWith('cron.d')) {
        items.push({ what: place, detail: name });
        continue;
      }
      add(full);
    }
  }
  return {
    id: 'cron',
    title: 'Scheduled jobs',
    severity: SEV.low,
    clean: false,
    summary: `${items.length} scheduled job(s). Read them: a line fetching and running something from the internet is how a backdoor reinstalls itself.`,
    items
  };
}

/** Services nobody's package installed, which is the tidy way to persist. */
async function strayUnits() {
  const items = [];
  const dir = '/etc/systemd/system';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  for (const name of names) {
    if (!name.endsWith('.service')) continue;
    const full = path.join(dir, name);
    const owner = await run('dpkg', ['-S', full], 8000);
    if (owner.ok) continue;                 // a package put it there
    if (/^(nexv|xray)\.service$/.test(name)) continue;   // ours, and expected
    const text = readText(full, 4000);
    const exec = (/ExecStart=(.*)/.exec(text) || [])[1] || '';
    items.push({ what: name, detail: exec.trim().slice(0, 300) || full });
  }
  return {
    id: 'units',
    title: 'Services no package installed',
    severity: items.length ? SEV.medium : SEV.info,
    clean: !items.length,
    summary: items.length
      ? `${items.length} service(s) were put here by hand rather than by a package. Yours will be among them - anything that is not is worth reading.`
      : 'Every service here came from a package',
    items
  };
}

/* --------------------------- the OS files themselves --------------------- */

/**
 * Every packaged file on disk, against the checksum its package shipped.
 *
 * This is the check that answers "is there something planted in Linux
 * itself": a replaced sshd, a patched ls that hides a directory, a wrapper
 * around sudo. dpkg already holds the checksums, so nothing has to be
 * downloaded or trusted from elsewhere.
 *
 * It walks the whole disk, so it is given room and is allowed to come back
 * unfinished rather than hold the page for ever - an answer that says it ran
 * out of time is worth more than no answer.
 */
async function osFiles(budgetMs) {
  const res = await run('dpkg', ['--verify'], budgetMs || 180000);
  if (!res.ok && !res.out.trim()) {
    return {
      id: 'os-files',
      title: 'Ubuntu’s own files',
      severity: SEV.info,
      clean: false,
      summary: res.timedOut
        ? 'The check ran out of time before it finished. Run it again when the server is quieter.'
        : `Could not check: ${(res.err.split('\n')[0] || 'dpkg said nothing').slice(0, 200)}`,
      items: []
    };
  }
  const items = [];
  for (const line of res.out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    /* dpkg prints ??5?????? /path - the 5 is the checksum column, which is
       the one that means the contents are not what was shipped. Config files
       are marked 'c' and are expected to differ, so they are not alarming. */
    const m = /^(\S+)\s+(?:(c)\s+)?(\/.*)$/.exec(t);
    if (!m) continue;
    const flags = m[1];
    const isConfig = m[2] === 'c';
    if (flags[2] !== '5') continue;          // only contents, not times or modes
    items.push({
      what: m[3],
      detail: isConfig
        ? 'a configuration file, so a difference here is usually your own edit'
        : 'the contents are not what Ubuntu shipped'
    });
  }
  const serious = items.filter((i) => !/configuration file/.test(i.detail));
  return {
    id: 'os-files',
    title: 'Ubuntu’s own files',
    severity: serious.length ? SEV.high : SEV.info,
    clean: !serious.length,
    summary: serious.length
      ? `${serious.length} system file(s) do not match what Ubuntu shipped. A replaced system binary is the strongest sign on this page.`
      : `Every packaged file matches what Ubuntu shipped${items.length ? ` (${items.length} edited config file(s), which is normal)` : ''}`,
    items: serious.length ? serious : items
  };
}

/* ------------------------------ what is listening ------------------------ */

function listeningPorts() {
  const out = [];
  const parse = (file, v6) => {
    for (const line of readText(file).split('\n').slice(1)) {
      const bits = line.trim().split(/\s+/);
      if (bits.length < 10) continue;
      if (bits[3] !== '0A') continue;              // LISTEN
      const [addr, portHex] = bits[1].split(':');
      const port = parseInt(portHex, 16);
      if (!port) continue;
      out.push({ port, inode: bits[9], v6, addr });
    }
  };
  parse('/proc/net/tcp', false);
  parse('/proc/net/tcp6', true);

  // match each listening socket back to the program holding it
  const byInode = new Map();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (_) { /* not linux */ }
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch (_) { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m) byInode.set(m[1], pid);
    }
  }

  const seen = new Map();
  for (const sock of out) {
    const pid = byInode.get(sock.inode);
    const cmd = pid ? readText(`/proc/${pid}/cmdline`, 300).replace(/\0/g, ' ').trim() : '';
    const key = `${sock.port}:${cmd}`;
    if (seen.has(key)) continue;
    seen.set(key, { port: sock.port, pid: pid || '', cmd });
  }
  const items = [...seen.values()]
    .sort((a, b) => a.port - b.port)
    .map((s) => ({ what: `port ${s.port}`, detail: s.cmd || `pid ${s.pid || 'unknown'}` }));
  return {
    id: 'listening',
    title: 'What is listening for connections',
    severity: SEV.low,
    clean: false,
    summary: `${items.length} port(s) open to connections. Your panel, Xray and sshd belong here - anything else is worth knowing about.`,
    items
  };
}

/* ------------------------------ the whole thing -------------------------- */

/**
 * Run the lot. `deep` turns on the dpkg pass, which is the slow one, so an
 * ordinary look at the page does not spend three minutes walking the disk.
 */
async function scan(options) {
  const opts = options || {};
  const started = Date.now();
  const checks = [rootAccounts(), sshKeys(), cronJobs(), listeningPorts()];
  const units = await strayUnits();
  if (units) checks.push(units);
  if (opts.deep) checks.push(await osFiles(opts.budgetMs));
  return {
    at: Date.now(),
    tookMs: Date.now() - started,
    deep: !!opts.deep,
    checks: checks.filter(Boolean)
  };
}

/*
 * The deep pass walks every packaged file on the disk and takes a minute or
 * more, which is far longer than a request should be held open. So it runs
 * behind the page: starting it answers at once, and the page asks for the
 * result until it is there. One at a time - a second press while it is
 * running joins the run already going rather than starting another walk.
 */
let state = { running: false, startedAt: 0, result: null, error: '' };

function start(options) {
  if (state.running) return { started: false, already: true };
  state = { running: true, startedAt: Date.now(), result: state.result, error: '' };
  scan(options)
    .then((result) => { state = { running: false, startedAt: 0, result, error: '' }; })
    .catch((err) => {
      state = { running: false, startedAt: 0, result: state.result, error: err.message };
    });
  return { started: true };
}

function last() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    error: state.error,
    result: state.result
  };
}

module.exports = {
  scan, start, last,
  rootAccounts, sshKeys, cronJobs, strayUnits, osFiles, listeningPorts, SEV
};
