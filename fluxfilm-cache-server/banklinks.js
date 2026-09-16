/**
 * FluxFilm — 🧾 ONE bank payment split across SEVERAL orders (schema-v28, table `bank_credit_links`).
 *
 * Customers often pay for two plans in a single UPI transfer ("Netflix + JioHotstar, ₹205"). A bank credit can only
 * remember ONE order in `bank_credits.consumed_order_id`, so the extra orders live here — one row per part, with the
 * share of the money each order took.
 *   • The first part is ALSO written to `bank_credits.consumed_order_id`, so every older screen, export and report
 *     keeps working unchanged (they still see one order per payment; the extra ones are a bonus, never a surprise).
 *   • A payment with no rows here is an ordinary one-order payment — this file simply answers "nothing".
 *   • Until schema-v28 is run every function answers "nothing" as well, so the panel keeps working and only the
 *     split button says to run the file.
 *
 * ⚠️ Collation: this table is utf8mb4_unicode_ci while `orders` / `bank_credits` are utf8mb4_general_ci, so JOINing
 * them dies on the live MariaDB with "Illegal mix of collations". EVERY statement here touches ONE table and the
 * rows are matched up in JavaScript. Do not add a JOIN.
 */
const SCHEMA_FILE = 'db/schema-v28.sql';
const MAX_PARTS = 6;

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column|ER_BAD_FIELD_ERROR/i.test(String((e && e.message) || e));
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const inList = (n) => '(' + new Array(n).fill('?').join(', ') + ')';
const clean = (list) => [...new Set((list || []).map((x) => up(x).replace(/\s+/g, '')).filter(Boolean))];
// A fake / half-built database can answer anything: only ever walk a real array of rows.
const rowsOf = (r) => (Array.isArray(r) ? r : []);

// The table is created once and never dropped, so "it exists" is cached; "it does not" is re-checked every minute.
let cache = { at: 0, on: false };
async function ready(query, fresh) {
  if (!fresh && cache.on) return true;
  if (!fresh && cache.at && Date.now() - cache.at < 60e3) return cache.on;
  let on = false;
  try { on = Array.isArray(await query('SELECT credit_id FROM bank_credit_links LIMIT 1')); }
  catch (e) { if (!missingTable(e)) throw e; }
  cache = { at: Date.now(), on };
  return on;
}
/** Tests only: forget what we know about the table. */
function resetCache() { cache = { at: 0, on: false }; }

/** creditId → [{ orderId, amount }] in the order they were linked (the first one is the primary). */
async function partsFor(query, creditIds) {
  const ids = [...new Set((creditIds || []).map((x) => parseInt(x, 10) || 0).filter(Boolean))];
  const out = new Map();
  if (!ids.length || !(await ready(query))) return out;
  for (const part of chunk(ids, 200)) {
    const rows = await query('SELECT id, credit_id, order_id, amount FROM bank_credit_links WHERE credit_id IN ' + inList(part.length) + ' ORDER BY id', part);
    for (const r of rowsOf(rows)) {
      const k = parseInt(r.credit_id, 10) || 0;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ orderId: s(r.order_id), amount: num(r.amount) });
    }
  }
  return out;
}

/** orderId → { creditId, amount } — "which payment paid this order?" for orders that are part of a split. */
async function creditFor(query, orderIds) {
  const ids = clean(orderIds);
  const out = new Map();
  if (!ids.length || !(await ready(query))) return out;
  for (const part of chunk(ids, 200)) {
    const rows = await query('SELECT credit_id, order_id, amount FROM bank_credit_links WHERE order_id IN ' + inList(part.length), part);
    for (const r of rowsOf(rows)) {
      const k = s(r.order_id);
      if (k && !out.has(k)) out.set(k, { creditId: parseInt(r.credit_id, 10) || 0, amount: num(r.amount) });
    }
  }
  return out;
}

/** Every order of this payment: the parts when it is a split, else just the primary order. */
async function ordersOf(query, creditId, consumedOrderId) {
  const parts = (await partsFor(query, [creditId])).get(parseInt(creditId, 10) || 0) || [];
  if (parts.length) return parts.map((p) => p.orderId);
  return s(consumedOrderId) ? [s(consumedOrderId)] : [];
}

/**
 * Write the parts of one payment (replaces whatever was there). `parts` = [{ orderId, amount }], first = primary.
 * The caller must have set bank_credits.consumed_order_id to the first order already.
 */
async function save(query, creditId, parts) {
  const id = parseInt(creditId, 10) || 0;
  const list = (parts || []).map((p) => ({ orderId: up(p && p.orderId).replace(/\s+/g, ''), amount: num(p && p.amount) })).filter((p) => p.orderId);
  if (!id || list.length < 2) return { ok: false, message: 'A split needs at least two orders.' };
  if (list.length > MAX_PARTS) return { ok: false, message: 'A payment can be split between at most ' + MAX_PARTS + ' orders.' };
  if (!(await ready(query, true))) return { ok: false, needsSchema: true, schemaFile: SCHEMA_FILE, message: 'Run ' + SCHEMA_FILE + ' in phpMyAdmin first — it makes room for one payment to pay several orders.' };
  await query('DELETE FROM bank_credit_links WHERE credit_id = ?', [id]);
  for (const p of list) await query('INSERT INTO bank_credit_links (credit_id, order_id, amount) VALUES (?, ?, ?)', [id, p.orderId, p.amount]);
  return { ok: true, parts: list };
}

/** Forget the split of one payment (used by Unlink and when a split could not be finished). */
async function clearCredit(query, creditId) {
  const id = parseInt(creditId, 10) || 0;
  if (!id || !(await ready(query))) return 0;
  const r = await query('DELETE FROM bank_credit_links WHERE credit_id = ?', [id]);
  return (r && r.affectedRows) || 0;
}

/** Take one order out of whatever split it is in (used when an order is erased). Returns the rows removed. */
async function dropOrder(query, orderId) {
  const id = up(orderId).replace(/\s+/g, '');
  if (!id || !(await ready(query))) return [];
  const rows = await query('SELECT id, credit_id, order_id, amount FROM bank_credit_links WHERE order_id = ?', [id]);
  if (!rowsOf(rows).length) return [];
  await query('DELETE FROM bank_credit_links WHERE order_id = ?', [id]);
  return rowsOf(rows).map((r) => ({ creditId: parseInt(r.credit_id, 10) || 0, orderId: s(r.order_id), amount: num(r.amount) }));
}

/** Rows left on a payment after dropOrder — so the caller can point consumed_order_id at one that still exists. */
async function remaining(query, creditId) {
  const id = parseInt(creditId, 10) || 0;
  if (!id || !(await ready(query))) return [];
  const rows = await query('SELECT order_id, amount FROM bank_credit_links WHERE credit_id = ? ORDER BY id', [id]);
  return rowsOf(rows).map((r) => ({ orderId: s(r.order_id), amount: num(r.amount) }));
}

module.exports = {
  SCHEMA_FILE, MAX_PARTS, ready, resetCache, partsFor, creditFor, ordersOf, save, clearCredit, dropOrder, remaining,
  _internal: { missingTable, chunk, inList, clean, rowsOf },
};
