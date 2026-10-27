'use strict';
/**
 * The panel's whole store, as a file somebody can keep.
 *
 * This used to live inside the download route, which meant the only way to
 * get a backup was to be sitting in front of the panel with a browser. The
 * bot can hand one over too now - on a schedule, or on demand - so the shape
 * of a backup had to stop being a detail of one HTTP handler.
 *
 * Two things never go in the file. The session secret, or every cookie this
 * server has ever issued would be forgeable from a backup that leaked; and
 * the sessions themselves, which belong to this machine and nowhere else.
 * Everything else does, the bot's token and plans included - a restore that
 * came back without them is not a restore.
 */
const db = require('./db');

/** The backup, as a plain object. */
function dump() {
  const out = JSON.parse(JSON.stringify(db.data));
  if (out.settings) delete out.settings.sessionSecret;
  out.sessions = [];
  return out;
}

/** The same thing as the bytes that go in the file. */
function text() {
  return JSON.stringify(dump(), null, 2);
}

/** Two digits, because a time is not a time with a bare 3 in it. */
function pad(n) { return String(n).padStart(2, '0'); }

/**
 * A name that sorts, and that says when it was taken in the admin's own day
 * rather than in UTC - a backup labelled 23:30 that was really taken at three
 * in the morning is a backup nobody can match to anything.
 */
function filename(at, offsetMinutes) {
  const when = new Date((at || Date.now()) + (Number(offsetMinutes) || 0) * 60000);
  return `nexv-${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`
    + `-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}.json`;
}

/** A line or two about what is in it, for whoever receives the file. */
function summary() {
  const d = db.data;
  const b = d.bot || {};
  return {
    inbounds: (d.inbounds || []).length,
    clients: (d.clients || []).length,
    plans: (b.plans || []).length,
    resellers: (d.resellers || []).length,
    bot: !!b.token
  };
}

module.exports = { dump, text, filename, summary, pad };
