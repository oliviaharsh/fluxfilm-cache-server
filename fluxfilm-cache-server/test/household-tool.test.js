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
// Who the numbers belong to, and every line written to the change log.
const NAMES = { '9971430096': 'Harsh Walia', '9000000002': 'Priya Sharma' };
const AUDIT = [];
let auditBroken = false;
const fakeDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    if (/^INSERT INTO audit_log/.test(sql)) {
      if (auditBroken) throw new Error('Table \'audit_log\' doesn\'t exist');
      AUDIT.push({ action: p[0], entity: p[1], entity_id: p[2], summary: p[3], details: p[4], ip: p[5] });
      return { affectedRows: 1 };
    }
    if (/SELECT name FROM customers WHERE phone_norm/.test(sql)) return NAMES[p[0]] ? [{ name: NAMES[p[0]] }] : [];
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
const hhlog = require('../customerlog');   // the shared logger, loaded while ./db is still the fake
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
    // Changed 24 Sep 2026 (owner: "can we not do that also in just 3 buttons"): a partner account is FIXED now,
    // not handed a link. The link only comes back when darkflix cannot do it - see the partner section below.
    ok('a partner account is fixed too, not sent away', d.ok && d.code === '1234' && !d.openLink, { d, CALLS });
    const sg = await hh.fix('9971430096', 'NFLX-D3', 'signin', deps);
    ok('…and the one that cannot work still gives the page, with the email to type in', sg.notOurs === true && /household\.php/.test(sg.openLink) && sg.email === 'someone@darkflix.shop', sg);
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

  // ── the change log ────────────────────────────────────────────────────────────────────────────────────────
  section('🕘 every use is written down — name, number, account, what happened');
  {
    const last = () => AUDIT[AUDIT.length - 1];
    const req = { ip: '203.0.113.9' };

    AUDIT.length = 0;
    await hh.start('9971430096', deps, req);
    ok('opening the tool is logged, with the name and the number', last().action === 'household.open' &&
      last().summary === 'Harsh Walia · 9971430096 · opened the household tool — 2 account(s)', last());
    ok('…against the customer, with where they came from', last().entity === 'customer' && last().entity_id === '9971430096' && last().ip === '203.0.113.9', last());

    AUDIT.length = 0;
    let out = await hh.fix('9000000002', 'NFLX-H5', 'travel', deps, req);
    ok('the TV code is logged as given', out.ok && AUDIT.length === 1 &&
      last().summary === 'Priya Sharma · 9000000002 · NFLX-H5 · get the TV code · ✅ TV code given', { out, AUDIT });
    ok('…and acting does NOT also log an "opened"', AUDIT.filter((a) => a.action === 'household.open').length === 0, AUDIT);
    ok('🔐 THE CODE ITSELF IS NEVER WRITTEN DOWN', out.code === '1234' && JSON.stringify(last()).indexOf('1234') === -1, last());

    AUDIT.length = 0;
    out = await hh.fix('9000000002', 'NFLX-H5', 'signin', deps, req);
    ok('the sign-in code is logged as given', out.ok && last().action === 'household.signin' && /🔐 sign-in code given/.test(last().summary), last());
    ok('🔐 …and that code is not written down either', out.code === '068097' && JSON.stringify(last()).indexOf('068097') === -1, last());

    AUDIT.length = 0;
    out = await hh.fix('9971430096', 'NFLX-H5', 'household', deps, req);
    ok('making the TV the home is logged', out.ok && last().action === 'household.update' && /🏠 this TV made the home/.test(last().summary), last());

    updateOn = false;
    AUDIT.length = 0;
    await hh.fix('9971430096', 'NFLX-H5', 'household', deps, req);
    ok('…and so is it being switched off', last().action === 'household.update' && /turned off/.test(last().summary), last());
    updateOn = true;

    AUDIT.length = 0;
    out = await hh.fix('9971430096', 'NFLX-D3', 'household', deps, req);
    ok('a darkflix account is logged as the fix it now is', out.ok && out.done === true && last().action === 'household.update' && /partner account/.test(last().summary), last());

    // The lines that matter most: somebody asking for an account that is not theirs.
    AUDIT.length = 0;
    out = await hh.fix('9000000002', 'NFLX-H9', 'signin', deps, req);
    ok('🚫 asking for an account that is not yours is REFUSED and logged', !out.ok && last().action === 'household.refused' &&
      /NFLX-H9, which is not theirs/.test(last().summary), { out, last: last() });
    ok('…with what they do own, for comparison', /NFLX-H5/.test(last().details), last().details);

    AUDIT.length = 0;
    out = await hh.fix('9000000009', 'NFLX-H5', 'signin', deps, req);
    ok('🚫 so is asking with no active plan at all', !out.ok && last().action === 'household.refused' && /no active Netflix plan/.test(last().summary), last());
    ok('…and an unknown number still logs, as Unknown', /^Unknown · 9000000009/.test(last().summary), last().summary);

    AUDIT.length = 0;
    out = await hh.fix('9971430096', '', 'signin', deps, req);
    ok('🚫 two accounts and no choice made is logged too', !out.ok && last().action === 'household.refused' && /without saying which account/.test(last().summary), last());

    // The log must never be able to break the thing it is logging.
    auditBroken = true;
    AUDIT.length = 0;
    out = await hh.fix('9000000002', 'NFLX-H5', 'travel', deps, req);
    ok('a missing audit_log table does NOT stop a customer fixing their TV', out.ok === true && out.code === '1234' && AUDIT.length === 0, out);
    auditBroken = false;
  }

  section('🕘 Olivia writes the same lines when SHE does it in chat');
  {
    AUDIT.length = 0;
    await hhlog.record({ query: fakeDb.query }, { ip: '198.51.100.4' }, {
      action: 'household.signin', phone: '+91 99714 30096',
      summary: 'in Olivia chat · NFLX-H5 · get the sign-in code · 🔐 sign-in code given',
      details: { what: 'verify', via: 'olivia', accountId: 'NFLX-H5', ok: true },
    });
    const row = AUDIT[0];
    ok('one shared logger, so both doors are written down the same way', !!row && row.action === 'household.signin', row);
    ok('…with the name in front of the number', /^Harsh Walia · 9971430096 · in Olivia chat/.test(row.summary), row.summary);
    ok('…the number normalised to 10 digits', row.entity_id === '9971430096', row.entity_id);
    ok('…and where it came from', row.ip === '198.51.100.4', row.ip);
  }

  // A PARTNER (darkflix) account: two of the three buttons work the same way, because the link comes from
  // darkflix rather than our inbox. Only the 6-digit code cannot - that mail is not ours to read.
  section('\🤝 partner accounts get the same buttons, where they can work');
  {
    CALLS.length = 0;
    let p1 = await hh.fix('9971430096', 'NFLX-D3', 'travel', deps);
    ok('\u2708\ufe0f the travelling code is fetched for a partner account too', p1.ok && p1.code === '1234' && !p1.openLink, p1);
    ok('...through the same darkflix path, not our inbox', CALLS.some((c) => c[0] === 'travel' && c[1] === 'NFLX-D3'), CALLS);

    updateOn = true;
    CALLS.length = 0;
    p1 = await hh.fix('9971430096', 'NFLX-D3', 'household', deps);
    ok('\U0001f3e0 and the household is updated for a partner account', p1.ok && p1.done === true && !p1.openLink, p1);

    p1 = await hh.fix('9971430096', 'NFLX-D3', 'signin', deps);
    ok('\U0001f510 but the 6-digit code is refused - that mail goes to their mailbox, not ours', p1.ok && p1.notOurs === true && p1.partnerSignin === true && !!p1.openLink, p1);

    // If darkflix cannot do it, the link is still there as the fallback rather than a dead end.
    const sulky = Object.assign({}, fakeHh, { travelCode: async () => ({ ok: false, manual: true }) });
    p1 = await hh.fix('9971430096', 'NFLX-D3', 'travel', { household: sulky });
    ok('...and when darkflix cannot do it, they still get the page', p1.ok && p1.notOurs === true && /household\.php/.test(p1.openLink), p1);
    updateOn = true;
  }

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // PR 172 renamed signInCode → verificationCode on main while this branch was open, and a call to the old
  // name would have merged cleanly and then been undefined at runtime. Pin the name to the one the module exports.
  ok('it calls the function oliviahousehold actually exports', /module\.exports = \{[^}]*\bverificationCode\b/.test(read('oliviahousehold.js')) && read('householdhelp.js').indexOf('H.verificationCode(target, deps)') > -1);
  const server = read('server.js');
  ok('the three actions are wired', /householdPics: \(\) => hhMod\.pictures\(\)/.test(server) && /householdStart: \(a, req\) => hhMod\.start\(a\[0\], null, req\)/.test(server) && /householdFix: \(a, req\) => hhMod\.fix\(a\[0\], a\[1\], a\[2\], null, req\)/.test(server));
  ok('…rate limited per IP, and the powerful one per phone as well', /householdFix: security\.rateLimiter\(20, TEN_MIN\)/.test(server) && /PHONE_LIMITS = \{[\s\S]*?householdFix: security\.rateLimiter\(10, 60 \* 60e3\)/.test(server));
  ok('…and on the MySQL storefront list', /'householdPics', 'householdStart', 'householdFix'/.test(server));
  const auth = read('customerauth.js');
  ok('the pictures are public, everything else needs the session', /householdPics: P/.test(auth) && /householdStart: S\(0\), householdFix: S\(0\)/.test(auth));
  const html = read('index.html');
  ok('the Tools tile opens the new tool, and the old "Link 1 / Link 2" sheet is gone',
    /React\.createElement\(HouseholdGate, \{/.test(html) && !/Which link should I use\?/.test(html) && !/🔧 Open Link 1/.test(html));
  ok('it asks you to log in first, because it reads your own plans', /function HouseholdGate\(\{/.test(html) && /ffEnsureLogin_\('', p => \{/.test(html));
  ok('no plan → it offers the plans instead of a dead end', /window\.ffGoBuy\('Netflix'\)/.test(html));
  ok('the three choices are shown with a picture each', /HH_WHATS = \[\{/.test(html) && /hhPic_\(pics, w\.id\) \? E\("img", \{/.test(html));
  ok('a partner account is sent to its own page or to Olivia', /!picked\.ours/.test(html) && /Ask Olivia to do it/.test(html));
  const admin = read('admin.html');
  ok('the owner can upload the three examples', /NF_PICS = \[\['household'/.test(admin) && /post\('\/admin\/api\/netflix\/pictures'/.test(admin));

  ok('Olivia logs all three household actions she does in chat', (() => {
    const o = read('olivia.js');
    return (o.match(/hhLog\(c\.phone, mode, got, gotAcc, usable\.length\);/g) || []).length === 3 && /require\('\.\/customerlog'\)\.record\(/.test(o);
  })());
  ok('householdhelp and Olivia share one logger', /require\('\.\/customerlog'\)/.test(read('householdhelp.js')));
  ok('🔐 no code is ever handed to the logger', !/record\([^)]*code/.test(read('customerlog.js')) && !/code: r\.code[^)]*note\(/.test(read('householdhelp.js')));
  // The three pictures are DRAWN, not photographed: no customer's email on them, ~3 KB each, and crisp at any size.
  section('the pictures the customer taps');
  {
    const src = read('householdpics.js');
    const sandbox = { window: {}, encodeURIComponent };
    require('vm').runInNewContext(src, sandbox);
    const pics = sandbox.window.FF_HH_PICS || {};
    ok('one for each choice', ['household', 'travel', 'signin'].every((k) => !!pics[k]), Object.keys(pics));
    ok('...each a self-contained SVG data URL', Object.values(pics).every((u) => /^data:image\/svg\+xml;charset=utf-8,%3Csvg/.test(u)));
    ok('...and small enough to be free', Object.values(pics).every((u) => u.length < 8192), Object.values(pics).map((u) => Math.round(u.length / 102.4) / 10 + ' KB'));
    const svgs = Object.values(pics).map((u) => decodeURIComponent(u.split(',')[1]));
    ok('...well-formed: every tag closed', svgs.every((s) => {
      const open = (s.match(/<(svg|g|text|rect|path|circle|defs|radialGradient|stop)\b/g) || []).length;
      const shut = (s.match(/<\/(svg|g|text|rect|path|circle|defs|radialGradient|stop)>/g) || []).length + (s.match(/\/>/g) || []).length;
      return open === shut;
    }));
    ok('...nothing loaded from outside, and no script in them', svgs.every((s) => !/<script|href\s*=|xlink:|https?:\/\/(?!www\.w3\.org)/.test(s)));
    ok('...they show the words a customer is actually looking at', /isn't part of/.test(svgs[0]) && /Enter this code/.test(svgs[1]) && /Verify with this code/.test(svgs[2]));
  }
  ok('the shop and the panel both load them, and the shop serves the file', /<script src="\/household-pics\.js" defer><\/script>/.test(read('index.html'))
    && /<script src="\/household-pics\.js"><\/script>/.test(read('admin.html'))
    && /app\.get\('\/household-pics\.js'/.test(read('server.js')));
  ok('an uploaded screenshot wins, the drawing is the fallback', /function hhPic_\(pics, id\)/.test(read('index.html'))
    && /const own = \(pics \|\| \{\}\)\[id\];/.test(read('index.html'))
    && /window\.FF_HH_PICS \|\| \{\}\)\[id\]/.test(read('index.html')));
  ok('the picture is shown again, full width, above the steps', /className: "ff-hh-shot"/.test(read('index.html')) && /\.ff-hh-shot \{/.test(read('index.html')));
  ok('nothing is cropped any more - a wide photo of a TV stays readable', /\.ff-hh-what img \{ width: 104px; height: 78px; object-fit: contain;/.test(read('index.html')));
  ok('admin shows the owner the same drawing, and says it is the built-in one', /Built-in drawing/.test(read('admin.html')));
  ok('server.js hands the request through, so the log has an IP', /householdFix: \(a, req\) => hhMod\.fix\(a\[0\], a\[1\], a\[2\], null, req\)/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
  ok('admin.html can filter the change log to 🏠 Household', /\['household', '🏠 Household'\]/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8')));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
