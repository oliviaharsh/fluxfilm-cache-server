/* 💳 Admin renewals: "start the new period from" (old expiry / today), credit renewals, receivables, mark paid /
 * partial / cancel, ✉️ reminder email (rate limited) + 💬 WhatsApp text. Owner request 16 Sep 2026.
 * Run: npm test (no database: in-memory fakes that refuse JOINs, like MariaDB with mixed collations). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (x) => JSON.parse(JSON.stringify(x));
const nsql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const noJoin = (sql) => { if (/\bJOIN\b/i.test(sql)) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT): ' + sql); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; } };
const p2 = (x) => String(x).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const DAY = 86400000;

// ====================================================================== fake DB #1: fulfill.js (renewal apply)
let F = null;
function runF(sqlRaw, params) {
  const sql = nsql(sqlRaw); params = params || [];
  noJoin(sql);
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  if (/information_schema\.columns/.test(sql)) return [{ n: 2 }];
  if (/FROM plans/.test(sql)) return F.plans.filter((p) => p.service === params[0] && p.plan === params[1]).map(clone);
  if (/FROM inventory_accounts/.test(sql)) return F.accounts.filter((a) => a.is_active === 'TRUE').map(clone);
  if (/FROM inventory_capacity/.test(sql)) return F.caps.map(clone);
  if (/FROM inventory_profiles/.test(sql)) return [];
  if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return F.subs.filter((s) => s.order_id === params[0]).map(clone);
  if (/FROM subscriptions WHERE sub_id = \?/.test(sql)) return F.subs.filter((s) => s.sub_id === params[0]).map((s) => ({ ...clone(s), occupying: 1 }));
  if (/FROM subscriptions/.test(sql) && /GROUP BY inventory_ref/.test(sql)) {
    const m = new Map();
    for (const s of F.subs) { const c = m.get(s.inventory_ref) || { inventory_ref: s.inventory_ref, total: 0, tv: 0 }; c.total += 1; m.set(s.inventory_ref, c); }
    return [...m.values()];
  }
  if (/^SELECT fulfillment_status FROM orders/.test(sql)) return F.orders.filter((o) => o.order_id === params[0]).map((o) => ({ fulfillment_status: o.fulfillment_status }));
  if (/FROM orders WHERE order_id = \?/.test(sql)) return F.orders.filter((o) => o.order_id === params[0]).map(clone);
  if (/FROM customers/.test(sql)) return [{ name: 'Mohammad Sourab' }];
  if (/^UPDATE subscriptions SET login_id/.test(sql)) return { affectedRows: 1 };
  if (/^UPDATE subscriptions SET expiry_date/.test(sql)) { const s = F.subs.find((x) => x.sub_id === params[4]); Object.assign(s, { expiry_date: params[0], order_id: params[2] }); F.writes.push('extend'); return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED'/.test(sql)) { F.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FULFILLED'; return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'FAILED'/.test(sql)) return { affectedRows: 1 };
  if (/app_settings|push_subscriptions|reminder_log/.test(sql)) return [];
  throw new Error('fake db F: unhandled SQL: ' + sql.slice(0, 140));
}
const poolF = { query: async (sql, p) => [runF(sql, p)], getConnection: async () => ({ query: async (sql, p) => [runF(sql, p)], release() {} }) };
const dbF = { ENABLED: true, query: async (sql, p) => runF(sql, p), getPool: () => poolF, ping: async () => ({ ok: true }) };
const coinCalls = [];
const fakeCoins = { awardCoins: async (p) => { coinCalls.push(p); return { ok: true, coins: 5 }; }, onOrderPaid: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return dbF;
  if (req === './coins') return fakeCoins;
  if (req === './mailer') return { sendAccessEmail: async () => { if (F) F.emails++; return { ok: true }; }, send: async () => ({ ok: true }) };
  if (req === './payments') return { findByOrder: async () => { if (F) F.bankLookups++; return { upi_ref: 'UPI123' }; }, findByRef: async () => null };
  if (req === './pushreminders') return { notifyDelivered: async () => ({}) };
  return origLoad.apply(this, arguments);
};

(async () => {
  const renewal = require('../renewal');
  const credit = require('../credit');
  const quick = require('../quickorders');

  // ==================================================================== 1. the date maths
  section('start the new period from: old expiry vs today (India time, month ends)');
  const at = (s) => renewal.toDate(s);
  // Owner's real case: Mohammad Sourab, expired 01 Sep 2026, still logged in, renewed from admin on 16 Sep.
  const now16 = at('2026-09-16 12:00:00');
  let r = renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2026-09-01 10:00:00', now: now16, durationDays: 30 });
  ok('Sourab: from old expiry 1 Sep + 30 days → 1 Oct 2026 (no free days)', r.newExpiryText === '1 Oct 2026' && fmt(r.newExpiry) === '2026-10-01 10:00:00' && r.case === 'ADMIN_FROM_EXPIRY' && r.base === 'EXPIRY', r);
  r = renewal.computeAdminRenewal({ base: 'TODAY', expiry: '2026-09-01 10:00:00', now: now16, durationDays: 30 });
  ok('Sourab: from today 16 Sep + 30 days → 16 Oct 2026', r.newExpiryText === '16 Oct 2026' && fmt(r.newExpiry) === '2026-10-16 12:00:00' && r.case === 'ADMIN_FROM_TODAY', r);
  const auto = renewal.computeAdminRenewal({ base: 'AUTO', expiry: '2026-09-01 10:00:00', now: now16, durationDays: 30 });
  const shop = renewal.computeRenewal({ expiry: '2026-09-01 10:00:00', now: now16, durationDays: 30 });
  ok('AUTO = exactly the shop rule (15 days kept access → 7 counted → 9 Oct)', auto.newExpiryText === shop.newExpiryText && auto.newExpiryText === '9 Oct 2026' && auto.counted === 7, { auto, shop });
  ok('the late-renewal rule does not override "old expiry" (15 days late, still from 1 Sep)', renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2026-09-01 10:00:00', now: at('2026-09-30 09:00:00'), durationDays: 30 }).newExpiryText === '1 Oct 2026');
  ok('…nor "today" when the shop rule would count days', renewal.computeAdminRenewal({ base: 'TODAY', expiry: '2026-09-10 10:00:00', now: now16, durationDays: 30 }).newExpiryText === '16 Oct 2026');
  ok('month end: 31 Aug + 30 days = 30 Sep', renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2026-08-31 23:59:00', now: now16, durationDays: 30 }).newExpiryText === '30 Sep 2026');
  ok('month end: 31 Jan 2027 + 30 days = 2 Mar 2027 (February has 28 days)', renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2027-01-31 10:00:00', now: at('2027-02-10 10:00:00'), durationDays: 30 }).newExpiryText === '2 Mar 2027');
  const late = renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2026-09-30 23:30:00', now: now16, durationDays: 30 });
  ok('India time late at night is kept (30 Sep 23:30 IST → 30 Oct 23:30, not shifted to UTC)', fmt(late.newExpiry) === '2026-10-30 23:30:00' && late.newExpiryText === '30 Oct 2026', fmt(late.newExpiry));
  ok('3-month plan from old expiry: 1 Sep + 90 days = 30 Nov', renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2026-09-01 10:00:00', now: now16, durationDays: 90 }).newExpiryText === '30 Nov 2026');
  ok('still running + "old expiry" = no gap (same as renewing early)', renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: '2026-09-20 10:00:00', now: now16, durationDays: 30 }).newExpiryText === '20 Oct 2026');
  ok('still running + "today" says the remaining days are dropped', /not added/.test(renewal.computeAdminRenewal({ base: 'TODAY', expiry: '2026-09-20 10:00:00', now: now16, durationDays: 30 }).message));
  ok('no expiry on file → starts today', renewal.computeAdminRenewal({ base: 'EXPIRY', expiry: null, now: now16, durationDays: 30 }).newExpiryText === '16 Oct 2026');
  ok('unknown base → AUTO', renewal.normBase('hack') === 'AUTO' && renewal.normBase('expiry') === 'EXPIRY' && renewal.normBase(' today ') === 'TODAY');
  const bases = quick.renewBases({ sub: { expiry_date: '2026-09-01 10:00:00' }, renewal: { preview: { newExpiryText: '9 Oct 2026', message: 'rule' } } }, 30, now16);
  ok('renew-quote bases: all three dates for the live preview', bases.AUTO.newExpiryText === '9 Oct 2026' && bases.EXPIRY.newExpiryText === '1 Oct 2026' && bases.TODAY.newExpiryText === '16 Oct 2026', bases);

  // ==================================================================== 2. fulfil applies it (real fulfill.js)
  section('fulfilment applies the admin choice; storefront orders keep the shop rule');
  const fulfill = require('../fulfill');
  const order = require('../order');
  const exp15 = new Date(Date.now() - 15 * DAY); exp15.setHours(10, 0, 0, 0);
  function baseF(orderOver) {
    F = {
      writes: [], emails: 0, bankLookups: 0,
      plans: [{ service: 'Prime Video', plan: '1 Month', duration_days: 30, price: 129, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY' }) }],
      accounts: [{ service: 'Prime', account_id: 'PRI-B', login_id: 'b@prime', password: 'pb', is_active: 'TRUE' }],
      caps: [{ service: 'Prime', account_id: 'PRI-B', max_total: 4, max_tv: 2, is_active: 'TRUE' }],
      subs: [{ sub_id: 'SUB-SOURAB', service: 'Prime Video', plan: '1 Month', phone: '9876543210', email: 's@x', expiry_date: fmt(exp15), inventory_ref: 'PRI-B', account_id: 'PRI-B', login_id: 'b@prime', password: 'pb', profile_name: '', profile_pin: '', profile_number: '', device_type: 'NON_TV', device_count: 1, tv_count: 0, status: 'ACTIVE', removed: 0, removed_at: null }],
      orders: [Object.assign({ order_id: 'FF-R1', service: 'Prime Video', plan: '1 Month', name: 'Mohammad Sourab', email: 's@x', phone: '9876543210', phone_norm: '9876543210', duration_days: 30, status: 'PAID', fulfillment_status: 'PENDING', extra_field_value: '', device_count: 1, tv_count: 0, source: 'node', final_amount: 129, order_type: 'RENEW', renew_sub_id: 'SUB-SOURAB', raw_json: '{}' }, orderOver || {})],
    };
  }
  const subExp = () => F.subs[0].expiry_date;
  const plusDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  baseF({ raw_json: JSON.stringify({ CreatedVia: 'ADMIN', RenewBase: 'EXPIRY' }) });
  let f = await fulfill.fulfillForAdmin('FF-R1');
  ok('admin RenewBase EXPIRY: new expiry = old expiry + 30 days', f.fulfillment === 'FULFILLED' && subExp() === fmt(plusDays(exp15, 30)), { f, exp: subExp() });
  baseF({ raw_json: JSON.stringify({ CreatedVia: 'ADMIN', RenewBase: 'TODAY' }) });
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('admin RenewBase TODAY: new expiry = today + 30 days', f.fulfillment === 'FULFILLED' && subExp().slice(0, 10) === fmt(plusDays(new Date(), 30)).slice(0, 10), subExp());
  baseF({ raw_json: JSON.stringify({ CreatedVia: 'ADMIN', RenewBase: 'AUTO' }) });
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('admin AUTO: shop rule (today + 30 − 7 counted days)', subExp().slice(0, 10) === fmt(plusDays(new Date(), 23)).slice(0, 10), subExp());
  baseF({ raw_json: JSON.stringify({ RenewBase: 'EXPIRY' }) });
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('a RenewBase without CreatedVia ADMIN is ignored (storefront keeps the shop rule)', subExp().slice(0, 10) === fmt(plusDays(new Date(), 23)).slice(0, 10), subExp());

  section('credit renewal: access now, unpaid, no coins');
  const creditRaw = JSON.stringify({ CreatedVia: 'ADMIN', RenewBase: 'EXPIRY', Credit: true, CreditAmount: 129, CreditDueDate: '2026-09-19', CreditStatus: 'OPEN' });
  baseF({ status: 'CREDIT', raw_json: creditRaw });
  coinCalls.length = 0;
  f = await fulfill.fulfillAndGetAccess('FF-R1', { phone: '9876543210' });
  ok('storefront fulfil path never delivers a CREDIT order', f.fulfillment === 'PENDING' && F.writes.length === 0, f);
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('admin fulfil without allowCredit does not either', f.fulfillment === 'PENDING' && F.writes.length === 0, f);
  f = await fulfill.fulfillForAdmin('FF-R1', { allowCredit: true });
  await new Promise((res) => setTimeout(res, 20));
  ok('admin credit fulfil renews the plan (from old expiry) and emails the login', f.fulfillment === 'FULFILLED' && subExp() === fmt(plusDays(exp15, 30)) && F.emails === 1, { f, exp: subExp() });
  ok('…the order stays CREDIT (unpaid) and no coins are given', F.orders[0].status === 'CREDIT' && coinCalls.length === 0, { st: F.orders[0].status, coinCalls });
  baseF({ status: 'CREDIT', raw_json: JSON.stringify({ CreatedVia: 'ADMIN' }), order_type: 'RENEW' });
  f = await fulfill.fulfillForAdmin('FF-R1', { allowCredit: true });
  ok('status CREDIT without raw_json Credit=true is refused', f.fulfillment === 'PENDING', f);
  baseF({ status: 'PAID', raw_json: '{}' });
  coinCalls.length = 0;
  await fulfill.fulfillForAdmin('FF-R1');
  await new Promise((res) => setTimeout(res, 20));
  ok('a normal paid renewal still earns coins on delivery', coinCalls.length === 1 && coinCalls[0].event === 'RENEW', coinCalls);

  section('storefront: no customer credit');
  baseF({ status: 'CREDIT', raw_json: creditRaw });
  let v = await order.verifyPayment('FF-R1');
  ok('verifyPayment on a CREDIT order: already active, never consumes a bank line', v.credit === true && v.paid === false && F.bankLookups === 0 && F.orders[0].status === 'CREDIT', v);
  v = await order.adminMarkPaid('FF-R1', 'ADMIN-UPI');
  ok('generic mark paid refuses a credit order (use 💳 Mark paid so the amount is recorded)', v.ok === false && v.credit === true, v);
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('storefront createRenewOrder passes only useCoins (no rawExtra / amountOverride / credit)', /createRenewOrder: async \(a\) => \(storeMod && await storeMod\.guard\(\)\) \|\| order\.createRenewOrder\(a\[0\], a\[1\], a\[2\], \{ useCoins: a\[3\] === true \}\)/.test(serverJs));
  const authJs = fs.readFileSync(path.join(__dirname, '..', 'customerauth.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('no new storefront action: customerauth has no credit / receivable rule; index.html never sends renewBase or payment CREDIT', !/receivable|markCredit|creditRenew/i.test(authJs) && !/renewBase|RenewBase|payment:\s*'CREDIT'/.test(indexHtml));

  // ==================================================================== 3. credit.js pure rules
  section('receivables, overdue and the Today card');
  const nowT = Date.now();
  const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
  const mkOrder = (id, over, raw) => Object.assign({ order_id: id, created_at_sheet: fmt(new Date(nowT - 5 * DAY)), name: 'Mohammad Sourab', phone_norm: '9876543210', email: 's@x', service: 'Prime Video', plan: '1 Month', final_amount: 129, status: 'CREDIT', order_type: 'RENEW', renew_sub_id: 'SUB-SOURAB', txn_ref: null, raw_json: JSON.stringify(Object.assign({ CreatedVia: 'ADMIN', Credit: true, CreditAmount: 129, CreditDueDate: ist(nowT - 2 * DAY), CreditCreatedAt: new Date(nowT - 5 * DAY).toISOString(), CreditStatus: 'OPEN' }, raw || {})) }, over || {});
  const rows = [
    mkOrder('FF1'),
    mkOrder('FF2', { phone_norm: '9000000002', name: 'Asha', final_amount: 199, renew_sub_id: 'SUB-2' }, { CreditAmount: 199, CreditDueDate: ist(nowT + 3 * DAY), CreditPayments: [{ amount: 50, key: 'x' }] }),
    mkOrder('FF3', { phone_norm: '9876543210', final_amount: 99, renew_sub_id: 'SUB-3' }, { CreditAmount: 99, CreditDueDate: ist(nowT + 1 * DAY) }),
    mkOrder('FF4', { status: 'PAID' }),
  ];
  const sum = credit.summarizeReceivables(rows);
  ok('total = what is still due (129 + 149 + 99), paid orders left out', sum.total === 377 && sum.count === 3, sum);
  ok('customers counted once per phone (2)', sum.customers === 2, sum);
  ok('overdue: due date passed → overdue, listed first, days since created', sum.overdue === 1 && sum.list[0].orderId === 'FF1' && sum.list[0].overdue === true && sum.list[0].overdueDays === 2 && sum.list[0].daysSince === 5, sum.list[0]);
  const card = credit.todayCard(sum);
  ok('Today card "💳 Receivables — ₹377 from 2 customers", red when overdue, opens Receivables', card.title === 'Receivables — ₹377 from 2 customers' && card.icon === '💳' && card.count === 2 && card.tone === 'bad' && card.go.view === 'receivables' && card.receivables.length === 3, card);
  ok('Today card when loading failed: count 0, says so', credit.todayCard({ error: 'x' }).count === 0);
  ok('default due date = 3 days (India date): 16 Sep 20:00 UTC is 17 Sep IST → 20 Sep', credit.defaultDueDate(new Date('2026-09-16T20:00:00Z')) === '2026-09-20');
  ok('due date check: bad text refused, empty → default', credit.parseDueDate('20/09/2026') === null && credit.parseDueDate('2026-02-30') === null && credit.parseDueDate('', new Date('2026-09-16T06:00:00Z')) === '2026-09-19');

  section('mark paid: exact → PAID, less → part payment, more → warn');
  const o1 = mkOrder('FF1');
  let st = credit.settle(o1, { amount: 129, method: 'upi', ref: 'UTR9', key: 'k1' });
  ok('exact amount → PAID, final amount 129, raw_json in step (Status/CreditStatus/payments)', st.action === 'PAID' && st.status === 'PAID' && st.finalAmount === 129 && st.raw.Status === 'PAID' && st.raw.CreditStatus === 'PAID' && st.raw.CreditPayments.length === 1 && st.raw.CreditPayments[0].method === 'UPI' && /UTR9/.test(st.txnRef), st);
  st = credit.settle(o1, { amount: 100, method: 'CASH', key: 'k2' });
  ok('₹100 of ₹129 with no choice → nothing written, "₹100 received but ₹129 due"', st.action === 'MISMATCH' && st.message === '₹100 received but ₹129 due.' && st.canPartial === true, st);
  st = credit.settle(o1, { amount: 100, method: 'CASH', key: 'k2', mode: 'PARTIAL' });
  ok('part payment → stays CREDIT with ₹29 still due', st.action === 'PARTIAL' && st.status === 'CREDIT' && st.left === 29 && st.raw.CreditStatus === 'PARTIAL' && st.raw.CreditPaid === 100, st);
  const o1b = Object.assign({}, o1, { raw_json: JSON.stringify(st.raw), txn_ref: st.txnRef });
  ok('after a part payment the list shows ₹29 due', credit.summarizeReceivables([o1b]).total === 29);
  ok('the same tap again (same key) is recorded once', credit.settle(o1b, { amount: 100, mode: 'PARTIAL', key: 'k2' }).action === 'ALREADY');
  const st2 = credit.settle(o1b, { amount: 29, method: 'UPI', key: 'k3' });
  ok('paying the remaining ₹29 → PAID for the full ₹129', st2.action === 'PAID' && st2.finalAmount === 129 && st2.raw.CreditPayments.length === 2, st2);
  st = credit.settle(o1, { amount: 150, key: 'k4' });
  ok('more than due → warns, part payment not offered', st.action === 'MISMATCH' && st.canPartial === false && /₹150 received but ₹129 due/.test(st.message), st);
  st = credit.settle(o1, { amount: 150, key: 'k4', mode: 'PARTIAL' });
  ok('…"part payment" of more than due is refused too', st.action === 'MISMATCH', st);
  st = credit.settle(o1, { amount: 120, key: 'k5', mode: 'FULL', note: 'small discount' });
  ok('accept ₹120 as full with a note → PAID for ₹120', st.action === 'PAID' && st.finalAmount === 120 && st.raw.CreditSettledNote === 'small discount', st);
  ok('zero amount refused; paid order → already', credit.settle(o1, { amount: 0 }).action === 'REFUSED' && credit.settle(mkOrder('FF4', { status: 'PAID' }), { amount: 5 }).action === 'ALREADY');

  section('cancel credit (write off)');
  let w = credit.writeOff(o1, 'forgiven');
  ok('nothing paid → WRITTEN_OFF, renewal untouched, ₹129 written off', w.action === 'WRITTEN_OFF' && w.status === 'WRITTEN_OFF' && w.raw.CreditWrittenOff === 129 && w.raw.CreditWriteOffNote === 'forgiven', w);
  w = credit.writeOff(o1b, '');
  ok('part paid → PAID for the ₹100 received, ₹29 written off', w.action === 'PAID' && w.finalAmount === 100 && w.raw.CreditWrittenOff === 29 && w.raw.CreditStatus === 'WRITTEN_OFF_PART', w);
  ok('already cancelled → already', credit.writeOff(Object.assign({}, o1, { status: 'WRITTEN_OFF' })).action === 'ALREADY');

  section('✉️ reminder email + 💬 WhatsApp text');
  const nowR = new Date('2026-09-16T06:30:00Z');
  const em = credit.reminderEmail({ name: 'Mohammad Sourab', service: 'Prime Video', plan: '1 Month', expiry: '2026-09-01 10:00:00', subId: 'SUB-SOURAB', now: nowR });
  ok('expired email: service, plan, "Expired on 1 Sep 2026", renew link the storefront opens', /Prime Video/.test(em.html) && /1 Month/.test(em.html) && /Expired on 1 Sep 2026/.test(em.html) && em.link === 'https://shop.fluxfilm.in/?source=push&renew=SUB-SOURAB' && em.html.includes('href="' + em.link.replace('&', '&amp;') + '"') && /has expired/.test(em.subject) && /Hi Mohammad,/.test(em.html), em);
  ok('the renew link matches the storefront deep link (source=push&renew=)', /q\.get\('source'\) !== 'push'/.test(indexHtml) && /q\.get\('renew'\)/.test(indexHtml));
  const emC = credit.reminderEmail({ name: 'Asha', service: 'Netflix', plan: 'Private 1M', expiry: '2026-10-01 10:00:00', subId: 'SUB-2', due: 149, dueDate: '2026-09-19', now: nowR });
  ok('credit email: amount due + due date, valid-till date (both in bold now)', /Amount due: ₹149/.test(emC.html) && /by <b>19 Sep 2026<\/b>/.test(emC.html) && /valid till <b>1 Oct 2026<\/b>/.test(emC.html) && /₹149 payment due/.test(emC.subject), emC);
  const emX = credit.reminderEmail({ name: '<script>x</script>', service: 'A&B', plan: '"1"', expiry: '2026-09-20 10:00:00', subId: 'S', now: nowR });
  ok('email escapes names / services', !/<script>/.test(emX.html) && /A&amp;B/.test(emX.html) && /4 days left/.test(emX.html), emX.html.slice(0, 300));
  const wt = credit.whatsappText({ name: 'Mohammad Sourab', service: 'Prime Video', plan: '1 Month', expiry: '2026-09-01 10:00:00', subId: 'SUB-SOURAB', now: nowR });
  ok('WhatsApp expired text: short lines, bold date, link on its own line', wt === ['Hi Mohammad,', '', '⏰ Your FluxFilm *Prime Video* (1 Month) *expired* on *1 Sep 2026*.', '', '👉 Renew in a minute:', 'https://shop.fluxfilm.in/?source=push&renew=SUB-SOURAB', '', 'Pick up right where you left off 💚'].join('\n'), wt);
  const wc = credit.whatsappText({ name: 'Asha K', service: 'Netflix', plan: 'Private 1M', expiry: '2026-10-01 10:00:00', subId: 'SUB-2', due: 149, dueDate: '2026-09-19', now: nowR });
  ok('WhatsApp credit text: renewed + the amount and both dates in bold', /^Hi Asha,\n\n✅ Your FluxFilm \*Netflix\* \(Private 1M\) is renewed — valid till \*1 Oct 2026\*\.\n\n💳 \*₹149\* is due by \*19 Sep 2026\*\./.test(wc), wc);
  const url = credit.waUrl('98765 43210', wt + ' & more?');
  ok('wa.me link: 91 + 10 digits, text fully encoded (spaces, &, ?, ₹, emoji) and decodes back', url.startsWith('https://wa.me/919876543210?text=') && !/[ &?]/.test(url.split('?text=')[1]) && decodeURIComponent(url.split('?text=')[1]) === wt + ' & more?', url);
  ok('credit WhatsApp link encodes ₹', credit.waUrl('9000000002', wc).includes(encodeURIComponent('₹149')));

  // ==================================================================== 4. admin routes on a JOIN-refusing fake DB
  section('admin routes (quick order credit, receivables, mark paid, cancel, reminders, Today)');
  const D = { orders: [], subs: [], customers: [], reminders: [], audit: [], sql: [] };
  function runD(sqlRaw, params) {
    const sql = nsql(sqlRaw); params = params || [];
    D.sql.push(sql);
    noJoin(sql);
    const find = (id) => D.orders.find((o) => o.order_id === id);
    if (/^INSERT INTO audit_log/.test(sql)) { D.audit.push({ action: params[0], id: params[2], summary: params[3] }); return { affectedRows: 1 }; }
    if (/^UPDATE orders SET status = 'CREDIT' WHERE order_id = \? AND UPPER\(status\) = 'CREATED'/.test(sql)) { const o = find(params[0]); if (!o || o.status !== 'CREATED') return { affectedRows: 0 }; o.status = 'CREDIT'; return { affectedRows: 1 }; }
    if (/^UPDATE orders SET status = \?, txn_ref = \?, final_amount = \?, raw_json = \?/.test(sql)) {
      const o = find(params[4]);
      if (!o || o.status !== 'CREDIT' || String(o.txn_ref || '') !== params[5]) return { affectedRows: 0 };
      Object.assign(o, { status: params[0], txn_ref: params[1], final_amount: params[2], raw_json: params[3] });
      if (/verified_at = NOW\(\)/.test(sql)) o.verified_at = 'now';
      return { affectedRows: 1 };
    }
    if (/FROM orders WHERE UPPER\(status\) = 'CREDIT' ORDER BY/.test(sql)) return D.orders.filter((o) => o.status === 'CREDIT').map(clone);
    if (/FROM orders WHERE order_id = \? LIMIT 1/.test(sql)) return D.orders.filter((o) => o.order_id === params[0]).map(clone);
    if (/FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'CREDIT'/.test(sql)) return D.orders.filter((o) => o.phone_norm === params[0] && o.status === 'CREDIT').map(clone);
    if (/^SELECT sub_id, order_id FROM subscriptions WHERE phone_norm/.test(sql)) return D.subs.filter((s) => s.phone_norm === params[0]).map((s) => ({ sub_id: s.sub_id, order_id: s.order_id }));
    if (/FROM subscriptions WHERE sub_id = \? LIMIT 1/.test(sql)) return D.subs.filter((s) => s.sub_id === params[0]).map(clone);
    if (/^SELECT phone_norm FROM subscriptions WHERE sub_id/.test(sql)) return D.subs.filter((s) => s.sub_id === params[0]).map((s) => ({ phone_norm: s.phone_norm }));
    if (/^SELECT name, email FROM customers WHERE phone_norm/.test(sql)) return D.customers.filter((c) => c.phone_norm === params[0]).map(clone);
    if (/FROM reminder_log WHERE sub_id = \? AND kind = 'ADMIN_REMINDER'/.test(sql)) {
      const list = D.reminders.filter((x) => x.sub_id === params[0] && x.ok);
      if (!list.length) return [{ last: null, recent: null }];
      return [{ last: fmt(new Date(Math.max(...list.map((x) => x.ms)))), recent: list.filter((x) => x.ms > Date.now() - 12 * 3600e3).length }];
    }
    if (/FROM reminder_log WHERE kind = 'ADMIN_REMINDER' AND ok = 1 AND sub_id IN/.test(sql)) {
      const out = {}; for (const x of D.reminders) if (x.ok && params.includes(x.sub_id)) out[x.sub_id] = Math.max(out[x.sub_id] || 0, x.ms);
      return Object.keys(out).map((k) => ({ sub_id: k, last: fmt(new Date(out[k])) }));
    }
    if (/^INSERT INTO reminder_log/.test(sql)) { D.reminders.push({ sub_id: params[0], kind: params[2], ok: params[4] === 1, ms: Date.now() }); return { affectedRows: 1 }; }
    if (/^(UPDATE|INSERT|DELETE)/.test(sql)) return { affectedRows: 1 };
    return [];
  }
  const dbD = { ENABLED: true, query: async (sql, p) => runD(sql, p), getPool: () => null, ping: async () => ({ ok: true }) };
  Module._load = function (req) {
    if (req === './db') return dbD;
    if (req === './coins') return fakeCoins;
    return origLoad.apply(this, arguments);
  };
  const fakeOrder = {
    renewQuote: async (sid, plan) => ({ ok: true, sub: { sub_id: sid, service: 'Prime Video', plan: '1 Month', expiry_date: '2026-09-01 10:00:00' }, plan: plan || '1 Month', price: 129, earlyDiscount: 0, amount: 129, daysLeft: -15, renewal: { mode: 'SAME', preview: { newExpiryText: '9 Oct 2026', message: 'rule' } } }),
    createRenewOrder: async (sid, plan, cc, o) => {
      D.lastRenew = { sid, plan, o };
      const id = 'FF' + (100 + D.orders.length);
      D.orders.push({ order_id: id, created_at_sheet: fmt(new Date()), name: 'Mohammad Sourab', phone_norm: '9876543210', email: 's@x', service: 'Prime Video', plan: '1 Month', final_amount: Number(o.amountOverride), status: 'CREATED', order_type: 'RENEW', renew_sub_id: sid, txn_ref: null, raw_json: JSON.stringify(Object.assign({ Status: 'CREATED' }, o.rawExtra)) });
      return { ok: true, orderId: id, amount: Number(o.amountOverride), upiLink: 'upi://x' };
    },
    adminMarkPaid: async () => ({ ok: true }),
  };
  const fulfilCalls = [];
  const fakeFulfill = { fulfillForAdmin: async (id, opts) => { fulfilCalls.push({ id, opts }); return { ok: true, fulfillment: 'FULFILLED', newExpiryText: '1 Oct 2026', access: { user: 'b@prime' } }; } };
  const PLANS = [{ service: 'Prime Video', plan: '1 Month', price: 129, durationDays: 30, allocationPolicy: 'CAPACITY', extraFieldKey: 'PRIME_DEVICE_TYPE' }];
  const fakeCatalog = { getBootstrap: async () => ({ ok: true, plans: PLANS }), getStockLevels: async () => ({ ok: true, levels: {} }) };
  const referralCalls = [];
  const sent = [];
  const fakeMailer = { send: async (to, subject, html) => { sent.push({ to, subject, html }); return { ok: true, sender: 'support@fluxfilm.in' }; } };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, {
    db: dbD, ADMIN_KEY: 'k', sync: require('../sync'),
    quick: { order: fakeOrder, fulfill: fakeFulfill, catalog: fakeCatalog },
    credit: { coins: fakeCoins, referrals: { onOrderPaid: async (id) => { referralCalls.push(id); return {}; } }, mailer: fakeMailer },
  });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const x = await fetch(base + p, { headers: H }); return { status: x.status, body: await x.json() }; };
  const post = async (p, b) => { const x = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() }; };
  D.subs.push({ sub_id: 'SUB-SOURAB', order_id: 'FF-OLD', phone_norm: '9876543210', email: 'old@x', service: 'Prime Video', plan: '1 Month', expiry_date: fmt(new Date(Date.now() - 15 * DAY)), status: 'ACTIVE' });
  D.customers.push({ phone_norm: '9876543210', name: 'Mohammad Sourab', email: 'sourab@x.com' });

  let q = await get('/admin/api/quick/renew-quote?sub_id=SUB-SOURAB');
  ok('renew-quote returns the three start choices with their dates + old expiry text + default due date', q.body.ok && q.body.bases.EXPIRY.newExpiryText === '1 Oct 2026' && q.body.bases.AUTO.newExpiryText === '9 Oct 2026' && q.body.expiryText === '1 Sep 2026' && q.body.defaultBase === 'AUTO' && /^\d{4}-\d{2}-\d{2}$/.test(q.body.creditDueDate), q.body);
  q = await get('/admin/api/credit/receivables');
  ok('no credit yet → ₹0', q.body.ok && q.body.total === 0 && q.body.count === 0, q.body);

  let rr = await post('/admin/api/quick/order', { mode: 'NEW', phone: '9876543210', name: 'X', service: 'Prime Video', plan: '1 Month', tvCount: 0, amount: 129, payment: 'CREDIT' });
  ok('credit on a NEW order is refused', rr.status === 400 && /only for renewals/.test(rr.body.message), rr.body);
  rr = await post('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-SOURAB', amount: 0, payment: 'CREDIT' });
  ok('credit of ₹0 refused', rr.status === 400 && rr.body.field === 'amount', rr.body);
  rr = await post('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-SOURAB', amount: 129, payment: 'CREDIT', creditDueDate: 'tomorrow' });
  ok('unreadable due date refused', rr.status === 400 && rr.body.field === 'creditDueDate', rr.body);
  rr = await post('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-SOURAB', amount: 129, payment: 'CREDIT', creditDueDate: '2026-09-19', renewBase: 'EXPIRY', markPaid: true, notes: 'will pay Friday' });
  const cOrder = D.orders[D.orders.length - 1];
  const cRaw = JSON.parse(cOrder.raw_json);
  ok('credit renewal: order made with raw_json Credit, CreditAmount, CreditDueDate, CreditCreatedAt, RenewBase EXPIRY', rr.body.ok && cRaw.Credit === true && cRaw.CreditAmount === 129 && cRaw.CreditDueDate === '2026-09-19' && !isNaN(Date.parse(cRaw.CreditCreatedAt)) && cRaw.RenewBase === 'EXPIRY' && cRaw.CreatedVia === 'ADMIN' && cRaw.CreditStatus === 'OPEN', { body: rr.body, cRaw });
  ok('…status CREDIT (not PAID), delivered with allowCredit, markPaid ignored', rr.body.status === 'CREDIT' && cOrder.status === 'CREDIT' && fulfilCalls.length === 1 && fulfilCalls[0].opts.allowCredit === true && rr.body.fulfillment.fulfillment === 'FULFILLED' && rr.body.creditDueDate === '2026-09-19', { body: rr.body, fulfilCalls });
  ok('…change log says renewed on credit, from old expiry', D.audit.some((a) => a.action === 'quick.renew' && /on credit, due 2026-09-19/.test(a.summary) && /starts from old expiry/.test(a.summary)), D.audit);
  rr = await post('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-SOURAB', amount: 129, payMethod: 'UPI', renewBase: 'TODAY' });
  ok('paid-now renew records RenewBase TODAY (no credit fields)', rr.body.ok && D.lastRenew.o.rawExtra.RenewBase === 'TODAY' && D.lastRenew.o.rawExtra.Credit === undefined, D.lastRenew.o.rawExtra);
  rr = await post('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-SOURAB', amount: 129, renewBase: 'weird' });
  ok('unknown RenewBase → AUTO', D.lastRenew.o.rawExtra.RenewBase === 'AUTO', D.lastRenew.o.rawExtra);

  q = await get('/admin/api/credit/receivables');
  ok('receivables: ₹129 from 1 customer', q.body.total === 129 && q.body.customers === 1 && q.body.list[0].orderId === cOrder.order_id && q.body.list[0].subId === 'SUB-SOURAB' && /\*₹129\* is due/.test(q.body.list[0].whatsapp), q.body);
  const today = await get('/admin/api/today');
  const rc = today.body.items && today.body.items.find((i) => i.key === 'receivables');
  ok('Today shows "💳 Receivables — ₹129 from 1 customer" with the list', rc && rc.title === 'Receivables — ₹129 from 1 customer' && rc.count === 1 && rc.receivables[0].due === 129, rc);
  q = await get('/admin/api/credit/customer?phone=9876543210');
  ok('Customer 360: credit pill data by subscription', q.body.ok && q.body.bySub['SUB-SOURAB'] && q.body.bySub['SUB-SOURAB'].due === 129, q.body);

  coinCalls.length = 0;
  rr = await post('/admin/api/credit/mark-paid', { orderId: cOrder.order_id, amount: 100, method: 'CASH', key: 'a1' });
  ok('mark paid ₹100 of ₹129 → 409 "₹100 received but ₹129 due", nothing written', rr.status === 409 && rr.body.mismatch && rr.body.message === '₹100 received but ₹129 due.' && cOrder.status === 'CREDIT' && !JSON.parse(cOrder.raw_json).CreditPayments, rr.body);
  rr = await post('/admin/api/credit/mark-paid', { orderId: cOrder.order_id, amount: 100, method: 'CASH', key: 'a1', mode: 'PARTIAL' });
  ok('part payment: stays CREDIT, ₹29 left, no coins yet', rr.body.ok && rr.body.left === 29 && cOrder.status === 'CREDIT' && coinCalls.length === 0 && Number(cOrder.final_amount) === 129, { body: rr.body, st: cOrder.status });
  rr = await post('/admin/api/credit/mark-paid', { orderId: cOrder.order_id, amount: 100, method: 'CASH', key: 'a1', mode: 'PARTIAL' });
  ok('double tap (same key) → already, recorded once', rr.body.ok && rr.body.already && JSON.parse(cOrder.raw_json).CreditPayments.length === 1, rr.body);
  q = await get('/admin/api/credit/receivables');
  ok('receivables now ₹29', q.body.total === 29, q.body);
  rr = await post('/admin/api/credit/mark-paid', { orderId: cOrder.order_id, amount: 29, method: 'UPI', ref: 'UTR55', key: 'a2' });
  await new Promise((res) => setTimeout(res, 20));
  const paidRaw = JSON.parse(cOrder.raw_json);
  ok('remaining ₹29 → PAID, paid time set, final ₹129, raw_json in step', rr.body.ok && rr.body.status === 'PAID' && cOrder.status === 'PAID' && cOrder.verified_at === 'now' && Number(cOrder.final_amount) === 129 && paidRaw.Status === 'PAID' && paidRaw.FinalAmount === 129 && paidRaw.CreditStatus === 'PAID' && /UTR55/.test(cOrder.txn_ref), { body: rr.body, cOrder });
  ok('…coins credited now (RENEW on ₹129) + referral check run', coinCalls.length === 1 && coinCalls[0].event === 'RENEW' && coinCalls[0].amount === 129 && coinCalls[0].orderId === cOrder.order_id && referralCalls.includes(cOrder.order_id), { coinCalls, referralCalls });
  rr = await post('/admin/api/credit/mark-paid', { orderId: cOrder.order_id, amount: 29, method: 'UPI', key: 'a3' });
  ok('marking a paid credit again → already, no second coins', rr.body.ok && rr.body.already && coinCalls.length === 1, rr.body);
  ok('change log: part payment + paid', D.audit.filter((a) => /^credit\./.test(a.action)).map((a) => a.action).join() === 'credit.partial,credit.paid', D.audit);

  // over-payment + accept as full
  D.orders.push(mkOrder('FF-OVER', { renew_sub_id: 'SUB-SOURAB' }));
  rr = await post('/admin/api/credit/mark-paid', { orderId: 'FF-OVER', amount: 150, key: 'o1' });
  ok('₹150 for ₹129 → warn (no part option)', rr.status === 409 && rr.body.canPartial === false, rr.body);
  rr = await post('/admin/api/credit/mark-paid', { orderId: 'FF-OVER', amount: 150, key: 'o1', mode: 'FULL', note: 'tip' });
  ok('accept as full → PAID ₹150', rr.body.ok && D.orders.find((o) => o.order_id === 'FF-OVER').status === 'PAID' && Number(D.orders.find((o) => o.order_id === 'FF-OVER').final_amount) === 150, rr.body);

  // cancel credit
  D.orders.push(mkOrder('FF-FORGIVE', { renew_sub_id: 'SUB-SOURAB', final_amount: 49 }, { CreditAmount: 49 }));
  coinCalls.length = 0;
  rr = await post('/admin/api/credit/cancel', { orderId: 'FF-FORGIVE', note: 'old customer' });
  const fo = D.orders.find((o) => o.order_id === 'FF-FORGIVE');
  ok('cancel credit → WRITTEN_OFF, no coins, change log note', rr.body.ok && fo.status === 'WRITTEN_OFF' && JSON.parse(fo.raw_json).CreditWrittenOff === 49 && coinCalls.length === 0 && D.audit.some((a) => a.action === 'credit.cancel' && /old customer/.test(a.summary)), { body: rr.body, fo });
  rr = await post('/admin/api/credit/cancel', { orderId: 'FF-FORGIVE' });
  ok('cancel again → already', rr.body.ok && rr.body.already, rr.body);
  rr = await post('/admin/api/credit/mark-paid', { orderId: 'FF-FORGIVE', amount: 49, key: 'z' });
  ok('a cancelled credit cannot be marked paid', rr.status === 400, rr.body);
  // stale write: someone else recorded a payment meanwhile (txn_ref changed)
  D.orders.push(mkOrder('FF-RACE'));
  const race = D.orders.find((o) => o.order_id === 'FF-RACE');
  const origRun = dbD.query;
  dbD.query = async (sql, p) => { const out = await origRun(sql, p); if (/FROM orders WHERE order_id = \? LIMIT 1/.test(nsql(sql)) && p[0] === 'FF-RACE') race.txn_ref = 'CREDIT-P1'; return out; };
  rr = await post('/admin/api/credit/mark-paid', { orderId: 'FF-RACE', amount: 129, key: 'r1' });
  dbD.query = origRun;
  ok('two devices at once: the stale one gets 409 "changed meanwhile", nothing overwritten', rr.status === 409 && rr.body.changed && race.status === 'CREDIT', rr.body);

  section('✉️ reminder routes: preview, send (mocked), 12-hour limit');
  let pv = await get('/admin/api/credit/remind-preview?sub_id=SUB-SOURAB');
  ok('preview: to = profile email, subject, html with service / expiry / link, WhatsApp link', pv.body.ok && pv.body.to === 'sourab@x.com' && /payment due/.test(pv.body.subject) && /Prime Video/.test(pv.body.html) && new RegExp('Expired on ' + exp15.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][exp15.getMonth()] + ' ' + exp15.getFullYear()).test(pv.body.html) && pv.body.link.endsWith('renew=SUB-SOURAB') && pv.body.waUrl.startsWith('https://wa.me/919876543210?text=') && pv.body.rateLimited === false, pv.body);
  ok('preview includes the ₹ due of an open credit on this plan (FF1-style row)', /Amount due: ₹129/.test(pv.body.html) && /\*₹129\* is due/.test(pv.body.whatsapp), pv.body.whatsapp);
  let se = await post('/admin/api/credit/remind-email', { subId: 'SUB-SOURAB' });
  ok('send: support@ mailer called once with the previewed email, logged, change log', se.body.ok && sent.length === 1 && sent[0].to === 'sourab@x.com' && sent[0].subject === pv.body.subject && sent[0].html === pv.body.html && D.reminders.length === 1 && D.audit.some((a) => a.action === 'remind.email' && a.id === 'SUB-SOURAB'), { body: se.body, sent: sent.length });
  se = await post('/admin/api/credit/remind-email', { subId: 'SUB-SOURAB' });
  ok('second send within 12 h → 429 with the last-sent time, no email', se.status === 429 && se.body.rateLimited && se.body.lastSentAt && sent.length === 1, se.body);
  pv = await get('/admin/api/credit/remind-preview?sub_id=SUB-SOURAB');
  ok('preview now warns (rateLimited + lastSentAt)', pv.body.rateLimited === true && !!pv.body.lastSentAt, pv.body);
  D.reminders[0].ms -= 13 * 3600e3;
  se = await post('/admin/api/credit/remind-email', { subId: 'SUB-SOURAB' });
  ok('after 12 hours it can be sent again', se.body.ok && sent.length === 2, se.body);
  q = await get('/admin/api/credit/customer?phone=9876543210');
  ok('Customer 360 gets the last emailed time per subscription', !!q.body.lastReminded['SUB-SOURAB'], q.body);
  D.subs.push({ sub_id: 'SUB-NOMAIL', order_id: '', phone_norm: '9111111111', email: '', service: 'Netflix', plan: 'Private 1M', expiry_date: fmt(new Date()), status: 'ACTIVE' });
  se = await post('/admin/api/credit/remind-email', { subId: 'SUB-NOMAIL' });
  ok('no email address → 400, nothing sent', se.status === 400 && sent.length === 2, se.body);
  const failMailer = fakeMailer.send;
  fakeMailer.send = async () => { throw new Error('SMTP down'); };
  D.subs.push({ sub_id: 'SUB-FAIL', order_id: '', phone_norm: '9222222222', email: 'f@x', service: 'Netflix', plan: 'Private 1M', expiry_date: fmt(new Date()), status: 'ACTIVE' });
  se = await post('/admin/api/credit/remind-email', { subId: 'SUB-FAIL' });
  fakeMailer.send = failMailer;
  ok('SMTP failure → 502, logged as not ok (does not block a retry)', se.status === 502 && D.reminders.some((x) => x.sub_id === 'SUB-FAIL' && !x.ok), se.body);
  ok('every SQL above was single-table (no JOIN)', !D.sql.some((x) => /\bJOIN\b/i.test(x) && /credit|reminder_log|CREDIT/.test(x)));
  ok('wrong admin key → 403', (await fetch(base + '/admin/api/credit/receivables', { headers: { 'X-Admin-Key': 'nope' } })).status === 403);

  section('admin panel');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true;
  for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline script parses', scripts.length > 0 && parsed);
  ok('Quick order renew: "Start the new period from" (shop rule / old expiry / today) with live new expiry', /Start the new period from/.test(html) && /function qBaseHtml\(/.test(html) && /id="q_rbase"/.test(html) && /body\.renewBase = Q\.rbase/.test(html));
  ok('Quick order renew: Payment Paid now / 💳 On credit with amount due + due date', /💳 On credit \(pay later\)/.test(html) && /id="q_cdue"/.test(html) && /body\.payment = 'CREDIT'/.test(html) && /💳 Renew on credit/.test(html));
  ok('Receivables screen + menu, Today list with ✅ Mark paid / 💬 / ✉️', /\['receivables', '💳', 'Receivables'\]/.test(html) && /receivables: receivablesView/.test(html) && /function crTodayList\(/.test(html) && /data-crpay=/.test(html) && /data-crwa=/.test(html) && /data-crmail=/.test(html));
  ok('Mark paid dialog: amount / UPI·Cash·Bank / reference; mismatch → part payment or accept as full; cancel credit', /function crPayDialog\(/.test(html) && /Part payment — keep/.test(html) && /as full payment/.test(html) && /function crCancel\(/.test(html));
  ok('Customer 360 card: credit pill + ✉️ Email reminder + improved 💬 text; order page credit box', /💳 Credit ' \+ money\(c\.due\) \+ ' due'/.test(html) && /✉️ Email reminder/.test(html) && /crSubExtras\(s, d, stopped\)/.test(html) && /id="od_credit"/.test(html) && /function crLoadOrder\(/.test(html));
  ok('generic ✅ Mark paid hidden on CREDIT / WRITTEN_OFF orders', /REFUNDED\|CREDIT\|WRITTEN_OFF/.test(html));
  // The card still renders when grabbed alone (other tests do that): extras are guarded.
  const grab = (name) => { const i = html.indexOf('function ' + name + '('); let depth = 0; const j = html.indexOf('{', i); for (let k = j; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); } } return ''; };
  const cardFn = new Function('return (function(){ var S = { cust: { profile: { name: "Mohammad Sourab" } } }; var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; function esc(v){return String(v==null?"":v);} function money(n){return "₹"+n;} function statusPill(){return "";} function svcIcon(){return "";} function waLink(p,t){return "wa:"+encodeURIComponent(t);} ' + grab('prettyDate') + grab('istDate') + grab('daysLeft') + grab('waClean') + grab('waName') + grab('waJoin') + grab('waYmd') + grab('crRenewLink') + grab('waRemindText') + grab('crFirst') + grab('crWaText') + grab('crDuePill') + grab('crExtrasInner') + grab('crSubExtras') + grab('subCard') + ' return subCard; })()')();
  const expiredCard = cardFn({ sub_id: 'SUB-SOURAB', service: 'Prime Video', plan: '1 Month', phone: '9876543210', status: 'ACTIVE', expiry_date: '2026-09-01 10:00:00', start_date: '2026-08-02 10:00:00' });
  ok('expired card: ✉️ Email reminder + the 💬 Remind text, named, bold date, real renew link', /crRemindDialog\('SUB-SOURAB'\)/.test(expiredCard) && expiredCard.includes(encodeURIComponent(['Hi Mohammad,', '', '⏰ Your FluxFilm *Prime Video* (1 Month) *expired* on *1 Sep 2026*.', '', '👉 Renew in a minute:', 'https://shop.fluxfilm.in/?source=push&renew=SUB-SOURAB', '', 'Pick up right where you left off 💚'].join('\n'))), expiredCard.slice(-900));
  const farCard = cardFn({ sub_id: 'SUB-FAR', service: 'Netflix', plan: 'Private 1M', phone: '9876543210', status: 'ACTIVE', expiry_date: fmt(new Date(Date.now() + 40 * DAY)), start_date: fmt(new Date()) });
  ok('plan with 40 days left: no ✉️ reminder button', !/crRemindDialog/.test(farCard));
  const alone = new Function('return (function(){ var MON = ["Jan"]; function esc(v){return String(v==null?"":v);} function statusPill(){return "";} function svcIcon(){return "";} function waLink(){return "#";} function prettyDate(v){return String(v||"");} function crRenewLink(id){return "#"+id;} ' + grab('waClean') + grab('waName') + grab('waJoin') + grab('waYmd') + grab('waRemindText') + grab('istDate') + grab('daysLeft') + grab('subCard') + ' return subCard; })()')();
  ok('subCard alone (without the credit block, which is optional) still renders', /⏱ Extend/.test(alone({ sub_id: 'S', status: 'ACTIVE', expiry_date: '2026-09-01 10:00:00' })));
  ok('profit view labels money on credit as not counted', /💳 Not counted: /.test(html) && /creditDue/.test(fs.readFileSync(path.join(__dirname, '..', 'profit.js'), 'utf8')));
  const pkg = require('../package.json');
  ok('this test is in npm test', /node test\/credit-renewals\.test\.js/.test(pkg.scripts.test));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  console.log('\n---------------------------------------');
  console.log('credit-renewals: PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exit(1); });
