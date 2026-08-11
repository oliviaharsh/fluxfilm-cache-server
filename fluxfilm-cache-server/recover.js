/**
 * FluxFilm - Recover access on MySQL (fully self-contained; no Apps Script).
 * Flow: sendOtp (email a code) -> verifyOtp (issue token) -> listSubscriptions ->
 * getAccess. OTPs + tokens are held server-side (in-memory, short TTL). The OTP
 * email is sent via Gmail SMTP using the same app password used for IMAP.
 *
 * Reassign (swap a dead profile for a fresh one) is intentionally NOT here yet.
 */
const db = require('./db');
const crypto = require('crypto');

const OTP_TTL_MS = Number(process.env.RECOVER_OTP_TTL_MIN || 10) * 60 * 1000;
const TOKEN_TTL_MS = Number(process.env.RECOVER_TOKEN_TTL_MIN || 20) * 60 * 1000;
const MAX_ATTEMPTS = 5;
const OTP_SERVICES = ['jiohotstar', 'hotstar', 'zee5', 'sonyliv'];

const otpStore = new Map();   // "phone|email" -> { otp, exp, attempts }
const tokenStore = new Map(); // token -> { ph, em, exp }

const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const normEmail = (v) => String(v == null ? '' : v).trim().toLowerCase();
const key = (ph, em) => ph + '|' + em;
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return e;
  const uu = u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.max(1, u.length - 2));
  return uu + '@' + d;
}
function purge() {
  const now = Date.now();
  for (const [k, v] of otpStore) if (now > v.exp) otpStore.delete(k);
  for (const [k, v] of tokenStore) if (now > v.exp) tokenStore.delete(k);
}

// ---- Gmail SMTP (lazy) ----
let _transport = null;
function transport() {
  if (_transport) return _transport;
  const nodemailer = require('nodemailer');
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: String(process.env.IMAP_PASS || '').replace(/\s+/g, '') },
  });
  return _transport;
}
async function sendOtpEmail(to, otp) {
  const html =
    '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto">' +
    '<h2 style="color:#16a34a;margin-bottom:4px">🔑 Your FluxFilm recovery code</h2>' +
    '<p style="color:#475569">Use this code to recover your subscription access. It expires in 10 minutes.</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:14px 0">' + otp + '</div>' +
    '<p style="color:#94a3b8;font-size:12px">If you didn\'t request this, you can ignore this email. 💚</p></div>';
  await transport().sendMail({
    from: '"FluxFilm" <' + process.env.IMAP_USER + '>',
    to, subject: 'Your FluxFilm recovery code: ' + otp, html,
  });
}

// ---- Steps ----
async function sendOtp(phone, email) {
  purge();
  const ph = norm(phone); const em = normEmail(email);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter a valid phone number.' };
  if (!em || em.indexOf('@') < 0) return { ok: false, message: 'Enter a valid email address.' };
  // The phone + email must match a subscription we have.
  const rows = await db.query('SELECT COUNT(*) n FROM subscriptions WHERE phone_norm = ? AND LOWER(email) = ?', [ph, em]);
  if (!(+(rows[0] || {}).n > 0)) return { ok: false, message: "We couldn't find a subscription for that phone + email. Please check and try again." };
  const otp = genOtp();
  otpStore.set(key(ph, em), { otp, exp: Date.now() + OTP_TTL_MS, attempts: 0 });
  try { await sendOtpEmail(email, otp); }
  catch (e) { console.log('[recover] email failed:', e.message); return { ok: false, message: 'Could not send the email right now — please try again in a moment.' }; }
  return { ok: true, message: 'OTP sent.', email: maskEmail(em) };
}

async function verifyOtp(phone, email, otp) {
  purge();
  const ph = norm(phone); const em = normEmail(email); const k = key(ph, em);
  const rec = otpStore.get(k);
  if (!rec) return { ok: false, message: 'No code found (or it expired). Please resend.' };
  if (Date.now() > rec.exp) { otpStore.delete(k); return { ok: false, message: 'Code expired. Please resend.' }; }
  rec.attempts += 1;
  if (rec.attempts > MAX_ATTEMPTS) { otpStore.delete(k); return { ok: false, message: 'Too many attempts. Please resend a new code.' }; }
  if (String(otp || '').replace(/\D/g, '') !== rec.otp) return { ok: false, message: 'Incorrect code. Please try again.' };
  otpStore.delete(k);
  const token = crypto.randomBytes(24).toString('hex');
  tokenStore.set(token, { ph, em, exp: Date.now() + TOKEN_TTL_MS });
  return { ok: true, message: 'Verified.', recoverToken: token };
}

function checkToken(token, ph, em) {
  const t = tokenStore.get(String(token || ''));
  if (!t) return false;
  if (Date.now() > t.exp) { tokenStore.delete(token); return false; }
  return t.ph === ph && t.em === em;
}

async function listSubscriptions(phone, email, token) {
  const ph = norm(phone); const em = normEmail(email);
  if (!checkToken(token, ph, em)) return { ok: false, message: 'Your session expired. Please verify the OTP again.' };
  const rows = await db.query(
    'SELECT order_id, sub_id, service, plan, status, fulfillment_status, expiry_date FROM subscriptions WHERE phone_norm = ? ORDER BY expiry_date DESC', [ph]);
  const subscriptions = rows.map((r) => ({
    orderId: r.order_id, subId: r.sub_id, service: r.service, plan: r.plan,
    status: r.status, fulfillmentStatus: r.fulfillment_status, expiry: r.expiry_date, expiryDate: r.expiry_date,
  }));
  return { ok: true, subscriptions };
}

async function getAccess(orderId, phone, email, token) {
  const ph = norm(phone); const em = normEmail(email);
  if (!checkToken(token, ph, em)) return { ok: false, message: 'Your session expired. Please verify the OTP again.' };
  const oid = String(orderId || '').trim();
  const rows = await db.query(
    'SELECT order_id, sub_id, service, plan, login_id, password, profile_name, profile_pin, profile_number, expiry_date, status FROM subscriptions WHERE (order_id = ? OR sub_id = ?) AND phone_norm = ? LIMIT 1',
    [oid, oid, ph]);
  const s = rows[0];
  if (!s) return { ok: false, message: 'Subscription not found for this account.' };
  const isOtp = OTP_SERVICES.some((k) => String(s.service || '').toLowerCase().includes(k));
  return {
    ok: true,
    access: {
      service: s.service, plan: s.plan,
      user: s.login_id || '', pass: s.password || '',
      loginId: s.login_id || '', password: s.password || '',
      profileName: s.profile_name || '', profilePin: s.profile_pin || '', profileNumber: s.profile_number || '',
      expiry: s.expiry_date, isOtpService: isOtp,
    },
  };
}

module.exports = { sendOtp, verifyOtp, listSubscriptions, getAccess, _internal: { checkToken, otpStore, tokenStore, maskEmail } };
