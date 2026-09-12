'use strict';
/**
 * Xray-core lifecycle: render config.json from the panel model, control the
 * systemd unit, and read per-client traffic counters back out of the stats API.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');

const XRAY_BIN = process.env.NEXV_XRAY_BIN || '/usr/local/bin/xray';
const XRAY_CONFIG = process.env.NEXV_XRAY_CONFIG || '/usr/local/etc/xray/config.json';
const XRAY_SERVICE = process.env.NEXV_XRAY_SERVICE || 'xray';
const API_PORT = 62789;

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
    });
  });
}

/** systemd is absent in some containers; degrade to config-only mode there. */
let systemdWarned = false;
function hasSystemd() {
  // the canonical check: systemd creates this directory only when it is PID 1
  const available = fs.existsSync('/run/systemd/system');
  if (!available && !systemdWarned) {
    systemdWarned = true;
    console.warn('[xray] systemd unavailable - config is written but the service is not managed');
  }
  return available;
}

function streamSettings(inb) {
  const net = inb.network || 'tcp';
  const s = { network: net, security: inb.security || 'none' };

  if (net === 'ws') {
    s.wsSettings = { path: inb.wsPath || '/' };
    if (inb.wsHost) s.wsSettings.host = inb.wsHost;
  } else if (net === 'grpc') {
    s.grpcSettings = { serviceName: inb.grpcServiceName || '', multiMode: !!inb.grpcMultiMode };
  } else if (net === 'httpupgrade') {
    s.httpupgradeSettings = { path: inb.wsPath || '/', host: inb.wsHost || '' };
  } else if (net === 'xhttp') {
    s.xhttpSettings = { path: inb.wsPath || '/', host: inb.wsHost || '', mode: inb.xhttpMode || 'auto' };
  } else {
    s.tcpSettings = { header: { type: 'none' } };
  }

  if (s.security === 'tls') {
    const cert = inb.certFile || db.settings.certFile;
    const key = inb.keyFile || db.settings.keyFile;
    s.tlsSettings = {
      serverName: inb.sni || db.settings.domain || '',
      alpn: net === 'grpc' ? ['h2'] : ['h2', 'http/1.1'],
      certificates: cert && key ? [{ certificateFile: cert, keyFile: key }] : []
    };
  } else if (s.security === 'reality') {
    const r = inb.reality || {};
    s.realitySettings = {
      show: false,
      dest: r.dest || 'www.cloudflare.com:443',
      xver: 0,
      serverNames: (r.serverNames && r.serverNames.length ? r.serverNames : ['www.cloudflare.com']),
      privateKey: r.privateKey || '',
      shortIds: (r.shortIds && r.shortIds.length ? r.shortIds : ['']),
      fingerprint: r.fingerprint || 'chrome'
    };
  }
  return s;
}

function inboundSettings(inb, clients) {
  const active = clients.filter((c) => c.enable !== false && !isExpired(c) && !isOverQuota(c));
  switch (inb.protocol) {
    case 'vless':
      return {
        clients: active.map((c) => ({ id: c.uuid, email: clientTag(c), flow: c.flow || '' })),
        decryption: 'none',
        fallbacks: inb.fallbacks || []
      };
    case 'vmess':
      return {
        clients: active.map((c) => ({ id: c.uuid, email: clientTag(c), alterId: 0 }))
      };
    case 'trojan':
      return {
        clients: active.map((c) => ({ password: c.password || c.uuid, email: clientTag(c) })),
        fallbacks: inb.fallbacks || []
      };
    case 'shadowsocks':
      return {
        method: inb.method || '2022-blake3-aes-128-gcm',
        password: inb.password || '',
        network: 'tcp,udp',
        // ss-2022 multi-user rejects a per-client method; the inbound-level one applies
        clients: active.map((c) => ({ password: c.password || c.uuid, email: clientTag(c) }))
      };
    default:
      return { clients: [] };
  }
}

/** Stats keys are per-email, so the tag must be unique across all inbounds. */
function clientTag(c) {
  return `${c.email}#${c.id.slice(0, 8)}`;
}

function isExpired(c) {
  return !!c.expiryTime && c.expiryTime > 0 && c.expiryTime < Date.now();
}

function isOverQuota(c) {
  if (!c.totalGB || c.totalGB <= 0) return false;
  return (c.up || 0) + (c.down || 0) >= c.totalGB * 1024 ** 3;
}

/** RFC1918 + loopback + link-local; keeps clients from reaching the server's own LAN. */
const PRIVATE_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '224.0.0.0/4', '240.0.0.0/4', '::1/128', 'fc00::/7', 'fe80::/10'
];

function buildConfig() {
  const d = db.data;
  const inbounds = [
    {
      tag: 'api',
      port: API_PORT,
      listen: '127.0.0.1',
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' }
    }
  ];

  for (const inb of d.inbounds) {
    if (inb.enable === false) continue;
    const clients = d.clients.filter((c) => c.inboundId === inb.id);
    inbounds.push({
      tag: inb.tag,
      listen: inb.listen || '0.0.0.0',
      port: Number(inb.port),
      protocol: inb.protocol,
      settings: inboundSettings(inb, clients),
      streamSettings: streamSettings(inb),
      sniffing: { enabled: inb.sniffing !== false, destOverride: ['http', 'tls', 'quic'] }
    });
  }

  return {
    log: { loglevel: d.settings.xrayLogLevel || 'warning' },
    api: { tag: 'api', services: ['HandlerService', 'StatsService', 'LoggerService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true }
    },
    inbounds,
    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'blocked', protocol: 'blackhole', settings: {} }
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        // explicit CIDRs rather than geoip:private, so the config never depends
        // on geoip.dat being present next to the binary
        { type: 'field', outboundTag: 'blocked', ip: PRIVATE_RANGES },
        { type: 'field', protocol: ['bittorrent'], outboundTag: d.settings.blockTorrent ? 'blocked' : 'direct' }
      ]
    }
  };
}

function writeConfig() {
  const cfg = buildConfig();
  fs.mkdirSync(path.dirname(XRAY_CONFIG), { recursive: true });
  fs.writeFileSync(XRAY_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

async function testConfig() {
  if (!fs.existsSync(XRAY_BIN)) return { ok: false, stderr: 'xray binary not found' };
  return run(XRAY_BIN, ['run', '-test', '-config', XRAY_CONFIG]);
}

/** Write the config, verify it parses, and reload the service. Rolls back on a bad config. */
async function apply() {
  let previous = null;
  if (fs.existsSync(XRAY_CONFIG)) previous = fs.readFileSync(XRAY_CONFIG, 'utf8');

  writeConfig();
  const test = await testConfig();
  if (!test.ok && fs.existsSync(XRAY_BIN)) {
    if (previous !== null) fs.writeFileSync(XRAY_CONFIG, previous, { mode: 0o600 });
    return { ok: false, error: test.stderr.trim() || 'invalid xray config' };
  }
  if (!hasSystemd()) return { ok: true, warning: 'systemd unavailable; xray was not restarted' };
  const restart = await run('systemctl', ['restart', XRAY_SERVICE], 30000);
  if (!restart.ok) return { ok: false, error: restart.stderr.trim() || 'failed to restart xray' };
  return { ok: true };
}

let versionCache = null;
/** The binary's version cannot change while the process runs, so read it once. */
async function xrayVersion() {
  if (versionCache !== null) return versionCache;
  if (!fs.existsSync(XRAY_BIN)) return '';
  // never execFileSync here: spawning the (large) xray binary can take seconds
  // on a small VPS and would block the event loop for every other request
  const res = await run(XRAY_BIN, ['version'], 8000);
  versionCache = res.ok ? (res.stdout.split('\n')[0] || '').trim() : '';
  return versionCache;
}

async function serviceStatus() {
  const active = hasSystemd()
    ? await run('systemctl', ['is-active', XRAY_SERVICE], 5000)
    : { stdout: 'unmanaged' };
  return {
    running: active.stdout.trim() === 'active',
    state: active.stdout.trim() || 'unknown',
    version: await xrayVersion()
  };
}

async function restart() { return run('systemctl', ['restart', XRAY_SERVICE], 30000); }
async function stop() { return run('systemctl', ['stop', XRAY_SERVICE], 30000); }
async function start() { return run('systemctl', ['start', XRAY_SERVICE], 30000); }

/**
 * Pull user counters from the stats API and fold them into stored totals.
 * `reset` makes Xray zero its counters, so each poll adds only the delta.
 */
async function collectTraffic() {
  if (!fs.existsSync(XRAY_BIN)) return { ok: false };
  const res = await run(XRAY_BIN, [
    'api', 'statsquery', `--server=127.0.0.1:${API_PORT}`, '-pattern=user>>>', '-reset'
  ], 10000);
  if (!res.ok) return { ok: false, error: res.stderr.trim() };

  let stat = [];
  try {
    stat = (JSON.parse(res.stdout || '{}').stat) || [];
  } catch (_) { return { ok: false, error: 'unparsable stats output' }; }

  const byTag = new Map();
  for (const row of stat) {
    // name looks like: user>>>email#abcd1234>>>traffic>>>uplink
    const m = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(row.name || '');
    if (!m) continue;
    const entry = byTag.get(m[1]) || { up: 0, down: 0 };
    entry[m[2] === 'uplink' ? 'up' : 'down'] += Number(row.value || 0);
    byTag.set(m[1], entry);
  }

  const d = db.data;
  let changed = false;
  for (const c of d.clients) {
    const delta = byTag.get(clientTag(c));
    if (!delta || (!delta.up && !delta.down)) continue;
    c.up = (c.up || 0) + delta.up;
    c.down = (c.down || 0) + delta.down;
    c.lastSeen = Date.now();
    changed = true;
  }
  if (changed) db.save();
  return { ok: true, count: byTag.size };
}

/** Disable clients that ran out of quota or time, then push a fresh config. */
async function enforceLimits() {
  const d = db.data;
  let dirty = false;
  for (const c of d.clients) {
    const shouldDisable = isExpired(c) || isOverQuota(c);
    if (shouldDisable && c.enable !== false && !c.autoDisabled) {
      c.autoDisabled = true;
      dirty = true;
    } else if (!shouldDisable && c.autoDisabled) {
      c.autoDisabled = false;
      dirty = true;
    }
  }
  if (dirty) {
    db.save();
    await apply();
  }
  return dirty;
}

async function generateReality() {
  const res = await run(XRAY_BIN, ['x25519'], 8000);
  if (!res.ok) throw new Error(res.stderr.trim() || 'xray x25519 failed');
  const out = res.stdout;
  // output wording differs across xray versions:
  //   old: "Private key: X" / "Public key: Y"
  //   new: "PrivateKey: X"  / "Password (PublicKey): Y"
  const priv = /Private\s*Key:\s*(\S+)/i.exec(out);
  const pub = /(?:Password\s*\(PublicKey\)|Public\s*Key|Password):\s*(\S+)/i.exec(out);
  if (!priv || !pub) throw new Error(`could not parse xray x25519 output: ${out.trim().slice(0, 120)}`);
  return { privateKey: priv[1], publicKey: pub[1] };
}

module.exports = {
  xrayVersion,
  XRAY_BIN, XRAY_CONFIG, XRAY_SERVICE, API_PORT,
  buildConfig, writeConfig, testConfig, apply, serviceStatus,
  restart, start, stop, collectTraffic, enforceLimits,
  clientTag, isExpired, isOverQuota, generateReality, run
};
