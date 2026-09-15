/**
 * FluxFilm - customer "💸 Request refund" (Refunds v3, owner addition 15 Sep 2026). Storefront Account → Request refund,
 * admin 💸 Refunds → 📨 Refund requests (adminrefunds.js). Rows in refund_requests (db/schema-v26.sql).
 *
 * Step 1  listItems(phone): the customer's delivered subscriptions + paid orders, each with whether a refund can be
 *         requested now and why not (all worked out here, India time, never trusting the browser):
 *   - delivered + active plan → DELIVERED request (mid-period): an ESTIMATED usage charge (same days-used formula as the
 *     admin suggestion, refunds.js suggestCharge) — the team decides and sends a refund offer.
 *   - paid, NOT delivered (manual plan still pending, or failed allocation / no stock / never delivered): only after
 *     48 HOURS FROM PAYMENT (orders.verified_at, else created_at_sheet). Before that: "wait until DD MMM, HH:MM".
 *     After: UNDELIVERED request = full refund, no charge; admin taps "Approve → offer full refund".
 *   - refunded / cancelled / ended plans, and items with an open request or a live refund offer: shown disabled.
 * Step 2  createRequest(phone, { orderId | subId, reason, text }): re-checks everything, one OPEN request per order
 *         (unique open_key), at most 5 requests a day per phone. Nothing is refunded by a request.
 * Admin   list() · reject({ requestId, message }) emails the customer · markOffered / markApproved (adminrefunds.js).
 */
const crypto = require('crypto');
const refundsMod = require('./refunds');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "16 Sep, 14:05" in the process time zone (server.js pins Asia/Kolkata). */
const whenLabel = (d) => d.getDate() + ' ' + MON[d.getMonth()] + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

const WAIT_HOURS = 48;
const PER_DAY = 5;
const REASONS = { NOT_WORKING: 'Not working', NOT_RECEIVED: 'Didn’t receive', NOT_NEEDED: 'Don’t need anymore', QUALITY: 'Quality changed', OTHER: 'Other' };
const REQ_RE = /^RQ[A-Z0-9]{8}$/;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const isDeliveredSub = (x) => up(x.fulfillment_status) === 'FULFILLED' || !!s(x.login_id);
const ENDED = ['REFUNDED', 'CANCELLED', 'CANCELED', 'REMOVED', 'ERASED'];
const paidAtOf = (o) => s(o.verified_at) || s(o.created_at_sheet);

/**
 * Pure: what the customer can request. input { subs, orders, requests, offers, now: Date }.
 * Returns items [{ key, type 'sub'|'order', orderId, subId, service, plan, date, amount, statusLabel, kind, state,
 *   canRequest, disabledReason, waitUntil, waitUntilLabel, waitMessage, estimate, request }].
 */
function buildItems(input) {
  const inp = input || {};
  const now = inp.now instanceof Date ? inp.now : new Date(inp.now == null ? Date.now() : inp.now);
  const orders = inp.orders || []; const subs = inp.subs || [];
  const byOrder = new Map(orders.map((o) => [s(o.order_id), o]));
  const openReq = new Map(); const lastReq = new Map();
  for (const r of inp.requests || []) {
    const k = s(r.order_id);
    if (up(r.status) === 'OPEN') openReq.set(k, r);
    if (!lastReq.has(k)) lastReq.set(k, r);
  }
  const liveOffer = new Set((inp.offers || []).filter((x) => ['OFFERED', 'UPI_REQUESTED'].includes(up(x.status))).map((x) => s(x.order_id)));
  const reqView = (r) => (r ? { requestId: s(r.request_id), status: up(r.status), reason: up(r.reason), adminMessage: s(r.admin_message), createdAt: s(r.created_at), offerId: s(r.offer_id) } : null);
  const blockFor = (orderId) => {
    if (liveOffer.has(orderId)) return 'Refund offered — choose how you want it from the banner.';
    if (openReq.has(orderId)) return 'Refund already requested — we’ll update you.';
    return '';
  };
  const items = [];
  // Subscriptions (a purchase with separate logins is one item).
  const seenGroup = new Set();
  for (const x of subs) {
    const gid = s(x.group_id);
    if (gid) { if (seenGroup.has(gid)) continue; seenGroup.add(gid); }
    if (!isDeliveredSub(x)) continue; // manual placeholder: listed as its order below
    // The order that paid for the current period: fulfilment moves subscriptions.order_id to each delivered renewal.
    const o = byOrder.get(s(x.order_id)) || null;
    const st = up(x.status); const exp = toDate(x.expiry_date);
    const item = { key: 'sub:' + s(x.sub_id), type: 'sub', orderId: o ? s(o.order_id) : s(x.order_id), subId: s(x.sub_id), service: s(x.service), plan: s(x.plan), date: s(x.start_date) || (o ? paidAtOf(o) : ''), expiry: s(x.expiry_date), amount: o ? Math.round(asNum(o.final_amount)) : 0, kind: 'DELIVERED', state: 'ACTIVE', canRequest: false, disabledReason: '', request: reqView(lastReq.get(o ? s(o.order_id) : s(x.order_id))) };
    if (st === 'REFUNDED' || (o && up(o.status) === 'REFUNDED')) { item.state = 'REFUNDED'; item.statusLabel = '💸 Refunded'; item.disabledReason = 'Already refunded.'; }
    else if (ENDED.includes(st)) { item.state = 'ENDED'; item.statusLabel = 'Cancelled'; item.disabledReason = 'This plan was cancelled.'; }
    else if (!exp || exp.getTime() <= now.getTime()) { item.state = 'EXPIRED'; item.statusLabel = 'Ended'; item.disabledReason = 'This plan has ended.'; }
    else if (!o || up(o.status) !== 'PAID' || !(asNum(o.final_amount) > 0)) { item.state = 'NO_PAYMENT'; item.statusLabel = '✅ Active'; item.disabledReason = 'No payment found for this plan — tap Help.'; }
    else {
      item.statusLabel = '✅ Active';
      const block = blockFor(s(o.order_id));
      if (block) item.disabledReason = block;
      else {
        item.canRequest = true;
        const periodEnd = subs.filter((y) => (gid && s(y.group_id) === gid) || s(y.sub_id) === s(x.sub_id)).map((y) => s(y.expiry_date)).sort().pop();
        const sc = refundsMod.suggestCharge({ paid: o.final_amount, totalDays: asNum(o.duration_days) || asNum(x.duration_days) || 30, periodEnd, now });
        item.estimate = { paid: sc.paid, daysUsed: sc.daysUsed, totalDays: sc.totalDays, charge: sc.suggested, refund: Math.max(0, sc.paid - sc.suggested) };
      }
    }
    items.push(item);
  }
  // Paid orders that were NOT delivered (website orders only; old-site orders were handled by the old site).
  const deliveredOrders = new Set(subs.filter(isDeliveredSub).map((x) => s(x.order_id)));
  for (const o of orders) {
    const oid = s(o.order_id); const st = up(o.status); const fs = up(o.fulfillment_status);
    if (st !== 'PAID' || s(o.source) !== 'node' || fs === 'FULFILLED' || deliveredOrders.has(oid)) continue;
    const paid = toDate(paidAtOf(o));
    const item = { key: 'order:' + oid, type: 'order', orderId: oid, subId: '', service: s(o.service), plan: s(o.plan), date: paidAtOf(o), amount: Math.round(asNum(o.final_amount)), kind: 'UNDELIVERED', state: fs === 'MANUAL_PENDING' ? 'MANUAL_PENDING' : 'NOT_DELIVERED', canRequest: false, disabledReason: '', request: reqView(lastReq.get(oid)) };
    item.statusLabel = item.state === 'MANUAL_PENDING' ? '⏳ Being activated' : '⚠️ Not delivered yet';
    if (!(asNum(o.final_amount) > 0)) { item.disabledReason = 'This order cost ₹0 — tap Help and we’ll sort it out.'; items.push(item); continue; }
    const until = paid ? new Date(paid.getTime() + WAIT_HOURS * 3600e3) : null;
    if (until) { item.waitUntil = fmtDt(until); item.waitUntilMs = until.getTime(); item.waitUntilLabel = whenLabel(until); }
    const block = blockFor(oid);
    if (block) item.disabledReason = block;
    else if (!until || now.getTime() < until.getTime()) {
      item.waiting = true;
      item.disabledReason = item.state === 'MANUAL_PENDING'
        ? 'Your plan is being activated by our team. It can take up to 48 hours from payment. You can request a refund after ' + (item.waitUntilLabel || '48 hours') + ' if it’s still not delivered.'
        : 'We’re arranging a replacement account for you. Please wait until ' + (item.waitUntilLabel || '48 hours after payment') + '.';
    } else { item.canRequest = true; item.estimate = { paid: item.amount, daysUsed: 0, totalDays: 0, charge: 0, refund: item.amount }; }
    items.push(item);
  }
  // Refunded orders without a subscription row (e.g. refunded before delivery): shown, disabled.
  for (const o of orders) {
    if (up(o.status) !== 'REFUNDED' || items.some((i) => i.orderId === s(o.order_id))) continue;
    items.push({ key: 'order:' + s(o.order_id), type: 'order', orderId: s(o.order_id), subId: '', service: s(o.service), plan: s(o.plan), date: paidAtOf(o), amount: Math.round(asNum(o.final_amount)), kind: 'UNDELIVERED', state: 'REFUNDED', statusLabel: '💸 Refunded', canRequest: false, disabledReason: 'Already refunded.', request: reqView(lastReq.get(s(o.order_id))) });
  }
  const rank = (i) => (i.canRequest ? 0 : i.waiting ? 1 : i.request && i.request.status === 'OPEN' ? 2 : 3);
  items.sort((a, b) => rank(a) - rank(b) || String(b.date).localeCompare(String(a.date)));
  return items.slice(0, 40);
}

function create(deps) {
  deps = deps || {};
  const lazy = (name) => () => deps[name] || require('./' + name);
  const M = { db: lazy('db'), mailer: lazy('mailer'), push: lazy('push') };
  const now = () => (deps.now ? deps.now() : new Date());
  const q = (sql, p) => M.db().query(sql, p);

  async function loadFor(ph) {
    const [subs, orders] = await Promise.all([
      q('SELECT * FROM subscriptions WHERE phone_norm = ? ORDER BY expiry_date DESC LIMIT 60', [ph]),
      q('SELECT order_id, service, plan, final_amount, status, fulfillment_status, order_type, renew_sub_id, source, duration_days, verified_at, created_at_sheet, email, name FROM orders WHERE phone_norm = ? ORDER BY created_at_sheet DESC LIMIT 60', [ph]),
    ]);
    let requests = []; let ready = true;
    try { requests = await q('SELECT * FROM refund_requests WHERE phone_norm = ? ORDER BY created_at DESC LIMIT 30', [ph]); }
    catch (e) { if (missingTable(e)) ready = false; else throw e; }
    let offers = [];
    try { offers = await q("SELECT order_id, status FROM refund_offers WHERE phone_norm = ? AND status IN ('OFFERED', 'UPI_REQUESTED')", [ph]); }
    catch (e) { if (!missingTable(e)) throw e; }
    return { subs: (subs || []).filter((x) => norm(x.phone_norm) === ph), orders: orders || [], requests: requests || [], offers: offers || [], ready };
  }

  /** Storefront step 1: what this phone can request a refund for (+ its recent requests). */
  async function listItems(phone) {
    const ph = norm(phone);
    if (ph.length !== 10) return { ok: false, message: 'Please log in with your phone number.' };
    const d = await loadFor(ph);
    const items = buildItems(Object.assign({ now: now() }, d));
    if (!d.ready) items.forEach((i) => { if (i.canRequest) { i.canRequest = false; i.disabledReason = 'Refund requests are being set up — please tap Help for now.'; } });
    const requests = d.requests.slice(0, 10).map((r) => ({ requestId: s(r.request_id), orderId: s(r.order_id), service: s(r.service), plan: s(r.plan), status: up(r.status), reason: up(r.reason), reasonLabel: REASONS[up(r.reason)] || '', adminMessage: s(r.admin_message), createdAt: s(r.created_at), offerId: s(r.offer_id) }));
    return { ok: true, items, requests, reasons: REASONS, waitHours: WAIT_HOURS, serverNow: now().getTime() };
  }

  async function newRequestId() {
    for (let i = 0; i < 8; i++) {
      let c = 'RQ'; for (let j = 0; j < 8; j++) c += CHARS[crypto.randomInt(0, CHARS.length)];
      if (!((await q('SELECT request_id FROM refund_requests WHERE request_id = ? LIMIT 1', [c])) || []).length) return c;
    }
    throw new Error('Could not pick a free request id — try again.');
  }

  /** Storefront step 2/3: submit. Only { orderId | subId, reason, text } are read; everything else is recomputed. */
  async function createRequest(phone, input) {
    const ph = norm(phone); const b = input && typeof input === 'object' ? input : {};
    if (ph.length !== 10) return { ok: false, message: 'Please log in with your phone number.' };
    const reason = up(b.reason);
    if (!REASONS[reason]) return { ok: false, field: 'reason', message: 'Choose a reason.' };
    const text = s(b.text).replace(/\s+/g, ' ').slice(0, 300);
    if (reason === 'OTHER' && text.length < 3) return { ok: false, field: 'text', message: 'Tell us a little about why (a few words).' };
    const d = await loadFor(ph);
    if (!d.ready) return { ok: false, message: 'Refund requests are being set up — please tap Help for now.' };
    const items = buildItems(Object.assign({ now: now() }, d));
    const subId = s(b.subId); const orderId = up(b.orderId);
    const item = subId ? items.find((i) => i.type === 'sub' && i.subId === subId) : items.find((i) => i.type === 'order' && i.orderId === orderId);
    if (!item) return { ok: false, message: 'We couldn’t find that plan or order on your number.' };
    if (!item.canRequest) return { ok: false, waiting: !!item.waiting, waitUntil: item.waitUntil || '', waitUntilLabel: item.waitUntilLabel || '', message: item.disabledReason || 'A refund can’t be requested for this right now.' };
    const dayAgo = fmtDt(new Date(now().getTime() - 24 * 3600e3));
    if (d.requests.filter((r) => s(r.created_at) >= dayAgo).length >= PER_DAY) return { ok: false, rateLimited: true, message: 'You’ve sent the most refund requests for today. Please try again tomorrow or tap Help.' };
    const id = await newRequestId();
    const at = fmtDt(now());
    const o = d.orders.find((x) => s(x.order_id) === item.orderId) || {};
    const est = item.estimate || {};
    try {
      await q('INSERT INTO refund_requests (request_id, order_id, sub_id, open_key, phone_norm, service, plan, kind, delivery_state, reason, reason_text, paid_amount, estimated_charge, paid_at, status, created_at)' +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)",
        [id, item.orderId, item.subId || null, item.orderId, ph, item.service, item.plan, item.kind, item.state, reason, text || null, item.amount, item.kind === 'DELIVERED' ? (est.charge || 0) : 0, paidAtOf(o) || null, at]);
    } catch (e) {
      if (e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(e.message))) return { ok: false, duplicate: true, message: 'Refund already requested — we’ll update you.' };
      if (missingTable(e)) return { ok: false, message: 'Refund requests are being set up — please tap Help for now.' };
      throw e;
    }
    Promise.resolve().then(() => M.push().sendToAdmins({ title: '📨 Refund request', body: item.service + ' ' + item.plan + ' · ₹' + item.amount + ' · ' + REASONS[reason] + (item.kind === 'UNDELIVERED' ? ' · not delivered' : ''), url: '/panel', tag: 'refund-request-' + id }, { kind: 'admin' })).catch(() => {});
    const message = item.kind === 'UNDELIVERED'
      ? '✅ Request received. This order was not delivered, so it’s a full refund of ₹' + item.amount + ' with no charge. We’ll email you and show a banner here to choose Coins, a Coupon or UPI.'
      : reason === 'NOT_WORKING'
        ? '✅ Request received. We’ll first try to give you a replacement account — we only refund if we can’t replace it. You’ll get an email and a banner here.'
        : '✅ Request received. Our team will check and send you the refund amount. You’ll get an email and a banner here to choose Coins, a Coupon or UPI.';
    return { ok: true, requestId: id, kind: item.kind, orderId: item.orderId, message };
  }

  // ------------------------------------------------------------------ admin
  /** Admin list: newest first, open ones on top, with the live delivery state and time since payment. */
  async function list() {
    let rows;
    try { rows = await q("SELECT * FROM refund_requests ORDER BY (status = 'OPEN') DESC, created_at DESC LIMIT 100", []); }
    catch (e) { if (missingTable(e)) return { ok: true, ready: false, requests: [] }; throw e; }
    rows = rows || [];
    const ids = [...new Set(rows.filter((r) => up(r.status) === 'OPEN').map((r) => s(r.order_id)))];
    const orders = new Map(); const subsBy = new Map(); const names = new Map();
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      for (const o of (await q('SELECT order_id, name, status, fulfillment_status, verified_at, created_at_sheet FROM orders WHERE order_id IN (' + marks + ')', ids)) || []) orders.set(s(o.order_id), o);
      for (const x of (await q('SELECT order_id, sub_id, status, fulfillment_status, login_id, expiry_date FROM subscriptions WHERE order_id IN (' + marks + ')', ids)) || []) { const k = s(x.order_id); if (!subsBy.has(k)) subsBy.set(k, []); subsBy.get(k).push(x); }
    }
    try {
      const phones = [...new Set(rows.map((r) => norm(r.phone_norm)).filter(Boolean))];
      if (phones.length) for (const c of (await q('SELECT phone_norm, name FROM customers WHERE phone_norm IN (' + phones.map(() => '?').join(',') + ')', phones)) || []) names.set(norm(c.phone_norm), s(c.name));
    } catch (_) { /* names are only a nicety */ }
    const t = now().getTime();
    const requests = rows.map((r) => {
      const o = orders.get(s(r.order_id));
      const subs = subsBy.get(s(r.order_id)) || [];
      const delivered = !!o && (up(o.fulfillment_status) === 'FULFILLED' || subs.some(isDeliveredSub));
      const paid = toDate(s(r.paid_at) || (o && paidAtOf(o)));
      return {
        requestId: s(r.request_id), orderId: s(r.order_id), subId: s(r.sub_id), phone: norm(r.phone_norm), name: names.get(norm(r.phone_norm)) || (o && s(o.name)) || '', service: s(r.service), plan: s(r.plan),
        kind: up(r.kind), deliveryStateAtRequest: up(r.delivery_state), reason: up(r.reason), reasonLabel: REASONS[up(r.reason)] || '', text: s(r.reason_text), paid: asNum(r.paid_amount), estimatedCharge: asNum(r.estimated_charge),
        status: up(r.status), adminMessage: s(r.admin_message), offerId: s(r.offer_id), createdAt: s(r.created_at), decidedAt: s(r.decided_at), paidAt: paid ? fmtDt(paid) : '',
        hoursSincePayment: paid ? Math.floor((t - paid.getTime()) / 3600e3) : null,
        live: o ? { orderStatus: up(o.status), fulfillment: up(o.fulfillment_status), delivered } : null,
      };
    });
    return { ok: true, ready: true, requests };
  }

  async function lockOpen(conn, id) {
    const [rows] = await conn.query('SELECT * FROM refund_requests WHERE request_id = ? LIMIT 1 FOR UPDATE', [id]);
    return (rows || [])[0] || null;
  }
  async function withTx(fn) {
    const pool = M.db().getPool && M.db().getPool();
    if (!pool) throw new Error('DB not configured');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try { const out = await fn(conn); await conn.commit(); return out; } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
    } finally { conn.release(); }
  }
  const idOf = (v) => { const id = up(v); return REQ_RE.test(id) ? id : ''; };

  /** Admin: fetch one request (for approve / offer). */
  async function get(requestId) {
    const id = idOf(requestId);
    if (!id) return null;
    try { return ((await q('SELECT * FROM refund_requests WHERE request_id = ? LIMIT 1', [id])) || [])[0] || null; }
    catch (e) { if (missingTable(e)) return null; throw e; }
  }

  /** Close an OPEN request (status APPROVED / OFFERED / REJECTED). Guarded: exactly one close. */
  async function close(requestId, status, fields) {
    const id = idOf(requestId);
    if (!id) return { ok: false, status: 400, message: 'Request id required.' };
    const f = fields || {};
    try {
      return await withTx(async (conn) => {
        const r = await lockOpen(conn, id);
        if (!r) return { ok: false, status: 404, message: 'Request not found.' };
        if (up(r.status) !== 'OPEN') return { ok: false, status: 409, already: true, message: 'This request was already ' + up(r.status).toLowerCase() + '.', request: r };
        const [u] = await conn.query("UPDATE refund_requests SET status = ?, open_key = NULL, admin_message = ?, offer_id = ?, decided_at = ? WHERE request_id = ? AND status = 'OPEN' LIMIT 1", [status, s(f.message).slice(0, 300) || null, s(f.offerId) || null, fmtDt(now()), id]);
        if (!u || u.affectedRows !== 1) return { ok: false, status: 409, message: 'This request was just handled by someone else.' };
        return { ok: true, request: Object.assign({}, r, { status, admin_message: s(f.message), offer_id: s(f.offerId) }) };
      });
    } catch (e) {
      if (missingTable(e)) return { ok: false, status: 409, needsSchema: true, message: 'Run db/schema-v26.sql in phpMyAdmin first.' };
      throw e;
    }
  }

  /** Admin: reject with a message → the customer is emailed (order email) and sees it on the Request refund screen. */
  async function reject({ requestId, message }) {
    const msg = s(message).replace(/\s+/g, ' ').slice(0, 300);
    if (msg.length < 3) return { ok: false, status: 400, field: 'message', message: 'Write a short message for the customer.' };
    const r = await close(requestId, 'REJECTED', { message: msg });
    if (!r.ok) return r;
    const req = r.request;
    let email = '';
    try { const o = ((await q('SELECT order_id, name, email, service, plan FROM orders WHERE order_id = ? LIMIT 1', [s(req.order_id)])) || [])[0]; email = o && s(o.email); if (o) r.order = o; } catch (_) { email = ''; }
    if (email.includes('@')) {
      const o = r.order;
      const title = 'About your refund request';
      const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto"><h2 style="color:#0f766e;margin-bottom:4px">' + esc(title) + '</h2>' +
        '<p style="color:#475569;margin-top:0">Hi ' + esc(o.name || 'there') + ',</p>' +
        '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px"><b>' + esc(o.service) + '</b> — ' + esc(o.plan) + '<br>Order ID: ' + esc(o.order_id) + '</div>' +
        '<p style="color:#475569;font-size:14px">We checked your refund request and can’t refund this one:</p><p style="color:#0f172a;font-size:14px;background:#fff7ed;border-radius:10px;padding:10px 12px">' + esc(msg) + '</p>' +
        '<p style="color:#475569;font-size:14px">Questions? Reply to this email or tap Help in the FluxFilm app. You can also read our <a href="' + esc((s(process.env.SITE_URL) || 'https://shop.fluxfilm.in').replace(/\/+$/, '')) + '/refund-policy">Refund policy</a>.</p></div>';
      Promise.resolve().then(() => M.mailer().send(email, title + ' — FluxFilm order ' + s(o.order_id), html)).catch(() => {});
    }
    Promise.resolve().then(() => M.push().sendToPhone(norm(req.phone_norm), { title: 'About your refund request', body: msg, url: '/?source=push', tag: 'refund-request-' + s(req.request_id) }, { kind: 'refund' })).catch(() => {});
    return { ok: true, requestId: s(req.request_id), orderId: s(req.order_id), emailed: email.includes('@'), message: '❌ Request rejected — the customer was told.' };
  }

  return { listItems, createRequest, list, get, close, reject };
}

const defaultInstance = create();
module.exports = Object.assign({ create, buildItems, REASONS, WAIT_HOURS, PER_DAY, REQ_RE }, defaultInstance);
