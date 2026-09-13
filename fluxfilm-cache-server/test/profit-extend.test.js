/* Profit view + extend subscription days. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let costsTable = true;
const calls = [];
const COSTS = [{ service: 'Netflix', account_id: 'NF-01', monthly_cost: '300.00', note: '' }, { service: 'Prime Video', account_id: 'PRI-01', monthly_cost: '100', note: 'annual / 12' }];
let SUB = { sub_id: 'SUB-1', phone_norm: '9876543210', service: 'Netflix', plan: 'Private 1M', expiry_date: '2026-09-10 10:00:00', release_eligible_at: '2026-09-20 10:00:00', status: 'EXPIRED' };
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params });
    if (/FROM orders o LEFT JOIN subscriptions s1/.test(sql)) return [
      { order_id: 'O1', service: 'Netflix (Group Offer)', final_amount: '199.00', order_type: 'NEW', ref: 'NF-01#P2' },
      { order_id: 'O2', service: 'Netflix', final_amount: '199', order_type: 'RENEW', ref: 'NF-01#P3' },
      { order_id: 'O3', service: 'Prime Video', final_amount: '39', order_type: 'NEW', ref: 'PRI-01' },
      { order_id: 'O4', service: 'YouTube Premium', final_amount: '99', order_type: 'NEW', ref: null },
      { order_id: 'O5', service: 'Prime Video', final_amount: '40', order_type: 'NEW', ref: 'PRI-OLD' },
    ];
    if (/^SELECT service, account_id, login_id, is_active FROM inventory_accounts/.test(sql)) return [
      { service: 'Netflix', account_id: 'NF-01', login_id: 'n@x', is_active: 'TRUE' },
      { service: 'Prime Video', account_id: 'PRI-01', login_id: 'p@x', is_active: 'TRUE' },
      { service: 'Prime Video', account_id: 'PRI-02', login_id: 'p2@x', is_active: 'TRUE' },
    ];
    if (/^SELECT inventory_ref, COUNT\(\*\) n FROM subscriptions WHERE UPPER\(status\) = 'ACTIVE'/.test(sql)) return [{ inventory_ref: 'NF-01#P2', n: 1 }, { inventory_ref: 'NF-01#P3', n: 1 }, { inventory_ref: 'PRI-01', n: 3 }];
    if (/DATE_FORMAT\(COALESCE\(verified_at, created_at_sheet\), '%Y-%m'\) ym/.test(sql)) return [{ ym: '2026-08', revenue: '5000', n: 40, renewals: 10 }, { ym: '2026-09', revenue: '576', n: 5, renewals: 1 }];
    if (/FROM account_costs/.test(sql) && /^SELECT/.test(sql)) { if (!costsTable) { const e = new Error("Table 'x.account_costs' doesn't exist"); throw e; } return COSTS; }
    if (/^INSERT INTO account_costs/.test(sql) || /^DELETE FROM account_costs/.test(sql)) { if (!costsTable) throw new Error("Table 'x.account_costs' doesn't exist"); return { affectedRows: 1 }; }
    if (/^SELECT sub_id, phone_norm, service, plan, expiry_date, release_eligible_at, status FROM subscriptions/.test(sql)) return params[0] === SUB.sub_id ? [Object.assign({}, SUB)] : [];
    if (/^SELECT sub_id, expiry_date, release_eligible_at, status FROM subscriptions/.test(sql)) return [{ sub_id: SUB.sub_id, expiry_date: '2026-09-12 10:00:00', release_eligible_at: '2026-09-22 10:00:00', status: 'EXPIRED' }];
    return { affectedRows: 1 };
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};

(async () => {
  const { periodRange } = require('../profit');
  section('periods (India time)');
  const now = new Date('2026-09-14T06:00:00Z'); // 14 Sep 11:30 IST
  let pr = periodRange('this_month', now);
  ok('this month = 1 Sep .. tomorrow', pr.from === '2026-09-01 00:00:00' && pr.to === '2026-09-15 00:00:00' && pr.days === 14, pr);
  pr = periodRange('last_month', now);
  ok('last month = all of August', pr.from === '2026-08-01 00:00:00' && pr.to === '2026-09-01 00:00:00' && pr.days === 31, pr);
  pr = periodRange('30d', now);
  ok('30 days includes today', pr.from === '2026-08-16 00:00:00' && pr.days === 30, pr);
  pr = periodRange('365d', new Date('2026-01-05T20:00:00Z')); // 6 Jan 01:30 IST
  ok('uses the India date near midnight UTC', pr.to === '2026-01-07 00:00:00' && pr.days === 365, pr);
  ok('unknown period -> this month', periodRange('forever', now).period === 'this_month');

  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const last = (re) => [...calls].reverse().find((c) => re.test(c.sql));
  const tick = () => new Promise((r) => setTimeout(r, 20));

  section('profit');
  let r = await get('/admin/api/profit?period=last_month');
  const b = r.body; const acc = (id) => b.accounts.find((a) => a.accountId === id);
  const months = 31 / 30.4375;
  ok('paid orders in the period, by payment time', b.ok && /UPPER\(o.status\) = 'PAID' AND COALESCE\(o.verified_at, o.created_at_sheet\) >= \?/.test(last(/FROM orders o LEFT JOIN/).sql) && last(/FROM orders o LEFT JOIN/).params.join() === b.range.from + ',' + b.range.to && b.range.period === 'last_month' && /-01 00:00:00$/.test(b.range.from), b.range);
  ok('totals: revenue 576, 5 orders, 1 renewal', b.totals.revenue === 576 && b.totals.orders === 5 && b.totals.renewals === 1, b.totals);
  ok('Netflix account: 2 orders across profiles (Group Offer counts as Netflix), cost 300/month', acc('NF-01').revenue === 398 && acc('NF-01').orders === 2 && Math.abs(acc('NF-01').cost - 300 * months) < 0.02 && acc('NF-01').activeCustomers === 2, acc('NF-01'));
  ok('profit = revenue - cost for the period', Math.abs(acc('PRI-01').profit - (39 - 100 * months)) < 0.02, acc('PRI-01'));
  ok('account with no cost flagged and counted', acc('PRI-02').monthlyCost === null && b.totals.accountsWithoutCost === 1);
  ok('orders without an account (manual / deleted account) shown separately', b.noAccount.orders === 2 && b.noAccount.revenue === 139, b.noAccount);
  const nf = b.services.find((x) => x.family === 'netflix');
  ok('by service family, sorted by revenue', b.services[0].family === 'netflix' && nf.revenue === 398 && nf.renewals === 1 && nf.services.includes('Netflix (Group Offer)'), b.services);
  ok('6-month trend', b.trend.length === 2 && b.trend[0].month === '2026-08' && b.trend[0].revenue === 5000);
  costsTable = false;
  r = await get('/admin/api/profit');
  ok('before schema-v14: revenue still shown, costsReady false', r.body.ok && r.body.costsReady === false && r.body.totals.cost === 0);
  r = await post('/admin/api/profit/cost', { service: 'Netflix', accountId: 'NF-01', monthlyCost: '250' });
  ok('saving a cost before schema-v14 -> 409 with the fix', r.status === 409 && /schema-v14/.test(r.body.message));
  costsTable = true;

  section('account cost');
  r = await post('/admin/api/profit/cost', { service: 'Netflix', accountId: 'NF-01', monthlyCost: 'abc' });
  ok('non-number refused', r.status === 400);
  r = await post('/admin/api/profit/cost', { service: 'Netflix', accountId: 'NF-01', monthlyCost: '249.999', note: 'new plan' });
  const ins = last(/^INSERT INTO account_costs/);
  ok('saved (upsert, rounded)', r.body.ok && ins.params.join() === 'Netflix,NF-01,250,new plan' && /ON DUPLICATE KEY UPDATE/.test(ins.sql), ins);
  r = await post('/admin/api/profit/cost', { service: 'Netflix', accountId: 'NF-01', monthlyCost: '' });
  ok('empty clears the cost', r.body.cleared === true && last(/^DELETE FROM account_costs/).params.join() === 'Netflix,NF-01');
  await tick();
  ok('costs logged in the change log', calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'cost.save') && calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'cost.clear'));

  section('extend days');
  r = await post('/admin/api/subs/extend', { subId: 'SUB-1', days: 2 });
  ok('reason required', r.status === 400 && /reason/.test(r.body.message));
  r = await post('/admin/api/subs/extend', { subId: 'SUB-1', days: 0, reason: 'x' });
  ok('0 days refused', r.status === 400);
  r = await post('/admin/api/subs/extend', { subId: 'SUB-1', days: 1.5, reason: 'x' });
  ok('half days refused', r.status === 400);
  r = await post('/admin/api/subs/extend', { subId: 'SUB-1', days: 400, reason: 'x' });
  ok('more than a year refused', r.status === 400);
  r = await post('/admin/api/subs/extend', { subId: 'NOPE', days: 2, reason: 'x' });
  ok('unknown subscription -> 404', r.status === 404);
  calls.length = 0;
  r = await post('/admin/api/subs/extend', { subId: 'SUB-1', days: 2, reason: 'Netflix down 12-14 Sep' });
  const up = last(/^UPDATE subscriptions SET release_eligible_at/);
  ok('extends expiry and the release date by the same days', r.body.ok && up && up.params.join() === '2,2,SUB-1' && r.body.after.expiry === '2026-09-12 10:00:00', r.body);
  ok('release date is moved BEFORE expiry in the SET (MySQL applies SET left to right)', up && up.sql.indexOf('release_eligible_at = DATE_ADD(COALESCE(release_eligible_at, expiry_date)') < up.sql.indexOf('expiry_date = DATE_ADD(expiry_date'), up && up.sql);
  ok('reactivates an expired sub only if the new expiry is in the future; raw_json kept in step', /status = IF\(expiry_date > NOW\(\) AND UPPER\(COALESCE\(status, ''\)\) IN \('EXPIRED', ''\), 'ACTIVE', status\)/.test(up.sql) && /JSON_SET\(raw_json, '\$.ExpiryDate'/.test(up.sql));
  await tick();
  const au = calls.find((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'sub.extend');
  ok('change log has before/after and the reason', au && au.params[2] === 'SUB-1' && /\+2 day/.test(au.params[3]) && /Netflix down/.test(au.params[3]) && /2026-09-10 10:00:00/.test(au.params[4]), au);
  r = await post('/admin/api/subs/extend', { subId: 'SUB-1', days: -3, reason: 'Given by mistake' });
  await tick();
  ok('negative days take days off (logged as shorten)', r.body.ok && calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'sub.shorten'));

  section('panel');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel parses; Profit screen + Extend button on subscription cards', parsed && /function profitView\(/.test(html) && /function extendDialog\(/.test(html) && /extendDialog\(\\'' \+ id \+ '\\'\)/.test(html));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
