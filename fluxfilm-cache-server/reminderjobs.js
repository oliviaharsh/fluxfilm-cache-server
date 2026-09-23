/**
 * FluxFilm — the three reminder jobs the owner asked for on 23 Sep 2026 (admin → 🔔 Notifications → ✉️ Email jobs).
 *
 *   1. ABANDONED  — an order made and never paid: ONE reminder, `afterHours` later (2). Push if that customer has
 *                   notifications on, email if not. Never twice for the same order, ever.
 *   2. EXPIRY_MAIL— "your plan is ending" by EMAIL, to the customers pushreminders.js cannot reach, i.e. the ones
 *                   with no device subscribed. Email fills the gap instead of doubling up, so nobody is told about
 *                   the same expiry twice on the same day.
 *   3. WINBACK    — a customer whose plan ended `afterDays` ago (30) and who has not come back: one email with a
 *                   discount code, and not again for `everyDays` (90).
 *
 *   4. WHATSNEW   — the only one that is not a reminder: "here is something worth watching, and by the way the
 *                   shop is automatic now". Goes to customers who have bought before, a batch a day, and not
 *                   again for everyDays (30). It cannot send with no title set, so it can never go out empty.
 *
 * 🔒 These send REAL messages to REAL customers, so:
 *   · every job ships OFF. Nothing goes out until the owner switches that job on.
 *   · there is a preview (what would go, to whom, sending nothing) and a "send one to me" before that.
 *   · `maxPerRun` caps a run, so a first switch-on can never mail hundreds of people at once.
 *   · sending hours only (quietStart–quietEnd, India time).
 *   · every send is written to reminder_log and checked first — the same table and habit as pushreminders.js.
 *
 * reminder_log has no column for "which order" or "which customer", and adding one would mean the owner running
 * SQL by hand, so the existing `sub_id` column carries the key and `kind` says what the key means:
 *   kind ABANDONED → sub_id is the ORDER id · kind WINBACK → sub_id is the customer's PHONE · the expiry kinds → a sub id.
 *
 * Settings live in app_settings ('reminder_jobs'). No schema change.
 *
 *   run(now)            → runs whichever jobs are on
 *   preview(job, now)   → { candidates, total, sample }  — reads only, sends nothing
 *   sendTest(job, to)   → one message to the owner
 */
const db = require('./db');

const KEY = 'reminder_jobs';
const DAY = 86400000;
const HOUR = 3600000;

const DEFAULTS = {
  abandoned: { on: false, afterHours: 2, withinHours: 48 },
  expiryMail: { on: false, daysBefore: [3, 1], onExpiryDay: true, afterExpiry: true, onlyWithoutPush: true },
  // withCode false = still write to lapsed customers, but give nothing away. The owner's switch, 23 Sep 2026.
  // perDay: how many lapsed customers to write to in a DAY. The list is worked through a batch at a time
  // rather than in one burst, so 113 people become six quiet days instead of one loud afternoon.
  // startOn: nothing goes out before this DAY (India time), so the job can be armed today and start later.
  // codeUntil + code2: a coupon has an expiry, and a batched job runs for days. Sending 114 people a code over
  // six days means the last batches can outlive the code. So the first code is used up to and including
  // codeUntil, and code2 from the next morning. Owner, 24 Sep 2026: "start winback on 30 sep and will give last
  // batch diff code - 10% off".
  winback: {
    on: false, withCode: true, afterDays: 30, everyDays: 90, perDay: 20,
    startOn: '', code: '', percent: 0, codeUntil: '', code2: '', percent2: 0,
  },
  // 📢 What is worth watching + how the shop works now. The title is seeded with an EXAMPLE so the preview shows
  // something real on day one; the owner types whatever is actually new before switching it on. Nothing here is a
  // claim about a release date, on purpose — 'badge' is free text the owner owns.
  whatsnew: {
    on: false, perDay: 40, everyDays: 30, onlyActive: false,
    title: 'Laapataa Ladies', service: 'Netflix', badge: 'Worth a watch',
    line: 'Two brides, one train, and the funniest mix-up in years.',
  },
  quietStart: 9,
  quietEnd: 21,
  maxPerRun: 30,
};

const s = (v) => String(v == null ? '' : v).trim();
const esc = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const SITE = () => String(process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
const firstName = (n) => s(n).split(/\s+/)[0] || '';

const dep = (deps, name, mod) => (deps && deps[name]) || require(mod);
const q = (deps, sql, p) => ((deps && deps.query) || db.query)(sql, p || []);

/** India time, whatever the server thinks it is. server.js pins TZ=Asia/Kolkata, but never rely on that alone. */
function istHour(now) {
  const d = new Date(now);
  const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
  return ist.getHours();
}

/** Today in India, as YYYY-MM-DD — the form the date settings are written in. */
function istDay(now) {
  const d = new Date(now);
  const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
  return ist.getFullYear() + '-' + String(ist.getMonth() + 1).padStart(2, '0') + '-' + String(ist.getDate()).padStart(2, '0');
}
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * Which code win-back is offering TODAY, and whether it is offering one at all.
 * → { withCode, code, percent, phase } — phase 'first' | 'second' | 'none'
 */
function codeForDay(cfg, now) {
  if (cfg.withCode === false) return { withCode: false, code: '', percent: 0, phase: 'none' };
  const today = istDay(now);
  const past = isDay(cfg.codeUntil) && today > cfg.codeUntil;
  const code = past ? s(cfg.code2) : s(cfg.code);
  const percent = Number(past ? cfg.percent2 : cfg.percent) || 0;
  return { withCode: true, code, percent, phase: past ? 'second' : 'first' };
}

// ── settings ──────────────────────────────────────────────────────────────────────────────────────────────────
async function getSettings(deps) {
  let v = null;
  try {
    const r = await q(deps, 'SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]);
    v = r && r[0] ? JSON.parse(r[0].value || 'null') : null;
  } catch (_) { v = null; }
  const o = v && typeof v === 'object' ? v : {};
  return {
    abandoned: Object.assign({}, DEFAULTS.abandoned, o.abandoned || {}),
    expiryMail: Object.assign({}, DEFAULTS.expiryMail, o.expiryMail || {}),
    winback: Object.assign({}, DEFAULTS.winback, o.winback || {}),
    // The live settings row was written before this job existed, so it has no whatsnew at all — the defaults
    // fill it in rather than the run finding undefined.
    whatsnew: Object.assign({}, DEFAULTS.whatsnew, o.whatsnew || {}),
    quietStart: num(o.quietStart, DEFAULTS.quietStart),
    quietEnd: num(o.quietEnd, DEFAULTS.quietEnd),
    maxPerRun: Math.min(200, Math.max(1, num(o.maxPerRun, DEFAULTS.maxPerRun))),
  };
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; }

async function saveSettings(input, deps) {
  const cur = await getSettings(deps);
  const i = input || {};
  const next = JSON.parse(JSON.stringify(cur));
  const errs = [];

  if (i.abandoned) {
    if (i.abandoned.on != null) next.abandoned.on = !!i.abandoned.on;
    if (i.abandoned.afterHours != null) next.abandoned.afterHours = Math.min(48, Math.max(1, num(i.abandoned.afterHours, 2)));
    if (i.abandoned.withinHours != null) next.abandoned.withinHours = Math.min(240, Math.max(2, num(i.abandoned.withinHours, 48)));
    if (next.abandoned.withinHours <= next.abandoned.afterHours) errs.push('The window has to be longer than the wait.');
  }
  if (i.expiryMail) {
    const e = i.expiryMail;
    if (e.on != null) next.expiryMail.on = !!e.on;
    if (e.onExpiryDay != null) next.expiryMail.onExpiryDay = !!e.onExpiryDay;
    if (e.afterExpiry != null) next.expiryMail.afterExpiry = !!e.afterExpiry;
    if (e.onlyWithoutPush != null) next.expiryMail.onlyWithoutPush = !!e.onlyWithoutPush;
    if (e.daysBefore != null) {
      const list = (Array.isArray(e.daysBefore) ? e.daysBefore : s(e.daysBefore).split(/[,\s]+/))
        .map((x) => num(x, 0)).filter((x) => x >= 1 && x <= 30);
      next.expiryMail.daysBefore = [...new Set(list)].sort((a, b) => b - a).slice(0, 4);
    }
  }
  if (i.winback) {
    const w = i.winback;
    if (w.on != null) next.winback.on = !!w.on;
    if (w.withCode != null) next.winback.withCode = !!w.withCode;
    if (w.afterDays != null) next.winback.afterDays = Math.min(365, Math.max(7, num(w.afterDays, 30)));
    if (w.everyDays != null) next.winback.everyDays = Math.min(365, Math.max(14, num(w.everyDays, 90)));
    if (w.percent != null) next.winback.percent = Math.min(90, Math.max(0, num(w.percent, 0)));
    if (w.perDay != null) next.winback.perDay = Math.min(500, Math.max(1, num(w.perDay, 20)));
    const cleanCode = (v) => s(v).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
    const cleanDay = (v) => (isDay(s(v)) ? s(v) : '');
    if (w.code != null) next.winback.code = cleanCode(w.code);
    if (w.code2 != null) next.winback.code2 = cleanCode(w.code2);
    if (w.percent2 != null) next.winback.percent2 = Math.min(90, Math.max(0, num(w.percent2, 0)));
    if (w.startOn != null) { if (s(w.startOn) && !isDay(s(w.startOn))) errs.push('The start date has to be a day like 2026-09-30.'); next.winback.startOn = cleanDay(w.startOn); }
    if (w.codeUntil != null) { if (s(w.codeUntil) && !isDay(s(w.codeUntil))) errs.push('The code-changes date has to be a day like 2026-10-02.'); next.winback.codeUntil = cleanDay(w.codeUntil); }
    // A code is only demanded when one is actually being offered.
    if (next.winback.on && next.winback.withCode && !next.winback.code) errs.push('Set the discount code, or turn off "offer a discount code".');
    // A handover date with nothing to hand over to would quietly start sending an empty code.
    if (next.winback.withCode && next.winback.codeUntil && !next.winback.code2) errs.push('Set the second code, or clear the date the code changes.');
    if (next.winback.codeUntil && next.winback.startOn && next.winback.codeUntil < next.winback.startOn) errs.push('The code cannot change before the job has started.');
  }
  if (i.whatsnew) {
    const w = i.whatsnew;
    if (w.on != null) next.whatsnew.on = !!w.on;
    if (w.onlyActive != null) next.whatsnew.onlyActive = !!w.onlyActive;
    if (w.perDay != null) next.whatsnew.perDay = Math.min(500, Math.max(1, num(w.perDay, 40)));
    if (w.everyDays != null) next.whatsnew.everyDays = Math.min(365, Math.max(7, num(w.everyDays, 30)));
    if (w.title != null) next.whatsnew.title = s(w.title).slice(0, 80);
    if (w.service != null) next.whatsnew.service = s(w.service).slice(0, 40);
    if (w.badge != null) next.whatsnew.badge = s(w.badge).slice(0, 40);
    if (w.line != null) next.whatsnew.line = s(w.line).slice(0, 160);
    // An announcement with nothing to announce is not a thing worth emailing 100 people.
    if (next.whatsnew.on && !next.whatsnew.title) errs.push('Type what you are announcing before switching this on.');
  }
  if (i.quietStart != null) next.quietStart = num(i.quietStart, cur.quietStart);
  if (i.quietEnd != null) next.quietEnd = num(i.quietEnd, cur.quietEnd);
  if (i.maxPerRun != null) next.maxPerRun = Math.min(200, Math.max(1, num(i.maxPerRun, cur.maxPerRun)));
  if (next.quietStart < 0 || next.quietStart > 23 || next.quietEnd < 1 || next.quietEnd > 24 || next.quietStart >= next.quietEnd) {
    errs.push('Sending hours must be like 9 to 21 (start before end).');
  }
  if (errs.length) throw Object.assign(new Error(errs[0]), { status: 400 });

  await q(deps, 'INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(next)]);
  return { ok: true, settings: next };
}

// ── the log we check before every send ────────────────────────────────────────────────────────────────────────
async function alreadySent(deps, key, kind, expiry, sinceMs, now) {
  const args = [s(key).slice(0, 40), kind];
  let sql = 'SELECT 1 AS x FROM reminder_log WHERE sub_id = ? AND kind = ?';
  if (expiry) { sql += ' AND expiry_date = ?'; args.push(expiry); }
  // Measured from the run's own clock, not the wall clock: a job asked to think it is a different day must
  // actually think so, or "do not write to them again for 90 days" quietly becomes "never again".
  if (sinceMs) { sql += ' AND ts > ?'; args.push(new Date((now || Date.now()) - sinceMs)); }
  const r = await q(deps, sql + ' LIMIT 1', args);
  return !!(r && r.length);
}
/** How many of this kind actually went out in the last window — what the daily batch size is measured against. */
async function sentSince(deps, kind, sinceMs, now) {
  const r = await q(deps, 'SELECT COUNT(*) AS n FROM reminder_log WHERE kind = ? AND ok = 1 AND ts > ?',
    [kind, new Date((now || Date.now()) - sinceMs)]);
  return Number(r && r[0] && r[0].n) || 0;
}
async function writeLog(deps, key, channel, kind, expiry, ok, note) {
  try {
    await q(deps, 'INSERT INTO reminder_log (ts, sub_id, channel, kind, expiry_date, ok, note) VALUES (NOW(), ?, ?, ?, ?, ?, ?)',
      [s(key).slice(0, 40), channel, kind, expiry || null, ok ? 1 : 0, s(note).slice(0, 300) || null]);
  } catch (e) { if (!missingTable(e)) console.log('[reminderjobs] log write failed:', e.message); }
}

// ── the emails ────────────────────────────────────────────────────────────────────────────────────────────────
function shell(inner) {
  return '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' + inner +
    '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';
}
function button(href, label) {
  return '<p><a href="' + esc(href) + '" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">' + esc(label) + '</a></p>' +
    '<p style="color:#94a3b8;font-size:12px">Or open ' + esc(href) + '</p>';
}

/** 1 · "you left this behind". Never says "hurry" — it is a reminder, not a chase. */
function abandonedEmail(p) {
  const link = SITE() + '/?source=reminder&order=' + encodeURIComponent(s(p.orderId));
  return {
    subject: '🛒 Your FluxFilm ' + s(p.service) + ' order is still waiting',
    html: shell('<h2 style="color:#b45309;margin-bottom:4px">🛒 You left something behind</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + esc(firstName(p.name) || 'there') + ',</p>' +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px">' +
      '<b>' + esc(p.service) + '</b>' + (s(p.plan) ? ' — ' + esc(p.plan) : '') +
      (p.amount ? '<br>Order ' + esc(p.orderId) + ' · <b>₹' + esc(p.amount) + '</b>' : '<br>Order ' + esc(p.orderId)) + '</div>' +
      '<p style="color:#475569;font-size:14px">Your order is still open — nothing has been taken from you. Pick it up whenever you like:</p>' +
      button(link, 'Finish my order')),
    link,
  };
}

/**
 * 3 · "come back". With a code, or without one: withCode=false still writes to a lapsed customer but gives
 * nothing away, and then the mail never mentions a discount at all rather than promising a vague one.
 * The code is NAMED here, never invented — it has to exist in 🎟️ Coupons already.
 */
function winbackEmail(p) {
  const link = SITE() + '/?source=winback';
  const withCode = p.withCode !== false && !!s(p.code);
  const off = Number(p.percent) > 0 ? Number(p.percent) + '% off' : 'a discount';
  return {
    subject: withCode ? '💚 We miss you at FluxFilm — ' + off + ' when you come back' : '💚 We miss you at FluxFilm',
    html: shell('<h2 style="color:#16a34a;margin-bottom:4px">💚 It has been a while</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + esc(firstName(p.name) || 'there') + ',</p>' +
      '<p style="color:#475569;font-size:14px">Your ' + esc(p.service || 'FluxFilm') + ' plan ended a while back and we would love to have you watching again.</p>' +
      (withCode
        ? '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px;margin:14px 0;text-align:center">' +
          '<div style="color:#15803d;font-size:13px">Use this code at checkout</div>' +
          '<div style="font-size:26px;font-weight:800;letter-spacing:2px;color:#14532d;margin-top:4px">' + esc(p.code) + '</div>' +
          '<div style="color:#15803d;font-size:13px;margin-top:4px">' + esc(off) + '</div></div>'
        : '<p style="color:#475569;font-size:14px">Everything is where you left it — your profile, your watch history, the lot.</p>') +
      button(link, 'Pick a plan')),
    link,
  };
}

/**
 * 4 · 📢 "here is something worth watching". Built for EMAIL, not for a browser, which rules out the obvious
 * pretty things: Gmail strips inline <svg> and blocks data: URIs in <img>, and Outlook's Word engine ignores
 * border-radius. So every "card", icon and avatar below is drawn with table cells, background colours, borders
 * and real text — it degrades to a plain tidy block in the worst client instead of to an empty white rectangle,
 * which is what an SVG email actually looks like for most people.
 */
function avatarRow() {
  // Letter avatars: a coloured circle and an initial. No image to load, nothing to block.
  const people = [['A', '#e11d48'], ['R', '#7c3aed'], ['S', '#0891b2'], ['M', '#ea580c'], ['K', '#16a34a']];
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>' +
    people.map(([ch, bg]) =>
      '<td style="padding:0 3px"><div style="width:32px;height:32px;line-height:32px;border-radius:16px;background:' + bg +
      ';color:#fff;font-size:13px;font-weight:700;text-align:center">' + ch + '</div></td>').join('') +
    '<td style="padding:0 3px"><div style="width:32px;height:32px;line-height:32px;border-radius:16px;background:#1f2937;color:#e5e7eb;font-size:11px;font-weight:700;text-align:center">+99</div></td>' +
    '</tr></table>';
}
function featureCards() {
  const cards = [
    ['⚡', 'Instant', 'Your login lands in your inbox the moment the payment clears.'],
    ['🤖', 'Automatic', 'No waiting for a reply. The shop does it itself, day or night.'],
    ['🔐', 'Your own profile', 'Your profile, your PIN, your watch history. Nobody else in it.'],
  ];
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0"><tr>' +
    cards.map(([icon, head, body]) =>
      '<td width="33%" valign="top" style="padding:4px">' +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 10px;height:100%">' +
      '<div style="font-size:22px;line-height:26px">' + icon + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:4px">' + head + '</div>' +
      '<div style="font-size:11.5px;color:#64748b;margin-top:3px;line-height:1.45">' + body + '</div>' +
      '</div></td>').join('') +
    '</tr></table>';
}
function whatsnewEmail(p) {
  const link = SITE() + '/?source=whatsnew';
  const title = s(p.title);
  const svc = s(p.service) || 'Netflix';
  const badge = s(p.badge);
  // The "poster": a deep gradient panel with the title set large. A real poster would be an <img> on an https URL,
  // which is the one image form every client loads — drop one in and this becomes that.
  const poster =
    '<div style="background:#141418;background-image:linear-gradient(135deg,#5c1116 0%,#1d0a0d 55%,#0b0b0f 100%);border-radius:14px;padding:26px 20px;text-align:center">' +
    (badge ? '<div style="display:inline-block;background:rgba(255,255,255,.14);color:#fecdd3;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px">' + esc(badge) + '</div>' : '') +
    '<div style="color:#ffffff;font-size:26px;font-weight:800;line-height:1.2;margin-top:10px">' + esc(title) + '</div>' +
    '<div style="color:#f8b4bc;font-size:12.5px;font-weight:600;margin-top:6px">🎬 on ' + esc(svc) + '</div>' +
    '</div>';
  return {
    subject: '🍿 ' + title + ' on ' + svc + ' — and your login now arrives instantly',
    html: shell(
      '<div style="text-align:center;margin-bottom:6px"><span style="font-size:19px;font-weight:800;color:#e11d48">FluxFilm</span></div>' +
      '<p style="color:#475569;margin-top:0;font-size:14px">Hi ' + esc(firstName(p.name) || 'there') + ',</p>' +
      poster +
      (s(p.line) ? '<p style="color:#475569;font-size:14px;line-height:1.55;margin:14px 0 0">' + esc(p.line) + '</p>' : '') +
      '<p style="color:#0f172a;font-size:14px;font-weight:700;margin:18px 0 0">One more thing — the shop runs itself now.</p>' +
      '<p style="color:#475569;font-size:13.5px;line-height:1.55;margin:4px 0 0">No messaging us and waiting. Pick a plan, pay, and the login is in your inbox before you have put your phone down.</p>' +
      featureCards() +
      '<div style="text-align:center;margin:18px 0 6px">' + avatarRow() +
      '<div style="color:#94a3b8;font-size:11.5px;margin-top:7px">watching on FluxFilm right now</div></div>' +
      button(link, 'See what is on'),
    ),
    link,
  };
}

// ── job 1 · the order nobody paid for ─────────────────────────────────────────────────────────────────────────
async function abandonedCandidates(settings, now, deps) {
  const cfg = settings.abandoned;
  const olderThan = new Date(now - cfg.afterHours * HOUR);
  const newerThan = new Date(now - cfg.withinHours * HOUR);
  const rows = await q(deps,
    "SELECT o.order_id, o.phone_norm, o.name, o.service, o.plan, o.final_amount, o.created_at_sheet, c.email " +
    'FROM orders o LEFT JOIN customers c ON c.phone_norm = o.phone_norm ' +
    "WHERE UPPER(o.status) = 'CREATED' AND o.created_at_sheet < ? AND o.created_at_sheet > ? " +
    'ORDER BY o.created_at_sheet DESC LIMIT 200', [olderThan, newerThan]);
  // One person, one reminder. A customer with three unpaid orders is still one person having one bad evening;
  // three emails in the same minute reads as a broken shop. The newest order is the one worth naming, and the
  // others are marked handled when it goes, so they never produce a second email of their own.
  const byPhone = new Map();
  for (const r of (rows || [])) {                       // already newest-first from the query
    if (await alreadySent(deps, r.order_id, 'ABANDONED')) continue;
    const phone = norm(r.phone_norm);
    const id = s(r.order_id);
    const seen = byPhone.get(phone || id);
    if (seen) { seen.alsoOrders.push(id); continue; }
    byPhone.set(phone || id, {
      key: id, orderId: id, phone, name: s(r.name), service: s(r.service), plan: s(r.plan),
      amount: Number(r.final_amount) || 0, email: s(r.email), alsoOrders: [],
    });
  }
  return [...byPhone.values()];
}

// ── job 2 · "your plan is ending", by email, to whoever push cannot reach ──────────────────────────────────────
function ymd(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }

async function expiryCandidates(settings, now, deps) {
  const cfg = settings.expiryMail;
  const push = dep(deps, 'push', './push');
  const wanted = [];
  for (const n of cfg.daysBefore) wanted.push({ kind: 'BEFORE_' + n, day: ymd(now + n * DAY) });
  if (cfg.onExpiryDay) wanted.push({ kind: 'EXPIRY_DAY', day: ymd(now) });
  if (cfg.afterExpiry) wanted.push({ kind: 'AFTER_1', day: ymd(now - DAY) });
  if (!wanted.length) return [];

  const days = wanted.map((w) => w.day);
  const rows = await q(deps,
    'SELECT sb.sub_id, sb.phone_norm, sb.service, sb.plan, sb.expiry_date, c.name, c.email ' +
    'FROM subscriptions sb LEFT JOIN customers c ON c.phone_norm = sb.phone_norm ' +
    "WHERE UPPER(sb.status) IN ('ACTIVE','EXPIRED') AND sb.expiry_date IS NOT NULL AND DATE(sb.expiry_date) IN (" +
    days.map(() => '?').join(',') + ') ORDER BY sb.expiry_date DESC LIMIT 300', days);

  const out = [];
  for (const r of (rows || [])) {
    const day = ymd(r.expiry_date);
    const hit = wanted.find((w) => w.day === day);
    if (!hit) continue;
    const phone = norm(r.phone_norm);
    if (!s(r.email)) continue;                       // nothing to send to
    if (cfg.onlyWithoutPush) {
      let has = false;
      try { has = !!(await push.hasDevice(phone)); } catch (_) { has = false; }
      if (has) continue;                             // pushreminders.js already tells this one
    }
    if (await alreadySent(deps, r.sub_id, hit.kind, r.expiry_date)) continue;
    out.push({
      key: s(r.sub_id), subId: s(r.sub_id), kind: hit.kind, phone, name: s(r.name),
      service: s(r.service), plan: s(r.plan), expiry: r.expiry_date, email: s(r.email),
    });
  }
  return out;
}

// ── job 3 · the customer who has not been back ────────────────────────────────────────────────────────────────
async function winbackCandidates(settings, now, deps) {
  const cfg = settings.winback;
  const before = new Date(now - cfg.afterDays * DAY);
  const rows = await q(deps,
    'SELECT sb.phone_norm, MAX(sb.expiry_date) AS last_expiry, MAX(sb.service) AS service ' +
    'FROM subscriptions sb WHERE sb.expiry_date IS NOT NULL ' +
    'GROUP BY sb.phone_norm HAVING MAX(sb.expiry_date) < ? ORDER BY last_expiry DESC LIMIT 300', [before]);
  const out = [];
  for (const r of (rows || [])) {
    const phone = norm(r.phone_norm);
    if (!phone) continue;
    // Anyone with a plan running today is not a win-back, whatever the dates say.
    const live = await q(deps, "SELECT 1 AS x FROM subscriptions WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' AND (expiry_date IS NULL OR expiry_date > NOW()) LIMIT 1", [phone]);
    if (live && live.length) continue;
    if (await alreadySent(deps, phone, 'WINBACK', null, cfg.everyDays * DAY, now)) continue;
    const c = await q(deps, 'SELECT name, email FROM customers WHERE phone_norm = ? LIMIT 1', [phone]);
    const email = s(c && c[0] && c[0].email);
    if (!email) continue;
    out.push({ key: phone, phone, name: s(c[0].name), email, service: s(r.service), lastExpiry: r.last_expiry });
  }
  return out;
}

// ── job 4 · what is worth watching, and how the shop works now ─────────────────────────────────────────────────
async function whatsnewCandidates(settings, now, deps) {
  const cfg = settings.whatsnew;
  if (!s(cfg.title)) return [];                     // nothing to announce — belt and braces with the validator
  // Everyone who has actually bought from us and left an address. Not every phone in the table: a stranger who
  // once opened the site is not someone to send film recommendations to.
  const rows = await q(deps,
    'SELECT c.phone_norm, c.name, c.email, MAX(sb.service) AS service, MAX(sb.expiry_date) AS last_expiry ' +
    'FROM customers c JOIN subscriptions sb ON sb.phone_norm = c.phone_norm ' +
    "WHERE c.email IS NOT NULL AND TRIM(c.email) <> '' " +
    'GROUP BY c.phone_norm, c.name, c.email ORDER BY MAX(sb.expiry_date) DESC LIMIT 600', []);
  const out = [];
  for (const r of (rows || [])) {
    const phone = norm(r.phone_norm);
    if (!phone) continue;
    // One announcement per person per everyDays, whatever the title is. Changing the film does not buy a second
    // email inside the window — that window is the promise that we will not become noise.
    if (await alreadySent(deps, phone, 'WHATSNEW', null, cfg.everyDays * DAY, now)) continue;
    if (cfg.onlyActive) {
      const live = await q(deps, "SELECT 1 AS x FROM subscriptions WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' AND (expiry_date IS NULL OR expiry_date > NOW()) LIMIT 1", [phone]);
      if (!live || !live.length) continue;
    }
    out.push({ key: phone, phone, name: s(r.name), email: s(r.email), service: s(r.service) });
  }
  return out;
}

/**
 * Is this coupon one a customer could actually use today? A win-back email naming a code that answers "Coupon is
 * not active" is worse than one with no code in it, and you only get to write to a lapsed customer once.
 * Checked against the coupons table rather than trusted: the owner stages codes inactive until a sale opens, and
 * the whole point of a job that runs for days is that nobody is watching it on the day it matters.
 * → '' when it is fine, otherwise the reason in plain words.
 */
async function codeProblem(code, deps, now) {
  const c = s(code);
  if (!c) return 'no code is set';
  let rows;
  try {
    rows = await q(deps, 'SELECT code, active, expiry FROM coupons WHERE UPPER(code) = ? LIMIT 1', [c.toUpperCase()]);
  } catch (e) { if (missingTable(e)) return ''; throw e; }   // no coupons table in a test world: not our business
  const r = rows && rows[0];
  if (!r) return c + ' is not in Coupons at all';
  if (String(r.active).toUpperCase() === 'FALSE') return c + ' is switched OFF in Coupons';
  if (r.expiry && new Date(r.expiry).getTime() <= (now || Date.now())) return c + ' expired on ' + String(r.expiry).slice(0, 10);
  return '';
}

// ── rendering one candidate, for preview and for sending ──────────────────────────────────────────────────────
function renderFor(job, cand, settings, now, deps) {
  if (job === 'abandoned') return abandonedEmail(cand);
  if (job === 'winback') return winbackEmail(Object.assign({}, cand, codeForDay(settings.winback, now)));
  if (job === 'whatsnew') return whatsnewEmail(Object.assign({}, cand, settings.whatsnew));
  const credit = dep(deps, 'credit', './credit');
  return credit.reminderEmail({ name: cand.name, service: cand.service, plan: cand.plan, expiry: cand.expiry, subId: cand.subId, now: new Date(now) });
}

const JOBS = {
  abandoned: { kind: () => 'ABANDONED', find: abandonedCandidates },
  expiryMail: { kind: (c) => c.kind, find: expiryCandidates },
  winback: { kind: () => 'WINBACK', find: winbackCandidates },
  whatsnew: { kind: () => 'WHATSNEW', find: whatsnewCandidates },
};

/** The jobs that go out a BATCH A DAY rather than all at once, and the setting that says how big a batch is. */
const BATCHED = { winback: 'WINBACK', whatsnew: 'WHATSNEW' };

/** Read-only: who would be written to, and exactly what the first one would say. Sends nothing. */
async function preview(job, now, deps) {
  const j = JOBS[job];
  if (!j) return { ok: false, message: 'Unknown job.' };
  const settings = await getSettings(deps);
  const at = now || Date.now();
  let list = [];
  try { list = await j.find(settings, at, deps); }
  catch (e) { if (missingTable(e)) return { ok: true, job, total: 0, candidates: [], note: 'Run db/schema-v14.sql first (reminder_log).' }; throw e; }
  let perBatch = settings.maxPerRun;
  let days = 0;
  if (BATCHED[job]) {
    perBatch = Math.min(perBatch, settings[job].perDay);
    days = Math.ceil(list.length / Math.max(1, settings[job].perDay));
  }
  const capped = list.slice(0, perBatch);
  const first = capped[0] || null;
  // Why nothing would go today, said out loud on the screen rather than discovered days later in the log.
  let holding = '';
  if (job === 'winback') {
    const cfg = settings.winback;
    if (cfg.startOn && istDay(at) < cfg.startOn) holding = 'waiting — this one starts on ' + cfg.startOn;
    else {
      const today = codeForDay(cfg, at);
      if (today.withCode) {
        const bad = await codeProblem(today.code, deps, at).catch(() => '');
        if (bad) holding = 'nothing can go out: ' + bad;
      }
      if (today.withCode && cfg.codeUntil) {
        const nextBad = cfg.code2 ? await codeProblem(cfg.code2, deps, at).catch(() => '') : 'no second code is set';
        if (nextBad) holding = (holding ? holding + ' · ' : '') + 'after ' + cfg.codeUntil + ': ' + nextBad;
      }
    }
  }
  return {
    ok: true, job, total: list.length, wouldSend: capped.length, maxPerRun: settings.maxPerRun,
    holding: holding || undefined,
    usingCode: job === 'winback' ? codeForDay(settings.winback, at) : undefined,
    perDay: BATCHED[job] ? settings[job].perDay : null, days,
    candidates: capped.slice(0, 20).map((c) => ({ key: c.key, name: c.name, phone: c.phone, email: c.email, service: c.service, plan: c.plan })),
    sample: first ? Object.assign({ to: first.email || '(push)', }, renderFor(job, first, settings, at, deps)) : null,
  };
}

/** One message to the owner, built exactly like the real thing — before any customer hears from us. */
async function sendTest(job, to, deps) {
  const j = JOBS[job];
  if (!j) return { ok: false, message: 'Unknown job.' };
  const address = s(to);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return { ok: false, message: 'Give a real email address to send the test to.' };
  const settings = await getSettings(deps);
  const at = Date.now();
  const sample = {
    abandoned: { orderId: 'FF0000000', name: 'Test Customer', service: 'Netflix', plan: 'Sharing 1M', amount: 199 },
    winback: { name: 'Test Customer', service: 'Netflix' },
    expiryMail: { name: 'Test Customer', service: 'Netflix', plan: 'Sharing 1M', subId: 'SUB-TEST', expiry: new Date(at + 3 * DAY) },
  }[job];
  const mail = renderFor(job, sample, settings, at, deps);
  const mailer = dep(deps, 'mailer', './mailer');
  const r = await mailer.send(address, '[TEST] ' + mail.subject, mail.html);
  return { ok: !!(r && r.ok !== false), to: address, subject: mail.subject };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runJob(job, settings, now, deps) {
  const j = JOBS[job];
  const out = { job, sent: 0, failed: 0, skipped: 0, considered: 0 };
  let list = [];
  try { list = await j.find(settings, now, deps); }
  catch (e) { if (missingTable(e)) return Object.assign(out, { skipped: 'schema-v14 not run (reminder_log)' }); throw e; }
  out.considered = list.length;
  const mailer = dep(deps, 'mailer', './mailer');
  const push = dep(deps, 'push', './push');

  // How many may go in this run. Win-back also has a DAILY batch size, so a long list is worked through a bit at
  // a time: today's batch goes, tomorrow's run picks up where it stopped, because everyone written to is logged.
  let room = settings.maxPerRun;
  if (BATCHED[job]) {
    const today = await sentSince(deps, BATCHED[job], DAY, now).catch(() => 0);
    out.sentToday = today;
    out.perDay = settings[job].perDay;
    room = Math.max(0, Math.min(room, settings[job].perDay - today));
    if (!room) return Object.assign(out, { skipped: "today's batch is done" });
  }

  for (const c of list.slice(0, room)) {
    const kind = j.kind(c);
    const mail = renderFor(job, c, settings, now, deps);
    // The abandoned nudge prefers a push, because it is small and immediate; everything else is an email.
    let channel = 'EMAIL';
    let ok = false;
    try {
      if (job === 'abandoned' && c.phone && (await push.hasDevice(c.phone).catch(() => false))) {
        channel = 'PUSH';
        const r = await push.sendToPhone(c.phone, {
          title: '🛒 Your ' + (c.service || 'FluxFilm') + ' order is waiting',
          body: 'Order ' + c.orderId + (c.amount ? ' · ₹' + c.amount : '') + ' — tap to finish it.',
          url: mail.link, tag: 'abandoned',
        }, { kind: 'broadcast' });
        ok = !!(r && r.sent);
      } else if (c.email) {
        const r = await mailer.send(c.email, mail.subject, mail.html);
        ok = !(r && r.ok === false);
      } else {
        out.skipped++;
        continue;                       // no way to reach them; not logged, so a later address still gets one
      }
    } catch (e) {
      ok = false;
      console.log('[reminderjobs] ' + job + ' failed for ' + c.key + ':', e.message);
    }
    await writeLog(deps, c.key, channel, kind, c.expiry || null, ok, job + (ok ? '' : ' failed'));
    // Their other unpaid orders count as reminded too — the person has been told, once.
    if (ok && c.alsoOrders) for (const other of c.alsoOrders) await writeLog(deps, other, channel, kind, null, 1, 'covered by ' + c.orderId);
    if (ok) out.sent++; else out.failed++;
  }
  return out;
}

async function run(now, deps) {
  const at = now || Date.now();
  const settings = await getSettings(deps);
  const h = istHour(at);
  if (h < settings.quietStart || h >= settings.quietEnd) return { ok: true, skipped: 'quiet hours' };
  const jobs = [];
  for (const name of ['abandoned', 'expiryMail', 'winback', 'whatsnew']) {
    if (!settings[name].on) continue;
    // Never offer a code that does not exist, is switched off, or has expired. With the discount switched off
    // there is nothing to check. The same guard covers both codes, because which one is live changes by the day.
    if (name === 'winback') {
      const cfg = settings.winback;
      if (cfg.startOn && istDay(at) < cfg.startOn) continue;      // armed, but not yet
      const today = codeForDay(cfg, at);
      if (today.withCode) {
        const bad = await codeProblem(today.code, deps, at).catch(() => '');
        if (bad) { console.log('[reminderjobs] win-back held back: ' + bad); continue; }
      }
    }
    // Never announce nothing.
    if (name === 'whatsnew' && !s(settings.whatsnew.title)) continue;
    jobs.push(await runJob(name, settings, at, deps));
  }
  return { ok: true, ran: jobs.length, jobs };
}

let timer = null;
function startTimer(deps) {
  if (timer) return;
  const tick = () => run(Date.now(), deps).catch((e) => console.log('[reminderjobs] run failed:', e.message));
  timer = setInterval(tick, HOUR);
  if (timer.unref) timer.unref();
  const first = setTimeout(tick, 90000);   // once shortly after boot, then hourly
  if (first.unref) first.unref();
}

function mount(app, deps) {
  const { auth } = deps;
  const audit = (deps && deps.audit) || { record: () => {} };
  const fail = (res, e) => res.status((e && e.status) || 500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/reminder-jobs', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json({ ok: true, settings: await getSettings(deps) }); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/reminder-jobs', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await saveSettings(req.body || {}, deps);
      const on = ['abandoned', 'expiryMail', 'winback', 'whatsnew'].filter((k) => r.settings[k].on);
      audit.record(req, { action: 'reminders.jobs', entity: 'app_settings', id: KEY, summary: on.length ? 'on: ' + on.join(', ') : 'all off', details: r.settings });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  // Reads only. This is what the owner looks at before switching anything on.
  app.get('/admin/api/reminder-jobs/preview', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await preview(s(req.query.job), Date.now(), deps)); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/reminder-jobs/test', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const r = await sendTest(s(b.job), s(b.to), deps);
      if (r.ok) audit.record(req, { action: 'reminders.test', entity: 'email', id: s(b.job), summary: 'test ' + s(b.job) + ' to ' + s(b.to) });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  // For a Hostinger cron job. The key goes in the X-Admin-Key header, never in the URL.
  app.post('/cron/reminders', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await run(Date.now(), deps)); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  mount, run, runJob, startTimer, getSettings, saveSettings, preview, sendTest,
  DEFAULTS, KEY, JOBS,
  _internal: { abandonedEmail, winbackEmail, whatsnewEmail, whatsnewCandidates, avatarRow, featureCards, abandonedCandidates, expiryCandidates, winbackCandidates, istHour, alreadySent, ymd },
};
