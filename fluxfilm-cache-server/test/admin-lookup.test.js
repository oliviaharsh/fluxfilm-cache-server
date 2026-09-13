/* Admin order lookup + stock levels + Customer 360 name search. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const calls = [];
let orderRow = null;
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params });
    if (/^SELECT order_id, created_at_sheet, name, phone_norm, service, plan, final_amount, status, fulfillment_status, order_type, source FROM orders/.test(sql)) return [{ order_id: 'FF1', name: 'A', phone_norm: '9876543210', service: 'Netflix', plan: 'Private 1M', final_amount: 199, status: 'PAID', fulfillment_status: 'FAILED', order_type: 'NEW', source: 'node' }];
    if (/FROM orders WHERE order_id = \? LIMIT 1$/.test(sql) && /raw_json/.test(sql)) return orderRow ? [Object.assign({}, orderRow)] : [];
    if (/^SELECT status, source FROM orders/.test(sql)) return orderRow ? [{ status: orderRow.status, source: orderRow.source }] : [];
    if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return [{ sub_id: 'SUB-9', service: 'Netflix', plan: 'Private 1M', login_id: 'l@x', password: 'p', inventory_ref: 'NF-01#P2' }];
    if (/FROM bank_credits WHERE consumed_order_id/.test(sql)) return [{ id: 3, upi_ref: '123456789012', amount: 199, received_at: '2026-09-14 10:00:00' }];
    if (/FROM coupon_usage WHERE order_id/.test(sql)) return [];
    if (/FROM customers WHERE phone_norm/.test(sql)) return [{ name: 'A', email: 'a@x', customer_id: 'CUS-1' }];
    // stock
    if (/FROM inventory_accounts ORDER BY/.test(sql)) return [
      { service: 'Prime Video', account_id: 'PRI-01', login_id: 'p1@x', is_active: 'TRUE' },
      { service: 'Prime Video', account_id: 'PRI-02', login_id: 'p2@x', is_active: 'TRUE' },
      { service: 'Prime Video', account_id: 'PRI-03', login_id: 'p3@x', is_active: 'FALSE' },
      { service: 'Netflix', account_id: 'NF-01', login_id: 'n@x', is_active: 'TRUE' },
      { service: 'JioHotstar', account_id: 'JH-01', login_id: '98181', is_active: 'TRUE', plan: '3 Months' },
      { service: 'YouTube Premium', account_id: 'YT-01', login_id: 'y@x', is_active: 'TRUE' },
    ];
    if (/FROM inventory_capacity$/.test(sql)) return [{ service: 'Prime Video', account_id: 'PRI-02', max_total: 3, max_tv: 1, is_active: 'TRUE' }, { service: 'JioHotstar', account_id: 'JH-01', max_total: 2, is_active: 'TRUE' }];
    if (/FROM inventory_profiles$/.test(sql)) return [1, 2, 3, 4, 5].map((n) => ({ service: 'Netflix', account_id: 'NF-01', profile_number: n }));
    if (/GROUP BY inventory_ref$/.test(sql) && /SUM\(COALESCE\(device_count, 1\)\)/.test(sql)) return [
      { inventory_ref: 'PRI-01', subs: 4, devices: 4, tv: 1 },
      { inventory_ref: 'PRI-02', subs: 1, devices: 1, tv: 1 },
      { inventory_ref: 'NF-01#P2', subs: 1, devices: 1, tv: 0 },
      { inventory_ref: 'NF-01#P3', subs: 1, devices: 1, tv: 0 },
      { inventory_ref: 'JH-01', subs: 1, devices: 1, tv: 0 },
    ];
    if (/COALESCE\(removed, 0\) = 0 GROUP BY inventory_ref/.test(sql)) return [{ inventory_ref: 'NF-01#P4', n: 2 }, { inventory_ref: 'PRI-01', n: 1 }];
    return { affectedRows: 1 };
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};
const fulfilCalls = [];
const lookupDeps = {
  fulfill: { fulfillForAdmin: async (id) => { fulfilCalls.push(id); return { ok: true, fulfillment: 'FULFILLED', message: '✅ Your access is ready!' }; } },
  catalog: {
    getBootstrap: async () => ({ ok: true, plans: [
      { service: 'Prime Video', plan: '1 Month', price: 39, durationDays: 30, allocationPolicy: 'CAPACITY' },
      { service: 'Netflix', plan: 'Private 1M', price: 199, durationDays: 30, allocationPolicy: 'PROFILE' },
      { service: 'JioHotstar', plan: '3 Months', price: 111, durationDays: 90, allocationPolicy: 'OTP_ACCOUNT' },
      { service: 'YouTube Premium', plan: '1 Month', price: 99, durationDays: 30, fulfillmentMode: 'MANUAL', allocationPolicy: 'NONE' },
    ] }),
    getStockLevels: async () => ({ ok: true, levels: { 'Prime Video|||1 Month': { stock: 2, stockLevel: 'LOW', source: 'inventory' }, 'Netflix|||Private 1M': { stock: 0, stockLevel: 'OUT', source: 'inventory' }, 'YouTube Premium|||1 Month': { stock: null, stockLevel: 'OK', source: 'manual' } } }),
  },
};

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), lookup: lookupDeps });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const lastSql = (re) => [...calls].reverse().find((c) => re.test(c.sql));

  section('order search');
  let r = await get('/admin/api/orders/search?q=rahul');
  let c = lastSql(/FROM orders WHERE/);
  ok('searches order id, name, email, UTR and service', r.body.ok && /order_id LIKE \? OR name LIKE \? OR email LIKE \? OR txn_ref LIKE \? OR service LIKE \? OR phone_norm LIKE \?/.test(c.sql) && c.params[0] === '%rahul%' && c.params[5] === '__no_match__', c);
  await get('/admin/api/orders/search?q=98765');
  ok('digits also search the phone', lastSql(/FROM orders WHERE/).params[5] === '%98765%');
  await get('/admin/api/orders/search?view=undelivered');
  c = lastSql(/FROM orders WHERE/);
  ok('"paid, not delivered" view', /UPPER\(status\) = 'PAID' AND UPPER\(COALESCE\(fulfillment_status, ''\)\) NOT IN \('FULFILLED', 'MANUAL_PENDING'\)/.test(c.sql), c.sql);
  ok('  ...skips old orders that did get a subscription', /NOT EXISTS \(SELECT 1 FROM subscriptions s WHERE s\.order_id = orders\.order_id\)/.test(c.sql), c.sql);

  section('extra OTP services from settings');
  const otpInternal = () => { delete require.cache[require.resolve('../otp')]; return require('../otp')._internal; };
  delete process.env.OTP_EXTRA_KEYWORDS;
  ok('without the setting, Prime Video + Shopping is not an OTP service', otpInternal().svcKeyOf('Prime Video + Shopping') === 'Prime Video + Shopping' && otpInternal().svcKeyOf('Zee5 Premium') === 'Zee5');
  process.env.OTP_EXTRA_KEYWORDS = JSON.stringify({ 'Prime Video + Shopping': ['Amazon', 'AMZN'], Prime: ['prime'] });
  ok('OTP_EXTRA_KEYWORDS adds it; the longer name wins over "Prime"', otpInternal().svcKeyOf('Prime Video + Shopping') === 'Prime Video + Shopping' && otpInternal().svcKeyOf('Prime Video') === 'Prime');
  ok('built-in services still resolve', otpInternal().svcKeyOf('JioHotstar') === 'JioHotstar');
  process.env.OTP_EXTRA_KEYWORDS = '{not json';
  ok('broken setting is ignored, nothing crashes', otpInternal().svcKeyOf('Zee5 Premium') === 'Zee5');
  delete process.env.OTP_EXTRA_KEYWORDS;
  await get('/admin/api/orders/search?view=' + encodeURIComponent("all' OR 1=1"));
  c = lastSql(/FROM orders/);
  ok('unknown view falls back to all (no SQL from the URL)', !/OR 1=1/.test(c.sql) && !/ WHERE /.test(c.sql), c.sql);

  section('order detail');
  orderRow = { order_id: 'FF1', phone_norm: '9876543210', status: 'PAID', fulfillment_status: 'FULFILLED', source: 'node', renew_sub_id: '', raw_json: JSON.stringify({ CreatedVia: 'ADMIN', PaymentMethod: 'CASH', AdminNote: 'paid on WhatsApp', AccessTokenHash: 'secret-hash' }) };
  r = await get('/admin/api/orders/detail?id=FF1');
  ok('order + subscription + bank credit + customer', r.body.ok && r.body.subs[0].sub_id === 'SUB-9' && r.body.bankCredits[0].upi_ref === '123456789012' && r.body.customer.customer_id === 'CUS-1', r.body);
  ok('shows how it was created and paid', r.body.meta.createdVia === 'ADMIN' && r.body.meta.paymentMethod === 'CASH' && r.body.meta.adminNote === 'paid on WhatsApp');
  ok('never sends raw_json / the access-token hash', !('raw_json' in r.body.order) && !JSON.stringify(r.body).includes('secret-hash'));
  orderRow = null;
  r = await get('/admin/api/orders/detail?id=FF404');
  ok('unknown order -> 404', r.status === 404);

  section('retry delivery');
  orderRow = { status: 'CREATED', source: 'node' };
  r = await post('/admin/api/orders/retry-fulfil', { orderId: 'FF1' });
  ok('unpaid order cannot be delivered', r.status === 400 && /not paid/.test(r.body.message) && fulfilCalls.length === 0);
  orderRow = { status: 'PAID', source: 'legacy' };
  r = await post('/admin/api/orders/retry-fulfil', { orderId: 'FF1' });
  ok('old Sheet order refused', r.status === 400 && fulfilCalls.length === 0);
  orderRow = { status: 'PAID', source: 'node' };
  r = await post('/admin/api/orders/retry-fulfil', { orderId: 'FF1' });
  const reset = lastSql(/^UPDATE orders SET fulfillment_status = 'PENDING'/);
  ok('paid order: clears FAILED and delivers again', r.body.ok && fulfilCalls[0] === 'FF1' && reset && /IN \('FAILED', 'ERROR', ''\)/.test(reset.sql), r.body);

  section('stock');
  r = await get('/admin/api/stock');
  const acc = (id) => r.body.accounts.find((a) => a.accountId === id);
  ok('plan stock = the storefront numbers', r.body.ok && r.body.plans.find((p) => p.service === 'Netflix').stockLevel === 'OUT' && r.body.plans.find((p) => p.service === 'Prime Video').stock === 2, r.body.plans);
  ok('Prime default capacity 4 devices: 4 used -> FULL', acc('PRI-01').status === 'FULL' && acc('PRI-01').cap === 4 && acc('PRI-01').free === 0, acc('PRI-01'));
  ok('Prime custom capacity 3/1 TV: TV slot used -> TV_FULL with 2 free devices', acc('PRI-02').status === 'TV_FULL' && acc('PRI-02').free === 2 && acc('PRI-02').tvUsed === 1, acc('PRI-02'));
  ok('inactive account marked INACTIVE', acc('PRI-03').status === 'INACTIVE');
  ok('Netflix counts profiles: 2 of 5 used', acc('NF-01').unit === 'profiles' && acc('NF-01').cap === 5 && acc('NF-01').used === 2 && acc('NF-01').status === 'OK', acc('NF-01'));
  ok('expired-but-not-removed customers counted per account (profiles roll up)', acc('NF-01').expiredOnAccount === 2 && acc('PRI-01').expiredOnAccount === 1);
  ok('OTP login capacity from inventory_capacity (1 of 2)', acc('JH-01').cap === 2 && acc('JH-01').used === 1 && acc('JH-01').free === 1, acc('JH-01'));
  ok('manual service has no capacity', acc('YT-01').status === 'MANUAL' && acc('YT-01').cap === null);
  ok('stock endpoint needs admin', (await fetch(base + '/admin/api/stock')).status === 403);

  section('panel');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel parses and has Orders + Stock screens', parsed && /function ordersView\(/.test(html) && /function stockView\(/.test(html) && /\['orders', '🧾', 'Orders'\]/.test(html));
  ok('Customer 360 searches by name / email', /attachCustomerSearch\(\$\('#cp'\)/.test(html) && /Search by name, phone, email or customer ID/.test(html));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
