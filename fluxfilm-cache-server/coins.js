/**
 * FluxFilm - loyalty coins on MySQL (award on fulfillment). Mirrors the old Apps
 * Script logic: earn = floor(amount/100 * COINS_PER_100) × new/renew multiplier.
 * Idempotent per (order_id, event) via the coins_ledger. No Sheet, no Apps Script.
 * (Spending/redeem isn't used in the app yet — earn only, like the old system.)
 */
const db = require('./db');

const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };

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

  // idempotent — never award twice for the same order+event
  const dup = await db.query('SELECT id FROM coins_ledger WHERE order_id = ? AND event = ? LIMIT 1', [oid, event]);
  if (dup.length) return { ok: true, already: true };

  const coins = computeCoins(event, p.amount);
  if (coins <= 0) return { ok: true, coins: 0 };

  const wrows = await db.query('SELECT coins_balance, coins_lifetime FROM wallet WHERE phone_norm = ? LIMIT 1', [ph]);
  const bal = wrows.length ? asNum(wrows[0].coins_balance) : 0;
  const life = wrows.length ? asNum(wrows[0].coins_lifetime) : 0;
  const newBal = bal + coins;
  const newLife = life + coins;
  const lastEvent = event + ':' + oid;

  if (wrows.length) {
    await db.query('UPDATE wallet SET coins_balance = ?, coins_lifetime = ?, last_earned_at = NOW(), last_event = ? WHERE phone_norm = ?', [newBal, newLife, lastEvent, ph]);
  } else {
    await db.query('INSERT INTO wallet (phone, phone_norm, coins_balance, coins_lifetime, last_earned_at, last_event) VALUES (?,?,?,?,NOW(),?)', [p.phone || ph, ph, newBal, newLife, lastEvent]);
  }
  await db.query(
    'INSERT INTO coins_ledger (ts, event, order_id, phone_norm, service, plan, amount, coins_delta, balance_after, note) VALUES (NOW(),?,?,?,?,?,?,?,?,?)',
    [event, oid, ph, String(p.service || ''), String(p.plan || ''), asNum(p.amount), coins, newBal, String(p.note || '')]);
  return { ok: true, coins, balanceAfter: newBal };
}

module.exports = { awardCoins, computeCoins };
