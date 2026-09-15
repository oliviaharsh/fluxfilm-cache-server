/**
 * FluxFilm - Recover access on MySQL (fully self-contained; no Apps Script).
 * Flow: sendOtp (email a code) -> verifyOtp (issue token) -> listSubscriptions -> getAccess.
 * The OTP email is sent through smtp.js (support@ mailbox, else the IMAP Gmail).
 *
 * WHO MAY RECOVER (owner, 15 Sep 2026: "recover should only work if subs is active"):
 *   A subscription (or a multi-device group) is unlocked only when ALL of these hold:
 *   - it is active: expiry is still in the future (India time) on every device row, and no row is
 *     refunded, cancelled, removed or marked EXPIRED;
 *   - the typed email belongs to THAT subscription: the email saved on its row, or the email of the order
 *     that was really PAID and FULFILLED for it (linked by the row's order_id; a renewal moves order_id).
 *   Customer-profile emails and CREATED / PENDING orders never count: anyone can write those without a login.
 *   Every "no" (no plan, wrong email, expired, refunded, removed) gets the same NO_ACTIVE message, and
 *   the step is re-checked when the list is loaded and when the login is shown.
 *
 * Codes + session tokens are kept hashed (HMAC with a server secret) in app_settings ('rcv_o_…' / 'rcv_t_…')
 * so a Hostinger restart / redeploy mid-recovery does not throw the customer out. Each guess is claimed with
 * a compare-and-swap UPDATE, so parallel guesses can never go past MAX_ATTEMPTS. If app_settings is missing
 * or the DB write fails, memory alone is used (single Node process).
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

const NO_ACTIVE = 'No active plan found for this number and email. If your plan ended, renew it from My plans. Need help? Tap Help.';
const EXPIRED_MSG = 'For your safety this page timed out. Please send a new code.';

const otpStore = new Map();   // "phone|email" -> { h (HMAC of the code), exp, attempts, sentAt }  (fallback only)
const tokenStore = new Map(); // token -> { ph, em, exp }

const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const normEmail = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
const key = (ph, em) => ph + '|' + em;
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

// Server secret for code hashes: derived from server-only env (no new env var needed).
let _secret = null;
function secret() {
  if (_secret) return _secret;
  const e = process.env;
  const base = [e.DB_PASS, e.CACHE_CLEAR_KEY, e.IMAP_PASS].map((x) => String(x == null ? '' : x)).join('|');
  _secret = crypto.createHmac('sha256', 'ff-recover-v2').update(base).digest();
  return _secret;
}
const mac = (v) => crypto.createHmac('sha256', secret()).update(String(v)).digest('hex');
const otpHash = (k, otp) => mac('otp|' + k + '|' + otp);
const sameHex = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const genOtp = () => String(crypto.randomInt(100000, 1000000));
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  const show = u.length >= 6 ? 2 : 1;
  return u.slice(0, show) + '*'.repeat(Math.max(2, u.length - show)) + '@' + d;
}
function purge() {
  const now = Date.now();
  for (const [k, v] of otpStore) if (now > v.exp) otpStore.delete(k);
  for (const [k, v] of tokenStore) if (now > v.exp) tokenStore.delete(k);
}

// ---- Short-lived copies in app_settings (fail soft) ----
const otpKey = (k) => 'rcv_o_' + mac('k|' + k).slice(0, 40);
const tokKey = (t) => 'rcv_t_' + mac('t|' + t).slice(0, 40);
const persist = {
  async getRaw(k) {
    const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [k]);
    return r && r[0] ? String(r[0].value) : null;
  },
  async get(k) {
    try {
      const raw = await persist.getRaw(k);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && Date.now() <= Number(v.exp) ? v : null;
    } catch (_) { return null; }
  },
  async set(k, v) {
    try { await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [k, JSON.stringify(v)]); return true; } catch (_) { return false; }
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

// ---- Dates: every stored date is India time ----
const dayMs = 24 * 3600e3;
function expiryMs(expiry) {
  if (expiry instanceof Date) return expiry.getTime();
  const x = String(expiry == null ? '' : expiry).trim();
  let m = x.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (m) return Date.parse(m[1] + 'T23:59:59+05:30');
  m = x.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return Date.parse(m[1] + 'T' + (m[2].length === 5 ? m[2] + ':00' : m[2]) + '+05:30');
  return NaN;
}
function daysLeftOf(expiry) {
  const t = expiryMs(expiry);
  return Number.isFinite(t) ? Math.ceil((t - Date.now()) / dayMs) : null;
}
function prettyDate(expiry) {
  const t = expiryMs(expiry);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// ---- Which subscriptions this phone + email may open ----
function rowInactive(r) {
  if (Number(r.removed) === 1) return true;
  if (up(r.fulfillment_status) === 'REFUNDED') return true;
  const st = up(r.status);
  if (st === 'REFUNDED' || st === 'REMOVED' || st === 'EXPIRED' || /^CANCEL/.test(st)) return true;
  const t = expiryMs(r.expiry_date);
  return !(Number.isFinite(t) && t > Date.now());
}

async function subRowsFor(ph, groupsOn) {
  const base = 'sub_id, order_id, email, service, plan, login_id, password, profile_name, profile_pin, profile_number, expiry_date, status, fulfillment_status' +
    (groupsOn ? ', device_type, device_count, tv_count, group_id, group_index' : '');
  try {
    return await db.query('SELECT ' + base + ', COALESCE(removed, 0) AS removed FROM subscriptions WHERE phone_norm = ?', [ph]);
  } catch (e) {
    if (!/removed/i.test(String(e && e.message))) throw e;
    return db.query('SELECT ' + base + ' FROM subscriptions WHERE phone_norm = ?', [ph]); // before schema-v13
  }
}

/** Active purchases this email may open, newest expiry first. Each item: { rows (Device 1 first), lead }. */
async function unlockedGroups(ph, em) {
  if (!ph || !em) return [];
  const groupsOn = await deviceLogins.groupsReady(db.query);
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
    if (rows.some(rowInactive)) continue;
    active.push({ rows, lead: rows[0], bySub: rows.some((r) => normEmail(r.email) === em) });
  }
  const needOrders = [...new Set(active.filter((g) => !g.bySub).flatMap((g) => g.rows.map((r) => String(r.order_id || '').trim())).filter(Boolean))];
  const paidEmail = new Map();
  if (needOrders.length) {
    const rows = await db.query(
      "SELECT order_id, email FROM orders WHERE order_id IN (" + needOrders.map(() => '?').join(', ') + ") AND UPPER(status) = 'PAID' AND UPPER(fulfillment_status) = 'FULFILLED'",
      needOrders);
    for (const o of rows || []) paidEmail.set(String(o.order_id), normEmail(o.email));
  }
  const out = active.filter((g) => g.bySub || g.rows.some((r) => paidEmail.get(String(r.order_id || '').trim()) === em));
  out.sort((a, b) => (expiryMs(b.lead.expiry_date) || 0) - (expiryMs(a.lead.expiry_date) || 0));
  return out;
}

// ---- Steps ----
async function sendOtp(phone, email) {
  purge(); sweepDb();
  const ph = norm(phone); const em = normEmail(email);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your 10-digit phone number (the one you bought with).' };
  if (!em || !/^[^@]+@[^@]+\.[^@]+$/.test(em)) return { ok: false, message: 'Enter a valid email address, like name@gmail.com.' };
  const groups = await unlockedGroups(ph, em);
  if (!groups.length) return { ok: false, noActive: true, message: NO_ACTIVE };
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
  // Memory copy: for the 30 s resend wait, and the ONLY copy (memOnly) when app_settings can't be written.
  const saved = await persist.set(otpKey(k), rec);
  otpStore.set(k, Object.assign({}, rec, { memOnly: !saved }));
  const mins = Math.round(OTP_TTL_MS / 60000);
  return {
    ok: true, email: maskEmail(em), expiresInMin: mins, resendInSec: RESEND_AFTER_MS / 1000,
    message: 'We sent a 6-digit code to ' + maskEmail(em) + '. It can take a minute — check Spam / Promotions too. The code works for ' + mins + ' minutes.',
  };
}

/**
 * Count one guess atomically. Returns { rec } (attempt counted, rec.attempts already includes it),
 * { expired } (no live code) or { locked } (MAX_ATTEMPTS already used).
 * DB path: compare-and-swap on the exact stored text, so two parallel guesses can't both use the last try.
 */
async function claimAttempt(k) {
  const dk = otpKey(k);
  for (let i = 0; i < 6; i++) {
    let raw;
    try { raw = await persist.getRaw(dk); } catch (_) { return claimInMemory(k); }
    if (raw == null) return claimInMemory(k);
    let rec = null; try { rec = JSON.parse(raw); } catch (_) { rec = null; }
    if (!rec || !(Date.now() <= Number(rec.exp))) { otpStore.delete(k); await persist.del(dk); return { expired: true }; }
    if (Number(rec.attempts || 0) >= MAX_ATTEMPTS) { otpStore.delete(k); await persist.del(dk); return { locked: true }; }
    const next = Object.assign({}, rec, { attempts: Number(rec.attempts || 0) + 1 });
    let res;
    try { res = await db.query('UPDATE app_settings SET value = ? WHERE setting_key = ? AND value = ?', [JSON.stringify(next), dk, raw]); }
    catch (_) { return claimInMemory(k); }
    if (res && Number(res.affectedRows) === 1) return { rec: next };
    // someone else changed it first: read again
  }
  return { locked: true };
}
// Only for a code that was never saved to app_settings (memOnly); a DB copy is never shadowed by memory.
function claimInMemory(k) {
  const rec = otpStore.get(k);
  if (!rec || !rec.memOnly || Date.now() > rec.exp) { otpStore.delete(k); return { expired: true }; }
  if (rec.attempts >= MAX_ATTEMPTS) { otpStore.delete(k); return { locked: true }; }
  rec.attempts += 1; // synchronous: atomic inside this one Node process
  return { rec };
}

async function verifyOtp(phone, email, otp) {
  purge();
  const ph = norm(phone); const em = normEmail(email); const k = key(ph, em);
  const code = String(otp || '').replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, message: 'Enter the 6-digit code from the email.' };
  const c = await claimAttempt(k);
  if (c.expired) return { ok: false, expired: true, message: 'This code has expired or was replaced. Tap "Send a new code".' };
  if (c.locked) return { ok: false, expired: true, message: 'Too many wrong tries. Tap "Send a new code".' };
  if (!sameHex(otpHash(k, code), c.rec.h)) {
    const left = MAX_ATTEMPTS - c.rec.attempts;
    if (left <= 0) { otpStore.delete(k); await persist.del(otpKey(k)); }
    return { ok: false, expired: left <= 0, message: 'That code is not right. ' + (left > 0 ? left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Tap "Send a new code".') + ' Use the newest email if you asked more than once.' };
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

async function listSubscriptions(phone, email, token) {
  const ph = norm(phone); const em = normEmail(email);
  if (!(await checkToken(token, ph, em))) return { ok: false, sessionExpired: true, message: EXPIRED_MSG };
  const groups = await unlockedGroups(ph, em);
  if (!groups.length) return { ok: false, noActive: true, message: NO_ACTIVE };
  // A purchase with separate logins is listed once (Device 1); getAccess shows every device.
  const subscriptions = groups.map(({ lead: r }) => ({
    orderId: r.order_id, subId: r.sub_id, service: r.service, plan: r.plan,
    status: r.status, fulfillmentStatus: r.fulfillment_status, expiry: r.expiry_date, expiryDate: r.expiry_date,
    daysLeft: daysLeftOf(r.expiry_date), expiryText: prettyDate(r.expiry_date), refunded: false,
  }));
  return { ok: true, subscriptions };
}

async function getAccess(orderId, phone, email, token) {
  const ph = norm(phone); const em = normEmail(email);
  if (!(await checkToken(token, ph, em))) return { ok: false, sessionExpired: true, message: EXPIRED_MSG };
  const oid = String(orderId || '').trim();
  if (!oid) return { ok: false, noActive: true, message: NO_ACTIVE };
  const groups = await unlockedGroups(ph, em);
  const g = groups.find((x) => x.rows.some((r) => String(r.sub_id) === oid)) ||
    groups.find((x) => x.rows.some((r) => String(r.order_id || '').trim() === oid));
  if (!g) return { ok: false, noActive: true, message: NO_ACTIVE };
  const groupsOn = await deviceLogins.groupsReady(db.query);
  const group = g.rows; const s = g.lead;
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
  return { ok: true, access, postPaymentMessage };
}

module.exports = { sendOtp, verifyOtp, listSubscriptions, getAccess, NO_ACTIVE, _internal: { checkToken, otpStore, tokenStore, maskEmail, unlockedGroups, otpKey, tokKey, otpHash, key, claimAttempt, expiryMs } };
