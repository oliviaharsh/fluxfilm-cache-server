/* 🍿 Feed v3: brand vs plan, Instagram thumbnails (server-side), ✨ AI fill, genre / platform / date filters + search, share texts.
   DB, TMDB, Instagram and the AI are all mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const ROOT = path.join(__dirname, '..');

const settings = {};
const plans = [
  { service: 'Netflix', price: 139, logo_url: 'https://cdn.example/netflix.png', is_active: 'TRUE', raw_json: '{}' },
  { service: 'Netflix (Group Offer)', price: 99, logo_url: 'https://cdn.example/other.jpg', is_active: 'TRUE', raw_json: '{}' },
  { service: 'Prime Video', price: 39, logo_url: 'https://cdn.example/prime.png', is_active: 'TRUE', raw_json: '{}' },
  { service: 'Prime Video + Shopping', price: 69, logo_url: '', is_active: 'TRUE', raw_json: '{}' },
  { service: 'SonyLiv Premium', price: 69, logo_url: '', is_active: 'TRUE', raw_json: '{}' },
];
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(sql)) { delete settings[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT service, price, logo_url, is_active, raw_json FROM plans$/.test(sql)) return plans;
    if (/feed_comments/.test(sql)) throw Object.assign(new Error("Table 'feed_comments' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const feed = require('../feed');
const thumbs = require('../feedthumb');
const feedai = require('../feedai');

// ---- fake TMDB (search → Front of the Class 2008) ----
const tmdbCalls = [];
feed._internal.setFetch(async (url) => {
  const u = new URL(url); tmdbCalls.push(u);
  const res = (body, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => body });
  const pth = u.pathname.replace('/3', '');
  if (pth === '/genre/movie/list') return res({ genres: [{ id: 18, name: 'Drama' }, { id: 36, name: 'History' }, { id: 10759, name: 'Action & Adventure' }] });
  if (pth === '/genre/tv/list') return res({ genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }] });
  if (pth === '/search/multi') {
    const q = u.searchParams.get('query').toLowerCase();
    if (/front of the class/.test(q)) return res({ results: [
      { id: 900, media_type: 'movie', title: 'Front of the Classroom', release_date: '2019-01-01', poster_path: '/wrong.jpg', genre_ids: [18], original_language: 'en', popularity: 90 },
      { id: 901, media_type: 'movie', title: 'Front of the Class', release_date: '2008-12-07', poster_path: '/front.jpg', genre_ids: [18, 36], original_language: 'en', popularity: 12, overview: 'Brad Cohen story.' },
      { id: 5, media_type: 'person', name: 'Someone' }] });
    return res({ results: [] });
  }
  if (pth === '/movie/901') return res({ id: 901, title: 'Front of the Class', release_date: '2008-12-07', poster_path: '/front.jpg', genres: [{ id: 18, name: 'Drama' }, { id: 10759, name: 'Action & Adventure' }], original_language: 'en', overview: 'Brad Cohen story.', videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abcdefghijk' }] } });
  return res({}, 404);
});

// ---- fake Instagram ----
const REEL = 'https://www.instagram.com/reel/DXcHYvyk1py/';
const jpeg = (kb) => { const b = Buffer.alloc(kb * 1024, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };
const EMBED_HTML = '<html><img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;us.silverscreens" src="https://instagram.flhr14-1.fna.fbcdn.net/v/big.jpg?stp=dst-jpg&amp;_nc_cat=105"/>' +
  '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/us.silverscreens/">us.silverscreens</a><br /><br />🎥: Front of the Class (2008) is a biographical drama &amp; true story.<br /><br /><a href="/explore/tags/hopecore/">#hopecore</a><div class="CaptionComments">x</div></div></html>';
const PAGE_HTML = '<meta property="og:image" content="https://scontent.cdninstagram.com/v/small.jpg?stp=s640x640&amp;x=1" /><meta property="og:description" content="120 likes, 4 comments - us.silverscreens on September 1, 2026: &quot;Front of the Class (2008) page caption&quot;. " />';
let ig = {};
const httpCalls = [];
const fakeHttp = async (url, opts) => {
  httpCalls.push({ url, opts });
  const u = new URL(url);
  const html = (s, status) => ({ status: status || 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(s) });
  if (u.hostname === 'graph.facebook.com') { if (ig.oembed) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(ig.oembed)) }; return html('{}', 400); }
  if (/embed\/captioned\/$/.test(u.pathname)) { if (ig.embedDown) throw Object.assign(new Error('Could not reach www.instagram.com'), { reason: 'ETIMEDOUT' }); return ig.embedStatus ? html('', ig.embedStatus) : html(ig.embedHtml || EMBED_HTML); }
  if (u.hostname === 'www.instagram.com') return ig.pageStatus ? html('', ig.pageStatus) : html(ig.pageHtml || PAGE_HTML);
  if (/big\.jpg$/.test(u.pathname)) return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: jpeg(ig.bigKb || 240) };
  if (/small\.jpg$/.test(u.pathname)) return ig.smallStatus ? html('', ig.smallStatus) : { status: 200, headers: { 'content-type': 'image/jpeg' }, body: jpeg(ig.smallKb || 23) };
  if (/oembed-thumb\.jpg$/.test(u.pathname)) return { status: 200, headers: {}, body: jpeg(30) };
  if (/notimage/.test(u.pathname)) return { status: 200, headers: {}, body: Buffer.from('<html>login</html>'.repeat(10)) };
  return html('', 404);
};

(async () => {
  // ================= 🏷️ brand vs plan =================
  const B = feed.brandOf;
  const brandCases = [['Netflix', 'Netflix'], ['Netflix (Group Offer)', 'Netflix'], ['netflix private 2 devices', 'Netflix'], ['Prime Video', 'Prime Video'], ['Prime Video + Shopping', 'Prime Video'], ['Amazon Prime', 'Prime Video'], ['JioHotstar', 'JioHotstar'], ['Disney+ Hotstar', 'JioHotstar'], ['JioCinema', 'JioHotstar'], ['SonyLiv Premium', 'SonyLIV'], ['Sony LIV', 'SonyLIV'], ['Zee5 Premium', 'Zee5'], ['ZEE 5', 'Zee5'], ['Crunchyroll', 'Crunchyroll'], ['YouTube Premium', 'YouTube'], ['Apple TV+', 'Apple TV+'], ['MX Player Premium', 'MX Player'], ['Hoichoi (Group Offer)', 'Hoichoi'], ['', ''], ['Aha + Shopping', 'Aha']];
  const brandMiss = brandCases.filter(([i, o]) => B(i) !== o).map(([i, o]) => [i, o, B(i)]);
  ok('brandOf: strips (Group Offer) / + Shopping / Premium, maps to the real brand name', brandMiss.length === 0, brandMiss);
  ok('brandOf never matches "zee" inside another word', B('Zeebra Films') === 'Zeebra Films');
  const services = plans.map((x) => x.service);
  ok('main plan of a brand = shortest catalog service ("Netflix" before "Netflix (Group Offer)")', feed.mainServiceFor('Netflix', services) === 'Netflix' && feed.mainServiceFor('Prime Video', services) === 'Prime Video' && feed.mainServiceFor('SonyLIV', services) === 'SonyLiv Premium' && feed.mainServiceFor('Hulu', services) === '');
  let v = feed.validate({ type: 'movie', title: 'Front of the Class', service: 'Netflix (Group Offer)' });
  ok('old client (service only): ctaService = service, brand derived, service kept in step', v.ok && v.post.ctaService === 'Netflix (Group Offer)' && v.post.brand === 'Netflix' && v.post.service === 'Netflix (Group Offer)' && v.post.cta === 'service');
  v = feed.validate({ type: 'movie', title: 'X', brand: 'netflix', ctaService: 'Netflix (Group Offer)', service: 'Netflix' });
  ok('brand + ctaService: brand canonical ("netflix" → Netflix), ctaService wins over service', v.ok && v.post.brand === 'Netflix' && v.post.ctaService === 'Netflix (Group Offer)' && v.post.service === 'Netflix (Group Offer)');
  v = feed.validate({ type: 'movie', title: 'X', brand: 'Netflix', ctaService: '' });
  ok('brand without a plan: allowed, no buy button', v.ok && v.post.cta === 'none' && v.post.brand === 'Netflix');
  ok('movie with neither brand nor plan → "Pick the platform"', /platform/.test(feed.validate({ type: 'movie', title: 'X' }).errors.join()));
  ok('brand text cleaned (< > stripped, 40 chars)', feed.validate({ type: 'movie', title: 'X', brand: '<b>' + 'M'.repeat(60) }).post.brand === 'b' + 'M'.repeat(39));
  // migration of existing posts
  settings.feed_posts = JSON.stringify([
    { id: 'fp111111111a', type: 'movie', title: 'Old Group', service: 'Netflix (Group Offer)', active: true, cta: 'service', createdAt: new Date(Date.now() - 3 * 86400e3).toISOString(), genres: ['Drama'] },
    { id: 'fp111111111b', type: 'series', title: 'Old Prime', service: 'Prime Video + Shopping', active: true, cta: 'service', source: 'tmdb', tmdbKey: 'tv:77', edited: false, createdAt: new Date(Date.now() - 40 * 86400e3).toISOString(), genres: ['Comedy', 'Drama'], languages: ['English'], caption: 'A funny office show', releaseDate: '2026-08-01', imageUrl: 'https://image.tmdb.org/t/p/w780/op.jpg', trailerUrl: '', instagramUrl: '', pinned: false, publishAt: '', hideAfter: '' },
    { id: 'fp111111111c', type: 'announcement', title: 'News', service: '', active: true, cta: 'none', createdAt: new Date().toISOString() },
  ]);
  let items = await feed.list();
  ok('migration: old posts read with brand = normalised service, ctaService = service', items[0].brand === 'Netflix' && items[0].ctaService === 'Netflix (Group Offer)' && items[1].brand === 'Prime Video' && items[1].ctaService === 'Prime Video + Shopping' && items[2].brand === '' && items[2].ctaService === '');
  let r = await feed.save(Object.assign({}, items[1], { pinned: true }));
  ok('migration: re-saving an imported post (pin only) does not mark it edited', r.ok && r.post.edited === false && r.post.brand === 'Prime Video');
  r = await feed.save(Object.assign({}, r.post, { brand: 'Netflix' }));
  ok('changing the brand of an imported post = owner edit', r.ok && r.post.edited === true);
  feed._internal.reset();
  let pub = await feed.publicList();
  const pg = pub.posts.find((x) => x.id === 'fp111111111a');
  ok('public post: brand, ctaService (service = ctaService), comments count 0 before schema, no sourceCaption', pg.brand === 'Netflix' && pg.ctaService === 'Netflix (Group Offer)' && pg.service === 'Netflix (Group Offer)' && pg.comments === 0 && !('sourceCaption' in pg) && !('hasThumb' in pg));
  const info = await feed.catalogServiceInfo();
  ok('catalog service info: cheapest live price + https logo per service, brand', JSON.stringify(info.find((x) => x.service === 'Netflix (Group Offer)')) === JSON.stringify({ service: 'Netflix (Group Offer)', brand: 'Netflix', minPrice: 99, logoUrl: 'https://cdn.example/other.jpg' }) && info.find((x) => x.service === 'SonyLiv Premium').brand === 'SonyLIV');
  const d = feed.draftFrom({ id: 3, title: 'T', release_date: '2026-09-01', poster_path: '/a.jpg' }, 'movie', 'Netflix', null);
  ok('TMDB drafts carry brand + ctaService', d.brand === 'Netflix' && d.ctaService === 'Netflix');

  // admin + storefront copies of brandOf = server rule
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const aStart = admin.indexOf('var FD_BRAND_RE = '); const aEnd = admin.indexOf('function fdBrandOpts(');
  const fdBrandOf = new Function(admin.slice(aStart, aEnd) + '; return fdBrandOf;')();
  ok('admin editor brand rule = server rule', brandCases.every(([i]) => fdBrandOf(i) === B(i)), brandCases.filter(([i]) => fdBrandOf(i) !== B(i)).map(([i]) => [i, fdBrandOf(i), B(i)]));
  const sStart = html.indexOf('const FEED_BRANDS_ = '); const sEnd = html.indexOf('function feedWhen_(');
  const S = new Function(html.slice(sStart, sEnd) + '; return { feedBrandOf_, feedBrandInfo_, feedFilter_, feedGenres_, feedBrands_ };')();
  const knownBrands = brandCases.filter(([, o]) => feed.BRANDS.some((b) => b.name === o));
  ok('storefront brand rule = server rule for every known brand', knownBrands.every(([i]) => S.feedBrandOf_(i) === B(i)), knownBrands.filter(([i]) => S.feedBrandOf_(i) !== B(i)));
  const bootPlans = [{ service: 'Netflix (Group Offer)', logoUrl: 'https://cdn.example/other.jpg' }, { service: 'Netflix', logoUrl: 'https://cdn.example/netflix.png' }, { service: 'Zee5 Premium', logoUrl: 'javascript:alert(1)' }];
  ok('header logo = the brand\'s MAIN plan logo from the catalog (not the Group Offer picture); emoji fallback; no unsafe logo', S.feedBrandInfo_('Netflix', bootPlans).logoUrl === 'https://cdn.example/netflix.png' && S.feedBrandInfo_('Zee5', bootPlans).logoUrl === '' && S.feedBrandInfo_('Zee5', bootPlans).emoji === '🟣' && S.feedBrandInfo_('Hoichoi', bootPlans).emoji === '');
  ok('post header uses brandInfo (name + logo), CTA still sells info.service with "Streaming on <brand>"', /brandInfo: feedBrandInfo_\(feedPostBrand_\(p\), plans\)/.test(html) && /const name = bi\.name;/.test(html) && /'Get ' \+ info\.service \+ ' from ₹' \+ info\.price/.test(html) && /'Streaming on ' \+ name/.test(html) && /const info = p\.cta === 'service' \? feedServiceInfo_\(plan, plans\) : null;/.test(html));
  ok('admin editor: brand dropdown + "Sell button uses plan:" with live cheapest price', /data-k="brand"/.test(admin) && /Sell button uses plan:<select class="inp" data-k="ctaService">/.test(admin) && /' — from ₹' \+ x\.minPrice/.test(admin) && /function fdMainPlan\(/.test(admin));

  // ================= 🔎 filters + search =================
  const now = Date.parse('2026-09-15T12:00:00+05:30');
  const P = (id, o) => Object.assign({ id, title: 'T' + id, brand: 'Netflix', service: 'Netflix', genres: [], languages: [], caption: '', date: new Date(now - 86400e3).toISOString() }, o);
  const posts = [
    P('a', { title: 'Front of the Class', ctaService: 'Netflix (Group Offer)', genres: ['Drama', 'Biography'], caption: 'Brad Cohen and Tourette syndrome', date: new Date(now - 2 * 86400e3).toISOString() }),
    P('b', { title: 'Reacher', brand: 'Prime Video', service: 'Prime Video', genres: ['Action', 'Crime'], languages: ['English'], date: new Date(now - 10 * 86400e3).toISOString() }),
    P('c', { title: 'Mirzapur', brand: 'Prime Video', service: 'Prime Video', genres: ['Crime', 'Drama'], languages: ['Hindi'], caption: 'Kaleen bhaiya is back', date: '2026-08-30T10:00:00.000Z' }),
    P('d', { title: 'Old news', brand: '', service: 'SonyLiv Premium', genres: ['Comedy'], date: '2026-07-01T10:00:00.000Z' }),
  ];
  const ids = (list) => list.map((x) => x.id).join('');
  ok('search matches title, brand, genre, caption, language (case / accents ignored, all words)', ids(S.feedFilter_(posts, { q: 'front' }, now)) === 'a' && ids(S.feedFilter_(posts, { q: 'prime' }, now)) === 'bc' && ids(S.feedFilter_(posts, { q: 'CRIME' }, now)) === 'bc' && ids(S.feedFilter_(posts, { q: 'tourette' }, now)) === 'a' && ids(S.feedFilter_(posts, { q: 'hindi crime' }, now)) === 'c' && ids(S.feedFilter_(posts, { q: 'sonylív' }, now)) === 'd' && ids(S.feedFilter_(posts, { q: '  ' }, now)) === 'abcd');
  ok('genre + platform (brand, not plan) + date filters', ids(S.feedFilter_(posts, { genre: 'Drama' }, now)) === 'ac' && ids(S.feedFilter_(posts, { brand: 'Netflix' }, now)) === 'a' && ids(S.feedFilter_(posts, { brand: 'SonyLIV' }, now)) === 'd' && ids(S.feedFilter_(posts, { date: 'week' }, now)) === 'a' && ids(S.feedFilter_(posts, { date: 'month' }, now)) === 'ab');
  ok('filters combine; nothing matches → empty list', ids(S.feedFilter_(posts, { brand: 'Prime Video', genre: 'Crime', q: 'reach' }, now)) === 'b' && S.feedFilter_(posts, { brand: 'Netflix', genre: 'Crime' }, now).length === 0 && S.feedFilter_(null, {}, now).length === 0);
  ok('chips: genres only present ones (most used first), platforms = brands', S.feedGenres_(posts).join() === 'Crime,Drama,Action,Biography,Comedy' && S.feedBrands_(posts).join() === 'Netflix,Prime Video,SonyLIV');
  ok('feed screen: debounced search box, app / date / genre chips, count + "Clear filters", empty state, genre tap on a post filters, ?post= link still first', /setTimeout\(\(\) => setQuery\(q\), 220\)/.test(html) && /placeholder: "Search title, app, genre…"/.test(html) && /\['week', '🆕 Latest'\], \['month', '📅 This month'\]/.test(html) && /"No posts match"/.test(html) && /"✖ Clear filters"/.test(html) && /onGenre: pickGenre/.test(html) && /const target = pinId && posts\.find\(p => p\.id === pinId\);/.test(html) && /onClick: \(\) => onGenre && onGenre\(genre === g \? '' : g\)/.test(html));
  ok('captions always start clamped to 3 lines with measured "more" / "less"', /className: "ff-feed-cap" \+ \(open \? '' : ' clamp'\)/.test(html) && /setOverflow\(el\.scrollHeight > el\.clientHeight \+ 2\)/.test(html) && /\.ff-feed-cap\.clamp \{ display: -webkit-box; -webkit-line-clamp: 3;/.test(html));
  ok('performance: comments load only when opened; phone widths — search input full width, chips scroll sideways', /talk && React\.createElement\(FeedComments/.test(html) && /\.ff-feed-find input \{ width: 100%; box-sizing: border-box;/.test(html) && /\.ff-feed-chips \{ display: flex; gap: 8px; overflow-x: auto;/.test(html));

  // ================= 📤 share texts + link previews use brand + plan price =================
  const a = html.indexOf('const shareText_ = {'); const b2 = html.indexOf('function copyText_(');
  const TX = new Function(html.slice(a, b2) + '; return shareText_;')();
  const catalog = { plans: [{ service: 'Netflix', plan: 'Sharing 1M', price: 139 }, { service: 'Netflix (Group Offer)', plan: 'Sharing 1M', price: 99 }, { service: 'Netflix (Group Offer)', plan: 'Private 1M', price: 79 }], levels: { 'Netflix (Group Offer)|||Private 1M': { stockLevel: 'OUT' } } };
  const msg = TX.post({ title: 'Front of the Class', type: 'movie', brand: 'Netflix', ctaService: 'Netflix (Group Offer)', service: 'Netflix (Group Offer)' }, null, now, catalog, 'https://shop.fluxfilm.in/?post=fp111111111a').text;
  ok('share text: "Now streaming on *Netflix*" (brand) + Group Offer in-stock price ₹99 (not Netflix ₹139, not out-of-stock ₹79)', /🔴 Now streaming on \*Netflix\*/.test(msg) && /— Netflix \(Group Offer\) from \*₹99\*/.test(msg) && !/₹139|₹79/.test(msg), msg);
  const share = require('../share');
  const meta = share._internal.postMeta({ id: 'fp111111111a', title: 'Front of the Class', type: 'movie', brand: 'Netflix', ctaService: 'Netflix (Group Offer)', service: 'Netflix (Group Offer)', image: '/feed-img/fp111111111at?v=2026' }, [{ name: 'Netflix', minPrice: 139 }, { name: 'Netflix (Group Offer)', minPrice: 99 }], now);
  ok('/?post= preview: "now on Netflix", "Get Netflix (Group Offer) … from ₹99", Instagram thumbnail path accepted as the picture', /now on Netflix$/.test(meta.title) && /Get Netflix \(Group Offer\) on FluxFilm from ₹99/.test(meta.description) && meta.image === 'https://shop.fluxfilm.in/feed-img/fp111111111at?v=2026', meta);

  // ================= 📸 Instagram thumbnails =================
  ok('embed page parsed: cover picture (CDN only, entities decoded) + caption without username / tags markup', (() => { const x = thumbs.parseEmbed(EMBED_HTML); return x.imageUrl === 'https://instagram.flhr14-1.fna.fbcdn.net/v/big.jpg?stp=dst-jpg&_nc_cat=105' && /^🎥: Front of the Class \(2008\) is a biographical drama & true story\./.test(x.caption) && !/us\.silverscreens|<a/.test(x.caption) && /#hopecore/.test(x.caption); })());
  ok('post page parsed: og:image + quoted caption from og:description', (() => { const x = thumbs.parsePage(PAGE_HTML); return x.imageUrl === 'https://scontent.cdninstagram.com/v/small.jpg?stp=s640x640&x=1' && x.caption === 'Front of the Class (2008) page caption'; })());
  ok('only Instagram / Facebook CDN pictures (not an open fetcher)', thumbs.imageHostOk('https://scontent.cdninstagram.com/a.jpg') && thumbs.imageHostOk('https://x.fbcdn.net/a.jpg') && !thumbs.imageHostOk('http://scontent.cdninstagram.com/a.jpg') && !thumbs.imageHostOk('https://cdninstagram.com.evil.com/a.jpg') && !thumbs.imageHostOk('https://evil.com/x.cdninstagram.com.jpg') && !thumbs.imageHostOk('https://127.0.0.1/a.jpg') && !thumbs.imageHostOk('https://user@scontent.cdninstagram.com/a.jpg'));
  ok('parser drops a non-CDN picture', thumbs.parseEmbed('<img class="EmbeddedMediaImage" src="https://evil.example/x.jpg">').imageUrl === '' && thumbs.parsePage('<meta property="og:image" content="https://evil.example/x.jpg">').imageUrl === '');

  // Reel post
  settings.feed_posts = JSON.stringify([]); feed._internal.reset();
  const saved = (await feed.save({ type: 'movie', title: '🎥Front of the class (2008)', brand: 'Netflix', ctaService: 'Netflix (Group Offer)', instagramUrl: REEL + '?igsh=abc', active: true })).post;
  ok('saving a Reel reports the link changed (the admin route then fetches the thumbnail)', saved.instagramUrl === REEL && (await feed.save(Object.assign({}, saved, { pinned: true }))).igChanged === false);
  ig = {}; httpCalls.length = 0;
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  let p = (await feed.list()).find((x) => x.id === saved.id);
  ok('no Meta token: embed page + post page asked; the small (≤120 KB) page picture stored as feed_img_<id>t; caption kept for AI', r.ok && r.thumb === true && r.bytes === 23 * 1024 && r.source === 'page' && !httpCalls.some((c) => /graph\.facebook/.test(c.url)) && /^data:image\/jpeg;base64,/.test(settings['feed_img_' + saved.id + 't']) && p.hasThumb === true && /Front of the Class \(2008\) is a biographical/.test(p.sourceCaption), r);
  ok('smallest good picture used first (page preview 23 KB), the 240 KB cover not downloaded', httpCalls.some((c) => /small\.jpg/.test(c.url)) && !httpCalls.some((c) => /big\.jpg/.test(c.url)));
  ok('requests are time-boxed and ask for plain HTML (no Chrome agent → simple embed page)', httpCalls.every((c) => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 8000) && !/Chrome/.test(httpCalls.find((c) => /embed/.test(c.url)).opts.headers['User-Agent']));
  feed._internal.reset();
  pub = await feed.publicList();
  const pp = pub.posts.find((x) => x.id === saved.id);
  ok('customers get the thumbnail through the shop (/feed-img/<id>t?v=…), never an Instagram picture URL, no caption from Instagram', /^\/feed-img\/fp[0-9a-f]{10}t\?v=/.test(pp.image) && !/instagram|fbcdn/i.test(pp.image) && pp.caption === '' && !/biographical/.test(JSON.stringify(pub)));
  ok('/feed-img/<id>t serves the stored thumbnail', (await feed.image(saved.id + 't')).type === 'image/jpeg');
  // upload beats nothing, thumbnail beats upload
  await feed.setImage(saved.id, 'data:image/png;base64,iVBORw0KGgo=');
  feed._internal.reset();
  ok('picture order: Instagram thumbnail first, then the uploaded picture', /t\?v=/.test((await feed.publicList()).posts.find((x) => x.id === saved.id).image));
  ok('pictureOf: no Reel link → thumbnail ignored', feed.pictureOf({ id: 'fp0000000000', hasThumb: true, hasImage: true, updatedAt: 'x' }, '') === '/feed-img/fp0000000000?v=x');
  // big picture only → stored, admin shrinks
  ig = { pageStatus: 429 }; httpCalls.length = 0;
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  ok('post page rate-limited → the embed cover (240 KB) is kept and reported so the admin page shrinks it to ≤120 KB', r.thumb === true && r.bytes === 240 * 1024 && r.source === 'embed');
  const shrunk = 'data:image/jpeg;base64,' + jpeg(100).toString('base64');
  ok('admin shrunk copy replaces the thumbnail; bad data refused', (await feed.setThumb(saved.id, shrunk)).ok && settings['feed_img_' + saved.id + 't'] === shrunk && !(await feed.setThumb(saved.id, 'data:text/html;base64,PGI+')).ok);
  // everything blocked → uploaded picture stays
  ig = { embedDown: true, pageStatus: 302 };
  const before = settings['feed_img_' + saved.id + 't'];
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  ok('Instagram blocked (timeout + login redirect): old thumbnail kept, clear reason, no throw', r.ok && r.thumb === false && /embed: ETIMEDOUT/.test(r.reason) && /page: HTTP 302/.test(r.reason) && settings['feed_img_' + saved.id + 't'] === before, r);
  await feed.setThumb(saved.id, '');
  feed._internal.reset();
  ok('no thumbnail → uploaded picture shown; message says so', /^\/feed-img\/fp[0-9a-f]{10}\?v=/.test((await feed.publicList()).posts.find((x) => x.id === saved.id).image) && /your picture is used/.test((await feed.refreshThumb(saved.id, { http: fakeHttp })).message));
  // blocked + no picture + TMDB key → poster of the matching title
  await feed.setImage(saved.id, '');
  await feed.saveSettings({ tmdbKey: 'abcdef0123456789abcdef0123456789' });
  tmdbCalls.length = 0;
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  p = (await feed.list()).find((x) => x.id === saved.id);
  ok('blocked + no picture → poster of the matched title (year + exact title beat the more popular wrong one)', r.poster === true && p.imageUrl === 'https://image.tmdb.org/t/p/w780/front.jpg' && tmdbCalls.some((c) => c.pathname === '/3/search/multi' && c.searchParams.get('query') === 'Front of the class'), [r, p.imageUrl]);
  feed._internal.reset();
  const posterImg = (await feed.publicList()).posts.find((x) => x.id === saved.id).image;
  ok('poster fallback served as a neutral /poster/ link (no TMDB in public output)', posterImg === '/poster/w780/front.jpg' && !/tmdb/i.test(JSON.stringify(await feed.publicList())));
  // not a picture / too big
  ig = { embedHtml: '<img class="EmbeddedMediaImage" src="https://x.fbcdn.net/notimage.jpg">', pageStatus: 404 };
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  ok('a login page instead of a picture is refused (magic bytes checked)', r.thumb === false && /not a picture/.test(r.reason), r);
  ok('downloadImage: too big / wrong host refused', /too big/.test((await thumbs.downloadImage('https://x.fbcdn.net/a.jpg', { http: async () => ({ status: 200, body: jpeg(400) }) })).reason) && /not allowed/.test((await thumbs.downloadImage('https://evil.com/a.jpg', { http: fakeHttp })).reason));
  // Meta token → oEmbed first
  const TOKEN = '1234567890123|abcdefabcdefabcdefabcdef';
  r = await feed.saveSettings({ metaToken: TOKEN });
  ok('Meta token saved; never returned to the admin page', r.ok && r.changed.includes('Meta token saved') && r.settings.hasMetaToken === true && !JSON.stringify(r.settings).includes(TOKEN) && !JSON.stringify(feed.publicSettings(await feed.getSettings())).includes('abcdefabcdef'));
  ok('bad Meta token refused', !(await feed.saveSettings({ metaToken: 'x y' })).ok);
  ig = { oembed: { title: 'oEmbed caption: Front of the Class', thumbnail_url: 'https://scontent.cdninstagram.com/v/oembed-thumb.jpg' } }; httpCalls.length = 0;
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  const oe = httpCalls.find((c) => /graph\.facebook\.com/.test(c.url));
  ok('with a Meta token: Graph oEmbed (v19.0, url + access_token, server-side) gives thumbnail + caption; Instagram pages not needed', oe && new URL(oe.url).pathname === '/v19.0/instagram_oembed' && new URL(oe.url).searchParams.get('access_token') === TOKEN && new URL(oe.url).searchParams.get('url') === REEL && r.thumb && r.source === 'oembed' && (await feed.list()).find((x) => x.id === saved.id).sourceCaption === 'oEmbed caption: Front of the Class' && !httpCalls.some((c) => /instagram\.com\/reel/.test(c.url)), r);
  ig = { oembed: { title: 'Only a caption' } }; httpCalls.length = 0;
  r = await feed.refreshThumb(saved.id, { http: fakeHttp });
  ok('oEmbed without thumbnail_url (Meta removed it for some apps) → embed / page pictures still tried', r.thumb && httpCalls.some((c) => /embed\/captioned/.test(c.url)));
  await feed.saveSettings({ clearMetaToken: true });
  ok('Meta token removable', (await feed.getSettings()).metaToken === '');
  const s2 = await feed.save(Object.assign({}, (await feed.list()).find((x) => x.id === saved.id), { instagramUrl: 'https://www.instagram.com/reel/C9xYz_12-ab/' }));
  ok('changing the Reel link drops the old thumbnail + old Reel caption', s2.igChanged === true && s2.post.hasThumb === false && s2.post.sourceCaption === '' && settings['feed_img_' + saved.id + 't'] === undefined);
  ok('refresh on a post without a Reel / unknown post → clear error', !(await feed.refreshThumb('fpffffffffff', { http: fakeHttp })).ok && !(await feed.refreshThumb((await feed.save({ type: 'movie', title: 'No reel', brand: 'Netflix' })).post.id, { http: fakeHttp })).ok);
  ok('deleting a post deletes its thumbnail too', await (async () => { await feed.setThumb(saved.id, shrunk); await feed.remove(saved.id); return settings['feed_img_' + saved.id + 't'] === undefined; })());

  // ================= ✨ AI fill =================
  const fakeFeed = { LANGS: feed.LANGS, getSettings: feed.getSettings, searchTitle: feed.searchTitle, tmdbMatch: feed.tmdbMatch };
  const SRC = '🎥: Front of the Class (2008) is a biographical drama based on the true story of Brad Cohen, a man born with Tourette syndrome. Contact 9876543210 #hopecore #mindset';
  let asked = null;
  const model = async (msgs) => { asked = msgs; return { json: { title: 'Front of the Class', caption: 'Brad ki kahani 💪 — Tourette syndrome ke saath teacher banne ka sapna. Must watch! #inspiring #hopecore call 98765 43210 www.x.com @us.silverscreens', genres: ['Drama', 'Biography', 'Superhero', 'Thriller'], languages: ['English', 'Klingon'], type: 'movie', releaseDate: '1999-01-01' }, tokens: 321 }; };
  r = await feedai.aiFill({ title: '🎥Front of the class (2008)', sourceCaption: SRC, type: 'movie' }, { feed: fakeFeed, model });
  const f = r.fields;
  ok('AI fill uses the Reel caption; result is only suggested (nothing saved)', r.ok && r.ai && r.tokens === 321 && /Brad Cohen/.test(asked[1].content) && JSON.stringify(await feed.list()).indexOf('Brad ki kahani') < 0);
  ok('AI caption cleaned: no hashtags, phone numbers, links, @handles; ≤ 300 characters; Hinglish kept', f.caption && !/#|98765|www\.|@us/.test(f.caption) && f.caption.length <= 300 && /Brad ki kahani/.test(f.caption), f.caption);
  ok('TMDB decides the facts: title, genres (mapped to the fixed list), release date, poster, trailer; the AI\'s date ignored', f.title === 'Front of the Class' && f.genres.join() === 'Drama,Action,Adventure' && f.releaseDate === '2008-12-07' && f.imageUrl === 'https://image.tmdb.org/t/p/w780/front.jpg' && f.trailerUrl === 'https://www.youtube.com/watch?v=abcdefghijk' && r.tmdb === true, f);
  ok('languages only from the known list', f.languages.join() === 'English');
  ok('prompt: fixed genre list, no hashtags / personal data rules, JSON answer', /ONLY from: Action, Adventure/.test(asked[0].content) && /NO hashtags/.test(asked[0].content) && /NO phone numbers/.test(asked[0].content) && /"caption"/.test(asked[0].content));
  r = await feedai.aiFill({ title: 'Front of the Class', caption: '' }, { feed: fakeFeed, model: null });
  ok('no AI key → TMDB-only fill + "Add an AI key in settings for captions"', r.ok && !r.ai && r.fields.releaseDate === '2008-12-07' && r.notes.some((n) => /Add an AI key in settings for captions/.test(n)));
  r = await feedai.aiFill({ title: 'Front of the Class' }, { feed: fakeFeed, model: async () => null });
  ok('AI down → friendly note, TMDB still fills', r.ok && !r.ai && r.notes.some((n) => /did not answer/.test(n)) && r.fields.genres.length > 0);
  r = await feedai.aiFill({ title: 'zzqx unknown' }, { feed: fakeFeed, model: async () => ({ json: { caption: 'A fun watch', genres: ['Comedy'] }, tokens: 10 }) });
  ok('title not found → no date / poster invented, note to check the title; AI genres kept', r.ok && !r.fields.releaseDate && !r.fields.imageUrl && r.fields.genres.join() === 'Comedy' && r.notes.some((n) => /Could not find this title/.test(n)));
  r = await feedai.aiFill({ title: 'x' }, { feed: fakeFeed, model: async () => ({ json: { caption: 'what a chutiya movie' }, tokens: 5 }) });
  ok('abusive AI caption dropped', !r.fields.caption && r.notes.some((n) => /not safe/.test(n)));
  ok('nothing to work from → message', !(await feedai.aiFill({}, { feed: fakeFeed, model })).ok);
  await feed.saveSettings({ clearKey: true });
  r = await feedai.aiFill({ title: 'Front of the Class' }, { feed: fakeFeed, model: null });
  ok('no TMDB key either → notes for both keys, no crash', r.ok && r.notes.length === 2 && Object.keys(r.fields).length === 0);

  // ================= admin routes =================
  const routes = {}; const audits = [];
  const app = { get: (pp2, fn) => { routes['GET ' + pp2] = fn; }, post: (pp2, fn) => { routes['POST ' + pp2] = fn; } };
  const feedForAdmin = Object.assign({}, feed, { refreshThumb: (id, o) => feed.refreshThumb(id, Object.assign({}, o, { http: fakeHttp })) });
  let aiCalls = 0;
  require('../adminfeed').mount(app, { auth: () => true, audit: { record: (q, x) => audits.push(x) }, feed: feedForAdmin, comments: { adminList: async () => ({ ready: false, counts: {}, byPost: {} }) }, ai: { aiFill: async () => { aiCalls++; return { ok: true, fields: { caption: 'x' }, tokens: 3, notes: [] }; } } });
  const call = (m, pp2, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; Promise.resolve(routes[m + ' ' + pp2]({ body, query: {} }, res)); });
  ig = {};
  let x = await call('POST', '/admin/api/feed/save', { type: 'movie', title: 'Reel post', brand: 'Netflix', ctaService: 'Netflix (Group Offer)', instagramUrl: REEL, active: true });
  ok('admin save with a new Reel link fetches the thumbnail right away and returns it', x.body.ok && x.body.thumb && x.body.thumb.thumb === true && x.body.post.hasThumb === true && /Netflix → Netflix \(Group Offer\)/.test(audits.pop().summary), x.body);
  x = await call('POST', '/admin/api/feed/thumb/refresh', { id: x.body.post.id });
  ok('🔄 Refresh thumbnail route + change log', x.body.ok && x.body.thumb === true && x.body.post && audits.some((l) => l.action === 'feed.thumb'));
  x = await call('GET', '/admin/api/feed');
  ok('admin list: serviceInfo with prices, brands, comments ready flag; no Meta / TMDB key', x.body.ok && x.body.serviceInfo.find((s) => s.service === 'Netflix (Group Offer)').minPrice === 99 && x.body.brands.some((bb) => bb.name === 'SonyLIV') && x.body.commentsReady === false && !/abcdefabcdef/.test(JSON.stringify(x.body)));
  for (let i = 0; i < 20; i++) await call('POST', '/admin/api/feed/ai-fill', { title: 'x' });
  x = await call('POST', '/admin/api/feed/ai-fill', { title: 'x' });
  ok('✨ AI fill is rate-limited (20 per 10 minutes)', x.code === 429 && aiCalls === 20);
  ok('admin page: ✨ AI fill fills the form for review (never saves), 🔄 Refresh thumbnail, big thumbnails shrunk ≤120 KB, Meta token setting with help, AI key status', /id="fdai"/.test(admin) && /\/admin\/api\/feed\/ai-fill/.test(admin) && /Check the ✨ suggestions, then 💾 Save/.test(admin) && /id="fdthumb"/.test(admin) && /\/admin\/api\/feed\/thumb\/refresh/.test(admin) && /var FD_THUMB_MAX = 120 \* 1024;/.test(admin) && /id="fdmeta" type="password" autocomplete="off"/.test(admin) && /App ID\|App secret/.test(admin) && /DEEPSEEK_API_KEY/.test(admin));
  ok('Olivia\'s DeepSeek adapter reused (exported, token limit option), no new AI provider', typeof require('../oliviawords').callModel === 'function' && /require\('\.\/oliviawords'\)\.callModel/.test(fs.readFileSync(path.join(ROOT, 'feedai.js'), 'utf8')) && !/openai|anthropic|gemini/i.test(fs.readFileSync(path.join(ROOT, 'feedai.js'), 'utf8')));

  // ================= #78: TMDB still not visible publicly =================
  const pubAll = JSON.stringify(await feed.publicList());
  ok('public feed output never mentions TMDB (posters /poster/, thumbnails /feed-img/)', !/tmdb/i.test(pubAll));
  ok('storefront + /whats-new keep no TMDB credit', !/not endorsed or certified by TMDB/.test(html) && !/TMDB/.test(fs.readFileSync(path.join(ROOT, 'seo.js'), 'utf8').split('async function aboutPage')[0].split('function whatsNewPage')[1] || ''));

  console.log('\n---------------------------------------');
  console.log('feed-v3: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
