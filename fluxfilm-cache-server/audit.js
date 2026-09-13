/**
 * FluxFilm - admin change log (table audit_log, schema-v14).
 *
 * record(req, { action, entity, id, summary, details }) never throws and never blocks
 * the action it describes: if the table is missing (schema-v14 not run yet) or the
 * insert fails, the admin action still succeeds and the problem is only logged.
 * Secrets are stripped from details before they are stored.
 */
const SECRET_KEYS = /pass(word)?|pin|token|secret|key/i;

function scrub(v, depth) {
  if (depth > 4 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? (x ? '•••' : x) : scrub(x, depth + 1);
    return out;
  }
  return typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
}

function makeAudit(db) {
  let warned = false;
  async function record(req, e) {
    try {
      const ip = req ? String(req.ip || (req.socket && req.socket.remoteAddress) || '') : '';
      await db.query('INSERT INTO audit_log (ts, action, entity, entity_id, summary, details, ip) VALUES (NOW(), ?, ?, ?, ?, ?, ?)', [
        String(e.action || '').slice(0, 60), e.entity ? String(e.entity).slice(0, 40) : null, e.id != null ? String(e.id).slice(0, 120) : null,
        e.summary ? String(e.summary).slice(0, 500) : null, e.details != null ? JSON.stringify(scrub(e.details, 0)).slice(0, 4000) : null, ip.slice(0, 64),
      ]);
    } catch (err) {
      if (!warned) { console.log('[audit] could not write change log (run db/schema-v14.sql?):', err.message); warned = true; }
    }
  }
  return { record };
}

module.exports = { makeAudit, scrub };
