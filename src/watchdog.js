'use strict';
/**
 * Keep Xray running without anyone watching.
 *
 * Xray can go down for reasons the panel cannot see at the moment it happens -
 * a certificate renewed under root that the service user can no longer read, a
 * port taken by something else, an OOM kill. Until now the admin had to notice
 * and run the repair from the terminal menu. This does the same work on its
 * own: when the service is down and there is something for it to serve, it
 * runs the repair the CLI already implements and writes what happened to the
 * panel's event log.
 */
const fs = require('fs');
const { execFile } = require('child_process');

const db = require('./db');
const xray = require('./xray');

const NEXV_CLI = process.env.NEXV_CLI || '/usr/local/bin/nexv';
const EVERY = Number(process.env.NEXV_WATCHDOG_SECONDS || 60) * 1000;
const CALM = 5;            // consecutive failures before backing off
const BACKOFF = 10;        // how many times slower to try after that

const state = { ticks: 0, failures: 0, lastMessage: '', repairs: 0, running: false };

function log(type, message) {
  const d = db.data;
  d.logs.unshift({ at: Date.now(), type, message });
  if (d.logs.length > 500) d.logs.length = 500;
  db.save();
}

function run(cmd, args, timeout, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', env: env || process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', failure: err ? err.message : '' });
    });
  });
}

function hasSystemd() {
  return fs.existsSync('/run/systemd/system');
}

async function isRunning() {
  const result = await run('systemctl', ['is-active', '--quiet', 'xray'], 8000);
  return result.ok;
}

/** Nothing enabled means xray has no work, and being down is not a fault. */
function hasWork() {
  return (db.data.inbounds || []).some((inbound) => inbound.enable !== false);
}

async function check() {
  if (state.running) return;
  state.running = true;
  try {
    if (!hasSystemd() || !hasWork()) return;
    if (await isRunning()) {
      if (state.failures) {
        log('xray', 'xray is running again');
        state.failures = 0;
        state.lastMessage = '';
      }
      return;
    }

    // back off once it is clear the problem needs a person
    if (state.failures >= CALM && state.ticks % BACKOFF !== 0) return;

    const repair = fs.existsSync(NEXV_CLI)
      ? await run(NEXV_CLI, ['xray-fix'], 120000, { ...process.env, NEXV_ASSUME_YES: '1' })
      : { ok: false, failure: 'the nexv command is not installed' };

    if (repair.ok && await isRunning()) {
      state.repairs++;
      state.failures = 0;
      log('xray', 'xray was down and has been started again');
      return;
    }

    // the CLI could not do it; say why, but only when the reason changes
    const why = xray.messageOf(repair) || 'xray is down and could not be restarted';
    state.failures++;
    if (why !== state.lastMessage) {
      state.lastMessage = why;
      log('xray', `xray is down: ${why}`);
    }
  } catch (err) {
    // a watchdog that throws is worse than no watchdog
    console.error('[watchdog]', err.message);
  } finally {
    state.running = false;
  }
}

function start() {
  if (!hasSystemd()) return null;
  const timer = setInterval(() => { state.ticks++; check(); }, EVERY);
  timer.unref?.();
  // give the panel a moment to finish starting before the first look
  setTimeout(() => check(), 15000).unref?.();
  return timer;
}

module.exports = { start, check, state };
