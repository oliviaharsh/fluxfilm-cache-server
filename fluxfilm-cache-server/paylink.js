/**
 * FluxFilm — 💳 a payment link + QR for ONE order.
 *
 * Owner, 20 Sep: after ⚡ Quick order creates an order he wants to send the customer a link / QR instead of only
 * "✅ Mark paid". The customer opens the link, scans the QR (or taps the button on a phone) and pays — and because
 * the **order id is the UPI note**, the bank alert carries it, so `payments.js` matches the payment to the order by
 * itself. Nothing has to be marked paid by hand, and if the note is lost the payment shows up in 🏦 Bank payments
 * where it can be linked in one tap.
 *
 * The page is plain HTML (no React, no login): the link itself is the key.
 *   GET /pay/:orderId?t=<token>          the page
 *   GET /pay/:orderId/status?t=<token>   { ok, status } — the page polls this and says "✅ Payment received"
 *
 * `t` is an HMAC of the order id with a server-only secret, so order ids cannot simply be guessed. The page shows
 * the plan, the amount and the order id — never the customer's name, phone or email — and is never indexed.
 */
const crypto = require('crypto');

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SITE = () => (process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
const VPA = () => process.env.UPI_VPA || 'fluxfilm@upi';
const PAYEE = () => process.env.UPI_PAYEE || 'FluxFilm';
// Set PAYLINK_SECRET in Hostinger to make old links survive an admin-key change; the admin key is the fallback.
const SECRET = () => process.env.PAYLINK_SECRET || process.env.CACHE_CLEAR_KEY || process.env.API_KEY || 'fluxfilm-paylink';
const ORDER_RE = /^[A-Z0-9-]{3,40}$/;

/** The key in the link. Same order id + same secret = same token, so a link can be rebuilt at any time. */
function token(orderId) {
  const id = up(orderId);
  if (!ORDER_RE.test(id)) return '';
  return crypto.createHmac('sha256', SECRET()).update('paylink:' + id).digest('hex').slice(0, 16);
}
function tokenOk(orderId, given) {
  const want = token(orderId);
  const got = s(given).toLowerCase();
  if (!want || want.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
/** The link to send the customer. */
function linkFor(orderId, base) {
  const id = up(orderId);
  const t = token(id);
  return t ? (s(base) || SITE()) + '/pay/' + encodeURIComponent(id) + '?t=' + t : '';
}
/** The same upi:// link checkout builds — the order id is the note, which is what makes the payment match itself. */
function upiLinkFor(orderId, amount) {
  return 'upi://pay?pa=' + encodeURIComponent(VPA()) + '&pn=' + encodeURIComponent(PAYEE()) +
    '&am=' + encodeURIComponent(num(amount)) + '&cu=INR&tn=' + encodeURIComponent(up(orderId));
}
/** The QR picture — the same service the checkout page already uses. */
function qrFor(upiLink, size) {
  const px = Math.max(160, Math.min(600, parseInt(size, 10) || 320));
  return 'https://api.qrserver.com/v1/create-qr-code/?size=' + px + 'x' + px + '&margin=8&data=' + encodeURIComponent(s(upiLink));
}
/** Ready-to-send message (WhatsApp / SMS). Short, no jargon, the link does the rest. */
function messageFor(o, link) {
  const name = s(o && o.name).split(/\s+/)[0];
  return (name ? 'Hi ' + name + ', ' : 'Hi, ') + 'here is the payment link for your FluxFilm ' + s(o && o.service) +
    (s(o && o.plan) ? ' (' + s(o.plan) + ')' : '') + ' — ₹' + num(o && o.final_amount) + '.\n' + s(link) +
    '\nScan the QR or tap the button in your UPI app. Your plan is delivered as soon as the payment reaches us. 💚';
}
function waUrlFor(o, link) {
  const ph = s(o && (o.phone || o.phone_norm)).replace(/\D/g, '').slice(-10);
  return ph.length === 10 ? 'https://wa.me/91' + ph + '?text=' + encodeURIComponent(messageFor(o, link)) : '';
}
/** Everything the admin panel needs for one order, in one object. */
function packFor(o, base) {
  const id = up(o && o.order_id);
  const link = linkFor(id, base);
  const upi = upiLinkFor(id, o && o.final_amount);
  return {
    orderId: id, amount: num(o && o.final_amount), service: s(o && o.service), plan: s(o && o.plan),
    payLink: link, upiLink: upi, qr: qrFor(upi, 320), upiVpa: VPA(), note: id,
    whatsapp: messageFor(o, link), waUrl: waUrlFor(o, link), email: s(o && o.email),
  };
}

// ------------------------------------------------------------------ the page
const PAID = ['PAID', 'FULFILLED'];
const CLOSED = ['CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED'];

function page(body, title) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex, nofollow"/>' +
    '<title>' + esc(title || 'FluxFilm payment') + '</title><style>' +
    ':root{color-scheme:light}body{margin:0;background:#f3f6f9;font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#0f172a}' +
    '.wrap{max-width:420px;margin:0 auto;padding:18px 16px 40px}' +
    '.card{background:#fff;border-radius:20px;padding:18px;box-shadow:0 10px 30px rgba(15,23,42,.08);margin-top:14px}' +
    '.brand{display:flex;align-items:center;gap:10px;font-weight:900;font-size:19px}.brand i{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,#15803d,#22c55e);display:grid;place-items:center;color:#fff;font-style:normal}' +
    'h1{font-size:19px;margin:0 0 2px}.muted{color:#64748b;font-size:13.5px;line-height:1.5}' +
    '.amt{font-size:34px;font-weight:900;letter-spacing:-.02em;margin:6px 0 2px}' +
    '.qr{display:block;margin:14px auto 6px;width:260px;max-width:100%;height:auto;border-radius:14px;background:#fff}' +
    '.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;border:0;border-radius:999px;background:linear-gradient(135deg,#15803d,#22c55e);color:#fff;font:inherit;font-size:16px;font-weight:800;text-decoration:none;margin-top:12px;cursor:pointer}' +
    '.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:#f8fafc;margin-top:10px;font-size:14px;font-weight:700;word-break:break-all}' +
    '.row button{border:0;background:#e2e8f0;border-radius:999px;padding:8px 12px;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;flex:none}' +
    '.state{margin-top:14px;padding:12px 14px;border-radius:14px;background:#fff7ed;color:#9a3412;font-size:14px;font-weight:700}' +
    '.state.ok{background:#f0fdf4;color:#166534}.pill{display:inline-block;padding:3px 10px;border-radius:999px;background:#ecfdf5;color:#166534;font-size:12px;font-weight:800}' +
    '</style></head><body><div class="wrap"><div class="brand"><i>▶</i> FluxFilm</div>' + body + '</div></body></html>';
}
const simple = (title, text) => page('<div class="card"><h1>' + esc(title) + '</h1><p class="muted">' + esc(text) + '</p>' +
  '<a class="btn" href="' + esc(SITE()) + '">Open FluxFilm</a></div>', title);

function payPage(o) {
  const id = up(o.order_id);
  const amount = num(o.final_amount);
  const upi = upiLinkFor(id, amount);
  const body = '<div class="card">' +
    '<h1>Pay for your ' + esc(o.service) + '</h1>' +
    '<p class="muted">' + esc(o.plan) + ' · order <b>' + esc(id) + '</b></p>' +
    '<div class="amt">₹' + esc(amount) + '</div>' +
    '<p class="muted">Scan this with any UPI app (GPay, PhonePe, Paytm…)</p>' +
    '<img class="qr" src="' + esc(qrFor(upi, 520)) + '" alt="UPI QR code for ₹' + esc(amount) + '" width="260" height="260"/>' +
    '<a class="btn" href="' + esc(upi) + '">📲 Pay ₹' + esc(amount) + ' in your UPI app</a>' +
    '<div class="row"><span>UPI ID<br><b>' + esc(VPA()) + '</b></span><button type="button" data-copy="' + esc(VPA()) + '">Copy</button></div>' +
    '<div class="row"><span>Keep this note on the payment<br><b>' + esc(id) + '</b></span><button type="button" data-copy="' + esc(id) + '">Copy</button></div>' +
    '<div class="state" id="st">⏳ Waiting for your payment… this page updates by itself.</div>' +
    '<p class="muted" style="margin-top:14px">Your plan is delivered as soon as the payment reaches us — usually within a minute. You can close this page after paying.</p>' +
    '</div>' +
    '<script>(function(){' +
    'document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;' +
    'var v=b.getAttribute("data-copy");try{navigator.clipboard.writeText(v);b.textContent="Copied";setTimeout(function(){b.textContent="Copy";},1500);}catch(x){}});' +
    'var st=document.getElementById("st"),tries=0;' +
    'function poll(){tries++;if(tries>120)return;' +
    'fetch(location.pathname+"/status"+location.search,{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){' +
    'if(d&&d.paid){st.className="state ok";st.innerHTML="✅ Payment received! Your plan is on its way — check your email.";return;}' +
    'setTimeout(poll,6000);}).catch(function(){setTimeout(poll,10000);});}' +
    'setTimeout(poll,6000);})();</script>';
  return page(body, 'Pay ₹' + amount + ' · FluxFilm');
}

function mount(app, deps) {
  const db = (deps && deps.db) || require('./db');
  const load = async (id) => {
    const rows = await db.query('SELECT order_id, service, plan, final_amount, status, fulfillment_status FROM orders WHERE order_id = ? LIMIT 1', [id]);
    return (rows && rows[0]) || null;
  };
  const clean = (v) => up(v).replace(/[^A-Z0-9-]/g, '').slice(0, 40);

  app.get('/pay/:orderId/status', async (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    const id = clean(req.params.orderId);
    if (!ORDER_RE.test(id) || !tokenOk(id, req.query.t)) return res.status(404).json({ ok: false });
    try {
      const o = await load(id);
      if (!o) return res.status(404).json({ ok: false });
      const st = up(o.status);
      res.json({ ok: true, status: st, paid: PAID.includes(st) });
    } catch (e) { res.status(500).json({ ok: false }); }
  });

  app.get('/pay/:orderId', async (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    const id = clean(req.params.orderId);
    const send = (html, code) => res.status(code || 200).type('html').send(html);
    if (!ORDER_RE.test(id) || !tokenOk(id, req.query.t)) {
      return send(simple('This payment link is not valid', 'Please ask us for a new link — the old one may have been changed or copied wrongly.'), 404);
    }
    try {
      const o = await load(id);
      if (!o) return send(simple('This payment link is not valid', 'We could not find that order. Please ask us for a new link.'), 404);
      const st = up(o.status);
      if (PAID.includes(st)) return send(simple('✅ Already paid', 'This order is paid — nothing more to do. Your plan is delivered by email; tap below to see it in the app.'));
      if (CLOSED.includes(st)) return send(simple('This order is closed', 'This order was cancelled or refunded, so it cannot be paid. Please talk to us if that looks wrong.'));
      send(payPage(o));
    } catch (e) { send(simple('Something went wrong', 'Please try again in a minute, or ask us for a new link.'), 500); }
  });
}

module.exports = { mount, token, tokenOk, linkFor, upiLinkFor, qrFor, messageFor, waUrlFor, packFor, SITE, _internal: { payPage, simple, page, PAID, CLOSED } };
