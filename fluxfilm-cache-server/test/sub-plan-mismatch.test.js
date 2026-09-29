/* ⚠️ Subscriptions whose plan name and device count disagree (owner, 29 Sep 2026: "7016076889 bought 2 devices
   prime initially and i think on 1 sep i changed it to 1 device? are we still recording it as 2 device in subs
   and device count both"). Half recorded: plan said "2 Devices 1M", device_count said 1.
   Real subfix.js on a fake MySQL. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const at = (d) => new Date(Date.now() + d * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

let SUBS = []; let ORDS = []; let PLANS = []; let AUDIT = [];
// The three real shapes, plus rows that must be left alone.
const SEED_SUBS = () => [
  // the owner's customer: moved to one device on 1 Sep, plan name never caught up
  { sub_id: 'S-STALE', phone_norm: '7016076889', service: 'Prime Video', plan: '2 Devices 1M', device_count: 1, status: 'ACTIVE', expiry_date: at(2), order_id: 'O-1M', raw_json: null },
  // genuinely a two-device customer whose count is wrong — the OPPOSITE fix
  { sub_id: 'S-DEV', phone_norm: '9000008207', service: 'Prime Video', plan: '2 Devices 1M', device_count: 1, status: 'ACTIVE', expiry_date: at(20), order_id: 'O-2D', raw_json: null },
  // one that already has a raw_json, to prove it is kept in step
  { sub_id: 'S-RAW', phone_norm: '9000007930', service: 'Prime Video', plan: '2 Devices 1M', device_count: 1, status: 'ACTIVE', expiry_date: at(8), order_id: 'O-2D2', raw_json: JSON.stringify({ Plan: '2 Devices 1M', DeviceConcurrency: 2, Notes: 'keep me' }) },
  // agrees with itself — must never appear
  { sub_id: 'S-OK', phone_norm: '9000000001', service: 'Prime Video', plan: '1 Month', device_count: 1, status: 'ACTIVE', expiry_date: at(30), order_id: 'O-OK', raw_json: null },
  { sub_id: 'S-OK2', phone_norm: '9000000002', service: 'Netflix', plan: 'Sharing 2 Devices 1M', device_count: 2, status: 'ACTIVE', expiry_date: at(30), order_id: 'O-OK2', raw_json: null },
  // refunded, and one with no device count at all — neither is a mismatch worth showing
  { sub_id: 'S-REF', phone_norm: '9000000003', service: 'Prime Video', plan: '2 Devices 1M', device_count: 1, status: 'REFUNDED', expiry_date: at(-5), order_id: 'O-R', raw_json: null },
  { sub_id: 'S-NULL', phone_norm: '9000000004', service: 'Prime Video', plan: '2 Devices 1M', device_count: null, status: 'ACTIVE', expiry_date: at(40), order_id: 'O-N', raw_json: null },
];
const SEED_ORDS = () => [
  { order_id: 'O-1M', phone_norm: '7016076889', service: 'Prime Video', plan: '1 Month', final_amount: 39, created_at_sheet: at(-28), status: 'PAID' },
  { order_id: 'O-OLD', phone_norm: '7016076889', service: 'Prime Video', plan: '2 Devices 1M', final_amount: 59, created_at_sheet: at(-96), status: 'PAID' },
  { order_id: 'O-2D', phone_norm: '9000008207', service: 'Prime Video', plan: '2 Devices 1M', final_amount: 56, created_at_sheet: at(-13), status: 'PAID' },
  { order_id: 'O-2D2', phone_norm: '9000007930', service: 'Prime Video', plan: '2 Devices 1M', final_amount: 59, created_at_sheet: at(-22), status: 'PAID' },
];
const SEED_PLANS = () => [
  { service: 'Prime Video', plan: '1 Month' }, { service: 'Prime Video', plan: '2 Devices 1M' },
  { service: 'Netflix', plan: 'Sharing 2 Devices 1M' },
];

const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    // Two collations in this database: subscriptions must never be joined to orders in SQL.
    if (/FROM subscriptions[\s\S]{0,120}JOIN\s+orders|FROM orders[\s\S]{0,120}JOIN\s+subscriptions/i.test(q)) {
      throw new Error("Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='");
    }
    if (/^SELECT sub_id, phone_norm, service, plan, device_count, status, expiry_date, order_id FROM subscriptions/.test(q)) {
      return SUBS.filter((x) => ['REFUNDED', 'CANCELLED'].indexOf(String(x.status).toUpperCase()) === -1 && x.device_count !== null).map((x) => Object.assign({}, x));
    }
    if (/^SELECT order_id, phone_norm, service, plan, final_amount, created_at_sheet FROM orders/.test(q)) {
      return ORDS.filter((x) => ['PAID', 'FULFILLED'].indexOf(String(x.status).toUpperCase()) > -1)
        .slice().sort((a, b) => String(b.created_at_sheet).localeCompare(String(a.created_at_sheet))).map((x) => Object.assign({}, x));
    }
    if (/^SELECT sub_id, service, plan, device_count FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(q)) {
      const x = SUBS.find((y) => y.sub_id === p[0]); return x ? [{ sub_id: x.sub_id, service: x.service, plan: x.plan, device_count: x.device_count }] : [];
    }
    if (/^SELECT plan FROM plans WHERE service = \?$/.test(q)) return PLANS.filter((x) => x.service === p[0]).map((x) => ({ plan: x.plan }));
    if (/^UPDATE subscriptions SET plan = \?, device_count = \?, raw_json = IF\(raw_json IS NULL, NULL, JSON_SET\(raw_json, '\$\.Plan', \?, '\$\.DeviceConcurrency', \?\)\) WHERE sub_id = \? LIMIT 1$/.test(q)) {
      const x = SUBS.find((y) => y.sub_id === p[4]);
      if (!x) return { affectedRows: 0 };
      x.plan = p[0]; x.device_count = p[1];
      // JSON_SET on NULL is NULL — the row keeps having none, which is what fulfill.js does on purpose.
      if (x.raw_json !== null) { const r = JSON.parse(x.raw_json); r.Plan = p[2]; r.DeviceConcurrency = p[3]; x.raw_json = JSON.stringify(r); }
      return { affectedRows: 1 };
    }
    if (/^INSERT INTO audit_log/.test(q)) { AUDIT.push({ action: p[0], id: p[2], summary: p[3] }); return { affectedRows: 1 }; }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 150));
  },
  getPool: () => null,
};
const reset = () => { SUBS = SEED_SUBS(); ORDS = SEED_ORDS(); PLANS = SEED_PLANS(); AUDIT = []; };

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const sf = require('../subfix');
  Module._load = origLoad;

  const app = express(); app.use(express.json());
  const audit = require('../audit').makeAudit({ query: mockDb.query });
  sf.mount(app, { db: mockDb, auth: () => true, audit });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'Content-Type': 'application/json' };
  const get = async (p) => (await fetch(base + p, { headers: H })).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
  const row = (r, id) => (r.rows || []).find((x) => x.subId === id);

  section('what counts as a mismatch');
  let r = await get('/admin/api/subs/mismatch');
  ok('a plan that says 2 devices with a device count of 1 is one', !!row(r, 'S-STALE') && !!row(r, 'S-DEV'), (r.rows || []).map((x) => x.subId));
  ok('a row that agrees with itself is not', !row(r, 'S-OK') && !row(r, 'S-OK2'), (r.rows || []).map((x) => x.subId));
  ok('a refunded row is not — there is nothing to renew', !row(r, 'S-REF'), (r.rows || []).map((x) => x.subId));
  ok('…and neither is one with no device count at all, which is most of them', !row(r, 'S-NULL'), (r.rows || []).map((x) => x.subId));
  ok('the soonest to expire comes first, because that is the one about to be mispriced', (r.rows || [])[0].subId === 'S-STALE' || String((r.rows || [])[0].expiry) >= String((r.rows || [])[1].expiry), (r.rows || []).map((x) => x.subId + ' ' + x.expiryLabel));

  section('which side is wrong is decided by what they PAID');
  // The whole point. These two rows look identical and need opposite corrections; guessing would break one.
  const stale = row(r, 'S-STALE');
  ok('somebody whose last order was a 1-device plan → fix the PLAN NAME', stale.suggest && stale.suggest.what === 'plan' && stale.suggest.plan === '1 Month' && stale.suggest.devices === 1, stale.suggest);
  ok('…and it shows the evidence, so the owner can disagree', /last paid order/.test(stale.suggest.why) && stale.lastPaidAmount === 39, { why: stale.suggest.why, paid: stale.lastPaidAmount });
  const dev = row(r, 'S-DEV');
  ok('somebody whose last order WAS the 2-device plan → fix the DEVICE COUNT', dev.suggest && dev.suggest.what === 'devices' && dev.suggest.plan === '2 Devices 1M' && dev.suggest.devices === 2, dev.suggest);
  ok('…the newest paid order is the one that counts, not the oldest', stale.lastPaidOrder === 'O-1M', stale.lastPaidOrder);

  section('correcting one row');
  r = await post('/admin/api/subs/fix-plan', { subId: 'S-STALE', plan: '1 Month', devices: 1 });
  ok('it saves, and the row drops off the list', r.ok && !row(r, 'S-STALE'), (r.rows || []).map((x) => x.subId));
  const after = SUBS.find((x) => x.sub_id === 'S-STALE');
  ok('…the plan name and the device count now agree', after.plan === '1 Month' && after.device_count === 1, { plan: after.plan, dev: after.device_count });
  ok('🔒 …and NOTHING else on the row moved: expiry, account, status, order all untouched',
    after.expiry_date === SEED_SUBS()[0].expiry_date && after.status === 'ACTIVE' && after.order_id === 'O-1M');
  ok('🔒 …a row with no raw_json still has none — fulfill.js keeps it that way on purpose', after.raw_json === null, after.raw_json);
  ok('the change log says what it was and what it became', AUDIT.some((a) => a.action === 'sub.fixPlan' && /2 Devices 1M/.test(a.summary) && /1 Month/.test(a.summary)), AUDIT.map((a) => a.summary));

  r = await post('/admin/api/subs/fix-plan', { subId: 'S-RAW', devices: 2 });
  const raw2 = JSON.parse(SUBS.find((x) => x.sub_id === 'S-RAW').raw_json);
  ok('a row that HAS a raw_json gets it moved in step, and keeps everything else in it', raw2.DeviceConcurrency === 2 && raw2.Plan === '2 Devices 1M' && raw2.Notes === 'keep me', raw2);
  ok('…and leaving the plan out leaves the plan alone', SUBS.find((x) => x.sub_id === 'S-RAW').plan === '2 Devices 1M');

  section('what it refuses');
  r = await post('/admin/api/subs/fix-plan', { subId: 'S-DEV', plan: 'Two Devices One Month', devices: 2 });
  ok('🔒 a plan that is not a plan of that service is refused — a typo here misprices every future renewal', r.ok === false && /not a plan of Prime Video/.test(r.message || ''), r.message);
  r = await post('/admin/api/subs/fix-plan', { subId: 'S-DEV', devices: 0 });
  ok('🔒 zero devices is refused', r.ok === false, r.message);
  r = await post('/admin/api/subs/fix-plan', { subId: 'NOPE', plan: '1 Month' });
  ok('an unknown subscription is refused, not silently ignored', r.ok === false && /No subscription/.test(r.message || ''), r.message);
  const before = JSON.stringify(SUBS);
  r = await post('/admin/api/subs/fix-plan', { subId: 'S-DEV', plan: '2 Devices 1M', devices: 1 });
  ok('setting it to what it already is changes nothing and says so', r.ok && r.unchanged === true && JSON.stringify(SUBS) === before, r);

  section('the code, and the promises on the screen');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok('🔒 it only ever writes plan and device_count — no expiry, no money, no account',
    (read('subfix.js').match(/UPDATE subscriptions SET [^"']*/g) || []).every((u) => /^UPDATE subscriptions SET plan = \?, device_count = \?/.test(u))
    && !/UPDATE orders|DELETE FROM|INSERT INTO subscriptions/i.test(read('subfix.js')));
  ok('🔒 and never joins subscriptions to orders in SQL', !/JOIN\s+orders/i.test(read('subfix.js')));
  ok('the endpoints are mounted', /require\('\.\/subfix'\)\.mount\(app/.test(read('admin.js')));
  ok('the card is on ⚙️ Maintenance, and wired', /sfxCard\(\)/.test(read('admin.html')) && /wireSfxCard\(\)/.test(read('admin.html')));
  ok('…and it tells the owner these do not all mean the same thing', /do not all mean the same thing/.test(read('admin.html')));
  ok('…and the button says exactly what it will set, before it is pressed', /Make it ' \+ esc\(sug\.plan\)/.test(read('admin.html')) && /Only the plan name and the device count change/.test(read('admin.html')));

  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  console.log('\n---------------------------------------');
  console.log('sub-plan-mismatch: PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
