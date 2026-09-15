/**
 * FluxFilm - "Expired customers still on accounts" (admin Today, 🚪 Remove users, 📦 Stock per-account badge).
 * One source of truth: GET /admin/api/remove-users (adminexpired.js) = load() + summarize().
 *
 * The owner trusts the old Sheet DASHBOARD, so this is its rule (checked 2026-09-15 against the Sheet: Netflix 15):
 *   - Grouped per real account LOGIN (a login listed under two account IDs is one account), per service family
 *     (Netflix + Netflix (Group Offer) share logins; Prime Video + Prime Video + Shopping too).
 *   - Pending = subscriptions on that login whose expiry has passed, not ticked "removed", not refunded/cancelled,
 *     and not superseded by the same customer's renewal on the same login (renew_sub_id, or the same phone with an
 *     active subscription there). NO day cap — someone expired 90 days ago can still be watching.
 *   - Only logins that still have at least one ACTIVE subscription (status ACTIVE, expiry in the future) need
 *     "⚠️ Remove N expired users (names)". A login nobody active uses is "✅ Safe → reset devices / change the
 *     password"; its old users are listed separately and do NOT count in the Today number.
 *   - Netflix / Prime Video and any other PROFILE / CAPACITY service are the main list. Whole-account / OTP services
 *     (Zee5, JioHotstar, SonyLiv, Crunchyroll, YouTube) are a separate, collapsed section with their own counts.
 *
 *
 * WHEN to change the password (owner, 15 Sep): the only way to log someone out is a new password, which disturbs the
 * active customers, so batch it. Every listed login gets an `advice` (adviceFor):
 *   NOW       "🔑 Change password now": nobody active, OR inactive ≥ rules.minInactive AND the next active expiry is
 *             ≥ rules.minDays IST calendar days away.
 *   WAIT_DATE "⏳ Wait — change on 17 Sep": the next active expiry is sooner than minDays. The date (plan) is the first
 *             active expiry day on which the rule above holds (two expiries a few days apart = one change, not two).
 *   WAIT_FEW  "⏳ Wait — only 1 inactive": fewer inactive than minInactive and the next expiry is far; plan = the day
 *             it becomes worth it.
 * The thresholds are owner-editable in admin (app_settings 'remove_users_rules', loadRules / saveRules).
 *
 * compute() is pure (tested against an anonymised copy of the live data); load() reads MySQL and calls it.
 */
const { loginKey } = require('./logins');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }

/** Whole-account / OTP style services: shown in their own collapsed section. */
const OTHER_SERVICES = /zee5|hotstar|sony|crunchyroll|youtube/i;
/** Rows that never gave (or no longer give) anyone access. */
const EXCLUDED_STATUS = ['REFUNDED', 'CANCELLED', 'CANCELED', 'ERASED'];

function familyOf(service) {
  const v = s(service).toLowerCase();
  if (v.includes('netflix')) return 'Netflix';
  if (v.includes('prime')) return 'Prime Video';
  return s(service) || 'Other';
}
/** 'main' (Netflix / Prime / PROFILE / CAPACITY) or 'other' (whole-account, OTP, manual). */
function sectionOf(service, policy) {
  if (OTHER_SERVICES.test(s(service))) return 'other';
  if (/netflix|prime/i.test(s(service))) return 'main';
  const p = up(policy);
  return p === 'PROFILE' || p === 'CAPACITY' ? 'main' : 'other';
}
const accountOfRef = (ref) => { const r = s(ref); const cut = r.indexOf('#'); return cut >= 0 ? r.slice(0, cut) : r; };

/** India-time 'YYYY-MM-DD HH:MM:SS' (how the database stores dates) or a Date → ms. */
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  const t = s(v);
  if (/Z$|[+-]\d\d:?\d\d$/.test(t)) return new Date(t).getTime();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 5.5 * 3600e3;
}

/* ---------- password-change timing ---------- */
const RULES_KEY = 'remove_users_rules';
const DEFAULT_RULES = Object.freeze({ minInactive: 3, minDays: 10 });
const RULE_LIMITS = { minInactive: [1, 50], minDays: [0, 60] };
function validateRules(input, prev) {
  const inb = input || {}; const errors = [];
  const out = Object.assign({}, DEFAULT_RULES, prev || {});
  for (const k of Object.keys(RULE_LIMITS)) {
    if (inb[k] === undefined || inb[k] === null || s(inb[k]) === '') continue;
    const n = Number(inb[k]); const [lo, hi] = RULE_LIMITS[k];
    if (!Number.isInteger(n) || n < lo || n > hi) errors.push((k === 'minInactive' ? 'Min inactive users' : 'Min days until next expiry') + ' must be a whole number from ' + lo + ' to ' + hi + '.');
    else out[k] = n;
  }
  return { ok: !errors.length, rules: out, errors };
}
/** Saved thresholds (any problem → defaults, so the list always loads). q = db.query-style. */
async function loadRules(q) {
  try {
    const rows = await q('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [RULES_KEY]);
    if (!Array.isArray(rows) || !rows.length || !rows[0] || typeof rows[0].value !== 'string') return Object.assign({}, DEFAULT_RULES);
    const v = validateRules(JSON.parse(rows[0].value));
    return v.ok ? v.rules : Object.assign({}, DEFAULT_RULES);
  } catch (_) { return Object.assign({}, DEFAULT_RULES); }
}
async function saveRules(q, input) {
  const before = await loadRules(q);
  const v = validateRules(input, before);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  await q('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [RULES_KEY, JSON.stringify(v.rules)]);
  const changed = Object.keys(DEFAULT_RULES).filter((k) => before[k] !== v.rules[k]);
  return { ok: true, rules: v.rules, before, changed };
}

/** IST calendar day number (days since 1970-01-01, India time). */
const istDay = (ms) => Math.floor((ms + 5.5 * 3600e3) / 86400e3);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayInfo(day, today) {
  const d = new Date(day * 86400e3);
  const days = day - today;
  return { date: d.toISOString().slice(0, 10), label: d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()], days, when: days <= 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days' };
}

/**
 * The recommendation for one login. inactive = expired, not removed, not renewed (the listed people);
 * actives = [{ ms, name }] for each ACTIVE subscription on the login (isActive, the same rule as the list).
 */
function adviceFor(inactive, actives, now, rules) {
  const r = validateRules(rules).rules;
  if (!(inactive > 0)) return { kind: 'NONE', inactive: 0 };
  const today = istDay(now);
  const list = (actives || []).map((a) => ({ day: istDay(a.ms), name: s(a.name) })).filter((x) => isFinite(x.day)).sort((a, b) => a.day - b.day);
  if (!list.length) return { kind: 'NOW', reason: 'NOBODY', inactive, active: 0, nextExpiry: null, plan: null };
  const first = list[0].day;
  const sharing = list.filter((x) => x.day === first);
  const nextExpiry = Object.assign(dayInfo(first, today), { count: sharing.length, name: sharing[0].name });
  const days = first - today;
  if (inactive >= r.minInactive && days >= r.minDays) return { kind: 'NOW', reason: 'READY', inactive, active: list.length, nextExpiry, plan: null };
  // Plan: the first active expiry day after which the rule holds (everyone ending that day counts as inactive).
  let plan = null;
  const distinct = [...new Set(list.map((x) => x.day))];
  for (let i = 0; i < distinct.length && !plan; i++) {
    const d = distinct[i];
    const endedBy = list.filter((x) => x.day <= d).length;
    const left = list.length - endedBy;
    const next = distinct[i + 1];
    if (!left || (inactive + endedBy >= r.minInactive && next - d >= r.minDays)) plan = Object.assign(dayInfo(d, today), { inactive: inactive + endedBy, activeLeft: left, nextAfter: next == null ? null : dayInfo(next, today) });
  }
  return { kind: days < r.minDays ? 'WAIT_DATE' : 'WAIT_FEW', inactive, active: list.length, nextExpiry, plan };
}
const ADVICE_ORDER = { NOW: 0, WAIT_DATE: 1, WAIT_FEW: 2, NONE: 3 };

const isRemoved = (x) => Number(x.removed) === 1 || x.removed === true || up(x.removed) === 'TRUE';
const isActive = (x, now) => up(x.status) === 'ACTIVE' && toMs(x.expiry_date) > now;
const isExpired = (x, now) => toMs(x.expiry_date) < now;

/** "Profile 3" (from NFLX-D1#P3) / "2 devices · TV" (Prime, device-aware) / '' when unknown. */
function slotOf(x) {
  const m = s(x.inventory_ref).match(/#P(\d+)/i);
  if (m) return 'Profile ' + m[1];
  const n = Number(x.device_count) || 0;
  const tv = Number(x.tv_count) || (up(x.device_type) === 'TV' ? n || 1 : 0);
  const parts = [];
  if (n) parts.push(n + ' device' + (n === 1 ? '' : 's'));
  if (tv) parts.push(tv === n ? 'TV' : tv + ' TV');
  else if (s(x.device_type)) parts.push(s(x.device_type).toLowerCase());
  return parts.join(' · ');
}

function nameOf(x) {
  const n = s(x.name) || s(rawOf(x.raw_json).Name);
  return n || (s(x.phone_norm) ? '…' + s(x.phone_norm).slice(-4) : '?');
}

/**
 * input: { subs, accounts, policyOf?: { [serviceLower]: policy }, now?: Date|ms }
 *   subs: { sub_id, order_id, phone_norm, name?, service, plan, status, expiry_date, inventory_ref, account_id,
 *           login_id, removed, renew_sub_id, raw_json? }
 *   accounts: { account_id, login_id, service }
 */
function compute(input) {
  const inp = input || {};
  const now = inp.now == null ? Date.now() : (inp.now instanceof Date ? inp.now.getTime() : Number(inp.now));
  const policyOf = inp.policyOf || {};
  const rules = validateRules(inp.rules).rules;
  const accLogin = new Map(), accLoginRaw = new Map(), accService = new Map();
  for (const a of inp.accounts || []) {
    const id = s(a.account_id); if (!id) continue;
    if (!accService.has(id) && s(a.service)) accService.set(id, s(a.service));
    if (!accLogin.has(id) || !accLogin.get(id)) { accLogin.set(id, loginKey(a.login_id)); accLoginRaw.set(id, s(a.login_id)); }
  }

  const groups = new Map();
  for (const x of inp.subs || []) {
    if (EXCLUDED_STATUS.includes(up(x.status))) continue;
    const accId = accountOfRef(x.inventory_ref) || s(x.account_id);
    const login = loginKey(x.login_id) || accLogin.get(accId) || '';
    if (!login && !accId) continue; // never placed on an account (manual placeholder)
    const family = familyOf(x.service);
    const key = family + '|' + (login ? 'L:' + login : 'id:' + accId);
    let g = groups.get(key);
    if (!g) {
      g = { key, family, section: sectionOf(x.service, policyOf[s(x.service).toLowerCase()]), login, loginLabel: '', accountIds: new Set(), services: new Set(), active: [], expired: [] };
      groups.set(key, g);
    }
    if (!g.loginLabel) g.loginLabel = s(x.login_id) || accLoginRaw.get(accId) || '';
    if (sectionOf(x.service, policyOf[s(x.service).toLowerCase()]) === 'main') g.section = 'main';
    if (accId) g.accountIds.add(accId);
    g.services.add(s(x.service));
    if (isActive(x, now)) g.active.push(x);
    else if (isExpired(x, now) && !isRemoved(x)) g.expired.push(x);
  }

  const out = {
    now: new Date(now).toISOString(),
    rules,
    main: { pending: 0, accountsToFix: 0, safeAccounts: 0, safeOldUsers: 0, byFamily: {}, groups: [] },
    other: { pending: 0, accountsToFix: 0, safeAccounts: 0, safeOldUsers: 0, byFamily: {}, groups: [] },
    byAccount: {},
  };
  for (const g of groups.values()) {
    // Renewed by the same customer on this login: the old row is history, not someone to remove.
    const renewedIds = new Set(g.active.map((a) => s(a.renew_sub_id)).filter(Boolean));
    const activePhones = new Set(g.active.map((a) => s(a.phone_norm)).filter(Boolean));
    const pending = g.expired.filter((x) => !renewedIds.has(s(x.sub_id)) && !(s(x.phone_norm) && activePhones.has(s(x.phone_norm))));
    if (!pending.length && !g.active.length) continue;
    const sec = out[g.section];
    const hasActive = g.active.length > 0;
    pending.sort((a, b) => toMs(b.expiry_date) - toMs(a.expiry_date));
    const people = pending.map((x) => ({ subId: s(x.sub_id), orderId: s(x.order_id), name: nameOf(x), phone: s(x.phone_norm), service: s(x.service), plan: s(x.plan), expiry: s(x.expiry_date instanceof Date ? x.expiry_date.toISOString() : x.expiry_date), daysAgo: Math.max(0, Math.floor((now - toMs(x.expiry_date)) / 86400e3)), accountRef: s(x.inventory_ref), accountId: accountOfRef(x.inventory_ref) || s(x.account_id), slot: slotOf(x) }));
    const advice = adviceFor(pending.length, g.active.map((a) => ({ ms: toMs(a.expiry_date), name: nameOf(a) })), now, rules);
    const blank = () => ({ pending: 0, oldUsers: 0, hasActive: false, advice: 'NONE', changeOn: '' });
    for (const p of people) {
      const b = out.byAccount[p.accountId] || (out.byAccount[p.accountId] = blank());
      if (hasActive) b.pending++; else b.oldUsers++;
    }
    for (const id of g.accountIds) {
      const b = out.byAccount[id] || (out.byAccount[id] = blank());
      if (hasActive) b.hasActive = true;
      if (pending.length) { b.advice = advice.kind; b.changeOn = advice.plan ? advice.plan.label : ''; }
    }
    if (!pending.length) continue;
    const row = { key: g.key, family: g.family, login: g.login, loginLabel: g.loginLabel || g.login, accountIds: [...g.accountIds].sort(), accountServices: Object.fromEntries([...g.accountIds].map((id) => [id, accService.get(id) || [...g.services][0] || ''])), services: [...g.services].sort(), activeCount: g.active.length, count: pending.length, action: hasActive ? 'REMOVE' : 'SAFE', advice, people };
    sec.groups.push(row);
    if (hasActive) {
      sec.pending += pending.length; sec.accountsToFix++;
      sec.byFamily[g.family] = (sec.byFamily[g.family] || 0) + pending.length;
    } else { sec.safeAccounts++; sec.safeOldUsers += pending.length; }
  }
  // 🔑 Change now first (most inactive first), then ⏳ Wait by planned date, then the rest by the day it becomes worth it.
  const planDay = (g) => (g.advice.plan ? g.advice.plan.date : '9999');
  const order = (a, b) => (ADVICE_ORDER[a.advice.kind] - ADVICE_ORDER[b.advice.kind]) ||
    (a.advice.kind === 'NOW' ? b.count - a.count : planDay(a).localeCompare(planDay(b))) ||
    a.family.localeCompare(b.family) || String(a.accountIds[0] || a.login).localeCompare(String(b.accountIds[0] || b.login));
  out.main.groups.sort(order); out.other.groups.sort(order);
  return out;
}

/** One line per "change now" account for the Today card: "NFLX-D3 · 5 active, 3 inactive: Ashu C, Saumil A". */
function todayNames(result, max) {
  return result.main.groups.filter((g) => g.advice && g.advice.kind === 'NOW').slice(0, max || 50)
    .map((g) => (g.accountIds.join('/') || g.login) + ' · ' + (g.activeCount ? g.activeCount + ' active, ' : 'nobody active, ') + g.count + ' inactive: ' + g.people.map((p) => p.name).join(', '));
}

/**
 * The numbers every admin screen shows (Today, 🚪 Remove users, 📦 Stock), with explicit units:
 *   customers  = expired customers to log out, on logins that still have active customers (main list)
 *   accounts   = how many account logins those customers are on (a login under two IDs counts once)
 *   safeAccounts / safeUsers = logins nobody active uses (reset the password) and their old users (not counted)
 *   other      = the same for whole-account / OTP services (Zee5, JioHotstar, SonyLiv, Crunchyroll, YouTube)
 *   changeNow  = { accounts, inactive, nobodyActive }  logins to change the password on NOW (the Today "to do" number)
 *   wait       = { accounts, inactive, next: {date,label} }  logins waiting for a planned date (soonest date)
 *   later      = { accounts, inactive }  too few inactive for now, next expiry far
 */
function summarize(result) {
  const r = result || {};
  const part = (sec) => {
    const x = sec || {}; const byFamily = {};
    const changeNow = { accounts: 0, inactive: 0, nobodyActive: 0 }, wait = { accounts: 0, inactive: 0, next: null }, later = { accounts: 0, inactive: 0 };
    for (const g of x.groups || []) {
      const kind = (g.advice && g.advice.kind) || (g.action === 'SAFE' ? 'NOW' : 'WAIT_FEW');
      if (kind === 'NOW') { changeNow.accounts++; changeNow.inactive += g.count; if (!g.activeCount) changeNow.nobodyActive++; }
      else if (kind === 'WAIT_DATE') {
        wait.accounts++; wait.inactive += g.count;
        const p = g.advice.plan; if (p && (!wait.next || p.date < wait.next.date)) wait.next = { date: p.date, label: p.label };
      } else if (kind === 'WAIT_FEW') { later.accounts++; later.inactive += g.count; }
      if (g.action !== 'REMOVE') continue;
      const f = byFamily[g.family] || (byFamily[g.family] = { customers: 0, accounts: 0 });
      f.customers += g.count; f.accounts++;
    }
    return { customers: Number(x.pending) || 0, accounts: Number(x.accountsToFix) || 0, safeAccounts: Number(x.safeAccounts) || 0, safeUsers: Number(x.safeOldUsers) || 0, byFamily, changeNow, wait, later };
  };
  const main = part(r.main);
  return Object.assign({}, main, { todo: todoLine(main), other: part(r.other), rules: validateRules(r.rules).rules });
}

/** "3 accounts to change now · 5 waiting (next 17 Sep)" — the one sentence Today and Stock both show. */
function todoLine(c) {
  const x = c || {}; const now = (x.changeNow && x.changeNow.accounts) || 0; const w = x.wait || {};
  return now + ' account' + (now === 1 ? '' : 's') + ' to change now' + (w.accounts ? ' · ' + w.accounts + ' waiting' + (w.next ? ' (next ' + w.next.label + ')' : '') : '');
}

// Only rows that can matter: active ones (to know who is still on a login) and expired rows not yet ticked removed.
const SUBS_SQL =
  "SELECT s.sub_id, s.order_id, s.phone_norm, s.service, s.plan, s.status, s.expiry_date, s.inventory_ref, s.account_id, s.login_id, COALESCE(s.removed, 0) AS removed, s.renew_sub_id, s.device_count, s.device_type, s.tv_count, " +
  '(SELECT c.name FROM customers c WHERE c.phone_norm = s.phone_norm LIMIT 1) AS name ' +
  "FROM subscriptions s WHERE (COALESCE(s.inventory_ref, '') <> '' OR COALESCE(s.login_id, '') <> '') " +
  "AND ((UPPER(s.status) = 'ACTIVE' AND s.expiry_date > NOW()) OR (s.expiry_date < NOW() AND COALESCE(s.removed, 0) = 0))";

/** Read MySQL and apply the rule. q = db.query-style (sql, params) → rows. */
async function load(q, opts) {
  const o = opts || {};
  const [subs, accounts, plans, rules] = await Promise.all([
    q(SUBS_SQL, []),
    q('SELECT account_id, login_id, service FROM inventory_accounts', []).catch(() => []),
    q('SELECT service, raw_json FROM plans', []).catch(() => []),
    o.rules ? Promise.resolve(o.rules) : loadRules(q),
  ]);
  const policyOf = {};
  for (const p of Array.isArray(plans) ? plans : []) {
    const k = s(p.service).toLowerCase(); const pol = up(rawOf(p.raw_json).AllocationPolicy);
    if (k && pol && !policyOf[k]) policyOf[k] = pol;
  }
  return compute({ subs: Array.isArray(subs) ? subs : [], accounts: Array.isArray(accounts) ? accounts : [], policyOf, rules, now: o.now });
}

module.exports = { compute, load, summarize, todayNames, todoLine, adviceFor, istDay, validateRules, loadRules, saveRules, DEFAULT_RULES, RULES_KEY, slotOf, familyOf, sectionOf, toMs, SUBS_SQL, OTHER_SERVICES };
