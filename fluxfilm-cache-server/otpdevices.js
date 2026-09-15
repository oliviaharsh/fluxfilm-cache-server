/**
 * FluxFilm - 📱 OTP accounts & devices (admin). The owner's old JioHotstar Sheet table, now from MySQL:
 * per OTP login account (JioHotstar / SonyLIV / Zee5 …) its customers, expiry, status and the DEVICE NAME the owner
 * types ("LG TV", "Honor phone") so an expired customer's device can be logged out in the app before 🚪 Remove.
 *
 * Storage (no schema change): subscriptions.raw_json DeviceName, DeviceNameUpdatedAt (+ DeviceNameSource 'sheet' when
 * copied from the old Sheet). Device type is the typed subscriptions.device_type column AND raw_json DeviceType, always
 * written together (CLAUDE.md: typed columns and raw_json stay in sync).
 *
 * Every read is a separate single-table query, matched in JS (MariaDB "Illegal mix of collations" lesson).
 * compute() / parseRows() / matchRows() are pure and tested (test/otp-devices.test.js).
 *
 * Old Sheet import (owner, 15 Sep): READ-ONLY. The Sheet is read through the Apps Script adminDumpTab action (the same
 * reader sync.js uses for the final import) or the owner pastes the rows. Nothing is ever written to the Sheet — the
 * reader here has no write method at all.
 */
const { loginKey, buildLoginGroups } = require('./logins');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
function rawOf(v) {
  if (v == null || v === '') return {};
  if (typeof v === 'object') return v;
  try { const j = JSON.parse(v); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (_) { return {}; }
}
/** true when raw_json holds something that is not a JSON object (never overwrite it blindly). */
function rawBroken(v) {
  if (v == null || v === '' || typeof v === 'object') return false;
  try { const j = JSON.parse(v); return !(j && typeof j === 'object' && !Array.isArray(j)); } catch (_) { return true; }
}

/* ---------- which services are OTP ---------- */
const OTP_RE = /hotstar|sony ?liv|\bsony\b|zee ?5/i;
/** Plans with AllocationPolicy OTP_ACCOUNT, or the known OTP names (same list as index.html isOtpSvc / recover.js). */
function isOtpService(service, policyOf) {
  const k = s(service).toLowerCase();
  if (!k) return false;
  if (policyOf && up(policyOf[k]) === 'OTP_ACCOUNT') return true;
  return OTP_RE.test(k);
}
/** 'jiohotstar' | 'sonyliv' | 'zee5' | the lower-case name: one tab per real service. */
function canonService(service) {
  const x = s(service).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (x.includes('hotstar') || x.includes('jiocinema')) return 'jiohotstar';
  if (x.includes('sony')) return 'sonyliv';
  if (x.includes('zee5') || x === 'zee') return 'zee5';
  return x;
}
const LABELS = { jiohotstar: 'JioHotstar', sonyliv: 'SonyLIV', zee5: 'Zee5' };

/* ---------- dates (the database stores India time without a zone) ---------- */
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  const t = s(v);
  if (/Z$|[+-]\d\d:?\d\d$/.test(t)) return new Date(t).getTime();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 5.5 * 3600e3;
}
const istDay = (ms) => Math.floor((ms + 5.5 * 3600e3) / 86400e3);
const dayOfYmd = (ymd) => { const m = s(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400e3) : NaN; };
/** 'YYYY-MM-DD HH:MM:SS' India time. */
function istStamp(ms) {
  const d = new Date((ms == null ? Date.now() : ms) + 5.5 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
const dateText = (v) => (v instanceof Date ? istStamp(v.getTime()) : s(v));

/* ---------- device name / type ---------- */
const MAX_DEVICE_NAME = 60;
/** { ok, value } — trimmed, spaces collapsed, control characters dropped, at most 60 characters. */
function cleanDeviceName(v) {
  if (v != null && typeof v !== 'string' && typeof v !== 'number') return { ok: false, message: 'Device name must be text.' };
  const t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...t].length > MAX_DEVICE_NAME) return { ok: false, message: 'Device name is too long (max ' + MAX_DEVICE_NAME + ' characters).' };
  return { ok: true, value: t };
}
/** 'PHONE' | 'TV' | '' (blank) | null (not a device type). Accepts "📱 PHONE", "📺 TV", "mobile". */
function normDeviceType(v) {
  const raw = s(v);
  const t = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (t === '') { if (raw.includes('📺')) return 'TV'; if (raw.includes('📱')) return 'PHONE'; return raw === '' ? '' : null; }
  if (t === 'PHONE' || t === 'MOBILE' || t === 'MOBILEPHONE' || t === 'SMARTPHONE') return 'PHONE';
  if (t === 'TV' || t === 'SMARTTV') return 'TV';
  return null;
}

/* ---------- multi-device plans (same login on N devices = one row with device_count N) ---------- */
const MAX_DEVICES = 10;
const devCount = (v) => Math.max(1, Math.min(MAX_DEVICES, Math.floor(Number(v)) || 1));
/**
 * Per-device names of one subscription: [{ device, name, type }] for devices 1..n. raw_json DeviceNames holds them for
 * a multi-device plan; device 1 falls back to DeviceName / device_type (DeviceName always = device 1, backward compatible).
 */
function deviceList(raw, n, typedType) {
  const r = raw || {};
  const src = Array.isArray(r.DeviceNames) ? r.DeviceNames.filter((x) => x && typeof x === 'object') : [];
  const count = Math.max(devCount(n), Math.min(MAX_DEVICES, src.reduce((m, x) => Math.max(m, Math.floor(Number(x.device)) || 0), 0)));
  const out = [];
  for (let i = 1; i <= count; i++) {
    const e = src.find((x) => Number(x.device) === i);
    let name = e ? s(e.name) : '', type = e ? (normDeviceType(e.type) || '') : '';
    if (i === 1) { if (!name) name = s(r.DeviceName); if (!type) type = normDeviceType(typedType) || normDeviceType(r.DeviceType) || ''; }
    out.push({ device: i, name, type });
  }
  return out;
}
/** One line for cards: "LG TV" (one device) or "Device 1: LG TV · Device 2: Mi TV" ('' when nothing is named). */
function deviceNamesText(rawJson, n) {
  const raw = rawOf(rawJson);
  const list = deviceList(raw, n, null);
  if (list.length < 2) return s(raw.DeviceName);
  if (!list.some((d) => d.name)) return '';
  return list.map((d) => 'Device ' + d.device + ': ' + (d.name || '—')).join(' · ');
}

/* ---------- the list ---------- */
const REFUND_STATUS = ['REFUNDED', 'CANCELLED', 'CANCELED'];
const isRemoved = (x) => Number(x.removed) === 1 || x.removed === true || up(x.removed) === 'TRUE';
const accountOfRef = (ref) => { const r = s(ref); const cut = r.indexOf('#'); return cut >= 0 ? r.slice(0, cut) : r; };
const digits10 = (v) => { const d = s(v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const mask = (ph) => (s(ph) ? '…' + s(ph).slice(-4) : '');

function statusOf(x, now) {
  if (REFUND_STATUS.includes(up(x.status)) || /REFUNDED/.test(up(x.fulfillment_status))) return 'REFUNDED';
  const ex = toMs(x.expiry_date);
  if (up(x.status) === 'ACTIVE' && ex > now) return 'ACTIVE';
  return 'EXPIRED';
}
function statusLabel(row) {
  if (row.status === 'REFUNDED') return '↩️ Refunded';
  if (row.status === 'ACTIVE') return '✅ ACTIVE';
  const d = row.daysAgo;
  return '⚠️ EXPIRED ' + (d == null ? '' : d <= 0 ? 'today' : d + 'd ago');
}

/** Free-text search: customer name, phone, device name, account (ID / login), order or sub id. */
function matchesQuery(row, acc, q) {
  const t = s(q).toLowerCase(); if (!t) return true;
  const hay = [row.name, row.deviceName, (row.devices || []).map((d) => d.name).join(' '), row.orderId, row.subId, row.plan, acc.loginLabel, acc.accountIds.join(' ')].join(' ').toLowerCase();
  if (hay.includes(t)) return true;
  const d = t.replace(/\D/g, '');
  return d.length >= 3 && (s(row.phone).includes(d) || s(acc.login).replace(/\D/g, '').includes(d));
}

/**
 * input: { subs, accounts, caps, customers, plans, now, service, q, showRemoved }
 *   subs:      subscriptions rows (sub_id, order_id, phone_norm, service, plan, status, fulfillment_status, expiry_date,
 *              release_eligible_at, inventory_ref, account_id, login_id, device_type, device_count, removed, removed_at,
 *              renew_sub_id, raw_json)
 *   accounts:  inventory_accounts (service, account_id, login_id, is_active, plan)
 *   caps:      inventory_capacity (service, account_id, max_total, is_active)
 *   customers: [{ phone_norm, name }]
 *   plans:     [{ service, raw_json }]  → AllocationPolicy OTP_ACCOUNT
 */
function compute(input) {
  const inp = input || {};
  const now = inp.now == null ? Date.now() : (inp.now instanceof Date ? inp.now.getTime() : Number(inp.now));
  const policyOf = {};
  for (const p of inp.plans || []) { const k = s(p.service).toLowerCase(); const pol = up(rawOf(p.raw_json).AllocationPolicy); if (k && pol && !policyOf[k]) policyOf[k] = pol; }
  const otp = (svc) => isOtpService(svc, policyOf);
  const nameOfPhone = new Map();
  for (const c of inp.customers || []) { const ph = s(c.phone_norm); if (ph && s(c.name) && !nameOfPhone.has(ph)) nameOfPhone.set(ph, s(c.name)); }

  const subs = (inp.subs || []).filter((x) => otp(x.service) && up(x.status) !== 'ERASED');
  const accounts = (inp.accounts || []).filter((a) => otp(a.service) && s(a.account_id));
  const caps = (inp.caps || []).filter((c) => otp(c.service));

  // Service tabs: every OTP service seen in plans, inventory or subscriptions.
  const tabs = new Map();
  const tab = (svc) => { const k = canonService(svc); if (!k) return null; if (!tabs.has(k)) tabs.set(k, { key: k, label: LABELS[k] || s(svc), accounts: 0, active: 0, expired: 0 }); return tabs.get(k); };
  Object.keys(policyOf).forEach((k) => { if (policyOf[k] === 'OTP_ACCOUNT') tab(k); });
  (inp.plans || []).forEach((p) => { if (otp(p.service)) tab(p.service); });
  accounts.forEach((a) => tab(a.service));
  subs.forEach((x) => tab(x.service));
  const want = s(inp.service) ? canonService(inp.service) : '';

  // Login of each account ID (one real login can be listed under several IDs: JH-3M-02, JH-1Y-02).
  const loginOfId = new Map(), labelOfId = new Map();
  for (const a of accounts) { const id = s(a.account_id); if (!loginOfId.get(id)) { loginOfId.set(id, loginKey(a.login_id)); labelOfId.set(id, s(a.login_id)); } }

  // Occupancy per account ID: the allocator's rule (ACTIVE and not expired or still inside release time).
  const usedById = new Map();
  for (const x of subs) {
    const id = accountOfRef(x.inventory_ref) || s(x.account_id); if (!id) continue;
    const occupying = up(x.status) === 'ACTIVE' && (toMs(x.expiry_date) > now || toMs(x.release_eligible_at) > now);
    if (occupying) usedById.set(id, (usedById.get(id) || 0) + (Number(x.device_count) || 1));
  }
  const groupsByCanon = new Map();
  const loginGroups = (canon) => {
    if (!groupsByCanon.has(canon)) {
      groupsByCanon.set(canon, buildLoginGroups(
        accounts.filter((a) => canonService(a.service) === canon).map((a) => ({ account_id: a.account_id, key: loginKey(a.login_id) })),
        caps.filter((c) => canonService(c.service) === canon),
        (id) => usedById.get(id) || 0));
    }
    return groupsByCanon.get(canon);
  };

  const cards = new Map();
  const cardFor = (canon, login, id, service) => {
    const key = canon + '|' + (login ? 'L:' + login : id ? 'id:' + id : 'none');
    let c = cards.get(key);
    if (!c) { c = { key, service: LABELS[canon] || s(service), canon, login, loginLabel: '', accountIds: new Set(), services: new Set(), rows: [], removedRecent: [], noAccount: !login && !id }; cards.set(key, c); }
    if (id) c.accountIds.add(id);
    if (s(service)) c.services.add(s(service));
    return c;
  };
  // Every inventory account gets a card, even with nobody on it (capacity is still useful).
  for (const a of accounts) {
    const c = cardFor(canonService(a.service), loginKey(a.login_id), s(a.account_id), a.service);
    if (!c.loginLabel) c.loginLabel = s(a.login_id);
  }

  const rowsAll = [];
  for (const x of subs) {
    const canon = canonService(x.service);
    const id = accountOfRef(x.inventory_ref) || s(x.account_id);
    const login = loginKey(x.login_id) || loginOfId.get(id) || '';
    const c = cardFor(canon, login, id, x.service);
    if (!c.loginLabel) c.loginLabel = s(x.login_id) || labelOfId.get(id) || '';
    const raw = rawOf(x.raw_json);
    const status = statusOf(x, now);
    const ex = toMs(x.expiry_date);
    const today = istDay(now);
    const row = {
      subId: s(x.sub_id), orderId: s(x.order_id), phone: s(x.phone_norm), phoneMasked: mask(x.phone_norm),
      name: nameOfPhone.get(s(x.phone_norm)) || s(raw.Name) || mask(x.phone_norm) || '?',
      service: s(x.service), plan: s(x.plan),
      deviceType: normDeviceType(x.device_type) || normDeviceType(raw.DeviceType) || '',
      deviceCount: devCount(x.device_count),
      devices: devCount(x.device_count) > 1 ? deviceList(raw, x.device_count, x.device_type) : null,
      deviceName: s(raw.DeviceName), deviceNameUpdatedAt: s(raw.DeviceNameUpdatedAt), deviceNameSource: s(raw.DeviceNameSource),
      expiry: dateText(x.expiry_date), status,
      daysAgo: status === 'EXPIRED' && isFinite(ex) ? Math.max(0, today - istDay(ex)) : null,
      daysLeft: status === 'ACTIVE' && isFinite(ex) ? Math.max(0, istDay(ex) - today) : null,
      removed: isRemoved(x), removedAt: dateText(x.removed_at), renewSubId: s(x.renew_sub_id),
      _ms: isFinite(ex) ? ex : 0, _card: c,
    };
    row.label = statusLabel(row);
    row.canRemove = !row.removed && row.status !== 'ACTIVE';
    rowsAll.push(row);
  }

  // Renewed by the same customer on the same login: the old expired row is history, not a device to log out.
  for (const c of cards.values()) {
    const mine = rowsAll.filter((r) => r._card === c);
    const active = mine.filter((r) => r.status === 'ACTIVE' && !r.removed);
    const renewedIds = new Set(active.map((r) => r.renewSubId).filter(Boolean));
    const activePhones = new Set(active.map((r) => r.phone).filter(Boolean));
    for (const r of mine) {
      if (r.status !== 'EXPIRED' || r.removed) continue;
      if (renewedIds.has(r.subId) || (r.phone && activePhones.has(r.phone))) r.renewed = true;
    }
    // A renewal that got a new row: offer the old device name as a hint.
    for (const a of active) {
      if (a.deviceName) continue;
      const old = mine.filter((r) => r !== a && r.phone === a.phone && r.deviceName).sort((p, q) => q._ms - p._ms)[0];
      if (old) a.deviceNameHint = old.deviceName;
    }
  }

  const q = s(inp.q);
  const recentCut = now - 7 * 86400e3;
  const out = { now: new Date(now).toISOString(), service: want, services: [], counts: { accounts: 0, activeDevices: 0, expiredWaiting: 0, removedRecent: 0 }, accounts: [] };
  const rank = (r) => (r.status === 'ACTIVE' ? 1 : 0);
  for (const c of cards.values()) {
    const t = tabs.get(c.canon);
    const mine = rowsAll.filter((r) => r._card === c && !r.renewed);
    const live = mine.filter((r) => !r.removed);
    // Counts are DEVICES: a 2-device plan on one login is 2 active devices (the 🚪 waiting count stays per plan).
    const active = live.filter((r) => r.status === 'ACTIVE').reduce((n, r) => n + r.deviceCount, 0);
    const waiting = live.filter((r) => r.status !== 'ACTIVE').length;
    if (t && !c.noAccount) t.accounts++;
    if (t) { t.active += active; t.expired += waiting; }
    if (want && c.canon !== want) continue;
    out.counts.accounts += c.noAccount ? 0 : 1;
    out.counts.activeDevices += active;
    out.counts.expiredWaiting += waiting;
    const ids = [...c.accountIds].sort();
    const g = ids.length ? loginGroups(c.canon).forId(ids[0]) : null;
    const hasCap = !!(g && g.explicit && g.explicit.length);
    const acc = { key: c.key, service: c.service, services: [...c.services].sort(), login: c.login, loginLabel: c.loginLabel || c.login || '', accountIds: ids, noAccount: c.noAccount, active, expired: waiting, cap: hasCap ? g.maxTotal : null, used: g ? g.used : active, capInactive: g ? !g.isActive : false };
    const pick = (list) => list.filter((r) => matchesQuery(r, acc, q));
    let rows = pick(inp.showRemoved ? mine : live);
    const recent = pick(mine.filter((r) => r.removed && (toMs(r.removedAt) >= recentCut)));
    // Expired / refunded first (oldest expiry first), then active by the soonest expiry.
    rows = rows.sort((a, b) => (Number(a.removed) - Number(b.removed)) || (rank(a) - rank(b)) || (a._ms - b._ms) || a.name.localeCompare(b.name));
    recent.sort((a, b) => toMs(b.removedAt) - toMs(a.removedAt));
    const clean = (r) => { const o = Object.assign({}, r); delete o._ms; delete o._card; delete o.renewSubId; delete o.devices; o.key = o.subId; return o; };
    // A multi-device plan shows ONE ROW PER DEVICE ("Device 1 of 2"), each with its own name + type (raw_json DeviceNames).
    // 🚪 Remove stays per plan: allNames lets the confirm name every device.
    const expand = (r) => {
      if (!r.devices) return [clean(r)];
      const allNames = r.devices.map((d) => d.name);
      return r.devices.map((d) => Object.assign(clean(r), {
        key: r.subId + '#' + d.device, device: d.device, devices: r.devices.length, deviceName: d.name, deviceType: d.type, allNames,
        deviceNameHint: d.device === 1 ? r.deviceNameHint : undefined,
      }));
    };
    acc.rows = [].concat(...rows.map(expand));
    acc.removedRecent = recent.map((r) => Object.assign(clean(r), r.devices ? { deviceName: r.devices.map((d) => 'Device ' + d.device + ': ' + (d.name || '—')).join(' · ') } : {}));
    // Empty cards stay visible without a search (capacity view); a search shows only accounts with a match.
    if (q && !acc.rows.length && !acc.removedRecent.length && !matchesQuery({}, acc, q)) continue;
    if (c.noAccount && !acc.rows.length && !acc.removedRecent.length) continue;
    out.accounts.push(acc);
    out.counts.removedRecent += recent.length;
  }
  out.accounts.sort((a, b) => (Number(a.noAccount) - Number(b.noAccount)) || (b.expired - a.expired) || a.service.localeCompare(b.service) || String(a.accountIds[0] || a.loginLabel).localeCompare(String(b.accountIds[0] || b.loginLabel)));
  out.services = [...tabs.values()].sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/* ---------- MySQL reads: one table per query, matched in JS ---------- */
const SUB_COLS = 'sub_id, order_id, phone_norm, service, plan, status, fulfillment_status, expiry_date, release_eligible_at, inventory_ref, account_id, login_id, device_type, device_count, COALESCE(removed, 0) AS removed, removed_at, renew_sub_id, raw_json';
const OTP_LIKE = ['%hotstar%', '%sony%', '%zee%'];

const GROUP_COLS = ', group_id, group_size, group_index';
async function loadSubs(q, services) {
  const svc = [...new Set((services || []).map(s).filter(Boolean))].slice(0, 30);
  const where = OTP_LIKE.map(() => 'LOWER(service) LIKE ?').concat(svc.length ? ['service IN (' + svc.map(() => '?').join(', ') + ')'] : []);
  // Separate-login groups (schema-v19 group_id / group_index) only when those columns exist.
  const groups = await require('./devicelogins').groupsReady(q).catch(() => false);
  const rows = await q('SELECT ' + SUB_COLS + (groups ? GROUP_COLS : '') + ' FROM subscriptions WHERE ' + where.join(' OR '), OTP_LIKE.concat(svc));
  return Array.isArray(rows) ? rows : [];
}

async function load(q, opts) {
  const o = opts || {};
  const [plans, accounts, caps] = await Promise.all([
    q('SELECT service, raw_json FROM plans', []).catch(() => []),
    q('SELECT service, account_id, login_id, is_active, plan FROM inventory_accounts', []).catch(() => []),
    q('SELECT service, account_id, max_total, is_active FROM inventory_capacity', []).catch(() => []),
  ]);
  const otpPlanServices = (Array.isArray(plans) ? plans : []).filter((p) => up(rawOf(p.raw_json).AllocationPolicy) === 'OTP_ACCOUNT').map((p) => p.service);
  const subs = await loadSubs(q, otpPlanServices);
  const phones = [...new Set(subs.map((x) => s(x.phone_norm)).filter(Boolean))].slice(0, 2000);
  const customers = phones.length ? await q('SELECT phone_norm, name FROM customers WHERE phone_norm IN (' + phones.map(() => '?').join(', ') + ')', phones).catch(() => []) : [];
  return compute({ subs, accounts, caps, customers, plans, now: o.now, service: o.service, q: o.q, showRemoved: o.showRemoved });
}

/* ---------- save one device name / type ---------- */
/**
 * body: { subId, device?, setDevices?, deviceName?, deviceType? } (a field left out is not changed). device = 1..N of a
 * multi-device plan (default 1); setDevices raises a same-login plan to that many devices (never lowers). q = db.query-style.
 * Returns { ok, status?, message?, before, after, changed }.
 */
async function saveDevice(q, body, opts) {
  const b = body || {};
  const o = opts || {};
  const subId = s(b.subId || b.sub_id);
  if (!subId) return { ok: false, status: 400, message: 'subId required.' };
  const hasName = b.deviceName !== undefined, hasType = b.deviceType !== undefined;
  if (!hasName && !hasType && (b.setDevices === undefined || b.setDevices === null || b.setDevices === '')) return { ok: false, status: 400, message: 'Nothing to save.' };
  let name = null, type = null;
  if (hasName) { const c = cleanDeviceName(b.deviceName); if (!c.ok) return { ok: false, status: 400, message: c.message }; name = c.value; }
  if (hasType) { type = b.deviceType === null ? '' : normDeviceType(b.deviceType); if (type === null) return { ok: false, status: 400, message: 'Device type must be PHONE or TV.' }; }
  const hasDevice = b.device !== undefined && b.device !== null && b.device !== '';
  const device = hasDevice ? Number(b.device) : 1;
  if (!(Number.isInteger(device) && device >= 1 && device <= MAX_DEVICES)) return { ok: false, status: 400, message: 'Device number must be 1 to ' + MAX_DEVICES + '.' };
  const hasSet = b.setDevices !== undefined && b.setDevices !== null && b.setDevices !== '';
  const setDevices = hasSet ? Number(b.setDevices) : 0;
  if (hasSet && !(Number.isInteger(setDevices) && setDevices >= 2 && setDevices <= MAX_DEVICES)) return { ok: false, status: 400, message: 'Number of devices must be 2 to ' + MAX_DEVICES + '.' };
  const rows = await q('SELECT sub_id, service, device_type, device_count, raw_json FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]);
  const cur = Array.isArray(rows) && rows[0];
  if (!cur) return { ok: false, status: 404, message: 'Subscription not found.' };
  if (!isOtpService(cur.service, o.policyOf)) return { ok: false, status: 400, message: 'Only OTP services (JioHotstar, SonyLIV, Zee5) have device names here.' };
  if (rawBroken(cur.raw_json)) return { ok: false, status: 409, message: 'This subscription\'s raw_json is unreadable — fix it in 📋 Sheets first.' };
  const raw = rawOf(cur.raw_json);
  const curCount = devCount(cur.device_count);
  if (hasSet && setDevices < curCount) return { ok: false, status: 400, message: 'This plan already has ' + curCount + ' devices (never lowered here).' };
  const count = Math.max(curCount, setDevices);
  if (device > count) return { ok: false, status: 400, message: 'This plan has ' + count + ' device' + (count === 1 ? '' : 's') + ' — there is no device ' + device + '.' };
  if (count > 1) return saveMultiDevice(q, { subId, cur, raw, count, curCount, device, hasName, name, hasType, type }, o);
  const before = { deviceName: s(raw.DeviceName), deviceType: normDeviceType(cur.device_type) || normDeviceType(raw.DeviceType) || '' };
  const after = { deviceName: hasName ? name : before.deviceName, deviceType: hasType ? type : before.deviceType };
  const changed = [];
  if (hasName && after.deviceName !== before.deviceName) changed.push('deviceName');
  // Keep the typed column and raw_json in step even when only one of them was out of date.
  const typeOut = hasType && (after.deviceType !== before.deviceType || s(cur.device_type) !== after.deviceType || s(raw.DeviceType) !== after.deviceType);
  if (hasType && after.deviceType !== before.deviceType) changed.push('deviceType');
  if (!changed.length && !typeOut) return { ok: true, before, after, changed, unchanged: true };
  const stamp = istStamp(o.now);
  const sets = [], params = [], paths = [], pathParams = [];
  if (hasName && after.deviceName !== before.deviceName) {
    paths.push("'$.DeviceName', ?", "'$.DeviceNameUpdatedAt', ?"); pathParams.push(after.deviceName, stamp);
    if (o.source) { paths.push("'$.DeviceNameSource', ?"); pathParams.push(o.source); }
  }
  if (typeOut) { sets.push('device_type = ?'); params.push(after.deviceType || null); paths.push("'$.DeviceType', ?"); pathParams.push(after.deviceType); }
  if (paths.length) { sets.push("raw_json = JSON_SET(COALESCE(raw_json, '{}'), " + paths.join(', ') + ')'); params.push(...pathParams); }
  const r = await q('UPDATE subscriptions SET ' + sets.join(', ') + " WHERE sub_id = ? AND (raw_json IS NULL OR JSON_VALID(raw_json) = 1) LIMIT 1", params.concat([subId]));
  if (!r || !r.affectedRows) return { ok: false, status: 409, message: 'Not saved — the subscription changed. Refresh and try again.' };
  return { ok: true, before, after, changed, updatedAt: stamp };
}

/**
 * Multi-device plan (device_count ≥ 2, or setDevices raising it): the device's name + type go into raw_json DeviceNames
 * [{ device, name, type }]. DeviceName, DeviceType and the typed device_type always mirror DEVICE 1 (backward compatible).
 * A raised count writes the typed device_count and raw_json DeviceCount together. One UPDATE, JSON_ARRAY/JSON_OBJECT
 * (same result on MySQL and MariaDB), guarded by JSON_VALID.
 */
async function saveMultiDevice(q, a, o) {
  const { subId, cur, raw, count, curCount, device, hasName, name, hasType, type } = a;
  const list = deviceList(raw, count, cur.device_type);
  const slot = list[device - 1];
  const before = { device, deviceName: slot.name, deviceType: slot.type };
  const after = { device, deviceName: hasName ? name : slot.name, deviceType: hasType ? type : slot.type };
  const changed = [];
  if (after.deviceName !== before.deviceName) changed.push('deviceName');
  if (after.deviceType !== before.deviceType) changed.push('deviceType');
  if (count !== curCount) changed.push('devices');
  if (!changed.length) return { ok: true, before, after, changed, unchanged: true, device, devices: count, deviceNames: list };
  slot.name = after.deviceName; slot.type = after.deviceType;
  const first = list[0];
  const stamp = istStamp(o.now);
  const sets = [], params = [], paths = [], pathParams = [];
  const typeOut = (normDeviceType(cur.device_type) || '') !== first.type || s(raw.DeviceType) !== first.type;
  if (typeOut) { sets.push('device_type = ?'); params.push(first.type || null); }
  if (count !== curCount) { sets.push('device_count = ?'); params.push(count); }
  if (changed.includes('deviceName') || s(raw.DeviceName) !== first.name) {
    paths.push("'$.DeviceName', ?", "'$.DeviceNameUpdatedAt', ?"); pathParams.push(first.name, stamp);
    if (o.source) { paths.push("'$.DeviceNameSource', ?"); pathParams.push(o.source); }
  }
  if (typeOut) { paths.push("'$.DeviceType', ?"); pathParams.push(first.type); }
  if (count !== curCount) { paths.push("'$.DeviceCount', ?"); pathParams.push(count); }
  paths.push("'$.DeviceNames', JSON_ARRAY(" + list.map(() => "JSON_OBJECT('device', ?, 'name', ?, 'type', ?)").join(', ') + ')');
  for (const d of list) pathParams.push(d.device, d.name, d.type);
  sets.push("raw_json = JSON_SET(COALESCE(raw_json, '{}'), " + paths.join(', ') + ')'); params.push(...pathParams);
  const r = await q('UPDATE subscriptions SET ' + sets.join(', ') + " WHERE sub_id = ? AND (raw_json IS NULL OR JSON_VALID(raw_json) = 1) LIMIT 1", params.concat([subId]));
  if (!r || !r.affectedRows) return { ok: false, status: 409, message: 'Not saved — the subscription changed. Refresh and try again.' };
  return { ok: true, before, after, changed, updatedAt: stamp, device, devices: count, devicesBefore: curCount, deviceNames: list };
}

/* ================= old Sheet import (read-only) ================= */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
/** A sheet cell → 'YYYY-MM-DD' (India date) or ''. dd/mm/yyyy, dd-mm-yy, 14 Sep 2026, ISO (from the Apps Script dump). */
function sheetDate(v) {
  if (v instanceof Date) return isNaN(v) ? '' : istStamp(v.getTime()).slice(0, 10);
  const t = s(v);
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/);
  if (m) { const ms = new Date(t).getTime(); return isFinite(ms) ? istStamp(ms).slice(0, 10) : ''; }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)?$/i);
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,9})[\s\-,]+(\d{4})$/);
  const mon = m && (MONTHS[m[2].toLowerCase()] || MONTHS[m[2].toLowerCase().slice(0, 3)]);
  if (mon) return valid(+m[3], mon, +m[1]);
  return '';
}
function valid(y, mo, d) {
  if (!(y > 2000 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? y + '-' + pad(mo) + '-' + pad(d) : '';
}
const cellText = (v) => (v === true ? 'TRUE' : v === false ? 'FALSE' : v instanceof Date ? v.toISOString() : s(v));
const TICKS = new Set(['TRUE', 'FALSE', 'YES', 'NO', '✅', '✔', '✔️', '☑', '☑️', '✓', '❌', '☐', '✗', '✘', 'Y', 'N']);
const isStatusCell = (t) => t.length <= 30 && /^[^A-Za-z]*(ACTIVE|EXPIRED|EXPIRING|INACTIVE|REMOVED)\b[^A-Za-z]*$/i.test(t);
const isNumberCell = (t) => /^[#\s]*\d{1,4}[.)]?$/.test(t);
/** "📱 8076332049" / "8076332049" / "+91 80763 32049" (no letters) → '8076332049'. */
function phoneCell(t) {
  if (/[A-Za-z]/.test(t)) return '';
  const d = t.replace(/\D/g, '');
  return d.length === 10 || (d.length === 12 && d.startsWith('91')) ? d.slice(-10) : '';
}

/**
 * rows2d: the Sheet as rows of cells. Account header rows ("📱 8076332049") set the account for the rows below; a
 * service name on a row ("JioHotstar", "SONYLIV") sets the service. Customer rows have a date:
 *   name | device name | 📱 PHONE / 📺 TV | tick | expiry | ACTIVE ✅ / EXPIRED ⚠️   (any order of type/tick/status)
 * Returns { rows: [{ line, account, service, name, deviceName, deviceType, expiry, sheetStatus }], skipped: [{ line, reason }] }.
 */
function parseRows(rows2d, opts) {
  const o = opts || {};
  let account = '', service = o.service ? canonService(o.service) : '';
  const rows = [], skipped = [];
  (rows2d || []).forEach((cells0, i) => {
    const line = i + 1;
    const cells = (Array.isArray(cells0) ? cells0 : []).map(cellText);
    const filled = cells.filter(Boolean);
    if (!filled.length) return;
    let di = -1, expiry = '';
    for (let k = 0; k < cells.length; k++) { const d = sheetDate(cells[k]); if (d) { di = k; expiry = d; break; } }
    if (di < 0) {
      const ph = filled.map(phoneCell).find(Boolean);
      const svcCell = filled.find((t) => OTP_RE.test(t) && t.length <= 40);
      if (svcCell) service = canonService(svcCell);
      if (ph) account = ph;
      return; // header / title / column names
    }
    let name = '', deviceName = '', deviceType = '', sheetStatus = '';
    cells.forEach((t, k) => {
      if (k === di || !t) return;
      const dt = /^[\s📱📺]*[A-Za-z ]{0,14}$/u.test(t) ? normDeviceType(t) : null;
      if (dt) { if (!deviceType) deviceType = dt; return; }
      if (TICKS.has(up(t))) return;
      if (isStatusCell(t)) { sheetStatus = /ACTIVE/i.test(t) && !/INACTIVE/i.test(t) ? 'ACTIVE' : 'EXPIRED'; return; }
      if (phoneCell(t) || isNumberCell(t) || sheetDate(t)) return;
      if (!name) name = t; else if (!deviceName) deviceName = t;
    });
    if (!name) { skipped.push({ line, reason: 'no customer name' }); return; }
    const c = cleanDeviceName(deviceName);
    if (!c.ok) { skipped.push({ line, reason: 'device name longer than ' + MAX_DEVICE_NAME + ' characters', name }); return; }
    if (!c.value && !deviceType) { skipped.push({ line, reason: 'no device name', name }); return; }
    rows.push({ line, account, service, name, deviceName: c.value, deviceType, expiry, sheetStatus });
  });
  return { rows, skipped };
}
/** Text copied from Google Sheets (tab-separated; a single-column paste splits on 2+ spaces or " | "). */
function parsePaste(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  return lines.map((l) => (l.includes('\t') ? l.split('\t') : l.split(/\s*\|\s*|\s{2,}/)));
}
/** The Apps Script dump ({ headers?, rows: [{ header: value }] }) back to rows of cells, first Sheet row included. */
function dumpToRows(dump) {
  const d = dump || {};
  const list = Array.isArray(d.rows) ? d.rows : [];
  const headers = Array.isArray(d.headers) && d.headers.length ? d.headers.map((h) => s(h)) : Object.keys(list[0] || {});
  const keys = headers.map((h, c) => h || 'Col' + (c + 1));
  const first = headers.map((h) => (/^Col\d+$/.test(h) ? '' : h));
  return [first].concat(list.map((r) => keys.map((k) => (r && r[k] != null ? r[k] : ''))));
}

const normName = (v) => s(v).toLowerCase().normalize('NFKD').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function nameLevel(sheetName, custName) {
  const a = normName(sheetName), b = normName(custName);
  if (!a || !b) return 0;
  if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) return 2;
  const x = a.split(' '), y = b.split(' ');
  // Only one name typed: its first OR last name ("Adhate" ~ "Rohit Adhate"). Still only used when the match is unique.
  if ((x.length === 1 && y.length > 1 && y[y.length - 1] === x[0]) || (y.length === 1 && x.length > 1 && x[x.length - 1] === y[0])) return 1;
  if (x[0] !== y[0]) return 0;
  if (x.length === 1 || y.length === 1 || x[1][0] === y[1][0]) return 1; // "Ankit" ~ "Ankit Satija", "Ankit S" ~ "Ankit Satija"
  return 0;
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2027-02-17 …' → '17 Feb 2027'. */
function dayLabel(v) { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MON3[+m[2] - 1] + ' ' + m[1] : s(v); }
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

/**
 * Match parsed Sheet rows to OTP subscriptions: same service + login account (when the Sheet gave them), customer name
 * (exact beats first/last-name), expiry within ±1 IST day (same day beats ±1). Only a unique match counts.
 *
 * Multi-device plans: a PLAN is one subscription (same login on device_count N devices) or all rows of a separate-logins
 * group (group_id, devices in group_index order). K Sheet rows of the same customer + expiry that match one plan with at
 * least K devices are given Device 1..K in Sheet order (fewer rows than devices is fine). More rows than devices,
 * different customer names or different expiry dates → ambiguous with the reason.
 *
 * Ambiguous / not-found rows carry `options` — the subscriptions on that login, one entry per device slot — so the owner
 * can pick one in Preview. A plan with fewer devices than Sheet rows also gets "sets this plan to K devices" options.
 * subs: compute()-style subscriptions + customers; returns { matched, alreadyNamed, same, ambiguous, unmatched }.
 */
function matchRows(parsed, input) {
  const inp = input || {};
  const policyOf = {};
  for (const p of inp.plans || []) { const k = s(p.service).toLowerCase(); const pol = up(rawOf(p.raw_json).AllocationPolicy); if (k && pol && !policyOf[k]) policyOf[k] = pol; }
  const nameOfPhone = new Map();
  for (const c of inp.customers || []) if (s(c.phone_norm) && s(c.name)) nameOfPhone.set(s(c.phone_norm), s(c.name));
  const loginOfId = new Map();
  for (const a of inp.accounts || []) if (s(a.account_id) && !loginOfId.get(s(a.account_id))) loginOfId.set(s(a.account_id), s(a.login_id));
  const cands = (inp.subs || []).filter((x) => isOtpService(x.service, policyOf) && up(x.status) !== 'ERASED').map((x) => {
    const raw = rawOf(x.raw_json);
    const id = accountOfRef(x.inventory_ref) || s(x.account_id);
    const ms = toMs(x.expiry_date);
    const n = devCount(x.device_count);
    return {
      subId: s(x.sub_id), service: canonService(x.service), serviceName: s(x.service), plan: s(x.plan),
      login: digits10(x.login_id) || digits10(loginOfId.get(id)), accountId: id,
      names: [nameOfPhone.get(s(x.phone_norm)), s(raw.Name)].filter(Boolean),
      day: isFinite(ms) ? istDay(ms) : NaN, expiry: dateText(x.expiry_date),
      deviceCount: n, devices: deviceList(raw, n, x.device_type), typedType: s(x.device_type) ? (normDeviceType(x.device_type) || '') : '',
      groupId: s(x.group_id), groupIndex: Number(x.group_index) || 0, groupSize: Number(x.group_size) || 0, removed: isRemoved(x),
    };
  });
  const unitKey = (c) => (c.groupId ? 'G:' + c.service + '|' + c.groupId : 'S:' + c.subId);
  const unitSubs = new Map();
  for (const c of cands) { const k = unitKey(c); if (!unitSubs.has(k)) unitSubs.set(k, []); unitSubs.get(k).push(c); }
  for (const list of unitSubs.values()) list.sort((p, q) => (p.groupIndex - q.groupIndex) || p.subId.localeCompare(q.subId));
  const slotsOf = (k) => [].concat(...unitSubs.get(k).map((c) => Array.from({ length: c.deviceCount }, (_, i) => ({ c, device: i + 1 }))));
  const curNameOf = (c, d) => (c.devices[d - 1] ? c.devices[d - 1].name : '');
  const curTypeOf = (c, d) => (d === 1 ? c.typedType : c.devices[d - 1] ? c.devices[d - 1].type : '');
  const lvOf = (r, c) => Math.max(0, ...c.names.map((n) => nameLevel(r.name, n)));

  const results = (parsed || []).map((r) => {
    const day = dayOfYmd(r.expiry);
    const near = cands.filter((c) => (!r.service || c.service === r.service) && (!r.account || c.login === r.account) && isFinite(c.day) && Math.abs(c.day - day) <= 1);
    const exact = near.filter((c) => lvOf(r, c) === 2);
    let pool = exact.length ? exact : near.filter((c) => lvOf(r, c) === 1);
    let units = [...new Set(pool.map(unitKey))];
    if (units.length > 1) { const sameDay = pool.filter((c) => c.day === day); if (sameDay.length) { pool = sameDay; units = [...new Set(pool.map(unitKey))]; } }
    return { row: r, day, pool, unit: units.length === 1 ? units[0] : '', units };
  });

  // Sheet rows that all point at the same plan → its devices, in Sheet order.
  const byUnit = new Map();
  for (const res of results) if (res.unit) { if (!byUnit.has(res.unit)) byUnit.set(res.unit, []); byUnit.get(res.unit).push(res); }
  for (const [k, list] of byUnit) {
    const slots = slotsOf(k);
    let reason = '';
    if (list.some((x, i) => list.some((y, j) => j > i && nameLevel(x.row.name, y.row.name) === 0))) reason = 'different customer names on the Sheet match the same plan';
    else if (new Set(list.map((x) => x.row.expiry)).size > 1) reason = 'Sheet rows with different expiry dates match the same plan';
    else if (list.length > slots.length) { reason = list.length + ' Sheet rows for this plan, but it is for ' + plural(slots.length, 'device'); list.forEach((x) => { x.overflow = list.length; }); }
    if (!reason) {
      const used = new Set();
      for (const x of list) {
        const i = slots.findIndex((sl, idx) => !used.has(idx) && x.pool.includes(sl.c));
        if (i < 0) { reason = 'more Sheet rows than devices on this login'; break; }
        used.add(i); x.slot = slots[i];
      }
      if (reason) list.forEach((x) => { delete x.slot; });
    }
    if (reason) list.forEach((x) => { x.reason = reason; });
  }

  // Manual pick in Preview: one option per device slot of each candidate plan.
  const option = (c, d, n, setDevices) => {
    const now = d <= c.deviceCount ? curNameOf(c, d) : '';
    return {
      value: c.subId + '|' + d + (setDevices ? '|' + setDevices : ''), subId: c.subId, device: d, devices: n, setDevices: setDevices || undefined,
      label: (c.names[0] || '?') + ' · ' + dayLabel(c.expiry) + ' · ' + plural(n, 'device') + (n > 1 ? ' · Device ' + d + ' of ' + n : '') +
        (c.groupSize > 1 ? ' · separate login ' + c.groupIndex + ' of ' + c.groupSize : '') + (setDevices ? ' (sets this plan to ' + setDevices + ' devices)' : '') +
        (now ? ' · now "' + now + '"' : '') + (c.removed ? ' · removed' : ''),
    };
  };
  const optionsFor = (subsList, overflow) => {
    const out = [], seen = new Set();
    for (const c of subsList) {
      if (seen.has(c.subId)) continue; seen.add(c.subId);
      for (let d = 1; d <= c.deviceCount; d++) out.push(option(c, d, c.deviceCount));
      if (overflow > c.deviceCount && !c.groupId) for (let d = 1; d <= Math.min(overflow, MAX_DEVICES); d++) out.push(option(c, d, Math.min(overflow, MAX_DEVICES), Math.min(overflow, MAX_DEVICES)));
    }
    return out.slice(0, 80);
  };
  const onLogin = (r, day) => cands.filter((c) => (!r.service || c.service === r.service) && !c.removed && (r.account ? c.login === r.account : lvOf(r, c) >= 1))
    .sort((p, q) => ((isFinite(p.day) ? Math.abs(p.day - day) : 1e9) - (isFinite(q.day) ? Math.abs(q.day - day) : 1e9)) || p.subId.localeCompare(q.subId)).slice(0, 30);
  const candList = (subsList) => subsList.map((c) => ({ subId: c.subId, name: c.names[0] || '', expiry: c.expiry, devices: c.deviceCount }));

  const out = { matched: [], alreadyNamed: [], same: [], ambiguous: [], unmatched: [] };
  for (const res of results) {
    const row = res.row;
    const base = { line: row.line, sheetName: row.name, deviceName: row.deviceName, deviceType: row.deviceType, expiry: row.expiry, account: row.account, service: LABELS[row.service] || row.service };
    if (!res.slot) {
      const planSubs = [].concat(...res.units.map((k) => unitSubs.get(k)));
      const others = onLogin(row, res.day);
      if (!res.pool.length) { out.unmatched.push(Object.assign(base, { options: optionsFor(others, 0) })); continue; }
      out.ambiguous.push(Object.assign(base, {
        reason: res.reason || plural(planSubs.length, 'possible subscription'),
        candidates: candList(planSubs), options: optionsFor(planSubs.concat(others), res.overflow || 0),
      }));
      continue;
    }
    const { c, device: d } = res.slot;
    const item = Object.assign(base, {
      subId: c.subId, device: d, devices: c.deviceCount, name: c.names[0] || row.name, plan: c.plan, subService: c.serviceName, subExpiry: c.expiry,
      currentDeviceName: curNameOf(c, d), currentDeviceType: curTypeOf(c, d),
    }, c.groupSize > 1 ? { groupIndex: c.groupIndex, groupSize: c.groupSize } : {});
    classify(out, item);
  }
  return out;
}
/** matched (something to write) / alreadyNamed (a different name is there) / same (nothing to write). */
function classify(out, item) {
  const nameSame = !item.deviceName || item.currentDeviceName === item.deviceName;
  const typeSame = !item.deviceType || item.currentDeviceType === item.deviceType || !!item.currentDeviceType;
  if (item.currentDeviceName && item.deviceName && item.currentDeviceName !== item.deviceName) out.alreadyNamed.push(item);
  else if (nameSame && typeSame) out.same.push(item);
  else out.matched.push(item);
}

/**
 * Save the owner-confirmed rows. items: [{ subId, device?, setDevices?, deviceName, deviceType }] (device = 1..N of a
 * multi-device plan; setDevices only from a manual "sets this plan to K devices" pick). Existing device names and types
 * are kept unless overwrite is true. Writes DeviceName (+ DeviceNames for multi-device plans) + DeviceNameSource 'sheet' +
 * DeviceNameUpdatedAt, and device_type (typed + raw_json) only where it is empty or overwrite. Never touches status,
 * expiry or removed. Idempotent.
 */
async function saveImport(q, items, opts) {
  const o = opts || {};
  const overwrite = o.overwrite === true;
  const list = Array.isArray(items) ? items : [];
  const out = { saved: 0, names: 0, types: 0, devices: 0, unchanged: 0, skipped: 0, errors: [] };
  const seen = new Set();
  for (const it of list) {
    const subId = s(it && it.subId);
    const device = it && it.device != null && it.device !== '' ? Number(it.device) : 1;
    const setDevices = it && it.setDevices != null && it.setDevices !== '' ? Number(it.setDevices) : 0;
    const key = subId + '|' + device;
    if (!subId || seen.has(key)) { out.skipped++; continue; }
    seen.add(key);
    const c = cleanDeviceName(it.deviceName);
    const t = it.deviceType == null || it.deviceType === '' ? '' : normDeviceType(it.deviceType);
    if (!c.ok || t === null) { out.errors.push({ subId, device, message: c.ok ? 'Device type must be PHONE or TV.' : c.message }); continue; }
    const rows = await q('SELECT sub_id, service, device_type, device_count, raw_json FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]);
    const cur = Array.isArray(rows) && rows[0];
    if (!cur) { out.errors.push({ subId, device, message: 'not found' }); continue; }
    const raw = rawOf(cur.raw_json);
    const count = Math.max(devCount(cur.device_count), setDevices || 0);
    const slot = count > 1 ? (deviceList(raw, count, cur.device_type)[device - 1] || { name: '', type: '' }) : { name: s(raw.DeviceName), type: normDeviceType(cur.device_type) || '' };
    const typedEmpty = count > 1 && device > 1 ? !slot.type : !s(cur.device_type);
    const body = { subId };
    if (count > 1 || device !== 1) body.device = device;
    if (setDevices && setDevices > devCount(cur.device_count)) body.setDevices = setDevices;
    if (c.value && slot.name !== c.value && (overwrite || !slot.name)) body.deviceName = c.value;
    if (t && slot.type !== t && (overwrite || typedEmpty)) body.deviceType = t;
    if (body.deviceName === undefined && body.deviceType === undefined && body.setDevices === undefined) { out.unchanged++; continue; }
    const r = await saveDevice(q, body, { now: o.now, policyOf: o.policyOf, source: 'sheet' });
    if (!r.ok) { out.errors.push({ subId, device, message: r.message }); continue; }
    if (r.unchanged) { out.unchanged++; continue; }
    out.saved++;
    if (r.changed.includes('deviceName')) out.names++;
    if (r.changed.includes('deviceType')) out.types++;
    if (r.changed.includes('devices')) out.devices++;
  }
  return out;
}

/** Everything the matcher needs, read one table at a time (all OTP subscriptions, removed ones included). */
async function loadForImport(q) {
  const [plans, accounts] = await Promise.all([
    q('SELECT service, raw_json FROM plans', []).catch(() => []),
    q('SELECT service, account_id, login_id, is_active, plan FROM inventory_accounts', []).catch(() => []),
  ]);
  const otpPlanServices = (Array.isArray(plans) ? plans : []).filter((p) => up(rawOf(p.raw_json).AllocationPolicy) === 'OTP_ACCOUNT').map((p) => p.service);
  const subs = await loadSubs(q, otpPlanServices);
  const phones = [...new Set(subs.map((x) => s(x.phone_norm)).filter(Boolean))].slice(0, 2000);
  const customers = phones.length ? await q('SELECT phone_norm, name FROM customers WHERE phone_norm IN (' + phones.map(() => '?').join(', ') + ')', phones).catch(() => []) : [];
  return { plans, accounts, subs, customers };
}

/**
 * READ-ONLY Sheet reader: the Apps Script adminDumpTab action through api.php (API_PHP_URL + API_KEY), exactly the
 * request sync.js fetchDump makes for the final import. It has no write method; the Sheet is never written.
 * Returns { ok, rows2d } or { ok: false, message, help }.
 */
function sheetReader(env, fetchImpl) {
  const e = env || process.env;
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const HOW_TO_ALLOW = (tab) => 'In Apps Script open AdminDump.gs, add ' + tab + ': 1 to the ALLOW list, then Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy. The tab name must be in CAPITALS (the reader looks for "' + tab + '"). Or copy the rows from the Sheet and paste them below.';
  return {
    async readTab(tabName) {
      const tab = s(tabName).toUpperCase();
      if (!tab || tab.length > 80 || /[\u0000-\u001f]/.test(tab)) return { ok: false, message: 'Type the Sheet tab name.' };
      if (!s(e.API_KEY)) return { ok: false, message: 'The old Sheet reader is not set up on this server (API_KEY is empty).', help: 'Set API_KEY in Hostinger → Environment variables to the current Apps Script API key (it was changed at go-live), or paste the rows below.' };
      if (!f) return { ok: false, message: 'This server cannot make web requests.' };
      let text = '';
      try {
        const res = await f(s(e.API_PHP_URL) || 'https://go.fluxfilm.in/api.php', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': e.API_KEY },
          body: JSON.stringify({ apiKey: e.API_KEY, action: 'adminDumpTab', args: [tab] }),
        });
        text = await res.text();
      } catch (err) { return { ok: false, message: 'Could not reach the old Sheet reader: ' + String((err && err.message) || err), help: 'Paste the rows below instead.' }; }
      let j;
      try { j = JSON.parse(text); } catch (_) { return { ok: false, message: 'The old Sheet reader did not answer (the old site may be switched off).', help: 'Paste the rows below instead.' }; }
      const r1 = (j && j.result) || {};
      const msg = s((j && (j.message || j.error)) || r1.message || (r1.result && r1.result.message));
      if (/not allowed/i.test(msg)) return { ok: false, message: 'The Sheet reader does not allow the tab "' + tab + '" yet.', help: HOW_TO_ALLOW(tab) };
      if (/missing sheet/i.test(msg)) return { ok: false, message: 'No tab called "' + tab + '" in the Sheet.', help: 'The reader looks for the name in CAPITALS. Rename the tab (for example JIOHOTSTAR_DEVICES), add it to ALLOW in AdminDump.gs, or paste the rows below.' };
      if (/unknown action|adminDumpTab/i.test(msg) && !/error:/i.test(msg)) return { ok: false, message: 'The Sheet reader (adminDumpTab) is not deployed.', help: HOW_TO_ALLOW(tab) };
      if (/key|unauthori|forbidden/i.test(msg)) return { ok: false, message: 'The old Sheet refused the API key.', help: 'API_KEY in Hostinger must match the Apps Script key (it was changed at go-live). Or paste the rows below.' };
      const result = Array.isArray(r1.rows) ? r1 : r1.result && Array.isArray(r1.result.rows) ? r1.result : j && Array.isArray(j.rows) ? j : {};
      if (!Array.isArray(result.rows)) return { ok: false, message: msg || 'The Sheet reader gave no rows.', help: 'Paste the rows below instead.' };
      return { ok: true, tab, rows2d: dumpToRows(result) };
    },
  };
}

module.exports = {
  compute, load, saveDevice, cleanDeviceName, normDeviceType, isOtpService, canonService, statusOf, statusLabel, matchesQuery,
  parseRows, parsePaste, dumpToRows, sheetDate, nameLevel, matchRows, saveImport, loadForImport, sheetReader,
  istStamp, toMs, rawOf, MAX_DEVICE_NAME, SUB_COLS, GROUP_COLS, MAX_DEVICES, deviceList, deviceNamesText, dayLabel,
};
