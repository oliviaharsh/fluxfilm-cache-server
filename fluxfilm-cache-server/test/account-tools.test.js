/* Password change (F5) + renewal reminders. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const pad = (v) => String(v).padStart(2, '0');
// India-time 'YYYY-MM-DD HH:MM:SS' n days from now
const ist = (n) => { const d = new Date(Date.now() + n * 86400000 + 5.5 * 3600e3); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':00'; };

const ACCOUNTS = [
  { service: 'Netflix', account_id: 'NF-03', login_id: 'Shared@x.com ', password: 'old', is_active: 'TRUE' },
  { service: 'Netflix', account_id: 'NF-03B', login_id: 'shared@x.com', password: 'old', is_active: 'TRUE' },
  { service: 'Prime Video', account_id: 'PRI-09', login_id: 'shared@x.com', password: 'prime-pass', is_active: 'TRUE' },
];
const SUBS = [
  { sub_id: 'A1', phone_norm: '9000000001', email: 'a1@x', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: ist(10), status: 'ACTIVE', inventory_ref: 'NF-03#P1', removed: 0, name: 'Asha' },
  { sub_id: 'A2', phone_norm: '9000000002', email: '', service: 'Netflix', plan: 'Private 1M', expiry_date: ist(3), status: 'ACTIVE', inventory_ref: 'NF-03B#P2', removed: 0, name: 'Bala' },
  { sub_id: 'E1', phone_norm: '9000000003', email: 'e1@x', service: 'Netflix', plan: 'Private 1M', expiry_date: ist(-2), status: 'ACTIVE', inventory_ref: 'NF-03#P3', removed: 0, name: 'Chen' },
  { sub_id: 'E2', phone_norm: '9000000004', email: 'e2@x', service: 'Netflix', plan: 'Private 1M', expiry_date: ist(-20), status: 'EXPIRED', inventory_ref: 'NF-03#P4', removed: 1, name: 'Dev' },
];
const calls = [];
let reminderRows = [];
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params });
    if (/^SELECT service, account_id, login_id, password, is_active FROM inventory_accounts WHERE service = \? AND account_id = \?/.test(sql)) return ACCOUNTS.filter((a) => a.service === params[0] && a.account_id === params[1]);
    if (/^SELECT service, account_id, is_active FROM inventory_accounts WHERE LOWER\(TRIM\(login_id\)\) = \? AND LOWER\(service\) LIKE \?/.test(sql)) {
      const fam = params[1].replace(/%/g, '');
      return ACCOUNTS.filter((a) => a.login_id.trim().toLowerCase() === params[0] && a.service.toLowerCase().includes(fam));
    }
    if (/FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm WHERE \(s.inventory_ref IN/.test(sql)) {
      const fam = params[params.length - 1].replace(/%/g, '');
      return SUBS.filter((x) => x.service.toLowerCase().includes(fam)).map((x) => Object.assign({}, x));
    }
    if (/^SELECT service, account_id, login_id, is_active FROM inventory_accounts/.test(sql)) return ACCOUNTS;
    if (/^UPDATE inventory_accounts SET password/.test(sql)) return { affectedRows: ACCOUNTS.filter((a) => a.login_id.trim().toLowerCase() === params[2] && a.service.toLowerCase().includes(params[3].replace(/%/g, ''))).length };
    if (/^UPDATE subscriptions SET removed = 1/.test(sql)) return { affectedRows: params.length };
    if (/FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm WHERE s.expiry_date BETWEEN/.test(sql) || /FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm WHERE s.sub_id IN/.test(sql)) {
      if (/sub_id IN/.test(sql)) return reminderRows.filter((r) => params.includes(r.sub_id));
      return reminderRows;
    }
    return { affectedRows: 1 };
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};
const sentMail = { pw: [], renew: [] };
const mailer = {
  sendPasswordChanged: async (p) => { sentMail.pw.push(p); return { ok: true }; },
  sendRenewalReminder: async (p) => { if (p.email === 'boom@x') throw new Error('SMTP down'); sentMail.renew.push(p); return { ok: true }; },
};

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), tools: { mailer } });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const last = (re) => [...calls].reverse().find((c) => re.test(c.sql));

  section('who a password change affects');
  let r = await get('/admin/api/accounts/impact?service=Netflix&account_id=NF-03');
  ok('same login on 2 Netflix rows grouped; Prime row with the same email NOT included', r.body.ok && r.body.sameLogin.map((a) => a.account_id).join() === 'NF-03,NF-03B', r.body.sameLogin);
  ok('active = still running (A1, A2); expired & not removed = E1 only (E2 already removed)', r.body.active.map((x) => x.subId).join() === 'A1,A2' && r.body.expired.map((x) => x.subId).join() === 'E1', r.body);
  ok('subscriptions matched by account ids, profile refs and login, within the service family', /s.inventory_ref LIKE \?/.test(last(/LEFT JOIN customers c ON c.phone_norm = s.phone_norm WHERE \(s.inventory_ref IN/).sql) && last(/WHERE \(s.inventory_ref IN/).params.includes('NF-03#%') && last(/WHERE \(s.inventory_ref IN/).params.slice(-1)[0] === '%netflix%');
  r = await get('/admin/api/accounts/impact?service=Netflix&account_id=NOPE');
  ok('unknown account -> 404', r.status === 404);

  section('password change');
  r = await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NF-03', password: '' });
  ok('empty password refused', r.status === 400);
  r = await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NF-03', password: 'old' });
  ok('same as saved password refused', r.status === 400 && /already/.test(r.body.message));
  calls.length = 0;
  r = await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NF-03', password: 'N3w#pass', tickExpired: true, emailActive: true });
  const accUpd = last(/^UPDATE inventory_accounts SET password/);
  const subUpd = last(/^UPDATE subscriptions SET password/);
  const tickUpd = last(/^UPDATE subscriptions SET removed = 1/);
  ok('every account row with this login in the family gets the new password (+ raw_json)', r.body.ok && accUpd.params[0] === 'N3w#pass' && /JSON_SET\(raw_json, '\$.Password'/.test(accUpd.sql) && accUpd.params[3] === '%netflix%' && r.body.accountRows === 2, r.body);
  ok('active customers get the new password saved', subUpd && subUpd.params[0] === 'N3w#pass' && subUpd.params.slice(2).join() === 'A1,A2');
  ok('expired customers ticked removed now, only if not already', tickUpd && /removed_at = NOW\(\)/.test(tickUpd.sql) && /COALESCE\(removed, 0\) = 0/.test(tickUpd.sql) && tickUpd.params.join() === 'E1' && r.body.expiredTicked === 1);
  ok('emails only active customers who have an email', r.body.email.sent === 1 && r.body.email.noEmail === 1 && sentMail.pw[0].email === 'a1@x' && sentMail.pw[0].password === 'N3w#pass' && sentMail.pw[0].login === 'Shared@x.com');
  ok('logged in reminder_log and the change log (without the password)', calls.some((c) => /^INSERT INTO reminder_log/.test(c.sql) && c.params[2] === 'PASSWORD_CHANGE') && calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'account.passwordChange' && !JSON.stringify(c.params).includes('N3w#pass')));
  ok('returns the active list for the AI agent copy', r.body.active.length === 2 && r.body.active[0].phone === '9000000001');
  calls.length = 0;
  r = await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NF-03', password: 'Another1', tickExpired: false });
  ok('tick box off -> expired customers left alone, no emails', r.body.ok && !last(/^UPDATE subscriptions SET removed = 1/) && r.body.email === null && sentMail.pw.length === 1);

  section('renewal reminders');
  reminderRows = [
    { sub_id: 'R1', phone_norm: '9000000011', email: 'r1@x', service: 'Netflix', plan: 'Private 1M', expiry_date: ist(2), status: 'ACTIVE', removed: 0, name: 'Esha', has_newer: 0, last_reminded: null },
    { sub_id: 'R2', phone_norm: '9000000012', email: '', service: 'Zee5', plan: '1 Month', expiry_date: ist(-3), status: 'ACTIVE', removed: 0, name: 'Faiz', has_newer: 0, last_reminded: null },
    { sub_id: 'R3', phone_norm: '9000000013', email: 'r3@x', service: 'Prime Video', plan: '1 Month', expiry_date: ist(-1), status: 'ACTIVE', removed: 0, name: 'Gita', has_newer: 0, last_reminded: '2026-09-13 10:00:00' },
    { sub_id: 'R4', phone_norm: '9000000014', email: 'r4@x', service: 'JioHotstar', plan: '3 Months', expiry_date: ist(-5), status: 'ACTIVE', removed: 0, name: 'Hari', has_newer: 1, last_reminded: null },
    { sub_id: 'R5', phone_norm: '9000000015', email: 'boom@x', service: 'Netflix', plan: 'Sharing 1M', expiry_date: ist(5), status: 'ACTIVE', removed: 0, name: 'Ira', has_newer: 0, last_reminded: null },
  ];
  r = await get('/admin/api/reminders?past=7&next=7');
  const q = last(/WHERE s.expiry_date BETWEEN/);
  ok('past 7 + next 7 days window', r.body.ok && q.params.join() === '7,7' && /NOW\(\) - INTERVAL \? DAY AND NOW\(\) \+ INTERVAL \? DAY/.test(q.sql));
  const R = (id) => r.body.rows.find((x) => x.subId === id);
  ok('days left / ended, reminded and already-renewed flags', R('R1').daysLeft === 2 && R('R2').daysLeft === -3 && !!R('R3').lastReminded && R('R4').hasNewer === true && R('R1').expiryText.length > 5, r.body.rows);
  await get('/admin/api/reminders?past=999&next=-5');
  ok('window clamped to 0-60 days', last(/WHERE s.expiry_date BETWEEN/).params.join() === '60,7');
  r = await post('/admin/api/reminders/email', { subIds: ['R1', 'R2', 'R3', 'R4', 'R5'] });
  ok('sends to R1; skips no email (R2), already reminded (R3), already renewed (R4); reports failure (R5)', r.body.ok && r.body.sent === 1 && r.body.noEmail === 1 && r.body.alreadyReminded === 1 && r.body.hasNewer === 1 && r.body.failed.length === 1 && sentMail.renew[0].email === 'r1@x', r.body);
  ok('reminder email has the date and days left', sentMail.renew[0].daysLeft === 2 && /\d{4}$/.test(sentMail.renew[0].expiryText));
  r = await post('/admin/api/reminders/email', { subIds: ['R3'], force: true });
  ok('force re-sends to someone already reminded', r.body.sent === 1);
  r = await post('/admin/api/reminders/email', { subIds: [] });
  ok('nobody picked -> 400', r.status === 400);
  r = await post('/admin/api/reminders/email', { subIds: Array.from({ length: 101 }, (_, i) => 'X' + i) });
  ok('max 100 emails at a time', r.status === 400);

  section('emails + panel');
  const mail = require('../mailer');
  ok('mailer exposes reminder + password emails', typeof mail.sendRenewalReminder === 'function' && typeof mail.sendPasswordChanged === 'function');
  const noSmtp = await mail.sendRenewalReminder({ email: '', service: 'Netflix' });
  ok('no email address -> skipped, not thrown', noSmtp.ok === false && noSmtp.skipped === 'no email');
  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel parses and has Password change + Reminders screens', parsed && /function passwordView\(/.test(html) && /function remindersView\(/.test(html) && /Copy for AI/.test(html));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  Module._load = origLoad;
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
