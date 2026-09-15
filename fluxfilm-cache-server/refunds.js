/**
 * FluxFilm - customer-friendly refunds. Used by the admin Refund dialog (adminorderactions.js), the admin 💸 Refunds
 * screen (adminrefunds.js), the storefront (server.js actions) and the Today to-dos (adminhome.js).
 *
 * Refunds v3 (owner decisions 15 Sep 2026): THE CUSTOMER decides how they get their refund.
 *   🪙 Coins  = refund + bonus% (admin setting, default 10) as refund credit (₹1 = 1, pays up to 100%), instant.
 *   🎟️ Coupon = refund + bonus% as a personal single-use coupon (180 days), instant.
 *   🏦 UPI    = the EXACT refund, after an email code to the order's own email; the owner sends it (💸 Refunds to send
 *               → ✅ Done + UTR) and the customer is emailed + sees a one-time "✅ sent" pop-up.
 *
 * 1) NOT delivered (admin → order → 💸 Refund). The owner can still refund directly as Coins / Coupon (no bonus) or
 *    record a refund made outside, but the normal way is UPI_ASK = "let the customer choose":
 *      order REFUNDED, RefundMethod UPI_PENDING, RefundState ASK_CUSTOMER → the home screen asks. chooseForOrder()
 *      (coins / coupon) or requestUpi() (RefundState UPI_REQUESTED + Today to-do) → completeUpi() (RefundMethod UPI).
 *    The order status stays REFUNDED in every case; what is still open lives in raw_json.RefundState.
 * 2) DELIVERED plans (admin → 💸 Offer refund on an order / subscription). createOffer() stores a refund_offers row
 *    (db/schema-v26.sql) — NO_REPLACEMENT (no charge) or MID_PERIOD (usage charge the owner set, suggested = days used
 *    ÷ total days × paid) — emails the customer and the website shows a banner. The order stays PAID until the
 *    customer chooses (acceptOffer / requestUpi). Accepting (any method) marks the order REFUNDED (same raw_json shape
 *    as 1, plus RefundKind DELIVERED / RefundOfferId / RefundCharge) and every subscription of that purchase REFUNDED,
 *    so Recover / Get OTP / Games stop, renew is blocked and 🚪 Remove users lists the customer as inactive.
 *    A UPI choice becomes the same UPI_PENDING / UPI_REQUESTED order state as 1, so the queue and ✅ Done are shared.
 *    Offers expire after offerDays (admin setting, default 30) and the owner can cancel an open one.
 *
 * Safety: amounts only ever come from the server (the order / the stored offer). Every change locks the rows
 * (SELECT … FOR UPDATE) in one transaction, checks the phone owns them, and moves the state with a guarded update
 * (… WHERE status = 'OFFERED'), so double taps / two devices / admin + customer at the same moment can never credit
 * twice or credit AND pay out. A UPI ID needs an email code (otpaccess.js) sent to the email on THAT order (never
 * the profile email): a phone number alone must never redirect money.
 */
const crypto = require('crypto');
const { isDeliveredSub } = require('./delivered');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return Object.assign({}, v); try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }
const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const maskPhone = (ph) => { const p = norm(ph); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
/** 'YYYY-MM-DD HH:MM:SS' (India time, how MySQL returns dates here) or a Date → Date. */
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}
const DAY = 86400e3;

const BONUS_PERCENT = 10;                 // default bonus for coins / coupon (admin → 💸 Refunds → settings)
const OFFER_DAYS = 30;                    // default: an offer on a delivered plan stays open this many days
const SETTINGS_KEY = 'refund_settings';
const COUPON_DAYS = 180;
const COUPON_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SENT_POPUP_DAYS = 30;               // "✅ Your refund was sent" pop-up: only for UPI refunds sent recently
// name@handle: letters, digits, dot, dash, underscore before @; a letters-first handle after it (e.g. okhdfcbank, ybl).
const UPI_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}@[a-zA-Z][a-zA-Z0-9]{1,49}$/;
const OFFER_RE = /^RO[A-Z0-9]{8}$/;
const REASONS = { NO_REPLACEMENT: 'No replacement available', MID_PERIOD: 'Mid-period refund' };
// ⚡ Refund now (adminrefundnow.js): refunds the owner issues directly are refund_offers rows with an RN… id.
const NOW_REASONS = { NO_REPLACEMENT: 'No replacement', MID_PERIOD: 'Mid-period', NOT_DELIVERED: 'Not delivered', OTHER: 'Other' };
const NOW_ID_RE = /^RN[A-Z0-9]{8}$/;
const TODO_MARK = (id) => '[upi-refund:' + id + ']';
const TODO_MARK_RE = /\[upi-refund:(FF\d{1,14})\]/;
/** refund + bonus% in whole rupees (coins / coupon value). */
const bonusCredit = (amount, percent) => { const a = Math.round(asNum(amount)); const p = percent == null ? BONUS_PERCENT : asNum(percent); return a + Math.round(a * p / 100); };
const maskUpi = (u) => { const [n, h] = s(u).split('@'); if (!h) return ''; return (n.length <= 3 ? n[0] + '•••' : n.slice(0, 3) + '•'.repeat(Math.min(5, n.length - 3))) + '@' + h; };
const siteUrl = () => (s(process.env.SITE_URL) || 'https://shop.fluxfilm.in').replace(/\/+$/, '');

class Refused extends Error { constructor(message, extra) { super(message); this.extra = extra || {}; } }

/** Admin settings: { bonusPercent 0–50, offerDays 1–90 }. Missing values → defaults; a bad value → error. */
function validateSettings(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const out = { bonusPercent: BONUS_PERCENT, offerDays: OFFER_DAYS };
  const errors = [];
  const int = (k, min, max, label) => {
    if (inp[k] == null || inp[k] === '') return;
    const n = Number(inp[k]);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(label + ' must be a whole number from ' + min + ' to ' + max + '.');
    else out[k] = n;
  };
  int('bonusPercent', 0, 50, 'Extra for coins / coupon (%)');
  int('offerDays', 1, 90, 'Days the customer has to choose');
  return { ok: !errors.length, settings: out, errors };
}

/**
 * Suggested usage charge for a mid-period refund: days used ÷ total days × paid (whole rupees).
 * The paid period is the `totalDays` before the plan's expiry, so a renewal paid early counts from its own start.
 */
function suggestCharge({ paid, totalDays, periodEnd, now }) {
  const p = Math.max(0, Math.round(asNum(paid)));
  const total = Math.max(1, Math.round(asNum(totalDays)) || 30);
  const end = toDate(periodEnd);
  const at = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const start = end ? new Date(end.getTime() - total * DAY) : null;
  const used = start ? Math.min(total, Math.max(0, Math.ceil((at.getTime() - start.getTime()) / DAY))) : 0;
  return { paid: p, totalDays: total, daysUsed: used, suggested: Math.min(p, Math.round(p * used / total)), periodStart: start ? fmtDt(start) : '', periodEnd: end ? fmtDt(end) : '' };
}
/** What the customer gets: refund = paid − charge, never below 0 (no charge for NO_REPLACEMENT). */
function offerAmounts(paid, reason, charge) {
  const p = Math.max(0, Math.round(asNum(paid)));
  const c = up(reason) === 'NO_REPLACEMENT' ? 0 : Math.min(p, Math.max(0, Math.round(asNum(charge))));
  return { paid: p, charge: c, refund: Math.max(0, p - c) };
}

/** A refunded order's refund, as the storefront / admin show it. */
function refundInfo(o) {
  const raw = rawOf(o.raw_json);
  const method = s(raw.RefundMethod);
  const m = up(method);
  const kind = m === 'UPI_PENDING' ? 'UPI_PENDING' : /COIN|CREDIT/.test(m) ? 'CREDIT' : m === 'COUPON' ? 'COUPON' : m === 'UPI' ? 'UPI' : m ? 'OTHER' : '';
  return {
    amount: asNum(raw.RefundAmount != null ? raw.RefundAmount : o.final_amount), method, kind,
    state: s(raw.RefundState) || (kind === 'UPI_PENDING' ? 'ASK_CUSTOMER' : kind ? 'DONE' : ''),
    credit: asNum(raw.RefundCredit || (kind === 'CREDIT' ? raw.RefundCoins : 0)), bonus: asNum(raw.RefundBonus),
    coupon: s(raw.RefundCoupon), couponExpiry: s(raw.RefundCouponExpiry), upi: s(raw.RefundUpi), at: s(raw.RefundedAt),
    todoId: raw.RefundTodoId || null, reference: s(raw.RefundRef),
    delivered: up(raw.RefundKind) === 'DELIVERED', offerId: s(raw.RefundOfferId), charge: asNum(raw.RefundCharge), paid: asNum(raw.RefundPaid),
    byAdmin: raw.RefundNow === true,
  };
}

function create(deps) {
  deps = deps || {};
  const lazy = (name) => () => deps[name] || require('./' + name);
  const M = { db: lazy('db'), coins: lazy('coins'), push: lazy('push'), mailer: lazy('mailer'), otpaccess: lazy('otpaccess') };
  const now = () => (deps.now ? deps.now() : new Date());

  async function withTx(fn) {
    const pool = M.db().getPool && M.db().getPool();
    if (!pool) throw new Error('DB not configured');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try { const out = await fn(conn); await conn.commit(); return out; } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
    } finally { conn.release(); }
  }
  const rowsOf = async (conn, sql, p) => { const [r] = await conn.query(sql, p); return r || []; };
  const saveRaw = (conn, orderId, raw) => conn.query('UPDATE orders SET raw_json = ? WHERE order_id = ? LIMIT 1', [JSON.stringify(raw), orderId]);
  const lockOrder = async (conn, orderId) => (await rowsOf(conn, 'SELECT order_id, service, plan, name, email, phone, phone_norm, status, final_amount, raw_json FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [orderId]))[0] || null;
  const lockOffer = async (conn, offerId) => (await rowsOf(conn, 'SELECT * FROM refund_offers WHERE offer_id = ? LIMIT 1 FOR UPDATE', [offerId]))[0] || null;
  const oidOf = (v) => { const id = up(v); return /^FF\d{1,14}$/.test(id) ? id : ''; };
  const offerIdOf = (v) => { const id = up(v); return OFFER_RE.test(id) ? id : ''; };
  const expired = (ro) => { const d = toDate(ro && ro.expires_at); return !d || d.getTime() <= now().getTime(); };
  const refusedOut = (e) => Object.assign({ ok: false, message: e.message }, e.extra);

  // ------------------------------------------------------------------ settings (app_settings 'refund_settings')
  let cfgCache = null; let cfgAt = 0;
  async function getSettings(fresh) {
    if (!fresh && cfgCache && Date.now() - cfgAt < 60e3) return cfgCache;
    let saved = null;
    try {
      const r = await M.db().query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
      saved = r && r[0] && r[0].value ? JSON.parse(r[0].value) : null;
    } catch (_) { saved = null; }
    const v = validateSettings(saved || {});
    cfgCache = v.ok ? v.settings : validateSettings({}).settings; cfgAt = Date.now();
    return cfgCache;
  }
  async function saveSettings(input) {
    const cur = await getSettings(true);
    const v = validateSettings(Object.assign({}, cur, input || {}));
    if (!v.ok) return { ok: false, status: 400, message: v.errors.join(' '), errors: v.errors };
    await M.db().query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTINGS_KEY, JSON.stringify(v.settings)]);
    cfgCache = v.settings; cfgAt = Date.now();
    return { ok: true, settings: v.settings, before: cur };
  }

  // ------------------------------------------------------------------ notifications (never block, never throw)
  function notify(o, kind, d) {
    d = d || {};
    const amt = '₹' + asNum(d.amount);
    const svc = s(o.service);
    const pct = d.bonusPercent == null ? BONUS_PERCENT : asNum(d.bonusPercent);
    const T = {
      CREDIT: ['💸 ' + amt + ' refund credit added', 'Your ' + svc + ' order ' + o.order_id + ' was refunded as ' + asNum(d.credit) + ' coins of refund credit. Use it on any plan — it can pay the full price.'],
      COUPON: ['🎟️ Your ' + amt + ' refund coupon', 'Your ' + svc + ' order ' + o.order_id + ' was refunded as coupon ' + s(d.coupon) + ' (₹' + asNum(d.value || d.amount) + ' off any plan). Find it in Account → Coupons.'],
      ASK: ['💸 Your ' + svc + ' order was refunded', 'Open FluxFilm to choose: ' + asNum(d.credit) + ' coins or a ₹' + asNum(d.credit) + ' coupon (' + pct + '% extra), or ' + amt + ' to your UPI.'],
      CONVERTED: ['💸 ' + asNum(d.credit) + ' coins of refund credit added', 'Thanks! Your refund for ' + o.order_id + ' is now ' + asNum(d.credit) + ' coins of refund credit (incl. ' + asNum(d.bonus) + ' extra). Use it on any plan.'],
      UPI_REQUESTED: ['💸 UPI refund requested', 'We\'ll send ' + amt + ' for order ' + o.order_id + ' to ' + maskUpi(d.upi) + ' within 24 hours.'],
      UPI_SENT: ['💸 ' + amt + ' refunded to your UPI', amt + ' for order ' + o.order_id + ' was sent to ' + (d.upi ? maskUpi(d.upi) : 'your UPI') + (d.reference ? ' (ref ' + s(d.reference) + ')' : '') + '.'],
      RECORDED: ['💸 Refund for your ' + svc + ' order', 'We refunded ' + amt + (d.how ? ' ' + d.how : '') + ' for order ' + o.order_id + '. Sorry we could not deliver it.'],
      OFFER: ['💸 Your refund of ' + amt + ' is ready', 'Paid ₹' + asNum(d.paid) + (asNum(d.charge) > 0 ? ' − usage charge ₹' + asNum(d.charge) : '') + ' = refund ' + amt + ' for order ' + o.order_id + '. Open FluxFilm to choose how you want it.'],
    }[kind];
    if (!T) return;
    const [title, body] = T;
    const tag = 'refund-' + s(o.order_id).replace(/[^\w-]/g, '');
    // A refund to choose opens the choice sheet (?refund=1); every other refund notice opens the home screen.
    if (kind === 'OFFER' || kind === 'ASK') Promise.resolve().then(() => M.push().sendToPhone(o.phone_norm, { title, body, url: '/?refund=1', tag }, { kind: 'refund' })).catch(() => {});
    else Promise.resolve().then(() => M.push().sendToPhone(o.phone_norm, { title, body, url: '/?source=push', tag }, { kind: 'refund' })).catch(() => {});
    if (!s(o.email).includes('@')) return Promise.resolve({ ok: false, skipped: 'no email' });
    const P = (t) => '<p style="color:#475569;font-size:14px">' + t + '</p>';
    const button = '<p style="margin:18px 0"><a href="' + esc(siteUrl()) + '/?refund=1" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;display:inline-block">Open FluxFilm and choose</a></p>';
    const choices = (credit) => P('🪙 <b>' + esc(credit) + ' coins</b> of refund credit (' + esc(amt) + ' + ' + esc(pct) + '% extra) — added instantly, can pay the full price of any plan<br>🎟️ <b>₹' + esc(credit) + ' coupon</b> (' + esc(amt) + ' + ' + esc(pct) + '% extra) — instant, one use, valid ' + COUPON_DAYS + ' days<br>🏦 <b>exactly ' + esc(amt) + ' to your UPI ID</b> — our team sends it and tells you when it\'s done');
    let extra = '';
    if (kind === 'ASK') extra = P('Open <b>FluxFilm</b> and sign in with your phone number — you\'ll see three choices:') + choices(d.credit) + button;
    else if (kind === 'UPI_REQUESTED') extra = P('You asked us to send your refund to <b>' + esc(maskUpi(d.upi)) + '</b>. We\'ll send it within 24 hours and let you know. <b>Didn\'t ask for this?</b> Reply to this email straight away.');
    else if (kind === 'COUPON') extra = P('Coupon <b style="font-size:18px;letter-spacing:1px">' + esc(d.coupon) + '</b> — ₹' + esc(asNum(d.value || d.amount)) + ' off any plan, only for your number, valid until ' + esc(s(d.expiry).slice(0, 10)) + '. It\'s also in Account → Coupons. If the plan costs less than the coupon, the rest of it is not kept.');
    else if (kind === 'OFFER') {
      const why = up(d.reason) === 'NO_REPLACEMENT'
        ? 'We could not give you a replacement account, so you get <b>everything you paid</b> back — no charge.'
        : 'This is a refund in the middle of your plan. The usage charge of <b>₹' + esc(asNum(d.charge)) + '</b> is for the time you used' + (d.daysUsed != null && d.totalDays ? ' (' + esc(d.daysUsed) + ' of ' + esc(d.totalDays) + ' days)' : '') + '.';
      extra = '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:6px 0 12px">' +
        '<tr><td style="padding:6px 0;color:#64748b">You paid</td><td style="text-align:right;font-weight:700">₹' + esc(asNum(d.paid)) + '</td></tr>' +
        '<tr><td style="padding:6px 0;color:#64748b">Usage charge</td><td style="text-align:right;font-weight:700">' + (asNum(d.charge) > 0 ? '− ₹' + esc(asNum(d.charge)) : 'No charge') + '</td></tr>' +
        '<tr><td style="padding:6px 0;color:#0f172a;font-weight:800">Your refund</td><td style="text-align:right;font-weight:800;color:#0f766e;font-size:16px">' + esc(amt) + '</td></tr></table>' +
        P(why) + (s(d.note) ? P('Note from FluxFilm: <i>' + esc(d.note) + '</i>') : '') +
        P('Choose how you want it in the app:') + choices(d.credit) + button +
        P('This refund is ready for you until <b>' + esc(s(d.expiresAt).slice(0, 10)) + '</b>. When you take it, this plan stops working (the account is refunded).');
    }
    // ⚡ Refund now (adminrefundnow.js): the owner's optional note to the customer on the other refund emails.
    if (kind !== 'OFFER' && s(d.note)) extra += P('Note from FluxFilm: <i>' + esc(d.note) + '</i>');
    const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto"><h2 style="color:#0f766e;margin-bottom:4px">' + esc(title) + '</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + esc(o.name || 'there') + ',</p>' +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px"><b>' + esc(o.service) + '</b> — ' + esc(o.plan) + '<br>Order ID: ' + esc(o.order_id) + '<br>' + esc(body) + '</div>' + extra +
      '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';
    return Promise.resolve().then(() => M.mailer().send(o.email, title + ' — FluxFilm order ' + o.order_id, html)).catch(() => ({ ok: false }));
  }

  // ------------------------------------------------------------------ admin refund helpers (run inside its transaction)
  // Personal single-use coupon worth `amount`: typed columns AND raw_json (couponDiscount reads raw_json only),
  // same shape as admin → Coupons / games prizes.
  async function createRefundCouponOn(conn, { orderId, phone, amount }) {
    const ph = norm(phone); const value = Math.round(asNum(amount));
    if (!ph || !(value > 0)) throw new Refused('Coupon refund needs the customer’s phone and an amount.');
    let code = '';
    for (let i = 0; i < 8 && !code; i++) {
      let c = 'RF'; for (let j = 0; j < 6; j++) c += COUPON_CHARS[crypto.randomInt(0, COUPON_CHARS.length)];
      if (!(await rowsOf(conn, 'SELECT code FROM coupons WHERE code = ? LIMIT 1', [c])).length) code = c;
    }
    if (!code) throw new Error('Could not pick a free coupon code — try again.');
    const ex = new Date(now()); ex.setDate(ex.getDate() + COUPON_DAYS);
    const expiry = fmtDt(ex).slice(0, 10) + ' 23:59:59';
    const raw = {
      Code: code, CouponCode: code, Description: '💸 Refund for order ' + orderId + ' — ₹' + value + ' off', Scope: 'ANY', Type: 'FLAT', Value: value,
      MinAmount: 0, MaxDiscount: 0, Expiry: expiry, PerUserLimit: 1, GlobalLimit: 1, Active: 'TRUE', ShowInProfile: 'TRUE',
      AllowedPhones: ph, FirstTimeOnly: 'FALSE', Source: 'REFUND', RefundOrderId: orderId,
    };
    await conn.query(
      'INSERT INTO coupons (code, description, scope, type, value, min_amount, max_discount, expiry, per_user_limit, global_limit, active, show_in_profile, allowed_phones, first_time_only, raw_json)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [code, raw.Description, raw.Scope, raw.Type, raw.Value, raw.MinAmount, raw.MaxDiscount, expiry, raw.PerUserLimit, raw.GlobalLimit, raw.Active, raw.ShowInProfile, raw.AllowedPhones, raw.FirstTimeOnly, JSON.stringify(raw)]);
    return { code, value, expiry };
  }

  // ------------------------------------------------------------------ offers on delivered plans: reads
  function offerView(ro) {
    const amount = Math.round(asNum(ro.refund_amount)); const pct = asNum(ro.bonus_percent);
    const value = bonusCredit(amount, pct);
    return {
      kind: 'offer', id: s(ro.offer_id), offerId: s(ro.offer_id), orderId: s(ro.order_id), service: s(ro.service), plan: s(ro.plan),
      reason: up(ro.reason), reasonLabel: REASONS[up(ro.reason)] || '', paid: Math.round(asNum(ro.paid_amount)), charge: Math.round(asNum(ro.charge_amount)),
      daysUsed: ro.days_used == null ? null : Number(ro.days_used), totalDays: ro.total_days == null ? null : Number(ro.total_days),
      amount, note: s(ro.note), bonusPercent: pct, credit: value, couponValue: value, couponDays: COUPON_DAYS, expiresAt: s(ro.expires_at), state: 'OFFERED',
    };
  }
  /** Open offers of this phone that the customer can still choose (not expired). [] before schema-v26. */
  async function openOffersFor(ph) {
    let rows = [];
    try { rows = await M.db().query("SELECT * FROM refund_offers WHERE phone_norm = ? AND status = 'OFFERED' ORDER BY created_at DESC LIMIT 10", [ph]); }
    catch (e) { if (missingTable(e)) return []; throw e; }
    return (rows || []).filter((ro) => norm(ro.phone_norm) === ph && !expired(ro)).map(offerView);
  }

  // ------------------------------------------------------------------ storefront
  /**
   * Everything the home screen needs for refunds of this phone:
   *   items  = not-delivered refunds waiting for the customer (ASK_CUSTOMER) or a UPI refund on its way (UPI_REQUESTED)
   *   offers = refunds offered on delivered plans (banner → choose)
   *   sent   = UPI refunds sent recently that the customer has not seen yet (one-time "✅ sent" pop-up)
   */
  async function getPendingRefunds(phone) {
    const ph = norm(phone);
    if (ph.length !== 10) return { ok: false, message: 'Phone required.' };
    const cfg = await getSettings();
    const rows = await M.db().query("SELECT order_id, service, plan, final_amount, status, raw_json FROM orders WHERE phone_norm = ? AND UPPER(status) = 'REFUNDED' ORDER BY created_at_sheet DESC LIMIT 20", [ph]);
    const items = []; const sent = [];
    const cutoff = now().getTime() - SENT_POPUP_DAYS * DAY;
    for (const o of rows) {
      const r = refundInfo(o); const raw = rawOf(o.raw_json);
      if (r.kind === 'UPI' && s(raw.RefundUpiSentAt) && !s(raw.RefundSentSeenAt)) {
        const at = toDate(raw.RefundUpiSentAt);
        if (at && at.getTime() >= cutoff) sent.push({ orderId: s(o.order_id), service: s(o.service), plan: s(o.plan), amount: r.amount, upi: r.upi ? maskUpi(r.upi) : '', reference: r.reference, sentAt: s(raw.RefundUpiSentAt) });
        continue;
      }
      if (r.kind !== 'UPI_PENDING' || !['ASK_CUSTOMER', 'UPI_REQUESTED'].includes(r.state)) continue;
      const pct = cfg.bonusPercent; const value = bonusCredit(r.amount, pct);
      items.push({ kind: 'order', id: s(o.order_id), orderId: s(o.order_id), service: s(o.service), plan: s(o.plan), amount: r.amount, paid: r.delivered ? r.paid : r.amount, charge: r.charge, state: r.state, bonusPercent: pct, credit: value, couponValue: value, couponDays: COUPON_DAYS, upi: r.upi ? maskUpi(r.upi) : '', delivered: r.delivered });
    }
    const offers = await openOffersFor(ph);
    return { ok: true, items, offers, sent, bonusPercent: cfg.bonusPercent };
  }

  /** Not-delivered refund (ASK_CUSTOMER): the customer takes it as coins or a coupon, with the bonus. */
  async function chooseForOrder(phone, orderId, method) {
    const ph = norm(phone); const oid = oidOf(orderId); const how = up(method) === 'COUPON' ? 'COUPON' : 'COINS';
    if (ph.length !== 10 || !oid) return { ok: false, message: 'Order not found.' };
    const cfg = await getSettings();
    try {
      const done = await withTx(async (conn) => {
        const o = await lockOrder(conn, oid);
        if (!o || s(o.phone_norm) !== ph) throw new Refused('Order not found.');
        const raw = rawOf(o.raw_json); const r = refundInfo(o);
        if (up(o.status) !== 'REFUNDED') throw new Refused('This order is not refunded.');
        if (raw.RefundConvertedAt) {
          if ((how === 'COINS' && r.kind === 'CREDIT') || (how === 'COUPON' && r.kind === 'COUPON')) return { already: true, o, r };
          throw new Refused('This refund was already taken as ' + (r.kind === 'COUPON' ? 'a coupon' : 'coins') + '.');
        }
        if (r.kind !== 'UPI_PENDING') throw new Refused('This refund was already completed.');
        if (r.state !== 'ASK_CUSTOMER') throw new Refused('You already asked for a UPI refund — it is on its way.', { state: r.state });
        const pct = cfg.bonusPercent;
        const value = bonusCredit(r.amount, pct); const bonus = value - Math.round(r.amount);
        const at = fmtDt(now());
        if (how === 'COINS') {
          const c = await M.coins().addRefundCreditOn(conn, { orderId: oid, phone: ph, credit: value, service: o.service, plan: o.plan, amount: r.amount, note: 'Cash refund for ' + oid + ' taken as refund credit (+' + pct + '%)' });
          if (!c.ok) throw new Error('Refund credit could not be added.');
          if (c.already) throw new Refused('This refund was already added as credit.');
          Object.assign(raw, { RefundMethod: 'Coins', RefundState: 'DONE', RefundCredit: value, RefundCoins: value, RefundBonus: bonus, RefundBonusPercent: pct, RefundConvertedAt: at });
          await saveRaw(conn, oid, raw);
          return { o, how, value, bonus, amount: r.amount, creditAfter: c.creditAfter, pct };
        }
        const cp = await createRefundCouponOn(conn, { orderId: oid, phone: ph, amount: value });
        Object.assign(raw, { RefundMethod: 'COUPON', RefundState: 'DONE', RefundCoupon: cp.code, RefundCouponExpiry: cp.expiry, RefundCouponValue: value, RefundBonus: bonus, RefundBonusPercent: pct, RefundConvertedAt: at });
        await saveRaw(conn, oid, raw);
        return { o, how, value, bonus, amount: r.amount, coupon: cp, pct };
      });
      if (done.already) {
        return done.r.kind === 'COUPON'
          ? { ok: true, already: true, orderId: oid, method: 'COUPON', coupon: done.r.coupon, message: '✅ Already added as coupon ' + done.r.coupon + '.' }
          : { ok: true, already: true, orderId: oid, method: 'COINS', credit: done.r.credit, message: '✅ Already added as refund credit.' };
      }
      if (done.how === 'COINS') {
        notify(done.o, 'CONVERTED', { amount: done.amount, credit: done.value, bonus: done.bonus });
        return { ok: true, orderId: oid, method: 'COINS', credit: done.value, bonus: done.bonus, creditBalance: done.creditAfter, message: '🪙 ' + done.value + ' coins of refund credit added — use them on any plan.' };
      }
      notify(done.o, 'COUPON', { amount: done.amount, value: done.value, coupon: done.coupon.code, expiry: done.coupon.expiry });
      return { ok: true, orderId: oid, method: 'COUPON', coupon: done.coupon.code, couponValue: done.value, couponExpiry: done.coupon.expiry, bonus: done.bonus, message: '🎟️ Coupon ' + done.coupon.code + ' (₹' + done.value + ' off, valid ' + COUPON_DAYS + ' days) added — find it in Account → Coupons.' };
    } catch (e) {
      if (e instanceof Refused) return refusedOut(e);
      throw e;
    }
  }
  const convertToCredit = (phone, orderId) => chooseForOrder(phone, orderId, 'COINS');

  /**
   * Accepting a delivered-plan offer (any method): the order becomes REFUNDED (typed columns + raw_json in step) and
   * every subscription of that purchase REFUNDED, so Recover / Get OTP / Games / renew stop for it.
   */
  async function endAccessOn(conn, o, ro, extra) {
    const at = fmtDt(now());
    const raw = rawOf(o.raw_json);
    Object.assign(raw, {
      Status: 'REFUNDED', FulfillmentStatus: 'REFUNDED', RefundedAt: at, RefundAmount: Math.round(asNum(ro.refund_amount)),
      RefundKind: 'DELIVERED', RefundOfferId: s(ro.offer_id), RefundReason: up(ro.reason), RefundPaid: Math.round(asNum(ro.paid_amount)), RefundCharge: Math.round(asNum(ro.charge_amount)),
      RefundNote: s(ro.note), PreviousFulfillmentStatus: up(raw.FulfillmentStatus) || 'FULFILLED', AccessEndedAt: at,
    }, extra || {});
    await conn.query("UPDATE orders SET status = 'REFUNDED', fulfillment_status = 'REFUNDED', raw_json = ? WHERE order_id = ? LIMIT 1", [JSON.stringify(raw), o.order_id]);
    const ids = [...new Set(s(ro.sub_ids).split(',').map(s).filter(Boolean))];
    let ended = 0;
    for (const sid of ids) {
      const x = (await rowsOf(conn, 'SELECT sub_id, phone_norm, status, raw_json FROM subscriptions WHERE sub_id = ? LIMIT 1 FOR UPDATE', [sid]))[0];
      if (!x || norm(x.phone_norm) !== norm(o.phone_norm)) continue;
      const sraw = x.raw_json == null ? null : Object.assign(rawOf(x.raw_json), { Status: 'REFUNDED', FulfillmentStatus: 'REFUNDED', RefundOfferId: s(ro.offer_id), AccessEndedAt: at, PreviousStatus: up(x.status) });
      await conn.query("UPDATE subscriptions SET status = 'REFUNDED', fulfillment_status = 'REFUNDED'" + (sraw ? ', raw_json = ?' : '') + ' WHERE sub_id = ? LIMIT 1', (sraw ? [JSON.stringify(sraw)] : []).concat([sid]));
      ended++;
    }
    return { at, ended };
  }

  // Locks the offer + its order and checks the customer may still take it. Returns { ro, o } or { already }.
  async function lockOpenOffer(conn, ph, id, sameMethod) {
    const ro = await lockOffer(conn, id);
    if (!ro || norm(ro.phone_norm) !== ph) throw new Refused('Refund not found.');
    const st = up(ro.status);
    if (st !== 'OFFERED') {
      if (sameMethod && sameMethod(ro)) return { already: true, ro };
      if (st === 'DONE' || st === 'UPI_REQUESTED') throw new Refused('You already chose how to get this refund.');
      if (st === 'CANCELLED') throw new Refused('This refund offer was cancelled. Please tap Help if you have a question.', { cancelled: true });
      throw new Refused('This refund offer has expired. Please tap Help if you still need it.', { expired: true });
    }
    if (expired(ro)) throw new Refused('This refund offer has expired. Please tap Help if you still need it.', { expired: true });
    const o = (await rowsOf(conn, 'SELECT * FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [s(ro.order_id)]))[0];
    if (!o || norm(o.phone_norm) !== ph || up(o.status) !== 'PAID') throw new Refused('This refund can no longer be taken. Please tap Help.');
    return { ro, o };
  }
  const guardOffer = async (conn, sql, params) => {
    const [u] = await conn.query(sql, params);
    if (!u || u.affectedRows !== 1) throw new Refused('You already chose how to get this refund.');
  };

  /** Delivered-plan offer taken as coins or a coupon (refund + the offer's bonus%), instantly, exactly once. */
  async function acceptOffer(phone, offerId, method) {
    const ph = norm(phone); const id = offerIdOf(offerId); const how = up(method) === 'COUPON' ? 'COUPON' : up(method) === 'COINS' ? 'COINS' : '';
    if (ph.length !== 10 || !id) return { ok: false, message: 'Refund not found.' };
    if (!how) return { ok: false, message: 'Choose coins, a coupon or UPI.' };
    try {
      const done = await withTx(async (conn) => {
        const got = await lockOpenOffer(conn, ph, id, (ro) => up(ro.status) === 'DONE' && up(ro.method) === how);
        if (got.already) return got;
        const { ro, o } = got;
        const amount = Math.round(asNum(ro.refund_amount)); const pct = asNum(ro.bonus_percent);
        if (!(amount > 0)) throw new Refused('Nothing to refund on this offer. Please tap Help.');
        const value = bonusCredit(amount, pct); const bonus = value - amount;
        const at = fmtDt(now());
        await guardOffer(conn, "UPDATE refund_offers SET status = 'DONE', method = ?, credit_amount = ?, accepted_at = ?, paid_at = ? WHERE offer_id = ? AND status = 'OFFERED' LIMIT 1", [how, value, at, at, id]);
        let extra; let coupon = null; let creditAfter;
        if (how === 'COINS') {
          const c = await M.coins().addRefundCreditOn(conn, { orderId: o.order_id, phone: ph, credit: value, service: o.service, plan: o.plan, amount, note: 'Refund offer ' + id + ' for ' + o.order_id + ' taken as refund credit (+' + pct + '%)' });
          if (!c.ok) throw new Error('Refund credit could not be added.');
          if (c.already) throw new Refused('This refund was already added as credit.');
          creditAfter = c.creditAfter;
          extra = { RefundMethod: 'Coins', RefundState: 'DONE', RefundCredit: value, RefundCoins: value, RefundBonus: bonus, RefundBonusPercent: pct, RefundConvertedAt: at };
        } else {
          coupon = await createRefundCouponOn(conn, { orderId: o.order_id, phone: ph, amount: value });
          await conn.query('UPDATE refund_offers SET coupon_code = ? WHERE offer_id = ? LIMIT 1', [coupon.code, id]);
          extra = { RefundMethod: 'COUPON', RefundState: 'DONE', RefundCoupon: coupon.code, RefundCouponExpiry: coupon.expiry, RefundCouponValue: value, RefundBonus: bonus, RefundBonusPercent: pct, RefundConvertedAt: at };
        }
        const end = await endAccessOn(conn, o, ro, extra);
        return { ro, o, how, amount, value, bonus, coupon, creditAfter, ended: end.ended };
      });
      if (done.already) {
        const ro = done.ro;
        return up(ro.method) === 'COUPON'
          ? { ok: true, already: true, offerId: id, method: 'COUPON', coupon: s(ro.coupon_code), message: '✅ Already added as coupon ' + s(ro.coupon_code) + '.' }
          : { ok: true, already: true, offerId: id, method: 'COINS', credit: Number(ro.credit_amount) || 0, message: '✅ Already added as refund credit.' };
      }
      if (done.how === 'COINS') {
        notify(done.o, 'CONVERTED', { amount: done.amount, credit: done.value, bonus: done.bonus });
        return { ok: true, offerId: id, orderId: s(done.o.order_id), method: 'COINS', credit: done.value, bonus: done.bonus, creditBalance: done.creditAfter, accessEnded: done.ended, message: '🪙 ' + done.value + ' coins of refund credit added — use them on any plan.' };
      }
      notify(done.o, 'COUPON', { amount: done.amount, value: done.value, coupon: done.coupon.code, expiry: done.coupon.expiry });
      return { ok: true, offerId: id, orderId: s(done.o.order_id), method: 'COUPON', coupon: done.coupon.code, couponValue: done.value, couponExpiry: done.coupon.expiry, bonus: done.bonus, accessEnded: done.ended, message: '🎟️ Coupon ' + done.coupon.code + ' (₹' + done.value + ' off, valid ' + COUPON_DAYS + ' days) added — find it in Account → Coupons.' };
    } catch (e) {
      if (e instanceof Refused) return refusedOut(e);
      if (missingTable(e)) return { ok: false, message: 'Refunds are being set up. Please try again later or tap Help.' };
      throw e;
    }
  }

  /** Storefront "Coins" / "Coupon" button: an offer id (RO…) or a not-delivered refunded order id (FF…). */
  function chooseRefund(phone, id, method) {
    return offerIdOf(id) ? acceptOffer(phone, id, method) : chooseForOrder(phone, id, method);
  }

  // Email code for "send my refund to this UPI ID". The code goes ONLY to the email on the refunded order itself
  // (a REFUNDED order with RefundMethod UPI_PENDING was PAID: admin can refund only paid orders), or on the order of an
  // open offer. Never the profile email (anyone can change it without a login). Every "no" gets the same REFUND_NO.
  const REFUND_NO = 'We could not confirm this. Use the email you gave on the refunded order. Need help? Tap Help.';
  const VERIFY_MSG = 'For your safety, confirm it\'s you: type the email you used on this order, and we\'ll email you a 6-digit code.';
  const emailOf = (o) => s(o && o.email).replace(/\s+/g, '').toLowerCase();
  function refundEmailMatches(o, match) {
    const r = refundInfo(o); const raw = rawOf(o.raw_json);
    if (up(o.status) !== 'REFUNDED' || r.kind !== 'UPI_PENDING' || !s(raw.RefundedAt)) return false;
    const em = emailOf(o);
    return !!em && em.includes('@') && !!match && match(em);
  }
  function offerEmailMatches(o, ph, match) {
    const em = emailOf(o);
    return !!o && norm(o.phone_norm) === ph && up(o.status) === 'PAID' && !!em && em.includes('@') && !!match && match(em);
  }
  async function refundEligible(ph, match) {
    const rows = await M.db().query("SELECT order_id, email, status, raw_json FROM orders WHERE phone_norm = ? AND UPPER(status) = 'REFUNDED' ORDER BY created_at_sheet DESC LIMIT 20", [ph]);
    if ((rows || []).some((o) => refundInfo(o).state === 'ASK_CUSTOMER' && refundEmailMatches(o, match))) return true;
    let offers = [];
    try { offers = await M.db().query("SELECT r.offer_id, r.expires_at, o.email, o.phone_norm, o.status FROM refund_offers r JOIN orders o ON o.order_id = r.order_id WHERE r.phone_norm = ? AND r.status = 'OFFERED' LIMIT 10", [ph]); }
    catch (e) { if (!missingTable(e)) throw e; }
    return (offers || []).some((x) => !expired(x) && offerEmailMatches(x, ph, match));
  }
  function sendCode(phone, email) {
    return M.otpaccess().sendEmailCode('refund', phone, email, { tool: 'Refund', eligible: refundEligible, noMessage: REFUND_NO, mailer: M.mailer() });
  }
  function verifyCode(phone, email, code) {
    return M.otpaccess().verifyEmailCode('refund', phone, email, code, { eligible: refundEligible, noMessage: REFUND_NO });
  }

  async function addUpiTodo(conn, { oid, ph, o, upi, amount, what }) {
    try {
      const [ins] = await conn.query('INSERT INTO admin_todos (title, note) VALUES (?, ?)', [
        ('💸 Send ₹' + amount + ' UPI refund to ' + upi + ' for ' + oid + ' (' + maskPhone(ph) + ')').slice(0, 300),
        TODO_MARK(oid) + ' ' + (what || 'UPI refund') + ' requested by the customer for ' + s(o.service) + ' ' + s(o.plan) + ' (' + s(o.name) + '). Send ₹' + amount + ' to ' + upi + ' (check the UPI name looks like the customer), then tick this done or use admin → 💸 Refunds → ✅ Done — the order becomes Refunded (UPI) and the customer is told.',
      ]);
      return (ins && ins.insertId) || null;
    } catch (e) { if (!missingTable(e)) throw e; return null; }
  }
  const upiReceived = (amount, upi) => '✅ Request received — we\'ll send ₹' + amount + ' to ' + upi + ' within 24 hours. You\'ll get a message when it\'s done.';

  async function requestUpi(phone, orderId, upiId, token) {
    if (offerIdOf(orderId)) return requestOfferUpi(phone, orderId, upiId, token);
    const ph = norm(phone); const oid = oidOf(orderId); const upi = s(upiId).replace(/\s+/g, '');
    if (ph.length !== 10 || !oid) return { ok: false, message: 'Order not found.' };
    if (!UPI_RE.test(upi)) return { ok: false, field: 'upi', message: 'Enter a UPI ID like name@okhdfcbank.' };
    const match = M.otpaccess().tokenMatcher(token, ph);
    if (!match) return { ok: false, needsVerify: true, message: VERIFY_MSG };
    try {
      const done = await withTx(async (conn) => {
        const o = await lockOrder(conn, oid);
        if (!o || s(o.phone_norm) !== ph) throw new Refused('Order not found.');
        const raw = rawOf(o.raw_json); const r = refundInfo(o);
        if (up(o.status) !== 'REFUNDED' || r.kind !== 'UPI_PENDING') throw new Refused('This refund was already completed.');
        // The device's verified email must be THIS order's email (a token from Get OTP / Games / another order does not count).
        if (!refundEmailMatches(o, match)) throw new Refused(VERIFY_MSG, { needsVerify: true });
        if (r.state === 'UPI_REQUESTED') return { already: true, o, upi: r.upi };
        if (r.state !== 'ASK_CUSTOMER') throw new Refused('This refund was already completed.');
        const at = fmtDt(now());
        const amount = Math.round(r.amount);
        const todoId = await addUpiTodo(conn, { oid, ph, o, upi, amount });
        Object.assign(raw, { RefundState: 'UPI_REQUESTED', RefundUpi: upi, RefundUpiRequestedAt: at, RefundTodoId: todoId });
        await saveRaw(conn, oid, raw);
        return { o, upi, amount, todoId };
      });
      if (done.already) return { ok: true, already: true, orderId: oid, upi: maskUpi(done.upi), message: 'We already have your UPI ID — your refund is on its way.' };
      notify(done.o, 'UPI_REQUESTED', { amount: done.amount, upi: done.upi });
      Promise.resolve().then(() => M.push().sendToAdmins({ title: '💸 UPI refund to send', body: '₹' + done.amount + ' for ' + oid + ' → ' + done.upi, url: '/panel', tag: 'upi-refund-' + oid }, { kind: 'admin' })).catch(() => {});
      return { ok: true, orderId: oid, amount: done.amount, upi: maskUpi(done.upi), todoId: done.todoId, message: upiReceived(done.amount, done.upi) };
    } catch (e) {
      if (e instanceof Refused) return refusedOut(e);
      throw e;
    }
  }

  /** Delivered-plan offer taken as UPI: exact refund, email code to the order's email, then the owner sends it. */
  async function requestOfferUpi(phone, offerId, upiId, token) {
    const ph = norm(phone); const id = offerIdOf(offerId); const upi = s(upiId).replace(/\s+/g, '');
    if (ph.length !== 10 || !id) return { ok: false, message: 'Refund not found.' };
    if (!UPI_RE.test(upi)) return { ok: false, field: 'upi', message: 'Enter a UPI ID like name@okhdfcbank.' };
    const match = M.otpaccess().tokenMatcher(token, ph);
    if (!match) return { ok: false, needsVerify: true, message: VERIFY_MSG };
    try {
      const done = await withTx(async (conn) => {
        const got = await lockOpenOffer(conn, ph, id, (ro) => up(ro.status) === 'UPI_REQUESTED');
        if (got.already) return got;
        const { ro, o } = got;
        if (!offerEmailMatches(o, ph, match)) throw new Refused(VERIFY_MSG, { needsVerify: true });
        const amount = Math.round(asNum(ro.refund_amount));
        if (!(amount > 0)) throw new Refused('Nothing to refund on this offer. Please tap Help.');
        const at = fmtDt(now());
        await guardOffer(conn, "UPDATE refund_offers SET status = 'UPI_REQUESTED', method = 'UPI', upi_id = ?, accepted_at = ? WHERE offer_id = ? AND status = 'OFFERED' LIMIT 1", [upi, at, id]);
        const todoId = await addUpiTodo(conn, { oid: s(o.order_id), ph, o, upi, amount, what: 'Refund offer ' + id + ' (delivered plan) as UPI' });
        const end = await endAccessOn(conn, o, ro, { RefundMethod: 'UPI_PENDING', RefundState: 'UPI_REQUESTED', RefundUpi: upi, RefundUpiRequestedAt: at, RefundTodoId: todoId });
        return { ro, o, upi, amount, todoId, ended: end.ended };
      });
      if (done.already) return { ok: true, already: true, offerId: id, upi: maskUpi(done.ro.upi_id), message: 'We already have your UPI ID — your refund is on its way.' };
      const oid = s(done.o.order_id);
      notify(done.o, 'UPI_REQUESTED', { amount: done.amount, upi: done.upi });
      Promise.resolve().then(() => M.push().sendToAdmins({ title: '💸 UPI refund to send', body: '₹' + done.amount + ' for ' + oid + ' → ' + done.upi, url: '/panel', tag: 'upi-refund-' + oid }, { kind: 'admin' })).catch(() => {});
      return { ok: true, offerId: id, orderId: oid, amount: done.amount, upi: maskUpi(done.upi), todoId: done.todoId, accessEnded: done.ended, message: upiReceived(done.amount, done.upi) };
    } catch (e) {
      if (e instanceof Refused) return refusedOut(e);
      if (missingTable(e)) return { ok: false, message: 'Refunds are being set up. Please try again later or tap Help.' };
      throw e;
    }
  }

  /** The customer saw the one-time "✅ Your refund was sent" pop-up. */
  async function markSentSeen(phone, orderId) {
    const ph = norm(phone); const oid = oidOf(orderId);
    if (ph.length !== 10 || !oid) return { ok: false, message: 'Order not found.' };
    try {
      return await withTx(async (conn) => {
        const o = await lockOrder(conn, oid);
        if (!o || s(o.phone_norm) !== ph) throw new Refused('Order not found.');
        const raw = rawOf(o.raw_json);
        if (up(o.status) !== 'REFUNDED' || !s(raw.RefundUpiSentAt)) throw new Refused('Nothing to confirm.');
        if (s(raw.RefundSentSeenAt)) return { ok: true, already: true };
        raw.RefundSentSeenAt = fmtDt(now());
        await saveRaw(conn, oid, raw);
        return { ok: true };
      });
    } catch (e) {
      if (e instanceof Refused) return refusedOut(e);
      throw e;
    }
  }

  // ------------------------------------------------------------------ admin: the UPI refund was sent
  async function completeUpi({ orderId, reference, via, notify: tell }) {
    const oid = oidOf(orderId);
    if (!oid) return { ok: false, status: 400, message: 'Order id required.' };
    const ref = s(reference).slice(0, 120);
    try {
      const done = await withTx(async (conn) => {
        const o = await lockOrder(conn, oid);
        if (!o) throw new Refused('Order not found.', { status: 404 });
        const raw = rawOf(o.raw_json); const r = refundInfo(o);
        if (up(o.status) !== 'REFUNDED') throw new Refused('This order is not refunded.', { status: 409 });
        if (r.kind === 'UPI' && raw.RefundUpiSentAt) return { already: true, o, r };
        if (r.kind !== 'UPI_PENDING') throw new Refused('This refund was completed another way (' + (r.method || '—') + ') — nothing to send.', { status: 409 });
        const at = fmtDt(now());
        Object.assign(raw, { RefundMethod: 'UPI', RefundState: 'DONE', RefundUpiSentAt: at, RefundRef: ref || s(raw.RefundRef), RefundCompletedVia: s(via) || 'admin' });
        await saveRaw(conn, oid, raw);
        let todoClosed = 0;
        if (raw.RefundTodoId) {
          try { const [u] = await conn.query('UPDATE admin_todos SET done = 1, done_at = NOW() WHERE id = ? AND done = 0 LIMIT 1', [raw.RefundTodoId]); todoClosed = (u && u.affectedRows) || 0; } catch (e) { if (!missingTable(e)) throw e; }
        }
        // A delivered-plan offer paid by UPI: the offer is done too.
        if (s(raw.RefundOfferId)) {
          try { await conn.query("UPDATE refund_offers SET status = 'DONE', paid_at = ?, upi_ref = ? WHERE offer_id = ? AND status = 'UPI_REQUESTED' LIMIT 1", [at, ref || null, s(raw.RefundOfferId)]); } catch (e) { if (!missingTable(e)) throw e; }
        }
        return { o, r, ref: ref || s(raw.RefundRef), upi: s(raw.RefundUpi), todoClosed, offerId: s(raw.RefundOfferId) };
      });
      if (done.already) return { ok: true, already: true, orderId: oid, message: 'Already marked as sent on ' + s(rawOf(done.o.raw_json).RefundUpiSentAt) + '.' };
      if (tell !== false) notify(done.o, 'UPI_SENT', { amount: done.r.amount, upi: done.upi, reference: done.ref });
      return { ok: true, orderId: oid, amount: done.r.amount, upi: done.upi, offerId: done.offerId, todoClosed: done.todoClosed, message: '💸 UPI refund marked as sent (₹' + done.r.amount + (done.upi ? ' to ' + done.upi : '') + ').' };
    } catch (e) {
      if (e instanceof Refused) return refusedOut(e);
      throw e;
    }
  }

  /** Today to-do ticked done: if it is a UPI refund to-do, the refund is complete. */
  async function onTodoDone(todoId) {
    const rows = await M.db().query('SELECT id, title, note FROM admin_todos WHERE id = ? LIMIT 1', [todoId]);
    const t = rows[0];
    const m = t && (s(t.note).match(TODO_MARK_RE) || s(t.title).match(TODO_MARK_RE));
    if (!m) return null;
    return completeUpi({ orderId: m[1], via: 'todo' });
  }

  // ------------------------------------------------------------------ admin: offers on delivered plans
  // isDeliveredSub: delivered.js (no-login plans like YouTube invites and old-site imports count as delivered).
  const endedSub = (x) => ['REFUNDED', 'CANCELLED', 'CANCELED', 'REMOVED', 'ERASED'].includes(up(x.status));

  /** The order + subscriptions an offer is about. q = (sql, params) → rows. */
  async function offerTarget(q, { orderId, subId }) {
    const oid = oidOf(orderId); const sid = s(subId).slice(0, 40);
    let o = null;
    if (oid) o = (await q('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [oid]))[0] || null;
    else if (sid) {
      const sub = (await q('SELECT * FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]))[0];
      if (!sub) throw new Refused('Subscription not found.', { status: 404 });
      // The order that paid for the current period: fulfilment moves subscriptions.order_id to each delivered renewal,
      // so prefer that order; a renewal that failed to deliver never counts here.
      const cands = await q("SELECT * FROM orders WHERE (order_id = ? OR renew_sub_id = ?) AND UPPER(status) IN ('PAID', 'REFUNDED') ORDER BY created_at_sheet DESC LIMIT 5", [s(sub.order_id), s(sub.sub_id)]);
      o = (cands || []).find((x) => s(x.order_id) === s(sub.order_id)) || (cands || []).find((x) => up(x.fulfillment_status) === 'FULFILLED') || null;
    } else throw new Refused('Order or subscription id required.', { status: 400 });
    if (!o) throw new Refused(sid && !oid
      ? 'This plan was bought on the old site — no paid order in the new system. Use Extend, or refund outside FluxFilm.'
      : 'No paid order found for this.', { status: 404, noPaidOrder: true });
    const renew = up(o.order_type) === 'RENEW' && s(o.renew_sub_id);
    let subs = await q('SELECT * FROM subscriptions WHERE ' + (renew ? 'sub_id = ?' : 'order_id = ?'), [renew ? s(o.renew_sub_id) : s(o.order_id)]);
    // Separate logins of one purchase (F1): every device row ends together.
    const gid = (subs || []).map((x) => s(x.group_id)).find(Boolean);
    if (gid) {
      const g = await q('SELECT * FROM subscriptions WHERE group_id = ?', [gid]);
      const seen = new Set((subs || []).map((x) => s(x.sub_id)));
      subs = (subs || []).concat((g || []).filter((x) => !seen.has(s(x.sub_id))));
    }
    subs = (subs || []).filter((x) => norm(x.phone_norm) === norm(o.phone_norm));
    return { o, subs };
  }

  function offerProblem(o, subs) {
    const st = up(o.status);
    if (st === 'REFUNDED') return 'This order was already refunded.';
    if (st !== 'PAID') return 'Only paid orders can be refunded.';
    if (norm(o.phone_norm).length !== 10) return 'This order has no phone number — the customer could not choose. Refund it outside FluxFilm.';
    if (!subs.some(isDeliveredSub)) return 'This order was not delivered — use 💸 Refund instead.';
    if (subs.every(endedSub)) return 'This plan already ended (refunded / cancelled).';
    return '';
  }

  async function expireOld(q) {
    try { await q("UPDATE refund_offers SET status = 'EXPIRED', live_order = NULL WHERE status = 'OFFERED' AND expires_at <= ?", [fmtDt(now())]); }
    catch (e) { if (!missingTable(e)) throw e; }
  }

  /** Admin preview: paid, the paid period, days used, suggested charge, and any open offer. */
  async function quoteOffer({ orderId, subId }) {
    const q = (sql, p) => M.db().query(sql, p);
    try {
      const { o, subs } = await offerTarget(q, { orderId, subId });
      const cfg = await getSettings();
      const periodEnd = subs.map((x) => s(x.expiry_date)).filter(Boolean).sort().pop() || '';
      const totalDays = asNum(o.duration_days) || asNum((subs[0] || {}).duration_days) || 30;
      const sc = suggestCharge({ paid: o.final_amount, totalDays, periodEnd, now: now() });
      let ready = true; let open = null;
      try {
        await expireOld(q);
        const rows = await q("SELECT * FROM refund_offers WHERE order_id = ? ORDER BY created_at DESC LIMIT 5", [s(o.order_id)]);
        const live = (rows || []).find((x) => ['OFFERED', 'UPI_REQUESTED', 'DONE'].includes(up(x.status)));
        if (live) open = adminOfferView(live);
      } catch (e) { if (missingTable(e)) ready = false; else throw e; }
      const problem = offerProblem(o, subs);
      return {
        ok: true, ready, orderId: s(o.order_id), subIds: subs.map((x) => s(x.sub_id)), service: s(o.service), plan: s(o.plan), name: s(o.name), phone: norm(o.phone_norm), email: s(o.email),
        paid: sc.paid, totalDays: sc.totalDays, daysUsed: sc.daysUsed, suggestedCharge: sc.suggested, periodStart: sc.periodStart, periodEnd: sc.periodEnd,
        bonusPercent: cfg.bonusPercent, offerDays: cfg.offerDays, allowed: !problem && ready && !open, reason: problem || (!ready ? 'Run db/schema-v26.sql in phpMyAdmin first.' : open ? 'This order already has a refund offer (' + open.offerId + ', ' + open.status + ').' : ''), offer: open,
      };
    } catch (e) {
      if (e instanceof Refused) return Object.assign({ ok: false, status: e.extra.status || 409, message: e.message }, e.extra);
      throw e;
    }
  }

  async function newOfferId(conn) {
    for (let i = 0; i < 8; i++) {
      let c = 'RO'; for (let j = 0; j < 8; j++) c += COUPON_CHARS[crypto.randomInt(0, COUPON_CHARS.length)];
      if (!(await rowsOf(conn, 'SELECT offer_id FROM refund_offers WHERE offer_id = ? LIMIT 1', [c])).length) return c;
    }
    throw new Error('Could not pick a free offer id — try again.');
  }

  /**
   * Admin → 💸 Offer refund. input: { orderId | subId, reason NO_REPLACEMENT|MID_PERIOD, charge (₹, MID_PERIOD), note, notify }
   * The paid amount comes from the order; the charge is clamped to 0…paid; the refund must be at least ₹1.
   */
  async function createOffer(input) {
    const b = input || {};
    const reason = up(b.reason);
    if (!REASONS[reason]) return { ok: false, status: 400, field: 'reason', message: 'Choose the reason: No replacement available, or Mid-period refund.' };
    const note = s(b.note).replace(/\s+/g, ' ').slice(0, 300);
    const chargeIn = b.charge === '' || b.charge == null ? null : Number(b.charge);
    if (reason === 'MID_PERIOD' && chargeIn != null && (!Number.isFinite(chargeIn) || chargeIn < 0)) return { ok: false, status: 400, field: 'charge', message: 'The usage charge must be ₹0 or more.' };
    const cfg = await getSettings();
    try {
      const done = await withTx(async (conn) => {
        const q = (sql, p) => rowsOf(conn, sql, p);
        await expireOld(async (sql, p) => { await conn.query(sql, p); });
        const { o, subs } = await offerTarget(q, { orderId: b.orderId, subId: b.subId });
        const locked = (await rowsOf(conn, 'SELECT order_id, status FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [s(o.order_id)]))[0];
        if (!locked) throw new Refused('Order not found.', { status: 404 });
        o.status = locked.status;
        const problem = offerProblem(o, subs);
        if (problem) throw new Refused(problem, { status: 409 });
        const periodEnd = subs.map((x) => s(x.expiry_date)).filter(Boolean).sort().pop() || '';
        const sc = suggestCharge({ paid: o.final_amount, totalDays: asNum(o.duration_days) || asNum((subs[0] || {}).duration_days) || 30, periodEnd, now: now() });
        const a = offerAmounts(o.final_amount, reason, chargeIn == null ? sc.suggested : chargeIn);
        if (!(a.refund >= 1)) throw new Refused('With a usage charge of ₹' + a.charge + ' there is nothing left to refund (paid ₹' + a.paid + ').', { status: 400, field: 'charge' });
        const id = await newOfferId(conn);
        const created = now(); const exp = new Date(created.getTime() + cfg.offerDays * DAY);
        const endIds = subs.filter((x) => !endedSub(x)).map((x) => s(x.sub_id)).join(',').slice(0, 400);
        try {
          await conn.query(
            'INSERT INTO refund_offers (offer_id, order_id, live_order, sub_ids, phone_norm, service, plan, reason, paid_amount, charge_amount, suggested_charge, refund_amount, days_used, total_days, bonus_percent, note, status, expires_at, created_at)' +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?, ?)",
            [id, s(o.order_id), s(o.order_id), endIds, norm(o.phone_norm), s(o.service), s(o.plan), reason, a.paid, a.charge, sc.suggested, a.refund, sc.daysUsed, sc.totalDays, cfg.bonusPercent, note || null, fmtDt(exp), fmtDt(created)]);
        } catch (e) {
          if (e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(e.message))) throw new Refused('This order already has a refund offer — cancel it first.', { status: 409 });
          throw e;
        }
        // The customer's open "Request refund" for this order is answered by this offer (refundrequests.js).
        try { await conn.query("UPDATE refund_requests SET status = 'OFFERED', open_key = NULL, offer_id = ?, decided_at = ? WHERE order_id = ? AND status = 'OPEN'", [id, fmtDt(created), s(o.order_id)]); }
        catch (e) { if (!missingTable(e)) throw e; }
        return { id, o, a, sc, reason, note, expiresAt: fmtDt(exp), subIds: endIds };
      });
      const offer = { offerId: done.id, orderId: s(done.o.order_id), subIds: done.subIds, reason: done.reason, paid: done.a.paid, charge: done.a.charge, suggestedCharge: done.sc.suggested, refund: done.a.refund, daysUsed: done.sc.daysUsed, totalDays: done.sc.totalDays, bonusPercent: cfg.bonusPercent, credit: bonusCredit(done.a.refund, cfg.bonusPercent), note: done.note, expiresAt: done.expiresAt };
      let mail = null;
      if (b.notify !== false) {
        mail = notify(done.o, 'OFFER', { amount: done.a.refund, paid: done.a.paid, charge: done.a.charge, reason: done.reason, note: done.note, daysUsed: done.sc.daysUsed, totalDays: done.sc.totalDays, credit: offer.credit, bonusPercent: cfg.bonusPercent, expiresAt: done.expiresAt });
        if (mail) mail.then((r) => { if (r && r.ok) return M.db().query('UPDATE refund_offers SET email_sent = 1 WHERE offer_id = ? LIMIT 1', [done.id]); return null; }).catch(() => {});
      }
      return { ok: true, offer, emailed: b.notify !== false && s(done.o.email).includes('@'), o: done.o, message: '💸 Refund of ₹' + done.a.refund + ' offered. ' + (b.notify !== false ? 'The customer was emailed and will see it in the app.' : 'No email sent — the customer will see it in the app.') };
    } catch (e) {
      if (e instanceof Refused) return Object.assign({ ok: false, status: e.extra.status || 409, message: e.message }, e.extra);
      if (missingTable(e)) return { ok: false, status: 409, needsSchema: true, message: 'Run db/schema-v26.sql in phpMyAdmin first.' };
      throw e;
    }
  }

  /** Admin cancels an offer the customer has not taken yet. */
  async function cancelOffer({ offerId, reason }) {
    const id = offerIdOf(offerId);
    if (!id) return { ok: false, status: 400, message: 'Offer id required.' };
    try {
      return await withTx(async (conn) => {
        const ro = await lockOffer(conn, id);
        if (!ro) throw new Refused('Offer not found.', { status: 404 });
        if (up(ro.status) === 'CANCELLED') return { ok: true, already: true, offerId: id, message: 'Already cancelled.' };
        if (up(ro.status) !== 'OFFERED') throw new Refused('The customer already chose (' + up(ro.status) + ') — it can no longer be cancelled.', { status: 409 });
        const [u] = await conn.query("UPDATE refund_offers SET status = 'CANCELLED', live_order = NULL, cancelled_at = ?, cancel_reason = ? WHERE offer_id = ? AND status = 'OFFERED' LIMIT 1", [fmtDt(now()), s(reason).slice(0, 200) || null, id]);
        if (!u || u.affectedRows !== 1) throw new Refused('The customer just chose — it can no longer be cancelled.', { status: 409 });
        return { ok: true, offerId: id, orderId: s(ro.order_id), amount: Math.round(asNum(ro.refund_amount)), message: '🚫 Refund offer ' + id + ' cancelled.' };
      });
    } catch (e) {
      if (e instanceof Refused) return Object.assign({ ok: false, status: e.extra.status || 409, message: e.message }, e.extra);
      if (missingTable(e)) return { ok: false, status: 409, needsSchema: true, message: 'Run db/schema-v26.sql in phpMyAdmin first.' };
      throw e;
    }
  }

  function adminOfferView(ro) {
    const st = up(ro.status) === 'OFFERED' && expired(ro) ? 'EXPIRED' : up(ro.status);
    return {
      offerId: s(ro.offer_id), orderId: s(ro.order_id), subIds: s(ro.sub_ids), phone: norm(ro.phone_norm), service: s(ro.service), plan: s(ro.plan), reason: up(ro.reason), reasonLabel: REASONS[up(ro.reason)] || NOW_REASONS[up(ro.reason)] || '',
      byAdmin: NOW_ID_RE.test(s(ro.offer_id)),
      paid: asNum(ro.paid_amount), charge: asNum(ro.charge_amount), suggestedCharge: ro.suggested_charge == null ? null : asNum(ro.suggested_charge), refund: asNum(ro.refund_amount),
      daysUsed: ro.days_used == null ? null : Number(ro.days_used), totalDays: ro.total_days == null ? null : Number(ro.total_days), bonusPercent: asNum(ro.bonus_percent), note: s(ro.note),
      status: st, method: up(ro.method), credit: ro.credit_amount == null ? null : Number(ro.credit_amount), coupon: s(ro.coupon_code), upi: s(ro.upi_id), reference: s(ro.upi_ref),
      emailSent: Number(ro.email_sent) === 1, createdAt: s(ro.created_at), expiresAt: s(ro.expires_at), acceptedAt: s(ro.accepted_at), paidAt: s(ro.paid_at), cancelledAt: s(ro.cancelled_at), cancelReason: s(ro.cancel_reason),
    };
  }

  /** Admin → 💸 Refunds: UPI refunds to send, refunds the customer is still choosing, recent offers, settings. */
  async function adminOverview() {
    const q = (sql, p) => M.db().query(sql, p);
    const cfg = await getSettings(true);
    const rows = await q("SELECT o.order_id, o.name, o.phone_norm, o.email, o.service, o.plan, o.final_amount, o.raw_json, o.created_at_sheet FROM orders o WHERE UPPER(o.status) = 'REFUNDED' AND JSON_UNQUOTE(JSON_EXTRACT(o.raw_json, '$.RefundMethod')) = 'UPI_PENDING' ORDER BY o.created_at_sheet DESC LIMIT 100", []);
    const toSend = []; const choosing = [];
    for (const o of rows || []) {
      const r = refundInfo(o); const raw = rawOf(o.raw_json);
      const row = { orderId: s(o.order_id), name: s(o.name), phone: norm(o.phone_norm), email: s(o.email), service: s(o.service), plan: s(o.plan), amount: r.amount, upi: r.upi, state: r.state, requestedAt: s(raw.RefundUpiRequestedAt), refundedAt: r.at, delivered: r.delivered, offerId: r.offerId, charge: r.charge, paid: r.paid, byAdmin: r.byAdmin };
      if (r.state === 'UPI_REQUESTED') toSend.push(row); else if (r.state === 'ASK_CUSTOMER') choosing.push(Object.assign(row, { kind: 'order' }));
    }
    toSend.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    let ready = true; let offers = [];
    try {
      await expireOld(q);
      offers = ((await q('SELECT * FROM refund_offers ORDER BY created_at DESC LIMIT 100', [])) || []).map(adminOfferView);
    } catch (e) { if (missingTable(e)) ready = false; else throw e; }
    const names = {};
    if (offers.length) {
      try {
        const phones = [...new Set(offers.map((x) => x.phone).filter(Boolean))].slice(0, 100);
        if (phones.length) for (const c of (await q('SELECT phone_norm, name FROM customers WHERE phone_norm IN (' + phones.map(() => '?').join(',') + ')', phones)) || []) names[norm(c.phone_norm)] = s(c.name);
      } catch (_) { /* names are only a nicety */ }
      offers.forEach((x) => { x.name = names[x.phone] || ''; });
    }
    for (const x of offers) if (x.status === 'OFFERED') choosing.push(Object.assign({ kind: 'offer', orderId: x.orderId, name: x.name, phone: x.phone, service: x.service, plan: x.plan, amount: x.refund, delivered: true }, { offerId: x.offerId, charge: x.charge, paid: x.paid, expiresAt: x.expiresAt }));
    return { ok: true, ready, settings: cfg, toSend, choosing, offers };
  }

  return {
    getSettings, saveSettings, getPendingRefunds, chooseRefund, chooseForOrder, convertToCredit, acceptOffer, sendCode, verifyCode, requestUpi, requestOfferUpi, markSentSeen,
    completeUpi, onTodoDone, createRefundCouponOn, notify, quoteOffer, createOffer, cancelOffer, adminOverview, offerTarget,
    // ⚡ Refund now (adminrefundnow.js) reuses the offer-accept access ending and the UPI to-do.
    endAccessOn, addUpiTodo,
  };
}

const defaultInstance = create();
module.exports = Object.assign({ create, refundInfo, BONUS_PERCENT, OFFER_DAYS, COUPON_DAYS, UPI_RE, OFFER_RE, REASONS, NOW_REASONS, NOW_ID_RE, bonusCredit, maskUpi, suggestCharge, offerAmounts, validateSettings, TODO_MARK_RE, Refused }, defaultInstance);
