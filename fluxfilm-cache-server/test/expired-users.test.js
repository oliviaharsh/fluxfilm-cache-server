/* "Expired customers still on accounts" = the legacy Sheet DASHBOARD rule (expiredusers.js) + the one-tap
 * "tick all subscriptions of this order removed" tool (adminexpired.js). Run: npm test
 *
 * test/fixtures/expired-accounts.json is an anonymised copy of the live Netflix rows on 2026-09-15 (fake names,
 * phones, logins and ids). The Sheet said 15 to remove on 9 accounts; the old admin query said 21. */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const E = require('../expiredusers');
const FX = require('./fixtures/expired-accounts.json');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const NOW = E.toMs(FX.now);
const withTestsRemoved = () => FX.subs.map((x) => (/^FF-TEST-/.test(x.order_id) ? Object.assign({}, x, { removed: 1 }) : x));
const perAccount = (r) => { const o = {}; for (const [k, v] of Object.entries(r.byAccount)) if (v.pending) o[k] = v.pending; return o; };
const same = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

section('live copy vs the Sheet DASHBOARD');
{
  const r = E.compute({ subs: withTestsRemoved(), accounts: FX.accounts, now: NOW });
  ok('after ticking the owner test orders removed: Netflix = 15, like the Sheet', r.main.pending === FX.sheetTotal && r.main.byFamily.Netflix === 15, r.main.byFamily);
  ok('per account exactly the Sheet numbers (D3 2, D5 3, D1 1, H4 1, H3 2, H2 2, H1 1, D8 2, D4 1)', same(perAccount(r), FX.sheetPendingByAccount), perAccount(r));
  ok('9 accounts to fix', r.main.accountsToFix === 9, r.main.accountsToFix);
  ok('accounts nobody active uses are "safe" and not counted', r.main.safeAccounts >= 3 && r.main.groups.filter((g) => g.action === 'SAFE').every((g) => g.activeCount === 0), r.main.groups.filter((g) => g.action === 'SAFE').map((g) => [g.accountIds, g.count]));
  const before = E.compute({ subs: FX.subs, accounts: FX.accounts, now: NOW });
  ok('before the cleanup the 2 owner test subs still count (17)', before.main.pending === 17, before.main.pending);

  // Mutations of the rule must change the result (proves each part is tested by the live copy).
  const idle = r.main.groups.filter((g) => g.action === 'SAFE').reduce((n, g) => n + g.count, 0);
  ok('mutation: without the "account still in use" condition the total is wrong', r.main.pending + idle !== 15 && idle > 0, idle);
  // On D1 the owner's own test sub expired while the same phone has a newer active sub on that login (a renewal):
  // even before the cleanup it must not count. Drop that active row and it counts → D1 becomes 2.
  ok('renewal rule: before the cleanup D1 is still the Sheet\'s 1 (the renewed test sub is skipped)', before.byAccount['NFLX-D1'].pending === 1, before.byAccount['NFLX-D1']);
  const d1Expired = FX.subs.filter((x) => x.inventory_ref.indexOf('NFLX-D1#') === 0 && E.toMs(x.expiry_date) < NOW && !x.removed).map((x) => x.phone_norm);
  const renewing = (y) => y.inventory_ref.indexOf('NFLX-D1#') === 0 && y.status === 'ACTIVE' && E.toMs(y.expiry_date) > NOW && d1Expired.includes(y.phone_norm);
  const unrenewed = E.compute({ subs: FX.subs.filter((y) => !renewing(y)), accounts: FX.accounts, now: NOW });
  ok('mutation: without the renewal the old row counts again (D1 = 2)', FX.subs.filter(renewing).length === 1 && unrenewed.byAccount['NFLX-D1'].pending === 2, unrenewed.byAccount['NFLX-D1']);
  const capped = withTestsRemoved().filter((x) => !(E.toMs(x.expiry_date) < NOW - 60 * 86400e3));
  const rc = E.compute({ subs: capped, accounts: FX.accounts, now: NOW });
  ok('no 60-day cap: the old 60-day window would lose old users (safe list shrinks)', rc.main.safeOldUsers < r.main.safeOldUsers, [rc.main.safeOldUsers, r.main.safeOldUsers]);
}

section('rule details');
{
  const now = E.toMs('2026-09-15 12:00:00');
  const sub = (o) => Object.assign({ status: 'EXPIRED', removed: 0, service: 'Netflix', plan: 'Sharing 1M', expiry_date: '2026-09-01 10:00:00' }, o);
  const act = (o) => sub(Object.assign({ status: 'ACTIVE', expiry_date: '2026-10-01 10:00:00' }, o));
  const accounts = [{ account_id: 'NF-1', login_id: 'One@X ', service: 'Netflix' }, { account_id: 'NF-2', login_id: 'one@x', service: 'Netflix (Group Offer)' }, { account_id: 'PR-1', login_id: 'p@x', service: 'Prime Video' }, { account_id: 'PS-1', login_id: 's@x', service: 'Prime Video + Shopping' }, { account_id: 'Z5-1', login_id: 'z@x', service: 'Zee5 Premium' }, { account_id: 'CR-1', login_id: 'c@x', service: 'Crunchyroll' }];
  const subs = [
    act({ sub_id: 'A1', phone_norm: '9000000001', inventory_ref: 'NF-1#P1' }),
    sub({ sub_id: 'X1', phone_norm: '9000000002', inventory_ref: 'NF-2#P3', expiry_date: '2025-01-01 10:00:00', name: 'Very Old' }), // other account ID, same login, 1.5 years ago
    sub({ sub_id: 'X2', phone_norm: '9000000003', inventory_ref: 'NF-1#P2', removed: 1 }),        // ticked removed
    sub({ sub_id: 'X3', phone_norm: '9000000004', inventory_ref: 'NF-1#P2', status: 'REFUNDED' }), // refunded
    sub({ sub_id: 'X4', phone_norm: '9000000005', inventory_ref: 'NF-1#P4' }),
    act({ sub_id: 'A2', phone_norm: '9000000006', inventory_ref: 'NF-1#P4', renew_sub_id: 'X5' }),
    sub({ sub_id: 'X5', phone_norm: '9000000099', inventory_ref: 'NF-1#P4' }),                     // renewed via renew_sub_id
    act({ sub_id: 'P1', phone_norm: '9000000007', service: 'Prime Video', inventory_ref: 'PR-1' }),
    sub({ sub_id: 'P2', phone_norm: '9000000008', service: 'Prime Video', inventory_ref: 'PR-1' }),
    sub({ sub_id: 'S1', phone_norm: '9000000009', service: 'Prime Video + Shopping', inventory_ref: 'PS-1' }), // nobody active
    act({ sub_id: 'Z1', phone_norm: '9000000010', service: 'Zee5 Premium', inventory_ref: 'Z5-1' }),
    sub({ sub_id: 'Z2', phone_norm: '9000000011', service: 'Zee5 Premium', inventory_ref: 'Z5-1' }),
    act({ sub_id: 'C1', phone_norm: '9000000012', service: 'Crunchyroll', inventory_ref: 'CR-1#P1' }),
    sub({ sub_id: 'C2', phone_norm: '9000000013', service: 'Crunchyroll', inventory_ref: 'CR-1#P2' }),
    sub({ sub_id: 'M1', phone_norm: '9000000014', service: 'YouTube Premium' }),                    // never on an account
    act({ sub_id: 'G1', phone_norm: '9000000015', service: 'Netflix', inventory_ref: 'NF-9#P1', status: 'ACTIVE', expiry_date: '2026-09-15 11:59:00' }), // expired a minute ago, status not flipped
  ];
  const r = E.compute({ subs, accounts, now, policyOf: { crunchyroll: 'PROFILE' } });
  const nf = r.main.groups.find((g) => g.family === 'Netflix' && g.login === 'one@x');
  ok('one login under two account IDs (NF-1 + NF-2 Group Offer) is ONE account', nf && nf.accountIds.join() === 'NF-1,NF-2', nf);
  ok('pending: very old (no day cap) + plain expired; not removed / refunded / renewed', nf && nf.count === 2 && nf.people.map((p) => p.subId).sort().join() === 'X1,X4' && nf.action === 'REMOVE', nf && nf.people);
  ok('names come with the list', nf && nf.people.some((p) => p.name === 'Very Old'));
  ok('Prime Video account with an active user: remove 1', r.main.byFamily['Prime Video'] === 1 && r.byAccount['PR-1'].pending === 1);
  const ps = r.main.groups.find((g) => g.accountIds[0] === 'PS-1');
  ok('Prime Video + Shopping is in the main list; nobody active → SAFE, not counted', ps && ps.action === 'SAFE' && ps.count === 1 && r.byAccount['PS-1'].oldUsers === 1 && r.byAccount['PS-1'].pending === 0, ps);
  ok('Zee5 and Crunchyroll (even with PROFILE policy) go to the separate section', r.other.pending === 2 && r.other.byFamily['Zee5 Premium'] === 1 && r.other.byFamily.Crunchyroll === 1 && !r.main.groups.some((g) => /zee5|crunchy/i.test(g.family)), r.other);
  ok('Today number = main list only (Netflix 2 + Prime 1)', r.main.pending === 3, r.main.pending);
  ok('status ACTIVE but already past expiry is expired, not "active"', r.byAccount['NF-9'] && r.byAccount['NF-9'].hasActive === false && r.byAccount['NF-9'].oldUsers === 1, r.byAccount['NF-9']);
  ok('Today card lines', E.todayNames(r).join(' | ') === 'NF-1/NF-2 · remove 2: …0005, Very Old | PR-1 · remove 1: …0008', E.todayNames(r));
  const sameCust = E.compute({ now, accounts, subs: [act({ sub_id: 'N1', phone_norm: '9000000020', inventory_ref: 'NF-1#P5' }), sub({ sub_id: 'O1', phone_norm: '9000000020', inventory_ref: 'NF-1#P1' })] });
  ok('same customer active again on the same login (moved profile) → old row not pending', sameCust.main.pending === 0 && sameCust.main.groups.length === 0, sameCust.main);
  ok('the SQL reads only active + expired-not-removed rows with an account', /expiry_date < NOW\(\) AND COALESCE\(s.removed, 0\) = 0/.test(E.SUBS_SQL) && !/INTERVAL 60 DAY/.test(E.SUBS_SQL));

  // 🚪 Remove users: one set of numbers with explicit units (customers vs accounts vs safe vs other services).
  const c = E.summarize(r);
  ok('summarize: 3 customers on 2 accounts to log out (customers ≠ accounts)', c.customers === 3 && c.accounts === 2, c);
  ok('summarize: safe accounts + their old users are separate (2 accounts, 2 old users) and not in customers', c.safeAccounts === 2 && c.safeUsers === 2, c);
  ok('summarize: per family customers + accounts', c.byFamily.Netflix.customers === 2 && c.byFamily.Netflix.accounts === 1 && c.byFamily['Prime Video'].customers === 1 && c.byFamily['Prime Video'].accounts === 1 && !c.byFamily['Zee5 Premium'], c.byFamily);
  ok('summarize: other services on their own (2 customers on 2 accounts)', c.other.customers === 2 && c.other.accounts === 2 && c.other.safeAccounts === 0, c.other);
  ok('summarize = the Today number (main.pending) and main.accountsToFix', c.customers === r.main.pending && c.accounts === r.main.accountsToFix);
  ok('summarize of an empty/failed result is all zeros', JSON.stringify(E.summarize(null)) === JSON.stringify({ customers: 0, accounts: 0, safeAccounts: 0, safeUsers: 0, byFamily: {}, other: { customers: 0, accounts: 0, safeAccounts: 0, safeUsers: 0, byFamily: {} } }), E.summarize(null));
  const very = nf.people.find((p) => p.subId === 'X1');
  ok('person rows carry days since expiry + profile slot', very && very.daysAgo === Math.floor((now - E.toMs('2025-01-01 10:00:00')) / 86400e3) && very.slot === 'Profile 3', very);
  ok('group carries the login as saved (display) and each account ID\'s own service (for 🔑 Password change)', nf.loginLabel === 'One@X' && nf.accountServices['NF-1'] === 'Netflix' && nf.accountServices['NF-2'] === 'Netflix (Group Offer)', [nf.loginLabel, nf.accountServices]);
  ok('slotOf: Prime devices / TV', E.slotOf({ inventory_ref: 'PR-1', device_count: 2, tv_count: 1 }) === '2 devices · 1 TV' && E.slotOf({ inventory_ref: 'PR-1', device_count: 1, device_type: 'TV' }) === '1 device · TV' && E.slotOf({ inventory_ref: 'PR-1' }) === '', [E.slotOf({ inventory_ref: 'PR-1', device_count: 2, tv_count: 1 }), E.slotOf({ inventory_ref: 'PR-1', device_count: 1, device_type: 'TV' })]);
  ok('the SQL also reads device columns for the slot', /s\.device_count, s\.device_type, s\.tv_count/.test(E.SUBS_SQL));
}
{
  const r = E.compute({ subs: withTestsRemoved(), accounts: FX.accounts, now: NOW });
  const c = E.summarize(r);
  ok('live copy: 15 customers on 9 accounts (the Sheet numbers, units explicit)', c.customers === 15 && c.accounts === 9 && c.byFamily.Netflix.customers === 15 && c.byFamily.Netflix.accounts === 9, c);
}

section('admin endpoints: expired list + tick all subscriptions of an order removed');
(async () => {
  const calls = [];
  const subsOf = { FF0215802: { total: 54, already: 0, running: 0, ended: 54 }, FFRUN: { total: 2, already: 0, running: 1, ended: 1 } };
  const mockDb = {
    ENABLED: true,
    query: async (sql, params) => {
      sql = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql, params });
      if ((sql.match(/\?/g) || []).length !== (params || []).length) throw new Error('placeholder count mismatch: ' + sql);
      if (/^SELECT COUNT\(\*\) total/.test(sql)) { const x = subsOf[params[0]]; return [x || { total: 0 }]; }
      if (/^UPDATE subscriptions SET removed = 1/.test(sql) && /WHERE sub_id IN \(/.test(sql)) return { affectedRows: params.filter((id) => !/RUN|DONE/.test(id)).length };
      if (/^UPDATE subscriptions SET removed = 1/.test(sql)) {
        const x = subsOf[params[0]]; if (!x) return { affectedRows: 0 };
        const n = x.ended + (/NOT \(UPPER/.test(sql) ? 0 : x.running);
        x.already += n; x.ended = 0; if (!/NOT \(UPPER/.test(sql)) x.running = 0;
        return { affectedRows: n };
      }
      if (/FROM subscriptions s WHERE/.test(sql)) return [{ sub_id: 'A', service: 'Netflix', status: 'ACTIVE', expiry_date: '2099-01-01 00:00:00', inventory_ref: 'NF-1#P1', login_id: 'l@x', phone_norm: '9000000001' }, { sub_id: 'B', service: 'Netflix', status: 'EXPIRED', expiry_date: '2020-01-01 00:00:00', inventory_ref: 'NF-1#P2', login_id: 'l@x', phone_norm: '9000000002' }];
      if (/FROM inventory_accounts|FROM plans/.test(sql)) return [];
      return { affectedRows: 1 };
    },
    getPool: () => null, ping: async () => ({ ok: true }),
  };
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const x = await fetch(base + p, { headers: H }); return { status: x.status, body: await x.json() }; };
  const post = async (p, b) => { const x = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() }; };
  const tick = () => new Promise((res) => setTimeout(res, 20));
  try {
    let r = await get('/admin/api/expired-users');
    ok('GET expired-users: main list with the account to fix', r.body.ok && r.body.main.pending === 1 && r.body.main.groups[0].people[0].subId === 'B', r.body);
    ok('expired-users needs admin', (await fetch(base + '/admin/api/expired-users')).status === 403);
    r = await get('/admin/api/order/subs-removed?id=ff0215802');
    ok('preview: 54 subscriptions, all ended', r.body.ok && r.body.orderId === 'FF0215802' && r.body.total === 54 && r.body.ended === 54 && r.body.alreadyRemoved === 0, r.body);
    calls.length = 0;
    r = await post('/admin/api/order/subs-removed', { orderId: 'FF0215802' });
    const upd = calls.find((c) => /^UPDATE subscriptions SET removed = 1/.test(c.sql));
    ok('ticks all 54 removed with removed_at = now, raw_json kept in step, skips already removed', r.body.ok && r.body.marked === 54 && upd && /removed_at = NOW\(\)/.test(upd.sql) && /JSON_SET\(raw_json, '\$.RemovedFromDevice', 'TRUE'\)/.test(upd.sql) && /COALESCE\(removed, 0\) = 0/.test(upd.sql) && upd.params[0] === 'FF0215802', { body: r.body, upd });
    await tick();
    ok('  ...and writes one change-log entry', calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'sub.removedBulk' && c.params[2] === 'FF0215802'));
    r = await post('/admin/api/order/subs-removed', { orderId: 'FF0215802' });
    ok('second tap: nothing to do', r.body.ok && r.body.marked === 0 && /already removed/.test(r.body.message), r.body);
    r = await post('/admin/api/order/subs-removed', { orderId: 'FFRUN' });
    ok('running subscriptions are skipped unless asked', r.body.ok && r.body.marked === 1 && r.body.skippedRunning === 1, r.body);
    r = await post('/admin/api/order/subs-removed', { orderId: 'FFNONE' });
    ok('order without subscriptions → 404', r.status === 404);
    r = await post('/admin/api/order/subs-removed', {});
    ok('order id required', r.status === 400);
    const html = await (await fetch(base + '/panel')).text();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
    let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
    ok('panel parses and has the order cleanup button', parsed && /Mark all subscriptions of this order as removed/.test(html));

    // 🚪 Remove users: one API for Today, the new screen and Stock.
    r = await get('/admin/api/remove-users');
    const cnt = r.body.counts || {};
    ok('GET remove-users: ok + list + counts {customers, accounts, safeAccounts, safeUsers, byFamily, other}', r.body.ok && r.body.main.groups.length === 1 && ['customers', 'accounts', 'safeAccounts', 'safeUsers', 'byFamily', 'other'].every((k) => k in cnt) && cnt.customers === 1 && cnt.accounts === 1 && cnt.other.customers === 0, r.body);
    ok('remove-users needs admin', (await fetch(base + '/admin/api/remove-users')).status === 403);
    const alias = await get('/admin/api/expired-users');
    ok('older /expired-users answers the same (with counts)', JSON.stringify(alias.body.counts) === JSON.stringify(cnt) && alias.body.main.pending === 1);
    calls.length = 0;
    r = await post('/admin/api/remove-users/removed', { subIds: ['B', 'C', 'B', ' '], label: 'NF-1' });
    const bulk = calls.find((c) => /^UPDATE subscriptions SET removed = 1/.test(c.sql));
    ok('Remove all on this account: ticks the listed subs (deduped), removed_at = now, raw_json in step', r.body.ok && r.body.marked === 2 && bulk && bulk.params.join() === 'B,C' && /sub_id IN \(\?, \?\)/.test(bulk.sql) && /removed_at = NOW\(\)/.test(bulk.sql) && /RemovedFromDevice', 'TRUE'/.test(bulk.sql), { body: r.body, bulk });
    ok('  ...never touches running or already-removed subscriptions', bulk && /COALESCE\(removed, 0\) = 0/.test(bulk.sql) && /NOT \(UPPER\(COALESCE\(status, ''\)\) = 'ACTIVE' AND expiry_date > NOW\(\)\)/.test(bulk.sql), bulk && bulk.sql);
    await tick();
    ok('  ...one change-log entry naming the account', calls.some((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === 'sub.removedBulk' && c.params[2] === 'NF-1'));
    r = await post('/admin/api/remove-users/removed', { subIds: ['B', 'RUN1'] });
    ok('  ...reports skipped rows', r.body.ok && r.body.marked === 1 && r.body.skipped === 1 && /skipped/.test(r.body.message), r.body);
    ok('  ...needs subIds (400) and at most 100', (await post('/admin/api/remove-users/removed', { subIds: [] })).status === 400 && (await post('/admin/api/remove-users/removed', { subIds: Array.from({ length: 101 }, (_, i) => 'S' + i) })).status === 400);
    ok('  ...needs admin', (await fetch(base + '/admin/api/remove-users/removed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"subIds":["B"]}' })).status === 403);

    section('panel: 🚪 Remove users screen, Today card, Stock');
    ok('sidebar has 🚪 Remove users with its own view (history entry via nav)', /\['removeusers', '🚪', 'Remove users'\]/.test(html) && /removeusers: removeUsersView/.test(html) && /function removeUsersView\(/.test(html));
    ok('screen reads the one API and shows units explicitly', /api\('\/admin\/api\/remove-users'\)/.test(html) && /ruPlural\(c\.customers, 'customer'\) \+ '<\/b> on <b>' \+ ruPlural\(c\.accounts, 'account'\)/.test(html) && /safe to reset/.test(html) && /Other services: <b>/.test(html));
    ok('sections: log out per login (✅ Removed + Remove all), safe → 🔑 Password change, other services collapsed, search', /data-rurm=/.test(html) && /Remove all ' \+ g\.count \+ ' on this account/.test(html) && /\/admin\/api\/remove-users\/removed/.test(html) && /data-rupw=/.test(html) && /nav\('password'\); loadImpact\(\)/.test(html) && /id="ruc"/.test(html) && /id="ruq"/.test(html));
    ok('customer rows: phone masked to last 4, days since expiry, profile/device slot', /'…' \+ esc\(String\(p\.phone\)\.slice\(-4\)\)/.test(html) && /'expired ' \+ ruPlural\(p\.daysAgo, 'day'\) \+ ' ago'/.test(html) && /p\.slot/.test(html));
    ok('Today card shows its subtitle and opens the new screen', /it\.sub && it\.count > 0/.test(html) && /go\.view === 'removeusers'/.test(html));
    ok('Stock: no "Accounts with expired customers" KPI, no 🚪 expired filter/section, old list code gone', !/Accounts with expired customers/.test(html) && !/\['expired', '🚪 Expired customers/.test(html) && !/K\.filter === 'expired'/.test(html) && !/function renderExpiredUsers\(/.test(html) && !/expiredUsers/.test(html));
    ok('Stock links to 🚪 Remove users with the same counts; per-account badge opens it for that account', /d\.removeUsers/.test(html) && /🚪 Remove users' \+ \(ru && ru\.customers/.test(html) && /data-kru="' \+ esc\(a\.accountId\)/.test(html) && /nav\('removeusers'\)/.test(html));
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((res) => server.close(res));
    Module._load = origLoad;
  }
  console.log('\n---------------------------------------');
  console.log('expired-users: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
