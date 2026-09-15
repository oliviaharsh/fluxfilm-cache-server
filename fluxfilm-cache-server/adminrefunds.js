/**
 * FluxFilm - admin 💸 Refunds (Refunds v3, owner decisions 15 Sep 2026). Mounted by admin.js, admin-only.
 *
 *   GET  /admin/api/refunds                     UPI refunds to send, refunds the customer is still choosing, offers, settings
 *   POST /admin/api/refunds/settings            { bonusPercent 0–50, offerDays 1–90 }       (app_settings, change log)
 *   GET  /admin/api/refund-offers/quote?orderId=FF…|subId=SUB-…   paid, days used ÷ total, suggested charge, open offer
 *   POST /admin/api/refund-offers               { orderId | subId, reason NO_REPLACEMENT|MID_PERIOD, charge, note, notify }
 *   POST /admin/api/refund-offers/cancel        { offerId, reason }
 *   GET  /admin/api/refund-requests             📨 customer "Request refund" list (refundrequests.js)
 *   POST /admin/api/refund-requests/approve     { requestId }   not delivered → full refund, customer chooses (re-checks delivery)
 *   POST /admin/api/refund-requests/reject      { requestId, message }   customer emailed
 *   ✅ Done on a UPI refund uses POST /admin/api/order/refund-upi-done (adminorderactions.js). "Offer refund" on a
 *   request is the normal offer form: createOffer marks the order's open request OFFERED.
 *
 * All the rules live in refunds.js (amounts only from the server, locked + guarded state changes). Every write is in
 * the change log (audit_log).
 */
const s = (v) => String(v == null ? '' : v).trim();
const { isDeliveredSub, DELIVERY_COLS } = require('./delivered');
// deps (admin.js deps.refundsAdmin): { refunds } = a refunds.create() instance (tests), else { coins, push, mailer, otpaccess, now }.
const maskPhone = (ph) => { const p = s(ph).replace(/\D/g, '').slice(-10); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const R = deps.refunds || require('./refunds').create({ db, coins: deps.coins, push: deps.push, mailer: deps.mailer, otpaccess: deps.otpaccess, now: deps.now });
  const RQ = deps.refundRequests || require('./refundrequests').create({ db, mailer: deps.mailer, push: deps.push, now: deps.now });
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const reply = (res, r) => res.status(r.ok ? 200 : (r.status || 409)).json(r);
  const up = (v) => s(v).toUpperCase();

  app.get('/admin/api/refunds', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [over, reqs] = await Promise.all([R.adminOverview(), RQ.list()]);
      res.json(Object.assign(over, { requests: reqs.requests || [], requestsReady: reqs.ready !== false }));
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- 📨 customer refund requests (refundrequests.js)
  app.get('/admin/api/refund-requests', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await RQ.list()); } catch (e) { fail(res, e); }
  });

  // Paid but NOT delivered → one tap: full refund, the customer chooses coins / coupon (+%) or exact UPI. The same
  // refund as order → 💸 Refund → "Let the customer choose" (allocation lock, holds released, customer emailed).
  app.post('/admin/api/refund-requests/approve', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await RQ.get(b.requestId);
      if (!r) return res.status(404).json({ ok: false, message: 'Request not found.' });
      if (up(r.status) !== 'OPEN') return res.status(409).json({ ok: false, already: true, message: 'This request was already ' + up(r.status).toLowerCase() + '.' });
      if (up(r.kind) !== 'UNDELIVERED') return res.status(400).json({ ok: false, message: 'This plan was delivered — use 💸 Offer refund (with a usage charge if needed).' });
      // Re-check delivery NOW (the customer may have been delivered since they asked).
      const o = (await db.query('SELECT order_id, status, fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [s(r.order_id)]))[0];
      const subs = await db.query('SELECT sub_id, ' + DELIVERY_COLS + ' FROM subscriptions WHERE order_id = ?', [s(r.order_id)]);
      const deliveredNow = !!o && (up(o.fulfillment_status) === 'FULFILLED' || (subs || []).some(isDeliveredSub));
      const warn = { ok: false, status: 409, delivered: true, message: '⚠️ This order was delivered after the customer asked — nothing was refunded. Check with the customer; if they still want a refund use 💸 Offer refund, or Reject with a message.' };
      if (!o) return res.status(404).json({ ok: false, message: 'Order not found.' });
      if (deliveredNow) return res.status(409).json(warn);
      if (!req.app.locals.ffOrderRefund) return res.status(500).json({ ok: false, message: 'Order refunds are not available.' });
      const out = await req.app.locals.ffOrderRefund(req, { orderId: s(r.order_id), method: 'UPI_ASK', note: ('Refund request ' + s(r.request_id) + ' (' + up(r.reason) + ')').slice(0, 300), notify: true });
      if (!out.body || !out.body.ok) {
        if (/already delivered/i.test(String(out.body && out.body.message))) return res.status(409).json(warn);
        return res.status(out.status || 409).json(out.body || { ok: false, message: 'Refund failed.' });
      }
      const closed = await RQ.close(r.request_id, 'APPROVED', { message: 'Full refund approved — choose how you want it.' });
      audit.record(req, { action: 'refund.requestApprove', entity: 'order', id: s(r.order_id), summary: 'Refund request ' + s(r.request_id) + ' approved: full refund ₹' + Number(r.paid_amount || 0) + ' (not delivered) · ' + maskPhone(r.phone_norm) });
      res.json({ ok: true, requestId: s(r.request_id), orderId: s(r.order_id), closed: closed.ok, already: !!out.body.already, refund: out.body, message: out.body.already ? 'The order was already refunded — request closed.' : '✅ Full refund approved. The customer was emailed and chooses coins / coupon or UPI in the app.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/refund-requests/reject', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await RQ.reject({ requestId: b.requestId, message: b.message });
      if (r.ok) audit.record(req, { action: 'refund.requestReject', entity: 'order', id: r.orderId, summary: 'Refund request ' + r.requestId + ' rejected: ' + s(b.message).slice(0, 200) });
      reply(res, r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/refunds/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const r = await R.saveSettings({ bonusPercent: b.bonusPercent, offerDays: b.offerDays });
      if (!r.ok) return reply(res, r);
      audit.record(req, { action: 'refunds.settings', entity: 'settings', id: 'refund_settings', summary: 'Refund settings: coins / coupon +' + r.settings.bonusPercent + '% · offers open ' + r.settings.offerDays + ' days', details: { before: r.before, after: r.settings } });
      res.json({ ok: true, settings: r.settings });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/refund-offers/quote', async (req, res) => {
    if (!auth(req, res)) return;
    try { reply(res, await R.quoteOffer({ orderId: req.query.orderId, subId: req.query.subId })); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/refund-offers', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      // Only these fields are used: the paid amount and refund are worked out by the server.
      const r = await R.createOffer({ orderId: b.orderId, subId: b.subId, reason: b.reason, charge: b.charge, note: b.note, notify: b.notify !== false });
      if (!r.ok) return reply(res, r);
      const f = r.offer;
      audit.record(req, {
        action: 'refund.offer', entity: 'order', id: f.orderId,
        summary: 'Refund offered ' + f.offerId + ': ₹' + f.refund + ' (paid ₹' + f.paid + (f.charge ? ' − charge ₹' + f.charge : ', no charge') + ') · ' + (f.reason === 'NO_REPLACEMENT' ? 'no replacement' : 'mid-period ' + f.daysUsed + '/' + f.totalDays + ' days, suggested ₹' + f.suggestedCharge) + ' · ' + maskPhone(r.o && r.o.phone_norm) + (f.note ? ' · ' + f.note : ''),
        details: f,
      });
      delete r.o;
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/refund-offers/cancel', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await R.cancelOffer({ offerId: b.offerId, reason: b.reason });
      if (r.ok && !r.already) audit.record(req, { action: 'refund.offerCancel', entity: 'order', id: r.orderId, summary: 'Refund offer ' + r.offerId + ' (₹' + r.amount + ') cancelled' + (s(b.reason) ? ': ' + s(b.reason).slice(0, 200) : '') });
      reply(res, r);
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
