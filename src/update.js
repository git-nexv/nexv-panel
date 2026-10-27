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

/** Long enough for a slow link to finish; past it, something has gone wrong. */
const RUN_LIMIT_MS = 20 * 60 * 1000;

/** The last thing the updater complained about, for the one-line summary. */
function failureLine(log) {
  const lines = String(log || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    // the CLI marks its own errors with [x]
    if (lines[i].startsWith('[x]')) return lines[i].replace(/^\[x\]\s*/, '');
  }
  return '';
}

/**
 * What the last update did, plus the tail of its output.
 *
 * The state on disk only ever said "running": nothing wrote the end of it,
 * because the thing that would have written it - the panel - is the thing the
 * updater restarts halfway through. So the outcome is worked out here instead
 * of recorded: the panel that answers this question is the one the update
 * produced, and its own version is the answer.
 *
 * That is what makes an update legible after the fact. Before, a page that
 * missed the moment of the restart had no way of ever learning what happened,
 * which is why reloading it seemed to fix things at random.
 */
function state(lines = 40) {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { /* never updated */ }
  let log = '';
  try {
    log = fs.readFileSync(LOG_FILE, 'utf8')
      /*
       * git draws its progress counter by rewinding the line with \r and
       * writing over itself. On a terminal that is one line counting up; in a
       * file it is every value it ever showed, joined end to end. Only the last
       * thing written to a line was ever meant to be read.
       */
      .split('\n')
      .map((line) => {
        const i = line.lastIndexOf('\r');
        return i < 0 ? line : line.slice(i + 1);
      })
      .slice(-lines).join('\n').trim();
  } catch (_) { /* no log yet */ }

  const out = { ...(info || {}), log };
  if (out.state === 'running') {
    const current = require('../package.json').version;
    const age = Date.now() - (Number(out.startedAt) || 0);
    /* the updater marks its own end, which is the only signal that separates
       "still working" from "stopped without restarting anything" */
    if (/^UPDATE-FAILED$/m.test(log)) {
      out.state = 'failed';
      out.reason = failureLine(log) || 'the updater stopped';
    } else if (out.to && current === out.to) {
      // we are the panel it produced
      out.state = 'done';
      out.finishedAt = out.finishedAt || Date.now();
    } else if (/^UPDATE-DONE$/m.test(log)) {
      out.state = 'done';
      out.finishedAt = out.finishedAt || Date.now();
    } else if (age > RUN_LIMIT_MS) {
      out.state = 'failed';
      out.reason = 'it did not finish in time';
    }
  }
  // the marker is for us, not for the person reading the output
  out.log = String(out.log || '').replace(/^UPDATE-(DONE|FAILED)$/gm, '').trim();
  out.current = require('../package.json').version;
  out.running = out.state === 'running';
  out.age = out.startedAt ? Date.now() - Number(out.startedAt) : 0;
  return out;
}

/**
 * Put the record beyond "running" for good.
 *
 * state() can work the outcome out every time, but only while the record is
 * there to work from; writing it down once means a later page load gets the
 * answer without re-deriving it, and that the "updated to x" note is shown
 * once rather than on every load forever.
 */
function settle() {
  const now = state();
  if (!now.startedAt || now.state === 'running') return now;
  writeState({
    startedAt: now.startedAt,
    finishedAt: now.finishedAt || Date.now(),
    from: now.from,
    to: now.to,
    state: now.state,
    reason: now.reason || '',
    announced: true
  });
  return now;
}

module.exports = { available, start, state, settle, RUN_LIMIT_MS };
