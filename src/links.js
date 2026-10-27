'use strict';
/** Share-link generation (vless / vmess / trojan / ss / socks) and subscription rendering. */
const db = require('./db');
const membership = require('./membership');

function hostFor(inb) {
  return inb.address || db.settings.domain || db.settings.serverIP || '127.0.0.1';
}

/**
 * Where a share link should actually point.
 *
 * An inbound can carry a list of external proxies - a CDN or a relay sitting in
 * front of this server - and then the link must name that, not the server. Each
 * entry may also override whether the link claims TLS, because a CDN commonly
 * terminates TLS itself while the server behind it speaks plain.
 *
 * One entry means every client gets it. Several means one link per entry, which
 * is why this returns a list and buildLink() is called once per address.
 */
function addressesFor(inb) {
  const rows = Array.isArray(inb.externalProxy) ? inb.externalProxy.filter((r) => r && r.dest) : [];
  if (!rows.length) return [{ host: hostFor(inb), port: Number(inb.port), security: null, remark: '' }];
  return rows.map((r) => ({
    host: String(r.dest),
    port: Number(r.port) || Number(inb.port),
    // 'same' leaves the inbound's own security alone; the other two force it
    security: r.forceTls === 'tls' ? 'tls' : (r.forceTls === 'none' ? 'none' : null),
    remark: String(r.remark || '')
  }));
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

/*
 * The line at the top of a subscription that is not a server at all.
 *
 * Every entry in a subscription is a way in, and every app shows its name in
 * the server list - so one of them can be spent on telling the buyer what
 * they have left instead. That is what this is: a config whose only job is
 * its own name. The real entries then go back to being called after the
 * inbound they are, with nobody's name or quota hanging off them.
 */
const DEFAULT_INFO = 'ℹ️ info | {{client}} | {{usage}} | {{days}}';

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

/**
 * Has this config run out, and on which of the two counts?
 *
 * The same two tests Xray is given when it decides whether to carry a client
 * at all, so what the buyer reads and what the server does cannot disagree.
 */
function outOfRoad(client) {
  const expiry = Number(client.expiryTime || 0);
  if (expiry > 0 && expiry < Date.now()) return '⛔️ اعتبار تمام شد';

  const quota = (client.totalGB || 0) * 1024 ** 3;
  if (quota > 0 && (client.up || 0) + (client.down || 0) >= quota) return '⛔️ حجم تمام شد';

  return '';
}

/** The values every token can take for one client on one inbound. */
function remarkValues(inb, client) {
  const used = (client.up || 0) + (client.down || 0);
  const quota = (client.totalGB || 0) * 1024 ** 3;
  const expiry = Number(client.expiryTime || 0);
  const daysLeft = expiry ? Math.ceil((expiry - Date.now()) / 86400000) : 0;

  /* bought but not started: it has its full run ahead of it, and saying the
     infinity sign there would be a promise the panel is not making */
  const waiting = !expiry && client.startAfterFirstUse && (client.expiryDays || 0) > 0;

  return {
    inbound: inb.remark || inb.tag || '',
    client: client.email || '',
    used: readable(used),
    quota: quota ? readable(quota) : INFINITY,
    usage: quota ? `${readable(used)} / ${readable(quota)}` : readable(used),
    left: quota ? readable(Math.max(0, quota - used)) : INFINITY,
    days: expiry ? (daysLeft > 0 ? String(daysLeft) : '0') : (waiting ? String(client.expiryDays) : INFINITY),
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
  /*
   * A client cut off for a reason the buyer should see - a receipt that did
   * not hold up - carries that reason as its whole name. It is the only thing
   * the panel can put in front of somebody whose app is still pointed at us.
   */
  if (client.blockedReason) return String(client.blockedReason);

  /*
   * A config that has run out says so, in the one place the buyer is looking.
   *
   * Xray stops carrying it the moment it expires, so it does not connect - but
   * the entry stays in their app under its old name, and a server that simply
   * fails with no reason given is indistinguishable from a panel whose time
   * limits do not work. Dropping it from the subscription would be worse: the
   * list would quietly empty itself and say even less.
   */
  const over = outOfRoad(client);
  if (over) return over;

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

/**
 * One link. `where` is an entry from addressesFor(); left out, it is the server
 * itself, which is what every caller that does not care about external proxies
 * gets by default.
 */
function buildLink(inb, client, where, nameOverride) {
  const at = where || addressesFor(inb)[0];
  const host = at.host;
  const port = at.port;
  const base = nameOverride || remarkFor(inb, client);
  /* an address with a label of its own says so after the name - but not when
     the caller has dictated the whole name, as the info line does */
  const remark = (!nameOverride && at.remark) ? `${base} · ${at.remark}` : base;
  const params = streamParams(inb);
  // an address in front may terminate TLS itself, or add it
  if (at.security) params.security = at.security;

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
      tls: (params.security === 'tls') ? 'tls' : '',
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
/*
 * Where the info line points, which is deliberately nowhere.
 *
 * 192.0.2.0/24 is TEST-NET-1: an address block the standards set aside for
 * documentation and examples, which no router on the internet carries. A
 * connection to it cannot succeed and cannot be made to succeed, which is the
 * whole point - the line is there to be read, not tapped, and an app that
 * tests it should report nothing rather than a ping.
 *
 * It used to borrow a real inbound's address, so it answered, carried a
 * working config and turned up in the app's latency test as just another
 * server. A row that exists to say "25 days left" should not be racing the
 * real ones to be picked.
 *
 * The id is all zeroes for the same reason: nothing of the buyer's belongs in
 * an entry that is never going to carry their traffic.
 */
const INFO_HOST = '192.0.2.1';
const INFO_PORT = 1;
const INFO_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The info line for one client: a link every app will parse and none can use.
 *
 * Built from nothing rather than from an inbound, so it neither occupies a
 * port nor depends on one being there.
 */
function infoLinkFor(client, inbounds) {
  const template = db.settings.infoTemplate || DEFAULT_INFO;
  const inb = (inbounds || []).find((i) => i.enable !== false) || {};
  const name = remarkFor(inb, client, template);
  if (!name) return '';
  const params = qs({ encryption: 'none', security: 'none', type: 'tcp' });
  return `vless://${INFO_ID}@${INFO_HOST}:${INFO_PORT}?${params}#${encodeURIComponent(name)}`;
}

/** Is the info line switched on? */
function infoRowOn() {
  return !!(db.settings.infoRow && db.settings.infoRow.enable);
}

function subscriptionFor(subId) {
  const d = db.data;
  const clients = d.clients.filter((c) => c.subId === subId);
  const links = [];

  /*
   * The info line goes first, so it is the first thing in the server list
   * rather than something to scroll for. One per subscription, not one per
   * client: it is the subscription that was bought.
   */
  if (infoRowOn()) {
    for (const c of clients) {
      if (c.enable === false && !c.blockedReason) continue;
      const line = infoLinkFor(c, membership.inboundsOf(c, d.inbounds));
      if (line) { links.push(line); break; }
    }
  }

  for (const c of clients) {
    /*
     * A blocked client stays in the list on purpose. It cannot connect - Xray
     * does not carry it at all - but its entry still arrives in the app, and
     * its name is the reason it stopped working. Dropping it would leave the
     * buyer with a subscription that silently empties itself.
     */
    if (c.enable === false && !c.blockedReason) continue;
    /*
     * One client can sit on several inbounds. Each one is a separate way in,
     * so each contributes its own links and the subscription carries all of
     * them - that is what makes multiple inbounds per client usable at all.
     */
    for (const inb of membership.inboundsOf(c, d.inbounds)) {
      if (inb.enable === false) continue;
      for (const where of addressesFor(inb)) {
        const link = buildLink(inb, c, where);
        if (link) links.push(link);
      }
    }
  }
  return links;
}

module.exports = {
  buildLink, subscriptionFor, hostFor, addressesFor, remarkFor, infoLinkFor, infoRowOn,
  DEFAULT_REMARK, DEFAULT_INFO, REMARK_TOKENS
};
