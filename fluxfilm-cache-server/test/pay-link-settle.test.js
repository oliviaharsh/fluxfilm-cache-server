/* 💳 A payment made from the payment link must pay the order by itself.
 *
 * The bug (found 28 Sep 2026, by tracing a claim I had made rather than re-reading the module's own comment):
 * the bank alert carries the order id and ingestCredit stored it — but the ONLY thing that ever consumed such a
 * credit was verifyPayment(), and the only thing that called verifyPayment() was the storefront checkout page
 * while the customer sat on it. /pay/:orderId/status just read orders.status. So anybody who paid from the link
 * — the whole point of which is that they are NOT on the checkout page — left the money unmatched and the order
 * on CREATED until somebody noticed by hand.
 *
 * Real payments.js + paylink.js against a fake MySQL. No network, no bank, no mail. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
process.env.PAYLINK_SECRET = 'test-secret-for-the-pay-token';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────
let ORDERS, CREDITS, verified, fulfilled;
const reset = () => {
  ORDERS = {
    FF1000001: { order_id: 'FF1000001', service: 'Prime Video', plan: '1 Month', final_amount: 129, status: 'CREATED', fulfillment_status: null, source: 'node' },
    FF2000002: { order_id: 'FF2000002', service: 'Netflix', plan: 'Private 1M', final_amount: 249, status: 'CREATED', fulfillment_status: null, source: 'node' },
    FF3000003: { order_id: 'FF3000003', service: 'Netflix', plan: 'Private 1M', final_amount: 249, status: 'PAID', fulfillment_status: 'FULFILLED', source: 'node' },
  };
  CREDITS = [
    { id: 11, order_ids: 'FF1000001', amount: 129, consumed_order_id: null, hoursAgo: 1 },
    { id: 12, order_ids: '', amount: 500, consumed_order_id: null, hoursAgo: 1 },          // paid to the plain backup QR: no order named
    { id: 13, order_ids: 'FF9999999', amount: 99, consumed_order_id: null, hoursAgo: 1 },  // names an order we do not have
    { id: 14, order_ids: 'FF2000002', amount: 249, consumed_order_id: null, hoursAgo: 900 }, // far too old for the window
  ];
  verified = []; fulfilled = [];
};

const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); const p = params || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    // the sweep's read
    if (/^SELECT id, order_ids, amount FROM bank_credits WHERE consumed_order_id IS NULL/.test(q)) {
      const hours = Number(p[1]);
      return CREDITS.filter((c) => !c.consumed_order_id && String(c.order_ids) !== p[0] && c.hoursAgo <= hours)
        .map((c) => ({ id: c.id, order_ids: c.order_ids, amount: c.amount }));
    }
    if (/FROM orders WHERE order_id = \?/.test(q)) { const o = ORDERS[p[0]]; return o ? [Object.assign({}, o)] : []; }
    return [];
  },
};

// order.verifyPayment and fulfill are the real seams; both are exercised by their own suites, so here they are
// recorded rather than re-run — what is under test is WHO calls them, and when.
const fakeOrder = {
  verifyPayment: async (oid) => {
    verified.push(oid);
    const o = ORDERS[oid];
    if (!o) return { ok: false, found: false };
    if (o.status === 'PAID') return { ok: true, found: true, paid: true };
    const c = CREDITS.find((x) => !x.consumed_order_id && String(x.order_ids).split(',').includes(oid) && Math.round(x.amount) === Math.round(o.final_amount));
    if (!c) return { ok: true, found: false };
    c.consumed_order_id = oid; o.status = 'PAID';
    return { ok: true, found: true, paid: true };
  },
};
const fakeFulfill = { fulfillForAdmin: async (oid) => { fulfilled.push(oid); ORDERS[oid].fulfillment_status = 'FULFILLED'; return { ok: true }; } };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './order') return fakeOrder;
  if (req === './fulfill') return fakeFulfill;
  return origLoad.apply(this, arguments);
};
const payments = require('../payments');
const paylink = require('../paylink');
// NOT restored here, on purpose: settleOne() requires ./order and ./fulfill LAZILY, at call time. Restoring the
// loader now would let the real order.js run and answer "DB not configured" — a harness bug that looks exactly
// like a product bug. Put back after the last assertion.

(async () => {
  const express = require('express');
  const app = express();
  paylink.mount(app, { db: mockDb });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const tokenOf = paylink.token;

  // ── the sweep ───────────────────────────────────────────────────────────────────────────────────────────
  section('a bank alert that names an order pays it, with nobody watching');
  reset();
  let r = await payments.settleNamedOrders(72);
  ok('the order the alert named is paid', ORDERS.FF1000001.status === 'PAID' && r.paid === 1, { r, st: ORDERS.FF1000001.status });
  ok('…and DELIVERED, not just marked paid — otherwise it only moves to "paid but not delivered"', fulfilled.includes('FF1000001'), fulfilled);
  ok('…and the credit is consumed, so it cannot pay a second order', CREDITS.find((c) => c.id === 11).consumed_order_id === 'FF1000001');

  ok('a credit with no order named is left alone — that is the backup-QR claim flow, not ours', !verified.includes(''), verified);
  ok('an order id we do not have is tried once and shrugged off, not retried forever', verified.includes('FF9999999') && ORDERS.FF9999999 === undefined);
  ok('a credit older than the window is not touched', ORDERS.FF2000002.status === 'CREATED' && !verified.includes('FF2000002'), ORDERS.FF2000002.status);

  const before = verified.length;
  r = await payments.settleNamedOrders(72);
  ok('running it again pays nothing twice', r.paid === 0 && ORDERS.FF1000001.status === 'PAID');
  ok('…and an already-paid order is not delivered a second time', fulfilled.filter((x) => x === 'FF1000001').length === 1, fulfilled);
  ok('…it does keep looking, cheaply', verified.length > before);

  section('the widest window still only reaches back, never forward');
  reset();
  r = await payments.settleNamedOrders(2000);
  ok('with a big enough window the old one pays too', ORDERS.FF2000002.status === 'PAID' && r.paid === 2, r);

  // ── the page the customer is actually on ────────────────────────────────────────────────────────────────
  section('💳 the payment page checks, instead of reporting a status nothing updates');
  reset();
  const t = tokenOf ? tokenOf('FF1000001') : null;
  ok('the pay page has a token to test with', !!t);
  let res = await fetch(base + '/pay/FF1000001/status?t=' + encodeURIComponent(t));
  let body = await res.json();
  ok('polling the payment page pays the order and says so', body.ok && body.paid === true && body.status === 'PAID', body);
  ok('…and delivers it', fulfilled.includes('FF1000001'), fulfilled);

  const v2 = verified.length;
  res = await fetch(base + '/pay/FF1000001/status?t=' + encodeURIComponent(t));
  body = await res.json();
  ok('an already-paid order costs one read and no more work', body.paid === true && verified.length === v2, { verified: verified.length, v2 });

  reset();
  CREDITS.length = 0;  // nothing has been paid yet
  res = await fetch(base + '/pay/FF1000001/status?t=' + encodeURIComponent(t));
  body = await res.json();
  ok('with no money in yet it says not paid, and nothing is delivered', body.ok && body.paid === false && body.status === 'CREATED' && !fulfilled.length, body);

  res = await fetch(base + '/pay/FF1000001/status?t=wrong-token');
  ok('🔒 a wrong token still gets nothing, and pays nothing', res.status === 404 && !fulfilled.length);

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  const pay = read('payments.js');
  ok('the sweep runs when new mail lands AND on the 60-second safety scan', (pay.match(/settleNamedOrders\(72\)/g) || []).length === 2, (pay.match(/settleNamedOrders\(72\)/g) || []).length);
  ok('the payment page settles before it answers', /require\('\.\/payments'\)\.settleOne\(id\)/.test(read('paylink.js')));
  // The ▶️ Today count was broken on 27 Sep by exactly this comparison. Not again.
  ok('🔒 the sweep never joins bank_credits against orders in SQL', !/order_ids[^;]{0,120}=\s*o\.order_id|orders[^;]{0,120}FIND_IN_SET/i.test(pay));

  server.close();
  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('pay-link-settle: PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
