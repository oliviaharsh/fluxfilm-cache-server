/**
 * FluxFilm - the last customer-facing Apps Script actions, ported to MySQL.
 *
 * Ports of: createOrUpdateCustomerProfile, updateCustomerProfilePic (Customers.gs),
 * getOrderStatus (Payments.gs), getResumePaymentByPhone (Resume.gs) and
 * submitRestockRequest (Stock.gs). Response shapes are unchanged so index.html
 * needs no edits.
 *
 * WHY: profile READS already came from MySQL while profile WRITES still went to
 * the Sheet. With Sheet->MySQL sync off (MySQL is master) a customer who changed
 * their email saved it somewhere nothing reads — and mailer.js then delivered
 * credentials to the stale address. Writing to MySQL closes that split.
 */
const db = require('./db');
const reads = require('./reads');
const emaillock = require('./emaillock');

function s(v) { return String(v == null ? '' : v).trim(); }
function up(v) { return s(v).toUpperCase(); }
function normPhone(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  if (!d) return '';
  return d.length > 10 ? d.slice(-10) : d;
}
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function nowSheet() {
  // Same shape the Sheet stored, so raw_json stays readable by the old tooling.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ------------------------------------------------------------------ *
 * Customer profile — create or update
 * ------------------------------------------------------------------ */
async function createOrUpdateCustomerProfile(payload) {
  const p = payload || {};
  const name = s(p.name);
  const phone = normPhone(p.phone);
  const email = emaillock.normEmail(p.email);

  if (!name) return { ok: false, message: 'Name is required.' };
  if (!phone) return { ok: false, message: 'Phone number is required.' };
  if (!email || email.indexOf('@') === -1) return { ok: false, message: 'Valid email is required.' };

  const now = nowSheet();
  const existing = await db.query('SELECT phone, raw_json, email FROM customers WHERE phone_norm = ? LIMIT 1', [phone]);

  if (existing.length) {
    // 🔒 Email lock (emaillock.js): changing an email already on file needs a code to the NEW address
    // (+ a code to an old address when a plan is active). Never trusts the client.
    const curStored = existing[0].email == null ? null : String(existing[0].email);
    const cur = emaillock.normEmail(curStored);
    const raw = rawOf(existing[0].raw_json);
    let changed = false;
    const at = new Date().toISOString();
    if (cur && email !== cur) {
      const auth = await emaillock.authorizeChange(phone, cur, email, p.emailToken, p.oldEmailToken);
      if (!auth.ok) return { ok: false, emailLocked: true, needOld: !!auth.needOld, message: emaillock.GENERIC_CHANGE };
      Object.assign(raw, emaillock.verifiedFields(email, 'code'), { EmailChangedAt: at, PreviousEmail: cur });
      changed = true;
    } else if (!cur) {
      // First email on a row that had none: allowed without a code, but NOT verified (checkout confirms it).
      const proved = emaillock._internal.tokenOk(p.emailToken, 'new', phone, email);
      Object.assign(raw, proved ? emaillock.verifiedFields(email, 'code') : { EmailVerified: false }, { EmailChangedAt: at });
    }
    raw.Name = name;
    raw.Email = cur === email ? (curStored || email) : email;
    raw.UpdatedAt = now;
    raw.lastActivity = now;
    if (!s(raw.Status)) raw.Status = 'ACTIVE';
    if (!s(raw.Phone)) raw.Phone = s(p.phone) || phone;

    // "email <=> old value": if the email changed in between (another request), nothing is written.
    const res = await db.query(
      "UPDATE customers SET name = ?, email = ?, updated_at = NOW(), status = COALESCE(NULLIF(status, ''), 'ACTIVE'), raw_json = ? WHERE phone_norm = ? AND email <=> ? LIMIT 1",
      [name, raw.Email, JSON.stringify(raw), phone, curStored]);
    if (res && res.affectedRows != null && Number(res.affectedRows) === 0) return { ok: false, emailLocked: true, message: emaillock.GENERIC_CHANGE };
    if (changed) notifyOld(cur, email, name);

    return { ok: true, message: changed ? 'Email changed ✅' : 'Account updated', emailChanged: changed, profile: await _profile(phone) };
  }

  // New customer: the email is saved WITHOUT a code but marked not verified (checkout confirms it when needed).
  const customerId = 'CUS-' + String(Date.now()).slice(-8);
  const raw = {
    CustomerID: customerId, MemberSince: now, UpdatedAt: now,
    Name: name, Phone: s(p.phone) || phone, Email: email,
    LastOrderID: '', TotalOrders: 0, TotalSpent: 0,
    lastActivity: now, Notes: '', Status: 'ACTIVE', ProfilePicUrl: '',
    EmailVerified: false,
  };
  if (emaillock._internal.tokenOk(p.emailToken, 'new', phone, email)) Object.assign(raw, emaillock.verifiedFields(email, 'code'));
  await db.query(
    "INSERT INTO customers (phone, phone_norm, name, email, profile_pic_url, member_since, updated_at, status, customer_id, raw_json)" +
    " VALUES (?, ?, ?, ?, '', NOW(), NOW(), 'ACTIVE', ?, ?)",
    [s(p.phone) || phone, phone, name, email, customerId, JSON.stringify(raw)]);

  // Signed up from a friend's invite link: record the link now (not only at the first order).
  if (s(p.referralCode)) {
    try {
      const r = await require('./referrals').attachOnSignup({ code: p.referralCode, friendPhone: phone });
      if (r && r.ok === false && !r.disabled) console.log('[referral] not linked at signup:', r.skipped);
    } catch (e) { console.log('[referral] signup link failed:', e.message); }
  }

  return { ok: true, message: 'Account created', profile: await _profile(phone) };
}

/** The old address gets "Your FluxFilm email was changed" (never blocks the save). */
function notifyOld(oldEmail, newEmail, name) {
  Promise.resolve()
    .then(() => emaillock.notifyChanged(oldEmail, newEmail, name))
    .catch((e) => console.log('[email-lock] change notice failed:', e.message));
}

/**
 * Account → Profile → Change email, and checkout "Change": only the email changes, the name is kept.
 * payload: { phone, email, emailToken, oldEmailToken }
 */
async function changeProfileEmail(payload) {
  const p = payload || {};
  const phone = normPhone(p.phone);
  if (!phone) return { ok: false, message: 'Phone number is required.' };
  const rows = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [phone]);
  if (!rows.length) return { ok: false, emailLocked: true, message: emaillock.GENERIC_CHANGE };
  return createOrUpdateCustomerProfile({ name: s(rows[0].name) || 'Customer', phone, email: p.email, emailToken: p.emailToken, oldEmailToken: p.oldEmailToken });
}

/** The profile object the frontend expects (same fields, minus the `ok` flag). */
async function _profile(phone) {
  const r = await reads.getCustomerProfile(phone);
  if (!r || r.ok === false) return null;
  const out = Object.assign({}, r);
  delete out.ok;
  return out;
}

/* ------------------------------------------------------------------ *
 * Customer profile — avatar
 * ------------------------------------------------------------------ */
async function updateCustomerProfilePic(phone, profilePicUrl) {
  const ph = normPhone(phone);
  const url = s(profilePicUrl);
  if (!ph) return { ok: false, message: 'Phone required' };

  const rows = await db.query('SELECT raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!rows.length) return { ok: false, message: 'Customer not found' };

  const raw = rawOf(rows[0].raw_json);
  raw.ProfilePicUrl = url;
  raw.UpdatedAt = nowSheet();
  raw.lastActivity = raw.UpdatedAt;

  await db.query(
    'UPDATE customers SET profile_pic_url = ?, updated_at = NOW(), raw_json = ? WHERE phone_norm = ? LIMIT 1',
    [url, JSON.stringify(raw), ph]);

  // Picked an avatar instead of their own photo: delete the uploaded photo (photos.js; no-op before schema-v20).
  try { const photos = require('./photos'); if (!photos.isPhotoUrl(url)) await photos.forget(ph); }
  catch (e) { console.log('[photos] could not delete old photo:', e.message); }

  return { ok: true, profilePicUrl: url, profile: await _profile(ph) };
}

/* ------------------------------------------------------------------ *
 * Order status (checkout polls this while waiting for payment/fulfilment)
 * ------------------------------------------------------------------ */
async function getOrderStatus(orderId) {
  const oid = s(orderId);
  if (!oid) return { ok: true, paid: false, fulfilled: false, manual: false, processing: false, found: false };

  const rows = await db.query(
    'SELECT status, fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [oid]);
  if (!rows.length) return { ok: true, paid: false, fulfilled: false, manual: false, found: false };

  const status = up(rows[0].status);
  const fulfillStatus = up(rows[0].fulfillment_status);
  return {
    ok: true,
    paid: status === 'PAID',
    fulfilled: fulfillStatus === 'FULFILLED',
    manual: fulfillStatus === 'MANUAL_PENDING',
    processing: fulfillStatus === 'PROCESSING',
    refunded: status === 'REFUNDED',
    status, fulfillStatus, found: true,
  };
}

/* ------------------------------------------------------------------ *
 * Resume an unfinished payment
 * NOTE: index.html defines an API wrapper for this but never calls it today.
 * Ported for parity so nothing is left pointing at Apps Script.
 * ------------------------------------------------------------------ */
async function getResumePaymentByPhone(phone) {
  const ph = normPhone(phone);
  if (!ph) return null;

  // Matches the Apps Script scan: newest order for this phone still CREATED or PAID.
  const rows = await db.query(
    "SELECT order_id, service, plan, final_amount, currency FROM orders" +
    " WHERE phone_norm = ? AND UPPER(status) IN ('CREATED', 'PAID')" +
    " ORDER BY created_at_sheet DESC LIMIT 1", [ph]);
  if (!rows.length) return null;

  const last = rows[0];
  const upiVpa = process.env.UPI_VPA || 'fluxfilm@upi';
  const payee = process.env.UPI_PAYEE || 'FluxFilm';
  const currency = s(last.currency) || process.env.CURRENCY || 'INR';
  const amt = Math.max(0, Number(last.final_amount || 0));

  return {
    orderId: last.order_id,
    service: last.service,
    plan: last.plan,
    finalAmount: amt,
    currency,
    upiLink: 'upi://pay?pa=' + encodeURIComponent(upiVpa) + '&pn=' + encodeURIComponent(payee) +
      '&am=' + encodeURIComponent(amt) + '&cu=' + encodeURIComponent(currency) +
      '&tn=' + encodeURIComponent(last.order_id),
  };
}

/* ------------------------------------------------------------------ *
 * "Notify me when back in stock"
 * ------------------------------------------------------------------ */
async function submitRestockRequest(payload) {
  const p = payload || {};
  const name = s(p.name);
  const phone = normPhone(p.phone);
  const service = s(p.service);
  const plan = s(p.plan);

  if (!phone) return { ok: false, message: 'Phone number is required.' };
  if (!service || !plan) return { ok: false, message: 'Service and plan are required.' };

  // Don't stack duplicate pending requests for the same phone+service+plan.
  const dup = await db.query(
    "SELECT id FROM restock_requests WHERE phone_norm = ? AND service = ? AND plan = ? AND UPPER(status) <> 'DONE' LIMIT 1",
    [phone, service, plan]);
  if (dup.length) {
    return { ok: true, duplicate: true, message: "You're already on the notify list for this plan. We'll message you when it's back." };
  }

  await db.query(
    "INSERT INTO restock_requests (ts, name, phone, phone_norm, service, plan, status, notes)" +
    " VALUES (NOW(), ?, ?, ?, ?, ?, 'PENDING', '')",
    [name, s(p.phone) || phone, phone, service, plan]);

  notifyTelegram({ name, phone, service, plan });

  return { ok: true, message: "You're on the list! We'll message you when this plan is back in stock." };
}

/**
 * Fire-and-forget admin ping, replacing the Apps Script notifyTelegram_ call.
 * No-op unless TG_BOT_TOKEN + TG_ADMIN_CHAT_ID are set, and never throws into
 * the customer's request.
 */
function notifyTelegram(info) {
  const token = process.env.TG_BOT_TOKEN || '';
  const chatId = process.env.TG_ADMIN_CHAT_ID || '';
  if (!token || !chatId) return;
  const text = 'RESTOCK REQUEST\n' + info.service + ' — ' + info.plan + '\n' +
    (info.name ? info.name + ' · ' : '') + info.phone;
  try {
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch((e) => console.log('[restock] telegram notify failed:', e.message));
  } catch (e) { console.log('[restock] telegram notify failed:', e.message); }
}

module.exports = {
  createOrUpdateCustomerProfile,
  changeProfileEmail,
  createCustomerProfile: createOrUpdateCustomerProfile, // Apps Script alias
  updateCustomerProfilePic,
  getOrderStatus,
  getResumePaymentByPhone,
  submitRestockRequest,
};
