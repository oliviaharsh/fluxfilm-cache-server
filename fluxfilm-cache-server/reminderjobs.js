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
  winback: { on: false, afterDays: 30, everyDays: 90, code: '', percent: 0 },
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
    if (w.afterDays != null) next.winback.afterDays = Math.min(365, Math.max(7, num(w.afterDays, 30)));
    if (w.everyDays != null) next.winback.everyDays = Math.min(365, Math.max(14, num(w.everyDays, 90)));
    if (w.percent != null) next.winback.percent = Math.min(90, Math.max(0, num(w.percent, 0)));
    if (w.code != null) next.winback.code = s(w.code).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
    if (next.winback.on && !next.winback.code) errs.push('Set the discount code before switching win-back on.');
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

/** 3 · "come back" — one code, capped, one use each. The code is named, never invented here. */
function winbackEmail(p) {
  const link = SITE() + '/?source=winback';
  const off = Number(p.percent) > 0 ? Number(p.percent) + '% off' : 'a discount';
  return {
    subject: '💚 We miss you at FluxFilm — ' + off + ' when you come back',
    html: shell('<h2 style="color:#16a34a;margin-bottom:4px">💚 It has been a while</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + esc(firstName(p.name) || 'there') + ',</p>' +
      '<p style="color:#475569;font-size:14px">Your ' + esc(p.service || 'FluxFilm') + ' plan ended a while back and we would love to have you watching again.</p>' +
      '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px;margin:14px 0;text-align:center">' +
      '<div style="color:#15803d;font-size:13px">Use this code at checkout</div>' +
      '<div style="font-size:26px;font-weight:800;letter-spacing:2px;color:#14532d;margin-top:4px">' + esc(p.code) + '</div>' +
      '<div style="color:#15803d;font-size:13px;margin-top:4px">' + esc(off) + '</div></div>' +
      button(link, 'Pick a plan')),
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
  const out = [];
  for (const r of (rows || [])) {
    if (await alreadySent(deps, r.order_id, 'ABANDONED')) continue;
    out.push({
      key: s(r.order_id), orderId: s(r.order_id), phone: norm(r.phone_norm), name: s(r.name),
      service: s(r.service), plan: s(r.plan), amount: Number(r.final_amount) || 0, email: s(r.email),
    });
  }
  return out;
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

// ── rendering one candidate, for preview and for sending ──────────────────────────────────────────────────────
function renderFor(job, cand, settings, now, deps) {
  if (job === 'abandoned') return abandonedEmail(cand);
  if (job === 'winback') return winbackEmail(Object.assign({}, cand, { code: settings.winback.code, percent: settings.winback.percent }));
  const credit = dep(deps, 'credit', './credit');
  return credit.reminderEmail({ name: cand.name, service: cand.service, plan: cand.plan, expiry: cand.expiry, subId: cand.subId, now: new Date(now) });
}

const JOBS = {
  abandoned: { kind: () => 'ABANDONED', find: abandonedCandidates },
  expiryMail: { kind: (c) => c.kind, find: expiryCandidates },
  winback: { kind: () => 'WINBACK', find: winbackCandidates },
};

/** Read-only: who would be written to, and exactly what the first one would say. Sends nothing. */
async function preview(job, now, deps) {
  const j = JOBS[job];
  if (!j) return { ok: false, message: 'Unknown job.' };
  const settings = await getSettings(deps);
  const at = now || Date.now();
  let list = [];
  try { list = await j.find(settings, at, deps); }
  catch (e) { if (missingTable(e)) return { ok: true, job, total: 0, candidates: [], note: 'Run db/schema-v14.sql first (reminder_log).' }; throw e; }
  const capped = list.slice(0, settings.maxPerRun);
  const first = capped[0] || null;
  return {
    ok: true, job, total: list.length, wouldSend: capped.length, maxPerRun: settings.maxPerRun,
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

  for (const c of list.slice(0, settings.maxPerRun)) {
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
  for (const name of ['abandoned', 'expiryMail', 'winback']) {
    if (!settings[name].on) continue;
    if (name === 'winback' && !settings.winback.code) continue;   // never offer a code that does not exist
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
      const on = ['abandoned', 'expiryMail', 'winback'].filter((k) => r.settings[k].on);
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
  _internal: { abandonedEmail, winbackEmail, abandonedCandidates, expiryCandidates, winbackCandidates, istHour, alreadySent, ymd },
};
