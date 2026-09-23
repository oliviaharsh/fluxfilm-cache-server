/**
 * FluxFilm — 🕘 what a CUSTOMER did with a self-service tool, and how it ended.
 *
 * One place, because a tool usually has more than one door into it and a log that covers only one door answers the
 * owner's question wrong. Today: 🏠 Netflix Household — the customer's own 🧰 Tools screen (householdhelp.js) and
 * Olivia doing it for them in chat (olivia.js) — and 🔎 Get OTP (otp.js).
 *
 * Was householdlog.js until 24 Sep 2026; the old copy is in _deleted-old-code/2026-09-24_householdlog-renamed/.
 *
 * Lines go into audit_log — the same table, and the same 🕘 Change log screen, as the admin panel's own actions,
 * filtered by the 'household.' prefix. Every line carries the customer's NAME and number, so the owner can read it
 * without looking the number up.
 *
 * 🔐 The one rule: the 6-digit codes are NEVER written down. A line records that a code was given, not what it was.
 * That is why `details` is always built by hand at each call site and never handed a result object.
 */
const db = require('./db');
const { makeAudit } = require('./audit');

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };

let realAudit = null;
function auditFor(deps) {
  if (deps && deps.audit) return deps.audit;
  if (deps && deps.query) return makeAudit({ query: deps.query });
  if (!realAudit) realAudit = makeAudit(db);
  return realAudit;
}

/** The customer's name, so a log line reads like a person and not a phone number. */
async function nameOf(ph, deps) {
  try {
    const q = (deps && deps.query) || db.query;
    const r = await q('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
    return s(r && r[0] && r[0].name);
  } catch (_) { return ''; }
}

/**
 * Write one line. It never throws and never blocks the thing it describes: a missing audit_log table
 * (db/schema-v14.sql not run) can never stop a customer fixing their TV.
 *   record(deps, req, { action, phone, summary, details })
 */
async function record(deps, req, e) {
  try {
    const ph = norm(e && e.phone);
    const name = await nameOf(ph, deps);
    const who = (name || 'Unknown') + ' · ' + ph;
    await auditFor(deps).record(req || null, {
      action: e.action,
      entity: 'customer',
      id: ph,
      summary: (who + ' · ' + s(e.summary)).slice(0, 500),
      details: Object.assign({ name, phone: ph }, e.details || {}),
    });
  } catch (_) { /* logging must never break the tool */ }
}

module.exports = { record, _internal: { nameOf, auditFor } };
