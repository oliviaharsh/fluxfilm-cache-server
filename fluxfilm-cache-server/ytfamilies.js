/**
 * FluxFilm — ▶️ YouTube families: who is in which Google family, when they expire, and how much room is left.
 *
 * YouTube Premium is the odd one out. Every other service is delivered on one of OUR logins, so a subscription
 * points at an inventory account and the panel can already say who sits where. YouTube is delivered by INVITING
 * the customer's own Google address into one of our families — there is no profile, no seat, nothing to point at,
 * and all 40 YouTube subscriptions carry inventory_ref NULL. The map lived in the owner's spreadsheet, so the two
 * questions that actually matter could not be answered here at all:
 *
 *     which family is this person in (so I can remove them when they expire)
 *     how much room have I got left (so I know whether I can sell another one)
 *
 * Deliberately its own two tables and NOT inventory_accounts: that table feeds allocation, stock and the
 * 🚪 Remove users grouping. A Google family is not an account we hand over, and quietly making it look like one
 * would change live selling to gain nothing. YouTube stays MANUAL in fulfill.js, untouched by this file.
 *
 *   GET  /admin/api/yt                      families, their seats, who is unplaced, and the free-seat count
 *   POST /admin/api/yt/family               add / edit / remove a family
 *   POST /admin/api/yt/seat                 put a customer in a family, move them, edit them, or release the seat
 *   POST /admin/api/yt/import               paste the old spreadsheet; match by email and place everyone at once
 *
 * 🔐 Read-only about people: it never emails, never invites and never touches a subscription row. Releasing a
 * seat records that OUR family no longer holds them — removing them at Google is still done by hand, on purpose.
 */
const s = (v) => String(v == null ? '' : v).trim();
const low = (v) => s(v).toLowerCase();
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** YouTube under any of the names it has been sold as ("YouTube Premium", "Youtube premium 1Y", …). */
const IS_YT = (svc) => /you\s*tube/i.test(s(svc));
const YT_LIKE = '%youtube%';

/** The part of an address the owner recognises — "rbk.andheri89@gmail.com" -> "rbk.andheri89". */
const localPart = (v) => s(v).split('@')[0];
/** …and the domain only as a hint, so a screenshot of this screen does not hand out a working address. */
const domainHint = (v) => { const d = s(v).split('@')[1] || ''; return d ? d.replace(/^[^.]*/, (m) => m.slice(0, 1) + '…') : ''; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (v) => { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : s(v); };

/** Whole days until this expiry, in IST, counted the same way accounttools.js counts them. */
function daysLeft(v, now) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const t = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00+05:30').getTime();
  return Math.ceil((t - (now == null ? Date.now() : now)) / 86400000);
}

/**
 * What the screen shows for one customer. EXPIRED means the seat is still taken at Google but the money has
 * stopped — that is the whole point of the screen, so it is never hidden, only marked.
 */
function stateOf(sub, now) {
  const d = daysLeft(sub && sub.expiry_date, now);
  const st = s(sub && sub.status).toUpperCase();
  if (st === 'REFUNDED' || st === 'CANCELLED') return { state: 'ENDED', days: d };
  if (d == null) return { state: 'UNKNOWN', days: null };
  if (d <= 0) return { state: 'EXPIRED', days: d };
  if (d <= 7) return { state: 'ENDING', days: d };
  return { state: 'ACTIVE', days: d };
}

/** Every YouTube subscription worth showing: ended ones matter too, because they are still sitting in a family. */
const SUBS_SQL =
  'SELECT s.sub_id, s.phone_norm, s.email, s.service, s.plan, s.expiry_date, s.status, COALESCE(s.removed, 0) AS removed, c.name ' +
  'FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm ' +
  'WHERE LOWER(s.service) LIKE ? ORDER BY s.expiry_date ASC LIMIT 2000';

/**
 * A subscription is worth a seat while it is alive. A refunded or cancelled one that has already been let go
 * (removed = 1) is history and clutters the "who still needs placing" list.
 */
const placeable = (x, now) => {
  const st = stateOf(x, now).state;
  if (Number(x.removed) === 1 && st !== 'ACTIVE' && st !== 'ENDING') return false;
  return st !== 'ENDED';
};

async function overview(query, now) {
  const at = now == null ? Date.now() : now;
  let fams = [];
  let seats = [];
  let guestsOff = false;   // schema-v30 not run: no guest places yet, and the screen says so instead of offering one
  try {
    fams = await query('SELECT id, login, label, slots, is_active, notes FROM yt_families ORDER BY login', []);
    seats = await query('SELECT id, family_id, sub_id, person, invited_email, joined_on, left_on, note FROM yt_seats WHERE left_on IS NULL', []);
  } catch (e) {
    // schema-v30 not run: the person column is missing, so read the rest and treat every seat as a customer.
    if (/Unknown column .*person/i.test(String(e && e.message))) {
      seats = (await query('SELECT id, family_id, sub_id, invited_email, joined_on, left_on, note FROM yt_seats WHERE left_on IS NULL', [])).map((x) => Object.assign({ person: '' }, x));
      guestsOff = true;
      // and fall through to build the screen normally — every seat is an ordinary customer until v30 is run
    } else if (/yt_families|yt_seats|doesn't exist|Unknown table/i.test(String(e && e.message))) {
      // schema-v29 not run yet: say so plainly rather than showing an empty screen that looks like "no families".
      return { ok: true, needsSchema: true, families: [], unplaced: [], totals: { families: 0, slots: 0, used: 0, free: 0, expiredInFamily: 0, unplaced: 0 } };
    } else {
      throw e;
    }
  }
  const subs = await query(SUBS_SQL, [YT_LIKE]);
  const bySub = new Map(subs.map((x) => [s(x.sub_id), x]));

  const person = (sub, seat) => {
    const st = stateOf(sub, at);
    return {
      seatId: seat ? seat.id : null,
      subId: s(sub.sub_id),
      name: s(sub.name) || 'Unknown',
      phone: s(sub.phone_norm),
      emailShort: localPart(seat && seat.invited_email ? seat.invited_email : sub.email),
      emailHint: domainHint(seat && seat.invited_email ? seat.invited_email : sub.email),
      email: s(seat && seat.invited_email ? seat.invited_email : sub.email),
      plan: s(sub.plan),
      expiry: s(sub.expiry_date),
      expiryLabel: prettyDate(sub.expiry_date),
      state: st.state,
      days: st.days,
      note: s(seat && seat.note),
    };
  };

  /**
   * A place held by somebody with no subscription — an old customer given YouTube for nothing (Vishal R Vipin,
   * owner 26 Sep 2026). They occupy a real place at Google, so the free count is only honest if it counts them.
   */
  const guest = (seat) => ({
    seatId: seat.id, subId: '', name: s(seat.person) || 'Guest', phone: '',
    emailShort: localPart(seat.invited_email), emailHint: domainHint(seat.invited_email), email: s(seat.invited_email),
    plan: 'no plan — free', expiry: '', expiryLabel: '', state: 'GUEST', days: null, note: s(seat.note),
  });

  const taken = new Set();
  const families = fams.map((f) => {
    const mine = seats.filter((x) => Number(x.family_id) === Number(f.id));
    const people = [];
    for (const seat of mine) {
      if (!s(seat.sub_id)) { people.push(guest(seat)); continue; }
      const sub = bySub.get(s(seat.sub_id));
      taken.add(s(seat.sub_id));
      // A seat whose subscription has vanished from the table still occupies a place at Google — show it, do not drop it.
      people.push(sub ? person(sub, seat)
        : { seatId: seat.id, subId: s(seat.sub_id), name: 'Unknown', phone: '', emailShort: localPart(seat.invited_email), emailHint: domainHint(seat.invited_email), email: s(seat.invited_email), plan: '', expiry: '', expiryLabel: '', state: 'GONE', days: null, note: s(seat.note) });
    }
    people.sort((a, b) => (a.expiry ? s(a.expiry) : '9999').localeCompare(b.expiry ? s(b.expiry) : '9999'));
    const slots = Math.max(0, n(f.slots, 5));
    return {
      id: Number(f.id), login: s(f.login), loginShort: localPart(f.login), label: s(f.label),
      slots, isActive: Number(f.is_active) !== 0, notes: s(f.notes),
      people,
      used: people.length,
      free: Math.max(0, slots - people.length),
      over: Math.max(0, people.length - slots),
      expiredHere: people.filter((p) => p.state === 'EXPIRED' || p.state === 'GONE').length,
    };
  });

  // Customers paying for YouTube who are in no family here. Either they were never recorded, or nobody placed them.
  const unplaced = subs.filter((x) => !taken.has(s(x.sub_id)) && placeable(x, at)).map((x) => person(x, null));

  const totals = {
    families: families.length,
    slots: families.reduce((t, f) => t + (f.isActive ? f.slots : 0), 0),
    used: families.reduce((t, f) => t + (f.isActive ? f.used : 0), 0),
    free: families.reduce((t, f) => t + (f.isActive ? f.free : 0), 0),
    expiredInFamily: families.reduce((t, f) => t + f.expiredHere, 0),
    unplaced: unplaced.length,
  };
  return { ok: true, guestsOff, families, unplaced, totals };
}

function mount(app, deps) {
  const { auth } = deps;
  const db = deps.db || require('./db');
  const query = (sql, p) => db.query(sql, p || []);
  const audit = deps.audit || { record: () => {} };
  const fail = (res, e) => {
    if (/yt_families|yt_seats/i.test(String(e && e.message)) && /doesn't exist|Unknown table/i.test(String(e && e.message))) {
      return res.json({ ok: false, needsSchema: true, message: 'Run db/schema-v29.sql in phpMyAdmin first — it makes the two YouTube tables.' });
    }
    return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };

  app.get('/admin/api/yt', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await overview(query)); } catch (e) { fail(res, e); }
  });

  // Add / edit / remove one family.
  app.post('/admin/api/yt/family', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = n(b.id, 0);
    try {
      if (s(b.action) === 'delete') {
        if (!id) return res.json({ ok: false, message: 'Which family?' });
        const held = (await query('SELECT COUNT(*) AS c FROM yt_seats WHERE family_id = ? AND left_on IS NULL', [id]))[0];
        // Deleting a family with people still in it would lose the only record of where they are.
        if (Number(held && held.c) > 0) return res.json({ ok: false, message: 'Take the ' + held.c + ' member(s) out of this family first.' });
        const old = (await query('SELECT login FROM yt_families WHERE id = ? LIMIT 1', [id]))[0];
        await query('DELETE FROM yt_families WHERE id = ?', [id]);
        audit.record(req, { action: 'yt.family.delete', entity: 'yt_family', id: String(id), summary: '▶️ removed the YouTube family ' + s(old && old.login) });
        return res.json(await overview(query));
      }
      const login = low(b.login);
      if (!login || login.indexOf('@') < 1) return res.json({ ok: false, message: 'Give the family account address, e.g. name@gmail.com.' });
      const slots = Math.min(20, Math.max(1, n(b.slots, 5)));
      const label = s(b.label).slice(0, 120);
      const notes = s(b.notes).slice(0, 500);
      const isActive = b.isActive === undefined ? 1 : (b.isActive ? 1 : 0);
      if (id) {
        await query('UPDATE yt_families SET login = ?, label = ?, slots = ?, is_active = ?, notes = ? WHERE id = ?', [login, label, slots, isActive, notes, id]);
        audit.record(req, { action: 'yt.family.edit', entity: 'yt_family', id: String(id), summary: '▶️ edited the YouTube family ' + login, details: { slots, isActive } });
      } else {
        const dupe = (await query('SELECT id FROM yt_families WHERE login = ? LIMIT 1', [login]))[0];
        if (dupe) return res.json({ ok: false, message: 'That family is already here.' });
        await query('INSERT INTO yt_families (login, label, slots, is_active, notes) VALUES (?, ?, ?, ?, ?)', [login, label, slots, isActive, notes]);
        audit.record(req, { action: 'yt.family.add', entity: 'yt_family', id: login, summary: '▶️ added the YouTube family ' + login + ' (' + slots + ' places)' });
      }
      res.json(await overview(query));
    } catch (e) { fail(res, e); }
  });

  /** One customer in, out, or moved. Everything goes through here so a sub can never sit in two families. */
  async function place(req, subId, familyId, email, note) {
    const open = await query('SELECT id, family_id FROM yt_seats WHERE sub_id = ? AND left_on IS NULL', [subId]);
    for (const row of open) await query('UPDATE yt_seats SET left_on = NOW() WHERE id = ?', [row.id]);
    if (!familyId) return { moved: false, released: open.length };
    await query('INSERT INTO yt_seats (family_id, sub_id, invited_email, note) VALUES (?, ?, ?, ?)', [familyId, subId, low(email).slice(0, 190), s(note).slice(0, 255)]);
    return { moved: true, released: open.length };
  }

  /** How many places a family has left right now. Used before every insert, so the free count cannot drift. */
  async function roomIn(familyId, exceptSeatId) {
    const fam = (await query('SELECT id, login, slots FROM yt_families WHERE id = ? LIMIT 1', [familyId]))[0];
    if (!fam) return null;
    const held = (await query('SELECT COUNT(*) AS c FROM yt_seats WHERE family_id = ? AND left_on IS NULL AND id <> ?', [familyId, Number(exceptSeatId) || 0]))[0];
    return { fam, used: Number((held && held.c) || 0), slots: Math.max(1, n(fam.slots, 5)) };
  }

  const guestFail = (e) => /Unknown column .*person|cannot be null/i.test(String(e && e.message));

  app.post('/admin/api/yt/seat', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const subId = s(b.subId);
    const familyId = n(b.familyId, 0);
    const seatId = n(b.seatId, 0);
    const action = s(b.action);

    // ── somebody with no subscription at all: an old customer given YouTube for nothing. They hold a real place
    //    at Google, so the screen has to be able to hold one too, or "places free" is wrong.
    if (action === 'guest') {
      const person = s(b.person).slice(0, 120);
      if (!person) return res.json({ ok: false, message: 'Who is it? Put a name in.' });
      try {
        const r = await roomIn(familyId, 0);
        if (!r) return res.json({ ok: false, message: 'No such family.' });
        if (r.used >= r.slots) return res.json({ ok: false, message: s(r.fam.login) + ' is full (' + r.slots + ' places). Take somebody out first.' });
        await query('INSERT INTO yt_seats (family_id, sub_id, person, invited_email, note) VALUES (?, NULL, ?, ?, ?)', [familyId, person, low(b.email).slice(0, 190), s(b.note).slice(0, 255)]);
        audit.record(req, { action: 'yt.seat.guest', entity: 'yt_family', id: String(familyId), summary: '▶️ ' + person + ' (no plan) given a place in ' + s(r.fam.login), details: { person, familyId } });
        return res.json(await overview(query));
      } catch (e) { return guestFail(e) ? res.json({ ok: false, needsSchema: true, message: 'Run db/schema-v30.sql in phpMyAdmin first — it lets a place be held by somebody with no plan.' }) : fail(res, e); }
    }

    // ── correct what is written on a place: the address actually invited at Google (often NOT the order email)
    //    and a note. Owner, 26 Sep 2026: "change avtar email to manmeet5mkkaur".
    if (action === 'edit') {
      if (!seatId) return res.json({ ok: false, message: 'Which place?' });
      try {
        const sets = ['invited_email = ?', 'note = ?'];
        const vals = [low(b.email).slice(0, 190), s(b.note).slice(0, 255)];
        if (b.person !== undefined) { sets.push('person = ?'); vals.push(s(b.person).slice(0, 120)); }
        await query('UPDATE yt_seats SET ' + sets.join(', ') + ' WHERE id = ?', vals.concat([seatId]));
        audit.record(req, { action: 'yt.seat.edit', entity: 'yt_seat', id: String(seatId), summary: '▶️ corrected the invited address on a YouTube place', details: { seatId, email: low(b.email) } });
        return res.json(await overview(query));
      } catch (e) { return guestFail(e) ? res.json({ ok: false, needsSchema: true, message: 'Run db/schema-v30.sql in phpMyAdmin first.' }) : fail(res, e); }
    }

    // ── free a place held by a guest: there is no subscription to name it by, so it goes by the place itself
    if (seatId && !subId) {
      try {
        const row = (await query('SELECT id, family_id, person FROM yt_seats WHERE id = ? AND left_on IS NULL LIMIT 1', [seatId]))[0];
        if (!row) return res.json({ ok: false, message: 'That place is already free.' });
        await query('UPDATE yt_seats SET left_on = NOW() WHERE id = ?', [seatId]);
        audit.record(req, { action: 'yt.seat.release', entity: 'yt_seat', id: String(seatId), summary: '▶️ ' + (s(row.person) || 'a guest') + ' taken out of the YouTube family', details: { seatId } });
        return res.json(await overview(query));
      } catch (e) { return fail(res, e); }
    }

    if (!subId) return res.json({ ok: false, message: 'Which customer?' });
    try {
      const sub = (await query('SELECT s.sub_id, s.service, s.email, c.name FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm WHERE s.sub_id = ? LIMIT 1', [subId]))[0];
      // A seat is only ever about a YouTube subscription; anything else is a mistake worth refusing out loud.
      if (!sub) return res.json({ ok: false, message: 'No subscription with that id.' });
      if (!IS_YT(sub.service)) return res.json({ ok: false, message: 'That subscription is ' + s(sub.service) + ', not YouTube.' });
      let fam = null;
      if (familyId) {
        fam = (await query('SELECT id, login, slots FROM yt_families WHERE id = ? LIMIT 1', [familyId]))[0];
        if (!fam) return res.json({ ok: false, message: 'No such family.' });
        // Full is full. Letting the count go over would make the free-seat number — the thing this screen is for — a lie.
        const held = (await query('SELECT COUNT(*) AS c FROM yt_seats WHERE family_id = ? AND left_on IS NULL AND sub_id <> ?', [familyId, subId]))[0];
        if (Number(held && held.c) >= Math.max(1, n(fam.slots, 5))) return res.json({ ok: false, message: s(fam.login) + ' is full (' + fam.slots + ' places). Take somebody out first.' });
      }
      const out = await place(req, subId, familyId, s(b.email) || s(sub.email), b.note);
      audit.record(req, {
        action: familyId ? 'yt.seat.place' : 'yt.seat.release', entity: 'subscription', id: subId,
        summary: familyId ? '▶️ ' + (s(sub.name) || subId) + ' placed in ' + s(fam.login) : '▶️ ' + (s(sub.name) || subId) + ' taken out of the YouTube family',
        details: { subId, familyId: familyId || null, released: out.released },
      });
      res.json(await overview(query));
    } catch (e) { fail(res, e); }
  });

  /**
   * The spreadsheet, pasted in. Lines look like whatever the owner's sheet looks like, so the only things read
   * are: a line that is just a family address starts a new family, and any address after it is a member.
   * Matching is by email against YouTube subscriptions — never by name, which is not unique and not reliable.
   */
  app.post('/admin/api/yt/import', async (req, res) => {
    if (!auth(req, res)) return;
    const text = s((req.body || {}).text);
    const dryRun = (req.body || {}).apply !== true;
    if (!text) return res.json({ ok: false, message: 'Paste the sheet first.' });
    try {
      const fams = await query('SELECT id, login, slots FROM yt_families', []);
      const byLogin = new Map(fams.map((f) => [low(f.login), f]));
      const subs = await query(SUBS_SQL, [YT_LIKE]);
      // One address can appear on an old row and a renewed row; the newest expiry is the live one.
      const byEmail = new Map();
      for (const x of subs) { const k = low(x.email); if (k) byEmail.set(k, x); }

      const plan = []; const unknown = []; let current = null;
      for (const raw of text.split(/\r?\n/)) {
        const line = s(raw);
        if (!line) continue;
        const mails = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
        if (!mails.length) continue;
        const only = mails.length === 1 && low(line) === low(mails[0]);
        if (only && byLogin.has(low(mails[0]))) { current = byLogin.get(low(mails[0])); continue; }
        for (const m of mails) {
          if (byLogin.has(low(m))) { current = byLogin.get(low(m)); continue; }
          const sub = byEmail.get(low(m));
          if (!sub) { unknown.push(m); continue; }
          if (!current) { unknown.push(m); continue; }
          plan.push({ subId: s(sub.sub_id), name: s(sub.name) || 'Unknown', email: low(m), familyId: Number(current.id), familyLogin: s(current.login) });
        }
      }
      // Never place more people than a family holds — the import must not create the very lie the screen exists to stop.
      const room = new Map();
      for (const f of fams) {
        const held = (await query('SELECT COUNT(*) AS c FROM yt_seats WHERE family_id = ? AND left_on IS NULL', [f.id]))[0];
        room.set(Number(f.id), Math.max(0, n(f.slots, 5) - Number((held && held.c) || 0)));
      }
      const doing = []; const skipped = [];
      const seenSub = new Set();
      for (const p of plan) {
        if (seenSub.has(p.subId)) { skipped.push(Object.assign({ why: 'listed twice' }, p)); continue; }
        const already = (await query('SELECT family_id FROM yt_seats WHERE sub_id = ? AND left_on IS NULL LIMIT 1', [p.subId]))[0];
        if (already && Number(already.family_id) === p.familyId) { skipped.push(Object.assign({ why: 'already there' }, p)); seenSub.add(p.subId); continue; }
        const left = room.get(p.familyId);
        if (!already && left <= 0) { skipped.push(Object.assign({ why: 'family full' }, p)); continue; }
        if (!already) room.set(p.familyId, left - 1);
        doing.push(p); seenSub.add(p.subId);
      }
      if (dryRun) return res.json({ ok: true, preview: true, place: doing, skipped, unknown: [...new Set(unknown)] });
      for (const p of doing) await place(req, p.subId, p.familyId, p.email, 'from the sheet');
      audit.record(req, { action: 'yt.import', entity: 'yt_family', id: 'import', summary: '▶️ placed ' + doing.length + ' YouTube customer(s) from the pasted sheet', details: { placed: doing.length, skipped: skipped.length, unknown: [...new Set(unknown)].length } });
      const view = await overview(query);
      res.json(Object.assign({ placed: doing.length, skipped, unknown: [...new Set(unknown)] }, view));
    } catch (e) { fail(res, e); }
  });
}

/**
 * How many people are paying for YouTube right now and are in no family. This is the Today "to do": a new buyer
 * has to be INVITED at Google by hand, and before this screen existed there was nothing anywhere to remind
 * anybody (owner, 26 Sep 2026: "when someone buys YT - it should add as a pending task").
 * Returns null — and the card is left out — if the YouTube tables are not there yet.
 */
async function pendingCount(query) {
  try {
    const r = await query(
      'SELECT COUNT(*) AS n FROM subscriptions s WHERE LOWER(s.service) LIKE ? AND UPPER(s.status) = ? ' +
      'AND s.expiry_date > NOW() AND COALESCE(s.removed, 0) = 0 ' +
      'AND NOT EXISTS (SELECT 1 FROM yt_seats t WHERE t.sub_id = s.sub_id AND t.left_on IS NULL)', [YT_LIKE, 'ACTIVE']);
    return Number((r && r[0] && r[0].n) || 0);
  } catch (_) { return null; }
}

module.exports = { mount, pendingCount, _internal: { overview, stateOf, daysLeft, localPart, domainHint, prettyDate, placeable, IS_YT } };
