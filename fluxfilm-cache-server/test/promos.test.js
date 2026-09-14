/* Offers, banners and pop-ups (promos.js, adminpromos.js, storefront). Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const settings = {};
const coupons = [{ raw_json: JSON.stringify({ Code: 'ANNIV30', Active: 'TRUE', Expiry: '2026-10-01 00:00:00' }) }, { raw_json: JSON.stringify({ CouponCode: 'OLD10', Active: 'TRUE', Expiry: '2025-01-01 00:00:00' }) }];
let writes = 0;
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { writes++; settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(sql)) { delete settings[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT raw_json FROM coupons/.test(sql)) return coupons;
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const promos = require('../promos');

(async () => {
  // ---- validation ----
  let v = promos.validate({ type: 'popup', title: '', message: '' });
  ok('needs a title or a message', !v.ok && /title or a message/.test(v.errors.join()));
  v = promos.validate({ type: 'bar', title: 'Sale <script>', ctaAction: 'link', ctaLink: 'javascript:alert(1)' });
  ok('links must be https; < > stripped', !v.ok && /https/.test(v.errors.join()) && v.promo.title === 'Sale script');
  v = promos.validate({ title: 'x', startAt: '2026-09-30T10:00', endAt: '2026-09-29T10:00' });
  ok('end must be after start', !v.ok && /after the start/.test(v.errors.join()));
  ok('admin datetime is India time', promos.toIso('2026-09-30T23:59') === '2026-09-30T18:29:00.000Z');
  v = promos.validate({ title: 'x', couponCode: ' anniv 30! ', type: 'card', theme: 'nope', audience: 'robots', priority: 500 });
  ok('safe defaults: code cleaned, bad theme/audience ignored, priority capped, card gets pages', v.ok && v.promo.couponCode === 'ANNIV30' && v.promo.theme === 'festive' && v.promo.audience === 'all' && v.promo.priority === 99 && v.promo.pages.join() === 'home,dashboard');

  // ---- save / schedule / public list ----
  const now = Date.now(); const iso = (min) => new Date(now + min * 60000).toISOString();
  let r = await promos.save({ name: 'Anniversary', type: 'popup', theme: 'festive', emoji: '🎉', title: 'Anniversary Sale', message: 'Till 30 Sep', couponCode: 'ANNIV30', ctaAction: 'buy', ctaText: 'Grab it', startAt: iso(-60), endAt: iso(60 * 24 * 10), active: true, frequency: 'day', countdown: true, priority: 10 });
  ok('create offer', r.ok && r.created && /^pr[0-9a-f]{10}$/.test(r.promo.id));
  const live = r.promo;
  await promos.save({ name: 'Bar', type: 'bar', title: 'Free delivery of logins', startAt: iso(-10), endAt: iso(60), active: true, pages: ['home', 'buy'], priority: 1 });
  await promos.save({ name: 'Later', type: 'card', title: 'Diwali', startAt: iso(60 * 24), endAt: iso(60 * 48), active: true });
  await promos.save({ name: 'Ended', type: 'card', title: 'Old', startAt: iso(-600), endAt: iso(-60), active: true });
  await promos.save({ name: 'Off', type: 'bar', title: 'Draft', active: false });
  const all = await promos.list();
  ok('statuses: live / scheduled / ended / off', ['LIVE', 'LIVE', 'SCHEDULED', 'ENDED', 'OFF'].join() === ['Anniversary', 'Bar', 'Later', 'Ended', 'Off'].map((n) => promos.statusOf(all.find((p) => p.name === n))).join());
  promos._internal.reset();
  let pub = await promos.publicList();
  ok('customers only get live offers, highest priority first', pub.promos.map((p) => p.title).join('|') === 'Anniversary Sale|Free delivery of logins');
  ok('admin-only fields not sent (name, active, start)', pub.promos.every((p) => !('name' in p) && !('active' in p) && !('startAt' in p)));
  r = await promos.save(Object.assign({}, live, { active: false }));
  promos._internal.reset(); pub = await promos.publicList();
  ok('turning an offer off hides it', !pub.promos.some((p) => p.id === live.id));
  await promos.save(Object.assign({}, live, { active: true }));
  ok('scheduled offer goes live at its start time by itself', (await promos.publicList(new Date(now + 60 * 24 * 60000 + 60000))).promos.some((p) => p.title === 'Diwali'));
  ok('…and ends by itself', !(await promos.publicList(new Date(now + 60 * 24 * 11 * 60000))).promos.some((p) => p.title === 'Anniversary Sale'));
  ok('unknown id cannot be "updated" into a new offer', !(await promos.save({ id: 'prdeadbeef00', title: 'x' })).ok);

  // ---- picture ----
  ok('picture must be an image', !(await promos.setImage(live.id, 'data:text/html;base64,PGI+')).ok);
  r = await promos.setImage(live.id, 'data:image/png;base64,iVBORw0KGgo=');
  const img = await promos.image(live.id);
  promos._internal.reset(); pub = await promos.publicList();
  ok('picture stored, served as binary, public URL busts cache', r.ok && img.type === 'image/png' && img.buf.length === 8 && /^\/promo-img\/pr[0-9a-f]+\?v=/.test(pub.promos.find((p) => p.id === live.id).image));
  ok('image id is sanitised', (await promos.image('../x')) === null);

  // ---- stats ----
  writes = 0;
  for (let i = 0; i < 25; i++) promos.record(live.id, 'view');
  promos.record(live.id, 'click'); promos.record(live.id, 'click'); promos.record('bad id!', 'view'); promos.record(live.id, 'hack');
  ok('views / clicks buffered, no database write per view', writes === 0 && (await promos.stats())[live.id].views === 25);
  await promos.flushStats();
  ok('flushed once a minute in one write', writes === 1 && JSON.parse(settings.promo_stats)[live.id].clicks === 2 && JSON.parse(settings.promo_stats)[live.id].views === 25);

  // ---- coupon check ----
  ok('coupon check: active / expired / missing', (await promos.couponCheck('anniv30')).active === true && (await promos.couponCheck('OLD10')).expired === true && (await promos.couponCheck('NOPE')).exists === false);

  // ---- admin API ----
  const routes = {}; const audits = []; let authed = false;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  require('../adminpromos').mount(app, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (q, a) => audits.push(a) }, promos });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; routes[m + ' ' + p]({ body }, res); });
  let x = await call('POST', '/admin/api/promos/save', { title: 'x' });
  ok('admin sign-in required', x.code === 403);
  authed = true;
  x = await call('GET', '/admin/api/promos');
  const a = x.body.promos.find((p) => p.id === live.id);
  ok('admin list: status, views, clicks, coupon check', x.body.ok && a.status === 'LIVE' && a.views === 25 && a.clicks === 2 && a.coupon.active === true);
  x = await call('POST', '/admin/api/promos/save', { name: 'Flash', type: 'bar', title: 'Flash sale', active: true });
  ok('create via admin + change log', x.body.ok && audits.some((l) => l.action === 'promo.create' && /Flash/.test(l.summary)));
  x = await call('POST', '/admin/api/promos/delete', { id: x.body.promo.id });
  ok('delete via admin + change log', x.body.ok && audits.some((l) => l.action === 'promo.delete'));

  // ---- storefront ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('const PROMO_PAGE_ = {'); const end = html.indexOf('function PromoCountdown(');
  const store = {}; const sess = {};
  const lsFake = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); } };
  const ssFake = { getItem: (k) => sess[k] || null, setItem: (k, v) => { sess[k] = String(v); } };
  const helpers = new Function('localStorage', 'sessionStorage', 'API', html.slice(start, end) + '; return { promoFits_, promoPopupDue_, promoMarkSeen_, savePromoCoupon_, getPromoCoupon_, promoLeft_ };')(lsFake, ssFake, { promoEvent: () => {} });
  const P = (o) => Object.assign({ id: 'p1', type: 'bar', pages: ['home', 'buy'], audience: 'all', endAt: iso(600), frequency: 'visit' }, o);
  ok('bar shows only on chosen pages (Buy covers both plan screens)', helpers.promoFits_(P(), 'home', false) && helpers.promoFits_(P(), 'buy2', false) && !helpers.promoFits_(P(), 'dashboard', false));
  ok('audience: guests / customers', !helpers.promoFits_(P({ audience: 'guests' }), 'home', true) && helpers.promoFits_(P({ audience: 'customers' }), 'home', true) && !helpers.promoFits_(P({ audience: 'customers' }), 'home', false));
  ok('pop-up only on home / my plans / buy, never mid-checkout; ended offers never show', helpers.promoFits_(P({ type: 'popup' }), 'dashboard', true) && !helpers.promoFits_(P({ type: 'popup' }), 'details', true) && !helpers.promoFits_(P({ endAt: iso(-1) }), 'home', false));
  const pv = P({ type: 'popup', id: 'pv', frequency: 'visit' }), pd = P({ type: 'popup', id: 'pd', frequency: 'day' }), po = P({ type: 'popup', id: 'po', frequency: 'once' });
  [pv, pd, po].forEach((p) => helpers.promoMarkSeen_(p));
  ok('pop-up frequency: every visit (session) / once a day / only once', !helpers.promoPopupDue_(pv) && !helpers.promoPopupDue_(pd) && !helpers.promoPopupDue_(po) && (() => { store.ff_promo_seen_pd = String(Date.now() - 21 * 3600000); return helpers.promoPopupDue_(pd); })());
  helpers.savePromoCoupon_({ couponCode: 'ANNIV30', endAt: iso(60) });
  ok('tapping an offer remembers its coupon until the offer ends', helpers.getPromoCoupon_() === 'ANNIV30' && (() => { store.ff_promo_coupon = JSON.stringify({ code: 'X', until: iso(-1) }); return helpers.getPromoCoupon_() === ''; })());
  ok('countdown text: days, then hh:mm:ss on the last day', /^\d+d \d+h left$/.test(helpers.promoLeft_(iso(60 * 50))) && /^\d\d:\d\d:\d\d left$/.test(helpers.promoLeft_(iso(90))) && helpers.promoLeft_(iso(-1)) === '');
  ok('checkout: new-order coupon pre-filled from the offer and applied once; renewal pre-filled', /coupon: getPromoCoupon_\(\),/.test(html) && /promoApplied\.current = true;\s*applyCoupon\(\);/.test(html) && /const \[couponCode, setCouponCode\] = useState\(getPromoCoupon_\);/.test(html));
  ok('app loads offers on start + every 5 min; bar, card (home / my plans) and pop-up rendered, not on maintenance', /API\.getPromos\(r =>/.test(html) && /setInterval\(load, 5 \* 60000\)/.test(html) && /!storeBlocked && \(\(\) => \{\s*const bar = promos\.find/.test(html) && /\(screen === 'home' \|\| screen === 'dashboard'\) && \(\(\) => \{\s*const card = promos\.find/.test(html) && /!storeBlocked && React\.createElement\(PromoPopup, \{/.test(html));
  ok('install pop-up waits while an offer pop-up is open', /if \(window\.ffPromoOpen\) return;/.test(html));
  ok('offer animations are transform/opacity only and stop for reduced motion', (() => { const kf = [...html.matchAll(/@keyframes (ffPromo\w+) \{([\s\S]*?)\} \}/g)]; return kf.length === 3 && kf.every((m) => (m[2].match(/([a-z-]+)\s*:/g) || []).every((q) => /^(transform|opacity)\s*:$/.test(q))); })() && /prefers-reduced-motion: reduce\) \{ \.ff-promo-pop, \.ff-promo-big, \.ff-promo-glow, \.ff-promo-bg \{ animation: none; \} \}/.test(html));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: public actions rate-limited, picture route before the catch-all, stats timer', /getPromos: \(\) => promosMod\.publicList\(\)/.test(srv) && /promoEvent: security\.rateLimiter/.test(srv) && srv.indexOf("app.get('/promo-img/:id'") < srv.indexOf("app.get('*'") && /promosMod\.startTimer\(\)/.test(srv));
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin: menu, anniversary template (ends 30 Sep 23:59 IST), live preview, picture upload', /\['promos', '📣', 'Offers'\]/.test(admin) && /endAt: '2026-09-30T23:59:00\+05:30'/.test(admin) && /function prPreview\(e\)/.test(admin) && /\/admin\/api\/promos\/image/.test(admin));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
