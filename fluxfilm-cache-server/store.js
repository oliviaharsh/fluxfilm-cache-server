/**
 * FluxFilm - maintenance / pause switch (admin → 🚧 Maintenance, stored in app_settings 'store').
 *
 * While paused, customers can still open the site, log in, see plans, their subscriptions and orders, edit
 * their profile, recover access and use Get OTP — but no NEW order or renewal can be created.
 * Orders that already exist can still be paid, verified and delivered (someone may be mid-payment).
 *
 *   getStatus()          → { ok, paused, message, backText, since, helpBubble } (public, storefront polls it)
 *   helpBubble (default ON): the small floating 💬 Help bubble on Home / My plans / Account; OFF = only the top Help button.
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
  helpBubble: true,
  // 🔐 Email login required (customerauth.js). ON = private actions need a signed session from an email code.
  // OFF = emergency switch back to the old phone-only login (every change is in the admin change log).
  emailLogin: true,
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
  if (inb.helpBubble !== undefined) out.helpBubble = !(inb.helpBubble === false || inb.helpBubble === 0 || /^(false|0|off)$/i.test(s(inb.helpBubble)));
  if (inb.emailLogin !== undefined) out.emailLogin = !(inb.emailLogin === false || inb.emailLogin === 0 || /^(false|0|off)$/i.test(s(inb.emailLogin)));
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
  const changed = ['paused', 'message', 'backText', 'helpBubble', 'emailLogin'].filter((k) => String(before[k]) !== String(next[k]));
  return { ok: true, settings: next, before, changed };
}

async function getStatus() {
  const c = await getSettings();
  return { ok: true, paused: !!c.paused, message: c.paused ? c.message : '', backText: c.paused ? c.backText : '', since: c.paused ? c.since : '', helpBubble: c.helpBubble !== false, emailLogin: c.emailLogin !== false };
}

/** 🔐 Is the email login switched on? Fails CLOSED (on) when the setting can't be read. */
async function emailLoginRequired() {
  try { return (await getSettings()).emailLogin !== false; } catch (e) { return true; }
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

module.exports = { DEFAULTS, validateSettings, getSettings, saveSettings, getStatus, guard, emailLoginRequired, _internal: { reset: () => { cache = null; } } };
