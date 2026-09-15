/* Today screen, to-dos, global search, change log (audit). Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let schema = true;
const calls = [];
const todos = [];
const noTable = () => { const e = new Error("Table 'u.admin_todos' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params });
    // MariaDB live: a parameter compared with a text literal fails on collation.
    if (/\? <> '/.test(sql)) throw new Error("Illegal mix of collations (utf8mb4_general_ci,COERCIBLE) and (utf8mb4_unicode_ci,COERCIBLE) for operation '<>'");
    if ((sql.match(/\?/g) || []).length !== (params || []).length) throw new Error('placeholder count mismatch: ' + sql);
    if (/admin_todos|audit_log/.test(sql) && !schema) noTable();
    if (/FROM orders WHERE UPPER\(status\) = 'CREATED' AND source = 'node'/.test(sql)) return [{ n: 5 }];
    if (/FROM orders o WHERE UPPER\(o.status\) = 'PAID'/.test(sql)) return [{ n: 1 }];
    if (/MANUAL_PENDING' AND UPPER\(status\) = 'ACTIVE'/.test(sql)) return [{ n: 2 }];
    if (/^SELECT COUNT\(\*\) n FROM subscriptions WHERE UPPER\(status\) = 'ACTIVE' AND expiry_date BETWEEN/.test(sql)) return [{ n: 3 }];
    if (/^SELECT sub_id, phone_norm, service, plan, expiry_date FROM subscriptions WHERE UPPER\(status\) = 'ACTIVE' AND expiry_date BETWEEN/.test(sql)) return [{ sub_id: 'S1', phone_norm: '9876543210', service: 'Netflix', plan: 'Private 1M', expiry_date: '2026-09-16 10:00:00' }];
    // expiredusers.js: NF-A has an active customer (2 expired to remove); NF-B has nobody active (safe, not counted).
    if (/FROM subscriptions s WHERE/.test(sql)) return [
      { sub_id: 'A1', phone_norm: '9000000001', name: 'Active One', service: 'Netflix', status: 'ACTIVE', expiry_date: '2099-01-01 00:00:00', inventory_ref: 'NF-A#P1', login_id: 'a@x', removed: 0 },
      { sub_id: 'E1', phone_norm: '9000000002', name: 'Old Two', service: 'Netflix', status: 'EXPIRED', expiry_date: '2020-01-01 00:00:00', inventory_ref: 'NF-A#P1', login_id: 'a@x', removed: 0 },
      { sub_id: 'E2', phone_norm: '9000000003', name: 'Old Three', service: 'Netflix', status: 'EXPIRED', expiry_date: '2020-02-01 00:00:00', inventory_ref: 'NF-A#P2', login_id: 'a@x', removed: 0 },
      { sub_id: 'E3', phone_norm: '9000000004', name: 'Idle Four', service: 'Netflix', status: 'EXPIRED', expiry_date: '2020-02-01 00:00:00', inventory_ref: 'NF-B#P1', login_id: 'b@x', removed: 0 },
    ];
    if (/FROM restock_requests/.test(sql)) return [{ n: 4 }];
    if (/FROM bank_credits WHERE consumed_order_id IS NULL/.test(sql)) return [{ n: params[0] === '2026-09-14 21:00:00' && /received_at >= \?/.test(sql) ? 2 : 99 }];
    if (/^SELECT 1 FROM admin_todos/.test(sql)) return [];
    if (/^SELECT id, title, note, due_date, done/.test(sql)) return todos.filter((t) => !/done = 0/.test(sql) || !t.done);
    if (/^INSERT INTO admin_todos/.test(sql)) { todos.push({ id: todos.length + 1, title: params[0], note: params[1], due_date: params[2], done: 0 }); return { insertId: todos.length }; }
    if (/^UPDATE admin_todos/.test(sql)) { const t = todos.find((x) => x.id === params[params.length - 1]); if (!t) return { affectedRows: 0 }; if (/done = \?/.test(sql)) t.done = params[0]; return { affectedRows: 1 }; }
    if (/^DELETE FROM admin_todos/.test(sql)) return { affectedRows: 1 };
    if (/FROM customers WHERE name LIKE/.test(sql)) return [{ customer_id: 'CUS-1', name: 'Rahul', email: 'r@x', phone_norm: '9876543210' }];
    if (/FROM orders WHERE order_id LIKE/.test(sql)) return [];
    if (/FROM subscriptions WHERE sub_id LIKE/.test(sql)) return [];
    if (/^SELECT id, ts, action/.test(sql)) return [{ id: 1, ts: '2026-09-14 10:00:00', action: 'row.delete', entity: 'orders', entity_id: 'FF1', summary: 'Deleted in Sheets', details: '{}' }];
    if (/^SELECT \* FROM `subscriptions` WHERE `sub_id`=\?/.test(sql)) return [{ sub_id: 'SUB-1', login_id: 'acc@x', password: 'Secret#1', profile_pin: '1234', raw_json: '{"Password":"Secret#1"}' }];
    if (/^DELETE FROM `subscriptions`/.test(sql)) return { affectedRows: 1 };
    return { affectedRows: 1 };
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};
const catalog = { getStockLevels: async () => ({ ok: true, levels: { 'SonyLiv Premium|||1 Month': { stock: 0, stockLevel: 'OUT' }, 'JioHotstar|||1 Month': { stock: 2, stockLevel: 'LOW' }, 'Netflix|||Private 1M': { stock: 6, stockLevel: 'OK' } } }) };

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), home: { catalog } });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b, h) => { const r = await fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const audits = () => calls.filter((c) => /^INSERT INTO audit_log/.test(c.sql));
  const tick = () => new Promise((r) => setTimeout(r, 20));

  section('Today');
  let r = await get('/admin/api/today');
  const item = (k) => r.body.items.find((i) => i.key === k);
  ok('lists what needs doing with counts', r.body.ok && item('undelivered').count === 1 && item('manual').count === 2 && item('ending').count === 3 && item('expired').count === 2 && item('restock').count === 4 && item('unpaid').count === 5, r.body.items);
  ok('expired: only the account still in use counts, named with who to remove', item('expired').names.length === 1 && /^NF-A · remove 2: Old Three, Old Two$/.test(item('expired').names[0]), item('expired'));
  ok('🚪 card: title "Customers to log out", count = customers (2), subtitle = accounts ("on 1 account")', item('expired').title === 'Customers to log out' && item('expired').count === 2 && item('expired').sub === 'on 1 account' && item('expired').accounts === 1, item('expired'));
  ok('🚪 card opens the 🚪 Remove users screen, not Stock', item('expired').go.view === 'removeusers' && !item('expired').go.stock, item('expired').go);
  const ru = await get('/admin/api/remove-users');
  ok('Today count and subtitle = GET /admin/api/remove-users counts (one source)', ru.body.ok && ru.body.counts.customers === item('expired').count && ru.body.counts.accounts === item('expired').accounts && ru.body.counts.safeAccounts === 1 && ru.body.counts.safeUsers === 1, ru.body.counts);
  ok('unmatched payments: since go-live (2026-09-14 21:00) only, opens 🏦 Bank payments', item('unmatched').count === 2 && item('unmatched').go.view === 'bank', item('unmatched'));
  ok('out of stock / low plans named', item('out').names[0] === 'SonyLiv Premium · 1 Month' && item('low').names[0] === 'JioHotstar · 1 Month (2)');
  ok('each item says where to go', item('undelivered').go.orders === 'undelivered' && item('restock').go.table === 'restock_requests');
  ok('to-dos included', Array.isArray(r.body.todos) && r.body.needsSchema === false);
  schema = false;
  r = await get('/admin/api/today');
  ok('before schema-v14: Today still works, to-dos say to run the SQL', r.body.ok && r.body.todos === null && r.body.needsSchema === true && r.body.items.length === 11, r.body); // +2: UPI refunds to send, customer still choosing (refunds.js)
  r = await post('/admin/api/todos', { title: 'x' });
  ok('adding a to-do before schema-v14 -> 409 with the fix', r.status === 409 && /schema-v14/.test(r.body.message), r.body);
  schema = true;

  section('to-dos');
  r = await post('/admin/api/todos', { title: '  ' });
  ok('empty title refused', r.status === 400);
  r = await post('/admin/api/todos', { title: 'Change NF-03 password', due_date: 'tomorrow' });
  ok('bad date refused', r.status === 400 && /2026-09-20/.test(r.body.message));
  r = await post('/admin/api/todos', { title: 'Change NF-03 password', due_date: '2026-09-20' });
  ok('added', r.body.ok && todos[0].title === 'Change NF-03 password' && todos[0].due_date === '2026-09-20');
  await tick();
  ok('  ...and logged in the change log', audits().some((a) => a.params[0] === 'todo.add' && a.params[3] === 'Change NF-03 password'));
  r = await post('/admin/api/todos/update', { id: 1, done: true });
  ok('ticked done', r.body.ok && todos[0].done === 1);
  r = await get('/admin/api/todos');
  ok('open list hides done items', r.body.ok && r.body.todos.length === 0);
  r = await get('/admin/api/todos?all=1');
  ok('"show done" includes them', r.body.todos.length === 1);
  r = await post('/admin/api/todos/update', { id: 99, done: true });
  ok('unknown to-do -> 404', r.status === 404);
  r = await post('/admin/api/todos/delete', { id: 1 });
  ok('deleted', r.body.ok);

  section('global search');
  r = await get('/admin/api/search?q=rah');
  const cs = calls.filter((c) => /FROM customers WHERE name LIKE/.test(c.sql)).pop();
  ok('finds customers, orders and subscriptions', r.body.ok && r.body.customers[0].customer_id === 'CUS-1' && Array.isArray(r.body.orders) && Array.isArray(r.body.subs) && cs.params[0] === '%rah%');
  r = await get('/admin/api/search?q=98765');
  const ph = calls.filter((c) => /FROM (customers|orders|subscriptions) WHERE/.test(c.sql)).slice(-3);
  ok('phone digits search customers, orders AND subscriptions by phone (no collation error)', r.body.ok && ph.length === 3 && ph.every((c) => /phone_norm LIKE \?/.test(c.sql) && c.params.includes('%98765%')), r.body);
  r = await get('/admin/api/search?q=harsh');
  const nm = calls.filter((c) => /FROM (customers|orders|subscriptions) WHERE/.test(c.sql)).slice(-3);
  ok('a name searches customers + order names, no phone clause when there are no digits', r.body.ok && nm.every((c) => !/phone_norm LIKE/.test(c.sql)) && /name LIKE \?/.test(nm[1].sql), nm.map((c) => c.sql));
  r = await get('/admin/api/search?q=r');
  ok('1 letter -> nothing (no full scans)', r.body.customers.length === 0);

  section('change log');
  calls.length = 0;
  r = await post('/admin/api/row-delete', { table: 'subscriptions', keyvals: { sub_id: 'SUB-1' } });
  await tick();
  const del = audits().find((a) => a.params[0] === 'row.delete');
  ok('deleting a row logs a copy of it', r.body.ok && del && del.params[1] === 'subscriptions' && del.params[2] === 'SUB-1' && /acc@x/.test(del.params[4]), del);
  ok('  ...with password and PIN hidden, raw_json dropped', del && !/Secret#1/.test(del.params[4]) && !/1234/.test(del.params[4]) && !/raw_json/.test(del.params[4]), del && del.params[4]);
  calls.length = 0;
  r = await post('/admin/api/login', { password: 'wrong' }, { 'Content-Type': 'application/json' });
  await tick();
  ok('wrong admin password logged', r.status === 401 && audits().some((a) => a.params[0] === 'login.failed'));
  calls.length = 0;
  await post('/admin/api/sub-removed', { sub_id: 'SUB-1', removed: true });
  await tick();
  r = await get('/admin/api/audit?action=row');
  const q = calls.find((c) => /FROM audit_log/.test(c.sql));
  ok('change log viewer filters by action', r.body.ok && r.body.rows[0].action === 'row.delete' && /action LIKE \?/.test(q.sql) && q.params[0] === 'row%', q);
  schema = false;
  r = await post('/admin/api/todos/update', { id: 1, done: true });
  let crashed = false;
  try { await post('/admin/api/row-delete', { table: 'subscriptions', keyvals: { sub_id: 'SUB-1' } }); } catch (e) { crashed = true; }
  ok('missing audit table never blocks an admin action', !crashed);
  schema = true;

  section('panel');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel parses; Today is the home screen; search bar + bottom menu + change log', parsed && /view: store\('ff_view'\) \|\| 'today'/.test(html) && /id="gsearch"/.test(html) && /class="bnav"/.test(html) && /function auditView\(/.test(html));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  Module._load = origLoad;
  const { scrub } = require('../audit');
  const sc = scrub({ password: 'x', profile_pin: '9', nested: { apiKey: 'k', name: 'ok' }, long: 'a'.repeat(400) }, 0);
  ok('scrub hides secrets at any depth and trims long text', sc.password === '•••' && sc.profile_pin === '•••' && sc.nested.apiKey === '•••' && sc.nested.name === 'ok' && sc.long.length < 310);

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
