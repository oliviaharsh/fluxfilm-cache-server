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

let ROWS = [];
let SUBS = [];
let PLANS = [];
let AUDIT = [];
let seq = 0;
let tableExists = true;
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

    if (/^SELECT id, phone_norm, name, claimed_at, claimed_via, claimed_for, seen_at, missing_at, note FROM wa_group_members$/.test(q)) return ROWS.map((r) => Object.assign({}, r));
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
  { phone_norm: '9123456789', name: 'Meera Joshi' },
  { phone_norm: '9988776655', name: 'Arun Pillai' },
  { phone_norm: '9555000111', name: 'Old Omkar' },
  { phone_norm: '9444000222', name: 'Refunded Ravi' },
  { phone_norm: '9333000333', name: 'Private Priya' },
];
let CUSTS = [];
const reset = () => { ROWS = []; AUDIT = []; seq = 0; tableExists = true; SUBS = SEED_SUBS(); PLANS = SEED_PLANS(); CUSTS = SEED_CUSTS(); };

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
  gm.mount(app, { db: mockDb, auth: () => true, audit });
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
  r = await post('/admin/api/group/paste', { text: EXPORT });
  ok('a check reads the export and says what it found', r.ok && r.mode === 'export' && r.countFound === 4, r);
  ok('…and writes NOTHING until it is saved — a half-pasted list would mark real members as gone', ROWS.every((x) => !x.seen_at), ROWS.map((x) => x.seen_at));

  r = await post('/admin/api/group/paste', { text: EXPORT, apply: true });
  ok('saving it records who is in the group', r.ok && r.total === 4, r);
  ok('…and the screen comes back with it already applied, so nothing has to be reloaded by hand', r.view && r.view.everChecked === true && r.view.totals.seen === 4, r.view && r.view.totals);
  ok('the change log says a list was checked', AUDIT.some((a) => a.action === 'group.list'), AUDIT.map((a) => a.action));

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
  ok('the screen is in the sidebar and in the view map', /\['wagroup', '👥', 'WhatsApp group'\]/.test(read('admin.html')) && /wagroup: groupView/.test(read('admin.html')));
  // In this panel api() is a GET with a query string and post() is the POST. Sending a whole exported chat as a
  // URL fails silently — the two write buttons did nothing at all until this was noticed by clicking them.
  ok('…and its two write buttons POST, rather than hanging a pasted chat off a URL',
    /post\('\/admin\/api\/group\/paste'/.test(read('admin.html')) && /post\('\/admin\/api\/group\/member'/.test(read('admin.html'))
    && !/api\('\/admin\/api\/group\/(paste|member)'/.test(read('admin.html')));
  ok('schema-v31 makes the one table it needs', /CREATE TABLE IF NOT EXISTS wa_group_members/.test(read('db/schema-v31.sql')));
  // The screen asks the owner to paste an export; if the words for how to get one ever go, the screen is useless.
  ok('…and the screen says how to get a list out of WhatsApp at all', /Export chat/.test(read('admin.html')));
  ok('🔒 it never messages anybody and never touches a subscription',
    !/mailer|sendMail|transport|wa\.me|whatsappText/i.test(read('groupmembers.js'))
    && !/UPDATE subscriptions|INSERT INTO subscriptions|DELETE FROM subscriptions/.test(read('groupmembers.js')));
  ok('🔒 and it never compares phone_norm across tables in SQL — the collation trap that broke the Today count',
    !/JOIN\s+(customers|subscriptions)/i.test(read('groupmembers.js')));

  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  console.log('\n---------------------------------------');
  console.log('group-members: PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
