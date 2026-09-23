/* R1 — renewals check the account before payment and at fulfilment.
 * Run: npm test (no database needed — a small in-memory fake answers the SQL). */
process.env.TZ = 'Asia/Kolkata';
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
  if (/information_schema\.columns/.test(sql)) return [{ n: S.noRemovalColumns ? 0 : 2 }];
  const c = conditions(sql, params);
  const activeOnly = /UPPER\(is_active\)='TRUE'/.test(sql);

  // 'WHERE service = ? AND plan = ?' (one plan) and 'WHERE service = ?' (the service's whole list, which is
  // how renewQuote checks a plan change is a real, active plan of the same service).
  if (/FROM plans/.test(sql)) return S.plans.filter((p) => (c.service == null || p.service === c.service) && (c.plan == null || p.plan === c.plan)).map(clone);
  if (/FROM inventory_accounts/.test(sql)) {
    return S.accounts.filter((a) => (c.account_id == null || a.account_id === c.account_id) && (!c.like || likes(a.service, c.like)) && (!activeOnly || a.is_active === 'TRUE')).map(clone);
  }
  if (/FROM inventory_capacity/.test(sql)) return S.caps.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  if (/FROM inventory_profiles/.test(sql)) return S.profiles.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  // F1: a purchase with one login per device — every row of the group renews together (_renewalRows).
  if (/FROM subscriptions WHERE group_id = \?/.test(sql)) return S.subs.filter((s) => s.group_id === params[0]).sort((x, y) => (x.group_index || 0) - (y.group_index || 0)).map((s) => ({ ...clone(s), occupying: s.occupying ? 1 : 0 }));
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
    // sub_id is the LAST parameter: these statements now also keep raw_json in step (CLAUDE.md).
    const s = S.subs.find((x) => x.sub_id === params[params.length - 1]);
    Object.assign(s, { inventory_ref: params[0], account_id: params[1], login_id: params[2], password: params[3], profile_number: params[4], profile_name: params[5], profile_pin: params[6] });
    if (params[7]) s.device_type = params[7];
    S.writes.push('move');
    return { affectedRows: 1 };
  }
  if (/^UPDATE subscriptions SET login_id/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[params.length - 1]);
    Object.assign(s, { login_id: params[0], password: params[1], profile_name: params[2], profile_pin: params[3] });
    S.writes.push('refresh');
    return { affectedRows: 1 };
  }
  // accesspassword.js safety net: the access card repairs a row still on an older password.
  if (/^UPDATE subscriptions SET password = \?, login_id = \?/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[4]);
    if (s) Object.assign(s, { password: params[0], login_id: params[1] });
    S.writes.push('access-repair');
    return { affectedRows: s ? 1 : 0 };
  }
  // The renewal write: the row becomes the plan that was bought (name, length, devices) and moves its expiry.
  //   plan, duration_days, device_count, tv_count, expiry, new_expiry, order_id, release, [raw_json x3], sub_id
  if (/^UPDATE subscriptions SET plan = \?, duration_days/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[params.length - 1]);
    Object.assign(s, { plan: params[0], duration_days: params[1], device_count: params[2], tv_count: params[3], expiry_date: params[4], order_id: params[6], occupying: true });
    if (/removed = 0, removed_at = NULL/.test(sql)) Object.assign(s, { removed: 0, removed_at: null });
    S.writes.push('extend');
    return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FAILED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FAILED'; S.writes.push('failed'); return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FULFILLED'; S.writes.push('fulfilled'); return { affectedRows: 1 }; }
  if (/^UPDATE orders SET raw_json = JSON_SET/.test(sql)) {
    const o = S.orders.find((x) => x.order_id === params[params.length - 1]);
    if (o) Object.assign(o, { renewNote: params[0], renewNoteWa: params[1], renewCounted: params[2], renewGifted: params[3], renewCase: params[4] });
    S.writes.push('days-note');
    return { affectedRows: o ? 1 : 0 };
  }
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
  if (req === './mailer') return { sendAccessEmail: async (p) => { S.emails += 1; S.lastEmail = p || {}; } };
  if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null };
  return origLoad.apply(this, arguments);
};
const fulfill = require('../fulfill');
const order = require('../order');

// ---------------------------------------------------------------- base inventory
function base() {
  return {
    writes: [], emails: 0, lastEmail: null,
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
// The renewed order row, to read back the days note fulfil stored on it.
const order1 = () => S.orders.find((o) => o.order_id === 'FF-R1') || {};
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
  ok('move happens before the extension, order marked fulfilled', JSON.stringify(S.writes) === JSON.stringify(['move', 'extend', 'fulfilled', 'days-note']), S.writes);
  ok('customer is told why the login changed', /no longer available/.test(f.message), f.message);
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('repeat call is idempotent and shows the NEW login', f.fulfillment === 'FULFILLED' && f.access.user === 'b@prime' && S.writes.length === 4, { f, writes: S.writes });

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

  section('renewal rules (F4) applied at fulfilment');
  {
    const pad = (n) => String(n).padStart(2, '0');
    const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    const DAYMS = 86400000;
    const now = Date.now();
    const daysFromNow = () => Math.round((new Date(me().expiry_date.replace(' ', 'T')).getTime() - now) / DAYMS);

    S = base();
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb',
      expiry_date: local(new Date(now - 8 * DAYMS)), removed: 1, removed_at: local(new Date(now - 4 * DAYMS)), occupying: false }));
    S.orders.push(renewOrder());
    let f = await fulfill.fulfillForAdmin('FF-R1');
    ok('removed customer: 4 free days, 2 goodwill -> 28 days from payment', daysFromNow() === 28, { days: daysFromNow(), expiry: me().expiry_date });
    ok('customer told what was counted and gifted', /counted only 2 days and gifted you 2 days/.test(f.renewMessage) && /runs until/.test(f.message), f);
    ok('fun bubble included', /hours/.test(f.renewBubble), f.renewBubble);
    // 🎁 The date alone is not enough: the counted/gifted sentence has to travel with it.
    ok('the gifted days are kept on the order for later', /gifted you 2 days free/.test(String(order1().renewNote)) && Number(order1().renewCounted) === 2 && Number(order1().renewGifted) === 2, { note: order1().renewNote, counted: order1().renewCounted, gifted: order1().renewGifted });
    // The stored note comes in both flavours: plain for a screen, *bold* for the WhatsApp text.
    ok('and in both flavours — plain on the card, bold for WhatsApp', !String(order1().renewNote).includes('*') && /gifted you \*2 days\* free/.test(String(order1().renewNoteWa)), { plain: order1().renewNote, wa: order1().renewNoteWa });
    await new Promise((r) => setTimeout(r, 0)); // the email is sent without being awaited
    ok('the credentials email carries the same sentence', /gifted you \*2 days\* free/.test(String((S.lastEmail || {}).renewNote)), S.lastEmail && S.lastEmail.renewNote);
    ok('"removed" tick cleared after renewal', Number(me().removed) === 0 && me().removed_at === null, me());

    S = base();
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb', expiry_date: local(new Date(now - 20 * DAYMS)), removed: 0, occupying: false }));
    S.orders.push(renewOrder());
    f = await fulfill.fulfillForAdmin('FF-R1');
    ok('not removed, 20 days late: 7 counted -> 23 days from payment', daysFromNow() === 23 && f.renewCounted === 7, { days: daysFromNow(), counted: f.renewCounted });

    S = base();
    S.accounts[1].password = 'NEW-pass';
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'old-pass', expiry_date: local(new Date(now - 3 * DAYMS)), removed: 1, removed_at: local(new Date(now - 2 * DAYMS)), occupying: false }));
    S.orders.push(renewOrder());
    f = await fulfill.fulfillForAdmin('FF-R1');
    ok('same account: stale stored password replaced by the current one', f.access.pass === 'NEW-pass' && me().password === 'NEW-pass' && S.writes.includes('refresh') && !f.accountChanged, { access: f.access, writes: S.writes });

    S = base();
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb' }));
    S.orders.push(renewOrder());
    await fulfill.fulfillForAdmin('FF-R1');
    ok('credentials already current: no needless write', !S.writes.includes('refresh'), S.writes);

    S = base();
    S.subs.push(sub({ service: 'Netflix', plan: 'Private 1M', inventory_ref: 'NF-1#P2', login_id: 'n1@nf', password: 'pn', profile_number: '2', profile_name: 'Two', profile_pin: 'OLD' }));
    S.profiles[1].profile_pin = '9999';
    S.orders.push(renewOrder({ service: 'Netflix', plan: 'Private 1M' }));
    f = await fulfill.fulfillForAdmin('FF-R1');
    ok('Netflix private: changed profile PIN refreshed', f.access.profilePin === '9999' && me().profile_pin === '9999', f.access);

    S = base();
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', expiry_date: local(new Date(now - 8 * DAYMS)), removed: 1, removed_at: local(new Date(now - 4 * DAYMS)), occupying: false }));
    const pr = await order.createRenewOrder('SUB-ME');
    ok('pay screen gets the new expiry and the explanation before payment', pr.ok && pr.renewPreview && /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(pr.renewPreview.newExpiryText) && /gifted you 2 days/.test(pr.renewPreview.message), pr.renewPreview);

    S = base();
    S.noRemovalColumns = true;
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb', expiry_date: local(new Date(now - 3 * DAYMS)), occupying: false }));
    S.orders.push(renewOrder());
    delete require.cache[require.resolve('../fulfill')];
    const freshFulfill = require('../fulfill');
    f = await freshFulfill.fulfillForAdmin('FF-R1');
    ok('before schema-v13 runs: renewal still fulfils, treated as not removed (3 days counted)', f.fulfillment === 'FULFILLED' && f.renewCounted === 3, { fulfillment: f.fulfillment, counted: f.renewCounted, message: f.message });
  }

  // ------------------------------------------------------------------ 🔄 changing the plan on renewal
  // Owner, 23 Sep 2026: "plan change on renewal - private to sharing and devices".
  // The rule: a different kind or a different number of devices can never keep the old place, so it is
  // allocated fresh — and if nothing is free the renewal is refused BEFORE the customer pays.
  section('renewal that changes the plan (Private ↔ Sharing, devices)');
  {
    const nfOrder = (o) => renewOrder(Object.assign({ service: 'Netflix', plan: 'Sharing 1M', final_amount: 139 }, o));
    const nfSub = (o) => sub(Object.assign({ service: 'Netflix', plan: 'Sharing 1M', inventory_ref: 'NF-1#P1', account_id: 'NF-1', profile_number: '1', profile_name: 'Shared', profile_pin: '1111', login_id: 'n1@nf', password: 'pn' }, o));
    const me = () => S.subs.find((s) => s.sub_id === 'SUB-ME');

    // Sharing → Private: the shared seat is not a private profile, so they get a private one (#2 or #3).
    S = base();
    S.subs.push(nfSub({}));
    S.orders.push(nfOrder({ plan: 'Private 1M', final_amount: 169 }));
    let f = await fulfill.fulfillForAdmin('FF-R1');
    ok('Sharing → Private: a private profile, never the shared seat', f.fulfillment === 'FULFILLED' && f.accountChanged === true && /#P[23]$/.test(me().inventory_ref), { ref: me().inventory_ref, f: f.message });
    ok('...and the row becomes the plan they bought', me().plan === 'Private 1M', { plan: me().plan });
    ok('...and they are told the login changes', /new login/i.test(String(f.loginNotice || f.message)), { notice: f.loginNotice, message: f.message });

    // Private → Sharing: the private profile is given up for the shared seat (#1, the reserved one).
    S = base();
    S.subs.push(nfSub({ plan: 'Private 1M', inventory_ref: 'NF-1#P2', profile_number: '2', profile_name: 'Two', profile_pin: '2222' }));
    S.orders.push(nfOrder({ plan: 'Sharing 1M' }));
    f = await fulfill.fulfillForAdmin('FF-R1');
    ok('Private → Sharing: moved to the reserved sharing profile', f.fulfillment === 'FULFILLED' && me().inventory_ref === 'NF-1#P1', { ref: me().inventory_ref });
    ok('...and the row says Sharing 1M', me().plan === 'Sharing 1M' && Number(me().device_count) === 1, me());

    // Only the length changes: the same profile is kept, and the row finally carries the new plan name.
    S = base();
    S.subs.push(nfSub({ inventory_ref: 'NF-1#P2', profile_number: '2', plan: 'Private 1M' }));
    S.orders.push(nfOrder({ plan: 'Private 3M', duration_days: 90, final_amount: 449 }));
    f = await fulfill.fulfillForAdmin('FF-R1');
    ok('longer, same kind: the profile is kept', f.fulfillment === 'FULFILLED' && !f.accountChanged && me().inventory_ref === 'NF-1#P2', { ref: me().inventory_ref, changed: f.accountChanged });
    ok('...and the row is updated to the longer plan (it used to keep the old name for ever)', me().plan === 'Private 3M' && Number(me().duration_days) === 90, me());

    // 1 → 2 devices on Prime: the new count is what gets placed, and the row records it.
    S = base();
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb', device_count: 1, tv_count: 0 }));
    S.orders.push(renewOrder({ plan: '2 Devices 1M', final_amount: 59 }));
    f = await fulfill.fulfillForAdmin('FF-R1');
    ok('1 → 2 devices: fulfilled, and the row now holds 2', f.fulfillment === 'FULFILLED' && Number(me().device_count) === 2 && me().plan === '2 Devices 1M', { dev: me().device_count, plan: me().plan, f: f.message });

    // …and when there is no room for the second device, nothing is sold: refused before payment.
    S = base();
    S.caps[1].max_total = 1; // PRI-B can take one device
    S.subs.push(sub({ service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb' }));
    S.subs.push(other('PRI-A', 'Prime Video')); // PRI-A's only free place taken
    S.caps[0].max_total = 1;
    const blocked = await order.createRenewOrder('SUB-ME', '2 Devices 1M');
    ok('no room for the extra device: refused BEFORE payment, no order', blocked.ok === false && blocked.renewBlocked === true && !S.writes.includes('order'), { blocked, writes: S.writes });

    // A purchase with a separate login per device still cannot change how many devices it has.
    S = base();
    S.subs.push(sub({ sub_id: 'SUB-ME', service: 'Prime Video', plan: '2 Devices 1M', inventory_ref: 'PRI-A', login_id: 'a@prime', password: 'pa', device_count: 1, group_id: 'G-1', group_size: 2, group_index: 1 }));
    S.subs.push(sub({ sub_id: 'SUB-ME2', service: 'Prime Video', plan: '2 Devices 1M', inventory_ref: 'PRI-B', login_id: 'b@prime', password: 'pb', device_count: 1, group_id: 'G-1', group_size: 2, group_index: 2 }));
    const shrink = await order.createRenewOrder('SUB-ME', '1 Month');
    ok('separate logins: dropping to 1 device is refused, with the reason', shrink.ok === false && /separate login/i.test(String(shrink.message)), shrink.message);
  }

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
