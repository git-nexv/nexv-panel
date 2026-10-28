'use strict';
/**
 * What somebody else left on this server.
 *
 * A box bought second-hand, or rented from somebody who ran a panel on it
 * before, usually still has that panel on it: its files, its service, its
 * database, and often its copy of Xray fighting this one over the same config
 * file. That is worth finding and worth removing, and it is what this does.
 *
 * What it deliberately does not do is work the other way round - list
 * everything on the disk and remove whatever is not ours. On a Linux server
 * that is rm -rf with a short whitelist. This panel runs on node, which needs
 * libc and the dynamic linker; the service needs systemd; getting back in
 * needs sshd and its host keys; Xray needs its binary. "Everything the panel
 * does not need" is most of an operating system, and there is no way to
 * compute that set that ends with a server still running. So nothing here
 * ever decides what to delete by elimination.
 *
 * Instead every removable thing is named in advance, in CATALOGUE below, and
 * the only paths this module will ever unlink are the ones written there. The
 * browser sends the id of a find, never a path, so there is nothing to
 * traverse out of and no way to ask for a path that is not on the list.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/* This panel's own things, which are never offered and never removed even if
   some future catalogue entry were to overlap them. */
const OURS = [
  process.env.NEXV_INSTALL_DIR || '/opt/nexv-panel',
  process.env.NEXV_DATA_DIR || '/etc/nexv/data',
  '/etc/nexv',
  '/usr/local/bin/nexv',
  '/etc/systemd/system/nexv.service',
  process.env.NEXV_XRAY_BIN || '/usr/local/bin/xray',
  process.env.NEXV_XRAY_CONFIG || '/usr/local/etc/xray/config.json',
  '/usr/local/etc/xray',
  '/etc/systemd/system/xray.service'
];

/*
 * Directories that are the system itself. Nothing at or above these is ever
 * removable, whatever a catalogue entry says - a belt to the braces above,
 * so that a typo in a path below takes nothing with it.
 */
const NEVER = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64',
  '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys',
  '/tmp', '/usr', '/var', '/usr/bin', '/usr/lib', '/usr/local', '/usr/sbin',
  '/usr/local/bin', '/usr/local/etc', '/usr/share', '/var/lib', '/var/log',
  '/etc/systemd', '/etc/systemd/system'
]);

/**
 * Every panel this knows how to recognise, with the exact places it puts
 * itself. Paths only - no globs, nothing computed - so what may be deleted is
 * readable here in full.
 */
const CATALOGUE = [
  {
    id: 'x-ui',
    name: '3x-ui / x-ui',
    about: 'Another Xray panel. It writes the same Xray config file as this one and restarts the same service, so the two undo each other.',
    services: ['x-ui'],
    paths: ['/usr/local/x-ui', '/etc/x-ui', '/usr/local/bin/x-ui', '/usr/bin/x-ui',
      '/etc/systemd/system/x-ui.service']
  },
  {
    id: 's-ui',
    name: 's-ui',
    about: 'Another Xray panel, by the same authors as 3x-ui.',
    services: ['s-ui'],
    paths: ['/usr/local/s-ui', '/etc/s-ui', '/usr/local/bin/s-ui',
      '/etc/systemd/system/s-ui.service']
  },
  {
    id: 'v2-ui',
    name: 'v2-ui',
    about: 'An older V2Ray panel that 3x-ui replaced.',
    services: ['v2-ui'],
    paths: ['/usr/local/v2-ui', '/etc/v2-ui', '/usr/local/bin/v2-ui',
      '/etc/systemd/system/v2-ui.service']
  },
  {
    id: 'marzban',
    name: 'Marzban',
    about: 'Another Xray panel, usually run in Docker.',
    services: ['marzban'],
    paths: ['/opt/marzban', '/var/lib/marzban', '/usr/local/bin/marzban',
      '/etc/systemd/system/marzban.service']
  },
  {
    id: 'marzneshin',
    name: 'Marzneshin',
    about: 'The panel that followed Marzban.',
    services: ['marzneshin'],
    paths: ['/etc/opt/marzneshin', '/var/lib/marzneshin', '/usr/local/bin/marzneshin']
  },
  {
    id: 'hiddify',
    name: 'Hiddify Manager',
    about: 'A whole server manager, not just a panel. It owns nginx and the firewall as well.',
    services: ['hiddify-panel', 'hiddify'],
    paths: ['/opt/hiddify-manager', '/opt/hiddify-config', '/opt/hiddify']
  },
  {
    id: 'xui-english',
    name: 'x-ui (original)',
    about: 'The first x-ui, which 3x-ui was forked from.',
    services: ['xui'],
    paths: ['/usr/local/xui', '/etc/xui', '/etc/systemd/system/xui.service']
  },
  {
    id: 'v2raya',
    name: 'v2rayA',
    about: 'A V2Ray client manager with a web interface.',
    services: ['v2raya'],
    paths: ['/usr/local/bin/v2raya', '/usr/lib/systemd/system/v2raya.service',
      '/etc/systemd/system/v2raya.service', '/etc/v2raya']
  }
];

/**
 * The only paths that may ever be unlinked: exactly the ones written in the
 * catalogue above, resolved, as a set.
 *
 * This is the real boundary, and it is an allow-list on purpose. Asking
 * "is this path dangerous?" is a question with endless wrong answers - some
 * string that resolves to /etc/shadow, a symlink, a path with .. in it - and
 * only one has to slip through. Asking "is this path one of the thirty we
 * named?" has no wrong answers. Nothing else is removable, whatever the rest
 * of this file is ever changed to.
 */
const ALLOWED = new Set(CATALOGUE.flatMap((e) => e.paths).map((p) => path.resolve(p)));

/** Whether this exact path is one the catalogue names, and still safe. */
function removable(target) {
  const full = path.resolve(String(target || ''));
  return ALLOWED.has(full) && !protectedPath(full);
}

/** Is this path one of ours, or part of the system itself? */
function protectedPath(target) {
  const full = path.resolve(target);
  if (NEVER.has(full)) return true;
  return OURS.some((ours) => {
    const mine = path.resolve(ours);
    return full === mine || full.startsWith(`${mine}${path.sep}`) || mine.startsWith(`${full}${path.sep}`);
  });
}

/**
 * How big something is, walking it ourselves rather than shelling out to du.
 *
 * Capped: a catalogue path that turned out to be a mount point, or a symlink
 * into somewhere enormous, must not turn a dashboard refresh into a disk
 * crawl. Over the cap it stops counting and says so.
 */
function sizeOf(target, cap) {
  const limit = Number(cap) || 40000;
  let bytes = 0;
  let files = 0;
  let capped = false;
  const stack = [target];
  while (stack.length) {
    if (files >= limit) { capped = true; break; }
    const here = stack.pop();
    let st;
    try { st = fs.lstatSync(here); } catch (_) { continue; }
    if (st.isSymbolicLink()) { files += 1; continue; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(here); } catch (_) { continue; }
      for (const name of entries) stack.push(path.join(here, name));
      continue;
    }
    bytes += st.size;
    files += 1;
  }
  return { bytes, files, capped };
}

function systemd() {
  return fs.existsSync(process.env.NEXV_SYSTEMD_DIR || '/run/systemd/system');
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

/** Whether a service exists and what it is doing. */
async function serviceState(name) {
  if (!systemd()) return { present: false, active: false };
  const active = await run('systemctl', ['is-active', name]);
  const enabled = await run('systemctl', ['is-enabled', name]);
  const known = active.out !== 'inactive' || enabled.out !== ''
    || /not-found/.test(enabled.err) === false;
  if (active.out === 'inactive' && /no such file|not-found/i.test(`${enabled.out}${enabled.err}`)) {
    return { present: false, active: false };
  }
  return { present: known, active: active.out === 'active', enabled: enabled.out === 'enabled' };
}

/**
 * What is actually on this server, out of everything the catalogue knows.
 *
 * Only entries with something really on disk come back, each with what it
 * would free and whether it is running - because a panel that is running is
 * one somebody may still be using, and that is worth saying before it goes.
 */
async function scan() {
  const found = [];
  for (const entry of CATALOGUE) {
    const present = entry.paths
      .filter((p) => removable(p))
      .filter((p) => fs.existsSync(p));
    if (!present.length) continue;

    let bytes = 0;
    let capped = false;
    const items = [];
    for (const p of present) {
      const size = sizeOf(p);
      bytes += size.bytes;
      capped = capped || size.capped;
      items.push({ path: p, bytes: size.bytes, files: size.files });
    }

    const services = [];
    for (const name of (entry.services || [])) {
      const state = await serviceState(name);
      if (state.present) services.push(Object.assign({ name }, state));
    }

    found.push({
      id: entry.id,
      name: entry.name,
      about: entry.about,
      bytes,
      capped,
      items,
      services,
      running: services.some((s) => s.active)
    });
  }
  return { found, scannedAt: Date.now() };
}

/**
 * Remove the finds named by id.
 *
 * The id is looked up in the catalogue here; the paths come from there and
 * never from the caller, so there is no path for a request to reach that the
 * catalogue does not already name. Every one is checked again against the
 * protected list immediately before it is unlinked.
 */
async function clean(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).map(String);
  const removed = [];
  const failed = [];
  let freed = 0;

  for (const entry of CATALOGUE) {
    if (!wanted.includes(entry.id)) continue;

    // a running service holds its files open and would put some back
    for (const name of (entry.services || [])) {
      const state = await serviceState(name);
      if (!state.present) continue;
      await run('systemctl', ['stop', name]);
      await run('systemctl', ['disable', name]);
    }

    for (const target of entry.paths) {
      // the allow-list, checked again at the last moment before anything goes
      if (!removable(target)) { failed.push({ path: target, why: 'not removable' }); continue; }
      if (!fs.existsSync(target)) continue;
      const size = sizeOf(target);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        freed += size.bytes;
        removed.push({ path: target, bytes: size.bytes });
      } catch (err) {
        failed.push({ path: target, why: err.message });
      }
    }
  }

  if (removed.length && systemd()) await run('systemctl', ['daemon-reload']);
  return { removed, failed, freed };
}

module.exports = { scan, clean, protectedPath, removable, sizeOf, CATALOGUE, OURS, NEVER, ALLOWED };
