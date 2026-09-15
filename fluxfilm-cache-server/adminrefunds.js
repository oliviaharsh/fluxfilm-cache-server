/**
 * FluxFilm - admin 💸 Refunds (Refunds v3, owner decisions 15 Sep 2026). Mounted by admin.js, admin-only.
 *
 *   GET  /admin/api/refunds                     UPI refunds to send, refunds the customer is still choosing, offers, settings
 *   POST /admin/api/refunds/settings            { bonusPercent 0–50, offerDays 1–90 }       (app_settings, change log)
 *   GET  /admin/api/refund-offers/quote?orderId=FF…|subId=SUB-…   paid, days used ÷ total, suggested charge, open offer
 *   POST /admin/api/refund-offers               { orderId | subId, reason NO_REPLACEMENT|MID_PERIOD, charge, note, notify }
 *   POST /admin/api/refund-offers/cancel        { offerId, reason }
 *   ✅ Done on a UPI refund uses POST /admin/api/order/refund-upi-done (adminorderactions.js).
 *
 * All the rules live in refunds.js (amounts only from the server, locked + guarded state changes). Every write is in
 * the change log (audit_log).
 */
const s = (v) => String(v == null ? '' : v).trim();
// deps (admin.js deps.refundsAdmin): { refunds } = a refunds.create() instance (tests), else { coins, push, mailer, otpaccess, now }.
const maskPhone = (ph) => { const p = s(ph).replace(/\D/g, '').slice(-10); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const R = deps.refunds || require('./refunds').create({ db, coins: deps.coins, push: deps.push, mailer: deps.mailer, otpaccess: deps.otpaccess, now: deps.now });
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const reply = (res, r) => res.status(r.ok ? 200 : (r.status || 409)).json(r);

  app.get('/admin/api/refunds', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await R.adminOverview()); } catch (e) { fail(res, e); }
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
