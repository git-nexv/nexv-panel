'use strict';
/** Host metrics for the dashboard: cpu, memory, disk, network, uptime. */
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let lastCpu = null;

function cpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  let percent = 0;
  if (lastCpu) {
    const dTotal = total - lastCpu.total;
    const dIdle = idle - lastCpu.idle;
    if (dTotal > 0) percent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  lastCpu = { idle, total };
  return { percent: Number(percent.toFixed(1)), cores: cpus.length, model: cpus[0] ? cpus[0].model : '' };
}

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  let available = free;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    if (m) available = Number(m[1]) * 1024;
  } catch (_) { /* not linux */ }
  return { total, used: total - available, percent: Number((((total - available) / total) * 100).toFixed(1)) };
}

function netTotals() {
  let rx = 0, tx = 0;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    for (const line of lines) {
      const [nameRaw, rest] = line.split(':');
      if (!rest) continue;
      const name = nameRaw.trim();
      if (name === 'lo' || name.startsWith('docker') || name.startsWith('veth') || name.startsWith('br-')) continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] || 0;
      tx += cols[8] || 0;
    }
  } catch (_) { /* not linux */ }
  return { rx, tx };
}

let lastNet = null;
let lastSpeed = { rx: 0, tx: 0 };

function network() {
  const now = Date.now();
  const totals = netTotals();
  if (!lastNet) {
    lastNet = { at: now, rx: totals.rx, tx: totals.tx };
    return { total: totals, speed: lastSpeed };
  }
  /*
   * The window belongs to whoever asked last, not to this caller. A second
   * dashboard - another tab, a reload, the CLI - asking a moment later used to
   * divide a whole window's bytes by a sliver of a second and report an
   * impossible rate, so a window shorter than a second keeps the last figure.
   */
  const dt = (now - lastNet.at) / 1000;
  if (dt >= 1) {
    lastSpeed = {
      rx: Math.max(0, (totals.rx - lastNet.rx) / dt),
      tx: Math.max(0, (totals.tx - lastNet.tx) / dt)
    };
    lastNet = { at: now, rx: totals.rx, tx: totals.tx };
  }
  return { total: totals, speed: lastSpeed };
}

let diskCache = { at: 0, value: { total: 0, used: 0, percent: 0 } };
/** df spawns a process; disk usage moves slowly, so a short cache is plenty. */
function disk() {
  if (Date.now() - diskCache.at < 20000) return Promise.resolve(diskCache.value);
  return new Promise((resolve) => {
    execFile('df', ['-kP', '/'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(diskCache.value);
      const line = (stdout || '').split('\n')[1] || '';
      const cols = line.trim().split(/\s+/);
      const total = Number(cols[1] || 0) * 1024;
      const used = Number(cols[2] || 0) * 1024;
      diskCache = {
        at: Date.now(),
        value: { total, used, percent: total ? Number(((used / total) * 100).toFixed(1)) : 0 }
      };
      resolve(diskCache.value);
    });
  });
}

/**
 * A single provider is a single point of failure - blocked, rate limited, or
 * simply down - and without an IP the panel cannot build share links. Try a
 * few in turn, then fall back to the host's own address.
 */
const IP_PROVIDERS = [
  'https://api4.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://v4.ident.me',
  'https://ipv4.myexternalip.com/raw'
];

function isIPv4(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((n) => Number(n) <= 255);
}

function publicIP() {
  const attempts = IP_PROVIDERS.map((url) => `curl -4 -s --max-time 3 ${url}`).join(' || ');
  return new Promise((resolve) => {
    execFile('sh', ['-c', `${attempts} || hostname -I | awk "{print \\$1}"`],
      { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
        const ip = (stdout || '').trim().split(/\s+/)[0] || '';
        resolve(isIPv4(ip) ? ip : '');
      });
  });
}

async function snapshot() {
  return {
    cpu: cpuUsage(),
    memory: memory(),
    disk: await disk(),
    network: network(),
    uptime: os.uptime(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    loadavg: os.loadavg()
  };
}

module.exports = { snapshot, publicIP };
