/**
 * FluxFilm - 🎬 uploaded Reel videos (admin → 🍿 What's new → Post type: Reel → Upload video).
 *
 * WHERE THE BYTES LIVE (owner decision 15 Sep 2026): MySQL, tables feed_videos + feed_video_chunks (db/schema-v25.sql),
 * raw binary in 1 MB MEDIUMBLOB chunks (never base64). Chunks because Hostinger's max_allowed_packet (often 16–64 MB)
 * would refuse one big row; MySQL because Hostinger rebuilds the app folder on every deploy (a file next to the code
 * would vanish). The bytes count toward the Hostinger disk quota and the MySQL database size, so there are limits:
 *   one video ≤ videoMaxMb (default 60, admin can set 1–150) · all videos ≤ videoTotalMb (default 2048 = 2 GB, max 5120)
 *   ≤ videoMaxSeconds (default 300 = 5 minutes, admin can set 10–600) — the admin page reads the length before uploading
 *   MP4 / WebM only, checked by the file's first bytes
 * Limits live in app_settings 'feed_video_settings' (admin → 🍿 What's new → 🎬 Videos card). 💡 Storage maths for the
 * owner: 60 MB × 30 reels ≈ 1.8 GB of database (and Hostinger disk) space — that is why the total cap exists.
 *
 * Upload (admin only, adminfeed.js): start { mime, size, sha256, duration } → id · chunk ?id=&n= (raw ~1 MB body; every
 * chunk but the last is exactly 1 MB; chunk 0 must start like a real MP4 / WebM) · finish { id } → the server re-reads
 * the chunks in order, checks the total size and the SHA-256 the browser computed → ready. Unfinished uploads older
 * than a day are removed. A post links a READY video by id (feed.save checks it); delete frees the chunks.
 * RESUME: status(id) says which parts arrived already, so a phone that lost its signal (or an admin app Android swapped
 * out) carries on from the first missing part instead of sending the whole video again. Nothing is ever buffered whole
 * on the server — one ~1 MB body at a time in, at most 2 chunks at a time out.
 *
 * Playback: GET /v/<id>.mp4 (or .webm) with HTTP Range → 206, reading ONLY the chunks the range needs (≤ 2 per answer, so
 * nothing loads a whole video into memory), Accept-Ranges, ETag = the SHA-256, long immutable cache (a new upload = a
 * new id), 304 on If-None-Match, nosniff. A tiny chunk cache (≤ 24 MB) spares MySQL when a reel loops.
 */
const crypto = require('crypto');
const db = require('./db');

const CHUNK = 1024 * 1024;
const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 60;
const HARD_MAX_MB = 150;
const DEFAULT_TOTAL_MB = 2048;
const HARD_TOTAL_MB = 5120;
const MIN_TOTAL_MB = 50;
const DEFAULT_MAX_SECONDS = 300;
const HARD_MAX_SECONDS = 600;
const MIN_MAX_SECONDS = 10;
const MAX_SECONDS = DEFAULT_MAX_SECONDS; // kept for older callers; the real cap is limits.videoMaxSeconds
const TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const SETTINGS_KEY = 'feed_video_settings';
const CACHE_MAX = 24;
const PER_RESPONSE = 2;
const NOT_READY = 'Run db/schema-v25.sql in phpMyAdmin first to upload videos (YouTube Shorts / Instagram links work already).';

const s = (v) => String(v == null ? '' : v).trim();
const safeId = (v) => (/^fv[0-9a-f]{16}$/.test(s(v)) ? s(v) : '');
const missingTable = (e) => !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || /doesn't exist|no such table/i.test(String(e.message || '')));
const istString = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
const urlOf = (id, mime) => '/v/' + id + '.' + (TYPES[mime] || 'mp4');

let readyAt = 0; let readyVal = null;
async function ready(force) {
  if (!force && readyVal !== null && Date.now() - readyAt < 60e3) return readyVal;
  try { await db.query('SELECT id FROM feed_videos LIMIT 1', []); await db.query('SELECT video_id FROM feed_video_chunks LIMIT 1', []); readyVal = true; }
  catch (e) { if (!missingTable(e)) throw e; readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}

// ---- limits (admin setting) ----
function cleanLimits(o) {
  const x = o || {};
  const maxMb = Math.floor(Number(x.videoMaxMb));
  const totalMb = Math.floor(Number(x.videoTotalMb));
  const secs = Math.floor(Number(x.videoMaxSeconds));
  return {
    videoMaxMb: maxMb >= 1 ? Math.min(HARD_MAX_MB, maxMb) : DEFAULT_MAX_MB,
    videoTotalMb: totalMb >= MIN_TOTAL_MB ? Math.min(HARD_TOTAL_MB, totalMb) : DEFAULT_TOTAL_MB,
    videoMaxSeconds: secs >= MIN_MAX_SECONDS ? Math.min(HARD_MAX_SECONDS, secs) : DEFAULT_MAX_SECONDS,
  };
}
/** "78 MB" / "1.8 GB" — the same words the admin page uses, so an error names a size the owner recognises. */
function mbText(bytes) {
  const m = (Number(bytes) || 0) / MB;
  if (m >= 1024) return (Math.round(m / 102.4) / 10) + ' GB';
  return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + ' MB';
}
/** 45 → "45 seconds" · 78.4 → "1 min 18 s" · 300 → "5 minutes". */
function durText(sec) {
  const n = Math.round(Number(sec) || 0);
  if (n < 60) return n + ' seconds';
  const m = Math.floor(n / 60); const r = n % 60;
  return r ? m + ' min ' + r + ' s' : m + ' minute' + (m === 1 ? '' : 's');
}
async function getLimits() {
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
    return cleanLimits(rows.length ? JSON.parse(rows[0].value || '{}') : {});
  } catch (_) { return cleanLimits({}); }
}
async function saveLimits(input) {
  const o = input || {};
  const set = (k) => o[k] !== undefined && o[k] !== null && o[k] !== '';
  const maxMb = Math.floor(Number(o.videoMaxMb)); const totalMb = Math.floor(Number(o.videoTotalMb)); const secs = Math.floor(Number(o.videoMaxSeconds));
  if (set('videoMaxMb') && !(maxMb >= 1 && maxMb <= HARD_MAX_MB)) return { ok: false, message: 'Max size per video must be 1–' + HARD_MAX_MB + ' MB.' };
  if (set('videoTotalMb') && !(totalMb >= MIN_TOTAL_MB && totalMb <= HARD_TOTAL_MB)) return { ok: false, message: 'Total video storage must be ' + MIN_TOTAL_MB + '–' + HARD_TOTAL_MB + ' MB (' + HARD_TOTAL_MB / 1024 + ' GB) — it all sits in the MySQL database and on the Hostinger disk.' };
  if (set('videoMaxSeconds') && !(secs >= MIN_MAX_SECONDS && secs <= HARD_MAX_SECONDS)) return { ok: false, message: 'Longest video must be ' + MIN_MAX_SECONDS + '–' + HARD_MAX_SECONDS + ' seconds (' + HARD_MAX_SECONDS / 60 + ' minutes).' };
  const cur = await getLimits();
  const next = cleanLimits(Object.assign({}, cur,
    set('videoMaxMb') ? { videoMaxMb: maxMb } : {},
    set('videoTotalMb') ? { videoTotalMb: totalMb } : {},
    set('videoMaxSeconds') ? { videoMaxSeconds: secs } : {}));
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTINGS_KEY, JSON.stringify(next)]);
  return { ok: true, limits: next };
}

/** What the first bytes say ('' = not an MP4 / WebM). MP4: "ftyp" at byte 4. WebM (Matroska EBML): 1A 45 DF A3. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return '';
}

async function start(input) {
  const o = input || {};
  const mime = s(o.mime).toLowerCase();
  const size = Math.floor(Number(o.size));
  const sha = s(o.sha256).toLowerCase();
  const dur = Number(o.duration);
  if (!TYPES[mime]) return { ok: false, message: 'Upload an MP4 or WebM video.' };
  if (!(size > 0)) return { ok: false, message: 'The video file is empty.' };
  if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, message: 'Missing the file check (SHA-256) — reload the page and try again.' };
  const lim = await getLimits();
  if (o.duration !== undefined && o.duration !== null && o.duration !== '' && (!(dur > 0) || dur > lim.videoMaxSeconds + 0.5)) {
    return { ok: false, tooLong: true, seconds: dur > 0 ? Math.round(dur) : 0, limitSeconds: lim.videoMaxSeconds,
      message: 'That video is ' + durText(dur) + ' — the limit is ' + durText(lim.videoMaxSeconds) + '. Trim it, or raise the limit in the 🎬 Videos card.' };
  }
  if (size > lim.videoMaxMb * MB) {
    return { ok: false, tooBig: true, bytes: size, limitBytes: lim.videoMaxMb * MB,
      message: mbText(size) + ' — the limit is ' + lim.videoMaxMb + ' MB. Try 720p, or raise the limit in ⚙️ settings.' };
  }
  if (!(await ready())) return { ok: false, notReady: true, message: NOT_READY };
  try {
    const old = await db.query('SELECT id FROM feed_videos WHERE status = ? AND created_at < ?', ['uploading', istString(Date.now() - 24 * 3600e3)]);
    for (const r of old) await remove(r.id);
  } catch (_) {}
  const tot = await db.query('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feed_videos', []);
  const used = Number(tot[0] && tot[0].n) || 0;
  if (used + size > lim.videoTotalMb * MB) {
    return { ok: false, full: true, bytes: size, freeBytes: Math.max(0, lim.videoTotalMb * MB - used),
      message: 'Video storage is full: ' + mbText(Math.max(0, lim.videoTotalMb * MB - used)) + ' free of ' + mbText(lim.videoTotalMb * MB) + ', this video needs ' + mbText(size) + '. Delete old Reel videos, or raise the total in the 🎬 Videos card.' };
  }
  const id = 'fv' + crypto.randomBytes(8).toString('hex');
  const chunks = Math.ceil(size / CHUNK);
  await db.query('INSERT INTO feed_videos (id, mime, size_bytes, chunks, sha256, duration_s, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, mime, size, chunks, sha, dur > 0 ? Math.round(dur * 10) / 10 : null, 'uploading', istString()]);
  return { ok: true, id, chunks, chunkSize: CHUNK, maxBytes: lim.videoMaxMb * MB, maxSeconds: lim.videoMaxSeconds };
}

/**
 * 📶 Resume: which parts of an unfinished upload the server already has. The admin page asks for this when a chunk
 * keeps failing (or after the app was swapped out mid-upload) and carries on from the first missing part.
 * Only counts the parts — the bytes themselves are never read here.
 */
async function status(id) {
  const m = await info(id).catch(() => null);
  if (!m) return { ok: false, message: 'Upload not found — start again.' };
  if (m.status === 'ready') return { ok: true, id: m.id, done: true, chunks: m.chunks, chunkSize: CHUNK, have: [], missing: [], url: m.url };
  const rows = await db.query('SELECT n FROM feed_video_chunks WHERE video_id = ?', [m.id]);
  const have = rows.map((r) => Number(r.n)).filter((n) => Number.isInteger(n) && n >= 0 && n < m.chunks).sort((a, b) => a - b);
  const seen = new Set(have);
  const missing = [];
  for (let n = 0; n < m.chunks; n++) if (!seen.has(n)) missing.push(n);
  return { ok: true, id: m.id, done: false, chunks: m.chunks, chunkSize: CHUNK, size: m.size, have, missing, next: missing.length ? missing[0] : m.chunks };
}

async function info(id) {
  const vid = safeId(id);
  if (!vid) return null;
  const rows = await db.query('SELECT id, mime, size_bytes, chunks, sha256, duration_s, status, created_at FROM feed_videos WHERE id = ? LIMIT 1', [vid]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: s(r.id), mime: s(r.mime), size: Number(r.size_bytes) || 0, chunks: Number(r.chunks) || 0, sha256: s(r.sha256), duration: r.duration_s == null ? null : Number(r.duration_s), status: s(r.status), createdAt: s(r.created_at), url: urlOf(s(r.id), s(r.mime)) };
}

async function chunk(id, n, buf) {
  const m = await info(id);
  if (!m || m.status !== 'uploading') return { ok: false, message: 'Upload not found — start again.' };
  const k = Number(n);
  if (!Number.isInteger(k) || k < 0 || k >= m.chunks) return { ok: false, message: 'Bad chunk number.' };
  if (!Buffer.isBuffer(buf)) return { ok: false, message: 'No video data.' };
  const want = k < m.chunks - 1 ? CHUNK : m.size - CHUNK * (m.chunks - 1);
  if (buf.length !== want) return { ok: false, message: 'Part ' + (k + 1) + ' has the wrong size.' };
  if (k === 0 && sniff(buf) !== m.mime) return { ok: false, message: 'That file is not a real ' + TYPES[m.mime].toUpperCase() + ' video.' };
  await db.query('INSERT INTO feed_video_chunks (video_id, n, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [m.id, k, buf]);
  return { ok: true, n: k };
}

/** Every chunk there, sizes add up, and the SHA-256 of the chunks in order = what the browser computed → ready. */
async function finish(id) {
  const m = await info(id);
  if (!m) return { ok: false, message: 'Upload not found.' };
  if (m.status === 'ready') return { ok: true, id: m.id, url: m.url, mime: m.mime, size: m.size };
  const r = await db.query('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS b FROM feed_video_chunks WHERE video_id = ?', [m.id]);
  if (Number(r[0] && r[0].c) !== m.chunks || Number(r[0] && r[0].b) !== m.size) return { ok: false, message: 'Some parts of the video are missing — upload it again.' };
  const hash = crypto.createHash('sha256');
  for (let n = 0; n < m.chunks; n++) {
    const rows = await db.query('SELECT data FROM feed_video_chunks WHERE video_id = ? AND n = ? LIMIT 1', [m.id, n]);
    if (!rows.length) return { ok: false, message: 'Part ' + (n + 1) + ' is missing — upload it again.' };
    hash.update(Buffer.isBuffer(rows[0].data) ? rows[0].data : Buffer.from(rows[0].data || []));
  }
  if (hash.digest('hex') !== m.sha256) { await remove(m.id); return { ok: false, message: 'The uploaded video does not match the file (SHA-256) — upload it again.' }; }
  await db.query('UPDATE feed_videos SET status = ? WHERE id = ?', ['ready', m.id]);
  return { ok: true, id: m.id, url: m.url, mime: m.mime, size: m.size };
}

async function remove(id) {
  const vid = safeId(id);
  if (!vid) return { ok: false, message: 'Video not found.' };
  for (const k of [...cache.keys()]) if (k.startsWith(vid + '|')) cache.delete(k);
  try {
    const r = await db.query('DELETE FROM feed_video_chunks WHERE video_id = ?', [vid]);
    await db.query('DELETE FROM feed_videos WHERE id = ?', [vid]);
    return { ok: true, id: vid, freedChunks: Number(r && r.affectedRows) || 0 };
  } catch (e) { if (!missingTable(e)) throw e; return { ok: true, id: vid, freedChunks: 0 }; }
}

/** Admin storage card: "Videos: 312 MB of 2 GB used" + every video with its size. */
async function usage() {
  const lim = await getLimits();
  const base = { ready: false, bytes: 0, freeBytes: lim.videoTotalMb * MB, videos: 0, list: [], maxBytes: lim.videoMaxMb * MB, totalBytes: lim.videoTotalMb * MB, limits: lim, maxSeconds: lim.videoMaxSeconds, caps: CAPS };
  try {
    if (!(await ready(true))) return base;
    const rows = await db.query('SELECT id, mime, size_bytes, duration_s, status, created_at FROM feed_videos ORDER BY created_at DESC LIMIT 200', []);
    const list = rows.map((r) => ({ id: s(r.id), mime: s(r.mime), size: Number(r.size_bytes) || 0, duration: r.duration_s == null ? null : Number(r.duration_s), status: s(r.status), createdAt: s(r.created_at), url: urlOf(s(r.id), s(r.mime)) }));
    const bytes = list.reduce((a, x) => a + x.size, 0);
    return Object.assign(base, { ready: true, list, videos: list.filter((x) => x.status === 'ready').length, bytes, freeBytes: Math.max(0, lim.videoTotalMb * MB - bytes) });
  } catch (_) { return base; }
}

// ---- playback ----
const cache = new Map(); // "<id>|<n>" → Buffer
async function readChunk(id, n) {
  const key = id + '|' + n;
  if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return b; }
  const rows = await db.query('SELECT data FROM feed_video_chunks WHERE video_id = ? AND n = ? LIMIT 1', [id, n]);
  if (!rows.length) return null;
  const b = Buffer.isBuffer(rows[0].data) ? rows[0].data : Buffer.from(rows[0].data || []);
  cache.set(key, b);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return b;
}

/** "bytes=a-b" / "bytes=a-" / "bytes=-n" → { start, end } (end capped to ≤ PER_RESPONSE chunks), null = no Range, false = unsatisfiable. */
function parseRange(header, size) {
  const h = s(header);
  if (!h) return null;
  const m = h.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '') || !(size > 0)) return false;
  let start; let end;
  if (m[1] === '') { const n = Number(m[2]); if (!(n > 0)) return false; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start >= 0) || start >= size || end < start) return false;
  const cap = (Math.floor(start / CHUNK) + PER_RESPONSE) * CHUNK - 1;
  return { start, end: Math.min(end, cap) };
}
/** Which chunks (and which bytes inside them) a byte range needs. */
function chunkPlan(start, end) {
  const out = [];
  for (let n = Math.floor(start / CHUNK); n <= Math.floor(end / CHUNK); n++) out.push({ n, from: Math.max(0, start - n * CHUNK), to: Math.min(CHUNK, end - n * CHUNK + 1) });
  return out;
}

/** GET /v/<id>.mp4 */
async function serve(req, res) {
  const file = s(req.params.file);
  const mm = file.match(/^(fv[0-9a-f]{16})\.(mp4|webm)$/);
  const m = mm ? await info(mm[1]).catch(() => null) : null;
  if (!m || m.status !== 'ready' || TYPES[m.mime] !== mm[2]) return res.status(404).type('text/plain').send('not found');
  const etag = '"' + m.sha256.slice(0, 32) + '"';
  res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  if (s(req.headers['if-none-match']) === etag && !req.headers.range) return res.status(304).end();
  const range = parseRange(req.headers.range, m.size);
  if (range === false) return res.status(416).set('Content-Range', 'bytes */' + m.size).end();
  // No Range header: a normal 200, still streamed chunk by chunk (never the whole video in memory).
  const startB = range ? range.start : 0;
  const endB = range ? range.end : m.size - 1;
  res.status(range ? 206 : 200);
  if (range) res.set('Content-Range', 'bytes ' + startB + '-' + endB + '/' + m.size);
  res.set('Content-Length', String(endB - startB + 1));
  if (req.method === 'HEAD') return res.end();
  for (const part of chunkPlan(startB, endB)) {
    const b = await readChunk(m.id, part.n);
    if (!b) { res.destroy(); return; }
    if (!res.write(b.slice(part.from, part.to))) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

// What the admin page is allowed to type into the 🎬 Videos card (so the page and the server never disagree).
const CAPS = { maxMb: HARD_MAX_MB, minMb: 1, maxTotalMb: HARD_TOTAL_MB, minTotalMb: MIN_TOTAL_MB, maxSeconds: HARD_MAX_SECONDS, minSeconds: MIN_MAX_SECONDS };

module.exports = {
  start, chunk, finish, status, info, remove, usage, ready, serve, sniff, parseRange, chunkPlan, safeId, getLimits, saveLimits, cleanLimits, urlOf, mbText, durText,
  CHUNK, DEFAULT_MAX_MB, HARD_MAX_MB, DEFAULT_TOTAL_MB, HARD_TOTAL_MB, MIN_TOTAL_MB, DEFAULT_MAX_SECONDS, HARD_MAX_SECONDS, MIN_MAX_SECONDS, MAX_SECONDS, CAPS, TYPES, PER_RESPONSE, NOT_READY,
  _internal: { cache, reset: () => { readyVal = null; readyAt = 0; cache.clear(); } },
};
