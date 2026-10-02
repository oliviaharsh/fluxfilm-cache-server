/* 📺 Activate my TV — the queue (primetv.js).
 *
 * Owner, 3 Oct 2026: *"can we not just start building a system which does that... test it with one customer
 * who wants to login on tv"*. So this is Phase 1: the customer types the code off their TV into the shop, it
 * is queued against the account they are ALREADY on, and the owner registers it. The private worker replaces
 * the owner later without any of this changing.
 *
 * What is worth protecting, and what most of the locked tests below are about:
 *   · the customer never names an account — it comes from their own subscription row
 *   · the gate is Get OTP's, not a second one written specially for this
 *   · the code is never logged, and never left in the database after the row is finished
 *   · nothing is reported as registered that was not seen to be registered
 *
 * Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ── a database that is just rows in memory ────────────────────────────────────────────────────────────────
let SUBS, TVROWS, SQL, NEXT_ID, TABLE_MISSING;
const reset = () => {
  SUBS = [
    { sub_id: 'S-TV', service: 'Prime Video', inventory_ref: 'PRI-13', device_type: 'TV', device_count: 1, tv_count: 1 },
    { sub_id: 'S-PHONE', service: 'Prime Video', inventory_ref: 'PRI-20', device_type: 'NON_TV', device_count: 1, tv_count: 0 },
    { sub_id: 'S-NFLX', service: 'Netflix', inventory_ref: 'NFLX-1', device_type: '', device_count: 1, tv_count: 0 },
    { sub_id: 'S-NOACC', service: 'Prime Video', inventory_ref: '', device_type: 'TV', device_count: 1, tv_count: 1 },
  ];
  TVROWS = []; SQL = []; NEXT_ID = 1; TABLE_MISSING = false;
};
const noTable = () => { const e = new Error("Table 'u.tv_activations' doesn't exist"); return e; };

const db = {
  query: async (sql, params) => {
    SQL.push({ sql, params });
    const p = params || [];
    if (/FROM tv_activations/.test(sql) || /INTO tv_activations/.test(sql) || /UPDATE tv_activations/.test(sql)) {
      if (TABLE_MISSING) throw noTable();
    }
    if (/SELECT 1 FROM tv_activations/.test(sql)) return [{ 1: 1 }];
    if (/FROM subscriptions WHERE sub_id IN/.test(sql)) return SUBS.filter((s) => p.indexOf(s.sub_id) >= 0);
    if (/INSERT INTO tv_activations/.test(sql)) {
      TVROWS.push({ id: NEXT_ID++, sub_id: p[0], account_id: p[1], phone_norm: p[2], service: p[3], code: p[4], status: p[5], created_at: p[6], why: null, device_name: null, finished_at: null });
      return { affectedRows: 1 };
    }
    if (/UPDATE tv_activations SET status = 'EXPIRED'/.test(sql)) {
      let n = 0;
      for (const r of TVROWS) {
        if (r.status !== 'PENDING') continue;
        if (/sub_id = \?/.test(sql) && r.sub_id !== p[2]) continue;
        if (/created_at < \?/.test(sql) && !(r.created_at < p[2])) continue;
        r.status = 'EXPIRED'; r.code = ''; r.why = p[0]; n++;
      }
      return { affectedRows: n };
    }
    if (/UPDATE tv_activations SET status = 'DONE'/.test(sql)) {
      const r = TVROWS.find((x) => x.id === p[2] && ['PENDING', 'CLAIMED'].indexOf(x.status) >= 0);
      if (!r) return { affectedRows: 0 };
      r.status = 'DONE'; r.code = ''; r.device_name = p[0]; r.finished_at = p[1];
      return { affectedRows: 1 };
    }
    if (/UPDATE tv_activations SET status = 'FAILED'/.test(sql)) {
      const r = TVROWS.find((x) => x.id === p[2] && ['PENDING', 'CLAIMED'].indexOf(x.status) >= 0);
      if (!r) return { affectedRows: 0 };
      r.status = 'FAILED'; r.code = ''; r.why = p[0]; r.finished_at = p[1];
      return { affectedRows: 1 };
    }
    if (/SELECT id FROM tv_activations WHERE status = 'PENDING'/.test(sql)) {
      const next = TVROWS.filter((r) => r.status === 'PENDING').sort((a, b) => a.id - b.id)[0];
      return next ? [{ id: next.id }] : [];
    }
    if (/UPDATE tv_activations SET status = 'CLAIMED'/.test(sql)) {
      // 🔒 Honour the WHERE clause AS WRITTEN. The first version of this fake applied the PENDING guard
      // itself, so the test passed even with the guard deleted from the SQL — a fixture doing the work it is
      // supposed to be checking. A test that cannot fail is worse than no test.
      const guarded = /AND status = 'PENDING'/.test(sql);
      const r = TVROWS.find((x) => x.id === p[2] && (!guarded || x.status === 'PENDING'));
      if (!r) return { affectedRows: 0 };
      r.status = 'CLAIMED'; r.claimed_at = p[0]; r.claimed_by = p[1];
      return { affectedRows: 1 };
    }
    if (/UPDATE tv_activations SET status = 'PENDING'/.test(sql)) {
      let n = 0;
      for (const r of TVROWS) { if (r.status === 'CLAIMED' && r.claimed_at < p[0]) { r.status = 'PENDING'; r.claimed_at = null; r.claimed_by = null; n++; } }
      return { affectedRows: n };
    }
    if (/SELECT id, sub_id, account_id, service, code FROM tv_activations WHERE id/.test(sql)) {
      const r = TVROWS.find((x) => x.id === p[0]);
      return r ? [r] : [];
    }
    if (/SELECT COUNT\(\*\) n FROM tv_activations/.test(sql)) {
      return [{ n: TVROWS.filter((r) => r.sub_id === p[0] && !(r.status === 'EXPIRED' && r.why === p[2])).length }];
    }
    if (/SELECT status, why, device_name/.test(sql)) {
      const mine = TVROWS.filter((r) => r.phone_norm === p[0]);
      return mine.length ? [mine[mine.length - 1]] : [];
    }
    if (/t.status = 'PENDING'/.test(sql)) return TVROWS.filter((r) => r.status === 'PENDING');
    if (/status <> 'PENDING'/.test(sql)) return TVROWS.filter((r) => r.status !== 'PENDING');
    return [];
  },
};

// ── the access gate, faked at its own boundary ────────────────────────────────────────────────────────────
let ACCESS, UNLOCKED;
const access = {
  checkGetOtp: async () => ACCESS,
  unlockedForToken: async () => UNLOCKED,
};

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './db') return db;
  if (req === './otpaccess') return access;
  return origLoad.apply(this, arguments);
};
const primetv = require(path.join(__dirname, '..', 'primetv.js'));
Module._load = origLoad;

const LOGS = [];
const realLog = console.log;

const sub = (rows) => ({ rows });
const okAccess = { ok: true, eh: 'hash' };

// primetv requires ./otpaccess lazily, INSIDE the call — so restoring Module._load before calling it would
// hand the real module back. (Same trap as about-figures earlier today.) The module takes injected deps for
// exactly this reason, and injecting is the honest seam anyway: it is what the server would override.
const submit = (ph, tok, code, ref, extra) => primetv.submit(ph, tok, code, ref || '', Object.assign({ access: access }, extra || {}));
const mine = (ph, tok) => primetv.mine(ph, tok, { access: access });

(async () => {
  // ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────
  section('🔒 who may ask');
  reset(); primetv._internal.reset();
  ACCESS = { ok: false, needsVerify: true, message: 'Confirm your email first.' };
  UNLOCKED = [];
  let r = await submit('9000000001', 'tok', 'ABC123');
  ok('a device that has not proved an email is refused', r.queued === false && r.why === 'locked' && r.needsVerify === true, r);
  ok('…and nothing was queued', TVROWS.length === 0);

  ACCESS = okAccess;
  UNLOCKED = [sub([{ sub_id: 'S-NFLX', order_id: 'O1' }])];
  r = await submit('9000000001', 'tok', 'ABC123');
  ok('a Netflix customer gets no Prime TV activation', r.queued === false && r.why === 'noplan', r);

  UNLOCKED = [sub([{ sub_id: 'S-PHONE', order_id: 'O2' }])];
  r = await submit('9000000001', 'tok', 'ABC123');
  ok('🔒 a Prime plan WITHOUT a TV slot is refused — the slot is what was paid for',
    r.queued === false && r.why === 'notv', r);

  UNLOCKED = [sub([{ sub_id: 'S-NOACC', order_id: 'O3' }])];
  r = await submit('9000000001', 'tok', 'ABC123');
  ok('a plan not yet allocated to an account is refused rather than guessed at', r.queued === false && r.why === 'noaccount', r);

  section('the code itself');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O4' }])];
  for (const bad of ['', '  ', 'ab', '12345678901234']) {
    r = await submit('9000000001', 'tok', bad);
    ok('"' + bad + '" is not a code', r.queued === false && r.why === 'badcode', { bad, r: r.why });
  }
  ok('people type it with spaces and dashes, as it looks on the TV', primetv._internal.cleanCode(' a1b-2 c3 ') === 'A1B2C3');

  // ── the happy path ────────────────────────────────────────────────────────────────────────────────────────
  section('a real request');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O5' }])];
  r = await submit('9000000001', 'tok', 'a1b2c3');
  ok('it is queued', r.queued === true && /registering your TV/i.test(r.message), r);
  ok('🔒 against the account from THEIR OWN subscription row — nothing they sent chose it',
    TVROWS.length === 1 && TVROWS[0].account_id === 'PRI-13' && TVROWS[0].sub_id === 'S-TV', TVROWS[0]);
  ok('the code is stored upper-cased and stripped', TVROWS[0].code === 'A1B2C3', TVROWS[0].code);
  ok('it starts PENDING', TVROWS[0].status === 'PENDING');

  section('🔒 the code never reaches a log');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O6' }])];
  LOGS.length = 0;
  console.log = (...a) => { LOGS.push(a.join(' ')); };
  await submit('9000000001', 'tok', 'SECRET9');
  console.log = realLog;
  ok('it logged that something was queued', LOGS.some((l) => /primetv/.test(l)), LOGS);
  ok('🔒 …and the code is not in any of it', !LOGS.some((l) => /SECRET9/.test(l)), LOGS);

  section('one code at a time per plan');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O7' }])];
  await submit('9000000001', 'tok', 'AAA111');
  await submit('9000000001', 'tok', 'BBB222');
  ok('the older code is retired, not left in the owner\'s queue twice',
    TVROWS.filter((x) => x.status === 'PENDING').length === 1, TVROWS.map((x) => x.status));
  ok('…and the one left is the new one', TVROWS.find((x) => x.status === 'PENDING').code === 'BBB222');
  ok('🔒 the retired row keeps no code', TVROWS.find((x) => x.status === 'EXPIRED').code === '');

  section('a flood is stopped');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O8' }])];
  let last;
  for (let i = 0; i < primetv.PER_SUB_DAY + 2; i++) last = await submit('9000000001', 'tok', 'C0DE' + i);
  ok('after the daily cap it is refused with a reason', last.queued === false && last.why === 'quota', last);

  section('a code that nobody got to');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O9' }])];
  const t0 = Date.now();
  await submit('9000000001', 'tok', 'OLD111', '', { now: t0 });
  await primetv.expireStale(t0 + (primetv.STALE_MIN + 1) * 60e3);
  ok('is marked expired once it cannot possibly work', TVROWS[0].status === 'EXPIRED', TVROWS[0]);
  ok('🔒 and the dead code is cleared out of the database', TVROWS[0].code === '', TVROWS[0]);

  section('what the customer sees while waiting');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O10' }])];
  await submit('9000000001', 'tok', 'DDD444');
  let m = await mine('9000000001', 'tok');
  ok('their own request is reported back', m.found === true && m.status === 'PENDING', m);
  ok('🔒 the reply never carries the code back out', !/DDD444/.test(JSON.stringify(m)), m);
  ACCESS = { ok: false, needsVerify: true };
  m = await mine('9000000001', 'tok');
  ok('🔒 an unproved device is told nothing about anybody\'s activation', m.found === false, m);

  // ── before the migration ──────────────────────────────────────────────────────────────────────────────────
  section('🔒 before db/schema-v35.sql has been run');
  reset(); primetv._internal.reset();
  TABLE_MISSING = true;
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'O11' }])];
  let threw = false;
  try {
    r = await submit('9000000001', 'tok', 'EEE555');
    m = await mine('9000000001', 'tok');
  } catch (e) { threw = true; }
  ok('nothing throws', !threw);
  ok('…it just says it is not ready, so the storefront draws no tool', r.ready === false && m.ready === false, { r, m });

  // -- the worker's claim ----------------------------------------------------------------------------------
  section('a worker takes a job');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'W1' }])];
  await submit('9000000001', 'tok', 'JOB111');
  let c = await primetv.claim('laptop');
  ok('it gets the waiting job, with the code', c.job && c.job.code === 'JOB111' && c.job.accountId === 'PRI-13', c.job);
  ok('the row is marked as held, and by whom', TVROWS[0].status === 'CLAIMED' && TVROWS[0].claimed_by === 'laptop', TVROWS[0]);

  section('LOCKED two workers can never take the same code');
  ok('the second one gets nothing', (await primetv.claim('vps')).job === null);
  ok('...and the row is still held by the first', TVROWS[0].claimed_by === 'laptop', TVROWS[0]);

  section('LOCKED two workers asking at the SAME MOMENT');
  // Sequentially the second worker's SELECT simply finds nothing, so the guard on the UPDATE is never
  // exercised — the first version of this test passed with the guard deleted. The race only exists when both
  // workers read the queue before either writes to it, so both must be in flight at once.
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'W1b' }])];
  await submit('9000000001', 'tok', 'RACE11');
  const both = await Promise.all([primetv.claim('one'), primetv.claim('two')]);
  const got = both.filter((x) => x.job);
  ok('LOCKED exactly one of them gets it - the UPDATE is the lock, not the SELECT',
    got.length === 1, both.map((x) => (x.job ? x.job.id : null)));
  ok('...and the code was handed out once', TVROWS.filter((r) => r.status === 'CLAIMED').length === 1, TVROWS);

  section('LOCKED a worker that dies does not strand the customer');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'W2' }])];
  const tA = Date.now();
  await submit('9000000001', 'tok', 'JOB222', '', { now: tA });
  await primetv.claim('laptop', { now: tA });
  ok('held', TVROWS[0].status === 'CLAIMED');
  await primetv.reapClaims(tA + (primetv.CLAIM_STUCK_MIN + 1) * 60e3);
  ok('after it goes quiet the job returns to the queue', TVROWS[0].status === 'PENDING' && !TVROWS[0].claimed_by, TVROWS[0]);
  ok('LOCKED the code survives the round trip - reaping must not destroy the thing the job needs',
    TVROWS[0].code === 'JOB222', TVROWS[0].code);
  const again = await primetv.claim('laptop', { now: tA + (primetv.CLAIM_STUCK_MIN + 1) * 60e3 });
  ok('so another worker can pick it up', again.job && again.job.code === 'JOB222', again.job);

  section('finishing a claimed job');
  reset(); primetv._internal.reset();
  ACCESS = okAccess; UNLOCKED = [sub([{ sub_id: 'S-TV', order_id: 'W3' }])];
  await submit('9000000001', 'tok', 'JOB333');
  const held = await primetv.claim('laptop');
  const done = await db.query("UPDATE tv_activations SET status = 'DONE', code = '', device_name = ?, why = NULL, finished_at = ? WHERE id = ? AND status IN ('PENDING', 'CLAIMED')", ['Fire TV Stick', new Date(), held.job.id]);
  ok('a CLAIMED row can be marked done - the worker holds it, not the owner', done.affectedRows === 1, done);
  ok('the device name is kept, because removal will need it', TVROWS[0].device_name === 'Fire TV Stick', TVROWS[0]);
  ok('LOCKED and the code is gone', TVROWS[0].code === '', TVROWS[0]);

  // ── 🔒 the customer must never read the worker's notes ──────────────────────────────────────────────
  // mine() hands why straight to the storefront. Before this, a customer whose code landed on a signed-out
  // profile read "the browser is signed out of this account" on their phone - a note written for the owner,
  // which tells them nothing except that something of ours is broken.
  section("the worker's voice and the customer's are not the same voice");
  const WW = primetv.WORKER_WHY;
  const INTERNAL = /browser|worker|amazon|device list|registration box|security check|signed out of this account/i;
  Object.keys(WW).forEach((c) => {
    ok('owner and customer are told different things: ' + c, WW[c].owner !== WW[c].customer, WW[c]);
    ok('nothing internal reaches the customer: ' + c, !INTERNAL.test(WW[c].customer), WW[c].customer);
    ok('the raw code never reaches them either: ' + c, primetv.customerWhy(c).indexOf('worker:') < 0, primetv.customerWhy(c));
    ok('the owner still gets the real sentence: ' + c, primetv.ownerWhy(c) === WW[c].owner);
  });
  ok("the owner's own typing passes through untouched",
    primetv.customerWhy('the code had already expired') === 'the code had already expired');
  ok('…and so does an expiry we wrote ourselves', primetv.customerWhy(primetv.WHY_STALE) === primetv.WHY_STALE);

  reset(); primetv._internal.reset();
  ACCESS = okAccess;
  TVROWS.push({ id: 90, sub_id: 'S-TV', account_id: 'PRI-13', phone_norm: '9000000001', service: 'Prime Video',
    code: '', status: 'FAILED', why: 'worker:signedout', device_name: null, created_at: new Date(), finished_at: new Date() });
  const seen = await mine('9000000001', 'tok');
  ok('a signed-out profile is not made the customer problem', seen.why === WW['worker:signedout'].customer, seen);
  ok('…and no note of ours survives in it', !INTERNAL.test(seen.why), seen.why);

  // 🔒 The guard that stops this returning: read what the worker ACTUALLY posts, not what we remember.
  // A new internal sentence added to the worker later fails here rather than on somebody's phone.
  section('every reason the worker posts is fit to be read by a customer');
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'tvworker.js'), 'utf8');
  const posted = (src.match(/why: '[^']+'/g) || []).map((m) => m.slice(6, -1));
  ok('the worker does post reasons, so this is actually checking something', posted.length >= 5, posted);
  // 🔒 Wider, and the one that actually holds: every worker: code ANYWHERE in the worker, however it is
  // returned, must have a translation. A ternary, a variable or a helper hides a code from the narrow scan
  // above, and a code with no translation is shown to the customer raw.
  const codes = Array.from(new Set(src.match(/'worker:[a-z]+'/g) || [])).map((m) => m.slice(1, -1));
  ok('the worker does use codes, so this is checking something', codes.length >= 6, codes);
  codes.forEach((code) => {
    ok('every code the worker can emit has a translation: ' + code, !!WW[code], code);
    ok('…and the customer is not shown the code itself: ' + code, primetv.customerWhy(code).indexOf('worker:') < 0);
  });

  posted.forEach((why) => {
    if (why.indexOf('worker:') === 0) {
      ok('a posted code has a translation: ' + why, !!WW[why], why);
    } else {
      ok('a posted sentence is plain customer English: ' + why.slice(0, 45), !INTERNAL.test(why), why);
    }
  });

  section('nothing waiting');
  reset(); primetv._internal.reset();
  ok('the worker is told so plainly rather than given a half job', (await primetv.claim('laptop')).job === null);

  console.log('\n---------------------------------------');
  console.log('prime-tv: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log = realLog; console.log('CRASH', e); process.exitCode = 1; });
