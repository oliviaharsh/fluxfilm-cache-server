/* Get OTP — Zee5 / JioHotstar / SonyLIV mail matching (16 Sep 2026).
   The bug: every run of 10+ digits counted as "the number this code was sent to", so a forwarder timestamp,
   a helpline or a reference id looked like another customer's phone and the code was refused (PR #111, 15 Sep).
   Here: real codes come back, another customer's number is still never shown, the time window is an admin
   setting, and the admin diagnostics / self-test say why nothing was found. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n== ' + t);

// ---------------- in-memory MySQL ----------------
const ZEE = '9812345678';        // the Zee5 login this customer's plan is on
const OTHER = '9876500011';      // another Zee5 login (another customer)
const HOT = '9000000001';
const SONY = '9000000007';
const DB = { settings: new Map(), otpLog: [], writes: [] };
const mockDb = {
  query: async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT service, login_id, is_active FROM inventory_accounts/.test(sql)) {
      return [
        { service: 'Zee5 Premium', login_id: ZEE, is_active: 'TRUE' },
        { service: 'Zee5 Premium', login_id: OTHER, is_active: 'TRUE' },
        { service: 'JioHotstar', login_id: HOT, is_active: 'TRUE' },
        { service: 'SonyLiv Premium', login_id: SONY, is_active: 'TRUE' },
      ];
    }
    if (/^SELECT DISTINCT service, login_id FROM subscriptions/.test(sql)) return [];
    if (/^SELECT COUNT\(\*\) n FROM sms_otp_log/.test(sql)) return [{ n: DB.otpLog.length }];
    if (/^INSERT INTO sms_otp_log/.test(sql)) { DB.otpLog.push({ service: p[0], otp: p[1], phone: p[2], message: p[3] }); return { affectedRows: 1 }; }
    if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return DB.settings.has(p[0]) ? [{ value: DB.settings.get(p[0]) }] : [];
    if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE/.test(sql)) { DB.settings.set(p[0], p[1]); DB.writes.push(p[0]); return { affectedRows: 1 }; }
    if (/getotp_fallback_count/.test(sql)) { DB.settings.set('getotp_fallback_count', p[0]); return { affectedRows: 1 }; }
    throw new Error('unexpected SQL: ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
process.env.IMAP_USER = 'shop@x.com'; process.env.IMAP_PASS = 'imap';
const otp = require('../otp');
const { pickOtpMail, loginsIn, extractOtp, mobileLast10, explainMail, serviceOfMail, newDiag, validateSettings } = otp._internal;

const now = Date.now();
const W = 10 * 60e3;
const mail = (uid, minsAgo, text, subject) => ({ uid, date: new Date(now - minsAgo * 60e3), subject: subject || 'SMSForwarder', text });

/* Realistic forwarded bodies. The SMS Forwarder app puts its own header on top; some phones add a
   "Received At" stamp, some SMS carry a helpline number, an amount or a reference id. */
const Z = 'SMSForwarder\nFrom : VM-ZEEOTT-S()\n';
const J = 'SMSForwarder\nFrom : VM-JIOHTR-S()\n';
const S = 'SMSForwarder\nFrom : VM-LIVOTP-S()\n';

const zeeAllowed = new Set(['p:' + ZEE]);
const zeeKnown = new Set(['p:' + ZEE, 'p:' + OTHER]);
const pick = (text, opts) => pickOtpMail([mail(1, 1, text)], Object.assign({ keywords: ['zee5', 'zeeott'], allowed: zeeAllowed, known: zeeKnown, now, windowMs: W }, opts || {}));

(async () => {
  section('Zee5: the code comes back (the 15 Sep number rule used to refuse these)');
  const good = [
    ['plain Zee5 mail, 4-digit code', Z + 'Your OTP is: 4725 for ZEE5. Do not share it with anyone.', '4725'],
    ['plain Zee5 mail, 6-digit code', Z + 'Your OTP is: 472518 for ZEE5 login. Valid for 10 mins.', '472518'],
    ['forwarder stamp dd-mm-yyyy hh:mm:ss', Z + 'Received At : 16-09-2026 21:45:03\nYour OTP is: 472518 for ZEE5 login.', '472518'],
    ['forwarder stamp yyyy-mm-dd hh:mm:ss', Z + 'Received At : 2026-09-16 21:45:03\nYour OTP is: 472518 for ZEE5 login.', '472518'],
    ['helpline number in the SMS', Z + 'Your OTP is: 472518. Need help? Call 1800 103 1051. ZEE5', '472518'],
    ['long reference id in the SMS', Z + 'Your OTP is: 472518. Ref 20260916213344 ZEE5', '472518'],
    ['an amount and a date in the SMS', Z + 'Your OTP is: 472518 for Rs 1499.00 paid on 16/09/2026 at 21 45 ZEE5', '472518'],
    ['the number written masked (xxxxx45678)', Z + 'Your OTP is: 472518 for ZEE5 account xxxxx45678', '472518'],
    ['names THIS plan login, +91 with spaces', Z + 'Your OTP is: 472518 for ZEE5 account +91 98123 45678', '472518'],
    ['names THIS plan login, 91 with dashes', Z + 'Your OTP is: 472518 sent to 91-98123-45678', '472518'],
    ['names THIS plan login, plain 10 digits', Z + 'Your OTP is: 472518 sent to ' + ZEE, '472518'],
    ['names THIS plan login with a 0 in front', Z + 'Your OTP is: 472518 sent to 0' + ZEE, '472518'],
  ];
  for (const [label, body, code] of good) {
    const hit = pick(body);
    ok('Zee5 — ' + label, !!hit && hit.otp === code, { hit, body: body.replace(/\n/g, ' ') });
  }

  section('Safety: another customer\'s number is still never shown');
  const bad = [
    ['names another Zee5 login of ours, with a cue', Z + 'Your OTP is: 472518 sent to ' + OTHER],
    ['names another Zee5 login of ours, bare in the text', Z + 'Your OTP is: 472518 ' + OTHER + ' ZEE5'],
    ['names an unknown mobile after "to"', Z + 'Your OTP is: 472518. To +91-90000-00009'],
    ['names an unknown mobile after "SIM"', Z + 'Your OTP is: 472518 SIM 9000000009'],
    ['names an unknown mobile after "login"', Z + 'Your OTP is: 135790 login 9000000009'],
  ];
  for (const [label, body] of bad) ok('refused — ' + label, pick(body) === null, body.replace(/\n/g, ' '));
  ok('a JioHotstar mail is never returned for Zee5', pick(J + '482913 is your JioHotstar verification code.') === null);
  ok('a phone number is never read as the code', (pick(Z + 'ZEE5 code for +91 98123-45678 : 4321') || {}).otp === '4321');
  ok('an email login of another account still refuses the mail',
    pickOtpMail([mail(2, 1, S + 'sonyliv OTP is 5566 for other@acct.com')], { keywords: ['sonyliv', 'livotp'], allowed: new Set(['e:me@acct.com']), known: new Set(['e:me@acct.com', 'e:other@acct.com']), now, windowMs: W }) === null);

  section('What counts as a recipient number');
  ok('10 digits starting 6-9 is a mobile', mobileLast10('9812345678') === '9812345678' && mobileLast10('6812345678') === '6812345678');
  ok('91 / 0 / 091 in front is the same mobile', mobileLast10('919812345678') === '9812345678' && mobileLast10('09812345678') === '9812345678' && mobileLast10('0919812345678') === '9812345678');
  ok('a date stamp is not a mobile', mobileLast10('1609202621') === '' && mobileLast10('2026091621') === '');
  ok('a helpline / a long id is not a mobile', mobileLast10('18001031051') === '' && mobileLast10('20260916213344') === '');
  ok('a number with no recipient cue is ignored', loginsIn('Your OTP is: 472518. Order 9812349999 done', new Set()).found.size === 0);
  ok('  ...but one of OUR logins counts even with no cue', loginsIn('Your OTP is: 472518 ' + OTHER, zeeKnown).found.has('p:' + OTHER));
  ok('the ignored numbers are listed for the admin', loginsIn('Received At : 16-09-2026 21:45:03', new Set()).ignored.length === 1);
  ok('numbers are blanked before the code is read', !/98123/.test(loginsIn('sent to ' + ZEE + ' code 4321', zeeKnown).cleaned));

  section('JioHotstar and SonyLIV keep working');
  const jHit = pickOtpMail([mail(3, 1, J + 'Received At : 16-09-2026 21:45:03\n482913 is your JioHotstar verification code.')], { keywords: ['jiohotstar', 'jiohtr'], allowed: new Set(['p:' + HOT]), known: new Set(['p:' + HOT]), now, windowMs: W });
  ok('JioHotstar mail with a forwarder stamp → code shown', !!jHit && jHit.otp === '482913' && jHit.matchedBy === 'fallback', jHit);
  const sHit = pickOtpMail([mail(4, 1, S + '16-09-2026 21:45:03\nYour SonyLIV OTP is 903214. Valid for 10 minutes.')], { keywords: ['sonyliv', 'livotp'], allowed: new Set(['p:' + SONY]), known: new Set(['p:' + SONY]), now, windowMs: W });
  ok('SonyLIV mail with a stamp → code shown', !!sHit && sHit.otp === '903214', sHit);
  const jStrict = pickOtpMail([mail(5, 1, J + '929292 is your JioHotstar code. Sent to 9000000002'), mail(6, 2, J + '828282 is your JioHotstar code. Sent to ' + HOT)],
    { keywords: ['jiohotstar', 'jiohtr'], allowed: new Set(['p:' + HOT]), known: new Set(['p:' + HOT, 'p:9000000002']), now, windowMs: W });
  ok('once the forwarder adds the SIM number, the newer mail for another login is still skipped', !!jStrict && jStrict.otp === '828282' && jStrict.matchedBy === 'login', jStrict);

  section('The time window');
  ok('the default is 10 minutes', validateSettings({ windowMin: 10 }).ok === true && (await otp.getSettings()).windowMin === 10);
  ok('4 minutes is refused', validateSettings({ windowMin: 4 }).ok === false);
  ok('31 minutes is refused', validateSettings({ windowMin: 31 }).ok === false);
  ok('a word is refused', validateSettings({ windowMin: 'soon' }).ok === false);
  ok('12 minutes is fine', validateSettings({ windowMin: 12 }).ok === true && validateSettings({ windowMin: '12' }).settings.windowMin === 12);
  ok('a 12-minute-old mail is too old for a 10-minute window', pickOtpMail([mail(7, 12, Z + 'Your OTP is: 424242')], { keywords: ['zee5', 'zeeott'], allowed: zeeAllowed, known: zeeKnown, now, windowMs: W }) === null);
  ok('  ...and fine for a 20-minute window', (pickOtpMail([mail(7, 12, Z + 'Your OTP is: 424242')], { keywords: ['zee5', 'zeeott'], allowed: zeeAllowed, known: zeeKnown, now, windowMs: 20 * 60e3 }) || {}).otp === '424242');
  const saved = await otp.saveSettings({ windowMin: 25 });
  ok('the owner can save 25 minutes (app_settings, no schema change)', saved.ok === true && saved.settings.windowMin === 25 && JSON.parse(DB.settings.get('getotp_settings')).windowMin === 25, saved);
  ok('a bad value is refused with a clear message', (await otp.saveSettings({ windowMin: 99 })).message === 'Use between 5 and 30 minutes.');

  section('Admin diagnostics: why nothing was shown');
  const diag = newDiag();
  pickOtpMail([
    mail(10, 1, Z + 'Your OTP is: 111111 sent to ' + OTHER),
    mail(11, 2, Z + 'Your OTP is: 222222. To 9000000009'),
    mail(12, 3, Z + 'Your OTP is: 333333 SIM 9000000008'),
    mail(13, 14, Z + 'Your OTP is: 444444'),
    mail(14, 1, J + '482913 is your JioHotstar verification code.'),
  ], { keywords: ['zee5', 'zeeott'], allowed: zeeAllowed, known: zeeKnown, now, windowMs: W, diag });
  ok('counts: 3 Zee5 mails seen, 3 rejected for the number, 1 too old, 1 for another service, 0 shown',
    diag.seen === 3 && diag.numberMismatch === 3 && diag.tooOld === 1 && diag.otherService === 1 && diag.shown === 0, diag);
  ok('the lines say when and why, with the numbers masked', diag.lines.length === 5 && diag.lines.every((l) => typeof l.minsAgo === 'number' && !!l.reason) &&
    JSON.stringify(diag.lines).indexOf(OTHER) === -1 && /••••••/.test(JSON.stringify(diag.lines)), diag.lines);
  const diag2 = newDiag();
  pickOtpMail([mail(15, 1, Z + 'Your OTP is: 555555')], { keywords: ['zee5', 'zeeott'], allowed: zeeAllowed, known: zeeKnown, now, windowMs: W, diag: diag2 });
  ok('a shown code is counted too', diag2.seen === 1 && diag2.shown === 1 && diag2.numberMismatch === 0, diag2);

  section('Admin self-test (paste a mail)');
  let x = explainMail({ text: Z + 'Received At : 16-09-2026 21:45:03\nYour OTP is: 472518 for ZEE5 login.', known: zeeKnown });
  ok('a good Zee5 mail → shown, code read, no number, the stamp listed as ignored',
    x.verdict === 'shown' && x.service === 'Zee5' && x.otp === '472518' && x.numbers.length === 0 && x.ignored.length === 1, x);
  x = explainMail({ text: Z + 'Your OTP is: 472518 sent to ' + OTHER, known: new Set(['p:' + ZEE]) });
  ok('a mail for another login → refused, and the number is masked', x.verdict === 'refused' && /not one of your/.test(x.reason) && JSON.stringify(x).indexOf(OTHER) === -1, x);
  x = explainMail({ text: Z + 'Your OTP is: 472518 sent to ' + ZEE, known: zeeKnown });
  ok('a mail for one of our logins → shown', x.verdict === 'shown' && x.numbers.length === 1 && /one of your Zee5 logins/.test(x.reason), x);
  x = explainMail({ text: 'Hello, your parcel is on the way.', known: new Set() });
  ok('a mail that is not an OTP mail → refused with a clear reason', x.verdict === 'refused' && /No OTP service/.test(x.reason), x);
  ok('nothing pasted → a clear message', explainMail({ text: '' }).ok === false);
  ok('the service is worked out from the words', serviceOfMail(Z) === 'Zee5' && serviceOfMail(J) === 'JioHotstar' && serviceOfMail(S) === 'SonyLIV' && serviceOfMail('hello') === '');
  const st = await otp.adminSelfTest({ text: Z + 'Your OTP is: 472518 sent to ' + ZEE });
  ok('the self-test uses the real logins of that service', st.verdict === 'shown' && st.logins === 2, st);

  section('End to end: a customer taps Get OTP for Zee5');
  const access = {
    NO_ACTIVE: 'No active plan found for this number.',
    checkGetOtp: async () => ({ ok: true, eh: 'hash' }),
    unlockedForToken: async () => [{ lead: { service: 'Zee5 Premium' }, rows: [{ sub_id: 'S1', order_id: 'O1', login_id: ZEE }] }],
  };
  const parse = async (m) => ({ subject: m.subject, text: m.text });
  const searches = [];
  const imapWith = (mails, flags) => async (fn) => fn({
    getMailboxLock: async () => ({ release() {} }),
    // Gmail matches the subject as a substring; `seen: false` means unread only.
    search: async (crit) => {
      searches.push(crit || {});
      return mails.filter((m) => (!crit || !crit.subject || String(m.subject || '').includes(crit.subject))
        && (!crit || crit.seen !== false || !m.read)).map((m) => m.uid);
    },
    fetch: async function* (uids) { for (const m of mails) if (uids.includes(m.uid)) yield { uid: m.uid, internalDate: m.date, source: m }; },
    messageFlagsAdd: async (q) => { flags.push(q.uid); },
  });
  await otp.saveSettings({ windowMin: 10 });
  let flags = [];
  let r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([mail(20, 2, Z + 'Received At : 16-09-2026 21:45:03\nYour OTP is: 472518 for ZEE5 login.')], flags) });
  ok('the Zee5 code is returned again and the mail is marked read', r.found === true && r.otp === '472518' && flags.join() === '20', r);
  const rec = JSON.parse(DB.settings.get('getotp_diag_zee5') || '{}');
  ok('the run is written to the admin diagnostics', rec.service === 'Zee5' && rec.seen === 1 && rec.shown === 1 && rec.windowMin === 10, rec);
  ok('the diagnostics hold no customer data', JSON.stringify(rec).indexOf('9111111111') === -1 && JSON.stringify(rec).indexOf(ZEE) === -1, rec);

  flags = [];
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([mail(21, 2, Z + 'Your OTP is: 999999 sent to ' + OTHER)], flags) });
  ok('another customer\'s Zee5 code is never returned', r.found === false && !flags.length && !/999999/.test(JSON.stringify(r)), r);
  const rec2 = JSON.parse(DB.settings.get('getotp_diag_zee5') || '{}');
  ok('  ...and the owner sees why: 1 seen, 1 number mismatch', rec2.seen === 1 && rec2.numberMismatch === 1 && rec2.shown === 0, rec2);

  flags = [];
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([mail(22, 14, Z + 'Your OTP is: 313131')], flags) });
  ok('a 14-minute-old mail is too old for the 10-minute window', r.found === false && /~10 min/.test(r.message), r);
  await otp.saveSettings({ windowMin: 20 });
  flags = [];
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([mail(23, 14, Z + 'Your OTP is: 313131')], flags) });
  ok('  ...and it is used once the owner sets the window to 20 minutes', r.found === true && r.otp === '313131', r);
  await otp.saveSettings({ windowMin: 10 });

  section('Admin panel');
  const adm = fs.readFileSync(path.join(__dirname, '..', 'adminotpdevices.js'), 'utf8');
  for (const route of ['/admin/api/otp-diagnostics', '/admin/api/otp-settings', '/admin/api/otp-selftest']) {
    ok('route ' + route + ' is mounted and admin-only', adm.indexOf(route) !== -1 && new RegExp(route.replace(/\//g, '\\/') + "'[\\s\\S]{0,120}auth\\(req, res\\)").test(adm));
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('📱 OTP devices has the 🔎 Get OTP check box', /🔎 Get OTP check/.test(html) && /odchkbody/.test(html));
  ok('  ...with the time-window setting', /data-odwin/.test(html) && /otp-settings/.test(html));
  ok('  ...the diagnostics line (seen / rejected / too old)', /rejected \(number mismatch\)/.test(html) && /too old/.test(html));
  ok('  ...and the paste-a-mail self-test', /data-odself/.test(html) && /otp-selftest/.test(html));
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type=["'](?!text\/javascript)/.test(m[1]));
  let badScripts = 0;
  for (const m of scripts) { try { new Function(m[2]); } catch (e) { badScripts++; console.log('  script error:', e.message); } }
  ok('every inline <script> in admin.html parses (' + scripts.length + ')', scripts.length > 0 && badScripts === 0);

  console.log('\n---------------------------------------');
    // 🔎 18 Sep: the live diagnostics showed a JioHotstar run with 0 mails SEEN. The mail search itself was the
  // blind spot — one fixed subject ("SMSForwarder") and unread-only — so a forwarder app with its own subject, or a
  // mail the owner had already opened, looked exactly like "no OTP arrived".
  const adminHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'admin.html'), 'utf8');
  section('the mail search itself: a different forwarder subject, and already-read mails');
  flags = []; searches.length = 0;
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([mail(30, 2, Z + 'Your OTP is: 314159 for ZEE5', 'SMS Mail Bridge')], flags) });
  ok('a forwarder that calls its mails "SMS Mail Bridge" is found too', r.found === true && r.otp === '314159', r);
  flags = []; searches.length = 0;
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([mail(31, 2, Z + 'Your OTP is: 271828 for ZEE5', 'my own forwarder app')], flags) });
  ok('an unknown subject: found on the second look, with no subject filter at all', r.found === true && r.otp === '271828' && searches.length > 1 && searches[searches.length - 1].subject === undefined, searches);
  let rec9 = JSON.parse(DB.settings.get('getotp_diag_zee5') || '{}');
  ok('  ...and the owner is told, with the subject his forwarder uses (digits blanked)', rec9.looseSearch === true && rec9.mailsFound === 1 && rec9.subjects.join() === 'my own forwarder app', rec9);
  flags = []; searches.length = 0;
  const readMail = mail(32, 2, Z + 'Your OTP is: 161803 for ZEE5');
  readMail.read = true;
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([readMail], flags) });
  ok('a mail the owner had already opened on his phone is still used', r.found === true && r.otp === '161803', r);
  flags = []; searches.length = 0;
  r = await otp.getLatestOtp('Zee5 Premium', '9111111111', 'tok', 'S1', { access, parse, now, withImap: imapWith([], flags) });
  rec9 = JSON.parse(DB.settings.get('getotp_diag_zee5') || '{}');
  ok('no mail at all → said plainly in the diagnostics (the phone stopped forwarding)', r.found === false && rec9.mailsFound === 0 && rec9.looseSearch === false && rec9.seen === 0, rec9);
  ok('the panel spells both out: nothing arrived, or only found without the subject filter', /No mail at all<\/b> reached us/.test(adminHtml) && /only found <b>without<\/b> the subject filter/.test(adminHtml) && /OTP_SUBJECTS/.test(adminHtml));

console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
