/**
 * FluxFilm - ONE rule for "which password does the customer actually get?"
 *
 * The password belongs to the ACCOUNT (inventory_accounts), not to the subscription row.
 * A subscription row only keeps a copy so the account page / Recover / the email can show it
 * without a second lookup. That copy goes stale the moment the owner changes the password.
 *
 * Owner report 16 Sep 2026: the password of an account was changed while a customer's plan was
 * already expired. Expired rows were not updated, so renewing that very row (fulfill.js extends the
 * SAME subscription) showed - and emailed - the OLD password. Recover could not help either: it only
 * opens ACTIVE plans.
 *
 * So every place that shows a password calls refreshAccess() first. It reads the account, and when the
 * row disagrees it uses the account's value AND repairs the row (typed columns AND raw_json, which
 * several code paths read as the source of truth - see CLAUDE.md).
 *
 * Rules kept deliberately boring:
 *   - inventory_accounts is read with its OWN single-table statement. Never a JOIN with subscriptions.
 *   - Account not found, or found with no password saved -> change NOTHING, just count it as `missing`
 *     and log. A missing account must never blank out a login the customer is using.
 *   - One read per (account id + service family), so a 10-device purchase is a couple of queries.
 *   - Nothing is written when the row already agrees with the account.
 */
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();

// "Netflix (Group Offer)" -> "netflix", "Prime Video" -> "prime". Same rule as accounttools.js:
// the same email can be the login of two services with two different passwords, so a lookup
// never crosses service families.
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
// "NF-1#P3" -> "NF-1" (a Netflix profile ref); anything else is the account id itself.
const accountOfRef = (ref) => { const r = s(ref); const cut = r.indexOf('#P'); return cut >= 0 ? r.slice(0, cut) : r; };
// Which account row this subscription sits on.
const accountKeyOf = (row) => accountOfRef((row || {}).inventory_ref) || s((row || {}).account_id);

const ACCOUNT_SQL = 'SELECT service, account_id, login_id, password, is_active FROM inventory_accounts WHERE account_id = ? AND LOWER(service) LIKE ? LIMIT 20';
const REPAIR_SQL = "UPDATE subscriptions SET password = ?, login_id = ?, " +
  "raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.Password', ?, '$.LoginId', ?)) WHERE sub_id = ? LIMIT 1";

/** The live login of one account id, or null. Prefers an active row that actually has a login + password. */
async function accountFor(query, accountId, serviceFamily) {
  const rows = await query(ACCOUNT_SQL, [accountId, '%' + serviceFamily + '%']);
  const list = Array.isArray(rows) ? rows : [];
  const usable = list.filter((r) => s(r.login_id) && s(r.password));
  return usable.find((r) => up(r.is_active) === 'TRUE') || usable[0] || null;
}

/**
 * Make these subscription rows show the password the account has NOW.
 * Mutates each row in place (login_id / password) and repairs the stored row unless opts.write is false.
 *
 * @param query  (sql, params) => rows
 * @param rows   one subscription row or an array of them
 * @returns { checked, repaired, missing, subIds }  subIds = the rows that were stale
 */
async function refreshAccess(query, rows, opts) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  const o = opts || {};
  const write = o.write !== false;
  const out = { checked: 0, repaired: 0, missing: 0, subIds: [] };
  if (!list.length) return out;

  // One lookup per account + service family, reused by every row on it.
  const wanted = new Map();
  for (const r of list) {
    const acc = accountKeyOf(r); const fam = family(r.service);
    if (acc && fam) wanted.set(acc + '|' + fam, { acc, fam });
  }
  if (!wanted.size) return out;
  const found = new Map();
  for (const [k, w] of wanted) found.set(k, await accountFor(query, w.acc, w.fam));

  for (const r of list) {
    const acc = accountKeyOf(r); const fam = family(r.service);
    if (!acc || !fam) continue;
    out.checked++;
    const a = found.get(acc + '|' + fam);
    if (!a) {
      // Retired, renamed or deleted account: keep exactly what the row has and say so in the log.
      out.missing++;
      console.log('[access] no inventory account for', s(r.sub_id) || '(row)', '-', acc, '/', s(r.service), '- keeping the stored login');
      continue;
    }
    const pass = s(a.password); const user = s(a.login_id);
    const sameUser = !user || user === s(r.login_id);
    if (pass === s(r.password) && sameUser) continue;
    const newUser = user || s(r.login_id);
    if (write && s(r.sub_id)) {
      await query(REPAIR_SQL, [pass, newUser, pass, newUser, s(r.sub_id)]);
      console.log('[access] repaired stale login on', s(r.sub_id), 'from account', acc);
    }
    r.password = pass;
    r.login_id = newUser;
    out.repaired++;
    if (s(r.sub_id)) out.subIds.push(s(r.sub_id));
  }
  return out;
}

/** Never let a display path fail because of this: the stored row is still shown if the lookup breaks. */
async function refreshAccessSafe(query, rows, opts) {
  try { return await refreshAccess(query, rows, opts); }
  catch (e) { console.log('[access] refresh skipped:', (e && e.message) || e); return { checked: 0, repaired: 0, missing: 0, subIds: [], error: String((e && e.message) || e) }; }
}

module.exports = { refreshAccess, refreshAccessSafe, accountFor, accountKeyOf, family, accountOfRef, ACCOUNT_SQL, REPAIR_SQL };
