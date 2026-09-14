/**
 * FluxFilm - admin 🧾 Plans editor (admin-only).
 *
 *   GET  /admin/api/plans          → { services: [{ service, plans: [...] }] } with orders, active subs, live stock
 *   POST /admin/api/plans/save     { original?: {service, plan}, ...plan }   create / update
 *   POST /admin/api/plans/copy     { service, plan, type?, devices?, months?, style?, name?, price?, durationDays? }
 *   POST /admin/api/plans/toggle   { service, plan, active }
 *   POST /admin/api/plans/delete   { service, plan }
 *
 * WHY: plans used to be edited in the generic Sheets grid, whose one-line inputs
 * flattened Benefits / PostPaymentMessage and made new plans a raw-key typing job.
 *
 * Rules this file keeps:
 *  - Typed columns AND raw_json are written together in ONE statement (order.js reads
 *    price/duration/is_active from columns; fulfill.js, catalog.js and coupons read raw_json).
 *    raw_json keys this editor does not know about are preserved.
 *  - The storefront (index.html planMeta_) and order.js read type / months / devices from
 *    the plan NAME, so the name builder only produces names both parse the same way.
 *  - Orders and subscriptions point at a plan by (service, plan) text. Renewals look the
 *    plan up by that text, so a plan that has orders or subscriptions can never be renamed
 *    or deleted here — turn it off and copy it instead.
 *  - Delete keeps a full copy of the row in app_settings (deleted_plan_…).
 */

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const isTrue = (v) => v === true || up(v) === 'TRUE' || v === 1 || s(v) === '1';
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return Object.assign({}, v); try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }

const FULFILLMENT_MODES = ['INSTANT', 'MANUAL'];
const ALLOCATION_POLICIES = ['CAPACITY', 'PROFILE', 'ACCOUNT', 'OTP_ACCOUNT', 'MANUAL', 'NONE'];
const TYPES = ['Private', 'Sharing', ''];
const PRIME_KEY = 'PRIME_DEVICE_TYPE';

// ---------------------------------------------------------------------------
// Plan names
// ---------------------------------------------------------------------------

/** Same reading as the storefront planMeta_ (index.html) — months from the name, 0 if none. */
function monthsFromName(name) {
  const lc = String(name || '').toLowerCase(); let m;
  if ((m = lc.match(/(\d+)\s*month/))) return +m[1];
  if ((m = lc.match(/(\d+)\s*year/))) return +m[1] * 12;
  if ((m = lc.match(/\b(\d+)\s*m\b/))) return +m[1];
  if ((m = lc.match(/\b(\d+)\s*y\b/))) return +m[1] * 12;
  return 0;
}
/** Same reading as order.js createOrder / stock.js devicesForPlan. */
function devicesFromName(name) { const m = String(name || '').match(/(\d+)\s*device/i); return Math.max(1, Number(m && m[1]) || 1); }
/** Same reading as index.html planMeta_ and fulfill.js allocateProfile. */
function typeFromName(name) { const lc = String(name || '').toLowerCase(); return /private/.test(lc) ? 'Private' : (/sharing|group/.test(lc) ? 'Sharing' : ''); }

/** Builder → name. { type: Private|Sharing|'', devices: 1-10, months: 1-60, style: 'short'|'long' } */
function buildPlanName(b) {
  const type = TYPES.includes(b.type) ? b.type : '';
  const devices = Math.floor(Number(b.devices) || 1);
  const months = Math.floor(Number(b.months) || 0);
  let dur;
  if (b.style === 'long') {
    if (months % 12 === 0) { const y = months / 12; dur = y + ' Year' + (y > 1 ? 's' : ''); } else dur = months + ' Month' + (months > 1 ? 's' : '');
  } else dur = months % 12 === 0 ? (months / 12) + 'Y' : months + 'M';
  return [type, devices > 1 ? devices + ' Devices' : '', dur].filter(Boolean).join(' ');
}

/** Name → builder, or null when the name is not one the builder would produce (free-text name). */
function parsePlanName(name) {
  const n = s(name);
  const m = n.match(/^(?:(Private|Sharing) )?(?:(\d+) Devices )?(\d+)(M|Y| Months?| Years?)$/);
  if (!m) return null;
  const unit = m[4].trim();
  const b = { type: m[1] || '', devices: Number(m[2] || 1), months: /^Y|^Year/.test(unit) ? Number(m[3]) * 12 : Number(m[3]), style: unit.length > 1 ? 'long' : 'short' };
  return buildPlanName(b) === n ? b : null;
}

/** Duration days to suggest for a number of months. */
function suggestDays(months) {
  const mo = Math.floor(Number(months) || 0);
  if (mo <= 0) return 0;
  return mo % 12 === 0 ? 365 * (mo / 12) : mo * 30;
}

// ---------------------------------------------------------------------------
// Validation: admin form → { raw fields, typed columns }
// ---------------------------------------------------------------------------

const clean = (v, max) => s(v).replace(/[<>]/g, '').slice(0, max);
const numOrNull = (v) => { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : NaN; };
const isHttps = (v) => /^https:\/\/[^\s"'<>]+$/i.test(v);
const isImageData = (v) => /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v);
/** Multi-line text: keep line breaks, normalise \r\n, strip < >. */
const multiline = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[<>]/g, '').replace(/\s+$/, '').slice(0, max);

/**
 * validatePlan(input) → { ok, errors, plan } where plan = the cleaned fields (raw_json keys).
 * The name comes from the builder ({ nameMode: 'builder', type, devices, months, style })
 * or from free text ({ nameMode: 'free', plan }).
 */
function validatePlan(b) {
  b = b || {};
  const errors = [];
  const service = clean(b.service, 80);
  if (!service) errors.push('Service is required.');

  let plan;
  if (b.nameMode === 'builder') {
    const devices = Number(b.devices == null || b.devices === '' ? 1 : b.devices);
    const months = Number(b.months);
    if (!TYPES.includes(b.type || '')) errors.push('Type must be Private, Sharing or none.');
    if (!Number.isInteger(devices) || devices < 1 || devices > 10) errors.push('Devices must be a whole number from 1 to 10.');
    if (!Number.isInteger(months) || months < 1 || months > 60) errors.push('Duration must be 1 to 60 months.');
    plan = errors.length ? '' : buildPlanName({ type: b.type || '', devices, months, style: b.style === 'long' ? 'long' : 'short' });
  } else {
    plan = clean(b.plan, 140).replace(/\s+/g, ' ');
    if (!plan) errors.push('Plan name is required.');
    else if (devicesFromName(plan) > 10) errors.push('Devices in the name must be 1 to 10.');
  }

  const price = numOrNull(b.price);
  if (price == null || isNaN(price) || price < 0) errors.push('Price must be a number of ₹0 or more.');
  const days = numOrNull(b.durationDays);
  if (days == null || !Number.isInteger(days) || days <= 0 || days > 3660) errors.push('Duration days must be a whole number above 0.');
  const nameMonths = plan ? monthsFromName(plan) : 0;
  if (plan && nameMonths && Number.isInteger(days) && days > 0 && Math.abs(days - suggestDays(nameMonths)) > Math.max(5, nameMonths * 3)) {
    errors.push('The name says ' + nameMonths + ' month' + (nameMonths > 1 ? 's' : '') + ' but duration days is ' + days + ' (expected about ' + suggestDays(nameMonths) + ').');
  }

  const mode = up(b.fulfillmentMode || 'INSTANT');
  if (!FULFILLMENT_MODES.includes(mode)) errors.push('Delivery must be INSTANT or MANUAL.');
  const policy = up(b.allocationPolicy || '');
  if (!ALLOCATION_POLICIES.includes(policy)) errors.push('Pick how accounts are handed out (allocation policy).');

  const d8 = numOrNull(b.earlyRenewDiscount); const d7 = numOrNull(b.earlyRenewDiscount7to2);
  for (const [label, v] of [['Early renew discount (8+ days)', d8], ['Early renew discount (2–7 days)', d7]]) {
    if (v != null && (isNaN(v) || v < 0)) errors.push(label + ' must be ₹0 or more.');
    else if (v != null && price != null && !isNaN(price) && v > price) errors.push(label + ' cannot be more than the price.');
  }

  const logoUrl = s(b.logoUrl);
  if (logoUrl && !isHttps(logoUrl) && !isImageData(logoUrl)) errors.push('Logo URL must start with https://');
  const requiresGroupJoin = isTrue(b.requiresGroupJoin);
  const groupJoinLink = s(b.groupJoinLink);
  if (groupJoinLink && !isHttps(groupJoinLink)) errors.push('Group join link must start with https://');
  const warn = numOrNull(b.groupSuspendWarningDays);
  if (warn != null && (!Number.isInteger(warn) || warn < 0 || warn > 365)) errors.push('Group warning days must be a whole number 0–365.');
  const stock = numOrNull(b.stock);
  if (stock != null && (!Number.isInteger(stock) || stock < 0)) errors.push('Stock must be empty or a whole number 0 or more.');
  const edp = numOrNull(b.extraDevicePrice);
  if (edp != null && (isNaN(edp) || edp < 0)) errors.push('Extra device price must be empty or ₹0 or more.');

  // Customer question: Prime TV question = PRIME_DEVICE_TYPE; other keys (e.g. YT_EMAIL) kept as typed.
  let extraFieldKey = up(b.extraFieldKey).replace(/[^A-Z0-9_]/g, '').slice(0, 40);
  if (b.primeTvQuestion === true) extraFieldKey = PRIME_KEY;
  else if (b.primeTvQuestion === false && extraFieldKey === PRIME_KEY) extraFieldKey = '';
  const needsExtraField = b.primeTvQuestion === true || (b.needsExtraField == null ? !!extraFieldKey : isTrue(b.needsExtraField));

  const plan_ = {
    Service: service,
    Plan: plan,
    DurationDays: Number.isInteger(days) ? days : 0,
    Price: price != null && !isNaN(price) ? Math.round(price * 100) / 100 : 0,
    IsActive: isTrue(b.isActive),
    FulfillmentMode: mode,
    AllocationPolicy: policy,
    NeedsExtraField: needsExtraField,
    ExtraFieldKey: extraFieldKey,
    ExtraFieldLabel: clean(b.extraFieldLabel, 300),
    DeviceRuleText: multiline(b.deviceRuleText, 600),
    EarlyRenewDiscount: d8 != null && !isNaN(d8) ? d8 : 0,
    EarlyRenewDiscount_7to2: d7 != null && !isNaN(d7) ? d7 : 0,
    RequiresGroupJoin: requiresGroupJoin,
    GroupJoinLink: groupJoinLink,
    GroupSuspendWarningDays: warn != null && !isNaN(warn) ? warn : '',
    Benefits: multiline(b.benefits, 2000),
    BadgeText: clean(b.badgeText, 40),
    LogoUrl: logoUrl,
    PostPaymentMessage: multiline(b.postPaymentMessage, 2000),
    Stock: stock != null && !isNaN(stock) ? stock : '',
    ExtraDevicePrice: edp != null && !isNaN(edp) ? edp : '',
  };
  return { ok: !errors.length, errors, plan: plan_ };
}

/** Typed columns for a raw plan (the sync.js mapping, cast the same way). */
function columnsFor(raw) {
  return {
    service: raw.Service, plan: raw.Plan, duration_days: Number(raw.DurationDays) || 0, price: Number(raw.Price) || 0,
    early_renew_discount: Number(raw.EarlyRenewDiscount) || 0, early_renew_discount_7to2: Number(raw.EarlyRenewDiscount_7to2) || 0,
    logo_url: s(raw.LogoUrl), is_active: isTrue(raw.IsActive) ? 'TRUE' : 'FALSE',
  };
}
const COLS = ['service', 'plan', 'duration_days', 'price', 'early_renew_discount', 'early_renew_discount_7to2', 'logo_url', 'is_active'];

/** DB row → the shape the admin editor uses. */
function shapeRow(r) {
  const raw = rawOf(r.raw_json);
  const service = s(r.service || raw.Service); const plan = s(r.plan || raw.Plan);
  const activeRaw = (r.is_active != null && r.is_active !== '') ? r.is_active : raw.IsActive;
  const builder = parsePlanName(plan);
  const txt = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n');
  return {
    service, plan,
    price: Number(r.price != null ? r.price : raw.Price) || 0,
    durationDays: Number(r.duration_days != null ? r.duration_days : raw.DurationDays) || 0,
    isActive: isTrue(activeRaw),
    type: typeFromName(plan), devices: devicesFromName(plan), months: monthsFromName(plan),
    nameMode: builder ? 'builder' : 'free', builder, style: builder ? builder.style : (/month|year/i.test(plan) ? 'long' : 'short'),
    fulfillmentMode: up(raw.FulfillmentMode), allocationPolicy: up(raw.AllocationPolicy),
    needsExtraField: isTrue(raw.NeedsExtraField), extraFieldKey: s(raw.ExtraFieldKey), extraFieldLabel: s(raw.ExtraFieldLabel),
    primeTvQuestion: up(raw.ExtraFieldKey) === PRIME_KEY,
    deviceRuleText: txt(raw.DeviceRuleText),
    earlyRenewDiscount: Number(r.early_renew_discount != null ? r.early_renew_discount : raw.EarlyRenewDiscount) || 0,
    earlyRenewDiscount7to2: Number(r.early_renew_discount_7to2 != null ? r.early_renew_discount_7to2 : raw.EarlyRenewDiscount_7to2) || 0,
    requiresGroupJoin: isTrue(raw.RequiresGroupJoin), groupJoinLink: s(raw.GroupJoinLink),
    groupSuspendWarningDays: raw.GroupSuspendWarningDays == null ? '' : raw.GroupSuspendWarningDays,
    benefits: txt(raw.Benefits), badgeText: s(raw.BadgeText), logoUrl: s(r.logo_url || raw.LogoUrl),
    postPaymentMessage: txt(raw.PostPaymentMessage),
    stock: raw.Stock == null ? '' : raw.Stock, extraDevicePrice: raw.ExtraDevicePrice == null ? '' : raw.ExtraDevicePrice,
  };
}

const keyOf = (service, plan) => s(service).toLowerCase() + '|||' + s(plan).toLowerCase();
function sortKey(p) { return [p.service.toLowerCase(), p.type, String(p.devices).padStart(2, '0'), String(p.months || 999).padStart(3, '0'), p.plan.toLowerCase()].join('~'); }

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const stock = deps.stock || require('./stock');
  const clearCaches = deps.clearCaches || (() => {
    try { require('./catalog').clearCache(); } catch (_) {}
    try { require('./reads').clearPlansCache(); } catch (_) {}
  });
  const now = deps.now || (() => Date.now());
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  async function loadPlan(service, plan) {
    const rows = await db.query('SELECT service, plan, duration_days, price, early_renew_discount, early_renew_discount_7to2, logo_url, is_active, raw_json FROM plans WHERE service = ? AND plan = ? LIMIT 1', [s(service), s(plan)]);
    return rows[0] || null;
  }
  /** Orders + subscriptions that point at this plan by name (same lookup renewals use). */
  async function usage(service, plan) {
    const [o, sub] = await Promise.all([
      db.query('SELECT COUNT(*) n FROM orders WHERE service = ? AND plan = ?', [s(service), s(plan)]),
      db.query("SELECT COUNT(*) n, SUM(CASE WHEN UPPER(status) = 'ACTIVE' AND expiry_date > NOW() THEN 1 ELSE 0 END) active FROM subscriptions WHERE service = ? AND plan = ?", [s(service), s(plan)]),
    ]);
    const orders = Number(o[0] && o[0].n) || 0; const subs = Number(sub[0] && sub[0].n) || 0;
    return { orders, subs, activeSubs: Number(sub[0] && sub[0].active) || 0, total: orders + subs };
  }
  const usedMsg = (u, what) => 'This plan has ' + u.orders + ' order' + (u.orders === 1 ? '' : 's') + ' and ' + u.subs + ' subscription' + (u.subs === 1 ? '' : 's') +
    ' linked to its name, so it cannot be ' + what + ' (renewals look the plan up by its name). Turn it off and use ⧉ Copy to make the new version instead.';

  async function writePlan(raw, original) {
    const cols = columnsFor(raw);
    const vals = COLS.map((c) => cols[c]);
    if (original) {
      return db.query('UPDATE plans SET ' + COLS.map((c) => '`' + c + '` = ?').join(', ') + ', raw_json = ? WHERE service = ? AND plan = ? LIMIT 1',
        [...vals, JSON.stringify(raw), original.service, original.plan]);
    }
    return db.query('INSERT INTO plans (' + COLS.map((c) => '`' + c + '`').join(', ') + ', raw_json) VALUES (' + COLS.map(() => '?').join(', ') + ', ?)', [...vals, JSON.stringify(raw)]);
  }
  const dupMsg = (raw) => 'A plan called "' + raw.Plan + '" already exists for ' + raw.Service + '.';

  app.get('/admin/api/plans', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [rows, subs, orders] = await Promise.all([
        db.query('SELECT service, plan, duration_days, price, early_renew_discount, early_renew_discount_7to2, logo_url, is_active, raw_json FROM plans', []),
        db.query("SELECT service, plan, COUNT(*) n, SUM(CASE WHEN UPPER(status) = 'ACTIVE' AND expiry_date > NOW() THEN 1 ELSE 0 END) active FROM subscriptions GROUP BY service, plan", []),
        db.query('SELECT service, plan, COUNT(*) n FROM orders GROUP BY service, plan', []),
      ]);
      const subMap = new Map(); for (const x of subs) { const k = keyOf(x.service, x.plan); const c = subMap.get(k) || { n: 0, active: 0 }; c.n += Number(x.n) || 0; c.active += Number(x.active) || 0; subMap.set(k, c); }
      const ordMap = new Map(); for (const x of orders) { const k = keyOf(x.service, x.plan); ordMap.set(k, (ordMap.get(k) || 0) + (Number(x.n) || 0)); }
      let levels = {}; let stockError = '';
      try { levels = await stock.computeStockLevels(rows); } catch (e) { stockError = String(e.message || e); }
      const byService = new Map();
      for (const r of rows) {
        const p = shapeRow(r);
        const k = keyOf(p.service, p.plan);
        const su = subMap.get(k) || { n: 0, active: 0 };
        p.orders = ordMap.get(k) || 0; p.subs = su.n; p.activeSubs = su.active;
        const lv = levels[p.service + '|||' + p.plan];
        p.stockLevel = lv ? lv.stockLevel : null; p.stockUnits = lv ? lv.stock : null; p.stockSource = lv ? lv.source : null;
        if (!byService.has(p.service)) byService.set(p.service, []);
        byService.get(p.service).push(p);
      }
      const services = [...byService.keys()].sort((a, b) => a.localeCompare(b)).map((sv) => ({ service: sv, plans: byService.get(sv).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)) }));
      res.json({ ok: true, services, count: rows.length, stockError, policies: ALLOCATION_POLICIES, modes: FULFILLMENT_MODES });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/plans/save', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const v = validatePlan(b);
      if (!v.ok) return res.status(400).json({ ok: false, message: v.errors[0], errors: v.errors });
      const orig = b.original && s(b.original.service) && s(b.original.plan) ? { service: s(b.original.service), plan: s(b.original.plan) } : null;
      let raw = v.plan;
      if (orig) {
        const cur = await loadPlan(orig.service, orig.plan);
        if (!cur) return res.status(404).json({ ok: false, message: 'That plan no longer exists — reload the page.' });
        const renamed = s(cur.service) !== raw.Service || s(cur.plan) !== raw.Plan;
        if (renamed) {
          const u = await usage(cur.service, cur.plan);
          if (u.total > 0) return res.status(409).json({ ok: false, renameBlocked: true, usage: u, message: usedMsg(u, 'renamed') });
          const clash = await loadPlan(raw.Service, raw.Plan);
          // Same row under a case-only change is fine; any other row with that name is a clash.
          if (clash && keyOf(clash.service, clash.plan) !== keyOf(cur.service, cur.plan)) return res.status(409).json({ ok: false, message: dupMsg(raw) });
        }
        raw = Object.assign(rawOf(cur.raw_json), raw); // unknown raw_json keys survive
        const r = await writePlan(raw, { service: s(cur.service), plan: s(cur.plan) });
        clearCaches();
        audit.record(req, { action: 'plan.update', entity: 'plan', id: raw.Service + ' / ' + raw.Plan, summary: 'Updated plan ' + raw.Service + ' ' + raw.Plan + (renamed ? ' (renamed from ' + cur.plan + ')' : '') + ' · ₹' + raw.Price + ' · ' + (raw.IsActive ? 'on' : 'off'), details: raw });
        return res.json({ ok: true, created: false, changed: (r && r.affectedRows) || 0, plan: shapeRow(Object.assign(columnsFor(raw), { raw_json: raw })) });
      }
      if (await loadPlan(raw.Service, raw.Plan)) return res.status(409).json({ ok: false, message: dupMsg(raw) });
      await writePlan(raw, null);
      clearCaches();
      audit.record(req, { action: 'plan.create', entity: 'plan', id: raw.Service + ' / ' + raw.Plan, summary: 'Created plan ' + raw.Service + ' ' + raw.Plan + ' · ₹' + raw.Price + ' · ' + (raw.IsActive ? 'on' : 'off'), details: raw });
      res.json({ ok: true, created: true, plan: shapeRow(Object.assign(columnsFor(raw), { raw_json: raw })) });
    } catch (e) {
      if (/Duplicate/i.test(String(e && e.message))) return res.status(409).json({ ok: false, message: 'A plan with that service and name already exists.' });
      fail(res, e);
    }
  });

  app.post('/admin/api/plans/copy', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const cur = await loadPlan(b.service, b.plan);
      if (!cur) return res.status(404).json({ ok: false, message: 'Plan not found.' });
      const src = shapeRow(cur);
      const input = Object.assign({}, src, { isActive: false, primeTvQuestion: undefined, needsExtraField: src.needsExtraField });
      const monthsChanged = b.months != null && b.months !== '' && Number(b.months) !== src.months;
      if (s(b.name)) { input.nameMode = 'free'; input.plan = b.name; } else {
        const base = src.builder || { type: src.type, devices: src.devices, months: src.months, style: /month|year/i.test(src.plan) ? 'long' : 'short' };
        input.nameMode = 'builder';
        input.type = b.type != null ? b.type : base.type;
        input.devices = b.devices != null && b.devices !== '' ? Number(b.devices) : base.devices;
        input.months = monthsChanged ? Number(b.months) : (base.months || Math.max(1, Math.round(src.durationDays / 30)));
        input.style = b.style || base.style;
      }
      if (b.price != null && b.price !== '') input.price = b.price;
      if (b.durationDays != null && b.durationDays !== '') input.durationDays = b.durationDays;
      else if (monthsChanged) input.durationDays = suggestDays(b.months);
      const v = validatePlan(input);
      if (!v.ok) return res.status(400).json({ ok: false, message: v.errors[0], errors: v.errors });
      const raw = Object.assign(rawOf(cur.raw_json), v.plan, { IsActive: false });
      if (keyOf(raw.Service, raw.Plan) === keyOf(cur.service, cur.plan) || await loadPlan(raw.Service, raw.Plan)) return res.status(409).json({ ok: false, message: dupMsg(raw) + ' Pick different devices, duration or name.' });
      await writePlan(raw, null);
      clearCaches();
      audit.record(req, { action: 'plan.copy', entity: 'plan', id: raw.Service + ' / ' + raw.Plan, summary: 'Copied ' + s(cur.service) + ' ' + s(cur.plan) + ' → ' + raw.Plan + ' · ₹' + raw.Price + ' (off)', details: raw });
      res.json({ ok: true, created: true, plan: shapeRow(Object.assign(columnsFor(raw), { raw_json: raw })) });
    } catch (e) {
      if (/Duplicate/i.test(String(e && e.message))) return res.status(409).json({ ok: false, message: 'A plan with that service and name already exists.' });
      fail(res, e);
    }
  });

  app.post('/admin/api/plans/toggle', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const cur = await loadPlan(b.service, b.plan);
      if (!cur) return res.status(404).json({ ok: false, message: 'Plan not found.' });
      const active = isTrue(b.active);
      const raw = Object.assign(rawOf(cur.raw_json), { IsActive: active });
      await db.query('UPDATE plans SET is_active = ?, raw_json = ? WHERE service = ? AND plan = ? LIMIT 1', [active ? 'TRUE' : 'FALSE', JSON.stringify(raw), s(cur.service), s(cur.plan)]);
      clearCaches();
      audit.record(req, { action: active ? 'plan.on' : 'plan.off', entity: 'plan', id: s(cur.service) + ' / ' + s(cur.plan), summary: (active ? 'Turned on ' : 'Turned off ') + s(cur.service) + ' ' + s(cur.plan) });
      res.json({ ok: true, active });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/plans/delete', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const cur = await loadPlan(b.service, b.plan);
      if (!cur) return res.status(404).json({ ok: false, message: 'Plan not found.' });
      const u = await usage(cur.service, cur.plan);
      if (u.total > 0) return res.status(409).json({ ok: false, deleteBlocked: true, usage: u, message: usedMsg(u, 'deleted').replace('Turn it off and use ⧉ Copy to make the new version instead.', 'Turn it off instead — customers will stop seeing it.') });
      const slug = (s(cur.service) + '_' + s(cur.plan)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 36);
      const backupKey = 'deleted_plan_' + slug + '_' + now();
      const copy = { service: s(cur.service), plan: s(cur.plan), duration_days: cur.duration_days, price: cur.price, early_renew_discount: cur.early_renew_discount, early_renew_discount_7to2: cur.early_renew_discount_7to2, is_active: cur.is_active, logo_url: cur.logo_url, raw_json: rawOf(cur.raw_json), deletedAt: new Date(now()).toISOString() };
      try {
        await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [backupKey, JSON.stringify(copy)]);
      } catch (e) {
        return res.status(500).json({ ok: false, message: 'Could not save a backup copy first, so nothing was deleted: ' + String(e.message || e) });
      }
      const r = await db.query('DELETE FROM plans WHERE service = ? AND plan = ? LIMIT 1', [s(cur.service), s(cur.plan)]);
      clearCaches();
      audit.record(req, { action: 'plan.delete', entity: 'plan', id: s(cur.service) + ' / ' + s(cur.plan), summary: 'Deleted plan ' + s(cur.service) + ' ' + s(cur.plan) + ' (backup in app_settings ' + backupKey + ')', details: { backupKey } });
      res.json({ ok: true, deleted: (r && r.affectedRows) || 0, backupKey });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, buildPlanName, parsePlanName, monthsFromName, devicesFromName, typeFromName, suggestDays, validatePlan, columnsFor, shapeRow, ALLOCATION_POLICIES, FULFILLMENT_MODES };
