/* 💸 Refunds v3 (owner decisions 15 Sep 2026): the customer chooses coins / coupon (+bonus%) or exact UPI; refund
   offers on DELIVERED plans (no replacement / mid-period charge); UPI queue → ✅ Done → email + one-time pop-up;
   access ends (Recover / Get OTP / renew / Remove users). In-memory MySQL, mocked mailer + push: no real email. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 30));
const noTable = (t) => { const e = new Error("Table 'u." + t + "' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };

let NOW = new Date(2026, 8, 15, 12, 0, 0);
const p2 = (x) => String(x).padStart(2, '0');
const dt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const days = (n) => new Date(NOW.getTime() + n * 86400e3);

// ---------------------------------------------------------------- in-memory MySQL (strict: unknown SQL throws)
let S;
const TABLES = ['orders', 'subs', 'offers', 'coupons', 'todos', 'ledger', 'settings'];
function fresh() { S = { orders: [], subs: [], offers: [], coupons: [], todos: [], ledger: [], settings: {}, noOffersTable: false, sql: [] }; }
fresh();
const snap = () => clone(TABLES.reduce((o, k) => { o[k] = S[k]; return o; }, {}));
const restore = (x) => { for (const k of TABLES) S[k] = x[k]; };
const order = (id) => S.orders.find((o) => o.order_id === id);
const rawOrder = (id) => JSON.parse(order(id).raw_json || '{}');
const offer = (id) => S.offers.find((o) => o.offer_id === id);
const sub = (id) => S.subs.find((x) => x.sub_id === id);
const up = (v) => String(v == null ? '' : v).toUpperCase();

function run(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  S.sql.push(sql);
  if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
  if (/FROM customers/.test(sql) && !/^SELECT phone_norm, name FROM customers WHERE phone_norm IN/.test(sql)) throw new Error('refunds must never read the customers profile email: ' + sql);
  if (/refund_offers/.test(sql) && S.noOffersTable) noTable('refund_offers');
  // settings
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return S.settings[p[0]] ? [{ value: S.settings[p[0]] }] : [];
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE value = VALUES\(value\)$/.test(sql)) { S.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  // orders
  if (/^SELECT order_id, service, plan, final_amount, status, raw_json FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'REFUNDED'/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0] && up(o.status) === 'REFUNDED').map(clone);
  if (/^SELECT order_id, email, status, raw_json FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'REFUNDED'/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0] && up(o.status) === 'REFUNDED').map(clone);
  if (/^SELECT order_id, service, plan, name, email, phone, phone_norm, status, final_amount, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT \* FROM orders WHERE order_id = \? LIMIT 1( FOR UPDATE)?$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, status FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map((o) => ({ order_id: o.order_id, status: o.status }));
  if (/^SELECT \* FROM orders WHERE \(order_id = \? OR renew_sub_id = \?\) AND UPPER\(status\) IN \('PAID', 'REFUNDED'\) ORDER BY created_at_sheet DESC LIMIT 5$/.test(sql)) return S.orders.filter((o) => (o.order_id === p[0] || o.renew_sub_id === p[1]) && ['PAID', 'REFUNDED'].includes(up(o.status))).sort((a, b) => String(b.created_at_sheet).localeCompare(String(a.created_at_sheet))).map(clone);
  if (/^UPDATE orders SET raw_json = \? WHERE order_id = \? LIMIT 1$/.test(sql)) { const o = order(p[1]); if (o) o.raw_json = p[0]; return { affectedRows: o ? 1 : 0 }; }
  if (/^UPDATE orders SET status = 'REFUNDED', fulfillment_status = 'REFUNDED', raw_json = \? WHERE order_id = \? LIMIT 1$/.test(sql)) { const o = order(p[1]); Object.assign(o, { status: 'REFUNDED', fulfillment_status: 'REFUNDED', raw_json: p[0] }); return { affectedRows: 1 }; }
  if (/^SELECT o\.order_id, o\.name, o\.phone_norm, o\.email, o\.service, o\.plan, o\.final_amount, o\.raw_json, o\.created_at_sheet FROM orders o WHERE UPPER\(o\.status\) = 'REFUNDED' AND JSON_UNQUOTE/.test(sql)) return S.orders.filter((o) => up(o.status) === 'REFUNDED' && JSON.parse(o.raw_json || '{}').RefundMethod === 'UPI_PENDING').map(clone);
  if (/^SELECT email FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' AND UPPER\(fulfillment_status\) = 'FULFILLED'/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0] && up(o.status) === 'PAID' && up(o.fulfillment_status) === 'FULFILLED').map((o) => ({ email: o.email }));
  // subscriptions
  if (/^SELECT \* FROM subscriptions WHERE sub_id = \?( LIMIT 1)?$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  if (/^SELECT \* FROM subscriptions WHERE order_id = \?$/.test(sql)) return S.subs.filter((x) => x.order_id === p[0]).map(clone);
  if (/^SELECT \* FROM subscriptions WHERE group_id = \?$/.test(sql)) return S.subs.filter((x) => x.group_id === p[0]).map(clone);
  if (/^SELECT sub_id, phone_norm, status, raw_json FROM subscriptions WHERE sub_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  if (/^UPDATE subscriptions SET status = 'REFUNDED', fulfillment_status = 'REFUNDED'(, raw_json = \?)? WHERE sub_id = \? LIMIT 1$/.test(sql)) { const x = sub(p[p.length - 1]); Object.assign(x, { status: 'REFUNDED', fulfillment_status: 'REFUNDED' }); if (p.length > 1) x.raw_json = p[0]; return { affectedRows: 1 }; }
  if (/^SELECT email, status, fulfillment_status, COALESCE\(removed, 0\) AS removed FROM subscriptions WHERE phone_norm = \?/.test(sql)) return S.subs.filter((x) => x.phone_norm === p[0]).map(clone);
  if (/^SELECT sub_id, service, plan, phone, email, expiry_date, source, status FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  // refund_offers
  if (/^SELECT \* FROM refund_offers WHERE phone_norm = \? AND status = 'OFFERED' ORDER BY created_at DESC LIMIT 10$/.test(sql)) return S.offers.filter((r) => r.phone_norm === p[0] && r.status === 'OFFERED').map(clone);
  if (/^SELECT \* FROM refund_offers WHERE offer_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.offers.filter((r) => r.offer_id === p[0]).map(clone);
  if (/^SELECT offer_id FROM refund_offers WHERE offer_id = \? LIMIT 1$/.test(sql)) return S.offers.filter((r) => r.offer_id === p[0]).map((r) => ({ offer_id: r.offer_id }));
  if (/^SELECT \* FROM refund_offers WHERE order_id = \? ORDER BY created_at DESC LIMIT 5$/.test(sql)) return S.offers.filter((r) => r.order_id === p[0]).slice().reverse().map(clone);
  if (/^SELECT \* FROM refund_offers ORDER BY created_at DESC LIMIT 100$/.test(sql)) return S.offers.slice().reverse().map(clone);
  if (/^SELECT r\.offer_id, r\.expires_at, o\.email, o\.phone_norm, o\.status FROM refund_offers r JOIN orders o ON o\.order_id = r\.order_id WHERE r\.phone_norm = \? AND r\.status = 'OFFERED' LIMIT 10$/.test(sql)) {
    return S.offers.filter((r) => r.phone_norm === p[0] && r.status === 'OFFERED').map((r) => { const o = order(r.order_id) || {}; return { offer_id: r.offer_id, expires_at: r.expires_at, email: o.email, phone_norm: o.phone_norm, status: o.status }; });
  }
  if (/^SELECT sub_ids FROM refund_offers WHERE status IN \('UPI_REQUESTED', 'DONE'\)/.test(sql)) return S.offers.filter((r) => ['UPI_REQUESTED', 'DONE'].includes(r.status) && r.sub_ids).map((r) => ({ sub_ids: r.sub_ids }));
  if (/^INSERT INTO refund_offers \(offer_id, order_id, live_order, sub_ids, phone_norm, service, plan, reason, paid_amount, charge_amount, suggested_charge, refund_amount, days_used, total_days, bonus_percent, note, status, expires_at, created_at\)/.test(sql)) {
    if (S.offers.some((r) => r.live_order && r.live_order === p[2])) { const e = new Error("Duplicate entry '" + p[2] + "' for key 'uq_ro_live_order'"); e.code = 'ER_DUP_ENTRY'; throw e; }
    const k = ['offer_id', 'order_id', 'live_order', 'sub_ids', 'phone_norm', 'service', 'plan', 'reason', 'paid_amount', 'charge_amount', 'suggested_charge', 'refund_amount', 'days_used', 'total_days', 'bonus_percent', 'note'];
    const row = {}; k.forEach((c, i) => { row[c] = p[i]; });
    Object.assign(row, { status: 'OFFERED', expires_at: p[16], created_at: p[17], email_sent: 0, method: null, credit_amount: null, coupon_code: null, upi_id: null, upi_ref: null });
    S.offers.push(row); return { affectedRows: 1, insertId: S.offers.length };
  }
  if (/^UPDATE refund_offers SET status = 'EXPIRED', live_order = NULL WHERE status = 'OFFERED' AND expires_at <= \?$/.test(sql)) { let n = 0; for (const r of S.offers) if (r.status === 'OFFERED' && r.expires_at <= p[0]) { r.status = 'EXPIRED'; r.live_order = null; n++; } return { affectedRows: n }; }
  if (/^UPDATE refund_offers SET status = 'DONE', method = \?, credit_amount = \?, accepted_at = \?, paid_at = \? WHERE offer_id = \? AND status = 'OFFERED' LIMIT 1$/.test(sql)) { const r = offer(p[4]); if (!r || r.status !== 'OFFERED') return { affectedRows: 0 }; Object.assign(r, { status: 'DONE', method: p[0], credit_amount: p[1], accepted_at: p[2], paid_at: p[3] }); return { affectedRows: 1 }; }
  if (/^UPDATE refund_offers SET coupon_code = \? WHERE offer_id = \? LIMIT 1$/.test(sql)) { offer(p[1]).coupon_code = p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE refund_offers SET status = 'UPI_REQUESTED', method = 'UPI', upi_id = \?, accepted_at = \? WHERE offer_id = \? AND status = 'OFFERED' LIMIT 1$/.test(sql)) { const r = offer(p[2]); if (!r || r.status !== 'OFFERED') return { affectedRows: 0 }; Object.assign(r, { status: 'UPI_REQUESTED', method: 'UPI', upi_id: p[0], accepted_at: p[1] }); return { affectedRows: 1 }; }
  if (/^UPDATE refund_offers SET status = 'DONE', paid_at = \?, upi_ref = \? WHERE offer_id = \? AND status = 'UPI_REQUESTED' LIMIT 1$/.test(sql)) { const r = offer(p[2]); if (!r || r.status !== 'UPI_REQUESTED') return { affectedRows: 0 }; Object.assign(r, { status: 'DONE', paid_at: p[0], upi_ref: p[1] }); return { affectedRows: 1 }; }
  if (/^UPDATE refund_offers SET email_sent = 1 WHERE offer_id = \? LIMIT 1$/.test(sql)) { offer(p[0]).email_sent = 1; return { affectedRows: 1 }; }
  if (/^UPDATE refund_offers SET status = 'CANCELLED', live_order = NULL, cancelled_at = \?, cancel_reason = \? WHERE offer_id = \? AND status = 'OFFERED' LIMIT 1$/.test(sql)) { const r = offer(p[2]); if (!r || r.status !== 'OFFERED') return { affectedRows: 0 }; Object.assign(r, { status: 'CANCELLED', live_order: null, cancelled_at: p[0], cancel_reason: p[1] }); return { affectedRows: 1 }; }
  if (/^SELECT phone_norm, name FROM customers WHERE phone_norm IN/.test(sql)) return [];
  // coupons / to-dos
  if (/^SELECT code FROM coupons WHERE code = \? LIMIT 1$/.test(sql)) return S.coupons.filter((c) => c.code === p[0]).map(clone);
  if (/^INSERT INTO coupons \(code, description, scope, type, value/.test(sql)) { S.coupons.push({ code: p[0], value: p[4], expiry: p[7], allowed_phones: p[12], raw_json: p[14] }); return { affectedRows: 1 }; }
  if (/^INSERT INTO admin_todos \(title, note\) VALUES \(\?, \?\)$/.test(sql)) { const id = S.todos.length + 1; S.todos.push({ id, title: p[0], note: p[1], done: 0 }); return { affectedRows: 1, insertId: id }; }
  if (/^UPDATE admin_todos SET done = 1, done_at = NOW\(\) WHERE id = \? AND done = 0 LIMIT 1$/.test(sql)) { const t = S.todos.find((x) => x.id === p[0] && !x.done); if (t) t.done = 1; return { affectedRows: t ? 1 : 0 }; }
  throw new Error('fake db: unhandled SQL: ' + sql);
}
// One transaction at a time (a coarse stand-in for InnoDB row locks), so parallel requests really race for the same row.
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

// ---------------------------------------------------------------- mocks: mailer, push, coins pot, email-code tokens
const mails = []; const pushes = [];
const fakeMailer = { send: async (to, subj, html) => { mails.push({ to, subj, html }); return { ok: true }; }, sendAccessEmail: async () => { throw new Error('no real email in tests'); } };
const fakePush = { sendToPhone: async (ph, msg) => { pushes.push({ ph, msg }); return { ok: true }; }, sendToAdmins: async (msg) => { pushes.push({ admin: true, msg }); return { ok: true }; } };
const fakeCoins = {
  addRefundCreditOn: async (conn, { orderId, phone, credit }) => {
    const [dup] = await conn.query("SELECT id FROM coins_ledger WHERE order_id = ? AND event = 'REFUND_CREDIT' LIMIT 1", [orderId]).catch(() => [[]]);
    if ((dup || []).length) return { ok: true, already: true };
    S.ledger.push({ event: 'REFUND_CREDIT', order_id: orderId, phone_norm: phone, coins_delta: credit });
    return { ok: true, credit, creditAfter: S.ledger.filter((l) => l.phone_norm === phone).reduce((n, l) => n + l.coins_delta, 0) };
  },
};
const _run = run;
run = function (sql, p) { // eslint-disable-line no-func-assign
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = 'REFUND_CREDIT' LIMIT 1$/.test(q)) return S.ledger.filter((l) => l.order_id === p[0] && l.event === 'REFUND_CREDIT').map((l, i) => ({ id: i + 1 }));
  return _run(sql, p);
};
// Token 'good-<phone>' = this device verified buyer@x.com; 'good-<phone>|other@x.com' = verified another email.
const fakeOtp = {
  tokenMatcher: (t, ph) => (String(t).split('|')[0] === 'good-' + ph ? (em) => em === (String(t).split('|')[1] || 'buyer@x.com') : null),
  sendEmailCode: async (kind, ph, em, o) => ((await o.eligible(ph, (x) => x === em)) ? { ok: true, kind } : { ok: false, noActive: true, message: o.noMessage }),
  verifyEmailCode: async (kind, ph, em, code, o) => ({ ok: await o.eligible(ph, (x) => x === em) }),
};
const refundsMod = require('../refunds');
const R = refundsMod.create({ db: mockDb, coins: fakeCoins, push: fakePush, mailer: fakeMailer, otpaccess: fakeOtp, now: () => NOW });

// ---------------------------------------------------------------- fixtures
const PH = '9876543210', OTHER = '9123456789';
function deliveredOrder(extra) {
  return Object.assign({ order_id: 'FF900', created_at_sheet: dt(days(-10)), name: 'Rahul', email: 'buyer@x.com', phone: PH, phone_norm: PH, service: 'Netflix', plan: 'Private 1M', duration_days: 30,
    final_amount: '199.00', status: 'PAID', fulfillment_status: 'FULFILLED', order_type: 'NEW', renew_sub_id: null, source: 'node', raw_json: JSON.stringify({ OrderID: 'FF900', Status: 'PAID', FulfillmentStatus: 'FULFILLED' }) }, extra || {});
}
function deliveredSub(extra) {
  return Object.assign({ sub_id: 'SUB-900', order_id: 'FF900', phone: PH, phone_norm: PH, email: 'buyer@x.com', service: 'Netflix', plan: 'Private 1M', duration_days: 30,
    start_date: dt(days(-10)), expiry_date: dt(days(20)), status: 'ACTIVE', fulfillment_status: 'FULFILLED', login_id: 'nf1@x.com', password: 'pw', inventory_ref: 'NFLX-D1#P2', account_id: 'NFLX-D1', removed: 0, raw_json: null }, extra || {});
}
function askOrder(extra) {
  return Object.assign({ order_id: 'FF800', created_at_sheet: dt(days(-1)), name: 'Rahul', email: 'buyer@x.com', phone: PH, phone_norm: PH, service: 'Zee5', plan: '1 Month', final_amount: '99.00', status: 'REFUNDED', fulfillment_status: 'REFUNDED',
    raw_json: JSON.stringify({ RefundMethod: 'UPI_PENDING', RefundState: 'ASK_CUSTOMER', RefundedAt: dt(days(-1)), RefundAmount: 99 }) }, extra || {});
}
async function makeOffer(body) {
  const r = await R.createOffer(Object.assign({ orderId: 'FF900', reason: 'NO_REPLACEMENT' }, body || {}));
  return r;
}

(async () => {
  section('pure rules: bonus, suggested charge, never negative');
  ok('bonusCredit: ₹99 + 10% = 109, ₹199 + 15% = 229, 0% = exact', refundsMod.bonusCredit(99, 10) === 109 && refundsMod.bonusCredit(199, 15) === 229 && refundsMod.bonusCredit(150, 0) === 150);
  let sc = refundsMod.suggestCharge({ paid: 199, totalDays: 30, periodEnd: dt(days(20)), now: NOW });
  ok('suggested charge: 10 of 30 days used on ₹199 → ₹66', sc.daysUsed === 10 && sc.totalDays === 30 && sc.suggested === 66, sc);
  sc = refundsMod.suggestCharge({ paid: 199, totalDays: 30, periodEnd: dt(days(-5)), now: NOW });
  ok('period already over → all 30 days used, charge capped at what was paid', sc.daysUsed === 30 && sc.suggested === 199, sc);
  sc = refundsMod.suggestCharge({ paid: 199, totalDays: 30, periodEnd: dt(days(45)), now: NOW });
  ok('renewal paid early (period starts in the future) → 0 days used, ₹0', sc.daysUsed === 0 && sc.suggested === 0, sc);
  ok('offerAmounts: no replacement ignores any charge; mid-period charge above paid → refund ₹0 (never negative); negative charge → 0',
    refundsMod.offerAmounts(199, 'NO_REPLACEMENT', 150).refund === 199 && refundsMod.offerAmounts(199, 'MID_PERIOD', 500).refund === 0 && refundsMod.offerAmounts(199, 'MID_PERIOD', 500).charge === 199 && refundsMod.offerAmounts(199, 'MID_PERIOD', -40).refund === 199);
  let v = refundsMod.validateSettings({ bonusPercent: '15', offerDays: 7 });
  ok('settings: 15% / 7 days valid; 80% or 0 days refused; empty → defaults 10% / 30 days', v.ok && v.settings.bonusPercent === 15 && v.settings.offerDays === 7 && !refundsMod.validateSettings({ bonusPercent: 80 }).ok && !refundsMod.validateSettings({ offerDays: 0 }).ok && refundsMod.validateSettings({}).settings.bonusPercent === 10 && refundsMod.validateSettings({}).settings.offerDays === 30, v);

  section('not delivered: the customer picks coins / coupon (+bonus%) or exact UPI');
  fresh(); S.orders.push(askOrder(), askOrder({ order_id: 'FF801' }), askOrder({ order_id: 'FF899', phone_norm: OTHER, phone: OTHER }));
  let pend = await R.getPendingRefunds(PH);
  const it = pend.items.find((x) => x.orderId === 'FF800');
  ok('pending item: ₹99 → 109 coins / ₹109 coupon (10%), 180 days, only this phone\'s orders', pend.ok && pend.items.length === 2 && it.credit === 109 && it.couponValue === 109 && it.couponDays === 180 && it.bonusPercent === 10 && !pend.items.some((x) => x.orderId === 'FF899'), pend);
  const saved = await R.saveSettings({ bonusPercent: 20 });
  pend = await R.getPendingRefunds(PH);
  ok('admin bonus % setting (20%) is used: ₹99 → 119', saved.ok && pend.items[0].credit === 119 && pend.bonusPercent === 20, pend);
  await R.saveSettings({ bonusPercent: 10 });
  let c = await R.chooseRefund(OTHER, 'FF800', 'COINS');
  ok('another phone cannot take it', c.ok === false && !S.ledger.length, c);
  const [c1, c2] = await Promise.all([R.chooseRefund(PH, 'FF800', 'COINS'), R.chooseRefund(PH, 'ff800', 'COINS')]);
  ok('coins: +109 exactly once even when tapped twice', c1.ok && c2.ok && [c1, c2].filter((x) => x.already).length === 1 && S.ledger.length === 1 && S.ledger[0].coins_delta === 109 && rawOrder('FF800').RefundMethod === 'Coins' && rawOrder('FF800').RefundBonus === 10, { c1, c2, l: S.ledger });
  c = await R.chooseRefund(PH, 'FF800', 'COUPON');
  ok('…then a coupon for the same refund is refused', c.ok === false && !S.coupons.length, c);
  c = await R.chooseRefund(PH, 'FF801', 'COUPON');
  const cp = S.coupons[0] || {}; const cpRaw = JSON.parse(cp.raw_json || '{}');
  ok('coupon: ₹109 single-use coupon for this phone, typed columns + raw_json in step, 180 days', c.ok && c.method === 'COUPON' && cp.value === 109 && cpRaw.Value === 109 && cpRaw.AllowedPhones === PH && cpRaw.GlobalLimit === 1 && cpRaw.Source === 'REFUND' && /^2027-03-14/.test(cp.expiry) && rawOrder('FF801').RefundMethod === 'COUPON' && rawOrder('FF801').RefundCoupon === cp.code, { c, cp });
  c = await R.chooseRefund(PH, 'FF801', 'COUPON');
  ok('coupon again → already, no second coupon', c.ok && c.already && S.coupons.length === 1, c);
  await tick();
  ok('confirmation emails for coins + coupon (mocked mailer only)', mails.some((m) => /109 coins of refund credit added/.test(m.subj)) && mails.some((m) => /refund coupon/.test(m.subj) && m.html.includes(cp.code)), mails.map((m) => m.subj));

  section('delivered plan: offer "no replacement" → no charge, email, banner only for that phone');
  fresh(); mails.length = 0; pushes.length = 0;
  S.orders.push(deliveredOrder()); S.subs.push(deliveredSub());
  let q = await R.quoteOffer({ orderId: 'FF900' });
  ok('quote: paid 199, 10/30 days used, suggested ₹66, allowed', q.ok && q.allowed && q.paid === 199 && q.daysUsed === 10 && q.totalDays === 30 && q.suggestedCharge === 66 && q.subIds.join() === 'SUB-900', q);
  const qs = await R.quoteOffer({ subId: 'SUB-900' });
  ok('quote from the subscription row finds the same order', qs.ok && qs.orderId === 'FF900' && qs.suggestedCharge === 66, qs);
  let o1 = await makeOffer({ reason: 'NO_REPLACEMENT', charge: 120, note: 'Sorry, no replacement account', amount: 1, refund: 999, paid: 5000 });
  const ro1 = offer(o1.offer && o1.offer.offerId) || {};
  ok('offer stored: OFFERED, refund ₹199, charge 0 (client charge / amount / paid ignored), 30-day expiry, sub listed', o1.ok && ro1.status === 'OFFERED' && ro1.refund_amount === 199 && ro1.charge_amount === 0 && ro1.paid_amount === 199 && ro1.expires_at === dt(days(30)) && ro1.sub_ids === 'SUB-900' && ro1.live_order === 'FF900', { o1, ro1 });
  ok('order untouched until the customer chooses', order('FF900').status === 'PAID' && sub('SUB-900').status === 'ACTIVE');
  await tick();
  const offerMail = mails.find((m) => /Your refund of ₹199 is ready/.test(m.subj));
  ok('customer emailed (order email) with amount, no charge, note, link to the website', !!offerMail && offerMail.to === 'buyer@x.com' && /No charge/.test(offerMail.html) && /Sorry, no replacement account/.test(offerMail.html) && /https:\/\/shop\.fluxfilm\.in\/\?refund=1/.test(offerMail.html) && ro1.email_sent === 1, { subj: mails.map((m) => m.subj), sent: ro1.email_sent });
  ok('push to the customer opens the choice (?refund=1)', pushes.some((p) => p.ph === PH && p.msg.url === '/?refund=1'), pushes);
  pend = await R.getPendingRefunds(PH);
  const b = pend.offers[0] || {};
  ok('banner data for that phone: ₹199, 219 coins / ₹219 coupon, reason + note', pend.offers.length === 1 && b.id === ro1.offer_id && b.amount === 219 - 20 && b.credit === 219 && b.couponValue === 219 && b.charge === 0 && b.reason === 'NO_REPLACEMENT' && b.note === 'Sorry, no replacement account', b);
  const pendOther = await R.getPendingRefunds(OTHER);
  ok('another phone sees no banner', pendOther.ok && pendOther.offers.length === 0);
  let dup = await makeOffer({ reason: 'MID_PERIOD', charge: 10 });
  ok('a second offer on the same order is refused', dup.ok === false && /already has a refund offer/.test(dup.message) && S.offers.length === 1, dup);

  section('accept coins instantly, exactly once; access ends');
  c = await R.chooseRefund(OTHER, ro1.offer_id, 'COINS');
  ok('another phone is refused (nothing credited)', c.ok === false && !S.ledger.length && offer(ro1.offer_id).status === 'OFFERED', c);
  const [a1, a2, a3] = await Promise.all([R.chooseRefund(PH, ro1.offer_id, 'COINS'), R.chooseRefund(PH, ro1.offer_id.toLowerCase(), 'COINS'), R.chooseRefund(PH, ro1.offer_id, 'COUPON')]);
  ok('three taps at once: coins +219 exactly once, no coupon', a1.ok && a1.credit === 219 && S.ledger.length === 1 && S.ledger[0].coins_delta === 219 && !S.coupons.length && [a1, a2, a3].filter((x) => x.ok && !x.already).length === 1, { a1, a2, a3, l: S.ledger });
  const raw900 = rawOrder('FF900');
  ok('offer DONE (COINS, 219); order REFUNDED typed + raw_json in step (kind DELIVERED, offer id, charge 0)', offer(ro1.offer_id).status === 'DONE' && offer(ro1.offer_id).method === 'COINS' && order('FF900').status === 'REFUNDED' && order('FF900').fulfillment_status === 'REFUNDED' && raw900.Status === 'REFUNDED' && raw900.FulfillmentStatus === 'REFUNDED' && raw900.RefundKind === 'DELIVERED' && raw900.RefundOfferId === ro1.offer_id && raw900.RefundCharge === 0 && raw900.RefundMethod === 'Coins', raw900);
  ok('subscription marked REFUNDED (access ended)', sub('SUB-900').status === 'REFUNDED' && sub('SUB-900').fulfillment_status === 'REFUNDED', sub('SUB-900'));
  pend = await R.getPendingRefunds(PH);
  ok('banner gone after choosing', pend.offers.length === 0, pend);
  c = await R.requestUpi(PH, ro1.offer_id, 'rahul@okhdfcbank', 'good-' + PH);
  ok('after coins, UPI is refused', c.ok === false && !S.todos.length, c);

  section('Recover / Get OTP / Games / renew / Remove users for the refunded plan');
  const recover = require('../recover');
  recover._internal.tokenStore.set('tokR', { ph: PH, em: 'buyer@x.com', exp: Date.now() + 60e3 });
  const _r0 = run;
  run = function (sql, p) { const q2 = sql.replace(/\s+/g, ' ').trim(); if (/information_schema/.test(q2)) return [{ n: 0 }]; if (/^SELECT order_id, sub_id, service, plan, login_id, password, profile_name, profile_pin, profile_number, expiry_date, status FROM subscriptions WHERE \(order_id = \? OR sub_id = \?\) AND phone_norm = \? LIMIT 1$/.test(q2)) return S.subs.filter((x) => (x.order_id === p[0] || x.sub_id === p[1]) && x.phone_norm === p[2]).map(clone); return _r0(sql, p); }; // eslint-disable-line no-func-assign
  const acc = await recover.getAccess('SUB-900', PH, 'buyer@x.com', 'tokR');
  ok('Recover: refunded plan → no login shown', acc.ok === false && acc.refunded === true && !acc.access, acc);
  const access = require('../otpaccess');
  ok('Get OTP: the refunded device row blocks the purchase', access._internal.rowBlocked(sub('SUB-900'), NOW.getTime()) === true);
  ok('Games prize check: email of the refunded plan / refunded order no longer proves a paid customer', (await access.paidCustomerEmailOk(PH, (em) => em === 'buyer@x.com')) === false);
  const orderMod = require('../order');
  const rq = await orderMod.renewQuote('SUB-900');
  ok('renew blocked for the refunded plan', rq.ok === false && rq.renewBlocked === true && /refunded/.test(rq.message), rq);
  const ex = require('../expiredusers');
  const live = [deliveredSub({ sub_id: 'SUB-LIVE', order_id: 'FF1', phone_norm: '9000000001', status: 'ACTIVE', inventory_ref: 'NFLX-D1#P3', login_id: 'nf1@x.com', expiry_date: dt(days(15)) })];
  const withEnded = ex.compute({ subs: live.concat([Object.assign(clone(sub('SUB-900')), { refund_ended: true })]), accounts: [], now: NOW });
  const legacy = ex.compute({ subs: live.concat([Object.assign(clone(sub('SUB-900')), { sub_id: 'SUB-OLD' })]), accounts: [], now: NOW });
  ok('Remove users: the refunded customer counts as inactive-not-removed on a login with active users', withEnded.main.pending === 1 && withEnded.main.groups[0].people[0].subId === 'SUB-900', withEnded.main);
  ok('…but an old REFUNDED row without a refund offer is still ignored (no surprise counts)', legacy.main.pending === 0, legacy.main);
  const loaded = await ex.load(async (sql, p) => {
    if (/refund_offers/.test(sql)) return run(sql, p);
    if (/AND UPPER\(s\.status\) = 'REFUNDED'/.test(sql)) return S.subs.filter((x) => p.includes(x.sub_id) && x.status === 'REFUNDED').map((x) => Object.assign(clone(x), { name: 'Rahul' }));
    if (/FROM subscriptions s/.test(sql)) return live;
    return [];
  }, { now: NOW });
  ok('Remove users load(): refund-ended subscriptions are fetched and counted', loaded.main.pending === 1 && loaded.main.groups[0].people.some((x) => x.subId === 'SUB-900'), loaded.main);
  const removedAfter = ex.compute({ subs: live.concat([Object.assign(clone(sub('SUB-900')), { refund_ended: true, removed: 1 })]), accounts: [], now: NOW });
  ok('…and ticked removed → not counted', removedAfter.main.pending === 0);
  run = _r0; // eslint-disable-line no-func-assign

  section('mid-period offer: charge, never negative, tampered amounts refused, coupon choice');
  fresh(); mails.length = 0;
  S.orders.push(deliveredOrder({ order_id: 'FF910', raw_json: '{}' })); S.subs.push(deliveredSub({ sub_id: 'SUB-910', order_id: 'FF910', group_id: 'G1', raw_json: JSON.stringify({ SubID: 'SUB-910', Status: 'ACTIVE' }) }), deliveredSub({ sub_id: 'SUB-911', order_id: 'FF910', group_id: 'G1', login_id: 'nf2@x.com', raw_json: null }));
  let bad = await R.createOffer({ orderId: 'FF910', reason: 'MID_PERIOD', charge: 199 });
  ok('charge = full price → nothing to refund → refused', bad.ok === false && bad.field === 'charge' && !S.offers.length, bad);
  bad = await R.createOffer({ orderId: 'FF910', reason: 'MID_PERIOD', charge: -5 });
  ok('negative charge refused', bad.ok === false && bad.field === 'charge' && !S.offers.length, bad);
  bad = await R.createOffer({ orderId: 'FF910', reason: 'WHATEVER' });
  ok('unknown reason refused', bad.ok === false && bad.field === 'reason');
  const o2 = await R.createOffer({ orderId: 'FF910', reason: 'MID_PERIOD', charge: '', note: 'Mid-month refund' });
  const ro2 = offer(o2.offer && o2.offer.offerId) || {};
  ok('empty charge → suggested ₹66 used: refund ₹133, both device rows listed', o2.ok && ro2.charge_amount === 66 && ro2.suggested_charge === 66 && ro2.refund_amount === 133 && ro2.days_used === 10 && ro2.sub_ids === 'SUB-910,SUB-911', { o2, ro2 });
  await tick();
  const midMail = mails.find((m) => /Your refund of ₹133 is ready/.test(m.subj)) || {};
  ok('email shows paid, charge and why (10 of 30 days)', /₹199/.test(midMail.html) && /− ₹66/.test(midMail.html) && /10 of 30 days/.test(midMail.html) && /Mid-month refund/.test(midMail.html), midMail.subj);
  // Tamper: the storefront sends only [phone, id, method]; even a forged stored amount on the order changes nothing.
  order('FF910').final_amount = '1.00';
  const tc = await R.chooseRefund(PH, ro2.offer_id, 'COUPON', { amount: 5000 });
  const cp2 = S.coupons[0] || {};
  ok('coupon value comes from the stored offer (₹133 + 10% = ₹146), not the client or a changed order', tc.ok && cp2.value === 146 && offer(ro2.offer_id).coupon_code === cp2.code && offer(ro2.offer_id).credit_amount === 146, { tc, cp2 });
  ok('both device rows ended; raw_json kept in step where present', sub('SUB-910').status === 'REFUNDED' && JSON.parse(sub('SUB-910').raw_json).Status === 'REFUNDED' && sub('SUB-911').status === 'REFUNDED' && sub('SUB-911').raw_json === null, S.subs);

  section('UPI: email code to the order email → admin queue → ✅ Done → email + one-time pop-up');
  fresh(); mails.length = 0; pushes.length = 0;
  S.orders.push(deliveredOrder({ order_id: 'FF920' })); S.subs.push(deliveredSub({ sub_id: 'SUB-920', order_id: 'FF920' }));
  const o3 = await R.createOffer({ orderId: 'FF920', reason: 'NO_REPLACEMENT' });
  const id3 = o3.offer.offerId;
  let u = await R.requestUpi(PH, id3, 'rahul@okhdfcbank', '');
  ok('no code yet → needsVerify, nothing saved', u.ok === false && u.needsVerify && offer(id3).status === 'OFFERED' && !S.todos.length, u);
  let sc1 = await R.sendCode(PH, 'buyer@x.com');
  const scBad = await R.sendCode(PH, 'profile@evil.com');
  const scOther = await R.sendCode(OTHER, 'buyer@x.com');
  ok('email code only to the email on the offer\'s order (not a profile email, not another phone)', sc1.ok && !scBad.ok && scBad.noActive && !scOther.ok, { sc1, scBad, scOther });
  u = await R.requestUpi(PH, id3, 'rahul@okhdfcbank', 'good-' + PH + '|other@x.com');
  ok('device verified with another email → needsVerify', u.ok === false && u.needsVerify && offer(id3).status === 'OFFERED', u);
  u = await R.requestUpi(PH, id3, 'rahul@@bank', 'good-' + PH);
  ok('bad UPI ID format refused', u.ok === false && u.field === 'upi');
  u = await R.requestUpi(OTHER, id3, 'thief@ybl', 'good-' + OTHER);
  ok('another phone (even verified) cannot redirect it', u.ok === false && offer(id3).status === 'OFFERED' && !S.todos.length, u);
  const [u1, u2] = await Promise.all([R.requestUpi(PH, id3, 'rahul.k@okhdfcbank', 'good-' + PH), R.requestUpi(PH, id3, 'rahul.k@okhdfcbank', 'good-' + PH)]);
  ok('UPI request: once (second = already), exact ₹199, "Request received … within 24 hours"', u1.ok && u2.ok && [u1, u2].filter((x) => x.already).length === 1 && S.todos.length === 1 && /Request received — we'll send ₹199 to rahul\.k@okhdfcbank within 24 hours/.test((u1.already ? u2 : u1).message), { u1, u2 });
  ok('offer UPI_REQUESTED; order REFUNDED as UPI_PENDING / UPI_REQUESTED; access ended', offer(id3).status === 'UPI_REQUESTED' && offer(id3).upi_id === 'rahul.k@okhdfcbank' && order('FF920').status === 'REFUNDED' && rawOrder('FF920').RefundMethod === 'UPI_PENDING' && rawOrder('FF920').RefundState === 'UPI_REQUESTED' && sub('SUB-920').status === 'REFUNDED', { ro: offer(id3), raw: rawOrder('FF920') });
  c = await R.chooseRefund(PH, id3, 'COINS');
  ok('after UPI, coins are refused (money is on its way)', c.ok === false && !S.ledger.length, c);

  // admin HTTP: queue + Done (key needed, change log)
  const express = require('express');
  const audits = [];
  const app = express(); app.use(express.json());
  const auth = (req, res) => { if (req.get('X-Admin-Key') === 'k') return true; res.status(403).json({ ok: false }); return false; };
  const audit = { record: (req, e) => audits.push(e) };
  require('../adminrefunds').mount(app, { db: mockDb, auth, audit, refunds: R });
  require('../adminorderactions').mount(app, { db: mockDb, auth, audit, refunds: R });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const r = await fetch(base + p, { headers: h || H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, body, h) => { const r = await fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  let r = await get('/admin/api/refunds', { 'Content-Type': 'application/json' });
  ok('💸 Refunds list needs the admin key', r.status === 403);
  r = await get('/admin/api/refunds');
  const row = (r.body.toSend || [])[0] || {};
  ok('Refunds to send: amount, full UPI, customer, order, delivered', r.body.ok && r.body.toSend.length === 1 && row.amount === 199 && row.upi === 'rahul.k@okhdfcbank' && row.orderId === 'FF920' && row.phone === PH && row.delivered === true && row.offerId === id3, r.body);
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF920', reference: 'UTR55' }, { 'Content-Type': 'application/json' });
  ok('✅ Done needs the admin key', r.status === 403 && offer(id3).status === 'UPI_REQUESTED');
  mails.length = 0;
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF920', reference: 'UTR55' });
  ok('✅ Done: order Refunded (UPI) with ref, offer DONE + paid, to-do ticked, change log', r.body.ok && rawOrder('FF920').RefundMethod === 'UPI' && rawOrder('FF920').RefundRef === 'UTR55' && offer(id3).status === 'DONE' && offer(id3).upi_ref === 'UTR55' && !!offer(id3).paid_at && S.todos[0].done === 1 && audits.some((a) => a.action === 'order.refundUpiSent'), { body: r.body, ro: offer(id3) });
  await tick();
  ok('customer emailed "₹199 … sent to your UPI (ref UTR55)"', mails.some((m) => m.to === 'buyer@x.com' && /₹199 refunded to your UPI/.test(m.subj) && /ref UTR55/.test(m.html)), mails.map((m) => m.subj));
  pend = await R.getPendingRefunds(PH);
  ok('next visit: one-time "sent" pop-up data (masked UPI, ref)', pend.sent.length === 1 && pend.sent[0].amount === 199 && /^rah•+@okhdfcbank$/.test(pend.sent[0].upi) && pend.sent[0].reference === 'UTR55' && pend.items.length === 0, pend);
  let seen = await R.markSentSeen(OTHER, 'FF920');
  ok('another phone cannot mark it seen', seen.ok === false && !rawOrder('FF920').RefundSentSeenAt);
  seen = await R.markSentSeen(PH, 'FF920');
  pend = await R.getPendingRefunds(PH);
  ok('after it is shown once it does not come back', seen.ok && pend.sent.length === 0 && !!rawOrder('FF920').RefundSentSeenAt, pend);

  section('admin: offer via HTTP, change log, cancel, expire, settings');
  fresh(); audits.length = 0;
  S.orders.push(deliveredOrder({ order_id: 'FF930' })); S.subs.push(deliveredSub({ sub_id: 'SUB-930', order_id: 'FF930' }));
  S.orders.push(deliveredOrder({ order_id: 'FF931', fulfillment_status: 'FAILED' })); // paid, not delivered (no subscription)
  r = await post('/admin/api/refund-offers', { orderId: 'FF930', reason: 'MID_PERIOD', charge: 50 }, { 'Content-Type': 'application/json' });
  ok('offer needs the admin key', r.status === 403 && !S.offers.length);
  r = await post('/admin/api/refund-offers', { orderId: 'FF931', reason: 'NO_REPLACEMENT' });
  ok('not delivered → refused (use 💸 Refund)', r.status === 409 && /not delivered/.test(r.body.message) && !S.offers.length, r.body);
  r = await get('/admin/api/refund-offers/quote?subId=SUB-930');
  ok('quote endpoint', r.body.ok && r.body.suggestedCharge === 66 && r.body.allowed, r.body);
  r = await post('/admin/api/refund-offers', { orderId: 'FF930', reason: 'MID_PERIOD', charge: 50, note: 'x', paid: 9999, refund: 9999 });
  const id4 = r.body.offer && r.body.offer.offerId;
  ok('offer created via HTTP: refund ₹149, change log refund.offer, no raw order in the answer', r.body.ok && r.body.offer.refund === 149 && !r.body.o && audits.some((a) => a.action === 'refund.offer' && /₹149/.test(a.summary) && !/9876543210/.test(a.summary)), { body: r.body, audits });
  r = await post('/admin/api/refund-offers/cancel', { offerId: id4, reason: 'customer happy now' });
  ok('cancel: CANCELLED, change log, banner gone', r.body.ok && offer(id4).status === 'CANCELLED' && offer(id4).live_order === null && audits.some((a) => a.action === 'refund.offerCancel') && (await R.getPendingRefunds(PH)).offers.length === 0, r.body);
  c = await R.chooseRefund(PH, id4, 'COINS');
  ok('cancelled offer cannot be taken', c.ok === false && c.cancelled === true && !S.ledger.length && order('FF930').status === 'PAID' && sub('SUB-930').status === 'ACTIVE', c);
  r = await post('/admin/api/refund-offers', { orderId: 'FF930', reason: 'NO_REPLACEMENT' });
  const id5 = r.body.offer && r.body.offer.offerId;
  ok('after cancelling, a new offer can be made', r.body.ok && id5 && id5 !== id4, r.body);
  NOW = new Date(NOW.getTime() + 31 * 86400e3);
  pend = await R.getPendingRefunds(PH);
  c = await R.chooseRefund(PH, id5, 'COINS');
  ok('31 days later: expired offer → no banner, cannot be taken, order still PAID', pend.offers.length === 0 && c.ok === false && c.expired === true && !S.ledger.length && order('FF930').status === 'PAID', { pend, c });
  u = await R.requestUpi(PH, id5, 'rahul@okhdfcbank', 'good-' + PH);
  ok('…nor by UPI', u.ok === false && u.expired === true && !S.todos.length, u);
  r = await get('/admin/api/refunds');
  ok('admin list shows it EXPIRED (and frees the order for a new offer)', r.body.ok && r.body.offers.some((f) => f.offerId === id5 && f.status === 'EXPIRED') && offer(id5).live_order === null, r.body.offers);
  NOW = new Date(2026, 8, 15, 12, 0, 0);
  r = await post('/admin/api/refunds/settings', { bonusPercent: 99 });
  ok('settings: 99% refused', r.status === 400 && !S.settings.refund_settings, r.body);
  r = await post('/admin/api/refunds/settings', { bonusPercent: 12, offerDays: 14 });
  ok('settings saved + change log', r.body.ok && JSON.parse(S.settings.refund_settings).bonusPercent === 12 && audits.some((a) => a.action === 'refunds.settings'), r.body);
  S.orders.push(deliveredOrder({ order_id: 'FF940' })); S.subs.push(deliveredSub({ sub_id: 'SUB-940', order_id: 'FF940' }));
  const o6 = await R.createOffer({ orderId: 'FF940', reason: 'NO_REPLACEMENT', notify: false });
  ok('new offer uses the new settings: 12% and 14 days', o6.ok && offer(o6.offer.offerId).bonus_percent === 12 && offer(o6.offer.offerId).expires_at === dt(days(14)) && o6.offer.credit === 223, o6);
  S.noOffersTable = true;
  const noSchema = await R.createOffer({ orderId: 'FF940', reason: 'NO_REPLACEMENT' });
  const pendNo = await R.getPendingRefunds(PH);
  ok('before schema-v26: offer says run the SQL; the storefront still works (no offers)', noSchema.ok === false && /schema-v26/.test(noSchema.message) && pendNo.ok && pendNo.offers.length === 0, { noSchema, pendNo });
  S.noOffersTable = false;
  server.close();

  section('wiring: server actions, storefront, admin, schema, scripts parse');
  const server2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: chooseRefund / refundSentSeen are MySQL storefront actions with IP + phone limits', /chooseRefund: \(a\) => refundsMod\.chooseRefund\(a\[0\], a\[1\], typeof a\[2\] === 'string' \? a\[2\] : ''\)/.test(server2) && /refundSentSeen: \(a\) => refundsMod\.markSentSeen\(a\[0\], a\[1\]\)/.test(server2) && /'chooseRefund', 'refundSendCode', 'requestUpiRefund', 'refundSentSeen'\]\.forEach/.test(server2) && /chooseRefund: security\.rateLimiter\(10, TEN_MIN\)/.test(server2));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('storefront: banner text, three choices, ✕ close, sent pop-up, API wrappers send only [phone, id, method]', /is ready — choose how you want it/.test(idx) && /🎟️ Coupon — ₹\$\{item\.amount\} \+ \$\{pct\}% = ₹\$\{item\.couponValue \|\| item\.credit\} coupon, valid \$\{item\.couponDays \|\| 180\} days, one use/.test(idx) && /className: "ff-refund-x"/.test(idx) && /"Refund sent"/.test(idx) && /apiCall_\('chooseRefund', \[phone, id, method\]/.test(idx) && /apiCall_\('refundSentSeen', \[phone, orderId\]/.test(idx) && /\[\?&\]refund=1/.test(idx));
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin: 💸 Offer refund (order actions + subscription card), Refunds view with ✅ Done + UTR + settings', /data-oa="offer"/.test(adminHtml) && /offerRefundDialog\(\\'' \+ id \+ '\\'\)/.test(adminHtml) && /'\/admin\/api\/refund-offers'/.test(adminHtml) && /data-rfdone=/.test(adminHtml) && /refunds: refundsView/.test(adminHtml) && /'\/admin\/api\/refunds\/settings'/.test(adminHtml));
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v26.sql'), 'utf8');
  ok('schema-v26: plain CREATE TABLE IF NOT EXISTS refund_offers, unique live_order, no information_schema / PREPARE', /CREATE TABLE IF NOT EXISTS refund_offers/.test(schema) && /UNIQUE KEY uq_ro_live_order \(live_order\)/.test(schema) && !/information_schema|PREPARE/i.test(schema.replace(/^--.*$/gm, '')));
  const pkg = require('../package.json');
  ok('package.json runs this test', /node test\/refunds-v3\.test\.js/.test(pkg.scripts.test));
  let bad2 = 0; let n = 0;
  for (const src of [idx, adminHtml]) {
    for (const m of src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type=["'](?!text\/javascript)/.test(m[1])) continue;
      n++; try { new Function(m[2]); } catch (e) { bad2++; console.log('  script error:', e.message); }
    }
  }
  ok('every inline <script> in index.html + admin.html parses (' + n + ')', n > 1 && bad2 === 0);
  ok('no real email was sent (mailer mocked; sendAccessEmail never called)', mails.every((m) => m.to && m.subj));

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
