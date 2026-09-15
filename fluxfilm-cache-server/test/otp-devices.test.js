/* 📱 OTP devices (otpdevices.js + adminotpdevices.js + admin.html): per OTP login its customers, device names,
 * 🚪 remove, and the read-only copy of device names from the old Sheet. Run: npm test
 * The fake database throws on any JOIN or any statement that touches two tables (MariaDB collation lesson). */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const O = require('../otpdevices');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const DAY = 86400e3;
const NOW = Date.now();
const at = (days) => O.istStamp(NOW + days * DAY); // India-time 'YYYY-MM-DD HH:MM:SS', days from now
const ymd = (days) => at(days).slice(0, 10);
const dmy = (days) => { const [y, m, d] = ymd(days).split('-'); return d + '/' + m + '/' + y; };

function fixture() {
  return {
    plans: [
      { service: 'JioHotstar', raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT' }) },
      { service: 'SonyLiv Premium', raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT' }) },
      { service: 'Zee5 Premium', raw_json: JSON.stringify({ AllocationPolicy: 'OTP_ACCOUNT' }) },
      { service: 'Netflix', raw_json: JSON.stringify({ AllocationPolicy: 'PROFILE' }) },
    ],
    accounts: [
      { service: 'JioHotstar', account_id: 'JH-3M-02', login_id: '8076332049', is_active: 'true', plan: '3 Months' },
      { service: 'JioHotstar', account_id: 'JH-1Y-02', login_id: '8076332049 ', is_active: 'true', plan: '1 Year' },
      { service: 'JioHotstar', account_id: 'JH-1M-01', login_id: '7428576079', is_active: 'true', plan: '1 Month' },
      { service: 'SonyLiv Premium', account_id: 'SL-01', login_id: '9000011111', is_active: 'TRUE', plan: '1 Month' },
      { service: 'Netflix', account_id: 'NF-1', login_id: 'nf@x', is_active: 'TRUE', plan: '' },
    ],
    caps: [
      { service: 'JioHotstar', account_id: 'JH-3M-02', max_total: 9, is_active: 'true' },
      { service: 'JioHotstar', account_id: 'JH-1Y-02', max_total: 9, is_active: 'true' },
      { service: 'SonyLiv Premium', account_id: 'SL-01', max_total: 4, is_active: 'TRUE' },
    ],
    customers: [
      { phone_norm: '9811100001', name: 'Ankit Satija' }, { phone_norm: '9811100002', name: 'Rahul Verma' },
      { phone_norm: '9811100003', name: 'Priya Shah' }, { phone_norm: '9811100004', name: 'Old Timer' },
      { phone_norm: '9811100005', name: 'Long Gone' }, { phone_norm: '9811100006', name: 'Refund Ravi' },
      { phone_norm: '9811100007', name: 'Sony Sunita' }, { phone_norm: '9811100008', name: 'Netflix Nina' },
      { phone_norm: '9811100009', name: 'Late Lata' },
    ],
    subs: [
      { sub_id: 'J1', order_id: 'FF1', phone_norm: '9811100001', service: 'JioHotstar', plan: '3 Months', status: 'EXPIRED', expiry_date: at(-5), inventory_ref: 'JH-3M-02', login_id: '8076332049', device_type: 'TV', device_count: null, removed: 0, removed_at: null, raw_json: JSON.stringify({ Name: 'Ankit Satija', DeviceName: 'LG TV', DeviceType: 'TV' }) },
      { sub_id: 'J2', order_id: 'FF2', phone_norm: '9811100002', service: 'JioHotstar', plan: '1 Year', status: 'ACTIVE', expiry_date: at(20), inventory_ref: 'JH-1Y-02', login_id: '8076332049', device_type: null, removed: 0, raw_json: JSON.stringify({ Name: 'Rahul Verma' }) },
      { sub_id: 'J3', order_id: 'FF3', phone_norm: '9811100003', service: 'JioHotstar', plan: '3 Months', status: 'ACTIVE', expiry_date: at(3), inventory_ref: 'JH-3M-02', login_id: '', device_type: '', removed: 0, raw_json: null },
      { sub_id: 'J4', order_id: 'FF4', phone_norm: '9811100004', service: 'JioHotstar', plan: '3 Months', status: 'EXPIRED', expiry_date: at(-40), inventory_ref: 'JH-3M-02', login_id: '8076332049', removed: 1, removed_at: at(-2), raw_json: JSON.stringify({ DeviceName: 'Honor Phone/Web browser' }) },
      { sub_id: 'J5', order_id: 'FF5', phone_norm: '9811100005', service: 'JioHotstar', plan: '3 Months', status: 'EXPIRED', expiry_date: at(-90), inventory_ref: 'JH-3M-02', login_id: '8076332049', removed: 1, removed_at: at(-30), raw_json: '{}' },
      { sub_id: 'J6', order_id: 'FF6', phone_norm: '9811100006', service: 'JioHotstar', plan: '1 Month', status: 'REFUNDED', expiry_date: at(10), inventory_ref: 'JH-1M-01', login_id: '7428576079', removed: 0, raw_json: '{}' },
      { sub_id: 'J7', order_id: 'FF7', phone_norm: '9811100002', service: 'JioHotstar', plan: '1 Year', status: 'EXPIRED', expiry_date: at(-300), inventory_ref: 'JH-1Y-02', login_id: '8076332049', removed: 0, raw_json: JSON.stringify({ DeviceName: 'Iphone 17,3' }) }, // renewed by J2
      { sub_id: 'J8', order_id: 'FF8', phone_norm: '9811100009', service: 'JioHotstar', plan: '1 Month', status: 'ACTIVE', expiry_date: at(-1), inventory_ref: 'JH-1M-01', login_id: '7428576079', removed: 0, raw_json: '{}' }, // status not flipped yet
      { sub_id: 'S1', order_id: 'FF9', phone_norm: '9811100007', service: 'SonyLiv Premium', plan: '1 Month', status: 'ACTIVE', expiry_date: at(12), inventory_ref: 'SL-01', login_id: '9000011111', removed: 0, raw_json: '{}' },
      { sub_id: 'N1', order_id: 'FF10', phone_norm: '9811100008', service: 'Netflix', plan: 'Sharing', status: 'EXPIRED', expiry_date: at(-3), inventory_ref: 'NF-1#P2', login_id: 'nf@x', removed: 0, raw_json: '{}' },
    ],
  };
}
const card = (r, id) => r.accounts.find((a) => a.accountIds.includes(id));

section('list: grouping, order, status labels, capacity, only OTP services');
{
  const F = fixture();
  const r = O.compute(Object.assign({}, F, { now: NOW }));
  const jh = card(r, 'JH-3M-02');
  ok('one login under two account IDs (JH-3M-02 + JH-1Y-02) is ONE card', jh && jh.accountIds.join() === 'JH-1Y-02,JH-3M-02' && jh.loginLabel === '8076332049' && r.accounts.filter((a) => a.accountIds.includes('JH-1Y-02')).length === 1, jh);
  ok('rows = subscriptions pointing at the login (by inventory_ref, login_id or account)', jh && jh.rows.map((x) => x.subId).sort().join() === 'J1,J2,J3', jh && jh.rows.map((x) => x.subId));
  ok('expired first, then active by the soonest expiry', jh && jh.rows.map((x) => x.subId).join() === 'J1,J3,J2', jh && jh.rows.map((x) => x.subId));
  ok('header counts: 2 active · 1 expired (not removed)', jh.active === 2 && jh.expired === 1, [jh.active, jh.expired]);
  ok('capacity from inventory_capacity: 2/9 used', jh.cap === 9 && jh.used === 2, [jh.cap, jh.used]);
  const j1 = jh.rows[0];
  ok('row: name (customers table), masked phone, plan, device type + count, device name, expiry, order id', j1.name === 'Ankit Satija' && j1.phoneMasked === '…0001' && j1.plan === '3 Months' && j1.deviceType === 'TV' && j1.deviceCount === 1 && j1.deviceName === 'LG TV' && j1.expiry === at(-5) && j1.orderId === 'FF1', j1);
  ok('status label ⚠️ EXPIRED 5d ago + 🚪 remove allowed', j1.status === 'EXPIRED' && j1.label === '⚠️ EXPIRED 5d ago' && j1.canRemove === true, j1);
  ok('active label ✅ ACTIVE, no remove button', jh.rows[1].label === '✅ ACTIVE' && jh.rows[1].canRemove === false);
  const jm = card(r, 'JH-1M-01');
  const j6 = jm.rows.find((x) => x.subId === 'J6'), j8 = jm.rows.find((x) => x.subId === 'J8');
  ok('refunded → ↩️ Refunded, removable', j6 && j6.label === '↩️ Refunded' && j6.canRemove, j6);
  ok('status ACTIVE but expiry passed → EXPIRED 1d ago', j8 && j8.status === 'EXPIRED' && j8.label === '⚠️ EXPIRED 1d ago', j8);
  ok('statusLabel: expired today', O.statusLabel({ status: 'EXPIRED', daysAgo: 0 }) === '⚠️ EXPIRED today');
  ok('renewed old row (same customer active on the login) is not listed; its device name is offered as a hint', !jh.rows.some((x) => x.subId === 'J7') && jh.rows.find((x) => x.subId === 'J2').deviceNameHint === 'Iphone 17,3', jh.rows.find((x) => x.subId === 'J2'));
  ok('removed rows are hidden; removed in the last 7 days go to "Removed recently" with device name + time', !jh.rows.some((x) => x.removed) && jh.removedRecent.map((x) => x.subId).join() === 'J4' && jh.removedRecent[0].deviceName === 'Honor Phone/Web browser' && jh.removedRecent[0].removedAt === at(-2), jh.removedRecent);
  ok('only OTP services: no Netflix card or row', !r.accounts.some((a) => /netflix/i.test(a.service)) && !r.accounts.some((a) => a.rows.some((x) => x.subId === 'N1')));
  ok('service tabs: JioHotstar, SonyLIV, Zee5 (from plans too)', r.services.map((x) => x.label).join() === 'JioHotstar,SonyLIV,Zee5', r.services);
  ok('counts on top: accounts, active devices, expired waiting', r.counts.accounts === 3 && r.counts.activeDevices === 3 && r.counts.expiredWaiting === 3, r.counts);
  ok('cards with expired first', r.accounts[0].expired >= r.accounts[r.accounts.length - 1].expired && r.accounts[0].expired === 2, r.accounts.map((a) => [a.accountIds, a.expired]));
  const sl = card(r, 'SL-01');
  ok('SonyLIV card: 1/4 used', sl && sl.cap === 4 && sl.used === 1 && sl.service === 'SonyLIV', sl);
  const only = O.compute(Object.assign({}, F, { now: NOW, service: 'sonyliv' }));
  ok('service filter: SonyLIV only (tabs still list all)', only.accounts.length === 1 && only.accounts[0].accountIds[0] === 'SL-01' && only.services.length === 3 && only.counts.accounts === 1, only.accounts.map((a) => a.accountIds));
  const shown = O.compute(Object.assign({}, F, { now: NOW, showRemoved: true }));
  ok('Show removed: removed rows listed after the others', card(shown, 'JH-3M-02').rows.map((x) => x.subId).join() === 'J1,J3,J2,J5,J4', card(shown, 'JH-3M-02').rows.map((x) => x.subId));
  ok('isOtpService: policy or name; Netflix / Prime are not', O.isOtpService('JioHotstar') && O.isOtpService('SonyLiv Premium') && O.isOtpService('Zee5 Premium') && O.isOtpService('Crunchyroll', { crunchyroll: 'OTP_ACCOUNT' }) && !O.isOtpService('Netflix') && !O.isOtpService('Prime Video') && !O.isOtpService('YouTube Premium'));
}

section('search');
{
  const F = fixture();
  const find = (q) => O.compute(Object.assign({}, F, { now: NOW, q }));
  let r = find('lg tv');
  ok('device name: only Ankit on one card', r.accounts.length === 1 && r.accounts[0].rows.map((x) => x.subId).join() === 'J1', r.accounts.map((a) => [a.accountIds, a.rows.map((x) => x.subId)]));
  r = find('priya');
  ok('customer name', r.accounts.length === 1 && r.accounts[0].rows.map((x) => x.subId).join() === 'J3');
  r = find('100007');
  ok('customer phone digits', r.accounts.length === 1 && r.accounts[0].rows[0].subId === 'S1');
  r = find('7428576079');
  ok('account login phone → the whole card', r.accounts.length === 1 && r.accounts[0].accountIds[0] === 'JH-1M-01' && r.accounts[0].rows.length === 2);
  r = find('JH-1Y');
  ok('account ID', r.accounts.length === 1 && r.accounts[0].rows.length === 3);
  r = find('honor');
  ok('device name of a recently removed customer', r.accounts.length === 1 && r.accounts[0].rows.length === 0 && r.accounts[0].removedRecent[0].subId === 'J4');
  ok('no match → no cards', find('zzzz-nobody').accounts.length === 0);
}

section('device name / type validation');
{
  ok('trim + collapse spaces', O.cleanDeviceName('  LG   TV ').value === 'LG TV');
  ok('60 characters ok, 61 refused', O.cleanDeviceName('x'.repeat(60)).ok && !O.cleanDeviceName('x'.repeat(61)).ok && /max 60/.test(O.cleanDeviceName('x'.repeat(61)).message));
  ok('control characters dropped', O.cleanDeviceName('LG\u0000\nTV').value === 'LG TV');
  ok('objects refused', !O.cleanDeviceName({ a: 1 }).ok);
  ok('device type: 📱 PHONE / 📺 TV / mobile / blank / junk', O.normDeviceType('📱 PHONE') === 'PHONE' && O.normDeviceType('📺 TV') === 'TV' && O.normDeviceType('mobile') === 'PHONE' && O.normDeviceType('tv') === 'TV' && O.normDeviceType('📺') === 'TV' && O.normDeviceType('') === '' && O.normDeviceType('LG TV') === null && O.normDeviceType('NON_TV') === null);
}

section('old Sheet: parsing');
const SHEET = [
  ['JIOHOTSTAR ACCOUNTS', '', '', '', '', ''],
  ['📱 8076332049', '', '', '', '', ''],
  ['Customer', 'Device', 'Type', '✓', 'Expiry', 'Status'],
  ['Ankit Satija', 'LG TV', '📺 TV', true, dmy(-5), 'EXPIRED ⚠️'],
  ['priya  shah', 'Amazon TV/Rockchip Phone', '📺 TV', 'TRUE', dmy(3), 'ACTIVE ✅'],
  ['Rahul', 'Iphone 17,3', '📱 PHONE', '✅', dmy(21), 'ACTIVE ✅'], // first name only, expiry one day off
  ['', '', '', '', '', ''],
  ['📱 7428576079', '', '', '', '', ''],
  ['Refund Ravi', 'Honor Phone/Web browser', '📱 PHONE', 'FALSE', dmy(10), 'EXPIRED ⚠️'],
  ['Nobody Known', 'Mi TV', '📺 TV', 'TRUE', dmy(10), 'ACTIVE ✅'],
  ['Late Lata', '', '', 'TRUE', dmy(-1), 'EXPIRED ⚠️'], // no device name or type → skipped
];
{
  const p = O.parseRows(SHEET);
  ok('reads 5 customer rows (headers, titles, blank lines ignored)', p.rows.length === 5, p.rows);
  const a = p.rows[0];
  ok('account from the 📱 header row, service from the title, name/device/type/expiry/status', a.account === '8076332049' && a.service === 'jiohotstar' && a.name === 'Ankit Satija' && a.deviceName === 'LG TV' && a.deviceType === 'TV' && a.expiry === ymd(-5) && a.sheetStatus === 'EXPIRED' && a.line === 4, a);
  ok('📱 PHONE → PHONE, ✅ tick ignored', p.rows[2].deviceType === 'PHONE' && p.rows[2].deviceName === 'Iphone 17,3', p.rows[2]);
  ok('next 📱 header switches the account', p.rows[3].account === '7428576079' && p.rows[3].name === 'Refund Ravi');
  ok('row without device name or type is skipped with a reason', p.skipped.some((x) => x.line === 11 && /no device name/.test(x.reason)), p.skipped);
  ok('dates: dd/mm/yyyy, d-m-yy, 14 Sep 2026, ISO from the Apps Script dump (India date)', O.sheetDate('14/09/2026') === '2026-09-14' && O.sheetDate('4-9-26') === '2026-09-04' && O.sheetDate('14 Sep 2026') === '2026-09-14' && O.sheetDate('2026-09-13T18:30:00.000Z') === '2026-09-14' && O.sheetDate('31/02/2026') === '' && O.sheetDate('LG TV') === '');
  const tsv = [SHEET[1].join('\t'), SHEET[3].map(String).join('\t'), '8.\tAnkit S\tSamsung TV\t📺 TV\tTRUE\t' + dmy(-5) + '\tEXPIRED ⚠️'].join('\r\n');
  const q = O.parseRows(O.parsePaste(tsv));
  ok('TSV paste (Ctrl+C from Google Sheets): same result, serial-number column ignored', q.rows.length === 2 && q.rows[0].account === '8076332049' && q.rows[0].deviceName === 'LG TV' && q.rows[1].name === 'Ankit S' && q.rows[1].deviceName === 'Samsung TV', q.rows);
  const dump = { headers: ['📱 8076332049', '', ''], rows: [{ '📱 8076332049': 'Ankit Satija', Col2: 'LG TV', Col3: '2026-09-13T18:30:00.000Z' }] };
  const back = O.dumpToRows(dump);
  ok('Apps Script dump → rows with the first Sheet row kept', back.length === 2 && back[0][0] === '📱 8076332049' && back[0][1] === '' && back[1].join('|') === 'Ankit Satija|LG TV|2026-09-13T18:30:00.000Z', back);
  const pd = O.parseRows(back);
  ok('  ...and parses (account from the header, ISO expiry)', pd.rows.length === 1 && pd.rows[0].account === '8076332049' && pd.rows[0].expiry === '2026-09-14', pd.rows);
}

section('old Sheet: matching (unique / ambiguous / none)');
{
  const F = fixture();
  const m = O.matchRows(O.parseRows(SHEET).rows, F);
  const sub = (list) => list.map((x) => x.subId).sort().join();
  ok('Ankit already has "LG TV" → same (nothing to write)', m.same.some((x) => x.subId === 'J1'), m.same);
  ok('Priya (spaces/case), Rahul (first name, expiry ±1 day), Refund Ravi → matched', sub(m.matched) === 'J2,J3,J6', m.matched);
  ok('matched rows carry sub id, customer, device name + type', m.matched.find((x) => x.subId === 'J3').deviceName === 'Amazon TV/Rockchip Phone' && m.matched.find((x) => x.subId === 'J2').deviceType === 'PHONE' && m.matched.find((x) => x.subId === 'J2').name === 'Rahul Verma');
  ok('unknown customer → not found, never guessed', m.unmatched.length === 1 && m.unmatched[0].sheetName === 'Nobody Known', m.unmatched);
  // Two subscriptions with the same name + date on the same login → ambiguous.
  const twin = fixture();
  twin.subs.push(Object.assign({}, twin.subs[2], { sub_id: 'J3B', order_id: 'FF3B', phone_norm: '9811100099' }));
  twin.customers.push({ phone_norm: '9811100099', name: 'Priya Shah' });
  const m2 = O.matchRows(O.parseRows(SHEET).rows, twin);
  ok('two possible subscriptions → ambiguous, listed with both sub ids', m2.ambiguous.length === 1 && m2.ambiguous[0].candidates.map((c) => c.subId).sort().join() === 'J3,J3B' && !m2.matched.some((x) => /J3/.test(x.subId)), m2.ambiguous);
  const m3 = O.matchRows(O.parseRows([['📱 8076332049'], ['Priya Shah', 'TV one', 'TV', dmy(3)], ['Priya', 'TV two', 'TV', dmy(3)]]).rows, F);
  ok('two Sheet rows claiming the same subscription → both ambiguous', m3.ambiguous.length === 2 && !m3.matched.length, m3);
  const m4 = O.matchRows(O.parseRows([['📱 7428576079'], ['Priya Shah', 'Mi TV', 'TV', dmy(3)]]).rows, F);
  ok('wrong account login → not found', m4.unmatched.length === 1 && !m4.matched.length);
  const m5 = O.matchRows(O.parseRows([['📱 8076332049'], ['Priya Shah', 'Mi TV', 'TV', dmy(6)]]).rows, F);
  ok('expiry 3 days off → not found', m5.unmatched.length === 1);
  const m6 = O.matchRows(O.parseRows([['📱 8076332049'], ['Ankit Satija', 'Samsung TV', 'TV', dmy(-5)]]).rows, F);
  ok('existing different device name → "already has a device name" (skipped unless overwrite)', m6.alreadyNamed.length === 1 && m6.alreadyNamed[0].currentDeviceName === 'LG TV' && !m6.matched.length, m6);
  ok('name rules: exact 2, first-name 1, different surname initial 0', O.nameLevel('ankit  SATIJA', 'Ankit Satija') === 2 && O.nameLevel('Ankit', 'Ankit Satija') === 1 && O.nameLevel('Ankit S.', 'Ankit Satija') === 1 && O.nameLevel('Ankit Kumar', 'Ankit Satija') === 0 && O.nameLevel('Rahul', 'Ankit') === 0);
  const netflixRow = O.matchRows([{ line: 1, account: '', service: '', name: 'Netflix Nina', deviceName: 'TV', deviceType: 'TV', expiry: ymd(-3) }], F);
  ok('never matches a non-OTP subscription', netflixRow.unmatched.length === 1);
}

section('fake database + admin routes');
const TABLES = ['subscriptions', 'customers', 'plans', 'inventory_accounts', 'inventory_capacity', 'orders', 'wallet', 'audit_log', 'app_settings', 'coins_ledger', 'refund_offers'];
function makeDb(F) {
  const calls = [];
  const subs = new Map(F.subs.map((x) => [x.sub_id, Object.assign({}, x)]));
  const nowStamp = () => O.istStamp(Date.now());
  const likeOk = (service, pat) => String(service).toLowerCase().includes(pat.replace(/%/g, ''));
  const jsonSet = (raw, pairs) => { const j = raw == null ? {} : JSON.parse(raw); for (const [k, v] of pairs) j[k] = v; return JSON.stringify(j); };
  const db = {
    calls, subs,
    async query(sql0, params) {
      const sql = String(sql0).replace(/\s+/g, ' ').trim(); const p = params || [];
      calls.push({ sql, params: p });
      if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
      if (/\bJOIN\b/i.test(sql)) throw new Error('fake db: JOIN refused (collations) ' + sql);
      const used = TABLES.filter((t) => new RegExp('\\b(FROM|INTO|UPDATE|JOIN)\\s+' + t + '\\b', 'i').test(sql));
      if (used.length > 1) throw new Error('fake db: two tables in one statement refused: ' + used.join('+'));
      if (/^SELECT service, raw_json FROM plans$/.test(sql)) return F.plans;
      if (/^SELECT service, account_id, login_id, is_active, plan FROM inventory_accounts$/.test(sql)) return F.accounts;
      if (/^SELECT service, account_id, max_total, is_active FROM inventory_capacity$/.test(sql)) return F.caps;
      if (/^SELECT phone_norm, name FROM customers WHERE phone_norm IN/.test(sql)) return F.customers.filter((c) => p.includes(c.phone_norm));
      if (sql.startsWith('SELECT ' + O.SUB_COLS + ' FROM subscriptions WHERE')) {
        const likes = p.filter((x) => /%/.test(x)), ins = p.filter((x) => !/%/.test(x));
        return [...subs.values()].filter((x) => likes.some((l) => likeOk(x.service, l)) || ins.includes(x.service)).map((x) => Object.assign({}, x));
      }
      if (/^SELECT sub_id, service, device_type, raw_json FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) { const x = subs.get(p[0]); return x ? [Object.assign({}, x)] : []; }
      if (/^UPDATE subscriptions SET .* WHERE sub_id = \? AND \(raw_json IS NULL OR JSON_VALID\(raw_json\) = 1\) LIMIT 1$/.test(sql)) {
        const x = subs.get(p[p.length - 1]); if (!x) return { affectedRows: 0 };
        let i = 0;
        if (/device_type = \?/.test(sql)) x.device_type = p[i++];
        const m = sql.match(/JSON_SET\(COALESCE\(raw_json, '\{\}'\), (.*)\) WHERE/);
        if (m) { const keys = [...m[1].matchAll(/'\$\.(\w+)', \?/g)].map((k) => k[1]); x.raw_json = jsonSet(x.raw_json, keys.map((k) => [k, p[i++]])); }
        return { affectedRows: 1 };
      }
      // admin.js POST /admin/api/sub-removed (the existing "Removed from account" save)
      if (/FROM information_schema\.columns/.test(sql)) return [{ n: 2 }];
      if (/^UPDATE subscriptions SET removed = 1, removed_at = COALESCE\(\?, NOW\(\)\)/.test(sql)) { const x = subs.get(p[2]); if (!x) return { affectedRows: 0 }; x.removed = 1; x.removed_at = p[0] || nowStamp(); if (x.raw_json != null) x.raw_json = jsonSet(x.raw_json, [['RemovedFromDevice', p[1]]]); return { affectedRows: 1 }; }
      if (/^SELECT sub_id, removed, removed_at FROM subscriptions WHERE sub_id = \?/.test(sql)) { const x = subs.get(p[0]); return x ? [{ sub_id: x.sub_id, removed: x.removed, removed_at: x.removed_at }] : []; }
      // Customer 360
      if (/^SELECT \* FROM subscriptions WHERE phone_norm = \?/.test(sql)) return [...subs.values()].filter((x) => x.phone_norm === p[0]).map((x) => Object.assign({}, x));
      if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return { affectedRows: 0 };
      return [];
    },
    getPool: () => null, ping: async () => ({ ok: true }),
  };
  return db;
}

(async () => {
  const F = fixture();
  const mockDb = makeDb(F);
  const readerCalls = [];
  const sheetMock = { async readTab(tab) { readerCalls.push(tab); return tab === 'JIOHOTSTAR' ? { ok: true, tab, rows2d: SHEET } : { ok: false, message: 'The Sheet reader does not allow the tab "' + tab + '" yet.', help: 'add ' + tab + ': 1 to the ALLOW list' }; } };
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), otpDevices: { sheetReader: sheetMock } });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const x = await fetch(base + p, { headers: H }); return { status: x.status, body: await x.json() }; };
  const post = async (p, b) => { const x = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() }; };
  const tick = () => new Promise((res) => setTimeout(res, 30));
  const audits = (action) => mockDb.calls.filter((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === action);
  const raw = (id) => JSON.parse(mockDb.subs.get(id).raw_json || '{}');
  try {
    let r = await get('/admin/api/otp-devices');
    ok('GET otp-devices: accounts + counts + services (separate single-table queries, fake db refuses JOIN)', r.status === 200 && r.body.ok && r.body.accounts.length === 3 && r.body.counts.expiredWaiting === 3 && r.body.services.length === 3, r.body);
    ok('  ...every statement touched one table', !mockDb.calls.some((c) => /JOIN/i.test(c.sql)));
    ok('  ...needs the admin key', (await fetch(base + '/admin/api/otp-devices')).status === 403);
    r = await get('/admin/api/otp-devices?service=jiohotstar&q=' + encodeURIComponent('lg tv'));
    ok('  ...service + search params', r.body.accounts.length === 1 && r.body.accounts[0].rows[0].subId === 'J1', r.body.accounts);

    section('device name save: typed column + raw_json in step, limit, change log');
    mockDb.calls.length = 0;
    r = await post('/admin/api/otp-devices/device', { subId: 'J3', deviceName: '  Amazon  TV/Rockchip Phone ', deviceType: '📺 TV' });
    const j3 = mockDb.subs.get('J3');
    ok('saves DeviceName + DeviceNameUpdatedAt (IST) in raw_json; device_type TV typed AND raw DeviceType TV', r.body.ok && r.body.deviceName === 'Amazon TV/Rockchip Phone' && raw('J3').DeviceName === 'Amazon TV/Rockchip Phone' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw('J3').DeviceNameUpdatedAt) && j3.device_type === 'TV' && raw('J3').DeviceType === 'TV', { body: r.body, j3 });
    ok('  ...a NULL raw_json becomes an object (COALESCE), and the update is guarded by JSON_VALID', mockDb.calls.some((c) => /JSON_SET\(COALESCE\(raw_json, '\{\}'\)/.test(c.sql) && /JSON_VALID\(raw_json\) = 1/.test(c.sql)));
    await tick();
    ok('  ...one change-log entry with before → after', audits('sub.device').length === 1 && /device name \(none\) → "Amazon TV\/Rockchip Phone", type \(none\) → TV/.test(audits('sub.device')[0].params.join('|')), audits('sub.device'));
    r = await post('/admin/api/otp-devices/device', { subId: 'J3', deviceName: 'Amazon TV/Rockchip Phone', deviceType: 'TV' });
    ok('same values again → unchanged, no write', r.body.ok && r.body.unchanged === true);
    r = await post('/admin/api/otp-devices/device', { subId: 'J3', deviceType: 'PHONE' });
    ok('type only → typed + raw change together, name kept', r.body.ok && mockDb.subs.get('J3').device_type === 'PHONE' && raw('J3').DeviceType === 'PHONE' && raw('J3').DeviceName === 'Amazon TV/Rockchip Phone', raw('J3'));
    r = await post('/admin/api/otp-devices/device', { subId: 'J3', deviceName: 'y'.repeat(61) });
    ok('61 characters → 400, nothing saved', r.status === 400 && /max 60/.test(r.body.message) && raw('J3').DeviceName === 'Amazon TV/Rockchip Phone', r.body);
    r = await post('/admin/api/otp-devices/device', { subId: 'J3', deviceType: 'LAPTOP' });
    ok('bad type → 400', r.status === 400 && /PHONE or TV/.test(r.body.message));
    r = await post('/admin/api/otp-devices/device', { subId: 'N1', deviceName: 'TV' });
    ok('non-OTP subscription → 400', r.status === 400 && /Only OTP services/.test(r.body.message) && !raw('N1').DeviceName, r.body);
    ok('missing subscription → 404, no subId → 400', (await post('/admin/api/otp-devices/device', { subId: 'NOPE', deviceName: 'x' })).status === 404 && (await post('/admin/api/otp-devices/device', { deviceName: 'x' })).status === 400);
    mockDb.subs.get('S1').raw_json = '{broken';
    r = await post('/admin/api/otp-devices/device', { subId: 'S1', deviceName: 'Mi TV' });
    ok('unreadable raw_json → 409 (never overwritten)', r.status === 409 && mockDb.subs.get('S1').raw_json === '{broken', r.body);
    mockDb.subs.get('S1').raw_json = '{}';
    const evil = '<img src=x onerror=alert(1)>"\'&';
    r = await post('/admin/api/otp-devices/device', { subId: 'J2', deviceName: evil });
    ok('HTML in a device name is stored as plain text (escaped when shown)', r.body.ok && raw('J2').DeviceName === evil);
    ok('save needs the admin key', (await fetch(base + '/admin/api/otp-devices/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"subId":"J3","deviceName":"x"}' })).status === 403);

    section('XSS-safe rendering (admin.html odCard / odRow with esc)');
    const html = await (await fetch(base + '/panel')).text();
    const fnSrc = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) return ''; const j = html.indexOf('\nfunction ', i + 10); const k = html.indexOf('\nvar ', i + 10); const end = [j, k].filter((x) => x > 0).sort((a, b) => a - b)[0]; return html.slice(i, end); };
    const varSrc = (name) => { const m = html.match(new RegExp('\\nvar ' + name + ' = [^\\n]*')); return m ? m[0] : ''; };
    const list = (await get('/admin/api/otp-devices?service=jiohotstar')).body;
    let rendered = '';
    try {
      const make = new Function(varSrc('ICONS') + varSrc('MON') + "\nvar OD = { q: '', removed: false };" + ['esc', 'prettyDate', 'svcIcon', 'ruPlural', 'odCard', 'odRow'].map(fnSrc).join('\n') + '\nreturn function (a) { return odCard(a); };');
      rendered = list.accounts.map(make()).join('');
    } catch (e) { console.log('   render error:', e.message); }
    ok('device name rendered escaped (no raw <img>, quotes escaped)', rendered.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;') && !rendered.includes('<img src=x'), rendered.slice(0, 200));
    ok('rows show name, masked phone, 360 link, plan, 📺/📱, device field (max 60) + 💾, expiry, status, order id, 🚪 Remove on expired', /data-odcust="9811100001"/.test(rendered) && /…0001/.test(rendered) && /📺 1 device/.test(rendered) && /maxlength="60" data-odname="J1" value="LG TV"/.test(rendered) && /💾 Save/.test(rendered) && /⚠️ EXPIRED 5d ago/.test(rendered) && /data-odorder="FF1"/.test(rendered) && /data-odrm="J1">🚪 Remove/.test(rendered) && !/data-odrm="J2"/.test(rendered) && /2\/9 used/.test(rendered), rendered.slice(0, 400));
    ok('"Removed recently" shows device name + removed time', /Removed recently \(1\)/.test(rendered) && /Honor Phone\/Web browser/.test(rendered));

    section('🚪 Remove: the existing "Removed from account" save, row leaves the list');
    mockDb.calls.length = 0;
    r = await post('/admin/api/sub-removed', { sub_id: 'J1', removed: true, removed_at: '' });
    ok('POST /admin/api/sub-removed marks removed = 1, removed_at = now (IST), raw_json RemovedFromDevice TRUE', r.body.ok && Number(mockDb.subs.get('J1').removed) === 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(mockDb.subs.get('J1').removed_at) && raw('J1').RemovedFromDevice === 'TRUE', r.body);
    await tick();
    ok('  ...with its change-log entry (sub.removed)', audits('sub.removed').length === 1);
    r = await get('/admin/api/otp-devices?service=jiohotstar');
    const jh = r.body.accounts.find((a) => a.accountIds.includes('JH-3M-02'));
    ok('  ...J1 left the list and is in "Removed recently" with its device name', !jh.rows.some((x) => x.subId === 'J1') && jh.removedRecent[0].subId === 'J1' && jh.removedRecent[0].deviceName === 'LG TV' && jh.expired === 0 && r.body.counts.expiredWaiting === 2, jh);
    ok('panel: remove button posts to the existing endpoint with a confirm naming device + login + service', /post\('\/admin\/api\/sub-removed', \{ sub_id: f\.r\.subId, removed: true, removed_at: '' \}\)/.test(html) && /confirm\('Remove ' \+ f\.r\.name \+ \(f\.r\.deviceName \? ' \(' \+ f\.r\.deviceName \+ '\)' : ''\) \+ ' from ' \+ login \+ '\?\\n\\nLog this device out in ' \+ f\.a\.service \+ ' first\.'\)/.test(html));

    section('Customer 360 + 🚪 Remove users show the device name');
    r = await get('/admin/api/customer?phone=9811100003');
    const c3 = (r.body.subs || []).find((x) => x.sub_id === 'J3');
    ok('customer API adds device_name, still hides raw_json', c3 && c3.device_name === 'Amazon TV/Rockchip Phone' && !('raw_json' in c3), c3);
    ok('subCard shows 📱 device name (escaped)', /\(s\.device_name \? ' · 📱 <b>' \+ esc\(s\.device_name\) \+ '<\/b>' : ''\)/.test(html));
    ok('Remove users rows show 📱 device name (escaped)', /\(p\.deviceName \? ' · 📱 <b>' \+ esc\(p\.deviceName\) \+ '<\/b>' : ''\)/.test(html));
    const E = require('../expiredusers');
    ok('expiredusers: same-row device_name (JSON_VALID guarded, no other table) → people.deviceName', /IF\(JSON_VALID\(s\.raw_json\), JSON_UNQUOTE\(JSON_EXTRACT\(s\.raw_json, '\$\.DeviceName'\)\), NULL\) AS device_name/.test(E.SUBS_SQL) && E.compute({ now: NOW, subs: [{ sub_id: 'A', service: 'JioHotstar', status: 'ACTIVE', expiry_date: at(9), inventory_ref: 'JH-1', login_id: '1', phone_norm: '1' }, { sub_id: 'B', service: 'JioHotstar', status: 'EXPIRED', expiry_date: at(-9), inventory_ref: 'JH-1', login_id: '1', phone_norm: '2', device_name: 'LG TV' }] }).other.groups[0].people[0].deviceName === 'LG TV');

    section('📥 copy device names from the old Sheet (read-only, preview first)');
    const before = JSON.stringify([...mockDb.subs.values()]);
    mockDb.calls.length = 0;
    r = await post('/admin/api/otp-devices/import/preview', { source: 'sheet', tab: 'JIOHOTSTAR' });
    ok('preview from the Sheet: counts + lists', r.body.ok && r.body.rowsRead === 5 && r.body.counts.unmatched === 1 && r.body.matched.length === r.body.counts.matched && readerCalls.join() === 'JIOHOTSTAR', r.body.counts);
    ok('  ...Rahul (J2, a different name typed above) → "already has a device name"; Priya (J3, same name) → same; Ravi matched', r.body.alreadyNamed.map((x) => x.subId).join() === 'J2' && r.body.same.some((x) => x.subId === 'J3') && r.body.matched.map((x) => x.subId).join() === 'J6', { m: r.body.matched, a: r.body.alreadyNamed });
    ok('  ...preview writes NOTHING (no UPDATE/INSERT, data identical)', !mockDb.calls.some((c) => /^(UPDATE|INSERT|DELETE)/.test(c.sql)) && JSON.stringify([...mockDb.subs.values()]) === before);
    ok('  ...the Sheet reader has only readTab (no write method)', Object.keys(O.sheetReader({ API_KEY: 'x' }, async () => ({ text: async () => '{}' }))).join() === 'readTab' && typeof sheetMock.write === 'undefined');
    r = await post('/admin/api/otp-devices/import/preview', { source: 'sheet', tab: 'OTHER' });
    ok('tab the reader does not allow → message + what to enable', r.body.ok === false && r.body.sheetError && /ALLOW/.test(r.body.help), r.body);
    const tsv = SHEET.map((row) => row.map(String).join('\t')).join('\n');
    r = await post('/admin/api/otp-devices/import/preview', { source: 'paste', text: tsv });
    ok('TSV paste fallback gives the same preview', r.body.ok && r.body.source === 'paste' && r.body.rowsRead === 5 && r.body.matched.map((x) => x.subId).join() === 'J6', r.body.counts);
    ok('empty paste → 400', (await post('/admin/api/otp-devices/import/preview', { source: 'paste', text: '  ' })).status === 400);

    mockDb.calls.length = 0;
    const j3Before = Object.assign({}, mockDb.subs.get('J3'));
    const j6Before = Object.assign({}, mockDb.subs.get('J6'));
    const items = r.body.matched.concat(r.body.alreadyNamed).map((x) => ({ subId: x.subId, deviceName: x.deviceName, deviceType: x.deviceType }));
    r = await post('/admin/api/otp-devices/import/save', { items });
    const j6 = mockDb.subs.get('J6');
    ok('save (overwrite off): the empty name is written — J6 DeviceName + DeviceNameSource sheet + UpdatedAt, type PHONE typed + raw', r.body.ok && r.body.saved === 2 && r.body.names === 1 && raw('J6').DeviceName === 'Honor Phone/Web browser' && raw('J6').DeviceNameSource === 'sheet' && raw('J6').DeviceNameUpdatedAt && j6.device_type === 'PHONE' && raw('J6').DeviceType === 'PHONE', { body: r.body, raw: raw('J6') });
    ok('  ...existing name kept (overwrite off by default); J2\'s empty type filled from the Sheet (typed + raw)', raw('J2').DeviceName === evil && r.body.types === 2 && mockDb.subs.get('J2').device_type === 'PHONE' && raw('J2').DeviceType === 'PHONE' && raw('J2').DeviceNameSource === undefined, { body: r.body, j2: raw('J2') });
    ok('  ...status, expiry and removed never change', j6.status === j6Before.status && j6.expiry_date === j6Before.expiry_date && j6.removed === j6Before.removed && mockDb.subs.get('J3').status === j3Before.status && mockDb.subs.get('J3').removed === j3Before.removed);
    await tick();
    ok('  ...one change-log entry with counts', audits('sub.deviceImport').length === 1 && /1 name\(s\), 2 type\(s\) on 2 subscription/.test(audits('sub.deviceImport')[0].params.join('|')), audits('sub.deviceImport'));
    r = await post('/admin/api/otp-devices/import/save', { items });
    ok('  ...run twice → nothing new (idempotent), no second change-log entry', r.body.ok && r.body.saved === 0 && r.body.unchanged === 2 && (await tick(), audits('sub.deviceImport').length === 1), r.body);
    mockDb.subs.get('J3').device_type = null; mockDb.subs.get('J3').raw_json = JSON.stringify(Object.assign(raw('J3'), { DeviceType: '' }));
    r = await post('/admin/api/otp-devices/import/save', { items: [{ subId: 'J3', deviceName: 'Amazon TV/Rockchip Phone', deviceType: 'TV' }] });
    ok('  ...type is filled where it is empty', r.body.saved === 1 && mockDb.subs.get('J3').device_type === 'TV' && raw('J3').DeviceType === 'TV', r.body);
    r = await post('/admin/api/otp-devices/import/save', { items: [{ subId: 'J3', deviceName: 'Rockchip Box', deviceType: 'PHONE' }], overwrite: true });
    ok('  ...overwrite ticked: name + type replaced', r.body.saved === 1 && raw('J3').DeviceName === 'Rockchip Box' && raw('J3').DeviceNameSource === 'sheet' && mockDb.subs.get('J3').device_type === 'PHONE' && raw('J3').DeviceType === 'PHONE', raw('J3'));
    r = await post('/admin/api/otp-devices/import/save', { items: [{ subId: 'N1', deviceName: 'TV' }, { subId: 'J6', deviceName: 'z'.repeat(61) }] });
    ok('  ...non-OTP / too long rows are reported as errors, not written', r.body.saved === 0 && r.body.errors.length === 2 && !raw('N1').DeviceName, r.body);
    ok('  ...needs items (400), at most 500, admin key', (await post('/admin/api/otp-devices/import/save', { items: [] })).status === 400 && (await post('/admin/api/otp-devices/import/save', { items: Array.from({ length: 501 }, (_, i) => ({ subId: 'S' + i })) })).status === 400 && (await fetch(base + '/admin/api/otp-devices/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"source":"paste","text":"x"}' })).status === 403);

    section('Sheet reader (read-only adminDumpTab request, clear messages)');
    const bodies = [];
    const fakeFetch = (answer) => async (url, init) => { bodies.push(JSON.parse(init.body)); return { text: async () => JSON.stringify(answer) }; };
    let rd = await O.sheetReader({ API_KEY: 'key1', API_PHP_URL: 'https://example.invalid/api.php' }, fakeFetch({ ok: false, message: 'Tab not allowed: JIOHOTSTAR DEVICES' })).readTab('JioHotstar devices');
    ok('asks adminDumpTab for the tab in CAPITALS (the only action it sends)', bodies[0].action === 'adminDumpTab' && bodies[0].args[0] === 'JIOHOTSTAR DEVICES', bodies);
    ok('not allowed → says exactly what to enable (AdminDump.gs ALLOW + new deployment) or paste', !rd.ok && /AdminDump\.gs/.test(rd.help) && /JIOHOTSTAR DEVICES: 1/.test(rd.help) && /New version/.test(rd.help) && /paste/i.test(rd.help), rd);
    rd = await O.sheetReader({ API_KEY: 'key1' }, fakeFetch({ ok: false, message: 'Missing sheet: X' })).readTab('x');
    ok('missing tab → CAPITALS hint', !rd.ok && /CAPITALS/.test(rd.help));
    rd = await O.sheetReader({ API_KEY: '' }, fakeFetch({})).readTab('X');
    ok('no API_KEY → explains, no request made', !rd.ok && /API_KEY/.test(rd.message) && bodies.length === 2);
    rd = await O.sheetReader({ API_KEY: 'k' }, async () => ({ text: async () => '<html>301</html>' })).readTab('X');
    ok('old site gone (non-JSON) → paste hint', !rd.ok && /paste/i.test(rd.help));
    rd = await O.sheetReader({ API_KEY: 'k' }, fakeFetch({ ok: true, result: { tab: 'X', headers: ['📱 8076332049', '', ''], rows: [{ '📱 8076332049': 'Ankit Satija', Col2: 'LG TV', Col3: dmy(-5) }] } })).readTab('X');
    ok('rows come back as cells with the first Sheet row', rd.ok && rd.rows2d[0][0] === '📱 8076332049' && rd.rows2d[1][1] === 'LG TV', rd);

    section('panel wiring');
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
    let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
    ok('inline scripts parse', parsed && scripts.length > 0);
    ok('side menu: 📱 OTP devices right after 🚪 Remove users, with its own view', /\['removeusers', '🚪', 'Remove users'\], \['otpdevices', '📱', 'OTP devices'\]/.test(html) && /otpdevices: otpDevicesView/.test(html) && /function otpDevicesView\(/.test(html));
    ok('screen: counts, service chips, search, Show removed toggle, import card with Sheet + paste + ✅ Save N', /api\('\/admin\/api\/otp-devices', \{ service: OD\.svc, q: OD\.q, removed: OD\.removed \? '1' : '' \}\)/.test(html) && /data-odsvc=/.test(html) && /id="odq"/.test(html) && /Show removed/.test(html) && /📥 Copy device names from old Sheet/.test(html) && /data-odprev="sheet"/.test(html) && /id="odpaste"/.test(html) && /✅ Save ' \+ n \+ ' device name'/.test(html) && /Overwrite device names I already typed/.test(html));
    ok('device save on 💾, blur and type change → POST /admin/api/otp-devices/device', /post\('\/admin\/api\/otp-devices\/device', \{ subId: id, deviceName: name, deviceType: type \}\)/.test(html) && /addEventListener\('focusout'/.test(html) && /✓ saved/.test(html));
    ok('import preview table cells are escaped', /'<td>' \+ esc\(v\) \+ '<\/td>'/.test(html));
    ok('package.json runs this test', /node test\/otp-devices\.test\.js/.test(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')));
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((res) => server.close(res));
    Module._load = origLoad;
  }
  console.log('\n---------------------------------------');
  console.log('otp-devices: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
