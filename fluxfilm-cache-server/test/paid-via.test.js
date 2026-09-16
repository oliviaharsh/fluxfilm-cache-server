/* 💸 "How was this paid" (paidvia.js) + the payer's UPI name on Customer 360. Owner request 16 Sep 2026.
 * Run: npm test — no database: an in-memory fake that REFUSES JOINs, like MariaDB with mixed collations.
 * Every name, phone, UTR and IFSC below is made up.
 */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const rawOf = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } };

// ------------------------------------------------------------------ fake database
const p2 = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const minAgo = (m) => fmt(new Date(Date.now() - m * 60e3));
const today = (hhmm) => fmt(new Date()).slice(0, 10) + ' ' + hhmm + ':00';
// The live lesson this whole module is written around: never compare columns of an old table with a new one.
const noJoin = (sql) => { if (/\bJOIN\b/i.test(sql)) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT)'); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; } };

let T;
const reset = () => { T = { orders: [], credits: [], claims: [], names: [], customers: [], subs: [], wallet: [], spends: [], settings: {}, sql: [], unhandled: [] }; };
reset();
const orderOf = (id) => T.orders.find((o) => o.order_id === id);
const openSt = (st) => st === 'WAITING' || st === 'REVIEW';
const inSet = (sql) => (sql.match(/IN \((\?(?:,\?)*)\)/) || [])[0];

async function q(sqlRaw, pr) {
  const sql = String(sqlRaw).replace(/\s+/g, ' ').trim(); const p = pr || [];
  T.sql.push(sql); noJoin(sql);
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  // ---- orders
  if (/^SELECT order_id, final_amount, status, source FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, created_at_sheet, name, email, phone, phone_norm, service, plan, duration_days,.*, raw_json FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT status, coupon_code, phone, phone_norm, email, discount, raw_json FROM orders WHERE order_id = \? FOR UPDATE$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET status = \?, txn_ref = \?, verified_at = NOW\(\)(, raw_json = \?)? WHERE order_id = \?$/.test(sql)) {
    const o = orderOf(p[p.length - 1]); if (!o) return { affectedRows: 0 };
    Object.assign(o, { status: p[0], txn_ref: p[1], verified_at: fmt(new Date()) }, p.length === 4 ? { raw_json: p[2] } : {});
    return { affectedRows: 1 };
  }
  if (/^SELECT order_id, status, source, service, plan, phone, phone_norm, email, order_type, price, discount, final_amount, coupon_code, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET status = 'PAID', txn_ref = \?, verified_at = NOW\(\), raw_json = \? WHERE order_id = \? AND UPPER\(status\) = 'CREATED' LIMIT 1$/.test(sql)) {
    const o = orderOf(p[2]); if (!o || o.status !== 'CREATED') return { affectedRows: 0 };
    Object.assign(o, { status: 'PAID', txn_ref: p[0], raw_json: p[1], verified_at: fmt(new Date()) }); return { affectedRows: 1 };
  }
  if (/^SELECT order_id, phone_norm, final_amount, status, source, order_type, created_at_sheet, raw_json FROM orders WHERE order_id = \?/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, phone_norm FROM orders WHERE UPPER\(status\) = 'CREATED'/.test(sql)) return [];
  if (/FROM orders WHERE UPPER\(status\) IN \('PAID', 'FULFILLED'\) AND COALESCE\(verified_at, created_at_sheet\) >= CURDATE\(\)/.test(sql)) {
    const from = fmt(new Date()).slice(0, 10) + ' 00:00:00';
    return T.orders.filter((o) => ['PAID', 'FULFILLED'].includes(String(o.status).toUpperCase()) && (o.verified_at || o.created_at_sheet || '') >= from).map(clone);
  }
  if (/^SELECT order_id, created_at_sheet, name, phone_norm, service, plan, final_amount, status, fulfillment_status, order_type, source, txn_ref, verified_at, raw_json FROM orders/.test(sql)) {
    return T.orders.slice().sort((a, b) => String(b.created_at_sheet).localeCompare(String(a.created_at_sheet))).map(clone);
  }
  if (/^SELECT order_id, created_at_sheet, service, plan, final_amount, status, fulfillment_status, source, txn_ref, verified_at, raw_json FROM orders WHERE phone_norm = \?/.test(sql)) {
    return T.orders.filter((o) => o.phone_norm === p[0]).sort((a, b) => String(b.created_at_sheet).localeCompare(String(a.created_at_sheet))).map(clone);
  }
  if (/^SELECT order_id, name, phone_norm, service, plan, final_amount, status, created_at_sheet FROM orders WHERE order_id LIKE \?/.test(sql)) return [];
  // ---- bank_credits
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE consumed_order_id IN \(/.test(sql)) return T.credits.filter((c) => p.includes(c.consumed_order_id)).map(clone);
  if (/^SELECT id, upi_ref, amount, raw, received_at, consumed_order_id FROM bank_credits WHERE consumed_order_id IN \(/.test(sql)) return T.credits.filter((c) => p.includes(c.consumed_order_id)).map(clone);
  if (/^SELECT id, upi_ref, amount, received_at, order_ids, raw FROM bank_credits WHERE consumed_order_id = \?/.test(sql)) return T.credits.filter((c) => c.consumed_order_id === p[0]).map(clone);
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE consumed_order_id IS NULL AND ROUND\(amount\) = ROUND\(\?\) AND FIND_IN_SET\(\?, order_ids\) > 0/.test(sql)) {
    const c = T.credits.find((x) => !x.consumed_order_id && Math.round(x.amount) === Math.round(p[1]) && String(x.order_ids || '').split(',').includes(p[2]));
    if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 };
  }
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE consumed_order_id IS NULL AND upi_ref = \?/.test(sql)) {
    const c = T.credits.find((x) => !x.consumed_order_id && x.upi_ref === p[1] && Math.round(x.amount) === Math.round(p[2]) && (!x.order_ids || String(x.order_ids).split(',').includes(p[3])));
    if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 };
  }
  if (/^SELECT \* FROM bank_credits WHERE consumed_order_id = \? ORDER BY id DESC LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.consumed_order_id === p[0]).slice(-1).map(clone);
  if (/^SELECT \* FROM bank_credits WHERE upi_ref = \? LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.upi_ref === p[0]).map(clone);
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE upi_ref = \?/.test(sql)) return T.credits.filter((c) => c.upi_ref === p[0]).map(clone);
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE id = \? LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.id === p[0]).map(clone);
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at FROM bank_credits WHERE consumed_order_id IS NULL AND ROUND\(amount\) = ROUND\(\?\) AND received_at BETWEEN \? AND \?/.test(sql)) {
    return T.credits.filter((c) => !c.consumed_order_id && Math.round(c.amount) === Math.round(p[0]) && c.received_at >= p[1] && c.received_at <= p[2]).map(clone);
  }
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE id = \? AND consumed_order_id IS NULL$/.test(sql)) { const c = T.credits.find((x) => x.id === p[1] && !x.consumed_order_id); if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE bank_credits SET consumed_order_id = NULL WHERE id = \?/.test(sql)) { const c = T.credits.find((x) => x.id === p[0]); if (c) c.consumed_order_id = null; return { affectedRows: c ? 1 : 0 }; }
  // ---- payment_claims
  if (/^SELECT order_id, payer_name, utr, status, source, credit_id, created_at, updated_at, decided_at FROM payment_claims WHERE status IN \('MATCHED', 'APPROVED'\) AND order_id IN \(/.test(sql)) {
    return T.claims.filter((c) => ['MATCHED', 'APPROVED'].includes(c.status) && p.includes(c.order_id)).map(clone);
  }
  if (/^SELECT order_id, payer_name, utr, status, source, created_at, updated_at, decided_at FROM payment_claims WHERE order_id = \? AND status IN \('MATCHED', 'APPROVED'\)/.test(sql)) {
    return T.claims.filter((c) => c.order_id === p[0] && ['MATCHED', 'APPROVED'].includes(c.status)).map(clone);
  }
  if (/^SELECT order_id, payer_name FROM payment_claims WHERE status IN/.test(sql)) return [];
  if (/^SELECT id, order_id, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE order_id = \? ORDER BY id DESC$/.test(sql)) return T.claims.filter((c) => c.order_id === p[0]).slice().reverse().map(clone);
  if (/^SELECT id, order_id, phone_norm, amount, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE id = \? LIMIT 1$/.test(sql)) return T.claims.filter((c) => c.id === p[0]).map(clone);
  if (/^UPDATE payment_claims SET status = 'REPLACED'/.test(sql)) { T.claims.forEach((c) => { if (c.order_id === p[0] && openSt(c.status)) c.status = 'REPLACED'; }); return { affectedRows: 1 }; }
  if (/^INSERT INTO payment_claims .*'WAITING', '', 'CUSTOMER'/.test(sql)) { const id = T.claims.length + 1; T.claims.push({ id, order_id: p[0], phone_norm: p[1], amount: p[2], payer_name: p[3], utr: p[4], status: 'WAITING', reason: '', credit_id: null, source: 'CUSTOMER', created_at: p[5] }); return { insertId: id, affectedRows: 1 }; }
  if (/^UPDATE payment_claims SET status = \?, reason = \?, credit_id = \?, candidates = \?/.test(sql)) { const c = T.claims.find((x) => x.id === p[4] && openSt(x.status)); if (c) Object.assign(c, { status: p[0], reason: p[1], credit_id: p[2] }); return { affectedRows: c ? 1 : 0 }; }
  if (/^UPDATE payment_claims SET status = 'APPROVED'/.test(sql)) { const c = T.claims.find((x) => x.id === p[2] && openSt(x.status)); if (c) Object.assign(c, { status: 'APPROVED', credit_id: p[0], decided_at: fmt(new Date()) }); return { affectedRows: c ? 1 : 0 }; }
  // ---- customer_payer_names (schema-v17)
  if (/^SELECT name_norm FROM customer_payer_names WHERE phone_norm = \?$/.test(sql)) return T.names.filter((n) => n.phone_norm === p[0]).map(clone);
  if (/^SELECT name_display, name_norm, last_used, times_used FROM customer_payer_names WHERE phone_norm = \?/.test(sql)) return T.names.filter((n) => n.phone_norm === p[0]).sort((a, b) => String(b.last_used).localeCompare(String(a.last_used))).map(clone);
  if (/^SELECT phone_norm, name_display, name_norm, last_used FROM customer_payer_names WHERE name_display LIKE \? OR name_norm LIKE \?/.test(sql)) {
    const like = String(p[0]).replace(/%/g, '').toUpperCase();
    return T.names.filter((n) => (n.name_display + ' ' + n.name_norm).toUpperCase().includes(like)).map(clone);
  }
  if (/^INSERT INTO customer_payer_names/.test(sql)) { const e = T.names.find((n) => n.phone_norm === p[0] && n.name_norm === p[1]); if (e) { e.times_used = (e.times_used || 1) + 1; e.last_used = fmt(new Date()); } else T.names.push({ phone_norm: p[0], name_norm: p[1], name_display: p[2], last_used: fmt(new Date()), times_used: 1 }); return { affectedRows: 1 }; }
  // ---- customers
  if (/^SELECT raw_json FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map((c) => ({ raw_json: c.raw_json }));
  if (/^UPDATE customers SET raw_json = \? WHERE phone_norm = \? LIMIT 1$/.test(sql)) { const c = T.customers.find((x) => x.phone_norm === p[1]); if (c) c.raw_json = p[0]; return { affectedRows: c ? 1 : 0 }; }
  if (/^SELECT phone, name, email, member_since, raw_json FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^SELECT customer_id, name, email, phone_norm FROM customers WHERE phone_norm IN \(/.test(sql)) return T.customers.filter((c) => p.includes(c.phone_norm)).map((c) => ({ customer_id: c.customer_id, name: c.name, email: c.email, phone_norm: c.phone_norm }));
  if (/^SELECT customer_id, name, email, phone_norm FROM customers WHERE name LIKE \?/.test(sql)) {
    const like = String(p[0]).replace(/%/g, '').toLowerCase();
    return T.customers.filter((c) => String(c.name || '').toLowerCase().includes(like)).map((c) => ({ customer_id: c.customer_id, name: c.name, email: c.email, phone_norm: c.phone_norm }));
  }
  if (/FROM customers WHERE JSON_VALID\(raw_json\)/.test(sql)) {
    const like = String(p[0]).replace(/%/g, '').toUpperCase();
    return T.customers.filter((c) => String(rawOf(c.raw_json).LastPayerName || '').toUpperCase().includes(like)).map((c) => ({ phone_norm: c.phone_norm, raw_json: c.raw_json }));
  }
  if (/FROM customers WHERE phone_norm = \?/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  // ---- everything else the admin panel asks for on these screens
  if (/^SELECT \* FROM subscriptions WHERE phone_norm = \?/.test(sql)) return T.subs.filter((x) => x.phone_norm === p[0]).map(clone);
  if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return [];
  if (/FROM coupon_usage WHERE order_id = \?/.test(sql)) return [];
  if (/FROM subscriptions WHERE sub_id LIKE \?/.test(sql)) return [];
  if (/FROM wallet WHERE phone_norm = \?/.test(sql)) return T.wallet.filter((w) => w.phone_norm === p[0]).map(clone);
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
  if (/FROM coin_spends WHERE order_id = \? LIMIT 1 FOR UPDATE/.test(sql)) return T.spends.filter((x) => x.order_id === p[0]).map(clone);
  if (/^UPDATE coin_spends SET status = 'SPENT'/.test(sql)) { const x = T.spends.find((y) => y.order_id === p[1] && y.status === 'HELD'); if (x) x.status = 'SPENT'; return { affectedRows: x ? 1 : 0 }; }
  if (/^INSERT INTO coupon_usage/.test(sql)) return { affectedRows: 1 };
  if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
  if (inSet(sql) && /FROM (refund_offers|refund_requests|feed_)/.test(sql)) return [];
  T.unhandled.push(sql);
  return [];
}
const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, query: async (sql, p) => [await q(sql, p)] };
const mockDb = { ENABLED: true, query: q, getPool: () => ({ getConnection: async () => conn }), ping: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './coins') return { onOrderPaid: async () => ({}), holdSpend: async () => ({ ok: false }), releaseSpend: async () => ({}), creditBalance: async () => 0, lockWalletOn: async () => ({}), creditOnOrderOn: async () => ({ held: 0 }) };
  if (req === './referrals') return { onOrderPaid: async () => ({}), checkReferral: async () => ({ ok: false }) };
  if (req === './ownernotify') return { orderPaidLater: () => {}, creditPaidLater: () => {} };
  if (req === './n8nhooks') return { kick: () => {} };
  return origLoad.apply(this, arguments);
};

const paidvia = require('../paidvia');
const order = require('../order');
const paymatch = require('../paymatch');
const credit = require('../credit');
const adminhome = require('../adminhome');
const ex = require('../adminexports');
const V = paidvia.VIA;

// ------------------------------------------------------------------ helpers
const PHONE = '9876500001';
const OTHER = '9876500002';
const alert = (amount, ref, name, note, ifsc) =>
  'Dear Customer, An amount of INR ' + amount.toFixed(2) + ' has been credited to A/c XXXXXXXX9982 Ref on account of UPI REF NO ' + ref +
  ' P2P-' + name + '-' + (note || 'UPI') + '-' + (ifsc || 'HDFC0002710') + '- HEAD OFFICE value 16-09-26 . Clear Bal is INR 100.00';
const addOrder = (id, amount, extra) => { T.orders.push(Object.assign({ order_id: id, name: 'Buyer', phone: PHONE, phone_norm: PHONE, email: 'buyer@example.test', service: 'Netflix', plan: 'Sharing 1M', final_amount: amount, price: amount, discount: 0, coupon_code: '', status: 'CREATED', fulfillment_status: '', source: 'node', order_type: 'NEW', txn_ref: '', verified_at: null, created_at_sheet: minAgo(5), raw_json: '{}' }, extra || {})); return orderOf(id); };
const addCredit = (id, ref, amount, name, note) => { T.credits.push({ id, upi_ref: ref, amount, order_ids: /^FF/.test(String(note || '')) ? note : '', raw: alert(amount, ref, name, note), received_at: minAgo(2), consumed_order_id: null }); return T.credits[T.credits.length - 1]; };
const viaOf = (id) => { const o = orderOf(id); return paidvia.compute(o, {}); };

(async () => {
  // ================================================================ 1. labels + stamping
  section('labels, pills and the raw_json stamp');
  ok('one label per value, with the emoji the owner asked for',
    paidvia.label(V.WEBSITE_QR) === '🌐 Website QR' && paidvia.label(V.UTR_TYPED) === '🔢 UTR typed' &&
    paidvia.label(V.BACKUP_QR, 'AUTO') === '📲 Backup QR (name matched)' && paidvia.label(V.BACKUP_QR, 'ADMIN') === '📲 Backup QR (admin approved)' &&
    paidvia.label(V.COINS) === '🪙 Coins' && paidvia.label(V.ADMIN) === '🧑‍💼 Admin' && paidvia.label(V.CREDIT, 'PAID') === '💳 Credit (paid)',
    [paidvia.label(V.WEBSITE_QR), paidvia.label(V.BACKUP_QR, 'AUTO'), paidvia.label(V.CREDIT, 'PAID')]);
  ok('an unknown value has no label and no pill', paidvia.label('nonsense') === '' && paidvia.pill('') === '');
  ok('the list pill drops the bracket text so it fits a phone row', paidvia.pill(V.BACKUP_QR) === '📲 Backup QR');
  const stamped = JSON.parse(paidvia.stampJson('{"CreatedVia":"WEBSITE","Coupon":"X"}', V.WEBSITE_QR, '', '2026-09-16T10:00:00.000Z'));
  ok('stampJson keeps every other raw_json field and adds PaidVia / PaidViaAt', stamped.CreatedVia === 'WEBSITE' && stamped.Coupon === 'X' && stamped.PaidVia === 'WEBSITE_QR' && stamped.PaidViaAt === '2026-09-16T10:00:00.000Z', stamped);
  ok('raw_json we cannot read is LEFT ALONE (null = do not write)', paidvia.stampJson('not json at all', V.ADMIN, '', '') === null);
  ok('an empty raw_json becomes a fresh object', JSON.parse(paidvia.stampJson(null, V.ADMIN, '', 'x')).PaidVia === 'ADMIN');
  ok('the bank alert gives the payer name, the note and the IFSC', (() => { const a = paidvia.parseAlert(alert(89, '129680267945', 'GIREESH S KONASALI', 'FF2885974')); return a.payerName === 'GIREESH S KONASALI' && a.note === 'FF2885974' && a.ifsc === 'HDFC0002710'; })(), paidvia.parseAlert(alert(89, '1', 'GIREESH S KONASALI', 'FF2885974')));
  ok('a UPI ID, if the bank ever sends one, is masked', paidvia.maskVpa('rahulsharma@okhdfc') === 'ra**@okhdfc' && paidvia.maskVpa('') === '');

  // ================================================================ 2. every payment path stamps the right value
  section('each payment path stamps its own value');
  reset();
  addOrder('FF0001', 199); addCredit(1, '111111111111', 199, 'RAHUL KUMAR SHARMA', 'FF0001');
  let r = await order.verifyPayment('FF0001');
  ok('🌐 website QR: the bank note carried the order id', r.paid && viaOf('FF0001').via === V.WEBSITE_QR && rawOf(orderOf('FF0001').raw_json).PaidVia === 'WEBSITE_QR' && !!rawOf(orderOf('FF0001').raw_json).PaidViaAt, viaOf('FF0001'));
  ok('…and the payer name is remembered on the order screen data', paidvia.parseAlert(T.credits[0].raw).payerName === 'RAHUL KUMAR SHARMA');

  addOrder('FF0002', 149); addCredit(2, '222222222222', 149, 'MEENA IYER', 'UPI');
  r = await order.verifyPaymentByRef('FF0002', '222222222222');
  ok('🔢 UTR typed on the checkout page', r.paid && viaOf('FF0002').via === V.UTR_TYPED, viaOf('FF0002'));

  T.settings.payfallback = JSON.stringify({ enabled: true, autoAccept: true, useLearnedNames: true, windowMin: 60, reviewAfterMin: 30, backupVpa: 'flux@okaxis', backupPayee: 'FluxFilm', maxClaimsPerOrder: 5 });
  paymatch._internal.reset();
  addOrder('FF0003', 99); addCredit(3, '333333333333', 99, 'ANJALI DESAI', 'UPI');
  r = await paymatch.claimPayment('FF0003', { phone: PHONE }, 'Anjali Desai', '');
  ok('📲 backup QR, auto-matched on the payer name', r.paid && viaOf('FF0003').via === V.BACKUP_QR && viaOf('FF0003').detail === 'AUTO' && viaOf('FF0003').label === '📲 Backup QR (name matched)', { r, pv: viaOf('FF0003') });

  addOrder('FF0004', 79); addCredit(4, '444444444444', 79, 'VIKRAM RAO', 'UPI');
  r = await paymatch.claimPayment('FF0004', { phone: PHONE }, 'Vikram Rao', '444444444444');
  ok('📲 backup QR, the customer also typed the UTR in the backup form', r.paid && viaOf('FF0004').via === V.BACKUP_QR && viaOf('FF0004').detail === 'UTR', viaOf('FF0004'));

  addOrder('FF0005', 59); addCredit(5, '555555555555', 59, 'SOMEONE ELSE ENTIRELY', 'UPI');
  r = await paymatch.claimPayment('FF0005', { phone: PHONE }, 'Naveen Pillai', '');
  ok('a name that does not match is NOT auto-accepted — it waits for the owner', !r.paid && orderOf('FF0005').status === 'CREATED', r);
  const claim5 = T.claims.find((c) => c.order_id === 'FF0005');
  r = await paymatch.approveClaim(claim5.id, 5, 'checked the bank app');
  ok('📲 backup QR, approved by the owner in the 💸 Payments queue', r.ok && viaOf('FF0005').via === V.BACKUP_QR && viaOf('FF0005').detail === 'ADMIN' && viaOf('FF0005').label === '📲 Backup QR (admin approved)', viaOf('FF0005'));

  addOrder('FF0006', 0, { price: 199, discount: 199, raw_json: JSON.stringify({ FreeCheckout: true, CoinsDiscount: 199, CoinsUsed: 40 }) });
  T.spends.push({ order_id: 'FF0006', coins: 40, rupees: 199, status: 'HELD' });
  r = await order.confirmFreeOrder('FF0006', { phone: PHONE });
  ok('🪙 coins paid the whole order', r.ok && r.paid && viaOf('FF0006').via === V.COINS, { r, pv: viaOf('FF0006') });

  addOrder('FF0007', 0, { price: 199, discount: 199, coupon_code: '', raw_json: JSON.stringify({ FreeCheckout: true }) });
  r = await order.confirmFreeOrder('FF0007', { phone: PHONE });
  ok('🎁 ₹0 checkout with no coins', r.ok && r.paid && viaOf('FF0007').via === V.FREE, { r, pv: viaOf('FF0007') });

  addOrder('FF0008', 249);
  r = await order.adminMarkPaid('FF0008', 'ADMIN-CASH');
  ok('🧑‍💼 marked paid in the admin panel', r.ok && viaOf('FF0008').via === V.ADMIN, viaOf('FF0008'));

  // 💳 credit: created on credit (DUE), then the owner records the money (PAID). credit.settle is pure.
  const creditOrder = { order_id: 'FF0009', status: 'CREDIT', final_amount: 0, txn_ref: '', raw_json: JSON.stringify(paidvia.stamp({ Credit: true, CreditAmount: 149, CreditDueDate: '2026-09-20', CreditStatus: 'OPEN' }, V.CREDIT, 'DUE', '2026-09-16T00:00:00.000Z')) };
  T.orders.push(Object.assign({ phone_norm: PHONE, created_at_sheet: minAgo(60), source: 'node' }, creditOrder));
  ok('💳 on credit → "pay later"', viaOf('FF0009').via === V.CREDIT && viaOf('FF0009').label === '💳 Credit (pay later)', viaOf('FF0009'));
  const settled = credit.settle(orderOf('FF0009'), { amount: 149, method: 'UPI', key: 'k1' }, Date.now());
  ok('💳 credit marked paid → "paid"', settled.action === 'PAID' && settled.raw.PaidVia === 'CREDIT' && settled.raw.PaidViaDetail === 'PAID', { a: settled.action, v: settled.raw.PaidVia, d: settled.raw.PaidViaDetail });

  // ================================================================ 3. older orders: worked out, never rewritten
  section('older orders with nothing stored are worked out on the fly');
  reset();
  const old1 = { order_id: 'FF9001', status: 'PAID', source: 'node', txn_ref: '999111', final_amount: 199, verified_at: '2026-09-01 10:00:00', raw_json: '{}' };
  ok('a bank line whose note has the order id → 🌐 website QR', paidvia.compute(old1, { credit: { order_ids: 'FF9001', raw: alert(199, '999111', 'RAHUL KUMAR SHARMA', 'FF9001') } }).via === V.WEBSITE_QR);
  ok('a bank line with no order id in the note → 🔢 UTR typed (the only way it could be taken)', paidvia.compute(old1, { credit: { order_ids: '', raw: alert(199, '999111', 'RAHUL KUMAR SHARMA', 'UPI') } }).via === V.UTR_TYPED);
  ok('an accepted claim → 📲 backup QR, auto or admin', paidvia.compute(old1, { claim: { status: 'MATCHED', source: 'CUSTOMER', utr: null } }).detail === 'AUTO' && paidvia.compute(old1, { claim: { status: 'APPROVED', source: 'CUSTOMER' } }).detail === 'ADMIN');
  ok('a known payer name matched it by itself → 📲 backup QR (known name)', paidvia.compute(old1, { claim: { status: 'MATCHED', source: 'LEARNED' } }).label === '📲 Backup QR (known name)');
  ok('nothing at all recorded → ❔ not recorded (never a guess)', paidvia.compute(old1, {}).via === V.UNKNOWN && paidvia.compute(old1, {}).label === '❔ Not recorded');
  ok('an old-site order says so', paidvia.compute({ order_id: 'FF0900', status: 'PAID', source: 'sheet', raw_json: '{}' }, {}).label === '❔ Not recorded (old site)');
  ok('an order that was never paid has no value at all', paidvia.compute({ order_id: 'FFX', status: 'CREATED', source: 'node', raw_json: '{}' }, {}).via === '');
  ok('a refunded order still shows how it was paid', paidvia.compute({ order_id: 'FFR', status: 'REFUNDED', source: 'node', raw_json: '{}', txn_ref: 'ADMIN-CASH' }, {}).via === V.ADMIN);
  ok('what is stored wins over any guess, and says so', (() => { const c = paidvia.compute({ order_id: 'FF1', status: 'PAID', source: 'node', raw_json: JSON.stringify({ PaidVia: 'BACKUP_QR', PaidViaDetail: 'ADMIN' }) }, { credit: { order_ids: 'FF1' } }); return c.via === V.BACKUP_QR && c.stored === true; })());
  ok('a worked-out answer is marked as not stored', paidvia.compute(old1, { credit: { order_ids: 'FF9001', raw: '' } }).stored === false);
  ok('computing never writes anything to the database', T.sql.length === 0, T.sql);

  // ================================================================ 4. the Today line
  section('Today: "Payments today: 6 website QR · 2 backup QR · 1 UTR"');
  reset();
  const paidToday = (id, via, detail) => T.orders.push({ order_id: id, status: 'PAID', source: 'node', final_amount: 99, verified_at: today('11:00'), created_at_sheet: today('10:00'), txn_ref: '', phone_norm: PHONE, raw_json: JSON.stringify(paidvia.stamp({}, via, detail, today('11:00'))) });
  ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].forEach((id) => paidToday(id, V.WEBSITE_QR));
  paidToday('B1', V.BACKUP_QR, 'AUTO'); paidToday('B2', V.BACKUP_QR, 'ADMIN');
  paidToday('C1', V.UTR_TYPED);
  T.orders.push({ order_id: 'OLD', status: 'PAID', source: 'node', final_amount: 99, verified_at: '2026-01-01 10:00:00', created_at_sheet: '2026-01-01 10:00:00', raw_json: '{}', phone_norm: PHONE });
  T.orders.push({ order_id: 'NOTPAID', status: 'CREATED', source: 'node', final_amount: 99, verified_at: null, created_at_sheet: today('12:00'), raw_json: '{}', phone_norm: PHONE });
  const line = await adminhome.paidViaToday(mockDb);
  ok('the owner sees exactly the sentence he asked for', line.line === 'Payments today: 6 website QR · 2 backup QR · 1 UTR', line);
  ok('counts are right and yesterday / unpaid orders are not in it', line.total === 9 && line.counts.WEBSITE_QR === 6 && line.counts.BACKUP_QR === 2 && line.counts.UTR_TYPED === 1, line.counts);
  ok('a quiet day shows no line at all', paidvia.summaryLine({}) === '');

  // ================================================================ 5. the export column + filter
  section('Excel export: a "Paid via" column and a "Paid via" filter');
  const exOrder = { order_id: 'FF1001', status: 'PAID', source: 'node', txn_ref: '111', final_amount: 199, created_at_sheet: '2026-09-01 10:00:00', device_count: 1, raw_json: '{}' };
  const ctx = { claims: new Map(), credits: new Map([['FF1001', { order_ids: 'FF1001', raw: alert(199, '111', 'RAHUL KUMAR SHARMA', 'FF1001') }]]), subsByOrder: new Map(), subsById: new Map(), now: Date.now() };
  const row = ex.mapOrder(exOrder, ctx);
  ok('the row carries the label and the payer name', row.paidVia === '🌐 Website QR' && row.payerName === 'RAHUL KUMAR SHARMA' && row._paidVia === 'website_qr', { v: row.paidVia, n: row.payerName });
  ok('both columns are in the file, right after "Payment method"', (() => { const h = ex.ORDER_COLUMNS.map((c) => c.header); return h[h.indexOf('Payment method') + 1] === 'Paid via' && h[h.indexOf('Paid via') + 1] === 'Payer UPI name'; })(), ex.ORDER_COLUMNS.map((c) => c.header).join());
  const backupRow = ex.mapOrder({ order_id: 'FF1002', status: 'PAID', source: 'node', final_amount: 99, raw_json: '{}' }, { claims: new Map([['FF1002', { status: 'MATCHED', source: 'CUSTOMER', payer_name: 'Anjali Desai' }]]), credits: new Map(), subsByOrder: new Map(), subsById: new Map(), now: Date.now() });
  ok('a backup-QR order is labelled and keeps the name the customer gave', backupRow.paidVia === '📲 Backup QR (name matched)' && backupRow.payerName === 'ANJALI DESAI', backupRow.paidVia);
  const onlyBackup = ex.normOrderFilters({ paidVia: ['backup_qr'] }, Date.now());
  ok('the filter keeps only that route', onlyBackup.paidVia.join() === 'backup_qr' && ex.orderPassesJs(backupRow, onlyBackup) && !ex.orderPassesJs(row, onlyBackup));
  ok('no filter = every order', ex.orderPassesJs(row, ex.normOrderFilters({}, Date.now())) && ex.orderPassesJs(backupRow, ex.normOrderFilters({}, Date.now())));
  ok('a made-up filter value is thrown away, not passed to SQL', ex.normOrderFilters({ paidVia: ['website_qr', 'hack; DROP TABLE orders'] }, Date.now()).paidVia.join() === 'website_qr');
  ok('the Summary sheet also breaks the money down by route', /By how it was paid/.test(JSON.stringify(ex.ordersSummary([row, backupRow], ex.normOrderFilters({}, Date.now()), Date.now()).rows)));

  // ================================================================ 6. Customer 360: 💳 Pays from
  section('Customer 360: the payer UPI names');
  reset();
  T.customers.push({ customer_id: 'C1', name: 'Buyer', phone: PHONE, phone_norm: PHONE, email: 'buyer@example.test', member_since: '2026-01-01 10:00:00', raw_json: '{}' });
  T.customers.push({ customer_id: 'C2', name: 'Someone Else', phone: OTHER, phone_norm: OTHER, email: '', member_since: '2026-01-01 10:00:00', raw_json: '{}' });
  T.credits.push({ id: 1, upi_ref: '900000000001', amount: 199, raw: alert(199, '900000000001', 'RAHUL KUMAR SHARMA', 'FFM1'), received_at: '2026-09-10 10:00:00', consumed_order_id: 'FFM1' });
  T.credits.push({ id: 2, upi_ref: '900000000002', amount: 149, raw: alert(149, '900000000002', 'Rahul  Kumar   Sharma', 'FFM2'), received_at: '2026-09-12 10:00:00', consumed_order_id: 'FFM2' });
  T.credits.push({ id: 3, upi_ref: '900000000003', amount: 99, raw: alert(99, '900000000003', 'SUNITA SHARMA', 'FFM3'), received_at: '2026-09-14 10:00:00', consumed_order_id: 'FFM3' });
  T.credits.push({ id: 4, upi_ref: '900000000004', amount: 999, raw: alert(999, '900000000004', 'NOT THIS CUSTOMER', 'FFZ1'), received_at: '2026-09-15 10:00:00', consumed_order_id: 'FFZ1' });
  T.names.push({ phone_norm: PHONE, name_norm: 'OLD NAME ONLY', name_display: 'Old Name Only', last_used: '2026-08-01 10:00:00', times_used: 1 });
  const card = await paidvia.payerCard(q, PHONE, ['FFM1', 'FFM2', 'FFM3'], []);
  ok('newest name first', card[0].name === 'SUNITA SHARMA' && card[1].name === 'RAHUL KUMAR SHARMA', card.map((x) => x.name));
  ok('the same name written differently is ONE row, counting both orders', card.filter((x) => x.name === 'RAHUL KUMAR SHARMA').length === 1 && card.find((x) => x.name === 'RAHUL KUMAR SHARMA').orders === 2, card);
  ok('another customer\'s payment never appears', !card.some((x) => /NOT THIS CUSTOMER/.test(x.name)), card.map((x) => x.name));
  ok('a name we only know from an earlier match is shown, marked "name only"', card.some((x) => x.name === 'OLD NAME ONLY' && x.learned === true), card);
  ok('the bank code is kept so the owner can recognise the app', card[0].bank === 'HDFC0002710', card[0]);
  const nasty = paidvia.payerNames([{ raw: alert(99, '900000000009', '<script>alert(1)</script>', 'FFM9'), received_at: '2026-09-16 10:00:00', amount: 99, consumed_order_id: 'FFM9' }], [], []);
  ok('a name with HTML in it cannot carry any markup out of the bank text', !/[<>]/.test(JSON.stringify(nasty)), nasty);

  // the customer row remembers the last 5 names, typed columns untouched
  await paidvia.rememberPayerName(q, PHONE, 'Rahul Kumar Sharma', '2026-09-10 10:00:00');
  await paidvia.rememberPayerName(q, PHONE, 'Sunita Sharma', '2026-09-14 10:00:00');
  await paidvia.rememberPayerName(q, PHONE, 'Rahul Kumar Sharma', '2026-09-16 10:00:00');
  let cRaw = rawOf(T.customers[0].raw_json);
  ok('raw_json.PayerNames: newest first, no duplicates, LastPayerName set', cRaw.PayerNames.length === 2 && cRaw.PayerNames[0].name === 'RAHUL KUMAR SHARMA' && cRaw.LastPayerName === 'RAHUL KUMAR SHARMA', cRaw.PayerNames);
  ok('the customer\'s typed columns are never touched', T.customers[0].name === 'Buyer' && T.customers[0].email === 'buyer@example.test');
  for (const n of ['Aa Bb', 'Cc Dd', 'Ee Ff', 'Gg Hh', 'Ii Jj']) await paidvia.rememberPayerName(q, PHONE, n, '2026-09-17 10:00:00');
  cRaw = rawOf(T.customers[0].raw_json);
  ok('only the last 5 names are kept', cRaw.PayerNames.length === 5 && cRaw.PayerNames[0].name === 'II JJ', cRaw.PayerNames.map((x) => x.name));
  T.customers[1].raw_json = 'not json';
  ok('a customer row whose raw_json cannot be read is left alone', (await paidvia.rememberPayerName(q, OTHER, 'Someone', '')).ok === false && T.customers[1].raw_json === 'not json');

  // ================================================================ 7. finding a customer by the name they pay with
  section('admin search finds people by their payer UPI name');
  T.names.push({ phone_norm: PHONE, name_norm: 'RAHUL KUMAR SHARMA', name_display: 'Rahul Kumar Sharma', last_used: '2026-09-16 10:00:00', times_used: 2 });
  const found = await paidvia.searchPayerPhones(q, 'rahul kumar', 6);
  ok('the learned-names table is searched', found.some((x) => x.phone_norm === PHONE), found);
  ok('a one-letter search finds nothing (too vague)', (await paidvia.searchPayerPhones(q, 'r', 6)).length === 0);
  T.names.length = 0;
  ok('the name remembered on the customer row also works', (await paidvia.searchPayerPhones(q, 'II JJ', 6)).some((x) => x.phone_norm === PHONE));
  ok('no cross-table JOIN was ever sent (the fake database refuses them)', !T.sql.some((s) => /\bJOIN\b/i.test(s)));

  // ================================================================ 8. the admin screens
  section('the admin screens show it');
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => (await fetch(base + p, { headers: H })).json();

  reset();
  T.customers.push({ customer_id: 'C1', name: 'Buyer', phone: PHONE, phone_norm: PHONE, email: 'buyer@example.test', member_since: '2026-01-01 10:00:00', raw_json: '{}' });
  addOrder('FF7001', 199, { status: 'PAID', raw_json: JSON.stringify(paidvia.stamp({}, V.WEBSITE_QR, '', '2026-09-16T05:00:00.000Z')), created_at_sheet: '2026-09-16 10:00:00' });
  addOrder('FF7002', 99, { status: 'PAID', raw_json: JSON.stringify(paidvia.stamp({}, V.BACKUP_QR, 'AUTO', '2026-09-16T06:00:00.000Z')), created_at_sheet: '2026-09-16 09:00:00' });
  addOrder('FF7003', 149, { status: 'CREATED', created_at_sheet: '2026-09-16 08:00:00' });
  T.credits.push({ id: 1, upi_ref: '900000007001', amount: 199, order_ids: 'FF7001', raw: alert(199, '900000007001', 'RAHUL KUMAR SHARMA', 'FF7001'), received_at: '2026-09-16 10:01:00', consumed_order_id: 'FF7001' });

  let res1 = await get('/admin/api/orders/search');
  ok('every order row carries its route, ready for the pill', res1.ok && res1.orders.length === 3 && res1.orders[0].paid_via_label === '🌐 Website QR' && res1.orders[2].paid_via === '', res1.orders.map((o) => [o.order_id, o.paid_via]));
  ok('raw_json is never sent to the browser', res1.ok && !('raw_json' in res1.orders[0]));
  res1 = await get('/admin/api/orders/search?paidVia=backup_qr');
  ok('the Orders filter keeps only backup-QR payments', res1.ok && res1.orders.length === 1 && res1.orders[0].order_id === 'FF7002', res1.orders.map((o) => o.order_id));
  res1 = await get('/admin/api/orders/search?paidVia=made_up');
  ok('a made-up filter is ignored rather than hiding everything', res1.ok && res1.orders.length === 3);

  const detail = await get('/admin/api/orders/detail?id=FF7001');
  ok('the order screen gets "Paid via" and the payer name next to the bank credit',
    detail.ok && detail.paidVia.label === '🌐 Website QR' && detail.paidVia.stored === true && detail.bankCredits[0].payerName === 'RAHUL KUMAR SHARMA' && detail.bankCredits[0].bank === 'HDFC0002710',
    { pv: detail.paidVia, bc: detail.bankCredits });
  ok('the raw bank email text is never sent to the browser', detail.ok && !('raw' in detail.bankCredits[0]));

  const c360 = await get('/admin/api/customer?phone=' + PHONE);
  ok('Customer 360 lists the payer names and each order\'s route',
    c360.ok && c360.payerNames.length === 1 && c360.payerNames[0].name === 'RAHUL KUMAR SHARMA' && c360.orders.some((o) => o.paid_via_label === '📲 Backup QR (name matched)'),
    { p: c360.payerNames, o: c360.orders.map((o) => o.paid_via) });
  ok('Customer 360 never leaks raw_json either', c360.ok && !('raw_json' in c360.orders[0]) && !('raw_json' in (c360.profile || {})));

  T.names.push({ phone_norm: PHONE, name_norm: 'RAHUL KUMAR SHARMA', name_display: 'Rahul Kumar Sharma', last_used: '2026-09-16 10:00:00', times_used: 2 });
  const search = await get('/admin/api/search?q=rahul');
  ok('the top search box finds the buyer by the name on their UPI payment', search.ok && search.customers.some((c) => c.phone_norm === PHONE && c.payerName === 'RAHUL KUMAR SHARMA'), search.customers);
  server.close();

  // ================================================================ 9. the panel still parses
  section('the admin panel scripts still parse');
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  let bad = '';
  scripts.forEach((src, i) => { try { new Function(src); } catch (e) { bad += '#' + i + ': ' + e.message + ' '; } });
  ok('every inline <script> in admin.html parses', !bad && scripts.length > 0, bad);
  ok('the Paid via pill, filter chips and tooltip are wired up',
    /function paidViaPill\(/.test(html) && /data-pv="/.test(html) && /Paid via ⓘ/.test(html) && /payerCardHtml\(/.test(html) && /💳 Pays from/.test(html));
  ok('"Created via" keeps its own meaning and explains the difference', /where the order was made/.test(html) && /PV_TIP/.test(html));

  console.log('\npaid-via: PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('THREW', e && e.stack); process.exitCode = 1; });
