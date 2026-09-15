/* Both payment flows end-to-end against an in-memory fake database (PR 101 follow-up). Run: npm test
 *  Flow 1 — bank email: IMAP scan (real mailparser) → bank_credits → verifyPayment (order id in the UPI note)
 *           or verifyPaymentByRef (customer types the UTR).
 *  Flow 2 — backup UPI: "I've paid" payer-name claim (paymatch) → order paid; admin "link bank payment".
 * Names, phones, UTRs and addresses below are made up. */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
delete process.env.BANK_SENDER;
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- fake database
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const minAgo = (m) => fmt(new Date(Date.now() - m * 60e3));
const asDb = (v) => (v instanceof Date ? fmt(v) : v); // mysql2 writes a JS Date as local (India) wall-clock time
let T;
const reset = () => { T = { orders: [], credits: [], claims: [], names: [], settings: {}, audit: [] }; };
reset();
const openSt = (st) => st === 'WAITING' || st === 'REVIEW';
const copy = (r) => Object.assign({}, r);

async function q(sqlRaw, p) {
  const sql = sqlRaw.replace(/\s+/g, ' ').trim(); p = p || [];
  // ---- payments.js
  if (/^INSERT IGNORE INTO bank_credits/.test(sql)) {
    if (T.credits.some((c) => c.upi_ref === p[0])) return { affectedRows: 0 };
    T.credits.push({ id: T.credits.length + 1, upi_ref: p[0], amount: p[1], order_ids: p[2], raw: p[3], received_at: asDb(p[4]), consumed_order_id: null });
    return { affectedRows: 1 };
  }
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE consumed_order_id IS NULL AND ROUND\(amount\) = ROUND\(\?\) AND FIND_IN_SET\(\?, order_ids\) > 0 ORDER BY received_at DESC LIMIT 1$/.test(sql)) {
    const c = T.credits.filter((x) => !x.consumed_order_id && Math.round(x.amount) === Math.round(p[1]) && String(x.order_ids || '').split(',').includes(p[2])).sort((a, b) => (a.received_at < b.received_at ? 1 : -1))[0];
    if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 };
  }
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE consumed_order_id IS NULL AND upi_ref = \? AND ROUND\(amount\) = ROUND\(\?\) AND \(COALESCE\(order_ids, ''\) = '' OR FIND_IN_SET\(\?, order_ids\) > 0\) AND received_at >= COALESCE\(\(SELECT DATE_SUB\(o\.created_at_sheet, INTERVAL \? MINUTE\) FROM orders o WHERE o\.order_id = \? LIMIT 1\), '1000-01-01 00:00:00'\) LIMIT 1$/.test(sql)) {
    const o = T.orders.find((x) => x.order_id === p[5]);
    const bound = o && o.created_at_sheet ? fmt(new Date(new Date(o.created_at_sheet.replace(' ', 'T')).getTime() - p[4] * 60e3)) : '1000-01-01 00:00:00';
    const c = T.credits.find((x) => !x.consumed_order_id && x.upi_ref === p[1] && Math.round(x.amount) === Math.round(p[2]) &&
      (!x.order_ids || String(x.order_ids).split(',').includes(p[3])) && x.received_at != null && x.received_at >= bound);
    if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 };
  }
  if (/^SELECT \* FROM bank_credits WHERE consumed_order_id = \? ORDER BY id DESC LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.consumed_order_id === p[0]).slice(-1).map(copy);
  if (/^SELECT \* FROM bank_credits WHERE upi_ref = \? LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.upi_ref === p[0]).map(copy);
  // ---- order.js
  if (/^SELECT order_id, final_amount, status, source FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(copy);
  if (/^SELECT status, coupon_code, phone, phone_norm, email, discount FROM orders WHERE order_id = \? FOR UPDATE$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(copy);
  if (/^UPDATE orders SET status = \?, txn_ref = \?, verified_at = NOW\(\) WHERE order_id = \?$/.test(sql)) { const o = T.orders.find((x) => x.order_id === p[2]); if (o) Object.assign(o, { status: p[0], txn_ref: p[1] }); return { affectedRows: o ? 1 : 0 }; }
  // ---- paymatch.js
  if (/^SELECT value FROM app_settings WHERE setting_key = \? LIMIT 1$/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
  if (/^SELECT order_id, phone_norm, final_amount, status, source, order_type, created_at_sheet, raw_json FROM orders WHERE order_id = \?/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(copy);
  if (/^SELECT name_norm FROM customer_payer_names WHERE phone_norm = \?/.test(sql)) return T.names.filter((n) => n.phone_norm === p[0]);
  if (/^INSERT INTO customer_payer_names/.test(sql)) { if (!T.names.some((n) => n.phone_norm === p[0] && n.name_norm === p[1])) T.names.push({ phone_norm: p[0], name_norm: p[1], name_display: p[2] }); return { affectedRows: 1 }; }
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE upi_ref = \?/.test(sql)) return T.credits.filter((c) => c.upi_ref === p[0]).map(copy);
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at FROM bank_credits WHERE consumed_order_id IS NULL AND ROUND\(amount\) = ROUND\(\?\) AND received_at BETWEEN \? AND \?/.test(sql))
    return T.credits.filter((c) => !c.consumed_order_id && Math.round(c.amount) === Math.round(p[0]) && c.received_at >= p[1] && c.received_at <= p[2]).map(copy);
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE id = \? AND consumed_order_id IS NULL$/.test(sql)) { const c = T.credits.find((x) => x.id === p[1] && !x.consumed_order_id); if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE bank_credits SET consumed_order_id = NULL WHERE id = \? AND consumed_order_id = \?$/.test(sql)) { const c = T.credits.find((x) => x.id === p[0] && x.consumed_order_id === p[1]); if (c) c.consumed_order_id = null; return { affectedRows: c ? 1 : 0 }; }
  if (/^SELECT order_id, payer_name FROM payment_claims WHERE status IN/.test(sql)) return T.claims.filter((c) => openSt(c.status) && c.order_id !== p[0] && Math.round(c.amount) === Math.round(p[1]) && c.created_at >= p[2] && c.created_at <= p[3]);
  if (/^SELECT order_id, phone_norm FROM orders WHERE UPPER\(status\) = 'CREATED'/.test(sql)) return T.orders.filter((o) => o.status === 'CREATED' && o.order_id !== p[0] && Math.round(o.final_amount) === Math.round(p[1]) && o.created_at_sheet >= p[2] && o.created_at_sheet <= p[3]);
  if (/^SELECT id, order_id, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE order_id = \? ORDER BY id DESC$/.test(sql)) return T.claims.filter((c) => c.order_id === p[0]).slice().reverse().map(copy);
  if (/^UPDATE payment_claims SET status = 'REPLACED'/.test(sql)) { T.claims.forEach((c) => { if (c.order_id === p[0] && openSt(c.status)) c.status = 'REPLACED'; }); return { affectedRows: 1 }; }
  if (/^INSERT INTO payment_claims .*'WAITING', '', 'CUSTOMER'/.test(sql)) { const id = T.claims.length + 1; T.claims.push({ id, order_id: p[0], phone_norm: p[1], amount: p[2], payer_name: p[3], utr: p[4], status: 'WAITING', reason: '', credit_id: null, source: 'CUSTOMER', created_at: p[5] }); return { insertId: id, affectedRows: 1 }; }
  if (/^UPDATE payment_claims SET status = \?, reason = \?, credit_id = \?, candidates = \?/.test(sql)) { const c = T.claims.find((x) => x.id === p[4] && openSt(x.status)); if (c) Object.assign(c, { status: p[0], reason: p[1], credit_id: p[2] }); return { affectedRows: c ? 1 : 0 }; }
  // ---- adminbankcredits.js
  if (/^SELECT ignored_at, ignored_reason, ignored_note FROM bank_credits LIMIT 0$/.test(sql)) { const e = new Error("Unknown column 'ignored_at'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE id = \? LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.id === p[0]).map(copy);
  if (/^SELECT order_id, name, service, plan, final_amount, status, fulfillment_status, source, txn_ref FROM orders WHERE order_id = \? LIMIT 1$/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]).map(copy);
  if (/^SELECT id, upi_ref FROM bank_credits WHERE consumed_order_id = \? AND id <> \? LIMIT 1$/.test(sql)) return T.credits.filter((c) => c.consumed_order_id === p[0] && c.id !== p[1]).map(copy);
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 160));
}
const conn = {
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
  query: async (sql, p) => [await q(sql, p)],
};
const mockDb = { ENABLED: true, query: q, getPool: () => ({ getConnection: async () => conn }), ping: async () => ({ ok: true }) };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === './db') return mockDb;
  if (req === './coins') return { onOrderPaid: async () => ({}), holdSpend: async () => ({ ok: false }), releaseSpend: async () => ({}) };
  if (req === './referrals') return { onOrderPaid: async () => ({}), checkReferral: async () => ({ ok: false }) };
  return origLoad.apply(this, arguments);
};
const payments = require('../payments');
const order = require('../order');
const paymatch = require('../paymatch');
const adminBank = require('../adminbankcredits');
const { simpleParser } = require('mailparser');

// ---------------------------------------------------------------- helpers
const PHONE = '9876500001';
const addOrder = (id, amount, createdMinAgo, extra) => T.orders.push(Object.assign({
  order_id: id, phone: PHONE, phone_norm: PHONE, email: 'buyer@example.test', final_amount: amount, status: 'CREATED', source: 'node',
  order_type: 'NEW', coupon_code: '', discount: 0, created_at_sheet: createdMinAgo == null ? null : minAgo(createdMinAgo), raw_json: '{}',
}, extra || {}));
const orderOf = (id) => T.orders.find((o) => o.order_id === id);
const creditOf = (ref) => T.credits.find((c) => c.upi_ref === ref);
const alertText = (amount, ref, name, note) => 'Dear Customer, An amount of INR ' + amount.toFixed(2) + ' has been credited to A/c XXXXXXXX1234 on account of UPI REF NO ' + ref + ' P2P-' + name + '-' + (note || 'UPI') + '-SBIN0001234- HEAD OFFICE value 15-09-26 . Equitas Small Finance Bank';
function mail(from, body, dateHeader) {
  return Buffer.from([
    'From: ' + from, 'To: owner@example.test', 'Subject: Credit alert for your account',
    'Date: ' + (dateHeader || new Date(Date.now() - 3 * 86400e3).toUTCString()), // sender-written Date header (old / fake)
    'Message-ID: <' + Math.random().toString(36).slice(2) + '@example.test>', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].join('\r\n'));
}
function fakeImap(messages) {
  return {
    searches: [],
    async getMailboxLock() { return { release() {} }; },
    async search(query) { this.searches.push(query); return messages.map((_, i) => i + 1); },
    async *fetch(uids) { for (const u of uids) yield Object.assign({ envelope: { date: new Date(Date.now() - 3 * 86400e3) } }, messages[u - 1]); },
  };
}
const scan = async (messages) => { const c = fakeImap(messages); const r = await payments._internal.scanInbox(c, 1); return Object.assign(r, { client: c }); };
const logs = [];
const realLog = console.log;
console.log = (...a) => { const line = a.join(' '); if (/^\[imap\]|^\[paymatch\]|^\[referral\]|^\[coins\]/.test(line)) { logs.push(line); return; } realLog.apply(console, a); };

(async () => {
  // ------------------------------------------------------------------------------------------------
  section('flow 1: bank email with the exact sender → order id in the note pays the order');
  reset();
  addOrder('FF1000001', 99, 2);
  let r = await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(99, '612300000001', 'RAHUL KUMAR', 'FF1000001')), internalDate: new Date() }]);
  ok('mail parsed with the real mailparser and stored', r.found === 1 && r.ingested === 1 && !!creditOf('612300000001'), r);
  ok('IMAP search asks for the bank domain', r.client.searches[0] && r.client.searches[0].from === 'equitas.bank.in' && !r.client.searches[0].or, r.client.searches[0]);
  ok('received time = Gmail receive time (internalDate), not the old Date header', creditOf('612300000001').received_at >= minAgo(1), creditOf('612300000001').received_at);
  r = await order.verifyPayment('FF1000001');
  ok('verifyPayment finds it (findByOrder) and marks the order PAID', r.ok && r.paid === true && orderOf('FF1000001').status === 'PAID' && orderOf('FF1000001').txn_ref === '612300000001', { r, o: orderOf('FF1000001') });
  ok('the credit is used by that order only', creditOf('612300000001').consumed_order_id === 'FF1000001');
  r = await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(99, '612300000001', 'RAHUL KUMAR', 'FF1000001')), internalDate: new Date() }]);
  ok('the same mail scanned again is not stored twice', r.ingested === 0 && T.credits.length === 1);

  section('flow 1: a different @equitas.bank.in sender still works');
  addOrder('FF1000002', 169, 1);
  r = await scan([{ source: mail('"Equitas Alerts" <alerts@equitas.bank.in>', alertText(169, '612300000002', 'PRIYA S', 'FF1000002')), internalDate: new Date() }]);
  ok('alerts@equitas.bank.in stored', r.ingested === 1, r);
  r = await order.verifyPayment('FF1000002');
  ok('… and pays its order', r.paid === true && orderOf('FF1000002').status === 'PAID', r);
  addOrder('FF1000012', 59, 1);
  r = await scan([{ source: mail('Equitas <noreply@mail.equitas.bank.in>', alertText(59, '612300000012', 'ANIL', 'FF1000012')), internalDate: new Date() }]);
  ok('a subdomain of equitas.bank.in is stored and pays', r.ingested === 1 && (await order.verifyPayment('FF1000012')).paid === true, r);

  section('flow 1: BANK_SENDER set as a bare domain / a partial or different address');
  for (const [i, setting] of [['3', 'equitas.bank.in'], ['4', '@equitas.bank.in'], ['5', 'alerts@equitas.bank.in'], ['6', ' ESFB-ALERTS@EQUITAS.BANK.IN ']]) {
    process.env.BANK_SENDER = setting;
    const oid = 'FF100000' + i; const ref = '61230000000' + i;
    addOrder(oid, 111, 1);
    r = await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(111, ref, 'MEENA', oid)), internalDate: new Date() }]);
    const v = await order.verifyPayment(oid);
    ok('BANK_SENDER "' + setting + '": stored + paid', r.ingested === 1 && v.paid === true, { r: { f: r.found, i: r.ingested }, v });
  }
  process.env.BANK_SENDER = 'alerts@otherbank.example';
  ok('BANK_SENDER on another bank: IMAP search covers it AND equitas.bank.in', JSON.stringify(payments._internal.searchQuery('S')) === JSON.stringify({ or: [{ from: 'otherbank.example' }, { from: 'equitas.bank.in' }], since: 'S' }), payments._internal.searchQuery('S'));
  addOrder('FF1000013', 45, 1);
  r = await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(45, '612300000013', 'RAVI', 'FF1000013')), internalDate: new Date() }]);
  ok('… and an Equitas mail is still accepted', r.ingested === 1 && (await order.verifyPayment('FF1000013')).paid === true, r);
  delete process.env.BANK_SENDER;

  section('flow 1: spoofed / look-alike senders are rejected');
  addOrder('FF1000007', 99, 1);
  logs.length = 0;
  const spoofs = [
    '"esfb-alerts@equitas.bank.in" <esfb-alerts@equitas.bank.in.evil.com>',
    'Equitas Bank <esfb-alerts@xequitas.bank.in>',
    'esfb-alerts@equitas.bank.in <someone@gmail.com>',
    'Equitas <esfb-alerts@equitas-bank.in>',
  ];
  r = await scan(spoofs.map((f, i) => ({ source: mail(f, alertText(99, '61239999000' + i, 'FAKE', 'FF1000007')), internalDate: new Date() })));
  ok('none of the 4 look-alike mails is stored', r.ingested === 0 && !T.credits.some((c) => /^61239999/.test(c.upi_ref)), r);
  const parsedSpoof = await simpleParser(mail(spoofs[0], 'x'));
  ok('the check uses the parsed address, not the display name', parsedSpoof.from.value[0].address === 'esfb-alerts@equitas.bank.in.evil.com' && !payments._internal.fromBank(parsedSpoof));
  r = await order.verifyPayment('FF1000007');
  ok('the order stays unpaid', r.paid !== true && orderOf('FF1000007').status === 'CREATED', r);
  const skipLines = logs.filter((l) => /skipped a credit-like mail/.test(l)).length;
  await scan(spoofs.map((f, i) => ({ source: mail(f, alertText(99, '61239999000' + i, 'FAKE', 'FF1000007')), internalDate: new Date() })));
  const skipLines2 = logs.filter((l) => /skipped a credit-like mail/.test(l)).length;
  ok('skips are logged once per sender, not on every scan', skipLines === 4 && skipLines2 === 4, { skipLines, skipLines2 });

  // ------------------------------------------------------------------------------------------------
  section('flow 1: customer types the UTR (findByRef, fresh credit only)');
  addOrder('FF1000008', 149, 3);
  r = await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(149, '612300000008', 'SUNITA DEVI', 'UPI')), internalDate: new Date() }]);
  ok('plain-QR payment stored (no order id in the note)', r.ingested === 1 && creditOf('612300000008').order_ids === '');
  r = await order.verifyPayment('FF1000008');
  ok('verifyPayment alone cannot see it (asks for the UTR)', r.paid !== true && r.needRef === true, r);
  r = await order.verifyPaymentByRef('FF1000008', 'UTR: 6123 0000 0008');
  ok('typed UTR of a fresh credit pays the order', r.paid === true && orderOf('FF1000008').status === 'PAID' && creditOf('612300000008').consumed_order_id === 'FF1000008', r);
  // old credit: received 2 days before the order
  T.credits.push({ id: T.credits.length + 1, upi_ref: '612300000009', amount: 149, order_ids: '', raw: alertText(149, '612300000009', 'OLD PAYER'), received_at: minAgo(2 * 1440), consumed_order_id: null });
  addOrder('FF1000009', 149, 1);
  r = await order.verifyPaymentByRef('FF1000009', '612300000009');
  ok('a UTR from an old payment (before the order) does not pay', r.paid !== true && orderOf('FF1000009').status === 'CREATED' && !creditOf('612300000009').consumed_order_id, r);
  T.credits.push({ id: T.credits.length + 1, upi_ref: '612300000010', amount: 149, order_ids: '', raw: alertText(149, '612300000010', 'SKEW'), received_at: minAgo(8), consumed_order_id: null });
  addOrder('FF1000010', 149, 1);
  r = await order.verifyPaymentByRef('FF1000010', '612300000010');
  ok('a credit up to 10 min before the order (clock skew) still pays', r.paid === true, r);
  T.credits.push({ id: T.credits.length + 1, upi_ref: '612300000011', amount: 99, order_ids: 'FF7777777', raw: alertText(99, '612300000011', 'X', 'FF7777777'), received_at: minAgo(0), consumed_order_id: null });
  addOrder('FF1000011', 99, 1);
  r = await order.verifyPaymentByRef('FF1000011', '612300000011');
  ok('a credit whose note names another order does not pay', r.paid !== true, r);
  T.credits.push({ id: T.credits.length + 1, upi_ref: '612300000014', amount: 75, order_ids: '', raw: alertText(75, '612300000014', 'NULLTIME'), received_at: minAgo(0), consumed_order_id: null });
  addOrder('FF1000014', 75, null); // created_at_sheet NULL
  r = await order.verifyPaymentByRef('FF1000014', '612300000014');
  ok('order with no created time (NULL): a valid UTR is not blocked', r.paid === true && orderOf('FF1000014').status === 'PAID', r);

  // ------------------------------------------------------------------------------------------------
  section('flow 2: backup UPI — payer-name claim matches a bank credit');
  addOrder('FF2000001', 199, 4);
  r = await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(199, '622300000001', 'GUNAVANTH KUMAR', 'UPI')), internalDate: new Date() }]);
  ok('backup-QR payment stored from the bank email', r.ingested === 1, r);
  r = await paymatch.claimPayment('FF2000001', { phone: PHONE }, 'Gunavanth Kumar', '');
  ok('"I\'ve paid" with the payer name → MATCHED and paid', r.ok && r.status === 'MATCHED' && r.paid === true, r);
  ok('order PAID through order.adminMarkPaid with the bank UTR; credit used once', orderOf('FF2000001').status === 'PAID' && orderOf('FF2000001').txn_ref === '622300000001' && creditOf('622300000001').consumed_order_id === 'FF2000001', { o: orderOf('FF2000001'), c: creditOf('622300000001') });
  addOrder('FF2000002', 199, 2);
  r = await paymatch.claimPayment('FF2000002', { phone: PHONE }, 'Somebody Else', '');
  ok('a different name with no matching credit keeps waiting (not paid)', r.ok && r.status === 'WAITING' && orderOf('FF2000002').status === 'CREATED', r);
  addOrder('FF2000003', 249, 3);
  await scan([{ source: mail('Equitas Bank <esfb-alerts@equitas.bank.in>', alertText(249, '622300000003', 'NEHA GUPTA', 'UPI')), internalDate: new Date() }]);
  r = await paymatch.claimPayment('FF2000003', { phone: PHONE }, 'Neha Gupta', '622300000003');
  ok('claim with the UTR → MATCHED', r.status === 'MATCHED' && orderOf('FF2000003').status === 'PAID', r);

  // ------------------------------------------------------------------------------------------------
  section('admin: "link bank payment" works for any credit (no time window)');
  const express = require('express');
  const app = express(); app.use(express.json());
  adminBank.mount(app, { db: mockDb, auth: () => true, audit: { record: (req, x) => T.audit.push(x) } });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (url, body) => { const x = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: x.status, body: await x.json() }; };
  try {
    const old = creditOf('612300000009'); // the old credit the typed UTR could not use
    r = await post('/admin/api/bank-credits/link', { id: old.id, orderId: 'ff1000009' });
    ok('old credit linked to the order by the admin', r.status === 200 && r.body.ok && r.body.orderId === 'FF1000009' && creditOf('612300000009').consumed_order_id === 'FF1000009' && r.body.canMarkPaid === true, r);
    r = await post('/admin/api/bank-credits/link', { id: old.id, orderId: 'FF1000007' });
    ok('a credit already linked cannot be linked to another order', r.status === 409 && creditOf('612300000009').consumed_order_id === 'FF1000009', r);
    const spoofFree = T.credits.find((c) => c.upi_ref === '612300000011');
    r = await post('/admin/api/bank-credits/link', { id: spoofFree.id, orderId: 'FF1000007' });
    ok('a credit whose note names another order can still be linked by the admin', r.status === 200 && r.body.ok && creditOf('612300000011').consumed_order_id === 'FF1000007', r);
    ok('each link is audited', T.audit.filter((a) => a.action === 'bank.link').length === 2);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }

  console.log = realLog;
  console.log('\n---------------------------------------\npayment-flows: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log = realLog; console.error(e); process.exitCode = 1; });
