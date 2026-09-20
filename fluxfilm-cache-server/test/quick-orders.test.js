/* Admin quick orders (WhatsApp sales) + checkout price-tampering fix. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const PLANS = [
  { service: 'Prime Video', plan: '1 Month', price: 129, durationDays: 30, allocationPolicy: 'CAPACITY', extraFieldKey: 'PRIME_DEVICE_TYPE', needsExtraField: true, extraFieldLabel: 'Device' },
  { service: 'Prime Video', plan: '2 Devices 1M', price: 229, durationDays: 30, allocationPolicy: 'CAPACITY', extraFieldKey: 'PRIME_DEVICE_TYPE', needsExtraField: true },
  { service: 'Netflix', plan: 'Private 1M', price: 199, durationDays: 30, allocationPolicy: 'PROFILE' },
  { service: 'JioHotstar', plan: '3 Months', price: 299, durationDays: 90, allocationPolicy: 'OTP_ACCOUNT' },
  { service: 'YouTube Premium', plan: '6 Months', price: 499, durationDays: 180, fulfillmentMode: 'MANUAL', allocationPolicy: 'NONE' },
  { service: 'Spotify', plan: 'Family 1M', price: 99, durationDays: 30, allocationPolicy: 'ACCOUNT', needsExtraField: true, extraFieldKey: 'SPOTIFY_ADDRESS', extraFieldLabel: 'Home address' },
];

(async () => {
  const qo = require('../quickorders');

  section('fields change with the service');
  const meta = (svc, plan) => qo.planMeta(PLANS.find((p) => p.service === svc && p.plan === plan));
  ok('Prime 1 device asks TV or mobile', meta('Prime Video', '1 Month').fields[0].type === 'tv');
  ok('Prime 2 devices asks how many are TVs (0-2)', meta('Prime Video', '2 Devices 1M').fields[0].type === 'count' && meta('Prime Video', '2 Devices 1M').fields[0].max === 2);
  ok('Netflix asks nothing extra', meta('Netflix', 'Private 1M').fields.length === 0 && meta('Netflix', 'Private 1M').kind === 'PROFILE');
  ok('OTP service asks nothing, explains Get OTP', meta('JioHotstar', '3 Months').fields.length === 0 && /Get OTP/.test(meta('JioHotstar', '3 Months').notes.join()));
  ok('manual service flagged as manual activation', meta('YouTube Premium', '6 Months').kind === 'MANUAL');
  ok('plan with its own extra field asks for it by label', meta('Spotify', 'Family 1M').fields[0].label === 'Home address');
  const cf = (svc, plan, body) => qo.checkFields(PLANS.find((p) => p.service === svc && p.plan === plan), body);
  ok('Prime without TV answer is refused with a clear message (old admin broke here)', cf('Prime Video', '1 Month', {}).ok === false && /TV or Mobile/.test(cf('Prime Video', '1 Month', {}).message));
  ok('Prime TV -> tvCount 1, TV', cf('Prime Video', '1 Month', { tvCount: '1' }).tvCount === 1 && cf('Prime Video', '1 Month', { tvCount: 1 }).extraFieldValue === 'TV');
  ok('Prime mobile -> tvCount 0, NON_TV', cf('Prime Video', '1 Month', { tvCount: '0' }).extraFieldValue === 'NON_TV');
  ok('Prime 2 devices, 1 TV -> MIXED', cf('Prime Video', '2 Devices 1M', { tvCount: 1 }).extraFieldValue === 'MIXED');
  ok('Prime TV count above devices refused', cf('Prime Video', '2 Devices 1M', { tvCount: 3 }).ok === false);
  ok('required text field refused when blank', cf('Spotify', 'Family 1M', { extraFieldValue: ' ' }).ok === false);

  section('quick order routes');
  const calls = { create: [], renew: [], paid: [], fulfil: [], sql: [] };
  let dupRows = [], custRows = [], subOwner = '9876543210';
  // 💳 orders the payment page is asked about
  const PAY_ORDERS = {
    FF9: { order_id: 'FF9', name: 'Rahul Sharma', phone_norm: '9876543210', email: 'r@x.com', service: 'Netflix', plan: 'Private 1M', final_amount: 199, status: 'CREATED', fulfillment_status: '' },
    FF8: { order_id: 'FF8', name: 'No Email', phone_norm: '9876500000', email: '', service: 'Zee5', plan: '1 Month', final_amount: 89, status: 'CREATED', fulfillment_status: '' },
    FF7: { order_id: 'FF7', name: 'Paid Already', phone_norm: '9876511111', email: 'p@x.com', service: 'Netflix', plan: 'Private 1M', final_amount: 199, status: 'PAID', fulfillment_status: 'FULFILLED' },
  };
  const mails = [];
  const fakeOrder = {
    createOrder: async (p, o) => { calls.create.push({ p, o }); return { ok: true, orderId: 'FF1', amount: o.amountOverride != null ? Number(o.amountOverride) : 129, upiLink: 'upi://x' }; },
    createRenewOrder: async (sid, plan, cc, o) => { calls.renew.push({ sid, plan, cc, o }); return { ok: true, orderId: 'FF2', amount: Number(o.amountOverride) }; },
    renewQuote: async (sid, plan) => ({ ok: true, sub: { sub_id: sid, service: 'Netflix', plan: 'Private 1M' }, plan: plan || 'Private 1M', price: 199, earlyDiscount: 20, amount: 179, daysLeft: 9, renewal: { mode: 'SAME', preview: { newExpiryText: '20 Oct 2026' } } }),
    adminMarkPaid: async (id, ref) => { calls.paid.push({ id, ref }); return { ok: true }; },
  };
  const fakeFulfill = { fulfillForAdmin: async (id) => { calls.fulfil.push(id); return { ok: true, fulfillment: 'FULFILLED', access: { user: 'u@x', pass: 'p' }, expiry: '2026-10-14 10:00:00' }; } };
  const fakeCatalog = { getBootstrap: async () => ({ ok: true, plans: PLANS }), getStockLevels: async () => ({ ok: true, levels: { 'Prime Video|||1 Month': { stock: 2, stockLevel: 'LOW' } } }) };
  const mockDb = {
    ENABLED: true,
    query: async (sql, params) => {
      sql = sql.replace(/\s+/g, ' ').trim(); calls.sql.push({ sql, params });
      if (/FROM customers c WHERE/.test(sql)) return [{ customer_id: 'CUS-1', name: 'Rahul Sharma', email: 'r@x.com', phone: '9876543210', phone_norm: '9876543210', active_subs: 2 }];
      if (/FROM orders o WHERE/.test(sql)) return [{ phone_norm: '9123456789', name: 'Rahul K', email: '' }];
      if (/FROM orders WHERE phone_norm = \? AND service = \? AND plan = \?/.test(sql)) return dupRows;
      if (/SELECT customer_id, name, email FROM customers/.test(sql)) return custRows;
      if (/SELECT phone_norm FROM subscriptions WHERE sub_id/.test(sql)) return [{ phone_norm: subOwner }];
      // 💳 paylink: one order row, by id (the payment page and /admin/api/quick/paylink read it)
      if (/FROM orders WHERE order_id = \? LIMIT 1/.test(sql)) { const o = PAY_ORDERS[String(params[0]).toUpperCase()]; return o ? [Object.assign({}, o)] : []; }
      if (/FROM orders WHERE UPPER\(status\) = 'CREATED'/.test(sql)) return [{ order_id: 'FF9', name: 'A', phone_norm: '9876543210', service: 'Netflix', plan: 'Private 1M', final_amount: 199 }];
      return { affectedRows: 1 };
    },
    getPool: () => null, ping: async () => ({ ok: true }),
  };
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync'), quick: { order: fakeOrder, fulfill: fakeFulfill, catalog: fakeCatalog },
    mailer: { send: async (to, subject, html) => { mails.push({ to, subject, html }); return { ok: true }; } } });
  require('../paylink').mount(app, { db: mockDb });
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (path) => { const r = await fetch(base + path, { headers: H }); return { status: r.status, body: await r.json() }; };
  const postq = async (path, body, headers) => { const r = await fetch(base + path, { method: 'POST', headers: headers || H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  let r = await get('/admin/api/quick/catalog');
  const prime = r.body.plans && r.body.plans.find((p) => p.plan === '1 Month');
  ok('catalog lists plans with their fields and live stock', r.body.ok && prime.fields[0].type === 'tv' && prime.stock === 2 && r.body.payMethods.includes('CASH'), r.body);
  r = await get('/admin/api/quick/customers?q=rah');
  ok('customer search by name finds profiles and order-only buyers', r.body.results.length === 2 && r.body.results[0].customerId === 'CUS-1' && r.body.results[1].source === 'orders', r.body);
  const searchSql = calls.sql.find((c) => /FROM customers c WHERE/.test(c.sql));
  ok('search looks at name, email, phone and customer id', /c.name LIKE \? OR c.email LIKE \? OR c.phone_norm LIKE \? OR c.customer_id LIKE \?/.test(searchSql.sql) && searchSql.params[0] === '%rah%' && searchSql.params[2] === '__no_match__');
  await get('/admin/api/quick/customers?q=98765');
  ok('digits search the phone number', calls.sql.filter((c) => /FROM customers c WHERE/.test(c.sql)).pop().params[2] === '%98765%');
  r = await get('/admin/api/quick/customers?q=r');
  ok('1-letter search returns nothing (no full-table scans)', r.body.results.length === 0);

  const newOrder = (extra) => Object.assign({ mode: 'NEW', phone: '98765 43210', name: 'Rahul Sharma', email: '', service: 'Prime Video', plan: '1 Month', tvCount: '1', amount: '120', payMethod: 'UPI', txnRef: 'UTR55', markPaid: true }, extra || {});
  r = await postq('/admin/api/quick/order', newOrder({ tvCount: '' }));
  ok('Prime order without TV choice -> 400, nothing created', r.status === 400 && r.body.field === 'tvCount' && calls.create.length === 0, r.body);
  r = await postq('/admin/api/quick/order', newOrder({ phone: '12345' }));
  ok('bad phone -> 400', r.status === 400 && r.body.field === 'phone');
  r = await postq('/admin/api/quick/order', newOrder({ plan: 'Ghost plan' }));
  ok('unknown / inactive plan -> 400', r.status === 400 && r.body.field === 'plan');

  custRows = [];
  r = await postq('/admin/api/quick/order', newOrder());
  const c1 = calls.create[0];
  ok('creates the order through the storefront createOrder', r.body.ok && c1 && c1.p.service === 'Prime Video' && c1.p.phone === '9876543210', r.body);
  ok('passes TV choice the way fulfilment expects (tvCount + TV)', c1.p.tvCount === 1 && c1.p.extraFieldValue === 'TV' && c1.p.extraFieldKey === 'PRIME_DEVICE_TYPE');
  ok('agreed amount + no-email allowed are server-side options', c1.o.amountOverride === 120 && c1.o.allowNoEmail === true && c1.o.rawExtra.CreatedVia === 'ADMIN');
  ok('unknown phone -> customer created (no email needed)', calls.sql.some((c) => /^INSERT INTO customers/.test(c.sql) && c.params[1] === '9876543210' && c.params[3] === '') && r.body.customerCreated === true);
  ok('mark paid -> marked with method + UTR, then account handed out', calls.paid[0].id === 'FF1' && calls.paid[0].ref === 'ADMIN-UPI:UTR55' && calls.fulfil[0] === 'FF1' && r.body.status === 'PAID' && r.body.fulfillment.access.user === 'u@x', r.body);

  dupRows = [{ order_id: 'FF1' }];
  r = await postq('/admin/api/quick/order', newOrder());
  ok('double tap within 3 min -> 409 asks to confirm, no second order', r.status === 409 && r.body.duplicate && calls.create.length === 1, r.body);
  r = await postq('/admin/api/quick/order', newOrder({ confirmDuplicate: true, markPaid: false }));
  ok('confirmed duplicate goes through; unpaid order stays CREATED', r.body.ok && calls.create.length === 2 && r.body.status === 'CREATED' && calls.paid.length === 1, r.body);
  dupRows = [];

  custRows = [{ customer_id: 'CUS-1', name: 'Rahul Sharma', email: 'r@x.com' }];
  calls.sql.length = 0;
  r = await postq('/admin/api/quick/order', newOrder({ name: 'Someone Else', email: 'other@x.com', service: 'Netflix', plan: 'Private 1M', tvCount: '' }));
  const c3 = calls.create[2];
  ok('existing customer: name/email on file are kept, not overwritten', c3.p.name === 'Rahul Sharma' && !calls.sql.some((c) => /^INSERT INTO customers/.test(c.sql)) && !calls.sql.some((c) => /^UPDATE customers/.test(c.sql)), c3.p);
  ok('Netflix needs no device field', c3.p.tvCount === null && c3.p.extraFieldValue === '');

  r = await postq('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-1', plan: 'Private 1M', amount: '179', payMethod: 'CASH', markPaid: true });
  ok('renew -> createRenewOrder with agreed amount, then paid + fulfilled', r.body.ok && calls.renew[0].sid === 'SUB-1' && calls.renew[0].o.amountOverride === 179 && calls.paid.pop().ref === 'ADMIN-CASH' && r.body.status === 'PAID', r.body);
  subOwner = '9000000000';
  r = await postq('/admin/api/quick/order', { mode: 'RENEW', phone: '9876543210', subId: 'SUB-1', amount: '179', markPaid: true });
  ok('renewing a subscription of another phone is refused', r.status === 400 && r.body.field === 'subId' && calls.renew.length === 1, r.body);
  subOwner = '9876543210';

  r = await get('/admin/api/quick/renew-quote?sub_id=SUB-1');
  ok('renew quote shows plans, suggested amount and new expiry', r.body.ok && r.body.amount === 179 && r.body.mode === 'SAME' && r.body.preview.newExpiryText === '20 Oct 2026', r.body);
  r = await get('/admin/api/quick/unpaid?q=FF9');
  ok('unpaid order list', r.body.ok && r.body.orders[0].order_id === 'FF9');
  r = await postq('/admin/api/quick/mark-paid', { orderId: 'FF9', payMethod: 'bank', txnRef: 'X1' });
  ok('mark existing order paid -> fulfilled', r.body.ok && calls.paid.pop().ref === 'ADMIN-BANK:X1' && calls.fulfil.pop() === 'FF9');
  r = await postq('/admin/api/quick/order', newOrder(), { 'Content-Type': 'application/json' });
  ok('not signed in -> 403', r.status === 403);

  const html = await (await fetch(base + '/panel')).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('panel has the Quick order screen and still parses', parsed && /function quickView\(/.test(html) && /\['quick', '⚡', 'Quick order'\]/.test(html));
  // ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // 💳 Owner, 20 Sep: "add option of sending payment link and qr also - we send qr to customer they make payment
  // - it has order id and i go to admin and can link the payment easily then instead of direct marking it as paid"
  // ───────────────────────────────────────────────────────────────────────────────────────────────────────
  section('payment link + QR for an order');
  const paylink = require('../paylink');
  process.env.SITE_URL = 'https://shop.fluxfilm.in';
  process.env.UPI_VPA = 'fluxfilm@upi'; process.env.UPI_PAYEE = 'FluxFilm';
  const link9 = paylink.linkFor('FF9');
  const tok9 = link9.split('t=')[1];
  ok('the link is the order id + a token, on our own domain', /^https:\/\/shop\.fluxfilm\.in\/pay\/FF9\?t=[0-9a-f]{16}$/.test(link9), link9);
  ok('the token is checked: right one yes, wrong one no, another order\'s no', paylink.tokenOk('FF9', tok9) && !paylink.tokenOk('FF9', '0'.repeat(16)) && !paylink.tokenOk('FF8', tok9));
  ok('the UPI link carries the ORDER ID as the note — that is what makes the payment match itself', paylink.upiLinkFor('FF9', 199) === 'upi://pay?pa=fluxfilm%40upi&pn=FluxFilm&am=199&cu=INR&tn=FF9');

  const pageOf = async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; };
  let pg = await pageOf('/pay/FF9?t=' + tok9);
  ok('the customer page: amount, plan, order id, the QR and a Pay button — and no personal details', pg.status === 200 && /₹199/.test(pg.html) && /Private 1M/.test(pg.html) && /FF9/.test(pg.html) && /api\.qrserver\.com/.test(pg.html) && /upi:\/\/pay\?pa=/.test(pg.html) && !/Rahul/.test(pg.html) && !/9876543210/.test(pg.html) && !/r@x\.com/.test(pg.html), pg.html.slice(0, 200));
  ok('  ...and it is never indexed', /noindex/.test(pg.html));
  pg = await pageOf('/pay/FF9?t=' + '0'.repeat(16));
  ok('a wrong token shows nothing at all (no amount, no QR)', pg.status === 404 && !/qrserver/.test(pg.html) && !/₹199/.test(pg.html));
  pg = await pageOf('/pay/FF7?t=' + paylink.token('FF7'));
  ok('an order that is already paid says so instead of asking for money again', pg.status === 200 && /Already paid/.test(pg.html) && !/qrserver/.test(pg.html));
  pg = await pageOf('/pay/FFZZZZ?t=' + paylink.token('FFZZZZ'));
  ok('an order that does not exist: a plain "not valid" page', pg.status === 404 && /not valid/.test(pg.html));
  const st = await fetch(base + '/pay/FF9/status?t=' + tok9).then((x) => x.json());
  const stPaid = await fetch(base + '/pay/FF7/status?t=' + paylink.token('FF7')).then((x) => x.json());
  const stBad = await fetch(base + '/pay/FF9/status?t=' + '0'.repeat(16));
  ok('the page can ask whether it is paid yet (and only with the token)', st.paid === false && stPaid.paid === true && stBad.status === 404, { st, stPaid });

  r = await get('/admin/api/quick/paylink?orderId=FF9');
  ok('admin can fetch the link, QR, UPI id and a ready WhatsApp message for an unpaid order', r.body.ok && r.body.pay.payLink === link9 && /qrserver/.test(r.body.pay.qr) && r.body.pay.note === 'FF9' && /wa\.me\/919876543210/.test(r.body.pay.waUrl) && /shop\.fluxfilm\.in\/pay\/FF9/.test(r.body.pay.whatsapp), r.body);
  r = await get('/admin/api/quick/paylink?orderId=FF7');
  ok('  ...but not for an order that is already paid', r.status === 409 && /only for an unpaid order/.test(r.body.message), r.body);
  ok('  ...and not without the admin key', (await fetch(base + '/admin/api/quick/paylink?orderId=FF9')).status === 403);

  mails.length = 0;
  r = await postq('/admin/api/quick/send-paylink', { orderId: 'FF9' });
  ok('✉️ emailing the link: to the order email, with the amount, the QR and the order number to keep', r.body.ok && mails.length === 1 && mails[0].to === 'r@x.com' && /₹199/.test(mails[0].subject) && /FF9/.test(mails[0].subject) && /qrserver/.test(mails[0].html) && /shop\.fluxfilm\.in\/pay\/FF9/.test(mails[0].html), { body: r.body, mail: mails[0] && mails[0].subject });
  r = await postq('/admin/api/quick/send-paylink', { orderId: 'FF8' });
  ok('  ...an order with no email says so instead of failing', r.status === 400 && /no email/.test(r.body.message) && mails.length === 1, r.body);
  ok('  ...and it is in the change log', calls.sql.some((c) => /INSERT INTO audit_log/.test(c.sql) && c.params && c.params[0] === 'order.payLinkSent'));

  const adminHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'admin.html'), 'utf8');
  ok('the panel offers it after creating an order, on every unpaid order and on the order card', /💳 Ask the customer to pay/.test(adminHtml) && /function qPayBox\(/.test(adminHtml) && /data-payi=/.test(adminHtml) && /id="od_paylink"/.test(adminHtml) && /function payLinkModal\(/.test(adminHtml) && /send-paylink/.test(adminHtml));
  ok('the WhatsApp message for an unpaid order carries the link instead of "send the screenshot"', /Please pay ₹' \+ r\.amount \+ ' here/.test(adminHtml) && /r\.pay\.payLink/.test(adminHtml));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  Module._load = origLoad;

  section('storefront checkout cannot set its own price');
  const inserts = [];
  Module._load = function (req) {
    if (req === './db') return { query: async (sql, params) => {
      if (/FROM plans WHERE service/.test(sql)) return [{ price: 229, duration_days: 30, is_active: 'TRUE', raw_json: JSON.stringify({ ExtraDevicePrice: 50 }) }];
      if (/^INSERT INTO orders/.test(sql.trim())) inserts.push(params);
      return [];
    } };
    if (req === './payments') return {};
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../order')];
  const order = require('../order');
  const base2 = { service: 'Prime Video', plan: '2 Devices 1M', name: 'A', email: 'a@b.c', phone: '9876543210' };
  let o = await order.createOrder(Object.assign({ discountOverride: 228, amountOverride: 1 }, base2));
  ok('discountOverride / amountOverride sent by a customer are ignored', o.ok && o.amount === 279, o);
  o = await order.createOrder(Object.assign({ action: 'RENEW', renewSubId: 'SUB-VICTIM' }, base2));
  const row = inserts[inserts.length - 1];
  ok('customer cannot turn a purchase into a renewal of someone else\'s subscription', row[15] === 'NEW' && row[16] === '', row.slice(14, 18));
  o = await order.createOrder(Object.assign({ deviceCount: 1 }, base2));
  ok('device count cannot go below what the plan name says', o.deviceCount === 2 && o.amount === 279, o);
  o = await order.createOrder(Object.assign({}, base2, { email: '' }));
  ok('storefront still requires email', o.ok === false && /Email/.test(o.message));
  o = await order.createOrder(Object.assign({}, base2, { email: '' }), { amountOverride: 150, allowNoEmail: true });
  ok('server-side admin option: agreed amount, no email', o.ok && o.amount === 150 && o.discount === 129, o);
  o = await order.createOrder(base2, { amountOverride: 400 });
  ok('agreed amount above list price is charged as agreed', o.ok && o.amount === 400 && o.discount === 0, o);
  Module._load = origLoad;

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
