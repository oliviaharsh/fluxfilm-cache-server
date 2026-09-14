/**
 * FluxFilm - admin 🔔 Notifications (admin-only). Every send is written to the change log.
 *
 *   GET  /admin/api/push                    → { settings, stats, publicKey }
 *   POST /admin/api/push/settings           { auto, daysBefore, onExpiryDay, afterExpiry, delivered, quietStart, quietEnd, templates }
 *   POST /admin/api/push/subscribe          { subscription }     this admin phone / computer gets admin notifications
 *   POST /admin/api/push/unsubscribe        { endpoint }
 *   POST /admin/api/push/test               {}                   to the admin devices
 *   POST /admin/api/push/send               { phone, title, body, url }
 *   POST /admin/api/push/broadcast          { title, body, url, confirm: true }   all customers with reminders on
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const push = deps.push || require('./push');
  const reminders = deps.reminders || require('./pushreminders');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const s = (v) => String(v == null ? '' : v).trim();
  const BROADCAST_GAP_MS = deps.broadcastGapMs != null ? deps.broadcastGapMs : 2 * 60e3;
  let lastBroadcast = 0;
  const message = (b) => ({ title: s(b.title).replace(/[<>]/g, '').slice(0, 80), body: s(b.body).replace(/[<>]/g, '').slice(0, 240), url: s(b.url) || '/' });
  const badUrl = (u) => u && !/^\/[^\s<>"]*$/.test(u) && !/^https:\/\/[^\s<>"]+$/i.test(u);
  const summary = (r) => r.sent + ' of ' + r.devices + ' device(s) delivered' + (r.removed ? ', ' + r.removed + ' old removed' : '') + (r.failed ? ', ' + r.failed + ' failed' : '');

  app.get('/admin/api/push', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [settings, stats, key] = await Promise.all([reminders.getSettings(), push.stats(), push.publicKeyInfo().catch((e) => ({ ok: false, message: e.message }))]);
      res.json({ ok: true, settings, stats, publicKey: key.publicKey || '', needSchema: !!stats.needSchema, schemaMessage: stats.needSchema ? stats.message : '' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/push/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await reminders.saveSettings(req.body || {});
      if (!r.ok) return res.status(400).json(r);
      if (r.changed.length) audit.record(req, { action: 'push.settings', entity: 'settings', id: 'push_settings', summary: 'Notification settings changed: ' + r.changed.join(', ') + ' (automatic reminders ' + (r.settings.auto ? 'ON' : 'OFF') + ')' });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/push/subscribe', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const r = await push.subscribe({ subscription: b.subscription, userAgent: req.headers && req.headers['user-agent'], app: 'admin' });
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'push.adminSubscribe', entity: 'push', summary: 'Admin device switched on for notifications' });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/push/unsubscribe', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await push.unsubscribe((req.body || {}).endpoint, 'admin')); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/push/test', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await push.sendToAdmins({ title: '🔔 FluxFilm test notification', body: 'Notifications work on this device. ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), url: '/panel', tag: 'admin-test' });
      if (r.needSchema) return res.status(400).json(r);
      audit.record(req, { action: 'push.test', entity: 'push', summary: 'Test notification: ' + summary(r) });
      res.json(Object.assign(r, { message: r.devices ? summary(r) : 'No admin device yet — tap "Turn on for this device" first.' }));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/push/send', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {}; const m = message(b);
      if (!m.title) return res.status(400).json({ ok: false, message: 'Write a title.' });
      if (badUrl(m.url)) return res.status(400).json({ ok: false, message: 'The link must start with / or https://' });
      const r = await push.sendToPhone(b.phone, m);
      if (r.message && !r.devices) return res.status(400).json(r);
      audit.record(req, { action: 'push.send', entity: 'customer', id: s(b.phone).replace(/\D/g, '').slice(-10), summary: 'Notification "' + m.title + '": ' + summary(r), details: m });
      res.json(Object.assign(r, { message: r.devices ? summary(r) : 'This customer has not switched on notifications.' }));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/push/broadcast', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {}; const m = message(b);
      if (b.confirm !== true) return res.status(400).json({ ok: false, message: 'Please confirm the broadcast.' });
      if (!m.title || !m.body) return res.status(400).json({ ok: false, message: 'Write a title and a message.' });
      if (badUrl(m.url)) return res.status(400).json({ ok: false, message: 'The link must start with / or https://' });
      const wait = lastBroadcast + BROADCAST_GAP_MS - Date.now();
      if (wait > 0) return res.status(429).json({ ok: false, message: 'A broadcast was just sent — please wait ' + Math.ceil(wait / 1000) + ' seconds.' });
      lastBroadcast = Date.now();
      const r = await push.broadcast(Object.assign({ tag: 'broadcast' }, m), { concurrency: 10 });
      if (r.needSchema) { lastBroadcast = 0; return res.status(400).json(r); }
      audit.record(req, { action: 'push.broadcast', entity: 'push', id: r.phones + ' customers', summary: 'Broadcast "' + m.title + '" to ' + r.phones + ' customer(s): ' + summary(r), details: m });
      res.json(Object.assign(r, { message: 'Sent to ' + r.phones + ' customer(s) — ' + summary(r) }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
