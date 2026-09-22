/**
 * FluxFilm - 💳 admin credit renewals, receivables and ✉️/💬 renewal reminders (owner request 16 Sep 2026).
 *
 * Credit renewal (admin only — the storefront can never create one):
 *   Quick order → Renew → Payment "On credit" (quickorders.js) creates the renew order with amountOverride and
 *   raw_json { Credit: true, CreditAmount, CreditDueDate, CreditCreatedAt, CreditStatus: 'OPEN' }, then startCredit()
 *   turns it from CREATED into status 'CREDIT' and fulfils it (fulfill.js allowCredit): the plan renews now.
 *   status CREDIT is not PAID, so every revenue / profit / "total spent" figure (they all count PAID) leaves it out,
 *   and fulfil skips the coins for it (skipCoins).
 *
 * Receivables = orders with status CREDIT. Mark paid (settle):
 *   amount == still due          → PAID (verified_at now, final_amount = everything received) + coins / referral rules
 *   amount <  due, mode PARTIAL   → stays CREDIT, the payment is added to raw_json CreditPayments
 *   amount != due, mode FULL      → PAID for what was received, with a note (e.g. a small discount)
 *   amount != due, no mode        → nothing written; "₹X received but ₹Y due" and the owner picks
 *   Every payment carries a key from the dialog: the same tap twice records it once. The UPDATE also checks txn_ref
 *   (changed on every payment), so two devices can't both record against the same balance.
 * Cancel credit: the renewal stays. Nothing paid → status WRITTEN_OFF; partly paid → PAID for the part received.
 *
 * Reminders: preview + send a friendly renewal email (support@ via mailer.send), at most once per 12 hours per
 * subscription (reminder_log kind ADMIN_REMINDER, schema-v14), and a prefilled WhatsApp text. Nothing is sent
 * automatically.
 *
 * SQL: one table per statement, matched in JS (live lesson: mixed collations across tables).
 *
 * Routes (admin-only, mounted by admin.js):
 *   GET  /admin/api/credit/receivables
 *   GET  /admin/api/credit/order?id=
 *   GET  /admin/api/credit/customer?phone=
 *   POST /admin/api/credit/mark-paid      { orderId, amount, method, ref, mode, note, key }
 *   POST /admin/api/credit/cancel         { orderId, note }
 *   GET  /admin/api/credit/remind-preview?sub_id=
 *   POST /admin/api/credit/remind-email   { subId }
 */
const renewRules = require('./renewrules');
const watext = require('./watext');
// 💳 A credit renewal is always "paid via credit" — the detail turns from DUE into PAID when the owner records it.
const paidvia = require('./paidvia');

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

const DAY_MS = 86400000;
const PAY_METHODS = ['UPI', 'CASH', 'BANK', 'OTHER'];
const DEFAULT_DUE_DAYS = 3;
const REMIND_EVERY_HOURS = 12;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SITE = () => (process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');

const nowMs = (now) => (now == null ? Date.now() : now instanceof Date ? now.getTime() : Number(now));
const todayYmd = (now) => renewRules.istYmd(nowMs(now));
function addDaysYmd(ymd, n) { return new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
/** '2026-09-19' → '19 Sep 2026' (dates are India dates). */
function ymdText(ymd) { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; }
function defaultDueDate(now) { return addDaysYmd(todayYmd(now), DEFAULT_DUE_DAYS); }
/** A due date typed by the owner: YYYY-MM-DD (real date) → itself; empty → default; anything else → null. */
function parseDueDate(v, now) {
  const t = s(v);
  if (!t) return defaultDueDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const ms = Date.parse(t + 'T00:00:00Z');
  return isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== t ? null : t;
}
const rupees = (n) => Math.round(num(n) * 100) / 100;
const money = (n) => '₹' + rupees(n).toLocaleString('en-IN');

/** Everything about the credit on one order row (orders.* incl. raw_json). */
function creditState(o, now) {
  const raw = rawOf(o && o.raw_json);
  const status = s(o && o.status).toUpperCase();
  const amount = rupees(raw.CreditAmount != null && raw.CreditAmount !== '' ? raw.CreditAmount : o && o.final_amount);
  const payments = Array.isArray(raw.CreditPayments) ? raw.CreditPayments : [];
  const paid = rupees(payments.reduce((a, p) => a + num(p && p.amount), 0));
  const due = Math.max(0, rupees(amount - paid));
  const dueDate = parseDueDate(raw.CreditDueDate, now) && s(raw.CreditDueDate) ? s(raw.CreditDueDate) : '';
  const createdYmd = renewRules.expiryYmd(raw.CreditCreatedAt || (o && o.created_at_sheet)) || todayYmd(now);
  const today = todayYmd(now);
  const daysSince = Math.max(0, Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(createdYmd + 'T00:00:00Z')) / DAY_MS));
  const overdueDays = dueDate ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(dueDate + 'T00:00:00Z')) / DAY_MS) : 0;
  return {
    isCredit: raw.Credit === true, open: status === 'CREDIT', status, creditStatus: s(raw.CreditStatus) || (status === 'CREDIT' ? 'OPEN' : ''),
    amount, paid, due, payments, dueDate, dueDateText: ymdText(dueDate), createdYmd, daysSince,
    overdue: status === 'CREDIT' && overdueDays > 0, overdueDays: Math.max(0, overdueDays),
  };
}

// ---------------- reminder text ----------------
function renewLink(subId) { return SITE() + '/?source=push&renew=' + encodeURIComponent(s(subId)); }
function firstName(name) { return watext.firstName(name); }

/**
 * The reminder, on WhatsApp: expired / expires today / expires soon / renewed but money still due.
 * p = { name, service, plan, expiry, subId, due, dueDate, now }
 *
 * Short lines with a blank line between them, the numbers and dates in *bold*, one emoji per line — a reminder
 * is read on a phone in two seconds, and the old one-sentence version buried the date and the amount in prose
 * (owner, 23 Sep 2026). **admin.html crWaText() must say exactly the same thing** — test/message-style.test.js
 * runs both and compares them, so changing one alone fails the build.
 */
function whatsappText(p) {
  const name = watext.firstName(p.name);
  const hi = 'Hi' + (name ? ' ' + name : '') + ',';
  const exYmd = renewRules.expiryYmd(p.expiry);
  const dl = renewRules.daysLeftIst(p.expiry, p.now);
  // The plan name is typed by the owner in admin: strip any * of its own or it breaks the bold around it.
  const what = 'your FluxFilm *' + watext.clean(p.service) + '*' + (watext.clean(p.plan) ? ' (' + watext.clean(p.plan) + ')' : '');
  if (num(p.due) > 0) {
    return watext.join([hi, '',
      '✅ ' + what.replace('your', 'Your') + ' is renewed' + (exYmd && dl != null && dl >= 0 ? ' — valid till *' + ymdText(exYmd) + '*' : '') + '.', '',
      '💳 *₹' + rupees(p.due) + '* is due' + (p.dueDate ? ' by *' + ymdText(p.dueDate) + '*' : '') + '.',
      'Please pay by UPI and send the screenshot here.', '',
      'Thank you! 🙏']);
  }
  if (dl == null) {
    return watext.join([hi, '', '🔄 ' + what.replace('your', 'Your') + ' is due for renewal.', '',
      '👉 Renew in a minute:', renewLink(p.subId), '', 'Thanks for being with FluxFilm 💚']);
  }
  const when = dl < 0 ? '⏰ ' + what.replace('your', 'Your') + ' *expired* on *' + ymdText(exYmd) + '*.'
    : dl === 0 ? '⏳ ' + what.replace('your', 'Your') + ' *expires today*.'
      : '⏳ ' + what.replace('your', 'Your') + ' expires on *' + ymdText(exYmd) + '* — *' + dl + ' day' + (dl === 1 ? '' : 's') + '* left.';
  return watext.join([hi, '', when, '', '👉 Renew in a minute:', renewLink(p.subId), '',
    dl < 0 ? 'Pick up right where you left off 💚' : 'Renew early and keep watching without a break 💚']);
}
function waUrl(phone, text) { let d = String(phone || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text); }

/** The friendly reminder email (preview = exactly what is sent). */
function reminderEmail(p) {
  const exYmd = renewRules.expiryYmd(p.expiry);
  const dl = renewRules.daysLeftIst(p.expiry, p.now);
  const credit = num(p.due) > 0;
  const ended = dl != null && dl < 0;
  const when = dl == null ? '' : ended ? 'Expired on ' + ymdText(exYmd) : dl === 0 ? 'Expires today (' + ymdText(exYmd) + ')' : 'Expires on ' + ymdText(exYmd) + ' — ' + dl + ' day' + (dl === 1 ? '' : 's') + ' left';
  const subject = credit ? '💳 FluxFilm ' + s(p.service) + ': ₹' + rupees(p.due) + ' payment due'
    : ended ? '⏰ Your FluxFilm ' + s(p.service) + ' has expired — renew in a minute' : '⏳ Your FluxFilm ' + s(p.service) + ' is ending soon';
  const link = renewLink(p.subId);
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' +
    '<h2 style="color:' + (credit ? '#1d4ed8' : ended ? '#dc2626' : '#b45309') + ';margin-bottom:4px">' + (credit ? '💳 A friendly payment reminder' : ended ? '⏰ Your plan has expired' : '⏳ Your plan is ending soon') + '</h2>' +
    '<p style="color:#475569;margin-top:0">Hi ' + esc(firstName(p.name) || 'there') + ',</p>' +
    '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px">' +
    '<b>' + esc(p.service) + '</b>' + (s(p.plan) ? ' — ' + esc(p.plan) : '') + (when ? '<br>' + (credit && !ended ? 'Renewed — valid till <b>' + esc(ymdText(exYmd)) + '</b>' : esc(when)) : '') +
    (credit ? '<br><b style="color:#1d4ed8">Amount due: ₹' + esc(rupees(p.due)) + '</b>' + (p.dueDate ? ' (by <b>' + esc(ymdText(p.dueDate)) + '</b>)' : '') : '') + '</div>' +
    (credit
      ? '<p style="color:#475569;font-size:14px">We renewed your plan so you could keep watching. Please pay ₹' + esc(rupees(p.due)) + ' by UPI and reply with the screenshot (or send it on WhatsApp). Thank you for being with FluxFilm! 💚</p>'
      : '<p style="color:#475569;font-size:14px">' + (ended ? 'Renew now to get back to watching.' : 'Renew early and keep watching without a break.') + ' It takes a minute:</p>' +
        '<p><a href="' + esc(link) + '" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Renew now</a></p>' +
        '<p style="color:#94a3b8;font-size:12px">Or open ' + esc(link) + '</p>') +
    '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';
  return { subject, html, link };
}

// ---------------- settle (pure) ----------------
/**
 * What a "Mark paid" does to an order. Pure — returns the new row values, writes nothing.
 * → { action: 'PAID' | 'PARTIAL' | 'MISMATCH' | 'ALREADY' | 'REFUSED', status, finalAmount, raw, txnRef, message }
 */
function settle(o, b, now) {
  const st = creditState(o, now);
  const raw = Object.assign({}, rawOf(o.raw_json));
  const key = s(b.key).slice(0, 60);
  if (key && st.payments.some((p) => p && p.key === key)) return { action: 'ALREADY', message: 'Already recorded.' };
  if (!st.open) return st.status === 'PAID' && st.isCredit ? { action: 'ALREADY', message: 'This credit is already paid.' } : { action: 'REFUSED', message: 'This order is not an open credit.' };
  const amount = rupees(b.amount);
  if (!(amount > 0)) return { action: 'REFUSED', message: 'Enter the amount received.' };
  const method = PAY_METHODS.includes(s(b.method).toUpperCase()) ? s(b.method).toUpperCase() : 'UPI';
  const mode = s(b.mode).toUpperCase();
  const note = s(b.note).slice(0, 300);
  const exact = Math.abs(amount - st.due) < 0.005;
  if (!exact && mode !== 'FULL' && !(mode === 'PARTIAL' && amount < st.due)) {
    return { action: 'MISMATCH', received: amount, due: st.due, canPartial: amount < st.due, message: money(amount) + ' received but ' + money(st.due) + ' due.' };
  }
  const at = new Date(nowMs(now)).toISOString();
  const payment = { at, amount, method, ref: s(b.ref).slice(0, 80), key, note };
  const payments = st.payments.concat([payment]);
  const received = rupees(st.paid + amount);
  raw.CreditPayments = payments;
  raw.CreditPaid = received;
  if (exact || mode === 'FULL') {
    raw.CreditStatus = 'PAID';
    raw.CreditPaidAt = at;
    if (!exact) raw.CreditSettledNote = note || (amount < st.due ? 'Accepted ' + money(amount) + ' as full payment (' + money(st.due) + ' was due)' : 'Received ' + money(amount) + ' (' + money(st.due) + ' was due)');
    raw.Status = 'PAID'; raw.FinalAmount = received; raw.PaymentMethod = method;
    const txnRef = ('ADMIN-CREDIT-' + method + (payment.ref ? ':' + payment.ref : '')).slice(0, 120);
    raw.TxnRef = txnRef;
    paidvia.stamp(raw, paidvia.VIA.CREDIT, 'PAID', at);
    return { action: 'PAID', status: 'PAID', finalAmount: received, raw, txnRef, received, message: exact ? '✅ Paid in full (' + money(received) + ').' : '✅ Marked paid — ' + money(received) + ' received (' + money(st.amount) + ' was due).' };
  }
  raw.CreditStatus = 'PARTIAL';
  paidvia.stamp(raw, paidvia.VIA.CREDIT, 'DUE', at);
  const left = rupees(st.due - amount);
  return { action: 'PARTIAL', status: 'CREDIT', finalAmount: num(o.final_amount), raw, txnRef: ('CREDIT-P' + payments.length + (payment.ref ? ':' + payment.ref : '')).slice(0, 120), received, left, message: '🧾 ' + money(amount) + ' recorded — ' + money(left) + ' still due.' };
}

/** Cancel (write off) what is still due. Pure. */
function writeOff(o, note, now) {
  const st = creditState(o, now);
  if (!st.open) return st.status === 'WRITTEN_OFF' || (st.isCredit && /WRITTEN_OFF/.test(st.creditStatus)) ? { action: 'ALREADY', message: 'Already cancelled.' } : { action: 'REFUSED', message: 'This order is not an open credit.' };
  const raw = Object.assign({}, rawOf(o.raw_json));
  const at = new Date(nowMs(now)).toISOString();
  raw.CreditWrittenOff = st.due; raw.CreditWrittenOffAt = at; raw.CreditWriteOffNote = s(note).slice(0, 300);
  if (st.paid > 0) {
    raw.CreditStatus = 'WRITTEN_OFF_PART'; raw.Status = 'PAID'; raw.FinalAmount = st.paid;
    return { action: 'PAID', status: 'PAID', finalAmount: st.paid, raw, txnRef: 'ADMIN-CREDIT-WRITEOFF', received: st.paid, message: 'Credit closed — ' + money(st.paid) + ' received, ' + money(st.due) + ' written off.' };
  }
  raw.CreditStatus = 'WRITTEN_OFF'; raw.Status = 'WRITTEN_OFF';
  return { action: 'WRITTEN_OFF', status: 'WRITTEN_OFF', finalAmount: num(o.final_amount), raw, txnRef: 'ADMIN-CREDIT-WRITEOFF', received: 0, message: 'Credit cancelled — ' + money(st.due) + ' written off. The renewal stays.' };
}

// ---------------- receivables ----------------
const ORDER_COLS = 'order_id, created_at_sheet, name, phone_norm, email, service, plan, final_amount, status, order_type, renew_sub_id, txn_ref, raw_json';
function receivableRow(o, now) {
  const st = creditState(o, now);
  const subId = s(o.renew_sub_id);
  const text = whatsappText({ name: o.name, service: o.service, plan: o.plan, subId, due: st.due, dueDate: st.dueDate, now });
  return {
    orderId: s(o.order_id), name: s(o.name), phone: s(o.phone_norm), email: s(o.email), service: s(o.service), plan: s(o.plan), subId,
    amount: st.amount, paid: st.paid, due: st.due, dueDate: st.dueDate, dueDateText: st.dueDateText, daysSince: st.daysSince,
    overdue: st.overdue, overdueDays: st.overdueDays, whatsapp: text, waUrl: waUrl(o.phone_norm, text),
  };
}
function summarizeReceivables(rows, now) {
  const list = (rows || []).filter((o) => s(o.status).toUpperCase() === 'CREDIT').map((o) => receivableRow(o, now))
    .sort((a, b) => (b.overdue - a.overdue) || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  const total = rupees(list.reduce((a, x) => a + x.due, 0));
  return { total, count: list.length, customers: new Set(list.map((x) => x.phone)).size, overdue: list.filter((x) => x.overdue).length, list };
}
async function receivables(query, now) {
  const rows = await query("SELECT " + ORDER_COLS + " FROM orders WHERE UPPER(status) = 'CREDIT' ORDER BY created_at_sheet LIMIT 500", []);
  return summarizeReceivables(rows, now);
}
/** The Today card. */
function todayCard(r) {
  const ok = r && Array.isArray(r.list);
  const count = ok ? r.customers : 0;
  return {
    key: 'receivables', icon: '💳', title: ok && r.count ? 'Receivables — ' + money(r.total) + ' from ' + r.customers + ' customer' + (r.customers === 1 ? '' : 's') : 'Receivables (credit renewals)',
    count, tone: ok && r.overdue ? 'bad' : 'warn', total: ok ? r.total : 0, overdue: ok ? r.overdue : 0,
    sub: ok ? (r.overdue ? r.overdue + ' overdue' : '') : 'could not load', go: { view: 'receivables' },
    receivables: ok ? r.list.slice(0, 8) : [],
  };
}

// Newly paid (or partly written off): the normal paid-order rules — coins for the order, coin spends, referral reward.
async function afterPaid(deps, o, amount) {
  const coins = deps.coins || require('./coins');
  const referrals = deps.referrals || require('./referrals');
  const event = s(o.order_type).toUpperCase() === 'RENEW' ? 'RENEW' : 'NEW_PURCHASE';
  const out = {};
  try { out.coins = await coins.awardCoins({ event, orderId: o.order_id, phone: o.phone_norm, service: o.service, plan: o.plan, amount }); } catch (e) { out.coinsError = e.message; console.log('[credit] coins failed for', o.order_id, e.message); }
  try { if (typeof coins.onOrderPaid === 'function') await coins.onOrderPaid(o.order_id); } catch (e) { console.log('[credit] coin spends settle failed for', o.order_id, e.message); }
  try { if (typeof referrals.onOrderPaid === 'function') await referrals.onOrderPaid(o.order_id); } catch (e) { console.log('[credit] referral failed for', o.order_id, e.message); }
  return out;
}

/** CREATED renew order (just made by quickorders.js with raw Credit) → CREDIT, then deliver it. */
async function startCredit(deps, orderId) {
  const upd = await deps.db.query("UPDATE orders SET status = 'CREDIT' WHERE order_id = ? AND UPPER(status) = 'CREATED' LIMIT 1", [orderId]);
  if (!upd || upd.affectedRows !== 1) return { ok: false, message: 'The order could not be put on credit (it changed meanwhile).' };
  const fulfill = deps.fulfill || require('./fulfill');
  const f = await fulfill.fulfillForAdmin(orderId, { allowCredit: true });
  return { ok: true, fulfillment: f };
}

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const now = () => (deps.now ? deps.now() : new Date());
  const q = (sql, p) => db.query(sql, p || []);
  const mailer = () => deps.mailer || require('./mailer');
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const orderRow = async (id) => (await q('SELECT ' + ORDER_COLS + ' FROM orders WHERE order_id = ? LIMIT 1', [id]))[0] || null;

  app.get('/admin/api/credit/receivables', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(Object.assign({ ok: true }, await receivables(q, now()))); } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/credit/order', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const o = await orderRow(s(req.query.id));
      if (!o) return res.status(404).json({ ok: false, message: 'Order not found.' });
      const st = creditState(o, now());
      res.json({ ok: true, orderId: o.order_id, credit: st.isCredit ? Object.assign(receivableRow(o, now()), { status: st.status, creditStatus: st.creditStatus, payments: st.payments, open: st.open }) : null });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/credit/customer', async (req, res) => {
    if (!auth(req, res)) return;
    const ph = norm(req.query.phone);
    if (!ph) return res.status(400).json({ ok: false, message: 'phone required' });
    try {
      const [orders, subs] = await Promise.all([
        q("SELECT " + ORDER_COLS + " FROM orders WHERE phone_norm = ? AND UPPER(status) = 'CREDIT' LIMIT 50", [ph]),
        q('SELECT sub_id, order_id FROM subscriptions WHERE phone_norm = ? LIMIT 200', [ph]),
      ]);
      const credits = orders.map((o) => receivableRow(o, now()));
      // A credit belongs to the subscription it renewed (renew_sub_id), or to rows now pointing at that order (split logins).
      const bySub = {};
      for (const c of credits) { if (c.subId) bySub[c.subId] = c; }
      for (const x of subs) { const c = credits.find((k) => k.orderId === s(x.order_id)); if (c && !bySub[x.sub_id]) bySub[x.sub_id] = c; }
      const ids = subs.map((x) => s(x.sub_id)).filter(Boolean);
      const lastReminded = {};
      if (ids.length) {
        try {
          const rows = await q("SELECT sub_id, MAX(ts) AS last FROM reminder_log WHERE kind = 'ADMIN_REMINDER' AND ok = 1 AND sub_id IN (" + ids.map(() => '?').join(',') + ') GROUP BY sub_id', ids);
          for (const r of rows) lastReminded[s(r.sub_id)] = r.last;
        } catch (e) { if (!missingTable(e)) throw e; }
      }
      res.json({ ok: true, credits, bySub, lastReminded });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/credit/mark-paid', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = s(b.orderId);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const o = await orderRow(id);
      if (!o) return res.status(404).json({ ok: false, message: 'Order not found.' });
      const r = settle(o, b, now());
      if (r.action === 'ALREADY') return res.json({ ok: true, already: true, message: r.message });
      if (r.action === 'REFUSED') return res.status(400).json({ ok: false, message: r.message });
      if (r.action === 'MISMATCH') return res.status(409).json({ ok: false, mismatch: true, received: r.received, due: r.due, canPartial: r.canPartial, message: r.message });
      const upd = await q(
        'UPDATE orders SET status = ?, txn_ref = ?, final_amount = ?, raw_json = ?' + (r.action === 'PAID' ? ', verified_at = NOW()' : '') +
        " WHERE order_id = ? AND UPPER(status) = 'CREDIT' AND COALESCE(txn_ref, '') = ? LIMIT 1",
        [r.status, r.txnRef, r.finalAmount, JSON.stringify(r.raw), id, s(o.txn_ref)]);
      if (!upd || upd.affectedRows !== 1) return res.status(409).json({ ok: false, changed: true, message: 'This credit changed meanwhile — reopen it and try again.' });
      let extra = {};
      if (r.action === 'PAID') extra = await afterPaid(deps, o, r.finalAmount);
      // ✅ "Credit paid ₹X" on the owner's phones (ownernotify.js) — fire and forget, once per order.
      if (r.action === 'PAID') { try { (deps.ownernotify || require('./ownernotify')).creditPaidLater(id, r.received); } catch (e) { console.log('[owner-alert] not loaded:', e.message); } try { require('./n8nhooks').kick(); } catch (_) {} }
      audit.record(req, { action: r.action === 'PAID' ? 'credit.paid' : 'credit.partial', entity: 'order', id, summary: r.message.replace(/^\W+\s*/, '') + ' · ' + s(o.service) + ' · ' + s(o.phone_norm), details: { amount: rupees(b.amount), method: s(b.method), ref: s(b.ref), mode: s(b.mode), note: s(b.note) } });
      res.json({ ok: true, orderId: id, status: r.status, received: r.received, left: r.left || 0, message: r.message, coins: extra.coins || null });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/credit/cancel', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = s(b.orderId);
    if (!id) return res.status(400).json({ ok: false, message: 'Order id required.' });
    try {
      const o = await orderRow(id);
      if (!o) return res.status(404).json({ ok: false, message: 'Order not found.' });
      const r = writeOff(o, b.note, now());
      if (r.action === 'ALREADY') return res.json({ ok: true, already: true, message: r.message });
      if (r.action === 'REFUSED') return res.status(400).json({ ok: false, message: r.message });
      const upd = await q(
        'UPDATE orders SET status = ?, txn_ref = ?, final_amount = ?, raw_json = ?' + (r.action === 'PAID' ? ', verified_at = NOW()' : '') +
        " WHERE order_id = ? AND UPPER(status) = 'CREDIT' AND COALESCE(txn_ref, '') = ? LIMIT 1",
        [r.status, r.txnRef, r.finalAmount, JSON.stringify(r.raw), id, s(o.txn_ref)]);
      if (!upd || upd.affectedRows !== 1) return res.status(409).json({ ok: false, changed: true, message: 'This credit changed meanwhile — reopen it and try again.' });
      if (r.action === 'PAID') await afterPaid(deps, o, r.finalAmount);
      audit.record(req, { action: 'credit.cancel', entity: 'order', id, summary: r.message + (s(b.note) ? ' Note: ' + s(b.note).slice(0, 200) : ''), details: { writtenOff: r.raw.CreditWrittenOff } });
      res.json({ ok: true, orderId: id, status: r.status, message: r.message });
    } catch (e) { fail(res, e); }
  });

  // ---- ✉️ / 💬 reminders ----
  async function reminderFor(subId) {
    const sub = (await q('SELECT sub_id, order_id, phone_norm, email, service, plan, expiry_date, status FROM subscriptions WHERE sub_id = ? LIMIT 1', [subId]))[0];
    if (!sub) return null;
    const [cust, credits] = await Promise.all([
      q('SELECT name, email FROM customers WHERE phone_norm = ? LIMIT 1', [sub.phone_norm]),
      q("SELECT " + ORDER_COLS + " FROM orders WHERE phone_norm = ? AND UPPER(status) = 'CREDIT' LIMIT 50", [sub.phone_norm]),
    ]);
    const c = cust[0] || {};
    const co = credits.find((o) => s(o.renew_sub_id) === s(sub.sub_id)) || credits.find((o) => s(o.order_id) === s(sub.order_id)) || null;
    const st = co ? creditState(co, now()) : null;
    let last = null; let recent = 0;
    try {
      const r = (await q("SELECT MAX(ts) AS last, SUM(ts > NOW() - INTERVAL " + REMIND_EVERY_HOURS + " HOUR) AS recent FROM reminder_log WHERE sub_id = ? AND kind = 'ADMIN_REMINDER' AND ok = 1", [sub.sub_id]))[0] || {};
      last = r.last || null; recent = Number(r.recent) || 0;
    } catch (e) { if (!missingTable(e)) throw e; }
    const p = { name: s(c.name), service: sub.service, plan: sub.plan, expiry: sub.expiry_date, subId: sub.sub_id, due: st ? st.due : 0, dueDate: st ? st.dueDate : '', now: now() };
    const mail = reminderEmail(p);
    const text = whatsappText(p);
    return { sub, to: s(c.email) || s(sub.email), name: p.name, mail, text, waUrl: waUrl(sub.phone_norm, text), credit: co ? receivableRow(co, now()) : null, lastSentAt: last, rateLimited: recent > 0, daysLeft: renewRules.daysLeftIst(sub.expiry_date, now()) };
  }

  app.get('/admin/api/credit/remind-preview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await reminderFor(s(req.query.sub_id));
      if (!r) return res.status(404).json({ ok: false, message: 'Subscription not found.' });
      res.json({ ok: true, subId: r.sub.sub_id, to: r.to, name: r.name, subject: r.mail.subject, html: r.mail.html, link: r.mail.link, whatsapp: r.text, waUrl: r.waUrl, credit: r.credit, daysLeft: r.daysLeft, lastSentAt: r.lastSentAt, rateLimited: r.rateLimited, everyHours: REMIND_EVERY_HOURS });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/credit/remind-email', async (req, res) => {
    if (!auth(req, res)) return;
    const subId = s((req.body || {}).subId);
    if (!subId) return res.status(400).json({ ok: false, message: 'Subscription id required.' });
    try {
      const r = await reminderFor(subId);
      if (!r) return res.status(404).json({ ok: false, message: 'Subscription not found.' });
      if (!r.to || r.to.indexOf('@') < 0) return res.status(400).json({ ok: false, message: 'No email address on this customer.' });
      if (r.rateLimited) return res.status(429).json({ ok: false, rateLimited: true, lastSentAt: r.lastSentAt, message: 'A reminder was already emailed at ' + s(r.lastSentAt).slice(0, 16) + ' — at most one every ' + REMIND_EVERY_HOURS + ' hours.' });
      let sent;
      try { sent = await mailer().send(r.to, r.mail.subject, r.mail.html); } catch (e) { sent = { ok: false, error: e.message }; }
      const good = !!(sent && sent.ok);
      try { await q('INSERT INTO reminder_log (ts, sub_id, channel, kind, expiry_date, ok, note) VALUES (NOW(), ?, ?, ?, ?, ?, ?)', [r.sub.sub_id, 'EMAIL', 'ADMIN_REMINDER', r.sub.expiry_date || null, good ? 1 : 0, (good ? (r.credit ? 'credit due ₹' + r.credit.due : 'renewal') : s(sent && (sent.error || sent.skipped))).slice(0, 300) || null]); } catch (e) { console.log('[credit] reminder_log write failed:', e.message); }
      audit.record(req, { action: good ? 'remind.email' : 'remind.emailFailed', entity: 'subscription', id: r.sub.sub_id, summary: (good ? 'Reminder emailed to ' : 'Reminder email NOT sent to ') + r.to + ' · ' + s(r.sub.service) + (r.credit ? ' · ₹' + r.credit.due + ' due' : '') + (good ? '' : ' (' + s(sent && (sent.error || sent.skipped)) + ')') });
      if (!good) return res.status(502).json({ ok: false, message: 'Email not sent: ' + (s(sent && (sent.error || sent.skipped)) || 'unknown error') });
      res.json({ ok: true, to: r.to, sender: sent.sender || '', message: '✉️ Reminder sent to ' + r.to });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  mount, creditState, settle, writeOff, receivables, summarizeReceivables, todayCard, startCredit, afterPaid,
  whatsappText, waUrl, reminderEmail, renewLink, defaultDueDate, parseDueDate, ymdText, PAY_METHODS, REMIND_EVERY_HOURS,
};
