'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('./db');
const auth = require('./auth');
const xray = require('./xray');
const links = require('./links');
const system = require('./system');
const api = require('./routes/api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

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
  res.setHeader('Profile-Title', Buffer.from(db.settings.subTitle || 'NexV', 'utf8').toString('base64'));

  const body = list.join('\n');
  // most clients expect the base64 form; ?plain=1 returns the raw links
  res.send(req.query.plain === '1' ? body : Buffer.from(body, 'utf8').toString('base64'));
}

app.get(/.*/, (req, res, next) => {
  const prefix = db.settings.subPath || '/sub/';
  if (req.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) return serveSubscription(req, res);
  next();
});

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

app.use((req, res, next) => {
  const base = normalizeBasePath(db.settings.webBasePath);
  if (!base) return next();

  const [pathname, query] = req.url.split('?');
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
  const key = `${file}|${base}`;
  const cached = pageCache.get(key);
  const stat = fs.statSync(path.join(WEB_DIR, file));
  if (cached && cached.mtime === stat.mtimeMs) return cached.html;

  const prefix = `${base}/`;
  const html = fs.readFileSync(path.join(WEB_DIR, file), 'utf8')
    // static assets are cached for an hour, so an update has to change the URL
    // or browsers keep running the previous panel against the new server
    .replace(/(href|src)="(app\.js|style\.css)"/g, `$1="$2?v=${ASSET_VERSION}"`)
    .replace(
      '</head>',
      `<base href="${prefix}">\n<script>window.__NEXV_BASE__=${JSON.stringify(prefix)};</script>\n</head>`
    );
  pageCache.set(key, { mtime: stat.mtimeMs, html });
  return html;
}

function sendPage(res, file, base) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(renderPage(file, base));
}

app.get('/login', (req, res) => {
  const base = normalizeBasePath(db.settings.webBasePath);
  if (auth.currentUser(req)) return res.redirect(`${base}/`);
  sendPage(res, 'login.html', base);
});

app.get('/', (req, res) => {
  const base = normalizeBasePath(db.settings.webBasePath);
  if (!auth.currentUser(req)) return res.redirect(`${base}/login`);
  sendPage(res, 'index.html', base);
});

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

    createServer(app, tls).listen(port, host, () => {
      const base = normalizeBasePath(db.settings.webBasePath);
      console.log(`[nexv] panel listening on ${scheme}://${host}:${port}${base}/`);
      // printed every start: without the path the panel cannot be reached
      console.log(`[nexv] web path: ${base || '/'}`);
      if (!tls) console.log('[nexv] TLS is off - set a certificate in Settings, or run: nexv cert <domain>');
      startJobs();
    });

    // subscription links advertise their own port, so serve them there too
    const subPort = Number(db.settings.subPort || 0);
    if (subPort && subPort !== port) {
      const subApp = express();
      subApp.disable('x-powered-by');
      subApp.set('trust proxy', true);
      subApp.get(/.*/, serveSubscription);
      createServer(subApp, tls)
        .listen(subPort, host, () => console.log(`[nexv] subscriptions listening on ${scheme}://${host}:${subPort}`))
        .on('error', (err) => console.error(`[nexv] subscription port ${subPort} unavailable:`, err.message));
    }
  });
}

module.exports = app;
module.exports.normalizeBasePath = normalizeBasePath;
