/* ℹ️ The figures on /about as well. Owner, 2 Oct 2026: "Can we also show these figures in about section".
 *
 * /about is server-rendered, so the numbers go into the HTML itself — which is the point: a figure only a
 * browser running JavaScript can see is invisible to Google and to anyone the link is shared with, and this
 * page exists to be read by exactly those.
 *
 * What matters most here is that About cannot be taken down by a numbers problem. It is a footer page people
 * open when they want reassurance; losing it because a query failed would be a poor trade.
 *
 * Real seo.js with a faked trust module. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const FULL = {
  ok: true, on: true, since: '2024',
  totals: { orders: 5000, customers: 1438, recurring: 884, renewals: 1825, recurringPct: 61 },
  live: { running: 186, renewals: 349 },
  services: [{ service: 'Netflix', n: 49 }], recent: [], journey: [],
};
let TRUST = FULL;
const fakeTrust = { getTrust: async () => { if (TRUST instanceof Error) throw TRUST; return TRUST; } };

const origLoad = Module._load;
Module._load = function (req) { if (req === './trust') return fakeTrust; return origLoad.apply(this, arguments); };
const seo = require('../seo');
// NOT restored here, on purpose: trustFigures() requires './trust' LAZILY, at call time. Restoring the
// loader now would let the real trust.js run and answer "DB not configured" — a harness bug that reads
// exactly like a product bug. Put back after the last assertion.

(async () => {
  section('the numbers are in the HTML, not only in the app');
  TRUST = FULL;
  let h = await seo.trustFigures();
  ok('orders, with Indian digit grouping', /5,000/.test(h) && /orders delivered/.test(h), h.slice(0, 200));
  ok('customers served', /1,438/.test(h) && /customers served/.test(h));
  ok('came back for more', /884/.test(h) && /came back for more/.test(h));
  ok('plans running right now', /186/.test(h) && /plans running right now/.test(h));
  ok('the year', /Serving India since 2024/.test(h));
  ok('🔒 it says which half is counted and which came before, so the page is not quietly overclaiming',
    /include the years before our current system/.test(h) && /counted live and updates by itself/.test(h), h.slice(-260));
  ok('it is a heading a reader can scan', /FluxFilm by the numbers/.test(h));

  section('🔒 About must render even when the numbers cannot');
  TRUST = { ok: true, on: false };
  ok('section switched off → nothing, not an empty box', (await seo.trustFigures()) === '');
  TRUST = new Error('connection lost');
  ok('the lookup throws → still nothing, no crash', (await seo.trustFigures()) === '');
  TRUST = null;
  ok('the module answers nothing at all → nothing', (await seo.trustFigures()) === '');
  TRUST = { ok: true, on: true, totals: {}, live: {} };
  ok('every figure zero → no block rather than a row of noughts', (await seo.trustFigures()) === '');
  TRUST = { ok: true, on: true, totals: { orders: 5000 }, live: {} };
  h = await seo.trustFigures();
  ok('one figure → just that one, no blanks beside it', /5,000/.test(h) && !/customers served/.test(h) && !/plans running/.test(h), h);
  ok('…and no year line when there is no year', !/Serving India since/.test(h));

  section('the whole page still builds');
  TRUST = FULL;
  let page = await seo.aboutPage();
  const html = typeof page === 'string' ? page : (page && (page.html || page.body || JSON.stringify(page)));
  ok('/about contains the figures', /5,000/.test(html) && /FluxFilm by the numbers/.test(html));
  ok('…and everything that was there before', /FluxFilm helps people in India watch more for less/.test(html)
    && /TMDB/.test(html) && /See plans/.test(html), html.length);
  ok('the figures sit after the intro and before the buttons, where a reader expects them',
    html.indexOf('watch more for less') < html.indexOf('FluxFilm by the numbers')
    && html.indexOf('FluxFilm by the numbers') < html.indexOf('See plans'));
  TRUST = new Error('db down');
  page = await seo.aboutPage();
  const html2 = typeof page === 'string' ? page : (page && (page.html || page.body || JSON.stringify(page)));
  ok('🔒 and with the numbers broken, About is still a complete page',
    /FluxFilm helps people in India watch more for less/.test(html2) && /TMDB/.test(html2) && !/by the numbers/.test(html2));

  section('nothing personal reaches a public, crawlable page');
  TRUST = FULL;
  h = await seo.trustFigures();
  ok('🔒 no phone, email or order id', !/\b[6-9]\d{9}\b/.test(h) && !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(h) && !/\bFF\d{6,}\b/.test(h));

  console.log('\n---------------------------------------');
  Module._load = origLoad;
  console.log('about-figures: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { Module._load = origLoad; console.log('CRASH', e); process.exitCode = 1; });
