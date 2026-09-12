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
function network() {
  const now = Date.now();
  const totals = netTotals();
  let rxSpeed = 0, txSpeed = 0;
  if (lastNet) {
    const dt = (now - lastNet.at) / 1000;
    if (dt > 0) {
      rxSpeed = Math.max(0, (totals.rx - lastNet.rx) / dt);
      txSpeed = Math.max(0, (totals.tx - lastNet.tx) / dt);
    }
  }
  lastNet = { at: now, rx: totals.rx, tx: totals.tx };
  return { total: totals, speed: { rx: rxSpeed, tx: txSpeed } };
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

function publicIP() {
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'curl -4 -s --max-time 3 https://api.ipify.org || hostname -I | awk "{print \\$1}"'],
      { encoding: 'utf8', timeout: 6000 }, (err, stdout) => resolve((stdout || '').trim()));
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
