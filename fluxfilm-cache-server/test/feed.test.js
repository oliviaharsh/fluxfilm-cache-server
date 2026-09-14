/* 🍿 What's new feed (feed.js, adminfeed.js, storefront + admin). TMDB is mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const settings = {};
let writes = 0;
let plans = [
  { service: 'Netflix', is_active: 'TRUE', raw_json: '{}' },
  { service: 'Netflix (Group Offer)', is_active: null, raw_json: JSON.stringify({ IsActive: 'TRUE' }) },
  { service: 'Crunchyroll', is_active: 'TRUE', raw_json: '{}' },
  { service: 'Zee5 Premium', is_active: 'FALSE', raw_json: '{}' },
];
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { writes++; settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(sql)) { delete settings[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT service, is_active, raw_json FROM plans$/.test(sql)) return plans;
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const feed = require('../feed');

// ---- fake TMDB ----
const calls = [];
let tmdbDown = false; let tmdbStatus = 200;
const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
const row = (id, title, o) => Object.assign({ id, title, overview: 'A made-up story about ' + title + '.', release_date: day(-3), poster_path: '/p' + id + '.jpg', genre_ids: [28, 18], original_language: 'hi', popularity: 50, vote_count: 40 }, o || {});
const tvrow = (id, name, o) => Object.assign({ id, name, overview: 'A made-up series ' + name + '.', first_air_date: day(-10), poster_path: '/t' + id + '.jpg', genre_ids: [18], original_language: 'en', popularity: 30, vote_count: 20 }, o || {});
let discoverMovies = { 8: [row(101, 'Moonlit Heist', { popularity: 90 }), row(102, 'Paper Kites', { popularity: 70 }), row(103, 'No Poster Film', { poster_path: null, popularity: 60 }), row(104, 'Quiet Pond', { popularity: 1 }), row(105, 'Lonely Vote', { vote_count: 1 })], 283: [row(201, 'Sky Blade', { original_language: 'ja', popularity: 40 })] };
let discoverTv = { 8: [tvrow(301, 'Harbour Lights', { popularity: 80 })], 283: [] };
async function fakeFetch(url, opts) {
  const u = new URL(url);
  calls.push({ url: u, headers: (opts && opts.headers) || {} });
  if (tmdbDown) throw new Error('ECONNREFUSED');
  const res = (body, status) => ({ ok: (status || tmdbStatus) < 400, status: status || tmdbStatus, json: async () => body });
  const p = u.pathname.replace('/3', '');
  if (p === '/genre/movie/list') return res({ genres: [{ id: 28, name: 'Action' }, { id: 18, name: 'Drama' }] });
  if (p === '/genre/tv/list') return res({ genres: [{ id: 18, name: 'Drama' }] });
  if (p === '/discover/movie') { const ids = u.searchParams.get('with_watch_providers').split('|'); return res({ results: ids.flatMap((i) => discoverMovies[i] || []) }); }
  if (p === '/discover/tv') { const ids = u.searchParams.get('with_watch_providers').split('|'); return res({ results: ids.flatMap((i) => discoverTv[i] || []) }); }
  if (p === '/search/multi') return res({ results: [Object.assign(row(101, 'Moonlit Heist'), { media_type: 'movie' }), Object.assign(tvrow(301, 'Harbour Lights'), { media_type: 'tv' }), { id: 9, media_type: 'person', name: 'Someone' }] });
  let m = p.match(/^\/(movie|tv)\/(\d+)$/);
  if (m) {
    const all = Object.values(m[1] === 'movie' ? discoverMovies : discoverTv).flat();
    const r = all.find((x) => String(x.id) === m[2]) || row(+m[2], 'Detail ' + m[2]);
    return res(Object.assign({}, r, { genre_ids: undefined, genres: [{ id: 28, name: 'Action' }, { id: 53, name: 'Thriller' }], videos: { results: [{ site: 'YouTube', type: 'Teaser', key: 'teaser12345' }, { site: 'YouTube', type: 'Trailer', key: 'trail_er-01' }, { site: 'Vimeo', type: 'Trailer', key: 'x' }] } }));
  }
  if (p === '/watch/providers/movie') return res({ results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 2336, provider_name: 'JioHotstar' }] });
  return res({}, 404);
}
feed._internal.setFetch(fakeFetch);

(async () => {
  const now = Date.now(); const iso = (min) => new Date(now + min * 60000).toISOString();

  // ---- validation ----
  let v = feed.validate({ type: 'movie', title: '', service: '' });
  ok('needs a title and (for movies / series) a platform', !v.ok && /title/.test(v.errors.join()) && /platform/.test(v.errors.join()));
  ok('news posts need no platform and get no buy button', (v = feed.validate({ type: 'announcement', title: 'New plans soon', cta: 'service' })).ok && v.post.cta === 'none');
  v = feed.validate({ title: 'X <b>', service: 'Netflix', imageUrl: 'https://evil.example.com/a.jpg', trailerUrl: 'javascript:alert(1)' });
  ok('picture links only from allowed hosts, trailer only https YouTube, < > stripped', !v.ok && /Picture link/.test(v.errors.join()) && /YouTube/.test(v.errors.join()) && v.post.title === 'X b');
  ok('http (not https) YouTube refused; youtu.be accepted', !feed.validate({ title: 'a', service: 'N', trailerUrl: 'http://youtube.com/watch?v=1' }).ok && feed.validate({ title: 'a', service: 'N', trailerUrl: 'https://youtu.be/abc', imageUrl: 'https://image.tmdb.org/t/p/w780/x.jpg' }).ok);
  v = feed.validate({ title: 'a', service: 'N', caption: 'line one\r\nline two\n\n\n\nfar <script>' + 'x'.repeat(700), languages: 'Hindi, hindi, English', genres: ['Drama', '', 'Thriller'] });
  ok('caption keeps line breaks, max 600; tags deduped', v.ok && v.post.caption.startsWith('line one\nline two\n\nfar script') && v.post.caption.length === 600 && v.post.languages.join() === 'Hindi,English' && v.post.genres.join() === 'Drama,Thriller');
  ok('admin datetime is India time; hide must be after publish', feed.toIso('2026-09-30T23:59') === '2026-09-30T18:29:00.000Z' && !feed.validate({ title: 'a', service: 'N', publishAt: '2026-10-02T10:00', hideAfter: '2026-10-01T10:00' }).ok);

  // ---- save / status / public list ----
  let r = await feed.save({ type: 'movie', title: 'Old Pinned', service: 'Netflix', active: true, pinned: true, publishAt: iso(-60 * 48) });
  ok('create post', r.ok && r.created && /^fp[0-9a-f]{10}$/.test(r.post.id));
  const pinned = r.post;
  const newest = (await feed.save({ type: 'series', title: 'Newest Show', service: 'Netflix', active: true, publishAt: iso(-5), caption: 'hi' })).post;
  await feed.save({ type: 'movie', title: 'Middle', service: 'Crunchyroll', active: true, publishAt: iso(-60) });
  await feed.save({ type: 'movie', title: 'Later', service: 'Netflix', active: true, publishAt: iso(60) });
  await feed.save({ type: 'movie', title: 'Gone', service: 'Netflix', active: true, publishAt: iso(-600), hideAfter: iso(-1) });
  await feed.save({ type: 'movie', title: 'Draft', service: 'Netflix', active: false });
  const all = await feed.list();
  ok('statuses: LIVE / SCHEDULED / HIDDEN / OFF', ['Newest Show', 'Later', 'Gone', 'Draft'].map((t) => feed.statusOf(all.find((p) => p.title === t))).join() === 'LIVE,SCHEDULED,HIDDEN,OFF');
  feed._internal.reset();
  let pub = await feed.publicList();
  ok('customers get LIVE posts only: pinned first, then newest', pub.posts.map((p) => p.title).join('|') === 'Old Pinned|Newest Show|Middle', pub.posts.map((p) => p.title));
  ok('no admin fields in the public list', pub.posts.every((p) => !('active' in p) && !('publishAt' in p) && !('hideAfter' in p) && !('tmdbKey' in p) && !('edited' in p)) && pub.tmdb === false);
  ok('scheduled post goes live by itself', (await feed.publicList(new Date(now + 2 * 3600e3))).posts.some((p) => p.title === 'Later'));
  ok('unknown id cannot be "updated" into a new post', !(await feed.save({ id: 'fpdeadbeef00', title: 'x', service: 'N' })).ok);
  writes = 0;
  await feed.publicList(); await feed.publicList();
  ok('public list cached (no reads per visitor after the first)', writes === 0);

  // ---- picture ----
  ok('picture must be an image; save first', !(await feed.setImage(newest.id, 'data:text/html;base64,PGI+')).ok && !(await feed.setImage('fpnope', 'data:image/png;base64,iVBORw0KGgo=')).ok);
  r = await feed.setImage(newest.id, 'data:image/png;base64,iVBORw0KGgo=');
  const img = await feed.image(newest.id);
  feed._internal.reset(); pub = await feed.publicList();
  ok('uploaded picture served as binary with a cache-busting URL', r.ok && img.type === 'image/png' && img.buf.length === 8 && /^\/feed-img\/fp[0-9a-f]+\?v=/.test(pub.posts.find((p) => p.id === newest.id).image));
  ok('image id is sanitised', (await feed.image('../x')) === null);

  // ---- views / likes / clicks ----
  writes = 0;
  for (let i = 0; i < 12; i++) feed.record(newest.id, 'view');
  feed.record(newest.id, 'like', 'devA'); feed.record(newest.id, 'like', 'devA'); feed.record(newest.id, 'like', 'devB');
  feed.record(newest.id, 'unlike', 'devB'); feed.record(newest.id, 'unlike', 'devC');
  feed.record(newest.id, 'like', ''); feed.record(newest.id, 'click'); feed.record(newest.id, 'share'); feed.record(newest.id, 'hack'); feed.record('bad id!', 'view');
  let st = await feed.stats();
  ok('like counts once per device; unlike only undoes that device; like needs a device id', st[newest.id].likes === 1 && st[newest.id].views === 12 && st[newest.id].clicks === 1 && st[newest.id].shares === 1);
  ok('events buffered — no database write per event', writes === 0);
  await feed.flushStats();
  ok('flushed in one write', writes === 1 && JSON.parse(settings.feed_stats)[newest.id].likes === 1);
  feed._internal.reset(); pub = await feed.publicList();
  ok('like count shown to customers', pub.posts.find((p) => p.id === newest.id).likes === 1);
  ok('ticker fallback lists newest feed titles', (await feed.trendingLines())[0] === '🍿 Old Pinned on Netflix');

  // ---- settings ----
  let s1 = await feed.getSettings();
  ok('defaults: auto-publish ON, 5 per day, hide after 30 days, Hindi + English + regional languages', s1.autoPublish === true && s1.maxPerDay === 5 && s1.autoHideDays === 30 && ['hi', 'en', 'ta', 'te'].every((l) => s1.languages.includes(l)) && !s1.languages.includes('ko'));
  ok('bad key refused', !(await feed.saveSettings({ tmdbKey: 'short key!' })).ok);
  const V3 = 'abcdef0123456789abcdef0123456789';
  r = await feed.saveSettings({ tmdbKey: V3 });
  ok('key saved; never returned to the admin page', r.ok && r.changed.includes('TMDB key saved') && r.settings.hasKey === true && !JSON.stringify(r.settings).includes(V3));
  ok('provider ids documented for the main platforms', feed.DEFAULT_PROVIDERS.netflix === '8' && feed.DEFAULT_PROVIDERS.prime === '119' && /2336/.test(feed.DEFAULT_PROVIDERS.hotstar) && feed.DEFAULT_PROVIDERS.sony === '237' && feed.DEFAULT_PROVIDERS.zee5 === '232' && feed.DEFAULT_PROVIDERS.crunchyroll === '283');
  ok('catalog platforms = active services only', (await feed.catalogServices()).join() === 'Crunchyroll,Netflix,Netflix (Group Offer)');

  // ---- TMDB search / create ----
  calls.length = 0;
  r = await feed.tmdbSearch('moon');
  ok('v3 key sent as api_key (no header)', calls.some((c) => c.url.pathname === '/3/search/multi' && c.url.searchParams.get('api_key') === V3 && !c.headers.Authorization));
  ok('search: movies + series only, poster from image.tmdb.org, genres named', r.ok && r.results.length === 2 && r.results[0].imageUrl === 'https://image.tmdb.org/t/p/w780/p101.jpg' && r.results[0].genres.join() === 'Action,Drama' && r.results[1].type === 'series' && r.results[0].languages[0] === 'Hindi');
  r = await feed.tmdbCreate('movie:102', 'Netflix', false);
  ok('create from TMDB: draft (OFF), YouTube trailer, full genres, hides after 30 days', r.ok && r.post.active === false && r.post.trailerUrl === 'https://www.youtube.com/watch?v=trail_er-01' && r.post.genres.join() === 'Action,Thriller' && r.post.source === 'tmdb' && Math.round((Date.parse(r.post.hideAfter) - now) / 86400e3) === 30);
  ok('same title cannot be added twice', !(await feed.tmdbCreate('movie:102', 'Netflix', true)).ok);
  const V4 = 'eyJ' + 'a'.repeat(120);
  await feed.saveSettings({ tmdbKey: V4 }); calls.length = 0;
  await feed.tmdbProviders();
  ok('v4 read token sent as Bearer header (not in the URL)', calls.length === 1 && calls[0].headers.Authorization === 'Bearer ' + V4 && !calls[0].url.searchParams.get('api_key'));
  tmdbStatus = 401;
  let err = ''; try { await feed.tmdbSearch('moon'); } catch (e) { err = e.message; }
  ok('rejected key gives a clear message', /did not accept the key/.test(err));
  tmdbStatus = 200;
  await feed.saveSettings({ tmdbKey: V3 });

  // ---- automatic import ----
  const job = () => JSON.parse(settings.feed_job || '{}');
  await feed.saveSettings({ clearKey: true }); calls.length = 0;
  r = await feed.runImport({ force: true });
  ok('no key: import does nothing, no TMDB call', r.ok && r.skipped === 'no-key' && calls.length === 0);
  await feed.saveSettings({ tmdbKey: V3, maxPerDay: 2 });
  calls.length = 0;
  r = await feed.runImport({ force: true });
  const imported = (await feed.list()).filter((p) => p.importedAt && p.tmdbKey !== 'movie:102');
  ok('import: most popular first, daily cap 2, published (auto-publish ON)', r.ok && r.result.imported === 2 && r.result.published === 2 && imported.map((p) => p.title).sort().join() === 'Harbour Lights,Moonlit Heist', imported.map((p) => p.title));
  ok('imported post: poster, story caption, genres, language, release date, Get-platform button, not pinned', (() => { const p = imported.find((x) => x.title === 'Moonlit Heist'); return p && p.imageUrl === 'https://image.tmdb.org/t/p/w780/p101.jpg' && /made-up story/.test(p.caption) && p.genres.length > 0 && p.languages[0] === 'Hindi' && p.releaseDate === day(-3) && p.cta === 'service' && p.service === 'Netflix' && p.pinned === false && p.active === true; })());
  ok('auto-hide: imported posts hide after 30 days', imported.every((p) => Math.round((Date.parse(p.hideAfter) - now) / 86400e3) === 30));
  const discUrls = calls.filter((c) => /discover/.test(c.url.pathname));
  ok('discover: India, flatrate, platform provider ids, languages + min votes', discUrls.length === 4 && discUrls.every((c) => c.url.searchParams.get('watch_region') === 'IN' && c.url.searchParams.get('with_watch_monetization_types') === 'flatrate') && discUrls.some((c) => c.url.searchParams.get('with_watch_providers') === '8' && /^hi\|en/.test(c.url.searchParams.get('with_original_language')) && c.url.searchParams.get('vote_count.gte') === '5'));
  ok('Netflix and "Netflix (Group Offer)" share provider 8: asked once; Crunchyroll has no language filter', discUrls.filter((c) => c.url.searchParams.get('with_watch_providers') === '8').length === 2 && discUrls.filter((c) => c.url.searchParams.get('with_watch_providers') === '283').every((c) => !c.url.searchParams.get('with_original_language')));
  ok('low popularity / few votes / no poster are skipped', !(await feed.list()).some((p) => /Quiet Pond|Lonely Vote|No Poster/.test(p.title)));
  ok('job status: last run, next run, counts, today', job().lastRun && job().nextRun && job().lastResult.imported === 2 && (await feed.jobStatus()).today === 2 && job().lastError === '');
  r = await feed.runImport({ force: true });
  ok('daily cap reached: nothing more today', r.ok && r.result.imported === 0 && (await feed.list()).filter((p) => p.importedAt).length === 3);
  r = await feed.runImport({});
  ok('scheduled run waits 6 hours after the last run', r.skipped === 'not-due');

  // dedupe + edited post never overwritten + unedited refreshed
  const heist = (await feed.list()).find((p) => p.title === 'Moonlit Heist');
  const harbour = (await feed.list()).find((p) => p.title === 'Harbour Lights');
  await feed.save(Object.assign({}, heist, { caption: 'Owner wrote this caption.' }));
  await feed.save(Object.assign({}, harbour, { pinned: true })); // pin / on-off is not an edit
  ok('editing words marks an imported post edited; pinning does not', (await feed.list()).find((p) => p.id === heist.id).edited === true && (await feed.list()).find((p) => p.id === harbour.id).edited === false);
  discoverMovies[8][0] = row(101, 'Moonlit Heist', { popularity: 95, overview: 'TMDB changed the story.', poster_path: '/new101.jpg' });
  discoverTv[8][0] = tvrow(301, 'Harbour Lights', { popularity: 85, overview: 'Updated series story.' });
  const j0 = job(); j0.day = '2000-01-01'; settings.feed_job = JSON.stringify(j0); // new day → cap resets
  await feed.saveSettings({ maxPerDay: 5 });
  r = await feed.runImport({ force: true });
  const after = await feed.list();
  ok('edited imported post is never overwritten', after.find((p) => p.id === heist.id).caption === 'Owner wrote this caption.' && after.find((p) => p.id === heist.id).imageUrl.endsWith('/p101.jpg'));
  ok('unedited imported post gets the new story; pin kept', /Updated series story/.test(after.find((p) => p.id === harbour.id).caption) && after.find((p) => p.id === harbour.id).pinned === true && r.result.refreshed === 1);
  ok('dedupe by TMDB type+id: no duplicates', new Set(after.filter((p) => p.tmdbKey).map((p) => p.tmdbKey)).size === after.filter((p) => p.tmdbKey).length);
  const sky = after.find((p) => p.title === 'Sky Blade');
  ok('anime platform imported without the language filter', !!sky && sky.service === 'Crunchyroll');
  await feed.remove(sky.id);
  const j1 = job(); j1.day = '2000-01-01'; settings.feed_job = JSON.stringify(j1);
  await feed.runImport({ force: true });
  ok('a post the owner deleted is not imported again', !(await feed.list()).some((p) => p.title === 'Sky Blade'));

  // auto-publish off → drafts
  await feed.saveSettings({ autoPublish: false });
  discoverMovies[8].push(row(106, 'Glass River', { popularity: 99 }));
  const j2 = job(); j2.day = '2000-01-01'; settings.feed_job = JSON.stringify(j2);
  r = await feed.runImport({ force: true });
  const glass = (await feed.list()).find((p) => p.title === 'Glass River');
  ok('auto-publish OFF: new imports wait as drafts (OFF)', r.result.drafts === 1 && r.result.published === 0 && glass && glass.active === false && feed.statusOf(glass) === 'OFF');
  feed._internal.reset();
  ok('drafts are not shown to customers; TMDB attribution flag when TMDB posts are live', !(await feed.publicList()).posts.some((p) => p.title === 'Glass River') && (await feed.publicList()).tmdb === true);

  // TMDB down → fail soft
  tmdbDown = true;
  const j3 = job(); j3.day = '2000-01-01'; settings.feed_job = JSON.stringify(j3);
  r = await feed.runImport({ force: true });
  ok('TMDB down: no throw, error kept for admin, posts untouched', r.ok === false && /reach TMDB/.test(job().lastError) && (await feed.list()).length === after.length - 1 + 1);
  tmdbDown = false;
  let threw = false; try { await feed.runImport({ force: true }); } catch (e) { threw = true; }
  ok('next run clears the error', !threw && job().lastError === '');

  // ---- admin API ----
  const routes = {}; const audits = []; let authed = false;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  require('../adminfeed').mount(app, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (q, a) => audits.push(a) }, feed });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; Promise.resolve(routes[m + ' ' + p]({ body }, res)); });
  let x = await call('POST', '/admin/api/feed/save', { title: 'x', service: 'Netflix' });
  ok('admin sign-in required', x.code === 403);
  authed = true;
  x = await call('GET', '/admin/api/feed');
  const n = x.body.posts.find((p) => p.id === newest.id);
  ok('admin list: status, views, likes, clicks, shares, platforms, job, settings without key', x.body.ok && n.status === 'LIVE' && n.views === 12 && n.likes === 1 && n.clicks === 1 && x.body.services.length === 3 && x.body.job && x.body.job.lastRun && x.body.settings.hasKey && !JSON.stringify(x.body).includes(V3));
  x = await call('POST', '/admin/api/feed/save', { type: 'movie', title: 'Admin Made', service: 'Netflix', active: true });
  ok('create via admin + change log', x.body.ok && audits.some((l) => l.action === 'feed.create' && /Admin Made/.test(l.summary)));
  const made = x.body.post;
  x = await call('POST', '/admin/api/feed/delete', { id: made.id });
  ok('delete via admin + change log', x.body.ok && audits.some((l) => l.action === 'feed.delete'));
  audits.length = 0;
  x = await call('POST', '/admin/api/feed/settings', { tmdbKey: 'ffffffffffffffffffffffffffffffff', maxPerDay: 4 });
  ok('settings change logged without the key', x.body.ok && audits.length === 1 && !JSON.stringify(audits).includes('ffffffff') && /TMDB key saved/.test(audits[0].summary));
  await new Promise((res) => setTimeout(res, 30));
  x = await call('POST', '/admin/api/feed/run', {});
  ok('Run now route answers with counts', x.code === 200 && x.body.ok && x.body.result && 'imported' in x.body.result);
  x = await call('POST', '/admin/api/feed/tmdb/suggest', { services: [], days: 14 });
  ok('suggest: drafts with "already posted" marks, nothing saved', x.body.ok && x.body.drafts.some((d) => d.posted) && x.body.drafts.every((d) => d.tmdbKey));
  await feed.saveSettings({ clearKey: true });
  x = await call('POST', '/admin/api/feed/run', {});
  ok('Run now without a key explains what to do', x.code === 400 && /TMDB key/.test(x.body.message));

  // ---- storefront ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('storefront script parses', parsed);
  const start = html.indexOf('const feedStore_ = {'); const end = html.indexOf('function FeedStrip(');
  const H = new Function('localStorage', 'API', 'copyText_', 'window', 'navigator', html.slice(start, end) + '; return { feedServiceInfo_, feedRelease_, feedPostFromUrl_, feedWhen_, feedThumb_, feedLoad_, feedEvent_, feedLiked_, feedSetLiked_, feedDevice_ };');
  const store = {}; const apiCalls = [];
  const fakeApi = { getFeed: (ok2) => { apiCalls.push('getFeed'); ok2({ ok: true, posts: [{ id: 'fp1' }], tmdb: false }); }, feedEvent: (id, kind, dev) => apiCalls.push(kind + ':' + id + ':' + dev) };
  const h = H({ getItem: (k) => store[k] || null, setItem: (k, v2) => { store[k] = String(v2); } }, fakeApi, () => {}, { location: { origin: 'https://shop.fluxfilm.in', href: 'https://shop.fluxfilm.in/' } }, {});
  const cat = [{ service: 'Netflix', price: 139, logoUrl: '' }, { service: 'Netflix', price: 199, logoUrl: 'https://x/nf.png' }, { service: 'Netflix (Group Offer)', price: 99 }, { service: 'Prime Video', price: 39 }, { service: 'Prime Video + Shopping', price: 69 }];
  ok('CTA price = cheapest plan of that exact platform; logo from catalog', JSON.stringify(h.feedServiceInfo_('Netflix', cat)) === JSON.stringify({ service: 'Netflix', price: 139, logoUrl: 'https://x/nf.png' }));
  ok('platform not in catalog by exact name → starts-with match; unknown → no button', h.feedServiceInfo_('Prime', cat).service === 'Prime Video' && h.feedServiceInfo_('Prime', cat).price === 39 && h.feedServiceInfo_('Hulu', cat) === null && h.feedServiceInfo_('', cat) === null);
  ok('release line: future = Streaming from, past = Released / Out since', /^📅 Streaming from/.test(h.feedRelease_(day(5), 'movie')) && /^🎬 Released/.test(h.feedRelease_(day(-5), 'movie')) && /^📺 Out since/.test(h.feedRelease_(day(-5), 'series')) && h.feedRelease_('nope') === '');
  ok('deep link ?post=<id> read safely', h.feedPostFromUrl_('?post=fp0123456789') === 'fp0123456789' && h.feedPostFromUrl_('?post=<script>') === '' && h.feedPostFromUrl_('?ref=X') === '');
  ok('time ago + smaller TMDB thumbs for the strip', h.feedWhen_(new Date(Date.now() - 3 * 3600e3).toISOString()) === '3h ago' && h.feedThumb_('https://image.tmdb.org/t/p/w780/a.jpg') === 'https://image.tmdb.org/t/p/w342/a.jpg' && h.feedThumb_('/feed-img/fp1?v=1') === '/feed-img/fp1?v=1');
  let got = 0; h.feedLoad_(() => got++); h.feedLoad_(() => got++);
  ok('feed loaded once and shared by the strip and the page (cached 60 s)', got === 2 && apiCalls.filter((c) => c === 'getFeed').length === 1);
  h.feedEvent_('fp1', 'view'); h.feedEvent_('fp1', 'view'); h.feedEvent_('fp1', 'like'); h.feedSetLiked_('fp1', true);
  ok('view sent once per visit; like carries the device id and is remembered', apiCalls.filter((c) => /^view/.test(c)).length === 1 && /^like:fp1:\w{6,}/.test(apiCalls.find((c) => /^like/.test(c))) && h.feedLiked_().includes('fp1') && h.feedDevice_() === h.feedDevice_());
  const navBlock = (html.match(/const navItems = \[[\s\S]*?\}\];/) || [''])[0];
  ok('menu: 🍿 New entry opens the feed; bottom menu shows on the feed', /key: 'feed',\s*icon: '🍿',\s*label: 'New'/.test(navBlock) && /nav\('feed', \{\}\)/.test(navBlock) && /feed: 1,/.test(html) && /feed: \["What's new"/.test(html));
  ok('feed screen rendered for guests and customers (not blocked by maintenance); strip on Home and My plans', /screen === 'feed' && React\.createElement\(FeedScreen, \{/.test(html) && /screen === 'home' && React\.createElement\(FeedStrip,/.test(html) && /screen === 'dashboard' && React\.createElement\(FeedStrip,/.test(html) && !/storeBlocked && screen === 'feed'/.test(html));
  ok('post: lazy image in a fixed 4:5 box, like / share / trailer, caption "more", tags, CTA → plans or renew', /loading: "lazy",\s*decoding: "async"/.test(html) && /\.ff-feed-media \{[^}]*aspect-ratio: 4 \/ 5/.test(html) && /"aria-pressed": liked/.test(html) && /navigator\.share/.test(html) && /openExternal_\(p\.trailerUrl\)/.test(html) && /open \? 'less' : 'more'/.test(html) && /nav\('buy2', \{\s*service: info\.service\s*\}\)/.test(html) && /nav\('renewStart', \{\s*sub: renewSub\s*\}\)/.test(html));
  ok('filter chips only for platforms that have posts; skeletons while loading; TMDB attribution', /const platforms = \[\.\.\.new Set\(posts\.map\(p => p\.service\)\.filter\(Boolean\)\)\];/.test(html) && /function FeedSkeleton\(/.test(html) && /This product uses the TMDB API but is not endorsed or certified by TMDB\./.test(html));
  ok('shared link opens the post after login restore; link removed from the address bar', /const feedLink = useRef\(feedPostFromUrl_\(window\.location\.search\)\);/.test(html) && /nav\('feed', \{\s*postId: id\s*\}\)/.test(html) && /searchParams\.delete\('post'\)/.test(html));
  ok('API: getFeed + feedEvent', /apiCall_\('getFeed', \[\]/.test(html) && /apiCall_\('feedEvent', \[id, kind, device\]/.test(html));
  ok('feed animations are transform/opacity only and stop for reduced motion', /@keyframes ffFeedBurst \{[^@]*\} \}/.test(html) && !/@keyframes ffFeedBurst \{[^@]*(width|height|top|left)\s*:/.test(html.match(/@keyframes ffFeedBurst \{[^\n]*/)[0]) && /prefers-reduced-motion: reduce\) \{ \.ff-feed-burst, \.ff-feed-skel \.ff-feed-media \{ animation: none; \} \}/.test(html));

  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: getFeed / feedEvent wired + rate-limited, picture route before the catch-all with long cache, timers', /getFeed: \(\) => feedMod\.publicList\(\)/.test(srv) && /feedEvent: \(a\) => feedMod\.record\(a\[0\], a\[1\], a\[2\]\)/.test(srv) && /DB_STOREFRONT_ACTIONS\.add\('getFeed'\); DB_STOREFRONT_ACTIONS\.add\('feedEvent'\);/.test(srv) && /LIMITS\.feedEvent = security\.rateLimiter/.test(srv) && srv.indexOf("app.get('/feed-img/:id'") > 0 && srv.indexOf("app.get('/feed-img/:id'") < srv.indexOf("app.get('*'") && /max-age=31536000, immutable/.test(srv) && /feedMod\.startTimer\(/.test(srv));
  ok('server: ticker falls back to feed titles when trending_items is empty', /r\.items = await feedMod\.trendingLines\(\)/.test(srv));
  ok('admin.js mounts adminfeed', /require\('\.\/adminfeed'\)\.mount\(app/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')));

  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const aScripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let aParsed = true; for (const sc of aScripts) { try { new Function(sc); } catch (e) { aParsed = false; console.log('   admin parse error:', e.message); } }
  ok('admin panel parses; 🍿 menu entry + route', aParsed && /\['feed', '🍿', "What's new"\]/.test(admin) && /feed: feedView,/.test(admin));
  ok('admin: status pills, pin / copy / delete (confirm), live phone preview, picture upload shrunk first', /LIVE: \['🟢 Live'/.test(admin) && /HIDDEN: \[/.test(admin) && /data-pin=/.test(admin) && /data-dup=/.test(admin) && /confirm\('Delete the post "/.test(admin) && /function fdPreview\(e\)/.test(admin) && /\/admin\/api\/feed\/image/.test(admin) && /url\.length > 440000/.test(admin));
  ok('admin: TMDB search, suggestions, settings (platforms, languages, per day, auto-hide, popularity, votes), Run now + job status', /\/admin\/api\/feed\/tmdb\/search/.test(admin) && /\/admin\/api\/feed\/tmdb\/suggest/.test(admin) && /id="fdmax"/.test(admin) && /id="fdhide"/.test(admin) && /id="fdpop"/.test(admin) && /id="fdvotes"/.test(admin) && /data-plat=/.test(admin) && /data-lang=/.test(admin) && /id="fdrun"/.test(admin) && /\/admin\/api\/feed\/run/.test(admin) && /Last error/.test(admin) && /type="password" autocomplete="off"/.test(admin));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
