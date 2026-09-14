'use strict';
/**
 * Updating the panel from inside the panel.
 *
 * The update restarts the panel service, so the updater cannot be a child of
 * the panel: systemd kills the whole control group on restart and the update
 * would die halfway through. `systemd-run` puts it in a transient unit of its
 * own, which survives. Without systemd there is nothing safe to do from here
 * and the caller is told to run `nexv update` in a terminal instead.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DATA_DIR = process.env.NEXV_DATA_DIR || '/etc/nexv/data';
const LOG_FILE = path.join(DATA_DIR, 'update.log');
const STATE_FILE = path.join(DATA_DIR, 'update.json');
const CLI = process.env.NEXV_CLI || '/usr/local/bin/nexv';
const UNIT = 'nexv-panel-update';

function has(binary) {
  try {
    execFileSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

/** Can this process actually run the update? Returns the reason when it cannot. */
function available() {
  if (process.platform !== 'linux') return { ok: false, reason: 'updating from the panel only works on the server itself' };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { ok: false, reason: 'the panel is not running as root - update with: nexv update' };
  }
  if (!fs.existsSync(CLI)) return { ok: false, reason: `${CLI} is missing - update with: nexv update` };
  if (!has('systemd-run')) return { ok: false, reason: 'systemd-run is missing - update with: nexv update' };
  return { ok: true };
}

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (_) { /* the update itself matters more than the bookkeeping */ }
}

/**
 * Kick off the update. Returns once it is handed to systemd - the panel is
 * restarted by the updater a minute or so later, so nothing here waits for it.
 */
function start({ from, to }) {
  const ready = available();
  if (!ready.ok) throw new Error(ready.reason);

  try { fs.writeFileSync(LOG_FILE, '', { mode: 0o600 }); } catch (_) { /* keep going */ }
  writeState({ startedAt: Date.now(), from, to, state: 'running' });

  /*
   * systemd-run's own complaints go into the same log the dialog is already
   * reading. A box where the binary exists but the bus does not - a container,
   * mostly - would otherwise accept the button, do nothing, and leave somebody
   * watching an empty box until the five-minute deadline.
   */
  let handle = 'ignore';
  try { handle = fs.openSync(LOG_FILE, 'a', 0o600); } catch (_) { /* ignore is fine */ }

  // the unit is transient and --collect clears it away when it is done
  const child = spawn('systemd-run', [
    '--unit', UNIT, '--collect', '--quiet',
    '/bin/sh', '-c', `exec ${CLI} update >>${LOG_FILE} 2>&1`
  ], { detached: true, stdio: ['ignore', handle, handle] });

  child.on('exit', (code) => {
    if (code) {
      try {
        fs.appendFileSync(LOG_FILE,
          `\nCould not hand the update to systemd (exit ${code}). Run it on the server: nexv update\n`);
      } catch (_) { /* the message was the last thing we could do */ }
      writeState({ startedAt: Date.now(), from, to, state: 'failed' });
    }
    if (handle !== 'ignore') { try { fs.closeSync(handle); } catch (_) { /* already gone */ } }
  });
  child.unref();
  return { from, to };
}

/** What the last update did, plus the tail of its output. */
function state(lines = 40) {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { /* never updated */ }
  let log = '';
  try {
    log = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-lines).join('\n').trim();
  } catch (_) { /* no log yet */ }
  return { ...(info || {}), log };
}

module.exports = { available, start, state };
