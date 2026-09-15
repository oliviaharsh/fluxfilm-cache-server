/**
 * FluxFilm - ❤️ liked and 🔖 saved 🍿 What's new posts, per customer account (phone login).
 *
 * Same identity rule as 💬 comments (feedcomments.js): the storefront phone session, and the phone must belong to an
 * existing customer. Every query is scoped by phone_norm (last 10 digits) — one phone never reads or changes another's.
 *
 *   setFeedMark    [phone, postId, 'like' | 'save', on]  → { ok, on, changed } | { ok: false, needsLogin | notReady | rateLimited | full }
 *   getFeedMarks   [phone]                               → { ok, ready, liked: [ids], saved: [ids], commented: [ids] } (newest first)
 *   importFeedMarks [phone, { liked: [ids], saved: [ids] }] → first login on a phone: that phone's local likes / saves are
 *                  copied to the account (INSERT IGNORE, LIVE posts only, ≤ 200 each), then the lists above
 *
 * ❤️ LIKE COUNTS (fix 15 Sep): once schema-v25 exists the number under a post is COUNT(*) of feed_likes rows for that post —
 * one row per phone per post (PRIMARY KEY phone_norm + post_id), so liking twice, after a restart / redeploy or from
 * another browser never counts twice, and two phones count two. The old per-device counter in app_settings feed_stats
 * (deduped only in server memory, so it could climb) is no longer shown. Liking needs a login (the storefront asks).
 *
 * Storage: db/schema-v25.sql → feed_likes, feed_saves. Fails soft: until it is run, getFeedMarks answers { ready: false }
 * and the storefront keeps likes / saves on the phone only (localStorage), exactly like before.
 */
const db = require('./db');

const TABLES = { like: 'feed_likes', save: 'feed_saves' };
const MAX_PER_KIND = 500; // saved / liked posts kept per account
const LIST_MAX = 500;
const IMPORT_MAX = 200;
const COMMENTED_MAX = 100;
const PER_PHONE = 90; // taps per phone per 10 minutes (like + save together)
const PER_PHONE_MS = 10 * 60e3;
const NOT_READY = 'Saved posts stay on this phone for now.';
const LOGIN = 'Log in with your phone number to keep your liked and saved posts.';

const s = (v) => String(v == null ? '' : v).trim();
const normPhone = (p) => { const d = s(p).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
const safePost = (v) => (/^fp[0-9a-f]{10}$/.test(s(v)) ? s(v) : '');
const missingTable = (e) => !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || /doesn't exist|no such table/i.test(String(e.message || '')));
const istString = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const ids = (list, max) => [...new Set((Array.isArray(list) ? list : []).map(safePost).filter(Boolean))].slice(0, max);

let feedRef = null;
const feed = () => feedRef || (feedRef = require('./feed'));

// ---- schema check (cached a minute) ----
let readyAt = 0; let readyVal = null;
async function ready(force) {
  if (!force && readyVal !== null && Date.now() - readyAt < 60e3) return readyVal;
  try {
    await db.query('SELECT post_id FROM feed_likes LIMIT 1', []);
    await db.query('SELECT post_id FROM feed_saves LIMIT 1', []);
    readyVal = true;
  } catch (e) { if (!missingTable(e)) throw e; readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}

async function isCustomer(ph) {
  const rows = await db.query('SELECT phone_norm FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  return rows.length > 0;
}
async function liveIds() {
  const f = feed();
  return new Set((await f.list()).filter((p) => f.statusOf(p) === 'LIVE').map((p) => p.id));
}

const recent = new Map(); // phone → [ms, ...]
function underLimit(ph, now) {
  const list = (recent.get(ph) || []).filter((t) => now - t < PER_PHONE_MS);
  if (list.length >= PER_PHONE) { recent.set(ph, list); return false; }
  list.push(now); recent.set(ph, list);
  if (recent.size > 20000) recent.clear();
  return true;
}

/** ❤️ / 🔖 on or off for one post. */
async function set(phone, postId, kind, on) {
  const ph = normPhone(phone);
  const pid = safePost(postId);
  const table = Object.prototype.hasOwnProperty.call(TABLES, kind) ? TABLES[kind] : '';
  const want = truthy(on);
  if (ph.length !== 10) return { ok: false, needsLogin: true, message: LOGIN };
  if (!pid) return { ok: false, message: 'Post not found.' };
  if (!table) return { ok: false, message: 'Unknown action.' };
  if (!(await ready())) return { ok: false, notReady: true, message: NOT_READY };
  if (!(await isCustomer(ph))) return { ok: false, needsLogin: true, message: LOGIN };
  if (!underLimit(ph, Date.now())) return { ok: false, rateLimited: true, message: 'Too many taps — please wait a few minutes.' };
  if (want) {
    // Only LIVE posts can be liked / saved; removing always works (the post may have been hidden since).
    if (!(await liveIds()).has(pid)) return { ok: false, message: 'This post is not available any more.' };
    const cnt = await db.query('SELECT COUNT(*) AS n FROM ' + table + ' WHERE phone_norm = ?', [ph]);
    if ((Number(cnt[0] && cnt[0].n) || 0) >= MAX_PER_KIND) {
      const has = await db.query('SELECT post_id FROM ' + table + ' WHERE phone_norm = ? AND post_id = ? LIMIT 1', [ph, pid]);
      if (!has.length) return { ok: false, full: true, message: kind === 'save' ? 'You have ' + MAX_PER_KIND + ' saved posts — remove a few first.' : 'You have liked a lot of posts — unlike a few first.' };
    }
    const r = await db.query('INSERT IGNORE INTO ' + table + ' (phone_norm, post_id, created_at) VALUES (?, ?, ?)', [ph, pid, istString()]);
    const changed = !!(r && Number(r.affectedRows) > 0);
    if (changed && kind === 'like') likeCache = null;
    return { ok: true, on: true, changed };
  }
  const r = await db.query('DELETE FROM ' + table + ' WHERE phone_norm = ? AND post_id = ?', [ph, pid]);
  const changed = !!(r && Number(r.affectedRows) > 0);
  if (changed && kind === 'like') likeCache = null;
  return { ok: true, on: false, changed };
}

let likeCache = null; let likeAt = 0;
/** { <postId>: unique account likes } — null before schema-v25 (then the old counter is shown). Cached 30 s. */
async function likeCounts() {
  if (likeCache && Date.now() - likeAt < 30e3) return likeCache;
  try {
    if (!(await ready())) return null;
    const rows = await db.query('SELECT post_id, COUNT(*) AS n FROM feed_likes GROUP BY post_id', []);
    const out = {}; for (const r of rows) { const id = safePost(r.post_id); if (id) out[id] = Number(r.n) || 0; }
    likeCache = out; likeAt = Date.now();
    return out;
  } catch (_) { return likeCache; }
}

/** The account's liked / saved / commented post ids, newest first. */
async function list(phone) {
  const ph = normPhone(phone);
  if (ph.length !== 10) return { ok: false, needsLogin: true, message: LOGIN };
  if (!(await ready())) return { ok: true, ready: false, liked: [], saved: [], commented: [], message: NOT_READY };
  if (!(await isCustomer(ph))) return { ok: false, needsLogin: true, message: LOGIN };
  const [lk, sv] = await Promise.all([
    db.query('SELECT post_id FROM feed_likes WHERE phone_norm = ? ORDER BY created_at DESC, post_id LIMIT ' + LIST_MAX, [ph]),
    db.query('SELECT post_id FROM feed_saves WHERE phone_norm = ? ORDER BY created_at DESC, post_id LIMIT ' + LIST_MAX, [ph]),
  ]);
  let commented = [];
  try {
    const rows = await db.query('SELECT post_id, MAX(id) AS last_id FROM feed_comments WHERE phone_norm = ? AND status <> ? GROUP BY post_id ORDER BY last_id DESC LIMIT ' + COMMENTED_MAX, [ph, 'hidden']);
    commented = ids(rows.map((r) => r.post_id), COMMENTED_MAX);
  } catch (e) { if (!missingTable(e)) throw e; }
  return { ok: true, ready: true, liked: ids(lk.map((r) => r.post_id), LIST_MAX), saved: ids(sv.map((r) => r.post_id), LIST_MAX), commented };
}

/** First login on a phone: copy that phone's local likes / saves to the account, then answer the lists. */
async function importLocal(phone, input) {
  const ph = normPhone(phone);
  if (ph.length !== 10) return { ok: false, needsLogin: true, message: LOGIN };
  if (!(await ready())) return { ok: true, ready: false, liked: [], saved: [], commented: [], imported: { liked: 0, saved: 0 }, message: NOT_READY };
  if (!(await isCustomer(ph))) return { ok: false, needsLogin: true, message: LOGIN };
  const o = input && typeof input === 'object' ? input : {};
  const live = await liveIds();
  const imported = { liked: 0, saved: 0 };
  for (const [kind, key] of [['like', 'liked'], ['save', 'saved']]) {
    const want = ids(o[key], IMPORT_MAX).filter((id) => live.has(id));
    if (!want.length) continue;
    const table = TABLES[kind];
    const cnt = await db.query('SELECT COUNT(*) AS n FROM ' + table + ' WHERE phone_norm = ?', [ph]);
    const room = Math.max(0, MAX_PER_KIND - (Number(cnt[0] && cnt[0].n) || 0));
    const rows = want.slice(0, room);
    if (!rows.length) continue;
    const at = istString();
    const r = await db.query('INSERT IGNORE INTO ' + table + ' (phone_norm, post_id, created_at) VALUES ' + rows.map(() => '(?, ?, ?)').join(', '), rows.flatMap((id) => [ph, id, at]));
    imported[key] = Number(r && r.affectedRows) || 0;
  }
  const out = await list(ph);
  return Object.assign(out, { imported });
}

/** Admin: is schema-v25 in? + how many account likes / saves. */
async function adminInfo() {
  try {
    if (!(await ready(true))) return { ready: false, likes: 0, saves: 0 };
    const [a, b] = await Promise.all([db.query('SELECT COUNT(*) AS n FROM feed_likes', []), db.query('SELECT COUNT(*) AS n FROM feed_saves', [])]);
    return { ready: true, likes: Number(a[0] && a[0].n) || 0, saves: Number(b[0] && b[0].n) || 0 };
  } catch (_) { return { ready: false, likes: 0, saves: 0, error: true }; }
}

module.exports = {
  set, list, importLocal, ready, adminInfo, likeCounts, TABLES, MAX_PER_KIND, IMPORT_MAX, PER_PHONE, NOT_READY,
  _internal: { recent, reset: () => { readyVal = null; readyAt = 0; likeCache = null; recent.clear(); }, setFeed: (f) => { feedRef = f; }, istString },
};
