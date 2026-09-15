/* 🍿 Feed import: only truly NEW or UPCOMING titles (movies in the window, brand-new shows, new seasons) + 🧹 cleanup tool. TMDB mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const ROOT = path.join(__dirname, '..');

const settings = {};
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(sql)) { delete settings[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT service, price, logo_url, is_active, raw_json FROM plans$/.test(sql)) return [{ service: 'Netflix', price: 139, logo_url: '', is_active: 'TRUE', raw_json: '{}' }];
    if (/feed_comments/.test(sql)) throw new Error("Table 'x.feed_comments' doesn't exist");
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const feed = require('../feed');

// India-time YYYY-MM-DD, n days from today.
const day = (n) => new Date(Date.now() + n * 86400e3 + 330 * 60000).toISOString().slice(0, 10);
const midIST = (ymd) => Date.parse(ymd + 'T00:00:00+05:30');

// ---- fake TMDB ----
const calls = [];
const mv = (id, title, date, o) => Object.assign({ id, title, overview: 'Story of ' + title, release_date: date, poster_path: '/m' + id + '.jpg', genre_ids: [], original_language: 'hi', popularity: 50, vote_count: 50 }, o || {});
const tv = (id, name, first, o) => Object.assign({ id, name, overview: 'Series ' + name, first_air_date: first, poster_path: '/t' + id + '.jpg', genre_ids: [], original_language: 'en', popularity: 50, vote_count: 50 }, o || {});
const seasons = (list) => list.map(([n, date]) => ({ season_number: n, air_date: date, episode_count: 8 }));
let movies = []; let shows = []; const details = {}; const detailFail = new Set();
function resetCatalog() {
  movies = [
    mv(1, 'Fresh Film', day(-10), { popularity: 90 }),
    mv(2, 'Old Film', day(-60), { popularity: 99 }),
    mv(3, 'Soon Film', day(20), { popularity: 70 }),
    mv(4, 'Far Film', day(40), { popularity: 60 }),
    mv(5, 'India Film', day(-40), { popularity: 40 }),
  ];
  shows = [
    tv(11, 'Deadliest Catch', '2005-04-12', { popularity: 95 }),
    tv(12, 'Brand New Show', day(-7), { popularity: 85 }),
    tv(13, 'Outer Banks', '2020-04-15', { popularity: 80 }),
    tv(14, 'Vigil', '2021-08-29', { popularity: 75 }),
    tv(15, 'Teen Titans Go!', '2013-04-23', { popularity: 65 }),
    tv(16, 'Mushoku Tensei', '2021-01-11', { popularity: 55, original_language: 'ja' }),
  ];
  // Details (tv: seasons + last / next episode; movie: India release dates).
  details['movie:5'] = { release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: day(-40) + 'T00:00:00.000Z' }] }, { iso_3166_1: 'IN', release_dates: [{ type: 3, release_date: day(-30) + 'T00:00:00.000Z' }, { type: 4, release_date: day(-5) + 'T00:00:00.000Z' }] }] } };
  // Old show, weekly episodes of an old season (season 21 started 4 months ago).
  details['tv:11'] = { seasons: seasons([[0, '2005-01-01'], [1, '2005-04-12'], [20, day(-500)], [21, day(-120)]]), last_episode_to_air: { season_number: 21, episode_number: 8, air_date: day(-2) }, next_episode_to_air: { season_number: 21, episode_number: 9, air_date: day(5) } };
  details['tv:12'] = { seasons: seasons([[1, day(-7)]]), last_episode_to_air: { season_number: 1, episode_number: 2, air_date: day(-1) } };
  // New season premiered 3 days ago.
  details['tv:13'] = { seasons: seasons([[1, '2020-04-15'], [2, '2021-07-30'], [3, '2023-02-23'], [4, day(-3)]]), last_episode_to_air: { season_number: 4, episode_number: 1, air_date: day(-3) } };
  // Season 3 premieres in 12 days (only next_episode_to_air knows; the season has no air_date yet).
  details['tv:14'] = { seasons: seasons([[1, '2021-08-29'], [2, day(-400)]]).concat([{ season_number: 3, air_date: null }]), last_episode_to_air: { season_number: 2, episode_number: 6, air_date: day(-380) }, next_episode_to_air: { season_number: 3, episode_number: 1, air_date: day(12) } };
  details['tv:15'] = { seasons: seasons([[1, '2013-04-23'], [9, day(-200)]]), last_episode_to_air: { season_number: 9, episode_number: 30, air_date: day(-1) } };
  // Season 3 started 60 days ago: outside the default 45-day window, inside 90.
  details['tv:16'] = { seasons: seasons([[1, '2021-01-11'], [2, '2023-07-03'], [3, day(-60)]]), last_episode_to_air: { season_number: 3, episode_number: 9, air_date: day(-4) } };
}
resetCatalog();
async function fakeFetch(url) {
  const u = new URL(url);
  calls.push(u);
  const res = (body, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => body });
  const p = u.pathname.replace('/3', '');
  if (/^\/genre\//.test(p)) return res({ genres: [] });
  if (p === '/discover/movie') return res({ results: movies });
  if (p === '/discover/tv') return res({ results: shows });
  const m = p.match(/^\/(movie|tv)\/(\d+)$/);
  if (m) {
    const k = m[1] + ':' + m[2];
    if (detailFail.has(k)) return res({}, 500);
    const base = (m[1] === 'movie' ? movies : shows).find((x) => String(x.id) === m[2]) || (m[1] === 'tv' ? tv(+m[2], 'Show ' + m[2], '2010-01-01') : mv(+m[2], 'Film ' + m[2], '2010-01-01'));
    return res(Object.assign({}, base, details[k] || {}, { videos: { results: [] } }));
  }
  return res({}, 404);
}
feed._internal.setFetch(fakeFetch);
const tvDetailCalls = (id) => calls.filter((c) => c.pathname === '/3/tv/' + id).length;

(async () => {
  const now = Date.now();
  const W = feed.newWindow({ releasedDays: 45, upcomingDays: 30 });

  // ---- rules (pure) ----
  ok('window: today − 45 … today + 30 (India days)', W.from === day(-45) && W.to === day(30) && W.today === day(0));
  const S = (det) => feed.seriesNews(det, W);
  let q = S({ first_air_date: '2005-04-12', seasons: seasons([[21, day(-120)]]), last_episode_to_air: { season_number: 21, episode_number: 8, air_date: day(-2) }, next_episode_to_air: { season_number: 21, episode_number: 9, air_date: day(5) } });
  ok('old show with a NEW EPISODE (old season) is excluded', q.ok === false && /Old show \(since 2005\)/.test(q.reason), q);
  q = S({ first_air_date: day(-7) });
  ok('brand-new show included (no label)', q.ok && q.kind === 'new-show' && q.seasonLabel === '' && q.date === day(-7) && !q.upcoming, q);
  q = S({ first_air_date: day(9) });
  ok('brand-new show starting in 9 days = upcoming', q.ok && q.kind === 'new-show' && q.upcoming, q);
  q = S({ first_air_date: '2020-04-15', seasons: seasons([[3, '2023-02-23'], [4, day(-3)]]) });
  ok('new season premiere included with "Season 4" label + premiere date', q.ok && q.kind === 'new-season' && q.seasonLabel === 'Season 4' && q.season === 4 && q.date === day(-3) && !q.upcoming, q);
  q = S({ first_air_date: '2021-08-29', seasons: seasons([[2, day(-400)]]), next_episode_to_air: { season_number: 3, episode_number: 1, air_date: day(12) } });
  ok('upcoming season premiere (next episode is S3E1 in 12 days) → "Season 3", upcoming', q.ok && q.seasonLabel === 'Season 3' && q.date === day(12) && q.upcoming, q);
  q = S({ first_air_date: '2021-08-29', seasons: seasons([[2, day(-400)]]), next_episode_to_air: { season_number: 2, episode_number: 7, air_date: day(3) } });
  ok('next episode that is NOT a premiere does not qualify', !q.ok, q);
  q = S({ first_air_date: '2021-08-29', seasons: seasons([[2, day(-400)]]), next_episode_to_air: { season_number: 3, episode_number: 1, air_date: day(31) } });
  ok('season premiere beyond the upcoming window does not qualify', !q.ok, q);
  q = S({ first_air_date: '2015-01-01', seasons: seasons([[4, day(-400)]]), last_episode_to_air: { season_number: 5, episode_number: 1, air_date: day(-2) } });
  ok('season missing from seasons[] but last episode is S5E1 two days ago → Season 5', q.ok && q.seasonLabel === 'Season 5', q);
  q = S({ first_air_date: '2015-01-01', seasons: seasons([[0, day(-1)], [3, day(-900)]]) });
  ok('specials (season 0) never count', !q.ok, q);
  q = S({ first_air_date: '', seasons: seasons([[1, day(-4)]]) });
  ok('no first_air_date but season 1 starts in the window = brand-new show', q.ok && q.kind === 'new-show', q);
  q = S({ first_air_date: '2019-01-01', seasons: seasons([[2, day(-10)], [3, day(20)]]) });
  ok('two premieres in the window: the newest season wins', q.ok && q.seasonLabel === 'Season 3' && q.upcoming, q);
  ok('movies: in window ok (past / upcoming), too old / too far refused', feed.movieNews(day(-44), W).ok && feed.movieNews(day(29), W).upcoming === true && !feed.movieNews(day(-46), W).ok && !feed.movieNews(day(31), W).ok && !feed.movieNews('', W).ok);
  ok('India release date: Digital first, then Theatrical; none → ""', feed.indiaReleaseDate(details['movie:5']) === day(-5) && feed.indiaReleaseDate({ release_dates: { results: [{ iso_3166_1: 'IN', release_dates: [{ type: 3, release_date: '2026-01-02T00:00:00.000Z' }, { type: 1, release_date: '2025-12-01T00:00:00.000Z' }] }] } }) === '2026-01-02' && feed.indiaReleaseDate({ release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-01-02' }] }] } }) === '' && feed.indiaReleaseDate({}) === '');

  // ---- settings ----
  let st = await feed.getSettings();
  ok('defaults: released 45 days, upcoming 30 days, series new shows + new seasons only ON', st.releasedDays === 45 && st.upcomingDays === 30 && st.seriesNewOnly === true);
  let r = await feed.saveSettings({ releasedDays: 500, upcomingDays: -3 });
  ok('settings clamped (1–90, 0–90) and listed as changed', r.ok && r.settings.releasedDays === 90 && r.settings.upcomingDays === 0 && r.changed.includes('released in last N days') && r.changed.includes('upcoming next M days'));
  r = await feed.saveSettings({ releasedDays: 45, upcomingDays: 30, seriesNewOnly: 'false' });
  ok('series switch saved; admin sees rules + run interval', r.ok && r.settings.seriesNewOnly === false && r.settings.runEveryHours === 6 && /series: new shows \+ new seasons only off/.test(r.changed.join()));
  await feed.saveSettings({ seriesNewOnly: true, tmdbKey: 'a'.repeat(32), maxPerDay: 20 });

  // ---- discover ----
  calls.length = 0; feed._internal.reset();
  st = await feed.getSettings();
  let d = await feed.discover(st, ['Netflix']);
  const titles = (x) => x.drafts.map((y) => y.title).sort().join(', ');
  ok('discover: only new / upcoming titles', titles(d) === 'Brand New Show, Fresh Film, India Film, Outer Banks, Soon Film, Vigil', titles(d));
  ok('discover: old titles reported with a reason', d.notNew.map((x) => x.title).sort().join() === 'Deadliest Catch,Far Film,Mushoku Tensei,Old Film,Teen Titans Go!' && /Old show \(since 2005\)/.test(d.notNew.find((x) => x.title === 'Deadliest Catch').reason), d.notNew);
  const dq = calls.filter((c) => /discover/.test(c.pathname));
  ok('discover query: movie primary_release_date and tv air_date = today−45 … today+30', dq.length === 2 && dq.some((c) => c.pathname === '/3/discover/movie' && c.searchParams.get('primary_release_date.gte') === day(-45) && c.searchParams.get('primary_release_date.lte') === day(30)) && dq.some((c) => c.pathname === '/3/discover/tv' && c.searchParams.get('air_date.gte') === day(-45) && c.searchParams.get('air_date.lte') === day(30)));
  ok('brand-new show needs no extra TMDB call; old shows are checked once each', tvDetailCalls(12) === 0 && tvDetailCalls(11) === 1 && tvDetailCalls(13) === 1);
  const ob = d.drafts.find((x) => x.title === 'Outer Banks'); const vg = d.drafts.find((x) => x.title === 'Vigil');
  ok('series drafts carry the season label + premiere date', ob.seasonLabel === 'Season 4' && ob.releaseDate === day(-3) && vg.seasonLabel === 'Season 3' && vg.releaseDate === day(12) && vg.upcoming === true);
  ok('sorted by popularity', d.drafts.map((x) => x.title).join() === 'Fresh Film,Brand New Show,Outer Banks,Vigil,Soon Film,India Film', d.drafts.map((x) => x.title));
  calls.length = 0;
  await feed.discover(st, ['Netflix']);
  ok('tv details cached between runs', tvDetailCalls(11) === 0);
  // Settings respected.
  feed._internal.reset();
  d = await feed.discover(Object.assign({}, st, { releasedDays: 90, upcomingDays: 0 }), ['Netflix']);
  ok('settings: 90 days back / 0 ahead → Mushoku (season 3, 60 days ago) in; upcoming Soon Film + Vigil out; India Film (40 days) in', titles(d) === 'Brand New Show, Fresh Film, India Film, Mushoku Tensei, Old Film, Outer Banks', titles(d));
  calls.length = 0;
  d = await feed.discover(Object.assign({}, st, { seriesNewOnly: false }), ['Netflix']);
  ok('settings: series switch OFF → any show with an episode (old behaviour), no season checks', d.drafts.some((x) => x.title === 'Deadliest Catch') && calls.filter((c) => /^\/3\/tv\//.test(c.pathname)).length === 0);
  const sug = await feed.tmdbSuggest([], 14);
  ok('✨ Suggest uses the same rules (days picked there = released window)', sug.ok && sug.drafts.every((x) => x.title !== 'Deadliest Catch' && x.title !== 'India Film') && sug.drafts.some((x) => x.title === 'Outer Banks') && Array.isArray(sug.notNew), sug.drafts.map((x) => x.title));

  // ---- import ----
  calls.length = 0; feed._internal.reset();
  r = await feed.runImport({ force: true });
  const posts = await feed.list();
  const P = (t) => posts.find((x) => x.title === t);
  ok('import: posts only the new / upcoming titles', r.ok && r.result.imported === 6 && posts.map((x) => x.title).sort().join(', ') === 'Brand New Show, Fresh Film, India Film, Outer Banks, Soon Film, Vigil' && r.result.notNew === 5, [r.result, posts.map((x) => x.title)]);
  ok('import: new season post stores seasonLabel + premiere date', P('Outer Banks').seasonLabel === 'Season 4' && P('Outer Banks').releaseDate === day(-3) && P('Brand New Show').seasonLabel === '');
  ok('import: upcoming season post dated the premiere; hides 30 days after it comes out (not after import)', P('Vigil').seasonLabel === 'Season 3' && P('Vigil').releaseDate === day(12) && Math.round((Date.parse(P('Vigil').hideAfter) - midIST(day(12))) / 86400e3) === 30);
  ok('import: upcoming movie posted, auto-hide from release day; released movie from now', P('Soon Film').releaseDate === day(20) && Math.round((Date.parse(P('Soon Film').hideAfter) - midIST(day(20))) / 86400e3) === 30 && Math.round((Date.parse(P('Fresh Film').hideAfter) - now) / 86400e3) === 30);
  const job = JSON.parse(settings.feed_job);
  ok('import: daily cap counts', job.dayCount === 6 && (await feed.jobStatus()).today === 6);
  // India release date on a movie (released 40 days ago worldwide, 5 days ago in India).
  const importCalls = calls.slice();
  let india = (await feed.list()).find((x) => x.title === 'India Film');
  ok('movie details ask for release_dates; India digital date used + marked IN', india && india.releaseDate === day(-5) && india.releaseRegion === 'IN' && importCalls.some((c) => c.pathname === '/3/movie/5' && /release_dates/.test(c.searchParams.get('append_to_response') || '')), india);
  const j3 = JSON.parse(settings.feed_job); j3.day = '2000-01-01'; settings.feed_job = JSON.stringify(j3);
  r = await feed.runImport({ force: true });
  india = (await feed.list()).find((x) => x.title === 'India Film');
  ok('a later run never swaps the India date back to the worldwide one', india.releaseDate === day(-5) && r.ok);
  // Public feed.
  feed._internal.reset();
  const pub = await feed.publicList();
  const pob = pub.posts.find((x) => x.title === 'Outer Banks');
  ok('public feed: seasonLabel sent, source never revealed', pob && pob.seasonLabel === 'Season 4' && pub.posts.find((x) => x.title === 'Fresh Film').seasonLabel === '' && !/tmdb/i.test(JSON.stringify(pub)) && !/releaseRegion/.test(JSON.stringify(pub)));
  // validate keeps / cleans the label.
  let v = feed.validate({ title: 'X', type: 'series', service: 'Netflix' }, P('Outer Banks'));
  ok('saving without seasonLabel keeps it; junk labels dropped; movies never get one', v.post.seasonLabel === 'Season 4' && feed.validate({ title: 'X', type: 'series', service: 'Netflix', seasonLabel: '<b>S4' }).post.seasonLabel === '' && feed.validate({ title: 'X', type: 'movie', service: 'Netflix', seasonLabel: 'Season 2' }).post.seasonLabel === '');

  // ---- 🧹 cleanup ----
  const yesterday = new Date(now - 86400e3).toISOString();
  const mk = (id, title, type, tmdbKey, releaseDate, o) => Object.assign({ id, title, type, service: 'Netflix', ctaService: 'Netflix', brand: 'Netflix', caption: '', releaseDate, languages: [], genres: [], imageUrl: '', trailerUrl: '', instagramUrl: '', cta: 'service', pinned: false, active: true, publishAt: '', hideAfter: new Date(now + 20 * 86400e3).toISOString(), source: 'tmdb', tmdbKey, importedAt: yesterday, edited: false, createdAt: yesterday, updatedAt: yesterday, seasonLabel: '' }, o || {});
  details['tv:901'] = details['tv:11'];
  details['tv:902'] = details['tv:15'];
  details['tv:903'] = { seasons: seasons([[1, '2020-04-15'], [4, day(-400)]]), last_episode_to_air: { season_number: 4, episode_number: 10, air_date: day(-390) } };
  details['tv:904'] = { seasons: seasons([[1, '2021-08-29'], [2, day(-500)]]) };
  details['tv:905'] = { seasons: seasons([[1, '2023-06-18'], [2, day(-100)]]), last_episode_to_air: { season_number: 2, episode_number: 8, air_date: day(-3) } };
  details['tv:906'] = details['tv:16'];
  details['tv:907'] = { seasons: seasons([[1, '2016-07-15'], [5, day(-2)]]) };
  settings.feed_posts = JSON.stringify([
    mk('fpc1', 'Deadliest Catch', 'series', 'tv:901', '2005-04-12'),
    mk('fpc2', 'Teen Titans Go!', 'series', 'tv:902', '2013-04-23'),
    mk('fpc3', 'Outer Banks', 'series', 'tv:903', '2020-04-15'),
    mk('fpc4', 'Vigil', 'series', 'tv:904', '2021-08-29', { edited: true }),
    mk('fpc5', 'The Walking Dead: Dead City', 'series', 'tv:905', '2023-06-18'),
    mk('fpc6', 'Mushoku Tensei', 'series', 'tv:906', '2021-01-11'),
    mk('fpc7', 'Stranger Things', 'series', 'tv:907', '2016-07-15'), // old show, real new season 2 days ago → stays
    mk('fpc8', 'Brand New Show', 'series', 'tv:12', day(-7)),
    mk('fpc9', 'Season Post', 'series', 'tv:13', day(-3), { seasonLabel: 'Season 4' }),
    mk('fpc10', 'Old Movie', 'movie', 'movie:77', '2019-05-01'),
    mk('fpc11', 'Fresh Movie', 'movie', 'movie:78', day(-12)),
    mk('fpc12', 'Already Hidden Old Show', 'series', 'tv:901', '2005-04-12', { hideAfter: new Date(now - 3600e3).toISOString() }),
    mk('fpc13', 'Manual Post', 'series', '', '2005-04-12', { source: 'manual' }),
    mk('fpc14', 'TMDB Down Show', 'series', 'tv:908', '2011-01-01'),
  ]);
  detailFail.add('tv:908');
  feed._internal.reset();
  const cl = await feed.notNewCandidates();
  const cands = cl.candidates.map((x) => x.title).sort().join(', ');
  ok('cleanup lists exactly the old titles imported by mistake (the six + an old movie)', cands === 'Deadliest Catch, Mushoku Tensei, Old Movie, Outer Banks, Teen Titans Go!, The Walking Dead: Dead City, Vigil', cands);
  ok('cleanup: real new season / brand-new / labelled / fresh / hidden / manual posts not listed; TMDB errors counted as unchecked', !/Stranger|Brand New|Season Post|Fresh Movie|Already Hidden|Manual/.test(cands) && cl.unchecked === 1 && cl.checked === 12, cl);
  ok('cleanup: each has a reason; edited posts flagged', cl.candidates.every((x) => x.reason) && cl.candidates.find((x) => x.title === 'Vigil').edited === true && /^Old show \(since \d{4}\) — latest season 21 started /.test(cl.candidates.find((x) => x.title === 'Deadliest Catch').reason), cl.candidates);
  ok('cleanup is read-only (nothing saved)', JSON.parse(settings.feed_posts).every((p) => p.hiddenBy === undefined));

  // admin routes
  const routes = {}; const audits = []; let authed = false;
  require('../adminfeed').mount({ get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } }, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (rq, a) => audits.push(a) }, feed, comments: { adminList: async () => ({ ready: false, counts: {}, byPost: {} }) } });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; Promise.resolve(routes[m + ' ' + p]({ body, query: {} }, res)); });
  let x = await call('GET', '/admin/api/feed/cleanup/not-new');
  const x2 = await call('POST', '/admin/api/feed/cleanup/hide', { ids: ['fpc1'] });
  ok('cleanup routes need admin sign-in', x.code === 403 && x2.code === 403);
  authed = true;
  x = await call('GET', '/admin/api/feed/cleanup/not-new');
  ok('GET cleanup list', x.code === 200 && x.body.ok && x.body.candidates.length === 7);
  const before = (await feed.list()).length;
  x = await call('POST', '/admin/api/feed/cleanup/hide', { ids: x.body.candidates.filter((c) => !c.edited).map((c) => c.id).concat(['fpc13', 'nope']) });
  const after = await feed.list();
  const hiddenNow = after.filter((p) => feed.statusOf(p) === 'HIDDEN' && p.hiddenBy === 'cleanup').map((p) => p.title).sort().join(', ');
  ok('hide selected: hidden (not deleted), manual / unknown ids skipped', x.body.ok && x.body.hidden.length === 6 && x.body.skipped === 2 && after.length === before && hiddenNow === 'Deadliest Catch, Mushoku Tensei, Old Movie, Outer Banks, Teen Titans Go!, The Walking Dead: Dead City' && feed.statusOf(after.find((p) => p.id === 'fpc13')) === 'LIVE', [x.body, hiddenNow]);
  ok('hide selected: change log names the titles', audits.length === 1 && audits[0].action === 'feed.cleanup.hide' && /Hid 6 old imported/.test(audits[0].summary) && /"Deadliest Catch"/.test(audits[0].summary));
  feed._internal.reset();
  ok('hidden posts leave the customer feed; the edited one (not ticked) stays', !(await feed.publicList()).posts.some((p) => /Deadliest|Teen Titans|Outer Banks/.test(p.title)) && (await feed.publicList()).posts.some((p) => p.title === 'Vigil'));
  x = await call('POST', '/admin/api/feed/cleanup/hide', { ids: ['fpc1'] });
  ok('hiding again does nothing, no change log', x.body.ok && x.body.hidden.length === 0 && audits.length === 1);
  x = await call('POST', '/admin/api/feed/cleanup/hide', { ids: [] });
  ok('nothing ticked → 400', x.code === 400);
  ok('hidden posts are never imported again (still known)', (await feed.list()).some((p) => p.tmdbKey === 'tv:901'));
  x = await call('GET', '/admin/api/feed/cleanup/not-new');
  ok('after hiding, the list only has the edited post left', x.body.candidates.map((c) => c.title).join() === 'Vigil');

  // ---- storefront + share + admin page ----
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fnIn = (src, name) => { const a = src.indexOf('function ' + name + '('); let i = src.indexOf('{', a); let depth = 0; for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; } return src.slice(a, i + 1); };
  const fn = (name) => fnIn(html, name);
  const H = new Function(fn('feedRelease_') + fn('feedSeasonChip_') + '; return { feedRelease_, feedSeasonChip_ };')();
  const soon = H.feedRelease_(day(12), 'movie');
  ok('feed: upcoming = "🗓️ Coming soon · DD Mon"', /^🗓️ Coming soon · \d{1,2} [A-Z][a-z]+$/.test(soon), soon);
  ok('feed: upcoming new season = "🗓️ Season 3 coming DD Mon"', /^🗓️ Season 3 coming \d{1,2} [A-Z][a-z]+$/.test(H.feedRelease_(day(12), 'series', 0, 'Season 3')));
  ok('feed: flips by itself after the date (no re-post)', /^🎬 Released /.test(H.feedRelease_(day(12), 'movie', midIST(day(13)))) && /^🆕 Season 3 streaming since /.test(H.feedRelease_(day(12), 'series', midIST(day(13)), 'Season 3')));
  ok('feed chip: "🆕 Season 4" live, "🗓️ Season 3" before; none for movies / junk', H.feedSeasonChip_({ type: 'series', seasonLabel: 'Season 4', releaseDate: day(-3) }) === '🆕 Season 4' && H.feedSeasonChip_({ type: 'series', seasonLabel: 'Season 3', releaseDate: day(12) }) === '🗓️ Season 3' && H.feedSeasonChip_({ type: 'movie', seasonLabel: 'Season 3' }) === '' && H.feedSeasonChip_({ type: 'series', seasonLabel: '<img>' }) === '');
  ok('feed card renders the chip next to the platform name', /seasonChip && React\.createElement\("span", \{\s*className: "ff-feed-season"\s*\}, seasonChip\)/.test(html) && /const rel = feedRelease_\(p\.releaseDate, p\.type, 0, p\.seasonLabel\);/.test(html) && /\.ff-feed-season \{/.test(html));
  const a = html.indexOf('const shareText_ = {'); const b = html.indexOf('function copyText_(');
  const T = new Function(html.slice(a, b) + '; return shareText_;')();
  const catalog = { plans: [{ service: 'Netflix', plan: '1M', price: 139 }], levels: null };
  const nowT = Date.now();
  let m = T.post({ title: 'Outer Banks', type: 'series', service: 'Netflix', brand: 'Netflix', releaseDate: day(-3), seasonLabel: 'Season 4' }, null, nowT, catalog);
  ok('share: "🆕 Season 4 now streaming on *Netflix*"', m.text.split('\n')[1].startsWith('🆕 Season 4 now streaming on *Netflix*  •  📺 Series'), m.text);
  m = T.post({ title: 'Vigil', type: 'series', service: 'Netflix', brand: 'Netflix', releaseDate: day(12), seasonLabel: 'Season 3' }, null, nowT, catalog);
  ok('share: upcoming season "🗓️ Season 3 coming *DD Mon* on *Netflix*"', /^🗓️ Season 3 coming \*\d{1,2} [A-Z][a-z]+\.?\* on \*Netflix\*/.test(m.text.split('\n')[1]) && /Get ready/.test(m.text), m.text);
  m = T.post({ title: 'Fresh', type: 'movie', service: 'Netflix', releaseDate: day(-3), seasonLabel: 'Season 4' }, null, nowT, catalog);
  ok('share: movies ignore a season label', /^🔴 Now streaming on \*Netflix\*/.test(m.text.split('\n')[1]), m.text);
  const shareSrc = fs.readFileSync(path.join(ROOT, 'share.js'), 'utf8');
  ok('link preview title names the season', /' ' \+ s\(p\.seasonLabel\)/.test(shareSrc));
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const adminScripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]);
  let parsed = true; for (const sc of adminScripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   admin parse error:', e.message); } }
  ok('admin page script parses', parsed && adminScripts.length > 0);
  ok('admin settings: released N / upcoming M / series switch with plain-English help, all saved', /id="fdreld"/.test(admin) && /id="fdupd"/.test(admin) && /id="fdsernew"/.test(admin) && /Series: new shows \+ new seasons only/.test(admin) && /releasedDays: \$\('#fdreld'\)\.value, upcomingDays: \$\('#fdupd'\)\.value, seriesNewOnly: \$\('#fdsernew'\)\.checked/.test(admin) && /Old shows that just release a weekly episode are left out/.test(admin));
  const fjw = new Function(fnIn(admin, 'fdJobWhat') + '; return fdJobWhat;')();
  ok('import card: "Runs every 6 h · imports up to X new posts per day · Today: 7/7"', fjw({ runEveryHours: 6, maxPerDay: 7 }, { today: 7 }).replace(/<[^>]+>/g, '') === 'Runs every 6 h · imports up to 7 new posts per day · Today: 7/7');
  ok('admin: 🧹 cleanup button → list with checkboxes → hide selected (confirm)', /id="fdclean">🧹 Hide old titles imported by mistake</.test(admin) && /if \(b\.id === 'fdclean'\) return fdCleanup\(\);/.test(admin) && /api\('\/admin\/api\/feed\/cleanup\/not-new'\)/.test(admin) && /data-clid=/.test(admin) && /post\('\/admin\/api\/feed\/cleanup\/hide', \{ ids: ids \}\)/.test(admin) && /if \(!confirm\('Hide ' \+ ids\.length/.test(admin));

  console.log('\n---------------------------------------');
  console.log('feed-new-only: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
