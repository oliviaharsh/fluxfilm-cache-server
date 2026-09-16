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
 * Cost = each REAL LOGIN's monthly cost × months in the period, counted ONCE however many
 * inventory rows / AccountIDs / plans that login is listed under (accountgroups.js).
 * Profit = earned − cost. Orders with no account (manual services, undelivered) show as "No account".
 */
const AG = require('./accountgroups');
const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
// The billing period and the "stopped paying on" date are kept inside account_costs.note as
// "[billing:12:4800][stopped:2026-09-30] user note" so no schema change is needed; monthly_cost
// always holds the monthly equivalent (4800 / 12 = 400). See accountgroups.js.
const EVERY = AG.EVERY;
const parseBilling = AG.parseCostNote;
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

/**
 * The whole 💰 Profit page for one range { from, to ('YYYY-MM-DD 00:00:00', IST, to exclusive), months, … }.
 * Shared by GET /admin/api/profit and the 📈 business summaries (reports.js), so both show the same numbers.
 * deps { credit } optional.
 */
async function computeProfit(db, range, deps) {
  deps = deps || {};
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

      // One row per REAL LOGIN: Zee5 Z5-01 listed 4× (once per duration) and JioHotstar
      // JH-3M-02 / JH-6M-02 / JH-1Y-02 (one login, three ids) each become a single account,
      // so their cost is charged once instead of 4× / 3×.
      const { groups, byId } = AG.buildAccountGroups(accounts, costs, family);
      const groupOfRef = (svc, id) => byId.get(family(svc) + '|' + AG.normId(id)) || null;

      // Active customers belong to the login, not to the row: sum every id of the group.
      const activeById = new Map();
      for (const o of occ) { const a = AG.normId(s(o.inventory_ref).split('#')[0]); if (a) activeById.set(a, (activeById.get(a) || 0) + num(o.n)); }
      const activeOf = (g) => g.normIds.reduce((t, n) => t + (activeById.get(n) || 0), 0);

      // Revenue per login group.
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
        const g = acc ? groupOfRef(o.service, acc) : null;
        if (!g) { noAccount.revenue += amt; noAccount.earned += x.earned; noAccount.orders += n; continue; }
        const cur = revByAcc.get(g.key) || { revenue: 0, earned: 0, orders: 0 }; cur.revenue += amt; cur.earned += x.earned; cur.orders += n; revByAcc.set(g.key, cur);
      }

      let cost = 0, monthlyTotal = 0, stoppedCount = 0, dupCostGroups = 0, mergedLogins = 0, lowCostGroups = 0;
      const accRows = groups.map((g) => {
        const monthly = g.monthly;
        // "Stopped paying on <date>": the cost counts up to that date and not after it.
        const factor = AG.costFactor(g.stoppedOn, range);
        const periodCost = monthly != null ? monthly * range.months * factor : 0;
        const stillPaying = !g.stoppedOn || g.stoppedOn > range.today;
        if (monthly != null && g.isActive && stillPaying) monthlyTotal += monthly;
        if (g.stoppedOn) stoppedCount++;
        if (g.extraCostRows.length) dupCostGroups++;
        if (g.sameLogin || g.repeatedRows) mergedLogins++;
        if (g.lowCost) lowCostGroups++;
        const rv = revByAcc.get(g.key) || { revenue: 0, earned: 0, orders: 0 };
        revByAcc.delete(g.key);
        const customers = activeOf(g);
        const sv = svcRow(g.family); g.services.forEach((x) => sv.services.add(x)); sv.accounts++; sv.cost += periodCost; if (monthly == null && g.isActive) sv.accountsWithoutCost++;
        cost += periodCost;
        return {
          service: g.service, services: g.services, accountId: g.accountId, ids: g.ids, rows: g.rows,
          login: g.login, sameLogin: g.sameLogin, repeatedRows: g.repeatedRows,
          isActive: g.isActive, activeCustomers: customers,
          monthlyCost: monthly == null ? null : r2(monthly), billedEvery: g.cost ? g.cost.every : 1, billedAmount: g.cost ? r2(g.cost.amount) : null,
          note: g.cost ? g.cost.note : '', stoppedOn: g.stoppedOn || '', costCounted: monthly != null && factor > 0,
          costKey: g.costKey, extraCostRows: g.extraCostRows.map((c) => ({ service: c.service, accountId: c.accountId, amount: c.amount, every: c.every })),
          sharePerCustomer: monthly != null && customers > 0 ? r2(monthly / customers) : null,
          // What the rest of this service costs, whether this login looks too cheap next to it,
          // and which answer the 🔗 Merge dialog should pre-select (accountgroups.js).
          typical: g.typical, lowCost: !!g.lowCost, suggestion: g.suggestion, costRows: g.costRows.length,
          allCostRows: g.costRows.map((c) => ({ service: c.service, accountId: c.accountId, amount: c.amount, every: c.every, monthly: c.monthly })),
          // "Quiet": nobody on it and no money in this period - hidden behind the toggle, cost still counted.
          quiet: customers === 0 && rv.revenue === 0 && rv.earned === 0,
          revenue: r2(rv.revenue), earned: r2(rv.earned), orders: rv.orders, cost: r2(periodCost), profit: r2(rv.earned - periodCost),
        };
      });
      // Revenue on accounts that are no longer in inventory (deleted / renamed).
      for (const [key, rv] of revByAcc) { noAccount.revenue += rv.revenue; noAccount.earned += rv.earned; noAccount.orders += rv.orders; }
      const quietRows = accRows.filter((a) => a.quiet);

      // 💳 Credit renewals (status CREDIT) are not PAID, so none of the numbers above include them — shown as a label.
      let creditDue = null;
      try { const cr = await (deps.credit || require('./credit')).receivables((sql, p) => db.query(sql, p)); creditDue = { total: cr.total, count: cr.count }; } catch (_) { creditDue = null; }
      return ({
        ok: true, range, costsReady, creditDue,
        totals: { revenue: r2(revenue), earned: r2(earnedTotal), paidAhead: r2(ahead), cost: r2(cost), monthlyCost: r2(monthlyTotal), profit: r2(earnedTotal - cost), margin: earnedTotal > 0 ? Math.round(((earnedTotal - cost) / earnedTotal) * 1000) / 10 : null, orders: orderCount, renewals, newOrders: orderCount - renewals, accountsWithoutCost: accRows.filter((a) => a.isActive && a.monthlyCost == null).length,
          accounts: accRows.length, inventoryRows: accounts.length, mergedLogins, duplicateCostGroups: dupCostGroups, lowCostGroups, stoppedAccounts: stoppedCount,
          quietAccounts: quietRows.length, quietCost: r2(quietRows.reduce((t, a) => t + a.cost, 0)) },
        services: [...bySvc.values()].map((x) => ({ family: x.family, services: [...x.services].sort(), revenue: r2(x.revenue), earned: r2(x.earned), orders: x.orders, renewals: x.renewals, cost: r2(x.cost), profit: r2(x.earned - x.cost), accounts: x.accounts, accountsWithoutCost: x.accountsWithoutCost })).sort((a, b) => b.revenue - a.revenue),
        accounts: accRows,
        noAccount: { revenue: r2(noAccount.revenue), earned: r2(noAccount.earned), orders: noAccount.orders },
        trend: trend.map((t) => ({ month: s(t.ym), revenue: r2(num(t.revenue)), orders: num(t.n), renewals: num(t.renewals) })),
      });
}

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const fail = (res, e) => res.status(missingTable(e) ? 409 : 500).json({ ok: false, needsSchema: missingTable(e), message: missingTable(e) ? 'Run db/schema-v14.sql in phpMyAdmin first.' : String((e && e.message) || e) });

  app.get('/admin/api/profit', async (req, res) => {
    if (!auth(req, res)) return;
    const range = periodRange(s(req.query.period));
    try { res.json(await computeProfit(db, range, deps)); } catch (e) { fail(res, e); }
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
    let userNote = s(b.note).slice(0, 220);
    const per = { 1: 'month', 3: '3 months', 6: '6 months', 12: 'year' }[every];
    try {
      // Keep the "stopped paying on" date and the typed note unless this call changes them.
      let stoppedOn = s(b.stoppedOn);
      if (stoppedOn && !/^\d{4}-\d{2}-\d{2}$/.test(stoppedOn)) return res.status(400).json({ ok: false, message: 'Stopped date must be YYYY-MM-DD.' });
      if (b.stoppedOn === undefined || b.note === undefined) {
        const cur = await db.query('SELECT note FROM account_costs WHERE service = ? AND account_id = ? LIMIT 1', [service, accountId]);
        const old = cur && cur[0] ? AG.parseCostNote(cur[0].note, 0) : { stoppedOn: '', note: '' };
        if (b.stoppedOn === undefined) stoppedOn = old.stoppedOn;
        if (b.note === undefined) userNote = old.note;
      }
      const note = AG.buildCostNote(every, cost, stoppedOn, userNote);
      await db.query('INSERT INTO account_costs (service, account_id, monthly_cost, note) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE monthly_cost = VALUES(monthly_cost), note = VALUES(note)', [service, accountId, r2(monthly), note || null]);
      audit.record(req, { action: 'cost.save', entity: 'account', id: accountId, summary: service + ': ₹' + r2(cost) + ' / ' + per + (every === 1 ? '' : ' (= ₹' + r2(monthly) + ' / month)') + (stoppedOn ? ' · stopped paying ' + stoppedOn : '') + (userNote ? ' · ' + userNote : '') });
      res.json({ ok: true, monthlyCost: r2(monthly), billedEvery: every, billedAmount: r2(cost), stoppedOn });
    } catch (e) { fail(res, e); }
  });

  // "I stopped paying for this login on <date>" - the cost counts up to that date and not after it,
  // instead of the account quietly disappearing from the list with its cost still in the total.
  app.post('/admin/api/profit/cost/stopped', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const service = s(b.service), accountId = s(b.accountId), stoppedOn = s(b.stoppedOn);
    if (!service || !accountId) return res.status(400).json({ ok: false, message: 'Account required.' });
    if (stoppedOn && !/^\d{4}-\d{2}-\d{2}$/.test(stoppedOn)) return res.status(400).json({ ok: false, message: 'Stopped date must be YYYY-MM-DD.' });
    try {
      const cur = await db.query('SELECT monthly_cost, note FROM account_costs WHERE service = ? AND account_id = ? LIMIT 1', [service, accountId]);
      if (!cur || !cur[0]) return res.status(404).json({ ok: false, message: 'Enter a cost for this account first.' });
      const p = AG.parseCostNote(cur[0].note, cur[0].monthly_cost);
      const note = AG.buildCostNote(p.every, p.amount, stoppedOn, p.note);
      await db.query('UPDATE account_costs SET note = ? WHERE service = ? AND account_id = ? LIMIT 1', [note || null, service, accountId]);
      audit.record(req, { action: 'cost.stopped', entity: 'account', id: accountId, summary: service + ': ' + (stoppedOn ? 'stopped paying on ' + stoppedOn + ' — cost stops counting from that date' : 'still paying (stopped date removed)') });
      res.json({ ok: true, stoppedOn });
    } catch (e) { fail(res, e); }
  });

  // Several cost rows pointing at one real login. They can mean two OPPOSITE things, so the panel
  // asks which it is and sends the answer here:
  //   keep   - the same cost was typed on each row (duplicates)      -> keep one, delete the rest
  //   sum    - the real cost was divided across the rows             -> add them up onto the kept row
  //   manual - neither; the owner types what the login really costs  -> that amount on the kept row
  // JioHotstar 8076332049 is a "sum": 3 × ₹500/year is really one ₹1,500/year account.
  app.post('/admin/api/profit/cost/merge', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const keep = { service: s(b.service), accountId: s(b.accountId) };
    const drop = (Array.isArray(b.drop) ? b.drop : []).map((x) => ({ service: s(x && x.service), accountId: s(x && x.accountId) }))
      .filter((x) => x.service && x.accountId && !(x.service === keep.service && x.accountId === keep.accountId));
    const mode = (s(b.mode) || 'keep').toLowerCase();
    if (!keep.service || !keep.accountId) return res.status(400).json({ ok: false, message: 'Account required.' });
    if (['keep', 'sum', 'manual'].indexOf(mode) < 0) return res.status(400).json({ ok: false, message: 'Choose how the rows relate: keep one, add them up, or type the real cost.' });
    if (!drop.length && mode === 'keep') return res.status(400).json({ ok: false, message: 'Nothing to merge.' });
    if (mode === 'sum' && !drop.length) return res.status(400).json({ ok: false, message: 'There is only one cost row, so there is nothing to add up.' });
    let every = 0, amount = 0;
    if (mode === 'manual') {
      every = Number(b.every);
      amount = Number(b.amount);
      if (!EVERY.includes(every)) return res.status(400).json({ ok: false, message: 'Billing must be every 1, 3, 6 or 12 months.' });
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) return res.status(400).json({ ok: false, message: 'Cost must be a number.' });
    }
    try {
      const rows = await db.query('SELECT service, account_id, monthly_cost, note FROM account_costs WHERE service = ? AND account_id = ? LIMIT 1', [keep.service, keep.accountId]);
      const kept = rows && rows[0];
      if (!kept) return res.status(404).json({ ok: false, message: 'No cost row for ' + keep.accountId + '. Reload the page and try again.' });
      const kp = AG.parseCostNote(kept.note, kept.monthly_cost);
      if (mode === 'sum') {
        // The rows can be billed over different periods, so their MONTHLY costs are added and the
        // total written back over the kept row's period (3 × ₹500/year -> ₹1,500/year).
        let monthly = num(kp.amount) / kp.every;
        for (const d of drop) {
          const r = await db.query('SELECT monthly_cost, note FROM account_costs WHERE service = ? AND account_id = ? LIMIT 1', [d.service, d.accountId]);
          if (r && r[0]) { const p = AG.parseCostNote(r[0].note, r[0].monthly_cost); monthly += num(p.amount) / p.every; }
        }
        every = kp.every; amount = r2(monthly * every);
      } else if (mode === 'keep') { every = kp.every; amount = kp.amount; }
      let removed = 0;
      for (const d of drop) { const r = await db.query('DELETE FROM account_costs WHERE service = ? AND account_id = ? LIMIT 1', [d.service, d.accountId]); removed += (r && r.affectedRows) || 0; }
      const monthly = r2(amount / every);
      if (mode !== 'keep') {
        await db.query('UPDATE account_costs SET monthly_cost = ?, note = ? WHERE service = ? AND account_id = ? LIMIT 1',
          [monthly, AG.buildCostNote(every, amount, kp.stoppedOn, kp.note) || null, keep.service, keep.accountId]);
      }
      const per = { 1: 'month', 3: '3 months', 6: '6 months', 12: 'year' }[every];
      const how = mode === 'sum' ? 'added ' + (removed + 1) + ' rows up' : mode === 'manual' ? 'set by hand' : 'kept one row';
      audit.record(req, { action: 'cost.merge', entity: 'account', id: keep.accountId,
        summary: keep.service + ' ' + keep.accountId + ': ' + how + ' → ₹' + amount + ' / ' + per + ' (= ₹' + monthly + ' / month), removed ' + removed + ' other row' + (removed === 1 ? '' : 's') + (drop.length ? ' (' + drop.map((d) => d.accountId).join(', ') + ')' : ''),
        details: { keep, drop, mode, amount, every } });
      res.json({ ok: true, removed, mode, amount: r2(amount), every, monthlyCost: monthly });
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

module.exports = { mount, computeProfit, periodRange, family, parseBilling, durationDays, orderSplit, istMs, buildAccountGroups: AG.buildAccountGroups, costFactor: AG.costFactor };
