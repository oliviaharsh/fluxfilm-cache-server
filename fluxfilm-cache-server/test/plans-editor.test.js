/* 🧾 Plans editor (adminplans.js, admin.html plansView, grid editor line breaks). Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

// ---------------------------------------------------------------------------
// In-memory MySQL for plans / orders / subscriptions / app_settings
// ---------------------------------------------------------------------------
const ci = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); // utf8mb4 default collation
let plans = []; let orders = []; let subs = []; let settings = {};
let writes = []; let failSettings = false;
const PLAN_COLS = ['service', 'plan', 'duration_days', 'price', 'early_renew_discount', 'early_renew_discount_7to2', 'logo_url', 'is_active', 'raw_json'];
const findPlan = (sv, pl) => plans.find((r) => ci(r.service, sv) && ci(r.plan, pl));
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    if (/^SELECT .* FROM plans WHERE service = \? AND plan = \? LIMIT 1$/.test(sql)) { const r = findPlan(p[0], p[1]); return r ? [Object.assign({}, r)] : []; }
    if (/^SELECT .* FROM plans$/.test(sql)) return plans.map((r) => Object.assign({}, r));
    if (/^SELECT service, plan, COUNT\(\*\) n, SUM\(.*\) active FROM subscriptions GROUP BY service, plan$/.test(sql)) {
      const m = {}; for (const x of subs) { const k = x.service + '|' + x.plan; m[k] = m[k] || { service: x.service, plan: x.plan, n: 0, active: 0 }; m[k].n++; if (x.status === 'ACTIVE') m[k].active++; } return Object.values(m);
    }
    if (/^SELECT service, plan, COUNT\(\*\) n FROM orders GROUP BY service, plan$/.test(sql)) {
      const m = {}; for (const x of orders) { const k = x.service + '|' + x.plan; m[k] = m[k] || { service: x.service, plan: x.plan, n: 0 }; m[k].n++; } return Object.values(m);
    }
    if (/^SELECT COUNT\(\*\) n FROM orders WHERE service = \? AND plan = \?$/.test(sql)) return [{ n: orders.filter((x) => ci(x.service, p[0]) && ci(x.plan, p[1])).length }];
    if (/^SELECT COUNT\(\*\) n, SUM\(.*\) active FROM subscriptions WHERE service = \? AND plan = \?$/.test(sql)) { const l = subs.filter((x) => ci(x.service, p[0]) && ci(x.plan, p[1])); return [{ n: l.length, active: l.filter((x) => x.status === 'ACTIVE').length }]; }
    let m;
    if ((m = sql.match(/^UPDATE plans SET (.*) WHERE service = \? AND plan = \? LIMIT 1$/))) {
      writes.push(sql);
      const cols = m[1].split(', ').map((x) => x.replace(/`/g, '').replace(' = ?', ''));
      const r = findPlan(p[cols.length], p[cols.length + 1]); if (!r) return { affectedRows: 0 };
      cols.forEach((c, i) => { r[c] = p[i]; });
      return { affectedRows: 1 };
    }
    if ((m = sql.match(/^INSERT INTO plans \((.*)\) VALUES/))) {
      writes.push(sql);
      const cols = m[1].split(', ').map((x) => x.replace(/`/g, ''));
      const row = {}; cols.forEach((c, i) => { row[c] = p[i]; });
      if (findPlan(row.service, row.plan)) throw new Error("Duplicate entry for key 'PRIMARY'");
      plans.push(row); return { affectedRows: 1 };
    }
    if (/^INSERT INTO app_settings/.test(sql)) { if (failSettings) throw new Error('Data too long'); writes.push(sql); settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM plans WHERE service = \? AND plan = \? LIMIT 1$/.test(sql)) { writes.push(sql); const r = findPlan(p[0], p[1]); plans = plans.filter((x) => x !== r); return { affectedRows: r ? 1 : 0 }; }
    if (/^SELECT title, platform, line FROM trending_items/.test(sql)) return [];
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

const P = require('../adminplans');
const catalog = require('../catalog');
const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const orderSrc = fs.readFileSync(path.join(root, 'order.js'), 'utf8');

const planMeta_ = new Function(indexHtml.slice(indexHtml.indexOf('function planMeta_(p) {'), indexHtml.indexOf('function PlanVariantPicker(')) + '; return planMeta_;')();
const plBuildName = new Function(adminHtml.slice(adminHtml.indexOf('function plBuildName(b) {'), adminHtml.indexOf('function plSuggestDays(')) + '; return plBuildName;')();
const orderDevRe = new RegExp(orderSrc.match(/const planDevices = \(String\(plan\)\.match\(\/(.+?)\/i\)/)[1], 'i');
const orderDevices = (name) => Math.max(1, Number((String(name).match(orderDevRe) || [])[1]) || 1);

(async () => {
  // ---- names: builder ↔ storefront planMeta_ ↔ order.js ----
  let mismatches = []; let n = 0;
  for (const type of ['', 'Private', 'Sharing']) for (let devices = 1; devices <= 10; devices++) for (const months of [1, 2, 3, 6, 9, 12, 18, 24, 36]) for (const style of ['short', 'long']) {
    const b = { type, devices, months, style }; const name = P.buildPlanName(b); n++;
    const meta = planMeta_({ plan: name, durationDays: 0 });
    const back = P.parsePlanName(name);
    if (plBuildName(b) !== name || meta.months !== months || meta.devices !== devices || meta.type !== type || orderDevices(name) !== devices ||
      P.monthsFromName(name) !== months || P.devicesFromName(name) !== devices || P.typeFromName(name) !== type ||
      !back || back.type !== type || back.devices !== devices || back.months !== months) mismatches.push(name);
  }
  ok('builder names (' + n + ') read the same in storefront planMeta_, order.js and the admin page', mismatches.length === 0, mismatches.slice(0, 5));
  ok('builder examples', P.buildPlanName({ type: 'Private', devices: 2, months: 1 }) === 'Private 2 Devices 1M' && P.buildPlanName({ type: '', devices: 1, months: 12 }) === '1Y' && P.buildPlanName({ type: 'Sharing', devices: 3, months: 3, style: 'long' }) === 'Sharing 3 Devices 3 Months' && P.buildPlanName({ devices: 1, months: 24, style: 'long' }) === '2 Years');
  const live = ['Private 1M', 'Private 1Y', 'Sharing 6M', '1 Month', '3 Months', '1 Year', '1Year', '2 Devices 1M', '2 Devices 1Y'];
  ok('real plan names: server months/devices match planMeta_', live.every((x) => P.monthsFromName(x) === planMeta_({ plan: x }).months && P.devicesFromName(x) === planMeta_({ plan: x }).devices));
  ok('real names round-trip into the builder (free text only when needed)', P.parsePlanName('1 Month').style === 'long' && P.parsePlanName('2 Devices 1M').devices === 2 && P.parsePlanName('1Year') === null && P.parsePlanName('Private 1 Devices 1M') === null);
  ok('suggested days', P.suggestDays(1) === 30 && P.suggestDays(3) === 90 && P.suggestDays(6) === 180 && P.suggestDays(12) === 365 && P.suggestDays(24) === 730);

  // ---- validation ----
  const base = { service: 'Netflix', nameMode: 'builder', type: 'Private', devices: 2, months: 1, price: 249, durationDays: 30, fulfillmentMode: 'INSTANT', allocationPolicy: 'PROFILE', isActive: true };
  let v = P.validatePlan(base);
  ok('valid builder plan', v.ok && v.plan.Plan === 'Private 2 Devices 1M' && v.plan.Price === 249 && v.plan.IsActive === true, v.errors);
  const bad = (o, re, name) => { const r = P.validatePlan(Object.assign({}, base, o)); ok(name, !r.ok && re.test(r.errors.join(' | ')), r.errors); };
  bad({ service: '' }, /Service is required/, 'service required');
  bad({ nameMode: 'free', plan: '' }, /Plan name is required/, 'plan name required');
  bad({ price: -1 }, /Price/, 'price ≥ 0');
  bad({ price: 'abc' }, /Price/, 'price must be a number');
  bad({ durationDays: 0 }, /Duration days/, 'duration days > 0');
  bad({ devices: 11 }, /1 to 10/, 'devices 1–10 (builder)');
  bad({ nameMode: 'free', plan: 'Private 12 Devices 1M' }, /1 to 10/, 'devices 1–10 (free name)');
  bad({ allocationPolicy: 'RANDOM' }, /allocation/, 'allocation policy enum');
  bad({ fulfillmentMode: 'LATER' }, /INSTANT or MANUAL/, 'fulfillment enum');
  bad({ logoUrl: 'http://x.com/a.png' }, /https/, 'logo must be https');
  bad({ groupJoinLink: 'javascript:alert(1)' }, /https/, 'group link must be https');
  bad({ months: 3, durationDays: 30 }, /says 3 months/, 'name months must match duration days');
  bad({ earlyRenewDiscount: 500 }, /more than the price/, 'renew discount ≤ price');
  ok('existing data: image logo still allowed', P.validatePlan(Object.assign({}, base, { logoUrl: 'data:image/png;base64,iVBORw0KGgo=' })).ok);
  v = P.validatePlan(Object.assign({}, base, { benefits: '📅1 Month\r\n🤫Private Profile\n\n😍4K  ', postPaymentMessage: 'Line 1\nLine <b>2</b>\n' }));
  ok('multi-line fields keep their line breaks (CRLF → LF, < > stripped)', v.plan.Benefits === '📅1 Month\n🤫Private Profile\n\n😍4K' && v.plan.PostPaymentMessage === 'Line 1\nLine b2/b', v.plan);
  v = P.validatePlan(Object.assign({}, base, { primeTvQuestion: true, needsExtraField: false }));
  ok('Prime TV question sets PRIME_DEVICE_TYPE and asks it', v.plan.ExtraFieldKey === 'PRIME_DEVICE_TYPE' && v.plan.NeedsExtraField === true);
  v = P.validatePlan(Object.assign({}, base, { primeTvQuestion: false, extraFieldKey: 'YT_EMAIL', needsExtraField: true }));
  ok('other checkout keys (YT_EMAIL) are kept', v.plan.ExtraFieldKey === 'YT_EMAIL' && v.plan.NeedsExtraField === true);

  // ---- admin API ----
  const seed = () => {
    plans = [
      { service: 'Netflix', plan: 'Private 1M', duration_days: 30, price: '169.00', early_renew_discount: '17.00', early_renew_discount_7to2: '10.00', logo_url: 'https://x/n.png', is_active: 'true',
        raw_json: JSON.stringify({ Service: 'Netflix', Plan: 'Private 1M', DurationDays: 30, Price: 169, IsActive: true, FulfillmentMode: 'INSTANT', AllocationPolicy: 'PROFILE', Benefits: '📅1 Month\n🤫Private Profile', PostPaymentMessage: 'Important📝\n🚨Watch 1 device', LogoUrl: 'https://x/n.png', SheetOnlyKey: 'keep me', EarlyRenewDiscount: 17, EarlyRenewDiscount_7to2: 10 }) },
      { service: 'Netflix', plan: 'Sharing 1M', duration_days: 30, price: '139.00', early_renew_discount: 0, early_renew_discount_7to2: 0, logo_url: '', is_active: 'true',
        raw_json: JSON.stringify({ Service: 'Netflix', Plan: 'Sharing 1M', DurationDays: 30, Price: 139, IsActive: true, FulfillmentMode: 'INSTANT', AllocationPolicy: 'PROFILE' }) },
      { service: 'Prime Video', plan: '1 Month', duration_days: 30, price: '39.00', early_renew_discount: 4, early_renew_discount_7to2: 2, logo_url: '', is_active: 'true',
        raw_json: JSON.stringify({ Service: 'Prime Video', Plan: '1 Month', DurationDays: 30, Price: 39, IsActive: true, FulfillmentMode: 'INSTANT', AllocationPolicy: 'CAPACITY', ExtraFieldKey: 'PRIME_DEVICE_TYPE', NeedsExtraField: true }) },
    ];
    orders = [{ service: 'Netflix', plan: 'Private 1M' }, { service: 'Netflix', plan: 'Private 1M' }];
    subs = [{ service: 'netflix', plan: 'private 1m', status: 'ACTIVE' }, { service: 'Netflix', plan: 'Private 1M', status: 'EXPIRED' }];
    settings = {}; writes = []; failSettings = false;
  };
  seed();
  const routes = {}; const audits = []; let authed = false; let cleared = 0;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  const stockMock = { computeStockLevels: async (rows) => { const o = {}; rows.forEach((r) => { o[r.service + '|||' + r.plan] = { stock: 4, stockLevel: 'OK', source: 'inventory' }; }); return o; } };
  P.mount(app, { db: mockDb, auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (q, a) => audits.push(a) }, stock: stockMock, clearCaches: () => { cleared++; }, now: () => 1789000000000 });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; Promise.resolve(routes[m + ' ' + p]({ body }, res)).catch((e) => resolve({ code: 'THREW', body: String(e) })); });
  const raw = (sv, pl) => JSON.parse(findPlan(sv, pl).raw_json);

  let x = await call('GET', '/admin/api/plans');
  ok('admin sign-in required (list)', x.code === 403);
  x = await call('POST', '/admin/api/plans/save', base);
  ok('admin sign-in required (save)', x.code === 403 && plans.length === 3);
  authed = true;

  x = await call('GET', '/admin/api/plans');
  const nf = x.body.services && x.body.services.find((g) => g.service === 'Netflix');
  const p1 = nf && nf.plans.find((p) => p.plan === 'Private 1M');
  ok('list grouped by service with raw fields, counts and stock', x.body.ok && x.body.services.length === 2 && nf.plans.length === 2 && p1.orders === 2 && p1.subs === 2 && p1.activeSubs === 1 && p1.stockUnits === 4 && p1.benefits === '📅1 Month\n🤫Private Profile' && p1.type === 'Private' && p1.months === 1 && p1.nameMode === 'builder' && p1.earlyRenewDiscount === 17, p1);
  const prime = x.body.services.find((g) => g.service === 'Prime Video').plans[0];
  ok('Prime row: long name style + TV question detected', prime.style === 'long' && prime.primeTvQuestion === true && prime.months === 1);

  // create: 2-device Netflix private
  writes = []; cleared = 0;
  x = await call('POST', '/admin/api/plans/save', Object.assign({}, base, { benefits: 'A\nB\nC', postPaymentMessage: 'Hi\n\nThanks', isActive: false, extraDevicePrice: '' }));
  const created = findPlan('Netflix', 'Private 2 Devices 1M');
  ok('create: one INSERT with typed columns + raw_json in sync', x.body.ok && x.body.created && writes.length === 1 && /raw_json/.test(writes[0]) && created && created.price === 249 && created.duration_days === 30 && created.is_active === 'FALSE' && JSON.parse(created.raw_json).Price === 249 && JSON.parse(created.raw_json).IsActive === false && JSON.parse(created.raw_json).Benefits === 'A\nB\nC', x.body);
  ok('create: caches cleared + change log', cleared === 1 && audits.some((a) => a.action === 'plan.create' && /Private 2 Devices 1M/.test(a.summary)));
  x = await call('POST', '/admin/api/plans/save', Object.assign({}, base));
  ok('create: duplicate name refused', x.code === 409 && /already exists/.test(x.body.message) && plans.length === 4);

  // update without rename: unknown raw keys kept, multi-line kept, columns follow raw
  writes = [];
  const edit = Object.assign({}, p1, { price: 179, benefits: '📅1 Month\n🤫Private Profile\n🔏Lock', logoUrl: 'https://x/new.png', original: { service: 'Netflix', plan: 'Private 1M' } });
  x = await call('POST', '/admin/api/plans/save', edit);
  let r1 = raw('Netflix', 'Private 1M');
  ok('update: one UPDATE writes columns and raw_json together', x.body.ok && writes.length === 1 && /`price` = \?.*raw_json = \?/.test(writes[0]) && findPlan('Netflix', 'Private 1M').price === 179 && r1.Price === 179 && findPlan('Netflix', 'Private 1M').logo_url === 'https://x/new.png' && r1.LogoUrl === 'https://x/new.png', writes);
  ok('update: unknown raw_json keys survive; line breaks kept', r1.SheetOnlyKey === 'keep me' && r1.Benefits === '📅1 Month\n🤫Private Profile\n🔏Lock' && r1.PostPaymentMessage === 'Important📝\n🚨Watch 1 device');

  // rename protection
  writes = [];
  x = await call('POST', '/admin/api/plans/save', Object.assign({}, edit, { type: 'Sharing' }));
  ok('rename blocked when orders/subscriptions use the name (row untouched)', x.code === 409 && x.body.renameBlocked && /Turn it off and use ⧉ Copy/.test(x.body.message) && writes.length === 0 && findPlan('Netflix', 'Private 1M') && findPlan('Netflix', 'Private 1M').price === 179, x.body);
  x = await call('POST', '/admin/api/plans/save', Object.assign({}, edit, { service: 'Netflix Premium' }));
  ok('service rename blocked too', x.code === 409 && x.body.renameBlocked);
  const orders0 = orders; orders = []; const subs0 = subs; subs = [{ service: 'Netflix', plan: 'Private 1M', status: 'EXPIRED' }];
  x = await call('POST', '/admin/api/plans/save', Object.assign({}, edit, { type: 'Sharing' }));
  ok('an expired subscription still blocks a rename (renewals)', x.code === 409);
  subs = [];
  x = await call('POST', '/admin/api/plans/save', Object.assign({}, edit, { nameMode: 'free', plan: 'Sharing 1M' }));
  ok('rename into an existing plan name refused', x.code === 409 && /already exists/.test(x.body.message));
  const shared = Object.assign({}, P.shapeRow(findPlan('Netflix', 'Sharing 1M')), { original: { service: 'Netflix', plan: 'Sharing 1M' }, devices: 2 });
  x = await call('POST', '/admin/api/plans/save', shared);
  ok('rename allowed when nothing uses the plan', x.body.ok && !findPlan('Netflix', 'Sharing 1M') && raw('Netflix', 'Sharing 2 Devices 1M').Plan === 'Sharing 2 Devices 1M' && findPlan('Netflix', 'Sharing 2 Devices 1M').plan === 'Sharing 2 Devices 1M', x.body);
  orders = orders0; subs = subs0;

  // copy
  writes = [];
  x = await call('POST', '/admin/api/plans/copy', { service: 'Netflix', plan: 'Private 1M', devices: 2, months: 3, price: 649 });
  const cp = findPlan('Netflix', 'Private 2 Devices 3M');
  ok('copy: new row, off, devices + duration + price, days suggested, content copied', x.body.ok && cp && cp.is_active === 'FALSE' && cp.price === 649 && cp.duration_days === 90 && JSON.parse(cp.raw_json).Benefits === r1.Benefits && JSON.parse(cp.raw_json).SheetOnlyKey === 'keep me' && writes.length === 1 && findPlan('Netflix', 'Private 1M').is_active !== 'FALSE', x.body);
  x = await call('POST', '/admin/api/plans/copy', { service: 'Prime Video', plan: '1 Month', devices: 2, price: 59 });
  ok('copy keeps the name style (1 Month → 2 Devices 1 Month) and Prime question', x.body.ok && findPlan('Prime Video', '2 Devices 1 Month') && raw('Prime Video', '2 Devices 1 Month').ExtraFieldKey === 'PRIME_DEVICE_TYPE', x.body);
  x = await call('POST', '/admin/api/plans/copy', { service: 'Netflix', plan: 'Private 1M' });
  ok('copy to the same name refused', x.code === 409);

  // toggle
  writes = [];
  x = await call('POST', '/admin/api/plans/toggle', { service: 'Netflix', plan: 'Private 2 Devices 3M', active: true });
  ok('toggle on: is_active column and raw IsActive together', x.body.ok && writes.length === 1 && findPlan('Netflix', 'Private 2 Devices 3M').is_active === 'TRUE' && raw('Netflix', 'Private 2 Devices 3M').IsActive === true && raw('Netflix', 'Private 2 Devices 3M').SheetOnlyKey === 'keep me');

  // storefront catalog reads what the editor wrote
  const boot = await catalog.getBootstrap();
  const bp = boot.plans.find((p) => p.plan === 'Private 2 Devices 3M');
  ok('storefront getBootstrap shows the new plan with its price and benefits list', bp && bp.price === 649 && bp.durationDays === 90 && bp.benefits.join('|') === '📅1 Month|🤫Private Profile|🔏Lock' && !boot.plans.some((p) => p.plan === 'Private 2 Devices 1M'));

  // delete
  x = await call('POST', '/admin/api/plans/delete', { service: 'Netflix', plan: 'Private 1M' });
  ok('delete refused while orders/subscriptions use the plan', x.code === 409 && x.body.deleteBlocked && /Turn it off instead/.test(x.body.message) && findPlan('Netflix', 'Private 1M'));
  failSettings = true;
  x = await call('POST', '/admin/api/plans/delete', { service: 'Netflix', plan: 'Private 2 Devices 1M' });
  ok('no backup → nothing deleted', x.code === 500 && findPlan('Netflix', 'Private 2 Devices 1M'));
  failSettings = false;
  x = await call('POST', '/admin/api/plans/delete', { service: 'Netflix', plan: 'Private 2 Devices 1M' });
  const bk = x.body.backupKey && settings[x.body.backupKey] && JSON.parse(settings[x.body.backupKey]);
  ok('delete: backup copy saved in app_settings first (key ≤ 64 chars), then removed', x.body.ok && !findPlan('Netflix', 'Private 2 Devices 1M') && /^deleted_plan_netflix_private_2_devices_1m_1789000000000$/.test(x.body.backupKey) && x.body.backupKey.length <= 64 && bk.raw_json.Benefits === 'A\nB\nC' && bk.price === 249, x.body);
  ok('every change logged', ['plan.create', 'plan.update', 'plan.copy', 'plan.on', 'plan.delete'].every((a) => audits.some((l) => l.action === a)));

  // ---- admin page ----
  ok('admin: 🧾 Plans menu + route', /\['plans', '🧾', 'Plans'\]/.test(adminHtml) && /plans: plansView/.test(adminHtml) && /function plansView\(\)/.test(adminHtml));
  ok('admin: Benefits and after-payment message are textareas; save/copy/toggle/delete wired', /area\('benefits'/.test(adminHtml) && /area\('postPaymentMessage'/.test(adminHtml) && /<textarea class="inp" data-k="' \+ k/.test(adminHtml) && ['/admin/api/plans/save', '/admin/api/plans/copy', '/admin/api/plans/toggle', '/admin/api/plans/delete'].every((u) => adminHtml.includes("'" + u + "'")));
  ok('admin.js mounts adminplans', /require\('\.\/adminplans'\)\.mount\(app/.test(fs.readFileSync(path.join(root, 'admin.js'), 'utf8')));

  // ---- generic grid editor keeps line breaks ----
  const gridSrc = adminHtml.slice(adminHtml.indexOf('var MULTILINE_KEYS'), adminHtml.indexOf('function delRow() {'));
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  let posted = null; let modalHtml = '';
  // Tiny DOM: parse the modal's fields back out of the HTML the editor rendered.
  const decode = (v) => v.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const fields = () => {
    const out = [];
    for (const m of modalHtml.matchAll(/<input class="inp" data-h="([^"]*)" value="([^"]*)"[^>]*>/g)) out.push({ at: m.index, tag: 'input', getAttribute: () => decode(m[1]), value: decode(m[2]).replace(/[\r\n]/g, '') }); // a real <input> drops line breaks
    for (const m of modalHtml.matchAll(/<textarea class="inp" rows="\d+" data-h="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) out.push({ at: m.index, tag: 'textarea', getAttribute: () => decode(m[1]), value: decode(m[2]) });
    return out.sort((a, b) => a.at - b.at);
  };
  const $$ = (sel) => { if (sel === '#modal [data-h]') return fields(); if (sel === '#modal input[data-h]') return fields().filter((f) => f.tag === 'input'); throw new Error('selector ' + sel); };
  const $ = () => ({ textContent: '' });
  const S = { data: { table: 'plans', keys: ['Service', 'Plan'], mysqlKeys: ['service', 'plan'], rows: [{ service: 'Netflix', plan: 'Private 1M', __raw: { Service: 'Netflix', Plan: 'Private 1M', Price: 169, Benefits: '📅1 Month\n🤫Private', PostPaymentMessage: 'One line', DeviceRuleText: 'up to 2\nwatch 1' } }] } };
  const grid = new Function('S', '$', '$$', 'esc', 'post', 'modal', 'closeModal', 'loadTable', 'setTimeout', gridSrc + '; return { editRow, saveRow, gridField };')(
    S, $, $$, esc, (u, b) => { posted = { u, b }; return { then: (f) => f({ ok: true }) }; }, (t, body) => { modalHtml = body; }, () => {}, () => {}, () => {});
  grid.editRow(0);
  ok('grid editor: textarea for Benefits, PostPaymentMessage and any value with a line break; input otherwise', /<textarea[^>]*data-h="Benefits"/.test(modalHtml) && /<textarea[^>]*data-h="PostPaymentMessage"/.test(modalHtml) && /<textarea[^>]*data-h="DeviceRuleText"/.test(modalHtml) && /<input class="inp" data-h="Price" value="169"/.test(modalHtml) && /<input class="inp" data-h="Service" value="Netflix" readonly/.test(modalHtml), modalHtml);
  grid.saveRow();
  ok('grid editor: saveRow keeps \\n in multi-line fields', posted && posted.u === '/admin/api/row' && posted.b.raw.Benefits === '📅1 Month\n🤫Private' && posted.b.raw.DeviceRuleText === 'up to 2\nwatch 1' && posted.b.raw.Price === '169' && posted.b.keyvals.plan === 'Private 1M', posted);

  // 🗂️ 59 plans across 9 services used to render as one 5,700 px scroll (owner, 23 Sep 2026: "add categories
  // because have to scroll down to get to so many plans"). Services fold, and inside one the plans sit under
  // their own category. Nothing here changes the API — it is all in the page.
  console.log('\n=== plans list: folding, categories, search ===');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
    const lift = (name) => { const i = html.indexOf('function ' + name + '('); let j = html.indexOf('{', i), d = 0; for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); } } return ''; };
    const F2 = new Function(lift('plCategory') + '\n' + lift('plMatches') + '\nreturn { plCategory, plMatches };')();
    ok('a plan\'s category is what it is and for how many devices', F2.plCategory({ type: 'Sharing', devices: 2 }) === 'Sharing · 2 devices' && F2.plCategory({ type: 'Private', devices: 1 }) === 'Private · 1 device');
    ok('a service with no Private/Sharing split still groups by devices', F2.plCategory({ type: '', devices: 1 }) === '1 device' && F2.plCategory({ type: '', devices: 2 }) === '2 devices');
    ok('search looks at the name, the type and the badge', F2.plMatches({ plan: 'Sharing 1M', type: 'Sharing', badgeText: '' }, 'sharing') && F2.plMatches({ plan: 'Private 1Y', type: 'Private', badgeText: 'Most Popular' }, 'popular') && !F2.plMatches({ plan: 'Sharing 1M', type: 'Sharing' }, 'zee'));
    ok('an empty search matches everything', F2.plMatches({ plan: 'x' }, ''));

    ok('services are folded shut unless opened, and the open ones are remembered', /\.pl-svc:not\(\.open\) \.pl-item/.test(html) && /localStorage\.setItem\('ff_pl_open'/.test(html) && /function plOpen\(\)/.test(html));
    ok('a category heading is only drawn when a service has more than one', /if \(cats\.length > 1\) rows \+= '<div class="pl-cat">'/.test(html));
    ok('there is a search box and a chip per service, plus Fold all', /id="plq"/.test(html) && /class="pl-jump"/.test(html) && /data-all="1"/.test(html) && /Fold all/.test(html));
    ok('searching opens what it finds', /var isOpen = q \? true : open\.indexOf\(g\.service\) > -1;/.test(html));
    // ➕ Add plan sits inside the header that folds the service — the button has to win.
    ok('the buttons are handled before the fold, so ➕ Add plan still adds', html.indexOf("var b = ev.target.closest('[data-ed],[data-tog],[data-add]');") < html.indexOf("var fold = ev.target.closest('[data-fold]');"));
  }

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
