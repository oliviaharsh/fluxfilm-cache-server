/* 💰 Profit: one real login = one cost (Zee5 Z5-01 listed 4×, JioHotstar one login under several ids),
 * inactive accounts hidden but still counted, "stopped paying on <date>", duplicate cost rows merged,
 * 🏷️ rename / ✂️ split an AccountID everywhere — and the ☰ side menu closing on a phone.
 * Owner reports, 16 Sep 2026.
 * Run: npm test (no database: an in-memory fake that refuses cross-table JOINs, like MariaDB with
 * mixed collations - the one JOIN the profit view has always used is the exception, it is live-proven). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const nsql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const clone = (x) => JSON.parse(JSON.stringify(x));
const near = (a, b, tol) => Math.abs(a - b) < (tol == null ? 0.05 : tol);

// The only JOIN the app is allowed to make here (orders -> subscriptions, both old tables, same collation).
const ORDERS_JOIN = /FROM orders o LEFT JOIN subscriptions s1/;
const noJoin = (sql) => {
  if (ORDERS_JOIN.test(sql) || !/\bJOIN\b/i.test(sql)) return;
  const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT): ' + sql);
  e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e;
};

// ---------------------------------------------------------------- the shop, as the owner has it
const A = (service, account_id, login_id, plan) => ({ service, account_id, login_id, plan, password: 'p', is_active: 'TRUE', notes: '', raw_json: JSON.stringify({ Service: service, AccountID: account_id, LoginId: login_id }) });
let D;
function reset() {
  D = {
    sql: [], tx: [],
    // Zee5: ONE login, listed once per duration -> 4 rows, 1 AccountID.
    accounts: [
      A('Zee5 Premium', 'Z5-01', '9818196079', '1 Month'), A('Zee5 Premium', 'Z5-01', '9818196079', '3 Months'),
      A('Zee5 Premium', 'Z5-01', '9818196079', '6 Months'), A('Zee5 Premium', 'Z5-01', '9818196079', '1 Year'),
      // JioHotstar: ONE login under two different AccountIDs.
      A('JioHotstar', 'JH-3M-02', '8076332049', '3 Months'), A('JioHotstar', 'JH-6M-02', '8076332049', '6 Months'),
      // SonyLIV: no login recorded, the same id spelt two ways.
      A('SonyLIV', 'SL-01', '', '1 Month'), A('SonyLIV', 'sl 01', '', '1 Year'),
      // Netflix: nobody on it, no money this period - but the owner still pays for it.
      A('Netflix', 'NF-09', 'n9@x', 'Private'),
    ],
    costs: [
      { service: 'Zee5 Premium', account_id: 'Z5-01', monthly_cost: '183.33', note: '[billing:12:2200]' },
      { service: 'JioHotstar', account_id: 'JH-3M-02', monthly_cost: '41.67', note: '[billing:12:500]' },
      { service: 'JioHotstar', account_id: 'JH-6M-02', monthly_cost: '41.67', note: '[billing:12:500]' },
      { service: 'SonyLIV', account_id: 'SL-01', monthly_cost: '100', note: '' },
      { service: 'SonyLIV', account_id: 'sl 01', monthly_cost: '100', note: '' },
      { service: 'Netflix', account_id: 'NF-09', monthly_cost: '649', note: '' },
    ],
    occ: [{ inventory_ref: 'Z5-01', n: 4 }, { inventory_ref: 'JH-3M-02', n: 7 }, { inventory_ref: 'JH-6M-02', n: 1 }],
    orders: [
      { order_id: 'O1', service: 'Zee5 Premium', plan: '1 Month', duration_days: 30, final_amount: '249', order_type: 'NEW', ref: 'Z5-01', paid_at: '2026-08-01 12:00:00' },
      { order_id: 'O2', service: 'Zee5 Premium', plan: '1 Month', duration_days: 30, final_amount: '249', order_type: 'RENEW', ref: 'Z5-01', paid_at: '2026-08-02 12:00:00' },
      { order_id: 'O3', service: 'JioHotstar', plan: '3 Months', duration_days: 90, final_amount: '199', order_type: 'NEW', ref: 'JH-3M-02', paid_at: '2026-08-01 12:00:00' },
      { order_id: 'O4', service: 'SonyLIV', plan: '1 Month', duration_days: 30, final_amount: '99', order_type: 'NEW', ref: 'sl 01', paid_at: '2026-08-01 12:00:00' },
    ],
    subs: [
      { sub_id: 'S1', service: 'Zee5 Premium', plan: '1 Month', status: 'ACTIVE', expiry_date: '2026-10-01 00:00:00', account_id: 'Z5-01', inventory_ref: 'Z5-01', phone_norm: '9000000001' },
      { sub_id: 'S2', service: 'Zee5 Premium', plan: '3 Months', status: 'ACTIVE', expiry_date: '2026-11-01 00:00:00', account_id: 'Z5-01', inventory_ref: 'Z5-01', phone_norm: '9000000002' },
      { sub_id: 'S3', service: 'Zee5 Premium', plan: '6 Months', status: 'ACTIVE', expiry_date: '2026-12-01 00:00:00', account_id: 'Z5-01', inventory_ref: 'Z5-01', phone_norm: '9000000003' },
      { sub_id: 'S4', service: 'Zee5 Premium', plan: '1 Year', status: 'ACTIVE', expiry_date: '2027-06-01 00:00:00', account_id: 'Z5-01', inventory_ref: 'Z5-01', phone_norm: '9000000004' },
    ],
    caps: [{ service: 'Zee5 Premium', account_id: 'Z5-01', max_total: 7, max_tv: 0, is_active: 'TRUE', notes: '' }],
    profiles: [],
    fail: null, // set to a SQL fragment to make that statement blow up (rollback test)
  };
}
reset();

const like = (svc, p) => String(svc || '').toLowerCase().indexOf(String(p).replace(/%/g, '').toLowerCase()) > -1;
function run(sqlRaw, paramsRaw) {
  const sql = nsql(sqlRaw); const p = paramsRaw || [];
  D.sql.push(sql); noJoin(sql);
  if (D.fail && sql.indexOf(D.fail) > -1) throw new Error('boom: ' + D.fail);
  if (ORDERS_JOIN.test(sql)) return D.orders.map(clone);
  if (/^SELECT service, account_id, login_id, is_active FROM inventory_accounts/.test(sql)) return D.accounts.map((a) => ({ service: a.service, account_id: a.account_id, login_id: a.login_id, is_active: a.is_active }));
  if (/^SELECT inventory_ref, COUNT\(\*\) n FROM subscriptions/.test(sql)) return D.occ.map(clone);
  if (/DATE_FORMAT\(COALESCE\(verified_at, created_at_sheet\), '%Y-%m'\) ym/.test(sql)) return [{ ym: '2026-08', revenue: '796', n: 4, renewals: 1 }];
  if (/^SELECT service, account_id, monthly_cost, note FROM account_costs$/.test(sql)) return D.costs.map(clone);
  if (/^SELECT note FROM account_costs WHERE service = \? AND account_id = \?/.test(sql)) return D.costs.filter((c) => c.service === p[0] && c.account_id === p[1]).map((c) => ({ note: c.note }));
  if (/^SELECT monthly_cost, note FROM account_costs WHERE service = \? AND account_id = \?/.test(sql)) return D.costs.filter((c) => c.service === p[0] && c.account_id === p[1]).map(clone);
  if (/^SELECT service, account_id, monthly_cost, note FROM account_costs WHERE account_id = \?/.test(sql)) return D.costs.filter((c) => c.account_id === p[0] && like(c.service, p[1])).map(clone);
  if (/^INSERT INTO account_costs/.test(sql)) {
    const row = D.costs.find((c) => c.service === p[0] && c.account_id === p[1]);
    if (row) { row.monthly_cost = String(p[2]); row.note = p[3]; } else D.costs.push({ service: p[0], account_id: p[1], monthly_cost: String(p[2]), note: p[3] });
    return { affectedRows: 1 };
  }
  if (/^UPDATE account_costs SET note = \?/.test(sql)) { const row = D.costs.find((c) => c.service === p[1] && c.account_id === p[2]); if (row) row.note = p[0]; return { affectedRows: row ? 1 : 0 }; }
  if (/^UPDATE account_costs SET monthly_cost = \?, note = \?/.test(sql)) { const row = D.costs.find((c) => c.service === p[2] && c.account_id === p[3]); if (row) { row.monthly_cost = String(p[0]); row.note = p[1]; } return { affectedRows: row ? 1 : 0 }; }
  if (/^DELETE FROM account_costs WHERE service = \? AND account_id = \?/.test(sql)) { const i = D.costs.findIndex((c) => c.service === p[0] && c.account_id === p[1]); if (i > -1) D.costs.splice(i, 1); return { affectedRows: i > -1 ? 1 : 0 }; }
  // rename / split counting + reading
  if (/^SELECT COUNT\(\*\) n FROM (\w+) WHERE account_id = \? AND LOWER\(service\) LIKE \?/.test(sql)) {
    const t = sql.match(/FROM (\w+) /)[1];
    const src = { inventory_accounts: D.accounts, inventory_profiles: D.profiles, inventory_capacity: D.caps, account_costs: D.costs, subscriptions: D.subs }[t] || [];
    return [{ n: src.filter((r) => r.account_id === p[0] && like(r.service, p[1])).length }];
  }
  if (/^SELECT COUNT\(\*\) n FROM subscriptions WHERE LEFT\(inventory_ref, \?\)/.test(sql)) return [{ n: D.subs.filter((r) => String(r.inventory_ref || '').slice(0, p[0]) === p[1] && like(r.service, p[2])).length }];
  if (/^SELECT service, account_id, login_id, is_active, plan FROM inventory_accounts WHERE account_id = \?/.test(sql)) return D.accounts.filter((a) => a.account_id === p[0] && like(a.service, p[1])).map(clone);
  if (/^SELECT service, account_id, login_id, password, is_active, plan, notes, raw_json FROM inventory_accounts WHERE account_id = \?/.test(sql)) return D.accounts.filter((a) => a.account_id === p[0] && like(a.service, p[1])).map(clone);
  if (/^SELECT service, account_id, max_total, max_tv, is_active, notes FROM inventory_capacity WHERE account_id = \?/.test(sql)) return D.caps.filter((c) => c.account_id === p[0] && like(c.service, p[1])).map(clone);
  if (/FROM subscriptions WHERE account_id = \? AND LOWER\(service\) LIKE \?/.test(sql) && /^SELECT sub_id/.test(sql)) return D.subs.filter((x) => x.account_id === p[0] && like(x.service, p[1])).map(clone);
  // rename / split writing
  if (/^UPDATE (\w+) SET account_id = \? WHERE account_id = \? AND LOWER\(service\) LIKE \?$/.test(sql)) {
    const t = sql.match(/^UPDATE (\w+) /)[1];
    const src = { inventory_accounts: D.accounts, inventory_profiles: D.profiles, inventory_capacity: D.caps, account_costs: D.costs }[t] || [];
    let n = 0; for (const r of src) if (r.account_id === p[1] && like(r.service, p[2])) { r.account_id = p[0]; n++; }
    return { affectedRows: n };
  }
  if (/^UPDATE subscriptions SET account_id = \?, inventory_ref = IF\(inventory_ref IS NOT NULL AND LEFT/.test(sql) && /WHERE account_id = \? AND LOWER\(service\) LIKE \?$/.test(sql)) {
    let n = 0;
    for (const r of D.subs) {
      if (r.account_id !== p[6] || !like(r.service, p[7])) continue;
      r.account_id = p[0];
      if (r.inventory_ref && r.inventory_ref.slice(0, p[1]) === p[2]) r.inventory_ref = p[3] + r.inventory_ref.slice(p[4] - 1);
      n++;
    }
    return { affectedRows: n };
  }
  if (/^UPDATE subscriptions SET inventory_ref = CONCAT/.test(sql)) return { affectedRows: 0 };
  if (/^UPDATE subscriptions SET account_id = \?/.test(sql) && /WHERE sub_id IN \(/.test(sql)) {
    const hasLogin = /login_id = \?/.test(sql);
    const head = hasLogin ? 7 : 6; // toId [, login], fromLen, fromId, toId, fromLen+1, toId [, login]
    const tail = p.slice(head + (hasLogin ? 1 : 0));
    const fromId = tail[tail.length - 1]; const ids = tail.slice(0, -1);
    let n = 0;
    for (const r of D.subs) {
      if (ids.indexOf(r.sub_id) < 0 || r.account_id !== fromId) continue;
      r.account_id = p[0]; if (hasLogin) r.login_id = p[1];
      if (r.inventory_ref && r.inventory_ref.slice(0, p[hasLogin ? 2 : 1]) === p[hasLogin ? 3 : 2]) r.inventory_ref = p[0] + r.inventory_ref.slice(p[hasLogin ? 3 : 2].length);
      n++;
    }
    return { affectedRows: n };
  }
  if (/^INSERT INTO inventory_accounts/.test(sql)) { D.accounts.push({ service: p[0], account_id: p[1], login_id: p[2], password: p[3], is_active: p[4], plan: p[5], notes: p[6], raw_json: p[7] }); return { affectedRows: 1 }; }
  if (/^INSERT INTO inventory_capacity/.test(sql)) { D.caps.push({ service: p[0], account_id: p[1], max_total: p[2], max_tv: p[3], is_active: p[4], notes: p[5] }); return { affectedRows: 1 }; }
  if (/^SELECT COUNT\(\*\) n FROM inventory_profiles/.test(sql)) return [{ n: D.profiles.length }];
  if (/^INSERT INTO audit_log/.test(sql)) { D.log = D.log || []; D.log.push(p); return { affectedRows: 1 }; }
  if (/^SELECT 1/.test(sql)) return [{ ok: 1 }];
  return [];
}
const mkConn = () => ({
  query: async (sql, p) => [run(sql, p)],
  beginTransaction: async () => { D.tx.push('begin'); },
  commit: async () => { D.tx.push('commit'); },
  rollback: async () => { D.tx.push('rollback'); },
  release() {},
});
const pool = { query: async (sql, p) => [run(sql, p)], getConnection: async () => mkConn(), execute: async (sql, p) => [run(sql, p)] };
const db = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => pool, ping: async () => ({ ok: true }) };
const fakeCredit = { receivables: async () => ({ total: 0, count: 0, customers: 0, overdue: 0, list: [] }) };

(async () => {
  const profit = require('../profit');
  const AG = require('../accountgroups');
  const range = profit.periodRange('last_month', new Date('2026-09-14T06:00:00Z')); // all of August 2026, 31 days
  const months = range.months;

  section('the cost note carries the billing period and the stopped date (no schema change)');
  ok('[billing:12:2200] read back', JSON.stringify(AG.parseCostNote('[billing:12:2200] my note', 0)) === JSON.stringify({ every: 12, amount: 2200, stoppedOn: '', note: 'my note' }));
  ok('[stopped:…] read back, in either order', AG.parseCostNote('[stopped:2026-09-30][billing:3:900] x', 0).stoppedOn === '2026-09-30' && AG.parseCostNote('[billing:3:900][stopped:2026-09-30] x', 0).every === 3);
  ok('plain monthly note still works', JSON.stringify(AG.parseCostNote('just a note', '250')) === JSON.stringify({ every: 1, amount: 250, stoppedOn: '', note: 'just a note' }));
  ok('written back the same way', AG.buildCostNote(12, 2200, '2026-09-30', 'x') === '[billing:12:2200][stopped:2026-09-30] x' && AG.buildCostNote(1, 250, '', '') === '');
  ok('rubbish in the tags is ignored, the note survives', AG.parseCostNote('[billing:7:9][stopped:nope] hi', '5').note === 'hi');
  ok('"Z5-01" / "z5 01" / "Z5_01" are the same id', AG.normId('Z5-01') === 'z501' && AG.normId('z5 01') === 'z501' && AG.normId('Z5_01') === 'z501');

  section('one cost row, 4 subs on the login (the owner\'s Zee5)');
  let r = await profit.computeProfit(db, range, { credit: fakeCredit });
  const get = (id) => r.accounts.find((a) => a.ids.indexOf(id) > -1);
  let z = get('Z5-01');
  ok('4 inventory rows become ONE account', r.totals.inventoryRows === 9 && r.totals.accounts === 4 && z.rows === 4 && z.ids.length === 1, { rows: r.totals.inventoryRows, accounts: r.totals.accounts });
  ok('₹2,200 / year counted ONCE, not 4×', near(z.cost, (2200 / 12) * months, 0.02) && near(z.monthlyCost, 183.33) && z.billedEvery === 12 && z.billedAmount === 2200, z);
  ok('4 active customers on the one login', z.activeCustomers === 4, z.activeCustomers);
  ok('cost share per customer ≈ ₹45.83 / month', near(z.sharePerCustomer, 183.33 / 4), z.sharePerCustomer);
  ok('both Zee5 orders land on it', z.orders === 2 && z.revenue === 498, z);
  ok('it is flagged as one login listed several times', z.repeatedRows === true && z.sameLogin === false);

  section('duplicate cost rows for one login');
  let j = get('JH-3M-02');
  ok('two ids, one login (8076332049) = one account', j.sameLogin === true && j.ids.join() === 'JH-3M-02,JH-6M-02' && j.rows === 2, j.ids);
  ok('₹500 / year counted once although both ids have a cost row', near(j.cost, (500 / 12) * months, 0.02), { cost: j.cost, once: (500 / 12) * months });
  ok('the duplicate is reported so the panel can warn', j.extraCostRows.length === 1 && j.extraCostRows[0].accountId === 'JH-6M-02' && j.costKey.accountId === 'JH-3M-02', j.extraCostRows);
  ok('customers counted across both ids (7 + 1)', j.activeCustomers === 8, j.activeCustomers);
  let sl = get('SL-01');
  ok('same id spelt "SL-01" and "sl 01" = one account, ₹100 once', sl.ids.length === 2 && near(sl.cost, 100 * months, 0.02) && sl.extraCostRows.length === 1, sl);
  ok('an order booked on "sl 01" finds the account', sl.orders === 1 && sl.revenue === 99, sl);
  ok('two logins have a duplicate cost row', r.totals.duplicateCostGroups === 2 && r.totals.mergedLogins === 3, r.totals);

  section('totals add up');
  const expectCost = ((2200 / 12) + (500 / 12) + 100 + 649) * months;
  ok('cost = one charge per login', near(r.totals.cost, expectCost, 0.06), { got: r.totals.cost, want: expectCost });
  ok('profit = earned − cost', near(r.totals.profit, r.totals.earned - r.totals.cost, 0.02));
  ok('cash in = the 4 paid orders', r.totals.revenue === 796 && r.totals.orders === 4 && r.totals.renewals === 1, r.totals);
  ok('per-account costs add up to the total', near(r.accounts.reduce((t, a) => t + a.cost, 0), r.totals.cost, 0.02));
  ok('monthly bill for active logins counted once each', near(r.totals.monthlyCost, (2200 / 12) + (500 / 12) + 100 + 649, 0.05), r.totals.monthlyCost);

  section('an inactive account is hidden but its cost still counts');
  const nf = get('NF-09');
  ok('nobody on it and no money this period → quiet', nf.quiet === true && nf.activeCustomers === 0 && nf.revenue === 0, nf);
  ok('busy accounts are not quiet', z.quiet === false && j.quiet === false);
  ok('the totals say how many are quiet and what they cost', r.totals.quietAccounts === 1 && near(r.totals.quietCost, 649 * months, 0.02), r.totals);
  ok('the quiet account\'s cost IS inside the total', near(r.totals.cost - r.totals.quietCost, expectCost - 649 * months, 0.06));

  section('"stopped paying on <date>" stops the cost from that date');
  D.costs.find((c) => c.account_id === 'NF-09').note = '[stopped:2026-08-11]';
  let r2 = await profit.computeProfit(db, range, { credit: fakeCredit });
  const nf2 = r2.accounts.find((a) => a.accountId === 'NF-09');
  ok('only the 10 days before the date are charged', near(nf2.cost, 649 * 10 / 30.4375, 0.02), { got: nf2.cost, full: 649 * months });
  ok('the date is shown on the account', nf2.stoppedOn === '2026-08-11' && r2.totals.stoppedAccounts === 1);
  ok('it drops out of the "per month" figure', near(r2.totals.monthlyCost, (2200 / 12) + (500 / 12) + 100, 0.05), r2.totals.monthlyCost);
  ok('the rest of the totals are unchanged', r2.totals.revenue === r.totals.revenue && r2.totals.earned === r.totals.earned);
  D.costs.find((c) => c.account_id === 'NF-09').note = '[stopped:2026-07-01]';
  const before = (await profit.computeProfit(db, range, { credit: fakeCredit })).accounts.find((a) => a.accountId === 'NF-09');
  ok('stopped before the period → nothing at all', before.cost === 0 && before.costCounted === false);
  D.costs.find((c) => c.account_id === 'NF-09').note = '';
  ok('costFactor: after the period = full, inside = the part before it', AG.costFactor('2026-12-01', range) === 1 && near(AG.costFactor('2026-08-16', range), 15 / 31, 0.001) && AG.costFactor('', range) === 1);

  // ------------------------------------------------------------------ routes
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return db; if (req === './credit') return Object.assign({}, origLoad.apply(this, arguments), fakeCredit); return origLoad.apply(this, arguments); };
  const express = require('express');
  const app = express(); app.use(express.json());
  require('../admin').mountAdmin(app, { db, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((x) => server.once('listening', x));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const POST = async (p, b) => { const res = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: res.status, body: await res.json() }; };
  const tick = () => new Promise((x) => setTimeout(x, 25));

  section('merge duplicate cost rows');
  let m = await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'JH-3M-02', drop: [{ service: 'JioHotstar', accountId: 'JH-6M-02' }] });
  ok('the extra row is deleted, the counted one stays', m.body.ok && m.body.removed === 1 && !D.costs.some((c) => c.account_id === 'JH-6M-02') && D.costs.some((c) => c.account_id === 'JH-3M-02'), m.body);
  let after = await profit.computeProfit(db, range, { credit: fakeCredit });
  const j2 = after.accounts.find((a) => a.ids.indexOf('JH-3M-02') > -1);
  ok('the warning is gone and the cost did not change', j2.extraCostRows.length === 0 && near(j2.cost, (500 / 12) * months, 0.02) && after.totals.duplicateCostGroups === 1, j2.cost);
  ok('merging onto itself is refused', (await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'JH-3M-02', drop: [{ service: 'JioHotstar', accountId: 'JH-3M-02' }] })).status === 400);
  await tick();
  ok('it is in the change log', (D.log || []).some((x) => x[0] === 'cost.merge'));

  section('saving a cost keeps the stopped date');
  D.costs.find((c) => c.account_id === 'Z5-01').note = '[billing:12:2200][stopped:2026-09-30] shared';
  let sv = await POST('/admin/api/profit/cost', { service: 'Zee5 Premium', accountId: 'Z5-01', cost: '2400', every: 12 });
  ok('new amount, same stopped date', sv.body.ok && D.costs.find((c) => c.account_id === 'Z5-01').note === '[billing:12:2400][stopped:2026-09-30] shared', D.costs.find((c) => c.account_id === 'Z5-01'));
  sv = await POST('/admin/api/profit/cost/stopped', { service: 'Zee5 Premium', accountId: 'Z5-01', stoppedOn: '' });
  ok('"still paying" clears it and keeps the billing period', sv.body.ok && D.costs.find((c) => c.account_id === 'Z5-01').note === '[billing:12:2400] shared');
  ok('a bad date is refused', (await POST('/admin/api/profit/cost/stopped', { service: 'Zee5 Premium', accountId: 'Z5-01', stoppedOn: '30/09/2026' })).status === 400);
  ok('a stopped date with no cost row is refused', (await POST('/admin/api/profit/cost/stopped', { service: 'Netflix', accountId: 'NOPE', stoppedOn: '2026-09-01' })).status === 404);
  await POST('/admin/api/profit/cost', { service: 'Zee5 Premium', accountId: 'Z5-01', cost: '2200', every: 12 });

  section('🏷️ rename an AccountID everywhere');
  let pv = await POST('/admin/api/account/rename/preview', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-09' });
  ok('preview counts every table', pv.body.ok && pv.body.rows.inventory_accounts === 4 && pv.body.rows.account_costs === 1 && pv.body.rows.inventory_capacity === 1 && pv.body.rows.subscriptions === 4 && pv.body.rows.total === 10 && !pv.body.blocked, pv.body.rows);
  ok('renaming onto an id that exists is refused', (await POST('/admin/api/account/rename/preview', { service: 'JioHotstar', fromId: 'JH-3M-02', toId: 'JH-6M-02' })).body.blocked.indexOf('already uses') > -1);
  ok('the refusal is a 409 on the real call', (await POST('/admin/api/account/rename', { service: 'JioHotstar', fromId: 'JH-3M-02', toId: 'JH-6M-02' })).status === 409);
  ok('an unknown account is a 404, a silly id a 400', (await POST('/admin/api/account/rename', { service: 'Zee5 Premium', fromId: 'NOPE', toId: 'X1' })).status === 404 && (await POST('/admin/api/account/rename', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'a;b' })).status === 400);
  D.tx = [];
  let rn = await POST('/admin/api/account/rename', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-09' });
  ok('every table is updated', rn.body.ok && rn.body.changed.inventory_accounts === 4 && rn.body.changed.account_costs === 1 && rn.body.changed.inventory_capacity === 1 && rn.body.changed.subscriptions === 4, rn.body.changed);
  ok('one transaction, committed', D.tx.join() === 'begin,commit', D.tx);
  ok('inventory, cost row, capacity and subs all say Z5-09', D.accounts.filter((a) => a.account_id === 'Z5-09').length === 4 && D.costs.some((c) => c.account_id === 'Z5-09') && D.caps[0].account_id === 'Z5-09' && D.subs.every((x) => x.account_id === 'Z5-09'));
  ok('the inventory_ref prefix moved too', D.subs.every((x) => x.inventory_ref === 'Z5-09'));
  ok('raw_json is kept in step (AccountID + InventoryRef)', D.sql.some((x) => /JSON_SET\(raw_json, '\$.AccountID', \?, '\$.InventoryRef'/.test(x)));
  ok('the profit view follows the new name', (await profit.computeProfit(db, range, { credit: fakeCredit })).accounts.some((a) => a.accountId === 'Z5-09'));
  await tick();
  ok('it is in the change log', (D.log || []).some((x) => x[0] === 'account.rename' && /Z5-09/.test(x[3])));

  section('a rename that blows up changes nothing');
  D.fail = 'UPDATE inventory_capacity SET account_id';
  D.tx = [];
  const bad = await POST('/admin/api/account/rename', { service: 'Zee5 Premium', fromId: 'Z5-09', toId: 'Z5-77' });
  ok('rolled back, nothing kept', !bad.body.ok && D.tx.join() === 'begin,rollback' && /Nothing was changed/.test(bad.body.message), { tx: D.tx, msg: bad.body.message });
  D.fail = null;
  reset();

  section('✂️ split: move some plans onto a new login');
  let sp = await POST('/admin/api/account/split/preview', { service: 'Zee5 Premium', fromId: 'Z5-01' });
  ok('preview lists the plans and the cost to divide', sp.body.ok && sp.body.subs.length === 4 && sp.body.cost.amount === 2200 && sp.body.cost.every === 12 && sp.body.logins[0] === '9818196079', { subs: sp.body.subs.length, cost: sp.body.cost });
  ok('only the last 4 digits of a phone are sent', sp.body.subs[0].phone.length === 4);
  ok('no plans picked → refused', (await POST('/admin/api/account/split', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-02', subIds: [] })).status === 400);
  ok('a plan that is not on the account → refused', (await POST('/admin/api/account/split', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-02', subIds: ['S1', 'NOPE'] })).status === 409);
  D.tx = [];
  let sr = await POST('/admin/api/account/split', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-02', subIds: ['S3', 'S4'], login: '9000000099', costMode: 'divide', ways: 2 });
  ok('the chosen plans moved, the others stayed', sr.body.ok && sr.body.made.subscriptions === 2 && D.subs.filter((x) => x.account_id === 'Z5-02').map((x) => x.sub_id).join() === 'S3,S4' && D.subs.filter((x) => x.account_id === 'Z5-01').length === 2, D.subs.map((x) => x.sub_id + ':' + x.account_id));
  ok('their inventory_ref moved with them', D.subs.filter((x) => x.account_id === 'Z5-02').every((x) => x.inventory_ref === 'Z5-02'));
  ok('the new account exists with its own login and capacity', D.accounts.filter((a) => a.account_id === 'Z5-02').length === 4 && D.accounts.find((a) => a.account_id === 'Z5-02').login_id === '9000000099' && D.caps.some((c) => c.account_id === 'Z5-02'));
  ok('₹2,200 split 2 ways: ₹1,100 each', sr.body.newAmount === 1100 && sr.body.keepAmount === 1100 && D.costs.find((c) => c.account_id === 'Z5-02').note === '[billing:12:1100]' && D.costs.find((c) => c.account_id === 'Z5-01').note === '[billing:12:1100]', D.costs.filter((c) => /Z5/.test(c.account_id)));
  ok('one transaction, committed', D.tx.join() === 'begin,commit', D.tx);
  let sr2 = await profit.computeProfit(db, range, { credit: fakeCredit });
  ok('the profit view now shows two accounts, ₹2,200 in total', sr2.accounts.filter((a) => /^Z5-0/.test(a.accountId)).length === 2 && near(sr2.accounts.filter((a) => /^Z5-0/.test(a.accountId)).reduce((t, a) => t + a.cost, 0), (2200 / 12) * months, 0.05));
  await tick();
  ok('it is in the change log', (D.log || []).some((x) => x[0] === 'account.split'));

  reset();
  sr = await POST('/admin/api/account/split', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-03', subIds: ['S4'], costMode: 'amount', costAmount: '600' });
  ok('a typed amount goes on the new account, the old one keeps its own', sr.body.ok && sr.body.newAmount === 600 && D.costs.find((c) => c.account_id === 'Z5-03').note === '[billing:12:600]' && D.costs.find((c) => c.account_id === 'Z5-01').note === '[billing:12:2200]');
  reset();
  D.profiles = [{ service: 'Zee5 Premium', account_id: 'Z5-01', profile_number: '1' }];
  ok('an account with profiles cannot be split (they would point at the wrong login)', (await POST('/admin/api/account/split', { service: 'Zee5 Premium', fromId: 'Z5-01', toId: 'Z5-04', subIds: ['S1'] })).status === 409);
  reset();

  section('no cross-table statement, and the key is still needed');
  ok('every statement touched one table (the old orders→subs join excepted)', !D.sql.concat([]).some((x) => /\bJOIN\b/i.test(x) && !ORDERS_JOIN.test(x)));
  ok('wrong admin key → 403', (await fetch(base + '/admin/api/account/rename', { method: 'POST', headers: { 'X-Admin-Key': 'nope', 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
  ok('profit route answers over HTTP', (await (await fetch(base + '/admin/api/profit?period=this_month', { headers: H })).json()).ok);

  // ------------------------------------------------------------------ the panel
  section('☰ side menu: there is always a way out');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline script parses', scripts.length > 0 && parsed);
  ok('a dimmed area beside the menu, and tapping it closes', /class="scrim" id="scrim" onclick="toggleSide\(false\)"/.test(html) && /\.scrim\{/.test(html) && /@media\(max-width:900px\)[^}]*[\s\S]{0,400}\.scrim\{display:block\}/.test(html));
  ok('a ✕ in the drawer header', /class="sidex" onclick="toggleSide\(false\)"/.test(html) && /aria-label="Close menu"/.test(html));
  ok('Esc closes the dialog first, then the menu', /if \(\$\('#modal'\)\) \{ closeModal\(\); return; \}/.test(html) && /sideOpen\(\)\) toggleSide\(false\)/.test(html));
  ok('a swipe to the left closes it', /touchstart/.test(html) && /dx < -45/.test(html) && /function wireSideClose\(/.test(html));
  ok('the phone Back button still closes it (history layer "side")', /hPush\(hCopy\(H\.cur, \{ layer: 'side' \}\)\)/.test(html) && /H\.cur\.layer === 'side'\) hDropTop\(\)/.test(html) && /cur\.layer === 'side' && st\.layer !== 'side' && sd\) sideShow\(false\)/.test(html));
  ok('the existing Back handling is untouched: unsaved drafts / dialogs still ask', /function hLeaveBlocked\(/.test(html) && /\(closingModal && hLeaveBlocked\(true\)\) \|\| \(!closingModal && leavingScreen && hLeaveBlocked\(\)\)/.test(html) && /draftStop\(FD_DRAFT\)/.test(html));

  const grab = (name) => { const i = html.indexOf('function ' + name + '('); let depth = 0; const j = html.indexOf('{', i); for (let k = j; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); } } return ''; };
  ok('closing the menu never asks about unsaved work', !/hLeaveBlocked/.test(grab('toggleSide') + grab('sideShow')) && /hLeaveBlocked/.test(grab('nav')));
  const cls = (set) => ({ _s: set, contains: (c) => set.indexOf(c) > -1, toggle: (c, on) => { const i = set.indexOf(c); if (on && i < 0) set.push(c); if (!on && i > -1) set.splice(i, 1); } });
  const swipes = [];
  const side = { classList: cls([]), addEventListener: (k, f) => swipes.push([k, f]) }, scrim = { classList: cls([]) };
  const calls = [];
  const H0 = { cur: { ffv: 'today', n: 1 } };
  const menu = new Function('side', 'scrim', 'calls', 'H', 'return (function(){' +
    'var $ = function (s) { return s === "#side" ? side : s === "#scrim" ? scrim : null; };' +
    'function hCopy(a, b) { var o = {}, k; for (k in a || {}) o[k] = a[k]; for (k in b || {}) o[k] = b[k]; return o; }' +
    'function hPush(st) { calls.push("push:" + st.layer); H.cur = st; }' +
    'function hDropTop() { calls.push("drop"); }' +
    grab('sideShow') + grab('sideOpen') + grab('wireSideClose') + grab('toggleSide') +
    ' return { toggleSide: toggleSide, sideOpen: sideOpen, sideShow: sideShow }; })()')(side, scrim, calls, H0);
  menu.toggleSide();
  ok('☰ opens the drawer and the dimmed area together', side.classList.contains('open') && scrim.classList.contains('on') && calls.join() === 'push:side', { calls, scrim: scrim.classList._s });
  menu.toggleSide(false);
  ok('tapping the dimmed area closes both and drops the history entry', !side.classList.contains('open') && !scrim.classList.contains('on') && calls.join() === 'push:side,drop', calls);
  menu.toggleSide(false);
  ok('closing an already closed menu does nothing', calls.length === 2);
  menu.sideShow(true);
  ok('sideOpen reports the real state', menu.sideOpen() === true && scrim.classList.contains('on'));
  ok('the swipe listeners are wired the first time it opens, once', swipes.map((x) => x[0]).join() === 'touchstart,touchend', swipes.map((x) => x[0]));
  // A real swipe to the left, through the real handler.
  menu.sideShow(true); calls.length = 0; H0.cur = { ffv: 'today', n: 2, layer: 'side' };
  swipes.find((x) => x[0] === 'touchstart')[1]({ touches: [{ clientX: 200, clientY: 300 }] });
  swipes.find((x) => x[0] === 'touchend')[1]({ changedTouches: [{ clientX: 100, clientY: 310 }] });
  ok('swiping the drawer to the left closes it', !side.classList.contains('open') && !scrim.classList.contains('on') && calls.join() === 'drop', calls);

  section('💰 Profit page shows what is happening');
  ok('a row per real login, and it says so', /One row per real login/.test(html) && /charged once<\/b>/.test(html) && /counted once per login/.test(html));
  ok('"₹2,200 every 12 months = ₹183 / month · N customers on it · share per customer"', /function pfCostLine\(/.test(html) && /' every 12 months'/.test(html) && /customer' \+ \(a\.activeCustomers === 1 \? '' : 's'\) \+ ' on it'/.test(html) && /your cost share per customer ≈ /.test(html));
  ok('a "1 login · id, id" badge when one login has several ids', /1 login · ' \+ esc\(a\.ids\.join\(', '\)\)/.test(html) && /listings, 1 login/.test(html));
  ok('duplicate cost rows warn and offer a one-tap merge', /cost rows for this login/.test(html) && /counted once \(/.test(html) && /data-pfmerge=/.test(html) && /function pfMerge\(/.test(html));
  ok('inactive accounts are hidden behind a toggle that names the count', /showQuiet \? '🙈 Hide' : '👁️ Show'/.test(html) && /inactive accounts \(' \+ quiet\.length \+ '\)/.test(html) && /PF\.showQuiet = !PF\.showQuiet/.test(html));
  ok('the toggle states plainly that their cost is still counted', /cost IS counted in the totals above<\/b>/.test(html) && /you are still paying for them/.test(html));
  ok('a per-account "stopped paying" switch', /function pfStopDialog\(/.test(html) && /🛑 Stopped paying/.test(html) && /↩️ Still paying/.test(html) && /profit\/cost\/stopped/.test(html));
  ok('🏷️ rename with a preview of how many rows change', /function pfRenameDialog\(/.test(html) && /account\/rename\/preview/.test(html) && /Rename everywhere/.test(html));
  ok('✂️ split, with the warning that it is only right for different logins', /function pfSplitDialog\(/.test(html) && /Only split when this id really covers several DIFFERENT logins/.test(html) && /one account with one cost/.test(html) && /account\/split/.test(html));
  ok('split offers divide / typed amount / move / leave', /Divide it equally/.test(html) && /Type an amount for the new account/.test(html) && /Move the whole cost to the new account/.test(html));

  const pkg = require('../package.json');
  ok('this test is in npm test', /node test\/profit-accounts-menu\.test\.js/.test(pkg.scripts.test));
  ok('accountgroups.js and accountid.js are real files, mounted by admin.js', fs.existsSync(path.join(__dirname, '..', 'accountgroups.js')) && fs.existsSync(path.join(__dirname, '..', 'accountid.js')) && /require\('\.\/accountid'\)\.mount/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')));
  ok('no schema change was needed', !fs.existsSync(path.join(__dirname, '..', 'db', 'schema-v27.sql')));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((x) => server.close(x));
  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
