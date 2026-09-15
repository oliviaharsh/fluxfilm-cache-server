/* 🔐 Email login: a phone number alone no longer opens an account. First login on a device = a 6-digit code to a
 * TRUSTED email, then a signed, revocable session cookie. The real server.js runs on a free port with an in-memory
 * fake database and a fake mailer (no MySQL, no real email).  Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
process.env.CACHE_CLEAR_KEY = 'adminkey';
process.env.DB_PASS = 'test-db-pass';
process.env.PORT = '0';
process.env.IMAP_USER = ''; process.env.IMAP_PASS = '';
process.env.SYNC_INTERVAL_MIN = '0';
process.env.DOTENV_CONFIG_PATH = require('path').join(__dirname, '.no-such-env');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const pad = (v) => String(v).padStart(2, '0');
const istDay = (n) => { const d = new Date(Date.now() + n * 86400e3 + 5.5 * 3600e3); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' 23:00:00'; };

// ---------------- fake database ----------------
let T;
function reset() { T = { customers: [], orders: [], subs: [], settings: new Map(), audits: [] }; }
reset();
const clone = (x) => JSON.parse(JSON.stringify(x));
const likeRe = (pat) => new RegExp('^' + pat.replace(/\\_|[.*+?^${}()|[\]\\]|%|_/g, (m) => (m === '\\_' ? '_' : m === '%' ? '.*' : m === '_' ? '.' : '\\' + m)) + '$');
async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  await new Promise((r) => setImmediate(r));
  // app_settings
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return T.settings.has(p[0]) ? [{ value: T.settings.get(p[0]) }] : [];
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE/.test(sql)) { T.settings.set(p[0], p[1]); return { affectedRows: 1 }; }
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\)$/.test(sql)) {
    if (T.settings.has(p[0])) { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; }
    T.settings.set(p[0], p[1]); return { affectedRows: 1 };
  }
  if (/^UPDATE app_settings SET value = \? WHERE setting_key = \? AND value = \?$/.test(sql)) {
    if (T.settings.get(p[1]) !== p[2]) return { affectedRows: 0 };
    T.settings.set(p[1], p[0]); return { affectedRows: 1 };
  }
  if (/^UPDATE app_settings SET value = \? WHERE setting_key = \?$/.test(sql)) { if (!T.settings.has(p[1])) return { affectedRows: 0 }; T.settings.set(p[1], p[0]); return { affectedRows: 1 }; }
  if (/^DELETE FROM app_settings WHERE setting_key = \?$/.test(sql)) { const had = T.settings.delete(p[0]); return { affectedRows: had ? 1 : 0 }; }
  if (/^DELETE FROM app_settings WHERE setting_key LIKE \? AND updated_at/.test(sql)) return { affectedRows: 0 };
  if (/^DELETE FROM app_settings WHERE setting_key LIKE \?$/.test(sql)) { const re = likeRe(p[0]); let n = 0; for (const k of [...T.settings.keys()]) if (re.test(k)) { T.settings.delete(k); n++; } return { affectedRows: n }; }
  if (/^SELECT setting_key, value FROM app_settings WHERE setting_key LIKE \? LIMIT 100$/.test(sql)) { const re = likeRe(p[0]); return [...T.settings.entries()].filter(([k]) => re.test(k)).map(([k, v]) => ({ setting_key: k, value: v })); }
  if (/^INSERT INTO audit_log/.test(sql)) { T.audits.push({ action: p[0], summary: p[3] }); return { affectedRows: 1 }; }
  // customers
  if (/^SELECT phone, name, email, raw_json FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^SELECT phone, raw_json, email FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^UPDATE customers SET raw_json = \? WHERE phone_norm = \? AND email = \? LIMIT 1$/.test(sql)) {
    const c = T.customers.find((x) => x.phone_norm === p[1] && x.email === p[2]); if (!c) return { affectedRows: 0 };
    c.raw_json = p[0]; return { affectedRows: 1 };
  }
  if (/^INSERT INTO customers/.test(sql)) { T.customers.push({ phone: p[0], phone_norm: p[1], name: p[2], email: p[3], raw_json: p[5] }); return { affectedRows: 1 }; }
  // orders / subscriptions
  if (/^SELECT email FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' AND UPPER\(fulfillment_status\) = 'FULFILLED'/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID' && o.fulfillment_status === 'FULFILLED').sort((a, b) => b.at - a.at).map((o) => ({ email: o.email }));
  if (/^SELECT COUNT\(\*\) AS n FROM orders WHERE phone_norm = \?$/.test(sql)) return [{ n: T.orders.filter((o) => o.phone_norm === p[0]).length }];
  if (/^SELECT COUNT\(\*\) AS n FROM subscriptions WHERE phone_norm = \?$/.test(sql)) return [{ n: T.subs.filter((o) => o.phone_norm === p[0]).length }];
  if (/^SELECT order_id, email, expiry_date, status, fulfillment_status, COALESCE\(removed, 0\) AS removed FROM subscriptions WHERE phone_norm = \?$/.test(sql)) return T.subs.filter((s) => s.phone_norm === p[0]).map(clone);
  if (/^SELECT email FROM orders WHERE order_id IN/.test(sql)) return T.orders.filter((o) => p.includes(o.order_id) && o.status === 'PAID').map((o) => ({ email: o.email }));
  if (/^SELECT phone_norm FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map((o) => ({ phone_norm: o.phone_norm }));
  if (/^SELECT phone_norm FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return T.subs.filter((o) => o.sub_id === p[0]).map((o) => ({ phone_norm: o.phone_norm }));
  if (/^SELECT/.test(sql)) return [];
  return { affectedRows: 1 };
}
const mockDb = { ENABLED: true, query: q, getPool: () => null, ping: async () => ({ ok: true }) };
const mail = [];
const mockMailer = {
  send: async (to, subject, html) => { mail.push({ to, subject, html }); return { ok: true }; },
  sendAccessEmail: async () => ({ ok: true }), sendPasswordChanged: async () => ({ ok: true }), sendRenewalReminder: async () => ({ ok: true }),
};
// Modules behind the private actions echo the arguments they received, so the test sees which phone reached them.
const echo = () => new Proxy({}, { get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : /^(start|stop|mount)/.test(String(k)) ? () => undefined : async (...args) => ({ ok: true, fn: String(k), args })) });
const ECHO = ['./reads', './payments', './fulfill', './otp', './otpaccess', './referrals', './coins', './paymatch', './promos', './push', './feed', './feedcomments', './olivia', './photos', './avatars', './games', './refunds', './subexpiry', './pushreminders', './sync', './order', './recover', './smtp'];
const echoes = {};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './mailer') return mockMailer;
  if (ECHO.includes(req)) return (echoes[req] = echoes[req] || echo());
  return origLoad.apply(this, arguments);
};
const origLog = console.log;
console.log = (...x) => { if (!/^\[(FluxFilm|db|imap|autosync|feed|referral|push)\]/.test(String(x[0]))) origLog(...x); };

const A = '9876543210', B = '9123456780', NEW = '9000011111', NOEMAIL = '9555555555';
const lastCode = (to) => { const m = mail.filter((x) => !to || x.to === to).pop(); return m && (m.subject.match(/(\d{6})$/) || [])[1]; };
const wrong = (c) => (c === '111111' ? '222222' : '111111');
let ipN = 0;
function seed() {
  reset(); mail.length = 0;
  // A: the profile email was just changed (unverified, 5 min ago) — it must NEVER receive a login code.
  T.customers.push({ phone: A, phone_norm: A, name: 'Asha', email: 'attacker@evil.com', raw_json: JSON.stringify({ Email: 'attacker@evil.com', EmailVerified: false, EmailChangedAt: new Date(Date.now() - 5 * 60e3).toISOString() }) });
  T.orders.push({ order_id: 'FF100', phone_norm: A, email: 'asha@gmail.com', status: 'PAID', fulfillment_status: 'FULFILLED', at: 1 });
  T.subs.push({ sub_id: 'SA1', order_id: 'FF100', phone_norm: A, email: 'asha.plan@gmail.com', expiry_date: istDay(10), status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 });
  // B: verified profile email + an order.
  T.customers.push({ phone: B, phone_norm: B, name: 'Bala', email: 'bala@gmail.com', raw_json: JSON.stringify({ Email: 'bala@gmail.com', EmailVerified: true, EmailVerifiedEmail: 'bala@gmail.com' }) });
  T.orders.push({ order_id: 'FF200', phone_norm: B, email: 'bala@gmail.com', status: 'PAID', fulfillment_status: 'FULFILLED', at: 2 });
  T.subs.push({ sub_id: 'SB1', order_id: 'FF200', phone_norm: B, email: 'bala@gmail.com', expiry_date: istDay(5), status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 });
  // Legacy customer with no email anywhere.
  T.customers.push({ phone: NOEMAIL, phone_norm: NOEMAIL, name: 'Old', email: '', raw_json: '{}' });
}

(async () => {
  const { httpServer } = require('../server');
  await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const cauth = require('../customerauth');
  const emaillock = require('../emaillock');
  const store = require('../store');
  const call = async (action, args, cookie, headers) => {
    const h = Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.' + ((++ipN >> 8) & 255) + '.' + (ipN & 255) }, cookie ? { cookie } : {}, headers || {});
    const res = await fetch(base + '/api', { method: 'POST', headers: h, body: JSON.stringify({ action, args }) });
    const setCookie = res.headers.get('set-cookie') || '';
    let body = null; try { body = await res.json(); } catch (_) {}
    return { status: res.status, body, setCookie, cookie: (setCookie.match(/ff_cs=[^;]*/) || [''])[0] };
  };
  const adminGet = (url) => fetch(base + url, { headers: { 'X-Admin-Key': 'adminkey' } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const adminPost = (url, body) => fetch(base + url, { method: 'POST', headers: { 'X-Admin-Key': 'adminkey', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const out = { status: r.status, body: await r.json() }; await new Promise((res) => setTimeout(res, 40)); return out; }); // change log is written after the answer
  const loginAs = async (phone, to) => {
    const s1 = await call('loginStart', [phone]);
    const code = lastCode(to);
    const v = await call('loginVerify', [phone, code, { mode: 'login', target: s1.body && s1.body.target }]);
    return { start: s1, verify: v, cookie: v.cookie };
  };

  try {
    section('existing customer → code only to a trusted email');
    seed();
    let r = await call('loginStart', [A]);
    ok('code sent to the active plan email, masked on screen', r.status === 200 && r.body.ok && mail.length === 1 && mail[0].to === 'asha.plan@gmail.com' && r.body.maskedEmail === 'as***@gmail.com' && /log in to FluxFilm/.test(mail[0].html), r.body);
    ok('  ...other trusted email offered as a masked option (paid order email)', r.body.options.length === 2 && r.body.options.every((o) => /^[a-z]{2}\*\*\*@gmail\.com$/.test(o.maskedEmail) && o.id) && !JSON.stringify(r.body).includes('asha.plan@'), r.body.options);
    ok('unverified, recently changed profile email: never emailed, never an option', mail.every((m) => m.to !== 'attacker@evil.com') && !JSON.stringify(r.body).includes('evil.com'), r.body);
    r = await call('loginStart', [A, 'forged-option-id']);
    ok('a made-up option id falls back to the first trusted email (never a client-chosen address)', mail.every((m) => m.to !== 'attacker@evil.com'));
    r = await call('loginStart', [B]);
    ok('verified profile email is first', r.body.ok && mail[mail.length - 1].to === 'bala@gmail.com' && r.body.options.length === 0, r.body);
    const lo = await emaillock.loginOptions(A);
    ok('loginOptions order: active plan, paid order; no unverified profile email', JSON.stringify(lo.list) === JSON.stringify(['asha.plan@gmail.com', 'asha@gmail.com']), lo.list);
    T.orders.length = 0; T.subs.length = 0;
    const lo2 = await emaillock.loginOptions(A);
    ok('nothing else + profile email changed 5 min ago → still not used', lo2.list.length === 0, lo2.list);
    T.customers[0].raw_json = JSON.stringify({ Email: 'attacker@evil.com', EmailVerified: false, EmailChangedAt: new Date(Date.now() - 9 * 86400e3).toISOString() });
    ok('  ...only when nothing else exists and it is older than 24 h, it is the fallback', (await emaillock.loginOptions(A)).list[0] === 'attacker@evil.com');

    section('right code → session cookie (HttpOnly, SameSite=Lax, 180 days)');
    seed();
    let s = await call('loginStart', [A]);
    let v = await call('loginVerify', [A, wrong(lastCode()), { mode: 'login', target: s.body.target }]);
    ok('wrong code → "not right", no cookie', !v.body.ok && /not right/.test(v.body.message) && !v.cookie, v.body);
    v = await call('loginVerify', [A, lastCode(), { mode: 'login', target: s.body.target }]);
    ok('right code → logged in, token never in the JSON', v.body.ok && !v.body.token && /^ff_cs=cs1\./.test(v.cookie), v.body);
    ok('cookie: HttpOnly; SameSite=Lax; Path=/; Max-Age=180 days', /HttpOnly/.test(v.setCookie) && /SameSite=Lax/.test(v.setCookie) && /Path=\//.test(v.setCookie) && /Max-Age=15552000/.test(v.setCookie), v.setCookie);
    ok('  ...Secure on the real site (only left off for localhost testing)', /; Secure$/.test(cauth.cookieHeader({ headers: { host: 'shop.fluxfilm.in' } }, 'x', 10)) && !/Secure/.test(cauth.cookieHeader({ headers: { host: '127.0.0.1:4760' } }, 'x', 10)));
    const cookieA = v.cookie;
    ok('session stored server-side in app_settings (no phone or token in the key)', [...T.settings.keys()].some((k) => /^csess_[0-9a-f]{16}_[A-Za-z0-9_-]{24}$/.test(k)) && [...T.settings.keys()].every((k) => !k.includes(A)));
    r = await call('loginStatus', [], cookieA);
    ok('loginStatus: required + logged in as A (masked email)', r.body.required === true && r.body.loggedIn === true && r.body.phone === A && /\*\*\*@/.test(r.body.maskedEmail), r.body);

    section('private actions need the session, for THAT phone');
    r = await call('getCustomerProfile', [A]);
    ok('no session → 401 loginRequired, handler never runs', r.status === 401 && r.body.loginRequired === true, r);
    for (const act of ['getMySubscriptions', 'getCustomerOrders', 'getWalletByPhone', 'getReferralInfo', 'getCoinHistory', 'pushSubscribe', 'addFeedComment', 'gameStart', 'getPendingRefunds', 'otpSendCode', 'oliviaChat', 'setAvatar']) {
      r = await call(act, [A, 'x']);
      ok('  ' + act + ' without session → 401', r.status === 401 && r.body.loginRequired, r.status);
    }
    r = await call('getLatestOtp', ['Zee5', A, 'tok']);
    ok('  getLatestOtp without session → 401', r.status === 401);
    r = await call('getStoreStatus', []);
    ok('public actions still public (store status)', r.status === 200 && r.body.ok && r.body.emailLogin === true, r.body);
    r = await call('getCustomerProfile', [A], cookieA);
    ok('session A + phone A → handler gets A', r.status === 200 && r.body.fn === 'getCustomerProfile' && r.body.args[0] === A, r.body);
    r = await call('getCustomerProfile', [''], cookieA);
    ok('session A + no phone → handler gets A', r.status === 200 && r.body.args[0] === A, r.body);
    r = await call('getCustomerProfile', [B], cookieA);
    ok('session A but client sends B → refused (B never read)', r.status === 401 && r.body.otherPhone === true, r);
    r = await call('getMySubscriptions', ['+91 ' + B], cookieA);
    ok('  ...also with +91 / spaces', r.status === 401);
    r = await call('createOrder', [{ service: 'Netflix', plan: 'P', phone: B, email: 'x@y.z' }], cookieA);
    ok('  ...payload phone B (createOrder) refused', r.status === 401 && r.body.otherPhone, r.body);
    r = await call('createOrder', [{ service: 'Netflix', plan: 'P', email: 'x@y.z' }], cookieA);
    ok('  ...payload without phone → the session phone is filled in', r.status === 200 && r.body.args[0].phone === A, r.body);
    r = await call('getOrderStatus', ['FF200'], cookieA);
    ok('  ...B\'s order id → 403', r.status === 403 && !r.body.ok, r);
    r = await call('getOrderStatus', ['FF100'], cookieA);
    ok('  ...own order id → allowed', r.status === 200, r);
    r = await call('createRenewOrder', ['SB1', '', ''], cookieA);
    ok('  ...renewing B\'s subscription → 403', r.status === 403, r);
    r = await call('fulfillAndGetAccess', ['FF100', { token: 't', phone: A }]);
    ok('credentials without a session: the phone is removed, only the order token can prove it', r.status === 200 && r.body.args[1].token === 't' && !('phone' in r.body.args[1]), r.body);
    r = await call('fulfillAndGetAccess', ['FF100', { token: 't' }], cookieA);
    ok('  ...with the session: the session phone is the proof', r.status === 200 && r.body.args[1].phone === A, r.body);
    r = await call('validateCoupon', ['SAVE', { phone: B, amount: 100 }]);
    ok('coupon check without a session → validated without a phone', r.status === 200 && !r.body.args[1].phone, r.body);

    section('policy covers every storefront action');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const names = new Set();
    for (const m of srv.matchAll(/new Set\(\[([^\]]*)\]\)/g)) for (const x of m[1].matchAll(/'(\w+)'/g)) names.add(x[1]);
    for (const m of srv.matchAll(/\[([^\]]*)\]\.forEach\(\((?:a|x)\) => DB_\w+_ACTIONS\.add/g)) for (const x of m[1].matchAll(/'(\w+)'/g)) names.add(x[1]);
    for (const m of srv.matchAll(/DB_\w+_ACTIONS\.add\('(\w+)'\)/g)) names.add(m[1]);
    const missing = [...names].filter((n) => !cauth.POLICY[n]);
    ok('every action in server.js (' + names.size + ') has an explicit public / session rule', names.size > 60 && missing.length === 0, missing);
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const front = [...new Set([...html.matchAll(/apiCall_\('(\w+)'/g)].map((m) => m[1]))];
    const frontMissing = front.filter((n) => !cauth.POLICY[n]);
    ok('every action the storefront calls has a rule', front.length > 50 && frontMissing.length === 0, frontMissing);
    const PUBLIC = Object.keys(cauth.POLICY).filter((k) => cauth.POLICY[k].kind === 'public');
    ok('private reads are never public', ['getCustomerProfile', 'getMySubscriptions', 'getCustomerOrders', 'getWalletByPhone', 'getActiveCouponsForCustomer', 'getReferralInfo', 'getCoinHistory', 'getResumePaymentByPhone', 'getOrderStatus', 'getLatestOtp', 'oliviaHistory', 'getPendingRefunds'].every((k) => !PUBLIC.includes(k)));

    section('new customer: phone → name + email → code → logged in, email verified');
    r = await call('loginStart', [NEW]);
    ok('unknown phone → newCustomer (no email sent)', r.body.ok && r.body.newCustomer === true && !mail.some((m) => /NEW/.test(m.to)), r.body);
    mail.length = 0;
    r = await call('loginSignup', [NEW, 'Neha', 'neha@gmail.com']);
    ok('signup code goes to the typed email', r.body.ok && mail.length === 1 && mail[0].to === 'neha@gmail.com' && /creating your FluxFilm account/.test(mail[0].html), r.body);
    v = await call('loginVerify', [NEW, lastCode(), { mode: 'signup', name: 'Neha', email: 'someone.else@gmail.com' }]);
    ok('code with a different email → refused', !v.body.ok && !v.cookie, v.body);
    v = await call('loginVerify', [NEW, lastCode(), { mode: 'signup', name: 'Neha', email: 'neha@gmail.com' }]);
    const newRow = T.customers.find((c) => c.phone_norm === NEW);
    ok('right code → account created + cookie', v.body.ok && v.body.newCustomer && /^ff_cs=/.test(v.cookie) && newRow && newRow.email === 'neha@gmail.com', v.body);
    ok('  ...email saved as VERIFIED (typed column and raw_json)', newRow && JSON.parse(newRow.raw_json).EmailVerified === true && JSON.parse(newRow.raw_json).EmailVerifiedEmail === 'neha@gmail.com', newRow);
    r = await call('getCustomerProfile', [NEW], v.cookie);
    ok('  ...and private actions work', r.status === 200 && r.body.args[0] === NEW);
    r = await call('loginSignup', [B, 'Thief', 'thief@evil.com']);
    ok('signup for a number that already exists → refused, nothing sent to that email', !r.body.ok && r.body.known && mail.every((m) => m.to !== 'thief@evil.com'), r.body);

    section('number with no email anywhere → Help');
    r = await call('loginStart', [NOEMAIL]);
    ok('"We don\'t have an email for this number" + no email sent', !r.body.ok && r.body.noEmail === true && /don't have an email for this number/.test(r.body.message) && /Help/.test(r.body.message), r.body);
    T.orders.push({ order_id: 'FF900', phone_norm: '9444444444', email: '', status: 'CREATED', fulfillment_status: '', at: 3 });
    r = await call('loginStart', ['9444444444']);
    ok('orders but no customer row and no email → Help too (not a sign-up)', r.body.noEmail === true, r.body);

    section('brute force + rate limits (atomic, per code / phone / email)');
    seed();
    const t0 = Date.now();
    await cauth.start(B, { now: t0 });
    const good = lastCode('bala@gmail.com');
    let again = await cauth.start(B, { now: t0 + 10e3 });
    ok('new code within 30 s → no second email, wait shown', again.ok && again.resent === false && again.waitSeconds === 20 && mail.length === 1, again);
    let notRight = 0, lastV;
    for (let i = 0; i < 6; i++) { lastV = await cauth.verify(B, wrong(good), { mode: 'login', now: t0 + 15e3 }); if (/not right/.test(lastV.message)) notRight++; }
    ok('5 tries per code, then it is thrown away', notRight === 4 && lastV.expired === true && !lastV.token, { notRight, lastV });
    lastV = await cauth.verify(B, good, { mode: 'login', now: t0 + 16e3 });
    ok('  ...even the right code is dead now', !lastV.ok && !lastV.token);
    const par = await Promise.all(Array.from({ length: 10 }, () => cauth.verify(B, '000000', { mode: 'login', now: t0 + 40e3 })));
    ok('parallel guesses on a fresh code never exceed the limit', par.every((x) => !x.ok));
    let capped = 0;
    for (let i = 1; i <= 8; i++) { const x = await cauth.start(B, { now: t0 + i * 31e3 }); if (!x.ok && x.rateLimited) { capped = i; break; } }
    ok('per phone: codes per hour are capped', capped > 0 && capped <= 7, capped);

    section('logout · log out all devices · admin revoke');
    seed(); cauth._internal.cache.clear();
    const d1 = await loginAs(B, 'bala@gmail.com');
    await new Promise((res) => setTimeout(res, 31)); // different code window not needed: same code key is deleted after use
    emaillock._internal.mem.clear();
    for (const k of [...T.settings.keys()]) if (/^emlk_c_/.test(k)) T.settings.delete(k);
    const d2 = await loginAs(B, 'bala@gmail.com');
    ok('two devices logged in', /^ff_cs=/.test(d1.cookie) && /^ff_cs=/.test(d2.cookie) && d1.cookie !== d2.cookie, [d1.verify.body, d2.verify.body]);
    r = await call('logout', [], d1.cookie);
    ok('logout clears the cookie', r.body.ok && /ff_cs=;/.test(r.setCookie) && /Max-Age=0/.test(r.setCookie), r.setCookie);
    r = await call('getCustomerProfile', [B], d1.cookie);
    ok('  ...the old token is dead even if someone kept it', r.status === 401, r.status);
    r = await call('getCustomerProfile', [B], d2.cookie);
    ok('  ...the other device is still in', r.status === 200);
    const d3 = await (async () => { for (const k of [...T.settings.keys()]) if (/^emlk_c_/.test(k)) T.settings.delete(k); emaillock._internal.mem.clear(); return loginAs(B, 'bala@gmail.com'); })();
    r = await call('logoutAll', [], d3.cookie);
    ok('log out all devices', r.body.ok && r.body.revoked >= 2, r.body);
    r = await call('getCustomerProfile', [B], d2.cookie);
    ok('  ...device 2 is logged out too', r.status === 401);
    r = await call('logoutAll', []);
    ok('  ...logoutAll without a session does nothing', r.body.loginRequired === true);
    for (const k of [...T.settings.keys()]) if (/^emlk_c_/.test(k)) T.settings.delete(k);
    emaillock._internal.mem.clear();
    const d4 = await loginAs(B, 'bala@gmail.com');
    let a1 = await fetch(base + '/admin/api/customer-sessions?phone=' + B);
    ok('admin sessions API needs the admin key', a1.status === 403);
    a1 = await adminGet('/admin/api/customer-sessions?phone=' + B);
    ok('admin sees the logged-in device (no token shown)', a1.body.ok && a1.body.sessions.length === 1 && a1.body.sessions[0].device && !JSON.stringify(a1.body).includes('cs1.'), a1.body);
    a1 = await adminPost('/admin/api/customer-sessions/revoke', { phone: B });
    ok('admin "log out everywhere" → revoked + change log', a1.body.ok && a1.body.revoked === 1 && T.audits.some((x) => x.action === 'customer.logout_all' && /every device/.test(x.summary)), [a1.body, T.audits]);
    r = await call('getCustomerProfile', [B], d4.cookie);
    ok('  ...the customer is logged out', r.status === 401);

    section('emergency switch: 🔐 Email login required OFF → old phone-only behaviour, logged');
    a1 = await adminPost('/admin/api/store', { emailLogin: false });
    ok('admin turns it off', a1.body.ok && a1.body.settings.emailLogin === false && T.audits.some((x) => x.action === 'store.emaillogin' && /EMERGENCY/.test(x.summary)), [a1.body, T.audits]);
    r = await call('getCustomerProfile', [A]);
    ok('  ...private action works with only a phone again', r.status === 200 && r.body.args[0] === A, r);
    r = await call('loginStatus', []);
    ok('  ...storefront is told login is not required', r.body.required === false && (await call('getStoreStatus', [])).body.emailLogin === false, r.body);
    a1 = await adminPost('/admin/api/store', { emailLogin: true });
    r = await call('getCustomerProfile', [A]);
    ok('turned back on → enforced at once + logged', r.status === 401 && T.audits.some((x) => x.action === 'store.emaillogin' && /turned ON/.test(x.summary)), r.status);
    ok('default is ON (fresh settings) and fails closed when settings cannot be read', store.DEFAULTS.emailLogin === true && await (async () => { const orig = mockDb.query; mockDb.query = async () => { throw new Error('boom'); }; store._internal.reset(); const x = await store.emailLoginRequired(); mockDb.query = orig; store._internal.reset(); return x === true; })());

    section('restart in the middle');
    seed(); cauth._internal.cache.clear(); emaillock._internal.mem.clear();
    const rs = await cauth.start(A, {});
    const rc = lastCode();
    await cauth.verify(A, wrong(rc), { mode: 'login', target: rs.target });
    await cauth.verify(A, wrong(rc), { mode: 'login', target: rs.target });
    delete require.cache[require.resolve('../emaillock')]; delete require.cache[require.resolve('../customerauth')];
    const cauth2 = require('../customerauth');
    let x = await cauth2.verify(A, wrong(rc), { mode: 'login', target: rs.target });
    ok('after restart the tries continue (3rd wrong → 2 left)', /2 tries left/.test(x.message), x);
    x = await cauth2.verify(A, rc, { mode: 'login', target: rs.target }, { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' });
    ok('  ...right code still works → session', x.ok && /^cs1\./.test(x.token), x);
    delete require.cache[require.resolve('../customerauth')];
    const cauth3 = require('../customerauth');
    const val = await cauth3.validate(x.token);
    ok('  ...session survives another restart (stored, not in memory)', val && val.ph === A, val);
    const later = await cauth3.validate(x.token, Date.now() + 2 * 86400e3);
    const recAfter = JSON.parse([...T.settings.entries()].find(([k]) => k === val.key)[1]);
    ok('sliding: used after 2 days → valid again for 180 days from then', later && later.slid && recAfter.exp > Date.now() + 181 * 86400e3, recAfter);
    ok('  ...unused for 181 days → expired', (await (async () => { cauth3._internal.cache.clear(); return cauth3.validate(x.token, Date.now() + 2 * 86400e3 + 181 * 86400e3); })()) === null);
    const forged = x.token.replace(/\.(\d{10})\./, '.' + B + '.');
    ok('forged token (phone swapped) → rejected', (await cauth3.validate(forged)) === null);

    section('storefront + games + Olivia + admin wiring');
    ok('apiCall_ sends the cookie and raises the login screen on loginRequired', /credentials: 'same-origin'/.test(html.slice(html.indexOf('function apiCall_('), html.indexOf('const API = {'))) && /ff-login-required/.test(html));
    const gate = html.slice(html.indexOf('function EmailLoginSheet({'), html.indexOf('function EmailLockSheet({'));
    ok('login sheet sits before the email-lock sheet (own code, no shared text)', html.indexOf('function EmailLoginSheet({') > 0 && gate.length > 2000);
    ok('code screen: "We sent a code to", number keyboard, one-time-code, resend timer, "Not your email? Get help"', /We sent a code to/.test(gate) && /inputMode: "numeric", autoComplete: "one-time-code"/.test(gate) && /"Send a new code in ", left, " s"/.test(gate) && /Not your email\? Get help/.test(gate));
    ok('new customer step (name + email) + no-email Help step', /mode === 'signup'/.test(gate) && /don't have an email for this number/.test(gate) && /API\.openWhatsApp\(\)/.test(gate));
    ok('existing logged-in browsers: "Confirm it\'s you" before anything private', /Confirm it's you/.test(html) && /API\.loginStatus\(/.test(html));
    ok('Account: Log out (revokes) + Log out all devices', /API\.logout\(/.test(html) && /API\.logoutAll\(/.test(html) && /Log out all devices/.test(html));
    const details = html.slice(html.indexOf('function DetailsScreen({'), html.indexOf('function ReviewScreen({'));
    ok('checkout asks for login before the email check and before creating the order', /ffEnsureLogin_\(form\.phone/.test(details) && details.indexOf('ffEnsureLogin_(form.phone') < details.indexOf("API.emailLockStatus(form.phone, '', decide"));
    ok('home login card: code first, then the old login flow', /ffEnsureLogin_\(typed, p => continueLogin\(/.test(html) && /restoreAfterAuth\(saved\.phone/.test(html));
    const games = fs.readFileSync(path.join(ROOT, 'games.html'), 'utf8');
    ok('games page sends the cookie and handles loginRequired', /credentials: 'same-origin'/.test(games) && /loginRequired/.test(games));
    ok('Olivia widget sends the cookie', /credentials: 'same-origin'/.test(fs.readFileSync(path.join(ROOT, 'oliviawidget.js'), 'utf8')));
    const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    ok('admin: Maintenance switch + Customer 360 "log out everywhere"', /🔐 Email login required/.test(adminHtml) && /emailLogin:/.test(adminHtml) && /\/admin\/api\/customer-sessions\/revoke/.test(adminHtml));

    section('every inline <script> parses (index.html, admin.html, games.html)');
    for (const file of ['index.html', 'admin.html', 'games.html']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/type=["'](application\/(ld\+)?json|importmap)/i.test(m[1]));
      let bad = null;
      scripts.forEach((m, i) => { try { new Function(m[2]); } catch (e) { bad = bad || (file + ' script ' + i + ': ' + e.message); } });
      ok(file + ': ' + scripts.length + ' inline scripts parse', scripts.length > 0 && !bad, bad);
    }
    try { new Function(fs.readFileSync(path.join(ROOT, 'oliviawidget.js'), 'utf8')); ok('oliviawidget.js parses', true); } catch (e) { ok('oliviawidget.js parses', false, e.message); }
  } catch (e) {
    fail++; origLog('THREW', e);
  }

  console.log = origLog;
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { origLog('THREW', e); process.exit(1); });
