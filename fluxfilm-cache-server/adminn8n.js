/**
 * FluxFilm - admin → 🔗 Integrations → n8n (admin-only; mounted by admin.js). Settings live in app_settings (n8n.js).
 *
 *   GET  /admin/api/n8n                     status: key (prefix, created, last used), webhook URL + switches, secret set?,
 *                                           backup passphrase set?, win-back coupon settings, last 20 webhook deliveries
 *   POST /admin/api/n8n/key                 { action: 'generate' | 'revoke' }   → generate shows the key ONCE
 *   POST /admin/api/n8n/settings            { webhookUrl, events: { 'order.paid': true, … }, winback: { WB15: {…} } }
 *   POST /admin/api/n8n/secret              → a new webhook signing secret, shown ONCE
 *   POST /admin/api/n8n/passphrase          { passphrase } | { clear: true }   (only "set" / "not set" is ever shown)
 *   POST /admin/api/n8n/test-webhook        → one signed test.ping to <webhook URL>/test-ping, answers the HTTP status
 * Every change is in the change log (never the key / secret / passphrase itself).
 */
const crypto = require('crypto');

function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const n8n = deps.n8n || require('./n8n');
  const backup = deps.backup || require('./n8nbackup');
  const hooks = deps.hooks || require('./n8nhooks');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  async function view() {
    const [st, sec, pass, log] = await Promise.all([n8n.getSettings(true), n8n.getSecrets(), backup.passphraseInfo(), hooks.deliveries().catch(() => [])]);
    const site = String(process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
    return {
      ok: true, site,
      key: n8n.publicKeyInfo(st.key),
      webhookUrl: st.webhookUrl || '', events: st.events, eventList: n8n.EVENTS, secretSet: !!sec.webhookSecret, secretCreatedAt: sec.webhookSecretAt || '',
      backup: pass, winback: st.winback, deliveries: log, hooks: hooks.status(),
      endpoints: ['GET /n8n/api/expiring', 'POST /n8n/api/reminder-sent', 'GET /n8n/api/winback', 'POST /n8n/api/winback-sent', 'GET /n8n/api/posts/new', 'GET /n8n/api/health', 'GET /n8n/api/backup', 'GET /n8n/api/backup/tables'],
    };
  }

  app.get('/admin/api/n8n', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await view()); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/n8n/key', async (req, res) => {
    if (!auth(req, res)) return;
    const action = String((req.body || {}).action || '');
    try {
      if (action === 'generate') {
        const had = !!(await n8n.getSettings(true)).key;
        const r = await n8n.generateKey();
        audit.record(req, { action: had ? 'n8n.key.rotate' : 'n8n.key.create', entity: 'n8n', id: r.info.prefix, summary: (had ? 'n8n API key rotated (old key stops working now)' : 'n8n API key created') + ' · ' + r.info.prefix + '…' });
        return res.json({ ok: true, key: r.key, info: r.info, rotated: had });
      }
      if (action === 'revoke') {
        const r = await n8n.revokeKey();
        audit.record(req, { action: 'n8n.key.revoke', entity: 'n8n', summary: r.revoked ? 'n8n API key revoked' : 'n8n API key revoke (none was set)' });
        return res.json({ ok: true, revoked: r.revoked });
      }
      res.status(400).json({ ok: false, message: 'action must be generate or revoke.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/n8n/settings', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const st = await n8n.getSettings(true);
      const changed = [];
      if (b.webhookUrl !== undefined) {
        const v = n8n.validateWebhookUrl(b.webhookUrl);
        if (!v.ok) return res.status(400).json(v);
        if (v.url !== st.webhookUrl) { st.webhookUrl = v.url; changed.push('webhook URL'); }
      }
      if (b.events && typeof b.events === 'object') {
        for (const ev of n8n.EVENTS) if (b.events[ev] !== undefined) { const on = b.events[ev] === true || b.events[ev] === 'true'; if (on !== st.events[ev]) { st.events[ev] = on; changed.push(ev + (on ? ' on' : ' off')); } }
      }
      if (b.winback && typeof b.winback === 'object') {
        const v = n8n.validateWinback(b.winback, st.winback);
        if (!v.ok) return res.status(400).json({ ok: false, message: v.errors.join(' '), errors: v.errors });
        if (JSON.stringify(v.winback) !== JSON.stringify(st.winback)) { st.winback = v.winback; changed.push('win-back coupons'); }
      }
      await n8n.saveSettingsRaw(st);
      if (changed.length) audit.record(req, { action: 'n8n.settings', entity: 'n8n', summary: 'n8n settings: ' + changed.join(', '), details: { webhookUrl: st.webhookUrl, events: st.events, winback: st.winback } });
      res.json(Object.assign(await view(), { changed }));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/n8n/secret', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const sec = await n8n.getSecrets();
      const had = !!sec.webhookSecret;
      const secret = 'ffwh_' + crypto.randomBytes(32).toString('base64url');
      sec.webhookSecret = secret; sec.webhookSecretAt = new Date().toISOString();
      await n8n.saveSecrets(sec);
      audit.record(req, { action: had ? 'n8n.secret.rotate' : 'n8n.secret.create', entity: 'n8n', summary: had ? 'Webhook signing secret rotated (update it in n8n)' : 'Webhook signing secret created' });
      res.json({ ok: true, secret, rotated: had });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/n8n/passphrase', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      if (b.clear === true) {
        const r = await backup.clearPassphrase();
        audit.record(req, { action: 'n8n.backup.passphrase.clear', entity: 'n8n', summary: 'Backup passphrase removed (backups are refused until a new one is set)' });
        return res.json({ ok: true, cleared: r.cleared, backup: await backup.passphraseInfo() });
      }
      const r = await backup.setPassphrase(b.passphrase);
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'n8n.backup.passphrase.set', entity: 'n8n', summary: 'Backup passphrase set (check ' + r.check + ')' });
      res.json({ ok: true, backup: await backup.passphraseInfo() });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/n8n/test-webhook', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const st = await n8n.getSettings(true);
      if (!st.webhookUrl) return res.status(400).json({ ok: false, message: 'Save your n8n webhook URL first.' });
      const sec = await n8n.getSecrets();
      if (!sec.webhookSecret) return res.status(400).json({ ok: false, message: 'Create the webhook signing secret first.' });
      const r = await hooks.sendTest();
      audit.record(req, { action: 'n8n.webhook.test', entity: 'n8n', summary: 'Test webhook → ' + (r.ok ? 'HTTP ' + r.status : 'failed: ' + (r.error || r.skipped || 'HTTP ' + r.status)) });
      res.json(Object.assign({ url: hooks.eventUrl(st.webhookUrl, 'test.ping') }, r, { deliveries: await hooks.deliveries() }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
