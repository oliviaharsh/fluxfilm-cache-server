/* ➕ Add account — one form instead of seven row-adds (adminnewaccount.js).
 *
 * Owner, 4 Oct 2026: *"i will have to add id pass then profiles in separate sheet, is there a solution"*.
 * There was none: a Netflix account meant SEVEN row-adds across inventory_accounts, inventory_capacity and
 * one inventory_profiles row per profile, with Service and AccountID retyped into each.
 *
 * What is worth protecting here:
 *   · everything or nothing — a half-made account looks stockable in admin and falls over at fulfilment
 *   · the profile shape matches the live Netflix accounts, not a guess
 *   · raw_json agrees with the typed columns on every row (CLAUDE.md: drift there misbehaves at checkout)
 *   · a password never reaches the change log
 *   · deleting an account is refused the moment a customer is on it
 *
 * Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const mod = require(path.join(__dirname, '..', 'adminnewaccount.js'));
const { nextIdFrom, defaultProfiles, problemsWith, warningsFor, PRIME_MAX_TV } = mod._internal;

// ── a database that is just arrays, and a connection that can be made to fail ──────────────────────────
let ROWS, SQL, FAIL_ON, COMMITS, ROLLBACKS;
const reset = () => {
  ROWS = { inventory_accounts: [], inventory_capacity: [], inventory_profiles: [], subscriptions: [], plans: [] };
  SQL = []; FAIL_ON = null; COMMITS = 0; ROLLBACKS = 0;
};
const tableOf = (sql) => (String(sql).match(/(?:INTO|FROM)\s+([a-z_]+)/i) || [])[1] || '';
const runSql = (sql, params) => {
  SQL.push(String(sql));
  if (FAIL_ON && String(sql).indexOf(FAIL_ON) >= 0) throw new Error('boom');
  const t = tableOf(sql);
  if (/^INSERT/i.test(sql)) { (ROWS[t] = ROWS[t] || []).push({ sql: String(sql), params: params || [] }); return { affectedRows: 1 }; }
  if (/^DELETE/i.test(sql)) { const n = (ROWS[t] || []).length; ROWS[t] = []; return { affectedRows: n }; }
  if (/^SELECT/i.test(sql)) {
    if (t === 'plans') return ROWS.plans;
    if (t === 'subscriptions') return ROWS.subscriptions;
    if (t === 'inventory_accounts' && /COUNT|DISTINCT/i.test(sql)) return [];
    return ROWS[t] || [];
  }
  return { affectedRows: 0 };
};
const conn = {
  query: async (sql, p) => [runSql(sql, p)],
  beginTransaction: async () => {},
  commit: async () => { COMMITS++; },
  rollback: async () => { ROLLBACKS++; },
  release: () => {},
};
const db = { query: async (sql, p) => runSql(sql, p), getPool: () => ({ getConnection: async () => conn }) };

// ── the smallest express that records what was mounted ─────────────────────────────────────────────────
const ROUTES = {};
const app = { get: (p, h) => { ROUTES['GET ' + p] = h; }, post: (p, h) => { ROUTES['POST ' + p] = h; } };
let AUDIT = [];
const call = async (route, body, query) => {
  const h = ROUTES[route]; if (!h) throw new Error('no route ' + route);
  let out = null; let code = 200;
  const res = { json: (x) => { out = x; return res; }, status: (c) => { code = c; return res; } };
  await h({ body: body || {}, query: query || {}, headers: {} }, res);
  return { code, body: out };
};

reset();
mod.mount(app, { db, auth: () => true, audit: { record: (req, e) => AUDIT.push(e) } });

(async () => {
  section('the next free id');
  ok('PRI-05 -> PRI-06', nextIdFrom(['PRI-01', 'PRI-05', 'PRI-04']) === 'PRI-06', nextIdFrom(['PRI-01', 'PRI-05', 'PRI-04']));
  ok('padding is kept', nextIdFrom(['PRI-08', 'PRI-09']) === 'PRI-10');
  ok('NFLX-D5 -> NFLX-D6', nextIdFrom(['NFLX-D1', 'NFLX-D5']) === 'NFLX-D6', nextIdFrom(['NFLX-D1', 'NFLX-D5']));
  // A one-off oddity should not decide what the next account is called.
  ok('the commonest prefix wins', nextIdFrom(['PRI-01', 'PRI-02', 'PRI-03', 'ODD-9']) === 'PRI-04', nextIdFrom(['PRI-01', 'PRI-02', 'PRI-03', 'ODD-9']));
  ok('nothing to go on is a blank, not a crash', nextIdFrom([]) === '' && nextIdFrom(['PRIME-A']) === '');

  section('the profile shape matches the live accounts');
  const five = defaultProfiles(5);
  ok('five of them', five.length === 5);
  // NFLX-D3/D4/D5 all look exactly like this today.
  ok('#1 is the sharing one', five[0].type === 'SHARING_RESERVED' && five[0].reserved === true, five[0]);
  ok('the rest are private', five.slice(1).every((p) => p.type === 'PRIVATE_ROTATING' && p.reserved === false));
  ok('numbered 1..5', five.map((p) => p.number).join(',') === '1,2,3,4,5');

  section('what it refuses');
  const SECRET = 'not-a-real-password-4417';   // distinctive, so 'is it in the log?' can actually be answered
const base = { service: 'Netflix', accountId: 'NFLX-99', login: 'a@b.com', password: SECRET, maxTotal: 5, maxTv: 0, profiles: five };
  ok('a complete one is fine', problemsWith(base, { policy: 'PROFILE' }).length === 0, problemsWith(base, { policy: 'PROFILE' }));
  ok('no login', problemsWith(Object.assign({}, base, { login: '' }), { policy: 'PROFILE' }).some((x) => /login/i.test(x)));
  ok('no password', problemsWith(Object.assign({}, base, { password: '' }), { policy: 'PROFILE' }).some((x) => /password/i.test(x)));
  ok('an id already in use', problemsWith(base, { policy: 'PROFILE', idTaken: true }).some((x) => /already exists/i.test(x)));
  ok('a silly id', problemsWith(Object.assign({}, base, { accountId: 'no!!' }), { policy: 'PROFILE' }).some((x) => /characters/i.test(x)));
  ok('more TVs than devices', problemsWith(Object.assign({}, base, { maxTotal: 2, maxTv: 3 }), { policy: 'CAPACITY' }).some((x) => /More TVs/i.test(x)));
  ok('no room at all', problemsWith(Object.assign({}, base, { maxTotal: 0 }), { policy: 'CAPACITY' }).some((x) => /at least 1/i.test(x)));
  const dupe = [{ number: 1, type: 'SHARING_RESERVED' }, { number: 1, type: 'PRIVATE_ROTATING' }];
  ok('two profiles with one number', problemsWith(Object.assign({}, base, { profiles: dupe }), { policy: 'PROFILE' }).some((x) => /same number/i.test(x)));
  const two = [{ number: 1, type: 'SHARING_RESERVED' }, { number: 2, type: 'SHARING_RESERVED' }];
  ok('two sharing profiles', problemsWith(Object.assign({}, base, { profiles: two }), { policy: 'PROFILE' }).some((x) => /one profile can be the sharing/i.test(x)));
  // A device-policy account has no profiles, and that is not a fault.
  ok('Prime needs no profiles', problemsWith({ service: 'Prime', accountId: 'PRI-40', login: 'a@b.com', password: 'x', maxTotal: 5, maxTv: 2 }, { policy: 'CAPACITY' }).length === 0);

  section('what it warns about but allows');
  // Amazon's own page, read 4 Oct 2026: "5 devices, including 2 TVs".
  const over = warningsFor({ service: 'Prime Video', maxTotal: 5, maxTv: 3 }, { policy: 'CAPACITY' });
  ok('a third TV on Prime is called out', over.some((x) => /only 2 TVs/i.test(x)), over);
  ok('…and it says what actually happens', over.some((x) => /refused/i.test(x)), over);
  ok('two TVs is fine and silent', warningsFor({ service: 'Prime Video', maxTotal: 5, maxTv: 2 }, { policy: 'CAPACITY' }).length === 0);
  ok('a login already on another account is called out',
    warningsFor({ service: 'Netflix', maxTotal: 5, maxTv: 0, profiles: five }, { policy: 'PROFILE', sameLogin: ['NFLX-D2'] }).some((x) => /NFLX-D2/.test(x)));
  ok('an all-private Netflix account is called out, not refused',
    warningsFor({ service: 'Netflix', maxTotal: 5, maxTv: 0, profiles: [{ number: 1, type: 'PRIVATE_ROTATING' }] }, { policy: 'PROFILE' }).some((x) => /only ever be sold as private/i.test(x)));

  section('creating one writes all three tables, together');
  reset(); AUDIT = [];
  ROWS.plans = [{ service: 'Netflix', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) }];
  let r = await call('POST /admin/api/account/create', Object.assign({}, base, { confirm: true }));
  ok('it says yes', r.body && r.body.ok === true, r.body);
  ok('one account row', ROWS.inventory_accounts.length === 1, ROWS.inventory_accounts.length);
  ok('one capacity row', ROWS.inventory_capacity.length === 1);
  ok('five profile rows', ROWS.inventory_profiles.length === 5, ROWS.inventory_profiles.length);
  ok('and it was committed', COMMITS === 1 && ROLLBACKS === 0, { COMMITS, ROLLBACKS });
  // 🔒 raw_json must agree with the typed columns, or the row looks right in admin and misbehaves at
  // checkout - CLAUDE.md records that exact failure.
  const accRaw = JSON.parse(ROWS.inventory_accounts[0].params[7]);
  ok('the account raw_json carries the sheet headers', accRaw.AccountID === 'NFLX-99' && accRaw.LoginId === 'a@b.com' && accRaw.IsActive === 'TRUE', accRaw);
  const capRaw = JSON.parse(ROWS.inventory_capacity[0].params[6]);
  ok('the capacity raw_json agrees with its columns', capRaw.MaxTotal === 5 && capRaw.AccountID === 'NFLX-99', capRaw);
  const p1 = JSON.parse(ROWS.inventory_profiles[0].params[7]);
  ok('profile 1 is stored as the sharing one', p1.ProfileType === 'SHARING_RESERVED' && p1.IsReserved === 'True', p1);
  const p2 = JSON.parse(ROWS.inventory_profiles[1].params[7]);
  ok('profile 2 is stored as private', p2.ProfileType === 'PRIVATE_ROTATING' && p2.IsReserved === 'False', p2);
  ok('every profile starts FREE', ROWS.inventory_profiles.every((x) => JSON.parse(x.params[7]).Status === 'FREE'));
  // 🔒 The change log names the account. It must never name the password.
  ok('the change log records it', AUDIT.length === 1 && /NFLX-99/.test(AUDIT[0].summary), AUDIT[0]);
  ok('…and the password is nowhere in it', JSON.stringify(AUDIT).indexOf(SECRET) < 0, JSON.stringify(AUDIT).slice(0, 200));
  // It IS written to the row, of course - that is the point of the form. Just never to the log.
  ok('the password did reach the account row', ROWS.inventory_accounts[0].params.indexOf(SECRET) >= 0);

  section('🔒 everything, or nothing');
  reset();
  ROWS.plans = [{ service: 'Netflix', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) }];
  FAIL_ON = 'INSERT INTO inventory_profiles';            // the third table falls over
  r = await call('POST /admin/api/account/create', Object.assign({}, base, { confirm: true }));
  ok('it says no', !r.body.ok, r.body);
  ok('…and says nothing was created', /Nothing was created/i.test((r.body.problems || []).join(' ')), r.body.problems);
  ok('it rolled back rather than committing', ROLLBACKS === 1 && COMMITS === 0, { COMMITS, ROLLBACKS });

  section('warnings are said once, then the owner decides');
  reset();
  ROWS.plans = [{ service: 'Prime Video', raw_json: JSON.stringify({ AllocationPolicy: 'CAPACITY' }) }];
  const risky = { service: 'Prime Video', accountId: 'PRI-77', login: 'c@d.com', password: 'y', maxTotal: 5, maxTv: 3 };
  r = await call('POST /admin/api/account/create', risky);
  ok('the third TV stops it the first time', !r.body.ok && r.body.needsConfirm === true, r.body);
  ok('and nothing was written', ROWS.inventory_accounts.length === 0);
  r = await call('POST /admin/api/account/create', Object.assign({}, risky, { confirm: true }));
  ok('saying yes creates it', r.body.ok === true, r.body);
  ok('a device account gets no profiles', ROWS.inventory_profiles.length === 0);

  section('deleting one - only while nobody is on it');
  reset();
  ROWS.inventory_accounts = [{}]; ROWS.inventory_capacity = [{}]; ROWS.inventory_profiles = [{}, {}];
  ROWS.subscriptions = [{ sub_id: 'SUB-1' }];
  r = await call('POST /admin/api/account/remove', { service: 'Netflix', accountId: 'NFLX-99' });
  ok('a customer on it means no', !r.body.ok && /subscription/i.test(r.body.message), r.body);
  ok('…and nothing was deleted', ROWS.inventory_accounts.length === 1 && ROWS.inventory_profiles.length === 2);
  ROWS.subscriptions = [];
  r = await call('POST /admin/api/account/remove', { service: 'Netflix', accountId: 'NFLX-99' });
  ok('an untouched one goes', r.body.ok === true, r.body);
  ok('all three tables are cleared', !ROWS.inventory_accounts.length && !ROWS.inventory_capacity.length && !ROWS.inventory_profiles.length);
  ok('it is in the change log too', AUDIT.some((e) => e.action === 'account.remove'));

  console.log('\n---------------------------------------');
  console.log('new-account: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
