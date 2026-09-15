/**
 * FluxFilm - fast reads from MySQL (Phase 3).
 * Faithful ports of Apps Script getMySubscriptions / getCustomerOrders /
 * getCustomerProfile, producing the SAME response shape so the frontend is
 * unchanged. server.js routes these actions here unconditionally; errors are
 * returned to the storefront and never fall through to Apps Script.
 */
const db = require('./db');
const deviceLogins = require('./devicelogins');

function normPhone(p) {
  const s = String(p == null ? '' : p).replace(/\D/g, '');
  if (!s) return '';
  return s.length > 10 ? s.slice(-10) : s;
}
function parseDbDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); return isNaN(d.getTime()) ? null : d; }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}
function isoOrRaw(v) { const d = parseDbDate(v); return d ? d.toISOString() : (v ? String(v) : ''); }
function asNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

function maskEmailFirst4(email) {
  const e = String(email || '').trim();
  const at = e.indexOf('@');
  if (at < 0) return e ? e.slice(0, 4) + '****' : '';
  return e.slice(0, 4) + '****' + e.slice(at);
}

const TIER1_MIN = Number(process.env.EARLY_RENEW_TIER1_MIN_DAYS || 8);
const TIER2_MIN = Number(process.env.EARLY_RENEW_TIER2_MIN_DAYS || 2);
const TIER2_MAX = Number(process.env.EARLY_RENEW_TIER2_MAX_DAYS || 7);
function calcEarlyDiscount(daysLeft, pInfo) {
  const d8 = asNum(pInfo && pInfo.d8plus);
  const d72 = asNum(pInfo && pInfo.d7to2);
  if (daysLeft == null) return { amount: 0, tier: 'NONE' };
  if (daysLeft >= TIER1_MIN && d8 > 0) return { amount: d8, tier: '8PLUS' };
  if (daysLeft >= TIER2_MIN && daysLeft <= TIER2_MAX && d72 > 0) return { amount: d72, tier: '7TO2' };
  return { amount: 0, tier: 'NONE' };
}
// Days left + late-renew window are shared with order.js renewQuote (renewrules.js): calendar days in India
// from the expiry DATE; renew allowed until 6 days after the expiry date.
const renewRules = require('./renewrules');
const renewEligibility = renewRules.renewEligibility;
function renewableRow(r) {
  const st = String(r.status || '').trim().toUpperCase();
  const fs = String(r.fulfillment_status || '').trim().toUpperCase();
  if (st && st !== 'ACTIVE' && st !== 'EXPIRED') return false;
  return !['REFUNDED', 'CANCELLED', 'FAILED', 'NO_STOCK'].includes(fs);
}
/** 'REFUNDED' / 'CANCELLED' when the plan was stopped (refund or cancel), else ''. Undelivered FAILED rows are not "stopped". */
function stoppedRow(r) {
  const st = String(r.status || '').trim().toUpperCase();
  const fs = String(r.fulfillment_status || '').trim().toUpperCase();
  if (st === 'REFUNDED' || fs === 'REFUNDED') return 'REFUNDED';
  if (st === 'CANCELLED' || st === 'CANCELED') return 'CANCELLED';
  return '';
}
function expiryMood(daysLeft) {
  if (daysLeft == null) return { emoji: '❓', text: 'Expiry unknown' };
  if (daysLeft > 10) return { emoji: '😄', text: 'Safe' };
  if (daysLeft >= 6) return { emoji: '🙂', text: 'All good' };
  if (daysLeft >= 1) return { emoji: '😰', text: 'Expiring soon' };
  if (daysLeft === 0) return { emoji: '⚠️', text: 'Expires today' };
  if (daysLeft >= -renewRules.LATE_RENEW_DAYS) return { emoji: '😵', text: 'Expired (late renew allowed)' };
  return { emoji: '🟥', text: 'Expired' };
}

let _plans = null;
let _plansAt = 0;
const PLANS_TTL_MS = 5 * 60 * 1000;
async function getPlansMap() {
  if (_plans && Date.now() - _plansAt < PLANS_TTL_MS) return _plans;
  const rows = await db.query(
    'SELECT service, plan, duration_days, early_renew_discount, early_renew_discount_7to2, logo_url FROM plans', []);
  const m = new Map();
  for (const r of rows) {
    m.set(String(r.service || '').trim() + ' ' + String(r.plan || '').trim(), {
      durationDays: asNum(r.duration_days),
      d8plus: asNum(r.early_renew_discount),
      d7to2: asNum(r.early_renew_discount_7to2),
      logoUrl: String(r.logo_url || '').trim(),
    });
  }
  _plans = m; _plansAt = Date.now();
  return m;
}
function planInfo(map, service, plan) {
  return map.get(String(service || '').trim() + ' ' + String(plan || '').trim())
    || { durationDays: 0, d8plus: 0, d7to2: 0, logoUrl: '' };
}

// Per-device profile details for a plan card (no passwords here — those stay behind Recover / the access email).
function devicesOf(r) {
  const b = deviceLogins.buildLogins(r._group || [r]);
  return {
    deviceCount: b.deviceCount, sameLogin: b.sameLogin,
    list: b.logins.map((x) => ({ device: x.device, profileNumber: x.profileNumber, profileName: x.profileName, profilePIN: x.profilePin })),
  };
}

async function getMySubscriptions(phone) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone is required.' };
  const groupsOn = await deviceLogins.groupsReady(db.query);
  const allRows = await db.query(
    `SELECT sub_id, order_id, service, plan, email, start_date, expiry_date,
            profile_number, profile_name, profile_pin, inventory_ref, status, fulfillment_status` + (groupsOn ? ', device_count, group_id, group_index' : '') + `
     FROM subscriptions WHERE phone_norm = ?`, [ph]);
  const infoBanner = '📱 Please enter the same phone number you used to buy subscriptions.';
  if (!allRows.length) return { ok: true, phone: ph, infoBanner, actionable: [], history: [] };
  // F1: a purchase with separate logins (one row per login, same group_id) is ONE plan card with N devices.
  const groupRows = new Map();
  const rows = [];
  for (const r of allRows) {
    const g = groupsOn && r.group_id ? String(r.group_id) : '';
    if (!g) { rows.push(r); continue; }
    if (!groupRows.has(g)) { groupRows.set(g, []); rows.push(r); }
    groupRows.get(g).push(r);
  }
  for (let i = 0; i < rows.length; i++) {
    const list = rows[i].group_id && groupRows.get(String(rows[i].group_id));
    if (list && list.length > 1) { list.sort((a, b) => asNum(a.group_index) - asNum(b.group_index)); rows[i] = Object.assign({}, list[0], { _group: list }); }
  }

  const plansMap = await getPlansMap();
  const nowMs = Date.now();
  const all = rows.map((r) => {
    const svc = String(r.service || '').trim();
    const plan = String(r.plan || '').trim();
    // Calendar days in India from the expiry DATE: today = 0 ("Expires today"), yesterday = -1, tomorrow = 1.
    const daysLeft = renewRules.daysLeftIst(r.expiry_date, nowMs);
    const pInfo = planInfo(plansMap, svc, plan);
    const disc = calcEarlyDiscount(daysLeft, pInfo);
    const elig = renewEligibility(daysLeft);
    const mood = expiryMood(daysLeft);
    const devices = groupsOn ? devicesOf(r) : null;
    // Refunded / cancelled: the plan has ended even when its expiry date is still ahead → History, no renew.
    const stopped = stoppedRow(r);
    if (stopped) return Object.assign({
      subId: String(r.sub_id || '').trim(),
      orderId: String(r.order_id || '').trim(),
      service: svc,
      plan: plan,
      maskedEmail: maskEmailFirst4(r.email),
      logoUrl: pInfo.logoUrl,
      startDate: isoOrRaw(r.start_date),
      expiryDate: isoOrRaw(r.expiry_date),
      durationDays: asNum(pInfo.durationDays),
      earlyRenewDiscountEligible: 0,
      earlyRenewDiscountTier: '',
      earlyDiscount8Plus: 0,
      earlyDiscount7to2: 0,
      profileNumber: '',
      profileName: '',
      profilePIN: '',
      daysLeft: daysLeft,
      moodEmoji: '↩️',
      moodText: stopped === 'CANCELLED' ? 'Cancelled' : 'Refunded',
      renewEligibility: stopped,
      uiTone: 'faded_grey',
      showRenewButton: false,
      refunded: true,
      endedReason: stopped,
      inventoryRef: '',
      status: String(r.status || '').trim().toUpperCase(),
      fulfillmentStatus: String(r.fulfillment_status || '').trim().toUpperCase(),
    });
    return Object.assign({
      subId: String(r.sub_id || '').trim(),
      orderId: String(r.order_id || '').trim(),
      service: svc,
      plan: plan,
      maskedEmail: maskEmailFirst4(r.email),
      logoUrl: pInfo.logoUrl,
      startDate: isoOrRaw(r.start_date),
      expiryDate: isoOrRaw(r.expiry_date),
      durationDays: asNum(pInfo.durationDays),
      earlyRenewDiscountEligible: disc.amount,
      earlyRenewDiscountTier: disc.tier,
      earlyDiscount8Plus: asNum(pInfo.d8plus),
      earlyDiscount7to2: asNum(pInfo.d7to2),
      profileNumber: String(r.profile_number || '').trim(),
      profileName: String(r.profile_name || '').trim(),
      profilePIN: String(r.profile_pin || '').trim(),
      daysLeft: daysLeft,
      moodEmoji: mood.emoji,
      moodText: mood.text,
      renewEligibility: elig,
      uiTone: elig === 'CAN_RENEW' ? 'normal' : (elig === 'LATE_RENEW' ? 'faded_red' : 'faded_grey'),
      // Refunded / cancelled / not-yet-delivered rows cannot be renewed (order.js renewQuote refuses them too).
      showRenewButton: elig !== 'TOO_LATE' && renewableRow(r),
      inventoryRef: String(r.inventory_ref || '').trim(),
      // ⏳ Renewal reminder pop-up skips refunded / cancelled plans (admin refund sets CANCELLED + REFUNDED).
      status: String(r.status || '').trim().toUpperCase(),
      fulfillmentStatus: String(r.fulfillment_status || '').trim().toUpperCase(),
    }, devices && devices.deviceCount > 1 ? { deviceCount: devices.deviceCount, sameLogin: devices.sameLogin, devices: devices.list } : {});
  });

  const actionable = all.filter((x) => !x.refunded && x.renewEligibility !== 'TOO_LATE');
  const tooLate = all.filter((x) => !x.refunded && x.renewEligibility === 'TOO_LATE');
  const stoppedList = all.filter((x) => x.refunded);
  const t = (x) => { const d = parseDbDate(x.expiryDate); return d ? d.getTime() : null; };
  actionable.sort((a, b) => (t(a) == null ? 9e15 : t(a)) - (t(b) == null ? 9e15 : t(b)));
  tooLate.sort((a, b) => (t(b) == null ? 0 : t(b)) - (t(a) == null ? 0 : t(a)));
  // Customers whose plan ended a while ago can still renew (the renewal rules decide how many
  // days are counted), so list every plan that ended in the last RENEW_VISIBLE_DAYS days
  // (default 60, at most 10) — previously only the 3 most recent were shown.
  const visibleDays = Number(process.env.RENEW_VISIBLE_DAYS || 60);
  const recent = tooLate.filter((x) => x.daysLeft != null && x.daysLeft >= -visibleDays);
  // Refunded / cancelled plans from the last RENEW_VISIBLE_DAYS show first in History (clearly marked, no renew).
  const stoppedRecent = stoppedList.filter((x) => x.daysLeft == null || x.daysLeft >= -visibleDays).slice(0, 5);
  const history = stoppedRecent.concat((recent.length > 3 ? recent : tooLate.slice(0, 3)).slice(0, 10 - stoppedRecent.length));
  return { ok: true, phone: ph, infoBanner, actionable, history };
}

async function getCustomerOrders(phone, limit) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone is required.' };
  const max = Number(limit) || 15;
  const rows = await db.query(
    `SELECT order_id, created_at_sheet, service, plan, status, fulfillment_status,
            final_amount, discount, currency, raw_json
     FROM orders WHERE phone_norm = ?
     ORDER BY created_at_sheet DESC LIMIT ?`, [ph, max]);
  const orders = rows.map((r) => {
    const raw = rawOf(r.raw_json);
    const o = {
      orderId: String(r.order_id || '').trim(),
      createdAt: isoOrRaw(r.created_at_sheet),
      service: String(r.service || '').trim(),
      plan: String(r.plan || '').trim(),
      status: String(r.status || '').trim(),
      fulfillmentStatus: String(r.fulfillment_status || '').trim(),
      amount: asNum(r.final_amount),
      discount: asNum(r.discount),
      currency: String(r.currency || 'INR').trim(),
    };
    // Admin order actions: refund details and "delivered again after a failed attempt" for the Orders badges.
    if (o.status.toUpperCase() === 'REFUNDED') {
      // refundKind CREDIT | COUPON | UPI_PENDING | UPI | OTHER; refundState ASK_CUSTOMER | UPI_REQUESTED | DONE (refunds.js).
      const ri = require('./refunds').refundInfo(r);
      Object.assign(o, { refundAmount: ri.amount, refundMethod: ri.method, refundedAt: isoOrRaw(raw.RefundedAt), refundKind: ri.kind, refundState: ri.state, refundCredit: ri.credit, refundCoupon: ri.coupon });
    }
    if (asNum(raw.RefundCreditUsed) > 0) o.creditUsed = asNum(raw.RefundCreditUsed);
    if (raw.Refulfilled === true || String(raw.Refulfilled || '').toUpperCase() === 'TRUE') o.redelivered = true;
    return o;
  });
  return { ok: true, orders };
}

/** Saved avatar-creator settings, only if they still pass the strict check. */
function avatarConfigOf(raw) {
  try { const v = raw && raw.AvatarConfig && require('./avatarmaker').validate(raw.AvatarConfig); return v && v.ok ? v.config : null; } catch (_) { return null; }
}

function avatarUrlOf(raw) {
  const c = avatarConfigOf(raw);
  return c ? require('./avatarmaker').url(c) : '';
}

async function getCustomerProfile(phone) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone required' };
  const rows = await db.query(
    'SELECT phone, name, email, profile_pic_url, member_since, raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!rows.length) return { ok: false, message: 'Customer not found' };
  const r = rows[0];
  const raw = rawOf(r.raw_json);
  const pick = (keys, dflt) => { for (const k of keys) { if (raw[k] != null && raw[k] !== '') return raw[k]; } return dflt; };
  const updated = pick(['UpdatedAt', 'LastActivity', 'lastActivity'], '');
  return {
    ok: true,
    customerId: String(pick(['CustomerID'], '') || ''),
    name: String(r.name || ''),
    email: String(r.email || ''),
    phone: r.phone || ph,
    memberSince: r.member_since ? isoOrRaw(r.member_since) : '',
    updatedAt: updated ? isoOrRaw(updated) : '',
    lastActivity: updated ? isoOrRaw(updated) : '',
    totalOrders: Number(pick(['TotalOrders'], 0)) || 0,
    totalSpent: Number(pick(['TotalSpent'], 0)) || 0,
    status: String(pick(['Status'], '') || ''),
    profilePicUrl: String(r.profile_pic_url || pick(['ProfilePicUrl', 'AvatarUrl', 'PhotoUrl'], '') || ''),
    avatarConfig: avatarConfigOf(raw), // ✨ avatar creator settings (avatars.js), or null
    avatarUrl: avatarUrlOf(raw),       // …and its picture link, so the picker can offer it again after a photo
  };
}

async function getActiveCouponsForCustomer(phone) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone required' };
  const couponRows = await db.query('SELECT raw_json FROM coupons', []);
  if (!couponRows.length) return { ok: true, coupons: [] };
  const usageRows = await db.query(
    "SELECT coupon_code, COUNT(*) c FROM coupon_usage WHERE phone_norm = ? AND UPPER(action) = 'USED' GROUP BY coupon_code", [ph]);
  const usedMap = new Map();
  for (const u of usageRows) usedMap.set(String(u.coupon_code || '').trim().toUpperCase(), Number(u.c) || 0);

  const out = [];
  for (const cr of couponRows) {
    const raw = rawOf(cr.raw_json);
    if (String(raw.Active || '').toUpperCase() !== 'TRUE') continue;
    const showInProfile = raw.ShowInProfile != null ? String(raw.ShowInProfile).toUpperCase() : 'TRUE';
    if (showInProfile !== 'TRUE') continue;
    const code = String((raw.CouponCode != null ? raw.CouponCode : '') || (raw.Code != null ? raw.Code : '') || '').trim().toUpperCase();
    if (!code) continue;
    const allowedRaw = raw.AllowedPhones != null ? String(raw.AllowedPhones).trim() : 'ALL';
    if (allowedRaw && allowedRaw.toUpperCase() !== 'ALL') {
      const allowed = allowedRaw.split(',').map((x) => normPhone(x)).filter(Boolean);
      if (!allowed.includes(ph)) continue;
    }
    const perLimit = raw.PerUserLimit != null ? Number(raw.PerUserLimit || 0) : 0;
    const used = usedMap.get(code) || 0;
    if (perLimit > 0 && used >= perLimit) continue;
    out.push({
      code,
      description: String(raw.Description || ''),
      scope: String(raw.Scope || 'ANY'),
      type: String(raw.Type || ''),
      value: Number(raw.Value || 0),
      minAmount: Number(raw.MinAmount || 0),
      maxDiscount: Number(raw.MaxDiscount || 0),
      expiry: raw.Expiry ? isoOrRaw(raw.Expiry) : '',
      perUserLimit: perLimit,
      usedByUser: used,
      remaining: perLimit > 0 ? Math.max(0, perLimit - used) : 'Unlimited',
    });
  }
  return { ok: true, coupons: out };
}

async function getWalletByPhone(phone) {
  const ph = normPhone(phone);
  if (!ph) return { ok: false, message: 'Phone required.' };
  const rows = await db.query(
    'SELECT coins_balance, coins_lifetime, last_earned_at, last_spent_at, last_event FROM wallet WHERE phone_norm = ? ORDER BY coins_lifetime DESC, coins_balance DESC LIMIT 1', [ph]);
  // 💸 Refund credit: a separate pot (coins.js), ₹1 = 1, can pay the full price of an order.
  let refundCredit = 0;
  try { refundCredit = await require('./coins').creditBalance(ph); } catch (e) { refundCredit = 0; }
  if (!rows.length) return { ok: true, phone: ph, coinsBalance: 0, coinsLifetime: 0, refundCredit, lastEarnedAt: '', lastSpentAt: '', lastEvent: '' };
  const r = rows[0];
  return {
    ok: true, phone: ph, refundCredit,
    coinsBalance: asNum(r.coins_balance),
    coinsLifetime: asNum(r.coins_lifetime),
    lastEarnedAt: r.last_earned_at ? isoOrRaw(r.last_earned_at) : '',
    lastSpentAt: r.last_spent_at ? isoOrRaw(r.last_spent_at) : '',
    lastEvent: String(r.last_event || ''),
  };
}

/** Admin changed a plan: next read reloads durations / renew discounts / logos. */
function clearPlansCache() { _plans = null; _plansAt = 0; }

module.exports = { clearPlansCache, getMySubscriptions, getCustomerOrders, getCustomerProfile, getActiveCouponsForCustomer, getWalletByPhone,
  _internal: { normPhone, calcEarlyDiscount, renewEligibility, expiryMood, stoppedRow, maskEmailFirst4, parseDbDate } };
