/**
 * FluxFilm — ⚠️ subscriptions whose plan name and device count disagree.
 *
 * Found 29 Sep 2026, from the owner asking about one customer: "7016076889 bought 2 devices prime initially and
 * i think on 1 sep i changed it to 1 device? are we still recording it as 2 device in subs and device count both".
 * Half recorded — `plan` still said "2 Devices 1M", `device_count` said 1.
 *
 * Why it happened: a renewal only started rewriting the subscription's plan name on 23 Sep 2026 (be97a9e,
 * "Change your plan when you renew"). Before that, renewing into a different plan left the old name on the row.
 * So this is old data, not a live bug — but it is old data that still costs money, because renewQuote() prices
 * from the subscription's plan when the customer does not pick one. That customer would have been quoted ₹59
 * instead of ₹39 two days before his plan ended.
 *
 * ⚠️ The mismatch does NOT always mean the same thing, and fixing them all one way would break half of them:
 *     …6889  paid ₹39 for "1 Month"       → the PLAN NAME is stale, the device count is right
 *     …8207  paid ₹56 for "2 Devices 1M"  → the DEVICE COUNT is wrong, the plan name is right
 * So this screen shows what the customer's own orders say and lets the owner choose per row. It never guesses.
 *
 *   GET  /admin/api/subs/mismatch    the rows, with what their last paid order was for
 *   POST /admin/api/subs/fix-plan    set the plan name and/or the device count on ONE subscription
 *
 * 🔒 It touches two columns on one row, nothing else: no expiry, no price, no account, no money. raw_json is
 * updated only where one already exists — these rows have none, and fulfill.js deliberately keeps it that way.
 */
const s = (v) => String(v == null ? '' : v).trim();
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** How many devices a plan NAME says. "Sharing 2 Devices 1M" → 2, everything else → 1. */
const devicesInName = (plan) => (/(\d+)\s*devices?/i.test(s(plan)) ? n(s(plan).match(/(\d+)\s*devices?/i)[1], 1) : 1);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (v) => { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; };

const SUBS_SQL =
  'SELECT sub_id, phone_norm, service, plan, device_count, status, expiry_date, order_id FROM subscriptions ' +
  "WHERE UPPER(COALESCE(status,'')) NOT IN ('REFUNDED','CANCELLED') AND device_count IS NOT NULL";

/**
 * Every row where the plan name and the device count disagree, newest expiry first, with the plan the customer
 * last actually PAID for — which is the evidence for which side is wrong.
 */
async function overview(query) {
  const subs = await query(SUBS_SQL, []);
  const bad = subs.filter((x) => devicesInName(x.plan) !== n(x.device_count, 1));
  if (!bad.length) return { ok: true, rows: [], totals: { all: 0, active: 0 } };

  // The orders for those customers, read on their own and matched in JS — never joined, the tables are in two
  // collations and MariaDB refuses the comparison.
  let orders = [];
  try {
    orders = await query(
      "SELECT order_id, phone_norm, service, plan, final_amount, created_at_sheet FROM orders " +
      "WHERE UPPER(COALESCE(status,'')) IN ('PAID','FULFILLED') ORDER BY created_at_sheet DESC", []);
  } catch (e) { console.log('[subfix] orders unavailable:', e.message); }
  const lastFor = new Map();
  for (const o of orders) {
    const k = s(o.phone_norm) + '|' + s(o.service).toLowerCase();
    if (!lastFor.has(k)) lastFor.set(k, o);
  }

  const rows = bad.map((x) => {
    const paid = lastFor.get(s(x.phone_norm) + '|' + s(x.service).toLowerCase()) || null;
    const nameSays = devicesInName(x.plan);
    const countSays = n(x.device_count, 1);
    // What the money says. If their last paid order names a plan, that is the plan they are on — so a plan name
    // that disagrees with it is the stale one, and a device count that disagrees with the NAME is the stale one.
    const paidPlan = paid ? s(paid.plan) : '';
    const suggest = paidPlan && paidPlan !== s(x.plan)
      ? { what: 'plan', plan: paidPlan, devices: devicesInName(paidPlan), why: 'their last paid order was for "' + paidPlan + '"' }
      : paidPlan
        ? { what: 'devices', plan: s(x.plan), devices: nameSays, why: 'their last paid order was for "' + paidPlan + '", which is ' + nameSays + ' device' + (nameSays === 1 ? '' : 's') }
        : null;
    return {
      subId: s(x.sub_id), phone: s(x.phone_norm), service: s(x.service),
      plan: s(x.plan), deviceCount: countSays, nameSays,
      status: s(x.status).toUpperCase(), expiry: s(x.expiry_date), expiryLabel: prettyDate(x.expiry_date),
      lastPaidPlan: paidPlan, lastPaidAmount: paid ? n(paid.final_amount, null) : null,
      lastPaidOn: paid ? prettyDate(paid.created_at_sheet) : '', lastPaidOrder: paid ? s(paid.order_id) : '',
      suggest,
    };
  }).sort((a, b) => s(b.expiry).localeCompare(s(a.expiry)));

  return { ok: true, rows, totals: { all: rows.length, active: rows.filter((r) => r.status === 'ACTIVE').length } };
}

function mount(app, deps) {
  const { auth } = deps;
  const db = deps.db || require('./db');
  const query = (sql, p) => db.query(sql, p || []);
  const audit = deps.audit || { record: () => {} };
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/subs/mismatch', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await overview(query)); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/subs/fix-plan', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const subId = s(b.subId);
    if (!subId) return res.status(400).json({ ok: false, message: 'Which subscription?' });
    try {
      const row = (await query('SELECT sub_id, service, plan, device_count FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]))[0];
      if (!row) return res.status(404).json({ ok: false, message: 'No subscription with that id.' });
      const plan = b.plan === undefined ? s(row.plan) : s(b.plan);
      const devices = b.devices === undefined ? n(row.device_count, 1) : n(b.devices, 0);
      if (!plan) return res.status(400).json({ ok: false, message: 'A subscription must have a plan.' });
      if (!(devices >= 1 && devices <= 10)) return res.status(400).json({ ok: false, message: 'Devices must be between 1 and 10.' });
      // The plan has to be a real plan of the SAME service. A typo here would misprice every future renewal, which
      // is the very thing this screen exists to stop.
      const known = (await query('SELECT plan FROM plans WHERE service = ?', [row.service])).map((p) => s(p.plan));
      if (known.length && known.indexOf(plan) === -1) {
        return res.status(400).json({ ok: false, message: '"' + plan + '" is not a plan of ' + row.service + '. Pick one of: ' + known.slice(0, 8).join(', ') + (known.length > 8 ? '…' : '') });
      }
      if (plan === s(row.plan) && devices === n(row.device_count, 1)) return res.json(Object.assign({ ok: true, unchanged: true }, await overview(query)));
      // Two columns, one row. raw_json only where one already exists — these rows have none, and fulfill.js
      // keeps it that way on purpose, so inventing a partial one here would be a new kind of wrong.
      await query(
        "UPDATE subscriptions SET plan = ?, device_count = ?, " +
        "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.Plan', ?, '$.DeviceConcurrency', ?)) WHERE sub_id = ? LIMIT 1",
        [plan, devices, plan, devices, subId]);
      audit.record(req, {
        action: 'sub.fixPlan', entity: 'subscription', id: subId,
        summary: '⚠️ corrected ' + s(row.service) + ': "' + s(row.plan) + '" ×' + n(row.device_count, 1) + ' → "' + plan + '" ×' + devices,
        details: { subId, from: { plan: s(row.plan), devices: n(row.device_count, 1) }, to: { plan, devices } },
      });
      res.json(Object.assign({ ok: true, subId, plan, devices }, await overview(query)));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, _internal: { overview, devicesInName, prettyDate } };
