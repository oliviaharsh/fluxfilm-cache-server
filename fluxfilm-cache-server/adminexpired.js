/**
 * FluxFilm - admin "🚪 Expired customers still on accounts" + one-tap cleanup (admin-only, mounted by admin.js).
 *
 *   GET  /admin/api/remove-users                  the Sheet rule per account login (expiredusers.js) + counts
 *                                                 (customers, accounts, safeAccounts, safeUsers, other). Alias: /expired-users
 *   POST /admin/api/remove-users/removed          { subIds, label }  "Remove all on this account" (ended rows only)
 *   GET  /admin/api/order/subs-removed?id=FF…     how many of this order's subscriptions can be ticked removed
 *   POST /admin/api/order/subs-removed            { orderId, includeActive }  tick them all removed (removed_at = now)
 *
 * The bulk tick is exactly POST /admin/api/sub-removed for every subscription of the order: removed = 1,
 * removed_at = NOW(), raw_json RemovedFromDevice = TRUE (kept in step), already-removed rows are skipped.
 * Subscriptions that are still running are skipped unless includeActive is true (ticking a paying customer
 * "removed" changes how their renewal days are counted).
 * Written for test order FF0215802 (one ₹39 order → 54 Prime subscriptions in July staging) and the owner's
 * own test buys, which inflated the "expired, not removed" numbers.
 */
const s = (v) => String(v == null ? '' : v).trim();

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const expired = () => deps.expiredusers || require('./expiredusers');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const RUNNING = "UPPER(COALESCE(status, '')) = 'ACTIVE' AND expiry_date > NOW()";

  // The ONE list behind Today's 🚪 card, the 🚪 Remove users screen and Stock's per-account badge.
  const removeUsers = async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const E = expired();
      const r = await E.load((sql, p) => db.query(sql, p));
      res.json(Object.assign({ ok: true, counts: E.summarize(r) }, r));
    } catch (e) { fail(res, e); }
  };
  app.get('/admin/api/remove-users', removeUsers);
  app.get('/admin/api/expired-users', removeUsers); // older name, same answer

  // "Remove all on this account": tick several ended subscriptions removed at once (removed_at = now).
  // Same write as POST /admin/api/sub-removed; running subscriptions and already-removed rows are never touched.
  app.post('/admin/api/remove-users/removed', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const ids = [...new Set((Array.isArray(b.subIds) ? b.subIds : []).map(s).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ ok: false, message: 'Pick at least one subscription.' });
    if (ids.length > 100) return res.status(400).json({ ok: false, message: 'At most 100 at a time.' });
    const label = s(b.label).slice(0, 80);
    try {
      const r = await db.query(
        "UPDATE subscriptions SET removed = 1, removed_at = NOW(), raw_json = IF(raw_json IS NULL OR JSON_VALID(raw_json) = 0, raw_json, JSON_SET(raw_json, '$.RemovedFromDevice', 'TRUE')) " +
        'WHERE sub_id IN (' + ids.map(() => '?').join(', ') + ') AND COALESCE(removed, 0) = 0 AND NOT (' + RUNNING + ')', ids);
      const marked = (r && r.affectedRows) || 0;
      if (marked) audit.record(req, { action: 'sub.removedBulk', entity: 'account', id: label || ids[0], summary: 'Ticked ' + marked + ' expired customer(s) removed' + (label ? ' from ' + label : '') + (marked < ids.length ? ' · ' + (ids.length - marked) + ' skipped (running or already removed)' : ''), details: { subIds: ids } });
      res.json({ ok: true, marked, skipped: ids.length - marked, message: marked ? '🚪 ' + marked + ' customer' + (marked === 1 ? '' : 's') + ' ticked removed.' + (marked < ids.length ? ' ' + (ids.length - marked) + ' skipped.' : '') : 'Nothing ticked (already removed or still running).' });
    } catch (e) { fail(res, e); }
  });

  async function summary(orderId) {
    const rows = await db.query(
      'SELECT COUNT(*) total, SUM(COALESCE(removed, 0) = 1) already, SUM(COALESCE(removed, 0) = 0 AND ' + RUNNING + ') running, SUM(COALESCE(removed, 0) = 0 AND NOT (' + RUNNING + ')) ended FROM subscriptions WHERE order_id = ?', [orderId]);
    const x = (rows && rows[0]) || {};
    return { total: Number(x.total) || 0, alreadyRemoved: Number(x.already) || 0, running: Number(x.running) || 0, ended: Number(x.ended) || 0 };
  }

  app.get('/admin/api/order/subs-removed', async (req, res) => {
    if (!auth(req, res)) return;
    const id = s(req.query.id).toUpperCase();
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try { res.json(Object.assign({ ok: true, orderId: id }, await summary(id))); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/order/subs-removed', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = s(b.orderId).toUpperCase();
    const includeActive = b.includeActive === true || String(b.includeActive) === 'true';
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const before = await summary(id);
      if (!before.total) return res.status(404).json({ ok: false, message: 'Order ' + id + ' has no subscriptions.' });
      const r = await db.query(
        "UPDATE subscriptions SET removed = 1, removed_at = NOW(), raw_json = IF(raw_json IS NULL OR JSON_VALID(raw_json) = 0, raw_json, JSON_SET(raw_json, '$.RemovedFromDevice', 'TRUE')) " +
        'WHERE order_id = ? AND COALESCE(removed, 0) = 0' + (includeActive ? '' : ' AND NOT (' + RUNNING + ')'), [id]);
      const marked = (r && r.affectedRows) || 0;
      const skippedRunning = includeActive ? 0 : before.running;
      if (marked) {
        audit.record(req, { action: 'sub.removedBulk', entity: 'order', id, summary: 'Ticked ' + marked + ' subscription(s) of ' + id + ' removed from their accounts' + (skippedRunning ? ' · ' + skippedRunning + ' still running, skipped' : '') + (before.alreadyRemoved ? ' · ' + before.alreadyRemoved + ' were already removed' : ''), details: Object.assign({ includeActive }, before) });
      }
      res.json({
        ok: true, orderId: id, marked, alreadyRemoved: before.alreadyRemoved, skippedRunning,
        message: marked ? '🚪 ' + marked + ' subscription' + (marked === 1 ? '' : 's') + ' ticked removed.' + (skippedRunning ? ' ' + skippedRunning + ' still running (not touched).' : '') : (skippedRunning ? 'Nothing ticked: the ' + skippedRunning + ' remaining subscription(s) are still running.' : 'Nothing to do — all already removed.'),
      });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
