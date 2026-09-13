'use strict';
/**
 * Is there a newer panel released?
 *
 * The answer is read from the repository's package.json on the tracked branch.
 * A server behind a filter may not reach GitHub at all, so every failure is
 * silent and simply means "no update known" - never an error in the UI.
 */
const { execFile } = require('child_process');

const REPO = process.env.NEXV_REPO_RAW
  || 'https://raw.githubusercontent.com/git-nexv/nexv-panel';
const BRANCH = process.env.NEXV_BRANCH || 'main';
const CACHE_MS = 6 * 60 * 60 * 1000;

const current = require('../package.json').version;
let cache = { at: 0, latest: null };

/** Compare two dotted versions; returns true when `b` is newer than `a`. */
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) return true;
    if ((pb[i] || 0) < (pa[i] || 0)) return false;
  }
  return false;
}

function fetchLatest() {
  return new Promise((resolve) => {
    execFile('curl', [
      '-fsSL', '--max-time', '6', `${REPO}/${BRANCH}/package.json`
    ], { encoding: 'utf8', timeout: 9000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout).version || null);
      } catch (_) { resolve(null); }
    });
  });
}

async function check(force = false) {
  if (!force && cache.latest && Date.now() - cache.at < CACHE_MS) {
    return report(cache.latest);
  }
  const latest = await fetchLatest();
  if (latest) cache = { at: Date.now(), latest };
  return report(latest || cache.latest);
}

function report(latest) {
  return {
    current,
    latest: latest || current,
    updateAvailable: !!latest && isNewer(current, latest)
  };
}

module.exports = { check, isNewer, current };
