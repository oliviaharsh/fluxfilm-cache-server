/**
 * FluxFilm - admin 🏦 Bank payments (admin-only): every UPI credit the bank-mail watcher stored (bank_credits).
 *
 *   GET  /admin/api/bank-credits?filter=after|before|ignored|matched&q=   list + counts per filter
 *   GET  /admin/api/bank-credits/suggest?id=                               orders that could be this payment
 *   POST /admin/api/bank-credits/ignore     { id, reason, note }            "Not a sale" (Personal / Paytm settlement / Refund / Test / Other)
 *   POST /admin/api/bank-credits/unignore   { id }                          undo "Not a sale"
 *   POST /admin/api/bank-credits/link       { id, orderId, override, reason }  link to an order (amount must match unless override + reason)
 *   POST /admin/api/bank-credits/unlink     { id, reason }                  undo a wrong link (the order's paid status is NOT changed)
 *   POST /admin/api/bank-credits/cutoff     { cutoff: 'YYYY-MM-DD HH:MM' }  go-live time (app_settings 'golive_cutoff')
 *
 * Why (investigation 2026-09-15): the Today card counted every unmatched credit of the last 14 days, but every
 * payment before go-live (2026-09-14 21:00 IST) was confirmed by the old go site / Sheet, so they never have an
 * order here. Only credits since go-live, not marked "Not a sale", are real "payment without an order" problems.
 *
 * Linking never delivers anything by itself. If the order is still unpaid, the panel offers the existing
 * "Mark paid + deliver" (POST /admin/api/quick/mark-paid, quickorders.js) with the bank reference.
 *
 * "Not a sale" is stored in bank_credits.ignored_at / ignored_reason / ignored_note (db/schema-v23.sql). Until
 * that is run it is kept in app_settings['bank_credit_ignores'] (JSON), so the buttons work straight away;
 * both are read, so nothing is lost when the schema is run later.
 * bank_credits has no raw_json (the alert text is in `raw`), so there is nothing else to keep in step.
 */
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const unknownColumn = (e) => /Unknown column|ER_BAD_FIELD_ERROR/i.test(String(e && e.message));

/** Go-live of shop.fluxfilm.in (India time). Credits before this were handled by the old go site / Sheet. */
const GO_LIVE_DEFAULT = '2026-09-14 21:00:00';
const CUTOFF_KEY = 'golive_cutoff';
const IGNORE_KEY = 'bank_credit_ignores';
const SCHEMA_FILE = 'db/schema-v23.sql';
const REASONS = { PERSONAL: 'Personal', PAYTM_SETTLEMENT: 'Paytm settlement', REFUND: 'Refund', TEST: 'Test', OTHER: 'Other' };
const FILTERS = ['after', 'before', 'ignored', 'matched'];

function parseAlert(raw) {
  try { return require('./paymatch').parseAlert(raw); } catch (_) { return { payerName: '', note: '', ifsc: '' }; }
}
function cleanCutoff(v) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return '';
  if (+m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59) return '';
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00');
}

/** Shared state per db handle (tests mount several apps). */
function store(db) {
  let colsOk = false; let colsCheckedAt = 0;
  async function setting(key) {
    try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]); return r && r[0] ? r[0].value : null; }
    catch (e) { if (missingTable(e)) return null; throw e; }
  }
  async function saveSetting(key, value) {
    await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, value]);
  }
  async function cutoff() { return cleanCutoff(await setting(CUTOFF_KEY)) || GO_LIVE_DEFAULT; }
  /** schema-v23 columns present? A "no" is re-checked every minute so running the schema needs no restart. */
  async function ignoreColumns() {
    if (colsOk) return true;
    if (Date.now() - colsCheckedAt < 60e3 && colsCheckedAt) return false;
    colsCheckedAt = Date.now();
    try { await db.query('SELECT ignored_at, ignored_reason, ignored_note FROM bank_credits LIMIT 0', []); colsOk = true; }
    catch (e) { if (!unknownColumn(e)) throw e; colsOk = false; }
    return colsOk;
  }
  async function fallbackIgnores() {
    const v = await setting(IGNORE_KEY);
    if (!v) return {};
    try { const j = JSON.parse(v); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (_) { return {}; }
  }
  /** SQL pieces for "not ignored" / "ignored", with their parameters. p = column prefix ('b.' or ''). */
  async function ignoreSql(p) {
    const cols = await ignoreColumns();
    const ids = Object.keys(await fallbackIgnores()).map((x) => parseInt(x, 10)).filter((x) => x > 0);
    const marks = ids.map(() => '?').join(', ');
    return {
      cols, ids,
      notIgnored: { sql: (cols ? p + 'ignored_at IS NULL' : '1 = 1') + (ids.length ? ' AND ' + p + 'id NOT IN (' + marks + ')' : ''), params: ids },
      ignored: { sql: '(' + (cols ? p + 'ignored_at IS NOT NULL' : '0 = 1') + (ids.length ? ' OR ' + p + 'id IN (' + marks + ')' : '') + ')', params: ids },
    };
  }
  async function whereFor(filter, p) {
    const cut = await cutoff();
    const ig = await ignoreSql(p);
    if (filter === 'matched') return { sql: p + 'consumed_order_id IS NOT NULL', params: [], cut, ig };
    if (filter === 'ignored') return { sql: p + 'consumed_order_id IS NULL AND ' + ig.ignored.sql, params: ig.ignored.params, cut, ig };
    if (filter === 'before') return { sql: p + 'consumed_order_id IS NULL AND (' + p + 'received_at < ? OR ' + p + 'received_at IS NULL) AND ' + ig.notIgnored.sql, params: [cut].concat(ig.notIgnored.params), cut, ig };
    return { sql: p + 'consumed_order_id IS NULL AND ' + p + 'received_at >= ? AND ' + ig.notIgnored.sql, params: [cut].concat(ig.notIgnored.params), cut, ig };
  }
  /** Today card: payments since go-live with no order and not marked "Not a sale". */
  async function countUnmatched() {
    const w = await whereFor('after', '');
    const r = await db.query('SELECT COUNT(*) n FROM bank_credits WHERE ' + w.sql, w.params);
    return { count: num(r && r[0] && r[0].n), cutoff: w.cut };
  }
  return { setting, saveSetting, cutoff, ignoreColumns, fallbackIgnores, ignoreSql, whereFor, countUnmatched, reset: () => { colsOk = false; colsCheckedAt = 0; } };
}
const stores = new WeakMap();
function storeFor(db) { if (!stores.has(db)) stores.set(db, store(db)); return stores.get(db); }

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const st = storeFor(db);
  const fail = (res, e) => res.status(missingTable(e) ? 409 : 500).json({ ok: false, needsSchema: missingTable(e), message: String((e && e.message) || e) });
  const idOf = (b) => parseInt(s((b || {}).id), 10) || 0;
  const creditCols = async () => 'id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id' + ((await st.ignoreColumns()) ? ', ignored_at, ignored_reason, ignored_note' : '');
  async function loadCredit(id) {
    const r = await db.query('SELECT ' + (await creditCols()) + ' FROM bank_credits WHERE id = ? LIMIT 1', [id]);
    return (r && r[0]) || null;
  }
  async function ignoredInfo(c) {
    if (c.ignored_at) return { at: s(c.ignored_at), reason: s(c.ignored_reason), note: s(c.ignored_note), where: 'column' };
    const fb = (await st.fallbackIgnores())[String(c.id)];
    return fb ? { at: s(fb.at), reason: s(fb.reason), note: s(fb.note), where: 'settings' } : null;
  }
  const view = (c, ig, cut) => {
    const a = parseAlert(c.raw);
    return {
      id: c.id, upiRef: s(c.upi_ref), amount: num(c.amount), receivedAt: s(c.received_at), orderIdsInNote: s(c.order_ids),
      payerName: a.payerName, note: a.note, ifsc: a.ifsc, raw: s(c.raw),
      orderId: s(c.consumed_order_id) || null, beforeGoLive: !!(c.received_at && s(c.received_at) < cut),
      ignored: ig || null,
      order: c.consumed_order_id ? { name: s(c.order_name), service: s(c.order_service), plan: s(c.order_plan), amount: num(c.order_amount), status: s(c.order_status) } : null,
    };
  };

  app.get('/admin/api/bank-credits', async (req, res) => {
    if (!auth(req, res)) return;
    const filter = FILTERS.includes(s(req.query.filter)) ? s(req.query.filter) : 'after';
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const q = s(req.query.q);
    try {
      const w = await st.whereFor(filter, 'b.');
      const parts = [w.sql]; const params = w.params.slice();
      if (q) {
        const like = '%' + q + '%';
        parts.push('(b.upi_ref LIKE ? OR b.raw LIKE ? OR b.order_ids LIKE ? OR b.consumed_order_id LIKE ?' + (/^\d+(\.\d+)?$/.test(q) ? ' OR ROUND(b.amount) = ROUND(?)' : '') + ')');
        params.push(like, like, like, like); if (/^\d+(\.\d+)?$/.test(q)) params.push(Number(q));
      }
      const cols = (await creditCols()).split(', ').map((c) => 'b.' + c).join(', ');
      const rows = await db.query('SELECT ' + cols + ', o.name order_name, o.service order_service, o.plan order_plan, o.final_amount order_amount, o.status order_status ' +
        'FROM bank_credits b LEFT JOIN orders o ON o.order_id = b.consumed_order_id WHERE ' + parts.join(' AND ') + ' ORDER BY b.received_at DESC, b.id DESC LIMIT ?', params.concat([limit]));
      const counts = {};
      await Promise.all(FILTERS.map(async (f) => { const x = await st.whereFor(f, ''); const r = await db.query('SELECT COUNT(*) n FROM bank_credits WHERE ' + x.sql, x.params); counts[f] = num(r && r[0] && r[0].n); }));
      const fb = await st.fallbackIgnores();
      const list = [];
      for (const c of rows || []) {
        const ig = c.ignored_at ? { at: s(c.ignored_at), reason: s(c.ignored_reason), note: s(c.ignored_note), where: 'column' } : (fb[String(c.id)] ? Object.assign({ where: 'settings' }, fb[String(c.id)]) : null);
        list.push(view(c, ig, w.cut));
      }
      res.json({ ok: true, filter, cutoff: w.cut, cutoffDefault: GO_LIVE_DEFAULT, counts, credits: list, reasons: REASONS, schemaReady: w.ig.cols, schemaFile: SCHEMA_FILE });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/bank-credits/suggest', async (req, res) => {
    if (!auth(req, res)) return;
    const id = parseInt(s(req.query.id), 10) || 0;
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      const inNote = s(c.order_ids).toUpperCase().split(',').filter(Boolean);
      const at = s(c.received_at) || null;
      const cols = 'o.order_id, o.name, o.phone_norm, o.service, o.plan, o.final_amount, o.status, o.fulfillment_status, o.created_at_sheet, o.source';
      const linked = '(SELECT b.id FROM bank_credits b WHERE b.consumed_order_id = o.order_id LIMIT 1) AS linked_credit_id';
      const [byNote, byAmount] = await Promise.all([
        inNote.length ? db.query('SELECT ' + cols + ', ' + linked + ' FROM orders o WHERE o.order_id IN (' + inNote.map(() => '?').join(', ') + ')', inNote) : [],
        at ? db.query('SELECT ' + cols + ', ' + linked + ' FROM orders o WHERE ROUND(o.final_amount) = ROUND(?) AND o.created_at_sheet BETWEEN (? - INTERVAL 2 DAY) AND (? + INTERVAL 1 DAY) ' +
          "AND UPPER(COALESCE(o.status, '')) IN ('CREATED', 'PAID') ORDER BY ABS(TIMESTAMPDIFF(SECOND, o.created_at_sheet, ?)) LIMIT 8", [c.amount, at, at, at]) : [],
      ]);
      const seen = new Set(); const orders = [];
      for (const o of [].concat(byNote || [], byAmount || [])) {
        if (seen.has(o.order_id)) continue; seen.add(o.order_id);
        orders.push(Object.assign({}, o, { final_amount: num(o.final_amount), inNote: inNote.includes(up(o.order_id)), linkedCreditId: o.linked_credit_id || null, linked_credit_id: undefined }));
      }
      res.json({ ok: true, id, orders });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/bank-credits/ignore', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = idOf(b);
    const reason = up(b.reason);
    const note = s(b.note).slice(0, 300);
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    if (!REASONS[reason]) return res.status(400).json({ ok: false, field: 'reason', message: 'Pick why this is not a sale: Personal, Paytm settlement, Refund, Test or Other.' });
    if (reason === 'OTHER' && !note) return res.status(400).json({ ok: false, field: 'note', message: 'For "Other", write a short note.' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      if (c.consumed_order_id) return res.status(409).json({ ok: false, message: 'This payment is linked to order ' + c.consumed_order_id + ' — unlink it first.' });
      const prev = await ignoredInfo(c);
      if (prev) return res.json({ ok: true, already: true, id, ignored: prev, message: 'Already marked "Not a sale" (' + (REASONS[up(prev.reason)] || prev.reason) + ').' });
      let where = 'column';
      if (await st.ignoreColumns()) {
        const r = await db.query('UPDATE bank_credits SET ignored_at = NOW(), ignored_reason = ?, ignored_note = ? WHERE id = ? AND consumed_order_id IS NULL AND ignored_at IS NULL', [reason, note || null, id]);
        if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'This payment just changed (linked or marked) — refresh and try again.' });
      } else {
        // Before schema-v23: keep it in app_settings (read by every count and list).
        where = 'settings';
        const map = await st.fallbackIgnores();
        map[String(id)] = { at: new Date().toISOString(), reason, note };
        try { await st.saveSetting(IGNORE_KEY, JSON.stringify(map)); }
        catch (e) { if (missingTable(e)) return res.status(409).json({ ok: false, needsSchema: true, message: 'Run ' + SCHEMA_FILE + ' in phpMyAdmin first (or db/schema-v15.sql for app_settings).' }); throw e; }
      }
      audit.record(req, { action: 'bank.ignore', entity: 'bank_credit', id, summary: 'Not a sale (' + REASONS[reason] + (note ? ': ' + note : '') + ') · ₹' + num(c.amount) + ' · ref ' + s(c.upi_ref), details: { reason, note, amount: num(c.amount), upiRef: s(c.upi_ref), receivedAt: s(c.received_at), storedIn: where } });
      res.json({ ok: true, id, storedIn: where, message: '🙈 Marked "Not a sale" (' + REASONS[reason] + ').' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/bank-credits/unignore', async (req, res) => {
    if (!auth(req, res)) return;
    const id = idOf(req.body);
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      const prev = await ignoredInfo(c);
      if (!prev) return res.json({ ok: true, already: true, id, message: 'This payment is not marked "Not a sale".' });
      if (c.ignored_at) await db.query('UPDATE bank_credits SET ignored_at = NULL, ignored_reason = NULL, ignored_note = NULL WHERE id = ?', [id]);
      const map = await st.fallbackIgnores();
      if (map[String(id)]) { delete map[String(id)]; await st.saveSetting(IGNORE_KEY, JSON.stringify(map)); }
      audit.record(req, { action: 'bank.unignore', entity: 'bank_credit', id, summary: 'Undid "Not a sale" (was ' + (REASONS[up(prev.reason)] || prev.reason) + ') · ₹' + num(c.amount) + ' · ref ' + s(c.upi_ref) });
      res.json({ ok: true, id, message: '↩️ Back in the unmatched list.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/bank-credits/link', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = idOf(b);
    const orderId = up(b.orderId).replace(/\s+/g, '');
    const override = b.override === true || String(b.override) === 'true';
    const reason = s(b.reason).slice(0, 300);
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    if (!orderId) return res.status(400).json({ ok: false, field: 'orderId', message: 'Type or pick the order ID (FF…).' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      if (c.consumed_order_id) {
        if (up(c.consumed_order_id) === orderId) return res.json({ ok: true, already: true, id, orderId, message: 'Already linked to ' + orderId + '.' });
        return res.status(409).json({ ok: false, message: 'This payment is already linked to order ' + c.consumed_order_id + '. Unlink it first if that was wrong.' });
      }
      const orders = await db.query('SELECT order_id, name, service, plan, final_amount, status, fulfillment_status, source, txn_ref FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
      const o = orders && orders[0];
      if (!o) return res.status(404).json({ ok: false, field: 'orderId', message: 'No order ' + orderId + '.' });
      const other = await db.query('SELECT id, upi_ref FROM bank_credits WHERE consumed_order_id = ? AND id <> ? LIMIT 1', [o.order_id, id]);
      if (other && other.length) return res.status(409).json({ ok: false, message: 'Order ' + o.order_id + ' already has bank payment #' + other[0].id + ' (ref ' + s(other[0].upi_ref) + ').' });
      const mismatch = Math.round(num(c.amount)) !== Math.round(num(o.final_amount));
      if (mismatch && !override) return res.status(409).json({ ok: false, amountMismatch: true, paymentAmount: num(c.amount), orderAmount: num(o.final_amount), message: 'Amount differs: payment ₹' + num(c.amount) + ', order ₹' + num(o.final_amount) + '. Link anyway only with a reason.' });
      if (mismatch && !reason) return res.status(400).json({ ok: false, field: 'reason', amountMismatch: true, message: 'Write why the amounts differ.' });
      const ig = await ignoredInfo(c);
      const cols = await st.ignoreColumns();
      const r = await db.query('UPDATE bank_credits SET consumed_order_id = ?' + (cols ? ', ignored_at = NULL, ignored_reason = NULL, ignored_note = NULL' : '') + ' WHERE id = ? AND consumed_order_id IS NULL', [o.order_id, id]);
      if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'This payment was just used by another order — refresh and try again.' });
      if (ig && ig.where === 'settings') { const map = await st.fallbackIgnores(); delete map[String(id)]; await st.saveSetting(IGNORE_KEY, JSON.stringify(map)).catch(() => {}); }
      const status = up(o.status);
      audit.record(req, {
        action: 'bank.link', entity: 'bank_credit', id,
        summary: 'Linked ₹' + num(c.amount) + ' (ref ' + s(c.upi_ref) + ') to order ' + o.order_id + ' (₹' + num(o.final_amount) + ', ' + (status || '-') + ')' + (mismatch ? ' · amount differs: ' + reason : reason ? ' · ' + reason : ''),
        details: { orderId: o.order_id, upiRef: s(c.upi_ref), paymentAmount: num(c.amount), orderAmount: num(o.final_amount), amountMismatch: mismatch, reason, orderStatus: status, wasIgnored: ig || null },
      });
      const canMarkPaid = status === 'CREATED' && s(o.source) === 'node';
      res.json({
        ok: true, id, orderId: o.order_id, upiRef: s(c.upi_ref), orderStatus: status, amountMismatch: mismatch, needsPaid: status === 'CREATED', canMarkPaid,
        message: '🔗 Linked to ' + o.order_id + '.' + (status === 'CREATED' ? (canMarkPaid ? ' The order is still unpaid — use "Mark paid + deliver" if this payment is for it.' : ' The order is still unpaid (old-site order: it cannot be marked paid here).') : ''),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/bank-credits/unlink', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = idOf(b);
    const reason = s(b.reason).slice(0, 300);
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    if (!reason) return res.status(400).json({ ok: false, field: 'reason', message: 'Write why this link was wrong (kept in the change log).' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      if (!c.consumed_order_id) return res.json({ ok: true, already: true, id, message: 'This payment is not linked to an order.' });
      const r = await db.query('UPDATE bank_credits SET consumed_order_id = NULL WHERE id = ? AND consumed_order_id = ?', [id, c.consumed_order_id]);
      if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'This payment just changed — refresh and try again.' });
      audit.record(req, { action: 'bank.unlink', entity: 'bank_credit', id, summary: 'Unlinked ₹' + num(c.amount) + ' (ref ' + s(c.upi_ref) + ') from order ' + c.consumed_order_id + ' · ' + reason, details: { orderId: c.consumed_order_id, reason } });
      res.json({ ok: true, id, orderId: c.consumed_order_id, message: '↩️ Unlinked from ' + c.consumed_order_id + '. The order itself was not changed (a paid order stays paid).' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/bank-credits/cutoff', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const reset = b.reset === true;
    const v = reset ? GO_LIVE_DEFAULT : cleanCutoff(b.cutoff);
    if (!v) return res.status(400).json({ ok: false, field: 'cutoff', message: 'Use a date and time like 2026-09-14 21:00' });
    try {
      const before = await st.cutoff();
      try { await st.saveSetting(CUTOFF_KEY, v); }
      catch (e) { if (missingTable(e)) return res.status(409).json({ ok: false, needsSchema: true, message: 'Run db/schema-v15.sql in phpMyAdmin first.' }); throw e; }
      audit.record(req, { action: 'bank.cutoff', entity: 'settings', id: CUTOFF_KEY, summary: 'Go-live time for bank payments: ' + before + ' → ' + v });
      res.json({ ok: true, cutoff: v });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, storeFor, cleanCutoff, GO_LIVE_DEFAULT, REASONS, FILTERS, SCHEMA_FILE };
