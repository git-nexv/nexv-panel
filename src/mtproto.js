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
const CONFIG = path.join(DIR, 'mtg.toml');
const SERVICE = 'nexv-mtproto';
const UNIT = `/etc/systemd/system/${SERVICE}.service`;

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

/** Where this lives in the store, with its defaults filled in. */
function settings() {
  const d = db.data;
  if (!d.mtproto || typeof d.mtproto !== 'object') d.mtproto = {};
  const s = d.mtproto;
  if (typeof s.enable !== 'boolean') s.enable = false;
  if (!(Number(s.port) > 0 && Number(s.port) < 65536)) s.port = DEFAULT_PORT;
  if (typeof s.domain !== 'string' || !s.domain) s.domain = DEFAULT_DOMAIN;
  if (typeof s.secret !== 'string') s.secret = '';
  if (typeof s.error !== 'string') s.error = '';
  if (typeof s.version !== 'string') s.version = '';
  return s;
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

/* ---------------------------------- run ---------------------------------- */

function writeConfig() {
  const s = settings();
  if (!s.secret) s.secret = makeSecret(s.domain);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  /* two required keys and nothing else. prefer-ip keeps it on IPv4, which is
     what a server with no working IPv6 needs and costs nothing where it has */
  const toml = [
    '# written by the NexV panel - edit it there, not here',
    `secret = "${s.secret}"`,
    `bind-to = "0.0.0.0:${Number(s.port)}"`,
    'prefer-ip = "prefer-ipv4"',
    ''
  ].join('\n');
  fs.writeFileSync(CONFIG, toml, { mode: 0o600 });
  db.saveNow();
  return CONFIG;
}

function writeUnit() {
  const unit = [
    '[Unit]',
    'Description=NexV Telegram proxy (MTProto)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${BIN} run ${CONFIG}`,
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
  fs.writeFileSync(UNIT, unit, { mode: 0o644 });
  return UNIT;
}

function hasSystemd() {
  return fs.existsSync(process.env.NEXV_SYSTEMD_DIR || '/run/systemd/system');
}

async function isRunning() {
  if (!hasSystemd()) return false;
  const out = await run('systemctl', ['is-active', '--quiet', SERVICE], 8000);
  return out.ok;
}

/** Put the config and the unit in place and start it. */
async function start() {
  const ready = await installed();
  if (!ready.ok) throw new Error('mtg is not installed yet');
  writeConfig();
  if (!hasSystemd()) throw new Error('this server has no systemd, so the proxy cannot be kept running');
  writeUnit();
  await run('systemctl', ['daemon-reload'], 15000);
  const on = await run('systemctl', ['enable', '--now', SERVICE], 30000);
  if (!on.ok) throw new Error((on.stderr || on.error || 'systemd would not start it').slice(0, 200));

  // the port has to be open or the proxy is running and unreachable
  try { await require('./firewall').allow(settings().port, 'tcp'); } catch (_) { /* said on its own page */ }
  return { ok: true };
}

async function stop() {
  if (!hasSystemd()) return { ok: true };
  await run('systemctl', ['disable', '--now', SERVICE], 30000);
  return { ok: true };
}

/** Everything the page shows about it. */
async function status() {
  const s = settings();
  const bin = await installed();
  const running = await isRunning();
  const host = String(db.settings.domain || db.settings.serverIP || '').trim();
  const links = s.secret && host ? linksFor(host, Number(s.port), s.secret) : { tg: '', https: '' };
  return {
    enable: !!s.enable,
    installed: bin.ok,
    version: bin.version || s.version || '',
    wantVersion: VERSION,
    running,
    port: Number(s.port),
    domain: s.domain,
    secret: s.secret,
    secretDomain: domainOf(s.secret),
    host,
    links,
    error: s.error || '',
    arch: archKey(),
    supported: !!archKey() && process.platform === 'linux',
    systemd: hasSystemd()
  };
}

/**
 * One call for everything the page can change.
 *
 * The order matters: a port or a domain that is rejected must not leave the
 * proxy running on the old one while the page shows the new one, so nothing is
 * written until all of it is valid.
 */
async function apply(changes) {
  const s = settings();
  const want = changes || {};

  let port = s.port;
  if (want.port !== undefined) {
    port = Math.round(Number(want.port));
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  }

  let domain = s.domain;
  if (want.domain !== undefined) {
    domain = cleanDomain(want.domain);
    if (!domain) throw new Error('that is not a domain name');
  }

  const domainChanged = domain !== s.domain;
  s.port = port;
  s.domain = domain;
  /* the domain lives inside the secret, so a new domain is a new secret and
     the old links stop working - said on the page, not discovered later */
  if (want.newSecret || domainChanged || !s.secret) s.secret = makeSecret(domain);
  if (want.enable !== undefined) s.enable = !!want.enable;
  s.error = '';
  db.saveNow();

  try {
    if (s.enable) {
      if (!(await installed()).ok) await install();
      await start();
    } else {
      await stop();
    }
  } catch (err) {
    s.error = err.message;
    db.saveNow();
    throw err;
  }
  return status();
}

/** Start it again after a panel restart, if it is meant to be on. */
async function resume() {
  const s = settings();
  if (!s.enable) return { started: false };
  if (await isRunning()) return { started: false, already: true };
  try {
    await start();
    return { started: true };
  } catch (err) {
    s.error = err.message;
    db.save();
    return { started: false, error: err.message };
  }
}

module.exports = {
  settings, status, apply, install, installed, start, stop, resume,
  makeSecret, domainOf, cleanDomain, linksFor, writeConfig, writeUnit,
  isRunning, archKey, VERSION, SUMS, BIN, DIR, CONFIG, SERVICE, UNIT,
  DEFAULT_DOMAIN, DEFAULT_PORT
};
