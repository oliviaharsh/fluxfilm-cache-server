/**
 * FluxFilm - automatic renewal reminders by push notification (admin → 🔔 Notifications).
 *
 * Settings: app_settings 'push_settings' (no schema change). Sends only to customers who switched reminders on
 * (push_subscriptions, schema-v18), only between the quiet-hours window (India time), and never twice:
 * every send is logged in reminder_log (channel 'PUSH', kind, expiry_date) and checked before sending.
 *
 *   Kinds: BEFORE_<n> (n days before expiry, default 3 and 1) · EXPIRY_DAY · AFTER_1 (the day after)
 *   Not sent when the plan was renewed (expiry moved → different expiry_date / days) or the customer has a newer
 *   active plan for the same service.
 *
 *   run(now)                 → { ok, skipped?, checked, sent, alreadySent, renewed, noDevice }   (hourly + 60 s after start)
 *   notifyDelivered(payload) → fire-and-forget "🎬 Your Netflix access is ready" (fulfill.js afterFulfillHook)
 *   getSettings() · saveSettings(input) · render(template, vars)
 */
const db = require('./db');
const push = require('./push');

const KEY = 'push_settings';
const DEFAULTS = {
  auto: true,
  daysBefore: [3, 1],
  onExpiryDay: true,
  afterExpiry: true,
  delivered: true,
  quietStart: 9,
  quietEnd: 21,
  templates: {
    beforeTitle: '⏰ Your {service} plan ends in {days}',
    beforeBody: 'It ends on {date}. Renew in 1 tap and keep watching without a break.',
    todayTitle: '⚠️ Your {service} plan ends today',
    todayBody: 'Renew now in 1 tap so your {plan} plan keeps working.',
    afterTitle: '😟 Your {service} plan ended yesterday',
    afterBody: 'Renew now to keep your profile and your watch history.',
    deliveredTitle: '🎬 Your {service} access is ready',
    deliveredBody: 'Tap to open FluxFilm and see your login details.',
  },
};
const TPL_MAX = { Title: 80, Body: 200 };
const s = (v) => String(v == null ? '' : v).trim();
const clean = (v, max) => s(v).replace(/[<>]/g, '').slice(0, max);
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

async function getSettings() {
  let raw = null;
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]); raw = r.length ? r[0].value : null; }
  catch (e) { if (!missingTable(e)) throw e; }
  let saved = {};
  try { saved = JSON.parse(raw || '{}') || {}; } catch (_) { saved = {}; }
  return Object.assign({}, DEFAULTS, saved, { templates: Object.assign({}, DEFAULTS.templates, saved.templates || {}) });
}

function validate(input, current) {
  const i = input || {}; const cur = current || DEFAULTS; const errors = [];
  const bool = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === 1 || v === '1');
  const out = {
    auto: bool(i.auto, cur.auto), onExpiryDay: bool(i.onExpiryDay, cur.onExpiryDay), afterExpiry: bool(i.afterExpiry, cur.afterExpiry), delivered: bool(i.delivered, cur.delivered),
  };
  let days = i.daysBefore === undefined ? cur.daysBefore : i.daysBefore;
  if (!Array.isArray(days)) days = s(days).split(/[\s,]+/);
  days = [...new Set(days.map((d) => parseInt(d, 10)).filter((d) => d >= 1 && d <= 30))].sort((a, b) => b - a);
  if (days.length > 5) errors.push('At most 5 reminder days.');
  out.daysBefore = days.slice(0, 5);
  const hour = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  out.quietStart = hour(i.quietStart, cur.quietStart); out.quietEnd = hour(i.quietEnd, cur.quietEnd);
  if (out.quietStart < 0 || out.quietStart > 23 || out.quietEnd < 1 || out.quietEnd > 24 || out.quietStart >= out.quietEnd) errors.push('Sending hours must be like 9 to 21 (start before end).');
  out.templates = {};
  const t = i.templates || {};
  for (const k of Object.keys(DEFAULTS.templates)) {
    const max = /Title$/.test(k) ? TPL_MAX.Title : TPL_MAX.Body;
    out.templates[k] = t[k] === undefined ? (cur.templates || DEFAULTS.templates)[k] : clean(t[k], max);
    if (/Title$/.test(k) && !out.templates[k]) out.templates[k] = DEFAULTS.templates[k];
  }
  return { ok: !errors.length, settings: out, errors };
}
async function saveSettings(input) {
  const cur = await getSettings();
  const v = validate(input, cur);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  const changed = Object.keys(v.settings).filter((k) => JSON.stringify(v.settings[k]) !== JSON.stringify(cur[k]));
  try { await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(v.settings)]); }
  catch (e) { if (missingTable(e)) return { ok: false, message: 'Run db/schema-v15.sql first (settings table).' }; throw e; }
  return { ok: true, settings: v.settings, changed };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(v) { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MON[+m[2] - 1] : s(v); }
function render(tpl, vars) {
  const x = vars || {};
  const days = Number(x.days);
  const map = { service: s(x.service) || 'FluxFilm', plan: s(x.plan), days: Number.isFinite(days) ? Math.abs(days) + (Math.abs(days) === 1 ? ' day' : ' days') : '', date: prettyDate(x.date) };
  return s(tpl).replace(/\{(service|plan|days|date)\}/g, (_, k) => map[k]).replace(/\s{2,}/g, ' ').trim();
}

// India time, without trusting the server TZ.
function ist(now) {
  const d = new Date((now || new Date()).getTime() + 330 * 60000);
  const ymd = d.toISOString().slice(0, 10);
  return { ymd, hour: d.getUTCHours() };
}
function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysLeft(expiry, now) {
  const m = s(expiry).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  return Math.round((Date.parse(m[1] + 'T00:00:00Z') - Date.parse(ist(now).ymd + 'T00:00:00Z')) / 86400000);
}
function inSendingHours(settings, now) { const h = ist(now).hour; return h >= settings.quietStart && h < settings.quietEnd; }
function kindFor(left, settings) {
  if (left == null) return null;
  if (left > 0 && settings.daysBefore.includes(left)) return 'BEFORE_' + left;
  if (left === 0 && settings.onExpiryDay) return 'EXPIRY_DAY';
  if (left === -1 && settings.afterExpiry) return 'AFTER_1';
  return null;
}
function messageFor(kind, sub, settings) {
  const t = settings.templates;
  const vars = { service: sub.service, plan: sub.plan, days: daysLeftFromKind(kind), date: sub.expiry_date };
  const pick = kind === 'EXPIRY_DAY' ? 'today' : kind === 'AFTER_1' ? 'after' : 'before';
  return { title: render(t[pick + 'Title'], vars), body: render(t[pick + 'Body'], vars), url: '/?source=push&renew=' + encodeURIComponent(sub.sub_id), tag: 'renew-' + String(sub.sub_id).replace(/[^\w-]/g, '') };
}
function daysLeftFromKind(kind) { const m = /^BEFORE_(\d+)$/.exec(kind); return m ? Number(m[1]) : kind === 'AFTER_1' ? 1 : 0; }

async function logSend(subId, kind, expiry, ok, note) {
  try { await db.query('INSERT INTO reminder_log (ts, sub_id, channel, kind, expiry_date, ok, note) VALUES (NOW(), ?, ?, ?, ?, ?, ?)', [s(subId).slice(0, 40), 'PUSH', kind, expiry || null, ok ? 1 : 0, s(note).slice(0, 300) || null]); return true; }
  catch (e) { if (!missingTable(e)) console.log('[push] reminder_log write failed:', e.message); return false; }
}
async function alreadySent(subId, kind, expiry) {
  const r = await db.query("SELECT 1 AS x FROM reminder_log WHERE sub_id = ? AND channel = 'PUSH' AND kind = ? AND expiry_date = ? LIMIT 1", [subId, kind, expiry]);
  return r.length > 0;
}

let running = false;
async function run(now) {
  if (running) return { ok: true, skipped: 'already running' };
  running = true;
  try {
    const at = now || new Date();
    const settings = await getSettings();
    if (!settings.auto) return { ok: true, skipped: 'off' };
    if (!inSendingHours(settings, at)) return { ok: true, skipped: 'quiet hours' };
    const today = ist(at).ymd;
    const maxBefore = Math.max(0, ...settings.daysBefore);
    const from = addDaysYmd(today, -1) + ' 00:00:00';
    const to = addDaysYmd(today, maxBefore + 1) + ' 00:00:00';
    let rows;
    // F1: a purchase with separate logins has one row per login — remind once, through its first row.
    const groupsOn = await require('./devicelogins').groupsReady(db.query);
    try {
      rows = await db.query(
        'SELECT s.sub_id, s.phone_norm, s.service, s.plan, s.expiry_date, s.status, ' + (groupsOn ? 's.group_index, ' : '') +
        "EXISTS (SELECT 1 FROM subscriptions n WHERE n.phone_norm = s.phone_norm AND n.service = s.service AND n.sub_id <> s.sub_id AND n.expiry_date > s.expiry_date AND UPPER(n.status) = 'ACTIVE') AS has_newer " +
        "FROM subscriptions s WHERE s.expiry_date >= ? AND s.expiry_date < ? AND UPPER(COALESCE(s.status, '')) IN ('ACTIVE', 'EXPIRED') " +
        "AND s.phone_norm IN (SELECT p.phone_norm FROM push_subscriptions p WHERE p.disabled = 0 AND p.phone_norm <> '') ORDER BY s.expiry_date LIMIT 2000",
        [from, to]);
    } catch (e) {
      if (missingTable(e)) return { ok: true, skipped: 'schema-v18 not run' };
      throw e;
    }
    const out = { ok: true, checked: rows.length, sent: 0, alreadySent: 0, renewed: 0, noDevice: 0, failed: 0 };
    for (const sub of rows) {
      if (groupsOn && Number(sub.group_index) > 1) continue; // same purchase as its Device 1 row
      const kind = kindFor(daysLeft(sub.expiry_date, at), settings);
      if (!kind) continue;
      // Reminders before / on the day are for plans still running; "ended yesterday" also for ones already marked EXPIRED.
      if (kind !== 'AFTER_1' && String(sub.status).toUpperCase() !== 'ACTIVE') continue;
      if (Number(sub.has_newer) === 1) { out.renewed++; continue; }
      let dup;
      try { dup = await alreadySent(sub.sub_id, kind, sub.expiry_date); }
      catch (e) { if (missingTable(e)) return Object.assign(out, { skipped: 'schema-v14 not run (reminder_log)' }); throw e; }
      if (dup) { out.alreadySent++; continue; }
      const r = await push.sendToPhone(sub.phone_norm, messageFor(kind, sub, settings), { ttl: 12 * 3600 });
      if (!r.devices) { out.noDevice++; continue; }
      await logSend(sub.sub_id, kind, sub.expiry_date, r.sent > 0, r.sent + '/' + r.devices + ' devices' + (r.removed ? ', ' + r.removed + ' removed' : ''));
      if (r.sent > 0) out.sent++; else out.failed++;
    }
    if (out.sent || out.failed) console.log('[push] renewal reminders', JSON.stringify(out));
    return out;
  } finally { running = false; }
}

// "Your access is ready" when a plan is delivered. Never throws, never blocks delivery.
function notifyDelivered(p) {
  const x = p || {};
  if (x.manual || !x.phone) return Promise.resolve({ ok: true, skipped: true });
  return (async () => {
    const settings = await getSettings();
    if (!settings.delivered) return { ok: true, skipped: 'off' };
    const vars = { service: x.service, plan: x.plan, date: x.expiry };
    const r = await push.sendToPhone(x.phone, { title: render(settings.templates.deliveredTitle, vars), body: render(settings.templates.deliveredBody, vars), url: '/?source=push', tag: 'delivered-' + s(x.orderId).replace(/[^\w-]/g, '') }, { urgency: 'high' });
    return r;
  })().catch((e) => { console.log('[push] delivered notification failed:', e.message); return { ok: false }; });
}

let timer = null;
function startTimer() {
  if (timer) return;
  const tick = () => run().catch((e) => console.log('[push] reminders failed:', e.message));
  const first = setTimeout(tick, 60e3);
  if (first.unref) first.unref();
  timer = setInterval(tick, 60 * 60e3);
  if (timer.unref) timer.unref();
}

module.exports = { run, notifyDelivered, getSettings, saveSettings, validate, render, startTimer, DEFAULTS, _internal: { ist, daysLeft, kindFor, inSendingHours, messageFor } };
