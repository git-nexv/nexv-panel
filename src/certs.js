'use strict';
/**
 * Hand Xray a certificate it is allowed to open.
 *
 * The panel runs as root. Xray does not - the official unit starts it as
 * `nobody` - and certificates live in places only root may walk into:
 * /etc/letsencrypt/live, or /root/cert/<domain>, which is where the other
 * panel puts them and therefore what an imported inbound points at. Root can
 * read the file, so `xray run -test` as root passes and the panel believes the
 * config is good; the service then dies with
 *
 *     open /root/cert/example.com/fullchain.pem: permission denied
 *
 * Loosening /root is not an answer. Instead the panel keeps a copy of every
 * certificate an inbound uses under a directory the service user can read, and
 * writes the copy's path into config.json. The panel's own HTTPS listener goes
 * on using the original, and so does whatever renews it: the copy is refreshed
 * whenever the original changes, which is checked on every config write and
 * once a minute besides.
 */
const fs = require('fs');
const path = require('path');

const STORE = process.env.NEXV_CERT_STORE || '/usr/local/etc/xray/certs';

/* Every pair the config has asked for, so renewals can be picked up later. */
const tracked = new Map();

/** A short, stable, filesystem-safe name for one certificate pair. */
function slugFor(certPath) {
  const domain = path.basename(path.dirname(certPath)).replace(/[^A-Za-z0-9._-]/g, '');
  const stamp = Buffer.from(certPath).toString('base64url').slice(-8);
  return `${domain && domain !== '.' ? domain : 'cert'}-${stamp}`;
}

/** Does the copy already match the original, byte for byte as far as we care? */
function isCurrent(src, copy) {
  try {
    const a = fs.statSync(src);
    const b = fs.statSync(copy);
    return a.size === b.size && Math.floor(a.mtimeMs) <= Math.floor(b.mtimeMs);
  } catch (_) {
    return false;
  }
}

/*
 * Copy through a temporary file in the same directory and rename over the old
 * one: Xray may be reading it at this moment, and a half-written certificate
 * is worse than a stale one.
 */
function place(src, dest, mode) {
  const tmp = `${dest}.new`;
  fs.copyFileSync(src, tmp);          // follows symlinks, so archive/ links become real files
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, dest);
}

/**
 * Write (or refresh) the readable copy of one pair.
 * Returns the copy's paths, or null if anything went wrong - in which case the
 * caller keeps the original paths and Xray reports the real problem itself.
 */
function mirror(certPath, keyPath, gid) {
  const dir = path.join(STORE, slugFor(certPath));
  const cert = path.join(dir, 'fullchain.pem');
  const key = path.join(dir, 'privkey.pem');

  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
    let changed = false;
    if (!isCurrent(certPath, cert) || !isCurrent(keyPath, key)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      place(certPath, cert, 0o644);
      place(keyPath, key, 0o640);
      changed = true;
    }
    /* the private key stays unreadable to the world; the service user's own
       group is what opens it */
    if (changed) {
      fs.chmodSync(STORE, 0o755);
      fs.chmodSync(dir, 0o755);
      if (gid !== null && gid !== undefined) {
        try { fs.chownSync(dir, 0, gid); } catch (_) { /* not root, or no such group */ }
        try { fs.chownSync(cert, 0, gid); } catch (_) { /* as above */ }
        try { fs.chownSync(key, 0, gid); } catch (_) { /* as above */ }
      }
    }
    return { cert, key, changed };
  } catch (err) {
    console.error('[certs] could not mirror', certPath, '-', err.message);
    return null;
  }
}

/**
 * The paths to put in config.json for this pair.
 *
 * `owner` is {user, gid} for the account Xray runs as. When that is root there
 * is nothing to solve and the originals are used untouched, so a server that
 * works today keeps working exactly as it did.
 */
function forXray(certPath, keyPath, owner) {
  if (!certPath || !keyPath) return { cert: certPath, key: keyPath };
  if (!owner || !owner.user || owner.user === 'root') return { cert: certPath, key: keyPath };
  if (certPath.startsWith(`${STORE}/`)) return { cert: certPath, key: keyPath };

  const copy = mirror(certPath, keyPath, owner.gid);
  if (!copy) return { cert: certPath, key: keyPath };
  tracked.set(certPath, { keyPath, gid: owner.gid });
  return { cert: copy.cert, key: copy.key };
}

/**
 * Refresh every copy whose original has moved on - certbot replaced it at
 * three in the morning and nothing rewrote the config. Returns true when
 * something changed, which is the caller's cue to restart Xray.
 */
function refresh() {
  let changed = false;
  for (const [certPath, meta] of tracked) {
    const copy = mirror(certPath, meta.keyPath, meta.gid);
    if (copy && copy.changed) {
      changed = true;
      console.log('[certs] refreshed the readable copy of', certPath);
    }
  }
  return changed;
}

module.exports = { forXray, refresh, STORE, tracked };
