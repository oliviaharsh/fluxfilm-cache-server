/**
 * FluxFilm - referral system ("Refer & earn", schema-v15). All settings are edited in the admin
 * panel (🎁 Referrals) and stored in app_settings - no Hostinger env changes needed.
 *
 *   Friend  : opens shop.fluxfilm.in/?ref=CODE → ₹friendDiscount off their first order
 *             (new customers only, not their own code, a coupon replaces it).
 *   Referrer: FIRST  - firstPercent % of what the friend paid on their first paid order (min..max coins)
 *             REPEAT - repeatPercent % on the friend's next `repeatOrders` paid orders (renewals count)
 *             LEVEL2 - if the friend was themselves invited, THEIR referrer gets level2Percent % once,
 *                      on the new friend's first paid order (2-level chain)
 *
 * Reliability: every decision is a referral_rewards row (unique per order + person + kind). Coins are
 * added by coins.awardCoins inside a locked transaction; a row stays PENDING/FAILED until the coins are in,
 * and reconcile() (every 30 min + admin button) retries those and re-checks paid orders that were missed.
 * Before schema-v15 is run every entry point degrades gracefully - checkout never fails because of it.
 */
const crypto = require('crypto');
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const SETTINGS_KEY = 'referral';

// ---------------- settings ----------------
const DEFAULTS = Object.freeze({
  enabled: true,
  friendDiscount: 20, minOrder: 0,
  firstPercent: 10, firstMin: 5, firstMax: 100,
  repeatOrders: 2, repeatPercent: 5, repeatMin: 2, repeatMax: 50,
  level2Enabled: true, level2Percent: 3, level2Min: 2, level2Max: 30,
  maxPerMonth: 20,
});
// [key, min, max] for numbers; booleans listed separately.
const NUMBER_RULES = [
  ['friendDiscount', 0, 1000], ['minOrder', 0, 100000],
  ['firstPercent', 0, 100], ['firstMin', 0, 10000], ['firstMax', 0, 10000],
  ['repeatOrders', 0, 20], ['repeatPercent', 0, 100], ['repeatMin', 0, 10000], ['repeatMax', 0, 10000],
  ['level2Percent', 0, 100], ['level2Min', 0, 10000], ['level2Max', 0, 10000],
  ['maxPerMonth', 0, 1000],
];
const BOOL_KEYS = ['enabled', 'level2Enabled'];

function validateSettings(input) {
  const inb = input || {};
  const out = {}; const errors = [];
  for (const [k, lo, hi] of NUMBER_RULES) {
    const v = inb[k] === undefined || inb[k] === '' ? DEFAULTS[k] : Number(inb[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(k + ' must be a number between ' + lo + ' and ' + hi + '.');
    else out[k] = /Percent$/.test(k) ? Math.round(v * 100) / 100 : Math.round(v);
  }
  for (const k of BOOL_KEYS) {
    const v = inb[k];
    out[k] = v === undefined ? DEFAULTS[k] : (v === true || v === 1 || String(v).toLowerCase() === 'true');
  }
  for (const p of ['first', 'repeat', 'level2']) {
    if (out[p + 'Max'] != null && out[p + 'Min'] != null && out[p + 'Max'] > 0 && out[p + 'Max'] < out[p + 'Min']) errors.push(p + ': maximum coins can\'t be lower than minimum.');
  }
  return { ok: !errors.length, settings: Object.assign({}, DEFAULTS, out), errors };
}

let cache = null; let cacheAt = 0; let tablesReady = true;
async function getSettings(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 30e3) return cache;
  let saved = {};
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
    if (rows.length) { try { saved = JSON.parse(rows[0].value) || {}; } catch (_) { saved = {}; } }
    tablesReady = true;
  } catch (e) {
    if (!missingTable(e)) throw e;
    tablesReady = false;
  }
  cache = Object.assign({}, validateSettings(saved).settings, { site: s(process.env.SITE_URL) || 'https://shop.fluxfilm.in' });
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

// Coins for a paid amount: percent of it, kept between min and max (max 0 = no cap). ₹0 orders earn 0.
function coinsFor(amount, percent, min, max) {
  const amt = Math.max(0, num(amount));
  if (amt <= 0 || num(percent) <= 0) return 0;
  let c = Math.round(amt * num(percent) / 100);
  c = Math.max(c, Math.round(num(min)));
  if (num(max) > 0) c = Math.min(c, Math.round(num(max)));
  return Math.max(0, c);
}

// ---------------- codes ----------------
const normCode = (c) => s(c).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
const maskPhone = (ph) => { const p = norm(ph); return p.length === 10 ? p.slice(0, 2) + '••••••' + p.slice(-2) : '••••'; };
function genCode() {
  const bytes = crypto.randomBytes(6);
  let out = 'FF';
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
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
const hasPaidOrder = async (ph) => (await db.query("SELECT 1 FROM orders WHERE phone_norm = ? AND UPPER(status) = 'PAID' LIMIT 1", [ph])).length > 0;

// What the storefront shows about the reward rules (no internal numbers beyond these).
const publicRules = (cfg) => ({
  friendDiscount: cfg.friendDiscount, minOrder: cfg.minOrder,
  firstPercent: cfg.firstPercent, firstMin: cfg.firstMin, firstMax: cfg.firstMax,
  repeatOrders: cfg.repeatPercent > 0 ? cfg.repeatOrders : 0, repeatPercent: cfg.repeatPercent,
  level2Percent: cfg.level2Enabled ? cfg.level2Percent : 0,
  maxPerMonth: cfg.maxPerMonth,
});

// ---------------- customer side ----------------
async function getReferralInfo(phone) {
  const cfg = await getSettings();
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Phone required.' };
  if (!tablesReady) return { ok: false, disabled: true, message: 'Refer & earn is coming soon.' };
  if (!cfg.enabled) return { ok: false, disabled: true, message: 'Refer & earn is paused right now. Please check back soon.' };
  try {
    const cust = await db.query('SELECT 1 FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
    if (!cust.length) return { ok: false, message: 'Create your FluxFilm account first.' };
    const code = await ensureCode(ph);
    const friends = await db.query('SELECT friend_phone, status, created_at, rewarded_at FROM referrals WHERE referrer_phone = ? ORDER BY created_at DESC LIMIT 50', [ph]);
    const rewards = await db.query("SELECT friend_phone, kind, coins FROM referral_rewards WHERE beneficiary_phone = ? AND status = 'PAID'", [ph]);
    const byFriend = new Map();
    let level2Coins = 0; let total = 0;
    for (const r of rewards) {
      total += num(r.coins);
      if (s(r.kind).toUpperCase() === 'LEVEL2') level2Coins += num(r.coins);
      else byFriend.set(r.friend_phone, (byFriend.get(r.friend_phone) || 0) + num(r.coins));
    }
    return {
      ok: true, code,
      link: cfg.site.replace(/\/+$/, '') + '/?ref=' + code,
      rules: publicRules(cfg),
      friendDiscount: cfg.friendDiscount,
      invited: friends.length,
      joined: friends.filter((f) => s(f.status).toUpperCase() === 'REWARDED').length,
      coinsEarned: total, level2Coins,
      friends: friends.map((f) => ({ phone: maskPhone(f.friend_phone), status: s(f.status).toUpperCase(), coins: byFriend.get(f.friend_phone) || 0, joinedAt: f.created_at })),
    };
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true, message: 'Refer & earn is coming soon.' };
    throw e;
  }
}

// Is this invite code usable (for this phone)? amount optional (checkout passes the plan price).
async function checkReferral(code, phone, amount) {
  const cfg = await getSettings();
  const c = normCode(code);
  if (!tablesReady) return { ok: false, disabled: true, message: 'Invite discounts are coming soon.' };
  if (!cfg.enabled) return { ok: false, disabled: true, message: 'Invite discounts are paused right now.' };
  if (c.length < 4) return { ok: false, invalid: true, message: 'This invite link is not valid.' };
  try {
    const owner = await db.query('SELECT phone_norm FROM referral_codes WHERE code = ? LIMIT 1', [c]);
    if (!owner.length) return { ok: false, invalid: true, message: 'This invite link is not valid.' };
    const referrerPhone = owner[0].phone_norm;
    const cust = await db.query('SELECT name FROM customers WHERE phone_norm = ? LIMIT 1', [referrerPhone]);
    const referrerName = s((cust[0] || {}).name).split(/\s+/)[0] || '';
    const base = { code: c, friendDiscount: cfg.friendDiscount, minOrder: cfg.minOrder, referrerName };
    const ph = norm(phone);
    if (ph) {
      if (ph === referrerPhone) return { ok: false, own: true, ...base, message: "You can't use your own invite link." };
      if (await hasPaidOrder(ph)) return { ok: false, notNew: true, ...base, message: 'Invite discounts are for new customers only.' };
      const prev = await db.query('SELECT status FROM referrals WHERE friend_phone = ? LIMIT 1', [ph]);
      if (prev.length && s(prev[0].status).toUpperCase() !== 'PENDING') return { ok: false, notNew: true, ...base, message: 'Invite discounts are for new customers only.' };
    }
    if (amount != null && num(amount) < cfg.minOrder) return { ok: false, belowMin: true, ...base, message: 'Invite discount needs an order of ₹' + cfg.minOrder + ' or more.' };
    return { ok: true, ...base, referrerPhone, discount: amount != null ? Math.min(cfg.friendDiscount, Math.max(0, Math.round(num(amount)))) : cfg.friendDiscount };
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true, message: 'Invite discounts are coming soon.' };
    throw e;
  }
}

// Checkout created an order with an invite code: remember who invited this friend.
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

// ---------------- rewards ----------------
const KIND_EVENT = { FIRST: 'REFERRAL', REPEAT: 'REFERRAL_REPEAT', LEVEL2: 'REFERRAL_L2' };

// Record a reward decision (once) and pay it. Returns the row's final status.
async function payReward(coinsMod, o, r) {
  const ins = await db.query(
    'INSERT IGNORE INTO referral_rewards (order_id, friend_phone, beneficiary_phone, kind, order_amount, percent, coins, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
    [o.order_id, o.phone_norm, r.beneficiary || '', r.kind, num(o.final_amount), num(r.percent), r.coins || 0, r.status || 'PENDING', r.reason || null]);
  if (r.status && r.status !== 'PENDING') return { kind: r.kind, status: r.status, recorded: !!(ins && ins.affectedRows) };
  if (!ins || !ins.affectedRows) return { kind: r.kind, status: 'ALREADY' }; // decided before (retries go through retryReward)
  return settle(coinsMod, { order_id: o.order_id, friend_phone: o.phone_norm, beneficiary_phone: r.beneficiary, kind: r.kind, coins: r.coins, service: o.service, plan: o.plan, amount: o.final_amount });
}
async function settle(coinsMod, row) {
  try {
    const res = await coinsMod.awardCoins({
      event: KIND_EVENT[row.kind] || 'REFERRAL', orderId: row.order_id, phone: row.beneficiary_phone, coins: row.coins,
      service: row.service || '', plan: row.plan || '', amount: row.amount || 0,
      note: ({ FIRST: 'Invited friend ', REPEAT: 'Invited friend ', LEVEL2: "Friend's friend " }[row.kind] || '') + maskPhone(row.friend_phone) + ' paid ' + row.order_id,
    });
    if (!res || res.ok === false) throw new Error((res && (res.message || res.skipped)) || 'coins not added');
    await db.query("UPDATE referral_rewards SET status = 'PAID', paid_at = NOW(), reason = NULL WHERE order_id = ? AND beneficiary_phone = ? AND kind = ?", [row.order_id, row.beneficiary_phone, row.kind]);
    return { kind: row.kind, status: 'PAID', coins: row.coins, to: row.beneficiary_phone };
  } catch (e) {
    await db.query("UPDATE referral_rewards SET status = 'FAILED', reason = ? WHERE order_id = ? AND beneficiary_phone = ? AND kind = ?", [String(e.message || e).slice(0, 200), row.order_id, row.beneficiary_phone, row.kind]).catch(() => {});
    return { kind: row.kind, status: 'FAILED', error: String(e.message || e) };
  }
}

// An order became PAID (called from order.js _markPaid, and by reconcile). Safe to call any number of times.
async function onOrderPaid(orderId, deps) {
  const coinsMod = (deps && deps.coins) || require('./coins');
  const cfg = await getSettings(true);
  try {
    const o = (await db.query("SELECT order_id, phone_norm, service, plan, final_amount, status, COALESCE(verified_at, created_at_sheet) paid_at FROM orders WHERE order_id = ? LIMIT 1", [s(orderId)]))[0];
    if (!o || s(o.status).toUpperCase() !== 'PAID') return { ok: false, skipped: 'order not paid' };
    const link = (await db.query('SELECT id, referrer_phone, status, created_at FROM referrals WHERE friend_phone = ? LIMIT 1', [o.phone_norm]))[0];
    if (!link) return { ok: true, skipped: 'not an invited customer' };
    const results = [];
    const none = async (reason) => { results.push(await payReward(coinsMod, o, { kind: 'NONE', status: 'SKIPPED', reason })); return { ok: true, results }; };
    if (!cfg.enabled) return none('Refer & earn switched off');
    const referrer = norm(link.referrer_phone);
    if (!referrer || referrer === o.phone_norm) return none('own code');

    // The friend's paid orders, oldest first. Paid before they used the invite = not a new customer.
    const paid = await db.query("SELECT order_id, COALESCE(verified_at, created_at_sheet) paid_at FROM orders WHERE phone_norm = ? AND UPPER(status) = 'PAID' ORDER BY COALESCE(verified_at, created_at_sheet) ASC, order_id ASC", [o.phone_norm]);
    const idx = paid.findIndex((x) => x.order_id === o.order_id) + 1;
    const first = paid[0];
    const linkAt = Date.parse(s(link.created_at).replace(' ', 'T'));
    const firstAt = first ? Date.parse(s(first.paid_at).replace(' ', 'T')) : NaN;
    if (s(link.status).toUpperCase() === 'NOT_NEW' || (!isNaN(linkAt) && !isNaN(firstAt) && firstAt < linkAt - 60e3)) {
      if (s(link.status).toUpperCase() === 'PENDING') await db.query("UPDATE referrals SET status = 'NOT_NEW', updated_at = NOW() WHERE id = ? AND status = 'PENDING'", [link.id]);
      return none('friend was already a customer');
    }

    if (idx === 1) {
      // FIRST: the referrer (monthly limit applies to these only).
      let capped = false;
      if (cfg.maxPerMonth > 0) {
        const cnt = await db.query("SELECT COUNT(*) n FROM referral_rewards WHERE beneficiary_phone = ? AND kind = 'FIRST' AND status IN ('PAID', 'PENDING', 'FAILED') AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')", [referrer]);
        capped = num((cnt[0] || {}).n) >= cfg.maxPerMonth;
      }
      const c1 = coinsFor(o.final_amount, cfg.firstPercent, cfg.firstMin, cfg.firstMax);
      if (capped) results.push(await payReward(coinsMod, o, { kind: 'FIRST', beneficiary: referrer, percent: cfg.firstPercent, coins: 0, status: 'SKIPPED', reason: 'monthly limit reached' }));
      else if (c1 <= 0) results.push(await payReward(coinsMod, o, { kind: 'FIRST', beneficiary: referrer, percent: cfg.firstPercent, coins: 0, status: 'SKIPPED', reason: 'no coins for this amount' }));
      else results.push(await payReward(coinsMod, o, { kind: 'FIRST', beneficiary: referrer, percent: cfg.firstPercent, coins: c1 }));
      await db.query("UPDATE referrals SET status = ?, friend_order_id = ?, reward_coins = ?, rewarded_at = COALESCE(rewarded_at, NOW()), updated_at = NOW() WHERE id = ? AND status = 'PENDING'",
        [capped ? 'CAPPED' : 'REWARDED', o.order_id, capped ? 0 : c1, link.id]);

      // LEVEL2: whoever invited the referrer (once, on this friend's first paid order).
      if (cfg.level2Enabled && cfg.level2Percent > 0) {
        const up = (await db.query('SELECT referrer_phone, status FROM referrals WHERE friend_phone = ? LIMIT 1', [referrer]))[0];
        const grand = up && norm(up.referrer_phone);
        if (grand && grand !== o.phone_norm && grand !== referrer && ['REWARDED', 'CAPPED'].includes(s(up.status).toUpperCase())) {
          const c2 = coinsFor(o.final_amount, cfg.level2Percent, cfg.level2Min, cfg.level2Max);
          results.push(await payReward(coinsMod, o, c2 > 0 ? { kind: 'LEVEL2', beneficiary: grand, percent: cfg.level2Percent, coins: c2 } : { kind: 'LEVEL2', beneficiary: grand, percent: cfg.level2Percent, coins: 0, status: 'SKIPPED', reason: 'no coins for this amount' }));
        }
      }
      return { ok: true, results };
    }

    // REPEAT: the friend's 2nd .. (1 + repeatOrders)th paid order.
    if (idx >= 2 && idx <= 1 + cfg.repeatOrders && cfg.repeatPercent > 0 && ['REWARDED', 'CAPPED'].includes(s(link.status).toUpperCase())) {
      const c3 = coinsFor(o.final_amount, cfg.repeatPercent, cfg.repeatMin, cfg.repeatMax);
      results.push(await payReward(coinsMod, o, c3 > 0 ? { kind: 'REPEAT', beneficiary: referrer, percent: cfg.repeatPercent, coins: c3 } : { kind: 'REPEAT', beneficiary: referrer, percent: cfg.repeatPercent, coins: 0, status: 'SKIPPED', reason: 'no coins for this amount' }));
      return { ok: true, results };
    }
    return none(idx > 1 ? 'order #' + idx + ' (after the reward window)' : 'not due');
  } catch (e) {
    if (missingTable(e)) return { ok: false, disabled: true };
    throw e;
  }
}

// Pay anything that was missed: rewards stuck in FAILED / PENDING, and paid orders of invited friends that
// were never checked (e.g. the server restarted right after a payment). Idempotent.
async function reconcile(opts) {
  const o = opts || {};
  const coinsMod = o.coins || require('./coins');
  const days = Math.min(365, Math.max(1, Math.round(num(o.days) || 60)));
  const summary = { checkedOrders: 0, retried: 0, paid: 0, failed: 0, details: [] };
  try {
    const stuck = await db.query(
      "SELECT rr.order_id, rr.friend_phone, rr.beneficiary_phone, rr.kind, rr.coins, o.service, o.plan, o.final_amount amount FROM referral_rewards rr LEFT JOIN orders o ON o.order_id = rr.order_id " +
      "WHERE (rr.status = 'FAILED' OR (rr.status = 'PENDING' AND rr.created_at < NOW() - INTERVAL 2 MINUTE)) AND rr.coins > 0 ORDER BY rr.created_at LIMIT 200", []);
    for (const row of stuck) {
      summary.retried++;
      const r = await settle(coinsMod, row);
      if (r.status === 'PAID') summary.paid++; else summary.failed++;
      summary.details.push(r);
    }
    const missed = await db.query(
      "SELECT o.order_id FROM orders o JOIN referrals r ON r.friend_phone = o.phone_norm " +
      "WHERE UPPER(o.status) = 'PAID' AND COALESCE(o.verified_at, o.created_at_sheet) >= NOW() - INTERVAL ? DAY " +
      "AND COALESCE(o.verified_at, o.created_at_sheet) < NOW() - INTERVAL 1 MINUTE " +
      "AND NOT EXISTS (SELECT 1 FROM referral_rewards rr WHERE rr.order_id = o.order_id) " +
      "ORDER BY COALESCE(o.verified_at, o.created_at_sheet) ASC LIMIT 300", [days]);
    for (const m of missed) {
      summary.checkedOrders++;
      const r = await onOrderPaid(m.order_id, { coins: coinsMod });
      for (const x of (r && r.results) || []) {
        if (x.status === 'PAID') summary.paid++;
        if (x.status === 'FAILED') summary.failed++;
        if (x.kind !== 'NONE') summary.details.push(Object.assign({ orderId: m.order_id }, x));
      }
    }
    return Object.assign({ ok: true }, summary);
  } catch (e) {
    if (missingTable(e)) return { ok: false, needsSchema: true, message: 'Run db/schema-v15.sql in phpMyAdmin first.' };
    throw e;
  }
}

let timer = null;
function startReconcileTimer() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () => reconcile().then((r) => { if (r && (r.paid || r.failed)) console.log('[referral] reconcile', JSON.stringify({ paid: r.paid, failed: r.failed, checked: r.checkedOrders })); }).catch((e) => console.log('[referral] reconcile failed:', e.message));
  setTimeout(run, 90e3).unref();
  timer = setInterval(run, 30 * 60e3);
  timer.unref();
}

module.exports = {
  getReferralInfo, checkReferral, attachToOrder, onOrderPaid, reconcile, startReconcileTimer,
  getSettings, saveSettings, validateSettings, coinsFor, DEFAULTS,
  _internal: { genCode, normCode, maskPhone, ensureCode, resetCache: () => { cache = null; } },
};
