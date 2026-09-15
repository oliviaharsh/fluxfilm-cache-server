/**
 * FluxFilm - 📊 business summaries (end of day / week / month) + the numbers for admin → 📈 Reports.
 * Owner request 16 Sep 2026.
 *
 * Periods (India time, Asia/Kolkata, computed from the clock — not from the server TZ):
 *   day    00:00 → 24:00
 *   week   MONDAY 00:00 → next Monday 00:00 (the weekly summary goes out on Sunday, the last day of the week)
 *   month  the 1st 00:00 → the 1st of next month 00:00 (the monthly summary goes out on the last day)
 *   custom from date → to date, both days included (at most 400 days)
 *   The comparison is always the period just before: yesterday · last week · last month · the same number of days before.
 *
 * Numbers reuse the admin screens:
 *   cash in / orders / renewals = PAID orders by payment time (COALESCE(verified_at, created_at_sheet)) — exactly the
 *     💰 Profit page's "cash in" (profit.computeProfit). CREDIT orders are not PAID, so they are left out until marked
 *     paid; refunded orders are REFUNDED, so they drop out too and refunds are shown separately (by RefundedAt).
 *   earned / cost / profit = profit.computeProfit for the same range (only shown when account costs are entered).
 *   receivables = credit.receivables · pending / stock / passwords = adminhome.buildToday (the ✅ Today cards) ·
 *   comments to review = feedcomments.adminList · coins = the 🪙 Coins page formula on coins_ledger.
 *   Every SQL statement reads ONE table (live lesson: mixed collations) — everything is matched in JS.
 *
 * Scheduler (in-process, one tick a minute): daily at dailyTime (default 23:30; a time before 12:00 sends
 * YESTERDAY's summary), weekly Sunday weeklyTime (23:45), monthly last day monthlyTime (23:50).
 * Before sending, an atomic INSERT IGNORE of app_settings 'ffrep:<kind>:<period>' — only the process whose insert
 * went in sends (restarts, redeploys, two processes never double-send). The same row then holds the snapshot.
 * Down at the time? Sent on the next tick within 6 hours of the time (catch-up); later than that it is skipped.
 * Snapshots: at most 400 'ffrep:*' rows (oldest removed), each kept small (< 60 KB).
 */
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const inr = (n) => '₹' + Math.round(num(n)).toLocaleString('en-IN');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

const DAY = 86400000;
const IST_OFFSET = 5.5 * 3600e3;
const CATCHUP_MS = 6 * 3600e3;
const SNAP_PREFIX = 'ffrep:';
const MAX_SNAPSHOTS = 400;
const MAX_SNAPSHOT_CHARS = 60000;
const MAX_CUSTOM_DAYS = 400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------- India-time calendar (pure)
const pad = (n) => String(n).padStart(2, '0');
function istYmd(ms) { const d = new Date(Number(ms) + IST_OFFSET); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function istHm(ms) { const d = new Date(Number(ms) + IST_OFFSET); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
function validYmd(v) { const t = s(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return ''; const ms = Date.parse(t + 'T00:00:00Z'); return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === t ? t : ''; }
function addDays(ymd, n) { return new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
const dow = (ymd) => new Date(ymd + 'T00:00:00Z').getUTCDay();
function mondayOf(ymd) { return addDays(ymd, -((dow(ymd) + 6) % 7)); }
const monthStart = (ymd) => ymd.slice(0, 8) + '01';
function nextMonthStart(ymd) { const y = +ymd.slice(0, 4); const m = +ymd.slice(5, 7); return m === 12 ? (y + 1) + '-01-01' : y + '-' + pad(m + 1) + '-01'; }
const lastDayOfMonth = (ymd) => addDays(nextMonthStart(ymd), -1);
/** India wall-clock 'YYYY-MM-DD' + 'HH:MM' → epoch ms. */
const istMsAt = (ymd, hm) => Date.parse(ymd + 'T' + hm + ':00+05:30');
function ymdText(ymd, withDow) { const m = s(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (withDow ? DOWS[dow(m[0])] + ' ' : '') + (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; }

function makeRange(kind, fromYmd, toExclYmd, key, label) {
  const days = Math.round((Date.parse(toExclYmd) - Date.parse(fromYmd)) / DAY);
  return { kind, key, label, fromYmd, toYmd: addDays(toExclYmd, -1), from: fromYmd + ' 00:00:00', to: toExclYmd + ' 00:00:00', days, months: days / 30.4375 };
}
/**
 * kind 'day' | 'week' | 'month' → the period containing ymd. 'custom' → ymd .. toYmd (both included).
 * Returns null for an unreadable date / a custom range that is backwards or longer than 400 days.
 */
function rangeFor(kind, ymd, toYmd) {
  let d = validYmd(ymd) || (/^\d{4}-\d{2}$/.test(s(ymd)) ? validYmd(s(ymd) + '-01') : '');
  if (!d) return null;
  if (kind === 'week') { const mon = mondayOf(d); const sun = addDays(mon, 6); return makeRange('week', mon, addDays(mon, 7), 'week:' + mon, (+mon.slice(8)) + (mon.slice(5, 7) === sun.slice(5, 7) ? '' : ' ' + MONTHS[+mon.slice(5, 7) - 1]) + ' – ' + ymdText(sun)); }
  if (kind === 'month') { const m1 = monthStart(d); return makeRange('month', m1, nextMonthStart(d), 'month:' + d.slice(0, 7), MONTHS_LONG[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4)); }
  if (kind === 'custom') {
    const t = validYmd(toYmd); if (!t || t < d) return null;
    const r = makeRange('custom', d, addDays(t, 1), 'custom:' + d + '_' + t, ymdText(d) + ' – ' + ymdText(t));
    return r.days > MAX_CUSTOM_DAYS ? null : r;
  }
  return makeRange('day', d, addDays(d, 1), 'day:' + d, ymdText(d, true));
}
/** The period just before (for ▲ / ▼). */
function previousRange(r) {
  if (r.kind === 'week') return rangeFor('week', addDays(r.fromYmd, -7));
  if (r.kind === 'month') return rangeFor('month', addDays(r.fromYmd, -1));
  if (r.kind === 'custom') return rangeFor('custom', addDays(r.fromYmd, -r.days), addDays(r.fromYmd, -1));
  return rangeFor('day', addDays(r.fromYmd, -1));
}
/** 'day:2026-09-16' or 'day:2026-09-16~m231502' (a "send now") → range, or null. */
function rangeFromKey(key) {
  const m = s(key).match(/^(day|week|month):(\d{4}-\d{2}(?:-\d{2})?)(~m\d{6})?$/);
  return m ? rangeFor(m[1], m[2]) : null;
}
/** "Today" / "Yesterday" / "This week" / "Last week" / "September" … relative to now. */
function relLabel(r, nowMs) {
  const today = istYmd(nowMs == null ? Date.now() : nowMs);
  if (r.kind === 'day') return r.fromYmd === today ? 'Today' : r.fromYmd === addDays(today, -1) ? 'Yesterday' : ymdText(r.fromYmd, true).replace(/ \d{4}$/, '');
  if (r.kind === 'week') return r.fromYmd === mondayOf(today) ? 'This week' : r.fromYmd === addDays(mondayOf(today), -7) ? 'Last week' : 'Week ' + r.label;
  if (r.kind === 'month') return MONTHS_LONG[+r.fromYmd.slice(5, 7) - 1];
  return r.label;
}

// ---------------------------------------------------------------- scheduler maths (pure)
/** Every scheduled send that could be due around now: this period's and the previous one's. */
function candidates(nowMs, cfg) {
  const today = istYmd(nowMs); const out = [];
  if (cfg.dailyOn) {
    for (const dueDay of [today, addDays(today, -1)]) {
      // Morning time = yesterday's summary (a 09:00 report of a day that just started would be empty).
      const covered = cfg.dailyTime < '12:00' ? addDays(dueDay, -1) : dueDay;
      out.push({ kind: 'day', due: istMsAt(dueDay, cfg.dailyTime), range: rangeFor('day', covered) });
    }
  }
  if (cfg.weeklyOn) {
    const sun = addDays(mondayOf(today), 6);
    for (const d of [sun, addDays(sun, -7)]) out.push({ kind: 'week', due: istMsAt(d, cfg.weeklyTime), range: rangeFor('week', d) });
  }
  if (cfg.monthlyOn) {
    for (const d of [lastDayOfMonth(today), addDays(monthStart(today), -1)]) out.push({ kind: 'month', due: istMsAt(d, cfg.monthlyTime), range: rangeFor('month', d) });
  }
  return out;
}
/** Due now = the time has passed, but by less than 6 hours (catch-up after a restart; later is skipped). */
function dueNow(nowMs, cfg) { return candidates(nowMs, cfg).filter((c) => nowMs >= c.due && nowMs < c.due + CATCHUP_MS); }
/** Next send time per kind (for the settings screen). */
function nextTimes(nowMs, cfg) {
  const out = {};
  for (const kind of ['day', 'week', 'month']) {
    const on = cfg[{ day: 'dailyOn', week: 'weeklyOn', month: 'monthlyOn' }[kind]];
    if (!on) { out[kind] = null; continue; }
    let best = null;
    for (let i = 0; i < 70 && !best; i++) {
      const c = candidates(nowMs + i * DAY, cfg).filter((x) => x.kind === kind && x.due > nowMs).sort((a, b) => a.due - b.due)[0];
      if (c) best = c;
    }
    out[kind] = best ? { at: new Date(best.due).toISOString(), text: ymdText(istYmd(best.due), true) + ' ' + istHm(best.due), period: best.range.label } : null;
  }
  return out;
}

// ---------------------------------------------------------------- numbers
/** ▲12% / ▼5% / ±0% / "new" */
function pct(cur, prev) { const c = num(cur); const p = num(prev); if (p <= 0) return c > 0 ? null : 0; return Math.round(((c - p) / p) * 100); }
function arrow(cur, prev) { const x = pct(cur, prev); return x === null ? 'new' : x > 0 ? '▲' + x + '%' : x < 0 ? '▼' + Math.abs(x) + '%' : '±0%'; }
function refundKindLabel(kind, state) {
  if (kind === 'UPI') return 'UPI (sent)';
  if (kind === 'UPI_PENDING') return state === 'UPI_REQUESTED' ? 'UPI (to send)' : 'Customer still choosing';
  return ({ CREDIT: 'Coins / credit', COUPON: 'Coupon' })[kind] || 'Other';
}
const istParse = (v) => { const x = s(v); if (!x) return NaN; if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(x)) return Date.parse(x); return Date.parse(x.replace(' ', 'T').slice(0, 19) + '+05:30'); };

/** Paid orders + new customers + refunds for one range (everything the ▲ / ▼ comparison needs). */
async function core(q, range, deps) {
  const refunds = deps.refunds || require('./refunds');
  const [orders, cust, refundRows] = await Promise.all([
    q("SELECT order_id, service, plan, final_amount, order_type, COALESCE(verified_at, created_at_sheet) AS paid_at FROM orders WHERE UPPER(status) = 'PAID' AND COALESCE(verified_at, created_at_sheet) >= ? AND COALESCE(verified_at, created_at_sheet) < ? LIMIT 50000", [range.from, range.to]),
    q('SELECT COUNT(*) AS n FROM customers WHERE member_since >= ? AND member_since < ?', [range.from, range.to]).catch(() => [{ n: 0 }]),
    // Refunded orders of the last ~13 months; the refund date (raw_json RefundedAt) is checked in JS.
    q("SELECT order_id, service, plan, final_amount, raw_json, created_at_sheet FROM orders WHERE UPPER(status) = 'REFUNDED' AND created_at_sheet >= DATE_SUB(?, INTERVAL 400 DAY) AND created_at_sheet < ? LIMIT 20000", [range.from, range.to]).catch(() => []),
  ]);
  const fromMs = istParse(range.from); const toMs = istParse(range.to);
  const c = { revenue: 0, orders: 0, newOrders: 0, renewals: 0, newRevenue: 0, renewRevenue: 0, newCustomers: Number((cust[0] || {}).n) || 0 };
  const svc = new Map(); const plans = new Map(); const daily = new Map();
  const seen = new Set();
  for (const o of orders) {
    if (o.order_id != null && seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    const amt = num(o.final_amount);
    const renew = up(o.order_type) === 'RENEW';
    c.revenue += amt; c.orders++;
    if (renew) { c.renewals++; c.renewRevenue += amt; } else { c.newOrders++; c.newRevenue += amt; }
    const sv = s(o.service) || 'Other';
    const a = svc.get(sv) || { service: sv, orders: 0, revenue: 0, renewals: 0 }; a.orders++; a.revenue += amt; if (renew) a.renewals++; svc.set(sv, a);
    const pk = sv + '|' + s(o.plan);
    const b = plans.get(pk) || { service: sv, plan: s(o.plan), orders: 0, revenue: 0 }; b.orders++; b.revenue += amt; plans.set(pk, b);
    const day = istYmd(istParse(o.paid_at));
    const dd = daily.get(day) || { date: day, revenue: 0, orders: 0 }; dd.revenue += amt; dd.orders++; daily.set(day, dd);
  }
  const rf = { count: 0, amount: 0, methods: {} };
  for (const o of refundRows) {
    const info = refunds.refundInfo(o);
    const at = istParse(info.at);
    if (!(at >= fromMs && at < toMs)) continue;
    rf.count++; rf.amount += num(info.amount);
    const label = refundKindLabel(info.kind, info.state);
    const m = rf.methods[label] || { count: 0, amount: 0 }; m.count++; m.amount += num(info.amount); rf.methods[label] = m;
  }
  const days = [];
  for (let d = range.fromYmd, i = 0; d <= range.toYmd && i < MAX_CUSTOM_DAYS + 1; d = addDays(d, 1), i++) days.push(daily.get(d) || { date: d, revenue: 0, orders: 0 });
  return {
    revenue: r2(c.revenue), orders: c.orders, newOrders: c.newOrders, renewals: c.renewals, newRevenue: r2(c.newRevenue), renewRevenue: r2(c.renewRevenue),
    newCustomers: c.newCustomers, avgOrder: c.orders ? r2(c.revenue / c.orders) : 0,
    refunds: { count: rf.count, amount: r2(rf.amount), methods: rf.methods },
    services: [...svc.values()].map((x) => Object.assign(x, { revenue: r2(x.revenue) })).sort((a, b) => b.revenue - a.revenue || b.orders - a.orders),
    plans: [...plans.values()].map((x) => Object.assign(x, { revenue: r2(x.revenue) })).sort((a, b) => b.revenue - a.revenue || b.orders - a.orders),
    daily: days.map((x) => ({ date: x.date, revenue: r2(x.revenue), orders: x.orders })),
  };
}

/** The ✅ Today cards → stock / passwords / pending (same counts as the Today screen). */
function fromToday(today, pendingComments) {
  const items = (today && Array.isArray(today.items)) ? today.items : [];
  const it = (k) => items.find((x) => x.key === k) || {};
  const n = (k) => Number(it(k).count) || 0;
  const pending = {
    manual: n('manual'), manualLate: Number(it('manual').late) || 0, undelivered: n('undelivered'), refundRequests: n('refundrequests'),
    upiRefunds: n('upirefunds'), unmatched: n('unmatched'), comments: Number(pendingComments) || 0,
  };
  pending.total = pending.manual + pending.undelivered + pending.refundRequests + pending.upiRefunds + pending.unmatched + pending.comments;
  return {
    stock: { out: (it('out').names || []).slice(0, 30), low: (it('low').names || []).slice(0, 30) },
    passwords: { changeNow: n('expired'), waiting: Number(it('expired').waiting) || 0 },
    pending,
  };
}

/**
 * The full summary for a range. opts { now (ms), extras (default true: profit + "right now" parts) , deps }.
 * deps (tests): { refunds, profit, credit, home, comments }
 */
async function computeSummary(dbx, range, opts) {
  const o = opts || {}; const deps = o.deps || {};
  const nowMs = o.now == null ? Date.now() : Number(o.now);
  const q = (sql, p) => dbx.query(sql, p || []);
  const prevRange = previousRange(range);
  const [cur, prev] = await Promise.all([core(q, range, deps), core(q, prevRange, deps)]);
  const out = {
    ok: true, v: 1, kind: range.kind, key: range.key, label: range.label, relLabel: relLabel(range, nowMs), generatedAt: new Date(nowMs).toISOString(),
    range: { from: range.fromYmd, to: range.toYmd, days: range.days }, prevRange: { from: prevRange.fromYmd, to: prevRange.toYmd, label: prevRange.label },
    totals: cur, prev: { revenue: prev.revenue, orders: prev.orders, newOrders: prev.newOrders, renewals: prev.renewals, newCustomers: prev.newCustomers, refunds: { count: prev.refunds.count, amount: prev.refunds.amount } },
    change: { revenue: pct(cur.revenue, prev.revenue), orders: pct(cur.orders, prev.orders), newCustomers: pct(cur.newCustomers, prev.newCustomers), refunds: pct(cur.refunds.amount, prev.refunds.amount) },
    bestDay: null, profit: null, credit: null, coins: null, expiring: null, stock: null, passwords: null, pending: null,
  };
  if (range.kind !== 'day') {
    const best = cur.daily.filter((d) => d.revenue > 0).sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)[0];
    out.bestDay = best ? { date: best.date, text: ymdText(best.date, true), revenue: best.revenue, orders: best.orders } : null;
  }
  if (o.extras === false) return out;
  const soft = (p) => Promise.resolve().then(() => p()).catch((e) => { console.log('[reports] part failed:', e && e.message); return null; });
  const [pr, cr, coins, exp, today, comments] = await Promise.all([
    soft(() => (deps.profit || require('./profit')).computeProfit(dbx, range, {})),
    soft(() => (deps.credit || require('./credit')).receivables(q, new Date(nowMs))),
    soft(() => q("SELECT COALESCE(SUM(CASE WHEN coins_delta > 0 AND event NOT IN ('SPEND_RELEASE') THEN coins_delta ELSE 0 END), 0) AS earned, COALESCE(SUM(CASE WHEN event IN ('SPEND') THEN -coins_delta WHEN event = 'SPEND_RELEASE' THEN -coins_delta ELSE 0 END), 0) AS spent FROM coins_ledger WHERE ts >= ? AND ts < ?", [range.from, range.to])),
    soft(() => q("SELECT COUNT(*) AS subs, COUNT(DISTINCT phone_norm) AS customers FROM subscriptions WHERE UPPER(status) = 'ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 7 DAY", [])),
    soft(() => (deps.home || require('./adminhome')).buildToday(dbx, {})),
    soft(() => (deps.comments || require('./feedcomments')).adminList({ status: 'pending', limit: 1 })),
  ]);
  if (pr && pr.totals) {
    const t = pr.totals;
    out.profit = { ready: !!pr.costsReady && t.cost > 0, earned: t.earned, cost: t.cost, profit: t.profit, margin: t.margin, accountsWithoutCost: t.accountsWithoutCost, cashIn: t.revenue };
  }
  if (cr) out.credit = { total: cr.total, count: cr.count, customers: cr.customers, overdue: cr.overdue, overdueAmount: r2((cr.list || []).filter((x) => x.overdue).reduce((a, x) => a + num(x.due), 0)) };
  if (coins && coins[0]) out.coins = { given: Math.round(num(coins[0].earned)), used: Math.round(num(coins[0].spent)) };
  if (exp && exp[0]) out.expiring = { subs: Number(exp[0].subs) || 0, customers: Number(exp[0].customers) || 0 };
  if (today && today.items) Object.assign(out, fromToday(today, comments && comments.counts ? comments.counts.pending : 0));
  return out;
}

// ---------------------------------------------------------------- text / email (pure)
/** "📊 Today: ₹4,560 · 18 orders (6 new) · ▲12%" */
function pushLine(sum) {
  const t = sum.totals;
  return '📊 ' + sum.relLabel + ': ' + inr(t.revenue) + ' · ' + t.orders + ' order' + (t.orders === 1 ? '' : 's') + ' (' + t.newOrders + ' new) · ' + arrow(t.revenue, sum.prev.revenue);
}
function pushBody(sum) {
  const bits = [];
  if (sum.totals.refunds.count) bits.push('Refunds ' + inr(sum.totals.refunds.amount));
  if (sum.pending && sum.pending.total) bits.push(sum.pending.total + ' pending');
  if (sum.credit && sum.credit.total) bits.push('On credit ' + inr(sum.credit.total));
  bits.push('Tap for the full report');
  return bits.join(' · ');
}
const KIND_WORD = { day: 'daily', week: 'weekly', month: 'monthly', custom: '' };

/** Sections shared by the email, the plain-text version and the admin screen: [{ title, rows: [[label, value, note]] }] */
function sections(sum) {
  const t = sum.totals; const p = sum.prev; const out = [];
  const rev = [
    ['Cash in (paid orders)', inr(t.revenue), arrow(t.revenue, p.revenue) + ' vs ' + inr(p.revenue)],
    ['Orders', String(t.orders), arrow(t.orders, p.orders) + ' vs ' + p.orders],
    ['New orders', t.newOrders + ' · ' + inr(t.newRevenue), ''],
    ['Renewals', t.renewals + ' · ' + inr(t.renewRevenue), ''],
    ['Average order', inr(t.avgOrder), ''],
  ];
  if (sum.profit && sum.profit.ready) rev.push(['Profit estimate', inr(sum.profit.profit), 'earned ' + inr(sum.profit.earned) + ' − account costs ' + inr(sum.profit.cost) + (sum.profit.margin != null ? ' · ' + sum.profit.margin + '% margin' : '')]);
  if (sum.credit && sum.credit.total) rev.push(['On credit (not counted yet)', inr(sum.credit.total), 'counted when marked paid']);
  out.push({ title: '💵 Revenue', rows: rev });
  if (t.services.length) out.push({ title: '🏆 Top services', rows: t.services.slice(0, 5).map((x) => [x.service, inr(x.revenue), x.orders + ' order' + (x.orders === 1 ? '' : 's') + (x.renewals ? ' · ' + x.renewals + ' renewal' + (x.renewals === 1 ? '' : 's') : '')]) });
  if (t.plans.length) out.push({ title: '🧾 Top plans', rows: t.plans.slice(0, 5).map((x) => [x.service + (x.plan ? ' · ' + x.plan : ''), inr(x.revenue), x.orders + ' order' + (x.orders === 1 ? '' : 's')]) });
  if (sum.bestDay) out.push({ title: '📅 Best day', rows: [[sum.bestDay.text, inr(sum.bestDay.revenue), sum.bestDay.orders + ' order' + (sum.bestDay.orders === 1 ? '' : 's')]] });
  const cust = [['New customers', String(t.newCustomers), arrow(t.newCustomers, p.newCustomers) + ' vs ' + p.newCustomers], ['Renewals done', String(t.renewals), '']];
  if (sum.expiring) cust.push(['Expiring in the next 7 days', sum.expiring.customers + ' customer' + (sum.expiring.customers === 1 ? '' : 's'), sum.expiring.subs + ' plan' + (sum.expiring.subs === 1 ? '' : 's')]);
  out.push({ title: '👥 Customers', rows: cust });
  const rf = [['Refunds', t.refunds.count + ' · ' + inr(t.refunds.amount), arrow(t.refunds.amount, p.refunds.amount) + ' vs ' + inr(p.refunds.amount)]];
  for (const [label, m] of Object.entries(t.refunds.methods)) rf.push(['  ' + label, m.count + ' · ' + inr(m.amount), '']);
  out.push({ title: '↩️ Refunds', rows: rf });
  if (sum.credit) out.push({ title: '💳 Credit (right now)', rows: [['Receivables outstanding', inr(sum.credit.total), sum.credit.customers + ' customer' + (sum.credit.customers === 1 ? '' : 's')], ['Overdue', sum.credit.overdue + ' · ' + inr(sum.credit.overdueAmount), '']] });
  if (sum.coins) out.push({ title: '🪙 Coins', rows: [['Given', sum.coins.given.toLocaleString('en-IN'), ''], ['Used', sum.coins.used.toLocaleString('en-IN'), '']] });
  if (sum.stock) {
    out.push({ title: '📦 Stock (right now)', rows: [
      ['Out of stock', String(sum.stock.out.length), sum.stock.out.slice(0, 6).join(', ') + (sum.stock.out.length > 6 ? ' +' + (sum.stock.out.length - 6) + ' more' : '')],
      ['Running low', String(sum.stock.low.length), sum.stock.low.slice(0, 6).join(', ') + (sum.stock.low.length > 6 ? ' +' + (sum.stock.low.length - 6) + ' more' : '')],
    ] });
  }
  if (sum.passwords) out.push({ title: '🔑 Accounts', rows: [['Passwords to change now', String(sum.passwords.changeNow), sum.passwords.waiting ? sum.passwords.waiting + ' waiting' : '']] });
  if (sum.pending) {
    const pd = sum.pending;
    out.push({ title: '⏳ Pending (right now)', rows: [
      ['Manual deliveries waiting', String(pd.manual), pd.manualLate ? pd.manualLate + ' over 48 h' : ''],
      ['Paid but not delivered', String(pd.undelivered), ''],
      ['Refund requests', String(pd.refundRequests), ''],
      ['UPI refunds to send', String(pd.upiRefunds), ''],
      ['Unmatched bank payments', String(pd.unmatched), ''],
      ['Comments to review', String(pd.comments), ''],
    ] });
  }
  return out;
}

function renderEmail(sum, opts) {
  const o = opts || {};
  const site = (process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
  const link = site + (o.url || '/panel?v=reports');
  const t = sum.totals;
  const line = pushLine(sum);
  const word = KIND_WORD[sum.kind] ? KIND_WORD[sum.kind] + ' summary' : 'summary';
  const subject = '📊 FluxFilm ' + word + ' — ' + sum.label + ': ' + inr(t.revenue) + ' (' + arrow(t.revenue, sum.prev.revenue) + ')' + (o.manual ? ' · sent now' : '');
  const secs = sections(sum);
  const td = 'padding:7px 10px;border-top:1px solid #eef2f7;vertical-align:top;font-size:14px';
  const kpi = (label, value, note) => '<td style="padding:6px;width:33%"><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px"><div style="font-size:12px;color:#64748b">' + esc(label) + '</div><div style="font-size:20px;font-weight:800;color:#0f172a">' + esc(value) + '</div><div style="font-size:12px;color:#64748b">' + esc(note) + '</div></div></td>';
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">' +
    '<h2 style="margin:0 0 2px;color:#e11d48">📊 ' + esc(word.charAt(0).toUpperCase() + word.slice(1)) + '</h2>' +
    '<p style="margin:0 0 12px;color:#64748b;font-size:13px">' + esc(sum.label) + ' · compared with ' + esc(sum.prevRange.label) + '</p>' +
    '<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
    kpi('Cash in', inr(t.revenue), arrow(t.revenue, sum.prev.revenue)) + kpi('Orders', String(t.orders), t.newOrders + ' new · ' + t.renewals + ' renew') + kpi('New customers', String(t.newCustomers), arrow(t.newCustomers, sum.prev.newCustomers)) +
    '</tr></table>' +
    secs.map((sec) => '<h3 style="margin:18px 0 4px;font-size:15px">' + esc(sec.title) + '</h3><table role="presentation" style="width:100%;border-collapse:collapse">' +
      sec.rows.map((r) => '<tr><td style="' + td + ';color:#334155">' + esc(r[0]) + '</td><td style="' + td + ';font-weight:700;text-align:right;white-space:nowrap">' + esc(r[1]) + '</td></tr>' + (r[2] ? '<tr><td colspan="2" style="padding:0 10px 7px;font-size:12px;color:#64748b">' + esc(r[2]) + '</td></tr>' : '')).join('') + '</table>').join('') +
    '<p style="margin:20px 0 6px"><a href="' + esc(link) + '" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:700">Open 📈 Reports</a></p>' +
    '<p style="color:#94a3b8;font-size:12px">Cash in = paid orders by payment time (credit renewals only once paid; refunded orders are not counted and refunds are listed on their own). "Right now" parts show the moment this was sent.</p></div>';
  const text = [line, sum.label + ' (compared with ' + sum.prevRange.label + ')', ''].concat(secs.map((sec) => sec.title + '\n' + sec.rows.map((r) => '- ' + s(r[0]) + ': ' + r[1] + (r[2] ? ' (' + r[2] + ')' : '')).join('\n') + '\n')).concat([link]).join('\n');
  return { subject, html, text, line };
}

// ---------------------------------------------------------------- snapshots
const SNAP_ID = /^(day|week|month):(\d{4}-\d{2}(?:-\d{2})?)(~m\d{6})?$/;
function compactSnapshot(sum, extra) {
  const t = sum.totals;
  const snap = Object.assign({
    v: 1, kind: sum.kind, key: sum.key, label: sum.label, relLabel: sum.relLabel, generatedAt: sum.generatedAt,
    range: sum.range, prevRange: sum.prevRange, line: pushLine(sum), sections: sections(sum),
    totals: { revenue: t.revenue, orders: t.orders, newOrders: t.newOrders, renewals: t.renewals, newRevenue: t.newRevenue, renewRevenue: t.renewRevenue, newCustomers: t.newCustomers, avgOrder: t.avgOrder, refunds: t.refunds, services: t.services.slice(0, 12), plans: t.plans.slice(0, 8), daily: t.daily },
    prev: sum.prev, change: sum.change, bestDay: sum.bestDay, profit: sum.profit, credit: sum.credit, coins: sum.coins, expiring: sum.expiring, stock: sum.stock, passwords: sum.passwords, pending: sum.pending,
  }, extra || {});
  let json = JSON.stringify(snap);
  if (json.length > MAX_SNAPSHOT_CHARS) { snap.totals.daily = []; snap.totals.plans = snap.totals.plans.slice(0, 3); json = JSON.stringify(snap); }
  if (json.length > MAX_SNAPSHOT_CHARS) { snap.stock = null; snap.sections = snap.sections.slice(0, 6); json = JSON.stringify(snap); }
  return json.slice(0, MAX_SNAPSHOT_CHARS);
}
/** Atomic "already sent for period X" guard: true only for the one caller whose row went in. */
async function claim(dbx, key, nowMs) {
  const r = await dbx.query('INSERT IGNORE INTO app_settings (setting_key, value) VALUES (?, ?)', [key, JSON.stringify({ status: 'SENDING', at: new Date(nowMs == null ? Date.now() : nowMs).toISOString() })]);
  return !!(r && Number(r.affectedRows) === 1);
}
async function saveSnapshot(dbx, key, json) {
  await dbx.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, json]);
}
async function pruneSnapshots(dbx) {
  try {
    const old = await dbx.query("SELECT setting_key FROM app_settings WHERE setting_key LIKE 'ffrep:%' ORDER BY updated_at DESC, setting_key DESC LIMIT " + MAX_SNAPSHOTS + ', 200', []);
    for (const r of old || []) await dbx.query('DELETE FROM app_settings WHERE setting_key = ? LIMIT 1', [r.setting_key]);
    return (old || []).length;
  } catch (e) { console.log('[reports] prune failed:', e.message); return 0; }
}
async function listSnapshots(dbx) {
  const rows = await dbx.query("SELECT setting_key, updated_at FROM app_settings WHERE setting_key LIKE 'ffrep:%' ORDER BY updated_at DESC, setting_key DESC LIMIT " + MAX_SNAPSHOTS, []);
  return (rows || []).map((r) => {
    const id = s(r.setting_key).slice(SNAP_PREFIX.length);
    const m = id.match(SNAP_ID); if (!m) return null;
    const range = rangeFor(m[1], m[2]);
    return range ? { id, kind: m[1], label: range.label, manual: !!m[3], sentAt: s(r.updated_at) } : null;
  }).filter(Boolean);
}
async function getSnapshot(dbx, id) {
  if (!SNAP_ID.test(s(id))) return null;
  const rows = await dbx.query('SELECT value, updated_at FROM app_settings WHERE setting_key = ? LIMIT 1', [SNAP_PREFIX + s(id)]);
  if (!rows || !rows[0]) return null;
  const v = rawOf(rows[0].value);
  return Object.assign({ id, savedAt: s(rows[0].updated_at) }, v);
}

// ---------------------------------------------------------------- send
/**
 * Work out, deliver (push + email, per settings) and save one summary. opts { key (snapshot row), manual, now, deps }
 * deps (tests): { db, push, smtp, notify, summary, summaryDeps }
 */
async function sendSummary(range, opts) {
  const o = opts || {}; const deps = o.deps || {};
  const dbx = deps.db || db;
  const notify = deps.notify || require('./ownernotify');
  const nowMs = o.now == null ? Date.now() : Number(o.now);
  const cfg = await notify.getSettings(true);
  const sum = deps.summary ? await deps.summary(range) : await computeSummary(dbx, range, { now: nowMs, deps: deps.summaryDeps });
  const id = s(o.key).slice(SNAP_PREFIX.length) || range.key;
  const url = '/panel?v=reports&report=' + encodeURIComponent(id);
  const mail = renderEmail(sum, { url, manual: o.manual });
  const delivery = { push: null, email: null };
  if (cfg.summaryPush) {
    try {
      const r = await (deps.push || require('./push')).sendToAdmins({ title: mail.line, body: pushBody(sum), url, tag: 'report-' + id.replace(/[^\w-]/g, '-').slice(0, 50) }, { kind: 'admin' });
      delivery.push = { sent: r.sent || 0, devices: r.devices || 0 };
    } catch (e) { delivery.push = { sent: 0, error: e.message }; }
  }
  if (cfg.summaryEmail) {
    const to = notify.recipients(cfg);
    try {
      const smtp = deps.smtp || require('./smtp');
      if (!to.length) delivery.email = { ok: false, skipped: 'no email address' };
      else if (!smtp.status().configured) delivery.email = { ok: false, skipped: 'email not set up' };
      else { const r = await smtp.sendMail({ to: to.join(', '), subject: mail.subject, html: mail.html, text: mail.text }); delivery.email = { ok: !!(r && r.ok), to: to.length }; }
    } catch (e) { delivery.email = { ok: false, error: s(e.message).slice(0, 160) }; }
  }
  const key = o.key || SNAP_PREFIX + range.key;
  await saveSnapshot(dbx, key, compactSnapshot(sum, { status: 'SENT', sentAt: new Date(nowMs).toISOString(), manual: !!o.manual, delivery }));
  await pruneSnapshots(dbx);
  console.log('[reports] sent', key, mail.line, 'push', delivery.push ? delivery.push.sent + '/' + delivery.push.devices : 'off', 'email', delivery.email ? (delivery.email.ok ? 'ok' : s(delivery.email.skipped || delivery.email.error)) : 'off');
  return { ok: true, id, key, line: mail.line, delivery, summary: sum };
}

/** A "📨 Send now" from admin: never uses (or blocks) the scheduled period's guard row. */
function manualKey(range, nowMs) { return SNAP_PREFIX + range.key + '~m' + istHm(nowMs).replace(':', '') + pad(new Date(nowMs).getUTCSeconds()); }

// ---------------------------------------------------------------- scheduler
/** opts { db, now: () => ms, getSettings, send: (candidate, key) => Promise } — each instance is one "process". */
function createScheduler(opts) {
  const o = opts || {};
  const dbx = o.db || db;
  const nowFn = o.now || Date.now;
  const settingsFn = o.getSettings || (() => require('./ownernotify').getSettings(true));
  const sendFn = o.send || ((c, key) => sendSummary(c.range, { key, now: nowFn(), deps: { db: dbx } }));
  const handled = new Set(); // keys this process already claimed or saw claimed
  let busy = false; let timer = null;
  async function tick() {
    if (busy) return [{ skipped: 'busy' }];
    busy = true;
    const results = [];
    try {
      let cfg;
      try { cfg = await settingsFn(); } catch (e) { console.log('[reports] settings unreadable:', e.message); return results; }
      for (const c of dueNow(nowFn(), cfg)) {
        const key = SNAP_PREFIX + c.range.key;
        if (handled.has(key)) continue;
        let mine;
        try { mine = await claim(dbx, key, nowFn()); } catch (e) { if (!missingTable(e)) console.log('[reports] guard failed', key, e.message); results.push({ key, error: e.message }); continue; }
        handled.add(key);
        if (handled.size > 200) handled.delete(handled.values().next().value);
        if (!mine) { results.push({ key, skipped: 'already sent' }); continue; }
        try { await sendFn(c, key); results.push({ key, sent: true }); }
        catch (e) {
          console.log('[reports] summary', key, 'failed:', e.message);
          try { await saveSnapshot(dbx, key, JSON.stringify({ status: 'FAILED', error: s(e.message).slice(0, 300), at: new Date(nowFn()).toISOString(), kind: c.kind, label: c.range.label })); } catch (_) {}
          results.push({ key, error: e.message });
        }
      }
    } finally { busy = false; }
    return results;
  }
  function start() {
    if (timer) return;
    const run = () => tick().catch((e) => console.log('[reports] tick failed:', e.message));
    const first = setTimeout(run, 20e3); if (first.unref) first.unref();
    timer = setInterval(run, 60e3); if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { tick, start, stop, _handled: handled };
}
let main = null;
function startTimer() { if (!main) main = createScheduler(); main.start(); return main; }

module.exports = {
  rangeFor, previousRange, rangeFromKey, relLabel, candidates, dueNow, nextTimes, pct, arrow, computeSummary, sections, renderEmail, pushLine, pushBody,
  compactSnapshot, claim, saveSnapshot, listSnapshots, getSnapshot, pruneSnapshots, sendSummary, manualKey, createScheduler, startTimer,
  SNAP_PREFIX, CATCHUP_MS, MAX_SNAPSHOTS, MAX_CUSTOM_DAYS,
  _internal: { istYmd, istHm, addDays, mondayOf, lastDayOfMonth, istMsAt, core, fromToday, validYmd },
};
