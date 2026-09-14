/* Admin 🪙 Coins screen + the Save feedback fix. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const saved = {}; const calls = []; let spends = true;
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params: p });
    if (/coin_spends/.test(sql) && !spends) throw new Error("Table 'u.coin_spends' doesn't exist");
    if (/^SELECT value FROM app_settings/.test(sql)) return saved[p[0]] ? [{ value: saved[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { saved[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^SELECT 1 FROM/.test(sql)) return [];
    if (/COUNT\(DISTINCT phone_norm\) holders/.test(sql)) return [{ holders: 12, coins: 4300 }];
    if (/earned, COALESCE/.test(sql)) return [{ earned: 900, spent: 210 }];
    if (/FROM wallet w LEFT JOIN customers/.test(sql)) return [{ phone: '9876543210', name: 'Rahul', coins: 800 }];
    if (/FROM coins_ledger l LEFT JOIN customers/.test(sql)) return [{ ts: '2026-09-14 10:00:00', event: 'SPEND', order_id: 'FF1', phone: '9876543210', name: 'Rahul', coins_delta: -33, balance_after: 767, note: 'Used 33 coins' }];
    if (/FROM coin_spends WHERE status = 'HELD'/.test(sql)) return [{ n: 2, coins: 50 }];
    if (/FROM coin_spends WHERE status = 'SPENT'/.test(sql)) return [{ rupees: 210 }];
    if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
    return [];
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

(async () => {
  const express = require('express');
  const admin = require('../admin');
  const coins = require('../coins');
  let adjusted = null;
  const fakeCoins = Object.assign({}, coins, { adjust: async (a) => { adjusted = a; return Number(a.delta) ? { ok: true, change: Number(a.delta), balanceAfter: 150 } : { ok: false, message: 'Enter how many coins' }; }, maintain: async () => ({ ok: true, released: 1, settled: 0 }) });
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), coins: { coins: fakeCoins } });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const r = await fetch(base + p, { headers: h || H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  let r = await get('/admin/api/coins/settings', { 'Content-Type': 'application/json' });
  ok('needs admin sign-in', r.status === 401 || r.status === 403);
  r = await get('/admin/api/coins/settings');
  const ex = r.body.examples.find((e) => e.amount === 169);
  ok('settings + examples (₹169: earns 8, can pay 33 coins)', r.body.ok && r.body.settings.maxPercent === 20 && ex.earnNew === 8 && ex.spend.rupees === 33 && r.body.spendsReady === true, r.body);
  r = await post('/admin/api/coins/settings', Object.assign({}, coins.defaults(), { maxPercent: 150 }));
  ok('invalid → 400 with message', r.status === 400 && /maxPercent/.test(r.body.message));
  r = await post('/admin/api/coins/settings', Object.assign({}, coins.defaults(), { maxPercent: 25, coinValue: 0.5 }));
  await tick();
  const log = calls.filter((c) => /^INSERT INTO audit_log/.test(c.sql)).pop();
  ok('saved + change log shows before → after', r.body.ok && r.body.changed.includes('maxPercent') && JSON.parse(saved.coins).coinValue === 0.5 && log && log.params[0] === 'coins.settings' && /maxPercent 20 → 25/.test(log.params[3]));
  r = await get('/admin/api/coins/overview');
  ok('overview: wallets, month earned/used, held, top, recent', r.body.ok && r.body.coinsInWallets === 4300 && r.body.holders === 12 && r.body.spentMonth === 210 && r.body.held.coins === 50 && r.body.top[0].coins === 800 && r.body.recent[0].coins_delta === -33, r.body);
  spends = false;
  r = await get('/admin/api/coins/overview');
  ok('overview before schema-v16 still works', r.body.ok && r.body.spendsReady === false);
  spends = true;
  r = await post('/admin/api/coins/adjust', { phone: '9876543210', delta: 50, reason: 'sorry' });
  await tick();
  ok('add coins by hand + change log', r.body.ok && adjusted.delta === 50 && calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'coins.add'));
  r = await post('/admin/api/coins/adjust', { phone: '9876543210', delta: 0, reason: 'x' });
  ok('bad adjust → 400', r.status === 400);

  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel parses; Coins in the menu', parsed && /\['coins', '🪙', 'Coins'\]/.test(html) && /coins: coinsView/.test(html) && /id="cnadj"/.test(html));
  ok('Save bar sits above the phone bottom menu and shows the result on the button', /\.rf-save\{bottom:calc\(58px \+ env\(safe-area-inset-bottom\)\)\}/.test(html) && /btn\.textContent = '✅ Saved'/.test(html) && (html.match(/saveSettingsBtn\(\$\('#(rf|cn)save'\)/g) || []).length === 2);
  const cnSrc = (html.match(/function cnSpend\([\s\S]*?\n\}/) || [''])[0];
  const cfg = Object.assign(coins.defaults(), { maxPercent: 25, coinValue: 0.5 });
  const cnSpend = new Function('CN', cnSrc + '; return cnSpend;')({ s: cfg });
  ok('panel example maths = server maths', [39, 99, 169, 1849].every((a) => { const x = cnSpend(a); const y = coins.spendAllowed(cfg, 1e6, a, 'NEW'); return x.coins === y.coins && x.rupees === y.rupees; }));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
