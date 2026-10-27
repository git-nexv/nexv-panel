'use strict';

/**
 * Several inbounds on one port.
 *
 * Xray listens once per address, so two inbounds that both want 443 cannot
 * each have their own listener. The documented way to share one is a
 * fallback: one inbound owns the port, reads the start of every connection,
 * and hands the ones that are not its own to another inbound listening on
 * the loopback, chosen by the request path.
 *
 * That rewriting happens here, at config-build time only. The stored
 * inbounds keep the port the admin typed, so subscription links, QR codes
 * and the firewall all go on naming 443 - which is what the client must
 * really connect to. Nothing in db.json moves.
 *
 * Measured against Xray 25.9.11 rather than assumed:
 *   - two inbounds on one port both start and the port answers, but only the
 *     first one works once TLS is in play; the second is silently dead. So
 *     sharing is never left to Xray's own listener handling.
 *   - an owner with an empty client list dispatches fallbacks correctly and
 *     lets nobody in through itself, which is what makes a synthesised owner
 *     safe: it is a doorman, not a door.
 */

const PATH_NETWORKS = ['ws', 'httpupgrade', 'xhttp'];
/* only these can hold the fallbacks that make sharing work, so only these can
   own a shared port - and only these can lend a stand-in its transport */
const CAN_FALL_BACK = ['vless', 'trojan'];
/* no transport of their own, so there is nothing to tell their traffic apart */
const NO_TRANSPORT = ['wireguard', 'dokodemo-door'];
const LOCAL_HOST = '127.0.0.1';
const LOCAL_BASE = 41000;

function normPath(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '/') return '';
  return s.startsWith('/') ? s : `/${s}`;
}

/** What tells this inbound's traffic apart from its neighbours on the port. */
function pathOf(inb) {
  if (PATH_NETWORKS.includes(inb.network || 'tcp')) return normPath(inb.wsPath);
  return '';
}

function securityOf(inb) {
  return inb.security || 'none';
}

function slotOf(inb) {
  return `${inb.listen || '0.0.0.0'}:${Number(inb.port)}`;
}

/** An inbound that can own a port: plain tcp, so it can read the request. */
function canOwn(inb) {
  return CAN_FALL_BACK.includes(inb.protocol)
    && (inb.network || 'tcp') === 'tcp' && !pathOf(inb);
}

/**
 * Why these inbounds cannot share their port, in one sentence, or '' when
 * they can. The wording lands in front of whoever just pressed save, so it
 * says what to change rather than what went wrong.
 */
function problem(members) {
  const live = (members || []).filter(Boolean);
  if (live.length < 2) return '';

  const port = Number(live[0].port);
  const securities = [...new Set(live.map(securityOf))];
  if (securities.length > 1) {
    return `the inbounds sharing port ${port} must all use the same security `
      + `(these use ${securities.join(' and ')}); a shared port is wrapped once, for all of them`;
  }

  const bare = live.find((i) => NO_TRANSPORT.includes(i.protocol));
  if (bare) {
    return `inbound "${bare.remark}" is ${bare.protocol}, which carries no path to be told apart by; `
      + `it needs a port of its own rather than ${port}`;
  }

  const grpc = live.find((i) => (i.network || 'tcp') === 'grpc');
  if (grpc) {
    return `inbound "${grpc.remark}" uses gRPC, which needs a port of its own; `
      + 'give the others ws, httpupgrade or xhttp to share one';
  }

  /* a stand-in owner borrows the first member's transport, so at least one
     member must be a protocol that can carry fallbacks */
  if (!live.some((i) => CAN_FALL_BACK.includes(i.protocol))) {
    return `one of the inbounds on port ${port} must be VLESS or Trojan to hold the port `
      + 'for the others; nothing else can pass a connection on';
  }

  const owners = live.filter(canOwn);
  if (owners.length > 1) {
    return `only one inbound on port ${port} can be plain TCP; `
      + `"${owners[1].remark}" needs ws, httpupgrade or xhttp with its own path`;
  }

  const sharers = live.filter((i) => !canOwn(i));
  const seen = new Map();
  for (const inb of sharers) {
    const p = pathOf(inb);
    if (!p) {
      return `inbound "${inb.remark}" needs a path of its own to share port ${port} `
        + '(set one under the transport settings)';
    }
    if (seen.has(p)) {
      return `inbounds "${seen.get(p)}" and "${inb.remark}" both use path ${p} on port ${port}; `
        + 'give each one its own path';
    }
    seen.set(p, inb.remark);
  }
  return '';
}

/**
 * Port numbers nothing may be moved onto: the ports real inbounds listen on,
 * plus whatever the caller reserves for the panel itself.
 */
function takenPorts(inbounds, reserved) {
  const taken = new Set((reserved || []).map(Number).filter((n) => n > 0));
  for (const inb of inbounds) taken.add(Number(inb.port));
  return taken;
}

/**
 * How to render a set of inbounds so that the shared ports work.
 *
 * Returns the inbounds that must listen on the loopback instead of the port
 * they were given, and the owners that take those ports over. An owner is
 * either one of the admin's own inbounds - a plain TCP one, which can read a
 * request and pass it on - or, when there is none, a clientless stand-in
 * built from the first member so that the TLS handshake still happens with
 * the right certificate.
 */
function plan(inbounds, reserved) {
  const moved = new Map();   // inbound id -> { listen, port }
  const owners = [];         // synthesised entries, to append to the config
  const adopt = new Map();   // inbound id -> fallbacks to graft onto it

  const slots = new Map();
  for (const inb of inbounds) {
    const key = slotOf(inb);
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(inb);
  }

  const taken = takenPorts(inbounds, reserved);
  let next = LOCAL_BASE;
  const freeLocalPort = () => {
    while (taken.has(next) || next < 1024) next += 1;
    taken.add(next);
    return next;
  };

  for (const [, members] of slots) {
    if (members.length < 2) continue;
    if (problem(members)) continue;   // refused at save time; never rendered

    const owner = members.find(canOwn) || null;
    const sharers = members.filter((inb) => inb !== owner);
    const fallbacks = [];
    for (const inb of sharers) {
      const port = freeLocalPort();
      moved.set(inb.id, { listen: LOCAL_HOST, port });
      fallbacks.push({ path: pathOf(inb), dest: port, xver: 0 });
    }

    if (owner) {
      adopt.set(owner.id, fallbacks);
    } else {
      owners.push({ donor: members[0], fallbacks });
    }
  }

  return { moved, owners, adopt };
}

module.exports = { plan, problem, pathOf, slotOf, canOwn, LOCAL_HOST };
