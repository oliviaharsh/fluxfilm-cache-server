/**
 * FluxFilm - admin "Today" screen, to-dos, global search and change log (admin-only).
 *
 *   GET  /admin/api/today              action list: what needs doing now (+ open to-dos)
 *   GET  /admin/api/todos?all=1        to-dos     POST /admin/api/todos        add
 *   POST /admin/api/todos/update       done / edit     POST /admin/api/todos/delete
 *   GET  /admin/api/search?q=          customers, orders and subscriptions in one box
 *   GET  /admin/api/audit?q=&action=   change log
 *
 * Tables admin_todos / audit_log come from db/schema-v14.sql; until it is run the
 * Today screen still works and the to-do/change-log parts say so.
 */
const s = (v) => String(v == null ? '' : v).trim();
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const SCHEMA_MSG = 'Run db/schema-v14.sql in phpMyAdmin first.';
// Paid but not delivered (refunded orders are REFUNDED, not PAID, so they drop out by themselves).
const UNDELIVERED = "UPPER(o.status) = 'PAID' AND UPPER(COALESCE(o.fulfillment_status, '')) NOT IN ('FULFILLED', 'MANUAL_PENDING') AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.order_id = o.order_id) AND NOT (COALESCE(o.source, '') <> 'node' AND COALESCE(o.renew_sub_id, '') <> '' AND EXISTS (SELECT 1 FROM subscriptions r WHERE r.sub_id = o.renew_sub_id))";

function mount(app, deps) {
  const { db, auth, audit } = deps;
  const catalog = () => deps.catalog || require('./catalog');
  const refunds = () => deps.refunds || require('./refunds');
  const fail = (res, e) => res.status(missingTable(e) ? 409 : 500).json({ ok: false, needsSchema: missingTable(e), message: missingTable(e) ? SCHEMA_MSG : String((e && e.message) || e) });
  const one = async (sql, p) => { try { const r = await db.query(sql, p || []); return r[0] || {}; } catch (e) { return { error: e.message }; } };
  const many = async (sql, p) => { try { return await db.query(sql, p || []); } catch (e) { return []; } };

  // 🚪 card: the same numbers as GET /admin/api/remove-users (expiredusers.summarize), opens the 🚪 Remove users screen.
  const expiredCard = (ex) => {
    const E = deps.expiredusers || require('./expiredusers');
    const ok = !!(ex && ex.main);
    const c = ok ? E.summarize(ex) : E.summarize(null);
    // "To do" = only logins where changing the password is worth it NOW (owner's timing rule); waiting ones in the subtitle.
    return {
      key: 'expired', icon: '🔑', title: 'Account passwords to change', count: c.changeNow.accounts, tone: 'warn',
      sub: ok ? E.todoLine(c) : 'could not work it out — open 🚪 Remove users', showSub: ok && c.wait.accounts > 0,
      accounts: c.changeNow.accounts, waiting: c.wait.accounts, go: { view: 'removeusers' }, names: ok ? E.todayNames(ex, 20) : [],
    };
  };

  app.get('/admin/api/today', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [unpaid, undelivered, manual, ending, endingList, expiredOn, restock, unmatched, todos, stock, stuckList, upiRefunds, openOffers, manualLate, refundRequests] = await Promise.all([
        // Checkouts started on the new site in the last 3 days but not paid: worth a nudge.
        one("SELECT COUNT(*) n FROM orders WHERE UPPER(status) = 'CREATED' AND source = 'node' AND created_at_sheet > NOW() - INTERVAL 3 DAY"),
        one('SELECT COUNT(*) n FROM orders o WHERE ' + UNDELIVERED),
        one("SELECT COUNT(*) n FROM subscriptions WHERE UPPER(COALESCE(fulfillment_status, '')) = 'MANUAL_PENDING' AND UPPER(status) = 'ACTIVE'"),
        one("SELECT COUNT(*) n FROM subscriptions WHERE UPPER(status) = 'ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 3 DAY"),
        many("SELECT sub_id, phone_norm, service, plan, expiry_date FROM subscriptions WHERE UPPER(status) = 'ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 3 DAY ORDER BY expiry_date LIMIT 5"),
        // Sheet DASHBOARD rule (expiredusers.js): only logins that still have active customers, no 60-day cap.
        (deps.expiredusers || require('./expiredusers')).load((sql, p) => db.query(sql, p)).catch((e) => ({ error: e.message })),
        one("SELECT COUNT(*) n FROM restock_requests WHERE UPPER(COALESCE(status, '')) <> 'DONE'"),
        // Since go-live only (older payments were confirmed by the old site), minus "Not a sale" (adminbankcredits.js).
        (deps.bankcredits || require('./adminbankcredits')).storeFor(db).countUnmatched().then((x) => ({ n: x.count }), (e) => ({ error: e.message })),
        many('SELECT id, title, note, due_date, done, created_at FROM admin_todos WHERE done = 0 ORDER BY due_date IS NULL, due_date, id LIMIT 50'),
        catalog().getStockLevels().catch(() => ({ levels: {} })),
        // The stuck orders themselves, so a tap on one opens it with its actions (fulfil / refund / erase).
        many('SELECT o.order_id, o.name, o.phone_norm, o.service, o.plan, o.final_amount, o.fulfillment_status, o.created_at_sheet FROM orders o WHERE ' + UNDELIVERED + ' ORDER BY o.created_at_sheet DESC LIMIT 5'),
        // 💸 Cash refunds still open (refunds.js): the customer is choosing (ASK_CUSTOMER) or gave a UPI ID (UPI_REQUESTED).
        many("SELECT o.order_id, o.name, o.phone_norm, o.service, o.plan, o.final_amount, o.raw_json, o.created_at_sheet FROM orders o WHERE UPPER(o.status) = 'REFUNDED' AND JSON_UNQUOTE(JSON_EXTRACT(o.raw_json, '$.RefundMethod')) = 'UPI_PENDING' ORDER BY o.created_at_sheet DESC LIMIT 50"),
        // 💸 Refund offers on delivered plans the customer has not chosen yet (db/schema-v26; [] before it is run).
        many("SELECT offer_id, order_id, phone_norm, service, plan, refund_amount FROM refund_offers WHERE status = 'OFFERED' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 50"),
        // 🛠 Manual plans: the 48 hours count from the PAYMENT (verified_at, else when the order was created).
        one("SELECT COUNT(*) n FROM subscriptions s JOIN orders o ON o.order_id = s.order_id WHERE UPPER(COALESCE(s.fulfillment_status, '')) = 'MANUAL_PENDING' AND UPPER(s.status) = 'ACTIVE' AND COALESCE(o.verified_at, o.created_at_sheet) < NOW() - INTERVAL 48 HOUR"),
        // 📨 Customer "Request refund" waiting for an answer (refundrequests.js, db/schema-v26; [] before it is run).
        many("SELECT request_id, order_id, phone_norm, service, plan, paid_amount, kind FROM refund_requests WHERE status = 'OPEN' ORDER BY created_at LIMIT 50"),
      ]);
      // 💳 Receivables: admin credit renewals not paid yet (credit.js, orders only). Never breaks the Today screen.
      const credit = deps.credit || require('./credit');
      const recv = await credit.receivables((sql, p) => db.query(sql, p)).catch((e) => ({ error: e.message }));
      const openRefunds = (Array.isArray(upiRefunds) ? upiRefunds : []).map((o) => { const r = require("./refunds").refundInfo(o); return { order_id: o.order_id, name: o.name, phone_norm: o.phone_norm, service: o.service, plan: o.plan, final_amount: r.amount, fulfillment_status: r.state === 'UPI_REQUESTED' ? 'UPI_REFUND_REQUESTED' : 'CUSTOMER_CHOOSING', state: r.state }; });
      const toSend = openRefunds.filter((x) => x.state === 'UPI_REQUESTED');
      const choosing = openRefunds.filter((x) => x.state !== 'UPI_REQUESTED')
        .concat((Array.isArray(openOffers) ? openOffers : []).map((x) => ({ order_id: x.order_id, name: '', phone_norm: x.phone_norm, service: x.service, plan: x.plan, final_amount: Number(x.refund_amount) || 0, fulfillment_status: 'REFUND_OFFERED', state: 'OFFERED' })));
      const lateManual = +manualLate.n || 0;
      const levels = (stock && stock.levels) || {};
      const out = Object.keys(levels).filter((k) => levels[k].stockLevel === 'OUT').map((k) => k.replace('|||', ' · '));
      const low = Object.keys(levels).filter((k) => levels[k].stockLevel === 'LOW').map((k) => k.replace('|||', ' · ') + ' (' + levels[k].stock + ')');
      const hasTodos = await db.query('SELECT 1 FROM admin_todos LIMIT 1').then(() => true, () => false);
      res.json({
        ok: true,
        items: [
          { key: 'undelivered', icon: '⚠️', title: 'Paid but not delivered', count: +undelivered.n || 0, tone: 'bad', go: { view: 'orders', orders: 'undelivered' }, orders: Array.isArray(stuckList) ? stuckList : [] },
          { key: 'refundrequests', icon: '📨', title: 'Refund requests from customers', count: Array.isArray(refundRequests) ? refundRequests.length : 0, tone: 'bad', go: { view: 'refunds' }, orders: (Array.isArray(refundRequests) ? refundRequests : []).slice(0, 5).map((x) => ({ order_id: x.order_id, name: '', phone_norm: x.phone_norm, service: x.service, plan: x.plan, final_amount: Number(x.paid_amount) || 0, fulfillment_status: String(x.kind || '') === 'UNDELIVERED' ? 'NOT_DELIVERED' : 'DELIVERED' })) },
          { key: 'upirefunds', icon: '💸', title: 'Refunds to send (UPI)', count: toSend.length, tone: 'bad', go: { view: 'refunds' }, orders: toSend.slice(0, 5) },
          { key: 'refundchoice', icon: '⏳', title: 'Refunds: customer still choosing (coins / coupon or UPI)', count: choosing.length, tone: 'info', go: { view: 'refunds' }, orders: choosing.slice(0, 5) },
          credit.todayCard(recv),
          { key: 'manual', icon: '🛠', title: 'Manual plans to activate', count: +manual.n || 0, tone: lateManual ? 'bad' : 'warn', sub: lateManual ? lateManual + ' waiting over 48 h since payment' : '', late: lateManual, go: { view: 'orders', orders: 'manual' } },
          { key: 'unmatched', icon: '💸', title: 'Payments since go-live not matched to an order', count: +unmatched.n || 0, tone: 'warn', go: { view: 'bank' } },
          { key: 'ending', icon: '⏳', title: 'Plans ending in 3 days', count: +ending.n || 0, tone: 'warn', go: { view: 'reminders' }, list: endingList },
          { key: 'out', icon: '🔴', title: 'Plans out of stock', count: out.length, tone: 'bad', names: out, go: { view: 'stock' } },
          { key: 'low', icon: '🟡', title: 'Plans running low', count: low.length, tone: 'warn', names: low, go: { view: 'stock' } },
          // Unit = customers (people to log out); the subtitle says how many account logins they are on.
          expiredCard(expiredOn),
          { key: 'unpaid', icon: '🧾', title: 'Unpaid website checkouts (3 days)', count: +unpaid.n || 0, tone: 'info', go: { view: 'orders', orders: 'unpaid' } },
          { key: 'restock', icon: '🔔', title: 'Customers waiting for restock', count: +restock.n || 0, tone: 'info', go: { view: 'data', table: 'restock_requests' } },
        ],
        todos: hasTodos ? (todos || []) : null,
        needsSchema: !hasTodos,
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/todos', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const rows = await db.query('SELECT id, title, note, due_date, done, done_at, created_at FROM admin_todos ' + (req.query.all ? '' : 'WHERE done = 0 ') + 'ORDER BY done, due_date IS NULL, due_date, id DESC LIMIT 200', []);
      res.json({ ok: true, todos: rows });
    } catch (e) { fail(res, e); }
  });
  const dateOrNull = (v) => { const t = s(v); if (!t) return null; return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined; };
  app.post('/admin/api/todos', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const title = s(b.title).slice(0, 300);
    if (!title) return res.status(400).json({ ok: false, message: 'Write what needs doing.' });
    const due = dateOrNull(b.due_date);
    if (due === undefined) return res.status(400).json({ ok: false, message: 'Due date must look like 2026-09-20.' });
    try {
      const r = await db.query('INSERT INTO admin_todos (title, note, due_date) VALUES (?, ?, ?)', [title, s(b.note).slice(0, 2000) || null, due]);
      audit.record(req, { action: 'todo.add', entity: 'todo', id: r.insertId, summary: title });
      res.json({ ok: true, id: r.insertId });
    } catch (e) { fail(res, e); }
  });
  app.post('/admin/api/todos/update', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = parseInt(b.id, 10);
    if (!id) return res.status(400).json({ ok: false, message: 'id required' });
    const sets = []; const params = [];
    if (b.done != null) { const d = b.done === true || b.done === 1 || String(b.done) === 'true'; sets.push('done = ?', 'done_at = ' + (d ? 'NOW()' : 'NULL')); params.push(d ? 1 : 0); }
    if (b.title != null) { const t = s(b.title).slice(0, 300); if (!t) return res.status(400).json({ ok: false, message: 'Title cannot be empty.' }); sets.push('title = ?'); params.push(t); }
    if (b.note != null) { sets.push('note = ?'); params.push(s(b.note).slice(0, 2000) || null); }
    if (b.due_date != null) { const due = dateOrNull(b.due_date); if (due === undefined) return res.status(400).json({ ok: false, message: 'Due date must look like 2026-09-20.' }); sets.push('due_date = ?'); params.push(due); }
    if (!sets.length) return res.status(400).json({ ok: false, message: 'Nothing to change.' });
    try {
      const r = await db.query('UPDATE admin_todos SET ' + sets.join(', ') + ' WHERE id = ? LIMIT 1', [...params, id]);
      if (!r.affectedRows) return res.status(404).json({ ok: false, message: 'To-do not found.' });
      if (b.done != null) audit.record(req, { action: b.done ? 'todo.done' : 'todo.reopen', entity: 'todo', id });
      // A "💸 Send ₹X UPI refund" to-do ticked done = the money was sent: the order's refund is complete + customer told.
      let refund = null;
      if (b.done === true || b.done === 1 || String(b.done) === 'true') {
        try {
          refund = await refunds().onTodoDone(id);
          if (refund && refund.ok && !refund.already) audit.record(req, { action: 'order.refundUpiSent', entity: 'order', id: refund.orderId, summary: 'UPI refund sent ₹' + refund.amount + (refund.upi ? ' to ' + refund.upi : '') + ' (to-do ticked)' });
        } catch (e) { refund = { ok: false, message: String((e && e.message) || e) }; }
      }
      res.json(refund ? { ok: true, refund } : { ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/admin/api/todos/delete', async (req, res) => {
    if (!auth(req, res)) return;
    const id = parseInt((req.body || {}).id, 10);
    if (!id) return res.status(400).json({ ok: false, message: 'id required' });
    try {
      const r = await db.query('DELETE FROM admin_todos WHERE id = ? LIMIT 1', [id]);
      audit.record(req, { action: 'todo.delete', entity: 'todo', id });
      res.json({ ok: true, deleted: r.affectedRows || 0 });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/search', async (req, res) => {
    if (!auth(req, res)) return;
    const q = s(req.query.q);
    if (q.length < 2) return res.json({ ok: true, customers: [], orders: [], subs: [] });
    const like = '%' + q + '%';
    const digits = q.replace(/\D/g, '');
    // Phone parts only when the text has 3+ digits. Decided here in JS: comparing a parameter with a text literal in
    // SQL (? <> '...') failed live with "Illegal mix of collations" and broke the whole search.
    const phoneLike = digits.length >= 3 ? '%' + digits + '%' : null;
    const orPhone = (col) => (phoneLike ? ' OR ' + col + ' LIKE ?' : '');
    const withPhone = (arr) => (phoneLike ? arr.concat([phoneLike]) : arr);
    try {
      const [customers, orders, subs] = await Promise.all([
        db.query('SELECT customer_id, name, email, phone_norm FROM customers WHERE name LIKE ? OR email LIKE ? OR customer_id LIKE ?' + orPhone('phone_norm') + ' ORDER BY (name LIKE ?) DESC, name LIMIT 6', withPhone([like, like, like]).concat([q + '%'])),
        db.query('SELECT order_id, name, phone_norm, service, plan, final_amount, status, created_at_sheet FROM orders WHERE order_id LIKE ? OR txn_ref LIKE ? OR name LIKE ? OR email LIKE ?' + orPhone('phone_norm') + ' ORDER BY created_at_sheet DESC LIMIT 6', withPhone([like, like, like, like])),
        db.query('SELECT sub_id, phone_norm, service, plan, expiry_date, status, inventory_ref FROM subscriptions WHERE sub_id LIKE ? OR login_id LIKE ? OR inventory_ref LIKE ? OR email LIKE ?' + orPhone('phone_norm') + ' ORDER BY expiry_date DESC LIMIT 6', withPhone([like, like, like, like])),
      ]);
      res.json({ ok: true, customers, orders, subs });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/audit', async (req, res) => {
    if (!auth(req, res)) return;
    const q = s(req.query.q); const action = s(req.query.action);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const where = []; const params = [];
    if (q) { where.push('(entity_id LIKE ? OR summary LIKE ? OR action LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (action) { where.push('action LIKE ?'); params.push(action + '%'); }
    try {
      const rows = await db.query('SELECT id, ts, action, entity, entity_id, summary, details, ip FROM audit_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?', [...params, limit]);
      res.json({ ok: true, rows });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
