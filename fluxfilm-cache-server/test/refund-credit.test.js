/* Refund credit (coins.js pot that can pay 100%) + ₹0 checkout (order.js confirmFreeOrder). Run: npm test
 * Admin refund methods (coins / coupon / ask the customer → coins +10% or UPI → to-do) are in order-actions.test.js. */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 30));
const CREDIT = ['REFUND_CREDIT', 'CREDIT_SPEND', 'CREDIT_RELEASE'];

// ---------------------------------------------------------------- in-memory MySQL (strict: unknown SQL throws)
let S;
function fresh() {
  S = {
    settings: {}, wallet: [], ledger: [], spends: [], orders: [], couponUsage: [], coupons: [], todos: [], credits: [],
    plans: [{ service: 'Netflix', plan: 'Private 1M', price: 169 }, { service: 'Prime Video', plan: '1 Month', price: 39 }],
    locks: 0, orderUpdates: 0,
  };
}
fresh();
const TABLES = ['settings', 'wallet', 'ledger', 'spends', 'orders', 'couponUsage', 'coupons', 'todos', 'credits'];
const snap = () => clone(TABLES.reduce((o, k) => { o[k] = S[k]; return o; }, {}));
const restore = (x) => { for (const k of TABLES) S[k] = x[k]; };
const walletOf = (ph) => S.wallet.filter((w) => w.phone_norm === ph).sort((a, b) => b.coins_lifetime - a.coins_lifetime)[0];
const bal = (ph) => (walletOf(ph) || { coins_balance: 0 }).coins_balance;
const credit = (ph) => S.ledger.filter((l) => l.phone_norm === ph && CREDIT.includes(l.event)).reduce((n, l) => n + l.coins_delta, 0);
const orderOf = (id) => S.orders.find((o) => o.order_id === id);
const rawOf = (id) => JSON.parse(orderOf(id).raw_json);
const spendOf = (id) => S.spends.find((x) => x.order_id === id);
let nextLedgerId = 1;

function run(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
  let m;
  if (/^SELECT GET_LOCK/.test(sql)) { S.locks++; return [{ l: 1 }]; }
  if (/^SELECT RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  // settings
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return S.settings[p[0]] ? [{ value: S.settings[p[0]] }] : [];
  // wallet
  if (/^SELECT coins_balance FROM wallet WHERE phone_norm = \? ORDER BY/.test(sql)) { const w = walletOf(p[0]); return w ? [{ coins_balance: w.coins_balance }] : []; }
  if (/^SELECT coins_balance, coins_lifetime, last_earned_at, last_spent_at, last_event FROM wallet WHERE phone_norm = \?/.test(sql)) { const w = walletOf(p[0]); return w ? [clone(w)] : []; }
  if (/^SELECT phone, coins_balance FROM wallet WHERE phone_norm = \? ORDER BY coins_lifetime DESC, coins_balance DESC LIMIT 1 FOR UPDATE$/.test(sql)) { const w = walletOf(p[0]); return w ? [{ phone: w.phone, coins_balance: w.coins_balance }] : []; }
  if (/^INSERT IGNORE INTO wallet/.test(sql)) { if (!S.wallet.some((x) => x.phone === p[0])) S.wallet.push({ phone: p[0], phone_norm: p[1], coins_balance: 0, coins_lifetime: 0 }); return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance \+ \? WHERE phone = \?$/.test(sql)) { S.wallet.find((x) => x.phone === p[1]).coins_balance += p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance - \?/.test(sql)) { S.wallet.find((x) => x.phone === p[p.length - 1]).coins_balance -= p[0]; return { affectedRows: 1 }; }
  // ledger
  if (/^INSERT INTO coins_ledger/.test(sql)) { S.ledger.push({ id: nextLedgerId++, event: p[0], order_id: p[1], phone_norm: p[2], coins_delta: p[6], balance_after: p[7], note: p[8] }); return { affectedRows: 1 }; }
  if (/^SELECT COALESCE\(SUM\(coins_delta\), 0\) AS n FROM coins_ledger WHERE phone_norm = \? AND event IN \('REFUND_CREDIT', 'CREDIT_SPEND', 'CREDIT_RELEASE'\)$/.test(sql)) return [{ n: credit(p[0]) }];
  if (/^SELECT event, coins_delta FROM coins_ledger WHERE order_id = \? AND event IN \('CREDIT_SPEND', 'CREDIT_RELEASE'\) ORDER BY id$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && ['CREDIT_SPEND', 'CREDIT_RELEASE'].includes(l.event)).map(clone);
  if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = 'REFUND_CREDIT' LIMIT 1$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && l.event === 'REFUND_CREDIT').map((l) => ({ id: l.id }));
  if (/^SELECT ts, event, order_id, coins_delta, balance_after FROM coins_ledger WHERE phone_norm = \?/.test(sql)) return S.ledger.filter((l) => l.phone_norm === p[0]).slice().reverse().map((l) => ({ ts: '2026-09-15 10:00:00', event: l.event, order_id: l.order_id, coins_delta: l.coins_delta, balance_after: l.balance_after }));
  // coin_spends
  if (/^SELECT 1 FROM coin_spends LIMIT 1$/.test(sql)) return [];
  // S.staleRead: the list was read just before a parallel ₹0 confirm spent that hold (the UPDATE … AND status='HELD' then moves nothing).
  if (/^SELECT cs\.order_id, cs\.coins FROM coin_spends cs LEFT JOIN orders o/.test(sql)) return S.spends.filter((x) => x.phone_norm === p[0] && (x.status === 'HELD' || S.staleRead) && !S.orders.some((o) => o.order_id === x.order_id && o.status === 'PAID' && !S.staleRead)).map(clone);
  if (/^UPDATE coin_spends SET status = 'RELEASED', note = \?, updated_at = NOW\(\) WHERE order_id = \? AND status = 'HELD'$/.test(sql)) { const x = S.spends.find((y) => y.order_id === p[1] && y.status === 'HELD'); if (x) { x.status = 'RELEASED'; x.note = p[0]; } return { affectedRows: x ? 1 : 0 }; }
  if (/^INSERT INTO coin_spends/.test(sql)) { S.spends.push({ order_id: p[0], phone_norm: p[1], coins: p[2], rupees: p[3], status: 'HELD', created_at: Date.now() }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, phone_norm, coins FROM coin_spends WHERE order_id = \? AND status = 'HELD' LIMIT 1$/.test(sql)) return S.spends.filter((x) => x.order_id === p[0] && x.status === 'HELD').map(clone);
  if (/^SELECT order_id, phone_norm, coins, status FROM coin_spends WHERE order_id = \? AND status IN \('HELD', 'RELEASED'\) LIMIT 1$/.test(sql)) return S.spends.filter((x) => x.order_id === p[0] && ['HELD', 'RELEASED'].includes(x.status)).map(clone);
  if (/^UPDATE coin_spends SET status = 'SPENT', note = \?, updated_at = NOW\(\) WHERE order_id = \? AND status = \?$/.test(sql)) { const x = S.spends.find((y) => y.order_id === p[1] && y.status === p[2]); if (x) x.status = 'SPENT'; return { affectedRows: x ? 1 : 0 }; }
  if (/^UPDATE coin_spends SET status = 'SPENT', note = \?, updated_at = NOW\(\) WHERE order_id = \? AND status = 'HELD'$/.test(sql)) { const x = S.spends.find((y) => y.order_id === p[1] && y.status === 'HELD'); if (x) x.status = 'SPENT'; return { affectedRows: x ? 1 : 0 }; }
  if (/^SELECT order_id, phone_norm, coins, status FROM coin_spends WHERE order_id = \? AND status IN \('HELD', 'SPENT'\) LIMIT 1 FOR UPDATE$/.test(sql)) return S.spends.filter((x) => x.order_id === p[0] && ['HELD', 'SPENT'].includes(x.status)).map(clone);
  if (/^UPDATE coin_spends SET status = 'RELEASED', note = \?, updated_at = NOW\(\) WHERE order_id = \? AND status = \?$/.test(sql)) { const x = S.spends.find((y) => y.order_id === p[1] && y.status === p[2]); if (x) x.status = 'RELEASED'; return { affectedRows: x ? 1 : 0 }; }
  if (/^SELECT event, phone_norm, coins_delta FROM coins_ledger WHERE order_id = \? AND event IN \('NEW_PURCHASE', 'RENEW', 'EARN_REVERSE'\)$/.test(sql)) return S.ledger.filter((l) => l.order_id === p[0] && ['NEW_PURCHASE', 'RENEW', 'EARN_REVERSE'].includes(l.event)).map(clone);
  if (/^SELECT order_id, coins, rupees, status FROM coin_spends WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.spends.filter((x) => x.order_id === p[0]).map(clone);
  if (/^SELECT cs\.order_id FROM coin_spends cs LEFT JOIN orders o ON o\.order_id = cs\.order_id WHERE cs\.status = 'HELD' AND cs\.created_at < NOW\(\) - INTERVAL \? HOUR/.test(sql)) return S.spends.filter((x) => x.status === 'HELD' && x.created_at < Date.now() - p[0] * 3600e3 && !S.orders.some((o) => o.order_id === x.order_id && o.status === 'PAID')).map(clone);
  if (/^SELECT cs\.order_id FROM coin_spends cs JOIN orders o/.test(sql)) return S.spends.filter((x) => ['HELD', 'RELEASED'].includes(x.status) && S.orders.some((o) => o.order_id === x.order_id && o.status === 'PAID')).map(clone);
  // email lock (emaillock.js): these test customers have no profile row
  if (/^SELECT phone, name, email, raw_json FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return [];
  // plans / orders
  if (/^SELECT price, duration_days, is_active, raw_json FROM plans/.test(sql)) return S.plans.filter((x) => x.service === p[0] && x.plan === p[1]).map((x) => ({ price: x.price, duration_days: 30, is_active: 'TRUE', raw_json: '{}' }));
  if (/^SELECT 1 FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(() => ({ 1: 1 }));
  if (/^INSERT INTO orders/.test(sql)) {
    S.orders.push({ order_id: p[0], service: p[1], plan: p[2], name: p[4], email: p[5], phone: p[6], phone_norm: p[7], coupon_code: p[8], discount: p[9], price: p[10], final_amount: p[11], order_type: p[15], status: 'CREATED', fulfillment_status: 'PENDING', source: 'node', raw_json: p[21] });
    return { affectedRows: 1 };
  }
  if (/^SELECT order_id, status, source, service, plan, phone, phone_norm, email, order_type, price, discount, final_amount, coupon_code, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^UPDATE orders SET status = 'PAID', txn_ref = \?, verified_at = NOW\(\), raw_json = \? WHERE order_id = \? AND UPPER\(status\) = 'CREATED' LIMIT 1$/.test(sql)) { const o = orderOf(p[2]); if (!o || o.status !== 'CREATED') return { affectedRows: 0 }; S.orderUpdates++; Object.assign(o, { status: 'PAID', txn_ref: p[0], raw_json: p[1] }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, final_amount, status, source FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/^SELECT status, coupon_code, phone, phone_norm, email, discount, raw_json FROM orders WHERE order_id = \? FOR UPDATE$/.test(sql)) return S.orders.filter((o) => o.order_id === p[0]).map(clone);
  // _markPaid also writes raw_json (💸 PaidVia) when it can be read; the order id is always the LAST parameter.
  if (/^UPDATE orders SET status = \?, txn_ref = \?, verified_at = NOW\(\)(, raw_json = \?)? WHERE order_id = \?$/.test(sql)) { const o = orderOf(p[p.length - 1]); o.status = p[0]; o.txn_ref = p[1]; if (p.length === 4) o.raw_json = p[2]; return { affectedRows: 1 }; }
  if (/^UPDATE bank_credits SET consumed_order_id/.test(sql)) { S.credits.push(p); return { affectedRows: 0 }; }
  // coupons
  if (/^SELECT raw_json FROM coupons$/.test(sql)) return S.coupons.map((c) => ({ raw_json: c.raw_json }));
  if (/^SELECT raw_json FROM coupons WHERE code = \? LIMIT 1$/.test(sql)) return S.coupons.filter((c) => c.code === p[0]).map((c) => ({ raw_json: c.raw_json }));
  if ((m = sql.match(/^SELECT COUNT\(\*\) n, SUM\(phone_norm = \?\) mine FROM coupon_usage WHERE UPPER\(action\)='USED' AND UPPER\(coupon_code\)=\?$/))) { const rows = S.couponUsage.filter((c) => c.action === 'USED' && c.coupon_code === p[1]); return [{ n: rows.length, mine: rows.filter((c) => c.phone_norm === p[0]).length }]; }
  if (/^SELECT COUNT\(DISTINCT order_id\) n FROM coupon_usage WHERE UPPER\(coupon_code\) = \? AND UPPER\(action\) = 'USED'$/.test(sql)) return [{ n: new Set(S.couponUsage.filter((c) => c.coupon_code === p[0] && c.action === 'USED').map((c) => c.order_id)).size }];
  if (/^INSERT INTO coupon_usage .* VALUES \(\?, \?, \?, \?, \?, \?, 'HOLD', NOW\(\), \?\)$/.test(sql)) { S.couponUsage.push({ coupon_code: p[0], phone_norm: p[2], discount: p[4], order_id: p[5], action: 'HOLD' }); return { affectedRows: 1 }; }
  if (/^INSERT INTO coupon_usage .* SELECT \?, \?, \?, \?, \?, \?, 'USED', NOW\(\), \? WHERE NOT EXISTS/.test(sql)) {
    if (S.couponUsage.some((c) => c.order_id === p[7] && c.coupon_code === p[8] && c.action === 'USED')) return { affectedRows: 0 };
    S.couponUsage.push({ coupon_code: p[0], phone_norm: p[2], discount: p[4], order_id: p[5], action: 'USED' }); return { affectedRows: 1 };
  }
  if (/^INSERT INTO admin_todos \(title, note\) VALUES \(\?, \?\)$/.test(sql)) { S.todos.push({ title: p[0], note: p[1] }); return { affectedRows: 1, insertId: S.todos.length }; }
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
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => ({ getConnection: async () => makeConn() }), ping: async () => ({ ok: true }) };
const referralCalls = [];
Module._load = (function (orig) {
  return function (req) {
    if (req === './db') return mockDb;
    if (req === './payments') return { findByOrder: async (oid, amt) => { S.credits.push([oid, amt]); return null; }, findByRef: async () => null };
    if (req === './referrals') return { checkReferral: async () => ({ ok: false }), attachToOrder: async () => ({}), onOrderPaid: async (oid) => { referralCalls.push(oid); return {}; } };
    if (req === './paymatch') return { autoMatchLearned: async () => null };
    return orig.apply(this, arguments);
  };
})(Module._load);

const coins = require('../coins');
const order = require('../order');
const reads = require('../reads');
const P = '9876543210';
const OTHER = '9123456789';
const giveCredit = (ph, n, oid) => S.ledger.push({ id: nextLedgerId++, event: 'REFUND_CREDIT', order_id: oid || 'FFREF' + nextLedgerId, phone_norm: ph, coins_delta: n, balance_after: n });
const setBal = (ph, n) => { const w = walletOf(ph); if (w) w.coins_balance = n; else S.wallet.push({ phone: ph, phone_norm: ph, coins_balance: n, coins_lifetime: n }); };
const buy = (extra, plan) => order.createOrder(Object.assign({ service: plan === 'prime' ? 'Prime Video' : 'Netflix', plan: plan === 'prime' ? '1 Month' : 'Private 1M', name: 'Rahul', email: 'r@x.in', phone: P }, extra || {}));
function refundCoupon(code, value, phone) {
  const raw = { Code: code, CouponCode: code, Scope: 'ANY', Type: 'FLAT', Value: value, MinAmount: 0, MaxDiscount: 0, Expiry: '2027-03-01 23:59:59', PerUserLimit: 1, GlobalLimit: 1, Active: 'TRUE', ShowInProfile: 'TRUE', AllowedPhones: phone || P, FirstTimeOnly: 'FALSE', Source: 'REFUND', RefundOrderId: 'FF1111111' };
  S.coupons.push({ code, raw_json: JSON.stringify(raw) });
}

(async () => {
  section('spendPlan: refund credit pays up to 100%, coins keep the max-% rule');
  const cfg = coins.defaults();
  let a = coins.spendPlan(cfg, 0, 500, 169, 'NEW');
  ok('₹500 credit on ₹169 → credit ₹169 (full price), no coins', a.credit === 169 && a.coins === 0 && a.rupees === 169, a);
  a = coins.spendPlan(cfg, 500, 0, 169, 'NEW');
  ok('500 normal coins on ₹169 → still only 20% = 33', a.credit === 0 && a.coins === 33 && a.rupees === 33, a);
  a = coins.spendPlan(cfg, 500, 100, 169, 'NEW');
  ok('credit ₹100 + coins → 100 + 33 (cap on the order), total 133', a.credit === 100 && a.coins === 33 && a.rupees === 133, a);
  a = coins.spendPlan(cfg, 500, 150, 169, 'NEW');
  ok('credit ₹150 + coins → coins only fill the ₹19 left (never more than the price)', a.credit === 150 && a.coinRupees === 19 && a.rupees === 169, a);
  a = coins.spendPlan(Object.assign({}, cfg, { spendEnabled: false, spendOnRenew: false }), 500, 60, 169, 'RENEW');
  ok('coins switched off / not on renewals: refund credit still works', a.credit === 60 && a.coins === 0 && a.rupees === 60, a);
  a = coins.spendPlan(cfg, 10, 0, 169, 'NEW');
  ok('below the coin minimum and no credit → nothing (reason min)', a.rupees === 0 && a.reason === 'min', a);
  a = coins.spendPlan(Object.assign({}, cfg, { coinValue: 2 }), 500, 160, 169, 'NEW');
  ok('coin worth ₹2 and ₹9 left: 4 coins = ₹8, never overpays', a.credit === 160 && a.coins === 4 && a.coinRupees === 8 && a.rupees === 168, a);

  section('quote + wallet show both pots');
  giveCredit(P, 200); setBal(P, 50);
  let q = await coins.quoteSpend(P, 169, 'NEW');
  ok('quote: creditBalance 200, creditRupees 169, total coins/rupees include the credit', q.ok && q.enabled && q.creditBalance === 200 && q.creditRupees === 169 && q.rupees === 169 && q.coins === 169 && q.coinCoins === 0 && q.balance === 50, q);
  const w = await reads.getWalletByPhone(P);
  ok('wallet: refundCredit separate from coinsBalance', w.ok && w.refundCredit === 200 && w.coinsBalance === 50, w);

  section('checkout: credit covers everything → ₹0 order, no UPI needed');
  const o1 = await buy({ useCoins: true });
  const r1 = rawOf(o1.orderId);
  ok('₹169 − ₹169 credit = ₹0, freeCheckout, RefundCreditUsed 169, normal coins untouched', o1.ok && o1.amount === 0 && o1.freeCheckout === true && o1.creditUsed === 169 && r1.FreeCheckout === true && r1.RefundCreditUsed === 169 && bal(P) === 50 && credit(P) === 31, { o1, r1, bal: bal(P), credit: credit(P) });
  ok('hold recorded: coin_spends HELD (0 coins, ₹169) + ledger CREDIT_SPEND −169', spendOf(o1.orderId).status === 'HELD' && spendOf(o1.orderId).coins === 0 && spendOf(o1.orderId).rupees === 169 && S.ledger.some((l) => l.event === 'CREDIT_SPEND' && l.order_id === o1.orderId && l.coins_delta === -169) && !S.ledger.some((l) => l.event === 'SPEND'), S.ledger);
  let v = await order.verifyPayment(o1.orderId);
  ok('verifyPayment on an unconfirmed ₹0 order: never looks for a ₹0 bank credit', v.ok && v.paid === false && v.freeCheckout === true && !S.credits.length, v);

  section('confirmFreeOrder: proof, tampering, idempotency');
  let c = await order.confirmFreeOrder(o1.orderId, { phone: OTHER, token: 'nope' });
  ok('wrong phone + wrong token → refused, still CREATED', c.ok === false && orderOf(o1.orderId).status === 'CREATED' && spendOf(o1.orderId).status === 'HELD', c);
  const [x1, x2, x3] = await Promise.all([order.confirmFreeOrder(o1.orderId, { token: o1.accessToken }), order.confirmFreeOrder(o1.orderId, { phone: P }), order.confirmFreeOrder(o1.orderId.toLowerCase(), { phone: P })]);
  ok('three confirms at once: all ok, exactly one marks it paid', [x1, x2, x3].every((x) => x.ok && x.paid) && [x1, x2, x3].filter((x) => x.already).length === 2 && S.orderUpdates === 1, { x1, x2, x3, updates: S.orderUpdates });
  const paid1 = orderOf(o1.orderId); const praw1 = JSON.parse(paid1.raw_json);
  ok('PAID with txn_ref CREDIT-…, payment method CREDIT, raw_json in step; hold SPENT; credit not taken twice', paid1.status === 'PAID' && paid1.txn_ref === 'CREDIT-' + o1.orderId && praw1.Status === 'PAID' && praw1.PaymentMethod === 'CREDIT' && praw1.PaidWithCredit === 169 && spendOf(o1.orderId).status === 'SPENT' && credit(P) === 31 && S.ledger.filter((l) => l.order_id === o1.orderId && l.event === 'CREDIT_SPEND').length === 1, { paid1, praw1, credit: credit(P) });
  await tick();
  ok('referral hook runs once (same as a paid order)', referralCalls.filter((x) => x === o1.orderId).length === 1, referralCalls);
  v = await order.verifyPayment(o1.orderId);
  ok('verifyPayment now says paid → normal delivery polling continues', v.paid === true, v);
  const m1 = await coins.maintain();
  ok('maintain() leaves a confirmed ₹0 order alone', m1.released === 0 && spendOf(o1.orderId).status === 'SPENT' && credit(P) === 31, m1);

  const paidOrder = await buy({});
  ok('a normal order is not free', paidOrder.amount === 169 && !paidOrder.freeCheckout);
  c = await order.confirmFreeOrder(paidOrder.orderId, { token: paidOrder.accessToken });
  ok('confirming a ₹169 order is refused (needs payment), stays CREATED', c.ok === false && c.needsPayment === true && orderOf(paidOrder.orderId).status === 'CREATED', c);
  const tampered = await buy({ amount: 0, finalAmount: 0, discount: 999, discountOverride: 999, amountOverride: 0, FreeCheckout: true, freeCheckout: true, rawExtra: { FreeCheckout: true } });
  ok('client-sent amount / discount / FreeCheckout fields are ignored', tampered.amount === 169 && !tampered.freeCheckout && rawOf(tampered.orderId).FreeCheckout === undefined && Number(orderOf(tampered.orderId).discount) === 0, { tampered, raw: rawOf(tampered.orderId) });
  c = await order.confirmFreeOrder(tampered.orderId, { token: tampered.accessToken });
  ok('…and it can\'t be confirmed for free', c.ok === false && orderOf(tampered.orderId).status === 'CREATED', c);
  const forged = await buy({});
  orderOf(forged.orderId).final_amount = 0; // even if the stored amount were somehow 0 without FreeCheckout
  c = await order.confirmFreeOrder(forged.orderId, { token: forged.accessToken });
  ok('final_amount 0 without the server FreeCheckout flag → refused', c.ok === false && orderOf(forged.orderId).status === 'CREATED', c);
  const forged2 = await buy({});
  orderOf(forged2.orderId).final_amount = 0; orderOf(forged2.orderId).raw_json = JSON.stringify(Object.assign(rawOf(forged2.orderId), { FreeCheckout: true }));
  c = await order.confirmFreeOrder(forged2.orderId, { token: forged2.accessToken });
  ok('FreeCheckout flag but price not covered by holds / discounts → refused', c.ok === false && c.needsPayment === true && orderOf(forged2.orderId).status === 'CREATED', c);

  const quick = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'R', email: 'r@x.in', phone: P }, { amountOverride: 0 });
  ok('admin quick order agreed at ₹0 is not a customer ₹0 checkout', quick.ok && quick.amount === 0 && !quick.freeCheckout && rawOf(quick.orderId).FreeCheckout === undefined, quick);
  c = await order.confirmFreeOrder(quick.orderId, { token: quick.accessToken });
  ok('…so the storefront can\'t confirm it (the owner marks it paid)', c.ok === false && orderOf(quick.orderId).status === 'CREATED', c);

  section('holds given back before confirming → start again');
  fresh(); giveCredit(P, 169);
  const o2 = await buy({ useCoins: true });
  ok('₹0 order with ₹169 credit held', o2.freeCheckout && credit(P) === 0, o2);
  const o3 = await buy({ useCoins: true }, 'prime');
  ok('starting another order with coins gives the first hold back (credit released) and holds ₹39 for the new one', spendOf(o2.orderId).status === 'RELEASED' && S.ledger.some((l) => l.event === 'CREDIT_RELEASE' && l.order_id === o2.orderId && l.coins_delta === 169) && o3.amount === 0 && credit(P) === 130, { spends: S.spends, credit: credit(P) });
  c = await order.confirmFreeOrder(o2.orderId, { phone: P });
  ok('the first ₹0 order can no longer be confirmed (no double spend of the same credit)', c.ok === false && c.startAgain === true && orderOf(o2.orderId).status === 'CREATED' && credit(P) === 130, c);
  S.spends.find((x) => x.order_id === o3.orderId).created_at = Date.now() - 25 * 3600e3;
  const m2 = await coins.maintain();
  ok('24 h unpaid: maintain() gives the ₹39 credit back', m2.released === 1 && credit(P) === 169 && spendOf(o3.orderId).status === 'RELEASED', { m2, credit: credit(P) });
  c = await order.confirmFreeOrder(o3.orderId, { phone: P });
  ok('…and that order can\'t be confirmed any more either', c.ok === false && c.startAgain && orderOf(o3.orderId).status === 'CREATED', c);

  section('a new checkout never gives back a hold that a ₹0 confirm just spent');
  fresh(); giveCredit(P, 169); setBal(P, 100);
  const s1 = await buy({ useCoins: true });
  await order.confirmFreeOrder(s1.orderId, { phone: P });
  ok('confirmed: SPENT, credit 0, coins 100', spendOf(s1.orderId).status === 'SPENT' && credit(P) === 0 && bal(P) === 100);
  S.staleRead = true;
  const s2 = await buy({ useCoins: true }, 'prime');
  S.staleRead = false;
  ok('stale list of holds: nothing given back (no free credit / coins), the paid order keeps its hold', spendOf(s1.orderId).status === 'SPENT' && !S.ledger.some((l) => l.order_id === s1.orderId && l.event === 'CREDIT_RELEASE') && bal(P) === 100 - (s2.coinsUsed || 0) && credit(P) === 0, { spends: S.spends, bal: bal(P), credit: credit(P), s2 });

  section('partly paid with credit, then UPI; paid after the hold was released → credit taken again');
  fresh(); giveCredit(P, 100); setBal(P, 0);
  const o4 = await buy({ useCoins: true });
  ok('₹169 − ₹100 credit = ₹69 to pay by UPI (not free)', o4.amount === 69 && !o4.freeCheckout && credit(P) === 0, o4);
  await coins.releaseSpend(o4.orderId, 'test');
  ok('released: credit back to 100', credit(P) === 100 && spendOf(o4.orderId).status === 'RELEASED');
  await order.adminMarkPaid(o4.orderId, 'UPI'); await tick();
  ok('paid anyway: credit taken again (like coins), hold SPENT', credit(P) === 0 && spendOf(o4.orderId).status === 'SPENT' && S.ledger.filter((l) => l.order_id === o4.orderId && l.event === 'CREDIT_SPEND').length === 2, { credit: credit(P), l: S.ledger });
  const ref = await (async () => { const conn = makeConn(); await conn.beginTransaction(); const out = await coins.undoOrderCoinsOn(conn, o4.orderId, P, 'refunded'); await conn.commit(); return out; })();
  ok('refunding that order gives the ₹100 credit back (once)', ref.creditReturned === 100 && credit(P) === 100, ref);
  const ref2 = await (async () => { const conn = makeConn(); await conn.beginTransaction(); const out = await coins.undoOrderCoinsOn(conn, o4.orderId, P, 'again'); await conn.commit(); return out; })();
  ok('…and not twice (no second ledger line either)', ref2.creditReturned === 0 && credit(P) === 100 && S.ledger.filter((l) => l.order_id === o4.orderId && l.event === 'CREDIT_RELEASE').length === 2, { ref2, l: S.ledger.filter((l) => l.order_id === o4.orderId) });

  section('refund credit added once per refunded order');
  fresh();
  const add = async (n) => { const conn = makeConn(); await conn.beginTransaction(); const out = await coins.addRefundCreditOn(conn, { orderId: 'FF7777777', phone: P, credit: n, service: 'Zee5', plan: '1 Month', amount: n }); await conn.commit(); return out; };
  const [ad1, ad2] = await Promise.all([add(89), add(89)]);
  ok('two at once: +89 exactly once', credit(P) === 89 && [ad1, ad2].filter((x) => x.already).length === 1 && S.ledger.filter((l) => l.event === 'REFUND_CREDIT').length === 1, { ad1, ad2 });
  const h = await coins.history(P);
  ok('history labels the credit line and marks it credit', h.items[0].label === '💸 Refund credit added' && h.items[0].credit === true && h.items[0].coins === 89, h);

  section('₹0 with a refund coupon: single use enforced at confirm');
  fresh(); refundCoupon('RFABC234', 200);
  const k1 = await buy({ couponCode: 'rfabc234' });
  const k2 = await buy({ couponCode: 'RFABC234' });
  ok('both orders created at ₹0 with the coupon (limits count paid uses only)', k1.amount === 0 && k1.freeCheckout && k2.amount === 0 && k2.freeCheckout, { k1, k2 });
  c = await order.confirmFreeOrder(k1.orderId, { token: k1.accessToken });
  ok('first confirm: PAID (method COUPON) + coupon USED once', c.ok && c.paymentMethod === 'COUPON' && orderOf(k1.orderId).status === 'PAID' && S.couponUsage.filter((u) => u.action === 'USED').length === 1, { c, u: S.couponUsage });
  c = await order.confirmFreeOrder(k2.orderId, { token: k2.accessToken });
  ok('second order with the same single-use coupon → refused, stays unpaid', c.ok === false && c.startAgain && orderOf(k2.orderId).status === 'CREATED' && S.couponUsage.filter((u) => u.action === 'USED').length === 1, c);
  refundCoupon('RFOTHER22', 200, OTHER);
  const k3 = await buy({ couponCode: 'RFOTHER22' });
  ok('someone else\'s refund coupon can\'t even start an order', k3.ok === false && /not valid for this number/.test(k3.message), k3);

  section('refund coupon paid twice by UPI → owner to-do');
  fresh(); refundCoupon('RFTWICE22', 100);
  const t1 = await buy({ couponCode: 'RFTWICE22' }); const t2 = await buy({ couponCode: 'RFTWICE22' });
  await order.adminMarkPaid(t1.orderId, 'UPI'); await tick();
  ok('one paid use: no to-do', S.todos.length === 0 && S.couponUsage.filter((u) => u.action === 'USED').length === 1);
  await order.adminMarkPaid(t2.orderId, 'UPI'); await tick();
  ok('second paid use of the same refund coupon: to-do for the owner', S.todos.length === 1 && /RFTWICE22/.test(S.todos[0].title) && /2 paid orders/.test(S.todos[0].title), S.todos);

  section('wiring');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: confirmFreeOrder is a MySQL write action with a rate limit', /DB_WRITES\.confirmFreeOrder = \(a\) => order\.confirmFreeOrder\(a\[0\], a\[1\]\)/.test(server) && /DB_WRITE_ACTIONS\.add\('confirmFreeOrder'\)/.test(server) && /LIMITS\.confirmFreeOrder = security\.rateLimiter/.test(server));
  ok('server: refund actions registered with IP + phone limits', ['getPendingRefunds', 'convertRefundToCredit', 'refundSendCode', 'requestUpiRefund'].every((x) => server.includes("'" + x + "'")) && /PHONE_LIMITS, \{\s*convertRefundToCredit/.test(server) && /requestUpiRefund: \(a\) => refundsMod\.requestUpi\(a\[0\], a\[1\], a\[2\], a\[3\]\)/.test(server));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const iscripts = [...idx.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]).filter((t) => t.trim() && !/^\s*\{/.test(t));
  let parsed = true; for (const sc of iscripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   index parse error:', e.message); } }
  ok('index.html scripts parse', parsed);
  ok('storefront: ₹0 order shows a Confirm card (no UPI) that calls confirmFreeOrder then the normal verify screen', /if \(orderData\.free && Number\(amount \|\| 0\) === 0\)/.test(idx) && /"✅ Use your credit to get "/.test(idx) && /" — you pay ₹0"/.test(idx) && /API\.confirmFreeOrder\(orderId, \{/.test(idx) && /free: !!r\.freeCheckout/.test(idx) && (idx.match(/free: !!r\.freeCheckout/g) || []).length === 2);
  ok('storefront: coins toggle shows refund credit (full price) and coins (up to %)', /"💸 Refund credit ₹", q\.creditBalance, " \(can pay the full price\)"/.test(idx) && /🪙 Coins \$\{q\.balance\} \(up to \$\{R\.maxPercent\}% per order\)/.test(idx));
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const ascripts = [...admin.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]).filter((t) => t.trim());
  let aparsed = true; for (const sc of ascripts) { try { new Function(sc); } catch (e) { aparsed = false; console.log('   admin parse error:', e.message); } }
  ok('admin.html scripts parse', aparsed);

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
