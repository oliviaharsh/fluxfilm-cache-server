/**
 * FluxFilm - Sheet -> MySQL sync (Phase 2/3).
 *
 * Pulls all rows of a Sheet tab via the Apps Script `adminDumpTab` endpoint
 * (through api.php) and upserts them into MySQL. Faithful: maps known columns
 * and stores the FULL original row in raw_json so nothing is ever lost.
 *
 * Usage:
 *   node sync.js --dry-run            # show what WOULD happen, touch nothing
 *   node sync.js                      # sync all tables
 *   node sync.js customers orders     # sync specific tables
 *
 * Env: API_PHP_URL, API_KEY, DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Kolkata'; // FluxFilm runs on India time
const db = require('./db');

const API_PHP_URL = process.env.API_PHP_URL || 'https://go.fluxfilm.in/api.php';
const API_KEY = process.env.API_KEY || '';

// ---- helpers ----
const s = (v) => (v == null ? null : String(v).trim() || null);
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const int = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
const boolInt = (v) => (/^(true|1|yes)$/i.test(String(v == null ? '' : v).trim()) ? 1 : 0);
const normPhone = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : null; };
function dt(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// column -> { sheet header, cast fn }
const TABLES = {
  customers: {
    tab: 'CUSTOMERS', pk: 'phone',
    cols: {
      phone: ['Phone', s], name: ['Name', s], email: ['Email', s],
      profile_pic_url: ['ProfilePicUrl', s], member_since: ['MemberSince', dt],
    },
  },
  orders: {
    tab: 'ORDERS', pk: 'order_id', protectNode: true,
    cols: {
      order_id: ['OrderID', s], created_at_sheet: ['CreatedAt', dt], service: ['Service', s],
      plan: ['Plan', s], duration_days: ['DurationDays', int], name: ['Name', s],
      email: ['Email', s], phone: ['Phone', s], coupon_code: ['CouponCode', s],
      discount: ['Discount', num], price: ['Price', num], final_amount: ['FinalAmount', num],
      currency: ['Currency', s], notes: ['Notes', s], extra_field_key: ['ExtraFieldKey', s],
      extra_field_value: ['ExtraFieldValue', s], status: ['Status', s],
      fulfillment_status: ['FulfillmentStatus', s], order_type: ['OrderType', s],
      renew_sub_id: ['RenewSubID', s], txn_ref: ['TxnRef', s], verified_at: ['VerifiedAt', dt],
      fulfilled_at: ['FulfilledAt', dt], group_join_required: ['GroupJoinRequired', s],
      group_join_link: ['GroupJoinLink', s], group_joined: ['GroupJoined', s],
      group_joined_at: ['GroupJoinedAt', dt], suspend_if_false_on: ['SuspendIfFalseOn', dt],
    },
  },
  subscriptions: {
    tab: 'SUBSCRIPTIONS', pk: 'sub_id', protectNode: true,
    cols: {
      sub_id: ['SubID', s], order_id: ['OrderID', s], phone: ['Phone', s], email: ['Email', s],
      service: ['Service', s], plan: ['Plan', s], duration_days: ['DurationDays', int],
      start_date: ['StartDate', dt], expiry_date: ['ExpiryDate', dt], new_expiry: ['NewExpiry', dt],
      status: ['Status', s], fulfillment_status: ['FulfillmentStatus', s], order_type: ['OrderType', s],
      renew_sub_id: ['RenewSubID', s], inventory_ref: ['InventoryRef', s], account_id: ['AccountID', s],
      login_id: ['LoginId', s], password: ['Password', s], profile_name: ['ProfileName', s],
      profile_pin: ['ProfilePIN', s], profile_number: ['ProfileNumber', s],
      last_access_sent_at: ['LastAccessSentAt', dt], release_eligible_at: ['ReleaseEligibleAt', dt],
      fulfilled_at: ['FulfilledAt', dt], notes: ['Notes', s], device_type: ['DeviceType', s],
      removed: ['RemovedFromDevice', boolInt], device_count: ['DeviceConcurrency', int],
    },
  },
  plans: {
    tab: 'PLANS', pk: 'service',
    cols: {
      service: ['Service', s], plan: ['Plan', s], duration_days: ['DurationDays', int],
      price: ['Price', num], early_renew_discount: ['EarlyRenewDiscount', num],
      early_renew_discount_7to2: ['EarlyRenewDiscount_7to2', num],
      logo_url: ['LogoUrl', s], is_active: ['IsActive', s],
    },
  },
  coupons: {
    tab: 'COUPONS', pk: 'code',
    key: (r) => String((r.CouponCode != null ? r.CouponCode : '') || (r.Code != null ? r.Code : '') || '').trim(),
    cols: {
      code: ['CouponCode', s], description: ['Description', s], scope: ['Scope', s], type: ['Type', s],
      value: ['Value', num], min_amount: ['MinAmount', num], max_discount: ['MaxDiscount', num],
      expiry: ['Expiry', dt], per_user_limit: ['PerUserLimit', int], global_limit: ['GlobalLimit', int],
      active: ['Active', s], show_in_profile: ['ShowInProfile', s], allowed_phones: ['AllowedPhones', s],
      first_time_only: ['FirstTimeOnly', s],
    },
  },
  coupon_usage: {
    tab: 'COUPON_USAGE', pk: 'coupon_code', mode: 'replace', keepNodeRows: true,
    cols: {
      coupon_code: ['CouponCode', s], phone: ['Phone', s], email: ['Email', s],
      discount: ['Discount', num], order_id: ['OrderID', s], action: ['Action', s], ts: ['Timestamp', dt],
    },
  },
  wallet: {
    tab: 'WALLET', pk: 'phone',
    cols: {
      phone: ['Phone', s], coins_balance: ['CoinsBalance', num], coins_lifetime: ['CoinsLifetime', num],
      last_earned_at: ['LastEarnedAt', dt], last_spent_at: ['LastSpentAt', dt], last_event: ['LastEvent', s],
    },
  },
  inventory_accounts: {
    tab: 'INVENTORY_ACCOUNTS', pk: 'account_id', mode: 'replace',
    cols: { service: ['Service', s], account_id: ['AccountID', s], login_id: ['LoginId', s], password: ['Password', s], is_active: ['IsActive', s], plan: ['Plan', s], notes: ['Notes', s] },
  },
  inventory_profiles: {
    tab: 'INVENTORY_PROFILES', pk: 'account_id', mode: 'replace',
    cols: { service: ['Service', s], account_id: ['AccountID', s], profile_name: ['ProfileName', s], profile_number: ['ProfileNumber', s], profile_pin: ['ProfilePIN', s], status: ['Status', s], current_sub_id: ['CurrentSubID', s] },
  },
  inventory_capacity: {
    tab: 'INVENTORY_CAPACITY', pk: 'account_id', mode: 'replace',
    cols: { service: ['Service', s], account_id: ['AccountID', s], max_total: ['MaxTotal', int], max_tv: ['MaxTV', int], is_active: ['IsActive', s], notes: ['Notes', s] },
  },
  trending_items: {
    tab: 'TRENDING', pk: 'item_key', mode: 'replace',
    key: (r) => String(r.Line || '').trim() || (String(r.Title || '').trim() + '|' + String(r.Platform || '').trim()),
    cols: {
      item_key: ['Line', s], active: ['Active', s], title: ['Title', s],
      platform: ['Platform', s], line: ['Line', s], sort_order: ['SortOrder', int],
    },
  },
};

async function fetchDump(tab) {
  const res = await fetch(API_PHP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': API_KEY },
    body: JSON.stringify({ apiKey: API_KEY, action: 'adminDumpTab', args: [tab] }),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error(`Non-JSON dump for ${tab}: ${text.slice(0, 200)}`); }
  const rows = (j.result && j.result.rows) || j.rows || [];
  if (!Array.isArray(rows)) throw new Error(`Dump for ${tab} had no rows array. Got: ${JSON.stringify(j).slice(0, 200)}`);
  return rows;
}

function mapRow(def, srcRow) {
  const out = {};
  for (const [col, [header, cast]] of Object.entries(def.cols)) {
    out[col] = cast(srcRow[header]);
  }
  if (def.key) out[def.pk] = def.key(srcRow);
  if (Object.prototype.hasOwnProperty.call(out, 'phone')) out.phone_norm = normPhone(out.phone);
  out.raw_json = JSON.stringify(srcRow);
  return out;
}

async function upsert(table, def, mapped) {
  // An empty dump never clears a table (a broken/missing Sheet tab must not wipe MySQL).
  if (!mapped.length) return 0;
  const cols = Object.keys(mapped[0]);
  const values = mapped.map((r) => cols.map((c) => r[c]));
  const colList = cols.map((c) => `\`${c}\``).join(', ');
  const pool = db.getPool();
  if (def.mode === 'replace') {
    // DELETE + INSERT inside one transaction. The old TRUNCATE auto-committed, so a
    // failed INSERT left the table EMPTY — for the inventory tables that means no
    // account can be allocated until someone notices.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (def.keepNodeRows) {
        // Keep redemptions made on the new checkout: their orders exist only in
        // MySQL, so the Sheet can never re-supply them and deleting them would reset
        // every coupon's usage limit.
        await conn.query(
          'DELETE t FROM `' + table + '` t LEFT JOIN orders o ON o.order_id = t.order_id ' +
          "WHERE o.order_id IS NULL OR COALESCE(o.source, '') <> 'node'");
      } else {
        await conn.query('DELETE FROM `' + table + '`');
      }
      await conn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ?`, [values]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    } finally { conn.release(); }
    return mapped.length;
  }
  // protectNode: a row the new stack created or renewed (source='node') is newer
  // than anything in the Sheet — e.g. a renewal's extended expiry. Leave it alone.
  const updates = cols.filter((c) => c !== def.pk).map((c) => (def.protectNode
    ? `\`${c}\`=IF(COALESCE(\`source\`,'')='node', \`${c}\`, VALUES(\`${c}\`))`
    : `\`${c}\`=VALUES(\`${c}\`)`)).join(', ');
  const sql = `INSERT INTO \`${table}\` (${colList}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`;
  await pool.query(sql, [values]);
  return mapped.length;
}

async function syncOne(table, dry) {
  const def = TABLES[table];
  const rows = await fetchDump(def.tab);
  const keyOf = def.key || ((r) => r[def.cols[def.pk][0]]);
  const mapped = rows
    .filter((r) => { const k = keyOf(r); return k != null && String(k).trim() !== ''; })
    .map((r) => mapRow(def, r));
  if (dry) {
    return { table, sheetRows: rows.length, withKey: mapped.length, dry: true,
      sample: mapped.length ? { ...mapped[0], raw_json: '…' } : null };
  }
  const n = await upsert(table, def, mapped);
  await db.query('INSERT INTO sync_log (direction, table_name, rows_count, note) VALUES (?,?,?,?)',
    ['sheet_to_mysql', table, n, 'ok']);
  return { table, upserted: n };
}

/**
 * Programmatic entry point (used by the server endpoint).
 * @returns {Promise<{ok:boolean, results:Array, error?:string}>}
 */
const MASTER_TABLES = ['plans', 'coupons', 'inventory_accounts', 'inventory_profiles', 'inventory_capacity'];

async function runSync(tables, opts) {
  opts = opts || {};
  const dry = !!opts.dry;
  // MySQL is the master for catalogue + inventory: admin edits made on shop
  // (prices, ExtraDevicePrice, coupons, accounts, capacity) must not be silently
  // overwritten by a routine full sync. They are imported only when named
  // explicitly, e.g. /admin/sync?tables=inventory_accounts.
  const list = (tables && tables.length) ? tables : Object.keys(TABLES).filter((t) => !MASTER_TABLES.includes(t));
  const skipped = (tables && tables.length) ? [] : MASTER_TABLES.slice();
  const results = [];
  if (!dry) {
    const p = await db.ping();
    if (!p.ok) return { ok: false, error: 'DB not reachable: ' + p.reason, results };
  }
  for (const t of list) {
    if (!TABLES[t]) { results.push({ table: t, error: 'unknown table' }); continue; }
    try { results.push(await syncOne(t, dry)); }
    catch (e) { results.push({ table: t, error: e.message }); }
  }
  return { ok: true, dry, results, skippedMasterTables: skipped };
}

module.exports = { runSync, TABLES, MASTER_TABLES, _internal: { upsert, fetchDump, mapRow } };

// CLI mode: `node sync.js [--dry-run] [table...]`
if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const which = args.filter((a) => !a.startsWith('--'));
  runSync(which, { dry }).then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    const pool = db.getPool();
    if (pool) await pool.end();
  });
}
