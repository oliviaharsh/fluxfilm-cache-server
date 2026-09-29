/* 🎟️ Coupons that expired but still say Active (owner, 30 Sep 2026: "make sure it automatically becomes
   inactive at that time because our existing coupons which have expired i think still shows active").

   Five live coupons were Active = TRUE with a date already gone, and three of those had ShowInProfile TRUE.
   The flag was never the thing that let anyone SPEND a dead coupon — order.js always checked the date. What
   it did was put dead coupons in the customer's Account → coupons list, which checked the flag and not the
   date, so the shop offered a coupon and then refused it at checkout.

   Real couponexpiry.js, real reads.js and real order.js on a fake MySQL. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
/** A real date, N days from now, as the admin form writes it: bare YYYY-MM-DD, India time. */
const day = (n) => new Date(Date.now() + n * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10);

let COUPONS = []; let USAGE = [];
const SEED = () => [
  // the five real shapes found on production, plus the ones that must be left alone
  { code: 'FGUR2X6DH', expiry: '2026-09-29 23:59:59', active: 'TRUE', raw: { Code: 'FGUR2X6DH', Description: '🎮 Won in Penalty Shootout — ₹10 off', Type: 'FLAT', Value: 10, MaxDiscount: 0, MinAmount: 0, Expiry: '2026-09-29 23:59:59', Active: 'TRUE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', PerUserLimit: 1, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  { code: 'OFFCAMPUSXX10', expiry: '2026-05-31T18:30:00.000Z', active: 'TRUE', raw: { Code: 'OFFCAMPUSXX10', Type: 'PERCENT', Value: 10, MaxDiscount: 0, MinAmount: 0, Expiry: '2026-05-31T18:30:00.000Z', Active: 'TRUE', ShowInProfile: 'true', AllowedPhones: 'ALL', PerUserLimit: 1, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  { code: 'SUMMER26', expiry: '2026-04-30T18:30:00.000Z', active: 'TRUE', raw: { Code: 'SUMMER26', Type: 'PERCENT', Value: 10, MaxDiscount: 0, MinAmount: 0, Expiry: '2026-04-30T18:30:00.000Z', Active: 'TRUE', ShowInProfile: 'false', AllowedPhones: 'ALL', PerUserLimit: 1, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // still alive — must never be touched
  { code: 'FLUXBACK10', expiry: day(12), active: 'TRUE', raw: { Code: 'FLUXBACK10', Type: 'PERCENT', Value: 20, MaxDiscount: 100, MinAmount: 0, Expiry: day(12), Active: 'TRUE', ShowInProfile: 'FALSE', AllowedPhones: 'ALL', PerUserLimit: 1, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // the anniversary coupon: dies at the END of today, and is still off until 10:00
  { code: 'FLUX4', expiry: day(0), active: 'FALSE', raw: { Code: 'FLUX4', Description: 'Anniversary sale', Scope: 'ANY', Type: 'PERCENT', Value: 40, MaxDiscount: 100, MinAmount: 0, Expiry: day(0), Active: 'FALSE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', PerUserLimit: 1, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // no expiry at all — "never expires", and never something to guess about
  { code: 'FOREVER', expiry: '', active: 'TRUE', raw: { Code: 'FOREVER', Type: 'FLAT', Value: 5, MaxDiscount: 0, MinAmount: 0, Expiry: '', Active: 'TRUE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', PerUserLimit: 0, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // a date nobody can read — also left alone rather than switched off on a misreading
  { code: 'GIBBERISH', expiry: 'next tuesday', active: 'TRUE', raw: { Code: 'GIBBERISH', Type: 'FLAT', Value: 5, MaxDiscount: 0, MinAmount: 0, Expiry: 'next tuesday', Active: 'TRUE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', PerUserLimit: 0, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // already off and expired — nothing to do, must not be counted as work
  { code: 'OLDOFF', expiry: day(-40), active: 'FALSE', raw: { Code: 'OLDOFF', Type: 'FLAT', Value: 5, MaxDiscount: 0, MinAmount: 0, Expiry: day(-40), Active: 'FALSE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', PerUserLimit: 0, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // the column and raw_json disagree: still expired, still has to end up off in BOTH
  { code: 'HALFON', expiry: day(-3), active: 'FALSE', raw: { Code: 'HALFON', Type: 'FLAT', Value: 25, MaxDiscount: 0, MinAmount: 0, Expiry: day(-3), Active: 'TRUE', ShowInProfile: 'TRUE', AllowedPhones: 'ALL', PerUserLimit: 0, GlobalLimit: 0, FirstTimeOnly: 'FALSE' } },
  // a row with no raw_json at all — JSON_SET must leave it NULL, as fulfill.js does on purpose
  { code: 'NORAW', expiry: day(-2), active: 'TRUE', raw: null },
];
const rows = () => COUPONS.map((c) => ({ code: c.code, expiry: c.expiry, active: c.active, raw_json: c.raw === null ? null : JSON.stringify(c.raw) }));

const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    if (/^SELECT code, expiry, active, raw_json FROM coupons$/.test(q)) return rows();
    if (/^SELECT raw_json FROM coupons$/.test(q)) return rows().map((r) => ({ raw_json: r.raw_json }));
    if (/^UPDATE coupons SET active = 'FALSE', raw_json = IF\(raw_json IS NULL, NULL, JSON_SET\(raw_json, '\$\.Active', 'FALSE'\)\) WHERE UPPER\(code\) = \? LIMIT 1$/.test(q)) {
      const c = COUPONS.find((x) => x.code.toUpperCase() === String(p[0]).toUpperCase());
      if (!c) return { affectedRows: 0 };
      c.active = 'FALSE';
      if (c.raw !== null) c.raw.Active = 'FALSE';   // JSON_SET on NULL stays NULL
      return { affectedRows: 1 };
    }
    if (/^SELECT coupon_code, COUNT\(\*\) c FROM coupon_usage/.test(q)) {
      const m = {};
      for (const u of USAGE) if (u.phone === p[0] && u.action === 'USED') m[u.code] = (m[u.code] || 0) + 1;
      return Object.keys(m).map((k) => ({ coupon_code: k, c: m[k] }));
    }
    if (/^SELECT COUNT\(\*\) n, SUM\(phone_norm = \?\) mine FROM coupon_usage/.test(q)) {
      const used = USAGE.filter((u) => u.action === 'USED' && u.code.toUpperCase() === String(p[1]).toUpperCase());
      return [{ n: used.length, mine: used.filter((u) => u.phone === p[0]).length }];
    }
    if (/^INSERT INTO audit_log/.test(q)) return { affectedRows: 1 };
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 160));
  },
  getPool: () => null,
};
const reset = () => { COUPONS = SEED(); USAGE = []; };

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === './db') return mockDb;
    if (req === './coins') return { onOrderPaid: async () => ({}), holdSpend: async () => ({ ok: false }), releaseSpend: async () => ({}), creditBalance: async () => 0 };
    if (req === './referrals') return { onOrderPaid: async () => ({}), checkReferral: async () => ({ ok: false }) };
    return origLoad.apply(this, arguments);
  };
  const express = require('express');
  const cx = require('../couponexpiry');
  const reads = require('../reads');
  const order = require('../order');
  Module._load = origLoad;
  const couponDiscount = order._internal.couponDiscount;

  // ── the rule itself ─────────────────────────────────────────────────────────────────────────────────────
  section('when exactly does a coupon die');
  // The whole reason this lives in one place. FLUX4 says 2026-09-30 and must survive to the last minute of
  // that day in India — not to 05:30 that morning.
  const LAST_MINUTE = Date.UTC(2026, 8, 30, 18, 29, 0);   // 2026-09-30 23:59 IST
  const JUST_AFTER = Date.UTC(2026, 8, 30, 18, 30, 1);    // 2026-10-01 00:00:01 IST
  ok('a bare YYYY-MM-DD lives until 23:59:59 that day, India time',
    cx.expiryMs('2026-09-30') === Date.UTC(2026, 8, 30, 18, 29, 59), new Date(cx.expiryMs('2026-09-30')).toISOString());
  ok('…so at 23:59 IST tonight FLUX4 is still good', cx.isExpired('2026-09-30', LAST_MINUTE) === false);
  ok('…and one second into 1 Oct it is not', cx.isExpired('2026-09-30', JUST_AFTER) === true);
  // The bug that already cost ~18 hours once, pinned so it cannot come back a third time.
  ok('🔒 NOT UTC midnight — that is 05:30 IST and killed coupons ~18 hours early',
    cx.expiryMs('2026-09-30') - new Date('2026-09-30').getTime() > 18 * 3600e3);
  ok('a full timestamp is read as written', cx.expiryMs('2026-05-31T18:30:00.000Z') === Date.parse('2026-05-31T18:30:00.000Z'));
  ok('a space instead of a T is still a timestamp', cx.expiryMs('2026-09-29 23:59:59') === new Date('2026-09-29T23:59:59').getTime());
  ok('no expiry means never expires, not expired', cx.expiryMs('') === 0 && cx.isExpired('', JUST_AFTER) === false);
  ok('…and neither does a date nobody can read — we refuse to guess', cx.expiryMs('next tuesday') === 0 && cx.isExpired('next tuesday', JUST_AFTER) === false);

  // ── finding them ────────────────────────────────────────────────────────────────────────────────────────
  section('which coupons are lying about being active');
  let found = await cx._internal.expiredActive(mockDb.query, Date.now());
  const codes = found.rows.map((x) => x.code);
  ok('the expired ones that still say active are found', ['FGUR2X6DH', 'OFFCAMPUSXX10', 'SUMMER26', 'HALFON', 'NORAW'].every((c) => codes.includes(c)), codes);
  ok('a coupon still in date is not', !codes.includes('FLUXBACK10'), codes);
  ok('…nor one that has not started yet and dies tonight', !codes.includes('FLUX4'), codes);
  ok('…nor one with no expiry, or an unreadable one', !codes.includes('FOREVER') && !codes.includes('GIBBERISH'), codes);
  ok('…nor one already switched off', !codes.includes('OLDOFF'), codes);
  ok('a row whose column and raw_json disagree is still caught', codes.includes('HALFON'), codes);
  ok('the ones a customer can actually SEE are counted', found.rows.filter((x) => x.showInProfile).length >= 2, found.rows.map((x) => x.code + ':' + x.showInProfile));
  ok('longest dead first, so the list reads oldest to newest', found.rows[0].code === 'SUMMER26', codes);

  // ── the customer's list: the bug the owner actually saw ─────────────────────────────────────────────────
  section('what the customer is offered in Account → coupons');
  let mine = await reads.getActiveCouponsForCustomer('9000000001');
  let offered = (mine.coupons || []).map((c) => c.code);
  ok('🔒 an expired coupon is NOT offered, even though its flag still says active',
    !offered.includes('FGUR2X6DH') && !offered.includes('OFFCAMPUSXX10'), offered);
  ok('…which is the bug: the flag was checked and the DATE was not', offered.every((c) => !['SUMMER26', 'HALFON', 'NORAW'].includes(c)), offered);
  ok('a live coupon is still offered', offered.includes('FOREVER'), offered);
  ok('…and one that is switched off is still not', !offered.includes('FLUX4') && !offered.includes('OLDOFF'), offered);
  ok('🔒 and this is true BEFORE any sweep has run — the list does not wait for a timer',
    COUPONS.find((c) => c.code === 'FGUR2X6DH').active === 'TRUE', 'sweep must not have run yet');

  // ── checkout was always right ───────────────────────────────────────────────────────────────────────────
  section('checkout, which was never the broken half');
  let d = await couponDiscount('FGUR2X6DH', '9000000001', 500, { action: 'NEW' });
  ok('an expired coupon is refused at checkout', d.ok === false && /expired/i.test(d.message), d);
  d = await couponDiscount('FOREVER', '9000000001', 500, { action: 'NEW' });
  ok('a coupon with no expiry still works', d.ok === true && d.discount === 5, d);
  d = await couponDiscount('FLUXBACK10', '9000000001', 500, { action: 'NEW' });
  ok('the win-back coupon takes 20% of ₹500, capped at ₹100', d.ok === true && d.discount === 100, d);
  d = await couponDiscount('FLUXBACK10', '9000000001', 200, { action: 'RENEW' });
  ok('…and 20% of ₹200 on a renewal is ₹40 — Scope ANY covers renewals', d.ok === true && d.discount === 40, d);

  section('the anniversary coupon, tonight');
  // 40%, capped at ₹100 (the owner chose to keep the cap), one per customer, new buys AND renewals.
  COUPONS.find((c) => c.code === 'FLUX4').raw.Active = 'TRUE';   // what anniversary.js does at 10:00
  d = await couponDiscount('FLUX4', '9000000001', 99, { action: 'NEW' });
  ok('40% of ₹99 is ₹40', d.ok === true && d.discount === 40, d);
  d = await couponDiscount('FLUX4', '9000000001', 499, { action: 'NEW' });
  ok('…and on ₹499 the ₹100 cap bites, exactly as the message will say', d.ok === true && d.discount === 100, d);
  d = await couponDiscount('FLUX4', '9000000001', 299, { action: 'RENEW' });
  ok('…a renewal gets it too', d.ok === true && d.discount === 100, d);
  USAGE.push({ code: 'FLUX4', phone: '9000000001', action: 'USED' });
  d = await couponDiscount('FLUX4', '9000000001', 99, { action: 'NEW' });
  ok('…but only once each', d.ok === false && /limit/i.test(d.message), d);
  d = await couponDiscount('FLUX4', '9000000002', 99, { action: 'NEW' });
  ok('…and somebody else is unaffected — there is no global cap', d.ok === true && d.discount === 40, d);
  reset();

  // ── the sweep ───────────────────────────────────────────────────────────────────────────────────────────
  section('switching them off');
  const before = COUPONS.filter((c) => c.active === 'TRUE').length;
  const swept = await cx.sweep({ query: mockDb.query, now: Date.now() });
  ok('it reports what it switched off', swept.ok && swept.cleared.length === 5, swept.cleared.map((x) => x.code));
  ok('the typed column is off', COUPONS.filter((c) => ['FGUR2X6DH', 'OFFCAMPUSXX10', 'SUMMER26', 'HALFON', 'NORAW'].includes(c.code)).every((c) => c.active === 'FALSE'));
  ok('🔒 …and so is raw_json, which is what checkout reads',
    COUPONS.filter((c) => ['FGUR2X6DH', 'OFFCAMPUSXX10', 'SUMMER26', 'HALFON'].includes(c.code)).every((c) => c.raw.Active === 'FALSE'));
  ok('a row with no raw_json keeps having none', COUPONS.find((c) => c.code === 'NORAW').raw === null);
  ok('the live ones are untouched', COUPONS.find((c) => c.code === 'FLUXBACK10').active === 'TRUE' && COUPONS.find((c) => c.code === 'FOREVER').active === 'TRUE');
  ok('…including the one that has not started yet', COUPONS.find((c) => c.code === 'FLUX4').active === 'FALSE' && COUPONS.find((c) => c.code === 'FLUX4').raw.Active === 'FALSE');
  ok('…and the unreadable date is left for a human', COUPONS.find((c) => c.code === 'GIBBERISH').active === 'TRUE');
  // Four, not five: HALFON's column already said FALSE and only its raw_json still claimed TRUE, which
  // is exactly the half-written row the sweep exists to finish. The assertion above covers that fifth one.
  ok('it really did change something', before - COUPONS.filter((c) => c.active === 'TRUE').length === 4,
    { before, after: COUPONS.filter((c) => c.active === 'TRUE').length });
  const again = await cx.sweep({ query: mockDb.query, now: Date.now() });
  ok('running it twice does nothing the second time', again.ok && again.cleared.length === 0, again.cleared);

  section('tonight, at the moment the sale closes');
  reset();
  // FLUX4 is on, as anniversary.js left it at 10:00. At 23:59 it must survive; a tick later it must be off.
  const f = COUPONS.find((c) => c.code === 'FLUX4');
  f.active = 'TRUE'; f.raw.Active = 'TRUE'; f.expiry = '2026-09-30'; f.raw.Expiry = '2026-09-30';
  await cx.sweep({ query: mockDb.query, now: LAST_MINUTE });
  ok('a sweep at 23:59 leaves the sale running', f.active === 'TRUE' && f.raw.Active === 'TRUE');
  await cx.sweep({ query: mockDb.query, now: JUST_AFTER });
  ok('the first sweep after midnight closes it, in both places', f.active === 'FALSE' && f.raw.Active === 'FALSE');

  // ── the endpoints ───────────────────────────────────────────────────────────────────────────────────────
  section('the admin endpoints');
  reset();
  const app = express(); app.use(express.json());
  const audit = require('../audit').makeAudit({ query: mockDb.query });
  cx.mount(app, { db: mockDb, auth: () => true, audit });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  let r = await get('/admin/api/coupons/expired');
  ok('the list says how many, and how many a customer can see', r.ok && r.total === 5 && r.inProfile >= 2, { total: r.total, inProfile: r.inProfile });
  ok('looking does not change anything', COUPONS.find((c) => c.code === 'FGUR2X6DH').active === 'TRUE');
  r = await post('/admin/api/coupons/sweep');
  ok('the button switches them off', r.ok && r.total === 5, r.total);
  r = await get('/admin/api/coupons/expired');
  ok('…and then there are none left', r.ok && r.total === 0, r.rows);

  // ── the promises in the code ────────────────────────────────────────────────────────────────────────────
  section('the code');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const nocomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('🔒 order.js does not keep its own copy of the expiry rule',
    !/T23:59:59\+05:30/.test(nocomment(read('order.js'))) && /couponExpiry\.isExpired/.test(read('order.js')));
  ok('🔒 …and neither does reads.js', !/T23:59:59\+05:30/.test(nocomment(read('reads.js'))) && /couponExpiry\.isExpired/.test(read('reads.js')));
  ok('🔒 the sweep only ever switches coupons OFF — it never deletes one, and never changes the money',
    (nocomment(read('couponexpiry.js')).match(/UPDATE coupons SET [^"]*/g) || []).every((u) => /^UPDATE coupons SET active = 'FALSE'/.test(u))
    && !/DELETE FROM|INSERT INTO coupons|SET value|SET max_discount/i.test(nocomment(read('couponexpiry.js'))));
  ok('the endpoints are mounted', /require\('\.\/couponexpiry'\)\.mount\(app/.test(read('admin.js')));
  ok('…exactly once', (read('admin.js').match(/require\('\.\/couponexpiry'\)\.mount\(app/g) || []).length === 1);
  ok('the tick is started', /require\('\.\/couponexpiry'\)\.startTimer\(\)/.test(read('server.js')));
  ok('…every 15 minutes, not hourly, so a sale reads closed the night it closes', /15 \* 60e3/.test(read('couponexpiry.js')));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  console.log('\n---------------------------------------');
  console.log('coupon-expiry: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
