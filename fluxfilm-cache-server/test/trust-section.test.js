/* 🏆 Why trust us — the numbers, the badges, the ticker and the journey on the home screen.
 *
 * Owner, 1 Oct 2026: "can we add our orders count and some proofs or some journey section to increase trust",
 * then: headline the lifetime figure WITH the live numbers · a live activity ticker · service badges with real counts.
 *
 * The home screen already had four trust cards and every one is a CLAIM. This is the evidence, so the thing that
 * matters most in this file is that the evidence is TRUE and that it gives nobody away:
 *   - the headline is the owner's typed claim and is NEVER computed from the database
 *   - every live number is counted, and is 0 rather than invented when it cannot be read
 *   - the ticker carries no name, phone, email or order id — it is served to logged-out visitors
 *   - no query compares a phone column across two tables (the MariaDB collation lesson, 27 Sep)
 *
 * Real trust.js on a fake MySQL with a fixed clock. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const NOW = Date.parse('2026-10-01T22:00:00+05:30');

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────
let SETTINGS, SUBS, ORDERS, missing, SQL;
const reset = () => {
  SETTINGS = {};
  SQL = [];
  missing = new Set();
  SUBS = [
    { service: 'Netflix (Group Offer)', status: 'ACTIVE', phone_norm: '9000000001' },
    { service: 'Netflix (Group Offer)', status: 'ACTIVE', phone_norm: '9000000002' },
    { service: 'Prime Video', status: 'ACTIVE', phone_norm: '9000000001' },
    { service: 'JioHotstar', status: 'ACTIVE', phone_norm: '9000000003' },
    { service: 'Zee5 Premium', status: 'EXPIRED', phone_norm: '9000000004' },
    { service: '', status: 'ACTIVE', phone_norm: '9000000009' },        // no service: never shown as a badge
  ];
  ORDERS = [
    { status: 'PAID', order_type: 'NEW', phone_norm: '9000000001', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', at: '2026-10-01 21:55:00', name: 'Amit Sharma', email: 'amit@example.com', order_id: 'FF1111111' },
    { status: 'PAID', order_type: 'RENEW', phone_norm: '9000000001', service: 'Prime Video', plan: '1 Month', at: '2026-10-01 20:00:00', name: 'Amit Sharma', email: 'amit@example.com', order_id: 'FF2222222' },
    { status: 'PAID', order_type: 'NEW', phone_norm: '9000000002', service: 'JioHotstar', plan: '3 Months', at: '2026-09-30 22:00:00', name: 'Keshav', email: 'k@example.com', order_id: 'FF3333333' },
    { status: 'PAID', order_type: 'RENEW', phone_norm: '9000000002', service: 'Zee5 Premium', plan: '1 Year', at: '2026-09-28 10:00:00', name: 'Keshav', email: 'k@example.com', order_id: 'FF4444444' },
    { status: 'PAID', order_type: 'NEW', phone_norm: '9000000003', service: 'Netflix', plan: 'Private 1M', at: '2026-08-01 10:00:00', name: 'Sudhi', email: 's@example.com', order_id: 'FF5555555' },
    { status: 'CREATED', order_type: 'NEW', phone_norm: '9000000004', service: 'Netflix', plan: 'Private 1M', at: '2026-10-01 21:59:00', name: 'Nobody', email: 'n@example.com', order_id: 'FF6666666' },
    { status: 'PAID', order_type: 'NEW', phone_norm: '', service: 'Prime Video', plan: '1 Month', at: '2026-07-01 10:00:00', name: '', email: '', order_id: 'FF7777777' },
  ];
  // 3 phones with paid orders (9000000001 x2, ...002 x2, ...003 x1) → 2 of 3 come back → 67%
};

const paid = () => ORDERS.filter((o) => String(o.status).toUpperCase() === 'PAID');
const activeSubs = () => SUBS.filter((x) => String(x.status).toUpperCase() === 'ACTIVE');

const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); const p = params || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    SQL.push(q);
    const gone = (t) => { if (missing.has(t)) { const e = new Error("Table 'x." + t + "' doesn't exist"); throw e; } };

    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(q)) { gone('app_settings'); return SETTINGS[p[0]] ? [{ value: SETTINGS[p[0]] }] : []; }
    if (/^INSERT INTO app_settings/.test(q)) { gone('app_settings'); SETTINGS[p[0]] = p[1]; return { affectedRows: 1 }; }

    if (/^SELECT COUNT\(\*\) n FROM subscriptions/.test(q)) { gone('subscriptions'); return [{ n: activeSubs().length }]; }
    if (/^SELECT COUNT\(DISTINCT phone_norm\) n FROM subscriptions/.test(q)) { gone('subscriptions'); return [{ n: new Set(activeSubs().map((x) => x.phone_norm).filter(Boolean)).size }]; }
    if (/^SELECT service, COUNT\(\*\) n FROM subscriptions/.test(q)) {
      gone('subscriptions');
      const by = {}; for (const x of activeSubs()) if (x.service) by[x.service] = (by[x.service] || 0) + 1;
      return Object.entries(by).map(([service, n]) => ({ service, n })).sort((a, b) => b.n - a.n);
    }
    if (/^SELECT COUNT\(\*\) n, SUM\(UPPER\(COALESCE\(order_type, ''\)\) = 'RENEW'\) renewals FROM orders/.test(q)) {
      gone('orders');
      return [{ n: paid().length, renewals: paid().filter((o) => String(o.order_type).toUpperCase() === 'RENEW').length }];
    }
    if (/^SELECT COUNT\(\*\) total, SUM\(n > 1\) backs FROM \(SELECT phone_norm, COUNT\(\*\) n FROM orders/.test(q)) {
      gone('orders');
      const by = {}; for (const o of paid()) if (o.phone_norm) by[o.phone_norm] = (by[o.phone_norm] || 0) + 1;
      const v = Object.values(by);
      return [{ total: v.length, backs: v.filter((x) => x > 1).length }];
    }
    if (/^SELECT service, plan, order_type, COALESCE\(verified_at, created_at_sheet\) at FROM orders/.test(q)) {
      gone('orders');
      return paid().filter((o) => o.at).sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, 12).map((o) => ({ service: o.service, plan: o.plan, order_type: o.order_type, at: o.at }));
    }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 160));
  },
  getPool: () => null,
};

const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
const trust = require('../trust');
Module._load = origLoad;

(async () => {
  // ── the numbers are counted, not invented ────────────────────────────────────────────────────────────────
  section('the live numbers are counted from the database');
  reset(); trust._internal.reset();
  let l = await trust.live(true, NOW);
  ok('plans running now = the ACTIVE subscriptions', l.running === 5, l);
  ok('customers with a live plan counts each person once', l.customersWithPlan === 4, l);
  ok('paid orders counts only PAID — a cart left open is not a sale', l.paidOrders === 6, l);
  ok('renewals counted', l.renewals === 2, l);
  ok('🔒 "customers come back" is 2 of 3 people who have a phone on their order = 67%', l.customers === 3 && l.comeBackPct === 67, l);

  section('service badges');
  ok('one badge per service, biggest first', l.services[0].service === 'Netflix (Group Offer)' && l.services[0].n === 2, l.services);
  ok('🔒 an expired plan is not counted as running', !l.services.some((x) => x.service === 'Zee5 Premium'), l.services);
  ok('🔒 a row with no service name is never shown as an empty badge', l.services.every((x) => x.service), l.services);

  // ── the headline is the owner's claim, never a computed number ───────────────────────────────────────────
  section('the headline is a claim, and stays one');
  reset(); trust._internal.reset();
  let t = await trust.getTrust();
  ok('the default headline is the owner\'s figure, NOT the 6 orders the database holds',
    t.headline.orders === '5,000+' && t.headline.text === '5,000+ orders delivered since 2024', t.headline);
  ok('🔒 nothing computed ever overwrites it', (await trust.live(true, NOW)).paidOrders === 6 && t.headline.orders === '5,000+');
  let r = await trust.saveSettings({ lifetimeOrders: '6,200+', since: '2023' });
  trust._internal.reset();
  t = await trust.getTrust();
  ok('the owner can change it', r.ok && t.headline.text === '6,200+ orders delivered since 2023', t.headline);
  ok('🔒 a headline with markup in it is refused, not escaped-and-hoped',
    (await trust.saveSettings({ lifetimeOrders: '<b>lots</b>' })).ok === false);
  ok('🔒 and so is a silly year', (await trust.saveSettings({ since: '12' })).ok === false);
  ok('an empty headline simply removes it rather than printing "orders delivered since"',
    (await trust.saveSettings({ lifetimeOrders: '' })).ok === true);
  trust._internal.reset();
  ok('…and the section then has no headline at all', (await trust.getTrust()).headline === null);

  // ── privacy ──────────────────────────────────────────────────────────────────────────────────────────────
  section('nothing here can identify a customer');
  reset(); trust._internal.reset();
  t = await trust.getTrust();
  const blob = JSON.stringify(t);
  ok('🔒 no phone number anywhere in what the storefront is sent', !/9000000\d{3}/.test(blob), blob.slice(0, 200));
  ok('🔒 no customer name', !/Amit|Keshav|Sudhi/.test(blob));
  ok('🔒 no email address', !/@example\.com/.test(blob));
  ok('🔒 no order id', !/FF\d{7}/.test(blob));
  ok('the ticker says what happened and roughly when, and no more',
    t.recent[0].service === 'Netflix (Group Offer)' && t.recent[0].kind === 'started' && /ago|just now/.test(t.recent[0].ago)
    && Object.keys(t.recent[0]).sort().join() === 'ago,kind,plan,service', t.recent[0]);
  ok('a renewal reads as a renewal', t.recent[1].kind === 'renewed' && t.recent[1].service === 'Prime Video', t.recent[1]);
  ok('🔒 an unpaid order is NOT in the ticker — it would be announcing a sale that never happened',
    !t.recent.some((x) => x.service === 'Netflix' && x.plan === 'Private 1M' && /min ago/.test(x.ago)), t.recent);

  section('"4 min ago" is vague on purpose');
  ok('minutes', trust.ago('2026-10-01 21:55:00', NOW) === '5 min ago', trust.ago('2026-10-01 21:55:00', NOW));
  ok('under a minute', trust.ago('2026-10-01 21:59:40', NOW) === 'just now');
  ok('hours', trust.ago('2026-10-01 19:00:00', NOW) === '3 hours ago');
  ok('one hour is not "1 hours"', trust.ago('2026-10-01 21:00:00', NOW) === '1 hour ago');
  ok('yesterday', trust.ago('2026-09-30 20:00:00', NOW) === 'yesterday');
  ok('days, then months', trust.ago('2026-09-20 20:00:00', NOW) === '11 days ago' && trust.ago('2026-07-01 20:00:00', NOW) === '3 months ago');
  ok('🔒 an unreadable date gives nothing rather than "NaN ago"', trust.ago('', NOW) === '' && trust.ago('not a date', NOW) === '');

  // ── the journey ──────────────────────────────────────────────────────────────────────────────────────────
  section('the journey');
  reset(); trust._internal.reset();
  t = await trust.getTrust();
  ok('there is a journey out of the box, for the owner to correct', t.journey.length === 4 && t.journey[0].when === '2024', t.journey);
  r = await trust.saveSettings({ journey: [{ when: '2024', title: 'Started', text: 'With friends.' }, { when: '', title: '', text: '' }] });
  trust._internal.reset();
  t = await trust.getTrust();
  ok('the owner can rewrite it, and a blank row is dropped rather than rendered as a gap', r.ok && t.journey.length === 1 && t.journey[0].title === 'Started', t.journey);
  r = await trust.saveSettings({ journey: new Array(20).fill({ when: '2024', title: 'x', text: 'y' }) });
  ok('🔒 the list is capped so the home screen cannot be flooded', r.ok && r.settings.journey.length === trust.JOURNEY_MAX, r.settings.journey.length);
  ok('🔒 markup in a journey step is stripped', (await trust.saveSettings({ journey: [{ when: '2024', title: '<script>x</script>', text: 'y' }] })).settings.journey[0].title === 'scriptx/script');

  // ── the switches ─────────────────────────────────────────────────────────────────────────────────────────
  section('the owner can turn any of it off');
  reset(); trust._internal.reset();
  await trust.saveSettings({ showTicker: false }); trust._internal.reset();
  t = await trust.getTrust();
  ok('ticker off', t.recent.length === 0 && t.services.length > 0 && t.on === true, { recent: t.recent.length, services: t.services.length });
  await trust.saveSettings({ showServices: false, showJourney: false }); trust._internal.reset();
  t = await trust.getTrust();
  ok('badges and journey off, the numbers stay', t.services.length === 0 && t.journey.length === 0 && t.live.running === 5, t);
  await trust.saveSettings({ enabled: false }); trust._internal.reset();
  t = await trust.getTrust();
  ok('🔒 the whole section off = { on: false } and the home screen draws nothing', t.ok === true && t.on === false, t);

  // ── it must never break the home screen ──────────────────────────────────────────────────────────────────
  section('a broken database must not break the landing page');
  reset(); trust._internal.reset();
  missing.add('subscriptions');
  t = await trust.getTrust();
  ok('no subscriptions table: the section still answers ok', t.ok === true && t.on === true, t);
  ok('…with 0 rather than a wrong or invented number', t.live.running === 0 && t.services.length === 0, t.live);
  ok('…and the parts that CAN be read are still right', t.live.comeBackPct === 67 && t.recent.length > 0, t.live);
  reset(); trust._internal.reset();
  missing.add('orders'); missing.add('subscriptions'); missing.add('app_settings');
  t = await trust.getTrust();
  ok('🔒 nothing readable at all: still ok, nothing invented', t.ok === true && t.live.running === 0 && t.live.comeBackPct === 0 && !t.recent.length, t);
  ok('…and the owner\'s default claim still shows, because it was never a database number', t.headline.orders === '5,000+', t.headline);

  section('a thrown error is caught, not sent to the home screen');
  reset(); trust._internal.reset();
  const realQuery = mockDb.query;
  mockDb.query = async () => { throw new Error('connection lost'); };
  t = await trust.getTrust();
  mockDb.query = realQuery;
  ok('🔒 { ok: true, on: false } — the landing screen simply shows less', t.ok === true && t.on === false, t);

  // ── caching ──────────────────────────────────────────────────────────────────────────────────────────────
  section('the home page does not hammer the database');
  reset(); trust._internal.reset();
  await trust.getTrust();
  const n1 = SQL.length;
  await trust.getTrust(); await trust.getTrust();
  ok('three home loads, one set of queries', SQL.length === n1, { first: n1, after: SQL.length });
  ok('…and it is a 5-minute cache, not forever', trust.CACHE_MS === 5 * 60e3);

  // ── promises in the code ─────────────────────────────────────────────────────────────────────────────────
  section('the code');
  const src = fs.readFileSync(path.join(__dirname, '..', 'trust.js'), 'utf8');
  const nocomment = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('🔒 no query joins orders to subscriptions — those tables do not share a collation',
    !/FROM orders[\s\S]{0,200}JOIN subscriptions|FROM subscriptions[\s\S]{0,200}JOIN orders/i.test(nocomment));
  ok('🔒 the ticker query selects no name, phone, email or order id',
    /SELECT service, plan, order_type, COALESCE\(verified_at, created_at_sheet\) at FROM orders/.test(nocomment)
    && !/SELECT[^;]*\bname\b[^;]*FROM orders/.test(nocomment));
  ok('🔒 the public endpoint can never throw at the home screen', /catch \(e\) \{[\s\S]{0,200}return \{ ok: true, on: false \};/.test(nocomment));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('the section is drawn on Home', /React\.createElement\(TrustProof, null\)/.test(html) && /function TrustProof\(\)/.test(html));
  ok('…and draws NOTHING until the server answers, so it cannot delay the page', /if \(!t\) return null;/.test(html));
  ok('the storefront action is reachable', /getTrust\(onSuccess, onFailure\)/.test(html));
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('getTrust is a public storefront action with a rate limit', /'getTrust'/.test(sv) && /getTrust: security\.rateLimiter/.test(sv));
  ok('package.json runs this test', /node test\/trust-section\.test\.js/.test(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')));

  // ── the admin screen must keep the owner honest ──────────────────────────────────────────────────────────
  section('admin is told what the database can actually prove');
  reset(); trust._internal.reset();
  const routes = {};
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  const audits = [];
  trust.mount(app, { db: mockDb, auth: () => true, audit: { record: (q, a) => audits.push(a) } });
  const call = (m, p, body) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } };
    routes[m + ' ' + p]({ body }, res);
  });
  let x = await call('GET', '/admin/api/trust');
  ok('the claim and the proof are shown side by side', x.body.ok && x.body.settings.lifetimeOrders === '5,000+' && x.body.proved.paidOrders === 6, x.body.proved);
  ok('🔒 and it SAYS the database holds less, so the headline is an informed choice, not an accident',
    /MySQL can prove 6 paid orders/.test(x.body.proved.note) && /real lifetime number is higher/.test(x.body.proved.note), x.body.proved.note);
  x = await call('POST', '/admin/api/trust', { lifetimeOrders: '7,000+' });
  ok('saving works and is written to the change log', x.body.ok && audits.some((a) => a.action === 'trust.save' && /7,000\+/.test(a.summary)), audits);
  x = await call('POST', '/admin/api/trust', { since: 'nineteen' });
  ok('a bad value is refused with a reason the owner can read', x.code === 400 && /four digits/.test(x.body.message), x.body);

  console.log('\n---------------------------------------');
  console.log('trust-section: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
