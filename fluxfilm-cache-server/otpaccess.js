/**
 * FluxFilm - proof that the person asking for a login OTP is the customer (Get OTP tool).
 *
 * A phone number is not a secret, so it alone must not unlock the OTP inbox. The first time a device asks,
 * we email a 6-digit code to the email on that customer's FluxFilm account; entering it gives the device a
 * signed token (default 30 days) that getLatestOtp requires. No database table: the token is
 * "otp1.<phone>.<expiry>.<HMAC>", signed with OTP_ACCESS_SECRET (or a secret derived from server-only env).
 *
 *   sendCode(phone)            → { ok, maskedEmail }                (active plan + email on file required)
 *   verifyCode(phone, code)    → { ok, token, expiresAt }           (5 tries per code, 10 min)
 *   check(phone, token)        → { ok } or { ok:false, needsVerify, maskedEmail, message }
 */
const crypto = require('crypto');
const db = require('./db');

const CODE_TTL_MS = 10 * 60e3;
const MAX_TRIES = 5;
const TOKEN_DAYS = () => Math.min(90, Math.max(1, Number(process.env.OTP_ACCESS_DAYS || 30)));
const codes = new Map(); // phone -> { hash, exp, tries, email }

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
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

function makeToken(phone, now) {
  const ph = norm(phone);
  const exp = (now || Date.now()) + TOKEN_DAYS() * 86400e3;
  const payload = 'otp1.' + ph + '.' + exp;
  return { token: payload + '.' + hmac(payload), expiresAt: new Date(exp).toISOString() };
}
function verifyToken(token, phone, now) {
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
async function hasActivePlan(ph) {
  const r = await db.query("SELECT 1 FROM subscriptions WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' AND (expiry_date IS NULL OR expiry_date > NOW()) LIMIT 1", [ph]);
  return r.length > 0;
}

async function check(phone, token) {
  const ph = norm(phone);
  if (verifyToken(token, ph)) return { ok: true };
  const email = ph ? await emailFor(ph) : '';
  return {
    ok: false, needsVerify: true, maskedEmail: maskEmail(email), hasEmail: !!email,
    message: email ? 'For your safety, confirm it\'s you: we\'ll email a 6-digit code to ' + maskEmail(email) + '.' : 'We don\'t have an email for this number. Please message us on WhatsApp for your OTP.',
  };
}

// deps.eligible(phone) / deps.notEligibleMessage / deps.tool let 🎮 Games reuse the same code + token (games.js):
// a device verified once works for both Get OTP and Games prizes.
async function sendCode(phone, deps) {
  const mailer = (deps && deps.mailer) || require('./mailer');
  const tool = (deps && deps.tool) || 'Get OTP';
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your phone number.' };
  const eligible = deps && typeof deps.eligible === 'function' ? await deps.eligible(ph) : await hasActivePlan(ph);
  if (!eligible) return { ok: false, message: (deps && deps.notEligibleMessage) || 'Get OTP works only for a number with an active plan.' };
  const email = await emailFor(ph);
  if (!email) return { ok: false, noEmail: true, message: 'We don\'t have an email for this number. Please message us on WhatsApp for your OTP.' };
  const prev = codes.get(ph);
  if (prev && prev.exp - CODE_TTL_MS + 45e3 > Date.now()) return { ok: true, maskedEmail: maskEmail(email), resent: false, message: 'Code already sent — check your email (and spam).' };
  const code = String(crypto.randomInt(100000, 1000000));
  codes.set(ph, { hash: hmac('code.' + ph + '.' + code), exp: Date.now() + CODE_TTL_MS, tries: 0 });
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto">' +
    '<h2 style="color:#16a34a;margin-bottom:4px">🔒 Your FluxFilm verification code</h2>' +
    '<p style="color:#475569">Enter this code in <b>' + tool + '</b> to confirm it\'s you. It expires in 10 minutes.</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:14px 0">' + code + '</div>' +
    '<p style="color:#94a3b8;font-size:12px">Didn\'t ask for this? Someone may have typed your number — you can ignore this email; nobody gets your OTP without this code. 💚</p></div>';
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

module.exports = { sendCode, verifyCode, check, makeToken, verifyToken, _internal: { codes, maskEmail } };
