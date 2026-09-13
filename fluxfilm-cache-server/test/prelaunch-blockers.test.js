/* Pre-launch blocker fixes: stock vs allocators, coupon rules, credential guard, sync safety.
 * Run: npm test   (no database needed — everything is mocked). */
const Module = require('module');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------- shared mock db ----------------
const mock = { query: async () => [], pool: null };
const mockDb = {
  ENABLED: true,
  query: (sql, p) => mock.query(sql.replace(/\s+/g, ' ').trim(), p || []),
  getPool: () => mock.pool,
  ping: async () => ({ ok: true }),
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './coins') return { awardCoins: async () => ({ ok: true }) };
  if (req === './mailer') return { sendAccessEmail: async () => {} };
  if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null, startWatcher() {}, manualScan: async () => ({}) };
  return origLoad.apply(this, arguments);
};

const stock = require('../stock');
const fulfill = require('../fulfill');
const order = require('../order');
const sync = require('../sync');

// ============ 1. stock.js agrees with the real allocators ============
function rng(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

function makeFixture(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const accounts = [], caps = [], profiles = [], occ = [];
  const add = (service, id, extra) => {
    const creds = r() > 0.1;
    accounts.push({ service, account_id: id, login_id: creds ? id + '@x' : '', password: creds ? 'pw' : '', notes: (extra && extra.notes) || '', is_active: r() > 0.1 ? 'TRUE' : 'FALSE' });
  };
  // Prime (CAPACITY)
  for (let i = 0; i < 3; i++) {
    const id = 'PR-' + i; add(pick(['Prime', 'Prime Video + Shopping']), id);
    if (r() > 0.3) caps.push({ service: 'Prime', account_id: id, max_total: pick([0, 2, 4, 5]), max_tv: pick([0, 1, 2]), is_active: pick(['TRUE', 'TRUE', 'FALSE', '']) });
    if (r() > 0.3) occ.push({ svc: pick(['prime video', 'prime video + shopping']), inventory_ref: id, total: Math.floor(r() * 6), tv: Math.floor(r() * 3) });
  }
  // Netflix (PROFILE)
  for (let i = 0; i < 3; i++) {
    const id = 'NF-' + i; add('Netflix', id);
    if (r() > 0.3) caps.push({ service: 'Netflix', account_id: id, max_total: pick([0, 3, 5]), max_tv: 0, is_active: pick(['TRUE', 'FALSE', '']) });
    const nProf = Math.floor(r() * 5);
    for (let pno = (r() > 0.2 ? 1 : 2); pno <= nProf + 1; pno++) {
      const type = pno === 1 ? pick(['SHARING_RESERVED', 'PRIVATE_ROTATING']) : pick(['PRIVATE_ROTATING', 'PRIVATE_ROTATING', 'SHARING_RESERVED', 'OTHER', '']);
      profiles.push({ service: 'Netflix', account_id: id, profile_number: String(pno), profile_pin: '1111', profile_name: 'P' + pno, raw_json: JSON.stringify({ ProfileType: type, IsReserved: pick(['TRUE', 'FALSE', 'FALSE']) }) });
      if (r() > 0.5) occ.push({ svc: pick(['netflix', 'netflix (group offer)']), inventory_ref: id + '#P' + pno, total: Math.floor(r() * 6), tv: 0 });
    }
  }
  // Zee5 (OTP_ACCOUNT) + Crunchyroll (ACCOUNT)
  for (const [svc, pre] of [['Zee5 Premium', 'Z5'], ['Crunchyroll', 'CR']]) {
    for (let i = 0; i < 3; i++) {
      const id = pre + '-' + i; add(svc, id, { notes: pick(['', 'Our account', '1,3', '6', '12']) });
      if (r() > 0.4) caps.push({ service: svc, account_id: id, max_total: pick([0, 1, 2, 3]), max_tv: 0, is_active: pick(['TRUE', 'FALSE', '']) });
      if (r() > 0.4) occ.push({ svc: svc.toLowerCase(), inventory_ref: id, total: Math.floor(r() * 4), tv: 0 });
      if (svc === 'Crunchyroll') {
        const n = Math.floor(r() * 6);
        for (let pno = 1; pno <= n; pno++) {
          profiles.push({ service: 'Crunchyroll', account_id: id, profile_number: String(pno), profile_pin: '2222', profile_name: 'C' + pno, raw_json: JSON.stringify({ ProfileType: pick(['PRIVATE_ROTATING', 'PRIVATE_ROTATING', 'PRIVATE_ROTATING', 'SHARING_RESERVED', '']), IsReserved: pick(['FALSE', 'FALSE', 'TRUE']) }) });
          if (r() > 0.5) occ.push({ svc: 'crunchyroll', inventory_ref: id + '#P' + pno, total: Math.floor(r() * 3), tv: 0 });
        }
      }
    }
  }
  return { accounts, caps, profiles, occ };
}

// Minimal SQL emulation for the allocators' queries.
function allocConn(fx) {
  const needleOf = (sql, params) => { const m = sql.match(/LIKE '%([^%]+)%'/); return (m ? m[1] : String(params[0] || '').replace(/%/g, '')).toLowerCase(); };
  return {
    query: async (sql, params) => {
      sql = sql.replace(/\s+/g, ' ');
      const needle = needleOf(sql, params || []);
      const has = (s) => String(s || '').toLowerCase().includes(needle);
      if (/FROM inventory_accounts/.test(sql)) return [fx.accounts.filter((a) => has(a.service) && a.is_active.toUpperCase() === 'TRUE')];
      if (/FROM inventory_capacity/.test(sql)) return [fx.caps.filter((c) => has(c.service))];
      if (/FROM inventory_profiles/.test(sql)) return [fx.profiles.filter((p) => has(p.service))];
      if (/FROM subscriptions/.test(sql)) {
        const m = new Map();
        for (const o of fx.occ) { if (!o.svc.includes(needle)) continue; const c = m.get(o.inventory_ref) || { inventory_ref: o.inventory_ref, total: 0, tv: 0 }; c.total += o.total; c.tv += o.tv; m.set(o.inventory_ref, c); }
        return [[...m.values()]];
      }
      throw new Error('unexpected alloc SQL ' + sql.slice(0, 80));
    },
  };
}
function snapOf(fx) {
  return {
    accounts: fx.accounts.filter((a) => a.is_active.toUpperCase() === 'TRUE').map((a) => ({ service: a.service, account_id: a.account_id, notes: a.notes, has_creds: (a.login_id && a.password) ? 1 : 0 })),
    caps: fx.caps, profiles: fx.profiles, occ: fx.occ,
  };
}

(async () => {
  section('stock.js vs real allocators (randomized)');
  const plans = [
    { service: 'Prime Video', plan: '1 Month', duration_days: 30, raw_json: { AllocationPolicy: 'CAPACITY' }, alloc: (c) => fulfill.allocatePrime(c, 1, 0) },
    { service: 'Prime Video', plan: '2 Devices 1M', duration_days: 30, raw_json: { AllocationPolicy: 'CAPACITY' }, alloc: (c) => fulfill.allocatePrime(c, 2, 0) },
    { service: 'Netflix', plan: 'Sharing 1M', duration_days: 30, raw_json: { AllocationPolicy: 'PROFILE' }, alloc: (c) => fulfill.allocateNetflix(c, 'Sharing 1M', 1) },
    { service: 'Netflix (Group Offer)', plan: 'Sharing 3M', duration_days: 90, raw_json: { AllocationPolicy: 'PROFILE' }, alloc: (c) => fulfill.allocateNetflix(c, 'Sharing 3M', 1) },
    { service: 'Netflix', plan: 'Private 1M', duration_days: 30, raw_json: { AllocationPolicy: 'PROFILE' }, alloc: (c) => fulfill.allocateNetflix(c, 'Private 1M', 1) },
    { service: 'Zee5 Premium', plan: '1 Month', duration_days: 30, raw_json: { AllocationPolicy: 'OTP_ACCOUNT' }, alloc: (c) => fulfill.allocateOtp(c, 'Zee5 Premium', 30) },
    { service: 'Zee5 Premium', plan: '6 Months', duration_days: 180, raw_json: { AllocationPolicy: 'OTP_ACCOUNT' }, alloc: (c) => fulfill.allocateOtp(c, 'Zee5 Premium', 180) },
    { service: 'Crunchyroll', plan: 'Private 1M', duration_days: 30, raw_json: { AllocationPolicy: 'ACCOUNT' }, alloc: (c) => fulfill.allocateWholeAccount(c, 'Crunchyroll', 1) },
    { service: 'Crunchyroll', plan: 'Private 3M', duration_days: 90, raw_json: { AllocationPolicy: 'PROFILE' }, alloc: (c) => fulfill.allocateProfile(c, 'Crunchyroll', 'Private 3M', 1) },
    { service: 'Crunchyroll', plan: 'Sharing 1M', duration_days: 30, raw_json: { AllocationPolicy: 'PROFILE' }, alloc: (c) => fulfill.allocateProfile(c, 'Crunchyroll', 'Sharing 1M', 1) },
  ];
  let checks = 0, mismatches = 0, sawOut = 0, sawIn = 0;
  const r = rng(424242);
  for (let i = 0; i < 400; i++) {
    const fx = makeFixture(r); const snap = snapOf(fx);
    for (const p of plans) {
      const units = stock.unitsForPlan(snap, { ...p, raw_json: JSON.stringify(p.raw_json) });
      const a = await p.alloc(allocConn(fx));
      checks++; if (a.ok) sawIn++; else sawOut++;
      if ((units >= 1) !== !!a.ok) { mismatches++; if (mismatches <= 3) console.log('   mismatch', p.service, p.plan, 'units', units, 'alloc', a.ok, a.message); }
    }
  }
  ok(checks + ' plan checks, stock>=1 exactly when allocation succeeds', mismatches === 0, { checks, mismatches });
  ok('fixtures covered both in-stock and sold-out', sawIn > 300 && sawOut > 300, { sawIn, sawOut });

  section('stock levels + manual services');
  ok('manual plan honours Stock column', stock.unitsForPlan({ accounts: [], caps: [], profiles: [], occ: [] }, { service: 'YouTube Premium', plan: '1M', raw_json: JSON.stringify({ AllocationPolicy: 'NONE', Stock: 0 }) }) === null);
  ok('levelFor null -> OK', stock.levelFor(null, 3) === 'OK');
  ok('levelFor 0 -> OUT, 2 -> LOW, 3 -> OK', stock.levelFor(0, 3) === 'OUT' && stock.levelFor(2, 3) === 'LOW' && stock.levelFor(3, 3) === 'OK');
  ok('devicesForPlan', stock.devicesForPlan('2 Devices 1M') === 2 && stock.devicesForPlan('Private 1M') === 1);
  // SonyLiv real-world case: 1 account, no capacity row, 4 active subs -> OUT
  const sony = { accounts: [{ service: 'SonyLiv Premium', account_id: 'SL-1', notes: 'Our account', has_creds: 1 }], caps: [], profiles: [], occ: [{ svc: 'sonyliv premium', inventory_ref: 'SL-1', total: 4, tv: 0 }] };
  ok('SonyLiv (1 acct, no capacity row, 4 subs) is OUT', stock.unitsForPlan(sony, { service: 'SonyLiv Premium', plan: '1 Month', duration_days: 30, raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT' }) }) === 0);
  const jio = { accounts: [1, 2, 3, 4, 5].map((i) => ({ service: 'JioHotstar', account_id: 'JH-' + i, notes: 'Our account', has_creds: 1 })), caps: [1, 2, 3, 4].map((i) => ({ service: 'JioHotstar', account_id: 'JH-' + i, max_total: 9, is_active: 'TRUE' })), profiles: [], occ: [{ svc: 'jiohotstar', inventory_ref: 'JH-1', total: 5, tv: 0 }] };
  const jioUnits = stock.unitsForPlan(jio, { service: 'JioHotstar', plan: '1 Year', duration_days: 365, raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT', Stock: 0 }) });
  ok('JioHotstar with free capacity ignores stale Stock=0', jioUnits === 4 + 27 + 1, jioUnits);

  mock.query = async (sql) => {
    if (/FROM inventory_accounts/.test(sql)) return jio.accounts;
    if (/FROM inventory_capacity/.test(sql)) return jio.caps;
    if (/FROM inventory_profiles/.test(sql)) return [];
    if (/FROM subscriptions/.test(sql)) return jio.occ;
    return [];
  };
  const lv = await stock.computeStockLevels([
    { service: 'JioHotstar', plan: '1 Year', duration_days: 365, raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT', Stock: 0 }) },
    { service: 'YouTube Premium', plan: '3M', duration_days: 90, raw_json: JSON.stringify({ AllocationPolicy: 'NONE', Stock: 0 }) },
    { service: 'YouTube Premium', plan: '1M', duration_days: 30, raw_json: JSON.stringify({ AllocationPolicy: 'NONE' }) },
  ]);
  ok('computeStockLevels keys + sources', lv['JioHotstar|||1 Year'].stockLevel === 'OK' && lv['JioHotstar|||1 Year'].source === 'inventory' && lv['YouTube Premium|||3M'].stockLevel === 'OUT' && lv['YouTube Premium|||1M'].stockLevel === 'OK', lv);

  // ============ 1b. PROFILE allocation beyond Netflix ============
  section('profile allocation: Crunchyroll + Netflix unchanged');
  {
    const r2 = rng(777);
    let same = 0, diff = 0, leaks = 0, crSold = 0;
    for (let i = 0; i < 300; i++) {
      const fx = makeFixture(r2);
      for (const plan of ['Private 1M', 'Sharing 1M']) {
        const a = await fulfill.allocateNetflix(allocConn(fx), plan, 1);
        const b = await fulfill.allocateProfile(allocConn(fx), 'Netflix (Group Offer)', plan, 1);
        if (JSON.stringify(a) === JSON.stringify(b)) same++; else diff++;
      }
      const c = await fulfill.allocateProfile(allocConn(fx), 'Crunchyroll', 'Private 1M', 1);
      if (c.ok) { crSold++; if (!String(c.inventoryRef).startsWith('CR-')) leaks++; }
    }
    ok('Netflix result identical via old and new entry point (600 cases)', diff === 0 && same === 600, { same, diff });
    ok('Crunchyroll never receives a profile from another service', leaks === 0 && crSold > 50, { leaks, crSold });

    const fx = {
      accounts: [
        { service: 'Crunchyroll', account_id: 'CRY-01', login_id: 'cr@x', password: 'pw', notes: '', is_active: 'TRUE' },
        { service: 'Netflix', account_id: 'NF-9', login_id: 'nf@x', password: 'pw', notes: '', is_active: 'TRUE' },
      ],
      caps: [],
      profiles: [1, 2, 3, 4, 5].map((n) => ({ service: 'Crunchyroll', account_id: 'CRY-01', profile_number: String(n), profile_pin: '100' + n, profile_name: n + 'th Profile', raw_json: JSON.stringify({ ProfileType: 'PRIVATE_ROTATING', IsReserved: 'FALSE' }) }))
        .concat([1, 2].map((n) => ({ service: 'Netflix', account_id: 'NF-9', profile_number: String(n), profile_pin: '9', profile_name: 'N' + n, raw_json: JSON.stringify({ ProfileType: 'PRIVATE_ROTATING', IsReserved: 'FALSE' }) }))),
      occ: [2, 3, 4, 5].map((n) => ({ svc: 'crunchyroll', inventory_ref: 'CRY-01#P' + n, total: 1, tv: 0 }))
        .concat([{ svc: 'netflix', inventory_ref: 'NF-9#P2', total: 1, tv: 0 }]),
    };
    const got = await fulfill.allocateProfile(allocConn(fx), 'Crunchyroll', 'Private 1M', 1);
    ok('Crunchyroll sells profile #1 when #2-#5 are taken', got.ok && got.inventoryRef === 'CRY-01#P1' && got.access.profileNumber === 1 && got.access.profilePin === '1001', got);
    const snap1 = snapOf(fx);
    ok('stock agrees: 1 Crunchyroll profile left', stock.unitsForPlan(snap1, { service: 'Crunchyroll', plan: 'Private 1M', duration_days: 30, raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) }) === 1);
    const nf = await fulfill.allocateNetflix(allocConn(fx), 'Private 1M', 1);
    ok('Netflix still never sells shared profile #1 privately', nf.ok === false, nf);
    fx.occ.push({ svc: 'crunchyroll', inventory_ref: 'CRY-01#P1', total: 1, tv: 0 });
    const full = await fulfill.allocateProfile(allocConn(fx), 'Crunchyroll', 'Private 1M', 1);
    ok('Crunchyroll sold out after 5 customers, with a Crunchyroll-worded message', full.ok === false && /Crunchyroll/.test(full.message) && !/Netflix/.test(full.message), full);
    ok('stock agrees: 0 left', stock.unitsForPlan(snapOf(fx), { service: 'Crunchyroll', plan: 'Private 1M', duration_days: 30, raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) }) === 0);
  }

  // ============ 2. coupon rules ============
  section('coupon rules');
  const coupon = (over) => JSON.stringify(Object.assign({ Code: 'SAVE', Active: 'TRUE', Type: 'FLAT', Value: 20, MinAmount: 0, Scope: 'ANY', PerUserLimit: 0, GlobalLimit: 0, FirstTimeOnly: 'FALSE', AllowedPhones: 'ALL' }, over));
  const couponDb = (raw, usage, paid) => async (sql, params) => {
    if (/FROM coupons/.test(sql)) return [{ raw_json: raw }];
    if (/FROM coupon_usage/.test(sql)) return [{ n: usage.all, mine: usage.mine }];
    if (/FROM orders WHERE phone_norm/.test(sql)) return paid ? [{ 1: 1 }] : [];
    throw new Error('unexpected ' + sql);
  };
  const cd = order._internal.couponDiscount;
  mock.query = couponDb(coupon({ Scope: 'NEW' }), { all: 0, mine: 0 }, false);
  ok('NEW-only coupon rejected on RENEW', (await cd('SAVE', '9876543210', 100, { action: 'RENEW' })).ok === false);
  ok('NEW-only coupon ok on NEW', (await cd('SAVE', '9876543210', 100, { action: 'NEW' })).discount === 20);
  mock.query = couponDb(coupon({ Scope: '' }), { all: 0, mine: 0 }, false);
  ok('blank scope = ANY', (await cd('SAVE', '9876543210', 100, { action: 'RENEW' })).ok === true);
  mock.query = couponDb(coupon({ GlobalLimit: 5 }), { all: 5, mine: 0 }, false);
  ok('global limit reached -> rejected', (await cd('SAVE', '9876543210', 100, { action: 'NEW' })).ok === false);
  mock.query = couponDb(coupon({ GlobalLimit: 5 }), { all: 4, mine: 0 }, false);
  ok('global limit not reached -> ok', (await cd('SAVE', '9876543210', 100, { action: 'NEW' })).ok === true);
  mock.query = couponDb(coupon({ PerUserLimit: 1 }), { all: 9, mine: 1 }, false);
  ok('per-user limit still enforced', (await cd('SAVE', '9876543210', 100, { action: 'NEW' })).ok === false);
  mock.query = couponDb(coupon({ FirstTimeOnly: 'TRUE' }), { all: 0, mine: 0 }, true);
  ok('first-time-only rejected for a paying customer', (await cd('SAVE', '9876543210', 100, { action: 'NEW' })).ok === false);
  mock.query = couponDb(coupon({ FirstTimeOnly: 'TRUE' }), { all: 0, mine: 0 }, false);
  ok('first-time-only ok for a new customer', (await cd('SAVE', '9876543210', 100, { action: 'NEW' })).ok === true);
  mock.query = couponDb(coupon({ Services: 'Netflix, Prime Video' }), { all: 0, mine: 0 }, false);
  ok('service allow-list blocks others', (await cd('SAVE', '9', 100, { action: 'NEW', service: 'Zee5 Premium' })).ok === false);
  ok('service allow-list allows listed', (await cd('SAVE', '9', 100, { action: 'NEW', service: 'Prime Video' })).ok === true);
  mock.query = couponDb(coupon({ Plans: 'Private 1M' }), { all: 0, mine: 0 }, false);
  ok('plan allow-list', (await cd('SAVE', '9', 100, { action: 'NEW', plan: 'Sharing 1M' })).ok === false && (await cd('SAVE', '9', 100, { action: 'NEW', plan: 'Private 1M' })).ok === true);
  mock.query = couponDb(coupon({ Scope: 'RENEW' }), { all: 0, mine: 0 }, false);
  ok('validateCoupon passes checkout scope', (await order.validateCoupon('SAVE', { phone: '9', amount: 100, scope: 'NEW' })).ok === false
    && (await order.validateCoupon('SAVE', { phone: '9', amount: 100, scope: 'RENEW' })).ok === true);

  // ============ 3. createOrder issues a token, stores only its hash ============
  section('access token issued by createOrder');
  let inserted = null;
  mock.query = async (sql, params) => {
    if (/FROM plans/.test(sql)) return [{ price: 149, duration_days: 30, is_active: 'TRUE', raw_json: '{}' }];
    if (/^INSERT INTO orders/.test(sql)) { inserted = params; return { affectedRows: 1 }; }
    return [];
  };
  const co = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'A', email: 'a@b.c', phone: '9876543210' });
  const raw = JSON.parse(inserted[inserted.length - 1]);
  ok('response carries a 36-hex token', /^[0-9a-f]{36}$/.test(co.accessToken), co.accessToken);
  ok('raw_json stores the SHA-256, never the token', raw.AccessTokenHash === crypto.createHash('sha256').update(co.accessToken).digest('hex') && !JSON.stringify(raw).includes(co.accessToken));

  // ============ 4. credential guard ============
  section('fulfillAndGetAccess credential guard');
  const token = 'a'.repeat(36);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const makePool = (orderType) => ({
    query: async (sql) => {
      sql = sql.replace(/\s+/g, ' ');
      if (/SELECT order_id, service, plan, name/.test(sql)) return [[{ order_id: 'FF1', service: 'Netflix', plan: 'Private 1M', phone_norm: '9876543210', status: 'PAID', fulfillment_status: 'FULFILLED', source: 'node', order_type: orderType, renew_sub_id: orderType === 'RENEW' ? 'SUB-1' : '' }]];
      if (/FROM subscriptions WHERE order_id/.test(sql)) return [[{ sub_id: 'SUB-1', login_id: 'victim@x', password: 'secret', profile_name: 'P', profile_pin: '1', profile_number: 2 }]];
      if (/SELECT fulfillment_status FROM orders/.test(sql)) return [[{ fulfillment_status: 'FULFILLED' }]];
      if (/FROM subscriptions WHERE sub_id/.test(sql)) return [[{ sub_id: 'SUB-1', login_id: 'victim@x', password: 'secret' }]];
      if (/SELECT phone_norm, order_type, raw_json FROM orders/.test(sql)) return [[{ phone_norm: '9876543210', order_type: orderType, raw_json: JSON.stringify({ AccessTokenHash: hash }) }]];
      if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [[{ l: 1 }]];
      throw new Error('unexpected pool SQL ' + sql.slice(0, 70));
    },
    getConnection: async () => ({ query: async (s, p) => mock.pool.query(s, p), release() {} }),
  });
  mock.pool = makePool('NEW');
  let g = await fulfill.fulfillAndGetAccess('FF1');
  ok('no proof -> credentials withheld', !g.access && g.accessWithheld === true && g.fulfillment === 'FULFILLED', g);
  ok('withheld response leaks no password anywhere', !JSON.stringify(g).includes('secret'));
  g = await fulfill.fulfillAndGetAccess('FF1', { token: 'b'.repeat(36) });
  ok('wrong token -> withheld', !g.access);
  g = await fulfill.fulfillAndGetAccess('FF1', { token });
  ok('right token -> credentials', g.access && g.access.pass === 'secret');
  g = await fulfill.fulfillAndGetAccess('FF1', { phone: '+91 98765 43210' });
  ok('matching phone (normalised) -> credentials', g.access && g.access.pass === 'secret');
  g = await fulfill.fulfillAndGetAccess('FF1', { phone: '9000000000' });
  ok('other phone -> withheld', !g.access);
  g = await fulfill.fulfillAndGetAccess('FF1', token);
  ok('bare token string accepted', g.access && g.access.pass === 'secret');
  g = await fulfill.fulfillAndGetAccess('FF1', { trusted: true, admin: true });
  ok('client cannot claim trust', !g.access);
  mock.pool = makePool('RENEW');
  g = await fulfill.fulfillAndGetAccess('FF1', { token });
  ok('RENEW: token alone is NOT enough (stranger renewing a sub)', !g.access);
  g = await fulfill.fulfillAndGetAccess('FF1', { token, phone: '9876543210' });
  ok('RENEW: owner phone -> credentials', g.access && g.access.pass === 'secret');
  mock.pool = makePool('NEW');
  g = await fulfill.fulfillForAdmin('FF1');
  ok('admin variant returns credentials', g.access && g.access.pass === 'secret');

  // ============ 5. sync safety ============
  section('final sync safety');
  const captured = [];
  let failInsert = false;
  mock.pool = {
    query: async (sql, p) => { captured.push({ where: 'pool', sql }); return [{}]; },
    getConnection: async () => ({
      beginTransaction: async () => captured.push({ where: 'tx', sql: 'BEGIN' }),
      query: async (sql) => { captured.push({ where: 'tx', sql }); if (failInsert && /^INSERT/.test(sql)) throw new Error('boom'); return [{}]; },
      commit: async () => captured.push({ where: 'tx', sql: 'COMMIT' }),
      rollback: async () => captured.push({ where: 'tx', sql: 'ROLLBACK' }),
      release() {},
    }),
  };
  const up = sync._internal.upsert;
  await up('inventory_accounts', sync.TABLES.inventory_accounts, [{ service: 'X', account_id: 'A', raw_json: '{}' }]);
  const inv = captured.splice(0).map((x) => x.sql);
  ok('replace uses a transaction, no TRUNCATE', inv[0] === 'BEGIN' && /^DELETE FROM `inventory_accounts`/.test(inv[1]) && /^INSERT/.test(inv[2]) && inv[3] === 'COMMIT' && !inv.some((s) => /TRUNCATE/.test(s)), inv);
  failInsert = true;
  let threw = false;
  try { await up('inventory_accounts', sync.TABLES.inventory_accounts, [{ service: 'X', account_id: 'A', raw_json: '{}' }]); } catch (_) { threw = true; }
  const rb = captured.splice(0).map((x) => x.sql);
  ok('failed insert rolls back (table not left empty)', threw && rb.includes('ROLLBACK') && !rb.includes('COMMIT'), rb);
  failInsert = false;
  await up('coupon_usage', sync.TABLES.coupon_usage, [{ coupon_code: 'A', order_id: 'X', raw_json: '{}' }]);
  const cu = captured.splice(0).map((x) => x.sql);
  ok('coupon_usage keeps rows of node orders', /LEFT JOIN orders o ON o.order_id = t.order_id WHERE o.order_id IS NULL OR COALESCE\(o.source, ''\) <> 'node'/.test(cu[1]), cu[1]);
  ok('empty dump never clears a table', (await up('inventory_accounts', sync.TABLES.inventory_accounts, [])) === 0 && captured.length === 0);
  await up('subscriptions', sync.TABLES.subscriptions, [{ sub_id: 'S', expiry_date: '2026-01-01', raw_json: '{}' }]);
  const sq = captured.splice(0)[0].sql;
  ok('subscriptions upsert protects source=node rows', /`expiry_date`=IF\(COALESCE\(`source`,''\)='node', `expiry_date`, VALUES\(`expiry_date`\)\)/.test(sq) && !/`sub_id`=/.test(sq), sq.slice(0, 200));
  await up('customers', sync.TABLES.customers, [{ phone: '1', name: 'n', raw_json: '{}' }]);
  ok('tables without source keep plain upsert', /`name`=VALUES\(`name`\)/.test(captured.splice(0)[0].sql));
  // default run skips master tables
  const synced = [];
  mock.query = async () => [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { synced.push(JSON.parse(opts.body).args[0]); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rows: [] }), json: async () => ({ ok: true, rows: [] }) }; };
  const res = await sync.runSync([], { dry: true });
  ok('default sync skips plans/coupons/inventory', !synced.some((t) => /^(PLANS|COUPONS|INVENTORY_)/.test(t)) && synced.includes('ORDERS') && JSON.stringify(res.skippedMasterTables) === JSON.stringify(sync.MASTER_TABLES), { synced, skipped: res.skippedMasterTables });
  synced.length = 0;
  await sync.runSync(['inventory_accounts'], { dry: true });
  ok('master table still importable when named', synced.includes('INVENTORY_ACCOUNTS'), synced);
  global.fetch = realFetch;

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
