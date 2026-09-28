/* 👥 The WhatsApp group (owner, 28 Sep 2026: "and there is no way we can get a list of our group or community
   members in whatsapp is there" → 29 Sep: "build both"). Two halves: the "I have joined" tap is written down
   instead of being thrown away with the page, and a pasted member list is reconciled against who is paying.
   Real groupmembers.js on a fake MySQL — nothing reaches WhatsApp, nothing reaches a customer. Run: npm test */
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
const dmy = (days) => { const d = new Date(Date.now() + days * 86400e3 + 5.5 * 3600e3); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear(); };

let ROWS = [];
let SUBS = [];
let PLANS = [];
let AUDIT = [];
let seq = 0;
let tableExists = true;
let hasSeenBy = true;      // schema-v32. Flipped off below to prove the screen still works without it.
let REMINDED = [];         // reminder_log rows the nudge writes
let MAILED = [];           // what the mailer was asked to send — nothing ever leaves this array
const sqlNowStr = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const fakeMailer = { send: async (to, subject, html) => { MAILED.push({ to, subject, html }); return { ok: true, sender: 'support@fluxfilm.in' }; } };
let SETTINGS = {};
const noTable = () => { const e = new Error("Table 'u339830006_fluxfilm.wa_group_members' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };

const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    // The trap that emptied the ▶️ Today count on 27 Sep 2026: this database has tables in two collations and
    // MariaDB refuses to compare across them. The fake refuses it too, so no future query can bring it back.
    if (/wa_group_members[\s\S]{0,120}(JOIN|,)\s*(customers|subscriptions)\b|\.phone_norm\s*=\s*\w+\.phone_norm/i.test(q)) {
      throw new Error("Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='");
    }
    if (/wa_group_members/.test(q) && !tableExists) noTable();

    if (/^SELECT id, phone_norm, name, claimed_at, claimed_via, claimed_for, seen_at, seen_by, missing_at, note FROM wa_group_members$/.test(q)) {
      if (!hasSeenBy) throw new Error("Unknown column 'seen_by' in 'field list'");
      return ROWS.map((r) => Object.assign({}, r));
    }
    if (/^SELECT seen_by FROM wa_group_members LIMIT 1$/.test(q)) {
      if (!hasSeenBy) throw new Error("Unknown column 'seen_by' in 'field list'");
      return ROWS.slice(0, 1).map((r) => ({ seen_by: r.seen_by || '' }));
    }
    if (/^SELECT id, phone_norm, name, claimed_at, claimed_via, claimed_for, seen_at, missing_at, note FROM wa_group_members$/.test(q)) return ROWS.map((r) => Object.assign({}, r));
    if (/^UPDATE wa_group_members SET seen_at = \?, seen_by = \?, missing_at = NULL WHERE id = \?$/.test(q)) {
      if (!hasSeenBy) throw new Error("Unknown column 'seen_by' in 'field list'");
      const r = ROWS.find((x) => x.id === Number(p[2])); if (r) { r.seen_at = p[0]; r.seen_by = p[1]; r.missing_at = null; } return { affectedRows: r ? 1 : 0 };
    }
    if (/^INSERT INTO wa_group_members \(phone_norm, name, seen_at, seen_by\) VALUES \(\?, \?, \?, \?\)$/.test(q)) {
      if (!hasSeenBy) throw new Error("Unknown column 'seen_by' in 'field list'");
      ROWS.push({ id: ++seq, phone_norm: p[0], name: p[1], claimed_at: null, claimed_via: '', claimed_for: '', seen_at: p[2], seen_by: p[3], missing_at: null, note: '' }); return { insertId: seq };
    }
    if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(q)) return SETTINGS[p[0]] ? [{ value: SETTINGS[p[0]] }] : [];
    if (/^INSERT INTO app_settings \(setting_key, value\)/.test(q)) { SETTINGS[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^SELECT id, phone_norm, seen_at, missing_at FROM wa_group_members$/.test(q)) return ROWS.map((r) => ({ id: r.id, phone_norm: r.phone_norm, seen_at: r.seen_at, missing_at: r.missing_at }));
    if (/^UPDATE wa_group_members SET seen_at = \?, missing_at = NULL WHERE id = \?$/.test(q)) { const r = ROWS.find((x) => x.id === Number(p[1])); if (r) { r.seen_at = p[0]; r.missing_at = null; } return { affectedRows: r ? 1 : 0 }; }
    if (/^UPDATE wa_group_members SET missing_at = \? WHERE id = \?$/.test(q)) { const r = ROWS.find((x) => x.id === Number(p[1])); if (r) r.missing_at = p[0]; return { affectedRows: r ? 1 : 0 }; }
    if (/^INSERT INTO wa_group_members \(phone_norm, name, seen_at\) VALUES \(\?, \?, \?\)$/.test(q)) { ROWS.push({ id: ++seq, phone_norm: p[0], name: p[1], claimed_at: null, claimed_via: '', claimed_for: '', seen_at: p[2], missing_at: null, note: '' }); return { insertId: seq }; }
    if (/^INSERT INTO wa_group_members \(phone_norm, name, claimed_at, claimed_via, claimed_for\)/.test(q)) {
      const r = ROWS.find((x) => x.phone_norm === p[0]);
      if (r) { r.claimed_at = p[2]; r.claimed_via = p[3]; if (p[1]) r.name = p[1]; if (p[4]) r.claimed_for = p[4]; return { affectedRows: 2 }; }
      ROWS.push({ id: ++seq, phone_norm: p[0], name: p[1], claimed_at: p[2], claimed_via: p[3], claimed_for: p[4], seen_at: null, missing_at: null, note: '' });
      return { insertId: seq };
    }
    if (/^DELETE FROM wa_group_members WHERE id = \? LIMIT 1$/.test(q)) { ROWS = ROWS.filter((x) => x.id !== Number(p[0])); return { affectedRows: 1 }; }
    if (/^UPDATE wa_group_members SET note = \? WHERE id = \? LIMIT 1$/.test(q)) { const r = ROWS.find((x) => x.id === Number(p[1])); if (r) r.note = p[0]; return { affectedRows: r ? 1 : 0 }; }

    if (/^SELECT service, plan, raw_json FROM plans$/.test(q)) return PLANS.map((x) => Object.assign({}, x));
    // The real subscriptions table has NO name column — the customer's name is on customers. The first version of
    // this fake had one, because it was written from the code's own SQL rather than from the live table, so the
    // suite was green and every request on the live site answered 500. A fake that agrees with the code proves
    // nothing; this one refuses the column exactly as MariaDB does.
    if (/FROM subscriptions/.test(q) && /^SELECT[^]*?\bname\b[^]*?FROM subscriptions/.test(q)) throw new Error("Unknown column 'name' in 'SELECT'");
    if (/^SELECT sub_id, phone_norm, service, plan, expiry_date, status FROM subscriptions/.test(q)) {
      return SUBS.filter((x) => ['REFUNDED', 'CANCELLED'].indexOf(String(x.status).toUpperCase()) === -1)
        .map((x) => ({ sub_id: x.sub_id, phone_norm: x.phone_norm, service: x.service, plan: x.plan, expiry_date: x.expiry_date, status: x.status }));
    }
    if (/^SELECT phone_norm, name FROM customers$/.test(q)) return CUSTS.map((x) => Object.assign({}, x));
    if (/^SELECT email FROM customers WHERE phone_norm = \? LIMIT 1$/.test(q)) { const c = CUSTS.find((x) => x.phone_norm === p[0]); return c ? [{ email: c.email || '' }] : []; }
    if (/^SELECT ts FROM reminder_log WHERE sub_id = \? AND kind = 'GROUP_JOIN' ORDER BY ts DESC LIMIT 1$/.test(q)) {
      const r = REMINDED.filter((x) => x.sub_id === p[0]).sort((a, b) => b.ts.localeCompare(a.ts))[0];
      return r ? [{ ts: r.ts }] : [];
    }
    if (/^INSERT INTO reminder_log/.test(q)) { REMINDED.push({ ts: sqlNowStr(), sub_id: p[0], channel: p[1], kind: p[2], ok: p[5], note: p[6] }); return { affectedRows: 1 }; }
    if (/^INSERT INTO audit_log/.test(q)) { AUDIT.push({ action: p[0], entity: p[1], id: p[2], summary: p[3] }); return { affectedRows: 1 }; }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 140));
  },
  getPool: () => null,
};

const SEED_PLANS = () => [
  { service: 'Netflix (Group Offer)', plan: 'Sharing 1M', raw_json: JSON.stringify({ RequiresGroupJoin: 'TRUE', GroupJoinLink: 'https://chat.whatsapp.com/abc' }) },
  { service: 'Netflix', plan: 'Private 1M', raw_json: JSON.stringify({}) },
  { service: 'Prime Video', plan: '1 Month', raw_json: JSON.stringify({}) },
];
const SEED_SUBS = () => [
  // Group Offer customers: two paying now, one ending this week, one expired, one refunded (history, not a person to chase)
  { sub_id: 'G1', phone_norm: '9876543210', name: 'Siddhu', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(76), status: 'ACTIVE' },
  { sub_id: 'G2', phone_norm: '9123456789', name: 'Meera Joshi', service: 'Netflix (Group Offer)', plan: 'Sharing 3M', expiry_date: at(40), status: 'ACTIVE' },
  { sub_id: 'G3', phone_norm: '9988776655', name: 'Arun Pillai', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(3), status: 'ACTIVE' },
  { sub_id: 'G4', phone_norm: '9555000111', name: 'Old Omkar', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(-20), status: 'ACTIVE' },
  { sub_id: 'G5', phone_norm: '9444000222', name: 'Refunded Ravi', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(-2), status: 'REFUNDED' },
  // …and a customer on a normal plan, who has no business being on this screen at all
  { sub_id: 'P1', phone_norm: '9333000333', name: 'Private Priya', service: 'Netflix', plan: 'Private 1M', expiry_date: at(30), status: 'ACTIVE' },
];
// Names live here, not on the subscription — the same way round as the live database.
const SEED_CUSTS = () => [
  { phone_norm: '9876543210', name: 'Siddhu' },
  { phone_norm: '9123456789', name: 'Meera Joshi', email: 'meera.joshi@gmail.com' },
  { phone_norm: '9988776655', name: 'Arun Pillai', email: 'arun.pillai@gmail.com' },
  { phone_norm: '9555000111', name: 'Old Omkar' },
  { phone_norm: '9444000222', name: 'Refunded Ravi' },
  { phone_norm: '9333000333', name: 'Private Priya' },
];
let CUSTS = [];
const reset = () => { ROWS = []; AUDIT = []; SETTINGS = {}; REMINDED = []; MAILED = []; seq = 0; tableExists = true; hasSeenBy = true; SUBS = SEED_SUBS(); PLANS = SEED_PLANS(); CUSTS = SEED_CUSTS(); };

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const gm = require('../groupmembers');
  Module._load = origLoad;
  const I = gm._internal;

  const app = express(); app.use(express.json());
  const audit = require('../audit').makeAudit({ query: mockDb.query });
  gm.mount(app, { db: mockDb, auth: () => true, audit, mailer: fakeMailer });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'Content-Type': 'application/json' };
  const get = async (p) => (await fetch(base + p, { headers: H })).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
  const find = (r, list, name) => (r[list] || []).find((x) => x.name === name);

  // ── reading a pasted list ─────────────────────────────────────────────────────────────────────────────────
  section('reading what was pasted');
  // The sharpest edge in the whole file. Every line of an exported WhatsApp chat begins with a date and a time,
  // and "28/09/2026, 20:14" is nine digits with punctuation through it. A loose "find some digits" regex turns
  // that into a member and quietly invents people who are not in the group.
  ok('a date and a time are not a phone number', I.phonesIn('28/09/2026, 20:14 - Harsh: hello').length === 0, I.phonesIn('28/09/2026, 20:14 - Harsh: hello'));
  ok('…nor is an order id, a UTR or an amount', I.phonesIn('FF8259324 paid 4099 via UTR 528374619283 on 12.09.2026').length === 0, I.phonesIn('FF8259324 paid 4099 via UTR 528374619283 on 12.09.2026'));
  ok('a +91 number is read, and kept as the last 10 digits like everywhere else', I.phonesIn('+91 98765 43210 joined').join() === '9876543210', I.phonesIn('+91 98765 43210 joined'));
  ok('…as is a bare 10-digit one, and one written with hyphens', I.phonesIn('9123456789').join() === '9123456789' && I.phonesIn('98765-43210').join() === '9876543210');
  ok('a landline-shaped 10-digit number is not treated as a mobile', I.phonesIn('2261234567').length === 0, I.phonesIn('2261234567'));
  ok('two numbers on one line are both read', I.phonesIn('+919876543210 added +919123456789').length === 2, I.phonesIn('+919876543210 added +919123456789'));

  const EXPORT = [
    '01/06/2026, 10:02 - Messages are end-to-end encrypted.',
    '01/06/2026, 10:03 - +91 98765 43210 joined using this group\'s invite link',
    '02/06/2026, 11:15 - +91 91234 56789 joined using this group\'s invite link',
    '03/06/2026, 09:40 - +91 99887 76655 joined using this group\'s invite link',
    '04/06/2026, 18:20 - +91 95550 00111 joined using this group\'s invite link',
    '20/08/2026, 21:05 - +91 91234 56789 left',
    '28/09/2026, 20:14 - +91 90000 12345: bhai renew karna hai',
  ].join('\n');
  let pl = I.parseList(EXPORT);
  ok('an exported chat is recognised as one, not as a list of numbers', pl.mode === 'export' && pl.events === 5, { mode: pl.mode, events: pl.events });
  ok('…somebody who joined and then left is OUT', pl.phones.indexOf('9123456789') === -1, pl.phones);
  ok('…somebody who joined and stayed is IN', pl.phones.indexOf('9876543210') > -1 && pl.phones.indexOf('9988776655') > -1, pl.phones);
  ok('…and somebody who only ever talks in the group is in it too', pl.phones.indexOf('9000012345') > -1, pl.phones);

  pl = I.parseList('+91 98765 43210\n9123456789\n+91 99887 76655');
  ok('a plain list is taken at face value: everyone in it is a member', pl.mode === 'list' && pl.phones.length === 3, pl);

  // ── the screen before anything has been pasted ────────────────────────────────────────────────────────────
  section('before the group has ever been checked');
  tableExists = false;
  let r = await get('/admin/api/group');
  ok('schema-v31 not run → it SAYS so rather than showing an empty screen that looks like "nobody joined"', r.ok === true && r.needsSchema === true, r);
  tableExists = true;

  r = await get('/admin/api/group');
  ok('with no list ever pasted it admits it does not know yet', r.ok && r.everChecked === false, { everChecked: r.everChecked });
  // The first build put every group customer straight into "💸 paying, not in it" on a database that had never
  // been checked. That is not a finding, it is the absence of one, and a red number that is not a fact is worse
  // than a blank screen — it is the same mistake as a refusal that cannot say why.
  ok('…and nobody is accused of being missing on the strength of no evidence', r.totals.seen === 0 && (r.owe || []).length === 0 && (r.strangers || []).length === 0, r.totals);
  ok('a normal-plan customer is never on this screen', !find(r, 'owe', 'Private Priya'), (r.owe || []).map((x) => x.name));
  // A name we do not hold must give a worse row, never a broken screen. Going live it gave neither: it asked
  // subscriptions for a column that table has never had, and every request answered 500.
  CUSTS = [];
  const nameless = await get('/admin/api/group');
  ok('…and a customer whose name we do not hold still loads, just unnamed', nameless.ok === true, nameless.message);
  CUSTS = SEED_CUSTS();
  ok('a refunded group plan is not chased either — it is history', !find(r, 'owe', 'Refunded Ravi'), (r.owe || []).map((x) => x.name));

  // ── the tap that used to be thrown away ───────────────────────────────────────────────────────────────────
  section('"I have joined" is written down');
  await gm.claim('9876543210', 'Siddhu', 'shop', 'Netflix (Group Offer)', { query: mockDb.query });
  await gm.claim('+91 91234 56789', 'Meera Joshi', 'olivia', 'Netflix (Group Offer)', { query: mockDb.query });
  r = await get('/admin/api/group');
  ok('the claim survives the session it was made in — which is the whole point', r.totals.claimed === 2, r.totals);
  ok('…and remembers where it was made, so the chat and the checkout can be told apart', (r.members || []).some((m) => m.claimedVia === 'olivia') && (r.members || []).some((m) => m.claimedVia === 'shop'), (r.members || []).map((m) => m.claimedVia));
  ok('a number typed any which way lands on the same row', (r.members || []).some((m) => m.phone === '9123456789'), (r.members || []).map((m) => m.phone));
  const before = ROWS.length;
  await gm.claim('9876543210', '', 'shop', '', { query: mockDb.query });
  ok('claiming twice is one person, and the second one does not blank the name it had', ROWS.length === before && ROWS.find((x) => x.phone_norm === '9876543210').name === 'Siddhu', ROWS.map((x) => x.name));

  // A claim that cannot be saved must never be able to stop a sale.
  tableExists = false;
  let threw = false;
  try { await gm.claim('9000000001', 'Nobody', 'shop', 'x', { query: mockDb.query }); } catch (_) { threw = true; }
  ok('🔒 and when the table is not there yet it gives up quietly — an order must never fail over a bookkeeping row', !threw);
  tableExists = true;

  // ── pasting a list ────────────────────────────────────────────────────────────────────────────────────────
  section('pasting the group list');
  // ── a half-file must announce itself ─────────────────────────────────────────────────────────────────────
  // The owner exported a 490-member community, the paste stopped in May, and the screen said "Saved ✓ — 258 in
  // the group" with nothing to suggest anything was missing. Saving a half-file marks everybody it does not
  // mention as having left, so this is the one thing the check has to shout about.
  {
    const OLD = [
      dmy(-300) + ", 10:03 - +91 98765 43210 joined using this group's invite link",
      dmy(-260) + ", 11:15 - +91 91234 56789 joined using this group's invite link",
    ].join('\n');
    const half = await post('/admin/api/group/paste', { text: OLD });
    ok('an export whose last line is months old is called out as part of a file', half.ok && half.looksPartial === true && half.staleDays >= 259, { partial: half.looksPartial, stale: half.staleDays });
    ok('…and it says what the paste actually covered, which is how you see it at a glance', half.lastDate && half.firstDate && half.lines === 2, { first: half.firstDate, last: half.lastDate, lines: half.lines });
    const FRESH = [
      dmy(-300) + ", 10:03 - +91 98765 43210 joined using this group's invite link",
      dmy(0) + ', 09:00 - +91 98765 43210: morning',
    ].join('\n');
    const whole = await post('/admin/api/group/paste', { text: FRESH });
    ok('…while an export that runs up to today is not', whole.ok && whole.looksPartial === false, { partial: whole.looksPartial, stale: whole.staleDays });
    ok('…and neither warning wrote anything', ROWS.every((x) => !x.seen_at), ROWS.map((x) => x.seen_at));
  }

  // ── the half of the community that has no number in the export ───────────────────────────────────────────
  // Measured on the owner's real export, 29 Sep 2026: 1129 join lines, 598 of them with no number anywhere.
  // Anybody saved in his contacts is written by the name he saved — "FF - (YT) Alok Yadav joined using this
  // community's invite link" — and ignoring those made 20 of the 38 people being chased wrong.
  section('the members the export only names');
  {
    const NAMED = [
      dmy(-40) + " - FF - (YT) Arun Pillai joined using this community's invite link",
      dmy(-39) + ' - ~ Old Omkar joined the community',
      dmy(-38) + " - FF - Someone Random joined using this community's invite link",
      dmy(-30) + " - FF - Gone Gaurav joined using this community's invite link",
      dmy(-20) + ' - FF - Gone Gaurav left',
      dmy(-3) + ' - Harsh W added FF - Meera Joshi',
      dmy(0) + ', 09:00 - +91 98765 43210: morning',
    ].join('\n');
    const pl2 = I.parseList(NAMED.replace(/^(\d{2}\/\d{2}\/\d{4}) - /gm, '$1, 10:00 - '));
    ok('a system line with no number in it is still read', (pl2.names || []).length === 4, (pl2.names || []));
    ok('…replayed the same way, so somebody who joined and left is not in it', (pl2.names || []).indexOf('FF - Gone Gaurav') === -1, (pl2.names || []));
    ok('…and "X added Y" records Y, the one who joined, not X who did it', (pl2.names || []).indexOf('FF - Meera Joshi') > -1, (pl2.names || []));

    const chk = await post('/admin/api/group/paste', { text: NAMED.replace(/^(\d{2}\/\d{2}\/\d{4}) - /gm, '$1, 10:00 - ') });
    ok('the check counts them and says how many became members', chk.ok && chk.namesFound === 4 && chk.namesMatched === 3, { found: chk.namesFound, matched: chk.namesMatched, unknown: chk.namesUnknown });
    ok('…"FF - " and a service tag are the owner\'s own filing, so they are stripped before matching', chk.namesMatched === 3, chk);
    ok('…somebody who is not a customer is counted but never invented as one', chk.namesUnknown === 1, { unknown: chk.namesUnknown });
  // Three counts, and the first live run proved how easy they are to conflate: it reported 630 for a community
  // of 488, because the name-matched people had been folded into the "numbers read" count AND counted again as
  // names. countFound = numbers in the file. membersFound = people a save would write. memberTotal = the ceiling.
    ok('…"numbers read" still means numbers read, not numbers plus names', chk.countFound === 1, { countFound: chk.countFound });
    ok('…and it says how many people a save would actually write', chk.membersFound === 4, { membersFound: chk.membersFound, matched: chk.namesMatched });
    ok('…and the ceiling adds the two halves exactly once each', chk.memberTotal === chk.countFound + chk.namesFound && chk.memberTotal === 5, { total: chk.memberTotal, num: chk.countFound, named: chk.namesFound });

    // The rule that keeps this honest. Two customers with the same name is not a near miss to be resolved with a
    // guess — it is an unanswerable question, and answering it wrongly removes a real person from the chase list.
    CUSTS.push({ phone_norm: '9000000123', name: 'Arun Pillai' });
    const amb = await post('/admin/api/group/paste', { text: NAMED.replace(/^(\d{2}\/\d{2}\/\d{4}) - /gm, '$1, 10:00 - ') });
    ok('🔒 a name two customers share matches NEITHER of them', amb.namesAmbiguous === 1 && amb.namesMatched === 2, { amb: amb.namesAmbiguous, matched: amb.namesMatched });
    CUSTS = SEED_CUSTS();

    const save = await post('/admin/api/group/paste', { text: NAMED.replace(/^(\d{2}\/\d{2}\/\d{4}) - /gm, '$1, 10:00 - '), apply: true });
    ok('saving counts them as in the group', save.ok && save.byName === 3, save);
    const v = await get('/admin/api/group');
    ok('…so a customer the export never numbered stops being chased', !(v.owe || []).some((x) => x.name === 'Arun Pillai'), (v.owe || []).map((x) => x.name));
    ok('…and the row says it got there by NAME, so it can be disbelieved', (v.members || []).filter((m) => m.seenBy === 'name').length === 3, (v.members || []).map((m) => m.phone + ':' + m.seenBy));
    ok('…the screen can say what the whole community looked like, which it cannot otherwise see', v.lastList && v.lastList.memberTotal === 5 && v.lastList.named === 4, v.lastList);
    // Back to where this section started: the rows it wrote go, the two claims from earlier stay.
    ROWS = []; SETTINGS = {}; seq = 0;
    await gm.claim('9876543210', 'Siddhu', 'shop', 'Netflix (Group Offer)', { query: mockDb.query });
    await gm.claim('9123456789', 'Meera Joshi', 'olivia', 'Netflix (Group Offer)', { query: mockDb.query });
  }

  r = await post('/admin/api/group/paste', { text: EXPORT });
  ok('a check reads the export and says what it found', r.ok && r.mode === 'export' && r.countFound === 4, r);
  ok('…and writes NOTHING until it is saved — a half-pasted list would mark real members as gone', ROWS.every((x) => !x.seen_at), ROWS.map((x) => x.seen_at));

  r = await post('/admin/api/group/paste', { text: EXPORT, apply: true });
  ok('saving it records who is in the group', r.ok && r.total === 4, r);
  ok('…and the screen comes back with it already applied, so nothing has to be reloaded by hand', r.view && r.view.everChecked === true && r.view.totals.seen === 4, r.view && r.view.totals);
  ok('the change log says a list was checked', AUDIT.some((a) => a.action === 'group.list'), AUDIT.map((a) => a.action));
  ok('everyone found by their number is recorded as such', (await get('/admin/api/group')).members.filter((m) => m.seenBy === 'number').length === 4, ROWS.map((x) => x.phone_norm + ':' + x.seen_by));

  r = await get('/admin/api/group');
  ok('💸 the customer paying the group price and NOT in the group is named', (r.owe || []).length === 1 && r.owe[0].name === 'Meera Joshi', (r.owe || []).map((x) => x.name));
  ok('…and it says she had claimed she joined, which is the part worth knowing', !!r.owe[0].claimedAt, r.owe[0]);
  ok('🚪 the expired customer still sitting in the group is named separately — that is a removal, not a chase', (r.expiredIn || []).length === 1 && r.expiredIn[0].name === 'Old Omkar', (r.expiredIn || []).map((x) => x.name));
  ok('❓ the stranger in the group who pays for nothing is named too', (r.strangers || []).length === 1 && r.strangers[0].phone === '9000012345', (r.strangers || []).map((x) => x.phone));
  ok('…and the people who are both paying and present are on no list at all', !find(r, 'owe', 'Siddhu') && !find(r, 'owe', 'Arun Pillai'), (r.owe || []).map((x) => x.name));

  // ── the list changes ──────────────────────────────────────────────────────────────────────────────────────
  section('the next list, a week later');
  const LATER = '+91 98765 43210\n+91 99887 76655\n+91 91234 56789';
  r = await post('/admin/api/group/paste', { text: LATER });
  ok('a check warns that somebody who was in the group is not in this list', r.goneAway.length === 2 && r.goneAway.some((x) => x.phone === '9555000111'), r.goneAway);
  r = await post('/admin/api/group/paste', { text: LATER, apply: true });
  ok('saving marks them as no longer there', r.ok && r.gone === 2, r);
  r = await get('/admin/api/group');
  ok('…Meera has now joined for real, so she drops off the chase list', !find(r, 'owe', 'Meera Joshi') && (r.owe || []).length === 0, (r.owe || []).map((x) => x.name));
  ok('…and the expired one who left is no longer listed as needing removing', (r.expiredIn || []).length === 0, r.expiredIn);

  // ── one row at a time ─────────────────────────────────────────────────────────────────────────────────────
  section('tidying up');
  // They left the group in the second list, so they are no longer listed as being IN it — but the row stays,
  // because "was in our group, pays for nothing" is worth keeping until somebody deals with it. Forgetting is how
  // it goes away, and forgetting is only about the shop's own records.
  const strangerRow = (r.members || []).find(function (m) { return m.phone === '9000012345'; });
  ok('the row for somebody who was in the group and paid for nothing is kept, not silently dropped', !!strangerRow, r.members);
  if (strangerRow) {
    const after = await post('/admin/api/group/member', { id: strangerRow.id, action: 'forget' });
    ok('forgetting a row removes it from the shop', after.ok && !(after.members || []).some((x) => x.id === strangerRow.id), (after.members || []).map((x) => x.id));
    ok('…and says plainly that it is only the shop — WhatsApp is untouched', /does not touch WhatsApp/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8')));
  }

  // ── 🙏 asking them to join ───────────────────────────────────────────────────────────────────────────────
  section('asking somebody to join the group');
  {
    // Set the scene: a list with only Siddhu in it, so the other two are "paying, not in the group".
    await post('/admin/api/group/paste', { text: '+91 98765 43210', apply: true });
    const cur = await get('/admin/api/group');
    const target = (cur.owe || [])[0];
    ok('there is somebody to ask', !!target, (cur.owe || []).map((x) => x.name));
    const pv = await get('/admin/api/group/nudge?phone=' + target.phone);
    ok('the message is written for that customer by name', pv.ok && pv.name === target.name, { ok: pv.ok, name: pv.name });
    ok('…and carries the real invite link from their own plan, not a hard-coded one',
      pv.link === 'https://chat.whatsapp.com/abc' && pv.whatsapp.indexOf(pv.link) > -1, pv.link);
    ok('…says WHY they are being asked — the price is the group price', /Group Offer/i.test(pv.whatsapp), pv.whatsapp.slice(0, 200));
    ok('…says what happens if they do not join, without threatening them', /normal price at renewal/i.test(pv.whatsapp) && !/cancel|suspend|block/i.test(pv.whatsapp), pv.whatsapp.slice(-220));
    ok('…and offers the way out that is usually the truth: they are in it on another number', /different number/i.test(pv.whatsapp));
    ok('there is a WhatsApp link with the message already in it', /^https:\/\/wa\.me\/91\d{10}\?text=/.test(pv.waUrl) && decodeURIComponent(pv.waUrl.split('?text=')[1]).indexOf('Group Offer') > -1);
    ok('…and an email with a subject and a body', /join the FluxFilm group/i.test(pv.subject) && /Join the WhatsApp group/.test(pv.html) && pv.to === 'arun.pillai@gmail.com', { subject: pv.subject, to: pv.to });
    // 🔒 The standing rule: a real customer message is never sent without the owner seeing it first.
    ok('🔒 opening it sends NOTHING', MAILED.length === 0 && REMINDED.length === 0, { mailed: MAILED.length, logged: REMINDED.length });

    const bad = await get('/admin/api/group/nudge?phone=9000099999');
    ok('somebody who is not on the list cannot be nudged', bad.ok === false, bad);

    const sent = await post('/admin/api/group/nudge', { phone: target.phone });
    ok('sending it emails them once', sent.ok === true && MAILED.length === 1 && MAILED[0].to === 'arun.pillai@gmail.com', { sent, mailed: MAILED.length });
    ok('…and it is written down, so nobody is asked twice by accident', REMINDED.length === 1 && REMINDED[0].kind === 'GROUP_JOIN' && AUDIT.some((a) => a.action === 'group.nudge'), { log: REMINDED, audit: AUDIT.map((a) => a.action) });
    const again = await post('/admin/api/group/nudge', { phone: target.phone });
    ok('…and asking again the same day is refused', again.ok === false && again.rateLimited === true && MAILED.length === 1, again);

    // A customer with no email is common here; the WhatsApp half still works and the answer says so.
    const noMail = (cur.owe || []).find((x) => x.phone !== target.phone);
    if (noMail) {
      const c = CUSTS.find((x) => x.phone_norm === noMail.phone); const keep = c ? c.email : '';
      if (c) c.email = '';
      const r2 = await post('/admin/api/group/nudge', { phone: noMail.phone });
      ok('no email address → it says to use WhatsApp instead of failing silently', r2.ok === false && /WhatsApp/i.test(r2.message || ''), r2);
      if (c) c.email = keep;
    }

    // A field that is not a WhatsApp invite must never be pasted into a customer's message.
    PLANS[0].raw_json = JSON.stringify({ RequiresGroupJoin: 'TRUE', GroupJoinLink: 'https://example.com/not-a-group' });
    const safe = await get('/admin/api/group/nudge?phone=' + target.phone);
    ok('🔒 anything that is not a WhatsApp invite link is ignored, not sent', /^https:\/\/chat\.whatsapp\.com\//.test(safe.link), safe.link);
    PLANS = SEED_PLANS();
  }

  // ── before schema-v32 ────────────────────────────────────────────────────────────────────────────────────
  // The last time a column was added like this (schema-v30, 26 Sep) the fallback branch fell through to a throw
  // written below it and the whole screen went dark. So the no-column path is exercised, not assumed.
  section('a database where schema-v32 has not been run');
  {
    hasSeenBy = false;
    const v = await get('/admin/api/group');
    ok('the screen still loads, with every row still there', v.ok === true && (v.members || []).length === ROWS.length, { ok: v.ok, n: (v.members || []).length, rows: ROWS.length });
    ok('…and it says plainly that it cannot tell you HOW each one was found', v.provenanceOff === true, v.provenanceOff);
    const save = await post('/admin/api/group/paste', { text: '+91 98765 43210\n+91 99887 76655', apply: true });
    ok('…and a list can still be saved', save.ok === true, save);
    ok('…the panel says which migration to run', /db\/schema-v32\.sql/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8')));
    hasSeenBy = true;
  }

  // ── it is wired to the two places the tap actually happens ────────────────────────────────────────────────
  section('wired up where the tick really is');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // The tick existed for a year and went nowhere. Pin BOTH call sites: a screen fed by nothing is worse than no
  // screen, because it looks like an answer. (Same lesson as 28 Sep: pin the join, not each half on its own.)
  ok('checkout records it when the plan is a group one and the box was ticked',
    /if \(groupJoinRequired && p\.groupJoined\)/.test(read('order.js')) && /require\('\.\/groupmembers'\)\.claim\(phone, name, 'shop', service\)/.test(read('order.js')));
  ok('…and Olivia records it when they tap "I have joined" in the chat',
    /groupJoined: \(phone, name, service\) => require\('\.\/groupmembers'\)\.claim\(phone, name, 'olivia', service\)/.test(read('oliviatools.js'))
    && /t\.groupJoined\(c\.phone/.test(read('olivia.js')));
  ok('…without the chat ever waiting on it, or failing with it', /Promise\.resolve\(t\.groupJoined\([\s\S]{0,80}?\)\.catch\(\(\) => \{\}\)/.test(read('olivia.js')), (read('olivia.js').match(/t\.groupJoined[^\n]*/) || [])[0]);
  ok('the endpoints are mounted', /require\('\.\/groupmembers'\)\.mount\(app/.test(read('admin.js')));
  // A WhatsApp export of a community runs to megabytes. At the shared 1 MB it came back 413 as an HTML error
  // page the panel could not even read. The bigger parser has to be declared BEFORE the shared one or it never
  // runs, so pin the ORDER, not just its presence.
  ok('📎 a whole exported chat can actually be sent — the big parser is declared before the 1 MB one', (() => {
    const sv = read('server.js');
    const big = sv.indexOf("app.post('/admin/api/group/paste', express.json({ limit: '16mb' }))");
    const small = sv.indexOf("app.use(express.json({ limit: '1mb' }))");
    return big > -1 && small > -1 && big < small;
  })(), { });
  ok('…and the screen can take the file instead of a copy-paste of it', /id="grpfile"/.test(read('admin.html')) && /readAsText/.test(read('admin.html')));
  ok('…and says so plainly when the file is too big, instead of a JSON parse error', /too big to send in one go/.test(read('admin.html')) && /Unexpected token\|JSON/.test(read('admin.html')));
  // In a community most members are not Group Offer customers; hundreds of rows would bury the two lists that
  // do have an action behind them.
  ok('❓ the "paying for nothing" list is folded away and capped', /grpFolded\('❓ In the group, paying for nothing'/.test(read('admin.html')) && /and ' \+ \(rows\.length - shown\.length\) \+ ' more/.test(read('admin.html')));
  // The 🙏 button lives on the rows, so its handler has to live in grpClick — the PR 207 lesson: a unique
  // anchor is not a correct one, so pin the PLACE.
  ok('🙏 the ask handler is inside grpClick, where the rows are', (() => {
    const html = read('admin.html');
    const from = html.indexOf('function grpClick(e) {');
    if (from < 0) return false;
    const next = html.indexOf('\nfunction ', from + 10);
    const body = html.slice(from, next < 0 ? html.length : next);
    return body.indexOf("closest('[data-grpask]')") > -1;
  })());
  ok('…and the check NAMES who has left, not just how many — that is what you act on', /Gone: ' \+ r\.goneAway\.slice\(0, 12\)/.test(read('admin.html')));
  ok('🔒 the panel never sends without a press: both buttons are in the preview, and the email confirms',
    /data-grpask/.test(read('admin.html')) && /confirm\('Email ' \+ r\.to/.test(read('admin.html')));
  ok('the screen is in the sidebar and in the view map', /\['wagroup', '👥', 'WhatsApp group'\]/.test(read('admin.html')) && /wagroup: groupView/.test(read('admin.html')));
  // In this panel api() is a GET with a query string and post() is the POST. Sending a whole exported chat as a
  // URL fails silently — the two write buttons did nothing at all until this was noticed by clicking them.
  ok('…and its two write buttons POST, rather than hanging a pasted chat off a URL',
    /post\('\/admin\/api\/group\/paste'/.test(read('admin.html')) && /post\('\/admin\/api\/group\/member'/.test(read('admin.html'))
    && !/api\('\/admin\/api\/group\/(paste|member)'/.test(read('admin.html')));
  ok('schema-v31 makes the one table it needs', /CREATE TABLE IF NOT EXISTS wa_group_members/.test(read('db/schema-v31.sql')));
  ok('schema-v32 records how each member was found', /ADD COLUMN seen_by/.test(read('db/schema-v32.sql')));
  ok('🔒 the name matcher is exact and single — no nicknames, no initials, no fuzzy distance', (() => {
    // Comments stripped first: the rule is about what the code does, and the paragraph above nameKey says the
    // words "fuzzy distance" precisely in order to forbid them.
    const code = read('groupmembers.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    return !/levenshtein|distance|soundex|similar|startsWith/i.test(code) && /hit\.length > 1/.test(code);
  })());
  // The screen asks the owner to paste an export; if the words for how to get one ever go, the screen is useless.
  ok('…and the screen says how to get a list out of WhatsApp at all', /Export chat/.test(read('admin.html')));
  // It CAN message somebody now — that was the point of the 🙏 button — so the promise is narrower and has to
  // be stated as what it actually is: nothing goes out on a timer, and the only send is the one the owner pressed.
  ok('🔒 nothing is ever sent on a timer or a schedule', !/setInterval|setTimeout|cron|schedule/i.test(read('groupmembers.js')));
  ok('🔒 …the only send is inside the POST the owner presses', (() => {
    const src = read('groupmembers.js');
    const sends = (src.match(/\.send\(/g) || []).length;
    const i = src.indexOf("app.post('/admin/api/group/nudge'");
    const j = src.indexOf("app.post('/admin/api/group/member'");
    if (i < 0 || j < 0 || j < i) return false;
    return sends === 1 && src.slice(i, j).indexOf('.send(') > -1;
  })());
  ok('🔒 and it still never touches a subscription',
    !/UPDATE subscriptions|INSERT INTO subscriptions|DELETE FROM subscriptions/.test(read('groupmembers.js')));
  ok('🔒 and it never compares phone_norm across tables in SQL — the collation trap that broke the Today count',
    !/JOIN\s+(customers|subscriptions)/i.test(read('groupmembers.js')));

  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  console.log('\n---------------------------------------');
  console.log('group-members: PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
