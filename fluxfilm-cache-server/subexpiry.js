/**
 * FluxFilm - mark subscriptions EXPIRED once they have really ended (replaces the old Apps Script release job).
 *
 * A plan keeps its slot (Netflix profile / Prime device) until BOTH its expiry and its release date have passed
 * — or until the owner ticks 🚪 removed after it has ended, which gives the seat back at once (fulfill.js
 * OCC_ACTIVE). Only then is it marked EXPIRED, so this still never frees a slot early and never disagrees with
 * stock: it marks exactly what OCC_ACTIVE has already stopped counting. Renewing later still works (renewal sets
 * ACTIVE again).
 *
 *   run()         → { ok, expired }  (every hour + once at start)
 *   startTimer()
 */
const db = require('./db');

const ENDED = "UPPER(status) = 'ACTIVE' AND expiry_date IS NOT NULL AND expiry_date < NOW() "
  + "AND (release_eligible_at IS NULL OR release_eligible_at < NOW() OR COALESCE(removed, 0) = 1)";

async function run() {
  const r = await db.query("UPDATE subscriptions SET status = 'EXPIRED', raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.Status', 'EXPIRED')) WHERE " + ENDED, []);
  const expired = (r && r.affectedRows) || 0;
  if (expired) console.log('[subexpiry] marked', expired, 'ended subscription(s) EXPIRED');
  return { ok: true, expired };
}

let timer = null;
function startTimer() {
  if (timer) return;
  const tick = () => run().catch((e) => console.log('[subexpiry] failed:', e.message));
  setTimeout(tick, 30e3);
  timer = setInterval(tick, 60 * 60e3);
  if (timer.unref) timer.unref();
}

module.exports = { run, startTimer, ENDED };
