/**
 * FluxFilm - 🍿 "What's new" feed: Instagram-style posts about new movies and shows (admin → 🍿 Feed).
 * No schema change. app_settings keys:
 *   feed_posts        JSON list of posts (max 200)
 *   feed_img_<id>     uploaded picture (data URL, shrunk in the admin page first)
 *   feed_stats        { <id>: { views, likes, clicks, shares } }  (buffered in memory, written once a minute)
 *   feed_settings     { tmdbKey, autoPublish, platforms, languages, minPopularity, minVotes, maxPerDay,
 *                       autoHideDays, providerMap }  — tmdbKey never leaves the server
 *   feed_job          last import run: { lastRun, nextRun, lastResult, lastError, day, dayCount, seen[] }
 *
 * Post status: OFF (switched off / draft) · SCHEDULED (before "publish at") · HIDDEN (after "hide after") · LIVE.
 * Customers see LIVE posts only: pinned first, then newest.
 *
 * TMDB automation (themoviedb.org, free key). Once the owner saves a key, the import job runs 90 s after start
 * and every 6 hours: TMDB discover (watch_region=IN, flatrate) for each platform FluxFilm sells (active catalog
 * services → TMDB provider ids), new/popular movies + series from the last 30 days / next 14 days, filtered by
 * language, popularity and vote count. Deduped by TMDB type+id (also posts the owner deleted are not re-imported),
 * max N new posts per India day, each hidden after N days. Auto-publish is ON by default once a key is set;
 * switched off, imports wait as drafts (OFF) for approval. The job never changes a post the owner edited; an
 * unedited imported post only gets its poster / story / genres refreshed. No key or TMDB down = nothing happens
 * (the error is shown in admin); manual posts always work.
 */
const crypto = require('crypto');
const db = require('./db');

const KEY = 'feed_posts';
const STATS_KEY = 'feed_stats';
const SETTINGS_KEY = 'feed_settings';
const IMG_PREFIX = 'feed_img_';
const MAX_POSTS = 200;
const TYPES = ['movie', 'series', 'announcement'];
const CTAS = ['service', 'none'];
const KINDS = ['view', 'like', 'unlike', 'click', 'share'];
const IMG_MAX = 450000; // ~330 KB picture; the admin page shrinks uploads first
const IMG_HOSTS = ['image.tmdb.org', 'i.ytimg.com', 'img.youtube.com'];
const TRAILER_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w780';
/**
 * Default TMDB watch-provider ids for India (watch_region=IN). Matched against catalog service names
 * (lower-case "contains"). The owner can change them in admin → 🍿 Feed → Settings, and
 * "Check provider ids" lists TMDB's current ids. Several ids = any of them ("|").
 *   Netflix 8 · Amazon Prime Video 119 · JioHotstar 2336 (older "Hotstar" 122, "JioCinema" 220)
 *   Sony LIV 237 · Zee5 232 · Crunchyroll 283 · YouTube Premium 188 · Apple TV+ 350
 */
const DEFAULT_PROVIDERS = { netflix: '8', prime: '119', hotstar: '2336|122|220', sony: '237', zee5: '232', crunchyroll: '283', youtube: '188', apple: '350' };
const LANGS = { en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', ko: 'Korean', ja: 'Japanese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', zh: 'Chinese', th: 'Thai', tr: 'Turkish', pt: 'Portuguese' };

const s = (v) => String(v == null ? '' : v).trim();
const clean = (v, max) => s(v).replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, max);
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const safeId = (v) => s(v).replace(/[^a-z0-9]/g, '').slice(0, 20);

async function readKey(key) {
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]); return r.length ? r[0].value : null; }
  catch (e) { if (missingTable(e)) return null; throw e; }
}
async function writeKey(key, value) {
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, value]);
}
function parseJson(v, dflt) { try { const x = JSON.parse(v || ''); return x && typeof x === 'object' ? x : dflt; } catch (_) { return dflt; } }
function toIso(v) {
  const t = s(v);
  if (!t) return '';
  // "2026-09-30T23:59" from the admin form is India time.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + (t.length === 16 ? ':00' : '') + '+05:30');
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function cleanCaption(v) {
  return s(v).replace(/\r\n?/g, '\n').replace(/[<>]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, 600);
}
function cleanTags(v, max) {
  const list = Array.isArray(v) ? v : s(v).split(',');
  const out = [];
  for (const x of list) { const t = clean(x, max); if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); if (out.length >= 6) break; }
  return out;
}
function hostOk(url, hosts) {
  try { const u = new URL(url); return u.protocol === 'https:' && hosts.includes(u.hostname.toLowerCase()) && !/[\s"'<>]/.test(url); } catch (_) { return false; }
}

function validate(input, existing) {
  const i = input || {}; const errors = [];
  const out = Object.assign({}, existing || {});
  const now = new Date().toISOString();
  out.id = (existing && existing.id) || ('fp' + crypto.randomBytes(5).toString('hex'));
  out.type = TYPES.includes(i.type) ? i.type : 'movie';
  out.title = clean(i.title, 100);
  if (!out.title) errors.push('Write a title.');
  out.service = clean(i.service, 60);
  if (out.type !== 'announcement' && !out.service) errors.push('Pick the platform (e.g. Netflix).');
  out.caption = cleanCaption(i.caption);
  const rd = s(i.releaseDate).slice(0, 10);
  if (rd && !/^\d{4}-\d{2}-\d{2}$/.test(rd)) errors.push('Release date is not valid.');
  out.releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(rd) ? rd : '';
  out.languages = cleanTags(i.languages, 20);
  out.genres = cleanTags(i.genres, 24);
  out.imageUrl = s(i.imageUrl).slice(0, 300);
  if (out.imageUrl && !hostOk(out.imageUrl, IMG_HOSTS)) errors.push('Picture link must be https:// from ' + IMG_HOSTS.join(', ') + ' — or upload a picture.');
  out.trailerUrl = s(i.trailerUrl).slice(0, 300);
  if (out.trailerUrl && !hostOk(out.trailerUrl, TRAILER_HOSTS)) errors.push('Trailer must be an https:// YouTube link.');
  out.cta = CTAS.includes(i.cta) ? i.cta : (out.service ? 'service' : 'none');
  if (!out.service) out.cta = 'none';
  out.pinned = i.pinned === true || i.pinned === 'true' || i.pinned === 1;
  out.active = i.active === true || i.active === 'true' || i.active === 1;
  const pa = toIso(i.publishAt); const ha = toIso(i.hideAfter);
  if (pa === null) errors.push('"Publish at" is not valid.');
  if (ha === null) errors.push('"Hide after" is not valid.');
  out.publishAt = pa || ''; out.hideAfter = ha || '';
  if (out.publishAt && out.hideAfter && out.hideAfter <= out.publishAt) errors.push('"Hide after" must be after "Publish at".');
  out.source = existing && existing.source ? existing.source : (i.source === 'tmdb' ? 'tmdb' : 'manual');
  out.tmdbKey = existing && existing.tmdbKey ? existing.tmdbKey : (/^(movie|tv):\d{1,9}$/.test(s(i.tmdbKey)) ? s(i.tmdbKey) : '');
  out.hasImage = !!(existing && existing.hasImage);
  out.importedAt = existing ? (existing.importedAt || '') : (out.source === 'tmdb' && i.importedAt === true ? now : '');
  // An imported post whose words / picture / dates the owner changed is never touched by the import job again.
  const CONTENT = ['type', 'title', 'service', 'caption', 'releaseDate', 'imageUrl', 'trailerUrl', 'cta', 'languages', 'genres'];
  out.edited = !!(existing && (existing.edited || (existing.source === 'tmdb' && CONTENT.some((k) => JSON.stringify(existing[k] == null ? '' : existing[k]) !== JSON.stringify(out[k])))));
  out.createdAt = (existing && existing.createdAt) || now;
  out.updatedAt = now;
  return { ok: !errors.length, post: out, errors };
}

async function list() { const x = parseJson(await readKey(KEY), []); return Array.isArray(x) ? x : []; }
async function saveAll(items) { await writeKey(KEY, JSON.stringify(items)); cache = null; }

async function save(input) {
  const items = await list();
  const idx = input && input.id ? items.findIndex((p) => p.id === input.id) : -1;
  if (input && input.id && idx < 0) return { ok: false, message: 'Post not found.' };
  const v = validate(input, idx >= 0 ? items[idx] : null);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  if (idx < 0 && items.length >= MAX_POSTS) return { ok: false, message: 'Too many posts — delete old ones first (max ' + MAX_POSTS + ').' };
  if (idx >= 0) items[idx] = v.post; else items.unshift(v.post);
  await saveAll(items);
  return { ok: true, post: v.post, created: idx < 0 };
}
async function remove(id) {
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Post not found.' };
  await saveAll(items.filter((x) => x.id !== id));
  try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [IMG_PREFIX + id]); } catch (_) {}
  return { ok: true, post: p };
}
async function setImage(id, dataUrl) {
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Save the post first, then add a picture.' };
  const v = s(dataUrl);
  if (v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { ok: false, message: 'Please upload a PNG, JPG or WebP picture.' };
  if (v.length > IMG_MAX) return { ok: false, message: 'That picture is too big — please use a smaller one.' };
  try {
    if (v) await writeKey(IMG_PREFIX + id, v); else await db.query('DELETE FROM app_settings WHERE setting_key = ?', [IMG_PREFIX + id]);
  } catch (e) {
    if (/Data too long/i.test(String(e.message))) return { ok: false, message: 'Run db/schema-v17.sql first (it makes room for pictures).' };
    throw e;
  }
  p.hasImage = !!v; p.updatedAt = new Date().toISOString();
  await saveAll(items);
  return { ok: true, hasImage: p.hasImage, post: p };
}
async function image(id) {
  const v = s(await readKey(IMG_PREFIX + safeId(id)));
  const m = v.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  return m ? { type: m[1], buf: Buffer.from(m[2], 'base64') } : null;
}

function statusOf(p, now) {
  const t = (now || new Date()).toISOString();
  if (!p.active) return 'OFF';
  if (p.publishAt && t < p.publishAt) return 'SCHEDULED';
  if (p.hideAfter && t >= p.hideAfter) return 'HIDDEN';
  return 'LIVE';
}
const sortDate = (p) => p.publishAt || p.createdAt || '';
function sortPosts(items) {
  return items.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (sortDate(b) < sortDate(a) ? -1 : sortDate(b) > sortDate(a) ? 1 : 0));
}

// ---- public ----
let cache = null; let cacheAt = 0;
async function publicList(now) {
  if (!now && cache && Date.now() - cacheAt < 30e3) return cache;
  const [items, st] = await Promise.all([list(), stats().catch(() => ({}))]);
  const live = sortPosts(items.filter((p) => statusOf(p, now) === 'LIVE')).slice(0, 60);
  const out = {
    ok: true,
    tmdb: live.some((p) => p.source === 'tmdb'),
    posts: live.map((p) => ({
      id: p.id, type: p.type, title: p.title, service: p.service, caption: p.caption, releaseDate: p.releaseDate,
      languages: p.languages || [], genres: p.genres || [], trailerUrl: p.trailerUrl, cta: p.cta, pinned: !!p.pinned,
      date: sortDate(p), likes: (st[p.id] || {}).likes || 0, tmdb: p.source === 'tmdb',
      image: p.hasImage ? '/feed-img/' + p.id + '?v=' + encodeURIComponent(p.updatedAt || '') : (p.imageUrl || ''),
    })),
  };
  if (!now) { cache = out; cacheAt = Date.now(); }
  return out;
}
/** Ticker fallback when trending_items is empty: the newest live post titles. */
async function trendingLines() {
  try {
    const r = await publicList();
    return r.posts.slice(0, 8).map((p) => '🍿 ' + p.title + (p.service ? ' on ' + p.service : ''));
  } catch (_) { return []; }
}

// Views / likes / clicks: counted in memory, written to app_settings once a minute (no write per event).
// A like counts once per device per post (device id from the browser; kept in memory, the browser remembers too).
const pending = new Map();
const liked = new Set();
function record(id, kind, device) {
  const k = safeId(id);
  if (!k || !KINDS.includes(kind)) return { ok: false };
  const dev = s(device).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const cur = pending.get(k) || { views: 0, likes: 0, clicks: 0, shares: 0 };
  if (kind === 'like' || kind === 'unlike') {
    if (!dev) return { ok: false };
    const lk = k + '|' + dev;
    if (kind === 'like') { if (liked.has(lk)) return { ok: true, dup: true }; if (liked.size > 100000) liked.clear(); liked.add(lk); cur.likes++; }
    else { if (!liked.has(lk)) return { ok: true, dup: true }; liked.delete(lk); cur.likes--; }
  } else if (kind === 'view') cur.views++;
  else if (kind === 'click') cur.clicks++;
  else cur.shares++;
  pending.set(k, cur);
  return { ok: true };
}
async function flushStats() {
  if (!pending.size) return;
  const batch = [...pending.entries()]; pending.clear();
  const st = parseJson(await readKey(STATS_KEY), {});
  const known = new Set((await list()).map((p) => p.id));
  for (const [id, c] of batch) {
    if (!known.has(id)) continue;
    const cur = st[id] || {};
    st[id] = { views: (cur.views || 0) + c.views, likes: Math.max(0, (cur.likes || 0) + c.likes), clicks: (cur.clicks || 0) + c.clicks, shares: (cur.shares || 0) + c.shares };
  }
  await writeKey(STATS_KEY, JSON.stringify(st));
}
async function stats() {
  const st = parseJson(await readKey(STATS_KEY), {});
  for (const [id, c] of pending) {
    const cur = st[id] || {};
    st[id] = { views: (cur.views || 0) + c.views, likes: Math.max(0, (cur.likes || 0) + c.likes), clicks: (cur.clicks || 0) + c.clicks, shares: (cur.shares || 0) + c.shares };
  }
  return st;
}

// ---- settings (TMDB automation) ----
const JOB_KEY = 'feed_job';
const DEFAULT_LANGS = ['hi', 'en', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu'];
// Anime platforms: the language filter would hide almost everything (Japanese), so it is not applied there.
const ANY_LANGUAGE = ['crunchyroll'];
const RUN_EVERY_MS = 6 * 3600e3;
const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return v === '' || v == null || !isFinite(n) ? dflt : Math.max(lo, Math.min(hi, n)); };

async function getSettings() {
  const x = parseJson(await readKey(SETTINGS_KEY), {});
  return {
    tmdbKey: s(x.tmdbKey),
    // ON by default once a key is saved; only an explicit false turns it off.
    autoPublish: x.autoPublish !== false,
    platforms: Array.isArray(x.platforms) ? x.platforms.map((p) => clean(p, 60)).filter(Boolean) : [],
    languages: Array.isArray(x.languages) && x.languages.length ? x.languages.filter((l) => LANGS[l]) : DEFAULT_LANGS.slice(),
    minPopularity: clampNum(x.minPopularity, 0, 10000, 5),
    minVotes: clampNum(x.minVotes, 0, 100000, 5),
    maxPerDay: Math.round(clampNum(x.maxPerDay, 0, 50, 5)),
    autoHideDays: Math.round(clampNum(x.autoHideDays, 0, 365, 30)),
    providerMap: x.providerMap && typeof x.providerMap === 'object' ? x.providerMap : {},
  };
}
/** What the admin page may see: never the key itself. */
function publicSettings(st) {
  return {
    hasKey: !!st.tmdbKey, keyType: st.tmdbKey ? (isV4(st.tmdbKey) ? 'read access token' : 'API key') : '',
    autoPublish: st.autoPublish, platforms: st.platforms, languages: st.languages, minPopularity: st.minPopularity, minVotes: st.minVotes,
    maxPerDay: st.maxPerDay, autoHideDays: st.autoHideDays, providerMap: Object.assign({}, DEFAULT_PROVIDERS, st.providerMap),
    defaultProviders: DEFAULT_PROVIDERS, languageNames: LANGS, defaultLanguages: DEFAULT_LANGS,
  };
}
async function saveSettings(input) {
  const i = input || {};
  const raw = parseJson(await readKey(SETTINGS_KEY), {});
  const cur = await getSettings();
  const next = Object.assign({}, raw);
  const changed = [];
  const set = (k, v, label) => { if (JSON.stringify(v) !== JSON.stringify(cur[k])) changed.push(label || k); next[k] = v; };
  if (i.clearKey === true) { if (cur.tmdbKey) changed.push('TMDB key removed'); next.tmdbKey = ''; }
  else if (s(i.tmdbKey)) {
    const k = s(i.tmdbKey);
    if (!/^[A-Za-z0-9._-]{20,600}$/.test(k)) return { ok: false, message: 'That does not look like a TMDB API key or read access token.' };
    if (k !== cur.tmdbKey) { changed.push('TMDB key saved'); next.tmdbKey = k; }
  }
  if (i.autoPublish != null) set('autoPublish', i.autoPublish === true || i.autoPublish === 'true', 'auto-publish ' + ((i.autoPublish === true || i.autoPublish === 'true') ? 'on' : 'off'));
  if (Array.isArray(i.platforms)) set('platforms', i.platforms.map((p) => clean(p, 60)).filter(Boolean).slice(0, 30), 'platforms');
  if (Array.isArray(i.languages)) { const l = i.languages.filter((x) => LANGS[x]); set('languages', l.length ? l : DEFAULT_LANGS.slice(), 'languages'); }
  if (i.minPopularity != null) set('minPopularity', clampNum(i.minPopularity, 0, 10000, 5), 'min popularity');
  if (i.minVotes != null) set('minVotes', Math.round(clampNum(i.minVotes, 0, 100000, 5)), 'min votes');
  if (i.maxPerDay != null) set('maxPerDay', Math.round(clampNum(i.maxPerDay, 0, 50, 5)), 'max per day');
  if (i.autoHideDays != null) set('autoHideDays', Math.round(clampNum(i.autoHideDays, 0, 365, 30)), 'auto-hide days');
  if (i.providerMap && typeof i.providerMap === 'object') {
    const pm = {};
    for (const [k, v] of Object.entries(i.providerMap)) {
      const key = s(k).toLowerCase().replace(/[^a-z0-9+ ]/g, '').slice(0, 30); const val = s(v).replace(/[^0-9|]/g, '').slice(0, 40);
      if (key && val) pm[key] = val;
    }
    if (JSON.stringify(pm) !== JSON.stringify(Object.assign({}, DEFAULT_PROVIDERS, cur.providerMap))) changed.push('provider ids');
    next.providerMap = pm;
  }
  await writeKey(SETTINGS_KEY, JSON.stringify(next));
  return { ok: true, changed, settings: publicSettings(await getSettings()) };
}

// ---- TMDB ----
let fetchImpl = (...a) => fetch(...a);
const isV4 = (k) => /^eyJ/.test(k) && k.length > 60;
async function tmdbGet(key, pathQ, params) {
  if (!key) { const e = new Error('Add your TMDB key in 🍿 What\'s new → Settings first.'); e.code = 'NOKEY'; throw e; }
  const u = new URL(TMDB_API + pathQ);
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) u.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  if (isV4(key)) headers.Authorization = 'Bearer ' + key; else u.searchParams.set('api_key', key);
  let r;
  try { r = await fetchImpl(u.toString(), { headers, signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined }); }
  catch (e) { throw new Error('Could not reach TMDB — try again later.'); }
  if (r.status === 401) throw new Error('TMDB did not accept the key — check it in Settings.');
  if (r.status === 429) throw new Error('TMDB is busy (too many requests) — try again in a minute.');
  if (!r.ok) throw new Error('TMDB error ' + r.status + '.');
  return r.json();
}
const genreCache = { at: 0, movie: {}, tv: {} };
async function genres(key) {
  if (Date.now() - genreCache.at < 24 * 3600e3 && Object.keys(genreCache.movie).length) return genreCache;
  try {
    const [m, t] = await Promise.all([tmdbGet(key, '/genre/movie/list', { language: 'en' }), tmdbGet(key, '/genre/tv/list', { language: 'en' })]);
    genreCache.movie = {}; genreCache.tv = {};
    (m.genres || []).forEach((g) => { genreCache.movie[g.id] = g.name; });
    (t.genres || []).forEach((g) => { genreCache.tv[g.id] = g.name; });
    genreCache.at = Date.now();
  } catch (_) { /* posts just get no genre tags */ }
  return genreCache;
}
/** TMDB movie / tv row → a post draft (not saved). */
function draftFrom(row, media, service, gmap) {
  const mt = media || row.media_type;
  const names = (row.genres || []).map((g) => g.name).concat((row.genre_ids || []).map((id) => (gmap && gmap[mt] && gmap[mt][id]) || '')).filter(Boolean);
  let trailer = '';
  const vids = (row.videos && row.videos.results) || [];
  const okKey = (v) => v.site === 'YouTube' && /^[A-Za-z0-9_-]{6,20}$/.test(v.key || '');
  const tv = vids.find((v) => okKey(v) && v.type === 'Trailer') || vids.find(okKey);
  if (tv) trailer = 'https://www.youtube.com/watch?v=' + tv.key;
  const date = s(mt === 'tv' ? (row.first_air_date || row.air_date) : row.release_date).slice(0, 10);
  return {
    type: mt === 'tv' ? 'series' : 'movie',
    title: clean(mt === 'tv' ? (row.name || row.original_name) : (row.title || row.original_title), 100),
    service: clean(service, 60),
    caption: cleanCaption(row.overview),
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    languages: row.original_language && LANGS[row.original_language] ? [LANGS[row.original_language]] : [],
    genres: cleanTags(names, 24).slice(0, 4),
    imageUrl: /^\/[A-Za-z0-9_.-]+$/.test(s(row.poster_path)) ? TMDB_IMG + row.poster_path : '',
    trailerUrl: trailer,
    cta: service ? 'service' : 'none',
    source: 'tmdb',
    tmdbKey: (mt === 'tv' ? 'tv:' : 'movie:') + Number(row.id),
    popularity: Number(row.popularity) || 0,
    votes: Number(row.vote_count) || 0,
  };
}
async function readJob() { const j = parseJson(await readKey(JOB_KEY), {}); j.seen = Array.isArray(j.seen) ? j.seen : []; return j; }
async function writeJob(j) { await writeKey(JOB_KEY, JSON.stringify(Object.assign({}, j, { seen: (j.seen || []).slice(-3000) }))); }
/** TMDB ids already in the feed or imported before (so a post the owner deleted does not come back). */
async function knownKeys() {
  const [items, job] = await Promise.all([list(), readJob()]);
  return new Set(items.map((p) => p.tmdbKey).filter(Boolean).concat(job.seen));
}

async function tmdbSearch(query) {
  const q = clean(query, 80);
  if (q.length < 2) return { ok: false, message: 'Type at least 2 letters.' };
  const st = await getSettings();
  const [r, g, have] = await Promise.all([tmdbGet(st.tmdbKey, '/search/multi', { query: q, include_adult: 'false', language: 'en-US', page: 1 }), genres(st.tmdbKey), knownKeys()]);
  const results = (r.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 12)
    .map((x) => { const d = draftFrom(x, x.media_type, '', g); return Object.assign(d, { posted: have.has(d.tmdbKey) }); });
  return { ok: true, results };
}
async function tmdbDetails(key, tmdbKey, service) {
  const m = s(tmdbKey).match(/^(movie|tv):(\d{1,9})$/);
  if (!m) return null;
  const row = await tmdbGet(key, '/' + m[1] + '/' + m[2], { language: 'en-US', append_to_response: 'videos' });
  return draftFrom(row, m[1], service, null);
}
/** Owner picked a title (search / suggestions): full details + trailer → saved post. publish=false = draft (OFF). */
async function tmdbCreate(tmdbKey, service, publish) {
  if (!/^(movie|tv):\d{1,9}$/.test(s(tmdbKey))) return { ok: false, message: 'Pick a title from the TMDB results.' };
  if ((await list()).some((p) => p.tmdbKey === tmdbKey)) return { ok: false, message: 'This title is already in the feed.' };
  if (!clean(service, 60)) return { ok: false, message: 'Pick the platform it streams on.' };
  const st = await getSettings();
  const d = await tmdbDetails(st.tmdbKey, tmdbKey, service);
  const r = await save(Object.assign(d, { active: publish === true, importedAt: true, hideAfter: st.autoHideDays ? new Date(Date.now() + st.autoHideDays * 86400e3).toISOString() : '' }));
  if (r.ok) { const job = await readJob(); if (!job.seen.includes(tmdbKey)) { job.seen.push(tmdbKey); await writeJob(job); } }
  return r;
}
function providersFor(service, map) {
  const n = s(service).toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k && n.includes(k)) return v;
  return '';
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const istDay = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 10);

/** Active catalog services (the platforms FluxFilm sells). */
async function catalogServices() {
  try {
    const rows = await db.query('SELECT service, is_active, raw_json FROM plans', []);
    const out = new Set();
    for (const r of rows) {
      let raw = {}; try { raw = typeof r.raw_json === 'object' && r.raw_json ? r.raw_json : JSON.parse(r.raw_json || '{}'); } catch (_) {}
      const act = r.is_active != null && r.is_active !== '' ? r.is_active : raw.IsActive;
      if (String(act).toUpperCase() === 'TRUE' || act === 1 || act === true) out.add(s(r.service || raw.Service));
    }
    return [...out].filter(Boolean).sort((a, b) => a.localeCompare(b));
  } catch (_) { return []; }
}

/**
 * Candidates from TMDB discover for the given platforms (drafts, nothing saved).
 * opts: { days, languages, minPopularity, minVotes }
 */
async function discover(st, services, opts) {
  const o = Object.assign({ days: 30, languages: st.languages, minPopularity: st.minPopularity, minVotes: st.minVotes }, opts || {});
  const map = Object.assign({}, DEFAULT_PROVIDERS, st.providerMap);
  const span = Math.max(3, Math.min(90, Math.round(Number(o.days) || 30)));
  const from = ymd(Date.now() - span * 86400e3); const to = ymd(Date.now() + 14 * 86400e3);
  const g = await genres(st.tmdbKey);
  const byKey = new Map(); const skipped = [];
  // One platform shares a title with another (e.g. Netflix + "Netflix (Group Offer)"): the first platform keeps it.
  const unique = []; const seenIds = new Set();
  for (const svc of (services || []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 15)) {
    const ids = providersFor(svc, map);
    if (!ids) { skipped.push(svc); continue; }
    if (seenIds.has(ids)) continue;
    seenIds.add(ids); unique.push([svc, ids]);
  }
  for (const [svc, ids] of unique) {
    const anyLang = ANY_LANGUAGE.some((k) => svc.toLowerCase().includes(k));
    const base = { watch_region: 'IN', with_watch_providers: ids, with_watch_monetization_types: 'flatrate', include_adult: 'false', language: 'en-US', sort_by: 'popularity.desc', page: 1, 'vote_count.gte': o.minVotes || '', with_original_language: anyLang ? '' : (o.languages || []).join('|') };
    const [mv, tv] = await Promise.all([
      tmdbGet(st.tmdbKey, '/discover/movie', Object.assign({ 'primary_release_date.gte': from, 'primary_release_date.lte': to }, base)),
      tmdbGet(st.tmdbKey, '/discover/tv', Object.assign({ 'air_date.gte': from, 'air_date.lte': to }, base)),
    ]);
    const rows = (mv.results || []).slice(0, 10).map((x) => draftFrom(x, 'movie', svc, g)).concat((tv.results || []).slice(0, 10).map((x) => draftFrom(x, 'tv', svc, g)));
    for (const d of rows) {
      if (!d.title || byKey.has(d.tmdbKey)) continue;
      if (d.popularity < (o.minPopularity || 0) || d.votes < (o.minVotes || 0)) continue;
      byKey.set(d.tmdbKey, d);
    }
  }
  const drafts = [...byKey.values()].sort((a, b) => b.popularity - a.popularity);
  return { drafts, skipped, from, to };
}
/** Admin "✨ Suggest": candidates marked posted / new. */
async function tmdbSuggest(services, days) {
  const st = await getSettings();
  if (!st.tmdbKey) return { ok: false, message: 'Add your TMDB key in Settings first.' };
  const r = await discover(st, services && services.length ? services : await jobPlatforms(st), { days });
  const have = await knownKeys();
  r.drafts.forEach((d) => { d.posted = have.has(d.tmdbKey); });
  r.drafts.sort((a, b) => (a.posted ? 1 : 0) - (b.posted ? 1 : 0));
  return { ok: true, drafts: r.drafts.slice(0, 40), skipped: r.skipped, from: r.from, to: r.to };
}
async function tmdbProviders() {
  const st = await getSettings();
  const r = await tmdbGet(st.tmdbKey, '/watch/providers/movie', { watch_region: 'IN', language: 'en-US' });
  return { ok: true, providers: (r.results || []).map((p) => ({ id: p.provider_id, name: clean(p.provider_name, 60) })).filter((p) => p.id).slice(0, 200) };
}
async function jobPlatforms(st) {
  const services = await catalogServices();
  return st.platforms && st.platforms.length ? services.filter((x) => st.platforms.includes(x)) : services;
}

/**
 * The import job. force=true ("Run now") skips the 6-hour wait but still respects the daily cap.
 * Never throws: problems are stored as lastError for the admin page.
 */
let running = false; let nextRunAt = 0;
async function runImport(opts) {
  const o = opts || {};
  const now = Date.now();
  if (running) return { ok: false, message: 'The import is already running.' };
  running = true;
  const result = { imported: 0, published: 0, drafts: 0, refreshed: 0, skipped: 0 };
  let job = {};
  try {
    job = await readJob();
    const st = await getSettings();
    if (!st.tmdbKey) { running = false; return { ok: true, skipped: 'no-key', result }; }
    if (!o.force && job.lastRun && now - Date.parse(job.lastRun) < RUN_EVERY_MS - 60e3) { running = false; return { ok: true, skipped: 'not-due', result }; }
    const today = istDay(now);
    if (job.day !== today) { job.day = today; job.dayCount = 0; }
    job.lastRun = new Date(now).toISOString();
    job.nextRun = new Date(now + RUN_EVERY_MS).toISOString();
    const platforms = await jobPlatforms(st);
    const found = await discover(st, platforms, { days: 30 });
    const items = await list();
    const byKey = new Map(items.filter((p) => p.tmdbKey).map((p) => [p.tmdbKey, p]));
    const seen = new Set(job.seen);
    // 1) Already in the feed: refresh poster / story / genres of posts the owner never edited.
    let dirty = false;
    for (const d of found.drafts) {
      const p = byKey.get(d.tmdbKey);
      if (!p) continue;
      result.skipped++;
      if (p.edited || p.source !== 'tmdb') continue;
      const patch = {};
      for (const k of ['imageUrl', 'caption', 'genres', 'releaseDate']) if (d[k] && JSON.stringify(d[k]) !== JSON.stringify(p[k])) patch[k] = d[k];
      if (Object.keys(patch).length) { Object.assign(p, patch, { updatedAt: new Date(now).toISOString() }); dirty = true; result.refreshed++; }
    }
    if (dirty) await saveAll(items);
    // 2) New titles, most popular first, up to today's cap.
    const fresh = found.drafts.filter((d) => !byKey.has(d.tmdbKey) && !seen.has(d.tmdbKey));
    result.skipped = found.drafts.length - fresh.length;
    for (const d of fresh) {
      if (job.dayCount >= st.maxPerDay) { result.skipped++; continue; }
      if (!d.imageUrl) { result.skipped++; continue; }
      let full = d;
      try { const det = await tmdbDetails(st.tmdbKey, d.tmdbKey, d.service); if (det && det.title) full = Object.assign({}, d, det, { imageUrl: det.imageUrl || d.imageUrl, genres: det.genres.length ? det.genres : d.genres }); } catch (_) { /* discover row is enough */ }
      const r = await save(Object.assign({}, full, {
        active: st.autoPublish, pinned: false, importedAt: true,
        hideAfter: st.autoHideDays ? new Date(now + st.autoHideDays * 86400e3).toISOString() : '',
      }));
      if (!r.ok) { result.skipped++; continue; }
      seen.add(d.tmdbKey); job.seen.push(d.tmdbKey);
      job.dayCount++; result.imported++;
      if (r.post.active) result.published++; else result.drafts++;
    }
    job.lastResult = result; job.lastError = '';
    if (found.skipped.length) job.lastNote = 'No TMDB provider id for: ' + found.skipped.join(', '); else job.lastNote = '';
    await writeJob(job);
    const audit = o.audit;
    if (audit && result.imported) audit.record(o.req || null, { action: 'feed.import', entity: 'feed', summary: 'TMDB import: ' + result.published + ' published, ' + result.drafts + ' drafts (' + (o.force ? 'run now' : 'scheduled') + ')' });
    return { ok: true, result, job: jobPublic(job) };
  } catch (e) {
    job.lastError = String((e && e.message) || e).slice(0, 300);
    job.lastResult = result;
    try { await writeJob(job); } catch (_) {}
    console.log('[feed] import failed:', job.lastError);
    return { ok: false, message: job.lastError, result, job: jobPublic(job) };
  } finally { running = false; nextRunAt = Date.now() + RUN_EVERY_MS; }
}
function jobPublic(j) {
  return { lastRun: j.lastRun || '', nextRun: timer ? new Date(nextRunAt || Date.now() + 90e3).toISOString() : (j.nextRun || ''), lastResult: j.lastResult || null, lastError: j.lastError || '', lastNote: j.lastNote || '', today: j.day === istDay() ? (j.dayCount || 0) : 0, running };
}
async function jobStatus() { return jobPublic(await readJob()); }

let timer = null;
/** Stats flush every minute; TMDB import 90 s after start, then every 6 hours (does nothing without a key). */
function startTimer(deps) {
  if (timer) return;
  timer = setInterval(() => flushStats().catch((e) => console.log('[feed] stats flush failed:', e.message)), 60e3);
  if (timer.unref) timer.unref();
  const tick = () => runImport({ audit: deps && deps.audit }).catch(() => {});
  nextRunAt = Date.now() + 90e3;
  const first = setTimeout(tick, 90e3); if (first.unref) first.unref();
  const every = setInterval(tick, RUN_EVERY_MS); if (every.unref) every.unref();
}

module.exports = {
  TYPES, CTAS, IMG_HOSTS, TRAILER_HOSTS, DEFAULT_PROVIDERS, DEFAULT_LANGS, MAX_POSTS,
  validate, list, save, remove, setImage, image, statusOf, sortPosts, publicList, trendingLines, record, flushStats, stats,
  getSettings, publicSettings, saveSettings, tmdbSearch, tmdbCreate, tmdbSuggest, tmdbProviders, providersFor, draftFrom, catalogServices,
  discover, runImport, jobStatus, startTimer, toIso,
  _internal: { pending, liked, genreCache, setFetch: (f) => { fetchImpl = f; }, reset: () => { cache = null; pending.clear(); liked.clear(); genreCache.at = 0; running = false; } },
};
