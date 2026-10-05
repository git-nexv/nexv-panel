'use strict';

/*
 * Which inbounds a client belongs to.
 *
 * A client used to sit on exactly one inbound, held in `client.inboundId`.
 * That is now the primary of a list: `client.inboundIds` carries every inbound
 * the client is attached to, and the single field keeps pointing at the first
 * of them so older readers (the bot's config view, the dashboard summary)
 * still see something sensible.
 *
 * Nothing here migrates the stored file. A client written before this change
 * has no `inboundIds`, and reading falls back to the single field, so both
 * shapes work side by side and an old db.json needs no rewriting.
 */

/** Every inbound id this client is attached to, in order, without blanks or repeats. */
function inboundIdsOf(client) {
  if (!client) return [];
  const out = [];
  const push = (id) => {
    if (typeof id !== 'string' || !id) return;
    if (!out.includes(id)) out.push(id);
  };
  // the primary leads, so the first link of a subscription stays the first
  push(client.inboundId);
  if (Array.isArray(client.inboundIds)) for (const id of client.inboundIds) push(id);
  return out;
}

/** True when the client is carried by this inbound. */
function isOn(client, inboundId) {
  if (!inboundId) return false;
  return inboundIdsOf(client).includes(inboundId);
}

/** The clients this inbound carries. */
function clientsOn(clients, inboundId) {
  return (clients || []).filter((c) => isOn(c, inboundId));
}

/** The inbound records this client is attached to, in the client's own order. */
function inboundsOf(client, inbounds) {
  const ids = inboundIdsOf(client);
  const found = [];
  for (const id of ids) {
    const inb = (inbounds || []).find((i) => i.id === id);
    if (inb) found.push(inb);
  }
  return found;
}

/**
 * Point a client at exactly this set of inbounds. The first survivor becomes
 * the primary, which is what the single `inboundId` field keeps holding.
 */
function setInbounds(client, ids) {
  const clean = [];
  for (const id of (Array.isArray(ids) ? ids : [ids])) {
    if (typeof id !== 'string' || !id) continue;
    if (!clean.includes(id)) clean.push(id);
  }
  client.inboundIds = clean;
  client.inboundId = clean[0] || '';
  return client;
}

/** Attach one more inbound. Already attached is a no-op. */
function addInbound(client, inboundId) {
  const ids = inboundIdsOf(client);
  if (!inboundId || ids.includes(inboundId)) return setInbounds(client, ids);
  ids.push(inboundId);
  return setInbounds(client, ids);
}

/** Take one inbound off. The client keeps whatever else it had. */
function removeInbound(client, inboundId) {
  return setInbounds(client, inboundIdsOf(client).filter((id) => id !== inboundId));
}

/**
 * Drop an inbound that no longer exists from every client, so a deleted
 * inbound never leaves a dangling id behind.
 */
function forgetInbound(clients, inboundId) {
  let touched = 0;
  for (const c of (clients || [])) {
    if (!isOn(c, inboundId)) continue;
    removeInbound(c, inboundId);
    touched++;
  }
  return touched;
}

module.exports = {
  inboundIdsOf,
  isOn,
  clientsOn,
  inboundsOf,
  setInbounds,
  addInbound,
  removeInbound,
  forgetInbound
};
