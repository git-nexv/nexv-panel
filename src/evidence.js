'use strict';
/**
 * A record of who attacked the server, kept so it can be handed to somebody.
 *
 * The flood guard decides in the kernel and forgets: an address is banned for
 * ten minutes and then it is gone, and nothing is left to show anybody. This
 * keeps what the server actually saw of each attacking address, from the
 * moment it was caught, so the admin can write it down, report it to the
 * network that owns the address, or give it to the police.
 *
 * What it can know, and what it cannot, matters more here than anywhere else
 * in the panel, because this is meant to be evidence:
 *
 *  - The address, the time, the ports it hit and how hard - certain. These
 *    are the server's own observations.
 *  - Who owns the address (the ISP or hosting company, its country, its
 *    abuse contact) - from the regional internet registry and DNS, which is
 *    authoritative for who holds the block but says nothing about who was
 *    using it at that moment. That is the ISP's to answer, from its own logs,
 *    and only to the police. The abuse contact and the exact UTC timestamp
 *    are what make that request possible.
 *  - The operating system - only a guess at the family (Linux/Android,
 *    Windows, Apple, a router) from the TCP packet's starting TTL and option
 *    layout. A flood does not complete a connection, so there is no browser,
 *    no device model, no OS version and no session to read. Anybody can also
 *    forge these values, and forged packets are what most floods are made of.
 *  - The source address of a packet that never completed a handshake can be
 *    forged too. An address that DID complete one - it reached the panel and
 *    sent a User-Agent, or Xray logged a connection from it - is marked as
 *    verified, because a forged address cannot finish a handshake. Only then
 *    is there a User-Agent, and with it a device and OS version.
 *
 * Every report says this in plain words, and carries a SHA-256 of its own
 * contents so it can be shown not to have been edited afterwards.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');

const PREFIX = 'nexv-guard ';
const MAX_IPS = 3000;
const ENRICH_TTL = 24 * 60 * 60 * 1000;

function file() {
  return path.join(process.env.NEXV_DATA_DIR || '/etc/nexv/data', 'evidence.json');
}

let store = null;
let dirty = false;

function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { store = null; }
  if (!store || typeof store !== 'object' || !store.ips) store = { ips: {}, kmsgSeq: -1 };
  return store;
}

function save() {
  if (!dirty) return;
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
    dirty = false;
  } catch (_) { /* tried again on the next pass */ }
}

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout }, (err, stdout) => resolve(err ? '' : (stdout || '')));
  });
}

/* ------------------------------ one address ------------------------------ */

function entry(ip) {
  const s = load();
  if (!s.ips[ip]) {
    s.ips[ip] = {
      ip,
      family: ip.includes(':') ? 6 : 4,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      events: { ban: 0, hit: 0, conn: 0, udp: 0 },
      ports: {},
      srcPorts: [],
      ttl: [],
      tcp: null,
      samples: [],
      web: null,
      verified: false
    };
    prune();
  }
  return s.ips[ip];
}

/* the least active and oldest go first, so a long attack from many addresses
   cannot grow this file without end */
function prune() {
  const s = load();
  const all = Object.values(s.ips);
  if (all.length <= MAX_IPS) return;
  all.sort((a, b) => (a.events.ban + a.events.hit) - (b.events.ban + b.events.hit) || a.lastSeen - b.lastSeen);
  for (const e of all.slice(0, all.length - MAX_IPS)) delete s.ips[e.ip];
}

/* ------------------------ reading the kernel's log ----------------------- */

/*
 * The guard's own log lines, from the kernel ring buffer.
 *
 * /dev/kmsg hands out one record per read and numbers them, so remembering
 * the last number is enough to read only what is new. Its timestamps are
 * microseconds since boot, turned into wall-clock time here using the
 * uptime read at the same moment.
 */
function readKmsg() {
  const out = [];
  let fd;
  try {
    fd = fs.openSync('/dev/kmsg', fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (_) { return out; }
  const buf = Buffer.alloc(8192);
  try {
    for (let i = 0; i < 200000; i++) {
      let n;
      try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (err) {
        if (err.code === 'EAGAIN') break;
        if (err.code === 'EPIPE') continue; // overwritten while reading
        break;
      }
      if (!n) break;
      const rec = buf.toString('utf8', 0, n);
      const semi = rec.indexOf(';');
      if (semi < 0) continue;
      const head = rec.slice(0, semi).split(',');
      const seq = Number(head[1]);
      const usec = Number(head[2]);
      const msg = rec.slice(semi + 1).split('\n')[0];
      if (!msg.startsWith(PREFIX)) continue;
      out.push({ seq, usec, msg });
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* closing */ }
  }
  return out;
}

function uptimeSec() {
  try { return Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]) || 0; } catch (_) { return 0; }
}

/** One log line, as fields: SRC=1.2.3.4 DPT=443 ... OPT (020405B4...) */
function parseLine(msg) {
  const kind = (/^nexv-guard (\w+)/.exec(msg) || [])[1] || 'hit';
  const f = {};
  for (const m of msg.matchAll(/\b([A-Z]+)=(\S*)/g)) f[m[1]] = m[2];
  const opt = (/OPT \(([0-9A-Fa-f]+)\)/.exec(msg) || [])[1] || '';
  return {
    kind,
    src: f.SRC || '',
    dst: f.DST || '',
    proto: f.PROTO || '',
    spt: Number(f.SPT) || 0,
    dpt: Number(f.DPT) || 0,
    ttl: Number(f.TTL || f.HOPLIMIT) || 0,
    window: Number(f.WINDOW) || 0,
    len: Number(f.LEN) || 0,
    iface: f.IN || '',
    opt
  };
}

/*
 * TCP options, in the order the sender put them. The order and the values
 * are the most telling part of a passive fingerprint: every operating
 * system's network stack writes them its own way.
 */
function parseOptions(hex) {
  const b = Buffer.from(hex || '', 'hex');
  const order = [];
  let mss = 0;
  let ws = -1;
  for (let i = 0; i < b.length;) {
    const kind = b[i];
    if (kind === 0) { order.push('E'); i += 1; continue; }
    if (kind === 1) { order.push('N'); i += 1; continue; }
    const len = b[i + 1] || 2;
    if (kind === 2) { order.push('M'); mss = b.readUInt16BE(i + 2); }
    else if (kind === 3) { order.push('W'); ws = b[i + 2]; }
    else if (kind === 4) order.push('S');
    else if (kind === 8) order.push('T');
    else order.push(`?${kind}`);
    i += Math.max(2, len);
  }
  return { order: order.join(','), mss, ws };
}

/*
 * A guess at the sending system's family, and nothing finer.
 *
 * Systems start the TTL at 64 (Linux, Android, macOS, iOS), 128 (Windows) or
 * 255 (network equipment, some BSDs), and it falls by one per router on the
 * way, so the starting value is the next of those above what arrived. The
 * option layout then separates Linux from Apple. It is a guess and is always
 * labelled one: these values are trivially forged.
 */
function guessOs(ttl, tcp) {
  if (!ttl) return { family: 'unknown', initialTtl: 0, hops: 0, basis: 'no TTL was recorded' };
  const initial = ttl <= 64 ? 64 : ttl <= 128 ? 128 : 255;
  const hops = initial - ttl;
  const order = (tcp && tcp.order) || '';
  let family = 'unknown';
  let basis = `starting TTL ${initial}`;
  if (initial === 128) {
    family = 'Windows';
  } else if (initial === 64) {
    if (/^M,N,W,N,N,T,S/.test(order) || /T,S,E/.test(order)) family = 'Apple (macOS / iOS)';
    else if (/^M,S,T,N,W/.test(order)) family = 'Linux / Android';
    else family = 'Linux, Android or Apple';
  } else {
    family = 'Network device, router or BSD';
  }
  if (order) basis += `, TCP options ${order}`;
  return { family, initialTtl: initial, hops, basis };
}

/* --------------------------- a browser's own words ----------------------- */

/*
 * What a User-Agent says, read into parts - kept beside the raw string, never
 * instead of it. It only exists for an address that completed a connection
 * to the panel, and it is whatever the sender chose to write.
 */
function parseUa(ua) {
  const s = String(ua || '');
  if (!s) return null;
  let os = '';
  let osVersion = '';
  let device = '';
  let m;
  if ((m = /Android ([\d.]+)/.exec(s))) { os = 'Android'; osVersion = m[1]; device = (/;\s*([^;)]+?)\s+Build\//.exec(s) || /Android [\d.]+;\s*([^;)]+)\)/.exec(s) || [])[1] || ''; }
  else if ((m = /(iPhone|iPad|iPod).*?OS ([\d_]+)/.exec(s))) { os = 'iOS'; osVersion = m[2].replace(/_/g, '.'); device = m[1]; }
  else if ((m = /Windows NT ([\d.]+)/.exec(s))) { os = 'Windows'; osVersion = { '10.0': '10 / 11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]] || m[1]; }
  else if ((m = /Mac OS X ([\d_]+)/.exec(s))) { os = 'macOS'; osVersion = m[1].replace(/_/g, '.'); device = 'Mac'; }
  else if (/Linux/.test(s)) os = 'Linux';
  else if ((m = /^(curl|Wget|python-requests|Go-http-client|okhttp|Java)[/ ]?([\d.]*)/i.exec(s))) { os = ''; device = `${m[1]} ${m[2]}`.trim() + ' (a script, not a browser)'; }
  /* the specific ones first: Edge and Opera also say "Chrome", and Chrome
     also says "Safari" */
  const browser = /(Edg|OPR)\/([\d.]+)/.exec(s) || /(Firefox|Chrome)\/([\d.]+)/.exec(s)
    || /(Version)\/([\d.]+).*Safari/.exec(s) || [];
  const name = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' }[browser[1]] || browser[1] || '';
  return { os, osVersion, device, browser: name ? `${name} ${browser[2]}` : '' };
}

/** Called by the panel for every request, so an attacker's browser is kept. */
const web = new Map();
function noteWeb(ip, ua, pathName) {
  if (!ip) return;
  let w = web.get(ip);
  if (!w) {
    if (web.size > 5000) web.delete(web.keys().next().value);
    w = { ua: '', firstAt: Date.now(), lastAt: 0, requests: 0, paths: {} };
    web.set(ip, w);
  }
  w.requests += 1;
  w.lastAt = Date.now();
  if (ua) w.ua = String(ua).slice(0, 300);
  const p = String(pathName || '').slice(0, 60);
  if (Object.keys(w.paths).length < 20 || w.paths[p]) w.paths[p] = (w.paths[p] || 0) + 1;
  const s = load();
  if (s.ips[ip]) {
    s.ips[ip].web = Object.assign({}, w);
    if (!s.ips[ip].verified) s.ips[ip].verifiedBy = 'sent a web request to the panel';
    s.ips[ip].verified = true;
    dirty = true;
  }
}

/* -------------------------------- collect -------------------------------- */

/**
 * Take in whatever the guard has logged since last time, and who is in its
 * UDP and connection-limit sets.
 */
async function collect() {
  const s = load();
  const now = Date.now();
  const up = uptimeSec();
  for (const rec of readKmsg()) {
    if (rec.seq <= s.kmsgSeq) continue;
    s.kmsgSeq = rec.seq;
    const p = parseLine(rec.msg);
    if (!p.src) continue;
    const at = up ? Math.round(now - (up - rec.usec / 1e6) * 1000) : now;
    const e = entry(p.src);
    e.firstSeen = Math.min(e.firstSeen, at);
    e.lastSeen = Math.max(e.lastSeen, at);
    e.events[p.kind] = (e.events[p.kind] || 0) + 1;
    if (p.dpt) e.ports[p.dpt] = (e.ports[p.dpt] || 0) + 1;
    if (p.spt) { e.srcPorts.push(p.spt); if (e.srcPorts.length > 20) e.srcPorts.shift(); }
    if (p.ttl && !e.ttl.includes(p.ttl)) { e.ttl.push(p.ttl); if (e.ttl.length > 10) e.ttl.shift(); }
    if (p.opt && !e.tcp) e.tcp = Object.assign({ window: p.window }, parseOptions(p.opt));
    e.proto = p.proto || e.proto;
    e.target = p.dst || e.target;
    if (e.samples.length < 5 || p.kind === 'ban') {
      e.samples.push({ at, line: rec.msg.slice(0, 400) });
      if (e.samples.length > 10) e.samples.splice(5, 1);
    }
    if (web.has(p.src)) {
      e.web = Object.assign({}, web.get(p.src));
      if (!e.verified) e.verifiedBy = 'sent a web request to the panel';
      e.verified = true;
    }
    dirty = true;
  }

  /* the sets that record addresses without a log line each */
  for (const [set, kind] of [['udp4', 'udp'], ['udp6', 'udp'], ['conn4', 'conn'], ['conn6', 'conn']]) {
    const out = await run('nft', ['-j', 'list', 'set', 'inet', 'nexv_guard', set], 8000);
    if (!out) continue;
    try {
      for (const item of JSON.parse(out).nftables || []) {
        for (const el of ((item.set && item.set.elem) || [])) {
          const ip = String((el && el.elem && el.elem.val) || el || '');
          if (!ip) continue;
          const e = entry(ip);
          const flag = `${kind}Seen`;
          if (!e[flag]) { e[flag] = now; e.events[kind] = (e.events[kind] || 0) + 1; }
          e.lastSeen = Math.max(e.lastSeen, now);
          dirty = true;
        }
      }
    } catch (_) { /* nothing to record */ }
  }

  /*
   * An address the kernel has seen complete a handshake is not forged.
   *
   * Connection tracking marks a connection ASSURED once traffic has gone
   * both ways - which needs the sender to have received the server's reply,
   * and a forged source address never receives it. So an ASSURED entry from
   * an address is proof it was really there, which is exactly the line the
   * report draws between an address worth reporting and one that may be a
   * decoy.
   */
  let ct = '';
  try { ct = fs.readFileSync('/proc/net/nf_conntrack', 'utf8'); } catch (_) {
    ct = await run('conntrack', ['-L'], 8000);
  }
  if (ct) {
    const assured = new Set();
    for (const line of ct.split('\n')) {
      if (!line.includes('[ASSURED]')) continue;
      const m = /\bsrc=(\S+)/.exec(line);
      if (m) assured.add(m[1]);
    }
    for (const e of Object.values(s.ips)) {
      if (!e.verified && assured.has(e.ip)) {
        e.verified = true;
        e.verifiedBy = 'completed a TCP handshake (kernel connection tracking: ASSURED)';
        dirty = true;
      }
    }
  }

  /* an address Xray has served completed a handshake, so it is not forged */
  try {
    const online = require('./online');
    for (const e of Object.values(s.ips)) {
      if (e.verified) continue;
      for (const c of (db.data.clients || [])) {
        const tag = `${c.email}#${String(c.id || '').slice(0, 8)}`;
        if (online.forTag(tag).ips.some((x) => x.ip === e.ip)) {
          e.verified = true; e.client = c.email; e.verifiedBy = 'connected through Xray as a client'; dirty = true; break;
        }
      }
    }
  } catch (_) { /* the Xray side is optional */ }

  save();
  return Object.keys(s.ips).length;
}

let timer = null;
function watch() {
  if (timer) return;
  timer = setInterval(() => {
    if (db.settings.guard && db.settings.guard.enable) collect().catch(() => {});
  }, 10000);
  timer.unref?.();
}

/* ------------------------------- who owns it ----------------------------- */

function getJson(url, hops = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000, headers: { Accept: 'application/rdap+json, application/json' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).toString(), hops + 1));
      }
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function vcard(entity, key) {
  const card = (entity && entity.vcardArray && entity.vcardArray[1]) || [];
  const hit = card.find((x) => x[0] === key);
  return hit ? String(hit[3]) : '';
}

/** Who holds the block, from the registry: name, country, abuse contact. */
async function rdap(ip) {
  const j = await getJson(`https://rdap.org/ip/${encodeURIComponent(ip)}`);
  return j ? fromRdap(j) : null;
}

/** An RDAP answer, read into the few fields a report needs. */
function fromRdap(j) {
  if (!j || typeof j !== 'object') return null;
  const out = {
    network: j.name || j.handle || '',
    range: j.startAddress && j.endAddress ? `${j.startAddress} - ${j.endAddress}` : '',
    cidr: ((j.cidr0_cidrs || [])[0] || {}).v4prefix
      ? `${j.cidr0_cidrs[0].v4prefix}/${j.cidr0_cidrs[0].length}`
      : ((j.cidr0_cidrs || [])[0] || {}).v6prefix ? `${j.cidr0_cidrs[0].v6prefix}/${j.cidr0_cidrs[0].length}` : '',
    country: j.country || '',
    org: '',
    abuseEmail: '',
    abusePhone: '',
    source: j.port43 || 'rdap'
  };
  const walk = (list) => {
    for (const e of list || []) {
      const roles = e.roles || [];
      if (roles.includes('abuse')) {
        out.abuseEmail = out.abuseEmail || vcard(e, 'email');
        out.abusePhone = out.abusePhone || vcard(e, 'tel');
      }
      if ((roles.includes('registrant') || roles.includes('administrative')) && !out.org) out.org = vcard(e, 'fn');
      walk(e.entities);
    }
  };
  walk(j.entities);
  /* some registries put the organisation on the network object's remarks
     rather than an entity; the description is better than nothing */
  if (!out.org) {
    const rem = (j.remarks || []).find((r) => /description/i.test(r.title || '')) || (j.remarks || [])[0];
    if (rem && rem.description) out.org = String(rem.description[0] || '').slice(0, 120);
  }
  return out;
}

/* the whois command, for a server that cannot reach rdap.org */
async function whois(ip) {
  const text = await run('whois', [ip], 15000);
  if (!text) return null;
  const pick = (re) => ((text.match(re) || [])[1] || '').trim();
  return {
    network: pick(/^(?:netname|NetName):\s*(.+)$/mi),
    range: pick(/^(?:inetnum|inet6num|NetRange):\s*(.+)$/mi),
    cidr: pick(/^(?:CIDR|route):\s*(.+)$/mi),
    country: pick(/^country:\s*(.+)$/mi),
    org: pick(/^(?:org-name|OrgName|descr):\s*(.+)$/mi),
    abuseEmail: pick(/^(?:abuse-mailbox|OrgAbuseEmail):\s*(.+)$/mi) || pick(/(abuse@[\w.-]+)/i),
    abusePhone: pick(/^OrgAbusePhone:\s*(.+)$/mi),
    source: 'whois'
  };
}

/* the network's AS number and name, from Team Cymru's DNS service */
async function asn(ip) {
  try {
    let q;
    if (ip.includes(':')) {
      const full = require('net').isIPv6(ip) ? ip : '';
      if (!full) return null;
      const parts = full.split('::');
      const left = parts[0] ? parts[0].split(':') : [];
      const right = parts[1] ? parts[1].split(':') : [];
      const groups = left.concat(Array(8 - left.length - right.length).fill('0'), right);
      q = `${groups.map((g) => g.padStart(4, '0')).join('').split('').reverse().join('.')}.origin6.asn.cymru.com`;
    } else {
      q = `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`;
    }
    const txt = (await dns.resolveTxt(q)).map((x) => x.join(''))[0] || '';
    const [num, prefix, cc] = txt.split('|').map((x) => x.trim());
    if (!num) return null;
    const first = num.split(' ')[0];
    const nameTxt = (await dns.resolveTxt(`AS${first}.asn.cymru.com`).catch(() => [])).map((x) => x.join(''))[0] || '';
    return { asn: `AS${first}`, prefix: prefix || '', country: cc || '', name: (nameTxt.split('|')[4] || '').trim() };
  } catch (_) { return null; }
}

async function reverseDns(ip) {
  try {
    const names = await dns.reverse(ip);
    const out = [];
    for (const name of names.slice(0, 5)) {
      /* a PTR record is the owner's claim; one that resolves back to the
         same address is a claim that agrees with itself */
      let confirmed = false;
      try {
        const back = ip.includes(':') ? await dns.resolve6(name) : await dns.resolve4(name);
        confirmed = back.includes(ip);
      } catch (_) { /* not confirmed */ }
      out.push({ name, confirmed });
    }
    return out;
  } catch (_) { return []; }
}

/** Fill in everything the outside world will say about one address. */
async function enrich(ip, force) {
  const e = load().ips[ip];
  if (!e) return null;
  if (!force && e.who && Date.now() - (e.who.at || 0) < ENRICH_TTL) return e;
  const [names, reg, as] = await Promise.all([reverseDns(ip), rdap(ip).then((r) => r || whois(ip)), asn(ip)]);
  e.who = { at: Date.now(), reverseDns: names, registry: reg, asn: as };
  dirty = true;
  save();
  return e;
}

/* ------------------------------- reporting ------------------------------- */

function view(e) {
  const ttl = e.ttl.length ? Math.max(...e.ttl) : 0;
  return Object.assign({}, e, {
    os: guessOs(ttl, e.tcp),
    ua: e.web && e.web.ua ? parseUa(e.web.ua) : null,
    topPorts: Object.entries(e.ports).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([port, n]) => ({ port: Number(port), n })),
    score: (e.events.ban || 0) * 100 + (e.events.hit || 0) + (e.events.conn || 0) * 10 + (e.events.udp || 0) * 10
  });
}

function list() {
  return Object.values(load().ips).map(view).sort((a, b) => b.lastSeen - a.lastSeen || b.score - a.score);
}

function one(ip) {
  const e = load().ips[ip];
  return e ? view(e) : null;
}

function forget(ip) {
  const s = load();
  if (ip) delete s.ips[ip]; else s.ips = {};
  dirty = true;
  save();
}

const fmtUtc = (t) => (t ? new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-');
const fmtTehran = (t) => {
  if (!t) return '-';
  try {
    return new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Tehran', hour12: false }) + ' Tehran';
  } catch (_) { return '-'; }
};

/**
 * A plain-text report a person can print, sign and hand over.
 *
 * Plain text on purpose: it opens anywhere, prints the same everywhere, and
 * its hash at the bottom can be checked by anybody with `sha256sum`.
 */
function report(ips) {
  const s = db.settings;
  const lines = [];
  const push = (x = '') => lines.push(x);
  push('NETWORK ATTACK EVIDENCE REPORT');
  push('==============================');
  push(`Generated : ${fmtUtc(Date.now())}  (${fmtTehran(Date.now())})`);
  push(`Server    : ${s.serverIP || '-'}${s.domain ? `  (${s.domain})` : ''}`);
  push(`Recorded by the NexV panel's flood guard (Linux nftables, kernel log).`);
  push(`Addresses : ${ips.length}`);
  push('');
  push('WHAT THIS REPORT SHOWS AND DOES NOT SHOW');
  push('- Times, addresses, ports and counts are the server\'s own observations.');
  push('- "Network owner" and "abuse contact" come from the internet registry (RDAP/whois)');
  push('  and say who holds the address block - not who was using it. Only the owner');
  push('  (usually an ISP) can say that, from its own records, for the exact UTC time below.');
  push('- An address marked NOT VERIFIED never completed a TCP handshake, so it may have');
  push('  been forged by the attacker. VERIFIED addresses completed a connection and cannot');
  push('  have been forged.');
  push('- The operating system line is an estimate of the family only, from packet values');
  push('  that can themselves be forged. Device model, OS version and browser exist only for');
  push('  verified addresses that sent a web request (User-Agent), and are what that');
  push('  software claimed to be.');
  push('');

  for (const ip of ips) {
    const e = one(ip);
    if (!e) continue;
    const w = e.who || {};
    const reg = w.registry || {};
    push('------------------------------------------------------------');
    push(`ADDRESS        : ${e.ip}  (IPv${e.family})`);
    push(`Verified real  : ${e.verified ? `YES - ${e.verifiedBy || 'completed a connection'}` : 'NOT VERIFIED - may be forged'}`);
    push(`First seen     : ${fmtUtc(e.firstSeen)}  (${fmtTehran(e.firstSeen)})`);
    push(`Last seen      : ${fmtUtc(e.lastSeen)}  (${fmtTehran(e.lastSeen)})`);
    push(`Events         : banned for flooding x${e.events.ban || 0}, packets while banned (sampled) x${e.events.hit || 0},`);
    push(`                 too many connections x${e.events.conn || 0}, UDP flood x${e.events.udp || 0}`);
    push(`Target         : ${e.target || s.serverIP || '-'}  ports ${e.topPorts.map((p) => `${p.port}(${p.n})`).join(', ') || '-'}`);
    push(`Protocol       : ${e.proto || '-'}`);
    if (w.reverseDns && w.reverseDns.length) {
      push(`Reverse DNS    : ${w.reverseDns.map((r) => `${r.name}${r.confirmed ? ' (confirmed)' : ' (not confirmed)'}`).join(', ')}`);
    } else push('Reverse DNS    : none');
    push(`Network owner  : ${reg.org || reg.network || '-'}${reg.network && reg.org ? ` [${reg.network}]` : ''}`);
    push(`Address block  : ${reg.cidr || reg.range || (w.asn && w.asn.prefix) || '-'}`);
    push(`Country        : ${reg.country || (w.asn && w.asn.country) || '-'}`);
    push(`AS number      : ${w.asn ? `${w.asn.asn} ${w.asn.name}` : '-'}`);
    push(`Abuse contact  : ${reg.abuseEmail || '-'}${reg.abusePhone ? `  tel ${reg.abusePhone}` : ''}`);
    push(`OS (estimate)  : ${e.os.family}  - ${e.os.basis}${e.os.hops ? `, about ${e.os.hops} hops away` : ''}`);
    if (e.tcp) push(`TCP fingerprint: window ${e.tcp.window}, MSS ${e.tcp.mss || '-'}, window scale ${e.tcp.ws >= 0 ? e.tcp.ws : '-'}, options ${e.tcp.order || '-'}`);
    push(`TTL observed   : ${e.ttl.join(', ') || '-'}`);
    push(`Source ports   : ${e.srcPorts.join(', ') || '-'}`);
    if (e.web) {
      push(`Web requests   : ${e.web.requests} to this panel, last ${fmtUtc(e.web.lastAt)}`);
      push(`User-Agent     : ${e.web.ua || '-'}`);
      if (e.ua) push(`  read as      : ${[e.ua.device, e.ua.os && `${e.ua.os} ${e.ua.osVersion}`.trim(), e.ua.browser].filter(Boolean).join(' / ') || '-'}`);
    }
    if (e.client) push(`Xray client    : connected as "${e.client}"`);
    if (e.samples.length) {
      push('Kernel log samples:');
      for (const smp of e.samples) push(`  ${fmtUtc(smp.at)}  ${smp.line}`);
    }
    push('');
  }
  /*
   * The hash covers exactly the bytes above the closing rule, newline and
   * all, so anybody can check it with nothing but standard tools - the
   * command is printed under it. An earlier version hashed the text without
   * its last newline, so `sha256sum` on the file never matched, which is
   * worse than no hash: it reads as tampering.
   */
  const body = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const count = body.split('\n').length - 1;
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return `${body}------------------------------------------------------------\n`
    + `SHA-256 of the first ${count} lines of this file (everything above this rule):\n${hash}\n`
    + `Check it with:  head -n ${count} THIS_FILE | sha256sum\n`;
}

module.exports = {
  collect, watch, list, one, enrich, report, forget, noteWeb,
  parseLine, parseOptions, guessOs, parseUa, fromRdap, PREFIX
};
