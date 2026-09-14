/**
 * FluxFilm - admin 🚚 Go-live import (admin-only). See cutover.js for exactly what is copied.
 *
 *   POST /admin/api/cutover/preview   { wallet? }   → starts a preview in the background (writes nothing)
 *   POST /admin/api/cutover/run       { wallet?, confirm: 'IMPORT' }  → starts the import (new orders must be paused)
 *   GET  /admin/api/cutover/status    → { state: idle|running|done|failed, kind, result, error }
 *   POST /admin/api/cleanup/preview   → one-time ID / data cleanup preview (cleanup.js, writes nothing)
 *   POST /admin/api/cleanup/apply     { confirm: 'CLEANUP' }  → after the import, while paused; locks the import
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const cutover = deps.cutover || require('./cutover');
  const store = deps.store || require('./store');
  const cleanup = deps.cleanup || require('./cleanup');
  let lastRunAudited = null;

  app.post('/admin/api/cutover/preview', async (req, res) => {
    if (!auth(req, res)) return;
    res.json(cutover.start('preview', { wallet: (req.body || {}).wallet === true }));
  });

  app.post('/admin/api/cutover/run', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    if (b.confirm !== 'IMPORT') return res.status(400).json({ ok: false, message: 'Type IMPORT to confirm.' });
    const st = await store.getSettings(true).catch(() => ({ paused: false }));
    if (!st.paused) return res.status(409).json({ ok: false, needPause: true, message: 'Pause new orders first (🚧 Maintenance), so nothing is bought while the data is copied.' });
    // After the ID cleanup the Sheet's old Sub IDs no longer exist in MySQL: importing again would add them back.
    if (await cleanup.isDone()) return res.status(409).json({ ok: false, locked: true, message: 'The import is locked because the ID cleanup has already run (a new import would bring back the old IDs as duplicates).' });
    const r = cutover.start('run', { wallet: b.wallet === true });
    if (r.ok) audit.record(req, { action: 'cutover.run', entity: 'import', id: 'go', summary: 'Started go-live import from the Sheet' + (b.wallet ? ' (with coin balances)' : '') });
    res.status(r.ok ? 200 : 409).json(r);
  });

  app.get('/admin/api/cutover/status', (req, res) => {
    if (!auth(req, res)) return;
    const st = cutover.status();
    if (st.kind === 'run' && st.state === 'done' && st.result && lastRunAudited !== st.finishedAt) {
      lastRunAudited = st.finishedAt;
      const d = st.result.done || {};
      audit.record(req, { action: 'cutover.done', entity: 'import', id: 'go', summary: 'Go-live import finished: orders +' + ((d.orders || {}).added || 0) + ' / ~' + ((d.orders || {}).updated || 0) + ', subscriptions +' + ((d.subscriptions || {}).added || 0) + ' / ~' + ((d.subscriptions || {}).updated || 0) + ', customers +' + ((d.customers || {}).added || 0) });
    }
    res.json(st);
  });

  app.post('/admin/api/cleanup/preview', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await cleanup.preview()); } catch (e) { res.status(500).json({ ok: false, message: String((e && e.message) || e) }); }
  });

  app.post('/admin/api/cleanup/apply', async (req, res) => {
    if (!auth(req, res)) return;
    if ((req.body || {}).confirm !== 'CLEANUP') return res.status(400).json({ ok: false, message: 'Type CLEANUP to confirm.' });
    const st = await store.getSettings(true).catch(() => ({ paused: false }));
    if (!st.paused) return res.status(409).json({ ok: false, needPause: true, message: 'Pause new orders first (🚧 Maintenance).' });
    if (cutover.status().state === 'running') return res.status(409).json({ ok: false, message: 'Wait for the import to finish.' });
    try {
      const r = await cleanup.apply();
      if (!r.ok) return res.status(409).json(r);
      const c = r.counts;
      audit.record(req, { action: 'cleanup.apply', entity: 'data', id: 'id_cleanup', summary: 'ID cleanup: ' + c.subsRenamed + ' subscription IDs renamed (' + c.references + ' references), ' + c.ordersCreated + ' missing orders added, ' + c.customersCreated + ' customers added, ' + c.clutterExpired + ' test subscriptions expired' });
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, message: 'Nothing was changed (rolled back): ' + String((e && e.message) || e) }); }
  });
}

module.exports = { mount };
