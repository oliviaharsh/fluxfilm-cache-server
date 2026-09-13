/* F4 parts C + D: admin "removed from account" tick, customer 360, account page list,
 * Sheet import of the tick. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const net = require('net');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const calls = [];
let columnsPresent = 2;
let rowExists = true;
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });
    if (/COLUMN_NAME c FROM information_schema/.test(sql)) return [{ c: 'sub_id' }, { c: 'expiry_date' }, { c: 'removed' }];
    if (/information_schema\.columns/.test(sql)) return [{ n: columnsPresent }];
    if (/^UPDATE subscriptions SET removed/.test(sql)) return { affectedRows: rowExists ? 1 : 0 };
    if (/^SELECT sub_id, removed, removed_at FROM subscriptions/.test(sql)) return [{ sub_id: params[0], removed: /removed = 1/.test(calls[calls.length - 2].sql) ? 1 : 0, removed_at: /removed = 1/.test(calls[calls.length - 2].sql) ? (calls[calls.length - 2].params[0] || '2026-09-14 10:00:00') : null }];
    if (/FROM customers WHERE phone_norm/.test(sql)) return [{ phone: '9876543210', name: 'T', email: 't@x', member_since: '2026-01-01' }];
    if (/FROM orders WHERE phone_norm/.test(sql)) return [];
    if (/^SELECT \* FROM subscriptions WHERE phone_norm/.test(sql)) return [{ sub_id: 'SUB-1', service: 'Netflix', plan: 'Sharing 1M', expiry_date: '2026-09-10 10:00:00', status: 'ACTIVE', login_id: 'l', password: 'p', removed: 1, removed_at: '2026-09-12 09:30:00', raw_json: '{"big":"x"}' }];
    if (/FROM wallet/.test(sql)) return [];
    return [];
  },
  getPool: () => null,
  ping: async () => ({ ok: true }),
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  return origLoad.apply(this, arguments);
};

(async () => {
  const express = require('express');
  const admin = require('../admin');
  const sync = require('../sync');
  const app = express();
  app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (body, key = 'k') => {
    const res = await fetch(base + '/admin/api/sub-removed?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const lastUpdate = () => [...calls].reverse().find((c) => /^UPDATE subscriptions SET removed/.test(c.sql));

  section('admin "removed from account" tick');
  let r = await post({ sub_id: 'SUB-1', removed: true, removed_at: '2026-09-01T14:30' });
  let u = lastUpdate();
  ok('tick with a time stores removed = 1 at that India time', r.status === 200 && r.body.ok && /removed = 1/.test(u.sql) && u.params[0] === '2026-09-01 14:30:00' && u.params[2] === 'SUB-1', { r, u });
  ok('keeps raw_json RemovedFromDevice in step (editing the row elsewhere cannot undo it)', /JSON_SET\(raw_json, '\$\.RemovedFromDevice', \?\)/.test(u.sql) && u.params[1] === 'TRUE', u);
  r = await post({ sub_id: 'SUB-1', removed: true });
  u = lastUpdate();
  ok('tick without a time uses now', r.body.ok && /COALESCE\(\?, NOW\(\)\)/.test(u.sql) && u.params[0] === null, u);
  r = await post({ sub_id: 'SUB-1', removed: false, removed_at: '2026-09-01 14:30' });
  u = lastUpdate();
  ok('untick clears both fields and ignores any time', r.body.ok && /removed = 0, removed_at = NULL/.test(u.sql) && u.params[0] === 'FALSE', u);
  r = await post({ sub_id: 'SUB-1', removed: true, removed_at: 'yesterday' });
  ok('unreadable time -> 400 with a helpful message', r.status === 400 && /2026-09-01 14:30/.test(r.body.message), r);
  r = await post({ removed: true });
  ok('missing sub_id -> 400', r.status === 400, r);
  r = await post({ sub_id: 'SUB-1', removed: true }, 'wrong');
  ok('wrong admin key -> 403', r.status === 403, r);
  rowExists = false;
  r = await post({ sub_id: 'SUB-NOPE', removed: true });
  ok('unknown subscription -> 404', r.status === 404, r);
  rowExists = true;
  columnsPresent = 0;
  r = await post({ sub_id: 'SUB-1', removed: true });
  ok('before schema-v13 -> 409 telling the admin to run it', r.status === 409 && /schema-v13/.test(r.body.message), r);
  columnsPresent = 2;

  section('customer 360');
  const c = await (await fetch(base + '/admin/api/customer?key=k&phone=9876543210')).json();
  ok('subscriptions include removed + removed_at, raw_json stripped', c.ok && c.subs[0].removed === 1 && c.subs[0].removed_at === '2026-09-12 09:30:00' && !('raw_json' in c.subs[0]), c.subs);

  section('admin panel page still parses');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true;
  for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline script parses', scripts.length > 0 && parsed);
  ok('panel has the Customer 360 tick box and save handler', /function subCard\(/.test(html) && /function saveRemoved\(/.test(html) && /id="rm_' \+ id/.test(html));
  ok('Sheets grid renders removed as a tick box with an editable time', /data-act="rm"/.test(html) && /function gridRemoved\(/.test(html) && /function removedDialog\(/.test(html));
  ok('grid has resizable columns and a column picker', /class="rz"/.test(html) && /function autofit\(/.test(html) && /function toggleCols\(/.test(html));

  section('Sheets grid: sorting + page size');
  const tableCall = async (qs) => { calls.length = 0; await fetch(base + '/admin/api/table?key=k&name=subscriptions' + qs); return calls.find((x) => /^SELECT \* FROM `subscriptions`/.test(x.sql)); };
  let tc = await tableCall('&sort=expiry_date&dir=asc');
  ok('sort by a real column', tc && /ORDER BY `expiry_date` ASC/.test(tc.sql), tc);
  tc = await tableCall('&sort=removed');
  ok('sort defaults to descending', tc && /ORDER BY `removed` DESC/.test(tc.sql), tc);
  tc = await tableCall('&sort=' + encodeURIComponent('expiry_date; DROP TABLE x') + '&dir=asc');
  ok('unknown / injected sort column falls back to the default order', tc && /ORDER BY expiry_date DESC/.test(tc.sql) && !/DROP/.test(tc.sql), tc);
  tc = await tableCall('&limit=9999');
  ok('page size is capped at 500', tc && tc.params[tc.params.length - 2] === 500, tc);
  server.close();

  section('Sheet import maps RemovedFromDevice');
  const cast = sync.TABLES.subscriptions.cols.removed;
  ok('mapped from the RemovedFromDevice header', cast && cast[0] === 'RemovedFromDevice');
  ok('True/TRUE/1/yes -> 1; False/blank/null -> 0', [cast[1]('True'), cast[1]('TRUE'), cast[1](1), cast[1]('yes'), cast[1]('False'), cast[1](''), cast[1](null)].join() === '1,1,1,1,0,0,0');

  section('account page lists plans that ended a while ago');
  Module._load = function (req) {
    if (req === './db') return {
      query: async (sql) => {
        if (/FROM subscriptions WHERE phone_norm/.test(sql)) {
          const d = (n) => { const x = new Date(Date.now() + n * 86400000); const p = (v) => String(v).padStart(2, '0'); return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' 10:00:00'; };
          return [-7, -12, -20, -35, -50, -59, -90, -200].map((n, i) => ({ sub_id: 'S' + i, order_id: '', service: 'Prime Video', plan: '1 Month', email: '', start_date: d(n - 30), expiry_date: d(n), profile_number: '', profile_name: '', profile_pin: '', inventory_ref: 'PRI-1' }));
        }
        return [];
      },
    };
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../reads')];
  const reads = require('../reads');
  const res = await reads.getMySubscriptions('9876543210');
  ok('every plan that ended in the last 60 days is shown (was: only 3)', res.history.length === 6, res.history.map((h) => h.daysLeft));
  ok('plans that ended over 60 days ago are not listed', !res.history.some((h) => h.daysLeft < -60), res.history.map((h) => h.daysLeft));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
