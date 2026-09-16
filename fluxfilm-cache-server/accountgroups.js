/**
 * FluxFilm - "one real login = one account" for the 💰 Profit page.
 *
 * INVENTORY_ACCOUNTS lists the same real login several times (see logins.js):
 *   · once per duration it is sold for  — Zee5 `Z5-01` appears 4×  (1M / 3M / 6M / 1Y)
 *   · sometimes under different AccountIDs — JioHotstar `JH-3M-02` / `JH-6M-02` / `JH-1Y-02`
 *     are one login (8076332049)
 * The profit view used to walk those rows one by one, so an account's cost was charged
 * once PER ROW: a ₹2,200/year Zee5 login was counted 4 times and a ₹500/year JioHotstar
 * login 3 times. Capacity and occupancy already group per login (logins.js) - money now
 * does the same here.
 *
 * Grouping key (inside one service family, so the same Gmail on two services stays two accounts):
 *   login set        → 'L:' + LOWER(TRIM(login))     — merges different AccountIDs on one login
 *   no login         → '#'  + id without case/spaces — merges "Z5-01" / "z5 01" / "Z5_01"
 *
 * The cost note also carries settings, so no schema change is needed (account_costs is
 * schema-v14: service, account_id, monthly_cost, note, UNIQUE(service, account_id)):
 *   "[billing:12:2200][stopped:2026-09-30] my note"
 *   billing:<every months>:<amount>   monthly_cost always holds the monthly equivalent
 *   stopped:<YYYY-MM-DD>              the day the owner stopped paying for this login;
 *                                     the cost counts up to that date and not after it.
 */
const { loginKey } = require('./logins');

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
/** "Z5-01" / "z5 01" / "Z5_01" all become "z501". */
const normId = (v) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
const EVERY = [1, 3, 6, 12];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Read "[billing:12:2200][stopped:2026-09-30] note" (tags in any order). */
function parseCostNote(note, monthly) {
  let rest = s(note); let every = null, amount = null, stoppedOn = '';
  for (let i = 0; i < 3; i++) {
    const m = rest.match(/^\[(billing|stopped):([^\]]*)\]\s*/);
    if (!m) break;
    if (m[1] === 'billing') {
      const b = m[2].match(/^(\d+):([\d.]+)$/);
      if (b && EVERY.includes(Number(b[1]))) { every = Number(b[1]); amount = num(b[2]); }
    } else if (DATE_RE.test(s(m[2]))) stoppedOn = s(m[2]);
    rest = rest.slice(m[0].length);
  }
  if (every == null) { every = 1; amount = num(monthly); }
  return { every, amount, stoppedOn, note: rest };
}
/** The other way round. Keeps the tags first so parseCostNote always finds them. */
function buildCostNote(every, amount, stoppedOn, userNote) {
  const head = (EVERY.includes(Number(every)) && Number(every) !== 1 ? '[billing:' + Number(every) + ':' + r2(num(amount)) + ']' : '') +
    (DATE_RE.test(s(stoppedOn)) ? '[stopped:' + s(stoppedOn) + ']' : '');
  return (head + (head && s(userNote) ? ' ' : '') + s(userNote)).slice(0, 300);
}

/**
 * How much of a period a cost still applies for: 1 while the owner is paying,
 * 0 once they stopped before the period, the part before the date in between.
 * range { from, to } are 'YYYY-MM-DD 00:00:00' India-time strings.
 */
function costFactor(stoppedOn, range) {
  if (!DATE_RE.test(s(stoppedOn))) return 1;
  const stop = Date.parse(s(stoppedOn) + 'T00:00:00+05:30');
  const from = Date.parse(s(range.from).replace(' ', 'T').slice(0, 19) + '+05:30');
  const to = Date.parse(s(range.to).replace(' ', 'T').slice(0, 19) + '+05:30');
  if (!(stop > from)) return 0;
  if (stop >= to) return 1;
  return (stop - from) / (to - from);
}

/** Natural-ish order so "JH-1Y-02" sorts before "JH-3M-02" and "A2" before "A10". */
function natural(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * accounts : inventory_accounts rows { service, account_id, login_id, is_active }
 * costs    : account_costs rows      { service, account_id, monthly_cost, note }
 * family   : service -> family word  (profit.js)
 *
 * Returns { groups, byId } where byId maps family + '|' + normId(accountId) to its group,
 * so orders / occupancy (which only know an id) can find the real login account.
 */
function buildAccountGroups(accounts, costs, family) {
  const groups = [];
  const byKey = new Map();
  const byId = new Map();
  const get = (key) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, family: key.split('|')[0], services: [], ids: [], normIds: [], logins: [], rows: 0, isActive: false, costRows: [] };
      byKey.set(key, g); groups.push(g);
    }
    return g;
  };
  for (const a of accounts || []) {
    const id = s(a.account_id); if (!id) continue;
    const fam = family(a.service);
    const lk = loginKey(a.login_id);
    const g = get(fam + '|' + (lk ? 'L:' + lk : '#' + normId(id)));
    g.rows++;
    if (!g.services.includes(s(a.service))) g.services.push(s(a.service));
    if (!g.ids.includes(id)) g.ids.push(id);
    if (!g.normIds.includes(normId(id))) g.normIds.push(normId(id));
    if (lk && !g.logins.includes(s(a.login_id))) g.logins.push(s(a.login_id));
    if (s(a.is_active).toUpperCase() === 'TRUE') g.isActive = true;
    byId.set(fam + '|' + normId(id), g);
  }
  // Cost rows join by (family, id) - never by a SQL JOIN, the tables do not share a collation.
  for (const c of costs || []) {
    const g = byId.get(family(c.service) + '|' + normId(c.account_id));
    if (!g) continue; // cost for an account that is no longer in inventory: ignored, as before
    const p = parseCostNote(c.note, c.monthly_cost);
    // `exact` keeps the unrounded monthly figure: medians and sums are taken on it, so
    // 3 × ₹500 / year adds back to exactly ₹1,500 and not ₹1,500.12.
    g.costRows.push({ service: s(c.service), accountId: s(c.account_id), every: p.every, amount: r2(p.amount), monthly: r2(p.amount / p.every), exact: num(p.amount) / p.every, stoppedOn: p.stoppedOn, note: p.note });
  }
  for (const g of groups) {
    g.ids.sort(natural); g.normIds.sort(); g.services.sort();
    g.accountId = g.ids[0] || '';
    g.service = g.services[0] || '';
    g.login = g.logins[0] || '';
    g.sameLogin = g.ids.length > 1;       // one login listed under several AccountIDs
    g.repeatedRows = g.rows > g.ids.length; // the same AccountID listed once per duration
    // Several cost rows for one login: the biggest one wins and is counted ONCE. The others
    // are reported so the panel can offer a one-tap merge.
    g.costRows.sort((x, y) => (y.monthly - x.monthly) || natural(x.service + '|' + x.accountId, y.service + '|' + y.accountId));
    const chosen = g.costRows[0] || null;
    g.cost = chosen;
    g.extraCostRows = g.costRows.slice(1);
    g.monthly = chosen ? chosen.monthly : null;
    g.stoppedOn = chosen ? chosen.stoppedOn : '';
    // Where the panel writes a cost: the row that already exists, else the display id.
    g.costKey = chosen ? { service: chosen.service, accountId: chosen.accountId } : { service: g.service, accountId: g.accountId };
    // Several rows can mean two opposite things - see annotateCostShape.
    g.monthlyExact = chosen ? chosen.exact : null;
    g.sumExact = g.costRows.reduce((t, c) => t + c.exact, 0);
    g.sumMonthly = r2(g.sumExact);
  }
  annotateCostShape(groups);
  return { groups, byId };
}

// ---------------------------------------------------------------- "is this login's cost right?"
const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); if (!a.length) return null; const h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };
const modeOf = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); let best = null, n = -1; for (const [k, v] of c) if (v > n || (v === n && k > best)) { best = k; n = v; } return best; };
const close = (a, b, frac) => b > 0 && Math.abs(a - b) <= b * frac;
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const PER = { 1: 'month', 3: '3 months', 6: '6 months', 12: 'year' };

/**
 * Two cost rows on one login can mean two OPPOSITE things:
 *   · the owner typed the SAME cost on each row      -> they are duplicates, keep one
 *   · the owner SPLIT the real cost across the rows  -> add them up
 * JioHotstar 8076332049 is the second kind: the owner divided his real ₹1,500/year over the
 * three inventory rows as 3 × ₹500. The shop's other JioHotstar logins pay ₹1,499/year, which
 * is how we can tell the two shapes apart and pre-select the right answer.
 *
 * Sets on every group:
 *   typical    { monthly, every, amount, logins }  what the other logins of this service pay
 *   lowCost    true when this login costs less than half of that and could be a split
 *   suggestion { mode: 'keep' | 'sum' | 'manual', why, keep, sum }  for the 🔗 Merge dialog
 */
function annotateCostShape(groups) {
  const byFamily = new Map();
  for (const g of groups) { if (!byFamily.has(g.family)) byFamily.set(g.family, []); byFamily.get(g.family).push(g); }
  for (const g of groups) {
    const others = (byFamily.get(g.family) || []).filter((o) => o !== g && o.monthly > 0);
    const typicalMonthly = median(others.map((o) => o.monthlyExact));
    if (typicalMonthly != null) {
      const every = modeOf(others.map((o) => (o.cost && o.cost.every) || 1));
      g.typical = { monthly: r2(typicalMonthly), every, amount: r2(typicalMonthly * every), exact: typicalMonthly, logins: others.length };
    } else g.typical = null;
    // Far below what the rest of this service costs, on a login that HAS more than one row or
    // cost row: exactly the shape of "I divided the amount across the inventory rows".
    // A single-row login that is simply a cheaper plan (a ₹400 Netflix next to ₹649 ones) is left alone.
    g.lowCost = !!(g.typical && g.typical.logins >= 2 && g.monthlyExact > 0 && g.monthlyExact < g.typical.exact * 0.5 &&
      (g.costRows.length > 1 || g.rows > 1 || g.ids.length > 1));
    g.suggestion = suggestMerge(g);
  }
  return groups;
}

/** Which of the three answers the 🔗 Merge dialog pre-selects, and why, in one line. */
function suggestCore(costRows, keepMonthly, sumMonthly, typical) {
  const n = costRows.length;
  const allSame = n > 1 && costRows.every((c) => c.amount === costRows[0].amount && c.every === costRows[0].every);
  if (!typical || !typical.logins) {
    return { mode: allSame ? 'keep' : 'sum',
      why: allSame ? 'Every row has the same amount, so they look like one cost typed ' + n + ' times.' : 'The rows have different amounts, so they look like one cost split between them.' };
  }
  const per = PER[typical.every] || 'month';
  const head = 'Your other ' + typical.logins + ' ' + (typical.logins === 1 ? 'login' : 'logins') + ' for this service cost about ' + inr(typical.amount) + ' / ' + per + ', so ';
  if (allSame && close(keepMonthly, typical.monthly, 0.2)) return { mode: 'keep', why: head + 'each of these ' + n + ' rows already looks like the whole cost — the same thing typed ' + n + ' times.' };
  if (n > 1 && close(sumMonthly, typical.monthly, 0.2)) {
    return { mode: 'sum', why: head + 'these ' + n + ' × ' + inr(costRows[0].amount) + ' rows look like one ' + inr(costRows.reduce((t, c) => t + (c.exact == null ? c.monthly : c.exact), 0) * typical.every) + ' / ' + per + ' cost split ' + n + ' ways.' };
  }
  const keepOff = Math.abs(keepMonthly - typical.monthly), sumOff = Math.abs(sumMonthly - typical.monthly);
  if (Math.min(keepOff, sumOff) > typical.monthly * 0.5) return { mode: 'manual', why: head + 'neither keeping one row nor adding them up comes close — type what you really pay.' };
  return keepOff <= sumOff ? { mode: 'keep', why: head + 'keeping one row is the closer match.' }
    : { mode: 'sum', why: head + 'adding the rows up is the closer match.' };
}
function suggestMerge(g) {
  if (!g.costRows.length) return null;
  const keep = g.cost;
  const one = g.costRows.length === 1;
  const core = suggestCore(g.costRows, g.monthly, g.sumMonthly, g.typical);
  return {
    mode: one ? 'manual' : core.mode,
    why: one ? 'This login has one cost row, so there is nothing to add up — type what you really pay.' : core.why,
    rows: g.costRows.length,
    keep: { amount: keep.amount, every: keep.every, monthly: keep.monthly },
    // Rows can be billed over different periods, so the MONTHLY figures are added and shown
    // back in the kept row's period.
    sum: { amount: r2(g.sumExact * keep.every), every: keep.every, monthly: r2(g.sumExact) },
    typical: g.typical,
  };
}

module.exports = { normId, loginKey, parseCostNote, buildCostNote, costFactor, buildAccountGroups, annotateCostShape, suggestCore, natural, EVERY };
