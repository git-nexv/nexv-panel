'use strict';
/**
 * A flood guard in front of everything the server listens on.
 *
 * When somebody floods the server, the damage is not the bandwidth so much as
 * the connection table: tens of thousands of half-open handshakes from a few
 * addresses, until the kernel stops accepting new connections at all and every
 * real client's config goes dead with them. This sits in front of Xray, the
 * panel and the subscription port alike and refuses that traffic before any of
 * them has to look at it.
 *
 * It is one nftables table of its own, `inet nexv_guard`, hooked into input just
 * ahead of the ordinary filter. Owning a whole table is what makes this safe to
 * switch on and off: turning it off is deleting the table, which cannot touch a
 * single rule the admin or ufw wrote, and turning it on is loading the table in
 * one atomic step, so there is never a moment with half the rules in place.
 *
 * What it does, in order, to each NEW connection (established ones are never
 * judged - a client that is already connected is left alone):
 *
 *   - an address on the allowlist passes untouched
 *   - an address that is banned is dropped, and every packet it sends while
 *     banned pushes the ban out again, so an attack that keeps going stays shut
 *   - malformed and out-of-state packets are dropped
 *   - one address holding more than `maxConn` connections at once gets new ones
 *     refused with a reset, but is not banned: that is how a carrier's shared
 *     address looks, and banning it would cut off everybody behind it
 *   - one address opening connections faster than `rate` a second (after a
 *     burst of `burst`) is banned for `banMinutes` - that is a flood, not a
 *     phone
 *   - the same rate limit for new UDP flows, without the ban, because QUIC and
 *     Hysteria are UDP and legitimately busy
 *   - ping is rate limited per address
 *
 * And the kernel's own defences go up with it: SYN cookies on, a deeper SYN
 * backlog and fewer SYN-ACK retries, so a SYN flood that gets past the per-
 * address limits from a thousand addresses still cannot fill the table. The
 * values that were there before are kept and put back when it is switched off.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');

const TABLE = 'nexv_guard';
const FAMILY = 'inet';

/*
 * Three levels, because "how many connections a second is too many" is not a
 * question anybody should have to answer in the middle of an attack.
 *
 * The numbers are per address. They are generous on purpose: in Iran most
 * mobile users sit behind a carrier's shared address, so one IP can genuinely
 * be a few hundred people, and a guard that bans that address takes all of
 * them offline - which is the attacker's job, not ours.
 */
const LEVELS = {
  relaxed: { rate: 150, burst: 300, maxConn: 1500, udpRate: 400, banMinutes: 5 },
  normal: { rate: 80, burst: 160, maxConn: 600, udpRate: 250, banMinutes: 10 },
  strict: { rate: 30, burst: 60, maxConn: 200, udpRate: 120, banMinutes: 30 }
};

const SYSCTL = {
  'net.ipv4.tcp_syncookies': '1',
  'net.ipv4.tcp_max_syn_backlog': '8192',
  'net.ipv4.tcp_synack_retries': '2',
  'net.core.netdev_max_backlog': '5000'
};

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : '' });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => { /* the process may already be gone */ });
      child.stdin.end(input);
    }
  });
}

/* ------------------------------- settings -------------------------------- */

function settings() {
  const s = db.settings;
  if (!s.guard || typeof s.guard !== 'object') {
    s.guard = { enable: false, level: 'normal', allow: '', sysctlBefore: null };
  }
  return s.guard;
}

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** The numbers actually in force: the level's, with any custom ones on top. */
function limits() {
  const g = settings();
  const base = LEVELS[g.level] || LEVELS.normal;
  if (g.level !== 'custom') return Object.assign({}, base);
  const c = g.custom || {};
  return {
    rate: clampInt(c.rate, 5, 100000, LEVELS.normal.rate),
    burst: clampInt(c.burst, 5, 200000, LEVELS.normal.burst),
    maxConn: clampInt(c.maxConn, 20, 1000000, LEVELS.normal.maxConn),
    udpRate: clampInt(c.udpRate, 10, 1000000, LEVELS.normal.udpRate),
    banMinutes: clampInt(c.banMinutes, 1, 1440, LEVELS.normal.banMinutes)
  };
}

/*
 * The allowlist, split into the two families nftables keeps apart.
 *
 * Anything that is not an address or a range is dropped rather than passed
 * through: one stray word in this box would make `nft` refuse the whole table,
 * and a guard that will not load because of a typo is no guard.
 */
function allowList(extra) {
  const want = String(settings().allow || '').split(/[\s,]+/).concat(extra || []);
  const v4 = new Set();
  const v6 = new Set();
  for (const raw of want) {
    const item = String(raw || '').trim();
    if (!item) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(item)) {
      const [ip, bits] = item.split('/');
      if (ip.split('.').every((o) => Number(o) <= 255) && (bits === undefined || Number(bits) <= 32)) v4.add(item);
    } else if (/^[0-9a-f:]+(\/\d{1,3})?$/i.test(item) && item.includes(':')) {
      const bits = item.split('/')[1];
      if (bits === undefined || Number(bits) <= 128) v6.add(item.toLowerCase());
    }
  }
  return { v4: [...v4], v6: [...v6] };
}

/* ------------------------------ the ruleset ------------------------------ */

/** The whole table, as one file nft loads atomically. */
function ruleset(extraAllow) {
  const l = limits();
  const allow = allowList(extraAllow);
  const ban = `${l.banMinutes}m`;
  const set4 = allow.v4.length ? ` elements = { ${allow.v4.join(', ')} }` : '';
  const set6 = allow.v6.length ? ` elements = { ${allow.v6.join(', ')} }` : '';
  return `table ${FAMILY} ${TABLE} {
  set allow4 { type ipv4_addr; flags interval;${set4} }
  set allow6 { type ipv6_addr; flags interval;${set6} }
  set ban4 { type ipv4_addr; flags dynamic, timeout; timeout ${ban}; size 65535; }
  set ban6 { type ipv6_addr; flags dynamic, timeout; timeout ${ban}; size 65535; }

  counter banned_drop {}
  counter flood_ban {}
  counter conn_reject {}
  counter udp_drop {}
  counter bad_drop {}

  chain input {
    type filter hook input priority filter - 5; policy accept;

    iif "lo" accept
    ct state established,related accept

    ip saddr @allow4 accept
    ip6 saddr @allow6 accept

    ip saddr @ban4 update @ban4 { ip saddr } counter name "banned_drop" drop
    ip6 saddr @ban6 update @ban6 { ip6 saddr } counter name "banned_drop" drop

    ct state invalid counter name "bad_drop" drop
    tcp flags & (fin|syn|rst|ack) != syn ct state new counter name "bad_drop" drop

    tcp flags syn ct state new meter guard_conn4 { ip saddr ct count over ${l.maxConn} } counter name "conn_reject" reject with tcp reset
    tcp flags syn ct state new meter guard_conn6 { ip6 saddr ct count over ${l.maxConn} } counter name "conn_reject" reject with tcp reset

    tcp flags syn ct state new meter guard_rate4 { ip saddr limit rate over ${l.rate}/second burst ${l.burst} packets } add @ban4 { ip saddr } counter name "flood_ban" drop
    tcp flags syn ct state new meter guard_rate6 { ip6 saddr limit rate over ${l.rate}/second burst ${l.burst} packets } add @ban6 { ip6 saddr } counter name "flood_ban" drop

    meta l4proto udp ct state new meter guard_udp4 { ip saddr limit rate over ${l.udpRate}/second burst ${l.udpRate * 2} packets } counter name "udp_drop" drop
    meta l4proto udp ct state new meter guard_udp6 { ip6 saddr limit rate over ${l.udpRate}/second burst ${l.udpRate * 2} packets } counter name "udp_drop" drop

    icmp type echo-request meter guard_ping4 { ip saddr limit rate over 5/second burst 10 packets } drop
    icmpv6 type echo-request meter guard_ping6 { ip6 saddr limit rate over 5/second burst 10 packets } drop
  }
}
`;
}

/* --------------------------------- nft ----------------------------------- */

async function hasNft() {
  const out = await run('nft', ['--version']);
  return out.ok;
}

async function tableLoaded() {
  const out = await run('nft', ['list', 'table', FAMILY, TABLE]);
  return out.ok;
}

/*
 * Load the table, replacing whatever version of it is there.
 *
 * Checked with `nft -c` first, so a ruleset this kernel will not take leaves
 * the old one running rather than none at all. The delete and the load go in
 * the same file, which nft applies as one transaction.
 */
async function load(extraAllow) {
  const text = ruleset(extraAllow);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexv-guard-'));
  const file = path.join(dir, 'guard.nft');
  try {
    /*
     * The check has to be of the whole transaction - delete and reload -
     * not of the new table alone. Checked alone against a kernel that
     * already holds the table, nft sees every meter as a duplicate of the
     * one already loaded and refuses, so changing the level while the guard
     * was on always failed.
     */
    const exists = await tableLoaded();
    fs.writeFileSync(file, `${exists ? `delete table ${FAMILY} ${TABLE}\n` : ''}${text}`, { mode: 0o600 });
    const check = await run('nft', ['-c', '-f', file]);
    if (!check.ok) throw new Error(`nftables refused the rules: ${(check.stderr || check.error).trim().slice(0, 300)}`);
    const out = await run('nft', ['-f', file]);
    if (!out.ok) throw new Error(`could not load the rules: ${(out.stderr || out.error).trim().slice(0, 300)}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a temp dir */ }
  }
}

async function unload() {
  if (await tableLoaded()) await run('nft', ['delete', 'table', FAMILY, TABLE]);
}

/* -------------------------------- sysctl --------------------------------- */

function readSysctl(key) {
  try {
    return fs.readFileSync(`/proc/sys/${key.replace(/\./g, '/')}`, 'utf8').trim();
  } catch (_) { return null; }
}

function writeSysctl(key, value) {
  try {
    fs.writeFileSync(`/proc/sys/${key.replace(/\./g, '/')}`, String(value));
    return true;
  } catch (_) { return false; }
}

/* remember the values once, the first time, so switching off puts back what
   the server had rather than what the last switch-on found */
function raiseKernel() {
  const g = settings();
  if (!g.sysctlBefore) {
    g.sysctlBefore = {};
    for (const key of Object.keys(SYSCTL)) g.sysctlBefore[key] = readSysctl(key);
  }
  for (const [key, value] of Object.entries(SYSCTL)) {
    const now = readSysctl(key);
    /* never lower anything the admin already set higher */
    if (key !== 'net.ipv4.tcp_synack_retries' && now !== null && Number(now) > Number(value)) continue;
    writeSysctl(key, value);
  }
}

function restoreKernel() {
  const g = settings();
  if (!g.sysctlBefore) return;
  for (const [key, value] of Object.entries(g.sysctlBefore)) {
    if (value !== null && value !== undefined) writeSysctl(key, value);
  }
  g.sysctlBefore = null;
}

/* ------------------------------ public face ------------------------------ */

/**
 * Switch it on.
 *
 * `keep` is the address of whoever pressed the button. It goes on the
 * allowlist before anything loads, because the worst thing a flood guard can
 * do is lock out the one person trying to defend the server.
 */
async function enable(keep) {
  if (process.platform !== 'linux') throw new Error('this only works on Linux');
  if (!(await hasNft())) {
    throw new Error('nftables is not installed on this server. Install it with: apt-get install -y nftables');
  }
  const g = settings();
  if (keep) {
    const list = allowList().v4.concat(allowList().v6);
    if (!list.includes(keep)) g.allow = `${String(g.allow || '').trim()}\n${keep}`.trim();
  }
  await load();
  raiseKernel();
  g.enable = true;
  g.enabledAt = Date.now();
  db.saveNow();
  return status();
}

async function disable() {
  await unload();
  restoreKernel();
  const g = settings();
  g.enable = false;
  db.saveNow();
  return status();
}

/** Change the level, the custom numbers or the allowlist, and reload if on. */
async function configure(body) {
  const g = settings();
  if (body.level !== undefined) {
    g.level = ['relaxed', 'normal', 'strict', 'custom'].includes(body.level) ? body.level : 'normal';
  }
  if (body.custom && typeof body.custom === 'object') {
    g.custom = Object.assign({}, g.custom || {}, body.custom);
  }
  if (body.allow !== undefined) g.allow = String(body.allow).slice(0, 8000);
  db.saveNow();
  if (g.enable) await load();
  return status();
}

/*
 * After a restart, and once a minute after that.
 *
 * Something else flushing nftables - a firewall reload, a provider's agent,
 * an admin running `nft flush ruleset` - takes the table with it, and a guard
 * that silently stops guarding is worse than none, because the admin thinks
 * it is there. So it is put back if it has gone.
 */
async function resume() {
  if (!settings().enable) return { running: false };
  try {
    if (!(await tableLoaded())) await load();
    raiseKernel();
    return { running: true };
  } catch (err) {
    return { running: false, error: err.message };
  }
}

let watcher = null;
function watch() {
  if (watcher) return;
  watcher = setInterval(() => { resume().catch(() => {}); }, 60000);
  watcher.unref?.();
}

async function counters() {
  const out = await run('nft', ['-j', 'list', 'counters', 'table', FAMILY, TABLE]);
  const result = {};
  if (!out.ok) return result;
  try {
    for (const item of JSON.parse(out.stdout).nftables || []) {
      if (item.counter) result[item.counter.name] = item.counter.packets || 0;
    }
  } catch (_) { /* nothing worth reporting */ }
  return result;
}

/** Who is banned right now, with how long each has left. */
async function banned() {
  const list = [];
  for (const set of ['ban4', 'ban6']) {
    const out = await run('nft', ['-j', 'list', 'set', FAMILY, TABLE, set]);
    if (!out.ok) continue;
    try {
      for (const item of JSON.parse(out.stdout).nftables || []) {
        if (!item.set || !Array.isArray(item.set.elem)) continue;
        for (const e of item.set.elem) {
          if (e && e.elem) list.push({ ip: String(e.elem.val), expires: Number(e.elem.expires) || 0 });
          else if (typeof e === 'string') list.push({ ip: e, expires: 0 });
        }
      }
    } catch (_) { /* nothing worth reporting */ }
  }
  return list.sort((a, b) => b.expires - a.expires);
}

async function unban(ip) {
  const addr = String(ip || '').trim();
  if (!addr) throw new Error('which address?');
  const set = addr.includes(':') ? 'ban6' : 'ban4';
  const out = await run('nft', ['delete', 'element', FAMILY, TABLE, set, `{ ${addr} }`]);
  if (!out.ok) throw new Error('that address is not banned');
  return { ok: true };
}

async function unbanAll() {
  await run('nft', ['flush', 'set', FAMILY, TABLE, 'ban4']);
  await run('nft', ['flush', 'set', FAMILY, TABLE, 'ban6']);
  return { ok: true };
}

async function status() {
  const g = settings();
  const nft = await hasNft();
  const loaded = nft ? await tableLoaded() : false;
  return {
    enable: !!g.enable,
    running: loaded,
    nft,
    level: g.level || 'normal',
    custom: g.custom || {},
    limits: limits(),
    levels: LEVELS,
    allow: g.allow || '',
    enabledAt: g.enabledAt || 0,
    syncookies: readSysctl('net.ipv4.tcp_syncookies') === '1',
    counters: loaded ? await counters() : {},
    banned: loaded ? await banned() : []
  };
}

module.exports = {
  enable, disable, configure, resume, watch, status, unban, unbanAll,
  ruleset, limits, allowList, settings, LEVELS, TABLE
};
