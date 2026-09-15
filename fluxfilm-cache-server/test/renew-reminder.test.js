/* ⏳ Renewal reminder pop-up: which plans get a reminder (India calendar days, refunded / renewed / snoozed skipped),
   varied wording, offer from the account (catalog price, early discount, RENEW coupon, coins), admin switch + days,
   Back / once-per-visit wiring. The pure helpers are run straight from index.html. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const admin = read('admin.html');

// ---------------- pure helpers from index.html ----------------
const a = html.indexOf('// RR_PURE_START'), b = html.indexOf('// RR_PURE_END');
const pureSrc = html.slice(a, b);
const R = new Function(pureSrc + '\nreturn { RENEW_REMIND_TEXT_, rrParseMs_, rrDaysLeft_, renewRemindPick_, renewRemindCompose_, rrCoupon_, rrStateRead_, rrStateWrite_, rrMark_, rrFirstName_, RR_SNOOZE_MS_ };')();

const H = 3600000, DAY = 86400000;
// "Now" = 15 Sep 2026, 10:00 India time.
const NOW = Date.UTC(2026, 8, 15, 4, 30);
// A plan ending `off` India calendar days from 15 Sep, at 21:00 India time (server sends ISO with Z).
const expIso = (off, hIst) => new Date(Date.UTC(2026, 8, 15 + off, (hIst == null ? 21 : hIst), 0) - 5.5 * H).toISOString();
const elig = (d) => (d >= 0 ? 'CAN_RENEW' : d >= -5 ? 'LATE_RENEW' : 'TOO_LATE');
let n = 0;
const sub = (off, extra) => Object.assign({
  subId: 'SUB' + (++n), orderId: 'FF' + n, service: 'Netflix', plan: 'Sharing 1M', expiryDate: expIso(off), startDate: expIso(off - 30),
  daysLeft: off, renewEligibility: elig(off), showRenewButton: elig(off) !== 'TOO_LATE', earlyRenewDiscountEligible: 0,
  status: 'ACTIVE', fulfillmentStatus: 'FULFILLED',
}, extra || {});
const pick = (subs, o) => R.renewRemindPick_(Object.assign({ subs, orders: [], nowMs: NOW, before: 7, after: 3, state: {} }, o || {}));
const plans = [
  { service: 'Netflix', plan: 'Sharing 1M', price: 149 },
  { service: 'Netflix', plan: 'Private 2 Devices 1M', price: 399 },
  { service: 'Prime Video', plan: '1 Month', price: 49 },
];

(async () => {
  section('dates: India calendar days, Safari-safe parsing');
  ok('MySQL text "YYYY-MM-DD HH:MM:SS" = India time (no new Date(string) needed)', R.rrParseMs_('2026-09-20 10:00:00') === Date.UTC(2026, 8, 20, 4, 30));
  ok('ISO with Z and with +05:30 give the same moment', R.rrParseMs_('2026-09-20T04:30:00.000Z') === R.rrParseMs_('2026-09-20T10:00:00+05:30'));
  ok('date only, invalid date, junk → sensible', R.rrParseMs_('2026-09-20') === Date.UTC(2026, 8, 19, 18, 30) && R.rrParseMs_('2026-02-30 10:00:00') === null && R.rrParseMs_('soon') === null && R.rrParseMs_('') === null);
  ok('today = 0 even when the plan ended this morning (time of day ignored)', R.rrDaysLeft_(expIso(0, 1), NOW) === 0 && R.rrDaysLeft_(expIso(0, 23), NOW) === 0);
  const lateNight = Date.UTC(2026, 8, 15, 18, 0); // 23:30 India on 15 Sep
  ok('23:30 India, plan ends 00:30 next day → "tomorrow" (1), not 0', R.rrDaysLeft_('2026-09-16 00:30:00', lateNight) === 1 && R.rrDaysLeft_('2026-09-15T19:00:00.000Z', lateNight) === 1);
  ok('00:10 India: yesterday\'s 23:50 expiry = -1', R.rrDaysLeft_('2026-09-15 23:50:00', Date.UTC(2026, 8, 15, 18, 40)) === -1);
  ok('no `new Date(<text>)` parsing inside the pure block', !/new Date\((?!ms|day|Date\.UTC)[^)]/.test(pureSrc), (pureSrc.match(/new Date\([^)]*\)/g) || []));

  section('who gets a reminder');
  ok('day 8 → no', pick([sub(8)]).length === 0);
  ok('day 7 → yes (week)', pick([sub(7)]).length === 1 && pick([sub(7)])[0].bucket === 'week');
  ok('day 3 / 2 → soon, 1 → tomorrow, 0 → today', pick([sub(3)])[0].bucket === 'soon' && pick([sub(2)])[0].bucket === 'soon' && pick([sub(1)])[0].bucket === 'tomorrow' && pick([sub(0)])[0].bucket === 'today');
  ok('ended 1..3 days ago → yes (ended)', [-1, -2, -3].every((d) => { const p = pick([sub(d)]); return p.length === 1 && p[0].bucket === 'ended' && p[0].days === d; }));
  ok('ended 4 days ago → no', pick([sub(-4)]).length === 0);
  ok('renew not allowed any more (TOO_LATE / no Renew button) → no', pick([sub(-2, { renewEligibility: 'TOO_LATE', showRenewButton: false })]).length === 0 && pick([sub(2, { showRenewButton: false })]).length === 0);
  ok('refunded plan (admin refund: CANCELLED + REFUNDED) → no', pick([sub(2, { status: 'CANCELLED', fulfillmentStatus: 'REFUNDED' })]).length === 0);
  ok('removed / erased status → no', pick([sub(2, { status: 'REMOVED' })]).length === 0 && pick([sub(2, { status: 'erased' })]).length === 0);
  const rs = sub(2);
  ok('its order refunded (Orders list) → no', pick([rs], { orders: [{ orderId: rs.orderId, status: 'REFUNDED', service: 'Netflix' }] }).length === 0);
  const old = sub(-1);
  const renewedNew = sub(29, { startDate: expIso(-2) });
  ok('already renewed (newer Netflix plan bought around the end) → no', pick([old, renewedNew]).length === 0);
  ok('…but an older parallel plan of the same service does not count as a renewal', pick([sub(-1), sub(40, { startDate: expIso(-60) })]).length === 1);
  ok('…and a newer plan of ANOTHER service does not hide it', pick([sub(-1), sub(29, { service: 'Prime Video', startDate: expIso(-2) })]).length === 1);
  ok('a refunded newer plan does not count as renewed', pick([sub(-1), sub(29, { startDate: expIso(-2), status: 'CANCELLED', fulfillmentStatus: 'REFUNDED' })]).length === 1);
  const paidOrder = { orderId: 'FFR1', service: 'Netflix', status: 'PAID', fulfillmentStatus: 'PENDING', createdAt: new Date(NOW - 2 * H).toISOString() };
  ok('renewal paid and still being delivered → no', pick([sub(1)], { orders: [paidOrder] }).length === 0);
  ok('unpaid order, delivered order, or a paid order from last week → still reminded', pick([sub(1)], { orders: [Object.assign({}, paidOrder, { status: 'CREATED' })] }).length === 1 && pick([sub(1)], { orders: [Object.assign({}, paidOrder, { fulfillmentStatus: 'FULFILLED' })] }).length === 1 && pick([sub(1)], { orders: [Object.assign({}, paidOrder, { createdAt: new Date(NOW - 8 * DAY).toISOString() })] }).length === 1);
  const sz = sub(2);
  ok('snoozed ("Remind me later" = 24 h) → no, after 24 h → yes', pick([sz], { state: { [sz.subId]: { snooze: NOW + 5 * H } } }).length === 0 && pick([sz], { state: { [sz.subId]: { snooze: NOW - 1 } } }).length === 1 && R.RR_SNOOZE_MS_ === 24 * H);
  ok('seen 11 h ago → no; 13 h ago → yes (once per ~12 h per plan)', pick([sz], { state: { [sz.subId]: { seen: NOW - 11 * H } } }).length === 0 && pick([sz], { state: { [sz.subId]: { seen: NOW - 13 * H } } }).length === 1);
  ok('admin days: before 3 hides day 4; after 0 hides yesterday; after is capped at 5', pick([sub(4)], { before: 3 }).length === 0 && pick([sub(3)], { before: 3 }).length === 1 && pick([sub(-1)], { after: 0 }).length === 0 && pick([sub(-5)], { after: 9 }).length === 1 && pick([sub(-6)], { after: 9 }).length === 0);
  ok('no expiry / broken expiry → no', pick([sub(2, { expiryDate: '' })]).length === 0 && pick([sub(2, { expiryDate: 'n/a' })]).length === 0);
  const m1 = sub(6), m2 = sub(-2, { service: 'Prime Video', plan: '1 Month' }), m3 = sub(1, { service: 'JioHotstar', plan: 'Super 1M' });
  const mp = pick([m1, m2, m3, m1]);
  ok('several plans → one list, most urgent first, duplicates dropped', mp.length === 3 && mp.map((x) => x.days).join() === '-2,1,6', mp.map((x) => x.days));

  section('what it says');
  const c1 = (days, extra, o) => R.renewRemindCompose_(Object.assign({ items: pick([sub(days, extra)]), name: 'asha verma', plans, coupons: [], nowMs: NOW, before: 7 }, o || {}));
  const w = c1(5);
  ok('uses first name, service, plan and days', /Asha|friend|Hi there/.test(w.title + w.body) && /Netflix/.test(w.title + w.body) && /Sharing 1M|5 days/.test(w.title + w.body) && /Asha/.test(w.title + w.body), w);
  ok('no placeholder left, single sentence case', !/[{}]/.test(w.title + w.body));
  const titlesOverDays = new Set([0, 1, 2].map((k) => c1(5, { subId: 'SUBROT' }, { nowMs: NOW + k * DAY }).title));
  // days left changes as the days pass, so rotate on a fixed-days check instead:
  const rot = new Set([0, 1, 2].map((k) => R.renewRemindCompose_({ items: [{ sub: sub(5, { subId: 'SUBROT', expiryDate: expIso(5 + k) }), days: 5, bucket: 'week' }], name: 'Asha', plans, nowMs: NOW + k * DAY }).textKey));
  ok('wording rotates by day (3 different texts on 3 days)', rot.size === 3 && titlesOverDays.size >= 2, [...rot]);
  const keys = [7, 3, 1, 0, -1].map((d) => c1(d).textKey.split(':')[0]);
  ok('different sets for 7..4, 3..2, tomorrow, today, ended', keys.join() === 'week,soon,tomorrow,today,ended', keys);
  const allText = JSON.stringify(R.RENEW_REMIND_TEXT_);
  ok('every set has 3 templates; English + light Hinglish; nothing pushy', ['week', 'soon', 'tomorrow', 'today', 'ended', 'multi'].every((k) => R.RENEW_REMIND_TEXT_[k].length === 3) && /din|abhi|kal|aaj|karna/i.test(allText) && !/hurry|last chance|lose everything|must|immediately|!!/i.test(allText));
  const t0 = c1(0);
  ok('today: ring says "Today", urgent tone', t0.ring.num === 'Today' && t0.ring.word && t0.tone === 't-urgent' && t0.ring.label === 'Ends today');
  const t1 = c1(1);
  ok('tomorrow chip + "3 days left" ring', t1.ring.label === 'Ends tomorrow' && c1(3).ring.num === '3' && c1(3).ring.unit === 'days left' && c1(3).tone === 't-soon');
  const e2 = c1(-2, { profileName: 'Asha' });
  ok('ended: "ended 2 days ago" + keep the same account and profile; no "no days lost"', /2 days ago/.test(e2.title + e2.body) && e2.perks.some((p) => /keep the same account and profile/.test(p)) && !e2.perks.some((p) => /no days lost/.test(p)) && e2.tone === 't-ended', e2);
  ok('ended yesterday says "yesterday"', /yesterday/.test(JSON.stringify(c1(-1))));
  ok('before expiry: "no days lost" (renewal.js: on time → old expiry + plan)', c1(4).perks.some((p) => /no days lost/.test(p)) && /T\.getTime\(\) <= E\.getTime\(\)[\s\S]{0,80}addDays\(E, D\)/.test(read('renewal.js')));
  const dv = c1(3, { deviceCount: 2 });
  ok('2-device plan → "on both devices"; 3 devices → "on all 3 devices"', /on both devices/.test(dv.body) && /on all 3 devices/.test(c1(3, { deviceCount: 3 }).body), dv.body);
  ok('plan name already says "2 Devices" → not repeated', !/on both devices/.test(JSON.stringify(c1(3, { plan: 'Private 2 Devices 1M' }))) && /2 Devices/.test(JSON.stringify(c1(3, { plan: 'Private 2 Devices 1M' }).rows[0].vars)));
  ok('no name → "Hi there" / "friend", never "Hi undefined"', [0, 1, 2].every((k) => { const x = c1(5, {}, { name: '', nowMs: NOW + k * 3600 * 1000 * 0 }); const t = x.title + x.body + x.perks.join(); return !/undefined|null/.test(t) && /Hi there|friend|Netflix/.test(t); }) && R.rrFirstName_('9876543210') === '' && R.rrFirstName_('Customer') === '' && R.rrFirstName_('RAHUL kumar') === 'Rahul');

  section('the offer from their account');
  ok('price = live catalog price for the SAME plan', c1(5).price.was === 149 && c1(5).price.now === 149 && c1(5, { plan: 'Private 2 Devices 1M' }).price.was === 399);
  ok('plan not in the catalog → no price shown (never made up)', c1(5, { plan: 'Old Plan' }).price === null);
  const ed = c1(5, { earlyRenewDiscountEligible: 20 });
  ok('early-renew discount shown and taken off', ed.price.now === 129 && ed.perks.some((p) => /Early-renew discount: ₹20 off/.test(p)));
  ok('no early discount after expiry', c1(-1, { earlyRenewDiscountEligible: 20 }).perks.every((p) => !/Early-renew/.test(p)) && c1(-1, { earlyRenewDiscountEligible: 20 }).price.now === 149);
  const coupons = [
    { code: 'NEW50', scope: 'NEW', type: 'FLAT', value: 50 },
    { code: 'RENEW10', scope: 'RENEW', type: 'PERCENT', value: 10, maxDiscount: 12 },
    { code: 'RENEWOLD', scope: 'RENEW', type: 'FLAT', value: 90, expiry: '2026-09-01T00:00:00.000Z' },
    { code: 'RENEWBIG', scope: 'RENEW', type: 'FLAT', value: 30, minAmount: 500 },
    { code: 'RENEW15', scope: 'RENEW', type: 'FLAT', value: 15, remaining: 0 },
  ];
  const cp = c1(5, { earlyRenewDiscountEligible: 20 }, { coupons });
  ok('best usable RENEW coupon (NEW-only, expired, min amount, used up skipped)', cp.coupon && cp.coupon.code === 'RENEW10' && cp.coupon.amount === 12 && cp.price.now === 117 && cp.perks.some((p) => /RENEW10 saves about ₹12/.test(p)), cp.coupon);
  const cn = c1(5, {}, { coins: { ok: true, enabled: true, coins: 30, rupees: 15, coinCoins: 30, coinRupees: 15, creditRupees: 0 } });
  ok('usable coins shown from the coin quote', cn.perks.some((p) => /30 coins \(₹15 off\)/.test(p)));
  ok('no coins / coins off → nothing about coins', c1(5, {}, { coins: { ok: true, enabled: false, coins: 0, rupees: 0 } }).perks.every((p) => !/coins/.test(p)) && c1(5, {}, { coins: { ok: true, enabled: true, coins: 0, rupees: 0, reason: 'min' } }).perks.every((p) => !/coins/.test(p)));
  ok('refund credit shown separately', c1(5, {}, { coins: { ok: true, enabled: true, coins: 60, rupees: 60, coinCoins: 0, coinRupees: 0, creditRupees: 60 } }).perks.some((p) => /₹60 refund credit/.test(p)));
  const mc = R.renewRemindCompose_({ items: mp, name: 'Asha', plans, coupons, nowMs: NOW, before: 7 });
  ok('multiple plans: one pop-up, list with each chip + price, count in the title, both perks', !mc.single && mc.rows.length === 3 && /3/.test(mc.title) && mc.rows[0].chip.label === 'Ended 2 days ago' && mc.rows[0].pay === 49 && mc.rows[1].chip.label === 'Ends tomorrow' && mc.perks.some((p) => /no days lost/.test(p)) && mc.perks.some((p) => /same account/.test(p)) && mc.price === null, mc.rows.map((r) => r.chip));

  section('memory (localStorage) never breaks the page');
  const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  ok('blocked storage: read = {}, write does not throw', JSON.stringify(R.rrStateRead_(boom)) === '{}' && (() => { try { R.rrStateWrite_(boom, { a: { seen: NOW } }, NOW); return true; } catch (e) { return false; } })());
  const mem = { v: null, getItem() { return this.v; }, setItem(k, v) { this.v = v; } };
  R.rrStateWrite_(mem, R.rrMark_({ OLD: { seen: NOW - 30 * DAY } }, ['S1', 'S2'], 'snooze', NOW + 24 * H), NOW);
  const back = R.rrStateRead_(mem);
  ok('snooze saved per plan; entries older than 10 days pruned', back.S1.snooze === NOW + 24 * H && back.S2 && !back.OLD);
  mem.v = '[1,2]';
  ok('garbage in storage ignored', JSON.stringify(R.rrStateRead_(mem)) === '{}');

  section('storefront wiring');
  const comp = html.slice(html.indexOf('function RenewReminder({'), html.indexOf('function PromoPopup({'));
  ok('rendered at the app root with store settings, busy flags and nav; not on maintenance', /!storeBlocked && sessionPhone && React\.createElement\(RenewReminder, \{\s*screen: screen,\s*phone: sessionPhone,\s*manageResp: d\.manageResp,\s*orders: d\.orders,\s*coupons: couponCache\[normPhone_\(sessionPhone\)\] \|\| d\.coupons,\s*couponsReady: d\.couponsLoadedForPhone === normPhone_\(sessionPhone\),\s*profile: d\.profile,\s*boot: boot,\s*settings: storeStatus,\s*busy: !!\(loadingMsg \|\| restoring \|\| showRecoverModal \|\| showOtpModal \|\| accountModal\.open\),\s*nav: nav\s*\}\)/.test(html));
  const scr = html.match(/const RR_SCREENS_ = \{([^}]*)\}/);
  ok('only Home / My plans / Account / What\'s new / Buy — never checkout, pay, renew, verify, done, recover, OTP', scr && ['home', 'dashboard', 'account', 'feed', 'buy1'].every((k) => new RegExp('\\b' + k + ': 1').test(scr[1])) && !/pay|renew|verify|done|recover|otp|details|review|buy2|groupJoin/.test(scr[1]));
  ok('admin switch respected (off, paused, not loaded yet → nothing)', /const ready = !!settings && settings\.renewPopup !== false && !settings\.paused && !!phone && !busy && !!RR_SCREENS_\[screen\]/.test(comp) && /\(!!couponsReady \|\| waited\);/.test(comp));
  ok('at most once per app open (module flag + sessionStorage)', /rrShownThisOpen_ = true;\s*try \{\s*sessionStorage\.setItem\('ff_rr_shown', '1'\);/.test(comp) && /if \(!ready \|\| pop \|\| rrShownThisOpen_\) return;/.test(comp));
  ok('never over another open pop-up / sheet / chat', /if \(window\.ffPromoOpen \|\| window\.ffRefundOpen \|\| window\.ffPushOpen\) return true;/.test(html) && /querySelectorAll\('\[role="dialog"\], \[aria-modal="true"\]'\)/.test(html) && /if \(!live \|\| rrShownThisOpen_ \|\| !RR_SCREENS_\[screenRef\.current\] \|\| rrOtherDialogOpen_\(\)\) return;/.test(comp));
  ok('other pop-ups wait while it is open', /window\.ffRenewPopOpen = true;/.test(comp) && /if \(window\.ffRefundOpen \|\| window\.ffRenewPopOpen\) return;/.test(html) && /\(window\.ffPromoOpen \|\| window\.ffRenewPopOpen\) && !force/.test(html));
  ok('Back button closes it: history entry pushed, popstate closes, entry removed on ✕ (comments sheet pattern)', /history\.pushState\(Object\.assign\(\{\}, window\.history\.state \|\| \{\}, \{\s*ffRenewPop: 1\s*\}\), ''\)/.test(comp) && /const onPop = \(\) => \{\s*popped = true;\s*setPop\(null\);/.test(comp) && /if \(!popped\) try \{\s*if \(window\.history\.state && window\.history\.state\.ffRenewPop\) window\.history\.back\(\);/.test(comp));
  ok('closes with ✕, tap outside and Esc; "Remind me later" snoozes 24 h', /"aria-label": "Close",\s*onClick: close/.test(comp) && /if \(e\.target === e\.currentTarget\) close\(\);/.test(comp) && /if \(e\.key === 'Escape'\) setPop\(null\);/.test(comp) && /'snooze', now \+ RR_SNOOZE_MS_/.test(comp));
  ok('accessible: role dialog, aria-modal, labelled, focused on open', /role: "dialog",\s*"aria-modal": "true",\s*"aria-labelledby": "ff-rr-title"/.test(comp) && /dlgRef\.current\.focus\(\{\s*preventScroll: true/.test(comp) && /tabIndex: -1/.test(comp));
  ok('"Renew now" opens the normal renew flow for that plan with the coupon', /nav\('renewStart', \{\s*sub: row\.sub,\s*renewCoupon: p\.coupon \? p\.coupon\.code : ''\s*\}\)/.test(comp) && /renewCoupon: d\.renewCoupon/.test(html));
  const rsc = html.slice(html.indexOf('function RenewStartScreen({'), html.indexOf('function RenewStartScreen({') + 6000);
  ok('renew page applies that coupon once, quietly (server still checks it)', /applyCouponRef\.current\(true\)/.test(rsc) && /if \(quiet === true\) \{[\s\S]{0,400}msg: ''\s*\}\)\);\s*setCouponCode\(getPromoCoupon_\(\)\);\s*return;\s*\}/.test(rsc) && /applyCouponRef\.current = applyCoupon;/.test(html));
  ok('coins asked once, only when a reminder is due (kind RENEW), 2.5 s fallback', /API\.getCoinQuote\(phone, amount, 'RENEW'/.test(comp) && /setTimeout\(\(\) => show\(null\), 2500\)/.test(comp) && (html.match(/API\.getCoinQuote\(/g) || []).length === 3);
  ok('motion: small entrance, off for reduced motion, shorter on ff-lite; fixed overlay (no layout shift)', /\.ff-rr-bg \{ position: fixed; inset: 0;/.test(html) && /@media \(prefers-reduced-motion: reduce\) \{ \.ff-rr, \.ff-rr-bg, \.ff-rr-ring \.val \{ animation: none; \} \}/.test(html) && /html\.ff-lite \.ff-rr \{ animation-duration: \.18s; \}/.test(html));
  ok('narrow phones (≤340 px, e.g. 309 px): smaller ring + chips; title clear of ✕; 44 px tap targets', /@media \(max-width: 340px\) \{[^\n]*\.ff-rr-ring \{ width: 90px; height: 90px; \}[^\n]*\.ff-rr-chip \{ width: 50px; \}/.test(html) && /\.ff-rr\.multi \.ff-rr-title \{ margin: 0 34px; \}/.test(html) && /\.ff-rr-later \{[^}]*min-height: 44px/.test(html) && /\.ff-rr-x \{[^}]*width: 40px; height: 40px/.test(html));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).concat([...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]));
  let parsed = true;
  for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline <script> in index.html and admin.html parses', parsed && scripts.length > 4);

  section('server: subscription status for the storefront');
  const reads = read('reads.js');
  ok('getMySubscriptions returns status + fulfillmentStatus (same one query)', /inventory_ref, status, fulfillment_status/.test(reads) && /status: String\(r\.status \|\| ''\)\.trim\(\)\.toUpperCase\(\),\s*fulfillmentStatus: String\(r\.fulfillment_status \|\| ''\)\.trim\(\)\.toUpperCase\(\),/.test(reads));

  section('admin: 🚧 Maintenance → ⏳ Renewal reminder pop-up');
  const settings = {};
  const mockDb = {
    ENABLED: true,
    query: async (sql, p) => {
      sql = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
      if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
      throw new Error('unexpected SQL ' + sql);
    },
  };
  Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
  const store = require('../store');
  let st = await store.getStatus();
  ok('ON by default, 7 days before / 3 after, in the public status', st.renewPopup === true && st.renewPopupBefore === 7 && st.renewPopupAfter === 3);
  let r = await store.saveSettings({ renewPopup: false });
  st = await store.getStatus();
  ok('owner turns it off → public status false, pause untouched, change reported', r.ok && r.changed.join() === 'renewPopup' && st.renewPopup === false && st.paused === false);
  r = await store.saveSettings({ renewPopup: 'true', renewPopupBefore: '5', renewPopupAfter: 2 });
  st = await store.getStatus();
  ok('back on + days saved as numbers', r.ok && st.renewPopup === true && st.renewPopupBefore === 5 && st.renewPopupAfter === 2 && r.changed.includes('renewPopupBefore'));
  r = await store.saveSettings({ renewPopupBefore: 30, renewPopupAfter: 9 });
  ok('out of range refused (before 1–14, after 0–5), nothing changed', !r.ok && /1 to 14/.test(r.message) && /0 to 5/.test(r.message) && (await store.getStatus()).renewPopupBefore === 5);
  ok('bad values saved by hand are clamped to defaults', store.validateSettings({ renewPopupBefore: 99, renewPopupAfter: -2 }).settings.renewPopupBefore === 7 && store.validateSettings({ renewPopupAfter: -2 }).settings.renewPopupAfter === 3);
  ok('message save alone keeps the reminder settings', (await store.saveSettings({ message: 'Hi' })).settings.renewPopupBefore === 5);
  ok('no schema change (same app_settings "store" row)', Object.keys(settings).join() === 'store');
  const as = read('adminstore.js');
  ok('change log line for the switch / days', /action: 'store\.renewpopup'/.test(as) && /Renewal reminder pop-up turned ' \+ \(s\.renewPopup === false \? 'OFF' : 'ON'\)/.test(as) && /!\/\^renewPopup\/\.test\(k\)/.test(as));
  ok('admin page: checkbox saves at once + days inputs + save button', /id="mtrenew"' \+ \(s\.renewPopup !== false \? ' checked' : ''\)/.test(admin) && /post\('\/admin\/api\/store', \{ renewPopup: on \}\)/.test(admin) && /id="mtrrbefore" type="number"/.test(admin) && /id="mtrrafter" type="number"/.test(admin) && /\{ renewPopupBefore: \$\('#mtrrbefore'\)\.value, renewPopupAfter: \$\('#mtrrafter'\)\.value \}/.test(admin) && /⏳ Renewal reminder pop-up/.test(admin));

  console.log('\nrenew-reminder: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
