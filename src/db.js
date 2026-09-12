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

process.on('exit', () => { try { saveNow(); } catch (_) {} });

module.exports = db;
