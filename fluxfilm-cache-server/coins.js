/**
 * FluxFilm - loyalty coins on MySQL (award on fulfillment + Refer & earn rewards). Mirrors the old Apps
 * Script logic: earn = floor(amount/100 * COINS_PER_100) × new/renew multiplier; p.coins = a fixed amount.
 * Idempotent per (order_id, event) via the coins_ledger. No Sheet, no Apps Script.
 * (Spending/redeem isn't used in the app yet — earn only, like the old system.)
 *
 * Each award runs in one transaction that first locks the customer's wallet row, so two awards for the
 * same person at the same moment can neither overwrite each other's balance nor both pass the
 * "already awarded?" check. A customer can have several wallet rows (old Sheet phone formats); the one
 * with the most lifetime coins is the live one - reads use the same ORDER BY.
 */
const db = require('./db');

const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const WALLET_ORDER = 'ORDER BY coins_lifetime DESC, coins_balance DESC';

function computeCoins(event, amount) {
  const amt = asNum(amount);
  const minAmt = asNum(process.env.COINS_MIN_ORDER_AMOUNT || 0);
  if (amt < minAmt) return 0;
  const per100 = asNum(process.env.COINS_PER_100 || 5); // default 5 coins / ₹100
  if (per100 <= 0) return 0;
  const base = Math.floor((amt / 100) * per100);
  const multNew = asNum(process.env.COINS_NEW_MULTIPLIER || 1);
  const multRenew = asNum(process.env.COINS_RENEW_MULTIPLIER || 1);
  const mult = String(event || '').toUpperCase().indexOf('RENEW') !== -1 ? multRenew : multNew;
  return Math.max(0, Math.floor(base * mult));
}

async function awardCoins(payload) {
  const p = payload || {};
  const event = String(p.event || 'NEW_PURCHASE');
  const oid = String(p.orderId || '').trim();
  const ph = norm(p.phone);
  if (!ph || !oid) return { ok: false, skipped: 'missing phone/order' };

  // p.coins = a fixed reward (e.g. Refer & earn); otherwise earn from the order amount.
  const coins = p.coins != null ? Math.max(0, Math.floor(asNum(p.coins))) : computeCoins(event, p.amount);
  if (coins <= 0) return { ok: true, coins: 0 };
  const lastEvent = (event + ':' + oid).slice(0, 150);

  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();
    const lock = () => conn.query('SELECT phone, coins_balance FROM wallet WHERE phone_norm = ? ' + WALLET_ORDER + ' LIMIT 1 FOR UPDATE', [ph]);
    let [w] = await lock();
    if (!w.length) {
      await conn.query('INSERT IGNORE INTO wallet (phone, phone_norm, coins_balance, coins_lifetime) VALUES (?, ?, 0, 0)', [ph, ph]);
      [w] = await lock();
    }
    if (!w.length) throw new Error('wallet row could not be created');

    // idempotent — never award twice for the same order+event (checked while holding the wallet lock)
    const [dup] = await conn.query('SELECT id FROM coins_ledger WHERE order_id = ? AND event = ? LIMIT 1', [oid, event]);
    if (dup.length) { await conn.commit(); return { ok: true, already: true }; }

    const newBal = asNum(w[0].coins_balance) + coins;
    await conn.query('UPDATE wallet SET coins_balance = coins_balance + ?, coins_lifetime = coins_lifetime + ?, last_earned_at = NOW(), last_event = ? WHERE phone = ?',
      [coins, coins, lastEvent, w[0].phone]);
    await conn.query(
      'INSERT INTO coins_ledger (ts, event, order_id, phone_norm, service, plan, amount, coins_delta, balance_after, note) VALUES (NOW(),?,?,?,?,?,?,?,?,?)',
      [event, oid, ph, String(p.service || '').slice(0, 60), String(p.plan || '').slice(0, 80), asNum(p.amount), coins, newBal, String(p.note || '').slice(0, 200)]);
    await conn.commit();
    return { ok: true, coins, balanceAfter: newBal };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally { conn.release(); }
}

module.exports = { awardCoins, computeCoins, WALLET_ORDER };
