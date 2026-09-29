/**
 * FluxFilm — coupons that have expired but still say Active.
 *
 * Owner, 30 Sep 2026: "make sure it automatically becomes inactive at that time because our existing coupons
 * which have expired i think still shows active".
 *
 * He was right, and it was worse than cosmetic. Nothing ever cleared the Active flag when a coupon's date went
 * past. On the live database five coupons were Active = TRUE with a date already gone, and THREE of those had
 * ShowInProfile = TRUE (FGUR2X6DH, OFFCAMPUSXX10, ZEEDISC30). reads.js getActiveCouponsForCustomer filtered on
 * Active / ShowInProfile / AllowedPhones / PerUserLimit and **never on the expiry date** — so a customer opened
 * Account -> coupons, was shown a dead coupon as if it were theirs to use, typed it at checkout and was told
 * "Coupon expired." order.js was right the whole time and no money was ever lost; the list the customer was
 * reading was the thing that lied.
 *
 * Two fixes that do not depend on each other, deliberately:
 *   1. reads.js now hides an expired coupon whatever the flag says. Correctness must NOT wait for a timer to
 *      have run. If this module never ran once, no customer would still be shown a dead coupon.
 *   2. sweep() clears the flag on a 15-minute tick, so the admin list, the flag and checkout agree.
 *
 * WARNING - expiryMs() is THE single definition of when a coupon dies. order.js, reads.js and the sweep all
 * call it and none of them may re-implement it. A bare 'YYYY-MM-DD' means the END of that day in India
 * (23:59:59 +05:30). Writing new Date('2026-09-30') instead gives UTC midnight = 05:30 IST and kills the
 * coupon about eighteen hours early - that exact bug was already fixed once in order.js, and the only reason
 * it can not come back a third time is that there is now one copy of the rule.
 */
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When does this Expiry value stop being valid, in epoch ms?
 * 0 means "never expires" - no date at all, or something we cannot read. Refusing to guess is deliberate:
 * a coupon nobody can date is left alone rather than switched off by a misreading.
 */
function expiryMs(v) {
  const ev = s(v);
  if (!ev) return 0;
  const d = DATE_ONLY.test(ev) ? new Date(ev + 'T23:59:59+05:30') : new Date(ev.replace(' ', 'T'));
  const t = d.getTime();
  return isNaN(t) ? 0 : t;
}

/** Has it died yet? Same comparison as order.js couponDiscount: strictly past the last valid moment. */
function isExpired(v, now) {
  const t = expiryMs(v);
  return !!t && t < (now == null ? Date.now() : +now);
}

const rawOf = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch (e) { return {}; }
};
const codeOf = (raw, row) => s((raw.CouponCode != null ? raw.CouponCode : '') || (raw.Code != null ? raw.Code : '') || (row && row.code) || '').toUpperCase();

/**
 * Every coupon whose flag says Active but whose date has gone. Read through raw_json, because that is what
 * order.js validates against - a row whose typed column and raw_json disagree is reported by whichever of the
 * two still claims to be live, so the sweep cannot leave half a coupon behind.
 */
async function expiredActive(query, now) {
  const t = now == null ? Date.now() : +now;
  let rows = [];
  try { rows = await query('SELECT code, expiry, active, raw_json FROM coupons', []); } catch (e) {
    return { ok: false, message: e.message, rows: [] };
  }
  const out = [];
  for (const r of rows) {
    const raw = rawOf(r.raw_json);
    const flagRaw = s(raw.Active).toUpperCase() === 'TRUE';
    const flagCol = s(r.active).toUpperCase() === 'TRUE';
    if (!flagRaw && !flagCol) continue;
    // The date can live in either place too; a row with no raw_json still has the column.
    const when = s(raw.Expiry) || s(r.expiry);
    if (!isExpired(when, t)) continue;
    const code = codeOf(raw, r);
    if (!code) continue;
    out.push({
      code,
      expiry: when,
      expiredAtMs: expiryMs(when),
      description: s(raw.Description),
      showInProfile: s(raw.ShowInProfile).toUpperCase() !== 'FALSE',
      inRawJson: flagRaw,
      inColumn: flagCol,
    });
  }
  out.sort((a, b) => a.expiredAtMs - b.expiredAtMs);
  return { ok: true, rows: out };
}

/**
 * Switch off everything that has expired. Typed column AND raw_json in the one statement, because order.js
 * reads raw_json only while the admin list reads the column - flipping one and not the other is how a coupon
 * comes to look right in admin and behave differently at checkout.
 */
async function sweep(opts) {
  const o = opts || {};
  const query = o.query || ((sql, p) => db.query(sql, p));
  const now = o.now == null ? Date.now() : +o.now;
  const found = await expiredActive(query, now);
  if (!found.ok) return { ok: false, message: found.message, cleared: [] };
  const cleared = [];
  for (const c of found.rows) {
    try {
      const r = await query(
        "UPDATE coupons SET active = 'FALSE', raw_json = IF(raw_json IS NULL, NULL, JSON_SET(raw_json, '$.Active', 'FALSE')) WHERE UPPER(code) = ? LIMIT 1",
        [c.code]);
      if (r && r.affectedRows) cleared.push(c);
      else console.log('[couponexpiry] no row updated for ' + c.code);
    } catch (e) { console.log('[couponexpiry] could not switch off ' + c.code + ': ' + e.message); }
  }
  if (cleared.length) console.log('[couponexpiry] switched off ' + cleared.length + ' expired coupon(s): ' + cleared.map((x) => x.code).join(', '));
  return { ok: true, cleared, checked: found.rows.length };
}

/**
 * Fifteen minutes, not an hour: the owner wants a sale coupon to be visibly over at 23:59, and an hourly tick
 * could leave it reading Active until one in the morning. Nobody can USE it in that gap - order.js goes by the
 * date - but "the sale is over" should not be something only the checkout knows.
 */
let timer = null;
function startTimer() {
  if (timer) return;
  const tick = () => sweep().catch((e) => console.log('[couponexpiry] sweep failed:', e.message));
  const first = setTimeout(tick, 60e3);
  if (first.unref) first.unref();
  timer = setInterval(tick, 15 * 60e3);
  if (timer.unref) timer.unref();
}

function mount(app, deps) {
  const { auth } = deps;
  const audit = (deps && deps.audit) || { record: () => {} };
  const query = (deps && deps.db && deps.db.query) ? (sql, p) => deps.db.query(sql, p) : (sql, p) => db.query(sql, p);
  const fail = (res, e) => res.status((e && e.status) || 500).json({ ok: false, message: String((e && e.message) || e) });

  // What is sitting there expired but still flagged on. Read-only: safe to look at any time.
  app.get('/admin/api/coupons/expired', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await expiredActive(query, Date.now());
      if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
      res.json({ ok: true, rows: r.rows, total: r.rows.length, inProfile: r.rows.filter((x) => x.showInProfile).length });
    } catch (e) { fail(res, e); }
  });

  // Tidy up now rather than waiting for the tick.
  app.post('/admin/api/coupons/sweep', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await sweep({ query });
      if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
      if (r.cleared.length) {
        audit.record(req, {
          action: 'coupon.expired.sweep', entity: 'coupon', id: r.cleared.map((x) => x.code).join(','),
          summary: 'Switched off ' + r.cleared.length + ' expired coupon(s)', details: r.cleared,
        });
      }
      res.json({ ok: true, cleared: r.cleared, total: r.cleared.length });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, sweep, startTimer, expiryMs, isExpired, _internal: { expiredActive, rawOf, codeOf } };
