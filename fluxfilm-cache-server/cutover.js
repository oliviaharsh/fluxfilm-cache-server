/**
 * FluxFilm - safe go → shop import (admin → 🚚 Go-live import). Used once, at cutover.
 *
 * go.fluxfilm.in (Google Sheet) has the REAL customers, orders and subscriptions; shop only had tests.
 * This copies go's data into MySQL without duplicates and without touching what shop owns:
 *
 *   orders, subscriptions  by OrderID / SubID. New → added, legacy → refreshed from the Sheet.
 *                          A row created on shop (source='node') is never overwritten (reported instead).
 *   customers              matched by the LAST 10 DIGITS of the phone (the table key is the raw phone text, so
 *                          "+91 98765 43210" and "9876543210" would otherwise become two customers).
 *                          New → added. Existing → only EMPTY name / email / photo are filled in.
 *   coupon_usage           go's redemptions replace the old imported ones; shop's own redemptions are kept.
 *   wallet (optional)      go's coin balance, but never for a customer who has coin activity on shop.
 *
 *   NOT touched: plans, coupons, inventory accounts / profiles / capacity, settings, referrals, payments.
 *   Who holds which Netflix profile / Prime slot is worked out from the subscriptions table (fulfill.js),
 *   so importing subscriptions is what keeps shop from selling a taken slot again.
 *
 *   preview()          → counts + warnings, writes nothing
 *   run({ wallet })    → does the import, returns counts (callers must pause new orders first)
 */
const db = require('./db');
const sync = require('./sync');

const s = (v) => (v == null ? '' : String(v).trim());
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const CHUNK = 400;
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

const deps = { fetchDump: (tab) => sync._internal.fetchDump(tab), now: () => new Date() };

function same(a, b) {
  const x = s(a), y = s(b);
  if (x === y) return true;
  if (x !== '' && y !== '' && !isNaN(Number(x)) && !isNaN(Number(y))) return Number(x) === Number(y);
  return false;
}

async function load(def) {
  const rows = await deps.fetchDump(def.tab);
  const keyOf = def.key || ((r) => r[def.cols[def.pk][0]]);
  let noKey = 0;
  const byKey = new Map(); let dupes = 0;
  for (const r of rows) {
    const k = s(keyOf(r));
    if (!k) { noKey++; continue; }
    if (byKey.has(k)) dupes++;
    byKey.set(k, sync._internal.mapRow(def, r)); // the later Sheet row wins
  }
  return { sheetRows: rows.length, noKey, dupes, mapped: [...byKey.values()] };
}

async function existingByKey(table, pk, cols, keys) {
  const m = new Map();
  for (const part of chunks(keys, CHUNK)) {
    if (!part.length) continue;
    const rows = await db.query('SELECT `' + [pk].concat(cols).join('`, `') + '` FROM `' + table + '` WHERE `' + pk + '` IN (' + part.map(() => '?').join(',') + ')', part);
    for (const r of rows) m.set(s(r[pk]), r);
  }
  return m;
}

const COMPARE = {
  orders: ['status', 'fulfillment_status', 'final_amount', 'phone', 'service', 'plan', 'txn_ref'],
  subscriptions: ['status', 'expiry_date', 'new_expiry', 'inventory_ref', 'account_id', 'login_id', 'password', 'profile_number', 'release_eligible_at', 'phone'],
};

/** orders / subscriptions: classify each Sheet row against MySQL. */
async function planIdTable(table) {
  const def = sync.TABLES[table];
  const src = await load(def);
  const keys = src.mapped.map((r) => s(r[def.pk]));
  const have = await existingByKey(table, def.pk, ['source'].concat(COMPARE[table]), keys);
  const out = { table, sheetRows: src.sheetRows, skippedNoId: src.noKey, sheetDuplicates: src.dupes, add: 0, update: 0, same: 0, keptShopRows: [], rows: src.mapped };
  for (const r of src.mapped) {
    const ex = have.get(s(r[def.pk]));
    if (!ex) out.add++;
    else if (s(ex.source) === 'node') out.keptShopRows.push(s(r[def.pk]));
    else if (COMPARE[table].every((c) => same(ex[c], r[c]))) out.same++;
    else out.update++;
  }
  return out;
}

async function planCustomers() {
  const def = sync.TABLES.customers;
  const src = await load(def);
  // Merge Sheet rows of the same person (same last 10 digits): first non-empty value wins.
  const byNorm = new Map(); let samePerson = 0;
  for (const r of src.mapped) {
    const n = norm(r.phone); if (n.length !== 10) continue;
    const cur = byNorm.get(n);
    if (!cur) { byNorm.set(n, Object.assign({}, r, { phone_norm: n })); continue; }
    samePerson++;
    for (const c of ['name', 'email', 'profile_pic_url', 'member_since']) if (!s(cur[c]) && s(r[c])) cur[c] = r[c];
  }
  const norms = [...byNorm.keys()];
  const have = new Map();
  for (const part of chunks(norms, CHUNK)) {
    const rows = await db.query('SELECT phone, phone_norm, name, email, profile_pic_url, member_since FROM customers WHERE phone_norm IN (' + part.map(() => '?').join(',') + ')', part);
    for (const x of rows) { const k = s(x.phone_norm); if (!have.has(k)) have.set(k, []); have.get(k).push(x); }
  }
  const out = { table: 'customers', sheetRows: src.sheetRows, sheetSamePerson: samePerson, add: 0, fillBlanks: 0, same: 0, shopDuplicates: 0, rows: [], fills: [] };
  for (const [n, r] of byNorm) {
    const ex = have.get(n);
    if (!ex) { out.add++; out.rows.push(r); continue; }
    if (ex.length > 1) out.shopDuplicates++;
    const blanks = ['name', 'email', 'profile_pic_url'].filter((c) => s(r[c]) && ex.some((x) => !s(x[c])));
    if (blanks.length || (r.member_since && ex.some((x) => !x.member_since))) { out.fillBlanks++; out.fills.push(r); } else out.same++;
  }
  return out;
}

async function planWallet() {
  const def = sync.TABLES.wallet;
  const src = await load(def);
  const byNorm = new Map();
  for (const r of src.mapped) { const n = norm(r.phone); if (n.length === 10) byNorm.set(n, Object.assign({}, r, { phone_norm: n })); }
  const norms = [...byNorm.keys()];
  const shopActive = new Set(); const have = new Map();
  for (const part of chunks(norms, CHUNK)) {
    const q = '(' + part.map(() => '?').join(',') + ')';
    for (const x of await db.query('SELECT DISTINCT phone_norm FROM coins_ledger WHERE phone_norm IN ' + q, part).catch(() => [])) shopActive.add(s(x.phone_norm));
    for (const x of await db.query('SELECT phone_norm, coins_balance, coins_lifetime FROM wallet WHERE phone_norm IN ' + q, part)) { if (!have.has(s(x.phone_norm))) have.set(s(x.phone_norm), x); }
  }
  const out = { table: 'wallet', sheetRows: src.sheetRows, add: 0, update: 0, same: 0, keptShopBalances: 0, rows: [] };
  for (const [n, r] of byNorm) {
    if (shopActive.has(n)) { out.keptShopBalances++; continue; }
    const ex = have.get(n);
    if (!ex) { out.add++; out.rows.push(r); }
    else if (same(ex.coins_balance, r.coins_balance) && same(ex.coins_lifetime, r.coins_lifetime)) out.same++;
    else { out.update++; out.rows.push(r); }
  }
  return out;
}

async function planCouponUsage() {
  // Many rows share a coupon code (one per use), so do NOT de-duplicate by the table's "pk" here.
  const def = sync.TABLES.coupon_usage;
  const all = await deps.fetchDump(def.tab);
  const keyOf = def.key || ((r) => r[def.cols[def.pk][0]]);
  const src = { sheetRows: all.length, mapped: all.filter((r) => s(keyOf(r))).map((r) => sync._internal.mapRow(def, r)) };
  const shop = await db.query("SELECT COUNT(*) n FROM coupon_usage t JOIN orders o ON o.order_id = t.order_id WHERE o.source = 'node'", []);
  const cur = await db.query('SELECT COUNT(*) n FROM coupon_usage', []);
  return { table: 'coupon_usage', sheetRows: src.sheetRows, replaceImported: Math.max(0, Number(cur[0].n) - Number(shop[0].n)), keepShop: Number(shop[0].n), rows: src.mapped };
}

/** Netflix-style profile slots (inventory_ref with '#') held by an active go subscription AND an active shop one. */
async function slotClashes(subPlan) {
  const now = deps.now().getTime();
  const live = (r) => s(r.status).toUpperCase() === 'ACTIVE' && [r.expiry_date, r.release_eligible_at].some((d) => d && new Date(s(d).replace(' ', 'T')).getTime() > now);
  const goRefs = new Map();
  for (const r of subPlan.rows) if (live(r) && s(r.inventory_ref).includes('#')) goRefs.set(s(r.inventory_ref), s(r.sub_id));
  if (!goRefs.size) return [];
  const shop = await db.query("SELECT sub_id, inventory_ref, phone_norm FROM subscriptions WHERE source = 'node' AND UPPER(status) = 'ACTIVE' AND (expiry_date > NOW() OR release_eligible_at > NOW()) AND inventory_ref LIKE '%#%'", []);
  return shop.filter((x) => goRefs.has(s(x.inventory_ref)) && goRefs.get(s(x.inventory_ref)) !== s(x.sub_id))
    .map((x) => ({ inventoryRef: s(x.inventory_ref), goSub: goRefs.get(s(x.inventory_ref)), shopSub: s(x.sub_id), shopPhone: s(x.phone_norm) }));
}

async function buildPlan(opts) {
  const o = opts || {};
  const orders = await planIdTable('orders');
  const subscriptions = await planIdTable('subscriptions');
  const customers = await planCustomers();
  const couponUsage = await planCouponUsage();
  const wallet = o.wallet ? await planWallet() : null;
  const clashes = await slotClashes(subscriptions);
  return { orders, subscriptions, customers, couponUsage, wallet, clashes };
}

const strip = (p) => { const x = Object.assign({}, p); delete x.rows; delete x.fills; if (x.keptShopRows) { x.keptShopCount = x.keptShopRows.length; x.keptShopRows = x.keptShopRows.slice(0, 20); } return x; };
function summary(plan) {
  const warnings = [];
  if (plan.orders.keptShopRows.length) warnings.push(plan.orders.keptShopRows.length + ' order ID(s) exist on both go and shop — the shop copy is kept: ' + plan.orders.keptShopRows.slice(0, 5).join(', '));
  if (plan.subscriptions.keptShopRows.length) warnings.push(plan.subscriptions.keptShopRows.length + ' subscription ID(s) exist on both — the shop copy is kept.');
  if (plan.orders.sheetDuplicates || plan.subscriptions.sheetDuplicates) warnings.push('The Sheet has the same ID twice (' + (plan.orders.sheetDuplicates + plan.subscriptions.sheetDuplicates) + ' rows) — the later row is used, no duplicates are created.');
  if (plan.customers.shopDuplicates) warnings.push(plan.customers.shopDuplicates + ' customer(s) already have two rows in MySQL with the same number (old format difference) — left as they are.');
  if (plan.clashes.length) warnings.push(plan.clashes.length + ' profile slot(s) are held by an active go subscription AND an active shop (test) subscription — check them: ' + plan.clashes.slice(0, 3).map((c) => c.inventoryRef).join(', '));
  return {
    ok: true,
    orders: strip(plan.orders), subscriptions: strip(plan.subscriptions), customers: strip(plan.customers),
    couponUsage: strip(plan.couponUsage), wallet: plan.wallet ? strip(plan.wallet) : null,
    clashes: plan.clashes.slice(0, 20), warnings,
    untouched: ['plans', 'coupons', 'inventory accounts / profiles / capacity', 'settings', 'referrals', 'payments'],
  };
}

async function preview(opts) { return Object.assign(summary(await buildPlan(opts)), { preview: true, at: deps.now().toISOString() }); }

async function run(opts) {
  const o = opts || {};
  const plan = await buildPlan(o);
  const done = {};
  const upsert = sync._internal.upsert;
  for (const t of ['orders', 'subscriptions']) {
    const def = sync.TABLES[t]; let n = 0;
    for (const part of chunks(plan[t].rows, CHUNK)) { if (part.length) n += await upsert(t, def, part); }
    done[t] = { written: n, added: plan[t].add, updated: plan[t].update, keptShop: plan[t].keptShopRows.length };
  }
  // Customers: new people get a row; existing people only get their empty fields filled.
  let added = 0, filled = 0;
  for (const part of chunks(plan.customers.rows, CHUNK)) {
    if (!part.length) continue;
    // Bulk "VALUES ?" needs pool.query (db.query uses prepared statements, which can't expand it).
    const [r] = await db.getPool().query('INSERT IGNORE INTO customers (phone, phone_norm, name, email, profile_pic_url, member_since, raw_json) VALUES ?',
      [part.map((c) => [s(c.phone) || c.phone_norm, c.phone_norm, c.name, c.email, c.profile_pic_url, c.member_since, c.raw_json])]);
    added += (r && r.affectedRows) || 0;
  }
  for (const c of plan.customers.fills) {
    const r = await db.query("UPDATE customers SET name = IF(COALESCE(name, '') = '', ?, name), email = IF(COALESCE(email, '') = '', ?, email), " +
      "profile_pic_url = IF(COALESCE(profile_pic_url, '') = '', ?, profile_pic_url), member_since = COALESCE(member_since, ?) WHERE phone_norm = ?",
      [c.name, c.email, c.profile_pic_url, c.member_since, c.phone_norm]);
    filled += (r && r.affectedRows) ? 1 : 0;
  }
  done.customers = { added, filled };
  if (plan.couponUsage.rows.length) done.couponUsage = { written: await upsert('coupon_usage', sync.TABLES.coupon_usage, plan.couponUsage.rows), keptShop: plan.couponUsage.keepShop };
  else done.couponUsage = { written: 0, note: 'Sheet had no coupon usage rows — nothing replaced' };
  if (plan.wallet) {
    let w = 0;
    for (const r of plan.wallet.rows) {
      const u = await db.query('UPDATE wallet SET coins_balance = ?, coins_lifetime = ?, last_earned_at = ?, last_spent_at = ?, last_event = ?, raw_json = ? WHERE phone_norm = ?',
        [r.coins_balance || 0, r.coins_lifetime || 0, r.last_earned_at, r.last_spent_at, r.last_event, r.raw_json, r.phone_norm]);
      if (!u || !u.affectedRows) await db.query('INSERT IGNORE INTO wallet (phone, phone_norm, coins_balance, coins_lifetime, last_earned_at, last_spent_at, last_event, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [s(r.phone) || r.phone_norm, r.phone_norm, r.coins_balance || 0, r.coins_lifetime || 0, r.last_earned_at, r.last_spent_at, r.last_event, r.raw_json]);
      w++;
    }
    done.wallet = { written: w, keptShopBalances: plan.wallet.keptShopBalances };
  }
  for (const [t, v] of Object.entries(done)) {
    await db.query('INSERT INTO sync_log (direction, table_name, rows_count, note) VALUES (?,?,?,?)', ['sheet_to_mysql', t, Number(v.written || v.added || 0), 'go-live import ' + JSON.stringify(v).slice(0, 200)]).catch(() => {});
  }
  return Object.assign(summary(plan), { preview: false, done, at: deps.now().toISOString() });
}

// One job at a time, in the background (the Sheet export can take a minute; the admin page polls).
const job = { state: 'idle', kind: '', startedAt: null, finishedAt: null, result: null, error: '' };
function start(kind, opts) {
  if (job.state === 'running') return { ok: false, message: 'An import or preview is already running — wait for it to finish.' };
  Object.assign(job, { state: 'running', kind, startedAt: deps.now().toISOString(), finishedAt: null, result: null, error: '' });
  (kind === 'run' ? run(opts) : preview(opts))
    .then((r) => Object.assign(job, { state: 'done', result: r, finishedAt: deps.now().toISOString() }))
    .catch((e) => Object.assign(job, { state: 'failed', error: String((e && e.message) || e), finishedAt: deps.now().toISOString() }));
  return { ok: true, started: kind };
}
const status = () => Object.assign({ ok: true }, job);

module.exports = { preview, run, start, status, _internal: { deps, job, same, norm } };
