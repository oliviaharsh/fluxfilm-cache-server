/**
 * FluxFilm - "how was this paid" (PaidVia) + the payer's UPI name.
 *
 * Owner request (16 Sep 2026): "When we see recent orders we see everything as Website + UTR. Also add a field
 * for whether the order was paid using the website QR or our personal QR — it helps me understand if our 2nd
 * payment [the backup UPI] is working or not. Save their UPI name in Customer 360 also."
 *
 * The values (one per order):
 *   WEBSITE_QR  🌐  the order QR / UPI link: the bank email carried the order id and payments.findByOrder matched it
 *   UTR_TYPED   🔢  the customer typed the reference on the checkout page (payments.findByRef)
 *   BACKUP_QR   📲  paid to the plain backup UPI ID / QR and matched through a claim (paymatch.js) —
 *                   the detail says auto-matched (name / known name / UTR) or approved by the owner
 *   COINS       🪙  fully paid with coins            FREE  🎁  ₹0 checkout (coupon / refund credit)
 *   ADMIN       🧑‍💼 marked paid in the admin panel   CREDIT 💳  credit renewal (pay later), detail PAID once settled
 *   UNKNOWN     ❔  older orders with nothing recorded (detail OLD_SITE for old-site rows)
 *
 * NO SCHEMA CHANGE. Every new payment stamps `raw_json.PaidVia` / `PaidViaAt` / `PaidViaDetail` on the order
 * (typed columns untouched, and the rest of raw_json is kept exactly as it was — see CLAUDE.md: raw_json is a
 * source of truth, not an archive). Older orders are worked out on the fly from the matched bank credit, the
 * claim row and the order's own fields, so history still reads correctly. Nothing is ever bulk-rewritten.
 *
 * SQL rule (live lesson): never JOIN or compare a column of a new table (payment_claims, customer_payer_names…)
 * with one of an old table (orders, customers, bank_credits) in the same statement — "Illegal mix of collations"
 * took the refund flow down once. Every lookup here is one table per statement, matched in JS.
 */
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e && e.message));
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

const VIA = Object.freeze({
  WEBSITE_QR: 'WEBSITE_QR', UTR_TYPED: 'UTR_TYPED', BACKUP_QR: 'BACKUP_QR',
  COINS: 'COINS', FREE: 'FREE', ADMIN: 'ADMIN', CREDIT: 'CREDIT', UNKNOWN: 'UNKNOWN',
});
/** Order the owner reads them in (Today line, filters, export). */
const ORDER = Object.freeze([VIA.WEBSITE_QR, VIA.BACKUP_QR, VIA.UTR_TYPED, VIA.COINS, VIA.FREE, VIA.ADMIN, VIA.CREDIT, VIA.UNKNOWN]);
const META = Object.freeze({
  WEBSITE_QR: { emoji: '🌐', name: 'Website QR', filter: 'website_qr', word: 'website QR' },
  UTR_TYPED: { emoji: '🔢', name: 'UTR typed', filter: 'utr_typed', word: 'UTR' },
  BACKUP_QR: { emoji: '📲', name: 'Backup QR', filter: 'backup_qr', word: 'backup QR' },
  COINS: { emoji: '🪙', name: 'Coins', filter: 'coins', word: 'coins' },
  FREE: { emoji: '🎁', name: '₹0 checkout', filter: 'free', word: '₹0' },
  ADMIN: { emoji: '🧑‍💼', name: 'Admin', filter: 'admin', word: 'admin' },
  CREDIT: { emoji: '💳', name: 'Credit', filter: 'credit', word: 'credit' },
  UNKNOWN: { emoji: '❔', name: 'Not recorded', filter: 'unknown', word: 'not recorded' },
});
/** Extra words after the name, so the owner knows how a backup payment was accepted. */
const DETAIL_TEXT = Object.freeze({
  BACKUP_QR: { AUTO: 'name matched', LEARNED: 'known name', UTR: 'UTR matched', ADMIN: 'admin approved' },
  CREDIT: { DUE: 'pay later', PAID: 'paid', WRITTEN_OFF: 'written off' },
  FREE: { COUPON: 'coupon', REFUND_CREDIT: 'refund credit' },
  UNKNOWN: { OLD_SITE: 'old site' },
});
const FILTER_KEYS = Object.freeze(ORDER.map((k) => META[k].filter));
const BY_FILTER = Object.freeze(ORDER.reduce((m, k) => Object.assign(m, { [META[k].filter]: k }), {}));
/** { website_qr: '🌐 Website QR', … } for the admin filter chips and the export dialog. */
function filterOptions() { const out = {}; for (const k of ORDER) out[META[k].filter] = META[k].emoji + ' ' + META[k].name; return out; }

const normalize = (v) => (VIA[up(v)] ? up(v) : '');
const fromFilter = (v) => BY_FILTER[s(v).toLowerCase()] || '';
const filterOf = (via) => (META[normalize(via)] || {}).filter || '';

/** '📲 Backup QR (name matched)'. Empty for an order that was never paid. */
function label(via, detail) {
  const k = normalize(via); if (!k) return '';
  const extra = (DETAIL_TEXT[k] || {})[up(detail)] || '';
  return META[k].emoji + ' ' + META[k].name + (extra ? ' (' + extra + ')' : '');
}
/** Short pill for a list row: no bracket text, so it stays readable on a phone. */
function pill(via) { const k = normalize(via); return k ? META[k].emoji + ' ' + META[k].name : ''; }

// ------------------------------------------------------------------ writing (payment time)
/**
 * Put PaidVia / PaidViaAt / PaidViaDetail on a raw_json OBJECT. Pure: returns the same object.
 * `at` is India wall-clock text or an ISO string — whatever the caller already uses.
 */
function stamp(raw, via, detail, at) {
  const k = normalize(via); if (!k) return raw;
  raw.PaidVia = k;
  raw.PaidViaAt = s(at) || new Date().toISOString();
  if (s(detail)) raw.PaidViaDetail = up(detail); else delete raw.PaidViaDetail;
  return raw;
}
/**
 * Same, for the raw_json COLUMN value. Returns the JSON text to write, or null when nothing should be
 * written: a raw_json that is a non-empty string we cannot parse is left alone rather than replaced
 * (losing the original fields would be far worse than a missing "Paid via").
 */
function stampJson(rawJson, via, detail, at) {
  if (!normalize(via)) return null;
  let obj;
  if (rawJson == null || rawJson === '') obj = {};
  else if (typeof rawJson === 'object') obj = Object.assign({}, rawJson);
  else { try { obj = JSON.parse(rawJson); } catch (_) { return null; } if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null; }
  return JSON.stringify(stamp(obj, via, detail, at));
}

// ------------------------------------------------------------------ working it out (old orders)
const PAID_STATUSES = ['PAID', 'FULFILLED', 'REFUNDED'];
/**
 * How this order was paid → { via, detail, at, stored, label, filter }.
 * `ctx` may carry { raw, credit, claim } (see loadContext); anything missing just makes the answer vaguer.
 * A stamped order always answers from its own raw_json, so what the owner saw yesterday cannot change.
 */
function compute(o, ctx) {
  o = o || {}; ctx = ctx || {};
  const raw = ctx.raw || rawOf(o.raw_json);
  const out = (via, detail, at, stored) => ({
    via: normalize(via), detail: up(detail), at: s(at), stored: !!stored,
    label: label(via, detail), pill: pill(via), filter: filterOf(via),
  });
  const stored = normalize(raw.PaidVia);
  if (stored) return out(stored, raw.PaidViaDetail, raw.PaidViaAt, true);

  const st = up(o.status);
  const claim = ctx.claim || null;
  const credit = ctx.credit || null;
  // 💳 A credit renewal is "paid later": it stays CREDIT even after the owner records the money (raw.Credit).
  if (st === 'CREDIT' || st === 'WRITTEN_OFF' || raw.Credit === true) {
    return out(VIA.CREDIT, st === 'CREDIT' ? 'DUE' : st === 'WRITTEN_OFF' ? 'WRITTEN_OFF' : 'PAID', raw.CreditPaidAt);
  }
  if (!PAID_STATUSES.includes(st)) return { via: '', detail: '', at: '', stored: false, label: '', pill: '', filter: '' };
  if (up(raw.CreatedVia) === 'ADMIN') return out(VIA.ADMIN, '', raw.PaidAt);
  // ₹0 checkout (order.js confirmFreeOrder writes txn_ref CREDIT-FF… and FreeConfirmedAt).
  if (/^CREDIT-/i.test(s(o.txn_ref)) || raw.FreeConfirmedAt) {
    const pm = up(raw.PaymentMethod);
    if (/COINS/.test(pm)) return out(VIA.COINS, '', raw.FreeConfirmedAt);
    return out(VIA.FREE, /CREDIT/.test(pm) ? 'REFUND_CREDIT' : /COUPON/.test(pm) ? 'COUPON' : '', raw.FreeConfirmedAt);
  }
  // 📲 A claim row means the customer paid the plain backup UPI ID / QR (paymatch.js).
  if (claim) {
    const d = up(claim.source) === 'LEARNED' ? 'LEARNED' : up(claim.status) === 'APPROVED' ? 'ADMIN' : s(claim.utr) ? 'UTR' : 'AUTO';
    return out(VIA.BACKUP_QR, d, claim.decided_at || claim.updated_at || claim.created_at);
  }
  // Anything that is not a `node` order came from the old Sheet site (its source is 'sheet' or empty) — the same
  // rule the order screen already uses for "Created via". Those payments were confirmed there, so we never know.
  if (s(o.source) !== 'node') return out(VIA.UNKNOWN, 'OLD_SITE', o.verified_at);
  if (credit) {
    // The bank note carried the order id → it was the website QR / UPI link. Otherwise the only way this credit
    // could have been taken is the customer typing its reference (payments.findByRef).
    const ids = s(credit.order_ids).toUpperCase().split(',').map((x) => x.trim()).filter(Boolean);
    return out(ids.includes(up(o.order_id)) ? VIA.WEBSITE_QR : VIA.UTR_TYPED, '', o.verified_at || credit.received_at);
  }
  if (/^ADMIN-/i.test(s(o.txn_ref))) return out(VIA.ADMIN, '', o.verified_at);
  if (/^MANUAL-REVIEW-/i.test(s(o.txn_ref))) return out(VIA.BACKUP_QR, 'ADMIN', o.verified_at);
  if (num(raw.CoinsUsed) > 0 && num(o.final_amount) <= 0) return out(VIA.COINS, '', o.verified_at);
  return out(VIA.UNKNOWN, '', o.verified_at);
}

// ------------------------------------------------------------------ the bank alert
/**
 * Payer name / note / IFSC from a stored Equitas alert (bank_credits.raw). Same shape as paymatch.parseAlert —
 * kept here too so reading a payment never has to load the matching engine.
 *   "... UPI REF NO 123456789012 P2P-RAHUL KUMAR SHARMA-FF1234567-SBIN0001234- HEAD OFFICE ..."
 * A UPI ID is not in Equitas' text today; if one ever appears it is picked up and masked.
 */
function parseAlert(raw) {
  const text = s(raw).replace(/\s+/g, ' ');
  const m = text.match(/UPI REF NO\s+\d+\s+P2[PM]-(.*?)-([^-]*)-([A-Z]{4}0[A-Z0-9]{6})-/i);
  const vpaM = text.match(/\b([a-z0-9][a-z0-9._-]{1,48})@(ok[a-z]+|[a-z][a-z0-9.-]{1,24})\b/i);
  const vpa = vpaM && !/\.(com|in|net|org)$/i.test(vpaM[2]) ? vpaM[0] : '';
  return m
    ? { payerName: clean(m[1]), note: clean(m[2]), ifsc: up(m[3]), vpa: vpa.toLowerCase() }
    : { payerName: '', note: '', ifsc: '', vpa: vpa.toLowerCase() };
}
/** Bank text can hold anything: strip the characters that could break out of the admin HTML. */
function clean(v) { return s(v).replace(/[<>"'`\\]/g, '').slice(0, 80); }
function nameTokens(v) { return clean(v).toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean); }
const displayName = (v) => nameTokens(v).join(' ');
const compactName = (v) => nameTokens(v).join('');
/** 'rahulsharma@okhdfc' → 'ra**@okhdfc' (the owner only needs to recognise the bank). */
function maskVpa(v) {
  const t = s(v).toLowerCase(); const at = t.indexOf('@');
  if (at < 1) return '';
  return t.slice(0, Math.min(2, at)) + '**' + t.slice(at);
}

// ------------------------------------------------------------------ loading the context
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const inList = (n) => '(' + new Array(n).fill('?').join(',') + ')';
/**
 * The matched bank credit and the accepted claim for each of these orders.
 * One table per statement, matched in JS (no JOIN across old and new tables).
 */
async function loadContext(query, orderIds) {
  const ids = [...new Set((orderIds || []).map((x) => s(x)).filter(Boolean))];
  const credits = new Map(); const claims = new Map();
  if (!ids.length) return { credits, claims };
  for (const part of chunk(ids, 200)) {
    const rows = await query('SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE consumed_order_id IN ' + inList(part.length), part);
    for (const r of rows) { const k = s(r.consumed_order_id); if (k && !credits.has(k)) credits.set(k, r); }
    try {
      const cl = await query("SELECT order_id, payer_name, utr, status, source, credit_id, created_at, updated_at, decided_at FROM payment_claims WHERE status IN ('MATCHED', 'APPROVED') AND order_id IN " + inList(part.length), part);
      for (const c of cl) { const k = s(c.order_id); if (k && !claims.has(k)) claims.set(k, c); }
    } catch (e) { if (!missingTable(e)) throw e; }  // schema-v17 not run yet: no backup-QR claims exist either
  }
  return { credits, claims };
}
/** compute() for a whole list, with the bank credit / claim already loaded. Returns a Map orderId → result. */
function computeAll(orders, ctx) {
  const out = new Map();
  for (const o of orders || []) {
    const id = s(o.order_id);
    out.set(id, compute(o, { credit: (ctx.credits || new Map()).get(id) || null, claim: (ctx.claims || new Map()).get(id) || null }));
  }
  return out;
}
/** Everything in one go for a list of order rows that already carry raw_json. */
async function forOrders(query, orders) {
  const ctx = await loadContext(query, (orders || []).map((o) => o.order_id));
  return { map: computeAll(orders, ctx), ctx };
}

// ------------------------------------------------------------------ counting (Today)
/** { WEBSITE_QR: 6, BACKUP_QR: 2, … } from compute() results. */
function counts(list) {
  const out = {};
  for (const r of list || []) { const k = normalize(r && r.via); if (k) out[k] = (out[k] || 0) + 1; }
  return out;
}
/** 'Payments today: 6 website QR · 2 backup QR · 1 UTR' — '' when nothing was paid. */
function summaryLine(cnt, prefix) {
  const parts = ORDER.filter((k) => cnt && cnt[k] > 0).map((k) => cnt[k] + ' ' + META[k].word);
  return parts.length ? (prefix || 'Payments today') + ': ' + parts.join(' · ') : '';
}

// ------------------------------------------------------------------ the payer's UPI name
/**
 * "💳 Pays from" for Customer 360: every payer name seen on this customer's own matched bank credits,
 * newest first, de-duplicated, with the UPI ID (masked) when the bank ever sends one.
 *   credits  — bank_credits rows for THIS customer's orders only (never a global query)
 *   learned  — customer_payer_names rows for this phone (paymatch.js), used for names whose credit is gone
 *   storedNames — customers.raw_json.PayerNames
 */
function payerNames(credits, learned, storedNames) {
  const by = new Map();
  const add = (name, at, extra) => {
    const display = displayName(name); const key = compactName(name);
    if (key.length < 2) return;
    const cur = by.get(key);
    if (!cur) { by.set(key, Object.assign({ name: display, vpa: '', bank: '', lastAt: s(at), amount: 0, orderId: '', orders: 0, learned: false }, extra || {}, { name: display, lastAt: s(at) })); return; }
    cur.orders += (extra && extra.orders) || 0;
    if (extra && extra.learned === false) cur.learned = false;
    if (s(at) && s(at) > s(cur.lastAt)) {
      cur.lastAt = s(at);
      if (extra && extra.orderId) cur.orderId = extra.orderId;
      if (extra && extra.amount) cur.amount = extra.amount;
    }
    if (extra && extra.vpa && !cur.vpa) cur.vpa = extra.vpa;
    if (extra && extra.bank && !cur.bank) cur.bank = extra.bank;
  };
  for (const c of credits || []) {
    const a = parseAlert(c.raw);
    if (!a.payerName) continue;
    add(a.payerName, c.received_at, { vpa: maskVpa(a.vpa), bank: a.ifsc, amount: num(c.amount), orderId: s(c.consumed_order_id), orders: 1, learned: false });
  }
  for (const n of storedNames || []) add(n && n.name, n && n.at, { orders: 0, learned: false });
  for (const l of learned || []) add(l && (l.name_display || l.name_norm), l && l.last_used, { orders: 0, learned: true });
  return [...by.values()].sort((a, b) => s(b.lastAt).localeCompare(s(a.lastAt)) || b.orders - a.orders);
}
/**
 * Read the "💳 Pays from" card for one customer. `orderIds` must be that customer's own orders.
 * Three separate statements, joined in JS (bank_credits + customer_payer_names + customers.raw_json).
 */
async function payerCard(query, phoneNorm, orderIds, storedNames) {
  const ph = s(phoneNorm);
  const ids = [...new Set((orderIds || []).map((x) => s(x)).filter(Boolean))];
  let credits = [];
  for (const part of chunk(ids, 200)) {
    const rows = await query('SELECT id, upi_ref, amount, raw, received_at, consumed_order_id FROM bank_credits WHERE consumed_order_id IN ' + inList(part.length), part);
    credits = credits.concat(rows);
  }
  let learned = [];
  if (ph) {
    try { learned = await query('SELECT name_display, name_norm, last_used, times_used FROM customer_payer_names WHERE phone_norm = ? ORDER BY last_used DESC LIMIT 10', [ph]); }
    catch (e) { if (!missingTable(e)) throw e; learned = []; }
  }
  return payerNames(credits, learned, storedNames);
}
/** customers.raw_json.PayerNames → [{ name, at }] (tolerates the old plain-string shape). */
function storedPayerNames(rawJson) {
  const list = rawOf(rawJson).PayerNames;
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? { name: displayName(x), at: '' } : { name: displayName(x && x.name), at: s(x && x.at) })).filter((x) => x.name);
}
/**
 * Remember the payer's UPI name on the customer row: raw_json.PayerNames keeps the last 5 (newest first) and
 * LastPayerName the newest, so the admin search can find "who pays as RAHUL". Typed columns are never touched.
 * Never throws at the caller: a payment must not fail because a name could not be saved.
 */
async function rememberPayerName(query, phoneNorm, name, at) {
  const ph = s(phoneNorm); const display = displayName(name);
  if (!ph || compactName(display).length < 2) return { ok: false, skipped: 'no name' };
  const rows = await query('SELECT raw_json FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  if (!rows || !rows.length) return { ok: false, skipped: 'no customer' };
  const cur = rows[0].raw_json;
  let obj;
  if (cur == null || cur === '') obj = {};
  else if (typeof cur === 'object') obj = Object.assign({}, cur);
  else { try { obj = JSON.parse(cur); } catch (_) { return { ok: false, skipped: 'raw_json unreadable' }; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, skipped: 'raw_json unreadable' };
  const when = s(at) || new Date().toISOString();
  const kept = storedPayerNames(obj).filter((x) => compactName(x.name) !== compactName(display));
  obj.PayerNames = [{ name: display, at: when }].concat(kept).slice(0, 5);
  obj.LastPayerName = display;
  await query('UPDATE customers SET raw_json = ? WHERE phone_norm = ? LIMIT 1', [JSON.stringify(obj), ph]);
  return { ok: true, name: display, kept: obj.PayerNames.length };
}
/** Fire-and-forget wrapper for the payment paths — a failure is only logged. */
function rememberPayerNameLater(query, phoneNorm, name, at) {
  Promise.resolve()
    .then(() => rememberPayerName(query, phoneNorm, name, at))
    .catch((e) => console.log('[paidvia] could not save payer name:', e.message));
}
/**
 * Phone numbers whose payer name matches `q` (admin global search). Two statements, matched in JS:
 * customer_payer_names first, then whatever customers.raw_json remembers.
 */
async function searchPayerPhones(query, q, limit) {
  const text = s(q); const out = new Map();
  if (text.length < 2) return [];
  const max = Math.min(20, Math.max(1, limit || 6));
  const like = '%' + text + '%';
  try {
    const rows = await query('SELECT phone_norm, name_display, name_norm, last_used FROM customer_payer_names WHERE name_display LIKE ? OR name_norm LIKE ? ORDER BY last_used DESC LIMIT ?', [like, like, max]);
    for (const r of rows) { const ph = s(r.phone_norm); if (ph && !out.has(ph)) out.set(ph, { phone_norm: ph, payerName: displayName(r.name_display || r.name_norm) }); }
  } catch (e) { if (!missingTable(e)) throw e; }
  if (out.size < max) {
    try {
      const rows = await query("SELECT phone_norm, raw_json FROM customers WHERE JSON_VALID(raw_json) AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.LastPayerName')) LIKE ? LIMIT ?", [like, max]);
      for (const r of rows) { const ph = s(r.phone_norm); const n = (storedPayerNames(r.raw_json)[0] || {}).name || ''; if (ph && n && !out.has(ph)) out.set(ph, { phone_norm: ph, payerName: n }); }
    } catch (e) { console.log('[paidvia] payer-name search on customers skipped:', e.message); }  // best effort: the main search must never break
  }
  return [...out.values()].slice(0, max);
}

module.exports = {
  VIA, ORDER, META, FILTER_KEYS, filterOptions, normalize, fromFilter, filterOf, label, pill,
  stamp, stampJson, compute, computeAll, loadContext, forOrders, counts, summaryLine,
  parseAlert, maskVpa, displayName, compactName, payerNames, payerCard, storedPayerNames,
  rememberPayerName, rememberPayerNameLater, searchPayerPhones,
  _internal: { rawOf, chunk, inList },
};
