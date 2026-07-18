/**
 * FluxFilm - fulfillment (Wave 2). Prime capacity allocation first.
 * Uses a MySQL advisory lock (GET_LOCK) so two simultaneous buyers can never
 * grab the same last slot. Idempotent: once an order is FULFILLED it returns the
 * same credentials instead of allocating again.
 */
const db = require('./db');

const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function genSubId() { return 'SUB-' + Date.now() + Math.floor(Math.random() * 90 + 10); }
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + (n || 0)); return x; }

const PRIME_MAX_TOTAL = Number(process.env.PRIME_MAX_TOTAL || 4);
const PRIME_MAX_TV = Number(process.env.PRIME_MAX_TV || 2);
const COOLDOWN_DAYS = Number(process.env.REUSE_COOLDOWN_DAYS || 10);

// Fire-and-forget: ask Apps Script to award coins + send the credentials email.
// Never blocks credential delivery; failures are logged only.
function afterFulfillHook(payload) {
  const url = process.env.API_PHP_URL || 'https://go.fluxfilm.in/api.php';
  const key = process.env.API_KEY || '';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ apiKey: key, action: 'nodeAfterFulfill', args: [payload] }),
  }).then(() => console.log('[afterFulfill] coins+email hook sent for', payload.orderId))
    .catch((e) => console.log('[afterFulfill] hook failed:', e.message));
}

async function withLock(name, ttl, fn) {
  const pool = db.getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT GET_LOCK(?, ?) AS l', [name, ttl]);
    return await fn(conn);
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [name]); } catch (_) {}
    conn.release();
  }
}

// Pick a Prime account with free capacity (total < MaxTotal, and if TV: tv < MaxTV)
async function allocatePrime(conn, deviceType) {
  const dt = String(deviceType || '').toUpperCase();
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE '%prime%' AND UPPER(is_active)='TRUE'");
  if (!accs.length) return { ok: false, message: 'No active Prime accounts.' };
  const [caps] = await conn.query("SELECT account_id, max_total, max_tv, is_active FROM inventory_capacity WHERE LOWER(service) LIKE '%prime%'");
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || PRIME_MAX_TOTAL, maxTV: asNum(c.max_tv) || PRIME_MAX_TV, isActive: String(c.is_active || '').toUpperCase() === 'TRUE' });
  const [occ] = await conn.query("SELECT inventory_ref, COUNT(*) total, SUM(UPPER(device_type)='TV') tv FROM subscriptions WHERE LOWER(service) LIKE '%prime%' AND UPPER(status)='ACTIVE' AND release_eligible_at > NOW() GROUP BY inventory_ref");
  const occMap = new Map();
  for (const o of occ) occMap.set(String(o.inventory_ref), { total: asNum(o.total), tv: asNum(o.tv) });

  const candidates = [];
  for (const a of accs) {
    const id = String(a.account_id);
    if (!id || !a.login_id || !a.password) continue;
    const cap = capMap.get(id) || { maxTotal: PRIME_MAX_TOTAL, maxTV: PRIME_MAX_TV, isActive: true };
    if (!cap.isActive) continue;
    const o = occMap.get(id) || { total: 0, tv: 0 };
    if (o.total >= cap.maxTotal) continue;
    if (dt === 'TV' && o.tv >= cap.maxTV) continue;
    candidates.push({ id, login: a.login_id, pass: a.password, total: o.total });
  }
  if (!candidates.length) return { ok: false, noStock: true, message: 'Prime slots are full right now (TV/non-TV capacity).' };
  candidates.sort((x, y) => x.total - y.total);
  const picked = candidates[0];
  return { ok: true, inventoryRef: picked.id, deviceType: dt, access: { user: picked.login, pass: picked.pass } };
}

async function _existingAccess(orderId) {
  const [rows] = await db.getPool().query('SELECT sub_id, login_id, password, profile_name, profile_pin, profile_number FROM subscriptions WHERE order_id = ? LIMIT 1', [orderId]);
  const s = rows[0];
  if (!s) return null;
  return { subId: s.sub_id, access: { user: s.login_id || '', pass: s.password || '', profileName: s.profile_name || '', profilePin: s.profile_pin || '', profileNumber: s.profile_number || '' } };
}

async function _fulfill(orderId) {
  const [ords] = await db.getPool().query(
    'SELECT order_id, service, plan, name, email, phone, phone_norm, duration_days, status, fulfillment_status, extra_field_value, source, final_amount FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  const o = ords[0];
  if (!o || o.source !== 'node') return { __fallback: true };
  if (String(o.status || '').toUpperCase() !== 'PAID') return { ok: true, found: false, fulfillment: 'PENDING', retryAfterSec: 3, message: 'Processing your order…' };

  if (String(o.fulfillment_status || '').toUpperCase() === 'FULFILLED') {
    const ex = await _existingAccess(orderId);
    return { ok: true, found: true, orderId, fulfillment: 'FULFILLED', message: '✅ Showing your credentials.', postPaymentMessage: '', access: (ex && ex.access) || {} };
  }

  const svc = String(o.service || '').toLowerCase();
  if (!svc.includes('prime')) {
    return { ok: true, found: true, orderId, fulfillment: 'MANUAL_PENDING', message: '✅ Payment received. Activation will be done shortly.', postPaymentMessage: '' };
  }
  let dt = String(o.extra_field_value || '').toUpperCase();
  if (dt !== 'TV' && dt !== 'NON_TV') dt = 'NON_TV'; // default non-TV if not provided

  return withLock('ff_alloc_prime', 10, async (conn) => {
    // double-check inside the lock (idempotency under concurrency)
    const [chk] = await conn.query('SELECT fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (chk[0] && String(chk[0].fulfillment_status || '').toUpperCase() === 'FULFILLED') {
      const ex = await _existingAccess(orderId);
      return { ok: true, found: true, orderId, fulfillment: 'FULFILLED', message: '✅ Showing your credentials.', access: (ex && ex.access) || {} };
    }
    const alloc = await allocatePrime(conn, dt);
    if (!alloc.ok) {
      await conn.query("UPDATE orders SET fulfillment_status = 'FAILED' WHERE order_id = ?", [orderId]).catch(() => {});
      return { ok: true, found: true, orderId, fulfillment: 'NO_STOCK', message: '😔 We just ran out of Prime slots as your payment came in. Please contact WhatsApp support — we\'ll sort it instantly.' };
    }
    const subId = genSubId();
    const start = new Date();
    const expiry = addDays(start, asNum(o.duration_days) || 30);
    const release = addDays(expiry, COOLDOWN_DAYS);
    await conn.query(
      `INSERT INTO subscriptions (sub_id, order_id, phone, phone_norm, email, service, plan, duration_days,
         start_date, expiry_date, status, fulfillment_status, order_type, inventory_ref, account_id,
         login_id, password, device_type, release_eligible_at, fulfilled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'FULFILLED', 'NEW', ?, ?, ?, ?, ?, ?, NOW())`,
      [subId, orderId, o.phone, o.phone_norm, o.email, o.service, o.plan, asNum(o.duration_days) || 30,
        fmtDt(start), fmtDt(expiry), alloc.inventoryRef, alloc.inventoryRef,
        alloc.access.user, alloc.access.pass, dt, fmtDt(release)]);
    await conn.query("UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = NOW() WHERE order_id = ?", [orderId]);
    afterFulfillHook({
      orderId, phone: o.phone, email: o.email, name: o.name,
      service: o.service, plan: o.plan, amount: o.final_amount,
      expiry: fmtDt(expiry), postPaymentMessage: '',
      access: { user: alloc.access.user, pass: alloc.access.pass, deviceType: dt },
    });
    return {
      ok: true, found: true, orderId, fulfillment: 'FULFILLED',
      message: '✅ Your Prime access is ready!', postPaymentMessage: '',
      access: { user: alloc.access.user, pass: alloc.access.pass, profileName: '', profilePin: '', profileNumber: '', deviceType: dt },
      subId,
    };
  });
}

async function fulfillAndGetAccess(orderId) {
  try { return await _fulfill(orderId); }
  catch (e) { console.log('[fulfill] error:', e.message); return { ok: false, found: true, orderId, fulfillment: 'ERROR', message: 'Activation hit a snag — please contact support with your order id.', fulfillError: String(e && e.message || e) }; }
}

module.exports = { fulfillAndGetAccess, allocatePrime, _internal: { genSubId } };
