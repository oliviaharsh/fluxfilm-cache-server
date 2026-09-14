/**
 * FluxFilm - customers' own profile photos (Account → Profile → 📷 Upload your photo).
 *
 * Storage: table customer_photos (db/schema-v20.sql), one row per phone. Each upload gets a NEW random
 * photo_id, so the public URL /profile-photo/<photo_id>?v=<time> never contains the phone number and an old
 * photo's link stops working as soon as it is replaced or removed.
 *
 * The browser crops + re-encodes the picture on a canvas (square, ~256 px JPEG, no EXIF/location). The server
 * still checks the type, the size and the file's first bytes (magic numbers), refuses SVG, and strips any
 * JPEG metadata segments (APP1..APP15 / comments) that might have slipped through.
 *
 * Verification matches the existing avatar update (updateCustomerProfilePic): the phone must belong to an
 * existing customer; the /api rate limits apply per IP and per phone (server.js).
 *
 * Fails soft: until schema-v20 is run, uploading answers "coming soon" (notReady) and avatars keep working.
 */
const crypto = require('crypto');
const db = require('./db');
const reads = require('./reads');

const MAX_BYTES = 80 * 1024;             // decoded picture (the browser aims for <= 60 KB)
const MAX_DATAURL = 120 * 1024;          // base64 text length before decoding
const TYPES = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const URL_PREFIX = '/profile-photo/';
const NOT_READY = 'Uploading your own photo is coming soon. You can pick an avatar for now.';

function s(v) { return String(v == null ? '' : v).trim(); }
function normPhone(p) { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function nowSheet() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function missingTable(e) { return !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || /doesn't exist|no such table/i.test(String(e.message || ''))); }
function isPhotoUrl(u) { return s(u).indexOf(URL_PREFIX) === 0; }

/** What the first bytes say the file is ('' = not an allowed picture). */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/** Drop JPEG metadata (EXIF/XMP = APP1..APP15, comments) before the image data. Returns the input if unsure. */
function stripJpegMeta(buf) {
  try {
    if (sniff(buf) !== 'image/jpeg') return buf;
    const out = [buf.slice(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return buf;
      const marker = buf[i + 1];
      if (marker === 0xda) { out.push(buf.slice(i)); return Buffer.concat(out); } // start of scan: rest is image data
      const len = buf.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > buf.length) return buf;
      const meta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
      if (!meta) out.push(buf.slice(i, i + 2 + len));
      i += 2 + len;
    }
    return buf;
  } catch (_) { return buf; }
}

/** Checks a data URL from the browser. { ok, mime, buf } or { ok:false, message }. */
function parseDataUrl(dataUrl) {
  const v = typeof dataUrl === 'string' ? dataUrl : '';
  if (!v) return { ok: false, message: 'Please choose a photo.' };
  if (v.length > MAX_DATAURL) return { ok: false, message: 'That photo is too big. Please try another one.' };
  const m = v.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return { ok: false, message: 'Please upload a JPG, PNG or WebP photo.' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return { ok: false, message: 'That photo is too big. Please try another one.' };
  if (sniff(buf) !== m[1]) return { ok: false, message: 'That file is not a real photo. Please try another one.' };
  return { ok: true, mime: m[1], buf: m[1] === 'image/jpeg' ? stripJpegMeta(buf) : buf };
}

async function profileOf(ph) {
  const r = await reads.getCustomerProfile(ph);
  if (!r || r.ok === false) return null;
  const out = Object.assign({}, r); delete out.ok; return out;
}

/** Point customers.profile_pic_url (+ raw_json ProfilePicUrl) at `url` — same write as the avatar picker. */
async function setPicUrl(ph, raw, url) {
  raw.ProfilePicUrl = url;
  raw.UpdatedAt = nowSheet();
  raw.lastActivity = raw.UpdatedAt;
  await db.query('UPDATE customers SET profile_pic_url = ?, updated_at = NOW(), raw_json = ? WHERE phone_norm = ? LIMIT 1', [url, JSON.stringify(raw), ph]);
}

async function setProfilePhoto(phone, dataUrl) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone required' };
  const pic = parseDataUrl(dataUrl);
  if (!pic.ok) return pic;
  const rows = await db.query('SELECT raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!rows.length) return { ok: false, message: 'Customer not found' };

  const photoId = crypto.randomBytes(12).toString('hex');
  try {
    await db.query(
      'INSERT INTO customer_photos (phone_norm, photo_id, mime, data, updated_at) VALUES (?, ?, ?, ?, NOW())' +
      ' ON DUPLICATE KEY UPDATE photo_id = VALUES(photo_id), mime = VALUES(mime), data = VALUES(data), updated_at = NOW()',
      [ph, photoId, pic.mime, pic.buf]);
  } catch (e) {
    if (missingTable(e)) return { ok: false, notReady: true, message: NOT_READY };
    throw e;
  }
  const url = URL_PREFIX + photoId + '?v=' + Date.now().toString(36);
  await setPicUrl(ph, rawOf(rows[0].raw_json), url);
  return { ok: true, profilePicUrl: url, profile: await profileOf(ph) };
}

/** Delete the uploaded photo; the profile goes back to the letter / avatar (`fallbackUrl`, if one was picked). */
async function removeProfilePhoto(phone, fallbackUrl) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone required' };
  const rows = await db.query('SELECT raw_json, profile_pic_url FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!rows.length) return { ok: false, message: 'Customer not found' };
  await forget(ph);
  const fb = s(fallbackUrl);
  const next = fb && !isPhotoUrl(fb) && /^https:\/\/api\.dicebear\.com\//.test(fb) ? fb : '';
  if (isPhotoUrl(rows[0].profile_pic_url) || next) await setPicUrl(ph, rawOf(rows[0].raw_json), next);
  return { ok: true, profilePicUrl: next || (isPhotoUrl(rows[0].profile_pic_url) ? '' : s(rows[0].profile_pic_url)), profile: await profileOf(ph) };
}

/** Remove the stored photo row (no-op before schema-v20). Used when the customer picks an avatar instead. */
async function forget(phone) {
  const ph = normPhone(phone);
  if (!ph) return;
  try { await db.query('DELETE FROM customer_photos WHERE phone_norm = ?', [ph]); }
  catch (e) { if (!missingTable(e)) throw e; }
}

/** For GET /profile-photo/:id → { type, buf } or null. */
async function image(photoId) {
  const id = s(photoId);
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  let rows;
  try { rows = await db.query('SELECT mime, data FROM customer_photos WHERE photo_id = ? LIMIT 1', [id]); }
  catch (e) { if (missingTable(e)) return null; throw e; }
  if (!rows.length || !TYPES[rows[0].mime]) return null;
  const buf = Buffer.isBuffer(rows[0].data) ? rows[0].data : Buffer.from(rows[0].data || '');
  return buf.length ? { type: rows[0].mime, buf } : null;
}

module.exports = { setProfilePhoto, removeProfilePhoto, forget, image, isPhotoUrl, _internal: { parseDataUrl, sniff, stripJpegMeta, MAX_BYTES, NOT_READY } };
