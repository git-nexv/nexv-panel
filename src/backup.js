'use strict';
/**
 * The panel's whole store, as a file somebody can keep.
 *
 * This used to live inside the download route, which meant the only way to
 * get a backup was to be sitting in front of the panel with a browser. The
 * bot can hand one over too now - on a schedule, or on demand - so the shape
 * of a backup had to stop being a detail of one HTTP handler.
 *
 * Three things never go in the file. The session secret, or every cookie this
 * server has ever issued would be forgeable from a backup that leaked; the
 * sessions themselves, which belong to this machine and nowhere else; and the
 * server's own login password, because a backup is the one part of all this
 * that leaves the machine - it is sent to Telegram and sits in a chat, and
 * the root password of the box must not be in it. The rest of that setting
 * travels, so a restore still knows whether the automatic change was on.
 * Everything else goes in, the bot's token and plans included - a restore
 * that came back without them is not a restore.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

/*
 * The certificate and key the panel is actually using.
 *
 * These are the one part of the setup that lives on the disk rather than in
 * the store: settings hold a path, and a backup carrying the path and not the
 * file restores a panel that points at nothing. On a new server that is a
 * panel with no HTTPS and a subscription link nobody's app will open, which
 * is not what "restored" should mean.
 *
 * Only the four settings that name a certificate are read, and only files -
 * no directories, no links out to somewhere else - and nothing above a size a
 * certificate could plausibly be.
 */
const CERT_KEYS = ['certFile', 'keyFile', 'panelCertFile', 'panelKeyFile'];
const MAX_CERT_BYTES = 256 * 1024;

function certPaths() {
  const s = db.settings || {};
  const out = [];
  for (const key of CERT_KEYS) {
    const p = String(s[key] || '').trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function certFiles() {
  const out = {};
  for (const p of certPaths()) {
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > MAX_CERT_BYTES) continue;
      out[p] = fs.readFileSync(p, 'utf8');
    } catch (_) { /* named but not there: nothing to carry */ }
  }
  return out;
}

/** The backup, as a plain object. */
function dump() {
  const out = JSON.parse(JSON.stringify(db.data));
  if (out.settings) delete out.settings.sessionSecret;
  if (out.server) delete out.server.password;
  out.sessions = [];
  out.files = certFiles();
  return out;
}

/**
 * Put the certificates from a backup back, and say where they went.
 *
 * The names here are constants and the directory is the panel's own. The
 * backup supplies the contents of a certificate and nothing else - not where
 * it goes, not what it is called. That matters because a restore is an
 * upload: whoever hands one in chooses every byte of it, and this panel runs
 * as root. If the file could name its own destination, "restore a backup"
 * would be "write any file on this server as root", and the panel would be
 * handing over the machine to anybody who could get a file in front of it.
 *
 * So the incoming paths are used only to work out which of the four
 * certificates each blob was, and then thrown away.
 */
const RESTORE_NAMES = {
  certFile: 'xray.crt',
  keyFile: 'xray.key',
  panelCertFile: 'panel.crt',
  panelKeyFile: 'panel.key'
};

function restoreCerts(incoming) {
  const files = (incoming && incoming.files && typeof incoming.files === 'object') ? incoming.files : null;
  if (!files) return [];
  const settings = (incoming && incoming.settings) || {};
  const dir = path.join(db.DATA_DIR, 'certs');
  const written = [];

  for (const key of CERT_KEYS) {
    const named = String(settings[key] || '').trim();
    if (!named) continue;
    const body = files[named];
    if (typeof body !== 'string' || !body || body.length > MAX_CERT_BYTES) continue;
    // a certificate is text; anything else is not one, whatever it is called
    if (!/-----BEGIN [A-Z ]+-----/.test(body)) continue;

    const target = path.join(dir, RESTORE_NAMES[key]);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, body, { mode: /key/i.test(key) ? 0o600 : 0o644 });
      written.push({ key, path: target });
    } catch (_) { /* reported by whoever asked for the restore */ }
  }
  return written;
}

/** The same thing as the bytes that go in the file. */
function text() {
  return JSON.stringify(dump(), null, 2);
}

/** Two digits, because a time is not a time with a bare 3 in it. */
function pad(n) { return String(n).padStart(2, '0'); }

/**
 * A name that sorts, and that says when it was taken in the admin's own day
 * rather than in UTC - a backup labelled 23:30 that was really taken at three
 * in the morning is a backup nobody can match to anything.
 */
function filename(at, offsetMinutes) {
  const when = new Date((at || Date.now()) + (Number(offsetMinutes) || 0) * 60000);
  return `nexv-${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`
    + `-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}.json`;
}

/** A line or two about what is in it, for whoever receives the file. */
function summary() {
  const d = db.data;
  const b = d.bot || {};
  return {
    inbounds: (d.inbounds || []).length,
    clients: (d.clients || []).length,
    plans: (b.plans || []).length,
    resellers: (d.resellers || []).length,
    bot: !!b.token
  };
}

module.exports = {
  dump, text, filename, summary, pad,
  certPaths, certFiles, restoreCerts, CERT_KEYS, MAX_CERT_BYTES
};
