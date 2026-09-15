/**
 * FluxFilm - admin "⚡ Refund now" (owner request 15 Sep 2026): "instantly issue a refund without sending a request —
 * in case I already decided with the customer and already got the UPI ID." Mounted by adminorderactions.js, admin-only.
 *
 *   GET  /admin/api/order/refund-now/quote?orderId=FF…|subId=SUB-…
 *        paid, days used ÷ total, suggested usage charge, delivered?, bonus %, open offer / request, old-site plan?
 *   POST /admin/api/order/refund-now
 *        { orderId | subId, reason NO_REPLACEMENT|MID_PERIOD|NOT_DELIVERED|OTHER, reasonText, charge, amount,
 *          method UPI|COINS|COUPON, upi, reference, upiSent, addBonus, bonusPercent, note, notify, paid (old-site only) }
 *
 * Works for delivered plans (mid-period / no replacement) and paid-but-not-delivered orders. One transaction under the
 * allocation lock (ff_alloc, like 💸 Refund), the order row locked:
 *   - the refund is stored as a refund_offers row with an RN… id, already DONE (coins / coupon / UPI sent) or
 *     UPI_REQUESTED (UPI not sent yet → 💸 Refunds to send + Today to-do). One live row per order (uq_ro_live_order),
 *     so it shows in ↩️ Refunds history ("⚡ by admin"), and 🚪 Remove users counts the ended subscriptions;
 *   - the order becomes REFUNDED with the same raw_json fields as an accepted offer (refunds.js endAccessOn) and every
 *     subscription of the purchase / device group REFUNDED (Recover / Get OTP / Games / renew stop). A not-delivered
 *     order gets what 💸 Refund does instead: holds released (coupon use, coins, referral rewards) and placeholder
 *     rows CANCELLED;
 *   - coins = addRefundCreditOn, coupon = createRefundCouponOn (refund + optional bonus %), UPI sent = the ✅ Done fields;
 *   - an open offer on the order is CANCELLED and an open customer request APPROVED ("handled by admin");
 *   - after commit: the customer is emailed with the existing templates (refunds.js notify) and the change log written.
 * Repeating the same refund (double tap) answers "already done"; a different one on a refunded order is refused.
 *
 * Old-site plans (a subscription with no paid order in MySQL): a manual record with the paid amount the owner types.
 * The refund is written on the subscription rows (REFUNDED + raw_json) and an RN… row (live_order = sub id), coins /
 * coupon work, UPI must already be sent (no order for the UPI list), email only if the plan has an email.
 *
 * Collation rule (PR 121): refund_offers / refund_requests are never JOINed with orders / customers / subscriptions.
 */
const crypto = require('crypto');
const refundsMod = require('./refunds');
const { isDeliveredSub } = require('./delivered');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return Object.assign({}, v); try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const maskPhone = (ph) => { const p = norm(ph); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };

const METHODS = ['UPI', 'COINS', 'COUPON'];
const REASONS = refundsMod.NOW_REASONS;
const NO_CHARGE = ['NO_REPLACEMENT', 'NOT_DELIVERED'];
const ENDED = ['REFUNDED', 'CANCELLED', 'CANCELED', 'REMOVED', 'ERASED'];
const HANDLED = 'Handled by admin (⚡ Refund now)';
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const endedSub = (x) => ENDED.includes(up(x.status));

/** { paid, charge, refund } or { error, field }. charge = paid − refund, so what is stored always adds up. Pure. */
function nowAmounts({ paid, reason, charge, amount, suggested }) {
  const p = Math.round(asNum(paid));
  if (!(p >= 1)) return { error: 'Nothing was paid — nothing to refund.', field: 'paid' };
  const c = NO_CHARGE.includes(up(reason)) ? 0 : (charge == null ? Math.max(0, Math.round(asNum(suggested))) : charge);
  if (c > p) return { error: 'The usage charge (₹' + c + ') is more than what was paid (₹' + p + ').', field: 'charge' };
  const r = amount == null ? p - c : amount;
  if (r > p) return { error: 'The refund (₹' + r + ') can’t be more than what was paid (₹' + p + ').', field: 'amount' };
  if (!(r >= 1)) return { error: 'The refund must be at least ₹1.', field: 'amount' };
  return { paid: p, charge: p - r, refund: r };
}

function mount(app, h) {
  const { db, auth, R, withLockedTx, releaseHolds, decide, rowsOf, send, Refused } = h;
  const audit = h.audit || { record: () => {} };
  const now = () => h.now();

  // An old-site plan has no paid order: offerTarget says noPaidOrder. Load its subscription + device group instead.
  async function target(q, { orderId, subId }) {
    try {
      const t = await R.offerTarget(q, { orderId, subId });
      return Object.assign({ mode: 'ORDER' }, t);
    } catch (e) {
      if (!(e instanceof refundsMod.Refused)) throw e;
      if (!(e.extra && e.extra.noPaidOrder && s(subId) && !s(orderId))) throw new Refused(e.extra.status || 409, e.message);
      const sub = (await q('SELECT * FROM subscriptions WHERE sub_id = ? LIMIT 1', [s(subId).slice(0, 40)]))[0];
      if (!sub) throw new Refused(404, 'Subscription not found.');
      let subs = [sub];
      if (s(sub.group_id)) subs = subs.concat(((await q('SELECT * FROM subscriptions WHERE group_id = ?', [s(sub.group_id)])) || []).filter((x) => s(x.sub_id) !== s(sub.sub_id)));
      subs = subs.filter((x) => norm(x.phone_norm) === norm(sub.phone_norm));
      return { mode: 'LEGACY', sub, subs, o: null };
    }
  }
  const periodOf = (o, subs) => ({
    periodEnd: subs.map((x) => s(x.expiry_date)).filter(Boolean).sort().pop() || '',
    totalDays: asNum(o && o.duration_days) || asNum((subs[0] || {}).duration_days) || 30,
  });
  const optionalRows = async (fn) => { try { return (await fn()) || []; } catch (e) { if (missingTable(e)) return null; throw e; } };

  // ---------------------------------------------------------------- quote (what the form shows)
  app.get('/admin/api/order/refund-now/quote', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const q = (sql, p) => db.query(sql, p);
      const t = await target(q, { orderId: req.query.orderId, subId: req.query.subId });
      const cfg = await R.getSettings();
      const at = now();
      if (t.mode === 'LEGACY') {
        const { sub, subs } = t;
        const pr = periodOf(null, subs);
        const sc = refundsMod.suggestCharge({ paid: 0, totalDays: pr.totalDays, periodEnd: pr.periodEnd, now: at });
        const ph = norm(sub.phone_norm);
        const ended = subs.every(endedSub);
        const done = await optionalRows(() => q('SELECT * FROM refund_offers WHERE live_order = ? LIMIT 1', [s(sub.sub_id)]));
        return res.json({
          ok: true, mode: 'LEGACY', legacy: true, orderId: s(sub.order_id), subId: s(sub.sub_id), subIds: subs.map((x) => s(x.sub_id)), service: s(sub.service), plan: s(sub.plan), name: '', phone: ph, phoneOk: ph.length === 10, email: s(sub.email),
          paid: null, delivered: true, totalDays: sc.totalDays, daysUsed: sc.daysUsed, suggestedCharge: null, periodStart: sc.periodStart, periodEnd: sc.periodEnd, bonusPercent: cfg.bonusPercent, couponDays: refundsMod.COUPON_DAYS,
          ready: done !== null, allowed: done !== null && !ended && !(done && done.length),
          reason: done === null ? 'Run db/schema-v26.sql in phpMyAdmin first.' : (done && done.length) || ended ? 'This plan was already refunded / ended.' : '',
          openOffer: null, openRequest: null,
        });
      }
      const { o, subs } = t;
      const own = await q('SELECT * FROM subscriptions WHERE order_id = ?', [s(o.order_id)]);
      const d = decide(o, own || []);
      const pr = periodOf(o, subs);
      const sc = refundsMod.suggestCharge({ paid: o.final_amount, totalDays: pr.totalDays, periodEnd: pr.periodEnd, now: at });
      const offers = await optionalRows(() => q('SELECT * FROM refund_offers WHERE order_id = ? ORDER BY created_at DESC LIMIT 5', [s(o.order_id)]));
      const requests = await optionalRows(() => q("SELECT request_id, status FROM refund_requests WHERE order_id = ? AND status = 'OPEN' LIMIT 1", [s(o.order_id)]));
      const open = (offers || []).find((x) => up(x.status) === 'OFFERED');
      const ph = norm(o.phone_norm);
      const ready = offers !== null;
      res.json({
        ok: true, mode: 'ORDER', legacy: false, orderId: s(o.order_id), subId: s(req.query.subId), subIds: (d.delivered ? subs : own || []).map((x) => s(x.sub_id)), service: s(o.service), plan: s(o.plan), name: s(o.name), phone: ph, phoneOk: ph.length === 10, email: s(o.email),
        paid: sc.paid, delivered: d.delivered, totalDays: sc.totalDays, daysUsed: d.delivered ? sc.daysUsed : 0, suggestedCharge: d.delivered ? sc.suggested : 0, periodStart: sc.periodStart, periodEnd: sc.periodEnd,
        bonusPercent: cfg.bonusPercent, couponDays: refundsMod.COUPON_DAYS, ready, allowed: ready && d.refundNow.allowed, reason: !ready ? 'Run db/schema-v26.sql in phpMyAdmin first.' : d.refundNow.reason || '',
        openOffer: open ? { offerId: s(open.offer_id), refund: asNum(open.refund_amount), expiresAt: s(open.expires_at) } : null,
        openRequest: requests && requests[0] ? { requestId: s(requests[0].request_id) } : null,
      });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- issue it
  app.post('/admin/api/order/refund-now', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const bad = (field, message) => res.status(400).json({ ok: false, field, message });
    const method = up(b.method);
    if (!METHODS.includes(method)) return bad('method', 'Choose how: 🏦 UPI, 🪙 Coins or 🎟️ Coupon.');
    const reason = up(b.reason);
    if (!REASONS[reason]) return bad('reason', 'Choose the reason: No replacement, Mid-period, Not delivered or Other.');
    const reasonText = s(b.reasonText).replace(/\s+/g, ' ').slice(0, 200);
    if (reason === 'OTHER' && reasonText.length < 3) return bad('reasonText', 'Write the reason (a few words).');
    const note = s(b.note).replace(/\s+/g, ' ').slice(0, 300);
    const upi = s(b.upi).replace(/\s+/g, '');
    const reference = s(b.reference).slice(0, 120);
    const upiSent = b.upiSent !== false && b.upiSent !== 'false';
    if (method === 'UPI' && !refundsMod.UPI_RE.test(upi)) return bad('upi', 'Enter a UPI ID like name@okhdfcbank.');
    const intOf = (v) => (v === '' || v == null ? null : Number(v));
    const charge = intOf(b.charge); const amount = intOf(b.amount); const paidIn = intOf(b.paid);
    if (charge != null && (!Number.isInteger(charge) || charge < 0)) return bad('charge', 'The usage charge must be a whole number of rupees, ₹0 or more.');
    if (amount != null && !Number.isInteger(amount)) return bad('amount', 'The refund must be a whole number of rupees.');
    if (paidIn != null && (!Number.isInteger(paidIn) || paidIn < 1)) return bad('paid', 'Type what the customer paid, in whole rupees.');
    const tell = b.notify !== false && b.notify !== 'false';
    const addBonus = method !== 'UPI' && b.addBonus !== false && b.addBonus !== 'false';
    try {
      const cfg = await R.getSettings();
      let pct = 0;
      if (addBonus) {
        pct = b.bonusPercent === '' || b.bonusPercent == null ? cfg.bonusPercent : Number(b.bonusPercent);
        if (!Number.isInteger(pct) || pct < 0 || pct > 50) return bad('bonusPercent', 'Bonus must be a whole number from 0 to 50 (%).');
      }
      const done = await withLockedTx(async (conn) => {
        const q = (sql, p) => rowsOf(conn, sql, p);
        const at = fmtDt(now());
        const t = await target(q, { orderId: b.orderId, subId: b.subId });
        const legacy = t.mode === 'LEGACY';
        let o; let own = []; let ph; let paid; let delivered = true; let subs = t.subs; let liveKey; let pr;
        if (legacy) {
          const sub = (await q('SELECT * FROM subscriptions WHERE sub_id = ? LIMIT 1 FOR UPDATE', [s(t.sub.sub_id)]))[0];
          if (!sub) throw new Refused(404, 'Subscription not found.');
          liveKey = s(sub.sub_id); ph = norm(sub.phone_norm); paid = paidIn;
          if (paid == null) throw new Refused(400, 'This plan was bought on the old site — type what the customer paid (₹) to record the refund.', { field: 'paid', legacy: true });
          o = { order_id: s(sub.order_id) || liveKey, service: sub.service, plan: sub.plan, name: '', email: sub.email, phone: sub.phone, phone_norm: ph, raw_json: null };
          pr = periodOf(null, subs);
        } else {
          o = (await q('SELECT * FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [s(t.o.order_id)]))[0];
          if (!o) throw new Refused(404, 'Order not found.');
          own = await q('SELECT * FROM subscriptions WHERE order_id = ? FOR UPDATE', [s(o.order_id)]);
          liveKey = s(o.order_id); ph = norm(o.phone_norm); paid = Math.round(asNum(o.final_amount));
          pr = periodOf(o, subs);
        }
        const sc = refundsMod.suggestCharge({ paid, totalDays: pr.totalDays, periodEnd: pr.periodEnd, now: now() });
        const a = nowAmounts({ paid, reason, charge, amount, suggested: sc.suggested });
        // Already refunded: the same ⚡ refund again (double tap) is "already done"; anything else is refused.
        const prev = await optionalRows(() => q('SELECT * FROM refund_offers WHERE live_order = ? LIMIT 1', [liveKey]));
        if (prev === null) throw new Refused(409, 'Run db/schema-v26.sql in phpMyAdmin first.', { needsSchema: true });
        const last = prev[0];
        const same = last && refundsMod.NOW_ID_RE.test(s(last.offer_id)) && up(last.method) === method && !a.error && Math.round(asNum(last.refund_amount)) === a.refund;
        const refundedAlready = legacy ? subs.length > 0 && subs.every(endedSub) : up(o.status) === 'REFUNDED';
        if (same && (refundedAlready || legacy)) return { already: true, row: last, o };
        if (refundedAlready || (legacy && last)) throw new Refused(409, legacy ? 'This plan was already refunded / ended.' : 'This order was already refunded' + (refundsMod.refundInfo(o).method ? ' (' + refundsMod.refundInfo(o).method + ')' : '') + '.', { alreadyRefunded: true });
        if (!legacy && up(o.status) !== 'PAID') throw new Refused(409, 'Only paid orders can be refunded (this one is ' + (up(o.status) || 'not paid') + ').', { notPaid: true });
        if (a.error) throw new Refused(400, a.error, { field: a.field });
        if (!legacy) delivered = decide(o, own).delivered;
        const phoneOk = ph.length === 10;
        const warnings = [];
        if (!phoneOk) {
          if (!(method === 'UPI' && upiSent)) throw new Refused(400, 'This ' + (legacy ? 'plan' : 'order') + ' has no 10-digit phone number — coins, a coupon or the UPI to-send list need one. Send the UPI refund yourself, then record it with “Already sent”.', { field: 'method' });
          warnings.push('No 10-digit phone on this ' + (legacy ? 'plan' : 'order') + ': recorded, but the customer sees no pop-up or push.');
        }
        if (legacy && method === 'UPI' && !upiSent) throw new Refused(400, 'Old-site plan: there is no order for the “Refunds to send” list. Send the UPI refund first, then record it with “Already sent” ticked.', { field: 'upiSent' });

        // 1) Close what was open for this refund: the owner handled it.
        let closedOffers = 0; let closedRequests = 0;
        if (!legacy) {
          const [u] = await conn.query("UPDATE refund_offers SET status = 'CANCELLED', live_order = NULL, cancelled_at = ?, cancel_reason = ? WHERE order_id = ? AND status = 'OFFERED'", [at, HANDLED, liveKey]);
          closedOffers = (u && u.affectedRows) || 0;
        }
        const reqMsg = 'Refunded by FluxFilm: ₹' + a.refund + '.';
        try {
          const subIds = legacy ? subs.map((x) => s(x.sub_id)) : [];
          const [u] = legacy
            ? await conn.query("UPDATE refund_requests SET status = 'APPROVED', open_key = NULL, admin_message = ?, decided_at = ? WHERE sub_id IN (" + subIds.map(() => '?').join(',') + ") AND status = 'OPEN'", [reqMsg, at].concat(subIds))
            : await conn.query("UPDATE refund_requests SET status = 'APPROVED', open_key = NULL, admin_message = ?, decided_at = ? WHERE order_id = ? AND status = 'OPEN'", [reqMsg, at, liveKey]);
          closedRequests = (u && u.affectedRows) || 0;
        } catch (e) { if (!missingTable(e)) throw e; }

        // 2) Pay it.
        let id = '';
        for (let i = 0; i < 8 && !id; i++) {
          let c = 'RN'; for (let j = 0; j < 8; j++) c += ID_CHARS[crypto.randomInt(0, ID_CHARS.length)];
          if (!(await q('SELECT offer_id FROM refund_offers WHERE offer_id = ? LIMIT 1', [c])).length) id = c;
        }
        if (!id) throw new Error('Could not pick a free refund id — try again.');
        const value = refundsMod.bonusCredit(a.refund, pct); const bonus = value - a.refund;
        const base = { RefundNow: true, RefundBy: 'admin', RefundReasonText: reasonText };
        let extra; let coupon = null; let creditAfter = null; let todoId = null; let roStatus = 'DONE';
        const creditKey = legacy ? liveKey : s(o.order_id);
        if (method === 'COINS') {
          const c = await h.coins().addRefundCreditOn(conn, { orderId: creditKey, phone: ph, credit: value, service: o.service, plan: o.plan, amount: a.refund, note: '⚡ Refund now for ' + creditKey + (pct ? ' (+' + pct + '%)' : '') });
          if (!c.ok) throw new Refused(400, 'Refund credit needs the customer’s phone number.', { field: 'method' });
          if (c.already) throw new Refused(409, 'Refund credit was already added for ' + creditKey + '.', { alreadyRefunded: true });
          creditAfter = c.creditAfter;
          extra = { RefundMethod: 'Coins', RefundState: 'DONE', RefundCredit: value, RefundCoins: value, RefundBonus: bonus, RefundBonusPercent: pct, RefundConvertedAt: at };
        } else if (method === 'COUPON') {
          coupon = await R.createRefundCouponOn(conn, { orderId: s(o.order_id), phone: ph, amount: value });
          extra = { RefundMethod: 'COUPON', RefundState: 'DONE', RefundCoupon: coupon.code, RefundCouponExpiry: coupon.expiry, RefundCouponValue: value, RefundBonus: bonus, RefundBonusPercent: pct, RefundConvertedAt: at };
        } else if (upiSent) {
          extra = { RefundMethod: 'UPI', RefundState: 'DONE', RefundUpi: upi, RefundUpiSentAt: at, RefundRef: reference, RefundCompletedVia: 'refund-now' };
        } else {
          roStatus = 'UPI_REQUESTED';
          todoId = await R.addUpiTodo(conn, { oid: s(o.order_id), ph, o, upi, amount: a.refund, what: '⚡ Refund now (agreed with the customer by admin) — UPI' });
          extra = { RefundMethod: 'UPI_PENDING', RefundState: 'UPI_REQUESTED', RefundUpi: upi, RefundUpiRequestedAt: at, RefundTodoId: todoId, RefundRef: reference };
        }
        Object.assign(extra, base);
        const noteStored = [reasonText, note].filter(Boolean).join(' · ').slice(0, 300);
        const endIds = (delivered ? subs.filter((x) => !endedSub(x)) : []).map((x) => s(x.sub_id)).join(',').slice(0, 400);
        const ro = { offer_id: id, refund_amount: a.refund, reason, paid_amount: a.paid, charge_amount: a.charge, note, sub_ids: endIds };

        // 3) End access / mark refunded (typed columns + raw_json in step).
        let holds = null; let ended = 0;
        if (legacy) {
          for (const x of subs.filter((y) => !endedSub(y))) {
            const sraw = x.raw_json == null ? null : Object.assign(rawOf(x.raw_json), extra, {
              Status: 'REFUNDED', FulfillmentStatus: 'REFUNDED', RefundOfferId: id, AccessEndedAt: at, PreviousStatus: up(x.status), RefundedAt: at,
              RefundAmount: a.refund, RefundPaid: a.paid, RefundCharge: a.charge, RefundReason: reason, RefundNote: note, RefundKind: 'DELIVERED', RefundLegacyManual: true,
            });
            await conn.query("UPDATE subscriptions SET status = 'REFUNDED', fulfillment_status = 'REFUNDED'" + (sraw ? ', raw_json = ?' : '') + ' WHERE sub_id = ? LIMIT 1', (sraw ? [JSON.stringify(sraw)] : []).concat([s(x.sub_id)]));
            ended++;
          }
        } else if (delivered) {
          ended = (await R.endAccessOn(conn, o, ro, extra)).ended;
        } else {
          // Not delivered: exactly what 💸 Refund does — placeholder rows stop counting, holds go back.
          for (const x of (own || []).filter((y) => !isDeliveredSub(y))) {
            const sraw = x.raw_json == null ? null : Object.assign(rawOf(x.raw_json), { Status: 'CANCELLED', FulfillmentStatus: 'REFUNDED' });
            await conn.query("UPDATE subscriptions SET status = 'CANCELLED', fulfillment_status = 'REFUNDED'" + (sraw ? ', raw_json = ?' : '') + ' WHERE sub_id = ? LIMIT 1', (sraw ? [JSON.stringify(sraw)] : []).concat([x.sub_id]));
          }
          holds = await releaseHolds(conn, o, 'order ' + s(o.order_id) + ' refunded (⚡ Refund now)');
          await R.endAccessOn(conn, o, ro, Object.assign({}, extra, { RefundKind: 'NOT_DELIVERED', PreviousFulfillmentStatus: up(o.fulfillment_status), AccessEndedAt: undefined }));
        }

        // 4) The refund record (↩️ Refunds history, Remove users, ✅ Done on a queued UPI).
        try {
          await conn.query(
            'INSERT INTO refund_offers (offer_id, order_id, live_order, sub_ids, phone_norm, service, plan, reason, paid_amount, charge_amount, suggested_charge, refund_amount, days_used, total_days, bonus_percent, note, status, method, credit_amount, coupon_code, upi_id, upi_ref, expires_at, created_at, accepted_at, paid_at)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, s(o.order_id), liveKey, legacy ? subs.map((x) => s(x.sub_id)).join(',').slice(0, 400) : endIds, phoneOk ? ph : '', s(o.service), s(o.plan), reason, a.paid, a.charge, delivered ? sc.suggested : 0, a.refund,
              delivered ? sc.daysUsed : null, delivered ? sc.totalDays : null, pct, noteStored || null, roStatus, method, method === 'UPI' ? null : value, coupon ? coupon.code : null, method === 'UPI' ? upi : null, method === 'UPI' && reference ? reference : null,
              at, at, at, roStatus === 'DONE' ? at : null]);
        } catch (e) {
          if (e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(e.message))) throw new Refused(409, 'This was just refunded — refresh.', { alreadyRefunded: true });
          throw e;
        }
        return { id, o, legacy, delivered, a, method, value, bonus, pct, coupon, creditAfter, todoId, ended, holds, closedOffers, closedRequests, warnings, subIds: subs.map((x) => s(x.sub_id)) };
      });

      if (done.already) {
        const r0 = done.row;
        return res.json({ ok: true, already: true, refundId: s(r0.offer_id), orderId: s(r0.order_id), method: up(r0.method), amount: asNum(r0.refund_amount), message: '✅ Already refunded (' + s(r0.offer_id) + ') — nothing changed.' });
      }
      const o = done.o; const a = done.a;
      const how = done.method === 'COINS' ? done.value + ' coins' + (done.bonus ? ' (incl. +' + done.bonus + ' bonus)' : '')
        : done.method === 'COUPON' ? 'coupon ' + done.coupon.code + ' (₹' + done.value + ')'
          : 'UPI ' + upi + (upiSent ? ' (sent' + (reference ? ', ref ' + reference : '') + ')' : ' (to send)');
      audit.record(req, {
        action: 'refund.now', entity: done.legacy ? 'subscription' : 'order', id: done.legacy ? s(b.subId) : s(o.order_id),
        summary: '⚡ Refund now ' + done.id + ': ₹' + a.refund + ' (paid ₹' + a.paid + (a.charge ? ' − charge ₹' + a.charge : ', no charge') + ') as ' + how + ' · ' + REASONS[reason] + (reasonText ? ': ' + reasonText : '') +
          (done.legacy ? ' · old-site plan, manual record' : done.delivered ? ' · access ended' : ' · not delivered') + ' · ' + maskPhone(o.phone_norm) + (done.closedOffers ? ' · open offer closed' : '') + (done.closedRequests ? ' · request closed' : '') + (note ? ' · ' + note : ''),
        details: { refundId: done.id, orderId: s(o.order_id), subIds: done.subIds, legacy: done.legacy, delivered: done.delivered, paid: a.paid, charge: a.charge, refund: a.refund, method: done.method, bonusPercent: done.pct, credit: done.method === 'UPI' ? null : done.value, coupon: done.coupon, upi: done.method === 'UPI' ? upi : '', reference, upiSent: done.method === 'UPI' ? upiSent : null, todoId: done.todoId, reason, reasonText, note, closedOffers: done.closedOffers, closedRequests: done.closedRequests, holds: done.holds },
      });
      let mail = null;
      if (tell) {
        if (done.method === 'COINS') mail = R.notify(o, done.bonus ? 'CONVERTED' : 'CREDIT', { amount: a.refund, credit: done.value, bonus: done.bonus, note });
        else if (done.method === 'COUPON') mail = R.notify(o, 'COUPON', { amount: a.refund, value: done.value, coupon: done.coupon.code, expiry: done.coupon.expiry, note });
        else if (upiSent) mail = R.notify(o, 'UPI_SENT', { amount: a.refund, upi, reference, note });
        else mail = R.notify(o, 'UPI_REQUESTED', { amount: a.refund, upi, note });
        if (mail) mail.then((r) => { if (r && r.ok) return db.query('UPDATE refund_offers SET email_sent = 1 WHERE offer_id = ? LIMIT 1', [done.id]); return null; }).catch(() => {});
      }
      const emailed = tell && s(o.email).includes('@');
      const notes = done.warnings.slice();
      if (done.closedOffers) notes.push('The open refund offer on this order was closed (handled by admin).');
      if (done.closedRequests) notes.push('The customer’s refund request was closed (handled by admin).');
      if (done.legacy) notes.push('Old-site plan: recorded on the subscription (no order in the new system).');
      if (done.ended) notes.push(done.ended + ' subscription row(s) ended — Recover / Get OTP / renew stop; 🚪 Remove users lists them.');
      const h2 = done.holds;
      if (h2 && h2.coins && h2.coins.returned) notes.push(h2.coins.returned + ' coins used on this order were given back.');
      if (h2 && h2.coins && h2.coins.creditReturned) notes.push('₹' + h2.coins.creditReturned + ' refund credit used on this order was given back.');
      if (h2 && h2.coins && h2.coins.reversed) notes.push(h2.coins.reversed + ' coins earned on it were taken back.');
      if (h2 && h2.referral && h2.referral.cancelled) notes.push(h2.referral.cancelled + ' unpaid referral reward(s) cancelled.');
      if (done.todoId) notes.push('Added to 💸 Refunds to send (and a Today to-do). Tap ✅ Done after you send it.');
      notes.push(tell ? (emailed ? 'The customer was emailed.' : 'No email on this ' + (done.legacy ? 'plan' : 'order') + ' — nothing emailed.') : 'No email sent.');
      const message = done.method === 'UPI'
        ? (upiSent ? '⚡ Refund of ₹' + a.refund + ' to ' + upi + ' recorded as sent.' : '⚡ ₹' + a.refund + ' to ' + upi + ' added to Refunds to send.')
        : done.method === 'COINS' ? '⚡ ' + done.value + ' coins of refund credit added.' : '⚡ Coupon ' + done.coupon.code + ' (₹' + done.value + ') created.';
      res.json({
        ok: true, refundId: done.id, orderId: s(o.order_id), subIds: done.subIds, legacy: done.legacy, delivered: done.delivered, paid: a.paid, charge: a.charge, amount: a.refund, method: done.method,
        credit: done.method === 'COINS' ? done.value : null, creditBalance: done.creditAfter, coupon: done.coupon, upi: done.method === 'UPI' ? upi : '', upiSent: done.method === 'UPI' ? upiSent : null, queued: !!done.todoId, todoId: done.todoId,
        accessEnded: done.ended, closedOffers: done.closedOffers, closedRequests: done.closedRequests, emailed, notes, message,
      });
    } catch (e) {
      if (missingTable(e) && /refund_offers/.test(String(e.message))) return res.status(409).json({ ok: false, needsSchema: true, message: 'Run db/schema-v26.sql in phpMyAdmin first.' });
      send(res, e);
    }
  });
}

module.exports = { mount, nowAmounts, METHODS };
