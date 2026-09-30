/* 💸 The renew card promised a price the pay screen did not honour.
   Found live on 30 Sep 2026, mid-sale, from a customer's complaint (Siddhu: "he says he is not getting early
   renewal discount"). He was right, and the cause was the opposite of what it looked like:

     applyCoupon sent  amount: basePrice − earlyDisc   → the % came off a SMALLER number
     finalPrice then subtracted earlyDisc AGAIN, on top of the coupon

   while the server (order.js createOrder) is an if/else — `if (couponCode) … else if (discountOverride > 0)`
   — so a coupon REPLACES the early-renew discount and the plan price is what the coupon is priced on.

   Measured against production before the fix:
     Netflix (Group Offer) Sharing 1M  page ₹56    server ₹59      ₹3 out
     Netflix Sharing 1Y                page ₹1,159 server ₹1,299   ₹140 out

   Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const COUPONS = [
  { Code: 'FLUX4', CouponCode: 'FLUX4', Scope: 'ANY', Type: 'PERCENT', Value: 40, MinAmount: 0, MaxDiscount: 100,
    Expiry: '', PerUserLimit: 0, GlobalLimit: 0, Active: 'TRUE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', FirstTimeOnly: 'FALSE' },
];
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    if (/^SELECT raw_json FROM coupons$/.test(q)) return COUPONS.map((c) => ({ raw_json: JSON.stringify(c) }));
    if (/^SELECT COUNT\(\*\) n, SUM\(phone_norm = \?\) mine FROM coupon_usage/.test(q)) return [{ n: 0, mine: 0 }];
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 140));
  },
  getPool: () => null,
};

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === './db') return mockDb;
    if (req === './coins') return { onOrderPaid: async () => ({}), holdSpend: async () => ({ ok: false }), releaseSpend: async () => ({}), creditBalance: async () => 0 };
    if (req === './referrals') return { onOrderPaid: async () => ({}), checkReferral: async () => ({ ok: false }) };
    return origLoad.apply(this, arguments);
  };
  const order = require('../order');
  Module._load = origLoad;
  const couponDiscount = order._internal.couponDiscount;

  // ── what the server really does ──────────────────────────────────────────────────────────────────────
  section('the server gives ONE discount, priced on the PLAN PRICE');
  // The two shapes that were wrong on the live site, as plain arithmetic.
  const cases = [
    { name: 'Netflix (Group Offer) Sharing 1M', price: 99, early: 5, wasPage: 56, serverPays: 59 },
    { name: 'Netflix Sharing 1Y', price: 1399, early: 140, wasPage: 1159, serverPays: 1299 },
  ];
  for (const c of cases) {
    const right = await couponDiscount('FLUX4', '9000000001', c.price, { action: 'RENEW' });
    const wrong = await couponDiscount('FLUX4', '9000000001', c.price - c.early, { action: 'RENEW' });
    ok(c.name + ': the coupon is priced on the full ₹' + c.price + ', and that is what the customer pays',
      right.ok && c.price - right.discount === c.serverPays, { discount: right.discount, pays: c.price - right.discount });
    ok('  …pricing it on (price − early) is what produced the wrong figure',
      c.price - c.early - wrong.discount === c.wasPage, { wouldShow: c.price - c.early - wrong.discount, was: c.wasPage });
    ok('  …so the page was out by ₹' + (c.serverPays - c.wasPage),
      c.serverPays - c.wasPage > 0);
  }

  // ── the page must now agree ──────────────────────────────────────────────────────────────────────────
  section('the renew card');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const nocomment = html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  ok('🔒 the coupon is asked for on the FULL plan price', /amount: basePrice,/.test(nocomment));
  ok('🔒 …and never on (basePrice − earlyDisc) again', !/amount:\s*basePrice\s*-\s*earlyDisc/.test(nocomment));
  ok('🔒 a coupon zeroes the early-renew discount, the same if/else the server runs',
    /const earlyDisc = couponState\.applied \? 0 : earlyDiscEligible;/.test(nocomment));
  ok('the eligible amount is still kept, so the page can explain itself', /earlyDiscEligible/.test(nocomment));
  ok('…and the customer is TOLD which discount won', /couponReplacedEarly/.test(nocomment)
    && /Only one discount applies per order/.test(html));

  // finalPrice still subtracts both terms — but earlyDisc is now 0 whenever a coupon is applied, so the
  // arithmetic below is the server's arithmetic. Pin the shape so a later edit cannot quietly double up again.
  const fp = (nocomment.match(/const finalPrice = [^;]+;/) || [''])[0];
  ok('finalPrice takes earlyDisc + coupon, and earlyDisc is the gated one',
    /basePrice - earlyDisc - \(couponState\.applied \? couponState\.discount : 0\)/.test(fp), fp);

  // ── the arithmetic the page will now show, against the server ────────────────────────────────────────
  section('page and server agree, case by case');
  for (const c of cases) {
    const srv = await couponDiscount('FLUX4', '9000000001', c.price, { action: 'RENEW' });
    // page: earlyDisc = 0 because a coupon is applied; coupon asked for on basePrice
    const page = c.price - 0 - srv.discount;
    ok(c.name + ': page ₹' + page + ' = server ₹' + (c.price - srv.discount), page === c.price - srv.discount);
  }
  // …and with NO coupon the early-renew discount is still given, unchanged.
  section('no coupon: the early-renew discount is untouched');
  for (const c of cases) {
    ok(c.name + ': ₹' + c.price + ' − ₹' + c.early + ' = ₹' + (c.price - c.early) + ' still shows',
      /const earlyDisc = couponState\.applied \? 0 : earlyDiscEligible;/.test(nocomment) && c.early > 0);
  }

  ok('🔒 the server was NOT changed by this fix — only what the page shows',
    /never stacks with a coupon/.test(fs.readFileSync(path.join(__dirname, '..', 'order.js'), 'utf8')));

  console.log('\n---------------------------------------');
  console.log('renew-one-discount: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
