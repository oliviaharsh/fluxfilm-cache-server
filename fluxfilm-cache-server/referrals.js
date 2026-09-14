/**
 * FluxFilm - referral system ("Refer & earn", schema-v15).
 *
 *   1. A customer opens Account → Refer & earn and gets a code + link (shop.fluxfilm.in/?ref=CODE).
 *   2. A friend who opens the link gets REFERRAL_FRIEND_DISCOUNT off their first order
 *      (new customers only, not with their own code, not combined with a coupon).
 *   3. When the friend's first order is PAID, the referrer gets REFERRAL_REWARD_COINS coins
 *      (once per friend; at most REFERRAL_MAX_PER_MONTH rewards per referrer per month).
 *
 * Settings (Hostinger env, optional): REFERRAL_FRIEND_DISCOUNT (default 20), REFERRAL_REWARD_COINS (50),
 * REFERRAL_MIN_ORDER (0), REFERRAL_MAX_PER_MONTH (20), REFERRAL_ENABLED (set 0 to switch off).
 * Before schema-v15 is run every entry point degrades gracefully - checkout never fails because of it.
 */
const crypto = require('crypto');
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const int = (v, dflt) => { const n = parseInt(v, 10); return isNaN(n) ? dflt : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function settings() {
  const e = process.env;
  return {
    enabled: s(e.REFERRAL_ENABLED) !== '0' && s(e.REFERRAL_ENABLED).toLowerCase() !== 'false',
    friendDiscount: Math.max(0, int(e.REFERRAL_FRIEND_DISCOUNT, 20)),
    rewardCoins: Math.max(0, int(e.REFERRAL_REWARD_COINS, 50)),
    minOrder: Math.max(0, int(e.REFERRAL_MIN_ORDER, 0)),
    maxPerMonth: Math.max(0, int(e.REFERRAL_MAX_PER_MONTH, 20)),
    site: s(e.SITE_URL) || 'https://shop.fluxfilm.in',
  };
}
const normCode = (c) => s(c).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
const maskPhone = (ph) => { const p = norm(ph); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };
function genCode() {
  const bytes = crypto.randomBytes(6);
  let out = 'FF';
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
const hasPaidOrder = async (ph, exceptOrderId) => (await db.query(
  "SELECT 1 FROM orders WHERE phone_norm = ? AND UPPER(status) = 'PAID'" + (exceptOrderId ? ' AND order_id <> ?' : '') + ' LIMIT 1',
  exceptOrderId ? [ph, exceptOrderId] : [ph])).length > 0;

async function ensureCode(ph) {
  const rows = await db.query('SELECT code FROM referral_codes WHERE phone_norm = ? LIMIT 1', [ph]);
  if (rows.length) return rows[0].code;
  for (let i = 0; i < 6; i++) {
    const code = genCode();
    try {
      await db.query('INSERT INTO referral_codes (phone_norm, code) VALUES (?, ?)', [ph, code]);
      return code;
    } catch (e) {
      if (!/duplicate/i.test(String(e && e.message))) throw e;
      const again = await db.query('SELECT code FROM referral_codes WHERE phone_norm = ? LIMIT 1', [ph]);
      if (again.length) return again[0].code; // another request created it first
    }
  }
  throw new Error('Could not create an invite code.');
}

// Account → Refer & earn.
async function getReferralInfo(phone) {
  const cfg = settings();
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Phone required.' };
  if (!cfg.enabled) return { ok: false, disabled: true, message: 'Refer & earn is switched off right now.' };
  try {
    const cust = await db.query('SELECT 1 FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
    if (!cust.length) return { ok: false, message: 'Create your FluxFilm account first.' };
    const code = await ensureCode(ph);
    const rows = await db.query(
      'SELECT friend_phone, status, reward_coins, created_at, rewarded_at FROM referrals WHERE referrer_phone = ? ORDER BY created_at DESC LIMIT 50', [ph]);
    const rewarded = rows.filter((r) => s(r.status).toUpperCase() === 'REWARDED');
    return {
      ok: true, code,
      link: cfg.site.replace(/\/+$/, '') + '/?ref=' + code,
      friendDiscount: cfg.friendDiscount, rewardCoins: cfg.rewardCoins, maxPerMonth: cfg.maxPerMonth,
      invited: rows.length, rewarded: rewarded.length,
      coinsEarned: rewarded.reduce((a, r) => a + num(r.reward_coins), 0),
      friends: rows.map((r) => ({ phone: maskPhone(r.friend_phone), status: s(r.status).toUpperCase(), coins: num(r.reward_coins), joinedAt: r.created_at, rewardedAt: r.rewarded_at })),
    };
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true, message: 'Refer & earn is coming soon.' };
    throw e;
  }
}

// Is this invite code usable (for this phone)? Used by the storefront banner and by checkout.
// amount is optional (checkout passes the plan price).
async function checkReferral(code, phone, amount) {
  const cfg = settings();
  const c = normCode(code);
  if (!cfg.enabled) return { ok: false, disabled: true, message: 'Invite discounts are switched off right now.' };
  if (c.length < 4) return { ok: false, invalid: true, message: 'This invite link is not valid.' };
  try {
    const owner = await db.query('SELECT phone_norm FROM referral_codes WHERE code = ? LIMIT 1', [c]);
    if (!owner.length) return { ok: false, invalid: true, message: 'This invite link is not valid.' };
    const referrerPhone = owner[0].phone_norm;
    const cust = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [referrerPhone]);
    const referrerName = s((cust[0] || {}).name).split(/\s+/)[0] || '';
    const base = { code: c, friendDiscount: cfg.friendDiscount, referrerName };
    const ph = norm(phone);
    if (ph) {
      if (ph === referrerPhone) return { ok: false, own: true, ...base, message: "You can't use your own invite link." };
      if (await hasPaidOrder(ph)) return { ok: false, notNew: true, ...base, message: 'Invite discounts are for new customers only.' };
      const prev = await db.query('SELECT code, status FROM referrals WHERE friend_phone = ? LIMIT 1', [ph]);
      if (prev.length && s(prev[0].status).toUpperCase() !== 'PENDING') return { ok: false, notNew: true, ...base, message: 'Invite discounts are for new customers only.' };
    }
    if (amount != null && num(amount) < cfg.minOrder) return { ok: false, ...base, message: 'Invite discount needs an order of ₹' + cfg.minOrder + ' or more.' };
    return { ok: true, ...base, referrerPhone, discount: amount != null ? Math.min(cfg.friendDiscount, Math.max(0, Math.round(num(amount)))) : cfg.friendDiscount };
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true, message: 'Invite discounts are coming soon.' };
    throw e;
  }
}

// Checkout created an order that used an invite code: remember who invited this friend.
// (A friend who orders again before paying just moves the pending referral to the newer order.)
async function attachToOrder({ code, referrerPhone, friendPhone, orderId, discount }) {
  try {
    await db.query(
      "INSERT INTO referrals (code, referrer_phone, friend_phone, status, friend_order_id, discount, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?, NOW()) " +
      "ON DUPLICATE KEY UPDATE code = IF(status = 'PENDING', VALUES(code), code), referrer_phone = IF(status = 'PENDING', VALUES(referrer_phone), referrer_phone), " +
      "friend_order_id = IF(status = 'PENDING', VALUES(friend_order_id), friend_order_id), discount = IF(status = 'PENDING', VALUES(discount), discount), updated_at = NOW()",
      [normCode(code), norm(referrerPhone), norm(friendPhone), s(orderId), Math.max(0, Math.round(num(discount)))]);
    return { ok: true };
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true };
    throw e;
  }
}

// An order became PAID (called from order.js _markPaid). Rewards the referrer once.
async function onOrderPaid(orderId, deps) {
  const cfg = settings();
  const coins = (deps && deps.coins) || require('./coins');
  try {
    const orows = await db.query('SELECT order_id, phone_norm, service, plan, final_amount FROM orders WHERE order_id = ? LIMIT 1', [s(orderId)]);
    const o = orows[0];
    if (!o) return { ok: false, skipped: 'order not found' };
    const ref = await db.query("SELECT id, code, referrer_phone, friend_phone, status FROM referrals WHERE friend_phone = ? AND status = 'PENDING' LIMIT 1", [o.phone_norm]);
    const r = ref[0];
    if (!r) return { ok: true, skipped: 'no pending referral' };
    const setStatus = (status, extra) => db.query(
      "UPDATE referrals SET status = ?, friend_order_id = ?, updated_at = NOW()" + (extra || '') + " WHERE id = ? AND status = 'PENDING'", [status, o.order_id, r.id]);
    if (norm(r.referrer_phone) === norm(o.phone_norm)) { await setStatus('NOT_NEW'); return { ok: true, status: 'NOT_NEW' }; }
    if (await hasPaidOrder(o.phone_norm, o.order_id)) { await setStatus('NOT_NEW'); return { ok: true, status: 'NOT_NEW' }; }
    if (cfg.maxPerMonth > 0) {
      const cnt = await db.query("SELECT COUNT(*) n FROM referrals WHERE referrer_phone = ? AND status = 'REWARDED' AND rewarded_at >= DATE_FORMAT(NOW(), '%Y-%m-01')", [r.referrer_phone]);
      if (num((cnt[0] || {}).n) >= cfg.maxPerMonth) { await setStatus('CAPPED'); return { ok: true, status: 'CAPPED' }; }
    }
    const upd = await db.query(
      "UPDATE referrals SET status = 'REWARDED', friend_order_id = ?, reward_coins = ?, rewarded_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'PENDING'",
      [o.order_id, cfg.rewardCoins, r.id]);
    if (!upd || !upd.affectedRows) return { ok: true, skipped: 'already handled' }; // a parallel call won
    const award = cfg.rewardCoins > 0
      ? await coins.awardCoins({ event: 'REFERRAL', orderId: o.order_id, phone: r.referrer_phone, service: o.service, plan: o.plan, amount: o.final_amount, coins: cfg.rewardCoins, note: 'Invited friend ' + maskPhone(o.phone_norm) + ' bought ' + s(o.service) })
      : { ok: true, coins: 0 };
    return { ok: true, status: 'REWARDED', coins: cfg.rewardCoins, award };
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true };
    throw e;
  }
}

module.exports = { getReferralInfo, checkReferral, attachToOrder, onOrderPaid, settings, _internal: { genCode, normCode, maskPhone, ensureCode } };
