/**
 * FluxFilm - loyalty coins on MySQL: earning (on fulfilment + Refer & earn), and spending at checkout.
 * All rules are edited in the admin panel (🪙 Coins) and stored in app_settings['coins'] - no Hostinger env.
 *
 * Earning : floor(amount/100 × earnPer100) × new/renew multiplier (p.coins = a fixed reward). Idempotent per
 *           (order_id, event) via coins_ledger.
 * Spending: holdSpend() takes coins when an order is created (coin_spends HELD, ledger SPEND −coins);
 *           onOrderPaid() keeps them (SPENT); releaseSpend() gives them back (RELEASED, ledger SPEND_RELEASE)
 *           when the order is never paid (holdHours) or the customer starts another order with coins.
 *           Paying an order whose hold was already released takes the coins again (balance may go negative).
 *
 * Every balance change runs in one transaction that first locks the customer's wallet row, so parallel changes
 * for the same person can't overwrite each other or pass the "already done?" checks twice. A customer can have
 * several wallet rows (old Sheet phone formats); the one with the most lifetime coins is the live one.
 */
const db = require('./db');

const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const WALLET_ORDER = 'ORDER BY coins_lifetime DESC, coins_balance DESC';
const SETTINGS_KEY = 'coins';

// ---------------- settings ----------------
const envNum = (k, d) => { const v = asNum(process.env[k]); return process.env[k] != null && process.env[k] !== '' ? v : d; };
function defaults() {
  return {
    earnEnabled: true, earnPer100: envNum('COINS_PER_100', 5), earnNewMultiplier: envNum('COINS_NEW_MULTIPLIER', 1), earnRenewMultiplier: envNum('COINS_RENEW_MULTIPLIER', 1), earnMinOrder: envNum('COINS_MIN_ORDER_AMOUNT', 0),
    spendEnabled: true, spendOnNew: true, spendOnRenew: true, coinValue: 1, maxPercent: 20, minCoins: 20, holdHours: 24,
  };
}
const NUMBER_RULES = [
  ['earnPer100', 0, 1000, 2], ['earnNewMultiplier', 0, 20, 2], ['earnRenewMultiplier', 0, 20, 2], ['earnMinOrder', 0, 100000, 0],
  ['coinValue', 0.01, 100, 2], ['maxPercent', 0, 100, 2], ['minCoins', 0, 100000, 0], ['holdHours', 1, 168, 0],
];
const BOOL_KEYS = ['earnEnabled', 'spendEnabled', 'spendOnNew', 'spendOnRenew'];
function validateSettings(input) {
  const d = defaults(); const inb = input || {}; const out = {}; const errors = [];
  for (const [k, lo, hi, dp] of NUMBER_RULES) {
    const v = inb[k] === undefined || inb[k] === '' ? d[k] : Number(inb[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(k + ' must be a number between ' + lo + ' and ' + hi + '.');
    else out[k] = Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp);
  }
  for (const k of BOOL_KEYS) { const v = inb[k]; out[k] = v === undefined ? d[k] : (v === true || v === 1 || String(v).toLowerCase() === 'true'); }
  return { ok: !errors.length, settings: Object.assign({}, d, out), errors };
}
let cache = null; let cacheAt = 0;
async function getSettings(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 30e3) return cache;
  let saved = {}; let ready = true;
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
    if (rows.length) { try { saved = JSON.parse(rows[0].value) || {}; } catch (_) { saved = {}; } }
  } catch (e) { if (!missingTable(e)) throw e; ready = false; }
  cache = Object.assign(validateSettings(saved).settings, { settingsReady: ready });
  cacheAt = Date.now();
  return cache;
}
async function saveSettings(input) {
  const v = validateSettings(input);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  try {
    await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTINGS_KEY, JSON.stringify(v.settings)]);
  } catch (e) {
    if (missingTable(e)) return { ok: false, needsSchema: true, message: 'Run db/schema-v15.sql in phpMyAdmin first.' };
    throw e;
  }
  cache = null;
  return { ok: true, settings: v.settings };
}

// ---------------- earning ----------------
function computeCoins(event, amount, cfg) {
  const c = cfg || defaults();
  if (c.earnEnabled === false) return 0;
  const amt = asNum(amount);
  if (amt < asNum(c.earnMinOrder)) return 0;
  const per100 = asNum(c.earnPer100);
  if (per100 <= 0) return 0;
  const base = Math.floor((amt / 100) * per100);
  const mult = String(event || '').toUpperCase().indexOf('RENEW') !== -1 ? asNum(c.earnRenewMultiplier) : asNum(c.earnNewMultiplier);
  return Math.max(0, Math.floor(base * mult));
}

// Locks this customer's wallet row (created if missing) on a connection that is already inside a transaction.
async function lockWalletOn(conn, ph) {
  const lock = () => conn.query('SELECT phone, coins_balance FROM wallet WHERE phone_norm = ? ' + WALLET_ORDER + ' LIMIT 1 FOR UPDATE', [ph]);
  let [w] = await lock();
  if (!w.length) {
    await conn.query('INSERT IGNORE INTO wallet (phone, phone_norm, coins_balance, coins_lifetime) VALUES (?, ?, 0, 0)', [ph, ph]);
    [w] = await lock();
  }
  if (!w.length) throw new Error('wallet row could not be created');
  return { phone: w[0].phone, balance: asNum(w[0].coins_balance) };
}

// Runs fn(conn, wallet) inside a transaction holding the lock on this customer's wallet row (created if missing).
async function withWallet(ph, fn) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn, await lockWalletOn(conn, ph));
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally { conn.release(); }
}
const ledger = (conn, row) => conn.query(
  'INSERT INTO coins_ledger (ts, event, order_id, phone_norm, service, plan, amount, coins_delta, balance_after, note) VALUES (NOW(),?,?,?,?,?,?,?,?,?)',
  [row.event, s(row.orderId).slice(0, 20), row.phone, s(row.service).slice(0, 60), s(row.plan).slice(0, 80), asNum(row.amount), row.delta, row.balanceAfter, s(row.note).slice(0, 200)]);

async function awardCoins(payload) {
  const p = payload || {};
  const event = String(p.event || 'NEW_PURCHASE');
  const oid = String(p.orderId || '').trim();
  const ph = norm(p.phone);
  if (!ph || !oid) return { ok: false, skipped: 'missing phone/order' };
  // p.coins = a fixed reward (e.g. Refer & earn); otherwise earn from the order amount.
  const coins = p.coins != null ? Math.max(0, Math.floor(asNum(p.coins))) : computeCoins(event, p.amount, await getSettings());
  if (coins <= 0) return { ok: true, coins: 0 };
  const lastEvent = (event + ':' + oid).slice(0, 150);
  return withWallet(ph, async (conn, w) => {
    // idempotent — never award twice for the same order+event (checked while holding the wallet lock)
    const [dup] = await conn.query('SELECT id FROM coins_ledger WHERE order_id = ? AND event = ? LIMIT 1', [oid, event]);
    if (dup.length) return { ok: true, already: true };
    const newBal = w.balance + coins;
    await conn.query('UPDATE wallet SET coins_balance = coins_balance + ?, coins_lifetime = coins_lifetime + ?, last_earned_at = NOW(), last_event = ? WHERE phone = ?', [coins, coins, lastEvent, w.phone]);
    await ledger(conn, { event, orderId: oid, phone: ph, service: p.service, plan: p.plan, amount: p.amount, delta: coins, balanceAfter: newBal, note: p.note });
    return { ok: true, coins, balanceAfter: newBal };
  });
}

// ---------------- spending ----------------
// How many coins may pay for an order of `amount` (₹, after other discounts). kind = 'NEW' | 'RENEW'.
function spendAllowed(cfg, balance, amount, kind) {
  if (!cfg.spendEnabled) return { coins: 0, rupees: 0, reason: 'off' };
  if (String(kind).toUpperCase() === 'RENEW' ? !cfg.spendOnRenew : !cfg.spendOnNew) return { coins: 0, rupees: 0, reason: String(kind).toUpperCase() === 'RENEW' ? 'not on renewals' : 'not on new orders' };
  const bal = Math.floor(Math.max(0, asNum(balance)));
  const maxRupees = Math.floor(Math.max(0, asNum(amount)) * asNum(cfg.maxPercent) / 100);
  const value = asNum(cfg.coinValue) || 1;
  const coins = Math.min(bal, Math.floor(maxRupees / value + 1e-9));
  if (bal < cfg.minCoins) return { coins: 0, rupees: 0, reason: 'min', needed: cfg.minCoins };
  if (coins <= 0) return { coins: 0, rupees: 0, reason: 'amount' };
  const rupees = Math.floor(coins * value + 1e-9);
  if (rupees <= 0) return { coins: 0, rupees: 0, reason: 'amount' };
  return { coins: Math.ceil(rupees / value - 1e-9), rupees };
}

// Storefront preview: "Use 45 coins → −₹45" (the server re-checks when the order is created).
async function quoteSpend(phone, amount, kind) {
  const ph = norm(phone);
  const cfg = await getSettings();
  if (!ph) return { ok: false, message: 'Phone required.' };
  let spendsReady = true;
  try { await db.query('SELECT 1 FROM coin_spends LIMIT 1', []); } catch (e) { if (!missingTable(e)) throw e; spendsReady = false; }
  const w = await db.query('SELECT coins_balance FROM wallet WHERE phone_norm = ? ' + WALLET_ORDER + ' LIMIT 1', [ph]);
  const balance = Math.floor(asNum((w[0] || {}).coins_balance));
  const rules = { coinValue: cfg.coinValue, maxPercent: cfg.maxPercent, minCoins: cfg.minCoins, spendOnNew: cfg.spendOnNew, spendOnRenew: cfg.spendOnRenew };
  if (!spendsReady || !cfg.settingsReady) return { ok: true, enabled: false, balance, coins: 0, rupees: 0, rules, reason: 'coming soon' };
  const a = spendAllowed(cfg, balance, amount, kind);
  return { ok: true, enabled: !!cfg.spendEnabled, balance, coins: a.coins, rupees: a.rupees, reason: a.reason || '', rules };
}

// Take coins for a new order (inside the wallet lock). Older unpaid orders' holds for this phone are released first,
// so a customer who abandons an order and tries again never has their coins stuck.
async function holdSpend({ phone, orderId, amount, kind, service, plan }) {
  const ph = norm(phone); const oid = s(orderId);
  if (!ph || !oid) return { ok: false, message: 'missing phone/order' };
  const cfg = await getSettings(true);
  try {
    return await withWallet(ph, async (conn, w) => {
      let balance = w.balance;
      const [old] = await conn.query(
        "SELECT cs.order_id, cs.coins FROM coin_spends cs LEFT JOIN orders o ON o.order_id = cs.order_id WHERE cs.phone_norm = ? AND cs.status = 'HELD' AND (o.order_id IS NULL OR UPPER(o.status) <> 'PAID')", [ph]);
      for (const h of old) {
        balance += asNum(h.coins);
        await conn.query('UPDATE wallet SET coins_balance = coins_balance + ? WHERE phone = ?', [asNum(h.coins), w.phone]);
        await conn.query("UPDATE coin_spends SET status = 'RELEASED', note = ?, updated_at = NOW() WHERE order_id = ? AND status = 'HELD'", ['released: new order ' + oid, h.order_id]);
        await ledger(conn, { event: 'SPEND_RELEASE', orderId: h.order_id, phone: ph, delta: asNum(h.coins), balanceAfter: balance, note: 'Coins back: new order ' + oid });
      }
      const a = spendAllowed(cfg, balance, amount, kind);
      if (a.coins <= 0) return { ok: false, coins: 0, rupees: 0, reason: a.reason, balance, message: a.reason === 'min' ? 'You need at least ' + cfg.minCoins + ' coins to use them.' : 'Coins can\'t be used on this order.' };
      const after = balance - a.coins;
      await conn.query('UPDATE wallet SET coins_balance = coins_balance - ?, last_spent_at = NOW(), last_event = ? WHERE phone = ?', [a.coins, ('SPEND:' + oid).slice(0, 150), w.phone]);
      await conn.query("INSERT INTO coin_spends (order_id, phone_norm, coins, rupees, status, created_at) VALUES (?, ?, ?, ?, 'HELD', NOW())", [oid, ph, a.coins, a.rupees]);
      await ledger(conn, { event: 'SPEND', orderId: oid, phone: ph, service, plan, amount, delta: -a.coins, balanceAfter: after, note: 'Used ' + a.coins + ' coins = ₹' + a.rupees + ' off' });
      return { ok: true, coins: a.coins, rupees: a.rupees, balanceAfter: after };
    });
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true, message: 'Coins can\'t be used yet.' };
    throw e;
  }
}

async function releaseSpend(orderId, reason) {
  const rows = await db.query("SELECT order_id, phone_norm, coins FROM coin_spends WHERE order_id = ? AND status = 'HELD' LIMIT 1", [s(orderId)]);
  if (!rows.length) return { ok: true, skipped: 'no hold' };
  const r = rows[0];
  return withWallet(r.phone_norm, async (conn, w) => {
    const [upd] = await conn.query("UPDATE coin_spends SET status = 'RELEASED', note = ?, updated_at = NOW() WHERE order_id = ? AND status = 'HELD'", [s(reason).slice(0, 200), r.order_id]);
    if (!upd || !upd.affectedRows) return { ok: true, skipped: 'already handled' };
    await conn.query('UPDATE wallet SET coins_balance = coins_balance + ? WHERE phone = ?', [asNum(r.coins), w.phone]);
    await ledger(conn, { event: 'SPEND_RELEASE', orderId: r.order_id, phone: r.phone_norm, delta: asNum(r.coins), balanceAfter: w.balance + asNum(r.coins), note: 'Coins back: ' + s(reason) });
    return { ok: true, released: asNum(r.coins) };
  });
}

// The order was paid: keep the coins. If the hold had been released meanwhile, take them again.
async function onOrderPaid(orderId) {
  let rows;
  try { rows = await db.query("SELECT order_id, phone_norm, coins, status FROM coin_spends WHERE order_id = ? AND status IN ('HELD', 'RELEASED') LIMIT 1", [s(orderId)]); } catch (e) { if (missingTable(e)) return { ok: true, skipped: 'no table' }; throw e; }
  if (!rows.length) return { ok: true, skipped: 'no coins on this order' };
  const r = rows[0];
  const wasReleased = String(r.status) === 'RELEASED';
  const fromStatus = wasReleased ? 'RELEASED' : 'HELD';
  return withWallet(r.phone_norm, async (conn, w) => {
    const [upd] = await conn.query("UPDATE coin_spends SET status = 'SPENT', note = ?, updated_at = NOW() WHERE order_id = ? AND status = ?", [wasReleased ? 'paid after coins were given back: taken again' : null, r.order_id, fromStatus]);
    if (!upd || !upd.affectedRows) return { ok: true, skipped: 'already handled' };
    if (wasReleased) {
      await conn.query('UPDATE wallet SET coins_balance = coins_balance - ?, last_spent_at = NOW() WHERE phone = ?', [asNum(r.coins), w.phone]);
      await ledger(conn, { event: 'SPEND', orderId: r.order_id, phone: r.phone_norm, delta: -asNum(r.coins), balanceAfter: w.balance - asNum(r.coins), note: 'Order paid after coins were given back' });
      return { ok: true, status: 'SPENT', retaken: asNum(r.coins) };
    }
    return { ok: true, status: 'SPENT' };
  });
}

// Every few minutes: give back coins on orders not paid within holdHours, and settle paid orders still HELD.
async function maintain() {
  const cfg = await getSettings(true);
  const out = { released: 0, settled: 0 };
  try {
    const expired = await db.query(
      "SELECT cs.order_id FROM coin_spends cs LEFT JOIN orders o ON o.order_id = cs.order_id WHERE cs.status = 'HELD' AND cs.created_at < NOW() - INTERVAL ? HOUR AND (o.order_id IS NULL OR UPPER(o.status) <> 'PAID') LIMIT 200", [cfg.holdHours]);
    for (const x of expired) { const r = await releaseSpend(x.order_id, 'order not paid within ' + cfg.holdHours + 'h'); if (r.released) out.released++; }
    const paid = await db.query("SELECT cs.order_id FROM coin_spends cs JOIN orders o ON o.order_id = cs.order_id WHERE cs.status IN ('HELD', 'RELEASED') AND UPPER(o.status) = 'PAID' LIMIT 200", []);
    for (const x of paid) { const r = await onOrderPaid(x.order_id); if (r.status) out.settled++; }
    return Object.assign({ ok: true }, out);
  } catch (e) {
    if (missingTable(e)) return { ok: true, skipped: 'no table' };
    throw e;
  }
}
let timer = null;
function startTimer() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () => maintain().then((r) => { if (r && (r.released || r.settled)) console.log('[coins] maintain', JSON.stringify(r)); }).catch((e) => console.log('[coins] maintain failed:', e.message));
  setTimeout(run, 60e3).unref();
  timer = setInterval(run, 10 * 60e3); timer.unref();
}

// Admin: add or remove coins by hand (never below 0). Logged in coins_ledger as ADMIN_ADJUST.
async function adjust({ phone, delta, reason }) {
  const ph = norm(phone); const d = Math.round(asNum(delta));
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter a 10-digit phone number.' };
  if (!d) return { ok: false, message: 'Enter how many coins to add (e.g. 50) or remove (e.g. -50).' };
  if (!s(reason)) return { ok: false, message: 'Write a short reason (it goes in the coins history).' };
  return withWallet(ph, async (conn, w) => {
    const change = d < 0 ? -Math.min(-d, Math.max(0, Math.floor(w.balance))) : d;
    if (!change) return { ok: false, message: 'This customer has no coins to remove.' };
    const after = w.balance + change;
    await conn.query('UPDATE wallet SET coins_balance = coins_balance + ?, coins_lifetime = coins_lifetime + ?, last_event = ? WHERE phone = ?', [change, change > 0 ? change : 0, 'ADMIN_ADJUST', w.phone]);
    await ledger(conn, { event: 'ADMIN_ADJUST', orderId: 'ADJ' + Date.now().toString().slice(-12), phone: ph, delta: change, balanceAfter: after, note: s(reason) });
    return { ok: true, change, balanceAfter: after };
  });
}

// ---------------- refunded / erased orders (admin order actions) ----------------
// Both run on the caller's connection INSIDE its transaction, so the order's new state and the coins change
// commit together or not at all. Both are idempotent (safe to run again on the same order).

// An order is refunded or erased: give back coins used on it (HELD or SPENT → RELEASED) and take back coins earned
// on it (fulfilment awards NEW_PURCHASE / RENEW, e.g. manual plans). Earned coins are never taken below 0; what could
// not be taken is reported as `reverseShort`.
async function undoOrderCoinsOn(conn, orderId, phone, reason) {
  const oid = s(orderId); const why = s(reason) || 'order cancelled';
  const out = { returned: 0, reversed: 0, reverseShort: 0 };
  if (!oid) return out;
  let spend = null;
  try {
    const [rows] = await conn.query("SELECT order_id, phone_norm, coins, status FROM coin_spends WHERE order_id = ? AND status IN ('HELD', 'SPENT') LIMIT 1 FOR UPDATE", [oid]);
    spend = rows[0] || null;
  } catch (e) { if (!missingTable(e)) throw e; }
  const [earnRows] = await conn.query("SELECT event, phone_norm, coins_delta FROM coins_ledger WHERE order_id = ? AND event IN ('NEW_PURCHASE', 'RENEW', 'EARN_REVERSE')", [oid]);
  const alreadyReversed = earnRows.some((r) => s(r.event) === 'EARN_REVERSE');
  const earned = alreadyReversed ? 0 : earnRows.filter((r) => s(r.event) !== 'EARN_REVERSE').reduce((n, r) => n + Math.max(0, asNum(r.coins_delta)), 0);
  const earnPhone = (earnRows.find((r) => s(r.event) !== 'EARN_REVERSE') || {}).phone_norm;
  if (!spend && earned <= 0) return out;
  const ph = norm((spend && spend.phone_norm) || earnPhone || phone);
  if (!ph) return out;
  const w = await lockWalletOn(conn, ph);
  let bal = w.balance;
  if (spend) {
    const [upd] = await conn.query("UPDATE coin_spends SET status = 'RELEASED', note = ?, updated_at = NOW() WHERE order_id = ? AND status = ?", [why.slice(0, 200), oid, spend.status]);
    if (upd && upd.affectedRows) {
      const c = asNum(spend.coins); bal += c;
      await conn.query('UPDATE wallet SET coins_balance = coins_balance + ? WHERE phone = ?', [c, w.phone]);
      await ledger(conn, { event: 'SPEND_RELEASE', orderId: oid, phone: ph, delta: c, balanceAfter: bal, note: 'Coins back: ' + why });
      out.returned = c;
    }
  }
  if (earned > 0) {
    const take = Math.min(earned, Math.max(0, Math.floor(bal)));
    bal -= take;
    if (take) await conn.query('UPDATE wallet SET coins_balance = coins_balance - ?, coins_lifetime = GREATEST(coins_lifetime - ?, 0) WHERE phone = ?', [take, take, w.phone]);
    // Written even when 0 could be taken, so a second run never takes them again.
    await ledger(conn, { event: 'EARN_REVERSE', orderId: oid, phone: ph, delta: -take, balanceAfter: bal, note: ('Coins earned on this order taken back: ' + why + (take < earned ? ' (' + (earned - take) + ' already spent)' : '')) });
    out.reversed = take; out.reverseShort = earned - take;
  }
  return out;
}

// Refund paid as coins: add `coins` to the customer's wallet, once per order (ledger event REFUND).
async function creditRefundOn(conn, { orderId, phone, coins, note, service, plan, amount }) {
  const oid = s(orderId); const ph = norm(phone); const c = Math.max(0, Math.round(asNum(coins)));
  if (!oid || !ph || !c) return { ok: false, coins: 0 };
  const w = await lockWalletOn(conn, ph);
  const [dup] = await conn.query("SELECT id FROM coins_ledger WHERE order_id = ? AND event = 'REFUND' LIMIT 1", [oid]);
  if (dup.length) return { ok: true, already: true, coins: 0 };
  const after = w.balance + c;
  await conn.query('UPDATE wallet SET coins_balance = coins_balance + ?, last_event = ? WHERE phone = ?', [c, ('REFUND:' + oid).slice(0, 150), w.phone]);
  await ledger(conn, { event: 'REFUND', orderId: oid, phone: ph, service, plan, amount, delta: c, balanceAfter: after, note: s(note) || 'Refund for order ' + oid });
  return { ok: true, coins: c, balanceAfter: after };
}

// Customer's recent coin history (Wallet page). Order ids are shown; no other people's data.
async function history(phone) {
  const ph = norm(phone);
  if (!ph) return { ok: false, message: 'Phone required.' };
  const LABEL = { NEW_PURCHASE: 'Earned on your order', RENEW: 'Earned on your renewal', REFERRAL: 'Invite reward', REFERRAL_REPEAT: 'Invite reward (friend ordered again)', REFERRAL_L2: "Invite reward (friend's friend)", SPEND: 'Used at checkout', SPEND_RELEASE: 'Coins given back', ADMIN_ADJUST: 'Adjusted by FluxFilm', REFUND: 'Refund for your order', EARN_REVERSE: 'Order refunded: earned coins taken back' };
  const rows = await db.query('SELECT ts, event, order_id, coins_delta, balance_after FROM coins_ledger WHERE phone_norm = ? ORDER BY id DESC LIMIT 25', [ph]);
  return { ok: true, items: rows.map((r) => ({ at: r.ts, label: LABEL[s(r.event).toUpperCase()] || s(r.event), coins: asNum(r.coins_delta), orderId: /^ADJ/.test(s(r.order_id)) ? '' : s(r.order_id), balanceAfter: asNum(r.balance_after) })) };
}

module.exports = {
  awardCoins, computeCoins, WALLET_ORDER,
  getSettings, saveSettings, validateSettings, defaults,
  spendAllowed, quoteSpend, holdSpend, releaseSpend, onOrderPaid, maintain, startTimer, adjust, history,
  undoOrderCoinsOn, creditRefundOn,
  _internal: { resetCache: () => { cache = null; } },
};
