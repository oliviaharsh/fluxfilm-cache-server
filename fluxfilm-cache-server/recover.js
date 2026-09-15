/**
 * FluxFilm - Recover access on MySQL (fully self-contained; no Apps Script).
 * Flow: sendOtp (email a code) -> verifyOtp (issue token) -> listSubscriptions ->
 * getAccess. The OTP email is sent through smtp.js (support@ mailbox, else the IMAP Gmail).
 *
 * Which email may receive the code: any email saved for that phone on its subscriptions, orders
 * or customer profile (trimmed, any case). Go-era imports often have the email on only one of them.
 *
 * OTPs + tokens live in memory AND (hashed, short TTL) in app_settings ('rcv_o_…' / 'rcv_t_…'), so a
 * Hostinger restart / redeploy in the middle of a recovery does not throw the customer out.
 * If app_settings is missing or the DB write fails, memory alone is used (as before).
 *
 * Reassign (swap a dead profile for a fresh one) is intentionally NOT here yet.
 */
const db = require('./db');
const crypto = require('crypto');
const deviceLogins = require('./devicelogins');

const OTP_TTL_MS = Number(process.env.RECOVER_OTP_TTL_MIN || 10) * 60 * 1000;
const TOKEN_TTL_MS = Number(process.env.RECOVER_TOKEN_TTL_MIN || 20) * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const OTP_SERVICES = ['jiohotstar', 'hotstar', 'zee5', 'sonyliv'];

const otpStore = new Map();   // "phone|email" -> { h (hash of the code), exp, attempts, sentAt }
const tokenStore = new Map(); // token -> { ph, em, exp }

const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const normEmail = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
const key = (ph, em) => ph + '|' + em;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const otpHash = (k, otp) => sha('otp|' + k + '|' + otp);
const genOtp = () => String(crypto.randomInt(100000, 1000000));
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return e;
  const show = u.length >= 6 ? 2 : 1;
  return u.slice(0, show) + '*'.repeat(Math.max(2, u.length - show)) + '@' + d;
}
const maskPhone = (ph) => (ph.length === 10 ? ph.slice(0, 2) + '******' + ph.slice(-2) : ph);
function purge() {
  const now = Date.now();
  for (const [k, v] of otpStore) if (now > v.exp) otpStore.delete(k);
  for (const [k, v] of tokenStore) if (now > v.exp) tokenStore.delete(k);
}

// ---- Short-lived copies in app_settings (fail soft) ----
const otpKey = (k) => 'rcv_o_' + sha(k).slice(0, 40);
const tokKey = (t) => 'rcv_t_' + sha(t).slice(0, 40);
const persist = {
  async get(k) {
    try {
      const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [k]);
      if (!r || !r[0]) return null;
      const v = JSON.parse(r[0].value);
      return v && Date.now() <= Number(v.exp) ? v : null;
    } catch (_) { return null; }
  },
  async set(k, v) {
    try { await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [k, JSON.stringify(v)]); } catch (_) { /* memory only */ }
  },
  async del(k) {
    try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [k]); } catch (_) { /* memory only */ }
  },
};
let lastDbSweep = 0;
async function sweepDb() {
  if (Date.now() - lastDbSweep < 10 * 60e3) return;
  lastDbSweep = Date.now();
  try { await db.query('DELETE FROM app_settings WHERE setting_key LIKE ? AND updated_at < (NOW() - INTERVAL 2 HOUR)', ['rcv\\_%']); } catch (_) { /* ignore */ }
}

// ---- Email (smtp.js: support@ mailbox, else the IMAP Gmail) ----
const smtp = require('./smtp');
async function sendOtpEmail(to, otp) {
  const mins = Math.round(OTP_TTL_MS / 60000);
  const html =
    '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto">' +
    '<h2 style="color:#16a34a;margin-bottom:4px">🔑 Your FluxFilm recovery code</h2>' +
    '<p style="color:#475569">Use this code to recover your subscription access. It expires in ' + mins + ' minutes.</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:14px 0">' + otp + '</div>' +
    '<p style="color:#94a3b8;font-size:12px">If you didn\'t request this, you can ignore this email. 💚</p></div>';
  const r = await smtp.sendMail({ to, subject: 'Your FluxFilm recovery code: ' + otp, html });
  if (!r.ok) throw new Error('Email is not set up on the server.');
}

// Every email saved for this phone (subscriptions, orders, customer profile). A missing table only drops that source.
async function emailsForPhone(ph) {
  const sources = [
    'SELECT DISTINCT email FROM subscriptions WHERE phone_norm = ?',
    'SELECT DISTINCT email FROM orders WHERE phone_norm = ?',
    'SELECT DISTINCT email FROM customers WHERE phone_norm = ?',
  ];
  const out = new Set();
  for (const sql of sources) {
    let rows = [];
    try { rows = await db.query(sql, [ph]); } catch (_) { rows = []; }
    for (const r of rows || []) { const e = normEmail(r.email); if (e && e.indexOf('@') > 0) out.add(e); }
  }
  return [...out];
}

// ---- Steps ----
async function sendOtp(phone, email) {
  purge(); sweepDb();
  const ph = norm(phone); const em = normEmail(email);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your 10-digit phone number (the one you bought with).' };
  if (!em || !/^[^@]+@[^@]+\.[^@]+$/.test(em)) return { ok: false, message: 'Enter a valid email address, like name@gmail.com.' };
  const subs = await db.query('SELECT COUNT(*) n FROM subscriptions WHERE phone_norm = ?', [ph]);
  if (!(+(subs[0] || {}).n > 0)) {
    return { ok: false, noPlan: true, message: "We couldn't find any plan on " + maskPhone(ph) + '. Did you buy with a different phone number?' };
  }
  const known = await emailsForPhone(ph);
  if (!known.length) {
    return { ok: false, noEmail: true, message: "We don't have an email saved for this number, so we can't send a code. Tap Help and our team will get your login back." };
  }
  if (known.indexOf(em) < 0) {
    const hints = known.slice(0, 2).map(maskEmail);
    return {
      ok: false, wrongEmail: true, hints,
      message: 'This number has a plan, but not with this email. Use the email you bought with' + (hints.length === 1 ? ' — it looks like ' + hints[0] + '.' : ' — one of: ' + hints.join(', ') + '.'),
    };
  }
  const k = key(ph, em);
  const prev = otpStore.get(k) || await persist.get(otpKey(k));
  if (prev && prev.sentAt && Date.now() - prev.sentAt < RESEND_AFTER_MS) {
    const wait = Math.ceil((RESEND_AFTER_MS - (Date.now() - prev.sentAt)) / 1000);
    return { ok: false, wait, email: maskEmail(em), message: 'We just sent a code to ' + maskEmail(em) + '. You can ask for a new one in ' + wait + ' s.' };
  }
  const otp = genOtp();
  const rec = { h: otpHash(k, otp), exp: Date.now() + OTP_TTL_MS, attempts: 0, sentAt: Date.now() };
  try { await sendOtpEmail(em, otp); }
  catch (e) { console.log('[recover] email failed:', e.message); return { ok: false, message: 'We could not send the email right now. Please try again in a minute, or tap Help.' }; }
  otpStore.set(k, rec);
  await persist.set(otpKey(k), rec);
  const mins = Math.round(OTP_TTL_MS / 60000);
  return {
    ok: true, email: maskEmail(em), expiresInMin: mins, resendInSec: RESEND_AFTER_MS / 1000,
    message: 'We sent a 6-digit code to ' + maskEmail(em) + '. It can take a minute — check Spam / Promotions too. The code works for ' + mins + ' minutes.',
  };
}

async function verifyOtp(phone, email, otp) {
  purge();
  const ph = norm(phone); const em = normEmail(email); const k = key(ph, em);
  let rec = otpStore.get(k);
  if (!rec) { rec = await persist.get(otpKey(k)); if (rec) otpStore.set(k, rec); }
  if (!rec) return { ok: false, expired: true, message: 'This code has expired or was replaced. Tap "Send a new code".' };
  if (Date.now() > rec.exp) { otpStore.delete(k); await persist.del(otpKey(k)); return { ok: false, expired: true, message: 'This code has expired. Tap "Send a new code".' }; }
  const code = String(otp || '').replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, message: 'Enter the 6-digit code from the email.' };
  rec.attempts += 1;
  if (rec.attempts > MAX_ATTEMPTS) { otpStore.delete(k); await persist.del(otpKey(k)); return { ok: false, expired: true, message: 'Too many wrong tries. Tap "Send a new code".' }; }
  if (otpHash(k, code) !== rec.h) {
    await persist.set(otpKey(k), rec);
    const left = MAX_ATTEMPTS - rec.attempts;
    return { ok: false, message: 'That code is not right. ' + (left > 0 ? left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Tap "Send a new code".') + ' Use the newest email if you asked more than once.' };
  }
  otpStore.delete(k); await persist.del(otpKey(k));
  const token = crypto.randomBytes(24).toString('hex');
  const t = { ph, em, exp: Date.now() + TOKEN_TTL_MS };
  tokenStore.set(token, t);
  await persist.set(tokKey(token), t);
  return { ok: true, message: 'Verified.', recoverToken: token };
}

async function checkToken(token, ph, em) {
  const tk = String(token || '');
  if (!tk) return false;
  let t = tokenStore.get(tk);
  if (!t) { t = await persist.get(tokKey(tk)); if (t) tokenStore.set(tk, t); }
  if (!t) return false;
  if (Date.now() > t.exp) { tokenStore.delete(tk); await persist.del(tokKey(tk)); return false; }
  return t.ph === ph && t.em === em;
}

const EXPIRED_MSG = 'For your safety this page timed out. Please send a new code.';
const dayMs = 24 * 3600e3;
function daysLeftOf(expiry) {
  const t = Date.parse(String(expiry || '').replace(' ', 'T'));
  return Number.isFinite(t) ? Math.ceil((t - Date.now()) / dayMs) : null;
}
function prettyDate(expiry) {
  const t = Date.parse(String(expiry || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
const isRefunded = (r) => up(r.fulfillment_status) === 'REFUNDED' || /^CANCEL/.test(up(r.status));

async function listSubscriptions(phone, email, token) {
  const ph = norm(phone); const em = normEmail(email);
  if (!(await checkToken(token, ph, em))) return { ok: false, sessionExpired: true, message: EXPIRED_MSG };
  const groupsOn = await deviceLogins.groupsReady(db.query);
  const all = await db.query(
    'SELECT order_id, sub_id, service, plan, status, fulfillment_status, expiry_date' + (groupsOn ? ', group_id, group_index' : '') + ' FROM subscriptions WHERE phone_norm = ? ORDER BY expiry_date DESC', [ph]);
  // F1: a purchase with separate logins is listed once (its first device); getAccess shows every device.
  const seen = new Set();
  const rows = all.filter((r) => {
    if (!groupsOn || !r.group_id) return true;
    if (seen.has(r.group_id)) return false;
    seen.add(r.group_id); return true;
  }).map((r) => (groupsOn && r.group_id ? Object.assign({}, all.filter((x) => x.group_id === r.group_id).sort((a, b) => Number(a.group_index) - Number(b.group_index))[0]) : r));
  const subscriptions = rows.map((r) => ({
    orderId: r.order_id, subId: r.sub_id, service: r.service, plan: r.plan,
    status: r.status, fulfillmentStatus: r.fulfillment_status, expiry: r.expiry_date, expiryDate: r.expiry_date,
    daysLeft: daysLeftOf(r.expiry_date), expiryText: prettyDate(r.expiry_date), refunded: isRefunded(r),
  }));
  // Plans still running first (latest expiry first), then ended ones; refunded last.
  const rank = (x) => (x.refunded ? 2 : x.daysLeft != null && x.daysLeft > 0 ? 0 : 1);
  subscriptions.sort((a, b) => rank(a) - rank(b));
  return { ok: true, subscriptions };
}

async function getAccess(orderId, phone, email, token) {
  const ph = norm(phone); const em = normEmail(email);
  if (!(await checkToken(token, ph, em))) return { ok: false, sessionExpired: true, message: EXPIRED_MSG };
  const oid = String(orderId || '').trim();
  const groupsOn = await deviceLogins.groupsReady(db.query);
  const cols = 'order_id, sub_id, service, plan, login_id, password, profile_name, profile_pin, profile_number, expiry_date, status' + (groupsOn ? ', device_type, device_count, tv_count, group_id, group_index' : '');
  const rows = await db.query(
    'SELECT ' + cols + ' FROM subscriptions WHERE (order_id = ? OR sub_id = ?) AND phone_norm = ? LIMIT 1',
    [oid, oid, ph]);
  let s = rows[0];
  if (!s) return { ok: false, message: 'Subscription not found for this account.' };
  // Refund / login switched off: read separately so an older database (no removed column) still works.
  let extra = {};
  try { extra = (await db.query('SELECT fulfillment_status, COALESCE(removed, 0) AS removed FROM subscriptions WHERE sub_id = ? LIMIT 1', [s.sub_id]))[0] || {}; } catch (_) { extra = {}; }
  const row = Object.assign({}, s, extra);
  if (isRefunded(row)) return { ok: false, refunded: true, message: 'This plan was refunded, so there is no login to show. Need help? Tap Help.' };
  const daysLeft = daysLeftOf(s.expiry_date);
  if (Number(row.removed) === 1 && daysLeft != null && daysLeft <= 0) {
    return { ok: false, expired: true, message: 'This plan ended on ' + prettyDate(s.expiry_date) + ' and its old login no longer works. Renew it from My plans to get a working login.' };
  }
  // F1: every login of the purchase (same phone only), Device 1 first.
  let group = [s];
  if (groupsOn && s.group_id) {
    const g = await db.query('SELECT ' + cols + ' FROM subscriptions WHERE group_id = ? AND phone_norm = ? ORDER BY group_index', [s.group_id, ph]);
    if (g.length) { group = g; s = g[0]; }
  }
  const svc = String(s.service || '').toLowerCase();
  const isOtp = OTP_SERVICES.some((k) => svc.includes(k));
  const access = {
    service: s.service, plan: s.plan,
    user: s.login_id || '', pass: s.password || '',
    loginId: s.login_id || '', password: s.password || '',
    profileName: s.profile_name || '', profilePin: s.profile_pin || '', profileNumber: s.profile_number || '',
    expiry: s.expiry_date, isOtpService: isOtp,
  };
  if (groupsOn) {
    const multi = deviceLogins.accessWithLogins(group);
    if (multi.logins) Object.assign(access, { logins: multi.logins, sameLogin: multi.sameLogin, deviceCount: multi.deviceCount });
  }
  let postPaymentMessage = '';
  if (!access.user && !access.pass && !isOtp) {
    postPaymentMessage = svc.includes('youtube')
      ? 'YouTube Premium works on your own Google account — no login or password needed. Open the family invite we sent to your email (check Spam too). Not found? Tap Help.'
      : 'Your login is not saved here yet. Tap Help and our team will send it to you.';
  }
  if (daysLeft != null && daysLeft <= 0) postPaymentMessage = ('This plan ended on ' + prettyDate(s.expiry_date) + '. Renew it from My plans to keep watching. ' + postPaymentMessage).trim();
  return { ok: true, access, postPaymentMessage };
}

module.exports = { sendOtp, verifyOtp, listSubscriptions, getAccess, _internal: { checkToken, otpStore, tokenStore, maskEmail, emailsForPhone, otpKey, tokKey, otpHash, key } };
