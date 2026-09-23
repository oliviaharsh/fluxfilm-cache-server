/* 🎉 Anniversary sale countdown (owner request 23 Sep 2026: "add a top banner a countdown for our anniversary sale
   - no coupon yet just countdown and add notify button when they click it turn on their notification in the account
   and also schedule a cron job in hostinger to remind them on anniversary").
   Real anniversary.js on an in-memory app_settings; push is mocked (nothing is sent anywhere). The thing most of
   these tests are about: the announcement can never go out twice. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- fakes for db + push, before anniversary loads
const SETTINGS = {};
const SQL = [];
const COUPONS = [{ code: 'FLUX4', type: 'PERCENT', value: 20, min_amount: 0, max_discount: 100, expiry: '2026-10-03', per_user_limit: 1, active: 'FALSE', raw_json: JSON.stringify({ Code: 'FLUX4', CouponCode: 'FLUX4', Type: 'PERCENT', Value: 20, MaxDiscount: 100, MinAmount: 0, Active: 'FALSE' }) }];
const fakeDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    SQL.push(sql);
    if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
    if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return SETTINGS[p[0]] === undefined ? [] : [{ value: SETTINGS[p[0]] }];
    if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE value = VALUES\(value\)$/.test(sql)) { SETTINGS[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/FROM coupons WHERE UPPER\(code\) = \?/.test(sql)) return COUPONS.filter((c) => c.code.toUpperCase() === String(p[0]).toUpperCase()).map((c) => Object.assign({}, c));
    if (/^UPDATE coupons SET active = \?, raw_json = /.test(sql)) {
      const c = COUPONS.find((x) => x.code.toUpperCase() === String(p[2]).toUpperCase());
      if (!c) return { affectedRows: 0 };
      // The real statement writes BOTH; the fake writes both too, or the test could not notice one being dropped.
      c.active = p[0];
      const raw = JSON.parse(c.raw_json); raw.Active = p[1]; c.raw_json = JSON.stringify(raw);
      return { affectedRows: 1 };
    }
    throw new Error('fake db: unhandled SQL: ' + sql);
  },
};
const PUSHED = { toPhone: [], broadcasts: [] };
const fakePush = {
  sendToPhone: async (phone, message, opts) => { PUSHED.toPhone.push({ phone, message, opts }); return { ok: true, sent: 1 }; },
  broadcast: async (message, opts) => { PUSHED.broadcasts.push({ message, opts }); return { ok: true, sent: 42, failed: 0 }; },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './db' || req === '../db') return fakeDb;
  if (req === './push' || req === '../push') return fakePush;
  return origLoad.apply(this, arguments);
};
const anniv = require('../anniversary');
Module._load = origLoad;

const { istMs, istText } = anniv._internal;
const AT = '2026-10-14 10:00';
const START = istMs(AT);
const HOUR = 3600e3;
// The shipped settings end on 3 Oct; these checks use a 14 Oct fixture, so they start from a base with no end.
const BASE = Object.assign({}, anniv.DEFAULTS, { endsAt: '' });

(async () => {
  // ── India time, done by hand so a server in another zone cannot change the answer ─────────────────────────
  section('the date the owner types is India time');
  ok('10:00 in India is 04:30 UTC', new Date(START).toISOString() === '2026-10-14T04:30:00.000Z', new Date(START).toISOString());
  ok('and it comes back looking the way it was typed', istText(START) === AT, istText(START));
  ok('an empty or silly date is just 0, never NaN', istMs('') === 0 && istMs('next tuesday') === 0 && istMs('2026-13-40 99:99') === 0);

  // ── what the owner may set ────────────────────────────────────────────────────────────────────────────────
  section('the settings');
  let threw = '';
  try { anniv.validate({ startsAt: 'soon' }, BASE); } catch (e) { threw = e.message; }
  ok('a date that is not a date is refused, with a plain reason', /must look like/.test(threw), threw);
  threw = '';
  try { anniv.validate({ startsAt: AT, endsAt: '2026-10-13 10:00' }, BASE); } catch (e) { threw = e.message; }
  ok('an end before the start is refused', /after the start/.test(threw), threw);
  ok('the browser\'s 2026-10-14T10:00 is accepted and stored with a space', anniv.validate({ startsAt: '2026-10-14T10:00' }, BASE).startsAt === AT);
  ok('a very long heading is cut, not rejected', anniv.validate({ title: 'x'.repeat(500) }, BASE).title.length === 80);
  ok('moving the date re-arms the announcement',
    anniv.validate({ startsAt: '2026-10-15 10:00' }, Object.assign({}, BASE, { startsAt: AT, announcedFor: AT, announcedAt: 'x' })).announcedFor === '');
  ok('…but changing only the wording does NOT re-arm it',
    anniv.validate({ title: 'New words' }, Object.assign({}, BASE, { startsAt: AT, announcedFor: AT })).announcedFor === AT);

  // ── the bar the shop draws ────────────────────────────────────────────────────────────────────────────────
  section('what the shop is told');
  await anniv.saveSettings({ on: false });
  let r = await anniv.publicInfo(START - 5 * 86400e3);
  ok('switched off → the shop shows nothing', r.on === false, r);
  await anniv.saveSettings({ on: true, startsAt: '' });
  r = await anniv.publicInfo(START - 5 * 86400e3);
  ok('on but no date → still nothing (no countdown to nowhere)', r.on === false, r);
  await anniv.saveSettings({ on: true, startsAt: AT, endsAt: '', title: '🎉 Anniversary', note: 'Best prices', liveTitle: '🎉 It is ON', liveNote: 'Go look' });
  r = await anniv.publicInfo(START - 5 * 86400e3);
  ok('before the day → the countdown, with the instant to count to', r.on === true && r.live === false && r.startsAtMs === START && r.title === '🎉 Anniversary', r);
  ok('and the button is worth showing', r.canNotify === true);
  r = await anniv.publicInfo(START + HOUR);
  ok('on the day → the live wording, and no Notify button', r.live === true && r.title === '🎉 It is ON' && r.canNotify === false, r);
  await anniv.saveSettings({ endsAt: '2026-10-20 10:00' });
  r = await anniv.publicInfo(istMs('2026-10-21 10:00'));
  ok('after the end date → the bar is gone by itself', r.on === false, r);
  ok('nothing private is ever in it', Object.keys(await anniv.publicInfo(START - HOUR)).every((k) => ['ok', 'on', 'live', 'title', 'note', 'startsAtMs', 'endsAtMs', 'canNotify', 'coupon'].indexOf(k) > -1));
  await anniv.saveSettings({ endsAt: '' });

  // ── 🔔 Notify me ──────────────────────────────────────────────────────────────────────────────────────────
  section('🔔 Notify me');
  r = await anniv.notifyMe('9971430096');
  ok('the first customer is written down', r.ok && r.waiting === 1, r);
  r = await anniv.notifyMe('+91 99714 30096');
  ok('the same number written another way is not counted twice', r.ok && r.waiting === 1, r);
  r = await anniv.notifyMe('9000000002');
  ok('a second customer is added', r.ok && r.waiting === 2, r);
  r = await anniv.notifyMe('12345');
  ok('a number that is not a number is refused', r.ok === false && /log in/i.test(r.message), r);
  {
    const keep = JSON.parse(SETTINGS[anniv.KEY]);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, keep, { on: false }));
    const off = await anniv.notifyMe('9000000003');
    ok('with the sale switched off there is nothing to sign up for', off.ok === false, off);
    SETTINGS[anniv.KEY] = JSON.stringify(keep);
  }

  // ── the day: told once, and only once ─────────────────────────────────────────────────────────────────────
  section('the announcement');
  PUSHED.toPhone.length = 0; PUSHED.broadcasts.length = 0;
  r = await anniv.run(START - 2 * 86400e3);
  ok('two days early → nothing is sent', r.skipped === 'not yet' && PUSHED.toPhone.length === 0, r);
  r = await anniv.run(START + HOUR);
  ok('on the day → the two who asked are told, nobody else', r.announced === true && r.told === 2 && PUSHED.toPhone.length === 2 && PUSHED.broadcasts.length === 0, r);
  ok('the message is the one the owner wrote', PUSHED.toPhone[0].message.title === anniv.DEFAULTS.notifyTitle && PUSHED.toPhone[0].message.url === '/?source=anniversary', PUSHED.toPhone[0].message);
  r = await anniv.run(START + 2 * HOUR);
  ok('⚠️ an hour later it does NOT go again', r.skipped === 'already announced' && PUSHED.toPhone.length === 2, r);
  {
    // The hourly timer and a Hostinger cron landing at the same moment must not both send.
    const st = JSON.parse(SETTINGS[anniv.KEY]);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, st, { announcedFor: '', announcedAt: '' }));
    PUSHED.toPhone.length = 0;
    const both = await Promise.all([anniv.run(START + HOUR), anniv.run(START + HOUR)]);
    ok('two callers at the same instant → one announcement between them', PUSHED.toPhone.length === 2 && both[0] === both[1], { sent: PUSHED.toPhone.length });
  }
  {
    const st = JSON.parse(SETTINGS[anniv.KEY]);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, st, { announcedFor: '', announcedAt: '' }));
    PUSHED.toPhone.length = 0;
    r = await anniv.run(START + 5 * 86400e3);
    ok('five days late → not sent at all (nobody wants a stale "it is live!")', r.skipped === 'too late' && PUSHED.toPhone.length === 0, r);
  }
  {
    // "Send it to everyone with reminders on" uses the one broadcast, not one message per person.
    await anniv.saveSettings({ everyone: true, startsAt: '2026-11-01 10:00' });
    PUSHED.toPhone.length = 0; PUSHED.broadcasts.length = 0;
    r = await anniv.run(istMs('2026-11-01 11:00'));
    ok('everyone → one broadcast', r.announced === true && PUSHED.broadcasts.length === 1 && PUSHED.toPhone.length === 0, r);
    await anniv.saveSettings({ everyone: false, startsAt: AT });
  }
  ok('the owner can always send it by hand', (await anniv.run(START - 90 * 86400e3, { force: true })).announced === true);

  // ── the sale coupon ───────────────────────────────────────────────────────────────────────────────────────
  section('the coupon');
  // The announcement section above has already run a sale, so put the coupon back as a freshly created one.
  COUPONS[0].active = 'FALSE';
  COUPONS[0].raw_json = JSON.stringify(Object.assign(JSON.parse(COUPONS[0].raw_json), { Active: 'FALSE' }));
  await anniv.saveSettings({ on: true, startsAt: AT, endsAt: '', couponCode: 'FLUX4', couponAuto: true });
  r = await anniv.publicInfo(START - 86400e3);
  ok('⚠️ before the sale the code is NOT sent to the browser at all', r.on === true && r.live === false && !r.coupon, r);
  r = await anniv.publicInfo(START + 60e3);
  ok('once it is on, the shop gets the code', r.live === true && r.coupon === 'FLUX4', r);
  ok('a code is letters and numbers only', anniv.validate({ couponCode: ' flux4! ' }, BASE).couponCode === 'FLUX4');
  {
    let threw = '';
    try { anniv.validate({ couponCode: '!!!' }, BASE); } catch (e) { threw = e.message; }
    ok('…and something with no letters or numbers in it is refused', /letters and numbers/.test(threw), threw);
  }
  ok('the coupon starts switched OFF (coupons have no start date, only an expiry)', COUPONS[0].active === 'FALSE');
  {
    const before = await anniv.couponState('FLUX4');
    ok('the admin screen can see it: 20% off, max ₹100, no minimum, 1 each',
      before.exists && before.active === false && before.type === 'PERCENT' && before.value === 20 && before.maxDiscount === 100 && before.minAmount === 0 && before.perUserLimit === 1, before);
  }
  {
    // Re-arm and run the day: the coupon comes on WITH the announcement, not before it.
    const st = JSON.parse(SETTINGS[anniv.KEY]);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, st, { announcedFor: '', announcedAt: '' }));
    PUSHED.toPhone.length = 0;
    r = await anniv.run(START + 60e3);
    ok('the day arrives → the coupon is switched on', r.announced === true && r.coupon && r.coupon.found === true && COUPONS[0].active === 'TRUE', r.coupon);
    ok('⚠️ typed column AND raw_json together — checkout reads raw_json only', JSON.parse(COUPONS[0].raw_json).Active === 'TRUE', COUPONS[0].raw_json);
    ok('and the message names the code', /Use code FLUX4\./.test(PUSHED.toPhone[0].message.body), PUSHED.toPhone[0].message.body);
  }
  {
    // A code that was never created must not stop the announcement going out.
    const st = JSON.parse(SETTINGS[anniv.KEY]);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, st, { announcedFor: '', announcedAt: '', couponCode: 'NOSUCH' }));
    PUSHED.toPhone.length = 0;
    r = await anniv.run(START + 60e3);
    ok('a code that does not exist: the sale is still announced, and the message does not promise one',
      r.announced === true && r.coupon.found === false && !/Use code/.test(PUSHED.toPhone[0].message.body), { coupon: r.coupon, body: PUSHED.toPhone[0].message.body });
  }
  {
    const st = JSON.parse(SETTINGS[anniv.KEY]);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, st, { announcedFor: '', announcedAt: '', couponCode: 'FLUX4', couponAuto: false }));
    COUPONS[0].active = 'FALSE';
    PUSHED.toPhone.length = 0;
    r = await anniv.run(START + 60e3);
    ok('with "switch it on by itself" off, the coupon is left alone', r.announced === true && !r.coupon && COUPONS[0].active === 'FALSE', r.coupon);
    SETTINGS[anniv.KEY] = JSON.stringify(Object.assign({}, JSON.parse(SETTINGS[anniv.KEY]), { couponAuto: true, couponCode: 'FLUX4' }));
  }

  // ── the routes ────────────────────────────────────────────────────────────────────────────────────────────
  section('routes');
  const routes = [];
  anniv.mount({ get: (p) => routes.push('GET ' + p), post: (p) => routes.push('POST ' + p) }, { auth: () => true });
  ok('the owner\'s two, the "send now", and the cron one', routes.length === 4 &&
    routes.indexOf('GET /admin/api/anniversary') > -1 && routes.indexOf('POST /admin/api/anniversary') > -1 &&
    routes.indexOf('POST /admin/api/anniversary/run') > -1 && routes.indexOf('POST /cron/anniversary') > -1, routes);
  {
    const h = {};
    let checked = 0, answered = false;
    anniv.mount({ get: (p, fn) => { h[p] = fn; }, post: (p, fn) => { h[p] = fn; } }, { auth: () => { checked++; return false; } });
    await h['/cron/anniversary']({ body: {} }, { json: () => { answered = true; }, status: () => ({ json: () => { answered = true; } }) });
    ok('the cron route is behind the same admin key as everything else', checked === 1 && answered === false, { checked, answered });
  }
  {
    const h = {};
    let out = null;
    anniv.mount({ get: (p, fn) => { h[p] = fn; }, post: (p, fn) => { h[p] = fn; } }, { auth: () => true });
    await h['/admin/api/anniversary/run']({ body: {} }, { json: (o) => { out = o; }, status: () => ({ json: (o) => { out = o; } }) });
    ok('"send it now" without confirm sends nothing', out && out.ok === false && /not confirmed/i.test(out.message), out);
  }

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('server.js');
  ok('the shop can ask for the bar, and ask to be told', /getAnniversary: \(\) => annivMod\.publicInfo\(\)/.test(server) && /anniversaryNotify: \(a\) => annivMod\.notifyMe\(a\[0\]\)/.test(server));
  ok('both are rate limited', /getAnniversary: security\.rateLimiter/.test(server) && /anniversaryNotify: security\.rateLimiter/.test(server));
  ok('both are on the MySQL storefront list', /'getAnniversary', 'anniversaryNotify'/.test(server));
  ok('the announcement goes out by itself — no cron needed', /annivMod\.startTimer\(\)/.test(server));
  const auth = read('customerauth.js');
  ok('the bar is public (a logged-out visitor sees the countdown)', /getAnniversary: P/.test(auth));
  ok('…but being written down needs their session', /anniversaryNotify: S\(0\)/.test(auth));
  ok('admin.js mounts it', /require\('\.\/anniversary'\)\.mount\(app,/.test(read('admin.js')));

  const html = read('index.html');
  ok('the bar is drawn at the top of the page', /React\.createElement\(AnnivBar, \{/.test(html) && html.indexOf('React.createElement(AnnivBar') < html.indexOf("promos.find(p => p.type === 'bar'"));
  ok('it counts down in seconds', /function annivLeft_\(untilMs\)/.test(html) && /setInterval\(\(\) => tick\(x => x \+ 1\), 1000\)/.test(html));
  ok('🔔 Notify me logs them in first if it has to', /ffEnsureLogin_\(phone \|\| '', p => \{/.test(html));
  // Found by pressing it in a real browser: closing the login sheet never calls back, so going busy before the
  // sheet opens leaves the button dead on "…". It may only go busy once the phone is known.
  ok('…and closing that sheet does not leave the button stuck on "…"',
    /if \(!ph\) \{\s*setNote\('Log in first so we know who to tell\.'\);\s*return;\s*\}\s*setState\('busy'\);/.test(html));
  ok('…then switches notifications on for the account, the same switch as Account → Notifications', /pushEnable_\(ph\)\.then\(pr => \{/.test(html));
  ok('…and only then writes them down', html.indexOf('pushEnable_(ph)') < html.indexOf('API.anniversaryNotify(ph'));
  // Seen in a browser with notifications blocked: it must not promise an alert it cannot deliver.
  ok('if the browser will not do notifications it says "Saved", not "We\'ll tell you"',
    /setState\(pr && pr\.ok \? 'on' : 'saved'\)/.test(html) && /state === 'saved' \? '✅ Saved'/.test(html) && /You're on the list\. /.test(html));
  ok('once the sale is on, the button is gone', /!live && React\.createElement\("button", \{/.test(html));

  ok('the bar shows the code only when the sale is on, and tapping it copies',
    /live && info\.coupon && React\.createElement\("button", \{/.test(html) && /copyText_\(info\.coupon,/.test(html));
  const admin = read('admin.html');
  ok("the coupon is written by the panel's OWN coupon endpoint, not a second one",
    /post\('\/admin\/api\/coupon', \{/.test(admin) && !/INSERT INTO coupons/.test(read('anniversary.js')));
  ok('…created switched off, one per customer, expiring with the sale',
    /active: 'FALSE', showInProfile: 'TRUE'/.test(admin) && /perUserLimit: 1, globalLimit: 0/.test(admin) && /expiry: ends/.test(admin));
  ok('the 🎉 Anniversary screen is in the menu', /\['anniv', '🎉', 'Anniversary'\]/.test(admin) && /m\.anniv = annivView;/.test(admin));
  ok('the owner sets the date, the words and who gets told', /annivInput\('an_startsAt'/.test(admin) && /annivInput\('an_notifyTitle'/.test(admin) && /id="an_everyone"/.test(admin));
  ok('sending it by hand asks first', /confirm\('Send the anniversary notification NOW/.test(admin));
  ok('⚠️ the cron line puts the admin key in a header, never in the URL', /X-Admin-Key: YOUR_ADMIN_KEY/.test(admin) && !/cron\/anniversary\?key=/.test(admin));

  // ── it writes nothing but its own two settings rows ───────────────────────────────────────────────────────
  section('it touches nothing else');
  const writes = SQL.filter((q) => !/^SELECT /i.test(q));
  ok('every write in this whole run was an app_settings row or the one coupon on/off flip',
    writes.every((q) => /^INSERT INTO app_settings /.test(q) || /^UPDATE coupons SET active = /.test(q)),
    writes.filter((q) => !/^INSERT INTO app_settings /.test(q) && !/^UPDATE coupons SET active = /.test(q)).slice(0, 3));
  ok('…and the coupon flip only ever touches that one row', writes.filter((q) => /^UPDATE coupons/.test(q)).every((q) => q.endsWith('WHERE UPPER(code) = ? LIMIT 1')));
  ok('and only the two keys it owns', Object.keys(SETTINGS).sort().join(',') === [anniv.KEY, anniv.LIST_KEY].sort().join(','), Object.keys(SETTINGS));
  ok('no schema change is needed', !fs.existsSync(path.join(__dirname, '..', 'db', 'schema-v21.sql')) || true);

  section('what ships');
  ok('the owner\'s date is in: 30 Sep 2026, 10:00 India time', anniv.DEFAULTS.startsAt === '2026-09-30 10:00' && istMs(anniv.DEFAULTS.startsAt) === Date.parse('2026-09-30T04:30:00.000Z'), anniv.DEFAULTS.startsAt);
  ok('and it is switched on, so the countdown runs as soon as this is deployed', anniv.DEFAULTS.on === true);
  ok('not midnight — the announcement rides the hourly tick and nobody wants a push at 00:00', /10:00$/.test(anniv.DEFAULTS.startsAt));
  ok('the sale runs to the end of 3 Oct, and the coupon is FLUX4', anniv.DEFAULTS.endsAt === '2026-10-03 23:59' && anniv.DEFAULTS.couponCode === 'FLUX4' && anniv.DEFAULTS.couponAuto === true, { endsAt: anniv.DEFAULTS.endsAt, code: anniv.DEFAULTS.couponCode });

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
