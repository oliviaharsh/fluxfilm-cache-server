/**
 * FluxFilm - Get OTP tool on Node (login-OTP for JioHotstar / Zee5 / SonyLIV).
 * An SMS-Forwarder app emails the SMS OTP to the FluxFilm Gmail; this reads that
 * inbox over IMAP (same account used for payments), extracts the code, marks the
 * mail read (so it's served once), and logs it for the monthly quota. No Apps Script.
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
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
function svcKeyOf(service) {
  const s = String(service || '').toLowerCase();
  return Object.keys(KEYWORDS).find((k) => s.indexOf(k.toLowerCase()) !== -1) || String(service || '');
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

async function getLatestOtp(service, phone) {
  const svc = String(service || '').trim();
  if (!svc) return { ok: false, message: 'Service is required.' };
  const svcKey = svcKeyOf(svc);
  const keywords = (KEYWORDS[svcKey] || [svc.toLowerCase()]).map((k) => k.toLowerCase());
  const ph = norm(phone);
  const since = new Date(Date.now() - 24 * 3600 * 1000);

  return withImap(async (client) => {
    const lock = await client.getMailboxLock(FOLDER());
    try {
      const uids = await client.search({ from: OTP_EMAIL_FROM, subject: 'SMSForwarder', since, seen: false });
      if (!uids || !uids.length) return { ok: true, found: false, message: 'No OTP email yet. Log in to ' + svc + ' to trigger one, then tap Get OTP.' };
      const { simpleParser } = require('mailparser');
      const items = [];
      for await (const msg of client.fetch(uids.slice(-40), { source: true, internalDate: true, uid: true })) {
        items.push({ uid: msg.uid, date: msg.internalDate || new Date(), source: msg.source });
      }
      items.sort((a, b) => b.date.getTime() - a.date.getTime());
      const now = Date.now();
      for (const it of items) {
        if (now - it.date.getTime() > OTP_EXPIRY_MS) continue;
        const parsed = await simpleParser(it.source);
        const subject = String(parsed.subject || '').toLowerCase();
        const body = String(parsed.text || parsed.html || '');
        const bodyLC = body.toLowerCase();
        if (!keywords.some((kw) => subject.indexOf(kw) !== -1 || bodyLC.indexOf(kw) !== -1)) continue;
        const otp = extractOtp(body);
        if (!otp) continue;
        try { await client.messageFlagsAdd({ uid: it.uid }, ['\\Seen'], { uid: true }); } catch (_) {}
        const ageSec = Math.round((now - it.date.getTime()) / 1000);
        const remainingSec = Math.max(0, Math.round((OTP_EXPIRY_MS - (now - it.date.getTime())) / 1000));
        _logOtp(svcKey, otp, ph, body);
        return { ok: true, found: true, otp, service: svc, receivedAt: new Date(it.date).toISOString(), ageSec, remainingSec };
      }
      return { ok: true, found: false, message: 'No fresh OTP found for ' + svc + '. Codes expire in ~10 min — try logging in again.' };
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

module.exports = { getLatestOtp, getOtpQuota, _internal: { extractOtp, svcKeyOf } };
