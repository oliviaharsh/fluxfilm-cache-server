/* Customer email from the support mailbox (smtp.js), Gmail fallback, admin email check. Run: npm test */
const fs = require('fs');
const path = require('path');
const smtp = require('../smtp');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const GMAIL = { IMAP_USER: 'owner@gmail.com', IMAP_PASS: 'abcd efgh ijkl mnop' };
const BOTH = Object.assign({ SMTP_USER: 'support@fluxfilm.in', SMTP_PASS: 'wxyz wxyz wxyz wxyz' }, GMAIL);

(async () => {
  // Which account sends.
  ok('no support mailbox set → Gmail sends (nothing changes before setup)', smtp.accounts(GMAIL).map((a) => a.user).join() === 'owner@gmail.com');
  ok('support mailbox set → support@ first, Gmail kept as fallback', smtp.accounts(BOTH).map((a) => a.kind + ':' + a.user).join() === 'support:support@fluxfilm.in,gmail:owner@gmail.com');
  ok('app password spaces removed', smtp.accounts(BOTH)[0].pass === 'wxyzwxyzwxyzwxyz');
  const half = Object.assign({ SMTP_PASS: 'x' }, GMAIL);
  ok('only SMTP_PASS set (no SMTP_USER) → still Gmail, and admin is warned', smtp.accounts(half)[0].kind === 'gmail' && smtp.status(half).supportHalfSet === true);
  const st = smtp.status(BOTH);
  ok('status never contains a password', !JSON.stringify(st).includes('wxyz') && !JSON.stringify(st).includes('abcd'));
  ok('status: sender, reply-to and fallback', st.sender === 'support@fluxfilm.in' && st.replyTo === 'support@fluxfilm.in' && st.fallback === 'owner@gmail.com' && st.senderKind === 'support');
  ok('nothing configured → skipped, not a crash', (await smtp.sendMail({ to: 'a@b.c', subject: 's', html: 'h' }, {})).skipped === 'smtp not configured');

  // Sending with a fake transport.
  let sent = []; let refuse = {};
  smtp._internal.setTransportFactory((acc) => ({ sendMail: async (m) => { if (refuse[acc.user]) throw refuse[acc.user]; sent.push(Object.assign({ via: acc.user }, m)); } }));
  let r = await smtp.sendMail({ to: 'cust@x.com', subject: 'Access', html: '<b>hi</b>' }, BOTH);
  ok('sent from "FluxFilm" <support@fluxfilm.in> with reply-to support', r.ok && !r.fellBack && sent[0].from === '"FluxFilm" <support@fluxfilm.in>' && sent[0].replyTo === 'support@fluxfilm.in' && sent[0].to === 'cust@x.com');
  sent = []; refuse = { 'support@fluxfilm.in': Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH' }) };
  r = await smtp.sendMail({ to: 'cust@x.com', subject: 'Access', html: 'h' }, BOTH);
  ok('support login refused → same email re-sent from Gmail (customer still gets access)', r.ok && r.fellBack && sent.length === 1 && sent[0].via === 'owner@gmail.com');
  const le = smtp.status(BOTH).lastError;
  ok('…and the failure is shown to admin', le && /535/.test(le.message) && le.sender === 'support@fluxfilm.in');
  sent = []; refuse = { 'support@fluxfilm.in': Object.assign(new Error('550 5.1.1 recipient address rejected'), { code: 'EENVELOPE', responseCode: 550 }) };
  let threw = null; try { await smtp.sendMail({ to: 'bad@x.com', subject: 's', html: 'h' }, BOTH); } catch (e) { threw = e; }
  ok('a bad customer address is NOT re-sent from Gmail (would fail the same)', threw && sent.length === 0);
  sent = []; refuse = { 'support@fluxfilm.in': Object.assign(new Error('Invalid login'), { code: 'EAUTH' }), 'owner@gmail.com': Object.assign(new Error('Invalid login'), { code: 'EAUTH' }) };
  threw = null; try { await smtp.sendMail({ to: 'c@x.com', subject: 's', html: 'h' }, BOTH); } catch (e) { threw = e; }
  ok('both logins refused → error thrown (callers already log it / show "try again")', !!threw);
  refuse = {}; sent = [];
  r = await smtp.sendMail({ to: 'c@x.com', subject: 's', html: 'h' }, Object.assign({ SMTP_FROM_NAME: 'FluxFilm "Support"<x>', SMTP_REPLY_TO: 'help@fluxfilm.in' }, BOTH));
  ok('custom sender name is sanitised; custom reply-to used', sent[0].from === '"FluxFilm Supportx" <support@fluxfilm.in>' && sent[0].replyTo === 'help@fluxfilm.in', sent[0]);

  // Every customer email goes through smtp.js; reading bank / OTP mail stays on IMAP_USER.
  for (const f of ['mailer.js', 'recover.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(f + ': sends only via smtp.js (no own transport, no IMAP_USER sender)', /require\('\.\/smtp'\)/.test(src) && !/createTransport/.test(src) && !/IMAP_USER/.test(src));
  }
  for (const f of ['payments.js', 'otp.js']) ok(f + ': still reads mail with IMAP_USER', /process\.env\.IMAP_USER/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));

  // mailer.js end to end with the fake transport (env from process).
  const KEYS = ['SMTP_USER', 'SMTP_PASS', 'IMAP_USER', 'IMAP_PASS', 'SMTP_FROM_NAME', 'SMTP_REPLY_TO'];
  const saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, BOTH); smtp._internal.reset(); sent = [];
  const mailer = require('../mailer');
  r = await mailer.sendAccessEmail({ email: 'cust@x.com', name: 'A', service: 'Netflix', plan: 'Private 1M', orderId: 'FF1', access: { user: 'u', pass: 'p' } });
  ok('access email goes out from support@', r.ok && sent.length === 1 && sent[0].from.includes('support@fluxfilm.in') && /Netflix/.test(sent[0].subject));
  r = await mailer.sendRenewalReminder({ email: 'cust@x.com', service: 'Netflix', plan: 'Private 1M', expiryText: '1 Oct', daysLeft: 2 });
  ok('reminder email goes out from support@', r.ok && sent.length === 2 && sent[1].from.includes('support@fluxfilm.in'));
  ok('no email address → skipped', (await mailer.sendAccessEmail({ email: '' })).skipped === 'no email');
  for (const k of Object.keys(BOTH)) delete process.env[k];
  ok('mailer with nothing configured → skipped', (await mailer.send('c@x.com', 's', 'h')).skipped === 'smtp not configured');
  for (const k of KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];

  // Admin routes.
  const routes = {}; const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  const audits = []; let authed = true;
  const fakeSmtp = { status: () => smtp.status(BOTH), sendMail: async (m) => { sent.push(m); return { ok: true, sender: 'support@fluxfilm.in', fellBack: false }; } };
  require('../adminmail').mount(app, { auth: (req, res) => { if (!authed) res.status(401).json({ ok: false }); return authed; }, audit: { record: (req, a) => audits.push(a) }, smtp: fakeSmtp });
  const call = async (k, body) => { const out = { code: 200 }; const res = { status: (c) => { out.code = c; return res; }, json: (j) => { out.body = j; } }; await routes[k]({ body }, res); return out; };
  let o = await call('GET /admin/api/email/status');
  ok('admin status: sender shown, no password', o.body.ok && o.body.sender === 'support@fluxfilm.in' && !JSON.stringify(o.body).includes('wxyz'));
  o = await call('POST /admin/api/email/test', { to: 'not-an-email' });
  ok('test email: bad address refused', o.code === 400 && !o.body.ok);
  sent = [];
  o = await call('POST /admin/api/email/test', { to: 'owner@gmail.com' });
  ok('test email: sent + change log', o.body.ok && sent.length === 1 && sent[0].to === 'owner@gmail.com' && audits.some((a) => a.action === 'email.test'));
  authed = false; o = await call('POST /admin/api/email/test', { to: 'owner@gmail.com' });
  ok('test email needs the admin key', o.code === 401);

  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin.js mounts adminmail', /require\('\.\/adminmail'\)\.mount\(app/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')));
  ok('🔔 Notifications view shows the email sender card + test button', /pnLoad\(\); mailLoad\(\);/.test(admin) && /function mailTest\(btn\)/.test(admin) && /\/admin\/api\/email\/test/.test(admin));
  const scripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log(e.message); } }
  ok('admin.html scripts parse', scripts.length > 0 && parsed);

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
