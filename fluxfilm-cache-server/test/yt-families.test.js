/* ▶️ YouTube families (owner, 26 Sep 2026: "we have diff yt family accounts and ind customer emails invited to
   them - so need to be able to see in which family which customer name and their email even if just first
   characters and their expiry - so we can remove them and also know how much space we have").
   Real ytfamilies.js on a fake MySQL — nothing reaches Google, nothing reaches a customer. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// Dates the database would hold, in India time, relative to now — so the suite cannot pass or fail by the date.
const at = (days) => new Date(Date.now() + days * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

let FAMS = [];
let SEATS = [];
let SUBS = [];
let AUDIT = [];
const EVER = [];   // every line the whole run logged: reset() clears AUDIT, and the log check comes after a reset
let famSeq = 0, seatSeq = 0;
let tablesExist = true;
let guestCols = true;   // schema-v30: the person column and a nullable sub_id
const noTable = () => { const e = new Error("Table 'u339830006_fluxfilm.yt_families' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };

const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    if (/yt_families|yt_seats/.test(q) && !tablesExist) noTable();

    if (/^SELECT id, login, label, slots, is_active, notes FROM yt_families/.test(q)) return FAMS.map((f) => Object.assign({}, f));
    if (/^SELECT id, login, slots FROM yt_families WHERE id = \?/.test(q)) { const f = FAMS.find((x) => x.id === Number(p[0])); return f ? [Object.assign({}, f)] : []; }
    if (/^SELECT id, login, slots FROM yt_families$/.test(q)) return FAMS.map((f) => Object.assign({}, f));
    if (/^SELECT id FROM yt_families WHERE login = \?/.test(q)) { const f = FAMS.find((x) => x.login === p[0]); return f ? [{ id: f.id }] : []; }
    if (/^SELECT login FROM yt_families WHERE id = \?/.test(q)) { const f = FAMS.find((x) => x.id === Number(p[0])); return f ? [{ login: f.login }] : []; }
    if (/^INSERT INTO yt_families/.test(q)) { FAMS.push({ id: ++famSeq, login: p[0], label: p[1], slots: p[2], is_active: p[3], notes: p[4] }); return { insertId: famSeq }; }
    if (/^UPDATE yt_families SET/.test(q)) { const f = FAMS.find((x) => x.id === Number(p[5])); if (f) Object.assign(f, { login: p[0], label: p[1], slots: p[2], is_active: p[3], notes: p[4] }); return { affectedRows: f ? 1 : 0 }; }
    if (/^DELETE FROM yt_families WHERE id = \?/.test(q)) { FAMS = FAMS.filter((x) => x.id !== Number(p[0])); return { affectedRows: 1 }; }

    if (/^SELECT id, family_id, sub_id, person, invited_email, joined_on, left_on, note FROM yt_seats WHERE left_on IS NULL/.test(q)) {
      if (!guestCols) { const e = new Error("Unknown column 'person' in 'field list'"); throw e; }
      return SEATS.filter((x) => !x.left_on).map((x) => Object.assign({}, x));
    }
    if (/^SELECT id, family_id, sub_id, invited_email, joined_on, left_on, note FROM yt_seats WHERE left_on IS NULL/.test(q)) return SEATS.filter((x) => !x.left_on).map((x) => Object.assign({}, x));
    if (/^SELECT COUNT\(\*\) AS c FROM yt_seats WHERE family_id = \? AND left_on IS NULL AND id <> \?/.test(q)) return [{ c: SEATS.filter((x) => !x.left_on && x.family_id === Number(p[0]) && x.id !== Number(p[1])).length }];
    if (/^SELECT id, family_id, person FROM yt_seats WHERE id = \? AND left_on IS NULL/.test(q)) { const x = SEATS.find((y) => y.id === Number(p[0]) && !y.left_on); return x ? [{ id: x.id, family_id: x.family_id, person: x.person || '' }] : []; }
    if (/^UPDATE yt_seats SET left_on = NOW\(\) WHERE id = \?$/.test(q)) { const x = SEATS.find((y) => y.id === Number(p[0])); if (x) x.left_on = at(0); return { affectedRows: 1 }; }
    if (/^UPDATE yt_seats SET invited_email = \?, note = \?(, person = \?)? WHERE id = \?/.test(q)) {
      const x = SEATS.find((y) => y.id === Number(p[p.length - 1]));
      if (x) { x.invited_email = p[0]; x.note = p[1]; if (p.length === 4) x.person = p[2]; }
      return { affectedRows: x ? 1 : 0 };
    }
    if (/^INSERT INTO yt_seats \(family_id, sub_id, person, invited_email, note\) VALUES \(\?, NULL, \?, \?, \?\)/.test(q)) {
      if (!guestCols) throw new Error("Unknown column 'person' in 'field list'");
      SEATS.push({ id: ++seatSeq, family_id: Number(p[0]), sub_id: '', person: p[1], invited_email: p[2], note: p[3], joined_on: at(0), left_on: null });
      return { insertId: seatSeq };
    }
    // Live MariaDB will not compare yt_seats.sub_id (utf8mb4_unicode_ci, schema-v29) with the older tables'
    // columns, so the first Today count threw on every request and the card silently never appeared. The fake
    // refuses it too, so no future query can quietly bring the same shape back.
    if (/yt_seats[\s\S]{0,80}?\.sub_id = s\.sub_id|s\.sub_id = t\.sub_id/.test(q)) {
      throw new Error("Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='");
    }
    if (/^SELECT COUNT\(\*\) AS c FROM yt_seats WHERE family_id = \? AND left_on IS NULL AND sub_id <> \?/.test(q)) return [{ c: SEATS.filter((x) => !x.left_on && x.family_id === Number(p[0]) && x.sub_id !== p[1]).length }];
    if (/^SELECT COUNT\(\*\) AS c FROM yt_seats WHERE family_id = \? AND left_on IS NULL/.test(q)) return [{ c: SEATS.filter((x) => !x.left_on && x.family_id === Number(p[0])).length }];
    if (/^SELECT id, family_id FROM yt_seats WHERE sub_id = \? AND left_on IS NULL/.test(q)) return SEATS.filter((x) => !x.left_on && x.sub_id === p[0]).map((x) => ({ id: x.id, family_id: x.family_id }));
    if (/^SELECT family_id FROM yt_seats WHERE sub_id = \? AND left_on IS NULL LIMIT 1/.test(q)) { const x = SEATS.find((y) => !y.left_on && y.sub_id === p[0]); return x ? [{ family_id: x.family_id }] : []; }
    if (/^UPDATE yt_seats SET left_on = NOW\(\) WHERE id = \?/.test(q)) { const x = SEATS.find((y) => y.id === Number(p[0])); if (x) x.left_on = at(0); return { affectedRows: 1 }; }
    if (/^INSERT INTO yt_seats/.test(q)) { SEATS.push({ id: ++seatSeq, family_id: Number(p[0]), sub_id: p[1], invited_email: p[2], note: p[3], joined_on: at(0), left_on: null }); return { insertId: seatSeq }; }

    if (/FROM subscriptions s LEFT JOIN customers c .* WHERE LOWER\(s.service\) LIKE \?/.test(q)) return SUBS.filter((x) => /youtube/i.test(x.service)).map((x) => Object.assign({}, x));
    if (/^SELECT s.sub_id, s.service, s.email, c.name FROM subscriptions s LEFT JOIN customers c .* WHERE s.sub_id = \?/.test(q)) { const x = SUBS.find((y) => y.sub_id === p[0]); return x ? [{ sub_id: x.sub_id, service: x.service, email: x.email, name: x.name }] : []; }
    if (/^INSERT INTO audit_log/.test(q)) { const line = { action: p[0], entity: p[1], id: p[2], summary: p[3], details: p[4] }; AUDIT.push(line); EVER.push(line); return { affectedRows: 1 }; }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 130));
  },
  getPool: () => null,
};

const SEED_SUBS = () => [
  // the four the owner's sheet showed in harshgwalia1234567, plus one expired and one nobody has placed
  { sub_id: 'Y1', phone_norm: '9619941412', name: 'Brian Coutinho', email: 'rbk.andheri89@gmail.com', service: 'YouTube Premium', plan: '3 Months', expiry_date: at(120), status: 'ACTIVE', removed: 0 },
  { sub_id: 'Y2', phone_norm: '9000000002', name: 'Prince Rajput', email: 'prajpoot593@gmail.com', service: 'YouTube Premium', plan: '1 Month', expiry_date: at(4), status: 'ACTIVE', removed: 0 },
  { sub_id: 'Y3', phone_norm: '8360156254', name: 'Shiv Nayyar', email: 'shivnayyar80@gmail.com', service: 'YouTube Premium', plan: '3 Months', expiry_date: at(60), status: 'ACTIVE', removed: 0 },
  { sub_id: 'Y4', phone_norm: '9000000004', name: 'Devesh Singh', email: 'mamtasingh@gmail.com', service: 'YouTube Premium', plan: '1 Month', expiry_date: at(-23), status: 'ACTIVE', removed: 0 },
  { sub_id: 'Y5', phone_norm: '9000000005', name: 'Ashu Chugh', email: 'ashuchugh64@gmail.com', service: 'YouTube Premium', plan: '3 Months', expiry_date: at(54), status: 'ACTIVE', removed: 0 },
  { sub_id: 'Y6', phone_norm: '9000000006', name: 'Refunded Ravi', email: 'ravi@gmail.com', service: 'YouTube Premium', plan: '1 Month', expiry_date: at(-9), status: 'REFUNDED', removed: 1 },
  // a Netflix customer, to prove a seat can never be given to one
  { sub_id: 'N1', phone_norm: '9000000007', name: 'Netflix Nikhil', email: 'nikhil@gmail.com', service: 'Netflix', plan: 'Private 1M', expiry_date: at(30), status: 'ACTIVE', removed: 0 },
];

const reset = () => { FAMS = []; SEATS = []; AUDIT = []; famSeq = 0; seatSeq = 0; tablesExist = true; guestCols = true; SUBS = SEED_SUBS(); };

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const yt = require('../ytfamilies');
  Module._load = origLoad;

  const app = express(); app.use(express.json());
  const audit = require('../audit').makeAudit({ query: mockDb.query });
  yt.mount(app, { db: mockDb, auth: () => true, audit });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'Content-Type': 'application/json' };
  const get = async (p) => (await fetch(base + p, { headers: H })).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
  const fam = (r, login) => (r.families || []).find((f) => f.login === login);
  const who = (f, name) => (f.people || []).find((p) => p.name === name);

  // ── the screen with nothing set up yet ────────────────────────────────────────────────────────────────────
  section('before anything is set up');
  tablesExist = false;
  let r = await get('/admin/api/yt');
  ok('schema-v29 not run → it SAYS so rather than showing an empty screen that looks like "no families"', r.ok === true && r.needsSchema === true, r);
  tablesExist = true;

  r = await get('/admin/api/yt');
  ok('no families yet, but the paying customers are already listed as unplaced', r.ok && !r.families.length && r.unplaced.length === 5, r.totals);
  ok('a refunded and let-go plan is not asked about — it is history, not somebody waiting for a place', !r.unplaced.some((p) => p.subId === 'Y6'), r.unplaced.map((p) => p.subId));
  ok('a Netflix customer is never in this screen at all', !r.unplaced.some((p) => p.subId === 'N1'), r.unplaced.map((p) => p.subId));

  // ── families ──────────────────────────────────────────────────────────────────────────────────────────────
  section('the families, and how much room is in them');
  r = await post('/admin/api/yt/family', { login: 'Harshgwalia1234567@Gmail.com', slots: 5 });
  ok('adding a family works, and the address is stored lower-case so it matches later', r.ok && r.families.length === 1 && r.families[0].login === 'harshgwalia1234567@gmail.com', r.families);
  ok('an empty family is 5 free places, and the total says so', r.totals.slots === 5 && r.totals.used === 0 && r.totals.free === 5, r.totals);
  ok('the screen shows the part of the address the owner recognises', r.families[0].loginShort === 'harshgwalia1234567', r.families[0]);

  r = await post('/admin/api/yt/family', { login: 'harshgwalia1234567@gmail.com' });
  ok('the same family cannot be added twice', r.ok === false && /already/i.test(r.message), r);

  r = await post('/admin/api/yt/family', { login: 'not-an-address' });
  ok('…and something that is not an address is refused', r.ok === false, r);

  await post('/admin/api/yt/family', { login: 'harshwalia157@gmail.com', slots: 2, label: 'second one' });
  r = await get('/admin/api/yt');
  ok('two families → 7 places between them', r.totals.families === 2 && r.totals.slots === 7 && r.totals.free === 7, r.totals);

  const F1 = fam(r, 'harshgwalia1234567@gmail.com').id;
  const F2 = fam(r, 'harshwalia157@gmail.com').id;

  // ── placing people ────────────────────────────────────────────────────────────────────────────────────────
  section('who is in which family');
  r = await post('/admin/api/yt/seat', { subId: 'Y1', familyId: F1 });
  ok('placing somebody fills a place and the free count drops', r.ok !== false && fam(r, 'harshgwalia1234567@gmail.com').used === 1 && r.totals.free === 6, r.totals);
  const p1 = who(fam(r, 'harshgwalia1234567@gmail.com'), 'Brian Coutinho');
  ok('the row carries the name, the first part of the email, and the expiry — the three the sheet had', p1 && p1.emailShort === 'rbk.andheri89' && p1.expiryLabel && p1.state === 'ACTIVE', p1);
  ok('🔐 the full address is never given out as the visible text; the domain is only hinted', p1.emailHint === 'g…mail.com' || /…/.test(p1.emailHint), p1);

  r = await post('/admin/api/yt/seat', { subId: 'N1', familyId: F1 });
  ok('a Netflix subscription can never be given a YouTube place', r.ok === false && /not YouTube/i.test(r.message), r);
  r = await post('/admin/api/yt/seat', { subId: 'NOPE', familyId: F1 });
  ok('…and neither can a subscription that does not exist', r.ok === false, r);

  await post('/admin/api/yt/seat', { subId: 'Y2', familyId: F2 });
  r = await post('/admin/api/yt/seat', { subId: 'Y3', familyId: F2 });
  ok('the second family fills up', fam(r, 'harshwalia157@gmail.com').used === 2 && fam(r, 'harshwalia157@gmail.com').free === 0, r.totals);
  r = await post('/admin/api/yt/seat', { subId: 'Y5', familyId: F2 });
  ok('🚫 a full family is refused — otherwise the free-place count, which is the point of the screen, becomes a lie', r.ok === false && /full/i.test(r.message), r);

  // ── moving and freeing ────────────────────────────────────────────────────────────────────────────────────
  section('moving somebody, and freeing a place');
  r = await post('/admin/api/yt/seat', { subId: 'Y3', familyId: F1 });
  ok('moving takes the old place back as it gives the new one — never both at once', fam(r, 'harshgwalia1234567@gmail.com').used === 2 && fam(r, 'harshwalia157@gmail.com').used === 1, r.totals);
  ok('…and the totals still add up', r.totals.used === 3 && r.totals.free === 4, r.totals);
  ok('nobody is ever in two families', SEATS.filter((x) => !x.left_on && x.sub_id === 'Y3').length === 1, SEATS);

  r = await post('/admin/api/yt/seat', { subId: 'Y3', familyId: 0 });
  ok('freeing a place gives it back and puts them on the unplaced list again', fam(r, 'harshgwalia1234567@gmail.com').used === 1 && r.unplaced.some((p) => p.subId === 'Y3'), r.totals);
  ok('the row is KEPT with a left_on, so the tracker still knows they used to be there', SEATS.some((x) => x.sub_id === 'Y3' && x.left_on), SEATS);

  // ── the number the owner opens the screen for ─────────────────────────────────────────────────────────────
  section('expired, still taking up a place');
  await post('/admin/api/yt/seat', { subId: 'Y4', familyId: F1 });
  r = await get('/admin/api/yt');
  const expired = who(fam(r, 'harshgwalia1234567@gmail.com'), 'Devesh Singh');
  ok('an expired customer is NOT hidden — they are still sitting in the family, which is the thing to act on', expired && expired.state === 'EXPIRED', expired);
  ok('…and the top of the screen counts them', r.totals.expiredInFamily === 1, r.totals);
  const soon = who(fam(r, 'harshwalia157@gmail.com'), 'Prince Rajput');
  ok('somebody ending this week is marked before they expire, not after', soon && soon.state === 'ENDING' && soon.days > 0 && soon.days <= 7, soon);

  r = await post('/admin/api/yt/family', { id: F1, action: 'delete' });
  ok('🚫 a family with people in it cannot be deleted — that would lose the only record of where they are', r.ok === false && /take the/i.test(r.message), r);

  r = await post('/admin/api/yt/family', { id: F1, login: 'harshgwalia1234567@gmail.com', slots: 6 });
  ok('the number of places can be corrected', fam(r, 'harshgwalia1234567@gmail.com').slots === 6 && r.totals.slots === 8, r.totals);

  r = await post('/admin/api/yt/family', { id: F2, login: 'harshwalia157@gmail.com', slots: 2, isActive: false });
  ok('a family switched off stops counting towards free places', r.totals.slots === 6 && r.totals.free === 4, r.totals);
  await post('/admin/api/yt/family', { id: F2, login: 'harshwalia157@gmail.com', slots: 2, isActive: true });

  // ── the paste ─────────────────────────────────────────────────────────────────────────────────────────────
  section('pasting the old spreadsheet');
  reset();
  await post('/admin/api/yt/family', { login: 'harshgwalia1234567@gmail.com', slots: 5 });
  await post('/admin/api/yt/family', { login: 'harshwalia157@gmail.com', slots: 1 });
  const SHEET = [
    'harshgwalia1234567@gmail.com',
    'Brian Coutinho\trbk.andheri89@gmail.com\t13/01/2027\tACTIVE',
    'Prince Rajput\tprajpoot593@gmail.com\t30/09/2026\tACTIVE',
    'Somebody Else\tnot-a-customer@gmail.com\t01/01/2027\tACTIVE',
    'harshwalia157@gmail.com',
    'Shiv Nayyar\tshivnayyar80@gmail.com\t27/11/2026\tACTIVE',
    'Ashu Chugh\tashuchugh64@gmail.com\t19/11/2026\tACTIVE',
  ].join('\n');
  r = await post('/admin/api/yt/import', { text: SHEET });
  ok('preview first: nothing is written until it is asked for', r.ok && r.preview === true && !SEATS.length, { place: r.place.length, seats: SEATS.length });
  ok('it matches by EMAIL and places people under the family line above them', r.place.length === 3 && r.place[0].familyLogin === 'harshgwalia1234567@gmail.com' && r.place[2].familyLogin === 'harshwalia157@gmail.com', r.place);
  ok('an address we have no YouTube plan for is reported, never guessed at', r.unknown.length === 1 && r.unknown[0] === 'not-a-customer@gmail.com', r.unknown);
  ok('…and the one that does not fit the family is skipped, with the reason', r.skipped.length === 1 && /full/.test(r.skipped[0].why), r.skipped);

  r = await post('/admin/api/yt/import', { text: SHEET, apply: true });
  ok('applying it places everybody in one go', r.placed === 3 && r.totals.used === 3, r.totals);
  ok('…and running the same paste twice changes nothing', (await post('/admin/api/yt/import', { text: SHEET, apply: true })).placed === 0 && SEATS.filter((x) => !x.left_on).length === 3, SEATS.filter((x) => !x.left_on).length);

  // ── somebody with no subscription at all ─────────────────────────────────────────────────────────────────
  section('🎁 a place for somebody with no plan');
  reset();
  await post('/admin/api/yt/family', { login: 'flixfilm157@gmail.com', slots: 2 });
  let V = await get('/admin/api/yt');
  const FV = V.families[0].id;

  r = await post('/admin/api/yt/seat', { action: 'guest', familyId: FV, person: 'Vishal R Vipin', email: 'vishalrvipin2@gmail.com', note: 'old customer, free' });
  const v = (r.families || [])[0];
  const vg = v && v.people[0];
  ok('an old customer we give it to for nothing can hold a place', vg && vg.name === 'Vishal R Vipin' && vg.state === 'GUEST' && v.used === 1 && v.free === 1, v);
  ok('…they have no expiry to show, and never will', vg.expiryLabel === '' && vg.days === null && /free/i.test(vg.plan), vg);
  ok('…and the free count counts them, which is the whole reason this exists', r.totals.used === 1 && r.totals.free === 1, r.totals);
  ok('…they are not mistaken for a customer anywhere', !(r.unplaced || []).some((p) => p.name === 'Vishal R Vipin') && vg.subId === '', vg);

  r = await post('/admin/api/yt/seat', { action: 'guest', familyId: FV, person: '' });
  ok('a place with nobody named on it is refused', r.ok === false && /name/i.test(r.message), r);

  await post('/admin/api/yt/seat', { subId: 'Y1', familyId: FV });
  r = await post('/admin/api/yt/seat', { action: 'guest', familyId: FV, person: 'One Too Many' });
  ok('🚫 a guest cannot overfill a family either', r.ok === false && /full/i.test(r.message), r);

  // freeing it: there is no subscription to name it by, so it goes by the place itself
  V = await get('/admin/api/yt');
  const seatId = V.families[0].people.find((p) => p.state === 'GUEST').seatId;
  r = await post('/admin/api/yt/seat', { seatId: seatId });
  ok('the place can be freed by the place, with no subscription involved', r.totals.used === 1 && !(r.families[0].people || []).some((p) => p.state === 'GUEST'), r.totals);
  r = await post('/admin/api/yt/seat', { seatId: seatId });
  ok('…and freeing it twice says so instead of losing count', r.ok === false && /already free/i.test(r.message), r);

  section('✏️ the address we actually invited');
  reset();
  await post('/admin/api/yt/family', { login: 'harshwalia8888@gmail.com', slots: 5 });
  V = await get('/admin/api/yt');
  await post('/admin/api/yt/seat', { subId: 'Y1', familyId: V.families[0].id });
  V = await get('/admin/api/yt');
  const sId = V.families[0].people[0].seatId;
  ok('it starts as the address on the order', V.families[0].people[0].email === 'rbk.andheri89@gmail.com', V.families[0].people[0]);
  r = await post('/admin/api/yt/seat', { action: 'edit', seatId: sId, email: 'manmeet5mkkaur', note: 'invited on a different Google address' });
  const edited = r.families[0].people[0];
  ok('…and can be corrected to the Google address actually invited, which is what you search for at Google', edited.email === 'manmeet5mkkaur' && edited.note === 'invited on a different Google address', edited);
  ok('…without touching the subscription it belongs to', edited.name === 'Brian Coutinho' && edited.expiryLabel !== '', edited);

  section('⚠️ before schema-v30 is run');
  reset();
  guestCols = false;
  await post('/admin/api/yt/family', { login: 'harshwalia8888@gmail.com', slots: 5 });
  V = await get('/admin/api/yt');
  ok('the screen still works with the old columns, and says guests are not on yet', V.ok === true && V.guestsOff === true && V.families.length === 1, V);
  r = await post('/admin/api/yt/seat', { action: 'guest', familyId: V.families[0].id, person: 'Vishal R Vipin' });
  ok('…and asking for one says which file to run, rather than failing with SQL', r.ok === false && r.needsSchema === true && /schema-v30/.test(r.message), r);
  guestCols = true;

  // ── the Today card ───────────────────────────────────────────────────────────────────────────────────────
  section('▶️ a new YouTube buyer becomes a to-do');
  reset();
  let n0 = await yt.pendingCount(mockDb.query);
  // 4, not 5: the to-do is "somebody bought and nobody has invited them", so an EXPIRED customer still sitting
  // in a family is not one of them — that is the 🚪 count on the screen, a different job.
  ok('everybody PAYING and in no family is a to-do (an expired one is not)', n0 === 4, n0);
  // The number and the screen are counted from one place, so they cannot drift apart — and the count keeps
  // working on a database that refuses to compare the two tables in SQL.
  {
    const onScreen = ((await get('/admin/api/yt')).unplaced || []).filter((p) => p.state === 'ACTIVE' || p.state === 'ENDING').length;
    ok('…and it is exactly what the screen lists, never a second opinion', n0 === onScreen, { n0, onScreen });
  }
  await post('/admin/api/yt/family', { login: 'flixfilm157@gmail.com', slots: 5 });
  V = await get('/admin/api/yt');
  await post('/admin/api/yt/seat', { subId: 'Y1', familyId: V.families[0].id });
  ok('…placing one takes it off the list', (await yt.pendingCount(mockDb.query)) === 3, await yt.pendingCount(mockDb.query));
  tablesExist = false;
  ok('…and with no YouTube tables at all it returns null, so the Today card is simply left out', (await yt.pendingCount(mockDb.query)) === null);
  tablesExist = true;

  // ── the change log ────────────────────────────────────────────────────────────────────────────────────────
  section('🕘 every change is written down');
  const acts = EVER.map((a) => a.action);
  ok('adding a family, placing, freeing and importing all log a line', acts.includes('yt.family.add') && acts.includes('yt.seat.place') && acts.includes('yt.seat.release') && acts.includes('yt.import'), acts);
  ok('the lines read like sentences, not ids', EVER.some((a) => /placed in harshgwalia1234567@gmail.com/.test(a.summary)), EVER.map((a) => a.summary).slice(0, 6));

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok('the module is mounted by admin.js', /require\('\.\/ytfamilies'\)\.mount\(/.test(read('admin.js')));
  ok('the screen is in the menu and the router', /\['ytfamily', '▶️', 'YouTube families'\]/.test(read('admin.html')) && /ytfamily: ytFamilyView/.test(read('admin.html')));
  ok('schema-v29 makes both tables', /CREATE TABLE IF NOT EXISTS yt_families/.test(read('db/schema-v29.sql')) && /CREATE TABLE IF NOT EXISTS yt_seats/.test(read('db/schema-v29.sql')));
  ok('schema-v30 lets a place be held by somebody with no plan', /MODIFY COLUMN sub_id VARCHAR\(64\) NULL/.test(read('db/schema-v30.sql')) && /ADD COLUMN person/.test(read('db/schema-v30.sql')));
  ok('the Today screen asks for the count and leaves the card out when there is none', /ytFamilies \|\| require\('\.\/ytfamilies'\)\)\.pendingCount/.test(read('adminhome.js')) && /ytToPlace == null \? \[\] :/.test(read('adminhome.js')));
  ok('the ▶️ screen offers both a customer and somebody with no plan', /data-ytguest=/.test(read('admin.html')) && /data-ytseat=/.test(read('admin.html')));
  // The whole reason for two new tables instead of inventory_accounts: allocation, stock and 🚪 Remove users read
  // those, and a Google family is not an account we hand over. If this ever changes it must be on purpose.
  ok('🔒 it never touches the inventory tables, and never writes to a subscription', !/(FROM|INTO|UPDATE|JOIN)\s+inventory_/i.test(read('ytfamilies.js')) && !/UPDATE subscriptions|INSERT INTO subscriptions|DELETE FROM subscriptions/.test(read('ytfamilies.js')));
  ok('🔒 and it never emails or invites anybody — the screen records, the owner acts', !/mailer|sendMail|transport/i.test(read('ytfamilies.js')));

  server.close();
  console.log('\n---------------------------------------');
  console.log('yt-families: PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
