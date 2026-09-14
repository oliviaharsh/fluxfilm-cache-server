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

function mount(app, deps) {
  const { db, auth, audit } = deps;
  const catalog = () => deps.catalog || require('./catalog');
  const fail = (res, e) => res.status(missingTable(e) ? 409 : 500).json({ ok: false, needsSchema: missingTable(e), message: missingTable(e) ? SCHEMA_MSG : String((e && e.message) || e) });
  const one = async (sql, p) => { try { const r = await db.query(sql, p || []); return r[0] || {}; } catch (e) { return { error: e.message }; } };
  const many = async (sql, p) => { try { return await db.query(sql, p || []); } catch (e) { return []; } };

  app.get('/admin/api/today', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [unpaid, undelivered, manual, ending, endingList, expiredOn, restock, unmatched, todos, stock] = await Promise.all([
        // Checkouts started on the new site in the last 3 days but not paid: worth a nudge.
        one("SELECT COUNT(*) n FROM orders WHERE UPPER(status) = 'CREATED' AND source = 'node' AND created_at_sheet > NOW() - INTERVAL 3 DAY"),
        one("SELECT COUNT(*) n FROM orders o WHERE UPPER(o.status) = 'PAID' AND UPPER(COALESCE(o.fulfillment_status, '')) NOT IN ('FULFILLED', 'MANUAL_PENDING') AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.order_id = o.order_id) AND NOT (COALESCE(o.source, '') <> 'node' AND COALESCE(o.renew_sub_id, '') <> '' AND EXISTS (SELECT 1 FROM subscriptions r WHERE r.sub_id = o.renew_sub_id))"),
        one("SELECT COUNT(*) n FROM subscriptions WHERE UPPER(COALESCE(fulfillment_status, '')) = 'MANUAL_PENDING' AND UPPER(status) = 'ACTIVE'"),
        one("SELECT COUNT(*) n FROM subscriptions WHERE UPPER(status) = 'ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 3 DAY"),
        many("SELECT sub_id, phone_norm, service, plan, expiry_date FROM subscriptions WHERE UPPER(status) = 'ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 3 DAY ORDER BY expiry_date LIMIT 5"),
        one('SELECT COUNT(*) n FROM subscriptions WHERE expiry_date < NOW() AND expiry_date > NOW() - INTERVAL 60 DAY AND COALESCE(removed, 0) = 0'),
        one("SELECT COUNT(*) n FROM restock_requests WHERE UPPER(COALESCE(status, '')) <> 'DONE'"),
        one('SELECT COUNT(*) n FROM bank_credits WHERE consumed_order_id IS NULL AND received_at > NOW() - INTERVAL 14 DAY'),
        many('SELECT id, title, note, due_date, done, created_at FROM admin_todos WHERE done = 0 ORDER BY due_date IS NULL, due_date, id LIMIT 50'),
        catalog().getStockLevels().catch(() => ({ levels: {} })),
      ]);
      const levels = (stock && stock.levels) || {};
      const out = Object.keys(levels).filter((k) => levels[k].stockLevel === 'OUT').map((k) => k.replace('|||', ' · '));
      const low = Object.keys(levels).filter((k) => levels[k].stockLevel === 'LOW').map((k) => k.replace('|||', ' · ') + ' (' + levels[k].stock + ')');
      const hasTodos = await db.query('SELECT 1 FROM admin_todos LIMIT 1').then(() => true, () => false);
      res.json({
        ok: true,
        items: [
          { key: 'undelivered', icon: '⚠️', title: 'Paid but not delivered', count: +undelivered.n || 0, tone: 'bad', go: { view: 'orders', orders: 'undelivered' } },
          { key: 'manual', icon: '🛠', title: 'Manual plans to activate', count: +manual.n || 0, tone: 'warn', go: { view: 'orders', orders: 'manual' } },
          { key: 'unmatched', icon: '💸', title: 'Payments not matched to an order (14 days)', count: +unmatched.n || 0, tone: 'warn', go: { view: 'data', table: 'bank_credits' } },
          { key: 'ending', icon: '⏳', title: 'Plans ending in 3 days', count: +ending.n || 0, tone: 'warn', go: { view: 'reminders' }, list: endingList },
          { key: 'out', icon: '🔴', title: 'Plans out of stock', count: out.length, tone: 'bad', names: out, go: { view: 'stock' } },
          { key: 'low', icon: '🟡', title: 'Plans running low', count: low.length, tone: 'warn', names: low, go: { view: 'stock' } },
          { key: 'expired', icon: '🚪', title: 'Expired customers still on accounts', count: +expiredOn.n || 0, tone: 'warn', go: { view: 'stock' } },
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
      res.json({ ok: true });
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
    const phoneLike = digits.length >= 3 ? '%' + digits + '%' : '__no_match__';
    try {
      const [customers, orders, subs] = await Promise.all([
        db.query('SELECT customer_id, name, email, phone_norm FROM customers WHERE name LIKE ? OR email LIKE ? OR phone_norm LIKE ? OR customer_id LIKE ? ORDER BY (name LIKE ?) DESC, name LIMIT 6', [like, like, phoneLike, like, q + '%']),
        db.query('SELECT order_id, name, phone_norm, service, plan, final_amount, status, created_at_sheet FROM orders WHERE order_id LIKE ? OR txn_ref LIKE ? OR (? <> \'__no_match__\' AND phone_norm LIKE ?) ORDER BY created_at_sheet DESC LIMIT 6', [like, like, phoneLike, phoneLike]),
        db.query('SELECT sub_id, phone_norm, service, plan, expiry_date, status, inventory_ref FROM subscriptions WHERE sub_id LIKE ? OR login_id LIKE ? OR inventory_ref LIKE ? ORDER BY expiry_date DESC LIMIT 6', [like, like, like]),
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
