/* 🏦 Bank payments (adminbankcredits.js): go-live cutoff for "unmatched", "Not a sale", link to an order. Run: npm test
 * Investigation 2026-09-15: all 174 unmatched credits were from before go-live (2026-09-14 21:00 IST), when the old
 * go site / Sheet confirmed payments; 0 after. The Today card must only count credits since go-live. */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const alert = (name, note) => 'An amount of INR 99.00 has been credited ... UPI REF NO 612345678901 P2P-' + name + '-' + note + '-SBIN0001234- HEAD OFFICE';
const D = {
  cols: false,
  settings: {},
  credits: [
    { id: 1, upi_ref: '600000000001', amount: 900, order_ids: '', raw: alert('OLD PAYER ONE', 'UPI'), received_at: '2026-09-10 10:00:00', consumed_order_id: null },
    { id: 2, upi_ref: '600000000002', amount: 499, order_ids: '', raw: alert('OLD PAYER TWO', 'UPI'), received_at: '2026-09-14 20:59:59', consumed_order_id: null },
    { id: 3, upi_ref: '600000000003', amount: 69, order_ids: '', raw: alert('NEW PAYER', 'UPI'), received_at: '2026-09-14 21:00:00', consumed_order_id: null },
    { id: 4, upi_ref: '600000000004', amount: 10, order_ids: '', raw: alert('PAYTM', 'SETTLEMENT'), received_at: '2026-09-15 09:00:00', consumed_order_id: null },
    { id: 5, upi_ref: '600000000005', amount: 199, order_ids: 'FF1000001', raw: alert('MATCHED PAYER', 'FF1000001'), received_at: '2026-09-15 10:00:00', consumed_order_id: 'FF1000001' },
    { id: 6, upi_ref: '600000000006', amount: 139, order_ids: '', raw: alert('WHATSAPP BUYER', 'UPI'), received_at: '2026-09-15 11:00:00', consumed_order_id: null },
  ],
  orders: [
    { order_id: 'FF1000001', name: 'Matched', service: 'Netflix', plan: 'Private 1M', final_amount: 199, status: 'PAID', source: 'node', created_at_sheet: '2026-09-15 09:58:00' },
    { order_id: 'FF1000002', name: 'Waiting', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', final_amount: 139, status: 'CREATED', source: 'node', created_at_sheet: '2026-09-15 10:55:00' },
    { order_id: 'FF1000003', name: 'Other amount', service: 'Prime Video', plan: '1 Month', final_amount: 79, status: 'PAID', source: 'node', created_at_sheet: '2026-09-15 08:00:00' },
  ],
};
const calls = [];
const unknownCol = () => { const e = new Error("Unknown column 'ignored_at' in 'field list'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; };
function matchWhere(sql, params) {
  const w = sql.slice(sql.indexOf(' WHERE ') + 7);
  let pi = 0;
  const matched = /consumed_order_id IS NOT NULL/.test(w);
  const before = /received_at < \?/.test(w); const after = /received_at >= \?/.test(w);
  const cut = before || after ? params[pi++] : null;
  const inM = w.match(/id (NOT )?IN \(([?, ]+)\)/);
  const ids = inM ? params.slice(pi, pi + (inM[2].match(/\?/g) || []).length) : [];
  const colsUsed = /ignored_at IS (NOT )?NULL/.test(w);
  const wantIgnored = /ignored_at IS NOT NULL|0 = 1/.test(w);
  return (c) => {
    if (matched) return !!c.consumed_order_id;
    if (c.consumed_order_id) return false;
    const ign = (colsUsed && !!c.ignored_at) || ids.includes(c.id);
    if (wantIgnored) return ign;
    if (ign) return false;
    if (before) return !c.received_at || c.received_at < cut;
    if (after) return c.received_at >= cut;
    return true;
  };
}
const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    sql = sql.replace(/\s+/g, ' ').trim(); params = params || []; calls.push({ sql, params });
    if ((sql.match(/\?/g) || []).length !== params.length) throw new Error('placeholder count mismatch: ' + sql);
    if (/^INSERT INTO audit_log/.test(sql)) return { affectedRows: 1 };
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return D.settings[params[0]] != null ? [{ value: D.settings[params[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { D.settings[params[0]] = params[1]; return { affectedRows: 1 }; }
    if (/ignored_at/.test(sql) && !D.cols) unknownCol();
    if (/^SELECT ignored_at, ignored_reason, ignored_note FROM bank_credits LIMIT 0/.test(sql)) return [];
    if (/^SELECT COUNT\(\*\) n FROM bank_credits WHERE/.test(sql)) return [{ n: D.credits.filter(matchWhere(sql, params)).length }];
    if (/FROM bank_credits b LEFT JOIN orders o/.test(sql)) {
      const f = matchWhere(sql.replace(/b\./g, ''), params);
      return D.credits.filter(f).sort((a, b) => (a.received_at < b.received_at ? 1 : -1)).map((c) => { const o = D.orders.find((x) => x.order_id === c.consumed_order_id) || {}; return Object.assign({}, c, { order_name: o.name, order_service: o.service, order_plan: o.plan, order_amount: o.final_amount, order_status: o.status }); });
    }
    if (/FROM bank_credits WHERE id = \? LIMIT 1$/.test(sql)) { const c = D.credits.find((x) => x.id === params[0]); return c ? [Object.assign({}, c)] : []; }
    if (/^SELECT id, upi_ref FROM bank_credits WHERE consumed_order_id = \? AND id <> \?/.test(sql)) return D.credits.filter((c) => c.consumed_order_id === params[0] && c.id !== params[1]);
    if (/^SELECT order_id, name, service, plan, final_amount, status, fulfillment_status, source, txn_ref FROM orders WHERE order_id = \?/.test(sql)) return D.orders.filter((o) => o.order_id === params[0]);
    if (/^UPDATE bank_credits SET ignored_at = NOW\(\)/.test(sql)) { const c = D.credits.find((x) => x.id === params[2] && !x.consumed_order_id && !x.ignored_at); if (!c) return { affectedRows: 0 }; Object.assign(c, { ignored_at: '2026-09-15 12:00:00', ignored_reason: params[0], ignored_note: params[1] }); return { affectedRows: 1 }; }
    if (/^UPDATE bank_credits SET ignored_at = NULL/.test(sql)) { const c = D.credits.find((x) => x.id === params[0]); Object.assign(c, { ignored_at: null, ignored_reason: null, ignored_note: null }); return { affectedRows: 1 }; }
    if (/^UPDATE bank_credits SET consumed_order_id = \?/.test(sql)) { const c = D.credits.find((x) => x.id === params[1] && !x.consumed_order_id); if (!c) return { affectedRows: 0 }; c.consumed_order_id = params[0]; if (/ignored_at = NULL/.test(sql)) Object.assign(c, { ignored_at: null, ignored_reason: null, ignored_note: null }); return { affectedRows: 1 }; }
    if (/^UPDATE bank_credits SET consumed_order_id = NULL WHERE id = \? AND consumed_order_id = \?/.test(sql)) { const c = D.credits.find((x) => x.id === params[0] && x.consumed_order_id === params[1]); if (!c) return { affectedRows: 0 }; c.consumed_order_id = null; return { affectedRows: 1 }; }
    if (/FROM orders o WHERE o.order_id IN/.test(sql)) return D.orders.filter((o) => params.includes(o.order_id)).map((o) => Object.assign({}, o, { linked_credit_id: (D.credits.find((c) => c.consumed_order_id === o.order_id) || {}).id || null }));
    if (/FROM orders o WHERE ROUND\(o.final_amount\) = ROUND\(\?\)/.test(sql)) return D.orders.filter((o) => Math.round(o.final_amount) === Math.round(params[0])).map((o) => Object.assign({}, o, { linked_credit_id: (D.credits.find((c) => c.consumed_order_id === o.order_id) || {}).id || null }));
    return [];
  },
  getPool: () => null, ping: async () => ({ ok: true }),
};

(async () => {
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const bank = require('../adminbankcredits');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const audits = (a) => calls.filter((c) => /^INSERT INTO audit_log/.test(c.sql) && c.params[0] === a);
  const st = bank.storeFor(mockDb);
  try {
    section('go-live cutoff');
    ok('default go-live = 2026-09-14 21:00:00 (one constant)', bank.GO_LIVE_DEFAULT === '2026-09-14 21:00:00');
    let c = await st.countUnmatched();
    ok('Today count: only unmatched credits since go-live (3 · 4 · 6), not the old ones (1 · 2)', c.count === 3 && c.cutoff === '2026-09-14 21:00:00', c);
    let r = await get('/admin/api/bank-credits');
    ok('list defaults to "unmatched after go-live", newest first, payer name parsed', r.body.ok && r.body.filter === 'after' && r.body.credits.map((x) => x.id).join() === '6,4,3' && r.body.credits[0].payerName === 'WHATSAPP BUYER', r.body.credits && r.body.credits.map((x) => [x.id, x.payerName]));
    ok('counts per filter: after 3 · before 2 · ignored 0 · matched 1; schema not run yet', (r.body.counts.after === 3 && r.body.counts.before === 2 && r.body.counts.ignored === 0 && r.body.counts.matched === 1 && r.body.schemaReady === false), r.body.counts);
    r = await get('/admin/api/bank-credits?filter=before');
    ok('"before go-live" filter', r.body.credits.map((x) => x.id).join() === '2,1' && r.body.credits.every((x) => x.beforeGoLive), r.body.credits.map((x) => x.id));
    r = await get('/admin/api/bank-credits?filter=matched');
    ok('"matched" shows the order', r.body.credits.length === 1 && r.body.credits[0].orderId === 'FF1000001' && r.body.credits[0].order.name === 'Matched', r.body.credits);
    r = await post('/admin/api/bank-credits/cutoff', { cutoff: 'yesterday' });
    ok('cutoff must be a date and time', r.status === 400);
    r = await post('/admin/api/bank-credits/cutoff', { cutoff: '2026-09-10 00:00' });
    c = await st.countUnmatched();
    ok('mutation: an earlier go-live time counts the old payments too (5)', r.body.ok && c.count === 5 && c.cutoff === '2026-09-10 00:00:00', c);
    await post('/admin/api/bank-credits/cutoff', { reset: true });
    ok('reset to the default', (await st.countUnmatched()).count === 3);

    section('"Not a sale" (before schema-v23: kept in app_settings)');
    r = await post('/admin/api/bank-credits/ignore', { id: 4 });
    ok('reason required', r.status === 400 && r.body.field === 'reason');
    r = await post('/admin/api/bank-credits/ignore', { id: 4, reason: 'OTHER' });
    ok('"Other" needs a note', r.status === 400 && r.body.field === 'note');
    r = await post('/admin/api/bank-credits/ignore', { id: 4, reason: 'PAYTM_SETTLEMENT', note: 'daily settlement' });
    await tick();
    ok('marked; stored in app_settings until the schema is run', r.body.ok && r.body.storedIn === 'settings' && JSON.parse(D.settings.bank_credit_ignores)['4'].reason === 'PAYTM_SETTLEMENT', r.body);
    ok('  ...logged', audits('bank.ignore').length === 1 && /Paytm settlement/.test(audits('bank.ignore')[0].params[3]));
    ok('Today count drops to 2', (await st.countUnmatched()).count === 2);
    r = await get('/admin/api/bank-credits?filter=ignored');
    ok('"Ignored" filter lists it with the reason', r.body.credits.length === 1 && r.body.credits[0].id === 4 && r.body.credits[0].ignored.reason === 'PAYTM_SETTLEMENT' && r.body.counts.ignored === 1, r.body.credits);
    r = await post('/admin/api/bank-credits/ignore', { id: 4, reason: 'TEST' });
    ok('second tap: already marked', r.body.ok && r.body.already === true);
    r = await post('/admin/api/bank-credits/ignore', { id: 5, reason: 'TEST' });
    ok('a payment linked to an order cannot be ignored', r.status === 409 && /FF1000001/.test(r.body.message));
    r = await post('/admin/api/bank-credits/unignore', { id: 4 });
    ok('undo: back in the unmatched list', r.body.ok && (await st.countUnmatched()).count === 3 && !JSON.parse(D.settings.bank_credit_ignores)['4'], r.body);
    await post('/admin/api/bank-credits/ignore', { id: 3, reason: 'PERSONAL' });

    section('after schema-v23 (columns)');
    D.cols = true; st.reset();
    r = await post('/admin/api/bank-credits/ignore', { id: 4, reason: 'REFUND', note: 'sent back' });
    ok('now written to bank_credits.ignored_at / reason / note', r.body.ok && r.body.storedIn === 'column' && D.credits[3].ignored_reason === 'REFUND' && D.credits[3].ignored_note === 'sent back', r.body);
    ok('the one marked before the schema still counts as ignored (both places read): Today = 1', (await st.countUnmatched()).count === 1);
    r = await get('/admin/api/bank-credits?filter=ignored');
    ok('ignored list shows both', r.body.credits.map((x) => x.id).sort().join() === '3,4' && r.body.schemaReady === true, r.body.credits.map((x) => x.id));
    r = await post('/admin/api/bank-credits/unignore', { id: 4 });
    ok('undo clears the columns', r.body.ok && D.credits[3].ignored_at === null);

    section('link to an order');
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: 'FF9999999' });
    ok('unknown order → 404', r.status === 404);
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: 'FF1000003' });
    ok('amount differs → refused with both amounts', r.status === 409 && r.body.amountMismatch && r.body.paymentAmount === 139 && r.body.orderAmount === 79, r.body);
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: 'FF1000003', override: true });
    ok('override needs a reason', r.status === 400 && r.body.field === 'reason');
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: 'FF1000001' });
    ok('order already has another bank payment → refused', r.status === 409 && /#5/.test(r.body.message), r.body);
    r = await get('/admin/api/bank-credits/suggest?id=6');
    ok('suggestions: the ₹139 unpaid order, flagged free', r.body.ok && r.body.orders.length === 1 && r.body.orders[0].order_id === 'FF1000002' && r.body.orders[0].linkedCreditId === null, r.body);
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: ' ff1000002 ' });
    await tick();
    ok('linked; order still unpaid → offer "Mark paid + deliver" (never delivered automatically)', r.body.ok && D.credits[5].consumed_order_id === 'FF1000002' && r.body.needsPaid === true && r.body.canMarkPaid === true && r.body.upiRef === '600000000006' && D.orders[1].status === 'CREATED', r.body);
    ok('  ...logged', audits('bank.link').length === 1 && /FF1000002/.test(audits('bank.link')[0].params[3]));
    ok('Today count drops (only #3 ignored-before-schema and #4 remain; #4 unmatched) = 1', (await st.countUnmatched()).count === 1);
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: 'FF1000002' });
    ok('same link again: already', r.body.ok && r.body.already === true);
    r = await post('/admin/api/bank-credits/link', { id: 6, orderId: 'FF1000003', override: true, reason: 'x' });
    ok('a linked payment cannot be linked to a second order', r.status === 409 && /already linked/.test(r.body.message));
    r = await post('/admin/api/bank-credits/link', { id: 3, orderId: 'FF1000003', override: true, reason: 'customer paid ₹69 + ₹10 later' });
    ok('override with a reason links; "Not a sale" cleared from app_settings', r.body.ok && r.body.amountMismatch === true && D.credits[2].consumed_order_id === 'FF1000003' && !JSON.parse(D.settings.bank_credit_ignores)['3'], r.body);
    r = await post('/admin/api/bank-credits/unlink', { id: 3 });
    ok('unlink needs a reason', r.status === 400);
    r = await post('/admin/api/bank-credits/unlink', { id: 3, reason: 'wrong order' });
    ok('unlink frees the payment; the order is not touched', r.body.ok && D.credits[2].consumed_order_id === null && D.orders[2].status === 'PAID', r.body);

    section('access');
    ok('list needs admin', (await fetch(base + '/admin/api/bank-credits')).status === 403);
    ok('link needs admin', (await fetch(base + '/admin/api/bank-credits/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
    const html = await (await fetch(base + '/panel')).text();
    ok('panel has the 🏦 Bank payments screen', /function bankView\(/.test(html) && /\['bank', '🏦', 'Bank payments'\]/.test(html) && /\/admin\/api\/quick\/mark-paid/.test(html));
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((res) => server.close(res));
    Module._load = origLoad;
  }
  console.log('\n---------------------------------------');
  console.log('bank-credits: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
