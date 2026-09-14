/**
 * FluxFilm - multiple devices: same login or a separate login for each device (F1, decided 2026-09-14).
 *
 * Only Netflix (PROFILE policy) and Prime Video (CAPACITY policy) plans with 2+ devices in their name
 * ("Private 2 Devices 1M", "2 Devices 1M") offer the choice. Everything else behaves exactly as before.
 *
 *   same     — one login for all N devices (Netflix private: ONE private profile used on N devices).
 *   separate — one login per device, each on a different account → one subscriptions row per account,
 *              linked by order_id + group_id (schema-v19).
 *
 * Until db/schema-v19.sql has been run, groupsReady() is false: the question is hidden and every order is
 * delivered on one login (today's behaviour).
 *
 * Pure helpers + the schema check; the allocation itself lives in fulfill.js (under the allocation lock).
 */
const s = (v) => String(v == null ? '' : v).trim();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

/** Same rule as order.js / stock.js: "2 Devices 1M" → 2. */
function devicesForPlan(plan) {
  const m = s(plan).match(/(\d+)\s*device/i);
  return Math.max(1, Number(m && m[1]) || 1);
}

function serviceKind(service) {
  const x = s(service).toLowerCase();
  if (x.includes('netflix')) return 'netflix';
  if (x.includes('prime')) return 'prime';
  return '';
}

/** Does this plan offer "same login or separate logins"? (schema aside) */
function isEligible(p) {
  const x = p || {};
  if (s(x.fulfillmentMode).toUpperCase() === 'MANUAL') return false;
  if (devicesForPlan(x.plan) < 2) return false;
  const policy = s(x.policy).toUpperCase();
  const kind = serviceKind(x.service);
  return (kind === 'netflix' && policy === 'PROFILE') || (kind === 'prime' && policy === 'CAPACITY');
}

/** '' / missing → 'same'; 'same' | 'separate' (any case) → itself; anything else → null (invalid). */
function normalizeMode(v) {
  const x = s(v).toLowerCase();
  if (!x) return 'same';
  return x === 'same' || x === 'separate' ? x : null;
}

// ---- schema-v19 check (cached: "ready" forever, "not ready" for 60 s so running the file takes effect quickly)
const SCHEMA_SQL = "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND " +
  "((table_name = 'subscriptions' AND column_name IN ('group_id', 'group_size', 'group_index')) OR (table_name = 'orders' AND column_name = 'login_mode'))";
let _ready = false; let _checkedAt = 0;
/** q(sql, params) → rows (db.query) or [rows] (conn.query); both shapes accepted. Never throws. */
async function groupsReady(q) {
  if (_ready) return true;
  if (_checkedAt && Date.now() - _checkedAt < 60e3) return false;
  try {
    let rows = await q(SCHEMA_SQL, []);
    if (Array.isArray(rows) && Array.isArray(rows[0])) rows = rows[0];
    _ready = Number(((rows || [])[0] || {}).n) === 4;
  } catch (_) { _ready = false; }
  _checkedAt = Date.now();
  return _ready;
}
function _resetSchemaCache() { _ready = false; _checkedAt = 0; }

/**
 * How many complete sets of n devices on n DIFFERENT accounts fit, when account i has room for caps[i]
 * devices: the largest k with Σ min(caps[i], k) ≥ k·n.
 */
function maxSets(caps, n) {
  const c = (caps || []).map((x) => Math.max(0, Math.floor(asNum(x))));
  const need = Math.max(1, Math.floor(n) || 1);
  const total = c.reduce((a, b) => a + b, 0);
  if (need === 1) return total;
  for (let k = Math.floor(total / need); k >= 1; k--) {
    if (c.reduce((a, b) => a + Math.min(b, k), 0) >= k * need) return k;
  }
  return 0;
}

const bothWord = (n) => (Number(n) === 2 ? 'both devices' : 'all ' + n + ' devices');
const MESSAGES = {
  sameGaveSeparate: (n) => "One account doesn't have room for " + bothWord(n) + ' right now, so each device gets its own login (its own ID and password).',
  separateGaveSame: (n) => "We don't have enough separate accounts right now — please use this login on " + bothWord(n) + '.',
  outOfStock: (n) => 'Sorry — this ' + n + '-device plan is out of stock right now. Please try again later or message us on WhatsApp.',
};

function accessOfRow(r) {
  return {
    user: s(r.login_id), pass: s(r.password), profileName: s(r.profile_name), profilePin: s(r.profile_pin),
    profileNumber: s(r.profile_number), deviceType: s(r.device_type),
  };
}
const loginKey = (a) => [a.user, a.pass, a.profileNumber, a.profilePin].join('');

/** Rows of one purchase (in device order) → one entry per device: Device 1, Device 2 … */
function buildLogins(rows) {
  const list = (rows || []).slice().sort((a, b) => (asNum(a.group_index) || 0) - (asNum(b.group_index) || 0));
  const logins = [];
  for (const r of list) {
    const a = accessOfRow(r);
    const dev = Math.max(1, asNum(r.device_count) || 1);
    const tv = r.tv_count != null && r.tv_count !== '' ? asNum(r.tv_count) : null;
    for (let i = 0; i < dev; i++) {
      const deviceType = tv == null ? a.deviceType : (dev === 1 ? (tv >= 1 ? 'TV' : 'NON_TV') : a.deviceType);
      logins.push(Object.assign({}, a, { device: logins.length + 1, deviceType }));
    }
  }
  const sameLogin = logins.length > 0 && logins.every((x) => loginKey(x) === loginKey(logins[0]));
  return { deviceCount: logins.length, sameLogin, logins };
}

/** access (first login, back-compat) + logins/sameLogin/deviceCount when the purchase has 2+ devices. */
function accessWithLogins(rows) {
  const b = buildLogins(rows);
  const first = b.logins[0] ? Object.assign({}, b.logins[0]) : {};
  delete first.device;
  if (b.deviceCount > 1) Object.assign(first, { logins: b.logins, sameLogin: b.sameLogin, deviceCount: b.deviceCount });
  return first;
}

/** Plain-text lines for emails / admin: "Device 1 — ID / password (profile, PIN)". */
function loginLines(access) {
  const a = access || {};
  const one = (x) => [x.user, x.pass].filter(Boolean).join(' / ') +
    ((x.profileName || x.profileNumber || x.profilePin) ? ' (' + [x.profileName ? 'profile ' + x.profileName + (x.profileNumber ? ' #' + x.profileNumber : '') : (x.profileNumber ? 'profile #' + x.profileNumber : ''), x.profilePin ? 'PIN ' + x.profilePin : ''].filter(Boolean).join(', ') + ')' : '');
  if (!Array.isArray(a.logins) || a.logins.length < 2) return [one(a)];
  if (a.sameLogin) return [one(a.logins[0]), 'Use this same login on ' + bothWord(a.logins.length) + '.'];
  return a.logins.map((x) => 'Device ' + x.device + ' — ' + one(x));
}

module.exports = {
  devicesForPlan, serviceKind, isEligible, normalizeMode, groupsReady, maxSets, MESSAGES, bothWord,
  accessOfRow, buildLogins, accessWithLogins, loginLines, _resetSchemaCache, SCHEMA_SQL,
};
