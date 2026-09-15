/* 🎬 Reels v2: "Post as Reel" (feed.js format / reelInFeed / videoId), uploaded videos in MySQL chunks (feedvideo.js:
   caps, magic bytes, chunk assembly + SHA-256, Range math, streaming only the needed chunks, ETag, delete, missing
   tables), admin wiring (adminfeed.js / admin.html), and the storefront Reels player (kinds, Instagram / Shorts crop
   math, one video at a time, crop CSS, Reels-only posts not in the feed). DB mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MB = 1024 * 1024;

// ---------- in-memory DB: app_settings + feed_videos + feed_video_chunks ----------
const T = { tables: true, settings: {}, videos: {}, chunks: {}, sql: [] };
const missing = (n) => { const e = new Error("Table 'x." + n + "' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; e.errno = 1146; return e; };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    T.sql.push(sql);
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings/.test(sql)) { delete T.settings[p[0]]; return { affectedRows: 1 }; }
    if (/feed_videos|feed_video_chunks/.test(sql) && !T.tables) throw missing('feed_videos');
    if (sql === 'SELECT id FROM feed_videos LIMIT 1') return Object.keys(T.videos).slice(0, 1).map((id) => ({ id }));
    if (sql === 'SELECT video_id FROM feed_video_chunks LIMIT 1') return [];
    if (/^SELECT id FROM feed_videos WHERE status = \? AND created_at < \?$/.test(sql)) return Object.values(T.videos).filter((v) => v.status === p[0] && v.created_at < p[1]).map((v) => ({ id: v.id }));
    if (sql === 'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feed_videos') return [{ n: Object.values(T.videos).reduce((a, v) => a + v.size_bytes, 0) }];
    if (/^INSERT INTO feed_videos/.test(sql)) { T.videos[p[0]] = { id: p[0], mime: p[1], size_bytes: p[2], chunks: p[3], sha256: p[4], duration_s: p[5], status: p[6], created_at: p[7] }; return { affectedRows: 1 }; }
    if (/^SELECT id, mime, size_bytes, chunks, sha256, duration_s, status, created_at FROM feed_videos WHERE id = \? LIMIT 1$/.test(sql)) return T.videos[p[0]] ? [Object.assign({}, T.videos[p[0]])] : [];
    if (/^INSERT INTO feed_video_chunks \(video_id, n, data\) VALUES \(\?, \?, \?\) ON DUPLICATE KEY UPDATE/.test(sql)) { T.chunks[p[0] + '|' + p[1]] = Buffer.from(p[2]); return { affectedRows: 1 }; }
    if (/^SELECT COUNT\(\*\) AS c, COALESCE\(SUM\(LENGTH\(data\)\), 0\) AS b FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) { const ks = Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')); return [{ c: ks.length, b: ks.reduce((a, k) => a + T.chunks[k].length, 0) }]; }
    if (/^SELECT data FROM feed_video_chunks WHERE video_id = \? AND n = \? LIMIT 1$/.test(sql)) { const b = T.chunks[p[0] + '|' + p[1]]; return b ? [{ data: b }] : []; }
    if (/^UPDATE feed_videos SET status = \? WHERE id = \?$/.test(sql)) { if (T.videos[p[1]]) T.videos[p[1]].status = p[0]; return { affectedRows: 1 }; }
    if (/^DELETE FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) { const ks = Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')); ks.forEach((k) => delete T.chunks[k]); return { affectedRows: ks.length }; }
    if (/^DELETE FROM feed_videos WHERE id = \?$/.test(sql)) { delete T.videos[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT id, mime, size_bytes, duration_s, status, created_at FROM feed_videos ORDER BY created_at DESC LIMIT 200$/.test(sql)) return Object.values(T.videos).map((v) => Object.assign({}, v));
    if (/feed_comments|plans/.test(sql)) return [];
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const vid = require('../feedvideo');
const feed = require('../feed');

const mp4 = (size) => { const b = crypto.randomBytes(size); b.write('\0\0\0\x18ftypisom', 0, 'latin1'); return b; };
const webm = (size) => { const b = crypto.randomBytes(size); b[0] = 0x1a; b[1] = 0x45; b[2] = 0xdf; b[3] = 0xa3; return b; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function upload(file, mime, extra) {
  const r = await vid.start(Object.assign({ mime: mime || 'video/mp4', size: file.length, sha256: sha(file), duration: 30 }, extra || {}));
  if (!r.ok) return r;
  for (let n = 0; n < r.chunks; n++) { const c = await vid.chunk(r.id, n, file.slice(n * r.chunkSize, (n + 1) * r.chunkSize)); if (!c.ok) return c; }
  return vid.finish(r.id);
}
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: [], ended: false, destroyed: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { if (typeof k === 'object') Object.assign(res.headers, k); else res.headers[k] = v; return res; };
  res.type = () => res; res.send = (x) => { res.body.push(Buffer.from(String(x))); res.ended = true; return res; };
  res.write = (b) => { res.body.push(Buffer.from(b)); return true; }; res.end = () => { res.ended = true; }; res.destroy = () => { res.destroyed = true; };
  res.once = () => {}; res.headersSent = false;
  return res;
}

(async () => {
  // ================= 1. schema =================
  const schema = read('db/schema-v25.sql').replace(/^--.*$/gm, '');
  ok('schema-v25: feed_videos + feed_video_chunks with plain CREATE TABLE IF NOT EXISTS, MEDIUMBLOB chunks, sha256, no PREPARE / information_schema', /CREATE TABLE IF NOT EXISTS feed_videos \(/.test(schema) && /CREATE TABLE IF NOT EXISTS feed_video_chunks \(/.test(schema) && /data\s+MEDIUMBLOB\s+NOT NULL/.test(schema) && /PRIMARY KEY \(video_id, n\)/.test(schema) && /sha256\s+CHAR\(64\)/.test(schema) && !/information_schema|PREPARE|EXECUTE|ALTER/i.test(schema));

  // ================= 2. missing tables =================
  T.tables = false; vid._internal.reset();
  let r = await vid.start({ mime: 'video/mp4', size: 1000, sha256: 'a'.repeat(64) });
  ok('no schema-v25: upload start answers notReady with the phpMyAdmin hint, nothing inserted', r.ok === false && r.notReady && /schema-v25/.test(r.message) && !T.sql.some((s) => /^INSERT INTO feed_videos/.test(s)), r);
  let u = await vid.usage();
  ok('no schema-v25: usage ready:false (admin shows the note), default limits 25 MB / 2 GB', u.ready === false && u.maxBytes === 25 * MB && u.totalBytes === 2048 * MB, u);
  const noTableRes = fakeRes();
  await vid.serve({ params: { file: 'fv0123456789abcdef.mp4' }, headers: {} }, noTableRes);
  ok('no schema-v25: /v/<id>.mp4 → 404, never throws', noTableRes.statusCode === 404);
  T.tables = true; vid._internal.reset();

  // ================= 3. start: types, caps, sha, duration =================
  ok('bad type refused (only MP4 / WebM)', !(await vid.start({ mime: 'video/quicktime', size: 10, sha256: 'a'.repeat(64) })).ok && !(await vid.start({ mime: 'image/gif', size: 10, sha256: 'a'.repeat(64) })).ok);
  r = await vid.start({ mime: 'video/mp4', size: 25 * MB + 1, sha256: 'a'.repeat(64) });
  ok('over 25 MB refused with the tip text', r.ok === false && r.tooBig && /Upload vertical 720p, ~30–60 s — usually 3–8 MB/.test(r.message), r);
  ok('empty / missing sha256 refused', !(await vid.start({ mime: 'video/mp4', size: 0, sha256: 'a'.repeat(64) })).ok && !(await vid.start({ mime: 'video/mp4', size: 10, sha256: 'xyz' })).ok);
  r = await vid.start({ mime: 'video/mp4', size: 10, sha256: 'a'.repeat(64), duration: 120 });
  ok('longer than 90 s refused', r.ok === false && /90 seconds/.test(r.message), r);
  r = await vid.saveLimits({ videoMaxMb: 60 });
  ok('limit: per-video max above 50 MB refused', r.ok === false, r);
  r = await vid.saveLimits({ videoMaxMb: 2, videoTotalMb: 50 });
  ok('limit: saved (2 MB per video, 50 MB total)', r.ok && r.limits.videoMaxMb === 2 && r.limits.videoTotalMb === 50, r);
  r = await vid.start({ mime: 'video/mp4', size: 3 * MB, sha256: 'a'.repeat(64) });
  ok('…a 3 MB video is now over the per-video cap', r.ok === false && /max 2 MB/.test(r.message), r);
  await vid.saveLimits({ videoMaxMb: 25, videoTotalMb: 2048 });
  ok('limits clean junk back to defaults', JSON.stringify(vid.cleanLimits({ videoMaxMb: 'x', videoTotalMb: -3 })) === JSON.stringify({ videoMaxMb: 25, videoTotalMb: 2048 }));

  // ================= 4. chunks, assembly, SHA-256 =================
  const file = mp4(2.5 * MB | 0);
  r = await vid.start({ mime: 'video/mp4', size: file.length, sha256: sha(file), duration: 42.3 });
  ok('start: id + 3 chunks of 1 MB', r.ok && /^fv[0-9a-f]{16}$/.test(r.id) && r.chunks === 3 && r.chunkSize === MB, r);
  const id1 = r.id;
  ok('chunk: wrong size refused', !(await vid.chunk(id1, 0, file.slice(0, MB - 1))).ok);
  ok('chunk: number out of range refused', !(await vid.chunk(id1, 3, file.slice(0, 10))).ok && !(await vid.chunk(id1, -1, file.slice(0, MB))).ok && !(await vid.chunk(id1, 1.5, file.slice(0, MB))).ok);
  const fake0 = Buffer.from(file.slice(0, MB)); fake0.write('GIF89a', 0, 'latin1');
  ok('chunk 0: not really an MP4 (magic bytes) refused', /not a real MP4/.test((await vid.chunk(id1, 0, fake0)).message));
  ok('finish before all parts → "missing"', /missing/.test((await vid.finish(id1)).message));
  // upload out of order, one part twice (retry)
  await vid.chunk(id1, 2, file.slice(2 * MB)); await vid.chunk(id1, 0, file.slice(0, MB)); await vid.chunk(id1, 1, file.slice(MB, 2 * MB)); await vid.chunk(id1, 1, file.slice(MB, 2 * MB));
  r = await vid.finish(id1);
  ok('finish: all parts (any order, retried part) + SHA-256 match → ready, URL /v/<id>.mp4', r.ok && r.url === '/v/' + id1 + '.mp4' && T.videos[id1].status === 'ready', r);
  ok('assembled chunks = the original file', Buffer.concat([0, 1, 2].map((n) => T.chunks[id1 + '|' + n])).equals(file));
  const bad = mp4(1.2 * MB | 0);
  r = await vid.start({ mime: 'video/mp4', size: bad.length, sha256: sha(mp4(10)) });
  await vid.chunk(r.id, 0, bad.slice(0, MB)); await vid.chunk(r.id, 1, bad.slice(MB));
  const badId = r.id;
  r = await vid.finish(badId);
  ok('finish: SHA-256 mismatch → refused and the parts are deleted', r.ok === false && /SHA-256/.test(r.message) && !T.videos[badId] && !T.chunks[badId + '|0'], r);
  ok('chunk after ready refused', !(await vid.chunk(id1, 0, file.slice(0, MB))).ok);
  const wm = webm(300000);
  r = await upload(wm, 'video/webm');
  ok('WebM upload works → /v/<id>.webm', r.ok && /\.webm$/.test(r.url), r);
  const idWebm = r.id;
  r = await upload(mp4(5000), 'video/webm');
  ok('an MP4 claiming to be WebM is refused', r.ok === false && /not a real WEBM/.test(r.message), r);

  // total cap
  await vid.saveLimits({ videoTotalMb: 50 });
  T.videos.fvffffffffffffffff = { id: 'fvffffffffffffffff', mime: 'video/mp4', size_bytes: 49 * MB, chunks: 49, sha256: 'b'.repeat(64), status: 'ready', created_at: '2026-09-15 10:00:00' };
  r = await vid.start({ mime: 'video/mp4', size: 2 * MB, sha256: 'a'.repeat(64) });
  ok('total storage cap → "storage is full"', r.ok === false && r.full && /full/.test(r.message), r);
  delete T.videos.fvffffffffffffffff; await vid.saveLimits({ videoTotalMb: 2048 });
  // stale uploads cleaned
  T.videos.fv1111111111111111 = { id: 'fv1111111111111111', mime: 'video/mp4', size_bytes: 10, chunks: 1, sha256: 'c'.repeat(64), status: 'uploading', created_at: '2020-01-01 00:00:00' };
  T.chunks['fv1111111111111111|0'] = Buffer.alloc(10);
  await vid.start({ mime: 'video/mp4', size: 10, sha256: 'a'.repeat(64) });
  ok('unfinished uploads older than a day are removed on the next start', !T.videos.fv1111111111111111 && !T.chunks['fv1111111111111111|0']);

  // ================= 5. Range math + streaming =================
  const S = 2.5 * MB | 0;
  const pr = vid.parseRange;
  ok('Range: none → null', pr('', S) === null && pr(undefined, S) === null);
  ok('Range: bytes=0-99', JSON.stringify(pr('bytes=0-99', S)) === JSON.stringify({ start: 0, end: 99 }));
  ok('Range: bytes=0- is capped to 2 chunks', JSON.stringify(pr('bytes=0-', S)) === JSON.stringify({ start: 0, end: 2 * MB - 1 }));
  ok('Range: bytes=1500000- → to the end of chunk 2 (the file end)', JSON.stringify(pr('bytes=1500000-', S)) === JSON.stringify({ start: 1500000, end: S - 1 }));
  ok('Range: suffix bytes=-500 → last 500 bytes', JSON.stringify(pr('bytes=-500', S)) === JSON.stringify({ start: S - 500, end: S - 1 }));
  ok('Range: end past the size is trimmed', pr('bytes=10-99999999', S).end === 2 * MB - 1);
  ok('Range: unsatisfiable / junk → false', pr('bytes=' + S + '-', S) === false && pr('bytes=50-10', S) === false && pr('items=0-1', S) === false && pr('bytes=-', S) === false && pr('bytes=0-1,5-9', S) === false);
  ok('chunkPlan: a range across a chunk edge reads exactly those bytes', JSON.stringify(vid.chunkPlan(MB - 2, MB + 1)) === JSON.stringify([{ n: 0, from: MB - 2, to: MB }, { n: 1, from: 0, to: 2 }]));

  vid._internal.cache.clear(); T.sql = [];
  let res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: { range: 'bytes=' + (MB + 10) + '-' + (MB + 19) }, method: 'GET' }, res);
  const chunkReads = T.sql.filter((s) => /^SELECT data FROM feed_video_chunks/.test(s)).length;
  ok('serve Range → 206, Content-Range, Content-Length 10, the right 10 bytes, only ONE chunk read', res.statusCode === 206 && res.headers['Content-Range'] === 'bytes ' + (MB + 10) + '-' + (MB + 19) + '/' + file.length && res.headers['Content-Length'] === '10' && Buffer.concat(res.body).equals(file.slice(MB + 10, MB + 20)) && chunkReads === 1, { code: res.statusCode, h: res.headers, chunkReads });
  ok('serve headers: Accept-Ranges bytes, video/mp4, immutable long cache, ETag from SHA-256, nosniff', res.headers['Accept-Ranges'] === 'bytes' && res.headers['Content-Type'] === 'video/mp4' && /max-age=31536000, immutable/.test(res.headers['Cache-Control']) && res.headers.ETag === '"' + sha(file).slice(0, 32) + '"' && res.headers['X-Content-Type-Options'] === 'nosniff');
  T.sql = []; res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: { range: 'bytes=' + (MB + 30) + '-' + (MB + 39) }, method: 'GET' }, res);
  ok('a second request for the same chunk comes from the small cache (no DB read)', !T.sql.some((s) => /^SELECT data FROM feed_video_chunks/.test(s)) && Buffer.concat(res.body).equals(file.slice(MB + 30, MB + 40)));
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: { range: 'bytes=0-' }, method: 'GET' }, res);
  ok('open range from 0 → 206 with at most 2 MB', res.statusCode === 206 && Buffer.concat(res.body).length === 2 * MB && res.headers['Content-Range'] === 'bytes 0-' + (2 * MB - 1) + '/' + file.length);
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: {}, method: 'GET' }, res);
  ok('no Range → 200 with the whole file streamed chunk by chunk', res.statusCode === 200 && Buffer.concat(res.body).equals(file) && res.body.length === 3);
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: { range: 'bytes=99999999-' }, method: 'GET' }, res);
  ok('unsatisfiable Range → 416 + Content-Range bytes */size', res.statusCode === 416 && res.headers['Content-Range'] === 'bytes */' + file.length);
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: { 'if-none-match': '"' + sha(file).slice(0, 32) + '"' }, method: 'GET' }, res);
  ok('If-None-Match = ETag → 304', res.statusCode === 304 && !res.body.length);
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.webm' }, headers: {}, method: 'GET' }, res);
  ok('wrong extension for the type → 404', res.statusCode === 404);
  res = fakeRes();
  await vid.serve({ params: { file: '../etc.mp4' }, headers: {}, method: 'GET' }, res);
  ok('bad file name → 404', res.statusCode === 404);
  const srv = read('server.js');
  ok('server: GET /v/:file (strict fv<16 hex>.mp4|webm) → feedvideo.serve, before the storefront catch-all', /app\.get\('\/v\/:file'/.test(srv) && /\/\^fv\[0-9a-f\]\{16\}\\\.\(mp4\|webm\)\$\//.test(srv) && srv.indexOf("app.get('/v/:file'") < srv.indexOf("app.get('*'"));

  // ================= 6. posts: format, reelInFeed, video link =================
  let v = feed.validate({ title: 'A', brand: 'Netflix', format: 'reel' });
  ok('Reel without any video source → error', !v.ok && /A Reel needs a video/.test(v.errors.join(' ')), v.errors);
  v = feed.validate({ title: 'A', brand: 'Netflix', format: 'reel', trailerUrl: 'https://www.youtube.com/shorts/abcdefghijk' });
  ok('Reel with a YouTube Shorts link is valid; reelInFeed defaults to true', v.ok && v.post.format === 'reel' && v.post.reelInFeed === true, v.errors);
  v = feed.validate({ title: 'A', brand: 'Netflix', format: 'reel', instagramUrl: 'https://www.instagram.com/reel/DXcHYvyk1py/', reelInFeed: false });
  ok('Reel with an Instagram link + "Reels only"', v.ok && v.post.reelInFeed === false);
  v = feed.validate({ title: 'A', brand: 'Netflix', format: 'weird' });
  ok('unknown post type → post (old posts keep working)', v.ok && v.post.format === 'post' && v.post.reelInFeed === true);
  v = feed.validate({ title: 'A', brand: 'Netflix', format: 'post', reelInFeed: false });
  ok('a normal post is always in the feed', v.post.reelInFeed === true);
  v = feed.validate({ title: 'A', brand: 'Netflix', format: 'reel', videoId: '../../x' });
  ok('bad video id → error', !v.ok && /Video is not valid/.test(v.errors.join(' ')));
  v = feed.validate({ title: 'Old', brand: 'Netflix' }, { id: 'fp0000000001', format: 'reel', reelInFeed: false, instagramUrl: 'https://www.instagram.com/reel/DXcHYvyk1py/', createdAt: '2026-01-01' });
  ok('an old client that does not send format keeps the saved Reel settings', v.post.format === 'reel' && v.post.reelInFeed === false);

  r = await feed.save({ title: 'Reel with fake video', brand: 'Netflix', format: 'reel', videoId: 'fv9999999999999999', active: true });
  ok('save: a video id that is not a finished upload is refused', r.ok === false && /not finished/.test(r.message), r);
  r = await feed.save({ title: 'My Reel', brand: 'Netflix', ctaService: 'Netflix', format: 'reel', reelInFeed: false, videoId: id1, active: true });
  ok('save: finished upload linked (videoType from the upload)', r.ok && r.post.videoId === id1 && r.post.videoType === 'video/mp4', r);
  const reelPost = r.post;
  r = await feed.save({ title: 'Plain post', brand: 'Prime Video', active: true });
  const list = await feed.publicList(new Date());
  const pr1 = list.posts.find((x) => x.id === reelPost.id); const pp = list.posts.find((x) => x.title === 'Plain post');
  ok('publicList: reel → format reel, inFeed false, video /v/<id>.mp4, no video id leak beyond the URL; plain post inFeed', pr1 && pr1.format === 'reel' && pr1.inFeed === false && pr1.video === '/v/' + id1 + '.mp4' && pr1.videoType === 'video/mp4' && pp.format === 'post' && pp.inFeed === true && pp.video === '', { pr1, pp });
  r = await feed.save(Object.assign({}, reelPost, { videoId: idWebm }));
  ok('save: replacing the video deletes the old one (chunks freed)', r.ok && r.post.videoId === idWebm && r.post.videoType === 'video/webm' && !T.videos[id1] && !T.chunks[id1 + '|0'], r);
  r = await feed.remove(reelPost.id);
  ok('deleting the post deletes its video', r.ok && !T.videos[idWebm] && !Object.keys(T.chunks).some((k) => k.startsWith(idWebm)));
  const extra = await upload(mp4(4000));
  r = await vid.remove(extra.id);
  ok('delete frees the chunks (freedChunks) and the row', r.ok && r.freedChunks === 1 && !T.videos[extra.id]);
  u = await vid.usage();
  ok('usage: list of videos with sizes + total bytes', u.ready && Array.isArray(u.list) && typeof u.bytes === 'number' && u.totalBytes === 2048 * MB);

  // ================= 7. admin wiring =================
  const af = read('adminfeed.js');
  ok('admin routes: start (sha256 + duration), raw chunk ≤ ~1.1 MB behind auth, finish, videos list, delete (refused while on a post), limits', /route\('\/admin\/api\/feed\/video\/start'/.test(af) && /sha256: b\.sha256, duration: b\.duration/.test(af) && /express'\)\.raw\(\{ type: 'application\/octet-stream', limit: '1100kb' \}\)/.test(af) && /app\.post\('\/admin\/api\/feed\/video\/chunk', rawBody, async \(req, res\) => \{\s*if \(!auth\(req, res\)\) return;/.test(af) && /route\('\/admin\/api\/feed\/video\/finish'/.test(af) && /app\.get\('\/admin\/api\/feed\/videos'/.test(af) && /inUse: true/.test(af) && /route\('\/admin\/api\/feed\/video\/settings'/.test(af));
  const ad = read('admin.html');
  ok('admin editor: Post type Post / Reel, "Also show this Reel in the feed", upload with tip text, schema note when missing', /data-format="post"/.test(ad) && /data-format="reel"/.test(ad) && /Also show this Reel in the feed/.test(ad) && /Upload vertical 720p, ~30–60 s — usually 3–8 MB/.test(ad) && /Uploading videos needs <b>db\/schema-v25\.sql<\/b>/.test(ad));
  ok('admin upload: length check, SHA-256 in the browser, 1 MB raw octet-stream chunks, finish', /function fdVideoLength\(file, done\)/.test(ad) && /crypto\.subtle\.digest\('SHA-256', buf\)/.test(ad) && /'Content-Type': 'application\/octet-stream'/.test(ad) && /\/admin\/api\/feed\/video\/finish/.test(ad));
  ok('admin storage card: "Videos: X of Y used", each size, delete, limits', /<b>🎬 Videos: ' \+ fdMb\(v\.bytes\) \+ ' of ' \+ fdMb\(v\.totalBytes\) \+ ' used<\/b>/.test(ad) && /data-viddel=/.test(ad) && /\/admin\/api\/feed\/video\/delete/.test(ad) && /id="fdvidmax"/.test(ad) && /h \+= fdVideoCard\(\);/.test(ad));
  ok('admin: a duplicated post does not share the video', /delete c\.videoId;/.test(ad));
  let parseErr = ''; for (const sc of [...ad.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]) { try { new Function(sc[1]); } catch (e) { parseErr = e.message; } }
  ok('admin.html inline scripts parse', !parseErr, parseErr);

  // ================= 8. storefront =================
  const html = read('index.html');
  parseErr = ''; for (const sc of [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((x) => !/application\/(ld\+)?json/.test(x[0]))) { try { new Function(sc[1]); } catch (e) { parseErr = e.message; } }
  ok('index.html inline scripts parse', !parseErr, parseErr);
  const fn = (name) => { const i = html.indexOf('function ' + name + '('); const j = html.indexOf('\n}\n', i); return html.slice(i, j + 2); };
  const H = new Function('window', 'navigator', 'const FEED_IG_HEADER_ = 54; const FEED_IG_FOOTER_ = 190;' + ['feedYouTubeId_', 'feedIgUrl_', 'feedVideoSrc_', 'feedYtShort_', 'feedReelKind_', 'feedIgCrop_', 'feedShortCrop_', 'feedShortSrc_'].map(fn).join('\n') + '; return { feedReelKind_, feedIgCrop_, feedShortCrop_, feedShortSrc_, feedVideoSrc_ };')({ location: { origin: 'https://shop.fluxfilm.in' } }, {});
  const IG = 'https://www.instagram.com/reel/DXcHYvyk1py/'; const SHORT = 'https://www.youtube.com/shorts/abcdefghijk'; const TR = 'https://www.youtube.com/watch?v=abcdefghijk';
  ok('reel kind order: uploaded video › Short › Instagram › trailer', H.feedReelKind_({ video: '/v/fv0123456789abcdef.mp4', instagramUrl: IG, trailerUrl: SHORT }) === 'video' && H.feedReelKind_({ instagramUrl: IG, trailerUrl: SHORT }) === 'short' && H.feedReelKind_({ instagramUrl: IG, trailerUrl: TR }) === 'ig' && H.feedReelKind_({ trailerUrl: TR }) === 'yt' && H.feedReelKind_({}) === '');
  ok('video URL must be our own /v/<id>.mp4|webm', H.feedVideoSrc_({ video: 'https://evil.example/x.mp4' }) === '' && H.feedVideoSrc_({ video: '/v/fv0123456789abcdef.webm' }) === '/v/fv0123456789abcdef.webm' && H.feedVideoSrc_({ video: '/v/fv0123456789abcdef.mp4?x' }) === '');
  for (const [w, h] of [[390, 844], [309, 700], [412, 915], [520, 900]]) {
    const c = H.feedIgCrop_(w, h); const media = c.width * 1.25; const videoW = media * 9 / 16; const videoLeft = c.left + (c.width - videoW) / 2; const videoTop = c.top + 54;
    ok('Instagram crop ' + w + '×' + h + ': header above the slot, footer below, the 9:16 video covers the whole slot', c.top + 54 <= 0 && videoTop + media >= h && c.top + 54 + media <= c.height && videoLeft <= 0.5 && videoLeft + videoW >= w - 0.5 && videoTop <= 0 && c.top + 54 + media + 150 <= c.height, c);
    const sc = H.feedShortCrop_(w, h);
    ok('Shorts crop ' + w + '×' + h + ': 9:16 (or wider) iframe, title bar + logo 60 px outside, covers the slot', sc.top === -60 && sc.height === h + 120 && sc.width >= w && sc.width >= Math.floor((h + 120) * 9 / 16) && sc.left <= 0 && sc.left + sc.width >= w, sc);
  }
  ok('Short src: youtube-nocookie, autoplay muted, controls=0, playsinline, rel=0, loop, JS API', /^https:\/\/www\.youtube-nocookie\.com\/embed\/abcdefghijk\?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&loop=1&playlist=abcdefghijk/.test(H.feedShortSrc_('abcdefghijk')) && /enablejsapi=1/.test(H.feedShortSrc_('abcdefghijk')) && H.feedShortSrc_('bad') === '');
  ok('crop CSS: overflow hidden box, header / footer outside; our tap layer covers a Short once YouTube reports it started (before that its own play button can be tapped)', /\.ff-reel-crop \{ position: absolute; inset: 0; z-index: 3; overflow: hidden;/.test(html) && /\.ff-reel-crop\.short \{ z-index: 1; \}/.test(html) && /i === idx && playing && \(kind === 'short' \|\| kind === 'yt'\) && \(yt === 1 \|\| yt === 2 \|\| yt === 3\) && React\.createElement\("div", \{\s*className: "ff-reel-tap"/.test(html) && /className: "ff-reel-crop ig ff-reel-igcrop"/.test(html) && /style: px\(feedIgCrop_\(dims\.w, dims\.h\)\)/.test(html) && /style: px\(feedShortCrop_\(dims\.w, dims\.h\)\)/.test(html));
  ok('Instagram iframe: popups allowed again (without them Instagram\'s play did nothing on phones — "Front of the Class" bug), /embed/ only, header cropped away', /sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"/.test(html) && /feedIgUrl_\(p\.instagramUrl\) \+ 'embed\/'/.test(html) && !/ff-reel-igbar/.test(html));
  ok('Instagram fallback row while its player is open: hint + "▶ Trailer" (when the post has one, switches this reel to the YouTube trailer) + "Instagram ↗" — never a dead screen', /on && kind === 'ig' && React\.createElement\("div", \{\s*className: "ff-reel-igfb"/.test(html) && /"Tap the video to play"/.test(html) && /setAltYt\(p\.id\);/.test(html) && /"▶ Trailer"/.test(html) && /"Instagram ↗"/.test(html) && /const kindOf = p => p && altYt === p\.id && feedYouTubeId_\(p\.trailerUrl\) \? 'yt' : feedReelKind_\(p\);/.test(html) && /\.ff-reel-igfb \{/.test(html));
  ok('Reels caption: 2 lines, tap / "more" opens the whole text in place (darker fade, scrollable), tap or swipe down closes, the list is locked meanwhile and the tap never reaches the video', /className: "ff-reel-cap" \+ \(capOpen === p\.id \? ' open' : ' clamp'\)/.test(html) && /e\.stopPropagation\(\);\s*toggleCap\(p\.id\);/.test(html) && /if \(capOpen === id && dy > 40 && capTouch\.current\.top <= 0\)/.test(html) && /className: "ff-reels-list" \+ \(capOpen \? ' lock' : ''\)/.test(html) && /\.ff-reel-cap\.open \{ max-height: 42vh; overflow-y: auto;/.test(html) && /\.ff-reel-info\.open \{ background:/.test(html) && /\.ff-reels-list\.lock \{ overflow-y: hidden; \}/.test(html) && /className: "ff-reel-info" \+ \(capOpen === p\.id \? ' open' : ''\),\s*onClick: e => e\.stopPropagation\(\)/.test(html));
  ok('feed posts: tapping a long caption opens / closes it too', /onClick: long \? \(\) => setOpen\(o => !o\) : undefined/.test(html));

  // ================= 9. likes need a login + count from unique rows =================
  ok('storefront: liking needs a login (gentle prompt, nothing counted) on posts, double tap and Reels', /if \(kind === 'like' && !feedMarks_\.phone\) return 'login';/.test(html) && /setNote\('LIKELOGIN'\)/.test(html) && /' to like posts — one like per account\.'/.test(html) && /text: '❤️ Log in to like',\s*login: true/.test(html));
  const feedSrc = read('feed.js');
  ok('public feed + admin show unique account likes once schema-v25 exists (old inflated counter ignored)', /likes: al \? Math\.max\(0, al\[p\.id\] \|\| 0\) : \(st\[p\.id\] \|\| \{\}\)\.likes \|\| 0/.test(feedSrc) && /require\('\.\/feedmarks'\)\.likeCounts\(\)/.test(feedSrc) && /likes: al \? \(al\[p\.id\] \|\| 0\) : /.test(read('adminfeed.js')) && /PRIMARY KEY \(phone_norm, post_id\)/.test(read('db/schema-v25.sql')));

  // ================= 10. commenter pictures =================
  const cm = require('../feedcomments');
  const sa = cm.safeAvatar;
  ok('avatar formats: own photo, creator avatar, dicebear preset (http upgraded), empty / junk → ""', sa('/profile-photo/8e1620423c7ff1210ed4e967?v=mu1oveut') === '/profile-photo/8e1620423c7ff1210ed4e967?v=mu1oveut' && sa('/avatar/1abcdefghij12345.svg') === '/avatar/1abcdefghij12345.svg' && sa('https://api.dicebear.com/9.x/bottts/svg?seed=robot1') === 'https://api.dicebear.com/9.x/bottts/svg?seed=robot1' && sa('http://api.dicebear.com/9.x/thumbs/svg?seed=popcorn') === 'https://api.dicebear.com/9.x/thumbs/svg?seed=popcorn' && sa('') === '' && sa('javascript:alert(1)') === '' && sa('/profile-photo/../x') === '' && sa('https://x.com/a"onerror=') === '');
  const cmDb = { rows: [{ id: 7, pic: '/profile-photo/0123456789abcdef01234567?v=k2' }, { id: 8, pic: '' }], calls: [] };
  const oldQuery = mockDb.query;
  mockDb.query = async (sql, p) => { const q = sql.replace(/\s+/g, ' ').trim(); if (/^SELECT c\.id AS id, cu\.profile_pic_url AS pic FROM feed_comments c JOIN customers cu ON cu\.phone_norm = c\.phone_norm WHERE c\.id IN \(\?(, \?)*\)$/.test(q)) { cmDb.calls.push(p); return cmDb.rows.filter((r) => p.includes(r.id)); } return oldQuery(sql, p); };
  const cur = await cm._internal.currentAvatars([7, 8, 9, 7]);
  ok('current picture looked up at read time by comment id (no phone in the answer): new photo shown, removed photo → "" (letter), unknown → left as saved', cur[7] === '/profile-photo/0123456789abcdef01234567?v=k2' && cur[8] === '' && !(9 in cur) && JSON.stringify(cmDb.calls[0]) === '[7,8,9]' && !JSON.stringify(cur).includes('phone'), cur);
  await cm._internal.currentAvatars([7, 8]);
  ok('picture lookup cached (no second query within a minute)', cmDb.calls.length === 1);
  mockDb.query = async (sql, p) => { if (/JOIN customers/.test(sql)) throw new Error('db down'); return oldQuery(sql, p); };
  cm._internal.avatarCache.clear();
  ok('lookup failure → keeps the saved pictures (never breaks comments)', JSON.stringify(await cm._internal.currentAvatars([7])) === '{}');
  mockDb.query = oldQuery;
  const fcSrc = read('feedcomments.js');
  ok('list() and previews() both use the current pictures', /const page = await withAvatars\(rows\.slice\(0, PAGE\)\.map\(publicRow\)\);/.test(fcSrc) && /const cur = await currentAvatars\(ids\.flatMap/.test(fcSrc));
  ok('storefront: one FeedAvatar for the sheet AND the 20 px previews under posts; picture that fails to load or no picture → coloured letter', /function FeedAvatar\(\{/.test(html) && /React\.createElement\(FeedAvatar, \{\s*name: c\.name,\s*url: c\.avatar,\s*size: 34\s*\}\)/.test(html) && /React\.createElement\(FeedAvatar, \{\s*name: c\.name,\s*url: c\.avatar,\s*size: 20,\s*small: true\s*\}\), React\.createElement\("b", null, c\.name\), c\.text\)/.test(html) && /onError: \(\) => setFailed\(src\)/.test(html) && /background: feedAvatarColor_\(name\)/.test(html) && /\.ff-cp-av \{[^}]*width: 20px; height: 20px;[^}]*border-radius: 50%/.test(html));
  const AV = new Function('const FEED_AV_COLORS_ = ["a","b","c","d","e","f","g","h"];' + fn('feedAvatarSrc_') + fn('feedAvatarColor_') + '; return { feedAvatarSrc_, feedAvatarColor_ };')();
  ok('storefront avatar check matches the server (same formats) and the letter colour is stable per name', AV.feedAvatarSrc_('/avatar/1abcdefghij12345.svg') !== '' && AV.feedAvatarSrc_('http://api.dicebear.com/9.x/fun-emoji/svg?seed=wow') === 'https://api.dicebear.com/9.x/fun-emoji/svg?seed=wow' && AV.feedAvatarSrc_('data:image/png;base64,xx') === '' && AV.feedAvatarColor_('Harsh W.') === AV.feedAvatarColor_('Harsh W.'));
  ok('no neighbour bleed: each reel contains its paint, list re-snaps after resize / scroll end / focus into an embed', /\.ff-reel \{[^}]*overflow: hidden; contain: paint;/.test(html) && /ro = new ResizeObserver\(measure\)/.test(html) && /snapTimer\.current = setTimeout\(\(\) => \{\s*syncIdx\(\);\s*snap\(true\);\s*\}, 180\)/.test(html) && /window\.addEventListener\('blur', onBlur\)/.test(html));
  ok('one video at a time: only the reel on screen renders a <video> / Short / trailer / Instagram player, every start goes through feedVideoStart_', /i === idx && playing && kind === 'video' && React\.createElement\("video"/.test(html) && /i === idx && playing && kind === 'short' && dims\.h > 0/.test(html) && /i === idx && playing && kind === 'yt' && React\.createElement\("iframe"/.test(html) && /on && kind === 'ig' && dims\.h > 0/.test(html) && /feedVideoStart_\('reels', \(\) => \{/.test(html) && /function syncIdx\(\) \{[\s\S]{0,400}setIdx\(i\);[\s\S]{0,80}stop\(\);/.test(html));
  ok('our player: muted autoplay (attribute too), loop, playsinline, thin progress bar, 🔇 sound button, tap pauses', /autoPlay: true,\s*loop: true,\s*playsInline: true/.test(html) && /el\.setAttribute\('muted', ''\)/.test(html) && /className: "ff-reel-prog"/.test(html) && /barRef\.current\.style\.transform = 'scaleX\('/.test(html) && /className: "ff-reel-mute"/.test(html) && /if \(v\.paused\) v\.play\(\)\.catch\(\(\) => \{\}\);else v\.pause\(\);/.test(html));
  ok('autoplay only for our video / Shorts and not with reduced motion or Data Saver', /if \(\(kind === 'video' \|\| kind === 'short'\) && feedCanAutoplay_\(\)\) play\(p\);/.test(html) && /prefers-reduced-motion: reduce\)'\)\.matches\) return false;/.test(html) && /navigator\.connection\.saveData\) return false;/.test(html));
  ok('Reels tab uses every post with a video; "Reels only" posts stay out of the feed list; the ☰ grid sees all', /const posts = allPosts\.filter\(p => p\.inFeed !== false\);/.test(html) && /const reelItems = allPosts\.filter\(p => feedReelKind_\(p\)\);/.test(html) && /posts: allPosts,/.test(html));
  ok('uploaded-video post in the feed: "Watch Reel" opens Reels at it', /className: "ff-feed-reelbtn"/.test(html) && /onReel: p => setReels\(\{\s*startId: p\.id\s*\}\)/.test(html));
  // Reels-tab filtering with real data
  const posts = [{ id: 'a', inFeed: true, instagramUrl: IG }, { id: 'b', inFeed: false, format: 'reel', video: '/v/fv0123456789abcdef.mp4' }, { id: 'c' }, { id: 'd', trailerUrl: TR }];
  ok('filtering: feed = a, c, d · Reels = a, b, d', posts.filter((p) => p.inFeed !== false).map((p) => p.id).join() === 'a,c,d' && posts.filter((p) => H.feedReelKind_(p)).map((p) => p.id).join() === 'a,b,d');
  ok('npm test runs this suite', /node test\/feed-reels-video\.test\.js/.test(require('../package.json').scripts.test));

  console.log('\n---------------------------------------');
  console.log('feed-reels-video: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
