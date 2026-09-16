/**
 * FluxFilm - admin order lookup + stock levels (mounted by admin.js, admin-only).
 *
 *   GET  /admin/api/orders/search?q=&view=all|unpaid|undelivered|today|week&paidVia=
 *   GET  /admin/api/orders/detail?id=FF…        order + payment + delivery + subscription(s)
 *   POST /admin/api/orders/retry-fulfil         paid but not delivered → try again
 *   GET  /admin/api/stock                       free units per plan + every account's usage
 *
 * Stock per plan comes from stock.js — the same numbers the storefront's badges use,
 * which are cross-checked against the real allocators in tests.
 *
 * 💸 "Paid via" (paidvia.js) rides along on both order routes: website QR · typed UTR · backup QR · coins · ₹0 ·
 * admin · credit. It is stamped on raw_json at payment time and worked out on the fly for older orders. The bank
 * credit and the claim row are read with their OWN statements and matched in JS (never a cross-table JOIN).
 */
const paidvia = require('./paidvia');

const s = (v) => String(v == null ? '' : v).trim();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

const ORDER_COLS = 'order_id, created_at_sheet, name, email, phone, phone_norm, service, plan, duration_days, final_amount, price, discount, coupon_code, currency, status, fulfillment_status, order_type, renew_sub_id, txn_ref, verified_at, fulfilled_at, notes, extra_field_value, device_count, tv_count, source';
const VIEWS = {
  all: '',
  unpaid: "UPPER(status) = 'CREATED'",
  // Old-site orders often got their subscription but were never marked delivered:
  // only list paid orders with no subscription attached — the real problems. Old-site renewals
  // point at the renewed subscription (renew_sub_id) instead; website renewals always stay visible.
  undelivered: "UPPER(status) = 'PAID' AND UPPER(COALESCE(fulfillment_status, '')) NOT IN ('FULFILLED', 'MANUAL_PENDING') AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.order_id = orders.order_id) AND NOT (COALESCE(orders.source, '') <> 'node' AND COALESCE(orders.renew_sub_id, '') <> '' AND EXISTS (SELECT 1 FROM subscriptions r WHERE r.sub_id = orders.renew_sub_id))",
  manual: "UPPER(COALESCE(fulfillment_status, '')) = 'MANUAL_PENDING'",
  today: 'created_at_sheet >= CURDATE()',
  week: 'created_at_sheet >= CURDATE() - INTERVAL 6 DAY',
};
// Same occupancy rule as fulfill.js / stock.js.
const OCC_ACTIVE = "UPPER(status)='ACTIVE' AND (expiry_date > NOW() OR release_eligible_at > NOW())";

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const lazy = (name) => () => deps[name] || require('./' + name);
  const M = { fulfill: lazy('fulfill'), catalog: lazy('catalog'), stock: lazy('stock'), expiredusers: lazy('expiredusers') };
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/orders/search', async (req, res) => {
    if (!auth(req, res)) return;
    const q = s(req.query.q);
    const view = VIEWS[s(req.query.view)] != null ? s(req.query.view) : 'all';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    // 💸 Paid-via is not a column — it is worked out per order — so the filter reads more rows and keeps the
    // matching ones. 4× the page is plenty for "show me the backup-QR orders" without ever scanning the table.
    const wantVia = paidvia.fromFilter(req.query.paidVia);
    const readLimit = wantVia ? Math.min(400, limit * 4) : limit;
    const where = []; const params = [];
    if (VIEWS[view]) where.push(VIEWS[view]);
    if (q) {
      const like = '%' + q + '%';
      const digits = q.replace(/\D/g, '');
      where.push('(order_id LIKE ? OR name LIKE ? OR email LIKE ? OR txn_ref LIKE ? OR service LIKE ? OR phone_norm LIKE ?)');
      params.push(like, like, like, like, like, digits.length >= 3 ? '%' + digits + '%' : '__no_match__');
    }
    try {
      const rows = await db.query(
        'SELECT order_id, created_at_sheet, name, phone_norm, service, plan, final_amount, status, fulfillment_status, order_type, source, txn_ref, verified_at, raw_json FROM orders' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at_sheet DESC LIMIT ?', [...params, readLimit]);
      // Never let the paid-via lookup break the orders list itself.
      const map = await paidvia.forOrders((sql, p) => db.query(sql, p), rows).then((x) => x.map, (e) => { console.log('[paidvia] order list:', e.message); return new Map(); });
      const orders = [];
      for (const o of rows) {
        const pv = map.get(s(o.order_id)) || {};
        delete o.raw_json;                       // raw_json is only read here to work out "Paid via"
        o.paid_via = pv.via || ''; o.paid_via_detail = pv.detail || ''; o.paid_via_label = pv.label || '';
        if (wantVia && pv.via !== wantVia) continue;
        orders.push(o);
        if (orders.length >= limit) break;
      }
      res.json({ ok: true, view, paidVia: paidvia.filterOf(wantVia), orders, more: wantVia && rows.length >= readLimit });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/orders/detail', async (req, res) => {
    if (!auth(req, res)) return;
    const id = s(req.query.id);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const rows = await db.query('SELECT ' + ORDER_COLS + ', raw_json FROM orders WHERE order_id = ? LIMIT 1', [id]);
      if (!rows.length) return res.status(404).json({ ok: false, message: 'No order ' + id });
      const o = rows[0];
      const raw = rawOf(o.raw_json); delete o.raw_json;
      const subIds = [s(o.renew_sub_id)].filter(Boolean);
      // F1: an order with separate logins has one subscription per login (up to 10 devices) — list them all, Device 1 first.
      const groupsOn = await require('./devicelogins').groupsReady(db.query);
      const [subs, credits, coupons, cust] = await Promise.all([
        db.query(
          'SELECT sub_id, order_id, service, plan, start_date, expiry_date, status, fulfillment_status, inventory_ref, login_id, password, profile_name, profile_number, profile_pin, device_type, device_count, tv_count, source' + (groupsOn ? ', group_id, group_size, group_index' : '') + ' FROM subscriptions WHERE order_id = ?' +
          (subIds.length ? ' OR sub_id = ?' : '') +
          (groupsOn ? ' ORDER BY group_id, group_index' : '') + ' LIMIT 12', subIds.length ? [id, subIds[0]] : [id]),
        // `raw` is the bank's alert text: the payer name / IFSC are parsed here and only those are sent on.
        db.query('SELECT id, upi_ref, amount, received_at, order_ids, raw FROM bank_credits WHERE consumed_order_id = ? ORDER BY id DESC LIMIT 3', [id]),
        db.query('SELECT coupon_code, discount, action, ts FROM coupon_usage WHERE order_id = ? ORDER BY ts', [id]),
        db.query('SELECT name, email, customer_id FROM customers WHERE phone_norm = ? LIMIT 1', [o.phone_norm]),
      ]);
      // 📲 An accepted backup-UPI claim (paymatch.js) — its own statement, matched in JS (schema-v17 may be missing).
      let claim = null;
      try {
        const cl = await db.query("SELECT order_id, payer_name, utr, status, source, created_at, updated_at, decided_at FROM payment_claims WHERE order_id = ? AND status IN ('MATCHED', 'APPROVED') ORDER BY id DESC LIMIT 1", [id]);
        claim = cl[0] || null;
      } catch (e) { if (!/doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e.message))) throw e; }
      const pv = paidvia.compute(Object.assign({}, o, { raw_json: raw }), { raw, credit: credits[0] || null, claim });
      const bankCredits = credits.map((b) => {
        const a = paidvia.parseAlert(b.raw);
        return { id: b.id, upi_ref: b.upi_ref, amount: b.amount, received_at: b.received_at, payerName: a.payerName, bank: a.ifsc, vpa: paidvia.maskVpa(a.vpa), note: a.note };
      });
      res.json({
        ok: true, order: o, subs, bankCredits, couponUsage: coupons, customer: cust[0] || null,
        // 💸 How the money actually came in (website QR / typed UTR / backup QR / coins / ₹0 / admin / credit).
        paidVia: { key: pv.via, detail: pv.detail, label: pv.label, at: pv.at, stored: pv.stored, payerName: s((bankCredits[0] || {}).payerName) || paidvia.displayName(claim && claim.payer_name) },
        // Who/how it was created (admin quick orders tag these); never the access-token hash.
        meta: { createdVia: s(raw.CreatedVia) || (o.source === 'node' ? 'WEBSITE' : 'SHEET'), paymentMethod: s(raw.PaymentMethod), adminNote: s(raw.AdminNote), loginMode: s(raw.LoginMode) },
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/orders/retry-fulfil', async (req, res) => {
    if (!auth(req, res)) return;
    const id = s((req.body || {}).orderId);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const rows = await db.query('SELECT status, source FROM orders WHERE order_id = ? LIMIT 1', [id]);
      if (!rows.length) return res.status(404).json({ ok: false, message: 'Order not found.' });
      if (s(rows[0].source) !== 'node') return res.status(400).json({ ok: false, message: 'Old Sheet orders cannot be delivered from here.' });
      if (s(rows[0].status).toUpperCase() !== 'PAID') return res.status(400).json({ ok: false, message: 'This order is not paid yet — mark it paid first.' });
      // FAILED means an earlier attempt found no stock; clear it so fulfilment runs again.
      await db.query("UPDATE orders SET fulfillment_status = 'PENDING' WHERE order_id = ? AND UPPER(COALESCE(fulfillment_status, '')) IN ('FAILED', 'ERROR', '')", [id]);
      const f = await M.fulfill().fulfillForAdmin(id);
      audit.record(req, { action: 'order.retryDelivery', entity: 'order', id, summary: 'Tried delivering again → ' + ((f && f.fulfillment) || '') });
      res.json({ ok: true, orderId: id, fulfillment: f });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/stock', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [boot, levels, accounts, caps, profiles, occ, expired] = await Promise.all([
        M.catalog().getBootstrap(),
        M.catalog().getStockLevels(),
        db.query('SELECT service, account_id, login_id, is_active, plan, notes FROM inventory_accounts ORDER BY service, account_id', []),
        db.query('SELECT service, account_id, max_total, max_tv, is_active FROM inventory_capacity', []),
        db.query('SELECT service, account_id, profile_number, profile_name, raw_json FROM inventory_profiles', []),
        db.query(
          "SELECT inventory_ref, COUNT(*) subs, SUM(COALESCE(device_count, 1)) devices, SUM(CASE WHEN tv_count IS NOT NULL THEN tv_count WHEN UPPER(device_type) = 'TV' THEN COALESCE(device_count, 1) ELSE 0 END) tv FROM subscriptions WHERE " + OCC_ACTIVE + ' GROUP BY inventory_ref', []),
        // Same result as 🚪 Remove users (expiredusers.js, Sheet rule): per-account badge + the link's counts.
        M.expiredusers().load((sql, p) => db.query(sql, p)).catch((e) => { console.log('[stock] expired users failed:', e.message); return null; }),
      ]);
      const plans = (boot && boot.plans) || [];
      const lv = (levels && levels.levels) || {};

      // Policy per service (from its plans) decides how an account's capacity is read.
      const policyOf = {};
      for (const p of plans) {
        const pol = s(p.allocationPolicy).toUpperCase() || (s(p.fulfillmentMode).toUpperCase() === 'MANUAL' ? 'MANUAL' : '');
        if (!policyOf[p.service.toLowerCase()]) policyOf[p.service.toLowerCase()] = pol;
      }
      const policyForAccount = (svc) => {
        const k = s(svc).toLowerCase();
        if (policyOf[k]) return policyOf[k];
        const hit = Object.keys(policyOf).find((x) => x.includes(k) || k.includes(x));
        return hit ? policyOf[hit] : '';
      };

      const accOf = (ref) => s(ref).split('#')[0];
      const use = new Map(); const profUsed = new Map();
      const expBy = (expired && expired.byAccount) || {};
      for (const r of occ) {
        const a = accOf(r.inventory_ref); if (!a) continue;
        const u = use.get(a) || { subs: 0, devices: 0, tv: 0 };
        u.subs += asNum(r.subs); u.devices += asNum(r.devices); u.tv += asNum(r.tv);
        use.set(a, u);
        if (s(r.inventory_ref).includes('#P')) { if (!profUsed.has(a)) profUsed.set(a, new Set()); profUsed.get(a).add(s(r.inventory_ref)); }
      }
      const capMap = new Map(); for (const c of caps) capMap.set(s(c.account_id), c);
      const profCount = new Map(); for (const p of profiles) { const a = s(p.account_id); profCount.set(a, (profCount.get(a) || 0) + 1); }

      const primeMax = Number(process.env.PRIME_MAX_TOTAL || 4), primeTv = Number(process.env.PRIME_MAX_TV || 2);
      const out = accounts.map((a) => {
        const id = s(a.account_id);
        const policy = policyForAccount(a.service);
        const cap = capMap.get(id);
        const u = use.get(id) || { subs: 0, devices: 0, tv: 0 };
        const active = s(a.is_active).toUpperCase() === 'TRUE' && (!cap || s(cap.is_active).toUpperCase() !== 'FALSE');
        const row = { service: s(a.service), accountId: id, login: s(a.login_id), plan: s(a.plan), notes: s(a.notes), policy, isActive: active, activeSubs: u.subs, expiredOnAccount: expBy[id] ? expBy[id].pending : 0, expiredOldUsers: expBy[id] ? expBy[id].oldUsers : 0, removeAdvice: expBy[id] ? expBy[id].advice : 'NONE', removeOn: expBy[id] ? expBy[id].changeOn : '' };
        if (policy === 'CAPACITY') {
          row.cap = asNum(cap && cap.max_total) || primeMax; row.used = u.devices;
          row.tvCap = asNum(cap && cap.max_tv) || primeTv; row.tvUsed = u.tv; row.unit = 'devices';
        } else if (policy === 'PROFILE') {
          row.cap = profCount.get(id) || 0; row.used = (profUsed.get(id) || new Set()).size; row.unit = 'profiles';
        } else if (policy === 'ACCOUNT' || policy === 'OTP_ACCOUNT') {
          row.cap = asNum(cap && cap.max_total) || 1; row.used = u.devices; row.unit = policy === 'OTP_ACCOUNT' ? 'customers' : 'devices';
        } else {
          row.cap = null; row.used = u.subs; row.unit = 'customers';
        }
        row.free = row.cap == null ? null : Math.max(0, row.cap - row.used);
        row.status = !active ? 'INACTIVE' : row.cap == null ? 'MANUAL' : row.free <= 0 ? 'FULL' : (row.tvCap != null && row.tvUsed >= row.tvCap) ? 'TV_FULL' : 'OK';
        return row;
      });

      res.json({
        ok: true,
        plans: plans.map((p) => {
          const l = lv[p.service + '|||' + p.plan] || {};
          return { service: p.service, plan: p.plan, price: p.price, durationDays: p.durationDays, stock: l.stock == null ? null : l.stock, stockLevel: l.stockLevel || 'OK', source: l.source || '' };
        }),
        accounts: out,
        // Stock is about free slots. Who to log out lives in 🚪 Remove users (GET /admin/api/remove-users); Stock only
        // links there with the same counts (customers / accounts) and shows the per-account badge from the same result.
        removeUsers: expired ? M.expiredusers().summarize(expired) : null,
      });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, VIEWS };
