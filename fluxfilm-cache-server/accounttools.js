/**
 * FluxFilm - admin account tools: password change (F5) and renewal reminders.
 *
 *   GET  /admin/api/accounts/search?q=
 *   GET  /admin/api/accounts/impact?service=&account_id=    who a password change affects
 *   POST /admin/api/accounts/password-change                change it (+ tick expired, + email active)
 *   GET  /admin/api/reminders?past=7&next=7                 ended / ending plans
 *   POST /admin/api/reminders/email                         one-tap renewal emails
 *
 * A password belongs to a LOGIN, and one login can be listed under several account rows
 * (see logins.js / F3) — so a change updates every row with that login and every
 * subscription on any of them.
 */
const s = (v) => String(v == null ? '' : v).trim();
const passwordAge = require('./passwordage');
const loginKey = (v) => s(v).toLowerCase();
// "Netflix (Group Offer)" -> "netflix", "Prime Video" -> "prime": the same email can be the login of two
// different services with different passwords, so a change never crosses service families.
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(v) { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : s(v); }
function daysLeft(v) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00+05:30').getTime();
  return Math.ceil((t - Date.now()) / 86400000);
}
const MAX_EMAILS = 100;

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const mailer = () => deps.mailer || require('./mailer');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const inList = (arr) => arr.map(() => '?').join(', ');
  async function logReminder(subId, kind, expiry, ok, note) {
    try { await db.query('INSERT INTO reminder_log (ts, sub_id, channel, kind, expiry_date, ok, note) VALUES (NOW(), ?, ?, ?, ?, ?, ?)', [subId, 'EMAIL', kind, expiry || null, ok ? 1 : 0, s(note).slice(0, 300) || null]); } catch (_) { /* schema-v14 not run: sending still works */ }
  }

  app.get('/admin/api/accounts/search', async (req, res) => {
    if (!auth(req, res)) return;
    const q = s(req.query.q);
    try {
      const rows = await db.query(
        'SELECT service, account_id, login_id, is_active FROM inventory_accounts' + (q ? ' WHERE account_id LIKE ? OR login_id LIKE ? OR service LIKE ?' : '') + ' ORDER BY service, account_id LIMIT 40',
        q ? ['%' + q + '%', '%' + q + '%', '%' + q + '%'] : []);
      res.json({ ok: true, accounts: rows });
    } catch (e) { fail(res, e); }
  });

  // Everything a password change on this account touches.
  async function impact(service, accountId) {
    const acc = (await db.query('SELECT service, account_id, login_id, password, is_active FROM inventory_accounts WHERE service = ? AND account_id = ? LIMIT 1', [service, accountId]))[0];
    if (!acc) return { ok: false, status: 404, message: 'Account not found.' };
    const key = loginKey(acc.login_id);
    if (!key) return { ok: false, status: 400, message: 'This account has no login saved.' };
    const fam = family(acc.service);
    const same = await db.query('SELECT service, account_id, is_active FROM inventory_accounts WHERE LOWER(TRIM(login_id)) = ? AND LOWER(service) LIKE ?', [key, '%' + fam + '%']);
    const ids = [...new Set(same.map((r) => s(r.account_id)).filter(Boolean))];
    const refLike = ids.map(() => 'inventory_ref LIKE ?').join(' OR ');
    const groupsOn = await require('./devicelogins').groupsReady(db.query);
    const subs = await db.query(
      'SELECT s.sub_id, s.phone_norm, s.email, s.service, s.plan, s.expiry_date, s.status, s.inventory_ref, s.profile_name, s.profile_pin, COALESCE(s.removed, 0) AS removed, ' + (groupsOn ? 's.group_index, s.group_size, ' : '') + 'c.name ' +
      'FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm ' +
      'WHERE (s.inventory_ref IN (' + inList(ids) + ') OR s.account_id IN (' + inList(ids) + ') OR ' + refLike.replace(/inventory_ref/g, 's.inventory_ref') + ' OR LOWER(TRIM(s.login_id)) = ?) ' +
      'AND LOWER(s.service) LIKE ? ORDER BY s.expiry_date DESC LIMIT 1000',
      [...ids, ...ids, ...ids.map((i) => i + '#%'), key, '%' + fam + '%']);
    const active = []; const expired = [];
    for (const x of subs) {
      const d = daysLeft(x.expiry_date);
      const isActive = s(x.status).toUpperCase() === 'ACTIVE' && d != null && d > 0;
      if (isActive) active.push(x);
      else if (d != null && d <= 0 && Number(x.removed) !== 1) expired.push(x);
    }
    return { ok: true, account: acc, login: s(acc.login_id), key, fam, sameLogin: same, ids, active, expired };
  }
  // F1: a login row of a purchase with separate logins is shown as "Device 2 of 2" (only that device is affected).
  const brief = (x) => Object.assign({ subId: x.sub_id, name: s(x.name), phone: s(x.phone_norm), email: s(x.email), service: s(x.service), plan: s(x.plan), expiry: s(x.expiry_date), inventoryRef: s(x.inventory_ref) },
    Number(x.group_size) > 1 ? { device: 'Device ' + Number(x.group_index) + ' of ' + Number(x.group_size) } : {});

  app.get('/admin/api/accounts/impact', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const im = await impact(s(req.query.service), s(req.query.account_id));
      if (!im.ok) return res.status(im.status || 400).json(im);
      // 🔑 Last changed: newest over every account ID on this login (passwordage.js; separate single-table reads).
      const ages = await passwordAge.forAccounts((sql, p) => db.query(sql, p), im.ids.length ? im.ids : [im.account.account_id]);
      const passwordChangedAt = Object.values(ages).reduce((best, d) => (d && (!best || d.at > best.at) ? d : best), null);
      res.json({ ok: true, account: { service: im.account.service, accountId: im.account.account_id, login: im.login, password: s(im.account.password), isActive: s(im.account.is_active).toUpperCase() === 'TRUE', passwordChangedAt },
        sameLogin: im.sameLogin, active: im.active.map(brief), expired: im.expired.map(brief) });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/accounts/password-change', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const password = String(b.password == null ? '' : b.password).trim();
    if (!password) return res.status(400).json({ ok: false, message: 'Enter the new password.' });
    if (password.length > 200) return res.status(400).json({ ok: false, message: 'That password is too long.' });
    const tickExpired = b.tickExpired !== false;
    try {
      const im = await impact(s(b.service), s(b.accountId));
      if (!im.ok) return res.status(im.status || 400).json(im);
      if (s(im.account.password) === password) return res.status(400).json({ ok: false, message: 'That is already the saved password.' });

      // 1) every account row with this login
      const rAcc = await db.query("UPDATE inventory_accounts SET password = ?, raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.Password', ?)) WHERE LOWER(TRIM(login_id)) = ? AND LOWER(service) LIKE ?", [password, password, im.key, '%' + im.fam + '%']);
      // 1b) 🔑 when: raw_json.PasswordChangedAt (IST) + PasswordHistory (last 10 dates, never a password) on the same rows.
      //     No typed column exists for it; rows without a readable raw_json keep the change-log entry below as their date.
      const changedAt = passwordAge.istStamp(Date.now());
      const stampRows = await db.query('SELECT service, account_id, raw_json FROM inventory_accounts WHERE LOWER(TRIM(login_id)) = ? AND LOWER(service) LIKE ?', [im.key, '%' + im.fam + '%']);
      for (const row of Array.isArray(stampRows) ? stampRows : []) {
        if (!row.raw_json || !Object.keys(passwordAge.rawOf(row.raw_json)).length) continue;
        await db.query('UPDATE inventory_accounts SET raw_json = ? WHERE service = ? AND account_id = ?', [JSON.stringify(passwordAge.stampRaw(row.raw_json, changedAt)), row.service, row.account_id]);
      }
      // 2) active customers keep watching: their stored password (account page, recover, emails) is updated
      if (im.active.length) {
        const ids = im.active.map((x) => x.sub_id);
        await db.query("UPDATE subscriptions SET password = ?, raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.Password', ?)) WHERE sub_id IN (" + inList(ids) + ')', [password, password, ...ids]);
      }
      // 3) expired customers are now logged out: tick them removed (renewal rules F4 use this time)
      let ticked = 0;
      if (tickExpired && im.expired.length) {
        const ids = im.expired.map((x) => x.sub_id);
        const r = await db.query("UPDATE subscriptions SET removed = 1, removed_at = NOW(), raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.RemovedFromDevice', 'TRUE')) WHERE sub_id IN (" + inList(ids) + ') AND COALESCE(removed, 0) = 0', ids);
        ticked = (r && r.affectedRows) || 0;
      }
      // 4) optional: email the new login to active customers
      const mail = { sent: 0, noEmail: 0, failed: [] };
      if (b.emailActive) {
        for (const x of im.active.slice(0, MAX_EMAILS)) {
          if (!s(x.email)) { mail.noEmail++; continue; }
          try {
            const r = await mailer().sendPasswordChanged({ email: x.email, name: x.name, service: x.service, plan: x.plan, login: im.login, password, profileName: x.profile_name, profilePin: x.profile_pin });
            if (r && r.ok) { mail.sent++; await logReminder(x.sub_id, 'PASSWORD_CHANGE', x.expiry_date, true); } else { mail.failed.push({ subId: x.sub_id, message: (r && r.skipped) || 'not sent' }); }
          } catch (e) { mail.failed.push({ subId: x.sub_id, message: e.message }); await logReminder(x.sub_id, 'PASSWORD_CHANGE', x.expiry_date, false, e.message); }
        }
      }
      const summary = im.account.account_id + ' (' + im.login + '): ' + ((rAcc && rAcc.affectedRows) || 0) + ' account row(s), ' + im.active.length + ' active updated, ' + ticked + ' expired ticked removed' + (b.emailActive ? ', ' + mail.sent + ' emailed' : '');
      audit.record(req, { action: 'account.passwordChange', entity: 'account', id: im.account.account_id, summary, details: { accounts: im.ids, activeSubs: im.active.map((x) => x.sub_id), tickedSubs: tickExpired ? im.expired.map((x) => x.sub_id) : [], emailed: mail.sent } });
      res.json({ ok: true, passwordChangedAt: passwordAge.describe(passwordAge.toMs(changedAt), 'account'), accountRows: (rAcc && rAcc.affectedRows) || 0, activeUpdated: im.active.length, expiredTicked: ticked, email: b.emailActive ? mail : null, active: im.active.map(brief), summary });
    } catch (e) { fail(res, e); }
  });

  const clampDays = (v, d) => Math.max(0, Math.min(60, parseInt(v, 10) >= 0 ? parseInt(v, 10) : d));
  async function reminderRows(past, next, subIds) {
    // F1: a purchase with separate logins (one row per login) is one plan → one reminder, via its Device 1 row.
    const groupsOn = await require('./devicelogins').groupsReady(db.query);
    const rows = await reminderRowsRaw(past, next, subIds, groupsOn);
    return groupsOn ? rows.filter((x) => !(Number(x.group_index) > 1)) : rows;
  }
  async function reminderRowsRaw(past, next, subIds, groupsOn) {
    const base =
      'SELECT s.sub_id, s.phone_norm, s.email, s.service, s.plan, s.expiry_date, s.status, COALESCE(s.removed, 0) AS removed, c.name, ' + (groupsOn ? 's.group_index, s.group_size, ' : '') +
      "EXISTS (SELECT 1 FROM subscriptions n WHERE n.phone_norm = s.phone_norm AND n.service = s.service AND n.sub_id <> s.sub_id AND n.expiry_date > s.expiry_date AND UPPER(n.status) = 'ACTIVE') AS has_newer";
    const where = subIds
      ? ' WHERE s.sub_id IN (' + inList(subIds) + ')'
      : " WHERE s.expiry_date BETWEEN NOW() - INTERVAL ? DAY AND NOW() + INTERVAL ? DAY AND UPPER(COALESCE(s.status, '')) NOT IN ('CANCELLED', 'REFUNDED')";
    const params = subIds ? subIds : [past, next];
    const tail = ' FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm' + where + ' ORDER BY s.expiry_date LIMIT 500';
    try {
      return await db.query(base + ", (SELECT MAX(r.ts) FROM reminder_log r WHERE r.sub_id = s.sub_id AND r.kind = 'RENEWAL' AND r.ok = 1 AND r.expiry_date = s.expiry_date) AS last_reminded" + tail, params);
    } catch (e) {
      if (!/reminder_log/.test(String(e.message))) throw e;
      return await db.query(base + ', NULL AS last_reminded' + tail, params); // schema-v14 not run yet
    }
  }

  app.get('/admin/api/reminders', async (req, res) => {
    if (!auth(req, res)) return;
    const past = clampDays(req.query.past, 7), next = clampDays(req.query.next, 7);
    try {
      const rows = await reminderRows(past, next);
      res.json({ ok: true, past, next, rows: rows.map((x) => ({ subId: x.sub_id, name: s(x.name), phone: s(x.phone_norm), email: s(x.email), service: s(x.service), plan: s(x.plan), expiry: s(x.expiry_date), expiryText: prettyDate(x.expiry_date), daysLeft: daysLeft(x.expiry_date), removed: Number(x.removed) === 1, hasNewer: Number(x.has_newer) === 1, lastReminded: x.last_reminded || null })) });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/reminders/email', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const ids = [...new Set((Array.isArray(b.subIds) ? b.subIds : []).map(s).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ ok: false, message: 'Pick at least one customer.' });
    if (ids.length > MAX_EMAILS) return res.status(400).json({ ok: false, message: 'At most ' + MAX_EMAILS + ' emails at a time.' });
    try {
      const rows = await reminderRows(0, 0, ids);
      const out = { sent: 0, noEmail: 0, alreadyReminded: 0, hasNewer: 0, failed: [] };
      for (const x of rows) {
        if (!s(x.email)) { out.noEmail++; continue; }
        if (x.last_reminded && !b.force) { out.alreadyReminded++; continue; }
        if (Number(x.has_newer) === 1 && !b.force) { out.hasNewer++; continue; }
        try {
          const r = await mailer().sendRenewalReminder({ email: x.email, name: x.name, service: x.service, plan: x.plan, expiryText: prettyDate(x.expiry_date), daysLeft: daysLeft(x.expiry_date) });
          if (r && r.ok) { out.sent++; await logReminder(x.sub_id, 'RENEWAL', x.expiry_date, true); }
          else out.failed.push({ subId: x.sub_id, message: (r && r.skipped) || 'not sent' });
        } catch (e) { out.failed.push({ subId: x.sub_id, message: e.message }); await logReminder(x.sub_id, 'RENEWAL', x.expiry_date, false, e.message); }
      }
      audit.record(req, { action: 'reminders.email', entity: 'subscription', id: ids.length + ' selected', summary: out.sent + ' renewal email(s) sent, ' + out.noEmail + ' no email, ' + out.alreadyReminded + ' already reminded, ' + out.hasNewer + ' already renewed', details: { subIds: ids, failed: out.failed } });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, daysLeft, prettyDate, family };
