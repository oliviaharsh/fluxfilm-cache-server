/* 🔒 Profile email lock: a phone number alone can no longer change where a customer's login email goes.
 * Run: npm test  (in-memory fake database + fake mailer: no MySQL, no real email) */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
process.env.CACHE_CLEAR_KEY = 'k';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const tick = () => new Promise((r) => setTimeout(r, 15));
const pad = (v) => String(v).padStart(2, '0');
const istDay = (n) => { const d = new Date(Date.now() + n * 86400e3 + 5.5 * 3600e3); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' 23:00:00'; };

// ---------------- fake database ----------------
let T;
function reset() {
  T = { customers: [], orders: [], subs: [], settings: new Map(), dbDown: false };
}
reset();
const clone = (x) => JSON.parse(JSON.stringify(x));
async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  await new Promise((r) => setImmediate(r)); // let parallel requests interleave
  if (/app_settings/.test(sql) && T.dbDown) throw new Error('connect ECONNREFUSED');
  // app_settings (codes, tries, caps)
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return T.settings.has(p[0]) ? [{ value: T.settings.get(p[0]) }] : [];
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) {
    if (T.settings.has(p[0])) { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; }
    T.settings.set(p[0], p[1]); return { affectedRows: 1 };
  }
  if (/^UPDATE app_settings SET value = \? WHERE setting_key = \? AND value = \?$/.test(sql)) {
    if (T.settings.get(p[1]) !== p[2]) return { affectedRows: 0 };
    T.settings.set(p[1], p[0]); return { affectedRows: 1 };
  }
  if (/^DELETE FROM app_settings WHERE setting_key = \?$/.test(sql)) { T.settings.delete(p[0]); return { affectedRows: 1 }; }
  if (/^DELETE FROM app_settings WHERE setting_key LIKE/.test(sql)) return { affectedRows: 0 };
  // customers
  if (/^SELECT phone, name, email, raw_json FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^SELECT phone, raw_json, email FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^SELECT name FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^SELECT name, email FROM customers WHERE phone = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone === p[0]).map(clone);
  if (/^UPDATE customers SET raw_json = \? WHERE phone_norm = \? AND email = \? LIMIT 1$/.test(sql)) {
    const c = T.customers.find((x) => x.phone_norm === p[1] && x.email === p[2]); if (!c) return { affectedRows: 0 };
    c.raw_json = p[0]; return { affectedRows: 1 };
  }
  if (/^UPDATE customers SET name = \?, email = \?, updated_at = NOW\(\), status = .* WHERE phone_norm = \? AND email <=> \? LIMIT 1$/.test(sql)) {
    const c = T.customers.find((x) => x.phone_norm === p[3] && (x.email == null ? null : x.email) === p[4]); if (!c) return { affectedRows: 0 };
    Object.assign(c, { name: p[0], email: p[1], raw_json: p[2] }); return { affectedRows: 1 };
  }
  if (/^INSERT INTO customers/.test(sql)) { T.customers.push({ phone: p[0], phone_norm: p[1], name: p[2], email: p[3], raw_json: p[5] }); return { affectedRows: 1 }; }
  if (/^UPDATE `customers` SET/.test(sql)) { // admin row editor
    const c = T.customers.find((x) => x.phone === p[p.length - 1]); if (!c) return { affectedRows: 0 };
    const cols = sql.match(/`(\w+)`=\?/g).map((x) => x.slice(1, x.indexOf('`', 1)));
    cols.forEach((col, i) => { if (col !== 'customers') c[col] = p[i]; });
    c.raw_json = p[p.length - 2]; return { affectedRows: 1 };
  }
  // orders / subscriptions
  if (/^SELECT email FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' AND UPPER\(fulfillment_status\) = 'FULFILLED'/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID' && o.fulfillment_status === 'FULFILLED').sort((a, b) => b.at - a.at).map((o) => ({ email: o.email }));
  if (/^SELECT order_id, email, expiry_date, status, fulfillment_status, COALESCE\(removed, 0\) AS removed FROM subscriptions WHERE phone_norm = \?$/.test(sql)) return T.subs.filter((s) => s.phone_norm === p[0]).map(clone);
  if (/^SELECT email FROM orders WHERE order_id IN/.test(sql)) return T.orders.filter((o) => p.includes(o.order_id) && o.status === 'PAID').map((o) => ({ email: o.email }));
  if (/^SELECT email, phone_norm FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return T.subs.filter((s) => s.sub_id === p[0]).map(clone);
  if (/^SELECT price, duration_days, is_active, raw_json FROM plans/.test(sql)) return []; // the lock passed → "Plan not found"
  if (/^SELECT/.test(sql)) return [];
  return { affectedRows: 1 };
}
const mockDb = { ENABLED: true, query: q, getPool: () => null, ping: async () => ({ ok: true }) };
const mail = [];
const mockMailer = {
  send: async (to, subject, html) => { mail.push({ to, subject, html }); return { ok: true }; },
  sendAccessEmail: async () => ({ ok: true }), sendPasswordChanged: async () => ({ ok: true }), sendRenewalReminder: async () => ({ ok: true }),
};
const mockReads = { getCustomerProfile: async (ph) => { const c = T.customers.find((x) => x.phone_norm === ph); return c ? { ok: true, phone: ph, name: c.name, email: c.email } : { ok: false }; } };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './mailer') return mockMailer;
  if (req === './reads') return mockReads;
  return origLoad.apply(this, arguments);
};

const LOCK = require.resolve('../emaillock');
let lock = require('../emaillock');
const account = require('../account');
const order = require('../order');
const lastCode = (to) => { const m = mail.filter((x) => !to || x.to === to).pop(); return m && (m.subject.match(/(\d{6})$/) || [])[1]; };
const wrong = (c) => (c === '111111' ? '222222' : '111111');

const A = '9876543210';
function customer(extra) {
  const c = Object.assign({ phone: A, phone_norm: A, name: 'Asha', email: 'asha@gmail.com', raw_json: JSON.stringify({ Name: 'Asha', Email: 'asha@gmail.com' }) }, extra || {});
  T.customers.push(c); return c;
}
const rawOf = (ph) => JSON.parse(T.customers.find((c) => c.phone_norm === ph).raw_json || '{}');
const activePlan = (email) => T.subs.push({ sub_id: 'S1', order_id: 'FF1', phone_norm: A, email, expiry_date: istDay(10), status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 });
const paidOrder = (email, at) => T.orders.push({ order_id: 'FF' + (T.orders.length + 1), phone_norm: A, email, status: 'PAID', fulfillment_status: 'FULFILLED', at: at || Date.now() });

(async () => {
  section('changing an existing email without a code is refused');
  customer(); paidOrder('asha@gmail.com');
  let r = await account.createOrUpdateCustomerProfile({ name: 'Asha', phone: A, email: 'thief@evil.com' });
  ok('no token → refused with a generic message', !r.ok && r.emailLocked && /could not change the email/i.test(r.message) && !/thief/.test(r.message), r);
  ok('  ...and the email on file is unchanged', T.customers[0].email === 'asha@gmail.com');
  r = await account.createOrUpdateCustomerProfile({ name: 'Asha K', phone: A, email: 'ASHA@gmail.com ' });
  ok('same email (any case) + new name → saves, no code needed', r.ok && T.customers[0].name === 'Asha K' && T.customers[0].email === 'asha@gmail.com', r);
  r = await account.changeProfileEmail({ phone: A, email: 'thief@evil.com', emailToken: 'eml1.n.' + A + '.' + 'a'.repeat(32) + '.' + (Date.now() + 1e6) + '.forged' });
  ok('forged token → refused', !r.ok && r.emailLocked, r);

  section('with a code to the NEW email → saved, verified, old email told');
  mail.length = 0;
  r = await lock.sendCode(A, 'new', { email: 'asha.new@gmail.com' });
  ok('code sent to the new email only', r.ok && mail.length === 1 && mail[0].to === 'asha.new@gmail.com' && /^\d{6}$/.test(lastCode()) && r.maskedEmail === 'as***@gmail.com', r);
  r = await lock.verifyCode(A, 'new', lastCode(), { email: 'asha.new@gmail.com' });
  ok('right code → change token', r.ok && /^eml1\.n\./.test(r.token), r);
  const newTok = r.token;
  r = await account.changeProfileEmail({ phone: A, email: 'asha.other@gmail.com', emailToken: newTok });
  ok('token for a DIFFERENT email → refused', !r.ok && r.emailLocked, r);
  r = await account.changeProfileEmail({ phone: '9123456780', email: 'asha.new@gmail.com', emailToken: newTok });
  ok('token for a DIFFERENT phone → refused', !r.ok, r);
  mail.length = 0;
  r = await account.changeProfileEmail({ phone: A, email: 'asha.new@gmail.com', emailToken: newTok });
  await tick();
  const raw1 = rawOf(A);
  ok('right token → saved', r.ok && r.emailChanged && T.customers[0].email === 'asha.new@gmail.com' && T.customers[0].name === 'Asha K', r);
  ok('  ...typed column and raw_json in sync, marked verified', raw1.Email === 'asha.new@gmail.com' && raw1.EmailVerified === true && !!Date.parse(raw1.EmailVerifiedAt) && raw1.EmailVerifiedEmail === 'asha.new@gmail.com' && raw1.PreviousEmail === 'asha@gmail.com', raw1);
  ok('  ...old email told "Your FluxFilm email was changed" with the new one masked', mail.length === 1 && mail[0].to === 'asha@gmail.com' && /email was changed/i.test(mail[0].subject) && /as\*\*\*@gmail\.com/.test(mail[0].html) && !/asha\.new/.test(mail[0].html) && /wasn't you/.test(mail[0].html), mail);

  section('active plan → also needs a code from an old email');
  reset(); mail.length = 0; lock._internal.mem.clear();
  customer({ raw_json: JSON.stringify({ Email: 'asha@gmail.com', EmailVerified: true, EmailVerifiedEmail: 'asha@gmail.com' }) });
  activePlan('plan.asha@yahoo.com'); T.orders.push({ order_id: 'FF1', phone_norm: A, email: 'plan.asha@yahoo.com', status: 'PAID', fulfillment_status: 'FULFILLED', at: 1 });
  let stat = await lock.status(A);
  ok('status: active plan, old options = verified profile email + plan email (masked only)', stat.ok && stat.activePlan && stat.oldOptions.length === 2 && stat.oldOptions[0].maskedEmail === 'as***@gmail.com' && stat.oldOptions[1].maskedEmail === 'pl***@yahoo.com' && !JSON.stringify(stat).includes('asha@gmail.com'), stat);
  await lock.sendCode(A, 'new', { email: 'asha.new@gmail.com' });
  const tokNew = (await lock.verifyCode(A, 'new', lastCode('asha.new@gmail.com'), { email: 'asha.new@gmail.com' })).token;
  r = await account.changeProfileEmail({ phone: A, email: 'asha.new@gmail.com', emailToken: tokNew });
  ok('only the new-email code → refused (needs old)', !r.ok && r.needOld && T.customers[0].email === 'asha@gmail.com', r);
  r = await lock.sendCode(A, 'old', { target: 'not-an-option' });
  ok('old code to an address that is not an option → generic no, no email', !r.ok && mail.every((m) => m.to !== 'not-an-option'), r);
  r = await lock.sendCode(A, 'old', { target: stat.oldOptions[1].id });
  ok('old code goes to the plan email (dead profile email is fine)', r.ok && mail[mail.length - 1].to === 'plan.asha@yahoo.com', r);
  r = await lock.verifyCode(A, 'old', lastCode('plan.asha@yahoo.com'), { target: stat.oldOptions[1].id });
  ok('old code → old token', r.ok && /^eml1\.o\./.test(r.token), r);
  r = await account.changeProfileEmail({ phone: A, email: 'asha.new@gmail.com', emailToken: tokNew, oldEmailToken: r.token });
  ok('new + old token → changed', r.ok && T.customers[0].email === 'asha.new@gmail.com', r);
  reset(); lock._internal.mem.clear();
  customer({ raw_json: JSON.stringify({ Email: 'asha@gmail.com' }) }); activePlan('');
  stat = await lock.status(A);
  ok('active plan but no provable old email → no options (storefront shows Contact Help)', stat.activePlan && stat.oldOptions.length === 0, stat);

  section('first email: no code, but not verified');
  reset(); lock._internal.mem.clear();
  r = await account.createOrUpdateCustomerProfile({ name: 'New', phone: '9000011111', email: 'new@gmail.com' });
  const rawNew = JSON.parse(T.customers[0].raw_json);
  ok('new profile saved without a code, EmailVerified false', r.ok && T.customers[0].email === 'new@gmail.com' && rawNew.EmailVerified === false, rawNew);
  r = await lock.orderEmail('9000011111', 'new@gmail.com');
  ok('brand-new customer, first purchase → no extra step', r.ok && r.email === 'new@gmail.com', r);
  T.customers.push({ phone: '9000022222', phone_norm: '9000022222', name: 'Old row', email: '', raw_json: '{}' });
  T.orders.push({ order_id: 'FX', phone_norm: '9000022222', email: 'real.owner@gmail.com', status: 'PAID', fulfillment_status: 'FULFILLED', at: 5 });
  r = await account.createOrUpdateCustomerProfile({ name: 'Old row', phone: '9000022222', email: 'someone@evil.com' });
  ok('row with no email → first email saved without a code (not verified, change time kept)', r.ok && rawOf('9000022222').EmailVerified === false && !!rawOf('9000022222').EmailChangedAt, rawOf('9000022222'));

  section('checkout confirms the email');
  r = await lock.orderEmail('9000022222', 'someone@evil.com');
  ok('unverified + changed in the last 24 h (and not the paid order email) → code required', !r.ok && r.emailCheck && r.maskedEmail === 'so***@evil.com', r);
  r = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'X', email: 'someone@evil.com', phone: '9000022222' });
  ok('createOrder refuses before making any order', !r.ok && r.emailCheck === true, r);
  stat = await lock.status('9000022222');
  ok('status tells the storefront to ask for a code', stat.needsCode === true && stat.verified === false, stat);
  mail.length = 0;
  r = await lock.sendCode('9000022222', 'confirm');
  ok('confirm code goes to the email on file', r.ok && mail[0].to === 'someone@evil.com', r);
  r = await lock.verifyCode('9000022222', 'confirm', lastCode(), {});
  ok('right confirm code → verified in raw_json', r.ok && r.verified && rawOf('9000022222').EmailVerified === true, r);
  r = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'X', email: 'someone@evil.com', phone: '9000022222' });
  ok('  ...then checkout passes the lock (fails later only on the fake plan)', !r.ok && !r.emailCheck && /Plan not found/.test(r.message), r);

  reset(); lock._internal.mem.clear();
  customer({ raw_json: JSON.stringify({ Email: 'asha@gmail.com', EmailVerified: false, EmailChangedAt: new Date(Date.now() - 3 * 86400e3).toISOString() }) });
  paidOrder('old.asha@gmail.com');
  r = await lock.orderEmail(A, 'asha@gmail.com');
  ok('unverified + differs from the last PAID order email → code required', !r.ok && r.emailCheck, r);

  section('returning customers: no extra step');
  reset(); lock._internal.mem.clear();
  customer(); paidOrder('asha@gmail.com');
  r = await lock.orderEmail(A, 'asha@gmail.com');
  ok('customer from before this change (no flag) whose paid order used this email → trusted, no step', r.ok && r.email === 'asha@gmail.com', r);
  stat = await lock.status(A);
  ok('  ...status: verified, no code', stat.verified === true && stat.needsCode === false, stat);
  r = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'Asha', email: 'asha@gmail.com', phone: A });
  ok('  ...createOrder goes straight on', !r.emailCheck && /Plan not found/.test(r.message), r);
  r = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'Asha', email: 'thief@evil.com', phone: A });
  ok('a DIFFERENT email sent by the client → refused (never trusts the client)', !r.ok && r.emailChangeRequired, r);
  r = await order.createOrder({ service: 'Netflix', plan: 'Private 1M', name: 'Asha', email: '', phone: A });
  ok('no email sent → the profile email is used', !r.emailCheck && !r.emailChangeRequired && /Plan not found/.test(r.message), r);
  reset();
  customer({ raw_json: JSON.stringify({ Email: 'asha@gmail.com', EmailVerified: 'TRUE', EmailVerifiedEmail: 'asha@gmail.com' }) });
  r = await lock.orderEmail(A, 'asha@gmail.com');
  ok('verified flag saved as text by the admin editor still counts', r.ok, r);

  section('renewals never ask for a code');
  reset();
  customer({ email: 'someone@evil.com', raw_json: JSON.stringify({ Email: 'someone@evil.com', EmailVerified: false, EmailChangedAt: new Date().toISOString() }) });
  T.subs.push({ sub_id: 'S9', order_id: 'FF9', phone_norm: A, email: 'plan.owner@gmail.com', expiry_date: istDay(3), status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 });
  ok('unsafe profile email → renewal login goes to the plan email', (await lock.renewEmail(A, 'plan.owner@gmail.com')) === 'plan.owner@gmail.com');
  stat = await lock.status(A, 'S9');
  ok('  ...and the renew screen shows that (masked)', stat.renewMaskedEmail === 'pl***@gmail.com', stat);
  reset(); customer(); paidOrder('asha@gmail.com');
  ok('trusted profile email → renewal uses it', (await lock.renewEmail(A, 'older@gmail.com')) === 'asha@gmail.com');
  const orderSrc = fs.readFileSync(path.join(__dirname, '..', 'order.js'), 'utf8');
  ok('createRenewOrder picks the email on the server and skips the checkout lock', /renewTo = \(await emaillock\.renewEmail\(sub\.phone, sub\.email\)\)/.test(orderSrc) && /email: renewTo, phone: sub\.phone/.test(orderSrc) && /emailChecked: true/.test(orderSrc));
  ok('admin quick orders (amountOverride) skip the lock', /if \(!\(opts\.amountOverride != null && opts\.amountOverride !== ''\) && opts\.emailChecked !== true\)/.test(orderSrc));

  section('brute force + rate limits');
  reset(); lock._internal.mem.clear(); mail.length = 0; customer(); paidOrder('asha@gmail.com');
  const t0 = Date.now();
  await lock.sendCode(A, 'new', { email: 'x1@gmail.com', now: t0 });
  r = await lock.sendCode(A, 'new', { email: 'x1@gmail.com', now: t0 + 10e3 });
  ok('resend within 30 s → no second email, tells how long to wait', r.ok && r.resent === false && r.waitSeconds === 20 && mail.length === 1, r);
  const good = lastCode();
  let last; let wrongMsgs = 0;
  for (let i = 0; i < 6; i++) { last = await lock.verifyCode(A, 'new', wrong(good), { email: 'x1@gmail.com', now: t0 + 20e3 }); if (/not right/.test(last.message)) wrongMsgs++; }
  ok('5 tries per code: 4 "not right", then thrown away', wrongMsgs === 4 && last.expired === true, { wrongMsgs, last });
  r = await lock.verifyCode(A, 'new', good, { email: 'x1@gmail.com', now: t0 + 21e3 });
  ok('  ...even the right code no longer works', !r.ok);
  // per-phone cap: 6 codes / hour (x1 above was 1)
  let capped = null;
  for (let i = 2; i <= 7; i++) { r = await lock.sendCode(A, 'new', { email: 'x' + i + '@gmail.com', now: t0 + i * 31e3 }); if (!r.ok && r.rateLimited) { capped = i; break; } }
  ok('per phone: the 7th code in an hour is refused', capped === 7 && mail.length === 6, { capped, sent: mail.length });
  r = await lock.sendCode(A, 'new', { email: 'x8@gmail.com', now: t0 + 3700e3 });
  ok('  ...works again after an hour', r.ok, r);
  // per-email cap: 4 / hour across phones
  reset(); lock._internal.mem.clear(); mail.length = 0;
  for (let i = 0; i < 6; i++) T.customers.push({ phone: '90000000' + pad(i), phone_norm: '90000000' + pad(i), name: 'P' + i, email: 'p' + i + '@gmail.com', raw_json: '{}' });
  let emailCapped = null;
  for (let i = 0; i < 6; i++) { r = await lock.sendCode('90000000' + pad(i), 'new', { email: 'victim@gmail.com', now: t0 }); if (!r.ok && r.rateLimited) { emailCapped = i + 1; break; } }
  ok('per email: the 5th code to one address in an hour is refused (even from other phones)', emailCapped === 5 && mail.filter((m) => m.to === 'victim@gmail.com').length === 4, { emailCapped });
  r = await lock.sendCode('9555555555', 'new', { email: 'nobody@gmail.com' });
  ok('no profile for the phone → generic no, nothing sent', !r.ok && mail.every((m) => m.to !== 'nobody@gmail.com'), r);
  r = await lock.sendCode(A, 'purge', {});
  ok('unknown purpose → generic no', !r.ok);

  section('parallel guesses are atomic');
  reset(); lock._internal.mem.clear(); mail.length = 0; customer();
  await lock.sendCode(A, 'new', { email: 'race@gmail.com' });
  const rc = lastCode();
  const results = await Promise.all(Array.from({ length: 12 }, () => lock.verifyCode(A, 'new', wrong(rc), { email: 'race@gmail.com' })));
  const counted = results.filter((x) => /not right/.test(x.message)).length;
  ok('12 guesses at once: at most 4 "not right" answers, the rest are refused', counted <= 4 && results.every((x) => !x.ok), { counted });
  r = await lock.verifyCode(A, 'new', rc, { email: 'race@gmail.com' });
  ok('  ...and the code is gone', !r.ok);

  section('restart in the middle of a flow');
  reset(); lock._internal.mem.clear(); mail.length = 0; customer(); paidOrder('asha@gmail.com');
  await lock.sendCode(A, 'new', { email: 'after.restart@gmail.com' });
  const rs = lastCode();
  for (let i = 0; i < 3; i++) await lock.verifyCode(A, 'new', wrong(rs), { email: 'after.restart@gmail.com' });
  ok('code + tries are stored in app_settings (hashed, no plain code or email)', [...T.settings.keys()].some((k) => /^emlk_c_/.test(k)) && [...T.settings.values()].every((v) => !v.includes(rs) && !v.includes('after.restart')));
  delete require.cache[LOCK]; lock = require('../emaillock'); // new process: empty memory
  r = await lock.verifyCode(A, 'new', wrong(rs), { email: 'after.restart@gmail.com' });
  ok('after restart the tries continue (4th wrong → 1 try left)', /1 try left/.test(r.message), r);
  r = await lock.verifyCode(A, 'new', rs, { email: 'after.restart@gmail.com' });
  ok('  ...and the right code still works', r.ok && r.token, r);
  delete require.cache[LOCK]; lock = require('../emaillock');
  ok('  ...its token survives a restart too (signed, not in memory)', lock._internal.tokenOk(r.token, 'new', A, 'after.restart@gmail.com'));
  T.dbDown = true;
  r = await lock.sendCode(A, 'new', { email: 'dbdown@gmail.com' });
  ok('app_settings unavailable → memory fallback still limits', r.ok && lock._internal.mem.size > 0, r);
  T.dbDown = false;

  section('admin edit still works (admin key), marks verified, tells the old email');
  reset(); mail.length = 0; customer({ raw_json: JSON.stringify({ Phone: A, Name: 'Asha', Email: 'asha@gmail.com' }) });
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const resp = await fetch(base + '/admin/api/row', { method: 'POST', headers: H, body: JSON.stringify({ table: 'customers', keyvals: { phone: A }, raw: { Phone: A, Name: 'Asha', Email: 'fixed.by.owner@gmail.com' } }) });
  const body = await resp.json();
  await tick();
  const rawAdmin = rawOf(A);
  ok('admin changes the email with no code', resp.status === 200 && body.ok && T.customers[0].email === 'fixed.by.owner@gmail.com', body);
  ok('  ...saved as verified by admin', rawAdmin.EmailVerified === true && rawAdmin.EmailVerifiedBy === 'admin' && rawAdmin.EmailVerifiedEmail === 'fixed.by.owner@gmail.com', rawAdmin);
  ok('  ...old email gets the notice', mail.some((m) => m.to === 'asha@gmail.com' && /email was changed/i.test(m.subject)));
  const noKey = await fetch(base + '/admin/api/row', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'customers', keyvals: { phone: A }, raw: { Email: 'x@y.z' } }) });
  ok('  ...without the admin key → 403', noKey.status === 403);
  server.close();

  section('storefront + server wiring');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server exposes the 4 actions as MySQL storefront actions, rate-limited per IP and per phone', /\['emailLockStatus', 'emailSendCode', 'emailVerifyCode', 'changeProfileEmail'\]\.forEach\(\(a\) => DB_STOREFRONT_ACTIONS\.add\(a\)\)/.test(srv) &&
    /emailSendCode: security\.rateLimiter\(12, 60 \* 60e3\)/.test(srv) && /PHONE_LIMITS = \{[\s\S]*?emailSendCode: security\.rateLimiter\(8, 60 \* 60e3\)/.test(srv));
  const sheet = html.slice(html.indexOf('function EmailLockSheet({'), html.indexOf('function RecoverPickerModal({'));
  ok('code box: number keyboard + one-time-code autofill + 6 digits', /inputMode: "numeric", autoComplete: "one-time-code", pattern: "\[0-9\]\*", maxLength: 6/.test(sheet));
  ok('"Send a new code in N s" + "Wrong email? Change" + Help fallback', /"Send a new code in ", left, " s"/.test(sheet) && /Wrong email\? Change/.test(sheet) && /API\.openWhatsApp\(\)/.test(sheet));
  ok('checkout shows "Login details will be sent to … — Change"', /"📧 Login details will be sent to", React\.createElement\("br", null\)/.test(html) && /className: "ff-email-change"/.test(html));
  ok('checkout asks for the code only when the server says needsCode', /if \(r && r\.ok && r\.needsCode\) \{\s*setEmailLock\(r\);\s*setEmailSheet\('confirm'\);/.test(html));
  ok('renew screen shows where the login goes (no code step)', /renewLock\.renewMaskedEmail/.test(html) && /API\.emailLockStatus\(lockPhone, lockSubId,/.test(html));
  ok('Account → Profile has "Change email"', /"✏️ Change email"/.test(html) && /mode: "change",\s*onClose: \(\) => setEmailSheetOpen\(false\)/.test(html));
  const olivia = fs.readFileSync(path.join(__dirname, '..', 'olivia.js'), 'utf8');
  const words = require('../oliviawords');
  ok('Olivia: email needs a code → sends the customer to the Buy page (no order made)', /r\.emailCheck \|\| r\.emailChangeRequired\)\) \{ st\.step = 'confirm'; return \[\{ intent: 'CONFIRM_EMAIL_FIRST'/.test(olivia) && words.INTENTS.includes('CONFIRM_EMAIL_FIRST'));

  section('every inline <script> parses (index.html, admin.html)');
  for (const file of ['index.html', 'admin.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/type=["'](application\/(ld\+)?json|importmap)/i.test(m[1]));
    let bad = null;
    scripts.forEach((m, i) => { try { new Function(m[2]); } catch (e) { bad = bad || (file + ' script ' + i + ': ' + e.message); } });
    ok(file + ': ' + scripts.length + ' inline scripts parse', scripts.length > 0 && !bad, bad);
  }

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
