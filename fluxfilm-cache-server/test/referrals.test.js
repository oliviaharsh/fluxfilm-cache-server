/* Refer & earn: admin settings, invite codes, friend discount, % coins for the referrer on the friend's first and
 * next orders, 2-level chain, reliable coins (locked wallet), and "fix missed rewards".
 * Run: npm test  (in-memory fake database, no MySQL needed) */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------- tiny in-memory database ----------------
const pad = (n) => String(n).padStart(2, '0');
let clock = Date.parse('2026-09-14T10:00:00+05:30');
const nowStr = () => { const d = new Date(clock); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const later = (min) => { clock += min * 60e3; };
let tablesExist = true;
let T;
const reset = () => { T = { settings: {}, customers: [], orders: [], codes: [], refs: [], rewards: [], wallet: [], ledger: [], plans: [{ service: 'Netflix', plan: 'Private 1M', price: 169 }, { service: 'Prime Video', plan: '1 Month', price: 39 }] }; };
reset();
let nextId = 1;
const noTable = () => { const e = new Error("Table 'u.referral_rewards' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };
const paidAt = (o) => o.verified_at || o.created_at_sheet;
const REFT = /app_settings|referral_codes|referrals|referral_rewards/;

async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  if (REFT.test(sql) && !tablesExist) noTable();
  // settings
  if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return T.settings[p[0]] ? [{ value: T.settings[p[0]] }] : [];
  if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  if (/^SELECT 1 FROM app_settings/.test(sql)) return [];
  // plans / customers
  if (/^SELECT price, duration_days, is_active, raw_json FROM plans/.test(sql)) return T.plans.filter((x) => x.service === p[0] && x.plan === p[1]).map((x) => ({ price: x.price, duration_days: 30, is_active: 'TRUE', raw_json: '{}' }));
  if (/^SELECT 1 FROM customers WHERE phone_norm = \?/.test(sql) || /^SELECT name FROM customers WHERE phone_norm = \?/.test(sql)) return T.customers.filter((x) => x.phone_norm === p[0]);
  // codes
  if (/^SELECT code FROM referral_codes WHERE phone_norm = \?/.test(sql)) return T.codes.filter((x) => x.phone_norm === p[0]);
  if (/^INSERT INTO referral_codes/.test(sql)) { if (T.codes.some((x) => x.code === p[1])) throw new Error('Duplicate entry'); T.codes.push({ phone_norm: p[0], code: p[1] }); return { affectedRows: 1 }; }
  if (/^SELECT phone_norm FROM referral_codes WHERE code = \?/.test(sql)) return T.codes.filter((x) => x.code === p[0]);
  // orders
  if (/^SELECT 1 FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' LIMIT 1/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID');
  if (/^INSERT INTO orders/.test(sql)) { T.orders.push({ order_id: p[0], phone_norm: p[7], discount: p[9], price: p[10], final_amount: p[11], status: 'CREATED', service: p[1], plan: p[2], created_at_sheet: nowStr(), raw: JSON.parse(p[p.length - 1]) }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, final_amount, status, source FROM orders/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map((o) => ({ ...o, source: 'node' }));
  if (/^SELECT order_id, phone_norm, service, plan, final_amount, status, COALESCE\(verified_at, created_at_sheet\) paid_at FROM orders WHERE order_id = \?/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map((o) => ({ ...o, paid_at: paidAt(o) }));
  if (/^SELECT order_id, COALESCE\(verified_at, created_at_sheet\) paid_at FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' ORDER BY/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID').map((o) => ({ order_id: o.order_id, paid_at: paidAt(o) })).sort((a, b) => a.paid_at < b.paid_at ? -1 : a.paid_at > b.paid_at ? 1 : (a.order_id < b.order_id ? -1 : 1));
  if (/^INSERT INTO coupon_usage/.test(sql)) return { affectedRows: 1 };
  // referrals
  if (/^SELECT status FROM referrals WHERE friend_phone = \?/.test(sql)) return T.refs.filter((r) => r.friend_phone === p[0]);
  if (/^SELECT id, referrer_phone, status, created_at FROM referrals WHERE friend_phone = \?/.test(sql)) return T.refs.filter((r) => r.friend_phone === p[0]);
  if (/^SELECT referrer_phone, status FROM referrals WHERE friend_phone = \?/.test(sql)) return T.refs.filter((r) => r.friend_phone === p[0]);
  if (/^SELECT friend_phone, status, created_at, rewarded_at FROM referrals WHERE referrer_phone = \?/.test(sql)) return T.refs.filter((r) => r.referrer_phone === p[0]);
  if (/^INSERT INTO referrals/.test(sql)) {
    const ex = T.refs.find((r) => r.friend_phone === p[2]);
    if (ex) { if (ex.status === 'PENDING') Object.assign(ex, /code = IF\(/.test(sql) ? { code: p[0], referrer_phone: p[1] } : {}, { friend_order_id: p[3], discount: p[4] }); return { affectedRows: 2 }; }
    T.refs.push({ id: nextId++, code: p[0], referrer_phone: p[1], friend_phone: p[2], status: 'PENDING', friend_order_id: p[3], discount: p[4], created_at: nowStr() }); return { affectedRows: 1 };
  }
  if (/^UPDATE referrals SET status = 'NOT_NEW'/.test(sql)) { const r = T.refs.find((x) => x.id === p[0] && x.status === 'PENDING'); if (r) r.status = 'NOT_NEW'; return { affectedRows: r ? 1 : 0 }; }
  if (/^UPDATE referrals SET status = \?, friend_order_id = \?, reward_coins = \?/.test(sql)) { const r = T.refs.find((x) => x.id === p[3] && x.status === 'PENDING'); if (!r) return { affectedRows: 0 }; Object.assign(r, { status: p[0], friend_order_id: p[1], reward_coins: p[2] }); return { affectedRows: 1 }; }
  // rewards
  if (/^INSERT IGNORE INTO referral_rewards/.test(sql)) {
    if (T.rewards.some((x) => x.order_id === p[0] && x.beneficiary_phone === p[2] && x.kind === p[3])) return { affectedRows: 0 };
    T.rewards.push({ order_id: p[0], friend_phone: p[1], beneficiary_phone: p[2], kind: p[3], order_amount: p[4], percent: p[5], coins: p[6], status: p[7], reason: p[8], created_at: nowStr() }); return { affectedRows: 1 };
  }
  if (/^UPDATE referral_rewards SET status = 'PAID'/.test(sql)) { const r = T.rewards.find((x) => x.order_id === p[0] && x.beneficiary_phone === p[1] && x.kind === p[2]); if (r) { r.status = 'PAID'; r.reason = null; } return { affectedRows: r ? 1 : 0 }; }
  if (/^UPDATE referral_rewards SET status = 'FAILED'/.test(sql)) { const r = T.rewards.find((x) => x.order_id === p[1] && x.beneficiary_phone === p[2] && x.kind === p[3]); if (r) { r.status = 'FAILED'; r.reason = p[0]; } return { affectedRows: r ? 1 : 0 }; }
  if (/^SELECT COUNT\(\*\) n FROM referral_rewards WHERE beneficiary_phone = \? AND kind = 'FIRST'/.test(sql)) return [{ n: T.rewards.filter((x) => x.beneficiary_phone === p[0] && x.kind === 'FIRST' && ['PAID', 'PENDING', 'FAILED'].includes(x.status)).length }];
  if (/^SELECT friend_phone, kind, coins FROM referral_rewards WHERE beneficiary_phone = \? AND status = 'PAID'/.test(sql)) return T.rewards.filter((x) => x.beneficiary_phone === p[0] && x.status === 'PAID');
  if (/^SELECT rr\.order_id, rr\.friend_phone, rr\.beneficiary_phone, rr\.kind, rr\.coins, o\.service/.test(sql)) return T.rewards.filter((x) => x.coins > 0 && (x.status === 'FAILED' || (x.status === 'PENDING' && x.stale))).map((x) => ({ ...x, amount: 0 }));
  if (/^SELECT o\.order_id FROM orders o JOIN referrals r ON r\.friend_phone = o\.phone_norm/.test(sql)) return T.orders.filter((o) => o.status === 'PAID' && T.refs.some((r) => r.friend_phone === o.phone_norm) && !T.rewards.some((x) => x.order_id === o.order_id)).sort((a, b) => paidAt(a) < paidAt(b) ? -1 : 1).map((o) => ({ order_id: o.order_id }));
  return [];
}
// Connection: _markPaid (orders) + coins.awardCoins (wallet lock + ledger). FOR UPDATE on wallet = a per-phone mutex.
const locks = new Map();
const lockPhone = (ph) => { const prev = locks.get(ph) || Promise.resolve(); let release; const next = new Promise((r) => { release = r; }); locks.set(ph, prev.then(() => next)); return prev.then(() => release); };
let coinsFailNext = 0;
const mockDb = {
  ENABLED: true, query: q, ping: async () => ({ ok: true }),
  getPool: () => ({ getConnection: async () => {
    const held = [];
    return {
      beginTransaction: async () => {}, rollback: async () => { held.splice(0).forEach((r) => r()); },
      commit: async () => { held.splice(0).forEach((r) => r()); }, release: () => { held.splice(0).forEach((r) => r()); },
      query: async (sql, p) => {
        sql = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT status, coupon_code/.test(sql)) return [T.orders.filter((o) => o.order_id === p[0])];
        // _markPaid also writes raw_json (💸 PaidVia) when it can be read; the order id is always the LAST parameter.
        if (/^UPDATE orders SET status = \?/.test(sql)) { const o = T.orders.find((x) => x.order_id === p[p.length - 1]); if (o) { o.status = 'PAID'; o.verified_at = nowStr(); if (p.length === 4) o.raw_json = p[2]; } return [{ affectedRows: 1 }]; }
        if (/^SELECT phone, coins_balance FROM wallet WHERE phone_norm = \? ORDER BY coins_lifetime DESC, coins_balance DESC LIMIT 1 FOR UPDATE/.test(sql)) {
          if (!held.length) held.push(await lockPhone(p[0]));
          await new Promise((r) => setTimeout(r, 2)); // let a parallel award try to interleave
          const w = T.wallet.filter((x) => x.phone_norm === p[0]).sort((a, b) => b.coins_lifetime - a.coins_lifetime)[0];
          return [w ? [{ phone: w.phone, coins_balance: w.coins_balance }] : []];
        }
        if (/^INSERT IGNORE INTO wallet/.test(sql)) { if (!T.wallet.some((x) => x.phone === p[0])) T.wallet.push({ phone: p[0], phone_norm: p[1], coins_balance: 0, coins_lifetime: 0 }); return [{ affectedRows: 1 }]; }
        if (/^SELECT id FROM coins_ledger WHERE order_id = \? AND event = \?/.test(sql)) return [T.ledger.filter((x) => x.order_id === p[0] && x.event === p[1])];
        if (/^UPDATE wallet SET coins_balance = coins_balance \+ \?/.test(sql)) {
          if (coinsFailNext > 0) { coinsFailNext--; throw new Error('Lock wait timeout exceeded'); }
          const w = T.wallet.find((x) => x.phone === p[3]); w.coins_balance += p[0]; w.coins_lifetime += p[1]; return [{ affectedRows: 1 }];
        }
        if (/^INSERT INTO coins_ledger/.test(sql)) { T.ledger.push({ event: p[0], order_id: p[1], phone_norm: p[2], coins: p[6], balance_after: p[7], note: p[8] }); return [{ affectedRows: 1 }]; }
        return [[]];
      },
    };
  } }),
};
Module._load = (function (orig) {
  return function (req) {
    if (req === './db') return mockDb;
    if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null };
    return orig.apply(this, arguments);
  };
})(Module._load);

const referrals = require('../referrals');
const coins = require('../coins');
const order = require('../order');
const tick = () => new Promise((r) => setTimeout(r, 40));
const balance = (ph) => (T.wallet.filter((w) => w.phone_norm === ph).sort((a, b) => b.coins_lifetime - a.coins_lifetime)[0] || { coins_balance: 0 }).coins_balance;
const A = '9876543210', B = '9123456780', C = '9000022222', D = '9555511111';
const buy = (phone, extra, plan) => order.createOrder(Object.assign({ service: plan === 'prime' ? 'Prime Video' : 'Netflix', plan: plan === 'prime' ? '1 Month' : 'Private 1M', name: 'N', email: 'n@x.in', phone }, extra || {}));
const pay = async (id) => { later(5); await order.adminMarkPaid(id, 'UPI'); await tick(); };
const codeOf = async (ph) => { if (!T.customers.some((c) => c.phone_norm === ph)) T.customers.push({ phone_norm: ph, name: 'Cust ' + ph.slice(-2) }); return (await referrals.getReferralInfo(ph)).code; };
const rewardsFor = (ph) => T.rewards.filter((r) => r.beneficiary_phone === ph && r.kind !== 'NONE');

(async () => {
  section('settings (admin panel, stored in the database)');
  referrals._internal.resetCache();
  let cfg = await referrals.getSettings(true);
  ok('defaults before anything is saved', cfg.friendDiscount === 20 && cfg.firstPercent === 10 && cfg.repeatOrders === 2 && cfg.level2Enabled === true);
  let r = await referrals.saveSettings({ firstPercent: 'abc' });
  ok('bad number refused', !r.ok && /firstPercent/.test(r.message));
  r = await referrals.saveSettings({ firstMin: 50, firstMax: 10 });
  ok('max below min refused', !r.ok && /maximum/.test(r.message));
  r = await referrals.saveSettings({ friendDiscount: 25, firstPercent: 12.5, level2Enabled: 'false' });
  cfg = await referrals.getSettings(true);
  ok('saved values are used right away (no restart / Hostinger)', r.ok && cfg.friendDiscount === 25 && cfg.firstPercent === 12.5 && cfg.level2Enabled === false && cfg.repeatPercent === 5);
  T.settings = {}; await referrals.getSettings(true);
  ok('coins = % of amount within min..max', referrals.coinsFor(169, 10, 5, 100) === 17 && referrals.coinsFor(39, 10, 5, 100) === 5 && referrals.coinsFor(1849, 10, 5, 100) === 100 && referrals.coinsFor(0, 10, 5, 100) === 0 && referrals.coinsFor(500, 10, 0, 0) === 50);

  section('invite code + friend checks');
  const codeA = await codeOf(A);
  r = await referrals.getReferralInfo(A);
  ok('code + link + public rules', /^FF[A-Z2-9]{6}$/.test(codeA) && r.link.endsWith('/?ref=' + codeA) && r.rules.firstPercent === 10 && r.rules.repeatOrders === 2 && r.rules.level2Percent === 3);
  ok('no account → no code', !(await referrals.getReferralInfo('9444444444')).ok);
  r = await referrals.checkReferral(codeA.toLowerCase(), '');
  ok('valid code shows discount + first name only', r.ok && r.friendDiscount === 20 && r.referrerName === 'Cust' && !('referrerPhone' in r && r.referrerPhone !== A));
  ok("own code refused", (await referrals.checkReferral(codeA, A)).own === true);
  T.orders.push({ order_id: 'FFOLD', phone_norm: '9000011111', status: 'PAID', created_at_sheet: '2026-01-01 10:00:00', final_amount: 99 });
  ok('existing customer refused', (await referrals.checkReferral(codeA, '9000011111')).notNew === true);

  section('friend B: discount + % coins for A on first order');
  const o1 = await buy(B, { referralCode: codeA });
  ok('₹20 off, friend recorded', o1.ok && o1.amount === 149 && o1.referralApplied && T.refs.find((x) => x.friend_phone === B).status === 'PENDING');
  await pay(o1.orderId);
  let rw = rewardsFor(A);
  ok('A gets 10% of ₹149 = 15 coins (FIRST), paid into the wallet', rw.length === 1 && rw[0].kind === 'FIRST' && rw[0].coins === 15 && rw[0].status === 'PAID' && balance(A) === 15, { rw, bal: balance(A) });
  ok('ledger note hides the friend phone', T.ledger.some((l) => l.event === 'REFERRAL' && /91••••••80/.test(l.note)));
  await order.adminMarkPaid(o1.orderId, 'UPI'); await referrals.onOrderPaid(o1.orderId); await tick();
  ok('paying / checking again never pays twice', rewardsFor(A).length === 1 && balance(A) === 15);

  section('B buys 2 more (renewals count) → smaller coins; the 4th earns nothing');
  const o2 = await buy(B); await pay(o2.orderId);
  const o3 = await order.createOrder({ service: 'Prime Video', plan: '1 Month', name: 'B', email: 'b@x.in', phone: B }, { action: 'RENEW', renewSubId: 'SUB-9' }); await pay(o3.orderId);
  const o4 = await buy(B); await pay(o4.orderId);
  rw = rewardsFor(A);
  ok('2nd order ₹169 → 5% = 8 coins; 3rd (renewal ₹39) → min 2 coins; 4th → none', rw.length === 3 && rw[1].kind === 'REPEAT' && rw[1].coins === 8 && rw[2].kind === 'REPEAT' && rw[2].coins === 2 && balance(A) === 25, rw.map((x) => [x.kind, x.coins]));
  ok('4th order marked checked (so the missed-reward scan skips it)', T.rewards.some((x) => x.order_id === o4.orderId && x.kind === 'NONE'));

  section('2-level chain: B invites C → B gets FIRST, A gets LEVEL2 once');
  const codeB = await codeOf(B);
  const c1 = await buy(C, { referralCode: codeB }); await pay(c1.orderId);
  ok('B gets 10% of ₹149 = 15, A gets 3% of ₹149 = 4 (LEVEL2)', rewardsFor(B).length === 1 && rewardsFor(B)[0].coins === 15 && rewardsFor(A).filter((x) => x.kind === 'LEVEL2').length === 1 && rewardsFor(A).find((x) => x.kind === 'LEVEL2').coins === 4 && balance(A) === 29, { B: rewardsFor(B), A: rewardsFor(A) });
  const c2 = await buy(C); await pay(c2.orderId);
  ok("C's next order: B gets REPEAT, A gets nothing more", rewardsFor(B).filter((x) => x.kind === 'REPEAT').length === 1 && rewardsFor(A).filter((x) => x.kind === 'LEVEL2').length === 1);
  r = await referrals.getReferralInfo(A);
  ok("A's page: 1 invited, 1 joined, 29 coins (4 from friends' invites)", r.invited === 1 && r.joined === 1 && r.coinsEarned === 29 && r.level2Coins === 4 && r.friends[0].coins === 25, r);
  await referrals.saveSettings({ level2Enabled: false });
  const codeC = await codeOf(C);
  const d1 = await buy(D, { referralCode: codeC }); await pay(d1.orderId);
  ok('2-level switched off in admin → only the direct referrer is paid', rewardsFor(C).length === 1 && !T.rewards.some((x) => x.order_id === d1.orderId && x.kind === 'LEVEL2'));
  T.settings = {}; await referrals.getSettings(true);

  section('bug guard: coins failure → FAILED → "Fix missed rewards" pays it');
  reset(); nextId = 1; locks.clear();
  const codeA2 = await codeOf(A);
  const f1 = await buy(B, { referralCode: codeA2 });
  coinsFailNext = 1;
  await pay(f1.orderId);
  ok('reward saved as FAILED with the reason (not silently lost)', rewardsFor(A)[0].status === 'FAILED' && /Lock wait/.test(rewardsFor(A)[0].reason) && balance(A) === 0, rewardsFor(A));
  r = await referrals.reconcile({});
  ok('reconcile pays it once', r.ok && r.paid === 1 && rewardsFor(A)[0].status === 'PAID' && balance(A) === 15, { r, bal: balance(A) });
  r = await referrals.reconcile({});
  ok('running it again changes nothing', r.paid === 0 && balance(A) === 15);

  section('bug guard: payment recorded but the reward check never ran (e.g. restart)');
  const m1 = await buy(C, { referralCode: codeA2 });
  const mo = T.orders.find((x) => x.order_id === m1.orderId); mo.status = 'PAID'; mo.verified_at = nowStr(); // paid without the hook
  r = await referrals.reconcile({});
  ok('reconcile finds the paid order and pays the referrer', r.checkedOrders === 1 && r.paid === 1 && rewardsFor(A).length === 2 && balance(A) === 30, r);

  section('coins: two rewards for the same person at the same moment');
  reset(); locks.clear();
  await Promise.all([
    coins.awardCoins({ event: 'REFERRAL', orderId: 'X1', phone: A, coins: 10 }),
    coins.awardCoins({ event: 'REFERRAL', orderId: 'X2', phone: A, coins: 7 }),
    coins.awardCoins({ event: 'REFERRAL', orderId: 'X1', phone: A, coins: 10 }), // duplicate of the first
  ]);
  ok('both counted, duplicate ignored, one wallet row, ledger balances in order', balance(A) === 17 && T.wallet.length === 1 && T.ledger.length === 2 && T.ledger[1].balance_after === 17, { wallet: T.wallet, ledger: T.ledger });
  T.wallet.push({ phone: '+91 98765 43210', phone_norm: A, coins_balance: 100, coins_lifetime: 400 }); // old Sheet row, more history
  await coins.awardCoins({ event: 'NEW_PURCHASE', orderId: 'X3', phone: A, amount: 200 });
  ok('customer with 2 wallet rows: coins go to the main (most history) row', T.wallet.find((w) => w.phone === '+91 98765 43210').coins_balance === 110 && T.wallet.find((w) => w.phone === A).coins_balance === 17);

  section('abuse + limits');
  reset(); nextId = 1; locks.clear(); await referrals.getSettings(true);
  const k = await codeOf(A);
  const early = await buy(B, { referralCode: k });
  T.orders.push({ order_id: 'FFBEFORE', phone_norm: B, status: 'PAID', created_at_sheet: '2026-01-01 09:00:00', final_amount: 99 });
  await pay(early.orderId);
  ok('friend who had paid before using the code → NOT_NEW, no coins', T.refs[0].status === 'NOT_NEW' && rewardsFor(A).length === 0 && balance(A) === 0);
  await referrals.saveSettings({ maxPerMonth: 1 });
  const e1 = await buy(C, { referralCode: k }); await pay(e1.orderId);
  const e2 = await buy(D, { referralCode: k });
  ok('friend still gets the discount at the monthly limit', e2.amount === 149);
  await pay(e2.orderId);
  ok('monthly limit → 2nd friend SKIPPED + CAPPED', rewardsFor(A).filter((x) => x.status === 'PAID').length === 1 && T.rewards.some((x) => x.order_id === e2.orderId && x.status === 'SKIPPED' && /monthly/.test(x.reason)) && T.refs.find((x) => x.friend_phone === D).status === 'CAPPED');
  await referrals.saveSettings({ enabled: false });
  const off = await buy('9666600000', { referralCode: k });
  ok('switched off in admin → no discount', off.ok && off.amount === 169 && !off.referralApplied);
  await referrals.saveSettings({ friendDiscount: 500 });
  const big = await buy('9777700000', { referralCode: k });
  ok('discount never exceeds the price', big.ok && big.amount === 0 && big.referralDiscount === 169);
  const free = T.refs.find((x) => x.friend_phone === '9777700000');
  await pay(big.orderId);
  ok('₹0 order earns no coins (SKIPPED)', T.rewards.some((x) => x.order_id === big.orderId && x.status === 'SKIPPED') && free.status === 'REWARDED');
  T.settings = {}; await referrals.getSettings(true);

  section('before schema-v15');
  tablesExist = false; referrals._internal.resetCache();
  r = await referrals.getReferralInfo(A);
  ok('Refer & earn says coming soon', !r.ok && r.disabled);
  const s1 = await buy('9888800000', { referralCode: 'FFABCDEF' });
  ok('checkout works, no discount', s1.ok && s1.amount === 169);
  await pay(s1.orderId);
  ok('mark paid still works', T.orders.find((x) => x.order_id === s1.orderId).status === 'PAID');
  r = await referrals.saveSettings({ friendDiscount: 10 });
  ok('saving settings says to run the SQL', !r.ok && r.needsSchema);
  tablesExist = true;

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
