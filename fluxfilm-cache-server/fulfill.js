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
const NETFLIX_SHARING_NO = Number(process.env.NETFLIX_SHARING_PROFILE_NO || 1);
const NETFLIX_SHARING_MAX = Number(process.env.NETFLIX_SHARING_MAX_TOTAL || 5);

function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

const OCC_ACTIVE = "UPPER(status)='ACTIVE' AND (release_eligible_at > NOW() OR (release_eligible_at IS NULL AND expiry_date > NOW()))";

// Live DEVICE occupancy per inventory_ref, derived ONLY from node subscriptions
// (never from the inventory tables, which the 5-min sync truncates). Each sub uses
// device_count devices (older rows without it count as 1).
async function occupancyMap(conn, serviceLike) {
  const [occ] = await conn.query(
    "SELECT inventory_ref, SUM(COALESCE(device_count,1)) total FROM subscriptions " +
    "WHERE LOWER(service) LIKE ? AND " + OCC_ACTIVE + " GROUP BY inventory_ref", [serviceLike]);
  const m = new Map();
  for (const o of occ) m.set(String(o.inventory_ref), asNum(o.total));
  return m;
}

// Prime needs both total devices and how many are TV devices per account.
// tv_count is authoritative when present; older TV rows (device_type='TV', no
// tv_count) count their whole device_count as TV.
async function primeOccupancy(conn) {
  const [occ] = await conn.query(
    "SELECT inventory_ref, SUM(COALESCE(device_count,1)) total, " +
    "SUM(CASE WHEN tv_count IS NOT NULL THEN tv_count WHEN UPPER(device_type)='TV' THEN COALESCE(device_count,1) ELSE 0 END) tv " +
    "FROM subscriptions WHERE LOWER(service) LIKE '%prime%' AND " + OCC_ACTIVE + " GROUP BY inventory_ref");
  const m = new Map();
  for (const o of occ) m.set(String(o.inventory_ref), { total: asNum(o.total), tv: asNum(o.tv) });
  return m;
}

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

// Pick a Prime account that can fit deviceCount more devices (of which tvCount are
// TV): used_total + deviceCount <= MaxTotal, and used_tv + tvCount <= MaxTV.
async function allocatePrime(conn, deviceCount, tvCount) {
  const need = Math.max(1, deviceCount || 1);
  const needTV = Math.max(0, Math.min(tvCount || 0, need));
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE '%prime%' AND UPPER(is_active)='TRUE'");
  if (!accs.length) return { ok: false, message: 'No active Prime accounts.' };
  const [caps] = await conn.query("SELECT account_id, max_total, max_tv, is_active FROM inventory_capacity WHERE LOWER(service) LIKE '%prime%'");
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || PRIME_MAX_TOTAL, maxTV: asNum(c.max_tv) || PRIME_MAX_TV, isActive: String(c.is_active || '').toUpperCase() === 'TRUE' });
  const occMap = await primeOccupancy(conn);

  const candidates = [];
  for (const a of accs) {
    const id = String(a.account_id);
    if (!id || !a.login_id || !a.password) continue;
    const cap = capMap.get(id) || { maxTotal: PRIME_MAX_TOTAL, maxTV: PRIME_MAX_TV, isActive: true };
    if (!cap.isActive) continue;
    const o = occMap.get(id) || { total: 0, tv: 0 };
    if (o.total + need > cap.maxTotal) continue;      // not enough free devices
    if (o.tv + needTV > cap.maxTV) continue;          // not enough free TV slots
    candidates.push({ id, login: a.login_id, pass: a.password, total: o.total });
  }
  if (!candidates.length) return { ok: false, noStock: true, message: 'Prime slots are full right now (TV/non-TV capacity).' };
  candidates.sort((x, y) => x.total - y.total); // emptiest first (spreads load)
  const picked = candidates[0];
  const dt = needTV >= need ? 'TV' : (needTV > 0 ? 'MIXED' : 'NON_TV');
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
    'SELECT order_id, service, plan, name, email, phone, phone_norm, duration_days, status, fulfillment_status, extra_field_value, source, final_amount, order_type, renew_sub_id FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  const o = ords[0];
  if (!o || o.source !== 'node') return { __fallback: true };
  if (String(o.status || '').toUpperCase() !== 'PAID') return { ok: true, found: false, fulfillment: 'PENDING', retryAfterSec: 3, message: 'Processing your order…' };

  if (String(o.fulfillment_status || '').toUpperCase() === 'FULFILLED') {
    const ex = await _existingAccess(orderId);
    return { ok: true, found: true, orderId, fulfillment: 'FULFILLED', message: '✅ Showing your credentials.', postPaymentMessage: '', access: (ex && ex.access) || {} };
  }

  // RENEW: extend the SAME subscription's expiry — never allocate a new account.
  if (String(o.order_type || '').toUpperCase() === 'RENEW' && o.renew_sub_id) {
    return await _fulfillRenew(o);
  }

  // Manual orders already logged: don't re-insert, just show the pending message.
  if (String(o.fulfillment_status || '').toUpperCase() === 'MANUAL_PENDING') {
    return { ok: true, found: true, orderId, fulfillment: 'MANUAL_PENDING', message: '✅ Payment received — activation is in progress.', postPaymentMessage: '' };
  }

  // Read the plan's delivery policy (matches the Apps Script router).
  const [prows] = await db.getPool().query('SELECT raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [o.service, o.plan]);
  const praw = prows[0] ? rawOf(prows[0].raw_json) : {};
  const policy = String(praw.AllocationPolicy || '').toUpperCase();
  const mode = String(praw.FulfillmentMode || '').toUpperCase();
  const ppm = String(praw.PostPaymentMessage || '');

  // Manual services (YouTube etc.): no auto-allocation.
  if (mode === 'MANUAL' || policy === 'MANUAL' || policy === 'NONE') return await _fulfillManual(o, ppm);

  // Instant allocation, dispatched by policy. OTP allocates the account here; the
  // login OTP itself is still read by Apps Script on demand (Gmail specialist).
  if (policy === 'CAPACITY' || policy === 'PROFILE' || policy === 'ACCOUNT' || policy === 'OTP_ACCOUNT') return await _allocateAndFinish(o, policy, ppm);

  // Unknown/blank policy → safest is a manual task (never wrongly hand out an account).
  return await _fulfillManual(o, ppm);
}

// Pick a Netflix profile. Sharing plans share the reserved profile (#1) up to
// capacity; other plans get a private (PRIVATE_ROTATING) profile. Occupancy is
// derived from node subs, so nothing in the inventory tables is mutated.
async function allocateNetflix(conn, plan, deviceCount) {
  const need = Math.max(1, deviceCount || 1);
  const sharing = /sharing|group/i.test(String(plan || ''));
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE '%netflix%' AND UPPER(is_active)='TRUE'");
  if (!accs.length) return { ok: false, message: 'No active Netflix accounts.' };
  const [profs] = await conn.query("SELECT account_id, profile_number, profile_pin, profile_name, raw_json FROM inventory_profiles WHERE LOWER(service) LIKE '%netflix%'");
  const [caps] = await conn.query("SELECT account_id, max_total, is_active FROM inventory_capacity WHERE LOWER(service) LIKE '%netflix%'");
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || NETFLIX_SHARING_MAX, isActive: String(c.is_active || '').toUpperCase() !== 'FALSE' });
  const occ = await occupancyMap(conn, '%netflix%');

  const byAcc = new Map();
  for (const p of profs) {
    const acc = String(p.account_id || '').trim(); if (!acc) continue;
    const raw = rawOf(p.raw_json);
    const entry = {
      pno: asNum(p.profile_number) || asNum(raw.ProfileNumber),
      type: String(raw.ProfileType || '').toUpperCase(),
      reserved: String(raw.IsReserved || '').toUpperCase() === 'TRUE',
      name: String(raw.ProfileDisplayName || raw.ProfileName || p.profile_name || '').trim(),
      pin: String(p.profile_pin || raw.ProfilePIN || '').trim(),
    };
    if (!byAcc.has(acc)) byAcc.set(acc, []);
    byAcc.get(acc).push(entry);
  }

  if (sharing) {
    const cands = [];
    for (const a of accs) {
      const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
      const cap = capMap.get(acc) || { maxTotal: NETFLIX_SHARING_MAX, isActive: true }; if (!cap.isActive) continue;
      const list = byAcc.get(acc) || [];
      const prof = list.find((p) => p.pno === NETFLIX_SHARING_NO) || list.find((p) => p.type.indexOf('SHARING') === 0 || p.reserved);
      if (!prof || !prof.pno) continue;
      const ref = acc + '#P' + prof.pno;
      const used = occ.get(ref) || 0;
      if (used + need > cap.maxTotal) continue;   // not enough free device slots
      cands.push({ acc, a, prof, ref, used });
    }
    if (!cands.length) return { ok: false, noStock: true, message: 'Netflix sharing slots are full right now.' };
    cands.sort((x, y) => x.used - y.used);
    const p = cands[0];
    return { ok: true, inventoryRef: p.ref, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password, profileNumber: p.prof.pno, profileName: p.prof.name || 'FluxFilm', profilePin: p.prof.pin } };
  }

  // PRIVATE: a PRIVATE_ROTATING profile (not the sharing one) with no active sub.
  const cands = [];
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
    const list = (byAcc.get(acc) || []).filter((p) => p.pno && p.pno !== NETFLIX_SHARING_NO && p.type === 'PRIVATE_ROTATING');
    let assigned = 0; let free = null;
    for (const p of list) { const used = occ.get(acc + '#P' + p.pno) || 0; if (used > 0) assigned++; else if (!free) free = p; }
    if (free) cands.push({ acc, a, prof: free, ref: acc + '#P' + free.pno, assigned });
  }
  if (!cands.length) return { ok: false, noStock: true, message: 'No Netflix private profiles available right now.' };
  cands.sort((x, y) => x.assigned - y.assigned); // load-balance: emptiest account first
  const p = cands[0];
  return { ok: true, inventoryRef: p.ref, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password, profileNumber: p.prof.pno, profileName: p.prof.name || 'Private', profilePin: p.prof.pin } };
}

// Whole-account: hand over an account for the service. If the account has a
// capacity row (MaxTotal) it's shared by device count up to that limit; otherwise
// it's dedicated (one customer per account). Emptiest account first.
async function allocateWholeAccount(conn, service, deviceCount) {
  const need = Math.max(1, deviceCount || 1);
  const svc = String(service || '').toLowerCase();
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE ? AND UPPER(is_active)='TRUE'", ['%' + svc + '%']);
  if (!accs.length) return { ok: false, message: 'No active accounts for this service.' };
  const [caps] = await conn.query("SELECT account_id, max_total, is_active FROM inventory_capacity WHERE LOWER(service) LIKE ?", ['%' + svc + '%']);
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || 1, isActive: String(c.is_active || '').toUpperCase() !== 'FALSE' });
  const occ = await occupancyMap(conn, '%' + svc + '%');
  const cands = [];
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
    const cap = capMap.get(acc) || { maxTotal: 1, isActive: true }; if (!cap.isActive) continue;
    const used = occ.get(acc) || 0;
    if (used + need > cap.maxTotal) continue; // full
    cands.push({ acc, a, used });
  }
  if (!cands.length) return { ok: false, noStock: true, message: 'All accounts for this service are currently in use.' };
  cands.sort((x, y) => x.used - y.used);
  const p = cands[0];
  return { ok: true, inventoryRef: p.acc, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password } };
}

// OTP accounts: whole account, but the account's Notes list which durations (in
// months) it can serve, e.g. "1,3,6". Match the plan's duration; respect the
// account's MaxTotal limit (default 1 = one customer per account). Login-OTP
// reading stays on Apps Script. No device-count for OTP.
function monthsFromDays(days) {
  const d = asNum(days);
  if (d >= 330) return 12; if (d >= 150) return 6; if (d >= 75) return 3; if (d >= 20) return 1;
  return Math.max(1, Math.round(d / 30));
}
function notesAllowMonths(notes, months) {
  const nums = String(notes || '').match(/\d+/g);
  if (!nums || !nums.length) return true; // no restriction listed → any duration ok
  return nums.map(Number).includes(months);
}
async function allocateOtp(conn, service, durationDays) {
  const svc = String(service || '').toLowerCase();
  const months = monthsFromDays(durationDays);
  const [accs] = await conn.query("SELECT account_id, login_id, password, notes, plan FROM inventory_accounts WHERE LOWER(service) LIKE ? AND UPPER(is_active)='TRUE'", ['%' + svc + '%']);
  if (!accs.length) return { ok: false, message: 'No active accounts for this service.' };
  const [caps] = await conn.query("SELECT account_id, max_total, is_active FROM inventory_capacity WHERE LOWER(service) LIKE ?", ['%' + svc + '%']);
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || 1, isActive: String(c.is_active || '').toUpperCase() !== 'FALSE' });
  const occ = await occupancyMap(conn, '%' + svc + '%');
  const cands = [];
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
    if (!notesAllowMonths(a.notes, months)) continue;   // this account doesn't serve this duration
    const cap = capMap.get(acc) || { maxTotal: 1, isActive: true }; if (!cap.isActive) continue;
    const used = occ.get(acc) || 0;
    if (used + 1 > cap.maxTotal) continue;
    cands.push({ acc, a, used });
  }
  if (!cands.length) return { ok: false, noStock: true, message: 'No account available for this duration right now.' };
  cands.sort((x, y) => x.used - y.used);
  const p = cands[0];
  return { ok: true, inventoryRef: p.acc, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password } };
}

// Allocate (under a lock) + write the subscription + finish the order. Shared by
// Prime/Netflix/whole-account so the record + hook are identical everywhere.
async function _allocateAndFinish(o, policy, ppm) {
  return withLock('ff_alloc', 12, async (conn) => {
    const [chk] = await conn.query('SELECT fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [o.order_id]);
    if (chk[0] && String(chk[0].fulfillment_status || '').toUpperCase() === 'FULFILLED') {
      const ex = await _existingAccess(o.order_id);
      return { ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED', message: '✅ Showing your credentials.', access: (ex && ex.access) || {} };
    }

    // How many devices this order uses, and (Prime) how many are TV.
    const deviceCount = Math.max(1, asNum(o.device_count) || 1);
    let tvCount = (o.tv_count != null) ? asNum(o.tv_count) : null;
    if (tvCount == null) { const dtOld = String(o.extra_field_value || '').toUpperCase(); tvCount = dtOld === 'TV' ? deviceCount : 0; }
    tvCount = Math.max(0, Math.min(tvCount, deviceCount));

    let dt = ''; let alloc;
    if (policy === 'CAPACITY') {
      alloc = await allocatePrime(conn, deviceCount, tvCount);
      if (alloc && alloc.ok) dt = alloc.deviceType || (tvCount >= deviceCount ? 'TV' : tvCount > 0 ? 'MIXED' : 'NON_TV');
    } else if (policy === 'PROFILE') {
      alloc = await allocateNetflix(conn, o.plan, deviceCount);
    } else if (policy === 'OTP_ACCOUNT') {
      alloc = await allocateOtp(conn, o.service, o.duration_days);
    } else {
      alloc = await allocateWholeAccount(conn, o.service, deviceCount);
    }

    if (!alloc || !alloc.ok) {
      await conn.query("UPDATE orders SET fulfillment_status = 'FAILED' WHERE order_id = ?", [o.order_id]).catch(() => {});
      const why = (alloc && alloc.message) ? alloc.message : 'Out of stock momentarily.';
      return { ok: true, found: true, orderId: o.order_id, fulfillment: 'NO_STOCK', message: '😔 ' + why + " Please contact WhatsApp support — we'll sort it instantly." };
    }

    const acc = alloc.access || {};
    const subId = genSubId();
    const start = new Date();
    const expiry = addDays(start, asNum(o.duration_days) || 30);
    const release = addDays(expiry, COOLDOWN_DAYS);
    await conn.query(
      `INSERT INTO subscriptions (sub_id, order_id, phone, phone_norm, email, service, plan, duration_days,
         start_date, expiry_date, status, fulfillment_status, order_type, inventory_ref, account_id,
         login_id, password, profile_number, profile_name, profile_pin, device_type, device_count, tv_count, release_eligible_at, fulfilled_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'FULFILLED', 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'node')`,
      [subId, o.order_id, o.phone, o.phone_norm, o.email, o.service, o.plan, asNum(o.duration_days) || 30,
        fmtDt(start), fmtDt(expiry), alloc.inventoryRef, alloc.accountId || alloc.inventoryRef,
        acc.user || '', acc.pass || '', acc.profileNumber || '', acc.profileName || '', acc.profilePin || '', dt,
        deviceCount, (policy === 'CAPACITY' ? tvCount : null), fmtDt(release)]);
    await conn.query("UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = NOW() WHERE order_id = ?", [o.order_id]);
    afterFulfillHook({
      orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
      service: o.service, plan: o.plan, amount: o.final_amount, expiry: fmtDt(expiry), postPaymentMessage: ppm || '',
      access: { user: acc.user, pass: acc.pass, profileName: acc.profileName, profilePin: acc.profilePin, deviceType: dt },
    });
    return {
      ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED',
      message: '✅ Your access is ready!', postPaymentMessage: ppm || '',
      access: { user: acc.user || '', pass: acc.pass || '', profileName: acc.profileName || '', profilePin: acc.profilePin || '', profileNumber: acc.profileNumber || '', deviceType: dt },
      subId,
    };
  });
}

// Manual services: log a MANUAL_PENDING subscription (visible in the admin panel)
// and tell the customer we'll activate shortly. No credentials to hand out.
async function _fulfillManual(o, ppm) {
  const subId = genSubId();
  const start = new Date();
  const expiry = addDays(start, asNum(o.duration_days) || 30);
  await db.getPool().query(
    `INSERT INTO subscriptions (sub_id, order_id, phone, phone_norm, email, service, plan, duration_days,
       start_date, expiry_date, status, fulfillment_status, order_type, fulfilled_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'MANUAL_PENDING', 'NEW', NOW(), 'node')`,
    [subId, o.order_id, o.phone, o.phone_norm, o.email, o.service, o.plan, asNum(o.duration_days) || 30, fmtDt(start), fmtDt(expiry)]);
  await db.getPool().query("UPDATE orders SET fulfillment_status = 'MANUAL_PENDING', fulfilled_at = NOW() WHERE order_id = ?", [o.order_id]);
  afterFulfillHook({
    orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
    service: o.service, plan: o.plan, amount: o.final_amount, expiry: fmtDt(expiry), manual: true, postPaymentMessage: ppm || '', access: {},
  });
  return {
    ok: true, found: true, orderId: o.order_id, fulfillment: 'MANUAL_PENDING',
    message: ppm || "✅ Payment received! We'll activate your subscription within a few hours and email you the details.", postPaymentMessage: ppm || '', subId,
  };
}

function _accessOf(s) {
  return { user: s.login_id || '', pass: s.password || '', profileName: s.profile_name || '', profilePin: s.profile_pin || '', profileNumber: s.profile_number || '', deviceType: s.device_type || '' };
}

// Extend an existing subscription (renewal). Base policy: renewing in advance OR
// late by <= RENEW_BASE_TODAY_AFTER_DAYS days -> extend from the old expiry (keep
// continuity); later than that -> extend from today (the gap days are lost).
async function _fulfillRenew(o) {
  const sid = String(o.renew_sub_id || '').trim();
  return withLock('ff_renew', 10, async (conn) => {
    const [subsRows] = await conn.query(
      'SELECT sub_id, expiry_date, login_id, password, profile_name, profile_pin, profile_number, service, device_type FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
    const s = subsRows[0];
    if (!s) return { ok: false, found: true, orderId: o.order_id, fulfillment: 'ERROR', message: 'Renewal target not found — please contact support.' };

    // idempotent: if this renew order already applied, just show the credentials
    const [chk] = await conn.query('SELECT fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [o.order_id]);
    if (chk[0] && String(chk[0].fulfillment_status || '').toUpperCase() === 'FULFILLED') {
      return { ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED', message: '✅ Your subscription is renewed.', access: _accessOf(s), subId: sid };
    }

    const durationDays = asNum(o.duration_days) || 30;
    const LATE = Number(process.env.RENEW_BASE_TODAY_AFTER_DAYS || 10);
    const nowDate = new Date();
    let base = nowDate;
    const oldExp = s.expiry_date ? new Date(s.expiry_date) : null;
    if (oldExp && !isNaN(oldExp.getTime())) {
      const daysLate = Math.ceil((nowDate.getTime() - oldExp.getTime()) / 86400000);
      base = (daysLate <= LATE) ? oldExp : nowDate;
    }
    const newExpiry = addDays(base, durationDays);
    const release = addDays(newExpiry, COOLDOWN_DAYS);

    await conn.query(
      "UPDATE subscriptions SET expiry_date = ?, new_expiry = ?, order_id = ?, status = 'ACTIVE', fulfillment_status = 'FULFILLED', release_eligible_at = ?, fulfilled_at = NOW(), source = 'node' WHERE sub_id = ?",
      [fmtDt(newExpiry), fmtDt(newExpiry), o.order_id, fmtDt(release), sid]);
    await conn.query("UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = NOW() WHERE order_id = ?", [o.order_id]);

    afterFulfillHook({
      orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
      service: o.service, plan: o.plan, amount: o.final_amount,
      expiry: fmtDt(newExpiry), postPaymentMessage: '',
      access: { user: s.login_id, pass: s.password, deviceType: s.device_type },
    });
    return {
      ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED',
      message: '✅ Renewed! Your subscription has been extended.', postPaymentMessage: '',
      access: _accessOf(s), subId: sid, newExpiry: fmtDt(newExpiry),
    };
  });
}

async function fulfillAndGetAccess(orderId) {
  try { return await _fulfill(orderId); }
  catch (e) { console.log('[fulfill] error:', e.message); return { ok: false, found: true, orderId, fulfillment: 'ERROR', message: 'Activation hit a snag — please contact support with your order id.', fulfillError: String(e && e.message || e) }; }
}

module.exports = { fulfillAndGetAccess, allocatePrime, allocateNetflix, allocateWholeAccount, allocateOtp, _internal: { genSubId, monthsFromDays, notesAllowMonths } };
