/**
 * FluxFilm - payment fallback: "Payment not going through / limit reached?" (schema-v17).
 *
 * Some customers' UPI apps refuse the order QR/link ("limit reached"). They then pay the plain backup
 * UPI ID / QR, so the bank alert has no order id and the normal auto-verify (payments.findByOrder) can't
 * see it. The customer tells us they paid ("I've paid" form: payer name as shown in their UPI app,
 * optional UTR) and this module matches that claim to a bank credit.
 *
 * Equitas alert (checked 2026-09-14): "... UPI REF NO 123456789012 P2P-RAHUL KUMAR SHARMA-FF1234567-SBIN0001234- HEAD OFFICE ..."
 *   → payer name (cut at ~20 characters, sometimes without spaces) · note ("UPI" when there is none) · payer IFSC.
 *
 * Matching is deterministic, never a guess. A credit is only taken when:
 *   - it is unused (consumed_order_id IS NULL, taken with an atomic UPDATE … WHERE consumed_order_id IS NULL),
 *   - the amount equals the order amount, and
 *   - the UTR matches exactly, OR exactly ONE credit in the time window has a strong payer-name match
 *     (claimed name or a name this customer paid with before) and no other open order/claim fits it.
 * Anything else (two candidates, partial name, nothing found after `reviewAfterMin`) goes to the admin
 * 💸 Payments review queue for a one-tap approve / reject.
 *
 * Settings (admin panel, app_settings 'payfallback' + the QR image in 'payfallback_qr'):
 *   enabled, backupVpa, backupPayee, windowMin, reviewAfterMin, autoAccept, useLearnedNames, maxClaimsPerOrder.
 */
const crypto = require('crypto');
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e && e.message));
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

const SETTINGS_KEY = 'payfallback';
const QR_KEY = 'payfallback_qr';
const OPEN = ['WAITING', 'REVIEW'];
const QR_MAX_CHARS = 700000; // ~500 KB image; the admin panel shrinks uploads to ≤ 720 px first

// Tests replace these (clock + how an order is marked paid).
const deps = {
  now: () => new Date(),
  markPaid: (orderId, txnRef) => require('./order').adminMarkPaid(orderId, txnRef),
};

// ---------------- time helpers (the database stores India time without a zone) ----------------
const pad = (n) => String(n).padStart(2, '0');
function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function toDate(v) { if (!v) return null; if (v instanceof Date) return v; const d = new Date(s(v).replace(' ', 'T')); return isNaN(d.getTime()) ? null : d; }

// ---------------- settings ----------------
const DEFAULTS = Object.freeze({
  enabled: true,
  backupVpa: process.env.UPI_VPA || 'fluxfilm@upi',
  backupPayee: process.env.UPI_PAYEE || 'FluxFilm',
  windowMin: 15, reviewAfterMin: 30,
  autoAccept: true, useLearnedNames: true,
  maxClaimsPerOrder: 5,
});
const NUMBER_RULES = [['windowMin', 5, 120], ['reviewAfterMin', 5, 240], ['maxClaimsPerOrder', 1, 20]];
const BOOL_KEYS = ['enabled', 'autoAccept', 'useLearnedNames'];

function validateSettings(input) {
  const inb = input || {}; const out = {}; const errors = [];
  for (const [k, lo, hi] of NUMBER_RULES) {
    const v = inb[k] === undefined || inb[k] === '' ? DEFAULTS[k] : Number(inb[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(k + ' must be a number between ' + lo + ' and ' + hi + '.');
    else out[k] = Math.round(v);
  }
  for (const k of BOOL_KEYS) { const v = inb[k]; out[k] = v === undefined ? DEFAULTS[k] : (v === true || v === 1 || String(v).toLowerCase() === 'true'); }
  const vpa = inb.backupVpa === undefined ? DEFAULTS.backupVpa : s(inb.backupVpa).toLowerCase();
  if (!/^[a-z0-9._-]{2,64}@[a-z0-9.-]{2,64}$/.test(vpa)) errors.push('Backup UPI ID looks wrong (example: name@okaxis).');
  else out.backupVpa = vpa;
  const payee = inb.backupPayee === undefined ? DEFAULTS.backupPayee : s(inb.backupPayee).replace(/[<>"]/g, '');
  if (!payee || payee.length > 60) errors.push('Payee name must be 1–60 characters.');
  else out.backupPayee = payee;
  return { ok: !errors.length, settings: Object.assign({}, DEFAULTS, out), errors };
}

let cache = null; let cacheAt = 0; let qrCache = null; let qrAt = 0;
async function readSetting(key) {
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]);
    return rows.length ? rows[0].value : null;
  } catch (e) { if (missingTable(e)) return null; throw e; }
}
async function getSettings(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 30e3) return cache;
  let saved = {}; const v = await readSetting(SETTINGS_KEY);
  if (v) { try { saved = JSON.parse(v) || {}; } catch (_) { saved = {}; } }
  cache = validateSettings(saved).settings; cacheAt = Date.now();
  return cache;
}
async function saveSettings(input) {
  const v = validateSettings(input);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  try {
    await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTINGS_KEY, JSON.stringify(v.settings)]);
  } catch (e) { if (missingTable(e)) return { ok: false, needsSchema: true, message: 'Run db/schema-v15.sql and db/schema-v17.sql in phpMyAdmin first.' }; throw e; }
  cache = null;
  return { ok: true, settings: v.settings };
}
async function getQr(fresh) {
  if (!fresh && qrCache !== null && Date.now() - qrAt < 60e3) return qrCache;
  qrCache = s(await readSetting(QR_KEY)); qrAt = Date.now();
  return qrCache;
}
/** dataUrl '' removes the uploaded QR (the storefront then draws a QR from the backup UPI ID). */
async function saveQr(dataUrl) {
  const v = s(dataUrl);
  if (v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { ok: false, message: 'Please upload a PNG, JPG or WebP image.' };
  if (v.length > QR_MAX_CHARS) return { ok: false, message: 'That image is too big — please use a smaller picture (under 500 KB).' };
  try {
    if (!v) await db.query('DELETE FROM app_settings WHERE setting_key = ?', [QR_KEY]);
    else await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [QR_KEY, v]);
  } catch (e) {
    if (missingTable(e) || /Data too long/i.test(String(e.message))) return { ok: false, needsSchema: true, message: 'Run db/schema-v17.sql in phpMyAdmin first (it makes room for the QR image).' };
    throw e;
  }
  qrCache = null;
  return { ok: true, hasQr: !!v, bytes: v.length };
}

// ---------------- names ----------------
function nameTokens(v) { return s(v).toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean); }
function displayName(v) { return nameTokens(v).join(' '); }
function compactName(v) { return nameTokens(v).join(''); }
/**
 * How well the bank's payer name fits a typed name: EXACT · STRONG · WEAK · NONE.
 * Handles case, dots, extra spaces, names run together, the bank cutting the name at ~20 characters,
 * a different word order and missing/added initials ("E L GUNAVANTH KUMAR" = "Gunavanth Kumar").
 */
function nameScore(bankName, typedName) {
  const bt = nameTokens(bankName), tt = nameTokens(typedName);
  const bc = bt.join(''), tc = tt.join('');
  if (!bc || !tc) return 'NONE';
  if (bc === tc) return 'EXACT';
  const bSp = bt.join(' '), tSp = tt.join(' ');
  if ((bSp.length >= 16 && tSp.startsWith(bSp)) || (bc.length >= 14 && tc.startsWith(bc))) return 'STRONG';
  const words = (t) => t.filter((x) => x.length >= 2).sort();
  const initials = (t) => t.filter((x) => x.length === 1).sort().join('');
  const bw = words(bt), tw = words(tt);
  if (bw.length && bw.join(' ') === tw.join(' ') && (bw.length >= 2 || bw[0].length >= 5)) {
    const bi = initials(bt), ti = initials(tt);
    return bi && ti && bi !== ti ? 'WEAK' : 'STRONG';
  }
  if (bw.some((w) => w.length >= 3 && tw.includes(w))) return 'WEAK';
  return 'NONE';
}
const isStrong = (sc) => sc === 'EXACT' || sc === 'STRONG';
const RANK = { NONE: 0, WEAK: 1, STRONG: 2, EXACT: 3 };
const best = (a, b) => (RANK[b] > RANK[a] ? b : a);

/** Payer name / note / IFSC from the stored alert text (bank_credits.raw). */
function parseAlert(raw) {
  const m = s(raw).replace(/\s+/g, ' ').match(/UPI REF NO\s+\d+\s+P2[PM]-(.*?)-([^-]*)-([A-Z]{4}0[A-Z0-9]{6})-/i);
  return m ? { payerName: s(m[1]), note: s(m[2]), ifsc: s(m[3]).toUpperCase() } : { payerName: '', note: '', ifsc: '' };
}

// ---------------- data access ----------------
async function loadOrder(orderId) {
  const rows = await db.query('SELECT order_id, phone_norm, final_amount, status, source, order_type, created_at_sheet, raw_json FROM orders WHERE order_id = ? LIMIT 1', [s(orderId).toUpperCase()]);
  return rows[0] || null;
}
/** The browser that created the order (access token) or the order's phone number. */
function mayUse(o, proof) {
  const p = (proof && typeof proof === 'object') ? proof : { token: proof };
  const phone = norm(p.phone);
  if (phone && phone === s(o.phone_norm)) return true;
  const token = s(p.token); const hash = s(rawOf(o.raw_json).AccessTokenHash);
  return !!token && !!hash && crypto.createHash('sha256').update(token).digest('hex') === hash;
}
async function learnedNames(phone) {
  try { return (await db.query('SELECT name_norm FROM customer_payer_names WHERE phone_norm = ?', [phone])).map((r) => r.name_norm); }
  catch (e) { if (missingTable(e)) return []; throw e; }
}
async function learnName(phone, name) {
  const n = displayName(name); if (!phone || compactName(n).length < 2) return;
  try {
    await db.query('INSERT INTO customer_payer_names (phone_norm, name_norm, name_display, first_seen, last_used, times_used) VALUES (?, ?, ?, NOW(), NOW(), 1) ' +
      'ON DUPLICATE KEY UPDATE last_used = NOW(), times_used = times_used + 1', [phone, n.slice(0, 80), s(name).slice(0, 80)]);
  } catch (e) { console.log('[paymatch] could not save payer name:', e.message); }
}
const creditBelongsElsewhere = (c, oid) => { const ids = s(c.order_ids).toUpperCase().split(',').filter(Boolean); return ids.length > 0 && !ids.includes(oid); };
const creditView = (c, score) => ({ id: c.id, upiRef: c.upi_ref, amount: num(c.amount), receivedAt: c.received_at, payerName: parseAlert(c.raw).payerName, note: parseAlert(c.raw).note, score: score || 'NONE' });

async function setStatus(claim, status, reason, creditId, candidates) {
  if (claim.status === status && claim.reason === reason && (claim.credit_id || null) === (creditId || null)) return claim;
  await db.query("UPDATE payment_claims SET status = ?, reason = ?, credit_id = ?, candidates = ?, updated_at = NOW() WHERE id = ? AND status IN ('WAITING', 'REVIEW')",
    [status, s(reason).slice(0, 200), creditId || null, candidates ? JSON.stringify(candidates).slice(0, 4000) : null, claim.id]);
  return Object.assign(claim, { status, reason, credit_id: creditId || null });
}

/** Take the credit for the order (once, atomically) and mark the order paid. false = someone else took it first. */
async function takeCredit(orderId, credit) {
  const u = await db.query('UPDATE bank_credits SET consumed_order_id = ? WHERE id = ? AND consumed_order_id IS NULL', [orderId, credit.id]);
  if (!u || !u.affectedRows) return false;
  try {
    const r = await deps.markPaid(orderId, credit.upi_ref);
    if (r && r.ok === false) throw new Error(r.message || 'mark paid failed');
  } catch (e) {
    await db.query('UPDATE bank_credits SET consumed_order_id = NULL WHERE id = ? AND consumed_order_id = ?', [credit.id, orderId]).catch(() => {});
    throw e;
  }
  return true;
}

// ---------------- matching ----------------
/** Other open claims / pending orders a credit could also belong to (so we never pick between two people). */
async function someoneElseFits(credit, oid, cfg) {
  const bankName = parseAlert(credit.raw).payerName;
  const at = toDate(credit.received_at) || deps.now();
  const win = cfg.windowMin * 60e3;
  const claims = await db.query("SELECT order_id, payer_name FROM payment_claims WHERE status IN ('WAITING', 'REVIEW') AND order_id <> ? AND ROUND(amount) = ROUND(?) AND created_at BETWEEN ? AND ?",
    [oid, credit.amount, fmt(new Date(at.getTime() - win)), fmt(new Date(at.getTime() + win))]);
  if (claims.some((c) => isStrong(nameScore(bankName, c.payer_name)))) return true;
  if (!cfg.useLearnedNames) return false;
  const orders = await db.query("SELECT order_id, phone_norm FROM orders WHERE UPPER(status) = 'CREATED' AND source = 'node' AND order_id <> ? AND ROUND(final_amount) = ROUND(?) AND created_at_sheet BETWEEN ? AND ?",
    [oid, credit.amount, fmt(new Date(at.getTime() - 60 * 60e3)), fmt(new Date(at.getTime() + 2 * 60e3))]);
  for (const o of orders) {
    if ((await learnedNames(o.phone_norm)).some((n) => isStrong(nameScore(bankName, n)))) return true;
  }
  return false;
}

async function evaluate(claim, cfg) {
  cfg = cfg || await getSettings();
  if (!OPEN.includes(claim.status)) return claim;
  const oid = s(claim.order_id).toUpperCase();
  const o = await loadOrder(oid);
  if (!o) return setStatus(claim, 'REVIEW', 'Order not found');
  if (s(o.status).toUpperCase() === 'PAID') return setStatus(claim, 'MATCHED', 'Order was already paid');
  const amount = num(o.final_amount);
  const now = deps.now();
  const claimAt = toDate(claim.created_at) || now;
  const createdAt = toDate(o.created_at_sheet) || claimAt;

  // 1) UTR typed by the customer: exact reference + same amount.
  const utr = s(claim.utr).replace(/\D/g, '');
  if (utr) {
    const rows = await db.query('SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE upi_ref = ? LIMIT 1', [utr]);
    const c = rows[0];
    if (c) {
      if (c.consumed_order_id && s(c.consumed_order_id).toUpperCase() !== oid) return setStatus(claim, 'REVIEW', 'This UPI reference was already used for order ' + c.consumed_order_id, null, [creditView(c)]);
      if (creditBelongsElsewhere(c, oid)) return setStatus(claim, 'REVIEW', 'This payment\'s note has another order id (' + c.order_ids + ')', null, [creditView(c)]);
      if (Math.round(num(c.amount)) !== Math.round(amount)) return setStatus(claim, 'REVIEW', 'UPI reference found but the amount is ₹' + num(c.amount) + ' (order ₹' + amount + ')', null, [creditView(c)]);
      const rAt = toDate(c.received_at);
      if (rAt && rAt.getTime() < createdAt.getTime() - 10 * 60e3) return setStatus(claim, 'REVIEW', 'UPI reference is from before the order was made', null, [creditView(c)]);
      if (!cfg.autoAccept) return setStatus(claim, 'REVIEW', 'UPI reference matches (auto-accept is off)', null, [creditView(c, 'UTR')]);
      if (await takeCredit(oid, c)) {
        await learnName(o.phone_norm, claim.payer_name);
        return setStatus(claim, 'MATCHED', 'UPI reference ' + c.upi_ref + ' matched', c.id);
      }
      return setStatus(claim, 'REVIEW', 'That payment was just used by another order', null, [creditView(c)]);
    }
    // Not in the inbox yet (or mistyped): fall through to the name check, keep waiting.
  }

  // 2) Payer name + amount + time window.
  const win = cfg.windowMin * 60e3;
  const from = new Date(Math.max(createdAt.getTime() - 2 * 60e3, claimAt.getTime() - win));
  const to = new Date(claimAt.getTime() + win);
  const credits = (await db.query('SELECT id, upi_ref, amount, order_ids, raw, received_at FROM bank_credits WHERE consumed_order_id IS NULL AND ROUND(amount) = ROUND(?) AND received_at BETWEEN ? AND ? ORDER BY received_at',
    [amount, fmt(from), fmt(to)])).filter((c) => !creditBelongsElsewhere(c, oid));
  const learned = cfg.useLearnedNames ? await learnedNames(o.phone_norm) : [];
  const scored = credits.map((c) => {
    const bank = parseAlert(c.raw).payerName;
    let sc = nameScore(bank, claim.payer_name);
    for (const n of learned) sc = best(sc, nameScore(bank, n));
    if (s(c.order_ids).toUpperCase().split(',').includes(oid)) sc = 'EXACT'; // order id in the note after all
    return { c, sc };
  });
  const strong = scored.filter((x) => isStrong(x.sc));
  const views = scored.map((x) => creditView(x.c, x.sc));
  if (strong.length === 1) {
    const { c } = strong[0];
    if (await someoneElseFits(c, oid, cfg)) return setStatus(claim, 'REVIEW', 'Another customer could also match this payment', null, views);
    if (!cfg.autoAccept) return setStatus(claim, 'REVIEW', 'Name and amount match (auto-accept is off)', null, views);
    if (await takeCredit(oid, c)) {
      await learnName(o.phone_norm, claim.payer_name);
      const bank = parseAlert(c.raw).payerName; if (bank && compactName(bank) !== compactName(claim.payer_name)) await learnName(o.phone_norm, bank);
      return setStatus(claim, 'MATCHED', 'Name "' + bank + '" + amount matched (' + c.upi_ref + ')', c.id);
    }
    return setStatus(claim, 'REVIEW', 'That payment was just used by another order', null, views);
  }
  if (strong.length > 1) return setStatus(claim, 'REVIEW', strong.length + ' payments of ₹' + amount + ' match this name', null, views);
  if (scored.some((x) => x.sc === 'WEAK')) return setStatus(claim, 'REVIEW', 'A ₹' + amount + ' payment came in but the name only partly matches', null, views);
  if (now.getTime() - claimAt.getTime() > cfg.reviewAfterMin * 60e3) {
    return setStatus(claim, 'REVIEW', scored.length ? 'Payments of ₹' + amount + ' came in, but none from this name' : 'No ₹' + amount + ' payment found after ' + cfg.reviewAfterMin + ' min', null, views);
  }
  return setStatus(claim, 'WAITING', scored.length ? 'Waiting — other names only' : 'Waiting for the bank alert', null, views.length ? views : null);
}

// ---------------- public (storefront) ----------------
const PUBLIC = {
  WAITING: { status: 'WAITING', message: 'Looking for your payment… this usually takes 1–2 minutes.' },
  REVIEW: { status: 'REVIEW', message: 'Thanks! The FluxFilm team will check your payment by hand and activate your plan. You don\'t need to pay again.' },
  MATCHED: { status: 'MATCHED', paid: true, message: '✅ Payment found!' },
  APPROVED: { status: 'MATCHED', paid: true, message: '✅ Payment confirmed by FluxFilm!' },
  REJECTED: { status: 'REJECTED', message: 'We could not find this payment. If money was deducted, please send a screenshot on WhatsApp support.' },
};
const publicOf = (claim) => Object.assign({ ok: true, claimId: claim.id, payerName: claim.payer_name }, PUBLIC[claim.status] || PUBLIC.WAITING);
const UNAVAILABLE = { ok: false, unavailable: true, message: 'This option isn\'t available right now. If you already paid, please send the payment screenshot on WhatsApp support.' };

async function getBackupPayment(orderId, proof) {
  const cfg = await getSettings();
  const o = await loadOrder(orderId);
  if (!o || s(o.source) !== 'node') return { ok: false, message: 'Order not found.' };
  if (!mayUse(o, proof)) return { ok: false, message: 'Please open this order on the phone number you used to buy.' };
  if (!cfg.enabled) return Object.assign({ enabled: false }, UNAVAILABLE);
  const amount = num(o.final_amount);
  let last = null;
  try { const rows = await db.query('SELECT id, order_id, payer_name, status, reason, created_at FROM payment_claims WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.order_id]); if (rows[0] && rows[0].status !== 'REPLACED') last = publicOf(rows[0]); } catch (e) { if (!missingTable(e)) throw e; }
  return {
    ok: true, enabled: true, orderId: o.order_id, amount, paid: s(o.status).toUpperCase() === 'PAID',
    vpa: cfg.backupVpa, payee: cfg.backupPayee, qrImage: await getQr(),
    // No amount / note in the backup link: those are what some apps refuse. The customer types the amount.
    upiLink: 'upi://pay?pa=' + encodeURIComponent(cfg.backupVpa) + '&pn=' + encodeURIComponent(cfg.backupPayee) + '&cu=INR',
    lastClaim: last,
  };
}

async function claimPayment(orderId, proof, payerName, utr) {
  const cfg = await getSettings();
  if (!cfg.enabled) return UNAVAILABLE;
  const name = displayName(payerName);
  if (compactName(name).length < 2) return { ok: false, field: 'name', message: 'Please type your name exactly as it shows in your UPI app.' };
  if (name.length > 60) return { ok: false, field: 'name', message: 'That name is too long — please type it as shown in your UPI app.' };
  const ref = s(utr).replace(/\D/g, '');
  if (ref && (ref.length < 10 || ref.length > 16)) return { ok: false, field: 'utr', message: 'The UPI reference / UTR number is usually 12 digits. Please check it, or leave it empty.' };
  const o = await loadOrder(orderId);
  if (!o || s(o.source) !== 'node') return { ok: false, message: 'Order not found.' };
  if (!mayUse(o, proof)) return { ok: false, message: 'Please open this order on the phone number you used to buy.' };
  if (s(o.status).toUpperCase() === 'PAID') return { ok: true, status: 'MATCHED', paid: true, message: '✅ This order is already paid.' };
  try {
    const prior = await db.query('SELECT id, order_id, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE order_id = ? ORDER BY id DESC', [o.order_id]);
    if (prior.length >= cfg.maxClaimsPerOrder) {
      const open = prior.find((p) => p.status !== 'REPLACED') || prior[0];
      return Object.assign(publicOf(open), { ok: false, tooMany: true, message: 'We already have your payment details for this order — the FluxFilm team will check them. For help, WhatsApp support.' });
    }
    // A corrected claim (e.g. a typo in the name) replaces the older open one.
    await db.query("UPDATE payment_claims SET status = 'REPLACED', updated_at = NOW() WHERE order_id = ? AND status IN ('WAITING', 'REVIEW')", [o.order_id]);
    const createdAt = fmt(deps.now());
    const ins = await db.query("INSERT INTO payment_claims (order_id, phone_norm, amount, payer_name, utr, status, reason, source, created_at) VALUES (?, ?, ?, ?, ?, 'WAITING', '', 'CUSTOMER', ?)",
      [o.order_id, o.phone_norm, num(o.final_amount), name, ref || null, createdAt]);
    const claim = { id: ins.insertId, order_id: o.order_id, payer_name: name, utr: ref || null, status: 'WAITING', reason: '', credit_id: null, created_at: createdAt };
    return publicOf(await evaluate(claim, cfg));
  } catch (e) {
    if (missingTable(e)) return UNAVAILABLE;
    throw e;
  }
}

const lastEval = new Map();
async function getClaimStatus(orderId, proof) {
  const o = await loadOrder(orderId);
  if (!o || s(o.source) !== 'node') return { ok: false, message: 'Order not found.' };
  if (!mayUse(o, proof)) return { ok: false, message: 'Please open this order on the phone number you used to buy.' };
  let rows;
  try { rows = await db.query("SELECT id, order_id, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE order_id = ? AND status <> 'REPLACED' ORDER BY id DESC LIMIT 1", [o.order_id]); }
  catch (e) { if (missingTable(e)) return UNAVAILABLE; throw e; }
  const claim = rows[0];
  if (s(o.status).toUpperCase() === 'PAID') return Object.assign({ ok: true, status: 'MATCHED', paid: true, message: '✅ Payment found!' }, claim ? { claimId: claim.id } : {});
  if (!claim) return { ok: true, status: 'NONE' };
  // Re-check on the customer's poll, at most every 4 s per order (the bank-mail hook also re-checks).
  if (OPEN.includes(claim.status) && Date.now() - (lastEval.get(claim.id) || 0) > 4000) {
    lastEval.set(claim.id, Date.now());
    if (lastEval.size > 5000) lastEval.clear();
    await evaluate(claim);
  }
  return publicOf(claim);
}

/**
 * verifyPayment hook: an order paid to the plain QR by a customer whose payer name we already know
 * (from an earlier confirmed payment) is matched without the customer filling anything in.
 */
async function autoMatchLearned(orderId) {
  const cfg = await getSettings();
  if (!cfg.enabled || !cfg.autoAccept || !cfg.useLearnedNames) return null;
  const o = await loadOrder(orderId);
  if (!o || s(o.source) !== 'node' || s(o.status).toUpperCase() !== 'CREATED') return null;
  const names = await learnedNames(o.phone_norm);
  if (!names.length) return null;
  const oid = o.order_id; const createdAt = toDate(o.created_at_sheet) || deps.now();
  try {
    const credits = (await db.query('SELECT id, upi_ref, amount, order_ids, raw, received_at FROM bank_credits WHERE consumed_order_id IS NULL AND ROUND(amount) = ROUND(?) AND received_at BETWEEN ? AND ?',
      [o.final_amount, fmt(new Date(createdAt.getTime() - 2 * 60e3)), fmt(new Date(createdAt.getTime() + 60 * 60e3))])).filter((c) => !creditBelongsElsewhere(c, oid));
    const strong = credits.filter((c) => names.some((n) => isStrong(nameScore(parseAlert(c.raw).payerName, n))));
    if (strong.length !== 1) return null;
    const c = strong[0];
    if (await someoneElseFits(c, oid, cfg)) return null;
    if (!(await takeCredit(oid, c))) return null;
    const bank = parseAlert(c.raw).payerName;
    await learnName(o.phone_norm, bank);
    await db.query("INSERT INTO payment_claims (order_id, phone_norm, amount, payer_name, utr, status, reason, credit_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'MATCHED', ?, ?, 'LEARNED', ?, NOW())",
      [oid, o.phone_norm, num(o.final_amount), displayName(bank), ('Known payer name "' + bank + '" + amount matched (' + c.upi_ref + ')').slice(0, 200), c.id, fmt(deps.now())]).catch((e) => console.log('[paymatch] audit row failed:', e.message));
    return { ok: true, paid: true, creditId: c.id };
  } catch (e) { if (missingTable(e)) return null; throw e; }
}

/** Re-check open claims + recent unpaid orders of known payers. Called when bank mail lands and every minute. */
let sweeping = false;
async function sweep() {
  if (sweeping) return { ok: true, skipped: true };
  sweeping = true;
  const out = { ok: true, checked: 0, matched: 0, learned: 0 };
  try {
    const cfg = await getSettings();
    if (!cfg.enabled) return out;
    let claims = [];
    try { claims = await db.query("SELECT id, order_id, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE status IN ('WAITING', 'REVIEW') AND source = 'CUSTOMER' AND created_at > ? ORDER BY id LIMIT 100", [fmt(new Date(deps.now().getTime() - 86400e3))]); }
    catch (e) { if (missingTable(e)) return Object.assign(out, { needsSchema: true }); throw e; }
    for (const c of claims) {
      try { const r = await evaluate(c, cfg); out.checked++; if (r.status === 'MATCHED') out.matched++; }
      catch (e) { console.log('[paymatch] claim', c.id, 'check failed:', e.message); }
    }
    if (cfg.useLearnedNames && cfg.autoAccept) {
      const orders = await db.query("SELECT o.order_id FROM orders o WHERE UPPER(o.status) = 'CREATED' AND o.source = 'node' AND o.created_at_sheet > ? AND EXISTS (SELECT 1 FROM customer_payer_names n WHERE n.phone_norm = o.phone_norm) LIMIT 50", [fmt(new Date(deps.now().getTime() - 60 * 60e3))]).catch((e) => { if (missingTable(e)) return []; throw e; });
      for (const r of orders) {
        try { if (await autoMatchLearned(r.order_id)) out.learned++; } catch (e) { console.log('[paymatch] learned match failed:', r.order_id, e.message); }
      }
    }
    return out;
  } finally { sweeping = false; }
}
let timer = null;
function startTimer() {
  if (timer) return;
  timer = setInterval(() => { sweep().then((r) => { if (r.matched || r.learned) console.log('[paymatch]', JSON.stringify(r)); }).catch((e) => console.log('[paymatch] sweep failed:', e.message)); }, 60e3);
  if (timer.unref) timer.unref();
}

// ---------------- admin ----------------
async function schemaReady() {
  try { await db.query('SELECT 1 FROM payment_claims LIMIT 1', []); await db.query('SELECT 1 FROM customer_payer_names LIMIT 1', []); return true; }
  catch (e) { if (missingTable(e)) return false; throw e; }
}
async function listClaims(opts) {
  opts = opts || {};
  const which = s(opts.status).toUpperCase() || 'OPEN';
  const where = which === 'ALL' ? "c.status <> 'REPLACED'" : which === 'OPEN' ? "c.status IN ('WAITING', 'REVIEW')" : 'c.status = ?';
  const params = which === 'ALL' || which === 'OPEN' ? [] : [which];
  let rows;
  try {
    rows = await db.query('SELECT c.id, c.order_id, c.phone_norm, c.amount, c.payer_name, c.utr, c.status, c.reason, c.credit_id, c.candidates, c.source, c.created_at, c.updated_at, c.decided_at, c.admin_note, ' +
      'o.service, o.plan, o.status order_status, o.created_at_sheet order_created, cu.name customer_name FROM payment_claims c LEFT JOIN orders o ON o.order_id = c.order_id LEFT JOIN customers cu ON cu.phone_norm = c.phone_norm ' +
      'WHERE ' + where + ' ORDER BY FIELD(c.status, \'REVIEW\', \'WAITING\') DESC, c.id DESC LIMIT 60', params);
  } catch (e) { if (missingTable(e)) return { ok: true, needsSchema: true, claims: [], counts: {} }; throw e; }
  const claims = [];
  for (const r of rows) {
    const item = Object.assign({}, r, { candidates: undefined, amount: num(r.amount) });
    if (OPEN.includes(r.status)) {
      // Fresh list for the owner: unused credits of this amount from 1 h before to 24 h after the claim.
      const at = toDate(r.created_at) || deps.now();
      const credits = await db.query('SELECT id, upi_ref, amount, order_ids, raw, received_at FROM bank_credits WHERE consumed_order_id IS NULL AND ROUND(amount) = ROUND(?) AND received_at BETWEEN ? AND ? ORDER BY received_at DESC LIMIT 10',
        [r.amount, fmt(new Date(at.getTime() - 60 * 60e3)), fmt(new Date(at.getTime() + 24 * 3600e3))]);
      item.options = credits.map((c) => creditView(c, nameScore(parseAlert(c.raw).payerName, r.payer_name))).sort((a, b) => RANK[b.score] - RANK[a.score]);
    }
    claims.push(item);
  }
  const cnt = await db.query("SELECT status, COUNT(*) n FROM payment_claims WHERE status IN ('WAITING', 'REVIEW') GROUP BY status", []);
  const counts = {}; for (const c of cnt) counts[c.status] = num(c.n);
  return { ok: true, claims, counts };
}

async function loadClaim(id) {
  const rows = await db.query('SELECT id, order_id, phone_norm, amount, payer_name, utr, status, reason, credit_id, created_at FROM payment_claims WHERE id = ? LIMIT 1', [Number(id) || 0]);
  return rows[0] || null;
}
/** creditId = the bank payment the owner picked; none = the owner checked the bank app and confirms by hand. */
async function approveClaim(id, creditId, note) {
  const claim = await loadClaim(id);
  if (!claim) return { ok: false, message: 'Claim not found.' };
  if (!OPEN.includes(claim.status)) return { ok: false, message: 'This claim is already ' + claim.status.toLowerCase() + '.' };
  const o = await loadOrder(claim.order_id);
  if (!o) return { ok: false, message: 'Order not found.' };
  let credit = null;
  if (creditId) {
    const rows = await db.query('SELECT id, upi_ref, amount, order_ids, raw, received_at, consumed_order_id FROM bank_credits WHERE id = ? LIMIT 1', [Number(creditId) || 0]);
    credit = rows[0];
    if (!credit) return { ok: false, message: 'Bank payment not found.' };
    if (credit.consumed_order_id) return { ok: false, message: 'That bank payment is already used for order ' + credit.consumed_order_id + '.' };
    if (Math.round(num(credit.amount)) !== Math.round(num(o.final_amount))) return { ok: false, message: 'Amount differs: payment ₹' + num(credit.amount) + ', order ₹' + num(o.final_amount) + '.' };
    if (!(await takeCredit(o.order_id, credit))) return { ok: false, message: 'That bank payment was just used by another order.' };
  } else if (s(o.status).toUpperCase() !== 'PAID') {
    const r = await deps.markPaid(o.order_id, 'MANUAL-REVIEW-' + claim.id);
    if (r && r.ok === false) return r;
  }
  await db.query("UPDATE payment_claims SET status = 'APPROVED', credit_id = ?, admin_note = ?, decided_at = NOW(), updated_at = NOW() WHERE id = ? AND status IN ('WAITING', 'REVIEW')", [credit ? credit.id : null, s(note).slice(0, 200), claim.id]);
  await learnName(claim.phone_norm, claim.payer_name);
  if (credit) { const bank = parseAlert(credit.raw).payerName; if (bank && compactName(bank) !== compactName(claim.payer_name)) await learnName(claim.phone_norm, bank); }
  return { ok: true, orderId: o.order_id, creditId: credit ? credit.id : null, upiRef: credit ? credit.upi_ref : null, amount: num(o.final_amount) };
}
async function rejectClaim(id, note) {
  const claim = await loadClaim(id);
  if (!claim) return { ok: false, message: 'Claim not found.' };
  if (!OPEN.includes(claim.status)) return { ok: false, message: 'This claim is already ' + claim.status.toLowerCase() + '.' };
  await db.query("UPDATE payment_claims SET status = 'REJECTED', admin_note = ?, decided_at = NOW(), updated_at = NOW() WHERE id = ? AND status IN ('WAITING', 'REVIEW')", [s(note).slice(0, 200), claim.id]);
  return { ok: true, orderId: claim.order_id };
}

module.exports = {
  DEFAULTS, validateSettings, getSettings, saveSettings, getQr, saveQr,
  nameScore, displayName, parseAlert,
  getBackupPayment, claimPayment, getClaimStatus, autoMatchLearned, sweep, startTimer,
  schemaReady, listClaims, approveClaim, rejectClaim,
  _internal: { deps, evaluate, fmt, reset: () => { cache = null; qrCache = null; lastEval.clear(); } },
};
