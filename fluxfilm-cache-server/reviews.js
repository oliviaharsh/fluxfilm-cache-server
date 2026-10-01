/**
 * FluxFilm - ⭐ customer reviews, with the owner's reply underneath (owner request, 1 Oct 2026:
 * "can we also reviews function where we also reply to them").
 *
 * The rule that makes a review worth reading: **only a customer who has actually paid for something can write
 * one**, and there is **one per customer**, which they can rewrite. Nobody can stack five glowing reviews, and
 * nobody who has never bought can review us at all. A review wall anyone can post to is decoration, not proof.
 *
 * Moderation is feedmod.js, exactly as the 🍿 feed comments use it (same module, not a copy): abuse, phone
 * numbers, emails, UPI IDs, links and "DM me" selling are refused with a friendly message; borderline ones are
 * saved `pending` and stay hidden until the owner approves them. The owner can hide or delete any review, and
 * can reply to it — the reply shows under the review on the storefront.
 *
 * 🔒 What the public sees: "Harsh W.", a rating, the text, the service, and a date. Never the phone, never the
 * email. The IP is kept only as a salted hash, and the salt is per-process unless ADMIN_KEY is set, so the
 * stored hash cannot be matched back to an address by anyone reading the table.
 *
 * ⚠️ Phone columns are NEVER compared across tables in SQL — `orders`, `customers` and `reviews` do not share a
 * collation and MariaDB refuses the join (live lesson, 27 Sep). Every lookup here is one table with a parameter.
 *
 * Storage: db/schema-v34.sql → reviews. Fails soft: until it is run, reading answers { ready: false } and the
 * storefront shows no review section at all; writing answers notReady. Nothing else on the site is affected.
 *
 * Storefront:  getReviews                     (public)
 *              getMyReview, addReview         (logged-in customer)
 * Admin:       GET  /admin/api/reviews?status=
 *              POST /admin/api/reviews/reply    { id, reply }
 *              POST /admin/api/reviews/status   { id, status }
 *              POST /admin/api/reviews/delete   { id }
 */
const crypto = require('crypto');
const db = require('./db');
const mod = require('./feedmod');

const STATUSES = ['visible', 'pending', 'hidden'];
const PAGE = 20;
const TEXT_MAX = 400;
const REPLY_MAX = 400;
const PER_PHONE = 4;              // saves (including refused tries) per phone…
const PER_PHONE_MS = 10 * 60e3;   // …per ten minutes
const NOT_READY = 'Reviews are coming soon.';

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const normPhone = (p) => { const d = s(p).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
const missingTable = (e) => !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || /doesn't exist|no such table/i.test(String(e.message || '')));
const istString = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');

/** "Harsh Walia" → "Harsh W." — the same rule the feed comments use. Never a phone number. */
function displayName(name) {
  const parts = s(name).split(/\s+/).filter(Boolean);
  const word = (w) => (/^[\p{L}\p{M}.'’-]{2,20}$/u.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '');
  const first = word(parts[0] || '');
  if (!first) return 'FluxFilm member';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const initial = /^\p{L}/u.test(last) ? last.charAt(0).toUpperCase() + '.' : '';
  return (first + (initial ? ' ' + initial : '')).slice(0, 30);
}
const SALT = process.env.ADMIN_KEY || process.env.CACHE_CLEAR_KEY || crypto.randomBytes(16).toString('hex');
function ipHash(ip) { const v = s(ip); return v ? crypto.createHash('sha256').update(SALT + '|' + v).digest('hex') : null; }
function safeAvatar(v) { const u = s(v); return /^(https?:\/\/|\/)[^\s"'<>]{1,500}$/.test(u) ? u : ''; }

// Tests replace the clock.
const deps = { now: () => Date.now() };

/** feedmod's wording is written for 🍿 feed comments. The RULES are the same for a review; the noun is not,
 *  and telling somebody their "comment" is being checked when they wrote a review is a small, avoidable confusion. */
const asReview = (msg) => s(msg).replace(/\bcomments\b/g, 'reviews').replace(/\bcomment\b/g, 'review');

// ---- schema check (cached a minute, so running the file needs no restart) ----
let readyAt = 0, readyVal = null;
async function ready(force) {
  if (!force && readyVal !== null && Date.now() - readyAt < 60e3) return readyVal;
  try { await db.query('SELECT id FROM reviews LIMIT 1', []); readyVal = true; }
  catch (e) { if (!missingTable(e)) throw e; readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}

// ---- rate limit, in memory (same shape as feedcomments) ----
const recent = new Map();
function underLimit(ph, now) {
  const list = (recent.get(ph) || []).filter((t) => now - t < PER_PHONE_MS);
  recent.set(ph, list);
  if (recent.size > 20000) recent.clear();
  return list.length < PER_PHONE;
}

// ---- what the public may see ----
function publicRow(r) {
  return {
    id: num(r.id),
    name: s(r.name),
    avatar: safeAvatar(r.avatar_url) || '',
    rating: num(r.rating),
    service: s(r.service),
    text: s(r.text),
    at: s(r.created_at).slice(0, 10),
    reply: s(r.reply) || '',
    repliedAt: s(r.replied_at).slice(0, 10),
  };
}

let listCache = null, listAt = 0;
/** Public: the visible reviews, newest first, with the average. Cached a minute. */
async function list(opts) {
  const o = opts || {};
  if (!(await ready())) return { ok: true, ready: false, reviews: [], count: 0, average: 0 };
  if (!o.fresh && listCache && Date.now() - listAt < 60e3) return listCache;
  try {
    const rows = await db.query(
      "SELECT id, name, avatar_url, rating, service, text, reply, replied_at, created_at FROM reviews WHERE status = 'visible' ORDER BY id DESC LIMIT " + PAGE, []);
    const agg = await db.query("SELECT COUNT(*) n, AVG(rating) avg FROM reviews WHERE status = 'visible'", []);
    const a = (agg || [])[0] || {};
    listCache = {
      ok: true, ready: true,
      reviews: (rows || []).map(publicRow),
      count: num(a.n),
      average: num(a.n) ? Math.round(num(a.avg) * 10) / 10 : 0,
    };
    listAt = Date.now();
    return listCache;
  } catch (e) {
    if (missingTable(e)) return { ok: true, ready: false, reviews: [], count: 0, average: 0 };
    console.log('[reviews] could not read reviews:', e.message);
    return { ok: true, ready: true, reviews: [], count: 0, average: 0 };
  }
}

/** The customer's own review, so the box can be pre-filled instead of them writing it twice. */
async function mine(phone) {
  const ph = normPhone(phone);
  if (ph.length !== 10) return { ok: false, needsLogin: true, message: 'Log in to see your review.' };
  if (!(await ready())) return { ok: true, ready: false, review: null };
  const rows = await db.query('SELECT id, rating, service, text, status, reply, replied_at, created_at FROM reviews WHERE phone_norm = ? LIMIT 1', [ph]);
  const r = (rows || [])[0];
  return {
    ok: true, ready: true, canWrite: await hasBought(ph),
    review: r ? Object.assign(publicRow(Object.assign({ name: '' }, r)), { status: s(r.status) }) : null,
  };
}

/** Has this person ever paid us? One table, one parameter — never a join. */
async function hasBought(ph) {
  try {
    const r = await db.query("SELECT COUNT(*) n FROM orders WHERE phone_norm = ? AND UPPER(COALESCE(status, '')) = 'PAID'", [ph]);
    return num((r || [{}])[0].n) > 0;
  } catch (e) { if (missingTable(e)) return false; throw e; }
}

/**
 * Write (or rewrite) this customer's review. Returns { ok, status } — 'pending' means the owner has to let it
 * through, and the customer is told so plainly rather than wondering why it never appeared.
 */
async function add(phone, rating, text, service, meta) {
  const ph = normPhone(phone);
  if (ph.length !== 10) return { ok: false, needsLogin: true, message: 'Log in with your phone number to write a review.' };
  if (!(await ready())) return { ok: false, notReady: true, message: NOT_READY };

  const stars = Math.round(num(rating));
  if (!(stars >= 1 && stars <= 5)) return { ok: false, message: 'Please choose between 1 and 5 stars.' };

  const cust = await db.query('SELECT name, profile_pic_url FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!cust.length) return { ok: false, needsLogin: true, message: 'Log in with your phone number to write a review.' };
  // The rule that makes the wall worth reading.
  if (!(await hasBought(ph))) return { ok: false, notACustomer: true, message: 'Only customers who have bought a plan can leave a review.' };

  const now = deps.now();
  if (!underLimit(ph, now)) return { ok: false, rateLimited: true, message: 'You have changed your review a few times — please wait a few minutes.' };

  const m = mod.moderate(text);
  // Every real try counts, refused ones too, so nobody can sit there testing which words get through.
  if (m.reason !== 'empty') (recent.get(ph) || []).push(now);
  if (m.action === 'reject') return { ok: false, blocked: m.reason !== 'empty' && m.reason !== 'too long', message: asReview(m.message) };

  const name = displayName(cust[0].name);
  const avatar = safeAvatar(cust[0].profile_pic_url);
  const status = m.action === 'allow' ? 'visible' : 'pending';
  const at = istString(now);
  const svc = s(service).replace(/[<>]/g, '').slice(0, 80);
  // One row per customer: rewriting replaces it, and a rewritten review goes back through moderation. The reply
  // is cleared too — an owner's answer to the old words must never sit under new ones.
  await db.query(
    'INSERT INTO reviews (phone_norm, name, avatar_url, rating, service, text, status, reason, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON DUPLICATE KEY UPDATE name = VALUES(name), avatar_url = VALUES(avatar_url), rating = VALUES(rating), service = VALUES(service), '
    + 'text = VALUES(text), status = VALUES(status), reason = VALUES(reason), reply = NULL, replied_at = NULL, updated_at = VALUES(created_at)',
    [ph, name, avatar || null, stars, svc || null, m.text, status, m.reason || null, ipHash(meta && meta.ip), at]);
  listCache = null;
  // Held ones are common and harmless: the shared moderator treats words like "cheap" as a selling signal,
  // which in a review is usually a compliment. The owner approves it in admin → ⭐ Reviews.
  return status === 'pending'
    ? { ok: true, status, message: asReview(m.message) || 'Thank you — we will put your review up shortly.' }
    : { ok: true, status, message: '⭐ Thank you for the review!' };
}

// ---- admin ----
/** opts: { status: 'visible' | 'pending' | 'hidden' | 'all', limit } */
async function adminList(opts) {
  const o = opts || {};
  if (!(await ready(true))) return { ok: true, ready: false, schemaFile: 'db/schema-v34.sql', reviews: [], counts: {}, message: 'Run db/schema-v34.sql in phpMyAdmin to turn reviews on.' };
  const want = STATUSES.includes(s(o.status)) ? s(o.status) : '';
  const limit = Math.min(200, Math.max(1, parseInt(o.limit, 10) || 50));
  const rows = want
    ? await db.query('SELECT * FROM reviews WHERE status = ? ORDER BY id DESC LIMIT ' + limit, [want])
    : await db.query('SELECT * FROM reviews ORDER BY id DESC LIMIT ' + limit, []);
  const c = await db.query('SELECT status, COUNT(*) n FROM reviews GROUP BY status', []);
  const counts = {};
  for (const r of c || []) counts[s(r.status)] = num(r.n);
  const agg = await db.query("SELECT COUNT(*) n, AVG(rating) avg FROM reviews WHERE status = 'visible'", []);
  const a = (agg || [])[0] || {};
  return {
    ok: true, ready: true, counts,
    average: num(a.n) ? Math.round(num(a.avg) * 10) / 10 : 0,
    visibleCount: num(a.n),
    // The owner sees the phone (it is their admin panel); the storefront never does.
    reviews: (rows || []).map((r) => Object.assign(publicRow(r), {
      status: s(r.status), reason: s(r.reason), phone: s(r.phone_norm), updatedAt: s(r.updated_at),
    })),
  };
}

/** The owner's answer, shown under the review. An empty reply removes it. */
async function reply(id, text) {
  if (!(await ready(true))) return { ok: false, notReady: true, message: NOT_READY };
  const rid = parseInt(id, 10);
  if (!(rid > 0)) return { ok: false, message: 'Which review?' };
  const body = mod.cleanText(text).slice(0, REPLY_MAX);
  const r = body
    ? await db.query('UPDATE reviews SET reply = ?, replied_at = ? WHERE id = ? LIMIT 1', [body, istString(deps.now()), rid])
    : await db.query('UPDATE reviews SET reply = NULL, replied_at = NULL WHERE id = ? LIMIT 1', [rid]);
  if (!r || !r.affectedRows) return { ok: false, message: 'That review is not there any more.' };
  listCache = null;
  return { ok: true, id: rid, reply: body, message: body ? '💬 Reply posted.' : 'Reply removed.' };
}

async function setStatus(id, status) {
  if (!(await ready(true))) return { ok: false, notReady: true, message: NOT_READY };
  const rid = parseInt(id, 10);
  const st = s(status);
  if (!(rid > 0)) return { ok: false, message: 'Which review?' };
  if (!STATUSES.includes(st)) return { ok: false, message: 'Status must be visible, pending or hidden.' };
  const r = await db.query('UPDATE reviews SET status = ? WHERE id = ? LIMIT 1', [st, rid]);
  if (!r || !r.affectedRows) return { ok: false, message: 'That review is not there any more.' };
  listCache = null;
  return { ok: true, id: rid, status: st, message: st === 'visible' ? '⭐ Shown on the site.' : st === 'hidden' ? 'Hidden.' : 'Held for review.' };
}

async function remove(id) {
  if (!(await ready(true))) return { ok: false, notReady: true, message: NOT_READY };
  const rid = parseInt(id, 10);
  if (!(rid > 0)) return { ok: false, message: 'Which review?' };
  const r = await db.query('DELETE FROM reviews WHERE id = ? LIMIT 1', [rid]);
  if (!r || !r.affectedRows) return { ok: false, message: 'That review is not there any more.' };
  listCache = null;
  return { ok: true, id: rid, message: 'Deleted. The customer can write a new one.' };
}

function mount(app, deps_) {
  const { auth } = deps_;
  const audit = deps_.audit || { record: () => {} };
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const short = (v) => s(v).slice(0, 60) + (s(v).length > 60 ? '…' : '');

  app.get('/admin/api/reviews', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await adminList({ status: req.query.status, limit: req.query.limit })); } catch (e) { fail(res, e); }
  });
  app.post('/admin/api/reviews/reply', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await reply(b.id, b.reply);
      if (!r.ok) return res.status(r.notReady ? 409 : 400).json(r);
      audit.record(req, { action: 'review.reply', entity: 'review', id: String(b.id), summary: ('💬 Replied to review #' + b.id + ': "' + short(r.reply) + '"').slice(0, 500) });
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  app.post('/admin/api/reviews/status', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await setStatus(b.id, b.status);
      if (!r.ok) return res.status(r.notReady ? 409 : 400).json(r);
      audit.record(req, { action: 'review.status', entity: 'review', id: String(b.id), summary: '⭐ Review #' + b.id + ' set to ' + r.status });
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  app.post('/admin/api/reviews/delete', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await remove(b.id);
      if (!r.ok) return res.status(r.notReady ? 409 : 400).json(r);
      audit.record(req, { action: 'review.delete', entity: 'review', id: String(b.id), summary: '🗑️ Review #' + b.id + ' deleted' });
      res.json(r);
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  list, mine, add, adminList, reply, setStatus, remove, mount, ready, displayName, hasBought,
  STATUSES, TEXT_MAX, REPLY_MAX, PER_PHONE, PAGE,
  _internal: { deps, publicRow, ipHash, reset: () => { listCache = null; listAt = 0; readyVal = null; readyAt = 0; recent.clear(); } },
};
