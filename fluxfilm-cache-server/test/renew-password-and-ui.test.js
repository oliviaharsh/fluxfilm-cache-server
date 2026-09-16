/* 🔑 A renewed customer must never be given the OLD password (owner report 16 Sep 2026)
 * + the three storefront annoyances fixed with it:
 *     My plans opens on Active · the picker sheet scrolls itself · Recover forgets the typed email.
 * Run: npm test  (no database needed — a small in-memory fake answers the SQL).
 */
process.env.TZ = 'Asia/Kolkata';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- fake database
let S = null;
const clone = (x) => JSON.parse(JSON.stringify(x));
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const likes = (svc, needle) => String(svc || '').toLowerCase().includes(needle);

function conditions(sql, params) {
  const re = /(account_id = \?|sub_id = \?|order_id = \?|group_id = \?|LOWER\(service\) LIKE \?|LOWER\(service\) LIKE '%([^%]+)%')/g;
  const out = {}; let i = 0; let m;
  const where = sql.slice(sql.search(/ WHERE /) + 1);
  while ((m = re.exec(where))) {
    if (m[2]) { out.like = m[2]; continue; }
    const key = m[1].split(' ')[0].replace('LOWER(service)', 'like');
    const v = params[i++];
    if (key === 'like') out.like = String(v).replace(/%/g, '').toLowerCase(); else out[key] = v;
  }
  return out;
}

function run(sqlRaw, params) {
  const sql = norm(sqlRaw);
  params = params || [];
  S.sql.push(sql);
  if (/GET_LOCK|RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
  if (/information_schema\.columns/.test(sql)) return [{ n: 2 }];
  const c = conditions(sql, params);
  const activeOnly = /UPPER\(is_active\)='TRUE'/.test(sql);

  if (/FROM plans/.test(sql)) return S.plans.filter((p) => p.service === params[0] && p.plan === params[1]).map(clone);
  if (/FROM inventory_accounts/.test(sql)) {
    return S.accounts.filter((a) => (c.account_id == null || a.account_id === c.account_id) && (!c.like || likes(a.service, c.like)) && (!activeOnly || String(a.is_active).toUpperCase() === 'TRUE')).map(clone);
  }
  if (/FROM inventory_capacity/.test(sql)) return S.caps.filter((x) => (c.account_id == null || x.account_id === c.account_id) && (!c.like || likes(x.service, c.like))).map(clone);
  if (/FROM inventory_profiles/.test(sql)) return [];
  if (/FROM subscriptions WHERE sub_id = \?/.test(sql)) return S.subs.filter((x) => x.sub_id === c.sub_id).map((x) => ({ ...clone(x), occupying: x.occupying ? 1 : 0 }));
  if (/FROM subscriptions WHERE order_id = \?/.test(sql)) return S.subs.filter((x) => x.order_id === c.order_id).map(clone);
  if (/FROM subscriptions/.test(sql) && /GROUP BY inventory_ref/.test(sql)) {
    const m = new Map();
    for (const x of S.subs) {
      if (!x.occupying || !likes(x.service, c.like)) continue;
      const cur = m.get(x.inventory_ref) || { inventory_ref: x.inventory_ref, total: 0, tv: 0 };
      cur.total += x.device_count || 1;
      cur.tv += x.tv_count != null ? x.tv_count : 0;
      m.set(x.inventory_ref, cur);
    }
    return [...m.values()];
  }
  if (/^SELECT fulfillment_status FROM orders/.test(sql)) return S.orders.filter((o) => o.order_id === c.order_id).map((o) => ({ fulfillment_status: o.fulfillment_status }));
  if (/FROM orders WHERE order_id = \?/.test(sql)) return S.orders.filter((o) => o.order_id === c.order_id).map(clone);
  if (/FROM customers/.test(sql)) return [{ name: 'Sai' }];
  // accesspassword.js repair — typed columns AND raw_json in one statement.
  if (/^UPDATE subscriptions SET password = \?, login_id = \?/.test(sql)) {
    const x = S.subs.find((r) => r.sub_id === params[4]);
    if (x) { x.password = params[0]; x.login_id = params[1]; x.raw_json = JSON.stringify(Object.assign(JSON.parse(x.raw_json || '{}'), { Password: params[2], LoginId: params[3] })); }
    S.writes.push('access-repair');
    return { affectedRows: x ? 1 : 0 };
  }
  if (/^UPDATE subscriptions SET login_id/.test(sql)) {
    const x = S.subs.find((r) => r.sub_id === params[params.length - 1]);
    Object.assign(x, { login_id: params[0], password: params[1], profile_name: params[2], profile_pin: params[3] });
    if (/JSON_SET/.test(sql)) x.raw_json = JSON.stringify(Object.assign(JSON.parse(x.raw_json || '{}'), { LoginId: params[4], Password: params[5], ProfileName: params[6], ProfilePIN: params[7] }));
    S.writes.push('renew-refresh');
    return { affectedRows: 1 };
  }
  if (/^UPDATE subscriptions SET inventory_ref/.test(sql)) {
    const x = S.subs.find((r) => r.sub_id === params[params.length - 1]);
    Object.assign(x, { inventory_ref: params[0], account_id: params[1], login_id: params[2], password: params[3] });
    S.writes.push('move');
    return { affectedRows: 1 };
  }
  if (/^UPDATE subscriptions SET expiry_date/.test(sql)) {
    const x = S.subs.find((r) => r.sub_id === params[4]);
    Object.assign(x, { expiry_date: params[0], order_id: params[2], status: 'ACTIVE', occupying: true, removed: 0, removed_at: null });
    S.writes.push('extend');
    return { affectedRows: 1 };
  }
  if (/^UPDATE orders SET fulfillment_status = 'FULFILLED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FULFILLED'; return { affectedRows: 1 }; }
  if (/^UPDATE orders SET fulfillment_status = 'FAILED'/.test(sql)) { S.orders.find((o) => o.order_id === params[0]).fulfillment_status = 'FAILED'; return { affectedRows: 1 }; }
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 140));
}

const pool = {
  query: async (sql, p) => [run(sql, p)],
  getConnection: async () => ({ query: async (sql, p) => [run(sql, p)], release() {} }),
};
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => pool, ping: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './coins') return { awardCoins: async () => ({ ok: true }) };
  if (req === './mailer') return { sendAccessEmail: async (p) => { S.mails.push(p); return { ok: true }; } };
  if (req === './pushreminders') return { notifyDelivered: async () => ({ ok: true }) };
  return origLoad.apply(this, arguments);
};
const accessPassword = require('../accesspassword');
const fulfill = require('../fulfill');

// Sai: a Prime plan that ended before the owner changed the account password.
function base() {
  const past = (n) => { const d = new Date(Date.now() - n * 86400000); const p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':00'; };
  return {
    writes: [], mails: [], sql: [],
    plans: [{ service: 'Prime Video', plan: '1 Month', duration_days: 30, price: 39, is_active: 'TRUE', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY' }) }],
    accounts: [{ service: 'Prime', account_id: 'PRI-TRIG', login_id: 'triggerman@x.com', password: 'NEW-pass-2026', is_active: 'TRUE' }],
    caps: [{ service: 'Prime', account_id: 'PRI-TRIG', max_total: 4, max_tv: 2, is_active: 'TRUE' }],
    subs: [{
      sub_id: 'SUB-SAI', order_id: 'FF-OLD', phone: '9876500000', phone_norm: '9876500000', email: 'sai@x.com',
      service: 'Prime Video', plan: '1 Month', inventory_ref: 'PRI-TRIG', account_id: 'PRI-TRIG',
      login_id: 'triggerman@x.com', password: 'old-pass-2025', profile_name: '', profile_pin: '', profile_number: '',
      device_type: 'NON_TV', device_count: 1, tv_count: 0, status: 'ACTIVE', occupying: false,
      expiry_date: past(9), start_date: past(39), removed: 1, removed_at: past(5), source: 'node',
      raw_json: JSON.stringify({ SubID: 'SUB-SAI', LoginId: 'triggerman@x.com', Password: 'old-pass-2025' }),
    }],
    orders: [{
      order_id: 'FF-R9', service: 'Prime Video', plan: '1 Month', name: 'Sai', email: 'sai@x.com',
      phone: '9876500000', phone_norm: '9876500000', duration_days: 30, status: 'PAID', fulfillment_status: 'PENDING',
      extra_field_value: '', device_count: 1, tv_count: 0, source: 'node', final_amount: 39, order_type: 'RENEW', renew_sub_id: 'SUB-SAI',
    }],
  };
}
const sai = () => S.subs.find((x) => x.sub_id === 'SUB-SAI');
const rawOf = (x) => JSON.parse(x.raw_json || '{}');

(async () => {
  section('the shared helper (accesspassword.js)');
  S = base();
  let r = await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('a stale row is repaired from the account', r.repaired === 1 && r.missing === 0 && sai().password === 'NEW-pass-2026', { r, pass: sai().password });
  ok('raw_json is kept in step, not just the typed column (CLAUDE.md)', rawOf(sai()).Password === 'NEW-pass-2026' && rawOf(sai()).LoginId === 'triggerman@x.com', rawOf(sai()));
  ok('the row object the caller holds is updated too', S.subs[0].password === 'NEW-pass-2026');

  S.writes = [];
  r = await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('already current -> nothing written', r.repaired === 0 && !S.writes.length, { r, writes: S.writes });

  S = base();
  S.accounts = [];
  r = await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('account row gone -> the stored login is kept exactly as it was, counted as missing', r.missing === 1 && r.repaired === 0 && sai().password === 'old-pass-2025' && !S.writes.length, { r, pass: sai().password });

  S = base();
  S.accounts[0].password = '';
  r = await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('account with no password saved -> never blanks the customer out', r.missing === 1 && sai().password === 'old-pass-2025');

  S = base();
  S.subs.push(Object.assign({}, S.subs[0], { sub_id: 'SUB-SAI2', raw_json: null }));
  await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('two rows on one account = ONE account lookup (not one per row)', S.sql.filter((q) => /FROM inventory_accounts/.test(q)).length === 1, S.sql.filter((q) => /FROM inventory_accounts/.test(q)));
  ok('the account is read with its own statement — never a JOIN with subscriptions',
    S.sql.filter((q) => /FROM inventory_accounts/.test(q)).every((q) => !/JOIN/i.test(q) && !/subscriptions/i.test(q)));

  S = base();
  S.subs[0].inventory_ref = 'PRI-TRIG#P2';
  await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('a Netflix-style profile ref (ACC#P2) still finds its account', sai().password === 'NEW-pass-2026');

  S = base();
  S.subs[0].service = 'Netflix';
  await accessPassword.refreshAccess(mockDb.query, S.subs);
  ok('a different service family never borrows another service\'s password', sai().password === 'old-pass-2025');

  section('renewing an ended plan after a password change');
  S = base();
  let f = await fulfill.fulfillForAdmin('FF-R9');
  ok('the renewal shows the NEW password, not the one stored on the ended row', f.fulfillment === 'FULFILLED' && f.access.pass === 'NEW-pass-2026', f.access);
  ok('the subscription row is corrected — typed column and raw_json', sai().password === 'NEW-pass-2026' && rawOf(sai()).Password === 'NEW-pass-2026', { typed: sai().password, raw: rawOf(sai()) });
  ok('the login stays the same and the plan really is extended', sai().login_id === 'triggerman@x.com' && S.writes.includes('extend') && !S.writes.includes('move'), S.writes);
  ok('the credentials email carries the new password', S.mails.length === 1 && S.mails[0].access.pass === 'NEW-pass-2026' && S.mails[0].event === 'RENEW', S.mails[0] && S.mails[0].access);
  ok('nothing anywhere still shows the old password', !JSON.stringify({ f, sub: sai(), mails: S.mails }).includes('old-pass-2025'));

  // The owner changes it AGAIN while the renewal is already fulfilled: the card repairs itself.
  S.accounts[0].password = 'NEWER-pass';
  S.writes = [];
  f = await fulfill.fulfillForAdmin('FF-R9');
  ok('"show me my login again" repairs a row that went stale later', f.fulfillment === 'FULFILLED' && f.access.pass === 'NEWER-pass' && sai().password === 'NEWER-pass' && S.writes.includes('access-repair'), { access: f.access, writes: S.writes });

  S = base();
  S.accounts = [];
  f = await fulfill.fulfillForAdmin('FF-R9');
  ok('account missing at renewal: behaviour unchanged (moved or blocked), never a crash', f.ok === true && ['NO_STOCK', 'FULFILLED'].includes(f.fulfillment), { fulfillment: f.fulfillment, message: f.message });

  section('the password change reaches every plan on the login (accounttools.js)');
  const at = fs.readFileSync(path.join(__dirname, '..', 'accounttools.js'), 'utf8');
  ok('impact() hands back every row it found, not only the active ones', /subs,\s*active,\s*expired \}/.test(at) && /const allSubIds = \[\.\.\.new Set\(\(im\.subs \|\| \[\]\)/.test(at));
  ok('the update covers all of them and keeps raw_json in step', /UPDATE subscriptions SET password = \?, raw_json = IF\(raw_json IS NULL, NULL, JSON_SET\(raw_json, '\$\.Password', \?\)\) WHERE sub_id IN/.test(at) && /allSubIds\.slice\(i, i \+ 200\)/.test(at));
  ok('expired customers are still ticked removed, and the change log still records it', /UPDATE subscriptions SET removed = 1, removed_at = NOW\(\)/.test(at) && /action: 'account\.passwordChange'/.test(at) && /allSubs: allSubIds/.test(at));
  ok('the owner is told how many older plans were updated', /older plan\(s\) updated too/.test(at) && /olderUpdated: older/.test(at));

  section('every path that prints a password refreshes first');
  const reads = {
    'Recover getAccess': 'recover.js',
    'Customer 360': 'admin.js',
    'admin order card': 'adminlookup.js',
    '🔁 Switch account email': 'adminswitch.js',
    'renewal + "show it again"': 'fulfill.js',
  };
  for (const [name, file] of Object.entries(reads)) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    ok(name + ' uses the shared helper', /accesspassword'\)/.test(src) && /refreshAccessSafe\(/.test(src), file);
  }
  const rec = fs.readFileSync(path.join(__dirname, '..', 'recover.js'), 'utf8');
  ok('Recover reads the columns the helper needs', /inventory_ref, account_id, expiry_date/.test(rec));
  const ful = fs.readFileSync(path.join(__dirname, '..', 'fulfill.js'), 'utf8');
  ok('a renewal that keeps its account writes raw_json too', /JSON_SET\(raw_json, '\$\.LoginId', \?, '\$\.Password', \?, '\$\.ProfileName', \?, '\$\.ProfilePIN', \?\)/.test(ful));
  ok('a renewal that moves account writes raw_json too', /JSON_SET\(raw_json, '\$\.InventoryRef', \?, '\$\.LoginId', \?, '\$\.Password', \?/.test(ful));

  // ------------------------------------------------------------------ storefront
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
  let parsed = true;
  for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('index.html still parses', parsed && scripts.length > 0);

  section('My plans opens on Active');
  ok('a saved choice (including "all") is remembered and always wins', /v === 'active' \|\| v === 'expired' \|\| v === 'all' \? v : ''/.test(html) && /setSubFilterChosen\(true\);/.test(html) && /localStorage\.setItem\('ff_sub_filter', v\)/.test(html));
  ok('no saved choice + at least one running plan -> Active', /if \(subFilterChosen \|\| subFilterAuto\.current\) return;/.test(html) && /if \(liveSubs\.length\) setSubFilterState\('active'\);/.test(html));
  ok('no running plan -> stays on All, and the automatic choice is never saved', /const \[subFilter, setSubFilterState\] = useState\(\(\) => savedSubFilter\(\) \|\| 'all'\);/.test(html) && !/setSubFilter\('active'\)/.test(html));
  ok('it waits for the plans to load before deciding', /if \(!allSubs\.length\) return;/.test(html));

  section('the picker sheet scrolls, the page behind it does not');
  ok('one shared rule for every sheet', /const SHEET_PANEL_ = \{/.test(html) && /const SHEET_LIST_ = \{/.test(html) && /const SHEET_BG_ = \{/.test(html) && /function useSheetLock_\(open\) \{/.test(html));
  ok('the panel is capped, scrolls itself and never chains to the page', /maxHeight: 'min\(88dvh, calc\(100dvh - 24px\)\)'/.test(html) && /overscrollBehavior: 'contain'/.test(html) && /touchAction: 'pan-y'/.test(html));
  ok('a long list gets its own scroller with a 70vh cap', /maxHeight: 'min\(70vh, calc\(100dvh - 220px\)\)'/.test(html) && /flex: '1 1 auto',\s*minHeight: 0,/.test(html));
  ok('the page is locked while a sheet is open and unlocked when it closes', /return ffScrollLock_\(\);/.test(html) && /if \(--ffLock_\.n === 0\) html\.style\.overflow = ffLock_\.prev;/.test(html));
  const picker = (html.match(/function RecoverPickerModal\(\{[\s\S]*?\n\}\n/) || [''])[0];
  ok('the Recover picker: locked page, scrolling list, rows and Cancel never squashed', /useSheetLock_\(true\);/.test(picker) && /SHEET_LIST_/.test(picker) && (picker.match(/flexShrink: 0/g) || []).length >= 2 && /flexDirection: 'column'/.test(picker), picker.length);
  const lockCount = (html.match(/useSheetLock_\(/g) || []).length;
  ok('every bottom sheet locks the page (Recover · Get OTP · buy · login · email lock · tools)', lockCount >= 7, lockCount);
  ok('the tools / refund sheet CSS scrolls and contains its overscroll too', /\.ff-sheet \{[^}]*overflow-y: auto; overscroll-behavior: contain;[^}]*touch-action: pan-y;/.test(html) && /\.ff-sheet-bg \{[^}]*overscroll-behavior: contain; touch-action: none;/.test(html));

  section('Recover forgets the typed email');
  ok('nothing writes the email to the phone any more', !/localStorage\.setItem\('ff_recover_email'/.test(html));
  ok('the box opens empty and an old saved value is deleted', /const \[email, setEmail\] = useState\(''\);/.test(html) && /localStorage\.removeItem\('ff_recover_email'\)/.test(html));
  ok('Get OTP and the refund email box start empty too', /const \[refEmail, setRefEmail\] = useState\(''\);/.test(html) && !/getItem\('ff_recover_email'\)/.test(html));
  ok('no other email is read back out of our own storage', !/(localStorage|sessionStorage)\.getItem\([^)]*[Ee]mail/.test(html));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
