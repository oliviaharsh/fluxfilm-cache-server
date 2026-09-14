/* Safe go → shop import (cutover.js): copies go's real data without duplicates, never touches shop-owned data. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const future = '2030-01-01 00:00:00'; const past = '2024-01-01 00:00:00';
const DB = {
  orders: [
    { order_id: 'FF1000001', source: null, status: 'CREATED', fulfillment_status: 'PENDING', final_amount: '169.00', phone: '9876543210', service: 'Netflix', plan: 'Private 1M', txn_ref: null },
    { order_id: 'FF2000002', source: 'node', status: 'PAID', fulfillment_status: 'FULFILLED', final_amount: '5.00', phone: '9999999999', service: 'Prime Video', plan: '1 Month', txn_ref: 'X' },
    { order_id: 'FF4000004', source: null, status: 'PAID', fulfillment_status: 'FULFILLED', final_amount: '99.00', phone: '9123456789', service: 'Zee5', plan: '1 Month', txn_ref: 'R4' },
  ],
  subscriptions: [
    { sub_id: 'SUB-1', source: null, status: 'ACTIVE', expiry_date: '2026-09-01 00:00:00', new_expiry: null, inventory_ref: 'NF-01#P1', account_id: 'NF-01', login_id: 'a@x', password: 'p', profile_number: '1', release_eligible_at: null, phone: '9876543210', phone_norm: '9876543210' },
    { sub_id: 'SUB-9', source: 'node', status: 'ACTIVE', expiry_date: future, new_expiry: null, inventory_ref: 'NF-01#P2', account_id: 'NF-01', login_id: 'a@x', password: 'p', profile_number: '2', release_eligible_at: null, phone: '9999999999', phone_norm: '9999999999' },
  ],
  customers: [
    { phone: '9876543210', phone_norm: '9876543210', name: 'Rahul', email: '', profile_pic_url: null, member_since: null },
  ],
  wallet: [{ phone: '9876543210', phone_norm: '9876543210', coins_balance: '10.00', coins_lifetime: '10.00' }, { phone: '9222222222', phone_norm: '9222222222', coins_balance: '75.00', coins_lifetime: '80.00' }],
  coins_ledger: [{ phone_norm: '9222222222' }],
  coupon_usage: [{ order_id: 'FF2000002' }, { order_id: 'OLD-IMPORTED' }],
  sync_log: [],
};
const SHEET = {
  ORDERS: [
    { OrderID: 'FF1000001', CreatedAt: '2026-09-10 10:00:00', Service: 'Netflix', Plan: 'Private 1M', Phone: '9876543210', FinalAmount: 169, Status: 'PAID', FulfillmentStatus: 'FULFILLED', TxnRef: 'R1' },
    { OrderID: 'FF2000002', CreatedAt: '2026-09-11 10:00:00', Service: 'Netflix', Plan: 'Private 1M', Phone: '9000000001', FinalAmount: 169, Status: 'PAID', FulfillmentStatus: 'FULFILLED' },
    { OrderID: 'FF3000003', CreatedAt: '2026-09-12 10:00:00', Service: 'Netflix', Plan: 'Private 1M', Phone: '9000000001', FinalAmount: 100, Status: 'CREATED' },
    { OrderID: 'FF3000003', CreatedAt: '2026-09-12 10:00:00', Service: 'Netflix', Plan: 'Private 1M', Phone: '9000000001', FinalAmount: 169, Status: 'PAID', FulfillmentStatus: 'FULFILLED', TxnRef: 'R3' },
    { OrderID: 'FF4000004', CreatedAt: '2026-09-01 10:00:00', Service: 'Zee5', Plan: '1 Month', Phone: '9123456789', FinalAmount: 99, Status: 'PAID', FulfillmentStatus: 'FULFILLED', TxnRef: 'R4' },
    { OrderID: '', Service: 'Netflix' },
  ],
  SUBSCRIPTIONS: [
    { SubID: 'SUB-1', OrderID: 'FF1000001', Phone: '9876543210', Service: 'Netflix', Plan: 'Private 1M', ExpiryDate: '2030-02-01 00:00:00', Status: 'ACTIVE', InventoryRef: 'NF-01#P1', AccountID: 'NF-01', LoginId: 'a@x', Password: 'p', ProfileNumber: '1' },
    { SubID: 'SUB-2', OrderID: 'FF3000003', Phone: '9000000001', Service: 'Netflix', Plan: 'Private 1M', ExpiryDate: '2030-03-01 00:00:00', Status: 'ACTIVE', InventoryRef: 'NF-01#P2', AccountID: 'NF-01', LoginId: 'a@x', Password: 'p', ProfileNumber: '2' },
  ],
  CUSTOMERS: [
    { Phone: '+91 98765 43210', Name: 'Rahul Sharma', Email: 'rahul@example.com' },
    { Phone: '919000000001', Name: 'Asha', Email: 'asha@example.com', MemberSince: '2026-09-11 10:00:00' },
    { Phone: '9111111111', Name: '', Email: 'dev@example.com' },
    { Phone: '+91-9111111111', Name: 'Dev', Email: '' },
  ],
  WALLET: [
    { Phone: '9876543210', CoinsBalance: 50, CoinsLifetime: 60 },
    { Phone: '9000000001', CoinsBalance: 8, CoinsLifetime: 8 },
    { Phone: '9222222222', CoinsBalance: 999, CoinsLifetime: 999 },
  ],
  COUPON_USAGE: [{ CouponCode: 'FLUX20', Phone: '9000000001', OrderID: 'FF3000003', Action: 'USED' }],
};

const inList = (p) => new Set(p.map(String));
// Like mysql2: db.query uses prepared statements (execute), which cannot expand a bulk "VALUES ?"; pool.query can.
const exec = async (sql, p, viaPool) => {
    if (!viaPool && /VALUES \?/.test(sql)) throw new Error("You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '?' at line 1");
    return runSql(sql, p);
};
const mockDb = {
  ENABLED: true,
  getPool: () => ({ query: async (sql, p) => [await exec(sql, p, true)] }),
  query: async (sql, p) => exec(sql, p, false),
};
async function runSql(sql, p) {
  {
    sql = sql.replace(/\s+/g, ' ').trim();
    let m;
    if ((m = sql.match(/^SELECT `(\w+)`.* FROM `(orders|subscriptions)` WHERE `\w+` IN/))) { const set = inList(p); return DB[m[2]].filter((r) => set.has(r[m[1]])).map((r) => Object.assign({}, r)); }
    if (/^SELECT phone, phone_norm, name, email, profile_pic_url, member_since FROM customers WHERE phone_norm IN/.test(sql)) { const set = inList(p); return DB.customers.filter((r) => set.has(r.phone_norm)).map((r) => Object.assign({}, r)); }
    if (/^SELECT COUNT\(\*\) n FROM coupon_usage t JOIN orders/.test(sql)) return [{ n: DB.coupon_usage.filter((u) => DB.orders.some((o) => o.order_id === u.order_id && o.source === 'node')).length }];
    if (/^SELECT COUNT\(\*\) n FROM coupon_usage$/.test(sql)) return [{ n: DB.coupon_usage.length }];
    if (/^SELECT DISTINCT phone_norm FROM coins_ledger/.test(sql)) { const set = inList(p); return DB.coins_ledger.filter((r) => set.has(r.phone_norm)); }
    if (/^SELECT phone_norm, coins_balance, coins_lifetime FROM wallet/.test(sql)) { const set = inList(p); return DB.wallet.filter((r) => set.has(r.phone_norm)); }
    if (/^SELECT sub_id, inventory_ref, phone_norm FROM subscriptions WHERE source = 'node'/.test(sql)) return DB.subscriptions.filter((r) => r.source === 'node' && r.status === 'ACTIVE' && r.expiry_date > '2026' && r.inventory_ref.includes('#'));
    if (/^INSERT IGNORE INTO customers/.test(sql)) { let n = 0; for (const v of p[0]) { if (DB.customers.some((c) => c.phone === v[0])) continue; DB.customers.push({ phone: v[0], phone_norm: v[1], name: v[2], email: v[3], profile_pic_url: v[4], member_since: v[5] }); n++; } return { affectedRows: n }; }
    if (/^UPDATE customers SET name = IF/.test(sql)) { let n = 0; for (const c of DB.customers.filter((x) => x.phone_norm === p[4])) { if (!c.name) c.name = p[0]; if (!c.email) c.email = p[1]; if (!c.profile_pic_url) c.profile_pic_url = p[2]; if (!c.member_since) c.member_since = p[3]; n++; } return { affectedRows: n }; }
    if (/^UPDATE wallet SET/.test(sql)) { const rows = DB.wallet.filter((w) => w.phone_norm === p[6]); rows.forEach((w) => { w.coins_balance = p[0]; w.coins_lifetime = p[1]; }); return { affectedRows: rows.length }; }
    if (/^INSERT IGNORE INTO wallet/.test(sql)) { DB.wallet.push({ phone: p[0], phone_norm: p[1], coins_balance: p[2], coins_lifetime: p[3] }); return { affectedRows: 1 }; }
    if (/^INSERT INTO sync_log/.test(sql)) { DB.sync_log.push(p); return { affectedRows: 1 }; }
    throw new Error('unexpected SQL in test: ' + sql.slice(0, 120));
  }
}
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; if (req === 'dotenv') return { config: () => {} }; return orig.apply(this, arguments); }; })(Module._load);
const sync = require('../sync');
const cutover = require('../cutover');
cutover._internal.deps.fetchDump = async (tab) => (SHEET[tab] || []).map((r) => Object.assign({}, r));
cutover._internal.deps.now = () => new Date('2026-09-14T18:00:00+05:30');
// Same rules as sync.upsert: by primary key; a shop (source='node') row is never overwritten; coupon_usage keeps shop rows.
const upserts = [];
sync._internal.upsert = async (table, def, rows) => {
  upserts.push([table, rows.length]);
  if (table === 'coupon_usage') {
    DB.coupon_usage = DB.coupon_usage.filter((u) => DB.orders.some((o) => o.order_id === u.order_id && o.source === 'node')).concat(rows.map((r) => ({ order_id: r.order_id })));
    return rows.length;
  }
  for (const r of rows) {
    const ex = DB[table].find((x) => x[def.pk] === r[def.pk]);
    if (!ex) DB[table].push(Object.assign({ source: null }, r));
    else if (ex.source !== 'node') Object.assign(ex, r);
  }
  return rows.length;
};

(async () => {
  section('preview writes nothing');
  const before = JSON.stringify(DB);
  const pv = await cutover.preview({ wallet: true });
  ok('preview does not change the database', JSON.stringify(DB) === before && upserts.length === 0);
  ok('orders: 1 new, 1 updated (paid on go), 1 same, 1 shop copy kept, no-ID row skipped, duplicate Sheet row counted', pv.orders.add === 1 && pv.orders.update === 1 && pv.orders.same === 1 && pv.orders.keptShopCount === 1 && pv.orders.keptShopRows[0] === 'FF2000002' && pv.orders.skippedNoId === 1 && pv.orders.sheetDuplicates === 1, pv.orders);
  ok('subscriptions: 1 new, 1 updated (renewed on go)', pv.subscriptions.add === 1 && pv.subscriptions.update === 1, pv.subscriptions);
  ok('customers matched by last 10 digits: "+91 98765 43210" is the existing Rahul (fill email), 2 new people, same person twice in the Sheet merged', pv.customers.add === 2 && pv.customers.fillBlanks === 1 && pv.customers.sheetSamePerson === 1, pv.customers);
  ok('wallet: shop coin user kept, 1 new, 1 updated', pv.wallet.keptShopBalances === 1 && pv.wallet.add === 1 && pv.wallet.update === 1, pv.wallet);
  ok('clash found: NF-01#P2 held by go SUB-2 and shop test SUB-9', pv.clashes.length === 1 && pv.clashes[0].inventoryRef === 'NF-01#P2' && pv.clashes[0].goSub === 'SUB-2' && pv.clashes[0].shopSub === 'SUB-9', pv.clashes);
  ok('warnings explain kept shop IDs, Sheet duplicates and the clash', pv.warnings.some((w) => /FF2000002/.test(w)) && pv.warnings.some((w) => /same ID twice/.test(w)) && pv.warnings.some((w) => /NF-01#P2/.test(w)), pv.warnings);
  ok('says what is never touched', pv.untouched.includes('plans') && pv.untouched.includes('coupons') && pv.untouched.some((x) => /inventory/.test(x)));
  ok('without the wallet option coins are not looked at', (await cutover.preview({})).wallet === null);

  section('import');
  const r = await cutover.run({ wallet: true });
  const o = (id) => DB.orders.filter((x) => x.order_id === id);
  ok('go order paid on go is now PAID in MySQL', o('FF1000001')[0].status === 'PAID' && o('FF1000001')[0].txn_ref === 'R1');
  ok('shop order with the same ID untouched', o('FF2000002')[0].final_amount === '5.00' && o('FF2000002')[0].source === 'node');
  ok('new go order added once, using the later Sheet row', o('FF3000003').length === 1 && o('FF3000003')[0].final_amount === 169 && o('FF3000003')[0].status === 'PAID');
  const sub = (id) => DB.subscriptions.filter((x) => x.sub_id === id);
  ok('renewal on go moves the expiry; new go subscription added', sub('SUB-1')[0].expiry_date === '2030-02-01 00:00:00' && sub('SUB-2').length === 1 && sub('SUB-2')[0].status === 'ACTIVE');
  const rahul = DB.customers.filter((c) => c.phone_norm === '9876543210');
  ok('existing customer: still one row, name NOT overwritten, empty email filled', rahul.length === 1 && rahul[0].name === 'Rahul' && rahul[0].email === 'rahul@example.com', rahul);
  ok('new customers added once each (merged duplicate keeps both name and email)', DB.customers.filter((c) => c.phone_norm === '9000000001').length === 1 && DB.customers.filter((c) => c.phone_norm === '9111111111').length === 1 && DB.customers.find((c) => c.phone_norm === '9111111111').name === 'Dev' && DB.customers.find((c) => c.phone_norm === '9111111111').email === 'dev@example.com');
  ok('coins: go balance copied; shop coin user keeps 75', DB.wallet.find((w) => w.phone_norm === '9876543210').coins_balance === 50 && DB.wallet.find((w) => w.phone_norm === '9000000001').coins_balance === 8 && DB.wallet.find((w) => w.phone_norm === '9222222222').coins_balance === '75.00');
  ok('coupon usage: old imported rows replaced by go rows, shop redemption kept', DB.coupon_usage.some((u) => u.order_id === 'FF2000002') && DB.coupon_usage.some((u) => u.order_id === 'FF3000003') && !DB.coupon_usage.some((u) => u.order_id === 'OLD-IMPORTED'));
  ok('result has done counts + sync_log rows', r.done.orders.added === 1 && r.done.customers.added === 2 && r.done.customers.filled === 1 && DB.sync_log.length >= 4, r.done);

  section('running it again creates no duplicates');
  const counts = () => ({ o: DB.orders.length, s: DB.subscriptions.length, c: DB.customers.length, w: DB.wallet.length });
  const c1 = counts();
  const pv2 = await cutover.preview({ wallet: true });
  ok('second preview: nothing new', pv2.orders.add === 0 && pv2.subscriptions.add === 0 && pv2.customers.add === 0 && pv2.wallet.add === 0, { o: pv2.orders.add, s: pv2.subscriptions.add, c: pv2.customers.add });
  await cutover.run({ wallet: true });
  ok('second import: same row counts', JSON.stringify(counts()) === JSON.stringify(c1), [c1, counts()]);

  section('background job + admin API');
  const job = cutover.start('preview', {});
  ok('job starts', job.ok && cutover.status().state === 'running');
  ok('a second job is refused while one runs', cutover.start('run', {}).ok === false);
  await new Promise((res) => setTimeout(res, 50));
  ok('job finishes with a result', cutover.status().state === 'done' && cutover.status().result.preview === true);

  const routes = {}; const audits = []; let paused = false; let authed = true;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  require('../admincutover').mount(app, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (q, a) => audits.push(a) }, cutover, store: { getSettings: async () => ({ paused }) } });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; routes[m + ' ' + p]({ body }, res); });
  let x = await call('POST', '/admin/api/cutover/run', { wallet: false });
  ok('import needs the word IMPORT', x.code === 400 && /IMPORT/.test(x.body.message));
  x = await call('POST', '/admin/api/cutover/run', { confirm: 'IMPORT' });
  ok('import refused until new orders are paused', x.code === 409 && x.body.needPause === true);
  paused = true;
  x = await call('POST', '/admin/api/cutover/run', { confirm: 'IMPORT' });
  ok('paused + IMPORT → import starts, change log written', x.body.ok && audits.some((a) => a.action === 'cutover.run'));
  await new Promise((res) => setTimeout(res, 50));
  x = await call('GET', '/admin/api/cutover/status');
  ok('status reports the finished import once in the change log', x.body.state === 'done' && x.body.kind === 'run' && audits.filter((a) => a.action === 'cutover.done').length === 1);
  await call('GET', '/admin/api/cutover/status');
  ok('  ...not logged twice', audits.filter((a) => a.action === 'cutover.done').length === 1);
  authed = false;
  x = await call('POST', '/admin/api/cutover/preview', {});
  ok('admin sign-in required', x.code === 403);

  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin menu + view: preview, pause warning, type IMPORT, confirm', /\['golive', '🚚', 'Go-live import'\]/.test(admin) && /golive: goliveView/.test(admin) && /Pause new orders first/.test(admin) && /placeholder="Type IMPORT"/.test(admin) && /confirm\('Import go\\'s data into shop now\?/.test(admin));
  const src = fs.readFileSync(path.join(__dirname, '..', 'cutover.js'), 'utf8');
  ok('real SQL only fills EMPTY customer fields (never overwrites a name/email/photo)', /name = IF\(COALESCE\(name, ''\) = '', \?, name\), email = IF\(COALESCE\(email, ''\) = '', \?, email\)/.test(src) && /profile_pic_url = IF\(COALESCE\(profile_pic_url, ''\) = '', \?, profile_pic_url\), member_since = COALESCE\(member_since, \?\) WHERE phone_norm = \?/.test(src) && /INSERT IGNORE INTO customers/.test(src));
  ok('orders/subscriptions go through the protectNode upsert; plans, coupons and inventory are never written', /for \(const t of \['orders', 'subscriptions'\]\)/.test(src) && sync.TABLES.orders.protectNode === true && sync.TABLES.subscriptions.protectNode === true && !/upsert\('(plans|coupons|inventory_\w+)'/.test(src) && !/INTO (plans|coupons|inventory_)/.test(src));
  ok('admin.js mounts the routes', /require\('\.\/admincutover'\)\.mount/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
