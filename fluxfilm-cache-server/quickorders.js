/**
 * FluxFilm - admin quick orders (sales made on WhatsApp / phone).
 *
 * The owner picks a customer (search by name / phone / email / customer id, or type a
 * new one), picks service + plan from dropdowns, fills only the fields that plan needs
 * (Prime asks TV or mobile), and can mark it paid in the same tap — which allocates
 * the account and emails the credentials exactly like a website purchase.
 *
 * Everything goes through the storefront's own order.js / fulfill.js, so pricing,
 * stock, renewal rules (R1, F4), coins and emails behave identically.
 *
 * Routes (all admin-only, mounted by admin.js):
 *   GET  /admin/api/quick/catalog              plans + the fields each needs + live stock
 *   GET  /admin/api/quick/customers?q=         customer search
 *   GET  /admin/api/quick/renew-quote?sub_id=&plan=
 *   GET  /admin/api/quick/unpaid?q=            recent unpaid orders (to mark paid)
 *   POST /admin/api/quick/order                create NEW / RENEW order (+ mark paid)
 *   POST /admin/api/quick/mark-paid            mark an existing order paid + fulfil
 */
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const s = (v) => String(v == null ? '' : v).trim();
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

const PAY_METHODS = ['UPI', 'CASH', 'BANK', 'OTHER'];

/** What a plan needs from the admin, derived from the same plan columns the storefront uses. */
function planMeta(p) {
  const policy = s(p.allocationPolicy).toUpperCase();
  const mode = s(p.fulfillmentMode).toUpperCase();
  const deviceCount = Number((String(p.plan || '').match(/(\d+)\s*device/i) || [])[1]) || 1;
  const isPrime = p.extraFieldKey === 'PRIME_DEVICE_TYPE' || policy === 'CAPACITY';
  const fields = [];
  if (isPrime) {
    fields.push(deviceCount > 1
      ? { key: 'tvCount', type: 'count', label: 'How many of the ' + deviceCount + ' devices are TVs?', max: deviceCount, required: true }
      : { key: 'tvCount', type: 'tv', label: 'Will they watch on a TV?', max: 1, required: true });
  } else if (p.needsExtraField && s(p.extraFieldKey)) {
    fields.push({ key: 'extraFieldValue', type: 'text', label: s(p.extraFieldLabel) || s(p.extraFieldKey), required: true });
  }
  const kind = isPrime ? 'PRIME' : policy === 'OTP_ACCOUNT' ? 'OTP' : policy === 'PROFILE' ? 'PROFILE'
    : policy === 'ACCOUNT' ? 'ACCOUNT' : (mode === 'MANUAL' || policy === 'MANUAL' || policy === 'NONE' || !policy) ? 'MANUAL' : policy;
  const notes = [];
  if (kind === 'MANUAL') notes.push('Manual activation — no account is handed out automatically; activate it yourself.');
  if (kind === 'OTP') notes.push('OTP account — the customer uses Get OTP on the website to log in.');
  if (p.requiresGroupJoin) notes.push('Customer must join the group: ' + (s(p.groupJoinLink) || '(link not set)'));
  return { deviceCount, kind, fields, notes };
}

/**
 * Check the plan-specific fields. Returns { ok, tvCount, extraFieldValue } or { ok:false, message }.
 * Prime without a TV answer used to break the old admin's orders — refuse with a clear message instead.
 */
function checkFields(plan, body) {
  const meta = planMeta(plan);
  const out = { ok: true, tvCount: null, extraFieldValue: '' };
  for (const f of meta.fields) {
    if (f.key === 'tvCount') {
      const raw = body.tvCount;
      const n = Number(raw);
      if (raw === '' || raw == null || !Number.isInteger(n) || n < 0 || n > f.max) {
        return { ok: false, field: 'tvCount', message: f.type === 'tv' ? 'Choose TV or Mobile for ' + plan.service + '.' : 'Enter how many devices are TVs (0–' + f.max + ').' };
      }
      out.tvCount = n;
      out.extraFieldValue = n === 0 ? 'NON_TV' : n >= meta.deviceCount ? 'TV' : 'MIXED';
    } else if (f.key === 'extraFieldValue') {
      const v = s(body.extraFieldValue);
      if (!v) return { ok: false, field: 'extraFieldValue', message: f.label + ' is required.' };
      out.extraFieldValue = v;
    }
  }
  return out;
}

function mount(app, deps) {
  const { db, auth } = deps;
  // Loaded on first use (keeps admin-panel start-up and tests light).
  const lazy = (name) => ({ get: () => deps[name] || require('./' + name) });
  const M = { order: lazy('order'), fulfill: lazy('fulfill'), catalog: lazy('catalog') };
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  async function activePlans() {
    const b = await M.catalog.get().getBootstrap();
    return (b && b.ok && b.plans) || [];
  }

  app.get('/admin/api/quick/catalog', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [plans, stock] = await Promise.all([activePlans(), M.catalog.get().getStockLevels().catch(() => ({ levels: {} }))]);
      const levels = (stock && stock.levels) || {};
      res.json({
        ok: true, payMethods: PAY_METHODS,
        plans: plans.map((p) => {
          const lv = levels[p.service + '|||' + p.plan] || null;
          return {
            service: p.service, plan: p.plan, price: p.price, durationDays: p.durationDays,
            extraDevicePrice: p.extraDevicePrice, extraFieldKey: p.extraFieldKey,
            stock: lv ? lv.stock : null, stockLevel: lv ? lv.stockLevel : null,
            ...planMeta(p),
          };
        }),
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/quick/customers', async (req, res) => {
    if (!auth(req, res)) return;
    const q = s(req.query.q);
    if (q.length < 2) return res.json({ ok: true, results: [] });
    const like = '%' + q + '%';
    const digits = q.replace(/\D/g, '');
    const phoneLike = digits.length >= 3 ? '%' + digits + '%' : '__no_match__';
    try {
      const rows = await db.query(
        `SELECT c.customer_id, c.name, c.email, c.phone, c.phone_norm,
           (SELECT COUNT(*) FROM subscriptions x WHERE x.phone_norm = c.phone_norm AND UPPER(x.status) = 'ACTIVE' AND x.expiry_date > NOW()) AS active_subs
         FROM customers c
         WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone_norm LIKE ? OR c.customer_id LIKE ?
         ORDER BY (c.name LIKE ?) DESC, c.name ASC LIMIT 12`,
        [like, like, phoneLike, like, q + '%']);
      const results = rows.map((r) => ({ customerId: s(r.customer_id), name: s(r.name), email: s(r.email), phone: r.phone_norm || norm(r.phone), activeSubs: Number(r.active_subs) || 0, source: 'customers' }));
      if (results.length < 12) {
        // Buyers who never created a profile still have orders.
        const extra = await db.query(
          `SELECT o.phone_norm, MAX(o.name) AS name, MAX(o.email) AS email FROM orders o
           WHERE (o.name LIKE ? OR o.email LIKE ? OR o.phone_norm LIKE ?)
             AND o.phone_norm IS NOT NULL AND o.phone_norm <> ''
             AND o.phone_norm NOT IN (SELECT phone_norm FROM customers WHERE phone_norm IS NOT NULL)
           GROUP BY o.phone_norm LIMIT ?`,
          [like, like, phoneLike, 12 - results.length]);
        for (const r of extra) results.push({ customerId: '', name: s(r.name), email: s(r.email), phone: s(r.phone_norm), activeSubs: 0, source: 'orders' });
      }
      res.json({ ok: true, results });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/quick/renew-quote', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const q = await M.order.get().renewQuote(s(req.query.sub_id), s(req.query.plan));
      if (!q.ok) return res.status(400).json(q);
      const plans = (await activePlans()).filter((p) => p.service === q.sub.service).map((p) => ({ plan: p.plan, price: p.price, durationDays: p.durationDays }));
      res.json({
        ok: true, subId: q.sub.sub_id, service: q.sub.service, plan: q.plan, currentPlan: q.sub.plan, plans,
        price: q.price, earlyDiscount: q.earlyDiscount, amount: q.amount, daysLeft: q.daysLeft,
        mode: q.renewal.mode, message: q.renewal.message || '', preview: q.renewal.preview || null,
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/quick/unpaid', async (req, res) => {
    if (!auth(req, res)) return;
    const q = s(req.query.q);
    const digits = q.replace(/\D/g, '');
    try {
      const where = ["UPPER(status) = 'CREATED'", "source = 'node'", 'created_at_sheet > NOW() - INTERVAL 14 DAY'];
      const params = [];
      if (q) { where.push('(order_id LIKE ? OR name LIKE ? OR phone_norm LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', digits.length >= 3 ? '%' + digits + '%' : '__no_match__'); }
      const rows = await db.query(
        'SELECT order_id, created_at_sheet, name, phone_norm, service, plan, final_amount, order_type FROM orders WHERE ' + where.join(' AND ') + ' ORDER BY created_at_sheet DESC LIMIT 40', params);
      res.json({ ok: true, orders: rows });
    } catch (e) { fail(res, e); }
  });

  // Make sure the customer exists; never overwrite a name/email already on file.
  async function ensureCustomer(phone, name, email) {
    const rows = await db.query('SELECT customer_id, name, email FROM customers WHERE phone_norm = ? LIMIT 1', [phone]);
    if (rows.length) {
      const r = rows[0];
      const setName = !s(r.name) && name, setEmail = !s(r.email) && email;
      if (setName || setEmail) {
        await db.query(
          "UPDATE customers SET name = IF(? , ?, name), email = IF(?, ?, email), updated_at = NOW(), raw_json = JSON_SET(COALESCE(raw_json, '{}'), '$.Name', IF(?, ?, name), '$.Email', IF(?, ?, email)) WHERE phone_norm = ? LIMIT 1",
          [setName ? 1 : 0, name, setEmail ? 1 : 0, email, setName ? 1 : 0, name, setEmail ? 1 : 0, email, phone]);
      }
      return { created: false, customerId: s(r.customer_id), name: s(r.name) || name, email: s(r.email) || email };
    }
    const customerId = 'CUS-' + String(Date.now()).slice(-8);
    const now = new Date().toISOString();
    const raw = { CustomerID: customerId, MemberSince: now, UpdatedAt: now, Name: name, Phone: phone, Email: email, LastOrderID: '', TotalOrders: 0, TotalSpent: 0, lastActivity: now, Notes: 'Added from admin quick order', Status: 'ACTIVE', ProfilePicUrl: '' };
    await db.query(
      "INSERT INTO customers (phone, phone_norm, name, email, profile_pic_url, member_since, updated_at, status, customer_id, raw_json) VALUES (?, ?, ?, ?, '', NOW(), NOW(), 'ACTIVE', ?, ?)",
      [phone, phone, name, email, customerId, JSON.stringify(raw)]);
    return { created: true, customerId, name, email };
  }

  async function markPaidAndFulfil(orderId, method, ref) {
    const m = PAY_METHODS.includes(s(method).toUpperCase()) ? s(method).toUpperCase() : 'OTHER';
    const txn = ('ADMIN-' + m + (s(ref) ? ':' + s(ref) : '')).slice(0, 120);
    const paid = await M.order.get().adminMarkPaid(orderId, txn);
    if (!paid.ok) return { ok: false, message: paid.message };
    const f = await M.fulfill.get().fulfillForAdmin(orderId);
    return { ok: true, fulfillment: f };
  }

  app.post('/admin/api/quick/order', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const mode = s(b.mode).toUpperCase() === 'RENEW' ? 'RENEW' : 'NEW';
    const phone = norm(b.phone);
    if (phone.length !== 10) return res.status(400).json({ ok: false, field: 'phone', message: 'Enter a 10-digit mobile number.' });
    const email = s(b.email).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, field: 'email', message: 'That email looks wrong.' });
    const amount = (b.amount === '' || b.amount == null) ? null : Number(b.amount);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) return res.status(400).json({ ok: false, field: 'amount', message: 'Amount must be a number.' });
    const method = s(b.payMethod).toUpperCase() || 'UPI';
    const rawExtra = { CreatedVia: 'ADMIN', PaymentMethod: method, AdminNote: s(b.notes).slice(0, 300) };

    try {
      let out;
      if (mode === 'NEW') {
        const plans = await activePlans();
        const plan = plans.find((p) => p.service === s(b.service) && p.plan === s(b.plan));
        if (!plan) return res.status(400).json({ ok: false, field: 'plan', message: 'Pick a service and an active plan.' });
        const f = checkFields(plan, b);
        if (!f.ok) return res.status(400).json(f);
        const name = s(b.name);
        if (!name) return res.status(400).json({ ok: false, field: 'name', message: 'Customer name is required.' });

        // Two taps on "Create" must not make two orders.
        if (!b.confirmDuplicate) {
          const dup = await db.query(
            "SELECT order_id FROM orders WHERE phone_norm = ? AND service = ? AND plan = ? AND created_at_sheet > NOW() - INTERVAL 3 MINUTE AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.CreatedVia')) = 'ADMIN' ORDER BY created_at_sheet DESC LIMIT 1",
            [phone, plan.service, plan.plan]);
          if (dup.length) return res.status(409).json({ ok: false, duplicate: true, orderId: dup[0].order_id, message: 'An order for this customer and plan was created ' + 'in the last 3 minutes (' + dup[0].order_id + '). Create another anyway?' });
        }
        const cust = await ensureCustomer(phone, name, email);
        out = await M.order.get().createOrder({
          service: plan.service, plan: plan.plan, name: cust.name || name, email: email || cust.email || '', phone,
          notes: 'ADMIN ' + method + (s(b.notes) ? ': ' + s(b.notes) : ''),
          extraFieldKey: plan.extraFieldKey || '', extraFieldValue: f.extraFieldValue, tvCount: f.tvCount,
        }, { amountOverride: amount, allowNoEmail: true, rawExtra });
        if (out && out.ok) { out.customerCreated = cust.created; out.customerId = cust.customerId; }
      } else {
        const subId = s(b.subId);
        if (!subId) return res.status(400).json({ ok: false, field: 'subId', message: 'Pick the subscription to renew.' });
        const own = await db.query('SELECT phone_norm FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]);
        if (!own.length) return res.status(400).json({ ok: false, field: 'subId', message: 'Subscription not found.' });
        if (s(own[0].phone_norm) !== phone) return res.status(400).json({ ok: false, field: 'subId', message: 'That subscription belongs to a different phone number.' });
        out = await M.order.get().createRenewOrder(subId, s(b.plan), '', { amountOverride: amount, notes: 'ADMIN RENEW ' + method + (s(b.notes) ? ': ' + s(b.notes) : ''), rawExtra });
      }
      if (!out || !out.ok) return res.status(400).json(out || { ok: false, message: 'Order could not be created.' });

      const result = { ok: true, mode, orderId: out.orderId, amount: out.amount, status: 'CREATED', upiLink: out.upiLink, customerCreated: !!out.customerCreated, renewNotice: out.renewNotice || '', renewPreview: out.renewPreview || null };
      if (b.markPaid) {
        const p = await markPaidAndFulfil(out.orderId, method, b.txnRef);
        if (!p.ok) return res.json(Object.assign(result, { markPaidError: p.message }));
        result.status = 'PAID';
        result.fulfillment = p.fulfillment;
      }
      res.json(result);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/quick/mark-paid', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const orderId = s(b.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const p = await markPaidAndFulfil(orderId, b.payMethod, b.txnRef);
      if (!p.ok) return res.status(400).json(p);
      res.json({ ok: true, orderId, status: 'PAID', fulfillment: p.fulfillment });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, planMeta, checkFields, PAY_METHODS };
