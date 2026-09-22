/**
 * FluxFilm - fulfillment (Wave 2). Prime capacity allocation first.
 * Uses a MySQL advisory lock (GET_LOCK) so two simultaneous buyers can never
 * grab the same last slot. Idempotent: once an order is FULFILLED it returns the
 * same credentials instead of allocating again.
 */
const db = require('./db');
const { loginKey, buildLoginGroups } = require('./logins');
const { computeRenewal } = require('./renewal');
const deviceLogins = require('./devicelogins');
// 🔑 One shared rule: an access card never shows a password the account no longer has.
const accessPassword = require('./accesspassword');

const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
// One ID style for every subscription: SUB- + 9 digits (same as go's). Checked so it never reuses an existing ID.
function genSubId() { return 'SUB-' + String(require('crypto').randomInt(0, 1e9)).padStart(9, '0'); }
async function freeSubId() {
  for (let i = 0; i < 8; i++) {
    const id = genSubId();
    const [rows] = await db.getPool().query('SELECT 1 FROM subscriptions WHERE sub_id = ? LIMIT 1', [id]);
    if (!rows || !rows.length) return id;
  }
  return 'SUB-' + String(Date.now()).slice(-9);
}
function fmtDt(d) { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + (n || 0)); return x; }

const PRIME_MAX_TOTAL = Number(process.env.PRIME_MAX_TOTAL || 4);
const PRIME_MAX_TV = Number(process.env.PRIME_MAX_TV || 2);
const COOLDOWN_DAYS = Number(process.env.REUSE_COOLDOWN_DAYS || 10);
const NETFLIX_SHARING_NO = Number(process.env.NETFLIX_SHARING_PROFILE_NO || 1);
const NETFLIX_SHARING_MAX = Number(process.env.NETFLIX_SHARING_MAX_TOTAL || 5);

function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

// A subscription holds its slot while EITHER date is in the future. Normally the
// release date (expiry + cooldown) is the later one, but legacy renewals made in
// the Sheet extended ExpiryDate without moving ReleaseEligibleAt — such a paying
// customer must still count, or their slot gets sold a second time.
const OCC_ACTIVE = "UPPER(status)='ACTIVE' AND (expiry_date > NOW() OR release_eligible_at > NOW())";

// Live DEVICE occupancy per inventory_ref, derived ONLY from node subscriptions
// (never from the inventory tables, which the 5-min sync truncates). Each sub uses
// device_count devices (older rows without it count as 1).
async function occupancyMap(conn, serviceLike) {
  const [occ] = await conn.query(
    "SELECT inventory_ref, SUM(COALESCE(device_count,1)) total, SUM(GREATEST(COALESCE(device_count,1)-1,0)) extra FROM subscriptions " +
    "WHERE LOWER(service) LIKE ? AND " + OCC_ACTIVE + " GROUP BY inventory_ref", [serviceLike]);
  const m = new Map();
  // extra = devices beyond the first on each subscription (F1: a Netflix private profile used on N devices
  // takes N − 1 extra devices of its account's max_total). 0 for every 1-device subscription.
  m.extra = new Map();
  for (const o of occ) { m.set(String(o.inventory_ref), asNum(o.total)); m.extra.set(String(o.inventory_ref), asNum(o.extra)); }
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

// Fire-and-forget: award loyalty coins (MySQL) + send the email (Node SMTP).
// No Apps Script, no Sheet. Never blocks credential delivery; failures are logged.
const coins = require('./coins');
const mailer = require('./mailer');
function afterFulfillHook(payload) {
  const p = payload || {};
  const event = p.event || (String(p.orderType || '').toUpperCase() === 'RENEW' ? 'RENEW' : 'NEW_PURCHASE');
  if (!p.skipCoins) {
    coins.awardCoins({ event, orderId: p.orderId, phone: p.phone, service: p.service, plan: p.plan, amount: p.amount })
      .then((r) => console.log('[coins]', p.orderId, JSON.stringify(r)))
      .catch((e) => console.log('[coins] failed:', e.message));
  }
  mailer.sendAccessEmail(p)
    .then(() => console.log('[mail] sent for', p.orderId))
    .catch((e) => console.log('[mail] failed:', e.message));
  // Push "🎬 Your Netflix access is ready" if the customer switched notifications on (never blocks delivery).
  if (!p.manual) {
    try { require('./pushreminders').notifyDelivered(p).catch(() => {}); } catch (e) { console.log('[push] delivered hook skipped:', e.message); }
  }
}

async function withLock(name, ttl, fn) {
  const pool = db.getPool();
  const conn = await pool.getConnection();
  try {
    const [lk] = await conn.query('SELECT GET_LOCK(?, ?) AS l', [name, ttl]);
    // GET_LOCK returns 0 after the timeout (or NULL on error). Carrying on without the lock let two buyers take
    // the same last slot; fail instead — the checkout keeps polling and retries.
    if (Array.isArray(lk) && lk[0] && 'l' in lk[0] && Number(lk[0].l) !== 1) throw new Error('Busy — please try again in a moment.');
    return await fn(conn);
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [name]); } catch (_) {}
    conn.release();
  }
}

// Pick a Prime account that can fit deviceCount more devices (of which tvCount are
// TV): used_total + deviceCount <= MaxTotal, and used_tv + tvCount <= MaxTV.
// Every active Prime account with its capacity and live use (no filtering by free room).
async function primeAccounts(conn) {
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE '%prime%' AND UPPER(is_active)='TRUE'");
  if (!accs.length) return null;
  const [caps] = await conn.query("SELECT account_id, max_total, max_tv, is_active FROM inventory_capacity WHERE LOWER(service) LIKE '%prime%'");
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || PRIME_MAX_TOTAL, maxTV: asNum(c.max_tv) || PRIME_MAX_TV, isActive: String(c.is_active || '').toUpperCase() === 'TRUE' });
  const occMap = await primeOccupancy(conn);
  const list = [];
  for (const a of accs) {
    const id = String(a.account_id);
    if (!id || !a.login_id || !a.password) continue;
    const cap = capMap.get(id) || { maxTotal: PRIME_MAX_TOTAL, maxTV: PRIME_MAX_TV, isActive: true };
    if (!cap.isActive) continue;
    const o = occMap.get(id) || { total: 0, tv: 0 };
    list.push({ id, login: a.login_id, pass: a.password, total: o.total, tv: o.tv, maxTotal: cap.maxTotal, maxTV: cap.maxTV });
  }
  return list;
}

async function allocatePrime(conn, deviceCount, tvCount) {
  const need = Math.max(1, deviceCount || 1);
  const needTV = Math.max(0, Math.min(tvCount || 0, need));
  const accounts = await primeAccounts(conn);
  if (!accounts) return { ok: false, message: 'No active Prime accounts.' };
  const candidates = accounts.filter((x) => x.total + need <= x.maxTotal && x.tv + needTV <= x.maxTV); // free devices + free TV slots
  if (!candidates.length) return { ok: false, noStock: true, message: 'Prime slots are full right now (TV/non-TV capacity).' };
  candidates.sort((x, y) => x.total - y.total); // emptiest first (spreads load)
  const picked = candidates[0];
  const dt = needTV >= need ? 'TV' : (needTV > 0 ? 'MIXED' : 'NON_TV');
  return { ok: true, inventoryRef: picked.id, deviceType: dt, access: { user: picked.login, pass: picked.pass } };
}

// F1 separate logins on Prime: n devices on n DIFFERENT accounts, 1 device each. The first tvCount devices
// are the TVs: each goes to an account with a free TV slot; the others need only a free device.
// Emptiest accounts first. Returns parts in device order, or a failure (never a partial set).
async function allocatePrimeSeparate(conn, n, tvCount, exclude) {
  const need = Math.max(1, n || 1);
  const needTV = Math.max(0, Math.min(tvCount || 0, need));
  const accounts = await primeAccounts(conn);
  if (!accounts) return { ok: false, message: 'No active Prime accounts.' };
  const skip = exclude || new Set();
  const cands = accounts.filter((x) => !skip.has(x.id) && x.total + 1 <= x.maxTotal && x.tv <= x.maxTV).sort((x, y) => x.total - y.total);
  const tvCands = cands.filter((x) => x.tv + 1 <= x.maxTV);
  if (cands.length < need || tvCands.length < needTV) return { ok: false, noStock: true, message: 'Not enough separate Prime accounts are free right now.' };
  const tvPicked = tvCands.slice(0, needTV);
  const rest = cands.filter((x) => !tvPicked.includes(x)).slice(0, need - needTV);
  const mk = (x, tv) => ({ alloc: { ok: true, inventoryRef: x.id, accountId: x.id, deviceType: tv ? 'TV' : 'NON_TV', access: { user: x.login, pass: x.pass } }, dt: tv ? 'TV' : 'NON_TV', devices: 1, tv: tv ? 1 : 0 });
  return { ok: true, parts: tvPicked.map((x) => mk(x, true)).concat(rest.map((x) => mk(x, false))) };
}

async function _existingAccess(orderId) {
  const pool = db.getPool();
  const rows = await _purchaseRows((sql, p) => pool.query(sql, p), 'order_id', orderId);
  const s = rows[0];
  if (!s) return null;
  // 🔑 "Show me my credentials again" must not show a password the account no longer has.
  await accessPassword.refreshAccessSafe((sql, p) => pool.query(sql, p).then((r) => r[0]), rows);
  const access = { user: s.login_id || '', pass: s.password || '', profileName: s.profile_name || '', profilePin: s.profile_pin || '', profileNumber: s.profile_number || '' };
  const multi = deviceLogins.accessWithLogins(rows);
  if (rows.groupsOn && multi.logins) Object.assign(access, { logins: multi.logins, sameLogin: multi.sameLogin, deviceCount: multi.deviceCount });
  return { subId: s.sub_id, access };
}

// Refunded by the owner (admin order actions): never allocate, and stop the checkout page polling.
const REFUNDED_RESULT = (orderId) => ({ ok: true, found: true, orderId, fulfillment: 'REFUNDED', refunded: true, message: '💸 This order was refunded, so no account will be delivered for it. Please contact WhatsApp support if this looks wrong.' });

async function _fulfill(orderId, opts) {
  const [ords] = await db.getPool().query(
    // device_count/tv_count must be selected: allocation reserves that many devices.
    // (Omitting them silently treated every multi-device order as 1 device.)
    'SELECT order_id, service, plan, name, email, phone, phone_norm, duration_days, status, fulfillment_status, extra_field_value, device_count, tv_count, source, final_amount, order_type, renew_sub_id, raw_json FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  const o = ords[0];
  if (!o) return { ok: false, found: false, fulfillment: 'ERROR', message: 'Order not found in the FluxFilm database.' };
  if (String(o.status || '').toUpperCase() === 'REFUNDED') return REFUNDED_RESULT(orderId);
  // allowLegacy: the owner delivering an old-site (imported) order from the admin panel. Old-site renewals are
  // refused by the admin route before this point; the storefront never passes it.
  if (o.source !== 'node' && !(opts && opts.allowLegacy)) return { ok: false, found: false, fulfillment: 'ERROR', message: 'This legacy order cannot be fulfilled on the new checkout. Please contact support.' };
  // 💳 Admin credit renewal (credit.js): a CREDIT order is delivered before it is paid — only when the admin route asks
  // (opts.allowCredit) and the server marked the renewal as credit. The storefront never passes allowCredit.
  const creditOk = !!(opts && opts.allowCredit) && String(o.status || '').toUpperCase() === 'CREDIT' && rawOf(o.raw_json).Credit === true && String(o.order_type || '').toUpperCase() === 'RENEW';
  if (String(o.status || '').toUpperCase() !== 'PAID' && !creditOk) return { ok: true, found: false, fulfillment: 'PENDING', retryAfterSec: 3, message: 'Processing your order…' };

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

  // Instant allocation, dispatched by policy. OTP allocates the account here;
  // otp.js reads the forwarded login code directly over IMAP when requested.
  if (policy === 'CAPACITY' || policy === 'PROFILE' || policy === 'ACCOUNT' || policy === 'OTP_ACCOUNT') return await _allocateAndFinish(o, policy, ppm);

  // Unknown/blank policy → safest is a manual task (never wrongly hand out an account).
  return await _fulfillManual(o, ppm);
}

// Pick a Netflix profile. Sharing plans share the reserved profile (#1) up to
// capacity; other plans get a private (PRIVATE_ROTATING) profile. Occupancy is
// derived from node subs, so nothing in the inventory tables is mutated.
// PROFILE policy: hand out one profile of a shared account. Netflix keeps its
// historical behaviour exactly (any "Netflix..." service draws from every Netflix
// account; profile #NETFLIX_SHARING_NO is the shared profile and is never sold
// privately). Other services (e.g. Crunchyroll) draw only from accounts of their
// own service, and every PRIVATE_ROTATING profile is sellable, including #1.
// Devices a PROFILE account already uses against its max_total (F1 counting rule, decided 2026-09-14):
// seats on its sharing profile + the EXTRA devices (device_count − 1) of multi-device private subscriptions.
// A 1-device private profile adds 0, so stock for today's 1-device plans does not change.
function sharingProfileOf(list, reservedNo) {
  return (reservedNo != null && list.find((p) => p.pno === reservedNo)) || list.find((p) => p.type.indexOf('SHARING') === 0 || p.reserved) || null;
}
function profileAccountLoad(occ, acc, list, reservedNo) {
  const sp = sharingProfileOf(list, reservedNo);
  const sharingUsed = sp && sp.pno ? (occ.get(acc + '#P' + sp.pno) || 0) : 0;
  let extras = 0;
  for (const p of list) {
    if (!p.pno || p.pno === reservedNo || p.type !== 'PRIVATE_ROTATING') continue;
    extras += (occ.extra && occ.extra.get(acc + '#P' + p.pno)) || 0;
  }
  return { sharingUsed, extras, load: sharingUsed + extras };
}

async function allocateProfile(conn, service, plan, deviceCount) {
  const r = await profileCandidates(conn, service, plan, deviceCount);
  if (!r.ok) return r.noStock ? { ok: false, noStock: true, message: r.message } : { ok: false, message: r.message };
  const p = r.cands[0];
  return r.sharing
    ? { ok: true, inventoryRef: p.ref, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password, profileNumber: p.prof.pno, profileName: p.prof.name || 'FluxFilm', profilePin: p.prof.pin } }
    : { ok: true, inventoryRef: p.ref, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password, profileNumber: p.prof.pno, profileName: p.prof.name || 'Private', profilePin: p.prof.pin } };
}

// F1 separate logins on Netflix: n devices on n DIFFERENT accounts, one seat (sharing) or one private
// profile (private) each. All or nothing.
async function allocateProfileSeparate(conn, service, plan, n, exclude) {
  const r = await profileCandidates(conn, service, plan, 1);
  if (!r.ok && !r.noStock) return r;
  const skip = exclude || new Set();
  const cands = (r.cands || []).filter((c) => !skip.has(c.acc));
  const need = Math.max(1, n || 1);
  if (cands.length < need) return { ok: false, noStock: true, message: 'Not enough separate ' + (r.label || 'Netflix') + ' accounts are free right now.' };
  const name = r.sharing ? 'FluxFilm' : 'Private';
  return {
    ok: true,
    parts: cands.slice(0, need).map((p) => ({ alloc: { ok: true, inventoryRef: p.ref, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password, profileNumber: p.prof.pno, profileName: p.prof.name || name, profilePin: p.prof.pin } }, dt: '', devices: 1, tv: 0 })),
  };
}

// Candidate accounts for a PROFILE sale of `deviceCount` devices on one login, best first.
async function profileCandidates(conn, service, plan, deviceCount) {
  const need = Math.max(1, deviceCount || 1);
  const sharing = /sharing|group/i.test(String(plan || ''));
  const isNetflix = /netflix/i.test(String(service || ''));
  const like = isNetflix ? '%netflix%' : '%' + String(service || '').trim().toLowerCase() + '%';
  const reservedNo = isNetflix ? NETFLIX_SHARING_NO : null;
  const label = isNetflix ? 'Netflix' : String(service || 'this service').trim();
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE ? AND UPPER(is_active)='TRUE'", [like]);
  if (!accs.length) return { ok: false, label, sharing, message: 'No active ' + label + ' accounts.' };
  const [profs] = await conn.query('SELECT account_id, profile_number, profile_pin, profile_name, raw_json FROM inventory_profiles WHERE LOWER(service) LIKE ?', [like]);
  const [caps] = await conn.query('SELECT account_id, max_total, is_active FROM inventory_capacity WHERE LOWER(service) LIKE ?', [like]);
  const capMap = new Map();
  for (const c of caps) capMap.set(String(c.account_id), { maxTotal: asNum(c.max_total) || NETFLIX_SHARING_MAX, isActive: String(c.is_active || '').toUpperCase() !== 'FALSE' });
  const occ = await occupancyMap(conn, like);

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
      const prof = sharingProfileOf(list, reservedNo);
      if (!prof || !prof.pno) continue;
      const ref = acc + '#P' + prof.pno;
      const used = profileAccountLoad(occ, acc, list, reservedNo).load; // seats + extra private devices
      if (used + need > cap.maxTotal) continue;   // not enough free device slots
      cands.push({ acc, a, prof, ref, used });
    }
    if (!cands.length) return { ok: false, noStock: true, label, sharing, cands: [], message: label + ' sharing slots are full right now.' };
    cands.sort((x, y) => x.used - y.used);
    return { ok: true, label, sharing, cands };
  }

  // PRIVATE: a PRIVATE_ROTATING profile (not the sharing one) with no active sub. On N devices (same login)
  // the account must also have room for the N − 1 extra devices within its max_total.
  const cands = [];
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
    const all = byAcc.get(acc) || [];
    const list = all.filter((p) => p.pno && p.pno !== reservedNo && p.type === 'PRIVATE_ROTATING');
    let assigned = 0; let free = null;
    for (const p of list) { const used = occ.get(acc + '#P' + p.pno) || 0; if (used > 0) assigned++; else if (!free) free = p; }
    if (!free) continue;
    if (need > 1) {
      const cap = capMap.get(acc) || { maxTotal: NETFLIX_SHARING_MAX, isActive: true };
      if (profileAccountLoad(occ, acc, all, reservedNo).load + (need - 1) > cap.maxTotal) continue;
    }
    cands.push({ acc, a, prof: free, ref: acc + '#P' + free.pno, assigned });
  }
  if (!cands.length) return { ok: false, noStock: true, label, sharing, cands: [], message: 'No ' + label + ' private profiles available right now.' };
  cands.sort((x, y) => x.assigned - y.assigned); // load-balance: emptiest account first
  return { ok: true, label, sharing, cands };
}

/** Back-compat name: the Netflix case of allocateProfile. */
function allocateNetflix(conn, plan, deviceCount) { return allocateProfile(conn, 'Netflix', plan, deviceCount); }

// Capacity + usage per real login (see logins.js): every AccountID row that shares
// a login — any duration, active or not — counts against one limit.
async function loginGroups(conn, like) {
  const [rows] = await conn.query('SELECT account_id, login_id FROM inventory_accounts WHERE LOWER(service) LIKE ?', [like]);
  const [caps] = await conn.query('SELECT account_id, max_total, is_active FROM inventory_capacity WHERE LOWER(service) LIKE ?', [like]);
  const occ = await occupancyMap(conn, like);
  return buildLoginGroups(rows.map((r) => ({ account_id: r.account_id, key: loginKey(r.login_id) })), caps, (id) => occ.get(id) || 0);
}

// Whole-account: hand over an account for the service. If the account has a
// capacity row (MaxTotal) it's shared by device count up to that limit; otherwise
// it's dedicated (one customer per account). Emptiest account first.
async function allocateWholeAccount(conn, service, deviceCount) {
  const need = Math.max(1, deviceCount || 1);
  const svc = String(service || '').toLowerCase();
  const [accs] = await conn.query("SELECT account_id, login_id, password FROM inventory_accounts WHERE LOWER(service) LIKE ? AND UPPER(is_active)='TRUE'", ['%' + svc + '%']);
  if (!accs.length) return { ok: false, message: 'No active accounts for this service.' };
  const groups = await loginGroups(conn, '%' + svc + '%');
  const cands = [];
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
    const g = groups.forId(acc); if (!g.isActive) continue;
    if (g.used + need > g.maxTotal) continue; // full, counted across every row sharing this login
    cands.push({ acc, a, used: g.used });
  }
  if (!cands.length) return { ok: false, noStock: true, message: 'All accounts for this service are currently in use.' };
  cands.sort((x, y) => x.used - y.used);
  const p = cands[0];
  return { ok: true, inventoryRef: p.acc, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password } };
}

// OTP accounts: whole account, but the account's Notes list which durations (in
// months) it can serve, e.g. "1,3,6". Match the plan's duration; respect the
// account's MaxTotal limit (default 1 = one customer per account). Login-code
// reading is handled by otp.js. No device-count for OTP.
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
// Which plan an OTP account row serves. INVENTORY_ACCOUNTS lists an account once per
// duration it is sold for (Plan = "1 Month", "6 Months"…), exactly as the Apps
// Script otp_pickAccount_ required — e.g. JH-6M-02 serves only "6 Months", while
// Z5-01 has four rows, one per duration. Rows with no Plan fall back to Notes.
function otpRowServes(row, plan, months) {
  const rowPlan = String(row.plan || '').trim().toLowerCase();
  if (rowPlan) return !!plan && rowPlan === String(plan).trim().toLowerCase();
  return notesAllowMonths(row.notes, months);
}
async function allocateOtp(conn, service, durationDays, plan) {
  const svc = String(service || '').toLowerCase();
  const months = monthsFromDays(durationDays);
  const [accs] = await conn.query("SELECT account_id, login_id, password, notes, plan FROM inventory_accounts WHERE LOWER(service) LIKE ? AND UPPER(is_active)='TRUE'", ['%' + svc + '%']);
  if (!accs.length) return { ok: false, message: 'No active accounts for this service.' };
  const groups = await loginGroups(conn, '%' + svc + '%');
  const cands = [];
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc || !a.login_id || !a.password) continue;
    if (!otpRowServes(a, plan, months)) continue;   // this account row isn't sold for this plan
    const g = groups.forId(acc); if (!g.isActive) continue;
    if (g.used + 1 > g.maxTotal) continue;   // one login's capacity is shared by all its durations
    cands.push({ acc, a, used: g.used });
  }
  if (!cands.length) return { ok: false, noStock: true, message: 'No account available for this duration right now.' };
  cands.sort((x, y) => x.used - y.used);
  const p = cands[0];
  return { ok: true, inventoryRef: p.acc, accountId: p.acc, access: { user: p.a.login_id, pass: p.a.password } };
}

// Pick an account/profile for a sale or a renewal move, dispatched by policy.
// Read-only: it only chooses; the caller writes the subscription.
async function pickAllocation(conn, policy, a) {
  let dt = ''; let alloc;
  if (policy === 'CAPACITY') {
    alloc = await allocatePrime(conn, a.deviceCount, a.tvCount);
    if (alloc && alloc.ok) dt = alloc.deviceType || (a.tvCount >= a.deviceCount ? 'TV' : a.tvCount > 0 ? 'MIXED' : 'NON_TV');
  } else if (policy === 'PROFILE') {
    alloc = await allocateProfile(conn, a.service, a.plan, a.deviceCount);
  } else if (policy === 'OTP_ACCOUNT') {
    alloc = await allocateOtp(conn, a.service, a.durationDays, a.plan);
  } else {
    alloc = await allocateWholeAccount(conn, a.service, a.deviceCount);
  }
  return { alloc, dt };
}

// ---------------------------------------------------------------------------
// F1: multiple devices — same login or a separate login for each device.
// Read-only: chooses every device of the order at once (the caller holds the allocation lock and writes).
//   same     → one account with room for all N devices; else separate accounts (+ message)
//   separate → N different accounts, 1 device each; else one account for all N (+ message)
//   neither  → { ok: false, noStock } — nothing is allocated (never a partial set)
// ---------------------------------------------------------------------------
async function _separateParts(conn, policy, a, n, exclude) {
  const r = policy === 'CAPACITY'
    ? await allocatePrimeSeparate(conn, n, a.tvCount, exclude)
    : await allocateProfileSeparate(conn, a.service, a.plan, n, exclude);
  return r && r.ok ? r.parts : null;
}
async function pickDeviceLogins(conn, policy, a) {
  const n = Math.max(1, asNum(a.deviceCount) || 1);
  const tvCount = Math.max(0, Math.min(asNum(a.tvCount) || 0, n));
  const mode = a.mode === 'separate' ? 'separate' : 'same';
  const same = async () => {
    const { alloc, dt } = await pickAllocation(conn, policy, { service: a.service, plan: a.plan, durationDays: a.durationDays, deviceCount: n, tvCount });
    return alloc && alloc.ok ? [{ alloc, dt, devices: n, tv: tvCount }] : null;
  };
  const separate = () => _separateParts(conn, policy, { service: a.service, plan: a.plan, tvCount }, n, a.exclude);
  let parts; let delivered = mode; let message = '';
  if (mode === 'separate') {
    parts = await separate();
    if (!parts) { parts = await same(); delivered = 'same'; message = parts ? deviceLogins.MESSAGES.separateGaveSame(n) : ''; }
  } else {
    parts = await same();
    if (!parts) { parts = await separate(); delivered = 'separate'; message = parts ? deviceLogins.MESSAGES.sameGaveSeparate(n) : ''; }
  }
  if (!parts) return { ok: false, noStock: true, requested: mode, message: deviceLogins.MESSAGES.outOfStock(n) };
  return { ok: true, requested: mode, delivered, fallback: delivered !== mode, message, parts };
}

/** Before payment (createOrder): can this N-device order be delivered, and how? No lock, nothing written. */
async function checkDeviceLogins(a) {
  const conn = await db.getPool().getConnection();
  try {
    const r = await pickDeviceLogins(conn, String(a.policy || '').toUpperCase(), a);
    return { ok: r.ok, requested: r.requested, delivered: r.delivered, fallback: !!r.fallback, message: r.message };
  } finally { conn.release(); }
}

/** Is this order an F1 multi-login order (eligible plan AND schema-v19 ready)? */
async function _deviceLoginsOn(conn, service, plan, policy, deviceCount) {
  if (Math.max(1, asNum(deviceCount) || 1) < 2) return false;
  if (!deviceLogins.isEligible({ service, plan, policy })) return false;
  return deviceLogins.groupsReady((sql, p) => conn.query(sql, p));
}

// service / inventory_ref / account_id ride along so the access card can be checked against the account
// it sits on (accesspassword.js) — read with its own statement, never a JOIN.
const SUB_ACCESS_COLS = 'sub_id, service, inventory_ref, account_id, login_id, password, profile_name, profile_pin, profile_number, device_type, device_count, tv_count';
// All login rows of one purchase, in device order. Before schema-v19 (or for legacy rows) → just the first row.
async function _purchaseRows(q, where, param) {
  const on = await deviceLogins.groupsReady(q);
  const [rows] = await q('SELECT ' + SUB_ACCESS_COLS + (on ? ', group_id, group_index' : '') + ' FROM subscriptions WHERE ' + where + ' = ?' + (on ? ' ORDER BY group_index' : ''), [param]);
  if (!rows || !rows.length) return [];
  const first = rows[0];
  const out = (!on || !first.group_id) ? [first] : rows.filter((r) => r.group_id === first.group_id);
  out.groupsOn = on;
  return out;
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
    // Refunded or erased by the owner while this delivery waited for the lock: allocate nothing.
    if (Array.isArray(chk) && !chk.length) return { ok: false, found: false, fulfillment: 'ERROR', message: 'Order not found in the FluxFilm database.' };
    if (chk[0] && String(chk[0].fulfillment_status || '').toUpperCase() === 'REFUNDED') return REFUNDED_RESULT(o.order_id);

    // Duplicate guard: an order that already has a delivered subscription is never allocated again.
    const dup = await _deliveredRowsGuard(conn, o.order_id);
    if (dup) return dup;

    // How many devices this order uses, and (Prime) how many are TV.
    const deviceCount = Math.max(1, asNum(o.device_count) || 1);
    let tvCount = (o.tv_count != null) ? asNum(o.tv_count) : null;
    if (tvCount == null) { const dtOld = String(o.extra_field_value || '').toUpperCase(); tvCount = dtOld === 'TV' ? deviceCount : 0; }
    tvCount = Math.max(0, Math.min(tvCount, deviceCount));

    // F1: 2+ device Netflix / Prime order and schema-v19 ready → same login or separate logins.
    if (await _deviceLoginsOn(conn, o.service, o.plan, policy, deviceCount)) {
      return await _finishDeviceLogins(conn, o, policy, ppm, deviceCount, tvCount);
    }

    const { alloc, dt } = await pickAllocation(conn, policy, { service: o.service, plan: o.plan, durationDays: o.duration_days, deviceCount, tvCount });

    if (!alloc || !alloc.ok) {
      await conn.query("UPDATE orders SET fulfillment_status = 'FAILED' WHERE order_id = ?", [o.order_id]).catch(() => {});
      const why = (alloc && alloc.message) ? alloc.message : 'Out of stock momentarily.';
      return { ok: true, found: true, orderId: o.order_id, fulfillment: 'NO_STOCK', message: '😔 ' + why + " Please contact WhatsApp support — we'll sort it instantly." };
    }

    const acc = alloc.access || {};
    const subId = await freeSubId();
    const start = new Date();
    const expiry = addDays(start, asNum(o.duration_days) || 30);
    const release = addDays(expiry, COOLDOWN_DAYS);
    // One transaction: if marking the order FULFILLED fails, the subscription row is rolled back too — otherwise the
    // checkout page's next poll allocates again (how FF0215802 got 54 subscriptions).
    await _inTransaction(conn, async () => {
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
    });
    afterFulfillHook({
      event: 'NEW_PURCHASE',
      orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
      service: o.service, plan: o.plan, amount: o.final_amount, expiry: fmtDt(expiry), postPaymentMessage: ppm || '',
      access: { user: acc.user, pass: acc.pass, profileName: acc.profileName, profilePin: acc.profilePin, deviceType: dt },
    });
    return {
      ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED',
      message: '✅ Your access is ready!', postPaymentMessage: ppm || '',
      access: { user: acc.user || '', pass: acc.pass || '', profileName: acc.profileName || '', profilePin: acc.profilePin || '', profileNumber: acc.profileNumber || '', deviceType: dt },
      subId, expiry: fmtDt(expiry),
    };
  });
}

/**
 * Duplicate-subscription guard (caller holds the ff_alloc lock).
 * Test order FF0215802 (Prime ₹39, 2026-07-16/17 staging) got 54 subscriptions on ~30 accounts: the July code inserted
 * the subscription and then ran "UPDATE orders SET … inventory_ref = ?" — a column orders does not have — so the order
 * never became FULFILLED, the error went back to the checkout page, and every poll (every few seconds for 14 minutes)
 * allocated another account. Fixed on 2026-07-17 (7e9e5fd), but nothing stopped it happening again with any other
 * failing write. Now: if this NEW order already has a delivered row (login or FULFILLED), nothing is inserted — the
 * order is marked FULFILLED and the existing login is shown. A complete delivery writes all its rows (one per login
 * for separate logins) in one transaction, so one delivered row means the order is done.
 */
async function _deliveredRowsGuard(conn, orderId) {
  const [have] = await conn.query('SELECT sub_id, login_id, fulfillment_status FROM subscriptions WHERE order_id = ?', [orderId]);
  const rows = (have || []).filter((x) => String(x.fulfillment_status || '').toUpperCase() === 'FULFILLED' || String(x.login_id || '').trim());
  if (!rows.length) return null;
  console.log('[fulfill] duplicate guard:', orderId, 'already has', rows.length, 'delivered subscription row(s) — not allocating again');
  await conn.query("UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = COALESCE(fulfilled_at, NOW()) WHERE order_id = ?", [orderId])
    .catch((e) => console.log('[fulfill] duplicate guard could not mark', orderId, 'FULFILLED:', e.message));
  const ex = await _existingAccess(orderId);
  return { ok: true, found: true, orderId, fulfillment: 'FULFILLED', message: '✅ Showing your credentials.', access: (ex && ex.access) || {}, duplicateGuard: true };
}

// All writes of one delivery succeed or none do (fake test connections without transactions just run in order).
async function _inTransaction(conn, fn) {
  const tx = typeof conn.beginTransaction === 'function';
  if (tx) await conn.beginTransaction();
  try {
    const out = await fn();
    if (tx) await conn.commit();
    return out;
  } catch (e) {
    if (tx) { try { await conn.rollback(); } catch (_) {} }
    throw e;
  }
}

const SUB_INSERT_SQL =
  `INSERT INTO subscriptions (sub_id, order_id, phone, phone_norm, email, service, plan, duration_days,
     start_date, expiry_date, status, fulfillment_status, order_type, inventory_ref, account_id,
     login_id, password, profile_number, profile_name, profile_pin, device_type, device_count, tv_count, release_eligible_at, fulfilled_at, source,
     group_id, group_size, group_index)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'FULFILLED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'node', ?, ?, ?)`;

// F1 delivery (caller holds the ff_alloc lock): pick every device at once, then write one subscriptions row per
// login in one transaction. A same-login delivery is one row with device_count N (group_size 1).
async function _finishDeviceLogins(conn, o, policy, ppm, deviceCount, tvCount) {
  const oraw = rawOf(o.raw_json);
  const mode = deviceLogins.normalizeMode(oraw.LoginMode) || 'same';
  const pick = await pickDeviceLogins(conn, policy, { service: o.service, plan: o.plan, durationDays: o.duration_days, deviceCount, tvCount, mode });
  if (!pick.ok) {
    await conn.query("UPDATE orders SET fulfillment_status = 'FAILED' WHERE order_id = ?", [o.order_id]).catch(() => {});
    return { ok: true, found: true, orderId: o.order_id, fulfillment: 'NO_STOCK', message: '😔 No account has room for this ' + deviceCount + "-device plan right now (same or separate logins). Please contact WhatsApp support — we'll sort it instantly." };
  }
  const start = new Date();
  const expiry = addDays(start, asNum(o.duration_days) || 30);
  const release = addDays(expiry, COOLDOWN_DAYS);
  const groupId = 'G-' + o.order_id;
  const size = pick.parts.length;
  const rows = [];
  await _inTransaction(conn, async () => {
    for (let i = 0; i < size; i++) {
      const part = pick.parts[i];
      const acc = part.alloc.access || {};
      let rowSubId = await freeSubId();
      while (rows.some((r) => r.sub_id === rowSubId)) rowSubId = await freeSubId(); // not visible to freeSubId until commit
      const dt = policy === 'CAPACITY' ? (part.dt || (part.tv >= part.devices ? 'TV' : part.tv > 0 ? 'MIXED' : 'NON_TV')) : '';
      const tv = policy === 'CAPACITY' ? part.tv : null;
      await conn.query(SUB_INSERT_SQL,
        [rowSubId, o.order_id, o.phone, o.phone_norm, o.email, o.service, o.plan, asNum(o.duration_days) || 30,
          fmtDt(start), fmtDt(expiry), 'NEW', part.alloc.inventoryRef, part.alloc.accountId || part.alloc.inventoryRef,
          acc.user || '', acc.pass || '', acc.profileNumber || '', acc.profileName || '', acc.profilePin || '', dt,
          part.devices, tv, fmtDt(release), groupId, size, i + 1]);
      rows.push({ sub_id: rowSubId, login_id: acc.user || '', password: acc.pass || '', profile_name: acc.profileName || '', profile_pin: acc.profilePin || '', profile_number: acc.profileNumber || '', device_type: dt, device_count: part.devices, tv_count: tv, group_index: i + 1 });
    }
    await conn.query("UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = NOW() WHERE order_id = ?", [o.order_id]);
  });
  const access = deviceLogins.accessWithLogins(rows);
  console.log('[fulfill] F1', o.order_id, 'requested', pick.requested, 'delivered', pick.delivered, 'on', rows.length, 'login row(s)');
  afterFulfillHook({
    event: 'NEW_PURCHASE',
    orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
    service: o.service, plan: o.plan, amount: o.final_amount, expiry: fmtDt(expiry), postPaymentMessage: ppm || '',
    access, loginNotice: pick.message,
  });
  return {
    ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED',
    message: '✅ Your access is ready!', postPaymentMessage: ppm || '',
    access, loginMode: pick.delivered, requestedLoginMode: pick.requested, loginNotice: pick.message,
    subId: rows[0].sub_id, subIds: rows.map((r) => r.sub_id), expiry: fmtDt(expiry),
  };
}

// Manual services: log a MANUAL_PENDING subscription (visible in the admin panel)
// and tell the customer we'll activate shortly. No credentials to hand out.
async function _fulfillManual(o, ppm) {
  // Duplicate guard: a manual order already logged (e.g. the status update failed last time) is not logged twice.
  const [have] = await db.getPool().query('SELECT sub_id, expiry_date FROM subscriptions WHERE order_id = ? LIMIT 1', [o.order_id]);
  if (have && have.length) {
    await db.getPool().query("UPDATE orders SET fulfillment_status = 'MANUAL_PENDING', fulfilled_at = COALESCE(fulfilled_at, NOW()) WHERE order_id = ? AND UPPER(COALESCE(fulfillment_status, '')) NOT IN ('FULFILLED', 'MANUAL_PENDING')", [o.order_id])
      .catch((e) => console.log('[fulfill] manual guard could not update', o.order_id, e.message));
    return { ok: true, found: true, orderId: o.order_id, fulfillment: 'MANUAL_PENDING', message: ppm || "✅ Payment received! We'll activate your subscription within a few hours and email you the details.", postPaymentMessage: ppm || '', subId: have[0].sub_id, duplicateGuard: true };
  }
  const subId = await freeSubId();
  const start = new Date();
  const expiry = addDays(start, asNum(o.duration_days) || 30);
  await db.getPool().query(
    `INSERT INTO subscriptions (sub_id, order_id, phone, phone_norm, email, service, plan, duration_days,
       start_date, expiry_date, status, fulfillment_status, order_type, fulfilled_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'MANUAL_PENDING', 'NEW', NOW(), 'node')`,
    [subId, o.order_id, o.phone, o.phone_norm, o.email, o.service, o.plan, asNum(o.duration_days) || 30, fmtDt(start), fmtDt(expiry)]);
  await db.getPool().query("UPDATE orders SET fulfillment_status = 'MANUAL_PENDING', fulfilled_at = NOW() WHERE order_id = ?", [o.order_id]);
  afterFulfillHook({
    event: 'NEW_PURCHASE',
    orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
    service: o.service, plan: o.plan, amount: o.final_amount, expiry: fmtDt(expiry), manual: true, postPaymentMessage: ppm || '', access: {},
  });
  return {
    ok: true, found: true, orderId: o.order_id, fulfillment: 'MANUAL_PENDING',
    message: ppm || "✅ Payment received! We'll activate your subscription within a few hours and email you the details.", postPaymentMessage: ppm || '', subId, expiry: fmtDt(expiry),
  };
}

function _accessOf(s) {
  return { user: s.login_id || '', pass: s.password || '', profileName: s.profile_name || '', profilePin: s.profile_pin || '', profileNumber: s.profile_number || '', deviceType: s.device_type || '' };
}

// ---------------------------------------------------------------------------
// Renewal account check (R1). A renewal used to extend the subscription on its old
// account without looking at it — a customer renewing onto a retired or full
// account paid and received login details that no longer worked. Now, before
// payment AND again at fulfilment, the renewal decides:
//   SAME — keep the current login (account active, still has room for them)
//   MOVE — the old account can't serve them; allocate a new login on renewal
//   NONE — nothing free: block before payment (never take money first)
// Manual services (no inventory) always renew in place.
// ---------------------------------------------------------------------------
const INVENTORY_POLICIES = ['CAPACITY', 'PROFILE', 'ACCOUNT', 'OTP_ACCOUNT'];

async function _renewalPlanInfo(conn, service, plan) {
  const [rows] = await conn.query('SELECT raw_json, duration_days FROM plans WHERE service = ? AND plan = ? LIMIT 1', [service, plan]);
  const raw = rows[0] ? rawOf(rows[0].raw_json) : {};
  const policy = String(raw.AllocationPolicy || '').toUpperCase();
  const mode = String(raw.FulfillmentMode || '').toUpperCase();
  return {
    policy: (mode === 'MANUAL' || !INVENTORY_POLICIES.includes(policy)) ? 'MANUAL' : policy,
    durationDays: asNum(rows[0] && rows[0].duration_days) || asNum(raw.DurationDays) || 30,
  };
}

// schema-v13 adds subscriptions.removed / removed_at. Until it has been run, renewals
// keep working and treat everyone as "not removed".
let _removalColumns = false;
async function _hasRemovalColumns(conn) {
  if (_removalColumns) return true;
  const [r] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'subscriptions' AND column_name IN ('removed', 'removed_at')");
  _removalColumns = Number((r[0] || {}).n) === 2;
  return _removalColumns;
}

async function _renewalCols(conn) {
  const removal = (await _hasRemovalColumns(conn)) ? 'removed, removed_at, ' : '0 AS removed, NULL AS removed_at, ';
  const groups = (await deviceLogins.groupsReady((sql, p) => conn.query(sql, p))) ? 'group_id, group_size, group_index, ' : '';
  return 'sub_id, service, plan, expiry_date, start_date, inventory_ref, account_id, login_id, password, profile_name, profile_pin, profile_number, ' +
    'device_type, device_count, tv_count, ' + removal + groups + '(' + OCC_ACTIVE + ') AS occupying';
}
async function _renewalSub(conn, subId) {
  const [rows] = await conn.query('SELECT ' + (await _renewalCols(conn)) + ' FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]);
  return rows[0] || null;
}
// Every login row of the purchase this subscription belongs to (F1), in device order. Legacy / pre-v19 → [s].
async function _renewalRows(conn, s) {
  if (!s || !s.group_id) return [s];
  const [rows] = await conn.query('SELECT ' + (await _renewalCols(conn)) + ' FROM subscriptions WHERE group_id = ? ORDER BY group_index', [s.group_id]);
  return rows && rows.length ? rows : [s];
}

// Devices this subscription holds — counted exactly as the occupancy queries do.
function _heldDevices(s) {
  const dev = Math.max(1, asNum(s.device_count) || 1);
  const tv = (s.tv_count != null && s.tv_count !== '') ? asNum(s.tv_count) : (String(s.device_type || '').toUpperCase() === 'TV' ? dev : 0);
  return { dev, tv };
}

// Can this subscription stay on its current account? Its own slot is excluded
// while it is still occupied, so a customer never blocks their own renewal.
async function _canKeepAccount(conn, policy, s, plan) {
  const ref = String(s.inventory_ref || '').trim();
  if (!ref) return { keep: false, reason: 'NO_ACCOUNT' };
  const cut = ref.indexOf('#P');
  const acc = cut >= 0 ? ref.slice(0, cut) : ref;
  const pno = cut >= 0 ? asNum(ref.slice(cut + 2)) : 0;
  const { dev, tv } = _heldDevices(s);
  const mine = Number(s.occupying) === 1;
  const selfDev = mine ? dev : 0;
  const selfTv = mine ? tv : 0;
  const svc = String(s.service || '').trim().toLowerCase();
  const like = policy === 'CAPACITY' ? '%prime%' : (policy === 'PROFILE' && /netflix/i.test(svc)) ? '%netflix%' : '%' + svc + '%';

  const [rows] = await conn.query("SELECT login_id, password FROM inventory_accounts WHERE account_id = ? AND LOWER(service) LIKE ? AND UPPER(is_active)='TRUE'", [acc, like]);
  const live = rows.find((r) => r.login_id && r.password);
  if (!live) return { keep: false, reason: 'INACTIVE' };
  // The account's CURRENT login: a customer we removed by changing the password still
  // has the old one stored on their subscription.
  const creds = { user: live.login_id, pass: live.password };

  if (policy === 'CAPACITY') {
    const [caps] = await conn.query('SELECT max_total, max_tv, is_active FROM inventory_capacity WHERE account_id = ? AND LOWER(service) LIKE ?', [acc, like]);
    let cap = { maxTotal: PRIME_MAX_TOTAL, maxTV: PRIME_MAX_TV, isActive: true };
    for (const c of caps) cap = { maxTotal: asNum(c.max_total) || PRIME_MAX_TOTAL, maxTV: asNum(c.max_tv) || PRIME_MAX_TV, isActive: String(c.is_active || '').toUpperCase() === 'TRUE' };
    if (!cap.isActive) return { keep: false, reason: 'INACTIVE' };
    const o = (await primeOccupancy(conn)).get(acc) || { total: 0, tv: 0 };
    if (o.total - selfDev + dev > cap.maxTotal || o.tv - selfTv + Math.min(tv, dev) > cap.maxTV) return { keep: false, reason: 'FULL' };
    return { keep: true, creds };
  }

  if (policy === 'PROFILE') {
    if (!pno) return { keep: false, reason: 'NO_PROFILE' };
    const [profs] = await conn.query('SELECT profile_number, profile_name, profile_pin, raw_json FROM inventory_profiles WHERE account_id = ? AND LOWER(service) LIKE ?', [acc, like]);
    const prof = profs.find((p) => (asNum(p.profile_number) || asNum(rawOf(p.raw_json).ProfileNumber)) === pno);
    if (!prof) return { keep: false, reason: 'PROFILE_GONE' };
    const praw = rawOf(prof.raw_json);
    creds.profileNumber = pno;
    creds.profileName = String(praw.ProfileDisplayName || praw.ProfileName || prof.profile_name || '').trim();
    creds.profilePin = String(prof.profile_pin || praw.ProfilePIN || '').trim();
    const occ = await occupancyMap(conn, like);
    const used = occ.get(ref) || 0;
    // F1 counting rule: the account's sharing seats + extra devices of multi-device private profiles.
    const reservedNo = /netflix/i.test(svc) ? NETFLIX_SHARING_NO : null;
    const list = profs.map((p) => { const r = rawOf(p.raw_json); return { pno: asNum(p.profile_number) || asNum(r.ProfileNumber), type: String(r.ProfileType || '').toUpperCase(), reserved: String(r.IsReserved || '').toUpperCase() === 'TRUE' }; });
    const accLoad = profileAccountLoad(occ, acc, list, reservedNo);
    const capOf = async () => {
      const [caps] = await conn.query('SELECT max_total, is_active FROM inventory_capacity WHERE account_id = ? AND LOWER(service) LIKE ?', [acc, like]);
      let cap = { maxTotal: NETFLIX_SHARING_MAX, isActive: true };
      for (const c of caps) cap = { maxTotal: asNum(c.max_total) || NETFLIX_SHARING_MAX, isActive: String(c.is_active || '').toUpperCase() !== 'FALSE' };
      return cap;
    };
    if (/sharing|group/i.test(String(plan || s.plan || ''))) {
      const cap = await capOf();
      if (!cap.isActive) return { keep: false, reason: 'INACTIVE' };
      if (used - selfDev + dev + accLoad.extras > cap.maxTotal) return { keep: false, reason: 'FULL' };
    } else if (used - selfDev > 0) {
      return { keep: false, reason: 'FULL' }; // someone else now has this private profile
    } else if (dev > 1) {
      // One private profile on N devices: its N − 1 extra devices must still fit (own extras excluded).
      const cap = await capOf();
      if (accLoad.load - (mine ? dev - 1 : 0) + (dev - 1) > cap.maxTotal) return { keep: false, reason: 'FULL' };
    }
    return { keep: true, creds };
  }

  // ACCOUNT / OTP_ACCOUNT: capacity belongs to the login (see logins.js).
  const g = (await loginGroups(conn, like)).forId(acc);
  if (!g.isActive) return { keep: false, reason: 'INACTIVE' };
  const need = policy === 'OTP_ACCOUNT' ? 1 : dev;
  if (g.used - selfDev + need > g.maxTotal) return { keep: false, reason: 'FULL' };
  return { keep: true, creds };
}

const RENEW_MOVE_MESSAGE = {
  FULL: 'Your previous place on this account has been taken since your plan ended, so you will get a new login right after renewal.',
  DEFAULT: 'Your old account is no longer available, so you will get a new login right after renewal.',
};
const RENEW_NONE_MESSAGE = "Sorry — your old account is no longer available and no other account is free right now, so this renewal can't be paid for yet. Please message us on WhatsApp and we'll sort it out.";

async function _renewalDecision(conn, s, plan) {
  const targetPlan = plan || s.plan;
  const info = await _renewalPlanInfo(conn, s.service, targetPlan);
  if (info.policy === 'MANUAL') return { mode: 'SAME', policy: info.policy, durationDays: info.durationDays };
  const keep = await _canKeepAccount(conn, info.policy, s, targetPlan);
  if (keep.keep) return { mode: 'SAME', policy: info.policy, creds: keep.creds, durationDays: info.durationDays };
  const { dev, tv } = _heldDevices(s);
  const { alloc, dt } = await pickAllocation(conn, info.policy, {
    service: s.service, plan: targetPlan, durationDays: info.durationDays, deviceCount: dev, tvCount: Math.min(tv, dev),
  });
  if (alloc && alloc.ok) return { mode: 'MOVE', policy: info.policy, reason: keep.reason, alloc, dt, durationDays: info.durationDays };
  return { mode: 'NONE', policy: info.policy, reason: keep.reason, durationDays: info.durationDays };
}

const accountOfRef = (ref) => { const r = String(ref || '').trim(); const cut = r.indexOf('#P'); return cut >= 0 ? r.slice(0, cut) : r; };
const deviceNames = (rows) => rows.map((r, i) => 'Device ' + (asNum(r.group_index) || i + 1)).join(' and ');

// F1: the whole purchase (every login row) renews together, for one price.
//   one row (a normal or same-login subscription): today's R1 decision; if nothing can take all N devices
//     together but N separate accounts can (schema-v19) → SPLIT into one row per device.
//   several rows (separate logins): each row keeps its account if it can; the others MOVE to other accounts
//     (1 device each, different from the kept ones when possible). If any device can't be placed → NONE.
async function _purchaseRenewalDecision(conn, rows, plan) {
  const lead = rows[0];
  const targetPlan = plan || lead.plan;
  if (rows.length === 1) {
    const d = await _renewalDecision(conn, lead, targetPlan);
    d.rows = rows;
    d.keeps = d.mode === 'SAME' ? [{ row: lead, creds: d.creds }] : [];
    d.moves = d.mode === 'MOVE' ? [{ row: lead, reason: d.reason, part: { alloc: d.alloc, dt: d.dt } }] : [];
    if (d.mode !== 'NONE') return d;
    const { dev, tv } = _heldDevices(lead);
    if (dev > 1 && await _deviceLoginsOn(conn, lead.service, targetPlan, d.policy, dev)) {
      const parts = await _separateParts(conn, d.policy, { service: lead.service, plan: targetPlan, tvCount: Math.min(tv, dev) }, dev);
      if (parts) return Object.assign(d, { mode: 'SPLIT', parts });
    }
    return d;
  }
  const info = await _renewalPlanInfo(conn, lead.service, targetPlan);
  const base = { policy: info.policy, durationDays: info.durationDays, rows, keeps: [], moves: [] };
  const held = rows.reduce((n, r) => n + _heldDevices(r).dev, 0);
  if (deviceLogins.devicesForPlan(targetPlan) !== held) return Object.assign(base, { mode: 'NONE', reason: 'DEVICES' });
  if (info.policy === 'MANUAL') return Object.assign(base, { mode: 'SAME', keeps: rows.map((row) => ({ row })) });
  const moving = [];
  for (const row of rows) {
    const k = await _canKeepAccount(conn, info.policy, row, targetPlan);
    if (k.keep) base.keeps.push({ row, creds: k.creds }); else moving.push({ row, reason: k.reason });
  }
  if (!moving.length) return Object.assign(base, { mode: 'SAME' });
  const a = { service: lead.service, plan: targetPlan, tvCount: moving.reduce((n, m) => n + Math.min(1, _heldDevices(m.row).tv), 0) };
  const exclude = new Set(base.keeps.map((k) => accountOfRef(k.row.inventory_ref)));
  const parts = (await _separateParts(conn, info.policy, a, moving.length, exclude)) || (await _separateParts(conn, info.policy, a, moving.length));
  if (!parts) return Object.assign(base, { mode: 'NONE', reason: moving[0].reason });
  moving.sort((x, y) => Math.min(1, _heldDevices(y.row).tv) - Math.min(1, _heldDevices(x.row).tv)); // TV devices get the TV places (listed first)
  return Object.assign(base, { mode: 'MOVE', reason: moving[0].reason, moves: moving.map((m, i) => ({ row: m.row, reason: m.reason, part: parts[i] })) });
}

function _renewalMessage(d) {
  const n = d.rows.length;
  if (d.mode === 'NONE') {
    if (d.reason === 'DEVICES') {
      const held = d.rows.reduce((x, r) => x + _heldDevices(r).dev, 0);
      return 'This plan has a separate login for each of its ' + held + ' devices. To renew it, please choose the same ' + held + '-device plan.';
    }
    return RENEW_NONE_MESSAGE;
  }
  if (d.mode === 'SPLIT') {
    const dev = _heldDevices(d.rows[0]).dev;
    return 'Your old account can no longer take ' + deviceLogins.bothWord(dev) + ' together and no single account has room for them, so each device will get its own login right after renewal.';
  }
  if (d.mode === 'MOVE') {
    if (n === 1) return RENEW_MOVE_MESSAGE[d.reason] || RENEW_MOVE_MESSAGE.DEFAULT;
    const moved = d.moves.map((m) => m.row);
    return (moved.length === n ? 'The old accounts for your devices are' : 'The old account for ' + deviceNames(moved) + ' is') +
      ' no longer available, so ' + (moved.length === 1 ? 'that device' : 'those devices') + ' will get a new login right after renewal.' +
      (moved.length < n ? ' Your other device' + (n - moved.length === 1 ? ' keeps its' : 's keep their') + ' login.' : '');
  }
  return '';
}

// Renewal days (F4) for the purchase: "removed" only when every login was removed; the latest removal counts
// (the customer could watch until then). One row → exactly that row's values.
function _purchaseRemoval(rows) {
  const removed = rows.every((r) => Number(r.removed) === 1);
  if (!removed) return { removed: false, removedAt: null };
  let at = null;
  for (const r of rows) { const d = require('./renewal').toDate(r.removed_at); if (d && (!at || d.getTime() > at.getTime())) at = d; }
  return { removed: true, removedAt: rows.length === 1 ? rows[0].removed_at : at };
}

/** Before payment: what will happen to this renewal? Used by createRenewOrder. */
async function planRenewal(subId, plan) {
  const conn = await db.getPool().getConnection();
  try {
    const s = await _renewalSub(conn, subId);
    if (!s) return { mode: 'NONE', message: 'Subscription not found.' };
    const rows = await _renewalRows(conn, s);
    const d = await _purchaseRenewalDecision(conn, rows, plan);
    const message = _renewalMessage(d);
    const rem = _purchaseRemoval(rows);
    const rn = computeRenewal({ expiry: s.expiry_date, removed: rem.removed, removedAt: rem.removedAt, now: new Date(), durationDays: d.durationDays });
    const preview = { newExpiryText: rn.newExpiryText, message: rn.message, bubble: rn.bubble, counted: rn.counted, gifted: rn.gifted, case: rn.case };
    const out = { mode: d.mode, reason: d.reason || '', message, preview };
    if (rows.length > 1 || d.mode === 'SPLIT') Object.assign(out, { leadSubId: rows[0].sub_id, logins: rows.length, devices: rows.reduce((x, r) => x + _heldDevices(r).dev, 0) });
    return out;
  } finally { conn.release(); }
}

function _applyAccess(row, a) {
  Object.assign(row, { login_id: a.user || '', password: a.pass || '', profile_name: a.profileName || '', profile_pin: a.profilePin || '' });
}

// Extend an existing subscription (renewal) — every login row of the purchase, for one payment.
// New expiry follows the agreed rules in renewal.js (F4). Runs under the same lock as new sales, so moving a
// customer to another account can never race a purchase for the last free slot.
async function _fulfillRenew(o) {
  const sid = String(o.renew_sub_id || '').trim();
  return withLock('ff_alloc', 12, async (conn) => {
    const s = await _renewalSub(conn, sid);
    if (!s) return { ok: false, found: true, orderId: o.order_id, fulfillment: 'ERROR', message: 'Renewal target not found — please contact support.' };
    let rows = await _renewalRows(conn, s);
    const groupsOn = !!s.group_id || (_heldDevices(s).dev > 1 && await deviceLogins.groupsReady((sql, p) => conn.query(sql, p)));
    const q = (sql, p) => conn.query(sql, p).then((r) => r[0]);
    // 🔑 Safety net (accesspassword.js): whatever happened before, the card is built from the password the
    // ACCOUNT has now. A row still on an older password is repaired (typed columns + raw_json) as we read it.
    const accessFor = async (list) => {
      await accessPassword.refreshAccessSafe(q, list);
      if (list.length === 1 && !groupsOn) return _accessOf(list[0]);
      const multi = deviceLogins.accessWithLogins(list);
      return Object.assign(_accessOf(list[0]), multi.logins ? { logins: multi.logins, sameLogin: multi.sameLogin, deviceCount: multi.deviceCount } : {});
    };

    // idempotent: if this renew order already applied, just show the (possibly new) credentials
    const [chk] = await conn.query('SELECT fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [o.order_id]);
    if (chk[0] && String(chk[0].fulfillment_status || '').toUpperCase() === 'FULFILLED') {
      if (groupsOn && s.group_id) rows = await _renewalRows(conn, await _renewalSub(conn, sid));
      return { ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED', message: '✅ Your subscription is renewed.', access: await accessFor(rows), subId: sid };
    }
    // Refunded or erased by the owner while this renewal waited for the lock: extend nothing.
    if (Array.isArray(chk) && !chk.length) return { ok: false, found: false, fulfillment: 'ERROR', message: 'Order not found in the FluxFilm database.' };
    if (chk[0] && String(chk[0].fulfillment_status || '').toUpperCase() === 'REFUNDED') return REFUNDED_RESULT(o.order_id);

    // Re-check the account(s) now: stock can change between order and payment.
    const d = await _purchaseRenewalDecision(conn, rows, o.plan);
    if (d.mode === 'NONE') {
      await conn.query("UPDATE orders SET fulfillment_status = 'FAILED' WHERE order_id = ?", [o.order_id]).catch(() => {});
      return { ok: true, found: true, orderId: o.order_id, fulfillment: 'NO_STOCK', message: d.reason === 'DEVICES'
        ? '😔 Your payment is received, but this renewal has a different number of devices than your plan. Please contact WhatsApp support — we\'ll sort it instantly.'
        : "😔 Your payment is received, but your old account is no longer available and no other account is free right now. Please contact WhatsApp support — we'll sort it instantly." };
    }

    // How many days the late renewal costs — agreed rules in renewal.js (F4).
    const rem = _purchaseRemoval(rows);
    // Admin renewals may choose where the new period starts (raw_json RenewBase, quickorders.js). Only admin-created
    // orders carry it; every other renewal uses the normal rule.
    const oraw = rawOf(o.raw_json);
    const adminBase = oraw.CreatedVia === 'ADMIN' ? String(oraw.RenewBase || '').toUpperCase() : '';
    const rp = {
      expiry: s.expiry_date, removed: rem.removed, removedAt: rem.removedAt,
      now: new Date(), durationDays: asNum(o.duration_days) || 30,
    };
    const rn = (adminBase === 'EXPIRY' || adminBase === 'TODAY') ? require('./renewal').computeAdminRenewal(Object.assign({ base: adminBase }, rp)) : computeRenewal(rp);
    const newExpiry = rn.newExpiry;
    const release = addDays(newExpiry, COOLDOWN_DAYS);
    const moved = d.mode === 'MOVE' || d.mode === 'SPLIT';

    await _inTransaction(conn, async () => {
      for (const k of d.keeps) {
        if (!k.creds) continue;
        const r = k.row; const c = k.creds;
        const fresh = {
          user: c.user, pass: c.pass,
          profileName: c.profileName != null ? c.profileName : (r.profile_name || ''),
          profilePin: c.profilePin != null ? c.profilePin : (r.profile_pin || ''),
        };
        if (fresh.user !== r.login_id || fresh.pass !== r.password || fresh.profileName !== (r.profile_name || '') || fresh.profilePin !== (r.profile_pin || '')) {
          // raw_json is not just an archive (CLAUDE.md): keep it in step or the row looks right in admin
          // and hands out the old password somewhere else.
          await conn.query("UPDATE subscriptions SET login_id = ?, password = ?, profile_name = ?, profile_pin = ?, " +
            "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.LoginId', ?, '$.Password', ?, '$.ProfileName', ?, '$.ProfilePIN', ?)) WHERE sub_id = ?",
          [fresh.user, fresh.pass, fresh.profileName, fresh.profilePin, fresh.user, fresh.pass, fresh.profileName, fresh.profilePin, r.sub_id]);
          console.log('[renew] refreshed stored login for', r.sub_id);
        }
        _applyAccess(r, fresh);
      }
      for (const m of d.moves) {
        const r = m.row; const na = m.part.alloc.access || {}; const dt = m.part.dt || '';
        await conn.query(
          "UPDATE subscriptions SET inventory_ref = ?, account_id = ?, login_id = ?, password = ?, profile_number = ?, profile_name = ?, profile_pin = ?, device_type = COALESCE(NULLIF(?, ''), device_type), " +
          "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.InventoryRef', ?, '$.LoginId', ?, '$.Password', ?, '$.ProfileNumber', ?, '$.ProfileName', ?, '$.ProfilePIN', ?)) WHERE sub_id = ?",
          [m.part.alloc.inventoryRef, m.part.alloc.accountId || m.part.alloc.inventoryRef, na.user || '', na.pass || '', na.profileNumber || '', na.profileName || '', na.profilePin || '', dt,
            m.part.alloc.inventoryRef, na.user || '', na.pass || '', String(na.profileNumber || ''), na.profileName || '', na.profilePin || '', r.sub_id]);
        console.log('[renew] moved', r.sub_id, 'from', r.inventory_ref, 'to', m.part.alloc.inventoryRef, '(' + m.reason + ')');
        _applyAccess(r, na);
        Object.assign(r, { inventory_ref: m.part.alloc.inventoryRef, profile_number: na.profileNumber || '', device_type: dt || r.device_type });
      }
      if (d.mode === 'SPLIT') {
        // One row held all N devices; no single account can take them any more → one row per device.
        const lead = rows[0];
        const groupId = lead.group_id || ('G-' + lead.sub_id);
        const size = d.parts.length;
        const next = [];
        for (let i = 0; i < size; i++) {
          const part = d.parts[i]; const na = part.alloc.access || {};
          const dt = d.policy === 'CAPACITY' ? (part.dt || (part.tv ? 'TV' : 'NON_TV')) : '';
          const tv = d.policy === 'CAPACITY' ? part.tv : null;
          const row = Object.assign({}, lead, { inventory_ref: part.alloc.inventoryRef, login_id: na.user || '', password: na.pass || '', profile_number: na.profileNumber || '', profile_name: na.profileName || '', profile_pin: na.profilePin || '', device_type: dt, device_count: 1, tv_count: tv, group_id: groupId, group_size: size, group_index: i + 1 });
          if (i === 0) {
            await conn.query(
              'UPDATE subscriptions SET inventory_ref = ?, account_id = ?, login_id = ?, password = ?, profile_number = ?, profile_name = ?, profile_pin = ?, device_type = ?, device_count = 1, tv_count = ?, group_id = ?, group_size = ?, group_index = 1 WHERE sub_id = ?',
              [part.alloc.inventoryRef, part.alloc.accountId || part.alloc.inventoryRef, row.login_id, row.password, row.profile_number, row.profile_name, row.profile_pin, dt, tv, groupId, size, lead.sub_id]);
          } else {
            row.sub_id = await freeSubId();
            while (next.some((x) => x.sub_id === row.sub_id)) row.sub_id = await freeSubId();
            await conn.query(SUB_INSERT_SQL,
              [row.sub_id, o.order_id, o.phone, o.phone_norm, o.email, lead.service, lead.plan, asNum(o.duration_days) || 30,
                fmtDt(require('./renewal').toDate(lead.start_date) || new Date()), fmtDt(newExpiry), 'RENEW', part.alloc.inventoryRef, part.alloc.accountId || part.alloc.inventoryRef,
                row.login_id, row.password, row.profile_number, row.profile_name, row.profile_pin, dt, 1, tv, fmtDt(release), groupId, size, i + 1]);
          }
          next.push(row);
        }
        console.log('[renew] split', lead.sub_id, 'from', lead.inventory_ref, 'into', size, 'login rows (' + d.reason + ')');
        rows = next;
      }

      // Back on the account: clear the "removed" tick so the next renewal starts clean.
      const clearRemoval = (await _hasRemovalColumns(conn)) ? ', removed = 0, removed_at = NULL' : '';
      for (const r of rows) {
        await conn.query(
          "UPDATE subscriptions SET expiry_date = ?, new_expiry = ?, order_id = ?, status = 'ACTIVE', fulfillment_status = 'FULFILLED', release_eligible_at = ?, fulfilled_at = NOW(), source = 'node'" + clearRemoval + ' WHERE sub_id = ?',
          [fmtDt(newExpiry), fmtDt(newExpiry), o.order_id, fmtDt(release), r.sub_id]);
      }
      await conn.query("UPDATE orders SET fulfillment_status = 'FULFILLED', fulfilled_at = NOW() WHERE order_id = ?", [o.order_id]);
    });

    // 🎁 Remember what the late-renewal rule did (renewal.js): how many days it counted, how many it gifted and
    // the sentence the customer is told. Without it the new expiry just looks short, and nobody can see later that
    // we already forgave the difference (owner, 22 Sep 2026: Swayam's renewal). Outside the transaction and
    // best-effort on purpose — a note must never be able to undo a renewal that has already happened.
    try {
      await conn.query(
        "UPDATE orders SET raw_json = JSON_SET(COALESCE(raw_json, JSON_OBJECT()), '$.RenewNote', ?, '$.RenewCounted', ?, '$.RenewGifted', ?, '$.RenewCase', ?) WHERE order_id = ? LIMIT 1",
        [String(rn.message || ''), Number(rn.counted || 0), Number(rn.gifted || 0), String(rn.case || ''), o.order_id]);
    } catch (e) { console.log('[renew] could not store the days note for', o.order_id + ':', e.message); }

    const access = await accessFor(rows);
    const notice = moved && (rows.length > 1 || d.mode === 'SPLIT') ? _renewalMessage(Object.assign({}, d, { rows: d.mode === 'SPLIT' ? [s] : d.rows })) : '';
    afterFulfillHook({
      event: 'RENEW',
      orderId: o.order_id, phone: o.phone, email: o.email, name: o.name,
      service: o.service, plan: o.plan, amount: o.final_amount,
      // 💳 Credit renewal: no coins until it is paid (credit.js awards them when the owner marks it paid).
      skipCoins: String(o.status || '').toUpperCase() === 'CREDIT',
      expiry: fmtDt(newExpiry), postPaymentMessage: '',
      access: access.logins ? access : { user: access.user, pass: access.pass, profileName: access.profileName, profilePin: access.profilePin, deviceType: access.deviceType },
      loginNotice: notice,
      // 🎁 "we counted only X days and gifted you Y" — the email said only the new date before.
      renewNote: rn.message || '', renewGifted: rn.gifted || 0, renewCounted: rn.counted || 0,
    });
    const head = d.mode === 'SPLIT' ? '✅ Renewed! No single account could take all your devices, so each device now has its own login.'
      : moved ? (rows.length > 1 ? '✅ Renewed! Some of your old logins were no longer available, so the new ones are below.' : '✅ Renewed! Your old account was no longer available, so here is your new login.')
        : '✅ Renewed!';
    return {
      ok: true, found: true, orderId: o.order_id, fulfillment: 'FULFILLED',
      message: head + ' Your plan now runs until ' + rn.newExpiryText + '.',
      renewMessage: rn.message, renewBubble: rn.bubble, renewCounted: rn.counted, renewGifted: rn.gifted, newExpiryText: rn.newExpiryText,
      postPaymentMessage: '', access, subId: sid, newExpiry: fmtDt(newExpiry), accountChanged: moved,
      loginNotice: notice,
    };
  });
}

async function _fulfillSafe(orderId, opts) {
  try { return await _fulfill(orderId, opts); }
  catch (e) { console.log('[fulfill] error:', e.message); return { ok: false, found: true, orderId, fulfillment: 'ERROR', message: 'Activation hit a snag — please contact support with your order id.', fulfillError: String(e && e.message || e) }; }
}

/**
 * Who may SEE the login details in the HTTP response?
 *  - NEW orders: the browser that created the order (it holds the per-order
 *    access token) or anyone presenting the phone number the order was placed on.
 *  - RENEW orders: only the subscription owner's phone. A token is not enough —
 *    otherwise paying to renew a stranger's subscription would reveal their login.
 * Fulfilment itself (allocation, coins, credentials email) always runs; only the
 * on-screen credentials are withheld, so a paying customer is never stuck: the
 * email and the Recover flow still give them access.
 */
async function _mayViewAccess(orderId, proof) {
  const p = (proof && typeof proof === 'object') ? proof : { token: proof };
  const token = String(p.token || '').trim();
  const phone = norm(p.phone);
  const [rows] = await db.getPool().query('SELECT phone_norm, order_type, raw_json FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  const o = rows[0];
  if (!o) return false;
  const phoneOk = !!phone && phone === String(o.phone_norm || '');
  if (String(o.order_type || '').toUpperCase() === 'RENEW') return phoneOk;
  const hash = String(rawOf(o.raw_json).AccessTokenHash || '');
  const tokenOk = !!token && !!hash && require('crypto').createHash('sha256').update(token).digest('hex') === hash;
  return tokenOk || phoneOk;
}

async function fulfillAndGetAccess(orderId, proof) {
  const out = await _fulfillSafe(orderId);
  if (!out || !out.access) return out;
  let allowed = false;
  try { allowed = await _mayViewAccess(orderId, proof); }
  catch (e) { console.log('[fulfill] access check failed:', e.message); }
  if (allowed) return out;
  const { access, ...rest } = out;
  return Object.assign(rest, {
    accessWithheld: true,
    message: '✅ Your account is ready. For your security the login details were emailed to you — you can also view them any time using Recover.',
  });
}

/** Admin endpoint only (key-protected): full result including credentials. opts.allowLegacy: old-site order. */
async function fulfillForAdmin(orderId, opts) {
  const o = {};
  if (opts && opts.allowLegacy) o.allowLegacy = true;
  if (opts && opts.allowCredit) o.allowCredit = true;
  return _fulfillSafe(orderId, Object.keys(o).length ? o : undefined);
}

module.exports = { fulfillAndGetAccess, fulfillForAdmin, planRenewal, checkDeviceLogins, pickDeviceLogins, allocatePrimeSeparate, allocateProfileSeparate, allocatePrime, allocateProfile, allocateNetflix, allocateWholeAccount, allocateOtp, _internal: { withLock, genSubId, freeSubId, monthsFromDays, notesAllowMonths, otpRowServes, OCC_ACTIVE, _deliveredRowsGuard,
  // 🔁 Switch account (adminswitch.js) counts capacity with exactly these.
  occupancyMap, primeOccupancy, sharingProfileOf, profileAccountLoad, _inTransaction, _heldDevices, rawOf,
  PRIME_MAX_TOTAL, PRIME_MAX_TV, NETFLIX_SHARING_NO, NETFLIX_SHARING_MAX } };
