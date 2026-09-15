/**
 * FluxFilm - 🔁 Switch account (admin, owner request 15 Sep 2026). Mounted by admin.js, admin key / session only.
 *
 *   GET  /admin/api/subs/switch/options?subId=SUB-…   the plan's current account + every other account of the same
 *                                                     service family, least used first, full / disabled ones greyed
 *   POST /admin/api/subs/switch                       { subId, accountId, note, email, requestId }
 *
 * "An account is not working → move this customer to another one", like the old Apps Script asSwitchAccount, but on
 * MySQL and for every inventory service:
 *   - Capacity is counted EXACTLY like fulfilment (fulfill.js): occupancy comes only from subscriptions (status ACTIVE and
 *     expiry or the 10-day release date still ahead), per policy — CAPACITY (Prime: devices + TV slots), PROFILE
 *     (Netflix: sharing seats + extra private devices vs max_total, private = a PRIVATE_ROTATING profile nobody holds),
 *     ACCOUNT / OTP_ACCOUNT (per real login, logins.js; OTP rows only for the durations they are sold for).
 *   - Fulfilment never writes inventory_profiles / inventory_capacity (they are read-only limits), so moving
 *     inventory_ref / login is the whole switch: the old slot frees itself and the new one is taken.
 *   - One subscriptions row is one login (devicelogins.js): a same-login plan on N devices is one row, so all N devices
 *     move together; a separate-logins purchase has one row per device, so only that device moves and the other
 *     devices' accounts are not offered (the logins stay separate).
 *   - The switch runs under fulfilment's allocation lock (GET_LOCK ff_alloc) in one transaction and re-checks the target
 *     inside it. A repeated requestId (double tap) returns the first result and changes nothing.
 *   - Typed columns and raw_json are written together (CLAUDE.md), plus SwitchedAt / SwitchedFrom / SwitchedTo /
 *     SwitchReason / SwitchedBy / SwitchHistory (last 20) in raw_json and a line in `notes`.
 *
 * 🚪 Remove users: the customer may still be logged in on the OLD account. expiredusers.load() adds one "ghost" row per
 * SwitchHistory entry (id SUB-…~SW…) on the old login until it is ticked removed (OldRemovedAt) or the old account's
 * password has changed since the switch (the password tool logs everyone out). Ticking a ghost goes through the usual
 * /admin/api/sub-removed and /admin/api/remove-users/removed calls, which this module answers for ghost ids first.
 *
 * SQL: one table per statement (live lesson: never mix collations across tables).
 */
const crypto = require('crypto');
const { loginKey, buildLoginGroups } = require('./logins');
const deviceLogins = require('./devicelogins');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return Array.isArray(v) ? {} : v; try { const j = JSON.parse(v); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (_) { return {}; } }
const F = () => require('./fulfill')._internal;

const INVENTORY_POLICIES = ['CAPACITY', 'PROFILE', 'ACCOUNT', 'OTP_ACCOUNT'];
const HISTORY_MAX = 20;
const DEFAULT_NOTE = 'Account not working';
const GHOST_RE = /^(.+)~(SW[A-Za-z0-9]+)$/;

const accountOfRef = (ref) => { const r = s(ref); const cut = r.indexOf('#'); return cut >= 0 ? r.slice(0, cut) : r; };
const p2 = (x) => String(x).padStart(2, '0');
/** India time 'YYYY-MM-DD HH:MM:SS' (how every date in the database is stored). */
function istStamp(d) { const x = new Date((d instanceof Date ? d.getTime() : Number(d)) + 5.5 * 3600e3); return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate()) + ' ' + p2(x.getUTCHours()) + ':' + p2(x.getUTCMinutes()) + ':' + p2(x.getUTCSeconds()); }
function toMs(v) { return require('./expiredusers').toMs(v); }
const passTag = (pw) => (s(pw) ? crypto.createHash('sha256').update(s(pw)).digest('hex').slice(0, 16) : '');
/** m***@gmail.com / ******3210 — enough for the owner to recognise a login without showing it in full. */
function maskLogin(v) {
  const x = s(v); if (!x) return '';
  const at = x.indexOf('@');
  if (at > 0) return x.slice(0, Math.min(2, at)) + '***' + x.slice(at);
  const d = x.replace(/\D/g, '');
  if (d.length >= 8 && d.length === x.replace(/[\s+-]/g, '').length) return '******' + d.slice(-4);
  return x.length <= 4 ? x[0] + '***' : x.slice(0, 2) + '***' + x.slice(-2);
}
const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Why this subscription can't be switched ('' = it can). */
function refusalFor(sub, nowMs) {
  const st = up(sub.status);
  if (/REFUND|CANCEL|ERASED/.test(st) || /REFUND/.test(up(sub.fulfillment_status))) return 'This plan was refunded or cancelled — it has ended, so there is nothing to switch.';
  if (st !== 'ACTIVE') return 'Only active plans can be switched (this one is ' + (st || 'without a status') + ').';
  const ex = toMs(sub.expiry_date);
  if (!(ex > nowMs)) return 'This plan has expired — only running plans can be switched. Renew or extend it first.';
  if (!s(sub.inventory_ref) && !s(sub.account_id) && !s(sub.login_id)) return 'This plan has no account yet — deliver it first.';
  return '';
}

/** Delivery policy of the plan (as fulfilment reads it); an old plan name falls back to the service's other plans. */
async function policyFor(Q, service, plan) {
  const rows = await Q('SELECT plan, raw_json FROM plans WHERE service = ?', [s(service)]);
  const pick = (r) => { const raw = rawOf(r.raw_json); const pol = up(raw.AllocationPolicy); return (up(raw.FulfillmentMode) === 'MANUAL' || !INVENTORY_POLICIES.includes(pol)) ? 'MANUAL' : pol; };
  const exact = (rows || []).find((r) => s(r.plan) === s(plan));
  if (exact) return pick(exact);
  for (const r of rows || []) { const p = pick(r); if (p !== 'MANUAL') return p; }
  if (/netflix/i.test(s(service))) return 'PROFILE';
  if (/prime/i.test(s(service))) return 'CAPACITY';
  return 'MANUAL';
}

/** Everything about the subscription the account list depends on. Q = (sql, params) → rows. */
async function contextFor(Q, sub) {
  const I = F();
  const policy = await policyFor(Q, sub.service, sub.plan);
  const svc = s(sub.service).toLowerCase();
  const isNetflix = /netflix/i.test(svc);
  const like = policy === 'CAPACITY' ? '%prime%' : (policy === 'PROFILE' && isNetflix) ? '%netflix%' : '%' + svc + '%';
  const held = I._heldDevices(sub);
  const siblings = new Map();
  if (s(sub.group_id)) {
    const rows = await Q('SELECT sub_id, inventory_ref, account_id, login_id, group_index FROM subscriptions WHERE group_id = ?', [s(sub.group_id)]);
    for (const r of rows || []) {
      if (s(r.sub_id) === s(sub.sub_id)) continue;
      const acc = accountOfRef(r.inventory_ref) || s(r.account_id);
      if (acc) siblings.set(acc, 'Device ' + (asNum(r.group_index) || '?'));
    }
  }
  return {
    policy, like, isNetflix, svc,
    sharing: /sharing|group/i.test(s(sub.plan)),
    dev: held.dev, tv: Math.min(held.tv, held.dev),
    months: I.monthsFromDays(sub.duration_days),
    curAcc: accountOfRef(sub.inventory_ref) || s(sub.account_id),
    curLogin: loginKey(sub.login_id),
    siblings,
  };
}

/**
 * Every account of the family with its use, capacity and whether THIS subscription fits (same rules as fulfill.js).
 * Returns entries (internal fields start with _). conn = a pool connection (conn.query → [rows]).
 */
async function accountEntries(conn, sub, ctx) {
  const I = F();
  const Q = async (sql, p) => (await conn.query(sql, p))[0];
  const accs = await Q('SELECT account_id, service, login_id, password, is_active, plan, notes FROM inventory_accounts WHERE LOWER(service) LIKE ?', [ctx.like]);
  const caps = await Q('SELECT account_id, max_total, max_tv, is_active FROM inventory_capacity WHERE LOWER(service) LIKE ?', [ctx.like]);
  const out = [];
  const base = (a) => {
    const id = s(a.account_id);
    const e = { accountId: id, service: s(a.service), login: maskLogin(a.login_id), flags: [], fits: false, reason: '', free: 0, used: 0, cap: 0, _a: a };
    if (up(a.is_active) !== 'TRUE') e.flags.push('disabled');
    if (!a.login_id || !a.password) e.flags.push('no login/password');
    if (ctx.curLogin && loginKey(a.login_id) === ctx.curLogin && id !== ctx.curAcc) e.flags.push('same login as now');
    if (ctx.siblings.has(id)) e.flags.push('used by ' + ctx.siblings.get(id) + ' of this purchase');
    return e;
  };
  const blocked = (e) => e.flags.length > 0;

  if (ctx.policy === 'CAPACITY') {
    const capMap = new Map();
    for (const c of caps) capMap.set(s(c.account_id), { maxTotal: asNum(c.max_total) || I.PRIME_MAX_TOTAL, maxTV: asNum(c.max_tv) || I.PRIME_MAX_TV, isActive: up(c.is_active) === 'TRUE' });
    const occ = await I.primeOccupancy(conn);
    const seen = new Set();
    for (const a of accs) {
      const id = s(a.account_id); if (!id || seen.has(id)) continue; seen.add(id);
      const e = base(a);
      const cap = capMap.get(id) || { maxTotal: I.PRIME_MAX_TOTAL, maxTV: I.PRIME_MAX_TV, isActive: true };
      if (!cap.isActive && !e.flags.includes('disabled')) e.flags.push('disabled');
      const o = occ.get(id) || { total: 0, tv: 0 };
      Object.assign(e, { used: o.total, cap: cap.maxTotal, free: cap.maxTotal - o.total, unit: 'devices', tv: { used: o.tv, cap: cap.maxTV } });
      e.label = id + ' · ' + o.total + '/' + cap.maxTotal + ' devices · TV ' + o.tv + '/' + cap.maxTV;
      const roomDev = o.total + ctx.dev <= cap.maxTotal;
      const roomTv = o.tv + ctx.tv <= cap.maxTV;
      e.fits = !blocked(e) && roomDev && roomTv;
      if (!e.fits) e.reason = e.flags[0] || (!roomDev ? 'full' : 'TV slots full');
      e._ref = id;
      out.push(e);
    }
  } else if (ctx.policy === 'PROFILE') {
    const reservedNo = ctx.isNetflix ? I.NETFLIX_SHARING_NO : null;
    const profs = await Q('SELECT account_id, profile_number, profile_pin, profile_name, raw_json FROM inventory_profiles WHERE LOWER(service) LIKE ?', [ctx.like]);
    const capMap = new Map();
    for (const c of caps) capMap.set(s(c.account_id), { maxTotal: asNum(c.max_total) || I.NETFLIX_SHARING_MAX, isActive: up(c.is_active) !== 'FALSE' });
    const occ = await I.occupancyMap(conn, ctx.like);
    const byAcc = new Map();
    for (const p of profs) {
      const acc = s(p.account_id); if (!acc) continue;
      const raw = rawOf(p.raw_json);
      const entry = {
        pno: asNum(p.profile_number) || asNum(raw.ProfileNumber),
        type: up(raw.ProfileType),
        reserved: up(raw.IsReserved) === 'TRUE',
        name: s(raw.ProfileDisplayName || raw.ProfileName || p.profile_name),
        pin: s(p.profile_pin || raw.ProfilePIN),
      };
      if (!byAcc.has(acc)) byAcc.set(acc, []);
      byAcc.get(acc).push(entry);
    }
    const seen = new Set();
    for (const a of accs) {
      const id = s(a.account_id); if (!id || seen.has(id)) continue; seen.add(id);
      const e = base(a);
      const cap = capMap.get(id) || { maxTotal: I.NETFLIX_SHARING_MAX, isActive: true };
      const list = byAcc.get(id) || [];
      const sp = I.sharingProfileOf(list, reservedNo);
      const load = I.profileAccountLoad(occ, id, list, reservedNo).load;
      const priv = list.filter((p) => p.pno && p.pno !== reservedNo && p.type === 'PRIVATE_ROTATING');
      let assigned = 0; let freeProf = null;
      for (const p of priv) { if ((occ.get(id + '#P' + p.pno) || 0) > 0) assigned++; else if (!freeProf) freeProf = p; }
      e.sharing = sp && sp.pno ? { used: load, cap: cap.maxTotal } : null;
      e.private = { used: assigned, cap: priv.length };
      if (!cap.isActive) e.sharingOff = true;
      e.label = id + ' · ' + (e.sharing ? 'Sharing ' + load + '/' + cap.maxTotal : 'no sharing profile') + ' · Private ' + assigned + '/' + priv.length;
      if (ctx.sharing) {
        Object.assign(e, { used: load, cap: cap.maxTotal, free: cap.maxTotal - load, unit: 'sharing' });
        const room = load + ctx.dev <= cap.maxTotal;
        e.fits = !blocked(e) && !!(sp && sp.pno) && cap.isActive && room;
        if (!e.fits) e.reason = e.flags[0] || (!(sp && sp.pno) ? 'no sharing profile' : !cap.isActive ? 'sharing switched off' : 'sharing full');
        if (sp && sp.pno) { e._prof = sp; e._ref = id + '#P' + sp.pno; e._profName = sp.name || 'FluxFilm'; }
      } else {
        Object.assign(e, { used: assigned, cap: priv.length, free: priv.length - assigned, unit: 'private' });
        const room = ctx.dev <= 1 || load + (ctx.dev - 1) <= cap.maxTotal;
        e.fits = !blocked(e) && !!freeProf && room;
        if (!e.fits) e.reason = e.flags[0] || (!freeProf ? 'no free private profile' : 'no room for ' + ctx.dev + ' devices');
        if (freeProf) { e._prof = freeProf; e._ref = id + '#P' + freeProf.pno; e._profName = freeProf.name || 'Private'; }
      }
      out.push(e);
    }
  } else {
    // ACCOUNT / OTP_ACCOUNT: capacity belongs to the login (logins.js), one entry per login.
    const occ = await I.occupancyMap(conn, ctx.like);
    const groups = buildLoginGroups(accs.map((r) => ({ account_id: r.account_id, key: loginKey(r.login_id) })), caps, (id) => occ.get(id) || 0);
    const otp = ctx.policy === 'OTP_ACCOUNT';
    const curGroup = ctx.curAcc ? groups.forId(ctx.curAcc) : null;
    const order = accs.slice().sort((x, y) => (up(y.is_active) === 'TRUE' && y.login_id && y.password ? 1 : 0) - (up(x.is_active) === 'TRUE' && x.login_id && x.password ? 1 : 0));
    const seen = new Set();
    for (const a of order) {
      const id = s(a.account_id); if (!id) continue;
      if (otp && !I.otpRowServes(a, sub.plan, ctx.months)) continue;   // this row isn't sold for the plan's duration
      const g = groups.forId(id);
      if (seen.has(g.key)) continue; seen.add(g.key);
      if (curGroup && g.key === curGroup.key) { out.push(Object.assign(base(a), { accountId: ctx.curAcc, _current: true, _ids: [...g.ids], used: g.used, cap: g.maxTotal, free: g.maxTotal - g.used, unit: otp ? 'customers' : 'devices', label: ctx.curAcc + ' · ' + g.used + '/' + g.maxTotal + (otp ? ' customers' : ' devices') })); continue; }
      const e = base(a);
      if (!g.isActive && !e.flags.includes('disabled')) e.flags.push('disabled');
      const need = otp ? 1 : ctx.dev;
      Object.assign(e, { used: g.used, cap: g.maxTotal, free: g.maxTotal - g.used, unit: otp ? 'customers' : 'devices' });
      e.label = id + ' · ' + g.used + '/' + g.maxTotal + (otp ? ' customers' : ' devices');
      e.fits = !blocked(e) && g.used + need <= g.maxTotal;
      if (!e.fits) e.reason = e.flags[0] || 'full';
      e._ref = id;
      out.push(e);
    }
  }
  return out;
}

const publicEntry = (e) => { const o = {}; for (const [k, v] of Object.entries(e)) if (k[0] !== '_') o[k] = v; o.status = e.fits ? 'OK' : e.flags.includes('disabled') ? 'DISABLED' : e.flags.length ? 'BLOCKED' : 'FULL'; return o; };
/** Least used first: accounts that fit, most free slots on top, then by id; full / disabled at the bottom. */
function sortEntries(list) {
  return list.slice().sort((x, y) => (Number(y.fits) - Number(x.fits)) || (y.free - x.free) || natural(x.accountId, y.accountId));
}

/** Split into the current account and the other accounts, sorted. */
function splitEntries(entries, ctx) {
  const current = entries.find((e) => e._current || e.accountId === ctx.curAcc) || null;
  const others = sortEntries(entries.filter((e) => e !== current && !e._current && e.accountId !== ctx.curAcc));
  return { current, others };
}

function groupInfo(sub) {
  const size = asNum(sub.group_size);
  const dev = Math.max(1, asNum(sub.device_count) || 1);
  if (s(sub.group_id) && size > 1) return { kind: 'SEPARATE', size, index: asNum(sub.group_index) || null, text: 'This purchase has a separate login for each device. Only Device ' + (asNum(sub.group_index) || '?') + ' moves; the other device' + (size > 2 ? 's keep their' : ' keeps its') + ' account, and those accounts are not offered.' };
  if (dev > 1) return { kind: 'SAME', size: 1, devices: dev, text: 'This plan uses one login on ' + dev + ' devices — all ' + dev + ' devices move together.' };
  return { kind: 'SINGLE' };
}

function create(deps) {
  const d = deps || {};
  const db = d.db || require('./db');
  const now = () => (d.now ? d.now() : new Date());
  const mailer = () => d.mailer || require('./mailer');

  async function withConn(fn) {
    const conn = await db.getPool().getConnection();
    try { return await fn(conn); } finally { conn.release(); }
  }
  const Qc = (conn) => async (sql, p) => (await conn.query(sql, p))[0];

  async function options(subId) {
    const sid = s(subId);
    if (!sid) return { ok: false, status: 400, message: 'Subscription id required.' };
    return withConn(async (conn) => {
      const Q = Qc(conn);
      const rows = await Q('SELECT * FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
      const sub = rows && rows[0];
      if (!sub) return { ok: false, status: 404, message: 'No subscription ' + sid + '.' };
      const ctx = await contextFor(Q, sub);
      const cust = sub.phone_norm ? await Q('SELECT name, email FROM customers WHERE phone_norm = ? LIMIT 1', [s(sub.phone_norm)]) : [];
      const email = s(sub.email) || s(cust[0] && cust[0].email);
      const out = {
        ok: true, allowed: true, reason: '',
        sub: {
          subId: sid, orderId: s(sub.order_id), service: s(sub.service), plan: s(sub.plan), status: s(sub.status), expiry: s(sub.expiry_date),
          name: s(cust[0] && cust[0].name), email: maskLogin(email), hasEmail: email.indexOf('@') > 0, policy: ctx.policy, sharing: ctx.sharing,
          devices: ctx.dev, tvDevices: ctx.tv, group: groupInfo(sub),
          otp: ctx.policy === 'OTP_ACCOUNT',
        },
        current: { accountId: ctx.curAcc, ref: s(sub.inventory_ref), login: maskLogin(sub.login_id), profileName: s(sub.profile_name), profileNumber: s(sub.profile_number), label: ctx.curAcc },
        accounts: [], defaultNote: DEFAULT_NOTE,
      };
      const refuse = refusalFor(sub, now().getTime()) || (ctx.policy === 'MANUAL' ? 'This service is delivered by hand — it has no inventory accounts to switch between.' : '');
      if (refuse) return Object.assign(out, { allowed: false, reason: refuse });
      const { current, others } = splitEntries(await accountEntries(conn, sub, ctx), ctx);
      if (current && current.label) out.current.label = current.label;
      out.accounts = others.map(publicEntry);
      if (!out.accounts.length) Object.assign(out, { allowed: false, reason: 'There are no other ' + s(sub.service) + ' accounts in inventory to switch to.' });
      else if (!out.accounts.some((a) => a.fits)) out.warning = 'Every other account is full or disabled right now.';
      return out;
    });
  }

  const cleanSide = (x) => { const o = Object.assign({}, x || {}); delete o.passTag; return o; };

  async function switchAccount(input) {
    const b = input || {};
    const sid = s(b.subId);
    const target = s(b.accountId);
    const note = s(b.note).slice(0, 200) || DEFAULT_NOTE;
    const wantEmail = !(b.email === false || s(b.email).toLowerCase() === 'false');
    const requestId = s(b.requestId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
    if (!sid) return { ok: false, status: 400, message: 'Subscription id required.' };
    if (!target) return { ok: false, status: 400, message: 'Choose the account to switch to.' };

    const I = F();
    const done = await I.withLock('ff_alloc', 12, async (conn) => {
      const Q = Qc(conn);
      const rows = await Q('SELECT * FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
      const sub = rows && rows[0];
      if (!sub) return { ok: false, status: 404, message: 'No subscription ' + sid + '.' };
      const raw = rawOf(sub.raw_json);
      const history = Array.isArray(raw.SwitchHistory) ? raw.SwitchHistory.filter((h) => h && typeof h === 'object') : [];
      // Double tap / retry: the first request already did it.
      const prev = requestId ? history.find((h) => h.requestId === requestId) : null;
      if (prev) return { ok: true, already: true, subId: sid, at: prev.at, from: cleanSide(prev.from), to: cleanSide(prev.to), message: 'Already switched to ' + s(prev.to && prev.to.accountId) + '.' };

      const refuse = refusalFor(sub, now().getTime());
      if (refuse) return { ok: false, status: 409, message: refuse };
      const ctx = await contextFor(Q, sub);
      if (ctx.policy === 'MANUAL') return { ok: false, status: 409, message: 'This service is delivered by hand — it has no inventory accounts to switch between.' };
      if (target === ctx.curAcc) return { ok: false, status: 409, message: 'That is the account this plan is already on. Pick a different one.' };

      // Re-check inside the lock: stock can change between opening the dialog and confirming.
      const entries = await accountEntries(conn, sub, ctx);
      const chosen = entries.find((e) => e.accountId === target && !e._current);
      if (!chosen) return { ok: false, status: 409, message: entries.some((e) => e._current && (e._ids || []).includes(target)) ? 'That account has the same login as the current one. Pick a different one.' : 'Account ' + target + ' is not a ' + s(sub.service) + ' account in inventory (or not sold for this plan).' };
      if (!chosen.fits) return { ok: false, status: 409, full: /full|no free|no room/.test(chosen.reason), message: 'Can\'t switch to ' + target + ': ' + chosen.reason + ' (it may have changed since the list was loaded). Refresh and pick another.' };

      const a = chosen._a;
      const prof = chosen._prof || null;
      const newRef = chosen._ref || target;
      const fresh = {
        inventory_ref: newRef, account_id: target, login_id: s(a.login_id), password: s(a.password),
        profile_number: prof ? String(prof.pno) : '', profile_name: prof ? chosen._profName : '', profile_pin: prof ? s(prof.pin) : '',
      };
      const at = istStamp(now());
      const entry = {
        id: 'SW' + crypto.randomBytes(5).toString('hex').toUpperCase(), requestId: requestId || null, at,
        from: { accountId: ctx.curAcc, ref: s(sub.inventory_ref), login: s(sub.login_id), profileNumber: s(sub.profile_number), passTag: passTag(sub.password) },
        to: { accountId: target, ref: newRef, login: fresh.login_id, profileNumber: fresh.profile_number },
        reason: note, by: 'admin', oldRemovedAt: null,
      };
      const line = '[' + at + ' IST] 🔁 Account switched ' + (entry.from.ref || entry.from.accountId || '?') + ' → ' + newRef + ' by admin: ' + note;
      let notes = (s(sub.notes) ? s(sub.notes) + '\n' : '') + line;
      if (notes.length > 4000) notes = notes.slice(-4000);
      Object.assign(raw, {
        InventoryRef: fresh.inventory_ref, AccountID: fresh.account_id, LoginId: fresh.login_id, Password: fresh.password,
        ProfileNumber: fresh.profile_number, ProfileName: fresh.profile_name, ProfilePIN: fresh.profile_pin, Notes: notes,
        SwitchedAt: at,
        SwitchedFrom: [entry.from.accountId, entry.from.ref, entry.from.login].filter(Boolean).join(' · '),
        SwitchedTo: [target, newRef, fresh.login_id].filter(Boolean).join(' · '),
        SwitchReason: note, SwitchedBy: 'admin',
        SwitchHistory: history.concat([entry]).slice(-HISTORY_MAX),
      });
      await I._inTransaction(conn, async () => {
        const [r] = await conn.query(
          'UPDATE subscriptions SET inventory_ref = ?, account_id = ?, login_id = ?, password = ?, profile_number = ?, profile_name = ?, profile_pin = ?, notes = ?, raw_json = ? ' +
          "WHERE sub_id = ? AND COALESCE(inventory_ref, '') = ? LIMIT 1",
          [fresh.inventory_ref, fresh.account_id, fresh.login_id, fresh.password, fresh.profile_number, fresh.profile_name, fresh.profile_pin, notes, JSON.stringify(raw), sid, s(sub.inventory_ref)]);
        if (!r || !r.affectedRows) throw Object.assign(new Error('This plan changed while switching — refresh and try again.'), { status: 409 });
      });
      console.log('[switch]', sid, 'from', entry.from.ref || entry.from.accountId, 'to', newRef);
      return { ok: true, subId: sid, sub, fresh, entry, ctx };
    });
    if (!done.ok || done.already) return done;

    // After the commit (the lock is not held while emailing).
    const { sub, fresh, entry, ctx } = done;
    let email = { sent: false, reason: wantEmail ? '' : 'not requested' };
    let name = '';
    try {
      const cust = sub.phone_norm ? await db.query('SELECT name, email FROM customers WHERE phone_norm = ? LIMIT 1', [s(sub.phone_norm)]) : [];
      name = s(cust && cust[0] && cust[0].name);
      const to = s(sub.email) || s(cust && cust[0] && cust[0].email);
      if (wantEmail && to.indexOf('@') < 1) email = { sent: false, reason: 'no email on this plan' };
      else if (wantEmail) {
        let rows = [Object.assign({}, sub, fresh)];
        if (s(sub.group_id)) {
          const g = await db.query('SELECT sub_id, login_id, password, profile_name, profile_pin, profile_number, device_type, device_count, tv_count, group_index FROM subscriptions WHERE group_id = ? ORDER BY group_index', [s(sub.group_id)]);
          if (Array.isArray(g) && g.length) rows = g.map((r) => (s(r.sub_id) === s(sub.sub_id) ? Object.assign({}, r, fresh) : r));
        }
        const access = deviceLogins.accessWithLogins(rows);
        const gi = groupInfo(sub);
        const notice = ['We moved your plan to a new account so you can keep watching. Your plan and expiry date are unchanged — please sign out of the old account and log in with the new details above.']
          .concat(gi.kind === 'SEPARATE' ? ['Only Device ' + (gi.index || '?') + '’s login changed — your other device' + (gi.size > 2 ? 's keep their' : ' keeps its') + ' login.'] : [])
          .concat(ctx.policy === 'OTP_ACCOUNT' ? ['To sign in, enter this number and use Get OTP on ' + (process.env.SITE_URL || 'shop.fluxfilm.in') + ' for the login code.'] : [])
          .join(' ');
        const r = await mailer().sendAccessEmail({
          switched: true, email: to, name, orderId: s(sub.order_id), service: s(sub.service), plan: s(sub.plan), expiry: s(sub.expiry_date),
          access, loginNotice: notice,
        });
        email = r && r.ok !== false && !r.skipped ? { sent: true, to: maskLogin(to) } : { sent: false, reason: (r && (r.skipped || r.message || r.error)) || 'not sent' };
      }
    } catch (e) { email = { sent: false, reason: String((e && e.message) || e) }; console.log('[switch] email failed for', sub.sub_id, email.reason); }
    return {
      ok: true, subId: done.subId, at: entry.at, from: cleanSide(entry.from), to: cleanSide(entry.to), reason: entry.reason,
      profile: fresh.profile_number ? { name: fresh.profile_name, number: fresh.profile_number } : null,
      email, name,
      message: '🔁 Switched to ' + entry.to.accountId + (fresh.profile_number ? ' (profile #' + fresh.profile_number + ')' : '') + (email.sent ? ' · email sent' : wantEmail ? ' · email not sent (' + email.reason + ')' : ''),
    };
  }

  return { options, switchAccount };
}

/* ---------------- 🚪 Remove users: the old account after a switch ---------------- */

/**
 * Pure. rows: subscriptions with a SwitchHistory (sub_id, order_id, phone_norm, name, service, plan, status, login_id,
 * inventory_ref, account_id, device_count, device_type, tv_count, raw_json); accounts: inventory_accounts (account_id,
 * login_id, password). One row per switch the owner still has to log the customer out of.
 */
function ghostRows(rows, accounts) {
  const passOf = new Map();
  for (const a of accounts || []) { const id = s(a.account_id); if (!id) continue; if (!passOf.has(id)) passOf.set(id, new Set()); passOf.get(id).add(passTag(a.password)); }
  const out = [];
  for (const r of rows || []) {
    if (/ERASED/.test(up(r.status))) continue;
    const hist = rawOf(r.raw_json).SwitchHistory;
    if (!Array.isArray(hist)) continue;
    const curAcc = accountOfRef(r.inventory_ref) || s(r.account_id);
    const curLogin = loginKey(r.login_id);
    for (const h of hist) {
      if (!h || typeof h !== 'object' || !s(h.id) || h.oldRemovedAt) continue;
      const f = h.from || {};
      const acc = s(f.accountId) || accountOfRef(f.ref);
      if (!acc && !s(f.login)) continue;
      if ((acc && acc === curAcc) || (s(f.login) && loginKey(f.login) === curLogin)) continue;   // switched back since
      const tags = passOf.get(acc);
      if (tags && s(f.passTag) && !tags.has(f.passTag)) continue;   // the old account's password changed since: logged out
      out.push({
        sub_id: s(r.sub_id) + '~' + s(h.id), order_id: r.order_id, phone_norm: r.phone_norm, name: r.name, service: r.service, plan: r.plan,
        status: 'SWITCHED', expiry_date: s(h.at), inventory_ref: s(f.ref) || acc, account_id: acc, login_id: s(f.login), removed: 0, renew_sub_id: null,
        device_count: r.device_count, device_type: r.device_type, tv_count: r.tv_count,
        switched_to: s(h.to && (h.to.ref || h.to.accountId)), switched_at: s(h.at),
      });
    }
  }
  return out;
}

const SWITCHED_SQL =
  'SELECT s.sub_id, s.order_id, s.phone_norm, s.service, s.plan, s.status, s.login_id, s.inventory_ref, s.account_id, s.device_count, s.device_type, s.tv_count, s.raw_json, ' +
  '(SELECT c.name FROM customers c WHERE c.phone_norm = s.phone_norm LIMIT 1) AS name ' +
  "FROM subscriptions s WHERE s.raw_json LIKE '%SwitchHistory%'";

/** For expiredusers.load(): ghost rows, [] on any problem (the list must always load). q = db.query-style. */
async function loadGhosts(q) {
  try {
    const rows = await q(SWITCHED_SQL, []);
    if (!Array.isArray(rows) || !rows.length) return [];
    const accounts = await Promise.resolve().then(() => q('SELECT account_id, login_id, password FROM inventory_accounts', [])).catch(() => []);
    return ghostRows(rows, Array.isArray(accounts) ? accounts : []);
  } catch (e) { console.log('[switch] remove-users ghosts skipped:', e.message); return []; }
}

/** Tick (or clear) "logged out of the old account" for ghost ids SUB-…~SW…. Returns how many changed. */
async function markOldRemoved(db, ids, removed, at) {
  const bySub = new Map();
  for (const id of ids || []) { const m = s(id).match(GHOST_RE); if (!m) continue; if (!bySub.has(m[1])) bySub.set(m[1], new Set()); bySub.get(m[1]).add(m[2]); }
  let changed = 0;
  for (const [sid, hids] of bySub) {
    const rows = await db.query('SELECT sub_id, raw_json FROM subscriptions WHERE sub_id = ? LIMIT 1', [sid]);
    if (!rows || !rows[0]) continue;
    const raw = rawOf(rows[0].raw_json);
    if (!Array.isArray(raw.SwitchHistory)) continue;
    let n = 0;
    for (const h of raw.SwitchHistory) {
      if (!h || !hids.has(s(h.id))) continue;
      if (removed && !h.oldRemovedAt) { h.oldRemovedAt = at; n++; } else if (!removed && h.oldRemovedAt) { h.oldRemovedAt = null; n++; }
    }
    if (!n) continue;
    await db.query('UPDATE subscriptions SET raw_json = ? WHERE sub_id = ? LIMIT 1', [JSON.stringify(raw), sid]);
    changed += n;
  }
  return changed;
}

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const S = create(deps);
  const now = () => (deps.now ? deps.now() : new Date());
  const fail = (res, e) => res.status((e && e.status) || (/Busy/.test(String(e && e.message)) ? 503 : 500)).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/subs/switch/options', async (req, res) => {
    if (!auth(req, res)) return;
    try { const r = await S.options(req.query.subId); res.status(r.ok ? 200 : r.status || 400).json(r); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/subs/switch', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await S.switchAccount(req.body || {});
      if (!r.ok) return res.status(r.status || 400).json(r);
      if (!r.already) {
        audit.record(req, {
          action: 'sub.switchAccount', entity: 'subscription', id: r.subId,
          summary: '🔁 Switched account ' + (r.from.ref || r.from.accountId || '?') + ' → ' + r.to.ref + ' (' + r.reason + ')' + (r.email.sent ? ' · new login emailed' : ' · email not sent: ' + (r.email.reason || '')),
          details: { at: r.at, from: { accountId: r.from.accountId, ref: r.from.ref }, to: { accountId: r.to.accountId, ref: r.to.ref }, reason: r.reason, emailSent: r.email.sent },
        });
      }
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  // 🚪 Remove users "✅ Removed" on a switched-away customer (ghost id) — the real subscription is still running, so
  // only its SwitchHistory entry is ticked. Any other id goes on to the usual handlers (admin.js / adminexpired.js).
  app.post('/admin/api/sub-removed', async (req, res, next) => {
    const b = req.body || {};
    if (!GHOST_RE.test(s(b.sub_id))) return next();
    if (!auth(req, res)) return;
    const removed = b.removed === true || b.removed === 1 || s(b.removed).toLowerCase() === 'true';
    try {
      const at = istStamp(now());
      const n = await markOldRemoved(db, [s(b.sub_id)], removed, at);
      if (!n) return res.status(404).json({ ok: false, message: 'Nothing to change for ' + s(b.sub_id) + '.' });
      audit.record(req, { action: removed ? 'sub.switchOldRemoved' : 'sub.switchOldUnremoved', entity: 'subscription', id: s(b.sub_id), summary: removed ? 'Ticked removed from the old account (after 🔁 switch)' : 'Cleared removed tick on the old account (after 🔁 switch)' });
      res.json({ ok: true, sub: { sub_id: s(b.sub_id), removed: removed ? 1 : 0, removed_at: removed ? at : null } });
    } catch (e) { fail(res, e); }
  });
  app.post('/admin/api/remove-users/removed', async (req, res, next) => {
    const b = req.body || {};
    const all = Array.isArray(b.subIds) ? b.subIds.map(s).filter(Boolean) : [];
    const ghosts = [...new Set(all.filter((x) => GHOST_RE.test(x)))];
    if (!ghosts.length) return next();
    if (!auth(req, res)) return;
    if (all.length > 100) return res.status(400).json({ ok: false, message: 'At most 100 at a time.' });
    try {
      const n = await markOldRemoved(db, ghosts, true, istStamp(now()));
      if (n) audit.record(req, { action: 'sub.switchOldRemoved', entity: 'account', id: s(b.label).slice(0, 80) || ghosts[0], summary: 'Ticked ' + n + ' switched-away customer(s) removed from the old account', details: { subIds: ghosts } });
      const rest = all.filter((x) => !GHOST_RE.test(x));
      if (!rest.length) return res.json({ ok: true, marked: n, skipped: ghosts.length - n, message: n ? '🚪 ' + n + ' customer' + (n === 1 ? '' : 's') + ' ticked removed.' : 'Nothing ticked (already removed).' });
      req.body = Object.assign({}, b, { subIds: rest });
      const json = res.json.bind(res);
      res.json = (body) => {
        if (body && body.ok) {
          body.marked = (Number(body.marked) || 0) + n;
          body.skipped = (Number(body.skipped) || 0) + (ghosts.length - n);
          body.message = body.marked ? '🚪 ' + body.marked + ' customer' + (body.marked === 1 ? '' : 's') + ' ticked removed.' + (body.skipped ? ' ' + body.skipped + ' skipped.' : '') : body.message;
        }
        return json(body);
      };
      next();
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, create, ghostRows, loadGhosts, markOldRemoved, maskLogin, istStamp, refusalFor, sortEntries, groupInfo, SWITCHED_SQL, HISTORY_MAX, GHOST_RE };
