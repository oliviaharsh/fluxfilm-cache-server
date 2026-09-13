/**
 * FluxFilm - live stock levels, derived from real inventory.
 *
 * WHY: the storefront used to show a static PLANS `Stock` number that an Apps
 * Script job kept up to date. Nothing updates it on the MySQL stack, so badges
 * went stale — and an `OUT` badge disables the Buy button. Plans that had plenty
 * of free accounts could not be bought, while a sold-out service still showed OK
 * and failed only AFTER the customer had paid.
 *
 * This module answers "how many more of this plan could we sell right now?" by
 * applying the SAME rules fulfill.js uses to allocate: same account filters, same
 * capacity defaults, same occupancy (every ACTIVE, not-yet-released subscription,
 * legacy or node). test coverage cross-checks it against the real allocators, so a
 * rule change in one without the other fails loudly.
 *
 * Manual services (policy NONE/MANUAL/blank) have no inventory to count, so they
 * keep honouring the PLANS `Stock` column — that is how you pause one by hand.
 */
const db = require('./db');
const { buildLoginGroups } = require('./logins');

const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();

// Mirrors of the fulfill.js tunables — read at call time so tests can vary them.
const cfg = () => ({
  primeMaxTotal: Number(process.env.PRIME_MAX_TOTAL || 4),
  primeMaxTv: Number(process.env.PRIME_MAX_TV || 2),
  sharingNo: Number(process.env.NETFLIX_SHARING_PROFILE_NO || 1),
  sharingMax: Number(process.env.NETFLIX_SHARING_MAX_TOTAL || 5),
  low: Math.max(1, Number(process.env.STOCK_LOW_THRESHOLD || 3) || 3),
});

// Same occupancy rule as fulfill.js OCC_ACTIVE (tests assert they are identical).
const OCC_ACTIVE = "UPPER(status)='ACTIVE' AND (expiry_date > NOW() OR release_eligible_at > NOW())";

/** One round-trip per table; no credentials leave the database. */
async function loadSnapshot() {
  const [accounts, caps, profiles, occ, accountRows] = await Promise.all([
    db.query("SELECT service, account_id, notes, plan, (COALESCE(login_id,'') <> '' AND COALESCE(password,'') <> '') AS has_creds FROM inventory_accounts WHERE UPPER(is_active)='TRUE'", []),
    db.query('SELECT service, account_id, max_total, max_tv, is_active FROM inventory_capacity', []),
    db.query('SELECT service, account_id, profile_number, raw_json FROM inventory_profiles', []),
    db.query(
      'SELECT LOWER(service) svc, inventory_ref, SUM(COALESCE(device_count,1)) total, ' +
      "SUM(CASE WHEN tv_count IS NOT NULL THEN tv_count WHEN UPPER(device_type)='TV' THEN COALESCE(device_count,1) ELSE 0 END) tv " +
      'FROM subscriptions WHERE ' + OCC_ACTIVE + ' GROUP BY LOWER(service), inventory_ref', []),
    // Every row (active or not) with a hashed login, to group rows that share one login.
    db.query("SELECT service, account_id, SHA2(LOWER(TRIM(COALESCE(login_id,''))), 256) AS login_key, (TRIM(COALESCE(login_id,'')) <> '') AS has_login FROM inventory_accounts", []),
  ]);
  return { accounts, caps, profiles, occ, accountRows };
}

// `LOWER(service) LIKE '%x%'` in JS.
const likeSvc = (service, needle) => s(service).toLowerCase().includes(needle);

function occupancy(snap, needle) {
  const m = new Map();
  for (const o of snap.occ) {
    if (!String(o.svc || '').includes(needle)) continue;
    const ref = String(o.inventory_ref);
    const cur = m.get(ref) || { total: 0, tv: 0 };
    cur.total += asNum(o.total); cur.tv += asNum(o.tv);
    m.set(ref, cur);
  }
  return m;
}

function monthsFromDays(days) {
  const d = asNum(days);
  if (d >= 330) return 12; if (d >= 150) return 6; if (d >= 75) return 3; if (d >= 20) return 1;
  return Math.max(1, Math.round(d / 30));
}
function notesAllowMonths(notes, months) {
  const nums = String(notes || '').match(/\d+/g);
  if (!nums || !nums.length) return true;
  return nums.map(Number).includes(months);
}
// Mirror of fulfill.js otpRowServes: an OTP account row serves only its Plan.
function otpRowServes(row, plan, months) {
  const rowPlan = String(row.plan || '').trim().toLowerCase();
  if (rowPlan) return !!plan && rowPlan === String(plan).trim().toLowerCase();
  return notesAllowMonths(row.notes, months);
}

/** Devices a plan uses — same derivation as order.js createOrder ("2 Devices 1M" → 2). */
function devicesForPlan(plan) {
  const m = String(plan || '').match(/(\d+)\s*device/i);
  return Math.max(1, Number(m && m[1]) || 1);
}

/**
 * How many more purchases of this plan can be fulfilled right now, or null when
 * the plan is not inventory-backed (manual services).
 */
function unitsForPlan(snap, p) {
  const c = cfg();
  const raw = rawOf(p.raw_json);
  const policy = up(raw.AllocationPolicy);
  const mode = up(raw.FulfillmentMode);
  if (mode === 'MANUAL' || !['CAPACITY', 'PROFILE', 'ACCOUNT', 'OTP_ACCOUNT'].includes(policy)) return null;

  const service = s(p.service || raw.Service);
  const plan = s(p.plan || raw.Plan);
  const need = devicesForPlan(plan);

  if (policy === 'CAPACITY') {
    const accs = snap.accounts.filter((a) => likeSvc(a.service, 'prime') && Number(a.has_creds));
    const capMap = new Map();
    for (const x of snap.caps) {
      if (!likeSvc(x.service, 'prime')) continue;
      capMap.set(String(x.account_id), { maxTotal: asNum(x.max_total) || c.primeMaxTotal, maxTV: asNum(x.max_tv) || c.primeMaxTv, isActive: up(x.is_active) === 'TRUE' });
    }
    const occ = occupancy(snap, 'prime');
    let units = 0;
    for (const a of accs) {
      const id = String(a.account_id); if (!id) continue;
      const cap = capMap.get(id) || { maxTotal: c.primeMaxTotal, maxTV: c.primeMaxTv, isActive: true };
      if (!cap.isActive) continue;
      const o = occ.get(id) || { total: 0, tv: 0 };
      if (o.tv > cap.maxTV) continue; // allocator rejects even a non-TV order here
      const free = cap.maxTotal - o.total;
      if (free >= need) units += Math.floor(free / need);
    }
    return units;
  }

  if (policy === 'PROFILE') {
    // Mirrors fulfill.js allocateProfile: Netflix draws from all Netflix accounts
    // and never sells shared profile #sharingNo privately; other services draw
    // from their own accounts and every PRIVATE_ROTATING profile is sellable.
    const isNetflix = /netflix/i.test(service);
    const needle = isNetflix ? 'netflix' : service.toLowerCase();
    const reservedNo = isNetflix ? c.sharingNo : null;
    const accs = snap.accounts.filter((x) => likeSvc(x.service, needle) && Number(x.has_creds));
    const capMap = new Map();
    for (const x of snap.caps) {
      if (!likeSvc(x.service, needle)) continue;
      capMap.set(String(x.account_id), { maxTotal: asNum(x.max_total) || c.sharingMax, isActive: up(x.is_active) !== 'FALSE' });
    }
    const occ = occupancy(snap, needle);
    const byAcc = new Map();
    for (const pr of snap.profiles) {
      if (!likeSvc(pr.service, needle)) continue;
      const acc = s(pr.account_id); if (!acc) continue;
      const r = rawOf(pr.raw_json);
      const entry = { pno: asNum(pr.profile_number) || asNum(r.ProfileNumber), type: up(r.ProfileType), reserved: up(r.IsReserved) === 'TRUE' };
      if (!byAcc.has(acc)) byAcc.set(acc, []);
      byAcc.get(acc).push(entry);
    }
    const sharing = /sharing|group/i.test(plan);
    let units = 0;
    for (const acct of accs) {
      const acc = String(acct.account_id); if (!acc) continue;
      const list = byAcc.get(acc) || [];
      if (sharing) {
        const cap = capMap.get(acc) || { maxTotal: c.sharingMax, isActive: true }; if (!cap.isActive) continue;
        const prof = (reservedNo != null && list.find((x) => x.pno === reservedNo)) || list.find((x) => x.type.indexOf('SHARING') === 0 || x.reserved);
        if (!prof || !prof.pno) continue;
        const free = cap.maxTotal - ((occ.get(acc + '#P' + prof.pno) || {}).total || 0);
        if (free >= need) units += Math.floor(free / need);
      } else {
        for (const x of list) {
          if (!x.pno || x.pno === reservedNo || x.type !== 'PRIVATE_ROTATING') continue;
          if (!((occ.get(acc + '#P' + x.pno) || {}).total > 0)) units += 1;
        }
      }
    }
    return units;
  }

  // ACCOUNT and OTP_ACCOUNT: whole accounts matched by the plan's own service name.
  const needle = service.toLowerCase();
  const isOtp = policy === 'OTP_ACCOUNT';
  const months = monthsFromDays(p.duration_days != null ? p.duration_days : raw.DurationDays);
  const accs = snap.accounts.filter((a) => likeSvc(a.service, needle) && Number(a.has_creds) && (!isOtp || otpRowServes(a, plan, months)));
  const occ = occupancy(snap, needle);
  const groups = buildLoginGroups(
    (snap.accountRows || []).filter((r) => likeSvc(r.service, needle))
      .map((r) => ({ account_id: r.account_id, key: Number(r.has_login) ? String(r.login_key) : '' })),
    snap.caps.filter((x) => likeSvc(x.service, needle)),
    (id) => (occ.get(id) || {}).total || 0);
  const perSale = isOtp ? 1 : need; // OTP has no device count
  const counted = new Set(); // one login listed on several rows is counted once
  let units = 0;
  for (const a of accs) {
    const acc = String(a.account_id); if (!acc) continue;
    const g = groups.forId(acc);
    if (!g.isActive || counted.has(g.key)) continue;
    counted.add(g.key);
    const free = g.maxTotal - g.used;
    if (free >= perSale) units += Math.floor(free / perSale);
  }
  return units;
}

function levelFor(units, low) {
  if (units == null) return 'OK';
  return units <= 0 ? 'OUT' : (units < low ? 'LOW' : 'OK');
}

/** { "Service|||Plan": { stock, stockLevel, source } } for every active plan. */
async function computeStockLevels(planRows) {
  const snap = await loadSnapshot();
  const { low } = cfg();
  const levels = {};
  for (const p of planRows) {
    const raw = rawOf(p.raw_json);
    const service = s(p.service || raw.Service);
    const plan = s(p.plan || raw.Plan);
    if (!service || !plan) continue;
    const units = unitsForPlan(snap, p);
    if (units != null) {
      levels[service + '|||' + plan] = { stock: units, stockLevel: levelFor(units, low), source: 'inventory' };
    } else {
      // Manual service: the PLANS `Stock` column is the only signal (blank = unlimited).
      const stockText = s(raw.Stock);
      const stock = stockText === '' ? null : Math.max(0, Math.floor(asNum(raw.Stock)));
      levels[service + '|||' + plan] = { stock, stockLevel: levelFor(stock, low), source: 'manual' };
    }
  }
  return levels;
}

module.exports = { computeStockLevels, unitsForPlan, loadSnapshot, levelFor, devicesForPlan, OCC_ACTIVE };
