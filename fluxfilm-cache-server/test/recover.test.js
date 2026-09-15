/* Recover access (recover.js + the storefront Recover screen): which email may get the code, clear messages,
 * resend wait, codes and sessions surviving a restart, refunded / switched-off plans.
 * Run: npm test (no database, no real email — a small fake answers the SQL and smtp is mocked). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const day = 24 * 3600e3;
const sqlDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
let S;
function reset() {
  S = {
    subs: [
      { sub_id: 'SUB-1', order_id: 'FF1', phone_norm: '9876543210', email: ' Asha.K@Gmail.com ', service: 'Netflix', plan: 'Sharing 1M', status: 'ACTIVE', fulfillment_status: 'FULFILLED', expiry_date: sqlDate(Date.now() + 10 * day), login_id: 'nf@x', password: 'pw1', removed: 0 },
      { sub_id: 'SUB-2', order_id: 'FF2', phone_norm: '9876543210', email: 'asha.k@gmail.com', service: 'Prime Video', plan: '1M', status: 'EXPIRED', fulfillment_status: '', expiry_date: sqlDate(Date.now() - 20 * day), login_id: 'old@p', password: 'oldpw', removed: 1 },
      { sub_id: 'SUB-3', order_id: 'FF3', phone_norm: '9876543210', email: 'asha.k@gmail.com', service: 'Netflix', plan: 'Private', status: 'CANCELLED', fulfillment_status: 'REFUNDED', expiry_date: sqlDate(Date.now() + 5 * day), login_id: 'r@x', password: 'rpw', removed: 0 },
      // go-era import: no email on the subscription, the email is only on the order
      { sub_id: 'SUB-4', order_id: 'FF4', phone_norm: '9000000001', email: '', service: 'YouTube Premium', plan: '1M', status: 'ACTIVE', fulfillment_status: '', expiry_date: sqlDate(Date.now() + 3 * day), login_id: '', password: '', removed: 0 },
      // no email anywhere
      { sub_id: 'SUB-5', order_id: 'FF5', phone_norm: '9000000002', email: null, service: 'Zee5 Premium', plan: '1M', status: 'ACTIVE', fulfillment_status: '', expiry_date: sqlDate(Date.now() + 3 * day), login_id: '', password: '', removed: 0 },
      // expired, not yet switched off
      { sub_id: 'SUB-6', order_id: 'FF6', phone_norm: '9000000003', email: 'ravi@x.in', service: 'Netflix', plan: 'Sharing', status: 'EXPIRED', fulfillment_status: 'FULFILLED', expiry_date: sqlDate(Date.now() - 2 * day), login_id: 'nf6@x', password: 'pw6', removed: 0 },
    ],
    orders: [{ phone_norm: '9000000001', email: 'Yahya.Old@Gmail.com' }, { phone_norm: '9876543210', email: 'asha.k@gmail.com' }],
    customers: [{ phone_norm: '9000000003', email: 'ravi.new@x.in' }],
    settings: new Map(),
    settingsBroken: false,
    mails: [],
    mailFails: false,
  };
}
reset();
const byPhone = (rows, ph) => rows.filter((r) => r.phone_norm === ph);
const mockDb = {
  async query(sql, p) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/app_settings/.test(q)) {
      if (S.settingsBroken) throw Object.assign(new Error("Table 'app_settings' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
      if (/^SELECT value FROM app_settings/.test(q)) { const v = S.settings.get(p[0]); return v ? [{ value: v }] : []; }
      if (/^INSERT INTO app_settings/.test(q)) { S.settings.set(p[0], p[1]); return { affectedRows: 1 }; }
      if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(q)) { S.settings.delete(p[0]); return { affectedRows: 1 }; }
      if (/^DELETE FROM app_settings WHERE setting_key LIKE/.test(q)) return { affectedRows: 0 };
    }
    if (/^SELECT COUNT\(\*\) n FROM subscriptions WHERE phone_norm = \?/.test(q)) return [{ n: byPhone(S.subs, p[0]).length }];
    if (/^SELECT DISTINCT email FROM subscriptions/.test(q)) return byPhone(S.subs, p[0]).map((r) => ({ email: r.email }));
    if (/^SELECT DISTINCT email FROM orders/.test(q)) return byPhone(S.orders, p[0]).map((r) => ({ email: r.email }));
    if (/^SELECT DISTINCT email FROM customers/.test(q)) return byPhone(S.customers, p[0]).map((r) => ({ email: r.email }));
    if (/FROM subscriptions WHERE phone_norm = \? ORDER BY expiry_date DESC/.test(q)) return byPhone(S.subs, p[0]).slice().sort((a, b) => (a.expiry_date < b.expiry_date ? 1 : -1));
    if (/FROM subscriptions WHERE \(order_id = \? OR sub_id = \?\) AND phone_norm = \?/.test(q)) return S.subs.filter((r) => (r.order_id === p[0] || r.sub_id === p[1]) && r.phone_norm === p[2]).slice(0, 1);
    if (/^SELECT fulfillment_status, COALESCE\(removed, 0\) AS removed FROM subscriptions WHERE sub_id = \?/.test(q)) return S.subs.filter((r) => r.sub_id === p[0]).map((r) => ({ fulfillment_status: r.fulfillment_status, removed: r.removed }));
    throw new Error('unexpected SQL: ' + q);
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './smtp') return { sendMail: async (m) => { if (S.mailFails) throw new Error('smtp down'); S.mails.push(m); return { ok: true }; } };
  if (req === './devicelogins') return { groupsReady: async () => false, accessWithLogins: () => ({}) };
  return origLoad.apply(this, arguments);
};
const load = () => { delete require.cache[require.resolve('../recover')]; return require('../recover'); };
let recover = load();
const codeFrom = (m) => (String(m.subject).match(/(\d{6})/) || [])[1];

(async () => {
  section('send code: phone formats + which email');
  let r = await recover.sendOtp('+91 98765 43210', '  ASHA.K@gmail.com ');
  ok('+91 / spaces / uppercase email with spaces in the DB → code sent', r.ok === true && S.mails.length === 1, r);
  ok('code emailed to the saved (clean) address', S.mails[0] && S.mails[0].to === 'asha.k@gmail.com', S.mails[0] && S.mails[0].to);
  ok('message names the masked email + Spam', /as\*+@gmail\.com/.test(r.message) && /Spam/.test(r.message), r.message);
  ok('resend wait returned (30 s)', r.resendInSec === 30);
  ok('the code is not in the answer', !JSON.stringify(r).includes(codeFrom(S.mails[0])));
  r = await recover.sendOtp('09876543210', 'asha.k@gmail.com');
  ok('asking again within 30 s: no second email, tells how long to wait', r.ok === false && r.wait > 0 && r.wait <= 30 && S.mails.length === 1 && /as\*+@gmail\.com/.test(r.email), r);

  r = await recover.sendOtp('9000000001', 'yahya.old@gmail.com');
  ok('email only on the order (go-era import) → code sent', r.ok === true && S.mails.length === 2, r);
  r = await recover.sendOtp('9000000003', 'ravi.new@x.in');
  ok('email only on the customer profile → code sent', r.ok === true && S.mails.length === 3, r);

  r = await recover.sendOtp('9000000001', 'someone@else.com');
  ok('wrong email → says so + masked hint, nothing sent', r.ok === false && r.wrongEmail && /not with this email/.test(r.message) && /ya\*+@gmail\.com/.test(r.message) && S.mails.length === 3, r);
  ok('hint never shows the full email', !/yahya\.old/.test(JSON.stringify(r)));
  r = await recover.sendOtp('9000000002', 'x@y.com');
  ok('no email saved anywhere → Help message, nothing sent', r.ok === false && r.noEmail && /Help/.test(r.message) && S.mails.length === 3, r);
  r = await recover.sendOtp('9111111111', 'x@y.com');
  ok('no plan on the number → asks about a different number (masked)', r.ok === false && r.noPlan && /91\*{6}11/.test(r.message), r);
  r = await recover.sendOtp('12345', 'x@y.com');
  ok('short phone → clear message', r.ok === false && /10-digit/.test(r.message), r);
  r = await recover.sendOtp('9876543210', 'asha.gmail.com');
  ok('bad email → clear message', r.ok === false && /valid email/.test(r.message), r);

  section('verify code');
  const ashaCode = codeFrom(S.mails[0]);
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', '12');
  ok('too short → asks for 6 digits (does not use a try)', r.ok === false && /6-digit/.test(r.message));
  const wrong = ashaCode === '111111' ? '222222' : '111111';
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', wrong);
  ok('wrong code → tries left', r.ok === false && /4 tries left/.test(r.message), r);
  const stored = [...S.settings.keys()].filter((k) => k.startsWith('rcv_o_'));
  ok('code kept in app_settings (hashed, not the code itself)', stored.length === 3 && ![...S.settings.values()].some((v) => v.includes(ashaCode)), stored.length);

  // Hostinger restart: memory is gone, app_settings still has the code.
  recover = load();
  r = await recover.verifyOtp('+91 98765-43210', 'Asha.K@gmail.com', ' ' + ashaCode.slice(0, 3) + ' ' + ashaCode.slice(3));
  ok('after a restart the emailed code still works (any phone / email format)', r.ok === true && r.recoverToken, r);
  const token = r.recoverToken;
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', ashaCode);
  ok('a used code cannot be used again', r.ok === false && r.expired, r);

  section('list plans + show login');
  recover = load(); // restart again: the session token must survive too
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', token);
  ok('session survives a restart', r.ok === true && r.subscriptions.length === 3, r);
  ok('running plan first, ended next, refunded last', r.ok && r.subscriptions.map((x) => x.subId).join() === 'SUB-1,SUB-2,SUB-3', r.subscriptions && r.subscriptions.map((x) => x.subId));
  ok('days left + readable date', r.ok && r.subscriptions[0].daysLeft === 10 && /\d{1,2} \w{3,4} \d{4}/.test(r.subscriptions[0].expiryText), r.subscriptions && r.subscriptions[0]);
  r = await recover.listSubscriptions('9876543210', 'other@gmail.com', token);
  ok('token is bound to the verified email', r.ok === false && r.sessionExpired);
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', 'nope');
  ok('bad token → timed-out message', r.ok === false && r.sessionExpired && /send a new code/.test(r.message));

  r = await recover.getAccess('FF1', '9876543210', 'asha.k@gmail.com', token);
  ok('running plan → login', r.ok && r.access.user === 'nf@x' && r.access.pass === 'pw1' && !r.postPaymentMessage, r);
  r = await recover.getAccess('SUB-2', '9876543210', 'asha.k@gmail.com', token);
  ok('ended + switched off → no old password, renew message', r.ok === false && r.expired && /Renew/.test(r.message) && !JSON.stringify(r).includes('oldpw'), r);
  r = await recover.getAccess('FF3', '9876543210', 'asha.k@gmail.com', token);
  ok('refunded → no login', r.ok === false && r.refunded && !JSON.stringify(r).includes('rpw'), r);
  r = await recover.getAccess('FF4', '9876543210', 'asha.k@gmail.com', token);
  ok('another phone\'s plan → not found', r.ok === false && /not found/.test(r.message));

  const yCode = codeFrom(S.mails[1]);
  const yt = (await recover.verifyOtp('9000000001', 'yahya.old@gmail.com', yCode)).recoverToken;
  r = await recover.getAccess('FF4', '9000000001', 'yahya.old@gmail.com', yt);
  ok('YouTube (no login) → explains the family invite', r.ok && /family invite/.test(r.postPaymentMessage), r);
  const rCode = codeFrom(S.mails[2]);
  const rt = (await recover.verifyOtp('9000000003', 'ravi.new@x.in', rCode)).recoverToken;
  r = await recover.getAccess('FF6', '9000000003', 'ravi.new@x.in', rt);
  ok('ended but not switched off → login + renew note', r.ok && r.access.user === 'nf6@x' && /ended on .*Renew/.test(r.postPaymentMessage), r);

  section('attempt limit, expiry, email failure, no app_settings');
  reset(); recover = load();
  await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const c2 = codeFrom(S.mails[0]); const bad = c2 === '999999' ? '888888' : '999999';
  for (let i = 0; i < 5; i++) await recover.verifyOtp('9876543210', 'asha.k@gmail.com', bad);
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c2);
  ok('6th try (even the right code) → send a new code', r.ok === false && r.expired && /new code/.test(r.message), r);
  recover = load();
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c2);
  ok('attempt limit is not reset by a restart', r.ok === false, r);

  reset(); recover = load();
  await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const k = recover._internal.key('9876543210', 'asha.k@gmail.com');
  recover._internal.otpStore.get(k).exp = Date.now() - 1;
  const dbKey = recover._internal.otpKey(k); S.settings.set(dbKey, JSON.stringify(Object.assign(JSON.parse(S.settings.get(dbKey)), { exp: Date.now() - 1 })));
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', codeFrom(S.mails[0]));
  ok('expired code → clear message', r.ok === false && r.expired && /expired/.test(r.message), r);

  reset(); recover = load(); S.mailFails = true;
  r = await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  ok('email failure → friendly retry message, no code stored', r.ok === false && /could not send/.test(r.message) && S.settings.size === 0, r);
  S.mailFails = false;
  r = await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  ok('…and the customer can retry straight away (no 30 s wait after a failure)', r.ok === true, r);

  reset(); recover = load(); S.settingsBroken = true;
  r = await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const c3 = codeFrom(S.mails[0]);
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c3);
  ok('without app_settings: memory alone still works', r.ok === true, r);
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', r.recoverToken);
  ok('…list works too', r.ok === true && r.subscriptions.length === 3);

  section('storefront Recover screen');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('function RecoverScreen('); const b = html.indexOf('\nfunction ', a + 10);
  const src = html.slice(a, b);
  ok('no alert() pop-ups', !/alert\(/.test(src));
  ok('code box: numbers keyboard + SMS/email autofill + 6 max', /inputMode: "numeric"/.test(src) && /autoComplete: "one-time-code"/.test(src) && /maxLength: 6/.test(src));
  ok('auto-checks when 6 digits are typed', /v\.length === 6\) verifyOtp\(v\)/.test(src));
  ok('resend countdown + "Send a new code"', /Send a new code in/.test(src) && /Send a new code/.test(src));
  ok('"Wrong email? Change it" + Spam hint', /Wrong email\? Change it/.test(src) && /Spam/.test(src));
  ok('timed-out session goes back to step 1', /sessionExpired\) return backToStart/.test(src));
  ok('Help button for no-email / refunded; Renew for ended', /ffOpenHelp_/.test(src) && /Renew in My plans/.test(src));
  ok('double tap guarded', /busy\.current/.test(src));
  ok('Input passes inputMode / autoComplete / maxLength', /inputMode: inputMode,\n\s+autoComplete: autoComplete,\n\s+maxLength: maxLength/.test(html));
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => !/^\s*\{/.test(x));
  let parsed = 0;
  for (const sc of scripts) { try { new Function(sc); parsed++; } catch (e) { if (!/import|export|JSON/.test(e.message)) ok('script parses: ' + e.message, false); } }
  ok('index.html scripts parse', parsed > 0);

  console.log('\nrecover: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
