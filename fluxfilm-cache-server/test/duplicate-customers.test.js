/* 🧑‍🤝‍🧑 One person, two FluxFilm accounts (owner, 29 Sep 2026: "lets do the duplicate customers next").
   Found on 27 Sep while checking Yash — 16 customers with the same email on two numbers, 20 with the same name.
   It costs money twice: the customer signs in on the number with no plan and BUYS AGAIN instead of renewing, and
   a name two customer rows share cannot be matched to either of them in the 👥 WhatsApp group.
   Real duplicates.js on a fake MySQL. Nothing is moved, nothing is deleted. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const at = (days) => new Date(Date.now() + days * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

let LINKS = []; let linkSeq = 0; let linkTable = true;
let AUDIT = [];
// Two customers with the same email on two numbers, two with the same name on two numbers, and one ordinary one.
const SEED_CUSTS = () => [
  { phone_norm: '9000000001', name: 'Karan Sunder', email: 'ksunder7@gmail.com', customer_id: 'C1', member_since: at(-400) },
  { phone_norm: '9000000002', name: 'Karan Sunder', email: 'ksunder7@gmail.com', customer_id: 'C2', member_since: at(-200) },
  { phone_norm: '9000000003', name: 'Deepak Verma', email: 'deepak.one@gmail.com', customer_id: 'C3', member_since: at(-300) },
  { phone_norm: '9000000004', name: 'deepak verma', email: 'deepak.two@gmail.com', customer_id: 'C4', member_since: at(-100) },
  { phone_norm: '9000000005', name: 'Only Once', email: 'once@gmail.com', customer_id: 'C5', member_since: at(-50) },
];
const SEED_SUBS = () => [
  { sub_id: 'S1', phone_norm: '9000000001', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(40), status: 'ACTIVE' },
  { sub_id: 'S2', phone_norm: '9000000001', service: 'Prime Video', plan: '1 Month', expiry_date: at(-30), status: 'ACTIVE' },
  { sub_id: 'S3', phone_norm: '9000000002', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(20), status: 'ACTIVE' },
  { sub_id: 'S4', phone_norm: '9000000003', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry_date: at(10), status: 'ACTIVE' },
  { sub_id: 'S5', phone_norm: '9000000005', service: 'Netflix', plan: 'Private 1M', expiry_date: at(15), status: 'ACTIVE' },
];
const SEED_ORDS = () => [
  { order_id: 'O1', phone_norm: '9000000001', created_at_sheet: at(-40) },
  { order_id: 'O2', phone_norm: '9000000001', created_at_sheet: at(-10) },
  { order_id: 'O3', phone_norm: '9000000002', created_at_sheet: at(-5) },
];
let CUSTS = []; let SUBS = []; let ORDS = [];

const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    // The collation trap: customer_links must never be compared with customers or subscriptions in SQL.
    if (/customer_links[\s\S]{0,120}(JOIN|,)\s*(customers|subscriptions|orders)\b/i.test(q)) {
      throw new Error("Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='");
    }
    if (/customer_links/.test(q) && !linkTable) { const e = new Error("Table 'u339830006_fluxfilm.customer_links' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }

    if (/^SELECT phone_norm, primary_phone, linked_at, note FROM customer_links$/.test(q)) return LINKS.map((x) => Object.assign({}, x));
    if (/^INSERT INTO customer_links/.test(q)) {
      const found = LINKS.find((x) => x.phone_norm === p[0]);
      if (found) { found.primary_phone = p[1]; found.linked_at = p[2]; found.note = p[4]; return { affectedRows: 2 }; }
      LINKS.push({ id: ++linkSeq, phone_norm: p[0], primary_phone: p[1], linked_at: p[2], linked_by: p[3], note: p[4] });
      return { insertId: linkSeq };
    }
    if (/^DELETE FROM customer_links WHERE phone_norm = \? LIMIT 1$/.test(q)) { LINKS = LINKS.filter((x) => x.phone_norm !== p[0]); return { affectedRows: 1 }; }

    if (/^SELECT phone_norm, name, email, customer_id, member_since FROM customers$/.test(q)) return CUSTS.map((x) => Object.assign({}, x));
    if (/^SELECT phone_norm, name FROM customers$/.test(q)) return CUSTS.map((x) => ({ phone_norm: x.phone_norm, name: x.name }));
    if (/^SELECT phone_norm, COUNT\(\*\) AS c, SUM\(CASE WHEN UPPER\(COALESCE\(status,''\)\) = 'ACTIVE' AND expiry_date > NOW\(\) THEN 1 ELSE 0 END\) AS a, MAX\(expiry_date\) AS e FROM subscriptions GROUP BY phone_norm$/.test(q)) {
      const m = new Map();
      for (const x of SUBS) {
        const g = m.get(x.phone_norm) || { phone_norm: x.phone_norm, c: 0, a: 0, e: '' };
        g.c++; if (String(x.status).toUpperCase() === 'ACTIVE' && x.expiry_date > at(0)) g.a++;
        if (x.expiry_date > g.e) g.e = x.expiry_date;
        m.set(x.phone_norm, g);
      }
      return [...m.values()];
    }
    if (/^SELECT phone_norm, COUNT\(\*\) AS c, MAX\(created_at_sheet\) AS last FROM orders GROUP BY phone_norm$/.test(q)) {
      const m = new Map();
      for (const x of ORDS) { const g = m.get(x.phone_norm) || { phone_norm: x.phone_norm, c: 0, last: '' }; g.c++; if (x.created_at_sheet > g.last) g.last = x.created_at_sheet; m.set(x.phone_norm, g); }
      return [...m.values()];
    }
    if (/^INSERT INTO audit_log/.test(q)) { AUDIT.push({ action: p[0], summary: p[3] }); return { affectedRows: 1 }; }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 140));
  },
  getPool: () => null,
};
const reset = () => { LINKS = []; AUDIT = []; linkSeq = 0; linkTable = true; CUSTS = SEED_CUSTS(); SUBS = SEED_SUBS(); ORDS = SEED_ORDS(); };

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const dup = require('../duplicates');
  const gm = require('../groupmembers');
  Module._load = origLoad;

  const app = express(); app.use(express.json());
  const audit = require('../audit').makeAudit({ query: mockDb.query });
  dup.mount(app, { db: mockDb, auth: () => true, audit });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'Content-Type': 'application/json' };
  const get = async (p) => (await fetch(base + p, { headers: H })).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
  const byWhy = (r, why, shown) => (r.groups || []).find((g) => g.why === why && g.shown === shown);

  section('before schema-v33');
  linkTable = false;
  let r = await get('/admin/api/duplicates');
  ok('it says the migration is needed rather than showing an empty screen', r.ok === true && r.needsSchema === true, r);
  ok('…and still lists the pairs, because finding them needs no new table', (r.groups || []).length >= 2, (r.groups || []).length);
  linkTable = true;

  section('who looks like the same person');
  r = await get('/admin/api/duplicates');
  ok('two rows with the same email are a pair', !!byWhy(r, 'email', 'ksunder7@gmail.com'), (r.groups || []).map((g) => g.why + ':' + g.shown));
  ok('two rows with the same name on different emails are a pair too', !!byWhy(r, 'name', 'deepak verma'), (r.groups || []).map((g) => g.shown));
  ok('…and the name match ignores case, which is most of how they differ', byWhy(r, 'name', 'deepak verma').people.length === 2);
  ok('somebody who appears once is not a pair', !(r.groups || []).some((g) => g.people.some((p) => p.phone === '9000000005')), (r.groups || []).map((g) => g.shown));
  // The email pair happens to share a name too. Listing it twice would double the work and the confusion.
  ok('a pair already found by email is not listed again under its name', !byWhy(r, 'name', 'karan sunder'), (r.groups || []).map((g) => g.why + ':' + g.shown));

  const ks = byWhy(r, 'email', 'ksunder7@gmail.com');
  ok('each side says what it actually holds', ks.people.find((p) => p.phone === '9000000001').subs === 2 && ks.people.find((p) => p.phone === '9000000001').orders === 2, ks.people);
  ok('…and the busier account is the one suggested to keep', ks.suggested === '9000000001', { suggested: ks.suggested });
  ok('💸 a pair paying on BOTH numbers is called out — that is the one costing money', ks.bothActive === true, ks.bothActive);
  ok('…and those come first, because they are the ones worth doing today', (r.groups || [])[0].bothActive === true, (r.groups || []).map((g) => g.shown + ':' + g.bothActive));

  section('marking them as one person');
  r = await post('/admin/api/duplicates/link', { primary: '9000000001', phones: ['9000000001', '9000000002'] });
  ok('linking works and the pair is shown as settled', r.ok && byWhy(r, 'email', 'ksunder7@gmail.com').linked === true, byWhy(r, 'email', 'ksunder7@gmail.com'));
  ok('…one row written, for the duplicate — never for the one being kept', LINKS.length === 1 && LINKS[0].phone_norm === '9000000002' && LINKS[0].primary_phone === '9000000001', LINKS);
  ok('…and the change log says so', AUDIT.some((a) => a.action === 'customer.link'), AUDIT.map((a) => a.action));
  // 🔒 The promise on the screen: nothing is moved. If that ever stops being true the screen is lying.
  ok('🔒 no subscription, order or customer row was touched', SUBS.length === 5 && ORDS.length === 3 && CUSTS.length === 5);

  r = await post('/admin/api/duplicates/link', { primary: '9000000002', phones: ['9000000002', '9000000003'] });
  ok('🔒 linking TO an account that is itself a duplicate is refused, not quietly chained', r.ok === false && /already linked/i.test(r.message || ''), r);

  // Real phone keys: primaryOf normalises what it is given, so letters would never match anything.
  const A = '9000000011', B = '9000000012', C = '9000000013';
  ok('a chain is followed to the end', dup.primaryOf(new Map([[A, B], [B, C]]), A) === C);
  ok('…and a loop somebody made by hand does not hang the screen', dup.primaryOf(new Map([[A, B], [B, A]]), A).length === 10);

  section('the payoff: the group screen can match them');
  // This is why it was worth doing. "Karan Sunder" exists twice, so the 👥 screen could not match the name in the
  // WhatsApp export to either row and left him on the chase list. One person, one name, one match.
  {
    const withLink = await gm._internal.customerNames(mockDb.query);
    ok('two linked accounts count as ONE for a name match', (withLink.byName.get('karan sunder') || []).length === 1, withLink.byName.get('karan sunder'));
    ok('…and it is the account kept as the real one', (withLink.byName.get('karan sunder') || [])[0] === '9000000001', withLink.byName.get('karan sunder'));
    ok('…while a pair nobody has linked yet is still ambiguous, and still refused', (withLink.byName.get('deepak verma') || []).length === 2, withLink.byName.get('deepak verma'));
    const m = gm._internal.matchNames(['FF - Karan Sunder', 'FF - Deepak Verma'], withLink.byName);
    ok('…so the linked one matches and the unlinked one does not', m.matched.length === 1 && m.matched[0].phone === '9000000001' && m.ambiguous.length === 1, m);
  }

  section('undoing it');
  r = await post('/admin/api/duplicates/link', { action: 'unlink', phones: ['9000000001', '9000000002'] });
  ok('unlinking puts it back exactly as it was', r.ok && LINKS.length === 0 && byWhy(r, 'email', 'ksunder7@gmail.com').linked === false, LINKS);
  {
    const after = await gm._internal.customerNames(mockDb.query);
    ok('…and the name is ambiguous again, which is the honest answer', (after.byName.get('karan sunder') || []).length === 2, after.byName.get('karan sunder'));
  }

  section('the code, and the promises on the screen');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok('🔒 it never writes to customers, subscriptions or orders',
    !/(UPDATE|DELETE FROM|INSERT INTO)\s+(customers|subscriptions|orders)\b/i.test(read('duplicates.js')));
  ok('🔒 and never compares customer_links with them in SQL', !/JOIN\s+(customers|subscriptions|orders)/i.test(read('duplicates.js')));
  ok('the screen is in the sidebar and the view map', /\['duplicates', '🧑‍🤝‍🧑', 'Same person'\]/.test(read('admin.html')) && /duplicates: duplicatesView/.test(read('admin.html')));
  ok('…and says out loud that nothing is moved or deleted', /Nothing is moved or deleted/.test(read('admin.html')));
  // Duplicates are often consecutive numbers bought together: Geetesh Gwalani's two are 9238711109 and
  // 9329711109. Masked to the last four the rows and BOTH dropdown options read "…1109", which is not a choice
  // anybody can make. Show the shortest tail that tells this one group apart.
  {
    const src = read('admin.html');
    const grab = (name) => {
      const i = src.indexOf('function ' + name + '(');
      if (i < 0) throw new Error('no ' + name);
      let d = 0; const j = src.indexOf('{', i);
      for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } }
      throw new Error('unbalanced ' + name);
    };
    const sb = { String };
    require('vm').runInNewContext(grab('dupTail') + grab('dupNum') + '; this.dupTail = dupTail; this.dupNum = dupNum;', sb);
    const clash = { people: [{ phone: '9238711109' }, { phone: '9329711109' }] };
    const plain = { people: [{ phone: '8076530888' }, { phone: '8860018222' }] };
    ok('🔢 two numbers with the same last four are shown with enough digits to tell apart', sb.dupTail(clash) === 7 && sb.dupNum(clash.people[0], 7) !== sb.dupNum(clash.people[1], 7), { n: sb.dupTail(clash), a: sb.dupNum(clash.people[0], 7), b: sb.dupNum(clash.people[1], 7) });
    ok('…and ordinary ones still show four, like the rest of the panel', sb.dupTail(plain) === 4, sb.dupTail(plain));
  }
  ok('schema-v33 makes the one table', /CREATE TABLE IF NOT EXISTS customer_links/.test(read('db/schema-v33.sql')));
  ok('the endpoints are mounted', /require\('\.\/duplicates'\)\.mount\(app/.test(read('admin.js')));

  // A patch script whose replacement contains its own anchor is not idempotent: re-running it appends a second
  // copy and nothing complains. That happened on 29 Sep — groupmembers was mounted twice and order.js recorded
  // the group claim twice. Express used the first of each, so nothing looked wrong. This is the guard.
  {
    const a = read('admin.js');
    const mounts = (a.match(/require\('\.\/[a-z]+'\)\.mount\(app/g) || []);
    const seen = {}; const twice = [];
    for (const m of mounts) { seen[m] = (seen[m] || 0) + 1; if (seen[m] === 2) twice.push(m); }
    ok('🔁 no module is mounted twice', twice.length === 0, twice);
  }
  ok('🔁 and the group join claim is recorded once, not twice', (read('order.js').match(/groupmembers'\)\.claim\(/g) || []).length === 1);

  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  console.log('\n---------------------------------------');
  console.log('duplicate-customers: PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
