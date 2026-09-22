/* 🔁 Switch account (owner request 15 Sep 2026): move a live subscription to another account of the same service.
   Real admin routes (adminswitch.js + adminexpired.js) and the real mailer on an in-memory MySQL that refuses JOINs /
   cross-collation SQL; SMTP is mocked (no real email). Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 900) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (v) => JSON.parse(JSON.stringify(v));
const up = (v) => String(v == null ? '' : v).toUpperCase();
const p2 = (x) => String(x).padStart(2, '0');
const dt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const days = (n) => new Date(Date.now() + n * 86400e3);
const ms = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN; };

// ---------------------------------------------------------------- in-memory MySQL (strict: unknown SQL throws)
let S;
function fresh() { S = { subs: [], accounts: [], caps: [], profiles: [], plans: [], customers: [], sql: [], lockLog: [] }; }
fresh();
const sub = (id) => S.subs.find((x) => x.sub_id === id);
const rawSub = (id) => JSON.parse(sub(id).raw_json || '{}');
const occupying = (x) => up(x.status) === 'ACTIVE' && (ms(x.expiry_date) > Date.now() || ms(x.release_eligible_at) > Date.now());
const likeOf = (p) => String(p || '').replace(/%/g, '').toLowerCase();

// Live lessons: MariaDB refuses to compare refund_* / feed_* (utf8mb4_unicode_ci) with the old tables; and a JOIN across
// tables is where that bites — so this fake refuses any JOIN at all.
const NEW_T = /\b(refund_offers|refund_requests|feed_\w+)\b/;
const OLD_T = /\b(orders|customers|subscriptions|inventory_\w+)\b/;
function guard(sql) {
  if (/\bJOIN\b/i.test(sql) || (NEW_T.test(sql) && OLD_T.test(sql))) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT) for operation \'=\': ' + sql); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; }
}
const OCC = "UPPER(status)='ACTIVE' AND (expiry_date > NOW() OR release_eligible_at > NOW())";

function run(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  S.sql.push(sql);
  guard(sql);
  if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
  if (/^SELECT \* FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map(clone);
  if (/^SELECT plan, raw_json FROM plans WHERE service = \?$/.test(sql)) return S.plans.filter((x) => x.service === p[0]).map(clone);
  if (/^SELECT service, raw_json FROM plans$/.test(sql)) return S.plans.map(clone);
  if (/^SELECT sub_id, inventory_ref, account_id, login_id, group_index FROM subscriptions WHERE group_id = \?$/.test(sql)) return S.subs.filter((x) => x.group_id && x.group_id === p[0]).map(clone);
  // service / inventory_ref / account_id ride along so accesspassword.js can check the OTHER devices' logins.
  if (/^SELECT sub_id, service, inventory_ref, account_id, login_id, password, profile_name, profile_pin, profile_number, device_type, device_count, tv_count, group_index FROM subscriptions WHERE group_id = \? ORDER BY group_index$/.test(sql)) return S.subs.filter((x) => x.group_id === p[0]).sort((a, b) => a.group_index - b.group_index).map(clone);
  if (/^SELECT name, email FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return S.customers.filter((c) => c.phone_norm === p[0]).map(clone);
  if (/^SELECT account_id, service, login_id, password, is_active, plan, notes FROM inventory_accounts WHERE LOWER\(service\) LIKE \?$/.test(sql)) return S.accounts.filter((a) => a.service.toLowerCase().includes(likeOf(p[0]))).map(clone);
  // accesspassword.js: one account read per account id + service family (its own statement, never a JOIN).
  if (/^SELECT service, account_id, login_id, password, is_active FROM inventory_accounts WHERE account_id = \? AND LOWER\(service\) LIKE \? LIMIT 20$/.test(sql)) return S.accounts.filter((a) => a.account_id === p[0] && a.service.toLowerCase().includes(likeOf(p[1]))).map(clone);
  if (/^SELECT account_id, max_total, max_tv, is_active FROM inventory_capacity WHERE LOWER\(service\) LIKE \?$/.test(sql)) return S.caps.filter((a) => a.service.toLowerCase().includes(likeOf(p[0]))).map(clone);
  if (/^SELECT account_id, profile_number, profile_pin, profile_name, raw_json FROM inventory_profiles WHERE LOWER\(service\) LIKE \?$/.test(sql)) return S.profiles.filter((a) => a.service.toLowerCase().includes(likeOf(p[0]))).map(clone);
  if (/^SELECT account_id, login_id, password FROM inventory_accounts$/.test(sql)) return S.accounts.map((a) => ({ account_id: a.account_id, login_id: a.login_id, password: a.password }));
  if (/^SELECT account_id, login_id, service FROM inventory_accounts$/.test(sql)) return S.accounts.map((a) => ({ account_id: a.account_id, login_id: a.login_id, service: a.service }));
  // fulfill.js occupancy (only subscriptions, OCC_ACTIVE)
  if (/^SELECT inventory_ref, SUM\(COALESCE\(device_count,1\)\) total, SUM\(CASE WHEN tv_count IS NOT NULL THEN tv_count WHEN UPPER\(device_type\)='TV' THEN COALESCE\(device_count,1\) ELSE 0 END\) tv FROM subscriptions WHERE LOWER\(service\) LIKE '%prime%' AND /.test(sql) && sql.includes(OCC)) {
    const m = new Map();
    for (const x of S.subs) { if (!x.service.toLowerCase().includes('prime') || !occupying(x)) continue; const dev = x.device_count || 1; const o = m.get(x.inventory_ref) || { inventory_ref: x.inventory_ref, total: 0, tv: 0 }; o.total += dev; o.tv += x.tv_count != null ? x.tv_count : (up(x.device_type) === 'TV' ? dev : 0); m.set(x.inventory_ref, o); }
    return [...m.values()];
  }
  if (/^SELECT inventory_ref, SUM\(COALESCE\(device_count,1\)\) total, SUM\(GREATEST\(COALESCE\(device_count,1\)-1,0\)\) extra FROM subscriptions WHERE LOWER\(service\) LIKE \? AND /.test(sql) && sql.includes(OCC)) {
    const m = new Map();
    for (const x of S.subs) { if (!x.service.toLowerCase().includes(likeOf(p[0])) || !occupying(x)) continue; const dev = x.device_count || 1; const o = m.get(x.inventory_ref) || { inventory_ref: x.inventory_ref, total: 0, extra: 0 }; o.total += dev; o.extra += Math.max(0, dev - 1); m.set(x.inventory_ref, o); }
    return [...m.values()];
  }
  if (/^UPDATE subscriptions SET inventory_ref = \?, account_id = \?, login_id = \?, password = \?, profile_number = \?, profile_name = \?, profile_pin = \?, notes = \?, raw_json = \? WHERE sub_id = \? AND COALESCE\(inventory_ref, ''\) = \? LIMIT 1$/.test(sql)) {
    const x = sub(p[9]);
    if (!x || String(x.inventory_ref || '') !== p[10]) return { affectedRows: 0 };
    Object.assign(x, { inventory_ref: p[0], account_id: p[1], login_id: p[2], password: p[3], profile_number: p[4], profile_name: p[5], profile_pin: p[6], notes: p[7], raw_json: p[8] });
    return { affectedRows: 1 };
  }
  // 🚪 Remove users
  if (/FROM subscriptions s WHERE s\.raw_json LIKE '%SwitchHistory%'$/.test(sql)) return S.subs.filter((x) => String(x.raw_json || '').includes('SwitchHistory')).map((x) => Object.assign(clone(x), { name: (S.customers.find((c) => c.phone_norm === x.phone_norm) || {}).name || null }));
  if (/^SELECT sub_id, raw_json FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return S.subs.filter((x) => x.sub_id === p[0]).map((x) => ({ sub_id: x.sub_id, raw_json: x.raw_json }));
  if (/^UPDATE subscriptions SET raw_json = \? WHERE sub_id = \? LIMIT 1$/.test(sql)) { const x = sub(p[1]); if (x) x.raw_json = p[0]; return { affectedRows: x ? 1 : 0 }; }
  if (/^SELECT s\.sub_id, s\.order_id, s\.phone_norm, s\.service, s\.plan, s\.status, s\.expiry_date, s\.inventory_ref/.test(sql) && /AND \(\(UPPER\(s\.status\) = 'ACTIVE' AND s\.expiry_date > NOW\(\)\)/.test(sql)) {
    return S.subs.filter((x) => (x.inventory_ref || x.login_id) && ((up(x.status) === 'ACTIVE' && ms(x.expiry_date) > Date.now()) || (ms(x.expiry_date) < Date.now() && !Number(x.removed))))
      .map((x) => Object.assign(clone(x), { removed: Number(x.removed) || 0, name: (S.customers.find((c) => c.phone_norm === x.phone_norm) || {}).name || null }));
  }
  if (/refund_offers/.test(sql)) return [];
  if (/^SELECT value FROM app_settings/.test(sql)) return [];
  if (/^UPDATE subscriptions SET removed = 1, removed_at = NOW\(\), raw_json = IF\(.*WHERE sub_id IN \(([?, ]+)\) AND COALESCE\(removed, 0\) = 0 AND NOT \(UPPER\(COALESCE\(status, ''\)\) = 'ACTIVE' AND expiry_date > NOW\(\)\)$/.test(sql)) {
    let n = 0; for (const x of S.subs) if (p.includes(x.sub_id) && !Number(x.removed) && !(up(x.status) === 'ACTIVE' && ms(x.expiry_date) > Date.now())) { x.removed = 1; n++; }
    return { affectedRows: n };
  }
  throw new Error('fake db: unhandled SQL: ' + sql);
}
const locks = new Map();
function makeConn() {
  let snapv = null;
  return {
    query: async (sql, p) => {
      const n = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT GET_LOCK\(\?, \?\) AS l$/.test(n)) {
        while (locks.get(p[0])) await locks.get(p[0]).wait;
        let rel; const wait = new Promise((r) => { rel = r; });
        locks.set(p[0], { wait, rel }); S.lockLog.push('lock'); S.sql.push('GET_LOCK');
        return [[{ l: 1 }]];
      }
      if (/^SELECT RELEASE_LOCK\(\?\)$/.test(n)) { const L = locks.get(p[0]); locks.delete(p[0]); S.lockLog.push('unlock'); S.sql.push('RELEASE_LOCK'); if (L) L.rel(); return [[{ l: 1 }]]; }
      await new Promise((r) => setImmediate(r)); // let other requests interleave, like a real database
      return [run(sql, p)];
    },
    beginTransaction: async () => { snapv = clone(S.subs); },
    commit: async () => { snapv = null; },
    rollback: async () => { if (snapv) S.subs = snapv; snapv = null; },
    release: () => {},
  };
}
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => ({ getConnection: async () => makeConn() }) };
const smtpSent = [];
const fakeSmtp = { status: () => ({ configured: true }), sendMail: async (m) => { smtpSent.push(m); return { ok: true }; } };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './smtp') return fakeSmtp;
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------- fixtures
const PH = '9876543210';
const plan = (service, name, policy, extra) => ({ service, plan: name, raw_json: JSON.stringify(Object.assign({ AllocationPolicy: policy }, extra || {})) });
function liveSub(id, extra) {
  return Object.assign({
    sub_id: id, order_id: 'FF' + id.replace(/\D/g, ''), phone: PH, phone_norm: PH, email: 'buyer@x.com', service: 'Netflix', plan: 'Sharing 1M', duration_days: 30,
    start_date: dt(days(-10)), expiry_date: dt(days(20)), release_eligible_at: dt(days(30)), status: 'ACTIVE', fulfillment_status: 'FULFILLED',
    login_id: 'd1@nf.com', password: 'pw-d1', inventory_ref: 'NFLX-D1#P1', account_id: 'NFLX-D1', profile_number: '1', profile_name: 'Shared', profile_pin: '0000',
    device_type: null, device_count: 1, tv_count: null, group_id: null, group_size: null, group_index: null, removed: 0, notes: null, source: 'node', raw_json: JSON.stringify({ SubID: id, Status: 'ACTIVE' }),
  }, extra || {});
}
const other = (id, ref, extra) => liveSub(id, Object.assign({ phone_norm: '90000' + id.replace(/\D/g, '').padStart(5, '0').slice(-5), email: '', inventory_ref: ref, account_id: ref.split('#')[0] }, extra || {}));
function netflixAccount(id, extra) {
  S.accounts.push(Object.assign({ service: 'Netflix', account_id: id, login_id: id.toLowerCase().replace('nflx-', '') + '@nf.com', password: 'pw-' + id.toLowerCase().replace('nflx-', ''), is_active: 'TRUE', plan: '', notes: '' }, extra || {}));
  S.caps.push({ service: 'Netflix', account_id: id, max_total: (extra && extra.max) || 5, max_tv: null, is_active: 'TRUE' });
  S.profiles.push({ service: 'Netflix', account_id: id, profile_number: '1', profile_pin: '0000', profile_name: 'Shared', raw_json: JSON.stringify({ ProfileNumber: 1, ProfileType: 'SHARING', IsReserved: 'TRUE', ProfileDisplayName: 'Shared' }) });
  [['2', 'Blue', '1111'], ['3', 'Green', '2222'], ['4', 'Red', '3333']].forEach(([n, name, pin]) => S.profiles.push({ service: 'Netflix', account_id: id, profile_number: n, profile_pin: pin, profile_name: name, raw_json: JSON.stringify({ ProfileNumber: +n, ProfileType: 'PRIVATE_ROTATING', ProfileDisplayName: name }) }));
}
function primeAccount(id, extra) {
  S.accounts.push(Object.assign({ service: 'Prime Video', account_id: id, login_id: id.toLowerCase() + '@amz.com', password: 'pw-' + id.toLowerCase(), is_active: 'TRUE', plan: '', notes: '' }, extra || {}));
  S.caps.push({ service: 'Prime Video', account_id: id, max_total: 4, max_tv: 2, is_active: 'TRUE' });
}
function otpAccount(id, login, planName, max) {
  S.accounts.push({ service: 'JioHotstar', account_id: id, login_id: login, password: 'otp', is_active: 'TRUE', plan: planName, notes: '' });
  S.caps.push({ service: 'JioHotstar', account_id: id, max_total: max, max_tv: null, is_active: 'TRUE' });
}

function seed() {
  fresh();
  S.plans.push(plan('Netflix', 'Sharing 1M', 'PROFILE'), plan('Netflix', 'Private 1M', 'PROFILE'), plan('Prime Video', '1 Device 1M', 'CAPACITY'), plan('Prime Video', '2 Devices 1M', 'CAPACITY'),
    plan('JioHotstar', '1 Month', 'OTP_ACCOUNT'), plan('JioHotstar', '6 Months', 'OTP_ACCOUNT'), plan('YouTube', 'Premium 1M', 'MANUAL', { FulfillmentMode: 'MANUAL' }), plan('Crunchyroll', 'Private 1M', 'PROFILE'));
  S.customers.push({ phone_norm: PH, name: 'Rahul', email: 'rahul@x.com' });
  ['NFLX-D1', 'NFLX-D2', 'NFLX-D4', 'NFLX-D5', 'NFLX-D10'].forEach((id) => netflixAccount(id, id === 'NFLX-D4' ? { max: 2 } : undefined));
  netflixAccount('NFLX-D3', { is_active: 'FALSE' });
  S.subs.push(
    liveSub('SUB-N1', { notes: 'old note' }),                                     // the customer: sharing on D1
    other('SUB-101', 'NFLX-D1#P1'), other('SUB-102', 'NFLX-D1#P1'),
    other('SUB-201', 'NFLX-D2#P1'), other('SUB-202', 'NFLX-D2#P1'), other('SUB-203', 'NFLX-D2#P2', { plan: 'Private 1M' }),
    other('SUB-204', 'NFLX-D2#P1', { expiry_date: dt(days(-20)), release_eligible_at: dt(days(-10)) }), // long gone: not counted
    other('SUB-401', 'NFLX-D4#P1'), other('SUB-402', 'NFLX-D4#P1'),
    other('SUB-501', 'NFLX-D5#P2', { plan: 'Private 2 Devices 1M', device_count: 2 }), // private on 2 devices: 1 extra device
    other('SUB-502', 'NFLX-D5#P1', { status: 'REFUNDED' }),                        // refunded: not counted
    other('SUB-1001', 'NFLX-D10#P1', { expiry_date: dt(days(-3)), release_eligible_at: dt(days(7)) }), // 10-day grace: counted
    liveSub('SUB-P1', { plan: 'Private 1M', inventory_ref: 'NFLX-D1#P3', profile_number: '3', profile_name: 'Green', profile_pin: '2222', email: '' }),
    liveSub('SUB-R1', { status: 'REFUNDED', fulfillment_status: 'REFUNDED' }),
    liveSub('SUB-X1', { expiry_date: dt(days(-2)), release_eligible_at: dt(days(8)) }),
    other('SUB-EXP1', 'NFLX-D1#P1', { expiry_date: dt(days(-5)), release_eligible_at: dt(days(-1)) }),
  );
}

(async () => {
  const express = require('express');
  const audits = [];
  const app = express(); app.use(express.json());
  const auth = (req, res) => { if (req.get('X-Admin-Key') === 'k') return true; res.status(403).json({ ok: false }); return false; };
  const audit = { record: (req, e) => audits.push(e) };
  require('../adminswitch').mount(app, { db: mockDb, auth, audit });
  require('../adminexpired').mount(app, { db: mockDb, auth, audit });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const r = await fetch(base + p, { headers: h || H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, body, h) => { const r = await fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const options = (id) => get('/admin/api/subs/switch/options?subId=' + id);
  const doSwitch = (body) => post('/admin/api/subs/switch', body);
  const E = require('../expiredusers');
  const removeUsers = () => E.load((sql, p) => mockDb.query(sql, p));
  const people = (r) => [].concat(r.main.groups, r.other.groups).flatMap((g) => g.people.map((x) => Object.assign({ group: g }, x)));

  section('list: Netflix sharing, least used first, sharing + private split, full / disabled greyed');
  seed();
  let r = await get('/admin/api/subs/switch/options?subId=SUB-N1', { 'Content-Type': 'application/json' });
  ok('options need the admin key', r.status === 403);
  r = await options('SUB-N1');
  const acc = (id) => r.body.accounts.find((a) => a.accountId === id) || {};
  ok('allowed; current account D1 with its use (4 seats: this customer, 2 others, 1 in grace), masked login', r.body.ok && r.body.allowed && r.body.current.accountId === 'NFLX-D1' && r.body.current.ref === 'NFLX-D1#P1' && r.body.current.label === 'NFLX-D1 · Sharing 4/5 · Private 1/3' && r.body.current.login === 'd1***@nf.com', r.body.current);
  ok('current account is not offered', !r.body.accounts.some((a) => a.accountId === 'NFLX-D1'), r.body.accounts.map((a) => a.accountId));
  ok('Netflix labels show sharing and private separately (grace plan counted, long-expired + refunded not)',
    acc('NFLX-D2').label === 'NFLX-D2 · Sharing 2/5 · Private 1/3' && acc('NFLX-D5').label === 'NFLX-D5 · Sharing 1/5 · Private 1/3' && acc('NFLX-D10').label === 'NFLX-D10 · Sharing 1/5 · Private 0/3', r.body.accounts.map((a) => a.label));
  ok('sharing numbers as data too (used / cap)', acc('NFLX-D2').sharing.used === 2 && acc('NFLX-D2').sharing.cap === 5 && acc('NFLX-D2').private.used === 1 && acc('NFLX-D2').private.cap === 3);
  ok('least used first (most free sharing seats), ties by id D5 before D10, then full / disabled',
    r.body.accounts.map((a) => a.accountId).join() === 'NFLX-D5,NFLX-D10,NFLX-D2,NFLX-D3,NFLX-D4', r.body.accounts.map((a) => a.accountId + ':' + a.free + ':' + a.fits));
  ok('full account disabled with "sharing full"; inactive account disabled', acc('NFLX-D4').fits === false && acc('NFLX-D4').reason === 'sharing full' && acc('NFLX-D4').status === 'FULL' && acc('NFLX-D3').fits === false && acc('NFLX-D3').status === 'DISABLED', [acc('NFLX-D4'), acc('NFLX-D3')]);
  ok('no passwords in the options answer', !JSON.stringify(r.body).includes('pw-'), r.body);
  ok('customer email masked, default note', r.body.sub.hasEmail && r.body.sub.email === 'bu***@x.com' && r.body.defaultNote === 'Account not working');

  const rp = await options('SUB-P1');
  const pacc = (id) => rp.body.accounts.find((a) => a.accountId === id) || {};
  ok('private plan: sorted by free private profiles (D4, D10 3 free; D2, D5 2), sharing-full D4 still fits a private plan', rp.body.accounts.filter((a) => a.fits).map((a) => a.accountId).join() === 'NFLX-D4,NFLX-D10,NFLX-D2,NFLX-D5' && pacc('NFLX-D10').free === 3 && pacc('NFLX-D2').free === 2 && pacc('NFLX-D4').fits === true && pacc('NFLX-D4').free === 3, rp.body.accounts.map((a) => a.accountId + ':' + a.free));

  section('switch: typed columns + raw_json + history + note + timestamp, old slot freed, new taken');
  smtpSent.length = 0; audits.length = 0;
  r = await doSwitch({ subId: 'SUB-N1', accountId: 'NFLX-D2', note: 'Account not working', email: true, requestId: 'req-n1' });
  const n1 = sub('SUB-N1'); const raw1 = rawSub('SUB-N1');
  ok('switch ok, email reported sent (masked)', r.status === 200 && r.body.ok && r.body.to.ref === 'NFLX-D2#P1' && r.body.from.ref === 'NFLX-D1#P1' && r.body.email.sent === true && r.body.email.to === 'bu***@x.com' && !JSON.stringify(r.body).includes('pw-'), r.body);
  ok('typed columns: new ref / account / login / password / shared profile', n1.inventory_ref === 'NFLX-D2#P1' && n1.account_id === 'NFLX-D2' && n1.login_id === 'd2@nf.com' && n1.password === 'pw-d2' && n1.profile_number === '1' && n1.profile_name === 'Shared' && n1.profile_pin === '0000', n1);
  const seededN1 = liveSub('SUB-N1');
  ok('expiry / order / status / devices unchanged', n1.order_id === seededN1.order_id && n1.status === 'ACTIVE' && n1.device_count === 1 && Math.abs(ms(n1.expiry_date) - ms(seededN1.expiry_date)) < 5000);
  ok('raw_json in step with the typed columns', raw1.InventoryRef === n1.inventory_ref && raw1.AccountID === 'NFLX-D2' && raw1.LoginId === n1.login_id && raw1.Password === n1.password && raw1.ProfileNumber === '1' && raw1.ProfileName === 'Shared' && raw1.ProfilePIN === '0000' && raw1.Notes === n1.notes && raw1.SubID === 'SUB-N1', raw1);
  ok('raw_json switch fields: SwitchedAt (IST), From, To, Reason, By, History', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw1.SwitchedAt) && Math.abs(ms(raw1.SwitchedAt) - Date.now()) < 60e3 &&
    raw1.SwitchedFrom === 'NFLX-D1 · NFLX-D1#P1 · d1@nf.com' && raw1.SwitchedTo === 'NFLX-D2 · NFLX-D2#P1 · d2@nf.com' && raw1.SwitchReason === 'Account not working' && raw1.SwitchedBy === 'admin' &&
    Array.isArray(raw1.SwitchHistory) && raw1.SwitchHistory.length === 1 && raw1.SwitchHistory[0].from.accountId === 'NFLX-D1' && raw1.SwitchHistory[0].to.accountId === 'NFLX-D2' && raw1.SwitchHistory[0].at === raw1.SwitchedAt, raw1);
  ok('notes column: old note kept + one timestamped line', /^old note\n\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d IST\] 🔁 Account switched NFLX-D1#P1 → NFLX-D2#P1 by admin: Account not working$/.test(n1.notes), n1.notes);
  ok('no password text in history', !JSON.stringify(raw1.SwitchHistory).includes('pw-'));
  r = await options('SUB-101');
  ok('old slot released: D1 now Sharing 3/5; new slot taken: D2 Sharing 3/5', r.body.current.label === 'NFLX-D1 · Sharing 3/5 · Private 1/3' && (r.body.accounts.find((a) => a.accountId === 'NFLX-D2') || {}).label === 'NFLX-D2 · Sharing 3/5 · Private 1/3', [r.body.current, r.body.accounts]);
  const au = audits.find((a) => a.action === 'sub.switchAccount');
  ok('change-log entry with from → to, reason and email result, no password', !!au && au.id === 'SUB-N1' && /NFLX-D1#P1 → NFLX-D2#P1 \(Account not working\) · new login emailed/.test(au.summary) && !JSON.stringify(au).includes('pw-'), audits);
  ok('lock held around the re-check and the write', (() => { const i = S.sql.lastIndexOf('GET_LOCK'); const j = S.sql.indexOf('RELEASE_LOCK', i); const seg = S.sql.slice(i, j); return i >= 0 && j > i && seg.some((q) => /GREATEST/.test(q)) && seg.some((q) => /^UPDATE subscriptions SET inventory_ref/.test(q)); })());

  section('email: new login, device-aware, mocked SMTP');
  const m1 = smtpSent.find((m) => /login was updated/.test(m.subject));
  ok('one email to the plan email with the new login + profile + note, not the old login', smtpSent.length === 1 && m1 && m1.to === 'buyer@x.com' && m1.subject === '🔁 Your FluxFilm Netflix login was updated' && /d2@nf\.com/.test(m1.html) && /pw-d2/.test(m1.html) && /Shared/.test(m1.html) && !/d1@nf\.com/.test(m1.html) && /plan and expiry date are unchanged/.test(m1.html) && /Hi Rahul/.test(m1.html), smtpSent.map((m) => m.subject));
  const rn1 = await doSwitch({ subId: 'SUB-N1', accountId: 'NFLX-D2', requestId: 'req-n1' });
  ok('double click (same requestId) → already, nothing new, no second email', rn1.body.ok && rn1.body.already && rawSub('SUB-N1').SwitchHistory.length === 1 && smtpSent.length === 1, rn1.body);

  section('private profile: a free private profile on the new account');
  smtpSent.length = 0;
  r = await doSwitch({ subId: 'SUB-P1', accountId: 'NFLX-D2', note: '', email: true, requestId: 'req-p1' });
  const p1 = sub('SUB-P1');
  ok('D2 profile #2 is taken → gets #3 Green / PIN 2222; default note; typed + raw in step', r.body.ok && p1.inventory_ref === 'NFLX-D2#P3' && p1.profile_number === '3' && p1.profile_name === 'Green' && p1.profile_pin === '2222' && rawSub('SUB-P1').ProfilePIN === '2222' && rawSub('SUB-P1').SwitchReason === 'Account not working', p1);
  ok('no email on the plan or customer? → the customer email is used', r.body.email.sent === true && smtpSent[0] && smtpSent[0].to === 'rahul@x.com', r.body.email);
  S.customers[0].email = '';
  r = await doSwitch({ subId: 'SUB-P1', accountId: 'NFLX-D10', email: true, requestId: 'req-p1b' });
  ok('no email anywhere → switched, email not sent ("no email on this plan")', r.body.ok && r.body.email.sent === false && /no email/.test(r.body.email.reason) && smtpSent.length === 1 && sub('SUB-P1').inventory_ref === 'NFLX-D10#P2', r.body);
  S.customers[0].email = 'rahul@x.com';
  r = await doSwitch({ subId: 'SUB-P1', accountId: 'NFLX-D5', email: false, requestId: 'req-p1c' });
  ok('email unticked → not sent', r.body.ok && r.body.email.sent === false && r.body.email.reason === 'not requested' && smtpSent.length === 1 && sub('SUB-P1').inventory_ref === 'NFLX-D5#P3', r.body);

  section('refusals');
  let before = clone(S.subs);
  r = await doSwitch({ subId: 'SUB-N1', accountId: 'NFLX-D2', requestId: 'req-same' });
  ok('same account refused', r.status === 409 && /already on/.test(r.body.message), r.body);
  r = await doSwitch({ subId: 'SUB-N1', accountId: 'NFLX-D4', requestId: 'req-full' });
  ok('full account refused', r.status === 409 && /sharing full/.test(r.body.message) && r.body.full, r.body);
  r = await doSwitch({ subId: 'SUB-N1', accountId: 'NFLX-D3', requestId: 'req-dis' });
  ok('disabled account refused', r.status === 409 && /disabled/.test(r.body.message), r.body);
  r = await options('SUB-R1');
  ok('refunded plan: options say not allowed', r.body.ok && r.body.allowed === false && /refunded/.test(r.body.reason) && !r.body.accounts.length, r.body);
  r = await doSwitch({ subId: 'SUB-R1', accountId: 'NFLX-D5', requestId: 'req-ref' });
  ok('refunded plan refused', r.status === 409 && /refunded/.test(r.body.message), r.body);
  r = await doSwitch({ subId: 'SUB-X1', accountId: 'NFLX-D5', requestId: 'req-exp' });
  ok('expired plan refused', r.status === 409 && /expired/.test(r.body.message), r.body);
  r = await doSwitch({ subId: 'SUB-NOPE', accountId: 'NFLX-D5' });
  ok('unknown subscription → 404', r.status === 404);
  r = await doSwitch({ subId: 'SUB-N1', accountId: 'PR-01', requestId: 'req-x' });
  ok('account of another service refused', r.status === 409 && /not a Netflix account/.test(r.body.message), r.body);
  ok('refusals changed nothing', JSON.stringify(before) === JSON.stringify(S.subs));
  S.subs.push(liveSub('SUB-Y1', { service: 'YouTube', plan: 'Premium 1M', inventory_ref: '', account_id: '', login_id: 'fam@yt.com' }));
  r = await options('SUB-Y1');
  ok('manual service (no inventory) not allowed', r.body.allowed === false && /no inventory accounts/.test(r.body.reason), r.body);
  S.subs.push(liveSub('SUB-C9', { service: 'Crunchyroll', plan: 'Private 1M', inventory_ref: 'CRY-01#P2', account_id: 'CRY-01', login_id: 'c@c.com' }));
  r = await options('SUB-C9');
  ok('service with no other inventory accounts not allowed', r.body.allowed === false && /no other Crunchyroll accounts/.test(r.body.reason), r.body);

  section('capacity re-checked inside the lock');
  netflixAccount('NFLX-D11', { max: 1 });
  r = await options('SUB-101');
  ok('D11 offered with 1 free seat', (r.body.accounts.find((a) => a.accountId === 'NFLX-D11') || {}).fits === true);
  S.subs.push(other('SUB-1101', 'NFLX-D11#P1')); // someone bought the seat while the dialog was open
  before = clone(S.subs);
  r = await doSwitch({ subId: 'SUB-101', accountId: 'NFLX-D11', requestId: 'req-race' });
  ok('confirm after the seat went → refused "full", nothing changed', r.status === 409 && /sharing full/.test(r.body.message) && JSON.stringify(before) === JSON.stringify(S.subs), r.body);
  netflixAccount('NFLX-D12', { max: 1 });
  smtpSent.length = 0;
  const [c1, c2] = await Promise.all([doSwitch({ subId: 'SUB-101', accountId: 'NFLX-D12', requestId: 'race-a' }), doSwitch({ subId: 'SUB-102', accountId: 'NFLX-D12', requestId: 'race-b' })]);
  ok('two switches to the last seat at once → exactly one wins', [c1, c2].filter((x) => x.body.ok).length === 1 && [c1, c2].filter((x) => x.status === 409 && /full/.test(x.body.message)).length === 1 && S.subs.filter((x) => x.inventory_ref === 'NFLX-D12#P1').length === 1, [c1.body, c2.body]);
  const [d1, d2] = await Promise.all([doSwitch({ subId: 'SUB-201', accountId: 'NFLX-D10', requestId: 'dbl' }), doSwitch({ subId: 'SUB-201', accountId: 'NFLX-D10', requestId: 'dbl' })]);
  ok('double tap at the same moment → one switch, one "already", one history entry', d1.body.ok && d2.body.ok && [d1, d2].filter((x) => x.body.already).length === 1 && rawSub('SUB-201').SwitchHistory.length === 1 && sub('SUB-201').inventory_ref === 'NFLX-D10#P1', [d1.body, d2.body]);

  section('history capped at 20');
  const old20 = Array.from({ length: 20 }, (_, i) => ({ id: 'SWOLD' + i, at: '2026-01-01 10:00:00', from: { accountId: 'NFLX-D9' }, to: { accountId: 'NFLX-D1' }, oldRemovedAt: '2026-01-02 10:00:00' }));
  S.subs.push(liveSub('SUB-H1', { email: '', raw_json: JSON.stringify({ SubID: 'SUB-H1', SwitchHistory: old20 }) }));
  r = await doSwitch({ subId: 'SUB-H1', accountId: 'NFLX-D5', requestId: 'req-h1' });
  ok('21st switch keeps the last 20 (oldest dropped, newest last)', r.body.ok && rawSub('SUB-H1').SwitchHistory.length === 20 && rawSub('SUB-H1').SwitchHistory[0].id === 'SWOLD1' && rawSub('SUB-H1').SwitchHistory[19].requestId === 'req-h1', rawSub('SUB-H1').SwitchHistory.map((h) => h.id));

  section('device plans (Prime): separate-logins group, same login on 2 devices');
  ['PR-01', 'PR-02', 'PR-03', 'PR-04', 'PR-05', 'PR-06'].forEach((id) => primeAccount(id));
  const prime = (id, ref, extra) => liveSub(id, Object.assign({ service: 'Prime Video', plan: '1 Device 1M', inventory_ref: ref, account_id: ref, login_id: ref.toLowerCase() + '@amz.com', password: 'pw-' + ref.toLowerCase(), profile_number: '', profile_name: '', profile_pin: '', device_type: 'NON_TV', tv_count: 0 }, extra || {}));
  S.subs.push(
    prime('SUB-G1', 'PR-01', { plan: '2 Devices 1M', group_id: 'G-FF9', group_size: 2, group_index: 1, tv_count: 1, device_type: 'TV', order_id: 'FF9' }),
    prime('SUB-G2', 'PR-02', { plan: '2 Devices 1M', group_id: 'G-FF9', group_size: 2, group_index: 2, order_id: 'FF9' }),
    prime('SUB-S2', 'PR-03', { plan: '2 Devices 1M', device_count: 2, tv_count: 1, device_type: 'MIXED', email: 'two@x.com' }),
    prime('SUB-40', 'PR-04', { phone_norm: '9000000040', device_count: 3 }),
    prime('SUB-50', 'PR-05', { phone_norm: '9000000050', device_count: 2, tv_count: 2, device_type: 'TV' }),
  );
  r = await options('SUB-G2');
  const g = (id) => r.body.accounts.find((a) => a.accountId === id) || {};
  ok('group row: explained, sibling account (Device 1) not offered', r.body.sub.group.kind === 'SEPARATE' && /Only Device 2 moves/.test(r.body.sub.group.text) && g('PR-01').fits === false && /used by Device 1 of this purchase/.test(g('PR-01').reason), [r.body.sub.group, g('PR-01')]);
  ok('Prime labels devices + TV; least used first', g('PR-05').label === 'PR-05 · 2/4 devices · TV 2/2' && r.body.accounts.filter((a) => a.fits).map((a) => a.accountId).join() === 'PR-06,PR-03,PR-05,PR-04', r.body.accounts.map((a) => a.label + ':' + a.fits));
  smtpSent.length = 0;
  r = await doSwitch({ subId: 'SUB-G2', accountId: 'PR-06', requestId: 'req-g2' });
  ok('only Device 2 row moved; Device 1 untouched; device fields kept', r.body.ok && sub('SUB-G2').inventory_ref === 'PR-06' && sub('SUB-G2').login_id === 'pr-06@amz.com' && sub('SUB-G2').profile_number === '' && sub('SUB-G1').inventory_ref === 'PR-01' && sub('SUB-G2').group_index === 2 && sub('SUB-G2').device_type === 'NON_TV', [sub('SUB-G1'), sub('SUB-G2')]);
  const mg = smtpSent[0] || { html: '' };
  ok('email lists Device 1 (old, unchanged) and Device 2 (new) + "Only Device 2’s login changed"', /Device 1/.test(mg.html) && /Device 2/.test(mg.html) && /pr-01@amz\.com/.test(mg.html) && /pr-06@amz\.com/.test(mg.html) && !/pr-02@amz\.com/.test(mg.html) && /Only Device 2’s login changed/.test(mg.html), mg.html.slice(0, 400));
  r = await options('SUB-S2');
  const s2 = (id) => r.body.accounts.find((a) => a.accountId === id) || {};
  ok('same login on 2 devices (1 TV): all devices move; 3/4 account full, TV 2/2 account "TV slots full"', r.body.sub.group.kind === 'SAME' && /all 2 devices move together/.test(r.body.sub.group.text) && s2('PR-04').fits === false && s2('PR-04').reason === 'full' && s2('PR-05').fits === false && s2('PR-05').reason === 'TV slots full' && s2('PR-02').fits === true && r.body.accounts[0].accountId === 'PR-02', r.body.accounts.map((a) => a.label + ':' + a.reason));
  r = await doSwitch({ subId: 'SUB-S2', accountId: 'PR-05', requestId: 'req-s2tv' });
  ok('switch to a TV-full account refused', r.status === 409 && /TV slots full/.test(r.body.message), r.body);
  smtpSent.length = 0;
  r = await doSwitch({ subId: 'SUB-S2', accountId: 'PR-02', requestId: 'req-s2' });
  ok('2-device row moved as one (device_count 2, tv 1 kept); email "same login on both devices"', r.body.ok && sub('SUB-S2').inventory_ref === 'PR-02' && sub('SUB-S2').device_count === 2 && sub('SUB-S2').tv_count === 1 && smtpSent[0] && smtpSent[0].to === 'two@x.com' && /same login on both devices/.test(smtpSent[0].html), smtpSent.map((m) => m.to));

  section('OTP service (JioHotstar: login = phone number, no profile)');
  otpAccount('JH-1M-01', '9000000001', '1 Month', 2);
  otpAccount('JH-1M-02', '9000000002', '1 Month', 2);
  otpAccount('JH-6M-02', '9000000002', '6 Months', 2);
  otpAccount('JH-6M-03', '9000000003', '6 Months', 2);
  otpAccount('JH-1M-04', '9000000004', '1 Month', 1);
  const otpSub = (id, ref, login, planName, extra) => liveSub(id, Object.assign({ service: 'JioHotstar', plan: planName, inventory_ref: ref, account_id: ref, login_id: login, password: 'otp', profile_number: '', profile_name: '', profile_pin: '' }, extra || {}));
  S.subs.push(otpSub('SUB-O1', 'JH-1M-01', '9000000001', '1 Month'), otpSub('SUB-O6', 'JH-6M-02', '9000000002', '6 Months', { phone_norm: '9000000066' }), otpSub('SUB-O9', 'JH-1M-04', '9000000004', '1 Month', { phone_norm: '9000000099' }));
  r = await options('SUB-O1');
  const o = (id) => r.body.accounts.find((a) => a.accountId === id);
  ok('OTP: only accounts sold for "1 Month"; used counted per login (JH-6M-02 shares the login); full one greyed; phone masked', r.body.sub.otp && !o('JH-6M-03') && !o('JH-6M-02') && o('JH-1M-02').label === 'JH-1M-02 · 1/2 customers' && o('JH-1M-02').fits && o('JH-1M-04').fits === false && o('JH-1M-02').login === '******0002', r.body.accounts);
  smtpSent.length = 0;
  r = await doSwitch({ subId: 'SUB-O1', accountId: 'JH-1M-02', requestId: 'req-o1' });
  ok('OTP switch: login = new phone number, no profile, raw in step', r.body.ok && sub('SUB-O1').login_id === '9000000002' && sub('SUB-O1').inventory_ref === 'JH-1M-02' && sub('SUB-O1').profile_number === '' && rawSub('SUB-O1').LoginId === '9000000002', sub('SUB-O1'));
  ok('OTP email: new number + Get OTP hint', smtpSent[0] && /9000000002/.test(smtpSent[0].html) && /Get OTP/.test(smtpSent[0].html), smtpSent.map((m) => m.subject));
  r = await doSwitch({ subId: 'SUB-O1', accountId: 'JH-1M-04', requestId: 'req-o1b' });
  ok('OTP full account refused', r.status === 409 && /full/.test(r.body.message), r.body);

  section('🚪 Remove users: the old account after a switch');
  let ru = await removeUsers();
  let all = people(ru);
  const gN1 = all.find((x) => /^SUB-N1~SW[0-9A-F]+$/.test(x.subId));
  ok('N1 listed on its OLD login (D1) as switched to D2, with active customers there → remove', !!gN1 && gN1.accountId === 'NFLX-D1' && gN1.switchedTo === 'NFLX-D2#P1' && gN1.group.login === 'd1@nf.com' && gN1.group.action === 'REMOVE' && gN1.name === 'Rahul', gN1 && Object.assign({}, gN1, { group: gN1.group.key }));
  ok('…and not as someone to remove on the NEW login (D2)', !all.some((x) => x.subId === 'SUB-N1' || (x.subId.startsWith('SUB-N1~') && x.accountId === 'NFLX-D2')));
  ok('OTP old login listed too (other section)', all.some((x) => x.subId.startsWith('SUB-O1~') && x.accountId === 'JH-1M-01'));
  r = await post('/admin/api/sub-removed', { sub_id: gN1.subId, removed: true, removed_at: '' });
  ok('✅ Removed on the ghost: ok, history entry ticked, the real subscription untouched', r.body.ok && !!rawSub('SUB-N1').SwitchHistory[0].oldRemovedAt && sub('SUB-N1').removed === 0 && sub('SUB-N1').status === 'ACTIVE' && audits.some((a) => a.action === 'sub.switchOldRemoved'), r.body);
  ru = await removeUsers(); all = people(ru);
  ok('after the tick N1 is gone from the old login', !all.some((x) => x.subId.startsWith('SUB-N1~')));
  const ghostsP1 = all.filter((x) => x.subId.startsWith('SUB-P1~'));
  ok('P1 switched 3 times (D1 → D2 → D10 → D5): ghosts on D1 and D10; not on D2, where the same customer still has an active plan (N1)', ghostsP1.map((x) => x.accountId).sort().join() === 'NFLX-D1,NFLX-D10', ghostsP1.map((x) => x.accountId));
  const exp1 = all.find((x) => x.subId === 'SUB-EXP1');
  r = await post('/admin/api/remove-users/removed', { subIds: ghostsP1.map((x) => x.subId).concat(exp1 ? [exp1.subId] : []), label: 'NFLX-D1' });
  ok('"Tick all" with ghosts + a normal expired customer: both kinds ticked, one answer', r.body.ok && r.body.marked === 3 && sub('SUB-EXP1').removed === 1 && rawSub('SUB-P1').SwitchHistory.filter((h) => h.oldRemovedAt).map((h) => h.from.accountId).sort().join() === 'NFLX-D1,NFLX-D10', r.body);
  ok('non-ghost ticks still go to the usual route', (await post('/admin/api/remove-users/removed', { subIds: ['SUB-EXP1'] })).body.message === 'Nothing ticked (already removed or still running).');
  S.accounts.find((a) => a.account_id === 'JH-1M-01').password = 'new-otp';
  ru = await removeUsers();
  ok('old account password changed after the switch → customer is logged out, ghost gone', !people(ru).some((x) => x.subId.startsWith('SUB-O1~')));
  const { ghostRows } = require('../adminswitch');
  ok('switched back to the old account → no ghost', ghostRows([{ sub_id: 'S', inventory_ref: 'A#P1', login_id: 'a@x', raw_json: JSON.stringify({ SwitchHistory: [{ id: 'SW1', at: '2026-09-10 10:00:00', from: { accountId: 'A', ref: 'A#P1', login: 'a@x' }, to: { accountId: 'B' } }] }) }], []).length === 0);

  section('storefront reads the typed columns');
  const recoverSrc = fs.readFileSync(path.join(__dirname, '..', 'recover.js'), 'utf8');
  ok('Recover reads login_id / password / profile from subscriptions (now the new account)', /login_id, password, profile_name, profile_pin, profile_number/.test(recoverSrc));

  section('collation guard + wiring');
  let threw = false;
  try { run('SELECT s.sub_id FROM subscriptions s JOIN inventory_accounts a ON a.account_id = s.account_id', []); } catch (e) { threw = /Illegal mix of collations/.test(e.message); }
  ok('the fake DB throws on a JOIN (like MariaDB with mixed collations)', threw);
  const src = fs.readFileSync(path.join(__dirname, '..', 'adminswitch.js'), 'utf8');
  const sqls = src.match(/'(?:SELECT|UPDATE|INSERT)[^']*'|"(?:SELECT|UPDATE|INSERT)[^"]*"/g) || [];
  ok('no JOIN and no new-table SQL in adminswitch.js', sqls.length >= 8 && !sqls.some((q) => /\bJOIN\b/i.test(q) || NEW_T.test(q)), sqls);
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok('admin.js mounts adminswitch before adminexpired and the sub-removed route', adminJs.indexOf("require('./adminswitch').mount") > 0 && adminJs.indexOf("require('./adminswitch').mount") < adminJs.indexOf("require('./adminexpired').mount") && adminJs.indexOf("require('./adminswitch').mount") < adminJs.indexOf("app.post('/admin/api/sub-removed'"));

  section('admin card: 🔁 Switch account only on live plans');
  server.close();
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const grab = (name) => { const i = adminHtml.indexOf('function ' + name + '('); let depth = 0; let j = adminHtml.indexOf('{', i); for (let k = j; k < adminHtml.length; k++) { if (adminHtml[k] === '{') depth++; else if (adminHtml[k] === '}') { depth--; if (!depth) return adminHtml.slice(i, k + 1); } } return ''; };
  const card = new Function('return (function(){ var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; function esc(v){return String(v==null?"":v);} function statusPill(){return "";} function svcIcon(){return "";} function waLink(){return "#";} function prettyDate(v){return String(v||"");} function crRenewLink(id){return "#"+id;} ' + grab('waClean') + grab('waName') + grab('waJoin') + grab('waYmd') + grab('waRemindText') + grab('istDate') + grab('daysLeft') + grab('subCard') + ' return subCard; })()')();
  const has = (x) => /switchAccountDialog\('/.test(card(x));
  ok('live plan → button', has(liveSub('SUB-A')));
  ok('refunded / cancelled / expired / not active → no button', !has(liveSub('SUB-B', { status: 'REFUNDED', fulfillment_status: 'REFUNDED' })) && !has(liveSub('SUB-C', { status: 'CANCELLED' })) && !has(liveSub('SUB-D', { expiry_date: dt(days(-1)) })) && !has(liveSub('SUB-E', { status: 'EXPIRED' })));
  ok('dialog: options + switch calls, least used note, note field, email checkbox (default on), confirm summary, requestId, full options disabled',
    /'\/admin\/api\/subs\/switch\/options'/.test(adminHtml) && /'\/admin\/api\/subs\/switch', \{ subId: sb\.subId, accountId: a\.accountId, note: note, email: mail, requestId: rid \}/.test(adminHtml) && /least used first/.test(adminHtml) && /id="swa_note"/.test(adminHtml) && /Email the customer the new login/.test(adminHtml) && /' checked' : ' disabled'/.test(adminHtml) && /🔁 Confirm switch/.test(adminHtml) && /\(a\.fits \? '' : ' disabled'\)/.test(adminHtml));
  ok('🚪 Remove users shows "switched to" for moved customers', /p\.switchedTo\) ago = '🔁 switched to '/.test(adminHtml));
  const pkg = require('../package.json');
  ok('package.json runs this test', /node test\/switch-account\.test\.js/.test(pkg.scripts.test));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let bad = 0; let n = 0;
  for (const src2 of [idx, adminHtml]) {
    for (const mm of src2.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type=["']application\/ld\+json/.test(mm[1]) || /type=["'](?!text\/javascript)/.test(mm[1])) continue;
      n++; try { new Function(mm[2]); } catch (e) { bad++; console.log('  script error:', e.message); }
    }
  }
  ok('every inline <script> in index.html + admin.html parses (' + n + ')', n > 1 && bad === 0);

  console.log('\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
