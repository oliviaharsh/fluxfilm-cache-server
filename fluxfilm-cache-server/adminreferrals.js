/**
 * FluxFilm - admin 🎁 Referrals screen (admin-only).
 *
 *   GET  /admin/api/referrals/settings    → { settings, defaults, needsSchema }
 *   POST /admin/api/referrals/settings    { ...settings }   (validated, saved to app_settings, change log)
 *   GET  /admin/api/referrals/overview    → totals, this month, problems (FAILED / stuck PENDING), recent rewards, top referrers
 *   POST /admin/api/referrals/reconcile   { days }          → pays FAILED/stuck rewards + checks missed paid orders
 */
const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const referrals = deps.referrals || require('./referrals');
  const needsSchema = (res) => res.status(409).json({ ok: false, needsSchema: true, message: 'Run db/schema-v15.sql in phpMyAdmin first.' });

  app.get('/admin/api/referrals/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      let ready = true;
      try { await db.query('SELECT 1 FROM app_settings LIMIT 1', []); } catch (e) { if (!missingTable(e)) throw e; ready = false; }
      const cfg = await referrals.getSettings(true);
      const settings = {}; for (const k of Object.keys(referrals.DEFAULTS)) settings[k] = cfg[k];
      // Example coins for common prices so the owner sees what a setting means.
      const examples = [39, 99, 169, 499, 1849].map((amt) => ({
        amount: amt,
        first: referrals.coinsFor(amt, cfg.firstPercent, cfg.firstMin, cfg.firstMax),
        repeat: referrals.coinsFor(amt, cfg.repeatPercent, cfg.repeatMin, cfg.repeatMax),
        level2: cfg.level2Enabled ? referrals.coinsFor(amt, cfg.level2Percent, cfg.level2Min, cfg.level2Max) : 0,
      }));
      res.json({ ok: true, settings, defaults: referrals.DEFAULTS, examples, needsSchema: !ready });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/referrals/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const before = await referrals.getSettings(true);
      const r = await referrals.saveSettings(req.body || {});
      if (!r.ok) return r.needsSchema ? needsSchema(res) : res.status(400).json(r);
      const changed = Object.keys(r.settings).filter((k) => String(before[k]) !== String(r.settings[k]));
      audit.record(req, { action: 'referral.settings', entity: 'settings', id: 'referral', summary: changed.length ? 'Changed: ' + changed.map((k) => k + ' ' + before[k] + ' → ' + r.settings[k]).join(', ') : 'Saved (no changes)', details: { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, r.settings[k]])) } });
      res.json({ ok: true, settings: r.settings, changed });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.get('/admin/api/referrals/overview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [links, rewards, month, problems, recent, top] = await Promise.all([
        db.query('SELECT status, COUNT(*) n FROM referrals GROUP BY status', []),
        db.query("SELECT kind, status, COUNT(*) n, COALESCE(SUM(coins), 0) coins FROM referral_rewards WHERE kind <> 'NONE' GROUP BY kind, status", []),
        db.query("SELECT COUNT(*) n, COALESCE(SUM(coins), 0) coins FROM referral_rewards WHERE status = 'PAID' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')", []),
        db.query("SELECT rr.order_id, rr.kind, rr.coins, rr.status, rr.reason, rr.created_at, rr.beneficiary_phone, rr.friend_phone, c.name FROM referral_rewards rr LEFT JOIN customers c ON c.phone_norm = rr.beneficiary_phone " +
          "WHERE rr.status = 'FAILED' OR (rr.status = 'PENDING' AND rr.created_at < NOW() - INTERVAL 5 MINUTE) ORDER BY rr.created_at DESC LIMIT 50", []),
        db.query("SELECT rr.order_id, rr.kind, rr.coins, rr.percent, rr.order_amount, rr.status, rr.reason, rr.created_at, rr.paid_at, rr.beneficiary_phone, rr.friend_phone, c.name beneficiary_name, f.name friend_name " +
          "FROM referral_rewards rr LEFT JOIN customers c ON c.phone_norm = rr.beneficiary_phone LEFT JOIN customers f ON f.phone_norm = rr.friend_phone WHERE rr.kind <> 'NONE' ORDER BY rr.created_at DESC LIMIT 40", []),
        db.query("SELECT rr.beneficiary_phone phone, c.name, COUNT(DISTINCT rr.friend_phone) friends, COALESCE(SUM(rr.coins), 0) coins FROM referral_rewards rr LEFT JOIN customers c ON c.phone_norm = rr.beneficiary_phone " +
          "WHERE rr.status = 'PAID' GROUP BY rr.beneficiary_phone, c.name ORDER BY coins DESC LIMIT 10", []),
      ]);
      const count = (st) => num((links.find((x) => s(x.status).toUpperCase() === st) || {}).n);
      const paid = rewards.filter((x) => s(x.status).toUpperCase() === 'PAID');
      res.json({
        ok: true,
        invited: links.reduce((a, x) => a + num(x.n), 0), waiting: count('PENDING'), joined: count('REWARDED') + count('CAPPED'), notNew: count('NOT_NEW'),
        coinsPaid: paid.reduce((a, x) => a + num(x.coins), 0),
        byKind: ['FIRST', 'REPEAT', 'LEVEL2'].map((k) => ({ kind: k, rewards: paid.filter((x) => x.kind === k).reduce((a, x) => a + num(x.n), 0), coins: paid.filter((x) => x.kind === k).reduce((a, x) => a + num(x.coins), 0) })),
        month: { rewards: num((month[0] || {}).n), coins: num((month[0] || {}).coins) },
        problems, recent, top,
      });
    } catch (e) {
      if (missingTable(e)) return res.json({ ok: true, needsSchema: true, invited: 0, waiting: 0, joined: 0, notNew: 0, coinsPaid: 0, byKind: [], month: { rewards: 0, coins: 0 }, problems: [], recent: [], top: [] });
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  app.post('/admin/api/referrals/reconcile', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await referrals.reconcile({ days: (req.body || {}).days });
      if (!r.ok) return r.needsSchema ? needsSchema(res) : res.status(500).json(r);
      audit.record(req, { action: 'referral.reconcile', entity: 'referrals', id: 'all', summary: 'Fix missed rewards: ' + r.paid + ' paid, ' + r.failed + ' failed, ' + r.checkedOrders + ' orders checked' });
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
}

module.exports = { mount };
