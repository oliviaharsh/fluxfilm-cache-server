/* F1 — multiple devices: same login or a separate login for each device (Netflix + Prime Video).
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
const clone = (x) => JSON.parse(JSON.stringify(x));
const normSql = (sql) => sql.replace(/\s+/g, ' ').trim();
const likes = (svc, needle) => String(svc || '').toLowerCase().includes(needle);
const withOcc = (s) => ({ ...clone(s), occupying: s.occupying ? 1 : 0 });

function where(sql, params) {
  const re = /(account_id = \?|sub_id = \?|order_id = \?|group_id = \?|phone_norm = \?|service = \?|plan = \?|LOWER\(service\) LIKE \?|LOWER\(service\) LIKE '%([^%]+)%')/g;
  const out = {}; let i = 0; let m;
  const w = sql.slice(sql.search(/ WHERE /) + 1);
  const before = (sql.slice(0, sql.search(/ WHERE /)).match(/\?/g) || []).length; // placeholders before WHERE
  i = before;
  while ((m = re.exec(w))) {
    if (m[2]) { out.like = m[2]; continue; }
    const key = m[1].split(' ')[0].replace('LOWER(service)', 'like');
    const v = params[i++];
    if (key === 'like') out.like = String(v).replace(/%/g, '').toLowerCase(); else out[key] = v;
  }
  return out;
}

function insertObject(sql, params) {
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((x) => x.trim());
  const valsSrc = sql.slice(sql.indexOf('VALUES (') + 8, sql.lastIndexOf(')'));
  const vals = []; let depth = 0; let cur = '';
  for (const ch of valsSrc) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { vals.push(cur.trim()); cur = ''; } else cur += ch; }
  vals.push(cur.trim());
  const o = {}; let p = 0;
  cols.forEach((c, i) => { const v = vals[i]; o[c] = v === '?' ? params[p++] : v === 'NOW()' ? 'now' : v.replace(/^'|'$/g, ''); });
  return o;
}

function run(sqlRaw, params) {
  const sql = normSql(sqlRaw);
  params = params || [];
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  if (/information_schema\.columns/.test(sql)) return /group_id/.test(sql) ? [{ n: S.groups ? 4 : 0 }] : [{ n: 2 }];
  if (/^SELECT 1 FROM subscriptions WHERE sub_id = \?/.test(sql)) return S.subs.filter((s) => s.sub_id === params[0]).map(() => ({ 1: 1 }));
  if (/^SELECT 1 FROM orders WHERE order_id = \?/.test(sql)) return S.orders.filter((o) => o.order_id === params[0]).map(() => ({ 1: 1 }));
  const c = where(sql, params);
  const activeOnly = /UPPER\(is_active\)='TRUE'/.test(sql);
  if (/FROM plans WHERE/.test(sql)) return S.plans.filter((p) => p.service === c.service && p.plan === c.plan).map(clone);
  if (/FROM plans/.test(sql)) return S.plans.map(clone);
  if (/FROM inventory_accounts/.test(sql)) return S.accounts.filter((a) => (c.account_id == null || a.account_id === c.account_id) && (!c.like || likes(a.service, c.like)) && (!activeOnly || a.is_active === 'TRUE')).map((a) => ({ ...clone(a), has_creds: a.login_id && a.password ? 1 : 0, login_key: String(a.login_id || '').toLowerCase(), has_login: a.login_id ? 1 : 0 }));
  if (/FROM inventory_capacity/.test(sql)) return S.caps.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  if (/FROM inventory_profiles/.test(sql)) return S.profiles.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  if (/GROUP BY LOWER\(service\), inventory_ref/.test(sql)) {
    const m = new Map();
    for (const s of S.subs) {
      if (!s.occupying) continue;
      const k = String(s.service).toLowerCase() + '|' + s.inventory_ref;
      const cur = m.get(k) || { svc: String(s.service).toLowerCase(), inventory_ref: s.inventory_ref, total: 0, tv: 0, extra: 0 };
      const dev = s.device_count || 1;
      cur.total += dev; cur.extra += Math.max(0, dev - 1); cur.tv += s.tv_count != null ? s.tv_count : (s.device_type === 'TV' ? dev : 0);
      m.set(k, cur);
    }
    return [...m.values()];
  }
  if (/FROM subscriptions/.test(sql) && /GROUP BY inventory_ref/.test(sql)) {
    const m = new Map();
    for (const s of S.subs) {
      if (!s.occupying || (c.like && !likes(s.service, c.like))) continue;
      const cur = m.get(s.inventory_ref) || { inventory_ref: s.inventory_ref, total: 0, tv: 0, extra: 0 };
      const dev = s.device_count || 1;
      cur.total += dev; cur.extra += Math.max(0, dev - 1);
      cur.tv += s.tv_count != null ? s.tv_count : (s.device_type === 'TV' ? dev : 0);
      m.set(s.inventory_ref, cur);
    }
    return [...m.values()];
  }
  const sortIdx = (rows) => (/ORDER BY group_index/.test(sql) ? rows.sort((a, b) => (a.group_index || 0) - (b.group_index || 0)) : rows);
  if (/FROM subscriptions WHERE group_id = \?/.test(sql)) return sortIdx(S.subs.filter((s) => s.group_id === c.group_id && (c.phone_norm == null || s.phone_norm === c.phone_norm)).map(withOcc));
  if (/FROM subscriptions WHERE \(order_id = \? OR sub_id = \?\)/.test(sql)) return S.subs.filter((s) => (s.order_id === params[0] || s.sub_id === params[1]) && s.phone_norm === params[2]).slice(0, 1).map(clone);
  if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return sortIdx(S.subs.filter((s) => s.order_id === c.order_id).map(clone));
  if (/FROM subscriptions WHERE sub_id = \?/.test(sql)) return S.subs.filter((s) => s.sub_id === c.sub_id).map(withOcc);
  if (/FROM subscriptions WHERE phone_norm = \?/.test(sql)) return S.subs.filter((s) => s.phone_norm === c.phone_norm).map(clone);
  if (/^SELECT fulfillment_status FROM orders/.test(sql)) return S.orders.filter((o) => o.order_id === c.order_id).map((o) => ({ fulfillment_status: o.fulfillment_status }));
  if (/FROM orders WHERE order_id = \?/.test(sql)) return S.orders.filter((o) => o.order_id === c.order_id).map(clone);
  if (/FROM customers/.test(sql)) return [{ name: 'Test Customer' }];
  if (/FROM app_settings|FROM reminder_log|FROM coupons/.test(sql)) return [];
  if (/^INSERT INTO subscriptions/.test(sql)) {
    const o = insertObject(sql, params);
    S.subs.push(Object.assign(o, { occupying: true, device_count: Number(o.device_count), tv_count: o.tv_count == null ? null : Number(o.tv_count), group_size: o.group_size == null ? null : Number(o.group_size), group_index: o.group_index == null ? null : Number(o.group_index) }));
    S.writes.push('insert:' + o.inventory_ref); S.insertSql.push(sql);
    return { affectedRows: 1 };
  }
  if (/^UPDATE subscriptions SET inventory_ref/.test(sql) && /group_id = \?/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[11]);
    Object.assign(s, { inventory_ref: params[0], account_id: params[1], login_id: params[2], password: params[3], profile_number: params[4], profile_name: params[5], profile_pin: params[6], device_type: params[7], device_count: 1, tv_count: params[8], group_id: params[9], group_size: params[10], group_index: 1 });
    S.writes.push('split-lead'); return { affectedRows: 1 };
  }
  // sub_id is the LAST parameter: these statements now also keep raw_json in step (CLAUDE.md).
  if (/^UPDATE subscriptions SET inventory_ref/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[params.length - 1]);
    Object.assign(s, { inventory_ref: params[0], account_id: params[1], login_id: params[2], password: params[3], profile_number: params[4], profile_name: params[5], profile_pin: params[6] });
    if (params[7]) s.device_type = params[7];
    S.writes.push('move:' + s.sub_id); return { affectedRows: 1 };
  }
  if (/^UPDATE subscriptions SET login_id/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[params.length - 1]);
    Object.assign(s, { login_id: params[0], password: params[1], profile_name: params[2], profile_pin: params[3] });
    S.writes.push('refresh:' + s.sub_id); return { affectedRows: 1 };
  }
  // accesspassword.js safety net: an access card repairs a row still on an older password.
  if (/^UPDATE subscriptions SET password = \?, login_id = \?/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[4]);
    if (s) Object.assign(s, { password: params[0], login_id: params[1] });
    S.writes.push('access-repair:' + params[4]); return { affectedRows: s ? 1 : 0 };
  }
  // The renewal write: the row becomes the plan that was bought (name, length, devices) and moves its expiry.
  //   plan, duration_days, device_count, tv_count, expiry, new_expiry, order_id, release, [raw_json x3], sub_id
  if (/^UPDATE subscriptions SET plan = \?, duration_days/.test(sql)) {
    const s = S.subs.find((x) => x.sub_id === params[params.length - 1]);
    Object.assign(s, { plan: params[0], duration_days: params[1], device_count: params[2], tv_count: params[3], expiry_date: params[4], order_id: params[6], occupying: true, status: 'ACTIVE' });
    if (/removed = 0/.test(sql)) Object.assign(s, { removed: 0, removed_at: null });
    S.writes.push('extend:' + s.sub_id); return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FAILED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FAILED'; S.writes.push('failed'); return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FULFILLED'; S.writes.push('fulfilled'); return { affectedRows: 1 }; }
  if (/^INSERT INTO orders/.test(sql)) {
    const o = insertObject(sql, params);
    S.orders.push(Object.assign(o, { status: 'CREATED', fulfillment_status: 'PENDING', source: 'node', device_count: Number(o.device_count), tv_count: o.tv_count == null ? null : Number(o.tv_count) }));
    S.writes.push('order'); S.orderSql.push(sql);
    return { affectedRows: 1 };
  }
  if (/^INSERT INTO coupon_usage|^INSERT INTO reminder_log/.test(sql)) return { affectedRows: 1 };
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 140));
}

const conn = () => ({
  query: async (sql, p) => [run(sql, p)], release() {},
  beginTransaction: async () => { S.tx.push('begin'); }, commit: async () => { S.tx.push('commit'); }, rollback: async () => { S.tx.push('rollback'); },
});
const pool = { query: async (sql, p) => [run(sql, p)], getConnection: async () => conn() };
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => pool, ping: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './coins') return { awardCoins: async (x) => { S.coins.push(x.orderId); return { ok: true }; }, holdSpend: async () => ({ ok: false }) };
  if (req === './mailer') return { sendAccessEmail: async (p) => { S.emails.push(p); } };
  if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null };
  if (req === './push') return { sendToPhone: async (phone, msg) => { S.pushes.push({ phone, msg }); return { devices: 1, sent: 1 }; } };
  return origLoad.apply(this, arguments);
};
const deviceLogins = require('../devicelogins');
const fulfill = require('../fulfill');
const order = require('../order');
const stock = require('../stock');
const catalog = require('../catalog');

// ---------------------------------------------------------------- inventory
const PRIV_NF = { AllocationPolicy: 'PROFILE' };
const PRIME = { AllocationPolicy: 'CAPACITY', NeedsExtraField: 'TRUE', ExtraFieldKey: 'PRIME_DEVICE_TYPE' };
function base(o) {
  const st = {
    groups: true, writes: [], tx: [], coins: [], emails: [], pushes: [], insertSql: [], orderSql: [],
    plans: [
      { service: 'Netflix', plan: 'Private 1M', duration_days: 30, price: 169, is_active: 'TRUE', raw_json: JSON.stringify(PRIV_NF) },
      { service: 'Netflix', plan: 'Private 2 Devices 1M', duration_days: 30, price: 299, is_active: 'TRUE', raw_json: JSON.stringify(PRIV_NF) },
      { service: 'Netflix', plan: 'Sharing 1M', duration_days: 30, price: 99, is_active: 'TRUE', raw_json: JSON.stringify(PRIV_NF) },
      { service: 'Netflix', plan: 'Sharing 2 Devices 1M', duration_days: 30, price: 179, is_active: 'TRUE', raw_json: JSON.stringify(PRIV_NF) },
      { service: 'Prime Video', plan: '1 Month', duration_days: 30, price: 39, is_active: 'TRUE', raw_json: JSON.stringify(PRIME) },
      { service: 'Prime Video', plan: '2 Devices 1M', duration_days: 30, price: 59, is_active: 'TRUE', raw_json: JSON.stringify(PRIME) },
      { service: 'JioHotstar', plan: '2 Devices 1M', duration_days: 30, price: 99, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT' }) },
    ],
    accounts: [], caps: [], profiles: [], subs: [], orders: [],
  };
  return Object.assign(st, o || {});
}
const nfAccount = (st, id, maxTotal, privates, opts) => {
  st.accounts.push({ service: 'Netflix', account_id: id, login_id: id.toLowerCase() + '@nf', password: 'pw-' + id, is_active: (opts && opts.inactive) ? 'FALSE' : 'TRUE', notes: '', plan: '' });
  st.caps.push({ service: 'Netflix', account_id: id, max_total: maxTotal, max_tv: 0, is_active: 'TRUE' });
  st.profiles.push({ service: 'Netflix', account_id: id, profile_number: '1', profile_name: 'Shared', profile_pin: '1111', raw_json: JSON.stringify({ ProfileType: 'SHARING_RESERVED' }) });
  for (let i = 0; i < privates; i++) st.profiles.push({ service: 'Netflix', account_id: id, profile_number: String(i + 2), profile_name: 'P' + (i + 2), profile_pin: '2' + (i + 2) + '22', raw_json: JSON.stringify({ ProfileType: 'PRIVATE_ROTATING' }) });
};
const primeAccount = (st, id, maxTotal, maxTv, opts) => {
  st.accounts.push({ service: 'Prime', account_id: id, login_id: id.toLowerCase() + '@prime', password: 'pw-' + id, is_active: (opts && opts.inactive) ? 'FALSE' : 'TRUE', notes: '', plan: '' });
  st.caps.push({ service: 'Prime', account_id: id, max_total: maxTotal, max_tv: maxTv, is_active: 'TRUE' });
};
let seq = 0;
const occupy = (st, ref, service, o) => st.subs.push(Object.assign({ sub_id: 'SUB-OTHER' + (++seq), service, plan: 'x', inventory_ref: ref, device_count: 1, tv_count: 0, device_type: 'NON_TV', occupying: true, phone_norm: '9000000000' }, o || {}));
const reset = () => deviceLogins._resetSchemaCache();

async function buy(service, plan, extra) {
  const r = await order.createOrder(Object.assign({ service, plan, name: 'Asha', email: 'asha@x', phone: '9876543210' }, extra || {}));
  return r;
}
async function payAndFulfil(orderId) {
  const o = S.orders.find((x) => x.order_id === orderId);
  o.status = 'PAID';
  return fulfill.fulfillForAdmin(orderId);
}
const newSubs = () => S.subs.filter((s) => !/^SUB-OTHER|^SUB-ME/.test(s.sub_id));

(async () => {
  section('helpers');
  ok('eligible: Netflix private 2 devices (PROFILE)', deviceLogins.isEligible({ service: 'Netflix', plan: 'Private 2 Devices 1M', policy: 'PROFILE' }));
  ok('eligible: Prime 2 devices (CAPACITY)', deviceLogins.isEligible({ service: 'Prime Video', plan: '2 Devices 1M', policy: 'CAPACITY' }));
  ok('not eligible: 1-device plan', !deviceLogins.isEligible({ service: 'Netflix', plan: 'Private 1M', policy: 'PROFILE' }));
  ok('not eligible: other services / policies', !deviceLogins.isEligible({ service: 'JioHotstar', plan: '2 Devices 1M', policy: 'OTP_ACCOUNT' }) && !deviceLogins.isEligible({ service: 'Crunchyroll', plan: 'Private 2 Devices 1M', policy: 'PROFILE' }) && !deviceLogins.isEligible({ service: 'Netflix', plan: '2 Devices 1M', policy: 'CAPACITY' }));
  ok('not eligible: manual fulfilment', !deviceLogins.isEligible({ service: 'Prime Video', plan: '2 Devices 1M', policy: 'CAPACITY', fulfillmentMode: 'MANUAL' }));
  ok('mode: blank → same, valid kept, junk → null', deviceLogins.normalizeMode('') === 'same' && deviceLogins.normalizeMode('SEPARATE') === 'separate' && deviceLogins.normalizeMode('both') === null);
  ok('maxSets: [1,1] of 2 → 1, [3,1] of 2 → 1, [2,2,2] of 2 → 3, [5] of 2 → 0', deviceLogins.maxSets([1, 1], 2) === 1 && deviceLogins.maxSets([3, 1], 2) === 1 && deviceLogins.maxSets([2, 2, 2], 2) === 3 && deviceLogins.maxSets([5], 2) === 0);
  const lines = deviceLogins.loginLines({ logins: [{ device: 1, user: 'a', pass: 'p', profileName: 'P2', profileNumber: '2', profilePin: '1' }, { device: 2, user: 'b', pass: 'q' }], sameLogin: false });
  ok('loginLines: "Device 1 — ID / password (profile, PIN)"', lines[0] === 'Device 1 — a / p (profile P2 #2, PIN 1)' && lines[1] === 'Device 2 — b / q', lines);
  ok('loginLines: same login → one block + "use on both devices"', deviceLogins.loginLines({ logins: [{ device: 1, user: 'a', pass: 'p' }, { device: 2, user: 'a', pass: 'p' }], sameLogin: true })[1] === 'Use this same login on both devices.');

  // ============================================================ NEW purchases
  section('Netflix private: same login fits → ONE profile on 2 devices');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 3);
  let r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'same' });
  ok('order created, mode stored in raw_json AND login_mode column', r.ok && r.loginMode === 'same' && !r.loginNotice && JSON.parse(S.orders[0].raw_json).LoginMode === 'same' && S.orders[0].login_mode === 'same', { r, o: S.orders[0] });
  let f = await payAndFulfil(r.orderId);
  let subs = newSubs();
  ok('one subscription row, device_count 2, on a private profile, group of 1', f.fulfillment === 'FULFILLED' && subs.length === 1 && subs[0].device_count === 2 && /^NF-A#P[234]$/.test(subs[0].inventory_ref) && subs[0].group_size === 1 && subs[0].group_index === 1 && subs[0].group_id === 'G-' + r.orderId, subs);
  ok('credentials: sameLogin with Device 1 + Device 2 identical', f.access.sameLogin === true && f.access.logins.length === 2 && f.access.logins[1].user === 'nf-a@nf' && f.access.deviceCount === 2, f.access);
  ok('coins + email once for the order', S.coins.length === 1 && S.emails.length === 1 && S.emails[0].access.logins.length === 2);
  ok('written in one transaction', JSON.stringify(S.tx) === JSON.stringify(['begin', 'commit']), S.tx);

  section('Netflix counting rule: sharing seats + extra private devices ≤ max_total');
  S = base(); reset();
  nfAccount(S, 'NF-A', 3, 3);
  occupy(S, 'NF-A#P1', 'Netflix', {}); occupy(S, 'NF-A#P1', 'Netflix', {}); occupy(S, 'NF-A#P1', 'Netflix', {}); // 3 sharing seats = full
  let snap = await stock.loadSnapshot();
  const planOf = (service, plan) => S.plans.find((p) => p.service === service && p.plan === plan);
  ok('1-device private stock unchanged by full sharing seats (3 free profiles)', stock.unitsForPlan(snap, planOf('Netflix', 'Private 1M')) === 3, stock.unitsForPlan(snap, planOf('Netflix', 'Private 1M')));
  ok('1-device private still allocates', (await fulfill.allocateProfile(conn(), 'Netflix', 'Private 1M', 1)).ok);
  ok('2-device private (same) does NOT fit: 3 seats + 1 extra > 3', !(await fulfill.allocateProfile(conn(), 'Netflix', 'Private 2 Devices 1M', 2)).ok && stock.unitsForPlan(snap, planOf('Netflix', 'Private 2 Devices 1M')) === 0);
  S.subs.pop(); // 2 seats: 2 + 1 extra = 3 fits
  snap = await stock.loadSnapshot();
  ok('with 2 seats used it fits (2 + 1 = 3)', (await fulfill.allocateProfile(conn(), 'Netflix', 'Private 2 Devices 1M', 2)).ok && stock.unitsForPlan(snap, planOf('Netflix', 'Private 2 Devices 1M')) === 1);
  occupy(S, 'NF-A#P2', 'Netflix', { device_count: 2 }); // a 2-device private sub: 1 extra device
  snap = await stock.loadSnapshot();
  ok('extra device of a multi-device private sub blocks the last sharing seat', !(await fulfill.allocateProfile(conn(), 'Netflix', 'Sharing 1M', 1)).ok && stock.unitsForPlan(snap, planOf('Netflix', 'Sharing 1M')) === 0);
  ok('...but 1-device private stock is still every free profile (2)', stock.unitsForPlan(snap, planOf('Netflix', 'Private 1M')) === 2);

  section('same chosen, no single account fits → separate logins (customer told why)');
  S = base(); reset();
  nfAccount(S, 'NF-A', 3, 2); nfAccount(S, 'NF-B', 3, 2);
  for (const acc of ['NF-A', 'NF-B']) for (let i = 0; i < 3; i++) occupy(S, acc + '#P1', 'Netflix'); // both full of sharing seats
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'same' });
  ok('before payment: order allowed with the "each device gets its own login" notice', r.ok && /own login/.test(r.loginNotice), r);
  f = await payAndFulfil(r.orderId);
  subs = newSubs();
  const accOf = (s) => s.inventory_ref.split('#')[0];
  ok('two rows, 1 device each, on two DIFFERENT accounts, same group', subs.length === 2 && subs.every((s) => s.device_count === 1 && s.group_size === 2 && s.group_id === 'G-' + r.orderId) && accOf(subs[0]) !== accOf(subs[1]) && subs.map((s) => s.group_index).join() === '1,2', subs);
  ok('customer sees Device 1 / Device 2 with different logins + the notice', f.access.sameLogin === false && f.access.logins.map((x) => x.device).join() === '1,2' && f.access.logins[0].user !== f.access.logins[1].user && /own login/.test(f.loginNotice), f);
  ok('email payload carries per-device logins and the notice', S.emails.length === 1 && S.emails[0].access.logins.length === 2 && /own login/.test(S.emails[0].loginNotice));
  f = await fulfill.fulfillForAdmin(r.orderId);
  ok('repeat call: same two logins, nothing allocated again', f.fulfillment === 'FULFILLED' && f.access.logins.length === 2 && newSubs().length === 2 && S.coins.length === 1, f.access);

  section('separate chosen, not enough accounts, one account fits → same login with the owner message');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 3);
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'separate' });
  ok('before payment: warned "not enough separate accounts … use this login on both devices"', r.ok && r.loginMode === 'separate' && r.loginNotice === "We don't have enough separate accounts right now — please use this login on both devices.", r);
  f = await payAndFulfil(r.orderId);
  subs = newSubs();
  ok('delivered as ONE row with 2 devices', f.loginMode === 'same' && f.requestedLoginMode === 'separate' && subs.length === 1 && subs[0].device_count === 2 && f.access.sameLogin === true, { f, subs });

  section('separate chosen and possible → one private profile per account');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 2); nfAccount(S, 'NF-B', 5, 2); nfAccount(S, 'NF-C', 5, 2);
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'separate' });
  f = await payAndFulfil(r.orderId);
  subs = newSubs();
  ok('no notice; two accounts; private profiles (never #1)', r.ok && !r.loginNotice && subs.length === 2 && new Set(subs.map(accOf)).size === 2 && subs.every((s) => !/#P1$/.test(s.inventory_ref)), subs);

  section('Netflix sharing: same = 2 seats on one sharing profile; separate = seats on different accounts');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 1); nfAccount(S, 'NF-B', 5, 1);
  // Harsh asked on 23 Sep 2026, about a live order: when one customer buys 2 devices on the SAME login, does the
  // account lose 2 places or only 1? It must be 2 — one row with device_count 2, and the occupancy sum counts it
  // as two. If it ever counted 1, that account would be sold one seat too many and someone would be locked out.
  const sharingSeatsFree = async () => stock.unitsForPlan(await stock.loadSnapshot(), S.plans.find((p) => p.service === 'Netflix' && p.plan === 'Sharing 1M'));
  const seatsBefore = await sharingSeatsFree();
  ok('two empty accounts of 5 = 10 sharing places to sell', seatsBefore === 10, seatsBefore);
  r = await buy('Netflix', 'Sharing 2 Devices 1M', { loginMode: 'same' });
  f = await payAndFulfil(r.orderId);
  subs = newSubs();
  ok('same: one row on a sharing profile with 2 seats', subs.length === 1 && /#P1$/.test(subs[0].inventory_ref) && subs[0].device_count === 2, subs);
  {
    const after = await sharingSeatsFree();
    ok('⚠️ the account lost TWO places, not one (10 → 8)', after === 8, { before: seatsBefore, after, wouldBeIfCountedAsOne: 9 });
  }
  r = await buy('Netflix', 'Sharing 2 Devices 1M', { loginMode: 'separate' });
  f = await payAndFulfil(r.orderId);
  subs = newSubs().filter((s) => s.order_id === r.orderId);
  ok('separate: two rows, sharing profiles on two accounts', subs.length === 2 && subs.every((s) => /#P1$/.test(s.inventory_ref)) && new Set(subs.map(accOf)).size === 2, subs);

  section('neither possible → out of stock BEFORE payment, and NO_STOCK at fulfilment (nothing half-delivered)');
  S = base(); reset();
  nfAccount(S, 'NF-A', 3, 1);
  for (let i = 0; i < 3; i++) occupy(S, 'NF-A#P1', 'Netflix'); // one free private profile, no room for an extra device
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'separate' });
  ok('createOrder refuses with outOfStock, no order written', r.ok === false && r.outOfStock === true && /out of stock/.test(r.message) && !S.writes.includes('order'), r);
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'same' });
  ok('same mode refused too', r.ok === false && r.outOfStock === true);
  // Stock changed while the customer was paying:
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 1); nfAccount(S, 'NF-B', 5, 1);
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'separate' });
  ok('order accepted while 2 accounts were free', r.ok);
  occupy(S, 'NF-B#P2', 'Netflix'); // NF-B's only private profile sold meanwhile
  for (let i = 0; i < 5; i++) occupy(S, 'NF-A#P1', 'Netflix'); // NF-A has no room for an extra device either
  f = await payAndFulfil(r.orderId);
  ok('fulfilment: NO_STOCK, order FAILED, zero subscriptions written', f.fulfillment === 'NO_STOCK' && S.orders[0].fulfillment_status === 'FAILED' && newSubs().length === 0 && !S.tx.length, { f, subs: newSubs(), tx: S.tx });
  S.subs = S.subs.filter((s) => s.inventory_ref !== 'NF-A#P1'); // room again: admin retries delivery
  S.orders[0].fulfillment_status = 'PENDING';
  f = await fulfill.fulfillForAdmin(r.orderId);
  ok('retry after stock returns: same-login fallback on NF-A', f.fulfillment === 'FULFILLED' && newSubs().length === 1 && newSubs()[0].device_count === 2, f);

  section('Prime: same login = one account with total + TV room; separate respects each account\'s TV cap');
  S = base(); reset();
  primeAccount(S, 'PRI-A', 4, 2); primeAccount(S, 'PRI-B', 4, 2);
  r = await buy('Prime Video', '2 Devices 1M', { loginMode: 'same', tvCount: 1, extraFieldValue: 'TV' });
  f = await payAndFulfil(r.orderId);
  subs = newSubs();
  ok('same: one row, 2 devices, tv_count 1, MIXED', subs.length === 1 && subs[0].device_count === 2 && subs[0].tv_count === 1 && subs[0].device_type === 'MIXED', subs);

  S = base(); reset();
  primeAccount(S, 'PRI-A', 4, 1); primeAccount(S, 'PRI-B', 4, 1); primeAccount(S, 'PRI-C', 4, 1);
  occupy(S, 'PRI-A', 'Prime Video', { tv_count: 1, device_type: 'TV' }); // PRI-A: TV slot used, emptiest otherwise equal
  occupy(S, 'PRI-C', 'Prime Video', { tv_count: 0 }); occupy(S, 'PRI-C', 'Prime Video', { tv_count: 0 });
  r = await buy('Prime Video', '2 Devices 1M', { loginMode: 'separate', tvCount: 1, extraFieldValue: 'TV' });
  f = await payAndFulfil(r.orderId);
  subs = newSubs().sort((a, b) => a.group_index - b.group_index);
  ok('separate: Device 1 is the TV on an account with a free TV slot (PRI-B)', subs.length === 2 && subs[0].tv_count === 1 && subs[0].device_type === 'TV' && subs[0].inventory_ref === 'PRI-B', subs);
  ok('separate: Device 2 (mobile) on a different account, 1 device each', subs[1].tv_count === 0 && subs[1].inventory_ref !== 'PRI-B' && subs.every((s) => s.device_count === 1), subs);
  ok('per-device TV label reaches the customer', f.access.logins[0].deviceType === 'TV' && f.access.logins[1].deviceType === 'NON_TV', f.access.logins);

  S = base(); reset();
  primeAccount(S, 'PRI-A', 4, 2); primeAccount(S, 'PRI-B', 4, 1);
  occupy(S, 'PRI-B', 'Prime Video', { tv_count: 1, device_type: 'TV' }); // PRI-B has no TV slot left
  r = await buy('Prime Video', '2 Devices 1M', { loginMode: 'separate', tvCount: 2, extraFieldValue: 'TV' });
  ok('2 TVs, only one account with TV room → separate impossible → same on PRI-A (2 TV slots), told before payment', r.ok && /use this login on both devices/.test(r.loginNotice), r);
  f = await payAndFulfil(r.orderId);
  ok('delivered on PRI-A as one row', newSubs().length === 1 && newSubs()[0].inventory_ref === 'PRI-A' && newSubs()[0].tv_count === 2);
  const tvCheck = await fulfill.allocatePrimeSeparate(conn(), 2, 2);
  ok('allocatePrimeSeparate refuses 2 TVs when fewer TV-capable accounts', tvCheck.ok === false, tvCheck);

  section('server validation: mode checked, ignored where it does not apply');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 3); primeAccount(S, 'PRI-A', 4, 2);
  S.accounts.push({ service: 'JioHotstar', account_id: 'JH-1', login_id: 'j@x', password: 'p', is_active: 'TRUE', notes: '', plan: '2 Devices 1M' });
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'both please' });
  ok('junk mode refused with a plain message', r.ok === false && /same login/.test(r.message) && !S.writes.includes('order'), r);
  r = await buy('Netflix', 'Private 2 Devices 1M', {});
  ok('missing mode → same (older cached storefront)', r.ok && r.loginMode === 'same');
  r = await buy('Netflix', 'Private 1M', { loginMode: 'separate' });
  ok('1-device plan: mode ignored, nothing stored', r.ok && !r.loginMode && !('LoginMode' in JSON.parse(S.orders[S.orders.length - 1].raw_json)) && !/login_mode/.test(S.orderSql[S.orderSql.length - 1]), S.orders[S.orders.length - 1]);
  r = await buy('JioHotstar', '2 Devices 1M', { loginMode: 'separate' });
  ok('other services: mode ignored', r.ok && !r.loginMode && !('LoginMode' in JSON.parse(S.orders[S.orders.length - 1].raw_json)));
  r = await buy('Netflix', 'Private 2 Devices 1M', { loginMode: 'same', deviceCount: 1 });
  ok('client cannot lower the device count below the plan name', r.ok && r.deviceCount === 2);
  r = await order.createOrder({ service: 'Netflix', plan: 'Private 2 Devices 1M', name: 'A', email: 'a@x', phone: '9876543210', loginMode: 'separate' }, { amountOverride: 250 });
  ok('admin quick order stores the mode (no pre-payment stock refusal)', r.ok && JSON.parse(S.orders[S.orders.length - 1].raw_json).LoginMode === 'separate');

  section('before schema-v19: exactly today\'s behaviour');
  S = base({ groups: false }); reset();
  nfAccount(S, 'NF-A', 3, 2); nfAccount(S, 'NF-B', 3, 2);
  for (const acc of ['NF-A', 'NF-B']) for (let i = 0; i < 3; i++) occupy(S, acc + '#P1', 'Netflix');
  primeAccount(S, 'PRI-A', 4, 2);
  r = await buy('Prime Video', '2 Devices 1M', { loginMode: 'separate', tvCount: 1, extraFieldValue: 'TV' });
  ok('order: no LoginMode, no login_mode column, no notice', r.ok && !r.loginMode && !('LoginMode' in JSON.parse(S.orders[0].raw_json)) && !/login_mode/.test(S.orderSql[0]), S.orders[0]);
  f = await payAndFulfil(r.orderId);
  ok('fulfilment: one row, today\'s INSERT (no group columns), access without logins list', f.fulfillment === 'FULFILLED' && newSubs().length === 1 && newSubs()[0].device_count === 2 && !/group_id/.test(S.insertSql[0]) && !f.access.logins, { f, sql: S.insertSql });
  const boot = await catalog.getBootstrap();
  ok('catalog: no plan asks the question', boot.ok && !boot.plans.some((p) => p.loginChoice));
  catalog.clearCache();
  const lv = (await catalog.getStockLevels()).levels;
  ok('stock: no separate-mode numbers', !('stockSeparate' in lv['Prime Video|||2 Devices 1M']), lv['Prime Video|||2 Devices 1M']);
  S.groups = true; reset();
  const boot2 = await catalog.getBootstrap();
  ok('after schema-v19: only 2+ device Netflix / Prime plans ask', boot2.plans.filter((p) => p.loginChoice).map((p) => p.service + ' ' + p.plan).sort().join('|') === 'Netflix Private 2 Devices 1M|Netflix Sharing 2 Devices 1M|Prime Video 2 Devices 1M', boot2.plans.filter((p) => p.loginChoice));
  catalog.clearCache();
  const lv2 = (await catalog.getStockLevels()).levels['Netflix|||Private 2 Devices 1M'];
  ok('stock after v19: separate possible (2 accounts × 2 profiles) though same is not → plan stays buyable', lv2.stockSame === 0 && lv2.stockSeparate === 2 && lv2.stock === 2 && lv2.stockLevel !== 'OUT', lv2);

  // ============================================================ stock vs allocators (randomized, multi-device)
  section('stock.js agrees with the F1 allocators (randomized)');
  {
    let seed = 9091; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    let checks = 0, mismatches = 0, inStock = 0, outStock = 0;
    for (let it = 0; it < 300; it++) {
      S = base(); reset();
      const nNf = 1 + Math.floor(rnd() * 3), nPr = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < nNf; i++) {
        const id = 'NF-' + i; nfAccount(S, id, pick([2, 3, 4, 5]), Math.floor(rnd() * 4), { inactive: rnd() < 0.1 });
        const seats = Math.floor(rnd() * 5); for (let k = 0; k < seats; k++) occupy(S, id + '#P1', 'Netflix', { device_count: pick([1, 1, 2]) });
        for (let p = 2; p <= 4; p++) if (rnd() < 0.4) occupy(S, id + '#P' + p, 'Netflix', { device_count: pick([1, 2, 3]) });
      }
      for (let i = 0; i < nPr; i++) {
        const id = 'PR-' + i; primeAccount(S, id, pick([2, 3, 4]), pick([1, 2]), { inactive: rnd() < 0.1 });
        const used = Math.floor(rnd() * 4); for (let k = 0; k < used; k++) occupy(S, id, 'Prime Video', { tv_count: rnd() < 0.3 ? 1 : 0 });
      }
      const sn = await stock.loadSnapshot();
      const cases = [
        ['Netflix', 'Private 2 Devices 1M', () => fulfill.allocateProfile(conn(), 'Netflix', 'Private 2 Devices 1M', 2), () => fulfill.allocateProfileSeparate(conn(), 'Netflix', 'Private 2 Devices 1M', 2)],
        ['Netflix', 'Sharing 2 Devices 1M', () => fulfill.allocateProfile(conn(), 'Netflix', 'Sharing 2 Devices 1M', 2), () => fulfill.allocateProfileSeparate(conn(), 'Netflix', 'Sharing 2 Devices 1M', 2)],
        ['Netflix', 'Private 1M', () => fulfill.allocateProfile(conn(), 'Netflix', 'Private 1M', 1), null],
        ['Netflix', 'Sharing 1M', () => fulfill.allocateProfile(conn(), 'Netflix', 'Sharing 1M', 1), null],
        ['Prime Video', '2 Devices 1M', () => fulfill.allocatePrime(conn(), 2, 0), () => fulfill.allocatePrimeSeparate(conn(), 2, 0)],
      ];
      for (const [svc, plan, same, sep] of cases) {
        const p = S.plans.find((x) => x.service === svc && x.plan === plan);
        const a = await same(); const u = stock.unitsForPlan(sn, p);
        checks++; if (a.ok) inStock++; else outStock++;
        if ((u >= 1) !== !!a.ok) { mismatches++; if (mismatches < 4) console.log('   same mismatch', plan, u, a.ok); }
        if (sep) {
          const b = await sep(); const v = stock.unitsForPlan(sn, p, 'separate');
          checks++;
          if ((v >= 1) !== !!b.ok) { mismatches++; if (mismatches < 4) console.log('   separate mismatch', plan, v, b.ok); }
        }
      }
    }
    ok(checks + ' checks: stock ≥ 1 exactly when the allocator succeeds (same and separate)', mismatches === 0, { checks, mismatches });
    ok('fixtures covered in-stock and sold-out', inStock > 200 && outStock > 200, { inStock, outStock });
  }

  // ============================================================ renewals
  section('renewal of a purchase with separate logins');
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  const exp = local(new Date(Date.now() + 3 * DAY));
  const grpRow = (sub_id, idx, ref, o) => Object.assign({ sub_id, order_id: 'FF-OLD', phone: '9876543210', phone_norm: '9876543210', email: 'asha@x', service: 'Netflix', plan: 'Private 2 Devices 1M', expiry_date: exp, start_date: local(new Date(Date.now() - 27 * DAY)), inventory_ref: ref, account_id: ref.split('#')[0], login_id: ref.split('#')[0].toLowerCase() + '@nf', password: 'pw-' + ref.split('#')[0], profile_name: 'P2', profile_pin: '2222', profile_number: ref.split('#P')[1] || '', device_type: '', device_count: 1, tv_count: null, occupying: true, status: 'ACTIVE', removed: 0, removed_at: null, group_id: 'G-FF-OLD', group_size: 2, group_index: idx }, o || {});
  const renewOrder = (o) => Object.assign({ order_id: 'FF-R1', service: 'Netflix', plan: 'Private 2 Devices 1M', name: 'Asha', email: 'asha@x', phone: '9876543210', phone_norm: '9876543210', duration_days: 30, status: 'PAID', fulfillment_status: 'PENDING', extra_field_value: '', device_count: 2, tv_count: null, source: 'node', final_amount: 299, order_type: 'RENEW', renew_sub_id: 'SUB-ME1', raw_json: '{}' }, o || {});

  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 2); nfAccount(S, 'NF-B', 5, 2); nfAccount(S, 'NF-C', 5, 2);
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2'), grpRow('SUB-ME2', 2, 'NF-B#P2'));
  let d = await fulfill.planRenewal('SUB-ME2', 'Private 2 Devices 1M');
  ok('both accounts fine → SAME, lead is Device 1', d.mode === 'SAME' && d.leadSubId === 'SUB-ME1' && d.logins === 2 && d.devices === 2, d);
  let rr = await order.createRenewOrder('SUB-ME2');
  ok('renewing from Device 2 creates ONE order on Device 1 (no duplicate group), one plan price', rr.ok && rr.renewSubId === 'SUB-ME1' && S.orders.length === 1 && S.orders[0].renew_sub_id === 'SUB-ME1' && Number(S.orders[0].price) === 299, rr);
  S.orders = [renewOrder()];
  f = await fulfill.fulfillForAdmin('FF-R1');
  const me = (id) => S.subs.find((s) => s.sub_id === id);
  ok('both rows extended to the same new expiry and linked to the renew order', f.fulfillment === 'FULFILLED' && me('SUB-ME1').expiry_date === me('SUB-ME2').expiry_date && me('SUB-ME1').order_id === 'FF-R1' && me('SUB-ME2').order_id === 'FF-R1', S.writes);
  ok('no extra rows, group unchanged; coins + email once', newSubs().length === 0 && S.subs.filter((s) => s.group_id === 'G-FF-OLD').length === 2 && S.coins.length === 1 && S.emails.length === 1, { coins: S.coins, emails: S.emails.length });
  ok('customer sees both logins after renewal', f.access.logins.length === 2 && f.access.sameLogin === false);
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('repeat call idempotent (no second extension)', S.writes.filter((w) => /^extend/.test(w)).length === 2 && f.access.logins.length === 2, S.writes);

  section('renewal: one device\'s account retired → only that device moves (not onto the kept account when avoidable)');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 2); nfAccount(S, 'NF-B', 5, 2, { inactive: true }); nfAccount(S, 'NF-C', 5, 2);
  occupy(S, 'NF-C#P2', 'Netflix'); // NF-A and NF-C equally busy: NF-A would be first if the kept account were not avoided
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2'), grpRow('SUB-ME2', 2, 'NF-B#P2'));
  d = await fulfill.planRenewal('SUB-ME1', 'Private 2 Devices 1M');
  ok('MOVE told before payment, naming Device 2 and that Device 1 keeps its login', d.mode === 'MOVE' && /Device 2/.test(d.message) && /other device keeps its login/.test(d.message), d);
  rr = await order.createRenewOrder('SUB-ME1');
  ok('renew order carries the notice', rr.ok && rr.accountChange === true && /Device 2/.test(rr.renewNotice), rr);
  S.orders = [renewOrder()];
  f = await fulfill.fulfillForAdmin('FF-R1');
  ok('Device 2 moved to NF-C, Device 1 still on NF-A', me('SUB-ME2').inventory_ref.startsWith('NF-C#') && me('SUB-ME1').inventory_ref === 'NF-A#P2' && S.writes.includes('move:SUB-ME2') && !S.writes.includes('move:SUB-ME1'), S.writes);
  ok('moves before extensions, one transaction', S.writes.indexOf('move:SUB-ME2') < S.writes.indexOf('extend:SUB-ME1') && S.tx.join() === 'begin,commit', { w: S.writes, tx: S.tx });

  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 2); nfAccount(S, 'NF-B', 5, 2, { inactive: true });
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2'), grpRow('SUB-ME2', 2, 'NF-B#P2'));
  d = await fulfill.planRenewal('SUB-ME1', 'Private 2 Devices 1M');
  ok('no other account: may use a free profile on the kept account (still its own profile)', d.mode === 'MOVE', d);
  S.profiles = S.profiles.filter((p) => !(p.account_id === 'NF-A' && p.profile_number === '3'));
  d = await fulfill.planRenewal('SUB-ME1', 'Private 2 Devices 1M');
  ok('nothing free at all → NONE, refused before payment', d.mode === 'NONE' && /can't be paid/.test(d.message), d);
  rr = await order.createRenewOrder('SUB-ME1');
  ok('createRenewOrder blocked, no order', rr.ok === false && rr.renewBlocked === true && S.orders.length === 0, rr);

  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 2); nfAccount(S, 'NF-B', 5, 2);
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2'), grpRow('SUB-ME2', 2, 'NF-B#P2'));
  d = await fulfill.planRenewal('SUB-ME1', 'Private 1M');
  ok('renewing a 2-login purchase as a 1-device plan → refused with a clear message', d.mode === 'NONE' && /same 2-device plan/.test(d.message), d);

  section('renewal: removal counted for the purchase (removed only if every login was removed)');
  S = base(); reset();
  nfAccount(S, 'NF-A', 5, 2); nfAccount(S, 'NF-B', 5, 2);
  const late = local(new Date(Date.now() - 5 * DAY));
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2', { expiry_date: late, occupying: true, removed: 1, removed_at: local(new Date(Date.now() - 5 * DAY)) }), grpRow('SUB-ME2', 2, 'NF-B#P2', { expiry_date: late, occupying: true, removed: 0 }));
  d = await fulfill.planRenewal('SUB-ME1', 'Private 2 Devices 1M');
  ok('one device still had access → treated as not removed (5 days counted)', d.preview.case === 'KEPT_ACCESS' && d.preview.counted === 5, d.preview);
  S.subs[1].removed = 1; S.subs[1].removed_at = local(new Date(Date.now() - 5 * DAY));
  d = await fulfill.planRenewal('SUB-ME1', 'Private 2 Devices 1M');
  ok('both removed at expiry → fresh start', d.preview.case === 'REMOVED_AT_EXPIRY' && d.preview.counted === 0, d.preview);

  section('renewal: same-login Prime (one row, 2 devices), account retired, no single account fits → split');
  S = base(); reset();
  primeAccount(S, 'PRI-A', 4, 2, { inactive: true }); primeAccount(S, 'PRI-B', 2, 1); primeAccount(S, 'PRI-C', 2, 1);
  occupy(S, 'PRI-B', 'Prime Video'); occupy(S, 'PRI-C', 'Prime Video');
  S.subs.push(Object.assign(grpRow('SUB-ME1', null, 'PRI-A', { service: 'Prime Video', plan: '2 Devices 1M', device_count: 2, tv_count: 1, device_type: 'MIXED', group_id: null, group_size: null, group_index: null, profile_name: '', profile_pin: '', profile_number: '' })));
  d = await fulfill.planRenewal('SUB-ME1', '2 Devices 1M');
  ok('SPLIT told before payment', d.mode === 'SPLIT' && /each device will get its own login/.test(d.message), d);
  S.orders = [renewOrder({ service: 'Prime Video', plan: '2 Devices 1M', tv_count: 1 })];
  f = await fulfill.fulfillForAdmin('FF-R1');
  const grp = S.subs.filter((s) => s.group_id === 'G-SUB-ME1').sort((a, b) => a.group_index - b.group_index);
  ok('two rows now: lead updated to 1 device + one new row, different accounts, TV kept on one', f.fulfillment === 'FULFILLED' && grp.length === 2 && grp[0].sub_id === 'SUB-ME1' && grp.every((s) => s.device_count === 1 && s.group_size === 2) && grp[0].inventory_ref !== grp[1].inventory_ref && grp.reduce((n, s) => n + Number(s.tv_count), 0) === 1, grp);
  ok('both extended, customer gets 2 logins and the reason', grp[0].expiry_date === grp[1].expiry_date && f.access.logins.length === 2 && f.accountChanged && /own login/.test(f.message), f);
  d = await fulfill.planRenewal('SUB-ME1', '2 Devices 1M');
  ok('next renewal sees the 2-row purchase (no new group)', d.logins === 2 && d.leadSubId === 'SUB-ME1', d);

  S = base({ groups: false }); reset();
  primeAccount(S, 'PRI-A', 4, 2, { inactive: true }); primeAccount(S, 'PRI-B', 2, 1); primeAccount(S, 'PRI-C', 2, 1);
  occupy(S, 'PRI-B', 'Prime Video'); occupy(S, 'PRI-C', 'Prime Video');
  S.subs.push(grpRow('SUB-ME1', null, 'PRI-A', { service: 'Prime Video', plan: '2 Devices 1M', device_count: 2, tv_count: 1, group_id: null, group_size: null, group_index: null }));
  d = await fulfill.planRenewal('SUB-ME1', '2 Devices 1M');
  ok('before schema-v19: no split, refused as today', d.mode === 'NONE', d);

  // ============================================================ reads / recover / reminders
  section('My plans, Recover and reminders treat a group as ONE plan');
  S = base(); reset();
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2', { profile_number: '2', profile_name: 'P2' }), grpRow('SUB-ME2', 2, 'NF-B#P3', { profile_number: '3', profile_name: 'P3', login_id: 'nf-b@nf' }));
  delete require.cache[require.resolve('../reads')];
  const reads = require('../reads');
  const mine = await reads.getMySubscriptions('9876543210');
  const cards = mine.actionable.concat(mine.history);
  ok('one card with 2 devices (Device 1 / Device 2 profiles)', cards.length === 1 && cards[0].subId === 'SUB-ME1' && cards[0].deviceCount === 2 && cards[0].sameLogin === false && cards[0].devices.map((x) => x.profileNumber).join() === '2,3', cards);
  const recover = require('../recover');
  recover._internal.tokenStore.set('tok', { ph: '9876543210', em: 'asha@x', exp: Date.now() + 60000 });
  const list = await recover.listSubscriptions('9876543210', 'asha@x', 'tok');
  ok('recover lists the purchase once', list.ok && list.subscriptions.length === 1 && list.subscriptions[0].subId === 'SUB-ME1', list);
  const acc = await recover.getAccess('SUB-ME2', '9876543210', 'asha@x', 'tok');
  ok('recover shows every device, Device 1 first', acc.ok && acc.access.logins.length === 2 && acc.access.logins[0].user === 'nf-a@nf' && acc.access.logins[1].user === 'nf-b@nf' && acc.access.user === 'nf-a@nf', acc);
  S.groups = false; reset();
  const acc0 = await recover.getAccess('SUB-ME2', '9876543210', 'asha@x', 'tok');
  ok('recover before schema-v19: only the requested row, exactly as before', acc0.ok && !acc0.access.logins && acc0.access.user === 'nf-b@nf', acc0);

  S = base(); reset();
  const noon = new Date(); noon.setUTCHours(6, 30, 0, 0); // 12:00 India time
  const soon = local(new Date(noon.getTime() + 1 * DAY));
  S.subs.push(grpRow('SUB-ME1', 1, 'NF-A#P2', { expiry_date: soon }), grpRow('SUB-ME2', 2, 'NF-B#P3', { expiry_date: soon }));
  const reminders = require('../pushreminders');
  const origQuery = mockDb.query;
  mockDb.query = async (sql, p) => {
    const q = normSql(sql);
    if (/FROM app_settings/.test(q)) return [];
    if (/FROM subscriptions s WHERE s.expiry_date >= \?/.test(q)) return S.subs.map((s) => ({ sub_id: s.sub_id, phone_norm: s.phone_norm, service: s.service, plan: s.plan, expiry_date: s.expiry_date, status: 'ACTIVE', has_newer: 0, group_index: /group_index/.test(q) ? s.group_index : undefined }));
    if (/FROM reminder_log/.test(q)) return [];
    if (/INSERT INTO reminder_log/.test(q)) return { affectedRows: 1 };
    return origQuery(sql, p);
  };
  const out = await reminders.run(noon);
  mockDb.query = origQuery;
  ok('push reminder sent once for the 2-login purchase', out.sent === 1 && S.pushes.length === 1, { out, pushes: S.pushes.length });

  section('email + storefront + admin wiring');
  {
    const sent = [];
    Module._load = function (req) {
      if (req === './smtp') return { status: () => ({ configured: true }), sendMail: async (m) => { sent.push(m); return { ok: true }; } };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('../mailer')];
    const mailer = require('../mailer');
    await mailer.sendAccessEmail({ email: 'a@x', name: 'Asha', service: 'Netflix', plan: 'Private 2 Devices 1M', orderId: 'FF1', access: { user: 'a@nf', pass: 'p1', logins: [{ device: 1, user: 'a@nf', pass: 'p1', profileName: 'P2', profileNumber: '2', profilePin: '22' }, { device: 2, user: 'b@nf', pass: 'p2', profileName: 'P3', profileNumber: '3', profilePin: '33' }], sameLogin: false }, loginNotice: 'Why <b>' });
    ok('email: Device 1 and Device 2 blocks with each login', /Device 1/.test(sent[0].html) && /Device 2/.test(sent[0].html) && /b@nf/.test(sent[0].html) && /p2/.test(sent[0].html), sent[0] && sent[0].html.slice(0, 300));
    ok('email: notice escaped', /Why &lt;b&gt;/.test(sent[0].html));
    await mailer.sendAccessEmail({ email: 'a@x', service: 'Prime Video', plan: '2 Devices 1M', orderId: 'FF2', access: { user: 'a@p', pass: 'p', logins: [{ device: 1, user: 'a@p', pass: 'p' }, { device: 2, user: 'a@p', pass: 'p' }], sameLogin: true } });
    ok('email: same login → one block + "Use this same login on both devices"', /Use this same login on both devices/.test(sent[1].html) && !/Device 2/.test(sent[1].html));
    Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  }
  const scriptsOf = (file) => { const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); return [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); };
  for (const file of ['index.html', 'admin.html']) {
    let parsed = true; for (const sc of scriptsOf(file)) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error in', file, e.message); } }
    ok(file + ': every inline <script> parses', parsed);
  }
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('storefront asks only when the plan says loginChoice, and sends loginMode', /function LoginModeSelect\(/.test(idx) && /if \(!planObj \|\| !planObj\.loginChoice\) return null;/.test(idx) && /loginMode: planObj\?\.loginChoice \? form\?\.loginMode \|\| '' : ''/.test(idx));
  ok('storefront question wording + big buttons', /Same login on " \+ both \+ ", or a separate login for each device\?/.test(idx) && /Each device gets its own ID and password\./.test(idx));
  ok('storefront shows per-device credentials and the "same login" line', /function DeviceLoginsCard\(/.test(idx) && /Use this same login on /.test(idx) && /'📱 Device ' \+ x\.device/.test(idx));
  ok('storefront pay screen shows the login notice before payment', /loginNotice: r\.loginNotice \|\| ''/.test(idx) && /"ℹ️ ", loginNotice/.test(idx));
  const adm = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin shows "Device i of N" on subscription cards', (adm.match(/Device ' \+ esc\(s\.group_index\) \+ ' of ' \+ esc\(s\.group_size\)/g) || []).length === 2);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v19.sql'), 'utf8');
  ok('schema-v19 adds group_id / group_size / group_index / orders.login_mode with plain ALTERs (phpMyAdmin on Hostinger refuses information_schema + PREPARE), no data changes', ['subscriptions ADD COLUMN group_id', 'subscriptions ADD COLUMN group_size', 'subscriptions ADD COLUMN group_index', 'orders ADD COLUMN login_mode'].every((c) => schema.includes('ALTER TABLE ' + c)) && !/PREPARE|information_schema\.columns WHERE/i.test(schema.replace(/^--.*$/gm, '')) && !/DROP |DELETE |UPDATE /i.test(schema));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
