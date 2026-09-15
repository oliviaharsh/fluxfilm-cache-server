/**
 * FluxFilm - proof that the person asking for a login OTP is the customer (Get OTP tool).
 *
 * WHO MAY USE GET OTP (owner, 15 Sep 2026 - same rules as Recover):
 *   - only for an ACTIVE purchase: its expiry DATE is today or later in India (expiry today = active all day),
 *     and no device row of that purchase is refunded, cancelled or removed;
 *   - the email code goes only to an email the customer types that belongs to THAT purchase: the email saved on
 *     its subscription row, or the email of the PAID + FULFILLED order that created it (matched by order_id).
 *     The customers-table profile email and CREATED / PENDING orders never count: anyone can write those
 *     without logging in. An email only unlocks the purchases it belongs to.
 *   - every "no" gets the same NO_ACTIVE message (no masked email hints, no "no plan" vs "wrong email").
 *
 *   sendGetOtpCode(phone, email)          -> { ok } or { ok:false, noActive, message }
 *   verifyGetOtpCode(phone, email, code)  -> { ok, token, expiresAt }   (5 tries per code, 10 min)
 *   checkGetOtp(phone, token)             -> { ok, eh } or { ok:false, needsVerify, message }
 *   unlockedForToken(phone, eh)           -> active purchases that the verified email unlocks
 *
 * Token: "otp2.<phone>.<email HMAC>.<expiry>.<HMAC>" (30 days, OTP_ACCESS_DAYS). Get OTP accepts ONLY otp2 tokens
 * and re-checks the purchase (active + email) on every request, so a refund / expiry / removal stops it at once.
 * Codes, attempt counts and the per-phone send cap live in app_settings ('gotp_…', codes hashed with HMAC), so a
 * restart does not reset them; every guess / send is claimed with INSERT or a compare-and-swap UPDATE (atomic).
 * If app_settings cannot be used, memory is the fallback (single Node process).
 *
 * LEGACY (Games prizes + UPI refunds still use it; NOT accepted by Get OTP any more):
 *   sendCode(phone, deps) / verifyCode(phone, code) / check(phone, token) / makeToken / verifyToken ("otp1" tokens).
 *   verifyToken also accepts an otp2 token (a stronger proof), so a Get OTP check covers those screens too.
 *   Replaced Get OTP code: _deleted-old-code/2026-09-15_getotp-profile-email/.
 */
const crypto = require('crypto');
const db = require('./db');

const CODE_TTL_MS = 10 * 60e3;
const RESEND_AFTER_MS = 45e3;
const MAX_TRIES = 5;
const SENDS_PER_HOUR = 6;
const TOKEN_DAYS = () => Math.min(90, Math.max(1, Number(process.env.OTP_ACCESS_DAYS || 30)));
const NO_ACTIVE = 'No active plan found for this number and email. Use the email you gave when you bought the plan. Need help? Tap Help.';
const NEEDS_VERIFY = 'For your safety, confirm it\'s you: type the email you used when you bought this plan, and we\'ll email you a 6-digit code.';
const codes = new Map(); // legacy: phone -> { hash, exp, tries }

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const normEmail = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
function maskEmail(e) {
  const [u, d] = s(e).split('@');
  if (!d) return '';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.min(6, Math.max(1, u.length - 2)))) + '@' + d;
}
function secret() {
  const e = process.env;
  if (s(e.OTP_ACCESS_SECRET)) return s(e.OTP_ACCESS_SECRET);
  const base = [e.IMAP_PASS, e.DB_PASS, e.CACHE_CLEAR_KEY, e.ADMIN_PASSWORD].map(s).join('|');
  return crypto.createHash('sha256').update('ff-otp-access|' + base).digest('hex');
}
const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');
const sameText = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

// ---- Get OTP secret: derived from server-only env (no new env var). OTP_ACCESS_SECRET, if set, is mixed in. ----
function secret2() {
  const e = process.env;
  const base = [e.DB_PASS, e.CACHE_CLEAR_KEY, e.IMAP_PASS, e.OTP_ACCESS_SECRET].map(s).join('|');
  return crypto.createHmac('sha256', 'ff-getotp-v2').update(base).digest();
}
const mac = (v) => crypto.createHmac('sha256', secret2()).update(String(v)).digest('hex');
const emailHash = (em) => mac('em|' + normEmail(em)).slice(0, 32);

// ---------------- dates: India calendar days ----------------
const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
/** 'YYYY-MM-DD' (India date) of a stored expiry, or '' when missing / unreadable. */
function expiryDay(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? IST_DAY.format(v) : '';
  const x = s(v);
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(x)) { const t = new Date(x); return Number.isFinite(t.getTime()) ? IST_DAY.format(t) : ''; }
  const m = x.match(/^(\d{4}-\d{2}-\d{2})/); // stored as India time
  return m ? m[1] : '';
}
const todayIST = (now) => IST_DAY.format(new Date(now || Date.now()));

// ---------------- which purchases an email unlocks ----------------
/** A device row that stops the whole purchase: refunded, cancelled, removed, or expiry date before today (India). */
function rowBlocked(r, now) {
  if (Number(r.removed) === 1) return true;
  const fs = up(r.fulfillment_status); const st = up(r.status);
  if (fs === 'REFUNDED' || fs === 'REMOVED' || /^CANCEL/.test(fs)) return true;
  if (st === 'REFUNDED' || st === 'REMOVED' || /^CANCEL/.test(st)) return true;
  // status EXPIRED alone does not stop it: subexpiry.js marks it soon after the expiry TIME, but that whole day still counts.
  const day = expiryDay(r.expiry_date);
  return !day || day < todayIST(now);
}

async function groupsReady() {
  try { return await require('./devicelogins').groupsReady(db.query); } catch (_) { return false; }
}
async function subRowsFor(ph, groupsOn) {
  const base = 'sub_id, order_id, email, service, login_id, expiry_date, status, fulfillment_status' + (groupsOn ? ', group_id, group_index' : '');
  try {
    return await db.query('SELECT ' + base + ', COALESCE(removed, 0) AS removed FROM subscriptions WHERE phone_norm = ?', [ph]);
  } catch (e) {
    if (!/removed/i.test(String(e && e.message))) throw e;
    return db.query('SELECT ' + base + ' FROM subscriptions WHERE phone_norm = ?', [ph]); // before schema-v13
  }
}

/**
 * Active purchases on this phone that the email unlocks. match(normalisedEmail) -> true when it is the customer's email.
 * Each item: { rows (Device 1 first), lead }.
 */
async function unlockedGroups(phone, match, now) {
  const ph = norm(phone);
  if (!ph || typeof match !== 'function') return [];
  const groupsOn = await groupsReady();
  const all = (await subRowsFor(ph, groupsOn)) || [];
  const byKey = new Map();
  for (const r of all) {
    const k = groupsOn && r.group_id ? 'g:' + r.group_id : 's:' + r.sub_id;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const active = [];
  for (const rows of byKey.values()) {
    rows.sort((a, b) => Number(a.group_index || 0) - Number(b.group_index || 0));
    if (rows.some((r) => rowBlocked(r, now))) continue;
    active.push({ rows, lead: rows[0], bySub: rows.some((r) => !!normEmail(r.email) && match(normEmail(r.email))) });
  }
  const needOrders = [...new Set(active.filter((g) => !g.bySub).flatMap((g) => g.rows.map((r) => s(r.order_id))).filter(Boolean))];
  const paidEmail = new Map();
  if (needOrders.length) {
    const rows = await db.query(
      'SELECT order_id, email FROM orders WHERE order_id IN (' + needOrders.map(() => '?').join(', ') + ") AND UPPER(status) = 'PAID' AND UPPER(fulfillment_status) = 'FULFILLED'",
      needOrders);
    for (const o of rows || []) paidEmail.set(s(o.order_id), normEmail(o.email));
  }
  return active.filter((g) => g.bySub || g.rows.some((r) => {
    const em = paidEmail.get(s(r.order_id));
    return !!em && match(em);
  }));
}

// ---------------- app_settings store (memory when the DB can't be used) ----------------
const mem = new Map(); // key -> JSON text
const codeKey = (ph, em) => 'gotp_c_' + mac('c|' + ph + '|' + em).slice(0, 40);
const sendKey = (ph) => 'gotp_n_' + mac('n|' + ph).slice(0, 40);
const codeHash = (ph, em, code) => mac('code|' + ph + '|' + em + '|' + code);
const parse = (raw) => { try { return JSON.parse(raw); } catch (_) { return null; } };
async function del(k) {
  mem.delete(k);
  try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [k]); } catch (_) { /* memory only */ }
}
let lastSweep = 0;
function sweep() {
  if (Date.now() - lastSweep < 10 * 60e3) return;
  lastSweep = Date.now();
  for (const [k, v] of mem) { const x = parse(v); if (!x || Date.now() > Number(x.exp)) mem.delete(k); }
  Promise.resolve().then(() => db.query('DELETE FROM app_settings WHERE setting_key LIKE ? AND updated_at < (NOW() - INTERVAL 2 HOUR)', ['gotp\\_%'])).catch(() => {});
}

/**
 * Atomic read-modify-write of one JSON record. fn(rec|null) -> { next, result } (write next) or { result } (no write).
 * DB: INSERT for a new key, else compare-and-swap UPDATE on the exact old text; read again when someone else won.
 * Memory fallback (DB unreachable): synchronous, so atomic inside this one Node process.
 */
async function atomic(k, fn) {
  for (let i = 0; i < 25; i++) {
    if (mem.has(k)) return memAtomic(k, fn); // this record lives in memory (the DB was down when it was made)
    let raw;
    try {
      const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [k]);
      raw = r && r[0] ? String(r[0].value) : null;
    } catch (_) { return memAtomic(k, fn); }
    const out = fn(raw == null ? null : parse(raw));
    if (!out.next) return out.result;
    const val = JSON.stringify(out.next);
    try {
      if (raw == null) {
        await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)', [k, val]);
        return out.result;
      }
      const res = await db.query('UPDATE app_settings SET value = ? WHERE setting_key = ? AND value = ?', [val, k, raw]);
      if (res && Number(res.affectedRows) === 1) return out.result;
    } catch (e) {
      if (raw == null && (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /duplicate/i.test(String(e.message))))) continue; // a parallel insert won
      return memAtomic(k, fn);
    }
  }
  return { busy: true };
}
function memAtomic(k, fn) {
  const cur = mem.get(k);
  const out = fn(cur ? parse(cur) : null);
  if (out.next) mem.set(k, JSON.stringify(out.next));
  return out.result;
}

// ---------------- Get OTP: send + verify ----------------
async function sendGetOtpCode(phone, email, deps) {
  const mailer = (deps && deps.mailer) || require('./mailer');
  const now = (deps && deps.now) || Date.now();
  sweep();
  const ph = norm(phone); const em = normEmail(email);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your 10-digit phone number (the one you bought with).' };
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return { ok: false, message: 'Enter a valid email address, like name@gmail.com.' };
  // Per-phone cap (wrong emails count too), kept in the DB so a restart does not reset it.
  const cap = await atomic(sendKey(ph), (rec) => {
    if (!rec || now > Number(rec.exp)) return { next: { n: 1, exp: now + 60 * 60e3 }, result: { ok: true } };
    if (Number(rec.n) >= SENDS_PER_HOUR) return { result: { ok: false } };
    return { next: { n: Number(rec.n) + 1, exp: rec.exp }, result: { ok: true } };
  });
  if (!cap || !cap.ok) return { ok: false, rateLimited: true, message: 'Too many tries for this number. Please wait an hour, or tap Help.' };
  const groups = await unlockedGroups(ph, (x) => x === em, now);
  if (!groups.length) return { ok: false, noActive: true, message: NO_ACTIVE };
  const k = codeKey(ph, em);
  const code = String(crypto.randomInt(100000, 1000000));
  const claim = await atomic(k, (rec) => {
    if (rec && now <= Number(rec.exp) && now - Number(rec.sentAt || 0) < RESEND_AFTER_MS) return { result: { wait: true } };
    return { next: { h: codeHash(ph, em, code), exp: now + CODE_TTL_MS, tries: 0, sentAt: now }, result: { ok: true } };
  });
  if (claim && claim.wait) return { ok: true, resent: false, message: 'Code already sent - check your email (and Spam).' };
  if (!claim || !claim.ok) return { ok: false, message: 'Could not send the email right now - please try again in a minute.' };
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto">' +
    '<h2 style="color:#16a34a;margin-bottom:4px">🔒 Your FluxFilm verification code</h2>' +
    '<p style="color:#475569">Enter this code in <b>Get OTP</b> to confirm it\'s you. It expires in 10 minutes.</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:14px 0">' + code + '</div>' +
    '<p style="color:#94a3b8;font-size:12px">Didn\'t ask for this? You can ignore this email - nobody gets your OTP without this code. 💚</p></div>';
  try {
    const r = await mailer.send(em, 'Your FluxFilm verification code: ' + code, html);
    if (r && r.ok === false) throw new Error(r.skipped || 'email not sent');
  } catch (e) {
    await del(k);
    console.log('[otp-access] email failed:', e.message);
    return { ok: false, message: 'Could not send the email right now - please try again in a minute.' };
  }
  return { ok: true, message: 'We sent a 6-digit code to your email. It can take a minute - check Spam too.' };
}

async function verifyGetOtpCode(phone, email, code, deps) {
  const now = (deps && deps.now) || Date.now();
  const ph = norm(phone); const em = normEmail(email);
  const c = s(code).replace(/\D/g, '');
  if (c.length !== 6) return { ok: false, message: 'Enter the 6-digit code from the email.' };
  const EXPIRED = { ok: false, expired: true, message: 'The code expired. Tap "Email me a code" again.' };
  if (!ph || !em) return EXPIRED;
  const k = codeKey(ph, em);
  const res = await atomic(k, (rec) => {
    if (!rec || now > Number(rec.exp)) return { result: { expired: true } };
    if (Number(rec.tries || 0) >= MAX_TRIES) return { result: { locked: true } };
    const next = Object.assign({}, rec, { tries: Number(rec.tries || 0) + 1 });
    return { next, result: { rec: next } };
  });
  if (!res || res.busy || res.expired) { if (res && res.expired) await del(k); return EXPIRED; }
  if (res.locked) { await del(k); return { ok: false, expired: true, message: 'Too many tries. Tap "Email me a code" again.' }; }
  const h = Buffer.from(codeHash(ph, em, c)); const stored = Buffer.from(String(res.rec.h || ''));
  if (!(h.length === stored.length && crypto.timingSafeEqual(h, stored))) {
    const left = MAX_TRIES - Number(res.rec.tries);
    if (left <= 0) { await del(k); return { ok: false, expired: true, message: 'Too many tries. Tap "Email me a code" again.' }; }
    return { ok: false, message: 'That code is not right. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' };
  }
  await del(k);
  // The purchase may have ended / been refunded while the email was on its way.
  if (!(await unlockedGroups(ph, (x) => x === em, now)).length) return { ok: false, noActive: true, message: NO_ACTIVE };
  return Object.assign({ ok: true }, makeToken2(ph, em, now));
}

function makeToken2(phone, email, now) {
  const ph = norm(phone);
  const exp = (now || Date.now()) + TOKEN_DAYS() * 86400e3;
  const payload = 'otp2.' + ph + '.' + emailHash(email) + '.' + exp;
  return { token: payload + '.' + mac('tok|' + payload), expiresAt: new Date(exp).toISOString() };
}
/** { ok, ph, eh } for a valid, unexpired otp2 token of this phone. */
function readToken2(token, phone, now) {
  const parts = s(token).split('.');
  if (parts.length !== 5 || parts[0] !== 'otp2') return { ok: false };
  const [, ph, eh, exp, sig] = parts;
  if (ph !== norm(phone) || !/^\d{10}$/.test(ph) || !/^[0-9a-f]{32}$/.test(eh)) return { ok: false };
  if (!(Number(exp) > (now || Date.now()))) return { ok: false };
  if (!sameText(sig, mac('tok|otp2.' + ph + '.' + eh + '.' + exp))) return { ok: false };
  return { ok: true, ph, eh };
}
function checkGetOtp(phone, token, now) {
  const t = readToken2(token, phone, now);
  if (t.ok) return { ok: true, eh: t.eh };
  return { ok: false, needsVerify: true, message: NEEDS_VERIFY };
}
/** Active purchases a verified Get OTP token unlocks (the email is re-checked against the purchase every time). */
function unlockedForToken(phone, eh, now) {
  return unlockedGroups(phone, (em) => sameText(emailHash(em), eh), now);
}

// ---------------- LEGACY (Games / Refunds) ----------------
function makeToken(phone, now) {
  const ph = norm(phone);
  const exp = (now || Date.now()) + TOKEN_DAYS() * 86400e3;
  const payload = 'otp1.' + ph + '.' + exp;
  return { token: payload + '.' + hmac(payload), expiresAt: new Date(exp).toISOString() };
}
function verifyToken(token, phone, now) {
  if (readToken2(token, phone, now).ok) return true;
  const parts = s(token).split('.');
  if (parts.length !== 4 || parts[0] !== 'otp1') return false;
  const [, ph, exp, sig] = parts;
  if (ph !== norm(phone) || !/^\d{10}$/.test(ph)) return false;
  if (!(Number(exp) > (now || Date.now()))) return false;
  return sameText(sig, hmac('otp1.' + ph + '.' + exp));
}

async function emailFor(ph) {
  const c = await db.query("SELECT email FROM customers WHERE phone_norm = ? AND email IS NOT NULL AND email <> '' LIMIT 1", [ph]);
  if (c.length && s(c[0].email).includes('@')) return s(c[0].email);
  const sub = await db.query("SELECT email FROM subscriptions WHERE phone_norm = ? AND email IS NOT NULL AND email <> '' ORDER BY expiry_date DESC LIMIT 1", [ph]);
  return sub.length && s(sub[0].email).includes('@') ? s(sub[0].email) : '';
}

// Games page hint only. Get OTP uses checkGetOtp (no email hints).
async function check(phone, token) {
  const ph = norm(phone);
  if (verifyToken(token, ph)) return { ok: true };
  const email = ph ? await emailFor(ph) : '';
  return {
    ok: false, needsVerify: true, maskedEmail: maskEmail(email), hasEmail: !!email,
    message: email ? 'For your safety, confirm it\'s you: we\'ll email a 6-digit code to ' + maskEmail(email) + '.' : 'We don\'t have an email for this number. Please message us on WhatsApp.',
  };
}

// deps.eligible(phone) is REQUIRED; deps.notEligibleMessage / deps.tool / deps.emailFor: 🎮 Games (games.js), 💸 Refunds (refunds.js).
async function sendCode(phone, deps) {
  const mailer = (deps && deps.mailer) || require('./mailer');
  const tool = (deps && deps.tool) || 'FluxFilm';
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your phone number.' };
  if (!deps || typeof deps.eligible !== 'function') return { ok: false, message: 'This code is not available here.' };
  if (!(await deps.eligible(ph))) return { ok: false, message: deps.notEligibleMessage || 'Not available for this number.' };
  const email = typeof deps.emailFor === 'function' ? await deps.emailFor(ph) : await emailFor(ph);
  if (!email) return { ok: false, noEmail: true, message: 'We don\'t have an email for this number. Please message us on WhatsApp.' };
  const prev = codes.get(ph);
  if (prev && prev.exp - CODE_TTL_MS + 45e3 > Date.now()) return { ok: true, maskedEmail: maskEmail(email), resent: false, message: 'Code already sent — check your email (and spam).' };
  const code = String(crypto.randomInt(100000, 1000000));
  codes.set(ph, { hash: hmac('code.' + ph + '.' + code), exp: Date.now() + CODE_TTL_MS, tries: 0 });
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto">' +
    '<h2 style="color:#16a34a;margin-bottom:4px">🔒 Your FluxFilm verification code</h2>' +
    '<p style="color:#475569">Enter this code in <b>' + tool + '</b> to confirm it\'s you. It expires in 10 minutes.</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:14px 0">' + code + '</div>' +
    '<p style="color:#94a3b8;font-size:12px">Didn\'t ask for this? Someone may have typed your number — you can ignore this email. 💚</p></div>';
  try {
    const r = await mailer.send(email, 'Your FluxFilm verification code: ' + code, html);
    if (r && r.ok === false) throw new Error(r.skipped || 'email not sent');
  } catch (e) {
    codes.delete(ph);
    console.log('[otp-access] email failed:', e.message);
    return { ok: false, message: 'Could not send the email right now — please try again in a minute.' };
  }
  return { ok: true, maskedEmail: maskEmail(email) };
}

async function verifyCode(phone, code) {
  const ph = norm(phone);
  const rec = codes.get(ph);
  if (!rec || Date.now() > rec.exp) { codes.delete(ph); return { ok: false, expired: true, message: 'The code expired. Tap "Email me a code" again.' }; }
  rec.tries += 1;
  if (rec.tries > MAX_TRIES) { codes.delete(ph); return { ok: false, expired: true, message: 'Too many tries. Tap "Email me a code" again.' }; }
  if (!sameText(rec.hash, hmac('code.' + ph + '.' + s(code).replace(/\D/g, '')))) return { ok: false, message: 'That code is not right. Please check the email and try again.' };
  codes.delete(ph);
  return Object.assign({ ok: true }, makeToken(ph));
}

module.exports = {
  sendGetOtpCode, verifyGetOtpCode, checkGetOtp, unlockedForToken, unlockedGroups, NO_ACTIVE,
  sendCode, verifyCode, check, makeToken, verifyToken,
  _internal: { codes, mem, maskEmail, makeToken2, readToken2, emailHash, expiryDay, todayIST, rowBlocked, codeKey, sendKey },
};
