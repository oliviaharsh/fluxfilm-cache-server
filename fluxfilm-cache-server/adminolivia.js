/**
 * FluxFilm - admin 🤖 Olivia screen (admin-only): switch the AI store manager on/off, test phones, AI words, voice guide,
 * and read recent chats (the chat log never holds a login).
 *
 *   GET  /admin/api/olivia                   → { settings, schemaReady, aiKeySet }
 *   POST /admin/api/olivia                   { enabled?, testOnly?, testPhones?, aiWords?, whatsappLink?, voice? }  (change log)
 *   GET  /admin/api/olivia/chats?limit=      → { conversations }
 *   GET  /admin/api/olivia/chats/:id         → { messages }
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const olivia = deps.olivia || require('./olivia');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/olivia', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      res.json({ ok: true, settings: await olivia.getSettings(true), defaults: olivia.DEFAULTS, schemaReady: await olivia.schemaReady(), aiKeySet: !!process.env.DEEPSEEK_API_KEY });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/olivia', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await olivia.saveSettings(req.body || {});
      if (!r.ok) return res.status(400).json(r);
      if (r.changed.length) {
        const st = r.settings;
        const what = r.changed.includes('enabled') ? (st.enabled ? 'Olivia switched ON' + (st.testOnly ? ' (test phones only)' : ' for all customers') : 'Olivia switched OFF') : 'Olivia settings updated (' + r.changed.join(', ') + ')';
        audit.record(req, { action: 'olivia.settings', entity: 'settings', id: 'olivia', summary: what });
      }
      res.json({ ok: true, settings: r.settings, changed: r.changed });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/olivia/chats', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await olivia.recent(req.query.limit)); } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/olivia/chats/:id', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await olivia.messagesOf(req.params.id)); } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
