/**
 * FluxFilm - "Expired customers still on accounts" (admin Today, 📦 Stock, per account).
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

const isRemoved = (x) => Number(x.removed) === 1 || x.removed === true || up(x.removed) === 'TRUE';
const isActive = (x, now) => up(x.status) === 'ACTIVE' && toMs(x.expiry_date) > now;
const isExpired = (x, now) => toMs(x.expiry_date) < now;

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
  const accLogin = new Map();
  for (const a of inp.accounts || []) {
    const id = s(a.account_id); if (!id) continue;
    if (!accLogin.has(id) || !accLogin.get(id)) accLogin.set(id, loginKey(a.login_id));
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
      g = { key, family, section: sectionOf(x.service, policyOf[s(x.service).toLowerCase()]), login, accountIds: new Set(), services: new Set(), active: [], expired: [] };
      groups.set(key, g);
    }
    if (sectionOf(x.service, policyOf[s(x.service).toLowerCase()]) === 'main') g.section = 'main';
    if (accId) g.accountIds.add(accId);
    g.services.add(s(x.service));
    if (isActive(x, now)) g.active.push(x);
    else if (isExpired(x, now) && !isRemoved(x)) g.expired.push(x);
  }

  const out = {
    now: new Date(now).toISOString(),
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
    const people = pending.map((x) => ({ subId: s(x.sub_id), orderId: s(x.order_id), name: nameOf(x), phone: s(x.phone_norm), service: s(x.service), plan: s(x.plan), expiry: s(x.expiry_date instanceof Date ? x.expiry_date.toISOString() : x.expiry_date), accountRef: s(x.inventory_ref), accountId: accountOfRef(x.inventory_ref) || s(x.account_id) }));
    for (const p of people) {
      const b = out.byAccount[p.accountId] || (out.byAccount[p.accountId] = { pending: 0, oldUsers: 0, hasActive: false });
      if (hasActive) b.pending++; else b.oldUsers++;
    }
    for (const id of g.accountIds) {
      const b = out.byAccount[id] || (out.byAccount[id] = { pending: 0, oldUsers: 0, hasActive: false });
      if (hasActive) b.hasActive = true;
    }
    if (!pending.length) continue;
    const row = { key: g.key, family: g.family, login: g.login, accountIds: [...g.accountIds].sort(), services: [...g.services].sort(), activeCount: g.active.length, count: pending.length, action: hasActive ? 'REMOVE' : 'SAFE', people };
    sec.groups.push(row);
    if (hasActive) {
      sec.pending += pending.length; sec.accountsToFix++;
      sec.byFamily[g.family] = (sec.byFamily[g.family] || 0) + pending.length;
    } else { sec.safeAccounts++; sec.safeOldUsers += pending.length; }
  }
  const order = (a, b) => (a.action === b.action ? 0 : a.action === 'REMOVE' ? -1 : 1) || a.family.localeCompare(b.family) || String(a.accountIds[0] || a.login).localeCompare(String(b.accountIds[0] || b.login));
  out.main.groups.sort(order); out.other.groups.sort(order);
  return out;
}

/** One line per account for the Today card: "NFLX-D3 · remove 2: Ashu C, Saumil A". */
function todayNames(result, max) {
  return result.main.groups.filter((g) => g.action === 'REMOVE').slice(0, max || 50)
    .map((g) => (g.accountIds.join('/') || g.login) + ' · remove ' + g.count + ': ' + g.people.map((p) => p.name).join(', '));
}

// Only rows that can matter: active ones (to know who is still on a login) and expired rows not yet ticked removed.
const SUBS_SQL =
  "SELECT s.sub_id, s.order_id, s.phone_norm, s.service, s.plan, s.status, s.expiry_date, s.inventory_ref, s.account_id, s.login_id, COALESCE(s.removed, 0) AS removed, s.renew_sub_id, " +
  '(SELECT c.name FROM customers c WHERE c.phone_norm = s.phone_norm LIMIT 1) AS name ' +
  "FROM subscriptions s WHERE (COALESCE(s.inventory_ref, '') <> '' OR COALESCE(s.login_id, '') <> '') " +
  "AND ((UPPER(s.status) = 'ACTIVE' AND s.expiry_date > NOW()) OR (s.expiry_date < NOW() AND COALESCE(s.removed, 0) = 0))";

/** Read MySQL and apply the rule. q = db.query-style (sql, params) → rows. */
async function load(q, opts) {
  const o = opts || {};
  const [subs, accounts, plans] = await Promise.all([
    q(SUBS_SQL, []),
    q('SELECT account_id, login_id, service FROM inventory_accounts', []).catch(() => []),
    q('SELECT service, raw_json FROM plans', []).catch(() => []),
  ]);
  const policyOf = {};
  for (const p of Array.isArray(plans) ? plans : []) {
    const k = s(p.service).toLowerCase(); const pol = up(rawOf(p.raw_json).AllocationPolicy);
    if (k && pol && !policyOf[k]) policyOf[k] = pol;
  }
  return compute({ subs: Array.isArray(subs) ? subs : [], accounts: Array.isArray(accounts) ? accounts : [], policyOf, now: o.now });
}

module.exports = { compute, load, todayNames, familyOf, sectionOf, toMs, SUBS_SQL, OTHER_SERVICES };
