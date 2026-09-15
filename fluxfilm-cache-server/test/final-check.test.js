/* Final check 2026-09-15 — loopholes found in the full audit (plan select, renewals, payments).
 * Run: npm test (no database needed — a small in-memory fake answers the SQL). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- fake database
let S = null;
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
function fresh() {
  return {
    sql: [], inserted: [],
    plans: [
      { service: 'Prime Video', plan: '1 Month', duration_days: 30, price: 39, early_renew_discount: 5, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY', EarlyRenewDiscount: 5 }) },
      { service: 'Prime Video', plan: '3 Months', duration_days: 90, price: 111, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY', EarlyRenewDiscount: 40 }) },
      { service: 'Prime Video', plan: '2 Devices 1M', duration_days: 30, price: 59, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY' }) },
      { service: 'Prime Video', plan: '2 Devices 3M', duration_days: 90, price: 149, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY' }) },
      { service: 'Netflix', plan: 'Private 1M', duration_days: 30, price: 169, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) },
      { service: 'Netflix', plan: 'Sharing 1M', duration_days: 30, price: 139, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) },
      { service: 'Netflix', plan: 'Sharing 2 Devices 1M', duration_days: 30, price: 169, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE', ExtraDevicePrice: 20 }) },
      { service: 'YouTube Premium', plan: '1 Month', duration_days: 30, price: 99, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'NONE', FulfillmentMode: 'MANUAL' }) },
    ],
    subs: [],
    coupons: [],
  };
}
function run(sqlRaw, params) {
  const sql = norm(sqlRaw);
  params = params || [];
  S.sql.push({ sql, params });
  if (/information_schema/.test(sql)) return [{ n: 0 }];
  if (/FROM plans WHERE service = \? AND plan = \?/.test(sql)) return S.plans.filter((p) => p.service === params[0] && p.plan === params[1]);
  if (/^SELECT plan, is_active, raw_json FROM plans WHERE service = \?$/.test(sql)) return S.plans.filter((p) => p.service === params[0]);
  if (/^SELECT 1 AS x FROM plans p JOIN subscriptions s ON s.service = p.service WHERE s.sub_id = \? AND p.plan = \? LIMIT 1$/.test(sql)) {
    const sb = S.subs.find((x) => x.sub_id === params[0]); return sb && S.plans.some((p) => p.service === sb.service && p.plan === params[1]) ? [{ x: 1 }] : [];
  }
  if (/^SELECT service, plan, duration_days/.test(sql) && /FROM plans/.test(sql)) return S.plans;
  if (/^SELECT 1 FROM orders WHERE order_id/.test(sql)) return [];
  if (/FROM subscriptions WHERE sub_id = \?/.test(sql)) return S.subs.filter((s) => s.sub_id === params[0]);
  if (/FROM subscriptions WHERE phone_norm = \?/.test(sql)) return S.subs;
  if (/FROM customers/.test(sql)) return [{ name: 'Test Customer' }];
  if (/^SELECT raw_json FROM coupons/.test(sql)) return S.coupons.map((c) => ({ raw_json: JSON.stringify(c) }));
  if (/FROM coupon_usage/.test(sql)) return [{ n: 0, mine: 0 }];
  if (/^INSERT INTO orders/.test(sql)) { S.inserted.push(params); return { affectedRows: 1 }; }
  if (/^INSERT INTO coupon_usage/.test(sql)) return { affectedRows: 1 };
  if (/^UPDATE bank_credits/.test(sql)) return { affectedRows: 0 };
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 140));
}
let lockResult = 1;
const pool = {
  query: async (sql, p) => [run(sql, p)],
  getConnection: async () => ({
    query: async (sql, p) => (/GET_LOCK/.test(sql) ? [[{ l: lockResult }]] : /RELEASE_LOCK/.test(sql) ? [[{ r: 1 }]] : [run(sql, p)]),
    release() {},
  }),
};
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => pool, ping: async () => ({ ok: true }) };

let stockMode = { stock: 5 };
const fakeStock = {
  computeStockLevels: async (rows) => {
    if (stockMode.throws) throw new Error('stock db down');
    const out = {};
    for (const r of rows) out[r.service + '|||' + r.plan] = { stock: stockMode.stock, stockLevel: stockMode.stock === 0 ? 'OUT' : 'OK', source: stockMode.stock == null ? 'manual' : 'inventory' };
    return out;
  },
};
const fakeFulfillForOrder = { planRenewal: async (subId) => ({ mode: 'KEEP', leadSubId: subId }), checkDeviceLogins: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req, parent) {
  if (req === './db') return mockDb;
  if (req === './stock') return fakeStock;
  if (req === './coins') return { holdSpend: async () => ({ ok: false }), releaseSpend: async () => ({}), awardCoins: async () => ({ ok: true }) };
  if (req === './referrals') return { checkReferral: async () => ({ ok: false }), attachToOrder: async () => ({}) };
  if (req === './mailer') return { sendAccessEmail: async () => {} };
  if (req === './fulfill' && parent && /order\.js$/.test(parent.filename)) return fakeFulfillForOrder;
  return origLoad.apply(this, arguments);
};
const order = require('../order');
const payments = require('../payments');
const reads = require('../reads');
const fulfill = require('../fulfill');

const buyer = (o) => Object.assign({ name: 'Test Buyer', email: 'b@x.test', phone: '9876543210' }, o);
const lastDeviceCount = () => { const p = S.inserted[S.inserted.length - 1]; return p ? p[17] : null; };
const lastAmount = () => { const p = S.inserted[S.inserted.length - 1]; return p ? p[11] : null; };
const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' '); // Date → IST "YYYY-MM-DD HH:MM:SS"
const sub = (o) => Object.assign({ sub_id: 'SUB-100000001', service: 'Prime Video', plan: '1 Month', phone: '9876543210', email: 'me@x.test', expiry_date: ist(Date.now() + 12 * 86400e3), source: 'node', status: 'ACTIVE', fulfillment_status: 'FULFILLED' }, o);

(async () => {
  // ------------------------------------------------------------------------------------------------
  section('plan select: a client cannot raise the device count for free');
  S = fresh(); stockMode = { stock: 5 };
  let r = await order.createOrder(buyer({ service: 'Prime Video', plan: '2 Devices 1M', deviceCount: 6 }));
  ok('order created', r.ok === true, r);
  ok('6 devices asked on a 2-device plan without ExtraDevicePrice → 2 devices', r.deviceCount === 2 && lastDeviceCount() === 2, { d: r.deviceCount, row: lastDeviceCount() });
  ok('price stays the 2-device price', r.amount === 59, r.amount);
  S = fresh();
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '1 Month', deviceCount: 'Infinity' }));
  ok('"Infinity" devices → 1 device, normal price (no NaN amount)', r.ok && r.deviceCount === 1 && r.amount === 39, r);
  S = fresh();
  r = await order.createOrder(buyer({ service: 'Netflix', plan: 'Sharing 2 Devices 1M', deviceCount: 3 }));
  ok('plan WITH ExtraDevicePrice: 3 devices sold and charged (existing rule: base + 2 × 20)', r.ok && r.deviceCount === 3 && r.amount === 209, r);
  S = fresh();
  r = await order.createOrder(buyer({ service: 'Netflix', plan: 'Sharing 2 Devices 1M', deviceCount: 99 }));
  ok('ExtraDevicePrice plan: capped at 6 devices', r.ok && r.deviceCount === 6, r.deviceCount);
  S = fresh();
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '2 Devices 1M', deviceCount: 0 }));
  ok('never FEWER devices than the plan name', r.ok && r.deviceCount === 2, r.deviceCount);
  S = fresh();
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '1 Month', deviceCount: 3 }), { amountOverride: 100, allowNoEmail: true });
  ok('admin quick order may still set the device count', r.ok && r.deviceCount === 3, r.deviceCount);

  // ------------------------------------------------------------------------------------------------
  section('plan select: out of stock → no payable order');
  S = fresh(); stockMode = { stock: 0 };
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '1 Month' }));
  ok('stock 0 → refused with outOfStock', r.ok === false && r.outOfStock === true, r);
  ok('stock 0 → no order row written', S.inserted.length === 0);
  S = fresh(); stockMode = { stock: 1 };
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '1 Month' }));
  ok('stock 1 → order created', r.ok === true, r);
  S = fresh(); stockMode = { stock: null };
  r = await order.createOrder(buyer({ service: 'YouTube Premium', plan: '1 Month' }));
  ok('manual plan with blank Stock (unlimited) → order created', r.ok === true, r);
  S = fresh(); stockMode = { throws: true };
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '1 Month' }));
  ok('stock read error never blocks a sale', r.ok === true, r);
  S = fresh(); stockMode = { stock: 0 };
  r = await order.createOrder(buyer({ service: 'Prime Video', plan: '1 Month' }), { amountOverride: 39, allowNoEmail: true });
  ok('admin quick order is not blocked by stock (owner decides)', r.ok === true, r);
  stockMode = { stock: 5 };

  // ------------------------------------------------------------------------------------------------
  section('renewals: only the duration may change');
  ok('planVariant("Sharing 2 Devices 3M") = "sharing 2 devices"', order.planVariant('Sharing 2 Devices 3M') === 'sharing 2 devices');
  ok('planVariant("1Year") = planVariant("1 Month") = ""', order.planVariant('1Year') === '' && order.planVariant('1 Month') === '');
  ok('planVariant("Private 1M") ≠ planVariant("Sharing 1M")', order.planVariant('Private 1M') !== order.planVariant('Sharing 1M'));
  ok('planVariant("2 Devices 1M") ≠ planVariant("1 Month")', order.planVariant('2 Devices 1M') !== order.planVariant('1 Month'));

  S = fresh(); S.subs.push(sub({ plan: '2 Devices 1M' }));
  r = await order.createRenewOrder('SUB-100000001', '1 Month');
  ok('2-device sub renewed as "1 Month" (₹39, keeps 2 devices) → refused', r.ok === false && r.renewBlocked === true, r);
  ok('… and no order row written', S.inserted.length === 0);
  S = fresh(); S.subs.push(sub({ plan: '1 Month' }));
  r = await order.createRenewOrder('SUB-100000001', '2 Devices 1M');
  ok('1-device sub renewed as "2 Devices 1M" (pays, gets 1 device) → refused', r.ok === false && r.renewBlocked === true, r);
  S = fresh(); S.subs.push(sub({ service: 'Netflix', plan: 'Private 1M' }));
  r = await order.createRenewOrder('SUB-100000001', 'Sharing 1M');
  ok('Netflix Private renewed at the Sharing price → refused', r.ok === false && r.renewBlocked === true, r);
  S = fresh(); S.subs.push(sub({ plan: '2 Devices 1M' }));
  r = await order.createRenewOrder('SUB-100000001', '2 Devices 3M');
  ok('same devices, longer duration → allowed', r.ok === true && lastAmount() === 149, { r, amt: lastAmount() });
  S = fresh(); S.subs.push(sub({ plan: '2 Devices 1M' }));
  r = await order.createRenewOrder('SUB-100000001');
  ok('plain renewal of the same plan → allowed', r.ok === true, r);

  section('renewals: early-renew discount only on the same plan');
  S = fresh(); S.subs.push(sub({ plan: '1 Month', expiry_date: ist(Date.now() + 12 * 86400e3) }));
  let q = await order.renewQuote('SUB-100000001', '3 Months');
  ok('switching 1 Month → 3 Months: no early discount (page shows none)', q.ok && q.earlyDiscount === 0 && q.amount === 111, q);
  q = await order.renewQuote('SUB-100000001');
  ok('same plan 12 days early: EarlyRenewDiscount given', q.ok && q.earlyDiscount === 5 && q.amount === 34, q);

  section('renewals: refunded / cancelled subscriptions cannot be renewed');
  for (const st of [{ status: 'CANCELLED', fulfillment_status: 'REFUNDED' }, { status: 'ACTIVE', fulfillment_status: 'REFUNDED' }, { status: 'CANCELLED', fulfillment_status: null }]) {
    S = fresh(); S.subs.push(sub(Object.assign({ service: 'YouTube Premium', plan: '1 Month' }, st)));
    r = await order.createRenewOrder('SUB-100000001');
    ok('renew ' + JSON.stringify(st) + ' → refused, no order', r.ok === false && S.inserted.length === 0, r);
  }
  for (const st of [{ status: 'EXPIRED', fulfillment_status: null }, { status: 'ACTIVE', fulfillment_status: null }, { status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING' }]) {
    S = fresh(); S.subs.push(sub(Object.assign({ service: 'YouTube Premium', plan: '1 Month' }, st)));
    r = await order.createRenewOrder('SUB-100000001');
    ok('renew legacy/manual ' + JSON.stringify(st) + ' → allowed', r.ok === true, r);
  }

  // ------------------------------------------------------------------------------------------------
  section('coupons: a date-only expiry lasts until the end of that day (IST)');
  const todayIst = ist(Date.now()).slice(0, 10);
  const yesterdayIst = ist(Date.now() - 86400e3).slice(0, 10);
  S = fresh(); S.coupons.push({ Code: 'LASTDAY', Active: 'TRUE', Expiry: todayIst, Type: 'FLAT', Value: 10 });
  let c = await order._internal.couponDiscount('LASTDAY', '9876543210', 100, { action: 'NEW' });
  ok('coupon expiring TODAY is still valid now', c.ok === true && c.discount === 10, c);
  S = fresh(); S.coupons.push({ Code: 'OLD', Active: 'TRUE', Expiry: yesterdayIst, Type: 'FLAT', Value: 10 });
  c = await order._internal.couponDiscount('OLD', '9876543210', 100, { action: 'NEW' });
  ok('coupon that expired YESTERDAY is refused', c.ok === false, c);
  S = fresh(); S.coupons.push({ Code: 'TIMED', Active: 'TRUE', Expiry: ist(Date.now() - 60e3), Type: 'FLAT', Value: 10 });
  c = await order._internal.couponDiscount('TIMED', '9876543210', 100, { action: 'NEW' });
  ok('coupon with an exact time a minute ago is refused', c.ok === false, c);

  // ------------------------------------------------------------------------------------------------
  section('payments: a typed UTR only pays an order with a fresh credit made for it');
  S = fresh();
  await payments.findByRef('FF1234567', 'UTR 612345678901', 99);
  const up = S.sql.find((x) => /^UPDATE bank_credits/.test(x.sql));
  ok('credit whose bank note names ANOTHER order is not used', up && /COALESCE\(order_ids, ''\) = '' OR FIND_IN_SET\(\?, order_ids\) > 0/.test(up.sql), up && up.sql);
  ok('credit older than the order (minus a few minutes) is not used; no order time (NULL) skips the check', up && /received_at >= COALESCE\(\(SELECT DATE_SUB\(o\.created_at_sheet, INTERVAL \? MINUTE\) FROM orders o WHERE o\.order_id = \? LIMIT 1\), '1000-01-01 00:00:00'\)/.test(up.sql), up && up.sql);
  ok('parameters bound in order', up && JSON.stringify(up.params) === JSON.stringify(['FF1234567', '612345678901', 99, 'FF1234567', payments._internal.REF_WINDOW_MIN, 'FF1234567']), up && up.params);

  section('payments: only the bank is trusted (exact address, its domain, or equitas.bank.in)');
  const fb = payments._internal.fromBank;
  const F = (address, name) => ({ from: { value: [{ address, name: name || '' }] } });
  ok('esfb-alerts@equitas.bank.in → trusted', fb(F('esfb-alerts@equitas.bank.in', 'Equitas')));
  ok('upper-case bank address → trusted', fb(F('ESFB-Alerts@Equitas.Bank.In')));
  ok('another @equitas.bank.in address → trusted', fb(F('alerts@equitas.bank.in')));
  ok('subdomain of equitas.bank.in → trusted', fb(F('noreply@mail.equitas.bank.in')));
  ok('BANK_SENDER as a bare domain → trusted', fb(F('esfb-alerts@equitas.bank.in'), 'equitas.bank.in') && fb(F('x@alerts.otherbank.example'), 'otherbank.example'));
  ok('BANK_SENDER "@domain" → trusted', fb(F('esfb-alerts@otherbank.example'), '@otherbank.example'));
  ok('BANK_SENDER a different address on the same domain → trusted', fb(F('esfb-alerts@otherbank.example'), 'alerts@otherbank.example'));
  ok('BANK_SENDER on gmail.com does not trust every gmail user', fb(F('bank@gmail.com'), 'bank@gmail.com') && !fb(F('evil@gmail.com'), 'bank@gmail.com') && !fb(F('evil@x.co.in'), 'co.in'));
  ok('bank address only as DISPLAY NAME → refused', !fb(F('someone@gmail.com', 'esfb-alerts@equitas.bank.in')));
  ok('look-alike domains → refused', !fb(F('esfb-alerts@equitas.bank.in.evil.test')) && !fb(F('esfb-alerts@xequitas.bank.in')) && !fb(F('esfb-alerts@equitas-bank.in')) && !fb(F('esfb-alerts@equitas.bank.in.evil.com'), 'equitas.bank.in'));
  ok('two From addresses → refused', !fb({ from: { value: [{ address: 'esfb-alerts@equitas.bank.in' }, { address: 'x@evil.test' }] } }));
  ok('no From → refused', !fb({}) && !fb(null) && !fb(F('')));

  // ------------------------------------------------------------------------------------------------
  section('stock: the allocation lock must really be held');
  S = fresh(); lockResult = 0; let ran = false; let err = '';
  try { await fulfill._internal.withLock('ff_alloc', 1, async () => { ran = true; }); } catch (e) { err = e.message; }
  ok('GET_LOCK timed out (0) → does not allocate', ran === false && /Busy/.test(err), { ran, err });
  lockResult = null; ran = false; err = '';
  try { await fulfill._internal.withLock('ff_alloc', 1, async () => { ran = true; }); } catch (e) { err = e.message; }
  ok('GET_LOCK error (NULL) → does not allocate', ran === false, { ran, err });
  lockResult = 1; ran = false;
  await fulfill._internal.withLock('ff_alloc', 1, async () => { ran = true; });
  ok('lock held (1) → allocates', ran === true);

  // ------------------------------------------------------------------------------------------------
  section('My plans: expiry and Renew button');
  S = fresh();
  S.subs.push(sub({ sub_id: 'SUB-100000001', expiry_date: ist(Date.now() - 2 * 3600e3), status: 'ACTIVE' }));
  S.subs.push(sub({ sub_id: 'SUB-100000002', expiry_date: ist(Date.now() + 2 * 3600e3) }));
  S.subs.push(sub({ sub_id: 'SUB-100000003', service: 'YouTube Premium', expiry_date: ist(Date.now() + 20 * 86400e3), status: 'CANCELLED', fulfillment_status: 'REFUNDED' }));
  S.subs.push(sub({ sub_id: 'SUB-100000004', expiry_date: ist(Date.now() + 20 * 86400e3), status: 'ACTIVE', fulfillment_status: null }));
  const my = await reads.getMySubscriptions('9876543210');
  const byId = {}; for (const x of [].concat(my.actionable || [], my.history || [])) byId[x.subId] = x;
  const a1 = byId['SUB-100000001']; const a2 = byId['SUB-100000002']; const a3 = byId['SUB-100000003']; const a4 = byId['SUB-100000004'];
  const dayDiff = (ms) => Math.round((Date.parse(ist(ms).slice(0, 10) + 'T00:00:00Z') - Date.parse(ist(Date.now()).slice(0, 10) + 'T00:00:00Z')) / 86400e3);
  ok('expired 2 hours ago → calendar days (0 if that was still today, else -1), never "1 day left"', a1 && a1.daysLeft === dayDiff(Date.now() - 2 * 3600e3) && a1.daysLeft <= 0, a1 && { d: a1.daysLeft, m: a1.moodText });
  ok('… still renewable', a1 && a1.showRenewButton === true);
  ok('expires in 2 hours → calendar days (0 = today, 1 after midnight)', a2 && a2.daysLeft === dayDiff(Date.now() + 2 * 3600e3), a2 && a2.daysLeft);
  ok('refunded subscription → no Renew button', a3 && a3.showRenewButton === false, a3);
  ok('legacy active subscription (no fulfilment status) → Renew button', a4 && a4.showRenewButton === true, a4);

  // ------------------------------------------------------------------------------------------------
  section('expiry: one calendar-day count in India (page and server)');
  const RR = require('../renewrules');
  const at = (s) => Date.parse(s); // an exact moment
  const NOW = at('2026-09-15T14:00:00+05:30');
  const dayCase = (label, expiry, now, want, elig) => {
    const d = RR.daysLeftIst(expiry, now);
    ok(label + ' → ' + want + (elig ? ' ' + elig : ''), d === want && (!elig || RR.renewEligibility(d) === elig), { d, e: RR.renewEligibility(d) });
  };
  dayCase('expiry today 23:59', '2026-09-15 23:59:00', NOW, 0, 'CAN_RENEW');
  dayCase('expiry today 00:30 (time already passed)', '2026-09-15 00:30:00', NOW, 0, 'CAN_RENEW');
  dayCase('expiry today 00:30, checked at 23:59:30', '2026-09-15 00:30:00', at('2026-09-15T23:59:30+05:30'), 0);
  dayCase('expiry today 23:59, checked at 00:00:10 (just after midnight)', '2026-09-15 23:59:00', at('2026-09-15T00:00:10+05:30'), 0);
  dayCase('expiry yesterday', '2026-09-14 10:00:00', NOW, -1, 'LATE_RENEW');
  dayCase('tomorrow 00:05', '2026-09-16 00:05:00', NOW, 1, 'CAN_RENEW');
  dayCase('day 6 after expiry', '2026-09-09 23:59:00', NOW, -6, 'LATE_RENEW');
  dayCase('day 7 after expiry', '2026-09-08 00:30:00', NOW, -7, 'TOO_LATE');
  dayCase('leap day: 29 Feb expiry seen on 1 Mar', '2028-02-29 20:00:00', at('2028-03-01T09:00:00+05:30'), -1, 'LATE_RENEW');
  dayCase('leap year: 28 Feb 23:00 → 1 Mar expiry', '2028-03-01 00:30:00', at('2028-02-28T23:00:00+05:30'), 2);
  dayCase('non-leap year: 28 Feb → 1 Mar', '2027-03-01 10:00:00', at('2027-02-28T10:00:00+05:30'), 1);
  dayCase('month end in UTC but 1 Oct in India', '2026-10-01 00:10:00', at('2026-09-30T20:00:00Z'), 0);
  dayCase('30 Sep 23:30 India → 1 Oct expiry', '2026-10-01 00:10:00', at('2026-09-30T23:30:00+05:30'), 1);
  dayCase('31 Dec → 1 Jan', '2027-01-01 09:00:00', at('2026-12-31T22:00:00+05:30'), 1);
  dayCase('Date object / ISO with zone', new Date('2026-09-15T18:00:00Z'), NOW, 0);
  ok('no / bad expiry → null (TOO_LATE, no Renew)', RR.daysLeftIst(null, NOW) === null && RR.daysLeftIst('', NOW) === null && RR.daysLeftIst('2026-02-30 10:00:00', NOW) === null && RR.renewEligibility(null) === 'TOO_LATE');
  ok('mood: 0 = "Expires today", -1 and -6 = late renew allowed, -7 = Expired', reads._internal.expiryMood(0).text === 'Expires today' && /late renew/.test(reads._internal.expiryMood(-1).text) && /late renew/.test(reads._internal.expiryMood(-6).text) && reads._internal.expiryMood(-7).text === 'Expired');

  // My plans and renewQuote see the same day count and the same early discount.
  const istDay = (n, hhmm) => ist(Date.now() + n * 86400e3).slice(0, 10) + ' ' + hhmm + ':00';
  for (const [n, hhmm] of [[0, '00:30'], [0, '23:59'], [-1, '12:00'], [-6, '23:59'], [-7, '00:30'], [7, '23:59'], [8, '00:30'], [2, '00:01']]) {
    S = fresh(); S.subs.push(sub({ expiry_date: istDay(n, hhmm) }));
    const mine = (await reads.getMySubscriptions('9876543210'));
    const card = [].concat(mine.actionable || [], mine.history || [])[0];
    const qq = await order.renewQuote('SUB-100000001');
    ok('expiry ' + (n >= 0 ? '+' : '') + n + ' days at ' + hhmm + ': page daysLeft ' + (card && card.daysLeft) + ' = server ' + qq.daysLeft + ' = ' + n + '; same discount',
      card && card.daysLeft === n && qq.daysLeft === n && card.earlyRenewDiscountEligible === qq.earlyDiscount && card.renewEligibility === qq.renewEligibility && card.showRenewButton === (n >= -6),
      { card: card && { d: card.daysLeft, disc: card.earlyRenewDiscountEligible, e: card.renewEligibility }, q: { d: qq.daysLeft, disc: qq.earlyDiscount, e: qq.renewEligibility } });
  }

  // ------------------------------------------------------------------------------------------------
  section('renewals: old imported plan names never give an empty renew page');
  const legacy = ['1 Month', 'Yearly', '30 Days', '3 Months', '12M', '1 Year', 'Annual', 'Monthly', '6 Mon', 'Half-Yearly', '90 days', '1Year', '12 Months'];
  ok('every duration spelling normalises to the same (empty) kind', legacy.every((n) => RR.planVariant(n) === ''), legacy.map((n) => [n, RR.planVariant(n)]));
  ok('"Sharing 1M" = "Sharing 12 Months" = "Sharing - Yearly"', RR.planVariant('Sharing 1M') === 'sharing' && RR.planVariant('Sharing 12 Months') === 'sharing' && RR.planVariant('Sharing - Yearly') === 'sharing');
  ok('"Sharing 2 Device 1 Year" = "Sharing 2 Devices 1M"; ≠ "Sharing 1M"', RR.planVariant('Sharing 2 Device 1 Year') === RR.planVariant('Sharing 2 Devices 1M') && RR.planVariant('Sharing 2 Devices 1M') !== RR.planVariant('Sharing 1M'));
  const NF = ['Private 1M', 'Private 3M', 'Sharing 1M', 'Sharing 2 Devices 1M'];
  const PV = ['1 Month', '3 Months', '2 Devices 1M', '2 Devices 3M'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('known kind: Private → only Private durations', same(RR.renewPlanChoices('Private 12 Months', NF), ['Private 1M', 'Private 3M']));
  ok('old Netflix "1 Month" (kind unknown) → the 1-device plans', same(RR.renewPlanChoices('1 Month', NF), ['Private 1M', 'Private 3M', 'Sharing 1M']));
  ok('old Netflix "2 Devices Yearly" → the 2-device plan', same(RR.renewPlanChoices('2 Devices Yearly', NF), ['Sharing 2 Devices 1M']));
  ok('unknown kind AND no plan with that device count → every plan of the service', same(RR.renewPlanChoices('4 Devices Yearly', NF), NF));
  ok('Prime "1 Month" / "12M" / "Yearly" → 1-device durations only; "2 Devices 1M" → 2-device only', same(RR.renewPlanChoices('1 Month', PV), ['1 Month', '3 Months']) && same(RR.renewPlanChoices('Yearly', PV), ['1 Month', '3 Months']) && same(RR.renewPlanChoices('2 Devices 1M', PV), ['2 Devices 1M', '2 Devices 3M']));
  ok('any old name with plans available → never an empty list', legacy.concat(['Premium', 'Private Screen', 'Family 5 Devices']).every((n) => RR.renewPlanChoices(n, NF).length > 0 && RR.renewPlanChoices(n, PV).length > 0));

  S = fresh(); S.subs.push(sub({ service: 'Netflix', plan: '1 Month' }));
  r = await order.createRenewOrder('SUB-100000001', 'Sharing 1M');
  ok('server: old Netflix "1 Month" renews into "Sharing 1M"', r.ok === true, r);
  S = fresh(); S.subs.push(sub({ service: 'Netflix', plan: '1 Month' }));
  r = await order.createRenewOrder('SUB-100000001', 'Sharing 2 Devices 1M');
  ok('server: old Netflix "1 Month" → 2-device plan refused (page does not offer it)', r.ok === false && r.renewBlocked === true, r);
  S = fresh(); S.subs.push(sub({ service: 'Netflix', plan: 'Private 1M' }));
  S.plans.push({ service: 'Netflix', plan: 'Private 3M', duration_days: 90, price: 450, is_active: 'FALSE', raw_json: '{}' });
  r = await order.createRenewOrder('SUB-100000001', 'Private 3M');
  ok('server: an inactive plan is not a renew choice', r.ok === false, r);

  S = fresh(); S.plans.push({ service: 'YouTube Premium', plan: '1Year', duration_days: 365, price: 999, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'NONE', FulfillmentMode: 'MANUAL' }) });
  S.subs.push(sub({ service: 'YouTube Premium', plan: '1 Month', status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING' }));
  r = await order.createRenewOrder('SUB-100000001', '1Year');
  ok('plan "1Year" (no space) is renewed into, not read as a coupon code', r.ok === true && lastAmount() === 999, { r, amt: lastAmount() });
  S = fresh(); S.subs.push(sub({ service: 'YouTube Premium', plan: '1 Month', status: 'ACTIVE', fulfillment_status: 'MANUAL_PENDING' }));
  S.coupons.push({ Code: 'FLUX10', Active: 'TRUE', Type: 'FLAT', Value: 10 });
  r = await order.createRenewOrder('SUB-100000001', 'FLUX10');
  ok('old callers: a coupon in the 2nd argument still works as a coupon', r.ok === true && lastAmount() === 89, { r, amt: lastAmount() });

  const html0 = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const grab = (name) => { const m = html0.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')); return m ? m[0] : ''; };
  const pageFns = new Function(grab('renewPlanVariant_') + '\n' + grab('renewPlanDevices_') + '\n' + grab('renewPlanChoices_') + '\nreturn { v: renewPlanVariant_, c: renewPlanChoices_ };')();
  const names = legacy.concat(NF, PV, ['Sharing 2 Device 1 Year', '4 Devices Yearly', 'Private Screen', 'Family 5 Devices 1M', '', null]);
  ok('index.html renewPlanChoices_ gives exactly the server answers', names.every((n) => pageFns.v(n) === RR.planVariant(n) && same(pageFns.c(n, NF), RR.renewPlanChoices(n, NF)) && same(pageFns.c(n, PV), RR.renewPlanChoices(n, PV))));

  // ------------------------------------------------------------------------------------------------
  section('storefront renew page');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('renew page lists the shared renewPlanChoices_ (same kind; old names → same devices, else all)', /const renewAllowed_ = renewPlanChoices_\(currentPlan, allServicePlans\.map\(p => p\.plan\)\);/.test(html) && /const servicePlans = allServicePlans\.filter\(p => renewAllowed_\.includes\(p\.plan\)\);/.test(html));
  ok('renew page shows only the discount the server gives (no biggest-tier fallback)', !/earlyRenewDiscountEligible \|\| 0\) \|\| Math\.max\(Number\(sub\.earlyDiscount8Plus/.test(html));
  let parsed = 0; let bad = '';
  const re = /<script(?![^>]*type=["'](?:application\/ld\+json|application\/json|text\/babel))[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) { if (!m[1].trim()) continue; try { new Function(m[1]); parsed++; } catch (e) { bad = e.message; } }
  ok('every inline index.html script still parses', parsed > 0 && !bad, bad);

  console.log('\n---------------------------------------\nfinal-check: PASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
