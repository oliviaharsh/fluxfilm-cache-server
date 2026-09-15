/**
 * FluxFilm - 🔗 n8n integration: the shop side (owner decision 16 Sep 2026).
 *
 * The owner's own n8n (subscription) sends the reminder / win-back emails, backs up the database to Google Drive,
 * watches uptime + deploys and posts What's new to social media. The shop never messages customers by itself here:
 * it only answers n8n's questions and records what n8n says it sent. Nothing is switched on until the owner imports
 * and activates the workflows (files in n8n/ and docs/n8n/).
 *
 * Auth: its own key (admin → 🔗 Integrations), sent as the X-N8N-Key header. Stored only as HMAC-SHA256, shown once,
 * can be rotated / revoked, last-used time shown. A key in the URL is refused. Rate limited. Every call is written
 * to the change log (audit_log, one compact line). It is NOT the admin key and NOT a storefront /api action.
 *
 *   GET  /n8n/api/expiring?when=before&days=3   (when = before | today | after; after = ended 1..days days ago)
 *                          &channel=email&unsent=1 (optional: lastReminderAt for that channel / only not sent yet)
 *   POST /n8n/api/reminder-sent   { subId, kind, channel }      → idempotent (reminder_log, channel N8N_<CHANNEL>)
 *   GET  /n8n/api/winback?afterDays=15&windowDays=3&limit=50     → creates / returns a personal win-back coupon each
 *   POST /n8n/api/winback-sent    { phone, campaign }           → idempotent (customers raw_json Winback<C>SentAt)
 *   GET  /n8n/api/posts/new?since=<iso>                         → published What's new posts since then
 *   GET  /n8n/api/health                                        → deep health + build fingerprint
 *   GET  /n8n/api/backup[?table=<name>]  ·  GET /n8n/api/backup/tables   (n8nbackup.js)
 *   GET  /unsubscribe?t=<token>  ·  POST /unsubscribe            (customer opt-out page, no login)
 *
 * Which plans get an expiry reminder is decided by the SAME code as the storefront's ⏳ renewal reminder pop-up:
 * rrDaysLeft_ / rrSkipped_ / rrRenewed_ are loaded from index.html (between RR_PURE_START and RR_PURE_END), fed with
 * rows shaped like getMySubscriptions / getCustomerOrders. Refunded / cancelled / removed / already renewed plans are
 * skipped, device rows 2..N of one purchase are skipped (Device 1 speaks for the purchase).
 *
 * Opt-out (customers raw_json, typed columns untouched): MarketingOptOut = 'TRUE' (no win-back), ReminderEmailOptOut =
 * 'TRUE' (expiring still lists the plan but without the email). A phone with no customers row keeps its choice in
 * app_settings 'n8n_optout_<hash>'.
 *
 * SQL: one table per statement, matched in JS (live lesson: utf8mb4_unicode_ci vs general_ci). JSON_SET with scalar
 * values only (works on MySQL and MariaDB).
 *
 * app_settings: n8n_settings (key hash + last used, webhook URL, event switches, win-back coupon settings)
 *               n8n_secrets  (webhook signing secret, backup key derived from the passphrase, unsubscribe key) —
 *               never sent to the browser, never in a backup.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const security = require('./security');
const renewRules = require('./renewrules');

const SETTINGS_KEY = 'n8n_settings';
const SECRETS_KEY = 'n8n_secrets';
const OPTOUT_PREFIX = 'n8n_optout_';
const KEY_PREFIX = 'ffn8n_';
const EVENTS = ['order.paid', 'order.delivered', 'subscription.expired', 'post.published'];
const CHANNELS = ['email', 'telegram', 'whatsapp', 'sms'];
const WINBACK_COOLDOWN_DAYS = 60;
const DEFAULT_WINBACK = {
  WB15: { type: 'PERCENT', value: 15, maxDiscount: 50, validDays: 7 },
  WB30: { type: 'PERCENT', value: 20, maxDiscount: 75, validDays: 7 },
};
const COUPON_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IST_MS = 5.5 * 3600e3;
const DAY_MS = 86400e3;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function parseJson(v, dflt) { try { const x = JSON.parse(v || ''); return x && typeof x === 'object' ? x : dflt; } catch (_) { return dflt; } }
const SITE = () => String(process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
const truthy = (v) => v === true || up(v) === 'TRUE' || v === 1 || v === '1';
const validEmail = (v) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s(v));

// ------------------------------------------------------------------ India dates (never trust the server TZ)
function istYmd(ms) { return new Date((ms == null ? Date.now() : ms) + IST_MS).toISOString().slice(0, 10); }
function istStamp(ms) { return new Date((ms == null ? Date.now() : ms) + IST_MS).toISOString().slice(0, 19).replace('T', ' '); }
function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** DB wall-clock text (India) → epoch ms. */
function dbMs(v) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0) - IST_MS;
}
function prettyYmd(ymd) { const m = s(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MON[+m[2] - 1] + ' ' + m[1] : ''; }
function e164(ph) { const p = norm(ph); return p.length === 10 ? '+91' + p : ''; }
function inList(n) { return new Array(n).fill('?').join(', '); }

// ------------------------------------------------------------------ the renewal pop-up rules, straight from index.html
let INDEX_PATH = path.join(__dirname, 'index.html');
let _rr = null;
function rr() {
  if (_rr) return _rr;
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const a = html.indexOf('// RR_PURE_START'); const b = html.indexOf('// RR_PURE_END');
  if (a < 0 || b < a) throw new Error('Renewal reminder rules (RR_PURE_START) not found in index.html');
  // eslint-disable-next-line no-new-func
  _rr = new Function(html.slice(a, b) + '\nreturn { rrDaysLeft_, rrSkipped_, rrRenewed_, rrFirstName_, rrParseMs_ };')();
  return _rr;
}
function setIndexPath(p) { if (p) { INDEX_PATH = p; _rr = null; } }
function firstName(name) {
  try { return rr().rrFirstName_(name); } catch (_) {
    const w = s(name).split(/\s+/)[0] || '';
    return /^[A-Za-z][A-Za-z.'-]{0,13}$/.test(w) && !/^(customer|user|test|na|null)$/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
  }
}

// ------------------------------------------------------------------ settings + secrets
async function readKey(key) {
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]); return r.length ? r[0].value : null; }
  catch (e) { if (missingTable(e)) return null; throw e; }
}
async function writeKey(key, value) {
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, value]);
}
let _settingsCache = null; let _settingsAt = 0;
async function getSettings(fresh) {
  if (!fresh && _settingsCache && Date.now() - _settingsAt < 15e3) return _settingsCache;
  const saved = parseJson(await readKey(SETTINGS_KEY), {});
  const events = {}; for (const ev of EVENTS) events[ev] = saved.events ? saved.events[ev] !== false : true;
  const winback = {};
  for (const c of Object.keys(DEFAULT_WINBACK)) winback[c] = Object.assign({}, DEFAULT_WINBACK[c], (saved.winback || {})[c] || {});
  for (const c of Object.keys(saved.winback || {})) if (!winback[c]) winback[c] = Object.assign({}, DEFAULT_WINBACK.WB15, saved.winback[c]);
  const out = Object.assign({}, saved, { events, winback, webhookUrl: s(saved.webhookUrl), key: saved.key || null });
  _settingsCache = out; _settingsAt = Date.now();
  return out;
}
async function saveSettingsRaw(st) {
  const copy = Object.assign({}, st);
  await writeKey(SETTINGS_KEY, JSON.stringify(copy));
  _settingsCache = null;
}
async function getSecrets() { return parseJson(await readKey(SECRETS_KEY), {}); }
async function saveSecrets(sec) { await writeKey(SECRETS_KEY, JSON.stringify(sec)); _unsubKey = null; }

/** A webhook URL must be https, with a real host (no credentials, no local / private address). '' = none. */
function validateWebhookUrl(v) {
  const x = s(v);
  if (!x) return { ok: true, url: '' };
  let u; try { u = new URL(x); } catch (_) { return { ok: false, message: 'The webhook URL is not a valid link.' }; }
  if (u.protocol !== 'https:') return { ok: false, message: 'The webhook URL must start with https://' };
  if (u.username || u.password) return { ok: false, message: 'The webhook URL must not contain a user name or password.' };
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '[::1]' || !/\./.test(h)) return { ok: false, message: 'The webhook URL must be a public https address (your n8n).' };
  if (x.length > 300) return { ok: false, message: 'The webhook URL is too long.' };
  return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, '') };
}

function validateWinback(input, current) {
  const out = {}; const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const c of Object.keys(current)) {
    const cur = current[c]; const i = src[c] || {};
    const type = i.type === undefined ? cur.type : up(i.type);
    if (!['PERCENT', 'FLAT'].includes(type)) errors.push(c + ': type must be PERCENT or FLAT.');
    const value = i.value === undefined ? cur.value : Math.round(num(i.value));
    if (!(value > 0) || (type === 'PERCENT' && value > 90) || value > 5000) errors.push(c + ': value must be 1-90 % or ₹1-5000.');
    const maxDiscount = i.maxDiscount === undefined ? cur.maxDiscount : Math.max(0, Math.round(num(i.maxDiscount)));
    const validDays = i.validDays === undefined ? cur.validDays : Math.round(num(i.validDays));
    if (!(validDays >= 1 && validDays <= 60)) errors.push(c + ': valid days must be 1-60.');
    out[c] = { type, value, maxDiscount, validDays };
  }
  return { ok: !errors.length, winback: out, errors };
}

// ------------------------------------------------------------------ API key (hashed)
const keyHash = (key) => crypto.createHmac('sha256', 'fluxfilm-n8n-api-key-v1').update(s(key)).digest('hex');
async function generateKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const st = await getSettings(true);
  const now = new Date().toISOString();
  st.key = { hash: keyHash(key), prefix: key.slice(0, KEY_PREFIX.length + 4), createdAt: now, lastUsedAt: '', lastUsedIp: '', rotated: !!st.key };
  await saveSettingsRaw(st);
  return { key, info: publicKeyInfo(st.key) };
}
async function revokeKey() { const st = await getSettings(true); const had = !!st.key; st.key = null; await saveSettingsRaw(st); return { revoked: had }; }
function publicKeyInfo(k) { return k ? { set: true, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || '', rotated: !!k.rotated } : { set: false }; }
async function checkKey(given) {
  const st = await getSettings();
  if (!st.key || !st.key.hash || !s(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(keyHash(given), 'hex'), Buffer.from(String(st.key.hash).padEnd(64, '0').slice(0, 64), 'hex'));
}
let _lastUsedSaved = 0;
async function touchKey(ip) {
  if (Date.now() - _lastUsedSaved < 60e3) return;
  _lastUsedSaved = Date.now();
  try { const st = await getSettings(true); if (st.key) { st.key.lastUsedAt = new Date().toISOString(); st.key.lastUsedIp = s(ip).slice(0, 64); await saveSettingsRaw(st); } }
  catch (e) { console.log('[n8n] last-used time not saved:', e.message); }
}

// ------------------------------------------------------------------ unsubscribe tokens (encrypted + authenticated)
let _unsubKey = null;
async function unsubKey() {
  if (_unsubKey) return _unsubKey;
  const sec = await getSecrets();
  if (!sec.unsubKey) { sec.unsubKey = crypto.randomBytes(32).toString('base64'); await saveSecrets(sec); }
  _unsubKey = Buffer.from(sec.unsubKey, 'base64');
  return _unsubKey;
}
/** Opaque link token for one phone (the phone is not readable in the URL). */
async function unsubToken(phone) {
  const ph = norm(phone); if (ph.length !== 10) return '';
  const key = await unsubKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update('u1|' + ph, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}
async function readUnsubToken(t) {
  try {
    const buf = Buffer.from(s(t), 'base64url');
    if (buf.length < 12 + 13 + 16 || buf.length > 80) return null;
    const key = await unsubKey();
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const txt = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
    const m = txt.match(/^u1\|(\d{10})$/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
async function unsubUrl(phone) { const t = await unsubToken(phone); return t ? SITE() + '/unsubscribe?t=' + t : ''; }

const optoutKey = (ph) => OPTOUT_PREFIX + crypto.createHmac('sha256', 'ff-n8n-optout').update(norm(ph)).digest('hex').slice(0, 40);
/** { marketing, reminders } per phone, from customers raw_json (or the app_settings fallback). */
async function optOuts(phones, customersByPhone) {
  const out = new Map();
  const missing = [];
  for (const ph of phones) {
    const c = customersByPhone.get(ph);
    if (c) { const raw = rawOf(c.raw_json); out.set(ph, { marketing: truthy(raw.MarketingOptOut), reminders: truthy(raw.ReminderEmailOptOut) }); } else missing.push(ph);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const part = missing.slice(i, i + 200); const keys = part.map(optoutKey);
    let rows = [];
    try { rows = await db.query('SELECT setting_key, value FROM app_settings WHERE setting_key IN (' + inList(keys.length) + ')', keys); } catch (e) { if (!missingTable(e)) throw e; }
    const byKey = new Map(rows.map((r) => [r.setting_key, parseJson(r.value, {})]));
    part.forEach((ph, j) => { const v = byKey.get(keys[j]) || {}; out.set(ph, { marketing: !!v.marketing, reminders: !!v.reminders }); });
  }
  return out;
}
async function customersFor(phones) {
  const m = new Map();
  for (let i = 0; i < phones.length; i += 200) {
    const part = phones.slice(i, i + 200);
    const rows = await db.query('SELECT phone, phone_norm, name, email, raw_json FROM customers WHERE phone_norm IN (' + inList(part.length) + ')', part);
    for (const r of rows) if (!m.has(s(r.phone_norm))) m.set(s(r.phone_norm), r);
  }
  return m;
}

/** what = 'offers' (no win-back / offers) · 'all' (also no reminder emails) · 'resubscribe'. */
async function setOptOut(phone, what) {
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Invalid link.' };
  const marketing = what !== 'resubscribe';
  const reminders = what === 'all';
  const at = istStamp();
  const rows = await db.query('SELECT phone FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (rows.length) {
    await db.query("UPDATE customers SET raw_json = JSON_SET(COALESCE(raw_json, JSON_OBJECT()), '$.MarketingOptOut', ?, '$.ReminderEmailOptOut', ?, '$.MarketingOptOutAt', ?) WHERE phone_norm = ? LIMIT 1",
      [marketing ? 'TRUE' : 'FALSE', reminders ? 'TRUE' : 'FALSE', at, ph]);
  } else {
    await writeKey(optoutKey(ph), JSON.stringify({ marketing, reminders, at }));
  }
  return { ok: true, marketing, reminders };
}

// ------------------------------------------------------------------ small in-process lock (one Node process on Hostinger)
const _locks = new Map();
function serial(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  _locks.set(key, tail);
  tail.then(() => { if (_locks.get(key) === tail) _locks.delete(key); });
  return run;
}

// ------------------------------------------------------------------ rows → the shapes the pop-up code reads
const reads = () => require('./reads');
function popSub(r, nowMs) {
  const days = renewRules.daysLeftIst(r.expiry_date, nowMs);
  const stopped = reads()._internal.stoppedRow(r);
  const elig = stopped || renewRules.renewEligibility(days);
  const st = up(r.status); const fsx = up(r.fulfillment_status);
  const renewable = (!st || st === 'ACTIVE' || st === 'EXPIRED') && !['REFUNDED', 'CANCELLED', 'FAILED', 'NO_STOCK'].includes(fsx);
  return {
    subId: s(r.sub_id), orderId: s(r.order_id), service: s(r.service), plan: s(r.plan),
    expiryDate: s(r.expiry_date), startDate: s(r.start_date), status: st, fulfillmentStatus: fsx,
    renewEligibility: elig, showRenewButton: !stopped && elig !== 'TOO_LATE' && renewable,
  };
}
function popOrder(o) { return { orderId: s(o.order_id), service: s(o.service), status: up(o.status), fulfillmentStatus: up(o.fulfillment_status), createdAt: s(o.created_at_sheet) }; }
async function subsForPhones(phones, groupsOn) {
  const out = [];
  for (let i = 0; i < phones.length; i += 200) {
    const part = phones.slice(i, i + 200);
    const rows = await db.query('SELECT sub_id, order_id, phone_norm, email, service, plan, start_date, expiry_date, status, fulfillment_status, COALESCE(removed, 0) AS removed' + (groupsOn ? ', group_index' : '') +
      ' FROM subscriptions WHERE phone_norm IN (' + inList(part.length) + ')', part);
    out.push(...rows);
  }
  return out;
}
async function ordersForPhones(phones, sinceStamp) {
  const out = [];
  for (let i = 0; i < phones.length; i += 200) {
    const part = phones.slice(i, i + 200);
    const rows = await db.query('SELECT order_id, phone_norm, service, status, fulfillment_status, order_type, created_at_sheet FROM orders WHERE phone_norm IN (' + inList(part.length) + ') AND created_at_sheet >= ?', part.concat([sinceStamp]));
    out.push(...rows);
  }
  return out;
}
const groupedAway = (r, groupsOn) => groupsOn && Number(r.group_index) > 1;

// ------------------------------------------------------------------ GET expiring
function renewUrl(subId) { return SITE() + '/?source=push&renew=' + encodeURIComponent(s(subId)); }
function parseExpiringQuery(q) {
  const when = s(q.when || 'before').toLowerCase();
  if (!['before', 'today', 'after'].includes(when)) return { ok: false, message: 'when must be before, today or after.' };
  let days = when === 'today' ? 0 : parseInt(q.days, 10);
  if (when === 'before') { if (!(days >= 1 && days <= 14)) return { ok: false, message: 'days must be 1-14 for when=before.' }; }
  if (when === 'after') { if (!(days >= 1 && days <= renewRules.LATE_RENEW_DAYS)) return { ok: false, message: 'days must be 1-' + renewRules.LATE_RENEW_DAYS + ' for when=after (renewal is allowed up to ' + renewRules.LATE_RENEW_DAYS + ' days late).' }; }
  const channel = s(q.channel).toLowerCase();
  if (channel && !CHANNELS.includes(channel)) return { ok: false, message: 'channel must be one of ' + CHANNELS.join(', ') + '.' };
  const kind = when === 'before' ? 'BEFORE_' + days : when === 'today' ? 'EXPIRY_DAY' : 'AFTER';
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 200));
  return { ok: true, when, days, kind, channel, unsent: truthy(q.unsent), limit };
}
/** Target day range (daysLeft values) for a query. */
function targetDays(p) { if (p.when === 'before') return [p.days, p.days]; if (p.when === 'today') return [0, 0]; return [-p.days, -1]; }

async function expiring(query, opts) {
  const p = parseExpiringQuery(query || {});
  if (!p.ok) return Object.assign({ status: 400 }, p);
  const nowMs = (opts && opts.now) || Date.now();
  const R = rr();
  const today = istYmd(nowMs);
  const [lo, hi] = targetDays(p);
  const from = addDaysYmd(today, lo) + ' 00:00:00';
  const to = addDaysYmd(today, hi + 1) + ' 00:00:00';
  const groupsOn = await require('./devicelogins').groupsReady(db.query);
  const window = await db.query('SELECT sub_id, phone_norm FROM subscriptions WHERE expiry_date >= ? AND expiry_date < ? ORDER BY expiry_date ASC LIMIT 3000', [from, to]);
  const phones = [...new Set(window.map((r) => norm(r.phone_norm)).filter((x) => x.length === 10))];
  const base = { ok: true, when: p.when, days: p.days, kind: p.kind, channel: p.channel || null, today, count: 0, items: [] };
  if (!phones.length) return base;
  const inWindow = new Set(window.map((r) => s(r.sub_id)));
  const [subs, orders, customers] = await Promise.all([
    subsForPhones(phones, groupsOn),
    ordersForPhones(phones, addDaysYmd(today, -60) + ' 00:00:00'),
    customersFor(phones),
  ]);
  const opt = await optOuts(phones, customers);
  const subsBy = new Map(); const ordersBy = new Map();
  for (const r of subs) { if (groupedAway(r, groupsOn)) continue; const k = norm(r.phone_norm); if (!subsBy.has(k)) subsBy.set(k, []); subsBy.get(k).push(r); }
  for (const o of orders) { const k = norm(o.phone_norm); if (!ordersBy.has(k)) ordersBy.set(k, []); ordersBy.get(k).push(popOrder(o)); }
  const picked = [];
  for (const ph of phones) {
    const rows = subsBy.get(ph) || [];
    const all = rows.map((r) => popSub(r, nowMs));
    const ords = ordersBy.get(ph) || [];
    rows.forEach((r, i) => {
      const sub = all[i];
      if (!inWindow.has(sub.subId)) return;
      if (Number(r.removed) === 1) return;
      if (sub.showRenewButton === false) return;
      const days = R.rrDaysLeft_(sub.expiryDate, nowMs);
      if (days == null || days < lo || days > hi) return;
      if (days < 0 && up(sub.renewEligibility) === 'TOO_LATE') return;
      if (R.rrSkipped_(sub, ords) || R.rrRenewed_(sub, all, ords, nowMs)) return;
      picked.push({ ph, r, sub, days });
    });
  }
  picked.sort((a, b) => a.days - b.days || s(a.r.expiry_date).localeCompare(s(b.r.expiry_date)));
  const list = picked.slice(0, 2000);
  // Last reminder of this kind (same expiry = same plan period; a renewal moves the expiry and re-arms it).
  const sentBy = new Map();
  const ids = [...new Set(list.map((x) => x.sub.subId))];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    let rows = [];
    try { rows = await db.query("SELECT sub_id, channel, kind, expiry_date, ts FROM reminder_log WHERE sub_id IN (" + inList(part.length) + ") AND channel LIKE 'N8N%'", part); }
    catch (e) { if (!missingTable(e)) throw e; }
    for (const x of rows) {
      if (s(x.kind) !== p.kind) continue;
      if (p.channel && s(x.channel) !== 'N8N_' + p.channel.toUpperCase()) continue;
      const k = s(x.sub_id) + '|' + s(x.expiry_date).slice(0, 19);
      if (!sentBy.has(k) || s(x.ts) > sentBy.get(k)) sentBy.set(k, s(x.ts));
    }
  }
  const items = [];
  for (const x of list) {
    const c = customers.get(x.ph);
    const o = opt.get(x.ph) || {};
    const lastAt = sentBy.get(x.sub.subId + '|' + s(x.r.expiry_date).slice(0, 19)) || null;
    if (p.unsent && lastAt) continue;
    const name = s(c && c.name);
    const fn = firstName(name);
    const email = s(c && c.email) || s(x.r.email);
    const expYmd = s(x.r.expiry_date).slice(0, 10);
    items.push({
      subId: x.sub.subId, kind: p.kind, firstName: fn, greetingName: fn || 'there',
      service: x.sub.service, plan: x.sub.plan,
      expiry: s(x.r.expiry_date).slice(0, 16), expiryDate: expYmd, expiryText: prettyYmd(expYmd), daysLeft: x.days,
      renewUrl: renewUrl(x.sub.subId),
      email: !o.reminders && validEmail(email) ? email : null, emailOptOut: !!o.reminders,
      phone: e164(x.ph) || null,
      lastReminderAt: lastAt, unsubscribeUrl: await unsubUrl(x.ph),
    });
    if (items.length >= p.limit) break;
  }
  return Object.assign(base, { count: items.length, items });
}

// ------------------------------------------------------------------ POST reminder-sent
const KIND_RE = /^(BEFORE_([1-9]|1[0-4])|EXPIRY_DAY|AFTER)$/;
async function reminderSent(body) {
  const b = body || {};
  const subId = s(b.subId).slice(0, 40); const kind = up(b.kind); const channel = s(b.channel || 'email').toLowerCase();
  if (!subId) return { ok: false, status: 400, message: 'subId is required.' };
  if (!KIND_RE.test(kind)) return { ok: false, status: 400, message: 'kind must be BEFORE_1..BEFORE_14, EXPIRY_DAY or AFTER (the kind from /expiring).' };
  if (!CHANNELS.includes(channel)) return { ok: false, status: 400, message: 'channel must be one of ' + CHANNELS.join(', ') + '.' };
  const ch = 'N8N_' + channel.toUpperCase();
  return serial('rem|' + subId + '|' + kind + '|' + ch, async () => {
    const subs = await db.query('SELECT sub_id, expiry_date FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]);
    if (!subs.length) return { ok: false, status: 404, message: 'Subscription not found.' };
    const exp = s(subs[0].expiry_date) || null;
    const have = await db.query('SELECT ts FROM reminder_log WHERE sub_id = ? AND channel = ? AND kind = ? AND expiry_date = ? LIMIT 1', [subId, ch, kind, exp]);
    if (have.length) return { ok: true, already: true, subId, kind, channel, sentAt: s(have[0].ts) };
    const at = istStamp();
    await db.query('INSERT INTO reminder_log (ts, sub_id, channel, kind, expiry_date, ok, note) VALUES (?, ?, ?, ?, ?, 1, ?)', [at, subId, ch, kind, exp, 'n8n']);
    return { ok: true, already: false, subId, kind, channel, sentAt: at };
  });
}

// ------------------------------------------------------------------ win-back
const campaignOf = (afterDays) => 'WB' + afterDays;
const CAMPAIGN_RE = /^WB([1-9]\d{0,2})$/;
function couponSettingsFor(settings, campaign) {
  const w = (settings && settings.winback) || {};
  return w[campaign] || (Number(campaign.slice(2)) >= 30 ? DEFAULT_WINBACK.WB30 : DEFAULT_WINBACK.WB15);
}
function offerText(c) { return c.type === 'PERCENT' ? c.value + '% off' + (c.maxDiscount > 0 ? ' (up to ₹' + c.maxDiscount + ')' : '') : '₹' + c.value + ' off'; }
function serviceSlug(name) {
  try { return require('./seo').serviceSlug(name); } catch (_) { return s(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
}
async function couponStillGood(code, nowMs) {
  const rows = await db.query('SELECT code, expiry, active, raw_json FROM coupons WHERE code = ? LIMIT 1', [code]);
  if (!rows.length) return null;
  const raw = rawOf(rows[0].raw_json);
  if (up(raw.Active) !== 'TRUE') return null;
  const exMs = dbMs(raw.Expiry || rows[0].expiry);
  if (exMs != null && exMs < nowMs + 3600e3) return null;
  const used = await db.query("SELECT COUNT(*) AS n FROM coupon_usage WHERE UPPER(coupon_code) = ? AND UPPER(action) = 'USED'", [up(code)]);
  if (Number((used[0] || {}).n) > 0) return null;
  return { code: s(rows[0].code), expiry: s(raw.Expiry || rows[0].expiry), raw };
}
/** Personal one-use coupon, typed columns AND raw_json (order.js couponDiscount reads raw_json only). */
async function createWinbackCoupon(ph, campaign, cs, nowMs) {
  let code = '';
  for (let i = 0; i < 8 && !code; i++) {
    let c = 'WB'; for (let j = 0; j < 6; j++) c += COUPON_CHARS[crypto.randomInt(0, COUPON_CHARS.length)];
    if (!(await db.query('SELECT code FROM coupons WHERE code = ? LIMIT 1', [c])).length) code = c;
  }
  if (!code) throw new Error('Could not pick a free coupon code.');
  const expiry = addDaysYmd(istYmd(nowMs), cs.validDays) + ' 23:59:59';
  const raw = {
    Code: code, CouponCode: code, Description: '🎁 Welcome back — ' + offerText(cs), Scope: 'ANY', Type: cs.type, Value: cs.value,
    MinAmount: 0, MaxDiscount: cs.type === 'PERCENT' ? cs.maxDiscount : 0, Expiry: expiry, PerUserLimit: 1, GlobalLimit: 1, Active: 'TRUE', ShowInProfile: 'TRUE',
    AllowedPhones: ph, FirstTimeOnly: 'FALSE', Source: 'WINBACK', Campaign: campaign, CreatedAt: istStamp(nowMs),
  };
  await db.query(
    'INSERT INTO coupons (code, description, scope, type, value, min_amount, max_discount, expiry, per_user_limit, global_limit, active, show_in_profile, allowed_phones, first_time_only, raw_json)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [code, raw.Description, raw.Scope, raw.Type, raw.Value, raw.MinAmount, raw.MaxDiscount, expiry, raw.PerUserLimit, raw.GlobalLimit, raw.Active, raw.ShowInProfile, raw.AllowedPhones, raw.FirstTimeOnly, JSON.stringify(raw)]);
  await db.query("UPDATE customers SET raw_json = JSON_SET(COALESCE(raw_json, JSON_OBJECT()), ?, ?, ?, ?) WHERE phone_norm = ? LIMIT 1",
    ['$.Winback' + campaign + 'Code', code, '$.Winback' + campaign + 'Expiry', expiry, ph]);
  return { code, expiry, raw };
}
function ensureWinbackCoupon(ph, campaign, cs, customerRaw, nowMs) {
  return serial('wb|' + ph + '|' + campaign, async () => {
    const fresh = await db.query('SELECT raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
    const raw = fresh.length ? rawOf(fresh[0].raw_json) : (customerRaw || {});
    const prev = s(raw['Winback' + campaign + 'Code']);
    if (prev) { const good = await couponStillGood(prev, nowMs); if (good) return { code: good.code, expiry: good.expiry, created: false }; }
    const c = await createWinbackCoupon(ph, campaign, cs, nowMs);
    return { code: c.code, expiry: c.expiry, created: true };
  });
}

async function winback(query, opts) {
  const q = query || {};
  const afterDays = q.afterDays == null || q.afterDays === '' ? 15 : parseInt(q.afterDays, 10);
  if (!(afterDays >= 7 && afterDays <= 120)) return { ok: false, status: 400, message: 'afterDays must be 7-120 (15 or 30 in the workflow).' };
  const windowDays = q.windowDays == null || q.windowDays === '' ? 3 : parseInt(q.windowDays, 10);
  if (!(windowDays >= 1 && windowDays <= 7)) return { ok: false, status: 400, message: 'windowDays must be 1-7.' };
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const nowMs = (opts && opts.now) || Date.now();
  const campaign = campaignOf(afterDays);
  const settings = await getSettings();
  const cs = couponSettingsFor(settings, campaign);
  const today = istYmd(nowMs);
  // Last plan ended between afterDays+windowDays-1 and afterDays days ago (a missed n8n run still catches them).
  const endFrom = addDaysYmd(today, -(afterDays + windowDays - 1));
  const endTo = addDaysYmd(today, -afterDays);
  const base = { ok: true, campaign, afterDays, windowDays, offer: offerText(cs), today, count: 0, items: [] };
  const window = await db.query('SELECT phone_norm FROM subscriptions WHERE expiry_date >= ? AND expiry_date < ? LIMIT 3000', [endFrom + ' 00:00:00', addDaysYmd(endTo, 1) + ' 00:00:00']);
  const phones = [...new Set(window.map((r) => norm(r.phone_norm)).filter((x) => x.length === 10))];
  if (!phones.length) return base;
  const groupsOn = await require('./devicelogins').groupsReady(db.query);
  const [subs, orders, customers] = await Promise.all([subsForPhones(phones, groupsOn), ordersForPhones(phones, addDaysYmd(endFrom, -10) + ' 00:00:00'), customersFor(phones)]);
  const opt = await optOuts(phones, customers);
  const subsBy = new Map(); const ordersBy = new Map();
  for (const r of subs) { const k = norm(r.phone_norm); if (!subsBy.has(k)) subsBy.set(k, []); subsBy.get(k).push(r); }
  for (const o of orders) { const k = norm(o.phone_norm); if (!ordersBy.has(k)) ordersBy.set(k, []); ordersBy.get(k).push(o); }
  const stoppedRow = reads()._internal.stoppedRow;
  const candidates = [];
  for (const ph of phones) {
    const c = customers.get(ph);
    if (!c) continue; // opt-out + "already messaged" live in the customer's raw_json
    if ((opt.get(ph) || {}).marketing) continue;
    const plans = (subsBy.get(ph) || []).filter((r) => !stoppedRow(r) && !['FAILED', 'NO_STOCK'].includes(up(r.fulfillment_status)) && dbMs(r.expiry_date) != null);
    if (!plans.length) continue;
    plans.sort((a, b) => dbMs(b.expiry_date) - dbMs(a.expiry_date));
    const last = plans[0];
    const lastYmd = s(last.expiry_date).slice(0, 10);
    if (lastYmd < endFrom || lastYmd > endTo) continue; // a newer plan (or a renewal) ends later → not lost
    const lastMs = dbMs(last.expiry_date);
    if (lastMs >= nowMs) continue;
    // Paid (or on credit) since the plan ended, maybe not delivered yet → not lost.
    if ((ordersBy.get(ph) || []).some((o) => ['PAID', 'CREDIT'].includes(up(o.status)) && (dbMs(o.created_at_sheet) || 0) > lastMs - 3 * DAY_MS)) continue;
    const raw = rawOf(c.raw_json);
    const sentMs = dbMs(raw['Winback' + campaign + 'SentAt']);
    if (sentMs != null && nowMs - sentMs < WINBACK_COOLDOWN_DAYS * DAY_MS) continue;
    candidates.push({ ph, c, raw, last });
  }
  candidates.sort((a, b) => s(b.last.expiry_date).localeCompare(s(a.last.expiry_date)));
  const items = [];
  for (const x of candidates.slice(0, limit)) {
    const cp = await ensureWinbackCoupon(x.ph, campaign, cs, x.raw, nowMs);
    const email = s(x.c.email) || s(x.last.email);
    const fn = firstName(x.c.name);
    const slug = serviceSlug(x.last.service);
    const exYmd = s(cp.expiry).slice(0, 10);
    items.push({
      campaign, firstName: fn, greetingName: fn || 'there', name: s(x.c.name),
      email: validEmail(email) ? email : null, phone: e164(x.ph),
      lastService: s(x.last.service), lastPlan: s(x.last.plan), lastEndedOn: s(x.last.expiry_date).slice(0, 10), lastEndedText: prettyYmd(x.last.expiry_date),
      couponCode: cp.code, couponExpiry: s(cp.expiry), couponExpiryText: prettyYmd(exYmd), couponCreated: cp.created, offer: offerText(cs),
      shopUrl: SITE() + '/?coupon=' + encodeURIComponent(cp.code),
      buyUrl: SITE() + '/?buy=' + encodeURIComponent(slug) + '&coupon=' + encodeURIComponent(cp.code),
      unsubscribeUrl: await unsubUrl(x.ph),
    });
  }
  return Object.assign(base, { count: items.length, candidates: candidates.length, items });
}

async function winbackSent(body, opts) {
  const b = body || {};
  const ph = norm(b.phone); const campaign = up(b.campaign);
  if (ph.length !== 10) return { ok: false, status: 400, message: 'phone is required (the phone from /winback).' };
  if (!CAMPAIGN_RE.test(campaign)) return { ok: false, status: 400, message: 'campaign must look like WB15 or WB30 (the campaign from /winback).' };
  const nowMs = (opts && opts.now) || Date.now();
  return serial('wbs|' + ph + '|' + campaign, async () => {
    const rows = await db.query('SELECT raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
    if (!rows.length) return { ok: false, status: 404, message: 'Customer not found.' };
    const raw = rawOf(rows[0].raw_json);
    const prev = s(raw['Winback' + campaign + 'SentAt']);
    const prevMs = dbMs(prev);
    if (prevMs != null && nowMs - prevMs < WINBACK_COOLDOWN_DAYS * DAY_MS) return { ok: true, already: true, campaign, sentAt: prev };
    const at = istStamp(nowMs);
    await db.query("UPDATE customers SET raw_json = JSON_SET(COALESCE(raw_json, JSON_OBJECT()), ?, ?) WHERE phone_norm = ? LIMIT 1", ['$.Winback' + campaign + 'SentAt', at, ph]);
    return { ok: true, already: false, campaign, sentAt: at };
  });
}

// ------------------------------------------------------------------ What's new posts
function absUrl(v) {
  const x = s(v);
  if (!x) return '';
  if (x.startsWith('/') && !x.startsWith('//')) return SITE() + x;
  if (/tmdb\.org/i.test(x)) return '';
  return /^https:\/\//i.test(x) ? x : '';
}
function priceFor(service, info) {
  const name = s(service); if (!name) return null;
  let hit = info.find((x) => x.service === name);
  if (!hit) { const lc = name.toLowerCase(); const list = info.filter((x) => x.service.toLowerCase().startsWith(lc)); hit = list.sort((a, b) => (a.minPrice || 9e9) - (b.minPrice || 9e9))[0]; }
  return hit && hit.minPrice > 0 ? hit.minPrice : null;
}
function postItem(p, info) {
  const reel = p.format === 'reel';
  const price = p.cta === 'none' ? null : priceFor(p.ctaService, info);
  return {
    id: s(p.id), format: reel ? 'reel' : 'post', type: s(p.type), title: s(p.title), caption: s(p.caption),
    genres: p.genres || [], languages: p.languages || [], brand: s(p.brand), ctaService: s(p.ctaService),
    fromPrice: price, fromPriceText: price ? 'from ₹' + price : '',
    releaseDate: s(p.releaseDate), seasonLabel: s(p.seasonLabel),
    imageUrl: absUrl(p.image), videoUrl: absUrl(p.video), trailerUrl: s(p.trailerUrl), instagramUrl: s(p.instagramUrl),
    shareUrl: SITE() + '/?' + (reel ? 'reel=' : 'post=') + encodeURIComponent(s(p.id)),
    postUrl: SITE() + '/?post=' + encodeURIComponent(s(p.id)),
    publishedAt: s(p.date),
  };
}
async function livePosts(nowMs) {
  const feed = require('./feed');
  const [list, info] = await Promise.all([feed.publicList(new Date(nowMs || Date.now())), feed.catalogServiceInfo()]);
  return { posts: (list && list.posts) || [], info: info || [] };
}
async function postsNew(query, opts) {
  const q = query || {};
  const nowMs = (opts && opts.now) || Date.now();
  let sinceMs = nowMs - DAY_MS;
  if (s(q.since)) { sinceMs = Date.parse(s(q.since)); if (isNaN(sinceMs)) return { ok: false, status: 400, message: 'since must be a date like 2026-09-16T10:00:00Z.' }; }
  const limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 20));
  const { posts, info } = await livePosts(nowMs);
  const items = posts.filter((p) => { const t = Date.parse(s(p.date)); return !isNaN(t) && t > sinceMs && t <= nowMs; })
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, limit).map((p) => postItem(p, info));
  return { ok: true, since: new Date(sinceMs).toISOString(), count: items.length, items };
}

// ------------------------------------------------------------------ health + build fingerprint
const _fp = {};
function fingerprintOf(file) {
  try {
    const st = fs.statSync(file); const k = st.size + ':' + st.mtimeMs;
    if (_fp[file] && _fp[file].k === k) return _fp[file].v;
    const v = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    _fp[file] = { k, v };
    return v;
  } catch (_) { return null; }
}
function buildFingerprint() {
  return { serverJs: fingerprintOf(path.join(__dirname, 'server.js')), indexHtml: fingerprintOf(INDEX_PATH), algorithm: 'sha256, first 12 hex chars of the raw file bytes' };
}
async function health() {
  const t0 = Date.now();
  let dbOk = false; let dbErr = '';
  try { const r = await db.query('SELECT 1 AS ok'); dbOk = !!(r && r[0] && Number(r[0].ok) === 1); } catch (e) { dbErr = String(e.message || e).slice(0, 200); }
  const dbMsTaken = Date.now() - t0;
  const out = { ok: dbOk, status: dbOk ? 'ok' : 'db_down', time: new Date().toISOString(), timeIst: istStamp(), uptimeSec: Math.round(process.uptime()), node: process.version };
  try { out.version = String(require('./package.json').version || ''); } catch (_) { out.version = ''; }
  try { out.appVersion = require('./appversion').version(); } catch (_) { out.appVersion = ''; }
  out.db = { ok: dbOk, ms: dbMsTaken, error: dbErr || undefined };
  try { out.imap = require('./payments').status(); } catch (_) { out.imap = { configured: false }; }
  if (dbOk) {
    const one = async (sql) => { try { const r = await db.query(sql, []); return r[0] || {}; } catch (e) { return { error: String(e.message).slice(0, 120) }; } };
    const [paid, bank, manual] = await Promise.all([
      one("SELECT MAX(verified_at) AS at FROM orders WHERE UPPER(status) = 'PAID'"),
      one('SELECT MAX(received_at) AS at FROM bank_credits'),
      one("SELECT COUNT(*) AS n FROM subscriptions WHERE UPPER(COALESCE(fulfillment_status, '')) = 'MANUAL_PENDING' AND UPPER(status) = 'ACTIVE'"),
    ]);
    out.payments = { lastPaidOrderAt: paid.at || null, lastBankCreditAt: bank.at || null };
    out.pendingManualDeliveries = manual.n != null ? Number(manual.n) : null;
  }
  try { out.webhooks = require('./n8nhooks').status(); } catch (_) {}
  out.build = buildFingerprint();
  return out;
}

// ------------------------------------------------------------------ unsubscribe page
const escHtml = (v) => s(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + escHtml(title) + ' — FluxFilm</title><style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px}' +
    '.c{max-width:460px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px}h1{font-size:1.3rem;margin:0 0 8px}p{color:#475569;line-height:1.5}' +
    'button{display:block;width:100%;font-size:1rem;padding:14px;border-radius:12px;border:0;margin:10px 0;cursor:pointer;font-weight:700}.a{background:#e11d48;color:#fff}.b{background:#f1f5f9;color:#0f172a}' +
    'small{color:#94a3b8}</style></head><body><div class="c">' + body + '</div></body></html>';
}
function unsubPage(token, done) {
  if (done) {
    const msg = done.what === 'resubscribe' ? 'You will get FluxFilm offers again. Thank you! 💚'
      : done.what === 'all' ? 'You will not get offer emails or renewal reminder emails any more. You will still get emails about your orders and login details.'
        : 'You will not get offer emails any more. Renewal reminders for your plans still come, so your show never stops by surprise.';
    return page('Saved', '<h1>✅ Saved</h1><p>' + escHtml(msg) + '</p>' +
      (done.what !== 'resubscribe' ? '<form method="post" action="/unsubscribe"><input type="hidden" name="t" value="' + escHtml(token) + '"><button class="b" name="what" value="resubscribe">Changed your mind? Get offers again</button></form>' : '') +
      '<p><a href="' + escHtml(SITE()) + '">Open FluxFilm</a></p>');
  }
  return page('Email settings', '<h1>📭 FluxFilm emails</h1><p>Choose what you want to stop. Emails about your orders and login details always come.</p>' +
    '<form method="post" action="/unsubscribe"><input type="hidden" name="t" value="' + escHtml(token) + '">' +
    '<button class="a" name="what" value="offers">Stop offer emails</button>' +
    '<button class="b" name="what" value="all">Stop offers AND renewal reminder emails</button></form>' +
    '<small>Hindi: Offer emails band karne ke liye upar wala button dabayein.</small>');
}

// ------------------------------------------------------------------ routes
function mount(app, deps) {
  const d = deps || {};
  const audit = d.audit || require('./audit').makeAudit(db);
  const express = require('express');
  const failsByIp = security.rateLimiter(d.failLimit || 20, 15 * 60e3);
  const perKey = security.rateLimiter(d.keyLimit || 600, 10 * 60e3);
  const backupLimit = security.rateLimiter(d.backupLimit || 40, 10 * 60e3);
  const unsubLimit = security.rateLimiter(60, 15 * 60e3);
  const URL_KEY = /^(key|apikey|api_key|n8nkey|n8n_key|x-n8n-key|token|access_token)$/i;

  async function guard(req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const ip = security.clientIp(req);
    if (Object.keys(req.query || {}).some((k) => URL_KEY.test(k))) {
      audit.record(req, { action: 'n8n.refused', entity: 'n8n', id: req.path, summary: 'n8n call refused: key in the URL' });
      res.status(400).json({ ok: false, message: 'Keys in the URL are refused. Send the key in the X-N8N-Key header.' });
      return false;
    }
    if (failsByIp.count(ip) >= (d.failLimit || 20)) { res.set('Retry-After', '900'); res.status(429).json({ ok: false, rateLimited: true, message: 'Too many wrong keys. Wait 15 minutes.' }); return false; }
    const given = req.headers['x-n8n-key'];
    let good = false;
    try { good = await checkKey(given); } catch (e) { res.status(503).json({ ok: false, message: 'Settings unavailable: ' + e.message }); return false; }
    if (!good) {
      failsByIp.hit(ip);
      res.status(401).json({ ok: false, message: given ? 'Wrong n8n key (it may have been rotated or revoked in admin → 🔗 Integrations).' : 'Missing X-N8N-Key header.' });
      return false;
    }
    const lim = perKey.hit('key');
    if (!lim.ok) { res.set('Retry-After', String(lim.retryAfterSec)); res.status(429).json({ ok: false, rateLimited: true, message: 'Too many n8n calls — wait ' + Math.ceil(lim.retryAfterSec / 60) + ' min.' }); return false; }
    touchKey(ip);
    return true;
  }
  // Compact: one line per call. Healthy /health checks (the uptime workflow asks every 5 minutes) are folded into one
  // line per hour ("+11 more"), so the change log is not flooded; any non-200 health answer is logged at once.
  const healthFold = { hour: '', more: 0 };
  const logCall = (req, status, note) => {
    if (req.path === '/n8n/api/health' && status === 200) {
      const hour = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 13);
      if (healthFold.hour === hour) { healthFold.more++; return; }
      if (healthFold.more) note = (note ? note + ' · ' : '') + '+' + healthFold.more + ' more health checks in the hour before';
      healthFold.hour = hour; healthFold.more = 0;
    }
    const q = Object.entries(req.query || {}).map(([k, v]) => k + '=' + s(v).slice(0, 40)).join(' ');
    audit.record(req, { action: 'n8n.api', entity: 'n8n', id: req.method + ' ' + req.path, summary: (req.method + ' ' + req.path + (q ? ' ' + q : '') + ' → ' + status + (note ? ' · ' + note : '')).slice(0, 300) });
  };
  const handler = (fn) => async (req, res) => {
    if (!(await guard(req, res))) return;
    if (!db.ENABLED) { logCall(req, 503, 'no database'); return res.status(503).json({ ok: false, message: 'Database not configured.' }); }
    try {
      const out = await fn(req, res);
      if (out === undefined) return; // streamed
      const status = out.status || (out.ok === false ? 400 : 200);
      const body = Object.assign({}, out); delete body.status;
      logCall(req, status, out.count != null ? out.count + ' items' : out.already != null ? (out.already ? 'already recorded' : 'recorded') : '');
      res.status(status).json(body);
    } catch (e) {
      console.log('[n8n] ' + req.path + ' failed:', e.message);
      logCall(req, 500, String(e.message).slice(0, 120));
      if (!res.headersSent) res.status(500).json({ ok: false, message: 'Server error: ' + String(e.message).slice(0, 200) });
    }
  };

  app.get('/n8n/api/expiring', handler((req) => expiring(req.query)));
  app.post('/n8n/api/reminder-sent', handler((req) => reminderSent(req.body)));
  app.get('/n8n/api/winback', handler((req) => winback(req.query)));
  app.post('/n8n/api/winback-sent', handler((req) => winbackSent(req.body)));
  app.get('/n8n/api/posts/new', handler((req) => postsNew(req.query)));
  app.get('/n8n/api/health', handler(async () => { const h = await health(); return Object.assign({}, h, { status: 200, health: h.status }); }));
  const backup = d.backup || require('./n8nbackup');
  app.get('/n8n/api/backup/tables', handler(async () => backup.tableList()));
  app.get('/n8n/api/backup', handler(async (req, res) => {
    const lim = backupLimit.hit('backup');
    if (!lim.ok) return { ok: false, status: 429, message: 'Too many backup downloads — wait a few minutes.' };
    const r = await backup.prepare({ table: req.query.table });
    if (!r.ok) return r;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + r.filename + '"');
    res.set('X-Accel-Buffering', 'no');
    res.set('X-FF-Backup-Rows', String(r.totalRows));
    const t0 = Date.now();
    try {
      const done = await backup.stream(r, res);
      logCall(req, 200, 'backup ' + r.filename + ' · ' + done.rows + ' rows · ' + done.bytes + ' bytes · ' + (Date.now() - t0) + ' ms');
    } catch (e) {
      console.log('[n8n] backup stream failed:', e.message);
      logCall(req, 500, 'backup failed: ' + String(e.message).slice(0, 100));
      if (!res.headersSent) res.status(500).json({ ok: false, message: 'Backup failed: ' + e.message }); else res.destroy(e);
    }
    return undefined;
  }));
  // Anything else under /n8n/api: JSON 404 (never the storefront page).
  app.all('/n8n/api/*', (req, res) => res.status(404).json({ ok: false, message: 'Unknown n8n endpoint.' }));

  // ---- customer opt-out (no login: the token is the proof)
  app.get('/unsubscribe', async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const t = s(req.query.t);
    const ph = db.ENABLED ? await readUnsubToken(t).catch(() => null) : null;
    if (!ph) return res.status(400).type('html').send(page('Link not valid', '<h1>Link not valid</h1><p>This unsubscribe link is broken or too old. Reply to any FluxFilm email and we will stop the emails for you.</p>'));
    res.type('html').send(unsubPage(t));
  });
  app.post('/unsubscribe', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const lim = unsubLimit.hit(security.clientIp(req));
    if (!lim.ok) return res.status(429).type('html').send(page('Please wait', '<h1>Please wait</h1><p>Too many tries. Try again in a few minutes.</p>'));
    const b = req.body || {};
    const t = s(b.t || req.query.t);
    // One-click unsubscribe (RFC 8058 List-Unsubscribe-Post) sends no "what": that means offers.
    const what = ['offers', 'all', 'resubscribe'].includes(s(b.what)) ? s(b.what) : 'offers';
    const ph = db.ENABLED ? await readUnsubToken(t).catch(() => null) : null;
    if (!ph) return res.status(400).type('html').send(page('Link not valid', '<h1>Link not valid</h1><p>This unsubscribe link is broken or too old.</p>'));
    try {
      await setOptOut(ph, what);
      audit.record(req, { action: 'n8n.unsubscribe', entity: 'customer', id: '…' + ph.slice(-4), summary: 'Customer email choice: ' + what });
      res.type('html').send(unsubPage(t, { what }));
    } catch (e) {
      console.log('[n8n] unsubscribe failed:', e.message);
      res.status(500).type('html').send(page('Try again', '<h1>Something went wrong</h1><p>Please try again, or reply to any FluxFilm email.</p>'));
    }
  });
}

module.exports = {
  mount, EVENTS, CHANNELS, DEFAULT_WINBACK, SETTINGS_KEY, SECRETS_KEY, OPTOUT_PREFIX, KEY_PREFIX,
  getSettings, saveSettingsRaw, getSecrets, saveSecrets, validateWebhookUrl, validateWinback,
  generateKey, revokeKey, checkKey, keyHash, publicKeyInfo,
  unsubToken, readUnsubToken, unsubUrl, setOptOut,
  expiring, reminderSent, winback, winbackSent, postsNew, postItem, livePosts, health, buildFingerprint, firstName, setIndexPath,
  _internal: { istYmd, istStamp, addDaysYmd, dbMs, e164, rr, parseExpiringQuery, renewUrl, offerText, couponSettingsFor, absUrl, priceFor, reset: () => { _settingsCache = null; _unsubKey = null; _lastUsedSaved = 0; _rr = null; } },
};
