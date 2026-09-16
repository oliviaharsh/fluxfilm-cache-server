/**
 * FluxFilm - 🍿 "What's new" feed: Instagram-style posts about new movies and shows (admin → 🍿 Feed).
 * No schema change. app_settings keys:
 *   feed_posts        JSON list of posts (max 200)
 *   feed_img_<id>     uploaded picture (data URL, shrunk in the admin page first)
 *   feed_img_<id>t    📸 Instagram thumbnail fetched by the server (feedthumb.js) — served at /feed-img/<id>t, so customers
 *                     never load anything from Instagram before they tap play
 *   feed_stats        { <id>: { views, likes, clicks, shares, plays } }  (plays = video / trailer taps; buffered in memory, written once a minute)
 *   feed_settings     { tmdbKey, metaToken, autoPublish, platforms, languages, minPopularity, minVotes, maxPerDay,
 *                       autoHideDays, providerMap }  — tmdbKey / metaToken never leave the server
 *
 * Post fields (v3): brand = what the header shows ("Netflix", with the catalog's Netflix logo) · ctaService = the catalog
 * service the "Get … from ₹X" button sells ("Netflix (Group Offer)"). `service` is kept equal to ctaService for older code.
 * Older posts get brand = normalised service, ctaService = service when read (list()). sourceCaption = the Reel's own
 * caption (for ✨ AI fill; never sent to customers).
 *   feed_job          last import run: { lastRun, nextRun, lastResult, lastError, day, dayCount, seen[] }
 *
 * Post status: OFF (switched off / draft) · SCHEDULED (before "publish at") · HIDDEN (after "hide after") · LIVE.
 * Customers see LIVE posts only: pinned first, then newest.
 *
 * TMDB automation (themoviedb.org, free key). Once the owner saves a key, the import job runs 90 s after start
 * and every 6 hours: TMDB discover (watch_region=IN, flatrate) for each platform FluxFilm sells (active catalog
 * services → TMDB provider ids), filtered by language, popularity and vote count. Only truly NEW or UPCOMING titles:
 *   movies  released in the last N days (releasedDays, default 45) or coming in the next M days (upcomingDays, 30);
 *           the India release date is used when TMDB has one (release_dates, IN).
 *   series  (seriesNewOnly, ON by default) a brand-new show (first_air_date in the window) or a NEW SEASON whose
 *           premiere is in the window (tv details: seasons[].air_date, last/next_episode_to_air with episode 1) →
 *           seasonLabel "Season N". Weekly episodes of an old season never qualify (TMDB's air_date filter alone
 *           matched any episode, which is how Deadliest Catch (2005) got in).
 *   Upcoming posts show "🗓️ Coming DD Mon" and flip to "Released DD Mon" / "🆕 Season N · DD Mon" by themselves after the date.
 *   Talk / news / reality / soap shows (weekly or daily, e.g. WWE Raw) are left out (skipWeeklyShows, ON by default).
 * 📅 Automatic dates: refreshDates() (every import run for posts not checked in 20 h, and the admin "🔄 Refresh dates &
 *   seasons" button) re-reads TMDB for imported posts: series → new season premiere + "Season N" / brand-new show's first
 *   air date (no longer new → date left, the 🧹 cleanup lists it); movies → India release date when TMDB has one. Posts
 *   the owner edited only get EMPTY date / season filled. autoDate() fills an empty date on manual posts by title
 *   (+ "(2008)" year, type, brand's provider in India); unsure → nothing filled, "Couldn't find the date — type it".
 * 🧹 notNewCandidates() / hideNotNew(): admin tool listing LIVE imported posts that fail these rules (hide, never delete). Deduped by TMDB type+id (also posts the owner deleted are not re-imported),
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
const FORMATS = ['post', 'reel'];
const VIDEO_ID = /^fv[0-9a-f]{16}$/;
let videoRef = null;
const video = () => videoRef || (videoRef = require('./feedvideo'));
const KINDS = ['view', 'like', 'unlike', 'click', 'share', 'play'];
const IMG_MAX = 450000; // ~330 KB picture; the admin page shrinks uploads first
const THUMB_GOOD = 120 * 1024; // an Instagram thumbnail above this is shrunk by the admin page after saving
const IMG_HOSTS = ['image.tmdb.org', 'i.ytimg.com', 'img.youtube.com'];
const TRAILER_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];
const TMDB_API = 'https://api.themoviedb.org/3';
// TMDB's official second address — used when the first is blocked or down.
const TMDB_API_ALT = 'https://api.tmdb.org/3';
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
/**
 * 🏷️ Brands: the real platform a title streams on. The catalog can sell several plans of one brand
 * ("Netflix", "Netflix (Group Offer)"; "Prime Video", "Prime Video + Shopping").
 */
const BRANDS = [
  { name: 'Netflix', re: /netflix/i, emoji: '🔴' },
  { name: 'Prime Video', re: /prime|amazon/i, emoji: '📦' },
  { name: 'JioHotstar', re: /hotstar|jio ?cinema/i, emoji: '⭐' },
  { name: 'SonyLIV', re: /sony/i, emoji: '🔵' },
  { name: 'Zee5', re: /zee ?5|\bzee\b/i, emoji: '🟣' },
  { name: 'Crunchyroll', re: /crunchyroll/i, emoji: '🎌' },
  { name: 'YouTube', re: /youtube/i, emoji: '▶️' },
  { name: 'Apple TV+', re: /apple/i, emoji: '🍎' },
];
/** "Netflix (Group Offer)" → "Netflix", "Prime Video + Shopping" → "Prime Video", "SonyLiv Premium" → "SonyLIV", "MX Player Gold" → "MX Player Gold". */
function brandOf(v) {
  const t = clean(v, 60);
  if (!t) return '';
  const b = BRANDS.find((x) => x.re.test(t));
  if (b) return b.name;
  const stripped = clean(t.replace(/\([^)]*\)/g, ' ').replace(/\+\s*[A-Za-z]+/g, ' ').replace(/\b(premium|sharing|private|group offer|plans?|subscription)\b/gi, ' '), 40);
  return stripped || t.slice(0, 40);
}
/** The plan a brand's button sells by default: the shortest catalog service of that brand ("Netflix" before "Netflix (Group Offer)"). */
function mainServiceFor(brand, services) {
  const list = (services || []).map((x) => clean(x, 60)).filter((x) => x && brandOf(x) === brand);
  return list.sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || '';
}
function cleanSource(v) {
  return s(v).replace(/\r\n?/g, '\n').replace(/[<>]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2200);
}
/** Older posts (before brand / ctaService) read as if they had them. */
function migrate(p) {
  if (!p || typeof p !== 'object') return p;
  if (p.ctaService == null || p.ctaService === '') p.ctaService = s(p.service);
  if (p.brand == null || p.brand === '') p.brand = brandOf(p.ctaService || p.service);
  if (p.service !== p.ctaService && p.ctaService) p.service = p.ctaService;
  return p;
}

function hostOk(url, hosts) {
  try { const u = new URL(url); return u.protocol === 'https:' && hosts.includes(u.hostname.toLowerCase()) && !/[\s"'<>]/.test(url); } catch (_) { return false; }
}

/**
 * 📸 Instagram Reel / post link → the one normalised permalink the storefront embeds (Instagram's official embed;
 * the video stays on Instagram). Strict: https, instagram.com / www.instagram.com only, /reel/ /reels/ /p/ /tv/ + a
 * shortcode (the web "/<username>/reel/<code>/" form too); query (?igsh= tracking), hash, user info and ports are refused or dropped. '' = empty, null = not valid.
 */
const IG_HOSTS = ['www.instagram.com', 'instagram.com'];
function instagramUrl(v) {
  const t = s(v);
  if (!t) return '';
  if (t.length > 300 || /[\s"'<>\\`]/.test(t)) return null;
  let u; try { u = new URL(t); } catch (_) { return null; }
  if (u.protocol !== 'https:' || !IG_HOSTS.includes(u.hostname) || u.username || u.password || u.port) return null;
  const m = u.pathname.match(/^\/(?:[A-Za-z0-9._]{1,30}\/)?(reels?|p|tv)\/([A-Za-z0-9_-]{5,40})\/?$/);
  if (!m) return null;
  return 'https://www.instagram.com/' + (m[1] === 'p' || m[1] === 'tv' ? 'p' : 'reel') + '/' + m[2] + '/';
}
/** YouTube video id (11 chars) from watch?v= · youtu.be/ · /shorts/ · /embed/ links on the allowed trailer hosts; '' otherwise. */
function youtubeId(v) {
  let u; try { u = new URL(s(v)); } catch (_) { return ''; }
  if (u.protocol !== 'https:' || !TRAILER_HOSTS.includes(u.hostname) || u.username || u.password || u.port) return '';
  const ID = /^[A-Za-z0-9_-]{11}$/;
  let id = '';
  if (u.hostname === 'youtu.be') id = u.pathname.split('/')[1] || '';
  else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
  else { const m = u.pathname.match(/^\/(?:shorts|embed)\/([^/]+)\/?$/); id = m ? m[1] : ''; }
  return ID.test(id) ? id : '';
}

function validate(input, existing) {
  const i = input || {}; const errors = [];
  const out = Object.assign({}, existing || {});
  const now = new Date().toISOString();
  out.id = (existing && existing.id) || ('fp' + crypto.randomBytes(5).toString('hex'));
  out.type = TYPES.includes(i.type) ? i.type : 'movie';
  out.title = clean(i.title, 100);
  if (!out.title) errors.push('Write a title.');
  // ctaService = the plan the button sells; brand = the platform shown. Old clients send only `service`.
  out.ctaService = clean(s(i.ctaService) ? i.ctaService : i.service, 60);
  out.service = out.ctaService;
  const known = BRANDS.find((b) => b.name.toLowerCase() === clean(i.brand, 40).toLowerCase());
  out.brand = known ? known.name : (clean(i.brand, 40) || brandOf(out.ctaService));
  if (out.type !== 'announcement' && !out.brand) errors.push('Pick the platform (e.g. Netflix).');
  out.caption = cleanCaption(i.caption);
  out.sourceCaption = i.sourceCaption !== undefined ? cleanSource(i.sourceCaption) : s(existing && existing.sourceCaption);
  const rd = s(i.releaseDate).slice(0, 10);
  if (rd && !/^\d{4}-\d{2}-\d{2}$/.test(rd)) errors.push('Release date is not valid.');
  out.releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(rd) ? rd : '';
  out.languages = cleanTags(i.languages, 20);
  out.genres = cleanTags(i.genres, 24);
  out.imageUrl = s(i.imageUrl).slice(0, 300);
  if (out.imageUrl && !hostOk(out.imageUrl, IMG_HOSTS)) errors.push('Picture link must be https:// from ' + IMG_HOSTS.join(', ') + ' — or upload a picture.');
  out.trailerUrl = s(i.trailerUrl).slice(0, 300);
  if (out.trailerUrl && !hostOk(out.trailerUrl, TRAILER_HOSTS)) errors.push('Trailer must be an https:// YouTube link.');
  const ig = instagramUrl(i.instagramUrl);
  if (ig === null) errors.push('Instagram link must be a public Reel or post link, like https://www.instagram.com/reel/ABC123xyz/');
  out.instagramUrl = ig || '';
  // 🎬 Post type: 'post' (the feed) or 'reel' (full-screen in the Reels tab; also in the feed when reelInFeed).
  // A reel's video = an uploaded MP4 / WebM (videoId, checked in save()) › a YouTube Shorts / trailer link › an Instagram Reel link.
  out.format = FORMATS.includes(i.format) ? i.format : (existing && existing.format === 'reel' ? 'reel' : 'post');
  const inFeed = i.reelInFeed !== undefined ? i.reelInFeed : existing ? existing.reelInFeed : true;
  out.reelInFeed = out.format === 'reel' ? !(inFeed === false || inFeed === 'false' || inFeed === 0) : true;
  const vid = s(i.videoId !== undefined ? i.videoId : existing && existing.videoId);
  if (vid && !VIDEO_ID.test(vid)) errors.push('Video is not valid — upload it again.');
  out.videoId = VIDEO_ID.test(vid) ? vid : '';
  out.videoType = out.videoId && existing && existing.videoId === out.videoId ? s(existing.videoType) : '';
  if (out.format === 'reel' && !out.videoId && !youtubeId(out.trailerUrl) && !out.instagramUrl) errors.push('A Reel needs a video: upload one, or paste a YouTube Shorts link or an Instagram Reel link.');
  out.cta = CTAS.includes(i.cta) ? i.cta : (out.service ? 'service' : 'none');
  if (!out.service) out.cta = 'none';
  // 🆕 "Season 3" on a new-season post (set by the import; kept on later saves that do not send it).
  const sl = s(i.seasonLabel !== undefined ? i.seasonLabel : existing && existing.seasonLabel);
  out.seasonLabel = out.type === 'series' && /^Season \d{1,3}$/.test(sl) ? sl : '';
  // 'IN' = releaseDate is TMDB's India release date (the import then never swaps it back to the worldwide date).
  const rr = i.releaseRegion !== undefined ? i.releaseRegion : existing && existing.releaseRegion;
  out.releaseRegion = out.type === 'movie' && rr === 'IN' ? 'IN' : '';
  // 📅 dateAuto = the release date was found automatically (admin shows "auto"); cleared when the owner types another date.
  const da = i.dateAuto !== undefined ? (i.dateAuto === true || i.dateAuto === 'true') : !!(existing && existing.dateAuto && existing.releaseDate === out.releaseDate);
  out.dateAuto = !!(da && out.releaseDate);
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
  // A new / changed Reel link: the old thumbnail belongs to another video (save() deletes it).
  out.hasThumb = !!(existing && existing.hasThumb && existing.instagramUrl === out.instagramUrl);
  out.thumbAt = out.hasThumb ? s(existing.thumbAt) : '';
  if (existing && existing.instagramUrl !== out.instagramUrl) out.sourceCaption = '';
  out.importedAt = existing ? (existing.importedAt || '') : (out.source === 'tmdb' && i.importedAt === true ? now : '');
  // Dates worked out at import are fresh: refreshDates() skips the post for 20 h.
  out.datesAt = existing ? s(existing.datesAt) : (out.importedAt ? now : '');
  // An imported post whose words / picture / dates the owner changed is never touched by the import job again.
  const CONTENT = ['type', 'title', 'service', 'brand', 'ctaService', 'caption', 'releaseDate', 'imageUrl', 'trailerUrl', 'instagramUrl', 'cta', 'languages', 'genres'];
  out.edited = !!(existing && (existing.edited || (existing.source === 'tmdb' && CONTENT.some((k) => JSON.stringify(existing[k] == null ? '' : existing[k]) !== JSON.stringify(out[k])))));
  out.createdAt = (existing && existing.createdAt) || now;
  out.updatedAt = now;
  return { ok: !errors.length, post: out, errors };
}

async function list() { const x = parseJson(await readKey(KEY), []); return Array.isArray(x) ? x.map(migrate) : []; }
async function saveAll(items) { await writeKey(KEY, JSON.stringify(items)); cache = null; }

async function save(input) {
  const items = await list();
  const idx = input && input.id ? items.findIndex((p) => p.id === input.id) : -1;
  if (input && input.id && idx < 0) return { ok: false, message: 'Post not found.' };
  const v = validate(input, idx >= 0 ? items[idx] : null);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  if (idx < 0 && items.length >= MAX_POSTS) return { ok: false, message: 'Too many posts — delete old ones first (max ' + MAX_POSTS + ').' };
  // 🎬 A newly linked video must be a finished upload; the video it replaces is deleted after saving.
  const oldVideo = idx >= 0 ? s(items[idx].videoId) : '';
  if (v.post.videoId && v.post.videoId !== oldVideo) {
    let m = null; try { m = await video().info(v.post.videoId); } catch (_) { m = null; }
    if (!m || m.status !== 'ready') return { ok: false, message: 'The video upload is not finished — upload it again.', errors: ['video'] };
    v.post.videoType = m.mime;
  }
  const igChanged = idx >= 0 ? items[idx].instagramUrl !== v.post.instagramUrl : !!v.post.instagramUrl;
  if (idx >= 0 && items[idx].hasThumb && !v.post.hasThumb) { try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [IMG_PREFIX + v.post.id + 't']); } catch (_) {} }
  if (idx >= 0) items[idx] = v.post; else items.unshift(v.post);
  await saveAll(items);
  if (oldVideo && oldVideo !== v.post.videoId) { try { await video().remove(oldVideo); } catch (_) {} }
  return { ok: true, post: v.post, created: idx < 0, igChanged };
}
async function remove(id) {
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Post not found.' };
  await saveAll(items.filter((x) => x.id !== id));
  try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [IMG_PREFIX + id]); } catch (_) {}
  try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [IMG_PREFIX + id + 't']); } catch (_) {}
  if (p.videoId) { try { await video().remove(p.videoId); } catch (_) {} }
  return { ok: true, post: p };
}
/**
 * 🧽 Erase the VIDEO of a post but keep the post (feederase.js "Erase video only"). The words, picture and links stay,
 * so the page still works — a Reel left with no video at all goes back to being a normal post instead of a blank screen.
 * Deliberately not save(): save() would refuse a Reel with no video source.
 */
async function dropVideo(id) {
  const items = await list();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, message: 'Post not found.' };
  const vid = s(items[i].videoId);
  const p = Object.assign({}, items[i], { videoId: '', videoType: '', updatedAt: new Date().toISOString() });
  if (p.format === 'reel' && !youtubeId(p.trailerUrl) && !p.instagramUrl) { p.format = 'post'; p.reelInFeed = true; }
  items[i] = p;
  await saveAll(items);
  let freed = null;
  if (vid) { try { freed = await video().remove(vid); } catch (e) { freed = { ok: false, message: s(e && e.message) }; } }
  return { ok: true, post: p, videoId: vid, freed };
}
/** kind '' = the owner's uploaded picture (feed_img_<id>), 't' = the Instagram thumbnail (feed_img_<id>t). */
async function storePicture(id, dataUrl, kind) {
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Save the post first, then add a picture.' };
  const v = s(dataUrl);
  if (v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { ok: false, message: 'Please upload a PNG, JPG or WebP picture.' };
  if (v.length > IMG_MAX) return { ok: false, message: 'That picture is too big — please use a smaller one.' };
  const key = IMG_PREFIX + id + (kind === 't' ? 't' : '');
  try {
    if (v) await writeKey(key, v); else await db.query('DELETE FROM app_settings WHERE setting_key = ?', [key]);
  } catch (e) {
    if (/Data too long/i.test(String(e.message))) return { ok: false, message: 'Run db/schema-v17.sql first (it makes room for pictures).' };
    throw e;
  }
  const now = new Date().toISOString();
  if (kind === 't') { p.hasThumb = !!v; p.thumbAt = v ? now : ''; } else p.hasImage = !!v;
  p.updatedAt = now;
  await saveAll(items);
  return { ok: true, hasImage: !!p.hasImage, hasThumb: !!p.hasThumb, post: p };
}
const setImage = (id, dataUrl) => storePicture(id, dataUrl, '');
const setThumb = (id, dataUrl) => storePicture(id, dataUrl, 't');
async function image(id) {
  const v = s(await readKey(IMG_PREFIX + safeId(id)));
  const m = v.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  return m ? { type: m[1], buf: Buffer.from(m[2], 'base64') } : null;
}

// Posters are served through the shop (/poster/<size>/<file>; old /tmdb-img/t/p/… links still work): customers on Indian networks that block
// image.tmdb.org still see them. Only real TMDB poster files and sizes are allowed (not an open proxy).
const POSTER_SIZES = ['w185', 'w342', 'w500', 'w780'];
function posterPath(url) {
  const m = s(url).match(/^https:\/\/image\.tmdb\.org\/t\/p\/(w\d+)\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/);
  return m ? '/poster/' + m[1] + '/' + m[2] : s(url);
}
const posterCache = new Map(); // key → { type, buf } ; newest last, max 120 files
async function posterImage(size, file) {
  if (!POSTER_SIZES.includes(size) || !/^[A-Za-z0-9_-]{5,60}\.(jpg|jpeg|png|webp)$/.test(s(file))) return null;
  const k = size + '/' + file;
  if (posterCache.has(k)) { const v = posterCache.get(k); posterCache.delete(k); posterCache.set(k, v); return v; }
  const r = await require('./tmdbnet').getBuffer('https://image.tmdb.org/t/p/' + k, { timeoutMs: 10000, maxBytes: 2 * 1024 * 1024 });
  const type = s(r.headers && r.headers['content-type']).split(';')[0];
  if (r.status !== 200 || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
  const v = { type, buf: r.body };
  posterCache.set(k, v);
  while (posterCache.size > 120) posterCache.delete(posterCache.keys().next().value);
  return v;
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
/** Picture order: 📸 fetched Instagram thumbnail (Reel posts) → the owner's uploaded picture → poster link → none (gradient). */
function pictureOf(p, ig) {
  if (p.hasThumb && ig) return '/feed-img/' + p.id + 't?v=' + encodeURIComponent(p.thumbAt || p.updatedAt || '');
  if (p.hasImage) return '/feed-img/' + p.id + '?v=' + encodeURIComponent(p.updatedAt || '');
  return posterPath(p.imageUrl);
}
/** ❤️ Unique account likes per post (feedmarks.js) once schema-v25 exists; null = use the old feed_stats counter. */
async function accountLikes() {
  try { return await require('./feedmarks').likeCounts(); } catch (_) { return null; }
}
async function commentCounts() {
  try { return await require('./feedcomments').counts(); } catch (_) { return {}; }
}
let cache = null; let cacheAt = 0;
async function publicList(now) {
  if (!now && cache && Date.now() - cacheAt < 30e3) return cache;
  const [items, st, cc, al] = await Promise.all([list(), stats().catch(() => ({})), commentCounts(), accountLikes()]);
  const live = sortPosts(items.filter((p) => statusOf(p, now) === 'LIVE')).slice(0, 60);
  // 🪣 Where each uploaded video plays from: the public Cloudflare R2 link when the owner set one (fastest, no egress
  // cost), otherwise our own /v/<id>.mp4. Anything that goes wrong falls back to /v/<id>.mp4, which always works.
  let vurl = {};
  try { vurl = await video().urls(live.map((p) => p.videoId).filter(Boolean)); } catch (_) { vurl = {}; }
  const out = {
    ok: true,
    posts: live.map((p) => {
      const ig = instagramUrl(p.instagramUrl) || '';
      return {
        id: p.id, type: p.type, title: p.title, brand: p.brand || brandOf(p.service), ctaService: p.ctaService || p.service, service: p.ctaService || p.service,
        caption: p.caption, releaseDate: p.releaseDate, seasonLabel: p.type === 'series' ? (p.seasonLabel || '') : '',
        languages: p.languages || [], genres: p.genres || [], trailerUrl: p.trailerUrl, instagramUrl: ig, cta: p.cta, pinned: !!p.pinned,
        date: sortDate(p), likes: al ? Math.max(0, al[p.id] || 0) : (st[p.id] || {}).likes || 0, comments: cc[p.id] || 0,
        // 🎬 format 'reel' → Reels tab (+ the feed only when inFeed); video = our own uploaded file (feedvideo.js).
        format: p.format === 'reel' ? 'reel' : 'post', inFeed: p.format !== 'reel' || p.reelInFeed !== false,
        video: VIDEO_ID.test(s(p.videoId)) ? ((vurl[p.videoId] && vurl[p.videoId].url) || '/v/' + p.videoId + (p.videoType === 'video/webm' ? '.webm' : '.mp4')) : '', videoType: VIDEO_ID.test(s(p.videoId)) ? s(p.videoType) : '',
        image: pictureOf(p, ig),
      };
    }),
  };
  if (!now) { cache = out; cacheAt = Date.now(); }
  return out;
}
/** Ticker fallback when trending_items is empty: the newest live post titles. */
async function trendingLines() {
  try {
    const r = await publicList();
    return r.posts.slice(0, 8).map((p) => '🍿 ' + p.title + (p.brand || p.service ? ' on ' + (p.brand || p.service) : ''));
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
  const cur = pending.get(k) || { views: 0, likes: 0, clicks: 0, shares: 0, plays: 0 };
  if (kind === 'like' || kind === 'unlike') {
    if (!dev) return { ok: false };
    const lk = k + '|' + dev;
    if (kind === 'like') { if (liked.has(lk)) return { ok: true, dup: true }; if (liked.size > 100000) liked.clear(); liked.add(lk); cur.likes++; }
    else { if (!liked.has(lk)) return { ok: true, dup: true }; liked.delete(lk); cur.likes--; }
  } else if (kind === 'view') cur.views++;
  else if (kind === 'click') cur.clicks++;
  else if (kind === 'play') cur.plays = (cur.plays || 0) + 1;
  else cur.shares++;
  pending.set(k, cur);
  return { ok: true };
}
/** ❤️ Account likes (feedmarks.js): +1 / -1 only when the customer's feed_likes row really changed (no device id needed). */
function countLike(id, delta) {
  const k = safeId(id);
  const d = Number(delta) > 0 ? 1 : Number(delta) < 0 ? -1 : 0;
  if (!k || !d) return { ok: false };
  const cur = pending.get(k) || { views: 0, likes: 0, clicks: 0, shares: 0, plays: 0 };
  cur.likes += d;
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
    st[id] = { views: (cur.views || 0) + c.views, likes: Math.max(0, (cur.likes || 0) + c.likes), clicks: (cur.clicks || 0) + c.clicks, shares: (cur.shares || 0) + c.shares, plays: (cur.plays || 0) + (c.plays || 0) };
  }
  await writeKey(STATS_KEY, JSON.stringify(st));
}
async function stats() {
  const st = parseJson(await readKey(STATS_KEY), {});
  for (const [id, c] of pending) {
    const cur = st[id] || {};
    st[id] = { views: (cur.views || 0) + c.views, likes: Math.max(0, (cur.likes || 0) + c.likes), clicks: (cur.clicks || 0) + c.clicks, shares: (cur.shares || 0) + c.shares, plays: (cur.plays || 0) + (c.plays || 0) };
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
    // Optional Meta app token ("appid|secret" or a long-lived token) for Instagram's official oEmbed thumbnails.
    metaToken: s(x.metaToken),
    // ✨ Optional Google AI Studio key: AI fill uses Gemini (with Google Search for very new titles) when set, else DeepSeek.
    geminiKey: s(x.geminiKey),
    // ON by default once a key is saved; only an explicit false turns it off.
    autoPublish: x.autoPublish !== false,
    platforms: Array.isArray(x.platforms) ? x.platforms.map((p) => clean(p, 60)).filter(Boolean) : [],
    languages: Array.isArray(x.languages) && x.languages.length ? x.languages.filter((l) => LANGS[l]) : DEFAULT_LANGS.slice(),
    minPopularity: clampNum(x.minPopularity, 0, 10000, 5),
    minVotes: clampNum(x.minVotes, 0, 100000, 5),
    maxPerDay: Math.round(clampNum(x.maxPerDay, 0, 50, 5)),
    autoHideDays: Math.round(clampNum(x.autoHideDays, 0, 365, 30)),
    // Only new / upcoming titles: movies released in the last N days or coming in the next M days; series only when
    // the show is brand new or a new season premiered / premieres in that window.
    releasedDays: Math.round(clampNum(x.releasedDays, 1, 90, 45)),
    upcomingDays: Math.round(clampNum(x.upcomingDays, 0, 90, 30)),
    seriesNewOnly: x.seriesNewOnly !== false,
    // Talk / news / reality / soap shows (weekly or daily episodes all year, e.g. WWE Raw) are never "new": left out.
    skipWeeklyShows: x.skipWeeklyShows !== false,
    providerMap: x.providerMap && typeof x.providerMap === 'object' ? x.providerMap : {},
  };
}
/** What the admin page may see: never the key itself. */
function publicSettings(st) {
  return {
    hasKey: !!st.tmdbKey, keyType: st.tmdbKey ? (isV4(st.tmdbKey) ? 'read access token' : 'API key') : '',
    hasMetaToken: !!st.metaToken, aiKeySet: !!process.env.DEEPSEEK_API_KEY, hasGeminiKey: !!st.geminiKey,
    aiProvider: st.geminiKey ? 'Gemini' : process.env.DEEPSEEK_API_KEY ? 'DeepSeek' : '',
    autoPublish: st.autoPublish, platforms: st.platforms, languages: st.languages, minPopularity: st.minPopularity, minVotes: st.minVotes,
    maxPerDay: st.maxPerDay, autoHideDays: st.autoHideDays, releasedDays: st.releasedDays, upcomingDays: st.upcomingDays, seriesNewOnly: st.seriesNewOnly, skipWeeklyShows: st.skipWeeklyShows, runEveryHours: RUN_EVERY_MS / 3600e3, providerMap: Object.assign({}, DEFAULT_PROVIDERS, st.providerMap),
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
  if (i.clearMetaToken === true) { if (cur.metaToken) changed.push('Meta token removed'); next.metaToken = ''; }
  else if (s(i.metaToken)) {
    const k = s(i.metaToken);
    if (!/^[A-Za-z0-9|_.-]{20,600}$/.test(k)) return { ok: false, message: 'That does not look like a Meta app token (app id|app secret, or an access token).' };
    if (k !== cur.metaToken) { changed.push('Meta token saved'); next.metaToken = k; }
  }
  if (i.clearGeminiKey === true) { if (cur.geminiKey) changed.push('Gemini key removed'); next.geminiKey = ''; }
  else if (s(i.geminiKey)) {
    const k = s(i.geminiKey);
    if (!/^[A-Za-z0-9_-]{30,120}$/.test(k)) return { ok: false, message: 'That does not look like a Google AI Studio (Gemini) API key — it usually starts with "AIza".' };
    if (k !== cur.geminiKey) { changed.push('Gemini key saved'); next.geminiKey = k; }
  }
  if (i.autoPublish != null) set('autoPublish', i.autoPublish === true || i.autoPublish === 'true', 'auto-publish ' + ((i.autoPublish === true || i.autoPublish === 'true') ? 'on' : 'off'));
  if (Array.isArray(i.platforms)) set('platforms', i.platforms.map((p) => clean(p, 60)).filter(Boolean).slice(0, 30), 'platforms');
  if (Array.isArray(i.languages)) { const l = i.languages.filter((x) => LANGS[x]); set('languages', l.length ? l : DEFAULT_LANGS.slice(), 'languages'); }
  if (i.minPopularity != null) set('minPopularity', clampNum(i.minPopularity, 0, 10000, 5), 'min popularity');
  if (i.minVotes != null) set('minVotes', Math.round(clampNum(i.minVotes, 0, 100000, 5)), 'min votes');
  if (i.maxPerDay != null) set('maxPerDay', Math.round(clampNum(i.maxPerDay, 0, 50, 5)), 'max per day');
  if (i.autoHideDays != null) set('autoHideDays', Math.round(clampNum(i.autoHideDays, 0, 365, 30)), 'auto-hide days');
  if (i.releasedDays != null) set('releasedDays', Math.round(clampNum(i.releasedDays, 1, 90, 45)), 'released in last N days');
  if (i.upcomingDays != null) set('upcomingDays', Math.round(clampNum(i.upcomingDays, 0, 90, 30)), 'upcoming next M days');
  if (i.seriesNewOnly != null) { const on = !(i.seriesNewOnly === false || i.seriesNewOnly === 'false'); set('seriesNewOnly', on, 'series: new shows + new seasons only ' + (on ? 'on' : 'off')); }
  if (i.skipWeeklyShows != null) { const on = !(i.skipWeeklyShows === false || i.skipWeeklyShows === 'false'); set('skipWeeklyShows', on, 'leave out talk / news / reality / soap shows ' + (on ? 'on' : 'off')); }
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
// tmdbnet: retries through public DNS where Indian networks block TMDB (the shop server is in Mumbai).
let fetchImpl = (url, opts) => require('./tmdbnet').fetchJson(url, opts);
const isV4 = (k) => /^eyJ/.test(k) && k.length > 60;
async function tmdbGet(key, pathQ, params) {
  if (!key) { const e = new Error('Add your TMDB key in 🍿 What\'s new → Settings first.'); e.code = 'NOKEY'; throw e; }
  const headers = { Accept: 'application/json' };
  let r; const reasons = [];
  for (const base of [TMDB_API, TMDB_API_ALT]) {
    const u = new URL(base + pathQ);
    for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) u.searchParams.set(k, String(v));
    if (isV4(key)) headers.Authorization = 'Bearer ' + key; else u.searchParams.set('api_key', key);
    try { r = await fetchImpl(u.toString(), { headers }); break; }
    catch (e) { reasons.push(u.hostname + ': ' + String((e && (e.reason || e.code || e.message)) || 'error').slice(0, 60)); }
  }
  // The reason (never the key) is shown in admin so a blocked network can be told apart from TMDB being down.
  if (!r) throw new Error('Could not reach TMDB (' + reasons.join('; ') + ') — try again later.');
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
// ---- "new or upcoming" rules ----
const DAY_MS = 86400e3;
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(s(v));
const ymd10 = (v) => s(v).slice(0, 10);
/** The India-time window around `ref` (ms, default now): from = today − releasedDays … to = today + upcomingDays (YYYY-MM-DD). */
function newWindow(st, ref) {
  const today = istDay(ref || Date.now());
  const mid = Date.parse(today + 'T00:00:00+05:30');
  const back = Math.round(clampNum(st && st.releasedDays, 1, 90, 45)); const ahead = Math.round(clampNum(st && st.upcomingDays, 0, 90, 30));
  return { today, from: istDay(mid - back * DAY_MS), to: istDay(mid + ahead * DAY_MS), releasedDays: back, upcomingDays: ahead };
}
const inWindow = (date, w) => isYmd(date) && date >= w.from && date <= w.to;
/**
 * TMDB movie details (append_to_response=release_dates) → India's release date: Digital (4, when it streams) first,
 * then Theatrical (3), Limited (2), TV (6), Premiere (1), Physical (5). '' when TMDB has no India date.
 */
function indiaReleaseDate(row) {
  const all = (row && row.release_dates && Array.isArray(row.release_dates.results)) ? row.release_dates.results : [];
  const inRow = all.find((r) => r && r.iso_3166_1 === 'IN');
  const list = (inRow && Array.isArray(inRow.release_dates) ? inRow.release_dates : []).filter((r) => r && isYmd(ymd10(r.release_date)));
  for (const type of [4, 3, 2, 6, 1, 5]) {
    const d = list.filter((r) => Number(r.type) === type).map((r) => ymd10(r.release_date)).sort()[0];
    if (d) return d;
  }
  return '';
}
/**
 * Is this series NEW in the window? det = TMDB /tv/<id> details (or a discover row: then only first_air_date is known).
 *   brand-new show  first_air_date in the window                      → { ok, kind: 'new-show', date }
 *   new season      a season ≥ 2 premieres in the window (seasons[].air_date, or last/next_episode_to_air with
 *                   episode_number 1) — the newest such season wins     → { ok, kind: 'new-season', season, seasonLabel: 'Season N', date }
 *   anything else (an old show that only aired weekly episodes)        → { ok: false, reason }
 * upcoming = the date is after today (India).
 */
function seriesNews(det, w) {
  const d = det || {};
  const first = ymd10(d.first_air_date);
  const done = (x) => Object.assign(x, { ok: true, upcoming: x.date > w.today });
  if (inWindow(first, w)) return done({ kind: 'new-show', date: first, season: 1, seasonLabel: '' });
  const prem = [];
  for (const x of Array.isArray(d.seasons) ? d.seasons : []) {
    const n = Number(x && x.season_number);
    if (n >= 1 && isYmd(ymd10(x.air_date))) prem.push({ n, date: ymd10(x.air_date) });
  }
  for (const e of [d.last_episode_to_air, d.next_episode_to_air]) {
    const n = Number(e && e.season_number);
    if (e && Number(e.episode_number) === 1 && n >= 1 && isYmd(ymd10(e.air_date))) prem.push({ n, date: ymd10(e.air_date) });
  }
  const season = prem.filter((p) => p.n >= 2 && inWindow(p.date, w)).sort((a, b) => b.n - a.n || (a.date < b.date ? 1 : -1))[0];
  if (season) return done({ kind: 'new-season', date: season.date, season: season.n, seasonLabel: 'Season ' + season.n });
  // No first_air_date on TMDB but season 1 starts in the window = still a brand-new show.
  const s1 = !isYmd(first) && prem.find((p) => p.n === 1 && inWindow(p.date, w));
  if (s1) return done({ kind: 'new-show', date: s1.date, season: 1, seasonLabel: '' });
  const newest = prem.sort((a, b) => b.n - a.n)[0];
  return { ok: false, reason: 'Old show' + (isYmd(first) ? ' (since ' + first.slice(0, 4) + ')' : '') + (newest ? ' — latest season ' + newest.n + ' started ' + newest.date : '') + ', no new season in the window' };
}
/** Movies: the (India, else worldwide) release date must be in the window. */
function movieNews(date, w) {
  if (!isYmd(date)) return { ok: false, reason: 'No release date' };
  if (!inWindow(date, w)) return { ok: false, reason: date < w.from ? 'Released ' + date + ' — more than ' + w.releasedDays + ' days before' : 'Comes out ' + date + ' — more than ' + w.upcomingDays + ' days ahead' };
  return { ok: true, kind: 'movie', date, upcoming: date > w.today };
}
// TMDB tv genre ids (discover rows) / names (details, stored posts) / show types of weekly or daily shows.
const WEEKLY_GENRE_IDS = { 10763: 'News', 10764: 'Reality', 10766: 'Soap', 10767: 'Talk' };
const WEEKLY_TYPES = ['Talk Show', 'News', 'Reality'];
/** 'Reality' / 'Talk Show' / … when a TMDB row, details or a stored post is a talk / news / reality / soap show; '' otherwise. */
function weeklyShow(row) {
  const r = row || {};
  if (WEEKLY_TYPES.includes(s(r.type))) return s(r.type);
  const gs = Array.isArray(r.genres) ? r.genres : [];
  for (const id of (Array.isArray(r.genre_ids) ? r.genre_ids : []).concat(gs.map((g) => g && g.id))) if (WEEKLY_GENRE_IDS[Number(id)]) return WEEKLY_GENRE_IDS[Number(id)];
  const name = gs.map((g) => s(g && typeof g === 'object' ? g.name : g)).find((x) => /^(talk|news|reality|soap)$/i.test(x));
  return name || '';
}
/** An old show (first aired 5+ years ago) whose seasons run all year (40+ episodes, like a weekly wrestling show). */
function continuousShow(det, now) {
  const d = det || {};
  const first = ymd10(d.first_air_date);
  if (!isYmd(first) || Date.parse(first) > (now || Date.now()) - 5 * 365 * DAY_MS) return false;
  return (Array.isArray(d.seasons) ? d.seasons : []).some((x) => Number(x && x.season_number) >= 1 && Number(x.episode_count) >= 40);
}
function weeklyReason(kind) { return 'Weekly / daily show' + (kind ? ' (' + kind + ')' : '') + ' — not a new release'; }
/**
 * 🆕 The LATEST season of a series (owner rule, 16 Sep 2026: "when AI fills about series ask it to pick the latest
 * season"). det = TMDB /tv/<id> details. Specials (season 0) are ignored, and so are seasons with no air date.
 *   → { number, name, episodes, airDate, overview, coming, days } | null
 * The highest season number that has ALREADY aired (air date ≤ today, India) wins. A later season that starts within
 * the next 30 days beats it and is marked coming: true ("Season 4 lands next week"). A show whose only dated season is
 * still ahead also comes back with coming: true. last/next_episode_to_air fill in for a stale seasons[] list.
 */
const SEASON_SOON_DAYS = 30;
function latestSeason(det, now) {
  const d = det || {};
  const today = istDay(now || Date.now());
  const soon = istDay((now || Date.now()) + SEASON_SOON_DAYS * DAY_MS);
  const rows = new Map(); // season number → { number, name, episodes, airDate, overview }
  for (const x of Array.isArray(d.seasons) ? d.seasons : []) {
    const n = Number(x && x.season_number);
    const date = ymd10(x && x.air_date);
    if (!(n >= 1) || !isYmd(date)) continue;
    rows.set(n, { number: n, name: clean(x.name, 60) || 'Season ' + n, episodes: Number(x.episode_count) || 0, airDate: date, overview: s(x.overview).slice(0, 700) });
  }
  // TMDB sometimes has a newer season only on last/next_episode_to_air.
  for (const e of [d.last_episode_to_air, d.next_episode_to_air]) {
    const n = Number(e && e.season_number);
    const date = ymd10(e && e.air_date);
    if (!(n >= 1) || !isYmd(date) || rows.has(n)) continue;
    rows.set(n, { number: n, name: 'Season ' + n, episodes: 0, airDate: Number(e.episode_number) === 1 ? date : '', overview: '' });
  }
  const all = [...rows.values()].filter((x) => isYmd(x.airDate)).sort((a, b) => b.number - a.number);
  if (!all.length) return null;
  const aired = all.filter((x) => x.airDate <= today)[0] || null;
  const ahead = all.filter((x) => x.airDate > today && x.airDate <= soon).sort((a, b) => (a.airDate < b.airDate ? -1 : 1))[0] || null;
  const pick = ahead && (!aired || ahead.number > aired.number) ? ahead : (aired || all.filter((x) => x.airDate > today).sort((a, b) => (a.airDate < b.airDate ? -1 : 1))[0]);
  if (!pick) return null;
  const coming = pick.airDate > today;
  return Object.assign({}, pick, { coming, days: coming ? Math.round((Date.parse(pick.airDate + 'T00:00:00+05:30') - Date.parse(today + 'T00:00:00+05:30')) / DAY_MS) : 0 });
}
/**
 * The date a customer cares about for a series picked by title (manual posts / ✨ AI fill): a new season that premiered
 * in the last 90 days or starts in the next 90 → its premiere + "Season N"; else the LATEST season the show has (so a
 * post about a long-running series talks about season 5, never season 1); else the show's first air date.
 */
function showDates(det, now) {
  const w = newWindow({ releasedDays: 90, upcomingDays: 90 }, now);
  const q = seriesNews(det, w);
  if (q.ok) return { releaseDate: q.date, seasonLabel: q.kind === 'new-season' ? q.seasonLabel : '' };
  const last = latestSeason(det, now);
  if (last && last.number >= 2) return { releaseDate: last.airDate, seasonLabel: 'Season ' + last.number };
  const first = ymd10(det && det.first_air_date);
  return { releaseDate: isYmd(first) ? first : '', seasonLabel: '' };
}
// TV details are cached for 12 h (each 6-hourly run and ✨ Suggest ask about the same shows).
const tvCache = new Map();
async function tvDetails(key, id) {
  const k = String(Number(id));
  const hit = tvCache.get(k);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.det;
  const det = await tmdbGet(key, '/tv/' + k, { language: 'en-US' });
  tvCache.set(k, { at: Date.now(), det });
  while (tvCache.size > 500) tvCache.delete(tvCache.keys().next().value);
  return det;
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
  const inDate = mt === 'tv' ? '' : indiaReleaseDate(row);
  const date = inDate || s(mt === 'tv' ? (row.first_air_date || row.air_date) : row.release_date).slice(0, 10);
  return {
    type: mt === 'tv' ? 'series' : 'movie',
    title: clean(mt === 'tv' ? (row.name || row.original_name) : (row.title || row.original_title), 100),
    service: clean(service, 60),
    ctaService: clean(service, 60),
    brand: brandOf(service),
    caption: cleanCaption(row.overview),
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    releaseRegion: inDate ? 'IN' : '',
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
  const row = await tmdbGet(key, '/' + m[1] + '/' + m[2], { language: 'en-US', append_to_response: m[1] === 'movie' ? 'videos,release_dates,credits' : 'videos,credits' });
  const d = draftFrom(row, m[1], service, null);
  Object.defineProperty(d, 'raw', { value: row, enumerable: false }); // tv: seasons / next episode for seriesNews()
  return d;
}
/**
 * ✨ Story facts for the AI caption writer (server-side only, never saved or sent to the storefront):
 * overview, tagline, top cast (+ character), director / creator, genres, release / season info, language, runtime / seasons.
 */
function storyFrom(raw, d, opts) {
  const r = raw || {}; const x = d || {};
  const o = opts || {};
  const cast = ((r.credits && r.credits.cast) || []).slice(0, 4)
    .map((c) => { const n = clean(c && c.name, 40); const ch = clean(s(c && c.character).split('/')[0], 40); return n ? n + (ch ? ' (as ' + ch + ')' : '') : ''; }).filter(Boolean);
  const creators = (r.created_by || []).map((c) => clean(c && c.name, 40)).filter(Boolean).slice(0, 2);
  const director = (((r.credits && r.credits.crew) || []).find((c) => c && c.job === 'Director') || {}).name;
  return {
    title: clean(x.title, 100), type: x.type === 'series' ? 'series' : 'movie',
    overview: s(r.overview || x.caption).slice(0, 700), tagline: clean(r.tagline, 160),
    cast, director: clean(director || creators.join(', '), 80),
    genres: (x.genres || []).slice(0, 4), releaseDate: s(x.releaseDate), seasonLabel: s(x.seasonLabel),
    language: LANGS[r.original_language] || LANGS[x.originalLanguage] || s(r.original_language), country: [].concat(r.origin_country || [], (r.production_countries || []).map((c) => c && c.iso_3166_1)).filter(Boolean).slice(0, 2).join(', '),
    runtime: Number(r.runtime) || 0, seasons: Number(r.number_of_seasons) || 0,
    // 🆕 The latest season, so the AI writes about season 5 of a 5-season show — never season 1 (owner, 16 Sep 2026).
    season: x.type === 'series' ? (o.season || latestSeason(r, o.now) || null) : null,
  };
}
/** The overview of one season (TMDB /tv/<id>/season/<n>) when seasons[] has none. Cached 12 h; failure = no overview. */
const seasonCache = new Map();
async function seasonOverview(key, id, n) {
  const k = String(Number(id)) + ':' + String(Number(n));
  const hit = seasonCache.get(k);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.text;
  let text = '';
  try {
    const row = await tmdbGet(key, '/tv/' + Number(id) + '/season/' + Number(n), { language: 'en-US' });
    text = s(row && row.overview).slice(0, 700);
  } catch (_) { text = ''; }
  seasonCache.set(k, { at: Date.now(), text });
  while (seasonCache.size > 300) seasonCache.delete(seasonCache.keys().next().value);
  return text;
}
/**
 * 🔎 Best TMDB match for a free-text title ("🎥Front of the class (2008)"): movies / series only, same year and kind
 * preferred, must have a poster. → a draft (genres named, date, poster, language, trailer) or null. Needs a TMDB key.
 */
function searchTitle(v) {
  const raw = s(v);
  const year = (raw.match(/\((19|20)\d\d\)/) || [''])[0].replace(/\D/g, '');
  const t = raw.replace(/\((19|20)\d\d\)/g, ' ').replace(/[^\p{L}\p{N}\s:'’&.,!?-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return { q: clean(t.replace(/^[:\s-]+|[:\s-]+$/g, ''), 80), year };
}
async function tmdbMatch(title, opts) {
  const o = opts || {};
  const st = await getSettings();
  if (!st.tmdbKey) return null;
  const { q, year } = searchTitle(title);
  const y = o.year || year;
  if (q.length < 2) return null;
  const [r, g] = await Promise.all([tmdbGet(st.tmdbKey, '/search/multi', { query: q, include_adult: 'false', language: 'en-US', page: 1 }), genres(st.tmdbKey)]);
  const rows = (r.results || []).filter((x) => (x.media_type === 'movie' || x.media_type === 'tv') && x.poster_path);
  const norm = (x) => s(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nameOf = (x) => (x.media_type === 'tv' ? (x.name || x.original_name) : (x.title || x.original_title));
  const dateOf = (x) => s(x.media_type === 'tv' ? x.first_air_date : x.release_date);
  const pop = (c) => Number(c.x.popularity) || 0;
  const score = (x) => {
    const name = nameOf(x);
    const date = dateOf(x);
    return (norm(name) === norm(q) ? 4 : norm(name).includes(norm(q)) ? 1 : 0) + (y && date.startsWith(y) ? 3 : 0) +
      (o.type === 'series' && x.media_type === 'tv' ? 1 : o.type === 'movie' && x.media_type === 'movie' ? 1 : 0) + Math.min(1, (Number(x.popularity) || 0) / 100);
  };
  const scored = rows.map((x) => ({ x, sc: score(x), exact: norm(nameOf(x)) === norm(q) || norm(x.original_title || x.original_name) === norm(q), yearOk: !y || dateOf(x).startsWith(y) })).sort((a, b) => b.sc - a.sc);
  if (!scored.length || scored[0].sc < 1) return null;
  // 📅 sure = exactly one title with this name (+ year when given, + the kind picked). Several → the one streaming on the
  // brand's provider in India; else the clearly most popular (2× the next); else not sure (no date is filled from it).
  let pick = scored[0]; let sure = false;
  let tops = scored.filter((c) => c.exact && c.yearOk);
  const typed = tops.filter((c) => (o.type === 'series' ? c.x.media_type === 'tv' : o.type === 'movie' ? c.x.media_type === 'movie' : true));
  if (typed.length) tops = typed;
  if (tops.length === 1) { pick = tops[0]; sure = true; }
  else if (tops.length > 1) {
    const ids = s(providersFor(o.brand || o.service || '', Object.assign({}, DEFAULT_PROVIDERS, st.providerMap)) || providersFor(o.service || '', Object.assign({}, DEFAULT_PROVIDERS, st.providerMap))).split('|').map(Number).filter(Boolean);
    const on = [];
    if (ids.length) {
      for (const c of tops.slice(0, 4)) {
        try {
          const wp = await tmdbGet(st.tmdbKey, '/' + c.x.media_type + '/' + Number(c.x.id) + '/watch/providers', {});
          const inn = (wp && wp.results && wp.results.IN) || {};
          const got = [].concat(inn.flatrate || [], inn.free || [], inn.ads || []).map((p) => Number(p && p.provider_id));
          if (got.some((x) => ids.includes(x))) on.push(c);
        } catch (_) { /* unknown = not on the provider */ }
      }
    }
    const pool = (on.length ? on : tops).slice().sort((a, b) => pop(b) - pop(a));
    pick = pool[0];
    sure = pool.length === 1 || (pop(pool[0]) > 0 && pop(pool[0]) >= 2 * pop(pool[1]));
  }
  const best = pick.x;
  const d = draftFrom(best, best.media_type, o.service || '', g);
  d.sure = sure;
  if (d.type === 'series') Object.assign(d, { seasonLabel: '' });
  let raw = best;
  try {
    const det = await tmdbDetails(st.tmdbKey, d.tmdbKey, o.service || '');
    if (det && det.title) {
      if (det.raw) raw = det.raw;
      Object.assign(d, { genres: det.genres.length ? det.genres : d.genres, trailerUrl: det.trailerUrl || '' });
      // Movies: India's release date when TMDB has one. Series: the new season's premiere + "Season N" when there is one.
      if (d.type === 'movie' && det.releaseRegion === 'IN') Object.assign(d, { releaseDate: det.releaseDate, releaseRegion: 'IN' });
      if (d.type === 'series' && det.raw) { const sd = showDates(det.raw, o.now); if (sd.releaseDate) Object.assign(d, sd); }
    }
  } catch (_) {}
  // 🆕 Series: the latest season (number, name, episode count, air date, overview) goes to the ✨ AI fill prompt, and
  // its "Season N" is what the badge and the date use. A season row with no overview gets one extra TMDB call.
  let season = null;
  if (d.type === 'series') {
    season = latestSeason(raw, o.now);
    if (season && !season.overview && Number(raw && raw.id)) season = Object.assign({}, season, { overview: await seasonOverview(st.tmdbKey, raw.id, season.number) });
    if (season && season.number >= 2 && !d.seasonLabel) d.seasonLabel = 'Season ' + season.number;
  }
  // Not enumerable: ✨ AI fill reads it; it never ends up in a saved post or any JSON answer.
  Object.defineProperty(d, 'story', { value: storyFrom(raw, d, { season, now: o.now }), enumerable: false });
  return d;
}
/**
 * 📅 Manual post without a release date → { found, releaseDate, seasonLabel, releaseRegion, message } from TMDB by title
 * (+ "(2008)" year, type, brand). Nothing found / not sure → found: false + "Couldn't find the date — type it".
 */
const NO_DATE = 'Couldn\'t find the date — type it';
async function autoDate(input, opts) {
  const i = input || {};
  const o = opts || {};
  if (i.type !== 'movie' && i.type !== 'series') return { found: false, message: '' };
  const st = await getSettings();
  if (!st.tmdbKey) return { found: false, nokey: true, message: '' };
  let m = null;
  try { m = await tmdbMatch(i.title, { type: i.type, brand: clean(i.brand, 40) || brandOf(i.ctaService || i.service), service: clean(i.ctaService || i.service, 60), now: o.now }); }
  catch (_) { m = null; }
  if (!m || !m.sure || !isYmd(m.releaseDate)) return { found: false, message: NO_DATE };
  const seasonLabel = i.type === 'series' ? (m.seasonLabel || '') : '';
  return { found: true, releaseDate: m.releaseDate, seasonLabel, releaseRegion: i.type === 'movie' && m.releaseRegion === 'IN' ? 'IN' : '', message: '📅 Date found automatically: ' + (seasonLabel ? seasonLabel + ' · ' : '') + m.releaseDate + ' — change it if it is wrong' };
}

/**
 * 📸 Instagram thumbnail + the Reel's caption, fetched by the server (feedthumb.js). Stored as feed_img_<id>t.
 * Nothing fetched → the uploaded picture / picture link is used; neither → the poster of the matching title (TMDB).
 * opts: { http, budgetMs } (tests pass a fake http).
 */
async function refreshThumb(id, opts) {
  const o = opts || {};
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Post not found.' };
  const ig = instagramUrl(p.instagramUrl);
  if (!ig) return { ok: false, message: 'This post has no Instagram link.' };
  const st = await getSettings();
  const thumbs = require('./feedthumb');
  const info = await thumbs.instagramInfo(ig, { metaToken: st.metaToken, http: o.http, budgetMs: o.budgetMs });
  const out = { ok: true, thumb: false, caption: false, poster: false, source: info.source || '', reason: info.reason || '', bytes: 0 };
  let dirty = false;
  const now = new Date().toISOString();
  if (info.caption) { const c = cleanSource(info.caption); if (c) { out.caption = true; if (c !== p.sourceCaption) { p.sourceCaption = c; dirty = true; } } }
  const cands = (info.images && info.images.length ? info.images.map((c) => c.url) : [info.imageUrl]).filter(Boolean).slice(0, 3);
  if (cands.length) {
    // First picture ≤ 120 KB wins; otherwise the smallest one that downloaded (the admin page shrinks it after).
    let img = null;
    for (const url of cands) {
      const got = await thumbs.downloadImage(url, { http: o.http });
      if (!got.ok) { if (!img) out.reason = got.reason; continue; }
      if (!img || !img.ok || got.buf.length < img.buf.length) img = got;
      if (got.buf.length <= THUMB_GOOD) break;
    }
    img = img || { ok: false, reason: out.reason };
    if (img.ok) {
      const dataUrl = 'data:' + img.type + ';base64,' + img.buf.toString('base64');
      if (dataUrl.length <= IMG_MAX) {
        try { await writeKey(IMG_PREFIX + id + 't', dataUrl); p.hasThumb = true; p.thumbAt = now; dirty = true; out.thumb = true; out.bytes = img.buf.length; }
        catch (e) { out.reason = /Data too long/i.test(String(e.message)) ? 'run schema-v17' : 'save failed'; }
      } else out.reason = 'picture too big';
    } else out.reason = img.reason || 'picture blocked';
  }
  if (!p.hasThumb && !p.hasImage && !p.imageUrl && st.tmdbKey && p.title) {
    try { const m = await tmdbMatch(p.title, { type: p.type }); if (m && m.imageUrl) { p.imageUrl = m.imageUrl; dirty = true; out.poster = true; } } catch (_) {}
  }
  if (dirty) { p.updatedAt = now; await saveAll(items); }
  out.post = p;
  out.message = out.thumb ? '📸 Thumbnail saved' + (out.caption ? ' (+ Reel caption for ✨ AI fill)' : '')
    : (out.poster ? '🎬 Instagram blocked the thumbnail — used the title\'s poster instead' : p.hasImage || p.imageUrl ? '⚠️ No Instagram thumbnail (' + (out.reason || 'blocked') + ') — your picture is used' : '⚠️ No Instagram thumbnail (' + (out.reason || 'blocked') + ') — upload a picture, or add a TMDB key for posters');
  return out;
}

/** Owner picked a title (search / suggestions): full details + trailer → saved post. publish=false = draft (OFF). */
async function tmdbCreate(tmdbKey, service, publish) {
  if (!/^(movie|tv):\d{1,9}$/.test(s(tmdbKey))) return { ok: false, message: 'Pick a title from the TMDB results.' };
  if ((await list()).some((p) => p.tmdbKey === tmdbKey)) return { ok: false, message: 'This title is already in the feed.' };
  if (!clean(service, 60)) return { ok: false, message: 'Pick the platform it streams on.' };
  const st = await getSettings();
  const d = await tmdbDetails(st.tmdbKey, tmdbKey, service);
  // Picked by hand: a show with a new season in the window still gets its "Season N" label + premiere date.
  if (d.type === 'series' && d.raw) { const q = seriesNews(d.raw, newWindow(st)); if (q.ok && q.seasonLabel) Object.assign(d, { seasonLabel: q.seasonLabel, releaseDate: q.date }); }
  const r = await save(Object.assign(d, { active: publish === true, importedAt: true, hideAfter: hideAfterFor(st, d.releaseDate, Date.now()) }));
  if (r.ok) { const job = await readJob(); if (!job.seen.includes(tmdbKey)) { job.seen.push(tmdbKey); await writeJob(job); } }
  return r;
}
function providersFor(service, map) {
  const n = s(service).toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k && n.includes(k)) return v;
  return '';
}
const istDay = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 10);
/** Auto-hide counts from the later of "now" and the release date (an upcoming post must not hide right when it comes out). */
function hideAfterFor(st, releaseDate, now) {
  if (!st.autoHideDays) return '';
  const rel = isYmd(releaseDate) ? Date.parse(releaseDate + 'T00:00:00+05:30') : 0;
  return new Date(Math.max(now, rel) + st.autoHideDays * DAY_MS).toISOString();
}

/** Active catalog services (the platforms FluxFilm sells). */
async function catalogServices() {
  return (await catalogServiceInfo()).map((x) => x.service);
}
/** [{ service, brand, minPrice, logoUrl }] of active catalog services (admin "Sell button uses plan" list with live prices). */
async function catalogServiceInfo() {
  try {
    const rows = await db.query('SELECT service, price, logo_url, is_active, raw_json FROM plans', []);
    const by = new Map();
    for (const r of rows) {
      let raw = {}; try { raw = typeof r.raw_json === 'object' && r.raw_json ? r.raw_json : JSON.parse(r.raw_json || '{}'); } catch (_) {}
      const act = r.is_active != null && r.is_active !== '' ? r.is_active : raw.IsActive;
      if (!(String(act).toUpperCase() === 'TRUE' || act === 1 || act === true)) continue;
      const name = s(r.service || raw.Service); if (!name) continue;
      const price = Number(r.price != null && r.price !== '' ? r.price : raw.Price) || 0;
      const logo = s(r.logo_url || raw.LogoUrl);
      const cur = by.get(name) || { service: name, brand: brandOf(name), minPrice: 0, logoUrl: '' };
      if (price > 0 && (!cur.minPrice || price < cur.minPrice)) cur.minPrice = price;
      if (!cur.logoUrl && /^https:\/\/[^\s"'<>]+$/i.test(logo)) cur.logoUrl = logo;
      by.set(name, cur);
    }
    return [...by.values()].sort((a, b) => a.service.localeCompare(b.service));
  } catch (_) { return []; }
}

/**
 * Candidates from TMDB discover for the given platforms (drafts, nothing saved) — only NEW or UPCOMING titles
 * (see seriesNews / movieNews). Series drafts carry releaseDate = the show's / new season's premiere + seasonLabel.
 * opts: { days (= releasedDays), upcomingDays, seriesNewOnly, languages, minPopularity, minVotes, now }
 * → { drafts, skipped (platforms without provider ids), notNew [{ title, tmdbKey, reason }], from, to }
 */
async function discover(st, services, opts) {
  const o = Object.assign({ days: st.releasedDays, upcomingDays: st.upcomingDays, seriesNewOnly: st.seriesNewOnly, skipWeeklyShows: st.skipWeeklyShows !== false, languages: st.languages, minPopularity: st.minPopularity, minVotes: st.minVotes }, opts || {});
  const map = Object.assign({}, DEFAULT_PROVIDERS, st.providerMap);
  const w = newWindow({ releasedDays: o.days, upcomingDays: o.upcomingDays }, o.now);
  const from = w.from; const to = w.to;
  const g = await genres(st.tmdbKey);
  const byKey = new Map(); const skipped = []; const notNew = [];
  // One platform shares a title with another (e.g. Netflix + "Netflix (Group Offer)"): the first platform keeps it.
  const unique = []; const seenIds = new Set();
  for (const svc of (services || []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 15)) {
    const ids = providersFor(svc, map);
    if (!ids) { skipped.push(svc); continue; }
    if (seenIds.has(ids)) continue;
    // The button sells the brand's main plan ("Netflix", not "Netflix (Group Offer)") when both are listed.
    seenIds.add(ids); unique.push([mainServiceFor(brandOf(svc), services) || svc, ids]);
  }
  for (const [svc, ids] of unique) {
    const anyLang = ANY_LANGUAGE.some((k) => svc.toLowerCase().includes(k));
    const base = { watch_region: 'IN', with_watch_providers: ids, with_watch_monetization_types: 'flatrate', include_adult: 'false', language: 'en-US', sort_by: 'popularity.desc', page: 1, 'vote_count.gte': o.minVotes || '', with_original_language: anyLang ? '' : (o.languages || []).join('|') };
    const [mv, tv] = await Promise.all([
      tmdbGet(st.tmdbKey, '/discover/movie', Object.assign({ 'primary_release_date.gte': from, 'primary_release_date.lte': to }, base)),
      tmdbGet(st.tmdbKey, '/discover/tv', Object.assign({ 'air_date.gte': from, 'air_date.lte': to }, base)),
    ]);
    const tvRows = (tv.results || []).slice(0, 10);
    const rows = (mv.results || []).slice(0, 10).map((x) => draftFrom(x, 'movie', svc, g)).concat(tvRows.map((x) => draftFrom(x, 'tv', svc, g)));
    for (const d of rows) {
      if (!d.title || byKey.has(d.tmdbKey) || notNew.some((x) => x.tmdbKey === d.tmdbKey)) continue;
      if (d.popularity < (o.minPopularity || 0) || d.votes < (o.minVotes || 0)) continue;
      // Talk / news / reality / soap shows (e.g. WWE Raw): weekly or daily episodes all year — never a "new" post.
      const weekly = d.type === 'series' && o.skipWeeklyShows ? weeklyShow(tvRows.find((x) => 'tv:' + Number(x.id) === d.tmdbKey)) : '';
      if (weekly) { notNew.push({ title: d.title, tmdbKey: d.tmdbKey, reason: weeklyReason(weekly) }); continue; }
      if (d.type === 'movie') {
        const q = movieNews(d.releaseDate, w);
        if (!q.ok) { notNew.push({ title: d.title, tmdbKey: d.tmdbKey, reason: q.reason }); continue; }
        d.upcoming = q.upcoming;
      } else if (o.seriesNewOnly) {
        // Brand-new show: the discover row already says so. Otherwise ask TMDB about its seasons.
        let q = seriesNews({ first_air_date: d.releaseDate }, w);
        if (!q.ok) {
          try {
            const det = await tvDetails(st.tmdbKey, d.tmdbKey.slice(3));
            const wk = o.skipWeeklyShows ? (weeklyShow(det) || (continuousShow(det, o.now) ? 'all-year episodes' : '')) : '';
            q = wk ? { ok: false, reason: weeklyReason(wk) } : seriesNews(det, w);
          } catch (e) { q = { ok: false, reason: 'Could not check its seasons (' + String((e && e.message) || e).slice(0, 60) + ')' }; }
        }
        if (!q.ok) { notNew.push({ title: d.title, tmdbKey: d.tmdbKey, reason: q.reason }); continue; }
        Object.assign(d, { releaseDate: q.date, seasonLabel: q.seasonLabel || '', upcoming: q.upcoming });
      }
      byKey.set(d.tmdbKey, d);
    }
  }
  // Most popular first (languages / popularity / votes filtered above); the daily cap is applied by the import.
  const drafts = [...byKey.values()].sort((a, b) => b.popularity - a.popularity);
  return { drafts, skipped, notNew, from, to };
}
/** Admin "✨ Suggest": candidates marked posted / new. */
async function tmdbSuggest(services, days) {
  const st = await getSettings();
  if (!st.tmdbKey) return { ok: false, message: 'Add your TMDB key in Settings first.' };
  const r = await discover(st, services && services.length ? services : await jobPlatforms(st), { days });
  const have = await knownKeys();
  r.drafts.forEach((d) => { d.posted = have.has(d.tmdbKey); });
  r.drafts.sort((a, b) => (a.posted ? 1 : 0) - (b.posted ? 1 : 0));
  return { ok: true, drafts: r.drafts.slice(0, 40), skipped: r.skipped, notNew: r.notNew.slice(0, 40), from: r.from, to: r.to };
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
  const result = { imported: 0, published: 0, drafts: 0, refreshed: 0, skipped: 0, notNew: 0 };
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
    const found = await discover(st, platforms, { now });
    result.notNew = found.notNew.length;
    const win = newWindow(st, now);
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
      // A movie dated with India's release date keeps it (discover rows only carry the worldwide date).
      const keys = ['imageUrl', 'caption', 'genres'].concat(p.type === 'movie' && p.releaseRegion === 'IN' ? [] : ['releaseDate']).concat(p.type === 'series' ? ['seasonLabel'] : []);
      for (const k of keys) if (d[k] && JSON.stringify(d[k]) !== JSON.stringify(p[k])) patch[k] = d[k];
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
      try {
        const det = await tmdbDetails(st.tmdbKey, d.tmdbKey, d.service);
        if (det && det.title) {
          // Series keep the premiere date + "Season N" worked out by discover (details only know the first air date).
          // Movies take India's release date when TMDB has one inside the window.
          const inDate = d.type === 'movie' && det.releaseRegion === 'IN' && inWindow(det.releaseDate, win);
          full = Object.assign({}, d, det, {
            imageUrl: det.imageUrl || d.imageUrl, genres: det.genres.length ? det.genres : d.genres,
            releaseDate: d.type === 'movie' ? (inDate ? det.releaseDate : d.releaseDate) : d.releaseDate,
            releaseRegion: inDate ? 'IN' : '', seasonLabel: d.seasonLabel || '',
          });
        }
      } catch (_) { /* discover row is enough */ }
      const r = await save(Object.assign({}, full, {
        active: st.autoPublish, pinned: false, importedAt: true,
        hideAfter: hideAfterFor(st, full.releaseDate, now),
      }));
      if (!r.ok) { result.skipped++; continue; }
      seen.add(d.tmdbKey); job.seen.push(d.tmdbKey);
      job.dayCount++; result.imported++;
      if (r.post.active) result.published++; else result.drafts++;
    }
    // 3) 📅 Dates + season labels of imported posts (not checked in the last 20 h) straight from TMDB.
    try { const dr = await refreshDates({ now }); if (dr.ok) result.dates = dr.updated.length; } catch (_) { /* next run */ }
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

/**
 * 📅 "🔄 Refresh dates & seasons" (admin button, force) + every import run: imported posts (not HIDDEN) get the date
 * the customer cares about, from TMDB:
 *   series  new season premiered / premieres in today's window (or the import day's) → releaseDate = its premiere,
 *           seasonLabel "Season N"; brand-new show → first air date, no label; no longer new → date left alone
 *           (counted in notNew — the 🧹 cleanup lists it)
 *   movies  India release date (Digital first) when TMDB has one → releaseDate + releaseRegion IN
 * Posts the owner edited: only an EMPTY releaseDate / seasonLabel is filled (a label only next to its own date).
 * An unedited post whose date moves later keeps showing until autoHideDays after it (hideAfter is only ever extended).
 * opts: { force (ignore the 20 h "checked recently"), now, max } → { ok, checked, updated [{ id, title, from, to, seasonLabel }], unchanged, failed, notNew }
 */
async function refreshDates(opts) {
  const o = opts || {};
  const st = await getSettings();
  if (!st.tmdbKey) return { ok: false, message: 'Add your TMDB key in Settings first.' };
  const now = o.now || Date.now();
  const nowIso = new Date(now).toISOString();
  const wNow = newWindow(st, now);
  const items = await list();
  const out = { ok: true, checked: 0, updated: [], unchanged: 0, failed: 0, notNew: 0 };
  let dirty = false;
  for (const p of items) {
    if (p.source !== 'tmdb' || !/^(movie|tv):\d{1,9}$/.test(s(p.tmdbKey)) || statusOf(p, new Date(now)) === 'HIDDEN') continue;
    if (!o.force && p.datesAt && now - Date.parse(p.datesAt) < 20 * 3600e3) continue;
    if (out.checked >= (o.max || 80)) break;
    out.checked++;
    let want = null;
    try {
      if (p.tmdbKey.startsWith('tv:')) {
        const det = await tvDetails(st.tmdbKey, p.tmdbKey.slice(3));
        let q = seriesNews(det, wNow);
        if (!q.ok) q = seriesNews(det, newWindow(st, Date.parse(p.importedAt || p.createdAt || '') || now));
        if (q.ok) want = { releaseDate: q.date, seasonLabel: q.kind === 'new-season' ? q.seasonLabel : '' };
        else out.notNew++;
      } else {
        const d = await tmdbDetails(st.tmdbKey, p.tmdbKey, p.ctaService || p.service || '');
        if (d && d.releaseRegion === 'IN') want = { releaseDate: d.releaseDate, releaseRegion: 'IN' };
        else if (d && isYmd(d.releaseDate) && !p.releaseDate) want = { releaseDate: d.releaseDate };
      }
    } catch (_) { out.failed++; continue; }
    p.datesAt = nowIso; dirty = true;
    if (!want) { out.unchanged++; continue; }
    const patch = {};
    if (want.releaseDate !== p.releaseDate && (!p.edited || !p.releaseDate)) patch.releaseDate = want.releaseDate;
    const date = patch.releaseDate || p.releaseDate;
    if (p.type === 'series' && want.seasonLabel !== undefined) {
      if (!p.edited) { if (want.seasonLabel !== (p.seasonLabel || '')) patch.seasonLabel = want.seasonLabel; }
      else if (!p.seasonLabel && want.seasonLabel && date === want.releaseDate) patch.seasonLabel = want.seasonLabel;
    }
    if (p.type === 'movie' && want.releaseRegion === 'IN' && date === want.releaseDate && p.releaseRegion !== 'IN') patch.releaseRegion = 'IN';
    if (!Object.keys(patch).length) { out.unchanged++; continue; }
    if (patch.releaseDate && !p.edited && p.hideAfter && !p.hiddenBy) {
      const h = hideAfterFor(st, patch.releaseDate, Date.parse(p.importedAt || p.createdAt || '') || now);
      if (h && h > p.hideAfter) patch.hideAfter = h;
    }
    if (patch.releaseDate || patch.seasonLabel !== undefined) out.updated.push({ id: p.id, title: p.title, from: p.releaseDate || '', to: date, seasonLabel: patch.seasonLabel !== undefined ? patch.seasonLabel : (p.seasonLabel || ''), edited: !!p.edited });
    else out.unchanged++;
    Object.assign(p, patch, { updatedAt: nowIso });
  }
  if (dirty) await saveAll(items);
  return out;
}

/**
 * 🧹 "Hide old titles imported by mistake" (admin, never automatic): LIVE imported posts that fail today's rules,
 * judged by the day each was imported (window = import day − releasedDays … + upcomingDays).
 *   movie   stored release date outside that window
 *   series  not a brand-new show, no "Season N" label, and TMDB shows no season premiering in that window
 *   weekly  (skipWeeklyShows) talk / news / reality / soap shows, or 5+ year-old shows with 40+ episode seasons (WWE Raw)
 * → { ok, candidates: [{ id, title, brand, type, releaseDate, importedAt, edited, reason }], checked, unchecked }
 */
async function notNewCandidates(opts) {
  const o = opts || {};
  const st = await getSettings();
  const now = o.now || Date.now();
  const items = await list();
  const out = { ok: true, candidates: [], checked: 0, unchecked: 0, rules: { releasedDays: st.releasedDays, upcomingDays: st.upcomingDays, seriesNewOnly: st.seriesNewOnly } };
  for (const p of items) {
    if (p.source !== 'tmdb' || !/^(movie|tv):\d{1,9}$/.test(s(p.tmdbKey)) || statusOf(p, new Date(now)) !== 'LIVE') continue;
    const ref = Date.parse(p.importedAt || p.createdAt || '') || now;
    const w = newWindow(st, ref);
    out.checked++;
    let q;
    const weekly = st.skipWeeklyShows && p.tmdbKey.startsWith('tv:') ? weeklyShow({ genres: p.genres }) : '';
    if (weekly) q = { ok: false, reason: weeklyReason(weekly) };
    else if (p.type === 'movie' || p.tmdbKey.startsWith('movie:')) q = isYmd(p.releaseDate) ? movieNews(p.releaseDate, w) : { ok: true };
    else if (!st.seriesNewOnly || p.seasonLabel || inWindow(p.releaseDate, w)) q = { ok: true };
    else {
      if (!st.tmdbKey) { out.unchecked++; continue; }
      try {
        const det = await tvDetails(st.tmdbKey, p.tmdbKey.slice(3));
        const wk = st.skipWeeklyShows ? (weeklyShow(det) || (continuousShow(det, now) ? 'all-year episodes' : '')) : '';
        q = wk ? { ok: false, reason: weeklyReason(wk) } : seriesNews(det, w);
      } catch (_) { out.unchecked++; continue; }
    }
    if (q.ok) continue;
    out.candidates.push({ id: p.id, title: p.title, brand: p.brand || p.service || '', type: p.type, releaseDate: p.releaseDate || '', importedAt: p.importedAt || p.createdAt || '', edited: !!p.edited, reason: q.reason });
  }
  return out;
}
/** Hide (not delete) the picked posts now: hideAfter = now. Only LIVE imported posts; returns the titles hidden. */
async function hideNotNew(ids, opts) {
  const want = new Set((Array.isArray(ids) ? ids : []).map((x) => s(x)).filter(Boolean).slice(0, 200));
  if (!want.size) return { ok: false, message: 'Tick at least one post.' };
  const now = new Date((opts && opts.now) || Date.now());
  const items = await list();
  const hidden = [];
  for (const p of items) {
    if (!want.has(p.id) || p.source !== 'tmdb' || statusOf(p, now) !== 'LIVE') continue;
    p.hideAfter = now.toISOString(); p.hiddenBy = 'cleanup'; p.updatedAt = now.toISOString();
    hidden.push({ id: p.id, title: p.title });
  }
  if (hidden.length) await saveAll(items);
  return { ok: true, hidden, skipped: want.size - hidden.length };
}

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
  posterPath, posterImage,
  TYPES, CTAS, IMG_HOSTS, TRAILER_HOSTS, IG_HOSTS, DEFAULT_PROVIDERS, DEFAULT_LANGS, MAX_POSTS,
  validate, instagramUrl, youtubeId, list, save, remove, dropVideo, setImage, setThumb, image, statusOf, sortPosts, sortDate, publicList, trendingLines, record, countLike, flushStats, stats,
  getSettings, publicSettings, saveSettings, tmdbSearch, tmdbCreate, tmdbSuggest, tmdbProviders, providersFor, draftFrom, catalogServices, catalogServiceInfo,
  discover, runImport, jobStatus, startTimer, toIso,
  newWindow, seriesNews, movieNews, indiaReleaseDate, notNewCandidates, hideNotNew,
  weeklyShow, continuousShow, showDates, latestSeason, seasonOverview, SEASON_SOON_DAYS, refreshDates, autoDate, NO_DATE,
  accountLikes, BRANDS, brandOf, mainServiceFor, migrate, searchTitle, tmdbMatch, storyFrom, refreshThumb, pictureOf, LANGS,
  _internal: { pending, liked, genreCache, setFetch: (f) => { fetchImpl = f; }, reset: () => { cache = null; pending.clear(); liked.clear(); genreCache.at = 0; running = false; tvCache.clear(); seasonCache.clear(); } },
};
