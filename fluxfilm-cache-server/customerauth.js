/**
 * FluxFilm - 🔐 customer login with an email code + signed sessions (15 Sep 2026, owner: "Send OTP to email for first
 * time login").
 *
 * WHY: login was a phone number only, and every storefront action trusted the phone the browser sent. Anyone who
 * knew a number could read that customer's profile, plans, orders, coins and referrals, and act as them.
 *
 * LOGIN (first time on a device)
 *   start(phone)                 known phone  → 6-digit code to a TRUSTED email (emaillock.loginOptions), masked
 *                                unknown phone → { newCustomer } (storefront asks name + email)
 *                                known, no trusted email → { noEmail } ("tap Help (WhatsApp)")
 *   start(phone, { target })     same, to another trusted email (option id from the first answer)
 *   signup(phone, name, email)   unknown phone only → code to that email
 *   verify(phone, code, { mode:'login', target } | { mode:'signup', name, email }) → { ok, token } (+ profile made)
 *   Codes, 5 tries, 30 s resend, per phone + per email hourly caps: emaillock.js (atomic, in app_settings).
 *
 * SESSION
 *   token  = cs1.<phone>.<issuedAt>.<random id>.<HMAC>  (secret derived from DB_PASS + CACHE_CLEAR_KEY)
 *   stored = app_settings 'csess_<phone hash>_<id>' = { ph, iat, exp, seen, dev } → revocable, survives restarts,
 *            no schema change. Valid 180 days, sliding (refreshed at most once a day).
 *   cookie = ff_cs, HttpOnly, Secure (not on localhost), SameSite=Lax, Path=/ → same browser + installed app stay in.
 *   logout (this device) · logoutAll (every device) · admin revokeAll (Customer 360).
 *
 * ENFORCEMENT (guard): POLICY lists every storefront action as public or needing a session. With a session, the
 * phone in the request must be the session's phone (else refused) and is replaced by it. Orders / subscriptions
 * named by id must belong to that phone. Admin → 🚧 Maintenance → "🔐 Email login required" OFF = emergency
 * phone-only mode (store.emailLoginRequired), logged in the change log.
 */
const crypto = require('crypto');
const db = require('./db');
const emaillock = require('./emaillock');

const COOKIE = 'ff_cs';
const SESSION_DAYS = 180;
const SESSION_MS = SESSION_DAYS * 86400e3;
const SLIDE_EVERY_MS = 24 * 3600e3;
const CACHE_MS = 30e3;
const KEY_PREFIX = 'csess_';

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };

function secret() {
  const e = process.env;
  return crypto.createHmac('sha256', 'ff-customer-session-v1').update([e.DB_PASS, e.CACHE_CLEAR_KEY].map(s).join('|')).digest();
}
const mac = (v) => crypto.createHmac('sha256', secret()).update(String(v)).digest('base64url');
const phoneTag = (ph) => crypto.createHmac('sha256', secret()).update('ph|' + ph).digest('hex').slice(0, 16);
const keyFor = (ph, id) => KEY_PREFIX + phoneTag(ph) + '_' + id;
const likeFor = (ph) => KEY_PREFIX + phoneTag(ph) + '\\_%';
const sameText = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

/** "Chrome · Android" style label for admin / Account (no IP, no full user agent stored). */
function deviceLabel(ua) {
  const u = s(ua);
  const os = /android/i.test(u) ? 'Android' : /iphone|ipad|ios/i.test(u) ? 'iPhone' : /windows/i.test(u) ? 'Windows' : /mac os/i.test(u) ? 'Mac' : /linux/i.test(u) ? 'Linux' : '';
  const br = /edg\//i.test(u) ? 'Edge' : /samsungbrowser/i.test(u) ? 'Samsung Internet' : /opr\//i.test(u) ? 'Opera' : /chrome|crios/i.test(u) ? 'Chrome' : /firefox|fxios/i.test(u) ? 'Firefox' : /safari/i.test(u) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || 'Browser';
}

// ---------------- sessions ----------------
const cache = new Map(); // key -> { rec, at }

function parseToken(token) {
  const parts = s(token).split('.');
  if (parts.length !== 5 || parts[0] !== 'cs1') return null;
  const [, ph, iat, id, sig] = parts;
  if (!/^\d{10}$/.test(ph) || !/^\d{10,15}$/.test(iat) || !/^[A-Za-z0-9_-]{24}$/.test(id)) return null;
  if (!sameText(sig, mac('cs1.' + ph + '.' + iat + '.' + id))) return null;
  return { ph, iat: Number(iat), id };
}

async function createSession(phone, meta, now) {
  const ph = norm(phone);
  if (ph.length !== 10) return null;
  now = now || Date.now();
  const id = crypto.randomBytes(18).toString('base64url');
  const payload = 'cs1.' + ph + '.' + now + '.' + id;
  const rec = { ph, iat: now, exp: now + SESSION_MS, seen: now, dev: deviceLabel(meta && meta.userAgent) };
  const k = keyFor(ph, id);
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)', [k, JSON.stringify(rec)]);
  cache.set(k, { rec, at: now });
  sweep(now);
  return payload + '.' + mac(payload);
}

/** → { ph, id, key, slid } or null. Checks the signature AND the stored record (so a revoked token is dead). */
async function validate(token, now) {
  now = now || Date.now();
  const t = parseToken(token);
  if (!t) return null;
  const k = keyFor(t.ph, t.id);
  let rec;
  const hit = cache.get(k);
  if (hit && now - hit.at < CACHE_MS) rec = hit.rec;
  else {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [k]);
    if (!rows || !rows[0]) { cache.delete(k); return null; }
    try { rec = JSON.parse(String(rows[0].value)); } catch (_) { return null; }
    cache.set(k, { rec, at: now });
  }
  if (!rec || rec.ph !== t.ph || !(Number(rec.exp) > now)) { cache.delete(k); return null; }
  let slid = false;
  if (now - Number(rec.seen || 0) > SLIDE_EVERY_MS) {
    const next = Object.assign({}, rec, { seen: now, exp: now + SESSION_MS });
    try {
      const r = await db.query('UPDATE app_settings SET value = ? WHERE setting_key = ?', [JSON.stringify(next), k]);
      if (r && r.affectedRows != null && Number(r.affectedRows) === 0) { cache.delete(k); return null; } // revoked meanwhile
      cache.set(k, { rec: next, at: now }); slid = true;
    } catch (e) { console.log('[email-login] could not slide session:', e.message); }
  }
  return { ph: t.ph, id: t.id, key: k, slid };
}

async function revoke(token) {
  const t = parseToken(token);
  if (!t) return false;
  const k = keyFor(t.ph, t.id);
  cache.delete(k);
  await db.query('DELETE FROM app_settings WHERE setting_key = ?', [k]);
  return true;
}

async function revokeAll(phone) {
  const ph = norm(phone);
  if (ph.length !== 10) return 0;
  const prefix = KEY_PREFIX + phoneTag(ph) + '_';
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  const r = await db.query('DELETE FROM app_settings WHERE setting_key LIKE ?', [likeFor(ph)]);
  return Number((r && r.affectedRows) || 0);
}

async function listSessions(phone, now) {
  const ph = norm(phone);
  now = now || Date.now();
  if (ph.length !== 10) return [];
  const rows = await db.query('SELECT setting_key, value FROM app_settings WHERE setting_key LIKE ? LIMIT 100', [likeFor(ph)]);
  return (rows || []).map((r) => { try { return Object.assign({ key: String(r.setting_key) }, JSON.parse(String(r.value))); } catch (_) { return null; } })
    .filter((x) => x && x.ph === ph && Number(x.exp) > now)
    .sort((a, b) => Number(b.seen) - Number(a.seen))
    .map((x) => ({ id: x.key.slice(-6), device: x.dev || 'Browser', createdAt: new Date(Number(x.iat)).toISOString(), lastSeen: new Date(Number(x.seen)).toISOString(), expiresAt: new Date(Number(x.exp)).toISOString() }));
}

let lastSweep = 0;
function sweep(now) {
  if (now - lastSweep < 6 * 3600e3) return;
  lastSweep = now;
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  // updated_at moves every time a session slides, so anything untouched for 181 days has expired.
  Promise.resolve().then(() => db.query('DELETE FROM app_settings WHERE setting_key LIKE ? AND updated_at < (NOW() - INTERVAL 181 DAY)', ['csess\\_%'])).catch(() => {});
}

// ---------------- cookie ----------------
function readCookie(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return ''; } }
  }
  return '';
}
function isLocal(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String((req && req.headers && req.headers.host) || '')); }
function cookieHeader(req, token, maxAgeSec) {
  return COOKIE + '=' + encodeURIComponent(token || '') + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.max(0, Math.floor(maxAgeSec)) + (isLocal(req) ? '' : '; Secure');
}
const setCookie = (req, res, token) => res.append('Set-Cookie', cookieHeader(req, token, SESSION_MS / 1000));
const clearCookie = (req, res) => res.append('Set-Cookie', cookieHeader(req, '', 0));

async function sessionFromReq(req, now) {
  const tok = readCookie(req);
  if (!tok) return null;
  try { const v = await validate(tok, now); return v ? Object.assign(v, { token: tok }) : null; }
  catch (e) { console.log('[email-login] session check failed:', e.message); return null; }
}

// ---------------- login flow ----------------
const NO_EMAIL = "We don't have an email for this number. Tap Help (WhatsApp) and we'll add it for you.";

async function start(phone, opts) {
  opts = opts || {};
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Enter your 10-digit phone number.' };
  const lo = await emaillock.loginOptions(ph, opts.now);
  if (!lo.list.length) {
    if (!(await emaillock.phoneKnown(ph))) return { ok: true, newCustomer: true, phone: ph };
    return { ok: false, noEmail: true, message: NO_EMAIL };
  }
  const target = s(opts.target) && lo.options.some((o) => o.id === s(opts.target)) ? s(opts.target) : lo.options[0].id;
  const r = await emaillock.sendCode(ph, 'login', { target, now: opts.now, mailer: opts.mailer });
  return Object.assign({}, r, { phone: ph, target, maskedEmail: r.maskedEmail || (lo.options.find((o) => o.id === target) || {}).maskedEmail, options: lo.options.length > 1 ? lo.options : [] });
}

async function signup(phone, name, email, opts) {
  opts = opts || {};
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Enter your 10-digit phone number.' };
  const nm = s(name).replace(/[<>]/g, '');
  if (nm.length < 2 || nm.length > 60) return { ok: false, field: 'name', message: 'Please enter your name.' };
  const r = await emaillock.sendCode(ph, 'signup', { email, now: opts.now, mailer: opts.mailer });
  return Object.assign({}, r, { phone: ph });
}

async function verify(phone, code, opts, meta) {
  opts = opts || {};
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Enter your 10-digit phone number.' };
  if (opts.mode === 'signup') {
    const nm = s(opts.name).replace(/[<>]/g, '');
    if (nm.length < 2 || nm.length > 60) return { ok: false, field: 'name', message: 'Please enter your name.' };
    const v = await emaillock.verifyCode(ph, 'signup', code, { email: opts.email, now: opts.now });
    if (!v.ok) return v;
    // The code proved the email: the new profile is saved as verified (account.js reads the signed 'new' token).
    const account = require('./account');
    const made = await account.createOrUpdateCustomerProfile({ name: nm, phone: ph, email: v.email, emailToken: emaillock._internal.makeToken('new', ph, v.email, opts.now), referralCode: opts.referralCode });
    if (!made || !made.ok) return { ok: false, message: (made && made.message) || 'Could not create your account. Please try again.' };
    const token = await createSession(ph, meta, opts.now);
    return { ok: true, token, phone: ph, newCustomer: true, maskedEmail: v.maskedEmail, message: 'Welcome to FluxFilm 🎉' };
  }
  const v = await emaillock.verifyCode(ph, 'login', code, { target: opts.target, now: opts.now });
  if (!v.ok) return v;
  const token = await createSession(ph, meta, opts.now);
  return { ok: true, token, phone: ph, maskedEmail: v.maskedEmail, message: 'Logged in ✅' };
}

// ---------------- which actions need a session ----------------
// at: where the customer's phone is in args. i = args[i] · { i, key } = args[i][key].
// kind: 'public' · 'session' (refused without one) · 'soft' (no session → the phone is removed, so only an
// order token or no-phone behaviour is left) · 'self' (session needed, no phone argument).
// order / sub: args[n] is an order id / subscription id that must belong to the session phone.
const P = { kind: 'public' };
const S = (at, extra) => Object.assign({ kind: 'session', at }, extra || {});
const SOFT = (at, extra) => Object.assign({ kind: 'soft', at }, extra || {});
const POLICY = {
  // catalog, stock, offers, feed read, SEO, store status: public
  getBootstrap: P, getStockLevels: P, getTrendingItems: P, getStoreStatus: P, getPromos: P, promoEvent: P,
  getPushKey: P, pushUnsubscribe: P, getFeed: P, feedEvent: P, getFeedComments: P, getFeedCommentPreviews: P,
  getGamesStatus: P, checkReferral: P,
  getNetflixHouseholdLink: P, // needs the shared account's login email, not a customer's data
  submitRestockRequest: P, // "tell me when it's back" — writes a request, reveals nothing
  // Recover keeps its own email-code flow (for customers who lost access). A successful code also logs in.
  recoverSendOtp: P, recoverVerifyOtp: P, recoverListSubscriptionsSafe: P, recoverGetAccess: P, recoverReassignAccount: P,
  // login itself
  loginStatus: P, loginStart: P, loginSignup: P, loginVerify: P, logout: P,
  logoutAll: { kind: 'self' },
  // profile, plans, orders, wallet, coupons
  getMySubscriptions: S(0), getCustomerOrders: S(0), getCustomerProfile: S(0), getActiveCouponsForCustomer: S(0), getWalletByPhone: S(0),
  createOrUpdateCustomerProfile: S({ i: 0, key: 'phone' }), createCustomerProfile: S({ i: 0, key: 'phone' }), changeProfileEmail: S({ i: 0, key: 'phone' }),
  updateCustomerProfilePic: S(0), setProfilePhoto: S(0), removeProfilePhoto: S(0), setAvatar: S(0),
  emailLockStatus: S(0), emailSendCode: S(0), emailVerifyCode: S(0),
  getResumePaymentByPhone: S(0), getReferralInfo: S(0), getCoinQuote: S(0), getCoinHistory: S(0),
  pushSubscribe: S(0), addFeedComment: S(0),
  // checkout + payment (buying needs login: phone → email code → pay)
  createOrder: S({ i: 0, key: 'phone' }), createRenewOrder: S(null, { sub: 0 }),
  validateCoupon: SOFT({ i: 1, key: 'phone' }),
  getOrderStatus: S(null, { order: 0 }), verifyPayment: S(null, { order: 0 }), verifyPaymentByRef: S(null, { order: 0 }),
  // credentials + payment fallback: the order's own access token still works (a phone alone no longer does)
  fulfillAndGetAccess: SOFT({ i: 1, key: 'phone' }, { order: 0 }), confirmFreeOrder: SOFT({ i: 1, key: 'phone' }, { order: 0 }),
  getBackupPayment: SOFT({ i: 1, key: 'phone' }, { order: 0 }), claimManualPayment: SOFT({ i: 1, key: 'phone' }, { order: 0 }), getClaimStatus: SOFT({ i: 1, key: 'phone' }, { order: 0 }),
  // Get OTP
  getLatestOtp: S(1), getOtpQuota: S(0), otpSendCode: S(0), otpVerifyCode: S(0),
  // Games, refunds, Olivia
  getGamesHome: SOFT(0), // logged out = the games page for visitors ("Log in to play")
  gameStart: S(0), gameStep: S(0), gameFinish: S(0), gamesSendCode: S(0),
  getPendingRefunds: S(0), convertRefundToCredit: S(0), refundSendCode: S(0), requestUpiRefund: S(0),
  // Refunds v3 (PR 118): choose coins / coupon / UPI, "sent" pop-up seen, Account → Request refund
  chooseRefund: S(0), refundSentSeen: S(0), getRefundRequestItems: S(0), createRefundRequest: S(0),
  // What's new (PR 113): ❤️ likes / 🔖 saves follow the account
  setFeedMark: S(0), getFeedMarks: S(0), importFeedMarks: S(0),
  oliviaStatus: SOFT(0), oliviaChat: S(0), oliviaHistory: S(0), oliviaTranscript: S(0),
};

function readAt(a, at) {
  if (at == null) return '';
  if (typeof at === 'number') return norm(a[at]);
  const o = a[at.i];
  return o && typeof o === 'object' ? norm(o[at.key]) : '';
}
function writeAt(a, at, value) {
  if (at == null) return;
  if (typeof at === 'number') { a[at] = value; return; }
  const o = a[at.i] && typeof a[at.i] === 'object' && !Array.isArray(a[at.i]) ? Object.assign({}, a[at.i]) : {};
  if (value) o[at.key] = value; else delete o[at.key];
  a[at.i] = o;
}

const LOGIN_REQUIRED = { ok: false, loginRequired: true, message: 'Please log in again — we will send a code to your email. 🔐' };
const OTHER_PHONE = { ok: false, loginRequired: true, otherPhone: true, message: 'You are logged in with a different number here. Please log in with this number.' };

async function ownerOf(table, id) {
  const sql = table === 'orders' ? 'SELECT phone_norm FROM orders WHERE order_id = ? LIMIT 1' : 'SELECT phone_norm FROM subscriptions WHERE sub_id = ? LIMIT 1';
  const rows = await db.query(sql, [s(id)]);
  return rows && rows[0] ? norm(rows[0].phone_norm) : null;
}

/**
 * Called by server.js before any storefront action. Mutates `a` (the phone becomes the session's phone).
 * → { ok: true, session } or { ok: false, status, body }
 * deps.required() → is the email login switched on (store.emailLoginRequired).
 */
async function guard(action, a, req, deps) {
  const pol = POLICY[action] || { kind: 'session', at: null }; // unknown = needs a session (deny by default)
  if (pol.kind === 'public') return { ok: true, session: null };
  const required = deps && deps.required ? await deps.required() : true;
  if (!required) return { ok: true, session: null, legacy: true };
  const sess = await sessionFromReq(req);
  const sent = readAt(a, pol.at);
  if (!sess) {
    if (pol.kind === 'soft') { writeAt(a, pol.at, ''); return { ok: true, session: null }; }
    return { ok: false, status: 401, body: LOGIN_REQUIRED };
  }
  if (sent && sent !== sess.ph) return { ok: false, status: 401, body: OTHER_PHONE };
  writeAt(a, pol.at, sess.ph);
  for (const [field, table] of [['order', 'orders'], ['sub', 'subscriptions']]) {
    if (pol[field] == null || !s(a[pol[field]])) continue;
    const owner = await ownerOf(table, a[pol[field]]);
    if (owner && owner !== sess.ph) return { ok: false, status: 403, body: { ok: false, message: table === 'orders' ? 'Order not found for this number.' : 'Plan not found for this number.' } };
  }
  return { ok: true, session: sess };
}

// ---------------- /api handlers for the login itself (need res for the cookie) ----------------
async function handle(action, a, req, res, deps) {
  const required = deps && deps.required ? await deps.required() : true;
  const meta = { userAgent: req && req.headers ? req.headers['user-agent'] : '' };
  if (action === 'loginStatus') {
    const sess = await sessionFromReq(req);
    if (sess && sess.slid) setCookie(req, res, sess.token);
    let maskedEmail = '';
    if (sess) { try { const lo = await emaillock.loginOptions(sess.ph); maskedEmail = (lo.options[0] || {}).maskedEmail || ''; } catch (_) { /* optional */ } }
    return { ok: true, required, loggedIn: !!sess, phone: sess ? sess.ph : '', maskedEmail };
  }
  if (action === 'loginStart') return start(a[0], { target: a[1] });
  if (action === 'loginSignup') return signup(a[0], a[1], a[2]);
  if (action === 'loginVerify') {
    const o = a[2] && typeof a[2] === 'object' ? a[2] : {};
    const r = await verify(a[0], a[1], { mode: o.mode === 'signup' ? 'signup' : 'login', target: o.target, name: o.name, email: o.email, referralCode: o.referralCode }, meta);
    if (r.ok && r.token) {
      // A new login on this browser replaces the one it had (another number, or the same one).
      const old = readCookie(req);
      if (old) { try { await revoke(old); } catch (_) { /* best effort */ } }
      setCookie(req, res, r.token);
    }
    const out = Object.assign({}, r); delete out.token;
    return out;
  }
  if (action === 'logout') {
    const tok = readCookie(req);
    if (tok) { try { await revoke(tok); } catch (e) { console.log('[email-login] logout revoke failed:', e.message); } }
    clearCookie(req, res);
    return { ok: true, message: 'Logged out.' };
  }
  if (action === 'logoutAll') {
    const sess = await sessionFromReq(req);
    if (!sess) { clearCookie(req, res); return LOGIN_REQUIRED; }
    const n = await revokeAll(sess.ph);
    clearCookie(req, res);
    return { ok: true, revoked: n, message: 'Logged out on all devices.' };
  }
  return { ok: false, message: 'Unknown login action.' };
}
const LOGIN_ACTIONS = new Set(['loginStatus', 'loginStart', 'loginSignup', 'loginVerify', 'logout', 'logoutAll']);

/** After a successful Recover code: the customer proved an email on this phone's plan, so this browser is logged in. */
async function afterRecoverVerified(phone, req, res) {
  try {
    const tok = await createSession(phone, { userAgent: req && req.headers ? req.headers['user-agent'] : '' });
    if (tok) setCookie(req, res, tok);
  } catch (e) { console.log('[email-login] recover session failed:', e.message); }
}

module.exports = {
  COOKIE, SESSION_DAYS, POLICY, LOGIN_ACTIONS, guard, handle, start, signup, verify, afterRecoverVerified,
  createSession, validate, revoke, revokeAll, listSessions, sessionFromReq, cookieHeader, readCookie, deviceLabel,
  _internal: { cache, parseToken, keyFor, phoneTag, SESSION_MS, SLIDE_EVERY_MS, CACHE_MS },
};
