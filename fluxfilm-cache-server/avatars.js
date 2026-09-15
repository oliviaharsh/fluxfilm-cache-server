/**
 * FluxFilm - "✨ Create your avatar" (Account → Profile). The drawing code is avatarmaker.js (shared with the browser).
 *
 * Save: /api setAvatar [phone, config]. The config is checked strictly (known keys + known choices only,
 * ≤ 600 characters as JSON) and turned into a short code. We store:
 *   customers.profile_pic_url  = /avatar/<code>.svg       (typed column, like the other avatars)
 *   raw_json.ProfilePicUrl     = the same link            (kept in sync)
 *   raw_json.AvatarConfig      = the checked config       (kept even if the customer later picks a photo,
 *                                                            so "Edit my avatar" starts from it)
 * No schema change. The SVG is drawn by the server from the code on GET /avatar/<code>.svg — the browser
 * never sends SVG. Choosing the creator avatar replaces an uploaded photo, same as picking any avatar.
 */
const db = require('./db');
const reads = require('./reads');
const maker = require('./avatarmaker');

function s(v) { return String(v == null ? '' : v).trim(); }
function normPhone(p) { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function nowSheet() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function setAvatar(phone, config) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone required' };
  const v = maker.validate(config);
  if (!v.ok) return v;
  const url = maker.url(v.config);
  const rows = await db.query('SELECT raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!rows.length) return { ok: false, message: 'Customer not found' };
  const raw = rawOf(rows[0].raw_json);
  raw.ProfilePicUrl = url;
  raw.AvatarConfig = v.config;
  raw.UpdatedAt = nowSheet();
  raw.lastActivity = raw.UpdatedAt;
  await db.query('UPDATE customers SET profile_pic_url = ?, updated_at = NOW(), raw_json = ? WHERE phone_norm = ? LIMIT 1', [url, JSON.stringify(raw), ph]);
  try { await require('./photos').forget(ph); } catch (e) { console.log('[avatars] could not delete old photo:', e.message); }
  const prof = await reads.getCustomerProfile(ph);
  const profile = prof && prof.ok !== false ? Object.assign({}, prof) : null;
  if (profile) delete profile.ok;
  return { ok: true, profilePicUrl: url, avatarConfig: v.config, profile };
}

/** The saved config from raw_json (null if none / no longer valid). */
function configFromRaw(raw) {
  const c = raw && raw.AvatarConfig;
  if (!c || typeof c !== 'object') return null;
  const v = maker.validate(c);
  return v.ok ? v.config : null;
}

/** GET /avatar/:file → { svg } or null. Only '<16 base-36 chars>.svg' codes that decode exactly. */
function render(file) {
  const m = /^([0-9a-z]{16})\.svg$/.exec(s(file));
  const cfg = m && maker.decode(m[1]);
  return cfg ? maker.svg(cfg) : null;
}

module.exports = { setAvatar, configFromRaw, render, isAvatarUrl: (u) => !!maker.fromUrl(u) };
