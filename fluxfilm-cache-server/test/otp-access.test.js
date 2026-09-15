/* Email code → device token. Legacy otp1 code (Games / Refunds) + storefront / server wiring of Get OTP. Run: npm test
   The Get OTP attack cases (profile email, pending order, expired, refunded, another account's OTP) are in getotp-security.test.js. */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const P = '9876543210';
let customers = [{ phone_norm: P, email: 'rahul.sharma@gmail.com' }];
let subEmail = [];
const mockDb = {
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT email FROM customers WHERE phone_norm = \?/.test(sql)) return customers.filter((c) => c.phone_norm === p[0]);
    if (/^SELECT email FROM subscriptions WHERE phone_norm = \?/.test(sql)) return subEmail;
    return [];
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
process.env.OTP_ACCESS_SECRET = 'test-secret';
const access = require('../otpaccess');

(async () => {
  const sent = [];
  const mailer = { send: async (to, subject, html) => { sent.push({ to, subject, html }); return { ok: true }; } };
  const codeFrom = () => (sent[sent.length - 1].subject.match(/(\d{6})$/) || [])[1];
  const paid = new Set([P]);
  const deps = { mailer, tool: 'FluxFilm Games', eligible: async (ph) => paid.has(ph) };

  let r = await access.sendCode(P, { mailer });
  ok('legacy code without an eligible() rule is refused (old Get OTP path is gone)', !r.ok && sent.length === 0, r);
  r = await access.sendCode('9111111111', deps);
  ok('number that is not eligible → no email sent', !r.ok && sent.length === 0);
  r = await access.sendCode(P, deps);
  ok('Games code emailed', r.ok && sent.length === 1 && /^\d{6}$/.test(codeFrom()), r);
  r = await access.sendCode(P, deps);
  ok('tapping again within 45 s does not spam a second email', r.ok && sent.length === 1);
  r = await access.verifyCode(P, '000000' === codeFrom() ? '111111' : '000000');
  ok('wrong code refused', !r.ok && !r.token);
  r = await access.verifyCode('9222222222', codeFrom());
  ok('code only works for the number it was sent for', !r.ok);
  r = await access.verifyCode(P, codeFrom());
  ok('right code → device token valid ~30 days', r.ok && /^otp1\.9876543210\.\d+\./.test(r.token) && Date.parse(r.expiresAt) > Date.now() + 29 * 86400e3, r);
  const token = r.token;
  ok('token unlocks this phone (Games / Refunds)', access.verifyToken(token, P) === true);
  ok('token does not unlock another phone', access.verifyToken(token, '9000000000') === false);
  ok('otp1 token is NOT a Get OTP token', access.checkGetOtp(P, token).ok === false);
  r = await access.verifyCode(P, codeFrom());
  ok('a code works only once', !r.ok);
  process.env.OTP_ACCESS_SECRET = 'rotated';
  ok('changing the secret signs all devices out', access.verifyToken(token, P) === false);
  process.env.OTP_ACCESS_SECRET = 'test-secret';
  const t2 = access._internal.makeToken2(P, 'a@b.c').token;
  ok('a Get OTP (otp2) token also counts for Games / Refunds', access.verifyToken(t2, P) === true && access.verifyToken(t2, '9000000000') === false);

  access._internal.codes.clear();
  await access.sendCode(P, deps);
  let last;
  for (let i = 0; i < 6; i++) last = await access.verifyCode(P, '123456' === codeFrom() ? '654321' : '123456');
  ok('after 5 wrong tries the code is thrown away', last.expired === true);
  r = await access.verifyCode(P, codeFrom());
  ok('  ...even the right code no longer works', !r.ok);

  customers = []; subEmail = [];
  access._internal.codes.clear();
  r = await access.sendCode(P, deps);
  ok('no email on file → no code sent', !r.ok && r.noEmail === true);
  const failMailer = { send: async () => { throw new Error('SMTP down'); } };
  subEmail = [{ email: 'from.sub@example.com' }];
  access._internal.codes.clear();
  r = await access.sendCode(P, Object.assign({}, deps, { mailer: failMailer }));
  ok('email failure → clear message, no half-made code left', !r.ok && /try again/.test(r.message) && !access._internal.codes.has(P));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const card = html.slice(html.indexOf('function OtpVerifyCard('), html.indexOf('function OtpScreen('));
  ok('storefront Get OTP sends its own device token + the plan it is for', /apiCall_\('getLatestOtp', \[service, phone, getGetOtpToken_\(phone\), String\(subRef \|\| ''\)\]/.test(html) && /sub\?\.subId \|\| sub\?\.orderId \|\| ''\);/.test(html));
  ok('"Confirm it’s you" asks the customer to TYPE their email; no masked email hint', /API\.otpSendCode\(phone, em,/.test(card) && /label: "Your email"/.test(card) && !/maskedEmail/.test(card) && /setGetOtpToken_\(phone, r\)/.test(card));
  ok('storefront asks for the email code when the token is missing, or when this plan is not unlocked by it', /if \(r\.needsVerify \|\| r\.noActive\) \{/.test(html));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: Get OTP uses the email-checked code + token, rate limits stay', /otptool\.getLatestOtp\(a\[0\], a\[1\], typeof a\[2\] === 'string' \? a\[2\] : '', typeof a\[3\] === 'string' \? a\[3\] : ''\)/.test(server) &&
    /sendGetOtpCode\(String\(a\[0\] \|\| ''\), String\(a\[1\] \|\| ''\)\)/.test(server) && /verifyGetOtpCode\(/.test(server) &&
    /otpSendCode: security\.rateLimiter\(4, 60 \* 60e3\)/.test(server) && /otpVerifyCode: security\.rateLimiter\(12, 15 \* 60e3\)/.test(server));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
