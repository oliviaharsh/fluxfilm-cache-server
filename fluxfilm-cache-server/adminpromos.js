/**
 * FluxFilm - admin 📣 Offers (admin-only).
 *
 *   GET  /admin/api/promos           → { promos (with status, views, clicks, coupon check) }
 *   POST /admin/api/promos/save      { ...offer }      create / update
 *   POST /admin/api/promos/delete    { id }
 *   POST /admin/api/promos/image     { id, dataUrl }   '' removes the picture
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const promos = deps.promos || require('./promos');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/promos', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [items, st] = await Promise.all([promos.list(), promos.stats()]);
      const out = [];
      for (const p of items) {
        out.push(Object.assign({}, p, { status: promos.statusOf(p), views: (st[p.id] || {}).views || 0, clicks: (st[p.id] || {}).clicks || 0, coupon: p.couponCode ? await promos.couponCheck(p.couponCode) : null }));
      }
      res.json({ ok: true, promos: out, now: new Date().toISOString() });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/promos/save', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await promos.save(req.body || {});
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: r.created ? 'promo.create' : 'promo.update', entity: 'promo', id: r.promo.id, summary: (r.created ? 'Created' : 'Updated') + ' offer "' + r.promo.name + '" (' + r.promo.type + ', ' + (r.promo.active ? 'on' : 'off') + ')' });
      res.json(Object.assign(r, { status: promos.statusOf(r.promo) }));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/promos/delete', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await promos.remove(String((req.body || {}).id || ''));
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'promo.delete', entity: 'promo', id: r.promo.id, summary: 'Deleted offer "' + r.promo.name + '"' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/promos/image', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const r = await promos.setImage(String(b.id || ''), b.dataUrl);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
