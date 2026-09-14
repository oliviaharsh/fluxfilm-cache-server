/**
 * FluxFilm - offers, banners and pop-ups (admin → 📣 Offers). No schema change: app_settings 'promos' (list),
 * 'promo_img_<id>' (picture, data URL) and 'promo_stats' (views / clicks).
 *
 * Types:  bar   = thin announcement strip at the top of the page
 *         card  = big banner on Home / My plans
 *         popup = pop-up when the customer opens the site (once per visit / day / ever)
 * Each offer has a schedule (start / end, India time), pages, audience (everyone / not logged in / logged-in customers),
 * an optional coupon code (copied + pre-filled at checkout) and a button (go to Buy, open a link, or none).
 */
const crypto = require('crypto');
const db = require('./db');

const KEY = 'promos';
const STATS_KEY = 'promo_stats';
const IMG_PREFIX = 'promo_img_';
const TYPES = ['bar', 'card', 'popup'];
const THEMES = ['festive', 'green', 'red', 'purple', 'dark', 'gold'];
const PAGES = ['home', 'dashboard', 'buy', 'account'];
const AUDIENCES = ['all', 'guests', 'customers'];
const FREQS = ['visit', 'day', 'once'];
const ACTIONS = ['buy', 'link', 'none'];
const IMG_MAX = 450000; // ~330 KB picture; the admin page shrinks uploads first
const s = (v) => String(v == null ? '' : v).trim();
const clean = (v, max) => s(v).replace(/[<>]/g, '').slice(0, max);
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

async function readKey(key) {
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]); return r.length ? r[0].value : null; }
  catch (e) { if (missingTable(e)) return null; throw e; }
}
async function writeKey(key, value) {
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, value]);
}
function parseList(v) { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch (_) { return []; } }
function toIso(v) {
  const t = s(v);
  if (!t) return '';
  // "2026-09-30T23:59" from the admin form is India time.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + (t.length === 16 ? ':00' : '') + '+05:30');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function validate(input, existing) {
  const i = input || {}; const errors = [];
  const out = Object.assign({}, existing || {});
  out.id = (existing && existing.id) || ('pr' + crypto.randomBytes(5).toString('hex'));
  out.name = clean(i.name, 60) || clean(i.title, 60) || 'Offer';
  out.active = i.active === true || i.active === 'true' || i.active === 1;
  out.type = TYPES.includes(i.type) ? i.type : 'bar';
  out.theme = THEMES.includes(i.theme) ? i.theme : 'festive';
  out.emoji = clean(i.emoji, 8);
  out.title = clean(i.title, 80);
  out.message = clean(i.message, 240);
  if (!out.title && !out.message) errors.push('Write a title or a message.');
  out.couponCode = clean(i.couponCode, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  out.ctaAction = ACTIONS.includes(i.ctaAction) ? i.ctaAction : 'buy';
  out.ctaText = clean(i.ctaText, 30) || (out.ctaAction === 'none' ? '' : 'Shop now');
  out.ctaLink = s(i.ctaLink).slice(0, 300);
  if (out.ctaAction === 'link' && !/^https:\/\/[^\s<>"]+$/i.test(out.ctaLink)) errors.push('The button link must start with https://');
  if (out.ctaAction !== 'link') out.ctaLink = '';
  const st = toIso(i.startAt); const en = toIso(i.endAt);
  if (st === null) errors.push('Start date/time is not valid.');
  if (en === null) errors.push('End date/time is not valid.');
  out.startAt = st || ''; out.endAt = en || '';
  if (out.startAt && out.endAt && out.endAt <= out.startAt) errors.push('The end must be after the start.');
  out.pages = (Array.isArray(i.pages) ? i.pages : []).filter((p) => PAGES.includes(p));
  if (out.type !== 'popup' && !out.pages.length) out.pages = ['home', 'dashboard'];
  out.audience = AUDIENCES.includes(i.audience) ? i.audience : 'all';
  out.frequency = FREQS.includes(i.frequency) ? i.frequency : 'visit';
  out.countdown = i.countdown === true || i.countdown === 'true';
  out.priority = Math.max(0, Math.min(99, Math.round(Number(i.priority) || 0)));
  out.hasImage = !!(existing && existing.hasImage);
  out.updatedAt = new Date().toISOString();
  return { ok: !errors.length, promo: out, errors };
}

async function list() { return parseList(await readKey(KEY)); }
async function saveAll(items) { await writeKey(KEY, JSON.stringify(items)); cache = null; }

async function save(input) {
  const items = await list();
  const idx = input && input.id ? items.findIndex((p) => p.id === input.id) : -1;
  if (input && input.id && idx < 0) return { ok: false, message: 'Offer not found.' };
  const v = validate(input, idx >= 0 ? items[idx] : null);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  if (idx >= 0) items[idx] = v.promo; else items.unshift(v.promo);
  if (items.length > 50) return { ok: false, message: 'Too many offers — delete old ones first (max 50).' };
  await saveAll(items);
  return { ok: true, promo: v.promo, created: idx < 0 };
}
async function remove(id) {
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Offer not found.' };
  await saveAll(items.filter((x) => x.id !== id));
  try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [IMG_PREFIX + id]); } catch (_) {}
  return { ok: true, promo: p };
}
async function setImage(id, dataUrl) {
  const items = await list();
  const p = items.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Save the offer first, then add a picture.' };
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
  return { ok: true, hasImage: p.hasImage };
}
async function image(id) {
  const v = s(await readKey(IMG_PREFIX + s(id).replace(/[^a-z0-9]/g, '')));
  const m = v.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  return m ? { type: m[1], buf: Buffer.from(m[2], 'base64') } : null;
}

function statusOf(p, now) {
  const t = (now || new Date()).toISOString();
  if (!p.active) return 'OFF';
  if (p.startAt && t < p.startAt) return 'SCHEDULED';
  if (p.endAt && t >= p.endAt) return 'ENDED';
  return 'LIVE';
}

// ---- public ----
let cache = null; let cacheAt = 0;
async function publicList(now) {
  if (!now && cache && Date.now() - cacheAt < 30e3) return cache;
  const items = (await list()).filter((p) => statusOf(p, now) === 'LIVE').sort((a, b) => b.priority - a.priority);
  const out = {
    ok: true,
    promos: items.map((p) => ({
      id: p.id, type: p.type, theme: p.theme, emoji: p.emoji, title: p.title, message: p.message,
      couponCode: p.couponCode, ctaAction: p.ctaAction, ctaText: p.ctaText, ctaLink: p.ctaLink,
      endAt: p.endAt, pages: p.pages, audience: p.audience, frequency: p.frequency, countdown: p.countdown,
      image: p.hasImage ? '/promo-img/' + p.id + '?v=' + encodeURIComponent(p.updatedAt) : '',
    })),
  };
  if (!now) { cache = out; cacheAt = Date.now(); }
  return out;
}

// Views / clicks: counted in memory, written to app_settings once a minute (no write per page view).
const pending = new Map();
function record(id, kind) {
  const k = s(id).replace(/[^a-z0-9]/g, '');
  if (!k || !['view', 'click'].includes(kind)) return { ok: false };
  const cur = pending.get(k) || { views: 0, clicks: 0 };
  if (kind === 'view') cur.views++; else cur.clicks++;
  pending.set(k, cur);
  return { ok: true };
}
async function flushStats() {
  if (!pending.size) return;
  const batch = [...pending.entries()]; pending.clear();
  let stats = {}; try { stats = JSON.parse((await readKey(STATS_KEY)) || '{}') || {}; } catch (_) { stats = {}; }
  const known = new Set((await list()).map((p) => p.id));
  for (const [id, c] of batch) {
    if (!known.has(id)) continue;
    const cur = stats[id] || { views: 0, clicks: 0 };
    stats[id] = { views: cur.views + c.views, clicks: cur.clicks + c.clicks };
  }
  await writeKey(STATS_KEY, JSON.stringify(stats));
}
async function stats() {
  let st = {}; try { st = JSON.parse((await readKey(STATS_KEY)) || '{}') || {}; } catch (_) { st = {}; }
  for (const [id, c] of pending) { const cur = st[id] || { views: 0, clicks: 0 }; st[id] = { views: cur.views + c.views, clicks: cur.clicks + c.clicks }; }
  return st;
}
let timer = null;
function startTimer() {
  if (timer) return;
  timer = setInterval(() => flushStats().catch((e) => console.log('[promos] stats flush failed:', e.message)), 60e3);
  if (timer.unref) timer.unref();
}

/** Is the coupon code real and active? (warning in admin only) */
async function couponCheck(code) {
  const c = s(code).toUpperCase();
  if (!c) return null;
  const rows = await db.query('SELECT raw_json FROM coupons', []);
  for (const r of rows) {
    let j = {}; try { j = typeof r.raw_json === 'object' ? (r.raw_json || {}) : JSON.parse(r.raw_json || '{}'); } catch (_) {}
    const jc = s(j.CouponCode || j.Code).toUpperCase();
    if (jc === c) {
      const expired = j.Expiry && new Date(s(j.Expiry).replace(' ', 'T')).getTime() < Date.now();
      return { exists: true, active: s(j.Active).toUpperCase() === 'TRUE' && !expired, expired: !!expired };
    }
  }
  return { exists: false, active: false };
}

module.exports = { TYPES, THEMES, PAGES, AUDIENCES, FREQS, ACTIONS, validate, list, save, remove, setImage, image, statusOf, publicList, record, flushStats, stats, startTimer, couponCheck, toIso, _internal: { pending, reset: () => { cache = null; pending.clear(); } } };
