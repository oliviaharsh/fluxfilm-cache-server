/**
 * FluxFilm - admin 🚧 Maintenance screen (admin-only): pause / resume new orders.
 *
 *   GET  /admin/api/store   → { settings }
 *   POST /admin/api/store   { paused?, message?, backText?, helpBubble?, emailLogin? }   (change log)
 *   GET  /admin/api/customer-sessions?phone=   → { sessions: [{ id, createdAt, lastSeen, expiresAt, device }] }
 *   POST /admin/api/customer-sessions/revoke { phone }   → logs the customer out on every device (change log)
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
      if (r.changed.includes('emailLogin')) {
        const on = r.settings.emailLogin !== false;
        console.log('[email-login] admin turned the email login ' + (on ? 'ON' : 'OFF (emergency: phone-only login)'));
        audit.record(req, { action: 'store.emaillogin', entity: 'settings', id: 'store', summary: on ? '🔐 Email login required turned ON (customers confirm with an email code)' : '⚠️ Email login required turned OFF — EMERGENCY phone-only login (anyone with a number can open that account)' });
      }
      const rest = r.changed.filter((k) => k !== 'helpBubble' && k !== 'emailLogin');
      if (rest.length) {
        const what = rest.includes('paused') ? (r.settings.paused ? 'PAUSED new orders (maintenance on)' : 'RESUMED new orders (maintenance off)') : 'Updated maintenance message';
        audit.record(req, { action: 'store.' + (r.settings.paused ? 'pause' : 'resume'), entity: 'settings', id: 'store', summary: what + (r.settings.paused && r.settings.backText ? ' · back ' + r.settings.backText : '') });
      }
      res.json({ ok: true, settings: r.settings, changed: r.changed });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  // 🔐 Customer 360 → "Logged-in devices": list + log out everywhere (customerauth.js).
  const cauth = new Proxy({}, { get: (_t, k) => (deps.customerauth || require('./customerauth'))[k] });
  const ph10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
  app.get('/admin/api/customer-sessions', async (req, res) => {
    if (!auth(req, res)) return;
    const ph = ph10(req.query.phone);
    if (ph.length !== 10) return res.status(400).json({ ok: false, message: 'Enter a 10-digit phone number.' });
    try { res.json({ ok: true, phone: ph, sessions: await cauth.listSessions(ph) }); }
    catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
  app.post('/admin/api/customer-sessions/revoke', async (req, res) => {
    if (!auth(req, res)) return;
    const ph = ph10((req.body || {}).phone);
    if (ph.length !== 10) return res.status(400).json({ ok: false, message: 'Enter a 10-digit phone number.' });
    try {
      const n = await cauth.revokeAll(ph);
      audit.record(req, { action: 'customer.logout_all', entity: 'customers', id: ph, summary: '🔐 Logged the customer out on every device (' + n + ' session' + (n === 1 ? '' : 's') + ')' });
      res.json({ ok: true, revoked: n });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
}

module.exports = { mount };
