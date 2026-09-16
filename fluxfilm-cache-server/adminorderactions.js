/**
 * FluxFilm - admin actions for stuck orders (paid but not delivered). Mounted by admin.js, admin-only.
 *
 *   GET  /admin/api/order/actions?id=FF…     which actions fit this order now (+ last error, stock, refund info)
 *   POST /admin/api/order/fulfil             { orderId }                          run the normal delivery again
 *   POST /admin/api/order/manual-deliver     { orderId, login, password, profile, pin, accountRef, note, notify }
 *   POST /admin/api/order/refund             { orderId, amount, method: Coins|Coupon|UPI_ASK|UPI|Other, reference, note, notify }
 *   POST /admin/api/order/refund-upi-done    { orderId, reference, notify }        the customer's UPI refund was sent
 *   POST /admin/api/order/erase              { orderId, confirm: '<orderId>', reason }
 *
 * Rules (owner request 2026-09-15):
 *  - Only orders that were NOT delivered can be delivered again, refunded or erased. A delivered order is refused
 *    with a clear message (its customer still has a working login; that needs a human decision).
 *  - Fulfil reuses fulfill.js (same allocation lock, stock rules, device logins, renewals, email, coins). Old-site
 *    (imported) NEW orders are allowed from here; old-site renewals are not (use Deliver manually or Refund).
 *  - Refund and erase run in ONE transaction that also holds the allocation lock (ff_alloc), so a delivery can never
 *    run halfway through them. Coins and referral changes are made inside the same transaction.
 *  - Nothing important is lost: refund never deletes anything; erase first copies every row it touches into
 *    app_settings['erased_order_<id>'] (inside the same transaction) and writes the change log.
 *  - Every write keeps the typed columns AND raw_json in step (see CLAUDE.md).
 *  - Every action is idempotent: repeating it reports "already done" and changes nothing.
 */
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return Object.assign({}, v); try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + (n || 0)); return x; }
const maskPhone = (ph) => { const p = s(ph).replace(/\D/g, '').slice(-10); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };
const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

const LOCK = 'ff_alloc';                 // the same lock fulfill.js allocates under
// COINS = refund credit (pays up to 100%), COUPON = personal RF coupon, UPI_ASK = ask the customer (coins +10% or UPI ID),
// UPI / OTHER = already refunded outside FluxFilm, just recorded. See refunds.js.
const REFUND_METHODS = ['COINS', 'COUPON', 'UPI_ASK', 'UPI', 'OTHER'];
const METHOD_LABEL = { COINS: 'Coins', COUPON: 'Coupon', UPI_ASK: 'UPI_PENDING', UPI: 'UPI', OTHER: 'Other' };
const FAILED_STATES = ['FAILED', 'NO_STOCK', 'ERROR'];
const COOLDOWN_DAYS = Number(process.env.REUSE_COOLDOWN_DAYS || 10);

class Refused extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const refundsMod = require('./refunds');

/** A subscription row that really gave the customer something — shared rule in delivered.js (login, profile, invite, old-site import…). */
const { isDeliveredSub, DELIVERY_COLS } = require('./delivered');

/**
 * Which actions fit this order. Pure: used by the actions endpoint (buttons) AND as the guard of every write,
 * so the panel never offers something the server would refuse.
 */
function decide(o, subs) {
  const st = up(o.status); const fs = up(o.fulfillment_status);
  const legacy = s(o.source) !== 'node';
  const renew = up(o.order_type) === 'RENEW' && !!s(o.renew_sub_id);
  const delivered = fs === 'FULFILLED' || (subs || []).some(isDeliveredSub);
  const manualPending = fs === 'MANUAL_PENDING';
  const refunded = st === 'REFUNDED';
  const failed = FAILED_STATES.includes(fs);
  const no = (reason) => ({ allowed: false, reason });
  const deliveredMsg = 'This order was already delivered — the customer has a login. Refund or erase is not possible from here.';

  let fulfil;
  if (refunded) fulfil = no('This order was refunded.');
  else if (st !== 'PAID') fulfil = no('This order is not paid yet — mark it paid first.');
  else if (delivered) fulfil = no('Already delivered.');
  else if (manualPending) fulfil = no('Manual plan — activate it yourself, then use “Deliver manually”.');
  else if (legacy && renew) fulfil = no('Old-site renewal — use “Deliver manually” or “Refund”.');
  else fulfil = { allowed: true };
  fulfil.label = failed ? '🔁 Re-fulfil' : '▶️ Fulfil now';

  let manual;
  if (refunded) manual = no('This order was refunded.');
  else if (st !== 'PAID') manual = no('This order is not paid yet.');
  else if (delivered) manual = no('Already delivered.');
  else if (renew) manual = no('Renewals extend the existing subscription — use “Fulfil” (or Refund).');
  else manual = { allowed: true };

  let refund;
  if (refunded) refund = no('Already refunded.');
  else if (st !== 'PAID') refund = no('Only paid orders can be refunded.');
  else if (delivered) refund = no(deliveredMsg);
  else refund = { allowed: true, maxAmount: asNum(o.final_amount) };

  let erase;
  if (refunded) erase = no('Refunded orders are kept as a record of the refund.');
  else if (st !== 'PAID' && st !== 'CREATED') erase = no('Only unpaid or paid-but-not-delivered orders can be erased.');
  else if (delivered) erase = no(deliveredMsg);
  else erase = { allowed: true };

  // A cash refund the customer is choosing, or asked to be sent to their UPI ID: the owner marks it sent.
  const ri = refunded ? refundsMod.refundInfo(o) : null;
  const upiDone = ri && ri.kind === 'UPI_PENDING' ? { allowed: true, state: ri.state } : no(refunded ? 'No UPI refund is waiting.' : 'Not refunded.');

  // Refunds v3: a DELIVERED plan gets a refund OFFER the customer accepts in the app (refunds.js createOffer).
  let offer;
  if (refunded) offer = no('Already refunded.');
  else if (st !== 'PAID') offer = no('Only paid orders can be refunded.');
  else if (!delivered) offer = no('Not delivered — use 💸 Refund.');
  else offer = { allowed: true };

  // ⚡ Refund now (adminrefundnow.js): the owner already agreed it with the customer — delivered or not, one step.
  let refundNow;
  if (refunded) refundNow = no('Already refunded.');
  else if (st !== 'PAID') refundNow = no('Only paid orders can be refunded.');
  else if (!(asNum(o.final_amount) >= 1)) refundNow = no('This order cost ₹0 — use 💸 Refund.');
  else refundNow = { allowed: true };

  return { status: st, fulfillmentStatus: fs, legacy, renew, delivered, manualPending, refunded, failed, fulfil, manual, refund, erase, upiDone, offer, refundNow };
}

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const lazy = (name) => () => deps[name] || require('./' + name);
  const M = { fulfill: lazy('fulfill'), coins: lazy('coins'), referrals: lazy('referrals'), catalog: lazy('catalog'), mailer: lazy('mailer'), push: lazy('push'), pushreminders: lazy('pushreminders') };
  const now = () => (deps.now ? deps.now() : new Date());
  // Refund credit / coupon / ask-the-customer helpers + notifications (same injected push / mailer / coins as here).
  const R = deps.refunds || refundsMod.create({ db, coins: deps.coins, push: deps.push, mailer: deps.mailer, now: deps.now });

  const send = (res, e) => {
    if (e instanceof Refused) return res.status(e.status).json(Object.assign({ ok: false, message: e.message }, e.extra));
    if (missingTable(e)) return res.status(409).json({ ok: false, needsSchema: true, message: 'A database table is missing (run the latest db/schema-v*.sql files in phpMyAdmin): ' + e.message });
    return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };

  // One transaction on one connection, holding the allocation lock for its whole life.
  async function withLockedTx(fn) {
    const pool = db.getPool && db.getPool();
    if (!pool) throw new Error('DB not configured');
    const conn = await pool.getConnection();
    let locked = false;
    try {
      const [l] = await conn.query('SELECT GET_LOCK(?, ?) AS l', [LOCK, 15]);
      if (!l || !l[0] || Number(l[0].l) !== 1) throw new Refused(503, 'Busy delivering another order — try again in a few seconds.');
      locked = true;
      await conn.beginTransaction();
      try {
        const out = await fn(conn);
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        throw e;
      }
    } finally {
      if (locked) { try { await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]); } catch (_) {} }
      conn.release();
    }
  }
  const rowsOf = async (conn, sql, p) => { const [r] = await conn.query(sql, p); return r || []; };
  const optional = async (conn, sql, p) => { try { return await rowsOf(conn, sql, p); } catch (e) { if (missingTable(e)) return []; throw e; } };

  async function loadForUpdate(conn, orderId) {
    const o = (await rowsOf(conn, 'SELECT * FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [orderId]))[0];
    if (!o) return { o: null, subs: [] };
    const subs = await rowsOf(conn, 'SELECT * FROM subscriptions WHERE order_id = ? FOR UPDATE', [orderId]);
    return { o, subs };
  }
  const writeOrder = (conn, orderId, cols, raw) => {
    const keys = Object.keys(cols);
    return conn.query('UPDATE orders SET ' + keys.map((k) => '`' + k + '` = ' + (cols[k] === 'NOW()' ? 'NOW()' : '?')).join(', ') + ', raw_json = ? WHERE order_id = ? LIMIT 1',
      keys.filter((k) => cols[k] !== 'NOW()').map((k) => cols[k]).concat([JSON.stringify(raw), orderId]));
  };
  async function stockFor(service, plan) {
    try {
      const r = await M.catalog().getStockLevels();
      const lv = r && r.levels && r.levels[s(service) + '|||' + s(plan)];
      return lv ? { stock: lv.stock == null ? null : lv.stock, stockLevel: lv.stockLevel || '', source: lv.source || '' } : null;
    } catch (_) { return null; }
  }
  const orderIdOf = (req) => s((req.body || {}).orderId || (req.query || {}).id).toUpperCase();

  // ---------------------------------------------------------------- actions (what the panel may offer)
  app.get('/admin/api/order/actions', async (req, res) => {
    if (!auth(req, res)) return;
    const id = orderIdOf(req);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const o = (await db.query('SELECT order_id, service, plan, final_amount, status, fulfillment_status, order_type, renew_sub_id, source, phone_norm, raw_json FROM orders WHERE order_id = ? LIMIT 1', [id]))[0];
      if (!o) return res.status(404).json({ ok: false, message: 'No order ' + id });
      const subs = await db.query('SELECT sub_id, ' + DELIVERY_COLS + ' FROM subscriptions WHERE order_id = ?', [id]);
      const raw = rawOf(o.raw_json);
      const d = decide(o, subs);
      const out = {
        ok: true, orderId: o.order_id, service: o.service, plan: o.plan, amount: asNum(o.final_amount), actions: d,
        lastError: s(raw.LastFulfilError) || (d.failed ? 'An earlier delivery attempt failed (most likely no stock for ' + s(o.service) + ' ' + s(o.plan) + ' at that moment).' : ''),
        lastErrorAt: s(raw.LastFulfilAt),
        refulfilled: raw.Refulfilled === true, refulfilledAt: s(raw.RefulfilledAt), manualDelivered: raw.ManualDelivered === true,
      };
      if (d.refunded) {
        const ri = refundsMod.refundInfo(o);
        out.refund = { amount: ri.amount, method: ri.method, kind: ri.kind, state: ri.state, reference: ri.reference, note: s(raw.RefundNote), at: ri.at, coins: asNum(raw.RefundCoins), credit: ri.credit, bonus: ri.bonus, coupon: ri.coupon, couponExpiry: ri.couponExpiry, upi: ri.upi, todoId: ri.todoId, upiSentAt: s(raw.RefundUpiSentAt), delivered: ri.delivered, offerId: ri.offerId, charge: ri.charge, paid: ri.paid, reason: s(raw.RefundReason), byAdmin: ri.byAdmin };
      }
      if (d.fulfil.allowed || d.failed) out.stock = await stockFor(o.service, o.plan);
      res.json(out);
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- fulfil / re-fulfil
  app.post('/admin/api/order/fulfil', async (req, res) => {
    if (!auth(req, res)) return;
    const id = orderIdOf(req);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const o = (await db.query('SELECT order_id, service, plan, final_amount, status, fulfillment_status, order_type, renew_sub_id, source FROM orders WHERE order_id = ? LIMIT 1', [id]))[0];
      if (!o) throw new Refused(404, 'Order not found.');
      const subs = await db.query('SELECT sub_id, ' + DELIVERY_COLS + ' FROM subscriptions WHERE order_id = ?', [id]);
      const d = decide(o, subs);
      if (d.delivered) return res.json({ ok: true, already: true, orderId: id, message: '✅ Already delivered — nothing to do.' });
      if (!d.fulfil.allowed) throw new Refused(409, d.fulfil.reason);
      const f = (await M.fulfill().fulfillForAdmin(id, { allowLegacy: d.legacy })) || {};
      const result = up(f.fulfillment);
      const delivered = result === 'FULFILLED' || result === 'MANUAL_PENDING';
      // Keep raw_json in step with what fulfill.js wrote to the typed columns, and remember the last error.
      await withLockedTx(async (conn) => {
        const cur = (await rowsOf(conn, 'SELECT fulfillment_status, raw_json FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [id]))[0];
        if (!cur) return;
        const raw = rawOf(cur.raw_json);
        const at = fmtDt(now());
        if (delivered) {
          Object.assign(raw, { FulfillmentStatus: up(cur.fulfillment_status) || result, FulfilledAt: raw.FulfilledAt || at });
          if (d.failed) Object.assign(raw, { Refulfilled: true, RefulfilledAt: at });
        } else {
          Object.assign(raw, { LastFulfilError: s(f.fulfillError || f.message).slice(0, 300), LastFulfilAt: at });
          if (cur.fulfillment_status != null) raw.FulfillmentStatus = up(cur.fulfillment_status);
        }
        await conn.query('UPDATE orders SET raw_json = ? WHERE order_id = ? LIMIT 1', [JSON.stringify(raw), id]);
      });
      audit.record(req, { action: d.failed ? 'order.refulfil' : 'order.fulfil', entity: 'order', id, summary: (d.failed ? 'Re-fulfil' : 'Fulfil') + ' → ' + (result || 'ERROR') + (delivered ? '' : ': ' + s(f.message).slice(0, 200)) });
      const out = { ok: true, orderId: id, fulfillment: result || 'ERROR', delivered, refulfilled: delivered && d.failed, message: f.message || '', result: f };
      if (!delivered) out.stock = await stockFor(o.service, o.plan);
      res.json(out);
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- deliver manually (owner typed the login)
  app.post('/admin/api/order/manual-deliver', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = orderIdOf(req);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    const login = s(b.login).slice(0, 190); const password = s(b.password).slice(0, 190);
    const profile = s(b.profile).slice(0, 60); const pin = s(b.pin).slice(0, 20); const note = s(b.note).slice(0, 300);
    const accountRef = s(b.accountRef).slice(0, 60);
    if (!login) return res.status(400).json({ ok: false, field: 'login', message: 'Type the login (email / phone) you gave the customer.' });
    try {
      const done = await withLockedTx(async (conn) => {
        const { o, subs } = await loadForUpdate(conn, id);
        if (!o) throw new Refused(404, 'Order not found.');
        const d = decide(o, subs);
        if (d.delivered) return { already: true, o };
        if (!d.manual.allowed) throw new Refused(409, d.manual.reason);
        const start = now();
        const days = asNum(o.duration_days) || 30;
        const expiry = addDays(start, days);
        const release = addDays(expiry, COOLDOWN_DAYS);
        const pno = (accountRef.match(/#P(\d+)$/i) || [])[1] || '';
        const accountId = accountRef ? accountRef.replace(/#P\d+$/i, '') : '';
        const devices = Math.max(1, asNum(o.device_count) || 1);
        const placeholder = subs.find((x) => !isDeliveredSub(x));
        let subId;
        if (placeholder) {
          // Manual plan: fill in the MANUAL_PENDING row fulfilment created, instead of adding a second one.
          subId = placeholder.sub_id;
          const sraw = placeholder.raw_json == null ? null : Object.assign(rawOf(placeholder.raw_json), { Status: 'ACTIVE', FulfillmentStatus: 'FULFILLED', LoginId: login, Password: password, ProfileName: profile, ProfilePIN: pin, InventoryRef: accountRef, AccountID: accountId, ExpiryDate: fmtDt(expiry) });
          await conn.query(
            "UPDATE subscriptions SET status = 'ACTIVE', fulfillment_status = 'FULFILLED', login_id = ?, password = ?, profile_name = ?, profile_pin = ?, profile_number = ?, inventory_ref = ?, account_id = ?, start_date = ?, expiry_date = ?, release_eligible_at = ?, fulfilled_at = NOW(), notes = ?" + (sraw ? ', raw_json = ?' : '') + ' WHERE sub_id = ? LIMIT 1',
            [login, password, profile, pin, pno, accountRef || null, accountId || null, fmtDt(start), fmtDt(expiry), fmtDt(release), note ? 'Manual delivery: ' + note : 'Manual delivery'].concat(sraw ? [JSON.stringify(sraw)] : []).concat([subId]));
        } else {
          subId = await freeSubIdOn(conn);
          await conn.query(
            `INSERT INTO subscriptions (sub_id, order_id, phone, phone_norm, email, service, plan, duration_days,
               start_date, expiry_date, status, fulfillment_status, order_type, inventory_ref, account_id,
               login_id, password, profile_number, profile_name, profile_pin, device_type, device_count, tv_count, release_eligible_at, fulfilled_at, notes, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'FULFILLED', 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'node')`,
            [subId, o.order_id, o.phone, o.phone_norm, o.email, o.service, o.plan, days, fmtDt(start), fmtDt(expiry), accountRef || null, accountId || null,
              login, password, pno, profile, pin, ['TV', 'NON_TV', 'MIXED'].includes(up(o.extra_field_value)) ? up(o.extra_field_value) : '', devices, o.tv_count == null ? null : asNum(o.tv_count), fmtDt(release), note ? 'Manual delivery: ' + note : 'Manual delivery']);
        }
        const raw = rawOf(o.raw_json);
        const at = fmtDt(start);
        Object.assign(raw, { FulfillmentStatus: 'FULFILLED', FulfilledAt: at, ManualDelivered: true, ManualDeliveredAt: at, ManualDeliveryNote: note });
        if (d.failed) Object.assign(raw, { Refulfilled: true, RefulfilledAt: at });
        await writeOrder(conn, id, { fulfillment_status: 'FULFILLED', fulfilled_at: 'NOW()' }, raw);
        return { o, subId, expiry: fmtDt(expiry), failed: d.failed };
      });
      if (done.already) return res.json({ ok: true, already: true, orderId: id, message: '✅ Already delivered — nothing changed.' });
      const o = done.o;
      audit.record(req, { action: 'order.manualDeliver', entity: 'order', id, summary: 'Delivered by hand → ' + done.subId + (accountRef ? ' on ' + accountRef : '') + (note ? ' · ' + note : ''), details: { subId: done.subId, accountRef, profile, note } });
      // Same after-delivery steps as fulfill.js: coins (idempotent per order) + email + push. Never block the answer.
      const payload = { event: 'NEW_PURCHASE', orderId: id, phone: o.phone, email: o.email, name: o.name, service: o.service, plan: o.plan, amount: o.final_amount, expiry: done.expiry, access: { user: esc(login), pass: esc(password), profileName: esc(profile), profilePin: esc(pin) } };
      Promise.resolve().then(() => M.coins().awardCoins(payload)).catch((e) => console.log('[order-actions] coins failed:', e.message));
      if (b.notify !== false) {
        Promise.resolve().then(() => M.mailer().sendAccessEmail(payload)).catch((e) => console.log('[order-actions] email failed:', e.message));
        Promise.resolve().then(() => M.pushreminders().notifyDelivered(payload)).catch(() => {});
      }
      res.json({ ok: true, orderId: id, subId: done.subId, expiry: done.expiry, refulfilled: done.failed, message: '✅ Delivered. ' + (b.notify !== false ? 'The customer was emailed the login.' : 'No email sent.') });
    } catch (e) { send(res, e); }
  });

  async function freeSubIdOn(conn) {
    for (let i = 0; i < 8; i++) {
      const id = 'SUB-' + String(require('crypto').randomInt(0, 1e9)).padStart(9, '0');
      if (!(await rowsOf(conn, 'SELECT 1 FROM subscriptions WHERE sub_id = ? LIMIT 1', [id])).length) return id;
    }
    return 'SUB-' + String(Date.now()).slice(-9);
  }

  // Undo what a paid-but-undelivered order holds: coupon redemption, coins, referral rewards. Same transaction.
  async function releaseHolds(conn, o, why) {
    const coupons = await optional(conn, "UPDATE coupon_usage SET action = 'RELEASED', raw_json = JSON_SET(COALESCE(raw_json, JSON_OBJECT()), '$.Action', 'RELEASED') WHERE order_id = ? AND UPPER(action) = 'USED'", [o.order_id]);
    const coins = await M.coins().undoOrderCoinsOn(conn, o.order_id, o.phone_norm, why);
    const referral = await M.referrals().cancelForOrderOn(conn, o.order_id, why);
    return { couponsReleased: (coupons && coupons.affectedRows) || 0, coins, referral };
  }

  // ---------------------------------------------------------------- refund
  app.post('/admin/api/order/refund', (req, res) => handleRefund(req, res, false));
  // Internal use by admin 📨 Refund requests → "Approve full refund" (adminrefunds.js, which checked the admin key):
  // the very same checks, allocation lock, holds release and customer notices as the button. → { status, body }.
  app.locals.ffOrderRefund = (req, body) => new Promise((resolve) => {
    const fakeReq = { body: body || {}, query: {}, ip: req && req.ip, socket: req && req.socket, headers: (req && req.headers) || {} };
    const out = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, body: o }); return this; } };
    handleRefund(fakeReq, out, true).catch((e) => resolve({ status: 500, body: { ok: false, message: String((e && e.message) || e) } }));
  });
  async function handleRefund(req, res, trusted) {
    if (!trusted && !auth(req, res)) return;
    const b = req.body || {};
    const id = orderIdOf(req);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    const method = up(b.method);
    if (!REFUND_METHODS.includes(method)) return res.status(400).json({ ok: false, field: 'method', message: 'Choose how to refund: Coins (refund credit), Coupon, Ask the customer (UPI), UPI already sent, or Other.' });
    const reference = s(b.reference).slice(0, 120); const note = s(b.note).slice(0, 300);
    try {
      const done = await withLockedTx(async (conn) => {
        const { o, subs } = await loadForUpdate(conn, id);
        if (!o) throw new Refused(404, 'Order not found.');
        const d = decide(o, subs);
        const raw = rawOf(o.raw_json);
        if (d.refunded) return { already: true, o, raw };
        if (!d.refund.allowed) throw new Refused(409, d.refund.reason);
        const max = asNum(o.final_amount);
        let amount = (b.amount === '' || b.amount == null) ? max : Math.round(asNum(b.amount) * 100) / 100;
        // A ₹0 order (paid with refund credit / coupon / coins): refunding it just gives those back.
        let how = method;
        if (max === 0) { amount = 0; how = 'OTHER'; }
        else if (!(amount > 0) || amount > max) throw new Refused(400, 'Refund amount must be more than ₹0 and at most ₹' + max + '.', { field: 'amount' });
        if ((how === 'COINS' || how === 'COUPON') && Math.round(amount) !== amount) throw new Refused(400, 'Coins and coupon refunds need a whole rupee amount.', { field: 'amount' });
        const at = fmtDt(now());
        const methodLabel = METHOD_LABEL[how];
        Object.assign(raw, { Status: 'REFUNDED', FulfillmentStatus: 'REFUNDED', RefundedAt: at, RefundAmount: amount, RefundMethod: methodLabel, RefundRef: reference, RefundNote: note, PreviousFulfillmentStatus: up(o.fulfillment_status) });
        raw.RefundState = how === 'UPI_ASK' ? 'ASK_CUSTOMER' : 'DONE';
        // A manual plan's placeholder row (no login) must stop counting as "to activate".
        for (const x of subs.filter((x) => !isDeliveredSub(x))) {
          const sraw = x.raw_json == null ? null : Object.assign(rawOf(x.raw_json), { Status: 'CANCELLED', FulfillmentStatus: 'REFUNDED' });
          await conn.query("UPDATE subscriptions SET status = 'CANCELLED', fulfillment_status = 'REFUNDED'" + (sraw ? ', raw_json = ?' : '') + ' WHERE sub_id = ? LIMIT 1', (sraw ? [JSON.stringify(sraw)] : []).concat([x.sub_id]));
        }
        const holds = await releaseHolds(conn, o, 'order ' + id + ' refunded');
        let credit = 0; let coupon = null;
        if (how === 'COINS') {
          // ₹1 = 1 refund credit, separate from normal coins; it can pay the full price of the next order (coins.js).
          const c = await M.coins().addRefundCreditOn(conn, { orderId: id, phone: o.phone_norm, credit: amount, service: o.service, plan: o.plan, amount, note: 'Refund for order ' + id + (note ? ': ' + note : '') });
          if (!c.ok) throw new Refused(400, 'This order has no phone number — refund credit needs one. Use Coupon, UPI or Other.');
          credit = c.credit;
          Object.assign(raw, { RefundCredit: credit, RefundCoins: credit });
        }
        if (how === 'COUPON') {
          if (!s(o.phone_norm)) throw new Refused(400, 'This order has no phone number — a refund coupon needs one. Use UPI or Other.');
          coupon = await R.createRefundCouponOn(conn, { orderId: id, phone: o.phone_norm, amount });
          Object.assign(raw, { RefundCoupon: coupon.code, RefundCouponExpiry: coupon.expiry });
        }
        await writeOrder(conn, id, { status: 'REFUNDED', fulfillment_status: 'REFUNDED' }, raw);
        return { o, raw, amount, how, methodLabel, credit, coupon, holds, placeholders: subs.length };
      });
      const o = done.o;
      if (done.already) return res.json({ ok: true, already: true, orderId: id, message: 'Already refunded on ' + s(done.raw.RefundedAt) + '.', refund: { amount: asNum(done.raw.RefundAmount), method: s(done.raw.RefundMethod), at: s(done.raw.RefundedAt) } });
      const h = done.holds;
      const paidRewards = (h.referral && h.referral.alreadyPaid) || [];
      audit.record(req, {
        action: 'order.refund', entity: 'order', id,
        summary: 'Refunded ₹' + done.amount + ' by ' + done.methodLabel + (done.coupon ? ' ' + done.coupon.code : '') + (reference ? ' (' + reference + ')' : '') + (note ? ' · ' + note : '') + ' · was ' + (up(o.fulfillment_status) || 'PENDING'),
        details: { amount: done.amount, method: done.methodLabel, reference, note, refundCredit: done.credit, coupon: done.coupon, coins: h.coins, referral: h.referral, couponsReleased: h.couponsReleased },
      });
      // Coins / coupon chosen by the customer get the admin bonus % (💸 Refunds → settings); the owner's direct Coins / Coupon do not.
      const bonusPct = done.how === 'UPI_ASK' ? (await R.getSettings().catch(() => ({ bonusPercent: refundsMod.BONUS_PERCENT }))).bonusPercent : refundsMod.BONUS_PERCENT;
      if (b.notify !== false) {
        if (done.how === 'COINS') R.notify(o, 'CREDIT', { amount: done.amount, credit: done.credit });
        else if (done.how === 'COUPON') R.notify(o, 'COUPON', { amount: done.amount, coupon: done.coupon.code, expiry: done.coupon.expiry });
        else if (done.how === 'UPI_ASK') R.notify(o, 'ASK', { amount: done.amount, credit: refundsMod.bonusCredit(done.amount, bonusPct), bonusPercent: bonusPct });
        else R.notify(o, 'RECORDED', { amount: done.amount, how: done.how === 'UPI' ? 'to your UPI' : '' });
      }
      const notes = [];
      if (h.coins && h.coins.returned) notes.push(h.coins.returned + ' coins used on this order were given back.');
      if (h.coins && h.coins.creditReturned) notes.push('₹' + h.coins.creditReturned + ' refund credit used on this order was given back.');
      if (h.coins && h.coins.reversed) notes.push(h.coins.reversed + ' coins earned on it were taken back.');
      if (h.coins && h.coins.reverseShort) notes.push(h.coins.reverseShort + ' earned coins were already spent and could not be taken back.');
      if (done.credit) notes.push('₹' + done.credit + ' refund credit added — the customer can use it on any plan (up to the full price).');
      if (done.coupon) notes.push('Coupon ' + done.coupon.code + ' (₹' + done.coupon.value + ' off, single use, this phone only, until ' + done.coupon.expiry.slice(0, 10) + ') created.');
      if (done.how === 'UPI_ASK') notes.push('The customer chooses on their home screen: ' + refundsMod.bonusCredit(done.amount, bonusPct) + ' coins or a ₹' + refundsMod.bonusCredit(done.amount, bonusPct) + ' coupon (+' + bonusPct + '%), or exactly ₹' + done.amount + ' to their UPI. If they choose UPI it appears in 💸 Refunds to send (and a Today to-do).');
      if (done.how === 'OTHER' && method !== 'OTHER') notes.push('This order cost ₹0, so nothing new was credited — what paid for it was given back.');
      if (h.referral && h.referral.cancelled) notes.push(h.referral.cancelled + ' unpaid referral reward(s) cancelled.');
      if (paidRewards.length) notes.push('Referral reward already paid: ' + paidRewards.map((x) => x.coins + ' coins to ' + x.to).join(', ') + ' — remove them in 🪙 Coins if you want.');
      if (h.couponsReleased) notes.push('Coupon use released.');
      const label = { COINS: 'refund credit', COUPON: 'coupon ' + (done.coupon ? done.coupon.code : ''), UPI_ASK: 'waiting for the customer to choose', UPI: 'UPI', OTHER: 'Other' }[done.how];
      res.json({ ok: true, orderId: id, status: 'REFUNDED', amount: done.amount, method: done.methodLabel, refundCredit: done.credit, coinsCredited: done.credit, coupon: done.coupon, holds: h, notes, message: '💸 Refund recorded (₹' + done.amount + ', ' + label + ').' });
    } catch (e) { send(res, e); }
  }

  // ---------------------------------------------------------------- ⚡ Refund now (adminrefundnow.js)
  // Same allocation lock, holds release and refund helpers as the refund above.
  require('./adminrefundnow').mount(app, { db, auth, audit, now, coins: M.coins, R, withLockedTx, releaseHolds, decide, rowsOf, send, Refused });

  // ---------------------------------------------------------------- the customer's UPI refund was sent
  app.post('/admin/api/order/refund-upi-done', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = orderIdOf(req);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const r = await R.completeUpi({ orderId: id, reference: b.reference, via: 'admin', notify: b.notify !== false });
      if (!r.ok) return res.status(r.status || 409).json(r);
      if (!r.already) audit.record(req, { action: 'order.refundUpiSent', entity: 'order', id, summary: 'UPI refund sent ₹' + r.amount + (r.upi ? ' to ' + r.upi : '') + (s(b.reference) ? ' (' + s(b.reference).slice(0, 120) + ')' : '') });
      res.json(r);
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- erase (marked paid by mistake)
  app.post('/admin/api/order/erase', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = orderIdOf(req);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    if (up(b.confirm) !== id) return res.status(400).json({ ok: false, field: 'confirm', message: 'Type the order ID (' + id + ') to confirm.' });
    const reason = s(b.reason).slice(0, 300);
    if (!reason) return res.status(400).json({ ok: false, field: 'reason', message: 'Write why this order is being erased (it is kept in the change log).' });
    const backupKey = ('erased_order_' + id).slice(0, 64);
    try {
      const done = await withLockedTx(async (conn) => {
        const { o, subs } = await loadForUpdate(conn, id);
        if (!o) {
          const prev = await optional(conn, 'SELECT setting_key FROM app_settings WHERE setting_key = ? LIMIT 1', [backupKey]);
          if (prev.length) return { already: true };
          throw new Refused(404, 'Order not found.');
        }
        const d = decide(o, subs);
        if (!d.erase.allowed) throw new Refused(409, d.erase.reason);
        // 1) Copy EVERY row this touches, in the same transaction, before changing anything.
        const backup = {
          erasedAt: fmtDt(now()), reason, order: o, subscriptions: subs,
          bankCredits: await rowsOf(conn, 'SELECT * FROM bank_credits WHERE consumed_order_id = ? FOR UPDATE', [id]),
          bankCreditLinks: await optional(conn, 'SELECT * FROM bank_credit_links WHERE order_id = ?', [id]),
          couponUsage: await optional(conn, 'SELECT * FROM coupon_usage WHERE order_id = ?', [id]),
          coinSpends: await optional(conn, 'SELECT * FROM coin_spends WHERE order_id = ?', [id]),
          coinsLedger: await optional(conn, 'SELECT * FROM coins_ledger WHERE order_id = ?', [id]),
          referralRewards: await optional(conn, 'SELECT * FROM referral_rewards WHERE order_id = ?', [id]),
          referralLink: await optional(conn, 'SELECT * FROM referrals WHERE friend_order_id = ?', [id]),
          paymentClaims: await optional(conn, 'SELECT * FROM payment_claims WHERE order_id = ?', [id]),
        };
        const json = JSON.stringify(backup);
        if (json.length > 60000) throw new Refused(409, 'This order has too much linked data to erase safely from here (' + json.length + ' characters). Refund it instead.');
        await conn.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [backupKey, json]);
        // 2) Give back what the order held.
        const holds = await releaseHolds(conn, o, 'order ' + id + ' erased (marked paid by mistake)');
        // 3) The real payment can now match the right order.
        const [bc] = await conn.query('UPDATE bank_credits SET consumed_order_id = NULL WHERE consumed_order_id = ?', [id]);
        // 🧾 If one transfer paid for this order AND others (banklinks.js), take only this order out of it: the
        // payment stays linked to the orders that are left, and is only freed when nothing is left.
        let splitFreed = 0;
        try {
          const cids = [...new Set((await rowsOf(conn, 'SELECT credit_id FROM bank_credit_links WHERE order_id = ?', [id])).map((r) => Number(r.credit_id)).filter(Boolean))];
          if (cids.length) await conn.query('DELETE FROM bank_credit_links WHERE order_id = ?', [id]);
          for (const cid of cids) {
            const left = await rowsOf(conn, 'SELECT order_id FROM bank_credit_links WHERE credit_id = ? ORDER BY id', [cid]);
            if (left.length) await conn.query('UPDATE bank_credits SET consumed_order_id = ? WHERE id = ?', [String(left[0].order_id), cid]);
            if (left.length <= 1) await conn.query('DELETE FROM bank_credit_links WHERE credit_id = ?', [cid]);
            splitFreed++;
          }
        } catch (e) { if (!missingTable(e)) throw e; }
        await optional(conn, "UPDATE payment_claims SET status = 'REJECTED', reason = ?, updated_at = NOW() WHERE order_id = ? AND status IN ('WAITING', 'REVIEW')", ['Order erased by FluxFilm', id]);
        // 4) Placeholder subscription rows (never delivered), then the order itself.
        const [sd] = await conn.query("DELETE FROM subscriptions WHERE order_id = ? AND COALESCE(login_id, '') = '' AND UPPER(COALESCE(fulfillment_status, '')) <> 'FULFILLED'", [id]);
        const [od] = await conn.query('DELETE FROM orders WHERE order_id = ? LIMIT 1', [id]);
        if (!od || od.affectedRows !== 1) throw new Error('The order row could not be deleted — nothing was changed.');
        return { o, holds, creditsFreed: (bc && bc.affectedRows) || 0, splitFreed, subsDeleted: (sd && sd.affectedRows) || 0, backup };
      });
      if (done.already) return res.json({ ok: true, already: true, orderId: id, message: 'Already erased (a backup copy is kept as ' + backupKey + ').' });
      const o = done.o;
      const h = done.holds;
      audit.record(req, {
        action: 'order.erase', entity: 'order', id,
        summary: 'Erased: ' + reason + ' · ' + s(o.service) + ' ' + s(o.plan) + ' ₹' + asNum(o.final_amount) + ' · ' + maskPhone(o.phone_norm) + ' · was ' + up(o.status) + '/' + (up(o.fulfillment_status) || '-') + ' · backup app_settings.' + backupKey,
        details: { backupKey, reason, creditsFreed: done.creditsFreed, splitFreed: done.splitFreed, subsDeleted: done.subsDeleted, coins: h.coins, referral: h.referral, couponsReleased: h.couponsReleased, order: Object.assign({}, o, { raw_json: undefined }) },
      });
      const notes = [];
      if (done.creditsFreed) notes.push(done.creditsFreed + ' bank payment(s) are unmatched again and can be matched to the right order.');
      if (h.coins && h.coins.returned) notes.push(h.coins.returned + ' coins used on it were given back.');
      if (h.coins && h.coins.reversed) notes.push(h.coins.reversed + ' coins earned on it were taken back.');
      if (h.referral && h.referral.cancelled) notes.push(h.referral.cancelled + ' unpaid referral reward(s) cancelled.');
      if (h.referral && h.referral.alreadyPaid && h.referral.alreadyPaid.length) notes.push('Referral reward already paid: ' + h.referral.alreadyPaid.map((x) => x.coins + ' coins to ' + x.to).join(', ') + ' — remove them in 🪙 Coins if you want.');
      if (done.subsDeleted) notes.push(done.subsDeleted + ' undelivered placeholder subscription row(s) removed.');
      res.json({ ok: true, orderId: id, erased: true, backupKey, notes, message: '🗑 Order ' + id + ' erased. A full copy is kept in the change log backup (' + backupKey + ').' });
    } catch (e) { send(res, e); }
  });
}

module.exports = { mount, decide, isDeliveredSub, REFUND_METHODS, METHOD_LABEL };
