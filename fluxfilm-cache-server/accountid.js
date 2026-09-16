/**
 * FluxFilm - rename / split an inventory AccountID (admin only).
 *
 *   POST /admin/api/account/rename/preview  { service, fromId, toId }
 *   POST /admin/api/account/rename          { service, fromId, toId }
 *   POST /admin/api/account/split/preview   { service, fromId }
 *   POST /admin/api/account/split           { service, fromId, toId, subIds[], login, costMode, ... }
 *
 * RENAME is the safe one: the same real login keeps every row it has, it is only called
 * something else. Every table that stores the id is updated inside ONE transaction:
 *   inventory_accounts · inventory_profiles · inventory_capacity · account_costs ·
 *   subscriptions (account_id, inventory_ref prefix, raw_json AccountID / InventoryRef).
 *
 * SPLIT is only right when one AccountID really covers SEVERAL different logins. It makes a
 * new account, moves the chosen subscriptions onto it and divides the cost. If the 4 customers
 * share ONE login, the right answer is one account with one cost - the 💰 Profit page now shows
 * that correctly, so nothing needs splitting.
 *
 * Every statement touches a single table: `refund_*` / `feed_*` were created with
 * utf8mb4_unicode_ci while the old tables are utf8mb4_general_ci, and MariaDB refuses to
 * compare columns across them. Nothing here JOINs.
 */
const AG = require('./accountgroups');

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
const likeOf = (svc) => '%' + family(svc) + '%';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,58}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const rawOf = (v) => { if (v == null) return {}; if (typeof v === 'object') return v; try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } };

/** Tables that store an AccountID, in the order the preview lists them. */
const ID_TABLES = ['inventory_accounts', 'inventory_profiles', 'inventory_capacity', 'account_costs'];

function create(deps) {
  const d = deps || {};
  const db = d.db || require('./db');
  const audit = d.audit || { record: () => {} };

  const q = (sql, p) => db.query(sql, p || []);
  /** A table that was never created (account_costs before schema-v14) counts as empty. */
  const softCount = async (sql, p) => { try { const r = await q(sql, p); return Number(r && r[0] && r[0].n) || 0; } catch (e) { if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message))) return 0; throw e; } };

  async function counts(service, id) {
    const like = likeOf(service); const out = {};
    for (const t of ID_TABLES) out[t] = await softCount('SELECT COUNT(*) n FROM ' + t + ' WHERE account_id = ? AND LOWER(service) LIKE ?', [id, like]);
    out.subscriptions = await softCount('SELECT COUNT(*) n FROM subscriptions WHERE account_id = ? AND LOWER(service) LIKE ?', [id, like]);
    out.subscriptionRefs = await softCount('SELECT COUNT(*) n FROM subscriptions WHERE LEFT(inventory_ref, ?) = ? AND LOWER(service) LIKE ?', [id.length, id, like]);
    out.total = ID_TABLES.reduce((t, k) => t + out[k], 0) + out.subscriptions;
    return out;
  }

  function checkIds(service, fromId, toId) {
    if (!s(service)) return 'Service required.';
    if (!fromId || !toId) return 'Both the old and the new account id are required.';
    if (!ID_RE.test(fromId) || !ID_RE.test(toId)) return 'An account id can use letters, numbers, space, dot, dash, underscore and / only.';
    if (fromId === toId) return 'The new id is the same as the old one.';
    return '';
  }

  /** Anything already using the new id in this service (renaming onto it would merge two accounts). */
  async function takenBy(service, toId) {
    const like = likeOf(service); const hits = [];
    for (const t of ID_TABLES.concat(['subscriptions'])) {
      const n = await softCount('SELECT COUNT(*) n FROM ' + t + ' WHERE account_id = ? AND LOWER(service) LIKE ?', [toId, like]);
      if (n) hits.push(t + ' (' + n + ')');
    }
    return hits;
  }

  async function renamePreview(input) {
    const b = input || {};
    const service = s(b.service), fromId = s(b.fromId), toId = s(b.toId);
    const bad = checkIds(service, fromId, toId);
    if (bad) return { ok: false, status: 400, message: bad };
    const rows = await counts(service, fromId);
    if (!rows.total) return { ok: false, status: 404, message: 'No ' + service + ' account called "' + fromId + '".' };
    const taken = await takenBy(service, toId);
    return {
      ok: true, service, family: family(service), fromId, toId, rows, taken,
      blocked: taken.length ? 'Something already uses "' + toId + '" in ' + service + ': ' + taken.join(', ') + '. Renaming onto it would merge two different accounts — pick a free id.' : '',
    };
  }

  async function rename(input) {
    const pre = await renamePreview(input);
    if (!pre.ok) return pre;
    if (pre.blocked) return { ok: false, status: 409, message: pre.blocked };
    const { service, fromId, toId } = pre;
    const like = likeOf(service);
    const conn = await db.getPool().getConnection();
    const changed = {};
    try {
      await conn.beginTransaction();
      const run = async (sql, p) => { try { const [r] = await conn.query(sql, p); return (r && r.affectedRows) || 0; } catch (e) { if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message))) return 0; throw e; } };
      for (const t of ID_TABLES) changed[t] = await run('UPDATE ' + t + ' SET account_id = ? WHERE account_id = ? AND LOWER(service) LIKE ?', [toId, fromId, like]);
      // MySQL applies SET left to right, so raw_json sees the NEW inventory_ref.
      changed.subscriptions = await run(
        'UPDATE subscriptions SET account_id = ?, ' +
        'inventory_ref = IF(inventory_ref IS NOT NULL AND LEFT(inventory_ref, ?) = ?, CONCAT(?, SUBSTRING(inventory_ref, ?)), inventory_ref), ' +
        "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.AccountID', ?, '$.InventoryRef', COALESCE(inventory_ref, ''))) " +
        'WHERE account_id = ? AND LOWER(service) LIKE ?',
        [toId, fromId.length, fromId, toId, fromId.length + 1, toId, fromId, like]);
      // Rows whose account_id was blank but whose inventory_ref still points at the old id.
      changed.orphanRefs = await run(
        'UPDATE subscriptions SET inventory_ref = CONCAT(?, SUBSTRING(inventory_ref, ?)), ' +
        "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.InventoryRef', COALESCE(inventory_ref, ''))) " +
        'WHERE LEFT(inventory_ref, ?) = ? AND account_id <> ? AND LOWER(service) LIKE ?',
        [toId, fromId.length + 1, fromId.length, fromId, toId, like]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* already gone */ }
      conn.release();
      return { ok: false, status: 500, message: 'Nothing was changed: ' + String((e && e.message) || e) };
    }
    conn.release();
    const total = Object.values(changed).reduce((a, b2) => a + b2, 0);
    return { ok: true, service, fromId, toId, changed, total, logSummary: service + ': account "' + fromId + '" renamed to "' + toId + '" · ' + total + ' rows (' + Object.entries(changed).filter(([, n]) => n).map(([k, n]) => k + ' ' + n).join(', ') + ')' };
  }

  // ------------------------------------------------------------------ split
  async function splitPreview(input) {
    const b = input || {};
    const service = s(b.service), fromId = s(b.fromId);
    if (!service || !fromId) return { ok: false, status: 400, message: 'Account required.' };
    const like = likeOf(service);
    const accounts = await q('SELECT service, account_id, login_id, is_active, plan FROM inventory_accounts WHERE account_id = ? AND LOWER(service) LIKE ?', [fromId, like]);
    if (!accounts.length) return { ok: false, status: 404, message: 'No ' + service + ' account called "' + fromId + '".' };
    const profiles = await softCount('SELECT COUNT(*) n FROM inventory_profiles WHERE account_id = ? AND LOWER(service) LIKE ?', [fromId, like]);
    const subs = await q("SELECT sub_id, service, plan, status, expiry_date, inventory_ref, phone_norm FROM subscriptions WHERE account_id = ? AND LOWER(service) LIKE ? ORDER BY (UPPER(COALESCE(status, '')) = 'ACTIVE') DESC, expiry_date DESC LIMIT 200", [fromId, like]);
    let cost = null;
    try {
      const c = await q('SELECT service, account_id, monthly_cost, note FROM account_costs WHERE account_id = ? AND LOWER(service) LIKE ? LIMIT 1', [fromId, like]);
      if (c && c[0]) { const p = AG.parseCostNote(c[0].note, c[0].monthly_cost); cost = { service: s(c[0].service), accountId: s(c[0].account_id), every: p.every, amount: r2(p.amount), monthly: r2(p.amount / p.every), stoppedOn: p.stoppedOn, note: p.note }; }
    } catch (e) { if (!/doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message))) throw e; }
    return {
      ok: true, service, fromId, cost,
      logins: [...new Set(accounts.map((a) => s(a.login_id)).filter(Boolean))],
      rows: accounts.map((a) => ({ service: s(a.service), plan: s(a.plan), isActive: s(a.is_active).toUpperCase() === 'TRUE' })),
      profiles,
      blocked: profiles ? 'This account has ' + profiles + ' profile row' + (profiles === 1 ? '' : 's') + ' (Netflix-style). Splitting would leave the moved plans pointing at profiles that are not on the new login — move those plans with 🔁 Switch account instead.' : '',
      subs: subs.map((x) => ({ subId: s(x.sub_id), service: s(x.service), plan: s(x.plan), status: s(x.status), expiry: s(x.expiry_date), ref: s(x.inventory_ref), phone: s(x.phone_norm).slice(-4) })),
    };
  }

  async function split(input) {
    const b = input || {};
    const service = s(b.service), fromId = s(b.fromId), toId = s(b.toId);
    const bad = checkIds(service, fromId, toId);
    if (bad) return { ok: false, status: 400, message: bad };
    const subIds = [...new Set((Array.isArray(b.subIds) ? b.subIds : []).map(s).filter(Boolean))].slice(0, 200);
    if (!subIds.length) return { ok: false, status: 400, message: 'Pick at least one plan to move to the new account.' };
    const pre = await splitPreview({ service, fromId });
    if (!pre.ok) return pre;
    if (pre.blocked) return { ok: false, status: 409, message: pre.blocked };
    const taken = await takenBy(service, toId);
    if (taken.length) return { ok: false, status: 409, message: 'Something already uses "' + toId + '" in ' + service + ': ' + taken.join(', ') + '. Pick a free id.' };
    const known = new Set(pre.subs.map((x) => x.subId));
    const missing = subIds.filter((x) => !known.has(x));
    if (missing.length) return { ok: false, status: 409, message: 'These plans are not on ' + fromId + ' any more: ' + missing.join(', ') + '. Reload and try again.' };

    const newLogin = s(b.login) || s(pre.logins[0] || '');
    const mode = s(b.costMode).toLowerCase() || 'none';
    const ways = Math.max(2, Math.min(20, Math.round(num(b.ways)) || 2));
    let newAmount = null, keepAmount = null;
    if (pre.cost && mode !== 'none') {
      if (mode === 'move') { newAmount = pre.cost.amount; keepAmount = 0; }
      else if (mode === 'divide') { newAmount = r2(pre.cost.amount / ways); keepAmount = r2(pre.cost.amount - newAmount); }
      else if (mode === 'amount') { newAmount = r2(num(b.costAmount)); keepAmount = pre.cost.amount; if (!(newAmount >= 0 && newAmount <= 1e7)) return { ok: false, status: 400, message: 'Cost must be a number.' }; }
      else return { ok: false, status: 400, message: 'Unknown cost option.' };
    }

    const like = likeOf(service);
    const src = await q('SELECT service, account_id, login_id, password, is_active, plan, notes, raw_json FROM inventory_accounts WHERE account_id = ? AND LOWER(service) LIKE ?', [fromId, like]);
    const caps = await q('SELECT service, account_id, max_total, max_tv, is_active, notes FROM inventory_capacity WHERE account_id = ? AND LOWER(service) LIKE ?', [fromId, like]).catch(() => []);
    const conn = await db.getPool().getConnection();
    const made = { accounts: 0, capacity: 0, subscriptions: 0, cost: 0 };
    try {
      await conn.beginTransaction();
      for (const a of src) {
        const raw = rawOf(a.raw_json); raw.AccountID = toId; if (newLogin) raw.LoginId = newLogin;
        const [r] = await conn.query('INSERT INTO inventory_accounts (service, account_id, login_id, password, is_active, plan, notes, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [s(a.service), toId, newLogin, s(a.password), s(a.is_active) || 'TRUE', s(a.plan), s(a.notes), JSON.stringify(raw)]);
        made.accounts += (r && r.affectedRows) || 0;
      }
      for (const c of caps) {
        const [r] = await conn.query('INSERT INTO inventory_capacity (service, account_id, max_total, max_tv, is_active, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [s(c.service), toId, c.max_total == null ? null : Number(c.max_total), c.max_tv == null ? null : Number(c.max_tv), s(c.is_active) || 'TRUE', s(c.notes)]);
        made.capacity += (r && r.affectedRows) || 0;
      }
      const marks = subIds.map(() => '?').join(', ');
      const [mv] = await conn.query(
        'UPDATE subscriptions SET account_id = ?, ' + (newLogin ? 'login_id = ?, ' : '') +
        'inventory_ref = IF(inventory_ref IS NOT NULL AND LEFT(inventory_ref, ?) = ?, CONCAT(?, SUBSTRING(inventory_ref, ?)), ?), ' +
        "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.AccountID', ?, '$.InventoryRef', COALESCE(inventory_ref, '')" + (newLogin ? ", '$.LoginId', ?" : '') + ')) ' +
        'WHERE sub_id IN (' + marks + ') AND account_id = ?',
        [toId].concat(newLogin ? [newLogin] : []).concat([fromId.length, fromId, toId, fromId.length + 1, toId, toId]).concat(newLogin ? [newLogin] : []).concat(subIds, [fromId]));
      made.subscriptions = (mv && mv.affectedRows) || 0;
      if (newAmount != null) {
        const note = AG.buildCostNote(pre.cost.every, newAmount, pre.cost.stoppedOn, pre.cost.note);
        const [ins] = await conn.query('INSERT INTO account_costs (service, account_id, monthly_cost, note) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE monthly_cost = VALUES(monthly_cost), note = VALUES(note)',
          [pre.cost.service, toId, r2(newAmount / pre.cost.every), note || null]);
        made.cost += (ins && ins.affectedRows) || 0;
        if (keepAmount === 0) await conn.query('DELETE FROM account_costs WHERE service = ? AND account_id = ? LIMIT 1', [pre.cost.service, fromId]);
        else if (keepAmount !== pre.cost.amount) {
          const kn = AG.buildCostNote(pre.cost.every, keepAmount, pre.cost.stoppedOn, pre.cost.note);
          await conn.query('UPDATE account_costs SET monthly_cost = ?, note = ? WHERE service = ? AND account_id = ? LIMIT 1', [r2(keepAmount / pre.cost.every), kn || null, pre.cost.service, fromId]);
        }
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* already gone */ }
      conn.release();
      return { ok: false, status: 500, message: 'Nothing was changed: ' + String((e && e.message) || e) };
    }
    conn.release();
    const costText = newAmount == null ? 'cost left as it was' : 'cost ₹' + newAmount + ' to ' + toId + (keepAmount === 0 ? ' (moved)' : ', ₹' + keepAmount + ' stays on ' + fromId);
    return { ok: true, service, fromId, toId, made, newAmount, keepAmount, login: newLogin, subIds, logSummary: service + ': ' + made.subscriptions + ' plan(s) moved from "' + fromId + '" to a new account "' + toId + '" · ' + costText };
  }

  return { renamePreview, rename, splitPreview, split, counts };
}

function mount(app, deps) {
  const { auth } = deps;
  const api = create(deps);
  const audit = deps.audit || { record: () => {} };
  const send = (res, r) => res.status(r.ok ? 200 : (r.status || 400)).json(r.ok ? r : { ok: false, message: r.message });

  app.post('/admin/api/account/rename/preview', async (req, res) => {
    if (!auth(req, res)) return;
    try { send(res, await api.renamePreview(req.body || {})); } catch (e) { res.status(500).json({ ok: false, message: String((e && e.message) || e) }); }
  });
  app.post('/admin/api/account/rename', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await api.rename(req.body || {});
      if (r.ok) audit.record(req, { action: 'account.rename', entity: 'account', id: r.toId, summary: r.logSummary, details: { from: r.fromId, to: r.toId, changed: r.changed } });
      send(res, r);
    } catch (e) { res.status(500).json({ ok: false, message: String((e && e.message) || e) }); }
  });
  app.post('/admin/api/account/split/preview', async (req, res) => {
    if (!auth(req, res)) return;
    try { send(res, await api.splitPreview(req.body || {})); } catch (e) { res.status(500).json({ ok: false, message: String((e && e.message) || e) }); }
  });
  app.post('/admin/api/account/split', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await api.split(req.body || {});
      if (r.ok) audit.record(req, { action: 'account.split', entity: 'account', id: r.toId, summary: r.logSummary, details: { from: r.fromId, to: r.toId, made: r.made, subIds: r.subIds } });
      send(res, r);
    } catch (e) { res.status(500).json({ ok: false, message: String((e && e.message) || e) }); }
  });
}

module.exports = { mount, create, family };
