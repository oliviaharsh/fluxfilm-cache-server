/* Admin 🎁 Referrals screen: settings API (validated, saved, change log), overview, fix missed rewards. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

let schema = true;
const saved = {};
const calls = [];
const noTable = () => { const e = new Error("Table 'u.app_settings' doesn't exist"); throw e; };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params: p });
    if (/app_settings|referral/.test(sql) && !schema) noTable();
    if (/^SELECT value FROM app_settings/.test(sql)) return saved.referral ? [{ value: saved.referral }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { saved[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^SELECT 1 FROM app_settings/.test(sql)) return [];
    if (/^SELECT status, COUNT\(\*\) n FROM referrals GROUP BY status/.test(sql)) return [{ status: 'PENDING', n: 2 }, { status: 'REWARDED', n: 5 }, { status: 'NOT_NEW', n: 1 }];
    if (/^SELECT kind, status, COUNT\(\*\) n/.test(sql)) return [{ kind: 'FIRST', status: 'PAID', n: 5, coins: 90 }, { kind: 'REPEAT', status: 'PAID', n: 3, coins: 20 }, { kind: 'FIRST', status: 'FAILED', n: 1, coins: 15 }];
    if (/^SELECT COUNT\(\*\) n, COALESCE\(SUM\(coins\), 0\) coins FROM referral_rewards WHERE status = 'PAID' AND paid_at/.test(sql)) return [{ n: 4, coins: 60 }];
    if (/WHERE rr.status = 'FAILED' OR/.test(sql)) return [{ order_id: 'FF1', kind: 'FIRST', coins: 15, status: 'FAILED', reason: 'Lock wait timeout', beneficiary_phone: '9876543210', name: 'Rahul' }];
    if (/ORDER BY rr.created_at DESC LIMIT 40/.test(sql)) return [];
    if (/GROUP BY rr.beneficiary_phone/.test(sql)) return [{ phone: '9876543210', name: 'Rahul', friends: 3, coins: 110 }];
    if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
    return [];
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

(async () => {
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  let reconcileCalls = 0;
  const referrals = require('../referrals');
  const fakeRef = Object.assign({}, referrals, { reconcile: async (o) => { reconcileCalls++; return { ok: true, paid: 1, failed: 0, checkedOrders: 2, days: o.days }; } });
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), referrals: { referrals: fakeRef } });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const r = await fetch(base + p, { headers: h || H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  let r = await get('/admin/api/referrals/settings', { 'Content-Type': 'application/json' });
  ok('needs admin sign-in', r.status === 401 || r.status === 403, r.status);
  r = await get('/admin/api/referrals/settings');
  const ex169 = r.body.examples.find((e) => e.amount === 169);
  ok('settings + examples (₹169 → 17 / 8 / 5 coins)', r.body.ok && r.body.settings.firstPercent === 10 && ex169.first === 17 && ex169.repeat === 8 && ex169.level2 === 5 && r.body.needsSchema === false, r.body);
  r = await post('/admin/api/referrals/settings', { firstPercent: 150 });
  ok('invalid value → 400 with message, nothing saved', r.status === 400 && /firstPercent/.test(r.body.message) && !saved.referral);
  r = await post('/admin/api/referrals/settings', Object.assign({}, referrals.DEFAULTS, { firstPercent: 15, friendDiscount: 30 }));
  await tick();
  const log = calls.filter((c) => /^INSERT INTO audit_log/.test(c.sql)).pop();
  ok('saved to the database + change log lists what changed', r.body.ok && JSON.parse(saved.referral).firstPercent === 15 && r.body.changed.includes('firstPercent') && log && log.params[0] === 'referral.settings' && /firstPercent 10 → 15/.test(log.params[3]) && /friendDiscount 20 → 30/.test(log.params[3]), { body: r.body, log: log && log.params });
  r = await get('/admin/api/referrals/settings');
  ok('new values come back (live)', r.body.settings.firstPercent === 15 && r.body.settings.friendDiscount === 30);
  r = await get('/admin/api/referrals/overview');
  ok('overview: invited, joined, coins, month, problems, top', r.body.ok && r.body.invited === 8 && r.body.waiting === 2 && r.body.joined === 5 && r.body.coinsPaid === 110 && r.body.month.coins === 60 && r.body.problems.length === 1 && r.body.top[0].coins === 110, r.body);
  r = await post('/admin/api/referrals/reconcile', { days: 90 });
  await tick();
  ok('fix missed rewards runs + is logged', r.body.ok && r.body.paid === 1 && reconcileCalls === 1 && calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'referral.reconcile'));
  schema = false; referrals._internal.resetCache();
  r = await get('/admin/api/referrals/settings');
  ok('before schema-v15: settings show defaults + needsSchema', r.body.ok && r.body.needsSchema === true && r.body.settings.firstPercent === 10);
  r = await post('/admin/api/referrals/settings', { firstPercent: 12 });
  ok('saving before schema-v15 → 409 with the fix', r.status === 409 && /schema-v15/.test(r.body.message));
  r = await get('/admin/api/referrals/overview');
  ok('overview before schema-v15 does not crash', r.body.ok && r.body.needsSchema === true);
  schema = true;

  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel parses; Referrals in the menu with settings + fix button', parsed && /\['referrals', '🎁', 'Referrals'\]/.test(html) && /referrals: referralsView/.test(html) && /id="rffix"/.test(html) && /data-rf="level2Enabled"/.test(html) && /function rfCoins\(/.test(html));
  const rfSrc = (html.match(/function rfCoins\([\s\S]*?\n\}/) || [''])[0];
  const rfCoins = new Function(rfSrc + '; return rfCoins;')();
  ok('panel example maths = server maths', [[169, 10, 5, 100], [39, 10, 5, 100], [1849, 10, 5, 100], [0, 10, 5, 100], [500, 3, 2, 0]].every((a) => rfCoins(...a) === referrals.coinsFor(...a)));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
