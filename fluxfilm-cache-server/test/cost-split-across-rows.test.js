/* 💰 Several cost rows on one login mean one of two OPPOSITE things:
 *   · the same cost typed on each row   (duplicates → keep one)
 *   · the real cost divided across rows (a split    → add them up)
 * The owner did the second with JioHotstar 8076332049: 3 × ₹500/year is really ₹1,500/year, while
 * his other JioHotstar logins cost ₹1,499/year. The 🔗 Merge dialog now asks which it is, suggests
 * the answer from the data, and a login that looks far too cheap next to the rest of its service
 * gets a gentle flag. Owner follow-up, 16 Sep 2026.
 * Run: npm test (no database: an in-memory fake that refuses cross-table JOINs). */
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
const family = (s) => (String(s || '').toLowerCase().match(/[a-z0-9]+/) || [''])[0];

const ORDERS_JOIN = /FROM orders o LEFT JOIN subscriptions s1/;
const noJoin = (sql) => {
  if (ORDERS_JOIN.test(sql) || !/\bJOIN\b/i.test(sql)) return;
  const e = new Error('Illegal mix of collations: ' + sql); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e;
};

// ---------------------------------------------------------------- the shop, as it is live
const A = (service, account_id, login_id) => ({ service, account_id, login_id, is_active: 'TRUE' });
const C = (service, account_id, amount, every) => ({ service, account_id, monthly_cost: String(Math.round((amount / every) * 100) / 100), note: every === 1 ? '' : '[billing:' + every + ':' + amount + ']' });
let D;
function reset() {
  D = {
    sql: [], log: [],
    accounts: [
      // JioHotstar: two normal logins at ₹1,499/yr, and the owner's one login listed under 3 ids
      // with his real ₹1,500/yr divided across them as 3 × ₹500.
      A('JioHotstar', 'JH-1M-01', 'a@x'), A('JioHotstar', 'JH-1Y-03', 'b@x'),
      A('JioHotstar', 'JH-3M-02', '8076332049'), A('JioHotstar', 'JH-6M-02', '8076332049'), A('JioHotstar', 'JH-1Y-02', '8076332049'),
      // Netflix: two honest price tiers (₹400 and ₹649), every login a single row — none of these
      // is a split, and none may be flagged.
      A('Netflix', 'NFLX-D1', 'd1@x'), A('Netflix', 'NFLX-D3', 'd3@x'), A('Netflix', 'NFLX-D4', 'd4@x'),
      A('Netflix', 'NFLX-H1', 'h1@x'), A('Netflix', 'NFLX-H2', 'h2@x'), A('Netflix', 'NFLX-H3', 'h3@x'),
      // Zee5: one login listed 4×, the SAME ₹2,200/yr typed on two of the rows (real duplicates).
      A('Zee5 Premium', 'Z5-01', '9818196079'), A('Zee5 Premium', 'Z5-01', '9818196079'),
      A('Zee5 Premium', 'Z5-02', '9818100000'), A('Zee5 Premium', 'Z5-03', '9818100001'),
      // SonyLIV: the only login of its service — nothing to compare it with.
      A('SonyLIV', 'SL-02', 's@x'),
    ],
    costs: [
      C('JioHotstar', 'JH-1M-01', 1499, 12), C('JioHotstar', 'JH-1Y-03', 1499, 12),
      C('JioHotstar', 'JH-3M-02', 500, 12), C('JioHotstar', 'JH-6M-02', 500, 12), C('JioHotstar', 'JH-1Y-02', 500, 12),
      C('Netflix', 'NFLX-D1', 400, 1), C('Netflix', 'NFLX-D3', 400, 1), C('Netflix', 'NFLX-D4', 400, 1),
      C('Netflix', 'NFLX-H1', 649, 1), C('Netflix', 'NFLX-H2', 649, 1), C('Netflix', 'NFLX-H3', 649, 1),
      C('Zee5 Premium', 'Z5-01', 2200, 12), C('Zee5 Premium', 'Z5-02', 2200, 12), C('Zee5 Premium', 'Z5-03', 2200, 12),
      C('SonyLIV', 'SL-02', 199, 12),
    ],
    occ: [{ inventory_ref: 'JH-3M-02', n: 7 }, { inventory_ref: 'JH-1Y-02', n: 1 }, { inventory_ref: 'JH-1M-01', n: 9 }],
    orders: [{ order_id: 'O1', service: 'JioHotstar', plan: '3 Months', duration_days: 90, final_amount: '199', order_type: 'NEW', ref: 'JH-3M-02', paid_at: '2026-08-01 12:00:00' }],
  };
}
reset();

// A second Zee5 cost row that is a true duplicate of the first (same id spelt with a space).
const addZeeDuplicate = () => { D.accounts.push(A('Zee5 Premium', 'z5 01', '9818196079')); D.costs.push(C('Zee5 Premium', 'z5 01', 2200, 12)); };

function run(sqlRaw, paramsRaw) {
  const sql = nsql(sqlRaw); const p = paramsRaw || [];
  D.sql.push(sql); noJoin(sql);
  if (ORDERS_JOIN.test(sql)) return D.orders.map(clone);
  if (/^SELECT service, account_id, login_id, is_active FROM inventory_accounts/.test(sql)) return D.accounts.map(clone);
  if (/^SELECT inventory_ref, COUNT\(\*\) n FROM subscriptions/.test(sql)) return D.occ.map(clone);
  if (/ym, SUM\(final_amount\)/.test(sql)) return [];
  if (/^SELECT service, account_id, monthly_cost, note FROM account_costs$/.test(sql)) return D.costs.map(clone);
  if (/^SELECT (service, account_id, )?monthly_cost, note FROM account_costs WHERE service = \? AND account_id = \?/.test(sql)) return D.costs.filter((c) => c.service === p[0] && c.account_id === p[1]).map(clone);
  if (/^SELECT note FROM account_costs WHERE service = \? AND account_id = \?/.test(sql)) return D.costs.filter((c) => c.service === p[0] && c.account_id === p[1]).map((c) => ({ note: c.note }));
  if (/^UPDATE account_costs SET monthly_cost = \?, note = \?/.test(sql)) { const r = D.costs.find((c) => c.service === p[2] && c.account_id === p[3]); if (r) { r.monthly_cost = String(p[0]); r.note = p[1]; } return { affectedRows: r ? 1 : 0 }; }
  if (/^DELETE FROM account_costs WHERE service = \? AND account_id = \?/.test(sql)) { const i = D.costs.findIndex((c) => c.service === p[0] && c.account_id === p[1]); if (i > -1) D.costs.splice(i, 1); return { affectedRows: i > -1 ? 1 : 0 }; }
  if (/^INSERT INTO audit_log/.test(sql)) { D.log.push(p); return { affectedRows: 1 }; }
  return [];
}
const pool = { query: async (s, p) => [run(s, p)], getConnection: async () => ({ query: async (s, p) => [run(s, p)], beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }) };
const db = { ENABLED: true, query: async (s, p) => run(s, p), getPool: () => pool, ping: async () => ({ ok: true }) };
const fakeCredit = { receivables: async () => ({ total: 0, count: 0, customers: 0, overdue: 0, list: [] }) };

(async () => {
  const AG = require('../accountgroups');
  const profit = require('../profit');
  const range = profit.periodRange('last_month', new Date('2026-09-14T06:00:00Z')); // August 2026
  const months = range.months;
  const load = async () => (await profit.computeProfit(db, range, { credit: fakeCredit }));
  const of = (r, id) => r.accounts.find((a) => a.ids.indexOf(id) > -1);

  section('the suggestion reads the shape of the data');
  let r = await load();
  const jio = of(r, 'JH-3M-02');
  ok('the owner\'s login is 3 ids, 3 cost rows, one account', jio.ids.length === 3 && jio.costRows === 3 && jio.rows === 3, { ids: jio.ids, costRows: jio.costRows });
  ok('it knows what the other JioHotstar logins pay (₹1,499 / year)', jio.typical && jio.typical.amount === 1499 && jio.typical.every === 12 && jio.typical.logins === 2, jio.typical);
  ok('3 × ₹500 adds up to ₹1,500 / year, which matches → suggest ADDING THEM UP', jio.suggestion.mode === 'sum' && jio.suggestion.sum.amount === 1500 && near(jio.suggestion.sum.monthly, 125), jio.suggestion);
  ok('keeping one row is offered too, at ₹500 / year', jio.suggestion.keep.amount === 500 && near(jio.suggestion.keep.monthly, 41.67), jio.suggestion.keep);
  ok('the reason is one plain line naming both figures', /other 2 logins/.test(jio.suggestion.why) && /₹1,499 \/ year/.test(jio.suggestion.why) && /3 × ₹500/.test(jio.suggestion.why) && /₹1,500 \/ year/.test(jio.suggestion.why) && /split 3 ways/.test(jio.suggestion.why), jio.suggestion.why);

  addZeeDuplicate();
  r = await load();
  const zee = of(r, 'Z5-01');
  ok('Zee5: the SAME ₹2,200 typed twice, and ₹2,200 is what other Zee5 logins pay → suggest KEEPING ONE', zee.costRows === 2 && zee.suggestion.mode === 'keep' && zee.suggestion.keep.amount === 2200, zee.suggestion);
  ok('the reason says they are the same thing typed twice', /the same thing typed 2 times/.test(zee.suggestion.why) && /₹2,200/.test(zee.suggestion.why), zee.suggestion.why);
  ok('adding them up is still offered, at ₹4,400', zee.suggestion.sum.amount === 4400);
  ok('a login with one cost row is only offered "type it yourself"', of(r, 'SL-02').suggestion.mode === 'manual' && /nothing to add up/.test(of(r, 'SL-02').suggestion.why));

  section('the pure suggestion rule, on its own');
  const rows = (n, amt, every) => Array.from({ length: n }, () => ({ amount: amt, every: every || 12, monthly: amt / (every || 12) }));
  const typ = (amount, every) => ({ monthly: amount / every, every, amount, logins: 3 });
  ok('same amounts that each match the typical price → keep', AG.suggestCore(rows(3, 1499), 124.92, 374.75, typ(1499, 12)).mode === 'keep');
  ok('same amounts whose SUM matches the typical price → sum', AG.suggestCore(rows(3, 500), 41.67, 125, typ(1499, 12)).mode === 'sum');
  ok('neither close → manual', AG.suggestCore(rows(2, 10), 10 / 12, 20 / 12, typ(1499, 12)).mode === 'manual' && /type what you really pay/.test(AG.suggestCore(rows(2, 10), 10 / 12, 20 / 12, typ(1499, 12)).why));
  ok('no other login to compare with: same amounts → keep, different amounts → sum',
    AG.suggestCore(rows(2, 500), 41.67, 83.34, null).mode === 'keep' &&
    AG.suggestCore([{ amount: 300, every: 12, monthly: 25 }, { amount: 700, every: 12, monthly: 58.33 }], 58.33, 83.33, null).mode === 'sum');

  section('the "looks too cheap" flag');
  ok('the owner\'s JioHotstar login is flagged', jio.lowCost === true && r.totals.lowCostGroups === 1, { low: jio.lowCost, n: r.totals.lowCostGroups });
  ok('the two normal JioHotstar logins are not', of(r, 'JH-1M-01').lowCost === false && of(r, 'JH-1Y-03').lowCost === false);
  ok('a genuinely cheaper single-row plan is NOT flagged (₹400 Netflix next to ₹649 ones)', of(r, 'NFLX-D1').lowCost === false && of(r, 'NFLX-H1').lowCost === false, r.accounts.filter((a) => a.lowCost).map((a) => a.accountId));
  ok('the ₹400 tier really is below the ₹649 median, it is just not below half of it', of(r, 'NFLX-D1').monthlyCost === 400 && of(r, 'NFLX-D1').typical.monthly === 649);
  ok('a service with only one login is never flagged', of(r, 'SL-02').lowCost === false && of(r, 'SL-02').typical === null);
  ok('exactly one login in the whole shop is flagged', r.accounts.filter((a) => a.lowCost).length === 1);

  // ------------------------------------------------------------------ routes
  const origLoad = Module._load;
  Module._load = function (q) { if (q === './db') return db; return origLoad.apply(this, arguments); };
  const express = require('express');
  const app = express(); app.use(express.json());
  require('../admin').mountAdmin(app, { db, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((x) => server.once('listening', x));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const POST = async (p, b) => { const res = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: res.status, body: await res.json() }; };
  const tick = () => new Promise((x) => setTimeout(x, 25));
  const jioDrop = [{ service: 'JioHotstar', accountId: 'JH-6M-02' }, { service: 'JioHotstar', accountId: 'JH-1Y-02' }];
  const jioCostBefore = r.accounts.find((a) => a.ids.indexOf('JH-3M-02') > -1).cost;

  section('“I split the real cost across the rows” → add them up');
  let m = await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'JH-3M-02', drop: jioDrop, mode: 'sum' });
  ok('the kept row becomes ₹1,500 / year and the other two go', m.body.ok && m.body.amount === 1500 && m.body.every === 12 && near(m.body.monthlyCost, 125) && m.body.removed === 2, m.body);
  ok('the stored row matches', D.costs.filter((c) => /^JH-/.test(c.account_id)).length === 3 && D.costs.find((c) => c.account_id === 'JH-3M-02').note === '[billing:12:1500]', D.costs.filter((c) => /^JH-/.test(c.account_id)));
  let after = await load();
  const jio2 = of(after, 'JH-3M-02');
  ok('the profit view now charges ₹1,500 / year ONCE, not three times', near(jio2.cost, (1500 / 12) * months, 0.02) && jio2.costRows === 1 && jio2.extraCostRows.length === 0, { got: jio2.cost, want: (1500 / 12) * months });
  ok('it is 3× the old figure, not 9× — no double counting', near(jio2.cost, jioCostBefore * 3, 0.05) && jio2.extraCostRows.length === 0, { before: jioCostBefore, now: jio2.cost, want: jioCostBefore * 3 });
  ok('the flag is gone and the account no longer looks cheap', jio2.lowCost === false && after.totals.lowCostGroups === 0);
  ok('its 8 customers still share one cost', jio2.activeCustomers === 8 && near(jio2.sharePerCustomer, 125 / 8, 0.02), jio2.sharePerCustomer);
  await tick();
  ok('the change log says what happened', D.log.some((x) => x[0] === 'cost.merge' && /added 3 rows up/.test(x[3]) && /1500/.test(x[3])), (D.log.find((x) => x[0] === 'cost.merge') || [])[3]);

  section('“same cost typed on each row” → keep one');
  reset(); addZeeDuplicate();
  const zeeBefore = of(await load(), 'Z5-01').cost;
  m = await POST('/admin/api/profit/cost/merge', { service: 'Zee5 Premium', accountId: 'Z5-01', drop: [{ service: 'Zee5 Premium', accountId: 'z5 01' }], mode: 'keep' });
  ok('the amount is untouched, the duplicate is deleted', m.body.ok && m.body.amount === 2200 && m.body.removed === 1 && !D.costs.some((c) => c.account_id === 'z5 01'), m.body);
  after = await load();
  ok('the cost is exactly what it was — it was already counted once', near(of(after, 'Z5-01').cost, zeeBefore, 0.01) && of(after, 'Z5-01').costRows === 1, { before: zeeBefore, now: of(after, 'Z5-01').cost });

  section('“enter the real cost myself”');
  reset();
  m = await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'JH-3M-02', drop: jioDrop, mode: 'manual', amount: 1499, every: 12 });
  ok('the typed amount wins over both suggestions', m.body.ok && m.body.amount === 1499 && near(m.body.monthlyCost, 124.92) && m.body.removed === 2, m.body);
  after = await load();
  ok('the profit view uses it, once', near(of(after, 'JH-3M-02').cost, (1499 / 12) * months, 0.02) && of(after, 'JH-3M-02').lowCost === false);
  reset();
  m = await POST('/admin/api/profit/cost/merge', { service: 'SonyLIV', accountId: 'SL-02', drop: [], mode: 'manual', amount: 999, every: 12 });
  ok('it works on a login with a single cost row too (nothing to delete)', m.body.ok && m.body.amount === 999 && m.body.removed === 0, m.body);
  ok('a [stopped:…] date on the row survives a merge', await (async () => {
    reset();
    D.costs.find((c) => c.account_id === 'JH-3M-02').note = '[billing:12:500][stopped:2026-08-20] mine';
    await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'JH-3M-02', drop: jioDrop, mode: 'sum' });
    return D.costs.find((c) => c.account_id === 'JH-3M-02').note === '[billing:12:1500][stopped:2026-08-20] mine';
  })(), D.costs.find((c) => c.account_id === 'JH-3M-02').note);

  section('refusals');
  reset();
  ok('an unknown mode is refused', (await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'JH-3M-02', drop: jioDrop, mode: 'average' })).status === 400);
  ok('"add them up" with only one row is refused', (await POST('/admin/api/profit/cost/merge', { service: 'SonyLIV', accountId: 'SL-02', drop: [], mode: 'sum' })).status === 400);
  ok('a manual amount that is not a number is refused', (await POST('/admin/api/profit/cost/merge', { service: 'SonyLIV', accountId: 'SL-02', drop: [], mode: 'manual', amount: 'lots', every: 12 })).status === 400);
  ok('a silly billing period is refused', (await POST('/admin/api/profit/cost/merge', { service: 'SonyLIV', accountId: 'SL-02', drop: [], mode: 'manual', amount: 100, every: 7 })).status === 400);
  ok('a cost row that has gone is a 404, not a wrong number', (await POST('/admin/api/profit/cost/merge', { service: 'JioHotstar', accountId: 'GONE', drop: jioDrop, mode: 'sum' })).status === 404);
  ok('nothing was changed by any refusal', D.costs.filter((c) => /^JH-/.test(c.account_id)).length === 5);
  ok('wrong admin key → 403', (await fetch(base + '/admin/api/profit/cost/merge', { method: 'POST', headers: { 'X-Admin-Key': 'nope', 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
  ok('every statement touched a single table', !D.sql.some((x) => /\bJOIN\b/i.test(x) && !ORDERS_JOIN.test(x)));

  section('the panel');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline script parses', scripts.length > 0 && parsed);
  ok('the merge dialog asks how the rows relate, in the owner\'s words', /function pfMergeDialog\(/.test(html) &&
    /Same cost typed on each row \(duplicates\)/.test(html) && /I split the real cost across the rows/.test(html) && /Enter the real cost myself/.test(html));
  ok('it shows the ₹ for both answers before anything is saved', /Keep one row → /.test(html) && /Add them up → /.test(html) && /id="pfmgpv"/.test(html) && /This login will cost </.test(html));
  ok('the suggestion is pre-picked and explained', /sg\.mode === 'keep'/.test(html) && /sg\.mode === 'sum'/.test(html) && /💡 ' \+ esc\(sg\.why\)/.test(html));
  ok('it says what the other logins of that service pay', /login' \+ \(a\.typical\.logins === 1/.test(html) && /cost about <b>/.test(html));
  ok('the low-cost flag links to the same dialog', /looks low next to your other /.test(html) && /Did you divide the cost across the rows\?/.test(html) && /Fix it →/.test(html) && /a\.lowCost \?/.test(html));
  ok('the duplicate warning no longer assumes duplicates', /Are they the same cost typed /.test(html) && /or one cost you divided between the rows\?/.test(html));
  ok('the cost KPI counts the logins that look too cheap', /look' \+ \(t\.lowCostGroups === 1 \? 's' : ''\) \+ ' too cheap/.test(html));

  const pkg = require('../package.json');
  ok('this test is in npm test', /node test\/cost-split-across-rows\.test\.js/.test(pkg.scripts.test));
  const src = ['accountgroups.js', 'profit.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  ok('no schema change', !/CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(src) && /\[billing:/.test(src));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((x) => server.close(x));
  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
