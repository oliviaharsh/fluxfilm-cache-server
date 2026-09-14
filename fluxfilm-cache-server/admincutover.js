/**
 * FluxFilm - admin 🚚 Go-live import (admin-only). See cutover.js for exactly what is copied.
 *
 *   POST /admin/api/cutover/preview   { wallet? }   → starts a preview in the background (writes nothing)
 *   POST /admin/api/cutover/run       { wallet?, confirm: 'IMPORT' }  → starts the import (new orders must be paused)
 *   GET  /admin/api/cutover/status    → { state: idle|running|done|failed, kind, result, error }
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const cutover = deps.cutover || require('./cutover');
  const store = deps.store || require('./store');
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
}

module.exports = { mount };
