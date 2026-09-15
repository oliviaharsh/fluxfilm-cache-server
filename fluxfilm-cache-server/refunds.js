/**
 * FluxFilm - customer-friendly refunds (owner request 2026-09-15). Used by the admin Refund dialog
 * (adminorderactions.js), the storefront (server.js actions) and the Today to-dos (adminhome.js).
 *
 * How the owner can refund a paid-but-undelivered order:
 *   COINS   → 💸 refund credit (₹1 = 1, coins.js pot), can pay 100% of a new order or renewal. Order REFUNDED.
 *   COUPON  → personal single-use coupon RFxxxxxx worth the amount (180 days, this phone only). Order REFUNDED.
 *   UPI_ASK → order REFUNDED with RefundMethod UPI_PENDING / RefundState ASK_CUSTOMER. The customer's home screen asks:
 *             "take ₹X + 10% as refund credit" (convertToCredit) or "send it to my UPI" (requestUpi → Today to-do,
 *             RefundState UPI_REQUESTED). The owner sends the money and ticks the to-do (or ⚡ Actions → Mark UPI
 *             refund sent) → RefundMethod UPI, RefundState DONE (completeUpi).
 *   UPI / OTHER → already refunded outside FluxFilm, just recorded (PR #77 behaviour).
 * The order status stays REFUNDED in every case (so checkout, fulfilment, mark-paid and Today's "paid but not
 * delivered" all keep treating it as refunded); what is still open lives in raw_json.RefundState.
 *
 * Safety: every change locks the order row (SELECT … FOR UPDATE) inside one transaction, checks the phone owns the
 * order and that the refund is still in the expected state, so double taps / two devices / admin + customer at the
 * same moment can never credit twice or credit AND pay out. Sending a refund to a UPI ID needs the same email code
 * as Get OTP (otpaccess.js): a phone number alone must never redirect money.
 */
const crypto = require('crypto');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return Object.assign({}, v); try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }
const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const maskPhone = (ph) => { const p = norm(ph); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

const BONUS_PERCENT = 10;                 // "convert your cash refund to coins" bonus (owner: 10% extra)
const COUPON_DAYS = 180;
const COUPON_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// name@handle: letters, digits, dot, dash, underscore before @; a letters-first handle after it (e.g. okhdfcbank, ybl).
const UPI_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}@[a-zA-Z][a-zA-Z0-9]{1,49}$/;
const TODO_MARK = (id) => '[upi-refund:' + id + ']';
const TODO_MARK_RE = /\[upi-refund:(FF\d{1,14})\]/;
const bonusCredit = (amount) => { const a = Math.round(asNum(amount)); return a + Math.round(a * BONUS_PERCENT / 100); };
const maskUpi = (u) => { const [n, h] = s(u).split('@'); if (!h) return ''; return (n.length <= 3 ? n[0] + '•••' : n.slice(0, 3) + '•'.repeat(Math.min(5, n.length - 3))) + '@' + h; };

class Refused extends Error { constructor(message, extra) { super(message); this.extra = extra || {}; } }

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
  const oidOf = (v) => { const id = up(v); return /^FF\d{1,14}$/.test(id) ? id : ''; };

  // ------------------------------------------------------------------ notifications (never block, never throw)
  function notify(o, kind, d) {
    d = d || {};
    const amt = '₹' + asNum(d.amount);
    const svc = s(o.service);
    const T = {
      CREDIT: ['💸 ' + amt + ' refund credit added', 'Your ' + svc + ' order ' + o.order_id + ' was refunded as ' + asNum(d.credit) + ' coins of refund credit. Use it on any plan — it can pay the full price.'],
      COUPON: ['🎟️ Your ' + amt + ' refund coupon', 'Your ' + svc + ' order ' + o.order_id + ' was refunded as coupon ' + s(d.coupon) + ' (' + amt + ' off any plan). Find it in Account → Coupons.'],
      ASK: ['💸 Your ' + svc + ' order was refunded', 'Open FluxFilm to choose: ' + asNum(d.credit) + ' coins of refund credit (10% extra) or ' + amt + ' to your UPI.'],
      CONVERTED: ['💸 ' + asNum(d.credit) + ' coins of refund credit added', 'Thanks! Your refund for ' + o.order_id + ' is now ' + asNum(d.credit) + ' coins of refund credit (incl. ' + asNum(d.bonus) + ' extra). Use it on any plan.'],
      UPI_REQUESTED: ['💸 UPI refund requested', 'We\'ll send ' + amt + ' for order ' + o.order_id + ' to ' + maskUpi(d.upi) + ' soon.'],
      UPI_SENT: ['💸 ' + amt + ' refunded to your UPI', 'Your refund for order ' + o.order_id + ' was sent to ' + (d.upi ? maskUpi(d.upi) : 'your UPI') + (d.reference ? ' (ref ' + s(d.reference) + ')' : '') + '.'],
      RECORDED: ['💸 Refund for your ' + svc + ' order', 'We refunded ' + amt + (d.how ? ' ' + d.how : '') + ' for order ' + o.order_id + '. Sorry we could not deliver it.'],
    }[kind];
    if (!T) return;
    const [title, body] = T;
    const tag = 'refund-' + s(o.order_id).replace(/[^\w-]/g, '');
    Promise.resolve().then(() => M.push().sendToPhone(o.phone_norm, { title, body, url: '/?source=push', tag }, { kind: 'refund' })).catch(() => {});
    if (!s(o.email).includes('@')) return;
    const extra = kind === 'ASK'
      ? '<p style="color:#475569;font-size:14px">Open <b>FluxFilm</b> and sign in with your phone number — you\'ll see two choices:<br>🪙 <b>' + esc(d.credit) + ' coins of refund credit</b> (that\'s 10% extra, and it can pay the full price of any plan), or<br>🏦 <b>' + esc(amt) + ' back to your UPI ID</b>.</p>'
      : kind === 'UPI_REQUESTED'
        ? '<p style="color:#475569;font-size:14px">You asked us to send your refund to <b>' + esc(maskUpi(d.upi)) + '</b>. We\'ll send it soon. <b>Didn\'t ask for this?</b> Reply to this email straight away.</p>'
        : kind === 'COUPON'
          ? '<p style="color:#475569;font-size:14px">Coupon <b style="font-size:18px;letter-spacing:1px">' + esc(d.coupon) + '</b> — ' + esc(amt) + ' off any plan, only for your number, valid until ' + esc(s(d.expiry).slice(0, 10)) + '. It\'s also in Account → Coupons. If the plan costs less than the coupon, the rest of it is not kept.</p>'
          : '';
    const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto"><h2 style="color:#0f766e;margin-bottom:4px">' + esc(title) + '</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + esc(o.name || 'there') + ',</p>' +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px"><b>' + esc(o.service) + '</b> — ' + esc(o.plan) + '<br>Order ID: ' + esc(o.order_id) + '<br>' + esc(body) + '</div>' + extra +
      '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';
    Promise.resolve().then(() => M.mailer().send(o.email, title + ' — FluxFilm order ' + o.order_id, html)).catch(() => {});
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

  // ------------------------------------------------------------------ storefront
  /** Refunds waiting for the customer (home screen pop-up): cash refund to choose, or UPI refund on its way. */
  async function getPendingRefunds(phone) {
    const ph = norm(phone);
    if (ph.length !== 10) return { ok: false, message: 'Phone required.' };
    const rows = await M.db().query("SELECT order_id, service, plan, final_amount, status, raw_json FROM orders WHERE phone_norm = ? AND UPPER(status) = 'REFUNDED' ORDER BY created_at_sheet DESC LIMIT 20", [ph]);
    const items = [];
    for (const o of rows) {
      const r = refundInfo(o);
      if (r.kind !== 'UPI_PENDING' || !['ASK_CUSTOMER', 'UPI_REQUESTED'].includes(r.state)) continue;
      items.push({ orderId: s(o.order_id), service: s(o.service), plan: s(o.plan), amount: r.amount, state: r.state, bonusPercent: BONUS_PERCENT, credit: bonusCredit(r.amount), upi: r.upi ? maskUpi(r.upi) : '' });
    }
    return { ok: true, items };
  }

  async function convertToCredit(phone, orderId) {
    const ph = norm(phone); const oid = oidOf(orderId);
    if (ph.length !== 10 || !oid) return { ok: false, message: 'Order not found.' };
    try {
      const done = await withTx(async (conn) => {
        const o = await lockOrder(conn, oid);
        if (!o || s(o.phone_norm) !== ph) throw new Refused('Order not found.');
        const raw = rawOf(o.raw_json); const r = refundInfo(o);
        if (up(o.status) !== 'REFUNDED') throw new Refused('This order is not refunded.');
        if (r.kind === 'CREDIT' && raw.RefundConvertedAt) return { already: true, o, credit: r.credit };
        if (r.kind !== 'UPI_PENDING') throw new Refused('This refund was already completed.');
        if (r.state !== 'ASK_CUSTOMER') throw new Refused('You already asked for a UPI refund — it is on its way.', { state: r.state });
        const credit = bonusCredit(r.amount); const bonus = credit - Math.round(r.amount);
        const c = await M.coins().addRefundCreditOn(conn, { orderId: oid, phone: ph, credit, service: o.service, plan: o.plan, amount: r.amount, note: 'Cash refund for ' + oid + ' taken as refund credit (+' + BONUS_PERCENT + '%)' });
        if (!c.ok) throw new Error('Refund credit could not be added.');
        if (c.already) throw new Refused('This refund was already added as credit.');
        Object.assign(raw, { RefundMethod: 'Coins', RefundState: 'DONE', RefundCredit: credit, RefundCoins: credit, RefundBonus: bonus, RefundConvertedAt: fmtDt(now()) });
        await saveRaw(conn, oid, raw);
        return { o, credit, bonus, amount: r.amount, creditAfter: c.creditAfter };
      });
      if (done.already) return { ok: true, already: true, orderId: oid, credit: done.credit, message: '✅ Already added as refund credit.' };
      notify(done.o, 'CONVERTED', { amount: done.amount, credit: done.credit, bonus: done.bonus });
      return { ok: true, orderId: oid, credit: done.credit, bonus: done.bonus, creditBalance: done.creditAfter, message: '🪙 ' + done.credit + ' coins of refund credit added — use them on any plan.' };
    } catch (e) {
      if (e instanceof Refused) return Object.assign({ ok: false, message: e.message }, e.extra);
      throw e;
    }
  }

  // Email code for "send my refund to this UPI ID" (same code + device token as Get OTP / Games).
  async function hasOpenUpiRefund(ph) { return (await getPendingRefunds(ph)).items.some((x) => x.state === 'ASK_CUSTOMER'); }
  async function refundEmailFor(ph) {
    const c = await M.db().query("SELECT email FROM customers WHERE phone_norm = ? AND email IS NOT NULL AND email <> '' LIMIT 1", [ph]);
    if (c.length && s(c[0].email).includes('@')) return s(c[0].email);
    const o = await M.db().query("SELECT email FROM orders WHERE phone_norm = ? AND UPPER(status) = 'REFUNDED' AND email IS NOT NULL AND email <> '' ORDER BY created_at_sheet DESC LIMIT 1", [ph]);
    return o.length && s(o[0].email).includes('@') ? s(o[0].email) : '';
  }
  async function sendCode(phone) {
    return M.otpaccess().sendCode(phone, { tool: 'Refund', eligible: hasOpenUpiRefund, emailFor: refundEmailFor, notEligibleMessage: 'There is no refund waiting for a UPI ID on this number.' });
  }

  async function requestUpi(phone, orderId, upiId, token) {
    const ph = norm(phone); const oid = oidOf(orderId); const upi = s(upiId).replace(/\s+/g, '');
    if (ph.length !== 10 || !oid) return { ok: false, message: 'Order not found.' };
    if (!UPI_RE.test(upi)) return { ok: false, field: 'upi', message: 'Enter a UPI ID like name@okhdfcbank.' };
    if (!M.otpaccess().verifyToken(token, ph)) {
      const email = await refundEmailFor(ph).catch(() => '');
      const maskedEmail = email ? M.otpaccess()._internal.maskEmail(email) : '';
      return { ok: false, needsVerify: true, hasEmail: !!email, maskedEmail, message: email ? 'For your safety, confirm it\'s you: we\'ll email a 6-digit code to ' + maskedEmail + '.' : 'We don\'t have an email for this number. Please message us on WhatsApp for your refund.' };
    }
    try {
      const done = await withTx(async (conn) => {
        const o = await lockOrder(conn, oid);
        if (!o || s(o.phone_norm) !== ph) throw new Refused('Order not found.');
        const raw = rawOf(o.raw_json); const r = refundInfo(o);
        if (up(o.status) !== 'REFUNDED' || r.kind !== 'UPI_PENDING') throw new Refused('This refund was already completed.');
        if (r.state === 'UPI_REQUESTED') return { already: true, o, upi: r.upi };
        if (r.state !== 'ASK_CUSTOMER') throw new Refused('This refund was already completed.');
        const at = fmtDt(now());
        const amount = Math.round(r.amount);
        let todoId = null;
        try {
          const [ins] = await conn.query('INSERT INTO admin_todos (title, note) VALUES (?, ?)', [
            ('💸 Send ₹' + amount + ' UPI refund to ' + upi + ' for ' + oid + ' (' + maskPhone(ph) + ')').slice(0, 300),
            TODO_MARK(oid) + ' UPI refund requested by the customer for ' + s(o.service) + ' ' + s(o.plan) + ' (' + s(o.name) + '). Send ₹' + amount + ' to ' + upi + ' (check the UPI name looks like the customer), then tick this done — the order becomes Refunded (UPI) and the customer is told. To add the UTR: admin → Orders → ' + oid + ' → ⚡ Actions → Mark UPI refund sent.',
          ]);
          todoId = (ins && ins.insertId) || null;
        } catch (e) { if (!missingTable(e)) throw e; }
        Object.assign(raw, { RefundState: 'UPI_REQUESTED', RefundUpi: upi, RefundUpiRequestedAt: at, RefundTodoId: todoId });
        await saveRaw(conn, oid, raw);
        return { o, upi, amount, todoId };
      });
      if (done.already) return { ok: true, already: true, orderId: oid, upi: maskUpi(done.upi), message: 'We already have your UPI ID — your refund is on its way.' };
      notify(done.o, 'UPI_REQUESTED', { amount: done.amount, upi: done.upi });
      Promise.resolve().then(() => M.push().sendToAdmins({ title: '💸 UPI refund to send', body: '₹' + done.amount + ' for ' + oid + ' → ' + done.upi, url: '/panel', tag: 'upi-refund-' + oid }, { kind: 'admin' })).catch(() => {});
      return { ok: true, orderId: oid, upi: maskUpi(done.upi), todoId: done.todoId, message: '✅ Thanks! We\'ll send ₹' + done.amount + ' to ' + maskUpi(done.upi) + ' soon.' };
    } catch (e) {
      if (e instanceof Refused) return Object.assign({ ok: false, message: e.message }, e.extra);
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
        return { o, r, ref, upi: s(raw.RefundUpi), todoClosed };
      });
      if (done.already) return { ok: true, already: true, orderId: oid, message: 'Already marked as sent on ' + s(rawOf(done.o.raw_json).RefundUpiSentAt) + '.' };
      if (tell !== false) notify(done.o, 'UPI_SENT', { amount: done.r.amount, upi: done.upi, reference: done.ref });
      return { ok: true, orderId: oid, amount: done.r.amount, upi: done.upi, todoClosed: done.todoClosed, message: '💸 UPI refund marked as sent (₹' + done.r.amount + (done.upi ? ' to ' + done.upi : '') + ').' };
    } catch (e) {
      if (e instanceof Refused) return Object.assign({ ok: false, message: e.message }, e.extra);
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

  return { getPendingRefunds, convertToCredit, sendCode, requestUpi, completeUpi, onTodoDone, createRefundCouponOn, notify };
}

const defaultInstance = create();
module.exports = Object.assign({ create, refundInfo, BONUS_PERCENT, UPI_RE, bonusCredit, maskUpi, TODO_MARK_RE, Refused }, defaultInstance);
