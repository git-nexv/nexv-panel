'use strict';
/**
 * Is there a newer panel released?
 *
 * The answer is read from the repository's package.json on the tracked branch.
 * A server behind a filter may not reach GitHub at all, so every failure is
 * silent and simply means "no update known" - never an error in the UI.
 *
 * Two things matter here beyond fetching a number.
 *
 * The answer has to be *fresh*, or the header key never lights up on its own.
 * It used to be cached for six hours and refreshed only when something asked
 * with force=1 - which nothing did except a person clicking the key. A release
 * could therefore sit unannounced for most of a day, and the only way to see
 * it was to click the very thing that was supposed to tell you. The cache is
 * now kept warm by a timer instead, so the number is at most ten minutes old
 * whether or not anybody is looking.
 *
 * And the answer has to be *instant*. Reaching GitHub from a filtered server
 * can take the full timeout, and /version is on the path of every page load.
 * So a read never waits on the network: it returns what is cached and lets the
 * refresh happen behind it. Only the first call of the process, which has
 * nothing cached, waits at all.
 */
const { execFile } = require('child_process');

const REPO = process.env.NEXV_REPO_RAW
  || 'https://raw.githubusercontent.com/git-nexv/nexv-panel';
const BRANCH = process.env.NEXV_BRANCH || 'main';

/*
 * How long a fetched number is treated as current, for both the timer and a
 * read that finds it stale. Ten minutes is the gap between publishing a release
 * and the key lighting up by itself; six curls an hour is nothing to pay for
 * that. Overridable, mostly so this is testable at a sane speed.
 */
const INTERVAL_MS = Math.max(1000, Number(process.env.NEXV_VERSION_INTERVAL_MS) || 10 * 60 * 1000);

const current = require('../package.json').version;
let cache = { at: 0, latest: null };
let inFlight = null;

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

/**
 * One fetch at a time. Several tabs asking at once - or the timer landing on
 * top of a click - must not turn into several curls.
 */
function refresh() {
  if (inFlight) return inFlight;
  inFlight = fetchLatest().then((latest) => {
    // a failed reach keeps the last known answer rather than forgetting it
    if (latest) cache = { at: Date.now(), latest };
    inFlight = null;
    return latest;
  });
  return inFlight;
}

async function check(force = false) {
  const age = Date.now() - cache.at;
  if (force || !cache.latest) {
    // nothing to show yet, or somebody asked for the truth right now
    await refresh();
  } else if (age > INTERVAL_MS) {
    // hand back what we have and freshen it behind the answer
    refresh();
  }
  return report(cache.latest);
}

function report(latest) {
  return {
    current,
    latest: latest || current,
    updateAvailable: !!latest && isNewer(current, latest),
    checkedAt: cache.at
  };
}

/**
 * Keep the number warm for the life of the process. Unref'd, so it never holds
 * the panel open on shutdown.
 */
function watch() {
  refresh();
  const timer = setInterval(refresh, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { check, isNewer, current, watch, refresh };
