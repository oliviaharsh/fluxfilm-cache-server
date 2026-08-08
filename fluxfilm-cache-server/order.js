/**
 * FluxFilm - buy flow on MySQL (Wave 2): createOrder + verifyPayment.
 * Gated to BUY_SERVICES (default 'prime') so only those services use MySQL;
 * everything else returns {__fallback:true} and the server uses Apps Script.
 * Node-created orders are tagged source='node' so we never touch synced orders.
 */
const db = require('./db');
const pay = require('./payments');

const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function genOrderId() {
  const ts = String(Date.now()).slice(-5);
  const rnd = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  return 'FF' + ts + rnd;
}
function serviceAllowed(service) {
  const list = String(process.env.BUY_SERVICES || 'prime').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const svc = String(service || '').toLowerCase();
  return list.some((x) => svc.includes(x));
}

async function couponDiscount(code, phone, baseAmount) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { ok: true, discount: 0 };
  const rows = await db.query('SELECT raw_json FROM coupons', []);
  let raw = null;
  for (const r of rows) {
    const j = rawOf(r.raw_json);
    const jc = String((j.CouponCode != null ? j.CouponCode : '') || (j.Code != null ? j.Code : '') || '').trim().toUpperCase();
    if (jc === c) { raw = j; break; }
  }
  if (!raw) return { ok: false, message: 'Invalid coupon.' };
  if (String(raw.Active || '').toUpperCase() !== 'TRUE') return { ok: false, message: 'Coupon is not active.' };
  if (raw.Expiry) { const ex = new Date(String(raw.Expiry).replace(' ', 'T')); if (!isNaN(ex.getTime()) && ex.getTime() < Date.now()) return { ok: false, message: 'Coupon expired.' }; }
  const allowed = raw.AllowedPhones != null ? String(raw.AllowedPhones).trim() : 'ALL';
  if (allowed && allowed.toUpperCase() !== 'ALL') {
    const list = allowed.split(',').map((x) => norm(x)).filter(Boolean);
    if (!list.includes(norm(phone))) return { ok: false, message: 'Coupon not valid for this number.' };
  }
  const minA = asNum(raw.MinAmount);
  if (baseAmount < minA) return { ok: false, message: 'Minimum order ₹' + minA + ' for this coupon.' };
  const perLimit = Number(raw.PerUserLimit || 0);
  if (perLimit > 0) {
    const u = await db.query("SELECT COUNT(*) n FROM coupon_usage WHERE phone_norm = ? AND UPPER(action)='USED' AND UPPER(coupon_code)=?", [norm(phone), c]);
    if ((+(u[0] || {}).n || 0) >= perLimit) return { ok: false, message: 'Coupon usage limit reached.' };
  }
  const type = String(raw.Type || '').toUpperCase();
  const val = asNum(raw.Value); const maxD = asNum(raw.MaxDiscount);
  let disc = (type.startsWith('PERC') || type === 'PCT' || type === '%') ? baseAmount * val / 100 : val;
  if (maxD > 0) disc = Math.min(disc, maxD);
  disc = Math.max(0, Math.min(disc, baseAmount));
  return { ok: true, discount: Math.round(disc) };
}

async function createOrder(p) {
  p = p || {};
  const service = String(p.service || '').trim();
  if (!serviceAllowed(service)) return { __fallback: true };  // not a MySQL service -> Apps Script
  const plan = String(p.plan || '').trim();
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim();
  const phone = norm(p.phone);
  const couponCode = String(p.couponCode || '').trim().toUpperCase();
  const notes = String(p.notes || '').trim();
  const extraKey = String(p.extraFieldKey || '').trim();
  const extraVal = String(p.extraFieldValue || '').trim();

  if (!service || !plan) return { ok: false, message: 'Select service and plan.' };
  if (!phone) return { ok: false, message: 'Phone number is required.' };
  if (!name) return { ok: false, message: 'Full name is required.' };
  if (!email) return { ok: false, message: 'Email is required.' };

  const planRows = await db.query('SELECT price, duration_days, is_active, raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [service, plan]);
  const prow = planRows[0];
  if (!prow || String(prow.is_active || '').toUpperCase() !== 'TRUE') return { ok: false, message: 'Plan not found or inactive.' };
  const praw = rawOf(prow.raw_json);
  // OTP-login services need Gmail to read the login OTP → stay fully on Apps Script.
  // Don't create a node order we can't finish (Apps Script can't see MySQL-only orders).
  if (String(praw.AllocationPolicy || '').toUpperCase() === 'OTP_ACCOUNT') return { __fallback: true };
  const price = asNum(prow.price);
  const durationDays = Number(prow.duration_days) || asNum(praw.DurationDays);
  const groupJoinRequired = String(praw.RequiresGroupJoin || '').toUpperCase() === 'TRUE';
  const groupJoinLink = String(praw.GroupJoinLink || '').trim();

  const orderType = String(p.action || '').toUpperCase() === 'RENEW' ? 'RENEW' : 'NEW';
  const renewSubId = String(p.renewSubId || '').trim();

  let discount = 0;
  if (couponCode) {
    const cd = await couponDiscount(couponCode, phone, price);
    if (!cd.ok) return cd;
    discount = cd.discount;
  } else if (asNum(p.discountOverride) > 0) {
    // early-renew discount (no coupon on this order); never stacks with a coupon
    discount = Math.min(price, Math.round(asNum(p.discountOverride)));
  }
  const finalAmount = Math.max(0, price - discount);
  const orderId = genOrderId();

  await db.query(
    `INSERT INTO orders (order_id, created_at_sheet, service, plan, duration_days, name, email, phone, phone_norm,
       coupon_code, discount, price, final_amount, currency, notes, extra_field_key, extra_field_value,
       status, fulfillment_status, order_type, renew_sub_id, group_join_required, group_join_link, source)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'CREATED', 'PENDING', ?, ?, ?, ?, 'node')`,
    [orderId, service, plan, durationDays, name, email, p.phone || phone, phone,
      couponCode, discount, price, finalAmount, notes, extraKey, extraVal,
      orderType, renewSubId, groupJoinRequired ? 'TRUE' : 'FALSE', groupJoinLink]);

  const upiVpa = process.env.UPI_VPA || 'fluxfilm@upi';
  const payee = process.env.UPI_PAYEE || 'FluxFilm';
  const upiLink = 'upi://pay?pa=' + encodeURIComponent(upiVpa) + '&pn=' + encodeURIComponent(payee) +
    '&am=' + encodeURIComponent(finalAmount) + '&cu=INR&tn=' + encodeURIComponent(orderId);

  return {
    ok: true, orderId, amount: finalAmount, baseAmount: price, discount,
    couponCode: couponCode || '', currency: 'INR', upiVpa, payee, upiLink,
    paymentNote: orderId, groupJoinRequired, groupJoinLink,
  };
}

async function _order(orderId) {
  const rows = await db.query('SELECT order_id, final_amount, status, source FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  return rows[0] || null;
}
async function _markPaid(orderId, txnRef) {
  await db.query('UPDATE orders SET status = ?, txn_ref = ?, verified_at = NOW() WHERE order_id = ?', ['PAID', txnRef || '', orderId]);
}

async function verifyPayment(orderId) {
  const o = await _order(orderId);
  if (!o || o.source !== 'node') return { __fallback: true };   // not our order -> Apps Script
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  const credit = await pay.findByOrder(orderId, o.final_amount);
  if (credit) { await _markPaid(orderId, credit.upi_ref); return { ok: true, found: true, paid: true }; }
  return { ok: true, found: false, retryAfterSec: 5, needRef: true, message: 'Payment not detected yet. Auto-checking…' };
}

async function verifyPaymentByRef(orderId, ref) {
  const o = await _order(orderId);
  if (!o || o.source !== 'node') return { __fallback: true };
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  const credit = await pay.findByRef(orderId, ref, o.final_amount);
  if (credit) { await _markPaid(orderId, credit.upi_ref); return { ok: true, found: true, paid: true }; }
  return { ok: true, found: false, message: 'That reference / amount didn\'t match a payment yet. Please double-check and try again.' };
}

/**
 * createRenewOrder(subId, planOverride?, couponCode?)
 * Renews an existing MySQL (node-created) subscription. Reuses createOrder so the
 * pay screen / verify / fulfill chain is identical to a fresh buy — the only
 * differences are order_type='RENEW', renew_sub_id, and the early-renew discount.
 * Sheet-owned subs (not source='node') fall back to Apps Script, which renews them
 * on the live Sheet — so a renewal is never split across two stores.
 */
async function createRenewOrder(subId, planOverride, couponCode) {
  const sid = String(subId || '').trim();
  if (!sid) return { ok: false, message: 'Missing subscription id.' };
  const subs = await db.query(
    'SELECT sub_id, service, plan, phone, email, expiry_date, source FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
  const sub = subs[0];
  if (!sub) return { __fallback: true };                       // unknown to MySQL -> Apps Script
  if (String(sub.source || '') !== 'node') return { __fallback: true }; // Sheet sub -> Apps Script
  if (!serviceAllowed(sub.service)) return { __fallback: true };

  // Same backward-compat trick as Apps Script: a 2nd arg that "looks like" a coupon
  // (no spaces, 3-20 chars) is treated as a coupon, not a plan override.
  let plan = String(sub.plan || '').trim();
  let cc = String(couponCode || '').trim().toUpperCase();
  let po = String(planOverride || '').trim();
  if (!cc && po && /^[A-Z0-9_-]{3,20}$/.test(po.toUpperCase())) { cc = po.toUpperCase(); po = ''; }
  if (po) plan = po;

  const planRows = await db.query('SELECT price, raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [sub.service, plan]);
  const prow = planRows[0];
  if (!prow) return { ok: false, message: 'Renewal plan not found — please contact support.' };
  const praw = rawOf(prow.raw_json);

  // days left from current expiry -> tiered early-renew discount
  let daysLeft = null;
  if (sub.expiry_date) { const ex = new Date(sub.expiry_date); if (!isNaN(ex.getTime())) daysLeft = Math.ceil((ex.getTime() - Date.now()) / 86400000); }
  let discountOverride = 0;
  if (daysLeft != null) {
    if (daysLeft >= 8) discountOverride = asNum(praw.EarlyRenewDiscount);
    else if (daysLeft >= 2) discountOverride = asNum(praw.EarlyRenewDiscount_7to2);
  }

  const cust = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [norm(sub.phone)]);
  const name = (cust[0] && cust[0].name) || 'Customer';

  const out = await createOrder({
    service: sub.service, plan, name, email: sub.email, phone: sub.phone,
    couponCode: cc, action: 'RENEW', renewSubId: sid, notes: 'RENEW:' + sid,
    discountOverride,
  });
  if (out && out.ok) { out.renew = true; out.renewSubId = sid; }
  return out;
}

module.exports = { createOrder, createRenewOrder, verifyPayment, verifyPaymentByRef, serviceAllowed, _internal: { genOrderId, couponDiscount } };
