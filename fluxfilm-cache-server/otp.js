/**
 * FluxFilm - Get OTP tool on Node (login-OTP for JioHotstar / Zee5 / SonyLIV).
 * An SMS-Forwarder app emails the SMS OTP to the FluxFilm Gmail; this reads that
 * inbox over IMAP (same account used for payments), extracts the code, marks the
 * mail read (so it's served once), and logs it for the monthly quota. No Apps Script.
 *
 * Safety (15 Sep 2026): needs an otp2 device token (email that belongs to the plan, otpaccess.js); only ACTIVE
 * purchases of that service unlocked by that email; only mails from the last few minutes (admin setting, default 10);
 * a mail that names a number must name THAT purchase's login (never another number); a mail with no number = latest
 * OTP of that service inside the window (fallback, counted in app_settings 'getotp_fallback_count'). See pickOtpMail.
 *
 * Zee5 fix (16 Sep 2026): until now EVERY run of 10+ digits in a mail counted as "the number this code was sent to",
 * so a forwarder timestamp ("Received At : 16-09-2026 21:45"), a helpline or a reference id looked like somebody
 * else's phone number and a perfectly good code was refused. A number now only counts as the recipient when it is
 * one of OUR logins, or an Indian mobile right after a "to / sent to / SIM / for / login" cue. Everything else is
 * ignored. Why nothing was shown is counted per service in app_settings 'getotp_diag_<service>' for the admin panel,
 * the time window is an admin setting (5-30 min, app_settings 'getotp_settings'), and the owner can paste a mail
 * into admin -> 📱 OTP devices -> "🔎 Get OTP check" to see exactly what the parser makes of it.
 */
const db = require('./db');

const OTP_EXPIRY_MS = Number(process.env.OTP_FRESH_MIN || 10) * 60 * 1000;
const OTP_EMAIL_FROM = process.env.OTP_EMAIL_FROM || process.env.IMAP_USER || 'harshwalia8888@gmail.com';
const FOLDER = () => process.env.IMAP_FOLDER || '[Gmail]/All Mail';
/**
 * Subjects a forwarder app puts on the mail. The old app wrote "SMSForwarder"; the owner's own app (SMS Mail
 * Bridge) writes its own, and a mail we cannot SEE looks exactly like "no OTP arrived" — which is how a working
 * phone can still show "No OTP email yet". So we try each known subject, and if none of them match we look once
 * more with no subject filter and read ones included. Nothing is loosened after that: the service keywords, the
 * fresh-window and the recipient rules below still decide, so another customer's code can never be shown.
 * Add more with OTP_SUBJECTS="My Forwarder,Something else" in Hostinger.
 */
const SUBJECTS = () => [...new Set(String(process.env.OTP_SUBJECTS || '').split(',').map((x) => x.trim()).filter(Boolean)
  .concat(['SMSForwarder', 'SMS Mail Bridge', 'SMS Forwarder', 'SMS Bridge']))];
const HOST = () => process.env.IMAP_HOST || 'imap.gmail.com';

const KEYWORDS = {
  JioHotstar: ['jiohotstar', 'jiohtr', 'vm-jiohtr', 'jd-jiohtr', 'va-jiohtr'],
  Zee5: ['zee5', 'zeeott', 'vm-zeeott', 'va-zeeott'],
  SonyLIV: ['sonyliv', 'sony liv', 'livotp', 'vm-livotp'],
};
/**
 * Adding another OTP service (e.g. Amazon login OTP for the "Prime Video + Shopping"
 * account PRIME-1) needs no code change here: set the Hostinger env var
 *   OTP_EXTRA_KEYWORDS={"Prime Video + Shopping":["amazon","amzn"]}
 * Key = text found in the service name; value = words that identify its SMS. Longer
 * keys win, so "Prime Video + Shopping" is not confused with another Prime service.
 * The storefront's Get-OTP button list is still hardcoded — see STATUS.md §14 F6.
 */
function keywordMap() {
  const map = Object.assign({}, KEYWORDS);
  try {
    const extra = JSON.parse(process.env.OTP_EXTRA_KEYWORDS || '{}');
    for (const [k, v] of Object.entries(extra || {})) {
      const words = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (String(k).trim() && words.length) map[String(k).trim()] = words;
    }
  } catch (e) { console.log('[otp] OTP_EXTRA_KEYWORDS is not valid JSON — ignored'); }
  return map;
}
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function svcKeyOf(service) {
  const s = String(service || '').toLowerCase();
  const keys = Object.keys(keywordMap()).sort((a, b) => b.length - a.length);
  return keys.find((k) => s.indexOf(k.toLowerCase()) !== -1) || String(service || '');
}
function extractOtp(body) {
  if (!body) return '';
  let m = body.match(/Your OTP is:\s*(\d{4,6})/i); if (m) return m[1];      // Zee5
  m = body.match(/(\d{4,6})\s+is your JioHotstar/i); if (m) return m[1];    // JioHotstar
  m = body.match(/verification code is\s+(\d{4,6})/i); if (m) return m[1];  // JioHotstar
  m = body.match(/OTP is\s+(\d{4,6})/i); if (m) return m[1];               // SonyLIV
  m = body.match(/\b(\d{4,6})\b/); if (m) return m[1];                      // generic
  return '';
}

async function withImap(fn) {
  const user = process.env.IMAP_USER, pass = process.env.IMAP_PASS;
  if (!user || !pass) throw new Error('IMAP not configured');
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: HOST(), port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try { return await fn(client); } finally { try { await client.logout(); } catch (_) {} }
}

async function _logOtp(service, otp, phone, message) {
  try { await db.query('INSERT INTO sms_otp_log (ts, service, otp, phone_norm, message) VALUES (NOW(),?,?,?,?)', [service, otp, phone, String(message || '').slice(0, 300)]); } catch (_) {}
}

// ---- Which streaming account a forwarded OTP mail is for ----
// A login is a phone number (matched on its last 10 digits, spaces / dashes / +91 allowed) or an email (exact text).
const loginKey = (v) => {
  const x = String(v == null ? '' : v).trim().toLowerCase();
  if (!x) return '';
  if (x.includes('@')) return 'e:' + x.replace(/\s+/g, '');
  const d = x.replace(/\D/g, '');
  return d.length >= 10 ? 'p:' + d.slice(-10) : '';
};
/** An Indian mobile hiding in a digit run: 10 digits starting 6-9, with an optional 0 / 91 / 091 in front. '' = not a mobile. */
function mobileLast10(digits) {
  const d = String(digits || '');
  let core = '';
  if (d.length === 10) core = d;
  else if (d.length === 11 && d[0] === '0') core = d.slice(1);
  else if (d.length === 12 && d.slice(0, 2) === '91') core = d.slice(2);
  else if (d.length === 13 && d.slice(0, 3) === '091') core = d.slice(3);
  else return '';
  return /^[6-9]\d{9}$/.test(core) ? core : '';
}
// Words a forwarder or an SMS puts in front of the number the message went to. "Received At : 16-09-2026 21:45"
// and "Ref 20260916213344" have none, so a date or an id is never read as somebody's phone number.
const CUE = /(?:to|sent|send|sim|sim1|sim2|number|num|no|nos|mobile|msisdn|phone|ph|login|logging|account|acct|recipient|registered|user|for)$/;
const runRe = () => /\+?\d[\d \-]{8,18}\d/g;
/** The text with every 10+ digit run blanked out, so a phone number can never be read as the code. */
const blankNumbers = (text) => String(text || '').replace(runRe(), (run) => (run.replace(/\D/g, '').length < 10 ? run : ' '));
/**
 * Login keys a mail really names, the text with numbers blanked out, and the numbers that were ignored (for the admin).
 *  - a number that contains one of OUR logins (`known`) always counts - another customer's code is never shown;
 *  - any other number counts only when it is an Indian mobile in a recipient position ("sent to 98…", "SIM 98…",
 *    "+91 98…"). Dates, times, amounts, helplines, order ids and long reference numbers are ignored;
 *  - a `known` email login found anywhere in the text counts (email logins are matched as text).
 */
function loginsIn(text, known) {
  const t = String(text || '');
  const found = new Set();
  const ignored = [];
  const knownPhones = [...(known || [])].filter((k) => k.startsWith('p:')).map((k) => k.slice(2));
  const re = runRe();
  let m;
  while ((m = re.exec(t)) !== null) {
    const run = m[0];
    const d = run.replace(/\D/g, '');
    if (d.length < 10) continue;
    const ours = knownPhones.find((p) => d.indexOf(p) !== -1);
    if (ours) { found.add('p:' + ours); continue; }
    const core = mobileLast10(d);
    const before = t.slice(Math.max(0, m.index - 28), m.index).toLowerCase().replace(/[^a-z0-9]+$/, '');
    if (core && (run.trim().charAt(0) === '+' || CUE.test(before))) found.add('p:' + core);
    else ignored.push(d);
  }
  for (const k of known || []) {
    if (k.startsWith('e:') && t.toLowerCase().indexOf(k.slice(2)) !== -1) found.add(k);
  }
  return { found, cleaned: blankNumbers(t), ignored };
}
// ---- Admin diagnostics: how many mails were looked at and which check said no (never any customer data) ----
const REASONS = { tooOld: 'too old', otherService: 'another service', numberMismatch: 'number mismatch', noCode: 'no code in it', shown: 'shown' };
const newDiag = () => ({ seen: 0, shown: 0, tooOld: 0, otherService: 0, numberMismatch: 0, noCode: 0, lines: [], mailsFound: 0, subjectUsed: '', looseSearch: false, subjects: [] });
const maskNum = (v) => { const p = String(v == null ? '' : v).replace(/\D/g, '').slice(-10); return p.length >= 4 ? '••••••' + p.slice(-4) : '••••'; };
const maskKey = (k) => (String(k || '').startsWith('e:') ? String(k).slice(2).replace(/^(.).*(@.*)$/, '$1•••$2') : maskNum(k));
function note(diag, age, reason, keys) {
  if (!diag) return;
  diag[reason] = (diag[reason] || 0) + 1;
  if (diag.lines.length < 10) diag.lines.push({ minsAgo: Math.max(0, Math.round(age / 60e3)), reason: REASONS[reason] || reason, numbers: [...(keys || [])].map(maskKey) });
}

/**
 * Newest usable OTP mail for this service inside the fresh window (admin setting, 10 min by default).
 * Returns { item, otp, body, matchedBy } or null; opts.diag (newDiag()) is filled in for the admin panel.
 *  - STRICT: a mail that names a login / phone number (SIM) is used only when every login and number in it is this
 *    plan's. A mail naming ANOTHER number is never used. Only real recipient numbers count - see loginsIn.
 *  - FALLBACK (owner, 15 Sep 2026): a mail that names no number (today's SMS Forwarder mails carry no SIM number)
 *    is used as "the latest OTP for this service inside the window". Once the forwarder adds the SIM number,
 *    every mail names one and only STRICT applies - no code change needed.
 * items: [{ uid, date, subject, text }]
 */
function pickOtpMail(items, opts) {
  const { keywords, allowed, known, now, windowMs } = opts;
  const diag = opts.diag || null;
  const everyLogin = new Set([...(known || []), ...allowed]);
  const list = (items || []).slice().sort((a, b) => b.date.getTime() - a.date.getTime());
  for (const it of list) {
    const age = now - it.date.getTime();
    if (!(age >= -60e3 && age <= windowMs)) { note(diag, age, 'tooOld'); continue; }
    const subject = String(it.subject || '').toLowerCase();
    const body = String(it.text || '');
    if (!keywords.some((kw) => subject.indexOf(kw) !== -1 || body.toLowerCase().indexOf(kw) !== -1)) { note(diag, age, 'otherService'); continue; }
    if (diag) diag.seen += 1;
    const inSubject = loginsIn(it.subject, everyLogin).found;
    const { found: inBody, cleaned } = loginsIn(body, everyLogin);
    const found = new Set([...inSubject, ...inBody]);
    if (found.size && ![...found].every((k) => allowed.has(k))) { note(diag, age, 'numberMismatch', found); continue; }
    const otp = extractOtp(cleaned);
    if (!otp) { note(diag, age, 'noCode'); continue; }
    note(diag, age, 'shown', found);
    return { item: it, otp, body, matchedBy: found.size ? 'login' : 'fallback' };
  }
  return null;
}

// Admin-visible count of fallback OTPs (no customer data): app_settings 'getotp_fallback_count' = {"n":…,"last":"YYYY-MM-DD"}.
let fallbackSeen = 0;
async function noteFallback(svcKey) {
  fallbackSeen += 1;
  console.log('[otp] fallback used: ' + svcKey + ' OTP mail had no SIM number - showed the latest one (count since start: ' + fallbackSeen + ')');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  try {
    await db.query("INSERT INTO app_settings (setting_key, value) VALUES ('getotp_fallback_count', ?) ON DUPLICATE KEY UPDATE value = JSON_OBJECT('n', COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(value, '$.n')) AS UNSIGNED), 0) + 1, 'last', ?)",
      [JSON.stringify({ n: 1, last: day }), day]);
  } catch (_) { /* count is optional */ }
}

// ---- ⏱️ How long a forwarded mail stays usable (admin setting, app_settings 'getotp_settings') ----
// Some forwarders are slow, so the owner can stretch the window without touching Hostinger. 5-30 minutes.
const SETTINGS_KEY = 'getotp_settings';
const WINDOW_MIN = 5, WINDOW_MAX = 30;
const QUOTA_MAX = 2000;
/** A service key as the quota is stored: JIOHOTSTAR, ZEE5 … (the same shape as the OTP_QUOTA_* env names). */
const quotaKey = (svc) => String(svc == null ? '' : svc).trim().replace(/\s+/g, '').toUpperCase();
const WINDOW_DEFAULT = Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, Math.round(OTP_EXPIRY_MS / 60e3) || 10));
function validateSettings(input) {
  const i = input || {};
  const n = Math.round(Number(i.windowMin));
  if (!Number.isFinite(n)) return { ok: false, errors: ['Enter how many minutes a forwarded OTP mail stays usable.'] };
  if (n < WINDOW_MIN || n > WINDOW_MAX) return { ok: false, errors: ['Use between ' + WINDOW_MIN + ' and ' + WINDOW_MAX + ' minutes.'] };
  // How many OTPs a customer may pull in a month, per service. Blank / missing = fall back to the env var, so
  // nothing changes until the owner actually sets one here.
  const quotas = {};
  const src = i.quotas && typeof i.quotas === 'object' ? i.quotas : {};
  for (const [k, v] of Object.entries(src)) {
    const key = quotaKey(k);
    if (!key) continue;
    if (v === '' || v == null) continue;                       // cleared -> back to the env var
    const q = Math.round(Number(v));
    if (!Number.isFinite(q) || q < 0 || q > QUOTA_MAX) return { ok: false, errors: ['A monthly limit must be a whole number between 0 and ' + QUOTA_MAX + ' (' + key + ').'] };
    quotas[key] = q;
  }
  return { ok: true, settings: { windowMin: n, quotas } };
}
let cfgCache = null, cfgAt = 0;
async function getSettings(fresh) {
  if (!fresh && cfgCache && Date.now() - cfgAt < 60e3) return cfgCache;
  let saved = null;
  try {
    const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
    saved = r && r[0] && r[0].value ? JSON.parse(r[0].value) : null;
  } catch (_) { saved = null; }
  const v = validateSettings(saved || {});
  cfgCache = v.ok ? v.settings : { windowMin: WINDOW_DEFAULT, quotas: (saved && saved.quotas) || {} };
  cfgAt = Date.now();
  return cfgCache;
}
async function saveSettings(input) {
  const before = await getSettings(true);
  const v = validateSettings(Object.assign({}, before, input || {}));
  if (!v.ok) return { ok: false, status: 400, message: v.errors.join(' '), errors: v.errors };
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTINGS_KEY, JSON.stringify(v.settings)]);
  cfgCache = v.settings; cfgAt = Date.now();
  return { ok: true, settings: v.settings, before };
}

// ---- Why nothing was found: one row per service in app_settings (counts + masked numbers only) ----
const diagKey = (svcKey) => ('getotp_diag_' + String(svcKey || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')).slice(0, 60);
async function saveDiag(svcKey, diag, windowMin) {
  const rec = Object.assign({ at: new Date().toISOString(), service: svcKey, windowMin }, diag);
  try {
    await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [diagKey(svcKey), JSON.stringify(rec).slice(0, 4000)]);
  } catch (_) { /* diagnostics are optional */ }
  const why = ['tooOld', 'otherService', 'numberMismatch', 'noCode'].filter((k) => diag[k]).map((k) => diag[k] + ' ' + REASONS[k]).join(' · ');
  console.log('[otp] ' + svcKey + ': ' + diag.seen + ' mail(s) in the last ' + windowMin + ' min, ' + diag.shown + ' shown' + (why ? ' · ' + why : '') +
    (diag.looseSearch ? ' · found only WITHOUT the subject filter (subjects: ' + (diag.subjects || []).join(' | ') + ')' : '') +
    (!diag.mailsFound ? ' · no mail at all from ' + OTP_EMAIL_FROM + ' in the last hour (is the phone still forwarding?)' : ''));
  return rec;
}
async function readDiag(svcKey) {
  try {
    const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [diagKey(svcKey)]);
    return r && r[0] && r[0].value ? JSON.parse(r[0].value) : null;
  } catch (_) { return null; }
}

/** Every login of this service still in use: inventory accounts not switched off + logins on recent subscriptions. */
const OFF = /^(0|false|no|n|inactive|off)$/i;
async function knownLoginsFor(svcKey) {
  const out = new Set();
  const add = (rows) => { for (const r of rows || []) if (svcKeyOf(r.service) === svcKey && !OFF.test(String(r.is_active == null ? '' : r.is_active).trim())) { const k = loginKey(r.login_id); if (k) out.add(k); } };
  try { add(await db.query('SELECT service, login_id, is_active FROM inventory_accounts', [])); } catch (_) { /* table missing: subscriptions below still count */ }
  add(await db.query("SELECT DISTINCT service, login_id FROM subscriptions WHERE login_id IS NOT NULL AND login_id <> '' AND (expiry_date IS NULL OR expiry_date >= (NOW() - INTERVAL 3 DAY))", []));
  return out;
}

const NOT_READY = 'Your login is not ready here yet. Tap Help and our team will help you.';

/**
 * service, phone, token (otp2 from otpaccess.verifyGetOtpCode), subRef (sub_id or order_id of the plan the customer tapped).
 * deps (tests): { access, withImap, parse, now }
 */
/**
 * 🕘 One line per Get OTP request in the change log: who asked, when, for which service, and how it ended.
 * 🔐 The code is NEVER written down — the line says a code was given, not what it was. Same habit, same screen and
 * the same shared logger as 🏠 Netflix Household (customerlog.js).
 */
function noteOtp(deps, req, phone, svc, outcome, extra) {
  try {
    const log = (deps && deps.customerlog) || require('./customerlog');
    log.record(deps, req || null, {
      action: 'otp.' + outcome, phone,
      summary: svc + ' · ' + OTP_OUTCOME[outcome],
      details: Object.assign({ service: svc }, extra || {}),
    });
  } catch (_) { /* logging must never stop a customer getting their code */ }
}
const OTP_OUTCOME = {
  given: '✅ code given',
  none: '⌛ no fresh code in the inbox',
  noplan: '🚫 refused — no active plan for that email',
  quota: '🚫 refused — monthly limit used up',
  locked: '🔒 refused — this device has not confirmed the email',
};

async function getLatestOtp(service, phone, token, subRef, deps, req) {
  const svc = String(service || '').trim();
  if (!svc) return { ok: false, message: 'Service is required.' };
  const svcKey = svcKeyOf(svc);
  const keywords = (keywordMap()[svcKey] || [svc.toLowerCase()]).map((k) => k.toLowerCase());
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter the phone number you bought with.' };
  const accessMod = (deps && deps.access) || require('./otpaccess');
  // A phone number is not a secret: this device must have confirmed an email that belongs to the plan (otpaccess.js).
  const access = await accessMod.checkGetOtp(ph, token);
  if (!access.ok) { noteOtp(deps, req, ph, svcKey, 'locked'); return Object.assign({ ok: true, found: false }, access); }
  // Only ACTIVE purchases (India date) of this service that the verified email really belongs to.
  const ref = String(subRef == null ? '' : subRef).trim();
  let groups = (await accessMod.unlockedForToken(ph, access.eh)).filter((g) => svcKeyOf(g.lead.service) === svcKey);
  if (ref) groups = groups.filter((g) => g.rows.some((r) => String(r.sub_id || '').trim() === ref || String(r.order_id || '').trim() === ref));
  if (!groups.length) { noteOtp(deps, req, ph, svcKey, 'noplan', { askedFor: ref || undefined }); return { ok: true, found: false, noActive: true, message: accessMod.NO_ACTIVE }; }
  const allowed = new Set(groups.flatMap((g) => g.rows.map((r) => loginKey(r.login_id))).filter(Boolean));
  if (!allowed.size) return { ok: true, found: false, message: NOT_READY };
  const quota = await getOtpQuota(ph, svcKey);
  if (quota.remaining <= 0) { noteOtp(deps, req, ph, svcKey, 'quota', { used: quota.used, limit: quota.limit }); return { ok: true, found: false, message: 'You have used all your OTP requests for ' + svc + ' this month.' }; }
  const known = await knownLoginsFor(svcKey);
  const windowMin = (await getSettings()).windowMin;
  const windowMs = windowMin * 60e3;
  const since = new Date(((deps && deps.now) || Date.now()) - 60 * 60e3);
  const parse = (deps && deps.parse) || require('mailparser').simpleParser;
  const diag = newDiag();

  return ((deps && deps.withImap) || withImap)(async (client) => {
    const lock = await client.getMailboxLock(FOLDER());
    try {
      // 1) each subject a forwarder app is known to use, newest mails only, unread
      let uids = [];
      for (const subject of SUBJECTS()) {
        uids = (await client.search({ from: OTP_EMAIL_FROM, subject, since, seen: false })) || [];
        if (uids.length) { diag.subjectUsed = subject; break; }
      }
      // 2) nothing with a known subject → look at everything that address sent in the last hour (read ones too).
      //    Only the search is widened: the checks that pick a mail are exactly the same.
      if (!uids.length) {
        uids = (await client.search({ from: OTP_EMAIL_FROM, since })) || [];
        diag.looseSearch = uids.length > 0;
      }
      diag.mailsFound = uids.length;
      if (!uids.length) {
        await saveDiag(svcKey, diag, windowMin);
        return { ok: true, found: false, message: 'No OTP email yet. Log in to ' + svc + ' to trigger one, then tap Get OTP.' };
      }
      const now = (deps && deps.now) || Date.now();
      const items = [];
      for await (const msg of client.fetch(uids.slice(-40), { source: true, internalDate: true, uid: true })) {
        const date = msg.internalDate || new Date(0);
        if (now - date.getTime() > windowMs) { note(diag, now - date.getTime(), 'tooOld'); continue; } // too old: not even parsed
        const parsed = await parse(msg.source);
        // What the forwarder calls its mails, so the owner can see it in 🔎 Get OTP check (digits blanked out).
        const sj = blankNumbers(String(parsed.subject || '')).replace(/\s+/g, ' ').trim().slice(0, 40);
        if (sj && diag.subjects.length < 3 && !diag.subjects.includes(sj)) diag.subjects.push(sj);
        items.push({ uid: msg.uid, date, subject: parsed.subject || '', text: String(parsed.text || parsed.html || '') });
      }
      const hit = pickOtpMail(items, { keywords, allowed, known, now, windowMs, diag });
      await saveDiag(svcKey, diag, windowMin);
      if (!hit) { noteOtp(deps, req, ph, svcKey, 'none', { windowMin }); return { ok: true, found: false, message: 'No fresh OTP found for ' + svc + '. Codes expire in ~' + windowMin + ' min — try logging in again.' }; }
      try { await client.messageFlagsAdd({ uid: hit.item.uid }, ['\\Seen'], { uid: true }); } catch (_) {}
      const age = now - hit.item.date.getTime();
      _logOtp(svcKey, hit.otp, ph, hit.body);
      // 🔐 the code is deliberately not passed in — only that one was given, and how many are left this month.
      noteOtp(deps, req, ph, svcKey, 'given', { left: Math.max(0, quota.remaining - 1), limit: quota.limit });
      if (hit.matchedBy === 'fallback') await noteFallback(svcKey);
      return { ok: true, found: true, otp: hit.otp, service: svc, receivedAt: new Date(hit.item.date).toISOString(), ageSec: Math.max(0, Math.round(age / 1000)), remainingSec: Math.max(0, Math.round((windowMs - age) / 1000)) };
    } finally { lock.release(); }
  });
}

/**
 * How many OTPs this phone may still pull for this service this month.
 * The panel wins (admin → 📱 OTP devices → monthly limits), then the OTP_QUOTA_<SERVICE> env var, then 60 —
 * so an untouched service behaves exactly as it did before anything was set here.
 */
/**
 * What each service falls back to when its panel box is left empty: OTP_QUOTA_<SERVICE>, then OTP_QUOTA_DEFAULT,
 * then 60. The screen shows this as the placeholder, so "blank" is never a mystery number.
 */
function quotaDefaults(services) {
  const out = {};
  for (const svc of (services || [])) {
    const key = quotaKey(svc);
    if (!key) continue;
    out[key] = Number(process.env['OTP_QUOTA_' + key] || process.env.OTP_QUOTA_DEFAULT || 60);
  }
  return out;
}

async function getOtpQuota(phone, service) {
  const svcKey = svcKeyOf(service);
  const key = quotaKey(svcKey);
  const envKey = 'OTP_QUOTA_' + key;
  let fromPanel;
  try { fromPanel = ((await getSettings()).quotas || {})[key]; } catch (_) { fromPanel = undefined; }
  const limit = Number.isFinite(Number(fromPanel)) && fromPanel !== '' && fromPanel != null
    ? Number(fromPanel)
    : Number(process.env[envKey] || process.env.OTP_QUOTA_DEFAULT || 60);
  const source = (Number.isFinite(Number(fromPanel)) && fromPanel != null) ? 'panel' : (process.env[envKey] || process.env.OTP_QUOTA_DEFAULT ? 'env' : 'default');
  const ph = norm(phone);
  let used = 0;
  try {
    const r = await db.query("SELECT COUNT(*) n FROM sms_otp_log WHERE phone_norm = ? AND service = ? AND ts >= DATE_FORMAT(NOW(),'%Y-%m-01')", [ph, svcKey]);
    used = +(r[0] || {}).n || 0;
  } catch (_) {}
  return { ok: true, service: svcKey, limit, used, remaining: Math.max(0, limit - used), source };
}

/* ================= Admin: 🔎 Get OTP check (adminotpdevices.js) ================= */

/** Which OTP service a mail's words point at ('' = none of ours). Longer service names win, like svcKeyOf. */
function serviceOfMail(text) {
  const hay = String(text || '').toLowerCase();
  const map = keywordMap();
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  return keys.find((k) => (map[k] || []).some((kw) => hay.indexOf(String(kw).toLowerCase()) !== -1)) || '';
}

/**
 * Self-test: what the parser makes of ONE pasted forwarded mail, and which rule would accept or refuse it.
 * The owner pastes the mail themselves, so the code is shown back; every phone number is masked.
 * { service?, subject?, text }, known = login keys of that service. Pure - no mailbox, no writes.
 */
function explainMail(input) {
  const subject = String((input && input.subject) || '');
  const text = String((input && input.text) || '');
  const known = new Set((input && input.known) || []);
  if (!text.trim() && !subject.trim()) return { ok: false, message: 'Paste the forwarded mail first.' };
  const service = serviceOfMail(subject + ' ' + text) || svcKeyOf((input && input.service) || '');
  const inSubject = loginsIn(subject, known);
  const inBody = loginsIn(text, known);
  const found = new Set([...inSubject.found, ...inBody.found]);
  const otp = extractOtp(inBody.cleaned) || extractOtp(inSubject.cleaned);
  const numbers = [...found].map(maskKey);
  const ignored = [...inSubject.ignored, ...inBody.ignored].map(maskNum);
  const out = { ok: true, service, otp, numbers, ignored };
  if (!service) return Object.assign(out, { verdict: 'refused', reason: 'No OTP service found in this mail. Add its sender words to OTP_EXTRA_KEYWORDS.' });
  if (!otp) return Object.assign(out, { verdict: 'refused', reason: 'No code could be read out of this mail.' });
  if (!found.size) return Object.assign(out, { verdict: 'shown', reason: 'It names no number, so it is used as the latest ' + service + ' code inside the time window.' + (ignored.length ? ' Ignored (not a recipient): ' + ignored.join(', ') + '.' : '') });
  const ours = [...found].every((k) => known.has(k));
  return Object.assign(out, ours
    ? { verdict: 'shown', reason: 'It names ' + numbers.join(', ') + ' — one of your ' + service + ' logins, so only that login\'s customers see it.' }
    : { verdict: 'refused', reason: 'It names ' + numbers.join(', ') + ', which is not one of your ' + service + ' logins, so the code is never shown.' });
}

/** Admin panel: the time-window setting + the last Get OTP run per service (counts and masked numbers only). */
async function adminDiagnostics(service) {
  const wanted = svcKeyOf(service);
  const keys = Object.keys(keywordMap());
  const list = service && keys.includes(wanted) ? [wanted] : keys;
  const settings = await getSettings(true);
  const runs = [];
  for (const k of list) { const d = await readDiag(k); if (d) runs.push(d); }
  return { ok: true, settings, min: WINDOW_MIN, max: WINDOW_MAX, services: keys, runs };
}

/** Admin panel: run one pasted mail through the parser against this service's real logins. */
async function adminSelfTest(input) {
  const text = String((input && input.text) || '');
  const subject = String((input && input.subject) || '');
  const svcKey = serviceOfMail(subject + ' ' + text) || svcKeyOf((input && input.service) || '');
  let known = new Set();
  if (svcKey) { try { known = await knownLoginsFor(svcKey); } catch (_) { known = new Set(); } }
  return Object.assign(explainMail({ service: svcKey, subject, text, known }), { logins: known.size });
}

module.exports = {
  quotaDefaults,
  getLatestOtp, getOtpQuota, getSettings, saveSettings, adminDiagnostics, adminSelfTest,
  _internal: { extractOtp, svcKeyOf, loginKey, loginsIn, pickOtpMail, mobileLast10, blankNumbers, explainMail, serviceOfMail, newDiag, validateSettings, diagKey, WINDOW_MIN, WINDOW_MAX, QUOTA_MAX, quotaKey, noteOtp, OTP_OUTCOME },
};
