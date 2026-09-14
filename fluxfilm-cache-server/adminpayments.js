/**
 * FluxFilm - admin 💸 Payments screen (admin-only): backup UPI settings + the "I've paid" review queue.
 *
 *   GET  /admin/api/payments/settings   → { settings, hasQr, qrImage, needsSchema }
 *   POST /admin/api/payments/settings   { ...settings }          (validated, app_settings 'payfallback', change log)
 *   POST /admin/api/payments/qr         { dataUrl }              ('' removes it; change log)
 *   GET  /admin/api/payments/claims     ?status=OPEN|REVIEW|WAITING|MATCHED|APPROVED|REJECTED|ALL
 *   POST /admin/api/payments/approve    { id, creditId?, note? } (creditId = the bank payment picked; none = confirmed by hand)
 *   POST /admin/api/payments/reject     { id, note? }
 *   POST /admin/api/payments/sweep      → re-check open claims now
 */
const s = (v) => String(v == null ? '' : v).trim();

function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const pm = deps.paymatch || require('./paymatch');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/payments/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const cfg = await pm.getSettings(true);
      const settings = {}; for (const k of Object.keys(pm.DEFAULTS)) settings[k] = cfg[k];
      const qr = await pm.getQr(true);
      res.json({ ok: true, settings, defaults: pm.DEFAULTS, hasQr: !!qr, qrImage: qr, needsSchema: !(await pm.schemaReady()) });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/payments/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const before = await pm.getSettings(true);
      const r = await pm.saveSettings(req.body || {});
      if (!r.ok) return res.status(r.needsSchema ? 409 : 400).json(r);
      const changed = Object.keys(r.settings).filter((k) => String(before[k]) !== String(r.settings[k]));
      audit.record(req, { action: 'payments.settings', entity: 'settings', id: 'payfallback', summary: changed.length ? 'Changed: ' + changed.map((k) => k + ' ' + before[k] + ' → ' + r.settings[k]).join(', ') : 'Saved (no changes)' });
      res.json({ ok: true, settings: r.settings, changed });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/payments/qr', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await pm.saveQr((req.body || {}).dataUrl);
      if (!r.ok) return res.status(r.needsSchema ? 409 : 400).json(r);
      audit.record(req, { action: r.hasQr ? 'payments.qr' : 'payments.qr.remove', entity: 'settings', id: 'payfallback_qr', summary: r.hasQr ? 'Uploaded backup QR (' + Math.round(r.bytes / 1024) + ' KB)' : 'Removed backup QR' });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/payments/claims', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await pm.listClaims({ status: req.query.status })); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/payments/approve', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await pm.approveClaim(b.id, b.creditId, b.note);
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'payments.approve', entity: 'order', id: r.orderId, summary: 'Approved "I\'ve paid" claim #' + s(b.id) + ' · ₹' + r.amount + (r.upiRef ? ' · bank ref ' + r.upiRef : ' · confirmed by hand') + (s(b.note) ? ' · ' + s(b.note) : '') });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/payments/reject', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await pm.rejectClaim(b.id, b.note);
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'payments.reject', entity: 'order', id: r.orderId, summary: 'Rejected "I\'ve paid" claim #' + s(b.id) + (s(b.note) ? ' · ' + s(b.note) : '') });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/payments/sweep', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await pm.sweep()); } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
