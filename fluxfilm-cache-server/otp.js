/**
 * FluxFilm - Get OTP tool on Node (login-OTP for JioHotstar / Zee5 / SonyLIV).
 * An SMS-Forwarder app emails the SMS OTP to the FluxFilm Gmail; this reads that
 * inbox over IMAP (same account used for payments), extracts the code, marks the
 * mail read (so it's served once), and logs it for the monthly quota. No Apps Script.
 *
 * Safety (15 Sep 2026): needs an otp2 device token (email that belongs to the plan, otpaccess.js); only ACTIVE
 * purchases of that service unlocked by that email; only mails from the last 10 minutes; and only an OTP for
 * THAT purchase's login (see pickOtpMail) - never another account's.
 */
const db = require('./db');

const OTP_EXPIRY_MS = Number(process.env.OTP_FRESH_MIN || 10) * 60 * 1000;
const OTP_EMAIL_FROM = process.env.OTP_EMAIL_FROM || process.env.IMAP_USER || 'harshwalia8888@gmail.com';
const FOLDER = () => process.env.IMAP_FOLDER || '[Gmail]/All Mail';
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
/** Login keys a mail's text names (every 10+ digit phone number, and any `known` email login), plus the text with phone numbers blanked out. */
function loginsIn(text, known) {
  const t = String(text || '');
  const found = new Set();
  const phones = new Set();
  const cleaned = t.replace(/\+?\d[\d \-]{8,18}\d/g, (run) => {
    const d = run.replace(/\D/g, '');
    if (d.length < 10) return run;
    phones.add('p:' + d.slice(-10));
    return ' ';
  });
  for (const k of known) {
    if (k.startsWith('e:') && t.toLowerCase().indexOf(k.slice(2)) !== -1) found.add(k);
  }
  for (const k of phones) found.add(k); // every phone number counts, even one we don't know
  return { found, cleaned };
}
/**
 * Newest mail (inside the fresh window) whose OTP belongs to one of `allowed` logins. Returns { item, otp, body },
 * { unsure } (only mails that could be for another login) or null.
 *  - a mail that names a login / phone number is used only when every login and number in it is this plan's;
 *  - a mail that names no login (the SMS forwarder does not add the SIM number) is used only when this service
 *    has exactly ONE login in our records, so it can never be another account's OTP.
 * items: [{ uid, date, subject, text }]
 */
function pickOtpMail(items, opts) {
  const { keywords, allowed, known, now, windowMs } = opts;
  const everyLogin = new Set([...known, ...allowed]);
  const onlyOneLogin = everyLogin.size === 1 && allowed.size === 1;
  const list = (items || []).slice().sort((a, b) => b.date.getTime() - a.date.getTime());
  let unsure = false;
  for (const it of list) {
    const age = now - it.date.getTime();
    if (!(age >= -60e3 && age <= windowMs)) continue;
    const subject = String(it.subject || '').toLowerCase();
    const body = String(it.text || '');
    if (!keywords.some((kw) => subject.indexOf(kw) !== -1 || body.toLowerCase().indexOf(kw) !== -1)) continue;
    const inSubject = loginsIn(it.subject, everyLogin).found;
    const { found: inBody, cleaned } = loginsIn(body, everyLogin);
    const found = new Set([...inSubject, ...inBody]);
    if (found.size) {
      if (![...found].every((k) => allowed.has(k))) continue;
    } else if (!onlyOneLogin) { if (extractOtp(cleaned)) unsure = true; continue; }
    const otp = extractOtp(cleaned);
    if (!otp) continue;
    return { item: it, otp, body };
  }
  return unsure ? { unsure: true } : null;
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
async function getLatestOtp(service, phone, token, subRef, deps) {
  const svc = String(service || '').trim();
  if (!svc) return { ok: false, message: 'Service is required.' };
  const svcKey = svcKeyOf(svc);
  const keywords = (keywordMap()[svcKey] || [svc.toLowerCase()]).map((k) => k.toLowerCase());
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'Enter the phone number you bought with.' };
  const accessMod = (deps && deps.access) || require('./otpaccess');
  // A phone number is not a secret: this device must have confirmed an email that belongs to the plan (otpaccess.js).
  const access = await accessMod.checkGetOtp(ph, token);
  if (!access.ok) return Object.assign({ ok: true, found: false }, access);
  // Only ACTIVE purchases (India date) of this service that the verified email really belongs to.
  const ref = String(subRef == null ? '' : subRef).trim();
  let groups = (await accessMod.unlockedForToken(ph, access.eh)).filter((g) => svcKeyOf(g.lead.service) === svcKey);
  if (ref) groups = groups.filter((g) => g.rows.some((r) => String(r.sub_id || '').trim() === ref || String(r.order_id || '').trim() === ref));
  if (!groups.length) return { ok: true, found: false, noActive: true, message: accessMod.NO_ACTIVE };
  const allowed = new Set(groups.flatMap((g) => g.rows.map((r) => loginKey(r.login_id))).filter(Boolean));
  if (!allowed.size) return { ok: true, found: false, message: NOT_READY };
  const quota = await getOtpQuota(ph, svcKey);
  if (quota.remaining <= 0) return { ok: true, found: false, message: 'You have used all your OTP requests for ' + svc + ' this month.' };
  const known = await knownLoginsFor(svcKey);
  const windowMs = Math.min(OTP_EXPIRY_MS, 10 * 60e3);
  const since = new Date(((deps && deps.now) || Date.now()) - 60 * 60e3);
  const parse = (deps && deps.parse) || require('mailparser').simpleParser;

  return ((deps && deps.withImap) || withImap)(async (client) => {
    const lock = await client.getMailboxLock(FOLDER());
    try {
      const uids = await client.search({ from: OTP_EMAIL_FROM, subject: 'SMSForwarder', since, seen: false });
      if (!uids || !uids.length) return { ok: true, found: false, message: 'No OTP email yet. Log in to ' + svc + ' to trigger one, then tap Get OTP.' };
      const now = (deps && deps.now) || Date.now();
      const items = [];
      for await (const msg of client.fetch(uids.slice(-40), { source: true, internalDate: true, uid: true })) {
        const date = msg.internalDate || new Date(0);
        if (now - date.getTime() > windowMs) continue; // too old: not even parsed
        const parsed = await parse(msg.source);
        items.push({ uid: msg.uid, date, subject: parsed.subject || '', text: String(parsed.text || parsed.html || '') });
      }
      const hit = pickOtpMail(items, { keywords, allowed, known, now, windowMs });
      if (hit && hit.unsure) {
        console.log('[otp] ' + svcKey + ' OTP mail does not say which login it is for (several logins in use) - not shown');
        return { ok: true, found: false, message: 'We got an OTP but could not match it to your account. Please tap Help and our team will send it to you.' };
      }
      if (!hit) return { ok: true, found: false, message: 'No fresh OTP found for ' + svc + '. Codes expire in ~10 min — try logging in again.' };
      try { await client.messageFlagsAdd({ uid: hit.item.uid }, ['\\Seen'], { uid: true }); } catch (_) {}
      const age = now - hit.item.date.getTime();
      _logOtp(svcKey, hit.otp, ph, hit.body);
      return { ok: true, found: true, otp: hit.otp, service: svc, receivedAt: new Date(hit.item.date).toISOString(), ageSec: Math.max(0, Math.round(age / 1000)), remainingSec: Math.max(0, Math.round((windowMs - age) / 1000)) };
    } finally { lock.release(); }
  });
}

async function getOtpQuota(phone, service) {
  const svcKey = svcKeyOf(service);
  const envKey = 'OTP_QUOTA_' + svcKey.replace(/\s+/g, '').toUpperCase();
  const limit = Number(process.env[envKey] || process.env.OTP_QUOTA_DEFAULT || 60);
  const ph = norm(phone);
  let used = 0;
  try {
    const r = await db.query("SELECT COUNT(*) n FROM sms_otp_log WHERE phone_norm = ? AND service = ? AND ts >= DATE_FORMAT(NOW(),'%Y-%m-01')", [ph, svcKey]);
    used = +(r[0] || {}).n || 0;
  } catch (_) {}
  return { ok: true, service: svcKey, limit, used, remaining: Math.max(0, limit - used) };
}

module.exports = { getLatestOtp, getOtpQuota, _internal: { extractOtp, svcKeyOf, loginKey, loginsIn, pickOtpMail } };
