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

/* small, always up, and answers with no body - the usual captive-portal check */
const TARGET_HOST = process.env.NEXV_PROBE_HOST || 'cp.cloudflare.com';
const TARGET_PATH = process.env.NEXV_PROBE_PATH || '/generate_204';
const TARGET_PORT = Number(process.env.NEXV_PROBE_PORT || 80);
const BOOT_TIMEOUT = 6000;
const TEST_TIMEOUT = 12000;

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
function throughSocks(port, host, targetPort, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const fail = (message) => { socket.destroy(); reject(new Error(message)); };
    socket.setTimeout(TEST_TIMEOUT, () => fail('the request timed out'));
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
          // xray answers with a SOCKS failure when the outbound cannot connect
          return fail('the outbound could not reach the server');
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

    const host = TARGET_PORT === 80 ? TARGET_HOST : `${TARGET_HOST}:${TARGET_PORT}`;
    const request = Buffer.from(
      `GET ${TARGET_PATH} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: nexv-probe\r\nConnection: close\r\n\r\n`,
      'utf8'
    );

    const started = Date.now();
    const status = await throughSocks(port, TARGET_HOST, TARGET_PORT, request);
    const ms = Date.now() - started;

    const code = Number((status.split(' ')[1] || '0'));
    if (!code) return { ok: false, error: `unexpected answer: ${status.slice(0, 80)}` };
    return { ok: true, ms, status: code, through: `${TARGET_HOST}${TARGET_PATH}` };
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
