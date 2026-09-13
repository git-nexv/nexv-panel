'use strict';
/**
 * A config from somewhere else, turned into an outbound here.
 *
 * This is how one server is chained behind another: the second server hands
 * out a vless:// (or vmess://, trojan://, ss://) link for a client, and that
 * link is everything the first server needs to dial it. Typing the same
 * fifteen fields by hand is how a chain ends up not working for a reason
 * nobody can see, so the link is parsed instead.
 *
 * An Xray outbound written as JSON is accepted too, which is what the other
 * panel copies to the clipboard.
 */

function decodeBase64(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8');
}

/** The bits of a share link that describe the transport. */
function fromParams(params, out) {
  const get = (name) => (params.get(name) || '').trim();

  const net = get('type') || get('network') || 'tcp';
  out.network = net === 'h2' ? 'xhttp' : net;
  out.security = get('security') || 'none';

  const path = get('path');
  const host = get('host');
  if (path) out.wsPath = path;
  if (host) out.wsHost = host;
  if (get('serviceName')) out.grpcServiceName = get('serviceName');
  if (get('mode')) out.xhttpMode = get('mode');
  if (get('seed')) out.kcpSeed = get('seed');
  if (get('headerType')) out.kcpHeader = get('headerType');

  if (get('flow')) out.flow = get('flow');
  if (get('fp')) out.fingerprint = get('fp');
  if (get('sni')) out.sni = get('sni');
  if (get('alpn')) out.alpn = get('alpn').split(',').map((a) => a.trim()).filter(Boolean);
  if (get('allowInsecure') === '1' || get('allowInsecure') === 'true') out.allowInsecure = true;

  /* REALITY: the peer's public key and one short id, which is all a client
     needs and none of what a server needs */
  if (get('pbk')) out.realityPublicKey = get('pbk');
  if (get('sid')) out.realityShortId = get('sid');
  if (get('spx')) out.realitySpiderX = get('spx');

  // a REALITY link often leaves sni to the serverName parameter instead
  if (out.security === 'reality' && !out.sni && get('serverName')) out.sni = get('serverName');
  return out;
}

function parseVless(url) {
  const u = new URL(url);
  return fromParams(u.searchParams, {
    protocol: 'vless',
    address: decodeURIComponent(u.hostname).replace(/^\[|\]$/g, ''),
    port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username || ''),
    remark: decodeURIComponent(u.hash.slice(1) || '')
  });
}

function parseTrojan(url) {
  const u = new URL(url);
  return fromParams(u.searchParams, {
    protocol: 'trojan',
    address: decodeURIComponent(u.hostname).replace(/^\[|\]$/g, ''),
    port: Number(u.port || 443),
    password: decodeURIComponent(u.username || ''),
    remark: decodeURIComponent(u.hash.slice(1) || '')
  });
}

/** vmess:// is a base64 blob of JSON, with single-letter keys. */
function parseVmess(url) {
  const raw = url.slice('vmess://'.length).trim();
  let conf;
  try { conf = JSON.parse(decodeBase64(raw)); } catch (_) { throw new Error('that vmess link is not readable'); }

  const out = {
    protocol: 'vmess',
    address: String(conf.add || ''),
    port: Number(conf.port || 443),
    uuid: String(conf.id || ''),
    encryption: conf.scy || 'auto',
    network: conf.net === 'h2' ? 'xhttp' : (conf.net || 'tcp'),
    security: conf.tls === 'tls' ? 'tls' : 'none',
    remark: String(conf.ps || '')
  };
  if (conf.path) out.wsPath = String(conf.path);
  if (conf.host) out.wsHost = String(conf.host);
  if (conf.sni) out.sni = String(conf.sni);
  if (conf.fp) out.fingerprint = String(conf.fp);
  if (out.network === 'grpc' && conf.path) out.grpcServiceName = String(conf.path);
  return out;
}

/** ss:// is base64 of method:password, or the same in userinfo form. */
function parseShadowsocks(url) {
  const body = url.slice('ss://'.length);
  const hash = body.indexOf('#');
  const remark = hash >= 0 ? decodeURIComponent(body.slice(hash + 1)) : '';
  const main = hash >= 0 ? body.slice(0, hash) : body;
  const at = main.lastIndexOf('@');
  if (at < 0) throw new Error('that shadowsocks link is missing its server');

  let userinfo = main.slice(0, at);
  if (!userinfo.includes(':')) userinfo = decodeBase64(userinfo);
  const colon = userinfo.indexOf(':');

  const hostPart = main.slice(at + 1).split('?')[0];
  const lastColon = hostPart.lastIndexOf(':');
  return {
    protocol: 'shadowsocks',
    method: userinfo.slice(0, colon),
    password: decodeURIComponent(userinfo.slice(colon + 1)),
    address: hostPart.slice(0, lastColon).replace(/^\[|\]$/g, ''),
    port: Number(hostPart.slice(lastColon + 1)) || 443,
    network: 'tcp',
    security: 'none',
    remark
  };
}

/** An Xray outbound as JSON - what the other panel's clipboard holds. */
function parseOutboundJson(text) {
  let conf;
  try { conf = JSON.parse(text); } catch (_) { return null; }
  if (Array.isArray(conf)) conf = conf[0];
  if (!conf || typeof conf !== 'object') return null;
  if (conf.outbounds && conf.outbounds.length) conf = conf.outbounds[0];
  if (!conf.protocol) return null;

  const stream = conf.streamSettings || {};
  const settings = conf.settings || {};
  const peer = (settings.vnext && settings.vnext[0])
    || (settings.servers && settings.servers[0])
    || {};
  const user = (peer.users && peer.users[0]) || {};

  const out = {
    protocol: conf.protocol,
    remark: conf.tag || '',
    address: peer.address || '',
    port: Number(peer.port || 0),
    uuid: user.id || '',
    password: peer.password || user.pass || '',
    username: user.user || '',
    method: peer.method || '',
    encryption: user.security || 'auto',
    flow: user.flow || '',
    network: stream.network === 'h2' ? 'xhttp' : (stream.network || 'tcp'),
    security: stream.security || 'none'
  };

  const ws = stream.wsSettings || stream.httpupgradeSettings || stream.xhttpSettings || {};
  if (ws.path) out.wsPath = ws.path;
  if (ws.host) out.wsHost = ws.host;
  if (ws.headers && ws.headers.Host) out.wsHost = ws.headers.Host;
  if (stream.xhttpSettings && stream.xhttpSettings.mode) out.xhttpMode = stream.xhttpSettings.mode;
  if (stream.grpcSettings) out.grpcServiceName = stream.grpcSettings.serviceName || '';

  const tls = stream.tlsSettings || {};
  if (tls.serverName) out.sni = tls.serverName;
  if (tls.fingerprint) out.fingerprint = tls.fingerprint;
  if (tls.allowInsecure) out.allowInsecure = true;
  if (Array.isArray(tls.alpn)) out.alpn = tls.alpn;

  const reality = stream.realitySettings || {};
  if (reality.serverName) out.sni = reality.serverName;
  if (reality.publicKey) out.realityPublicKey = reality.publicKey;
  if (reality.shortId) out.realityShortId = reality.shortId;
  if (reality.spiderX) out.realitySpiderX = reality.spiderX;
  if (reality.fingerprint) out.fingerprint = reality.fingerprint;

  return out;
}

/**
 * One share link or one outbound JSON in, the fields of an outbound out.
 * Throws with something a person can act on rather than returning null.
 */
function parseShareLink(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('paste a config link or an outbound JSON first');

  const asJson = parseOutboundJson(trimmed);
  if (asJson) return asJson;

  try {
    if (trimmed.startsWith('vless://')) return parseVless(trimmed);
    if (trimmed.startsWith('trojan://')) return parseTrojan(trimmed);
    if (trimmed.startsWith('vmess://')) return parseVmess(trimmed);
    if (trimmed.startsWith('ss://')) return parseShadowsocks(trimmed);
  } catch (err) {
    throw new Error(`that link could not be read: ${err.message}`);
  }
  throw new Error('paste a vless://, vmess://, trojan:// or ss:// link, or an outbound in JSON');
}

module.exports = { parseShareLink, parseOutboundJson };
