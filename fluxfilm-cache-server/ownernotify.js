/**
 * FluxFilm - 🔔 owner alerts: "💸 New order ₹299" the moment an order becomes PAID, "✅ Credit paid ₹X", and the settings
 * for them + the 📊 business summaries (reports.js). Owner request 16 Sep 2026 ("I want my phone to ring").
 *
 * Where it is called (fire and forget — an alert can never slow down or break a payment):
 *   order.js _markPaid (becamePaid)  → verifyPayment · verifyPaymentByRef (bank email / typed UTR) · adminMarkPaid
 *                                     (admin Mark paid, ⚡ Quick order paid now, paymatch.js backup UPI claims + learned names)
 *   order.js confirmFreeOrder         → ₹0 checkout (refund credit / coins / coupon)
 *   credit.js mark-paid (→ PAID)      → creditPaid ("✅ Credit paid ₹X"). Creating a CREDIT renewal never alerts.
 *
 * Never twice: the order row gets raw_json AdminNotifiedAt (credit: AdminCreditPaidNotifiedAt) with one conditional
 * UPDATE — only the caller whose UPDATE changed the row sends. If that UPDATE fails (odd legacy raw_json) an in-memory
 * set still stops a repeat in this process.
 *
 * Settings (app_settings 'owner_alerts', admin → 🔔 Notifications):
 *   orderPush (ON) · creditPush (ON) · orderEmail (OFF)
 *   dailyOn / dailyTime '23:30' · weeklyOn / weeklyTime '23:45' (Sunday) · monthlyOn / monthlyTime '23:50' (last day)
 *   summaryPush (ON) · summaryEmail (ON) · emails [] (empty = the shop's support@ sender / reply-to address)
 */
const db = require('./db');

const KEY = 'owner_alerts';
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inr = (n) => '₹' + (Math.round(num(n) * 100) / 100).toLocaleString('en-IN');

const DEFAULTS = Object.freeze({
  orderPush: true, creditPush: true, orderEmail: false,
  dailyOn: true, dailyTime: '23:30',
  weeklyOn: true, weeklyTime: '23:45',
  monthlyOn: true, monthlyTime: '23:50',
  summaryPush: true, summaryEmail: true,
  emails: [],
});
const BOOLS = ['orderPush', 'creditPush', 'orderEmail', 'dailyOn', 'weeklyOn', 'monthlyOn', 'summaryPush', 'summaryEmail'];
const TIMES = ['dailyTime', 'weeklyTime', 'monthlyTime'];
const MAX_EMAILS = 5;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;

const truthy = (v) => !(v === false || v === 0 || /^(false|0|off|no)$/i.test(s(v)));
function validTime(v) {
  const m = s(v).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return String(+m[1]).padStart(2, '0') + ':' + m[2];
}
/** "a@x.com, b@y.in" or an array → { ok, emails, bad } (lower-case, no duplicates, at most 5). */
function parseEmails(v) {
  const list = (Array.isArray(v) ? v : s(v).split(/[,;\s]+/)).map((x) => s(x).toLowerCase()).filter(Boolean);
  const bad = list.filter((x) => !EMAIL_RE.test(x) || x.length > 254);
  const emails = [...new Set(list.filter((x) => !bad.includes(x)))];
  return { ok: !bad.length && emails.length <= MAX_EMAILS, emails: emails.slice(0, MAX_EMAILS), bad, tooMany: emails.length > MAX_EMAILS };
}

function validate(input, prev) {
  const inb = input || {}; const errors = [];
  const out = Object.assign({}, DEFAULTS, prev || {});
  for (const k of BOOLS) if (inb[k] !== undefined) out[k] = truthy(inb[k]);
  const labels = { dailyTime: 'Daily summary time', weeklyTime: 'Weekly summary time', monthlyTime: 'Monthly summary time' };
  for (const k of TIMES) {
    if (inb[k] !== undefined) { const t = validTime(inb[k]); if (t) out[k] = t; else errors.push(labels[k] + ' must look like 23:30.'); }
    if (!validTime(out[k])) out[k] = DEFAULTS[k];
  }
  if (inb.emails !== undefined) {
    const e = parseEmails(inb.emails);
    if (e.bad.length) errors.push('Not an email address: ' + e.bad.slice(0, 3).join(', ') + '.');
    else if (e.tooMany) errors.push('At most ' + MAX_EMAILS + ' email addresses.');
    else out.emails = e.emails;
  }
  if (!Array.isArray(out.emails)) out.emails = [];
  out.emails = parseEmails(out.emails).emails;
  return { ok: !errors.length, settings: out, errors };
}

let cache = null; let cacheAt = 0;
async function getSettings(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 15e3) return cache;
  let saved = {};
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]);
    if (rows && rows.length) saved = rawOf(rows[0].value);
  } catch (e) { if (!missingTable(e)) throw e; }
  cache = validate(saved).settings; cacheAt = Date.now();
  return cache;
}
async function saveSettings(input) {
  const before = await getSettings(true);
  const v = validate(input, before);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(v.settings)]);
  cache = null;
  const changed = Object.keys(DEFAULTS).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(v.settings[k]));
  return { ok: true, settings: v.settings, before, changed };
}

/** Where owner email goes: the emails in settings, else the shop's reply-to / sender address (support@). */
function recipients(settings) {
  const list = settings && Array.isArray(settings.emails) ? settings.emails : [];
  if (list.length) return list.slice();
  try {
    const st = require('./smtp').status();
    const d = s(st.replyTo) || s(st.sender);
    return d ? [d.toLowerCase()] : [];
  } catch (_) { return []; }
}

// ---------------------------------------------------------------- message text (pure)
/** "Rahul Kumar" → "Rahul K." · "rahul" → "Rahul" · "" → "" */
function shortName(name) {
  const parts = s(name).replace(/[<>"]/g, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const first = cap(parts[0]).slice(0, 20);
  return parts.length > 1 ? first + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.' : first;
}
/** How it was paid, from txn_ref (+ raw_json for ₹0 checkouts). */
function payMethod(o) {
  const t = up(o && o.txn_ref);
  const raw = rawOf(o && o.raw_json);
  let m;
  if ((m = t.match(/^ADMIN-CREDIT-(UPI|CASH|BANK|OTHER|WRITEOFF)/))) return m[1] === 'WRITEOFF' ? 'Credit closed' : ({ UPI: 'UPI', CASH: 'Cash', BANK: 'Bank', OTHER: 'Other' })[m[1]];
  if ((m = t.match(/^ADMIN-(UPI|CASH|BANK|OTHER)\b/))) return ({ UPI: 'UPI (marked by admin)', CASH: 'Cash', BANK: 'Bank transfer', OTHER: 'Other' })[m[1]];
  if (/^CREDIT-FF/.test(t) || raw.FreeCheckout === true) {
    const pm = up(raw.PaymentMethod);
    const bits = [/CREDIT/.test(pm) ? 'refund credit' : '', /COINS/.test(pm) ? 'coins' : '', /COUPON/.test(pm) ? 'coupon' : ''].filter(Boolean);
    return '₹0 checkout' + (bits.length ? ' (' + bits.join(' + ') + ')' : '');
  }
  if (/^MANUAL-REVIEW-/.test(t)) return 'UPI (checked by admin)';
  return 'UPI';
}
const isRenew = (o) => up(o && o.order_type) === 'RENEW';
function orderLink(orderId) { return '/panel?v=orders&order=' + encodeURIComponent(s(orderId)); }

/** The 💸 push for a paid order row (+ optional customer name when the order has none). */
function orderMessage(o, opts) {
  const x = opts || {};
  const name = shortName(s(o.name) || x.name);
  const body = [s(o.service), s(o.plan), name, isRenew(o) ? 'renewal' : 'new', payMethod(o)].filter(Boolean).join(' · ');
  const id = s(o.order_id);
  return {
    title: (x.test ? '🧪 TEST · ' : '') + '💸 New order ' + inr(o.final_amount),
    body: (x.test ? 'Sample only, nothing was created · ' : '') + body,
    url: x.test ? '/panel?v=orders' : orderLink(id),
    // A unique tag per order: every order rings (renotify), a second push for the same order would replace it.
    tag: x.test ? 'order-test-' + Date.now().toString(36) : 'order-' + id.replace(/[^\w-]/g, '').slice(0, 50),
  };
}
function creditMessage(o, amount) {
  const name = shortName(o.name);
  const body = [s(o.service), s(o.plan), name, 'credit renewal', payMethod(o)].filter(Boolean).join(' · ');
  return { title: '✅ Credit paid ' + inr(amount != null ? amount : o.final_amount), body, url: orderLink(o.order_id), tag: 'credit-' + s(o.order_id).replace(/[^\w-]/g, '').slice(0, 50) };
}
function orderEmail(o, msg) {
  const rows = [['Order', s(o.order_id)], ['Amount', inr(o.final_amount)], ['Service', s(o.service)], ['Plan', s(o.plan)], ['Customer', shortName(o.name)], ['Type', isRenew(o) ? 'Renewal' : 'New'], ['Paid by', payMethod(o)]];
  const site = (process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto"><h2 style="color:#16a34a;margin-bottom:6px">' + esc(msg.title) + '</h2>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' + rows.filter((r) => r[1]).map((r) => '<tr><td style="padding:6px 10px;color:#64748b">' + esc(r[0]) + '</td><td style="padding:6px 10px;font-weight:700">' + esc(r[1]) + '</td></tr>').join('') + '</table>' +
    '<p><a href="' + esc(site + msg.url) + '" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">Open in admin</a></p></div>';
  const text = msg.title + '\n' + rows.filter((r) => r[1]).map((r) => r[0] + ': ' + r[1]).join('\n') + '\n' + site + msg.url;
  return { subject: msg.title + ' — ' + [s(o.service), s(o.plan)].filter(Boolean).join(' ') + ' (' + s(o.order_id) + ')', html, text };
}

// ---------------------------------------------------------------- sending
const sentHere = new Set(); // this process: never twice even if the marker UPDATE is not possible
const ORDER_COLS = 'order_id, name, phone_norm, service, plan, final_amount, order_type, status, txn_ref, raw_json';

async function claimMarker(orderId, field) {
  const memo = field + '|' + orderId;
  if (sentHere.has(memo)) return false;
  sentHere.add(memo);
  if (sentHere.size > 5000) sentHere.delete(sentHere.values().next().value);
  try {
    const r = await db.query(
      "UPDATE orders SET raw_json = JSON_SET(COALESCE(raw_json, JSON_OBJECT()), '$." + field + "', ?) WHERE order_id = ? AND JSON_EXTRACT(COALESCE(raw_json, JSON_OBJECT()), '$." + field + "') IS NULL LIMIT 1",
      [new Date().toISOString(), orderId]);
    return !!(r && r.affectedRows === 1);
  } catch (e) {
    console.log('[owner-alert] marker not saved for', orderId, '(sending once from this process):', e.message);
    return true;
  }
}

async function sendEmail(settings, mail) {
  const to = recipients(settings);
  if (!to.length) return { ok: false, skipped: 'no owner email' };
  const smtp = require('./smtp');
  if (!smtp.status().configured) return { ok: false, skipped: 'smtp not configured' };
  return smtp.sendMail({ to: to.join(', '), subject: mail.subject, html: mail.html, text: mail.text });
}

async function loadOrder(orderId) {
  const rows = await db.query('SELECT ' + ORDER_COLS + ' FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
  return (rows && rows[0]) || null;
}
async function customerName(phone) {
  if (!s(phone)) return '';
  try { const r = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [s(phone)]); return s(r && r[0] && r[0].name); } catch (_) { return ''; }
}

/** An order just became PAID → 💸 push to admin phones (+ email if switched on). Returns what happened (tests). */
async function orderPaid(orderId) {
  const id = s(orderId);
  if (!id) return { skipped: 'no order' };
  const cfg = await getSettings();
  if (!cfg.orderPush && !cfg.orderEmail) return { skipped: 'off' };
  const o = await loadOrder(id);
  if (!o) return { skipped: 'not found' };
  if (up(o.status) !== 'PAID') return { skipped: 'not paid (' + up(o.status) + ')' };
  if (rawOf(o.raw_json).AdminNotifiedAt) return { skipped: 'already' };
  if (!(await claimMarker(id, 'AdminNotifiedAt'))) return { skipped: 'already' };
  const msg = orderMessage(o, { name: s(o.name) ? '' : await customerName(o.phone_norm) });
  const out = { sent: true, message: msg };
  if (cfg.orderPush) out.push = await require('./push').sendToAdmins(msg, { kind: 'admin' });
  if (cfg.orderEmail) { try { out.email = await sendEmail(cfg, orderEmail(o, msg)); } catch (e) { out.email = { ok: false, error: e.message }; } }
  console.log('[owner-alert] new order', id, inr(o.final_amount), 'push', out.push ? out.push.sent + '/' + out.push.devices : 'off', out.email ? 'email ' + (out.email.ok ? 'ok' : s(out.email.skipped || out.email.error)) : '');
  return out;
}

/** A 💳 credit renewal was marked paid in full → "✅ Credit paid ₹X". */
async function creditPaid(orderId, amount) {
  const id = s(orderId);
  const cfg = await getSettings();
  if (!cfg.creditPush) return { skipped: 'off' };
  const o = await loadOrder(id);
  if (!o) return { skipped: 'not found' };
  if (up(o.status) !== 'PAID') return { skipped: 'not paid (' + up(o.status) + ')' };
  if (rawOf(o.raw_json).AdminCreditPaidNotifiedAt) return { skipped: 'already' };
  if (!(await claimMarker(id, 'AdminCreditPaidNotifiedAt'))) return { skipped: 'already' };
  const msg = creditMessage(o, amount);
  const push = await require('./push').sendToAdmins(msg, { kind: 'admin' });
  console.log('[owner-alert] credit paid', id, msg.title, 'push', push.sent + '/' + push.devices);
  return { sent: true, message: msg, push };
}

/** Fire and forget: runs after the caller has finished; errors only logged. */
function later(fn, label) {
  const run = () => Promise.resolve().then(fn).catch((e) => console.log('[owner-alert] ' + label + ' failed:', e && e.message));
  if (typeof setImmediate === 'function') setImmediate(run); else setTimeout(run, 0);
}
const orderPaidLater = (orderId) => later(() => orderPaid(orderId), 'new order ' + orderId);
const creditPaidLater = (orderId, amount) => later(() => creditPaid(orderId, amount), 'credit paid ' + orderId);

/** 🔔 Test new-order alert: the same push with a sample order, clearly TEST. Reads / writes no order. */
async function testOrderAlert() {
  const sample = { order_id: 'FF-TEST', name: 'Rahul Kumar', service: 'Netflix', plan: 'Sharing 1 Month', final_amount: 299, order_type: 'NEW', txn_ref: '' };
  const msg = orderMessage(sample, { test: true });
  const push = await require('./push').sendToAdmins(msg, { kind: 'test' });
  return { message: msg, push };
}

module.exports = {
  KEY, DEFAULTS, validate, getSettings, saveSettings, parseEmails, recipients, validTime,
  shortName, payMethod, orderMessage, creditMessage, orderEmail, orderLink,
  orderPaid, creditPaid, orderPaidLater, creditPaidLater, testOrderAlert,
  _internal: { reset: () => { cache = null; sentHere.clear(); }, claimMarker, sendEmail },
};
