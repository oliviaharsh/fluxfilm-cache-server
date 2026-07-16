/**
 * FluxFilm - buy flow on MySQL (Wave 2): createOrder + verifyPayment.
 * Fulfillment (account allocation) lives in fulfill.js (separate, careful step).
 * Env: UPI_VPA (default fluxfilm@upi), UPI_PAYEE (default FluxFilm)
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

// ---- coupon discount (faithful subset of validateCoupon_) ----
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

// ---- createOrder ----
async function createOrder(p) {
  p = p || {};
  const service = String(p.service || '').trim();
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
  const pr = planRows[0];
  if (!pr || String(pr.is_active || '').toUpperCase() !== 'TRUE') return { ok: false, message: 'Plan not found or inactive.' };
  const praw = rawOf(pr.raw_json);
  const price = asNum(pr.price);
  const durationDays = Number(pr.duration_days) || asNum(praw.DurationDays);
  const groupJoinRequired = String(praw.RequiresGroupJoin || '').toUpperCase() === 'TRUE';
  const groupJoinLink = String(praw.GroupJoinLink || '').trim();

  let discount = 0;
  if (couponCode) {
    const cd = await couponDiscount(couponCode, phone, price);
    if (!cd.ok) return cd;
    discount = cd.discount;
  }
  const finalAmount = Math.max(0, price - discount);
  const orderId = genOrderId();

  await db.query(
    `INSERT INTO orders (order_id, created_at_sheet, service, plan, duration_days, name, email, phone, phone_norm,
       coupon_code, discount, price, final_amount, currency, notes, extra_field_key, extra_field_value,
       status, fulfillment_status, order_type, group_join_required, group_join_link)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'CREATED', 'PENDING', 'NEW', ?, ?)`,
    [orderId, service, plan, durationDays, name, email, p.phone || phone, phone,
      couponCode, discount, price, finalAmount, notes, extraKey, extraVal,
      groupJoinRequired ? 'TRUE' : 'FALSE', groupJoinLink]);

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
  const rows = await db.query('SELECT order_id, final_amount, status FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  return rows[0] || null;
}
async function _markPaid(orderId, txnRef) {
  await db.query('UPDATE orders SET status = ?, txn_ref = ?, verified_at = NOW() WHERE order_id = ?', ['PAID', txnRef || '', orderId]);
}

// ---- verifyPayment (auto, by OrderID in note) ----
async function verifyPayment(orderId) {
  const o = await _order(orderId);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  const credit = await pay.findByOrder(orderId, o.final_amount);
  if (credit) { await _markPaid(orderId, credit.upi_ref); return { ok: true, found: true, paid: true }; }
  return { ok: true, found: false, retryAfterSec: 5, needRef: true, message: 'Payment not detected yet. Auto-checking…' };
}

// ---- verifyPaymentByRef (fallback, customer enters UPI ref) ----
async function verifyPaymentByRef(orderId, ref) {
  const o = await _order(orderId);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  const credit = await pay.findByRef(orderId, ref, o.final_amount);
  if (credit) { await _markPaid(orderId, credit.upi_ref); return { ok: true, found: true, paid: true }; }
  return { ok: true, found: false, message: 'That reference / amount didn\'t match a payment yet. Please double-check and try again.' };
}

module.exports = { createOrder, verifyPayment, verifyPaymentByRef, _internal: { genOrderId, couponDiscount } };
