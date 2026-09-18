'use strict';
/**
 * Xray-core lifecycle: render config.json from the panel model, control the
 * systemd unit, and read per-client traffic counters back out of the stats API.
 */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const db = require('./db');
const certs = require('./certs');
const online = require('./online');

const XRAY_BIN = process.env.NEXV_XRAY_BIN || '/usr/local/bin/xray';
const XRAY_CONFIG = process.env.NEXV_XRAY_CONFIG || '/usr/local/etc/xray/config.json';
const NEXV_CLI = process.env.NEXV_CLI || '/usr/local/bin/nexv';
const ACCESS_LOG = process.env.NEXV_XRAY_ACCESS_LOG || '/var/log/xray/access.log';
const XRAY_SERVICE = process.env.NEXV_XRAY_SERVICE || 'xray';
const API_PORT = 62789;

/** Inbound protocols the panel can configure. */
const INBOUND_PROTOCOLS = [
  'vless', 'vmess', 'trojan', 'shadowsocks',
  'socks', 'http', 'dokodemo-door', 'wireguard'
];

/** Outbound protocols the panel can configure. */
const OUTBOUND_PROTOCOLS = [
  'freedom', 'blackhole', 'dns',
  'vless', 'vmess', 'trojan', 'shadowsocks',
  'socks', 'http', 'wireguard'
];

/** Protocols that carry per-user accounts, so the Clients page applies to them. */
const CLIENT_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'wireguard'];

/** Protocols whose clients get a shareable subscription link. */
const LINK_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks'];

function run(cmd, args, timeout = 15000, env = null) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', env: env || process.env }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        failure: err ? err.message : ''
      });
    });
  });
}

/**
 * What actually went wrong, in words.
 *
 * Xray prints the reason a config was rejected on stdout, not stderr, so
 * reporting stderr alone left the panel showing Node's own
 * "Command failed: /usr/local/bin/xray run -test ..." - which says nothing at
 * all. The reason is the line that names it, usually the last one.
 */
function messageOf(result) {
  const lines = `${result.stdout || ''}\n${result.stderr || ''}`
    .split('\n')
    .map((line) => line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, '').trim())
    .filter(Boolean);

  const blamed = lines.filter((line) => /failed|error|panic|denied|invalid|unable|refus/i.test(line));
  const best = blamed[blamed.length - 1] || lines[lines.length - 1] || '';
  // "Failed to start: main: failed to load config files: [...] > the real reason"
  const detail = best.includes(' > ') ? best.slice(best.lastIndexOf(' > ') + 3).trim() : best;
  return (detail || result.failure || '').slice(0, 300);
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

/**
 * TLS for an inbound. A certificate is taken either from files on disk or
 * pasted inline; inline wins when present, because someone who pasted a
 * certificate meant to use it.
 */
function tlsSettings(inb, net) {
  const alpn = (inb.alpn && inb.alpn.length)
    ? inb.alpn
    : (net === 'grpc' ? ['h2'] : ['h2', 'http/1.1']);

  const certificate = () => {
    const base = {
      ocspStapling: Number(inb.ocspStapling || 0),
      usage: inb.certUsage || 'encipherment',
      oneTimeLoading: !!inb.certOneTimeLoading
    };
    // only meaningful when the certificate is being issued by xray itself
    if (base.usage === 'issue' && inb.certBuildChain) base.buildChain = true;
    if (inb.certContent && inb.keyContent) {
      return [Object.assign(base, {
        certificate: String(inb.certContent).split('\n'),
        key: String(inb.keyContent).split('\n')
      })];
    }
    const cert = inb.certFile || db.settings.certFile;
    const key = inb.keyFile || db.settings.keyFile;
    if (!cert || !key) return [];
    /* xray may not be allowed to open the file the admin named; hand it a copy
       it can read rather than a path that dies at startup */
    const usable = certs.forXray(cert, key, serviceOwner());
    return [Object.assign(base, { certificateFile: usable.cert, keyFile: usable.key })];
  };

  const out = {
    serverName: inb.sni || db.settings.domain || '',
    minVersion: inb.tlsMinVersion || '1.2',
    maxVersion: inb.tlsMaxVersion || '1.3',
    rejectUnknownSni: !!inb.rejectUnknownSni,
    alpn,
    certificates: certificate()
  };
  if (inb.cipherSuites) out.cipherSuites = inb.cipherSuites;
  if (inb.curvePreferences && inb.curvePreferences.length) out.curvePreferences = inb.curvePreferences;
  if (inb.masterKeyLog) out.masterKeyLog = inb.masterKeyLog;
  if (inb.echServerKeys) out.echServerKeys = inb.echServerKeys;
  if (inb.disableSystemRoot) out.disableSystemRoot = true;
  if (inb.enableSessionResumption) out.enableSessionResumption = true;
  if (inb.verifyPeerCertInNames) {
    out.verifyPeerCertInNames = String(inb.verifyPeerCertInNames)
      .split(',').map((n) => n.trim()).filter(Boolean);
  }
  if (inb.echForceQuery) out.echForceQuery = inb.echForceQuery;
  if (inb.fingerprint || inb.echConfigList || inb.tlsAllowInsecure) {
    out.settings = {};
    if (inb.fingerprint) out.settings.fingerprint = inb.fingerprint;
    if (inb.echConfigList) out.settings.echConfigList = inb.echConfigList;
    if (inb.tlsAllowInsecure) out.settings.allowInsecure = true;
  }
  return out;
}

/**
 * Headers, in the two shapes Xray actually wants.
 *
 * They are not the same shape, which is easy to get wrong and impossible to
 * guess: the HTTP disguise on a raw TCP inbound takes {name: [value]}, because
 * a disguised request may repeat a header; websocket, httpupgrade and xhttp
 * take {name: value}, a plain string, and reject the array outright. Both are
 * built from the same list of {name, value} rows the form collects.
 */
function headerRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ name: String((row && row.name) || '').trim(), value: String((row && row.value) || '') }))
    .filter((row) => row.name);
}

/** {name: [value]} - the TCP disguise only. */
function headerObject(rows) {
  const out = {};
  for (const row of headerRows(rows)) out[row.name] = [row.value];
  return out;
}

/** {name: value} - websocket, httpupgrade and xhttp. */
function headerMap(rows) {
  const out = {};
  for (const row of headerRows(rows)) out[row.name] = row.value;
  return out;
}

/** Only the keys somebody actually filled in; Xray has its own defaults. */
function pruned(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || Number.isNaN(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Low-level socket options, the ones that are set on the listening socket
 * rather than on the protocol. Written only when the switch is on, because an
 * empty sockopt block changes Xray's behaviour on some of these.
 */
function sockoptSettings(inb) {
  const o = inb.sockopt || {};
  if (!inb.sockoptEnabled) return null;
  const out = pruned({
    mark: Number(o.mark) || undefined,
    tcpKeepAliveInterval: Number(o.tcpKeepAliveInterval) || undefined,
    tcpKeepAliveIdle: Number(o.tcpKeepAliveIdle) || undefined,
    tcpMaxSeg: Number(o.tcpMaxSeg) || undefined,
    tcpUserTimeout: Number(o.tcpUserTimeout) || undefined,
    tcpWindowClamp: Number(o.tcpWindowClamp) || undefined,
    domainStrategy: o.domainStrategy || undefined,
    tcpcongestion: o.tcpcongestion || undefined,
    tproxy: o.tproxy && o.tproxy !== 'off' ? o.tproxy : undefined,
    dialerProxy: o.dialerProxy || undefined,
    interfaceName: o.interfaceName || undefined
  });
  // switches are written even when false only if they were turned on once
  if (o.acceptProxyProtocol) out.acceptProxyProtocol = true;
  if (o.tcpFastOpen) out.tcpFastOpen = true;
  if (o.tcpMptcp) out.tcpMptcp = true;
  if (o.penetrate) out.penetrate = true;
  if (o.V6Only) out.V6Only = true;
  return Object.keys(out).length ? out : null;
}

/** The HTTP disguise on a raw TCP inbound: a request and a response shape. */
function tcpHeader(inb) {
  if (inb.tcpType !== 'http') return { type: 'none' };
  const req = inb.tcpRequest || {};
  const res = inb.tcpResponse || {};
  const paths = Array.isArray(req.path) ? req.path.filter(Boolean) : [];
  return {
    type: 'http',
    request: {
      version: req.version || '1.1',
      method: req.method || 'GET',
      path: paths.length ? paths : ['/'],
      headers: headerObject(req.headers)
    },
    response: {
      version: res.version || '1.1',
      status: String(res.status || '200'),
      reason: res.reason || 'OK',
      headers: headerObject(res.headers)
    }
  };
}

function streamSettings(inb) {
  const net = inb.network || 'tcp';
  const s = { network: net, security: inb.security || 'none' };

  if (net === 'ws') {
    s.wsSettings = { path: inb.wsPath || '/' };
    if (inb.wsHost) s.wsSettings.host = inb.wsHost;
    if (inb.wsAcceptProxyProtocol) s.wsSettings.acceptProxyProtocol = true;
    if (Number(inb.wsHeartbeatPeriod)) s.wsSettings.heartbeatPeriod = Number(inb.wsHeartbeatPeriod);
    const headers = headerMap(inb.wsHeaders);
    if (Object.keys(headers).length) s.wsSettings.headers = headers;
  } else if (net === 'grpc') {
    s.grpcSettings = { serviceName: inb.grpcServiceName || '', multiMode: !!inb.grpcMultiMode };
    if (inb.grpcAuthority) s.grpcSettings.authority = inb.grpcAuthority;
  } else if (net === 'httpupgrade') {
    s.httpupgradeSettings = { path: inb.wsPath || '/', host: inb.wsHost || '' };
    if (inb.wsAcceptProxyProtocol) s.httpupgradeSettings.acceptProxyProtocol = true;
    const headers = headerMap(inb.wsHeaders);
    if (Object.keys(headers).length) s.httpupgradeSettings.headers = headers;
  } else if (net === 'xhttp') {
    s.xhttpSettings = { path: inb.wsPath || '/', host: inb.wsHost || '', mode: inb.xhttpMode || 'auto' };
    // all optional; xray falls back to its own defaults when they are absent
    if (inb.xhttpMaxUploadSize) s.xhttpSettings.scMaxEachPostBytes = String(inb.xhttpMaxUploadSize);
    if (inb.xhttpMaxBufferedUpload) s.xhttpSettings.scMaxBufferedPosts = Number(inb.xhttpMaxBufferedUpload);
    if (inb.xhttpMinUploadInterval) s.xhttpSettings.scMinPostsIntervalMs = String(inb.xhttpMinUploadInterval);
    if (inb.xhttpMaxHeaderBytes) s.xhttpSettings.headerBytes = Number(inb.xhttpMaxHeaderBytes);
    if (inb.xhttpStreamUpServerSecs) s.xhttpSettings.scStreamUpServerSecs = String(inb.xhttpStreamUpServerSecs);
    if (inb.xhttpPaddingBytes) s.xhttpSettings.xPaddingBytes = String(inb.xhttpPaddingBytes);
    if (inb.xhttpNoSSEHeader) s.xhttpSettings.noSSEHeader = true;
    const headers = headerMap(inb.wsHeaders);
    if (Object.keys(headers).length) s.xhttpSettings.headers = headers;
  } else if (net === 'kcp') {
    s.kcpSettings = Object.assign(
      { seed: inb.kcpSeed || '', header: { type: inb.kcpHeader || 'none' } },
      pruned({
        mtu: Number(inb.kcpMtu) || undefined,
        tti: Number(inb.kcpTti) || undefined,
        uplinkCapacity: Number(inb.kcpUplink) || undefined,
        downlinkCapacity: Number(inb.kcpDownlink) || undefined,
        readBufferSize: Number(inb.kcpReadBuffer) || undefined,
        writeBufferSize: Number(inb.kcpWriteBuffer) || undefined
      })
    );
    // congestion is a boolean, so it cannot go through pruned()
    if (inb.kcpCongestion) s.kcpSettings.congestion = true;
  } else {
    s.tcpSettings = { header: tcpHeader(inb) };
    if (inb.tcpAcceptProxyProtocol) s.tcpSettings.acceptProxyProtocol = true;
  }

  const sockopt = sockoptSettings(inb);
  if (sockopt) s.sockopt = sockopt;

  if (s.security === 'tls') {
    s.tlsSettings = tlsSettings(inb, net);
  } else if (s.security === 'reality') {
    const r = inb.reality || {};
    s.realitySettings = {
      show: !!r.show,
      dest: r.dest || 'www.cloudflare.com:443',
      xver: Number(r.xver) || 0,
      serverNames: (r.serverNames && r.serverNames.length ? r.serverNames : ['www.cloudflare.com']),
      privateKey: r.privateKey || '',
      shortIds: (r.shortIds && r.shortIds.length ? r.shortIds : ['']),
      fingerprint: r.fingerprint || 'chrome'
    };
    Object.assign(s.realitySettings, pruned({
      maxTimeDiff: Number(r.maxTimeDiff) || undefined,
      minClientVer: r.minClientVer || undefined,
      maxClientVer: r.maxClientVer || undefined,
      spiderX: r.spiderX || undefined,
      mldsa65Seed: r.mldsa65Seed || undefined
    }));
  }
  return s;
}

function inboundSettings(inb, clients) {
  const active = clients.filter((c) => c.enable !== false
    && !isExpired(c) && !isOverQuota(c) && !isOverIpLimit(c));
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
    case 'shadowsocks': {
      /*
       * The two families want the cipher in different places, and getting it
       * wrong is not a warning - Xray refuses to start with "unsupported cipher
       * method:" and an empty name. ss-2022 takes it on the inbound and rejects
       * it on a client; everything older takes it on each client and ignores
       * the inbound's.
       */
      const method = inb.method || '2022-blake3-aes-128-gcm';
      const is2022 = method.startsWith('2022-');
      return {
        method,
        password: inb.password || '',
        network: inb.ssNetwork || 'tcp,udp',
        ivCheck: !!inb.ssIvCheck,
        clients: active.map((c) => {
          const entry = { password: c.password || c.uuid, email: clientTag(c) };
          if (!is2022) entry.method = method;
          return entry;
        })
      };
    }
    case 'socks':
      // with no accounts the inbound would be an open proxy, so require auth
      return {
        auth: active.length ? 'password' : 'noauth',
        accounts: active.map((c) => ({ user: c.email, pass: c.password || c.uuid })),
        udp: inb.udp !== false,
        ip: inb.udp !== false ? (inb.listen && inb.listen !== '0.0.0.0' ? inb.listen : '127.0.0.1') : undefined
      };
    case 'http':
      return {
        accounts: active.map((c) => ({ user: c.email, pass: c.password || c.uuid })),
        allowTransparent: !!inb.allowTransparent
      };
    case 'dokodemo-door': {
      const out = {
        address: inb.targetAddress || '127.0.0.1',
        port: Number(inb.targetPort || 0) || undefined,
        network: inb.targetNetwork || 'tcp,udp',
        followRedirect: !!inb.followRedirect
      };
      /* port -> address, for forwarding a range of ports to different places */
      const map = {};
      for (const row of (inb.portMap || [])) {
        const from = String((row && row.name) || '').trim();
        if (from) map[from] = String((row && row.value) || '');
      }
      if (Object.keys(map).length) out.portMap = map;
      return out;
    }
    case 'wireguard': {
      const out = {
        secretKey: inb.wgPrivateKey || '',
        mtu: Number(inb.wgMtu || 1420),
        peers: active.map((c) => {
          const peer = {
            publicKey: c.wgPublicKey || '',
            allowedIPs: (c.wgAllowedIPs && c.wgAllowedIPs.length)
              ? c.wgAllowedIPs
              : ['0.0.0.0/0', '::/0']
          };
          if (c.wgPresharedKey) peer.preSharedKey = c.wgPresharedKey;
          if (Number(c.wgKeepAlive)) peer.keepAlive = Number(c.wgKeepAlive);
          return peer;
        }).filter((p) => p.publicKey)
      };
      if (inb.wgNoKernelTun) out.noKernelTun = true;
      return out;
    }
    default:
      return { clients: [] };
  }
}

/**
 * The stream settings of an OUTBOUND, which are not the stream settings of an
 * inbound wearing a different hat.
 *
 * This was the bug behind "outbounds do not work". An outbound was rendered
 * with streamSettings(), the function that builds the listening side: for TLS
 * it emitted a certificate list, and for REALITY the server's own private key,
 * dest and serverNames. Xray wants the opposite of each - the name to ask for,
 * the peer's public key, one short id - so an outbound pointed at a REALITY
 * inbound on another server could not connect at all, whatever was typed into
 * it. The two sides are written out separately now.
 */
function outboundStream(out) {
  const net = out.network || 'tcp';
  const security = out.security || 'none';
  const s = { network: net, security };

  if (net === 'ws') {
    s.wsSettings = { path: out.wsPath || '/' };
    if (out.wsHost) s.wsSettings.headers = { Host: out.wsHost };
  } else if (net === 'httpupgrade') {
    s.httpupgradeSettings = { path: out.wsPath || '/' };
    if (out.wsHost) s.httpupgradeSettings.host = out.wsHost;
  } else if (net === 'xhttp') {
    s.xhttpSettings = { path: out.wsPath || '/', mode: out.xhttpMode || 'auto' };
    if (out.wsHost) s.xhttpSettings.host = out.wsHost;
  } else if (net === 'grpc') {
    s.grpcSettings = { serviceName: out.grpcServiceName || '' };
    if (out.grpcMultiMode) s.grpcSettings.multiMode = true;
  } else if (net === 'kcp') {
    s.kcpSettings = { header: { type: out.kcpHeader || 'none' } };
    if (out.kcpSeed) s.kcpSettings.seed = out.kcpSeed;
  }

  if (security === 'tls') {
    s.tlsSettings = {
      serverName: out.sni || out.address || '',
      fingerprint: out.fingerprint || 'chrome',
      allowInsecure: !!out.allowInsecure
    };
    if (out.alpn && out.alpn.length) s.tlsSettings.alpn = out.alpn;
  } else if (security === 'reality') {
    s.realitySettings = {
      serverName: out.sni || '',
      fingerprint: out.fingerprint || 'chrome',
      publicKey: out.realityPublicKey || '',
      shortId: out.realityShortId || '',
      spiderX: out.realitySpiderX || '/'
    };
  }
  return s;
}

/** Render one stored outbound into the shape xray expects. */
function outboundConfig(out) {
  const stream = () => {
    const s = outboundStream(out);
    // an outbound with plain tcp and no security needs no streamSettings at all
    if (s.network === 'tcp' && s.security === 'none') return undefined;
    return s;
  };
  const host = out.address || '';
  const port = Number(out.port || 0);

  switch (out.protocol) {
    case 'freedom':
      return {
        tag: out.tag,
        protocol: 'freedom',
        settings: {
          domainStrategy: out.domainStrategy || 'AsIs',
          redirect: out.redirect || undefined
        }
      };
    case 'blackhole':
      return {
        tag: out.tag,
        protocol: 'blackhole',
        settings: { response: { type: out.blackholeResponse || 'none' } }
      };
    case 'dns':
      return { tag: out.tag, protocol: 'dns', settings: {} };
    case 'vless':
      return {
        tag: out.tag,
        protocol: 'vless',
        settings: {
          vnext: [{
            address: host,
            port,
            users: [{ id: out.uuid || '', encryption: 'none', flow: out.flow || '' }]
          }]
        },
        streamSettings: stream()
      };
    case 'vmess':
      return {
        tag: out.tag,
        protocol: 'vmess',
        settings: {
          vnext: [{ address: host, port, users: [{ id: out.uuid || '', alterId: 0, security: out.encryption || 'auto' }] }]
        },
        streamSettings: stream()
      };
    case 'trojan':
      return {
        tag: out.tag,
        protocol: 'trojan',
        settings: { servers: [{ address: host, port, password: out.password || '' }] },
        streamSettings: stream()
      };
    case 'shadowsocks':
      return {
        tag: out.tag,
        protocol: 'shadowsocks',
        settings: {
          servers: [{
            address: host,
            port,
            method: out.method || 'aes-256-gcm',
            password: out.password || '',
            uot: !!out.uot
          }]
        },
        streamSettings: stream()
      };
    case 'socks':
      return {
        tag: out.tag,
        protocol: 'socks',
        settings: {
          servers: [Object.assign(
            { address: host, port },
            out.username ? { users: [{ user: out.username, pass: out.password || '' }] } : {}
          )]
        },
        streamSettings: stream()
      };
    case 'http':
      return {
        tag: out.tag,
        protocol: 'http',
        settings: {
          servers: [Object.assign(
            { address: host, port },
            out.username ? { users: [{ user: out.username, pass: out.password || '' }] } : {}
          )]
        },
        streamSettings: stream()
      };
    case 'wireguard':
      return {
        tag: out.tag,
        protocol: 'wireguard',
        settings: {
          secretKey: out.wgPrivateKey || '',
          address: (out.wgAddress && out.wgAddress.length) ? out.wgAddress : ['10.0.0.2/32'],
          mtu: Number(out.wgMtu || 1420),
          peers: [{
            publicKey: out.wgPeerPublicKey || '',
            endpoint: host && port ? `${host}:${port}` : '',
            allowedIPs: ['0.0.0.0/0', '::/0'],
            preSharedKey: out.wgPreSharedKey || undefined
          }]
        }
      };
    default:
      return null;
  }
}

/** Turn a stored routing rule into an xray routing rule, dropping empty fields. */
function routingRule(rule) {
  const list = (value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    const parts = String(value || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  };
  const out = {
    type: 'field',
    outboundTag: rule.outboundTag || 'direct',
    domain: list(rule.domain),
    ip: list(rule.ip),
    port: rule.port ? String(rule.port) : undefined,
    sourcePort: rule.sourcePort ? String(rule.sourcePort) : undefined,
    network: rule.network || undefined,
    protocol: list(rule.protocol),
    source: list(rule.source),
    user: list(rule.user),
    inboundTag: list(rule.inboundTag)
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  // a rule with no condition would swallow every connection
  const hasCondition = ['domain', 'ip', 'port', 'sourcePort', 'network', 'protocol', 'source', 'user', 'inboundTag']
    .some((key) => out[key] !== undefined);
  return hasCondition ? out : null;
}

/** Stats keys are per-email, so the tag must be unique across all inbounds. */
/**
 * Can Xray write its access log where we expect it?
 *
 * Pointing `log.access` at a path the service user cannot write makes Xray
 * refuse to start, so this never assumes: the directory is created when the
 * panel runs as root, and the setting is skipped entirely when it cannot be.
 */
function accessLogUsable() {
  const dir = path.dirname(ACCESS_LOG);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

/** Make the log directory, owned by whoever xray runs as. Best effort. */
async function ensureAccessLog() {
  const dir = path.dirname(ACCESS_LOG);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    if (!fs.existsSync(ACCESS_LOG)) fs.writeFileSync(ACCESS_LOG, '', { mode: 0o644 });
    const user = await serviceUser();
    if (user && user !== 'root' && process.getuid && process.getuid() === 0) {
      await run('chown', ['-R', `${user}:`, dir], 8000);
    }
    return accessLogUsable();
  } catch (err) {
    console.error('[xray] cannot prepare the access log:', err.message);
    return false;
  }
}

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

/**
 * An inbound can carry a cap and an expiry of its own, the way 3x-ui's does.
 *
 * It is not the sum of its clients' caps: it is the port itself going quiet -
 * useful for a trial inbound, or a box rented by the month. The same two tests
 * a client gets, against the inbound's own figures.
 */
function inboundDead(inb) {
  if (isExpired(inb)) return 'expired';
  if (isOverQuota(inb)) return 'out of quota';
  return '';
}

/**
 * More places at once than this client is allowed.
 *
 * The field has been on the client form all along and did nothing whatsoever -
 * a limit the panel collected, displayed, and never applied. It counts the
 * addresses seen in the last five minutes, which is the same list the Clients
 * page shows behind the green dot, so what disables an account is exactly what
 * the admin can see. Zero means no limit, and that is the default.
 */
function isOverIpLimit(c) {
  const limit = Number(c.limitIp || 0);
  if (!limit || limit <= 0) return false;
  /* addresses on the allowlist do not count towards the limit: one shared
     office address is one address to the server and thirty people to whoever
     is paying, and without this a limit of two is unusable behind any NAT */
  const netfilter = require('./netfilter');
  /* the list holds a record per address, not a bare string; passing the whole
     record to the allowlist stringified it to "[object Object]", which matches
     no rule anybody could write, so the allowlist never once exempted anything */
  const seen = online.forTag(clientTag(c)).ips.filter((entry) => !netfilter.ipLimitExempt(entry.ip));
  return seen.length > limit;
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
    // an inbound past its own expiry or cap stops listening, like a dead client
    if (inboundDead(inb)) continue;
    const clients = d.clients.filter((c) => c.inboundId === inb.id);
    const entry = {
      tag: inb.tag,
      listen: inb.listen || '0.0.0.0',
      port: Number(inb.port),
      protocol: inb.protocol,
      settings: inboundSettings(inb, clients),
      sniffing: {
        enabled: inb.sniffing !== false,
        destOverride: (inb.sniffDestOverride && inb.sniffDestOverride.length)
          ? inb.sniffDestOverride
          : ['http', 'tls', 'quic'],
        metadataOnly: !!inb.sniffMetadataOnly,
        routeOnly: !!inb.sniffRouteOnly
      }
    };
    // wireguard and dokodemo-door carry no transport of their own
    if (inb.protocol !== 'wireguard') entry.streamSettings = streamSettings(inb);
    inbounds.push(entry);
  }

  const builtin = [
    { tag: 'direct', protocol: 'freedom', settings: {} },
    { tag: 'blocked', protocol: 'blackhole', settings: {} }
  ];
  const custom = [];
  for (const out of (d.outbounds || [])) {
    if (out.enable === false) continue;
    const rendered = outboundConfig(out);
    if (rendered) custom.push(rendered);
  }

  // the first outbound is xray's default for traffic no rule matched
  const defaultTag = d.settings.defaultOutbound || 'direct';
  const outbounds = [...builtin, ...custom];
  const defaultIdx = outbounds.findIndex((o) => o.tag === defaultTag);
  if (defaultIdx > 0) outbounds.unshift(outbounds.splice(defaultIdx, 1)[0]);

  const rules = [
    { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
    // explicit CIDRs rather than geoip:private, so the config never depends
    // on geoip.dat being present next to the binary
    { type: 'field', outboundTag: 'blocked', ip: PRIVATE_RANGES }
  ];
  for (const rule of (d.routing || [])) {
    if (rule.enable === false) continue;
    const rendered = routingRule(rule);
    if (rendered) rules.push(rendered);
  }
  if (d.settings.blockTorrent) {
    rules.push({ type: 'field', protocol: ['bittorrent'], outboundTag: 'blocked' });
  }

  return {
    // the access log is the only place a client's source address appears, so it
    // is what "who is online, and from which IP" is read from
    log: Object.assign(
      { loglevel: d.settings.xrayLogLevel || 'warning' },
      d.settings.trackIps === false || !accessLogUsable() ? {} : { access: ACCESS_LOG }
    ),
    api: { tag: 'api', services: ['HandlerService', 'StatsService', 'LoggerService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true }
    },
    inbounds,
    outbounds,
    routing: { domainStrategy: d.settings.domainStrategy || 'AsIs', rules }
  };
}
function writeConfig() {
  const cfg = buildConfig();
  fs.mkdirSync(path.dirname(XRAY_CONFIG), { recursive: true });
  fs.writeFileSync(XRAY_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

/** The user systemd starts xray as - usually `nobody`, sometimes root. */
let serviceUserCache = null;
async function serviceUser() {
  if (serviceUserCache !== null) return serviceUserCache;
  const res = await run('systemctl', ['show', XRAY_SERVICE, '-p', 'User', '--value'], 5000);
  serviceUserCache = (res.ok ? res.stdout.trim() : '') || 'root';
  return serviceUserCache;
}

/*
 * The same answer, but available while the config is being built - which is
 * synchronous, and has to know whether the certificate needs a readable copy.
 * Both spellings share the one cache, so this asks systemd at most once.
 */
let serviceOwnerCache = null;
function serviceOwner() {
  if (serviceOwnerCache) return serviceOwnerCache;
  if (serviceUserCache === null && process.env.NEXV_XRAY_USER) {
    serviceUserCache = process.env.NEXV_XRAY_USER;
  }
  if (serviceUserCache === null) {
    try {
      const out = execFileSync('systemctl', ['show', XRAY_SERVICE, '-p', 'User', '--value'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      });
      serviceUserCache = out.trim() || 'root';
    } catch (_) {
      // no systemd, or no such unit: nothing is dropping privileges either
      serviceUserCache = 'root';
    }
  }
  serviceOwnerCache = { user: serviceUserCache, gid: groupIdOf(serviceUserCache) };
  return serviceOwnerCache;
}

/** The primary group of an account, straight out of /etc/passwd. */
function groupIdOf(user) {
  if (!user || user === 'root') return 0;
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8')
      .split('\n').find((l) => l.startsWith(`${user}:`));
    const gid = line ? Number(line.split(':')[3]) : NaN;
    return Number.isFinite(gid) ? gid : null;
  } catch (_) {
    return null;
  }
}

/**
 * Validate the config the way the service will load it.
 *
 * Running the test as root hides the most common TLS failure there is: the
 * certificate lives under /etc/letsencrypt, which is root-only, while xray
 * runs as `nobody`. Root passes the test, the service then dies on
 * "permission denied", and the panel believes it wrote a good config.
 */
async function testConfig() {
  if (!fs.existsSync(XRAY_BIN)) return { ok: false, stderr: '', message: 'xray binary not found' };
  const user = await serviceUser();
  if (user && user !== 'root' && process.getuid && process.getuid() === 0) {
    const asUser = await run('runuser', ['-u', user, '--', XRAY_BIN, 'run', '-test', '-config', XRAY_CONFIG]);
    // runuser may be missing on minimal images; fall back rather than block
    if (asUser.ok || !/runuser|No such file/i.test(asUser.stderr)) {
      return Object.assign(asUser, { message: asUser.ok ? '' : messageOf(asUser) });
    }
  }
  const asRoot = await run(XRAY_BIN, ['run', '-test', '-config', XRAY_CONFIG]);
  return Object.assign(asRoot, { message: asRoot.ok ? '' : messageOf(asRoot) });
}

/**
 * Hand the certificate to the user xray runs as.
 *
 * A certificate under /etc/letsencrypt is root-only while xray runs as
 * `nobody`, which is the most common reason it dies and stays dead. The nexv
 * CLI already knows how to make a readable copy and repoint the inbounds at
 * it, so the panel calls that rather than keeping a second copy of the logic.
 */
async function repairCerts() {
  if (!fs.existsSync(NEXV_CLI)) return { ok: false, message: 'the nexv command is not installed' };
  // nothing is there to answer its questions, so it must not ask any
  const result = await run(NEXV_CLI, ['cert-fix'], 60000, { ...process.env, NEXV_ASSUME_YES: '1' });
  return { ok: result.ok, message: result.ok ? '' : messageOf(result) };
}

/** Write the config, verify it parses, and reload the service. Rolls back on a bad config. */
async function apply() {
  let previous = null;
  if (fs.existsSync(XRAY_CONFIG)) previous = fs.readFileSync(XRAY_CONFIG, 'utf8');

  writeConfig();
  let test = await testConfig();

  /*
   * A certificate the service user cannot read is a permissions problem with a
   * known fix, and the config writer has already applied it: every such file is
   * mirrored somewhere readable. Force the mirror to be rebuilt - the copy can
   * predate a renewal, or have been deleted - and test once more before giving
   * up. This used to shell out to `nexv cert-fix`, which restarts the panel:
   * the request that triggered it died with the service that was serving it.
   */
  if (!test.ok && /permission denied/i.test(test.message || '')) {
    certs.refresh();
    writeConfig();
    test = await testConfig();
  }

  if (!test.ok && fs.existsSync(XRAY_BIN)) {
    if (previous !== null) fs.writeFileSync(XRAY_CONFIG, previous, { mode: 0o600 });
    return { ok: false, error: test.message || test.stderr.trim() || 'invalid xray config' };
  }
  if (!hasSystemd()) return { ok: true, warning: 'systemd unavailable; xray was not restarted' };

  const restart = await run('systemctl', ['restart', XRAY_SERVICE], 30000);
  if (restart.ok) return { ok: true };

  /*
   * `xray run -test` only parses the config; it cannot know that a port is
   * already taken. Such a config passes the test and then kills the service on
   * start - and until now it stayed on disk, so every later `systemctl start`
   * failed too and xray looked permanently dead. Put the working config back
   * and bring the service up on it, then report the failure.
   */
  if (previous !== null) {
    fs.writeFileSync(XRAY_CONFIG, previous, { mode: 0o600 });
    const recovered = await run('systemctl', ['restart', XRAY_SERVICE], 30000);
    const detail = await lastServiceError();
    return {
      ok: false,
      error: `${detail || messageOf(restart) || 'xray failed to start'}${recovered.ok ? ' (previous configuration restored)' : ''}`
    };
  }
  return { ok: false, error: (await lastServiceError()) || messageOf(restart) || 'failed to restart xray' };
}

/** The journal line that actually says why xray refused to start. */
async function lastServiceError() {
  const log = await run('journalctl', ['-u', XRAY_SERVICE, '-n', '25', '--no-pager'], 8000);
  if (!log.ok) return '';
  const lines = log.stdout.split('\n').filter((l) => /failed|error|address already in use|panic/i.test(l));
  const line = lines[lines.length - 1] || '';
  // strip the syslog prefix, keep the part a human needs
  return line.replace(/^.*?(?:xray\[\d+\]|systemd\[\d+\]):\s*/, '').trim().slice(0, 200);
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
/* Per-client rate from the last window; in memory, never written to disk. */
const rates = new Map();
let lastCollect = 0;

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
  const now = Date.now();
  // every poll asks for the counters and resets them, so what comes back is
  // the traffic of one window - divide by the window and that is the rate
  const window = lastCollect ? Math.max(1, (now - lastCollect) / 1000) : 0;
  let changed = false;

  for (const c of d.clients) {
    const delta = byTag.get(clientTag(c));
    if (!delta || (!delta.up && !delta.down)) {
      rates.delete(c.id);
      continue;
    }
    c.up = (c.up || 0) + delta.up;
    c.down = (c.down || 0) + delta.down;

    /*
     * First traffic on a client sold with the clock unwound: this is the
     * moment it was actually used, so this is when its month starts. Traffic
     * rather than a connection, because an app that is merely added to and
     * never opened still opens a connection or two.
     */
    if (c.startAfterFirstUse && !c.expiryTime && c.expiryDays > 0) {
      c.expiryTime = now + c.expiryDays * 86400000;
      c.startedAt = now;
      d.logs.unshift({
        at: now,
        type: 'client',
        message: `${c.email} was used for the first time - its ${c.expiryDays} days start now`
      });
      if (d.logs.length > 500) d.logs.length = 500;
    }

    c.lastSeen = now;
    if (window) {
      rates.set(c.id, { up: delta.up / window, down: delta.down / window, at: now });
    }
    changed = true;
  }
  lastCollect = now;
  if (changed) db.save();
  return { ok: true, count: byTag.size };
}

/** The rate a client was moving at over the last window, in bytes per second. */
function rateFor(clientId) {
  const entry = rates.get(clientId);
  if (!entry || Date.now() - entry.at > 90000) return { up: 0, down: 0 };
  return { up: entry.up, down: entry.down };
}

/*
 * Say so once, not once a minute: an account being shared flips over and back
 * as addresses age out of the five-minute window, and a log full of the same
 * line is a log nobody reads.
 */
const toldAbout = new Map();
const TELL_AGAIN = 60 * 60 * 1000;

function noteOverIpLimit(c) {
  const last = toldAbout.get(c.id) || 0;
  if (Date.now() - last < TELL_AGAIN) return;
  toldAbout.set(c.id, Date.now());
  const seen = online.forTag(clientTag(c)).ips.length;
  const d = db.data;
  d.logs.unshift({
    at: Date.now(),
    type: 'client',
    message: `${c.email} was cut off: ${seen} addresses at once, ${c.limitIp} allowed`
  });
  if (d.logs.length > 500) d.logs.length = 500;
}

/** Disable clients that ran out of quota or time or are in too many places. */
async function enforceLimits() {
  const d = db.data;
  let dirty = false;
  for (const c of d.clients) {
    const overIps = isOverIpLimit(c);
    const shouldDisable = isExpired(c) || isOverQuota(c) || overIps;
    if (shouldDisable && c.enable !== false && !c.autoDisabled) {
      c.autoDisabled = true;
      if (overIps) noteOverIpLimit(c);
      dirty = true;
    } else if (!shouldDisable && c.autoDisabled) {
      /* it comes back on its own once the extra addresses go quiet - the point
         is to stop an account being in six places, not to end it */
      c.autoDisabled = false;
      dirty = true;
    }
  }
  if (dirty) {
    db.save();
    await apply();
    /*
     * apply() rewrites the config and reloads it, which is enough for a client
     * that has just been cut off to stop being offered - but an existing
     * connection it already holds is not torn down by a reload. Restarting is
     * the only thing that drops it. Off by default, because a restart is a
     * blip for everybody else on the server to end one person's session early.
     */
    if (db.settings.restartXrayOnAutoDisable) await restart();
  }
  return dirty;
}

/**
 * ECH key material for an inbound: the server keys go in the config, the
 * config list is what clients need.
 *
 * `xray tls ech` prints four lines - a label, the base64, another label, the
 * base64 - with no blank line anywhere, and the config list comes first. The
 * old parser split on blank lines and took the keys to be first, so it handed
 * back the whole output as the key and nothing at all as the config. Both
 * fields want plain base64, which is what this command prints without --pem.
 */
function parseECH(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim());
  const isBase64 = (line) => /^[A-Za-z0-9+/]{24,}={0,2}$/.test(line);
  const found = { echConfigList: '', echServerKeys: '' };

  lines.forEach((line, index) => {
    const label = line.toLowerCase();
    const sameLine = line.slice(line.indexOf(':') + 1).trim();
    const value = isBase64(sameLine) ? sameLine : (lines.slice(index + 1).find(Boolean) || '');
    if (!isBase64(value)) return;
    if (/ech\s*config\s*list/.test(label)) found.echConfigList = value;
    if (/ech\s*server\s*keys/.test(label)) found.echServerKeys = value;
  });

  // a build that labels them differently still prints the pair in this order
  if (!found.echConfigList || !found.echServerKeys) {
    const blobs = lines.filter(isBase64);
    if (blobs.length >= 2) {
      found.echConfigList = found.echConfigList || blobs[0];
      found.echServerKeys = found.echServerKeys || blobs[1];
    }
  }
  return found;
}

async function generateECH(serverName) {
  const sni = String(serverName || '').trim();
  if (!sni) throw new Error('an SNI is needed before ECH keys can be generated');
  const res = await run(XRAY_BIN, ['tls', 'ech', '--serverName', sni], 15000);
  if (!res.ok) throw new Error(messageOf(res) || 'xray tls ech failed');

  const found = parseECH(`${res.stdout}\n${res.stderr}`);
  if (!found.echServerKeys || !found.echConfigList) {
    throw new Error(`could not read xray's ECH output: ${String(res.stdout).trim().slice(0, 160)}`);
  }
  return found;
}

async function generateReality() {
  const res = await run(XRAY_BIN, ['x25519'], 8000);
  if (!res.ok) throw new Error(messageOf(res) || 'xray x25519 failed');
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
  buildConfig, writeConfig, testConfig, apply, serviceStatus, repairCerts, messageOf, isOverIpLimit,
  outboundConfig, outboundStream,
  INBOUND_PROTOCOLS, OUTBOUND_PROTOCOLS, CLIENT_PROTOCOLS, LINK_PROTOCOLS,
  restart, start, stop, collectTraffic, enforceLimits, ensureAccessLog, accessLogUsable, ACCESS_LOG, rateFor,
  clientTag, isExpired, isOverQuota, inboundDead, generateReality, generateECH, parseECH, run, serviceUser
};
