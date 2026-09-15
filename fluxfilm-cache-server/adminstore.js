/**
 * FluxFilm - admin 🚧 Maintenance screen (admin-only): pause / resume new orders.
 *
 *   GET  /admin/api/store   → { settings }
 *   POST /admin/api/store   { paused?, message?, backText?, sassyGreeting? }   (change log)
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const store = deps.store || require('./store');

  app.get('/admin/api/store', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json({ ok: true, settings: await store.getSettings(true), defaults: store.DEFAULTS }); }
    catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/store', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await store.saveSettings(req.body || {});
      if (!r.ok) return res.status(400).json(r);
      if (r.changed.length === 1 && r.changed[0] === 'sassyGreeting') {
        audit.record(req, { action: 'store.greeting', entity: 'settings', id: 'store', summary: 'Sassy greeting on My plans ' + (r.settings.sassyGreeting ? 'ON' : 'OFF') });
      } else if (r.changed.length) {
        const what = r.changed.includes('paused') ? (r.settings.paused ? 'PAUSED new orders (maintenance on)' : 'RESUMED new orders (maintenance off)') : 'Updated maintenance message';
        audit.record(req, { action: 'store.' + (r.settings.paused ? 'pause' : 'resume'), entity: 'settings', id: 'store', summary: what + (r.settings.paused && r.settings.backText ? ' · back ' + r.settings.backText : '') });
      }
      res.json({ ok: true, settings: r.settings, changed: r.changed });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
}

module.exports = { mount };
