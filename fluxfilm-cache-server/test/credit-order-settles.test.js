/* 💳 A credit renewal the customer has actually paid must settle itself from the bank alert.
 *
 * settleNamedOrders() (28 Sep 2026) already pays an order whose bank alert names it, with no checkout page
 * involved. It goes through order.verifyPayment(), and verifyPayment refuses status CREDIT on purpose — the plan
 * is already running and the money is a receivable, so the checkout page must never "confirm" one. The side
 * effect: the ONE kind of order nobody polls for (the owner creates it; there is no page at all) was the one kind
 * a bank alert could never settle.
 *
 * Amit Sharma, 1 Oct 2026 — FF6638684, ₹99 Netflix Group Offer renewal put on credit at 21:31. He paid at 21:35
 * and the alert said "...UPI REF NO 949044591697 P2P-AMIT SHARMA-FF6638684-ICIC0000190...". It still sat in
 * 💳 Receivables until it was settled by hand.
 *
 * Real payments.js + real credit.js against a fake MySQL. No network, no bank, no mail. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const rawOf = (v) => { try { return JSON.parse(v) || {}; } catch (_) { return {}; } };

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────
let ORDERS, CREDITS, fulfilled, awarded, referred, ownerTold;
const creditRaw = (extra) => JSON.stringify(Object.assign({
  Credit: true, CreditAmount: 99, CreditStatus: 'OPEN', CreditCreatedAt: '2026-10-01T21:31:00+05:30', CreditDueDate: '2026-10-04',
}, extra || {}));

const reset = () => {
  ORDERS = {
    // Amit: the real case. On credit, nothing paid against it yet.
    FF6638684: { order_id: 'FF6638684', created_at_sheet: '2026-10-01 21:31:06', name: 'Amit Sharma', phone_norm: '8218860194',
      email: 'amit@example.com', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', final_amount: 99, status: 'CREDIT',
      source: 'node', order_type: 'RENEW', renew_sub_id: 'SUB-014023927', txn_ref: null, raw_json: creditRaw() },
    // an ordinary unpaid order — the path that already worked, and must keep working
    FF1000001: { order_id: 'FF1000001', service: 'Prime Video', plan: '1 Month', final_amount: 129, status: 'CREATED',
      source: 'node', order_type: 'NEW', txn_ref: null, raw_json: '{}' },
    // a credit renewal the owner has already taken ₹50 against
    FF2000002: { order_id: 'FF2000002', name: 'Part Paid', phone_norm: '9000000002', service: 'Zee5', plan: '1 Year',
      final_amount: 299, status: 'CREDIT', source: 'node', order_type: 'RENEW', txn_ref: 'CREDIT-P1',
      raw_json: creditRaw({ CreditAmount: 299, CreditStatus: 'PARTIAL', CreditPaid: 50, CreditPayments: [{ at: '2026-10-01T10:00:00+05:30', amount: 50, method: 'CASH', ref: '', key: 'hand-1', note: '' }] }) },
    // an old-site credit row: it cannot be marked paid here
    FF3000003: { order_id: 'FF3000003', service: 'Netflix', plan: 'Private 1M', final_amount: 249, status: 'CREDIT',
      source: 'sheet', order_type: 'RENEW', txn_ref: null, raw_json: creditRaw({ CreditAmount: 249 }) },
    // already settled
    FF4000004: { order_id: 'FF4000004', service: 'Netflix', plan: 'Sharing 1M', final_amount: 99, status: 'PAID',
      source: 'node', order_type: 'RENEW', txn_ref: 'ADMIN-CREDIT-UPI', raw_json: creditRaw({ CreditStatus: 'PAID' }) },
  };
  CREDITS = [
    { id: 295679, upi_ref: '949044591697', amount: 99, order_ids: 'FF6638684', consumed_order_id: null, hoursAgo: 1,
      raw: 'Dear Customer, An amount of INR 99.00 has been credited to A/c XXXXXXXX9982 Ref on account of UPI REF NO 949044591697 P2P-AMIT SHARMA-FF6638684-ICIC0000190- HEAD OFFICE value 01-10-26 .' },
    { id: 11, upi_ref: '111111111111', amount: 129, order_ids: 'FF1000001', consumed_order_id: null, hoursAgo: 1, raw: '' },
    { id: 22, upi_ref: '222222222222', amount: 299, order_ids: 'FF2000002', consumed_order_id: null, hoursAgo: 1, raw: '' },
    { id: 33, upi_ref: '333333333333', amount: 249, order_ids: 'FF3000003', consumed_order_id: null, hoursAgo: 1, raw: '' },
    // already settled: its payment was consumed when it was settled, which is why no sweep looks at it again
    { id: 44, upi_ref: '444444444444', amount: 99, order_ids: 'FF4000004', consumed_order_id: 'FF4000004', hoursAgo: 1, raw: '' },
  ];
  fulfilled = []; awarded = []; referred = []; ownerTold = [];
};

const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); const p = params || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);

    // settleNamedOrders' read
    if (/^SELECT id, order_ids, amount FROM bank_credits WHERE consumed_order_id IS NULL/.test(q)) {
      const hours = Number(p[1]);
      return CREDITS.filter((c) => !c.consumed_order_id && String(c.order_ids) !== p[0] && c.hoursAgo <= hours)
        .map((c) => ({ id: c.id, order_ids: c.order_ids, amount: c.amount }));
    }
    // settleCreditOrder's order read
    if (/^SELECT order_id, created_at_sheet, name, phone_norm, email, service, plan, final_amount, status, source, order_type, renew_sub_id, txn_ref, raw_json FROM orders WHERE order_id = \? LIMIT 1$/.test(q)) {
      const o = ORDERS[p[0]]; return o ? [Object.assign({}, o)] : [];
    }
    // findByOrder: take an unused credit, atomically
    if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE consumed_order_id IS NULL AND ROUND\(amount\) = ROUND\(\?\) AND FIND_IN_SET\(\?, order_ids\) > 0/.test(q)) {
      const [oid, amount, want] = p;
      const c = CREDITS.filter((x) => !x.consumed_order_id && Math.round(x.amount) === Math.round(amount)
        && String(x.order_ids).split(',').map((y) => y.trim()).includes(String(want)))
        .sort((a, b) => a.hoursAgo - b.hoursAgo)[0];
      if (!c) return { affectedRows: 0 };
      c.consumed_order_id = oid;
      return { affectedRows: 1 };
    }
    if (/^SELECT \* FROM bank_credits WHERE consumed_order_id = \? ORDER BY id DESC LIMIT 1$/.test(q)) {
      const list = CREDITS.filter((x) => x.consumed_order_id === p[0]).sort((a, b) => b.id - a.id);
      return list.length ? [Object.assign({}, list[0])] : [];
    }
    // the give-back
    if (/^UPDATE bank_credits SET consumed_order_id = NULL WHERE consumed_order_id = \?( AND id = \?)?$/.test(q)) {
      let n = 0;
      for (const c of CREDITS) if (c.consumed_order_id === p[0] && (p.length === 1 || c.id === p[1])) { c.consumed_order_id = null; n++; }
      return { affectedRows: n };
    }
    // credit.markPaidNow's write
    if (/^UPDATE orders SET status = \?, txn_ref = \?, final_amount = \?, raw_json = \?(, verified_at = NOW\(\))? WHERE order_id = \? AND UPPER\(status\) = 'CREDIT' AND COALESCE\(txn_ref, ''\) = \? LIMIT 1$/.test(q)) {
      const [status, txnRef, finalAmount, raw, oid, wantTxn] = p;
      const o = ORDERS[oid];
      if (!o || String(o.status).toUpperCase() !== 'CREDIT' || String(o.txn_ref || '') !== String(wantTxn)) return { affectedRows: 0 };
      Object.assign(o, { status, txn_ref: txnRef, final_amount: finalAmount, raw_json: raw });
      if (/verified_at/.test(q)) o.verified_at = '2026-10-01 21:44:00';
      return { affectedRows: 1 };
    }
    if (/FROM orders WHERE order_id = \?/.test(q)) { const o = ORDERS[p[0]]; return o ? [Object.assign({}, o)] : []; }
    return [];
  },
};

// order.verifyPayment and fulfill have their own suites; here they are recorded, because what is under test is
// WHO calls them and when. verifyPayment answers exactly as the real one does, CREDIT refusal included.
const CREDIT_VERIFY = { ok: true, found: true, paid: false, credit: true, message: 'already active' };
let verified = [];
const fakeOrder = {
  verifyPayment: async (oid) => {
    verified.push(oid);
    const o = ORDERS[oid];
    if (!o) return { ok: false, found: false };
    const st = String(o.status).toUpperCase();
    if (st === 'PAID') return { ok: true, found: true, paid: true };
    if (st === 'REFUNDED') return { ok: true, found: false, paid: false, refunded: true };
    if (st === 'CREDIT') return CREDIT_VERIFY;              // 💳 the refusal this test exists for
    const c = CREDITS.find((x) => !x.consumed_order_id && String(x.order_ids).split(',').includes(oid) && Math.round(x.amount) === Math.round(o.final_amount));
    if (!c) return { ok: true, found: false };
    c.consumed_order_id = oid; o.status = 'PAID';
    return { ok: true, found: true, paid: true };
  },
};
const fakeFulfill = { fulfillForAdmin: async (oid) => { fulfilled.push(oid); return { ok: true }; } };
const fakeCoins = {
  awardCoins: async (x) => { awarded.push(x); return { ok: true, coins: 1, balanceAfter: 2 }; },
  onOrderPaid: async () => ({ ok: true }),
};
const fakeReferrals = { onOrderPaid: async (oid) => { referred.push(oid); return { ok: true }; } };
const fakeOwnerNotify = { creditPaidLater: (oid, amt) => ownerTold.push(oid + ':' + amt) };
const fakeHooks = { kick: () => {} };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './order') return fakeOrder;
  if (req === './fulfill') return fakeFulfill;
  if (req === './coins') return fakeCoins;
  if (req === './referrals') return fakeReferrals;
  if (req === './ownernotify') return fakeOwnerNotify;
  if (req === './n8nhooks') return fakeHooks;
  return origLoad.apply(this, arguments);
};
const payments = require('../payments');
const credit = require('../credit');
// NOT restored here, on purpose: settleCreditOrder requires ./credit, ./order and ./fulfill LAZILY, at call time.
// Restoring the loader now would let the real modules run and answer "DB not configured" — a harness bug that
// looks exactly like a product bug. Put back after the last assertion.

(async () => {
  // ── the case that went wrong ─────────────────────────────────────────────────────────────────────────────
  section('a credit renewal the customer has paid settles itself');
  reset(); verified = [];
  let did = await payments.settleCreditOrder('FF6638684');
  let o = ORDERS.FF6638684;
  ok('it settles', did === true, { did, status: o.status });
  ok('the order is PAID', String(o.status).toUpperCase() === 'PAID', o.status);
  ok('the real UPI reference is on it, not a made-up one', /949044591697/.test(String(o.txn_ref)), o.txn_ref);
  ok('the bank payment is consumed, so it can never pay a second order', CREDITS[0].consumed_order_id === 'FF6638684');
  ok('₹99 is recorded as received', rawOf(o.raw_json).CreditPaid === 99 && rawOf(o.raw_json).CreditStatus === 'PAID', rawOf(o.raw_json));
  ok('the payment keeps the bank id, so the same credit cannot be recorded twice',
    (rawOf(o.raw_json).CreditPayments || [])[0].key === 'bank-295679', rawOf(o.raw_json).CreditPayments);
  ok('…and says it was matched automatically, not entered by the owner',
    /bank alert named this order/.test(((rawOf(o.raw_json).CreditPayments || [])[0] || {}).note || ''), (rawOf(o.raw_json).CreditPayments || [])[0]);
  ok('🔒 NOTHING is delivered again — a credit renewal was delivered when it was put on credit', !fulfilled.length, fulfilled);
  ok('the normal paid-order rules run, exactly as from 💳 Mark paid', awarded.length === 1 && referred.includes('FF6638684'), { awarded, referred });
  ok('the owner is told', ownerTold.includes('FF6638684:99'), ownerTold);

  section('and it happens through the sweep, with nobody watching a screen');
  reset(); verified = [];
  const r = await payments.settleNamedOrders(72);
  ok('the credit renewal is settled by the sweep', String(ORDERS.FF6638684.status).toUpperCase() === 'PAID', ORDERS.FF6638684.status);
  ok('🔒 the ordinary unpaid order still works too — no regression', String(ORDERS.FF1000001.status).toUpperCase() === 'PAID' && fulfilled.includes('FF1000001'), { st: ORDERS.FF1000001.status, fulfilled });
  ok('…and THAT one is delivered, because nothing had delivered it yet', fulfilled.length === 1 && fulfilled[0] === 'FF1000001', fulfilled);
  ok('the sweep counts both', r.paid === 2, r);
  ok('🔒 a payment already spent on an order is never looked at again', CREDITS.find((c) => c.id === 44).consumed_order_id === 'FF4000004');

  section('running twice does not take the money twice');
  const before = JSON.stringify(rawOf(ORDERS.FF6638684.raw_json).CreditPayments);
  await payments.settleNamedOrders(72);
  ok('🔒 one payment, one record', JSON.stringify(rawOf(ORDERS.FF6638684.raw_json).CreditPayments) === before, rawOf(ORDERS.FF6638684.raw_json).CreditPayments);
  ok('🔒 and ₹99 is not counted twice', rawOf(ORDERS.FF6638684.raw_json).CreditPaid === 99);

  // ── what it must NOT touch ───────────────────────────────────────────────────────────────────────────────
  section('what stays the owner\'s to decide');
  reset();
  ok('🔒 a part-paid credit renewal is left alone — the owner is mid-way through it',
    (await payments.settleCreditOrder('FF2000002')) === false && String(ORDERS.FF2000002.status).toUpperCase() === 'CREDIT', ORDERS.FF2000002.status);
  ok('…and its payment stays in the list for them', CREDITS.find((c) => c.id === 22).consumed_order_id === null);
  ok('🔒 an old-site (Sheet) credit row is refused', (await payments.settleCreditOrder('FF3000003')) === false && CREDITS.find((c) => c.id === 33).consumed_order_id === null);
  ok('🔒 an already-settled credit is not settled again', (await payments.settleCreditOrder('FF4000004')) === false
    && String(ORDERS.FF4000004.status).toUpperCase() === 'PAID', ORDERS.FF4000004.status);
  ok('🔒 an order we have never heard of is simply false, not a crash', (await payments.settleCreditOrder('FF0000000')) === false);
  ok('🔒 an empty id is refused before any query', (await payments.settleCreditOrder('')) === false);

  section('the amount has to match');
  reset();
  CREDITS[0].amount = 89;   // he paid ₹89 against a ₹99 credit
  ok('🔒 ₹89 does not settle a ₹99 credit', (await payments.settleCreditOrder('FF6638684')) === false, ORDERS.FF6638684.status);
  ok('…and the payment is still there, unused, for the owner to look at', CREDITS[0].consumed_order_id === null);
  reset();
  CREDITS[0].amount = 199;  // and neither does too much
  ok('🔒 ₹199 does not settle a ₹99 credit either', (await payments.settleCreditOrder('FF6638684')) === false && CREDITS[0].consumed_order_id === null);

  section('a refunded order can never come back as paid');
  reset();
  ORDERS.FF6638684.status = 'REFUNDED';
  ok('🔒 refunded stays refunded', (await payments.settleCreditOrder('FF6638684')) === false && ORDERS.FF6638684.status === 'REFUNDED');
  ok('…and the sweep leaves it too', (await payments.settleOne('FF6638684')) === false && CREDITS[0].consumed_order_id === null);

  // ── the money must never go missing ──────────────────────────────────────────────────────────────────────
  section('if settling fails, the payment goes straight back');
  reset();
  // Somebody records a payment from the admin dialog in the half-second between the match and the write: the
  // order's txn_ref moves, markPaidNow's guarded UPDATE matches nothing, and our claim on the credit is wrong.
  const realQuery = mockDb.query;
  let armed = true;
  mockDb.query = async (sql, p) => {
    if (armed && /^UPDATE orders SET status = \?, txn_ref = \?/.test(String(sql).replace(/\s+/g, ' ').trim())) { armed = false; return { affectedRows: 0 }; }
    return realQuery(sql, p);
  };
  did = await payments.settleCreditOrder('FF6638684');
  mockDb.query = realQuery;
  ok('it reports failure rather than claiming success', did === false, did);
  ok('🔒 the order is untouched', String(ORDERS.FF6638684.status).toUpperCase() === 'CREDIT' && !ORDERS.FF6638684.txn_ref, ORDERS.FF6638684);
  ok('🔒 THE PAYMENT IS BACK IN THE LIST — a taken credit that paid nothing would hide real money',
    CREDITS[0].consumed_order_id === null, CREDITS[0]);
  ok('…so the next sweep settles it', (await payments.settleCreditOrder('FF6638684')) === true && String(ORDERS.FF6638684.status).toUpperCase() === 'PAID');

  // ── one definition of the write ──────────────────────────────────────────────────────────────────────────
  section('the admin dialog and the sweep settle the same way');
  reset();
  let mp = await credit.markPaidNow({ db: mockDb }, ORDERS.FF6638684, { amount: 99, method: 'UPI', ref: 'x', key: 'k1' }, new Date('2026-10-01T21:44:00'));
  ok('markPaidNow settles in full', mp.action === 'PAID' && mp.written === true && mp.received === 99, mp);
  ok('…and hands back what the paid-order rules did, for the dialog to show', mp.extra && mp.extra.coins && mp.extra.coins.coins === 1, mp.extra);
  reset();
  mp = await credit.markPaidNow({ db: mockDb }, ORDERS.FF6638684, { amount: 50, method: 'UPI', ref: 'x', key: 'k2' }, new Date());
  ok('🔒 ₹50 against ₹99 with no decision writes NOTHING and asks', mp.action === 'MISMATCH' && !mp.written
    && String(ORDERS.FF6638684.status).toUpperCase() === 'CREDIT', mp);
  reset();
  mp = await credit.markPaidNow({ db: mockDb }, ORDERS.FF1000001, { amount: 129, method: 'UPI', key: 'k3' }, new Date());
  ok('🔒 an order that is not a credit is refused, not quietly paid', mp.action === 'REFUSED' && !mp.written, mp);

  // ── promises in the code ─────────────────────────────────────────────────────────────────────────────────
  section('the code');
  const csrc = fs.readFileSync(path.join(__dirname, '..', 'credit.js'), 'utf8');
  const psrc = fs.readFileSync(path.join(__dirname, '..', 'payments.js'), 'utf8');
  const nocomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const markPaidRoute = nocomment(csrc).split("app.post('/admin/api/credit/mark-paid'")[1].split("app.post('/admin/api/credit/cancel'")[0];
  ok('🔒 the Mark paid route no longer writes the row itself — it goes through markPaidNow, the same way the sweep does',
    /markPaidNow\(/.test(markPaidRoute) && !/UPDATE orders/.test(markPaidRoute), markPaidRoute.slice(0, 300));
  ok('…and markPaidNow is the only thing that settles a credit row (cancelling a credit is its own operation)',
    (nocomment(csrc).match(/UPDATE orders SET status = \?, txn_ref = \?, final_amount = \?, raw_json = \?/g) || []).length === 2);
  ok('🔒 the sweep takes the payment through findByOrder, never with its own UPDATE of consumed_order_id',
    !/UPDATE bank_credits SET consumed_order_id = \?/.test(nocomment(psrc).split('async function settleCreditOrder')[1].split('async function settleOne')[0]));
  ok('a credit renewal is never delivered a second time by this path',
    !/fulfillForAdmin/.test(nocomment(psrc).split('async function settleCreditOrder')[1].split('async function settleOne')[0]));
  ok('settleOne sends a credit order to settleCreditOrder', /if \(r && r\.credit\) return settleCreditOrder\(oid\)/.test(psrc));

  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('credit-order-settles: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { Module._load = origLoad; console.log('CRASH', e); process.exitCode = 1; });
