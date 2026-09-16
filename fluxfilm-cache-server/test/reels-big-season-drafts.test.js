/* Three owner fixes (16 Sep 2026):
   1. 🎬 Longer / bigger Reel videos — admin-set caps (5 min / 60 MB / 2 GB, up to 10 min / 150 MB / 5 GB), errors that
      name the real size and length, resumable chunk upload (status → have / missing / next), and the admin page's
      progress %, Cancel, retries and optional browser compression.
   2. ✨ AI fill picks the LATEST season of a series (TMDB mocked): 5 seasons → 5, a season next week → "coming",
      movies unaffected.
   3. 📝 Admin drafts: saved while typing, restored after the app is swapped out, 24 h expiry, discard, never a secret,
      the "new version" bar held back while a form is dirty, and the screen remembered.
   DB + TMDB mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MB = 1024 * 1024;

// ---------- in-memory DB ----------
const T = { settings: {}, videos: {}, chunks: {} };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings WHERE setting_key = \?/.test(sql)) { delete T.settings[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT service, price, logo_url, is_active, raw_json FROM plans$/.test(sql)) return [{ service: 'Netflix', price: 139, logo_url: '', is_active: 'TRUE', raw_json: '{}' }];
    if (sql === 'SELECT id FROM feed_videos LIMIT 1') return Object.keys(T.videos).slice(0, 1).map((id) => ({ id }));
    if (sql === 'SELECT video_id FROM feed_video_chunks LIMIT 1') return [];
    if (/^SELECT id FROM feed_videos WHERE status = \? AND created_at < \?$/.test(sql)) return [];
    if (sql === 'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feed_videos') return [{ n: Object.values(T.videos).reduce((a, v) => a + v.size_bytes, 0) }];
    if (/^INSERT INTO feed_videos/.test(sql)) { T.videos[p[0]] = { id: p[0], mime: p[1], size_bytes: p[2], chunks: p[3], sha256: p[4], duration_s: p[5], status: p[6], created_at: p[7] }; return { affectedRows: 1 }; }
    if (/^SELECT id, mime, size_bytes, chunks, sha256, duration_s, status, created_at FROM feed_videos WHERE id = \? LIMIT 1$/.test(sql)) return T.videos[p[0]] ? [Object.assign({}, T.videos[p[0]])] : [];
    if (/^INSERT INTO feed_video_chunks/.test(sql)) { T.chunks[p[0] + '|' + p[1]] = Buffer.from(p[2]); return { affectedRows: 1 }; }
    if (/^SELECT n FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) return Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')).map((k) => ({ n: Number(k.split('|')[1]) }));
    if (/^SELECT COUNT\(\*\) AS c, COALESCE\(SUM\(LENGTH\(data\)\), 0\) AS b FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) { const ks = Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')); return [{ c: ks.length, b: ks.reduce((a, k) => a + T.chunks[k].length, 0) }]; }
    if (/^SELECT data FROM feed_video_chunks WHERE video_id = \? AND n = \? LIMIT 1$/.test(sql)) { const b = T.chunks[p[0] + '|' + p[1]]; return b ? [{ data: b }] : []; }
    if (/^UPDATE feed_videos SET status = \? WHERE id = \?$/.test(sql)) { if (T.videos[p[1]]) T.videos[p[1]].status = p[0]; return { affectedRows: 1 }; }
    if (/^DELETE FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) { const ks = Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')); ks.forEach((k) => delete T.chunks[k]); return { affectedRows: ks.length }; }
    if (/^DELETE FROM feed_videos WHERE id = \?$/.test(sql)) { delete T.videos[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT id, mime, size_bytes, duration_s, status, created_at FROM feed_videos ORDER BY/.test(sql)) return Object.values(T.videos).map((v) => Object.assign({}, v));
    if (/feed_comments|feed_likes|feed_saves/.test(sql)) throw new Error("Table 'x.feed_comments' doesn't exist");
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const vid = require('../feedvideo');
const feed = require('../feed');
const feedai = require('../feedai');

const mp4 = (size) => { const b = crypto.randomBytes(size); b.write('\0\0\0\x18ftypisom', 0, 'latin1'); return b; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const admin = read('admin.html');

// ---------- fake TMDB ----------
const details = {}; const search = {}; const seasonRows = {}; const calls = [];
async function fakeFetch(url) {
  const u = new URL(url); calls.push(u.pathname);
  const res = (body, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => body });
  const p = u.pathname.replace('/3', '');
  if (/^\/genre\//.test(p)) return res({ genres: [] });
  if (p === '/search/multi') return res({ results: search[String(u.searchParams.get('query')).toLowerCase()] || [] });
  let m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/);
  if (m) return res(seasonRows[m[1] + ':' + m[2]] || {}, seasonRows[m[1] + ':' + m[2]] ? 200 : 404);
  if (/watch\/providers$/.test(p)) return res({ results: {} });
  m = p.match(/^\/(movie|tv)\/(\d+)$/);
  if (m && details[m[1] + ':' + m[2]]) return res(Object.assign({ id: +m[2], videos: { results: [] }, credits: { cast: [], crew: [] } }, details[m[1] + ':' + m[2]]));
  return res({}, 404);
}
feed._internal.setFetch(fakeFetch);
const day = (n) => new Date(Date.now() + n * 86400e3 + 330 * 60000).toISOString().slice(0, 10);
const seasonsOf = (list) => list.map(([n, date, eps, name]) => ({ season_number: n, air_date: date, episode_count: eps || 8, name: name || 'Season ' + n, overview: '' }));

(async () => {
  // ================================================================= 1. bigger / longer reels
  section('🎬 Reel videos: bigger, longer, resumable');
  ok('defaults raised: 60 MB per video, 5 minutes, 2 GB total; caps 150 MB / 10 min / 5 GB',
    vid.DEFAULT_MAX_MB === 60 && vid.DEFAULT_MAX_SECONDS === 300 && vid.DEFAULT_TOTAL_MB === 2048 && vid.HARD_MAX_MB === 150 && vid.HARD_MAX_SECONDS === 600 && vid.HARD_TOTAL_MB === 5120,
    { m: vid.DEFAULT_MAX_MB, s: vid.DEFAULT_MAX_SECONDS, caps: vid.CAPS });
  ok('sizes and lengths are written the way the owner reads them', vid.mbText(78 * MB) === '78 MB' && vid.mbText(1.8 * 1024 * MB) === '1.8 GB' && vid.durText(45) === '45 seconds' && vid.durText(78) === '1 min 18 s' && vid.durText(300) === '5 minutes');

  let r = await vid.start({ mime: 'video/mp4', size: 78 * MB, sha256: 'a'.repeat(64), duration: 78 });
  ok("the owner's 78 MB Instagram trailer: named size, named limit, the way out", r.ok === false && r.tooBig && r.message === '78 MB — the limit is 60 MB. Try 720p, or raise the limit in ⚙️ settings.', r);
  r = await vid.start({ mime: 'video/mp4', size: 20 * MB, sha256: 'a'.repeat(64), duration: 200 });
  ok('the trimmed 90 s problem is gone: 3 min 20 s now uploads', r.ok, r);
  r = await vid.start({ mime: 'video/mp4', size: 20 * MB, sha256: 'a'.repeat(64), duration: 620 });
  ok('over the 5-minute default: refused, naming the real length and the limit', r.ok === false && r.tooLong && r.seconds === 620 && /10 min 20 s/.test(r.message) && /5 minutes/.test(r.message), r);
  ok('the owner can raise the length to 10 minutes but no further', (await vid.saveLimits({ videoMaxSeconds: 600 })).ok && !(await vid.saveLimits({ videoMaxSeconds: 601 })).ok);
  ok('…then the 10 min 20 s video is still refused, a 9-minute one is fine', !(await vid.start({ mime: 'video/mp4', size: MB, sha256: 'a'.repeat(64), duration: 620 })).ok && (await vid.start({ mime: 'video/mp4', size: MB, sha256: 'a'.repeat(64), duration: 540 })).ok);
  await vid.saveLimits({ videoMaxSeconds: 300, videoMaxMb: 60, videoTotalMb: 2048 });
  ok('the total-storage message says how much is free and warns about the database', /5120 MB \(5 GB\) — it all sits in the MySQL database/.test((await vid.saveLimits({ videoTotalMb: 99999 })).message));

  // storage is full → the error says how much room is left
  T.videos = {}; T.chunks = {};
  T.videos.fvffffffffffffffff = { id: 'fvffffffffffffffff', mime: 'video/mp4', size_bytes: 2040 * MB, chunks: 2040, sha256: 'b'.repeat(64), status: 'ready', created_at: '2026-09-15 10:00:00' };
  r = await vid.start({ mime: 'video/mp4', size: 30 * MB, sha256: 'a'.repeat(64), duration: 60 });
  ok('storage full: the error names the free space and this video\'s size', r.ok === false && r.full && /8 MB free of 2 GB, this video needs 30 MB/.test(r.message), r);
  let u = await vid.usage();
  ok('usage tells the page the free space and the caps it may type', u.ready && u.freeBytes === 8 * MB && u.caps.maxMb === 150 && u.caps.maxSeconds === 600 && u.maxSeconds === 300, u);
  delete T.videos.fvffffffffffffffff;

  // resume
  const file = mp4(3 * MB);
  r = await vid.start({ mime: 'video/mp4', size: file.length, sha256: sha(file), duration: 200 });
  const id = r.id;
  ok('start tells the page the length limit too', r.chunks === 3 && r.maxSeconds === 300, r);
  await vid.chunk(id, 0, file.slice(0, MB));
  await vid.chunk(id, 2, file.slice(2 * MB));
  let st = await vid.status(id);
  ok('📶 resume: the server says which parts it has, which are missing and where to carry on', st.ok && st.done === false && JSON.stringify(st.have) === '[0,2]' && JSON.stringify(st.missing) === '[1]' && st.next === 1 && st.chunks === 3 && st.chunkSize === MB, st);
  await vid.chunk(id, 1, file.slice(MB, 2 * MB));
  st = await vid.status(id);
  ok('…nothing missing → next = the number of parts, so the page goes straight to finish', st.next === 3 && st.missing.length === 0, st);
  r = await vid.finish(id);
  ok('finish still checks size + SHA-256 and the parts are the original file', r.ok && Buffer.concat([0, 1, 2].map((n) => T.chunks[id + '|' + n])).equals(file), r);
  st = await vid.status(id);
  ok('status of a finished upload says done (never re-uploads it)', st.ok && st.done === true && st.url === '/v/' + id + '.mp4', st);
  ok('status of an unknown id is refused, never throws', !(await vid.status('fv0000000000000000')).ok && !(await vid.status('nonsense')).ok);

  // still streams with Range + the poster frame still works
  const res = { headers: {}, body: [], code: 0, status(c) { this.code = c; return this; }, set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; }, type() { return this; }, send() { return this; }, write(b) { this.body.push(Buffer.from(b)); return true; }, end() {}, once() {}, destroy() {} };
  await vid.serve({ params: { file: id + '.mp4' }, headers: { range: 'bytes=1048576-' }, method: 'GET' }, res);
  ok('playback: Range still answers 206 with Accept-Ranges, an ETag and only the chunks it needs', res.code === 206 && res.headers['Accept-Ranges'] === 'bytes' && /^bytes 1048576-/.test(res.headers['Content-Range']) && !!res.headers.ETag && Buffer.concat(res.body).length <= 2 * MB, { code: res.code, h: res.headers });
  ok('admin page: the poster button still grabs a frame of the uploaded video', /id="fdvidposter"/.test(admin) && /cv\.getContext\('2d'\)\.drawImage\(vid, 0, 0, cv\.width, cv\.height\);/.test(admin) && /Frame saved as the picture/.test(admin));

  section('🎬 admin page: limits shown, progress, cancel, retry, compress');
  ok('the upload box shows the two limits and the free space', /up to <b>' \+ fdMb\(v\.maxBytes \|\| 62914560\) \+ '<\/b> and <b>' \+ fdSecs\(v\.maxSeconds \|\| 300\)/.test(admin) && /free<\/b> of ' \+ fdMb\(v\.totalBytes\)/.test(admin));
  ok('too big / too long: a clear error naming the real size or length, with the way out', /fdMb\(file\.size\) \+ ' — the limit is ' \+ fdMb\(maxB\) \+ '\. Try 720p, or raise the limit in ⚙️ settings/.test(admin) && /fdSecs\(dur\) \+ ' — the limit is ' \+ fdSecs\(maxS\) \+ '\. Trim it/.test(admin) && /only ' \+ fdMb\(free\) \+ ' of storage is free/.test(admin));
  ok('upload: progress %, a progress bar and a Cancel button', /function fdUploadProgress\(job, pct, what\)/.test(admin) && /⏳ Uploading… ' \+ p \+ '%/.test(admin) && /class="fd-upbar"/.test(admin) && /id="fdvidcancel"/.test(admin) && /\.fd-upbar\{/.test(admin));
  ok('upload: 4 tries a part, each part asks the server what it already has before retrying, 60 s per part and a 20-minute overall guard', /FD_UP_TRIES = 4, FD_UP_PART_MS = 60000, FD_UP_MAX_MS = 20 \* 60000/.test(admin) && /\/admin\/api\/feed\/video\/status\?id=/.test(admin) && /if \(st && st\.ok && !st\.done && typeof st\.next === 'number'\) \{ n = st\.next;/.test(admin) && /Date\.now\(\) - t0 > FD_UP_MAX_MS/.test(admin) && /new AbortController\(\)/.test(admin));
  ok('upload: the body is one ~1 MB slice at a time (never the whole file)', /body: part, signal: ctrl \? ctrl\.signal : undefined/.test(admin) && /file\.slice\(n \* r\.chunkSize/.test(admin));
  ok('compress in the browser: MediaRecorder + canvas at 720p (480p for very big), original sound, before → after size, "this can take a minute"', /function fdCompressVideo\(file, dur, targetBytes, done\)/.test(admin) && /new MediaRecorder\(stream, \{ mimeType: type, videoBitsPerSecond: videoBps, audioBitsPerSecond: audioBps \}\)/.test(admin) && /cv\.captureStream\(30\)/.test(admin) && /createMediaElementSource\(el\)\.connect\(dest\)/.test(admin) && /file\.size > targetBytes \* 2 \? 480 : 720/.test(admin) && /Compressed ' \+ fdMb\(file\.size\) \+ ' → <b>' \+ fdMb\(out\.size\)/.test(admin) && /this can take a minute/.test(admin));
  ok('compression is optional: no MediaRecorder → no button, just the size advice', /function fdCanCompress\(\)/.test(admin) && /fdCanCompress\(\) && file\.size <= maxB \* 4/.test(admin) && /Export the Reel at 720p from your editing app/.test(admin));
  ok('the 🎬 Videos card lets the owner set all three limits and warns about disk + database', /id="fdvidmax"/.test(admin) && /id="fdvidsecs"/.test(admin) && /id="fdvidtotal"/.test(admin) && /videoMaxSeconds: Number\(\$\('#fdvidsecs'\)\.value\)/.test(admin) && /Big videos fill the Hostinger disk and make the database backup slow/.test(admin) && /MB × 30 reels ≈/.test(admin));
  // Run the page's upload loop for real (fake fetch): a part that fails is retried after asking what the server has.
  const upSrc = admin.slice(admin.indexOf('var FD_UP = null;'), admin.indexOf('// 🗜️ Shrink in the browser'));
  ok('the upload loop was found in admin.html', upSrc.length > 500 && /function fdUploadVideo/.test(upSrc));
  const runUpload = (plan) => new Promise((resolve) => {
    const log = []; const hold = {};
    let cancelBtn = null;
    const digest = async () => new Uint8Array(32).buffer;
    const win = { crypto: { subtle: { digest } }, AbortController: function () { this.signal = {}; this.abort = () => {}; } };
    const fakeFile = { type: 'video/mp4', size: 3 * MB, name: 'reel.mp4', slice: (a, b) => ({ from: a, to: b }), arrayBuffer: async () => new ArrayBuffer(8) };
    const jres = (body) => ({ json: async () => body });
    const fakeFetch = async (url) => {
      if (url.indexOf('/video/status') >= 0) { log.push('status'); return jres(plan.status); }
      const n = Number(String(url).match(/n=(\d+)/)[1]);
      log.push('chunk' + n);
      if (plan.failFirst && n === plan.failFirst.n && !plan.failFirst.done) { plan.failFirst.done = true; throw new Error('network'); }
      if (plan.cancelAfter === n && hold.api) hold.api.cancel(); // the owner taps Cancel while this part is in the air
      return jres({ ok: true, n });
    };
    const fakePost = async (p) => {
      log.push(p.split('/').pop());
      if (/start/.test(p)) return { ok: true, id: 'fv0000000000000001', chunks: 3, chunkSize: MB, maxBytes: 60 * MB, maxSeconds: 300 };
      return { ok: true, id: 'fv0000000000000001', url: '/v/fv0000000000000001.mp4', mime: 'video/mp4', size: 3 * MB };
    };
    const fake$ = (sel) => (sel === '#fdvidcancel' ? (cancelBtn = { onclick: null }) : null);
    const slowly = (fn, ms) => setTimeout(fn, ms >= 60000 ? ms : 0); // keep the 60 s per-part guard, skip the retry wait
    const api = new Function('window', 'crypto', 'fetch', 'post', 'handle', '$', 'esc', 'fdVidMsg', 'setTimeout', 'onProgress',
      upSrc + '; return { fdUploadVideo: fdUploadVideo, cancel: function () { if (FD_UP) { FD_UP.cancel = true; if (FD_UP.abort) FD_UP.abort(); } } };'
    )(win, win.crypto, fakeFetch, fakePost, (r) => r.json(), fake$, (x) => String(x), () => {}, slowly, null);
    hold.api = api;
    api.fdUploadVideo(fakeFile, 42, (r) => resolve({ r, log, cancelBtn }));
  });
  let up = await runUpload({ failFirst: { n: 1 }, status: { ok: true, done: false, chunks: 3, chunkSize: MB, have: [0], missing: [1, 2], next: 1 } });
  ok('a part that fails is retried from where it stopped: chunk1 fails → status → chunk1 again → chunk2 → finish, and the upload succeeds',
    up.r.ok && up.log.join(',') === 'start,chunk0,chunk1,status,chunk1,chunk2,finish', { r: up.r, log: up.log });
  ok('the page offers Cancel on every progress step', !!up.cancelBtn && typeof up.cancelBtn.onclick === 'function');
  up = await runUpload({ status: { ok: true, done: false, chunks: 3, chunkSize: MB, have: [], missing: [0, 1, 2], next: 0 } });
  ok('a plain upload sends the three parts in order and finishes', up.r.ok && up.log.join(',') === 'start,chunk0,chunk1,chunk2,finish', up.log);
  up = await runUpload({ cancelAfter: 0, status: { ok: true, done: false, chunks: 3, chunkSize: MB, have: [0], missing: [1, 2], next: 1 } });
  ok('Cancel stops it at once: no more parts, no finish, and the page is told it was cancelled', up.r.ok === false && up.r.cancelled === true && up.log.join(',') === 'start,chunk0', { r: up.r, log: up.log });

  const af = read('adminfeed.js');
  ok('admin routes: the resume status is a GET behind the admin key, and settings pass the new length', /app\.get\('\/admin\/api\/feed\/video\/status', async \(req, res\) => \{\s*if \(!auth\(req, res\)\) return;/.test(af) && /videoMaxSeconds: b\.videoMaxSeconds/.test(af));

  // ================================================================= 2. latest season
  section('✨ AI fill: the LATEST season of a series');
  const old5 = { name: 'Long Runner', first_air_date: '2016-03-04', poster_path: '/p.jpg', seasons: seasonsOf([[0, '2016-01-01', 3, 'Specials'], [1, '2016-03-04'], [2, '2018-02-02'], [3, '2020-05-05'], [4, '2022-06-06'], [5, '2024-08-08', 10, 'The Last Ride']]) };
  let ls = feed.latestSeason(old5);
  ok('5 seasons, all aired → season 5 (its name, episodes and date), not coming, specials ignored', ls && ls.number === 5 && ls.name === 'The Last Ride' && ls.episodes === 10 && ls.airDate === '2024-08-08' && ls.coming === false, ls);
  const soon = { name: 'Next Week', first_air_date: '2019-01-01', poster_path: '/p.jpg', seasons: seasonsOf([[1, '2019-01-01'], [2, '2021-01-01'], [3, day(7), 8, 'Season 3']]) };
  ls = feed.latestSeason(soon);
  ok('a season starting next week wins and is flagged coming (with the days)', ls && ls.number === 3 && ls.coming === true && ls.days === 7 && ls.airDate === day(7), ls);
  ls = feed.latestSeason({ seasons: seasonsOf([[1, '2019-01-01'], [2, '2021-01-01'], [3, day(90)]]) });
  ok('a season 3 months away does NOT steal the badge — the latest AIRED season does', ls && ls.number === 2 && ls.coming === false, ls);
  ls = feed.latestSeason({ first_air_date: '2015-01-01', seasons: seasonsOf([[1, '2015-01-01']]), last_episode_to_air: { season_number: 7, episode_number: 1, air_date: day(-40) } });
  ok('a newer season TMDB only lists on last_episode_to_air is still found', ls && ls.number === 7 && ls.airDate === day(-40), ls);
  ok('no dated season at all → null (nothing invented)', feed.latestSeason({ name: 'X' }) === null && feed.latestSeason(null) === null);
  ok('showDates on an old 5-season show: season 5 and its date, never season 1', JSON.stringify(feed.showDates(old5)) === JSON.stringify({ releaseDate: '2024-08-08', seasonLabel: 'Season 5' }));
  ok('a brand-new show still just gets its premiere (no "Season 1" badge)', JSON.stringify(feed.showDates({ first_air_date: day(-10), seasons: seasonsOf([[1, day(-10)]]) })) === JSON.stringify({ releaseDate: day(-10), seasonLabel: '' }));

  await feed.saveSettings({ tmdbKey: 'a'.repeat(32) });
  details['tv:50'] = old5;
  seasonRows['50:5'] = { overview: 'The crew face their last job together.', name: 'The Last Ride', episode_count: 10, air_date: '2024-08-08' };
  search['long runner'] = [{ media_type: 'tv', id: 50, name: 'Long Runner', original_name: 'Long Runner', first_air_date: '2016-03-04', poster_path: '/p.jpg', popularity: 40 }];
  let match = await feed.tmdbMatch('Long Runner', { type: 'series' });
  ok('tmdbMatch: the post is dated and badged from the LATEST season', match && match.seasonLabel === 'Season 5' && match.releaseDate === '2024-08-08', match && { l: match.seasonLabel, d: match.releaseDate });
  ok('…and the AI facts carry that season: number, name, episodes, date and its own overview (one extra TMDB call)', match.story.season && match.story.season.number === 5 && match.story.season.name === 'The Last Ride' && match.story.season.episodes === 10 && /last job together/.test(match.story.season.overview) && calls.includes('/3/tv/50/season/5'), match.story.season);
  let facts = feedai._internal.factLines(match.story);
  ok('the prompt Facts name the latest season and its story', /LATEST SEASON: Season 5 — "The Last Ride" · 10 episodes · started 2024-08-08/.test(facts) && /Season 5 story: The crew face their last job together\./.test(facts), facts);
  let rule = feedai._internal.seasonRule(match.story);
  ok('the model is told to write about Season 5 and never Season 1', /newest season is Season 5/.test(rule) && /Do not write about Season 1 unless Season 5 IS season 1/.test(rule), rule);
  ok('that rule really reaches the model (system message of the prompt)', /newest season is Season 5/.test(feedai._internal.prompt('Long Runner', 'Long Runner', ['English'], match.story, {})[0].content));

  // a season airing next week
  details['tv:51'] = soon;
  seasonRows['51:3'] = { overview: 'Everything changes.' };
  search['next week'] = [{ media_type: 'tv', id: 51, name: 'Next Week', original_name: 'Next Week', first_air_date: '2019-01-01', poster_path: '/p.jpg', popularity: 30 }];
  match = await feed.tmdbMatch('Next Week', { type: 'series' });
  facts = feedai._internal.factLines(match.story); rule = feedai._internal.seasonRule(match.story);
  ok('a season next week: the facts say COMING SOON with the real date, and the badge / date are that season', facts.indexOf('LATEST SEASON: Season 3 · 8 episodes · starts ' + day(7) + ' (in 7 days — COMING SOON)') >= 0 && match.seasonLabel === 'Season 3' && match.releaseDate === day(7), { facts, l: match.seasonLabel, d: match.releaseDate });
  ok('…and the model is told to write it as coming ("Season 3 lands …")', rule.indexOf('as something COMING: say it starts on ' + day(7) + ' (in 7 days)') >= 0 && rule.indexOf('Season 3 lands ' + day(7)) >= 0, rule);

  // aiFill end to end (stub model)
  let seen = null;
  const stub = async (msgs) => { seen = msgs; return { json: { title: 'Long Runner', caption: 'Season 5 is the last ride 🚗', angle: 'new season', genres: ['Drama'], languages: ['English'], type: 'series' }, tokens: 10 }; };
  let out = await feedai.aiFill({ title: 'Long Runner', type: 'series' }, { model: stub, modelName: 'Test', feed });
  ok('✨ AI fill on a series: fields.seasonLabel = the latest season, and a note tells the owner which one was used', out.ok && out.fields.seasonLabel === 'Season 5' && out.fields.releaseDate === '2024-08-08' && out.season.number === 5 && out.notes.some((n) => /Written about Season 5 \(10 episodes, from 2024-08-08\) — the newest one\./.test(n)), { f: out.fields, n: out.notes });
  ok('…and the season rule was really in the prompt sent to the model', /newest season is Season 5/.test(seen[0].content));
  out = await feedai.aiFill({ title: 'Next Week', type: 'series' }, { model: stub, modelName: 'Test', feed });
  ok('a coming season: the note says "coming" with the date, the badge is Season 3', out.fields.seasonLabel === 'Season 3' && out.season.coming === true && out.notes.some((n) => n.indexOf('Newest season: Season 3 — coming ' + day(7) + ' (in 7 days)') >= 0), { n: out.notes, s: out.season });

  // movies are untouched
  details['movie:60'] = { title: 'Just A Film', release_date: '2026-02-02', poster_path: '/m.jpg', overview: 'A film.', release_dates: { results: [] } };
  search['just a film'] = [{ media_type: 'movie', id: 60, title: 'Just A Film', original_title: 'Just A Film', release_date: '2026-02-02', poster_path: '/m.jpg', popularity: 20 }];
  const mv = await feed.tmdbMatch('Just A Film', { type: 'movie' });
  ok('a movie is unaffected: no season in the facts, no season rule, no season badge', mv.story.season === null && feedai._internal.seasonRule(mv.story) === '' && !/LATEST SEASON/.test(feedai._internal.factLines(mv.story)) && !mv.seasonLabel, { s: mv.story.season, l: mv.seasonLabel });
  out = await feedai.aiFill({ title: 'Just A Film', type: 'movie' }, { model: stub, modelName: 'Test', feed });
  ok('…and ✨ AI fill on a movie sends no season rule and adds no season note', out.season === null && !out.notes.some((n) => /Season/.test(n)) && !/newest season/.test(seen[0].content), { s: out.season, n: out.notes });

  // ================================================================= 3. admin drafts
  section('📝 Admin drafts: the post survives the app being swapped out');
  // Run the draft helpers out of admin.html with a fake browser.
  const start = admin.indexOf("var DRAFT = { P: 'ffd_'");
  const end = admin.indexOf('draftPrune();\ndocument.addEventListener');
  ok('the draft helpers are in admin.html', start > 0 && end > start);
  const storeC = admin.slice(start, end);
  const LS = (function () {
    const m = {};
    return { get length() { return Object.keys(m).length; }, key: (i) => Object.keys(m)[i], getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _all: m };
  })();
  const fakeWin = { localStorage: LS, File: function File() {}, Blob: function Blob() {} };
  const D = new Function('window', 'localStorage', '$', 'store', 'S', 'File', 'Blob', storeC +
    '; return { draftSave, draftLoad, draftDrop, draftScrub, draftLater, draftStop, draftFlush, draftPrune, draftStrip, draftAge, draftFields, draftApply, draftRestoreForm, DRAFT, DRAFT_SECRET, ffKeepView };'
  )(fakeWin, LS, () => null, () => {}, { view: 'feed', tab: 'subscriptions' }, fakeWin.File, fakeWin.Blob);

  D.draftSave('feedpost', { post: { title: 'My Reel', caption: 'hello' } });
  ok('a draft is written under its own ffd_ key with the time', !!LS.getItem('ffd_feedpost') && JSON.parse(LS.getItem('ffd_feedpost')).d.post.title === 'My Reel');
  let got = D.draftLoad('feedpost');
  ok('and read back', got && got.data.post.caption === 'hello' && got.at > 0, got);
  D.draftStop('feedpost');
  ok('discard removes it for good', D.draftLoad('feedpost') === null && LS.getItem('ffd_feedpost') === null);

  D.draftSave('feedpost', { post: { title: 'Old' } });
  const rec = JSON.parse(LS.getItem('ffd_feedpost')); rec.t = Date.now() - 25 * 3600 * 1000; LS.setItem('ffd_feedpost', JSON.stringify(rec));
  ok('a draft older than 24 hours is gone (and cleaned away when it is read)', D.draftLoad('feedpost') === null && LS.getItem('ffd_feedpost') === null);
  D.draftSave('a', { x: 1 }); D.draftSave('b', { x: 2 });
  const ro = JSON.parse(LS.getItem('ffd_b')); ro.t = Date.now() - 48 * 3600 * 1000; LS.setItem('ffd_b', JSON.stringify(ro));
  LS.setItem('ff_view', '"feed"');
  D.draftPrune();
  ok('every boot sweeps expired drafts away and leaves everything else alone', LS.getItem('ffd_a') !== null && LS.getItem('ffd_b') === null && LS.getItem('ff_view') === '"feed"');

  const scrubbed = D.draftScrub({ title: 'ok', adminKey: 'fluxfilm2026', password: 'x', cardNumber: '4111', upi: 'me@bank', geminiKey: 'g', tmdbKey: 'tv:50', nested: { apiToken: 't', keep: 'yes' }, file: new fakeWin.File() });
  ok('a secret never reaches storage: admin key / password / card / UPI / AI key / token dropped; the public TMDB id of the post and the rest kept; files dropped',
    JSON.stringify(scrubbed) === JSON.stringify({ title: 'ok', tmdbKey: 'tv:50', nested: { keep: 'yes' } }), scrubbed);
  D.draftSave('x', { adminKey: 'fluxfilm2026', note: 'fine' });
  ok('…the same when it goes through draftSave', !/fluxfilm2026/.test(LS.getItem('ffd_x')) && /fine/.test(LS.getItem('ffd_x')));

  // a plain form (the refund / switch dialogs and device names use this)
  const fld = (o) => Object.assign({ getAttribute: (n) => (n === 'data-k' ? o.k || null : null), type: o.type || 'text', id: o.id || '', name: '', value: o.value == null ? '' : o.value, checked: !!o.checked }, {});
  const fields = [fld({ id: 'orf_note', value: 'Sorry about that' }), fld({ id: 'orf_charge', value: '120' }), fld({ id: 'orf_notify', type: 'checkbox', checked: true }), fld({ id: 'rn_upi', value: 'me@okbank' }), fld({ id: 'k', type: 'password', value: 'secret' }), fld({ id: 'fdvid', type: 'file', value: 'reel.mp4' })];
  const form = { querySelectorAll: () => fields, insertAdjacentHTML: () => {}, addEventListener: () => {} };
  const snap = D.draftFields(form);
  ok('a form draft keeps the boxes and ticks, and skips the password, the file and the UPI id', JSON.stringify(snap) === JSON.stringify({ orf_note: 'Sorry about that', orf_charge: '120', orf_notify: true }), snap);
  D.draftSave('refundoffer:SUB-1', snap);
  fields[0].value = ''; fields[1].value = ''; fields[2].checked = false;
  ok('after a re-boot the same form comes back filled in', D.draftRestoreForm('refundoffer:SUB-1', form, null) === true && fields[0].value === 'Sorry about that' && fields[1].value === '120' && fields[2].checked === true);
  ok('a file box is never "restored" (the browser cannot) and the strip says to pick the video again', fields[5].value === 'reel.mp4' && /Pick the video again/.test(admin));
  ok('the strip says when the draft is from and offers discard', /📝 Draft restored/.test(D.draftStrip('t', Date.now() - 5 * 60000, '')) && /5 minutes ago/.test(D.draftStrip('t', Date.now() - 5 * 60000, '')) && /data-draftdiscard/.test(D.draftStrip('t', Date.now(), '')));

  section('📝 wired into the screens, and no reload while you are typing');
  ok('🍿 post editor: every "not saved yet" keeps the draft, a save throws it away, ← Back discards it', /if \(kind === 'dirty'\) fdDraftKeep\(\); else if \(kind === 'ok'\) draftStop\(FD_DRAFT\);/.test(admin) && /function fdBack\(\) \{ draftStop\(FD_DRAFT\);/.test(admin) && /function fdDraftKeep\(\)/.test(admin));
  ok('🍿 post editor: the screen re-opens the post by itself with the "📝 Draft restored" strip', /var d = draftLoad\(FD_DRAFT\);\s*fdLoad\(d && d\.data && d\.data\.post \? function \(\) \{ fdEdit\(d\.data\.post\); fdDraftShow\(d\.at\); \} : null\);/.test(admin) && /function fdDraftShow\(at\)/.test(admin));
  ok('🧾 plans editor keeps and restores its draft the same way', /var PL_DRAFT = 'planedit';/.test(admin) && /function plDraftKeep\(\)/.test(admin) && /plEdit\(d\.data\.edit, d\.data\.orig \|\| null\);/.test(admin) && /if \(k === 'dirty'\) plDraftKeep\(\); else if \(k === 'ok'\) draftStop\(PL_DRAFT\);/.test(admin));
  ok('💸 Offer refund, ⚡ Refund now and 🔁 Switch account keep drafts per plan and drop them once done', /'refundoffer:' \+ \(target\.subId \|\| target\.orderId/.test(admin) && /'refundnow:' \+ \(q\.orderId \|\| q\.subId/.test(admin) && /'switchacc:' \+ \(sb\.subId \|\| subId/.test(admin) && (admin.match(/draftStop\(box\._draftKey \|\| ''\)/g) || []).length === 2 && /draftStop\(dk\);\s*closeModal\(\);/.test(admin));
  ok('📱 device names: half-typed names are kept and put back with a strip', /var OD_DRAFT = 'devicenames';/.test(admin) && /function odDraftKeep\(list\)/.test(admin) && /odDraftRestore\(list\);/.test(admin) && /Tap 💾 Save on each row you want to keep\./.test(admin));
  ok('choosing "Leave without saving" really throws the draft away too (it never pops back)', /if \(!onlyModal\) \{ try \{ draftStop\(FD_DRAFT\); draftStop\(PL_DRAFT\); \} catch \(e\) \{\} \}/.test(admin));
  ok('drafts are also written the moment the app goes to the background or is closed', /visibilitychange', function \(\) \{ if \(document\.visibilityState === 'hidden'\) \{ draftFlush\(\); ffKeepView\(\); \} \}\);/.test(admin) && /window\.addEventListener\('pagehide', function \(\) \{ draftFlush\(\); ffKeepView\(\); \}\);/.test(admin));
  ok('the screen you were on is remembered, so a re-boot comes back here, not to Today', /function ffKeepView\(\) \{ try \{ store\('ff_view', S\.view\); store\('ff_tab', S\.tab\); \} catch \(e\) \{\} \}/.test(admin) && /var S = \{ view: store\('ff_view'\) \|\| 'today'/.test(admin));
  ok('no update bar while a form has unsaved changes — it appears by itself once you save or close', /if \(UPD\.ready\) \{ if \(!ffDirty\(\)\) updShow\(\); return; \}/.test(admin) && /if \(ffDirty\(\)\) return; \/\/ work in progress: no bar, no service-worker update/.test(admin) && /if \(UPD\.ready && !UPD\.shown && document\.visibilityState === 'visible' && !ffDirty\(\)\) updShow\(\);/.test(admin));
  ok('Refresh still asks before throwing work away, and saves the drafts first', /function updReload\(\) \{ if \(hLeaveBlocked\(\)\) return; draftFlush\(\); location\.reload\(\); \}/.test(admin));

  section('pages still parse');
  let bad = '';
  for (const sc of [...admin.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]) { try { new Function(sc[1]); } catch (e) { bad = e.message; } }
  ok('admin.html inline scripts parse', !bad, bad);
  bad = '';
  for (const sc of [...read('index.html').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((x) => !/application\/(ld\+)?json/.test(x[0]))) { try { new Function(sc[1]); } catch (e) { bad = e.message; } }
  ok('index.html inline scripts parse', !bad, bad);
  ok('npm test runs this suite', /node test\/reels-big-season-drafts\.test\.js/.test(require('../package.json').scripts.test));

  console.log('\n---------------------------------------');
  console.log('reels-big-season-drafts: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
