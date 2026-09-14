'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const QRCode = require('qrcode');

const db = require('./db');
const auth = require('./auth');
const resellers = require('./reseller');
const xray = require('./xray');
const links = require('./links');
const system = require('./system');
const api = require('./routes/api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

/**
 * Compress buffered responses. The panel is mostly text - 74 KB of HTML, CSS
 * and JS uncompressed, under 20 KB gzipped - and it is usually reached over a
 * phone connection, where that difference is most of the load time.
 * Responses below a KB cost more in headers than they save.
 */
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    const buf = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? Buffer.from(body) : null);
    if (!buf || buf.length < 1024 || res.getHeader('Content-Encoding')) return send(body);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return send(zlib.gzipSync(buf));
  };
  next();
});

/* --- minimal cookie helper so we don't pull in cookie-parser --- */
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    parts.push(`Path=${opts.path || '/'}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
    const prev = res.getHeader('Set-Cookie');
    const list = prev ? [].concat(prev) : [];
    list.push(parts.join('; '));
    res.setHeader('Set-Cookie', list);
    return res;
  };
  res.clearCookie = (name, opts = {}) => res.cookie(name, '', Object.assign({}, opts, { maxAge: 0 }));
  next();
});

// a request that takes this long is the difference between "the panel is slow"
// and "the panel is broken"; without it a stall leaves no trace anywhere
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    if (ms >= 1000) console.warn(`[http] slow ${req.method} ${req.path} -> ${res.statusCode} in ${ms}ms`);
  });
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

/* ------------------------------ subscription ---------------------------- */
/** Public endpoint: clients fetch their config list here, no auth. */
function serveSubscription(req, res) {
  const configured = db.settings.subPath || '/sub/';
  const prefix = configured.endsWith('/') ? configured : `${configured}/`;
  if (!req.path.startsWith(prefix)) return res.status(404).send('not found');

  const subId = req.path.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(subId)) return res.status(404).send('not found');

  const list = links.subscriptionFor(subId);
  if (!list.length) return res.status(404).send('not found');

  const clients = db.data.clients.filter((c) => c.subId === subId);
  const totalGB = clients.reduce((a, c) => a + (c.totalGB || 0), 0);
  const expiry = clients.reduce((a, c) => Math.max(a, c.expiryTime || 0), 0);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Profile-Update-Interval', '12');
  res.setHeader('Subscription-Userinfo',
    `upload=${clients.reduce((a, c) => a + (c.up || 0), 0)}; ` +
    `download=${clients.reduce((a, c) => a + (c.down || 0), 0)}; ` +
    `total=${totalGB * 1024 ** 3}; expire=${expiry ? Math.floor(expiry / 1000) : 0}`);
  /*
   * The name the client app files this subscription under. It was sent as bare
   * base64, which is not a form any client reads: the convention is plain text
   * or the string prefixed with "base64:", and without the prefix v2rayNG and
   * the rest either ignore the header or show the encoded gibberish. This is
   * why the subscription title never appeared on anybody's configs.
   */
  const title = db.settings.subTitle || 'NexV';
  res.setHeader('Profile-Title', `base64:${Buffer.from(title, 'utf8').toString('base64')}`);

  const body = list.join('\n');
  // most clients expect the base64 form; ?plain=1 returns the raw links
  res.send(req.query.plain === '1' ? body : Buffer.from(body, 'utf8').toString('base64'));
}

/**
 * The same address, opened by a person.
 *
 * A VPN client asks for this URL with an Accept of any type and wants the
 * base64 list; a browser says text/html and gets the page instead. `?info=1`
 * and `?plain=1` force either side of that, so nothing is ever stuck with
 * the wrong one.
 */
function wantsPage(req) {
  if (req.query.info === '1') return true;
  if (req.query.plain === '1' || req.query.json === '1') return false;
  return String(req.headers.accept || '').includes('text/html');
}

/** Everything the page shows, for the small script inside it. */
async function subscriptionInfo(subId) {
  const d = db.data;
  const clients = d.clients.filter((c) => c.subId === subId);
  if (!clients.length) return null;

  const used = clients.reduce((a, c) => a + (c.up || 0) + (c.down || 0), 0);
  const totalGB = clients.reduce((a, c) => a + (c.totalGB || 0), 0);
  const expiry = clients.reduce((a, c) => Math.max(a, c.expiryTime || 0), 0);
  const url = require('./routes/api').subUrl(subId);

  const configs = [];
  for (const c of clients) {
    const inb = d.inbounds.find((i) => i.id === c.inboundId);
    if (!inb) continue;
    const link = links.buildLink(inb, c);
    if (!link) continue;
    configs.push({
      name: inb.remark || inb.protocol,
      protocol: inb.protocol,
      network: inb.network || 'tcp',
      security: inb.security || 'none',
      link,
      enabled: c.enable !== false && inb.enable !== false
    });
  }

  // the codes come with the page, so it needs no QR library of its own; a
  // subscription with dozens of configs would be a heavy payload, hence the cap
  for (const config of configs.slice(0, 10)) {
    try {
      config.qr = await QRCode.toDataURL(config.link, { margin: 1, width: 420, errorCorrectionLevel: 'M' });
    } catch (_) { /* the link still copies */ }
  }

  let qr = '';
  try { qr = await QRCode.toDataURL(url, { margin: 1, width: 460, errorCorrectionLevel: 'M' }); } catch (_) { /* no QR then */ }

  return {
    title: db.settings.subTitle || 'NexV',
    name: clients[0].email,
    used,
    total: totalGB * 1024 ** 3,
    up: clients.reduce((a, c) => a + (c.up || 0), 0),
    down: clients.reduce((a, c) => a + (c.down || 0), 0),
    expiry,
    enabled: clients.some((c) => c.enable !== false),
    url,
    qr,
    configs
  };
}

/**
 * One entry point for both listeners: the panel's own port and the separate
 * subscription port serve the same three answers - the base64 list a client
 * app wants, the page a person wants, and the JSON behind that page.
 */
async function subscriptionRoute(req, res, next) {
  const prefix = db.settings.subPath || '/sub/';
  const full = prefix.endsWith('/') ? prefix : `${prefix}/`;
  if (!req.path.startsWith(full)) return next ? next() : res.status(404).send('not found');

  const subId = req.path.slice(full.length);
  const valid = /^[A-Za-z0-9_-]{4,64}$/.test(subId);
  if (valid && req.query.json === '1') {
    const info = await subscriptionInfo(subId);
    if (!info) return res.status(404).json({ error: 'not found' });
    return res.json(info);
  }
  if (valid && wantsPage(req)) return res.sendFile(path.join(WEB_DIR, 'sub.html'));
  return serveSubscription(req, res);
}

app.get(/.*/, subscriptionRoute);

/* ------------------------------- web path -------------------------------- */
/**
 * The panel lives under a secret, randomly generated prefix so it is not
 * discoverable by scanning the port. Requests outside it get a plain 404
 * rather than a redirect, which would leak that the panel is here.
 * Matched per request, so changing the path in settings applies immediately.
 */
function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

/*
 * Two kinds of front door.
 *
 * The leader's panel answers under its own secret path. Each reseller has a
 * path of their own, unguessable in the same way and never the leader's - what
 * comes through it is the same application, told by /api/me that it is a
 * reseller and to draw three pages instead of seven.
 */
app.use((req, res, next) => {
  const base = normalizeBasePath(db.settings.webBasePath);
  const [pathname, query] = req.url.split('?');

  const first = pathname.split('/')[1] || '';
  const reseller = first ? resellers.bySlug(first) : null;
  if (reseller) {
    if (reseller.enable === false) {
      return res.status(403).type('text/plain').send('This panel has been suspended.');
    }
    req.resellerSlug = reseller.slug;
    const prefix = `/${reseller.slug}`;
    if (pathname === prefix) {
      return res.redirect(302, `${prefix}/${query ? `?${query}` : ''}`);
    }
    req.url = req.url.slice(prefix.length);
    return next();
  }

  if (!base) return next();
  if (pathname === base) {
    return res.redirect(302, `${base}/${query ? `?${query}` : ''}`);
  }
  if (pathname.startsWith(`${base}/`)) {
    req.url = req.url.slice(base.length);
    return next();
  }
  return res.status(404).type('text/plain').send('404 Not Found');
});

/* --------------------------------- api ---------------------------------- */
app.use('/api', api);

/* ---------------------------- static frontend --------------------------- */
const WEB_DIR = path.join(__dirname, '..', 'web');

/**
 * Script and stylesheet are served from a gzipped in-memory copy: they are the
 * two largest files by far, they never change while the process runs, and
 * express.static streams from disk without compressing. Their URLs carry the
 * panel version, so they can be cached hard.
 */
const assetCache = new Map();
const ASSET_TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

app.get(/^\/[\w.-]+\.(js|css)$/, (req, res, next) => {
  const file = path.join(WEB_DIR, path.basename(req.path));
  let entry = assetCache.get(file);
  try {
    const stat = fs.statSync(file);
    if (!entry || entry.mtime !== stat.mtimeMs) {
      const raw = fs.readFileSync(file);
      entry = { mtime: stat.mtimeMs, raw, gzip: zlib.gzipSync(raw, { level: 9 }) };
      assetCache.set(file, entry);
    }
  } catch (_) {
    return next();
  }

  res.setHeader('Content-Type', ASSET_TYPES[path.extname(file)]);
  res.setHeader('Vary', 'Accept-Encoding');
  // versioned URLs, so a long cache never serves a stale build
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(entry.gzip);
  }
  return res.end(entry.raw);
});

app.use(express.static(WEB_DIR, { index: false, maxAge: '1h' }));

/**
 * Pages are served with the panel's base path baked in.
 *
 * Without this the frontend has to guess its own prefix from the current URL,
 * and a single trailing slash makes every relative fetch resolve one level too
 * deep - where the catch-all would answer with index.html instead of JSON, so
 * the page waits forever on a request that can never succeed.
 */
const pageCache = new Map();
const ASSET_VERSION = require('../package.json').version;

function renderPage(file, base) {
  // the language is baked into the page, so a change to it must miss the cache
  const key = `${file}|${base}|${db.settings.lang || 'en'}`;
  const cached = pageCache.get(key);
  const stat = fs.statSync(path.join(WEB_DIR, file));
  if (cached && cached.mtime === stat.mtimeMs) return cached.html;

  const prefix = `${base}/`;
  const html = fs.readFileSync(path.join(WEB_DIR, file), 'utf8')
    // static assets are cached for an hour, so an update has to change the URL
    // or browsers keep running the previous panel against the new server
    .replace(/(href|src)="(app\.js|style\.css|i18n\.js)"/g, `$1="$2?v=${ASSET_VERSION}"`)
    .replace(
      '</head>',
      `<base href="${prefix}">\n<script>window.__NEXV_BASE__=${JSON.stringify(prefix)};</script>\n</head>`
    )
    /* the language this panel is run in, so a browser that has never been here
       starts in it rather than in English */
    .replace('<html lang="en"', `<html lang="en" data-lang="${db.settings.lang === 'fa' ? 'fa' : 'en'}"`);
  pageCache.set(key, { mtime: stat.mtimeMs, html });
  return html;
}

function sendPage(res, file, base, req) {
  res.setHeader('Cache-Control', 'no-store');
  let html = renderPage(file, base);
  /* the sign-in page of a panel whose owner has not made an account yet offers
     to make one; every other door gets the ordinary form */
  if (req && req.resellerSlug) {
    const mine = resellers.bySlug(req.resellerSlug);
    const needsAccount = mine && !mine.userId;
    html = html.replace('</head>',
      `<script>window.__NEXV_RESELLER__=${JSON.stringify({ slug: mine.slug, name: mine.name, register: !!needsAccount })};</script>\n</head>`);
  }
  res.type('html').send(html);
}

/** Whichever door this request came through. */
function baseFor(req) {
  return req.resellerSlug ? `/${req.resellerSlug}` : normalizeBasePath(db.settings.webBasePath);
}

app.get('/login', (req, res) => {
  const base = baseFor(req);
  const user = auth.currentUser(req);
  /* somebody signed in as the leader who opens a reseller's address is not
     signed in *there*, and the other way round: each door has its own panel */
  if (user && !mismatched(req, user)) return res.redirect(`${base}/`);
  sendPage(res, 'login.html', base, req);
});

app.get('/', (req, res) => {
  const base = baseFor(req);
  const user = auth.currentUser(req);
  if (!user || mismatched(req, user)) return res.redirect(`${base}/login`);
  sendPage(res, 'index.html', base, req);
});

/** Is this session for a different panel than the door it arrived at? */
function mismatched(req, user) {
  const mine = resellers.forUser(user);
  if (req.resellerSlug) return !mine || mine.slug !== req.resellerSlug;
  return !!mine;
}

// anything else under the base path is a genuine 404. Serving index.html here
// would hand HTML to fetches that expect JSON.
app.use((req, res) => res.status(404).type('text/plain').send('404 Not Found'));

app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
});

/* ------------------------------ background ------------------------------ */
function startJobs() {
  // traffic accounting every 30s, limit enforcement right after
  setInterval(async () => {
    try {
      await xray.collectTraffic();
      await xray.enforceLimits();
    } catch (err) {
      console.error('[jobs] traffic:', err.message);
    }
  }, 30000).unref?.();

  // keep a cached public IP for link building when no domain is set
  const refreshIP = async () => {
    try {
      const ip = await system.publicIP();
      if (ip && ip !== db.settings.serverIP) {
        db.settings.serverIP = ip;
        db.save();
      }
    } catch (_) { /* offline is fine */ }
  };
  refreshIP();
  setInterval(refreshIP, 6 * 60 * 60 * 1000).unref?.();
}

async function bootstrap() {
  const d = db.data;
  if (!d.users.length) {
    const username = process.env.NEXV_ADMIN_USER || 'admin';
    const password = process.env.NEXV_ADMIN_PASS || require('crypto').randomBytes(9).toString('base64url');
    await auth.createUser(username, password);
    console.log('==================================================');
    console.log(' NexV Panel first run — admin account created');
    console.log(` username: ${username}`);
    console.log(` password: ${password}`);
    console.log('==================================================');
  }
  if (!d.settings.webBasePath) {
    d.settings.webBasePath = `/${require('crypto').randomBytes(9).toString('base64url')}`;
    db.saveNow();
  }
  try { xray.writeConfig(); } catch (err) { console.error('[xray] cannot write config:', err.message); }
  // a bot that was running before the restart starts polling again on its own
  try { require('./telegram').resume(); } catch (err) { console.error('[bot] could not resume:', err.message); }
  // and from here on xray gets itself picked up when it falls over
  try { require('./watchdog').start(); } catch (err) { console.error('[watchdog] could not start:', err.message); }

  // the access log is what tells the panel who is connected and from where
  try {
    await xray.ensureAccessLog();
    require('./online').start();
  } catch (err) { console.error('[online] could not start:', err.message); }
}

/**
 * TLS material for the panel's own listener.
 *
 * Falls back to the certificate configured for Xray inbounds, which is what a
 * Let's Encrypt run leaves behind, so a panel on a domain is served over HTTPS
 * without a second copy of the same paths. A missing or unreadable file is a
 * warning, never a failure to start: an unreachable panel is worse than one
 * served over plain HTTP.
 */
function tlsOptions() {
  const s = db.settings;
  const certFile = s.panelCertFile || s.certFile || '';
  const keyFile = s.panelKeyFile || s.keyFile || '';
  if (!certFile || !keyFile) return null;
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (err) {
    console.warn(`[nexv] TLS disabled, cannot read certificate: ${err.message}`);
    return null;
  }
}

function createServer(handler, tls) {
  return tls ? require('https').createServer(tls, handler) : require('http').createServer(handler);
}

if (require.main === module) {
  bootstrap().then(() => {
    const port = Number(process.env.NEXV_PORT || db.settings.panelPort || 2087);
    const host = process.env.NEXV_HOST || '0.0.0.0';
    const tls = process.env.NEXV_NO_TLS ? null : tlsOptions();
    const scheme = tls ? 'https' : 'http';

    createServer(app, tls)
      .listen(port, host, () => {
        const base = normalizeBasePath(db.settings.webBasePath);
        console.log(`[nexv] panel listening on ${scheme}://${host}:${port}${base}/`);
        // printed every start: without the path the panel cannot be reached
        console.log(`[nexv] web path: ${base || '/'}`);
        if (!tls) console.log('[nexv] TLS is off - set a certificate in Settings, or run: nexv cert <domain>');
        startJobs();
      })
      .on('error', (err) => {
        // systemd restarts us every few seconds; without naming the cause the
        // journal fills with stack traces that say nothing about the port
        if (err.code === 'EADDRINUSE') {
          console.error(`[nexv] port ${port} is already in use by another process.`);
          console.error('[nexv] free it, or pick another port with: nexv port <number>');
        } else if (err.code === 'EACCES') {
          console.error(`[nexv] not allowed to bind port ${port}. Ports below 1024 need root.`);
        } else {
          console.error(`[nexv] cannot listen on port ${port}: ${err.message}`);
        }
        process.exit(1);
      });

    /*
     * Optional redirect from port 80, off unless the admin turns it on.
     *
     * With TLS on, a bookmarked http:// address hits a socket that only speaks
     * TLS and fails to connect, so a redirect is useful - but binding a port
     * nobody asked for is not something a panel should do on its own, and port
     * 80 is usually wanted by an inbound.
     */
    const inboundOn80 = db.data.inbounds.some((i) => i.enable !== false && Number(i.port) === 80);
    const wantsRedirect = db.settings.httpRedirect === true;
    if (wantsRedirect && inboundOn80) {
      console.log('[nexv] port 80 is used by an inbound; http redirect not started');
    }

    if (tls && port !== 80 && wantsRedirect && !inboundOn80) {
      require('http')
        .createServer((req, res) => {
          const host = (req.headers.host || '').split(':')[0];
          const target = `https://${host}${port === 443 ? '' : `:${port}`}${req.url}`;
          res.writeHead(301, { Location: target });
          res.end();
        })
        .listen(80, host, () => console.log(`[nexv] redirecting http://${host}:80 to the panel`))
        .on('error', (err) => console.warn(`[nexv] no http redirect on port 80: ${err.message}`));
    }

    // subscription links advertise their own port, so serve them there too
    const subPort = Number(db.settings.subPort || 0);
    if (subPort && subPort !== port) {
      const subApp = express();
      subApp.disable('x-powered-by');
      subApp.set('trust proxy', true);
      subApp.get(/.*/, subscriptionRoute);
      createServer(subApp, tls)
        .listen(subPort, host, () => console.log(`[nexv] subscriptions listening on ${scheme}://${host}:${subPort}`))
        .on('error', (err) => console.error(`[nexv] subscription port ${subPort} unavailable:`, err.message));
    }
  });
}

module.exports = app;
module.exports.normalizeBasePath = normalizeBasePath;
