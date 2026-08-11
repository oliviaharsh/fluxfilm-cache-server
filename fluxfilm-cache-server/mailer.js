/**
 * FluxFilm - transactional email from Node (Gmail SMTP, same app password as IMAP).
 * Replaces the Apps Script credentials/manual email so the buy flow is Apps-Script-free.
 */
let _t = null;
function transport() {
  if (_t) return _t;
  const nodemailer = require('nodemailer');
  _t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: String(process.env.IMAP_PASS || '').replace(/\s+/g, '') },
  });
  return _t;
}
function row(label, val) {
  if (!val) return '';
  return '<tr><td style="padding:8px 12px;color:#64748b;font-size:13px">' + label +
    '</td><td style="padding:8px 12px;font-weight:700;font-size:14px">' + val + '</td></tr>';
}

// payload: { orderId, email, name, service, plan, amount, expiry, manual, postPaymentMessage,
//            access:{ user, pass, profileName, profilePin, deviceType } }
async function sendAccessEmail(payload) {
  const p = payload || {};
  const to = String(p.email || '').trim();
  if (!to || to.indexOf('@') < 0) return { ok: false, skipped: 'no email' };
  const user = process.env.IMAP_USER;
  if (!user) return { ok: false, skipped: 'smtp not configured' };

  let html, subject;
  if (p.manual) {
    subject = '✅ FluxFilm order received — ' + (p.service || '') + ' ' + (p.orderId || '');
    html =
      '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' +
      '<h2 style="color:#16a34a;margin-bottom:4px">✅ Payment received — activating soon!</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + (p.name || 'there') + ', thanks for your order.</p>' +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:8px 12px;margin:14px 0;font-size:14px">' +
      '<b>' + (p.service || '') + '</b> — ' + (p.plan || '') + '<br>Order ID: ' + (p.orderId || '') + '</div>' +
      '<p style="color:#475569;font-size:14px">We\'ll activate this manually and email your access within a few hours. 💚</p>' +
      (p.postPaymentMessage ? '<div style="background:#fef9c3;border-radius:10px;padding:12px;white-space:pre-line;font-size:13px">' + p.postPaymentMessage + '</div>' : '') +
      '</div>';
  } else {
    const a = p.access || {};
    let rows = row('Login / Email', a.user) + row('Password', a.pass) +
      row('Profile', a.profileName) + row('Profile PIN', a.profilePin) + row('Device', a.deviceType);
    subject = '🎬 Your FluxFilm ' + (p.service || '') + ' access — ' + (p.orderId || '');
    html =
      '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' +
      '<h2 style="color:#16a34a;margin-bottom:4px">🎬 Your FluxFilm access is ready!</h2>' +
      '<p style="color:#475569;margin-top:0">Hi ' + (p.name || 'there') + ', thanks for your order.</p>' +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:8px 4px;margin:14px 0">' +
      '<table style="width:100%;border-collapse:collapse">' +
      row('Service', p.service) + row('Plan', p.plan) + row('Order ID', p.orderId) + row('Valid till', p.expiry) + rows +
      '</table></div>' +
      (p.postPaymentMessage ? '<div style="background:#fef9c3;border-radius:10px;padding:12px;white-space:pre-line;font-size:13px">' + p.postPaymentMessage + '</div>' : '') +
      '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';
  }
  await transport().sendMail({ from: '"FluxFilm" <' + user + '>', to, subject, html });
  return { ok: true };
}

module.exports = { sendAccessEmail };
