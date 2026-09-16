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
    g.costRows.push({ service: s(c.service), accountId: s(c.account_id), every: p.every, amount: r2(p.amount), monthly: r2(p.amount / p.every), stoppedOn: p.stoppedOn, note: p.note });
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
  }
  return { groups, byId };
}

module.exports = { normId, loginKey, parseCostNote, buildCostNote, costFactor, buildAccountGroups, natural, EVERY };
