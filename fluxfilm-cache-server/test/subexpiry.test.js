/* Plans marked EXPIRED automatically once expiry AND release date have passed; remembered UPI payer name. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

// Tiny SQL evaluator for the one UPDATE (NOW fixed), so the real WHERE clause is what gets tested.
const NOW = '2026-09-14 21:00:00';
const subs = [
  { id: 'ended long ago, released', status: 'ACTIVE', expiry_date: '2026-08-01 00:00:00', release_eligible_at: '2026-08-11 00:00:00' },
  { id: 'ended, no release date (old import)', status: 'active', expiry_date: '2026-09-01 00:00:00', release_eligible_at: null },
  { id: 'ended but still in cooldown (holds the slot)', status: 'ACTIVE', expiry_date: '2026-09-10 00:00:00', release_eligible_at: '2026-09-20 00:00:00' },
  { id: 'still running', status: 'ACTIVE', expiry_date: '2026-10-14 00:00:00', release_eligible_at: '2026-10-24 00:00:00' },
  { id: 'no expiry (manual)', status: 'ACTIVE', expiry_date: null, release_eligible_at: null },
  { id: 'already expired', status: 'EXPIRED', expiry_date: '2026-01-01 00:00:00', release_eligible_at: null },
];
let lastSql = '';
const mockDb = {
  ENABLED: true,
  query: async (sql) => {
    lastSql = sql;
    if (!/^UPDATE subscriptions SET status = 'EXPIRED'/.test(sql)) throw new Error('unexpected ' + sql);
    const where = sql.split(' WHERE ')[1];
    const expected = "UPPER(status) = 'ACTIVE' AND expiry_date IS NOT NULL AND expiry_date < NOW() AND (release_eligible_at IS NULL OR release_eligible_at < NOW())";
    if (where !== expected) throw new Error('WHERE changed — update this test deliberately: ' + where);
    let n = 0;
    for (const x of subs) {
      if (String(x.status).toUpperCase() === 'ACTIVE' && x.expiry_date != null && x.expiry_date < NOW && (x.release_eligible_at == null || x.release_eligible_at < NOW)) { x.status = 'EXPIRED'; n++; }
    }
    return { affectedRows: n };
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const subexpiry = require('../subexpiry');

(async () => {
  const r = await subexpiry.run();
  const st = (id) => subs.find((x) => x.id === id).status;
  ok('ended + released plans marked EXPIRED', st('ended long ago, released') === 'EXPIRED' && st('ended, no release date (old import)') === 'EXPIRED' && r.expired === 2, r);
  ok('a plan still in its cooldown keeps ACTIVE (its slot is not freed early)', st('ended but still in cooldown (holds the slot)') === 'ACTIVE');
  ok('running and no-expiry plans untouched', st('still running') === 'ACTIVE' && st('no expiry (manual)') === 'ACTIVE');
  ok('raw_json status kept in sync', /JSON_SET\(raw_json, '\$\.Status', 'EXPIRED'\)/.test(lastSql));
  ok('same rule as slot occupancy (fulfill.js OCC_ACTIVE is the exact opposite)', /const OCC_ACTIVE = "UPPER\(status\)='ACTIVE' AND \(expiry_date > NOW\(\) OR release_eligible_at > NOW\(\)\)"/.test(fs.readFileSync(path.join(__dirname, '..', 'fulfill.js'), 'utf8')));
  ok('second run changes nothing', (await subexpiry.run()).expired === 0);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server starts the hourly job', /require\('\.\/subexpiry'\)\.startTimer\(\)/.test(srv));
  // The renewal write also sets the plan now (a renewal may change it), so the status check follows those columns.
  ok('renewing an expired plan makes it ACTIVE again (fulfill.js)', /UPDATE subscriptions SET plan = \?, duration_days = \?, device_count = \?, tv_count = \?, expiry_date = \?, new_expiry = \?, order_id = \?, status = 'ACTIVE'/.test(fs.readFileSync(path.join(__dirname, '..', 'fulfill.js'), 'utf8')));

  // Remembered UPI payer name on the backup payment screen.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('name from last payment is pre-filled', /if \(r\.knownName\) \{\s*setKnownName\(r\.knownName\);\s*setName\(r\.knownName\);/.test(html));
  ok('"I\'ve paid" goes straight to the confirm step when a name is remembered', /onClick: \(\) => setPhase\(knownName && name \? 'confirm' : 'form'\)/.test(html));
  ok('confirm step says "same name as last time" and offers Change it / add UTR', /Paying with the same name as last time\?/.test(html) && /✏️ Change it \/ add UTR/.test(html));
  const pm = fs.readFileSync(path.join(__dirname, '..', 'paymatch.js'), 'utf8');
  ok('server returns knownName (typed name first, then learned name)', /knownName = s\(typed\[0\]\.payer_name\)/.test(pm) && /FROM customer_payer_names WHERE phone_norm = \? ORDER BY last_used DESC/.test(pm) && /paid: s\(o\.status\)\.toUpperCase\(\) === 'PAID', knownName,/.test(pm));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
