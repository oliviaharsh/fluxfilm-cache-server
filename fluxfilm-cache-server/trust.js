/**
 * FluxFilm - 🏆 why trust us: the numbers, what is running right now, and the journey (owner request, 1 Oct 2026).
 *
 * The home screen already had four trust cards — Instant Access, Cheaper Plans, Safe Login, WhatsApp Verified —
 * and every one of them is a CLAIM. Owner: *"can we add our orders count and some proofs or some journey section
 * to increase trust"*. So this is the evidence next to the claims.
 *
 * Three kinds of number, and they are not the same kind, which is the whole point of keeping them apart:
 *
 *   1. The HEADLINE is the owner's own claim ("5,000+ orders since 2024"). FluxFilm ran on paper and then on a
 *      Google Sheet long before MySQL existed, so the true lifetime figure is bigger than anything this database
 *      can prove. It is typed in admin, it is never computed, and the admin screen prints what the database CAN
 *      prove right beside the box so the owner is never overstating by accident.
 *   2. The LIVE numbers are counted from MySQL every time (cached 5 minutes): plans running now, customers with a
 *      live plan, how many customers come back. These are true to the row and cannot go stale.
 *   3. The TICKER and the service badges are the same live data, shown as activity.
 *
 * 🔒 Privacy: the ticker carries a service, a plan and "4 min ago" — never a name, a phone, an email, a city or an
 * order id. Nothing on this endpoint can identify a customer, because it is served to anybody who opens the site,
 * logged in or not. Anything that would need a name belongs in reviews, where the customer chooses to be quoted.
 *
 * ⚠️ Every query here reads ONE table. Phone columns are never compared across tables in SQL — the live lesson
 * (27 Sep) is that `orders` and `subscriptions` do not share a collation and MariaDB refuses the join. The
 * "customers who come back" figure groups `orders` by itself and counts in SQL; nothing is matched across tables.
 *
 * No schema change: app_settings 'trust'. Fails soft everywhere — a missing table, an unreadable setting or a slow
 * query answers with whatever it has and the home screen simply shows less. A trust section that breaks the home
 * page would be a poor way to build trust.
 *
 * Storefront action:  getTrust                       (public, no login)
 * Admin:              GET/POST /admin/api/trust      (the claim, the journey, the switches)
 */
const db = require('./db');

const KEY = 'trust';
const CACHE_MS = 5 * 60e3;
const TICKER_MAX = 12;
const SERVICES_MAX = 12;
const JOURNEY_MAX = 8;

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
/** Owner-typed text that lands on a public page: no tags, no quotes, length capped. */
const clean = (v, max) => s(v).replace(/[<>]/g, '').slice(0, max);
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e && e.message));

// ⏸️ The journey ships EMPTY and switched OFF (owner, 1 Oct 2026: "hold on to journey page - we will
// first plan that more"). It had a four-step draft written by me, and I only genuinely knew two dates: FluxFilm
// was already serving customers in January 2024, and shop.fluxfilm.in went live on 14 Sep 2026. Shipping a
// plausible-looking middle that nobody had checked, on a section whose whole job is to be TRUSTED, is the one
// thing this feature must not do. So there is nothing to accidentally switch on: the owner writes the steps in
// admin and turns it on when they are right.
const DEFAULT_JOURNEY = Object.freeze([]);

const DEFAULTS = Object.freeze({
  enabled: true,
  lifetimeOrders: '5,000+',
  since: '2024',
  note: '',
  showTicker: true,
  showServices: true,
  showJourney: false,
  journey: DEFAULT_JOURNEY.map((x) => Object.assign({}, x)),
});

// ---------------- settings ----------------
async function readKey() {
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]); return r.length ? r[0].value : null; }
  catch (e) { if (missingTable(e)) return null; throw e; }
}
function validate(input) {
  const i = input || {}; const errors = [];
  const out = Object.assign({}, DEFAULTS);
  for (const k of ['enabled', 'showTicker', 'showServices', 'showJourney']) {
    if (i[k] !== undefined) out[k] = i[k] === true || i[k] === 1 || String(i[k]).toLowerCase() === 'true';
  }
  // The headline is a claim, not a computed number, so it is text: "5,000+", "5000+", "a few thousand".
  if (i.lifetimeOrders !== undefined) {
    const v = clean(i.lifetimeOrders, 20);
    if (v && !/^[0-9][0-9,]*\+?$/.test(v)) errors.push('Orders should look like 5,000+ — digits, commas and an optional +.');
    else out.lifetimeOrders = v;
  }
  if (i.since !== undefined) {
    const v = clean(i.since, 4);
    if (v && !/^(20)\d\d$/.test(v)) errors.push('The year should be four digits, like 2024.');
    else out.since = v;
  }
  if (i.note !== undefined) out.note = clean(i.note, 140);
  if (i.journey !== undefined) {
    if (!Array.isArray(i.journey)) errors.push('The journey must be a list.');
    else {
      out.journey = i.journey.slice(0, JOURNEY_MAX).map((x) => ({
        when: clean((x || {}).when, 20), title: clean((x || {}).title, 60), text: clean((x || {}).text, 200),
      })).filter((x) => x.when || x.title || x.text);
    }
  }
  return { ok: !errors.length, settings: out, errors };
}
let setCache = null, setAt = 0;
async function getSettings(fresh) {
  if (!fresh && setCache && Date.now() - setAt < 30e3) return setCache;
  let saved = {}; const v = await readKey();
  if (v) { try { saved = JSON.parse(v) || {}; } catch (_) { saved = {}; } }
  setCache = validate(saved).settings; setAt = Date.now();
  return setCache;
}
async function saveSettings(input) {
  const v = validate(input);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  try {
    await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(v.settings)]);
  } catch (e) { if (missingTable(e)) return { ok: false, needsSchema: true, message: 'app_settings is missing — run the schema files first.' }; throw e; }
  setCache = null; liveCache = null;
  return { ok: true, settings: v.settings };
}

// ---------------- the live numbers (one table per query) ----------------
const one = async (sql, params, fallback) => {
  try { const r = await db.query(sql, params || []); return r && r[0] ? r[0] : (fallback || {}); }
  catch (e) { if (missingTable(e)) return fallback || {}; throw e; }
};
const many = async (sql, params) => {
  try { return (await db.query(sql, params || [])) || []; }
  catch (e) { if (missingTable(e)) return []; throw e; }
};

/** "4 min ago" / "3 hours ago" / "yesterday" — vague on purpose, so a time can never pin down a person. */
function ago(v, now) {
  const t = Date.parse(s(v).replace(' ', 'T'));
  if (isNaN(t)) return '';
  const mins = Math.floor(((now || Date.now()) - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  const months = Math.floor(days / 30);
  return months + (months === 1 ? ' month ago' : ' months ago');
}

let liveCache = null, liveAt = 0;
/** Counted from MySQL, cached 5 minutes. Never throws: a figure it cannot read is simply left out. */
async function live(fresh, now) {
  if (!fresh && liveCache && Date.now() - liveAt < CACHE_MS) return liveCache;
  const at = now || Date.now();
  const [running, withPlan, paid, repeat, services, recent] = await Promise.all([
    one("SELECT COUNT(*) n FROM subscriptions WHERE UPPER(COALESCE(status, '')) = 'ACTIVE'"),
    one("SELECT COUNT(DISTINCT phone_norm) n FROM subscriptions WHERE UPPER(COALESCE(status, '')) = 'ACTIVE' AND COALESCE(phone_norm, '') <> ''"),
    one("SELECT COUNT(*) n, SUM(UPPER(COALESCE(order_type, '')) = 'RENEW') renewals FROM orders WHERE UPPER(COALESCE(status, '')) = 'PAID'"),
    // Grouped on orders alone - no phone column is ever compared across tables (MariaDB collation).
    one("SELECT COUNT(*) total, SUM(n > 1) backs FROM (SELECT phone_norm, COUNT(*) n FROM orders WHERE UPPER(COALESCE(status, '')) = 'PAID' AND COALESCE(phone_norm, '') <> '' GROUP BY phone_norm) t"),
    many("SELECT service, COUNT(*) n FROM subscriptions WHERE UPPER(COALESCE(status, '')) = 'ACTIVE' AND COALESCE(service, '') <> '' GROUP BY service ORDER BY n DESC LIMIT " + SERVICES_MAX),
    // 🔒 service, plan and a time. No name, no phone, no order id - this is served to anybody who opens the site.
    many("SELECT service, plan, order_type, COALESCE(verified_at, created_at_sheet) at FROM orders WHERE UPPER(COALESCE(status, '')) = 'PAID' AND COALESCE(verified_at, created_at_sheet) IS NOT NULL ORDER BY COALESCE(verified_at, created_at_sheet) DESC LIMIT " + TICKER_MAX),
  ]);
  const total = num(repeat.total), backs = num(repeat.backs);
  liveCache = {
    running: num(running.n),
    customersWithPlan: num(withPlan.n),
    paidOrders: num(paid.n),
    renewals: num(paid.renewals),
    customers: total,
    comeBackPct: total > 0 ? Math.round((backs / total) * 100) : 0,
    services: services.map((r) => ({ service: s(r.service), n: num(r.n) })).filter((r) => r.service && r.n > 0),
    recent: recent.map((r) => ({
      service: s(r.service), plan: s(r.plan),
      kind: s(r.order_type).toUpperCase() === 'RENEW' ? 'renewed' : 'started',
      ago: ago(r.at, at),
    })).filter((r) => r.service && r.ago),
  };
  liveAt = Date.now();
  return liveCache;
}

// ---------------- what the storefront gets ----------------
/** Public. Never throws: on any trouble it answers { ok: true, on: false } and the home screen shows nothing. */
async function getTrust() {
  try {
    const cfg = await getSettings();
    if (!cfg.enabled) return { ok: true, on: false };
    const l = await live();
    const out = {
      ok: true, on: true,
      headline: cfg.lifetimeOrders ? {
        orders: cfg.lifetimeOrders, since: cfg.since,
        text: cfg.lifetimeOrders + ' orders delivered' + (cfg.since ? ' since ' + cfg.since : ''),
      } : null,
      note: cfg.note,
      live: {
        running: l.running,
        customersWithPlan: l.customersWithPlan,
        comeBackPct: l.comeBackPct,
        renewals: l.renewals,
      },
      services: cfg.showServices ? l.services : [],
      recent: cfg.showTicker ? l.recent : [],
      // Off, or written but empty, both mean: draw no journey at all. An empty heading is worse than none.
      journey: cfg.showJourney ? cfg.journey : [],
    };
    return out;
  } catch (e) {
    console.log('[trust] could not build the trust section:', e.message);
    return { ok: true, on: false };
  }
}

// ---------------- admin ----------------
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/trust', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [cfg, l] = [await getSettings(true), await live(true)];
      res.json({
        ok: true, settings: cfg, live: l,
        // What the DATABASE can prove, printed next to the claim the owner types, so the headline is always an
        // informed choice. MySQL only holds what was imported - the Sheet and notebook years are not in it.
        proved: {
          paidOrders: l.paidOrders, customers: l.customers, running: l.running,
          note: 'MySQL can prove ' + l.paidOrders + ' paid orders from ' + l.customers + ' customers. The years before the '
            + 'import are not in it, so the real lifetime number is higher — that is why the headline is yours to type.',
        },
        preview: await getTrust(),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/trust', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const before = await getSettings(true);
      const r = await saveSettings(Object.assign({}, before, req.body || {}));
      if (!r.ok) return res.status(r.needsSchema ? 409 : 400).json(r);
      const bits = [];
      if (before.lifetimeOrders !== r.settings.lifetimeOrders || before.since !== r.settings.since) bits.push('headline "' + r.settings.lifetimeOrders + ' orders since ' + r.settings.since + '"');
      if (before.enabled !== r.settings.enabled) bits.push(r.settings.enabled ? 'switched ON' : 'switched OFF');
      if (JSON.stringify(before.journey) !== JSON.stringify(r.settings.journey)) bits.push('journey (' + r.settings.journey.length + ' steps)');
      audit.record(req, {
        action: 'trust.save', entity: 'setting', id: KEY,
        summary: ('🏆 Trust section: ' + (bits.join(' · ') || 'saved')).slice(0, 500),
        details: { settings: r.settings },
      });
      res.json(Object.assign({ ok: true, message: '🏆 Saved.' }, r, { preview: await getTrust() }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  getTrust, getSettings, saveSettings, validate, live, mount, ago,
  KEY, DEFAULTS, DEFAULT_JOURNEY, CACHE_MS, TICKER_MAX, SERVICES_MAX, JOURNEY_MAX,
  _internal: { reset: () => { setCache = null; liveCache = null; setAt = 0; liveAt = 0; } },
};
