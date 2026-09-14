/* Refer & earn: invite codes, friend discount at checkout, referrer coins after the friend's first paid order.
 * Run: npm test  (in-memory fake database, no MySQL needed) */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------- tiny in-memory tables ----------------
let tablesExist = true;
const T = { customers: [], orders: [], referral_codes: [], referrals: [], plans: [], coins: [] };
const reset = () => { T.customers = []; T.orders = []; T.referral_codes = []; T.referrals = []; T.coins = []; };
const noTable = () => { const e = new Error("Table 'u.referrals' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };
let nextId = 1;
async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  if (/referral_codes|referrals/.test(sql) && !tablesExist) noTable();
  if (/^SELECT price, duration_days, is_active, raw_json FROM plans/.test(sql)) return T.plans.filter((x) => x.service === p[0] && x.plan === p[1]);
  if (/^SELECT code FROM referral_codes WHERE phone_norm = \?/.test(sql)) return T.referral_codes.filter((x) => x.phone_norm === p[0]);
  if (/^INSERT INTO referral_codes/.test(sql)) {
    if (T.referral_codes.some((x) => x.code === p[1])) throw new Error('Duplicate entry for key uq_referral_code');
    T.referral_codes.push({ phone_norm: p[0], code: p[1] }); return { affectedRows: 1 };
  }
  if (/^SELECT phone_norm FROM referral_codes WHERE code = \?/.test(sql)) return T.referral_codes.filter((x) => x.code === p[0]);
  if (/^SELECT 1 FROM customers WHERE phone_norm = \?/.test(sql)) return T.customers.filter((x) => x.phone_norm === p[0]);
  if (/^SELECT name FROM customers WHERE phone_norm = \?/.test(sql)) return T.customers.filter((x) => x.phone_norm === p[0]);
  if (/^SELECT 1 FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID'/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID' && (!/order_id <> \?/.test(sql) || o.order_id !== p[1]));
  if (/^SELECT code, status FROM referrals WHERE friend_phone = \?/.test(sql)) return T.referrals.filter((r) => r.friend_phone === p[0]);
  if (/^SELECT friend_phone, status, reward_coins, created_at, rewarded_at FROM referrals WHERE referrer_phone = \?/.test(sql)) return T.referrals.filter((r) => r.referrer_phone === p[0]);
  if (/^INSERT INTO referrals/.test(sql)) {
    const ex = T.referrals.find((r) => r.friend_phone === p[2]);
    if (ex) { if (ex.status === 'PENDING') Object.assign(ex, { code: p[0], referrer_phone: p[1], friend_order_id: p[3], discount: p[4] }); return { affectedRows: 2 }; }
    T.referrals.push({ id: nextId++, code: p[0], referrer_phone: p[1], friend_phone: p[2], status: 'PENDING', friend_order_id: p[3], discount: p[4], reward_coins: 0, rewarded_at: null }); return { affectedRows: 1 };
  }
  if (/^SELECT order_id, phone_norm, service, plan, final_amount FROM orders WHERE order_id = \?/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]);
  if (/^SELECT id, code, referrer_phone, friend_phone, status FROM referrals WHERE friend_phone = \? AND status = 'PENDING'/.test(sql)) return T.referrals.filter((r) => r.friend_phone === p[0] && r.status === 'PENDING');
  if (/^UPDATE referrals SET status = \?, friend_order_id = \?/.test(sql)) { const r = T.referrals.find((x) => x.id === p[2] && x.status === 'PENDING'); if (!r) return { affectedRows: 0 }; r.status = p[0]; r.friend_order_id = p[1]; return { affectedRows: 1 }; }
  if (/^SELECT COUNT\(\*\) n FROM referrals WHERE referrer_phone = \? AND status = 'REWARDED'/.test(sql)) return [{ n: T.referrals.filter((r) => r.referrer_phone === p[0] && r.status === 'REWARDED').length }];
  if (/^UPDATE referrals SET status = 'REWARDED'/.test(sql)) { const r = T.referrals.find((x) => x.id === p[2] && x.status === 'PENDING'); if (!r) return { affectedRows: 0 }; Object.assign(r, { status: 'REWARDED', friend_order_id: p[0], reward_coins: p[1], rewarded_at: '2026-09-14 12:00:00' }); return { affectedRows: 1 }; }
  if (/^INSERT INTO orders/.test(sql)) { T.orders.push({ order_id: p[0], phone_norm: p[7], coupon_code: p[8], discount: p[9], price: p[10], final_amount: p[11], status: 'CREATED', service: p[1], plan: p[2], raw: JSON.parse(p[p.length - 1]) }); return { affectedRows: 1 }; }
  if (/^SELECT order_id, final_amount, status, source FROM orders/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map((o) => ({ ...o, source: 'node' }));
  if (/^INSERT INTO coupon_usage/.test(sql)) return { affectedRows: 1 };
  return [];
}
const mockDb = {
  ENABLED: true, query: q, ping: async () => ({ ok: true }),
  getPool: () => ({ getConnection: async () => ({
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, p) => {
      sql = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT status, coupon_code/.test(sql)) return [T.orders.filter((o) => o.order_id === p[0])];
      if (/^UPDATE orders SET status = \?/.test(sql)) { const o = T.orders.find((x) => x.order_id === p[2]); if (o) o.status = 'PAID'; return [{ affectedRows: 1 }]; }
      return [[]];
    },
  }) }),
};
const coinsMock = { awardCoins: async (x) => { T.coins.push(x); return { ok: true, coins: x.coins }; } };
Module._load = (function (orig) {
  return function (req) {
    if (req === './db') return mockDb;
    if (req === './coins') return coinsMock;
    if (req === './payments') return { findByOrder: async () => null, findByRef: async () => null };
    return orig.apply(this, arguments);
  };
})(Module._load);

const referrals = require('../referrals');
const order = require('../order');
const tick = () => new Promise((r) => setTimeout(r, 30));
const RAHUL = '9876543210', FRIEND = '9123456780', OLD = '9000011111';
const planRaw = JSON.stringify({ DurationDays: 30, ExtraDevicePrice: 0 });
T.plans = [{ service: 'Netflix', plan: 'Private 1M', price: 169, duration_days: 30, is_active: 'TRUE', raw_json: planRaw }];
const buy = (phone, extra) => order.createOrder(Object.assign({ service: 'Netflix', plan: 'Private 1M', name: 'Friend', email: 'f@x.in', phone }, extra || {}));

(async () => {
  section('invite code');
  reset();
  T.customers.push({ phone_norm: RAHUL, name: 'Rahul Sharma' });
  let r = await referrals.getReferralInfo('+91 98765 43210');
  ok('customer gets a code + link with the offer', r.ok && /^FF[A-Z2-9]{6}$/.test(r.code) && r.link === 'https://shop.fluxfilm.in/?ref=' + r.code && r.friendDiscount === 20 && r.rewardCoins === 50, r);
  const code = r.code;
  r = await referrals.getReferralInfo(RAHUL);
  ok('same code every time', r.code === code && T.referral_codes.length === 1);
  r = await referrals.getReferralInfo(FRIEND);
  ok('no account → asked to create one (no code made)', !r.ok && T.referral_codes.length === 1);
  ok('codes avoid look-alike characters', Array.from({ length: 200 }, () => referrals._internal.genCode()).every((c) => !/[01ILO]/.test(c.slice(2))));

  section('friend checks the link');
  r = await referrals.checkReferral(code.toLowerCase(), '');
  ok('valid code (any case) shows discount + referrer first name only', r.ok && r.friendDiscount === 20 && r.referrerName === 'Rahul');
  r = await referrals.checkReferral('FFNOPE12', FRIEND);
  ok('unknown code → invalid', !r.ok && r.invalid);
  r = await referrals.checkReferral(code, RAHUL);
  ok("can't use your own code", !r.ok && r.own);
  T.orders.push({ order_id: 'FFOLD1', phone_norm: OLD, status: 'PAID' });
  r = await referrals.checkReferral(code, OLD);
  ok('existing paying customer → new customers only', !r.ok && r.notNew);

  section('checkout with the invite code');
  let o = await buy(FRIEND, { referralCode: code });
  const ord = T.orders.find((x) => x.order_id === o.orderId);
  ok('₹20 off the first order, recorded on the order', o.ok && o.amount === 149 && o.referralApplied && o.referralDiscount === 20 && ord.discount === 20 && ord.raw.ReferralCode === code && ord.raw.ReferralDiscount === 20, o);
  ok('friend recorded as PENDING for Rahul', T.referrals.length === 1 && T.referrals[0].referrer_phone === RAHUL && T.referrals[0].status === 'PENDING' && T.referrals[0].friend_order_id === o.orderId);
  const o2 = await buy(FRIEND, { referralCode: code });
  ok('ordering again before paying moves the pending referral to the new order (still one row)', T.referrals.length === 1 && T.referrals[0].friend_order_id === o2.orderId);
  let own = await buy(RAHUL, { referralCode: code });
  ok('own code at checkout → full price + message, nothing recorded', own.ok && own.amount === 169 && !own.referralApplied && /own invite/.test(own.referralMessage) && T.referrals.length === 1, own);
  own = await buy(FRIEND, { referralCode: 'FFNOPE12' });
  ok('bad code never blocks checkout', own.ok && own.amount === 169);
  const renew = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'F', email: 'f@x.in', phone: FRIEND, referralCode: code }, { action: 'RENEW', renewSubId: 'SUB-1' });
  ok('renewals never get the invite discount', renew.ok && renew.amount === 169 && !renew.referralApplied);

  section('reward after the first paid order');
  await order.adminMarkPaid(o2.orderId, 'ADMIN-UPI:1');
  await tick();
  ok('friend pays → Rahul gets 50 coins once, referral REWARDED', T.referrals[0].status === 'REWARDED' && T.referrals[0].reward_coins === 50 && T.coins.length === 1 && T.coins[0].phone === RAHUL && T.coins[0].coins === 50 && T.coins[0].event === 'REFERRAL' && T.coins[0].orderId === o2.orderId, { ref: T.referrals[0], coins: T.coins });
  ok('coins note hides the friend phone', /91••••••80/.test(T.coins[0].note) && !/9123456780/.test(T.coins[0].note));
  await order.adminMarkPaid(o2.orderId, 'ADMIN-UPI:1');
  r = await referrals.onOrderPaid(o2.orderId, { coins: coinsMock });
  await tick();
  ok('paying / re-checking again never pays twice', T.coins.length === 1 && r.skipped, r);
  r = await referrals.checkReferral(code, FRIEND);
  ok('friend is no longer "new" afterwards', !r.ok && r.notNew);
  r = await referrals.getReferralInfo(RAHUL);
  ok('Rahul sees 1 invited, 1 rewarded, 50 coins, masked phone', r.invited === 1 && r.rewarded === 1 && r.coinsEarned === 50 && r.friends[0].phone === '91••••••80' && r.friends[0].status === 'REWARDED', r);

  section('abuse guards');
  reset(); nextId = 1;
  T.customers.push({ phone_norm: RAHUL, name: 'Rahul' });
  const c2 = (await referrals.getReferralInfo(RAHUL)).code;
  const F2 = '9111122222';
  const pend = await buy(F2, { referralCode: c2 });
  T.orders.push({ order_id: 'FFEARLIER', phone_norm: F2, status: 'PAID' }); // paid some other order in between
  await order.adminMarkPaid(pend.orderId, 'X');
  await tick();
  ok('friend who already had a paid order → NOT_NEW, no coins', T.referrals[0].status === 'NOT_NEW' && T.coins.length === 0, T.referrals[0]);
  process.env.REFERRAL_MAX_PER_MONTH = '1';
  T.referrals.push({ id: nextId++, code: c2, referrer_phone: RAHUL, friend_phone: '9000000009', status: 'REWARDED', reward_coins: 50 });
  const F3 = '9333344444';
  const o3 = await buy(F3, { referralCode: c2 });
  ok('friend still gets the discount when referrer is at the monthly limit', o3.amount === 149);
  await order.adminMarkPaid(o3.orderId, 'X');
  await tick();
  ok('monthly limit reached → CAPPED, no coins', T.referrals.find((x) => x.friend_phone === F3).status === 'CAPPED' && T.coins.length === 0);
  delete process.env.REFERRAL_MAX_PER_MONTH;
  process.env.REFERRAL_ENABLED = '0';
  const off = await buy('9555566666', { referralCode: c2 });
  ok('REFERRAL_ENABLED=0 switches the discount off', off.ok && off.amount === 169 && !off.referralApplied);
  delete process.env.REFERRAL_ENABLED;
  process.env.REFERRAL_FRIEND_DISCOUNT = '500';
  const big = await buy('9777788888', { referralCode: c2 });
  ok('discount never exceeds the price', big.ok && big.amount === 0 && big.referralDiscount === 169, big);
  delete process.env.REFERRAL_FRIEND_DISCOUNT;
  const withCoupon = referrals.checkReferral; // coupon path covered by order.js: coupon wins, referral still recorded
  ok('checkReferral exported for the storefront', typeof withCoupon === 'function');

  section('before schema-v15');
  tablesExist = false;
  r = await referrals.getReferralInfo(RAHUL);
  ok('Refer & earn page says coming soon', !r.ok && r.disabled);
  o = await buy('9888899999', { referralCode: 'FFABCDEF' });
  ok('checkout still works (no discount)', o.ok && o.amount === 169);
  await order.adminMarkPaid(o.orderId, 'X');
  await tick();
  ok('marking paid still works', T.orders.find((x) => x.order_id === o.orderId).status === 'PAID');
  tablesExist = true;

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
