/* One-time ID / data cleanup after the go-live import (cleanup.js). Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const sub = (o) => Object.assign({ phone: o.phone_norm, email: '', plan: '1 Month', duration_days: 30, start_date: '2026-08-01 10:00:00', expiry_date: '2026-12-01 10:00:00', release_eligible_at: null, status: 'ACTIVE', renew_sub_id: null, raw_json: JSON.stringify({ SubID: o.sub_id }) }, o);
function freshDb() {
  return {
    subscriptions: [
      sub({ sub_id: 'SUB-123456789', order_id: 'FF1000001', phone_norm: '9876543210', service: 'Netflix' }),
      sub({ sub_id: 'SUB-LG704247527', order_id: 'FF1000002', phone_norm: '7569704247', service: 'JioHotstar', renew_sub_id: 'SUB-YT-000018' }),
      sub({ sub_id: 'SUB-YT-000018', order_id: 'FF1000003', phone_norm: '8238322923', service: 'YouTube Premium' }),
      sub({ sub_id: 'SUB-PR-000007', order_id: 'MIG-PR-000007', phone_norm: '9808038167', service: 'Prime Video' }),
      sub({ sub_id: 'SUB-PR-000098', order_id: 'MIG-PR-000007', phone_norm: '9808038167', service: 'Prime Video' }),
      sub({ sub_id: 'SUB-LG159708123', order_id: 'MIG159708123', phone_norm: '9717720693', service: 'Prime Video', email: 'x@y.z' }),
      sub({ sub_id: 'SUB-848946979', order_id: 'FF5723167', phone_norm: '7899861348', service: 'Prime Video', email: 'satish@example.com' }),
      sub({ sub_id: 'SUB-178938896779561', order_id: 'FF9556534', phone_norm: '9818196079', service: 'Netflix (Group Offer)' }),
      sub({ sub_id: 'SUB-LG', order_id: 'MIG', phone_norm: null, phone: null, service: 'Netflix (Group Offer)', status: 'EXPIRED', expiry_date: '2026-02-25 00:00:00' }),
      ...[1, 2, 3, 4, 5].map((i) => sub({ sub_id: 'SUB-17842495203251' + i, order_id: 'FF0215802', phone_norm: '9818196079', service: 'Prime Video', expiry_date: '2026-08-16 10:00:00', release_eligible_at: '2026-08-26 10:00:00' })),
      sub({ sub_id: 'SUB-999999999', order_id: 'FF1000009', phone_norm: '9738463524', service: 'Zee5', status: 'ACTIVE', expiry_date: '2026-01-01 00:00:00', release_eligible_at: '2026-01-10 00:00:00' }),
    ],
    orders: [
      { order_id: 'FF1000001', phone: '9876543210', phone_norm: '9876543210', name: 'Rahul', status: 'PAID', service: 'Netflix', created_at_sheet: '2026-08-01', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF1000002', phone: '7569704247', phone_norm: '7569704247', name: 'Anu', status: 'PAID', service: 'JioHotstar', created_at_sheet: '2026-08-01', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF1000003', phone: '8238322923', phone_norm: '8238322923', name: 'Yash', status: 'PAID', service: 'YouTube Premium', created_at_sheet: '2026-08-01', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF2000001', phone: '7569704247', phone_norm: '7569704247', name: 'Anu', status: 'CREATED', service: 'JioHotstar', created_at_sheet: '2026-09-10', renew_sub_id: 'SUB-LG704247527', raw_json: JSON.stringify({ RenewSubID: 'SUB-LG704247527' }) },
      { order_id: 'FF9556534', phone: '9818196079', phone_norm: '9818196079', name: 'Harsh', status: 'PAID', service: 'Netflix (Group Offer)', created_at_sheet: '2026-09-14', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF0215802', phone: '9818196079', phone_norm: '9818196079', name: 'Harsh', status: 'PAID', service: 'Prime Video', created_at_sheet: '2026-07-16', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF1000009', phone: '973846524', phone_norm: '973846524', name: 'Typo', status: 'PAID', service: 'Zee5', created_at_sheet: '2026-01-01', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF3000001', phone: '7899861348', phone_norm: '7899861348', name: 'Satish', status: 'CREATED', service: 'Prime Video', created_at_sheet: '2026-09-01', renew_sub_id: null, raw_json: '{}' },
      { order_id: 'FF4642239', phone: '6281151936', phone_norm: '6281151936', name: 'Failed', status: 'PAID', service: 'Zee5 Premium', created_at_sheet: '2026-08-08', renew_sub_id: null, raw_json: '{}' },
    ],
    customers: ['9876543210', '7569704247', '8238322923', '9808038167', '9818196079', '9738463524'].map((p) => ({ phone_norm: p })),
    inventory_profiles: [{ current_sub_id: 'SUB-LG704247527', raw_json: JSON.stringify({ CurrentSubID: 'SUB-LG704247527' }) }],
    reminder_log: [{ sub_id: 'SUB-YT-000018' }],
    app_settings: {}, sync_log: [{ note: 'go-live import {"added":13}' }],
  };
}
const SYNC_LOG_COLS = ['id', 'direction', 'table_name', 'rows_count', 'note', 'ran_at']; // db/schema.sql (sync_log) — there is no 'ts'
let DB = freshDb(); let failAt = null; let txLog = [];
const jsonSet = (raw, pairs) => { const o = raw ? JSON.parse(raw) : {}; for (let i = 0; i < pairs.length; i += 2) o[pairs[i]] = pairs[i + 1]; return JSON.stringify(o); };
function run(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim();
  if (failAt && failAt.test(sql)) throw new Error('boom');
  if (/^SELECT sub_id, order_id, phone, phone_norm, email, service, plan/.test(sql)) return DB.subscriptions.map((x) => Object.assign({}, x));
  if (/^SELECT order_id, phone, phone_norm, name, status, service, created_at_sheet FROM orders/.test(sql)) return DB.orders.map((x) => { const o = {}; for (const c of ['order_id', 'phone', 'phone_norm', 'name', 'status', 'service', 'created_at_sheet']) o[c] = x[c]; return o; }); // only the selected columns, like MySQL
  if (/^SELECT phone_norm FROM customers/.test(sql)) return DB.customers.map((x) => Object.assign({}, x));
  if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return DB.app_settings[p[0]] ? [{ value: DB.app_settings[p[0]] }] : [];
  if (/FROM sync_log/.test(sql)) {
    // Only real sync_log columns (db/schema.sql) — a wrong column name failed on live.
    const cols = (sql.match(/^SELECT (.*?) FROM sync_log/) || [])[1].split(',').map((c) => c.trim());
    const bad = cols.filter((c) => !SYNC_LOG_COLS.includes(c)); if (bad.length) throw new Error("Unknown column '" + bad[0] + "' in 'field list'");
    return DB.sync_log.filter((x) => /^go-live import/.test(x.note)).map((x, i) => ({ id: i + 1, ran_at: '2026-09-14' }));
  }
  if (/^INSERT INTO orders/.test(sql)) { if (DB.orders.some((o) => o.order_id === p[0])) throw new Error('Duplicate entry'); DB.orders.push({ order_id: p[0], created_at_sheet: p[1], service: p[2], plan: p[3], name: p[5], email: p[6], phone: p[7], phone_norm: p[8], notes: p[9], raw_json: p[10], status: 'PAID', source: 'migrated', final_amount: 0 }); return { affectedRows: 1 }; }
  if (/^UPDATE subscriptions SET order_id = \?/.test(sql)) { const r = DB.subscriptions.filter((x) => x.sub_id === p[3]); r.forEach((x) => { x.order_id = p[0]; x.raw_json = jsonSet(x.raw_json, ['OrderID', p[1], 'LegacyOrderID', p[2]]); }); return { affectedRows: r.length }; }
  if (/^UPDATE subscriptions SET sub_id = \?/.test(sql)) { const r = DB.subscriptions.filter((x) => x.sub_id === p[5]); if (DB.subscriptions.some((x) => x.sub_id === p[0])) throw new Error('Duplicate entry'); r.forEach((x) => { x.sub_id = p[0]; x.raw_json = jsonSet(x.raw_json, ['SubID', p[3], 'LegacySubID', p[4]]); }); return { affectedRows: r.length }; }
  if (/^UPDATE subscriptions SET renew_sub_id = \?/.test(sql)) { const r = DB.subscriptions.filter((x) => x.renew_sub_id === p[1]); r.forEach((x) => { x.renew_sub_id = p[0]; }); return { affectedRows: r.length }; }
  if (/^UPDATE orders SET renew_sub_id = \?/.test(sql)) { const r = DB.orders.filter((x) => x.renew_sub_id === p[2]); r.forEach((x) => { x.renew_sub_id = p[0]; x.raw_json = jsonSet(x.raw_json, ['RenewSubID', p[1]]); }); return { affectedRows: r.length }; }
  if (/^UPDATE inventory_profiles SET current_sub_id = \?/.test(sql)) { const r = DB.inventory_profiles.filter((x) => x.current_sub_id === p[2]); r.forEach((x) => { x.current_sub_id = p[0]; x.raw_json = jsonSet(x.raw_json, ['CurrentSubID', p[1]]); }); return { affectedRows: r.length }; }
  if (/^UPDATE reminder_log SET sub_id = \?/.test(sql)) { const r = DB.reminder_log.filter((x) => x.sub_id === p[1]); r.forEach((x) => { x.sub_id = p[0]; }); return { affectedRows: r.length }; }
  if (/^INSERT IGNORE INTO customers/.test(sql)) { if (DB.customers.some((c) => c.phone_norm === p[1])) return { affectedRows: 0 }; DB.customers.push({ phone: p[0], phone_norm: p[1], name: p[2], email: p[3], member_since: p[4], customer_id: p[5] }); return { affectedRows: 1 }; }
  if (/^UPDATE subscriptions SET status = 'EXPIRED' WHERE order_id = \?/.test(sql)) { const r = DB.subscriptions.filter((x) => x.order_id === p[0] && x.status !== 'EXPIRED'); r.forEach((x) => { x.status = 'EXPIRED'; }); return { affectedRows: r.length }; }
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) { if (DB.app_settings[p[0]]) throw new Error('Duplicate entry'); DB.app_settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  throw new Error('unexpected SQL in test: ' + sql.slice(0, 100));
}
let snapshot = null;
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => run(sql, p),
  getPool: () => ({ getConnection: async () => ({
    query: async (sql, p) => { txLog.push(sql); return [run(sql, p)]; },
    beginTransaction: async () => { snapshot = JSON.stringify(DB); },
    commit: async () => { snapshot = null; },
    rollback: async () => { if (snapshot) DB = JSON.parse(snapshot); snapshot = null; },
    release() {},
  }) }),
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const cleanup = require('../cleanup');
cleanup._internal.deps.now = () => new Date('2026-09-14T19:00:00+05:30');

(async () => {
  const before = JSON.stringify(DB);
  const pv = await cleanup.preview();
  ok('preview writes nothing', JSON.stringify(DB) === before);
  ok('renames only non-regular IDs (LG, YT, PR, 15-digit, broken SUB-LG); SUB-######### untouched', pv.renames.count === 12 && !pv.renames.sample.some((r) => r.from === 'SUB-123456789' || r.from === 'SUB-848946979' || r.from === 'SUB-999999999') && pv.renames.sample.every((r) => /^SUB-\d{9}$/.test(r.to)), pv.renames);
  ok('missing orders: MIG-PR-000007 (2 plans) + MIG159708123 + MIG → new FF IDs; FF5723167 keeps its ID', pv.orders.count === 4 && pv.orders.newIds === 3 && pv.orders.subs === 5 && pv.orders.sample.some((o) => o.from === 'FF5723167' && o.to === 'FF5723167') && pv.orders.sample.filter((o) => /^MIG/.test(o.from)).every((o) => /^FF\d{7}$/.test(o.to)), pv.orders);
  ok('missing customers: Satish (name from his order, email from plan) + MIG customer; no phone → skipped', pv.customers.count === 2 && pv.customers.list.some((c) => c.phone === '7899861348' && c.name === 'Satish' && c.email === 'satish@example.com'), pv.customers);
  ok('clutter: FF0215802 (5 ended plans) only', pv.clutter.length === 1 && pv.clutter[0].orderId === 'FF0215802' && pv.clutter[0].subs === 5, pv.clutter);
  ok('report: phone typo, failed paid order, stale ACTIVE — not changed', pv.report.phoneMismatch.some((m) => m.orderId === 'FF1000009') && pv.report.paidNoPlan.includes('FF4642239') && pv.report.staleActive >= 1);
    ok('report counts renewals as having a plan (order service is selected)', !pv.report.paidNoPlan.includes('FF1000001') && pv.report.paidNoPlanCount === 1, pv.report);
  ok('preview knows the import ran and cleanup is not done', pv.importDone === true && !pv.done);

  // Refuses before the import.
  const sl = DB.sync_log; DB.sync_log = [];
  let r = await cleanup.apply();
  ok('refuses to run before the go-live import', !r.ok && r.needImport === true && JSON.stringify(DB.subscriptions) === JSON.stringify(freshDb().subscriptions));
  DB.sync_log = sl;

  // Failure midway → nothing half-done.
  failAt = /^UPDATE reminder_log/; const pre = JSON.stringify(DB);
  let threw = false; try { await cleanup.apply(); } catch (e) { threw = true; }
  ok('an error midway rolls everything back', threw && JSON.stringify(DB) === pre);
  failAt = null;

  r = await cleanup.apply();
  const ids = DB.subscriptions.map((x) => x.sub_id);
  ok('every subscription now has a regular SUB-######### ID, all unique', ids.every((i) => /^SUB-\d{9}$/.test(i)) && new Set(ids).size === ids.length, ids);
  const anu = DB.subscriptions.find((x) => JSON.parse(x.raw_json).LegacySubID === 'SUB-LG704247527');
  const yt = DB.subscriptions.find((x) => JSON.parse(x.raw_json).LegacySubID === 'SUB-YT-000018');
  ok('old ID kept in raw_json + SubID updated', anu && JSON.parse(anu.raw_json).SubID === anu.sub_id);
  ok('renew link inside subscriptions follows the rename', anu.renew_sub_id === yt.sub_id);
  const openRenew = DB.orders.find((o) => o.order_id === 'FF2000001');
  ok('open renewal order + its raw_json follow the rename', openRenew.renew_sub_id === anu.sub_id && JSON.parse(openRenew.raw_json).RenewSubID === anu.sub_id);
  ok('Netflix profile slot + reminder log follow the rename', DB.inventory_profiles[0].current_sub_id === anu.sub_id && JSON.parse(DB.inventory_profiles[0].raw_json).CurrentSubID === anu.sub_id && DB.reminder_log[0].sub_id === yt.sub_id);
  const orderIds = new Set(DB.orders.map((o) => o.order_id));
  ok('every subscription now points to an existing order', DB.subscriptions.every((x) => orderIds.has(x.order_id)));
  const pr = DB.subscriptions.filter((x) => JSON.parse(x.raw_json).LegacyOrderID === 'MIG-PR-000007');
  ok('both plans of MIG-PR-000007 share one new FF order (₹0, migrated, old ID kept)', pr.length === 2 && pr[0].order_id === pr[1].order_id && /^FF\d{7}$/.test(pr[0].order_id) && DB.orders.find((o) => o.order_id === pr[0].order_id).final_amount === 0 && JSON.parse(DB.orders.find((o) => o.order_id === pr[0].order_id).raw_json).MigratedFrom === 'MIG-PR-000007');
  ok('FF5723167 order record added with the same ID', DB.orders.filter((o) => o.order_id === 'FF5723167').length === 1);
  ok('Satish is now a customer', DB.customers.some((c) => c.phone_norm === '7899861348' && c.name === 'Satish'));
  ok('test clutter expired; real ACTIVE plans untouched', DB.subscriptions.filter((x) => x.order_id === 'FF0215802').every((x) => x.status === 'EXPIRED') && DB.subscriptions.find((x) => x.phone_norm === '9876543210').status === 'ACTIVE' && DB.subscriptions.find((x) => x.phone_norm === '9738463524').status === 'ACTIVE');
  ok('counts returned + done flag saved', r.ok && r.counts.subsRenamed === 12 && r.counts.ordersCreated === 4 && r.counts.customersCreated === 2 && r.counts.clutterExpired === 5 && r.counts.references >= 4 && !!DB.app_settings.id_cleanup, r.counts);
  r = await cleanup.apply();
  ok('runs only once', !r.ok && r.alreadyDone === true);

  // New subscriptions get the same ID style.
  const fsrc = fs.readFileSync(path.join(__dirname, '..', 'fulfill.js'), 'utf8');
  ok('shop now creates SUB-######### IDs and checks they are free', /function genSubId\(\) \{ return 'SUB-' \+ String\(require\('crypto'\)\.randomInt\(0, 1e9\)\)\.padStart\(9, '0'\); \}/.test(fsrc) && (fsrc.match(/const subId = await freeSubId\(\);/g) || []).length === 2);

  // Admin API.
  const routes = {}; const audits = []; let paused = true; let cleanDone = false;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  const fakeCleanup = { isDone: async () => cleanDone, preview: async () => ({ ok: true }), apply: async () => { cleanDone = true; return { ok: true, counts: { subsRenamed: 1, references: 2, ordersCreated: 3, customersCreated: 4, clutterExpired: 5 } }; } };
  const fakeCutover = { start: () => ({ ok: true }), status: () => ({ ok: true, state: 'idle' }) };
  require('../admincutover').mount(app, { auth: () => true, audit: { record: (q, a) => audits.push(a) }, cutover: fakeCutover, cleanup: fakeCleanup, store: { getSettings: async () => ({ paused }) } });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; routes[m + ' ' + p]({ body }, res); });
  let x = await call('POST', '/admin/api/cleanup/apply', {});
  ok('apply needs the word CLEANUP', x.code === 400);
  paused = false; x = await call('POST', '/admin/api/cleanup/apply', { confirm: 'CLEANUP' });
  ok('apply needs new orders paused', x.code === 409 && x.body.needPause);
  paused = true; x = await call('POST', '/admin/api/cleanup/apply', { confirm: 'CLEANUP' });
  ok('apply runs + change log', x.body.ok && audits.some((a) => a.action === 'cleanup.apply' && /1 subscription IDs renamed/.test(a.summary)));
  x = await call('POST', '/admin/api/cutover/run', { confirm: 'IMPORT' });
  ok('after the cleanup the import is locked (no duplicates from old IDs)', x.code === 409 && x.body.locked === true);

  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin step 3: preview, type CLEANUP, confirm', /3️⃣ Tidy up IDs/.test(admin) && /placeholder="Type CLEANUP"/.test(admin) && /confirm\('Tidy up IDs now\?/.test(admin) && /\/admin\/api\/cleanup\/preview/.test(admin));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
