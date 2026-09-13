/* R1 — renewals check the account before payment and at fulfilment.
 * Run: npm test (no database needed — a small in-memory fake answers the SQL). */
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- fake database
let S = null; // current state
const clone = (x) => JSON.parse(JSON.stringify(x));
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

function conditions(sql, params) {
  // Walk the WHERE conditions in order so each "?" gets its parameter.
  const re = /(account_id = \?|sub_id = \?|order_id = \?|phone_norm = \?|service = \?|plan = \?|LOWER\(service\) LIKE \?|LOWER\(service\) LIKE '%([^%]+)%')/g;
  const out = {}; let i = 0; let m;
  const where = sql.slice(sql.search(/ WHERE /) + 1);
  while ((m = re.exec(where))) {
    if (m[2]) { out.like = m[2]; continue; }
    const key = m[1].split(' ')[0].replace('LOWER(service)', 'like');
    const v = params[i++];
    if (key === 'like') out.like = String(v).replace(/%/g, '').toLowerCase(); else out[key] = v;
  }
  return out;
}
const likes = (svc, needle) => String(svc || '').toLowerCase().includes(needle);

function run(sqlRaw, params) {
  const sql = norm(sqlRaw);
  params = params || [];
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  const c = conditions(sql, params);
  const activeOnly = /UPPER\(is_active\)='TRUE'/.test(sql);

  if (/FROM plans/.test(sql)) return S.plans.filter((p) => p.service === c.service && p.plan === c.plan).map(clone);
  if (/FROM inventory_accounts/.test(sql)) {
    return S.accounts.filter((a) => (c.account_id == null || a.account_id === c.account_id) && (!c.like || likes(a.service, c.like)) && (!activeOnly || a.is_active === 'TRUE')).map(clone);
  }
  if (/FROM inventory_capacity/.test(sql)) return S.caps.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  if (/FROM inventory_profiles/.test(sql)) return S.profiles.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return S.subs.filter((s) => s.order_id === c.order_id).map(clone);
  if (/FROM subscriptions WHERE sub_id = \?/.test(sql)) return S.subs.filter((s) => s.sub_id === c.sub_id).map((s) => ({ ...clone(s), occupying: s.occupying ? 1 : 0 }));
  if (/FROM subscriptions/.test(sql) && /GROUP BY inventory_ref/.test(sql)) {
    const m = new Map();
    for (const s of S.subs) {
      if (!s.occupying || !likes(s.service, c.like)) continue;
      const cur = m.get(s.inventory_ref) || { inventory_ref: s.inventory_ref, total: 0, tv: 0 };
      const dev = s.device_count || 1;
      cur.total += dev;
      cur.tv += s.tv_count != null ? s.tv_count : (s.device_type === 'TV' ? dev : 0);
      m.set(s.inventory_ref, cur);
    }
    return [...m.values()];
  }
  if (/^SELECT fulfillment_status FROM orders/.test(sql)) return S.orders.filter((o) => o.order_id === c.order_id).map((o) => ({ fulfillment_status: o.fulfillment_status }));
  if (/FROM orders WHERE order_id = \?/.test(sql)) return S.orders.filter((o) => o.order_id === c.order_id).map(clone);
  if (/FROM customers/.test(sql)) return [{ name: 'Test Customer' }];
  if (/^UPDATE subscriptions SET inventory_ref/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[8]);
    Object.assign(s, { inventory_ref: params[0], account_id: params[1], login_id: params[2], password: params[3], profile_number: params[4], profile_name: params[5], profile_pin: params[6] });
    if (params[7]) s.device_type = params[7];
    S.writes.push('move');
    return { affectedRows: 1 };
  }
  if (/^UPDATE subscriptions SET expiry_date/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[4]);
    Object.assign(s, { expiry_date: params[0], order_id: params[2], occupying: true });
    S.writes.push('extend');
    return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FAILED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FAILED'; S.writes.push('failed'); return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FULFILLED'; S.writes.push('fulfilled'); return { affectedRows: 1 }; }
  if (/^INSERT INTO orders/.test(sql)) { S.writes.push('order'); return { affectedRows: 1 }; }
  if (/^INSERT INTO coupon_usage/.test(sql)) return { affectedRows: 1 };
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 120));
}

const pool = {
  query: async (sql, p) => [run(sql, p)],
  getConnection: async () => ({ query: async (sql, p) => [run(sql, p)], release() {} }),
};
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => pool, ping: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './coins') return { awardCoins: async () => ({ ok: true }) };
  if (req === './mailer') return { sendAccessEmail: async () => { S.emails += 1; } };
  if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null };
  return origLoad.apply(this, arguments);
};
const fulfill = require('../fulfill');
const order = require('../order');

// ---------------------------------------------------------------- base inventory
function base() {
  return {
    writes: [], emails: 0,
    plans: [
      { service: 'Prime Video', plan: '1 Month', duration_days: 30, price: 39, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY' }) },
      { service: 'Netflix', plan: 'Private 1M', duration_days: 30, price: 169, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) },
      { service: 'Netflix', plan: 'Sharing 1M', duration_days: 30, price: 139, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) },
      { service: 'JioHotstar', plan: '1 Month', duration_days: 30, price: 69, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT' }) },
      { service: 'YouTube Premium', plan: '1 Month', duration_days: 30, price: 99, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'NONE', FulfillmentMode: 'MANUAL' }) },
    ],
    accounts: [
      { service: 'Prime', account_id: 'PRI-A', login_id: 'a@prime', password: 'pa', is_active: 'TRUE', notes: '', plan: '' },
      { service: 'Prime', account_id: 'PRI-B', login_id: 'b@prime', password: 'pb', is_active: 'TRUE', notes: '', plan: '' },
      { service: 'Netflix', account_id: 'NF-1', login_id: 'n1@nf', password: 'pn', is_active: 'TRUE', notes: '', plan: '' },
      { service: 'JioHotstar', account_id: 'JH-1', login_id: 'j1@jh', password: 'pj1', is_active: 'TRUE', notes: 'Our account', plan: '1 Month' },
      { service: 'JioHotstar', account_id: 'JH-2', login_id: 'j2@jh', password: 'pj2', is_active: 'TRUE', notes: 'Our account', plan: '1 Month' },
    ],
    caps: [
      { service: 'Prime', account_id: 'PRI-A', max_total: 2, max_tv: 1, is_active: 'TRUE' },
      { service: 'Prime', account_id: 'PRI-B', max_total: 4, max_tv: 2, is_active: 'TRUE' },
      { service: 'Netflix', account_id: 'NF-1', max_total: 3, max_tv: 0, is_active: 'TRUE' },
      { service: 'JioHotstar', account_id: 'JH-1', max_total: 3, max_tv: 0, is_active: 'true' },
      { service: 'JioHotstar', account_id: 'JH-2', max_total: 3, max_tv: 0, is_active: 'true' },
    ],
    profiles: [
      { service: 'Netflix', account_id: 'NF-1', profile_number: '1', profile_name: 'Shared', profile_pin: '1111', raw_json: JSON.stringify({ ProfileType: 'SHARING_RESERVED' }) },
      { service: 'Netflix', account_id: 'NF-1', profile_number: '2', profile_name: 'Two', profile_pin: '2222', raw_json: JSON.stringify({ ProfileType: 'PRIVATE_ROTATING' }) },
      { service: 'Netflix', account_id: 'NF-1', profile_number: '3', profile_name: 'Three', profile_pin: '3333', raw_json: JSON.stringify({ ProfileType: 'PRIVATE_ROTATING' }) },
    ],
    subs: [],
    orders: [],
  };
}
const sub = (o) => Object.assign({ sub_id: 'SUB-ME', phone: '9876543210', email: 'me@x', expiry_date: '2026-09-10 10:00:00', account_id: '', login_id: 'old@login', password: 'oldpass', profile_name: '', profile_pin: '', profile_number: '', device_type: 'NON_TV', device_count: 1, tv_count: 0, occupying: true, status: 'ACTIVE', source: null }, o);
const other = (ref, service, o) => Object.assign({ sub_id: 'SUB-X' + Math.random().toString(36).slice(2, 7), service, plan: '1 Month', inventory_ref: ref, device_count: 1, tv_count: 0, device_type: 'NON_TV', occupying: true }, o);

(async () => {
  section('decision before payment: keep, move or block');
  // Prime: account full only because of this customer -> keep
  S = base();
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }), other('PRI-A', 'Prime Video'));
  let d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Prime: account full only because of this customer -> SAME', d.mode === 'SAME', d);

  // Prime: plan lapsed (not occupying) and someone else took the last place -> move
  S = base();
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A', occupying: false }), other('PRI-A', 'Prime Video'), other('PRI-A', 'Prime Video'));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Prime: place taken after the plan lapsed -> MOVE with the "place taken" message', d.mode === 'MOVE' && d.reason === 'FULL' && /taken/.test(d.message), d);

  // Prime: TV cap counted too
  S = base();
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A', occupying: false, device_type: 'TV', tv_count: 1 }), other('PRI-A', 'Prime Video', { tv_count: 1, device_type: 'TV' }));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Prime: TV slot gone even though a device slot is free -> MOVE', d.mode === 'MOVE' && d.reason === 'FULL', d);

  // Prime: account retired -> move; nothing anywhere -> block
  S = base();
  S.accounts[0].is_active = 'FALSE';
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Prime: account retired -> MOVE with "no longer available"', d.mode === 'MOVE' && d.reason === 'INACTIVE' && /no longer available/.test(d.message), d);
  S.accounts[1].is_active = 'FALSE';
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Prime: account retired and no other account free -> NONE (blocked)', d.mode === 'NONE' && /can't be paid/.test(d.message), d);

  // Prime: capacity row marked inactive also retires the account
  S = base();
  S.caps[0].is_active = 'FALSE';
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Prime: capacity row inactive -> MOVE', d.mode === 'MOVE' && d.reason === 'INACTIVE', d);

  // Netflix private: profile given to someone else -> move to a free private profile
  S = base();
  S.subs.push(sub({ service: 'Netflix', plan: 'Private 1M', inventory_ref: 'NF-1#P2', occupying: false }), other('NF-1#P2', 'Netflix', { plan: 'Private 1M' }));
  d = await fulfill.planRenewal('SUB-ME', 'Private 1M');
  ok('Netflix private: profile now belongs to someone else -> MOVE', d.mode === 'MOVE' && d.reason === 'FULL', d);
  S = base();
  S.subs.push(sub({ service: 'Netflix', plan: 'Private 1M', inventory_ref: 'NF-1#P2' }));
  d = await fulfill.planRenewal('SUB-ME', 'Private 1M');
  ok('Netflix private: still their own profile -> SAME', d.mode === 'SAME', d);
  S.profiles = S.profiles.filter((p) => p.profile_number !== '2');
  d = await fulfill.planRenewal('SUB-ME', 'Private 1M');
  ok('Netflix private: profile deleted from inventory -> MOVE', d.mode === 'MOVE' && d.reason === 'PROFILE_GONE', d);

  // Netflix sharing: 3/3 used including this customer -> keep
  S = base();
  S.subs.push(sub({ service: 'Netflix', plan: 'Sharing 1M', inventory_ref: 'NF-1#P1' }), other('NF-1#P1', 'Netflix', { plan: 'Sharing 1M' }), other('NF-1#P1', 'Netflix', { plan: 'Sharing 1M' }));
  d = await fulfill.planRenewal('SUB-ME', 'Sharing 1M');
  ok('Netflix sharing: full only with this customer counted -> SAME', d.mode === 'SAME', d);

  // OTP: login paused via inactive capacity row -> move to the other account
  S = base();
  S.caps[3].is_active = 'FALSE';
  S.subs.push(sub({ service: 'JioHotstar', plan: '1 Month', inventory_ref: 'JH-1' }));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('OTP: login paused -> MOVE', d.mode === 'MOVE' && d.reason === 'INACTIVE', d);

  // Manual service: nothing to check
  S = base();
  S.subs.push(sub({ service: 'YouTube Premium', plan: '1 Month', inventory_ref: '' }));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Manual service (no inventory) -> SAME', d.mode === 'SAME', d);

  // Inventory service with no recorded account -> move
  S = base();
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: '' }));
  d = await fulfill.planRenewal('SUB-ME', '1 Month');
  ok('Inventory service with no recorded account -> MOVE', d.mode === 'MOVE' && d.reason === 'NO_ACCOUNT', d);

  section('createRenewOrder: warn or block before any money is taken');
  S = base();
  S.accounts[0].is_active = 'FALSE'; S.accounts[1].is_active = 'FALSE';
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }));
  let r = await order.createRenewOrder('SUB-ME');
  ok('no account available -> order refused, nothing written', r.ok === false && r.renewBlocked === true && !S.writes.includes('order'), { r, writes: S.writes });
  S = base();
  S.accounts[0].is_active = 'FALSE';
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }));
  r = await order.createRenewOrder('SUB-ME');
  ok('move needed -> order created with a notice for the pay screen', r.ok === true && r.accountChange === true && /new login/.test(r.renewNotice) && S.writes.includes('order'), r);
  S = base();
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B' }));
  r = await order.createRenewOrder('SUB-ME');
  ok('account fine -> plain renewal, no notice', r.ok === true && !r.renewNotice && !r.accountChange, r);

  section('fulfilment re-checks and moves the customer');
  const renewOrder = (o) => Object.assign({ order_id: 'FF-R1', service: 'Prime Video', plan: '1 Month', name: 'T', email: 'me@x', phone: '9876543210', phone_norm: '9876543210', duration_days: 30, status: 'PAID', fulfillment_status: 'PENDING', extra_field_value: '', device_count: 1, tv_count: 0, source: 'node', final_amount: 39, order_type: 'RENEW', renew_sub_id: 'SUB-ME' }, o);

  S = base();
  S.accounts[0].is_active = 'FALSE';
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }));
  S.orders.push(renewOrder());
  let f = await fulfill.fulfillForAdmin('FF-R1');
  const me = () => S.subs.find((s) => s.sub_id === 'SUB-ME');
  ok('retired account: moved to PRI-B with its login', f.fulfillment === 'FULFILLED' && f.accountChanged === true && f.access.user === 'b@prime' && f.access.pass === 'pb' && me().inventory_ref === 'PRI-B', f);
  ok('subscription row now holds the new login (recover/account page show it)', me().login_id === 'b@prime' && me().password === 'pb' && me().account_id === 'PRI-B');
  ok('move happens before the extension, order marked fulfilled', JSON.stringify(S.writes) === JSON.stringify(['move', 'extend', 'fulfilled']), S.writes);
  ok('customer is told why the login changed', /no longer available/.test(f.message), f.message);
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('repeat call is idempotent and shows the NEW login', f.fulfillment === 'FULFILLED' && f.access.user === 'b@prime' && S.writes.length === 3, { f, writes: S.writes });

  S = base();
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb' }));
  S.orders.push(renewOrder());
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('healthy account: extended in place, login unchanged, no move', f.fulfillment === 'FULFILLED' && !f.accountChanged && f.access.user === 'b@prime' && !S.writes.includes('move'), { f, writes: S.writes });

  // Stock ran out between order and payment -> no extension, order FAILED, customer told
  S = base();
  S.accounts[0].is_active = 'FALSE'; S.accounts[1].is_active = 'FALSE';
  S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-A' }));
  S.orders.push(renewOrder());
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('nothing free at fulfilment: NO_STOCK, order FAILED, subscription untouched', f.fulfillment === 'NO_STOCK' && S.orders[0].fulfillment_status === 'FAILED' && !S.writes.includes('extend') && me().inventory_ref === 'PRI-A', { f, writes: S.writes });

  // Netflix private move hands over a new profile and PIN
  S = base();
  S.subs.push(sub({ service: 'Netflix', plan: 'Private 1M', inventory_ref: 'NF-1#P2', profile_number: '2', profile_pin: '2222', occupying: false }), other('NF-1#P2', 'Netflix', { plan: 'Private 1M' }));
  S.orders.push(renewOrder({ service: 'Netflix', plan: 'Private 1M' }));
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('Netflix private: moved to free profile #3 with its PIN', f.accountChanged && me().inventory_ref === 'NF-1#P3' && String(f.access.profileNumber) === '3' && f.access.profilePin === '3333', { access: f.access, ref: me().inventory_ref });

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
