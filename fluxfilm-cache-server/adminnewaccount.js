/**
 * FluxFilm — ➕ Add account: one form instead of seven.
 *
 *   GET  /admin/api/account/new?service=Netflix   what to prefill, and why
 *   POST /admin/api/account/create                account + capacity + profiles, in ONE transaction
 *   POST /admin/api/account/remove                undo one, only while nothing is sold on it
 *
 * Owner, 4 Oct 2026: *"i will have to add id pass then profiles in separate sheet, is there a solution"*.
 * He was right that there was none. Buying a Netflix account meant SEVEN row-adds across three tables in
 * 📋 Sheets — inventory_accounts, inventory_capacity, and one inventory_profiles row per profile — with
 * Service and AccountID retyped into every one and nothing checking they agreed.
 *
 * Two shapes, both taken from what the live data actually looks like rather than from a guess:
 *
 *   PROFILE  (Netflix, Crunchyroll)  five profiles: #1 SHARING_RESERVED + IsReserved True, the rest
 *                                    PRIVATE_ROTATING + False, all Status FREE. That is exactly what
 *                                    NFLX-D3/D4/D5 look like today.
 *   CAPACITY (Prime)                 no profiles; max_total devices of which max_tv may be televisions.
 *
 * 🔒 raw_json is written alongside the typed columns for every row. CLAUDE.md records why: several code
 * paths read raw_json as the source of truth, so a row where the two disagree looks perfect in admin and
 * misbehaves at checkout.
 */
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,58}[A-Za-z0-9]$/;
const family = (svc) => (s(svc).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
const likeOf = (svc) => '%' + family(svc) + '%';

// Amazon's own devices page, read 4 Oct 2026: "Your Prime membership allows streaming on 5 devices,
// including 2 TVs." Set more than this and the account simply refuses the extra TV at registration, so
// the form warns rather than letting an account be oversold on paper.
const PRIME_MAX_TOTAL = 5;
const PRIME_MAX_TV = 2;

/** The profile shape a new PROFILE-policy account gets, matching the live Netflix accounts. */
function defaultProfiles(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      number: i,
      name: '',
      pin: '',
      // #1 is the one the sharing plan sells seats on; fulfill.js finds it by type starting "SHARING".
      type: i === 1 ? 'SHARING_RESERVED' : 'PRIVATE_ROTATING',
      reserved: i === 1,
    });
  }
  return out;
}

/**
 * The next free id for a service, worked out from the ids it already uses.
 * PRI-05 -> PRI-06 · NFLX-D5 -> NFLX-D6. Only a suggestion; the owner can type anything.
 */
function nextIdFrom(ids) {
  const groups = new Map();
  (ids || []).forEach((raw) => {
    const m = /^(.*?)(\d+)$/.exec(s(raw));
    if (!m) return;
    const g = groups.get(m[1]) || { prefix: m[1], width: m[2].length, max: 0, n: 0 };
    g.max = Math.max(g.max, parseInt(m[2], 10));
    g.width = Math.max(g.width, m[2].length);
    g.n += 1;
    groups.set(m[1], g);
  });
  if (!groups.size) return '';
  // The prefix most of them share; a one-off oddity should not decide the next name.
  const best = Array.from(groups.values()).sort((a, b) => b.n - a.n || b.max - a.max)[0];
  return best.prefix + String(best.max + 1).padStart(best.width, '0');
}

/** What is wrong with this request, in words the owner can act on. Empty array = nothing. */
function problemsWith(body, ctx) {
  const p = [];
  const svc = s(body.service), id = s(body.accountId);
  if (!svc) p.push('Pick a service.');
  if (!id) p.push('Give the account an ID.');
  else if (!ID_RE.test(id)) p.push('That ID has characters we do not allow. Letters, numbers, space . _ - / only.');
  if (!s(body.login)) p.push('The login is missing.');
  if (!s(body.password)) p.push('The password is missing.');
  if (ctx && ctx.idTaken) p.push(id + ' already exists for ' + svc + '.');

  const total = asNum(body.maxTotal), tv = asNum(body.maxTv);
  if (total < 1) p.push('How many devices or seats can this account hold? It must be at least 1.');
  if (tv < 0) p.push('TVs cannot be a negative number.');
  if (tv > total) p.push('More TVs (' + tv + ') than devices in total (' + total + ').');

  if (ctx && ctx.policy === 'PROFILE') {
    const list = Array.isArray(body.profiles) ? body.profiles : [];
    if (!list.length) p.push('A ' + svc + ' account needs its profiles.');
    const nums = list.map((x) => asNum(x.number));
    if (nums.some((n) => n < 1)) p.push('Every profile needs a number.');
    if (new Set(nums).size !== nums.length) p.push('Two profiles have the same number.');
    const sharing = list.filter((x) => up(x.type).indexOf('SHARING') === 0);
    if (sharing.length > 1) p.push('Only one profile can be the sharing one.');
    // Not an error: an all-private account is a legitimate thing to stock.
  }
  return p;
}

/** Things worth saying out loud that are not refusals. The owner decides. */
function warningsFor(body, ctx) {
  const w = [];
  const total = asNum(body.maxTotal), tv = asNum(body.maxTv);
  if (ctx && ctx.policy === 'CAPACITY' && /prime/i.test(s(body.service))) {
    if (tv > PRIME_MAX_TV) w.push('Amazon allows only ' + PRIME_MAX_TV + ' TVs per account - the ' + (tv - PRIME_MAX_TV) + ' extra will be refused when a customer tries to register one.');
    if (total > PRIME_MAX_TOTAL) w.push('Amazon allows ' + PRIME_MAX_TOTAL + ' devices per account, and this is set to ' + total + '.');
  }
  if (ctx && ctx.sameLogin && ctx.sameLogin.length) {
    w.push('That login is already on ' + ctx.sameLogin.join(', ') + '. Two IDs on one real login is sometimes right - but if it is not, stop here.');
  }
  if (ctx && ctx.policy === 'PROFILE' && !(body.profiles || []).some((x) => up(x.type).indexOf('SHARING') === 0)) {
    w.push('No sharing profile, so this account can only ever be sold as private.');
  }
  return w;
}

function mount(app, deps) {
  const d = deps || {};
  const db = d.db || require('./db');
  const auth = d.auth;
  const audit = d.audit || { record: () => {} };
  const fail = (res, e) => { console.log('[newaccount]', e.message); res.status(500).json({ ok: false, message: e.message }); };

  /** CAPACITY or PROFILE for a service, decided by its plans - the same source fulfilment uses. */
  async function policyOf(service) {
    const fam = family(service);
    if (!fam) return '';
    try {
      const rows = await db.query('SELECT service, raw_json FROM plans');
      for (const r of rows || []) {
        if (family(r.service) !== fam) continue;
        let raw = {}; try { raw = r.raw_json ? JSON.parse(r.raw_json) : {}; } catch (e) { raw = {}; }
        const pol = up(raw.AllocationPolicy);
        if (pol) return pol;
      }
    } catch (e) { /* fall through */ }
    // No plan says: fall back to what the stock looks like. Profiles on disk means profiles.
    try {
      const r = await db.query('SELECT COUNT(*) n FROM inventory_profiles WHERE LOWER(service) LIKE ?', [likeOf(service)]);
      if (r && r[0] && Number(r[0].n) > 0) return 'PROFILE';
    } catch (e) { /* ignore */ }
    return 'CAPACITY';
  }

  // What to put in the form before the owner types anything.
  app.get('/admin/api/account/new', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const service = s(req.query.service);
      const all = await db.query('SELECT DISTINCT service FROM inventory_accounts ORDER BY service');
      const services = (all || []).map((r) => s(r.service)).filter(Boolean);
      if (!service) return res.json({ ok: true, services: services });

      const policy = await policyOf(service);
      const ids = await db.query('SELECT account_id FROM inventory_accounts WHERE LOWER(service) LIKE ?', [likeOf(service)]);
      const caps = await db.query('SELECT max_total, max_tv FROM inventory_capacity WHERE LOWER(service) LIKE ?', [likeOf(service)]);
      // Prefill from what this service's own accounts already use, not from a number I invented.
      const totals = (caps || []).map((c) => asNum(c.max_total)).filter((n) => n > 0);
      const tvs = (caps || []).map((c) => asNum(c.max_tv)).filter((n) => n > 0);
      const commonest = (xs, fallback) => {
        if (!xs.length) return fallback;
        const c = new Map(); xs.forEach((x) => c.set(x, (c.get(x) || 0) + 1));
        return Array.from(c.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      };
      let profileCount = 0;
      if (policy === 'PROFILE') {
        const pc = await db.query(
          'SELECT account_id, COUNT(*) n FROM inventory_profiles WHERE LOWER(service) LIKE ? GROUP BY account_id', [likeOf(service)]);
        profileCount = commonest((pc || []).map((r) => asNum(r.n)).filter((n) => n > 0), 5);
      }
      res.json({
        ok: true,
        services: services,
        service: service,
        policy: policy,
        nextId: nextIdFrom((ids || []).map((r) => s(r.account_id))),
        maxTotal: commonest(totals, policy === 'PROFILE' ? 5 : PRIME_MAX_TOTAL),
        maxTv: policy === 'PROFILE' ? 0 : commonest(tvs, PRIME_MAX_TV),
        profiles: policy === 'PROFILE' ? defaultProfiles(profileCount || 5) : [],
        primeLimits: /prime/i.test(service) ? { maxTotal: PRIME_MAX_TOTAL, maxTv: PRIME_MAX_TV } : null,
      });
    } catch (e) { fail(res, e); }
  });

  // 🔒 Everything, or nothing. A half-made account is worse than none: it looks stockable in admin and
  // falls over when fulfilment reaches for the piece that is missing.
  app.post('/admin/api/account/create', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const service = s(b.service), id = s(b.accountId);
      const policy = await policyOf(service);
      const dupe = await db.query('SELECT account_id FROM inventory_accounts WHERE account_id = ? AND LOWER(service) LIKE ? LIMIT 1', [id, likeOf(service)]);
      const sameLogin = await db.query(
        'SELECT account_id FROM inventory_accounts WHERE LOWER(TRIM(login_id)) = ? AND LOWER(service) LIKE ?',
        [s(b.login).toLowerCase(), likeOf(service)]);
      const ctx = { policy: policy, idTaken: !!(dupe && dupe.length), sameLogin: (sameLogin || []).map((r) => s(r.account_id)) };

      const problems = problemsWith(b, ctx);
      if (problems.length) return res.json({ ok: false, problems: problems });
      const warnings = warningsFor(b, ctx);
      // Warnings are shown once and the owner says go. They never block on their own.
      if (warnings.length && !b.confirm) return res.json({ ok: false, warnings: warnings, needsConfirm: true });

      const isActive = b.isActive === false ? 'FALSE' : 'TRUE';
      const profiles = policy === 'PROFILE' ? (Array.isArray(b.profiles) ? b.profiles : []) : [];
      const conn = await db.getPool().getConnection();
      try {
        await conn.beginTransaction();
        const accRaw = { Service: service, AccountID: id, LoginId: s(b.login), Password: s(b.password), IsActive: isActive, Plan: s(b.plan), Notes: s(b.notes) };
        await conn.query(
          'INSERT INTO inventory_accounts (service, account_id, login_id, password, is_active, plan, notes, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [service, id, s(b.login), s(b.password), isActive, s(b.plan), s(b.notes), JSON.stringify(accRaw)]);

        const capRaw = { Service: service, AccountID: id, MaxTotal: asNum(b.maxTotal), MaxTV: asNum(b.maxTv), IsActive: isActive, Notes: '' };
        await conn.query(
          'INSERT INTO inventory_capacity (service, account_id, max_total, max_tv, is_active, notes, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [service, id, asNum(b.maxTotal), asNum(b.maxTv), isActive, '', JSON.stringify(capRaw)]);

        for (const p of profiles) {
          const no = asNum(p.number);
          const type = up(p.type) || 'PRIVATE_ROTATING';
          const reserved = (p.reserved === true || up(p.reserved) === 'TRUE') ? 'True' : 'False';
          const prRaw = {
            Service: service, AccountID: id, ProfileNumber: String(no), ProfileType: type, IsReserved: reserved,
            ProfileDisplayName: s(p.name), ProfilePIN: s(p.pin), Status: 'FREE', CurrentSubID: '',
          };
          await conn.query(
            'INSERT INTO inventory_profiles (service, account_id, profile_name, profile_number, profile_pin, status, current_sub_id, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [service, id, s(p.name), String(no), s(p.pin), 'FREE', '', JSON.stringify(prRaw)]);
        }
        await conn.commit();
        conn.release();
      } catch (e) {
        try { await conn.rollback(); } catch (_) { /* already gone */ }
        conn.release();
        const msg = /Duplicate/i.test(String(e && e.message)) ? 'Something with that ID already exists.' : String((e && e.message) || e);
        return res.status(500).json({ ok: false, problems: ['Nothing was created: ' + msg] });
      }
      // 🔒 The login is named; the password is not, here or anywhere else in the log.
      audit.record(req, { action: 'account.create', entity: 'inventory_accounts', id: service + ' / ' + id,
        summary: 'Added ' + service + ' account ' + id + ' (' + asNum(b.maxTotal) + ' slots, ' + profiles.length + ' profiles)' });
      res.json({ ok: true, service: service, accountId: id, profiles: profiles.length, policy: policy });
    } catch (e) { fail(res, e); }
  });

  // 🔒 Undo. Only while the account is untouched - once a customer is on it, this is the wrong tool and
  // the right one is the owner's own judgement.
  app.post('/admin/api/account/remove', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const service = s(b.service), id = s(b.accountId);
      if (!service || !id) return res.json({ ok: false, message: 'Which account?' });
      const subs = await db.query(
        'SELECT sub_id FROM subscriptions WHERE account_id = ? OR inventory_ref = ? OR LEFT(inventory_ref, ?) = ? LIMIT 5',
        [id, id, id.length + 1, id + '#']);
      if (subs && subs.length) {
        return res.json({ ok: false, message: 'There are ' + subs.length + ' subscription(s) on ' + id + ' (' + subs.map((r) => s(r.sub_id)).join(', ') + '). Nothing was deleted.' });
      }
      const conn = await db.getPool().getConnection();
      let gone = { profiles: 0, capacity: 0, account: 0 };
      try {
        await conn.beginTransaction();
        const run = async (sql, p) => { const [r] = await conn.query(sql, p); return (r && r.affectedRows) || 0; };
        gone.profiles = await run('DELETE FROM inventory_profiles WHERE account_id = ? AND LOWER(service) LIKE ?', [id, likeOf(service)]);
        gone.capacity = await run('DELETE FROM inventory_capacity WHERE account_id = ? AND LOWER(service) LIKE ?', [id, likeOf(service)]);
        gone.account = await run('DELETE FROM inventory_accounts WHERE account_id = ? AND LOWER(service) LIKE ?', [id, likeOf(service)]);
        await conn.commit();
        conn.release();
      } catch (e) {
        try { await conn.rollback(); } catch (_) { /* already gone */ }
        conn.release();
        return res.status(500).json({ ok: false, message: 'Nothing was deleted: ' + String((e && e.message) || e) });
      }
      audit.record(req, { action: 'account.remove', entity: 'inventory_accounts', id: service + ' / ' + id,
        summary: 'Deleted ' + service + ' account ' + id + ' (' + gone.profiles + ' profiles, ' + gone.capacity + ' capacity)' });
      res.json({ ok: true, removed: gone });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, _internal: { nextIdFrom, defaultProfiles, problemsWith, warningsFor, PRIME_MAX_TOTAL, PRIME_MAX_TV } };
