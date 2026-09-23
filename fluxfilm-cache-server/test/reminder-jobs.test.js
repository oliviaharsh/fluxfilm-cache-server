/* ✉️ The three reminder jobs (owner, 23 Sep 2026: "cron jobs - for customers who did not pay for the order and
   left - once - also reminder emails when customers subs is about to expire with links - old customers get emails
   with discount codes"). Real reminderjobs.js against a fake MySQL, a fake mailer and a fake push. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const DAY = 86400000, HOUR = 3600000;
const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime();   // 24 Sep 2026, midday IST — inside sending hours
const at = (ms) => new Date(NOW + ms);
const ymd = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };

// ---------------------------------------------------------------- the world
let SETTINGS = {};
let ORDERS = [];
let SUBS = [];
let CUSTOMERS = [];
let LOG = [];

const fakeDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    p = p || [];
    if (/SELECT value FROM app_settings/.test(q)) return SETTINGS.value === undefined ? [] : [{ value: SETTINGS.value }];
    if (/^INSERT INTO app_settings/.test(q)) { SETTINGS.value = p[1]; return { affectedRows: 1 }; }
    if (/^INSERT INTO reminder_log/.test(q)) { LOG.push({ sub_id: p[0], channel: p[1], kind: p[2], expiry_date: p[3], ok: p[4], note: p[5], ts: new Date() }); return { affectedRows: 1 }; }
    if (/SELECT 1 AS x FROM reminder_log/.test(q)) {
      const [key, kind] = p;
      let rows = LOG.filter((l) => l.sub_id === key && l.kind === kind);
      let i = 2;
      if (/expiry_date = \?/.test(q)) { const e = p[i++]; rows = rows.filter((l) => String(l.expiry_date) === String(e)); }
      if (/ts > \?/.test(q)) { const t = new Date(p[i++]); rows = rows.filter((l) => l.ts > t); }
      return rows.length ? [{ x: 1 }] : [];
    }
    if (/FROM orders o LEFT JOIN customers c/.test(q)) {
      const older = new Date(p[0]), newer = new Date(p[1]);
      return ORDERS.filter((o) => String(o.status).toUpperCase() === 'CREATED'
        && new Date(o.created_at_sheet) < older && new Date(o.created_at_sheet) > newer)
        .map((o) => Object.assign({}, o, { email: (CUSTOMERS.find((c) => c.phone_norm === o.phone_norm) || {}).email || null }));
    }
    if (/FROM subscriptions sb LEFT JOIN customers c/.test(q)) {
      const days = p;
      return SUBS.filter((x) => ['ACTIVE', 'EXPIRED'].includes(String(x.status).toUpperCase())
        && x.expiry_date && days.includes(ymd(x.expiry_date)))
        .map((x) => { const c = CUSTOMERS.find((y) => y.phone_norm === x.phone_norm) || {}; return Object.assign({}, x, { name: c.name || null, email: c.email || null }); });
    }
    if (/GROUP BY sb.phone_norm HAVING MAX/.test(q)) {
      const before = new Date(p[0]);
      const byPhone = new Map();
      for (const x of SUBS) {
        if (!x.expiry_date) continue;
        const cur = byPhone.get(x.phone_norm);
        if (!cur || new Date(x.expiry_date) > new Date(cur.last_expiry)) byPhone.set(x.phone_norm, { phone_norm: x.phone_norm, last_expiry: x.expiry_date, service: x.service });
      }
      return [...byPhone.values()].filter((r) => new Date(r.last_expiry) < before);
    }
    if (/FROM subscriptions WHERE phone_norm = \? AND UPPER\(status\) = 'ACTIVE'/.test(q)) {
      const live = SUBS.some((x) => x.phone_norm === p[0] && String(x.status).toUpperCase() === 'ACTIVE' && (!x.expiry_date || new Date(x.expiry_date) > new Date()));
      return live ? [{ x: 1 }] : [];
    }
    if (/SELECT name, email FROM customers WHERE phone_norm/.test(q)) {
      const c = CUSTOMERS.find((x) => x.phone_norm === p[0]);
      return c ? [{ name: c.name, email: c.email }] : [];
    }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 120));
  },
};

const MAILED = [];
const PUSHED = [];
let PUSH_DEVICES = new Set();
const fakeMailer = { send: async (to, subject, html) => { MAILED.push({ to, subject, html }); return { ok: true }; } };
const fakePush = {
  hasDevice: async (phone) => PUSH_DEVICES.has(phone),
  sendToPhone: async (phone, msg) => { PUSHED.push({ phone, msg }); return { sent: 1 }; },
};

const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return fakeDb; return origLoad.apply(this, arguments); };
const jobs = require('../reminderjobs');
const credit = require('../credit');
Module._load = origLoad;

const deps = { mailer: fakeMailer, push: fakePush, credit };

function reset() {
  SETTINGS = {}; LOG = []; MAILED.length = 0; PUSHED.length = 0; PUSH_DEVICES = new Set();
  ORDERS = [
    { order_id: 'FF2000001', phone_norm: '9000000001', name: 'Asha Kumar', service: 'Netflix', plan: 'Sharing 1M', final_amount: 199, status: 'CREATED', created_at_sheet: at(-3 * HOUR) },
    { order_id: 'FF2000002', phone_norm: '9000000002', name: 'Bilal', service: 'Prime Video', plan: '1 Month', final_amount: 149, status: 'CREATED', created_at_sheet: at(-30 * 60000) },   // too fresh
    { order_id: 'FF2000003', phone_norm: '9000000003', name: 'Chand', service: 'Netflix', plan: 'Private 1M', final_amount: 399, status: 'PAID', created_at_sheet: at(-5 * HOUR) },          // paid
    { order_id: 'FF2000004', phone_norm: '9000000004', name: 'Divya', service: 'Netflix', plan: 'Sharing 1M', final_amount: 199, status: 'CREATED', created_at_sheet: at(-20 * DAY) },       // ancient
  ];
  SUBS = [
    { sub_id: 'SUB-A', phone_norm: '9000000001', service: 'Netflix', plan: 'Sharing 1M', status: 'ACTIVE', expiry_date: at(3 * DAY) },
    { sub_id: 'SUB-B', phone_norm: '9000000002', service: 'Prime Video', plan: '1 Month', status: 'ACTIVE', expiry_date: at(1 * DAY) },
    { sub_id: 'SUB-C', phone_norm: '9000000005', service: 'Netflix', plan: 'Private 1M', status: 'ACTIVE', expiry_date: at(9 * DAY) },   // not due yet
    { sub_id: 'SUB-D', phone_norm: '9000000006', service: 'Netflix', plan: 'Sharing 1M', status: 'EXPIRED', expiry_date: at(-60 * DAY) },
    { sub_id: 'SUB-E', phone_norm: '9000000007', service: 'Netflix', plan: 'Sharing 1M', status: 'EXPIRED', expiry_date: at(-10 * DAY) }, // lapsed, but not 30 days
  ];
  CUSTOMERS = [
    { phone_norm: '9000000001', name: 'Asha Kumar', email: 'asha@example.com' },
    { phone_norm: '9000000002', name: 'Bilal', email: 'bilal@example.com' },
    { phone_norm: '9000000004', name: 'Divya', email: 'divya@example.com' },
    { phone_norm: '9000000006', name: 'Farah', email: 'farah@example.com' },
    { phone_norm: '9000000007', name: 'Gita', email: 'gita@example.com' },
  ];
}
const on = async (patch) => jobs.saveSettings(patch, deps);

(async () => {
  // ── nothing happens until the owner says so ────────────────────────────────────────────────────────────────
  section('🔒 everything is off until it is switched on');
  reset();
  let d = await jobs.getSettings(deps);
  ok('all three jobs ship OFF', d.abandoned.on === false && d.expiryMail.on === false && d.winback.on === false, d);
  let r = await jobs.run(NOW, deps);
  ok('a run with nothing on sends nothing at all', r.ran === 0 && MAILED.length === 0 && PUSHED.length === 0, { r, MAILED: MAILED.length });

  section('👀 the preview reads, and sends nothing');
  const pv = await jobs.preview('abandoned', NOW, deps);
  ok('it finds the unpaid order', pv.ok && pv.total === 1 && pv.candidates[0].key === 'FF2000001', pv.candidates);
  ok('…shows exactly what would go out', !!pv.sample && /still waiting/.test(pv.sample.subject) && /FF2000001/.test(pv.sample.html), pv.sample && pv.sample.subject);
  ok('…and nothing was sent or written down', MAILED.length === 0 && PUSHED.length === 0 && LOG.length === 0);

  // ── 1 · the order nobody paid for ──────────────────────────────────────────────────────────────────────────
  section('🛒 the order nobody paid for');
  reset();
  await on({ abandoned: { on: true } });
  r = await jobs.run(NOW, deps);
  const job1 = r.jobs.find((j) => j.job === 'abandoned');
  ok('only the one that is 3 hours old is written to', job1.sent === 1 && MAILED.length === 1 && MAILED[0].to === 'asha@example.com', { job1, to: MAILED.map((m) => m.to) });
  ok('…a 30-minute-old order is left alone — they may still be paying', !MAILED.some((m) => m.to === 'bilal@example.com'));
  ok('…a PAID order is never chased', !MAILED.some((m) => /FF2000003/.test(m.html)));
  ok('…and a 20-day-old one is not dragged up', !MAILED.some((m) => m.to === 'divya@example.com'));
  ok('the mail carries the order and a way back to it', /FF2000001/.test(MAILED[0].html) && /source=reminder(&|&amp;)order=FF2000001/.test(MAILED[0].html), MAILED[0].subject);

  MAILED.length = 0;
  r = await jobs.run(NOW + HOUR, deps);
  ok('🔁 running again sends NOTHING — one reminder per order, ever', MAILED.length === 0 && PUSHED.length === 0, { MAILED: MAILED.length });

  section('🛒 …by push when they have it');
  reset();
  PUSH_DEVICES = new Set(['9000000001']);
  await on({ abandoned: { on: true } });
  await jobs.run(NOW, deps);
  ok('a customer with notifications gets a push, not an email', PUSHED.length === 1 && PUSHED[0].phone === '9000000001' && MAILED.length === 0, { PUSHED: PUSHED.length, MAILED: MAILED.length });
  ok('…and it is written down as PUSH', LOG.some((l) => l.sub_id === 'FF2000001' && l.channel === 'PUSH' && l.kind === 'ABANDONED'), LOG);

  // ── 2 · the expiry email ───────────────────────────────────────────────────────────────────────────────────
  section('⏳ expiry emails — only where push cannot reach');
  reset();
  PUSH_DEVICES = new Set(['9000000002']);          // Bilal has push; Asha does not
  await on({ expiryMail: { on: true } });
  r = await jobs.run(NOW, deps);
  ok('the customer with no push is emailed', MAILED.length === 1 && MAILED[0].to === 'asha@example.com', MAILED.map((m) => m.to));
  ok('…the one push already tells is skipped, so nobody hears it twice', !MAILED.some((m) => m.to === 'bilal@example.com'));
  ok('…a plan 9 days out is not touched', !MAILED.some((m) => /SUB-C/.test(m.html)));
  ok('the email has the renew link in it', /renew=SUB-A/.test(MAILED[0].html), MAILED[0].subject);

  MAILED.length = 0;
  await jobs.run(NOW + 2 * HOUR, deps);
  ok('🔁 the same expiry is never mailed twice', MAILED.length === 0);

  section('⏳ …and it can be told to mail everyone');
  reset();
  PUSH_DEVICES = new Set(['9000000002']);
  await on({ expiryMail: { on: true, onlyWithoutPush: false } });
  await jobs.run(NOW, deps);
  ok('with the switch off it mails the push customer too', MAILED.length === 2, MAILED.map((m) => m.to));

  // ── 3 · win-back ───────────────────────────────────────────────────────────────────────────────────────────
  section('💚 win-back');
  reset();
  await on({ winback: { on: true, code: 'COMEBACK', percent: 20 } });
  r = await jobs.run(NOW, deps);
  ok('only the customer gone 60 days is written to', MAILED.length === 1 && MAILED[0].to === 'farah@example.com', MAILED.map((m) => m.to));
  ok('…10 days lapsed is too soon', !MAILED.some((m) => m.to === 'gita@example.com'));
  ok('…someone with a live plan is never called lapsed', !MAILED.some((m) => m.to === 'asha@example.com'));
  ok('the code and the discount are in the email', /COMEBACK/.test(MAILED[0].html) && /20% off/.test(MAILED[0].html), MAILED[0].subject);

  // Watch Farah specifically: Gita crosses the 30-day line during these jumps and is a NEW candidate, not a repeat.
  MAILED.length = 0;
  await jobs.run(NOW + 30 * DAY, deps);
  ok('🔁 not pestered again inside the every-90-days window', !MAILED.some((m) => m.to === 'farah@example.com'), MAILED.map((m) => m.to));
  ok('…while someone who has only just lapsed is a new candidate, not a repeat', MAILED.some((m) => m.to === 'gita@example.com'), MAILED.map((m) => m.to));
  MAILED.length = 0;
  await jobs.run(NOW + 100 * DAY, deps);
  ok('…but welcome back again after it', MAILED.some((m) => m.to === 'farah@example.com'), MAILED.map((m) => m.to));

  section('\U0001f49a the discount can be switched off without silencing the email');
  reset();
  await on({ winback: { on: true, withCode: false } });
  await jobs.run(NOW, deps);
  ok('with no discount offered the email still goes', MAILED.length === 1 && MAILED[0].to === 'farah@example.com', MAILED.map((m) => m.to));
  ok('...and it says nothing about a code or a discount', !/code/i.test(MAILED[0].html) && !/discount/i.test(MAILED[0].html) && !/% off/.test(MAILED[0].html), MAILED[0].html.slice(0, 200));
  ok('...nor in the subject', !/off|discount|code/i.test(MAILED[0].subject), MAILED[0].subject);
  ok('...and it still gives them a way back', /source=winback/.test(MAILED[0].html));
  {
    let e = '';
    try { await on({ winback: { on: true, withCode: false, code: '' } }); } catch (x) { e = x.message; }
    ok('...switching it on needs no code at all now', e === '', e);
  }
  reset();
  await on({ winback: { on: true, withCode: true, code: 'COMEBACK', percent: 15 } });
  await jobs.run(NOW, deps);
  ok('...and with it back on, the code returns', /COMEBACK/.test(MAILED[0].html) && /15% off/.test(MAILED[0].html));

  section('💚 a code that does not exist is never offered');
  reset();
  let threw = '';
  try { await on({ winback: { on: true, code: '' } }); } catch (e) { threw = e.message; }
  ok('switching it on with no code is refused', /code/i.test(threw), threw);
  SETTINGS.value = JSON.stringify({ winback: { on: true, code: '', afterDays: 30, everyDays: 90, percent: 0 } });
  await jobs.run(NOW, deps);
  ok('…and even if the setting is forced on, nothing goes out', MAILED.length === 0);

  // ── the guards ─────────────────────────────────────────────────────────────────────────────────────────────
  section('🛡 the guards');
  reset();
  await on({ abandoned: { on: true }, expiryMail: { on: true }, winback: { on: true, code: 'X' } });
  const night = new Date(2026, 8, 24, 3, 0, 0).getTime();
  r = await jobs.run(night, deps);
  ok('nothing is sent at 3am', r.skipped === 'quiet hours' && MAILED.length === 0, r);

  reset();
  for (let i = 0; i < 40; i++) ORDERS.push({ order_id: 'FF300' + String(i).padStart(4, '0'), phone_norm: '90000100' + String(i).padStart(2, '0'), name: 'X' + i, service: 'Netflix', plan: 'S', final_amount: 99, status: 'CREATED', created_at_sheet: at(-4 * HOUR) });
  for (let i = 0; i < 40; i++) CUSTOMERS.push({ phone_norm: '90000100' + String(i).padStart(2, '0'), name: 'X' + i, email: 'x' + i + '@example.com' });
  await on({ abandoned: { on: true }, maxPerRun: 5 });
  await jobs.run(NOW, deps);
  ok('a first switch-on cannot mail everybody at once', MAILED.length === 5, MAILED.length);

  reset();
  await on({ abandoned: { on: true } });
  CUSTOMERS = [];                                  // nobody has an email address
  await jobs.run(NOW, deps);
  ok('no email and no push → nothing sent, and NOT logged, so a later address still gets one', MAILED.length === 0 && LOG.length === 0);

  section('✉️ the test send');
  reset();
  let t = await jobs.sendTest('winback', 'not-an-email', deps);
  ok('a bad address is refused', t.ok === false, t);
  t = await jobs.sendTest('abandoned', 'owner@example.com', deps);
  ok('the owner can send one to themselves first', t.ok === true && MAILED.length === 1 && MAILED[0].to === 'owner@example.com' && /^\[TEST\]/.test(MAILED[0].subject), { t, s: MAILED[0] && MAILED[0].subject });
  ok('…and a test is never confused with a real send in the log', LOG.length === 0);

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok('admin.js mounts it', /require\('\.\/reminderjobs'\)\.mount\(app,/.test(read('admin.js')));
  ok('server.js starts the hourly timer', /require\('\.\/reminderjobs'\)\.startTimer\(\)/.test(read('server.js')));
  ok('there is a cron route, and the key goes in the header', /app\.post\('\/cron\/reminders'/.test(read('reminderjobs.js')) && /never in the URL/.test(read('reminderjobs.js')));
  ok('every route is behind the admin sign-in', (() => {
    const src = read('reminderjobs.js');
    const routes = src.match(/app\.(get|post)\('[^']+', async \(req, res\) => \{\s*\n\s*if \(!auth\(req, res\)\) return;/g) || [];
    const all = src.match(/app\.(get|post)\('/g) || [];
    return routes.length === all.length && all.length === 5;
  })(), 'routes');
  ok('it never writes to a customer row — only settings and the log', !/UPDATE (customers|orders|subscriptions)|DELETE FROM/.test(read('reminderjobs.js')));
  ok('the screen is in the panel and registered', /\['rjobs', '✉️', 'Email jobs'\]/.test(read('admin.html')) && /m\.rjobs = rjView;/.test(read('admin.html')));
  ok('the screen says, in words, that nothing goes out until it is switched on', /off until you switch it on/.test(read('admin.html')));
  ok('👀 Preview and ✉️ Send me one are both there, before any switch', /data-rjpv=/.test(read('admin.html')) && /data-rjtest=/.test(read('admin.html')));
ok('the panel has the discount switch, and hides the code boxes when it is off', /data-rjb="winback\.withCode"/.test(read('admin.html')) && /cfg\.withCode !== false\n?\s*\? '<label>Discount code/.test(read('admin.html').replace(/\r/g, '')));
  ok('every day-count on the screen is editable', (() => {
    const h = read('admin.html');
    return ['afterHours', 'withinHours', 'afterDays', 'everyDays'].every((k) => h.indexOf("'" + k + "'") > -1) && /data-rjd="1"/.test(h);
  })());
    ok('this test file runs in the suite', / && node test\/reminder-jobs\.test\.js/.test(read('package.json')));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
