/**
 * FluxFilm — 🎉 the anniversary sale countdown (owner request 23 Sep 2026: "add a top banner a countdown for our
 * anniversary sale - no coupon yet just countdown and add notify button when they click it turn on their
 * notification in the account and also schedule a cron job in hostinger to remind them on anniversary").
 *
 * One slim bar at the top of the shop counting down to the day, with a 🔔 Notify me button. Pressing it switches
 * notifications on for that customer (the same push switch as Account → Notifications — no second mechanism) and
 * writes their number down here, so on the day we tell exactly the people who asked.
 *
 * No schema change: everything lives in `app_settings` — the settings under 'anniversary', the list of people who
 * asked under 'anniversary_notify'.
 *
 *   publicInfo(now)  → what the shop needs to draw the bar: { on, title, note, startsAtMs, live, endsAtMs }
 *   notifyMe(phone)  → remember this customer (the browser does the push switch itself, this is the list)
 *   run(now)         → on the day: tell everyone who asked. Never twice — the moment it announced is written down.
 *   getSettings() · saveSettings(input) · stats()
 *
 * The announcement is sent by the app's own hourly timer (startTimer, the same shape as pushreminders.js), so it
 * works with nothing set up on Hostinger. POST /cron/anniversary is there as well for a real cron job: same work,
 * same "never twice" guard, so having both cannot double-send.
 */
const db = require('./db');
const push = require('./push');

const KEY = 'anniversary';
const LIST_KEY = 'anniversary_notify';
const LIST_MAX = 20000;
const IST_OFFSET = 5.5 * 3600e3;
// An announcement that is more than this late is not sent at all — nobody wants "the sale is live!" three days after.
const TOO_LATE_MS = 36 * 3600e3;

const DEFAULTS = {
  on: true,
  title: '🎉 FluxFilm Anniversary Sale',
  note: 'Our best prices of the year. Be the first to know.',
  startsAt: '2026-09-30 10:00',  // 'YYYY-MM-DD HH:MM', India time. The moment the countdown reaches zero.
  endsAt: '',                   // optional 'YYYY-MM-DD HH:MM': the bar disappears after this.
  liveTitle: '🎉 The Anniversary Sale is ON',
  liveNote: 'Our best prices of the year — see the plans.',
  notifyTitle: '🎉 The FluxFilm Anniversary Sale is live',
  notifyBody: 'Our best prices of the year are on right now. Tap to see them.',
  everyone: false,              // false = only the people who pressed 🔔 Notify me. true = everyone with reminders on.
  announcedFor: '',             // the startsAt already announced — the guard that stops a second send.
  announcedAt: '',
};

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const clip = (v, n) => s(v).slice(0, n);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

/** 'YYYY-MM-DD HH:MM' written in India time → epoch ms. '' / nonsense → 0. */
function istMs(v) {
  const m = s(v).match(DATE_RE);
  if (!m) return 0;
  const mo = +m[2], day = +m[3], hh = +m[4], mm = +m[5];
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return 0;
  const ms = Date.UTC(+m[1], mo - 1, day, hh, mm) - IST_OFFSET;
  if (isNaN(ms)) return 0;
  // 31 February rolls into March — refuse it rather than silently move the sale.
  return new Date(ms + IST_OFFSET).getUTCDate() === day ? ms : 0;
}
/** epoch ms → 'YYYY-MM-DD HH:MM' in India time (what the owner typed, and what we show back). */
function istText(ms) {
  if (!ms) return '';
  const d = new Date(ms + IST_OFFSET);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

async function readSetting(key) {
  try {
    const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]);
    return r && r[0] ? JSON.parse(r[0].value || 'null') : null;
  } catch (e) { return null; }
}
async function writeSetting(key, value) {
  await db.query(
    'INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, JSON.stringify(value)]);
}

async function getSettings() {
  const saved = await readSetting(KEY);
  return Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
}

/** Only the fields the owner may set, each trimmed to a sane size. A changed date re-arms the announcement. */
function validate(input, current) {
  const i = input || {};
  const cur = current || DEFAULTS;
  const out = Object.assign({}, cur);
  if (i.on != null) out.on = !!i.on;
  if (i.everyone != null) out.everyone = !!i.everyone;
  for (const k of ['title', 'liveTitle', 'notifyTitle']) if (i[k] != null) out[k] = clip(i[k], 80);
  for (const k of ['note', 'liveNote', 'notifyBody']) if (i[k] != null) out[k] = clip(i[k], 200);
  for (const k of ['startsAt', 'endsAt']) {
    if (i[k] == null) continue;
    const v = s(i[k]).replace('T', ' ').slice(0, 16);
    if (v && !DATE_RE.test(v)) throw Object.assign(new Error('The date must look like 2026-10-14 10:00.'), { status: 400 });
    out[k] = v;
  }
  if (out.startsAt && out.endsAt && istMs(out.endsAt) <= istMs(out.startsAt)) {
    throw Object.assign(new Error('The end must come after the start.'), { status: 400 });
  }
  // Moved the date? Then this is a different sale: it may be announced again.
  if (out.startsAt !== cur.startsAt) { out.announcedFor = ''; out.announcedAt = ''; }
  return out;
}

async function saveSettings(input) {
  const cur = await getSettings();
  const next = validate(input, cur);
  await writeSetting(KEY, next);
  return { ok: true, settings: next };
}

/** What the shop is told. Nothing private: a title, a note and the instant to count down to. */
async function publicInfo(now) {
  const t = now ? +now : Date.now();
  const st = await getSettings();
  const startsAtMs = istMs(st.startsAt);
  const endsAtMs = istMs(st.endsAt);
  if (!st.on || !startsAtMs || (endsAtMs && t >= endsAtMs)) return { ok: true, on: false };
  const live = t >= startsAtMs;
  return {
    ok: true,
    on: true,
    live,
    title: live ? st.liveTitle : st.title,
    note: live ? st.liveNote : st.note,
    startsAtMs,
    endsAtMs: endsAtMs || 0,
    // The bar asks for this so it can show "✅ You'll be told" straight away on the next visit; the browser knows
    // its own push state, this only says whether the button is worth showing at all.
    canNotify: !live,
  };
}

// ── who asked to be told ──────────────────────────────────────────────────────────────────────────────────────
async function readList() {
  const v = await readSetting(LIST_KEY);
  return Array.isArray(v) ? v.filter((x) => norm(x).length === 10) : [];
}

/** The customer pressed 🔔 Notify me. Their browser does the push switch; this is the list of who asked. */
async function notifyMe(phone) {
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Please log in first so we know who to tell.' };
  const st = await getSettings();
  if (!st.on) return { ok: false, message: 'There is nothing to be told about right now.' };
  const list = await readList();
  if (list.indexOf(ph) === -1) {
    if (list.length >= LIST_MAX) return { ok: true, already: true, waiting: list.length };
    list.push(ph);
    await writeSetting(LIST_KEY, list);
  }
  return { ok: true, waiting: list.length, already: list.indexOf(ph) > -1 };
}

async function stats() {
  const [st, list] = await Promise.all([getSettings(), readList()]);
  return {
    ok: true,
    settings: st,
    waiting: list.length,
    startsAtMs: istMs(st.startsAt),
    announced: !!(st.announcedFor && st.announcedFor === st.startsAt),
    announcedAt: st.announcedAt || '',
  };
}

// ── the day itself ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Tell the people who asked. Called by the app's own hourly timer AND (if the owner sets one up) by a Hostinger
 * cron. Safe to call as often as you like: the startsAt it announced is written down first, so the second caller
 * finds the work already done.
 */
let inFlight = null;
function run(now, opts) {
  // The hourly timer and a Hostinger cron live in the same process: if they land together, the second one waits
  // for the first and gets its answer, instead of starting a second announcement.
  if (inFlight) return inFlight;
  inFlight = runOnce(now, opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runOnce(now, opts) {
  const t = now ? +now : Date.now();
  const force = !!(opts && opts.force);
  const st = await getSettings();
  const startsAtMs = istMs(st.startsAt);
  if (!st.on) return { ok: true, skipped: 'off' };
  if (!startsAtMs) return { ok: true, skipped: 'no date' };
  if (!force && t < startsAtMs) return { ok: true, skipped: 'not yet', startsAtMs };
  if (!force && st.announcedFor === st.startsAt) return { ok: true, skipped: 'already announced', announcedAt: st.announcedAt };
  if (!force && t - startsAtMs > TOO_LATE_MS) return { ok: true, skipped: 'too late' };

  // Written down BEFORE the sending, so a cron and the hourly timer landing together cannot both send.
  await writeSetting(KEY, Object.assign({}, st, { announcedFor: st.startsAt, announcedAt: istText(t) }));

  const message = { title: st.notifyTitle, body: st.notifyBody, url: '/?source=anniversary', tag: 'anniversary' };
  let sent = 0, failed = 0, told = 0;
  try {
    if (st.everyone) {
      const r = await push.broadcast(message, { kind: 'broadcast' });
      sent = Number(r && r.sent) || 0; failed = Number(r && r.failed) || 0; told = sent;
    } else {
      const list = await readList();
      for (const ph of list) {
        try {
          const r = await push.sendToPhone(ph, message, { kind: 'broadcast' });
          if (r && r.sent) { sent += Number(r.sent) || 0; told++; } else failed++;
        } catch (e) { failed++; }
      }
    }
  } catch (e) {
    console.log('[anniversary] announcement failed:', e.message);
    return { ok: false, message: e.message, sent, failed };
  }
  console.log('[anniversary] announced the sale to ' + told + ' customer(s), ' + sent + ' device(s)');
  return { ok: true, announced: true, told, sent, failed, everyone: !!st.everyone };
}

let timer = null;
function startTimer() {
  if (timer) return;
  const tick = () => run().catch((e) => console.log('[anniversary] timer failed:', e.message));
  const first = setTimeout(tick, 90e3);
  if (first.unref) first.unref();
  timer = setInterval(tick, 60 * 60e3);
  if (timer.unref) timer.unref();
}

function mount(app, deps) {
  const { auth } = deps;
  const audit = (deps && deps.audit) || { record: () => {} };
  const fail = (res, e) => res.status((e && e.status) || 500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/anniversary', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await stats()); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/anniversary', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await saveSettings(req.body || {});
      audit.record({ action: 'anniversary.save', entity: 'app_settings', entityId: KEY, summary: (r.settings.on ? 'on' : 'off') + ' · ' + (r.settings.startsAt || 'no date') });
      res.json(Object.assign(r, await stats()));
    } catch (e) { fail(res, e); }
  });

  // "Send it now" — the owner's own button, and only with confirm: true.
  app.post('/admin/api/anniversary/run', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!(req.body || {}).confirm) return res.status(400).json({ ok: false, message: 'Not confirmed.' });
      const r = await run(Date.now(), { force: true });
      audit.record({ action: 'anniversary.announce', entity: 'app_settings', entityId: KEY, summary: 'told ' + (r.told || 0) + ' customer(s) by hand' });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  // For a Hostinger cron job. Same work and the same "never twice" guard as the app's own hourly timer, so running
  // both is harmless. The key goes in the X-Admin-Key header — never in the URL, where it would end up in logs.
  app.post('/cron/anniversary', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await run(Date.now())); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  mount, run, startTimer, publicInfo, notifyMe, getSettings, saveSettings, validate, stats,
  DEFAULTS, KEY, LIST_KEY, _internal: { istMs, istText, readList },
};
