'use strict';
/** Share-link generation (vless / vmess / trojan / ss / socks) and subscription rendering. */
const db = require('./db');

function hostFor(inb) {
  return inb.address || db.settings.domain || db.settings.serverIP || '127.0.0.1';
}

function streamParams(inb) {
  const p = {};
  const net = inb.network || 'tcp';
  p.type = net;
  p.security = inb.security || 'none';

  if (net === 'ws' || net === 'httpupgrade' || net === 'xhttp') {
    p.path = inb.wsPath || '/';
    if (inb.wsHost) p.host = inb.wsHost;
  } else if (net === 'grpc') {
    p.serviceName = inb.grpcServiceName || '';
    if (inb.grpcMultiMode) p.mode = 'multi';
  }

  if (p.security === 'tls') {
    p.sni = inb.sni || db.settings.domain || '';
    p.fp = inb.fingerprint || 'chrome';
    if (net === 'grpc') p.alpn = 'h2';
  } else if (p.security === 'reality') {
    const r = inb.reality || {};
    p.sni = (r.serverNames && r.serverNames[0]) || '';
    p.pbk = r.publicKey || '';
    p.sid = (r.shortIds && r.shortIds[0]) || '';
    p.fp = r.fingerprint || 'chrome';
  }
  return p;
}

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function buildLink(inb, client) {
  const host = hostFor(inb);
  const port = inb.port;
  const remark = `${inb.remark || inb.tag}-${client.email}`;
  const params = streamParams(inb);

  if (inb.protocol === 'vless') {
    if (client.flow) params.flow = client.flow;
    return `vless://${client.uuid}@${host}:${port}?${qs(params)}#${encodeURIComponent(remark)}`;
  }

  if (inb.protocol === 'trojan') {
    return `trojan://${encodeURIComponent(client.password || client.uuid)}@${host}:${port}?${qs(params)}#${encodeURIComponent(remark)}`;
  }

  if (inb.protocol === 'vmess') {
    const conf = {
      v: '2',
      ps: remark,
      add: host,
      port: String(port),
      id: client.uuid,
      aid: '0',
      scy: 'auto',
      net: inb.network || 'tcp',
      type: 'none',
      host: inb.wsHost || '',
      path: inb.wsPath || '',
      tls: (inb.security === 'tls') ? 'tls' : '',
      sni: inb.sni || '',
      alpn: '',
      fp: inb.fingerprint || ''
    };
    return `vmess://${Buffer.from(JSON.stringify(conf)).toString('base64')}`;
  }

  if (inb.protocol === 'socks') {
    const userinfo = Buffer.from(`${client.email}:${client.password || client.uuid}`).toString('base64url');
    return `socks://${userinfo}@${host}:${port}#${encodeURIComponent(remark)}`;
  }

  if (inb.protocol === 'shadowsocks') {
    const method = inb.method || '2022-blake3-aes-128-gcm';
    const pass = inb.password ? `${inb.password}:${client.password || client.uuid}` : (client.password || client.uuid);
    const userinfo = Buffer.from(`${method}:${pass}`).toString('base64url');
    return `ss://${userinfo}@${host}:${port}#${encodeURIComponent(remark)}`;
  }

  return '';
}

/** All links for one subscription id, as plain text (clients expect base64 of this). */
function subscriptionFor(subId) {
  const d = db.data;
  const clients = d.clients.filter((c) => c.subId === subId);
  const links = [];
  for (const c of clients) {
    if (c.enable === false) continue;
    const inb = d.inbounds.find((i) => i.id === c.inboundId);
    if (!inb || inb.enable === false) continue;
    const link = buildLink(inb, c);
    if (link) links.push(link);
  }
  return links;
}

module.exports = { buildLink, subscriptionFor, hostFor };
