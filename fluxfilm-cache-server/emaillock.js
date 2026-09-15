/**
 * FluxFilm - profile email lock (15 Sep 2026).
 *
 * WHY: login is by phone number only, and a phone number is not a secret. Before this, anyone who knew a number could
 * overwrite that customer's profile email; checkout (and Olivia) used the profile email as the ORDER email, so the
 * victim's next login email went to the attacker, and that order then counted as a "paid order email" for Recover /
 * Get OTP / Games / Refunds.
 *
 * RULES
 *  - Changing an EXISTING email needs a 6-digit code sent to the NEW address (proves the customer owns it).
 *  - If the customer has an ACTIVE plan, it also needs a code to an OLD address they already proved: the current
 *    profile email when it is verified, or an email on an active plan (its subscription row, or the PAID order that
 *    created it). Nobody can write those without a code or a payment, so an attacker who only knows the phone can
 *    never receive that code. When every old address is dead: "Contact Help" (admin can change it, admin key).
 *  - First email (new profile, or a row with no email yet) needs no code, but is saved as NOT verified.
 *  - Checkout asks for a code to the profile email only when it is not verified AND (it was set/changed in the last
 *    24 h, or it differs from the email on the customer's last PAID + FULFILLED order). Verified / unchanged = no step.
 *  - Customers from before this change (raw_json has no EmailVerified key): their email counts as verified when a
 *    paid order already delivered its login to that same address. Nobody is locked out; nothing is migrated.
 *  - Renewals never need a code: they use the profile email when it is trusted, otherwise the email on the plan
 *    being renewed (which already received that plan's login).
 *
 * State: customers.raw_json EmailVerified / EmailVerifiedAt / EmailVerifiedEmail / EmailVerifiedBy / EmailChangedAt /
 * PreviousEmail (typed customers.email stays the one address). No schema change.
 * Codes, tries and send caps live in app_settings ('emlk_…', codes HMAC-hashed), claimed with INSERT or a
 * compare-and-swap UPDATE, so they are atomic and survive a restart. Memory is the fallback when the DB is down.
 *
 * NOTE (cleanup later): atomic()/memAtomic() and the secret derivation duplicate the ones in otpaccess.js from PRs
 * #111/#114 (not on main yet). After those merge, move both onto one shared helper.
 *
 *   status(phone, subId?)                         → what the storefront needs to show (masked emails only)
 *   sendCode(phone, purpose, { email, target })   purpose: 'new' | 'old' | 'confirm' | 'login' | 'signup' (🔐 customerauth.js)
 *   loginOptions(ph) / phoneKnown(ph)             → trusted login emails (never a recently changed unverified one)
 *   verifyCode(phone, purpose, code, { email, target }) → 'new'/'old': { token } · 'confirm': marks verified
 *   authorizeChange(phone, curEmail, newEmail, newToken, oldToken) → { ok } (used by account.js)
 *   orderEmail(phone, requestedEmail)            → { ok, email } or { ok:false, emailCheck | emailChangeRequired }
 *   renewEmail(phone, subEmail)                  → the email a renewal's login goes to
 */
const crypto = require('crypto');
const db = require('./db');

const CODE_TTL_MS = 10 * 60e3;
const RESEND_AFTER_MS = 30e3;
const MAX_TRIES = 5;
const SENDS_PER_PHONE_HOUR = 6;
const SENDS_PER_EMAIL_HOUR = 4;
const TOKEN_TTL_MS = 30 * 60e3;
const RECENT_MS = 24 * 3600e3;

const GENERIC_SEND = 'We could not send a code right now. Please try again, or tap Help.';
const GENERIC_CHANGE = 'For your safety, we could not change the email. Please confirm it with the code, or tap Help.';

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const normEmail = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 120;
const rawOf = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } };
function maskEmail(e) {
  const x = s(e);
  const at = x.indexOf('@');
  if (at < 1) return '';
  const l = x.slice(0, at);
  return (l.length <= 2 ? l[0] : l.slice(0, 2)) + '***' + x.slice(at);
}

function secret() {
  const e = process.env;
  const base = [e.DB_PASS, e.CACHE_CLEAR_KEY, e.IMAP_PASS, e.OTP_ACCESS_SECRET].map(s).join('|');
  return crypto.createHmac('sha256', 'ff-emaillock-v1').update(base).digest();
}
const mac = (v) => crypto.createHmac('sha256', secret()).update(String(v)).digest('hex');
const emailHash = (em) => mac('em|' + normEmail(em)).slice(0, 32);
const sameText = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const optionId = (ph, em) => mac('opt|' + ph + '|' + normEmail(em)).slice(0, 16);

// ---------------- India dates (an expiry DAY counts as active all day) ----------------
const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
function expiryDay(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? IST_DAY.format(v) : '';
  const x = s(v);
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(x)) { const t = new Date(x); return Number.isFinite(t.getTime()) ? IST_DAY.format(t) : ''; }
  const m = x.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
const todayIST = (now) => IST_DAY.format(new Date(now || Date.now()));

// ---------------- reads ----------------
async function loadCustomer(ph) {
  const r = await db.query('SELECT phone, name, email, raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  return r && r[0] ? r[0] : null;
}
/** Emails of PAID + FULFILLED orders (login delivered), newest first. */
async function paidEmails(ph) {
  const r = await db.query("SELECT email FROM orders WHERE phone_norm = ? AND UPPER(status) = 'PAID' AND UPPER(fulfillment_status) = 'FULFILLED' AND email IS NOT NULL AND email <> '' ORDER BY created_at_sheet DESC LIMIT 50", [ph]);
  return (r || []).map((o) => normEmail(o.email)).filter(Boolean);
}
function subBlocked(r, now) {
  if (Number(r.removed) === 1) return true;
  const st = up(r.status); const fs = up(r.fulfillment_status);
  if (st === 'REFUNDED' || st === 'REMOVED' || /^CANCEL/.test(st) || fs === 'REFUNDED' || fs === 'REMOVED' || /^CANCEL/.test(fs)) return true;
  const day = expiryDay(r.expiry_date);
  return !day || day < todayIST(now);
}
/** { active, emails }: does the phone have an active plan, and which emails belong to those plans. */
async function activePlanEmails(ph, now) {
  let rows;
  try { rows = await db.query('SELECT order_id, email, expiry_date, status, fulfillment_status, COALESCE(removed, 0) AS removed FROM subscriptions WHERE phone_norm = ?', [ph]); }
  catch (e) {
    if (!/removed/i.test(String(e && e.message))) throw e;
    rows = await db.query('SELECT order_id, email, expiry_date, status, fulfillment_status FROM subscriptions WHERE phone_norm = ?', [ph]); // before schema-v13
  }
  const active = (rows || []).filter((r) => !subBlocked(r, now));
  const emails = [];
  const add = (e) => { const x = normEmail(e); if (x && validEmail(x) && !emails.includes(x)) emails.push(x); };
  active.forEach((r) => add(r.email));
  const ids = [...new Set(active.map((r) => s(r.order_id)).filter(Boolean))];
  if (ids.length) {
    const os = await db.query('SELECT email FROM orders WHERE order_id IN (' + ids.map(() => '?').join(', ') + ") AND UPPER(status) = 'PAID'", ids);
    (os || []).forEach((o) => add(o.email));
  }
  return { active: active.length > 0, emails };
}

/** Everything about one phone's email. */
async function stateFor(ph, now) {
  now = now || Date.now();
  const c = await loadCustomer(ph);
  const email = c ? normEmail(c.email) : '';
  if (!c || !email) return { customer: c, email: '', hasEmail: false, verified: false, needsCode: false };
  const raw = rawOf(c.raw_json);
  const paid = await paidEmails(ph);
  // The admin row editor saves every raw_json value back as text, so "true" / "false" count too.
  const flag = /^true$/i.test(s(raw.EmailVerified)) ? true : /^false$/i.test(s(raw.EmailVerified)) ? false : undefined;
  const explicit = flag === true && normEmail(raw.EmailVerifiedEmail || email) === email;
  // Before this change nobody had the flag: the address a paid order already delivered a login to is trusted.
  const legacy = flag === undefined && paid.includes(email);
  const verified = explicit || legacy;
  const changedAt = Date.parse(s(raw.EmailChangedAt));
  const recent = Number.isFinite(changedAt) && now - changedAt < RECENT_MS && now >= changedAt - 60e3;
  const lastPaid = paid[0] || '';
  const needsCode = !verified && (recent || (!!lastPaid && lastPaid !== email));
  return { customer: c, raw, email, hasEmail: true, verified, legacy, needsCode, lastPaid };
}

/** Old addresses that may confirm a change: the verified profile email + emails on active plans. */
async function oldOptions(ph, st, now) {
  const plan = await activePlanEmails(ph, now);
  const list = [];
  if (st.hasEmail && st.verified) list.push(st.email);
  plan.emails.forEach((e) => { if (!list.includes(e)) list.push(e); });
  return { active: plan.active, list };
}

/**
 * 🔐 Email login (customerauth.js): the emails a login code may go to, best first. Only addresses a stranger who
 * knows the phone cannot have written: the VERIFIED profile email, emails on subscriptions (active first, then past,
 * newest expiry first) and emails on PAID + FULFILLED orders (newest first). An unverified profile email is used
 * only when there is nothing else AND it was not set in the last 24 h AND no paid order contradicts it.
 * → { list: [email…] (max 4), options: [{ id, maskedEmail }] }
 */
async function loginOptions(ph, now) {
  now = now || Date.now();
  const st = await stateFor(ph, now);
  const list = [];
  const add = (e) => { const x = normEmail(e); if (x && validEmail(x) && !list.includes(x)) list.push(x); };
  if (st.hasEmail && st.verified) add(st.email);
  let subs;
  try { subs = await db.query('SELECT order_id, email, expiry_date, status, fulfillment_status, COALESCE(removed, 0) AS removed FROM subscriptions WHERE phone_norm = ?', [ph]); }
  catch (e) {
    if (!/removed/i.test(String(e && e.message))) throw e;
    subs = await db.query('SELECT order_id, email, expiry_date, status, fulfillment_status FROM subscriptions WHERE phone_norm = ?', [ph]); // before schema-v13
  }
  const byExpiry = (a, b) => (expiryDay(b.expiry_date) > expiryDay(a.expiry_date) ? 1 : expiryDay(b.expiry_date) < expiryDay(a.expiry_date) ? -1 : 0);
  const rows = (subs || []).slice();
  rows.filter((r) => !subBlocked(r, now)).sort(byExpiry).forEach((r) => add(r.email));
  (await paidEmails(ph)).forEach(add);
  rows.filter((r) => subBlocked(r, now)).sort(byExpiry).forEach((r) => add(r.email));
  if (!list.length && st.hasEmail && !st.verified && !st.needsCode) {
    const changedAt = Date.parse(s(st.raw && st.raw.EmailChangedAt));
    const recent = Number.isFinite(changedAt) && now - changedAt < RECENT_MS;
    if (!recent) add(st.email);
  }
  const top = list.slice(0, 4);
  return { list: top, options: top.map((e) => ({ id: optionId(ph, e), maskedEmail: maskEmail(e) })), customer: st.customer, profileEmail: st.email };
}
/** Has this phone ever been seen (profile, order or subscription)? New customers may sign up; known ones log in. */
async function phoneKnown(ph) {
  if (await loadCustomer(ph)) return true;
  const o = await db.query('SELECT COUNT(*) AS n FROM orders WHERE phone_norm = ?', [ph]);
  if (Number((o && o[0] || {}).n) > 0) return true;
  const sub = await db.query('SELECT COUNT(*) AS n FROM subscriptions WHERE phone_norm = ?', [ph]);
  return Number((sub && sub[0] || {}).n) > 0;
}

/** Storefront: masked emails only. subId (optional) = the plan being renewed. */
async function status(phone, subId, now) {
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your phone number.' };
  const st = await stateFor(ph, now);
  const out = { ok: true, hasEmail: st.hasEmail, maskedEmail: maskEmail(st.email), verified: !!st.verified, needsCode: !!st.needsCode };
  if (st.hasEmail) {
    const opt = await oldOptions(ph, st, now);
    out.activePlan = opt.active;
    out.oldOptions = opt.active ? opt.list.map((e) => ({ id: optionId(ph, e), maskedEmail: maskEmail(e) })) : [];
  }
  if (s(subId)) {
    const r = await db.query('SELECT email, phone_norm FROM subscriptions WHERE sub_id = ? LIMIT 1', [s(subId)]);
    if (r && r[0] && norm(r[0].phone_norm) === ph) out.renewMaskedEmail = maskEmail(await renewEmailFromState(st, r[0].email));
  }
  return out;
}

// ---------------- app_settings store (memory when the DB can't be used) ----------------
const mem = new Map();
const parse = (raw) => { try { return JSON.parse(raw); } catch (_) { return null; } };
const codeKey = (ph, em, purpose) => 'emlk_c_' + mac('c|' + purpose + '|' + ph + '|' + em).slice(0, 40);
const phoneKey = (ph) => 'emlk_p_' + mac('p|' + ph).slice(0, 40);
const emailKey = (em) => 'emlk_e_' + mac('e|' + em).slice(0, 40);
const codeHash = (ph, em, code, purpose) => mac('code|' + purpose + '|' + ph + '|' + em + '|' + code);
async function del(k) {
  mem.delete(k);
  try { await db.query('DELETE FROM app_settings WHERE setting_key = ?', [k]); } catch (_) { /* memory only */ }
}
let lastSweep = 0;
function sweep() {
  if (Date.now() - lastSweep < 10 * 60e3) return;
  lastSweep = Date.now();
  for (const [k, v] of mem) { const x = parse(v); if (!x || Date.now() > Number(x.exp)) mem.delete(k); }
  Promise.resolve().then(() => db.query('DELETE FROM app_settings WHERE setting_key LIKE ? AND updated_at < (NOW() - INTERVAL 2 HOUR)', ['emlk\\_%'])).catch(() => {});
}
async function peek(k) {
  if (mem.has(k)) return parse(mem.get(k));
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [k]); return r && r[0] ? parse(String(r[0].value)) : null; } catch (_) { return null; }
}
/** Atomic read-modify-write of one JSON record: fn(rec|null) -> { next, result } (write) or { result } (no write). */
async function atomic(k, fn) {
  for (let i = 0; i < 25; i++) {
    if (mem.has(k)) return memAtomic(k, fn);
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
      if (raw == null && (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /duplicate/i.test(String(e.message))))) continue;
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
function capStep(now, max) {
  return (rec) => {
    if (!rec || now > Number(rec.exp)) return { next: { n: 1, exp: now + 3600e3 }, result: { ok: true } };
    if (Number(rec.n) >= max) return { result: { ok: false } };
    return { next: { n: Number(rec.n) + 1, exp: rec.exp }, result: { ok: true } };
  };
}

// ---------------- which address a purpose sends to ----------------
/** { ok, em } or { ok:false, message }. Re-derived on send AND on verify (never trusts the client). */
async function targetFor(ph, purpose, opts, now) {
  // 🔐 Email login: 'login' = a trusted email of a known phone (the client only picks an option id);
  // 'signup' = the email a brand-new customer typed (only while the phone is unknown everywhere).
  if (purpose === 'login') {
    const lo = await loginOptions(ph, now);
    const em = s(opts.target) ? lo.list.find((e) => optionId(ph, e) === s(opts.target)) : lo.list[0];
    if (!em) return { ok: false, message: GENERIC_SEND };
    return { ok: true, em, st: { email: lo.profileEmail } };
  }
  if (purpose === 'signup') {
    const em = normEmail(opts.email);
    if (!validEmail(em)) return { ok: false, message: 'Enter a valid email address, like name@gmail.com.' };
    if (await phoneKnown(ph)) return { ok: false, known: true, message: 'This number already has a FluxFilm account. Go back and log in.' };
    return { ok: true, em, st: {} };
  }
  const st = await stateFor(ph, now);
  if (!st.customer) return { ok: false, message: GENERIC_SEND };
  if (purpose === 'confirm') {
    if (!st.hasEmail) return { ok: false, message: GENERIC_SEND };
    return { ok: true, em: st.email, st };
  }
  if (purpose === 'new') {
    const em = normEmail(opts.email);
    if (!validEmail(em)) return { ok: false, message: 'Enter a valid email address, like name@gmail.com.' };
    if (st.hasEmail && em === st.email) return { ok: false, same: true, message: 'This is already your email.' };
    return { ok: true, em, st };
  }
  if (purpose === 'old') {
    if (!st.hasEmail) return { ok: false, message: GENERIC_SEND };
    const opt = await oldOptions(ph, st, now);
    const em = opt.list.find((e) => optionId(ph, e) === s(opts.target));
    if (!opt.active || !em) return { ok: false, message: GENERIC_SEND };
    return { ok: true, em, st };
  }
  return { ok: false, message: GENERIC_SEND };
}

const PURPOSES = new Set(['new', 'old', 'confirm', 'login', 'signup']);

async function sendCode(phone, purpose, opts) {
  opts = opts || {};
  const mailer = opts.mailer || require('./mailer');
  const now = opts.now || Date.now();
  sweep();
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter your phone number.' };
  if (!PURPOSES.has(purpose)) return { ok: false, message: GENERIC_SEND };
  const t = await targetFor(ph, purpose, opts, now);
  if (!t.ok) return { ok: false, same: !!t.same, known: !!t.known, message: t.message };
  const em = t.em;
  const k = codeKey(ph, em, purpose);
  const prev = await peek(k);
  if (prev && now <= Number(prev.exp) && now - Number(prev.sentAt || 0) < RESEND_AFTER_MS) {
    return { ok: true, resent: false, waitSeconds: Math.ceil((RESEND_AFTER_MS - (now - Number(prev.sentAt))) / 1000), maskedEmail: maskEmail(em), message: 'Code already sent - check your email (and Spam).' };
  }
  const capP = await atomic(phoneKey(ph), capStep(now, SENDS_PER_PHONE_HOUR));
  if (!capP || !capP.ok) return { ok: false, rateLimited: true, message: 'Too many codes for this number. Please wait an hour, or tap Help.' };
  const capE = await atomic(emailKey(em), capStep(now, SENDS_PER_EMAIL_HOUR));
  if (!capE || !capE.ok) return { ok: false, rateLimited: true, message: 'Too many codes for this email. Please wait an hour, or tap Help.' };
  const code = String(crypto.randomInt(100000, 1000000));
  const claim = await atomic(k, (rec) => {
    if (rec && now <= Number(rec.exp) && now - Number(rec.sentAt || 0) < RESEND_AFTER_MS) return { result: { wait: true } };
    return { next: { h: codeHash(ph, em, code, purpose), exp: now + CODE_TTL_MS, tries: 0, sentAt: now }, result: { ok: true } };
  });
  if (claim && claim.wait) return { ok: true, resent: false, waitSeconds: 30, maskedEmail: maskEmail(em), message: 'Code already sent - check your email (and Spam).' };
  if (!claim || !claim.ok) return { ok: false, message: GENERIC_SEND };
  const why = purpose === 'new' ? 'to make this your FluxFilm email' : purpose === 'old' ? 'to confirm it is you before your FluxFilm email is changed'
    : purpose === 'login' ? 'to log in to FluxFilm' : purpose === 'signup' ? 'to finish creating your FluxFilm account' : 'to confirm your FluxFilm email before you pay';
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto">' +
    '<h2 style="color:#16a34a;margin-bottom:4px">🔒 Your FluxFilm code</h2>' +
    '<p style="color:#475569">Enter this code ' + why + '. It expires in 10 minutes.</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:14px 0">' + code + '</div>' +
    '<p style="color:#94a3b8;font-size:12px">Did not ask for this? Do not share this code with anyone. Nothing changes without it. 💚</p></div>';
  try {
    const r = await mailer.send(em, 'Your FluxFilm code: ' + code, html);
    if (r && r.ok === false) throw new Error(r.skipped || 'email not sent');
  } catch (e) {
    await del(k);
    console.log('[email-lock] code email failed:', e.message);
    return { ok: false, message: GENERIC_SEND };
  }
  return { ok: true, waitSeconds: 30, maskedEmail: maskEmail(em), message: 'We sent a 6-digit code. It can take a minute - check Spam too.' };
}

async function verifyCode(phone, purpose, code, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const ph = norm(phone);
  const c = s(code).replace(/\D/g, '');
  if (c.length !== 6) return { ok: false, message: 'Enter the 6-digit code from the email.' };
  const EXPIRED = { ok: false, expired: true, message: 'The code expired. Tap "Send a new code".' };
  if (!ph || !PURPOSES.has(purpose)) return EXPIRED;
  const t = await targetFor(ph, purpose, opts, now);
  if (!t.ok) return EXPIRED;
  const em = t.em;
  const k = codeKey(ph, em, purpose);
  const res = await atomic(k, (rec) => {
    if (!rec || now > Number(rec.exp)) return { result: { expired: true } };
    if (Number(rec.tries || 0) >= MAX_TRIES) return { result: { locked: true } };
    const next = Object.assign({}, rec, { tries: Number(rec.tries || 0) + 1 });
    return { next, result: { rec: next } };
  });
  if (!res || res.busy || res.expired) { if (res && res.expired) await del(k); return EXPIRED; }
  if (res.locked) { await del(k); return { ok: false, expired: true, message: 'Too many tries. Tap "Send a new code".' }; }
  const hh = Buffer.from(codeHash(ph, em, c, purpose)); const stored = Buffer.from(String(res.rec.h || ''));
  if (!(hh.length === stored.length && crypto.timingSafeEqual(hh, stored))) {
    const left = MAX_TRIES - Number(res.rec.tries);
    if (left <= 0) { await del(k); return { ok: false, expired: true, message: 'Too many tries. Tap "Send a new code".' }; }
    return { ok: false, message: 'That code is not right. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' };
  }
  await del(k);
  // 🔐 Login: the code reached this address. When it is the profile email, that also verifies it.
  if (purpose === 'login') {
    if (t.st && t.st.email && t.st.email === em) { try { await markVerified(ph, em, 'login', now); } catch (_) { /* login still works */ } }
    return { ok: true, email: em, maskedEmail: maskEmail(em) };
  }
  if (purpose === 'signup') return { ok: true, email: em, maskedEmail: maskEmail(em) };
  if (purpose === 'confirm') {
    const done = await markVerified(ph, em, 'code', now);
    return done ? { ok: true, verified: true, message: 'Email confirmed ✅' } : EXPIRED;
  }
  // 'old' proves the CURRENT profile email may be replaced; 'new' proves ownership of the new one.
  const bound = purpose === 'old' ? t.st.email : em;
  return { ok: true, token: makeToken(purpose, ph, bound, now) };
}

function makeToken(purpose, ph, em, now) {
  const exp = (now || Date.now()) + TOKEN_TTL_MS;
  const payload = 'eml1.' + (purpose === 'old' ? 'o' : 'n') + '.' + ph + '.' + emailHash(em) + '.' + exp;
  return payload + '.' + mac('tok|' + payload);
}
function tokenOk(token, purpose, phone, email, now) {
  const parts = s(token).split('.');
  if (parts.length !== 6 || parts[0] !== 'eml1') return false;
  const [, p, ph, eh, exp, sig] = parts;
  if (p !== (purpose === 'old' ? 'o' : 'n') || ph !== norm(phone) || !/^\d{10}$/.test(ph)) return false;
  if (!(Number(exp) > (now || Date.now()))) return false;
  if (!sameText(eh, emailHash(email))) return false;
  return sameText(sig, mac('tok|eml1.' + p + '.' + ph + '.' + eh + '.' + exp));
}

/** May this phone replace curEmail with newEmail? (curEmail non-empty) */
async function authorizeChange(phone, curEmail, newEmail, newToken, oldToken, now) {
  const ph = norm(phone);
  if (!tokenOk(newToken, 'new', ph, newEmail, now)) return { ok: false, needNew: true };
  const plan = await activePlanEmails(ph, now);
  if (plan.active && !tokenOk(oldToken, 'old', ph, curEmail, now)) return { ok: false, needOld: true };
  return { ok: true };
}

/** Sets EmailVerified on the profile, only while its email is still `em`. */
async function markVerified(ph, em, how, now) {
  const c = await loadCustomer(ph);
  if (!c || normEmail(c.email) !== em) return false;
  const raw = rawOf(c.raw_json);
  Object.assign(raw, verifiedFields(em, how, now));
  const r = await db.query('UPDATE customers SET raw_json = ? WHERE phone_norm = ? AND email = ? LIMIT 1', [JSON.stringify(raw), ph, c.email]);
  return !r || r.affectedRows == null || Number(r.affectedRows) >= 1;
}
function verifiedFields(em, how, now) {
  return { EmailVerified: true, EmailVerifiedAt: new Date(now || Date.now()).toISOString(), EmailVerifiedEmail: normEmail(em), EmailVerifiedBy: how || 'code' };
}

/** Checkout (new purchase): which email the order may use. Admin quick orders do not call this. */
async function orderEmail(phone, requested, now) {
  const ph = norm(phone);
  const st = await stateFor(ph, now);
  const req = normEmail(requested);
  if (!st.hasEmail) return { ok: true, email: s(requested) };
  const masked = maskEmail(st.email);
  if (req && req !== st.email) {
    return { ok: false, emailChangeRequired: true, maskedEmail: masked, message: 'This number already has an email (' + masked + '). To use a different one, tap Change and confirm it with a code.' };
  }
  if (st.needsCode) {
    return { ok: false, emailCheck: true, maskedEmail: masked, message: 'For your safety, please confirm your email first. We will send a 6-digit code to ' + masked + '.' };
  }
  return { ok: true, email: s(st.customer.email) };
}

async function renewEmailFromState(st, subEmail) {
  if (st.hasEmail && !st.needsCode) return s(st.customer.email);
  return s(subEmail);
}
/** Renewal: trusted profile email, else the email on the plan being renewed. Never asks for a code. */
async function renewEmail(phone, subEmail, now) {
  const st = await stateFor(norm(phone), now);
  return renewEmailFromState(st, subEmail);
}

/** "Your FluxFilm email was changed" to the OLD address (from support@ when SMTP_USER is set). */
async function notifyChanged(oldEmail, newEmail, name, mailer) {
  const m = mailer || require('./mailer');
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto">' +
    '<h2 style="color:#b45309;margin-bottom:4px">🔔 Your FluxFilm email was changed</h2>' +
    '<p style="color:#475569">Hi ' + esc(name || 'there') + ', the email on your FluxFilm account was changed to <b>' + esc(maskEmail(newEmail)) + '</b>. ' +
    'Your next login details will go to that address.</p>' +
    '<p style="color:#475569"><b>If this wasn\'t you</b>, reply to this email or tap Help in the FluxFilm app right away and we will fix it.</p>' +
    '<p style="color:#94a3b8;font-size:12px">For your safety we never show the full new address here.</p></div>';
  return m.send(oldEmail, 'Your FluxFilm email was changed', html);
}

module.exports = {
  status, sendCode, verifyCode, authorizeChange, orderEmail, renewEmail, notifyChanged, markVerified, verifiedFields, loginOptions, phoneKnown,
  maskEmail, normEmail, validEmail, GENERIC_CHANGE,
  _internal: { mem, stateFor, tokenOk, makeToken, optionId, codeKey, phoneKey, emailKey, RESEND_AFTER_MS, MAX_TRIES, SENDS_PER_PHONE_HOUR, SENDS_PER_EMAIL_HOUR },
};
