/* 🏠 Netflix Household — the customer's own tool (owner, 23 Sep 2026: "add one button Netflix Household in tools …
   that should check first if customer has active subs … then which account (so that customers do not need to
   understand which link to click its confusing)"). Real householdhelp.js on a fake MySQL with oliviahousehold
   stubbed — no inbox, no Netflix. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- fakes
const SETTINGS = {};
const SUBS = {
  '9971430096': [
    { sub_id: 'S-OURS', plan: 'Sharing 1M', expiry_date: '2026-10-23 10:00:00', inventory_ref: 'NFLX-H5#P1' },
    { sub_id: 'S-THEIRS', plan: 'Private 1M', expiry_date: '2026-11-02 10:00:00', inventory_ref: 'NFLX-D3#P2' },
  ],
  '9000000002': [{ sub_id: 'S-ONE', plan: 'Sharing 3M', expiry_date: '2026-12-01 10:00:00', inventory_ref: 'NFLX-H5#P1' }],
  '9000000009': [],
};
const fakeDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    if (/SELECT value FROM app_settings/.test(sql)) return SETTINGS[p[0]] === undefined ? [] : [{ value: SETTINGS[p[0]] }];
    if (/^INSERT INTO app_settings/.test(sql)) { SETTINGS[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/FROM subscriptions WHERE phone_norm = \?/.test(sql)) return (SUBS[p[0]] || []).map((x) => Object.assign({}, x));
    throw new Error('fake db: unhandled SQL: ' + sql);
  },
};
// What oliviahousehold would answer. The tool must never do more than this allows.
const CALLS = [];
const ACC = {
  'NFLX-H5': { ref: 'NFLX-H5', subId: 'S-OURS', service: 'Netflix', email: 'ininjathetriggerman@gmail.com', kind: 'H', tag: 'ACC5' },
  'NFLX-D3': { ref: 'NFLX-D3', subId: 'S-THEIRS', service: 'Netflix', email: 'someone@darkflix.shop', kind: 'D', tag: '' },
};
let updateOn = true;
const fakeHh = {
  netflixAccounts: async (phone) => ({ ok: true, accounts: (SUBS[phone] || []).map((s) => ACC[String(s.inventory_ref).split('#')[0]]).filter(Boolean) }),
  travelCode: async (a) => { CALLS.push(['travel', a.ref]); return { ok: true, code: '1234' }; },
  verificationCode: async (a) => { CALLS.push(['signin', a.ref]); return { ok: true, code: '068097' }; },
  updateHousehold: async (a) => { CALLS.push(['update', a.ref]); return { ok: true }; },
  updateEnabled: () => updateOn,
};
const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return fakeDb; if (req === './oliviahousehold') return fakeHh; return origLoad.apply(this, arguments); };
const hh = require('../householdhelp');
Module._load = origLoad;
const deps = { household: fakeHh };

(async () => {
  // ── who is asking, and what have they got ─────────────────────────────────────────────────────────────────
  section('the shop works out which account — the customer does not');
  let r = await hh.start('9000000009', deps);
  ok('no Netflix plan → say so, so the tool can offer one', r.ok && r.needPlan === true && !r.accounts.length, r);
  r = await hh.start('9000000002', deps);
  ok('one plan → one account, marked as ours', r.ok && r.accounts.length === 1 && r.accounts[0].accountId === 'NFLX-H5' && r.accounts[0].ours === true, r);
  ok('…with the plan and end date, so the customer recognises it', r.accounts[0].plan === 'Sharing 3M' && r.accounts[0].expiry === '2026-12-01', r.accounts[0]);
  r = await hh.start('9971430096', deps);
  ok('two plans → both, one ours and one not', r.accounts.length === 2 && r.accounts.filter((a) => a.ours).length === 1, r.accounts);
  ok('…each with its Netflix email, which is how the customer tells them apart', r.accounts.every((a) => a.email), r.accounts);
  ok('not logged in → nothing at all', (await hh.start('', deps)).ok === false);

  // ── the thing that matters: it only ever acts on YOUR account ─────────────────────────────────────────────
  section('🔒 it can only act on an account you are paying for');
  CALLS.length = 0;
  r = await hh.fix('9000000002', 'NFLX-H5', 'travel', deps);
  ok('your own account → the code', r.ok && r.code === '1234' && CALLS[0][1] === 'NFLX-H5', { r, CALLS });
  CALLS.length = 0;
  r = await hh.fix('9000000002', 'NFLX-H1', 'travel', deps);
  ok('⚠️ somebody else\'s account id → refused, and nothing was fetched', r.ok === false && CALLS.length === 0, { r, CALLS });
  CALLS.length = 0;
  r = await hh.fix('9000000009', 'NFLX-H5', 'travel', deps);
  ok('⚠️ no active plan → refused, and nothing was fetched', r.ok === false && r.needPlan === true && CALLS.length === 0, { r, CALLS });
  r = await hh.fix('9971430096', 'NFLX-H5', 'nonsense', deps);
  ok('a made-up action is refused', r.ok === false && /Pick what you are seeing/.test(r.message), r);
  {
    // Two accounts and none chosen: it must ask, not guess which one.
    CALLS.length = 0;
    const amb = await hh.fix('9971430096', '', 'travel', deps);
    ok('two accounts, none picked → it asks instead of guessing', amb.ok === false && /choose which Netflix/i.test(amb.message) && CALLS.length === 0, amb);
    const one = await hh.fix('9000000002', '', 'travel', deps);
    ok('…but with only one account it just gets on with it', one.ok === true && one.code === '1234', one);
  }

  // ── the three things a customer can be seeing ─────────────────────────────────────────────────────────────
  section('the three things');
  r = await hh.fix('9971430096', 'NFLX-H5', 'signin', deps);
  ok('🔐 verification code, for our own account', r.ok && r.code === '068097', r);
  r = await hh.fix('9971430096', 'NFLX-H5', 'household', deps);
  ok('🏠 make this TV the home', r.ok && r.done === true, r);
  {
    updateOn = false;
    const off = await hh.fix('9971430096', 'NFLX-H5', 'household', deps);
    ok('…and when the owner has that switched off, it says so instead of half-doing it', off.ok === false && off.updateOff === true, off);
    updateOn = true;
  }
  {
    CALLS.length = 0;
    const d = await hh.fix('9971430096', 'NFLX-D3', 'travel', deps);
    ok('a partner account → the page to open, and nothing is fetched from our inbox', d.ok && d.notOurs === true && /household\.php/.test(d.openLink) && CALLS.length === 0, { d, CALLS });
    ok('…with the Netflix email to type in', d.email === 'someone@darkflix.shop', d);
  }

  // ── the example pictures ──────────────────────────────────────────────────────────────────────────────────
  section('the pictures the customer points at');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  ok('none to start with', Object.values((await hh.pictures(deps)).pictures).every((v) => !v));
  hh._internal.reset();
  let p = await hh.savePicture('household', PNG, deps);
  ok('one can be uploaded', p.ok && p.has === true, p);
  ok('…and the shop can read it back', (await hh.pictures(deps)).pictures.household === PNG);
  ok('a file that is not an image is refused', (await hh.savePicture('household', 'data:text/html,<script>', deps)).ok === false);
  ok('an unknown slot is refused', (await hh.savePicture('nope', PNG, deps)).ok === false);
  hh._internal.reset();
  ok('one can be removed without touching the others', (await hh.savePicture('household', '', deps)).ok && !(await hh.pictures(deps)).pictures.household);

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // PR 172 renamed signInCode → verificationCode on main while this branch was open, and a call to the old
  // name would have merged cleanly and then been undefined at runtime. Pin the name to the one the module exports.
  ok('it calls the function oliviahousehold actually exports', /module\.exports = \{[^}]*\bverificationCode\b/.test(read('oliviahousehold.js')) && read('householdhelp.js').indexOf('H.verificationCode(target, deps)') > -1);
  const server = read('server.js');
  ok('the three actions are wired', /householdPics: \(\) => hhMod\.pictures\(\)/.test(server) && /householdStart: \(a\) => hhMod\.start\(a\[0\]\)/.test(server) && /householdFix: \(a\) => hhMod\.fix\(a\[0\], a\[1\], a\[2\]\)/.test(server));
  ok('…rate limited per IP, and the powerful one per phone as well', /householdFix: security\.rateLimiter\(20, TEN_MIN\)/.test(server) && /PHONE_LIMITS = \{[\s\S]*?householdFix: security\.rateLimiter\(10, 60 \* 60e3\)/.test(server));
  ok('…and on the MySQL storefront list', /'householdPics', 'householdStart', 'householdFix'/.test(server));
  const auth = read('customerauth.js');
  ok('the pictures are public, everything else needs the session', /householdPics: P/.test(auth) && /householdStart: S\(0\), householdFix: S\(0\)/.test(auth));
  const html = read('index.html');
  ok('the Tools tile opens the new tool, and the old "Link 1 / Link 2" sheet is gone',
    /React\.createElement\(HouseholdGate, \{/.test(html) && !/Which link should I use\?/.test(html) && !/🔧 Open Link 1/.test(html));
  ok('it asks you to log in first, because it reads your own plans', /function HouseholdGate\(\{/.test(html) && /ffEnsureLogin_\('', p => \{/.test(html));
  ok('no plan → it offers the plans instead of a dead end', /window\.ffGoBuy\('Netflix'\)/.test(html));
  ok('the three choices are shown with a picture each', /HH_WHATS = \[\{/.test(html) && /pics\[w\.id\] \? E\("img", \{/.test(html));
  ok('a partner account is sent to its own page or to Olivia', /!picked\.ours/.test(html) && /Ask Olivia to do it/.test(html));
  const admin = read('admin.html');
  ok('the owner can upload the three examples', /NF_PICS = \[\['household'/.test(admin) && /post\('\/admin\/api\/netflix\/pictures'/.test(admin));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
