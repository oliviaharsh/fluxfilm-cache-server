/* ⭐🏆 The two admin PANEL screens: Reviews (approve · hide · delete · REPLY) and Why trust us.
 *
 * Owner, 2 Oct 2026: "Yes pls build both". PRs 226 and 227 shipped the engines and the storefront but no panel
 * UI at all, so the owner could not reply to a review, approve a held one, or change the headline from their
 * phone — which is the owner-facing half of "reviews function where we also reply to them".
 *
 * The panel is plain browser JavaScript inside admin.html, so `node --check` proves nothing about it (the one
 * blank-page bug came from a missing `)}`). This test does what the lesson says: it pulls the REAL view source
 * out of admin.html, runs it against a tiny fake DOM, and then clicks the buttons and checks what was sent.
 *
 * Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

// ── the real view code, lifted out of the panel ───────────────────────────────────────────────────────────
const START = '/* ================= ⭐ reviews:';
const END = '/* ================= offers:';
const a = HTML.indexOf(START), b = HTML.indexOf(END);
if (a < 0 || b < 0 || b < a) { console.log('CRASH: could not find the two views in admin.html'); process.exit(1); }
const SRC = HTML.slice(a, b);

// ── the smallest DOM these views actually use ─────────────────────────────────────────────────────────────
let EL, GET, POST, TOASTS, CONFIRM;
function makeEl(id) { return { id, innerHTML: '', value: '', onclick: null, oninput: null, onchange: null, disabled: false, focus() {} }; }
const reset = () => {
  EL = { '#view': makeEl('view') };
  GET = []; POST = []; TOASTS = []; CONFIRM = true;
};
const $ = (sel) => {
  // The views create #rvbody / #trbody by writing innerHTML, so hand back an element the first time each is asked for.
  if (!EL[sel] && /^#(rvbody|trbody|rvtext|trj|trsave|trreload|trjadd)$/.test(sel)) EL[sel] = makeEl(sel.slice(1));
  return EL[sel] || null;
};
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const toast = (t) => TOASTS.push(t);
let API_REPLY = {}, POST_REPLY = { ok: true };
const api = (p, params) => { GET.push({ path: p, params }); return Promise.resolve(API_REPLY); };
const post = (p, body) => { POST.push({ path: p, body }); return Promise.resolve(typeof POST_REPLY === 'function' ? POST_REPLY(p, body) : POST_REPLY); };
const confirm = () => CONFIRM;

const views = new Function('$', 'esc', 'toast', 'api', 'post', 'confirm',
  SRC + '\nreturn { reviewsView, rvLoad, rvRender, trustView, trLoad, trRender, RV: RV, TR: TR };')($, esc, toast, api, post, confirm);

/** Click a button the view drew: finds it by its data-attribute in the rendered HTML. */
const click = (elSel, dataset) => {
  const handler = EL[elSel] && EL[elSel].onclick;
  if (!handler) throw new Error('no onclick on ' + elSel);
  const button = { dataset, disabled: false, id: dataset.id || '' };
  handler({ target: { closest: () => button } });
  return button;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const REVIEWS = [
  { id: 7, name: 'Harsh W.', rating: 5, service: 'Netflix', text: 'Login came in a minute.', status: 'visible', at: '2026-10-01', phone: '9000000001', reply: 'Thank you!', repliedAt: '2026-10-01' },
  { id: 8, name: 'Keshav', rating: 5, service: '', text: 'Cheap and quick.', status: 'pending', at: '2026-10-02', phone: '9000000002', reply: '', repliedAt: '' },
  { id: 9, name: 'Sudhi', rating: 2, service: 'Zee5', text: 'Took two days.', status: 'hidden', at: '2026-09-28', phone: '9000000003', reply: '', repliedAt: '' },
];
const READY = { ok: true, ready: true, reviews: REVIEWS, counts: { visible: 1, pending: 1, hidden: 1 }, average: 4, visibleCount: 1 };

(async () => {
  // ══ ⭐ Reviews ════════════════════════════════════════════════════════════════════════════════════════════
  section('⭐ Reviews: what the owner sees');
  reset(); API_REPLY = READY;
  views.reviewsView(); await tick();
  ok('it asks for every review, not just the shown ones', GET[0].path === '/admin/api/reviews' && GET[0].params.status === 'all', GET[0]);
  let h = EL['#rvbody'].innerHTML;
  ok('the average and how many are on the site', /<b style="font-size:1.5rem">4<\/b>/.test(h) && /average of 1 shown on the site/.test(h), h.slice(0, 200));
  ok('all three reviews are listed', /Harsh W\./.test(h) && /Keshav/.test(h) && /Sudhi/.test(h));
  ok('🔒 the owner DOES see the phone — it is their own panel', /9000000001/.test(h));
  ok('a held review is labelled plainly, not left looking broken', /Waiting for you/.test(h));
  ok('…and the owner is told WHY things get held, so a queue is not alarming', /look like selling to the filter/.test(h), h.slice(h.indexOf('qnote'), h.indexOf('qnote') + 160));
  ok('the existing reply is shown under the review it answers', /rv-reply[\s\S]{0,120}Thank you!/.test(h));
  const sudhi = h.slice(h.indexOf('Sudhi'), h.indexOf('Sudhi') + 700);
  ok('a 2-star review is shown like any other, with two stars filled and the same buttons',
    /Took two days/.test(sudhi) && /★★<span class="muted">★★★/.test(sudhi) && /data-reply="9"/.test(sudhi) && /data-del="9"/.test(sudhi), sudhi.slice(0, 220));

  section('the filter tabs');
  click('#rvbody', { f: 'pending' });
  h = EL['#rvbody'].innerHTML;
  ok('only the held one is listed', /Keshav/.test(h) && !/Harsh W\./.test(h) && !/Sudhi/.test(h));
  click('#rvbody', { f: 'all' });
  ok('and back to all', /Harsh W\./.test(EL['#rvbody'].innerHTML));

  section('approve, hide, delete');
  reset(); API_REPLY = READY; POST = [];
  views.reviewsView(); await tick();
  click('#rvbody', { show: '8' }); await tick();
  ok('✅ Show on site publishes the held one', POST[0].path === '/admin/api/reviews/status' && POST[0].body.id === 8 && POST[0].body.status === 'visible', POST[0]);
  ok('…and says so', TOASTS.some((t) => /Shown on the site/.test(t)), TOASTS);
  POST = [];
  click('#rvbody', { hide: '7' }); await tick();
  ok('🚫 Hide takes one off the site', POST[0].path === '/admin/api/reviews/status' && POST[0].body.status === 'hidden', POST[0]);
  POST = []; CONFIRM = false;
  click('#rvbody', { del: '7' }); await tick();
  ok('🔒 Delete ASKS first, and sends nothing when the answer is no', POST.length === 0, POST);
  CONFIRM = true;
  click('#rvbody', { del: '7' }); await tick();
  ok('…and deletes when the answer is yes', POST[0].path === '/admin/api/reviews/delete' && POST[0].body.id === 7, POST[0]);

  section('💬 the reply — the thing this screen exists for');
  reset(); API_REPLY = READY; POST = [];
  views.reviewsView(); await tick();
  click('#rvbody', { reply: '9' });
  h = EL['#rvbody'].innerHTML;
  ok('the box opens on the right review, addressed to that person', /rvtext/.test(h) && /Write back to Sudhi/.test(h), h.slice(h.indexOf('rvtext') - 80, h.indexOf('rvtext') + 120));
  EL['#rvtext'].value = 'Sorry about that — we were out of stock. Fixed now.';
  click('#rvbody', { save: '9' }); await tick();
  ok('saving sends the reply against that review', POST[0].path === '/admin/api/reviews/reply' && POST[0].body.id === 9 && /out of stock/.test(POST[0].body.reply), POST[0]);
  ok('…and it reloads, so the owner sees it land', GET.length > 1);

  reset(); API_REPLY = READY; POST = [];
  views.reviewsView(); await tick();
  click('#rvbody', { reply: '7' });
  ok('a review that already has a reply opens with it IN THE BOX, to be edited rather than retyped',
    /<textarea class="inp" id="rvtext"[^>]*>Thank you!<\/textarea>/.test(EL['#rvbody'].innerHTML),
    EL['#rvbody'].innerHTML.slice(EL['#rvbody'].innerHTML.indexOf('rvtext') - 30, EL['#rvbody'].innerHTML.indexOf('rvtext') + 200));
  click('#rvbody', { rmreply: '7' }); await tick();
  ok('removing a reply sends an empty one, which is how the server deletes it', POST[0].body.reply === '' && POST[0].body.id === 7, POST[0]);
  reset(); API_REPLY = READY;
  views.reviewsView(); await tick();
  click('#rvbody', { reply: '9' });
  click('#rvbody', { cancel: '1' });
  ok('Cancel closes the box and writes nothing', !/rvtext/.test(EL['#rvbody'].innerHTML));

  section('before the table exists');
  reset(); API_REPLY = { ok: true, ready: false, schemaFile: 'db/schema-v34.sql', message: 'Run db/schema-v34.sql…', reviews: [] };
  views.reviewsView(); await tick();
  h = EL['#rvbody'].innerHTML;
  ok('🔒 the screen says exactly WHICH file to run, instead of looking broken', /db\/schema-v34\.sql/.test(h) && /phpMyAdmin/.test(h), h.slice(0, 220));
  ok('…and says nothing else breaks meanwhile', /the site simply shows no reviews/.test(h));

  section('no reviews yet');
  reset(); API_REPLY = { ok: true, ready: true, reviews: [], counts: {}, average: 0, visibleCount: 0 };
  views.reviewsView(); await tick();
  h = EL['#rvbody'].innerHTML;
  ok('it explains where reviews come from rather than showing an empty box', /No reviews yet/.test(h) && /from their dashboard/.test(h));
  ok('…and warns that Home shows nothing until the first one', /no review section at all/.test(h));

  // ══ 🏆 Why trust us ══════════════════════════════════════════════════════════════════════════════════════
  const TRUST = {
    ok: true,
    settings: { enabled: true, baselineOrders: null, baselineCustomers: null, lifetimeOrders: '5,000+', since: '2024', note: '', showTicker: true, showServices: true, showJourney: false, journey: [] },
    proved: { paidOrders: 956, customers: 275, running: 186 },
    live: { running: 186, comeBackPct: 61, renewals: 349, recurring: 169, services: [{ service: 'Netflix', n: 49 }] },
    totals: { orders: 5000, customers: 275, recurring: 169, renewals: 349, recurringPct: 61,
      counted: { orders: 956, customers: 275, recurring: 169, renewals: 349 },
      before: { orders: 4044, customers: 0, recurring: 0, renewals: 0 }, carriedOver: true },
    suggest: { basis: { ordersPerCustomer: 3.48, comeBackShare: 61, renewalShare: 37 },
      baselineOrders: 4044, baselineCustomers: 1163, baselineRecurring: 715, baselineRenewals: 1476,
      note: 'ESTIMATES from today\u2019s pattern' },
  };
  section('🏆 Why trust us: the claim and the proof, side by side');
  reset(); API_REPLY = TRUST;
  views.trustView(); await tick();
  h = EL['#trbody'].innerHTML;
  ok('the total is shown with its arithmetic, so there is nothing to guess at', /5,000[\s\S]{0,120}4,044 before \+ 956 counted/.test(h), h.slice(h.indexOf('trsum'), h.indexOf('trsum') + 320));
  ok('customers served and recurring are shown too', /275[\s\S]{0,80}customers served/.test(h) && /169[\s\S]{0,80}came back for more/.test(h));
  ok('every running total has a box for its old days', /data-k="baselineOrders"/.test(h) && /data-k="baselineCustomers"/.test(h)
    && /data-k="baselineRecurring"/.test(h) && /data-k="baselineRenewals"/.test(h) && !/data-k="lifetimeOrders"/.test(h));
  ok('🔒 and the screen SAYS why "plans running now" has none', /not a running total/.test(h) && /would simply be untrue/.test(h),
    h.slice(h.indexOf('Also counted live'), h.indexOf('Also counted live') + 320));
  ok('🔒 and it says which half is counted, and that it rises by itself', /counts <b>956 paid orders<\/b>/.test(h) && /rises on its own/.test(h));
  ok('🔒 a carried-over old claim is called out so the owner checks it rather than inheriting it silently',
    /carried over as <b>4,044 before the database<\/b>/.test(h) && /Please check it/.test(h), h.slice(h.indexOf('carried over') - 60, h.indexOf('carried over') + 200));
  ok('…and a nudge to keep it defensible', /could defend if a customer asked/.test(h));
  ok('the live numbers are shown as read-only facts', /186[\s\S]{0,80}plans running now/.test(h) && /61%[\s\S]{0,80}customers come back/.test(h));
  ok('all four switches are there', /data-b="enabled"/.test(h) && /data-b="showTicker"/.test(h) && /data-b="showServices"/.test(h) && /data-b="showJourney"/.test(h));
  ok('the ticker switch says plainly that it names nobody', /No names, no numbers/.test(h));

  section('the suggestion for the old days');
  ok('it is offered with its reasoning, and called an estimate',
    /3\.48 orders per customer/.test(h) && /about <b>1,163 customers<\/b>/.test(h) && /ESTIMATES from today/.test(h),
    h.slice(h.indexOf('Not sure what'), h.indexOf('Not sure what') + 360));
  ok('🔒 nothing is filled in until the owner asks', TRUST.settings.baselineCustomers === null);
  click('#trbody', { id: 'trsug' });
  ok('one tap fills all four boxes', views.TR.s.baselineOrders === 4044 && views.TR.s.baselineCustomers === 1163
    && views.TR.s.baselineRecurring === 715 && views.TR.s.baselineRenewals === 1476, views.TR.s);
  ok('🔒 …and it is still NOT saved — the owner has to look at them and press Save',
    POST.filter((x) => x.path === '/admin/api/trust').length === 0, POST);
  ok('…and they are told to check first', TOASTS.some((x) => /check them/i.test(x)), TOASTS);

  section('the journey editor');
  ok('⏸️ it starts empty, and says why that is deliberate', /No steps yet/.test(h) && /made-up timeline/.test(h), h.slice(h.indexOf('How we got here'), h.indexOf('How we got here') + 260));
  click('#trbody', { id: 'trjadd' });
  h = EL['#trbody'].innerHTML;
  ok('adding a step draws a row', /data-j="when"/.test(h) && /data-j="title"/.test(h) && /data-j="text"/.test(h));
  EL['#trbody'].oninput({ target: { dataset: { j: 'when', i: '0' }, value: '2024' } });
  EL['#trbody'].oninput({ target: { dataset: { j: 'title', i: '0' }, value: 'Where it started' } });
  ok('typing into it is kept', views.TR.s.journey[0].when === '2024' && views.TR.s.journey[0].title === 'Where it started', views.TR.s.journey);
  click('#trbody', { jdel: '0' });
  ok('and a step can be removed', views.TR.s.journey.length === 0);

  section('saving');
  reset(); API_REPLY = TRUST; POST = [];
  views.trustView(); await tick();
  EL['#trbody'].oninput({ target: { dataset: { k: 'baselineOrders' }, value: '4200' } });
  EL['#trbody'].onchange({ target: { dataset: { b: 'showTicker' }, checked: false } });
  POST_REPLY = { ok: true, settings: Object.assign({}, TRUST.settings, { baselineOrders: 4200, showTicker: false }) };
  click('#trbody', { id: 'trsave' }); await tick();
  ok('what the owner typed is what is sent', POST[0].path === '/admin/api/trust' && POST[0].body.baselineOrders === '4200' && POST[0].body.showTicker === false, POST[0]);
  ok('…and they are told it is not instant', TOASTS.some((t) => /live within 5 minutes/.test(t)), TOASTS);

  reset(); API_REPLY = TRUST; POST = []; TOASTS = [];
  views.trustView(); await tick();
  POST_REPLY = { ok: false, message: 'The year should be four digits, like 2024.' };
  click('#trbody', { id: 'trsave' }); await tick();
  ok('🔒 a refusal is shown to the owner in words, not swallowed', TOASTS.some((t) => /four digits/.test(t)), TOASTS);

  // ══ the panel itself ═════════════════════════════════════════════════════════════════════════════════════
  section('wired into the panel');
  ok('⭐ Reviews and 🏆 Why trust us are in the menu',
    HTML.indexOf("['reviews', '⭐', 'Reviews']") > 0 && HTML.indexOf("['trust', '🏆', 'Why trust us']") > 0);
  ok('…and both routes resolve', /reviews: reviewsView/.test(HTML) && /trust: trustView/.test(HTML));
  ok('🔒 the reply styling is inside the real stylesheet, not in a JS string',
    /\.rv-reply\{/.test(HTML.slice(0, HTML.indexOf('</style></head>'))));
  let parsed = true, n = 0;
  for (const m of HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1].trim()) continue;
    n++;
    try { new Function(m[1]); } catch (e) { parsed = false; console.log('   parse error: ' + e.message); }
  }
  ok('🔒 every inline <script> in admin.html still parses (node --check cannot see these)', parsed && n > 0, { blocks: n });
  ok('package.json runs this test', /node test\/admin-reviews-trust\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  section('the views only talk to endpoints that exist');
  const reviewsJs = fs.readFileSync(path.join(ROOT, 'reviews.js'), 'utf8');
  const trustJs = fs.readFileSync(path.join(ROOT, 'trust.js'), 'utf8');
  for (const p of ['/admin/api/reviews', '/admin/api/reviews/reply', '/admin/api/reviews/status', '/admin/api/reviews/delete']) {
    ok('reviews.js serves ' + p, reviewsJs.indexOf("'" + p + "'") > 0);
  }
  ok('trust.js serves /admin/api/trust (GET and POST)', (trustJs.match(/'\/admin\/api\/trust'/g) || []).length === 2);

  console.log('\n---------------------------------------');
  console.log('admin-reviews-trust: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
