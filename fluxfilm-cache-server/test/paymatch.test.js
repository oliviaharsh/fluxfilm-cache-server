/* Payment fallback ("limit reached" → backup UPI → "I've paid" → match / review). Run: npm test
 * In-memory fake database, fixed clock, no MySQL needed. Names/refs below are made up. */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let T; let tables = true; let clock = new Date('2026-09-14T12:00:00+05:30');
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const at = (min) => fmt(new Date(clock.getTime() + min * 60e3));
const reset = () => { T = { settings: {}, orders: [], credits: [], claims: [], names: [], paid: [] }; clock = new Date('2026-09-14T12:00:00+05:30'); };
reset();
const noTable = () => { const e = new Error("Table 'u.payment_claims' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; };
const alert = (ref, name, note, ifsc) => 'Dear Customer, An amount of INR 99.00 has been credited to A/c XXXXXXXX0000 Ref on account of UPI REF NO ' + ref + ' P2P-' + name + '-' + (note || 'UPI') + '-' + (ifsc || 'SBIN0001234') + '- HEAD OFFICE value 14-09-26 .';
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const openSt = (st) => st === 'WAITING' || st === 'REVIEW';

async function q(sql, p) {
  sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
  if (/payment_claims|customer_payer_names/.test(sql) && !tables) noTable();
  if (/^SELECT value FROM app_settings/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
  if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  if (/^DELETE FROM app_settings/.test(sql)) { delete T.settings[p[0]]; return { affectedRows: 1 }; }
  if (/^SELECT 1 FROM (payment_claims|customer_payer_names)/.test(sql)) return [];
  if (/^SELECT order_id, phone_norm, final_amount, status, source, order_type, created_at_sheet, raw_json FROM orders WHERE order_id = \?/.test(sql)) return T.orders.filter((o) => o.order_id === p[0]);
  if (/^SELECT order_id, phone_norm FROM orders WHERE UPPER\(status\) = 'CREATED'/.test(sql)) return T.orders.filter((o) => o.status === 'CREATED' && o.order_id !== p[0] && Math.round(o.final_amount) === Math.round(p[1]) && o.created_at_sheet >= p[2] && o.created_at_sheet <= p[3]);
  if (/^SELECT o.order_id FROM orders o WHERE UPPER\(o.status\) = 'CREATED'/.test(sql)) return T.orders.filter((o) => o.status === 'CREATED' && o.created_at_sheet > p[0] && T.names.some((n) => n.phone_norm === o.phone_norm));
  if (/^SELECT name_norm FROM customer_payer_names/.test(sql)) return T.names.filter((n) => n.phone_norm === p[0]);
  if (/^SELECT payer_name FROM payment_claims WHERE phone_norm = \? AND source = 'CUSTOMER' AND status IN \('MATCHED', 'APPROVED'\)/.test(sql)) return T.claims.filter((c) => c.phone_norm === p[0] && c.source === 'CUSTOMER' && (c.status === 'MATCHED' || c.status === 'APPROVED')).reverse().slice(0, 1);
  if (/^SELECT name_display FROM customer_payer_names WHERE phone_norm = \?/.test(sql)) return T.names.filter((n) => n.phone_norm === p[0]).slice(-1);
  if (/^INSERT INTO customer_payer_names/.test(sql)) { const ex = T.names.find((n) => n.phone_norm === p[0] && n.name_norm === p[1]); if (ex) ex.times_used++; else T.names.push({ phone_norm: p[0], name_norm: p[1], name_display: p[2], times_used: 1 }); return { affectedRows: 1 }; }
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE upi_ref = \?/.test(sql)) return T.credits.filter((c) => c.upi_ref === p[0]).map((c) => ({ ...c }));
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE id = \?/.test(sql)) return T.credits.filter((c) => c.id === p[0]).map((c) => ({ ...c }));
  if (/^SELECT id, upi_ref, amount, order_ids, raw, received_at FROM bank_credits WHERE consumed_order_id IS NULL AND ROUND\(amount\) = ROUND\(\?\) AND received_at BETWEEN/.test(sql))
    return T.credits.filter((c) => !c.consumed_order_id && Math.round(c.amount) === Math.round(p[0]) && c.received_at >= p[1] && c.received_at <= p[2]).map((c) => ({ ...c }));
  if (/^UPDATE bank_credits SET consumed_order_id = \? WHERE id = \? AND consumed_order_id IS NULL/.test(sql)) {
    await new Promise((r) => setImmediate(r)); // let concurrent callers interleave
    const c = T.credits.find((x) => x.id === p[1] && !x.consumed_order_id); if (!c) return { affectedRows: 0 }; c.consumed_order_id = p[0]; return { affectedRows: 1 };
  }
  if (/^UPDATE bank_credits SET consumed_order_id = NULL/.test(sql)) { const c = T.credits.find((x) => x.id === p[0] && x.consumed_order_id === p[1]); if (c) c.consumed_order_id = null; return { affectedRows: c ? 1 : 0 }; }
  if (/^SELECT order_id, payer_name FROM payment_claims WHERE status IN/.test(sql)) return T.claims.filter((c) => openSt(c.status) && c.order_id !== p[0] && Math.round(c.amount) === Math.round(p[1]) && c.created_at >= p[2] && c.created_at <= p[3]);
  if (/^SELECT id, order_id, payer_name, status, reason, created_at FROM payment_claims WHERE order_id = \? ORDER BY id DESC LIMIT 1/.test(sql)) return T.claims.filter((c) => c.order_id === p[0]).slice(-1);
  if (/^SELECT id, order_id, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE order_id = \? ORDER BY id DESC$/.test(sql)) return T.claims.filter((c) => c.order_id === p[0]).slice().reverse().map((c) => ({ ...c }));
  if (/FROM payment_claims WHERE order_id = \? AND status <> 'REPLACED' ORDER BY id DESC LIMIT 1/.test(sql)) return T.claims.filter((c) => c.order_id === p[0] && c.status !== 'REPLACED').slice(-1).map((c) => ({ ...c }));
  if (/FROM payment_claims WHERE status IN \('WAITING', 'REVIEW'\) AND source = 'CUSTOMER' AND created_at > \?/.test(sql)) return T.claims.filter((c) => openSt(c.status) && c.source === 'CUSTOMER' && c.created_at > p[0]).map((c) => ({ ...c }));
  if (/^UPDATE payment_claims SET status = 'REPLACED'/.test(sql)) { T.claims.forEach((c) => { if (c.order_id === p[0] && openSt(c.status)) c.status = 'REPLACED'; }); return { affectedRows: 1 }; }
  if (/^INSERT INTO payment_claims .*'WAITING', '', 'CUSTOMER'/.test(sql)) { const id = T.claims.length + 1; T.claims.push({ id, order_id: p[0], phone_norm: p[1], amount: p[2], payer_name: p[3], utr: p[4], status: 'WAITING', reason: '', credit_id: null, source: 'CUSTOMER', created_at: p[5] }); return { insertId: id, affectedRows: 1 }; }
  if (/^INSERT INTO payment_claims .*'MATCHED', \?, \?, 'LEARNED'/.test(sql)) { const id = T.claims.length + 1; T.claims.push({ id, order_id: p[0], phone_norm: p[1], amount: p[2], payer_name: p[3], status: 'MATCHED', reason: p[4], credit_id: p[5], source: 'LEARNED', created_at: p[6] }); return { insertId: id, affectedRows: 1 }; }
  if (/^UPDATE payment_claims SET status = \?, reason = \?, credit_id = \?, candidates = \?/.test(sql)) { const c = T.claims.find((x) => x.id === p[4] && openSt(x.status)); if (c) Object.assign(c, { status: p[0], reason: p[1], credit_id: p[2], candidates: p[3] }); return { affectedRows: c ? 1 : 0 }; }
  if (/^SELECT id, order_id, phone_norm, amount, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE id = \?/.test(sql)) return T.claims.filter((c) => c.id === p[0]).map((c) => ({ ...c }));
  if (/^UPDATE payment_claims SET status = 'APPROVED'/.test(sql)) { const c = T.claims.find((x) => x.id === p[2] && openSt(x.status)); if (c) Object.assign(c, { status: 'APPROVED', credit_id: p[0], admin_note: p[1] }); return { affectedRows: c ? 1 : 0 }; }
  if (/^UPDATE payment_claims SET status = 'REJECTED'/.test(sql)) { const c = T.claims.find((x) => x.id === p[1] && openSt(x.status)); if (c) Object.assign(c, { status: 'REJECTED', admin_note: p[0] }); return { affectedRows: c ? 1 : 0 }; }
  if (/^SELECT c.id, c.order_id/.test(sql)) return T.claims.filter((c) => (/status IN \('WAITING', 'REVIEW'\)/.test(sql) ? openSt(c.status) : /c.status = \?/.test(sql) ? c.status === p[0] : c.status !== 'REPLACED')).reverse().map((c) => ({ ...c, service: 'Netflix', plan: 'Private 1M', customer_name: 'Test' }));
  if (/^SELECT status, COUNT\(\*\) n FROM payment_claims/.test(sql)) { const out = {}; T.claims.filter((c) => openSt(c.status)).forEach((c) => { out[c.status] = (out[c.status] || 0) + 1; }); return Object.keys(out).map((k) => ({ status: k, n: out[k] })); }
  if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
  throw new Error('unexpected SQL in test: ' + sql);
}
const mockDb = { ENABLED: true, query: q, ping: async () => ({ ok: true }), getPool: () => null };
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

const pm = require('../paymatch');
pm._internal.deps.now = () => clock;
pm._internal.deps.markPaid = async (orderId, ref) => { const o = T.orders.find((x) => x.order_id === orderId); o.status = 'PAID'; T.paid.push({ orderId, ref }); return { ok: true }; };

const A = '9876543210', B = '9123456780';
let seq = 1;
const addOrder = (id, phone, amount, minAgo, extra) => { T.orders.push(Object.assign({ order_id: id, phone_norm: phone, final_amount: amount, status: 'CREATED', source: 'node', order_type: 'NEW', created_at_sheet: at(-(minAgo || 3)), raw_json: JSON.stringify({ AccessTokenHash: hash('tok-' + id) }) }, extra || {})); };
const addCredit = (ref, amount, name, minFromNow, note) => { const c = { id: seq++, upi_ref: ref, amount, order_ids: /^FF\d+$/.test(note || '') ? note : '', raw: alert(ref, name, note), received_at: at(minFromNow || 0), consumed_order_id: null }; T.credits.push(c); return c; };
const proofA = (id) => ({ token: 'tok-' + id });
const fresh = () => { reset(); pm._internal.reset(); seq = 1; };

(async () => {
  section('names');
  const sc = pm.nameScore;
  ok('exact, case / dots / spaces', sc('RAHUL KUMAR SHARMA', ' rahul  kumar. sharma ') === 'EXACT');
  ok('bank cut at 20 characters', sc('NANDYALA VEERA VENKA', 'Nandyala Veera Venkata Rao') === 'STRONG');
  ok('bank name without spaces', sc('BHABHORDAKSHKUMARVIJ', 'Bhabhor Daksh Kumar Vijay') === 'STRONG');
  ok('initials missing in typed name', sc('E L GUNAVANTH KUMAR', 'Gunavanth Kumar') === 'STRONG');
  ok('initials typed with dots, other order', sc('C B BHAGYA LAKSHMI', 'Bhagya Lakshmi C.B.') === 'STRONG');
  ok('word order swapped', sc('SHARMA RAHUL', 'Rahul Sharma') === 'STRONG');
  ok('different initials → weak', sc('A K SINGH RAJ', 'B R Singh Raj') === 'WEAK');
  ok('missing middle name → weak (review)', sc('GOVIND KUMAR SHARMA', 'Govind Sharma') === 'WEAK');
  ok('different person → none', sc('ANSHU', 'Priya Verma') === 'NONE');
  ok('short single first name is not strong', sc('RAM', 'Ram Kumar') !== 'STRONG' && sc('RAM', 'Ram Kumar') !== 'EXACT');
  const pa = pm.parseAlert(alert('515365837394', 'GOVIND KUMAR SHARMA', 'FF8817310', 'SBIN0013560'));
  ok('alert parse: name, note, IFSC', pa.payerName === 'GOVIND KUMAR SHARMA' && pa.note === 'FF8817310' && pa.ifsc === 'SBIN0013560', pa);
  ok('alert parse: no note', pm.parseAlert(alert('662002120058', 'ANSHU', 'UPI')).note === 'UPI');

  section('settings + QR');
  let r = pm.validateSettings({ backupVpa: 'Flux.Film@OKAXIS', windowMin: 20 });
  ok('valid settings normalised', r.ok && r.settings.backupVpa === 'flux.film@okaxis' && r.settings.windowMin === 20);
  ok('bad UPI id rejected', !pm.validateSettings({ backupVpa: 'not a vpa' }).ok);
  ok('window out of range rejected', !pm.validateSettings({ windowMin: 1 }).ok);
  r = await pm.saveSettings({ backupVpa: 'backup@ybl', backupPayee: 'FluxFilm Backup' });
  ok('saved to app_settings', r.ok && JSON.parse(T.settings.payfallback).backupVpa === 'backup@ybl');
  ok('QR must be an image', !(await pm.saveQr('data:text/html;base64,PGI+')).ok);
  ok('QR too big rejected', !(await pm.saveQr('data:image/png;base64,' + 'A'.repeat(800000))).ok);
  r = await pm.saveQr('data:image/png;base64,iVBORw0KGgo=');
  ok('QR saved + removed', r.ok && r.hasQr && T.settings.payfallback_qr && (await pm.saveQr('')).ok && !T.settings.payfallback_qr);

  section('backup payment details');
  fresh();
  await pm.saveSettings({ backupVpa: 'backup@ybl', backupPayee: 'FluxFilm' });
  addOrder('FF1000001', A, 99);
  r = await pm.getBackupPayment('FF1000001', { phone: B });
  ok("someone else's order is refused", !r.ok);
  r = await pm.getBackupPayment('FF1000001', proofA('FF1000001'));
  ok('backup UPI + amount, link without amount/note', r.ok && r.vpa === 'backup@ybl' && r.amount === 99 && !/am=|tn=/.test(r.upiLink) && r.lastClaim === null, r);
  r = await pm.getBackupPayment('FF1000001', { phone: A });
  ok('order phone also works', r.ok);
  ok('first time: no remembered name', r.knownName === '');
  T.claims.push({ id: 99, order_id: 'FF0999999', phone_norm: A, amount: 99, payer_name: 'RAHUL KUMAR SHARMA', status: 'MATCHED', source: 'CUSTOMER' });
  T.names.push({ phone_norm: A, name_norm: 'RAHUL KUMAR SHARM', name_display: 'RAHUL KUMAR SHARM', times_used: 1 });
  r = await pm.getBackupPayment('FF1000001', proofA('FF1000001'));
  ok('next time: the name they typed last time is offered (not the bank-cut one)', r.knownName === 'RAHUL KUMAR SHARMA', r.knownName);
  T.claims = T.claims.filter((c) => c.id !== 99);
  r = await pm.getBackupPayment('FF1000001', proofA('FF1000001'));
  ok('only a learned name (auto-matched before) → that name', r.knownName === 'RAHUL KUMAR SHARM', r.knownName);
  T.names = [];

  section('claim validation');
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), ' . ', '');
  ok('payer name required', !r.ok && r.field === 'name');
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul', '12345');
  ok('short UTR rejected', !r.ok && r.field === 'utr');
  r = await pm.claimPayment('FF1000001', { phone: B, token: 'tok-FF1000002' }, 'Rahul Sharma', '');
  ok("can't claim another customer's order", !r.ok && T.claims.length === 0);

  section('UTR exact match');
  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('625396796414', 99, 'KESHAV KAUSHIK', -1);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Keshav K', '6253 9679 6414');
  ok('UTR + amount → matched straight away', r.ok && r.status === 'MATCHED' && r.paid && T.paid[0].ref === '625396796414' && T.credits[0].consumed_order_id === 'FF1000001', r);
  ok('typed name learned for next time', T.names.some((n) => n.phone_norm === A && n.name_norm === 'KESHAV K'));

  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('625396796414', 149, 'KESHAV KAUSHIK', -1);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Keshav Kaushik', '625396796414');
  ok('UTR with a different amount → review, not paid', r.status === 'REVIEW' && !T.paid.length && /amount/.test(T.claims[0].reason), T.claims[0]);

  fresh();
  addOrder('FF1000001', A, 99);
  const used = addCredit('625396796414', 99, 'KESHAV KAUSHIK', -1); used.consumed_order_id = 'FF7777777';
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Keshav Kaushik', '625396796414');
  ok('UTR already used by another order → review', r.status === 'REVIEW' && !T.paid.length && /FF7777777/.test(T.claims[0].reason));

  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('625396796414', 99, 'KESHAV KAUSHIK', -1, 'FF5555555');
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Keshav Kaushik', '625396796414');
  ok("payment whose note has another order id can't be claimed", r.status === 'REVIEW' && !T.paid.length);

  section('payer name + amount + time');
  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('111111111111', 99, 'NANDYALA VEERA VENKA', -2);
  addCredit('222222222222', 99, 'PRIYA VERMA', -4);
  addCredit('333333333333', 149, 'NANDYALA VEERA VENKA', -1);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'nandyala veera venkata rao', '');
  ok('one strong name among others → matched', r.status === 'MATCHED' && T.paid[0].ref === '111111111111', T.claims[0]);
  ok('bank form of the name learned too', T.names.some((n) => n.name_norm === 'NANDYALA VEERA VENKA') && T.names.some((n) => n.name_norm === 'NANDYALA VEERA VENKATA RAO'));

  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('111111111111', 99, 'RAHUL SHARMA', -3);
  addCredit('222222222222', 99, 'RAHUL SHARMA', -1);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('two payments with the same name → review, nothing taken', r.status === 'REVIEW' && !T.paid.length && T.credits.every((c) => !c.consumed_order_id));

  fresh();
  addOrder('FF1000001', A, 99, 40);
  addCredit('111111111111', 99, 'RAHUL SHARMA', -25);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('payment outside the 15-min window → waiting, not matched', r.status === 'WAITING' && !T.paid.length, T.claims[0]);

  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('111111111111', 98, 'RAHUL SHARMA', -1);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('amount ₹1 different → not matched', r.status === 'WAITING' && !T.paid.length);

  fresh();
  addOrder('FF1000001', A, 99);
  const taken = addCredit('111111111111', 99, 'RAHUL SHARMA', -1); taken.consumed_order_id = 'FF9999999';
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('credit already consumed → not matched', r.status === 'WAITING' && !T.paid.length);

  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('111111111111', 99, 'GOVIND KUMAR SHARMA', -1);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Govind Sharma', '');
  ok('partial name → review with the candidate listed', r.status === 'REVIEW' && !T.paid.length && JSON.parse(T.claims[0].candidates)[0].score === 'WEAK');

  section('waiting → bank mail arrives → matched; nothing → review');
  fresh();
  addOrder('FF1000001', A, 99);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('no bank alert yet → waiting', r.status === 'WAITING');
  clock = new Date(clock.getTime() + 60e3);
  addCredit('444444444444', 99, 'RAHUL SHARMA', 0);
  let sw = await pm.sweep();
  ok('bank mail sweep matches it', sw.matched === 1 && T.claims[0].status === 'MATCHED' && T.paid.length === 1, sw);
  r = await pm.getClaimStatus('FF1000001', proofA('FF1000001'));
  ok('customer status poll says matched', r.status === 'MATCHED' && r.paid);

  fresh();
  addOrder('FF1000001', A, 99);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  clock = new Date(clock.getTime() + 31 * 60e3);
  r = await pm.getClaimStatus('FF1000001', proofA('FF1000001'));
  ok('nothing after 30 min → under review', r.status === 'REVIEW' && /No ₹99 payment/.test(T.claims[0].reason), T.claims[0]);
  r = await pm.getClaimStatus('FF1000001', { phone: B });
  ok("status of someone else's order refused", !r.ok);

  section('corrections, limits, auto-accept off');
  fresh();
  addOrder('FF1000001', A, 99);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Shrma', '');
  addCredit('555555555555', 99, 'RAHUL SHARMA', 0);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('corrected name replaces the old claim and matches', r.status === 'MATCHED' && T.claims[0].status === 'REPLACED');
  fresh();
  await pm.saveSettings({ maxClaimsPerOrder: 2 });
  addOrder('FF1000001', A, 99);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'One', '');
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Two', '');
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Three', '');
  ok('claims per order are limited', !r.ok && r.tooMany && T.claims.length === 2);
  fresh();
  await pm.saveSettings({ autoAccept: false });
  addOrder('FF1000001', A, 99);
  addCredit('555555555555', 99, 'RAHUL SHARMA', 0);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('auto-accept off → review even for a clean match', r.status === 'REVIEW' && !T.paid.length);

  section('two customers, one payment');
  fresh();
  addOrder('FF1000001', A, 99);
  addOrder('FF1000002', B, 99);
  addCredit('666666666666', 99, 'RAHUL SHARMA', 0);
  const [c1, c2] = await Promise.all([
    pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', ''),
    pm.claimPayment('FF1000002', proofA('FF1000002'), 'Rahul Sharma', ''),
  ]);
  ok('same name on two orders at once → both reviewed, credit untouched', c1.status === 'REVIEW' && c2.status === 'REVIEW' && !T.credits[0].consumed_order_id && !T.paid.length, [c1, c2]);
  const [a1, a2] = await Promise.all([pm.approveClaim(T.claims[0].id, 1), pm.approveClaim(T.claims[1].id, 1)]);
  ok('admin approving the same payment twice at once → only one wins', [a1, a2].filter((x) => x.ok).length === 1 && T.paid.length === 1 && /already used|just used/.test((a1.ok ? a2 : a1).message), [a1, a2]);

  section('learned names (no form)');
  fresh();
  T.names.push({ phone_norm: A, name_norm: 'RAHUL SHARMA', times_used: 1 });
  addOrder('FF1000001', A, 99);
  addCredit('777777777777', 99, 'RAHUL SHARMA', 0);
  r = await pm.autoMatchLearned('FF1000001');
  ok('known payer name + amount + time → paid without a form', r && r.paid && T.paid[0].ref === '777777777777' && T.claims[0].source === 'LEARNED');
  fresh();
  T.names.push({ phone_norm: A, name_norm: 'RAHUL SHARMA', times_used: 1 }, { phone_norm: B, name_norm: 'RAHUL SHARMA', times_used: 1 });
  addOrder('FF1000001', A, 99); addOrder('FF1000002', B, 99);
  addCredit('777777777777', 99, 'RAHUL SHARMA', 0);
  r = await pm.autoMatchLearned('FF1000001');
  ok('two unpaid orders from people with that name → not auto-matched', !r && !T.paid.length);
  fresh();
  T.names.push({ phone_norm: A, name_norm: 'RAHUL SHARMA', times_used: 1 });
  addOrder('FF1000001', A, 99);
  addCredit('777777777777', 99, 'PRIYA VERMA', 0);
  ok('other name → nothing', !(await pm.autoMatchLearned('FF1000001')) && !T.paid.length);
  fresh();
  T.names.push({ phone_norm: A, name_norm: 'RAHUL SHARMA', times_used: 1 });
  addOrder('FF1000001', A, 99);
  addCredit('777777777777', 99, 'RAHUL SHARMA', 0);
  sw = await pm.sweep();
  ok('bank mail sweep also runs learned matching', sw.learned === 1 && T.paid.length === 1, sw);

  section('admin queue');
  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('888888888888', 99, 'GOVIND KUMAR SHARMA', -1);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Govind Sharma', '');
  let list = await pm.listClaims({ status: 'OPEN' });
  ok('open queue lists the claim with bank options', list.ok && list.claims.length === 1 && list.claims[0].options[0].upiRef === '888888888888' && list.claims[0].options[0].payerName === 'GOVIND KUMAR SHARMA' && list.counts.REVIEW === 1, list);
  r = await pm.approveClaim(T.claims[0].id, 99, '');
  ok('approve with unknown credit → error', !r.ok);
  r = await pm.approveClaim(T.claims[0].id, 1, 'checked bank app');
  ok('approve with the picked bank payment → paid + learned', r.ok && T.paid[0].ref === '888888888888' && T.claims[0].status === 'APPROVED' && T.names.some((n) => n.name_norm === 'GOVIND KUMAR SHARMA'));
  r = await pm.approveClaim(T.claims[0].id, null, '');
  ok("can't decide twice", !r.ok);
  fresh();
  addOrder('FF1000001', A, 99);
  addCredit('888888888888', 149, 'GOVIND KUMAR SHARMA', -1);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Govind Sharma', '');
  r = await pm.approveClaim(T.claims[0].id, 1, '');
  ok('approve with a different amount → refused', !r.ok && /Amount differs/.test(r.message));
  r = await pm.approveClaim(T.claims[0].id, null, 'saw it in bank app');
  ok('approve by hand (no bank row) → paid', r.ok && T.paid[0].ref === 'MANUAL-REVIEW-1');
  fresh();
  addOrder('FF1000001', A, 99);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Nobody', '');
  r = await pm.rejectClaim(T.claims[0].id, 'no money');
  ok('reject', r.ok && T.claims[0].status === 'REJECTED' && !T.paid.length);
  r = await pm.getClaimStatus('FF1000001', proofA('FF1000001'));
  ok('customer sees rejected message', r.status === 'REJECTED' && /WhatsApp/.test(r.message));
  await pm.sweep();
  ok('sweep never reopens a decided claim', T.claims[0].status === 'REJECTED');

  section('before schema-v17');
  fresh(); tables = false;
  addOrder('FF1000001', A, 99);
  r = await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Rahul Sharma', '');
  ok('claim degrades to a WhatsApp message', !r.ok && r.unavailable);
  ok('learned match is skipped quietly', (await pm.autoMatchLearned('FF1000001')) === null);
  ok('admin queue says needs schema', (await pm.listClaims({})).needsSchema === true && (await pm.schemaReady()) === false);
  ok('backup details still work', (await pm.getBackupPayment('FF1000001', proofA('FF1000001'))).ok);
  tables = true;

  section('admin API + server wiring');
  fresh();
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json({ limit: '1mb' }));
  const audits = [];
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), audit: { record: (req, e) => audits.push(e) } });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const x = await fetch(base + p, { headers: h || H }); return { status: x.status, body: await x.json() }; };
  const post = async (p, b) => { const x = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() }; };
  let g = await get('/admin/api/payments/settings', { 'Content-Type': 'application/json' });
  ok('needs admin sign-in', g.status === 401 || g.status === 403);
  g = await get('/admin/api/payments/settings');
  ok('settings GET', g.body.ok && g.body.settings.windowMin === 15 && g.body.needsSchema === false, g.body);
  g = await post('/admin/api/payments/settings', Object.assign({}, pm.DEFAULTS, { backupVpa: 'x' }));
  ok('bad settings → 400', g.status === 400);
  g = await post('/admin/api/payments/settings', Object.assign({}, pm.DEFAULTS, { backupVpa: 'owner@ybl', windowMin: 20 }));
  ok('settings saved + change log', g.body.ok && g.body.changed.includes('backupVpa') && audits.some((e) => e.action === 'payments.settings' && /windowMin 15 → 20/.test(e.summary)));
  g = await post('/admin/api/payments/qr', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  ok('QR upload + change log', g.body.ok && audits.some((e) => e.action === 'payments.qr'));
  addOrder('FF1000001', A, 99);
  await pm.claimPayment('FF1000001', proofA('FF1000001'), 'Nobody Here', '');
  g = await get('/admin/api/payments/claims?status=OPEN');
  ok('claims GET', g.body.ok && g.body.claims.length === 1);
  g = await post('/admin/api/payments/approve', { id: T.claims[0].id, note: 'seen in bank' });
  ok('approve POST + change log', g.body.ok && audits.some((e) => e.action === 'payments.approve' && e.id === 'FF1000001'));
  g = await post('/admin/api/payments/reject', { id: T.claims[0].id });
  ok('reject after approve → 400', g.status === 400);
  const html = await (await fetch(base + '/panel')).text();
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const src of scripts) { try { new Function(src); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('admin panel scripts still parse', parsed);

  const fs = require('fs'); const path = require('path');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('storefront actions routed + rate-limited', ['getBackupPayment', 'claimManualPayment', 'getClaimStatus'].every((a) => new RegExp("'" + a + "'").test(srv) && new RegExp(a + ': security.rateLimiter').test(srv)));
  ok('verifyPayment tries learned names; bank mail triggers a sweep', /autoMatchLearned\(orderId\)/.test(fs.readFileSync(path.join(__dirname, '..', 'order.js'), 'utf8')) && /paymatch'\)\.sweep\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'payments.js'), 'utf8')));
  // MySQL FIELD() gives the LAST listed value the highest number, so with DESC 'REVIEW' (needs the owner) must be listed last.
  ok('admin queue lists claims needing review before waiting ones', /FIELD\(c\.status, \\'WAITING\\', \\'REVIEW\\'\) DESC/.test(fs.readFileSync(path.join(__dirname, '..', 'paymatch.js'), 'utf8')));
  ok('schema-v17 creates both tables + widens app_settings', /CREATE TABLE IF NOT EXISTS payment_claims/.test(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v17.sql'), 'utf8')) && /MEDIUMTEXT/.test(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v17.sql'), 'utf8')));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
