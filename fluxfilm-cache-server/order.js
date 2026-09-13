/**
 * FluxFilm - MySQL-only buy flow: createOrder + payment verification.
 * Every new order and renewal stays on MySQL. There is deliberately no Apps
 * Script/Sheet fallback: an error must be visible instead of silently creating
 * an order in the legacy system.
 */
const crypto = require('crypto');
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
// Per-order secret handed only to the browser that created the order. Only its
// SHA-256 is stored, so the raw token never sits in MySQL or the admin panel.
// fulfill.js checks it before returning login credentials.
function newAccessToken() { return crypto.randomBytes(18).toString('hex'); }
function hashAccessToken(t) { return crypto.createHash('sha256').update(String(t || '')).digest('hex'); }

function serviceAllowed(service) {
  // Kept as an exported compatibility helper for old tests/callers. All plans
  // present and active in MySQL are now eligible for the database order flow.
  return !!String(service || '').trim();
}

/**
 * couponDiscount(code, phone, baseAmount, ctx) — every rule the Apps Script
 * validateCoupon_ enforced. ctx = { action: 'NEW'|'RENEW', service, plan }.
 * The first MySQL port only checked Active/Expiry/AllowedPhones/MinAmount/
 * PerUserLimit, so GlobalLimit, FirstTimeOnly, Scope and the Services/Plans
 * allow-lists were silently ignored.
 */
async function couponDiscount(code, phone, baseAmount, ctx) {
  ctx = ctx || {};
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

  // Scope: a NEW-only coupon must not discount a renewal and vice versa. Blank = ANY.
  const scope = String(raw.Scope || 'ANY').trim().toUpperCase() || 'ANY';
  const action = String(ctx.action || 'ANY').trim().toUpperCase();
  if (scope !== 'ANY' && scope !== action) return { ok: false, message: 'Coupon not valid for this ' + (action === 'RENEW' ? 'renewal' : 'purchase') + '.' };

  // Optional comma-separated allow-lists (exact names, as in the Sheet).
  const listOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const svcAllow = listOf(raw.Services);
  if (svcAllow.length && !svcAllow.includes(String(ctx.service || '').trim())) return { ok: false, message: 'Coupon not valid for this service.' };
  const planAllow = listOf(raw.Plans);
  if (planAllow.length && !planAllow.includes(String(ctx.plan || '').trim())) return { ok: false, message: 'Coupon not valid for this plan.' };

  // First-time only: this phone has never paid for an order.
  if (String(raw.FirstTimeOnly || '').trim().toUpperCase() === 'TRUE') {
    const paid = await db.query("SELECT 1 FROM orders WHERE phone_norm = ? AND UPPER(status) = 'PAID' LIMIT 1", [norm(phone)]);
    if (paid.length) return { ok: false, message: 'Coupon only for first-time customers.' };
  }

  // Limits count only paid (USED) redemptions; HOLD rows are abandoned checkouts.
  const perLimit = Number(raw.PerUserLimit || 0);
  const globalLimit = Number(raw.GlobalLimit || 0);
  if (perLimit > 0 || globalLimit > 0) {
    const u = await db.query(
      "SELECT COUNT(*) n, SUM(phone_norm = ?) mine FROM coupon_usage WHERE UPPER(action)='USED' AND UPPER(coupon_code)=?", [norm(phone), c]);
    const all = +(u[0] || {}).n || 0; const mine = +(u[0] || {}).mine || 0;
    if (perLimit > 0 && mine >= perLimit) return { ok: false, message: 'Coupon usage limit reached.' };
    if (globalLimit > 0 && all >= globalLimit) return { ok: false, message: 'This coupon has been fully redeemed.' };
  }
  const type = String(raw.Type || '').toUpperCase();
  const val = asNum(raw.Value); const maxD = asNum(raw.MaxDiscount);
  let disc = (type.startsWith('PERC') || type === 'PCT' || type === '%') ? baseAmount * val / 100 : val;
  if (maxD > 0) disc = Math.min(disc, maxD);
  disc = Math.max(0, Math.min(disc, baseAmount));
  return { ok: true, discount: Math.round(disc) };
}

/**
 * createOrder(p, opts)
 *  p    — what the storefront sends (customer-controlled).
 *  opts — SERVER-ONLY options, never taken from p: { action, renewSubId, discountOverride,
 *         amountOverride, allowNoEmail, rawExtra }. Used by createRenewOrder and the admin
 *         quick-order tool. (These used to be read from p, so a customer could post
 *         discountOverride and pay Rs 1 for any plan.)
 */
async function createOrder(p, opts) {
  p = p || {};
  opts = opts || {};
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
  if (!email && !opts.allowNoEmail) return { ok: false, message: 'Email is required.' };

  const planRows = await db.query('SELECT price, duration_days, is_active, raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [service, plan]);
  const prow = planRows[0];
  if (!prow || String(prow.is_active || '').toUpperCase() !== 'TRUE') return { ok: false, message: 'Plan not found or inactive.' };
  const praw = rawOf(prow.raw_json);
  const price = asNum(prow.price);
  const durationDays = Number(prow.duration_days) || asNum(praw.DurationDays);
  const groupJoinRequired = String(praw.RequiresGroupJoin || '').toUpperCase() === 'TRUE';
  const groupJoinLink = String(praw.GroupJoinLink || '').trim();

  const orderType = String(opts.action || '').toUpperCase() === 'RENEW' ? 'RENEW' : 'NEW';
  const renewSubId = orderType === 'RENEW' ? String(opts.renewSubId || '').trim() : '';

  // How many devices/screens this subscription uses. Model A: the device count is
  // baked into the plan name (e.g. "2 Devices 1M" → 2); a caller may still override
  // via p.deviceCount. tvCount = how many are TV (Prime only).
  const planDevices = (String(plan).match(/(\d+)\s*device/i) || [])[1];
  // Never fewer devices than the plan name says (a lower count would under-reserve slots).
  const deviceCount = Math.max(Number(planDevices) || 1, Math.floor(asNum(p.deviceCount)) || 0);
  let tvCount = (p.tvCount != null && p.tvCount !== '') ? Math.max(0, Math.floor(asNum(p.tvCount))) : null;
  // Back-compat: a single-device Prime order that only sent the old TV/NON_TV flag.
  if (tvCount == null) {
    const dt = String(p.extraFieldValue || '').toUpperCase();
    if (dt === 'TV') tvCount = deviceCount; else if (dt === 'NON_TV') tvCount = 0;
  }
  if (tvCount != null) tvCount = Math.min(tvCount, deviceCount);

  // Per-device pricing: base plan price covers 1 device; each EXTRA device adds a
  // fixed amount from the PLANS `ExtraDevicePrice` column. OTP has no device count.
  const extraDevicePrice = asNum(praw.ExtraDevicePrice);
  const basePrice = Math.round(price + Math.max(0, deviceCount - 1) * extraDevicePrice);

  const hasAmountOverride = opts.amountOverride != null && opts.amountOverride !== '';
  const overrideAmount = hasAmountOverride ? Math.max(0, Math.round(asNum(opts.amountOverride))) : 0;
  let discount = 0;
  if (couponCode) {
    const cd = await couponDiscount(couponCode, phone, basePrice, { action: orderType, service, plan });
    if (!cd.ok) return cd;
    discount = cd.discount;
  } else if (hasAmountOverride) {
    // Admin quick order: the amount actually agreed with the customer (e.g. on WhatsApp).
    discount = Math.max(0, basePrice - overrideAmount);
  } else if (asNum(opts.discountOverride) > 0) {
    // early-renew discount (no coupon on this order); never stacks with a coupon
    discount = Math.min(basePrice, Math.round(asNum(opts.discountOverride)));
  }
  const listPrice = hasAmountOverride ? Math.max(basePrice, overrideAmount) : basePrice;
  const finalAmount = Math.max(0, listPrice - discount);
  const orderId = genOrderId();
  const accessToken = newAccessToken();

  const orderRaw = {
    OrderID: orderId, Service: service, Plan: plan, DurationDays: durationDays,
    Name: name, Email: email, Phone: p.phone || phone, CouponCode: couponCode,
    Discount: discount, Price: listPrice, FinalAmount: finalAmount, Currency: 'INR',
    Notes: notes, ExtraFieldKey: extraKey, ExtraFieldValue: extraVal,
    Status: 'CREATED', FulfillmentStatus: 'PENDING', OrderType: orderType,
    RenewSubID: renewSubId, DeviceConcurrency: deviceCount, TVCount: tvCount,
    GroupJoinRequired: groupJoinRequired ? 'TRUE' : 'FALSE', GroupJoinLink: groupJoinLink,
    Source: 'node',
    AccessTokenHash: hashAccessToken(accessToken),
  };
  if (opts.rawExtra && typeof opts.rawExtra === 'object') Object.assign(orderRaw, opts.rawExtra);

  await db.query(
    `INSERT INTO orders (order_id, created_at_sheet, service, plan, duration_days, name, email, phone, phone_norm,
       coupon_code, discount, price, final_amount, currency, notes, extra_field_key, extra_field_value,
       status, fulfillment_status, order_type, renew_sub_id, device_count, tv_count, group_join_required, group_join_link, source, raw_json)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'CREATED', 'PENDING', ?, ?, ?, ?, ?, ?, 'node', ?)`,
    [orderId, service, plan, durationDays, name, email, p.phone || phone, phone,
      couponCode, discount, listPrice, finalAmount, notes, extraKey, extraVal,
      orderType, renewSubId, deviceCount, tvCount, groupJoinRequired ? 'TRUE' : 'FALSE', groupJoinLink,
      JSON.stringify(orderRaw)]);

  // HOLD records attempts but does not count against coupon limits. Payment
  // confirmation adds the USED row below, entirely in MySQL.
  if (couponCode && discount > 0) {
    try {
      await db.query(
        `INSERT INTO coupon_usage (coupon_code, phone, phone_norm, email, discount, order_id, action, ts, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, 'HOLD', NOW(), ?)`,
        [couponCode, p.phone || phone, phone, email, discount, orderId, JSON.stringify({
          Timestamp: new Date().toISOString(), CouponCode: couponCode, Phone: p.phone || phone,
          Email: email, Discount: discount, OrderID: orderId, Action: 'HOLD',
        })]);
    } catch (e) {
      // The order is already safely in MySQL; a non-counting audit row must not
      // make checkout appear to fail and tempt the customer to submit twice.
      console.log('[coupon] HOLD log failed for', orderId, e.message);
    }
  }

  const upiVpa = process.env.UPI_VPA || 'fluxfilm@upi';
  const payee = process.env.UPI_PAYEE || 'FluxFilm';
  const upiLink = 'upi://pay?pa=' + encodeURIComponent(upiVpa) + '&pn=' + encodeURIComponent(payee) +
    '&am=' + encodeURIComponent(finalAmount) + '&cu=INR&tn=' + encodeURIComponent(orderId);

  return {
    ok: true, orderId, amount: finalAmount, baseAmount: listPrice, planPrice: price, discount,
    couponCode: couponCode || '', currency: 'INR', upiVpa, payee, upiLink,
    paymentNote: orderId, groupJoinRequired, groupJoinLink,
    deviceCount, tvCount,
    accessToken,
  };
}

async function _order(orderId) {
  const rows = await db.query('SELECT order_id, final_amount, status, source FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  return rows[0] || null;
}
async function _markPaid(orderId, txnRef) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT status, coupon_code, phone, phone_norm, email, discount FROM orders WHERE order_id = ? FOR UPDATE', [orderId]);
    const o = rows[0];
    if (!o) throw new Error('Order not found.');
    if (String(o.status || '').toUpperCase() !== 'PAID') {
      await conn.query('UPDATE orders SET status = ?, txn_ref = ?, verified_at = NOW() WHERE order_id = ?', ['PAID', txnRef || '', orderId]);
      const code = String(o.coupon_code || '').trim().toUpperCase();
      if (code && asNum(o.discount) > 0) {
        await conn.query(
          `INSERT INTO coupon_usage (coupon_code, phone, phone_norm, email, discount, order_id, action, ts, raw_json)
           SELECT ?, ?, ?, ?, ?, ?, 'USED', NOW(), ?
           WHERE NOT EXISTS (
             SELECT 1 FROM coupon_usage WHERE order_id = ? AND UPPER(coupon_code) = ? AND UPPER(action) = 'USED'
           )`,
          [code, o.phone, o.phone_norm, o.email, o.discount, orderId, JSON.stringify({
            Timestamp: new Date().toISOString(), CouponCode: code, Phone: o.phone,
            Email: o.email, Discount: o.discount, OrderID: orderId, Action: 'USED',
          }), orderId, code]);
      }
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally { conn.release(); }
}

async function verifyPayment(orderId) {
  const o = await _order(orderId);
  if (!o) return { ok: false, found: false, message: 'Order not found in the FluxFilm database.' };
  if (o.source !== 'node') return { ok: false, found: false, message: 'This legacy order cannot be verified on the new checkout. Please contact support.' };
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  const credit = await pay.findByOrder(orderId, o.final_amount);
  if (credit) { await _markPaid(orderId, credit.upi_ref); return { ok: true, found: true, paid: true }; }
  return { ok: true, found: false, retryAfterSec: 5, needRef: true, message: 'Payment not detected yet. Auto-checking…' };
}

async function verifyPaymentByRef(orderId, ref) {
  const o = await _order(orderId);
  if (!o) return { ok: false, found: false, message: 'Order not found in the FluxFilm database.' };
  if (o.source !== 'node') return { ok: false, found: false, message: 'This legacy order cannot be verified on the new checkout. Please contact support.' };
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  const credit = await pay.findByRef(orderId, ref, o.final_amount);
  if (credit) { await _markPaid(orderId, credit.upi_ref); return { ok: true, found: true, paid: true }; }
  return { ok: true, found: false, message: 'That reference / amount didn\'t match a payment yet. Please double-check and try again.' };
}

/**
 * renewQuote(subId, planOverride?) — everything a renewal will cost and do, without
 * creating an order: the plan, early-renew discount, and the account decision (R1).
 * Shared by createRenewOrder and the admin quick-order preview.
 */
async function renewQuote(subId, planOverride) {
  const sid = String(subId || '').trim();
  if (!sid) return { ok: false, message: 'Missing subscription id.' };
  const subs = await db.query(
    'SELECT sub_id, service, plan, phone, email, expiry_date, source FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
  const sub = subs[0];
  if (!sub) return { ok: false, message: 'Subscription not found.' };  // MySQL is master; no Sheet fallback
  const plan = String(planOverride || '').trim() || String(sub.plan || '').trim();

  const planRows = await db.query('SELECT price, raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [sub.service, plan]);
  const prow = planRows[0];
  if (!prow) return { ok: false, message: 'Renewal plan not found — please contact support.' };
  const praw = rawOf(prow.raw_json);

  // R1: check the account can still serve this customer BEFORE they pay.
  const renewal = await require('./fulfill').planRenewal(sid, plan);

  // days left from current expiry -> tiered early-renew discount
  let daysLeft = null;
  if (sub.expiry_date) { const ex = new Date(sub.expiry_date); if (!isNaN(ex.getTime())) daysLeft = Math.ceil((ex.getTime() - Date.now()) / 86400000); }
  let earlyDiscount = 0;
  if (daysLeft != null) {
    if (daysLeft >= 8) earlyDiscount = asNum(praw.EarlyRenewDiscount);
    else if (daysLeft >= 2) earlyDiscount = asNum(praw.EarlyRenewDiscount_7to2);
  }
  const price = asNum(prow.price);
  return { ok: true, sub, plan, price, daysLeft, earlyDiscount, amount: Math.max(0, price - earlyDiscount), renewal };
}

/**
 * createRenewOrder(subId, planOverride?, couponCode?, opts?)
 * Renews an existing MySQL subscription — ALWAYS on MySQL (MySQL is the master; we
 * never write to the Sheet). Reuses createOrder so the pay/verify/fulfill chain is
 * identical to a fresh buy — only order_type='RENEW', renew_sub_id, and the tiered
 * early-renew discount differ. Fulfillment extends the SAME sub.
 * opts (server-only, e.g. admin quick orders): { amountOverride, notes, rawExtra }.
 */
async function createRenewOrder(subId, planOverride, couponCode, opts) {
  opts = opts || {};
  // Same backward-compat trick as Apps Script: a 2nd arg that "looks like" a coupon
  // (no spaces, 3-20 chars) is treated as a coupon, not a plan override.
  let cc = String(couponCode || '').trim().toUpperCase();
  let po = String(planOverride || '').trim();
  if (!cc && po && /^[A-Z0-9_-]{3,20}$/.test(po.toUpperCase())) { cc = po.toUpperCase(); po = ''; }

  const q = await renewQuote(subId, po);
  if (!q.ok) return q;
  const { sub, plan, renewal } = q;
  // Nothing can serve this customer: no order is created and no money is taken.
  if (renewal.mode === 'NONE') return { ok: false, renewBlocked: true, message: renewal.message };

  const cust = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [norm(sub.phone)]);
  const name = (cust[0] && cust[0].name) || 'Customer';

  const out = await createOrder({
    service: sub.service, plan, name, email: sub.email, phone: sub.phone,
    couponCode: cc, notes: opts.notes || ('RENEW:' + sub.sub_id),
  }, {
    action: 'RENEW', renewSubId: sub.sub_id, discountOverride: q.earlyDiscount,
    amountOverride: opts.amountOverride, allowNoEmail: true, rawExtra: opts.rawExtra,
  });
  if (out && out.ok) {
    out.renew = true; out.renewSubId = sub.sub_id;
    if (renewal.mode === 'MOVE') { out.accountChange = true; out.renewNotice = renewal.message; }
    if (renewal.preview) out.renewPreview = renewal.preview;
  }
  return out;
}

/**
 * validateCoupon(code, ctx) — the checkout "Apply coupon" preview. Checks the coupon
 * against MySQL (coupons is master now) and returns the discount for the given amount.
 * ctx = { phone, amount, service, plan, scope }.
 */
async function validateCoupon(code, ctx) {
  ctx = ctx || {};
  const c = String(code || '').trim();
  if (!c) return { ok: false, message: 'Enter a coupon code.' };
  const phone = norm(ctx.phone);
  const amount = asNum(ctx.amount);
  const cd = await couponDiscount(c, phone, amount, {
    action: String(ctx.scope || ctx.action || 'ANY').toUpperCase(), service: ctx.service, plan: ctx.plan,
  });
  if (!cd.ok) return { ok: false, message: cd.message || 'Coupon is not valid.' };
  return { ok: true, code: c.toUpperCase(), discount: cd.discount, finalAmount: Math.max(0, amount - cd.discount), message: 'Coupon applied.' };
}

/** Admin only: mark an order paid (cash / UPI seen on WhatsApp). Same bookkeeping as a matched bank credit. */
async function adminMarkPaid(orderId, txnRef) {
  const o = await _order(orderId);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.source !== 'node') return { ok: false, message: 'Legacy (Sheet) orders cannot be marked paid here.' };
  await _markPaid(orderId, txnRef);
  return { ok: true };
}

module.exports = { createOrder, createRenewOrder, renewQuote, adminMarkPaid, verifyPayment, verifyPaymentByRef, validateCoupon, serviceAllowed, hashAccessToken, _internal: { genOrderId, couponDiscount } };
