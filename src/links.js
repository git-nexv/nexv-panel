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

/*
 * What a config calls itself in the client app.
 *
 * The name used to be inbound-client and nothing else. An admin selling
 * accounts wants more in there - how much is left, how long is left - and
 * wants it their way round, so it is a template: anything outside {{...}} is
 * kept verbatim, and each token is replaced with the value it names.
 */
const DEFAULT_REMARK = '{{inbound}}-{{client}}';

const REMARK_TOKENS = [
  { token: 'inbound', about: 'the inbound\u2019s name' },
  { token: 'client', about: 'the client\u2019s name' },
  { token: 'usage', about: 'used of quota, e.g. 1.4 GB / 10 GB' },
  { token: 'used', about: 'traffic used so far' },
  { token: 'quota', about: 'the quota, or \u221e' },
  { token: 'left', about: 'traffic still to go' },
  { token: 'days', about: 'days remaining, or \u221e' },
  { token: 'expiry', about: 'the expiry date' },
  { token: 'protocol', about: 'vless, vmess, trojan\u2026' },
  { token: 'port', about: 'the inbound\u2019s port' },
  { token: 'host', about: 'the address clients connect to' },
  { token: 'panel', about: 'the subscription title' }
];

const INFINITY = '\u221e';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/*
 * Step up a unit on what will be *printed*, not on the raw figure: a gigabyte
 * less 512 bytes is 1023.9995 MB, which prints as "1024 MB" if you only look
 * at the number behind it. And 10.0 GB is a quota nobody writes that way.
 */
function readable(bytes) {
  let value = Math.max(0, Number(bytes) || 0);
  let i = 0;
  const print = (v, unit) => (unit === 0
    ? String(Math.round(v))
    : v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, ''));

  while (i < UNITS.length - 1 && Number(print(value, i)) >= 1024) {
    value /= 1024;
    i++;
  }
  return `${print(value, i)} ${UNITS[i]}`;
}

/** The values every token can take for one client on one inbound. */
function remarkValues(inb, client) {
  const used = (client.up || 0) + (client.down || 0);
  const quota = (client.totalGB || 0) * 1024 ** 3;
  const expiry = Number(client.expiryTime || 0);
  const daysLeft = expiry ? Math.ceil((expiry - Date.now()) / 86400000) : 0;

  return {
    inbound: inb.remark || inb.tag || '',
    client: client.email || '',
    used: readable(used),
    quota: quota ? readable(quota) : INFINITY,
    usage: quota ? `${readable(used)} / ${readable(quota)}` : readable(used),
    left: quota ? readable(Math.max(0, quota - used)) : INFINITY,
    days: expiry ? (daysLeft > 0 ? String(daysLeft) : '0') : INFINITY,
    expiry: expiry ? new Date(expiry).toISOString().slice(0, 10) : INFINITY,
    protocol: inb.protocol || '',
    port: String(inb.port || ''),
    host: hostFor(inb),
    panel: db.settings.subTitle || 'NexV'
  };
}

/**
 * Render the naming template. An unknown token is left as it was typed rather
 * than silently becoming an empty string: a name reading {{clint}} is a typo
 * the admin can see and fix, where a missing word is a mystery.
 */
function remarkFor(inb, client, template) {
  const tpl = template !== undefined && template !== null && template !== ''
    ? String(template)
    : (db.settings.remarkTemplate || DEFAULT_REMARK);
  const values = remarkValues(inb, client);
  return tpl.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (whole, name) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole;
  }).trim();
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
  const remark = remarkFor(inb, client);
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

module.exports = { buildLink, subscriptionFor, hostFor, remarkFor, DEFAULT_REMARK, REMARK_TOKENS };
