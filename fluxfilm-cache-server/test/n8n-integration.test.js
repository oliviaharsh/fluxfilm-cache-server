/* 🔗 n8n integration (shop side): API key (hashed, rotate, URL refused, rate limit), expiring reminders (India days, the
 * pop-up's skip rules, reminder-sent once), win-back (rules, personal coupon: idempotent, typed columns = raw_json,
 * accepted by order.js couponDiscount, opt-out), posts (no TMDB links, catalog prices), health (build fingerprint),
 * encrypted backup (streams, AES-256-GCM, restore script round trip, excluded keys + video bytes, refused without a
 * passphrase), webhooks (signature, once per event, retries, never throws), unsubscribe tokens, admin page wiring,
 * inline scripts, n8n workflow files. Run: npm test (no database: in-memory fakes that refuse JOINs). */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
process.env.SITE_URL = 'https://shop.fluxfilm.in';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 900) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const clone = (x) => JSON.parse(JSON.stringify(x));
const IST = 5.5 * 3600e3, DAY = 86400e3;
const istYmd = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const addYmd = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** DB text (India wall clock) for "day offset from nowMs's India date, at hh:mm:ss". */
const at = (nowMs, off, hms) => addYmd(istYmd(nowMs), off) + ' ' + (hms || '21:00:00');

// ====================================================================== fake database
let T;
function reset() {
  T = { settings: new Map(), customers: [], subs: [], orders: [], coupons: [], usage: [], reminders: [], audits: [], bank: [], tables: {}, queries: [], failAll: false };
}
reset();
const noJoin = (sql) => { if (/\bJOIN\b/i.test(sql)) { const e = new Error('Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT): ' + sql); e.code = 'ER_CANT_AGGREGATE_2COLLATIONS'; throw e; } };
const noTable = (t) => { const e = new Error("Table 'db." + t + "' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; return e; };
const likeRe = (pat) => new RegExp('^' + String(pat).replace(/\\_|[.*+?^${}()|[\]\\]|%|_/g, (m) => (m === '\\_' ? '_' : m === '%' ? '.*' : m === '_' ? '.' : '\\' + m)) + '$');
function jsonSet(rawText, tokens, params) {
  const obj = typeof rawText === 'object' && rawText ? rawText : (rawText ? JSON.parse(rawText) : {});
  const vals = tokens.map((t) => (t === '?' ? params.shift() : t.replace(/^'|'$/g, '')));
  for (let i = 0; i < vals.length; i += 2) obj[String(vals[i]).replace(/^\$\./, '')] = vals[i + 1];
  return JSON.stringify(obj);
}
function tableRows(name) {
  if (name === 'app_settings') return [...T.settings.entries()].map(([k, v]) => ({ setting_key: k, value: v, updated_at: '2026-09-16 10:00:00' }));
  if (name === 'customers') return T.customers; if (name === 'orders') return T.orders; if (name === 'subscriptions') return T.subs;
  if (name === 'coupons') return T.coupons; if (name === 'coupon_usage') return T.usage; if (name === 'reminder_log') return T.reminders;
  if (name === 'audit_log') return T.audits; if (name === 'bank_credits') return T.bank;
  if (T.tables[name]) return T.tables[name];
  return null;
}
async function q(sqlRaw, p) {
  const sql = String(sqlRaw).replace(/\s+/g, ' ').trim(); p = (p || []).slice();
  T.queries.push(sql);
  noJoin(sql);
  if (T.failAll) throw new Error('database is down');
  await new Promise((r) => setImmediate(r));
  // ---- app_settings
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return T.settings.has(p[0]) ? [{ value: T.settings.get(p[0]) }] : [];
  if (/^INSERT INTO app_settings \(setting_key, value\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE value = VALUES\(value\)$/.test(sql)) { T.settings.set(p[0], p[1]); return { affectedRows: 1 }; }
  if (/^SELECT setting_key, value FROM app_settings WHERE setting_key IN \(/.test(sql)) return p.filter((k) => T.settings.has(k)).map((k) => ({ setting_key: k, value: T.settings.get(k) }));
  if (/^INSERT INTO audit_log/.test(sql)) { T.audits.push({ id: T.audits.length + 1, action: p[0], entity: p[1], entity_id: p[2], summary: p[3], details: p[4] }); return { affectedRows: 1 }; }
  if (/information_schema\.columns/.test(sql)) return [{ n: 4 }];
  if (/information_schema\.KEY_COLUMN_USAGE/.test(sql)) return { orders: [{ c: 'order_id' }], customers: [{ c: 'phone' }], app_settings: [{ c: 'setting_key' }], inventory_accounts: [{ c: 'account_id' }] }[p[0]] || [];
  if (sql === 'SELECT 1 AS ok') return [{ ok: 1 }];
  // ---- customers
  if (/^SELECT phone, phone_norm, name, email, raw_json FROM customers WHERE phone_norm IN \(/.test(sql)) return T.customers.filter((c) => p.includes(c.phone_norm)).map(clone);
  if (/^SELECT phone_norm, name FROM customers WHERE phone_norm IN \(/.test(sql)) return T.customers.filter((c) => p.includes(c.phone_norm)).map((c) => ({ phone_norm: c.phone_norm, name: c.name }));
  if (/^SELECT phone FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map((c) => ({ phone: c.phone }));
  if (/^SELECT raw_json FROM customers WHERE phone_norm = \? LIMIT 1$/.test(sql)) return T.customers.filter((c) => c.phone_norm === p[0]).map((c) => ({ raw_json: c.raw_json }));
  let m = sql.match(/^UPDATE customers SET raw_json = JSON_SET\(COALESCE\(raw_json, JSON_OBJECT\(\)\), (.+)\) WHERE phone_norm = \? LIMIT 1$/);
  if (m) {
    const tokens = m[1].split(', ');
    const nArgs = tokens.filter((t) => t === '?').length;
    const ph = p[nArgs];
    const c = T.customers.find((x) => x.phone_norm === ph); if (!c) return { affectedRows: 0 };
    c.raw_json = jsonSet(c.raw_json, tokens, p.slice(0, nArgs));
    return { affectedRows: 1 };
  }
  // ---- subscriptions
  if (/^SELECT sub_id, phone_norm FROM subscriptions WHERE expiry_date >= \? AND expiry_date < \? ORDER BY expiry_date ASC LIMIT 3000$/.test(sql)) return T.subs.filter((s) => s.expiry_date >= p[0] && s.expiry_date < p[1]).map((s) => ({ sub_id: s.sub_id, phone_norm: s.phone_norm }));
  if (/^SELECT phone_norm FROM subscriptions WHERE expiry_date >= \? AND expiry_date < \? LIMIT 3000$/.test(sql)) return T.subs.filter((s) => s.expiry_date >= p[0] && s.expiry_date < p[1]).map((s) => ({ phone_norm: s.phone_norm }));
  if (/^SELECT sub_id, order_id, phone_norm, email, service, plan, start_date, expiry_date, status, fulfillment_status, COALESCE\(removed, 0\) AS removed(, group_index)? FROM subscriptions WHERE phone_norm IN \(/.test(sql)) return T.subs.filter((s) => p.includes(s.phone_norm)).map((s) => Object.assign({ removed: 0, group_index: null, email: '' }, clone(s)));
  if (/^SELECT sub_id, order_id, phone_norm, service, plan, expiry_date, status, fulfillment_status(, group_index)? FROM subscriptions WHERE expiry_date >= \? AND expiry_date < \? ORDER BY expiry_date ASC LIMIT 2000$/.test(sql)) return T.subs.filter((s) => s.expiry_date >= p[0] && s.expiry_date < p[1]).map(clone);
  if (/^SELECT sub_id, expiry_date FROM subscriptions WHERE sub_id = \? LIMIT 1$/.test(sql)) return T.subs.filter((s) => s.sub_id === p[0]).map((s) => ({ sub_id: s.sub_id, expiry_date: s.expiry_date }));
  if (/^SELECT COUNT\(\*\) AS n FROM subscriptions WHERE UPPER\(COALESCE\(fulfillment_status, ''\)\) = 'MANUAL_PENDING'/.test(sql)) return [{ n: T.subs.filter((s) => s.fulfillment_status === 'MANUAL_PENDING' && s.status === 'ACTIVE').length }];
  // ---- orders
  if (/^SELECT order_id, phone_norm, service, status, fulfillment_status, order_type, created_at_sheet FROM orders WHERE phone_norm IN \(.+\) AND created_at_sheet >= \?$/.test(sql)) { const since = p.pop(); return T.orders.filter((o) => p.includes(o.phone_norm) && o.created_at_sheet >= since).map(clone); }
  if (/^SELECT order_id, service, plan, final_amount, order_type, name, verified_at FROM orders WHERE UPPER\(status\) = 'PAID' AND verified_at >= \? ORDER BY verified_at ASC LIMIT 300$/.test(sql)) return T.orders.filter((o) => o.status === 'PAID' && o.verified_at && o.verified_at >= p[0]).sort((a, b) => a.verified_at.localeCompare(b.verified_at)).map(clone);
  if (/^SELECT order_id, service, plan, final_amount, order_type, name, fulfilled_at FROM orders WHERE UPPER\(fulfillment_status\) = 'FULFILLED' AND fulfilled_at >= \? ORDER BY fulfilled_at ASC LIMIT 300$/.test(sql)) return T.orders.filter((o) => o.fulfillment_status === 'FULFILLED' && o.fulfilled_at && o.fulfilled_at >= p[0]).map(clone);
  if (/^SELECT MAX\(verified_at\) AS at FROM orders/.test(sql)) return [{ at: T.orders.filter((o) => o.status === 'PAID').map((o) => o.verified_at).sort().pop() || null }];
  if (/^SELECT MAX\(received_at\) AS at FROM bank_credits$/.test(sql)) return [{ at: '2026-09-16 09:00:00' }];
  if (/^SELECT 1 FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID' LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.phone_norm === p[0] && o.status === 'PAID').slice(0, 1);
  // ---- reminder_log
  if (/^SELECT sub_id, channel, kind, expiry_date, ts FROM reminder_log WHERE sub_id IN \(.+\) AND channel LIKE 'N8N%'$/.test(sql)) return T.reminders.filter((r) => p.includes(r.sub_id) && /^N8N/.test(r.channel)).map(clone);
  if (/^SELECT ts FROM reminder_log WHERE sub_id = \? AND channel = \? AND kind = \? AND expiry_date = \? LIMIT 1$/.test(sql)) return T.reminders.filter((r) => r.sub_id === p[0] && r.channel === p[1] && r.kind === p[2] && r.expiry_date === p[3]).map((r) => ({ ts: r.ts }));
  if (/^INSERT INTO reminder_log \(ts, sub_id, channel, kind, expiry_date, ok, note\) VALUES \(\?, \?, \?, \?, \?, 1, \?\)$/.test(sql)) { T.reminders.push({ id: T.reminders.length + 1, ts: p[0], sub_id: p[1], channel: p[2], kind: p[3], expiry_date: p[4], ok: 1, note: p[5] }); return { affectedRows: 1 }; }
  // ---- coupons
  if (/^SELECT code FROM coupons WHERE code = \? LIMIT 1$/.test(sql)) return T.coupons.filter((c) => c.code === p[0]).map((c) => ({ code: c.code }));
  if (/^SELECT code, expiry, active, raw_json FROM coupons WHERE code = \? LIMIT 1$/.test(sql)) return T.coupons.filter((c) => c.code === p[0]).map(clone);
  if (/^INSERT INTO coupons \(code, description, scope, type, value, min_amount, max_discount, expiry, per_user_limit, global_limit, active, show_in_profile, allowed_phones, first_time_only, raw_json\)/.test(sql)) {
    const cols = ['code', 'description', 'scope', 'type', 'value', 'min_amount', 'max_discount', 'expiry', 'per_user_limit', 'global_limit', 'active', 'show_in_profile', 'allowed_phones', 'first_time_only', 'raw_json'];
    T.coupons.push(Object.fromEntries(cols.map((c, i) => [c, p[i]]))); return { affectedRows: 1 };
  }
  if (sql === 'SELECT raw_json FROM coupons') return T.coupons.map((c) => ({ raw_json: c.raw_json }));
  if (/^SELECT COUNT\(\*\) AS n FROM coupon_usage WHERE UPPER\(coupon_code\) = \? AND UPPER\(action\) = 'USED'$/.test(sql)) return [{ n: T.usage.filter((u) => u.coupon_code.toUpperCase() === p[0] && u.action === 'USED').length }];
  if (/^SELECT COUNT\(\*\) n, SUM\(phone_norm = \?\) mine FROM coupon_usage/.test(sql)) { const list = T.usage.filter((u) => u.coupon_code.toUpperCase() === p[1] && u.action === 'USED'); return [{ n: list.length, mine: list.filter((u) => u.phone_norm === p[0]).length }]; }
  // ---- backup: generic tables
  m = sql.match(/^SELECT COUNT\(\*\) AS n FROM `(\w+)`( WHERE .+)?$/);
  if (m) {
    let rows = tableRows(m[1]); if (!rows) throw noTable(m[1]);
    if (m[1] === 'app_settings' && m[2]) rows = rows.filter((r) => p.every((pat) => !likeRe(pat).test(r.setting_key)));
    return [{ n: rows.length }];
  }
  m = sql.match(/^SELECT (\*|video_id, n, LENGTH\(data\) AS size_bytes) FROM `(\w+)`( WHERE .+?)?( ORDER BY .+?)? LIMIT (\d+) OFFSET (\d+)$/);
  if (m) {
    let rows = tableRows(m[2]); if (!rows) throw noTable(m[2]);
    if (m[2] === 'app_settings' && m[3]) rows = rows.filter((r) => p.every((pat) => !likeRe(pat).test(r.setting_key)));
    T.pages = (T.pages || 0) + 1;
    rows = rows.slice(+m[6], +m[6] + +m[5]);
    if (m[1] !== '*') rows = rows.map((r) => ({ video_id: r.video_id, n: r.n, size_bytes: r.data.length }));
    return rows.map((r) => Object.assign({}, r));
  }
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 200));
}
const mockDb = { ENABLED: true, query: q, getPool: () => null, ping: async () => ({ ok: true }) };

// ---------------- other fakes
let FEED = { posts: [], info: [] };
const fakeFeed = {
  publicList: async () => ({ ok: true, posts: clone(FEED.posts) }),
  catalogServiceInfo: async () => clone(FEED.info),
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './feed') return fakeFeed;
  if (req === './payments') return { status: () => ({ configured: true, watching: true, connected: true, lastScanAt: '2026-09-16T04:00:00.000Z' }), findByOrder: async () => null, findByRef: async () => null };
  if (req === './mailer') return { send: async () => ({ ok: true }), sendAccessEmail: async () => ({ ok: true }) };
  return origLoad.apply(this, arguments);
};

const express = require('express');
function listen(app) { return new Promise((res) => { const srv = app.listen(0, '127.0.0.1', () => res(srv)); }); }
async function call(base, method, pathQ, opts) {
  const o = opts || {};
  const r = await fetch(base + pathQ, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, o.headers || {}), body: o.body ? JSON.stringify(o.body) : undefined, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
  return { status: r.status, json, buf, headers: r.headers, text: buf.toString('utf8') };
}

(async () => {
  const n8n = require('../n8n');
  const hooks = require('../n8nhooks');
  const backup = require('../n8nbackup');
  const restore = require('../scripts/restore-backup');
  const order = require('../order');
  const I = n8n._internal;

  // ==================================================================== 1. API key
  section('n8n API key: hashed, shown once, rotate, revoke, URL refused, rate limit, every call logged');
  reset(); I.reset();
  let g1 = await n8n.generateKey();
  const stored = T.settings.get('n8n_settings');
  ok('key looks like ffn8n_… with 43 random chars', /^ffn8n_[A-Za-z0-9_-]{43}$/.test(g1.key), g1.key);
  ok('only a hash is stored (the key itself is nowhere in app_settings)', !stored.includes(g1.key) && JSON.parse(stored).key.hash === n8n.keyHash(g1.key) && JSON.parse(stored).key.hash.length === 64);
  ok('HMAC-SHA256, not a plain sha256 of the key', n8n.keyHash(g1.key) !== crypto.createHash('sha256').update(g1.key).digest('hex'));
  ok('public info has the prefix but no hash', g1.info.set && g1.info.prefix === g1.key.slice(0, 10) && !('hash' in g1.info));
  ok('the right key passes, a wrong one fails', (await n8n.checkKey(g1.key)) === true && (await n8n.checkKey(g1.key + 'x')) === false && (await n8n.checkKey('')) === false);
  I.reset();
  const g2 = await n8n.generateKey();
  I.reset();
  ok('rotate: the old key stops working, the new one works', (await n8n.checkKey(g1.key)) === false && (await n8n.checkKey(g2.key)) === true && g2.info.rotated === true);
  await n8n.revokeKey(); I.reset();
  ok('revoke: no key works', (await n8n.checkKey(g2.key)) === false && n8n.publicKeyInfo((await n8n.getSettings(true)).key).set === false);

  I.reset();
  const g3 = await n8n.generateKey();
  const appA = express(); appA.use(express.json());
  n8n.mount(appA, { keyLimit: 5, failLimit: 4, backup });
  const srvA = await listen(appA); const A = 'http://127.0.0.1:' + srvA.address().port;
  const H = { 'X-N8N-Key': g3.key };
  let r = await call(A, 'GET', '/n8n/api/expiring?when=today');
  ok('no header → 401', r.status === 401 && /X-N8N-Key/.test(r.json.message), r);
  r = await call(A, 'GET', '/n8n/api/expiring?when=today&key=' + g3.key, { headers: H });
  ok('a key in the URL is refused (400) even with a right header', r.status === 400 && /URL/.test(r.json.message), r.json);
  r = await call(A, 'GET', '/n8n/api/expiring?when=today&apiKey=abc');
  ok('…any key-like query name', r.status === 400);
  ok('the refusal is in the change log', T.audits.some((a) => a.action === 'n8n.refused'));
  r = await call(A, 'GET', '/n8n/api/expiring?when=today', { headers: H });
  ok('right header → 200 JSON', r.status === 200 && r.json.ok === true && Array.isArray(r.json.items) && /no-store/.test(r.headers.get('cache-control')), r.json);
  await new Promise((res) => setTimeout(res, 30));
  ok('every call is logged compactly (action n8n.api, path + query + status)', T.audits.some((a) => a.action === 'n8n.api' && /GET \/n8n\/api\/expiring when=today → 200/.test(a.summary)), T.audits.map((a) => a.summary));
  ok('no key or secret in the change log', !JSON.stringify(T.audits).includes(g3.key));
  ok('last-used time is saved', !!JSON.parse(T.settings.get('n8n_settings')).key.lastUsedAt);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call(A, 'GET', '/n8n/api/expiring?when=today', { headers: H })).status);
  ok('rate limit per key: calls over the limit → 429 with Retry-After', codes.includes(429), codes);
  r = await call(A, 'GET', '/n8n/api/nope', { headers: H });
  ok('unknown /n8n/api path → JSON 404 (never the storefront page)', r.status === 404 && r.json && r.json.ok === false);
  const wrong = [];
  for (let i = 0; i < 6; i++) wrong.push((await call(A, 'GET', '/n8n/api/health', { headers: { 'X-N8N-Key': 'ffn8n_wrong' } })).status);
  ok('wrong keys from one IP are limited too (401… then 429)', wrong[0] === 401 && wrong[wrong.length - 1] === 429, wrong);
  srvA.close();

  // ==================================================================== 2. expiring
  section('GET expiring: India calendar days, the pop-up skip rules, fields');
  reset(); I.reset();
  // 16 Sep 2026, 00:30 India time = 15 Sep 19:00 UTC. UTC maths would put every date one day off.
  const NOW = Date.UTC(2026, 8, 15, 19, 0);
  ok('test clock is 16 Sep in India', istYmd(NOW) === '2026-09-16');
  const cust = (ph, name, email, raw) => T.customers.push({ phone: ph, phone_norm: ph, name, email, raw_json: JSON.stringify(raw || {}) });
  let sid = 0;
  const sub = (ph, off, extra) => { const x = Object.assign({ sub_id: 'SUB' + (++sid), order_id: 'FF' + sid, phone_norm: ph, email: '', service: 'Netflix', plan: 'Sharing 1M', start_date: at(NOW, off - 30), expiry_date: at(NOW, off), status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0, group_index: null }, extra || {}); T.subs.push(x); return x; };
  cust('9000000001', 'asha verma', 'asha@example.com'); const sA = sub('9000000001', 3, { expiry_date: at(NOW, 3, '00:10:00') });
  cust('9000000002', 'Ravi', 'ravi@example.com'); const sB = sub('9000000002', 3, { expiry_date: at(NOW, 3, '23:59:00') });
  cust('9000000003', 'Test', 'bad-email'); const sC = sub('9000000003', 2, { expiry_date: at(NOW, 2, '23:59:59') }); // 2 days → not in BEFORE_3
  cust('9000000004', 'Refunded', 'r@example.com'); sub('9000000004', 3, { status: 'CANCELLED', fulfillment_status: 'REFUNDED' });
  cust('9000000005', 'Removed', 'rm@example.com'); sub('9000000005', 3, { removed: 1 });
  cust('9000000006', 'Renewed', 're@example.com'); const sF = sub('9000000006', 3); sub('9000000006', 33, { start_date: at(NOW, 1) }); // newer plan started around the end
  cust('9000000007', 'Paying', 'p@example.com'); const sG = sub('9000000007', 3);
  T.orders.push({ order_id: 'FFPAY', phone_norm: '9000000007', service: 'Netflix', status: 'PAID', fulfillment_status: 'PENDING', order_type: 'RENEW', created_at_sheet: at(NOW, -1, '10:00:00') });
  cust('9000000008', 'Group', 'g@example.com'); const sH1 = sub('9000000008', 3, { group_index: 1 }); const sH2 = sub('9000000008', 3, { group_index: 2 });
  cust('9000000009', 'Other service', 'o@example.com'); const sI = sub('9000000009', 3); sub('9000000009', 40, { service: 'Prime Video', start_date: at(NOW, 1) });
  sub('9000000010', 3, { email: 'nocust@example.com' }); // no customers row: still reminded, email from the subscription
  cust('9000000011', 'Opted Out', 'oo@example.com', { ReminderEmailOptOut: 'TRUE' }); const sK = sub('9000000011', 3);
  cust('9000000012', 'Today', 't@example.com'); const sT = sub('9000000012', 0, { expiry_date: at(NOW, 0, '00:05:00') });
  cust('9000000013', 'Ended1', 'e1@example.com'); const sE1 = sub('9000000013', -1, { status: 'EXPIRED' });
  cust('9000000014', 'Ended2', 'e2@example.com'); const sE2 = sub('9000000014', -2, { status: 'EXPIRED', expiry_date: at(NOW, -2, '00:00:00') });
  cust('9000000015', 'Ended3', 'e3@example.com'); sub('9000000015', -3, { status: 'EXPIRED' });

  let ex = await n8n.expiring({ when: 'before', days: '3' }, { now: NOW });
  const ids = (x) => x.items.map((i) => i.subId).sort();
  ok('before 3: India days (00:10 and 23:59 on 19 Sep both count, 18 Sep 23:59:59 does not)', ids(ex).includes(sA.sub_id) && ids(ex).includes(sB.sub_id) && !ids(ex).includes(sC.sub_id), ex.items.map((i) => [i.subId, i.daysLeft]));
  ok('skips refunded / cancelled', !T.subs.filter((s) => s.phone_norm === '9000000004').some((s) => ids(ex).includes(s.sub_id)));
  ok('skips removed', !T.subs.filter((s) => s.phone_norm === '9000000005').some((s) => ids(ex).includes(s.sub_id)));
  ok('skips already renewed (newer plan of the same service started around the end)', !ids(ex).includes(sF.sub_id));
  ok('skips a paid renewal still being delivered', !ids(ex).includes(sG.sub_id));
  ok('one reminder per purchase: device row 2 is skipped', ids(ex).includes(sH1.sub_id) && !ids(ex).includes(sH2.sub_id));
  ok('a newer plan of ANOTHER service does not count as renewed', ids(ex).includes(sI.sub_id));
  ok('kind BEFORE_3 on every item', ex.kind === 'BEFORE_3' && ex.items.every((i) => i.kind === 'BEFORE_3'));
  const a1 = ex.items.find((i) => i.subId === sA.sub_id);
  ok('fields: first name, service, plan, expiry (India), daysLeft 3', a1.firstName === 'Asha' && a1.greetingName === 'Asha' && a1.service === 'Netflix' && a1.plan === 'Sharing 1M' && a1.expiry === '2026-09-19 00:10' && a1.expiryText === '19 Sep 2026' && a1.daysLeft === 3, a1);
  ok('renew link = the real deep link (/?source=push&renew=<subId>)', a1.renewUrl === 'https://shop.fluxfilm.in/?source=push&renew=' + sA.sub_id);
  ok('phone in E.164, email only when present', a1.phone === '+919000000001' && a1.email === 'asha@example.com' && a1.lastReminderAt === null);
  const noCust = ex.items.find((i) => i.phone === '+919000000010');
  ok('no customers row: still listed, email from the subscription, greeting "there"', noCust && noCust.email === 'nocust@example.com' && noCust.greetingName === 'there', noCust);
  const kOpt = ex.items.find((i) => i.subId === sK.sub_id);
  ok('reminder-email opt-out: listed (service message) but no email', kOpt && kOpt.email === null && kOpt.emailOptOut === true);
  ok('unsubscribe link decodes back to that phone only on the server', /^https:\/\/shop\.fluxfilm\.in\/unsubscribe\?t=[A-Za-z0-9_-]+$/.test(a1.unsubscribeUrl) && !a1.unsubscribeUrl.includes('9000000001') && (await n8n.readUnsubToken(a1.unsubscribeUrl.split('t=')[1])) === '9000000001');
  ex = await n8n.expiring({ when: 'today' }, { now: NOW });
  ok('today: EXPIRY_DAY (00:05 today counts)', ex.kind === 'EXPIRY_DAY' && ids(ex).join() === sT.sub_id, ids(ex));
  ex = await n8n.expiring({ when: 'after', days: 2 }, { now: NOW });
  ok('after 2: ended 1 or 2 days ago (not 3), kind AFTER', ex.kind === 'AFTER' && ids(ex).includes(sE1.sub_id) && ids(ex).includes(sE2.sub_id) && ids(ex).length === 2, ex.items.map((i) => [i.subId, i.daysLeft]));
  ok('bad params → 400', (await n8n.expiring({ when: 'before', days: 0 })).status === 400 && (await n8n.expiring({ when: 'soon' })).status === 400 && (await n8n.expiring({ when: 'after', days: 9 })).status === 400 && (await n8n.expiring({ when: 'today', channel: 'pigeon' })).status === 400);
  ok('every query touches one table (no JOIN)', T.queries.every((x) => !/\bJOIN\b/i.test(x)));

  section('POST reminder-sent: records once (idempotent), lastReminderAt, unsent filter per channel');
  let rs = await n8n.reminderSent({ subId: sA.sub_id, kind: 'BEFORE_3', channel: 'email' });
  ok('first time: recorded', rs.ok && rs.already === false && T.reminders.length === 1 && T.reminders[0].channel === 'N8N_EMAIL' && T.reminders[0].expiry_date === sA.expiry_date, rs);
  rs = await n8n.reminderSent({ subId: sA.sub_id, kind: 'BEFORE_3', channel: 'email' });
  ok('second time: "already", nothing new written', rs.ok && rs.already === true && T.reminders.length === 1);
  const both = await Promise.all([n8n.reminderSent({ subId: sB.sub_id, kind: 'BEFORE_3', channel: 'email' }), n8n.reminderSent({ subId: sB.sub_id, kind: 'BEFORE_3', channel: 'email' })]);
  ok('two calls at the same moment still write one row', T.reminders.filter((x) => x.sub_id === sB.sub_id).length === 1 && both.filter((x) => x.already).length === 1, both);
  ex = await n8n.expiring({ when: 'before', days: 3, channel: 'email' }, { now: NOW });
  ok('lastReminderAt shows on the next /expiring', !!ex.items.find((i) => i.subId === sA.sub_id).lastReminderAt);
  ex = await n8n.expiring({ when: 'before', days: 3, channel: 'email', unsent: 1 }, { now: NOW });
  ok('unsent=1 leaves out what was already emailed', !ids(ex).includes(sA.sub_id) && !ids(ex).includes(sB.sub_id) && ids(ex).includes(sI.sub_id));
  ex = await n8n.expiring({ when: 'before', days: 3, channel: 'telegram', unsent: 1 }, { now: NOW });
  ok('…per channel (Telegram not sent yet)', ids(ex).includes(sA.sub_id));
  ok('a renewal (new expiry) re-arms the reminder', await (async () => { const old = sA.expiry_date; sA.expiry_date = at(NOW, 3, '08:00:00'); const e2 = await n8n.expiring({ when: 'before', days: 3, channel: 'email', unsent: 1 }, { now: NOW }); sA.expiry_date = old; return e2.items.some((i) => i.subId === sA.sub_id); })());
  ok('bad kind / channel → 400, unknown sub → 404', (await n8n.reminderSent({ subId: sA.sub_id, kind: 'SOON', channel: 'email' })).status === 400 && (await n8n.reminderSent({ subId: sA.sub_id, kind: 'AFTER', channel: 'fax' })).status === 400 && (await n8n.reminderSent({ subId: 'NOPE', kind: 'AFTER', channel: 'email' })).status === 404);
  ok('uses the pop-up rules from index.html (rrSkipped_ / rrRenewed_ / rrDaysLeft_)', typeof I.rr().rrRenewed_ === 'function' && typeof I.rr().rrSkipped_ === 'function');
  const tmpIndex = path.join(require('os').tmpdir(), 'ff-n8n-noindex-' + process.pid + '.html');
  fs.writeFileSync(tmpIndex, '<html>no rules</html>');
  n8n.setIndexPath(tmpIndex);
  let threw = ''; try { await n8n.expiring({ when: 'today' }, { now: NOW }); } catch (e) { threw = e.message; }
  ok('if index.html lost the pop-up rules, /expiring fails loudly (never guesses)', /RR_PURE_START/.test(threw), threw);
  n8n.setIndexPath(path.join(ROOT, 'index.html')); fs.unlinkSync(tmpIndex);

  // ==================================================================== 3. win-back
  section('GET winback: candidates, personal coupon (idempotent, raw_json = typed columns, couponDiscount accepts), opt-out');
  reset(); I.reset();
  const NW = Date.now();
  const wsub = (ph, off, extra) => { const x = Object.assign({ sub_id: 'W' + (++sid), order_id: 'FW' + sid, phone_norm: ph, email: '', service: 'Netflix', plan: 'Sharing 1M', start_date: at(NW, off - 30), expiry_date: at(NW, off, '12:00:00'), status: 'EXPIRED', fulfillment_status: 'FULFILLED', removed: 1 }, extra || {}); T.subs.push(x); return x; };
  const wcust = (ph, name, raw) => T.customers.push({ phone: ph, phone_norm: ph, name, email: name.toLowerCase().replace(/\W/g, '') + '@example.com', raw_json: raw === null ? null : JSON.stringify(raw || {}) });
  wcust('9100000001', 'Anil', null); wsub('9100000001', -15);                                                   // A in
  wcust('9100000002', 'Bina'); wsub('9100000002', -15); wsub('9100000002', 10, { service: 'Prime Video', status: 'ACTIVE' }); // B has an active plan
  wcust('9100000003', 'Chetan'); wsub('9100000003', -15); wsub('9100000003', 14, { status: 'ACTIVE' });        // C renewed (new plan ends later)
  wcust('9100000004', 'Deepa', { MarketingOptOut: 'TRUE' }); wsub('9100000004', -15);                           // D opted out
  wcust('9100000005', 'Esha', { WinbackWB15SentAt: at(NW, -10, '11:00:00') }); wsub('9100000005', -15);         // E messaged 10 days ago
  wcust('9100000006', 'Farhan', { WinbackWB15SentAt: at(NW, -70, '11:00:00') }); wsub('9100000006', -16);       // F messaged 70 days ago → in
  wcust('9100000007', 'Gita'); wsub('9100000007', -15);
  T.orders.push({ order_id: 'FWPAID', phone_norm: '9100000007', service: 'Netflix', status: 'PAID', fulfillment_status: 'PENDING', order_type: 'NEW', created_at_sheet: at(NW, -2, '10:00:00') }); // G paid again
  wcust('9100000008', 'Hari'); wsub('9100000008', -15, { status: 'REFUNDED', fulfillment_status: 'REFUNDED' });  // H only a refunded plan
  wcust('9100000009', 'Isha'); wsub('9100000009', -17);                                                          // I 17 days (window 3) → in
  wcust('9100000010', 'Jai'); wsub('9100000010', -20);                                                           // J too long ago
  wsub('9100000011', -15);                                                                                       // K no customers row

  let wb = await n8n.winback({ afterDays: 15 }, { now: NW });
  const phones = (x) => x.items.map((i) => i.phone).sort();
  ok('candidates: ended 15-17 days ago, no active plan, not renewed, not opted out, not messaged in 60 days',
    phones(wb).join() === ['+919100000001', '+919100000006', '+919100000009'].join(), { got: phones(wb) });
  const wa = wb.items.find((i) => i.phone === '+919100000001');
  ok('item fields: name, email, last service / plan, campaign WB15, offer text', wa.firstName === 'Anil' && wa.email === 'anil@example.com' && wa.lastService === 'Netflix' && wa.lastPlan === 'Sharing 1M' && wa.campaign === 'WB15' && wa.offer === '15% off (up to ₹50)', wa);
  ok('coupon code WB + 6, expires in 7 days (end of day, India)', /^WB[A-Z2-9]{6}$/.test(wa.couponCode) && wa.couponExpiry === addYmd(istYmd(NW), 7) + ' 23:59:59', wa);
  ok('links: /?coupon=CODE and /?buy=netflix&coupon=CODE', wa.shopUrl === 'https://shop.fluxfilm.in/?coupon=' + wa.couponCode && wa.buyUrl === 'https://shop.fluxfilm.in/?buy=netflix&coupon=' + wa.couponCode, wa);
  const row = T.coupons.find((c) => c.code === wa.couponCode);
  const craw = JSON.parse(row.raw_json);
  ok('typed columns and raw_json agree', row.type === craw.Type && row.value === craw.Value && row.max_discount === craw.MaxDiscount && row.expiry === craw.Expiry && row.allowed_phones === craw.AllowedPhones && row.per_user_limit === craw.PerUserLimit && row.global_limit === craw.GlobalLimit && row.active === craw.Active && row.scope === craw.Scope && row.code === craw.Code && craw.CouponCode === row.code, { row, craw });
  ok('personal + one use: only their phone, PerUserLimit 1, GlobalLimit 1, new AND renew (scope ANY), shown in profile', craw.AllowedPhones === '9100000001' && craw.PerUserLimit === 1 && craw.GlobalLimit === 1 && craw.Scope === 'ANY' && craw.ShowInProfile === 'TRUE' && craw.Type === 'PERCENT' && craw.Value === 15 && craw.MaxDiscount === 50 && craw.Source === 'WINBACK');
  ok('customer raw_json remembers the code (JSON_SET, even when raw_json was NULL)', JSON.parse(T.customers.find((c) => c.phone_norm === '9100000001').raw_json).WinbackWB15Code === wa.couponCode);
  let cd = await order._internal.couponDiscount(wa.couponCode, '9100000001', 200, { action: 'NEW', service: 'Netflix', plan: 'Sharing 1M' });
  ok('order.js couponDiscount accepts it for a new order: 15% of ₹200 = ₹30', cd.ok && Math.round(cd.discount) === 30, cd);
  cd = await order._internal.couponDiscount(wa.couponCode, '9100000001', 900, { action: 'RENEW' });
  ok('…for a renewal, capped at ₹50', cd.ok && Math.round(cd.discount) === 50, cd);
  cd = await order._internal.couponDiscount(wa.couponCode, '9999999999', 200, { action: 'NEW' });
  ok('…refused for another phone', !cd.ok && /not valid for this number/i.test(cd.message), cd);
  const couponsBefore = T.coupons.length;
  wb = await n8n.winback({ afterDays: 15 }, { now: NW });
  ok('idempotent: the same code again, no new coupon row', wb.items.find((i) => i.phone === '+919100000001').couponCode === wa.couponCode && T.coupons.length === couponsBefore && wb.items.every((i) => i.couponCreated === false));
  T.usage.push({ coupon_code: wa.couponCode, phone_norm: '9100000001', action: 'USED' });
  wb = await n8n.winback({ afterDays: 15 }, { now: NW });
  const wa2 = wb.items.find((i) => i.phone === '+919100000001');
  ok('a used coupon is not handed out again (new code)', wa2.couponCode !== wa.couponCode && wa2.couponCreated === true);
  let ws = await n8n.winbackSent({ phone: '+919100000001', campaign: 'WB15' }, { now: NW });
  ok('winback-sent: recorded', ws.ok && ws.already === false && JSON.parse(T.customers.find((c) => c.phone_norm === '9100000001').raw_json).WinbackWB15SentAt);
  ws = await n8n.winbackSent({ phone: '9100000001', campaign: 'WB15' }, { now: NW });
  ok('winback-sent again: "already" (idempotent)', ws.ok && ws.already === true);
  wb = await n8n.winback({ afterDays: 15 }, { now: NW });
  ok('after winback-sent the customer is not listed for 60 days', !phones(wb).includes('+919100000001'));
  ok('bad params → 400 / unknown customer → 404', (await n8n.winback({ afterDays: 3 })).status === 400 && (await n8n.winbackSent({ phone: '1', campaign: 'WB15' })).status === 400 && (await n8n.winbackSent({ phone: '9100000009', campaign: 'X' })).status === 400 && (await n8n.winbackSent({ phone: '9100000011', campaign: 'WB15' })).status === 404);
  // 30-day campaign: different coupon settings.
  wcust('9100000030', 'Tara'); wsub('9100000030', -30);
  wb = await n8n.winback({ afterDays: 30 }, { now: NW });
  const w30 = wb.items.find((i) => i.phone === '+919100000030');
  ok('30-day campaign WB30 with its own coupon (20% up to ₹75)', w30 && w30.campaign === 'WB30' && w30.offer === '20% off (up to ₹75)' && JSON.parse(T.coupons.find((c) => c.code === w30.couponCode).raw_json).Value === 20, wb.items);

  section('unsubscribe: signed token, page, opt-out honoured by win-back and reminders');
  const tok = await n8n.unsubToken('9100000009');
  ok('token round trip', (await n8n.readUnsubToken(tok)) === '9100000009');
  const bad = Buffer.from(tok, 'base64url'); bad[14] ^= 1;
  ok('a changed token is refused', (await n8n.readUnsubToken(bad.toString('base64url'))) === null && (await n8n.readUnsubToken('abc')) === null && (await n8n.readUnsubToken('')) === null);
  const appU = express(); appU.use(express.json()); n8n.mount(appU, { backup });
  const srvU = await listen(appU); const U = 'http://127.0.0.1:' + srvU.address().port;
  r = await call(U, 'GET', '/unsubscribe?t=' + tok);
  ok('GET page: two choices, a POST form, no phone number shown, strict CSP', r.status === 200 && /Stop offer emails/.test(r.text) && /method="post"/.test(r.text) && !r.text.includes('9100000009') && /default-src 'none'/.test(r.headers.get('content-security-policy')), r.text.slice(0, 300));
  r = await call(U, 'GET', '/unsubscribe?t=broken');
  ok('bad token → 400 friendly page', r.status === 400 && /not valid/.test(r.text));
  r = await fetch(U + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(tok) + '&what=offers' });
  ok('POST offers → saved', r.status === 200 && /Saved/.test(await r.text()) && JSON.parse(T.customers.find((c) => c.phone_norm === '9100000009').raw_json).MarketingOptOut === 'TRUE');
  ok('customer typed columns untouched (only raw_json)', T.customers.find((c) => c.phone_norm === '9100000009').email === 'isha@example.com');
  wb = await n8n.winback({ afterDays: 15 }, { now: NW });
  ok('opted-out customer is no longer a win-back candidate', !phones(wb).includes('+919100000009'));
  const tokK = await n8n.unsubToken('9100000011');
  await fetch(U + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(tokK) + '&what=all' });
  ok('a phone with no customers row keeps its choice in app_settings', [...T.settings.keys()].some((k) => k.startsWith('n8n_optout_')));
  const oo = await (async () => { T.subs.push({ sub_id: 'KX', order_id: 'FKX', phone_norm: '9100000011', email: 'k@example.com', service: 'Netflix', plan: 'Sharing 1M', start_date: at(NW, -27), expiry_date: at(NW, 3, '12:00:00'), status: 'ACTIVE', fulfillment_status: 'FULFILLED', removed: 0 }); return n8n.expiring({ when: 'before', days: 3 }, { now: NW }); })();
  ok('…and /expiring honours it (no email for that phone)', oo.items.find((i) => i.subId === 'KX').email === null, oo.items);
  srvU.close();

  // ==================================================================== 4. posts
  section('GET posts/new: published since, catalog "from ₹X", never TMDB links');
  reset(); I.reset();
  const PN = Date.now();
  FEED.info = [{ service: 'Netflix', minPrice: 149 }, { service: 'Netflix (Group Offer)', minPrice: 99 }, { service: 'Prime Video', minPrice: 49 }];
  FEED.posts = [
    { id: 'p1', type: 'movie', title: 'Old', caption: 'x', genres: ['Drama'], brand: 'Netflix', ctaService: 'Netflix', cta: 'service', date: new Date(PN - 3 * DAY).toISOString(), image: '/poster/w500/abc123.jpg', trailerUrl: '', instagramUrl: '', format: 'post' },
    { id: 'p2', type: 'series', title: 'New Show', caption: 'Watch now', genres: ['Crime', 'Thriller'], brand: 'Netflix', ctaService: 'Netflix (Group', cta: 'service', date: new Date(PN - 2 * 3600e3).toISOString(), image: 'https://image.tmdb.org/t/p/w780/zzz.jpg', trailerUrl: 'https://www.youtube.com/watch?v=abcdefghijk', instagramUrl: '', format: 'post' },
    { id: 'p3', type: 'movie', title: 'Reel', caption: 'Clip', genres: [], brand: 'Prime Video', ctaService: 'Prime Video', cta: 'service', date: new Date(PN - 3600e3).toISOString(), image: '/feed-img/p3t?v=1', video: '/v/fv0123456789abcdef.mp4', trailerUrl: '', instagramUrl: 'https://www.instagram.com/reel/ABC123/', format: 'reel' },
  ];
  let pn = await n8n.postsNew({ since: new Date(PN - DAY).toISOString() }, { now: PN });
  ok('only posts published since the time, oldest first', pn.items.map((x) => x.id).join() === 'p2,p3', pn.items.map((x) => x.id));
  ok('no TMDB URL anywhere in the answer', !/tmdb\.org/i.test(JSON.stringify(pn)));
  ok('image via the shop (/poster, /feed-img) as a full https link', pn.items[1].imageUrl === 'https://shop.fluxfilm.in/feed-img/p3t?v=1' && pn.items[0].imageUrl === '');
  ok('"from ₹X" from the live catalog (Netflix (Group… → cheapest match ₹99; Prime ₹49)', pn.items[0].fromPrice === 99 && pn.items[0].fromPriceText === 'from ₹99' && pn.items[1].fromPrice === 49, pn.items.map((x) => x.fromPrice));
  ok('share links: ?post= for posts, ?reel= for reels', pn.items[0].shareUrl === 'https://shop.fluxfilm.in/?post=p2' && pn.items[1].shareUrl === 'https://shop.fluxfilm.in/?reel=p3');
  ok('title, caption, genres, brand, trailer, Instagram passed through', pn.items[0].title === 'New Show' && pn.items[0].genres.join() === 'Crime,Thriller' && pn.items[1].instagramUrl === 'https://www.instagram.com/reel/ABC123/' && pn.items[0].trailerUrl.includes('youtube'));
  ok('poster route kept: /poster/… becomes https://shop.fluxfilm.in/poster/…', I.absUrl('/poster/w500/abc123.jpg') === 'https://shop.fluxfilm.in/poster/w500/abc123.jpg');
  ok('bad since → 400', (await n8n.postsNew({ since: 'yesterday-ish' })).status === 400);

  // ==================================================================== 5. health
  section('GET health: DB, IMAP, payments, manual deliveries, build fingerprint');
  const hh = await n8n.health();
  const sha12 = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').slice(0, 12);
  ok('fingerprint = first 12 hex of sha256(server.js) and sha256(index.html)', hh.build.serverJs === sha12('server.js') && hh.build.indexHtml === sha12('index.html'), hh.build);
  ok('DB ping ms + ok', hh.db.ok === true && typeof hh.db.ms === 'number' && hh.status === 'ok');
  ok('IMAP watcher status, last payment, pending manual deliveries, version, uptime', hh.imap.connected === true && 'lastPaidOrderAt' in hh.payments && hh.pendingManualDeliveries === 0 && hh.version === require('../package.json').version && typeof hh.uptimeSec === 'number');
  T.failAll = true;
  const hd = await n8n.health();
  T.failAll = false;
  ok('DB down → status db_down (not a crash), fingerprint still there', hd.status === 'db_down' && hd.db.ok === false && hd.build.serverJs === hh.build.serverJs);

  // ==================================================================== 6. backup
  section('backup: refused without passphrase, streams in pages, AES-256-GCM, restore script round trip, exclusions');
  reset(); I.reset();
  const pre0 = await backup.prepare({});
  ok('no passphrase → refused (409), nothing streamed', pre0.ok === false && pre0.status === 409);
  ok('short passphrase refused', (await backup.setPassphrase('short')).ok === false);
  const PASS = 'correct horse battery staple 42';
  const sp = await backup.setPassphrase(PASS);
  ok('passphrase saved as a derived key only (the passphrase is not stored)', sp.ok && !T.settings.get('n8n_secrets').includes(PASS) && JSON.parse(T.settings.get('n8n_secrets')).backup.key.length > 40);
  for (let i = 0; i < 1203; i++) T.orders.push({ order_id: 'FF' + String(i).padStart(6, '0'), service: 'Netflix', status: 'PAID', final_amount: 149, raw_json: JSON.stringify({ OrderID: 'FF' + i, Note: 'ऑर्डर ✅' }) });
  T.customers.push({ phone: '9876543210', phone_norm: '9876543210', name: 'Asha', email: 'a@x.in', raw_json: '{}' });
  T.tables.inventory_accounts = [{ account_id: 'NF-01', service: 'Netflix', login_id: 'nf1@x', password: 'Secret#Pass1' }];
  T.tables.feed_video_chunks = [{ video_id: 'fv0123456789abcdef', n: 0, data: Buffer.alloc(3000, 7) }];
  T.tables.customer_photos = [{ phone_norm: '9876543210', photo_id: 'x'.repeat(24), mime: 'image/jpeg', data: Buffer.from([1, 2, 3, 250]) }];
  T.settings.set('gotp_c_abc', '{"code":"123456"}'); T.settings.set('csess_abc_1', '{"ph":"9876543210"}'); T.settings.set('emlk_c_x', '{}'); T.settings.set('rcv_t_y', '{}'); T.settings.set('sess_z', '{}');
  T.settings.set('feed_posts', '[{"id":"p1"}]'); T.settings.set('push_vapid', '{"privateKey":"k"}'); T.settings.set('n8n_settings', '{}');
  const prep = await backup.prepare({ now: Date.UTC(2026, 8, 16, 21, 0) });
  ok('filename fluxfilm-backup-YYYY-MM-DD.ffbak (India date)', prep.ok && prep.filename === 'fluxfilm-backup-2026-09-17.ffbak', prep.filename);
  const chunks = []; let writes = 0;
  const sink = new Writable({ highWaterMark: 1024, write(c, _e, cb) { chunks.push(Buffer.from(c)); writes++; setImmediate(cb); } });
  T.pages = 0;
  const done = await backup.stream(prep, sink);
  const file = Buffer.concat(chunks);
  ok('streamed in many writes, orders read in pages of 500 (3 pages for 1203 rows)', writes > 3 && T.queries.filter((x) => /FROM `orders` ORDER BY `order_id` LIMIT 500 OFFSET/.test(x)).length === 3, { writes, pages: T.queries.filter((x) => /FROM `orders`/.test(x)).length });
  ok('header line is readable JSON (no rows in it), body is not readable', file.toString('utf8', 0, file.indexOf(10)).startsWith('{"format":"fluxfilm-backup"') && !file.includes(Buffer.from('Secret#Pass1')) && !file.includes(Buffer.from('FF000001')));
  const hdr = restore.splitFile(file).header;
  ok('header: version, created time, row counts, cipher aes-256-gcm + scrypt', hdr.version === 1 && hdr.createdAt && hdr.tables.orders === 1203 && hdr.cipher.alg === 'aes-256-gcm' && hdr.cipher.kdf === 'scrypt' && Array.isArray(hdr.missingTables));
  const dec = restore.decryptBackup(file, PASS);
  ok('restore script decrypts it: every order back, unicode intact', dec.tables.orders.length === 1203 && JSON.parse(dec.tables.orders[5].raw_json).Note === 'ऑर्डर ✅' && dec.end.total === done.rows);
  ok('inventory passwords are included (needed to restore)', dec.tables.inventory_accounts[0].password === 'Secret#Pass1');
  const keys = dec.tables.app_settings.map((x) => x.setting_key);
  ok('app_settings: login / code / session keys and n8n_secrets left out, business settings kept', !keys.some((k) => /^(gotp_|csess_|emlk_|rcv_|sess_)/.test(k)) && !keys.includes('n8n_secrets') && keys.includes('feed_posts') && keys.includes('push_vapid') && keys.includes('n8n_settings'), keys);
  ok('feed_video_chunks: ids + size only, no video bytes', dec.tables.feed_video_chunks[0].video_id === 'fv0123456789abcdef' && dec.tables.feed_video_chunks[0].size_bytes === 3000 && !('data' in dec.tables.feed_video_chunks[0]));
  ok('binary columns kept as base64', Buffer.from(dec.tables.customer_photos[0].data.$b64, 'base64').equals(Buffer.from([1, 2, 3, 250])));
  ok('missing tables (schema not run) are skipped and listed', hdr.missingTables.includes('refund_offers') && !('refund_offers' in dec.tables));
  let e1 = ''; try { restore.decryptBackup(file, 'wrong passphrase!!'); } catch (e) { e1 = e.message; }
  ok('wrong passphrase → clear error', /Wrong backup passphrase/.test(e1), e1);
  let e2 = ''; try { restore.decryptBackup(file.subarray(0, file.length - 40), PASS); } catch (e) { e2 = e.message; }
  ok('cut-off download → error (GCM tag)', /damaged|cut off/.test(e2), e2);
  const tampered = Buffer.from(file); const nl = tampered.indexOf(10); tampered[nl - 3] = tampered[nl - 3] === 0x31 ? 0x32 : 0x31;
  let e3 = ''; try { restore.decryptBackup(tampered, PASS); } catch (e) { e3 = e.message; }
  ok('a changed header also fails (header is authenticated)', !!e3, e3);
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ffbak-'));
  const names = restore.writeOut(dec, tmpDir);
  ok('writeOut: one JSON file per table + _header.json', names.includes('orders') && JSON.parse(fs.readFileSync(path.join(tmpDir, 'orders.json'), 'utf8')).length === 1203 && fs.existsSync(path.join(tmpDir, '_header.json')));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const prepT = await backup.prepare({ table: 'orders' });
  const chunksT = []; await backup.stream(prepT, new Writable({ write(c, _e, cb) { chunksT.push(Buffer.from(c)); cb(); } }));
  const decT = restore.decryptBackup(Buffer.concat(chunksT), PASS);
  ok('?table=orders: same format, one table', prepT.filename.endsWith('-orders.ffbak') && Object.keys(decT.tables).join() === 'orders' && decT.tables.orders.length === 1203);
  ok('unknown table → 400', (await backup.prepare({ table: 'mysql.user' })).status === 400);
  // Over HTTP with the real routes.
  I.reset();
  const kb = await n8n.generateKey();
  const appB = express(); appB.use(express.json()); n8n.mount(appB, { backup });
  const srvB = await listen(appB); const B = 'http://127.0.0.1:' + srvB.address().port;
  r = await call(B, 'GET', '/n8n/api/backup', { headers: { 'X-N8N-Key': kb.key } });
  ok('HTTP: octet-stream download with the filename', r.status === 200 && /octet-stream/.test(r.headers.get('content-type')) && /fluxfilm-backup-\d{4}-\d{2}-\d{2}\.ffbak/.test(r.headers.get('content-disposition')));
  ok('HTTP download decrypts with the restore script', restore.decryptBackup(r.buf, PASS).tables.orders.length === 1203);
  r = await call(B, 'GET', '/n8n/api/backup/tables', { headers: { 'X-N8N-Key': kb.key } });
  ok('backup/tables lists row counts for n8n loops', r.status === 200 && r.json.tables.find((x) => x.name === 'orders').rows === 1203 && r.json.passphraseSet === true);
  await backup.clearPassphrase();
  r = await call(B, 'GET', '/n8n/api/backup', { headers: { 'X-N8N-Key': kb.key } });
  ok('HTTP without passphrase → 409 JSON, no file', r.status === 409 && r.json && /passphrase/.test(r.json.message));
  srvB.close();

  // ==================================================================== 7. webhooks
  section('webhooks: signed, once per event, retries, never throws, 00:05 expiry sweep, posts');
  reset(); I.reset(); hooks._internal.reset();
  const sent = []; let failNext = 0; let throwFetch = false;
  hooks._internal.setTransport({
    fetch: async (url, opts) => { if (throwFetch) throw new Error('ECONNRESET'); sent.push({ url, opts }); if (failNext > 0) { failNext--; return { status: 502 }; } return { status: 200 }; },
    setTimeout: (f, ms) => (ms === 10e3 ? { fake: true } : setImmediate(f)),
  });
  const settle = () => new Promise((res) => setTimeout(res, 40));
  const body0 = '{"a":1}';
  ok('signature = sha256=HMAC-SHA256(secret, raw body)', hooks.sign('s3cret', body0) === 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body0).digest('hex'));
  ok('event URL = base + /order-paid', hooks.eventUrl('https://x.app.n8n.cloud/webhook/fluxfilm/', 'order.paid') === 'https://x.app.n8n.cloud/webhook/fluxfilm/order-paid');
  let sr = await hooks.send('order.paid', { orderId: 'FF1' }, { wait: true });
  ok('no URL saved → nothing sent', sr.skipped && sent.length === 0);
  ok('webhook URL must be public https', !n8n.validateWebhookUrl('http://x.app.n8n.cloud/webhook/a').ok && !n8n.validateWebhookUrl('https://127.0.0.1/webhook').ok && !n8n.validateWebhookUrl('https://user:pw@x.com/w').ok && n8n.validateWebhookUrl('https://x.app.n8n.cloud/webhook/fluxfilm/').url === 'https://x.app.n8n.cloud/webhook/fluxfilm');
  const st0 = await n8n.getSettings(true); st0.webhookUrl = 'https://x.app.n8n.cloud/webhook/fluxfilm'; await n8n.saveSettingsRaw(st0);
  const sec0 = await n8n.getSecrets(); sec0.webhookSecret = 'ffwh_testsecret'; await n8n.saveSecrets(sec0);
  sr = await hooks.send('order.paid', { orderId: 'FF1', amount: 149 }, { wait: true, eventId: 'order.paid:FF1' });
  const req0 = sent[0];
  ok('POST with X-FF-Signature matching the exact body, timestamp + event id headers', sr.ok && req0.url.endsWith('/order-paid') && req0.opts.headers['X-FF-Signature'] === hooks.sign('ffwh_testsecret', req0.opts.body) && /^\d{10}$/.test(req0.opts.headers['X-FF-Timestamp']) && req0.opts.headers['X-FF-Event-Id'] === 'order.paid:FF1');
  const pb = JSON.parse(req0.opts.body);
  ok('body { eventId, event, createdAt, data }', pb.eventId === 'order.paid:FF1' && pb.event === 'order.paid' && pb.data.orderId === 'FF1' && !!pb.createdAt);
  sent.length = 0; failNext = 2;
  sr = await hooks.send('order.delivered', { orderId: 'FF2' }, { wait: true });
  ok('retries: 2 failures then success = 3 attempts', sr.ok && sr.attempts === 3 && sent.length === 3, sr);
  sent.length = 0; failNext = 99;
  sr = await hooks.send('order.delivered', { orderId: 'FF3' }, { wait: true });
  ok('gives up after 1 try + 3 retries, logged as failed', !sr.ok && sr.attempts === 4 && sent.length === 4, sr);
  failNext = 0; throwFetch = true;
  let nothrow = true; try { sr = await hooks.send('order.paid', { orderId: 'FF4' }, { wait: true, retries: 0 }); } catch (_) { nothrow = false; }
  ok('network error → resolves { ok:false }, never throws', nothrow && sr.ok === false && /ECONNRESET/.test(sr.error), sr);
  throwFetch = false;
  T.failAll = true;
  nothrow = true; try { sr = await hooks.send('order.paid', {}, {}); } catch (_) { nothrow = false; }
  T.failAll = false;
  ok('settings unreadable (DB down) → resolves, never throws', nothrow && sr.ok === false);
  const dl = await hooks.deliveries();
  ok('delivery log keeps the newest first, max 20, with status + attempts', dl.length >= 3 && dl.length <= 20 && dl.some((x) => x.ok === false && x.attempts === 4));
  const stOff = await n8n.getSettings(true); stOff.events['order.delivered'] = false; await n8n.saveSettingsRaw(stOff);
  sent.length = 0;
  sr = await hooks.send('order.delivered', {}, { wait: true });
  ok('event switched off → skipped', sr.skipped === 'event switched off' && sent.length === 0);
  stOff.events['order.delivered'] = true; await n8n.saveSettingsRaw(stOff);

  // sweep
  sent.length = 0;
  const S0 = Date.UTC(2026, 8, 16, 18, 29); // 23:59 India, 16 Sep
  T.orders.push({ order_id: 'FFOLD', service: 'Netflix', plan: 'Sharing 1M', final_amount: 149, order_type: 'NEW', name: 'Old Buyer', status: 'PAID', verified_at: '2026-09-16 20:00:00', fulfillment_status: 'FULFILLED', fulfilled_at: '2026-09-16 20:01:00' });
  FEED.posts = [{ id: 'p1', title: 'Old post', date: new Date(S0 - DAY).toISOString(), image: '/poster/w500/a1.jpg', ctaService: 'Netflix', format: 'post' }];
  let sw = await hooks.sweep({ now: S0 });
  await settle();
  ok('first sweep only sets the starting point (old orders / posts not sent)', sw.initialised === true && sent.length === 0);
  T.orders.push({ order_id: 'FFNEW', service: 'Prime Video', plan: '1 Month', final_amount: 49, order_type: 'RENEW', name: 'rahul sharma', status: 'PAID', verified_at: '2026-09-16 23:59:30', fulfillment_status: 'PENDING', fulfilled_at: null, phone_norm: '9876500000', email: 'r@x.in' });
  sw = await hooks.sweep({ now: S0 + 60e3 });
  await settle();
  const paidReq = sent.filter((x) => x.url.endsWith('/order-paid'));
  ok('order.paid fired for the new paid order only', paidReq.length === 1 && JSON.parse(paidReq[0].opts.body).data.orderId === 'FFNEW', sent.map((x) => x.url));
  const pd = JSON.parse(paidReq[0].opts.body).data;
  ok('order.paid data: id, service, plan, amount, renewal flag, first name (no phone / email)', pd.service === 'Prime Video' && pd.amount === 49 && pd.isRenewal === true && pd.type === 'RENEWAL' && pd.firstName === 'Rahul' && !JSON.stringify(pd).includes('9876500000') && !JSON.stringify(pd).includes('r@x.in'), pd);
  sw = await hooks.sweep({ now: S0 + 120e3 });
  await settle();
  ok('once per order: the next sweep does not send it again', sent.filter((x) => x.url.endsWith('/order-paid')).length === 1);
  const fnew = T.orders.find((o) => o.order_id === 'FFNEW'); fnew.fulfillment_status = 'FULFILLED'; fnew.fulfilled_at = '2026-09-17 00:02:00';
  // subscription that ended yesterday (16 Sep) + one from today, a refunded one and a device-2 row
  T.subs.push({ sub_id: 'SX1', order_id: 'FX1', phone_norm: '9000000001', service: 'Netflix', plan: 'Sharing 1M', expiry_date: '2026-09-16 21:00:00', status: 'EXPIRED', fulfillment_status: 'FULFILLED', group_index: null });
  T.subs.push({ sub_id: 'SX2', order_id: 'FX2', phone_norm: '9000000002', service: 'Netflix', plan: 'Sharing 1M', expiry_date: '2026-09-16 10:00:00', status: 'CANCELLED', fulfillment_status: 'REFUNDED', group_index: null });
  T.subs.push({ sub_id: 'SX3', order_id: 'FX1', phone_norm: '9000000001', service: 'Netflix', plan: 'Sharing 1M', expiry_date: '2026-09-16 21:00:00', status: 'EXPIRED', fulfillment_status: 'FULFILLED', group_index: 2 });
  T.subs.push({ sub_id: 'SX4', order_id: 'FX4', phone_norm: '9000000004', service: 'Netflix', plan: 'Sharing 1M', expiry_date: '2026-09-17 01:00:00', status: 'ACTIVE', fulfillment_status: 'FULFILLED', group_index: null });
  T.customers.push({ phone: '9000000001', phone_norm: '9000000001', name: 'asha', email: 'a@x', raw_json: '{}' });
  sent.length = 0;
  sw = await hooks.sweep({ now: Date.UTC(2026, 8, 16, 18, 33) }); // 00:03 India, 17 Sep
  await settle();
  ok('order.delivered fired once when it became FULFILLED', sent.filter((x) => x.url.endsWith('/order-delivered')).length === 1);
  ok('before 00:05 India: no expiry events yet', sent.filter((x) => x.url.endsWith('/subscription-expired')).length === 0);
  sent.length = 0;
  sw = await hooks.sweep({ now: Date.UTC(2026, 8, 16, 18, 36) }); // 00:06 India
  await settle();
  const exReq = sent.filter((x) => x.url.endsWith('/subscription-expired'));
  ok('00:05 India: subscription.expired for plans that ended yesterday (not refunded, not device 2, not today)', exReq.length === 1 && JSON.parse(exReq[0].opts.body).data.subId === 'SX1', exReq.map((x) => JSON.parse(x.opts.body).data.subId));
  const exd = exReq.length ? JSON.parse(exReq[0].opts.body).data : {};
  ok('expired data: service, plan, expiredOn, first name, renew link', exd.expiredOn === '2026-09-16' && exd.firstName === 'Asha' && exd.renewUrl === 'https://shop.fluxfilm.in/?source=push&renew=SX1', exd);
  ok('guarded in app_settings: expiredDay saved', JSON.parse(T.settings.get('n8n_hook_state')).expiredDay === '2026-09-17');
  sent.length = 0;
  hooks._internal.reset();
  sw = await hooks.sweep({ now: Date.UTC(2026, 8, 17, 2, 0) }); // restart later the same day
  await settle();
  ok('a restart later that day does not send the expiry events again', sent.filter((x) => x.url.endsWith('/subscription-expired')).length === 0);
  FEED.posts.unshift({ id: 'p9', title: 'Brand new', caption: 'Out now', date: new Date(Date.UTC(2026, 8, 17, 2, 0)).toISOString(), image: 'https://image.tmdb.org/t/p/w780/q.jpg', ctaService: 'Netflix', cta: 'service', format: 'post' });
  FEED.info = [{ service: 'Netflix', minPrice: 149 }];
  sent.length = 0;
  sw = await hooks.sweep({ now: Date.UTC(2026, 8, 17, 2, 1) });
  await settle();
  const postReq = sent.filter((x) => x.url.endsWith('/post-published'));
  ok('post.published once for a newly live post, with price and share link, no TMDB link', postReq.length === 1 && JSON.parse(postReq[0].opts.body).data.id === 'p9' && JSON.parse(postReq[0].opts.body).data.fromPrice === 149 && !/tmdb/.test(postReq[0].opts.body));
  sent.length = 0;
  await hooks.sweep({ now: Date.UTC(2026, 8, 17, 2, 2) }); await settle();
  ok('…not again on the next sweep', sent.length === 0);
  T.failAll = true;
  nothrow = true; try { sw = await hooks.sweep({ now: Date.UTC(2026, 8, 17, 2, 3) }); } catch (_) { nothrow = false; }
  T.failAll = false;
  ok('sweep with the DB down resolves { ok:false } (timer never crashes)', nothrow && sw.ok === false);
  const orderSrc = fs.readFileSync(path.join(ROOT, 'order.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'credit.js'), 'utf8');
  const hookLines = orderSrc.split('\n').filter((l) => /n8nhooks/.test(l) && !/^\s*\/\//.test(l));
  ok('order flow only calls kick() inside try/catch at the PAID point (no await, no send)', hookLines.length === 2 && hookLines.every((l) => /try \{ require\('\.\/n8nhooks'\)\.kick\(\); \} catch/.test(l) && !/await/.test(l)) && !/n8nhooks/.test(fs.readFileSync(path.join(ROOT, 'fulfill.js'), 'utf8')), hookLines);
  // No URL: idle, cursor moves.
  const stNo = await n8n.getSettings(true); stNo.webhookUrl = ''; await n8n.saveSettingsRaw(stNo);
  T.orders.push({ order_id: 'FFIDLE', service: 'Netflix', plan: 'x', final_amount: 1, order_type: 'NEW', name: 'x', status: 'PAID', verified_at: '2026-09-17 07:40:00' });
  sent.length = 0;
  sw = await hooks.sweep({ now: Date.UTC(2026, 8, 17, 2, 11) });
  ok('no webhook URL: sweep idles (no event queries), starting point moves on', sw.idle && sent.length === 0 && JSON.parse(T.settings.get('n8n_hook_state')).paidCursor === '2026-09-17 07:41:00', sw);
  const origGet = n8n.getSettings;
  ok('kick() before the timer started does nothing and never throws', hooks.kick() === false);
  T.failAll = true; hooks.startTimer();
  let kicked; nothrow = true; try { kicked = hooks.kick(); hooks.kick(); } catch (_) { nothrow = false; }
  ok('kick() with the DB down: returns at once, debounced, never throws', nothrow && kicked === true);
  T.failAll = false; void origGet;

  // ==================================================================== 8. admin routes + page
  section('admin → 🔗 Integrations: routes and page wiring');
  reset(); I.reset(); hooks._internal.reset();
  const appC = express(); appC.use(express.json());
  const audC = []; require('../adminn8n').mount(appC, { auth: () => true, audit: { record: (_r, e) => audC.push(e) } });
  const srvC = await listen(appC); const C = 'http://127.0.0.1:' + srvC.address().port;
  r = await call(C, 'POST', '/admin/api/n8n/key', { body: { action: 'generate' } });
  const shownKey = r.json.key;
  ok('generate: key shown in this answer', r.status === 200 && /^ffn8n_/.test(shownKey));
  r = await call(C, 'GET', '/admin/api/n8n');
  ok('status never contains the key, its hash, the secret or the passphrase', r.json.ok && r.json.key.set && !r.text.includes(shownKey) && !r.text.includes(n8n.keyHash(shownKey)) && !('hash' in r.json.key));
  r = await call(C, 'POST', '/admin/api/n8n/secret', {});
  const shownSecret = r.json.secret;
  ok('signing secret shown once', /^ffwh_/.test(shownSecret) && !(await call(C, 'GET', '/admin/api/n8n')).text.includes(shownSecret));
  r = await call(C, 'POST', '/admin/api/n8n/settings', { body: { webhookUrl: 'http://insecure.example.com/hook' } });
  ok('http:// webhook URL refused', r.status === 400);
  r = await call(C, 'POST', '/admin/api/n8n/settings', { body: { webhookUrl: 'https://you.app.n8n.cloud/webhook/fluxfilm', events: { 'post.published': false }, winback: { WB15: { value: 10, maxDiscount: 40 } } } });
  ok('settings saved (URL, switches, win-back coupon)', r.status === 200 && r.json.webhookUrl === 'https://you.app.n8n.cloud/webhook/fluxfilm' && r.json.events['post.published'] === false && r.json.winback.WB15.value === 10 && r.json.winback.WB15.maxDiscount === 40, r.json);
  ok('win-back validation (95% refused)', (await call(C, 'POST', '/admin/api/n8n/settings', { body: { winback: { WB15: { type: 'PERCENT', value: 95 } } } })).status === 400);
  r = await call(C, 'POST', '/admin/api/n8n/passphrase', { body: { passphrase: 'my long backup passphrase' } });
  ok('passphrase: only "set" comes back', r.json.ok && r.json.backup.set === true && !r.text.includes('my long backup passphrase') && !(await call(C, 'GET', '/admin/api/n8n')).text.includes('my long backup passphrase'));
  sent.length = 0;
  r = await call(C, 'POST', '/admin/api/n8n/test-webhook', {});
  ok('📡 test webhook: one signed test.ping to …/test-ping, HTTP status answered', r.json.ok && r.json.status === 200 && sent.length === 1 && sent[0].url === 'https://you.app.n8n.cloud/webhook/fluxfilm/test-ping' && sent[0].opts.headers['X-FF-Signature'] === hooks.sign(shownSecret, sent[0].opts.body), r.json);
  ok('changes are in the change log, never the secrets', audC.some((e) => e.action === 'n8n.key.create') && audC.some((e) => e.action === 'n8n.backup.passphrase.set') && !JSON.stringify(audC).includes(shownKey) && !JSON.stringify(audC).includes(shownSecret));
  r = await call(C, 'POST', '/admin/api/n8n/key', { body: { action: 'revoke' } });
  ok('revoke works', r.json.ok && r.json.revoked === true);
  srvC.close();

  const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('menu item 🔗 Integrations + view registered', /\['integrations', '🔗', 'Integrations'\]/.test(adminHtml) && /integrations: integrationsView/.test(adminHtml) && /function integrationsView\(\)/.test(adminHtml));
  ok('page calls the real admin routes', ['/admin/api/n8n', '/admin/api/n8n/key', '/admin/api/n8n/settings', '/admin/api/n8n/secret', '/admin/api/n8n/passphrase', '/admin/api/n8n/test-webhook'].every((u) => adminHtml.includes("'" + u + "'")));
  ok('admin.js mounts adminn8n; server.js mounts /n8n before the storefront catch-all and starts the webhook timer', /require\('\.\/adminn8n'\)\.mount/.test(fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8')) && serverJs.indexOf("require('./n8n')") > 0 && serverJs.indexOf("require('./n8n')") < serverJs.indexOf("app.get('*'") && /require\('\.\/n8nhooks'\)\.startTimer\(\)/.test(serverJs));
  ok('the n8n API is not a storefront /api action', !/n8n/i.test(serverJs.slice(serverJs.indexOf("app.post('/api'"), serverJs.indexOf("app.get('/olivia.js'"))));
  for (const [name, html] of [['admin.html', adminHtml], ['index.html', indexHtml]]) {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]).filter((x) => x.trim());
    let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   ' + name + ' parse error:', e.message); } }
    ok(name + ': every inline <script> parses', parsed && scripts.length > 0);
  }
  const clSrc = indexHtml.slice(indexHtml.indexOf('function couponLinkFromUrl_'), indexHtml.indexOf('(function couponLinkInit_'));
  const couponLinkFromUrl_ = new Function(clSrc + '\nreturn couponLinkFromUrl_;')();
  ok('storefront reads /?coupon=CODE (win-back link) and ignores junk', couponLinkFromUrl_('?coupon=wbab23cd') === 'WBAB23CD' && couponLinkFromUrl_('?buy=netflix&coupon=WBX2Y3Z4') === 'WBX2Y3Z4' && couponLinkFromUrl_('?coupon=<script>') === '' && couponLinkFromUrl_('') === '');
  ok('…and saves it as the checkout / renew coupon', /couponLinkInit_[\s\S]{0,300}savePromoCoupon_\(/.test(indexHtml));

  // ==================================================================== 9. n8n workflow files
  section('n8n workflow files: valid JSON, unique names, connections, inactive, no secrets');
  const wfDir = path.join(ROOT, '..', 'n8n');
  const files = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => f.endsWith('.json')).sort() : [];
  ok('5 workflow files', files.join() === ['01-expiry-reminders.json', '02-winback.json', '03-daily-backup.json', '04-uptime-deploy-watch.json', '05-social-autopost.json'].join(), files);
  for (const f of files) {
    const txt = fs.readFileSync(path.join(wfDir, f), 'utf8');
    let wf = null; try { wf = JSON.parse(txt); } catch (e) { ok(f + ' parses', false, e.message); continue; }
    const nodeNames = (wf.nodes || []).map((n) => n.name);
    const unique = new Set(nodeNames).size === nodeNames.length;
    const conns = Object.entries(wf.connections || {});
    const connOk = conns.every(([from, v]) => nodeNames.includes(from) && Object.values(v).every((outs) => outs.every((list) => (list || []).every((c) => nodeNames.includes(c.node)))));
    const nodesOk = (wf.nodes || []).every((n) => n.id && n.type && /^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./.test(n.type) && Array.isArray(n.position) && typeof n.typeVersion === 'number' && n.parameters);
    ok(f + ': nodes valid, names unique, connections point at real nodes', wf.name && nodesOk && unique && connOk && conns.length > 0, { unique, connOk, nodesOk });
    ok(f + ': "active": false, has a setup sticky note', wf.active === false && wf.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote' && /setup|Setup|SETUP/.test(n.parameters.content || '')));
    ok(f + ': no secrets (no keys, tokens, passwords, admin key)', !/ffn8n_[A-Za-z0-9_-]{20}|ffwh_[A-Za-z0-9_-]{20}|fluxfilm2026|EAA[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|\d{8,10}:[A-Za-z0-9_-]{30,}/.test(txt));
    const creds = (wf.nodes || []).filter((n) => n.credentials).map((n) => Object.values(n.credentials)).flat();
    ok(f + ': credentials are named placeholders', creds.every((c) => c && c.name && /^(REPLACE|FluxFilm|Gmail|SMTP|Google|Telegram|GitHub|WhatsApp|Meta|Pushover)/i.test(c.name) && (!c.id || /^REPLACE/.test(c.id))), creds);
    const wa = (wf.nodes || []).filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && /whatsapp/i.test(n.name + n.type));
    ok(f + ': WhatsApp nodes (if any) are disabled', wa.every((n) => n.disabled === true));
    let codeOk = true;
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) { try { new Function('$input', '$json', '$', '$getWorkflowStaticData', '$runIndex', 'return (async () => {' + n.parameters.jsCode + '\n})'); } catch (e) { codeOk = false; console.log('   ' + f + ' / ' + n.name + ': ' + e.message); } }
    ok(f + ': every Code node parses', codeOk);
    const hosts = [...new Set(txt.match(/https:\/\/[a-z0-9.-]+/gi) || [])];
    ok(f + ': only the shop / GitHub / Meta / example n8n hosts', hosts.every((u) => /^https:\/\/(shop\.fluxfilm\.in|api\.github\.com|graph\.facebook\.com|you\.app\.n8n\.cloud)$/i.test(u)), hosts);
  }
  const docs = path.join(ROOT, '..', 'n8n', 'README.md');
  ok('n8n/README.md is in the repo', fs.existsSync(docs) && /WhatsApp/.test(fs.readFileSync(docs, 'utf8')) && /restore-backup/.test(fs.readFileSync(docs, 'utf8')));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  Module._load = origLoad;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.stack); process.exit(1); });
