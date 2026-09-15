/**
 * FluxFilm - "when was the password last changed" for each streaming account (admin 🔑 Password change + 🚪 Remove users).
 *
 * Where the date comes from (first one found wins):
 *   1. inventory_accounts.raw_json.PasswordChangedAt   written by every admin password change from now on (IST datetime)
 *   2. audit_log action 'account.passwordChange'        the newest change-log entry that lists this account id
 *   3. inventory_accounts.raw_json.LastPassChangedOn   the old Google-Sheet column (imported, ISO date)
 *   otherwise unknown.
 *
 * raw_json.PasswordHistory keeps the last 10 change times (dates only — never a password).
 * There is no typed column for this on inventory_accounts, so raw_json is the one place it is stored.
 * Every read is a separate single-table query matched in JS (MariaDB collation lesson: no cross-table JOIN).
 */
const s = (v) => String(v == null ? '' : v).trim();
const PWD_KEY = 'PasswordChangedAt';
const HISTORY_KEY = 'PasswordHistory';
const LEGACY_KEY = 'LastPassChangedOn';
const HISTORY_MAX = 10;
const AUDIT_ACTION = 'account.passwordChange';
const STALE_DAYS = 30;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST = 5.5 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');

function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { const j = JSON.parse(v); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (_) { return {}; } }

/** 'YYYY-MM-DD HH:MM:SS' (IST, how the database stores dates) / ISO with zone / Date → ms (NaN if not a date). */
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  const t = s(v);
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d\d:?\d\d)$/.test(t)) return new Date(t).getTime();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - IST;
}
/** ms → IST 'YYYY-MM-DD HH:MM:SS'. */
function istStamp(ms) {
  const d = new Date(ms + IST);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
const istDay = (ms) => Math.floor((ms + IST) / 86400e3);

/** The new PasswordHistory: previous DATE entries only (anything else is dropped), + stamp, last 10. */
function nextHistory(prev, stamp) {
  const list = (Array.isArray(prev) ? prev : []).map(s).filter((x) => isFinite(toMs(x)));
  return list.concat([stamp]).slice(-HISTORY_MAX);
}
/** raw_json after a password change at `stamp` (a copy; the caller writes it back with the typed columns). */
function stampRaw(raw, stamp) {
  const r = Object.assign({}, rawOf(raw));
  r[PWD_KEY] = stamp;
  r[HISTORY_KEY] = nextHistory(r[HISTORY_KEY], stamp);
  return r;
}

/** { at, date, label, short, days, ago, stale, source } for the admin screens, or null when unknown. */
function describe(ms, source, now) {
  if (!isFinite(ms)) return null;
  const n = now == null ? Date.now() : Number(now);
  const at = istStamp(ms);
  const days = Math.max(0, istDay(n) - istDay(ms));
  const m = at.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const short = +m[3] + ' ' + MONTHS[+m[2] - 1];
  return { at, date: at.slice(0, 10), label: short + ' ' + m[1], short, days, ago: days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago', stale: days > STALE_DAYS, source };
}

/** audit rows → Map account_id → newest ms (entity_id + details.accounts: one change covers every ID on the login). */
function auditMap(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || s(r.action) && s(r.action) !== AUDIT_ACTION) continue;
    const ms = toMs(r.ts); if (!isFinite(ms)) continue;
    let ids = [s(r.entity_id)];
    try { const d = rawOf(r.details); if (Array.isArray(d.accounts)) ids = ids.concat(d.accounts.map(s)); } catch (_) { /* keep entity id */ }
    for (const id of ids) if (id && !(out.get(id) >= ms)) out.set(id, ms);
  }
  return out;
}

/** One account: raw_json PasswordChangedAt → change log → old Sheet LastPassChangedOn → null. */
function resolve(accountId, raw, audits, now) {
  const r = rawOf(raw);
  const own = toMs(r[PWD_KEY]);
  if (isFinite(own)) return describe(own, 'account', now);
  const log = audits && audits.get(s(accountId));
  if (isFinite(log)) return describe(log, 'changelog', now);
  const legacy = toMs(r[LEGACY_KEY]);
  if (isFinite(legacy)) return describe(legacy, 'sheet', now);
  return null;
}

/** Newest change-log entries for password changes ([] when audit_log is missing). q = db.query-style. */
async function loadAudit(q) {
  try {
    const rows = await q('SELECT entity_id, details, ts FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 2000', [AUDIT_ACTION]);
    return auditMap(Array.isArray(rows) ? rows : []);
  } catch (_) { return new Map(); }
}

/** { [account_id]: describe() | null } for the given ids (all accounts when ids is empty/undefined). */
async function forAccounts(q, ids, now) {
  const want = [...new Set((ids || []).map(s).filter(Boolean))];
  let rows = [];
  try {
    const r = await q('SELECT account_id, raw_json FROM inventory_accounts' + (want.length ? ' WHERE account_id IN (' + want.map(() => '?').join(', ') + ')' : ''), want);
    rows = Array.isArray(r) ? r : [];
  } catch (_) { rows = []; }
  const audits = await loadAudit(q);
  const out = {};
  for (const id of want) out[id] = resolve(id, null, audits, now);
  for (const row of rows) {
    const id = s(row.account_id); if (!id) continue;
    const d = resolve(id, row.raw_json, audits, now);
    if (!out[id] || (d && d.at > out[id].at)) out[id] = d;
  }
  return out;
}

/** Adds passwordChangedAt (newest over the login's account IDs, or null) to every remove-users group. */
async function attachToGroups(q, result, now) {
  const groups = [].concat((result && result.main && result.main.groups) || [], (result && result.other && result.other.groups) || []);
  if (!groups.length) return result;
  const ids = [...new Set(groups.flatMap((g) => g.accountIds || []))];
  const map = ids.length ? await forAccounts(q, ids, now) : {};
  for (const g of groups) {
    let best = null;
    for (const id of g.accountIds || []) { const d = map[id]; if (d && (!best || d.at > best.at)) best = d; }
    g.passwordChangedAt = best;
  }
  return result;
}

module.exports = { PWD_KEY, HISTORY_KEY, LEGACY_KEY, HISTORY_MAX, AUDIT_ACTION, STALE_DAYS, rawOf, toMs, istStamp, nextHistory, stampRaw, describe, auditMap, resolve, loadAudit, forAccounts, attachToGroups };
