/* 💸 New paid order push + ✅ credit paid push + 📊 daily / weekly / monthly business summaries + 📈 Reports.
 * Owner request 16 Sep 2026. Run: npm test (no database, no real push / email: in-memory fakes; the fake DB refuses
 * JOINs except the two legacy orders+subscriptions statements of the Profit / Today screens). Names are made up. */
process.env.TZ = 'Asia/Kolkata';
process.env.SMTP_USER = 'support@fluxfilm.in';
process.env.SMTP_PASS = 'test-only';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 900) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (x) => JSON.parse(JSON.stringify(x));
const nsql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const p2 = (x) => String(x).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rawOf = (v) => { try { return v ? (typeof v === 'object' ? v : JSON.parse(v)) : {}; } catch (_) { return {}; } };

// ====================================================================== fake database
let T;
function resetDb() { T = { orders: [], customers: [], settings: {}, coins: [], subs: [], accounts: [], costs: [], audit: [], sql: [], tick: 0 }; }
resetDb();
const LEGACY_JOINS = [/^SELECT o\.order_id, o\.service, o\.plan, o\.duration_days, o\.final_amount, o\.order_type, COALESCE\(o\.verified_at, o\.created_at_sheet\) AS paid_at, COALESCE\(s1\.inventory_ref, s2\.inventory_ref\) AS ref FROM orders o LEFT JOIN subscriptions s1/];
function noJoin(sql) {
  if (/\bJOIN\b/i.test(sql) && !LEGACY_JOINS.some((re) => re.test(sql))) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT): ' + sql.slice(0, 120)); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; }
}
const setting = (k) => T.settings[k];
const putSetting = (k, v) => { T.tick++; T.settings[k] = { value: v, updated_at: '2026-09-16 10:' + p2(Math.floor(T.tick / 60) % 60) + ':' + p2(T.tick % 60), seq: T.tick }; };
const inRange = (v, a, b) => v != null && v >= a && v < b;
const paidAt = (o) => o.verified_at || o.created_at_sheet;
function run(sqlRaw, p) {
  const sql = nsql(sqlRaw); p = p || [];
  T.sql.push(sql);
  noJoin(sql);
  const order = (id) => T.orders.find((o) => o.order_id === id);
  let m;
  // ---- app_settings
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return setting(p[0]) ? [{ value: setting(p[0]).value }] : [];
  if (/^SELECT value, updated_at FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return setting(p[0]) ? [{ value: setting(p[0]).value, updated_at: setting(p[0]).updated_at }] : [];
  if (/^INSERT IGNORE INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) { if (setting(p[0])) return { affectedRows: 0 }; putSetting(p[0], p[1]); return { affectedRows: 1 }; }
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE value = VALUES\(value\)$/.test(sql)) { const had = !!setting(p[0]); putSetting(p[0], p[1]); return { affectedRows: had ? 2 : 1 }; }
  if ((m = sql.match(/^SELECT setting_key(, updated_at)? FROM app_settings WHERE setting_key LIKE 'ffrep:%' ORDER BY updated_at DESC, setting_key DESC LIMIT (\d+)(?:, (\d+))?$/))) {
    const all = Object.keys(T.settings).filter((k) => k.startsWith('ffrep:')).sort((a, b) => T.settings[b].seq - T.settings[a].seq);
    const list = m[3] ? all.slice(+m[2], +m[2] + +m[3]) : all.slice(0, +m[2]);
    return list.map((k) => ({ setting_key: k, updated_at: T.settings[k].updated_at }));
  }
  if (/^DELETE FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) { const had = !!setting(p[0]); delete T.settings[p[0]]; return { affectedRows: had ? 1 : 0 }; }
  if (/^INSERT INTO audit_log/.test(sql)) { T.audit.push({ action: p[0], id: p[2], summary: p[3] }); return { affectedRows: 1 }; }
  // ---- order.js (payment paths)
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  if (/^SELECT order_id, final_amount, status, source FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT status, coupon_code, phone, phone_norm, email, discount FROM orders WHERE order_id = \? FOR UPDATE$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET status = \?, txn_ref = \?, verified_at = NOW\(\) WHERE order_id = \?$/.test(sql)) { const o = order(p[2]); if (o) Object.assign(o, { status: p[0], txn_ref: p[1], verified_at: fmt(new Date()) }); return { affectedRows: o ? 1 : 0 }; }
  if (/^SELECT order_id, status, source, service, plan, phone, phone_norm, email, order_type, price, discount, final_amount, coupon_code, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET status = 'PAID', txn_ref = \?, verified_at = NOW\(\), raw_json = \? WHERE order_id = \? AND UPPER\(status\) = 'CREATED' LIMIT 1$/.test(sql)) { const o = order(p[2]); if (!o || o.status !== 'CREATED') return { affectedRows: 0 }; Object.assign(o, { status: 'PAID', txn_ref: p[0], raw_json: p[1], verified_at: fmt(new Date()) }); return { affectedRows: 1 }; }
  // ---- ownernotify.js
  if (/^SELECT order_id, name, phone_norm, service, plan, final_amount, order_type, status, txn_ref, raw_json FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if ((m = sql.match(/^UPDATE orders SET raw_json = JSON_SET\(COALESCE\(raw_json, JSON_OBJECT\(\)\), '\$\.(\w+)', \?\) WHERE order_id = \? AND JSON_EXTRACT\(COALESCE\(raw_json, JSON_OBJECT\(\)\), '\$\.(\w+)'\) IS NULL LIMIT 1$/))) {
    const o = order(p[1]); if (!o) return { affectedRows: 0 };
    const raw = rawOf(o.raw_json); if (raw[m[2]] != null) return { affectedRows: 0 };
    raw[m[1]] = p[0]; o.raw_json = JSON.stringify(raw); return { affectedRows: 1 };
  }
  if (/^SELECT name FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map((c) => ({ name: c.name }));
  // ---- credit.js
  if (/^UPDATE orders SET status = 'CREDIT' WHERE order_id = \? AND UPPER\(status\) = 'CREATED' LIMIT 1$/.test(sql)) { const o = order(p[0]); if (!o || o.status !== 'CREATED') return { affectedRows: 0 }; o.status = 'CREDIT'; return { affectedRows: 1 }; }
  if (/^SELECT order_id, created_at_sheet, name, phone_norm, email, service, plan, final_amount, status, order_type, renew_sub_id, txn_ref, raw_json FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET status = \?, txn_ref = \?, final_amount = \?, raw_json = \?/.test(sql)) {
    const o = order(p[4]); if (!o || o.status !== 'CREDIT' || String(o.txn_ref || '') !== p[5]) return { affectedRows: 0 };
    Object.assign(o, { status: p[0], txn_ref: p[1], final_amount: p[2], raw_json: p[3] }); if (/verified_at = NOW\(\)/.test(sql)) o.verified_at = fmt(new Date()); return { affectedRows: 1 };
  }
  if (/FROM orders WHERE UPPER\(status\) = 'CREDIT' ORDER BY created_at_sheet LIMIT 500$/.test(sql)) return T.orders.filter((o) => o.status === 'CREDIT').map(clone);
  // ---- reports.js
  if (/^SELECT order_id, service, plan, final_amount, order_type, COALESCE\(verified_at, created_at_sheet\) AS paid_at FROM orders WHERE UPPER\(status\) = 'PAID' AND COALESCE\(verified_at, created_at_sheet\) >= \? AND COALESCE\(verified_at, created_at_sheet\) < \? LIMIT 50000$/.test(sql))
    return T.orders.filter((o) => o.status === 'PAID' && inRange(paidAt(o), p[0], p[1])).map((o) => ({ order_id: o.order_id, service: o.service, plan: o.plan, final_amount: o.final_amount, order_type: o.order_type, paid_at: paidAt(o) }));
  if (/^SELECT COUNT\(\*\) AS n FROM customers WHERE member_since >= \? AND member_since < \?$/.test(sql)) return [{ n: T.customers.filter((c) => inRange(c.member_since, p[0], p[1])).length }];
  if (/^SELECT order_id, service, plan, final_amount, raw_json, created_at_sheet FROM orders WHERE UPPER\(status\) = 'REFUNDED' AND created_at_sheet >= DATE_SUB\(\?, INTERVAL 400 DAY\) AND created_at_sheet < \? LIMIT 20000$/.test(sql))
    return T.orders.filter((o) => o.status === 'REFUNDED' && o.created_at_sheet < p[1]).map(clone);
  if (/FROM coins_ledger WHERE ts >= \? AND ts < \?$/.test(sql)) {
    const rows = T.coins.filter((c) => inRange(c.ts, p[0], p[1]));
    return [{ earned: rows.filter((c) => c.coins_delta > 0 && c.event !== 'SPEND_RELEASE').reduce((a, c) => a + c.coins_delta, 0), spent: rows.reduce((a, c) => a + (c.event === 'SPEND' || c.event === 'SPEND_RELEASE' ? -c.coins_delta : 0), 0) }];
  }
  if (/^SELECT COUNT\(\*\) AS subs, COUNT\(DISTINCT phone_norm\) AS customers FROM subscriptions WHERE UPPER\(status\) = 'ACTIVE' AND expiry_date BETWEEN NOW\(\) AND NOW\(\) \+ INTERVAL 7 DAY$/.test(sql)) return [{ subs: 3, customers: 2 }];
  // ---- profit.js computeProfit (legacy orders+subscriptions JOIN allowed)
  if (LEGACY_JOINS[0].test(sql)) return T.orders.filter((o) => o.status === 'PAID' && paidAt(o) < p[1]).map((o) => ({ order_id: o.order_id, service: o.service, plan: o.plan, duration_days: o.duration_days || 0, final_amount: o.final_amount, order_type: o.order_type, paid_at: paidAt(o), ref: null }));
  if (/^SELECT service, account_id, login_id, is_active FROM inventory_accounts/.test(sql)) return T.accounts.map(clone);
  if (/FROM subscriptions WHERE UPPER\(status\) = 'ACTIVE' AND expiry_date > NOW\(\) GROUP BY inventory_ref$/.test(sql)) return [];
  if (/^SELECT DATE_FORMAT\(COALESCE\(verified_at, created_at_sheet\), '%Y-%m'\) ym/.test(sql)) return [];
  if (/^SELECT service, account_id, monthly_cost, note FROM account_costs$/.test(sql)) return T.costs.map(clone);
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 200));
}
const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, query: async (sql, p) => [run(sql, p)] };
const fakeDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => ({ getConnection: async () => conn, query: async (sql, p) => [run(sql, p)] }), ping: async () => ({ ok: true }) };

const pushes = [];
const fakePush = { sendToAdmins: async (msg, opts) => { pushes.push({ msg: clone(msg), opts: clone(opts || {}) }); return { ok: true, sent: 1, devices: 1, failed: 0, removed: 0 }; }, stats: async () => ({ ok: true, adminDevices: 1 }) };
const mails = [];
const fakeSmtp = { status: () => ({ configured: true, sender: 'support@fluxfilm.in', replyTo: 'support@fluxfilm.in' }), sendMail: async (m) => { mails.push(clone(m)); return { ok: true, sender: 'support@fluxfilm.in' }; } };
const bank = {};
const fakePayments = { findByOrder: async (id) => bank[id] || null, findByRef: async (id, ref) => (bank[id] && bank[id].upi_ref === ref ? bank[id] : null) };
const fakeCoins = { onOrderPaid: async () => ({ ok: true }), awardCoins: async () => ({ ok: true }), lockWalletOn: async () => {}, creditOnOrderOn: async () => ({ held: 0 }) };
const fakeReferrals = { onOrderPaid: async () => ({}) };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return fakeDb;
  if (req === './push') return fakePush;
  if (req === './smtp') return fakeSmtp;
  if (req === './payments') return fakePayments;
  if (req === './coins') return fakeCoins;
  if (req === './referrals') return fakeReferrals;
  if (req === './paymatch') return { autoMatchLearned: async () => null };
  return origLoad.apply(this, arguments);
};

const ROOT = path.join(__dirname, '..');
const notify = require('../ownernotify');
const order = require('../order');
const credit = require('../credit');
const reports = require('../reports');
const profit = require('../profit');
const settle = () => sleep(40); // fire-and-forget alerts run on setImmediate

function mkOrder(id, extra, raw) {
  return Object.assign({ order_id: id, source: 'node', status: 'CREATED', name: 'Rahul Kumar', phone: '9876543210', phone_norm: '9876543210', email: 'r@x.in', service: 'Netflix', plan: 'Sharing 1M', price: 299, discount: 0, final_amount: 299, coupon_code: '', order_type: 'NEW', txn_ref: null, created_at_sheet: fmt(new Date()), verified_at: null, raw_json: JSON.stringify(Object.assign({ Status: 'CREATED' }, raw || {})) }, extra || {});
}

(async () => {
  // ==================================================================== 1. message text
  section('💸 alert text + settings');
  ok('short name: first name + initial', notify.shortName('rahul kumar sharma') === 'Rahul S.' && notify.shortName('Priya') === 'Priya' && notify.shortName('') === '');
  ok('pay method from txn ref', notify.payMethod({ txn_ref: 'UTR123' }) === 'UPI' && notify.payMethod({ txn_ref: 'ADMIN-CASH' }) === 'Cash' && notify.payMethod({ txn_ref: 'ADMIN-CREDIT-UPI:U1' }) === 'UPI' && notify.payMethod({ txn_ref: 'CREDIT-FF12', raw_json: '{"PaymentMethod":"CREDIT+COINS"}' }) === '₹0 checkout (refund credit + coins)' && notify.payMethod({ txn_ref: 'MANUAL-REVIEW-4' }) === 'UPI (checked by admin)');
  const m1 = notify.orderMessage({ order_id: 'FF100', name: 'Rahul Kumar', service: 'Netflix', plan: 'Sharing 1M', final_amount: 299, order_type: 'RENEW', txn_ref: 'UTR1' });
  ok('title "💸 New order ₹299", body "Netflix · Sharing 1M · Rahul K. · renewal · UPI", deep link + unique tag', m1.title === '💸 New order ₹299' && m1.body === 'Netflix · Sharing 1M · Rahul K. · renewal · UPI' && m1.url === '/panel?v=orders&order=FF100' && m1.tag === 'order-FF100', m1);
  ok('push.js keeps the deep link and tag (renotify per tag in sw.js)', (() => { const c = require('../push').cleanMessage; return true; })() && /opts\.renotify = true/.test(fs.readFileSync(path.join(ROOT, 'pwa.js'), 'utf8')));
  let v = notify.validate({ dailyTime: '7:05', emails: 'Owner@Gmail.com, b@x.in ,owner@gmail.com' });
  ok('settings: defaults ON/OFF as asked, time normalised, emails lower-case + de-duplicated', v.ok && v.settings.orderPush === true && v.settings.creditPush === true && v.settings.orderEmail === false && v.settings.dailyTime === '07:05' && v.settings.weeklyTime === '23:45' && v.settings.monthlyTime === '23:50' && v.settings.emails.join() === 'owner@gmail.com,b@x.in', v);
  v = notify.validate({ dailyTime: '24:10', emails: 'nope, a@b.in' });
  ok('settings: bad time / bad email refused with a message', !v.ok && v.errors.length === 2 && /23:30/.test(v.errors[0]) && /nope/.test(v.errors[1]), v.errors);
  ok('settings: at most 5 emails', !notify.validate({ emails: 'a@a.in,b@a.in,c@a.in,d@a.in,e@a.in,f@a.in' }).ok);
  ok('default recipient = the shop sender (support@)', notify.recipients({ emails: [] }).join() === 'support@fluxfilm.in' && notify.recipients({ emails: ['me@x.in'] }).join() === 'me@x.in');

  // ==================================================================== 2. every PAID path
  section('💸 push on every PAID path — once, never on CREDIT');
  T.orders.push(mkOrder('FF1'), mkOrder('FF2', { order_type: 'RENEW', final_amount: 199, name: '' }), mkOrder('FF3', { service: 'Prime Video', plan: '1 Month', final_amount: 149 }), mkOrder('FF4', { final_amount: 0, price: 0 }, { FreeCheckout: true }), mkOrder('FF5'), mkOrder('FFC', { status: 'CREDIT', order_type: 'RENEW', final_amount: 129 }, { Credit: true, CreditAmount: 129, CreditStatus: 'OPEN' }));
  T.customers.push({ phone_norm: '9876543210', name: 'Rahul Kumar', member_since: '2026-01-01 10:00:00' });
  bank.FF1 = { upi_ref: 'UTR-A1' }; bank.FF2 = { upi_ref: 'UTR-B2' };

  let r = await order.verifyPayment('FF1'); await settle();
  ok('bank email match (verifyPayment) → PAID + one push', r.paid && pushes.length === 1 && pushes[0].msg.title === '💸 New order ₹299' && pushes[0].msg.body === 'Netflix · Sharing 1M · Rahul K. · new · UPI' && pushes[0].msg.url === '/panel?v=orders&order=FF1' && pushes[0].opts.kind === 'admin', pushes);
  ok('…marker AdminNotifiedAt saved in raw_json (typed columns untouched)', !!rawOf(T.orders[0].raw_json).AdminNotifiedAt && T.orders[0].status === 'PAID' && rawOf(T.orders[0].raw_json).Status === 'CREATED');
  r = await order.verifyPayment('FF1'); await settle();
  ok('checking the same order again → no second push', r.paid && pushes.length === 1);
  let d = await notify.orderPaid('FF1');
  ok('direct second call → skipped (already)', d.skipped === 'already' && pushes.length === 1, d);
  notify._internal.reset();
  d = await notify.orderPaid('FF1');
  ok('another process / after a restart (memory empty) → the raw_json marker still stops it', d.skipped === 'already' && pushes.length === 1, d);
  r = await order.verifyPaymentByRef('FF2', 'UTR-B2'); await settle();
  ok('typed UTR (verifyPaymentByRef) → push, renewal, name from the customer profile', r.paid && pushes.length === 2 && pushes[1].msg.body === 'Netflix · Sharing 1M · Rahul K. · renewal · UPI' && pushes[1].msg.title === '💸 New order ₹199', pushes[1]);
  r = await order.adminMarkPaid('FF3', 'ADMIN-CASH'); await settle();
  ok('admin Mark paid / Quick order paid now / backup UPI claim (adminMarkPaid) → push "Cash"', r.ok && pushes.length === 3 && /Prime Video · 1 Month · Rahul K\. · new · Cash$/.test(pushes[2].msg.body), pushes[2]);
  await order.adminMarkPaid('FF3', 'ADMIN-CASH'); await settle();
  ok('marking it paid twice → still one push', pushes.length === 3);
  r = await order.confirmFreeOrder('FF4', { phone: '9876543210' }); await settle();
  ok('₹0 checkout (confirmFreeOrder) → push "₹0"', r.ok && r.paid && pushes.length === 4 && pushes[3].msg.title === '💸 New order ₹0' && /₹0 checkout/.test(pushes[3].msg.body), { r, p: pushes[3] });
  r = await order.adminMarkPaid('FFC', 'ADMIN-UPI');
  await settle();
  ok('a CREDIT order cannot be "Mark paid" here → no push', !r.ok && r.credit && pushes.length === 4, r);
  const qo = fs.readFileSync(path.join(ROOT, 'quickorders.js'), 'utf8'); const pm = fs.readFileSync(path.join(ROOT, 'paymatch.js'), 'utf8');
  ok('Quick order paid now + backup UPI claims + learned names all pay through adminMarkPaid (→ _markPaid → alert)', /adminMarkPaid\(orderId, txn\)/.test(qo) && /markPaid: \(orderId, txnRef\) => require\('\.\/order'\)\.adminMarkPaid/.test(pm));

  // credit: creation never alerts, mark paid → "✅ Credit paid"
  T.orders.push(mkOrder('FFK', { order_type: 'RENEW', final_amount: 129, service: 'Prime Video', plan: '1 Month' }, { Credit: true, CreditAmount: 129, CreditStatus: 'OPEN' }));
  const st = await credit.startCredit({ db: fakeDb, fulfill: { fulfillForAdmin: async () => ({ ok: true, fulfillment: 'FULFILLED' }) } }, 'FFK'); await settle();
  ok('💳 credit renewal created (status CREDIT) → no push', st.ok && T.orders.find((o) => o.order_id === 'FFK').status === 'CREDIT' && pushes.length === 4, st);

  const express = require('express');
  const app = express(); app.use(express.json());
  const auth = (req, res) => { if (req.headers['x-admin-key'] === 'k') return true; res.status(403).json({ ok: false }); return false; };
  const audit = { record: (req, e) => T.audit.push(e) };
  let NOW = Date.parse('2026-09-16T12:00:00+05:30');
  const fakeHome = { buildToday: async () => ({ ok: true, items: [
    { key: 'undelivered', count: 1 }, { key: 'refundrequests', count: 2 }, { key: 'upirefunds', count: 1 }, { key: 'manual', count: 3, late: 1 }, { key: 'unmatched', count: 4 },
    { key: 'out', count: 1, names: ['Netflix · Private 1M'] }, { key: 'low', count: 1, names: ['Prime Video · 1 Month (2)'] }, { key: 'expired', count: 5, waiting: 2 },
  ] }) };
  const summaryDeps = { home: fakeHome, comments: { adminList: async () => ({ counts: { pending: 6 } }) } };
  credit.mount(app, { db: fakeDb, auth, audit, coins: fakeCoins, referrals: fakeReferrals });
  require('../adminreports').mount(app, { db: fakeDb, auth, audit, now: () => NOW, summaryDeps, push: fakePush, sendGapMs: 0 });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (pth) => { const x = await fetch(base + pth, { headers: H }); return { status: x.status, body: await x.json() }; };
  const post = async (pth, b) => { const x = await fetch(base + pth, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() }; };

  let rr = await post('/admin/api/credit/mark-paid', { orderId: 'FFK', amount: 100, method: 'UPI', key: 'p1', mode: 'PARTIAL' }); await settle();
  ok('credit part payment → no push', rr.body.ok && pushes.length === 4, rr.body);
  rr = await post('/admin/api/credit/mark-paid', { orderId: 'FFK', amount: 29, method: 'UPI', ref: 'U9', key: 'p2' }); await settle();
  ok('credit marked paid in full → "✅ Credit paid ₹129" once (no 💸 new-order push for it)', rr.body.ok && rr.body.status === 'PAID' && pushes.length === 5 && pushes[4].msg.title === '✅ Credit paid ₹129' && /credit renewal · UPI$/.test(pushes[4].msg.body) && pushes[4].msg.url === '/panel?v=orders&order=FFK', pushes[4]);
  d = await notify.creditPaid('FFK', 129);
  ok('credit paid alert never twice', d.skipped === 'already' && pushes.length === 5, d);

  // settings off
  section('settings off → no push; order email on');
  rr = await post('/admin/api/owner-alerts/settings', { orderPush: false, creditPush: false });
  ok('switch both alerts off (change log)', rr.body.ok && rr.body.settings.orderPush === false && T.audit.some((a) => a.action === 'ownerAlerts.settings'), rr.body);
  notify._internal.reset();
  await order.adminMarkPaid('FF5', 'ADMIN-UPI'); await settle();
  ok('new paid order with the push OFF → nothing sent, no marker', pushes.length === 5 && !rawOf(T.orders.find((o) => o.order_id === 'FF5').raw_json).AdminNotifiedAt);
  T.orders.push(mkOrder('FFK2', { status: 'CREDIT', order_type: 'RENEW', final_amount: 50 }, { Credit: true, CreditAmount: 50, CreditStatus: 'OPEN' }));
  await post('/admin/api/credit/mark-paid', { orderId: 'FFK2', amount: 50, key: 'z1' }); await settle();
  ok('credit paid with its push OFF → nothing sent', pushes.length === 5);
  rr = await post('/admin/api/owner-alerts/settings', { orderPush: true, creditPush: true, orderEmail: true, emails: 'owner@example.com' });
  rr = await post('/admin/api/owner-alerts/settings', { emails: 'owner@example.com, not-an-email' });
  ok('invalid email refused (400), nothing saved', rr.status === 400 && /not-an-email/.test(rr.body.message), rr.body);
  notify._internal.reset();
  T.orders.push(mkOrder('FF6', { name: '<img src=x onerror=alert(1)> Bad', plan: 'A&B' }));
  await order.adminMarkPaid('FF6', 'ADMIN-UPI'); await settle();
  ok('"Also email me each order" ON → push + one email to the owner, escaped', pushes.length === 6 && mails.length === 1 && mails[0].to === 'owner@example.com' && !/<img/.test(mails[0].html) && /A&amp;B/.test(mails[0].html) && /\/panel\?v=orders&amp;order=FF6/.test(mails[0].html) && !!mails[0].text, mails[0]);

  // test alert
  section('🔔 test new-order alert');
  const before = { orders: T.orders.length, sql: T.sql.length, json: JSON.stringify(T.orders) };
  rr = await post('/admin/api/owner-alerts/test-order', {});
  const writes = T.sql.slice(before.sql).filter((x) => /^(INSERT|UPDATE|DELETE)/.test(x));
  ok('test alert: same push format, clearly TEST, opens Orders, kind test', rr.body.ok && pushes.length === 7 && /^🧪 TEST · 💸 New order ₹299$/.test(pushes[6].msg.title) && /nothing was created/.test(pushes[6].msg.body) && pushes[6].opts.kind === 'test', pushes[6]);
  ok('test alert creates nothing (no order, no DB write)', T.orders.length === before.orders && JSON.stringify(T.orders) === before.json && writes.length === 0 && T.audit.some((a) => a.action === 'ownerAlerts.test'), writes);

  // ==================================================================== 3. scheduler
  section('📊 scheduler: IST times, guard, restart, catch-up');
  const I = reports._internal;
  const cfg = notify.validate({}).settings;
  ok('IST clock: 23:30 IST = 18:00 UTC', I.istMsAt('2026-09-16', '23:30') === Date.UTC(2026, 8, 16, 18, 0) && I.istYmd(Date.UTC(2026, 8, 16, 18, 45)) === '2026-09-17');
  const keysAt = (iso, c) => reports.dueNow(Date.parse(iso), c || cfg).map((x) => x.range.key).sort().join();
  ok('daily: not at 23:29, due at 23:30 IST', keysAt('2026-09-16T23:29:00+05:30') === '' && keysAt('2026-09-16T23:30:00+05:30') === 'day:2026-09-16');
  ok('weekly: Sunday 23:45 → week Mon 14 – Sun 20 Sep (weeks start Monday)', keysAt('2026-09-20T23:46:00+05:30') === 'day:2026-09-20,week:2026-09-14');
  ok('monthly: last day 23:50 (30 Sep; 28 Feb 2026)', keysAt('2026-09-30T23:51:00+05:30') === 'day:2026-09-30,month:2026-09' && keysAt('2026-02-28T23:55:00+05:30') === 'day:2026-02-28,month:2026-02' && keysAt('2026-02-27T23:55:00+05:30') === 'day:2026-02-27');
  ok('a morning time (09:00) sends yesterday\'s day', keysAt('2026-09-17T09:05:00+05:30', Object.assign({}, cfg, { dailyTime: '09:00' })) === 'day:2026-09-16');
  ok('off → never due', keysAt('2026-09-30T23:55:00+05:30', Object.assign({}, cfg, { dailyOn: false, monthlyOn: false })) === '');
  ok('catch-up: 5 h 59 m late still due, 6 h late skipped', keysAt('2026-09-17T05:29:00+05:30') === 'day:2026-09-16' && keysAt('2026-09-17T05:30:00+05:30') === '');
  const nx = reports.nextTimes(Date.parse('2026-09-16T12:00:00+05:30'), cfg);
  ok('next send times for the settings screen', /Wed 16 Sep 2026 23:30/.test(nx.day.text) && /Sun 20 Sep 2026 23:45/.test(nx.week.text) && /Wed 30 Sep 2026 23:50/.test(nx.month.text), nx);

  const sends = [];
  const mkSched = (iso) => reports.createScheduler({ db: fakeDb, now: () => Date.parse(iso), getSettings: async () => cfg, send: async (c, key) => { sends.push(key); await reports.saveSnapshot(fakeDb, key, JSON.stringify({ status: 'SENT' })); } });
  const A = mkSched('2026-09-16T23:31:00+05:30'); const B = mkSched('2026-09-16T23:31:00+05:30');
  await Promise.all([A.tick(), B.tick()]);
  ok('two processes at the same minute → sent once', sends.length === 1 && sends[0] === 'ffrep:day:2026-09-16', sends);
  await A.tick(); await B.tick();
  ok('every later tick → nothing more', sends.length === 1);
  const C = mkSched('2026-09-16T23:50:00+05:30'); await C.tick();
  ok('after a restart / redeploy (fresh process) → not sent again', sends.length === 1);
  const D = mkSched('2026-09-17T03:10:00+05:30'); await D.tick();
  ok('server was down at 23:30 on 17th? here: already sent, so the catch-up does not repeat it', sends.length === 1);
  delete T.settings['ffrep:day:2026-09-16'];
  const E = mkSched('2026-09-17T03:10:00+05:30'); await E.tick();
  ok('down at the time, back at 03:10 (within 6 h) → catch-up send', sends.length === 2 && sends[1] === 'ffrep:day:2026-09-16', sends);
  delete T.settings['ffrep:day:2026-09-16'];
  const F = mkSched('2026-09-17T06:00:00+05:30'); await F.tick();
  ok('back only at 06:00 (over 6 h) → skipped', sends.length === 2);
  const failing = reports.createScheduler({ db: fakeDb, now: () => Date.parse('2026-09-20T23:46:00+05:30'), getSettings: async () => Object.assign({}, cfg, { dailyOn: false }), send: async () => { throw new Error('SMTP down'); } });
  const fr = await failing.tick();
  ok('a failed send is logged on its guard row (no retry loop / no double send)', fr.length === 1 && fr[0].error && rawOf(T.settings['ffrep:week:2026-09-14'].value).status === 'FAILED' && (await failing.tick()).length === 0, fr);
  ok('server.js starts the scheduler (unref timers)', /require\('\.\/reports'\)\.startTimer\(\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')) && /first\.unref/.test(fs.readFileSync(path.join(ROOT, 'reports.js'), 'utf8')));

  // ==================================================================== 4. summary numbers vs a fixture
  section('📊 summary numbers (fixture)');
  resetDb(); notify._internal.reset();
  const P = (id, amt, at, extra) => mkOrder(id, Object.assign({ status: 'PAID', final_amount: amt, verified_at: at, created_at_sheet: at }, extra || {}));
  T.orders.push(
    P('A', 299, '2026-09-15 10:00:00'),
    P('B', 199, '2026-09-15 20:00:00', { order_type: 'RENEW' }),
    P('C', 149, '2026-09-15 23:59:59', { service: 'Prime Video', plan: '1 Month' }),
    mkOrder('D', { status: 'CREDIT', order_type: 'RENEW', final_amount: 500, created_at_sheet: '2026-09-15 11:00:00' }, { Credit: true, CreditAmount: 500, CreditDueDate: '2026-09-10' }),
    mkOrder('E', { status: 'REFUNDED', final_amount: 250, created_at_sheet: '2026-09-10 09:00:00', verified_at: '2026-09-10 09:05:00' }, { RefundedAt: '2026-09-15 12:00:00', RefundMethod: 'UPI', RefundAmount: 250 }),
    mkOrder('E2', { status: 'REFUNDED', final_amount: 80, created_at_sheet: '2026-09-12 09:00:00' }, { RefundedAt: '2026-09-15 13:00:00', RefundMethod: 'Coins', RefundAmount: 80 }),
    P('F', 100, '2026-09-14 09:00:00'),
    mkOrder('G', { status: 'PAID', order_type: 'RENEW', final_amount: 400, created_at_sheet: '2026-09-14 11:00:00', verified_at: null }),
    P('H', 999, '2026-09-16 00:00:00'),
  );
  T.customers.push({ phone_norm: '1', member_since: '2026-09-15 08:00:00' }, { phone_norm: '2', member_since: '2026-09-15 22:00:00' }, { phone_norm: '3', member_since: '2026-09-14 08:00:00' });
  T.coins.push({ ts: '2026-09-15 10:00:00', event: 'NEW_PURCHASE', coins_delta: 15 }, { ts: '2026-09-15 11:00:00', event: 'SPEND', coins_delta: -40 }, { ts: '2026-09-15 12:00:00', event: 'SPEND_RELEASE', coins_delta: 10 });
  T.accounts.push({ service: 'Netflix', account_id: 'NF-1', login_id: 'a', is_active: 'TRUE' });
  T.costs.push({ service: 'Netflix', account_id: 'NF-1', monthly_cost: 304.375, note: null });
  NOW = Date.parse('2026-09-16T12:00:00+05:30');
  const day = reports.rangeFor('day', '2026-09-15');
  const sum = await reports.computeSummary(fakeDb, day, { now: NOW, deps: summaryDeps });
  ok('cash in = paid orders only: ₹647 (CREDIT ₹500, refunded, next-day ₹999 left out)', sum.totals.revenue === 647 && sum.totals.orders === 3 && sum.totals.newOrders === 2 && sum.totals.renewals === 1 && sum.totals.newRevenue === 448 && sum.totals.renewRevenue === 199, sum.totals);
  const pf = await profit.computeProfit(fakeDb, day, {});
  ok('…exactly the 💰 Profit page cash in / orders / renewals for the same range', pf.totals.revenue === sum.totals.revenue && pf.totals.orders === sum.totals.orders && pf.totals.renewals === sum.totals.renewals, pf.totals);
  ok('refunds shown separately by refund date: 2 · ₹330 (UPI sent 1 · ₹250, coins 1 · ₹80)', sum.totals.refunds.count === 2 && sum.totals.refunds.amount === 330 && sum.totals.refunds.methods['UPI (sent)'].amount === 250 && sum.totals.refunds.methods['Coins / credit'].count === 1, sum.totals.refunds);
  ok('previous day: ₹500 (verified_at empty → created time, like Profit) → ▲29%', sum.prev.revenue === 500 && sum.change.revenue === 29 && sum.prevRange.from === '2026-09-14' && reports.arrow(647, 500) === '▲29%' && reports.arrow(50, 100) === '▼50%' && reports.arrow(5, 0) === 'new', sum.prev);
  ok('new customers 2 vs 1 → ▲100%', sum.totals.newCustomers === 2 && sum.change.newCustomers === 100);
  ok('top services / plans by ₹', sum.totals.services[0].service === 'Netflix' && sum.totals.services[0].revenue === 498 && sum.totals.services[0].renewals === 1 && sum.totals.plans[0].plan === 'Sharing 1M');
  ok('profit estimate from the Profit page (cost ₹10/day)', sum.profit && sum.profit.ready && sum.profit.cost === 10, sum.profit);
  ok('receivables (credit.receivables): ₹500 outstanding, overdue', sum.credit.total === 500 && sum.credit.overdue === 1 && sum.credit.overdueAmount === 500, sum.credit);
  ok('coins given 15 / used 30 (🪙 Coins page formula)', sum.coins.given === 15 && sum.coins.used === 30, sum.coins);
  ok('Today cards → pending / stock / passwords', sum.pending.manual === 3 && sum.pending.manualLate === 1 && sum.pending.refundRequests === 2 && sum.pending.upiRefunds === 1 && sum.pending.unmatched === 4 && sum.pending.comments === 6 && sum.pending.total === 17 && sum.stock.out[0] === 'Netflix · Private 1M' && sum.passwords.changeNow === 5 && sum.expiring.customers === 2, sum.pending);
  ok('push line', reports.pushLine(sum) === '📊 Yesterday: ₹647 · 3 orders (2 new) · ▲29%', reports.pushLine(sum));
  const wk = await reports.computeSummary(fakeDb, reports.rangeFor('week', '2026-09-16'), { now: NOW, deps: summaryDeps });
  ok('week totals + best day', wk.range.from === '2026-09-14' && wk.range.to === '2026-09-20' && wk.totals.revenue === 2146 && wk.bestDay.date === '2026-09-16' && wk.totals.daily.length === 7 && wk.prevRange.from === '2026-09-07', { t: wk.totals.revenue, best: wk.bestDay });
  ok('the ₹0 day summary makes a sensible line', reports.pushLine(await reports.computeSummary(fakeDb, reports.rangeFor('day', '2026-08-01'), { now: NOW, extras: false })) === '📊 Sat 1 Aug: ₹0 · 0 orders (0 new) · ±0%');

  section('✉️ summary email is escaped, has tables + plain text');
  T.orders.push(P('X1', 55, '2026-09-15 09:00:00', { service: '<script>alert(1)</script>', plan: 'A&B "x"' }));
  const s2 = await reports.computeSummary(fakeDb, day, { now: NOW, deps: summaryDeps });
  const em = reports.renderEmail(s2, { url: '/panel?v=reports&report=day:2026-09-15' });
  ok('no raw <script>, service / plan escaped, links escaped', !/<script>/.test(em.html) && /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(em.html) && /A&amp;B &quot;x&quot;/.test(em.html) && /report=day:2026-09-15/.test(em.html), em.html.slice(0, 400));
  ok('subject + tables + plain-text fallback with the same numbers', /^📊 FluxFilm daily summary — Tue 15 Sep 2026: ₹702 \(▲40%\)$/.test(em.subject) && /<table/.test(em.html) && /💵 Revenue/.test(em.text) && /Cash in \(paid orders\): ₹702/.test(em.text) && /⏳ Pending/.test(em.html), { subject: em.subject, text: em.text.slice(0, 300) });

  // ==================================================================== 5. Reports API + send now + snapshots
  section('📈 Reports API ranges, send now, snapshots');
  let g = await get('/admin/api/reports?kind=day&date=2026-09-15');
  ok('day report = same numbers + sections', g.body.ok && g.body.totals.revenue === 702 && g.body.sections.some((x) => x.title === '💵 Revenue') && g.body.line === '📊 Yesterday: ₹702 · 4 orders (3 new) · ▲40%', g.body.line);
  g = await get('/admin/api/reports?kind=week&date=2026-09-20');
  ok('week of a Sunday → Monday 14 – Sunday 20', g.body.range.from === '2026-09-14' && g.body.range.to === '2026-09-20' && g.body.range.days === 7, g.body.range);
  g = await get('/admin/api/reports?kind=month&date=2026-02-10');
  ok('month end: February 2026 → 1 – 28 Feb, compared with January', g.body.range.from === '2026-02-01' && g.body.range.to === '2026-02-28' && g.body.prevRange.from === '2026-01-01' && g.body.prevRange.to === '2026-01-31', g.body.range);
  g = await get('/admin/api/reports?kind=month&date=2026-12');
  ok('December → 1 – 31 Dec, compared with November', g.body.range.from === '2026-12-01' && g.body.range.to === '2026-12-31' && g.body.prevRange.from === '2026-11-01');
  g = await get('/admin/api/reports?kind=custom&from=2026-09-14&to=2026-09-15');
  ok('custom 14–15 Sep (both days) compared with 12–13 Sep', g.body.ok && g.body.range.days === 2 && g.body.prevRange.from === '2026-09-12' && g.body.prevRange.to === '2026-09-13' && g.body.totals.revenue === 1202, { r: g.body.range, p: g.body.prevRange, t: g.body.totals && g.body.totals.revenue });
  g = await get('/admin/api/reports?kind=custom&from=2026-09-15&to=2026-09-01');
  ok('custom backwards → 400', g.status === 400);
  g = await get('/admin/api/reports?kind=custom&from=2025-01-01&to=2026-09-01');
  ok('custom over 400 days → 400', g.status === 400);
  g = await get('/admin/api/reports?kind=day&date=2026-02-30');
  ok('impossible date → 400', g.status === 400);

  await post('/admin/api/owner-alerts/settings', { summaryPush: true, summaryEmail: true, emails: 'owner@example.com, partner@example.com' });
  pushes.length = 0; mails.length = 0;
  NOW = Date.parse('2026-09-15T21:15:07+05:30');
  rr = await post('/admin/api/reports/send-now', { kind: 'day' });
  ok('📨 send today\'s summary now: one push (tap opens the report) + one email to both owners', rr.body.ok && pushes.length === 1 && pushes[0].msg.title === '📊 Today: ₹702 · 4 orders (3 new) · ▲40%' && /^\/panel\?v=reports&report=day%3A2026-09-15~m211507$/.test(pushes[0].msg.url) && mails.length === 1 && mails[0].to === 'owner@example.com, partner@example.com' && /<table/.test(mails[0].html) && !!mails[0].text, { body: rr.body, push: pushes[0], to: mails[0] && mails[0].to });
  ok('…saved as a snapshot that does NOT take the scheduled guard for the day', !!T.settings['ffrep:day:2026-09-15~m211507'] && !T.settings['ffrep:day:2026-09-15'] && T.audit.some((a) => a.action === 'reports.sendNow'));
  g = await get('/admin/api/reports/history');
  ok('past summaries list', g.body.ok && g.body.list.length >= 1 && g.body.list.some((x) => x.id === 'day:2026-09-15~m211507' && x.manual && x.label === 'Tue 15 Sep 2026'), g.body.list);
  g = await get('/admin/api/reports/snapshot?id=' + encodeURIComponent('day:2026-09-15~m211507'));
  ok('snapshot opens with its sections + delivery', g.body.ok && g.body.snapshot.totals.revenue === 702 && g.body.snapshot.sections.length > 4 && g.body.snapshot.delivery.push.sent === 1 && g.body.snapshot.delivery.email.ok === true && g.body.snapshot.line === pushes[0].msg.title, g.body.snapshot && g.body.snapshot.delivery);
  g = await get('/admin/api/reports/snapshot?id=' + encodeURIComponent("x' OR 1=1"));
  ok('bad snapshot id → 404 (never queried)', g.status === 404);
  await post('/admin/api/owner-alerts/settings', { summaryPush: false, summaryEmail: false });
  pushes.length = 0; mails.length = 0; NOW += 5000;
  rr = await post('/admin/api/reports/send-now', { kind: 'week' });
  ok('summary push / email OFF → saved only', rr.body.ok && pushes.length === 0 && mails.length === 0 && /push off/.test(rr.body.message), rr.body);
  // snapshot limit
  for (let i = 0; i < 410; i++) putSetting('ffrep:day:2025-' + p2(1 + (i % 12)) + '-' + p2(1 + (i % 28)) + '~m' + String(100000 + i), '{}');
  const pruned = await reports.pruneSnapshots(fakeDb);
  ok('at most 400 snapshots kept (oldest removed)', pruned > 0 && Object.keys(T.settings).filter((k) => k.startsWith('ffrep:')).length === 400, pruned);
  ok('snapshot JSON stays small', reports.compactSnapshot(s2).length < 60000);
  g = await get('/admin/api/owner-alerts');
  ok('settings screen data: settings, default email, next times, admin devices', g.body.ok && g.body.defaultEmails.join() === 'support@fluxfilm.in' && g.body.next && g.body.adminDevices === 1, g.body);
  ok('wrong admin key → 403', (await fetch(base + '/admin/api/reports', { headers: { 'X-Admin-Key': 'no' } })).status === 403 && (await fetch(base + '/admin/api/owner-alerts/test-order', { method: 'POST', headers: { 'X-Admin-Key': 'no' } })).status === 403);
  ok('every SQL of the new code reads one table (only the two legacy Profit / Today JOINs exist)', !T.sql.some((x) => /\bJOIN\b/i.test(x) && !LEGACY_JOINS.some((re) => re.test(x))));
  server.close();

  // ==================================================================== 6. wiring
  section('admin wiring + inline scripts');
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]).filter((x) => x.trim());
  let parsed = true;
  for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline script parses', scripts.length > 0 && parsed);
  ok('📈 Reports in the side menu (after Profit) + screen + Today button', /\['reports', '📈', 'Reports'\]/.test(html) && /m\.reports = reportsView; return m;/.test(html) && /function reportsView\(/.test(html) && /id="treports"/.test(html));
  ok('Reports: Day / Week / Month / Custom tabs, charts, past summaries', /\['day', 'Day'\], \['week', 'Week'\], \['month', 'Month'\], \['custom', 'Custom dates'\]/.test(html) && /id="rpc1"/.test(html) && /id="rpc2"/.test(html) && /\/admin\/api\/reports\/history/.test(html) && /function rpOpenSnap\(/.test(html));
  ok('Notifications page: alert toggles, test alert with ka-ching, summary times, emails, send now, battery tip', /id="ownercard"/.test(html) && /💸 New paid order push/.test(html) && /✅ Credit paid push/.test(html) && /Also email me each order/.test(html) && /🔔 Test new-order alert/.test(html) && /ffBell\.play\(true\); \/\/ the in-app ka-ching/.test(html) && /'oadayt', st\.dailyTime/.test(html) && /weeklyTime: \$\('#oaweekt'\)\.value/.test(html) && /data-oasend="day"/.test(html) && /Unrestricted/.test(html));
  ok('notification taps open the order / the summary', /\/panel\?v=orders&order=FF123 opens that order/.test(html) && /openOrder\(id\)/.test(html) && /rpOpenSnap\(id\)/.test(html));
  const adminJs = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8'); const orderJs = fs.readFileSync(path.join(ROOT, 'order.js'), 'utf8'); const creditJs = fs.readFileSync(path.join(ROOT, 'credit.js'), 'utf8');
  ok('admin.js mounts adminreports', /require\('\.\/adminreports'\)\.mount\(app/.test(adminJs));
  ok('order.js alerts from _markPaid + ₹0 checkout; credit.js from Mark paid', (orderJs.match(/notifyOwnerPaid\(/g) || []).length === 3 && /creditPaidLater\(id, r\.received\)/.test(creditJs));
  ok('package.json runs this test', /node test\/owner-reports\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('THREW', e); process.exit(1); });
