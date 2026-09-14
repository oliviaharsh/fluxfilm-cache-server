/**
 * FluxFilm - admin 🪙 Coins screen (admin-only).
 *
 *   GET  /admin/api/coins/settings   → { settings, examples, needsSchema, spendsReady }
 *   POST /admin/api/coins/settings   { ...settings }            (validated, saved to app_settings, change log)
 *   GET  /admin/api/coins/overview   → coins in wallets, earned / spent this month, held now, top balances, recent history
 *   POST /admin/api/coins/adjust     { phone, delta, reason }   (add / remove coins by hand, change log)
 *   POST /admin/api/coins/maintain   → give back expired holds + settle paid orders now
 */
const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const coins = deps.coins || require('./coins');
  const has = async (table) => { try { await db.query('SELECT 1 FROM ' + table + ' LIMIT 1', []); return true; } catch (e) { if (missingTable(e)) return false; throw e; } };

  app.get('/admin/api/coins/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [settingsReady, spendsReady] = await Promise.all([has('app_settings'), has('coin_spends')]);
      const cfg = await coins.getSettings(true);
      const settings = {}; for (const k of Object.keys(coins.defaults())) settings[k] = cfg[k];
      const examples = [39, 99, 169, 499, 1849].map((amt) => ({ amount: amt, earnNew: coins.computeCoins('NEW_PURCHASE', amt, cfg), earnRenew: coins.computeCoins('RENEW', amt, cfg), spend: coins.spendAllowed(cfg, 100000, amt, 'NEW') }));
      res.json({ ok: true, settings, examples, needsSchema: !settingsReady, spendsReady });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/coins/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const before = await coins.getSettings(true);
      const r = await coins.saveSettings(req.body || {});
      if (!r.ok) return res.status(r.needsSchema ? 409 : 400).json(r);
      const changed = Object.keys(r.settings).filter((k) => String(before[k]) !== String(r.settings[k]));
      audit.record(req, { action: 'coins.settings', entity: 'settings', id: 'coins', summary: changed.length ? 'Changed: ' + changed.map((k) => k + ' ' + before[k] + ' → ' + r.settings[k]).join(', ') : 'Saved (no changes)', details: { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, r.settings[k]])) } });
      res.json({ ok: true, settings: r.settings, changed });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.get('/admin/api/coins/overview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [wallets, month, top, recent] = await Promise.all([
        db.query('SELECT COUNT(DISTINCT phone_norm) holders, COALESCE(SUM(coins_balance), 0) coins FROM wallet WHERE coins_balance > 0', []),
        db.query("SELECT COALESCE(SUM(CASE WHEN coins_delta > 0 AND event NOT IN ('SPEND_RELEASE') THEN coins_delta ELSE 0 END), 0) earned, COALESCE(SUM(CASE WHEN event IN ('SPEND') THEN -coins_delta WHEN event = 'SPEND_RELEASE' THEN -coins_delta ELSE 0 END), 0) spent FROM coins_ledger WHERE ts >= DATE_FORMAT(NOW(), '%Y-%m-01')", []),
        db.query('SELECT w.phone_norm phone, c.name, MAX(w.coins_balance) coins FROM wallet w LEFT JOIN customers c ON c.phone_norm = w.phone_norm WHERE w.coins_balance > 0 GROUP BY w.phone_norm, c.name ORDER BY coins DESC LIMIT 10', []),
        db.query('SELECT l.ts, l.event, l.order_id, l.phone_norm phone, c.name, l.coins_delta, l.balance_after, l.note FROM coins_ledger l LEFT JOIN customers c ON c.phone_norm = l.phone_norm ORDER BY l.id DESC LIMIT 40', []),
      ]);
      let held = { orders: 0, coins: 0, rupeesSpentMonth: 0 }; let spendsReady = true;
      try {
        const h = await db.query("SELECT COUNT(*) n, COALESCE(SUM(coins), 0) coins FROM coin_spends WHERE status = 'HELD'", []);
        const m = await db.query("SELECT COALESCE(SUM(rupees), 0) rupees FROM coin_spends WHERE status = 'SPENT' AND updated_at >= DATE_FORMAT(NOW(), '%Y-%m-01')", []);
        held = { orders: num((h[0] || {}).n), coins: num((h[0] || {}).coins), rupeesSpentMonth: num((m[0] || {}).rupees) };
      } catch (e) { if (!missingTable(e)) throw e; spendsReady = false; }
      res.json({ ok: true, spendsReady, holders: num((wallets[0] || {}).holders), coinsInWallets: num((wallets[0] || {}).coins), earnedMonth: num((month[0] || {}).earned), spentMonth: num((month[0] || {}).spent), held, top, recent });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/coins/adjust', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await coins.adjust({ phone: b.phone, delta: b.delta, reason: b.reason });
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: r.change > 0 ? 'coins.add' : 'coins.remove', entity: 'wallet', id: s(b.phone).replace(/\D/g, '').slice(-10), summary: (r.change > 0 ? '+' : '') + r.change + ' coins · balance ' + r.balanceAfter + ' · ' + s(b.reason) });
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/coins/maintain', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await coins.maintain()); } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
}

module.exports = { mount };
