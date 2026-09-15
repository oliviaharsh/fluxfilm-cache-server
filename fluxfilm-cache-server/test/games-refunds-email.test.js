/* 🎮 Games + 💸 Refunds email code (15 Sep 2026): never the profile email. Refund code only to the email on the
   refunded (paid) order itself; Games code only to an email on this phone's plans / PAID + FULFILLED orders.
   One generic "no", HMAC codes in app_settings (restart-safe, atomic tries), tokens checked per tool. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n== ' + t);

const P = '9876543210';
const OTHER = '9111111111';
const refundRaw = (extra) => JSON.stringify(Object.assign({ RefundMethod: 'UPI_PENDING', RefundState: 'ASK_CUSTOMER', RefundedAt: '2026-09-15 10:00:00', RefundAmount: 99 }, extra || {}));
const sent = [];
const mailer = { send: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; } };
const DB = { settings: new Map(), subs: [], orders: [], todos: [] };
function resetData() {
  DB.orders = [
    { order_id: 'FF100', phone_norm: P, name: 'Rahul', service: 'Zee5', plan: '1M', email: 'buyer@x.com', status: 'REFUNDED', fulfillment_status: 'REFUNDED', final_amount: 99, raw_json: refundRaw(), created_at_sheet: '2026-09-14' },
    { order_id: 'FF101', phone_norm: P, email: 'pending@x.com', status: 'CREATED', fulfillment_status: 'PENDING', raw_json: '{}', created_at_sheet: '2026-09-14' },
    { order_id: 'FF102', phone_norm: P, email: 'paid@x.com', status: 'PAID', fulfillment_status: 'FULFILLED', raw_json: '{}', created_at_sheet: '2026-09-10' },
    { order_id: 'FF103', phone_norm: P, email: 'legacy@x.com', status: 'REFUNDED', fulfillment_status: 'REFUNDED', final_amount: 50, raw_json: refundRaw({ RefundedAt: '' }), created_at_sheet: '2026-09-01' },
    { order_id: 'FF104', phone_norm: P, email: 'paidpending@x.com', status: 'PAID', fulfillment_status: 'PENDING', raw_json: '{}', created_at_sheet: '2026-09-12' },
    { order_id: 'FF200', phone_norm: OTHER, email: 'other@x.com', status: 'REFUNDED', fulfillment_status: 'REFUNDED', final_amount: 70, raw_json: refundRaw(), created_at_sheet: '2026-09-14' },
  ];
  DB.subs = [
    { phone_norm: P, email: 'sub@x.com', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 },
    { phone_norm: P, email: 'ended@x.com', status: 'EXPIRED', fulfillment_status: 'FULFILLED', removed: 0 },
    { phone_norm: P, email: 'refunded@x.com', status: 'REFUNDED', fulfillment_status: 'REFUNDED', removed: 0 },
    { phone_norm: P, email: 'removed@x.com', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 1 },
    { phone_norm: P, email: 'cancel@x.com', status: 'CANCELLED', fulfillment_status: 'FULFILLED', removed: 0 },
  ];
  DB.todos = [];
}
resetData();
const clone = (x) => JSON.parse(JSON.stringify(x));
const dupErr = () => { const e = new Error("Duplicate entry for key 'PRIMARY'"); e.code = 'ER_DUP_ENTRY'; return e; };
function run(sqlIn, p = []) {
  const sql = sqlIn.replace(/\s+/g, ' ').trim();
  if (/FROM customers/.test(sql)) throw new Error('must never read the customers profile email: ' + sql);
  if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return DB.settings.has(p[0]) ? [{ value: DB.settings.get(p[0]) }] : [];
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) { if (DB.settings.has(p[0])) throw dupErr(); DB.settings.set(p[0], p[1]); return { affectedRows: 1 }; }
  if (/^UPDATE app_settings SET value = \? WHERE setting_key = \? AND value = \?$/.test(sql)) { if (DB.settings.get(p[1]) !== p[2]) return { affectedRows: 0 }; DB.settings.set(p[1], p[0]); return { affectedRows: 1 }; }
  if (/^DELETE FROM app_settings WHERE setting_key = \?$/.test(sql)) { DB.settings.delete(p[0]); return { affectedRows: 1 }; }
  if (/^DELETE FROM app_settings WHERE setting_key LIKE/.test(sql)) return { affectedRows: 0 };
  if (/^SELECT email, status, fulfillment_status, COALESCE\(removed, 0\) AS removed FROM subscriptions WHERE phone_norm = \?/.test(sql)) return DB.subs.filter((x) => x.phone_norm === p[0]).map(clone);
  if (/^SELECT email FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' AND UPPER\(fulfillment_status\) = 'FULFILLED'/.test(sql)) return DB.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID' && o.fulfillment_status === 'FULFILLED').map((o) => ({ email: o.email }));
  if (/^SELECT order_id, email, status, raw_json FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'REFUNDED'/.test(sql)) return DB.orders.filter((o) => o.phone_norm === p[0] && o.status === 'REFUNDED').map(clone);
  if (/^SELECT order_id, service, plan, name, email, phone, phone_norm, status, final_amount, raw_json FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE$/.test(sql)) return DB.orders.filter((o) => o.order_id === p[0]).map(clone);
  if (/refund_offers/.test(sql)) { const e = new Error("Table 'u.refund_offers' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; } // offers: refunds-v3.test.js
  if (/^INSERT INTO admin_todos/.test(sql)) { DB.todos.push({ id: DB.todos.length + 1, title: p[0] }); return { affectedRows: 1, insertId: DB.todos.length }; }
  if (/^UPDATE orders SET raw_json = \? WHERE order_id = \? LIMIT 1$/.test(sql)) { DB.orders.find((o) => o.order_id === p[1]).raw_json = p[0]; return { affectedRows: 1 }; }
  throw new Error('unmocked SQL: ' + sql);
}
const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query: async (sql, p) => [run(sql, p)] };
const mockDb = { ENABLED: true, query: async (sql, p) => { await new Promise((r) => setImmediate(r)); return run(sql, p); }, getPool: () => ({ getConnection: async () => conn }) };
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; if (req === './mailer') return mailer; return orig.apply(this, arguments); }; })(Module._load);
process.env.DB_PASS = 'db-test'; process.env.CACHE_CLEAR_KEY = 'ck'; process.env.IMAP_PASS = 'imap';

const lastCode = (to) => { const m = sent.filter((x) => x.to === to).pop(); return m ? (m.subject.match(/(\d{6})$/) || [])[1] : ''; };
let access = require('../otpaccess');
const mkRefunds = () => require('../refunds').create({ db: mockDb, otpaccess: access, mailer, push: { sendToPhone: async () => ({}), sendToAdmins: async () => ({}) }, coins: {} });
let R = mkRefunds();
const clearCodes = () => { DB.settings.clear(); access._internal.mem.clear(); };

(async () => {
  section('💸 Refunds: who gets the code');
  const tryRefund = async (label, phone, email) => {
    clearCodes();
    const before = sent.length;
    const r = await R.sendCode(phone, email);
    ok(label + ' → refused, generic message, no email', !r.ok && r.noActive === true && /could not confirm/.test(r.message) && sent.length === before && !/\*|x\.com/.test(r.message), r);
    return r;
  };
  const noA = await tryRefund('profile email written by anyone', P, 'attacker@evil.com');
  const noB = await tryRefund('email of an unpaid (CREATED) order', P, 'pending@x.com');
  const noC = await tryRefund('email of ANOTHER paid order (not the refunded one)', P, 'paid@x.com');
  await tryRefund('refunded order without RefundedAt (not a real admin refund of a paid order)', P, 'legacy@x.com');
  await tryRefund("another phone's refunded order email", P, 'other@x.com');
  await tryRefund('right email, wrong phone', OTHER, 'buyer@x.com');
  ok('"no refund" and "wrong email" look the same', noA.message === noB.message && noB.message === noC.message);
  clearCodes();
  let r = await R.sendCode(P, ' Buyer@X.com ');
  ok('email on the refunded order itself → code sent there', r.ok && sent[sent.length - 1].to === 'buyer@x.com', r);
  const v = await R.verifyCode(P, 'buyer@x.com', lastCode('buyer@x.com'));
  ok('code → otp2 token', v.ok && /^otp2\./.test(v.token || ''), v);

  section('💸 Refunds: the token must be THIS order\'s email');
  const badTokens = [
    ['token verified with another paid order email (e.g. from Games / Get OTP)', access._internal.makeToken2(P, 'paid@x.com').token],
    ['token verified with the profile email', access._internal.makeToken2(P, 'attacker@evil.com').token],
    ["the right email but another phone's token", access._internal.makeToken2(OTHER, 'buyer@x.com').token],
    ['old otp1 token', 'otp1.' + P + '.' + (Date.now() + 86400e3) + '.sig'],
    ['no token', ''],
  ];
  for (const [label, tok] of badTokens) {
    const u = await R.requestUpi(P, 'FF100', 'rahul@okhdfcbank', tok);
    ok(label + ' → needsVerify, nothing saved', u.ok === false && u.needsVerify === true && !DB.todos.length && JSON.parse(DB.orders[0].raw_json).RefundState === 'ASK_CUSTOMER' && !/\*/.test(u.message), u);
  }
  let u = await R.requestUpi(OTHER, 'FF100', 'thief@ybl', access._internal.makeToken2(OTHER, 'other@x.com').token);
  ok('a verified other customer cannot redirect this refund', u.ok === false && !DB.todos.length, u);
  u = await R.requestUpi(P, 'FF100', 'rahul@okhdfcbank', v.token);
  ok('good: verified with the order email → UPI saved + one Today to-do', u.ok && DB.todos.length === 1 && JSON.parse(DB.orders[0].raw_json).RefundState === 'UPI_REQUESTED', u);

  section('Codes: per tool, hashed, atomic, survive restart');
  resetData(); clearCodes();
  await R.sendCode(P, 'buyer@x.com');
  const rc = lastCode('buyer@x.com');
  ok('stored code is an HMAC, not the code or the email', [...DB.settings.values()].every((x) => x.indexOf(rc) === -1 && x.indexOf('buyer@') === -1) && [...DB.settings.values()].some((x) => /"h":"[0-9a-f]{64}"/.test(x)));
  r = await access.verifyGetOtpCode(P, 'buyer@x.com', rc);
  ok('a Refund code cannot be used as a Get OTP code', !r.ok, r);
  const gamesMod = require('../games');
  r = await gamesMod.verifyCode(P, 'buyer@x.com', rc);
  ok('  ...nor as a Games code', !r.ok, r);
  const wrong = rc === '111111' ? '222222' : '111111';
  const par = await Promise.all(Array.from({ length: 10 }, () => R.verifyCode(P, 'buyer@x.com', wrong)));
  ok('10 parallel wrong guesses count at most 5', par.filter((x) => /not right/.test(x.message)).length <= 5, par.map((x) => x.message));
  r = await R.verifyCode(P, 'buyer@x.com', rc);
  ok('  ...then the right code is refused too', !r.ok, r);
  clearCodes();
  await R.sendCode(P, 'buyer@x.com');
  const rc2 = lastCode('buyer@x.com');
  await R.verifyCode(P, 'buyer@x.com', rc2 === '333333' ? '444444' : '333333');
  for (const m of ['../otpaccess', '../refunds', '../games']) delete require.cache[require.resolve(m)];
  access = require('../otpaccess'); R = mkRefunds(); // restart
  r = await R.verifyCode(P, 'buyer@x.com', rc2 === '333333' ? '444444' : '333333');
  ok('after a restart the tries continue (3 left)', /3 tries left/.test(r.message), r);
  r = await R.verifyCode(P, 'buyer@x.com', rc2);
  ok('  ...and the right code still works', r.ok && !!r.token, r);

  section('🎮 Games: which emails prove the customer');
  const games = require('../games');
  const tryGames = async (label, phone, email) => {
    clearCodes();
    const before = sent.length;
    const g = await games.sendCode(phone, email);
    ok(label + ' → refused, generic message, no email', !g.ok && g.noActive === true && g.message === games.GAMES_NO && sent.length === before, g);
    return g;
  };
  await tryGames('profile email written by anyone', P, 'attacker@evil.com');
  await tryGames('unpaid CREATED order email', P, 'pending@x.com');
  await tryGames('PAID but not fulfilled order email', P, 'paidpending@x.com');
  await tryGames('email on a refunded plan', P, 'refunded@x.com');
  await tryGames('email on a removed plan', P, 'removed@x.com');
  await tryGames('email on a cancelled plan', P, 'cancel@x.com');
  await tryGames("right email, another phone", OTHER, 'sub@x.com');
  for (const good of ['sub@x.com', 'ended@x.com', 'paid@x.com']) {
    clearCodes();
    const g = await games.sendCode(P, good);
    const gv = await games.verifyCode(P, good, lastCode(good));
    ok('good: ' + good + ' → code sent there → token', g.ok && sent[sent.length - 1].to === good && gv.ok && /^otp2\./.test(gv.token || ''), { g, gv });
  }
  const matchFor = (tok, ph) => access.tokenMatcher(tok, ph);
  ok('games prize check: token email on a paid order of this phone → verified', await access.paidCustomerEmailOk(P, matchFor(access._internal.makeToken2(P, 'paid@x.com').token, P)));
  ok('games prize check: token made from the profile email → not verified', !(await access.paidCustomerEmailOk(P, matchFor(access._internal.makeToken2(P, 'attacker@evil.com').token, P))));
  ok("games prize check: another phone's token → not verified", matchFor(access._internal.makeToken2(OTHER, 'paid@x.com').token, P) === null);
  const gsrc = fs.readFileSync(path.join(__dirname, '..', 'games.js'), 'utf8');
  ok('games.js checks the token email on start AND when a prize is collected', /const tokenOk = await deviceVerified\(ph, token\);/.test(gsrc) && /cfg\.requireVerify && !\(await deviceVerified\(ph, token\)\)\) return/.test(gsrc) && !/otpaccess\.(check|verifyToken|sendCode)\(/.test(gsrc));

  section('Storefront + games page');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const rcSrc = html.slice(html.indexOf('function RefundChoice('), html.indexOf('function RefundChoice(') + 12000);
  ok('refund sheet: customer types the email, no masked hint, code checked as kind "refund"', /API\.refundSendCode\(ph, em,/.test(rcSrc) && /label: "Email on this order"/.test(rcSrc) && !/maskedEmail|hasEmail/.test(rcSrc) && /'refund'\);/.test(rcSrc));
  ok('API wrappers send [phone, email] and [phone, code, email, kind]', /apiCall_\('refundSendCode', \[phone, email\]/.test(html) && /apiCall_\('otpVerifyCode', \[phone, code, email \|\| '', kind \|\| 'getotp'\]/.test(html));
  const gh = fs.readFileSync(path.join(__dirname, '..', 'games.html'), 'utf8');
  ok('games page: email box, no masked hint, code checked as kind "games"', /id="vEmail"/.test(gh) && !/maskedEmail/.test(gh) && /api\('gamesSendCode', \[S\.phone, email\(\)\]\)/.test(gh) && /api\('otpVerifyCode', \[S\.phone, \$\('vCode'\)\.value, email\(\), 'games'\]\)/.test(gh));
  let bad = 0; let n = 0;
  for (const src of [html, gh]) {
    for (const m of src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type=["'](?!text\/javascript)/.test(m[1])) continue;
      n++; try { new Function(m[2]); } catch (e) { bad++; console.log('  script error:', e.message); }
    }
  }
  ok('every inline <script> in index.html + games.html parses (' + n + ')', n > 1 && bad === 0);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: send actions take [phone, email]; verify routes by kind; no phone-only verify', /gamesSendCode: \(a\) => gamesMod\.sendCode\(String\(a\[0\] \|\| ''\), String\(a\[1\] \|\| ''\)\)/.test(server) && /refundSendCode: \(a\) => refundsMod\.sendCode\(String\(a\[0\] \|\| ''\), String\(a\[1\] \|\| ''\)\)/.test(server) &&
    /if \(a\[3\] === 'games' && gamesMod\) return gamesMod\.verifyCode\(ph, em, code\);/.test(server) && /if \(a\[3\] === 'refund' && refundsMod\) return refundsMod\.verifyCode\(ph, em, code\);/.test(server) && !/otpaccess'\)\.verifyCode\(/.test(server));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
