/* Get OTP security (15 Sep 2026): only ACTIVE plans (India date), code only to an email on THAT plan or its PAID +
   FULFILLED order, one generic "no", attempts + send cap in the DB (atomic, survive restart), HMAC-hashed codes,
   and only an OTP mail for THAT plan's login from the last 10 minutes. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n== ' + t);

const IST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayPlus = (n) => IST.format(new Date(Date.now() + n * 86400e3));
const P = '9876543210';

// ---------------- in-memory MySQL ----------------
const DB = {
  customers: [{ phone_norm: P, email: 'attacker@evil.com' }], // profile email: anyone can write it
  subs: [], orders: [], inventory: [], settings: new Map(), otpLog: [], down: false, queries: [],
};
function resetData() {
  DB.subs = [
    // S1 JioHotstar: email on the sub row; its order O1 is PAID + FULFILLED with another email
    { sub_id: 'S1', order_id: 'O1', email: 'sub@x.com', service: 'JioHotstar', login_id: '9000000001', expiry_date: dayPlus(10) + ' 12:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 },
    // S2 Zee5: no sub email; order O2 is still CREATED (unpaid)
    { sub_id: 'S2', order_id: 'O2', email: '', service: 'Zee5 Premium', login_id: '9000000005', expiry_date: dayPlus(20) + ' 12:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 },
    // S3 SonyLIV older plan, order O3 paid (old@x.com). O4 is a LATER paid order (later@x.com) for S4 (JioHotstar).
    { sub_id: 'S3', order_id: 'O3', email: '', service: 'SonyLiv Premium', login_id: '9000000007', expiry_date: dayPlus(5) + ' 12:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 },
    { sub_id: 'S4', order_id: 'O4', email: '', service: 'JioHotstar', login_id: '9000000002', expiry_date: dayPlus(30) + ' 12:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 },
    // S5 expired yesterday
    { sub_id: 'S5', order_id: 'O5', email: 'exp@x.com', service: 'JioHotstar', login_id: '9000000001', expiry_date: dayPlus(-1) + ' 23:00:00', status: 'EXPIRED', fulfillment_status: 'FULFILLED', removed: 0 },
    // G6: 2-device purchase, device 2 refunded
    { sub_id: 'S6a', order_id: 'O6', email: 'grp@x.com', service: 'JioHotstar', login_id: '9000000001', expiry_date: dayPlus(9) + ' 12:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0, group_id: 'G6', group_index: 1 },
    { sub_id: 'S6b', order_id: 'O6', email: 'grp@x.com', service: 'JioHotstar', login_id: '9000000002', expiry_date: dayPlus(9) + ' 12:00:00', status: 'REFUNDED', fulfillment_status: 'REFUNDED', removed: 0, group_id: 'G6', group_index: 2 },
    // S7 removed by admin
    { sub_id: 'S7', order_id: 'O7', email: 'rem@x.com', service: 'JioHotstar', login_id: '9000000001', expiry_date: dayPlus(9) + ' 12:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 1 },
    // S8 expires TODAY; its time has already passed (00:00:01) and subexpiry.js already marked it EXPIRED
    { sub_id: 'S8', order_id: 'O8', email: 'today@x.com', service: 'Zee5 Premium', login_id: '9000000005', expiry_date: dayPlus(0) + ' 00:00:01', status: 'EXPIRED', fulfillment_status: 'FULFILLED', removed: 0 },
    // S9 cancelled
    { sub_id: 'S9', order_id: 'O9', email: 'cancel@x.com', service: 'Zee5 Premium', login_id: '9000000005', expiry_date: dayPlus(9) + ' 12:00:00', status: 'CANCELLED', fulfillment_status: 'FULFILLED', removed: 0 },
  ];
  DB.orders = [
    { order_id: 'O1', email: 'paid@x.com', status: 'PAID', fulfillment_status: 'FULFILLED' },
    { order_id: 'O2', email: 'pending@x.com', status: 'CREATED', fulfillment_status: 'PENDING' },
    { order_id: 'O3', email: 'old@x.com', status: 'PAID', fulfillment_status: 'FULFILLED' },
    { order_id: 'O4', email: 'later@x.com', status: 'PAID', fulfillment_status: 'FULFILLED' },
    { order_id: 'O10', email: 'pendingpaid@x.com', status: 'PAID', fulfillment_status: 'PENDING' },
  ];
  DB.inventory = [
    { service: 'JioHotstar', login_id: '9000000001', is_active: 'TRUE' },
    { service: 'JioHotstar', login_id: '9000000002', is_active: 'TRUE' },
    { service: 'JioHotstar', login_id: '9000000003', is_active: 'FALSE' },
    { service: 'Zee5 Premium', login_id: '9000000005', is_active: 'TRUE' },
    { service: 'SonyLiv Premium', login_id: '9000000007', is_active: 'TRUE' },
  ];
}
resetData();
const dupErr = () => { const e = new Error("Duplicate entry for key 'PRIMARY'"); e.code = 'ER_DUP_ENTRY'; return e; };
const mockDb = {
  query: async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    DB.queries.push(sql);
    await new Promise((r) => setImmediate(r)); // real async gaps, so parallel calls interleave
    if (/app_settings/.test(sql) && DB.down) throw new Error('connect ECONNREFUSED');
    if (/information_schema/.test(sql)) return [{ n: 4 }];
    if (/FROM customers/.test(sql)) throw new Error('Get OTP must never read the customers profile email: ' + sql);
    if (/^SELECT sub_id, order_id, email, service, login_id, expiry_date, status, fulfillment_status/.test(sql)) return DB.subs.filter((r) => (r.phone_norm || P) === p[0]).map((r) => Object.assign({}, r));
    if (/^SELECT order_id, email FROM orders WHERE order_id IN/.test(sql)) {
      ok('orders query only takes PAID + FULFILLED', /UPPER\(status\) = 'PAID' AND UPPER\(fulfillment_status\) = 'FULFILLED'/.test(sql));
      return DB.orders.filter((o) => p.includes(o.order_id) && o.status === 'PAID' && o.fulfillment_status === 'FULFILLED');
    }
    if (/^SELECT service, login_id, is_active FROM inventory_accounts/.test(sql)) return DB.inventory;
    if (/^SELECT DISTINCT service, login_id FROM subscriptions/.test(sql)) return DB.subs.filter((r) => IST.format(new Date(Date.now() - 3 * 86400e3)) <= r.expiry_date.slice(0, 10));
    if (/sms_otp_log/.test(sql) && /^SELECT COUNT/.test(sql)) return [{ n: DB.otpLog.filter((x) => x.phone === p[0] && x.service === p[1]).length }];
    if (/^INSERT INTO sms_otp_log/.test(sql)) { DB.otpLog.push({ service: p[0], otp: p[1], phone: p[2] }); return { affectedRows: 1 }; }
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return DB.settings.has(p[0]) ? [{ value: DB.settings.get(p[0]) }] : [];
    if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) { if (DB.settings.has(p[0])) throw dupErr(); DB.settings.set(p[0], p[1]); return { affectedRows: 1 }; }
    if (/^UPDATE app_settings SET value = \? WHERE setting_key = \? AND value = \?$/.test(sql)) {
      if (DB.settings.get(p[1]) !== p[2]) return { affectedRows: 0 };
      DB.settings.set(p[1], p[0]); return { affectedRows: 1 };
    }
    if (/^DELETE FROM app_settings WHERE setting_key = \?$/.test(sql)) { DB.settings.delete(p[0]); return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key LIKE/.test(sql)) return { affectedRows: 0 };
    throw new Error('unexpected SQL: ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
process.env.DB_PASS = 'db-pass-test'; process.env.CACHE_CLEAR_KEY = 'ck'; process.env.IMAP_PASS = 'imap'; delete process.env.OTP_ACCESS_SECRET;

const fresh = () => {
  for (const m of ['../otpaccess', '../otp', '../devicelogins']) delete require.cache[require.resolve(m)];
  return { access: require('../otpaccess'), otp: require('../otp') };
};
let { access, otp } = fresh();
const NO = access.NO_ACTIVE;

const sent = [];
const mailer = { send: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; } };
const lastCode = (to) => { const m = sent.filter((x) => x.to === to).pop(); return m ? (m.subject.match(/(\d{6})$/) || [])[1] : ''; };
const clearState = () => { DB.settings.clear(); access._internal.mem.clear(); };

async function verifyAs(email) {
  clearState();
  const s = await access.sendGetOtpCode(P, email, { mailer });
  if (!s.ok) return { send: s };
  const v = await access.verifyGetOtpCode(P, email, lastCode(email.replace(/\s+/g, '').toLowerCase()));
  return { send: s, verify: v, token: v.token };
}

// ---------------- fake IMAP ----------------
function imapWith(mails, flags) {
  return async (fn) => fn({
    getMailboxLock: async () => ({ release() {} }),
    search: async () => mails.map((m) => m.uid),
    fetch: async function* (uids) { for (const m of mails) if (uids.includes(m.uid)) yield { uid: m.uid, internalDate: m.date, source: m }; },
    messageFlagsAdd: async (q) => { flags.push(q.uid); },
  });
}
const mail = (uid, minsAgo, text, subject) => ({ uid, date: new Date(Date.now() - minsAgo * 60e3), subject: subject || 'SMSForwarder', text });
const parse = async (m) => ({ subject: m.subject, text: m.text });

(async () => {
  section('Attack: who gets a code');
  const refused = [];
  const tryEmail = async (label, email) => {
    clearState();
    const before = sent.length;
    const r = await access.sendGetOtpCode(P, email, { mailer });
    refused.push(r);
    ok(label + ' → refused with the generic message, no email sent', !r.ok && r.noActive === true && r.message === NO && sent.length === before, r);
  };
  await tryEmail('profile email (customers table, no login needed to change it)', 'attacker@evil.com');
  await tryEmail('email of an unpaid CREATED / PENDING order', 'pending@x.com');
  await tryEmail('email of a PAID order that is not fulfilled (and not linked)', 'pendingpaid@x.com');
  await tryEmail('email on an expired plan', 'exp@x.com');
  await tryEmail('email on a purchase with one device refunded', 'grp@x.com');
  await tryEmail('email on a removed plan', 'rem@x.com');
  await tryEmail('email on a cancelled plan', 'cancel@x.com');
  await tryEmail('an email that is nowhere', 'nobody@x.com');
  clearState();
  let r = await access.sendGetOtpCode('9111111111', 'sub@x.com', { mailer });
  ok('the right email on a different phone number → same generic message', !r.ok && r.message === NO, r);
  ok('no "no" answer carries an email hint', refused.every((x) => !('maskedEmail' in x) && !('email' in x) && !/\*/.test(JSON.stringify(x))));
  ok('"no plan" and "wrong email" look exactly the same', new Set(refused.map((x) => JSON.stringify(x))).size === 1, refused.map((x) => x.message));

  section('Good: sub email, paid order email, expiry today');
  let v = await verifyAs('sub@x.com');
  ok('email saved on the subscription → code sent to that email → otp2 token', v.send.ok && sent[sent.length - 1].to === 'sub@x.com' && /^otp2\.9876543210\.[0-9a-f]{32}\.\d+\./.test(v.token || ''), v);
  ok('success message has no email hint either', !/\*|@/.test(v.send.message), v.send);
  const tokSub = v.token;
  v = await verifyAs('PAID@x.com ');
  ok('email of the PAID + FULFILLED order that created the plan (case / spaces ignored) → token', !!v.token, v);
  const tokPaid = v.token;
  v = await verifyAs('today@x.com');
  ok('plan whose expiry date is TODAY (time passed, marked EXPIRED) still works', !!v.token, v);
  const tokToday = v.token;
  // 23:00 India time on the expiry day
  const today23 = Date.parse(dayPlus(0) + 'T23:00:00+05:30');
  const rows23 = [{ expiry_date: dayPlus(0) + ' 10:00:00', status: 'EXPIRED' }];
  ok('expiry today at 10:00, checked at 23:00 India time → still active', access._internal.rowBlocked(rows23[0], today23) === false);
  ok('  ...and the next day at 00:05 → ended', access._internal.rowBlocked(rows23[0], today23 + 65 * 60e3) === true);
  ok('expiry as a Date object (mysql2) uses the India date', access._internal.expiryDay(new Date(Date.parse(dayPlus(0) + 'T23:30:00+05:30'))) === dayPlus(0));
  clearState();
  r = await access.sendGetOtpCode(P, 'today@x.com', { mailer, now: today23 });
  ok('send code at 23:00 on the expiry day → sent', r.ok === true, r);

  section('Attack: an email only unlocks its own plans');
  v = await verifyAs('later@x.com');
  ok('later paid order email gets a token (it owns S4)', !!v.token, v);
  const tokLater = v.token;
  const denyOtp = async (label, svc, tok, ref) => {
    let touched = false;
    const res = await otp.getLatestOtp(svc, P, tok, ref || '', { withImap: async () => { touched = true; return {}; }, parse });
    ok(label, res.found === false && res.noActive === true && res.message === NO && !touched, res);
  };
  await denyOtp('later order email does NOT unlock the older SonyLIV plan (S3)', 'SonyLIV', tokLater);
  await denyOtp('sub email token does not unlock Zee5 (S2 belongs to an unpaid order)', 'Zee5', tokSub);
  await denyOtp('later email + S1 ref (a JioHotstar plan it does not own) → refused', 'JioHotstar', tokLater, 'S1');
  // the plan gets refunded after the device was verified
  DB.subs.find((x) => x.sub_id === 'S1').fulfillment_status = 'REFUNDED';
  await denyOtp('token stops working at once when the plan is refunded', 'JioHotstar', tokSub);
  DB.subs.find((x) => x.sub_id === 'S1').fulfillment_status = 'FULFILLED';
  DB.subs.find((x) => x.sub_id === 'S1').removed = 1;
  await denyOtp('  ...or removed', 'JioHotstar', tokPaid);
  DB.subs.find((x) => x.sub_id === 'S1').removed = 0;
  DB.subs.find((x) => x.sub_id === 'S1').expiry_date = dayPlus(-1) + ' 20:00:00';
  await denyOtp('  ...or expired (yesterday)', 'JioHotstar', tokSub);
  resetData();
  let res = await otp.getLatestOtp('JioHotstar', P, access.makeToken(P).token, '', { withImap: async () => { throw new Error('no'); }, parse });
  ok('old otp1 token (made from the profile email) → must verify again', res.needsVerify === true && !('maskedEmail' in res) && !/\*/.test(res.message), res);

  section('Codes: hashed, attempts atomic, survive restart');
  clearState();
  await access.sendGetOtpCode(P, 'sub@x.com', { mailer });
  const code = lastCode('sub@x.com');
  const stored = [...DB.settings.entries()];
  ok('code record is in app_settings (gotp_…) and never holds the code or the email', stored.length === 2 && stored.every(([k, val]) => /^gotp_[cn]_[0-9a-f]{40}$/.test(k) && k.length <= 64 && val.indexOf(code) === -1 && !/sub@x\.com|9876543210/.test(k + val)), stored);
  ok('code hash is an HMAC (64 hex)', /"h":"[0-9a-f]{64}"/.test(stored.find(([k]) => /gotp_c_/.test(k))[1]));
  const wrong = code === '111111' ? '222222' : '111111';
  const par = await Promise.all(Array.from({ length: 12 }, () => access.verifyGetOtpCode(P, 'sub@x.com', wrong)));
  const rec = DB.settings.get(access._internal.codeKey(P, 'sub@x.com'));
  ok('12 parallel wrong guesses: never more than 5 counted', par.filter((x) => /not right/.test(x.message)).length <= 5 && (!rec || JSON.parse(rec).tries <= 5), { par: par.map((x) => x.message), rec });
  r = await access.verifyGetOtpCode(P, 'sub@x.com', code);
  ok('  ...then even the right code is refused', !r.ok && !r.token, r);

  clearState();
  await access.sendGetOtpCode(P, 'sub@x.com', { mailer });
  const code2 = lastCode('sub@x.com');
  for (let i = 0; i < 3; i++) await access.verifyGetOtpCode(P, 'sub@x.com', code2 === '333333' ? '444444' : '333333');
  ({ access, otp } = fresh()); // Hostinger restart: memory gone, DB kept
  r = await access.verifyGetOtpCode(P, 'sub@x.com', code2 === '333333' ? '444444' : '333333');
  ok('after a restart the tries continue (4th wrong try → 1 left)', /1 try left/.test(r.message), r);
  r = await access.verifyGetOtpCode(P, 'sub@x.com', code2);
  ok('  ...and the right code still works after the restart', r.ok === true && !!r.token, r);
  r = await access.verifyGetOtpCode(P, 'sub@x.com', code2);
  ok('a code works only once', !r.ok);
  r = await access.verifyGetOtpCode(P, 'other@x.com', code2);
  ok('a code only works with the email it was sent to', !r.ok);

  clearState();
  const sends = [];
  for (let i = 0; i < 6; i++) sends.push(await access.sendGetOtpCode(P, 'nobody' + i + '@x.com', { mailer }));
  ({ access, otp } = fresh());
  r = await access.sendGetOtpCode(P, 'sub@x.com', { mailer });
  ok('7th try in an hour (wrong emails count) is refused, even after a restart', sends.every((x) => x.noActive) && r.ok === false && r.rateLimited === true, r);
  clearState();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => access.sendGetOtpCode(P, 'x' + i + '@x.com', { mailer })));
  ok("10 parallel sends: exactly 6 pass the cap", burst.filter((x) => !x.rateLimited).length === 6, { b: burst.map((x) => x.rateLimited ? "RL" : x.noActive ? "NO" : x.message), s: [...DB.settings.values()] });
  clearState();
  const nSent = sent.length;
  await access.sendGetOtpCode(P, 'sub@x.com', { mailer });
  r = await access.sendGetOtpCode(P, 'sub@x.com', { mailer });
  ok('tapping again within 45 s does not send a second email', sent.length === nSent + 1 && r.ok === true, r);
  clearState();
  DB.down = true;
  r = await access.sendGetOtpCode(P, 'sub@x.com', { mailer });
  const c3 = lastCode('sub@x.com');
  const r2 = await access.verifyGetOtpCode(P, 'sub@x.com', c3);
  DB.down = false;
  ok('app_settings down → memory fallback still works', r.ok && r2.ok && !!r2.token, { r, r2 });

  section('Which OTP mail is returned');
  ({ access, otp } = fresh());
  const flags = [];
  const J1 = 'SMSForwarder From : VM-JIOHTR-S() ';
  const tokS1 = (await verifyAs('sub@x.com')).token;
  res = await otp.getLatestOtp('JioHotstar', P, tokS1, 'S1', { parse, withImap: imapWith([
    mail(1, 1, J1 + '482913 is your JioHotstar verification code. Sent to +91 90000 00002'),
    mail(2, 2, J1 + '777111 is your JioHotstar verification code. To 9000000001'),
  ], flags) });
  ok("another account's newer OTP (login …0002) is skipped; this plan's login …0001 OTP is returned", res.found === true && res.otp === '777111' && flags.join() === '2', { res, flags });
  flags.length = 0;
  res = await otp.getLatestOtp('JioHotstar', P, tokS1, 'S1', { parse, withImap: imapWith([mail(3, 1, J1 + '555666 is your JioHotstar verification code.')], flags) });
  ok('JioHotstar has 2 logins in use: a mail that does not say which → not shown, customer told to tap Help', res.found === false && /could not match/.test(res.message) && !flags.length, res);
  res = await otp.getLatestOtp('JioHotstar', P, tokS1, 'S1', { parse, withImap: imapWith([mail(4, 11, J1 + '123123 is your JioHotstar verification code. 9000000001')], flags) });
  ok('11-minute-old mail for the right login → too old, not shown', res.found === false && !flags.length, res);
  res = await otp.getLatestOtp('JioHotstar', P, tokS1, 'S1', { parse, withImap: imapWith([mail(5, 1, 'SMSForwarder From : VM-ZEEOTT-S() Your OTP is: 909090 for 9000000001')], flags) });
  ok('a Zee5 mail is never returned for JioHotstar', res.found === false && !flags.length, res);
  const tokToday2 = (await verifyAs('today@x.com')).token;
  res = await otp.getLatestOtp('Zee5', P, tokToday2, 'S8', { parse, withImap: imapWith([mail(6, 2, 'SMSForwarder From : VM-ZEEOTT-S() Your OTP is: 246810')], flags) });
  ok('Zee5 has ONE login in use: mail without a number is fine (plan expiring today)', res.found === true && res.otp === '246810', res);
  res = await otp.getLatestOtp('Zee5', P, tokToday2, 'S8', { parse, withImap: imapWith([mail(7, 1, 'SMSForwarder From : VM-ZEEOTT-S() Your OTP is: 135790 login 9000000009')], flags) });
  ok('  ...but a Zee5 mail naming a login that is not this plan’s is refused', res.found === false, res);
  ok('phone numbers in a mail are never read as the OTP', otp._internal.pickOtpMail([mail(8, 1, 'jiohotstar code for +91 90000-00001 : 4321')], { keywords: ['jiohotstar'], allowed: new Set(['p:9000000001']), known: new Set(['p:9000000001']), now: Date.now(), windowMs: 600e3 }).otp === '4321');
  ok('email logins are matched too', otp._internal.pickOtpMail([mail(9, 1, 'sonyliv OTP is 5566 for other@acct.com')], { keywords: ['sonyliv'], allowed: new Set(['e:me@acct.com']), known: new Set(['e:me@acct.com', 'e:other@acct.com']), now: Date.now(), windowMs: 600e3 }) === null);
  ok('the OTP log never stores the phone of another customer', DB.otpLog.every((x) => x.phone === P));

  section('Storefront');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type=["'](?!text\/javascript)/.test(m[1]));
  let bad = 0;
  for (const m of scripts) { try { new Function(m[2]); } catch (e) { bad++; console.log('  script error:', e.message); } }
  ok('every inline <script> in index.html parses (' + scripts.length + ')', scripts.length > 0 && bad === 0);
  const card = html.slice(html.indexOf('function OtpVerifyCard('), html.indexOf('function OtpScreen('));
  ok('Get OTP card: no masked email, no "we don\'t have an email" branch', !/maskedEmail|hasEmail/.test(card));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
