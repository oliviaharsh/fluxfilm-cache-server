/**
 * FluxFilm - admin profit view + extend a subscription (admin-only).
 *
 *   GET  /admin/api/profit?period=this_month|last_month|30d|90d|365d
 *   POST /admin/api/profit/cost        { service, accountId, monthlyCost, note }   (account_costs, schema-v14)
 *   POST /admin/api/subs/extend        { subId, days, reason }                     (+/- days, change log)
 *
 * Revenue = paid orders in the period (by payment time), credited to the account the
 * order's subscription sits on (renewals: the renewed subscription). Cost = each
 * account's monthly cost × months in the period. Orders with no account (manual
 * services, undelivered) show as "No account".
 */
const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

// India-time calendar maths (DB dates are India time, stored without a zone).
function istParts(d) { const x = new Date(d.getTime() + 5.5 * 3600e3); return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() }; }
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m, d)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
function periodRange(period, now) {
  const p = istParts(now || new Date());
  const today = ymd(p.y, p.m, p.d);
  const tomorrow = ymd(p.y, p.m, p.d + 1);
  let from, to = tomorrow, label;
  switch (period) {
    case 'last_month': from = ymd(p.y, p.m - 1, 1); to = ymd(p.y, p.m, 1); label = 'Last month'; break;
    case '30d': from = ymd(p.y, p.m, p.d - 29); label = 'Last 30 days'; break;
    case '90d': from = ymd(p.y, p.m, p.d - 89); label = 'Last 90 days'; break;
    case '365d': from = ymd(p.y, p.m, p.d - 364); label = 'Last 12 months'; break;
    default: period = 'this_month'; from = ymd(p.y, p.m, 1); label = 'This month';
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  return { period, from: from + ' 00:00:00', to: to + ' 00:00:00', days, months: days / 30.4375, label, today };
}

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const fail = (res, e) => res.status(missingTable(e) ? 409 : 500).json({ ok: false, needsSchema: missingTable(e), message: missingTable(e) ? 'Run db/schema-v14.sql in phpMyAdmin first.' : String((e && e.message) || e) });

  app.get('/admin/api/profit', async (req, res) => {
    if (!auth(req, res)) return;
    const range = periodRange(s(req.query.period));
    try {
      const [orders, accounts, occ, trend] = await Promise.all([
        db.query(
          'SELECT o.order_id, o.service, o.final_amount, o.order_type, COALESCE(s1.inventory_ref, s2.inventory_ref) AS ref ' +
          'FROM orders o LEFT JOIN subscriptions s1 ON s1.order_id = o.order_id LEFT JOIN subscriptions s2 ON s2.sub_id = o.renew_sub_id ' +
          "WHERE UPPER(o.status) = 'PAID' AND COALESCE(o.verified_at, o.created_at_sheet) >= ? AND COALESCE(o.verified_at, o.created_at_sheet) < ?", [range.from, range.to]),
        db.query('SELECT service, account_id, login_id, is_active FROM inventory_accounts ORDER BY service, account_id', []),
        db.query("SELECT inventory_ref, COUNT(*) n FROM subscriptions WHERE UPPER(status) = 'ACTIVE' AND expiry_date > NOW() GROUP BY inventory_ref", []),
        db.query("SELECT DATE_FORMAT(COALESCE(verified_at, created_at_sheet), '%Y-%m') ym, SUM(final_amount) revenue, COUNT(*) n, SUM(UPPER(COALESCE(order_type, '')) = 'RENEW') renewals FROM orders WHERE UPPER(status) = 'PAID' AND COALESCE(verified_at, created_at_sheet) >= DATE_FORMAT(NOW() - INTERVAL 5 MONTH, '%Y-%m-01') GROUP BY ym ORDER BY ym", []),
      ]);
      let costs = []; let costsReady = true;
      try { costs = await db.query('SELECT service, account_id, monthly_cost, note FROM account_costs', []); } catch (e) { if (!missingTable(e)) throw e; costsReady = false; }

      const costOf = new Map(costs.map((c) => [s(c.service) + '|' + s(c.account_id), c]));
      const active = new Map();
      for (const o of occ) { const a = s(o.inventory_ref).split('#')[0]; if (a) active.set(a, (active.get(a) || 0) + num(o.n)); }

      // Revenue per account (by id; ids are unique enough across services in practice, service family breaks ties).
      const revByAcc = new Map(); const noAccount = { revenue: 0, orders: 0 };
      const bySvc = new Map();
      const svcRow = (fam) => { if (!bySvc.has(fam)) bySvc.set(fam, { family: fam, services: new Set(), revenue: 0, orders: 0, renewals: 0, cost: 0, accounts: 0, accountsWithoutCost: 0 }); return bySvc.get(fam); };
      let revenue = 0, orderCount = 0, renewals = 0;
      for (const o of orders) {
        const amt = num(o.final_amount); revenue += amt; orderCount++;
        const isRenew = s(o.order_type).toUpperCase() === 'RENEW'; if (isRenew) renewals++;
        const sv = svcRow(family(o.service)); sv.services.add(s(o.service)); sv.revenue += amt; sv.orders++; if (isRenew) sv.renewals++;
        const acc = s(o.ref).split('#')[0];
        if (!acc) { noAccount.revenue += amt; noAccount.orders++; continue; }
        const key = family(o.service) + '|' + acc;
        const cur = revByAcc.get(key) || { revenue: 0, orders: 0 }; cur.revenue += amt; cur.orders++; revByAcc.set(key, cur);
      }

      let cost = 0;
      const accRows = accounts.map((a) => {
        const fam = family(a.service);
        const c = costOf.get(s(a.service) + '|' + s(a.account_id));
        const monthly = c ? num(c.monthly_cost) : null;
        const periodCost = monthly != null ? monthly * range.months : 0;
        const rv = revByAcc.get(fam + '|' + s(a.account_id)) || { revenue: 0, orders: 0 };
        revByAcc.delete(fam + '|' + s(a.account_id));
        const sv = svcRow(fam); sv.services.add(s(a.service)); sv.accounts++; sv.cost += periodCost; if (monthly == null && s(a.is_active).toUpperCase() === 'TRUE') sv.accountsWithoutCost++;
        cost += periodCost;
        return { service: s(a.service), accountId: s(a.account_id), login: s(a.login_id), isActive: s(a.is_active).toUpperCase() === 'TRUE', activeCustomers: active.get(s(a.account_id)) || 0,
          monthlyCost: monthly, note: c ? s(c.note) : '', revenue: r2(rv.revenue), orders: rv.orders, cost: r2(periodCost), profit: r2(rv.revenue - periodCost) };
      });
      // Revenue on accounts that are no longer in inventory (deleted / renamed).
      for (const [key, rv] of revByAcc) { noAccount.revenue += rv.revenue; noAccount.orders += rv.orders; }

      res.json({
        ok: true, range, costsReady,
        totals: { revenue: r2(revenue), cost: r2(cost), profit: r2(revenue - cost), margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null, orders: orderCount, renewals, newOrders: orderCount - renewals, accountsWithoutCost: accRows.filter((a) => a.isActive && a.monthlyCost == null).length },
        services: [...bySvc.values()].map((x) => ({ family: x.family, services: [...x.services].sort(), revenue: r2(x.revenue), orders: x.orders, renewals: x.renewals, cost: r2(x.cost), profit: r2(x.revenue - x.cost), accounts: x.accounts, accountsWithoutCost: x.accountsWithoutCost })).sort((a, b) => b.revenue - a.revenue),
        accounts: accRows,
        noAccount: { revenue: r2(noAccount.revenue), orders: noAccount.orders },
        trend: trend.map((t) => ({ month: s(t.ym), revenue: r2(num(t.revenue)), orders: num(t.n), renewals: num(t.renewals) })),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/profit/cost', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const service = s(b.service), accountId = s(b.accountId);
    if (!service || !accountId) return res.status(400).json({ ok: false, message: 'Account required.' });
    const raw = s(b.monthlyCost);
    if (raw === '') {
      try { await db.query('DELETE FROM account_costs WHERE service = ? AND account_id = ?', [service, accountId]); audit.record(req, { action: 'cost.clear', entity: 'account', id: accountId, summary: service + ': monthly cost cleared' }); return res.json({ ok: true, cleared: true }); } catch (e) { return fail(res, e); }
    }
    const cost = Number(raw);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1e6) return res.status(400).json({ ok: false, message: 'Monthly cost must be a number.' });
    try {
      await db.query('INSERT INTO account_costs (service, account_id, monthly_cost, note) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE monthly_cost = VALUES(monthly_cost), note = VALUES(note)', [service, accountId, r2(cost), s(b.note).slice(0, 300) || null]);
      audit.record(req, { action: 'cost.save', entity: 'account', id: accountId, summary: service + ': ₹' + r2(cost) + ' / month' + (s(b.note) ? ' · ' + s(b.note) : '') });
      res.json({ ok: true, monthlyCost: r2(cost) });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/subs/extend', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const subId = s(b.subId); const days = Number(b.days); const reason = s(b.reason).slice(0, 200);
    if (!subId) return res.status(400).json({ ok: false, message: 'Subscription required.' });
    if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 365) return res.status(400).json({ ok: false, message: 'Days must be a whole number between -365 and 365 (not 0).' });
    if (!reason) return res.status(400).json({ ok: false, message: 'Write a short reason (it goes in the change log).' });
    try {
      const before = (await db.query('SELECT sub_id, phone_norm, service, plan, expiry_date, release_eligible_at, status FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]))[0];
      if (!before) return res.status(404).json({ ok: false, message: 'Subscription not found.' });
      if (!before.expiry_date) return res.status(400).json({ ok: false, message: 'This subscription has no expiry date to extend.' });
      // MySQL applies SET left to right: release date first (from the OLD expiry), then expiry;
      // status / new_expiry / raw_json then see the NEW expiry.
      await db.query(
        'UPDATE subscriptions SET release_eligible_at = DATE_ADD(COALESCE(release_eligible_at, expiry_date), INTERVAL ? DAY), ' +
        'expiry_date = DATE_ADD(expiry_date, INTERVAL ? DAY), new_expiry = expiry_date, ' +
        "status = IF(expiry_date > NOW() AND UPPER(COALESCE(status, '')) IN ('EXPIRED', ''), 'ACTIVE', status), " +
        "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.ExpiryDate', DATE_FORMAT(expiry_date, '%Y-%m-%d %H:%i:%s'))) WHERE sub_id = ? LIMIT 1",
        [days, days, subId]);
      const after = (await db.query('SELECT sub_id, expiry_date, release_eligible_at, status FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]))[0] || {};
      audit.record(req, { action: days > 0 ? 'sub.extend' : 'sub.shorten', entity: 'subscription', id: subId, summary: (days > 0 ? '+' : '') + days + ' day(s) · ' + s(before.service) + ' ' + s(before.plan) + ' · ' + s(before.expiry_date) + ' → ' + s(after.expiry_date) + ' · ' + reason, details: { before, after, reason } });
      res.json({ ok: true, subId, days, before: { expiry: before.expiry_date, status: before.status }, after: { expiry: after.expiry_date, status: after.status } });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, periodRange, family };
