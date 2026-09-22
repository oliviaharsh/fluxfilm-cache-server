/**
 * FluxFilm - how many days a late renewal costs (agreed with the owner 2026-09-14).
 *
 *   Count the days the customer could still watch after their plan ended, up to
 *   RENEW_CAP_DAYS (7) — unless we removed them more than RENEW_WINDOW_DAYS (7)
 *   before they renewed. Customers we removed who renew within that window get
 *   RENEW_GOODWILL_DAYS (2) of the counted days forgiven. Whole days only.
 *
 *   not removed, renews late       → new expiry = payment + plan − min(late days, 7)
 *   removed, renews ≤ 7 days after → new expiry = payment + plan − max(0, min(access days, 7) − 2)
 *   removed, renews later          → new expiry = payment + plan (fresh start)
 *   renews on time / early         → new expiry = old expiry + plan (no gap)
 *
 * Why: the old rule only looked at lateness, so a customer removed on their expiry
 * day who renewed 5 days later was renewed from the old expiry and lost 5 days
 * they could not watch. Real case: Prince Rajput, Netflix, 5 Sep 2026.
 *
 * Every sentence here is written with WhatsApp's *bold* markers (watext.js): `message` is the plain version the
 * shop screen prints, `messageWa` keeps the markers for the WhatsApp text and the email turns them into <b>.
 * One wording, three channels — the owner asked for bold and emoji on 23 Sep 2026 and this is where it starts.
 *
 * Pure: no database access, so every case is unit-tested (test/renewal-rules.test.js).
 */
const watext = require('./watext');
const DAY = 86400000;

function cfgFromEnv(env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.floor(x) : d; };
  const e = env || process.env;
  return {
    capDays: n(e.RENEW_CAP_DAYS, 7),
    windowDays: n(e.RENEW_WINDOW_DAYS, 7),
    goodwillDays: n(e.RENEW_GOODWILL_DAYS, 2),
  };
}

/** 'YYYY-MM-DD HH:MM:SS' (how MySQL returns dates here) → local Date; Date passes through. */
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Formatted by hand: locale data differs between Node builds ("Sep" vs "Sept").
// Uses the process time zone, which server.js pins to Asia/Kolkata.
function prettyDate(d) {
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

/** "96 hours, 12 minutes and 5 seconds" */
function hms(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return plural(h, 'hour') + ', ' + plural(m, 'minute') + ' and ' + plural(s, 'second');
}

/**
 * @param {object} p
 * @param {Date|string} p.expiry      current expiry (E)
 * @param {boolean}     p.removed     did we remove the customer from the account?
 * @param {Date|string} p.removedAt   when (R); missing on a removed row → treated as removed at expiry
 * @param {Date}        p.now         payment / renewal time (T)
 * @param {number}      p.durationDays plan length (D)
 * @param {object}      [p.cfg]       { capDays, windowDays, goodwillDays }
 */
function computeRenewal(p) {
  const cfg = p.cfg || cfgFromEnv();
  const D = Math.max(1, Number(p.durationDays) || 30);
  const T = toDate(p.now) || new Date();
  const E = toDate(p.expiry);
  const out = { case: '', counted: 0, accessDays: 0, gifted: 0, accessMs: 0, daysSinceRemoval: null, message: '', bubble: '' };

  if (!E) {
    Object.assign(out, { case: 'NO_EXPIRY', newExpiry: addDays(T, D), message: '🎬 Your plan starts fresh from *today*.' });
    return finish(out);
  }
  if (T.getTime() <= E.getTime()) {
    Object.assign(out, { case: 'ON_TIME', newExpiry: addDays(E, D), message: '✅ Renewed without a break — the new days are added *on top* of your current plan.' });
    return finish(out);
  }

  if (p.removed) {
    const R = toDate(p.removedAt) || E; // legacy ticks have no time: removed at expiry (decided 2026-09-13)
    out.accessMs = Math.max(0, R.getTime() - E.getTime());
    out.accessDays = Math.floor(out.accessMs / DAY);
    out.daysSinceRemoval = Math.max(0, Math.floor((T.getTime() - R.getTime()) / DAY));
    if (out.daysSinceRemoval > cfg.windowDays) {
      out.case = 'REMOVED_LONG_AGO';
      out.counted = 0;
      out.message = '🎉 Welcome back! Your plan starts fresh from *today* — *nothing* is counted.';
    } else if (out.accessDays === 0) {
      out.case = 'REMOVED_AT_EXPIRY';
      out.counted = 0;
      out.message = '🎉 Your plan starts fresh from *today* — *nothing* is counted.';
    } else {
      out.case = 'REMOVED_RECENTLY';
      out.counted = Math.max(0, Math.min(out.accessDays, cfg.capDays) - cfg.goodwillDays);
      out.gifted = out.accessDays - out.counted;
      out.message = '⏳ Your access carried on for *' + plural(out.accessDays, 'day') + '* after your plan ended (until *' + prettyDate(R) + '*). '
        + (out.counted > 0
          ? '🎁 We have counted only *' + plural(out.counted, 'day') + '* and gifted you *' + plural(out.gifted, 'day') + '* free.'
          : '🎁 We have gifted you *all of them* — nothing is counted.');
    }
    out.gifted = out.accessDays - out.counted;
  } else {
    out.case = 'KEPT_ACCESS';
    out.accessMs = T.getTime() - E.getTime();
    out.accessDays = Math.floor(out.accessMs / DAY);
    out.counted = Math.min(out.accessDays, cfg.capDays);
    out.gifted = out.accessDays - out.counted;
    out.message = out.accessDays === 0
      ? '✅ Your plan just ended — renewed without a break.'
      : '⏳ Your plan ended *' + plural(out.accessDays, 'day') + '* ago but you kept watching, so '
        + (out.gifted > 0
          ? '🎁 we have counted only *' + plural(out.counted, 'day') + '* and gifted you *' + plural(out.gifted, 'day') + '* free.'
          : 'those *' + plural(out.counted, 'day') + '* are counted.');
  }

  out.newExpiry = addDays(T, D - out.counted);
  if (out.gifted > 0 && out.accessMs >= 3600000) {
    out.bubble = '🍿 Fun fact: that was ' + hms(out.accessMs) + ' of streaming after your plan ended!';
  }
  return finish(out);
}

function finish(out) {
  out.newExpiryText = prettyDate(out.newExpiry);
  // The sentence is authored once with *bold* markers: WhatsApp gets it as it is, everything that prints plain
  // text (the shop's own "renewed" line, the admin note, the stored order note) gets it without the markers.
  out.messageWa = watext.wa(out.message);
  out.message = watext.plain(out.message);
  out.bubbleWa = watext.wa(out.bubble);
  out.bubble = watext.plain(out.bubble);
  return out;
}

/**
 * Admin only (Quick order → Renew, owner request 16 Sep 2026): the owner picks where the new period starts.
 *   base 'EXPIRY' → new expiry = old expiry + plan (the customer kept watching unpaid, so no free days)
 *   base 'TODAY'  → new expiry = today + plan (a fresh start; days still left on a running plan are dropped)
 *   anything else → the normal rule above (computeRenewal), exactly what the storefront does.
 * The storefront never sends a base: RenewBase is only written by quickorders.js into raw_json (server-side).
 */
const RENEW_BASES = ['AUTO', 'EXPIRY', 'TODAY'];
function normBase(v) { const b = String(v == null ? '' : v).trim().toUpperCase(); return RENEW_BASES.includes(b) ? b : 'AUTO'; }
function computeAdminRenewal(p) {
  const base = normBase(p && p.base);
  if (base === 'AUTO') return Object.assign(computeRenewal(p), { base });
  const D = Math.max(1, Number(p.durationDays) || 30);
  const T = toDate(p.now) || new Date();
  const E = toDate(p.expiry);
  const out = { case: '', base, counted: 0, accessDays: 0, gifted: 0, accessMs: 0, daysSinceRemoval: null, message: '', bubble: '' };
  if (base === 'EXPIRY' && E) {
    out.case = 'ADMIN_FROM_EXPIRY';
    out.newExpiry = addDays(E, D);
    out.message = '✅ Renewed from your old expiry date (*' + prettyDate(E) + '*) — the new period carries on from there.';
  } else {
    out.case = base === 'EXPIRY' ? 'NO_EXPIRY' : 'ADMIN_FROM_TODAY';
    out.newExpiry = addDays(T, D);
    out.message = E && E.getTime() > T.getTime()
      ? '🎬 Starts fresh from *today* — the days left on the current plan are not added.'
      : '🎬 Starts fresh from *today*.';
  }
  return finish(out);
}

module.exports = { computeRenewal, computeAdminRenewal, normBase, RENEW_BASES, prettyDate, cfgFromEnv, toDate, hms, DAY };
