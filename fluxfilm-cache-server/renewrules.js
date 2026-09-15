/**
 * FluxFilm - shared renewal rules (PR 101 follow-up, 2026-09-15).
 *
 * 1) Days left: ONE calendar-day count in India time, from the expiry DATE (the time of day is ignored).
 *    expiry today = 0 ("Expires today"), yesterday = -1, tomorrow = 1. Used by My plans (reads.js) and the
 *    server price check (order.js renewQuote), so the page and the server always agree.
 *    Renew is allowed until LATE_RENEW_DAYS (6) days after the expiry date, the same as before.
 *
 * 2) Which plans a subscription may renew into. A renewal keeps the same account and devices, so only the
 *    duration may change. Old imported plan names ("1 Month", "Yearly", "30 Days", "12M", "1 Year") are
 *    normalised the same way as current names ("Sharing 1M"). If the old plan's kind is unknown, the plans of
 *    the same service with the same device count are offered; if none, every plan of the service. Never none.
 *
 * index.html has a copy of planVariant / planDevices / renewPlanChoices (renewPlanChoices_); a test checks both
 * give the same answers.
 */

const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 3600e3;
const LATE_RENEW_DAYS = 6;

function istYmd(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }

/** The expiry DATE (YYYY-MM-DD, India) of a DB value. The DB stores India wall-clock time without a zone. */
function expiryYmd(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : istYmd(v.getTime());
  const str = String(v).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/);
  if (m) {
    const ymd = m[1] + '-' + m[2] + '-' + m[3];
    const t = Date.parse(ymd + 'T00:00:00Z');
    return isNaN(t) || new Date(t).toISOString().slice(0, 10) !== ymd ? null : ymd;
  }
  const d = new Date(str); // ISO with a zone ("…Z", "+05:30")
  return isNaN(d.getTime()) ? null : istYmd(d.getTime());
}

/** Calendar days from today (India) to the expiry date. null when there is no valid expiry. */
function daysLeftIst(expiry, now) {
  const y = expiryYmd(expiry);
  if (!y) return null;
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
  const today = istYmd(nowMs);
  return Math.round((Date.parse(y + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY_MS);
}

function renewEligibility(daysLeft) {
  if (daysLeft == null) return 'TOO_LATE';
  if (daysLeft >= 0) return 'CAN_RENEW';
  if (daysLeft >= -LATE_RENEW_DAYS) return 'LATE_RENEW';
  return 'TOO_LATE';
}

// ---------------- plan names ----------------
const DURATION_WORD = '(?:m|mo|mos|mon|mth|mths|month|months|d|day|days|w|wk|wks|week|weeks|y|yr|yrs|year|years)';
const DURATION_RE = new RegExp('\\b\\d+\\s*-?\\s*' + DURATION_WORD + '\\b', 'g');
const PERIOD_RE = /\b(?:half[\s-]*yearly|monthly|yearly|annual|annually|quarterly|weekly|daily)\b/g;

/** "Sharing 2 Devices 3M" → "sharing 2 devices": the plan name without its duration. */
function planVariant(plan) {
  return String(plan || '').toLowerCase()
    .replace(/(\d+)\s*devices?\b/g, '$1 devices')
    .replace(DURATION_RE, ' ')
    .replace(PERIOD_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/** Devices in a plan name ("2 Devices 1M" → 2); 1 when the name does not say. Same rule as createOrder. */
function planDevices(plan) { return Number((String(plan || '').match(/(\d+)\s*device/i) || [])[1]) || 1; }

/**
 * Plan names (of the SAME service, active) that a subscription on `subPlan` may renew into.
 *  1. plans with the same kind (planVariant) — the normal case, duration changes only;
 *  2. the kind is unknown (old name, no live plan of that kind): plans with the same number of devices;
 *  3. still none: every plan of the service (a customer never sees an empty renew page).
 */
function renewPlanChoices(subPlan, planNames) {
  const names = [];
  for (const p of planNames || []) { const n = String(p == null ? '' : p).trim(); if (n && !names.includes(n)) names.push(n); }
  const v = planVariant(subPlan);
  const same = names.filter((n) => planVariant(n) === v);
  if (same.length) return same;
  const dev = planDevices(subPlan);
  const byDevices = names.filter((n) => planDevices(n) === dev);
  if (byDevices.length) return byDevices;
  return names;
}

module.exports = { LATE_RENEW_DAYS, istYmd, expiryYmd, daysLeftIst, renewEligibility, planVariant, planDevices, renewPlanChoices };
