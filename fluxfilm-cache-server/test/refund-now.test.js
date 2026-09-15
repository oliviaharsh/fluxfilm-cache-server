/* ⚡ Refund now (owner request 15 Sep 2026): the owner issues a refund at once — UPI (already sent or to send), coins or a
   coupon — for a delivered plan, an undelivered paid order, or an old-site plan (manual record). Real admin routes
   (adminorderactions.js → adminrefundnow.js) on an in-memory MySQL that refuses cross-collation JOINs; mocked mailer /
   push / coins: no real email. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 30));

const NOW = new Date(2026, 8, 15, 12, 0, 0);
const p2 = (x) => String(x).padStart(2, '0');
const dt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const days = (n) => new Date(NOW.getTime() + n * 86400e3);
const up = (v) => String(v == null ? '' : v).toUpperCase();

// ---------------------------------------------------------------- in-memory MySQL (strict: unknown SQL throws)
let S;
const TABLES = ['orders', 'subs', 'offers', 'coupons', 'todos', 'ledger', 'settings', 'requests'];
function fresh() { S = { orders: [], subs: [], offers: [], coupons: [], todos: [], ledger: [], settings: {}, requests: [], sql: [], holds: [] }; }
fresh();
const snap = () => clone(TABLES.reduce((o, k) => { o[k] = S[k]; return o; }, {}));
const restore = (x) => { for (const k of TABLES) S[k] = x[k]; };
const order = (id) => S.orders.find((o) => o.order_id === id);
const rawOrder = (id) => JSON.parse(order(id).raw_json || '{}');
const sub = (id) => S.subs.find((x) => x.sub_id === id);
const offer = (id) => S.offers.find((o) => o.offer_id === id);
const nowRows = () => S.offers.filter((r) => /^RN[A-Z0-9]{8}$/.test(r.offer_id));

// PR 121 lesson: refund_offers / refund_requests / feed_* use utf8mb4_unicode_ci, the old tables the server default.
// MariaDB refuses to compare them in one statement ("Illegal mix of collations") — so does this fake.
const NEW_T = /\b(refund_offers|refund_requests|feed_\w+)\b/;
const OLD_T = /\b(orders|customers|subscriptions)\b/;
function collationGuard(sql) {
  if (NEW_T.test(sql) && OLD_T.test(sql)) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT) for operation \'=\': ' + sql); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; }
}

function insertRow(sql, p) {
  const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim());
  const vals = sql.match(/VALUES \((.*)\)$/)[1].split(',').map((v) => v.trim());
  let i = 0; const row = {};
  cols.forEach((c, k) => { const v = vals[k]; row[c] = v === '?' ? p[i++] : v === 'NULL' ? null : v.replace(/^'|'$/g, ''); });
  return row;
}

function run(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  S.sql.push(sql);
  collationGuard(sql);
  if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
  let m;
  if (/^SELECT GET_LOCK/.test(sql) || /^SELECT RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return S.settings[p[0]] ? [{ value: S.settings[p[0]] }] : [];
  // orders
  if (/^SELECT \* FROM orders WHERE order_id = \? LIMIT 1( FOR UPDATE)?$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, service, plan, name, email, phone, phone_norm, status, final_amount, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, status FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map((o) => ({ order_id: o.order_id, status: o.status }));
  if (/^SELECT \* FROM orders WHERE \(order_id = \? OR renew_sub_id = \?\) AND UPPER\(status\) IN \('PAID', 'REFUNDED'\) ORDER BY created_at_sheet DESC LIMIT 5$/.test(sql)) return S.orders.filter((o) => (o.order_id === p[0] || (o.renew_sub_id && o.renew_sub_id === p[1])) && ['PAID', 'REFUNDED'].includes(up(o.status))).map(clone);
  if (/^SELECT order_id, service, plan, final_amount, status, fulfillment_status, order_type, renew_sub_id, source, phone_norm, raw_json FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET raw_json = \? WHERE order_id = \? LIMIT 1$/.test(sql)) { const o = order(p[1]); if (o) o.raw_json = p[0]; return { affectedRows: o ? 1 : 0 }; }
  if (/^UPDATE orders SET status = 'REFUNDED', fulfillment_status = 'REFUNDED', raw_json = \? WHERE order_id = \? LIMIT 1$/.test(sql)) { const o = order(p[1]); Object.assign(o, { status: 'REFUNDED', fulfillment_status: 'REFUNDED', raw_json: p[0] }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, service, plan, final_amount, status, raw_json FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'REFUNDED'/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0] && up(o.status) === 'REFUNDED').map(clone);
  if (/^SELECT o\.order_id, o\.name, o\.phone_norm, o\.email, o\.service, o\.plan, o\.final_amount, o\.raw_json, o\.created_at_sheet FROM orders o WHERE UPPER\(o\.status\) = 'REFUNDED' AND JSON_UNQUOTE/.test(sql)) return S.orders.filter((o) => up(o.status) === 'REFUNDED' && JSON.parse(o.raw_json || '{}').RefundMethod === 'UPI_PENDING').map(clone);
  // subscriptions
  if (/^SELECT \* FROM subscriptions WHERE sub_id = \? LIMIT 1( FOR UPDATE)?$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  if (/^SELECT \* FROM subscriptions WHERE sub_id = \?$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  if (/^SELECT \* FROM subscriptions WHERE order_id = \?( FOR UPDATE)?$/.test(sql)) return S.subs.filter((x) => x.order_id === p[0]).map(clone);
  if (/^SELECT \* FROM subscriptions WHERE group_id = \?$/.test(sql)) return S.subs.filter((x) => x.group_id === p[0]).map(clone);
  if (/^SELECT sub_id, status, fulfillment_status, start_date, source, login_id, inventory_ref, account_id, profile_name, profile_number FROM subscriptions WHERE order_id = \?$/.test(sql)) return S.subs.filter((x) => x.order_id === p[0]).map(clone);
  if (/^SELECT sub_id, phone_norm, status, raw_json FROM subscriptions WHERE sub_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  if ((m = sql.match(/^UPDATE subscriptions SET status = '(REFUNDED|CANCELLED)', fulfillment_status = 'REFUNDED'(, raw_json = \?)? WHERE sub_id = \? LIMIT 1$/))) { const x = sub(p[p.length - 1]); Object.assign(x, { status: m[1], fulfillment_status: 'REFUNDED' }); if (m[2]) x.raw_json = p[0]; return { affectedRows: 1 }; }
  if (/^SELECT sub_id, service, plan, phone, email, expiry_date, source, status, fulfillment_status FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  // refund_offers
  if (/^SELECT \* FROM refund_offers WHERE order_id = \? ORDER BY created_at DESC LIMIT 5$/.test(sql)) return S.offers.filter((r) => r.order_id === p[0]).slice().reverse().map(clone);
  if (/^SELECT \* FROM refund_offers WHERE live_order = \? LIMIT 1$/.test(sql)) return S.offers.filter((r) => r.live_order && r.live_order === p[0]).map(clone);
  if (/^SELECT offer_id FROM refund_offers WHERE offer_id = \? LIMIT 1$/.test(sql)) return S.offers.filter((r) => r.offer_id === p[0]).map((r) => ({ offer_id: r.offer_id }));
  if (/^SELECT \* FROM refund_offers WHERE phone_norm = \? AND status = 'OFFERED' ORDER BY created_at DESC LIMIT 10$/.test(sql)) return S.offers.filter((r) => r.phone_norm === p[0] && r.status === 'OFFERED').map(clone);
  if (/^SELECT \* FROM refund_offers ORDER BY created_at DESC LIMIT 100$/.test(sql)) return S.offers.slice().reverse().map(clone);
  if (/^SELECT sub_ids FROM refund_offers WHERE status IN \('UPI_REQUESTED', 'DONE'\)/.test(sql)) return S.offers.filter((r) => ['UPI_REQUESTED', 'DONE'].includes(r.status) && r.sub_ids).map((r) => ({ sub_ids: r.sub_ids }));
  if (/^INSERT INTO refund_offers /.test(sql)) {
    const row = Object.assign({ email_sent: 0, method: null, credit_amount: null, coupon_code: null, upi_id: null, upi_ref: null, accepted_at: null, paid_at: null }, insertRow(sql, p));
    if (row.live_order && S.offers.some((r) => r.live_order === row.live_order)) { const e = new Error("Duplicate entry '" + row.live_order + "' for key 'uq_ro_live_order'"); e.code = 'ER_DUP_ENTRY'; throw e; }
    S.offers.push(row); return { affectedRows: 1 };
  }
  if (/^UPDATE refund_offers SET status = 'EXPIRED', live_order = NULL WHERE status = 'OFFERED' AND expires_at <= \?$/.test(sql)) { for (const r of S.offers) if (r.status === 'OFFERED' && r.expires_at <= p[0]) { r.status = 'EXPIRED'; r.live_order = null; } return { affectedRows: 0 }; }
  if (/^UPDATE refund_offers SET status = 'CANCELLED', live_order = NULL, cancelled_at = \?, cancel_reason = \? WHERE order_id = \? AND status = 'OFFERED'$/.test(sql)) { let n = 0; for (const r of S.offers) if (r.order_id === p[2] && r.status === 'OFFERED') { Object.assign(r, { status: 'CANCELLED', live_order: null, cancelled_at: p[0], cancel_reason: p[1] }); n++; } return { affectedRows: n }; }
  if (/^UPDATE refund_offers SET status = 'DONE', paid_at = \?, upi_ref = \? WHERE offer_id = \? AND status = 'UPI_REQUESTED' LIMIT 1$/.test(sql)) { const r = offer(p[2]); if (!r || r.status !== 'UPI_REQUESTED') return { affectedRows: 0 }; Object.assign(r, { status: 'DONE', paid_at: p[0], upi_ref: p[1] }); return { affectedRows: 1 }; }
  if (/^UPDATE refund_offers SET email_sent = 1 WHERE offer_id = \? LIMIT 1$/.test(sql)) { const r = offer(p[0]); if (r) r.email_sent = 1; return { affectedRows: 1 }; }
  if (/^SELECT phone_norm, name FROM customers WHERE phone_norm IN/.test(sql)) return [];
  // refund_requests
  if (/^SELECT request_id, status FROM refund_requests WHERE order_id = \? AND status = 'OPEN' LIMIT 1$/.test(sql)) return S.requests.filter((r) => r.order_id === p[0] && r.status === 'OPEN').map(clone);
  if (/^UPDATE refund_requests SET status = 'APPROVED', open_key = NULL, admin_message = \?, decided_at = \? WHERE order_id = \? AND status = 'OPEN'$/.test(sql)) { let n = 0; for (const r of S.requests) if (r.order_id === p[2] && r.status === 'OPEN') { Object.assign(r, { status: 'APPROVED', open_key: null, admin_message: p[0], decided_at: p[1] }); n++; } return { affectedRows: n }; }
  if (/^UPDATE refund_requests SET status = 'APPROVED', open_key = NULL, admin_message = \?, decided_at = \? WHERE sub_id IN \([?,]+\) AND status = 'OPEN'$/.test(sql)) { let n = 0; for (const r of S.requests) if (p.slice(2).includes(r.sub_id) && r.status === 'OPEN') { Object.assign(r, { status: 'APPROVED', open_key: null, admin_message: p[0], decided_at: p[1] }); n++; } return { affectedRows: n }; }
  if (/^UPDATE refund_requests SET status = 'OFFERED', open_key = NULL, offer_id = \?, decided_at = \? WHERE order_id = \? AND status = 'OPEN'$/.test(sql)) return { affectedRows: 0 };
  // coupons / to-dos / holds / coins ledger
  if (/^SELECT code FROM coupons WHERE code = \? LIMIT 1$/.test(sql)) return S.coupons.filter((c) => c.code === p[0]).map(clone);
  if (/^INSERT INTO coupons \(code, description, scope, type, value/.test(sql)) { S.coupons.push({ code: p[0], value: p[4], expiry: p[7], allowed_phones: p[12], global_limit: p[9], raw_json: p[14] }); return { affectedRows: 1 }; }
  if (/^INSERT INTO admin_todos \(title, note\) VALUES \(\?, \?\)$/.test(sql)) { const id = S.todos.length + 1; S.todos.push({ id, title: p[0], note: p[1], done: 0 }); return { affectedRows: 1, insertId: id }; }
  if (/^UPDATE admin_todos SET done = 1, done_at = NOW\(\) WHERE id = \? AND done = 0 LIMIT 1$/.test(sql)) { const t = S.todos.find((x) => x.id === p[0] && !x.done); if (t) t.done = 1; return { affectedRows: t ? 1 : 0 }; }
  if (/^UPDATE coupon_usage SET action = 'RELEASED'/.test(sql)) { S.holds.push({ couponUsage: p[0] }); return { affectedRows: 0 }; }
  if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = 'REFUND_CREDIT' LIMIT 1$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0]).map((l, i) => ({ id: i + 1 }));
  throw new Error('fake db: unhandled SQL: ' + sql);
}
let txQueue = Promise.resolve();
function makeConn() {
  let done = null; let snapv = null;
  const finish = () => { if (done) { const d = done; done = null; d(); } };
  return {
    query: async (sql, p) => [run(sql, p)],
    beginTransaction: async () => { const prev = txQueue; let d; txQueue = new Promise((res) => { d = res; }); await prev; done = d; snapv = snap(); },
    commit: async () => { snapv = null; finish(); },
    rollback: async () => { if (snapv) restore(snapv); snapv = null; finish(); },
    release: () => {},
  };
}
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => ({ getConnection: async () => makeConn() }) };
const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };

// ---------------------------------------------------------------- mocks
const mails = []; const pushes = [];
const fakeMailer = { send: async (to, subj, html) => { mails.push({ to, subj, html }); return { ok: true }; }, sendAccessEmail: async () => { throw new Error('no real email in tests'); } };
const fakePush = { sendToPhone: async (ph, msg) => { pushes.push({ ph, msg }); return { ok: true }; }, sendToAdmins: async (msg) => { pushes.push({ admin: true, msg }); return { ok: true }; } };
const fakeCoins = {
  addRefundCreditOn: async (conn, { orderId, phone, credit }) => {
    const [dup] = await conn.query("SELECT id FROM coins_ledger WHERE order_id = ? AND event = 'REFUND_CREDIT' LIMIT 1", [orderId]);
    if ((dup || []).length) return { ok: true, already: true };
    if (!phone || String(phone).length !== 10) return { ok: false, credit: 0 };
    S.ledger.push({ event: 'REFUND_CREDIT', order_id: orderId, phone_norm: phone, coins_delta: credit });
    return { ok: true, credit, creditAfter: S.ledger.filter((l) => l.phone_norm === phone).reduce((n, l) => n + l.coins_delta, 0) };
  },
  undoOrderCoinsOn: async (conn, orderId) => { S.holds.push({ coins: orderId }); return { returned: 5 }; },
};
const referrals = { cancelForOrderOn: async (conn, orderId) => { S.holds.push({ referral: orderId }); return { cancelled: 1 }; } };
const catalog = { getStockLevels: async () => ({ ok: true, levels: {} }) };
const refundsMod = require('../refunds');
const R = refundsMod.create({ db: mockDb, coins: fakeCoins, push: fakePush, mailer: fakeMailer, now: () => NOW });

// ---------------------------------------------------------------- fixtures
const PH = '9876543210';
function paidOrder(id, extra) {
  return Object.assign({ order_id: id, created_at_sheet: dt(days(-10)), name: 'Rahul', email: 'buyer@x.com', phone: PH, phone_norm: PH, service: 'Netflix', plan: 'Sharing 1M', duration_days: 30,
    final_amount: '199.00', status: 'PAID', fulfillment_status: 'FULFILLED', order_type: 'NEW', renew_sub_id: null, source: 'node', raw_json: JSON.stringify({ OrderID: id, Status: 'PAID', FulfillmentStatus: 'FULFILLED' }) }, extra || {});
}
function liveSub(id, orderId, extra) {
  return Object.assign({ sub_id: id, order_id: orderId, phone: PH, phone_norm: PH, email: 'buyer@x.com', service: 'Netflix', plan: 'Sharing 1M', duration_days: 30, group_id: null,
    start_date: dt(days(-10)), expiry_date: dt(days(20)), status: 'ACTIVE', fulfillment_status: 'FULFILLED', login_id: 'nf1@x.com', password: 'pw', inventory_ref: 'NFLX-D1#P2', account_id: 'NFLX-D1', removed: 0, source: 'node', raw_json: JSON.stringify({ SubID: id, Status: 'ACTIVE' }) }, extra || {});
}

(async () => {
  const express = require('express');
  const audits = [];
  const app = express(); app.use(express.json());
  const auth = (req, res) => { if (req.get('X-Admin-Key') === 'k') return true; res.status(403).json({ ok: false }); return false; };
  const audit = { record: (req, e) => audits.push(e) };
  require('../adminorderactions').mount(app, { db: mockDb, auth, audit, refunds: R, coins: fakeCoins, referrals, catalog, now: () => NOW });
  const RQ = require('../refundrequests').create({ db: mockDb, mailer: fakeMailer, push: fakePush, now: () => NOW });
  require('../adminrefunds').mount(app, { db: mockDb, auth, audit, refunds: R, refundRequests: { list: async () => ({ ok: true, ready: true, requests: [] }), get: RQ.get } });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const r = await fetch(base + p, { headers: h || H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, body, h) => { const r = await fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const now = (body) => post('/admin/api/order/refund-now', body);

  section('pure: amounts never above paid, never negative');
  const A = require('../adminrefundnow').nowAmounts;
  ok('mid-period ₹199 − ₹66 = ₹133; no replacement ignores the charge; amount edited down → charge = the rest',
    A({ paid: 199, reason: 'MID_PERIOD', charge: 66 }).refund === 133 && A({ paid: 199, reason: 'NO_REPLACEMENT', charge: 66 }).refund === 199 && A({ paid: 199, reason: 'NO_REPLACEMENT', amount: 150 }).charge === 49);
  ok('amount > paid, charge > paid, ₹0 refund → errors', A({ paid: 199, reason: 'OTHER', amount: 250 }).field === 'amount' && A({ paid: 199, reason: 'MID_PERIOD', charge: 300 }).field === 'charge' && A({ paid: 199, reason: 'MID_PERIOD', charge: 199 }).field === 'amount');

  section('delivered plan, usage charge, UPI already sent');
  fresh(); mails.length = 0; pushes.length = 0; audits.length = 0;
  S.orders.push(paidOrder('FF100'));
  S.subs.push(liveSub('SUB-100', 'FF100', { group_id: 'G100' }), liveSub('SUB-101', 'FF100', { group_id: 'G100', login_id: 'nf2@x.com', inventory_ref: 'NFLX-D2#P1', raw_json: null }));
  let r = await get('/admin/api/order/refund-now/quote?subId=SUB-100', { 'Content-Type': 'application/json' });
  ok('quote needs the admin key', r.status === 403);
  r = await get('/admin/api/order/refund-now/quote?subId=SUB-100');
  ok('quote from the Customer 360 card: paid ₹199, 10/30 days, suggested ₹66, both devices, allowed', r.body.ok && r.body.mode === 'ORDER' && r.body.orderId === 'FF100' && r.body.paid === 199 && r.body.daysUsed === 10 && r.body.suggestedCharge === 66 && r.body.delivered && r.body.allowed && r.body.subIds.join() === 'SUB-100,SUB-101', r.body);
  const body100 = { orderId: 'FF100', reason: 'MID_PERIOD', charge: 66, amount: 133, method: 'UPI', upi: 'rahul.k@okhdfcbank', reference: 'UTR777', upiSent: true, note: 'As agreed on WhatsApp', notify: true };
  r = await post('/admin/api/order/refund-now', body100, { 'Content-Type': 'application/json' });
  ok('refund needs the admin key (nothing changed)', r.status === 403 && order('FF100').status === 'PAID' && !S.offers.length);
  r = await now(body100);
  const raw100 = rawOrder('FF100'); const rn100 = nowRows()[0] || {};
  ok('order REFUNDED, typed columns + raw_json in step (UPI sent, ref, paid / charge, delivered, ⚡ by admin)', r.body.ok && order('FF100').status === 'REFUNDED' && order('FF100').fulfillment_status === 'REFUNDED' && raw100.Status === 'REFUNDED' && raw100.FulfillmentStatus === 'REFUNDED' &&
    raw100.RefundMethod === 'UPI' && raw100.RefundState === 'DONE' && raw100.RefundUpi === 'rahul.k@okhdfcbank' && raw100.RefundRef === 'UTR777' && !!raw100.RefundUpiSentAt && raw100.RefundAmount === 133 && raw100.RefundPaid === 199 && raw100.RefundCharge === 66 && raw100.RefundKind === 'DELIVERED' && raw100.RefundReason === 'MID_PERIOD' && raw100.RefundNow === true && raw100.RefundOfferId === rn100.offer_id, { body: r.body, raw100 });
  ok('refund record: RN… row DONE, UPI, ref, both subs, live on the order', /^RN[A-Z0-9]{8}$/.test(rn100.offer_id) && rn100.status === 'DONE' && rn100.method === 'UPI' && rn100.upi_id === 'rahul.k@okhdfcbank' && rn100.upi_ref === 'UTR777' && Number(rn100.refund_amount) === 133 && Number(rn100.charge_amount) === 66 && rn100.sub_ids === 'SUB-100,SUB-101' && rn100.live_order === 'FF100' && !!rn100.paid_at, rn100);
  ok('every device of the purchase REFUNDED (raw_json where present)', sub('SUB-100').status === 'REFUNDED' && JSON.parse(sub('SUB-100').raw_json).Status === 'REFUNDED' && sub('SUB-101').status === 'REFUNDED' && sub('SUB-101').raw_json === null && r.body.accessEnded === 2, S.subs);
  ok('change log: refund.now with amounts and method', audits.some((x) => x.action === 'refund.now' && x.id === 'FF100' && /₹133 \(paid ₹199 − charge ₹66\)/.test(x.summary) && /UPI rahul\.k@okhdfcbank \(sent, ref UTR777\)/.test(x.summary)), audits);
  await tick();
  const m100 = mails.find((x) => /₹133 refunded to your UPI/.test(x.subj));
  ok('email (mocked): "₹133 refunded to your UPI … (ref UTR777)" + the owner\'s note, to the order email', !!m100 && m100.to === 'buyer@x.com' && /ref UTR777/.test(m100.html) && /As agreed on WhatsApp/.test(m100.html) && nowRows()[0].email_sent === 1, mails.map((x) => x.subj));
  let pend = await R.getPendingRefunds(PH);
  ok('website: one-time "✅ sent" pop-up data for that phone', pend.ok && pend.sent.length === 1 && pend.sent[0].orderId === 'FF100' && pend.sent[0].amount === 133 && pend.sent[0].reference === 'UTR777', pend);

  section('access ended: Recover, Get OTP, renew, Remove users');
  const recover = require('../recover');
  ok('Recover rowInactive: the refunded rows are inactive', recover._internal.rowInactive(sub('SUB-100')) === true && recover._internal.rowInactive(sub('SUB-101')) === true);
  ok('Get OTP rowBlocked: blocked', require('../otpaccess')._internal.rowBlocked(sub('SUB-100'), NOW.getTime()) === true);
  const rq = await require('../order').renewQuote('SUB-100');
  ok('renew blocked', rq.ok === false && rq.renewBlocked === true && /refunded/.test(rq.message), rq);
  const ex = require('../expiredusers');
  const live = [liveSub('SUB-LIVE', 'FF1', { phone_norm: '9000000001', inventory_ref: 'NFLX-D1#P3', expiry_date: dt(days(15)) })];
  const loaded = await ex.load(async (sql, p) => {
    if (/refund_offers/.test(sql)) return run(sql, p);
    if (/AND UPPER\(s\.status\) = 'REFUNDED'/.test(sql)) return S.subs.filter((x) => p.includes(x.sub_id) && x.status === 'REFUNDED').map((x) => Object.assign(clone(x), { name: 'Rahul' }));
    if (/FROM subscriptions s/.test(sql)) return live;
    return [];
  }, { now: NOW });
  ok('🚪 Remove users counts the ⚡-refunded device on a login with active users', loaded.main.pending >= 1 && loaded.main.groups.some((g) => g.people.some((x) => x.subId === 'SUB-100')), loaded.main);

  section('double submit is idempotent; a different refund on a refunded order is refused');
  mails.length = 0; audits.length = 0;
  r = await now(body100);
  ok('same refund again → already, nothing new', r.status === 200 && r.body.ok && r.body.already && nowRows().length === 1 && !audits.length, r.body);
  r = await now(Object.assign({}, body100, { method: 'COINS' }));
  ok('already refunded order + another method → refused', r.status === 409 && r.body.alreadyRefunded && !S.ledger.length && nowRows().length === 1, r.body);
  S.orders.push(paidOrder('FF101')); S.subs.push(liveSub('SUB-102', 'FF101'));
  const b101 = { orderId: 'FF101', reason: 'NO_REPLACEMENT', method: 'COINS', addBonus: true, notify: true };
  const [d1, d2] = await Promise.all([now(b101), now(b101)]);
  ok('two taps at once: coins credited exactly once, one ⚡ row, one already', d1.body.ok && d2.body.ok && [d1, d2].filter((x) => x.body.already).length === 1 && S.ledger.filter((l) => l.order_id === 'FF101').length === 1 && nowRows().filter((x) => x.order_id === 'FF101').length === 1, [d1.body, d2.body]);
  await tick();
  ok('…and one email', mails.filter((x) => /FF101/.test(x.subj)).length === 1, mails.map((x) => x.subj));

  section('UPI not sent → 💸 Refunds to send, then ✅ Done');
  fresh(); mails.length = 0;
  S.orders.push(paidOrder('FF110')); S.subs.push(liveSub('SUB-110', 'FF110'));
  r = await now({ orderId: 'FF110', reason: 'NO_REPLACEMENT', method: 'UPI', upi: 'bad@@upi', upiSent: false });
  ok('bad UPI ID refused', r.status === 400 && r.body.field === 'upi' && order('FF110').status === 'PAID');
  r = await now({ orderId: 'FF110', reason: 'NO_REPLACEMENT', method: 'UPI', upi: 'rahul@ybl', upiSent: false });
  const raw110 = rawOrder('FF110'); const rn110 = nowRows()[0] || {};
  ok('queued: order UPI_PENDING / UPI_REQUESTED with the UPI filled, to-do, ⚡ row UPI_REQUESTED, access ended', r.body.ok && r.body.queued && raw110.RefundMethod === 'UPI_PENDING' && raw110.RefundState === 'UPI_REQUESTED' && raw110.RefundUpi === 'rahul@ybl' && S.todos.length === 1 && /Send ₹199 UPI refund to rahul@ybl for FF110/.test(S.todos[0].title) && rn110.status === 'UPI_REQUESTED' && !rn110.paid_at && sub('SUB-110').status === 'REFUNDED', { body: r.body, raw110, rn110 });
  r = await get('/admin/api/refunds');
  const ts = (r.body.toSend || [])[0] || {};
  ok('↩️ Refunds → Refunds to send lists it (⚡ by admin), history row ⚡', r.body.ok && ts.orderId === 'FF110' && ts.upi === 'rahul@ybl' && ts.amount === 199 && ts.byAdmin === true && (r.body.offers || []).some((f) => f.offerId === rn110.offer_id && f.byAdmin && /^No replacement/.test(f.reasonLabel)), r.body);
  await tick();
  ok('email: UPI refund on its way', mails.some((x) => /UPI refund requested/.test(x.subj) && x.to === 'buyer@x.com'), mails.map((x) => x.subj));
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF110', reference: 'UTR9' });
  ok('✅ Done: order UPI sent, ⚡ row DONE with ref, to-do ticked', r.body.ok && rawOrder('FF110').RefundMethod === 'UPI' && offer(rn110.offer_id).status === 'DONE' && offer(rn110.offer_id).upi_ref === 'UTR9' && S.todos[0].done === 1, r.body);

  section('coins with bonus, coupon');
  fresh(); mails.length = 0;
  S.orders.push(paidOrder('FF120'), paidOrder('FF121'), paidOrder('FF130')); S.subs.push(liveSub('SUB-120', 'FF120'), liveSub('SUB-121', 'FF121'), liveSub('SUB-130', 'FF130'));
  r = await now({ orderId: 'FF120', reason: 'NO_REPLACEMENT', method: 'COINS', addBonus: true, amount: '', charge: '' });
  const raw120 = rawOrder('FF120');
  ok('coins +10% (setting): 219 refund credit, raw_json Coins / credit / bonus', r.body.ok && r.body.credit === 219 && S.ledger[0].coins_delta === 219 && raw120.RefundMethod === 'Coins' && raw120.RefundCredit === 219 && raw120.RefundBonus === 20 && raw120.RefundBonusPercent === 10 && nowRows()[0].credit_amount === 219, { body: r.body, raw120 });
  r = await now({ orderId: 'FF121', reason: 'NO_REPLACEMENT', method: 'COINS', addBonus: false });
  ok('coins without bonus: exactly ₹199', r.body.ok && r.body.credit === 199 && rawOrder('FF121').RefundBonus === 0, r.body);
  r = await now({ orderId: 'FF130', reason: 'MID_PERIOD', charge: 0, method: 'COUPON', addBonus: true, bonusPercent: 15 });
  const cp = S.coupons[0] || {}; const cpRaw = JSON.parse(cp.raw_json || '{}'); const raw130 = rawOrder('FF130');
  ok('coupon: ₹199 + 15% = ₹229, one use, this phone, 180 days, typed + raw_json; order raw_json has the code', r.body.ok && cp.value === 229 && cpRaw.Value === 229 && cpRaw.AllowedPhones === PH && cpRaw.GlobalLimit === 1 && cpRaw.Source === 'REFUND' && /^2027-03-14/.test(cp.expiry) && raw130.RefundMethod === 'COUPON' && raw130.RefundCoupon === cp.code && nowRows().find((x) => x.order_id === 'FF130').coupon_code === cp.code, { body: r.body, cp });
  r = await now({ orderId: 'FF130', reason: 'MID_PERIOD', charge: 0, method: 'COUPON', addBonus: true, bonusPercent: 80 });
  ok('bonus above 50% refused', r.status === 400 && r.body.field === 'bonusPercent');
  await tick();
  ok('emails: "219 coins … incl. 20 extra", "199 refund credit", coupon code', mails.some((x) => /219 coins of refund credit added/.test(x.subj)) && mails.some((x) => /₹199 refund credit added/.test(x.subj)) && mails.some((x) => /refund coupon/.test(x.subj) && x.html.includes(cp.code)), mails.map((x) => x.subj));

  section('undelivered paid order: full refund');
  fresh(); mails.length = 0;
  S.orders.push(paidOrder('FF140', { fulfillment_status: 'FAILED', service: 'Zee5', plan: '1 Month', final_amount: '99.00' }));
  S.subs.push(liveSub('SUB-140', 'FF140', { status: 'PENDING', fulfillment_status: 'MANUAL_PENDING', login_id: null, inventory_ref: null, account_id: null, service: 'Zee5' }));
  r = await get('/admin/api/order/actions?id=FF140');
  ok('order page offers ⚡ Refund now (and 💸 Refund)', r.body.ok && r.body.actions.refundNow.allowed && r.body.actions.refund.allowed && !r.body.actions.delivered, r.body.actions);
  r = await get('/admin/api/order/refund-now/quote?orderId=FF140');
  ok('quote: not delivered, no suggested charge', r.body.ok && r.body.delivered === false && r.body.suggestedCharge === 0 && r.body.paid === 99 && r.body.allowed, r.body);
  r = await now({ orderId: 'FF140', reason: 'NOT_DELIVERED', charge: 50, method: 'COINS', addBonus: false });
  const raw140 = rawOrder('FF140');
  ok('full ₹99 (charge ignored), holds released, placeholder CANCELLED, order REFUNDED not-delivered', r.body.ok && r.body.amount === 99 && S.ledger[0].coins_delta === 99 && S.holds.some((x) => x.coins === 'FF140') && S.holds.some((x) => x.referral === 'FF140') && sub('SUB-140').status === 'CANCELLED' &&
    order('FF140').status === 'REFUNDED' && raw140.RefundKind === 'NOT_DELIVERED' && raw140.PreviousFulfillmentStatus === 'FAILED' && refundsMod.refundInfo(order('FF140')).delivered === false && refundsMod.refundInfo(order('FF140')).byAdmin === true && nowRows()[0].sub_ids === '', { body: r.body, raw140 });
  r = await get('/admin/api/order/actions?id=FF140');
  ok('order page afterwards: refunded, ⚡ by admin, no more refund buttons', r.body.actions.refunded && !r.body.actions.refundNow.allowed && r.body.refund.byAdmin === true, r.body);

  section('refusals: amount > paid, not paid, no phone');
  fresh();
  S.orders.push(paidOrder('FF150'), paidOrder('FF160', { phone: '12345', phone_norm: '12345' }), paidOrder('FF170', { status: 'CREATED', fulfillment_status: '' }));
  S.subs.push(liveSub('SUB-150', 'FF150'), liveSub('SUB-160', 'FF160', { phone: '12345', phone_norm: '12345' }));
  r = await now({ orderId: 'FF150', reason: 'OTHER', reasonText: 'Customer asked', amount: 250, method: 'COINS' });
  ok('amount ₹250 > paid ₹199 → refused, nothing changed', r.status === 400 && r.body.field === 'amount' && order('FF150').status === 'PAID' && !S.ledger.length && !S.offers.length, r.body);
  r = await now({ orderId: 'FF150', reason: 'OTHER', method: 'COINS' });
  ok('Other without a reason → refused', r.status === 400 && r.body.field === 'reasonText');
  r = await now({ orderId: 'FF170', reason: 'NOT_DELIVERED', method: 'COINS' });
  ok('not paid → refused', r.status === 409 && r.body.notPaid && order('FF170').status === 'CREATED', r.body);
  r = await now({ orderId: 'FF160', reason: 'NO_REPLACEMENT', method: 'COINS' });
  ok('no 10-digit phone + coins → refused', r.status === 400 && order('FF160').status === 'PAID', r.body);
  r = await now({ orderId: 'FF160', reason: 'NO_REPLACEMENT', method: 'UPI', upi: 'x.y@okaxis', upiSent: false });
  ok('no 10-digit phone + UPI to send → refused', r.status === 400 && order('FF160').status === 'PAID', r.body);
  r = await now({ orderId: 'FF160', reason: 'NO_REPLACEMENT', method: 'UPI', upi: 'x.y@okaxis', upiSent: true, notify: false });
  ok('no 10-digit phone + UPI already sent → recorded with a warning', r.body.ok && order('FF160').status === 'REFUNDED' && (r.body.notes || []).some((n) => /No 10-digit phone/.test(n)) && nowRows()[0].phone_norm === '', r.body);

  section('open offer + customer request closed ("handled by admin")');
  fresh(); mails.length = 0;
  S.orders.push(paidOrder('FF180')); S.subs.push(liveSub('SUB-180', 'FF180'));
  const off = await R.createOffer({ orderId: 'FF180', reason: 'NO_REPLACEMENT', notify: false });
  S.requests.push({ request_id: 'RQ1', order_id: 'FF180', sub_id: 'SUB-180', open_key: 'FF180', phone_norm: PH, status: 'OPEN' });
  r = await get('/admin/api/order/refund-now/quote?orderId=FF180');
  ok('quote shows the open offer + request', r.body.ok && r.body.allowed && r.body.openOffer && r.body.openOffer.offerId === off.offer.offerId && r.body.openRequest.requestId === 'RQ1', r.body);
  r = await now({ orderId: 'FF180', reason: 'NO_REPLACEMENT', method: 'COUPON', addBonus: false });
  const old = offer(off.offer.offerId);
  ok('offer CANCELLED (handled by admin, live slot freed), request APPROVED, ⚡ refund done', r.body.ok && r.body.closedOffers === 1 && r.body.closedRequests === 1 && old.status === 'CANCELLED' && old.live_order === null && /Handled by admin/.test(old.cancel_reason) && S.requests[0].status === 'APPROVED' && S.requests[0].open_key === null && nowRows()[0].live_order === 'FF180' && order('FF180').status === 'REFUNDED', { body: r.body, old, req: S.requests[0] });
  pend = await R.getPendingRefunds(PH);
  ok('customer banner gone', pend.offers.length === 0, pend);

  section('old-site plan (no paid order in MySQL): manual record');
  fresh(); mails.length = 0; audits.length = 0;
  S.subs.push(liveSub('SUB-OLD', 'OLD-77', { source: 'sheet', fulfillment_status: '', login_id: null, inventory_ref: null, account_id: null, profile_number: 'MIG_YT', service: 'YouTube', plan: 'Family 1M', email: 'old@x.com' }));
  S.subs.push(liveSub('SUB-OLD2', 'OLD-78', { source: 'sheet', email: '', raw_json: null, service: 'YouTube' }));
  r = await get('/admin/api/order/refund-now/quote?subId=SUB-OLD');
  ok('quote: old-site plan, paid unknown, allowed', r.body.ok && r.body.legacy && r.body.mode === 'LEGACY' && r.body.paid === null && r.body.allowed && r.body.daysUsed === 10, r.body);
  r = await now({ subId: 'SUB-OLD', reason: 'NO_REPLACEMENT', method: 'UPI', upi: 'old@okicici', upiSent: true });
  ok('without the paid amount → asks for it', r.status === 400 && r.body.field === 'paid' && sub('SUB-OLD').status === 'ACTIVE', r.body);
  r = await now({ subId: 'SUB-OLD', paid: 149, reason: 'NO_REPLACEMENT', method: 'UPI', upi: 'old@okicici', upiSent: false });
  ok('UPI "to send" → refused for old-site plans', r.status === 400 && r.body.field === 'upiSent' && sub('SUB-OLD').status === 'ACTIVE', r.body);
  const bOld = { subId: 'SUB-OLD', paid: 149, reason: 'MID_PERIOD', charge: 50, method: 'UPI', upi: 'old@okicici', reference: 'UTR-OLD', upiSent: true, notify: true };
  r = await now(bOld);
  const sraw = JSON.parse(sub('SUB-OLD').raw_json || '{}'); const rnOld = nowRows()[0] || {};
  ok('recorded on the subscription: REFUNDED + raw_json (₹99 = 149 − 50, UPI, ref, manual)', r.body.ok && r.body.legacy && sub('SUB-OLD').status === 'REFUNDED' && sub('SUB-OLD').fulfillment_status === 'REFUNDED' && sraw.Status === 'REFUNDED' && sraw.RefundAmount === 99 && sraw.RefundPaid === 149 && sraw.RefundCharge === 50 && sraw.RefundUpi === 'old@okicici' && sraw.RefundRef === 'UTR-OLD' && sraw.RefundLegacyManual === true && sraw.RefundNow === true, { body: r.body, sraw });
  ok('⚡ row for history / Remove users (order id OLD-77, live on the sub id); change log entity subscription', rnOld.order_id === 'OLD-77' && rnOld.live_order === 'SUB-OLD' && rnOld.sub_ids === 'SUB-OLD' && rnOld.status === 'DONE' && audits.some((x) => x.action === 'refund.now' && x.entity === 'subscription' && /old-site plan, manual record/.test(x.summary)), { rnOld, audits });
  ok('Recover inactive + renew blocked for it', recover._internal.rowInactive(sub('SUB-OLD')) && (await require('../order').renewQuote('SUB-OLD')).renewBlocked === true);
  await tick();
  ok('emailed only because the plan has an email (old@x.com)', mails.length === 1 && mails[0].to === 'old@x.com' && /₹99 refunded to your UPI/.test(mails[0].subj), mails.map((x) => [x.to, x.subj]));
  r = await now(bOld);
  ok('double submit → already', r.body.ok && r.body.already && nowRows().length === 1, r.body);
  r = await now({ subId: 'SUB-OLD2', paid: 99, reason: 'NO_REPLACEMENT', method: 'COINS', addBonus: false, notify: true });
  await tick();
  ok('no email on the plan: coins credited (keyed on the sub id), nothing emailed', r.body.ok && S.ledger.some((l) => l.order_id === 'SUB-OLD2' && l.coins_delta === 99) && sub('SUB-OLD2').status === 'REFUNDED' && mails.length === 1 && (r.body.notes || []).some((n) => /No email/.test(n)), r.body);

  section('collation guard (PR 121): never JOIN / compare new refund tables with old tables');
  let threw = false;
  try { run('SELECT r.offer_id FROM refund_offers r JOIN orders o ON o.order_id = r.order_id', []); } catch (e) { threw = /Illegal mix of collations/.test(e.message); }
  ok('the fake DB throws on such a JOIN (like MariaDB)', threw);
  const src = fs.readFileSync(path.join(__dirname, '..', 'adminrefundnow.js'), 'utf8');
  const sqls = src.match(/'(?:SELECT|UPDATE|INSERT)[^']*'|"(?:SELECT|UPDATE|INSERT)[^"]*"/g) || [];
  ok('no SQL string in adminrefundnow.js mixes refund_offers / refund_requests with orders / customers / subscriptions', sqls.length > 5 && !sqls.some((q) => NEW_T.test(q) && OLD_T.test(q)), sqls.filter((q) => NEW_T.test(q) && OLD_T.test(q)));

  section('wiring: admin panel, package.json, scripts parse');
  server.close();
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('Customer 360 card: ⚡ Refund now next to 💸 Offer refund', /onclick="offerRefundDialog\(\\'' \+ id \+ '\\'\)">💸 Offer refund<\/button><button class="btn ghost sm" onclick="refundNowDialog\(\\'' \+ id \+ '\\'\)">⚡ Refund now<\/button>/.test(adminHtml));
  ok('order page: data-oa="refundnow" → refundNowForm; form posts to /admin/api/order/refund-now after a confirm summary', /data-oa="refundnow"/.test(adminHtml) && /act === 'refundnow'/.test(adminHtml) && /'\/admin\/api\/order\/refund-now\/quote'/.test(adminHtml) && /'\/admin\/api\/order\/refund-now', body/.test(adminHtml) && /This plan will stop working\./.test(adminHtml) && /⚡ Confirm refund/.test(adminHtml) && /Already sent/.test(adminHtml) && /Add bonus/.test(adminHtml) && /Send email to customer/.test(adminHtml));
  ok('↩️ Refunds history labels "⚡ by admin"', /⚡ by admin<\/span>/.test(adminHtml) && /Recent offers &amp; ⚡ refunds by admin/.test(adminHtml));
  const pkg = require('../package.json');
  ok('package.json runs this test', /node test\/refund-now\.test\.js/.test(pkg.scripts.test));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let bad = 0; let n = 0;
  for (const src2 of [idx, adminHtml]) {
    for (const mm of src2.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type=["']application\/ld\+json/.test(mm[1]) || /type=["'](?!text\/javascript)/.test(mm[1])) continue;
      n++; try { new Function(mm[2]); } catch (e) { bad++; console.log('  script error:', e.message); }
    }
  }
  ok('every inline <script> in index.html + admin.html parses (' + n + ')', n > 1 && bad === 0);
  ok('no real email (mailer mocked, sendAccessEmail never used)', mails.every((x) => x.to && x.subj));

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
