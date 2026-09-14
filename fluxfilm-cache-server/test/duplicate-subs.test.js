/* Duplicate-subscription guard (fulfill.js). Run: npm test
 *
 * What happened (test order FF0215802, Prime ₹39, 2026-07-16/17 on staging): fulfilment inserted the subscription,
 * then "UPDATE orders SET … inventory_ref = ?" failed (orders has no such column), so the order never became
 * FULFILLED. The checkout page polled every few seconds and each poll allocated another Prime account:
 * 54 subscriptions on ~30 accounts in 14 minutes. These tests replay that failure. */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let S = null;
function fresh(opts) {
  const o = opts || {};
  S = {
    tx: !!o.tx, failFulfilled: o.failFulfilled || 0, inTx: null,
    order: Object.assign({ order_id: 'FFDUP1', service: 'Prime Video', plan: '1 Month', name: 'T', email: 't@example.test', phone: '9000000001', phone_norm: '9000000001', duration_days: 30, status: 'PAID', fulfillment_status: 'PENDING', extra_field_value: 'NON_TV', device_count: 1, tv_count: 0, source: 'node', final_amount: 39, order_type: 'NEW', renew_sub_id: '', raw_json: '{}' }, o.order || {}),
    policy: o.policy || 'CAPACITY',
    subs: (o.subs || []).slice(),
    accounts: [1, 2, 3, 4, 5].map((n) => ({ service: 'Prime Video', account_id: 'PR-' + n, login_id: 'p' + n + '@example.test', password: 'pw', is_active: 'TRUE' })),
    inserts: 0,
  };
}
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
function run(sqlRaw, params, conn) {
  const sql = norm(sqlRaw);
  const subs = conn && conn.pending ? S.subs.concat(conn.pending) : S.subs;
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  if (/information_schema/.test(sql)) return [{ n: 0 }];
  if (/^SELECT order_id, service, plan/.test(sql) && /FROM orders WHERE order_id = \?/.test(sql)) return [Object.assign({}, S.order)];
  if (/^SELECT fulfillment_status FROM orders/.test(sql)) return [{ fulfillment_status: S.order.fulfillment_status }];
  if (/^SELECT phone_norm, order_type, raw_json FROM orders/.test(sql)) return [S.order];
  if (/SELECT raw_json FROM plans/.test(sql)) return [{ raw_json: JSON.stringify({ AllocationPolicy: S.policy, FulfillmentMode: S.policy === 'NONE' ? 'MANUAL' : 'INSTANT' }) }];
  if (/FROM inventory_accounts/.test(sql)) return S.accounts;
  if (/FROM inventory_capacity/.test(sql)) return [];
  if (/FROM subscriptions WHERE LOWER\(service\) LIKE '%prime%'/.test(sql)) {
    const m = new Map(); for (const x of subs) m.set(x.inventory_ref, (m.get(x.inventory_ref) || 0) + 1);
    return [...m.entries()].map(([k, v]) => ({ inventory_ref: k, total: v, tv: 0 }));
  }
  if (/^SELECT 1 FROM subscriptions WHERE sub_id = \?/.test(sql)) return [];
  if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return subs.filter((x) => x.order_id === params[0]).slice(0, /LIMIT 1/.test(sql) ? 1 : 99);
  if (/^INSERT INTO subscriptions/.test(sql)) {
    const row = { sub_id: params[0], order_id: params[1], inventory_ref: params[10], login_id: /MANUAL_PENDING/.test(sql) ? '' : params[12], password: 'pw', fulfillment_status: /MANUAL_PENDING/.test(sql) ? 'MANUAL_PENDING' : 'FULFILLED' };
    S.inserts++;
    if (conn && conn.pending) conn.pending.push(row); else S.subs.push(row);
    return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = NOW\(\)/.test(sql)) {
    if (S.failFulfilled > 0) { S.failFulfilled--; throw new Error("Unknown column 'inventory_ref' in 'field list'"); }
    if (conn && conn.pendingOrder !== undefined) conn.pendingOrder = 'FULFILLED'; else S.order.fulfillment_status = 'FULFILLED';
    return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = COALESCE/.test(sql)) { S.order.fulfillment_status = 'FULFILLED'; return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'MANUAL_PENDING'/.test(sql)) {
    if (S.failFulfilled > 0 && !/COALESCE/.test(sql)) { S.failFulfilled--; throw new Error('write failed'); }
    S.order.fulfillment_status = 'MANUAL_PENDING'; return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FAILED'/.test(sql)) { S.order.fulfillment_status = 'FAILED'; return { affectedRows: 1 }; }
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 120));
}
// MySQL GET_LOCK: one holder at a time (the fake must serialise like the real lock does).
let lockTail = Promise.resolve();
function makeConn() {
  const c = { release() {} };
  c.query = async (sql, p) => {
    if (/GET_LOCK/.test(sql)) { let rel; const mine = new Promise((r) => { rel = r; }); const prev = lockTail; lockTail = prev.then(() => mine); await prev; c.unlock = rel; return [[{ l: 1 }]]; }
    if (/RELEASE_LOCK/.test(sql)) { if (c.unlock) { c.unlock(); c.unlock = null; } return [[{ l: 1 }]]; }
    return [run(sql, p, c)];
  };
  if (S.tx) {
    c.beginTransaction = async () => { c.pending = []; c.pendingOrder = null; };
    c.commit = async () => { S.subs.push(...c.pending); if (c.pendingOrder) S.order.fulfillment_status = c.pendingOrder; c.pending = null; c.pendingOrder = undefined; };
    c.rollback = async () => { c.pending = null; c.pendingOrder = undefined; };
  }
  return c;
}
const pool = { query: async (sql, p) => [run(sql, p)], getConnection: async () => makeConn() };
// Coins / email / push after delivery talk to db.query: answer softly (they never block delivery).
const mockDb = { ENABLED: true, getPool: () => pool, query: async () => [], ping: async () => ({ ok: true }) };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './mailer') return { sendAccessEmail: async () => {}, send: async () => {} };
  if (req === './pushreminders') return { notifyDelivered: async () => {} };
  if (req === './coins') return { awardCoins: async () => ({ ok: true }) };
  return origLoad.apply(this, arguments);
};
const fulfill = require('../fulfill');
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const ofOrder = (id) => S.subs.filter((x) => x.order_id === (id || 'FFDUP1'));

(async () => {
  section('replay July: the order status write fails, the checkout keeps polling');
  fresh({ tx: false, failFulfilled: 1000 });
  let last; const polls = [];
  await quiet(async () => { for (let i = 0; i < 54; i++) polls.push(last = await fulfill.fulfillAndGetAccess('FFDUP1', { phone: '9000000001' })); });
  ok('54 polls on a connection without transactions: ONE subscription, not 54', ofOrder().length === 1 && S.inserts === 1, { rows: ofOrder().length, inserts: S.inserts });
  ok('the first poll fails like July; the next one is stopped by the guard, shows the existing login and repairs the order', polls[0].fulfillment === 'ERROR' && polls[1].duplicateGuard === true && polls[1].access.user === ofOrder()[0].login_id && S.order.fulfillment_status === 'FULFILLED' && last.fulfillment === 'FULFILLED', polls.slice(0, 2));

  fresh({ tx: true, failFulfilled: 5 });
  const results = [];
  await quiet(async () => { for (let i = 0; i < 12; i++) results.push(await fulfill.fulfillAndGetAccess('FFDUP1', { phone: '9000000001' })); });
  ok('with transactions: failed attempts leave no subscription behind (rolled back)', results.slice(0, 5).every((r) => r.fulfillment === 'ERROR') && S.inserts === 6, { inserts: S.inserts, results: results.slice(0, 5).map((r) => r.fulfillment) });
  ok('once the write works: exactly one subscription, later polls add nothing', ofOrder().length === 1 && results.slice(5).every((r) => r.fulfillment === 'FULFILLED') && S.order.fulfillment_status === 'FULFILLED', { rows: ofOrder().length, inserts: S.inserts, results: results.map((r) => r.fulfillment) });

  section('an order that already has a delivered subscription');
  fresh({ tx: true, order: { fulfillment_status: 'FAILED' }, subs: [{ sub_id: 'SUB-OLD', order_id: 'FFDUP1', inventory_ref: 'PR-2', login_id: 'p2@example.test', password: 'pw', fulfillment_status: 'FULFILLED' }] });
  last = await quiet(() => fulfill.fulfillForAdmin('FFDUP1'));
  ok('admin re-fulfil of a "FAILED" order that has a login: nothing allocated, existing login shown', S.inserts === 0 && ofOrder().length === 1 && last.fulfillment === 'FULFILLED' && last.access.user === 'p2@example.test', { last, inserts: S.inserts });
  fresh({ tx: true, subs: [{ sub_id: 'SUB-PH', order_id: 'FFDUP1', inventory_ref: '', login_id: '', fulfillment_status: 'PENDING' }] });
  last = await quiet(() => fulfill.fulfillForAdmin('FFDUP1'));
  ok('a placeholder row without a login does not block the real delivery', S.inserts === 1 && last.fulfillment === 'FULFILLED', { last, inserts: S.inserts });
  fresh({ tx: true });
  await quiet(async () => { await Promise.all([1, 2, 3, 4, 5, 6].map(() => fulfill.fulfillAndGetAccess('FFDUP1', { phone: '9000000001' }))); });
  ok('six polls at the same moment: one subscription', ofOrder().length === 1 && S.inserts === 1, { rows: ofOrder().length, inserts: S.inserts });

  section('manual plans');
  fresh({ tx: false, policy: 'NONE', failFulfilled: 3, order: { service: 'YouTube Premium', plan: '1 Month' } });
  await quiet(async () => { for (let i = 0; i < 6; i++) await fulfill.fulfillAndGetAccess('FFDUP1', { phone: '9000000001' }); });
  ok('status write failing 3 times: still ONE "to activate" row', ofOrder().length === 1 && S.inserts === 1 && S.order.fulfillment_status === 'MANUAL_PENDING', { rows: ofOrder().length, inserts: S.inserts, st: S.order.fulfillment_status });

  ok('the guard lives inside the allocation lock, before any allocation', /withLock\('ff_alloc'[\s\S]{0,1200}_deliveredRowsGuard\(conn, o\.order_id\)[\s\S]{0,600}pickAllocation|_deliveredRowsGuard\(conn, o\.order_id\)[\s\S]*_deviceLoginsOn/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'fulfill.js'), 'utf8')));

  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('duplicate-subs: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
