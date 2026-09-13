/* F4 — the agreed renewal day-counting rules, case by case. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const { computeRenewal, hms, DAY } = require('../renewal');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const at = (s) => new Date(s.replace(' ', 'T') + ':00+05:30');
const day = (d) => d.toISOString().slice(0, 10) === d.toISOString().slice(0, 10) && new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const cfg = { capDays: 7, windowDays: 7, goodwillDays: 2 };
const run = (o) => computeRenewal(Object.assign({ durationDays: 30, cfg }, o));

console.log('=== owner examples (30-day plan, expired 10 Sep 10:00) ===');
const E = '2026-09-10 10:00';
let r;

r = run({ expiry: E, removed: false, now: at('2026-09-15 12:00') });
ok('not removed, renews 15 Sep -> 10 Oct, 5 days counted', day(r.newExpiry) === '2026-10-10' && r.counted === 5 && r.case === 'KEPT_ACCESS', r);

r = run({ expiry: E, removed: false, now: at('2026-09-30 12:00') });
ok('not removed, renews 30 Sep -> only 7 of 20 late days counted -> 23 Oct', day(r.newExpiry) === '2026-10-23' && r.counted === 7 && r.gifted === 13, r);
ok('  ...and the customer is told about the 13 gifted days, with a fun bubble', /gifted you 13 days/.test(r.message) && /hours/.test(r.bubble), r);

r = run({ expiry: E, removed: true, removedAt: E, now: at('2026-09-25 12:00') });
ok('removed at expiry, renews 25 Sep -> fresh start 25 Oct', day(r.newExpiry) === '2026-10-25' && r.counted === 0, r);

r = run({ expiry: E, removed: true, removedAt: at('2026-09-12 10:00'), now: at('2026-09-14 12:00') });
ok('removed 12 Sep (2 free days), renews 14 Sep -> goodwill forgives both -> 14 Oct', day(r.newExpiry) === '2026-10-14' && r.counted === 0 && r.gifted === 2, r);

r = run({ expiry: E, removed: true, removedAt: at('2026-09-18 10:00'), now: at('2026-09-20 12:00') });
ok('removed 18 Sep (8 free days), renews 20 Sep -> 7 capped - 2 goodwill = 5 -> 15 Oct', day(r.newExpiry) === '2026-10-15' && r.counted === 5 && r.gifted === 3, r);

r = run({ expiry: E, removed: true, removedAt: at('2026-09-25 10:00'), now: at('2026-09-28 12:00') });
ok('removed 25 Sep (15 free days), renews 28 Sep -> 5 counted -> 23 Oct', day(r.newExpiry) === '2026-10-23' && r.counted === 5 && r.gifted === 10, r);

r = run({ expiry: E, removed: true, removedAt: at('2026-09-18 10:00'), now: at('2026-09-30 12:00') });
ok('removed 18 Sep, renews 30 Sep (12 days later) -> old matter, fresh start 30 Oct', day(r.newExpiry) === '2026-10-30' && r.counted === 0 && r.case === 'REMOVED_LONG_AGO', r);

console.log('=== the real complaint ===');
r = run({ expiry: '2026-08-28 10:00', removed: true, removedAt: at('2026-09-01 10:00'), now: at('2026-09-05 19:12') });
ok('Prince (expired 28 Aug, removed 1 Sep, renewed 5 Sep): 4 free days, 2 counted -> 28 days', r.counted === 2 && r.gifted === 2 && Math.round((r.newExpiry - at('2026-09-05 19:12')) / DAY) === 28, r);
ok('  ...message names the day access ended', /until 1 Sep 2026/.test(r.message), r.message);

console.log('=== edges ===');
r = run({ expiry: E, removed: false, now: at('2026-09-09 10:00') });
ok('renewing before expiry adds on top of the current plan (10 Oct)', day(r.newExpiry) === '2026-10-10' && r.case === 'ON_TIME', r);
r = run({ expiry: E, removed: true, removedAt: at('2026-09-10 15:00'), now: at('2026-09-11 12:00') });
ok('whole days only: removed 5 hours after expiry counts 0', r.counted === 0 && r.accessDays === 0, r);
r = run({ expiry: E, removed: true, now: at('2026-09-12 12:00') });
ok('legacy tick without a time = removed at expiry -> fresh start', r.counted === 0 && day(r.newExpiry) === '2026-10-12', r);
r = run({ expiry: E, removed: true, removedAt: at('2026-09-08 10:00'), now: at('2026-09-12 12:00') });
ok('removed BEFORE expiry (dead account) never costs days', r.counted === 0 && day(r.newExpiry) === '2026-10-12', r);
r = run({ expiry: null, removed: false, now: at('2026-09-12 12:00') });
ok('no expiry on record -> fresh start', r.case === 'NO_EXPIRY' && day(r.newExpiry) === '2026-10-12', r);
r = run({ expiry: E, removed: true, removedAt: at('2026-09-17 10:00'), now: at('2026-09-24 09:59') });
ok('renewing 6d 23h after removal is still inside the 7-day window', r.case === 'REMOVED_RECENTLY', r);
r = run({ expiry: E, removed: true, removedAt: at('2026-09-17 10:00'), now: at('2026-09-25 10:00') });
ok('renewing 8 days after removal is outside it', r.case === 'REMOVED_LONG_AGO', r);
r = computeRenewal({ expiry: E, removed: false, now: at('2026-09-30 12:00'), durationDays: 30, cfg: { capDays: 5, windowDays: 3, goodwillDays: 1 } });
ok('numbers are settings (cap 5 -> 5 counted)', r.counted === 5, r);
r = run({ expiry: E, removed: false, now: at('2026-09-10 11:00') });
ok('renewing 1 hour late: nothing counted, no bubble', r.counted === 0 && r.bubble === '', r);

console.log('=== invariants over many random cases ===');
let bad = 0;
for (let i = 0; i < 3000; i++) {
  const e = at('2026-09-10 10:00').getTime();
  const late = Math.random() * 40 * DAY - 5 * DAY;
  const now = new Date(e + late);
  const removed = Math.random() < 0.5;
  const removedAt = new Date(e + (Math.random() * 30 - 3) * DAY);
  if (removed && removedAt > now) continue;
  const x = run({ expiry: new Date(e), removed, removedAt, now });
  const full = now.getTime() + 30 * DAY;
  const lo = Math.max(e, now.getTime()) + 30 * DAY - 7 * DAY;
  if (x.counted < 0 || x.counted > 7 || x.newExpiry.getTime() > Math.max(full, e + 30 * DAY) || x.newExpiry.getTime() < lo) { bad++; if (bad < 3) console.log('   bad', { late: late / DAY, removed, x }); }
  if (removed && x.case === 'REMOVED_RECENTLY' && x.counted > Math.max(0, x.accessDays - 2)) bad++;
}
ok('never more than a full plan, never more than 7 days counted, goodwill always applied', bad === 0, bad);
ok('hms formatting', hms(96 * 3600e3 + 12 * 60e3 + 5e3) === '96 hours, 12 minutes and 5 seconds' && hms(3600e3) === '1 hour, 0 minutes and 0 seconds');

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exit(fail ? 1 : 0);
