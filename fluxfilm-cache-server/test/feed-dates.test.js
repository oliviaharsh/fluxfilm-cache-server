/* 🍿 Feed 📅 automatic release dates: refresh imported posts (new season + label, India date), edited posts only get empty
   fields, manual posts dated by title / year, ambiguous titles left empty, weekly shows (WWE Raw) left out + flagged,
   storefront date line. TMDB mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const ROOT = path.join(__dirname, '..');

const settings = {};
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(sql)) { delete settings[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT service, price, logo_url, is_active, raw_json FROM plans$/.test(sql)) return [{ service: 'Netflix', price: 139, logo_url: '', is_active: 'TRUE', raw_json: '{}' }, { service: 'Prime Video', price: 49, logo_url: '', is_active: 'TRUE', raw_json: '{}' }];
    if (/feed_comments/.test(sql)) throw new Error("Table 'x.feed_comments' doesn't exist");
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const feed = require('../feed');
const feedai = require('../feedai');

const day = (n) => new Date(Date.now() + n * 86400e3 + 330 * 60000).toISOString().slice(0, 10);
const seasons = (list) => list.map(([n, date, eps]) => ({ season_number: n, air_date: date, episode_count: eps || 8 }));

// ---- fake TMDB ----
const calls = [];
const details = {}; const search = {}; const providers = {}; let discoverTv = []; let discoverMovies = [];
async function fakeFetch(url) {
  const u = new URL(url);
  calls.push(u);
  const res = (body, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => body });
  const p = u.pathname.replace('/3', '');
  if (/^\/genre\//.test(p)) return res({ genres: [] });
  if (p === '/discover/movie') return res({ results: discoverMovies });
  if (p === '/discover/tv') return res({ results: discoverTv });
  if (p === '/search/multi') return res({ results: search[u.searchParams.get('query').toLowerCase()] || [] });
  let m = p.match(/^\/(movie|tv)\/(\d+)\/watch\/providers$/);
  if (m) return res({ id: +m[2], results: providers[m[1] + ':' + m[2]] ? { IN: { flatrate: providers[m[1] + ':' + m[2]].map((id) => ({ provider_id: id })) } } : {} });
  m = p.match(/^\/(movie|tv)\/(\d+)$/);
  if (m && details[m[1] + ':' + m[2]]) return res(Object.assign({ id: +m[2], videos: { results: [] } }, details[m[1] + ':' + m[2]]));
  return res({}, 404);
}
feed._internal.setFetch(fakeFetch);
const detailCalls = (k) => calls.filter((c) => c.pathname === '/3/' + k.replace(':', '/')).length;

const now = Date.now();
const imported = new Date(now - 86400e3).toISOString();
const mk = (id, title, type, tmdbKey, releaseDate, o) => Object.assign({ id, title, type, service: 'Netflix', ctaService: 'Netflix', brand: 'Netflix', caption: '', releaseDate, languages: [], genres: ['Drama'], imageUrl: '', trailerUrl: '', instagramUrl: '', cta: 'service', pinned: false, active: true, publishAt: '', hideAfter: new Date(now + 29 * 86400e3).toISOString(), source: 'tmdb', tmdbKey, importedAt: imported, edited: false, createdAt: imported, updatedAt: imported, seasonLabel: '' }, o || {});
const tvDet = (name, first, list, o) => Object.assign({ name, first_air_date: first, poster_path: '/x.jpg', seasons: seasons(list) }, o || {});

(async () => {
  await feed.saveSettings({ tmdbKey: 'a'.repeat(32), maxPerDay: 20 });

  // ================= 1. refresh imported posts =================
  // Imported before #99: first air dates, no labels (like the live Outer Banks '2020-04-15').
  details['tv:1'] = tvDet('Outer Banks', '2020-04-15', [[1, '2020-04-15'], [4, '2024-10-10'], [5, day(-20)]], { last_episode_to_air: { season_number: 5, episode_number: 3, air_date: day(-6) } });
  details['tv:2'] = tvDet('Dead City', '2023-06-18', [[1, '2023-06-18'], [2, day(-400)]], { next_episode_to_air: { season_number: 3, episode_number: 1, air_date: day(10) } });
  details['tv:3'] = tvDet('Lanterns', day(-30), [[1, day(-30)]]);
  details['tv:4'] = tvDet('Vigil', '2021-08-29', [[1, '2021-08-29'], [2, day(-700)]]);
  details['tv:5'] = tvDet('Reacher', '2022-02-03', [[1, '2022-02-03'], [3, day(-500)], [4, day(-8)]]);
  details['tv:6'] = tvDet('Lioness', '2023-07-23', [[1, '2023-07-23'], [3, day(-3)]]);
  details['tv:7'] = tvDet('Hidden Show', '2010-01-01', [[9, day(-2)]]);
  details['tv:8'] = tvDet('Imported Weeks Ago', '2015-05-05', [[1, '2015-05-05'], [2, day(-50)]]);
  details['movie:20'] = { title: 'Gandhari', release_date: day(-15), poster_path: '/g.jpg', release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: day(-15) + 'T00:00:00.000Z' }] }, { iso_3166_1: 'IN', release_dates: [{ type: 4, release_date: day(-12) + 'T00:00:00.000Z' }] }] } };
  details['movie:21'] = { title: 'No India Date', release_date: day(-9), poster_path: '/n.jpg', release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: day(-9) + 'T00:00:00.000Z' }] }] } };
  details['movie:22'] = { title: 'Edited Movie', release_date: day(-5), poster_path: '/e.jpg', release_dates: { results: [{ iso_3166_1: 'IN', release_dates: [{ type: 4, release_date: day(-4) }] }] } };
  settings.feed_posts = JSON.stringify([
    mk('fp1', 'Outer Banks', 'series', 'tv:1', '2020-04-15'),
    mk('fp2', 'The Walking Dead: Dead City', 'series', 'tv:2', '2023-06-18', { hideAfter: new Date(now + 29 * 86400e3).toISOString() }),
    mk('fp3', 'Lanterns', 'series', 'tv:3', day(-30)),
    mk('fp4', 'Vigil', 'series', 'tv:4', '2021-08-29'),
    mk('fp5', 'Reacher', 'series', 'tv:5', '2022-02-03', { edited: true }), // owner edited, date set → untouched
    mk('fp6', 'Lioness', 'series', 'tv:6', '', { edited: true }), // owner edited, date empty → filled + label
    mk('fp7', 'Hidden Show', 'series', 'tv:7', '2010-01-01', { hideAfter: new Date(now - 3600e3).toISOString() }),
    mk('fp8', 'Gandhari', 'movie', 'movie:20', day(-15)),
    mk('fp9', 'No India Date', 'movie', 'movie:21', day(-9)),
    mk('fp10', 'Edited Movie', 'movie', 'movie:22', day(-5), { edited: true }),
    mk('fp11', 'Manual', 'series', '', '2001-01-01', { source: 'manual' }),
    mk('fp12', 'Imported Weeks Ago', 'series', 'tv:8', '2015-05-05', { importedAt: new Date(now - 40 * 86400e3).toISOString(), hideAfter: new Date(now + 86400e3).toISOString() }),
  ]);
  feed._internal.reset(); calls.length = 0;
  let r = await feed.refreshDates({ force: true });
  let P = Object.fromEntries((await feed.list()).map((p) => [p.id, p]));
  ok('refresh: old-imported series with a new season → premiere date + "Season 5"', P.fp1.releaseDate === day(-20) && P.fp1.seasonLabel === 'Season 5', P.fp1);
  ok('refresh: upcoming season (next episode S3E1) → its date + "Season 3"', P.fp2.releaseDate === day(10) && P.fp2.seasonLabel === 'Season 3', P.fp2);
  ok('refresh: an unedited post whose date moved later hides autoHideDays after that date (only ever extended)', Math.round((Date.parse(P.fp2.hideAfter) - Date.parse(day(10) + 'T00:00:00+05:30')) / 86400e3) === 30, P.fp2.hideAfter);
  ok('refresh: season that premiered 50 days ago (inside the window of its import day) still gets its date + label', P.fp12.releaseDate === day(-50) && P.fp12.seasonLabel === 'Season 2', P.fp12);
  ok('refresh: brand-new show keeps its first air date, no label', P.fp3.releaseDate === day(-30) && P.fp3.seasonLabel === '');
  ok('refresh: no longer new → date left alone, counted for the 🧹 cleanup', P.fp4.releaseDate === '2021-08-29' && P.fp4.seasonLabel === '' && r.notNew === 1, r);
  ok('refresh: owner-edited post with a date is never overwritten (not even the label)', P.fp5.releaseDate === '2022-02-03' && P.fp5.seasonLabel === '' && P.fp5.edited === true);
  ok('refresh: owner-edited post with an EMPTY date gets date + label filled', P.fp6.releaseDate === day(-3) && P.fp6.seasonLabel === 'Season 3' && P.fp6.edited === true, P.fp6);
  ok('refresh: hidden posts and manual posts are skipped (no TMDB call)', P.fp7.releaseDate === '2010-01-01' && detailCalls('tv:7') === 0 && P.fp11.releaseDate === '2001-01-01');
  ok('refresh: movie prefers the India release date (+ region IN)', P.fp8.releaseDate === day(-12) && P.fp8.releaseRegion === 'IN', P.fp8);
  ok('refresh: movie without an India date keeps its date', P.fp9.releaseDate === day(-9) && !P.fp9.releaseRegion);
  ok('refresh: edited movie keeps the owner\'s date', P.fp10.releaseDate === day(-5));
  ok('refresh result lists what changed', r.ok && r.checked === 10 && r.updated.map((x) => x.id).sort().join() === 'fp1,fp12,fp2,fp6,fp8' && r.updated.find((x) => x.id === 'fp1').from === '2020-04-15' && r.failed === 0, r);
  ok('refresh stamps datesAt; a non-forced run within 20 h asks TMDB nothing', Object.values(P).filter((p) => p.datesAt).length === 10 && await (async () => { calls.length = 0; feed._internal.reset(); const x = await feed.refreshDates({}); return x.checked === 0 && calls.length === 0; })());
  r = await feed.refreshDates({ force: true });
  ok('refresh again: nothing more to change (stable)', r.updated.length === 0, r.updated);
  const pubTxt = JSON.stringify(await feed.publicList());
  ok('public feed: new dates + label, never tmdb / datesAt / dateAuto', /"seasonLabel":"Season 5"/.test(pubTxt) && !/tmdb|datesAt|dateAuto|releaseRegion/i.test(pubTxt));
  // TMDB down → counted, nothing lost.
  const saveFetch = fakeFetch; feed._internal.setFetch(async () => { throw new Error('ECONNREFUSED'); }); feed._internal.reset();
  r = await feed.refreshDates({ force: true });
  ok('TMDB down: failed counted, dates kept', r.ok && r.failed === 10 && (await feed.list()).find((p) => p.id === 'fp1').releaseDate === day(-20));
  feed._internal.setFetch(saveFetch);

  // ================= 2. import run refreshes old posts too =================
  discoverMovies = []; discoverTv = [];
  let px = JSON.parse(settings.feed_posts); px.forEach((p) => { if (p.id === 'fp4') { p.datesAt = ''; } if (p.id === 'fp1') { p.releaseDate = '2020-04-15'; p.seasonLabel = ''; p.datesAt = new Date(now - 21 * 3600e3).toISOString(); } });
  settings.feed_posts = JSON.stringify(px); feed._internal.reset();
  r = await feed.runImport({ force: true });
  ok('scheduled import also backfills dates of posts not checked in 20 h', r.ok && r.result.dates === 1 && (await feed.list()).find((p) => p.id === 'fp1').seasonLabel === 'Season 5', r);

  // ================= 3. weekly shows (WWE Raw) =================
  details['tv:4656'] = tvDet('Raw', '1993-01-11', [[1, '1993-01-11', 30], [33, '2025-01-06', 52], [34, day(-250), 52]], { type: 'Scripted', last_episode_to_air: { season_number: 34, episode_number: 36, air_date: day(-1) } });
  details['tv:4657'] = tvDet('Talky', '2015-01-01', [[1, '2015-01-01']], { type: 'Talk Show' });
  discoverTv = [
    { id: 4656, name: 'Raw', first_air_date: '1993-01-11', poster_path: '/r.jpg', genre_ids: [10759], popularity: 90, vote_count: 90 },
    { id: 4658, name: 'Reality Thing', first_air_date: day(-3), poster_path: '/q.jpg', genre_ids: [10764], popularity: 80, vote_count: 80 },
    { id: 4657, name: 'Talky', first_air_date: '2015-01-01', poster_path: '/t.jpg', genre_ids: [], popularity: 70, vote_count: 70 },
    { id: 4659, name: 'Fresh Drama', first_air_date: day(-2), poster_path: '/f.jpg', genre_ids: [18], popularity: 60, vote_count: 60 },
  ];
  feed._internal.reset();
  let st = await feed.getSettings();
  ok('setting: leave out talk / news / reality / soap shows ON by default', st.skipWeeklyShows === true && feed.publicSettings(st).skipWeeklyShows === true);
  let d = await feed.discover(st, ['Netflix']);
  const reason = (t) => (d.notNew.find((x) => x.title === t) || {}).reason || '';
  ok('discover: brand-new reality show (genre id) left out even though it is new', !d.drafts.some((x) => x.title === 'Reality Thing') && /Weekly \/ daily show \(Reality\)/.test(reason('Reality Thing')), d.notNew);
  ok('discover: WWE Raw style (old, 52-episode seasons, no genre flag) left out', !d.drafts.some((x) => x.title === 'Raw') && /Weekly \/ daily show \(all-year episodes\)/.test(reason('Raw')), d.notNew);
  ok('discover: talk show (TMDB type) left out; normal new drama kept', /Talk Show/.test(reason('Talky')) && d.drafts.map((x) => x.title).join() === 'Fresh Drama', d.drafts.map((x) => x.title));
  d = await feed.discover(Object.assign({}, st, { skipWeeklyShows: false, seriesNewOnly: false }), ['Netflix']);
  ok('setting OFF → weekly shows can come back', d.drafts.some((x) => x.title === 'Reality Thing') && d.drafts.some((x) => x.title === 'Raw'));
  r = await feed.saveSettings({ skipWeeklyShows: false });
  ok('setting saved + change log words', r.ok && r.settings.skipWeeklyShows === false && /leave out talk \/ news \/ reality \/ soap shows off/.test(r.changed.join()));
  await feed.saveSettings({ skipWeeklyShows: true });
  // 🧹 cleanup flags the live Raw post ('1993-01-11', genre Reality) and a Raw-style one without genres.
  settings.feed_posts = JSON.stringify([
    mk('fr1', 'Raw', 'series', 'tv:4656', '1993-01-11', { genres: ['Reality'] }),
    mk('fr2', 'Raw Again', 'series', 'tv:4656', '1993-01-11', { genres: [] }),
    mk('fr3', 'Outer Banks', 'series', 'tv:1', day(-20), { seasonLabel: 'Season 5' }),
    mk('fr4', 'Far Movie', 'movie', 'movie:30', day(60)),
  ]);
  feed._internal.reset(); calls.length = 0;
  let cl = await feed.notNewCandidates();
  const cr = (id) => (cl.candidates.find((x) => x.id === id) || {}).reason || '';
  ok('🧹 cleanup flags Raw by its Reality genre without asking TMDB', /Weekly \/ daily show \(Reality\)/.test(cr('fr1')), cl.candidates);
  ok('🧹 cleanup flags a Raw-style show by its all-year seasons', /all-year episodes/.test(cr('fr2')));
  ok('🧹 cleanup flags a post whose only date is beyond the window; the new season stays', /more than 30 days ahead/.test(cr('fr4')) && !cr('fr3'), cl.candidates);

  // ================= 4. manual posts: date by title =================
  const row = (id, media, title, date, pop, o) => Object.assign({ id, media_type: media, poster_path: '/p' + id + '.jpg', popularity: pop, genre_ids: [18], original_language: 'en' }, media === 'tv' ? { name: title, first_air_date: date } : { title, release_date: date }, o || {});
  search['front of the class'] = [row(900, 'movie', 'Front of the Classroom', '2019-01-01', 90), row(901, 'movie', 'Front of the Class', '2008-12-07', 12), row(902, 'movie', 'Front of the Class', '2024-05-01', 11)];
  details['movie:901'] = { title: 'Front of the Class', release_date: '2008-12-07', poster_path: '/front.jpg', genres: [{ id: 18, name: 'Drama' }] };
  search['the office'] = [row(910, 'tv', 'The Office', '2005-03-24', 40), row(911, 'tv', 'The Office', '2001-07-09', 30)];
  search['kingdom'] = [row(920, 'tv', 'Kingdom', '2019-01-25', 30), row(921, 'tv', 'Kingdom', '2014-10-08', 28)];
  providers['tv:920'] = [8];
  details['tv:920'] = tvDet('Kingdom', '2019-01-25', [[1, '2019-01-25'], [2, '2020-03-13'], [3, day(-10)]]);
  search['shaque'] = [row(930, 'movie', 'Shaque', '2026-09-25', 5)];
  details['movie:930'] = { title: 'Shaque', release_date: day(10), poster_path: '/s.jpg', release_dates: { results: [{ iso_3166_1: 'IN', release_dates: [{ type: 4, release_date: day(12) + 'T00:00:00.000Z' }] }] } };
  search['off campus'] = [row(940, 'tv', 'Off Campus', day(-120), 20)];
  details['tv:940'] = tvDet('Off Campus', day(-120), [[1, day(-120)]]);
  search['popular pick'] = [row(950, 'movie', 'Popular Pick', '2011-01-01', 80), row(951, 'movie', 'Popular Pick', '1990-01-01', 3)];
  details['movie:950'] = { title: 'Popular Pick', release_date: '2011-01-01', poster_path: '/pp.jpg' };

  let a = await feed.autoDate({ type: 'movie', title: '🎥Front of the Class (2008)', brand: 'Netflix' });
  ok('manual movie: title + (2008) year → that film\'s date (not the 2024 one, not "Classroom")', a.found && a.releaseDate === '2008-12-07' && !a.seasonLabel && /Date found automatically/.test(a.message), a);
  a = await feed.autoDate({ type: 'movie', title: 'Front of the Class', brand: 'Netflix' });
  ok('same title twice, similar popularity, none on the platform → not sure, empty + "Couldn\'t find the date — type it"', !a.found && a.message === 'Couldn\'t find the date — type it' && !a.releaseDate, a);
  a = await feed.autoDate({ type: 'series', title: 'The Office', brand: 'Prime Video' });
  ok('ambiguous series title → empty + message', !a.found && /Couldn't find the date — type it/.test(a.message), a);
  calls.length = 0;
  a = await feed.autoDate({ type: 'series', title: 'Kingdom', brand: 'Netflix', ctaService: 'Netflix (Group Offer)' });
  ok('several matches → the one streaming on the brand\'s provider in India (Netflix 8) wins; new season → "Season 3" + premiere', a.found && a.releaseDate === day(-10) && a.seasonLabel === 'Season 3' && calls.some((c) => c.pathname === '/3/tv/921/watch/providers'), a);
  a = await feed.autoDate({ type: 'movie', title: 'Popular Pick', brand: 'Netflix' });
  ok('several matches, none on the platform, one clearly most popular → that one', a.found && a.releaseDate === '2011-01-01', a);
  a = await feed.autoDate({ type: 'movie', title: 'Shaque', brand: 'Netflix' });
  ok('manual movie: India release date preferred', a.found && a.releaseDate === day(12) && a.releaseRegion === 'IN', a);
  a = await feed.autoDate({ type: 'series', title: 'Off Campus', brand: 'Prime Video' });
  ok('manual series (new show, 120 days ago) → first air date, no label', a.found && a.releaseDate === day(-120) && a.seasonLabel === '', a);
  a = await feed.autoDate({ type: 'movie', title: 'zzqx nothing' });
  ok('unknown title → empty + message; announcement → nothing asked', !a.found && /type it/.test(a.message) && (await feed.autoDate({ type: 'announcement', title: 'Sale' })).message === '');

  // admin save route
  const routes = {}; const audits = [];
  require('../adminfeed').mount({ get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } }, { auth: () => true, audit: { record: (rq, x) => audits.push(x) }, feed, comments: { adminList: async () => ({ ready: false, counts: {}, byPost: {} }) } });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; Promise.resolve(routes[m + ' ' + p]({ body, query: {} }, res)); });
  settings.feed_posts = '[]'; feed._internal.reset();
  let x = await call('POST', '/admin/api/feed/save', { type: 'movie', title: 'Front of the Class (2008)', brand: 'Netflix', ctaService: 'Netflix', active: true });
  ok('admin save without a date → date filled automatically, marked auto, message returned', x.body.ok && x.body.post.releaseDate === '2008-12-07' && x.body.post.dateAuto === true && x.body.autoDate.found === true, x.body);
  const saved = x.body.post;
  x = await call('POST', '/admin/api/feed/save', Object.assign({}, saved, { releaseDate: '2009-01-01', dateAuto: false }));
  ok('owner changes the date → theirs (no longer auto), no lookup', x.body.ok && x.body.post.releaseDate === '2009-01-01' && x.body.post.dateAuto === false && !x.body.autoDate);
  x = await call('POST', '/admin/api/feed/save', Object.assign({}, saved, { caption: 'new words' }));
  ok('saving other fields keeps an auto date auto', x.body.post.dateAuto === true && x.body.post.releaseDate === '2008-12-07');
  x = await call('POST', '/admin/api/feed/save', { type: 'series', title: 'The Office', brand: 'Prime Video', ctaService: 'Prime Video', active: true });
  ok('admin save, ambiguous title → saved without a date + "Couldn\'t find the date — type it"', x.body.ok && x.body.post.releaseDate === '' && x.body.autoDate.found === false && x.body.autoDate.message === 'Couldn\'t find the date — type it', x.body);
  x = await call('POST', '/admin/api/feed/save', { type: 'series', title: 'Kingdom', brand: 'Netflix', ctaService: 'Netflix', active: true });
  ok('admin save, series with a new season → date + Season 3 saved', x.body.post.releaseDate === day(-10) && x.body.post.seasonLabel === 'Season 3');
  calls.length = 0;
  x = await call('POST', '/admin/api/feed/save', { type: 'movie', title: 'Typed Date', brand: 'Netflix', releaseDate: '2026-01-02', active: true });
  ok('a typed date is never looked up or replaced', x.body.post.releaseDate === '2026-01-02' && !x.body.post.dateAuto && !calls.some((c) => /search/.test(c.pathname)) && !x.body.autoDate);
  // 🔄 refresh route
  settings.feed_posts = JSON.stringify([mk('fq1', 'Outer Banks', 'series', 'tv:1', '2020-04-15')]); feed._internal.reset(); audits.length = 0;
  x = await call('POST', '/admin/api/feed/dates/refresh', {});
  ok('🔄 Refresh dates & seasons route: forced, message + change log with titles', x.body.ok && x.body.updated.length === 1 && /updated 1/.test(x.body.message) && audits.length === 1 && audits[0].action === 'feed.dates.refresh' && /"Outer Banks" 2020-04-15 → \d{4}-\d{2}-\d{2} \(Season 5\)/.test(audits[0].summary), [x.body, audits]);
  await feed.saveSettings({ clearKey: true });
  x = await call('POST', '/admin/api/feed/dates/refresh', {});
  ok('no TMDB key → 400 with a clear message', x.code === 400 && /TMDB key/.test(x.body.message));
  x = await call('POST', '/admin/api/feed/save', { type: 'movie', title: 'No Key Film', brand: 'Netflix', active: true });
  ok('no TMDB key: manual save still works, no date message', x.body.ok && x.body.post.releaseDate === '' && !x.body.autoDate);
  await feed.saveSettings({ tmdbKey: 'a'.repeat(32) });

  // ✨ AI fill
  const fakeFeed = { LANGS: feed.LANGS, getSettings: feed.getSettings, searchTitle: feed.searchTitle, tmdbMatch: feed.tmdbMatch, NO_DATE: feed.NO_DATE };
  r = await feedai.aiFill({ title: 'The Office', type: 'series', brand: 'Prime Video' }, { feed: fakeFeed, model: null });
  ok('✨ AI fill: ambiguous title → no date, "Couldn\'t find the date — type it" note', r.ok && !r.fields.releaseDate && r.notes.includes('Couldn\'t find the date — type it'), r);
  r = await feedai.aiFill({ title: 'Kingdom', type: 'series', brand: 'Netflix' }, { feed: fakeFeed, model: null });
  ok('✨ AI fill: series with a new season → date + seasonLabel', r.fields.releaseDate === day(-10) && r.fields.seasonLabel === 'Season 3', r.fields);

  // ================= 5. storefront + admin page =================
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fnIn = (src, name) => { const s0 = src.indexOf('function ' + name + '('); let i = src.indexOf('{', s0); let depth = 0; for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; } return src.slice(s0, i + 1); };
  const R = new Function(fnIn(html, 'feedRelease_') + '; return feedRelease_;')();
  const T0 = Date.parse('2026-09-15T12:00:00+05:30');
  ok('storefront: new season = "🆕 Season 5 · 20 Aug"', R('2026-08-20', 'series', T0, 'Season 5') === '🆕 Season 5 · 20 Aug', R('2026-08-20', 'series', T0, 'Season 5'));
  ok('storefront: movie / new show = "Released 3 Sept"', /^🎬 Released 3 Sept?$/.test(R('2026-09-03', 'movie', T0)) && /^📺 Released 16 Aug$/.test(R('2026-08-16', 'series', T0)), [R('2026-09-03', 'movie', T0), R('2026-08-16', 'series', T0)]);
  ok('storefront: upcoming = "Coming 25 Sept" (season: "Season 3 · Coming 25 Sept")', /^🗓️ Coming 25 Sept?$/.test(R('2026-09-25', 'movie', T0)) && /^🗓️ Season 3 · Coming 25 Sept?$/.test(R('2026-09-25', 'series', T0, 'Season 3')));
  ok('storefront: an old date shows its year ("Released 7 Dec 2008"), this year\'s never does', /^🎬 Released 7 Dec 2008$/.test(R('2008-12-07', 'movie', T0)) && !/2026/.test(R('2026-09-03', 'movie', T0)));
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const scripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]);
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   admin parse error:', e.message); } }
  ok('admin page script parses', parsed && scripts.length > 0);
  const AR = new Function('Date', fnIn(admin, 'fdRelease') + '; return fdRelease;')((function () { const D = function (...a) { return a.length ? new Date(...a) : new Date(T0); }; D.now = () => T0; D.parse = Date.parse; return D; })());
  ok('admin preview uses the same date line', AR({ releaseDate: '2026-08-20', type: 'series', seasonLabel: 'Season 5' }) === '🆕 Season 5 · 20 Aug' && /^🗓️ Coming 25 Sept?$/.test(AR({ releaseDate: '2026-09-25', type: 'movie' })));
  ok('admin: 🔄 Refresh dates & seasons button → route; "auto" pill; typing a date clears auto; setting checkbox saved', /id="fddates">🔄 Refresh dates &amp; seasons</.test(admin) && /post\('\/admin\/api\/feed\/dates\/refresh', \{\}\)/.test(admin) && />auto<\/span>/.test(admin) && /if \(k === 'releaseDate'\) \{ FD\.edit\.dateAuto = false;/.test(admin) && /id="fdweekly"/.test(admin) && /skipWeeklyShows: \$\('#fdweekly'\)\.checked/.test(admin) && /r\.autoDate && r\.autoDate\.message/.test(admin));

  console.log('\n---------------------------------------');
  console.log('feed-dates: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
