'use strict';
/**
 * A Telegram proxy, which is not an Xray inbound and cannot be one.
 *
 * MTProto is Telegram's own transport, and a Telegram proxy speaks it rather
 * than vless or trojan. Xray-core did support it once and the project removed
 * it; the request to bring it back was closed as not planned, on the grounds
 * that the protocol is fingerprinted and blocked wherever it matters now. So
 * there is no inbound to add on the Inbounds page: a config.json with a
 * `mtproto` inbound in it is one Xray refuses to start on.
 *
 * What does work is a second daemon beside Xray that speaks MTProto, and that
 * is what this manages - mtg, which is one static Go binary, a two-line config
 * and a systemd unit. The panel installs it, holds its secret, opens its port,
 * and hands over the tg:// link. Xray is not involved and does not need to be.
 *
 * FakeTLS is the only mode offered. A bare MTProto proxy announces itself in
 * its first packet; FakeTLS wraps the same thing in what looks like a TLS
 * handshake to a domain that really exists, which is the difference between a
 * proxy that lasts a week and one that lasts an afternoon. The secret carries
 * the domain, which is why changing the domain changes the secret and every
 * link already handed out.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');

const BIN = process.env.NEXV_MTG_BIN || '/usr/local/bin/mtg';
const DIR = process.env.NEXV_MTG_DIR || '/usr/local/etc/nexv-mtproto';
/* one config and one unit per inbound: see serviceOf/configOf below */

/*
 * The release this panel installs, and the hash of every file it will accept.
 *
 * Pinned rather than "latest" on purpose: the panel runs as root and this is a
 * binary off the internet, so what lands on the server is a file whose hash
 * was written down here in advance. A download that does not match is thrown
 * away. The hashes are the project's own published checksums for 2.2.8.
 */
const VERSION = '2.2.8';
const SUMS = {
  amd64: '7ef19d079d85f4e00d4f8334ec1f3f3c8718e3d0ed1f3109ea9a8673138a2102',
  arm64: '562a94dd4cafcb8f179b76cfeafb76da12747c8e230bc76235bf8746cc189644',
  armv7: '494ee3794ed00201e5333b478236ce2f434b33f2d3445f227debe9fc386bbef0',
  armv6: '9b2061ba01661d60411798e0a63e6cbc9430c6c1398e1b20c01e4a66ca9a1d82',
  386: '99c2f177730271b88d8f2404b2cf27d5ee997685f6d9118d4c8cac9c5aaedf50'
};

/* Domains worth pretending to be: big, boring, and certainly not blocked
   wherever Telegram is reachable at all. */
const DEFAULT_DOMAIN = 'www.cloudflare.com';
const DEFAULT_PORT = 8443;

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : '' });
    });
  });
}

/** Which release file this machine needs, or '' when we have no build for it. */
function archKey() {
  switch (os.arch()) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    case 'arm': return 'armv7';
    case 'ia32': return '386';
    default: return '';
  }
}

/**
 * The settings this panel used to keep in a corner of its own.
 *
 * Kept only so an install made before MTProto became a protocol can be moved
 * across: whatever was configured there becomes an inbound on the first run
 * and this is never read again.
 */
function legacySettings() {
  const d = db.data;
  return (d.mtproto && typeof d.mtproto === 'object') ? d.mtproto : null;
}

/** Every MTProto inbound, which is the whole of what this module serves. */
function inbounds() {
  return (db.data.inbounds || []).filter((i) => i.protocol === 'mtproto');
}

function byId(id) {
  return inbounds().find((i) => i.id === id) || null;
}

/** A hostname, as strict as it needs to be - it goes into a secret. */
function cleanDomain(value) {
  const want = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(want)) return '';
  if (want.length > 63) return '';
  /* an address is not a disguise. The domain in the secret becomes the name in
     the client's TLS hello, and a hello for 10.0.0.1 is the one thing on the
     wire that looks less like a browser than no disguise at all */
  if (/^\d+\.\d+\.\d+\.\d+$/.test(want)) return '';
  return want;
}

/**
 * A FakeTLS secret: `ee`, sixteen random bytes, then the domain's own bytes.
 *
 * The client reads the domain back out of the secret and uses it as the name
 * in its TLS hello, which is how both ends agree on what they are pretending
 * to be without the domain being sent separately. It also means the secret is
 * not a password that can be rotated independently of the disguise: change
 * one, change both, and every link handed out so far stops working.
 */
function makeSecret(domain) {
  const host = cleanDomain(domain);
  if (!host) throw new Error('that is not a domain name');
  return `ee${crypto.randomBytes(16).toString('hex')}${Buffer.from(host, 'utf8').toString('hex')}`;
}

/** The domain a secret is carrying, for showing what an old link points at. */
function domainOf(secret) {
  const hex = String(secret || '');
  if (!/^ee[0-9a-f]{32}([0-9a-f]{2})+$/i.test(hex)) return '';
  try { return Buffer.from(hex.slice(34), 'hex').toString('utf8'); } catch (_) { return ''; }
}

/** What somebody taps. Telegram takes either spelling; both are offered. */
function linksFor(host, port, secret) {
  const query = `server=${encodeURIComponent(host)}&port=${port}&secret=${secret}`;
  return { tg: `tg://proxy?${query}`, https: `https://t.me/proxy?${query}` };
}

/* --------------------------- one inbound, one daemon --------------------- */

/*
 * A service, a config file and a unit name per inbound.
 *
 * mtg is one secret on one port per process, so two MTProto inbounds are two
 * processes - which is the same thing two vless inbounds are inside Xray, and
 * the admin should not have to know the difference. The id is what names them
 * apart, shortened the way client tags are, so the unit is something a person
 * can read in `systemctl status`.
 */
function tagOf(inb) {
  /* a unit name, so only characters that are safe in one: the id is a uuid
     and its first eight are hex, but nothing here should depend on that */
  const clean = String(inb.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean.slice(0, 8) || 'default';
}

function serviceOf(inb) { return `nexv-mtproto-${tagOf(inb)}`; }
function unitPathOf(inb) { return `/etc/systemd/system/${serviceOf(inb)}.service`; }
function configOf(inb) { return path.join(DIR, `${tagOf(inb)}.toml`); }

function hasSystemd() {
  return fs.existsSync(process.env.NEXV_SYSTEMD_DIR || '/run/systemd/system');
}

async function isRunning(inb) {
  if (!hasSystemd()) return false;
  const out = await run('systemctl', ['is-active', '--quiet', serviceOf(inb)], 8000);
  return out.ok;
}

/* ------------------------------- the dials ------------------------------- */

/*
 * What an MTProto inbound can be tuned with, and what it is when nobody has.
 *
 * mtg has a lot of knobs and the panel used to write three lines: a secret, a
 * port and prefer-ipv4. That was fine on a server with clean DNS and one
 * proxy on it, and wrong almost everywhere else - which is why the thing
 * would not connect. Each of these is a real key in mtg's own config; the
 * defaults here are the ones that work on a filtered link rather than the
 * ones upstream ships, and every one of them is on the inbound's form.
 */
const TUNING = {
  /* The port mtg reaches the fronting site on. Only moved behind a balancer. */
  mtFrontPort: 443,
  /*
   * Where to actually connect for domain fronting, when the disguise domain
   * cannot be resolved from this server. The name still goes in the TLS
   * hello; only the address dialled changes. On a filtered link this is
   * occasionally the whole difference between a proxy that works and one
   * that does not, and there is no way to guess it, so it is a field.
   */
  mtFrontHost: '',
  /*
   * Which address family to reach Telegram over. mtg prefers IPv6 by default
   * and a server whose IPv6 is configured but dead then fails every
   * connection until it times out; preferring v4 is the safe default and the
   * only-* modes are there for a server that really is one or the other.
   */
  mtPreferIP: 'prefer-ipv4',
  /* How many connections at once before new ones are dropped. */
  mtConcurrency: 8192,
  /*
   * FakeTLS carries a timestamp and mtg rejects anything outside this window.
   * The default is three seconds, and a VPS whose clock has drifted further
   * than that refuses every single client while looking perfectly healthy -
   * no error, no log, just nothing connecting. Five is still tight enough to
   * stop a replay and loose enough to survive a clock nobody is watching.
   */
  mtSkew: '5s',
  /*
   * Telegram occasionally asks for a datacentre the proxy has not heard of.
   * Upstream rejects it; any DC can serve any request at the cost of a little
   * latency, so accepting is the difference between a client that reconnects
   * and one that sits there failing.
   */
  mtFallbackDC: true,
  /*
   * mtg ignores the system resolver and does DNS over HTTPS, to Cloudflare by
   * default. Where 1.1.1.1 is blocked or answers with a lie - which is most
   * of the places anybody wants this proxy - that fails, and it fails at
   * startup while resolving the disguise domain. This is settable, and
   * "system" hands DNS back to the operating system, which on a server with a
   * working resolver is the one thing certain to answer.
   */
  mtDns: 'system',
  /*
   * Upstream SOCKS5 proxies for mtg's own traffic to Telegram, one per line.
   * More than one and it balances between them. For a server that cannot
   * reach Telegram directly at all.
   */
  mtUpstream: '',
  /* The anti-probing cache. Worth keeping on; a dial because it costs memory. */
  mtAntiReplay: true,
  /*
   * The FireHOL blocklist, which upstream has on. It is downloaded from
   * iplists.firehol.org - unreachable from exactly the servers this panel
   * tends to run on, so it silently never loads - and the default list
   * contains the private ranges, so it rejects anybody testing from the same
   * network. Off unless it is asked for.
   */
  mtBlocklist: false,
  /* Verbose logging, for working out why a proxy will not come up. */
  mtDebug: false
};

const PREFER_IP = ['prefer-ipv4', 'prefer-ipv6', 'only-ipv4', 'only-ipv6'];

/** One inbound's dials, with anything unset or nonsensical filled in. */
function tuning(inb) {
  const out = Object.assign({}, TUNING);
  for (const key of Object.keys(TUNING)) {
    const got = inb[key];
    if (got === undefined || got === null || got === '') continue;
    out[key] = typeof TUNING[key] === 'boolean' ? !!got : got;
  }
  out.mtFrontPort = Math.min(65535, Math.max(1, Number(out.mtFrontPort) || 443));
  out.mtConcurrency = Math.min(1000000, Math.max(16, Number(out.mtConcurrency) || 8192));
  if (!PREFER_IP.includes(out.mtPreferIP)) out.mtPreferIP = TUNING.mtPreferIP;
  if (!/^\d+(\.\d+)?(ms|s|m|h)$/.test(String(out.mtSkew))) out.mtSkew = TUNING.mtSkew;
  return out;
}

/** TOML string literal: mtg's parser, so the usual two characters. */
function q(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/*
 * mtg will not take a hostname in bind-to: it wants a literal address or it
 * refuses to start, and the refusal reads like a parse error rather than
 * "that is a domain". An inbound whose listen was filled in with the server's
 * own domain - which is a reasonable thing for somebody to type - therefore
 * produced a proxy that was never running and never said why.
 */
function bindHost(inb) {
  const want = String(inb.listen || '').trim();
  if (!want || want === '*' || want === '0.0.0.0') return '0.0.0.0';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(want)) return want;
  if (want.includes(':')) return `[${want.replace(/^\[|\]$/g, '')}]`;
  throw new Error(`"${want}" is a name, and the Telegram proxy can only listen on an IP address `
    + '- leave the listen field empty to take every address');
}

/** The addresses to tell mtg are ours, so it never asks the internet. */
function publicIPs() {
  const out = { v4: '', v6: '' };
  const seen = String(db.settings.serverIP || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(seen)) out.v4 = seen;
  else if (seen.includes(':')) out.v6 = seen;
  return out;
}

function writeConfig(inb) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const t = tuning(inb);
  const ips = publicIPs();
  const lines = [
    '# Written by the NexV panel. Edit the inbound in the panel, not this file:',
    '# it is rewritten from scratch every time the inbound is saved.',
    '',
    `secret = ${q(inb.mtSecret)}`,
    `bind-to = ${q(`${bindHost(inb)}:${Number(inb.port)}`)}`,
    `prefer-ip = ${q(t.mtPreferIP)}`,
    `concurrency = ${t.mtConcurrency}`,
    `tolerate-time-skewness = ${q(t.mtSkew)}`,
    `allow-fallback-on-unknown-dc = ${t.mtFallbackDC ? 'true' : 'false'}`,
    `debug = ${t.mtDebug ? 'true' : 'false'}`
  ];

  /*
   * Without these mtg asks ifconfig.co what its own address is, every start.
   * From a server behind the kind of filtering this proxy exists to get
   * through, that request hangs until it times out, and the proxy is down for
   * as long as it takes. The panel already knows the address.
   */
  if (ips.v4) lines.push(`public-ipv4 = ${q(ips.v4)}`);
  if (ips.v6) lines.push(`public-ipv6 = ${q(ips.v6)}`);

  lines.push('', '[domain-fronting]', `port = ${t.mtFrontPort}`);
  if (t.mtFrontHost) lines.push(`host = ${q(t.mtFrontHost)}`);

  lines.push('', '[network]');
  /*
   * An empty dns leaves mtg on the operating system's resolver. Anything else
   * is handed over as written - mtg takes https:// for DoH, tls:// for DoT
   * and a bare address for plain UDP.
   */
  const dns = String(t.mtDns || '').trim();
  lines.push(`dns = ${q(dns && dns !== 'system' ? dns : '')}`);
  const ups = String(t.mtUpstream || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  lines.push(`proxies = [${ups.map(q).join(', ')}]`);

  lines.push('', '[defense.anti-replay]', `enabled = ${t.mtAntiReplay ? 'true' : 'false'}`);
  lines.push('', '[defense.blocklist]', `enabled = ${t.mtBlocklist ? 'true' : 'false'}`);

  /*
   * Upstream turns Prometheus on and binds it to 127.0.0.1:3129 - a fixed
   * port, in a panel where two Telegram proxies are two processes. The second
   * one lost the race for that port and died on startup, every time, and the
   * inbound simply showed as not running. Nothing here reads those metrics,
   * so it is off.
   */
  lines.push('', '[stats.prometheus]', 'enabled = false', '');

  const file = configOf(inb);
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  return file;
}

function writeUnit(inb) {
  const unit = [
    '[Unit]',
    `Description=NexV Telegram proxy (MTProto) - ${inb.remark || tagOf(inb)}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${BIN} run ${configOf(inb)}`,
    'Restart=always',
    'RestartSec=3',
    'LimitNOFILE=65535',
    /* it needs a low port sometimes and nothing else; no reason for it to run
       as root beyond binding one */
    'AmbientCapabilities=CAP_NET_BIND_SERVICE',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].join('\n');
  fs.writeFileSync(unitPathOf(inb), unit, { mode: 0o644 });
  return unitPathOf(inb);
}

/** Put one inbound's proxy up, replacing whatever it was running before. */
async function startOne(inb) {
  if (!(await installed()).ok) await install();
  if (!hasSystemd()) throw new Error('this server has no systemd, so the proxy cannot be kept running');
  writeConfig(inb);
  writeUnit(inb);
  await run('systemctl', ['daemon-reload'], 15000);
  /* restart rather than start: the port or the secret may have changed, and a
     service already up would otherwise keep serving the old one */
  const on = await run('systemctl', ['enable', '--now', serviceOf(inb)], 30000);
  if (!on.ok) throw new Error((on.stderr || on.error || 'systemd would not start it').slice(0, 200));
  await run('systemctl', ['restart', serviceOf(inb)], 30000);
  return { ok: true };
}

/** Take one down, and forget it ever existed when it is really gone. */
async function stopOne(inb, remove) {
  if (hasSystemd()) await run('systemctl', ['disable', '--now', serviceOf(inb)], 30000);
  if (remove) {
    try { fs.rmSync(unitPathOf(inb), { force: true }); } catch (_) { /* already gone */ }
    try { fs.rmSync(configOf(inb), { force: true }); } catch (_) { /* as above */ }
    if (hasSystemd()) await run('systemctl', ['daemon-reload'], 15000);
  }
  return { ok: true };
}

/**
 * Make the running daemons match the inbound list, whatever it now says.
 *
 * Called after every change to an inbound, and on the way up. It is the whole
 * of the control surface: there is no "start the Telegram proxy" button
 * anywhere, because an MTProto inbound that is switched on is one that should
 * be running and an inbound that is switched off or deleted is one that
 * should not. Exactly what enable means for every other inbound.
 */
/* what the running daemons would have to match; see sync() */
function fingerprint() {
  return inbounds()
    .map((i) => {
      const t = tuning(i);
      /* every dial, not just the port and the key: a change to the resolver
         or the fronting address rewrites the config file, and leaving them
         out here meant the daemon kept running with the old one and the
         admin's change silently did nothing */
      const dials = Object.keys(TUNING).sort().map((k) => `${k}=${t[k]}`).join(',');
      return [i.id, i.port, i.listen || '', i.mtSecret || '', i.enable !== false, dials].join(':');
    })
    .sort()
    .join('|');
}

let lastSynced = null;

async function sync(force) {
  /*
   * Applying the configuration happens on every client change too, and this
   * one shells out to systemctl - so when nothing about the MTProto inbounds
   * has moved since the last pass, there is nothing to do and doing it anyway
   * would make saving a client slower for everybody who has one of these.
   */
  const now = fingerprint();
  if (!force && lastSynced === now) return { started: [], stopped: [], failed: [], skipped: true };

  const mine = inbounds();
  const wanted = mine.filter((i) => i.enable !== false);
  const out = { started: [], stopped: [], failed: [] };

  for (const inb of mine) {
    try {
      if (inb.enable === false) {
        await stopOne(inb, false);
        out.stopped.push(inb.id);
      } else {
        await startOne(inb);
        out.started.push(inb.id);
        try { await require('./firewall').allow(inb.port, 'tcp'); } catch (_) { /* its own page says */ }
      }
    } catch (err) {
      out.failed.push({ id: inb.id, reason: err.message });
    }
  }

  /* units for inbounds that are no longer there at all. Read off the disk
     rather than remembered, so a deletion the panel was not running for is
     still cleaned up the next time it is. */
  const alive = new Set(mine.map((i) => serviceOf(i)));
  try {
    for (const name of fs.readdirSync('/etc/systemd/system')) {
      const m = /^(nexv-mtproto-[0-9a-z]+)\.service$/.exec(name);
      if (!m || alive.has(m[1])) continue;
      if (hasSystemd()) await run('systemctl', ['disable', '--now', m[1]], 30000);
      fs.rmSync(`/etc/systemd/system/${name}`, { force: true });
      out.stopped.push(m[1]);
    }
    if (hasSystemd()) await run('systemctl', ['daemon-reload'], 15000);
  } catch (_) { /* no systemd directory: nothing to tidy */ }

  void wanted;
  /* remembered only when nothing failed: a daemon that would not start has to
     be tried again on the next pass, not written off as done */
  lastSynced = out.failed.length ? null : now;
  return out;
}

/* ------------------------------ why it is down --------------------------- */

/* systemd ends every failure with the same two or three lines, and a search
   for "failed" finds those rather than the thing that actually broke */
const UNIT_NOISE = /^(Stopped|Started|Deactivated successfully|Scheduled restart|Consumed |Main process exited|Failed with result|Service hold-off|Unit .* entered failed state)/i;

/** The last line mtg itself wrote, skipping systemd's own epitaph. */
async function lastLog(inb) {
  if (!hasSystemd()) return '';
  const out = await run('journalctl', ['-u', serviceOf(inb), '-n', '60', '--no-pager', '-o', 'cat'], 10000);
  const lines = (out.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!UNIT_NOISE.test(lines[i])) return lines[i].slice(0, 300);
  }
  return '';
}

/*
 * Turn mtg's own words into something a person can act on.
 *
 * These are the failures that actually happen, in the order they happen, and
 * every one of them used to surface as an inbound that was simply not running
 * with no explanation anywhere in the panel.
 */
const KNOWN = [
  [/address already in use/i, (p) => `port ${p.port} is already taken by something else on this server`],
  [/permission denied/i, (p) => `the proxy is not allowed to open port ${p.port}`],
  [/bind|parse.*bind-to|invalid.*address/i, () => 'the listen address is not one mtg will take - leave it empty for every address'],
  [/secret/i, () => 'the key is malformed - make a new one on the inbound'],
  [/no such host|lookup .* no such|dns|resolve/i, (p) => `this server cannot resolve ${p.domain || 'the disguise domain'}. `
    + 'Set the DNS resolver on the inbound, or fill in "connect to instead" with its IP address'],
  [/i\/o timeout|connection refused|unreachable|context deadline/i, (p) => `this server cannot reach ${p.domain || 'the disguise domain'} on port ${p.frontPort}. `
    + 'Try another disguise domain, or point "connect to instead" at an address that answers'],
  [/unknown field|cannot unmarshal|toml/i, () => 'mtg would not read its configuration - this is a panel bug, please report the log line below'],
  [/blacklist|blocklist/i, () => 'the client\'s address is on the blocklist - turn the blocklist off on the inbound']
];

/**
 * Say why one proxy is not working, in a sentence rather than a log dump.
 *
 * It asks mtg to check its own configuration first, because `mtg doctor`
 * catches a bad secret or an unreachable disguise domain without anything
 * having to be running, and falls back to the last thing the daemon said.
 */
async function diagnose(inb) {
  const out = { running: await isRunning(inb), reason: '', detail: '', checked: false };
  const t = tuning(inb);
  const p = { port: Number(inb.port), domain: domainOf(inb.mtSecret) || inb.mtDomain || '', frontPort: t.mtFrontPort };

  if (!(await installed()).ok) {
    out.reason = 'mtg is not installed yet - the panel installs it the first time a Telegram proxy is switched on';
    return out;
  }
  if (!hasSystemd()) {
    out.reason = 'this server has no systemd, so the proxy cannot be kept running';
    return out;
  }

  /* the written config is the one that is actually running, so check that */
  let file = '';
  try { file = configOf(inb); if (!fs.existsSync(file)) file = writeConfig(inb); } catch (err) { 
    out.reason = err.message;
    return out;
  }
  const doctor = await run(BIN, ['doctor', file], 25000);
  out.checked = true;
  const said = `${doctor.stdout || ''}\n${doctor.stderr || ''}`.trim();
  const log = await lastLog(inb);
  out.detail = (said && !doctor.ok ? said : log).slice(0, 600);

  const haystack = `${doctor.ok ? '' : said}\n${out.running ? '' : log}`;
  for (const [re, say] of KNOWN) {
    if (re.test(haystack)) { out.reason = say(p); return out; }
  }

  if (out.running && doctor.ok) {
    out.reason = '';
    return out;
  }
  if (out.running) {
    out.reason = 'the proxy is running, but mtg is unhappy with its settings - see below';
    return out;
  }
  out.reason = log ? 'the proxy stopped; mtg said:' : 'the proxy is not running and said nothing about why';
  return out;
}

/** Everything the page shows about one MTProto inbound. */
async function statusOf(inb) {
  const bin = await installed();
  const host = String(db.settings.domain || db.settings.serverIP || '').trim();
  const secret = inb.mtSecret || '';
  const links = secret && host ? linksFor(host, Number(inb.port), secret) : { tg: '', https: '' };
  return {
    id: inb.id,
    installed: bin.ok,
    version: bin.version || '',
    wantVersion: VERSION,
    running: await isRunning(inb),
    service: serviceOf(inb),
    port: Number(inb.port),
    domain: domainOf(secret) || inb.mtDomain || '',
    secret,
    host,
    links,
    supported: !!archKey() && process.platform === 'linux',
    systemd: hasSystemd()
  };
}

/** The same, for the whole list - what the Inbounds page asks for once. */
async function status() {
  const mine = inbounds();
  const bin = await installed();
  const out = {
    installed: bin.ok,
    version: bin.version || '',
    wantVersion: VERSION,
    supported: !!archKey() && process.platform === 'linux',
    systemd: hasSystemd(),
    arch: archKey(),
    inbounds: []
  };
  for (const inb of mine) out.inbounds.push(await statusOf(inb));
  return out;
}

/**
 * Move an install made before this was a protocol.
 *
 * The Telegram proxy used to be a card of its own with its settings in a
 * corner of the store. Anybody who switched it on there should not have to
 * set it up again, so it becomes an inbound - with its port, its disguise and
 * the secret it already had, so the links already handed out keep working.
 */
async function migrate() {
  const old = legacySettings();
  if (!old || !old.secret) return { moved: false };
  const d = db.data;
  d.inbounds = d.inbounds || [];
  if (d.inbounds.some((i) => i.protocol === 'mtproto')) {
    delete d.mtproto;
    db.saveNow();
    return { moved: false };
  }

  d.inbounds.push({
    id: db.id(),
    remark: 'Telegram proxy',
    protocol: 'mtproto',
    port: Number(old.port) || DEFAULT_PORT,
    listen: '0.0.0.0',
    enable: !!old.enable,
    mtSecret: old.secret,
    mtDomain: domainOf(old.secret) || old.domain || DEFAULT_DOMAIN,
    createdAt: Date.now()
  });
  delete d.mtproto;
  db.saveNow();
  return { moved: true };
}

/** Start whatever should be running, after a panel restart. */
async function resume() {
  await migrate();
  if (!inbounds().some((i) => i.enable !== false)) return { started: 0 };
  const out = await sync();
  return { started: out.started.length, failed: out.failed };
}

/* --------------------------------- install ------------------------------- */

/** Is the binary there? Its own version is read from it when it is. */
async function installed() {
  try { if (!fs.statSync(BIN).isFile()) return { ok: false }; } catch (_) { return { ok: false }; }
  const out = await run(BIN, ['--version'], 8000);
  const m = /(\d+\.\d+\.\d+)/.exec(`${out.stdout} ${out.stderr}`);
  return { ok: true, version: m ? m[1] : '' };
}

/**
 * Fetch the pinned release and put the binary in place.
 *
 * The tarball is hashed before anything is unpacked, and a mismatch stops
 * here: the panel is root, and "download and run" without that check is how a
 * management panel turns into somebody else's way in. Extraction asks tar for
 * one named path and nothing else, so a tarball cannot write outside the
 * directory even if it tried.
 */
async function install() {
  const arch = archKey();
  if (!arch) throw new Error(`no mtg build for this machine (${os.arch()})`);
  if (process.platform !== 'linux') throw new Error('this only works on Linux');

  const name = `mtg-${VERSION}-linux-${arch}.tar.gz`;
  const url = `https://github.com/9seconds/mtg/releases/download/v${VERSION}/${name}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexv-mtg-'));
  const tarball = path.join(work, name);

  try {
    const got = await run('curl', ['-fsSL', '--max-time', '180', '-o', tarball, url], 190000);
    if (!got.ok) throw new Error(`could not download mtg: ${(got.stderr || got.error || '').slice(0, 160)}`);

    const sum = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    if (sum !== SUMS[arch]) {
      throw new Error('the downloaded file is not the one we expected - nothing was installed');
    }

    /* the archive holds mtg-<version>-linux-<arch>/mtg; --strip-components
       puts it straight in the working directory under its own name */
    const out = await run('tar', ['-xzf', tarball, '-C', work, '--strip-components=1',
      `mtg-${VERSION}-linux-${arch}/mtg`], 60000);
    if (!out.ok) throw new Error(`could not unpack mtg: ${(out.stderr || out.error || '').slice(0, 160)}`);

    const staged = path.join(work, 'mtg');
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    // copied then moved, so the binary never appears half-written on the path
    fs.copyFileSync(staged, `${BIN}.new`);
    fs.chmodSync(`${BIN}.new`, 0o755);
    fs.renameSync(`${BIN}.new`, BIN);

    const s = settings();
    s.version = VERSION;
    db.saveNow();
    return { ok: true, version: VERSION };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* a temp dir */ }
  }
}

module.exports = {
  /* the inbound list is the configuration; there is nothing else to set */
  inbounds, byId, status, statusOf, sync, fingerprint, resume, migrate,
  install, installed, startOne, stopOne, isRunning, diagnose, lastLog,
  tuning, TUNING, PREFER_IP, bindHost,
  makeSecret, domainOf, cleanDomain, linksFor, writeConfig, writeUnit,
  serviceOf, configOf, unitPathOf, tagOf, archKey,
  VERSION, SUMS, BIN, DIR, DEFAULT_DOMAIN, DEFAULT_PORT
};
