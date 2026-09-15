/* 🔑 "When was the password last changed" (passwordage.js) on Password change + 🚪 Remove users. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const PA = require('../passwordage');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const DAY = 86400e3;
const ago = (n) => PA.istStamp(Date.now() - n * DAY);

section('helpers');
{
  const stamp = '2026-09-16 10:15:00';
  const prev = Array.from({ length: 12 }, (_, i) => '2026-0' + (1 + (i % 8)) + '-1' + (i % 9) + ' 09:00:00');
  const raw = PA.stampRaw({ Password: 'secret1', LastPassChangedOn: '2026-08-10T18:30:00.000Z', PasswordHistory: prev.concat(['hunter2', { p: 'x' }]) }, stamp);
  ok('stampRaw sets PasswordChangedAt and keeps the other keys', raw.PasswordChangedAt === stamp && raw.Password === 'secret1' && raw.LastPassChangedOn === '2026-08-10T18:30:00.000Z');
  ok('history = last 10 dates, newest last, non-dates (a password) dropped', raw.PasswordHistory.length === 10 && raw.PasswordHistory[9] === stamp && !JSON.stringify(raw.PasswordHistory).includes('hunter2') && !JSON.stringify(raw.PasswordHistory).includes('secret1'), raw.PasswordHistory);
  ok('istStamp is India time', PA.istStamp(Date.UTC(2026, 8, 1, 20, 0, 0)) === '2026-09-02 01:30:00');
  ok('old Sheet ISO date read as the IST day', PA.describe(PA.toMs('2026-08-10T18:30:00.000Z'), 'sheet', Date.UTC(2026, 8, 16, 6)).date === '2026-08-11');
  const d = PA.describe(PA.toMs('2026-09-02 14:00:00'), 'account', PA.toMs('2026-09-16 09:00:00'));
  ok('describe: "2 Sep 2026", short "2 Sep", 14 days ago, not stale', d.label === '2 Sep 2026' && d.short === '2 Sep' && d.days === 14 && d.ago === '14 days ago' && d.stale === false, d);
  ok('today / yesterday / stale after 30 days', PA.describe(Date.now(), 'x').ago === 'today' && PA.describe(Date.now() - DAY, 'x').ago === 'yesterday' && PA.describe(Date.now() - 31 * DAY, 'x').stale === true);
  const audits = PA.auditMap([{ action: 'account.passwordChange', entity_id: 'A1', ts: '2026-09-10 10:00:00', details: '{"accounts":["A1","A1B"]}' }, { action: 'account.passwordChange', entity_id: 'A1', ts: '2026-09-01 10:00:00', details: null }]);
  ok('change log: newest entry per id, every ID on the login', PA.istStamp(audits.get('A1')) === '2026-09-10 10:00:00' && PA.istStamp(audits.get('A1B')) === '2026-09-10 10:00:00');
  ok('resolve order: raw PasswordChangedAt → change log → Sheet LastPassChangedOn → unknown',
    PA.resolve('A1', { PasswordChangedAt: '2026-09-12 08:00:00' }, audits).source === 'account' &&
    PA.resolve('A1', { LastPassChangedOn: '2026-08-10T18:30:00.000Z' }, audits).source === 'changelog' &&
    PA.resolve('ZZ', { LastPassChangedOn: '2026-08-10T18:30:00.000Z' }, audits).source === 'sheet' &&
    PA.resolve('ZZ', { LastPassChangedOn: '' }, audits) === null && PA.resolve('ZZ', null, new Map()) === null);
}

section('admin endpoints');
const ACCOUNTS = [
  { service: 'Netflix', account_id: 'NFLX-H2', login_id: 'h2@x.com', password: 'h2-old', is_active: 'TRUE', raw_json: JSON.stringify({ AccountID: 'NFLX-H2', Password: 'h2-old', LastPassChangedOn: '2026-08-10T18:30:00.000Z' }) },
  { service: 'Netflix', account_id: 'NFLX-D3', login_id: 'd3@x.com', password: 'd3-old', is_active: 'TRUE', raw_json: JSON.stringify({ AccountID: 'NFLX-D3', Password: 'd3-old', LastPassChangedOn: new Date(Date.now() - 40 * DAY).toISOString() }) },
  { service: 'Netflix', account_id: 'NFLX-U1', login_id: 'u1@x.com', password: 'u1-old', is_active: 'TRUE', raw_json: JSON.stringify({ AccountID: 'NFLX-U1', Password: 'u1-old', LastPassChangedOn: '' }) },
  { service: 'Netflix', account_id: 'NFLX-N', login_id: 'n@x.com', password: 'n-old', is_active: 'TRUE', raw_json: null },
];
const AUDIT = [{ id: 7, action: 'account.passwordChange', entity_id: 'NFLX-H2', ts: ago(14), details: JSON.stringify({ accounts: ['NFLX-H2'], activeSubs: [], tickedSubs: [], emailed: 0 }) }];
const future = PA.istStamp(Date.now() + 20 * DAY), past = PA.istStamp(Date.now() - 5 * DAY);
const SUBS = ['NFLX-H2', 'NFLX-D3', 'NFLX-U1'].flatMap((id, i) => [
  { sub_id: 'ACT' + i, order_id: 'FFA' + i, phone_norm: '900000001' + i, service: 'Netflix', plan: 'Private 1M', status: 'ACTIVE', expiry_date: future, inventory_ref: id + '#P1', account_id: id, login_id: '', removed: 0, name: 'Active ' + i },
  { sub_id: 'EXP' + i, order_id: 'FFE' + i, phone_norm: '900000002' + i, service: 'Netflix', plan: 'Private 1M', status: 'EXPIRED', expiry_date: past, inventory_ref: id + '#P2', account_id: id, login_id: '', removed: 0, name: 'Gone ' + i },
]);
const calls = [];
const byLogin = (key, fam) => ACCOUNTS.filter((a) => a.login_id.trim().toLowerCase() === key && a.service.toLowerCase().includes(fam.replace(/%/g, '')));
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim(); params = params || []; calls.push({ sql, params });
    if ((sql.match(/\?/g) || []).length !== params.length) throw new Error('placeholder count mismatch: ' + sql);
    // Never JOIN / compare the change log or accounts with another table in one statement (MariaDB collations).
    if (/\bJOIN\b/i.test(sql) && /audit_log|inventory_accounts|refund_|feed_/.test(sql)) throw new Error('cross-table JOIN not allowed: ' + sql);
    if (/audit_log/.test(sql) && /inventory_accounts|subscriptions|customers/.test(sql)) throw new Error('cross-table query not allowed: ' + sql);
    if (/^SELECT entity_id, details, ts FROM audit_log WHERE action = \?/.test(sql)) return AUDIT.filter((a) => a.action === params[0]);
    if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
    if (/^SELECT account_id, raw_json FROM inventory_accounts WHERE account_id IN/.test(sql)) return ACCOUNTS.filter((a) => params.includes(a.account_id)).map((a) => ({ account_id: a.account_id, raw_json: a.raw_json }));
    if (/^SELECT service, account_id, login_id, password, is_active FROM inventory_accounts WHERE service = \? AND account_id = \?/.test(sql)) return ACCOUNTS.filter((a) => a.service === params[0] && a.account_id === params[1]);
    if (/^SELECT service, account_id, is_active FROM inventory_accounts WHERE LOWER\(TRIM\(login_id\)\) = \?/.test(sql)) return byLogin(params[0], params[1]);
    if (/^SELECT service, account_id, raw_json FROM inventory_accounts WHERE LOWER\(TRIM\(login_id\)\) = \?/.test(sql)) return byLogin(params[0], params[1]).map((a) => ({ service: a.service, account_id: a.account_id, raw_json: a.raw_json }));
    if (/^UPDATE inventory_accounts SET password = \?/.test(sql)) {
      const rows = byLogin(params[2], params[3]);
      for (const a of rows) { a.password = params[0]; if (a.raw_json) { const r = JSON.parse(a.raw_json); r.Password = params[1]; a.raw_json = JSON.stringify(r); } }
      return { affectedRows: rows.length };
    }
    if (/^UPDATE inventory_accounts SET raw_json = \? WHERE service = \? AND account_id = \?/.test(sql)) {
      const a = ACCOUNTS.find((x) => x.service === params[1] && x.account_id === params[2]); if (a) a.raw_json = params[0];
      return { affectedRows: a ? 1 : 0 };
    }
    if (/FROM subscriptions s LEFT JOIN customers c ON c.phone_norm = s.phone_norm WHERE \(s.inventory_ref IN/.test(sql)) {
      return SUBS.filter((x) => params.includes(x.account_id)).map((x) => Object.assign({}, x));
    }
    if (/SwitchHistory/.test(sql)) return [];
    if (/FROM subscriptions s WHERE/.test(sql)) return SUBS.map((x) => Object.assign({}, x));
    if (/^SELECT account_id, login_id, service FROM inventory_accounts$/.test(sql)) return ACCOUNTS.map((a) => ({ account_id: a.account_id, login_id: a.login_id, service: a.service }));
    if (/FROM plans|FROM refund_offers|FROM app_settings|information_schema/.test(sql)) return [];
    return { affectedRows: 1 };
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), tools: { mailer: { sendPasswordChanged: async () => ({ ok: true }) } } });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  try {
    let r = await get('/admin/api/accounts/impact?service=Netflix&account_id=NFLX-H2');
    let d = r.body.account && r.body.account.passwordChangedAt;
    ok('password screen: date falls back to the change-log entry (14 days ago), newer than the old Sheet date', r.body.ok && d && d.source === 'changelog' && d.ago === '14 days ago' && d.date === ago(14).slice(0, 10), r.body.account);
    r = await get('/admin/api/accounts/impact?service=Netflix&account_id=NFLX-D3');
    d = r.body.account.passwordChangedAt;
    ok('  ...old Sheet LastPassChangedOn used when there is no log entry', d && d.source === 'sheet' && d.days === 40 && d.stale === true, d);
    r = await get('/admin/api/accounts/impact?service=Netflix&account_id=NFLX-U1');
    ok('  ...unknown (null) when nothing exists', r.body.ok && r.body.account.passwordChangedAt === null, r.body.account);

    // 🚪 Remove users payload
    r = await get('/admin/api/remove-users');
    const groups = r.body.ok ? r.body.main.groups : [];
    const G = (id) => groups.find((g) => g.accountIds.includes(id));
    ok('remove-users groups carry passwordChangedAt', r.body.ok && groups.length === 3 && G('NFLX-H2').passwordChangedAt.source === 'changelog' && G('NFLX-H2').passwordChangedAt.short.length > 3, r.body);
    ok('  ...stale Sheet date on D3, null (unknown) on U1', G('NFLX-D3').passwordChangedAt.stale === true && G('NFLX-U1').passwordChangedAt === null);

    // Password change writes the date
    calls.length = 0;
    r = await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NFLX-U1', password: 'Brand#New9', tickExpired: true });
    const raw = JSON.parse(ACCOUNTS.find((a) => a.account_id === 'NFLX-U1').raw_json);
    ok('password change writes raw_json.PasswordChangedAt (IST, now) + typed password kept in step', r.body.ok && raw.Password === 'Brand#New9' && ACCOUNTS[2].password === 'Brand#New9' && PA.describe(PA.toMs(raw.PasswordChangedAt), 'x').ago === 'today' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.PasswordChangedAt), raw);
    ok('  ...PasswordHistory has the date and never a password', Array.isArray(raw.PasswordHistory) && raw.PasswordHistory.length === 1 && raw.PasswordHistory[0] === raw.PasswordChangedAt && !JSON.stringify(raw.PasswordHistory).includes('Brand#New9') && !JSON.stringify(raw.PasswordHistory).includes('u1-old'));
    ok('  ...response says today; old Sheet keys untouched', r.body.passwordChangedAt && r.body.passwordChangedAt.ago === 'today' && raw.AccountID === 'NFLX-U1' && raw.LastPassChangedOn === '');
    ok('  ...no password in the change log', calls.some((c) => /^INSERT INTO audit_log/.test(c.sql)) && !calls.filter((c) => /^INSERT INTO audit_log/.test(c.sql)).some((c) => JSON.stringify(c.params).includes('Brand#New9')));
    await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NFLX-U1', password: 'Second#2', tickExpired: false });
    const raw2 = JSON.parse(ACCOUNTS[2].raw_json);
    ok('  ...a second change appends to the history', raw2.PasswordHistory.length === 2 && !JSON.stringify(raw2.PasswordHistory).includes('Second#2'));
    r = await get('/admin/api/accounts/impact?service=Netflix&account_id=NFLX-U1');
    ok('  ...and the password screen now shows today from raw_json', r.body.account.passwordChangedAt && r.body.account.passwordChangedAt.source === 'account' && r.body.account.passwordChangedAt.ago === 'today');
    r = await post('/admin/api/accounts/password-change', { service: 'Netflix', accountId: 'NFLX-N', password: 'Null#raw1' });
    ok('  ...an account without raw_json still changes (raw_json left NULL)', r.body.ok && ACCOUNTS[3].raw_json === null && ACCOUNTS[3].password === 'Null#raw1');

    // Admin HTML
    const html = await (await fetch(base + '/panel')).text();
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/ld\+json/.test(m[1])).map((m) => m[2]).filter((x) => x.trim());
    let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
    ok('panel inline scripts parse', parsed && scripts.length > 0);
    ok('password screen has the Last changed row + "today" after a change', /<span>Last changed<\/span>/.test(html) && /pwAgeText\(im\.account\.passwordChangedAt\)/.test(html) && /Last changed: <b>' \+ \(r\.passwordChangedAt \? esc\(r\.passwordChangedAt\.ago\) : 'today'\)/.test(html));
    ok('remove-users card has the Last password change line next to Next expiry', /ruNextLine\(g\) \+ '<\/div>' \+ ruPwLine\(g\)/.test(html) && /🔑 Last password change: /.test(html));
    // Run the two render helpers for real: escaped, unknown, amber when stale.
    const grab = (name) => { const i = html.indexOf('function ' + name + '('); let depth = 0, j = html.indexOf('{', i); for (; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) break; } return html.slice(i, j + 1); };
    const env = new Function(grab('esc') + '\nvar MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];\n' + grab('prettyDate') + '\n' + grab('pwAgeText') + '\n' + grab('ruPwLine') + '\nreturn { pwAgeText: pwAgeText, ruPwLine: ruPwLine };')();
    const evil = { at: '2026-09-02 14:00:00', short: '<b>2 Sep</b>', ago: '<img src=x onerror=alert(1)>', stale: false };
    ok('pwAgeText: "2 Sep 2026 (14 days ago)" and "unknown"', env.pwAgeText({ at: '2026-09-02 14:00:00', short: '2 Sep', ago: '14 days ago' }) === '2 Sep 2026 (14 days ago)' && env.pwAgeText(null) === 'unknown');
    ok('  ...escaped', !/<img/.test(env.pwAgeText(evil)) && /&lt;img/.test(env.pwAgeText(evil)) && !/<b>2 Sep/.test(env.ruPwLine({ count: 1, passwordChangedAt: evil })));
    ok('ruPwLine: short date, amber only when stale with inactive waiting, unknown otherwise',
      /Last password change: 2 Sep \(14 days ago\)/.test(env.ruPwLine({ count: 2, passwordChangedAt: { at: '2026-09-02 14:00:00', short: '2 Sep', ago: '14 days ago', stale: false } })) &&
      /ru-pwage old/.test(env.ruPwLine({ count: 2, passwordChangedAt: { at: '2026-07-02 14:00:00', short: '2 Jul', ago: '76 days ago', stale: true } })) &&
      !/ru-pwage old/.test(env.ruPwLine({ count: 2, passwordChangedAt: { at: '2026-09-02 14:00:00', short: '2 Sep', ago: '14 days ago', stale: false } })) &&
      /Last password change: unknown/.test(env.ruPwLine({ count: 3, passwordChangedAt: null })));
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((res) => server.close(res));
    Module._load = origLoad;
  }
  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
