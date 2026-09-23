/* Email-code engine (otpaccess.js) shared by Get OTP, Games and Refunds + Get OTP storefront / server wiring. Run: npm test
   Attack cases: getotp-security.test.js (Get OTP) and games-refunds-email.test.js (Games, Refunds). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const P = '9876543210';
const settings = new Map();
const mockDb = {
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/FROM customers/.test(sql)) throw new Error('profile email must never be read: ' + sql);
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings.has(p[0]) ? [{ value: settings.get(p[0]) }] : [];
    if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) { if (settings.has(p[0])) { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; } settings.set(p[0], p[1]); return { affectedRows: 1 }; }
    if (/^UPDATE app_settings SET value = \? WHERE setting_key = \? AND value = \?$/.test(sql)) { if (settings.get(p[1]) !== p[2]) return { affectedRows: 0 }; settings.set(p[1], p[0]); return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings/.test(sql)) { settings.delete(p[0]); return { affectedRows: 1 }; }
    throw new Error('unmocked SQL: ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
process.env.OTP_ACCESS_SECRET = 'test-secret';
const access = require('../otpaccess');

(async () => {
  const sent = [];
  const mailer = { send: async (to, subject, html) => { sent.push({ to, subject, html }); return { ok: true }; } };
  const codeFrom = () => (sent[sent.length - 1].subject.match(/(\d{6})$/) || [])[1];
  const allowed = new Set(['me@x.com']);
  const eligible = async (ph, match) => ph === P && [...allowed].some((e) => match(e));
  const opts = { mailer, eligible, tool: 'Test tool', noMessage: 'GENERIC NO' };

  let r = await access.sendEmailCode('games', P, 'me@x.com', { mailer });
  ok('a tool without an email rule never sends a code', !r.ok && sent.length === 0, r);
  r = await access.sendEmailCode('games', P, 'someone@x.com', opts);
  ok('email not allowed → the tool\'s generic message, no email', !r.ok && r.noActive && r.message === 'GENERIC NO' && sent.length === 0, r);
  r = await access.sendEmailCode('games', P, 'not-an-email', opts);
  ok('not an email → asks for a valid email', !r.ok && /valid email/.test(r.message) && sent.length === 0, r);
  r = await access.sendEmailCode('games', P, 'ME@x.com', opts);
  ok('allowed email → code sent to that typed email, tool name in the mail, no hint in the answer', r.ok && sent.length === 1 && sent[0].to === 'me@x.com' && /Test tool/.test(sent[0].html) && /^\d{6}$/.test(codeFrom()) && !/me@|\*/.test(r.message), r);
  r = await access.sendEmailCode('games', P, 'me@x.com', opts);
  ok('tapping again within 45 s does not send a second email', r.ok && sent.length === 1);
  const code = codeFrom();
  r = await access.verifyEmailCode('refund', P, 'me@x.com', code, opts);
  ok('a code sent for one tool (games) does not work for another (refund)', !r.ok, r);
  r = await access.verifyEmailCode('games', '9222222222', 'me@x.com', code, opts);
  ok('code only works for the number it was sent for', !r.ok);
  r = await access.verifyEmailCode('games', P, 'other@x.com', code, opts);
  ok('code only works with the email it was sent to', !r.ok);
  r = await access.verifyEmailCode('games', P, 'me@x.com', code === '000000' ? '111111' : '000000', opts);
  ok('wrong code → tries left shown', !r.ok && /4 tries left/.test(r.message), r);
  allowed.clear();
  r = await access.verifyEmailCode('games', P, 'me@x.com', code, opts);
  ok('right code, but the email stopped being allowed meanwhile → generic no, no token', !r.ok && !r.token && r.message === 'GENERIC NO', r);
  allowed.add('me@x.com');
  settings.clear(); access._internal.mem.clear();
  await access.sendEmailCode('games', P, 'me@x.com', opts);
  r = await access.verifyEmailCode('games', P, 'me@x.com', codeFrom(), opts);
  ok('right code → otp2 token for 30 days', r.ok && /^otp2\.9876543210\.[0-9a-f]{32}\.\d+\./.test(r.token) && Date.parse(r.expiresAt) > Date.now() + 29 * 86400e3, r);
  const token = r.token;
  const m = access.tokenMatcher(token, P);
  ok('tokenMatcher: says yes only for the verified email', !!m && m('me@x.com') && !m('other@x.com'));
  ok('tokenMatcher: another phone, a tampered or an old otp1 token → null', access.tokenMatcher(token, '9000000000') === null && access.tokenMatcher(token.slice(0, -2) + 'xx', P) === null && access.tokenMatcher('otp1.' + P + '.' + (Date.now() + 1e6) + '.sig', P) === null);
  process.env.OTP_ACCESS_SECRET = 'rotated';
  ok('changing a server secret signs all devices out', access.tokenMatcher(token, P) === null);
  process.env.OTP_ACCESS_SECRET = 'test-secret';
  ok('old profile-email API is gone', !access.sendCode && !access.verifyCode && !access.check && !access.verifyToken && !access.makeToken);

  settings.clear(); access._internal.mem.clear();
  const failMailer = { send: async () => { throw new Error('SMTP down'); } };
  r = await access.sendEmailCode('games', P, 'me@x.com', Object.assign({}, opts, { mailer: failMailer }));
  ok('email failure → clear message, no half-made code left', !r.ok && /try again/.test(r.message) && ![...settings.keys()].some((k) => /^gotp_c_/.test(k)), r);

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const card = html.slice(html.indexOf('function OtpVerifyCard('), html.indexOf('function OtpScreen('));
  ok('storefront Get OTP sends its own device token + the plan it is for', /apiCall_\('getLatestOtp', \[service, phone, getGetOtpToken_\(phone\), String\(subRef \|\| ''\)\]/.test(html) && /sub\?\.subId \|\| sub\?\.orderId \|\| ''\);/.test(html));
  ok('"Confirm it’s you" asks the customer to TYPE their email; no masked email hint', /API\.otpSendCode\(phone, em,/.test(card) && /label: "Your email"/.test(card) && !/maskedEmail/.test(card) && /setGetOtpToken_\(phone, r\)/.test(card));
  ok('storefront asks for the email code when the token is missing, or when this plan is not unlocked by it', /if \(r\.needsVerify \|\| r\.noActive\) \{/.test(html));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: Get OTP uses the email-checked code + token, rate limits stay', /otptool\.getLatestOtp\(a\[0\], a\[1\], typeof a\[2\] === 'string' \? a\[2\] : '', typeof a\[3\] === 'string' \? a\[3\] : '', null, req\)/.test(server) &&
    /sendGetOtpCode\(String\(a\[0\] \|\| ''\), String\(a\[1\] \|\| ''\)\)/.test(server) && /verifyGetOtpCode\(ph, em, code\)/.test(server) &&
    /otpSendCode: security\.rateLimiter\(4, 60 \* 60e3\)/.test(server) && /otpVerifyCode: security\.rateLimiter\(12, 15 \* 60e3\)/.test(server));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
