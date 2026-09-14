/**
 * FluxFilm - one-time data cleanup, run RIGHT AFTER the go-live import (admin → 🚚 Go-live import → step 3).
 * Owner approved 2026-09-14.
 *
 *   1. One ID style for subscriptions: every sub ID that isn't "SUB-" + 9 digits (SUB-LG…, SUB-YT-…, SUB-PR-…, the
 *      15-digit ones shop made, a broken "SUB-LG") gets a new SUB-######### ID. Every reference moves with it:
 *      subscriptions.renew_sub_id, orders.renew_sub_id, inventory_profiles.current_sub_id, reminder_log.sub_id and
 *      raw_json. The old ID is kept in raw_json.LegacySubID.
 *   2. Subscriptions whose order doesn't exist (migrated "MIG…" orders, or FF orders missing from the Sheet) get an
 *      order record: MIG IDs become a new FF ID; FF IDs keep their ID. Amount ₹0 and source='migrated', so revenue
 *      and profit don't change.
 *   3. People who have subscriptions but no customer record get one (name from their orders, email from the plan).
 *   4. Test clutter: an order with more than 3 subscriptions whose dates have all passed → marked EXPIRED.
 *
 * Must run AFTER the import (the import matches by Sub ID, so importing after renaming would add the old IDs back).
 * Once done it is recorded in app_settings 'id_cleanup' and the import refuses to run again.
 *
 *   preview()  → what would change (writes nothing)
 *   apply()    → everything in one transaction
 */
const crypto = require('crypto');
const db = require('./db');

const s = (v) => (v == null ? '' : String(v).trim());
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const REGULAR_SUB = /^SUB-\d{9}$/;
const REGULAR_ORDER = /^FF\d{7}$/;
const deps = { rand9: () => String(crypto.randomInt(0, 1e9)).padStart(9, '0'), rand7: () => String(crypto.randomInt(0, 1e7)).padStart(7, '0'), now: () => new Date() };

async function isDone() {
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', ['id_cleanup']); return r.length ? JSON.parse(r[0].value) : null; }
  catch (e) { return null; }
}
async function importDone() {
  try { const r = await db.query("SELECT ts FROM sync_log WHERE note LIKE 'go-live import%' ORDER BY id DESC LIMIT 1", []); return r.length > 0; }
  catch (e) { return false; }
}

async function buildPlan() {
  const subs = await db.query('SELECT sub_id, order_id, phone, phone_norm, email, service, plan, duration_days, start_date, expiry_date, release_eligible_at, status FROM subscriptions', []);
  const orders = await db.query('SELECT order_id, phone, phone_norm, name, status, created_at_sheet FROM orders', []);
  const customers = await db.query('SELECT phone_norm FROM customers', []);
  const orderIds = new Set(orders.map((o) => s(o.order_id)));
  const custPhones = new Set(customers.map((c) => norm(c.phone_norm)));
  const phoneOf = (x) => norm(x.phone_norm || x.phone);

  // 1. Sub IDs.
  const used = new Set(subs.map((x) => s(x.sub_id))); const renames = [];
  for (const x of subs) {
    const id = s(x.sub_id);
    if (REGULAR_SUB.test(id)) continue;
    let nid; do { nid = 'SUB-' + deps.rand9(); } while (used.has(nid));
    used.add(nid);
    renames.push({ from: id, to: nid, service: s(x.service), phone: phoneOf(x), status: s(x.status) });
  }

  // 2. Orders that subscriptions point to but that don't exist.
  const nameByPhone = new Map();
  for (const o of orders.slice().sort((a, b) => s(a.created_at_sheet).localeCompare(s(b.created_at_sheet)))) { const p = norm(o.phone_norm || o.phone); if (p && s(o.name)) nameByPhone.set(p, s(o.name)); }
  const usedOrders = new Set(orderIds); const missing = new Map();
  for (const x of subs) {
    const oid = s(x.order_id);
    if (orderIds.has(oid)) continue;
    const key = oid || ('(none) ' + s(x.sub_id));
    if (!missing.has(key)) {
      let to = oid;
      if (!REGULAR_ORDER.test(oid)) { do { to = 'FF' + deps.rand7(); } while (usedOrders.has(to)); }
      usedOrders.add(to);
      missing.set(key, { from: oid, to, subs: [], sub: x });
    }
    missing.get(key).subs.push(s(x.sub_id));
  }
  const placeholders = [...missing.values()].map((m) => ({
    from: m.from, to: m.to, subs: m.subs, service: s(m.sub.service), plan: s(m.sub.plan), phone: phoneOf(m.sub),
    email: s(m.sub.email), name: nameByPhone.get(phoneOf(m.sub)) || '', start: m.sub.start_date || null, days: m.sub.duration_days || null,
  }));

  // 3. Customers.
  const latest = new Map();
  for (const x of subs) { const p = phoneOf(x); if (p.length !== 10 || custPhones.has(p)) continue; const cur = latest.get(p); if (!cur || s(x.start_date) > s(cur.start_date)) latest.set(p, x); }
  const newCustomers = [...latest.entries()].map(([p, x]) => ({ phone: p, name: nameByPhone.get(p) || '', email: s(x.email), since: x.start_date || null }));

  // 4. Test clutter.
  const now = deps.now().getTime();
  const past = (d) => !d || new Date(s(d).replace(' ', 'T')).getTime() < now;
  const byOrder = new Map();
  for (const x of subs) { const k = s(x.order_id); if (!byOrder.has(k)) byOrder.set(k, []); byOrder.get(k).push(x); }
  const clutter = [...byOrder.entries()]
    .filter(([k, list]) => k && list.length > 3 && list.every((x) => past(x.expiry_date) && past(x.release_eligible_at)) && list.some((x) => s(x.status).toUpperCase() !== 'EXPIRED'))
    .map(([k, list]) => ({ orderId: k, subs: list.length, phone: phoneOf(list[0]), service: s(list[0].service) }));

  // Report only — left for the owner to decide.
  const orderById = new Map(orders.map((o) => [s(o.order_id), o]));
  const phoneMismatch = subs.filter((x) => orderById.has(s(x.order_id)) && phoneOf(x) && norm(orderById.get(s(x.order_id)).phone_norm || orderById.get(s(x.order_id)).phone) !== phoneOf(x))
    .map((x) => ({ subId: s(x.sub_id), orderId: s(x.order_id), planPhone: phoneOf(x), orderPhone: s(orderById.get(s(x.order_id)).phone) }));
  const linked = new Set(subs.map((x) => s(x.order_id)));
  const planKeys = new Set(subs.map((x) => phoneOf(x) + '|' + s(x.service).toLowerCase()));
  const paidNoPlan = orders.filter((o) => s(o.status).toUpperCase() === 'PAID' && !linked.has(s(o.order_id)) && !planKeys.has(norm(o.phone_norm || o.phone) + '|' + s(o.service).toLowerCase()))
    .map((o) => s(o.order_id));
  const staleActive = subs.filter((x) => s(x.status).toUpperCase() === 'ACTIVE' && x.expiry_date && past(x.expiry_date) && past(x.release_eligible_at)).length;

  return { renames, placeholders, newCustomers, clutter, report: { phoneMismatch, paidNoPlan, staleActive, subsWithoutPhone: subs.filter((x) => phoneOf(x).length !== 10).map((x) => s(x.sub_id)) } };
}

function summary(plan) {
  const shapes = {};
  for (const r of plan.renames) { const k = r.from.replace(/\d+/g, (m) => '#'.repeat(Math.min(m.length, 15))); shapes[k] = (shapes[k] || 0) + 1; }
  return {
    ok: true,
    renames: { count: plan.renames.length, byShape: shapes, sample: plan.renames.slice(0, 12) },
    orders: { count: plan.placeholders.length, newIds: plan.placeholders.filter((p) => p.from !== p.to).length, subs: plan.placeholders.reduce((n, p) => n + p.subs.length, 0), sample: plan.placeholders.slice(0, 12).map((p) => ({ from: p.from, to: p.to, subs: p.subs.length, service: p.service, phone: p.phone })) },
    customers: { count: plan.newCustomers.length, list: plan.newCustomers.slice(0, 20) },
    clutter: plan.clutter,
    report: {
      phoneMismatchCount: plan.report.phoneMismatch.length, phoneMismatch: plan.report.phoneMismatch.slice(0, 20),
      paidNoPlanCount: plan.report.paidNoPlan.length, paidNoPlan: plan.report.paidNoPlan.slice(0, 30),
      staleActive: plan.report.staleActive, subsWithoutPhone: plan.report.subsWithoutPhone,
    },
  };
}

async function preview() {
  return Object.assign(summary(await buildPlan()), { preview: true, done: await isDone(), importDone: await importDone() });
}

async function apply() {
  if (await isDone()) return { ok: false, alreadyDone: true, message: 'The cleanup has already been done.' };
  if (!(await importDone())) return { ok: false, needImport: true, message: 'Run the go-live import first (it matches by Sub ID, so it must come before renaming).' };
  const plan = await buildPlan();
  const conn = await db.getPool().getConnection();
  const q = async (sql, p) => { const [r] = await conn.query(sql, p); return r; };
  const counts = { ordersCreated: 0, subsLinked: 0, subsRenamed: 0, references: 0, customersCreated: 0, clutterExpired: 0 };
  try {
    await conn.beginTransaction();
    for (const p of plan.placeholders) {
      const raw = { OrderID: p.to, Service: p.service, Plan: p.plan, Phone: p.phone, Email: p.email, Name: p.name, FinalAmount: 0, Status: 'PAID', FulfillmentStatus: 'FULFILLED', Source: 'migrated' };
      if (p.from && p.from !== p.to) raw.MigratedFrom = p.from;
      await q("INSERT INTO orders (order_id, created_at_sheet, service, plan, duration_days, name, email, phone, phone_norm, discount, price, final_amount, currency, notes, status, fulfillment_status, order_type, source, raw_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'INR', ?, 'PAID', 'FULFILLED', 'NEW', 'migrated', ?)",
        [p.to, p.start, p.service, p.plan, p.days, p.name, p.email, p.phone, p.phone, p.from === p.to ? 'Order record added in cleanup (it was missing)' : 'Migrated plan (old order ' + (p.from || 'none') + ')', JSON.stringify(raw)]);
      counts.ordersCreated++;
      if (p.from !== p.to) {
        for (const sid of p.subs) {
          const u = await q("UPDATE subscriptions SET order_id = ?, raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.OrderID', ?, '$.LegacyOrderID', ?)) WHERE sub_id = ?", [p.to, p.to, p.from, sid]);
          counts.subsLinked += (u && u.affectedRows) || 0;
        }
      } else counts.subsLinked += p.subs.length;
    }
    for (const r of plan.renames) {
      const u = await q("UPDATE subscriptions SET sub_id = ?, raw_json = IF(raw_json IS NULL, JSON_OBJECT('SubID', ?, 'LegacySubID', ?), JSON_SET(raw_json, '$.SubID', ?, '$.LegacySubID', ?)) WHERE sub_id = ?", [r.to, r.to, r.from, r.to, r.from, r.from]);
      counts.subsRenamed += (u && u.affectedRows) ? 1 : 0;
      const refs = [
        await q('UPDATE subscriptions SET renew_sub_id = ? WHERE renew_sub_id = ?', [r.to, r.from]),
        await q("UPDATE orders SET renew_sub_id = ?, raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.RenewSubID', ?)) WHERE renew_sub_id = ?", [r.to, r.to, r.from]),
        await q("UPDATE inventory_profiles SET current_sub_id = ?, raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.CurrentSubID', ?)) WHERE current_sub_id = ?", [r.to, r.to, r.from]),
      ];
      try { refs.push(await q('UPDATE reminder_log SET sub_id = ? WHERE sub_id = ?', [r.to, r.from])); } catch (e) { if (!/doesn't exist/i.test(String(e.message))) throw e; }
      counts.references += refs.reduce((n, x) => n + ((x && x.affectedRows) || 0), 0);
    }
    for (const c of plan.newCustomers) {
      const r = await q("INSERT IGNORE INTO customers (phone, phone_norm, name, email, profile_pic_url, member_since, updated_at, status, customer_id, raw_json) VALUES (?, ?, ?, ?, '', ?, NOW(), 'ACTIVE', ?, ?)",
        [c.phone, c.phone, c.name, c.email, c.since, 'CUS-' + deps.rand7() + '9', JSON.stringify({ Phone: c.phone, Name: c.name, Email: c.email, Source: 'cleanup' })]);
      counts.customersCreated += (r && r.affectedRows) || 0;
    }
    for (const c of plan.clutter) {
      const r = await q("UPDATE subscriptions SET status = 'EXPIRED' WHERE order_id = ? AND UPPER(status) <> 'EXPIRED'", [c.orderId]);
      counts.clutterExpired += (r && r.affectedRows) || 0;
    }
    await q('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)', ['id_cleanup', JSON.stringify({ at: deps.now().toISOString(), counts })]);
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally { conn.release(); }
  return Object.assign(summary(plan), { preview: false, counts });
}

module.exports = { preview, apply, isDone, importDone, REGULAR_SUB, _internal: { deps, buildPlan } };
