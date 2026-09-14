/* Get OTP: prove it's the customer (email code → 30-day device token) before any OTP is read. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const P = '9876543210';
let customers = [{ phone_norm: P, email: 'rahul.sharma@gmail.com' }];
let subsActive = true; let subEmail = [];
const mockDb = {
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT email FROM customers WHERE phone_norm = \?/.test(sql)) return customers.filter((c) => c.phone_norm === p[0]);
    if (/^SELECT email FROM subscriptions WHERE phone_norm = \?/.test(sql)) return subEmail;
    if (/^SELECT 1 FROM subscriptions WHERE phone_norm = \? AND UPPER\(status\) = 'ACTIVE'/.test(sql)) return subsActive && p[0] === P ? [{ 1: 1 }] : [];
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

  let r = await access.check(P, '');
  ok('no token → needs verify, masked email shown', !r.ok && r.needsVerify && r.maskedEmail === 'ra******@gmail.com' && r.hasEmail === true, r);
  r = await access.sendCode('9111111111', { mailer });
  ok('number without an active plan → no email sent', !r.ok && sent.length === 0);
  r = await access.sendCode(P, { mailer });
  ok('code emailed to the account email (not typed by the caller)', r.ok && sent.length === 1 && sent[0].to === 'rahul.sharma@gmail.com' && /^\d{6}$/.test(codeFrom()), r);
  r = await access.sendCode(P, { mailer });
  ok('tapping again within 45 s does not spam a second email', r.ok && sent.length === 1);
  r = await access.verifyCode(P, '000000' === codeFrom() ? '111111' : '000000');
  ok('wrong code refused', !r.ok && !r.token);
  r = await access.verifyCode('9222222222', codeFrom());
  ok("code only works for the number it was sent for", !r.ok);
  r = await access.verifyCode(P, codeFrom());
  ok('right code → device token valid ~30 days', r.ok && /^otp1\.9876543210\.\d+\./.test(r.token) && Date.parse(r.expiresAt) > Date.now() + 29 * 86400e3, r);
  const token = r.token;
  ok('token unlocks this phone', (await access.check(P, token)).ok === true);
  ok('token does not unlock another phone', (await access.check('9000000000', token)).ok === false);
  r = await access.verifyCode(P, codeFrom());
  ok('a code works only once', !r.ok);
  process.env.OTP_ACCESS_SECRET = 'rotated';
  ok('changing the secret signs all devices out', (await access.check(P, token)).ok === false);
  process.env.OTP_ACCESS_SECRET = 'test-secret';

  access._internal.codes.clear();
  await access.sendCode(P, { mailer });
  let last;
  for (let i = 0; i < 6; i++) last = await access.verifyCode(P, '123456' === codeFrom() ? '654321' : '123456');
  ok('after 5 wrong tries the code is thrown away', last.expired === true);
  r = await access.verifyCode(P, codeFrom());
  ok('  ...even the right code no longer works', !r.ok);

  customers = []; subEmail = [];
  r = await access.check(P, '');
  ok('no email on file → tells them to use WhatsApp support', r.hasEmail === false && /WhatsApp/.test(r.message));
  access._internal.codes.clear();
  r = await access.sendCode(P, { mailer });
  ok('  ...and no code is sent', !r.ok && r.noEmail === true);
  subEmail = [{ email: 'from.sub@example.com' }];
  access._internal.codes.clear();
  r = await access.sendCode(P, { mailer });
  ok('falls back to the email on their subscription', r.ok && sent[sent.length - 1].to === 'from.sub@example.com');
  const failMailer = { send: async () => { throw new Error('SMTP down'); } };
  access._internal.codes.clear();
  r = await access.sendCode(P, { mailer: failMailer });
  ok('email failure → clear message, no half-made code left', !r.ok && /try again/.test(r.message) && !access._internal.codes.has(P));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('storefront sends the device token and shows the "Confirm it’s you" step', /apiCall_\('getLatestOtp', \[service, phone, getOtpToken_\(phone\)\]/.test(html) && /function OtpVerifyCard\(/.test(html) && /if \(r\.needsVerify\) \{/.test(html) && /setOtpToken_\(phone, r\)/.test(html));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server passes the token and rate-limits the code actions per IP and per phone', /otptool\.getLatestOtp\(a\[0\], a\[1\], a\[2\]\)/.test(server) && /otpSendCode: security\.rateLimiter\(4, 60 \* 60e3\)/.test(server) && /otpVerifyCode: security\.rateLimiter\(12, 15 \* 60e3\)/.test(server));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
