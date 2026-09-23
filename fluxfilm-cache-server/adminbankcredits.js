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
// 🧾 One payment for two plans: the extra orders live in bank_credit_links (banklinks.js, schema-v28). The first
// order is still bank_credits.consumed_order_id, so nothing that reads that column had to change.
const banklinks = require('./banklinks');
const paidvia = require('./paidvia');
const SUGGEST_POOL = 60;      // open orders around the payment we look at
const COMBO_POOL = 30;        // of those, how many we try to add up
const MAX_COMBOS = 6;
const NEAR_FLOOR = 20;        // ₹ — a total this close to the payment is still worth showing
const FILTERS = ['after', 'before', 'ignored', 'matched'];

// Why we are suggesting these two (or three) orders together, in the owner's words.
function comboWhy(x) {
  const bits = [];
  if (x.noted) bits.push('one of them is in the payment note');
  if (x.samePhone) bits.push('same customer');
  else if (x.named) bits.push('the name on the payment matches');
  if (x.spreadMin <= 90) bits.push(x.spreadMin <= 1 ? 'bought a minute apart' : 'bought ' + x.spreadMin + ' min apart');
  if (!x.exact) bits.push(x.diff > 0 ? '₹' + Math.abs(x.diff) + ' LESS than the payment' : '₹' + Math.abs(x.diff) + ' MORE than the payment');
  return bits.join(' · ');
}
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
  // Order rows for a list of ids — its own statement (never JOINed with bank_credit_links: different collations).
  async function ordersByIds(ids) {
    const list = [...new Set((ids || []).map((x) => up(x)).filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await db.query('SELECT order_id, name, phone_norm, service, plan, final_amount, status, fulfillment_status, source, created_at_sheet FROM orders WHERE order_id IN (' + list.map(() => '?').join(', ') + ')', list);
    const out = new Map();
    for (const o of rows || []) out.set(up(o.order_id), o);
    return out;
  }
  // "Which orders did this payment pay?" — the split parts when there are any, else the single linked order.
  function partView(parts, omap) {
    return parts.map((p) => {
      const o = omap.get(up(p.orderId)) || {};
      return { orderId: p.orderId, amount: num(p.amount), name: s(o.name), service: s(o.service), plan: s(o.plan), orderAmount: num(o.final_amount), status: up(o.status) };
    });
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
      parts: null,
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
      // 🧾 Payments that were split between several orders: show every order on the card.
      const partMap = await banklinks.partsFor(db.query, list.map((c) => c.id));
      if (partMap.size) {
        const omap = await ordersByIds([].concat(...[...partMap.values()].map((ps) => ps.map((p) => p.orderId))));
        for (const c of list) { const ps = partMap.get(c.id); if (ps && ps.length > 1) c.parts = partView(ps, omap); }
      }
      res.json({ ok: true, filter, cutoff: w.cut, cutoffDefault: GO_LIVE_DEFAULT, counts, credits: list, reasons: REASONS, schemaReady: w.ig.cols, schemaFile: SCHEMA_FILE, splitReady: await banklinks.ready(db.query), splitSchemaFile: banklinks.SCHEMA_FILE });
    } catch (e) { fail(res, e); }
  });

  /**
   * 🔎 What could this payment be? Four ways, best first:
   *   1. the order id written in the payment note,
   *   2. an order of exactly this amount around that time,
   *   3. an order of the customer who pays with this name (learned payer names + the name on the order),
   *   4. TWO or THREE orders that ADD UP to it — customers often pay for both plans in one transfer.
   * Orders that already have a payment (their own or as part of a split) are shown greyed out, never suggested.
   */
  app.get('/admin/api/bank-credits/suggest', async (req, res) => {
    if (!auth(req, res)) return;
    const id = parseInt(s(req.query.id), 10) || 0;
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      const amount = num(c.amount);
      const inNote = s(c.order_ids).toUpperCase().split(',').filter(Boolean);
      const at = s(c.received_at) || null;
      const payerName = s(parseAlert(c.raw).payerName);
      const cols = 'o.order_id, o.name, o.phone_norm, o.service, o.plan, o.final_amount, o.status, o.fulfillment_status, o.created_at_sheet, o.source';
      const linked = '(SELECT b.id FROM bank_credits b WHERE b.consumed_order_id = o.order_id LIMIT 1) AS linked_credit_id';
      const [byNote, pool, payerPhones] = await Promise.all([
        inNote.length ? db.query('SELECT ' + cols + ', ' + linked + ' FROM orders o WHERE o.order_id IN (' + inNote.map(() => '?').join(', ') + ')', inNote) : [],
        at ? db.query('SELECT ' + cols + ', ' + linked + " FROM orders o WHERE o.created_at_sheet BETWEEN (? - INTERVAL 2 DAY) AND (? + INTERVAL 1 DAY) AND UPPER(COALESCE(o.status, '')) IN ('CREATED', 'PAID') " +
          'ORDER BY ABS(TIMESTAMPDIFF(SECOND, o.created_at_sheet, ?)) LIMIT ' + SUGGEST_POOL, [at, at, at]) : [],
        payerName ? paidvia.searchPayerPhones(db.query, payerName, 8).catch(() => []) : [],
      ]);
      // 💳 Who pays with this name: the phone numbers we learned from earlier payments.
      const phones = new Set((payerPhones || []).map((p) => s(p.phone_norm)).filter(Boolean));
      const payerKey = paidvia.compactName(payerName);
      const payerWords = paidvia.displayName(payerName).split(' ').filter((t) => t.length >= 4);
      const nameHit = (o) => {
        if (s(o.phone_norm) && phones.has(s(o.phone_norm))) return 'pays';
        const n = paidvia.compactName(o.name);
        if (!payerKey || n.length < 3) return '';
        if (n === payerKey) return 'same';
        if (payerKey.includes(n) || n.includes(payerKey)) return 'part';
        const words = paidvia.displayName(o.name).split(' ');
        return payerWords.some((t) => words.includes(t)) ? 'part' : '';
      };
      const all = [].concat(byNote || [], pool || []);
      const alsoLinked = await banklinks.creditFor(db.query, all.map((o) => o.order_id));
      const creditIdOf = (o) => o.linked_credit_id || (alsoLinked.get(up(o.order_id)) || {}).creditId || null;
      const row = (o, why) => ({
        order_id: s(o.order_id), name: s(o.name), phone_norm: s(o.phone_norm), service: s(o.service), plan: s(o.plan),
        final_amount: num(o.final_amount), status: s(o.status), fulfillment_status: s(o.fulfillment_status),
        created_at_sheet: s(o.created_at_sheet), source: s(o.source),
        inNote: inNote.includes(up(o.order_id)), linkedCreditId: creditIdOf(o), payerMatch: nameHit(o), why,
      });
      const seen = new Set(); const orders = [];
      const push = (o, why) => { const k = up(o.order_id); if (seen.has(k)) return; seen.add(k); orders.push(row(o, why)); };
      for (const o of byNote || []) push(o, 'note');
      for (const o of pool || []) if (Math.round(num(o.final_amount)) === Math.round(amount)) push(o, 'amount');
      for (const o of pool || []) if (nameHit(o)) push(o, 'name');

      // ➕ Two or three orders that add up to this payment. Only orders that are still free to be linked.
      const cand = (pool || []).filter((o) => !creditIdOf(o)).slice(0, COMBO_POOL).map((o) => row(o, 'combo'));
      const tol = Math.max(NEAR_FLOOR, Math.round(amount * 0.05));
      const found = [];
      const add = (list) => {
        const total = list.reduce((a, o) => a + o.final_amount, 0);
        const diff = Math.round((amount - total) * 100) / 100;
        if (Math.abs(diff) > tol) return;
        const phone = s(list[0].phone_norm);
        const samePhone = !!phone && list.every((o) => s(o.phone_norm) === phone);
        const named = list.some((o) => o.payerMatch);
        const noted = list.some((o) => o.inNote);
        const times = list.map((o) => Date.parse(s(o.created_at_sheet).replace(' ', 'T'))).filter((t) => !isNaN(t));
        const spreadMin = times.length > 1 ? Math.round((Math.max.apply(null, times) - Math.min.apply(null, times)) / 60000) : 0;
        const exact = Math.round(diff) === 0;
        const x = { orders: list, total: Math.round(total * 100) / 100, diff, exact, samePhone, named, noted, spreadMin };
        x.score = (exact ? 1000 : 0) + (samePhone ? 120 : 0) + (noted ? 80 : 0) + (named ? 40 : 0) - Math.min(120, spreadMin / 30) - list.length * 4 - Math.abs(diff);
        found.push(x);
      };
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) add([cand[i], cand[j]]);
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) for (let k = j + 1; k < cand.length; k++) add([cand[i], cand[j], cand[k]]);
      const exactOnes = found.filter((x) => x.exact);
      // Exact matches are worth showing several of; near misses are guesses, so only the best few.
      const combos = (exactOnes.length ? exactOnes : found).sort((a, b) => b.score - a.score).slice(0, exactOnes.length ? MAX_COMBOS : 3)
        .map((x) => ({ orders: x.orders, total: x.total, diff: x.diff, exact: x.exact, samePhone: x.samePhone, why: comboWhy(x) }));

      res.json({
        ok: true, id, amount, payerName, orders: orders.slice(0, 10), combos,
        splitReady: await banklinks.ready(db.query), splitSchemaFile: banklinks.SCHEMA_FILE, maxParts: banklinks.MAX_PARTS,
      });
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

  /**
   * 🔗 Link this payment to an order — or to SEVERAL orders when one transfer paid for two plans.
   * `orderId` (one order) behaves exactly as it always did. `orderIds` (two or more) splits the payment: the
   * first order still goes into bank_credits.consumed_order_id, and every part is written to bank_credit_links,
   * so an order can never end up with two payments and a payment can never be spent twice.
   */
  app.post('/admin/api/bank-credits/link', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = idOf(b);
    const ids = [...new Set([].concat(Array.isArray(b.orderIds) ? b.orderIds : [], b.orderId ? [b.orderId] : []).map((x) => up(x).replace(/\s+/g, '')).filter(Boolean))];
    const override = b.override === true || String(b.override) === 'true';
    const reason = s(b.reason).slice(0, 300);
    const split = ids.length > 1;
    if (!id) return res.status(400).json({ ok: false, message: 'Bank payment id required.' });
    if (!ids.length) return res.status(400).json({ ok: false, field: 'orderId', message: 'Type or pick the order ID (FF…).' });
    if (ids.length > banklinks.MAX_PARTS) return res.status(400).json({ ok: false, field: 'orderId', message: 'One payment can be split between at most ' + banklinks.MAX_PARTS + ' orders.' });
    try {
      const c = await loadCredit(id);
      if (!c) return res.status(404).json({ ok: false, message: 'Bank payment not found.' });
      if (c.consumed_order_id) {
        const already = await banklinks.ordersOf(db.query, id, c.consumed_order_id);
        if (already.length === ids.length && ids.every((x) => already.map(up).includes(x))) return res.json({ ok: true, already: true, id, orderId: s(c.consumed_order_id), orderIds: already, message: 'Already linked to ' + already.join(' + ') + '.' });
        return res.status(409).json({ ok: false, message: 'This payment is already linked to ' + (already.length > 1 ? already.length + ' orders (' + already.join(', ') + ')' : 'order ' + c.consumed_order_id) + '. Unlink it first if that was wrong.' });
      }
      const omap = await ordersByIds(ids);
      const missing = ids.filter((x) => !omap.has(x));
      if (missing.length) return res.status(404).json({ ok: false, field: 'orderId', message: missing.length === 1 ? 'No order ' + missing[0] + '.' : 'No order: ' + missing.join(', ') + '.' });
      const list = ids.map((x) => omap.get(x));
      const other = await db.query('SELECT id, upi_ref, consumed_order_id FROM bank_credits WHERE consumed_order_id IN (' + ids.map(() => '?').join(', ') + ') AND id <> ? LIMIT 3', ids.concat([id]));
      if (other && other.length) return res.status(409).json({ ok: false, message: 'Order ' + s(other[0].consumed_order_id) + ' already has bank payment #' + other[0].id + ' (ref ' + s(other[0].upi_ref) + ').' });
      const inSplit = await banklinks.creditFor(db.query, ids);
      for (const [oid, v] of inSplit) if (v.creditId && v.creditId !== id) return res.status(409).json({ ok: false, message: 'Order ' + oid + ' is already part of bank payment #' + v.creditId + ' — unlink that one first.' });
      if (split && !(await banklinks.ready(db.query, true))) {
        return res.status(409).json({ ok: false, needsSchema: true, schemaFile: banklinks.SCHEMA_FILE, message: 'Run ' + banklinks.SCHEMA_FILE + ' in phpMyAdmin first — it makes room for one payment to pay several orders. Nothing was changed.' });
      }
      // ₹ the orders come to, against what actually arrived.
      const total = Math.round(list.reduce((a, o) => a + num(o.final_amount), 0) * 100) / 100;
      const mismatch = Math.round(num(c.amount)) !== Math.round(total);
      const left = Math.round((num(c.amount) - total) * 100) / 100;
      if (mismatch && !override) {
        return res.status(409).json({
          ok: false, amountMismatch: true, paymentAmount: num(c.amount), orderAmount: total, orderIds: ids, split, left,
          // 💡 The payment is bigger than this one order: it may well be paying for another order too.
          canSplit: !split && left > 0,
          message: split
            ? 'These ' + ids.length + ' orders come to ₹' + total + ' but the payment is ₹' + num(c.amount) + ' (' + (left > 0 ? '₹' + left + ' left over' : '₹' + Math.abs(left) + ' short') + '). Link anyway only with a reason.'
            : 'Amount differs: payment ₹' + num(c.amount) + ', order ₹' + total + '. Link anyway only with a reason.',
        });
      }
      if (mismatch && !reason) return res.status(400).json({ ok: false, field: 'reason', amountMismatch: true, message: 'Write why the amounts differ.' });
      const ig = await ignoredInfo(c);
      const cols = await st.ignoreColumns();
      const first = list[0];
      const r = await db.query('UPDATE bank_credits SET consumed_order_id = ?' + (cols ? ', ignored_at = NULL, ignored_reason = NULL, ignored_note = NULL' : '') + ' WHERE id = ? AND consumed_order_id IS NULL', [s(first.order_id), id]);
      if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'This payment was just used by another order — refresh and try again.' });
      if (split) {
        let saved;
        try { saved = await banklinks.save(db.query, id, list.map((o) => ({ orderId: s(o.order_id), amount: num(o.final_amount) }))); }
        catch (e) { saved = { ok: false, message: String((e && e.message) || e) }; }
        if (!saved.ok) {
          // Put the payment back exactly as it was — a half-done split must never exist.
          await db.query('UPDATE bank_credits SET consumed_order_id = NULL WHERE id = ? AND consumed_order_id = ?', [id, s(first.order_id)]).catch(() => {});
          await banklinks.clearCredit(db.query, id).catch(() => {});
          return res.status(409).json(Object.assign({ ok: false, message: 'The split could not be saved — nothing was changed.' }, saved, { ok: false }));
        }
      }
      if (ig && ig.where === 'settings') { const map = await st.fallbackIgnores(); delete map[String(id)]; await st.saveSetting(IGNORE_KEY, JSON.stringify(map)).catch(() => {}); }
      const parts = list.map((o) => ({ orderId: s(o.order_id), amount: num(o.final_amount), name: s(o.name), service: s(o.service), plan: s(o.plan), status: up(o.status), canMarkPaid: up(o.status) === 'CREATED' && s(o.source) === 'node', isCredit: up(o.status) === 'CREDIT' }));
      const unpaid = parts.filter((p) => p.status === 'CREATED');
      // 💳 A credit renewal is money already owed: linking the payment does NOT settle it, and until it is settled
      // the customer keeps showing in 💳 Receivables. So say so, and offer to settle it right here.
      const credits = parts.filter((p) => p.isCredit);
      const status = up(first.status);
      audit.record(req, {
        action: 'bank.link', entity: 'bank_credit', id,
        summary: (split ? 'Split ₹' + num(c.amount) + ' (ref ' + s(c.upi_ref) + ') between ' + parts.length + ' orders: ' + parts.map((p) => p.orderId + ' ₹' + p.amount).join(' + ') + ' = ₹' + total
          : 'Linked ₹' + num(c.amount) + ' (ref ' + s(c.upi_ref) + ') to order ' + s(first.order_id) + ' (₹' + num(first.final_amount) + ', ' + (status || '-') + ')')
          + (mismatch ? ' · amount differs: ' + reason : reason ? ' · ' + reason : ''),
        details: { orderId: s(first.order_id), orderIds: parts.map((p) => p.orderId), split, parts, upiRef: s(c.upi_ref), paymentAmount: num(c.amount), orderAmount: total, amountMismatch: mismatch, reason, orderStatus: status, wasIgnored: ig || null },
      });
      const canMarkPaid = status === 'CREATED' && s(first.source) === 'node';
      const isCredit = status === 'CREDIT';
      res.json({
        ok: true, id, orderId: s(first.order_id), orderIds: parts.map((p) => p.orderId), parts, split, upiRef: s(c.upi_ref),
        orderStatus: status, amountMismatch: mismatch, needsPaid: status === 'CREATED', canMarkPaid, unpaid,
        isCredit, credits, paymentAmount: num(c.amount),
        message: split
          ? '🔗 Split between ' + parts.length + ' orders: ' + parts.map((p) => p.orderId + ' ₹' + p.amount).join(' + ') + '.'
            + (unpaid.length ? ' ' + unpaid.length + ' of them ' + (unpaid.length === 1 ? 'is' : 'are') + ' still unpaid — use "Mark paid + deliver".' : '')
            + (credits.length ? ' ' + credits.length + ' ' + (credits.length === 1 ? 'is a credit renewal that is' : 'are credit renewals that are') + ' still owed — settle ' + (credits.length === 1 ? 'it' : 'them') + ' in 💳 Receivables.' : '')
          : '🔗 Linked to ' + s(first.order_id) + '.'
            + (status === 'CREATED' ? (canMarkPaid ? ' The order is still unpaid — use "Mark paid + deliver" if this payment is for it.' : ' The order is still unpaid (old-site order: it cannot be marked paid here).') : '')
            + (isCredit ? ' This is a credit renewal — linking does not settle it, so it stays in 💳 Receivables until you mark it paid.' : ''),
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
      // 🧾 A split payment is unlinked from ALL its orders in one go (they were one transfer).
      const orderIds = await banklinks.ordersOf(db.query, id, c.consumed_order_id);
      const r = await db.query('UPDATE bank_credits SET consumed_order_id = NULL WHERE id = ? AND consumed_order_id = ?', [id, c.consumed_order_id]);
      if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'This payment just changed — refresh and try again.' });
      await banklinks.clearCredit(db.query, id).catch(() => {});
      const many = orderIds.length > 1;
      audit.record(req, { action: 'bank.unlink', entity: 'bank_credit', id, summary: 'Unlinked ₹' + num(c.amount) + ' (ref ' + s(c.upi_ref) + ') from ' + (many ? orderIds.length + ' orders ' + orderIds.join(' + ') : 'order ' + c.consumed_order_id) + ' · ' + reason, details: { orderId: c.consumed_order_id, orderIds, split: many, reason } });
      res.json({ ok: true, id, orderId: c.consumed_order_id, orderIds, split: many, message: '↩️ Unlinked from ' + orderIds.join(' + ') + '. ' + (many ? 'Those orders were' : 'The order itself was') + ' not changed (a paid order stays paid).' });
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
