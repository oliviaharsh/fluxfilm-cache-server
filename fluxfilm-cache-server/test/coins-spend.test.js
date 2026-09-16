/* Paying with coins at checkout: admin settings, quote, hold → spent / released, abandoned orders, expiry,
 * paying after release, renewals, admin add/remove, earning from settings, history. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let T; let spendsTable = true; let settingsTable = true;
const reset = () => { T = { settings: {}, wallet: [], ledger: [], spends: [], orders: [], plans: [{ service: 'Netflix', plan: 'Private 1M', price: 169 }, { service: 'Prime Video', plan: '1 Month', price: 39 }], subs: [] }; };
reset();
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
const noTable = (n) => { const e = new Error("Table 'u." + n + "' doesn't exist"); throw e; };
const walletOf = (ph) => T.wallet.filter((w) => w.phone_norm === ph).sort((a, b) => b.coins_lifetime - a.coins_lifetime)[0];
const bal = (ph) => (walletOf(ph) || { coins_balance: 0 }).coins_balance;
const setBal = (ph, n) => { const w = walletOf(ph); if (w) { w.coins_balance = n; w.coins_lifetime = Math.max(w.coins_lifetime, n); } else T.wallet.push({ phone: ph, phone_norm: ph, coins_balance: n, coins_lifetime: n }); };

async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  if (/app_settings/.test(sql) && !settingsTable) noTable('app_settings');
  if (/coin_spends/.test(sql) && !spendsTable) noTable('coin_spends');
  if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return T.settings[p[0]] ? [{ value: T.settings[p[0]] }] : [];
  if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  if (/^SELECT 1 FROM coin_spends/.test(sql) || /^SELECT 1 FROM app_settings/.test(sql)) return [];
  if (/^SELECT coins_balance FROM wallet WHERE phone_norm = \? ORDER BY/.test(sql)) { const w = walletOf(p[0]); return w ? [{ coins_balance: w.coins_balance }] : []; }
  if (/^SELECT order_id, phone_norm, coins FROM coin_spends WHERE order_id = \? AND status = 'HELD'/.test(sql)) return T.spends.filter((x) => x.order_id === p[0] && x.status === 'HELD').map((x) => ({ ...x }));
  if (/^SELECT order_id, phone_norm, coins, status FROM coin_spends WHERE order_id = \? AND status IN/.test(sql)) return T.spends.filter((x) => x.order_id === p[0] && ['HELD', 'RELEASED'].includes(x.status)).map((x) => ({ ...x }));
  if (/^SELECT cs\.order_id FROM coin_spends cs LEFT JOIN orders o ON o\.order_id = cs\.order_id WHERE cs\.status = 'HELD' AND cs\.created_at < NOW\(\) - INTERVAL \? HOUR/.test(sql)) return T.spends.filter((x) => x.status === 'HELD' && x.created_at < hoursAgo(p[0]) && !T.orders.some((o) => o.order_id === x.order_id && o.status === 'PAID'));
  if (/^SELECT cs\.order_id FROM coin_spends cs JOIN orders o ON o\.order_id = cs\.order_id WHERE cs\.status IN \('HELD', 'RELEASED'\) AND UPPER\(o\.status\) = 'PAID'/.test(sql)) return T.spends.filter((x) => ['HELD', 'RELEASED'].includes(x.status) && T.orders.some((o) => o.order_id === x.order_id && o.status === 'PAID'));
  if (/^SELECT ts, event, order_id, coins_delta, balance_after FROM coins_ledger WHERE phone_norm = \?/.test(sql)) return T.ledger.filter((l) => l.phone_norm === p[0]).slice().reverse().map((l) => ({ ts: '2026-09-14 10:00:00', event: l.event, order_id: l.order_id, coins_delta: l.delta, balance_after: l.balance_after }));
  if (/^SELECT price, duration_days, is_active, raw_json FROM plans/.test(sql)) return T.plans.filter((x) => x.service === p[0] && x.plan === p[1]).map((x) => ({ price: x.price, duration_days: 30, is_active: 'TRUE', raw_json: '{}' }));
  if (/^INSERT INTO orders/.test(sql)) { if (T.failOrderInsert) { T.failOrderInsert = false; throw new Error('Deadlock found'); } T.orders.push({ order_id: p[0], phone_norm: p[7], discount: p[9], price: p[10], final_amount: p[11], status: 'CREATED', raw: JSON.parse(p[p.length - 1]) }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, final_amount, status, source FROM orders/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map((o) => ({ ...o, source: 'node' }));
  if (/FROM subscriptions s LEFT JOIN|FROM subscriptions WHERE sub_id = \?/.test(sql)) return T.subs.filter((x) => x.sub_id === p[0]);
  return [];
}
const mockDb = {
  ENABLED: true, query: q, ping: async () => ({ ok: true }),
  getPool: () => ({ getConnection: async () => ({
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, p) => {
      sql = sql.replace(/\s+/g, ' ').trim();
      if (/coin_spends/.test(sql) && !spendsTable) noTable('coin_spends');
      if (/^SELECT status, coupon_code/.test(sql)) return [T.orders.filter((o) => o.order_id === p[0])];
      // _markPaid also writes raw_json (💸 PaidVia) when it can be read; the order id is always the LAST parameter.
      if (/^UPDATE orders SET status = \?/.test(sql)) { const o = T.orders.find((x) => x.order_id === p[p.length - 1]); if (o) o.status = 'PAID'; return [{ affectedRows: 1 }]; }
      if (/^SELECT phone, coins_balance FROM wallet WHERE phone_norm = \? ORDER BY .* FOR UPDATE/.test(sql)) { const w = walletOf(p[0]); return [w ? [{ phone: w.phone, coins_balance: w.coins_balance }] : []]; }
      if (/^INSERT IGNORE INTO wallet/.test(sql)) { if (!T.wallet.some((x) => x.phone === p[0])) T.wallet.push({ phone: p[0], phone_norm: p[1], coins_balance: 0, coins_lifetime: 0 }); return [{ affectedRows: 1 }]; }
      if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = \?/.test(sql)) return [T.ledger.filter((x) => x.order_id === p[0] && x.event === p[1])];
      if (/^UPDATE wallet SET coins_balance = coins_balance \+ \?, coins_lifetime = coins_lifetime \+ \?, last_earned_at/.test(sql)) { const w = T.wallet.find((x) => x.phone === p[3]); w.coins_balance += p[0]; w.coins_lifetime += p[1]; return [{ affectedRows: 1 }]; }
      if (/^UPDATE wallet SET coins_balance = coins_balance \+ \?, coins_lifetime = coins_lifetime \+ \?, last_event/.test(sql)) { const w = T.wallet.find((x) => x.phone === p[3]); w.coins_balance += p[0]; w.coins_lifetime += p[1]; return [{ affectedRows: 1 }]; }
      if (/^UPDATE wallet SET coins_balance = coins_balance \+ \? WHERE phone = \?/.test(sql)) { const w = T.wallet.find((x) => x.phone === p[1]); w.coins_balance += p[0]; return [{ affectedRows: 1 }]; }
      if (/^UPDATE wallet SET coins_balance = coins_balance - \?/.test(sql)) { const w = T.wallet.find((x) => x.phone === p[p.length - 1]); w.coins_balance -= p[0]; return [{ affectedRows: 1 }]; }
      if (/^SELECT cs\.order_id, cs\.coins FROM coin_spends cs LEFT JOIN orders o/.test(sql)) return [T.spends.filter((x) => x.phone_norm === p[0] && x.status === 'HELD' && !T.orders.some((o) => o.order_id === x.order_id && o.status === 'PAID')).map((x) => ({ ...x }))];
      if (/^UPDATE coin_spends SET status = 'RELEASED'/.test(sql)) { const r = T.spends.find((x) => x.order_id === p[1] && x.status === 'HELD'); if (r) { r.status = 'RELEASED'; r.note = p[0]; } return [{ affectedRows: r ? 1 : 0 }]; }
      if (/^INSERT INTO coin_spends/.test(sql)) { T.spends.push({ order_id: p[0], phone_norm: p[1], coins: p[2], rupees: p[3], status: 'HELD', created_at: new Date() }); return [{ affectedRows: 1 }]; }
      if (/^UPDATE coin_spends SET status = 'SPENT'/.test(sql)) { const r = T.spends.find((x) => x.order_id === p[1] && x.status === p[2]); if (r) { r.status = 'SPENT'; r.note = p[0]; } return [{ affectedRows: r ? 1 : 0 }]; }
      if (/^INSERT INTO coins_ledger/.test(sql)) { T.ledger.push({ event: p[0], order_id: p[1], phone_norm: p[2], delta: p[6], balance_after: p[7], note: p[8] }); return [{ affectedRows: 1 }]; }
      return [[]];
    },
  }) }),
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null }; return orig.apply(this, arguments); }; })(Module._load);

const coins = require('../coins');
const order = require('../order');
const tick = () => new Promise((r) => setTimeout(r, 30));
const P = '9876543210';
const buy = (extra, plan) => order.createOrder(Object.assign({ service: plan === 'prime' ? 'Prime Video' : 'Netflix', plan: plan === 'prime' ? '1 Month' : 'Private 1M', name: 'Rahul', email: 'r@x.in', phone: P }, extra || {}));

(async () => {
  section('settings (admin panel)');
  let cfg = await coins.getSettings(true);
  ok('defaults: spend on, 1 coin = ₹1, max 20%, min 20 coins, hold 24h, earn 5 per ₹100', cfg.spendEnabled && cfg.coinValue === 1 && cfg.maxPercent === 20 && cfg.minCoins === 20 && cfg.holdHours === 24 && cfg.earnPer100 === 5);
  let r = await coins.saveSettings({ coinValue: 0 });
  ok('1 coin must be worth something', !r.ok && /coinValue/.test(r.message));
  r = await coins.saveSettings({ maxPercent: 30, earnPer100: 10 });
  cfg = await coins.getSettings(true);
  ok('saved values used straight away', r.ok && cfg.maxPercent === 30 && cfg.earnPer100 === 10);
  ok('earning uses the saved rate', coins.computeCoins('NEW_PURCHASE', 169, cfg) === 16 && coins.computeCoins('RENEW', 99, Object.assign({}, cfg, { earnRenewMultiplier: 2 })) === 18);
  T.settings = {}; await coins.getSettings(true);

  section('limits');
  cfg = await coins.getSettings(true);
  ok('₹169 with 500 coins → 20% = 33 coins = ₹33', JSON.stringify(coins.spendAllowed(cfg, 500, 169, 'NEW')) === JSON.stringify({ coins: 33, rupees: 33 }));
  ok('never more than the balance', coins.spendAllowed(cfg, 25, 1849, 'NEW').coins === 25);
  ok('below the minimum balance → not allowed', coins.spendAllowed(cfg, 19, 169, 'NEW').reason === 'min');
  ok('coin worth ₹0.5: ₹33 needs 66 coins', JSON.stringify(coins.spendAllowed(Object.assign({}, cfg, { coinValue: 0.5 }), 500, 169, 'NEW')) === JSON.stringify({ coins: 66, rupees: 33 }));
  ok('renewals switched off → not allowed there', coins.spendAllowed(Object.assign({}, cfg, { spendOnRenew: false }), 500, 169, 'RENEW').reason === 'not on renewals');
  ok('switched off → nothing', coins.spendAllowed(Object.assign({}, cfg, { spendEnabled: false }), 500, 169, 'NEW').coins === 0);

  section('quote (storefront "Use 33 coins → −₹33")');
  setBal(P, 120);
  r = await coins.quoteSpend(P, 169, 'NEW');
  ok('quote shows balance, coins, rupees and rules', r.ok && r.enabled && r.balance === 120 && r.coins === 33 && r.rupees === 33 && r.rules.maxPercent === 20, r);

  section('checkout with coins: held → paid → kept');
  const o1 = await buy({ useCoins: true });
  const row1 = T.orders.find((x) => x.order_id === o1.orderId);
  ok('₹169 − ₹33 coins = ₹136; order records coins + total discount', o1.ok && o1.amount === 136 && o1.coinsUsed === 33 && row1.discount === 33 && row1.raw.CoinsUsed === 33 && row1.raw.CoinsDiscount === 33, o1);
  ok('coins taken from the wallet at once (HELD) with a history line', bal(P) === 87 && T.spends[0].status === 'HELD' && T.ledger.some((l) => l.event === 'SPEND' && l.delta === -33 && l.balance_after === 87));
  await order.adminMarkPaid(o1.orderId, 'UPI'); await tick();
  ok('order paid → SPENT, balance stays', T.spends[0].status === 'SPENT' && bal(P) === 87);
  const noCoins = await buy({});
  ok('without ticking "use coins" nothing is taken', noCoins.amount === 169 && bal(P) === 87 && T.spends.length === 1);

  section('abandoned order → new order gives the coins back first');
  setBal(P, 100);
  const a1 = await buy({ useCoins: true });
  ok('first try holds 33', bal(P) === 67 && T.spends.find((x) => x.order_id === a1.orderId).status === 'HELD');
  const a2 = await buy({ useCoins: true });
  ok('second try: old hold released (+33), new hold 33 → still 67, not 34', bal(P) === 67 && T.spends.find((x) => x.order_id === a1.orderId).status === 'RELEASED' && T.spends.find((x) => x.order_id === a2.orderId).status === 'HELD' && a2.amount === 136, { bal: bal(P), spends: T.spends });
  await order.adminMarkPaid(a1.orderId, 'UPI'); await tick();
  ok('if they pay the OLD order anyway, its coins are taken again', T.spends.find((x) => x.order_id === a1.orderId).status === 'SPENT' && bal(P) === 34 && T.ledger.filter((l) => l.order_id === a1.orderId && l.event === 'SPEND').length === 2, { bal: bal(P), spend: T.spends.find((x) => x.order_id === a1.orderId), led: T.ledger.filter((l) => l.order_id === a1.orderId) });

  section('never paid → coins back after holdHours');
  reset(); setBal(P, 50);
  const e1 = await buy({ useCoins: true }, 'prime'); // ₹39 → 20% = 7 coins, but min balance 20 ok
  ok('₹39 order holds 7 coins', e1.coinsUsed === 7 && bal(P) === 43);
  T.spends[0].created_at = hoursAgo(25);
  r = await coins.maintain();
  ok('maintain gives them back (RELEASED) once', r.released === 1 && bal(P) === 50 && T.spends[0].status === 'RELEASED');
  r = await coins.maintain();
  ok('running again does nothing', r.released === 0 && bal(P) === 50);
  const e2 = await buy({ useCoins: true }, 'prime');
  const o = T.orders.find((x) => x.order_id === e2.orderId); o.status = 'PAID'; // paid, but the hook never ran
  r = await coins.maintain();
  ok('paid order still HELD gets settled by maintain', r.settled === 1 && T.spends.find((x) => x.order_id === e2.orderId).status === 'SPENT');

  section('can\'t use coins');
  reset(); setBal(P, 10);
  let x = await buy({ useCoins: true });
  ok('below minimum: full price + message, nothing taken', x.ok && x.amount === 169 && !x.coinsUsed && /at least 20/.test(x.coinsMessage) && bal(P) === 10);
  setBal(P, 500); T.failOrderInsert = true;
  let threw = false; try { await buy({ useCoins: true }); } catch (err) { threw = true; }
  await tick();
  ok('order could not be saved → held coins given straight back', threw && bal(P) === 500 && T.spends[0].status === 'RELEASED', { bal: bal(P), spends: T.spends });
  spendsTable = false; coins._internal.resetCache();
  x = await buy({ useCoins: true });
  ok('before schema-v16: checkout works, full price', x.ok && x.amount === 169 && !x.coinsUsed);
  r = await coins.quoteSpend(P, 169, 'NEW');
  ok('before schema-v16: storefront hides the option', r.ok && r.enabled === false);
  spendsTable = true;
  const quick = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'R', email: 'r@x.in', phone: P, useCoins: true }, { amountOverride: 120 });
  ok('admin quick orders never use coins', quick.amount === 120 && !quick.coinsUsed);

  section('admin add / remove coins');
  reset();
  r = await coins.adjust({ phone: '98765 43210', delta: 50, reason: 'sorry for the delay' });
  ok('add 50 (logged)', r.ok && r.change === 50 && bal(P) === 50 && T.ledger[0].event === 'ADMIN_ADJUST' && T.ledger[0].note === 'sorry for the delay');
  r = await coins.adjust({ phone: P, delta: -80, reason: 'fix' });
  ok('removing more than they have stops at 0', r.ok && r.change === -50 && bal(P) === 0);
  ok('reason required', !(await coins.adjust({ phone: P, delta: 5, reason: '' })).ok);

  section('history (Wallet page)');
  r = await coins.history(P);
  ok('latest first, friendly labels, admin ids hidden', r.ok && r.items[0].coins === -50 && r.items[0].label === 'Adjusted by FluxFilm' && r.items[0].orderId === '');

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
