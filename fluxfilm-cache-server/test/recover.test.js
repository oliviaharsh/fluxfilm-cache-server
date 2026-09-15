/* Recover access (recover.js + the storefront Recover screen).
 * Owner rule (15 Sep 2026): recover only works for an ACTIVE subscription, and an email only opens the
 * subscriptions it belongs to (email on the subscription row, or on the PAID + FULFILLED order for it).
 * Attack cases (profile email, pending order, later paid order, expired, refunded device, removed) must all
 * get the same generic answer with no hints. Also: codes/sessions survive a restart, atomic attempt count.
 * Run: npm test (no database, no real email — a small fake answers the SQL and smtp is mocked). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const day = 24 * 3600e3;
// Stored dates are India wall time.
const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const NO_ACTIVE = 'No active plan found for this number and email. If your plan ended, renew it from My plans. Need help? Tap Help.';

let S;
const sub = (o) => Object.assign({ phone_norm: '', email: '', service: 'Netflix', plan: '1M', status: 'ACTIVE', fulfillment_status: 'FULFILLED', expiry_date: ist(Date.now() + 10 * day), login_id: 'u', password: 'p', removed: 0, group_id: null, group_index: null }, o);
function reset() {
  S = {
    subs: [
      // Asha: email on the subscription (spaces / capitals)
      sub({ sub_id: 'SUB-1', order_id: 'FF1', phone_norm: '9876543210', email: ' Asha.K@Gmail.com ', login_id: 'nf@x', password: 'pw1' }),
      sub({ sub_id: 'SUB-2', order_id: 'FF2', phone_norm: '9876543210', email: 'asha.k@gmail.com', service: 'Prime Video', status: 'EXPIRED', fulfillment_status: '', expiry_date: ist(Date.now() - 20 * day), login_id: 'old@p', password: 'oldpw', removed: 1 }),
      sub({ sub_id: 'SUB-3', order_id: 'FF3', phone_norm: '9876543210', email: 'asha.k@gmail.com', status: 'CANCELLED', fulfillment_status: 'REFUNDED', login_id: 'r@x', password: 'rpw' }),
      // Yahya: go-era import, email only on the PAID + FULFILLED order
      sub({ sub_id: 'SUB-4', order_id: 'FF4', phone_norm: '9000000001', email: '', service: 'YouTube Premium', login_id: '', password: '', expiry_date: ist(Date.now() + 3 * day) }),
      // …and a LATER purchase on the same phone, paid with a different email
      sub({ sub_id: 'SUB-9', order_id: 'FF10', phone_norm: '9000000001', email: '', service: 'Netflix', login_id: 'nf9@x', password: 'pw9', expiry_date: ist(Date.now() + 20 * day) }),
      // no email anywhere; its only order is still CREATED (pending) with an email
      sub({ sub_id: 'SUB-5', order_id: 'FF5', phone_norm: '9000000002', email: null, service: 'Zee5 Premium', login_id: 'z@x', password: 'zpw' }),
      // Ravi: expired, not yet switched off
      sub({ sub_id: 'SUB-6', order_id: 'FF6', phone_norm: '9000000003', email: 'ravi@x.in', status: 'ACTIVE', expiry_date: ist(Date.now() - 2 * 3600e3), login_id: 'nf6@x', password: 'pw6' }),
      // 2-device purchase, Device 2 refunded
      sub({ sub_id: 'SUB-G1', order_id: 'FFG', phone_norm: '9000000004', email: 'dev@x.in', login_id: 'd1@x', password: 'dpw1', group_id: 'G-FFG', group_index: 1 }),
      sub({ sub_id: 'SUB-G2', order_id: 'FFG', phone_norm: '9000000004', email: 'dev@x.in', login_id: 'd2@x', password: 'dpw2', group_id: 'G-FFG', group_index: 2, fulfillment_status: 'REFUNDED' }),
      // healthy 2-device purchase
      sub({ sub_id: 'SUB-H2', order_id: 'FFH', phone_norm: '9000000005', email: 'grp@x.in', login_id: 'h2@x', password: 'hpw2', group_id: 'G-FFH', group_index: 2 }),
      sub({ sub_id: 'SUB-H1', order_id: 'FFH', phone_norm: '9000000005', email: 'grp@x.in', login_id: 'h1@x', password: 'hpw1', group_id: 'G-FFH', group_index: 1 }),
      // removed from the account (still has days on paper)
      sub({ sub_id: 'SUB-R', order_id: 'FFR', phone_norm: '9000000006', email: 'rem@x.in', login_id: 'rm@x', password: 'rmpw', removed: 1 }),
    ],
    orders: [
      { order_id: 'FF4', phone_norm: '9000000001', email: 'Yahya.Old@Gmail.com', status: 'PAID', fulfillment_status: 'FULFILLED' },
      { order_id: 'FF10', phone_norm: '9000000001', email: 'yahya.new@gmail.com', status: 'PAID', fulfillment_status: 'FULFILLED' },
      { order_id: 'FF5', phone_norm: '9000000002', email: 'pending@evil.com', status: 'CREATED', fulfillment_status: 'PENDING' },
      // attacker's own unpaid order on Asha's phone
      { order_id: 'FF99', phone_norm: '9876543210', email: 'attacker@evil.com', status: 'CREATED', fulfillment_status: 'PENDING' },
      { order_id: 'FF1', phone_norm: '9876543210', email: 'asha.k@gmail.com', status: 'PAID', fulfillment_status: 'FULFILLED' },
    ],
    // profile emails: anyone can write these, they must never count
    customers: [{ phone_norm: '9876543210', email: 'attacker@evil.com' }, { phone_norm: '9000000003', email: 'ravi.new@x.in' }],
    settings: new Map(),
    settingsBroken: false,
    interleave: false,
    mails: [],
    mailFails: false,
    groupsOn: true,
    sql: [],
  };
}
reset();
const tick = () => new Promise((r) => setImmediate(r));
const mockDb = {
  async query(sql, p) {
    const q = sql.replace(/\s+/g, ' ').trim();
    S.sql.push(q);
    if (S.interleave) await tick();
    if (/app_settings/.test(q)) {
      if (S.settingsBroken) throw Object.assign(new Error("Table 'app_settings' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
      if (/^SELECT value FROM app_settings/.test(q)) { const v = S.settings.get(p[0]); return v != null ? [{ value: v }] : []; }
      if (/^INSERT INTO app_settings/.test(q)) { S.settings.set(p[0], p[1]); return { affectedRows: 1 }; }
      if (/^UPDATE app_settings SET value = \? WHERE setting_key = \? AND value = \?$/.test(q)) {
        if (S.settings.get(p[1]) !== p[2]) return { affectedRows: 0 };
        S.settings.set(p[1], p[0]); return { affectedRows: 1 };
      }
      if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(q)) { S.settings.delete(p[0]); return { affectedRows: 1 }; }
      if (/^DELETE FROM app_settings WHERE setting_key LIKE/.test(q)) return { affectedRows: 0 };
    }
    if (/FROM subscriptions WHERE phone_norm = \?$/.test(q)) return S.subs.filter((r) => r.phone_norm === p[0]).map((r) => Object.assign({}, r));
    if (/^SELECT order_id, email FROM orders WHERE order_id IN \(/.test(q)) {
      if (!/UPPER\(status\) = 'PAID'/.test(q) || !/UPPER\(fulfillment_status\) = 'FULFILLED'/.test(q)) throw new Error('orders query must require PAID + FULFILLED');
      return S.orders.filter((o) => p.includes(o.order_id) && o.status.toUpperCase() === 'PAID' && o.fulfillment_status.toUpperCase() === 'FULFILLED').map((o) => ({ order_id: o.order_id, email: o.email }));
    }
    throw new Error('unexpected SQL: ' + q);
  },
};
const accessWithLogins = (rows) => (rows.length > 1 ? { logins: rows.map((r, i) => ({ device: i + 1, user: r.login_id, pass: r.password })), sameLogin: false, deviceCount: rows.length } : {});
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './smtp') return { sendMail: async (m) => { if (S.mailFails) throw new Error('smtp down'); S.mails.push(m); return { ok: true }; } };
  if (req === './devicelogins') return { groupsReady: async () => S.groupsOn, accessWithLogins };
  return origLoad.apply(this, arguments);
};
const load = () => { delete require.cache[require.resolve('../recover')]; return require('../recover'); };
let recover = load();
const codeFrom = (m) => (String(m && m.subject).match(/(\d{6})/) || [])[1];
const wrongOf = (c) => (c === '111111' ? '222222' : '111111');
// Every refusal must look exactly the same: same keys, same words, nothing masked, nothing sent.
const refused = (r) => r && r.ok === false && r.noActive === true && r.message === NO_ACTIVE && Object.keys(r).sort().join() === 'message,noActive,ok' && !/\*/.test(JSON.stringify(r));
async function session(ph, em) {
  const s = await recover.sendOtp(ph, em);
  if (!s.ok && !s.wait) return { send: s };
  const mail = S.mails.filter((m) => m.to === em).pop(); // a code sent < 30 s ago is still the live one
  const v = await recover.verifyOtp(ph, em, codeFrom(mail));
  return { send: s, token: v.recoverToken };
}

(async () => {
  section('send code: good cases');
  let r = await recover.sendOtp('+91 98765 43210', '  ASHA.K@gmail.com ');
  ok('email on the subscription (+91 / spaces / capitals) → code sent', r.ok === true && S.mails.length === 1, r);
  ok('code emailed to the clean address', S.mails[0] && S.mails[0].to === 'asha.k@gmail.com', S.mails[0] && S.mails[0].to);
  ok('message names the masked typed email + Spam', /as\*+@gmail\.com/.test(r.message) && /Spam/.test(r.message), r.message);
  ok('resend wait returned (30 s)', r.resendInSec === 30);
  ok('the code is not in the answer', !JSON.stringify(r).includes(codeFrom(S.mails[0])));
  r = await recover.sendOtp('09876543210', 'asha.k@gmail.com');
  ok('asking again within 30 s: no second email, tells how long to wait', r.ok === false && r.wait > 0 && r.wait <= 30 && S.mails.length === 1, r);
  r = await recover.sendOtp('9000000001', 'yahya.old@gmail.com');
  ok('email only on the PAID + FULFILLED order for that sub → code sent', r.ok === true && S.mails.length === 2, r);
  ok('customer profile table is never read', !S.sql.some((q) => /FROM customers/.test(q)));

  section('send code: attacks and inactive plans → one generic answer, nothing sent');
  const mailsBefore = S.mails.length;
  const cases = [
    ['profile (customers) email on the victim phone', '9876543210', 'attacker@evil.com'],
    ['pending / created order email', '9000000002', 'pending@evil.com'],
    ['profile email of an expired customer', '9000000003', 'ravi.new@x.in'],
    ['expired subscription (right email)', '9000000003', 'ravi@x.in'],
    ['2-device purchase with Device 2 refunded (right email)', '9000000004', 'dev@x.in'],
    ['removed from the account (right email)', '9000000006', 'rem@x.in'],
    ['no plan at all on the number', '9111111111', 'x@y.com'],
    ['wrong email on a number with an active plan', '9000000001', 'someone@else.com'],
    ['no email saved anywhere', '9000000002', 'x@y.com'],
  ];
  const answers = [];
  for (const [name, ph, em] of cases) { r = await recover.sendOtp(ph, em); answers.push(JSON.stringify(r)); ok(name + ' → refused, generic', refused(r), r); }
  ok('every refusal is byte-for-byte the same (no hint / noPlan / wrongEmail)', new Set(answers).size === 1, [...new Set(answers)]);
  ok('no masked email or hint anywhere in the refusals', !answers.some((a) => /hint|looks like|\*|noPlan|wrongEmail|noEmail/.test(a)));
  ok('no email sent for any refusal', S.mails.length === mailsBefore, S.mails.length);
  r = await recover.sendOtp('12345', 'x@y.com');
  ok('short phone → clear message', r.ok === false && /10-digit/.test(r.message), r);
  r = await recover.sendOtp('9876543210', 'asha.gmail.com');
  ok('bad email → clear message', r.ok === false && /valid email/.test(r.message), r);

  section('later paid order with another email opens only its own plan');
  r = await recover.sendOtp('9000000001', 'yahya.new@gmail.com');
  ok('new email has an active plan of its own → code sent', r.ok === true, r);
  const newTok = (await recover.verifyOtp('9000000001', 'yahya.new@gmail.com', codeFrom(S.mails[S.mails.length - 1]))).recoverToken;
  r = await recover.listSubscriptions('9000000001', 'yahya.new@gmail.com', newTok);
  ok('list shows only the newer purchase (SUB-9)', r.ok && r.subscriptions.map((x) => x.subId).join() === 'SUB-9', r);
  r = await recover.getAccess('FF4', '9000000001', 'yahya.new@gmail.com', newTok);
  ok('older sub (by order id) refused, generic', refused(r), r);
  r = await recover.getAccess('SUB-4', '9000000001', 'yahya.new@gmail.com', newTok);
  ok('older sub (by sub id) refused, generic', refused(r), r);
  r = await recover.getAccess('FF10', '9000000001', 'yahya.new@gmail.com', newTok);
  ok('its own plan opens', r.ok && r.access.user === 'nf9@x', r);

  section('verify code + hashes');
  const ashaCode = codeFrom(S.mails[0]);
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', '12');
  ok('too short → asks for 6 digits (does not use a try)', r.ok === false && /6-digit/.test(r.message));
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', wrongOf(ashaCode));
  ok('wrong code → tries left', r.ok === false && /4 tries left/.test(r.message), r);
  r = await recover.verifyOtp('9111111111', 'x@y.com', '123456');
  ok('verify for a number that never got a code says nothing about the number', r.ok === false && r.expired && !/plan|email/i.test(r.message.replace('Send a new code', '')), r);
  const k = recover._internal.key('9876543210', 'asha.k@gmail.com');
  const storedRaw = S.settings.get(recover._internal.otpKey(k));
  const stored = JSON.parse(storedRaw);
  ok('code kept in app_settings, never the code itself', storedRaw && !storedRaw.includes(ashaCode));
  ok('hash is not plain SHA-256 of phone+email+code', stored.h !== crypto.createHash('sha256').update('otp|' + k + '|' + ashaCode).digest('hex'));
  const oldSecret = process.env.CACHE_CLEAR_KEY;
  process.env.CACHE_CLEAR_KEY = 'another-server-secret';
  const other = load();
  ok('hash is keyed by the server secret (HMAC)', other._internal.otpHash(k, ashaCode) !== recover._internal.otpHash(k, ashaCode));
  if (oldSecret == null) delete process.env.CACHE_CLEAR_KEY; else process.env.CACHE_CLEAR_KEY = oldSecret;

  // Hostinger restart: memory is gone, app_settings still has the code.
  recover = load();
  r = await recover.verifyOtp('+91 98765-43210', 'Asha.K@gmail.com', ' ' + ashaCode.slice(0, 3) + ' ' + ashaCode.slice(3));
  ok('restart mid-flow: the emailed code still works (any phone / email format)', r.ok === true && r.recoverToken, r);
  const token = r.recoverToken;
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', ashaCode);
  ok('a used code cannot be used again', r.ok === false && r.expired, r);

  section('list plans + show login');
  recover = load(); // restart again: the session token must survive too
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', token);
  ok('restart mid-flow: session survives, only the active plan is listed', r.ok === true && r.subscriptions.map((x) => x.subId).join() === 'SUB-1', r);
  ok('days left + readable date', r.ok && r.subscriptions[0].daysLeft === 10 && /\d{1,2} \w{3,4} \d{4}/.test(r.subscriptions[0].expiryText), r.subscriptions && r.subscriptions[0]);
  r = await recover.listSubscriptions('9876543210', 'other@gmail.com', token);
  ok('token is bound to the verified email', r.ok === false && r.sessionExpired);
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', 'nope');
  ok('bad token → timed-out message', r.ok === false && r.sessionExpired && /send a new code/.test(r.message));

  r = await recover.getAccess('FF1', '9876543210', 'asha.k@gmail.com', token);
  ok('active plan, email on the sub → login', r.ok && r.access.user === 'nf@x' && r.access.pass === 'pw1' && !r.postPaymentMessage, r);
  r = await recover.getAccess('SUB-2', '9876543210', 'asha.k@gmail.com', token);
  ok('ended + switched off → refused, generic, no old password', refused(r) && !JSON.stringify(r).includes('oldpw'), r);
  r = await recover.getAccess('FF3', '9876543210', 'asha.k@gmail.com', token);
  ok('refunded → refused, generic, no password', refused(r) && !JSON.stringify(r).includes('rpw'), r);
  r = await recover.getAccess('FF4', '9876543210', 'asha.k@gmail.com', token);
  ok('another phone\'s plan → refused, generic', refused(r), r);

  // refunded AFTER the code was verified: re-checked when the login is shown
  S.subs.find((x) => x.sub_id === 'SUB-1').fulfillment_status = 'REFUNDED';
  r = await recover.getAccess('FF1', '9876543210', 'asha.k@gmail.com', token);
  ok('refunded after verify → refused at "Show my login"', refused(r) && !JSON.stringify(r).includes('pw1'), r);
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', token);
  ok('…and the list is empty with the generic answer', refused(r), r);

  const y = await session('9000000001', 'yahya.old@gmail.com');
  r = await recover.getAccess('FF4', '9000000001', 'yahya.old@gmail.com', y.token);
  ok('paid-order email for that sub → opens; YouTube explains the family invite', r.ok && /family invite/.test(r.postPaymentMessage), r);
  r = await recover.getAccess('FF10', '9000000001', 'yahya.old@gmail.com', y.token);
  ok('old email does not open the newer purchase paid with another email', refused(r), r);

  const h = await session('9000000005', 'grp@x.in');
  r = await recover.listSubscriptions('9000000005', 'grp@x.in', h.token);
  ok('2-device purchase listed once (Device 1)', r.ok && r.subscriptions.length === 1 && r.subscriptions[0].subId === 'SUB-H1', r);
  r = await recover.getAccess('SUB-H2', '9000000005', 'grp@x.in', h.token);
  ok('every device shown, Device 1 first', r.ok && r.access.user === 'h1@x' && r.access.logins.length === 2 && r.access.logins[1].user === 'h2@x', r);
  S.subs.find((x) => x.sub_id === 'SUB-H2').removed = 1;
  r = await recover.getAccess('SUB-H1', '9000000005', 'grp@x.in', h.token);
  ok('Device 2 removed later → whole purchase refused (not just the first row)', refused(r) && !JSON.stringify(r).includes('hpw1'), r);

  section('attempt limit (atomic), expiry, email failure, no app_settings');
  reset(); recover = load();
  await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const c2 = codeFrom(S.mails[0]);
  for (let i = 0; i < 5; i++) await recover.verifyOtp('9876543210', 'asha.k@gmail.com', wrongOf(c2));
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c2);
  ok('6th try (even the right code) → send a new code', r.ok === false && r.expired && /new code/.test(r.message), r);
  recover = load();
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c2);
  ok('attempt limit is not reset by a restart', r.ok === false, r);

  reset(); recover = load();
  await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const c4 = codeFrom(S.mails[0]);
  recover = load(); // restart: every request now reads its own copy from the database
  S.interleave = true;
  const burst = await Promise.all(Array.from({ length: 20 }, () => recover.verifyOtp('9876543210', 'asha.k@gmail.com', wrongOf(c4))));
  S.interleave = false;
  const counted = burst.filter((x) => /That code is not right/.test(x.message)).length;
  ok('20 parallel wrong guesses after a restart → exactly 5 are checked', counted === 5, burst.map((x) => x.message));
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c4);
  ok('…and the right code no longer works', r.ok === false && r.expired, r);

  reset(); recover = load();
  await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const kk = recover._internal.key('9876543210', 'asha.k@gmail.com');
  recover._internal.otpStore.get(kk).exp = Date.now() - 1;
  const dbKey = recover._internal.otpKey(kk); S.settings.set(dbKey, JSON.stringify(Object.assign(JSON.parse(S.settings.get(dbKey)), { exp: Date.now() - 1 })));
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', codeFrom(S.mails[0]));
  ok('expired code → clear message', r.ok === false && r.expired && /expired/.test(r.message), r);

  reset(); recover = load(); S.mailFails = true;
  r = await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  ok('email failure → friendly retry message, no code stored', r.ok === false && /could not send/.test(r.message) && S.settings.size === 0, r);
  S.mailFails = false;
  r = await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  ok('…and the customer can retry straight away (no 30 s wait after a failure)', r.ok === true, r);

  reset(); recover = load(); S.settingsBroken = true;
  await recover.sendOtp('9876543210', 'asha.k@gmail.com');
  const c3 = codeFrom(S.mails[0]);
  for (let i = 0; i < 2; i++) await recover.verifyOtp('9876543210', 'asha.k@gmail.com', wrongOf(c3));
  r = await recover.verifyOtp('9876543210', 'asha.k@gmail.com', c3);
  ok('without app_settings: memory alone still works', r.ok === true, r);
  r = await recover.listSubscriptions('9876543210', 'asha.k@gmail.com', r.recoverToken);
  ok('…list works too', r.ok === true && r.subscriptions.length === 1);

  reset(); S.groupsOn = false; recover = load();
  const g = await session('9000000005', 'grp@x.in');
  r = await recover.getAccess('SUB-H2', '9000000005', 'grp@x.in', g.token);
  ok('before schema-v19: only the requested row', r.ok && r.access.user === 'h2@x' && !r.access.logins, r);

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
  ok('generic answer shows Help + Renew', /r\?\.noActive\) setRenewHint\(true\)/.test(src) && /ffOpenHelp_/.test(src) && /Renew in My plans/.test(src));
  ok('storefront uses the same generic words as the server', html.includes("const RECOVER_NO_ACTIVE_ = '" + NO_ACTIVE + "'") && /RECOVER_NO_ACTIVE_/.test(src));
  ok('no hint / noPlan / wrongEmail / "No plans found" left on the screen', !/noPlan|wrongEmail|noEmail|hints|looks like|No plans found/.test(src));
  ok('double tap guarded', /busy\.current/.test(src));
  ok('Input passes inputMode / autoComplete / maxLength', /inputMode: inputMode,\n\s+autoComplete: autoComplete,\n\s+maxLength: maxLength/.test(html));
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = 0; let bad = 0;
  for (const sc of scripts) {
    if (/^\s*[{[]/.test(sc)) { try { JSON.parse(sc); parsed++; continue; } catch (_) { /* not JSON: parse as JS */ } }
    try { new Function(sc); parsed++; } catch (e) { bad++; ok('script parses: ' + e.message, false); }
  }
  ok('every inline index.html <script> parses', parsed === scripts.length && bad === 0, { parsed, total: scripts.length });

  console.log('\nrecover: ' + pass + ' passed, ' + fail + ' failed');
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
