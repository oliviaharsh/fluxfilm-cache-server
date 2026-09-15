/**
 * FluxFilm - Admin panel v3: Customer 360 cards, Sheets-style grid, coupons, expiring.
 * GET /panel serves the dashboard; /admin/api/* return JSON. Key-protected.
 */

const TABLES = {
  orders:        { cols: '*', order: 'created_at_sheet DESC', phone: 'phone_norm', like: ['order_id'] },
  subscriptions: { cols: '*', order: 'expiry_date DESC', phone: 'phone_norm', like: ['sub_id'] },
  customers:     { cols: '*', order: 'created_at DESC', phone: 'phone_norm', like: ['name', 'email'] },
  coupons:       { cols: '*', order: 'code ASC', phone: null, like: ['code', 'description'] },
  wallet:        { cols: '*', order: 'coins_balance DESC', phone: 'phone_norm', like: [] },
  coupon_usage:  { cols: '*', order: 'ts DESC', phone: 'phone_norm', like: ['coupon_code', 'order_id'] },
  plans:         { cols: '*', order: 'service ASC', phone: null, like: ['service', 'plan'] },
  inventory_accounts: { cols: '*', order: 'service ASC', phone: null, like: ['account_id', 'login_id', 'service'] },
  inventory_profiles: { cols: '*', order: 'account_id ASC', phone: null, like: ['account_id', 'profile_name', 'current_sub_id'] },
  inventory_capacity: { cols: '*', order: 'account_id ASC', phone: null, like: ['account_id', 'service'] },
  bank_credits: { cols: '*', order: 'received_at DESC', phone: null, like: ['upi_ref', 'order_ids', 'consumed_order_id'] },
  restock_requests: { cols: '*', order: 'ts DESC', phone: 'phone_norm', like: ['service', 'plan'] },
  referrals: { cols: '*', order: 'created_at DESC', phone: 'friend_phone', like: ['code', 'referrer_phone', 'friend_order_id', 'status'] },
  referral_codes: { cols: '*', order: 'created_at DESC', phone: 'phone_norm', like: ['code'] },
};
const security = require('./security');

/**
 * Sheets filters: ?f=[{"col":"status","op":"eq","value":"ACTIVE"}, ...] (all must match).
 * Only real columns are accepted and every value is a bound parameter.
 * Returns an error message, or '' when the filters were added.
 */
const FILTER_OPS = ['contains', 'not_contains', 'eq', 'neq', 'empty', 'not_empty', 'gt', 'gte', 'lt', 'lte', 'before_now', 'after_now', 'next_days', 'last_days'];
function addFilters(raw, cols, parts, params) {
  if (raw == null || raw === '') return '';
  let list;
  try { list = JSON.parse(String(raw)); } catch (_) { return 'Filters could not be read.'; }
  if (!Array.isArray(list)) return 'Filters could not be read.';
  if (list.length > 12) return 'Too many filters (max 12).';
  for (const f of list) {
    const c = String((f && f.col) || '');
    const op = String((f && f.op) || '');
    if (!cols.includes(c)) return 'Unknown column: ' + c;
    if (!FILTER_OPS.includes(op)) return 'Unknown filter: ' + op;
    const col = '`' + c + '`';
    const text = 'COALESCE(CAST(' + col + ' AS CHAR), \'\')';
    const v = f.value == null ? '' : String(f.value).trim();
    const num = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    const days = Math.max(0, Math.min(3650, parseInt(v, 10) || 0));
    switch (op) {
      case 'contains': parts.push(text + ' LIKE ?'); params.push('%' + v + '%'); break;
      case 'not_contains': parts.push(text + ' NOT LIKE ?'); params.push('%' + v + '%'); break;
      case 'eq': parts.push('LOWER(' + text + ') = LOWER(?)'); params.push(v); break;
      case 'neq': parts.push('LOWER(' + text + ') <> LOWER(?)'); params.push(v); break;
      case 'empty': parts.push(text + " = ''"); break;
      case 'not_empty': parts.push(text + " <> ''"); break;
      case 'gt': parts.push(col + ' > ?'); params.push(num); break;
      case 'gte': parts.push(col + ' >= ?'); params.push(num); break;
      case 'lt': parts.push(col + ' < ?'); params.push(num); break;
      case 'lte': parts.push(col + ' <= ?'); params.push(num); break;
      case 'before_now': parts.push(col + ' < NOW()'); break;
      case 'after_now': parts.push(col + ' > NOW()'); break;
      case 'next_days': parts.push(col + ' BETWEEN NOW() AND NOW() + INTERVAL ? DAY'); params.push(days); break;
      case 'last_days': parts.push(col + ' BETWEEN NOW() - INTERVAL ? DAY AND NOW()'); params.push(days); break;
      default: break;
    }
  }
  return '';
}
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };

// Which tables can be edited, and the SHEET header column(s) that identify a row.
// Nothing is written back to Google Sheets any more — these header names survive
// only because raw_json is still keyed by them, so the editor labels fields the way
// the data is actually stored. bank_credits is MySQL-only → not editable.
const SHEETKEYS = {
  orders: ['OrderID'], subscriptions: ['SubID'], customers: ['Phone'], coupons: ['Code'],
  wallet: ['Phone'], plans: ['Service', 'Plan'], inventory_accounts: ['Service', 'AccountID'],
  inventory_profiles: ['AccountID', 'ProfileNumber'], inventory_capacity: ['Service', 'AccountID'],
  coupon_usage: ['OrderID', 'CouponCode'],
};
// The MySQL columns that uniquely identify a row (for the UPDATE ... WHERE). Edits
// write straight to MySQL now — MySQL is the master, nothing goes back to the Sheet.
const MYSQLKEYS = {
  orders: ['order_id'], subscriptions: ['sub_id'], customers: ['phone'], coupons: ['code'],
  wallet: ['phone'], plans: ['service', 'plan'], inventory_accounts: ['service', 'account_id'],
  inventory_profiles: ['account_id', 'profile_number'], inventory_capacity: ['service', 'account_id'],
  coupon_usage: ['order_id', 'coupon_code'],
};

function mountAdmin(app, deps) {
  // No callApiPhp here any more: every admin write goes straight to MySQL.
  // `sync` is still used, but only for its TABLES column mapping (sheet header ->
  // MySQL column), not to talk to the Sheet.
  const { db, ADMIN_KEY, sync } = deps;
  // Change log (audit_log, schema-v14). Never blocks or fails an admin action.
  const audit = deps.audit || require('./audit').makeAudit(db);
  // deps.env lets tests set ADMIN_PASSWORD; ADMIN_KEY (CACHE_CLEAR_KEY) still works for scripts via X-Admin-Key.
  const env = Object.assign({}, process.env, ADMIN_KEY ? { CACHE_CLEAR_KEY: ADMIN_KEY } : {}, deps.env || {});
  const auth = (req, res) => {
    if (!security.isAdmin(req, env)) { res.status(403).json({ ok: false, needLogin: true, message: 'Please sign in again.' }); return false; }
    // Cross-site writes: the cookie is SameSite=Strict, and a foreign Origin is refused too.
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && origin.replace(/^https?:\/\//, '') !== String(req.headers.host || '')) {
      res.status(403).json({ ok: false, message: 'Cross-site request refused.' }); return false;
    }
    return true;
  };

  // ---- Sign-in ----
  // At most 5 wrong passwords per IP per 15 min, and 40 site-wide per hour.
  const failsByIp = security.rateLimiter(5, 15 * 60e3);
  const failsAll = security.rateLimiter(40, 60 * 60e3);
  const weak = () => security.usingFallbackPassword(env) || security.adminPassword(env).length < 12;
  app.post('/admin/api/login', (req, res) => {
    const ip = security.clientIp(req);
    const pw = security.adminPassword(env);
    if (!pw) return res.status(503).json({ ok: false, message: 'ADMIN_PASSWORD is not set on the server.' });
    if (failsByIp.count(ip) >= 5 || failsAll.count('all') >= 40) {
      return res.status(429).json({ ok: false, message: 'Too many wrong attempts. Try again in 15 minutes.' });
    }
    const given = String((req.body || {}).password || '');
    if (!given || !security.safeEqual(given, pw)) {
      failsByIp.hit(ip); failsAll.hit('all');
      console.log('[admin] failed sign-in from', ip);
      audit.record(req, { action: 'login.failed', summary: 'Wrong admin password' });
      return res.status(401).json({ ok: false, message: 'Wrong password.' });
    }
    failsByIp.reset(ip);
    audit.record(req, { action: 'login.ok', summary: 'Signed in to the admin panel' });
    res.set('Set-Cookie', security.sessionCookie(req, security.makeSession(Date.now(), env), security.SESSION_HOURS * 3600));
    res.json({ ok: true, weakPassword: weak() });
  });
  app.post('/admin/api/logout', (req, res) => {
    res.set('Set-Cookie', security.sessionCookie(req, '', 0));
    res.json({ ok: true });
  });
  app.get('/admin/api/me', (req, res) => {
    const ok = security.isAdmin(req, env);
    // ip lets the owner check that rate limits see the real visitor address behind Hostinger's proxy.
    res.json(ok ? { ok, weakPassword: weak(), ip: security.clientIp(req), forwardedFor: req.headers['x-forwarded-for'] || '' } : { ok, weakPassword: weak() });
  });
  // WhatsApp / phone sales: quick new + renew orders, mark paid (quickorders.js).
  require('./quickorders').mount(app, Object.assign({ db, auth, audit }, deps.quick || {}));
  // 💳 Credit renewals: receivables, mark paid / partial / cancel, ✉️ reminder email + 💬 WhatsApp text (credit.js).
  require('./credit').mount(app, Object.assign({ db, auth, audit }, deps.credit || {}));
  // Order lookup + stock levels (adminlookup.js).
  require('./adminlookup').mount(app, Object.assign({ db, auth, audit }, deps.lookup || {}));
  // 📤 Exports: orders list + customer profiles to Excel (.xlsx) / CSV, with filters, limits and change log (adminexports.js).
  require('./adminexports').mount(app, Object.assign({ db, auth, audit }, deps.exports || {}));
  // Stuck orders: fulfil / re-fulfil, deliver manually, refund, erase (adminorderactions.js).
  require('./adminorderactions').mount(app, Object.assign({ db, auth, audit }, deps.orderActions || {}));
  // 🔁 Switch account on a live subscription (adminswitch.js). Mounted before adminexpired.js and the sub-removed
  // route below: it answers 🚪 Remove users ticks for switched-away (ghost) ids and passes every other id on.
  require('./adminswitch').mount(app, Object.assign({ db, auth, audit }, deps.switchAccount || {}));
  // 💸 Refunds v3: UPI refunds to send, refund offers on delivered plans, bonus % / offer days settings (adminrefunds.js).
  require('./adminrefunds').mount(app, Object.assign({ db, auth, audit }, deps.refundsAdmin || {}));
  // Today screen, to-dos, global search, change log viewer (adminhome.js).
  require('./adminhome').mount(app, Object.assign({ db, auth, audit }, deps.home || {}));
  // Password change (F5) + renewal reminders (accounttools.js).
  require('./accounttools').mount(app, Object.assign({ db, auth, audit }, deps.tools || {}));
  // Profit view + extend subscription days (profit.js).
  require('./profit').mount(app, Object.assign({ db, auth, audit }, deps.profit || {}));
  // Refer & earn settings, overview and "fix missed rewards" (adminreferrals.js).
  require('./adminreferrals').mount(app, Object.assign({ db, auth, audit }, deps.referrals || {}));
  // Coins: earning + paying with coins settings, overview, add/remove coins (admincoins.js).
  require('./admincoins').mount(app, Object.assign({ db, auth, audit }, deps.coins || {}));
  // 🎮 Games: free plays, prices, prizes, difficulty, questions, stats (admingames.js).
  require('./admingames').mount(app, Object.assign({ db, auth, audit }, deps.games || {}));
  // Payment fallback: backup UPI ID / QR settings + "I've paid" review queue (adminpayments.js).
  require('./adminpayments').mount(app, Object.assign({ db, auth, audit }, deps.payments || {}));
  // 🏦 Bank payments: unmatched since go-live, "Not a sale", link to an order (adminbankcredits.js).
  require('./adminbankcredits').mount(app, Object.assign({ db, auth, audit }, deps.bank || {}));
  // 🚪 Expired customers still on accounts (Sheet rule) + tick all subscriptions of an order removed (adminexpired.js).
  require('./adminexpired').mount(app, Object.assign({ db, auth, audit }, deps.expired || {}));
  // 📱 OTP devices: per OTP login account its customers + device names, 🚪 remove, copy names from the old Sheet (adminotpdevices.js).
  require('./adminotpdevices').mount(app, Object.assign({ db, auth, audit }, deps.otpDevices || {}));
  // Maintenance: pause / resume new orders (adminstore.js).
  require('./adminstore').mount(app, Object.assign({ db, auth, audit }, deps.store || {}));
  // 🤖 Olivia, the AI store manager: on/off, test phones, voice, recent chats (adminolivia.js).
  require('./adminolivia').mount(app, Object.assign({ db, auth, audit }, deps.olivia || {}));
  // Offers, banners, pop-ups (adminpromos.js).
  require('./adminpromos').mount(app, Object.assign({ db, auth, audit }, deps.promos || {}));
  // 🍿 What's new feed: posts, pictures, TMDB search / suggestions (adminfeed.js).
  require('./adminfeed').mount(app, Object.assign({ db, auth, audit }, deps.feed || {}));
  // Push notifications: renewal reminders settings, test, send, broadcast (adminpush.js).
  require('./adminpush').mount(app, Object.assign({ db, auth, audit }, deps.push || {}));
  // Email sender check + test email (adminmail.js).
  require('./adminmail').mount(app, Object.assign({ auth, audit }, deps.mail || {}));
  // Plans editor: builder, copy, on/off, safe delete (adminplans.js).
  require('./adminplans').mount(app, Object.assign({ db, auth, audit }, deps.plans || {}));
  // Go-live: safe one-time import of go's customers / orders / subscriptions (admincutover.js).
  require('./admincutover').mount(app, Object.assign({ db, auth, audit }, deps.cutover || {}));

  // Real column list per table (cached), so search can look at every column.
  const _colsCache = {};
  async function columnsOf(name) {
    if (_colsCache[name]) return _colsCache[name];
    const rows = await db.query("SELECT COLUMN_NAME c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND COLUMN_NAME NOT IN ('raw_json','logo_url') ORDER BY ORDINAL_POSITION", [name]);
    _colsCache[name] = rows.map((r) => r.c);
    return _colsCache[name];
  }

  app.get('/admin/api/summary', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const one = async (sql, p) => { const r = await db.query(sql, p || []); return r[0] || {}; };
      // "Active" everywhere means status ACTIVE **and not past expiry** (a sub whose
      // status was never flipped shouldn't count). NULL expiry is treated as active.
      const LIVE = "status='ACTIVE' AND (expiry_date IS NULL OR expiry_date > NOW())";
      const [cust, ord, sub, actCust, cpn, wal] = await Promise.all([
        one('SELECT COUNT(*) n FROM customers'),
        one("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status='PAID' THEN final_amount END),0) rev, SUM(status='PAID') paid FROM orders"),
        one("SELECT COUNT(*) n, SUM(" + LIVE + ") active, SUM(status='ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 7 DAY) expiring FROM subscriptions"),
        one('SELECT COUNT(DISTINCT phone_norm) n FROM subscriptions WHERE ' + LIVE),
        one('SELECT COUNT(*) n FROM coupons'),
        one('SELECT COALESCE(SUM(coins_balance),0) coins FROM wallet'),
      ]);
      res.json({ ok: true, kpis: {
        customers: +cust.n || 0, activeCustomers: +actCust.n || 0, orders: +ord.n || 0, paidOrders: +ord.paid || 0, revenue: +ord.rev || 0,
        subs: +sub.n || 0, activeSubs: +sub.active || 0, expiring7d: +sub.expiring || 0,
        coupons: +cpn.n || 0, coinsOutstanding: +wal.coins || 0,
      } });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/charts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [rev, svc, status] = await Promise.all([
        db.query("SELECT DATE(created_at_sheet) d, COALESCE(SUM(final_amount),0) rev, COUNT(*) n FROM orders WHERE status='PAID' AND created_at_sheet >= (CURDATE() - INTERVAL 29 DAY) GROUP BY DATE(created_at_sheet) ORDER BY d", []),
        db.query("SELECT service, COUNT(*) n, COALESCE(SUM(final_amount),0) rev FROM orders WHERE status='PAID' GROUP BY service ORDER BY n DESC LIMIT 8", []),
        db.query('SELECT status, COUNT(*) n FROM orders GROUP BY status ORDER BY n DESC', []),
      ]);
      res.json({ ok: true, revenueByDay: rev, serviceBreakdown: svc, statusBreakdown: status });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/expiring', async (req, res) => {
    if (!auth(req, res)) return;
    const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 7));
    try {
      const rows = await db.query(
        `SELECT sub_id, phone, email, service, plan, expiry_date FROM subscriptions
         WHERE status='ACTIVE' AND expiry_date IS NOT NULL
           AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL ? DAY
         ORDER BY expiry_date ASC LIMIT 300`, [days]);
      res.json({ ok: true, days, rows });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/table', async (req, res) => {
    if (!auth(req, res)) return;
    const name = String(req.query.name || ''); const cfg = TABLES[name];
    if (!cfg) return res.status(400).json({ ok: false, message: 'Unknown table' });
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const q = String(req.query.q || '').trim();
    const parts = []; const params = [];
    let allCols;
    try { allCols = await columnsOf(name); } catch (e) { return res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
    if (q && allCols.length) {
      // Search EVERY column (glued together), so a name, email, service, status,
      // account id — anything — matches. raw_json/logo_url are excluded.
      parts.push('CONCAT_WS(0x1f, ' + allCols.map((c) => "COALESCE(`" + c + "`,'')").join(', ') + ') LIKE ?');
      params.push('%' + q + '%');
    }
    const bad = addFilters(req.query.f, allCols, parts, params);
    if (bad) return res.status(400).json({ ok: false, message: bad });
    const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
    // Sort by any real column (click a header in the panel); falls back to the table default.
    let order = cfg.order;
    const sort = String(req.query.sort || '');
    if (sort) {
      if (allCols.includes(sort)) order = '`' + sort + '` ' + (String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC');
    }
    try {
      const rows = await db.query('SELECT ' + cfg.cols + ' FROM `' + name + '` ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', [...params, limit, offset]);
      const totalRow = await db.query('SELECT COUNT(*) n FROM `' + name + '` ' + where, params);
      const HIDE = new Set(['logo_url']);
      for (const r of rows) {
        let raw = {}; try { raw = r.raw_json ? JSON.parse(r.raw_json) : {}; } catch (_) { raw = {}; }
        delete r.raw_json;
        for (const k of Object.keys(r)) if (HIDE.has(k)) delete r[k];
        r.__raw = raw; // exact original Google-Sheet fields for the editor
      }
      // No rows (e.g. a filter matched nothing): still send the column list so filters can be edited.
      const columns = rows.length ? Object.keys(rows[0]).filter((c) => c !== '__raw') : allCols.slice();
      res.json({ ok: true, table: name, columns, rows, total: +(totalRow[0] || {}).n || 0, limit, offset, editable: !!SHEETKEYS[name], keys: SHEETKEYS[name] || [], mysqlKeys: MYSQLKEYS[name] || [] });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/customer', async (req, res) => {
    if (!auth(req, res)) return;
    const ph = norm(req.query.phone);
    if (!ph) return res.status(400).json({ ok: false, message: 'phone required' });
    try {
      const [profile, orders, subs, wallet] = await Promise.all([
        db.query('SELECT phone, name, email, member_since FROM customers WHERE phone_norm = ? LIMIT 1', [ph]),
        db.query('SELECT order_id, created_at_sheet, service, plan, final_amount, status, fulfillment_status FROM orders WHERE phone_norm = ? ORDER BY created_at_sheet DESC LIMIT 50', [ph]),
        db.query('SELECT * FROM subscriptions WHERE phone_norm = ? ORDER BY expiry_date DESC', [ph]),
        db.query('SELECT coins_balance, coins_lifetime, last_event FROM wallet WHERE phone_norm = ? ORDER BY coins_lifetime DESC, coins_balance DESC LIMIT 1', [ph]),
      ]);
      // 📱 Device name the owner typed for OTP services (raw_json DeviceName, otpdevices.js) — shown on the card.
      // A multi-device plan shows every device: "Device 1: LG TV · Device 2: Mi TV" (raw_json DeviceNames).
      for (const x of subs) { try { const t = require('./otpdevices').deviceNamesText(x.raw_json, x.device_count); if (t) x.device_name = t; } catch (_) { /* unreadable raw_json: no device name */ } delete x.raw_json; }
      // 💸 Refund credit (separate pot in coins_ledger, pays up to 100% of an order) — never blocks Customer 360.
      let refundCredit = 0;
      try { refundCredit = await require('./coins').creditBalance(ph); } catch (_) { refundCredit = 0; }
      res.json({ ok: true, phone: ph, profile: profile[0] || null, orders, subs, wallet: wallet[0] || null, refundCredit });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // Add / edit a coupon — straight into MySQL (coupons is master; nothing goes
  // to the Sheet any more).
  //
  // IMPORTANT: order.js couponDiscount() validates a coupon by reading ONLY
  // `raw_json`, so we write raw_json AND the typed columns. A coupon saved with
  // just the typed columns would show in the admin list but silently never apply
  // at checkout.
  // "Removed from account" tick (renewal rules F4): who we logged out, and when. The
  // renewal rule reads removed + removed_at. Times are India time, like every date here.
  app.post('/admin/api/sub-removed', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const sid = String(b.sub_id || '').trim();
    if (!sid) return res.status(400).json({ ok: false, message: 'sub_id required' });
    const removed = b.removed === true || b.removed === 1 || String(b.removed).toLowerCase() === 'true';
    let at = null;
    if (removed && String(b.removed_at || '').trim()) {
      const m = String(b.removed_at).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
      if (!m) return res.status(400).json({ ok: false, message: 'Use a date and time like 2026-09-01 14:30' });
      at = m[1] + ' ' + m[2] + ':' + (m[3] || '00');
    }
    try {
      const cols = await db.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'subscriptions' AND column_name IN ('removed', 'removed_at')", []);
      if (Number((cols[0] || {}).n) !== 2) return res.status(409).json({ ok: false, message: 'Run db/schema-v13.sql in phpMyAdmin first.' });
      // Keep raw_json's Sheet field in step, so editing the row elsewhere can't undo the tick.
      const flag = removed ? 'TRUE' : 'FALSE';
      const r = removed
        ? await db.query("UPDATE subscriptions SET removed = 1, removed_at = COALESCE(?, NOW()), raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.RemovedFromDevice', ?)) WHERE sub_id = ? LIMIT 1", [at, flag, sid])
        : await db.query("UPDATE subscriptions SET removed = 0, removed_at = NULL, raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.RemovedFromDevice', ?)) WHERE sub_id = ? LIMIT 1", [flag, sid]);
      if (!r || !r.affectedRows) return res.status(404).json({ ok: false, message: 'Subscription not found' });
      const row = await db.query('SELECT sub_id, removed, removed_at FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
      audit.record(req, { action: removed ? 'sub.removed' : 'sub.unremoved', entity: 'subscription', id: sid, summary: removed ? 'Ticked removed from account' + (at ? ' at ' + at : '') : 'Cleared removed tick' });
      res.json({ ok: true, sub: row[0] || null });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.post('/admin/api/coupon', async (req, res) => {
    if (!auth(req, res)) return;
    const p = req.body || {};
    const code = String(p.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, message: 'Coupon code required' });

    const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const int = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
    const str = (v) => String(v == null ? '' : v).trim();
    const bool = (v, dflt) => { const t = str(v).toUpperCase(); return (t === 'TRUE' || t === 'FALSE') ? t : dflt; };
    const expiry = str(p.expiry);

    // Sheet-header keyed, exactly as the sync mapping + couponDiscount expect.
    // Both `Code` and `CouponCode` are written because the Sheet used `Code`
    // while the sync mapping reads `CouponCode`.
    const raw = {
      Code: code, CouponCode: code,
      Description: str(p.description), Scope: str(p.scope).toUpperCase() || 'ANY',
      Type: str(p.type).toUpperCase() || 'FLAT', Value: num(p.value),
      MinAmount: num(p.minAmount), MaxDiscount: num(p.maxDiscount),
      Expiry: expiry, PerUserLimit: int(p.perUserLimit), GlobalLimit: int(p.globalLimit),
      Active: bool(p.active, 'TRUE'), ShowInProfile: bool(p.showInProfile, 'TRUE'),
      AllowedPhones: str(p.allowedPhones) || 'ALL', FirstTimeOnly: bool(p.firstTimeOnly, 'FALSE'),
    };

    try {
      await db.query(
        'INSERT INTO coupons (code, description, scope, type, value, min_amount, max_discount, expiry,' +
        ' per_user_limit, global_limit, active, show_in_profile, allowed_phones, first_time_only, raw_json)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)' +
        ' ON DUPLICATE KEY UPDATE description=VALUES(description), scope=VALUES(scope), type=VALUES(type),' +
        ' value=VALUES(value), min_amount=VALUES(min_amount), max_discount=VALUES(max_discount),' +
        ' expiry=VALUES(expiry), per_user_limit=VALUES(per_user_limit), global_limit=VALUES(global_limit),' +
        ' active=VALUES(active), show_in_profile=VALUES(show_in_profile), allowed_phones=VALUES(allowed_phones),' +
        ' first_time_only=VALUES(first_time_only), raw_json=VALUES(raw_json)',
        [code, raw.Description, raw.Scope, raw.Type, raw.Value, raw.MinAmount, raw.MaxDiscount,
          expiry || null, raw.PerUserLimit, raw.GlobalLimit, raw.Active, raw.ShowInProfile,
          raw.AllowedPhones, raw.FirstTimeOnly, JSON.stringify(raw)]);
      audit.record(req, { action: 'coupon.save', entity: 'coupon', id: code, summary: raw.Type + ' ' + raw.Value + ' · active ' + raw.Active, details: raw });
      res.json({ ok: true, code });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // Save a row: write STRAIGHT TO MySQL (MySQL is the master). Updates both the
  // typed columns and raw_json so reads that use either stay consistent. Nothing is
  // written back to the Google Sheet.
  app.post('/admin/api/row', async (req, res) => {
    if (!auth(req, res)) return;
    const body = req.body || {};
    const name = String(body.table || '');
    const raw = body.raw || {};          // sheet-header keyed (the editor fields)
    const keyvals = body.keyvals || {};  // MySQL key column → original value
    const cfg = TABLES[name]; const mkeys = MYSQLKEYS[name];
    const def = sync && sync.TABLES && sync.TABLES[name];
    if (!cfg || !mkeys || !def) return res.status(400).json({ ok: false, message: 'Table not editable' });
    for (const k of mkeys) { if (keyvals[k] == null || keyvals[k] === '') return res.status(400).json({ ok: false, message: 'Missing key: ' + k }); }
    try {
      // 🔒 Email lock: the admin may change a customer's email with no code (e.g. the old email is dead → "Contact Help").
      // The owner checked who they are, so the new address is saved as verified and the old one gets a notice.
      let emailNotice = null;
      if (name === 'customers' && Object.prototype.hasOwnProperty.call(raw, 'Email')) {
        try {
          const emaillock = require('./emaillock');
          const before = await db.query('SELECT name, email FROM customers WHERE phone = ? LIMIT 1', [keyvals.phone]);
          const oldEm = emaillock.normEmail(before && before[0] && before[0].email);
          const newEm = emaillock.normEmail(raw.Email);
          if (newEm && newEm !== oldEm) {
            Object.assign(raw, emaillock.verifiedFields(newEm, 'admin'), { EmailChangedAt: new Date().toISOString() });
            if (oldEm) { raw.PreviousEmail = oldEm; emailNotice = { oldEm, newEm, name: before[0].name }; }
          }
        } catch (e) { console.log('[email-lock] admin edit check skipped:', e.message); }
      }
      // sheet header -> { col, cast } from the sync mapping
      const rev = {};
      for (const [col, spec] of Object.entries(def.cols)) rev[spec[0]] = { col, cast: spec[1] };
      const sets = []; const params = []; const seen = new Set();
      for (const [header, val] of Object.entries(raw)) {
        const m = rev[header]; if (!m || seen.has(m.col)) continue; seen.add(m.col);
        sets.push('`' + m.col + '`=?'); params.push(m.cast ? m.cast(val) : val);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'Phone')) { sets.push('phone_norm=?'); params.push(norm(raw.Phone)); }
      sets.push('raw_json=?'); params.push(JSON.stringify(raw));
      if (!sets.length) return res.json({ ok: false, message: 'Nothing to update' });
      const where = mkeys.map((k) => '`' + k + '`=?').join(' AND ');
      const r = await db.query('UPDATE `' + name + '` SET ' + sets.join(', ') + ' WHERE ' + where + ' LIMIT 1', [...params, ...mkeys.map((k) => keyvals[k])]);
      audit.record(req, { action: 'row.edit', entity: name, id: mkeys.map((k) => keyvals[k]).join(' / '), summary: 'Edited in Sheets', details: raw });
      if (emailNotice && r && r.affectedRows) {
        Promise.resolve().then(() => require('./emaillock').notifyChanged(emailNotice.oldEm, emailNotice.newEm, emailNotice.name))
          .catch((e) => console.log('[email-lock] admin change notice failed:', e.message));
      }
      res.json({ ok: true, changed: (r && r.affectedRows) || 0 });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // Add a brand-new row straight into MySQL (e.g. a new plan / coupon / account).
  app.post('/admin/api/row-add', async (req, res) => {
    if (!auth(req, res)) return;
    const body = req.body || {};
    const name = String(body.table || ''); const raw = body.raw || {};
    const cfg = TABLES[name]; const mkeys = MYSQLKEYS[name];
    const def = sync && sync.TABLES && sync.TABLES[name];
    if (!cfg || !mkeys || !def) return res.status(400).json({ ok: false, message: 'Table not editable' });
    try {
      const rev = {};
      for (const [col, spec] of Object.entries(def.cols)) rev[spec[0]] = { col, cast: spec[1] };
      const cols = []; const vals = []; const seen = new Set();
      for (const [header, val] of Object.entries(raw)) {
        const m = rev[header]; if (!m || seen.has(m.col)) continue; seen.add(m.col);
        cols.push('`' + m.col + '`'); vals.push(m.cast ? m.cast(val) : val);
      }
      for (const k of mkeys) { if (!seen.has(k)) return res.json({ ok: false, message: 'Please fill the key field(s): ' + mkeys.join(', ') }); }
      if (Object.prototype.hasOwnProperty.call(raw, 'Phone')) { cols.push('phone_norm'); vals.push(norm(raw.Phone)); }
      cols.push('raw_json'); vals.push(JSON.stringify(raw));
      const sql = 'INSERT INTO `' + name + '` (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
      await db.query(sql, vals);
      audit.record(req, { action: 'row.add', entity: name, id: mkeys.map((k) => raw[Object.keys(rev).find((h) => rev[h].col === k)] || '').join(' / '), summary: 'Added in Sheets', details: raw });
      res.json({ ok: true });
    } catch (e) {
      const msg = /Duplicate/i.test(String(e && e.message)) ? 'A row with those key values already exists.' : String(e && e.message || e);
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // Delete a row by its key columns.
  app.post('/admin/api/row-delete', async (req, res) => {
    if (!auth(req, res)) return;
    const body = req.body || {};
    const name = String(body.table || ''); const keyvals = body.keyvals || {};
    const cfg = TABLES[name]; const mkeys = MYSQLKEYS[name];
    if (!cfg || !mkeys) return res.status(400).json({ ok: false, message: 'Table not editable' });
    for (const k of mkeys) { if (keyvals[k] == null || keyvals[k] === '') return res.status(400).json({ ok: false, message: 'Missing key: ' + k }); }
    try {
      const where = mkeys.map((k) => '`' + k + '`=?').join(' AND ');
      // Keep a copy of the deleted row in the change log (passwords/PINs masked) so it can be recovered.
      const before = await db.query('SELECT * FROM `' + name + '` WHERE ' + where + ' LIMIT 1', mkeys.map((k) => keyvals[k])).catch(() => []);
      const r = await db.query('DELETE FROM `' + name + '` WHERE ' + where + ' LIMIT 1', mkeys.map((k) => keyvals[k]));
      if (r && r.affectedRows) {
        const copy = Object.assign({}, before[0] || {}); delete copy.raw_json;
        audit.record(req, { action: 'row.delete', entity: name, id: mkeys.map((k) => keyvals[k]).join(' / '), summary: 'Deleted in Sheets', details: copy });
      }
      res.json({ ok: true, deleted: (r && r.affectedRows) || 0 });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // window.FF_VERSION added so the installed admin app can show "new version ready" (appversion.js).
  app.get('/panel', (_req, res) => res.type('html').send(appversion.page(path.join(__dirname, 'admin.html')) || PAGE));
}

// The panel page lives in admin.html (plain HTML/JS, no template-literal escaping).
const fs = require('fs');
const path = require('path');
const appversion = require('./appversion');
let PAGE;
try { PAGE = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); }
catch (e) { PAGE = '<!DOCTYPE html><title>FluxFilm Admin</title><p>admin.html is missing from the app folder.</p>'; }

module.exports = { mountAdmin };
