/**
 * FluxFilm - admin 🚧 Maintenance screen (admin-only): pause / resume new orders.
 *
 *   GET  /admin/api/store   → { settings }
 *   POST /admin/api/store   { paused?, message?, backText?, helpBubble?, sassyGreeting?, renewPopup?, renewPopupBefore?, renewPopupAfter? }   (change log)
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
      if (r.changed.includes('helpBubble')) audit.record(req, { action: 'store.helpbubble', entity: 'settings', id: 'store', summary: '💬 Floating Help bubble turned ' + (r.settings.helpBubble === false ? 'OFF' : 'ON') });
      if (r.changed.includes('sassyGreeting')) audit.record(req, { action: 'store.greeting', entity: 'settings', id: 'store', summary: 'Sassy greeting on My plans turned ' + (r.settings.sassyGreeting === false ? 'OFF' : 'ON') });
      const rr = r.changed.filter((k) => /^renewPopup/.test(k));
      if (rr.length) {
        const s = r.settings;
        const what = rr.includes('renewPopup') ? '⏳ Renewal reminder pop-up turned ' + (s.renewPopup === false ? 'OFF' : 'ON') : '⏳ Renewal reminder pop-up days changed';
        audit.record(req, { action: 'store.renewpopup', entity: 'settings', id: 'store', summary: what + ' · ' + s.renewPopupBefore + ' days before / ' + s.renewPopupAfter + ' after expiry' });
      }
      const rest = r.changed.filter((k) => k !== 'helpBubble' && k !== 'sassyGreeting' && !/^renewPopup/.test(k));
      if (rest.length) {
        const what = rest.includes('paused') ? (r.settings.paused ? 'PAUSED new orders (maintenance on)' : 'RESUMED new orders (maintenance off)') : 'Updated maintenance message';
        audit.record(req, { action: 'store.' + (r.settings.paused ? 'pause' : 'resume'), entity: 'settings', id: 'store', summary: what + (r.settings.paused && r.settings.backText ? ' · back ' + r.settings.backText : '') });
      }
      res.json({ ok: true, settings: r.settings, changed: r.changed });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
}

module.exports = { mount };
