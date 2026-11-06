'use strict';
/**
 * Does this outbound actually work, and how far away is it?
 *
 * Pinging the server's address answers neither question: ICMP is often
 * dropped, and a host that answers a ping can still refuse the handshake, hand
 * back the wrong REALITY key, or route nowhere. The only test worth running is
 * the real one - so a throwaway Xray is started with just this outbound and a
 * SOCKS port on loopback, a request is made through it, and the time it takes
 * is the answer. That is what a chained server will do with every connection.
 *
 * Nothing here touches the running service: a separate process, a separate
 * config file, a port nobody else has, and it is killed on the way out.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const XRAY_BIN = process.env.NEXV_XRAY_BIN || '/usr/local/bin/xray';

/*
 * Where the probe sends its one request, and why there is more than one.
 *
 * These are the captive-portal endpoints: tiny, always up, and answering with
 * no body at all. The test used to use a single one, and a working outbound
 * whose exit could not reach that one host came back as "the request timed
 * out" - which reads as "this outbound is broken" when the outbound is fine
 * and one site is not reachable from where it comes out. Several are tried in
 * turn and the first that answers is the answer; only when none of them does
 * is there really something wrong, and then the error says so in those words.
 *
 * A single host can still be forced with NEXV_PROBE_HOST for a network where
 * one of these is the only thing reachable.
 */
const TARGETS = process.env.NEXV_PROBE_HOST
  ? [{
    host: process.env.NEXV_PROBE_HOST,
    path: process.env.NEXV_PROBE_PATH || '/generate_204',
    port: Number(process.env.NEXV_PROBE_PORT || 80)
  }]
  : [
    { host: 'cp.cloudflare.com', path: '/generate_204', port: 80 },
    { host: 'connectivitycheck.gstatic.com', path: '/generate_204', port: 80 },
    { host: 'www.msftconnecttest.com', path: '/connecttest.txt', port: 80 },
    { host: 'detectportal.firefox.com', path: '/success.txt', port: 80 }
  ];

/*
 * A slow link through two hops needs longer than a local one, but a button
 * that can sit for a minute is a button people press twice. The first site
 * gets the patient timeout - it is the one that normally answers, and on a
 * congested link it may really need twelve seconds - and the fallbacks get a
 * short one each, because by then the question is only whether some site
 * answers at all. Worst case is about half a minute rather than a full one.
 */
const BOOT_TIMEOUT = 10000;
const TEST_TIMEOUT = 8000;
const RETRY_TIMEOUT = 5000;

/*
 * The line of xray's output that says what went wrong, if there is one. The
 * readiness check opens a connection to the socks port and drops it, which
 * xray logs as a rejected handshake - that one is ours, and reporting it as
 * the outbound's fault sent the admin hunting for a problem that is not there.
 */
function complaint(output) {
  return (String(output).split('\n')
    .filter((line) => !/insufficient header/i.test(line))
    .find((line) => /fail|error|invalid|rejected|refused/i.test(line)) || '').trim();
}

/** A loopback port nobody is listening on. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Wait until something is accepting connections there, or give up. */
function waitForPort(port, deadline) {
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (Date.now() > deadline) return resolve(false);
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(tryOnce, 120);
      });
    };
    tryOnce();
  });
}

/**
 * Ask a SOCKS5 proxy to connect somewhere, then speak plain HTTP over it.
 * Written out by hand rather than pulled in: it is forty lines and the panel
 * has no runtime dependencies worth adding one to.
 */
function throughSocks(port, host, targetPort, request, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const fail = (message, tunnel) => {
      socket.destroy();
      const err = new Error(message);
      if (tunnel) err.tunnel = true;
      reject(err);
    };
    socket.setTimeout(Number(timeout) || TEST_TIMEOUT, () => fail('the request timed out'));
    socket.on('error', (err) => reject(err));

    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) return fail('the local proxy refused the handshake');
        buffer = buffer.slice(2);
        stage = 'connect';

        const name = Buffer.from(host, 'utf8');
        const head = Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]);
        const tail = Buffer.alloc(2);
        tail.writeUInt16BE(targetPort, 0);
        socket.write(Buffer.concat([head, name, tail]));
        return;
      }

      if (stage === 'connect') {
        if (buffer.length < 10) return;
        if (buffer[1] !== 0x00) {
          /* xray answers with a SOCKS failure when the outbound cannot
             connect: that is the tunnel's own verdict and not this site's, so
             it is marked, and the caller stops rather than trying the rest */
          return fail('the outbound could not reach the server', true);
        }
        buffer = Buffer.alloc(0);
        stage = 'http';
        socket.write(request);
        return;
      }

      if (stage === 'http' && buffer.includes('\r\n')) {
        const line = buffer.slice(0, buffer.indexOf('\r\n')).toString('utf8');
        socket.destroy();
        resolve(line);
      }
    });

    /*
     * Where it got to says what is wrong, and saying "the connection closed"
     * says nothing. Reaching 'http' means the near end dialled the far server
     * and the far server then dropped it without a word - which is what a
     * wrong id, a wrong path, or security settings that do not match the other
     * end all look like from here.
     */
    socket.on('close', () => {
      if (stage === 'http') {
        return reject(new Error(
          'the far server accepted the connection and then closed it - check the id, the path, and that the security settings match the other end'
        ));
      }
      if (stage === 'connect') {
        return reject(new Error('could not reach the far server - check the address and port'));
      }
    });
  });
}

/**
 * Start a throwaway Xray carrying only this outbound, make one request through
 * it, and report how long it took.
 */
/** Is anything at all listening there? Answers the commonest typo on its own. */
function reachable(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(timeout, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

async function testOutbound(outbound, peer) {
  if (!fs.existsSync(XRAY_BIN)) {
    return { ok: false, error: 'xray is not installed on this server' };
  }

  /*
   * SOCKS answers "connected" before the far server has been dialled, so a
   * wrong port and a wrong id look identical by the time the request fails.
   * One TCP connection first tells the two apart, and a wrong port is the
   * mistake people actually make.
   */
  if (peer && peer.address && peer.port) {
    if (!(await reachable(peer.address, Number(peer.port)))) {
      return { ok: false, error: `nothing is listening on ${peer.address}:${peer.port}` };
    }
  }

  const port = await freePort();
  const file = path.join(os.tmpdir(), `nexv-probe-${process.pid}-${port}.json`);
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'probe-in',
      listen: '127.0.0.1',
      port,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: false }
    }],
    outbounds: [Object.assign({}, outbound, { tag: 'probe-out' })]
  };

  let child = null;
  let stderr = '';
  try {
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    child = spawn(XRAY_BIN, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { stderr += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const up = await waitForPort(port, Date.now() + BOOT_TIMEOUT);
    if (!up) {
      return { ok: false, error: complaint(stderr) || 'xray would not start with this outbound' };
    }

    /*
     * Each target in turn. A refusal from the tunnel itself stops the whole
     * thing - trying three more sites through an outbound that cannot connect
     * only wastes the admin's time - but a site that does not answer is just
     * that one site, and the next is tried.
     */
    const tried = [];
    let first = true;
    for (const target of TARGETS) {
      const hostHeader = target.port === 80 ? target.host : `${target.host}:${target.port}`;
      const request = Buffer.from(
        `GET ${target.path} HTTP/1.1\r\nHost: ${hostHeader}\r\n`
        + 'User-Agent: nexv-probe\r\nConnection: close\r\n\r\n',
        'utf8'
      );

      const started = Date.now();
      let status;
      try {
        status = await throughSocks(port, target.host, target.port, request,
          first ? TEST_TIMEOUT : RETRY_TIMEOUT);
        first = false;
      } catch (err) {
        first = false;
        if (err && err.tunnel) throw err;          // the outbound itself said no
        tried.push(`${target.host}: ${err.message}`);
        continue;
      }
      const ms = Date.now() - started;
      const code = Number((status.split(' ')[1] || '0'));
      if (!code) {
        tried.push(`${target.host}: unexpected answer ${status.slice(0, 40)}`);
        continue;
      }
      return { ok: true, ms, status: code, through: `${target.host}${target.path}`, tried };
    }

    /* the tunnel came up and carried nothing: that is a different fault from
       one it would not open, and it is worth naming every site that was tried
       so the next question is about the exit rather than about this panel */
    return {
      ok: false,
      error: 'the outbound connected, but none of the test sites answered through it'
        + ` (${tried.length} tried) - the far server is up but its own internet may be down`,
      tried
    };
  } catch (err) {
    /* xray writes why it gave up a moment after the socket drops, so the
       reason is worth waiting a breath for - "connection refused" or "invalid
       user" is an answer, "the connection closed" is not */
    await new Promise((r) => setTimeout(r, 350));
    const why = complaint(stderr);
    return { ok: false, error: why ? `${err.message} - ${why}` : err.message };
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } }
    try { fs.unlinkSync(file); } catch (_) { /* nothing to clean */ }
  }
}

module.exports = { testOutbound };
