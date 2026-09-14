/* Refer & earn: a friend who creates an account from an invite link is linked at SIGN-UP (not only at the
 * first order), so the referrer's page shows them as "Joined" right away. Coins still wait for a paid order.
 * Run: npm test  (in-memory fake database, no MySQL needed) */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let T; let nextId = 1; let tablesExist = true; let insertCalls = 0;
const reset = () => { T = { settings: {}, customers: [], orders: [], codes: [], refs: [] }; insertCalls = 0; };
reset();
const noTable = () => { const e = new Error("Table 'u.referrals' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };

async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  if (/app_settings|referral_codes|referrals/.test(sql) && !tablesExist) noTable();
  if (/^SELECT value FROM app_settings/.test(sql)) return T.settings[p[0]] ? [{ value: T.settings[p[0]] }] : [];
  if (/^SELECT phone, raw_json FROM customers WHERE phone_norm = \?/.test(sql)) return T.customers.filter((x) => x.phone_norm === p[0]);
  if (/^UPDATE customers SET name = \?/.test(sql)) return { affectedRows: 1 };
  if (/^INSERT INTO customers/.test(sql)) { T.customers.push({ phone: p[0], phone_norm: p[1], name: p[2], email: p[3] }); return { affectedRows: 1 }; }
  if (/^SELECT 1 FROM customers WHERE phone_norm = \?/.test(sql) || /^SELECT name FROM customers WHERE phone_norm = \?/.test(sql)) return T.customers.filter((x) => x.phone_norm === p[0]);
  if (/^SELECT code FROM referral_codes WHERE phone_norm = \?/.test(sql)) return T.codes.filter((x) => x.phone_norm === p[0]);
  if (/^INSERT INTO referral_codes/.test(sql)) { T.codes.push({ phone_norm: p[0], code: p[1] }); return { affectedRows: 1 }; }
  if (/^SELECT phone_norm FROM referral_codes WHERE code = \?/.test(sql)) return T.codes.filter((x) => x.code === p[0]);
  if (/^SELECT 1 FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID'/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID');
  if (/^SELECT status FROM referrals WHERE friend_phone = \?/.test(sql)) return T.refs.filter((r) => r.friend_phone === p[0]);
  if (/^SELECT friend_phone, status, created_at, rewarded_at FROM referrals WHERE referrer_phone = \?/.test(sql)) return T.refs.filter((r) => r.referrer_phone === p[0]);
  if (/^SELECT friend_phone, kind, coins FROM referral_rewards/.test(sql)) return [];
  if (/^INSERT IGNORE INTO referrals/.test(sql)) {
    insertCalls++;
    await new Promise((r) => setTimeout(r, 1)); // let parallel sign-ups interleave
    if (T.refs.some((r) => r.friend_phone === p[2])) return { affectedRows: 0 };
    T.refs.push({ id: nextId++, code: p[0], referrer_phone: p[1], friend_phone: p[2], status: 'PENDING', friend_order_id: null, discount: 0 }); return { affectedRows: 1 };
  }
  if (/^INSERT INTO referrals/.test(sql)) { // attachToOrder (checkout)
    const ex = T.refs.find((r) => r.friend_phone === p[2]);
    if (ex) { if (ex.status === 'PENDING') Object.assign(ex, /code = IF\(/.test(sql) ? { code: p[0], referrer_phone: p[1] } : {}, { friend_order_id: p[3], discount: p[4] }); return { affectedRows: 2 }; }
    T.refs.push({ id: nextId++, code: p[0], referrer_phone: p[1], friend_phone: p[2], status: 'PENDING', friend_order_id: p[3], discount: p[4] }); return { affectedRows: 1 };
  }
  throw new Error('unexpected SQL in test: ' + sql);
}
const mockDb = { ENABLED: true, query: q, ping: async () => ({ ok: true }) };
const mockReads = { getCustomerProfile: async (ph) => ({ ok: true, phone: ph }) };
Module._load = (function (orig) {
  return function (req) {
    if (req === './db') return mockDb;
    if (req === './reads') return mockReads;
    return orig.apply(this, arguments);
  };
})(Module._load);

const referrals = require('../referrals');
const account = require('../account');
const A = '9876543210', B = '9123456780', C = '9000022222', D = '9555511111', E = '9444433333';
const signUp = (phone, referralCode) => account.createOrUpdateCustomerProfile({ name: 'Friend ' + phone.slice(-2), phone, email: phone + '@x.in', referralCode });
const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };

(async () => {
  section('owner A gets an invite code');
  T.customers.push({ phone_norm: A, name: 'Harsh' });
  let info = await referrals.getReferralInfo(A);
  const CODE = info.code;
  ok('A has a code, 0 joined', info.ok && /^FF/.test(CODE) && info.joined === 0 && info.bought === 0, info);

  section('friend B signs up from the invite link (no order)');
  let r = await signUp(B, CODE.toLowerCase());
  ok('account created as before', r.ok && r.message === 'Account created' && T.customers.some((c) => c.phone_norm === B), r);
  ok('link recorded at sign-up (PENDING, no order yet)', T.refs.length === 1 && T.refs[0].referrer_phone === A && T.refs[0].friend_phone === B && T.refs[0].status === 'PENDING' && !T.refs[0].friend_order_id, T.refs);
  info = await referrals.getReferralInfo(A);
  ok("A's page: 1 joined, 0 bought, no coins", info.joined === 1 && info.bought === 0 && info.invited === 1 && info.coinsEarned === 0 && info.friends[0].status === 'PENDING', info);

  section('B later orders with the code → checkout keeps the same link');
  const chk = await referrals.checkReferral(CODE, B, 169);
  ok('B still gets the friend discount at checkout', chk.ok && chk.discount === 20, chk);
  await referrals.attachToOrder({ code: CODE, referrerPhone: A, friendPhone: B, orderId: 'FF1', discount: 20 });
  ok('same single link, now with the order id', T.refs.length === 1 && T.refs[0].friend_order_id === 'FF1' && T.refs[0].referrer_phone === A);

  section('never replaces an existing link');
  T.customers.push({ phone_norm: D, name: 'Dev' });
  const codeD = (await referrals.getReferralInfo(D)).code;
  r = await referrals.attachOnSignup({ code: codeD, friendPhone: B });
  ok("B stays A's friend", T.refs.filter((x) => x.friend_phone === B).length === 1 && T.refs.find((x) => x.friend_phone === B).referrer_phone === A && r.linked === false, r);

  section('first link wins: ordering later with another invite code keeps the first referrer');
  await referrals.attachToOrder({ code: codeD, referrerPhone: D, friendPhone: B, orderId: 'FF2', discount: 20 });
  const bLink = T.refs.filter((x) => x.friend_phone === B);
  ok("B still A's friend after ordering with D's code (order id updated)", bLink.length === 1 && bLink[0].referrer_phone === A && bLink[0].code === CODE && bLink[0].friend_order_id === 'FF2', bLink);
  ok('checkout SQL never rewrites code / referrer of an existing link', !/code = IF\(|referrer_phone = IF\(/.test(fs.readFileSync(path.join(__dirname, '..', 'referrals.js'), 'utf8')));

  section('not linked: own code, bad code, no code, already paid, existing account');
  r = await quiet(referrals.attachOnSignup)({ code: CODE, friendPhone: A });
  ok('own code', !r.ok && !T.refs.some((x) => x.friend_phone === A), r);
  r = await quiet(signUp)(C, 'FFNOPE99');
  ok('invalid code: account still created, no link', r.ok && T.customers.some((c) => c.phone_norm === C) && !T.refs.some((x) => x.friend_phone === C));
  const before = insertCalls;
  r = await signUp(E);
  ok('no code: no referral query at all', r.ok && insertCalls === before && !T.refs.some((x) => x.friend_phone === E));
  T.orders.push({ phone_norm: '9333322222', status: 'PAID' });
  r = await quiet(signUp)('9333322222', CODE);
  ok('number that already paid (legacy order, no profile) is not linked', r.ok && !T.refs.some((x) => x.friend_phone === '9333322222'));
  T.customers.push({ phone_norm: '9222211111', raw_json: '{}' });
  r = await signUp('9222211111', CODE);
  ok('existing customer updating their profile is not linked', r.ok && r.message === 'Account updated' && !T.refs.some((x) => x.friend_phone === '9222211111'));
  r = await referrals.attachOnSignup({ code: '', friendPhone: '12' });
  ok('empty input is ignored', !r.ok && r.skipped);

  section('two sign-up requests at the same moment → one link');
  await Promise.all([referrals.attachOnSignup({ code: CODE, friendPhone: '9111100000' }), referrals.attachOnSignup({ code: CODE, friendPhone: '9111100000' })]);
  ok('exactly one row', T.refs.filter((x) => x.friend_phone === '9111100000').length === 1);

  section('paused / before schema-v15 → sign-up still works');
  T.settings.referral = JSON.stringify({ enabled: false }); referrals._internal.resetCache();
  r = await signUp('9777700001', CODE);
  ok('paused: account created, no link', r.ok && !T.refs.some((x) => x.friend_phone === '9777700001'));
  T.settings = {}; referrals._internal.resetCache();
  tablesExist = false;
  r = await signUp('9777700002', CODE);
  ok('no tables: account created', r.ok && T.customers.some((c) => c.phone_norm === '9777700002'));
  tablesExist = true;
  referrals._internal.resetCache();
  mockDb.query = async (sql, p) => { if (/referral/.test(sql)) throw new Error('Connection lost'); return q(sql, p); };
  r = await quiet(signUp)('9777700003', CODE);
  ok('database error in the referral step never breaks sign-up', r.ok && r.message === 'Account created');
  mockDb.query = q;

  section('paid friends are "Bought"; already-customers are not "Joined"');
  T.refs.push({ id: nextId++, code: CODE, referrer_phone: A, friend_phone: '9000000001', status: 'REWARDED' });
  T.refs.push({ id: nextId++, code: CODE, referrer_phone: A, friend_phone: '9000000002', status: 'CAPPED' });
  T.refs.push({ id: nextId++, code: CODE, referrer_phone: A, friend_phone: '9000000003', status: 'NOT_NEW' });
  info = await referrals.getReferralInfo(A);
  const mine = T.refs.filter((x) => x.referrer_phone === A).length;
  ok('counts: invited = all, joined = all but NOT_NEW, bought = REWARDED + CAPPED', info.invited === mine && info.joined === mine - 1 && info.bought === 2, info);

  section('storefront sends the invite code when creating an account and shows Joined / Bought');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('create-account sends referralCode', /API\.createOrUpdateCustomerProfile\(\{\s*name,\s*phone,\s*email,\s*referralCode: getRefCode_\(\)\s*\}/.test(html));
  ok('stats show Joined, Bought, Coins earned', /\[\['Joined', info\.joined\], \['Bought', info\.bought \|\| 0\], \['Coins earned', info\.coinsEarned\]\]/.test(html));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
