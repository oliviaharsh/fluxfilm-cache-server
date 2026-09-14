/**
 * FluxFilm - maintenance / pause switch (admin → 🚧 Maintenance, stored in app_settings 'store').
 *
 * While paused, customers can still open the site, log in, see plans, their subscriptions and orders, edit
 * their profile, recover access and use Get OTP — but no NEW order or renewal can be created.
 * Orders that already exist can still be paid, verified and delivered (someone may be mid-payment).
 *
 *   getStatus()          → { ok, paused, message, backText, since }          (public, storefront polls it)
 *   guard()              → null, or { ok:false, paused:true, message }         (createOrder / createRenewOrder)
 *   saveSettings(input)  → { ok, settings, changed }                            (admin)
 */
const db = require('./db');

const KEY = 'store';
const s = (v) => String(v == null ? '' : v).trim();
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

const DEFAULTS = Object.freeze({
  paused: false,
  message: 'We are upgrading FluxFilm to make it faster and better. Please come back in a little while.',
  backText: '',
  since: '',
});

function validateSettings(input, prev) {
  const inb = input || {}; const errors = [];
  const out = Object.assign({}, DEFAULTS, prev || {});
  if (inb.paused !== undefined) out.paused = inb.paused === true || inb.paused === 1 || s(inb.paused).toLowerCase() === 'true';
  if (inb.message !== undefined) {
    const m = s(inb.message).replace(/[<>]/g, '');
    if (m.length > 300) errors.push('Message must be 300 characters or less.');
    else out.message = m || DEFAULTS.message;
  }
  if (inb.backText !== undefined) {
    const b = s(inb.backText).replace(/[<>]/g, '');
    if (b.length > 60) errors.push('"Back by" must be 60 characters or less (example: in 30 minutes).');
    else out.backText = b;
  }
  return { ok: !errors.length, settings: out, errors };
}

let cache = null; let cacheAt = 0;
async function getSettings(fresh) {
  // Short cache: a pause must take effect within seconds.
  if (!fresh && cache && Date.now() - cacheAt < 5e3) return cache;
  let saved = {};
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]);
    if (rows.length) { try { saved = JSON.parse(rows[0].value) || {}; } catch (_) { saved = {}; } }
  } catch (e) { if (!missingTable(e)) throw e; }
  cache = validateSettings(saved).settings; cacheAt = Date.now();
  return cache;
}

async function saveSettings(input) {
  const before = await getSettings(true);
  const v = validateSettings(input, before);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  const next = v.settings;
  if (next.paused && !before.paused) next.since = new Date().toISOString();
  if (!next.paused) next.since = '';
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(next)]);
  cache = null;
  const changed = ['paused', 'message', 'backText'].filter((k) => String(before[k]) !== String(next[k]));
  return { ok: true, settings: next, before, changed };
}

async function getStatus() {
  const c = await getSettings();
  return { ok: true, paused: !!c.paused, message: c.paused ? c.message : '', backText: c.paused ? c.backText : '', since: c.paused ? c.since : '' };
}

/** Called before creating any new order. Fails OPEN on a database hiccup (the order code has its own checks). */
async function guard() {
  let c;
  try { c = await getSettings(); } catch (e) { console.log('[store] status check failed:', e.message); return null; }
  if (!c.paused) return null;
  return {
    ok: false, paused: true,
    message: '🚧 New orders are paused for a short maintenance. ' + (c.backText ? 'Please come back ' + c.backText + '.' : 'Please try again in a little while.') + ' Your plans are safe.',
  };
}

module.exports = { DEFAULTS, validateSettings, getSettings, saveSettings, getStatus, guard, _internal: { reset: () => { cache = null; } } };
