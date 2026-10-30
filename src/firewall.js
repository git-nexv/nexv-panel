'use strict';
/**
 * The host's firewall, as far as the panel needs to touch it.
 *
 * Until now only the terminal menu could open a port, which meant the panel
 * could hand somebody an inbound on port 8443, write it into the Xray config,
 * report it as Enabled - and the firewall would drop every packet that came
 * for it. Nothing said so. The admin saw a working inbound and a client that
 * would not connect.
 *
 * So the panel opens the port itself when an inbound starts listening on it,
 * and can be told to open or close one by hand. Everything here is best
 * effort: a server with no firewall running is the common case on a fresh VPS,
 * and on one of those every call here is a no-op that reports itself as such
 * rather than an error.
 */
const { execFile } = require('child_process');
const fs = require('fs');

const TIMEOUT = 8000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: TIMEOUT }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : '' });
    });
  });
}

function hasSystemd() {
  return fs.existsSync(process.env.NEXV_SYSTEMD_DIR || '/run/systemd/system');
}

/*
 * Which firewall is actually running, cached briefly. "Installed" is not the
 * question - ufw present but inactive blocks nothing, and adding rules to it
 * would be a lie told to whoever reads them later.
 */
let kindCache = { at: 0, value: null };
const KIND_TTL = 30000;

async function kind() {
  if (process.env.NEXV_FIREWALL) return process.env.NEXV_FIREWALL;
  if (kindCache.value && Date.now() - kindCache.at < KIND_TTL) return kindCache.value;

  let found = 'none';
  const ufw = await run('ufw', ['status']);
  if (ufw.ok && /Status:\s*active/i.test(ufw.stdout)) found = 'ufw';
  else if (hasSystemd()) {
    const active = await run('systemctl', ['is-active', '--quiet', 'firewalld']);
    if (active.ok) found = 'firewalld';
  }
  kindCache = { at: Date.now(), value: found };
  return found;
}

/**
 * Which firewall is INSTALLED, running or not.
 *
 * The rule commands used to ask `kind()`, which answers only about a firewall
 * that is up. On a box where ufw is installed and switched off - every fresh
 * Ubuntu server - that meant opening a port from the panel did nothing and
 * reported success as "skipped", and the open-ports list came back empty, so
 * a port the admin had just opened was not in it. ufw keeps its rules whether
 * it is up or down, and a rule added while it is down is in force the moment
 * it is enabled, which is the whole point of adding it. So rules go to the
 * tool, and `kind()` is left to answer the different question of what is
 * being enforced right now.
 */
let toolCache = { at: 0, value: null };

async function tool() {
  if (process.env.NEXV_FIREWALL_TOOL) return process.env.NEXV_FIREWALL_TOOL;
  if (process.env.NEXV_FIREWALL) return process.env.NEXV_FIREWALL;
  if (toolCache.value && Date.now() - toolCache.at < KIND_TTL) return toolCache.value;

  let found = 'none';
  // `ufw status` needs root; `--version` answers for anybody and only says
  // whether the thing is on the box, which is what is being asked
  const ufw = await run('ufw', ['--version']);
  if (ufw.ok || /ufw/i.test(ufw.stdout)) found = 'ufw';
  else {
    const fwd = await run('firewall-cmd', ['--version']);
    if (fwd.ok) found = 'firewalld';
  }
  toolCache = { at: Date.now(), value: found };
  return found;
}

/** Is the installed firewall actually filtering anything? */
async function isActive() { return (await kind()) !== 'none'; }

/** Forget what we think is running - after installing or enabling one. */
function forget() {
  kindCache = { at: 0, value: null };
  toolCache = { at: 0, value: null };
}

function portOf(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : 0;
}

/**
 * Every rule currently in force, as port -> the protocols it covers.
 *
 * The protocol is not a detail to drop here. A wireguard inbound is opened on
 * udp only, and reading the list for tcp alone made the page report that same
 * port as still shut however many times it was opened - a warning that could
 * never be cleared, about a port that was fine.
 */
async function openRules() {
  const which = await kind();
  const rules = new Map();
  const add = (port, proto) => {
    if (!rules.has(port)) rules.set(port, new Set());
    const set = rules.get(port);
    if (proto) set.add(proto);
    else { set.add('tcp'); set.add('udp'); }   // ufw writes a bare port for both
  };

  if (which === 'ufw') {
    const res = await run('ufw', ['status']);
    for (const line of res.stdout.split('\n')) {
      // "8443/tcp  ALLOW  Anywhere", "51820/udp  ALLOW  Anywhere", "8443  ALLOW  Anywhere"
      const m = /^\s*(\d{1,5})(?:\/(tcp|udp))?\s+ALLOW/i.exec(line);
      if (m) add(Number(m[1]), m[2] ? m[2].toLowerCase() : '');
    }
  } else if (which === 'none' && (await tool()) === 'ufw') {
    /* switched off, so `ufw status` prints one line and no rules at all. The
       rules are still there and are what the admin is being shown, so they are
       read from where they are kept - `ufw show added` prints them as the
       commands that made them. */
    const res = await run('ufw', ['show', 'added']);
    for (const line of res.stdout.split('\n')) {
      const m = /^\s*ufw\s+allow\s+(?:.*\s)?(\d{1,5})(?:\/(tcp|udp))?\s*$/i.exec(line);
      if (m) add(Number(m[1]), m[2] ? m[2].toLowerCase() : '');
    }
  } else if (which === 'none' && (await tool()) === 'firewalld') {
    const res = await run('firewall-cmd', ['--permanent', '--list-ports']);
    for (const entry of res.stdout.trim().split(/\s+/)) {
      const m = /^(\d{1,5})\/(tcp|udp)$/.exec(entry);
      if (m) add(Number(m[1]), m[2]);
    }
  } else if (which === 'firewalld') {
    const res = await run('firewall-cmd', ['--list-ports']);
    for (const entry of res.stdout.trim().split(/\s+/)) {
      const m = /^(\d{1,5})\/(tcp|udp)$/.exec(entry);
      if (m) add(Number(m[1]), m[2]);
    }
  }
  return rules;
}

/** Just the port numbers, for a list somebody reads. */
async function openPorts() {
  return [...(await openRules()).keys()].sort((a, b) => a - b);
}

/** Is this port open for everything it needs to be? */
function covers(rules, port, proto) {
  const set = rules.get(port);
  if (!set) return false;
  if (proto === 'both') return set.has('tcp') && set.has('udp');
  return set.has(proto || 'tcp');
}

/**
 * Open one port. Returns what happened rather than throwing: a firewall that
 * is not running is not a failure, and the caller usually wants to carry on.
 */
async function allow(value, proto) {
  const port = portOf(value);
  if (!port) return { ok: false, reason: 'that is not a port number' };
  const which = await tool();
  if (which === 'none') return { ok: true, skipped: true, reason: 'no firewall is installed' };
  const enforced = await isActive();

  const kinds = proto === 'udp' ? ['udp'] : proto === 'both' ? ['tcp', 'udp'] : ['tcp'];
  for (const p of kinds) {
    const res = which === 'ufw'
      ? await run('ufw', ['allow', `${port}/${p}`])
      : await run('firewall-cmd', ['--permanent', `--add-port=${port}/${p}`]);
    if (!res.ok) return { ok: false, reason: (res.stderr || res.error || 'the firewall refused').trim().slice(0, 200) };
  }
  if (which === 'firewalld') await run('firewall-cmd', ['--reload']);
  return { ok: true, firewall: which, port, enforced };
}

/** Close one port, by the same rules. */
async function deny(value, proto) {
  const port = portOf(value);
  if (!port) return { ok: false, reason: 'that is not a port number' };
  const which = await tool();
  if (which === 'none') return { ok: true, skipped: true, reason: 'no firewall is installed' };
  const enforced = await isActive();

  /* a port opened as a bare `ufw allow 443` - which is how ufw's own examples
     do it - is not removed by deleting 443/tcp, and went on showing in the
     list after being closed. Every spelling of the rule goes. */
  const kinds = proto === 'udp' ? ['udp'] : proto === 'both' ? ['tcp', 'udp'] : ['tcp'];
  if (which === 'ufw') kinds.push('');
  for (const p of kinds) {
    const res = which === 'ufw'
      ? await run('ufw', ['delete', 'allow', p ? `${port}/${p}` : String(port)])
      : await run('firewall-cmd', ['--permanent', `--remove-port=${port}/${p}`]);
    /* a rule that was not there is not a failure - and ufw says so on
       stdout, not stderr, which is why closing a port that had been opened
       the bare way failed here instead of going on to delete the bare rule */
    if (!res.ok && !/could not delete|no.*match|NOT_ENABLED/i.test(res.stdout + res.stderr + res.error)) {
      return { ok: false, reason: (res.stderr || res.error || 'the firewall refused').trim().slice(0, 200) };
    }
  }
  if (which === 'firewalld') await run('firewall-cmd', ['--reload']);
  return { ok: true, firewall: which, port, enforced };
}

/**
 * Which transport an inbound actually needs open.
 *
 * wireguard is udp and nothing else; mkcp and quic ride on udp too, and hysteria
 * likewise. Everything else - tcp, ws, grpc, httpupgrade, xhttp - is tcp.
 */
function protoOf(inb) {
  if (inb.protocol === 'wireguard' || inb.protocol === 'hysteria2') return 'udp';
  const net = String(inb.network || '').toLowerCase();
  if (net === 'kcp' || net === 'mkcp' || net === 'quic') return 'udp';
  return 'tcp';
}

/**
 * Make sure every port the panel needs is open: its own, the subscription
 * port, and one for each inbound that is switched on. Called whenever an
 * inbound changes, so a port never silently stays shut.
 *
 * `udp` matters: a wireguard or a QUIC inbound is useless over tcp alone.
 */
async function sync(db) {
  /* the installed one, not the running one: rules saved into a switched-off
     ufw are what makes enabling it safe later */
  const which = await tool();
  if (which === 'none') return { ok: true, skipped: true, opened: [], reason: 'no firewall is installed' };

  const d = db.data;
  const wanted = new Map();          // port -> 'tcp' | 'udp' | 'both'
  const want = (value, proto) => {
    const port = portOf(value);
    if (!port) return;
    const had = wanted.get(port);
    wanted.set(port, !had || had === proto ? proto : 'both');
  };

  want(d.settings.panelPort || 2087, 'tcp');
  // NEXV_PORT overrides the stored setting at run time; that is the port the
  // panel is actually answering on right now, so it is the one to open
  want(process.env.NEXV_PORT, 'tcp');
  want(d.settings.subPort, 'tcp');
  if (d.settings.domain) { want(80, 'tcp'); want(443, 'tcp'); }
  for (const inb of (d.inbounds || [])) {
    if (inb.enable === false) continue;
    want(inb.port, protoOf(inb));
  }

  /*
   * `ufw allow` on a port that is already allowed is harmless, but it is also
   * a process spawn each time, and sync runs on every inbound change. So the
   * ports already known open are skipped - except where udp is wanted, since
   * the listing only tells us about tcp.
   */
  const already = await openRules();
  const opened = [];
  const failed = [];
  for (const [port, proto] of wanted) {
    if (covers(already, port, proto)) continue;
    const res = await allow(port, proto);
    if (res.ok && !res.skipped) opened.push(port);
    else if (!res.ok) failed.push({ port, reason: res.reason });
  }
  return { ok: !failed.length, firewall: which, opened, failed };
}

/** What the panel can tell the admin about the firewall right now. */
async function status(db) {
  const which = await kind();
  const installed = await tool();
  /* read the rules even when nothing is enforcing them: they are what the
     admin opened and the list that used to come back empty here is what made
     a port they had just opened look like it had not been */
  const rules = installed === 'none' ? new Map() : await openRules();
  const needed = [];
  const d = db.data;
  /* `kind` says what the port is for, so a reader can tell which program
     ought to be holding it: the panel is node, an inbound is Xray, and the
     certificate ports are whatever is answering http at the time */
  const add = (p, what, proto, who) => {
    const n = portOf(p);
    if (n) needed.push({ port: n, what, proto: proto || 'tcp', kind: who });
  };
  add(d.settings.panelPort || 2087, 'the panel', 'tcp', 'panel');
  add(d.settings.subPort, 'subscriptions', 'tcp', 'panel');
  if (d.settings.domain) {
    add(80, 'certificates', 'tcp', 'cert');
    add(443, 'certificates', 'tcp', 'cert');
  }
  for (const inb of (d.inbounds || [])) {
    if (inb.enable === false) continue;
    add(inb.port, inb.remark || inb.protocol, protoOf(inb), 'inbound');
  }
  return {
    firewall: which,
    installed,
    running: which !== 'none',
    /* installed but switched off: the rules are saved and will apply the
       moment it is enabled, and nothing is being blocked in the meantime */
    savedOnly: which === 'none' && installed !== 'none',
    open: [...rules.keys()].sort((a, b) => a - b),
    needed,
    shut: which === 'none' ? [] : needed.filter((n) => !covers(rules, n.port, n.proto))
  };
}

/**
 * Switch the firewall on without locking anybody out.
 *
 * Enabling ufw with no rules in it drops ssh and the panel's own port, and the
 * admin finds out by losing the session they were doing it from. So everything
 * the panel needs is opened first, ssh with it, and only then is it enabled -
 * and enabled for the next boot too, because a firewall that is gone after a
 * reboot is not one.
 */
async function enable(db) {
  const which = await tool();
  if (which !== 'ufw') {
    return { ok: false, reason: which === 'none' ? 'ufw is not installed on this server' : `${which} is not switched on from here` };
  }

  // ssh first, and before anything that could fail
  await run('ufw', ['allow', '22/tcp']);
  const opened = await sync(db);
  const on = await run('ufw', ['--force', 'enable']);
  if (!on.ok) return { ok: false, reason: (on.stderr || on.stdout || on.error || 'ufw refused to start').trim().slice(0, 200) };
  if (hasSystemd()) await run('systemctl', ['enable', 'ufw']);
  forget();
  if (!(await isActive())) return { ok: false, reason: 'ufw says it is enabled but is not filtering' };
  return { ok: true, firewall: 'ufw', opened: opened.opened || [] };
}

/**
 * What is actually holding a port, by name.
 *
 * A rule list says what is allowed through; it says nothing about what is
 * sitting on the port already. "443 is in use and I do not know by what" is
 * not a firewall question at all, and the firewall page is where people go
 * looking for it, so it is answered here.
 *
 * Read out of /proc rather than by running ss or netstat, because neither is
 * on a minimal Ubuntu image and a panel that answers only when an optional
 * package happens to be installed is a panel that answers sometimes.
 */
function listening() {
  const socks = [];
  const parse = (file) => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    for (const line of text.split('\n').slice(1)) {
      const bits = line.trim().split(/\s+/);
      if (bits.length < 10) continue;
      if (bits[3] !== '0A') continue;                 // 0A is LISTEN
      const port = parseInt((bits[1].split(':')[1] || ''), 16);
      if (port) socks.push({ port, inode: bits[9] });
    }
  };
  parse('/proc/net/tcp');
  parse('/proc/net/tcp6');
  if (!socks.length) return [];

  /* which process holds which socket: every open file descriptor that is a
     socket points at an inode, and that is the only link between the two */
  const byInode = new Map();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (_) { return []; }
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch (_) { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && !byInode.has(m[1])) byInode.set(m[1], pid);
    }
  }

  const seen = new Map();
  for (const s of socks) {
    const pid = byInode.get(s.inode) || '';
    let cmd = '';
    let name = '';
    if (pid) {
      try {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch (_) { /* it exited while we were looking */ }
      try {
        name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      } catch (_) { /* same */ }
    }
    const was = seen.get(s.port);
    // prefer the entry we could actually name
    if (!was || (!was.pid && pid)) seen.set(s.port, { port: s.port, pid, name, cmd: cmd.slice(0, 300) });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

/** Whichever process holds this port, or null when nothing does. */
function whoHas(port) {
  const n = portOf(port);
  if (!n) return null;
  return listening().find((l) => l.port === n) || null;
}

module.exports = {
  kind, tool, isActive, forget, allow, deny, enable, openPorts, openRules, sync, status, protoOf,
  listening, whoHas
};
