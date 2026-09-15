/**
 * FluxFilm - 📤 admin exports: orders list and customer profiles to Excel (.xlsx) or CSV (owner request 16 Sep 2026:
 * "export orders list with filters in Excel, and customers profiles also").
 *
 * Routes (admin-only, mounted by admin.js — session cookie from /panel, or X-Admin-Key for scripts; never a key in URLs):
 *   GET  /admin/api/exports/options           services / plans for the dialog, limits
 *   POST /admin/api/exports/orders/count      { filters }                → { ok, count, limit }
 *   POST /admin/api/exports/orders            { filters, format }        → .xlsx / .csv file (or JSON { ok:false })
 *   POST /admin/api/exports/customers/count   { filters }
 *   POST /admin/api/exports/customers         { filters, format }
 *
 * Safety:
 *   - At most MAX_ROWS rows (default 50,000): over that nothing is built and a clear message says to narrow the dates.
 *   - 20 exports per 10 minutes (counts only real downloads, not the "how many rows?" check).
 *   - Every download is written to the change log (export.orders / export.customers: filters, row count, format).
 *   - Only the columns listed below are ever written. No passwords, login ids, PINs, OTPs, tokens, sessions or push
 *     subscriptions: those columns are never SELECTed.
 *
 * SQL: one table per statement (live lesson: mixed collations across old/new tables) — rows are matched in JS.
 * Dates in MySQL are India wall-clock time (dateStrings), so date filters are plain 'YYYY-MM-DD 00:00:00' bounds.
 */
const xlsx = require('./xlsx');
const renewRules = require('./renewrules');
const refunds = require('./refunds');
const credit = require('./credit');
const security = require('./security');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const round2 = (n) => Math.round(num(n) * 100) / 100;
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const unknownColumn = (e) => /Unknown column|ER_BAD_FIELD_ERROR/i.test(String(e && e.message));
const asList = (v) => (Array.isArray(v) ? v : s(v) ? s(v).split(',') : []).map(s).filter(Boolean);

const MAX_ROWS = 50000;
const PAGE = 2000;
const CHUNK = 500;
const RATE_MAX = 20;
const RATE_WINDOW_MS = 10 * 60e3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

// ------------------------------------------------------------------ dates (India)
const nowMs = (now) => (now == null ? Date.now() : now instanceof Date ? now.getTime() : Number(now));
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const validYmd = (v) => { const t = s(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return ''; const ms = Date.parse(t + 'T00:00:00Z'); return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === t ? t : ''; };
/** India 'YYYY-MM-DD HH:MM:SS' for now. */
function istNowText(now) { return new Date(nowMs(now) + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' '); }
const DATE_PRESETS = ['all', 'today', 'yesterday', 'this_week', 'last7', 'this_month', 'last_month', 'custom'];
/**
 * A date choice → { preset, from, to } (India dates, both inclusive; '' = open). The SQL uses
 * col >= 'from 00:00:00' AND col < 'to+1 00:00:00', so a whole last day (up to 23:59:59) is included.
 * Weeks start on Monday.
 */
function dateRange(preset, from, to, now) {
  const p = DATE_PRESETS.includes(s(preset)) ? s(preset) : (validYmd(from) || validYmd(to) ? 'custom' : 'all');
  const today = renewRules.istYmd(nowMs(now));
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0 Sunday
  const monthStart = today.slice(0, 8) + '01';
  switch (p) {
    case 'today': return { preset: p, from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { preset: p, from: y, to: y }; }
    case 'this_week': return { preset: p, from: addDays(today, -((dow + 6) % 7)), to: today };
    case 'last7': return { preset: p, from: addDays(today, -6), to: today };
    case 'this_month': return { preset: p, from: monthStart, to: today };
    case 'last_month': { const end = addDays(monthStart, -1); return { preset: p, from: end.slice(0, 8) + '01', to: end }; }
    case 'custom': {
      let f = validYmd(from); let t = validYmd(to);
      if (f && t && f > t) { const x = f; f = t; t = x; }
      return { preset: p, from: f, to: t };
    }
    default: return { preset: 'all', from: '', to: '' };
  }
}
function addDateSql(col, range, where, params) {
  if (range.from) { where.push(col + ' >= ?'); params.push(range.from + ' 00:00:00'); }
  if (range.to) { where.push(col + ' < ?'); params.push(addDays(range.to, 1) + ' 00:00:00'); }
}
function fileName(kind, range, format, now) {
  const today = renewRules.istYmd(nowMs(now));
  const span = range.from || range.to ? (range.from || 'start') + '_to_' + (range.to || today) : 'all_to_' + today;
  return 'FluxFilm-' + kind + '-' + span + '.' + (format === 'csv' ? 'csv' : 'xlsx');
}
/** '2026-10-12 10:00:00' → '12 Oct' (same year) / '12 Oct 2027'. */
function shortDate(v, now) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return '';
  const year = renewRules.istYmd(nowMs(now)).slice(0, 4);
  return (+m[3]) + ' ' + MONTHS[+m[2] - 1] + (m[1] === year ? '' : ' ' + m[1]);
}

// ------------------------------------------------------------------ orders: filters
const STATUS_GROUPS = {
  paid: ['PAID', 'FULFILLED'], created: ['CREATED'], pending: ['PENDING', 'PENDING_PAYMENT', 'VERIFYING'],
  credit: ['CREDIT'], written_off: ['WRITTEN_OFF'], refunded: ['REFUNDED'], failed: ['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'ERROR'],
};
const METHODS = {
  upi_auto: 'UPI (auto-matched)', utr: 'UTR typed by customer', backup_claim: 'Backup UPI claim', coins: 'Coins',
  zero: '₹0 (coupon / refund credit)', credit: 'On credit (pay later)', admin: 'Admin order', old_site: 'Old site',
};
const DELIVERY = { fulfilled: ['FULFILLED'], manual: ['MANUAL_PENDING'], failed: ['FAILED', 'ERROR'], pending: ['PENDING', ''] };
const REFUND_KINDS = ['any', 'none', 'UPI', 'UPI_PENDING', 'CREDIT', 'COUPON', 'OTHER'];

function normOrderFilters(f, now) {
  f = f || {};
  const pick = (list, allowed) => [...new Set(asList(list).map((x) => x.toLowerCase()))].filter((x) => allowed.includes(x));
  return {
    range: dateRange(f.date || f.preset, f.from, f.to, now),
    statuses: pick(f.statuses || f.status, Object.keys(STATUS_GROUPS)),
    types: pick(f.types || f.type, ['new', 'renewal']),
    services: [...new Set(asList(f.services || f.service))].slice(0, 50),
    plan: s(f.plan).slice(0, 120),
    methods: pick(f.methods || f.method, Object.keys(METHODS)),
    delivery: pick(f.delivery, Object.keys(DELIVERY)),
    hasCoupon: ['yes', 'no'].includes(s(f.hasCoupon).toLowerCase()) ? s(f.hasCoupon).toLowerCase() : '',
    refundKinds: [...new Set(asList(f.refundKinds || f.refundKind))].map((x) => (x.toLowerCase() === 'any' || x.toLowerCase() === 'none' ? x.toLowerCase() : x.toUpperCase())).filter((x) => REFUND_KINDS.includes(x)),
    q: s(f.q).slice(0, 80),
  };
}
/** SQL on the orders table only (payment method + refund kind are worked out in JS from raw_json). */
function orderWhere(f) {
  const where = []; const params = [];
  addDateSql('created_at_sheet', f.range, where, params);
  if (f.statuses.length) {
    const list = [].concat(...f.statuses.map((k) => STATUS_GROUPS[k]));
    where.push('UPPER(status) IN (' + list.map(() => '?').join(', ') + ')'); params.push(...list);
  }
  if (f.types.length === 1) where.push(f.types[0] === 'renewal' ? "UPPER(COALESCE(order_type, '')) = 'RENEW'" : "UPPER(COALESCE(order_type, '')) <> 'RENEW'");
  if (f.services.length) { where.push('service IN (' + f.services.map(() => '?').join(', ') + ')'); params.push(...f.services); }
  if (f.plan) { where.push('plan = ?'); params.push(f.plan); }
  if (f.delivery.length) {
    const list = [].concat(...f.delivery.map((k) => DELIVERY[k]));
    where.push("UPPER(COALESCE(fulfillment_status, '')) IN (" + list.map(() => '?').join(', ') + ')'); params.push(...list);
  }
  if (f.hasCoupon === 'yes') where.push("COALESCE(coupon_code, '') <> ''");
  if (f.hasCoupon === 'no') where.push("COALESCE(coupon_code, '') = ''");
  if (f.refundKinds.length && !f.refundKinds.includes('none')) where.push("UPPER(status) = 'REFUNDED'");
  if (f.q) {
    const like = '%' + f.q + '%'; const digits = f.q.replace(/\D/g, '');
    where.push('(order_id LIKE ? OR name LIKE ? OR email LIKE ? OR txn_ref LIKE ? OR phone_norm LIKE ?)');
    params.push(like, like, like, like, digits.length >= 3 ? '%' + digits + '%' : '__no_match__');
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

// ------------------------------------------------------------------ orders: columns
const ORDER_COLUMNS = [
  { key: 'orderId', header: 'Order ID', type: 'text', width: 18 },
  { key: 'createdAt', header: 'Date & time (IST)', type: 'datetime', width: 20 },
  { key: 'name', header: 'Customer name', type: 'text', width: 22 },
  { key: 'phone', header: 'Phone', type: 'text', width: 14 },
  { key: 'email', header: 'Email', type: 'text', width: 28 },
  { key: 'service', header: 'Service', type: 'text', width: 18 },
  { key: 'plan', header: 'Plan', type: 'text', width: 22 },
  { key: 'devices', header: 'Devices', type: 'int', width: 9 },
  { key: 'type', header: 'Type (New/Renewal)', type: 'text', width: 12 },
  { key: 'price', header: 'Price', type: 'money', width: 11 },
  { key: 'discount', header: 'Discount', type: 'money', width: 11 },
  { key: 'coupon', header: 'Coupon', type: 'text', width: 14 },
  { key: 'coinsUsed', header: 'Coins used', type: 'int', width: 10 },
  { key: 'paid', header: 'Paid amount', type: 'money', width: 12 },
  { key: 'method', header: 'Payment method', type: 'text', width: 24 },
  { key: 'ref', header: 'UTR / Ref', type: 'text', width: 20 },
  { key: 'status', header: 'Status', type: 'text', width: 16 },
  { key: 'delivery', header: 'Delivery status', type: 'text', width: 18 },
  { key: 'accountRef', header: 'Account ref (inventory ref)', type: 'text', width: 22 },
  { key: 'expiry', header: 'Expiry of the plan', type: 'date', width: 14 },
  { key: 'refundKind', header: 'Refund kind', type: 'text', width: 14 },
  { key: 'refundAmount', header: 'Refund amount', type: 'money', width: 12 },
  { key: 'refundMethod', header: 'Refund method', type: 'text', width: 14 },
  { key: 'creditDue', header: 'Credit due', type: 'money', width: 11 },
  { key: 'referralCode', header: 'Referral code used', type: 'text', width: 14 },
  { key: 'notes', header: 'Notes', type: 'text', width: 40 },
];
const STATUS_TEXT = { PAID: 'Paid', FULFILLED: 'Paid', CREATED: 'Created (not paid)', PENDING: 'Pending', CREDIT: 'On credit', WRITTEN_OFF: 'Credit written off', REFUNDED: 'Refunded', FAILED: 'Failed', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const DELIVERY_TEXT = { FULFILLED: 'Delivered', MANUAL_PENDING: 'Manual — to activate', FAILED: 'Failed', ERROR: 'Failed', PENDING: 'Pending' };
const REFUND_KIND_TEXT = { UPI: 'UPI', UPI_PENDING: 'UPI (waiting for customer)', CREDIT: 'Refund credit / coins', COUPON: 'Coupon', OTHER: 'Other' };

/** How the order was paid → { key (filter), text }. claim = the MATCHED payment_claims row for it, if any. */
function paymentMethod(o, raw, claim) {
  const st = up(o.status);
  const pm = up(raw.PaymentMethod);
  if (st === 'CREDIT' || st === 'WRITTEN_OFF' || raw.Credit === true) {
    return { key: 'credit', text: st === 'CREDIT' ? 'On credit (pay later)' : st === 'WRITTEN_OFF' ? 'On credit (written off)' : 'On credit, paid later' + (pm && pm !== 'CREDIT' ? ' (' + pm + ')' : '') };
  }
  if (up(raw.CreatedVia) === 'ADMIN') return { key: 'admin', text: 'Admin order' + (pm ? ' (' + pm + ')' : '') };
  if (/^CREDIT-/i.test(s(o.txn_ref)) || raw.FreeConfirmedAt) {
    if (/COINS/.test(pm)) return { key: 'coins', text: 'Coins' + (/CREDIT/.test(pm) ? ' + refund credit' : '') + (/COUPON/.test(pm) ? ' + coupon' : '') };
    return { key: 'zero', text: '₹0 (' + (/CREDIT/.test(pm) ? 'refund credit' : /COUPON/.test(pm) ? 'coupon' : 'discount') + ')' };
  }
  if (claim) return claim.utr ? { key: 'utr', text: 'UTR typed by customer' } : { key: 'backup_claim', text: 'Backup UPI claim' + (up(claim.source) === 'ADMIN' ? ' (admin)' : '') };
  if (s(o.source) && s(o.source) !== 'node') return { key: 'old_site', text: 'Old site' };
  if (!['PAID', 'FULFILLED', 'REFUNDED'].includes(st)) return { key: '', text: '' };
  if (num(raw.CoinsUsed) > 0 && num(o.final_amount) <= 0) return { key: 'coins', text: 'Coins' };
  return { key: 'upi_auto', text: 'UPI (auto-matched)' };
}

/** One order row → the export row object (keys of ORDER_COLUMNS) + hidden fields used by filters/summary. */
function mapOrder(o, ctx) {
  ctx = ctx || {};
  const raw = rawOf(o.raw_json);
  const st = up(o.status);
  const claim = ctx.claims && ctx.claims.get(s(o.order_id));
  const m = paymentMethod(o, raw, claim);
  const subs = (ctx.subsByOrder && ctx.subsByOrder.get(s(o.order_id))) || [];
  const renewed = s(o.renew_sub_id) && ctx.subsById ? ctx.subsById.get(s(o.renew_sub_id)) : null;
  const allSubs = subs.length ? subs : renewed ? [renewed] : [];
  const expiry = allSubs.map((x) => s(x.expiry_date)).filter(Boolean).sort().pop() || '';
  const refs = [...new Set(allSubs.map((x) => s(x.inventory_ref)).filter(Boolean))].join(', ');
  const rf = st === 'REFUNDED' ? refunds.refundInfo(o) : null;
  const cs = st === 'CREDIT' || st === 'WRITTEN_OFF' || raw.Credit === true ? credit.creditState(o, ctx.now) : null;
  const paid = ['PAID', 'FULFILLED', 'REFUNDED'].includes(st) ? round2(o.final_amount) : cs ? cs.paid : 0;
  const notes = [s(o.notes), s(raw.AdminNote) && s(raw.AdminNote) !== s(o.notes) ? 'Admin note: ' + s(raw.AdminNote) : ''].filter(Boolean).join(' · ');
  return {
    orderId: s(o.order_id), createdAt: s(o.created_at_sheet), name: s(o.name), phone: s(o.phone_norm) || s(o.phone), email: s(o.email),
    service: s(o.service), plan: s(o.plan), devices: o.device_count == null || o.device_count === '' ? 1 : Math.max(1, Math.round(num(o.device_count))),
    type: up(o.order_type) === 'RENEW' ? 'Renewal' : 'New',
    price: round2(o.price), discount: round2(o.discount), coupon: s(o.coupon_code), coinsUsed: Math.round(num(raw.CoinsUsed)) || 0,
    paid, method: m.text, ref: claim && claim.utr ? s(claim.utr) : s(o.txn_ref), status: STATUS_TEXT[st] || s(o.status),
    delivery: DELIVERY_TEXT[up(o.fulfillment_status)] || s(o.fulfillment_status), accountRef: refs, expiry,
    refundKind: rf ? (REFUND_KIND_TEXT[rf.kind] || rf.kind) : '', refundAmount: rf ? rf.amount : '', refundMethod: rf ? rf.method : '',
    creditDue: cs && st === 'CREDIT' ? cs.due : '', referralCode: s(raw.ReferralCode), notes,
    _methodKey: m.key, _refundKind: rf ? rf.kind : '', _status: st, _amount: round2(o.final_amount),
  };
}
function orderPassesJs(row, f) {
  if (f.methods.length && !f.methods.includes(row._methodKey)) return false;
  if (f.refundKinds.length) {
    const wantNone = f.refundKinds.includes('none'); const wantAny = f.refundKinds.includes('any');
    const k = row._refundKind;
    if (!k) return wantNone;
    if (!wantAny && !f.refundKinds.includes(k)) return false;
  }
  return true;
}
function ordersSummary(rows, f, now) {
  const paidSt = ['PAID', 'FULFILLED'];
  const tot = { n: rows.length, paidN: 0, paid: 0, refunded: 0, creditDue: 0 };
  const bySvc = new Map(); const bySt = new Map();
  for (const r of rows) {
    const isPaid = paidSt.includes(r._status);
    if (isPaid) { tot.paidN++; tot.paid += r._amount; }
    if (r.refundAmount !== '') tot.refunded += num(r.refundAmount);
    if (r.creditDue !== '') tot.creditDue += num(r.creditDue);
    const a = bySvc.get(r.service || '(none)') || { n: 0, paidN: 0, paid: 0 }; a.n++; if (isPaid) { a.paidN++; a.paid += r._amount; } bySvc.set(r.service || '(none)', a);
    const b = bySt.get(r.status || '(none)') || { n: 0, amount: 0 }; b.n++; b.amount += r._amount; bySt.set(r.status || '(none)', b);
  }
  const B = (v) => ({ v, bold: true });
  const out = [
    [B('FluxFilm orders export'), ''],
    ['Made on (IST)', { v: istNowText(now), type: 'datetime' }],
    ['Dates', f.range.from || f.range.to ? (f.range.from || 'start') + ' to ' + (f.range.to || 'today') : 'All dates'],
    ['Filters', filterText('orders', f)],
    ['⚠️ Contains customer phone numbers and emails — keep this file private.', ''],
    [],
    [B('Totals'), ''],
    ['Orders in this file', { v: tot.n, type: 'int' }],
    ['Paid orders', { v: tot.paidN, type: 'int' }],
    ['₹ paid (paid orders)', { v: round2(tot.paid), type: 'money' }],
    ['₹ refunded', { v: round2(tot.refunded), type: 'money' }],
    ['₹ credit still due', { v: round2(tot.creditDue), type: 'money' }],
    [],
    [B('By service'), B('Orders'), B('Paid orders'), B('₹ paid')],
  ];
  [...bySvc.entries()].sort((a, b) => b[1].paid - a[1].paid || b[1].n - a[1].n).forEach(([k, v]) => out.push([k, { v: v.n, type: 'int' }, { v: v.paidN, type: 'int' }, { v: round2(v.paid), type: 'money' }]));
  out.push([], [B('By status'), B('Orders'), B('₹ amount')]);
  [...bySt.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => out.push([k, { v: v.n, type: 'int' }, { v: round2(v.amount), type: 'money' }]));
  return { rows: out, totals: { orders: tot.n, paidOrders: tot.paidN, paid: round2(tot.paid) } };
}

// ------------------------------------------------------------------ customers: filters + columns
function normCustomerFilters(f, now) {
  f = f || {};
  const minSpent = num(f.minSpent);
  return {
    range: dateRange(f.date || f.preset, f.from, f.to, now),
    planState: ['active', 'expired', 'never'].includes(s(f.planState).toLowerCase()) ? s(f.planState).toLowerCase() : '',
    services: [...new Set(asList(f.services || f.service))].slice(0, 50),
    hasEmail: ['yes', 'no'].includes(s(f.hasEmail).toLowerCase()) ? s(f.hasEmail).toLowerCase() : '',
    minSpent: minSpent > 0 ? minSpent : 0,
    q: s(f.q).slice(0, 80),
  };
}
function customerWhere(f) {
  const where = []; const params = [];
  addDateSql('member_since', f.range, where, params);
  if (f.hasEmail === 'yes') where.push("COALESCE(email, '') <> ''");
  if (f.hasEmail === 'no') where.push("COALESCE(email, '') = ''");
  if (f.q) {
    const like = '%' + f.q + '%'; const digits = f.q.replace(/\D/g, '');
    where.push('(name LIKE ? OR email LIKE ? OR customer_id LIKE ? OR phone_norm LIKE ?)');
    params.push(like, like, like, digits.length >= 3 ? '%' + digits + '%' : '__no_match__');
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}
const CUSTOMER_COLUMNS = [
  { key: 'customerId', header: 'Customer ID', type: 'text', width: 14 },
  { key: 'name', header: 'Name', type: 'text', width: 22 },
  { key: 'phone', header: 'Phone', type: 'text', width: 14 },
  { key: 'email', header: 'Email', type: 'text', width: 28 },
  { key: 'emailVerified', header: 'Email verified', type: 'text', width: 12 },
  { key: 'memberSince', header: 'Member since', type: 'date', width: 14 },
  { key: 'orders', header: 'Total orders (paid)', type: 'int', width: 10 },
  { key: 'spent', header: 'Total spent ₹', type: 'money', width: 12 },
  { key: 'firstOrder', header: 'First order date', type: 'date', width: 14 },
  { key: 'lastOrder', header: 'Last order date', type: 'date', width: 14 },
  { key: 'activeCount', header: 'Active plans', type: 'int', width: 8 },
  { key: 'activeList', header: 'Active plans list', type: 'text', width: 44 },
  { key: 'nextExpiry', header: 'Next expiry', type: 'date', width: 14 },
  { key: 'coins', header: 'Coins balance', type: 'int', width: 10 },
  { key: 'referralCode', header: 'Referral code', type: 'text', width: 13 },
  { key: 'referredBy', header: 'Referred by', type: 'text', width: 24 },
  { key: 'invites', header: 'Invites joined', type: 'int', width: 9 },
  { key: 'refundsCount', header: 'Refunds', type: 'int', width: 8 },
  { key: 'refundsAmount', header: 'Refunds ₹', type: 'money', width: 11 },
  { key: 'creditDue', header: 'Credit due ₹', type: 'money', width: 11 },
  { key: 'removedCount', header: 'Removed from account', type: 'int', width: 10 },
  { key: 'notes', header: 'Notes', type: 'text', width: 34 },
];

function filterText(kind, f) {
  const parts = [];
  if (kind === 'orders') {
    if (f.statuses.length) parts.push('status ' + f.statuses.join('/'));
    if (f.types.length === 1) parts.push(f.types[0]);
    if (f.services.length) parts.push('service ' + f.services.join('/'));
    if (f.plan) parts.push('plan ' + f.plan);
    if (f.methods.length) parts.push('payment ' + f.methods.join('/'));
    if (f.delivery.length) parts.push('delivery ' + f.delivery.join('/'));
    if (f.hasCoupon) parts.push('coupon ' + f.hasCoupon);
    if (f.refundKinds.length) parts.push('refund ' + f.refundKinds.join('/'));
  } else {
    if (f.planState) parts.push(f.planState === 'active' ? 'has active plan' : f.planState === 'expired' ? 'expired only' : 'never bought');
    if (f.services.length) parts.push('used ' + f.services.join('/'));
    if (f.hasEmail) parts.push(f.hasEmail === 'yes' ? 'has email' : 'no email');
    if (f.minSpent) parts.push('spent ≥ ₹' + f.minSpent);
  }
  if (f.q) parts.push('search "' + f.q + '"');
  return parts.join(' · ') || 'none';
}

// ------------------------------------------------------------------ module
function mount(app, deps) {
  const { auth } = deps;
  const q = (sql, p) => deps.db.query(sql, p || []);
  const audit = deps.audit || { record: () => {} };
  const maxRows = deps.maxRows || MAX_ROWS;
  const limiter = deps.limiter || security.rateLimiter(RATE_MAX, RATE_WINDOW_MS);
  const now = () => (deps.now ? deps.now() : Date.now());
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const chunks = (list) => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };
  const inList = (n) => '(' + new Array(n).fill('?').join(', ') + ')';
  const tooMany = (n, what) => ({ ok: false, tooMany: true, count: n, limit: maxRows, message: n.toLocaleString('en-IN') + ' ' + what + ' match — one file can hold at most ' + maxRows.toLocaleString('en-IN') + '. Pick a shorter date range or add a filter.' });
  const who = (req) => (req.headers && req.headers['x-admin-key'] ? 'admin key (script)' : 'admin panel sign-in');

  async function optional(sql, p) {
    try { return await q(sql, p); } catch (e) { if (missingTable(e)) return []; throw e; }
  }

  // ---------------- orders
  async function countOrders(f) {
    const w = orderWhere(f);
    const r = await q('SELECT COUNT(*) AS n FROM orders' + w.sql, w.params);
    return Math.round(num((r[0] || {}).n));
  }
  async function loadOrders(f) {
    const w = orderWhere(f);
    const cols = 'order_id, created_at_sheet, name, email, phone, phone_norm, service, plan, price, discount, coupon_code, final_amount, status, fulfillment_status, order_type, renew_sub_id, txn_ref, notes, device_count, source, raw_json';
    const orders = [];
    for (let off = 0; ; off += PAGE) {
      const page = await q('SELECT ' + cols + ' FROM orders' + w.sql + ' ORDER BY created_at_sheet DESC, order_id DESC LIMIT ? OFFSET ?', [...w.params, PAGE, off]);
      orders.push(...page);
      if (page.length < PAGE || orders.length > maxRows) break;
    }
    const ids = orders.map((o) => s(o.order_id));
    const renewIds = [...new Set(orders.map((o) => s(o.renew_sub_id)).filter(Boolean))];
    const subsByOrder = new Map(); const subsById = new Map(); const claims = new Map();
    for (const part of chunks(ids)) {
      const subs = await q('SELECT sub_id, order_id, expiry_date, inventory_ref FROM subscriptions WHERE order_id IN ' + inList(part.length), part);
      for (const x of subs) { const k = s(x.order_id); if (!subsByOrder.has(k)) subsByOrder.set(k, []); subsByOrder.get(k).push(x); subsById.set(s(x.sub_id), x); }
      const cl = await optional("SELECT order_id, utr, source FROM payment_claims WHERE status = 'MATCHED' AND order_id IN " + inList(part.length), part);
      for (const c of cl) if (!claims.has(s(c.order_id))) claims.set(s(c.order_id), c);
    }
    const missing = renewIds.filter((id) => !subsById.has(id));
    for (const part of chunks(missing)) {
      const subs = await q('SELECT sub_id, order_id, expiry_date, inventory_ref FROM subscriptions WHERE sub_id IN ' + inList(part.length), part);
      for (const x of subs) subsById.set(s(x.sub_id), x);
    }
    const ctx = { subsByOrder, subsById, claims, now: now() };
    return orders.map((o) => mapOrder(o, ctx)).filter((r) => orderPassesJs(r, f));
  }

  // ---------------- customers
  async function countCustomers(f) {
    const w = customerWhere(f);
    const r = await q('SELECT COUNT(*) AS n FROM customers' + w.sql, w.params);
    return Math.round(num((r[0] || {}).n));
  }
  async function loadCustomers(f) {
    const w = customerWhere(f);
    const custs = [];
    for (let off = 0; ; off += PAGE) {
      const page = await q('SELECT customer_id, name, phone, phone_norm, email, member_since, raw_json FROM customers' + w.sql + ' ORDER BY member_since DESC, phone_norm LIMIT ? OFFSET ?', [...w.params, PAGE, off]);
      custs.push(...page);
      if (page.length < PAGE || custs.length > maxRows) break;
    }
    const phones = [...new Set(custs.map((c) => s(c.phone_norm)).filter(Boolean))];
    const by = () => new Map();
    const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    const ordersBy = by(); const subsBy = by(); const walletBy = new Map(); const codeBy = new Map(); const referrerOf = new Map(); const invites = new Map();
    const nowText = istNowText(now());
    let removedCol = true;
    for (const part of chunks(phones)) {
      const IN = inList(part.length);
      const orders = await q("SELECT order_id, phone_norm, created_at_sheet, service, status, final_amount, email FROM orders WHERE phone_norm IN " + IN, part);
      for (const o of orders) push(ordersBy, s(o.phone_norm), o);
      // raw_json only for the few refunded / on-credit orders (refund amount, credit due).
      const special = await q("SELECT order_id, phone_norm, status, final_amount, created_at_sheet, raw_json FROM orders WHERE UPPER(status) IN ('REFUNDED', 'CREDIT') AND phone_norm IN " + IN, part);
      const rawById = new Map(special.map((o) => [s(o.order_id), o]));
      for (const o of orders) { const r = rawById.get(s(o.order_id)); if (r) o.raw_json = r.raw_json; }
      let subs;
      if (removedCol) {
        try { subs = await q('SELECT sub_id, phone_norm, service, plan, status, expiry_date, removed FROM subscriptions WHERE phone_norm IN ' + IN, part); } catch (e) { if (!unknownColumn(e)) throw e; removedCol = false; }
      }
      if (!removedCol) subs = await q('SELECT sub_id, phone_norm, service, plan, status, expiry_date FROM subscriptions WHERE phone_norm IN ' + IN, part);
      for (const x of subs) push(subsBy, s(x.phone_norm), x);
      const wal = await q('SELECT phone_norm, coins_balance, coins_lifetime FROM wallet WHERE phone_norm IN ' + IN, part);
      for (const x of wal) { const k = s(x.phone_norm); const cur = walletBy.get(k); if (!cur || num(x.coins_lifetime) > num(cur.coins_lifetime) || (num(x.coins_lifetime) === num(cur.coins_lifetime) && num(x.coins_balance) > num(cur.coins_balance))) walletBy.set(k, x); }
      for (const x of await optional('SELECT phone_norm, code FROM referral_codes WHERE phone_norm IN ' + IN, part)) codeBy.set(s(x.phone_norm), s(x.code));
      for (const x of await optional('SELECT friend_phone, referrer_phone, code FROM referrals WHERE friend_phone IN ' + IN, part)) referrerOf.set(s(x.friend_phone), x);
      for (const x of await optional('SELECT referrer_phone, COUNT(*) AS n FROM referrals WHERE referrer_phone IN ' + IN + ' GROUP BY referrer_phone', part)) invites.set(s(x.referrer_phone), Math.round(num(x.n)));
    }
    // Names of the people who invited them (a separate customers query, matched in JS).
    const nameOf = new Map(custs.map((c) => [s(c.phone_norm), s(c.name)]));
    const need = [...new Set([...referrerOf.values()].map((x) => s(x.referrer_phone)).filter((p) => p && !nameOf.has(p)))];
    for (const part of chunks(need)) for (const x of await q('SELECT phone_norm, name FROM customers WHERE phone_norm IN ' + inList(part.length), part)) nameOf.set(s(x.phone_norm), s(x.name));

    const out = [];
    for (const c of custs) {
      const ph = s(c.phone_norm);
      const row = mapCustomer(c, { orders: ordersBy.get(ph) || [], subs: subsBy.get(ph) || [], wallet: walletBy.get(ph), code: codeBy.get(ph) || '', referral: referrerOf.get(ph), invites: invites.get(ph) || 0, nameOf, nowText, now: now() });
      if (customerPassesJs(row, f)) out.push(row);
    }
    return out;
  }

  // ---------------- routes
  app.get('/admin/api/exports/options', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const rows = await q("SELECT DISTINCT service, plan FROM orders WHERE COALESCE(service, '') <> '' ORDER BY service, plan LIMIT 800", []);
      const services = [...new Set(rows.map((r) => s(r.service)))].sort((a, b) => a.localeCompare(b));
      res.json({ ok: true, services, plans: rows.map((r) => ({ service: s(r.service), plan: s(r.plan) })), limit: maxRows, rateLimit: { max: RATE_MAX, minutes: RATE_WINDOW_MS / 60e3 }, statuses: Object.keys(STATUS_GROUPS), methods: METHODS, datePresets: DATE_PRESETS });
    } catch (e) { fail(res, e); }
  });

  const handlers = {
    orders: { norm: normOrderFilters, count: countOrders, load: loadOrders, columns: ORDER_COLUMNS, what: 'orders' },
    customers: { norm: normCustomerFilters, count: countCustomers, load: loadCustomers, columns: CUSTOMER_COLUMNS, what: 'customers' },
  };
  for (const kind of Object.keys(handlers)) {
    const h = handlers[kind];
    app.post('/admin/api/exports/' + kind + '/count', async (req, res) => {
      if (!auth(req, res)) return;
      try {
        const f = h.norm((req.body || {}).filters, now());
        const n = await h.count(f);
        res.json({ ok: true, count: n, limit: maxRows, tooMany: n > maxRows, fileName: fileName(kind, f.range, s((req.body || {}).format).toLowerCase(), now()), exact: kind === 'orders' ? !(f.methods.length || f.refundKinds.length) : !(f.planState || f.services.length || f.minSpent) });
      } catch (e) { fail(res, e); }
    });
    app.post('/admin/api/exports/' + kind, async (req, res) => {
      if (!auth(req, res)) return;
      const b = req.body || {};
      const format = s(b.format).toLowerCase() === 'csv' ? 'csv' : 'xlsx';
      const hit = limiter.hit('exports', now());
      if (!hit.ok) return res.status(429).json({ ok: false, message: 'Too many exports — at most ' + RATE_MAX + ' every 10 minutes. Try again in ' + Math.ceil(hit.retryAfterSec / 60) + ' min.' });
      try {
        const f = h.norm(b.filters, now());
        const n = await h.count(f);
        if (n > maxRows) return res.status(413).json(tooMany(n, h.what));
        const rows = await h.load(f);
        if (rows.length > maxRows) return res.status(413).json(tooMany(rows.length, h.what));
        const table = rows.map((r) => h.columns.map((c) => r[c.key]));
        const name = fileName(kind, f.range, format, now());
        let body; let summary = null;
        if (format === 'csv') body = Buffer.from(xlsx.buildCsv(h.columns, table), 'utf8');
        else {
          const sheets = [{ name: kind === 'orders' ? 'Orders' : 'Customers', columns: h.columns, rows: table, freeze: true, autoFilter: true }];
          summary = kind === 'orders' ? ordersSummary(rows, f, now()) : customersSummary(rows, f, now());
          sheets.push({ name: 'Summary', header: false, columns: [{ header: '', width: 44 }, { header: '', width: 20 }, { header: '', width: 14 }, { header: '', width: 14 }], rows: summary.rows });
          body = xlsx.buildXlsx(sheets);
        }
        audit.record(req, {
          action: 'export.' + kind, entity: 'export', id: name,
          summary: 'Exported ' + rows.length + ' ' + h.what + ' (' + format.toUpperCase() + ') · ' + (f.range.from || f.range.to ? (f.range.from || 'start') + ' to ' + (f.range.to || 'today') : 'all dates') + ' · filters: ' + filterText(kind, f),
          details: { who: who(req), format, rows: rows.length, filters: f },
        });
        res.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', 'attachment; filename="' + name + '"');
        res.set('X-Export-Rows', String(rows.length));
        res.set('X-Export-Filename', name);
        res.send(body);
      } catch (e) { fail(res, e); }
    });
  }
}

/** Customer row. ctx = { orders, subs, wallet, code, referral, invites, nameOf, nowText, now } (all for this phone). */
function mapCustomer(c, ctx) {
  const raw = rawOf(c.raw_json);
  const email = s(c.email).toLowerCase();
  const paid = ctx.orders.filter((o) => ['PAID', 'FULFILLED'].includes(up(o.status)));
  const dates = paid.map((o) => s(o.created_at_sheet)).filter(Boolean).sort();
  const active = ctx.subs.filter((x) => up(x.status) === 'ACTIVE' && s(x.expiry_date) && s(x.expiry_date) > ctx.nowText).sort((a, b) => (s(a.expiry_date) < s(b.expiry_date) ? -1 : 1));
  const refundsList = ctx.orders.filter((o) => up(o.status) === 'REFUNDED');
  const creditDue = ctx.orders.filter((o) => up(o.status) === 'CREDIT').reduce((n, o) => n + credit.creditState(o, ctx.now).due, 0);
  // Same rule as emaillock.stateFor: the flag when set; before the flag existed, an email a paid order used counts.
  const flag = /^true$/i.test(s(raw.EmailVerified)) ? true : /^false$/i.test(s(raw.EmailVerified)) ? false : undefined;
  const verified = !email ? '' : flag === true ? (s(raw.EmailVerifiedEmail || email).toLowerCase() === email ? 'Yes' : 'No') : flag === false ? 'No' : paid.some((o) => s(o.email).toLowerCase() === email) ? 'Yes (paid order)' : 'No';
  const ref = ctx.referral;
  const refPhone = ref ? s(ref.referrer_phone) : '';
  return {
    customerId: s(c.customer_id), name: s(c.name), phone: s(c.phone_norm) || s(c.phone), email: s(c.email), emailVerified: verified,
    memberSince: s(c.member_since), orders: paid.length, spent: round2(paid.reduce((n, o) => n + num(o.final_amount), 0)),
    firstOrder: dates[0] || '', lastOrder: dates[dates.length - 1] || '',
    activeCount: active.length, activeList: active.map((x) => [s(x.service), s(x.plan)].filter(Boolean).join(' ') + ' till ' + shortDate(x.expiry_date, ctx.now)).join('; '),
    nextExpiry: active.length ? s(active[0].expiry_date) : '',
    coins: ctx.wallet ? Math.round(num(ctx.wallet.coins_balance)) : 0, referralCode: ctx.code,
    referredBy: refPhone ? ((ctx.nameOf.get(refPhone) ? ctx.nameOf.get(refPhone) + ' · ' : '') + refPhone + (s(ref.code) ? ' (code ' + s(ref.code) + ')' : '')) : '',
    invites: ctx.invites, refundsCount: refundsList.length, refundsAmount: round2(refundsList.reduce((n, o) => n + refunds.refundInfo(o).amount, 0)),
    creditDue: round2(creditDue), removedCount: ctx.subs.filter((x) => Number(x.removed) === 1 || x.removed === true || up(x.removed) === 'TRUE').length,
    notes: s(raw.Notes) || s(raw.AdminNote),
    _services: [...new Set(ctx.orders.filter((o) => ['PAID', 'FULFILLED', 'CREDIT'].includes(up(o.status))).map((o) => s(o.service)).concat(ctx.subs.map((x) => s(x.service))).filter(Boolean))],
    _bought: paid.length > 0 || ctx.subs.length > 0 || ctx.orders.some((o) => up(o.status) === 'CREDIT'),
  };
}
function customerPassesJs(row, f) {
  if (f.planState === 'active' && !row.activeCount) return false;
  if (f.planState === 'expired' && (row.activeCount || !row._bought)) return false;
  if (f.planState === 'never' && row._bought) return false;
  if (f.services.length) { const want = f.services.map((x) => x.toLowerCase()); if (!row._services.some((x) => want.includes(x.toLowerCase()))) return false; }
  if (f.minSpent && row.spent < f.minSpent) return false;
  return true;
}
function customersSummary(rows, f, now) {
  const B = (v) => ({ v, bold: true });
  const sum = (k) => round2(rows.reduce((n, r) => n + num(r[k]), 0));
  return { rows: [
    [B('FluxFilm customers export'), ''],
    ['Made on (IST)', { v: istNowText(now), type: 'datetime' }],
    ['Joined', f.range.from || f.range.to ? (f.range.from || 'start') + ' to ' + (f.range.to || 'today') : 'Any date'],
    ['Filters', filterText('customers', f)],
    ['⚠️ Contains customer phone numbers and emails — keep this file private.', ''],
    [],
    [B('Totals'), ''],
    ['Customers in this file', { v: rows.length, type: 'int' }],
    ['With an active plan', { v: rows.filter((r) => r.activeCount).length, type: 'int' }],
    ['Never bought', { v: rows.filter((r) => !r._bought).length, type: 'int' }],
    ['Total spent ₹', { v: sum('spent'), type: 'money' }],
    ['Coins balance (all)', { v: sum('coins'), type: 'int' }],
    ['Credit due ₹', { v: sum('creditDue'), type: 'money' }],
  ] };
}

module.exports = {
  mount, dateRange, normOrderFilters, orderWhere, mapOrder, paymentMethod, orderPassesJs, ordersSummary, normCustomerFilters,
  customerWhere, mapCustomer, customerPassesJs, fileName, ORDER_COLUMNS, CUSTOMER_COLUMNS, STATUS_GROUPS, METHODS, MAX_ROWS, RATE_MAX,
};
