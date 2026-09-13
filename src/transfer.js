'use strict';
/**
 * Moving an inbound between panels, in the shape 3x-ui writes.
 *
 * The point of carrying clients along is their `subId`: a subscription URL is
 * built from it, so as long as the destination serves the same domain, every
 * client keeps working after an import and only has to refresh its
 * subscription. Anything that drops or regenerates subIds silently breaks
 * every user, so they are preserved exactly.
 */
const crypto = require('crypto');

const GB = 1024 ** 3;

/**
 * Strip control characters from a value that will be written into JSON.
 *
 * A stray newline in a client name survives round-trips here, because
 * JSON.stringify escapes it - but Go's decoder rejects the escaped form in
 * some panels, so an export with one in it cannot be imported into 3x-ui at
 * all. Nothing legitimate needs them, so they are removed at both ends.
 */
function clean(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

/** 3x-ui stores settings and streamSettings as JSON strings in some versions. */
function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

/* ------------------------------- export --------------------------------- */

function exportInbound(inb, clients) {
  const stream = { network: inb.network || 'tcp', security: inb.security || 'none' };

  if (stream.network === 'ws') {
    stream.wsSettings = { path: inb.wsPath || '/', host: inb.wsHost || '' };
  } else if (stream.network === 'grpc') {
    stream.grpcSettings = { serviceName: inb.grpcServiceName || '' };
  } else if (stream.network === 'httpupgrade') {
    stream.httpupgradeSettings = { path: inb.wsPath || '/', host: inb.wsHost || '' };
  } else if (stream.network === 'xhttp') {
    stream.xhttpSettings = {
      path: clean(inb.wsPath),
      host: clean(inb.wsHost),
      mode: inb.xhttpMode || 'auto',
      xPaddingBytes: '100-1000',
      scMaxBufferedPosts: Number(inb.xhttpMaxBufferedUpload || 30),
      scStreamUpServerSecs: '20-80'
    };
  } else if (stream.network === 'kcp') {
    stream.kcpSettings = { seed: inb.kcpSeed || '', header: { type: inb.kcpHeader || 'none' } };
  }

  if (stream.security === 'tls') {
    stream.tlsSettings = {
      serverName: clean(inb.sni),
      minVersion: inb.tlsMinVersion || '1.2',
      maxVersion: inb.tlsMaxVersion || '1.3',
      cipherSuites: clean(inb.cipherSuites),
      rejectUnknownSni: !!inb.rejectUnknownSni,
      disableSystemRoot: false,
      enableSessionResumption: false,
      certificates: (inb.certFile && inb.keyFile)
        ? [{
          certificateFile: clean(inb.certFile),
          keyFile: clean(inb.keyFile),
          ocspStapling: Number(inb.ocspStapling || 0),
          oneTimeLoading: !!inb.certOneTimeLoading,
          usage: inb.certUsage || 'encipherment',
          buildChain: false
        }]
        : [],
      alpn: (inb.alpn && inb.alpn.length) ? inb.alpn : ['h2', 'http/1.1'],
      echServerKeys: clean(inb.echServerKeys),
      settings: {
        fingerprint: clean(inb.fingerprint),
        echConfigList: clean(inb.echConfigList),
        pinnedPeerCertSha256: [],
        verifyPeerCertByName: ''
      }
    };
  } else if (stream.security === 'reality') {
    const r = inb.reality || {};
    stream.realitySettings = {
      dest: r.dest || '',
      serverNames: r.serverNames || [],
      privateKey: r.privateKey || '',
      publicKey: r.publicKey || '',
      shortIds: r.shortIds || [],
      fingerprint: r.fingerprint || 'chrome'
    };
  }

  const settings = { clients: clients.map(exportClient) };
  if (inb.protocol === 'vless') { settings.decryption = 'none'; settings.encryption = 'none'; }
  if (inb.protocol === 'shadowsocks') { settings.method = inb.method || ''; settings.password = inb.password || ''; }

  // The field set mirrors a 3x-ui export exactly, including the keys it does
  // not strictly need, so a file written here imports there unchanged.
  return {
    id: 1,
    userId: 0,
    up: clients.reduce((a, c) => a + (c.up || 0), 0),
    down: clients.reduce((a, c) => a + (c.down || 0), 0),
    total: 0,
    remark: clean(inb.remark),
    enable: inb.enable !== false,
    expiryTime: 0,
    trafficReset: 'never',
    trafficResetDay: 1,
    lastTrafficResetTime: 0,
    listen: inb.listen === '0.0.0.0' ? '' : clean(inb.listen),
    port: Number(inb.port),
    protocol: inb.protocol,
    settings,
    streamSettings: stream,
    tag: clean(inb.tag) || `in-${inb.port}-${inb.protocol}`,
    sniffing: {
      enabled: inb.sniffing !== false,
      destOverride: inb.sniffDestOverride || ['http', 'tls', 'quic'],
      metadataOnly: !!inb.sniffMetadataOnly,
      routeOnly: !!inb.sniffRouteOnly
    },
    clientStats: clients.map((c, index) => ({
      id: index + 1,
      inboundId: 1,
      enable: c.enable !== false,
      email: clean(c.email),
      uuid: clean(c.uuid),
      subId: clean(c.subId),
      up: c.up || 0,
      down: c.down || 0,
      expiryTime: c.expiryTime || 0,
      total: Math.round((c.totalGB || 0) * GB),
      reset: 0,
      resetDay: 0,
      resetMax: 0,
      resetCount: 0,
      lastOnline: c.lastSeen || 0,
      lastSubFetch: 0
    })),
    nodeId: null,
    shareAddrStrategy: 'listen',
    shareAddr: clean(inb.address),
    subSortIndex: 1,
    disableFlow: false,
    originNodeGuid: '',
    fallbackParent: null
  };
}

function exportClient(c) {
  return {
    comment: clean(c.comment),
    created_at: c.createdAt || 0,
    email: clean(c.email),
    enable: c.enable !== false,
    expiryTime: c.expiryTime || 0,
    id: clean(c.uuid),
    limitIp: c.limitIp || 0,
    password: clean(c.password),
    flow: clean(c.flow),
    reset: 0,
    resetDay: 0,
    resetMax: 0,
    security: 'auto',
    subId: clean(c.subId),
    tgId: Number(c.tgId) || 0,
    // 3x-ui counts this field in bytes despite the name
    totalGB: Math.round((c.totalGB || 0) * GB),
    updated_at: c.updatedAt || c.createdAt || 0
  };
}

/* ------------------------------- import --------------------------------- */

/**
 * Read an inbound written by this panel or by 3x-ui.
 * Returns { inbound, clients } in this panel's own shape; ids are assigned by
 * the caller, everything else - subId above all - is carried across as-is.
 */
function importInbound(raw) {
  const data = asObject(raw);
  if (!data.protocol || !data.port) {
    throw new Error('that file does not look like an inbound export');
  }

  const settings = asObject(data.settings);
  const stream = asObject(data.streamSettings);
  const tls = asObject(stream.tlsSettings);
  const reality = asObject(stream.realitySettings);
  const cert = (Array.isArray(tls.certificates) && tls.certificates[0]) ? tls.certificates[0] : {};
  const network = stream.network || 'tcp';

  const transport = asObject(
    stream.wsSettings || stream.httpupgradeSettings || stream.xhttpSettings || {}
  );
  const grpc = asObject(stream.grpcSettings);
  const kcp = asObject(stream.kcpSettings);

  const inbound = {
    remark: clean(data.remark) || `imported-${data.port}`,
    protocol: data.protocol,
    port: Number(data.port),
    listen: data.listen || '0.0.0.0',
    enable: data.enable !== false,
    network,
    security: stream.security || 'none',
    wsPath: transport.path || '/',
    wsHost: transport.host || '',
    grpcServiceName: grpc.serviceName || '',
    kcpSeed: kcp.seed || '',
    kcpHeader: (asObject(kcp.header).type) || 'none',
    xhttpMode: stream.xhttpSettings ? (asObject(stream.xhttpSettings).mode || 'auto') : 'auto',
    xhttpMaxBufferedUpload: asObject(stream.xhttpSettings).scMaxBufferedPosts || '',
    sni: tls.serverName || '',
    tlsMinVersion: tls.minVersion || '1.2',
    tlsMaxVersion: tls.maxVersion || '1.3',
    cipherSuites: tls.cipherSuites || '',
    rejectUnknownSni: !!tls.rejectUnknownSni,
    alpn: Array.isArray(tls.alpn) ? tls.alpn : ['h2', 'http/1.1'],
    fingerprint: asObject(tls.settings).fingerprint || 'chrome',
    certFile: cert.certificateFile || '',
    keyFile: cert.keyFile || '',
    ocspStapling: Number(cert.ocspStapling || 0),
    certUsage: cert.usage || 'encipherment',
    certOneTimeLoading: !!cert.oneTimeLoading,
    method: settings.method || '2022-blake3-aes-128-gcm',
    password: settings.password || '',
    sniffing: asObject(data.sniffing).enabled !== false,
    sniffDestOverride: asObject(data.sniffing).destOverride || ['http', 'tls', 'quic'],
    reality: {
      dest: reality.dest || 'www.cloudflare.com:443',
      serverNames: reality.serverNames || ['www.cloudflare.com'],
      privateKey: reality.privateKey || '',
      publicKey: reality.publicKey || '',
      shortIds: reality.shortIds || [''],
      fingerprint: reality.fingerprint || 'chrome'
    }
  };

  // traffic lives in clientStats, keyed by email
  const stats = new Map();
  for (const row of (Array.isArray(data.clientStats) ? data.clientStats : [])) {
    if (row && row.email) stats.set(row.email, row);
  }

  const clients = (Array.isArray(settings.clients) ? settings.clients : []).map((c) => {
    const stat = stats.get(c.email) || {};
    return {
      email: clean(c.email),
      uuid: clean(c.id) || crypto.randomUUID(),
      password: clean(c.password),
      flow: clean(c.flow),
      // both panels store this field in bytes; ours keeps whole gigabytes
      totalGB: Number(c.totalGB || 0) / GB,
      expiryTime: Number(c.expiryTime || 0),
      limitIp: Number(c.limitIp || 0),
      tgId: c.tgId || '',
      comment: clean(c.comment),
      enable: c.enable !== false,
      // the whole reason for carrying clients: their subscription keeps working
      subId: clean(c.subId) || crypto.randomBytes(6).toString('base64url'),
      up: Number(stat.up || 0),
      down: Number(stat.down || 0)
    };
  }).filter((c) => c.email);

  return { inbound, clients };
}

module.exports = { exportInbound, importInbound, asObject, clean };
