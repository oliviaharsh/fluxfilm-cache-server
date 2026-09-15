/**
 * FluxFilm - 💬 comments on 🍿 What's new posts.
 *
 * Everyone can read visible comments; only a logged-in customer (the storefront phone session — the phone must belong
 * to an existing customer, same check as the profile writes) can write one. Before saving, feedmod.js moderates the
 * text: abuse / phone numbers / emails / UPI IDs / links / "DM me" style selling are refused with a friendly message,
 * borderline ones are saved as `pending` (hidden until the owner approves them in admin → 🍿 What's new → 💬 Comments).
 * Limits: 5 comments per phone per 10 minutes, the same text twice in 24 h is refused, 280 characters.
 * Shown name = first name + last initial ("Harsh W."), never the phone. The IP is kept only as a salted hash.
 *
 * Storage: db/schema-v24.sql → feed_comments, feed_bans. Fails soft: until it is run, reading answers
 * { ready: false } ("Comments coming soon") and writing answers notReady — the feed itself keeps working.
 */
const crypto = require('crypto');
const db = require('./db');
const mod = require('./feedmod');

const STATUSES = ['visible', 'pending', 'hidden'];
const PAGE = 10;
const PER_PHONE = 5;
const PER_PHONE_MS = 10 * 60e3;
const DUP_MS = 24 * 3600e3;
const NOT_READY = 'Comments are coming soon.';

const s = (v) => String(v == null ? '' : v).trim();
const normPhone = (p) => { const d = s(p).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
const safePost = (v) => (/^fp[0-9a-f]{10}$/.test(s(v)) ? s(v) : '');
const missingTable = (e) => !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || /doesn't exist|no such table/i.test(String(e.message || '')));
// India time, the same zone the DB session uses (db.js), "YYYY-MM-DD HH:MM:SS".
const istString = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
const istParse = (v) => { const t = Date.parse(s(v).replace(' ', 'T') + '+05:30'); return isNaN(t) ? 0 : t; };

let feedRef = null;
const feed = () => feedRef || (feedRef = require('./feed'));

// ---- schema check (cached a minute) ----
let readyAt = 0; let readyVal = null;
async function ready(force) {
  if (!force && readyVal !== null && Date.now() - readyAt < 60e3) return readyVal;
  try { await db.query('SELECT id FROM feed_comments LIMIT 1', []); readyVal = true; }
  catch (e) { if (!missingTable(e)) throw e; readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}

/** "harsh  walia" → "Harsh W."; one name → "Harsh"; digits / emails / odd names → "FluxFilm member". */
function displayName(name) {
  const parts = s(name).split(/\s+/).filter(Boolean);
  const word = (w) => (/^[\p{L}\p{M}.'’-]{2,20}$/u.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '');
  const first = word(parts[0] || '');
  if (!first) return 'FluxFilm member';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const initial = /^\p{L}/u.test(last) ? last.charAt(0).toUpperCase() + '.' : '';
  return (first + (initial ? ' ' + initial : '')).slice(0, 30);
}
/** Only the shop's own profile-photo links or plain https avatar pictures. */
function safeAvatar(u) {
  const v = s(u);
  if (/^\/profile-photo\/[a-f0-9]{24}(\?v=[a-z0-9]{1,20})?$/.test(v)) return v;
  return /^https:\/\/[A-Za-z0-9.-]+\/[^\s"'<>\\]{1,250}$/.test(v) ? v : '';
}
const ipHash = (ip) => crypto.createHash('sha256').update('ffcomment|' + s(ip)).digest('hex').slice(0, 24);

function publicRow(r) {
  return { id: Number(r.id), name: s(r.name) || 'FluxFilm member', avatar: safeAvatar(r.avatar_url), text: s(r.text), at: new Date(istParse(r.created_at) || Date.now()).toISOString() };
}

// ---- public read ----
/** Newest first, 10 at a time. cursor = the last id shown ("Load more"). */
async function list(postId, cursor) {
  const pid = safePost(postId);
  if (!pid) return { ok: false, message: 'Post not found.' };
  if (!(await ready())) return { ok: true, ready: false, comments: [], next: null, message: NOT_READY };
  const cur = Math.floor(Number(cursor) || 0);
  const rows = await db.query('SELECT id, name, avatar_url, text, created_at FROM feed_comments WHERE post_id = ? AND status = ?' + (cur > 0 ? ' AND id < ?' : '') + ' ORDER BY id DESC LIMIT ' + (PAGE + 1), cur > 0 ? [pid, 'visible', cur] : [pid, 'visible']);
  const page = rows.slice(0, PAGE).map(publicRow);
  return { ok: true, ready: true, comments: page, next: rows.length > PAGE ? page[page.length - 1].id : null };
}

let countCache = null; let countAt = 0;
/** { <postId>: visible comments } for the feed list (cached 30 s, {} before the schema). */
async function counts() {
  if (countCache && Date.now() - countAt < 30e3) return countCache;
  try {
    if (!(await ready())) return {};
    const rows = await db.query('SELECT post_id, COUNT(*) AS n FROM feed_comments WHERE status = ? GROUP BY post_id', ['visible']);
    const out = {}; for (const r of rows) out[s(r.post_id)] = Number(r.n) || 0;
    countCache = out; countAt = Date.now();
    return out;
  } catch (_) { return countCache || {}; }
}

// ---- previews under each post ----
const PREVIEW_N = 3;
const PREVIEW_MAX_POSTS = 12;
const PREVIEW_MS = 30e3;
const previewCache = new Map(); // postId → { at, comments }
/**
 * The newest 3 visible comments for up to 12 posts (the ones near the customer's screen) in ONE query, cached 30 s per
 * post. → { ok, ready, previews: { <postId>: { total, comments: [3 newest] } } }. Posts without comments get total 0.
 */
async function previews(postIds) {
  const ids = [...new Set((Array.isArray(postIds) ? postIds : []).map(safePost).filter(Boolean))].slice(0, PREVIEW_MAX_POSTS);
  if (!ids.length) return { ok: true, ready: true, previews: {} };
  if (!(await ready())) return { ok: true, ready: false, previews: {} };
  const now = Date.now();
  const need = ids.filter((id) => { const h = previewCache.get(id); return !h || now - h.at >= PREVIEW_MS; });
  if (need.length) {
    // One bounded query: (… post A … LIMIT 3) UNION ALL (… post B … LIMIT 3) — never reads a popular post's whole thread.
    const sql = need.map(() => '(SELECT id, post_id, name, avatar_url, text, created_at FROM feed_comments WHERE post_id = ? AND status = ? ORDER BY id DESC LIMIT ' + PREVIEW_N + ')').join(' UNION ALL ');
    const rows = await db.query(sql, need.flatMap((id) => [id, 'visible']));
    const by = {}; for (const r of rows) (by[s(r.post_id)] = by[s(r.post_id)] || []).push(r);
    for (const id of need) previewCache.set(id, { at: now, comments: (by[id] || []).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, PREVIEW_N).map(publicRow) });
    if (previewCache.size > 500) for (const [k, v] of previewCache) if (now - v.at >= PREVIEW_MS) previewCache.delete(k);
  }
  const cc = await counts();
  const out = {};
  for (const id of ids) { const list = (previewCache.get(id) || {}).comments || []; out[id] = { total: Math.max(Number(cc[id]) || 0, list.length), comments: list }; }
  return { ok: true, ready: true, previews: out };
}

// ---- public write ----
const recent = new Map(); // phone → [ms, ...] (comment tries in the last 10 minutes)
const lastTexts = new Map(); // phone → [{ key, at }]
function underLimit(ph, now) {
  const list = (recent.get(ph) || []).filter((t) => now - t < PER_PHONE_MS);
  recent.set(ph, list);
  if (recent.size > 20000) recent.clear();
  return list.length < PER_PHONE;
}
const blockedCounts = {}; // reason → count since start (admin shows it; the text itself is never kept)

/**
 * a = [phone, postId, text]. meta = { ip }.
 * → { ok: true, status: 'visible' | 'pending', comment?, message } | { ok: false, message, needsLogin? | blocked? | notReady? | rateLimited? }
 */
async function add(phone, postId, text, meta) {
  const ph = normPhone(phone);
  const pid = safePost(postId);
  if (ph.length !== 10) return { ok: false, needsLogin: true, message: 'Log in with your phone number to comment.' };
  if (!pid) return { ok: false, message: 'Post not found.' };
  const post = (await feed().list()).find((p) => p.id === pid);
  if (!post || feed().statusOf(post) !== 'LIVE') return { ok: false, message: 'This post is not available any more.' };
  if (!(await ready())) return { ok: false, notReady: true, message: NOT_READY };
  const cust = await db.query('SELECT name, profile_pic_url FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!cust.length) return { ok: false, needsLogin: true, message: 'Log in with your phone number to comment.' };
  try {
    const ban = await db.query('SELECT phone_norm FROM feed_bans WHERE phone_norm = ? LIMIT 1', [ph]);
    if (ban.length) return { ok: false, blocked: true, message: 'You can\'t comment right now.' };
  } catch (e) { if (!missingTable(e)) throw e; }
  const now = Date.now();
  if (!underLimit(ph, now)) return { ok: false, rateLimited: true, message: 'You are commenting a lot — please wait a few minutes.' };
  const m = mod.moderate(text);
  // Every real try counts (refused ones too), so nobody can keep testing words; an empty box does not.
  if (m.reason !== 'empty') recent.get(ph).push(now);
  if (m.action === 'reject') { blockedCounts[m.reason] = (blockedCounts[m.reason] || 0) + 1; return { ok: false, blocked: m.reason !== 'empty' && m.reason !== 'too long', message: m.message }; }
  const key = mod.sameKey(m.text);
  const mine = (lastTexts.get(ph) || []).filter((x) => now - x.at < DUP_MS);
  let dup = mine.some((x) => x.key === key);
  if (!dup) {
    const rows = await db.query('SELECT text FROM feed_comments WHERE phone_norm = ? AND created_at >= ? ORDER BY id DESC LIMIT 30', [ph, istString(now - DUP_MS)]);
    dup = rows.some((r) => mod.sameKey(r.text) === key);
  }
  if (dup) return { ok: false, duplicate: true, message: 'You already posted this comment.' };
  const name = displayName(cust[0].name);
  const avatar = safeAvatar(cust[0].profile_pic_url);
  const status = m.action === 'allow' ? 'visible' : 'pending';
  const at = istString(now);
  const r = await db.query('INSERT INTO feed_comments (post_id, phone_norm, name, avatar_url, text, status, reason, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [pid, ph, name, avatar || null, m.text, status, m.reason || null, ipHash(meta && meta.ip), at]);
  mine.push({ key, at: now }); lastTexts.set(ph, mine.slice(-20));
  if (lastTexts.size > 20000) lastTexts.clear();
  countCache = null;
  if (status === 'pending') return { ok: true, status, message: m.message };
  previewCache.delete(pid);
  return { ok: true, status, comment: publicRow({ id: r && r.insertId, name, avatar_url: avatar, text: m.text, created_at: at }), message: '💬 Comment posted' };
}

// ---- admin ----
/** opts: { status: 'pending' | 'visible' | 'hidden' | 'all', postId, limit } */
async function adminList(opts) {
  const o = opts || {};
  if (!(await ready(true))) return { ok: true, ready: false, comments: [], counts: { visible: 0, pending: 0, hidden: 0 }, byPost: {}, bans: 0, blocked: blockedCounts };
  const where = []; const params = [];
  if (STATUSES.includes(o.status)) { where.push('status = ?'); params.push(o.status); }
  if (safePost(o.postId)) { where.push('post_id = ?'); params.push(safePost(o.postId)); }
  const limit = Math.max(1, Math.min(200, Math.floor(Number(o.limit) || 100)));
  const [rows, cnt, byPost] = await Promise.all([
    db.query('SELECT id, post_id, phone_norm, name, text, status, reason, created_at, updated_at FROM feed_comments' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ' + limit, params),
    db.query('SELECT status, COUNT(*) AS n FROM feed_comments GROUP BY status', []),
    db.query('SELECT post_id, status, COUNT(*) AS n FROM feed_comments GROUP BY post_id, status', []),
  ]);
  const counts = { visible: 0, pending: 0, hidden: 0 };
  for (const c of cnt) if (STATUSES.includes(c.status)) counts[c.status] = Number(c.n) || 0;
  const per = {};
  for (const c of byPost) { const k = s(c.post_id); per[k] = per[k] || { visible: 0, pending: 0, hidden: 0 }; if (STATUSES.includes(c.status)) per[k][c.status] = Number(c.n) || 0; }
  let bans = 0; let banned = new Set();
  try { const b = await db.query('SELECT phone_norm FROM feed_bans', []); bans = b.length; banned = new Set(b.map((x) => s(x.phone_norm))); } catch (e) { if (!missingTable(e)) throw e; }
  return {
    ok: true, ready: true, counts, byPost: per, bans, blocked: blockedCounts,
    comments: rows.map((r) => ({ id: Number(r.id), postId: s(r.post_id), phone: s(r.phone_norm), name: s(r.name), text: s(r.text), status: s(r.status), reason: s(r.reason), at: new Date(istParse(r.created_at) || 0).toISOString(), banned: banned.has(s(r.phone_norm)) })),
  };
}

/** action: approve | hide | delete | block (block = no more comments from that phone + hide all of theirs) | unblock */
async function adminAction(id, action) {
  if (!(await ready(true))) return { ok: false, message: 'Run db/schema-v24.sql in phpMyAdmin first.' };
  const cid = Math.floor(Number(id) || 0);
  const rows = cid > 0 ? await db.query('SELECT id, post_id, phone_norm, name, text, status FROM feed_comments WHERE id = ? LIMIT 1', [cid]) : [];
  if (!rows.length) return { ok: false, message: 'Comment not found.' };
  const c = rows[0]; const at = istString();
  countCache = null;
  // A hidden / deleted / blocked comment must leave the previews at once (block can touch many posts).
  if (action === 'block') previewCache.clear(); else previewCache.delete(s(c.post_id));
  if (action === 'approve') await db.query('UPDATE feed_comments SET status = ?, updated_at = ? WHERE id = ?', ['visible', at, cid]);
  else if (action === 'hide') await db.query('UPDATE feed_comments SET status = ?, updated_at = ? WHERE id = ?', ['hidden', at, cid]);
  else if (action === 'delete') await db.query('DELETE FROM feed_comments WHERE id = ?', [cid]);
  else if (action === 'block') {
    await db.query('INSERT INTO feed_bans (phone_norm, reason, created_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)', [s(c.phone_norm), 'comment ' + cid, at]);
    await db.query('UPDATE feed_comments SET status = ?, updated_at = ? WHERE phone_norm = ? AND status <> ?', ['hidden', at, s(c.phone_norm), 'hidden']);
  } else if (action === 'unblock') await db.query('DELETE FROM feed_bans WHERE phone_norm = ?', [s(c.phone_norm)]);
  else return { ok: false, message: 'Unknown action.' };
  return { ok: true, comment: { id: cid, postId: s(c.post_id), phone: s(c.phone_norm), name: s(c.name), status: action === 'approve' ? 'visible' : action === 'delete' ? 'deleted' : action === 'unblock' ? s(c.status) : 'hidden' } };
}

module.exports = {
  list, add, counts, previews, ready, adminList, adminAction, displayName, safeAvatar, NOT_READY, PER_PHONE, PREVIEW_N, PREVIEW_MAX_POSTS,
  _internal: { recent, lastTexts, blockedCounts, previewCache, reset: () => { readyVal = null; readyAt = 0; countCache = null; recent.clear(); lastTexts.clear(); previewCache.clear(); }, setFeed: (f) => { feedRef = f; }, istString, istParse },
};
