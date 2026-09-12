'use strict';
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

app.get('/login', (req, res) => res.sendFile(path.join(WEB_DIR, 'login.html')));
app.get('*', (req, res) => {
  if (!auth.currentUser(req)) {
    // redirect back through the base path, which was stripped from req.url
    const base = normalizeBasePath(db.settings.webBasePath);
    return res.redirect(`${base}/login`);
  }
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

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

if (require.main === module) {
  bootstrap().then(() => {
    const port = Number(process.env.NEXV_PORT || db.settings.panelPort || 2087);
    const host = process.env.NEXV_HOST || '0.0.0.0';
    app.listen(port, host, () => {
      const base = normalizeBasePath(db.settings.webBasePath);
      console.log(`[nexv] panel listening on http://${host}:${port}${base}/`);
      // printed every start: without the path the panel cannot be reached
      console.log(`[nexv] web path: ${base || '/'}`);
      startJobs();
    });

    // subscription links advertise their own port, so serve them there too
    const subPort = Number(db.settings.subPort || 0);
    if (subPort && subPort !== port) {
      const subApp = express();
      subApp.disable('x-powered-by');
      subApp.set('trust proxy', true);
      subApp.get(/.*/, serveSubscription);
      subApp.listen(subPort, host, () => console.log(`[nexv] subscriptions listening on http://${host}:${subPort}`))
        .on('error', (err) => console.error(`[nexv] subscription port ${subPort} unavailable:`, err.message));
    }
  });
}

module.exports = app;
module.exports.normalizeBasePath = normalizeBasePath;
