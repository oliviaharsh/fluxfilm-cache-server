/**
 * FluxFilm - one place that sends customer email (access, recovery code, reminders, password change).
 *
 * Sender: the support mailbox when SMTP_USER + SMTP_PASS are set (e.g. support@fluxfilm.in, Google Workspace
 * app password), otherwise the Gmail used for reading bank emails (IMAP_USER / IMAP_PASS) — so nothing stops
 * working before the support mailbox is set up.
 * If the support login is refused (wrong / revoked app password) the email is re-sent from the Gmail account,
 * so a customer never misses their access details; the failure is kept for admin → email status.
 *
 * Env (Hostinger, secrets only): SMTP_USER, SMTP_PASS, optional SMTP_FROM_NAME (default FluxFilm),
 * SMTP_REPLY_TO (default = sender), SMTP_HOST (smtp.gmail.com), SMTP_PORT (465).
 * Reading bank / OTP email always stays on IMAP_USER.
 */
const s = (v) => String(v == null ? '' : v).trim();
const clean = (v) => s(v).replace(/\s+/g, '');

function accounts(env) {
  const e = env || process.env;
  const list = [];
  if (s(e.SMTP_USER) && clean(e.SMTP_PASS)) list.push({ kind: 'support', user: s(e.SMTP_USER), pass: clean(e.SMTP_PASS) });
  if (s(e.IMAP_USER) && clean(e.IMAP_PASS) && s(e.IMAP_USER).toLowerCase() !== s(e.SMTP_USER).toLowerCase()) list.push({ kind: 'gmail', user: s(e.IMAP_USER), pass: clean(e.IMAP_PASS) });
  if (!list.length && s(e.IMAP_USER)) list.push({ kind: 'gmail', user: s(e.IMAP_USER), pass: clean(e.IMAP_PASS) });
  return list;
}

/** What admin may see (never the password). */
function status(env) {
  const e = env || process.env;
  const a = accounts(e);
  return {
    configured: a.length > 0,
    sender: a[0] ? a[0].user : '',
    senderKind: a[0] ? a[0].kind : '',
    fallback: a[1] ? a[1].user : '',
    replyTo: s(e.SMTP_REPLY_TO) || (a[0] ? a[0].user : ''),
    supportHalfSet: !!(s(e.SMTP_USER) || clean(e.SMTP_PASS)) && !(s(e.SMTP_USER) && clean(e.SMTP_PASS)),
    lastError: state.lastError,
    lastOk: state.lastOk,
  };
}

const state = { lastError: null, lastOk: null };
const transports = new Map();
let makeTransport = (acc, e) => require('nodemailer').createTransport({
  host: s(e.SMTP_HOST) || 'smtp.gmail.com',
  port: Number(e.SMTP_PORT || 465),
  secure: true,
  auth: { user: acc.user, pass: acc.pass },
});
function transportFor(acc, e) {
  const k = acc.user + '|' + acc.pass;
  if (!transports.has(k)) transports.set(k, makeTransport(acc, e));
  return transports.get(k);
}
// Only a refused login / sender switches to the Gmail account. A bad recipient would fail the same way from both.
const isAccountProblem = (err) => /EAUTH|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNECTION|ESOCKET/.test(s(err && err.code)) || /535|534|530|Username and Password not accepted|Invalid login|Application-specific password/i.test(s(err && (err.response || err.message)));

/** sendMail({ to, subject, html }) → { ok, sender, fellBack } — throws only when every account failed. */
async function sendMail(msg, env) {
  const e = env || process.env;
  const list = accounts(e);
  if (!list.length) return { ok: false, skipped: 'smtp not configured' };
  const name = (s(e.SMTP_FROM_NAME) || 'FluxFilm').replace(/["<>\r\n]/g, '');
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const acc = list[i];
    const replyTo = s(e.SMTP_REPLY_TO) || list[0].user;
    try {
      await transportFor(acc, e).sendMail({ from: '"' + name + '" <' + acc.user + '>', replyTo, to: msg.to, subject: msg.subject, html: msg.html });
      state.lastOk = { at: new Date().toISOString(), sender: acc.user };
      return { ok: true, sender: acc.user, fellBack: i > 0 };
    } catch (err) {
      lastErr = err;
      state.lastError = { at: new Date().toISOString(), sender: acc.user, message: s(err && (err.response || err.message)).slice(0, 200) };
      console.log('[smtp] send from ' + acc.user + ' failed:', state.lastError.message);
      if (!isAccountProblem(err)) break;
    }
  }
  throw lastErr;
}

module.exports = { sendMail, status, accounts, _internal: { state, isAccountProblem, setTransportFactory: (f) => { makeTransport = f; transports.clear(); }, reset: () => { transports.clear(); state.lastError = null; state.lastOk = null; } } };
