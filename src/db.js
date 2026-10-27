'use strict';
/**
 * Tiny embedded JSON document store with atomic writes.
 * Chosen over sqlite so the panel installs with zero native build tooling.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.NEXV_DATA_DIR || '/etc/nexv/data';
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULTS = () => ({
  version: 1,
  settings: {
    panelPort: 2087,
    panelPath: '/',
    domain: '',
    subDomain: '',
    subPort: 2096,
    subPath: '/sub/',
    tgBotToken: '',
    tgAdminId: '',
    theme: 'dark',
    lang: 'en',
    // binding port 80 for a redirect is opt-in: it is a port the admin may
    // want for an inbound, and taking it unasked is a surprise
    httpRedirect: false,
    trafficResetDay: 1
  },
  users: [],        // panel admins
  inbounds: [],     // xray inbounds
  clients: [],      // per-inbound clients
  outbounds: [],    // xray outbounds beyond the built-in direct/blocked pair
  routing: [],      // routing rules, evaluated in order
  sessions: [],
  traffic: [],      // { clientId, up, down, at }
  logs: []
});

let cache = null;
let writeTimer = null;
/*
 * When this process last read or wrote the file. The terminal menu edits
 * db.json directly - that is how the port, the web path, a password reset and
 * a certificate are applied - and then restarts the panel. If the panel then
 * writes its own copy out on the way down, it puts back everything the admin
 * had just changed, and the command silently does nothing at all.
 *
 * (It only started doing that once the panel began exiting on SIGTERM. Before
 * that it was killed outright, and a killed process runs no exit handler, so
 * the edit survived by luck rather than design.)
 */
let lastTouched = 0;

function rememberFile() {
  try { lastTouched = fs.statSync(DB_FILE).mtimeMs; } catch (_) { lastTouched = 0; }
}

/** Has somebody else written the file since we last did? */
function changedElsewhere() {
  try { return fs.statSync(DB_FILE).mtimeMs !== lastTouched; } catch (_) { return false; }
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      const backup = `${DB_FILE}.corrupt.${Date.now()}`;
      fs.copyFileSync(DB_FILE, backup);
      console.error(`[db] unreadable database, moved to ${backup}:`, err.message);
      cache = DEFAULTS();
    }
  } else {
    cache = DEFAULTS();
  }
  rememberFile();
  // fill in keys added by newer versions
  const base = DEFAULTS();
  for (const key of Object.keys(base)) {
    if (cache[key] === undefined) cache[key] = base[key];
  }
  cache.settings = Object.assign({}, base.settings, cache.settings);
  return cache;
}

function flush() {
  if (!cache) return;
  ensureDir();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
  rememberFile();
}

/** Persist soon; batches bursts of writes into one disk hit. */
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try { flush(); } catch (err) { console.error('[db] save failed:', err.message); }
  }, 150);
}

function saveNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  flush();
}

const db = {
  get data() { return load(); },
  get settings() { return load().settings; },
  save,
  saveNow,
  id: () => crypto.randomUUID(),
  DATA_DIR,
  DB_FILE
};

/*
 * On the way out, write only what has not been written yet - and not even
 * that if the file has moved under us.
 *
 * Flushing unconditionally meant every shutdown rewrote the whole store from
 * memory, which is how `nexv port`, `nexv url` and the password reset came to
 * do nothing: they edit the file and restart the panel, and the panel put its
 * stale copy back on the way down. There is nothing to write unless a
 * debounced save is still outstanding, and if somebody has edited the file in
 * the meantime theirs is the newer truth.
 */
process.on('exit', () => {
  if (!writeTimer) return;
  if (changedElsewhere()) {
    console.warn('[db] the database changed on disk while shutting down - keeping that version');
    return;
  }
  try { saveNow(); } catch (_) { /* nothing more we can do here */ }
});

module.exports = db;
