/**
 * FluxFilm - admin profit view + extend a subscription (admin-only).
 *
 *   GET  /admin/api/profit?period=this_month|last_month|30d|90d|365d
 *   POST /admin/api/profit/cost        { service, accountId, cost, every, note }   (account_costs, schema-v14)
 *        every = months the cost covers: 1 (monthly, default), 3, 6 or 12 (yearly). Old { monthlyCost } still works.
 *   POST /admin/api/subs/extend        { subId, days, reason }                     (+/- days, change log)
 *
 * Cash in = paid orders in the period (by payment time), credited to the account the
 * order's subscription sits on (renewals: the renewed subscription).
 * Earned = each paid order spread evenly over the days it covers (duration_days, or
 * "3M"/"1Y" in the plan name), counting only the days inside the period - so a ₹499
 * 3-month plan adds ~₹5.5/day, not ₹499 to the month it was paid.
 * Cost = each account's monthly cost × months in the period. Profit = earned − cost. Orders with no account (manual
 * services, undelivered) show as "No account".
 */
const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
// The billing period is kept inside account_costs.note as "[billing:12:4800] user note" so no schema
// change is needed; monthly_cost always holds the monthly equivalent (4800 / 12 = 400).
const EVERY = [1, 3, 6, 12];
function parseBilling(note, monthly) {
  const m = s(note).match(/^\[billing:(\d+):([\d.]+)\]\s*/);
  if (m && EVERY.includes(Number(m[1]))) return { every: Number(m[1]), amount: num(m[2]), note: s(note).slice(m[0].length) };
  return { every: 1, amount: monthly, note: s(note) };
}
const DAY = 86400000;
// DB datetimes are India time without a zone (dateStrings: true).
const istMs = (v) => { const x = s(v); if (!x) return NaN; return Date.parse(x.replace(' ', 'T').slice(0, 19) + '+05:30'); };
function durationDays(o) {
  const d = Math.round(num(o.duration_days));
  if (d > 0) return d;
  const plan = s(o.plan);
  let m = plan.match(/(\d+)\s*(?:m|mo|month|months)\b/i); if (m) return Number(m[1]) * 30;
  m = plan.match(/(\d+)\s*(?:y|yr|year|years)\b/i); if (m) return Number(m[1]) * 365;
  if (/\b(?:year|annual|yearly)\b/i.test(plan)) return 365;
  if (/\bmonth(?:ly)?\b/i.test(plan)) return 30;
  return 0;
}
// { cash, earned, ahead, inPeriod } for one order within [fromMs, toMs).
function orderSplit(o, fromMs, toMs) {
  const amt = num(o.final_amount); const paid = istMs(o.paid_at);
  const inPeriod = paid >= fromMs && paid < toMs;
  const cash = inPeriod ? amt : 0;
  const dur = durationDays(o);
  if (!dur || isNaN(paid)) return { cash, earned: cash, ahead: 0, inPeriod };
  const end = paid + dur * DAY;
  const earned = amt * Math.max(0, Math.min(toMs, end) - Math.max(fromMs, paid)) / (dur * DAY);
  const ahead = inPeriod ? amt * Math.max(0, end - Math.max(toMs, paid)) / (dur * DAY) : 0;
  return { cash, earned, ahead, inPeriod };
}
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
          'SELECT o.order_id, o.service, o.plan, o.duration_days, o.final_amount, o.order_type, COALESCE(o.verified_at, o.created_at_sheet) AS paid_at, COALESCE(s1.inventory_ref, s2.inventory_ref) AS ref ' +
          'FROM orders o LEFT JOIN subscriptions s1 ON s1.order_id = o.order_id LEFT JOIN subscriptions s2 ON s2.sub_id = o.renew_sub_id ' +
          // Also orders paid up to ~13 months before the period: a yearly plan bought last year still earns now.
          "WHERE UPPER(o.status) = 'PAID' AND COALESCE(o.verified_at, o.created_at_sheet) >= DATE_SUB(?, INTERVAL 400 DAY) AND COALESCE(o.verified_at, o.created_at_sheet) < ?", [range.from, range.to]),
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
      const revByAcc = new Map(); const noAccount = { revenue: 0, earned: 0, orders: 0 };
      const bySvc = new Map();
      const svcRow = (fam) => { if (!bySvc.has(fam)) bySvc.set(fam, { family: fam, services: new Set(), revenue: 0, earned: 0, orders: 0, renewals: 0, cost: 0, accounts: 0, accountsWithoutCost: 0 }); return bySvc.get(fam); };
      let revenue = 0, earnedTotal = 0, ahead = 0, orderCount = 0, renewals = 0;
      const fromMs = istMs(range.from), toMs = istMs(range.to);
      const seenOrders = new Set();
      for (const o of orders) {
        // One order joined to several subscriptions (F1 separate logins: one row per login) is counted once.
        if (o.order_id != null && seenOrders.has(o.order_id)) continue;
        seenOrders.add(o.order_id);
        const x = orderSplit(o, fromMs, toMs);
        if (!x.inPeriod && x.earned <= 0) continue;
        const amt = x.cash; const n = x.inPeriod ? 1 : 0;
        revenue += amt; earnedTotal += x.earned; ahead += x.ahead; orderCount += n;
        const isRenew = n && s(o.order_type).toUpperCase() === 'RENEW'; if (isRenew) renewals++;
        const sv = svcRow(family(o.service)); sv.services.add(s(o.service)); sv.revenue += amt; sv.earned += x.earned; sv.orders += n; if (isRenew) sv.renewals++;
        const acc = s(o.ref).split('#')[0];
        if (!acc) { noAccount.revenue += amt; noAccount.earned += x.earned; noAccount.orders += n; continue; }
        const key = family(o.service) + '|' + acc;
        const cur = revByAcc.get(key) || { revenue: 0, earned: 0, orders: 0 }; cur.revenue += amt; cur.earned += x.earned; cur.orders += n; revByAcc.set(key, cur);
      }

      let cost = 0, monthlyTotal = 0;
      const accRows = accounts.map((a) => {
        const fam = family(a.service);
        const c = costOf.get(s(a.service) + '|' + s(a.account_id));
        const bill = c ? parseBilling(c.note, num(c.monthly_cost)) : null;
        const monthly = bill ? bill.amount / bill.every : null;
        const periodCost = monthly != null ? monthly * range.months : 0;
        if (monthly != null && s(a.is_active).toUpperCase() === 'TRUE') monthlyTotal += monthly;
        const rv = revByAcc.get(fam + '|' + s(a.account_id)) || { revenue: 0, earned: 0, orders: 0 };
        revByAcc.delete(fam + '|' + s(a.account_id));
        const sv = svcRow(fam); sv.services.add(s(a.service)); sv.accounts++; sv.cost += periodCost; if (monthly == null && s(a.is_active).toUpperCase() === 'TRUE') sv.accountsWithoutCost++;
        cost += periodCost;
        return { service: s(a.service), accountId: s(a.account_id), login: s(a.login_id), isActive: s(a.is_active).toUpperCase() === 'TRUE', activeCustomers: active.get(s(a.account_id)) || 0,
          monthlyCost: monthly == null ? null : r2(monthly), billedEvery: bill ? bill.every : 1, billedAmount: bill ? r2(bill.amount) : null, note: bill ? bill.note : '', revenue: r2(rv.revenue), earned: r2(rv.earned), orders: rv.orders, cost: r2(periodCost), profit: r2(rv.earned - periodCost) };
      });
      // Revenue on accounts that are no longer in inventory (deleted / renamed).
      for (const [key, rv] of revByAcc) { noAccount.revenue += rv.revenue; noAccount.earned += rv.earned; noAccount.orders += rv.orders; }

      // 💳 Credit renewals (status CREDIT) are not PAID, so none of the numbers above include them — shown as a label.
      let creditDue = null;
      try { const cr = await (deps.credit || require('./credit')).receivables((sql, p) => db.query(sql, p)); creditDue = { total: cr.total, count: cr.count }; } catch (_) { creditDue = null; }
      res.json({
        ok: true, range, costsReady, creditDue,
        totals: { revenue: r2(revenue), earned: r2(earnedTotal), paidAhead: r2(ahead), cost: r2(cost), monthlyCost: r2(monthlyTotal), profit: r2(earnedTotal - cost), margin: earnedTotal > 0 ? Math.round(((earnedTotal - cost) / earnedTotal) * 1000) / 10 : null, orders: orderCount, renewals, newOrders: orderCount - renewals, accountsWithoutCost: accRows.filter((a) => a.isActive && a.monthlyCost == null).length },
        services: [...bySvc.values()].map((x) => ({ family: x.family, services: [...x.services].sort(), revenue: r2(x.revenue), earned: r2(x.earned), orders: x.orders, renewals: x.renewals, cost: r2(x.cost), profit: r2(x.earned - x.cost), accounts: x.accounts, accountsWithoutCost: x.accountsWithoutCost })).sort((a, b) => b.revenue - a.revenue),
        accounts: accRows,
        noAccount: { revenue: r2(noAccount.revenue), earned: r2(noAccount.earned), orders: noAccount.orders },
        trend: trend.map((t) => ({ month: s(t.ym), revenue: r2(num(t.revenue)), orders: num(t.n), renewals: num(t.renewals) })),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/profit/cost', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const service = s(b.service), accountId = s(b.accountId);
    if (!service || !accountId) return res.status(400).json({ ok: false, message: 'Account required.' });
    const hasNew = b.cost !== undefined;
    const raw = s(hasNew ? b.cost : b.monthlyCost);
    const every = hasNew && b.every !== undefined ? Number(b.every) : 1;
    if (!EVERY.includes(every)) return res.status(400).json({ ok: false, message: 'Billing must be every 1, 3, 6 or 12 months.' });
    if (raw === '') {
      try { await db.query('DELETE FROM account_costs WHERE service = ? AND account_id = ?', [service, accountId]); audit.record(req, { action: 'cost.clear', entity: 'account', id: accountId, summary: service + ': monthly cost cleared' }); return res.json({ ok: true, cleared: true }); } catch (e) { return fail(res, e); }
    }
    const cost = Number(raw);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1e7) return res.status(400).json({ ok: false, message: 'Cost must be a number.' });
    const monthly = cost / every;
    const userNote = s(b.note).slice(0, 260);
    const note = (every === 1 ? userNote : '[billing:' + every + ':' + r2(cost) + '] ' + userNote).trim();
    const per = { 1: 'month', 3: '3 months', 6: '6 months', 12: 'year' }[every];
    try {
      await db.query('INSERT INTO account_costs (service, account_id, monthly_cost, note) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE monthly_cost = VALUES(monthly_cost), note = VALUES(note)', [service, accountId, r2(monthly), note || null]);
      audit.record(req, { action: 'cost.save', entity: 'account', id: accountId, summary: service + ': ₹' + r2(cost) + ' / ' + per + (every === 1 ? '' : ' (= ₹' + r2(monthly) + ' / month)') + (userNote ? ' · ' + userNote : '') });
      res.json({ ok: true, monthlyCost: r2(monthly), billedEvery: every, billedAmount: r2(cost) });
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

module.exports = { mount, periodRange, family, parseBilling, durationDays, orderSplit, istMs };
