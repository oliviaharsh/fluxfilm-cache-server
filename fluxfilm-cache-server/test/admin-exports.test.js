/* 📤 Admin exports: orders list + customer profiles to Excel (.xlsx) / CSV. Owner request 16 Sep 2026.
 * Run: npm test (no database: an in-memory fake that refuses JOINs, like MariaDB with mixed collations). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const clone = (x) => JSON.parse(JSON.stringify(x));
const nsql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const noJoin = (sql) => { if (/\bJOIN\b/i.test(sql)) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT): ' + sql); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; } };
const SECRETS = ['SECRETPW', 'secretlogin@x', 'PIN7Q9Z', 'PUSHSECRET', 'OTP-998877', 'SESSIONSECRET'];

// ====================================================================== fake data
const NOW = Date.parse('2026-09-16T12:00:00+05:30');
const D = { audit: [], sql: [] };
function seed() {
  D.orders = [
    { order_id: 'FF1001', created_at_sheet: '2026-09-01 00:00:00', name: 'Ravi, "Kumar"', email: 'ravi@x.com', phone: '+91 98765 43210', phone_norm: '9876543210', service: 'Netflix', plan: 'Sharing 1M', price: 199, discount: 20, coupon_code: 'SAVE20', final_amount: 179, status: 'PAID', fulfillment_status: 'FULFILLED', order_type: 'NEW', renew_sub_id: '', txn_ref: 'UPI111', notes: '', device_count: 1, source: 'node', raw_json: JSON.stringify({ ReferralCode: 'RAVI10', ReferralDiscount: 20, AccessTokenHash: 'SESSIONSECRET' }) },
    { order_id: 'FF1002', created_at_sheet: '2026-09-10 14:30:00', name: 'Priya', email: 'priya@x.com', phone: '9000000002', phone_norm: '9000000002', service: 'Prime Video', plan: '1 Month', price: 129, discount: 0, coupon_code: '', final_amount: 129, status: 'REFUNDED', fulfillment_status: 'FAILED', order_type: 'NEW', renew_sub_id: '', txn_ref: 'UPI222', notes: '', device_count: 2, source: 'node', raw_json: JSON.stringify({ RefundMethod: 'UPI', RefundAmount: 129, RefundUpi: 'priya@upi', RefundedAt: '2026-09-11 10:00:00' }) },
    { order_id: 'FF1003', created_at_sheet: '2026-09-15 09:00:00', name: 'Priya', email: 'priya@x.com', phone: '9000000002', phone_norm: '9000000002', service: 'Prime Video', plan: '1 Month', price: 149, discount: 0, coupon_code: '', final_amount: 149, status: 'CREDIT', fulfillment_status: 'FULFILLED', order_type: 'RENEW', renew_sub_id: 'S2', txn_ref: '', notes: 'ADMIN RENEW CREDIT', device_count: 1, source: 'node', raw_json: JSON.stringify({ CreatedVia: 'ADMIN', PaymentMethod: 'CREDIT', AdminNote: 'pays Friday', Credit: true, CreditAmount: 149, CreditDueDate: '2026-09-18', CreditCreatedAt: '2026-09-15T03:30:00.000Z', CreditStatus: 'OPEN', CreditPayments: [{ amount: 49, method: 'UPI' }] }) },
    { order_id: 'FF1004', created_at_sheet: '2026-09-12 20:15:00', name: '=HYPERLINK("http://evil")', email: 'ravi@x.com', phone: '9876543210', phone_norm: '9876543210', service: 'Netflix', plan: 'Sharing 1M', price: 199, discount: 199, coupon_code: '', final_amount: 0, status: 'PAID', fulfillment_status: 'MANUAL_PENDING', order_type: 'NEW', renew_sub_id: '', txn_ref: 'CREDIT-FF1004', notes: 'line1\nline2 😀, "ok"', device_count: null, source: 'node', raw_json: JSON.stringify({ PaymentMethod: 'COINS', PaidWithCoins: 199, CoinsUsed: 40, CoinsDiscount: 199, FreeConfirmedAt: '2026-09-12T14:45:00.000Z' }) },
    { order_id: 'FF1005', created_at_sheet: '2026-09-16 23:59:59', name: 'Never Paid', email: 'n@x.com', phone: '9111111111', phone_norm: '9111111111', service: 'Hotstar', plan: '1 Month', price: 99, discount: 0, coupon_code: '', final_amount: 99, status: 'CREATED', fulfillment_status: '', order_type: 'NEW', renew_sub_id: '', txn_ref: '', notes: '', device_count: 1, source: 'node', raw_json: '{}' },
    { order_id: 'FF1006', created_at_sheet: '2026-08-31 23:59:59', name: 'Ravi', email: 'ravi@x.com', phone: '9876543210', phone_norm: '9876543210', service: 'Netflix', plan: 'Private 1M', price: 399, discount: 0, coupon_code: '', final_amount: 399, status: 'PAID', fulfillment_status: 'FULFILLED', order_type: 'NEW', renew_sub_id: '', txn_ref: 'UPI333', notes: '', device_count: 1, source: 'node', raw_json: '{}' },
    { order_id: 'FF1007', created_at_sheet: '2026-09-17 00:00:00', name: 'Tomorrow', email: '', phone: '9222222222', phone_norm: '9222222222', service: 'Prime Video', plan: '1 Month', price: 129, discount: 0, coupon_code: '', final_amount: 129, status: 'PAID', fulfillment_status: 'FULFILLED', order_type: 'NEW', renew_sub_id: '', txn_ref: 'UPI444', notes: '', device_count: 1, source: 'node', raw_json: '{}' },
    { order_id: 'FF0900', created_at_sheet: '2025-12-01 10:00:00', name: 'Old Timer', email: 'old@x.com', phone: '9222222222', phone_norm: '9222222222', service: 'Prime Video', plan: '1 Month', price: 149, discount: 0, coupon_code: '', final_amount: 149, status: 'PAID', fulfillment_status: 'FULFILLED', order_type: 'NEW', renew_sub_id: '', txn_ref: 'OLD1', notes: '', device_count: 1, source: 'sheet', raw_json: '{}' },
  ];
  D.subscriptions = [
    { sub_id: 'S1', order_id: 'FF1001', phone_norm: '9876543210', service: 'Netflix', plan: 'Sharing 1M', status: 'ACTIVE', expiry_date: '2026-10-12 10:00:00', inventory_ref: 'NF-ACC-1#P2', login_id: 'secretlogin@x', password: 'SECRETPW', profile_pin: 'PIN7Q9Z', removed: 0 },
    { sub_id: 'S2', order_id: 'FF0901', phone_norm: '9000000002', service: 'Prime Video', plan: '1 Month', status: 'ACTIVE', expiry_date: '2026-10-30 09:00:00', inventory_ref: 'PR-ACC-3', login_id: 'secretlogin@x', password: 'SECRETPW', profile_pin: '', removed: 0 },
    { sub_id: 'S3', order_id: 'FF0800', phone_norm: '9000000002', service: 'Hotstar', plan: '1 Month', status: 'EXPIRED', expiry_date: '2026-08-01 09:00:00', inventory_ref: 'HS-1', login_id: '', password: 'SECRETPW', profile_pin: '', removed: 1 },
    { sub_id: 'S4', order_id: 'FF0900', phone_norm: '9222222222', service: 'Prime Video', plan: '1 Month', status: 'ACTIVE', expiry_date: '2026-01-01 10:00:00', inventory_ref: 'PR-ACC-1', login_id: '', password: 'SECRETPW', profile_pin: '', removed: 0 },
  ];
  D.customers = [
    { customer_id: 'C001', name: 'Ravi', phone: '9876543210', phone_norm: '9876543210', email: 'ravi@x.com', member_since: '2026-01-05 10:00:00', raw_json: JSON.stringify({ EmailVerified: true, EmailVerifiedEmail: 'ravi@x.com', Notes: 'VIP', Password: 'SECRETPW', PushToken: 'PUSHSECRET', LastOtp: 'OTP-998877' }) },
    { customer_id: 'C002', name: 'Priya', phone: '9000000002', phone_norm: '9000000002', email: '', member_since: '2026-09-10 08:00:00', raw_json: '{}' },
    { customer_id: 'C003', name: 'Never Paid', phone: '9111111111', phone_norm: '9111111111', email: 'n@x.com', member_since: '2026-09-12 08:00:00', raw_json: '{}' },
    { customer_id: 'C004', name: 'Old Timer', phone: '9222222222', phone_norm: '9222222222', email: 'old@x.com', member_since: '2025-05-01 08:00:00', raw_json: '{}' },
  ];
  D.wallet = [
    { phone_norm: '9876543210', coins_balance: 5, coins_lifetime: 10 },
    { phone_norm: '9876543210', coins_balance: 30, coins_lifetime: 50 },
  ];
  D.referral_codes = [{ phone_norm: '9876543210', code: 'RAVI10' }];
  D.referrals = [{ friend_phone: '9000000002', referrer_phone: '9876543210', code: 'RAVI10', status: 'REWARDED' }];
  D.payment_claims = [{ order_id: 'FF1006', utr: '123456789012', status: 'MATCHED', source: 'CUSTOMER' }];
}

// ---------------------------------------------------------------------- tiny WHERE evaluator (single table only)
function splitAnd(w) {
  const out = []; let depth = 0; let cur = ''; let quote = false;
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    if (ch === "'") quote = !quote;
    if (!quote) { if (ch === '(') depth++; if (ch === ')') depth--; }
    if (!quote && depth === 0 && w.startsWith(' AND ', i)) { out.push(cur.trim()); cur = ''; i += 4; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function makePred(cond, P) {
  let m;
  const colExpr = (e) => { const x = e.match(/^(UPPER\()?(?:COALESCE\()?(?:CAST\()?(\w+)(?:, '')?\)?\)?$/); return x ? { col: x[2], upper: !!x[1] } : null; };
  const val = (r, c) => { const v = r[c.col] == null ? '' : String(r[c.col]); return c.upper ? v.toUpperCase() : v; };
  if ((m = cond.match(/^(\w+) (>=|<|=) \?$/))) { const p = P(); const col = m[1]; const op = m[2]; return (r) => { const v = r[col] == null ? null : String(r[col]); if (v == null || v === '') return false; return op === '>=' ? v >= p : op === '<' ? v < p : v === String(p); }; }
  if ((m = cond.match(/^(.+?) IN \(([^)]*)\)$/)) && colExpr(m[1])) {
    const c = colExpr(m[1]); const vals = m[2].split(',').map((x) => x.trim()).map((x) => (x === '?' ? String(P()) : x.replace(/^'|'$/g, '')));
    return (r) => vals.includes(val(r, c));
  }
  if ((m = cond.match(/^(.+?) (=|<>) '([^']*)'$/)) && colExpr(m[1])) { const c = colExpr(m[1]); const lit = m[3]; const eq = m[2] === '='; return (r) => (val(r, c) === lit) === eq; }
  if ((m = cond.match(/^\((.+)\)$/)) && / LIKE \?/.test(m[1])) {
    const cols = m[1].split(' OR ').map((x) => x.match(/^(\w+) LIKE \?$/)[1]); const ps = cols.map(() => String(P()));
    return (r) => cols.some((c, i) => { const pat = ps[i]; if (pat === '__no_match__') return false; const needle = pat.replace(/^%|%$/g, '').toLowerCase(); return String(r[c] == null ? '' : r[c]).toLowerCase().includes(needle); });
  }
  throw new Error('fake db: unhandled condition: ' + cond);
}
function run(sqlRaw, params) {
  const sql = nsql(sqlRaw); params = (params || []).slice();
  D.sql.push(sql);
  noJoin(sql);
  if (/^INSERT INTO audit_log/.test(sql)) { D.audit.push({ action: params[0], entity: params[1], id: params[2], summary: params[3], details: params[4] }); return { affectedRows: 1 }; }
  const m = sql.match(/^SELECT (DISTINCT )?(.+?) FROM (\w+)(?: WHERE (.+?))?(?: GROUP BY (\w+))?(?: ORDER BY .+?)?(?: LIMIT (\?|\d+)(?: OFFSET \?)?)?$/);
  if (!m) throw new Error('fake db: unhandled SQL: ' + sql);
  const table = D[m[3]];
  if (!table) { const e = new Error("Table 'x." + m[3] + "' doesn't exist"); throw e; }
  let i = 0; const P = () => params[i++];
  const preds = m[4] ? splitAnd(m[4]).map((c) => makePred(c, P)) : [];
  let rows = table.filter((r) => preds.every((p) => p(r)));
  const ob = sql.match(/ ORDER BY (\w+)( DESC)?/);
  if (ob) rows = rows.slice().sort((a, b) => { const va = String(a[ob[1]] == null ? '' : a[ob[1]]); const vb = String(b[ob[1]] == null ? '' : b[ob[1]]); return va === vb ? 0 : (va < vb ? -1 : 1) * (ob[2] ? -1 : 1); });
  if (m[6] === '?') { const limit = Number(P()); const offset = / OFFSET \?/.test(sql) ? Number(P()) : 0; rows = rows.slice(offset, offset + limit); } else if (m[6]) rows = rows.slice(0, Number(m[6]));
  if (/^COUNT\(\*\) AS n$/.test(m[2])) return [{ n: rows.length }];
  if (m[5]) { const g = new Map(); for (const r of rows) g.set(r[m[5]], (g.get(r[m[5]]) || 0) + 1); return [...g.entries()].map(([k, n]) => ({ [m[5]]: k, n })); }
  const cols = m[2].split(',').map((x) => x.trim());
  for (const c of cols) if (!/^\w+$/.test(c)) throw new Error('fake db: unhandled column ' + c);
  let out = rows.map((r) => { const o = {}; for (const c of cols) o[c] = r[c] === undefined ? null : clone(r[c]); return o; });
  if (m[1]) { const seen = new Set(); out = out.filter((o) => { const k = JSON.stringify(o); if (seen.has(k)) return false; seen.add(k); return true; }); }
  return out;
}
const fakeDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => null, ping: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return fakeDb;
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------- zip / xml helpers
function unzip(buf) {
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16); const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extra = buf.readUInt16LE(p + 30); const comment = buf.readUInt16LE(p + 32); const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const lName = buf.readUInt16LE(off + 26); const lExtra = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lName + lExtra, off + 30 + lName + lExtra + size);
    files[name] = { method, crc, data, text: data.toString('utf8') };
    p += 46 + nameLen + extra + comment;
  }
  return files;
}
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(body)) return 'bad entity';
  const stack = []; const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g; let m; let last = 0;
  while ((m = re.exec(body))) {
    if (/</.test(body.slice(last, m.index))) return 'stray < near ' + body.slice(last, m.index).slice(0, 40);
    last = m.index + m[0].length;
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return 'mismatched </' + m[2] + '>'; } else stack.push(m[2]);
  }
  if (/</.test(body.slice(last))) return 'unparsed tag';
  return stack.length ? 'unclosed ' + stack.join(',') : '';
}
function sheetCells(files, n) {
  const sst = [...files['xl/sharedStrings.xml'].text.matchAll(/<si><t xml:space="preserve">([\s\S]*?)<\/t><\/si>/g)].map((x) => x[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  const cells = {};
  for (const c of files['xl/worksheets/sheet' + n + '.xml'].text.matchAll(/<c r="([A-Z]+\d+)"((?: [a-z]+="[^"]*")*)(?:\/>|><v>([^<]*)<\/v><\/c>)/g)) {
    const attrs = c[2]; const t = (attrs.match(/ t="(\w+)"/) || [])[1]; const st = (attrs.match(/ s="(\d+)"/) || [])[1];
    cells[c[1]] = { t: t || 'n', s: st == null ? 0 : +st, raw: c[3], v: t === 's' ? sst[+c[3]] : c[3] == null ? null : Number(c[3]) };
  }
  return cells;
}

(async () => {
  seed();
  const ex = require('../adminexports');
  const xlsx = require('../xlsx');
  const security = require('../security');

  // ==================================================================== 1. filters → SQL
  section('date presets → India-time SQL bounds (month ends, week start, leap year)');
  const at = (iso) => Date.parse(iso);
  let r = ex.dateRange('today', '', '', at('2026-09-30T20:00:00Z')); // = 1 Oct 01:30 IST
  ok('today just after midnight IST is the new India day (1 Oct), not UTC 30 Sep', r.from === '2026-10-01' && r.to === '2026-10-01', r);
  let f = ex.normOrderFilters({ date: 'today' }, at('2026-09-30T20:00:00Z'));
  let w = ex.orderWhere(f);
  ok('today → created_at_sheet >= "2026-10-01 00:00:00" AND < "2026-10-02 00:00:00"', /created_at_sheet >= \? AND created_at_sheet < \?/.test(w.sql) && w.params[0] === '2026-10-01 00:00:00' && w.params[1] === '2026-10-02 00:00:00', w);
  r = ex.dateRange('yesterday', '', '', at('2026-10-01T00:30:00+05:30'));
  ok('yesterday on 1 Oct → 30 Sep', r.from === '2026-09-30' && r.to === '2026-09-30', r);
  r = ex.dateRange('this_week', '', '', NOW);
  ok('this week on Wed 16 Sep → Mon 14 Sep to 16 Sep', r.from === '2026-09-14' && r.to === '2026-09-16', r);
  r = ex.dateRange('this_week', '', '', at('2026-09-20T18:00:00+05:30'));
  ok('this week on Sunday 20 Sep → still Mon 14 Sep', r.from === '2026-09-14', r);
  r = ex.dateRange('last_month', '', '', at('2026-03-05T10:00:00+05:30'));
  ok('last month in March 2026 → 1 Feb to 28 Feb', r.from === '2026-02-01' && r.to === '2026-02-28', r);
  r = ex.dateRange('last_month', '', '', at('2024-03-01T00:10:00+05:30'));
  ok('last month on 1 Mar 2024 (leap year) → 1 Feb to 29 Feb', r.from === '2024-02-01' && r.to === '2024-02-29', r);
  w = ex.orderWhere(ex.normOrderFilters({ date: 'last_month' }, at('2027-01-10T10:00:00+05:30')));
  ok('last month in January → December of last year, end bound 1 Jan 00:00', w.params[0] === '2026-12-01 00:00:00' && w.params[1] === '2027-01-01 00:00:00', w.params);
  r = ex.dateRange('this_month', '', '', NOW);
  ok('this month → 1 Sep to today', r.from === '2026-09-01' && r.to === '2026-09-16', r);
  r = ex.dateRange('custom', '2026-09-16', '2026-09-01', NOW);
  ok('custom range given backwards is swapped', r.from === '2026-09-01' && r.to === '2026-09-16', r);
  r = ex.dateRange('custom', '2026-02-30', '2026-09-01', NOW);
  ok('an impossible date (30 Feb) is ignored, not guessed', r.from === '' && r.to === '2026-09-01', r);
  ok('unknown preset + no dates → all dates (no date SQL)', ex.orderWhere(ex.normOrderFilters({ date: 'forever' }, NOW)).sql === '');
  ok('file name FluxFilm-orders-2026-09-01_to_2026-09-16.xlsx', ex.fileName('orders', ex.dateRange('custom', '2026-09-01', '2026-09-16', NOW), 'xlsx', NOW) === 'FluxFilm-orders-2026-09-01_to_2026-09-16.xlsx');
  ok('file name for all dates / CSV', ex.fileName('customers', ex.dateRange('all', '', '', NOW), 'csv', NOW) === 'FluxFilm-customers-all_to_2026-09-16.csv');

  section('other order filters → bound parameters only');
  f = ex.normOrderFilters({ statuses: ['paid', 'credit', 'hack; DROP'], types: ['renewal'], services: ['Netflix', "Prime' OR 1=1"], plan: 'Sharing 1M', delivery: ['manual'], hasCoupon: 'yes', q: '98765' }, NOW);
  w = ex.orderWhere(f);
  ok('status groups (paid = PAID+FULFILLED), unknown status dropped', /UPPER\(status\) IN \(\?, \?, \?\)/.test(w.sql) && w.params.slice(0, 3).join() === 'PAID,FULFILLED,CREDIT' && f.statuses.length === 2, w);
  ok('renewal only → order_type RENEW', /UPPER\(COALESCE\(order_type, ''\)\) = 'RENEW'/.test(w.sql));
  ok('services and plan are parameters (quote in a name never reaches the SQL text)', /service IN \(\?, \?\)/.test(w.sql) && w.params.includes("Prime' OR 1=1") && !/OR 1=1/.test(w.sql) && /plan = \?/.test(w.sql));
  ok('delivery manual + has coupon + search on order id / name / email / UTR / phone', /fulfillment_status, ''\)\) IN \(\?\)/.test(w.sql) && w.params.includes('MANUAL_PENDING') && /COALESCE\(coupon_code, ''\) <> ''/.test(w.sql) && w.params[w.params.length - 1] === '%98765%');
  ok('both types chosen = no type filter', !/order_type/.test(ex.orderWhere(ex.normOrderFilters({ types: ['new', 'renewal'] }, NOW)).sql));

  // ==================================================================== 2. column mapping
  section('order row mapping: refunds, credit, coins, referral, claims, expiry');
  const subsByOrder = new Map([['FF1001', [D.subscriptions[0]]]]);
  const subsById = new Map([['S2', D.subscriptions[1]]]);
  const claims = new Map([['FF1006', D.payment_claims[0]]]);
  const ctx = { subsByOrder, subsById, claims, now: NOW };
  const o1 = ex.mapOrder(D.orders[0], ctx);
  ok('paid order: price / discount / coupon / paid / UPI auto / referral code / account ref / plan expiry', o1.price === 199 && o1.discount === 20 && o1.coupon === 'SAVE20' && o1.paid === 179 && o1.method === 'UPI (auto-matched)' && o1.referralCode === 'RAVI10' && o1.accountRef === 'NF-ACC-1#P2' && o1.expiry === '2026-10-12 10:00:00' && o1.type === 'New' && o1.status === 'Paid' && o1.delivery === 'Delivered' && o1.phone === '9876543210', o1);
  const o2 = ex.mapOrder(D.orders[1], ctx);
  ok('refunded order: kind UPI, amount 129, method UPI; paid stays 129; devices 2', o2.refundKind === 'UPI' && o2.refundAmount === 129 && o2.refundMethod === 'UPI' && o2.paid === 129 && o2.status === 'Refunded' && o2.devices === 2 && o2._refundKind === 'UPI', o2);
  const o3 = ex.mapOrder(D.orders[2], ctx);
  ok('credit renewal: On credit, ₹49 received, ₹100 due, renewal, expiry from the renewed subscription, admin note', o3.method === 'On credit (pay later)' && o3.paid === 49 && o3.creditDue === 100 && o3.type === 'Renewal' && o3.expiry === '2026-10-30 09:00:00' && o3.accountRef === 'PR-ACC-3' && /Admin note: pays Friday/.test(o3.notes) && o3._methodKey === 'credit', o3);
  const o4 = ex.mapOrder(D.orders[3], ctx);
  ok('₹0 coins order: Coins, 40 coins used, paid 0, manual pending, devices default 1', o4.method === 'Coins' && o4.coinsUsed === 40 && o4.paid === 0 && o4.delivery === 'Manual — to activate' && o4.devices === 1 && o4._methodKey === 'coins', o4);
  const o6 = ex.mapOrder(D.orders[5], ctx);
  ok('backup UPI claim with a typed UTR → "UTR typed by customer" and the UTR as ref', o6.method === 'UTR typed by customer' && o6.ref === '123456789012' && o6._methodKey === 'utr', o6);
  ok('claim without UTR → Backup UPI claim; old Sheet order → Old site; admin order → Admin (UPI)',
    ex.paymentMethod(D.orders[5], {}, { utr: null, source: 'CUSTOMER' }).key === 'backup_claim' && ex.paymentMethod(D.orders[7], {}, null).key === 'old_site' &&
    ex.paymentMethod({ status: 'PAID', source: 'node' }, { CreatedVia: 'ADMIN', PaymentMethod: 'UPI' }, null).text === 'Admin order (UPI)');
  ok('unpaid order has no payment method', ex.mapOrder(D.orders[4], ctx).method === '' && ex.mapOrder(D.orders[4], ctx).status === 'Created (not paid)');
  const fRefund = ex.normOrderFilters({ refundKinds: ['UPI'] }, NOW);
  ok('refund kind filter: UPI keeps the UPI refund, drops a paid order; "none" keeps non-refunded', ex.orderPassesJs(o2, fRefund) && !ex.orderPassesJs(o1, fRefund) && ex.orderPassesJs(o1, ex.normOrderFilters({ refundKinds: ['none'] }, NOW)) && !ex.orderPassesJs(o2, ex.normOrderFilters({ refundKinds: ['none'] }, NOW)));
  ok('payment method filter: coins keeps FF1004 only', ex.orderPassesJs(o4, ex.normOrderFilters({ methods: ['coins'] }, NOW)) && !ex.orderPassesJs(o1, ex.normOrderFilters({ methods: ['coins'] }, NOW)));

  section('no secret columns, ever');
  const allHeaders = ex.ORDER_COLUMNS.concat(ex.CUSTOMER_COLUMNS).map((c) => c.header + ' ' + c.key).join(' | ');
  ok('no header / key about passwords, PINs, OTPs, tokens, sessions, logins or push', !/pass|pin\b|otp|token|session|push|login/i.test(allHeaders), allHeaders);
  ok('order columns: every requested column is there, in simple English', ['Order ID', 'Date & time (IST)', 'Customer name', 'Phone', 'Email', 'Service', 'Plan', 'Devices', 'Type (New/Renewal)', 'Price', 'Discount', 'Coupon', 'Coins used', 'Paid amount', 'Payment method', 'UTR / Ref', 'Status', 'Delivery status', 'Account ref (inventory ref)', 'Expiry of the plan', 'Refund kind', 'Refund amount', 'Refund method', 'Credit due', 'Referral code used', 'Notes'].join() === ex.ORDER_COLUMNS.map((c) => c.header).join());
  ok('customer columns: every requested column is there', ['Customer ID', 'Name', 'Phone', 'Email', 'Email verified', 'Member since', 'Total orders (paid)', 'Total spent ₹', 'First order date', 'Last order date', 'Active plans', 'Active plans list', 'Next expiry', 'Coins balance', 'Referral code', 'Referred by', 'Invites joined', 'Refunds', 'Refunds ₹', 'Credit due ₹', 'Removed from account', 'Notes'].join() === ex.CUSTOMER_COLUMNS.map((c) => c.header).join());

  // ==================================================================== 3. xlsx writer
  section('xlsx structure: zip entries, XML, numbers + dates, header, freeze pane, auto-filter');
  ok('CRC32 of "hello" is 0x3610a686', xlsx.crc32(Buffer.from('hello')) === 0x3610a686);
  ok('Excel serial: 2026-09-16 13:45 → 46281.572916…; 1900-03-01 → 61; bad date → null', Math.abs(xlsx.excelSerial('2026-09-16 13:45:00') - (46281 + 13.75 / 24)) < 1e-9 && xlsx.excelSerial('1900-03-01') === 61 && xlsx.excelSerial('2026-02-30') === null && xlsx.excelSerial('soon') === null);
  ok('column letters A, Z, AA, AZ, BA', ['A', 'Z', 'AA', 'AZ', 'BA'].join() === [0, 25, 26, 51, 52].map(xlsx.colName).join());
  const book = xlsx.buildXlsx([
    { name: 'Orders', columns: ex.ORDER_COLUMNS, rows: [o1, o4].map((row) => ex.ORDER_COLUMNS.map((c) => row[c.key])), freeze: true, autoFilter: true },
    { name: 'Summary: [x]?', header: false, columns: [{ header: '', width: 40 }], rows: [[{ v: 'Totals', bold: true }], ['Orders', { v: 2, type: 'int' }]] },
  ]);
  const zf = unzip(book);
  const names = Object.keys(zf);
  ok('zip has [Content_Types].xml, _rels, workbook, 2 sheets, styles, sharedStrings', ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml', 'xl/sharedStrings.xml'].every((n) => names.includes(n)), names);
  ok('every entry is STORE with a correct CRC32', Object.values(zf).every((x) => x.method === 0 && xlsx.crc32(x.data) === x.crc));
  const xmlErrors = names.filter((n) => /\.xml$|\.rels$/.test(n)).map((n) => [n, wellFormed(zf[n].text)]).filter((x) => x[1]);
  ok('every XML part is well-formed', !xmlErrors.length, xmlErrors);
  const s1 = zf['xl/worksheets/sheet1.xml'].text;
  ok('header row frozen (pane ySplit=1, state frozen, top-left A2)', /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/.test(s1));
  ok('auto-filter over the header + data (A1:Z3) and a _FilterDatabase name', /<autoFilter ref="A1:Z3"\/>/.test(s1) && /_xlnm\._FilterDatabase" localSheetId="0" hidden="1">'Orders'!\$A\$1:\$Z\$3</.test(zf['xl/workbook.xml'].text));
  ok('column widths set', /<cols><col min="1" max="1" width="18" customWidth="1"\/>/.test(s1));
  const c1 = sheetCells(zf, 1);
  ok('header cells are bold text (style 1): A1 "Order ID", Z1 "Notes"', c1.A1.t === 's' && c1.A1.s === 1 && c1.A1.v === 'Order ID' && c1.Z1.v === 'Notes');
  ok('B2 date & time is a real Excel date (number, date+time style), 1 Sep 2026 00:00 = 46266', c1.B2.t === 'n' && c1.B2.s === xlsx.STYLE.datetime && c1.B2.v === 46266, c1.B2);
  ok('T2 plan expiry is a date-only cell (12 Oct 2026 = 46307)', c1.T2.t === 'n' && c1.T2.s === xlsx.STYLE.date && c1.T2.v === 46307, c1.T2);
  ok('money cells are numbers with the ₹ format (J2 price 199, N2 paid 179), whole numbers for devices / coins', c1.J2.t === 'n' && c1.J2.v === 199 && c1.J2.s === xlsx.STYLE.money && c1.N2.v === 179 && c1.H2.s === xlsx.STYLE.int && c1.M3.v === 40, { J2: c1.J2, N2: c1.N2, M3: c1.M3 });
  ok('phone stays text (keeps leading digits exactly)', c1.D2.t === 's' && c1.D2.v === '9876543210');
  ok('a formula-looking name is stored as plain text (shared string), never as a formula', c1.C3.t === 's' && c1.C3.v === '=HYPERLINK("http://evil")' && !/<f>/.test(s1));
  ok('emoji + newline + quotes survive in text (Z3)', c1.Z3.v === 'line1\nline2 😀, "ok"', c1.Z3);
  ok('styles: bold font, d mmm yyyy, date+time, ₹ format', /<b\/>/.test(zf['xl/styles.xml'].text) && /formatCode="d mmm yyyy"/.test(zf['xl/styles.xml'].text) && /formatCode="&quot;₹&quot;#,##0.00"/.test(zf['xl/styles.xml'].text));
  ok('sheet name cleaned of [ ] : ? (Excel refuses them)', /<sheet name="Summary   x" sheetId="2"/.test(zf['xl/workbook.xml'].text), zf['xl/workbook.xml'].text.match(/<sheet [^>]*>/g));
  const c2 = sheetCells(zf, 2);
  ok('summary sheet without a header row: A1 bold "Totals", B2 number 2, no freeze/filter', c2.A1.v === 'Totals' && c2.A1.s === xlsx.STYLE.bold && c2.B2.v === 2 && !/<pane|<autoFilter/.test(zf['xl/worksheets/sheet2.xml'].text));
  ok('control characters are stripped so the XML stays valid', !wellFormed(zf['xl/sharedStrings.xml'].text) && xlsx.cleanText('abc') === 'abc' && xlsx.cleanText('x\uD800y') === 'xy');

  section('CSV escaping + formula-injection guard');
  const cols = [{ header: 'Name', type: 'text' }, { header: 'Amount', type: 'money' }, { header: 'When', type: 'datetime' }];
  const csv = xlsx.buildCsv(cols, [
    ['Ravi, "Kumar"', 179, '2026-09-01 00:00:00'],
    ['line1\nline2 😀', -5, ''],
    ['=1+1', 0, null], ['+91 98765', 1.5, null], ['-cmd', null, null], ['@SUM(A1)', null, null], ['\tTab', null, null], ['plain', null, null],
  ]);
  const lines = csv.split('\r\n');
  ok('UTF-8 BOM + CRLF lines + header', csv.charCodeAt(0) === 0xFEFF && lines[0] === '﻿Name,Amount,When');
  ok('comma + quotes → quoted with doubled quotes; numbers plain; date as text YYYY-MM-DD HH:MM', lines[1] === '"Ravi, ""Kumar""",179,2026-09-01 00:00');
  ok('newline + emoji → quoted, emoji kept; negative number is a number, not guarded', csv.includes('"line1\nline2 😀",-5,'));
  ok('= + - @ and tab at the start get a leading apostrophe', csv.includes("'=1+1,0,") && csv.includes("'+91 98765,1.5,") && csv.includes("'-cmd,,") && csv.includes("'@SUM(A1),,") && csv.includes("'\tTab,,") && csv.includes('\r\nplain,,'));

  // ==================================================================== 4. routes on the JOIN-refusing fake DB
  section('admin routes: auth, count, orders xlsx/csv, customers, limit, rate limit, change log');
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: fakeDb, ADMIN_KEY: 'k', sync: require('../sync'), exports: { now: () => NOW } });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const postRaw = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b) });
  const postJson = async (p, b, h) => { const x = await postRaw(p, b, h); return { status: x.status, body: await x.json() }; };

  let res = await postJson('/admin/api/exports/orders', { filters: {} }, { 'Content-Type': 'application/json' });
  ok('no admin sign-in → 403 needLogin', res.status === 403 && res.body.needLogin === true);
  res = await postJson('/admin/api/exports/orders?key=k', { filters: {} }, { 'Content-Type': 'application/json' });
  ok('a key in the URL is not accepted', res.status === 403);
  res = await fetch(base + '/admin/api/exports/options', { headers: H }).then((x) => x.json());
  ok('options: services from orders, limit 50,000, 20 per 10 min', res.ok && res.services.join() === 'Hotstar,Netflix,Prime Video' && res.limit === 50000 && res.rateLimit.max === 20 && res.rateLimit.minutes === 10, res);

  const sepFilters = { date: 'custom', from: '2026-09-01', to: '2026-09-16' };
  res = await postJson('/admin/api/exports/orders/count', { filters: sepFilters, format: 'xlsx' });
  ok('count 1–16 Sep = 5 (1 Sep 00:00 and 16 Sep 23:59:59 in; 31 Aug 23:59:59 and 17 Sep 00:00 out)', res.body.ok && res.body.count === 5 && res.body.exact === true && res.body.fileName === 'FluxFilm-orders-2026-09-01_to_2026-09-16.xlsx', res.body);
  const auditBefore = D.audit.length;
  ok('count check writes nothing to the change log', D.audit.length === auditBefore);

  let x = await postRaw('/admin/api/exports/orders', { filters: sepFilters, format: 'xlsx' });
  const buf = Buffer.from(await x.arrayBuffer());
  ok('xlsx download: content type, attachment file name, row count header', x.status === 200 && /spreadsheetml\.sheet/.test(x.headers.get('content-type')) && x.headers.get('content-disposition') === 'attachment; filename="FluxFilm-orders-2026-09-01_to_2026-09-16.xlsx"' && x.headers.get('x-export-rows') === '5', [x.status, x.headers.get('content-type'), x.headers.get('content-disposition')]);
  const zo = unzip(buf);
  const co = sheetCells(zo, 1);
  const ids = Object.keys(co).filter((k) => /^A\d+$/.test(k) && k !== 'A1').map((k) => co[k].v);
  ok('rows newest first: FF1005, FF1003, FF1004, FF1002, FF1001', ids.join() === 'FF1005,FF1003,FF1004,FF1002,FF1001', ids);
  ok('no secret value anywhere in the file (passwords, login ids, PINs, OTPs, tokens, sessions)', SECRETS.every((sec) => !buf.includes(Buffer.from(sec))), SECRETS.filter((sec) => buf.includes(Buffer.from(sec))));
  const summaryCells = sheetCells(zo, 2);
  const sumText = Object.values(summaryCells).map((c) => c.v).join(' | ');
  ok('Summary sheet: orders 5, paid orders 2, ₹ paid 179 (PAID only), ₹ refunded 129, credit due 100, by service + by status', /Orders in this file \| 5/.test(sumText) && /Paid orders \| 2/.test(sumText) && /₹ paid \(paid orders\) \| 179/.test(sumText) && /₹ refunded \| 129/.test(sumText) && /₹ credit still due \| 100/.test(sumText) && /By service/.test(sumText) && /Netflix \| 2 \| 2 \| 179/.test(sumText) && /By status/.test(sumText) && /keep this file private/.test(sumText), sumText);
  const au = D.audit[D.audit.length - 1];
  const auDetails = JSON.parse(au.details);
  ok('change log: export.orders, file name, "Exported 5 orders (XLSX)", dates, who, filters', au.action === 'export.orders' && au.id === 'FluxFilm-orders-2026-09-01_to_2026-09-16.xlsx' && /^Exported 5 orders \(XLSX\) · 2026-09-01 to 2026-09-16/.test(au.summary) && auDetails.who === 'admin key (script)' && auDetails.rows === 5 && auDetails.filters.range.from === '2026-09-01', au);

  x = await postRaw('/admin/api/exports/orders', { filters: Object.assign({ methods: ['coins'] }, sepFilters), format: 'csv' });
  const csvText = await x.text();
  ok('CSV download with a JS filter (coins): only FF1004, UTF-8 csv, guarded formula name', x.status === 200 && /text\/csv; charset=utf-8/.test(x.headers.get('content-type')) && x.headers.get('x-export-rows') === '1' && /FF1004/.test(csvText) && !/FF1001/.test(csvText) && csvText.includes(`"'=HYPERLINK(""http://evil"")"`) && /\.csv"$/.test(x.headers.get('content-disposition')), csvText.slice(0, 400));

  res = await postJson('/admin/api/exports/orders/count', { filters: { statuses: ['refunded'], refundKinds: ['UPI'] } });
  ok('count with a refund-kind filter is marked "up to" (not exact)', res.body.ok && res.body.count === 1 && res.body.exact === false, res.body);

  section('customers export');
  res = await postJson('/admin/api/exports/customers/count', { filters: {} });
  ok('customers count = 4', res.body.ok && res.body.count === 4, res.body);
  x = await postRaw('/admin/api/exports/customers', { filters: {}, format: 'xlsx' });
  const cbuf = Buffer.from(await x.arrayBuffer());
  // Optional: EXPORT_DUMP_DIR=… saves both files so they can be opened by hand / read back with openpyxl.
  if (process.env.EXPORT_DUMP_DIR) { fs.writeFileSync(path.join(process.env.EXPORT_DUMP_DIR, 'orders.xlsx'), buf); fs.writeFileSync(path.join(process.env.EXPORT_DUMP_DIR, 'customers.xlsx'), cbuf); fs.writeFileSync(path.join(process.env.EXPORT_DUMP_DIR, 'orders.csv'), csvText); }
  const zc = unzip(cbuf); const cc = sheetCells(zc, 1);
  const colOf = (h) => xlsx.colName(ex.CUSTOMER_COLUMNS.findIndex((c) => c.header === h));
  const rowOf = (id) => { const k = Object.keys(cc).find((kk) => /^A\d+$/.test(kk) && cc[kk].v === id); return k ? k.slice(1) : null; };
  const cell = (id, h) => { const c = cc[colOf(h) + rowOf(id)]; return c ? c.v : undefined; };
  ok('file name FluxFilm-customers-all_to_2026-09-16.xlsx, 4 rows', x.headers.get('x-export-filename') === 'FluxFilm-customers-all_to_2026-09-16.xlsx' && x.headers.get('x-export-rows') === '4');
  ok('Ravi: verified email, member since (date cell), 3 paid orders, ₹578 spent, first 31 Aug / last 12 Sep', cell('C001', 'Email verified') === 'Yes' && cc[colOf('Member since') + rowOf('C001')].s === xlsx.STYLE.date && cell('C001', 'Total orders (paid)') === 3 && cell('C001', 'Total spent ₹') === 578 && cell('C001', 'First order date') === xlsx.excelSerial('2026-08-31') && cell('C001', 'Last order date') === xlsx.excelSerial('2026-09-12'), [cell('C001', 'Email verified'), cell('C001', 'Total spent ₹')]);
  ok('Ravi: 1 active plan "Netflix Sharing 1M till 12 Oct", next expiry 12 Oct, coins 30 (wallet row with most lifetime coins)', cell('C001', 'Active plans') === 1 && cell('C001', 'Active plans list') === 'Netflix Sharing 1M till 12 Oct' && cell('C001', 'Next expiry') === xlsx.excelSerial('2026-10-12') && cell('C001', 'Coins balance') === 30, cell('C001', 'Active plans list'));
  ok('Ravi: referral code RAVI10, 1 invite joined, notes VIP', cell('C001', 'Referral code') === 'RAVI10' && cell('C001', 'Invites joined') === 1 && cell('C001', 'Notes') === 'VIP');
  ok('Priya: referred by "Ravi · 9876543210 (code RAVI10)", 1 refund ₹129, credit due ₹100, removed 1, no email → verified blank', cell('C002', 'Referred by') === 'Ravi · 9876543210 (code RAVI10)' && cell('C002', 'Refunds') === 1 && cell('C002', 'Refunds ₹') === 129 && cell('C002', 'Credit due ₹') === 100 && cell('C002', 'Removed from account') === 1 && cell('C002', 'Email verified') === undefined, [cell('C002', 'Referred by'), cell('C002', 'Credit due ₹')]);
  ok('Old Timer: email used on a paid order before the flag existed → "Yes (paid order)"; expired plan → 0 active', cell('C004', 'Email verified') === 'Yes (paid order)' && cell('C004', 'Active plans') === 0);
  ok('no secret value in the customers file', SECRETS.every((sec) => !cbuf.includes(Buffer.from(sec))), SECRETS.filter((sec) => cbuf.includes(Buffer.from(sec))));
  const csum = Object.values(sheetCells(zc, 2)).map((c) => c.v).join(' | ');
  ok('customers Summary: 4 customers, 2 with an active plan, 1 never bought', /Customers in this file \| 4/.test(csum) && /With an active plan \| 2/.test(csum) && /Never bought \| 1/.test(csum), csum);
  const auc = D.audit[D.audit.length - 1];
  ok('change log: export.customers with row count', auc.action === 'export.customers' && /^Exported 4 customers \(XLSX\)/.test(auc.summary));

  const idsFor = async (filters) => { const t = await (await postRaw('/admin/api/exports/customers', { filters, format: 'csv' })).text(); return t.split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[0]).join(); };
  ok('filter: has active plan → Ravi, Priya', (await idsFor({ planState: 'active' })) === 'C002,C001');
  ok('filter: expired only → Old Timer', (await idsFor({ planState: 'expired' })) === 'C004');
  ok('filter: never bought → the customer with only an unpaid order', (await idsFor({ planState: 'never' })) === 'C003');
  ok('filter: service used Hotstar → Priya (expired Hotstar sub), not the unpaid Hotstar order', (await idsFor({ services: ['Hotstar'] })) === 'C002');
  const spent300 = await idsFor({ minSpent: '300' });
  ok('filter: total spent ≥ ₹300 → Ravi (₹578), not Old Timer (₹278)', spent300 === 'C001', spent300);
  ok('filter: total spent ≥ ₹200 → Ravi + Old Timer', (await idsFor({ minSpent: '200' })) === 'C001,C004');
  ok('filter: joined this month + no email → Priya', (await idsFor({ date: 'this_month', hasEmail: 'no' })) === 'C002');

  section('limits');
  const app2 = express(); app2.use(express.json());
  const audit2 = [];
  ex.mount(app2, { db: fakeDb, auth: () => true, audit: { record: (req, e) => audit2.push(e) }, now: () => NOW, maxRows: 3, limiter: security.rateLimiter(4, 600000) });
  const server2 = app2.listen(0); await new Promise((r2) => server2.once('listening', r2));
  const base2 = 'http://127.0.0.1:' + server2.address().port;
  const p2 = async (p, b) => { const y = await fetch(base2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: y.status, type: y.headers.get('content-type'), body: /json/.test(y.headers.get('content-type')) ? await y.json() : null }; };
  let lim = await p2('/admin/api/exports/orders', { filters: sepFilters });
  ok('over the row limit → 413 JSON "5 orders match — one file can hold at most 3. Pick a shorter date range…", no file, no log', lim.status === 413 && lim.body.tooMany && /^5 orders match — one file can hold at most 3\. Pick a shorter date range/.test(lim.body.message) && !audit2.length, lim.body);
  lim = await p2('/admin/api/exports/orders/count', { filters: sepFilters });
  ok('count says tooMany too (dialog warns before downloading)', lim.body.tooMany === true && lim.body.limit === 3);
  for (let k = 0; k < 3; k++) await p2('/admin/api/exports/customers', { filters: { planState: 'active' } });
  lim = await p2('/admin/api/exports/customers', { filters: { planState: 'active' } });
  ok('rate limit: the 5th export in 10 minutes → 429 "Too many exports — at most 20 every 10 minutes"', lim.status === 429 && /Too many exports — at most 20 every 10 minutes/.test(lim.body.message), lim);
  ok('real limits: 50,000 rows, 20 exports', ex.MAX_ROWS === 50000 && ex.RATE_MAX === 20);

  ok('every export SQL was single-table (no JOIN) and never selected secrets or *', D.sql.length > 20 && !D.sql.some((q) => /\bJOIN\b/i.test(q)) && !D.sql.some((q) => /password|login_id|profile_pin|access_token|push_subscriptions|SELECT \*/i.test(q)), D.sql.filter((q) => /password|login_id|SELECT \*/i.test(q)));

  // ==================================================================== 5. admin page wiring
  section('admin page: buttons, dialog, download via fetch + Blob, menu, scripts parse');
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok('admin.js mounts adminexports with the admin auth + change log', /require\('\.\/adminexports'\)\.mount\(app, Object\.assign\(\{ db, auth, audit \}, deps\.exports \|\| \{\}\)\);/.test(adminJs));
  ok('Orders page: ⬇️ Export to Excel uses the filters on screen (search + view)', /id="oexport" onclick="exOrdersDialog\(\{ q: O\.q, view: O\.view \}\)">⬇️ Export to Excel</.test(html));
  ok('Customer 360: ⬇️ Export customers', /id="cexport" onclick="exCustomersDialog\(\{\}\)">⬇️ Export customers</.test(html));
  ok('📤 Exports menu item + screen added in the export block (menu line untouched)', /MENU\.splice\(at >= 0 \? at : MENU\.length, 0, \['exports', '📤', 'Exports'\]\)/.test(html) && /m\.exports = exportsView/.test(html) && /function exportsView\(/.test(html) && !/\['exports', '📤', 'Exports'\], \['/.test(html));
  const exBlock = html.slice(html.indexOf('/* ================= 📤 exports'));
  ok('download = fetch POST with the session cookie + Blob + object URL + <a download>; no key in the page or URL', /credentials: 'same-origin'/.test(exBlock) && /r\.blob\(\)/.test(exBlock) && /URL\.createObjectURL\(blob\)/.test(exBlock) && /a\.download = name/.test(exBlock) && !/X-Admin-Key|key=|fluxfilm2026/i.test(exBlock));
  ok('dialog filters: dates (today…last month, custom), status, type, service, plan, payment, delivery, coupon, refund, search, format', ['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'custom'].every((p) => exBlock.includes("['" + p + "'")) && ['exo_st', 'exo_type', 'exo_svc', 'exo_plan', 'exo_pm', 'exo_dl', 'exo_cpn', 'exo_rf', 'exo_q', 'exo_fmt'].every((id) => exBlock.includes("'" + id + "'") || exBlock.includes('id="' + id + '"')) && /📄 CSV \(UTF-8\)/.test(exBlock));
  ok('customer dialog filters: joined, active/expired/never, service, email, min spent, search', ['exc_date', 'exc_plan', 'exc_svc', 'exc_em', 'exc_min', 'exc_q'].every((id) => exBlock.includes(id)) && /'never', 'Never bought'/.test(exBlock));
  ok('privacy note on the dialog', /Contains customer phone numbers and emails — keep this file private\./.test(exBlock));
  ok('Orders view mapping: unpaid → created, not delivered → paid + failed/pending, manual, today, last 7 days', /v === 'unpaid' \? \['created'\]/.test(exBlock) && /v === 'manual' \? \['manual'\]/.test(exBlock) && /v === 'week' \? 'last7'/.test(exBlock));
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]).filter((y) => y.trim());
  let parsed = true;
  for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every inline script parses', scripts.length > 0 && parsed);
  // Run the menu/viewMap patch against a fake MENU.
  const patch = exBlock.slice(0, exBlock.indexOf('var EX_PRIVATE'));
  const env = new Function('MENU', 'viewMap', 'exportsView', patch.replace('/* ================= 📤 exports', '/*') + '\nreturn { MENU: MENU, viewMap: viewMap };')([['DATA'], ['data', '📋', 'Sheets'], ['audit', '🕘', 'Change log']], () => ({ today: 1 }), 'EXPORTS');
  ok('menu patch puts 📤 Exports just before 🕘 Change log and viewMap still has the old screens', env.MENU.map((mm) => mm[0]).join() === 'DATA,data,exports,audit' && env.viewMap().today === 1 && env.viewMap().exports === 'EXPORTS', env.MENU);

  const pkg = require('../package.json');
  ok('this test is in npm test', /node test\/admin-exports\.test\.js/.test(pkg.scripts.test));
  ok('no new npm dependency (writer is built in)', !pkg.dependencies.exceljs && !pkg.dependencies.xlsx);

  for (const sv of [server, server2]) { if (sv.closeAllConnections) sv.closeAllConnections(); await new Promise((r3) => sv.close(r3)); }
  console.log('\n---------------------------------------');
  console.log('admin-exports: PASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exit(1); });
