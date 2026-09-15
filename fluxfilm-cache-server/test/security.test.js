/* Security hardening: admin sign-in, sessions, rate limits, CORS, OTP tool gate. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

(async () => {
  const sec = require('../security');

  section('sessions');
  const env = { ADMIN_PASSWORD: 'correct horse battery', CACHE_CLEAR_KEY: 'oldkey' };
  const s = sec.makeSession(Date.now(), env);
  ok('fresh session verifies', sec.verifySession(s, Date.now(), env));
  ok('expired session is refused', !sec.verifySession(s, Date.now() + (sec.SESSION_HOURS + 1) * 3600e3, env));
  const parts = s.split('.');
  ok('extending the expiry breaks the signature', !sec.verifySession(['v1', Date.now() + 9e12, parts[2], parts[3]].join('.'), Date.now(), env));
  ok('changing ADMIN_PASSWORD signs everyone out', !sec.verifySession(s, Date.now(), { ADMIN_PASSWORD: 'a different password' }));
  ok('garbage is refused', !sec.verifySession('abc', Date.now(), env) && !sec.verifySession('', Date.now(), env));
  ok('no password configured -> no session is valid', !sec.verifySession(s, Date.now(), {}));
  ok('falls back to the old key when ADMIN_PASSWORD is unset', sec.adminPassword({ CACHE_CLEAR_KEY: 'k' }) === 'k' && sec.usingFallbackPassword({ CACHE_CLEAR_KEY: 'k' }));
  const reqWith = (h) => ({ headers: h });
  ok('X-Admin-Key header works for scripts', sec.isAdmin(reqWith({ 'x-admin-key': 'oldkey' }), env));
  ok('wrong header refused', !sec.isAdmin(reqWith({ 'x-admin-key': 'nope' }), env));
  ok('cookie session accepted', sec.isAdmin(reqWith({ cookie: 'a=1; ff_admin=' + encodeURIComponent(s) }), env));
  const ck = sec.sessionCookie({ headers: { host: 'shop.fluxfilm.in' } }, 'x', 60);
  ok('cookie is HttpOnly, SameSite=Strict and Secure', /HttpOnly/.test(ck) && /SameSite=Strict/.test(ck) && /Secure/.test(ck), ck);

  section('rate limiter + CORS');
  const lim = sec.rateLimiter(3, 1000);
  const t0 = 1e12;
  ok('allows up to the limit, then refuses', lim.hit('a', t0).ok && lim.hit('a', t0).ok && lim.hit('a', t0).ok && !lim.hit('a', t0).ok);
  ok('keys are independent', lim.hit('b', t0).ok);
  ok('window resets', lim.hit('a', t0 + 1001).ok);
  const cors = sec.corsOptions({});
  const allow = (o) => new Promise((r) => cors.origin(o, (_e, v) => r(v)));
  ok('own sites allowed', (await allow('https://shop.fluxfilm.in')) && (await allow('https://go.fluxfilm.in')));
  ok('no Origin (same-site / server) allowed', await allow(undefined));
  ok('other websites refused', !(await allow('https://evil.example')));

  section('Get-OTP tool needs an active plan and quota');
  let subsRows = [], used = 0, imapTouched = false;
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === './db') return { query: async (sql) => (/FROM subscriptions/.test(sql) ? subsRows : /sms_otp_log/.test(sql) ? [{ n: used }] : []) };
    if (req === 'imapflow') { imapTouched = true; throw new Error('IMAP must not be reached'); }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../otp')];
  const otp = require('../otp');
  process.env.IMAP_USER = ''; process.env.IMAP_PASS = '';
  delete require.cache[require.resolve('../otpaccess')];
  const access = require('../otpaccess');
  const good = access._internal.makeToken2('9876543210', 'a@b.c').token;
  const tryOtp = async (s, p, t) => { try { return await otp.getLatestOtp(s, p, t === undefined ? good : t); } catch (e) { return { threw: e.message }; } };
  const subRow = (service) => ({ sub_id: 'S1', order_id: 'O1', email: 'a@b.c', service, login_id: '9000000001', expiry_date: '2099-01-01 10:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED' });
  let r = await tryOtp('JioHotstar', '');
  ok('no phone -> refused', r.ok === false, r);
  subsRows = [subRow('JioHotstar')]; used = 0;
  r = await tryOtp('JioHotstar', '9876543210', '');
  ok('phone number alone (no device token) -> must confirm by email first', r.found === false && r.needsVerify === true, r);
  r = await tryOtp('JioHotstar', '9876543210', access._internal.makeToken2('9000000000', 'a@b.c').token);
  ok("another number's token does not work", r.needsVerify === true);
  const tamp = good.split('.'); tamp[3] = String(Number(tamp[3]) + 86400e3);
  r = await tryOtp('JioHotstar', '9876543210', tamp.join('.'));
  ok('token with a changed expiry (tampered) does not work', r.needsVerify === true);
  r = await tryOtp('JioHotstar', '9876543210', 'otp1.9876543210.' + (Date.now() + 86400e3) + '.oldsignature');
  ok('old otp1 token (Games / Refund code, profile email) does not unlock Get OTP', r.needsVerify === true, r);
  ok('expired token does not work', !access._internal.readToken2(access._internal.makeToken2('9876543210', 'a@b.c', Date.now() - 40 * 86400e3).token, '9876543210').ok);
  ok('IMAP not opened without a token', !imapTouched);
  subsRows = [];
  r = await tryOtp('JioHotstar', '9876543210');
  ok('phone with no plan gets no OTP', r.found === false && r.noActive === true, r);
  subsRows = [subRow('Zee5 Premium')];
  r = await tryOtp('JioHotstar', '9876543210');
  ok('a plan for a different service does not count', r.found === false && r.noActive === true, r);
  subsRows = [subRow('JioHotstar')]; used = 999;
  r = await tryOtp('JioHotstar', '9876543210');
  ok('quota used up -> no OTP', r.found === false && /used all/.test(r.message), r);
  ok('IMAP inbox never opened for refused requests', !imapTouched);
  Module._load = origLoad;

  section('storefront no longer ships the old API key');
  ok('index.html has no FF_GO key', !/FF_GO_20\d\d/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));

  section('live server');
  const port = await new Promise((res) => { const srv = net.createServer(); srv.listen(0, () => { const p = srv.address().port; srv.close(() => res(p)); }); });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DB_HOST: '', DB_USER: '', DB_NAME: '', CACHE_CLEAR_KEY: 'oldkey', ADMIN_PASSWORD: 'correct horse battery', IMAP_USER: '', IMAP_PASS: '', SYNC_INTERVAL_MIN: '0', DOTENV_CONFIG_PATH: path.join(ROOT, '.no-such-env') }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/health'); break; } catch (_) { await sleep(100); } }
  try {
    let res = await fetch(base + '/admin/db-ping?key=oldkey');
    ok('?key= in the URL is refused', res.status === 403 && /no longer accepted/.test((await res.json()).message));
    res = await fetch(base + '/admin/db-ping', { headers: { 'X-Admin-Key': 'oldkey' } });
    ok('X-Admin-Key header works', res.status === 200);
    res = await fetch(base + '/__debug');
    ok('/__debug needs admin', res.status === 403);
    res = await fetch(base + '/admin/api/summary');
    ok('admin API without sign-in -> 403 needLogin', res.status === 403 && (await res.json()).needLogin === true);
    res = await fetch(base + '/admin/api/me');
    ok('/me reports signed out and a strong password', (await res.json()).ok === false);

    const login = (pw, extra) => fetch(base + '/admin/api/login', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}), body: JSON.stringify({ password: pw }) });
    res = await login('correct horse battery');
    const cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
    ok('right password -> session cookie', res.status === 200 && /^ff_admin=/.test(cookie), res.status);
    res = await fetch(base + '/admin/api/me', { headers: { cookie } });
    ok('session is recognised', (await res.json()).ok === true);
    res = await fetch(base + '/admin/db-ping', { headers: { cookie } });
    ok('session opens the old admin links (/admin/db-ping) without a key', res.status === 200);
    res = await fetch(base + '/admin/api/sub-removed', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    ok('cross-site POST with a valid session is refused', res.status === 403 && /Cross-site/.test((await res.json()).message));
    res = await fetch(base + '/admin/api/logout', { method: 'POST', headers: { cookie } });
    ok('logout clears the cookie', /Max-Age=0/.test(String(res.headers.get('set-cookie'))));

    res = await fetch(base + '/panel');
    ok('/panel sends X-Frame-Options DENY + no-store', res.headers.get('x-frame-options') === 'DENY' && /no-store/.test(res.headers.get('cache-control')));
    res = await fetch(base + '/health', { headers: { Origin: 'https://evil.example' } });
    ok('other websites get no CORS permission', !res.headers.get('access-control-allow-origin'));
    res = await fetch(base + '/health', { headers: { Origin: 'https://go.fluxfilm.in' } });
    ok('go.fluxfilm.in gets CORS permission', res.headers.get('access-control-allow-origin') === 'https://go.fluxfilm.in');

    let statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await login('wrong' + i, { 'X-Forwarded-For': '203.0.113.9' })).status);
    ok('5 wrong passwords then locked (429)', statuses.slice(0, 5).every((x) => x === 401) && statuses[5] === 429 && statuses[6] === 429, statuses);
    res = await login('correct horse battery', { 'X-Forwarded-For': '203.0.113.9' });
    ok('even the right password waits out the lock', res.status === 429);
    res = await login('correct horse battery', { 'X-Forwarded-For': '198.51.100.7' });
    ok('owner on another IP can still sign in', res.status === 200);

    const act = (action, args, ip) => fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ action, args }) });
    statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await act('recoverSendOtp', ['9876500001', 'a@b.c'], '203.0.113.' + (20 + i))).status);
    ok('recover OTP email: 3 per phone per 15 min, whatever the IP', statuses.slice(0, 3).every((x) => x !== 429) && statuses[3] === 429 && statuses[4] === 429, statuses);
    const rl = await (await act('recoverSendOtp', ['9876500001', 'a@b.c'], '203.0.113.99')).json();
    ok('429 tells the customer to wait', rl.rateLimited === true && /wait/.test(rl.message), rl);
    statuses = [];
    for (let i = 0; i < 22; i++) statuses.push((await act('verifyPaymentByRef', ['FF1', 'UTR' + i], '203.0.113.50')).status);
    ok('UTR guessing is capped at 20 per 10 min per IP', statuses[19] !== 429 && statuses[20] === 429, statuses.slice(18));
    statuses = [];
    for (let i = 0; i < 60; i++) statuses.push((await act('getOrderStatus', ['FF1'], '203.0.113.60')).status);
    ok('payment-status polling is not blocked (60 polls)', statuses.every((x) => x !== 429));
  } finally {
    child.kill();
  }
  if (fail) console.log(log.split('\n').slice(-15).join('\n'));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
