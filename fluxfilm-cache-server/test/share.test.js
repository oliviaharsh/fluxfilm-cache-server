/* 📤 Share texts (index.html shareText_) + link previews for /?post=<id> and /?ref=<CODE> (share.js). Feed, catalog, referrals mocked — no DB, no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const net = require('net');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('- ' + t);
const ROOT = path.join(__dirname, '..');

const P = (service, plan, days, price) => ({ service, plan, durationDays: days, price, fulfillmentMode: 'INSTANT', allocationPolicy: 'PROFILE', benefits: [], logoUrl: '', deviceRuleText: '', requiresGroupJoin: false });
const plans = [P('Netflix', 'Sharing 1M', 30, 139), P('Netflix', 'Private 3M', 90, 499), P('Prime Video', '1 Month', 30, 39), P('JioHotstar', '1 Month', 30, 69)];
const future = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
let posts = [
  { id: 'fpa3a00152db', type: 'series', title: 'The Runner', service: 'Prime Video', caption: 'A marathon runner discovers a secret. '.repeat(8), releaseDate: '2026-09-01', image: '/tmdb-img/t/p/w780/kPKAigYUlWRpnfo4Ptiwlz4FWXU.jpg' },
  { id: 'fp0123456789', type: 'movie', title: 'Evil <script>alert("x")</script> "Heist"', service: 'Netflix', caption: '<img src=x onerror=alert(1)>', releaseDate: future, image: '/feed-img/fp0123456789?v=2026-09-14T20%3A32%3A16.110Z' },
  { id: 'fpbbbbbbbbbb', type: 'announcement', title: 'Diwali offers are here', service: '', caption: '', image: 'https://evil.example.com/x.jpg' },
];
let feedCalls = 0; let feedDown = false; let feedSlow = false;
const mockFeed = {
  publicList: async () => {
    feedCalls++;
    if (feedDown) throw new Error('db down');
    if (feedSlow) await new Promise((r) => setTimeout(r, 2500));
    return { ok: true, posts };
  },
};
const mockCatalog = { getBootstrap: async () => ({ ok: true, plans: JSON.parse(JSON.stringify(plans)) }), getStockLevels: async () => ({ ok: true, levels: {} }) };
const codes = {
  FFABC234: { name: 'rahul kumar', phone: '9876543210' },
  FFEVIL22: { name: '<script>alert(1)</script>', phone: '9000000001' },
  FFPHONE2: { name: '9876543210', phone: '9000000002' },
  FFNONAME: { name: '', phone: '9000000003' },
};
let refCalls = 0; let friendDiscount = 20;
const mockReferrals = {
  checkReferral: async (code, phone) => {
    refCalls++;
    if (phone) throw new Error('preview must not pass a phone');
    const c = codes[code];
    if (!c) return { ok: false, invalid: true, message: 'This invite link is not valid.' };
    return { ok: true, code, friendDiscount, minOrder: 0, referrerName: String(c.name).split(/\s+/)[0], referrerPhone: c.phone, discount: friendDiscount };
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './catalog') return mockCatalog;
  if (req === './feed') return mockFeed;
  if (req === './referrals') return mockReferrals;
  if (req === './db') return { ENABLED: false, query: async () => { throw new Error('no db in test'); } };
  return origLoad.apply(this, arguments);
};
const share = require('../share');

const store = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const metaContent = (html, attr, name) => { const m = html.match(new RegExp('<meta ' + attr + '="' + name.replace(/[.:]/g, '\\$&') + '" content="([^"]*)"')); return m ? m[1] : null; };
const decode = (x) => String(x).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const titleOf = (html) => decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');

(async () => {
  section('share texts (index.html shareText_)');
  const a = store.indexOf('const shareText_ = {'); const b = store.indexOf('function copyText_(');
  let T = null;
  try { T = new Function(store.slice(a, b) + '; return shareText_;')(); } catch (e) { console.log('   ', e.message); }
  ok('shareText_ is one block right before copyText_', T && a > 0 && b > a && b - a < 5000);
  const now = Date.parse('2026-09-15T10:00:00+05:30');
  let m = T.post({ title: 'The *Runner*', type: 'series', service: 'Prime Video', releaseDate: '2026-09-01' }, { service: 'Prime Video', price: 39 }, now);
  ok('post: bold title, service, cheapest price, instant login, ends with 👉 and NO link (share sheet adds the url)', m.text === '🍿 *The Runner* is streaming on Prime Video! Watch it with FluxFilm — Prime Video from ₹39, instant login ✅ 👉' && m.title === 'The Runner — on Prime Video' && !/https?:/.test(m.text), m);
  m = T.post({ title: 'Big Film', type: 'movie', service: 'Netflix', releaseDate: '2026-09-25' }, null, now);
  ok('post: future release says "coming to … on <date>"; no catalog price → "at low prices"', /^🍿 \*Big Film\* is coming to Netflix on 25 Sept?\.?! Get ready with FluxFilm — Netflix at low prices, instant login ✅ 👉$/.test(m.text), m.text);
  m = T.post({ title: 'Diwali offers', type: 'announcement', service: '' }, null, now);
  ok('post: announcement / no service', m.text === '📣 *Diwali offers* — fresh from FluxFilm 🍿 👉' && m.title === 'Diwali offers', m);
  const info = { code: 'FFABC234', link: 'https://shop.fluxfilm.in/?ref=FFABC234', friendDiscount: 20 };
  const long = T.referral(info);
  ok('referral: warm text, real friend discount, code visible, link LAST', long === '🎁 Hey! I get my Netflix, Prime Video & JioHotstar from FluxFilm — cheap, instant and legit. Use my link and get *₹20 OFF* your first plan (code FFABC234) 👉 https://shop.fluxfilm.in/?ref=FFABC234', long);
  const short = T.referralShort(info);
  ok('referral short (Copy link): shorter, code + link last', short === '🎁 ₹20 OFF your first FluxFilm plan — code FFABC234 👉 https://shop.fluxfilm.in/?ref=FFABC234' && short.length < long.length / 2, short);
  ok('referral with ₹0 friend discount never says "₹0 OFF"', !/₹0/.test(T.referral(Object.assign({}, info, { friendDiscount: 0 }))) && T.referralShort(Object.assign({}, info, { friendDiscount: 0 })) === '🎁 Join me on FluxFilm — code FFABC234 👉 https://shop.fluxfilm.in/?ref=FFABC234');
  ok('₹ uses Indian grouping', T.rupees(1299) === '₹1,299' && T.rupees(0) === '' && T.rupees('x') === '');

  section('share buttons use the texts');
  const fnSrc = (name) => { const i = store.indexOf('function ' + name + '('); const j = store.indexOf('\n}\n', i); return i >= 0 && j > i ? store.slice(i, j + 2) : ''; };
  const calls = [];
  const mk = (nav) => new Function('shareText_', 'navigator', 'window', 'copyText_', 'feedEvent_', fnSrc('feedShare_') + 'return feedShare_;')(T, nav, { location: { origin: 'https://shop.fluxfilm.in' } }, (t, done) => { calls.push(['copy', t]); done(); }, (id, k) => calls.push([k, id]));
  let shared = null;
  const p1 = { id: 'fpa3a00152db', title: 'The Runner', type: 'series', service: 'Prime Video', releaseDate: '2026-09-01' };
  await new Promise((r) => mk({ share: (d) => { shared = d; return Promise.resolve(); } })(p1, { service: 'Prime Video', price: 39 }, r));
  ok('feed share sheet: title + text without link + url /?post=<id>', shared && shared.url === 'https://shop.fluxfilm.in/?post=fpa3a00152db' && /^🍿 \*The Runner\* is streaming on Prime Video!.*₹39/.test(shared.text) && !shared.text.includes('http') && shared.title === 'The Runner — on Prime Video' && calls.some((c) => c[0] === 'share'), shared);
  let how = '';
  await new Promise((r) => mk({})(p1, null, (h) => { how = h; r(); }));
  const copied = calls.filter((c) => c[0] === 'copy').pop();
  ok('no share sheet: copies the whole message with the link at the end', how === 'copied' && copied && /👉 https:\/\/shop\.fluxfilm\.in\/\?post=fpa3a00152db$/.test(copied[1]), copied);
  ok('feed post passes the catalog info (cheapest plan) even when the post has no buy button', /shareInfo: info \|\| feedServiceInfo_\(p\.service, plans\)/.test(store) && /onClick: \(\) => feedShare_\(p, shareInfo, how => \{/.test(store));
  ok('Refer & earn: WhatsApp uses shareText_.referral, Copy link uses shareText_.referralShort', /const shareText = shareText_\.referral\(info\);/.test(store) && /copy\('link', shareText_\.referralShort\(info\)\)/.test(store) && /'https:\/\/wa\.me\/\?text=' \+ encodeURIComponent\(shareText\)/.test(store));
  const scripts = [...store.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('storefront script parses', parsed);

  section('strict inputs');
  const I = share._internal;
  ok('post id pattern only', I.postIdOf({ post: 'fpa3a00152db' }) === 'fpa3a00152db' && I.postIdOf({ post: 'FPA3A00152DB' }) === '' && I.postIdOf({ post: '"><script>' }) === '' && I.postIdOf({ post: ['fpa3a00152db'] }) === '' && I.postIdOf({}) === '' && I.postIdOf(null) === '');
  ok('ref code pattern only (4-16 letters/digits, upper-cased)', I.refCodeOf({ ref: 'ffabc234' }) === 'FFABC234' && I.refCodeOf({ ref: 'FF<b>' }) === '' && I.refCodeOf({ ref: 'ABC' }) === '' && I.refCodeOf({ ref: 'A'.repeat(17) }) === '' && I.refCodeOf({ ref: ['FFABC234'] }) === '');
  ok('first name only, letters only, never digits / emails', I.firstName('rahul kumar') === 'Rahul' && I.firstName('PRIYA') === 'Priya' && I.firstName('9876543210') === '' && I.firstName('a@b.com') === '' && I.firstName('<script>') === '' && I.firstName('R2D2') === '' && I.firstName('') === '' && I.firstName('राहुल') === 'राहुल');
  ok('poster: TMDB via our proxy at w500 with size; uploaded picture without size; outside URLs dropped', JSON.stringify(I.postImage('/tmdb-img/t/p/w780/kPKAigYUlWRpnfo4Ptiwlz4FWXU.jpg')) === JSON.stringify({ url: 'https://shop.fluxfilm.in/tmdb-img/t/p/w500/kPKAigYUlWRpnfo4Ptiwlz4FWXU.jpg', width: 500, height: 750, type: 'image/jpeg' }) && I.postImage('/feed-img/fp0123456789?v=1').url === 'https://shop.fluxfilm.in/feed-img/fp0123456789?v=1' && !I.postImage('/feed-img/fp0123456789?v=1').width && I.postImage('https://evil.example.com/x.jpg') === null && I.postImage('/tmdb-img/t/p/w780/../../x.jpg') === null);

  section('post preview /?post=<id>');
  let html = await share.decorate(store, { post: 'fpa3a00152db' });
  const ogTitle = decode(metaContent(html, 'property', 'og:title'));
  const ogDesc = decode(metaContent(html, 'property', 'og:description'));
  ok('og:title "🍿 <Title> — now on <Service>" (also <title> + twitter:title)', ogTitle === '🍿 The Runner — now on Prime Video' && titleOf(html) === ogTitle && decode(metaContent(html, 'name', 'twitter:title')) === ogTitle, ogTitle);
  ok('og:description = caption (trimmed) + "Get <Service> on FluxFilm from ₹X"', /^A marathon runner discovers a secret\./.test(ogDesc) && /… Get Prime Video on FluxFilm from ₹39 — pay by UPI, instant login\.$/.test(ogDesc) && ogDesc.length < 240, ogDesc);
  ok('og:image = poster (absolute, w500, 500×750, jpeg) + twitter:image', metaContent(html, 'property', 'og:image') === 'https://shop.fluxfilm.in/tmdb-img/t/p/w500/kPKAigYUlWRpnfo4Ptiwlz4FWXU.jpg' && metaContent(html, 'property', 'og:image:width') === '500' && metaContent(html, 'property', 'og:image:height') === '750' && metaContent(html, 'property', 'og:image:type') === 'image/jpeg' && metaContent(html, 'name', 'twitter:image') === metaContent(html, 'property', 'og:image'));
  ok('og:url = the share link, canonical → /whats-new, noindex', metaContent(html, 'property', 'og:url') === 'https://shop.fluxfilm.in/?post=fpa3a00152db' && /<link rel="canonical" href="https:\/\/shop\.fluxfilm\.in\/whats-new" \/>/.test(html) && metaContent(html, 'name', 'robots') === 'noindex, follow, max-image-preview:large');
  ok('only the head changes (same page otherwise, one of each tag)', html.length - store.length < 2000 && (html.match(/<meta property="og:title"/g) || []).length === 1 && (html.match(/<title>/g) || []).length === 1 && html.slice(html.indexOf('</head>')) === store.slice(store.indexOf('</head>')));
  html = await share.decorate(store, { post: 'fp0123456789' });
  ok('future post: "coming soon to"; DB text escaped everywhere; uploaded picture without size', /^🍿 Evil <script>alert\("x"\)<\/script> "Heist" — coming soon to Netflix$/.test(decode(metaContent(html, 'property', 'og:title'))) && !/<script>alert|<img src=x/.test(html.slice(0, html.indexOf('</head>'))) && metaContent(html, 'property', 'og:image') === 'https://shop.fluxfilm.in/feed-img/fp0123456789?v=2026-09-14T20%3A32%3A16.110Z' && metaContent(html, 'property', 'og:image:width') === null && /from ₹139/.test(decode(metaContent(html, 'property', 'og:description'))));
  html = await share.decorate(store, { post: 'fpbbbbbbbbbb' });
  ok('announcement: "📣 <Title> | FluxFilm", outside picture → brand image', decode(metaContent(html, 'property', 'og:title')) === '📣 Diwali offers are here | FluxFilm' && metaContent(html, 'property', 'og:image') === 'https://shop.fluxfilm.in/og-image.png?v=1' && metaContent(html, 'property', 'og:image:width') === '1200' && !/evil\.example/.test(html));
  ok('unknown / hidden post id → normal head, byte for byte', (await share.decorate(store, { post: 'fpcccccccccc' })) === store);
  ok('invalid id → normal head, no lookup', (await share.decorate(store, { post: '<script>' })) === store && (await share.decorate(store, {})) === store);
  const before = feedCalls;
  await share.decorate(store, { post: 'fpa3a00152db' }); await share.decorate(store, { post: 'fpcccccccccc' });
  ok('cached 5 min per id (found and not found)', feedCalls === before);

  section('referral preview /?ref=<CODE>');
  html = await share.decorate(store, { ref: 'ffabc234' });
  ok('og:title "🎁 <FirstName> invited you to FluxFilm — ₹20 OFF your first plan"', decode(metaContent(html, 'property', 'og:title')) === '🎁 Rahul invited you to FluxFilm — ₹20 OFF your first plan' && titleOf(html) === '🎁 Rahul invited you to FluxFilm — ₹20 OFF your first plan');
  ok('og:description + referral card 1200×630 + share url + noindex', decode(metaContent(html, 'property', 'og:description')) === 'Netflix, Prime Video, JioHotstar & more at low prices. Instant login, pay by UPI.' && metaContent(html, 'property', 'og:image') === 'https://shop.fluxfilm.in/og-referral.png?v=1' && metaContent(html, 'property', 'og:image:width') === '1200' && metaContent(html, 'property', 'og:image:height') === '630' && metaContent(html, 'property', 'og:url') === 'https://shop.fluxfilm.in/?ref=FFABC234' && metaContent(html, 'name', 'robots') === 'noindex, follow, max-image-preview:large' && /<link rel="canonical" href="https:\/\/shop\.fluxfilm\.in\/" \/>/.test(html));
  ok('never leaks the phone number', !/9876543210|98765/.test(html));
  html = await share.decorate(store, { ref: 'FFEVIL22' });
  ok('name with markup → "A friend" (nothing of it in the head)', !/<script|alert/i.test(html.slice(0, html.indexOf('<style>'))) && /^🎁 A friend invited you/.test(decode(metaContent(html, 'property', 'og:title'))));
  html = await share.decorate(store, { ref: 'FFPHONE2' });
  ok('name that is a phone number → "A friend"', decode(metaContent(html, 'property', 'og:title')) === '🎁 A friend invited you to FluxFilm — ₹20 OFF your first plan' && !/9876543210/.test(html));
  friendDiscount = 0;
  html = await share.decorate(store, { ref: 'FFNONAME' });
  ok('no name, ₹0 discount → "🎁 A friend invited you to FluxFilm"', decode(metaContent(html, 'property', 'og:title')) === '🎁 A friend invited you to FluxFilm');
  friendDiscount = 20;
  ok('unknown code / bad code → normal head', (await share.decorate(store, { ref: 'NOPE1234' })) === store && (await share.decorate(store, { ref: 'x"><b>' })) === store);
  const rc = refCalls;
  await share.decorate(store, { ref: 'FFABC234' }); await share.decorate(store, { ref: 'NOPE1234' });
  ok('referral lookups cached too', refCalls === rc);
  ok('post wins when both are present', /now on Prime Video/.test(await share.decorate(store, { post: 'fpa3a00152db', ref: 'FFABC234' })));

  section('fail soft');
  share.clearCache(); feedDown = true;
  ok('DB error → normal head', (await share.decorate(store, { post: 'fpa3a00152db' })) === store);
  feedDown = false; feedSlow = true; share.clearCache();
  const t0 = Date.now();
  ok('slow DB (> 1.5 s) → normal head quickly, not cached', (await share.decorate(store, { post: 'fpa3a00152db' })) === store && Date.now() - t0 < 2200 && !share._internal.cache.has('p:fpa3a00152db'));
  feedSlow = false;
  ok('works again after', /now on Prime Video/.test(await share.decorate(store, { post: 'fpa3a00152db' })));
  for (let i = 0; i < 520; i++) await share.decorate(store, { ref: 'ZZ' + String(i).padStart(4, '0') });
  ok('cache capped at 500 entries', share._internal.cache.size <= 500);

  section('routes + wiring');
  const express = require('express');
  const app = express();
  share.mount(app);
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const server = app.listen(port);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/og-referral.png');
    const buf = Buffer.from(await res.arrayBuffer());
    ok('/og-referral.png: 1200×630 PNG, long cache, small file', res.status === 200 && res.headers.get('content-type') === 'image/png' && /max-age=2592000/.test(res.headers.get('cache-control')) && buf.slice(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630 && buf.length < 150000, buf.length);
  } finally { server.closeAllConnections(); server.close(); }
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('server: share mounted before the catch-all; decorates only "/" after seo', srv.indexOf("share = require('./share'); share.mount(app);") > srv.indexOf("seo.mount(app)") && srv.indexOf('share.mount(app)') < srv.indexOf("app.get('*'") && /if \(share && \(req\.path === '\/' \|\| req\.path === '\/index\.html'\)\) \{ try \{ out = await share\.decorate\(out, req\.query\); \} catch \(_\) \{\} \}/.test(srv) && srv.indexOf('share.decorate(out') > srv.indexOf('seo.decorateIndex(html)'));
  ok('npm test runs this suite', /node test\/share\.test\.js/.test(require('../package.json').scripts.test));

  Module._load = origLoad;
  console.log('\nshare: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
