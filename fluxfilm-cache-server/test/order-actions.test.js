/* Admin actions for stuck orders: fulfil / re-fulfil, deliver manually, refund, erase. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (v) => JSON.parse(JSON.stringify(v));
const noTable = (t) => { const e = new Error("Table 'u." + t + "' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };

// ---------------------------------------------------------------- in-memory MySQL (only the SQL these paths use)
let S;
function fresh() {
  S = {
    orders: [], subs: [], credits: [], couponUsage: [], spends: [], ledger: [], wallet: [], rewards: [], referrals: [], settings: {}, coupons: [], todos: [],
    audits: [], sql: [], locks: 0, released: 0, commits: 0, rollbacks: 0, failDeleteOrder: false,
  };
}
const TABLES = ['orders', 'subs', 'credits', 'couponUsage', 'spends', 'ledger', 'wallet', 'rewards', 'referrals', 'settings', 'coupons', 'todos'];
const CREDIT_EVENTS = ['REFUND_CREDIT', 'CREDIT_SPEND', 'CREDIT_RELEASE'];
const snap = () => clone(TABLES.reduce((o, k) => { o[k] = S[k]; return o; }, {}));
const restore = (x) => { for (const k of TABLES) S[k] = x[k]; };
const order = (id) => S.orders.find((o) => o.order_id === id);
const walletOf = (ph) => S.wallet.find((w) => w.phone_norm === ph);

function run(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  S.sql.push(sql);
  if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
  let m;
  if (/^INSERT INTO audit_log/.test(sql)) { S.audits.push({ action: p[0], entity: p[1], id: p[2], summary: p[3], details: p[4] }); return { affectedRows: 1 }; }
  if (/^SELECT GET_LOCK/.test(sql)) { S.locks++; return [{ l: 1 }]; }
  if (/^SELECT RELEASE_LOCK/.test(sql)) { S.released++; return [{ l: 1 }]; }
  // orders
  if (/^SELECT \* FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, service, plan, final_amount, status, fulfillment_status, order_type, renew_sub_id, source(, phone_norm, raw_json)? FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT fulfillment_status, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if ((m = sql.match(/^UPDATE orders SET (.+), raw_json = \? WHERE order_id = \? LIMIT 1$/))) {
    const o = order(p[p.length - 1]); if (!o) return { affectedRows: 0 };
    let i = 0;
    for (const part of m[1].split(', ')) { const mm = part.match(/^`(\w+)` = (\?|NOW\(\))$/); if (!mm) throw new Error('bad set: ' + part); o[mm[1]] = mm[2] === '?' ? p[i++] : '2026-09-15 12:00:00'; }
    o.raw_json = p[i]; return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET raw_json = \? WHERE order_id = \? LIMIT 1$/.test(sql)) { const o = order(p[1]); if (o) o.raw_json = p[0]; return { affectedRows: o ? 1 : 0 }; }
  if (/^SELECT order_id, created_at_sheet, service, plan, status, fulfillment_status, final_amount, discount, currency, raw_json FROM orders WHERE phone_norm = \? ORDER BY created_at_sheet DESC LIMIT \?$/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0]).map(clone);
  if (/^DELETE FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) { if (S.failDeleteOrder) return { affectedRows: 0 }; const n = S.orders.length; S.orders = S.orders.filter((o) => o.order_id !== p[0]); return { affectedRows: n - S.orders.length }; }
  // subscriptions
  if (/^SELECT \* FROM subscriptions WHERE order_id = \? FOR UPDATE$/.test(sql)) return S.subs.filter((x) => x.order_id === p[0]).map(clone);
  if (/^SELECT sub_id, status, fulfillment_status, start_date, source, login_id, inventory_ref, account_id, profile_name, profile_number FROM subscriptions WHERE order_id = \?$/.test(sql)) return S.subs.filter((x) => x.order_id === p[0]).map(clone);
  if (/^SELECT 1 FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(() => ({ 1: 1 }));
  if (/^UPDATE subscriptions SET status = 'CANCELLED', fulfillment_status = 'REFUNDED'/.test(sql)) { const x = S.subs.find((y) => y.sub_id === p[p.length - 1]); if (x) { x.status = 'CANCELLED'; x.fulfillment_status = 'REFUNDED'; if (p.length > 1) x.raw_json = p[0]; } return { affectedRows: x ? 1 : 0 }; }
  if (/^UPDATE subscriptions SET status = 'ACTIVE', fulfillment_status = 'FULFILLED', login_id = \?/.test(sql)) { const x = S.subs.find((y) => y.sub_id === p[p.length - 1]); Object.assign(x, { status: 'ACTIVE', fulfillment_status: 'FULFILLED', login_id: p[0], password: p[1], profile_name: p[2], profile_pin: p[3], inventory_ref: p[5], expiry_date: p[8] }); return { affectedRows: 1 }; }
  if (/^INSERT INTO subscriptions/.test(sql)) { S.subs.push({ sub_id: p[0], order_id: p[1], phone_norm: p[3], service: p[5], plan: p[6], duration_days: p[7], start_date: p[8], expiry_date: p[9], status: 'ACTIVE', fulfillment_status: 'FULFILLED', inventory_ref: p[10], account_id: p[11], login_id: p[12], password: p[13], profile_number: p[14], profile_name: p[15], profile_pin: p[16], device_count: p[18], release_eligible_at: p[20], notes: p[21] }); return { affectedRows: 1 }; }
  if (/^DELETE FROM subscriptions WHERE order_id = \? AND COALESCE\(login_id, ''\) = ''/.test(sql)) { const n = S.subs.length; S.subs = S.subs.filter((x) => !(x.order_id === p[0] && !x.login_id && String(x.fulfillment_status || '').toUpperCase() !== 'FULFILLED')); return { affectedRows: n - S.subs.length }; }
  // bank credits / coupons / claims / settings
  if (/^SELECT \* FROM bank_credits WHERE consumed_order_id = \? FOR UPDATE$/.test(sql)) return S.credits.filter((c) => c.consumed_order_id === p[0]).map(clone);
  if (/^UPDATE bank_credits SET consumed_order_id = NULL WHERE consumed_order_id = \?$/.test(sql)) { let n = 0; for (const c of S.credits) if (c.consumed_order_id === p[0]) { c.consumed_order_id = null; n++; } return { affectedRows: n }; }
  if (/^SELECT \* FROM coupon_usage WHERE order_id = \?$/.test(sql)) return S.couponUsage.filter((c) => c.order_id === p[0]).map(clone);
  if (/^UPDATE coupon_usage SET action = 'RELEASED'/.test(sql)) { let n = 0; for (const c of S.couponUsage) if (c.order_id === p[0] && String(c.action).toUpperCase() === 'USED') { c.action = 'RELEASED'; n++; } return { affectedRows: n }; }
  if (/payment_claims/.test(sql)) noTable('payment_claims');
  if (/refund_offers/.test(sql)) noTable('refund_offers'); // Refunds v3 offers: covered in refunds-v3.test.js (before schema-v26 here)
  if (/^SELECT setting_key FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return S.settings[p[0]] ? [{ setting_key: p[0] }] : [];
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE/.test(sql)) { S.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return S.settings[p[0]] ? [{ value: S.settings[p[0]] }] : [];
  // coins
  if (/^SELECT order_id, phone_norm, coins, status FROM coin_spends WHERE order_id = \? AND status IN \('HELD', 'SPENT'\) LIMIT 1 FOR UPDATE$/.test(sql)) return S.spends.filter((x) => x.order_id === p[0] && ['HELD', 'SPENT'].includes(x.status)).map(clone);
  if (/^SELECT \* FROM coin_spends WHERE order_id = \?$/.test(sql)) return S.spends.filter((x) => x.order_id === p[0]).map(clone);
  if (/^UPDATE coin_spends SET status = 'RELEASED', note = \?, updated_at = NOW\(\) WHERE order_id = \? AND status = \?$/.test(sql)) { const x = S.spends.find((y) => y.order_id === p[1] && y.status === p[2]); if (x) { x.status = 'RELEASED'; x.note = p[0]; } return { affectedRows: x ? 1 : 0 }; }
  if (/^SELECT event, phone_norm, coins_delta FROM coins_ledger WHERE order_id = \? AND event IN/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && ['NEW_PURCHASE', 'RENEW', 'EARN_REVERSE'].includes(l.event)).map(clone);
  if (/^SELECT \* FROM coins_ledger WHERE order_id = \?$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0]).map(clone);
  if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = 'REFUND' LIMIT 1$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && l.event === 'REFUND').map((l, i) => ({ id: i + 1 }));
  // refund credit pot (coins.js)
  if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = 'REFUND_CREDIT' LIMIT 1$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && l.event === 'REFUND_CREDIT').map((l, i) => ({ id: i + 1 }));
  if (/^SELECT COALESCE\(SUM\(coins_delta\), 0\) AS n FROM coins_ledger WHERE phone_norm = \? AND event IN \('REFUND_CREDIT', 'CREDIT_SPEND', 'CREDIT_RELEASE'\)$/.test(sql)) return [{ n: S.ledger.filter((l) => l.phone_norm === p[0] && CREDIT_EVENTS.includes(l.event)).reduce((n, l) => n + l.coins_delta, 0) }];
  if (/^SELECT event, coins_delta FROM coins_ledger WHERE order_id = \? AND event IN \('CREDIT_SPEND', 'CREDIT_RELEASE'\) ORDER BY id$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && ['CREDIT_SPEND', 'CREDIT_RELEASE'].includes(l.event)).map(clone);
  // refund coupons + to-dos + customer refund reads (refunds.js)
  if (/^SELECT raw_json FROM coupons$/.test(sql)) return S.coupons.map((c) => ({ raw_json: c.raw_json }));
  if (/^SELECT COUNT\(\*\) n, SUM\(phone_norm = \?\) mine FROM coupon_usage WHERE UPPER\(action\)='USED' AND UPPER\(coupon_code\)=\?$/.test(sql)) { const rows = S.couponUsage.filter((c) => String(c.action).toUpperCase() === 'USED' && String(c.coupon_code).toUpperCase() === p[1]); return [{ n: rows.length, mine: rows.filter((c) => c.phone_norm === p[0]).length }]; }
  if (/^SELECT code FROM coupons WHERE code = \? LIMIT 1$/.test(sql)) return S.coupons.filter((c) => c.code === p[0]).map(clone);
  if (/^INSERT INTO coupons \(code, description, scope, type, value, min_amount, max_discount, expiry, per_user_limit, global_limit, active, show_in_profile, allowed_phones, first_time_only, raw_json\)/.test(sql)) { S.coupons.push({ code: p[0], description: p[1], scope: p[2], type: p[3], value: p[4], min_amount: p[5], max_discount: p[6], expiry: p[7], per_user_limit: p[8], global_limit: p[9], active: p[10], show_in_profile: p[11], allowed_phones: p[12], first_time_only: p[13], raw_json: p[14] }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, service, plan, name, email, phone, phone_norm, status, final_amount, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT order_id, service, plan, final_amount, status, raw_json FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'REFUNDED'/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0] && String(o.status).toUpperCase() === 'REFUNDED').map(clone);
  if (/^INSERT INTO admin_todos \(title, note\) VALUES \(\?, \?\)$/.test(sql)) { const id = S.todos.length + 1; S.todos.push({ id, title: p[0], note: p[1], done: 0 }); return { affectedRows: 1, insertId: id }; }
  if (/^UPDATE admin_todos SET done = \?, done_at = (NOW\(\)|NULL) WHERE id = \? LIMIT 1$/.test(sql)) { const t = S.todos.find((x) => x.id === p[1]); if (t) t.done = p[0]; return { affectedRows: t ? 1 : 0 }; }
  if (/^SELECT id, title, note FROM admin_todos WHERE id = \? LIMIT 1$/.test(sql)) return S.todos.filter((x) => x.id === p[0]).map(clone);
  if (/FROM customers/.test(sql)) throw new Error('refunds must never read the customers profile email: ' + sql);
  if (/^SELECT order_id, email, status, raw_json FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'REFUNDED'/.test(sql)) return S.orders.filter((o) => o.phone_norm === p[0] && String(o.status).toUpperCase() === 'REFUNDED').map(clone);
  if (/^UPDATE admin_todos SET done = 1, done_at = NOW\(\) WHERE id = \? AND done = 0 LIMIT 1$/.test(sql)) { const t = S.todos.find((x) => x.id === p[0] && !x.done); if (t) t.done = 1; return { affectedRows: t ? 1 : 0 }; }
  if (/^INSERT INTO coins_ledger/.test(sql)) { S.ledger.push({ event: p[0], order_id: p[1], phone_norm: p[2], coins_delta: p[6], balance_after: p[7], note: p[8] }); return { affectedRows: 1 }; }
  if (/^SELECT phone, coins_balance FROM wallet WHERE phone_norm = \? ORDER BY coins_lifetime DESC, coins_balance DESC LIMIT 1 FOR UPDATE$/.test(sql)) return S.wallet.filter((w) => w.phone_norm === p[0]).map(clone);
  if (/^INSERT IGNORE INTO wallet/.test(sql)) { if (!walletOf(p[1])) S.wallet.push({ phone: p[0], phone_norm: p[1], coins_balance: 0, coins_lifetime: 0 }); return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance \+ \? WHERE phone = \?$/.test(sql)) { const w = S.wallet.find((x) => x.phone === p[1]); w.coins_balance += p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance - \?, coins_lifetime = GREATEST/.test(sql)) { const w = S.wallet.find((x) => x.phone === p[2]); w.coins_balance -= p[0]; w.coins_lifetime = Math.max(0, w.coins_lifetime - p[1]); return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance \+ \?, last_event = \? WHERE phone = \?$/.test(sql)) { const w = S.wallet.find((x) => x.phone === p[2]); w.coins_balance += p[0]; return { affectedRows: 1 }; }
  // referrals
  if (/^SELECT beneficiary_phone, kind, coins, status FROM referral_rewards WHERE order_id = \? FOR UPDATE$/.test(sql)) return S.rewards.filter((r) => r.order_id === p[0]).map(clone);
  if (/^SELECT \* FROM referral_rewards WHERE order_id = \?$/.test(sql)) return S.rewards.filter((r) => r.order_id === p[0]).map(clone);
  if (/^UPDATE referral_rewards SET status = 'CANCELLED'/.test(sql)) { let n = 0; for (const r of S.rewards) if (r.order_id === p[1] && ['PENDING', 'FAILED'].includes(r.status)) { r.status = 'CANCELLED'; r.reason = p[0]; n++; } return { affectedRows: n }; }
  if (/^SELECT \* FROM referrals WHERE friend_order_id = \?$/.test(sql)) return S.referrals.filter((r) => r.friend_order_id === p[0]).map(clone);
  if (/^UPDATE referrals SET status = 'PENDING', friend_order_id = NULL/.test(sql)) { let n = 0; for (const r of S.referrals) if (r.friend_order_id === p[0] && ['REWARDED', 'CAPPED'].includes(r.status)) { Object.assign(r, { status: 'PENDING', friend_order_id: null, reward_coins: 0 }); n++; } return { affectedRows: n }; }
  throw new Error('fake db: unhandled SQL: ' + sql);
}
// One transaction at a time (a coarse stand-in for InnoDB row locks), so parallel requests really race for the same row.
let txQueue = Promise.resolve();
function makeConn() {
  let done = null; let snapv = null;
  const finish = () => { if (done) { const d = done; done = null; d(); } };
  const c = {
    query: async (sql, p) => { const r = run(sql, p); return [r]; },
    beginTransaction: async () => { const prev = txQueue; let d; txQueue = new Promise((res) => { d = res; }); await prev; done = d; snapv = snap(); },
    commit: async () => { S.commits++; snapv = null; finish(); },
    rollback: async () => { S.rollbacks++; if (snapv) restore(snapv); snapv = null; finish(); },
    release: () => {},
  };
  return c;
}
const conn = makeConn();
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => ({ getConnection: async () => makeConn(), query: async (sql, p) => [run(sql, p)] }), ping: async () => ({ ok: true }) };

// ---------------------------------------------------------------- fixtures
const PH = '6281151936', REF = '9812345678';
function stuckOrder(extra) {
  return Object.assign({
    order_id: 'FF4642239', created_at_sheet: '2026-08-08 20:10:46', name: 'Yugandhar', email: 'y@x.com', phone: PH, phone_norm: PH,
    service: 'Zee5 Premium', plan: '1 Month', duration_days: 30, final_amount: '89.00', status: 'PAID', fulfillment_status: 'FAILED',
    order_type: null, renew_sub_id: null, source: null, device_count: null, tv_count: null, extra_field_value: null, raw_json: { OrderID: 'FF4642239', Status: 'PAID' },
  }, extra || {});
}
const rawOrder = (id) => { const r = order(id).raw_json; return typeof r === 'string' ? JSON.parse(r) : r; };

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const actions = require('../adminorderactions');
  const coins = require('../coins');
  const referrals = require('../referrals');

  section('decide(): which actions fit which order');
  const d = (o, subs) => actions.decide(Object.assign({ status: 'PAID', fulfillment_status: 'FAILED', source: 'node', final_amount: 89 }, o), subs || []);
  let x = d({});
  ok('paid + failed: re-fulfil, manual, refund, erase all allowed', x.fulfil.allowed && x.fulfil.label === '🔁 Re-fulfil' && x.manual.allowed && x.refund.allowed && x.refund.maxAmount === 89 && x.erase.allowed, x);
  ok('paid + pending: button says Fulfil now', d({ fulfillment_status: 'PENDING' }).fulfil.label === '▶️ Fulfil now');
  x = d({ fulfillment_status: 'FULFILLED' });
  ok('delivered: nothing allowed (refund/erase explain why)', !x.fulfil.allowed && !x.manual.allowed && !x.refund.allowed && !x.erase.allowed && /already delivered/i.test(x.refund.reason), x);
  x = d({ fulfillment_status: 'FAILED' }, [{ sub_id: 'S1', fulfillment_status: '', login_id: 'acc@x' }]);
  ok('a subscription row with a login counts as delivered even if the order says FAILED', x.delivered && !x.erase.allowed && !x.refund.allowed, x);
  x = d({ status: 'CREATED', fulfillment_status: 'PENDING' });
  ok('unpaid: only erase (no fulfil / refund / manual)', !x.fulfil.allowed && !x.refund.allowed && !x.manual.allowed && x.erase.allowed, x);
  x = d({ status: 'REFUNDED', fulfillment_status: 'REFUNDED' });
  ok('refunded: nothing more, erase keeps the refund record', x.refunded && !x.fulfil.allowed && !x.refund.allowed && !x.erase.allowed && /record/.test(x.erase.reason), x);
  x = d({ fulfillment_status: 'MANUAL_PENDING' }, [{ sub_id: 'S2', fulfillment_status: 'MANUAL_PENDING', login_id: '' }]);
  ok('manual plan waiting: no auto fulfil, manual + refund + erase allowed', !x.fulfil.allowed && x.manual.allowed && x.refund.allowed && x.erase.allowed, x);
  x = d({ source: null, order_type: 'RENEW', renew_sub_id: 'SUB-1' });
  ok('old-site renewal: no auto fulfil and no manual (renewals extend a sub)', !x.fulfil.allowed && !x.manual.allowed && x.refund.allowed, x);
  x = d({ source: null });
  ok('old-site NEW order: fulfil allowed (legacy flag set)', x.fulfil.allowed && x.legacy, x);
  // Shared delivered rule (delivered.js, bug 15 Sep 2026: YouTube invite had no Offer refund).
  x = d({ fulfillment_status: 'FAILED' }, [{ sub_id: 'S3', status: 'ACTIVE', fulfillment_status: 'FAILED', login_id: '', start_date: '2026-09-01 10:00:00', source: 'node' }]);
  ok('FAILED row with no login → not delivered: undelivered 💸 Refund still allowed, no offer', !x.delivered && x.refund.allowed && x.erase.allowed && !x.offer.allowed, x);
  x = d({ fulfillment_status: 'MANUAL_PENDING' }, [{ sub_id: 'S4', status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING', login_id: '', start_date: '2026-09-01 10:00:00', source: 'node' }]);
  ok('MANUAL_PENDING row (has a start date, no login) → not delivered', !x.delivered && x.refund.allowed, x);
  x = d({ fulfillment_status: 'FULFILLED', source: null }, [{ sub_id: 'S5', status: 'ACTIVE', fulfillment_status: null, login_id: null, profile_number: 'MIG_YT', start_date: '2026-09-01 10:00:00', source: null }]);
  ok('YouTube family invite (profile only) → delivered: offer allowed, undelivered refund / erase refused', x.delivered && x.offer.allowed && !x.refund.allowed && !x.erase.allowed, x);
  x = d({ fulfillment_status: '', source: null }, [{ sub_id: 'S6', status: 'ACTIVE', fulfillment_status: '', login_id: '', start_date: '2026-08-20 10:00:00', source: null }]);
  ok('old-site import (empty fulfilment, ACTIVE, start date) → delivered', x.delivered && x.offer.allowed && !x.fulfil.allowed, x);
  const del = require('../delivered').isDeliveredSub;
  ok('delivered.js rule table', del({ fulfillment_status: 'delivered' }) && del({ fulfillment_status: 'Completed' }) && del({ status: 'PENDING', fulfillment_status: 'PENDING', inventory_ref: 'YT-01' }) && del({ status: 'EXPIRED', start_date: '2026-07-01', source: '' }) &&
    !del({ status: 'ACTIVE', fulfillment_status: 'CREATED', start_date: '2026-09-01' }) && !del({ status: 'ACTIVE', fulfillment_status: 'PENDING', start_date: '2026-09-01' }) && !del({ status: 'ACTIVE', fulfillment_status: '', start_date: '' }) &&
    !del({ status: 'ACTIVE', fulfillment_status: '', start_date: '2026-09-01', source: 'node' }) && !del({ status: 'CANCELLED', fulfillment_status: '', start_date: '2026-09-01' }));

  // ---------------------------------------------------------------- HTTP
  const express = require('express');
  const admin = require('../admin');
  let fulfilMode = 'NO_STOCK'; const fulfilCalls = [];
  const fakeFulfill = {
    fulfillForAdmin: async (id, opts) => {
      fulfilCalls.push({ id, opts });
      const o = order(id);
      if (fulfilMode === 'NO_STOCK') { o.fulfillment_status = 'FAILED'; return { ok: true, found: true, orderId: id, fulfillment: 'NO_STOCK', message: '😔 No account available for this duration right now.' }; }
      o.fulfillment_status = 'FULFILLED';
      S.subs.push({ sub_id: 'SUB-000000777', order_id: id, status: 'ACTIVE', fulfillment_status: 'FULFILLED', login_id: 'z5@x', password: 'pw' });
      return { ok: true, found: true, orderId: id, fulfillment: 'FULFILLED', message: '✅ Your access is ready!', access: { user: 'z5@x', pass: 'pw' } };
    },
  };
  const mails = [], pushes = [], awards = [];
  const fakeCoins = Object.assign({}, coins, { getSettings: async () => ({ coinValue: 1 }), awardCoins: async (p) => { awards.push(p); return { ok: true }; } });
  const catalog = { getStockLevels: async () => ({ ok: true, levels: { 'Zee5 Premium|||1 Month': { stock: 0, stockLevel: 'OUT', source: 'inventory' } } }) };
  const app = express(); app.use(express.json());
  const fakeMailer = { send: async (to, subj, html) => { mails.push({ to, subj, html }); return { ok: true }; }, sendAccessEmail: async (p) => { mails.push({ to: p.email, access: p.access }); return { ok: true }; } };
  const fakePush = { sendToPhone: async (ph, msg) => { pushes.push({ ph, msg }); return { ok: true }; }, sendToAdmins: async (msg) => { pushes.push({ admin: true, msg }); return { ok: true }; } };
  const codeSends = [];
  // Token 'good-<phone>' = this device verified y@x.com; 'good-<phone>|other@x.com' = verified another email.
  const fakeOtp = {
    tokenMatcher: (t, ph) => (String(t).split('|')[0] === 'good-' + ph ? (em) => em === (String(t).split('|')[1] || 'y@x.com') : null),
    sendEmailCode: async (kind, ph, em, o) => { const eligible = await o.eligible(ph, (x) => x === em); codeSends.push({ kind, ph, em, tool: o.tool, eligible }); return eligible ? { ok: true } : { ok: false, noActive: true, message: o.noMessage }; },
    verifyEmailCode: async (kind, ph, em, code, o) => ({ ok: await o.eligible(ph, (x) => x === em) }),
  };
  const R = require('../refunds').create({ db: mockDb, coins: fakeCoins, push: fakePush, mailer: fakeMailer, otpaccess: fakeOtp });
  admin.mountAdmin(app, {
    db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'),
    home: { refunds: R },
    orderActions: {
      fulfill: fakeFulfill, coins: fakeCoins, referrals, catalog, refunds: R,
      mailer: fakeMailer,
      push: fakePush,
      pushreminders: { notifyDelivered: async (p) => { pushes.push({ ph: p.phone, delivered: true }); return { ok: true }; } },
    },
  });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const r = await fetch(base + p, { headers: h || H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, body, h) => { const r = await fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const tick = () => new Promise((r) => setTimeout(r, 30));

  section('auth required on every action');
  fresh(); S.orders.push(stuckOrder());
  const noKey = { 'Content-Type': 'application/json' };
  const denied = [await get('/admin/api/order/actions?id=FF4642239', noKey), await post('/admin/api/order/fulfil', { orderId: 'FF4642239' }, noKey), await post('/admin/api/order/manual-deliver', { orderId: 'FF4642239', login: 'a' }, noKey), await post('/admin/api/order/refund', { orderId: 'FF4642239', method: 'UPI' }, noKey), await post('/admin/api/order/erase', { orderId: 'FF4642239', confirm: 'FF4642239', reason: 'x' }, noKey)];
  ok('no admin key → 403 needLogin on all 5 routes, nothing written', denied.every((r) => r.status === 403 && r.body.needLogin) && order('FF4642239').status === 'PAID' && !fulfilCalls.length && !S.locks, denied.map((r) => r.status));
  const cross = await post('/admin/api/order/refund', { orderId: 'FF4642239', method: 'UPI' }, Object.assign({ Origin: 'https://evil.example' }, H));
  ok('cross-site POST refused', cross.status === 403 && order('FF4642239').status === 'PAID');

  section('actions endpoint (the stuck live order: old-site Zee5, FAILED)');
  let r = await get('/admin/api/order/actions?id=ff4642239');
  ok('lists Re-fulfil / manual / refund / erase with last error + stock', r.body.ok && r.body.actions.fulfil.allowed && r.body.actions.fulfil.label === '🔁 Re-fulfil' && r.body.actions.erase.allowed && /no stock/i.test(r.body.lastError) && r.body.stock.stockLevel === 'OUT', r.body);
  ok('unknown order → 404', (await get('/admin/api/order/actions?id=FF0000000')).status === 404);

  section('fulfil: still no stock, then re-fulfil succeeds');
  r = await post('/admin/api/order/fulfil', { orderId: 'FF4642239' });
  ok('no stock: ok, not delivered, message + stock returned', r.body.ok && r.body.delivered === false && r.body.fulfillment === 'NO_STOCK' && r.body.stock.stock === 0, r.body);
  ok('old-site order delivered with allowLegacy', fulfilCalls[0].opts && fulfilCalls[0].opts.allowLegacy === true, fulfilCalls);
  ok('last error saved in raw_json (typed FAILED kept in step)', /No account available/.test(rawOrder('FF4642239').LastFulfilError) && rawOrder('FF4642239').FulfillmentStatus === 'FAILED', rawOrder('FF4642239'));
  r = await get('/admin/api/order/actions?id=FF4642239');
  ok('actions now show the real last error', /No account available/.test(r.body.lastError), r.body.lastError);
  fulfilMode = 'OK';
  r = await post('/admin/api/order/fulfil', { orderId: 'FF4642239' });
  ok('stock added: re-fulfil delivers', r.body.ok && r.body.delivered && r.body.refulfilled && r.body.fulfillment === 'FULFILLED', r.body);
  ok('raw_json marks Refulfilled + FULFILLED', rawOrder('FF4642239').Refulfilled === true && !!rawOrder('FF4642239').RefulfilledAt && rawOrder('FF4642239').FulfillmentStatus === 'FULFILLED' && order('FF4642239').fulfillment_status === 'FULFILLED', rawOrder('FF4642239'));
  ok('change log: order.refulfil', S.audits.some((a) => a.action === 'order.refulfil' && /FULFILLED/.test(a.summary)), S.audits);
  const callsBefore = fulfilCalls.length;
  r = await post('/admin/api/order/fulfil', { orderId: 'FF4642239' });
  ok('idempotent: second tap says already delivered, fulfilment not run again', r.body.ok && r.body.already && fulfilCalls.length === callsBefore, r.body);
  r = await post('/admin/api/order/refund', { orderId: 'FF4642239', method: 'UPI' });
  ok('refund of a delivered order refused (409), order untouched', r.status === 409 && order('FF4642239').status === 'PAID', r.body);
  r = await post('/admin/api/order/erase', { orderId: 'FF4642239', confirm: 'FF4642239', reason: 'test' });
  ok('erase of a delivered order refused (409), nothing deleted or backed up', r.status === 409 && !!order('FF4642239') && !Object.keys(S.settings).length, r.body);
  const readsOrders = require('../reads');
  const list = await readsOrders.getCustomerOrders(PH, 15).catch((e) => ({ err: e.message }));
  ok('storefront order list: re-delivered flag', list.ok && list.orders[0].redelivered === true, list);

  section('fulfil guards');
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF1', status: 'CREATED', fulfillment_status: 'PENDING', source: 'node' }), stuckOrder({ order_id: 'FF2', fulfillment_status: 'MANUAL_PENDING', source: 'node' }), stuckOrder({ order_id: 'FF3', order_type: 'RENEW', renew_sub_id: 'SUB-1' }), stuckOrder({ order_id: 'FF4', status: 'REFUNDED', fulfillment_status: 'REFUNDED' }));
  const n0 = fulfilCalls.length;
  const g = [await post('/admin/api/order/fulfil', { orderId: 'FF1' }), await post('/admin/api/order/fulfil', { orderId: 'FF2' }), await post('/admin/api/order/fulfil', { orderId: 'FF3' }), await post('/admin/api/order/fulfil', { orderId: 'FF4' }), await post('/admin/api/order/fulfil', { orderId: 'FF9' })];
  ok('unpaid / manual / old-site renewal / refunded → 409, unknown → 404; fulfilment never called', g.slice(0, 4).every((y) => y.status === 409) && g[4].status === 404 && fulfilCalls.length === n0 && /not paid/.test(g[0].body.message) && /Old-site renewal/.test(g[2].body.message), g.map((y) => [y.status, y.body.message]));

  section('refund: coins, referral, coupon, bank credit, audit');
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF5', source: 'node', coupon_code: 'SAVE10', raw_json: JSON.stringify({ OrderID: 'FF5', Status: 'PAID' }) }));
  S.credits.push({ id: 7, upi_ref: '123456789012', amount: 89, consumed_order_id: 'FF5' });
  S.couponUsage.push({ order_id: 'FF5', coupon_code: 'SAVE10', action: 'USED' });
  S.spends.push({ order_id: 'FF5', phone_norm: PH, coins: 30, rupees: 30, status: 'SPENT' });
  S.wallet.push({ phone: PH, phone_norm: PH, coins_balance: 10, coins_lifetime: 100 });
  S.rewards.push({ order_id: 'FF5', beneficiary_phone: REF, kind: 'FIRST', coins: 15, status: 'FAILED' }, { order_id: 'FF5', beneficiary_phone: '9000000001', kind: 'LEVEL2', coins: 5, status: 'PAID' });
  S.referrals.push({ id: 1, referrer_phone: REF, friend_phone: PH, status: 'REWARDED', friend_order_id: 'FF5', reward_coins: 15 });
  r = await post('/admin/api/order/refund', { orderId: 'FF5', method: 'UPI', reference: 'UTR998877', note: 'no stock' });
  const o5 = order('FF5'); const raw5 = rawOrder('FF5');
  ok('refund ok', r.body.ok && r.body.status === 'REFUNDED' && r.body.amount === 89, r.body);
  ok('typed columns AND raw_json both say REFUNDED', o5.status === 'REFUNDED' && o5.fulfillment_status === 'REFUNDED' && raw5.Status === 'REFUNDED' && raw5.FulfillmentStatus === 'REFUNDED', { o5, raw5 });
  ok('raw_json keeps amount / method / ref / note / date', raw5.RefundAmount === 89 && raw5.RefundMethod === 'UPI' && raw5.RefundRef === 'UTR998877' && raw5.RefundNote === 'no stock' && /^2026|^\d{4}-/.test(raw5.RefundedAt) && raw5.OrderID === 'FF5', raw5);
  ok('coins used on the order go back (SPENT → RELEASED, wallet +30, ledger SPEND_RELEASE)', S.spends[0].status === 'RELEASED' && walletOf(PH).coins_balance === 40 && S.ledger.some((l) => l.event === 'SPEND_RELEASE' && l.coins_delta === 30), { spends: S.spends, wallet: S.wallet, ledger: S.ledger });
  ok('unpaid referral reward cancelled; paid one kept and reported', S.rewards[0].status === 'CANCELLED' && S.rewards[1].status === 'PAID' && r.body.holds.referral.alreadyPaid.length === 1 && r.body.notes.some((n) => /already paid: 5 coins to 90••••••01/.test(n)), { rewards: S.rewards, notes: r.body.notes });
  ok('invite goes back to PENDING (no FIRST reward was paid)', S.referrals[0].status === 'PENDING' && S.referrals[0].friend_order_id === null, S.referrals);
  ok('coupon use released; bank credit stays consumed (money was received)', S.couponUsage[0].action === 'RELEASED' && S.credits[0].consumed_order_id === 'FF5', { c: S.couponUsage, b: S.credits });
  ok('one transaction under the allocation lock, committed and lock released', S.locks === 1 && S.released === 1 && S.commits === 1 && S.rollbacks === 0, S);
  ok('change log: order.refund with amount + method', S.audits.some((a) => a.action === 'order.refund' && /₹89 by UPI \(UTR998877\)/.test(a.summary)), S.audits);
  await tick();
  ok('customer told by push + email (fire-and-forget)', pushes.some((p) => p.ph === PH && /Refund/.test(p.msg.title)) && mails.some((m) => m.to === 'y@x.com' && /Refund/.test(m.subj)), { pushes, mails });
  const walletAfter = walletOf(PH).coins_balance; const ledgerN = S.ledger.length;
  r = await post('/admin/api/order/refund', { orderId: 'FF5', method: 'UPI' });
  ok('idempotent: second refund → already, nothing changes', r.body.ok && r.body.already && walletOf(PH).coins_balance === walletAfter && S.ledger.length === ledgerN, r.body);
  r = await post('/admin/api/order/fulfil', { orderId: 'FF5' });
  ok('refunded order cannot be fulfilled', r.status === 409);
  const list5 = await readsOrders.getCustomerOrders(PH, 15);
  ok('storefront order list: refund amount / method / date', list5.orders[0].status === 'REFUNDED' && list5.orders[0].refundAmount === 89 && list5.orders[0].refundMethod === 'UPI' && !!list5.orders[0].refundedAt, list5.orders[0]);

  section('refund guards and Coins method');
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF6', source: 'node' }));
  r = await post('/admin/api/order/refund', { orderId: 'FF6', method: 'UPI', amount: 500 });
  ok('amount above the order total refused and rolled back', r.status === 400 && order('FF6').status === 'PAID' && S.rollbacks === 1 && S.released === 1, { body: r.body, o: order('FF6') });
  r = await post('/admin/api/order/refund', { orderId: 'FF6', method: 'CASH' });
  ok('unknown method refused before touching anything', r.status === 400 && S.locks === 1);
  r = await post('/admin/api/order/refund', { orderId: 'FF6', method: 'Coins', amount: 50 });
  const creditOf = (ph) => S.ledger.filter((l) => l.phone_norm === ph && CREDIT_EVENTS.includes(l.event)).reduce((n, l) => n + l.coins_delta, 0);
  ok('Coins refund: partial amount → ₹50 REFUND CREDIT (separate pot), normal coins untouched, ledger REFUND_CREDIT once', r.body.ok && r.body.refundCredit === 50 && creditOf(PH) === 50 && (!walletOf(PH) || walletOf(PH).coins_balance === 0) && S.ledger.filter((l) => l.event === 'REFUND_CREDIT').length === 1 && rawOrder('FF6').RefundCredit === 50 && rawOrder('FF6').RefundCoins === 50 && rawOrder('FF6').RefundAmount === 50 && rawOrder('FF6').RefundMethod === 'Coins' && rawOrder('FF6').RefundState === 'DONE', { body: r.body, w: S.wallet, l: S.ledger });
  r = await post('/admin/api/order/refund', { orderId: 'FF6', method: 'Coins', amount: 50 });
  ok('Coins refund repeated: no second credit', r.body.already && creditOf(PH) === 50 && S.ledger.filter((l) => l.event === 'REFUND_CREDIT').length === 1);
  await tick();
  ok('Coins refund: customer told by push + email about the refund credit', pushes.some((p) => p.ph === PH && /refund credit/.test(p.msg.title)) && mails.some((m) => /refund credit/.test(m.subj)), { pushes: pushes.slice(-2), mails: mails.slice(-2) });
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF6B', source: 'node' }));
  r = await post('/admin/api/order/refund', { orderId: 'FF6B', method: 'Coins', amount: 49.5 });
  ok('Coins / coupon refunds need whole rupees (rolled back)', r.status === 400 && order('FF6B').status === 'PAID' && !S.ledger.length, r.body);
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF6C', source: 'node', final_amount: '0.00', raw_json: JSON.stringify({ OrderID: 'FF6C', FreeCheckout: true, RefundCreditUsed: 89 }) }));
  S.spends.push({ order_id: 'FF6C', phone_norm: PH, coins: 0, rupees: 89, status: 'SPENT' });
  S.ledger.push({ event: 'REFUND_CREDIT', order_id: 'FFOLD', phone_norm: PH, coins_delta: 89 }, { event: 'CREDIT_SPEND', order_id: 'FF6C', phone_norm: PH, coins_delta: -89 });
  S.wallet.push({ phone: PH, phone_norm: PH, coins_balance: 7, coins_lifetime: 7 });
  r = await post('/admin/api/order/refund', { orderId: 'FF6C', method: 'Coins' });
  ok('refunding a ₹0 order (paid with refund credit) gives the ₹89 credit back, no new credit, coins untouched', r.body.ok && r.body.amount === 0 && creditOf(PH) === 89 && walletOf(PH).coins_balance === 7 && r.body.holds.coins.creditReturned === 89 && !S.ledger.some((l) => l.event === 'SPEND_RELEASE') && S.ledger.filter((l) => l.event === 'REFUND_CREDIT').length === 1 && rawOrder('FF6C').RefundMethod === 'Other', { body: r.body, l: S.ledger });
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF7', source: 'node', status: 'CREATED', fulfillment_status: 'PENDING' }));
  r = await post('/admin/api/order/refund', { orderId: 'FF7', method: 'UPI' });
  ok('unpaid order cannot be refunded', r.status === 409 && order('FF7').status === 'CREATED', r.body);

  section('refund of a manual plan: placeholder cancelled, earned coins taken back');
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF8', source: 'node', service: 'YouTube Premium', fulfillment_status: 'MANUAL_PENDING' }));
  S.subs.push({ sub_id: 'SUB-8', order_id: 'FF8', status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING', login_id: '', raw_json: null });
  S.wallet.push({ phone: PH, phone_norm: PH, coins_balance: 3, coins_lifetime: 3 });
  S.ledger.push({ event: 'NEW_PURCHASE', order_id: 'FF8', phone_norm: PH, coins_delta: 4 });
  r = await post('/admin/api/order/refund', { orderId: 'FF8', method: 'Other', note: 'could not activate' });
  ok('placeholder subscription no longer "to activate"', r.body.ok && S.subs[0].status === 'CANCELLED' && S.subs[0].fulfillment_status === 'REFUNDED', S.subs);
  ok('earned coins taken back, never below 0 (3 of 4, 1 reported short)', walletOf(PH).coins_balance === 0 && r.body.holds.coins.reversed === 3 && r.body.holds.coins.reverseShort === 1 && S.ledger.some((l) => l.event === 'EARN_REVERSE' && l.coins_delta === -3), { w: S.wallet, h: r.body.holds });
  const again = await coins.undoOrderCoinsOn(conn, 'FF8', PH, 'again');
  ok('coins undo is idempotent (no second reverse)', again.reversed === 0 && S.ledger.filter((l) => l.event === 'EARN_REVERSE').length === 1, again);

  section('refund as a personal coupon');
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF30', source: 'node' }));
  pushes.length = 0; mails.length = 0;
  r = await post('/admin/api/order/refund', { orderId: 'FF30', method: 'Coupon' });
  const cp = S.coupons[0] || {}; const cpRaw = cp.raw_json ? JSON.parse(cp.raw_json) : {};
  ok('coupon RF + 6 chars, FLAT ₹89, typed columns AND raw_json', r.body.ok && /^RF[A-HJ-NP-Z2-9]{6}$/.test(cp.code) && cp.type === 'FLAT' && cp.value === 89 && cp.per_user_limit === 1 && cp.global_limit === 1 && cp.active === 'TRUE' && cp.allowed_phones === PH && cpRaw.Code === cp.code && cpRaw.CouponCode === cp.code && cpRaw.Value === 89 && cpRaw.Scope === 'ANY' && cpRaw.PerUserLimit === 1 && cpRaw.GlobalLimit === 1 && cpRaw.AllowedPhones === PH && cpRaw.ShowInProfile === 'TRUE' && cpRaw.Source === 'REFUND' && cpRaw.RefundOrderId === 'FF30', { cp, body: r.body });
  const days = Math.round((new Date(cp.expiry.replace(' ', 'T')) - Date.now()) / 86400e3);
  ok('coupon expires in ~180 days; order raw_json keeps the code', days >= 179 && days <= 181 && rawOrder('FF30').RefundCoupon === cp.code && rawOrder('FF30').RefundMethod === 'Coupon' && order('FF30').status === 'REFUNDED', { days, raw: rawOrder('FF30') });
  await tick();
  ok('coupon refund: push + email with the code', pushes.some((p) => p.ph === PH && p.msg.body.includes(cp.code)) && mails.some((m) => m.html && m.html.includes(cp.code)), { pushes, mails: mails.map((m) => m.subj) });
  r = await post('/admin/api/order/refund', { orderId: 'FF30', method: 'Coupon' });
  ok('coupon refund repeated: no second coupon', r.body.already && S.coupons.length === 1);
  const orderMod0 = require('../order');
  const cd1 = await orderMod0._internal.couponDiscount(cp.code, PH, 169, { action: 'NEW', service: 'Netflix', plan: 'Private 1M' }).catch((e) => ({ err: e.message }));
  ok('checkout accepts it for this phone (₹89 off, flagged as a refund coupon)', cd1.ok && cd1.discount === 89 && cd1.refundCoupon === true, cd1);
  const cd2 = await orderMod0._internal.couponDiscount(cp.code, '9000000009', 169, { action: 'NEW' }).catch((e) => ({ err: e.message }));
  ok('…but not for another phone', cd2.ok === false && /not valid for this number/.test(cd2.message), cd2);
  S.couponUsage.push({ order_id: 'FF31', coupon_code: cp.code, phone_norm: PH, action: 'USED' });
  const cd3 = await orderMod0._internal.couponDiscount(cp.code, PH, 169, { action: 'NEW' }).catch((e) => ({ err: e.message }));
  ok('…and only once (single use per phone)', cd3.ok === false && /limit/.test(cd3.message), cd3);

  section('UPI cash refund: ask the customer → coins +10% (once)');
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF40', source: 'node', final_amount: '99.00' }), stuckOrder({ order_id: 'FF41', source: 'node' }));
  pushes.length = 0; mails.length = 0;
  r = await post('/admin/api/order/refund', { orderId: 'FF40', method: 'UPI_ASK', note: 'no stock' });
  ok('UPI_ASK: REFUNDED, RefundMethod UPI_PENDING, state ASK_CUSTOMER, nothing credited', r.body.ok && order('FF40').status === 'REFUNDED' && rawOrder('FF40').RefundMethod === 'UPI_PENDING' && rawOrder('FF40').RefundState === 'ASK_CUSTOMER' && !S.ledger.length && !S.coupons.length && r.body.notes.some((n) => /109 coins/.test(n)), { body: r.body, raw: rawOrder('FF40') });
  await tick();
  ok('customer told to open FluxFilm and choose (push + email)', pushes.some((p) => p.ph === PH && /choose/.test(p.msg.body)) && mails.some((m) => /109 coins/.test(m.html)), pushes);
  r = await get('/admin/api/order/actions?id=FF40');
  ok('actions: Mark UPI refund sent offered; refund info says waiting', r.body.actions.upiDone.allowed && r.body.refund.kind === 'UPI_PENDING' && r.body.refund.state === 'ASK_CUSTOMER', r.body);
  let pend = await R.getPendingRefunds(PH);
  ok('storefront pending list: FF40 with ₹99 → 109 coins (10%)', pend.ok && pend.items.length === 1 && pend.items[0].orderId === 'FF40' && pend.items[0].credit === 109 && pend.items[0].state === 'ASK_CUSTOMER', pend);
  let cv = await R.convertToCredit('9000000009', 'FF40');
  ok('another phone cannot convert it', cv.ok === false && !S.ledger.length && rawOrder('FF40').RefundState === 'ASK_CUSTOMER', cv);
  cv = await R.convertToCredit(PH, 'FF41');
  ok('an order that is not refunded cannot be converted', cv.ok === false && !S.ledger.length, cv);
  const [c1, c2] = await Promise.all([R.convertToCredit(PH, 'FF40'), R.convertToCredit(PH, 'ff40')]);
  ok('convert: +109 refund credit exactly once even when tapped twice at the same time', c1.ok && c2.ok && [c1, c2].filter((x) => x.already).length === 1 && creditOf(PH) === 109 && S.ledger.filter((l) => l.event === 'REFUND_CREDIT').length === 1, { c1, c2, l: S.ledger });
  ok('order now Refunded as coins (+10 bonus), state DONE, not pending any more', rawOrder('FF40').RefundMethod === 'Coins' && rawOrder('FF40').RefundCredit === 109 && rawOrder('FF40').RefundBonus === 10 && rawOrder('FF40').RefundState === 'DONE' && (await R.getPendingRefunds(PH)).items.length === 0, rawOrder('FF40'));
  const up1 = await R.requestUpi(PH, 'FF40', 'rahul@okhdfcbank', 'good-' + PH);
  ok('after converting, a UPI refund can no longer be requested', up1.ok === false && !S.todos.length, up1);
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF40' });
  ok('…and the admin cannot mark a UPI refund sent', r.status === 409 && rawOrder('FF40').RefundMethod === 'Coins', r.body);
  await tick();
  ok('convert: customer told (push)', pushes.some((p) => p.ph === PH && /109 coins/.test(p.msg.title)), pushes.map((p) => p.msg.title));

  section('UPI cash refund: UPI ID → Today to-do → admin marks it sent');
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF50', source: 'node' }));
  await post('/admin/api/order/refund', { orderId: 'FF50', method: 'UPI_ASK' });
  pushes.length = 0; mails.length = 0;
  let u = await R.requestUpi(PH, 'FF50', 'rahul@okhdfcbank', '');
  ok('no email-code token → needsVerify (nothing saved), no email hint', u.ok === false && u.needsVerify === true && !('maskedEmail' in u) && !/@/.test(u.message) && !S.todos.length && rawOrder('FF50').RefundState === 'ASK_CUSTOMER', u);
  const sc = await R.sendCode(PH, 'y@x.com');
  ok('email code for refunds: the typed email is the one on the refunded order → sent', sc.ok && codeSends[0].kind === 'refund' && codeSends[0].tool === 'Refund' && codeSends[0].eligible === true, codeSends);
  const scBad = await R.sendCode(PH, 'attacker@evil.com');
  const scNone = await R.sendCode('9000000009', 'y@x.com');
  ok('any other email (e.g. a profile email someone wrote) or another phone → one generic "no"', !scBad.ok && scBad.noActive && !scNone.ok && scBad.message === scNone.message && !/y@x|\*/.test(scBad.message), { scBad, scNone });
  u = await R.requestUpi(PH, 'FF50', 'rahul@okhdfcbank', 'good-' + PH + '|attacker@evil.com');
  ok('device verified with ANOTHER email (Get OTP / Games / another order) cannot redirect this refund', u.ok === false && u.needsVerify === true && !S.todos.length && !rawOrder('FF50').RefundUpi, u);
  for (const bad of ['rahul', 'rahul@', '@okhdfc', 'rahul@o', 'rahul@@ok', 'rahul@ok-hdfc', 'r@1bank', 'rahul@okhdfcbank.com', '<b>@ybl']) {
    u = await R.requestUpi(PH, 'FF50', bad, 'good-' + PH);
    if (u.ok || u.field !== 'upi') { ok('UPI ID format refused: ' + bad, false, u); break; }
  }
  ok('bad UPI IDs refused (name@handle only)', !S.todos.length);
  u = await R.requestUpi('9000000009', 'FF50', 'thief@ybl', 'good-9000000009');
  ok('another phone (even verified) cannot redirect the refund', u.ok === false && !S.todos.length && !rawOrder('FF50').RefundUpi, u);
  u = await R.requestUpi(PH, 'FF50', 'rahul.k@okhdfcbank', 'good-' + PH);
  const todo = S.todos[0] || {};
  ok('UPI ID saved: state UPI_REQUESTED + one Today to-do with amount, UPI, order, masked phone', u.ok && rawOrder('FF50').RefundState === 'UPI_REQUESTED' && rawOrder('FF50').RefundUpi === 'rahul.k@okhdfcbank' && rawOrder('FF50').RefundTodoId === todo.id && /Send ₹89 UPI refund to rahul\.k@okhdfcbank for FF50 \(62••••••36\)/.test(todo.title) && /\[upi-refund:FF50\]/.test(todo.note) && !/6281151936/.test(todo.title), { u, todo, raw: rawOrder('FF50') });
  // Refunds v3 (owner 15 Sep): "Request received — we'll send ₹X to name@upi within 24 hours, you'll get a message when it's done".
  ok('customer sees "request received … within 24 hours" with the UPI they typed; the returned upi field stays masked', /Request received/.test(u.message) && /₹89 to rahul\.k@okhdfcbank within 24 hours/.test(u.message) && /^rah•+@okhdfcbank$/.test(u.upi), u);
  u = await R.requestUpi(PH, 'FF50', 'other@ybl', 'good-' + PH);
  ok('asking again: already requested, no second to-do, UPI not changed', u.ok && u.already && S.todos.length === 1 && rawOrder('FF50').RefundUpi === 'rahul.k@okhdfcbank', u);
  cv = await R.convertToCredit(PH, 'FF50');
  ok('after asking for UPI, converting to coins is refused (money may be on its way)', cv.ok === false && !S.ledger.length, cv);
  await tick();
  ok('customer emailed a "didn\'t ask for this?" confirmation; owner pushed', mails.some((m) => /Didn't ask for this/.test(m.html)) && pushes.some((p) => p.admin && /UPI refund to send/.test(p.msg.title)), { mails: mails.map((m) => m.subj), pushes });
  pend = await R.getPendingRefunds(PH);
  ok('pending list shows UPI_REQUESTED with masked UPI', pend.items.length === 1 && pend.items[0].state === 'UPI_REQUESTED' && /^rah•+@okhdfcbank$/.test(pend.items[0].upi), pend);
  const listU = await readsOrders.getCustomerOrders(PH, 15);
  ok('storefront order list: refundKind UPI_PENDING / state UPI_REQUESTED', listU.orders[0].refundKind === 'UPI_PENDING' && listU.orders[0].refundState === 'UPI_REQUESTED', listU.orders[0]);
  pushes.length = 0;
  r = await post('/admin/api/todos/update', { id: todo.id, done: true });
  ok('Today to-do ticked done → order Refunded to UPI, state DONE, customer told', r.body.ok && r.body.refund && r.body.refund.ok && rawOrder('FF50').RefundMethod === 'UPI' && rawOrder('FF50').RefundState === 'DONE' && !!rawOrder('FF50').RefundUpiSentAt && rawOrder('FF50').RefundCompletedVia === 'todo' && S.audits.some((a) => a.action === 'order.refundUpiSent'), { body: r.body, raw: rawOrder('FF50') });
  await tick();
  ok('UPI sent: push to the customer', pushes.some((p) => p.ph === PH && /refunded to your UPI/.test(p.msg.title)), pushes);
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF50', reference: 'UTR1' });
  ok('marking sent again → already, nothing changes', r.body.ok && r.body.already && rawOrder('FF50').RefundRef === '', r.body);
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF51', source: 'node' }));
  await post('/admin/api/order/refund', { orderId: 'FF51', method: 'UPI_ASK' });
  await R.requestUpi(PH, 'FF51', 'rahul@ybl', 'good-' + PH);
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF51', reference: 'UTR777' }, noKey);
  ok('refund-upi-done needs the admin key', r.status === 403 && rawOrder('FF51').RefundState === 'UPI_REQUESTED');
  r = await post('/admin/api/order/refund-upi-done', { orderId: 'FF51', reference: 'UTR777' });
  ok('⚡ Actions → Mark UPI refund sent: UTR kept, to-do ticked, change log', r.body.ok && rawOrder('FF51').RefundRef === 'UTR777' && rawOrder('FF51').RefundMethod === 'UPI' && S.todos[0].done === 1 && S.audits.some((a) => a.action === 'order.refundUpiSent' && /UTR777/.test(a.summary)), { body: r.body, todos: S.todos });
  const listD = await readsOrders.getCustomerOrders(PH, 15);
  ok('storefront order list: refunded to UPI', listD.orders[0].refundKind === 'UPI' && listD.orders[0].refundState === 'DONE', listD.orders[0]);

  section('erase: guards');
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF10', source: 'node' }));
  r = await post('/admin/api/order/erase', { orderId: 'FF10', confirm: 'FF1', reason: 'mistake' });
  ok('wrong confirmation refused', r.status === 400 && r.body.field === 'confirm' && !!order('FF10') && !S.locks);
  r = await post('/admin/api/order/erase', { orderId: 'FF10', confirm: 'FF10', reason: ' ' });
  ok('reason required', r.status === 400 && r.body.field === 'reason' && !!order('FF10'));
  S.subs.push({ sub_id: 'SUB-10', order_id: 'FF10', status: 'ACTIVE', fulfillment_status: 'FULFILLED', login_id: 'a@x' });
  r = await post('/admin/api/order/erase', { orderId: 'FF10', confirm: 'ff10', reason: 'mistake' });
  ok('refused when a delivered subscription exists (no backup, no delete)', r.status === 409 && !!order('FF10') && S.subs.length === 1 && !Object.keys(S.settings).length && S.rollbacks === 1, r.body);

  section('erase: marked paid by mistake');
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF11', source: 'node', raw_json: { OrderID: 'FF11', AccessTokenHash: 'abc' } }));
  S.subs.push({ sub_id: 'SUB-11', order_id: 'FF11', status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING', login_id: '' });
  S.credits.push({ id: 9, upi_ref: '555', amount: 89, consumed_order_id: 'FF11' }, { id: 10, upi_ref: '556', amount: 89, consumed_order_id: 'FF99' });
  S.spends.push({ order_id: 'FF11', phone_norm: PH, coins: 20, rupees: 20, status: 'SPENT' });
  S.wallet.push({ phone: PH, phone_norm: PH, coins_balance: 0, coins_lifetime: 50 });
  S.rewards.push({ order_id: 'FF11', beneficiary_phone: REF, kind: 'FIRST', coins: 15, status: 'PENDING' });
  r = await post('/admin/api/order/erase', { orderId: 'FF11', confirm: 'FF11', reason: 'marked paid on the wrong order' });
  ok('erase ok', r.body.ok && r.body.erased && r.body.backupKey === 'erased_order_FF11', r.body);
  const bk = S.settings.erased_order_FF11 ? JSON.parse(S.settings.erased_order_FF11) : {};
  ok('backup copy has the order (with raw_json), subscriptions, bank credit, coins, rewards', bk.order && bk.order.order_id === 'FF11' && bk.order.raw_json && bk.subscriptions.length === 1 && bk.bankCredits[0].id === 9 && bk.coinSpends[0].status === 'SPENT' && bk.referralRewards[0].status === 'PENDING' && bk.reason === 'marked paid on the wrong order', bk);
  const iBackup = S.sql.findIndex((q) => /^INSERT INTO app_settings/.test(q)); const iDelete = S.sql.findIndex((q) => /^DELETE FROM orders/.test(q));
  ok('backup written BEFORE anything is deleted', iBackup > -1 && iDelete > iBackup);
  ok('order + placeholder subscription deleted', !order('FF11') && !S.subs.some((y) => y.order_id === 'FF11'));
  ok('its bank credit is unmatched again; other credits untouched', S.credits[0].consumed_order_id === null && S.credits[1].consumed_order_id === 'FF99', S.credits);
  ok('coins back (+20), referral reward cancelled', walletOf(PH).coins_balance === 20 && S.spends[0].status === 'RELEASED' && S.rewards[0].status === 'CANCELLED', { w: S.wallet, r: S.rewards });
  ok('missing payment_claims table does not block erase', S.commits === 1 && S.rollbacks === 0);
  ok('change log: order.erase with reason + backup key, phone masked', S.audits.some((a) => a.action === 'order.erase' && /marked paid on the wrong order/.test(a.summary) && /erased_order_FF11/.test(a.summary) && /62••••••36/.test(a.summary) && !/6281151936/.test(a.summary)), S.audits);
  r = await post('/admin/api/order/erase', { orderId: 'FF11', confirm: 'FF11', reason: 'again' });
  ok('idempotent: second erase → already erased', r.body.ok && r.body.already, r.body);

  section('erase: failure rolls everything back');
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF12', source: 'node' }));
  S.credits.push({ id: 11, upi_ref: '777', amount: 89, consumed_order_id: 'FF12' });
  S.spends.push({ order_id: 'FF12', phone_norm: PH, coins: 5, rupees: 5, status: 'SPENT' });
  S.wallet.push({ phone: PH, phone_norm: PH, coins_balance: 0, coins_lifetime: 0 });
  S.failDeleteOrder = true;
  r = await post('/admin/api/order/erase', { orderId: 'FF12', confirm: 'FF12', reason: 'mistake' });
  ok('delete fails → 500, order, credit, coins and backup all as before', r.status === 500 && !!order('FF12') && S.credits[0].consumed_order_id === 'FF12' && S.spends[0].status === 'SPENT' && walletOf(PH).coins_balance === 0 && !S.settings.erased_order_FF12 && S.rollbacks === 1 && S.released === 1, { body: r.body, S: { credits: S.credits, spends: S.spends, settings: S.settings } });

  section('deliver manually');
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF13', source: null }));
  r = await post('/admin/api/order/manual-deliver', { orderId: 'FF13', login: ' ' });
  ok('login required', r.status === 400 && r.body.field === 'login');
  r = await post('/admin/api/order/manual-deliver', { orderId: 'FF13', login: 'zee@x.com', password: 'p<&>w', accountRef: 'Z5-01', note: 'added by hand' });
  const sub13 = S.subs.find((y) => y.order_id === 'FF13');
  ok('subscription created with the typed login, 30 days, on the account', r.body.ok && sub13 && sub13.login_id === 'zee@x.com' && sub13.password === 'p<&>w' && sub13.inventory_ref === 'Z5-01' && sub13.account_id === 'Z5-01' && sub13.fulfillment_status === 'FULFILLED' && sub13.duration_days === 30, { body: r.body, sub13 });
  ok('order FULFILLED; raw_json ManualDelivered + Refulfilled (was FAILED)', order('FF13').fulfillment_status === 'FULFILLED' && rawOrder('FF13').ManualDelivered === true && rawOrder('FF13').Refulfilled === true && rawOrder('FF13').FulfillmentStatus === 'FULFILLED', rawOrder('FF13'));
  await tick();
  ok('customer emailed (values HTML-escaped) + coins awarded once per order', mails.some((m) => m.to === 'y@x.com' && m.access && m.access.pass === 'p&lt;&amp;&gt;w') && awards.some((a) => a.orderId === 'FF13' && a.event === 'NEW_PURCHASE'), { mails, awards });
  const subsN = S.subs.length;
  r = await post('/admin/api/order/manual-deliver', { orderId: 'FF13', login: 'other@x.com' });
  ok('idempotent: already delivered, no second subscription', r.body.ok && r.body.already && S.subs.length === subsN);
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF14', source: 'node', fulfillment_status: 'MANUAL_PENDING' }));
  S.subs.push({ sub_id: 'SUB-14', order_id: 'FF14', status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING', login_id: '', raw_json: null });
  r = await post('/admin/api/order/manual-deliver', { orderId: 'FF14', login: 'yt@x.com', notify: false });
  ok('manual plan: fills the waiting placeholder row instead of adding one', r.body.ok && S.subs.length === 1 && S.subs[0].login_id === 'yt@x.com' && S.subs[0].fulfillment_status === 'FULFILLED' && r.body.subId === 'SUB-14', S.subs);
  fresh(); S.orders.push(stuckOrder({ order_id: 'FF15', source: 'node', order_type: 'RENEW', renew_sub_id: 'SUB-1' }));
  r = await post('/admin/api/order/manual-deliver', { orderId: 'FF15', login: 'x' });
  ok('renewal refused (extends an existing subscription)', r.status === 409 && !S.subs.length, r.body);

  server.close();

  section('checkout never revives a refunded order');
  fresh();
  S.orders.push(stuckOrder({ order_id: 'FF20', source: 'node', status: 'REFUNDED', fulfillment_status: 'REFUNDED' }));
  const extra = (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT order_id, final_amount, status, source FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
    if (/^UPDATE bank_credits SET consumed_order_id = \?/.test(sql)) { S.sql.push(sql); return { affectedRows: 1 }; }
    if (/^SELECT order_id, service, plan, name, email, phone, phone_norm, duration_days, status/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
    if (/^SELECT status, fulfillment_status FROM orders/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
    return null;
  };
  const runBase = run;
  run = (sql, p) => { const e = extra(sql, p); return e != null ? e : runBase(sql, p); }; // eslint-disable-line no-func-assign
  const orderMod = require('../order');
  const v = await orderMod.verifyPayment('FF20');
  ok('verifyPayment: refunded, no bank credit taken', v.refunded === true && v.paid === false && v.fulfillment === 'REFUNDED' && !S.sql.some((q) => /^UPDATE bank_credits SET consumed_order_id = \?/.test(q)), v);
  const vr = await orderMod.verifyPaymentByRef('FF20', '123456789012');
  ok('verifyPaymentByRef: refunded too', vr.refunded === true);
  const mp = await orderMod.adminMarkPaid('FF20', 'ADMIN-UPI');
  ok('adminMarkPaid refuses a refunded order', mp.ok === false && /refunded/.test(mp.message) && order('FF20').status === 'REFUNDED', mp);
  const ful = require('../fulfill');
  const f = await ful.fulfillForAdmin('FF20');
  ok('fulfilment returns REFUNDED (checkout stops polling)', f.fulfillment === 'REFUNDED' && f.refunded === true, f);
  S.orders.push(stuckOrder({ order_id: 'FF21', source: null, fulfillment_status: 'MANUAL_PENDING' }));
  const legacyNo = await ful.fulfillForAdmin('FF21');
  const legacyYes = await ful.fulfillForAdmin('FF21', { allowLegacy: true });
  const store = await ful.fulfillAndGetAccess('FF21', { phone: PH });
  ok('old-site order: refused without allowLegacy (storefront), allowed from admin', legacyNo.fulfillment === 'ERROR' && legacyYes.fulfillment === 'MANUAL_PENDING' && store.fulfillment === 'ERROR', { legacyNo, legacyYes, store });
  const st = await require('../account').getOrderStatus('FF20');
  ok('getOrderStatus reports refunded', st.refunded === true && st.paid === false, st);

  section('panel + storefront wiring');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const scripts = [...adminHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('admin.html scripts parse', parsed && scripts.length > 0);
  ok('order modal loads actions and calls every action route', /loadOrderActions\(o\.order_id\)/.test(adminHtml) && ['/admin/api/order/actions', '/admin/api/order/fulfil', '/admin/api/order/manual-deliver', '/admin/api/order/refund', '/admin/api/order/erase'].every((u) => adminHtml.includes("'" + u + "'")));
  ok('erase needs the typed order ID in the panel too', /oa_econfirm/.test(adminHtml) && /Erase permanently/.test(adminHtml));
  ok('Today stuck orders open the order; Customer 360 rows open it with a Fix button', /data-toid/.test(adminHtml) && /openOrder\(so\.getAttribute\('data-toid'\)\)/.test(adminHtml) && /⚡ Fix/.test(adminHtml) && /#c360 \.orow/.test(adminHtml));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const iscripts = [...idx.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.trim() && !/^\s*\{/.test(t));
  let iparsed = true; for (const sc of iscripts) { try { new Function(sc); } catch (e) { iparsed = false; console.log('   index parse error:', e.message); } }
  ok('index.html scripts parse', iparsed);
  ok('storefront: Refunded badge with UPI/Coins + no Verify button; Re-delivered note', /'💸 Refunded'/.test(idx) && /'💸 Refunded to UPI'/.test(idx) && /'💸 Refunded as coins'/.test(idx) && /!fulfilled && !refunded && React\.createElement/.test(idx) && /Re-delivered/.test(idx));
  ok('storefront: coupon / UPI requested / choose badges + button that opens the refund pop-up', /'🎟️ Refunded as coupon ' \+ \(o\.refundCoupon/.test(idx) && /'⏳ UPI refund requested'/.test(idx) && /new Event\('ff-refunds-open'\)/.test(idx) && /window\.addEventListener\('ff-refunds-open', onOpen\)/.test(idx));
  // Refunds v3: three choices (coins / coupon +bonus%, exact UPI) — details in refunds-v3.test.js.
  ok('storefront: refund pop-up offers coins / coupon (+bonus%) or exact UPI (with email code), mounted for logged-in customers', /function RefundChoice\(/.test(idx) && /🪙 Coins — ₹\$\{item\.amount\} \+ \$\{pct\}% = \$\{item\.credit\} coins \(instant\)/.test(idx) && /🏦 UPI — exact ₹\$\{item\.amount\} to your UPI/.test(idx) && /API\.refundSendCode\(ph/.test(idx) && /sessionPhone && React\.createElement\(RefundChoice, \{/.test(idx));
  ok('admin: refund dialog has Coins / Coupon / UPI ask / already sent / other + Mark UPI refund sent', ['value="Coins"', 'value="Coupon"', 'value="UPI_ASK"', 'value="UPI"', 'value="Other"'].every((v) => adminHtml.includes(v)) && adminHtml.includes("'/admin/api/order/refund-upi-done'") && /data-oa="upidone"/.test(adminHtml) && /Refund credit \(pays up to 100%\)/.test(adminHtml));
  ok('storefront checkout stops on a refunded order', /if \(r\?\.refunded\) \{ goToDone/.test(idx) && /isRefunded \? '💸 Order Refunded'/.test(idx));

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
