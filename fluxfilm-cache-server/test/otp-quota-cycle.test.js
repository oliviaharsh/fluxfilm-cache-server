/* 🔢 The OTP quota now runs from the customer's OWN start date, not the 1st of the calendar month.

   Owner, 30 Sep 2026: "fix it to count from their own start date". Before this, the allowance you got
   depended on the day you happened to buy — someone who bought on 28 Sep had 5 JioHotstar codes for
   September and 5 more on 1 October, ten in four days, while someone who renewed on 2 October had to make
   5 last the whole month. Same plan, same price.

   Real otp.js on a fake MySQL with a FIXED clock. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let SUBS = [], LOG = [], SETTINGS = { windowMin: 10, quotas: { JIOHOTSTAR: 5, SONYLIV: 3, ZEE5: 5 } };
const reset = () => {
  SUBS = [
    // bought near the END of a month — the case that used to get two allowances in four days
    { phone_norm: '9000000028', service: 'JioHotstar', start_date: '2026-09-28 11:00:00', status: 'ACTIVE' },
    // bought at the START of a month — the case that used to get squeezed
    { phone_norm: '9000000002', service: 'JioHotstar', start_date: '2026-09-02 11:00:00', status: 'ACTIVE' },
    // a long-standing customer, 3-month plan from April
    { phone_norm: '9000000404', service: 'JioHotstar', start_date: '2026-04-08 23:40:00', status: 'ACTIVE' },
    // started on the 31st — the clamp case
    { phone_norm: '9000000031', service: 'Zee5 Premium', start_date: '2026-01-31 09:00:00', status: 'ACTIVE' },
    // an EXPIRED row must not define anybody's cycle
    { phone_norm: '9000000909', service: 'JioHotstar', start_date: '2026-01-05 09:00:00', status: 'EXPIRED' },
  ];
  LOG = [];
};
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    if (/^SELECT value FROM app_settings/.test(q)) return [{ value: JSON.stringify(SETTINGS) }];
    if (/^SELECT service, start_date FROM subscriptions WHERE phone_norm = \?/.test(q)) {
      return SUBS.filter((s) => s.phone_norm === p[0] && s.start_date && String(s.status).toUpperCase() === 'ACTIVE')
        .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))
        .map((s) => ({ service: s.service, start_date: s.start_date }));
    }
    if (/^SELECT COUNT\(\*\) n FROM sms_otp_log WHERE phone_norm = \? AND service = \? AND ts >= \?$/.test(q)) {
      return [{ n: LOG.filter((l) => l.phone === p[0] && l.service === p[1] && l.ts >= p[2]).length }];
    }
    if (/^SELECT COUNT\(\*\) n FROM sms_otp_log WHERE phone_norm = \? AND service = \? AND ts >= DATE_FORMAT\(NOW\(\),'%Y-%m-01'\)$/.test(q)) {
      const first = '2026-09-01 00:00:00';
      return [{ n: LOG.filter((l) => l.phone === p[0] && l.service === p[1] && l.ts >= first).length }];
    }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 150));
  },
  getPool: () => null,
};

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const otp = require('../otp');
  Module._load = origLoad;
  const { cycleStart, addMonths, prettyDay, sqlDt } = otp._quota;
  const NOW = new Date('2026-09-30T22:30:00');

  // ── month arithmetic ─────────────────────────────────────────────────────────────────────────────────
  section('adding a month without falling into the next one');
  ok('8 Apr + 1 = 8 May', sqlDt(addMonths(new Date('2026-04-08T23:40:00'), 1)).startsWith('2026-05-08'));
  ok('8 Apr + 5 = 8 Sep', sqlDt(addMonths(new Date('2026-04-08T23:40:00'), 5)).startsWith('2026-09-08'));
  // 2026 is not a leap year, so February has 28 days.
  ok('🔒 31 Jan + 1 = 28 Feb, NOT 3 March', sqlDt(addMonths(new Date('2026-01-31T09:00:00'), 1)).startsWith('2026-02-28'),
    sqlDt(addMonths(new Date('2026-01-31T09:00:00'), 1)));
  ok('🔒 31 Jan + 2 = 31 Mar — the clamp does not stick', sqlDt(addMonths(new Date('2026-01-31T09:00:00'), 2)).startsWith('2026-03-31'));
  ok('31 Mar + 1 = 30 Apr', sqlDt(addMonths(new Date('2026-03-31T09:00:00'), 1)).startsWith('2026-04-30'));
  ok('31 Dec + 1 = 31 Jan next year', sqlDt(addMonths(new Date('2026-12-31T09:00:00'), 1)).startsWith('2027-01-31'));

  // ── whose month is it ────────────────────────────────────────────────────────────────────────────────
  section('each customer\'s own month');
  let c = await cycleStart('9000000404', 'JioHotstar', NOW);
  ok('a plan from 8 Apr is in its 8 Sep → 8 Oct month on 30 Sep',
    sqlDt(c.start).startsWith('2026-09-08') && sqlDt(c.next).startsWith('2026-10-08'), { from: sqlDt(c.start), to: sqlDt(c.next) });
  c = await cycleStart('9000000028', 'JioHotstar', NOW);
  ok('somebody who bought on 28 Sep is still in their FIRST month', sqlDt(c.start).startsWith('2026-09-28'), sqlDt(c.start));
  ok('…and it does not run out on 1 Oct — it runs to 28 Oct', sqlDt(c.next).startsWith('2026-10-28'), sqlDt(c.next));
  c = await cycleStart('9000000002', 'JioHotstar', NOW);
  ok('somebody who bought on 2 Sep is in 2 Sep → 2 Oct', sqlDt(c.start).startsWith('2026-09-02') && sqlDt(c.next).startsWith('2026-10-02'));
  c = await cycleStart('9000000031', 'Zee5', NOW);
  ok('the 31 Jan customer lands on 30 Sep (clamped all the way along)', sqlDt(c.start).startsWith('2026-09-30'), sqlDt(c.start));
  ok('🔒 an EXPIRED subscription does not define a cycle', (await cycleStart('9000000909', 'JioHotstar', NOW)) === null);
  ok('🔒 nobody we know of → null, and the caller falls back', (await cycleStart('9111111111', 'JioHotstar', NOW)) === null);
  ok('🔒 the service key is matched the way the LOG writes it ("JioHotstar" row ↔ "JioHotstar" key)',
    (await cycleStart('9000000404', 'JioHotstar', NOW)) !== null && (await cycleStart('9000000404', 'Zee5', NOW)) === null);

  // ── the count ────────────────────────────────────────────────────────────────────────────────────────
  section('what actually gets counted');
  reset();
  // Three codes before their month began, two inside it.
  LOG.push({ phone: '9000000404', service: 'JioHotstar', ts: '2026-09-02 10:00:00' });
  LOG.push({ phone: '9000000404', service: 'JioHotstar', ts: '2026-09-05 10:00:00' });
  LOG.push({ phone: '9000000404', service: 'JioHotstar', ts: '2026-09-07 10:00:00' });
  LOG.push({ phone: '9000000404', service: 'JioHotstar', ts: '2026-09-09 10:00:00' });
  LOG.push({ phone: '9000000404', service: 'JioHotstar', ts: '2026-09-20 10:00:00' });
  let q = await otp.getOtpQuota('9000000404', 'JioHotstar');
  ok('only the codes since 8 Sep count — 2, not 5', q.used === 2 && q.remaining === 3, q);
  ok('…and it says which month it means', q.basis === 'plan' && q.cycleFrom.startsWith('2026-09-08') && q.cycleTo.startsWith('2026-10-08'), q);
  ok('the limit still comes from the panel', q.limit === 5 && q.source === 'panel', { limit: q.limit, source: q.source });

  // The whole point of the change, side by side.
  reset();
  for (const d of ['2026-09-28 12:00:00', '2026-09-29 12:00:00']) LOG.push({ phone: '9000000028', service: 'JioHotstar', ts: d });
  q = await otp.getOtpQuota('9000000028', 'JioHotstar');
  ok('🔒 the 28 Sep buyer has used 2 of 5 and keeps them until 28 Oct — no free reset on the 1st',
    q.used === 2 && q.cycleTo.startsWith('2026-10-28'), q);

  // ── the fallback ─────────────────────────────────────────────────────────────────────────────────────
  section('when there is no plan to date');
  reset();
  LOG.push({ phone: '9111111111', service: 'JioHotstar', ts: '2026-09-15 10:00:00' });
  q = await otp.getOtpQuota('9111111111', 'JioHotstar');
  ok('🔒 falls back to the calendar month rather than throwing or giving unlimited',
    q.basis === 'calendar' && q.used === 1 && q.remaining === 4, q);
  ok('…and says so, with no cycle dates to promise', q.cycleFrom === '' && q.cycleTo === '');

  // ── the message the customer reads ───────────────────────────────────────────────────────────────────
  section('what the customer is told');
  ok('a date is rendered for humans', prettyDay('2026-10-28 19:29:00') === '28 Oct', prettyDay('2026-10-28 19:29:00'));
  ok('…and an empty one stays empty', prettyDay('') === '' && prettyDay(null) === '');
  const src = fs.readFileSync(path.join(__dirname, '..', 'otp.js'), 'utf8');
  ok('the refusal names the day the allowance comes back, not "this month"',
    /you get ' \+ quota\.limit \+ ' more on ' \+ prettyDay\(quota\.cycleTo\)/.test(src));

  // ── promises in the code ─────────────────────────────────────────────────────────────────────────────
  section('the code');
  const nocomment = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('🔒 the calendar-month query is only the FALLBACK now, not the main path',
    (nocomment.match(/DATE_FORMAT\(NOW\(\),'%Y-%m-01'\)/g) || []).length === 1);
  ok('🔒 the cycle lookup only ever reads — it never writes a subscription',
    !/UPDATE subscriptions|INSERT INTO subscriptions/i.test(nocomment.split('async function cycleStart')[1].split('async function getOtpQuota')[0]));
  ok('a missing or unreadable plan can never raise the allowance', /catch \(_\) \{ cycle = null; \}/.test(nocomment));

  console.log('\n---------------------------------------');
  console.log('otp-quota-cycle: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
