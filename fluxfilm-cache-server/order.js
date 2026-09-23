/**
 * FluxFilm - MySQL-only buy flow: createOrder + payment verification.
 * Every new order and renewal stays on MySQL. There is deliberately no Apps
 * Script/Sheet fallback: an error must be visible instead of silently creating
 * an order in the legacy system.
 */
const crypto = require('crypto');
const db = require('./db');
const pay = require('./payments');
const referrals = require('./referrals');
const coins = require('./coins');
const deviceLogins = require('./devicelogins');
const emaillock = require('./emaillock');
// 💸 "How was this paid" (website QR / typed UTR / backup QR / coins / admin / credit) — stamped at payment time.
const paidvia = require('./paidvia');

const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) || !isFinite(n) ? 0 : n; };
// Most devices one order may hold when a plan sells extra devices (ExtraDevicePrice > 0).
const MAX_EXTRA_DEVICES = 6;
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
function genOrderId() {
  const ts = String(Date.now()).slice(-5);
  const rnd = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  return 'FF' + ts + rnd;
}
// IDs are short (FF + 7 digits) and go's imported orders use the same shape, so a new ID could land on an
// existing order. Pick one that is not taken yet (the INSERT would otherwise fail and the customer see an error).
async function freeOrderId() {
  for (let i = 0; i < 8; i++) {
    const id = genOrderId();
    const rows = await db.query('SELECT 1 FROM orders WHERE order_id = ? LIMIT 1', [id]);
    if (!rows || !rows.length) return id;
  }
  // Extremely unlikely: fall back to a longer ID (still matches FF + digits everywhere).
  return 'FF' + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
}
// Per-order secret handed only to the browser that created the order. Only its
// SHA-256 is stored, so the raw token never sits in MySQL or the admin panel.
// fulfill.js checks it before returning login credentials.
function newAccessToken() { return crypto.randomBytes(18).toString('hex'); }
function hashAccessToken(t) { return crypto.createHash('sha256').update(String(t || '')).digest('hex'); }

// "Sharing 2 Devices 3M" → "sharing 2 devices": the plan name without its duration. Two plans with the same
// variant differ only in duration, which is the only thing a renewal may change. Shared with reads.js and
// index.html (renewrules.js), including old imported names ("1 Month", "Yearly", "30 Days", "12M").
const renewRules = require('./renewrules');
const planVariant = renewRules.planVariant;
// ACTIVE or EXPIRED subscriptions that were not refunded / cancelled / never delivered (legacy rows have no fulfillment_status).
function renewableStatus(sub) {
  const st = String(sub.status || '').trim().toUpperCase();
  const fs = String(sub.fulfillment_status || '').trim().toUpperCase();
  if (st && st !== 'ACTIVE' && st !== 'EXPIRED') return false;
  return !['REFUNDED', 'CANCELLED', 'FAILED', 'NO_STOCK'].includes(fs);
}

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
  if (raw.Expiry) {
    // A date without a time (the admin form saves "YYYY-MM-DD") is valid until the END of that day in India.
    // new Date("2026-12-31") alone is UTC midnight = 05:30 IST, so the coupon died ~18 hours early.
    const ev = String(raw.Expiry).trim();
    const ex = /^\d{4}-\d{2}-\d{2}$/.test(ev) ? new Date(ev + 'T23:59:59+05:30') : new Date(ev.replace(' ', 'T'));
    if (!isNaN(ex.getTime()) && ex.getTime() < Date.now()) return { ok: false, message: 'Coupon expired.' };
  }
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
  // refundCoupon: a personal coupon FluxFilm gave as a refund (adminorderactions.js, raw.Source = 'REFUND').
  return { ok: true, discount: Math.round(disc), refundCoupon: String(raw.Source || '').trim().toUpperCase() === 'REFUND', globalLimit: globalLimit };
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
  let email = String(p.email || '').trim();
  const phone = norm(p.phone);
  const couponCode = String(p.couponCode || '').trim().toUpperCase();
  const notes = String(p.notes || '').trim();
  const extraKey = String(p.extraFieldKey || '').trim();
  const extraVal = String(p.extraFieldValue || '').trim();
  const referralCode = String(p.referralCode || '').trim();

  if (!service || !plan) return { ok: false, message: 'Select service and plan.' };
  if (!phone) return { ok: false, message: 'Phone number is required.' };
  if (!name) return { ok: false, message: 'Full name is required.' };
  // 🔒 Email lock (emaillock.js): the storefront / Olivia may only send the login to the profile email, and only once
  // it is safe (verified, or unchanged since the last paid order); otherwise { emailCheck } / { emailChangeRequired }
  // and no order is made. Admin quick orders (amountOverride, server-only) and renewals (createRenewOrder picks the
  // email itself and sets the server-only emailChecked) skip this.
  if (!(opts.amountOverride != null && opts.amountOverride !== '') && opts.emailChecked !== true) {
    const chk = await emaillock.orderEmail(phone, email);
    if (!chk.ok) return chk;
    email = chk.email;
  }
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
  // Never fewer devices than the plan name says (a lower count would under-reserve slots). MORE devices than
  // the plan name only when they are paid for (plan ExtraDevicePrice > 0, up to MAX_EXTRA_DEVICES) or on an admin
  // quick order — before, a tampered request got 6 devices for the 2-device price.
  const planDevCount = Number(planDevices) || 1;
  const askedDevices = Math.floor(asNum(p.deviceCount)) || 0;
  const extraDevicesSold = asNum(praw.ExtraDevicePrice) > 0 || (opts.amountOverride != null && opts.amountOverride !== '');
  const deviceCount = extraDevicesSold
    ? Math.min(Math.max(planDevCount, askedDevices), Math.max(planDevCount, MAX_EXTRA_DEVICES))
    : planDevCount;
  let tvCount = (p.tvCount != null && p.tvCount !== '') ? Math.max(0, Math.floor(asNum(p.tvCount))) : null;
  // Back-compat: a single-device Prime order that only sent the old TV/NON_TV flag.
  if (tvCount == null) {
    const dt = String(p.extraFieldValue || '').toUpperCase();
    if (dt === 'TV') tvCount = deviceCount; else if (dt === 'NON_TV') tvCount = 0;
  }
  if (tvCount != null) tvCount = Math.min(tvCount, deviceCount);

  // F1: "Same login on all devices, or a separate login for each device?" — only for NEW 2+ device Netflix /
  // Prime plans, and only once schema-v19 has been run (before that: one login, exactly as before). The plan
  // name decides the device count (a client-sent deviceCount can only raise it, never skip the question).
  let loginMode = ''; let loginNotice = '';
  if (orderType === 'NEW' && deviceLogins.isEligible({ service, plan, policy: praw.AllocationPolicy, fulfillmentMode: praw.FulfillmentMode }) &&
      await deviceLogins.groupsReady(db.query)) {
    const m = deviceLogins.normalizeMode(p.loginMode);
    if (m === null) return { ok: false, message: 'Please choose: the same login on all devices, or a separate login for each device.' };
    loginMode = m;
    // Stock can't take this order in either mode → say so BEFORE any payment (admin quick orders skip this).
    if (!(opts.amountOverride != null && opts.amountOverride !== '')) {
      const chk = await require('./fulfill').checkDeviceLogins({ policy: praw.AllocationPolicy, service, plan, durationDays, deviceCount: deviceCount, tvCount: tvCount || 0, mode: loginMode });
      if (!chk.ok) return { ok: false, outOfStock: true, message: deviceLogins.MESSAGES.outOfStock(deviceCount) };
      loginNotice = chk.message || '';
    }
  }

  // Out of stock → no payable order (the Buy button was only disabled in the browser, so a stale page or a
  // direct API call still took money for a plan that could not be delivered). New orders only: renewals keep
  // their own account (R1 decides), admin quick orders are the owner's call. A stock read error never blocks
  // a sale — fulfilment still refuses NO_STOCK as before.
  if (orderType === 'NEW' && !loginMode && !(opts.amountOverride != null && opts.amountOverride !== '')) {
    let level = null;
    try {
      const levels = await require('./stock').computeStockLevels([{ service, plan, price: prow.price, duration_days: prow.duration_days, raw_json: prow.raw_json }]);
      level = levels[service + '|||' + plan] || null;
    } catch (e) { console.log('[order] stock check skipped for', service, plan, e.message); }
    if (level && level.stock != null && Number(level.stock) < 1) { // stock = purchases of this plan that can still be delivered
      return { ok: false, outOfStock: true, message: 'Sorry, ' + service + ' ' + plan + ' is out of stock right now. Please pick another plan or check again later.' };
    }
  }

  // Per-device pricing: base plan price covers 1 device; each EXTRA device adds a
  // fixed amount from the PLANS `ExtraDevicePrice` column. OTP has no device count.
  const extraDevicePrice = asNum(praw.ExtraDevicePrice);
  const basePrice = Math.round(price + Math.max(0, deviceCount - 1) * extraDevicePrice);

  const hasAmountOverride = opts.amountOverride != null && opts.amountOverride !== '';
  const overrideAmount = hasAmountOverride ? Math.max(0, Math.round(asNum(opts.amountOverride))) : 0;
  let discount = 0;
  // Invite link (Refer & earn): new customers get a discount on their first order. A coupon
  // takes priority over it, but the friend is still recorded so the referrer gets rewarded.
  let referral = null; let referralMessage = '';
  if (referralCode && orderType === 'NEW' && !hasAmountOverride) {
    try {
      const rq = await referrals.checkReferral(referralCode, phone, basePrice);
      if (rq.ok) referral = rq; else referralMessage = rq.message || '';
    } catch (e) { console.log('[referral] check failed:', e.message); }
  }
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
  } else if (referral) {
    discount = Math.min(basePrice, referral.discount);
  }
  const referralDiscount = referral && !couponCode ? discount : 0;
  const listPrice = hasAmountOverride ? Math.max(basePrice, overrideAmount) : basePrice;
  const orderId = await freeOrderId();
  // Pay part with coins (customer ticked "Use my coins"): the coins are held now, kept when paid, given back if not.
  // coinsRupees = everything "Use my coins" took (refund credit first, up to 100%, then coins within the max-%);
  // creditUsed = the refund-credit part of it.
  let coinsUsed = 0; let coinsRupees = 0; let creditUsed = 0; let coinsMessage = '';
  if (p.useCoins === true && !hasAmountOverride && typeof coins.holdSpend === 'function') {
    try {
      const h = await coins.holdSpend({ phone, orderId, amount: Math.max(0, listPrice - discount), kind: orderType, service, plan });
      if (h.ok) { coinsUsed = h.coins; coinsRupees = h.rupees; creditUsed = asNum(h.credit); } else coinsMessage = h.message || '';
    } catch (e) { console.log('[coins] hold failed for', orderId, e.message); coinsMessage = 'Coins could not be used right now.'; }
  }
  const totalDiscount = discount + coinsRupees;
  const finalAmount = Math.max(0, listPrice - totalDiscount);
  // ₹0 checkout: credit / coupon / coins cover the whole price. No UPI screen; the customer taps Confirm and
  // confirmFreeOrder re-checks everything on the server. Decided here only (raw_json is never written by the client);
  // admin quick orders (amountOverride) are marked paid by the owner instead.
  const freeCheckout = finalAmount === 0 && !hasAmountOverride;
  const accessToken = newAccessToken();

  const orderRaw = {
    OrderID: orderId, Service: service, Plan: plan, DurationDays: durationDays,
    Name: name, Email: email, Phone: p.phone || phone, CouponCode: couponCode,
    Discount: totalDiscount, Price: listPrice, FinalAmount: finalAmount, Currency: 'INR',
    Notes: notes, ExtraFieldKey: extraKey, ExtraFieldValue: extraVal,
    Status: 'CREATED', FulfillmentStatus: 'PENDING', OrderType: orderType,
    RenewSubID: renewSubId, DeviceConcurrency: deviceCount, TVCount: tvCount,
    GroupJoinRequired: groupJoinRequired ? 'TRUE' : 'FALSE', GroupJoinLink: groupJoinLink,
    Source: 'node',
    AccessTokenHash: hashAccessToken(accessToken),
  };
  if (referral) { orderRaw.ReferralCode = referral.code; orderRaw.ReferralDiscount = referralDiscount; }
  if (coinsUsed) { orderRaw.CoinsUsed = coinsUsed; orderRaw.CoinsDiscount = coinsRupees - creditUsed; }
  if (creditUsed) orderRaw.RefundCreditUsed = creditUsed;
  if (freeCheckout) orderRaw.FreeCheckout = true;
  if (loginMode) orderRaw.LoginMode = loginMode; // the typed column orders.login_mode holds the same value
  if (opts.rawExtra && typeof opts.rawExtra === 'object') Object.assign(orderRaw, opts.rawExtra);

  try {
  await db.query(
    `INSERT INTO orders (order_id, created_at_sheet, service, plan, duration_days, name, email, phone, phone_norm,
       coupon_code, discount, price, final_amount, currency, notes, extra_field_key, extra_field_value,
       status, fulfillment_status, order_type, renew_sub_id, device_count, tv_count, group_join_required, group_join_link, source, raw_json` + (loginMode ? ', login_mode' : '') + `)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'CREATED', 'PENDING', ?, ?, ?, ?, ?, ?, 'node', ?` + (loginMode ? ', ?' : '') + ')',
    [orderId, service, plan, durationDays, name, email, p.phone || phone, phone,
      couponCode, totalDiscount, listPrice, finalAmount, notes, extraKey, extraVal,
      orderType, renewSubId, deviceCount, tvCount, groupJoinRequired ? 'TRUE' : 'FALSE', groupJoinLink,
      JSON.stringify(orderRaw)].concat(loginMode ? [loginMode] : []));
  } catch (e) {
    // The order was not saved: give the held coins straight back.
    if (coinsRupees) await coins.releaseSpend(orderId, 'order could not be saved').catch((x) => console.log('[coins] release failed', orderId, x.message));
    throw e;
  }

  if (referral) {
    try {
      await referrals.attachToOrder({ code: referral.code, referrerPhone: referral.referrerPhone, friendPhone: phone, orderId, discount: referralDiscount });
    } catch (e) { console.log('[referral] attach failed for', orderId, e.message); }
  }

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
    ok: true, orderId, amount: finalAmount, baseAmount: listPrice, planPrice: price, discount: totalDiscount,
    coinsUsed, coinsDiscount: coinsRupees, creditUsed, coinsMessage, freeCheckout,
    couponCode: couponCode || '', currency: 'INR', upiVpa, payee, upiLink,
    paymentNote: orderId, groupJoinRequired, groupJoinLink,
    deviceCount, tvCount,
    loginMode, loginNotice,
    referralApplied: !!referral && !couponCode, referralDiscount, referralMessage: referral ? '' : referralMessage,
    accessToken,
  };
}

async function _order(orderId) {
  const rows = await db.query('SELECT order_id, final_amount, status, source FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  return rows[0] || null;
}
/**
 * Mark an order PAID, once.
 *   via  — how the money came in (paidvia.VIA.*): stamped onto raw_json.PaidVia so the admin panel never has
 *          to guess later. Unknown/empty leaves the order unstamped and it is worked out on the fly instead.
 *   opts — { detail, payerName }: `detail` says how a backup-QR claim was accepted, `payerName` is the name on
 *          the bank alert, remembered on the customer for Customer 360 and the admin search.
 */
async function _markPaid(orderId, txnRef, via, opts) {
  const o_ = opts || {};
  const conn = await db.getPool().getConnection();
  let becamePaid = false;
  const couponOf = { code: '', discount: 0 };
  let phoneNorm = '';
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT status, coupon_code, phone, phone_norm, email, discount, raw_json FROM orders WHERE order_id = ? FOR UPDATE', [orderId]);
    const o = rows[0];
    if (!o) throw new Error('Order not found.');
    phoneNorm = String(o.phone_norm || '');
    // A refunded order stays refunded: a late bank credit or a second "mark paid" never turns it back into PAID.
    if (String(o.status || '').toUpperCase() !== 'PAID' && String(o.status || '').toUpperCase() !== 'REFUNDED') {
      // raw_json keeps every original field; stampJson returns null (and we leave raw_json alone) if it cannot be read.
      const stamped = paidvia.stampJson(o.raw_json, via, o_.detail, new Date().toISOString());
      if (stamped) await conn.query('UPDATE orders SET status = ?, txn_ref = ?, verified_at = NOW(), raw_json = ? WHERE order_id = ?', ['PAID', txnRef || '', stamped, orderId]);
      else await conn.query('UPDATE orders SET status = ?, txn_ref = ?, verified_at = NOW() WHERE order_id = ?', ['PAID', txnRef || '', orderId]);
      becamePaid = true;
      const code = String(o.coupon_code || '').trim().toUpperCase();
      couponOf.code = code; couponOf.discount = asNum(o.discount);
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
  // A refund coupon (single use) was on two orders that were both paid (one by UPI after the other was confirmed):
  // payment can't be refused, so tell the owner. Never blocks payment.
  // 💳 The name on the bank alert goes on the customer (raw_json.PayerNames, last 5) for Customer 360 + search.
  if (becamePaid && String(o_.payerName || '').trim()) paidvia.rememberPayerNameLater(db.query, phoneNorm, o_.payerName);
  if (becamePaid && /^RF[A-Z0-9]{4,}$/.test(String(couponOf.code || '')) && couponOf.discount > 0) {
    flagRefundCouponOveruse(couponOf.code, orderId).catch((e) => console.log('[coupon] overuse check failed for', orderId, e.message));
  }
  // Refer & earn: a friend's first paid order rewards whoever invited them. Never blocks payment.
  if (becamePaid && typeof coins.onOrderPaid === 'function') {
    // Coins used on this order are now kept (maintain() retries if this fails).
    coins.onOrderPaid(orderId).catch((e) => console.log('[coins] settle failed for', orderId, e.message));
  }
  if (becamePaid) {
    referrals.onOrderPaid(orderId)
      .then((r) => { if (r && r.status) console.log('[referral]', orderId, JSON.stringify(r)); })
      .catch((e) => console.log('[referral] reward failed for', orderId, e.message));
  }
  // 💸 "New order ₹X" on the owner's phones (ownernotify.js). Bank email / typed UTR / admin Mark paid / Quick order /
  // backup UPI claims all end here. Fire and forget, at most once per order.
  if (becamePaid) notifyOwnerPaid(orderId);
}
function notifyOwnerPaid(orderId) {
  try { require('./ownernotify').orderPaidLater(orderId); } catch (e) { console.log('[owner-alert] not loaded:', e.message); }
  // 📡 n8n order.paid webhook (n8nhooks.js): only asks for a sweep in ~3 s (a timer, no await, never throws). The sweep's
  // once-per-order guard sends it; the 60-second sweep also catches any PAID path that does not pass through here.
  try { require('./n8nhooks').kick(); } catch (_) { /* webhooks are optional */ }
}

// Refunded by the owner: the checkout page stops waiting and says so (no bank credit is taken for it).
const REFUNDED_VERIFY = { ok: true, found: false, paid: false, refunded: true, fulfillment: 'REFUNDED', message: '💸 This order was refunded. Please contact WhatsApp support if this looks wrong.' };
const CREDIT_VERIFY = { ok: true, found: true, paid: false, credit: true, message: '✅ This renewal is already active. FluxFilm will confirm your payment — message WhatsApp support if you have paid.' };
const FREE_VERIFY = { ok: true, found: false, paid: false, freeCheckout: true, message: 'Nothing to pay on this order — go back and tap “Confirm” to use your credit.' };

async function verifyPayment(orderId) {
  const o = await _order(orderId);
  if (!o) return { ok: false, found: false, message: 'Order not found in the FluxFilm database.' };
  if (o.source !== 'node') return { ok: false, found: false, message: 'This legacy order cannot be verified on the new checkout. Please contact support.' };
  if (String(o.status || '').toUpperCase() === 'REFUNDED') return REFUNDED_VERIFY;
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  // 💳 Admin credit renewal (credit.js): already active; the owner records the payment, never a bank line matched here.
  if (String(o.status || '').toUpperCase() === 'CREDIT') return CREDIT_VERIFY;
  // ₹0 order: nothing to find in the bank (and no ₹0 bank line may ever "pay" it) — it is confirmed with confirmFreeOrder.
  if (!(asNum(o.final_amount) > 0)) return FREE_VERIFY;
  const credit = await pay.findByOrder(orderId, o.final_amount);
  // 🌐 The bank alert carried this order id, so the customer used the order QR / UPI link on the site.
  if (credit) { await _markPaid(orderId, credit.upi_ref, paidvia.VIA.WEBSITE_QR, { payerName: paidvia.parseAlert(credit.raw).payerName }); return { ok: true, found: true, paid: true }; }
  // Paid to the plain backup QR by a customer whose payer name we already know (payment fallback, schema-v17).
  try {
    const learned = await require('./paymatch').autoMatchLearned(orderId);
    if (learned && learned.paid) return { ok: true, found: true, paid: true };
  } catch (e) { console.log('[paymatch] learned-name check failed for', orderId, e.message); }
  return { ok: true, found: false, retryAfterSec: 5, needRef: true, message: 'Payment not detected yet. Auto-checking…' };
}

async function verifyPaymentByRef(orderId, ref) {
  const o = await _order(orderId);
  if (!o) return { ok: false, found: false, message: 'Order not found in the FluxFilm database.' };
  if (o.source !== 'node') return { ok: false, found: false, message: 'This legacy order cannot be verified on the new checkout. Please contact support.' };
  if (String(o.status || '').toUpperCase() === 'REFUNDED') return REFUNDED_VERIFY;
  if (String(o.status || '').toUpperCase() === 'PAID') return { ok: true, found: true, paid: true, message: '✅ Payment confirmed.' };
  // 💳 Admin credit renewal (credit.js): already active; the owner records the payment, never a bank line matched here.
  if (String(o.status || '').toUpperCase() === 'CREDIT') return CREDIT_VERIFY;
  if (!(asNum(o.final_amount) > 0)) return FREE_VERIFY;
  const credit = await pay.findByRef(orderId, ref, o.final_amount);
  // 🔢 The customer typed the reference on the checkout page.
  if (credit) { await _markPaid(orderId, credit.upi_ref, paidvia.VIA.UTR_TYPED, { payerName: paidvia.parseAlert(credit.raw).payerName }); return { ok: true, found: true, paid: true }; }
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
    'SELECT sub_id, service, plan, phone, email, expiry_date, source, status, fulfillment_status FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
  const sub = subs[0];
  if (!sub) return { ok: false, message: 'Subscription not found.' };  // MySQL is master; no Sheet fallback
  // Refunds v3: a refunded plan (refund offer accepted) can’t be renewed — the customer buys a new plan instead.
  if (String(sub.status || '').trim().toUpperCase() === 'REFUNDED') return { ok: false, renewBlocked: true, refunded: true, message: 'This plan was refunded, so it can’t be renewed. Please buy a new plan instead.' };
  // A refunded / cancelled row used to renew "in place" and come out FULFILLED again (no login, no owner task).
  if (!renewableStatus(sub)) return { ok: false, renewBlocked: true, message: 'This plan cannot be renewed online. Please contact WhatsApp support.' };
  const plan = String(planOverride || '').trim() || String(sub.plan || '').trim();
  const samePlan = plan === String(sub.plan || '').trim();
  // The customer may renew into ANY active plan of the same service — a longer one, Private ↔ Sharing, or a
  // different number of devices (owner, 23 Sep 2026). A different service is a new purchase, not a renewal.
  // Changing the kind or the devices cannot reuse the old place, so fulfil allocates fresh (renewNeedsNewPlace)
  // and planRenewal below decides that BEFORE payment — a renewal that cannot be placed is refused, not sold.
  if (!samePlan) {
    const svcRows = await db.query('SELECT plan, is_active, raw_json FROM plans WHERE service = ?', [sub.service]);
    const activeNames = (svcRows || []).filter((r) => {
      const a = (r.is_active != null && r.is_active !== '') ? r.is_active : rawOf(r.raw_json).IsActive;
      return String(a == null ? '' : a).trim().toUpperCase() === 'TRUE';
    }).map((r) => String(r.plan || '').trim());
    if (!activeNames.includes(plan)) {
      return { ok: false, renewBlocked: true, message: 'That plan is not available for ' + sub.service + ' right now. Please pick one of the plans shown, or contact WhatsApp support.' };
    }
  }

  const planRows = await db.query('SELECT price, raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [sub.service, plan]);
  const prow = planRows[0];
  if (!prow) return { ok: false, message: 'Renewal plan not found — please contact support.' };
  const praw = rawOf(prow.raw_json);

  // R1: check the account can still serve this customer BEFORE they pay. A kind / device change is allocated
  // fresh here too, so "no room" is a refusal before payment rather than a failed delivery after it.
  const newPlace = !samePlan && renewRules.renewNeedsNewPlace(sub.plan, plan);
  const renewal = await require('./fulfill').planRenewal(sid, plan);

  // days left from current expiry -> tiered early-renew discount. The SAME calendar-day count (India, expiry date)
  // as My plans (reads.js), so the renew page and this price always agree.
  const daysLeft = renewRules.daysLeftIst(sub.expiry_date);
  let earlyDiscount = 0;
  // The early-renew discount is for renewing the SAME plan (that is what the renew page shows and promises).
  if (daysLeft != null && samePlan) {
    if (daysLeft >= 8) earlyDiscount = asNum(praw.EarlyRenewDiscount);
    else if (daysLeft >= 2) earlyDiscount = asNum(praw.EarlyRenewDiscount_7to2);
  }
  const price = asNum(prow.price);
  return { ok: true, sub, plan, price, daysLeft, renewEligibility: renewRules.renewEligibility(daysLeft), earlyDiscount, amount: Math.max(0, price - earlyDiscount), renewal, planChanged: !samePlan, newPlace };
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
  // …unless it is a real plan of this subscription's service (live "YouTube Premium" plan "1Year" has no space).
  if (!cc && po && /^[A-Z0-9_-]{3,20}$/.test(po.toUpperCase())) {
    const isPlan = await db.query('SELECT 1 AS x FROM plans p JOIN subscriptions s ON s.service = p.service WHERE s.sub_id = ? AND p.plan = ? LIMIT 1', [String(subId || '').trim(), po]).catch(() => []);
    if (!(isPlan && isPlan.length)) { cc = po.toUpperCase(); po = ''; }
  }

  const q = await renewQuote(subId, po);
  if (!q.ok) return q;
  const { sub, plan, renewal } = q;
  // Nothing can serve this customer: no order is created and no money is taken.
  if (renewal.mode === 'NONE') return { ok: false, renewBlocked: true, message: renewal.message };

  const cust = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [norm(sub.phone)]);
  const name = (cust[0] && cust[0].name) || 'Customer';
  // 🔒 Email lock: the trusted profile email (verified / unchanged since the last paid order), otherwise the email on
  // this plan, which already received its login. Never a fresh unverified change, and never a code step.
  let renewTo = sub.email;
  try { renewTo = (await emaillock.renewEmail(sub.phone, sub.email)) || sub.email; } catch (e) { console.log('[email-lock] renew email check failed, using the plan email:', e.message); }

  const out = await createOrder({
    service: sub.service, plan, name, email: renewTo, phone: sub.phone,
    couponCode: cc, notes: opts.notes || ('RENEW:' + sub.sub_id), useCoins: opts.useCoins === true,
  }, {
    // F1: a purchase with separate logins always renews through its first row, so every row renews together.
    action: 'RENEW', renewSubId: renewal.leadSubId || sub.sub_id, discountOverride: q.earlyDiscount,
    amountOverride: opts.amountOverride, allowNoEmail: true, rawExtra: opts.rawExtra, emailChecked: true,
  });
  if (out && out.ok) {
    out.renew = true; out.renewSubId = renewal.leadSubId || sub.sub_id;
    if (renewal.mode === 'MOVE' || renewal.mode === 'SPLIT') { out.accountChange = true; out.renewNotice = renewal.message; }
    if (renewal.logins > 1 || renewal.mode === 'SPLIT') out.renewDevices = renewal.devices;
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

/**
 * confirmFreeOrder(orderId, proof) — ₹0 checkout: refund credit / coupon / coins cover the whole price.
 * proof = { token, phone }: the per-order token from createOrder OR the order's phone (same proof as fulfillAndGetAccess).
 * Nothing the browser sends is trusted: under one named lock + a transaction that locks the order row and the
 * customer's wallet row, the server checks that createOrder marked the order FreeCheckout, the stored final amount is
 * 0, the credit + coins are STILL held for this order (not given back meanwhile), and the coupon is STILL valid and
 * worth what it was. Only then: PAID (txn_ref CREDIT-…, no bank credit), coupon USED, holds SPENT — all or nothing.
 * Repeating (or racing) the call returns { paid, already } and changes nothing. Delivery then runs exactly like a paid
 * order (the storefront polls fulfillAndGetAccess); if it fails the order is PAID/FAILED with the admin ⚡ Actions.
 */
const FREE_LOCK = 'ff_free_confirm';
class FreeRefused extends Error { constructor(message, extra) { super(message); this.extra = extra || {}; } }
async function confirmFreeOrder(orderId, proof) {
  const oid = String(orderId || '').trim().toUpperCase();
  if (!/^FF\d{1,14}$/.test(oid)) return { ok: false, message: 'Order not found.' };
  const pr = proof && typeof proof === 'object' ? proof : { token: proof };
  const pool = db.getPool && db.getPool();
  if (!pool) return { ok: false, message: 'Database not available — please try again.' };
  const conn = await pool.getConnection();
  let locked = false; let done = null;
  try {
    const [l] = await conn.query('SELECT GET_LOCK(?, ?) AS l', [FREE_LOCK, 10]);
    if (!l || !l[0] || Number(l[0].l) !== 1) return { ok: false, busy: true, message: 'Busy — please tap Confirm again in a moment.' };
    locked = true;
    await conn.beginTransaction();
    try {
      done = await _confirmFreeOn(conn, oid, pr);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      if (e instanceof FreeRefused) return Object.assign({ ok: false, message: e.message }, e.extra);
      throw e;
    }
  } finally {
    if (locked) { try { await conn.query('SELECT RELEASE_LOCK(?)', [FREE_LOCK]); } catch (_) {} }
    conn.release();
  }
  if (done.becamePaid) {
    referrals.onOrderPaid(oid)
      .then((r) => { if (r && r.status) console.log('[referral]', oid, JSON.stringify(r)); })
      .catch((e) => console.log('[referral] reward failed for', oid, e.message));
    notifyOwnerPaid(oid);
  }
  return done.out;
}
async function _confirmFreeOn(conn, oid, pr) {
  const [rows] = await conn.query(
    'SELECT order_id, status, source, service, plan, phone, phone_norm, email, order_type, price, discount, final_amount, coupon_code, raw_json FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [oid]);
  const o = (rows || [])[0];
  if (!o) throw new FreeRefused('Order not found.');
  const raw = Object.assign({}, rawOf(o.raw_json));
  const token = String(pr.token || '').trim();
  const phoneOk = !!norm(pr.phone) && norm(pr.phone) === String(o.phone_norm || '');
  const tokenOk = !!token && !!raw.AccessTokenHash && hashAccessToken(token) === String(raw.AccessTokenHash);
  if (!phoneOk && !tokenOk) throw new FreeRefused('This order was placed with a different phone number.');
  const st = String(o.status || '').toUpperCase();
  if (st === 'PAID') return { out: { ok: true, paid: true, already: true, orderId: oid, message: '✅ Already confirmed.' } };
  if (st === 'REFUNDED') throw new FreeRefused('💸 This order was refunded.', { refunded: true });
  if (String(o.source || '') !== 'node' || st !== 'CREATED') throw new FreeRefused('This order can’t be confirmed here. Please contact support.');
  if (raw.FreeCheckout !== true || asNum(o.final_amount) !== 0) throw new FreeRefused('This order still needs a UPI payment.', { needsPayment: true });

  // Credit + coins still held for THIS order? (A newer checkout with coins, or 24 h without paying, gives them back.)
  const creditRecorded = Math.round(asNum(raw.RefundCreditUsed));
  const coinsRecorded = Math.round(asNum(raw.CoinsDiscount));
  const heldRecorded = creditRecorded + coinsRecorded;
  const startAgain = { startAgain: true };
  let spend = null;
  if (heldRecorded > 0) {
    await coins.lockWalletOn(conn, String(o.phone_norm));
    const [sp] = await conn.query('SELECT order_id, coins, rupees, status FROM coin_spends WHERE order_id = ? LIMIT 1 FOR UPDATE', [oid]);
    spend = (sp || [])[0] || null;
    if (!spend || String(spend.status).toUpperCase() !== 'HELD' || Math.round(asNum(spend.rupees)) !== heldRecorded) {
      throw new FreeRefused('Your credit / coins on this order were given back (the order waited too long, or you started another order). Please start the order again.', startAgain);
    }
    const c = await coins.creditOnOrderOn(conn, oid);
    if (Math.round(c.held) !== creditRecorded) throw new FreeRefused('Your refund credit on this order was given back. Please start the order again.', startAgain);
  }
  // Every other discount (coupon, invite, early renewal) was worked out by createOrder on the server.
  const otherDiscount = Math.round(asNum(o.discount)) - heldRecorded;
  const code = String(o.coupon_code || '').trim().toUpperCase();
  if (code && otherDiscount > 0) {
    const cd = await couponDiscount(code, o.phone_norm, asNum(o.price), { action: String(o.order_type || 'NEW').toUpperCase() === 'RENEW' ? 'RENEW' : 'NEW', service: o.service, plan: o.plan });
    if (!cd.ok) throw new FreeRefused('Coupon ' + code + ': ' + (cd.message || 'not valid any more') + ' Please start the order again.', startAgain);
    if (cd.discount < otherDiscount) throw new FreeRefused('Coupon ' + code + ' is now worth less than when you started. Please start the order again.', startAgain);
  }
  if (Math.round(asNum(o.price)) - otherDiscount - heldRecorded > 0 || otherDiscount < 0) throw new FreeRefused('This order still needs a UPI payment.', { needsPayment: true });

  const paidWith = [creditRecorded ? 'CREDIT' : '', coinsRecorded ? 'COINS' : '', code && otherDiscount > 0 ? 'COUPON' : ''].filter(Boolean);
  const method = paidWith.join('+') || 'DISCOUNT';
  Object.assign(raw, { Status: 'PAID', PaymentMethod: method, PaidWithCredit: creditRecorded, PaidWithCoins: coinsRecorded, PaidWithCoupon: code && otherDiscount > 0 ? code : '', FreeConfirmedAt: new Date().toISOString(), TxnRef: 'CREDIT-' + oid });
  // 🪙 Coins paid for it, or 🎁 nothing was left to pay (coupon / refund credit) — no bank line will ever exist.
  paidvia.stamp(raw, coinsRecorded > 0 ? paidvia.VIA.COINS : paidvia.VIA.FREE,
    coinsRecorded > 0 ? '' : creditRecorded > 0 ? 'REFUND_CREDIT' : code && otherDiscount > 0 ? 'COUPON' : '', raw.FreeConfirmedAt);
  const [upd] = await conn.query("UPDATE orders SET status = 'PAID', txn_ref = ?, verified_at = NOW(), raw_json = ? WHERE order_id = ? AND UPPER(status) = 'CREATED' LIMIT 1", ['CREDIT-' + oid, JSON.stringify(raw), oid]);
  if (!upd || upd.affectedRows !== 1) throw new FreeRefused('This order changed while confirming — please try again.');
  if (code && otherDiscount > 0) {
    await conn.query(
      `INSERT INTO coupon_usage (coupon_code, phone, phone_norm, email, discount, order_id, action, ts, raw_json)
       SELECT ?, ?, ?, ?, ?, ?, 'USED', NOW(), ?
       WHERE NOT EXISTS (
         SELECT 1 FROM coupon_usage WHERE order_id = ? AND UPPER(coupon_code) = ? AND UPPER(action) = 'USED'
       )`,
      [code, o.phone, o.phone_norm, o.email, otherDiscount, oid, JSON.stringify({
        Timestamp: new Date().toISOString(), CouponCode: code, Phone: o.phone,
        Email: o.email, Discount: otherDiscount, OrderID: oid, Action: 'USED',
      }), oid, code]);
  }
  if (spend) {
    const [sp2] = await conn.query("UPDATE coin_spends SET status = 'SPENT', note = ?, updated_at = NOW() WHERE order_id = ? AND status = 'HELD'", ['₹0 checkout confirmed', oid]);
    if (!sp2 || sp2.affectedRows !== 1) throw new FreeRefused('Your credit on this order was just given back. Please start the order again.', startAgain);
  }
  return { becamePaid: true, out: { ok: true, paid: true, orderId: oid, paymentMethod: method, message: '✅ Confirmed — getting your plan ready…' } };
}

// Refund coupons are single use; if two orders using the same one both got paid, put it on the owner's Today to-dos.
async function flagRefundCouponOveruse(code, orderId) {
  const u = await db.query("SELECT COUNT(DISTINCT order_id) n FROM coupon_usage WHERE UPPER(coupon_code) = ? AND UPPER(action) = 'USED'", [code]);
  const n = +((u || [])[0] || {}).n || 0;
  if (n <= 1) return { ok: true, n };
  const c = await db.query('SELECT raw_json FROM coupons WHERE code = ? LIMIT 1', [code]);
  const raw = rawOf(((c || [])[0] || {}).raw_json);
  if (String(raw.Source || '').toUpperCase() !== 'REFUND' || n <= Math.max(1, Number(raw.GlobalLimit || 1))) return { ok: true, n };
  await db.query('INSERT INTO admin_todos (title, note) VALUES (?, ?)', [
    ('⚠️ Refund coupon ' + code + ' was used on ' + n + ' paid orders (latest ' + orderId + ')').slice(0, 300),
    'A single-use refund coupon (₹' + asNum(raw.Value) + ', from order ' + (raw.RefundOrderId || '?') + ') paid for more than one order — one of them was paid by UPI after the other was confirmed. Check the orders and decide whether to ask the customer for the difference.',
  ]).catch(() => {});
  return { ok: true, n, flagged: true };
}

/**
 * Admin only: mark an order paid (cash / UPI seen on WhatsApp). Same bookkeeping as a matched bank credit.
 * `via` defaults to 🧑‍💼 ADMIN; paymatch.js passes 📲 BACKUP_QR (with how the claim was accepted) because there
 * the money really came in on the backup UPI — the admin only confirmed it.
 */
async function adminMarkPaid(orderId, txnRef, via, opts) {
  const o = await _order(orderId);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.source !== 'node') return { ok: false, message: 'Legacy (Sheet) orders cannot be marked paid here.' };
  if (String(o.status || '').toUpperCase() === 'REFUNDED') return { ok: false, message: 'This order was refunded — it cannot be marked paid again. Create a new order instead.' };
  if (String(o.status || '').toUpperCase() === 'CREDIT') return { ok: false, credit: true, message: 'This renewal is on credit — use 💳 Mark paid on the order (Today → Receivables) so the amount is recorded.' };
  if (String(o.status || '').toUpperCase() === 'WRITTEN_OFF') return { ok: false, message: 'This credit was cancelled (written off) — it cannot be marked paid.' };
  await _markPaid(orderId, txnRef, paidvia.normalize(via) || paidvia.VIA.ADMIN, opts);
  return { ok: true };
}

module.exports = {
  planVariant, renewableStatus, createOrder, createRenewOrder, renewQuote, adminMarkPaid, verifyPayment, verifyPaymentByRef, validateCoupon, confirmFreeOrder, serviceAllowed, hashAccessToken, _internal: { genOrderId, freeOrderId, couponDiscount, flagRefundCouponOveruse } };
