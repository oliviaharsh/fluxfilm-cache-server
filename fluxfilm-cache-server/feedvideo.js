/**
 * FluxFilm - 🎬 uploaded Reel videos (admin → 🍿 What's new → Post type: Reel → Upload video).
 *
 * WHERE THE BYTES LIVE — two stores, the owner picks one in admin → 🍿 What's new → ⚙️ Settings → 🪣 Video storage:
 *   'db'  (how it started, 15 Sep 2026) tables feed_videos + feed_video_chunks (db/schema-v25.sql), raw binary in
 *         1 MB MEDIUMBLOB chunks (never base64). Chunks because Hostinger's max_allowed_packet (often 16–64 MB) would
 *         refuse one big row; MySQL because Hostinger rebuilds the app folder on every deploy (a file next to the code
 *         would vanish). The bytes count toward the 3 GB Hostinger database and the disk quota, so:
 *           one video ≤ videoMaxMb (default 60, admin can set 1–150) · all videos ≤ videoTotalMb (default 2048, max 5120)
 *         💡 Storage maths: 60 MB × 30 reels ≈ 1.8 GB of database space — that is why the total cap exists.
 *   'r2'  (16 Sep 2026, preferred) Cloudflare R2 (r2.js, db/schema-v27.sql). MySQL then keeps only the key, size, type,
 *         duration and etag — never the bytes. R2's free tier is 10 GB with no charge for downloads, so:
 *           one video ≤ videoMaxMbR2 (default 200, max 200) · all videos ≤ videoTotalMbR2 (default 8192 = 8 GB)
 * Both stores: MP4 / WebM only, checked by the file's first bytes, and ≤ videoMaxSeconds (default 300 = 5 minutes,
 * admin can set 10–600). Limits live in app_settings 'feed_video_settings'.
 *
 * Upload (admin only, adminfeed.js): start { mime, size, sha256, duration } → id · chunk ?id=&n= (raw ~1 MB body; every
 * chunk but the last is exactly 1 MB; chunk 0 must start like a real MP4 / WebM) · finish { id } → the server checks the
 * total size and the SHA-256 the browser computed → ready. Unfinished uploads older than a day are removed.
 *   db: each chunk is one INSERT; finish re-reads them in order and hashes them.
 *   R2: the chunks are gathered in memory and pushed to R2 — one PUT under 8 MB, otherwise an S3 multipart upload in
 *       8 MB parts (S3 wants every part but the last ≥ 5 MB, so 8 MB is safe) with retries; the SHA-256 is worked out
 *       as the bytes pass through, and finish HEADs the object so R2 itself confirms the size. If R2 does not answer,
 *       the upload FAILS with a clear message — it never quietly falls back to the database.
 * RESUME: status(id) says which parts arrived already, so a phone that lost its signal (or an admin app Android swapped
 * out) carries on from the first missing part instead of sending the whole video again. Nothing is ever buffered whole
 * on the server for a database upload — one ~1 MB body at a time in, at most 2 chunks at a time out. (An R2 upload
 * holds at most one 8 MB part in memory, and can only be resumed while the app has not restarted.)
 * A post links a READY video by id (feed.save checks it); delete frees the chunks / deletes the R2 object.
 *
 * Playback:
 *   db videos      GET /v/<id>.mp4 (or .webm) with HTTP Range → 206, reading ONLY the chunks the range needs (≤ 2 per
 *                  answer, so nothing loads a whole video into memory), Accept-Ranges, ETag = the SHA-256, long
 *                  immutable cache (a new upload = a new id), 304 on If-None-Match, nosniff. A tiny chunk cache
 *                  (≤ 24 MB) spares MySQL when a reel loops.
 *   R2 videos      the feed hands the browser the public R2 link when the owner set one (fastest, zero egress cost);
 *                  otherwise /v/<id>.mp4 streams it out of R2 with the Range passed straight through (never buffered).
 *                  /v/<id>.mp4 keeps working for old links either way: with a public URL it redirects to it.
 *
 * Moving: migrateNext() moves ONE database video to R2 (upload → HEAD check the size → flip the row → free the
 * chunks). Safe to re-run and safe to stop half way: a video only counts as moved after R2 confirms the size.
 */
const crypto = require('crypto');
const { Readable } = require('stream');
const db = require('./db');
const r2 = require('./r2');

const CHUNK = 1024 * 1024;
const MB = 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024; // R2: one-shot PUT below this, S3 multipart part size above it (S3 minimum is 5 MB)
const DEFAULT_MAX_MB = 60;
const HARD_MAX_MB = 150;
const DEFAULT_TOTAL_MB = 2048;
const HARD_TOTAL_MB = 5120;
const MIN_TOTAL_MB = 50;
const DEFAULT_MAX_MB_R2 = 200;
const HARD_MAX_MB_R2 = 200;
const DEFAULT_TOTAL_MB_R2 = 8192;
const HARD_TOTAL_MB_R2 = 20480;
const DEFAULT_MAX_SECONDS = 300;
const HARD_MAX_SECONDS = 600;
const MIN_MAX_SECONDS = 10;
const MAX_SECONDS = DEFAULT_MAX_SECONDS; // kept for older callers; the real cap is limits.videoMaxSeconds
const WARN_AT = 0.75; // amber banner in admin + a to-do line in the owner's daily summary
const TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const SETTINGS_KEY = 'feed_video_settings';
const CACHE_MAX = 24;
const PER_RESPONSE = 2;
const R2_PREFIX = 'reels/';
const NOT_READY = 'Run db/schema-v25.sql in phpMyAdmin first to upload videos (YouTube Shorts / Instagram links work already).';
const NOT_READY_R2 = 'Run db/schema-v27.sql in phpMyAdmin first — it makes room for Cloudflare R2 video storage.';

const s = (v) => String(v == null ? '' : v).trim();
const safeId = (v) => (/^fv[0-9a-f]{16}$/.test(s(v)) ? s(v) : '');
const missingTable = (e) => !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || /doesn't exist|no such table/i.test(String(e.message || '')));
const istString = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
const urlOf = (id, mime) => '/v/' + id + '.' + (TYPES[mime] || 'mp4');
const keyOf = (id, mime) => R2_PREFIX + id + '.' + (TYPES[mime] || 'mp4');

let readyAt = 0; let readyVal = null;
async function ready(force) {
  if (!force && readyVal !== null && Date.now() - readyAt < 60e3) return readyVal;
  try { await db.query('SELECT id FROM feed_videos LIMIT 1', []); await db.query('SELECT video_id FROM feed_video_chunks LIMIT 1', []); readyVal = true; }
  catch (e) { if (!missingTable(e)) throw e; readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}
/** Has db/schema-v27.sql been run (the R2 columns)? Anything that goes wrong counts as "no", so nothing ever breaks. */
let colsAt = 0; let colsVal = null;
async function hasR2Cols(force) {
  if (!force && colsVal !== null && Date.now() - colsAt < 60e3) return colsVal;
  try { await db.query('SELECT storage FROM feed_videos LIMIT 1', []); colsVal = true; }
  catch (_) { colsVal = false; }
  colsAt = Date.now();
  return colsVal;
}
/** 'r2' when the owner switched storage on AND schema-v27 is in; 'db' otherwise. */
async function storeMode() {
  let cfg = null;
  try { cfg = await r2.getConfig(); } catch (_) { cfg = null; }
  if (!cfg || !cfg.live) return 'db';
  return (await hasR2Cols()) ? 'r2' : 'db';
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
/** 🪣 The R2 caps sit beside the database ones, so switching store back and forth keeps both sets. */
function cleanLimitsR2(o) {
  const x = o || {};
  const maxMb = Math.floor(Number(x.videoMaxMbR2));
  const totalMb = Math.floor(Number(x.videoTotalMbR2));
  return {
    videoMaxMbR2: maxMb >= 1 ? Math.min(HARD_MAX_MB_R2, maxMb) : DEFAULT_MAX_MB_R2,
    videoTotalMbR2: totalMb >= MIN_TOTAL_MB ? Math.min(HARD_TOTAL_MB_R2, totalMb) : DEFAULT_TOTAL_MB_R2,
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
async function rawLimits() {
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
    return rows.length ? (JSON.parse(rows[0].value || '{}') || {}) : {};
  } catch (_) { return {}; }
}
async function getLimits() { return cleanLimits(await rawLimits()); }
async function getAllLimits() { const raw = await rawLimits(); return Object.assign(cleanLimits(raw), cleanLimitsR2(raw)); }
/** The caps that apply to the store in use → { mode, maxMb, totalMb, maxBytes, totalBytes, maxSeconds }. */
async function limitsFor(mode) {
  const all = await getAllLimits();
  const m = mode || (await storeMode());
  const maxMb = m === 'r2' ? all.videoMaxMbR2 : all.videoMaxMb;
  const totalMb = m === 'r2' ? all.videoTotalMbR2 : all.videoTotalMb;
  return { mode: m, all, maxMb, totalMb, maxBytes: maxMb * MB, totalBytes: totalMb * MB, maxSeconds: all.videoMaxSeconds };
}
async function saveLimits(input) {
  const o = input || {};
  const set = (k) => o[k] !== undefined && o[k] !== null && o[k] !== '';
  const maxMb = Math.floor(Number(o.videoMaxMb)); const totalMb = Math.floor(Number(o.videoTotalMb)); const secs = Math.floor(Number(o.videoMaxSeconds));
  const maxR2 = Math.floor(Number(o.videoMaxMbR2)); const totalR2 = Math.floor(Number(o.videoTotalMbR2));
  if (set('videoMaxMb') && !(maxMb >= 1 && maxMb <= HARD_MAX_MB)) return { ok: false, message: 'Max size per video must be 1–' + HARD_MAX_MB + ' MB.' };
  if (set('videoTotalMb') && !(totalMb >= MIN_TOTAL_MB && totalMb <= HARD_TOTAL_MB)) return { ok: false, message: 'Total video storage must be ' + MIN_TOTAL_MB + '–' + HARD_TOTAL_MB + ' MB (' + HARD_TOTAL_MB / 1024 + ' GB) — it all sits in the MySQL database and on the Hostinger disk.' };
  if (set('videoMaxSeconds') && !(secs >= MIN_MAX_SECONDS && secs <= HARD_MAX_SECONDS)) return { ok: false, message: 'Longest video must be ' + MIN_MAX_SECONDS + '–' + HARD_MAX_SECONDS + ' seconds (' + HARD_MAX_SECONDS / 60 + ' minutes).' };
  if (set('videoMaxMbR2') && !(maxR2 >= 1 && maxR2 <= HARD_MAX_MB_R2)) return { ok: false, message: 'With Cloudflare R2, max size per video must be 1–' + HARD_MAX_MB_R2 + ' MB.' };
  if (set('videoTotalMbR2') && !(totalR2 >= MIN_TOTAL_MB && totalR2 <= HARD_TOTAL_MB_R2)) return { ok: false, message: 'With Cloudflare R2, total video storage must be ' + MIN_TOTAL_MB + '–' + HARD_TOTAL_MB_R2 + ' MB (the free tier is 10240 MB).' };
  const cur = await getAllLimits();
  const merged = Object.assign({}, cur,
    set('videoMaxMb') ? { videoMaxMb: maxMb } : {},
    set('videoTotalMb') ? { videoTotalMb: totalMb } : {},
    set('videoMaxSeconds') ? { videoMaxSeconds: secs } : {},
    set('videoMaxMbR2') ? { videoMaxMbR2: maxR2 } : {},
    set('videoTotalMbR2') ? { videoTotalMbR2: totalR2 } : {});
  const next = Object.assign(cleanLimits(merged), cleanLimitsR2(merged));
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

// ---- rows ----
const SEL = 'id, mime, size_bytes, chunks, sha256, duration_s, status, created_at';
const SEL_R2 = SEL + ', storage, r2_key, r2_etag, upload_ref';
// The storage card does not need the chunk count or the hash, so it asks for less.
const LIST = 'id, mime, size_bytes, duration_s, status, created_at';
const LIST_R2 = LIST + ', storage, r2_key, r2_etag';
function rowToInfo(r, cols) {
  return {
    id: s(r.id), mime: s(r.mime), size: Number(r.size_bytes) || 0, chunks: Number(r.chunks) || 0, sha256: s(r.sha256),
    duration: r.duration_s == null ? null : Number(r.duration_s), status: s(r.status), createdAt: s(r.created_at),
    storage: cols && s(r.storage) === 'r2' ? 'r2' : 'db', r2Key: cols ? s(r.r2_key) : '', etag: cols ? s(r.r2_etag) : '',
    url: urlOf(s(r.id), s(r.mime)),
  };
}
async function info(id) {
  const vid = safeId(id);
  if (!vid) return null;
  const cols = await hasR2Cols();
  const rows = await db.query('SELECT ' + (cols ? SEL_R2 : SEL) + ' FROM feed_videos WHERE id = ? LIMIT 1', [vid]);
  if (!rows.length) return null;
  return rowToInfo(rows[0], cols);
}
/** Sizes / store of several videos at once (the 🧽 erase tool). Never a JOIN — one table only. */
async function infoMany(ids) {
  const list = [...new Set((ids || []).map(safeId).filter(Boolean))];
  const out = {};
  if (!list.length) return out;
  try {
    const cols = await hasR2Cols();
    const rows = await db.query('SELECT ' + (cols ? SEL_R2 : SEL) + ' FROM feed_videos WHERE id IN (' + list.map(() => '?').join(', ') + ')', list);
    for (const r of rows) { const m = rowToInfo(r, cols); out[m.id] = m; }
  } catch (_) {}
  return out;
}
/**
 * What the storefront should put in <video src>: the public Cloudflare R2 link when the owner set one, else
 * /v/<id>.mp4. Anything that goes wrong falls back to /v/<id>.mp4, which always works.
 */
async function urls(ids) {
  const list = [...new Set((ids || []).map(safeId).filter(Boolean))];
  const out = {};
  if (!list.length) return out;
  try {
    const cols = await hasR2Cols();
    const rows = await db.query('SELECT id, mime, status' + (cols ? ', storage, r2_key' : '') + ' FROM feed_videos WHERE id IN (' + list.map(() => '?').join(', ') + ')', list);
    const cfg = cols ? await r2.getConfig() : null;
    for (const r of rows) {
      if (s(r.status) !== 'ready') continue;
      const isR2 = cols && s(r.storage) === 'r2';
      const pub = isR2 ? r2.publicUrl(cfg, s(r.r2_key)) : '';
      out[s(r.id)] = { url: pub || urlOf(s(r.id), s(r.mime)), mime: s(r.mime), storage: isR2 ? 'r2' : 'db' };
    }
  } catch (_) {}
  return out;
}

// ---- upload ----
const uploads = new Map(); // 🪣 R2 uploads in flight: id → { key, next, buf[], bufLen, parts[], partNo, uploadId, hash, multipart }
const r2Fail = (e, what) => ({ ok: false, r2Down: true, message: '☁️ ' + what + ' — ' + s(e && e.message).slice(0, 220) + ' Nothing was saved in the database instead. Check ⚙️ Settings → 🪣 Video storage → 🔌 Test connection.' });

async function usedBytes(mode, cols) {
  if (cols) {
    const r = await db.query('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feed_videos WHERE storage = ?', [mode]);
    return Number(r[0] && r[0].n) || 0;
  }
  const r = await db.query('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feed_videos', []);
  return Number(r[0] && r[0].n) || 0;
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
  const mode = await storeMode();
  const lim = await limitsFor(mode);
  if (o.duration !== undefined && o.duration !== null && o.duration !== '' && (!(dur > 0) || dur > lim.maxSeconds + 0.5)) {
    return { ok: false, tooLong: true, seconds: dur > 0 ? Math.round(dur) : 0, limitSeconds: lim.maxSeconds,
      message: 'That video is ' + durText(dur) + ' — the limit is ' + durText(lim.maxSeconds) + '. Trim it, or raise the limit in the 🎬 Videos card.' };
  }
  if (size > lim.maxBytes) {
    return { ok: false, tooBig: true, bytes: size, limitBytes: lim.maxBytes,
      message: mbText(size) + ' — the limit is ' + lim.maxMb + ' MB. Try 720p, or raise the limit in ⚙️ settings.' };
  }
  if (!(await ready())) return { ok: false, notReady: true, message: NOT_READY };
  const cols = await hasR2Cols();
  let cfg = null;
  if (mode === 'r2') {
    cfg = await r2.getConfig();
    // Never a quiet fall back to the database: if R2 does not answer, the upload stops here and says why.
    try { await r2.headBucket(cfg); } catch (e) { return r2Fail(e, 'Cloudflare R2 did not answer, so the video was not uploaded'); }
  }
  try {
    const old = await db.query('SELECT id FROM feed_videos WHERE status = ? AND created_at < ?', ['uploading', istString(Date.now() - 24 * 3600e3)]);
    for (const r of old) await remove(r.id);
  } catch (_) {}
  const used = await usedBytes(mode, cols);
  if (used + size > lim.totalBytes) {
    return { ok: false, full: true, bytes: size, freeBytes: Math.max(0, lim.totalBytes - used),
      message: 'Video storage is full: ' + mbText(Math.max(0, lim.totalBytes - used)) + ' free of ' + mbText(lim.totalBytes) + ', this video needs ' + mbText(size) + '. Delete old Reel videos (🧽 Erase older reels), or raise the total in the 🎬 Videos card.' };
  }
  const id = 'fv' + crypto.randomBytes(8).toString('hex');
  const chunks = Math.ceil(size / CHUNK);
  const key = keyOf(id, mime);
  if (cols) {
    await db.query('INSERT INTO feed_videos (id, mime, size_bytes, chunks, sha256, duration_s, status, created_at, storage, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, mime, size, chunks, sha, dur > 0 ? Math.round(dur * 10) / 10 : null, 'uploading', istString(), mode, mode === 'r2' ? key : null]);
  } else {
    await db.query('INSERT INTO feed_videos (id, mime, size_bytes, chunks, sha256, duration_s, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, mime, size, chunks, sha, dur > 0 ? Math.round(dur * 10) / 10 : null, 'uploading', istString()]);
  }
  if (mode === 'r2') uploads.set(id, { id, key, mime, size, chunks, next: 0, buf: [], bufLen: 0, parts: [], partNo: 0, uploadId: '', hash: crypto.createHash('sha256'), multipart: size > PART_SIZE });
  return { ok: true, id, chunks, chunkSize: CHUNK, maxBytes: lim.maxBytes, maxSeconds: lim.maxSeconds, storage: mode };
}

/**
 * 📶 Resume: which parts of an unfinished upload the server already has. The admin page asks for this when a chunk
 * keeps failing (or after the app was swapped out mid-upload) and carries on from the first missing part.
 * Only counts the parts — the bytes themselves are never read here. An R2 upload can only be resumed while the app
 * has not restarted (its parts are in flight to Cloudflare, not in MySQL); then it says to start again.
 */
async function status(id) {
  const m = await info(id).catch(() => null);
  if (!m) return { ok: false, message: 'Upload not found — start again.' };
  if (m.status === 'ready') return { ok: true, id: m.id, done: true, chunks: m.chunks, chunkSize: CHUNK, have: [], missing: [], url: m.url };
  let have = [];
  if (m.storage === 'r2') {
    const st = uploads.get(m.id);
    if (!st) return { ok: false, restart: true, message: 'This upload was interrupted (the app restarted) — upload the video again.' };
    for (let n = 0; n < st.next; n++) have.push(n);
  } else {
    const rows = await db.query('SELECT n FROM feed_video_chunks WHERE video_id = ?', [m.id]);
    have = rows.map((r) => Number(r.n)).filter((n) => Number.isInteger(n) && n >= 0 && n < m.chunks).sort((a, b) => a - b);
  }
  const seen = new Set(have);
  const missing = [];
  for (let n = 0; n < m.chunks; n++) if (!seen.has(n)) missing.push(n);
  return { ok: true, id: m.id, done: false, chunks: m.chunks, chunkSize: CHUNK, size: m.size, storage: m.storage, have, missing, next: missing.length ? missing[0] : m.chunks };
}

/** Push what is waiting in memory to R2 as one multipart part. */
async function flushPart(st, cfg) {
  if (!st.bufLen) return;
  if (!st.uploadId) { const c = await r2.createMultipart(cfg, st.key, st.mime); st.uploadId = c.uploadId; }
  const body = Buffer.concat(st.buf, st.bufLen);
  st.buf = []; st.bufLen = 0;
  st.partNo += 1;
  const p = await r2.uploadPart(cfg, st.key, st.uploadId, st.partNo, body);
  st.parts.push({ partNumber: p.partNumber, etag: p.etag });
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
  if (m.storage !== 'r2') {
    await db.query('INSERT INTO feed_video_chunks (video_id, n, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [m.id, k, buf]);
    return { ok: true, n: k };
  }
  const st = uploads.get(m.id);
  if (!st) return { ok: false, restart: true, message: 'This upload was interrupted (the app restarted) — upload the video again.' };
  if (k === st.next - 1) return { ok: true, n: k, already: true }; // the browser retried a part we already took
  if (k !== st.next) return { ok: false, message: 'Parts must be sent in order — upload the video again.', next: st.next };
  st.hash.update(buf); st.buf.push(buf); st.bufLen += buf.length; st.next = k + 1;
  if (st.multipart && st.bufLen >= PART_SIZE && st.next < m.chunks) {
    const cfg = await r2.getConfig();
    try { await flushPart(st, cfg); }
    catch (e) { await abortUpload(m.id); return r2Fail(e, 'Cloudflare R2 refused part ' + (st.partNo + 1)); }
  }
  return { ok: true, n: k };
}

/** Give up on an R2 upload: tell R2 to drop the parts and remove the half-written row. */
async function abortUpload(id) {
  const st = uploads.get(id);
  uploads.delete(id);
  if (st && st.uploadId) { try { await r2.abortMultipart(await r2.getConfig(), st.key, st.uploadId); } catch (_) {} }
  try { await db.query('DELETE FROM feed_videos WHERE id = ?', [safeId(id)]); } catch (_) {}
}

/** Every chunk there, sizes add up, and the SHA-256 of the chunks in order = what the browser computed → ready. */
async function finish(id) {
  const m = await info(id);
  if (!m) return { ok: false, message: 'Upload not found.' };
  if (m.status === 'ready') return { ok: true, id: m.id, url: m.url, mime: m.mime, size: m.size, storage: m.storage };
  if (m.storage === 'r2') return finishR2(m);
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
  return { ok: true, id: m.id, url: m.url, mime: m.mime, size: m.size, storage: 'db' };
}

async function finishR2(m) {
  const st = uploads.get(m.id);
  if (!st) { await abortUpload(m.id); return { ok: false, restart: true, message: 'This upload was interrupted (the app restarted) — upload the video again.' }; }
  if (st.next !== m.chunks) return { ok: false, message: 'Some parts of the video are missing — upload it again.' };
  if (st.hash.copy().digest('hex') !== m.sha256) { await abortUpload(m.id); return { ok: false, message: 'The uploaded video does not match the file (SHA-256) — upload it again.' }; }
  const cfg = await r2.getConfig();
  let etag = '';
  try {
    if (st.multipart) { await flushPart(st, cfg); const c = await r2.completeMultipart(cfg, st.key, st.uploadId, st.parts); etag = c.etag; }
    else { const p = await r2.putObject(cfg, st.key, Buffer.concat(st.buf, st.bufLen), st.mime); etag = p.etag; }
  } catch (e) { await abortUpload(m.id); return r2Fail(e, 'Cloudflare R2 could not finish the upload'); }
  // Trust nothing: ask R2 how big the object really is before a post may use it.
  try {
    const h = await r2.headObject(cfg, st.key);
    if (h.size !== m.size) { try { await r2.deleteObject(cfg, st.key); } catch (_) {} await abortUpload(m.id); return { ok: false, message: '☁️ Cloudflare R2 stored ' + mbText(h.size) + ' but the video is ' + mbText(m.size) + ' — upload it again.' }; }
  } catch (e) { await abortUpload(m.id); return r2Fail(e, 'Cloudflare R2 could not confirm the upload'); }
  uploads.delete(m.id);
  await db.query('UPDATE feed_videos SET status = ?, r2_etag = ?, upload_ref = NULL WHERE id = ?', ['ready', etag || null, m.id]);
  r2.flushOps(true).catch(() => {});
  return { ok: true, id: m.id, url: m.url, mime: m.mime, size: m.size, storage: 'r2', key: st.key, etag };
}

async function remove(id) {
  const vid = safeId(id);
  if (!vid) return { ok: false, message: 'Video not found.' };
  for (const k of [...cache.keys()]) if (k.startsWith(vid + '|')) cache.delete(k);
  let m = null; try { m = await info(vid); } catch (_) { m = null; }
  uploads.delete(vid);
  let r2Deleted = false; let r2Error = '';
  if (m && m.storage === 'r2' && m.r2Key) {
    // A failed R2 delete must never stop the post / row from going: it is logged and left for the owner.
    try { await r2.deleteObject(await r2.getConfig(), m.r2Key); r2Deleted = true; }
    catch (e) { r2Error = s(e && e.message).slice(0, 200); console.log('[feed video] could not delete ' + m.r2Key + ' from R2:', r2Error); }
  }
  try {
    const r = await db.query('DELETE FROM feed_video_chunks WHERE video_id = ?', [vid]);
    await db.query('DELETE FROM feed_videos WHERE id = ?', [vid]);
    return { ok: true, id: vid, freedChunks: Number(r && r.affectedRows) || 0, freedBytes: m ? m.size : 0, storage: m ? m.storage : 'db', r2Deleted, r2Error };
  } catch (e) { if (!missingTable(e)) throw e; return { ok: true, id: vid, freedChunks: 0, freedBytes: 0, storage: 'db', r2Deleted, r2Error }; }
}

// ---- admin storage card ----
function storeBox(bytes, videos, totalBytes) {
  const pct = totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0;
  return { bytes, videos, totalBytes, freeBytes: Math.max(0, totalBytes - bytes), pct, over: pct >= WARN_AT * 100, text: mbText(bytes) + ' of ' + mbText(totalBytes) };
}
/** Admin storage card: "Videos: 312 MB of 2 GB used" / "R2: 1.2 GB of 8 GB used" + every video with its size. */
async function usage() {
  const all = await getAllLimits();
  const mode = await storeMode();
  const dbTotal = all.videoTotalMb * MB; const r2Total = all.videoTotalMbR2 * MB;
  const lim = mode === 'r2' ? { maxMb: all.videoMaxMbR2, totalMb: all.videoTotalMbR2 } : { maxMb: all.videoMaxMb, totalMb: all.videoTotalMb };
  let cfg = { on: false, ready: false, live: false, publicBase: '' };
  try { cfg = await r2.getConfig(); } catch (_) {}
  const base = {
    ready: false, mode, bytes: 0, freeBytes: lim.totalMb * MB, videos: 0, list: [], maxBytes: lim.maxMb * MB, totalBytes: lim.totalMb * MB,
    limits: all, maxSeconds: all.videoMaxSeconds, caps: CAPS, warn: null, schemaV27: false, warnAt: WARN_AT,
    db: storeBox(0, 0, dbTotal), r2: Object.assign(storeBox(0, 0, r2Total), r2.publicConfig(cfg), { ops: null }),
    migrate: { pending: 0, pendingBytes: 0 },
  };
  try {
    if (!(await ready(true))) return base;
    const cols = await hasR2Cols(true);
    const rows = await db.query('SELECT ' + (cols ? LIST_R2 : LIST) + ' FROM feed_videos ORDER BY created_at DESC LIMIT 200', []);
    const list = rows.map((r) => {
      const m = rowToInfo(r, cols);
      return { id: m.id, mime: m.mime, size: m.size, duration: m.duration, status: m.status, createdAt: m.createdAt, storage: m.storage, url: m.url, publicUrl: m.storage === 'r2' ? r2.publicUrl(cfg, m.r2Key) : '' };
    });
    const sum = (f) => list.filter(f).reduce((a, x) => a + x.size, 0);
    const dbBox = storeBox(sum((x) => x.storage === 'db'), list.filter((x) => x.storage === 'db' && x.status === 'ready').length, dbTotal);
    const r2Box = Object.assign(storeBox(sum((x) => x.storage === 'r2'), list.filter((x) => x.storage === 'r2' && x.status === 'ready').length, r2Total), r2.publicConfig(cfg));
    r2Box.ops = cfg.ready ? await r2.getOps().catch(() => null) : null;
    const active = mode === 'r2' ? r2Box : dbBox;
    const pending = list.filter((x) => x.storage === 'db' && x.status === 'ready');
    const warns = [];
    if (active.over) warns.push({ store: mode, pct: active.pct, text: (mode === 'r2' ? 'R2 videos: ' : 'Videos: ') + active.text + ' (' + active.pct + '%)' });
    if (mode === 'r2' && dbBox.over && dbBox.bytes > 0) warns.push({ store: 'db', pct: dbBox.pct, text: 'Videos still in the database: ' + dbBox.text + ' (' + dbBox.pct + '%)' });
    return Object.assign(base, {
      ready: true, schemaV27: cols, list, videos: active.videos, bytes: active.bytes, freeBytes: active.freeBytes, totalBytes: active.totalBytes,
      db: dbBox, r2: r2Box, warn: warns.length ? Object.assign({ over: true }, warns[0], { all: warns }) : null,
      migrate: { pending: pending.length, pendingBytes: pending.reduce((a, x) => a + x.size, 0) },
    });
  } catch (_) { return base; }
}

// ---- ⬆️ move database videos to R2 (one call = one video, so the admin page can show progress) ----
async function migrateStatus() {
  const out = { ok: true, ready: false, pending: 0, pendingBytes: 0, moved: 0, movedBytes: 0 };
  if (!(await ready()) || !(await hasR2Cols())) return out;
  let cfg = null; try { cfg = await r2.getConfig(); } catch (_) {}
  out.ready = !!(cfg && cfg.live);
  try {
    const rows = await db.query("SELECT storage, COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS b FROM feed_videos WHERE status = 'ready' GROUP BY storage", []);
    for (const r of rows) {
      if (s(r.storage) === 'r2') { out.moved = Number(r.c) || 0; out.movedBytes = Number(r.b) || 0; }
      else { out.pending = Number(r.c) || 0; out.pendingBytes = Number(r.b) || 0; }
    }
  } catch (_) {}
  return out;
}
/**
 * Move ONE ready video from the database to R2. Order matters: upload → HEAD (R2 confirms the size) → flip the row →
 * only then free the chunks. Stopping half way is safe, and running it again just does the next one.
 */
async function migrateNext() {
  if (!(await ready())) return { ok: false, message: NOT_READY };
  if (!(await hasR2Cols())) return { ok: false, message: NOT_READY_R2 };
  const cfg = await r2.getConfig();
  if (!cfg.live) return { ok: false, message: 'Switch 🪣 Video storage to Cloudflare R2 first.' };
  const st = await migrateStatus();
  const rows = await db.query("SELECT " + SEL_R2 + " FROM feed_videos WHERE status = 'ready' AND storage = 'db' ORDER BY created_at ASC LIMIT 1", []);
  if (!rows.length) return { ok: true, done: true, moved: null, left: 0, leftBytes: 0, message: '✅ All Reel videos are in Cloudflare R2.' };
  const m = rowToInfo(rows[0], true);
  const key = keyOf(m.id, m.mime);
  const readRaw = async (n) => {
    const r = await db.query('SELECT data FROM feed_video_chunks WHERE video_id = ? AND n = ? LIMIT 1', [m.id, n]);
    return r.length ? (Buffer.isBuffer(r[0].data) ? r[0].data : Buffer.from(r[0].data || [])) : null;
  };
  const gone = (n) => ({ ok: false, message: 'Part ' + (n + 1) + ' of video ' + m.id + ' is missing in the database — delete that video instead.' });
  let etag = '';
  try {
    if (m.size > PART_SIZE) {
      const c = await r2.createMultipart(cfg, key, m.mime);
      const parts = []; let hold = []; let holdLen = 0; let partNo = 0;
      for (let n = 0; n < m.chunks; n++) {
        const b = await readRaw(n);
        if (!b) { await r2.abortMultipart(cfg, key, c.uploadId); return gone(n); }
        hold.push(b); holdLen += b.length;
        if (holdLen >= PART_SIZE && n < m.chunks - 1) { partNo += 1; const p = await r2.uploadPart(cfg, key, c.uploadId, partNo, Buffer.concat(hold, holdLen)); parts.push({ partNumber: p.partNumber, etag: p.etag }); hold = []; holdLen = 0; }
      }
      if (holdLen) { partNo += 1; const p = await r2.uploadPart(cfg, key, c.uploadId, partNo, Buffer.concat(hold, holdLen)); parts.push({ partNumber: p.partNumber, etag: p.etag }); }
      etag = (await r2.completeMultipart(cfg, key, c.uploadId, parts)).etag;
    } else {
      const bufs = [];
      for (let n = 0; n < m.chunks; n++) { const b = await readRaw(n); if (!b) return gone(n); bufs.push(b); }
      etag = (await r2.putObject(cfg, key, Buffer.concat(bufs), m.mime)).etag;
    }
    const h = await r2.headObject(cfg, key);
    if (h.size !== m.size) { try { await r2.deleteObject(cfg, key); } catch (_) {} return { ok: false, message: '☁️ R2 stored ' + mbText(h.size) + ' of video ' + m.id + ' but it is ' + mbText(m.size) + ' — nothing was deleted, try again.' }; }
  } catch (e) { return r2Fail(e, 'Could not move video ' + m.id + ' to Cloudflare R2'); }
  await db.query('UPDATE feed_videos SET storage = ?, r2_key = ?, r2_etag = ?, moved_at = ? WHERE id = ?', ['r2', key, etag || null, istString(), m.id]);
  const del = await db.query('DELETE FROM feed_video_chunks WHERE video_id = ?', [m.id]);
  for (const k of [...cache.keys()]) if (k.startsWith(m.id + '|')) cache.delete(k);
  r2.flushOps(true).catch(() => {});
  const left = Math.max(0, st.pending - 1);
  return {
    ok: true, done: left === 0, moved: { id: m.id, size: m.size, key, etag, freedChunks: Number(del && del.affectedRows) || 0 },
    left, leftBytes: Math.max(0, st.pendingBytes - m.size),
    message: '⬆️ Moved ' + mbText(m.size) + ' to Cloudflare R2' + (left ? ' · ' + left + ' left' : ' · all done'),
  };
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
  if (m.storage === 'r2') return serveR2(m, req, res);
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

/** 🪣 R2: send the browser straight to the public link when there is one, otherwise stream the bytes through. */
async function serveR2(m, req, res) {
  let cfg = null;
  try { cfg = await r2.getConfig(); } catch (_) { cfg = null; }
  if (!cfg || !cfg.ready) return res.status(503).type('text/plain').send('video storage not set up');
  const pub = r2.publicUrl(cfg, m.r2Key);
  if (pub) { res.set('Cache-Control', 'public, max-age=3600'); return res.redirect(302, pub); }
  let up = null;
  try { up = await r2.getObject(cfg, m.r2Key, s(req.headers.range) || ''); }
  catch (e) {
    if (e && e.status === 416) return res.status(416).set('Content-Range', 'bytes */' + m.size).end();
    console.log('[feed video] R2 read failed for ' + m.id + ':', s(e && e.message).slice(0, 200));
    return res.status(502).type('text/plain').send('video not available');
  }
  const cr = r2.headerOf(up, 'content-range'); const cl = r2.headerOf(up, 'content-length');
  res.status(up.status === 206 ? 206 : 200);
  if (cr) res.set('Content-Range', cr);
  if (cl) res.set('Content-Length', cl);
  if (req.method === 'HEAD') { try { if (up.body && up.body.cancel) up.body.cancel(); } catch (_) {} return res.end(); }
  if (!up.body) return res.end();
  // Streamed, never buffered: a 200 MB reel must not sit in the app's memory.
  const stream = typeof up.body.getReader === 'function' ? Readable.fromWeb(up.body) : up.body;
  await new Promise((done) => {
    let over = false; const fin = () => { if (!over) { over = true; done(); } };
    stream.on('error', (e) => { console.log('[feed video] R2 stream broke:', s(e && e.message).slice(0, 120)); try { res.destroy(); } catch (_) {} fin(); });
    stream.on('end', fin);
    res.on('close', fin);
    stream.pipe(res);
  });
}

// What the admin page is allowed to type into the 🎬 Videos card (so the page and the server never disagree).
const CAPS = {
  maxMb: HARD_MAX_MB, minMb: 1, maxTotalMb: HARD_TOTAL_MB, minTotalMb: MIN_TOTAL_MB, maxSeconds: HARD_MAX_SECONDS, minSeconds: MIN_MAX_SECONDS,
  maxMbR2: HARD_MAX_MB_R2, maxTotalMbR2: HARD_TOTAL_MB_R2,
};

module.exports = {
  start, chunk, finish, status, info, infoMany, urls, remove, usage, ready, hasR2Cols, storeMode, serve, sniff, parseRange, chunkPlan, safeId,
  getLimits, getAllLimits, limitsFor, saveLimits, cleanLimits, cleanLimitsR2, urlOf, keyOf, mbText, durText, migrateNext, migrateStatus, abortUpload,
  CHUNK, PART_SIZE, DEFAULT_MAX_MB, HARD_MAX_MB, DEFAULT_TOTAL_MB, HARD_TOTAL_MB, MIN_TOTAL_MB, DEFAULT_MAX_MB_R2, HARD_MAX_MB_R2, DEFAULT_TOTAL_MB_R2, HARD_TOTAL_MB_R2,
  DEFAULT_MAX_SECONDS, HARD_MAX_SECONDS, MIN_MAX_SECONDS, MAX_SECONDS, WARN_AT, CAPS, TYPES, PER_RESPONSE, NOT_READY, NOT_READY_R2, R2_PREFIX,
  _internal: { cache, uploads, reset: () => { readyVal = null; readyAt = 0; colsVal = null; colsAt = 0; cache.clear(); uploads.clear(); } },
};
