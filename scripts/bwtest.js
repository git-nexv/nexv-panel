'use strict';
/**
 * bwtest - how much bandwidth does the link to your server really carry?
 *
 * A ping says nothing about throughput, and a browser speed test measures the
 * path to some third party's node, not to YOUR server. This measures the real
 * thing: raw TCP between this machine and your server, in both directions, over
 * several parallel streams so that one connection's window/latency ceiling does
 * not cap the result. Same idea as iperf, in one dependency-free file that runs
 * anywhere Node 18+ does.
 *
 * Two sides, one file:
 *   On the server (the IP you want to test):   node bwtest.js server
 *   On your own machine:                        node bwtest.js client <server-ip>
 *
 * The client runs a download test (server -> you) and an upload test
 * (you -> server). "Upload" is what the server RECEIVES - the "ورودی" figure -
 * so it is counted on the server itself and reported back, leaving no doubt
 * about how much traffic your server can actually take in.
 */
const net = require('net');

const MAGIC = 'NEXVBW1';
const DEFAULTS = {
  port: 5201,        // iperf's port, so a firewall hole may already exist
  time: 10,          // seconds per direction
  streams: 4,        // parallel TCP connections (needed to fill a fat/long link)
  chunk: 128 * 1024, // bytes per write
};

/* ----------------------------------------------------------------- helpers */

function fmtBits(bps) {
  if (!isFinite(bps) || bps < 0) bps = 0;
  if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps';
  if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
  if (bps >= 1e3) return (bps / 1e3).toFixed(2) + ' Kbps';
  return bps.toFixed(0) + ' bps';
}
function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + ' KB';
  return n + ' B';
}
function fmtRate(bytesPerSec) { return fmtBytes(bytesPerSec) + '/s'; }

/* Read one newline-terminated JSON header off a socket, then hand the socket
 * (and any bytes that arrived after the header) to a callback. */
function readHeader(sock, cb) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > 4096) { sock.destroy(); } // no header worth this much
      return;
    }
    sock.removeListener('data', onData);
    let hdr = null;
    try { hdr = JSON.parse(buf.slice(0, nl).toString('utf8')); } catch {}
    cb(hdr, buf.slice(nl + 1));
  };
  sock.on('data', onData);
}

/* ------------------------------------------------------------------ server */

function runServer(opts) {
  const chunk = Buffer.allocUnsafe(DEFAULTS.chunk); // reused; contents irrelevant
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {}); // a client that walks away is not our problem

    readHeader(sock, (hdr, rest) => {
      if (!hdr || hdr.magic !== MAGIC) { sock.destroy(); return; }
      const peer = sock.remoteAddress ? sock.remoteAddress.replace(/^::ffff:/, '') : '?';

      if (hdr.dir === 'down') {
        // The client wants to download: blast until it hangs up.
        console.log(`[${new Date().toISOString()}] download test from ${peer}`);
        let stopped = false;
        sock.on('close', () => { stopped = true; });
        const pump = () => {
          if (stopped || sock.destroyed) return;
          let ok = true;
          while (ok && !stopped && !sock.destroyed) ok = sock.write(chunk);
          if (!stopped && !sock.destroyed) sock.once('drain', pump);
        };
        pump();
        return;
      }

      if (hdr.dir === 'up') {
        // The client uploads: WE are the receiver, so we are the authority on
        // how much actually got in. Count bytes, time from the first one, and
        // report the verdict back when the client half-closes.
        console.log(`[${new Date().toISOString()}] upload test from ${peer}`);
        let bytes = rest.length;
        let startAt = rest.length ? Date.now() : 0;
        sock.on('data', (d) => {
          if (!startAt) startAt = Date.now();
          bytes += d.length;
        });
        sock.on('end', () => {
          const ms = startAt ? Date.now() - startAt : 0;
          try { sock.end(JSON.stringify({ bytes, ms }) + '\n'); } catch {}
          const mbps = ms ? (bytes * 8) / (ms / 1000) : 0;
          console.log(`[${new Date().toISOString()}]   received ${fmtBytes(bytes)} in ${(ms/1000).toFixed(1)}s = ${fmtBits(mbps)}`);
        });
        return;
      }

      sock.destroy();
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`پورت ${opts.port} در حال استفاده است. با --port یک پورت دیگر بدهید.`);
    else console.error('خطای سرور:', e.message);
    process.exit(1);
  });

  server.listen(opts.port, () => {
    console.log('NexV bwtest server');
    console.log(`گوش می‌دهد روی پورت ${opts.port} (TCP) — برای توقف Ctrl+C`);
    console.log('حالا روی سیستم خودت اجرا کن:');
    console.log(`    node bwtest.js client <IP-این-سرور> --port ${opts.port}\n`);
  });
}

/* ------------------------------------------------------------------ client */

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const to = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(to); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(to); reject(e); });
  });
}

/* Run one direction over `streams` parallel sockets for `time` seconds.
 * Returns { totalBytes, seconds, avgBps, peakBps }. */
async function runDirection(host, opts, dir) {
  const { port, time, streams, chunk } = opts;
  const label = dir === 'down' ? 'دانلود (سرور → شما)' : 'آپلود  (شما → سرور)';

  // 1) Open every connection first, so slow-start warmup on one does not eat
  //    into the test window of the next.
  const socks = [];
  for (let i = 0; i < streams; i++) {
    try { socks.push(await connect(host, port, 8000)); }
    catch (e) {
      if (socks.length === 0) throw e; // could not reach the server at all
    }
  }
  if (socks.length < streams) {
    console.log(`  (فقط ${socks.length} از ${streams} اتصال برقرار شد)`);
  }

  const counted = { bytes: 0 };            // receiver-side bytes, for the live line
  const reports = [];                      // server verdicts, for the up direction
  const payload = Buffer.allocUnsafe(chunk);

  // 2) Wire each socket up for its role and send the header.
  const finished = socks.map((sock) => new Promise((resolve) => {
    sock.on('error', () => resolve());
    sock.write(JSON.stringify({ magic: MAGIC, dir }) + '\n');

    if (dir === 'down') {
      sock.on('data', (d) => { counted.bytes += d.length; });
      sock.on('close', () => resolve());
    } else {
      // upload: blast until the deadline, then half-close and read the verdict.
      let rbuf = '';
      sock.on('data', (d) => { rbuf += d.toString('utf8'); });
      sock.on('close', () => {
        const nl = rbuf.indexOf('\n');
        if (nl !== -1) { try { reports.push(JSON.parse(rbuf.slice(0, nl))); } catch {} }
        resolve();
      });
      const pump = () => {
        if (sock.destroyed) return;
        if (Date.now() >= deadline) { sock.end(); return; }
        let ok = true;
        while (ok && Date.now() < deadline && !sock.destroyed) {
          ok = sock.write(payload);
          counted.bytes += payload.length;
        }
        if (Date.now() >= deadline) { sock.end(); return; }
        sock.once('drain', pump);
      };
      // defer start until the deadline is set below
      process.nextTick(pump);
    }
  }));

  // 3) Run the clock and sample throughput every 250ms.
  const start = Date.now();
  const deadline = start + time * 1000;
  const samples = [];
  let lastBytes = 0, lastTime = start;
  const sampler = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    const db = counted.bytes - lastBytes;
    lastTime = now; lastBytes = counted.bytes;
    if (dt > 0) {
      const bps = (db * 8) / dt;
      samples.push({ t: now - start, bps });
      process.stdout.write(`\r  ${label}   ${fmtBits(bps).padStart(11)}   ${fmtRate(db / dt).padStart(12)}   `);
    }
  }, 250);

  // 4) For download, cut the sockets at the deadline (the server sends forever).
  if (dir === 'down') {
    setTimeout(() => { for (const s of socks) s.destroy(); }, time * 1000);
  }

  await Promise.all(finished);
  clearInterval(sampler);
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  // 5) Tally up. Downloads are trusted from the client's own receive count;
  //    uploads use the SERVER's count and clock - the true "ورودی سرور".
  let totalBytes, seconds;
  if (dir === 'up' && reports.length) {
    totalBytes = reports.reduce((a, r) => a + (r.bytes || 0), 0);
    seconds = Math.max(...reports.map((r) => (r.ms || 0) / 1000), 0.001);
  } else {
    totalBytes = counted.bytes;
    seconds = Math.max((Date.now() - start) / 1000, 0.001);
  }
  const avgBps = (totalBytes * 8) / seconds;
  // Peak = best sustained 250ms window after the first second (skip slow-start).
  const stable = samples.filter((s) => s.t >= 1000);
  const peakBps = Math.max(0, ...(stable.length ? stable : samples).map((s) => s.bps));

  return { totalBytes, seconds, avgBps, peakBps };
}

async function runClient(host, opts) {
  console.log('NexV bwtest client');
  console.log(`سرور هدف : ${host}:${opts.port}`);
  console.log(`تنظیمات  : ${opts.time} ثانیه در هر جهت، ${opts.streams} اتصال موازی\n`);

  const which = opts.dir; // 'down' | 'up' | 'both'
  const results = {};
  try {
    if (which === 'down' || which === 'both') results.down = await runDirection(host, opts, 'down');
    if (which === 'up' || which === 'both') results.up = await runDirection(host, opts, 'up');
  } catch (e) {
    console.error(`\nنتوانستم به ${host}:${opts.port} وصل شوم (${e.message}).`);
    console.error('مطمئن شو روی سرور دستور زیر در حال اجراست و پورت در فایروال باز است:');
    console.error(`    node bwtest.js server --port ${opts.port}`);
    process.exit(1);
  }

  console.log('──────────────────────────────────────────────');
  console.log('نتیجه:');
  if (results.down) {
    const r = results.down;
    console.log(`  دانلود (سرور → شما) : اوج ${fmtBits(r.peakBps)}   میانگین ${fmtBits(r.avgBps)}   (${fmtBytes(r.totalBytes)})`);
  }
  if (results.up) {
    const r = results.up;
    console.log(`  آپلود  (شما → سرور) : اوج ${fmtBits(r.peakBps)}   میانگین ${fmtBits(r.avgBps)}   (${fmtBytes(r.totalBytes)})`);
    console.log('  ↑ همین «میانگین آپلود» حداکثر ورودی‌ای است که سرورت واقعاً می‌گیرد.');
  }
  console.log('──────────────────────────────────────────────');
  console.log('این اعداد را با پهنای باندی که سرویس‌دهنده‌ات بهت قول داده مقایسه کن.');
  console.log('اگر خیلی کمتر بود، یعنی پهنای باند کامل تحویل داده نمی‌شود.');
}

/* -------------------------------------------------------------------- args */

function parseArgs(argv) {
  const opts = { ...DEFAULTS, dir: 'both' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--time' || a === '-t') opts.time = Number(argv[++i]);
    else if (a === '--streams' || a === '-s') opts.streams = Number(argv[++i]);
    else if (a === '--down') opts.dir = 'down';
    else if (a === '--up') opts.dir = 'up';
    else if (a === '--both') opts.dir = 'both';
    else rest.push(a);
  }
  return { opts, rest };
}

function usage() {
  console.log(`NexV bwtest — تست پهنای باند به سرور (بدون هیچ وابستگی، فقط Node 18+)

روی سرور (همان IP که می‌خواهی تست کنی):
    node bwtest.js server [--port 5201]

روی سیستم خودت:
    node bwtest.js client <IP-سرور> [گزینه‌ها]

گزینه‌های client:
    --port, -p <n>      پورت سرور (پیش‌فرض 5201)
    --time, -t <n>      مدت هر جهت به ثانیه (پیش‌فرض 10)
    --streams, -s <n>   تعداد اتصال موازی (پیش‌فرض 4؛ برای خط پرسرعت زیادش کن)
    --down              فقط تست دانلود (سرور → تو)
    --up                فقط تست آپلود / ورودی سرور (تو → سرور)
    --both              هر دو جهت (پیش‌فرض)

مثال:
    node bwtest.js server
    node bwtest.js client 203.0.113.10 -t 15 -s 8`);
}

function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest.shift();

  if (!Number.isFinite(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('پورت نامعتبر است.'); process.exit(1);
  }

  if (cmd === 'server') return runServer(opts);
  if (cmd === 'client') {
    const host = rest.shift();
    if (!host) { console.error('IP سرور را بده. مثال: node bwtest.js client 203.0.113.10\n'); usage(); process.exit(1); }
    if (!Number.isFinite(opts.time) || opts.time < 1) { console.error('--time نامعتبر است.'); process.exit(1); }
    if (!Number.isFinite(opts.streams) || opts.streams < 1) { console.error('--streams نامعتبر است.'); process.exit(1); }
    return runClient(host, opts);
  }
  usage();
  process.exit(cmd ? 1 : 0);
}

main();
