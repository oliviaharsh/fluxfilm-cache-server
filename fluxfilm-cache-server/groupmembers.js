/**
 * FluxFilm — 👥 the WhatsApp group: who said they joined, and who is actually in it.
 *
 * Group Offer plans are cheaper because the customer joins the FluxFilm WhatsApp group. Two things were missing:
 *
 *   1. The "I have joined" tap was thrown away. It lived in the checkout's React state and in Olivia's chat state,
 *      and neither outlives the session, so nothing recorded who had ever said yes. `claim()` writes it down.
 *   2. There is no WhatsApp API that will list a group's members — not officially, and nothing worth running the
 *      business on. So the owner pastes the list (or an exported chat) and this file reconciles it against who is
 *      paying. `reconcile()` reads, `applyList()` writes.
 *
 * What the screen is FOR — three questions, each with an action behind it:
 *   · who is paying for a Group Offer and is NOT in the group   → chase them, or stop the discount
 *   · who is in the group and is paying for nothing             → remove them
 *   · who said they joined and never showed up in a list        → the tap was a lie, or they left again
 *
 * ⚠️ phone_norm is NEVER compared with customers / subscriptions in SQL. Those tables and the newer ones are in
 * different collations and MariaDB refuses the comparison — the failure that silently emptied the ▶️ Today count
 * on 27 Sep 2026. Every side is read on its own and matched in JavaScript, here and everywhere below.
 *
 * 🔐 Read-only about people: it never messages anybody, never adds or removes anyone from the group, and never
 * touches a subscription. Removing someone from WhatsApp is still done by hand, on purpose.
 *
 *   GET  /admin/api/group              who claimed, who was last seen, and who is missing
 *   POST /admin/api/group/paste        paste a member list → what it would change (apply: true to save it)
 *   POST /admin/api/group/member       edit the note on one row, or forget it
 */
const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (v) => { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; };
const sqlNow = (at) => new Date((at == null ? Date.now() : at) + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

/** Whole days until this expiry, in IST — counted the same way accounttools.js and ytfamilies.js count them. */
function daysLeft(v, now) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const t = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00+05:30').getTime();
  return Math.ceil((t - (now == null ? Date.now() : now)) / 86400000);
}

// ── reading a pasted list ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Every phone number in a line of text.
 *
 * Deliberately fussy, because the thing most likely to be pasted is an exported chat and EVERY line of one starts
 * with a date and a time. "28/09/2026, 20:14" is nine digits with punctuation through it; a loose "find digits"
 * regex turns that into a phone number and quietly invents members. So: digits may be separated by spaces and
 * hyphens only — never by a slash, dot or colon — and the result has to be a plausible Indian mobile.
 */
/** An Indian mobile, and nothing else: 10 digits starting 6-9, optionally behind a trunk / country prefix. */
const isMobile = (d) => (d.length === 10 ? /^[6-9]/.test(d) : /^(0|91|091|0091)[6-9]\d{9}$/.test(d));
/** The "28/09/2026, 20:14 - " that starts every line of an exported chat, in the shapes WhatsApp writes it. */
const STAMP_RE = /^\s*\[?\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*\]?\s*[-–]?\s*/i;

function phonesIn(line) {
  const out = [];
  // Split on anything a phone number cannot contain. A date is broken up by its slashes and a time by its colon,
  // so neither survives as one run of digits — and a name or a word ends the run it is next to.
  for (const chunk of s(line).replace(STAMP_RE, ' ').split(/[^\d+\s-]+/)) {
    let toks = chunk.split(/[\s-]+/).filter((x) => /\d/.test(x));
    const here = [];
    // Take the LONGEST trailing group of tokens that reads as one number, then keep going on what is left of it.
    // Reading left to right and stopping at the first match instead is what loses numbers: a greedy match that
    // swallows "20 14 - +91 98765 43210" fails the mobile test as a whole and takes the real number down with it.
    while (toks.length) {
      let hit = -1;
      for (let i = 0; i < toks.length; i++) {
        if (isMobile(toks.slice(i).join('').replace(/\D/g, ''))) { hit = i; break; }
      }
      if (hit < 0) break;
      here.unshift(toks.slice(hit).join('').replace(/\D/g, '').slice(-10));
      toks = toks.slice(0, hit);
    }
    for (const p of here) out.push(p);
  }
  return out;
}

const JOINED_RE = /joined using this group|was added|added (you|\+?\d)|joined the group/i;
// "left" only at the very end of the line, because that is where WhatsApp puts it ("+91 98765 43210 left") and
// because a member typing "I left my phone at home" must not remove themselves from the group.
const LEFT_RE = /\bleft\s*$|was removed\s*$|removed (\+?\d)/i;

/**
 * Turn whatever was pasted into a set of numbers that are in the group now.
 *
 * Two shapes, told apart by what is in the text rather than by a switch the owner has to understand:
 *   · an EXPORTED CHAT — has "joined using this group's invite link" / "left" lines. Replayed in order, so
 *     somebody who joined in June and left in August is correctly OUT. This is the only shape a phone can
 *     actually produce: WhatsApp will not let you select the participants list, but it will export the chat.
 *   · a plain LIST — anything else. Every number in it is a member. What you get from WhatsApp Web, a
 *     screenshot typed out, or a list kept by hand.
 */
function parseList(text) {
  const lines = s(text).split(/\r?\n/);
  let events = 0;
  const state = new Map(); // phone -> true (in) / false (out)
  const seenAnywhere = new Set();
  for (const line of lines) {
    const ph = phonesIn(line);
    if (!ph.length) continue;
    const joined = JOINED_RE.test(line);
    const left = LEFT_RE.test(line);
    for (const p of ph) seenAnywhere.add(p);
    if (joined && !left) { events++; for (const p of ph) state.set(p, true); }
    else if (left && !joined) { events++; for (const p of ph) state.set(p, false); }
  }
  const mode = events > 0 ? 'export' : 'list';
  if (mode === 'list') return { mode, events: 0, phones: [...seenAnywhere] };
  // In an export, somebody who never has an event but does send messages is in the group too.
  for (const p of seenAnywhere) if (!state.has(p)) state.set(p, true);
  return { mode, events, phones: [...state.entries()].filter(([, inGroup]) => inGroup).map(([p]) => p) };
}

// ── who is supposed to be in the group ────────────────────────────────────────────────────────────────────────
const SUBS_SQL =
  'SELECT sub_id, phone_norm, name, service, plan, expiry_date, status FROM subscriptions ' +
  "WHERE UPPER(COALESCE(status,'')) NOT IN ('REFUNDED','CANCELLED')";

/**
 * The services sold on the "join the group" deal. Taken from the plans themselves (RequiresGroupJoin in
 * raw_json, which is what the storefront gates on) rather than guessed from a name — a plan renamed in admin
 * must not quietly drop out of this screen. The /group/i fallback only covers a plan whose flag was never set.
 */
async function groupServices(query) {
  const out = new Set();
  let rows = [];
  try { rows = await query('SELECT service, plan, raw_json FROM plans', []); } catch (_) { rows = []; }
  for (const r of rows) {
    let raw = {};
    try { raw = r.raw_json ? (typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json) : {}; } catch (_) { raw = {}; }
    const flag = s(raw.RequiresGroupJoin).toUpperCase();
    if (flag === 'TRUE' || flag === '1' || flag === 'YES' || /group/i.test(s(r.service))) out.add(s(r.service).toLowerCase());
  }
  return out;
}

function stateOf(sub, now) {
  const d = daysLeft(sub && sub.expiry_date, now);
  if (d == null) return { state: 'UNKNOWN', days: null };
  if (d <= 0) return { state: 'EXPIRED', days: d };
  if (d <= 7) return { state: 'ENDING', days: d };
  return { state: 'ACTIVE', days: d };
}

/**
 * Everything the screen needs. Three reads, no joins, matched on the 10-digit phone in JavaScript.
 */
async function overview(query, now) {
  const at = now == null ? Date.now() : now;
  let rows;
  try {
    rows = await query('SELECT id, phone_norm, name, claimed_at, claimed_via, claimed_for, seen_at, missing_at, note FROM wa_group_members', []);
  } catch (e) {
    if (/wa_group_members/i.test(String(e && e.message)) && /doesn't exist|Unknown table/i.test(String(e && e.message))) {
      return { ok: true, needsSchema: true, members: [], owe: [], strangers: [], totals: { claimed: 0, seen: 0, owe: 0, strangers: 0, neverSeen: 0 } };
    }
    throw e;
  }
  const byPhone = new Map(rows.map((r) => [norm(r.phone_norm), r]));
  const services = await groupServices(query);
  const subs = (await query(SUBS_SQL, [])).filter((x) => services.has(s(x.service).toLowerCase()));

  // One line per person who is paying for a Group Offer plan today.
  const owed = new Map();
  for (const sub of subs) {
    const ph = norm(sub.phone_norm);
    if (!ph) continue;
    const st = stateOf(sub, at);
    const prev = owed.get(ph);
    // Somebody with two group subs is one person in the group; keep the one that runs longest.
    if (prev && s(prev.expiry) >= s(sub.expiry_date)) continue;
    owed.set(ph, {
      phone: ph, name: s(sub.name) || 'Unknown', service: s(sub.service), plan: s(sub.plan),
      subId: s(sub.sub_id), expiry: s(sub.expiry_date), expiryLabel: prettyDate(sub.expiry_date),
      state: st.state, days: st.days,
    });
  }

  const row = (r) => ({
    id: Number(r.id), phone: norm(r.phone_norm), name: s(r.name),
    claimedAt: s(r.claimed_at), claimedVia: s(r.claimed_via), claimedFor: s(r.claimed_for),
    seenAt: s(r.seen_at), missingAt: s(r.missing_at), note: s(r.note),
    // seen_at set and missing_at cleared, NOT 'the later of the two timestamps'. Both are written to the second,
    // so two lists checked inside the same second made a member who had left look present — a real ordering bug
    // that a slow afternoon would have hidden for months. applyList clears missing_at whenever it sees them.
    inGroup: !!s(r.seen_at) && !s(r.missing_at),
  });
  const members = rows.map(row);
  const inGroup = new Set(members.filter((m) => m.inGroup).map((m) => m.phone));
  const everChecked = members.some((m) => m.seenAt || m.missingAt);

  // Paying, not in the group. Only meaningful once a list has been pasted at least once — before that we do not
  // know who is in the group, and a screen full of red would be a lie, so it says "not checked yet" instead.
  const owe = (everChecked ? [...owed.values()] : [])
    .filter((p) => p.state !== 'EXPIRED' && !inGroup.has(p.phone))
    .map((p) => Object.assign({}, p, byPhone.has(p.phone) ? { claimedAt: s((byPhone.get(p.phone) || {}).claimed_at) } : {}))
    .sort((a, b) => s(a.expiry).localeCompare(s(b.expiry)));

  // In the group, paying for nothing. Expired group customers are named as such — they are the ones to remove.
  const strangers = members.filter((m) => m.inGroup && !owed.has(m.phone)).map((m) => Object.assign({}, m, { was: null }));
  const expiredIn = [...owed.values()].filter((p) => p.state === 'EXPIRED' && inGroup.has(p.phone));

  return {
    ok: true,
    everChecked,
    members: members.sort((a, b) => s(b.claimedAt || b.seenAt).localeCompare(s(a.claimedAt || a.seenAt))),
    owe, strangers, expiredIn,
    totals: {
      claimed: members.filter((m) => m.claimedAt).length,
      seen: inGroup.size,
      owe: owe.length,
      strangers: strangers.length,
      expiredIn: expiredIn.length,
      neverSeen: members.filter((m) => m.claimedAt && !m.seenAt).length,
    },
  };
}

/**
 * What a pasted list says, without writing anything. The owner sees this before it is saved, because a bad paste
 * (the wrong group, half a screen, a list of order ids) would otherwise mark every real member as having left.
 */
async function reconcile(query, text, now) {
  const at = now == null ? Date.now() : now;
  const parsed = parseList(text);
  const view = await overview(query, at);
  if (view.needsSchema) return { ok: true, needsSchema: true };
  const found = new Set(parsed.phones);
  const owed = new Map(view.owe.concat(view.expiredIn || []).map((p) => [p.phone, p]));
  for (const m of view.members) if (!owed.has(m.phone)) owed.set(m.phone, null);

  const known = new Map(view.members.map((m) => [m.phone, m]));
  const nowIn = [...found];
  const newRows = nowIn.filter((p) => !known.has(p));
  const goneAway = view.members.filter((m) => m.inGroup && !found.has(m.phone)).map((m) => ({ phone: m.phone, name: m.name }));
  return {
    ok: true,
    mode: parsed.mode, events: parsed.events,
    countFound: nowIn.length,
    newRows: newRows.length,
    goneAway,
    // Named here so the owner can see the paste was understood before it is saved.
    sample: nowIn.slice(0, 5),
  };
}

/** Save a pasted list: everyone in it is seen now, everyone previously in it and absent from it has gone. */
async function applyList(query, text, now) {
  const at = now == null ? Date.now() : now;
  const stamp = sqlNow(at);
  const parsed = parseList(text);
  if (!parsed.phones.length) return { ok: false, message: 'No phone numbers could be read out of that. Paste the participant list, or an exported chat.' };
  const rows = await query('SELECT id, phone_norm, seen_at, missing_at FROM wa_group_members', []);
  const known = new Map(rows.map((r) => [norm(r.phone_norm), r]));
  const found = new Set(parsed.phones);
  let added = 0; let seen = 0; let gone = 0;
  for (const p of found) {
    if (known.has(p)) { await query('UPDATE wa_group_members SET seen_at = ?, missing_at = NULL WHERE id = ?', [stamp, known.get(p).id]); seen++; }
    else { await query('INSERT INTO wa_group_members (phone_norm, name, seen_at) VALUES (?, ?, ?)', [p, '', stamp]); added++; }
  }
  for (const r of rows) {
    const p = norm(r.phone_norm);
    if (found.has(p)) continue;
    if (!s(r.seen_at)) continue;                       // never seen in a list: nothing to have left
    if (s(r.missing_at)) continue;                     // already marked gone by an earlier list
    await query('UPDATE wa_group_members SET missing_at = ? WHERE id = ?', [stamp, r.id]);
    gone++;
  }
  return { ok: true, mode: parsed.mode, added, seen, gone, total: found.size };
}

/**
 * Record that this person says they have joined the group. Called from the storefront checkout and from Olivia,
 * and it must never be able to stop either of them: a claim that does not save is a missing line on one screen,
 * an order that does not save is a customer with no plan.
 */
async function claim(phone, name, via, service, deps) {
  const ph = norm(phone);
  if (!ph) return { ok: false };
  const query = (deps && deps.query) || require('./db').query;
  const stamp = sqlNow(deps && deps.now ? deps.now() : null);
  try {
    // The name and the service are only worth writing when we have them; a later claim must not blank an earlier one.
    await query(
      'INSERT INTO wa_group_members (phone_norm, name, claimed_at, claimed_via, claimed_for) VALUES (?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE claimed_at = VALUES(claimed_at), claimed_via = VALUES(claimed_via), ' +
      'name = COALESCE(NULLIF(VALUES(name), \'\'), name), claimed_for = COALESCE(NULLIF(VALUES(claimed_for), \'\'), claimed_for)',
      [ph, s(name).slice(0, 120), stamp, s(via).slice(0, 16), s(service).slice(0, 80)]);
    return { ok: true };
  } catch (e) {
    // Includes "table doesn't exist" — schema-v31 not run yet. Says so once in the log and gets out of the way.
    console.log('[group] could not record the join claim for ...' + ph.slice(-4) + ':', e.message);
    return { ok: false };
  }
}

function mount(app, deps) {
  const { auth } = deps;
  const db = deps.db || require('./db');
  const query = (sql, p) => db.query(sql, p || []);
  const audit = deps.audit || { record: () => {} };
  const now = deps.now || (() => Date.now());
  const fail = (res, e) => {
    if (/wa_group_members/i.test(String(e && e.message)) && /doesn't exist|Unknown table/i.test(String(e && e.message))) {
      return res.json({ ok: false, needsSchema: true, message: 'Run db/schema-v31.sql in phpMyAdmin first — it makes the group table.' });
    }
    return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };

  app.get('/admin/api/group', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await overview(query, now())); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/group/paste', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const text = s(b.text);
    if (!text) return res.status(400).json({ ok: false, message: 'Paste the member list first.' });
    try {
      if (b.apply !== true) return res.json(await reconcile(query, text, now()));
      const r = await applyList(query, text, now());
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'group.list', entity: 'settings', id: 'wa_group', summary: 'group list checked — ' + r.total + ' in the group (' + r.added + ' new, ' + r.gone + ' gone)' });
      res.json(Object.assign(r, { view: await overview(query, now()) }));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/group/member', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = n(b.id, 0);
    if (!id) return res.status(400).json({ ok: false, message: 'Which row?' });
    try {
      if (s(b.action) === 'forget') {
        await query('DELETE FROM wa_group_members WHERE id = ? LIMIT 1', [id]);
        audit.record(req, { action: 'group.forget', entity: 'settings', id: 'wa_group', summary: 'forgot one group row' });
      } else {
        await query('UPDATE wa_group_members SET note = ? WHERE id = ? LIMIT 1', [s(b.note).slice(0, 200), id]);
      }
      res.json(Object.assign({ ok: true }, await overview(query, now())));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, claim, _internal: { phonesIn, parseList, overview, reconcile, applyList, groupServices, stateOf, daysLeft, prettyDate, sqlNow } };
