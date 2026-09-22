/**
 * FluxFilm - transactional email from Node. Sending goes through smtp.js (support@ mailbox when SMTP_USER/SMTP_PASS
 * are set, else the IMAP Gmail).
 * Replaces the Apps Script credentials/manual email so the buy flow is Apps-Script-free.
 */
const smtp = require('./smtp');
function row(label, val) {
  if (!val) return '';
  return '<tr><td style="padding:8px 12px;color:#64748b;font-size:13px">' + label +
    '</td><td style="padding:8px 12px;font-weight:700;font-size:14px">' + val + '</td></tr>';
}

// payload: { orderId, email, name, service, plan, amount, expiry, manual, postPaymentMessage, renewNote,
//            access:{ user, pass, profileName, profilePin, deviceType } }
async function sendAccessEmail(payload) {
  const p = payload || {};
  const to = String(p.email || '').trim();
  if (!to || to.indexOf('@') < 0) return { ok: false, skipped: 'no email' };
  if (!smtp.status().configured) return { ok: false, skipped: 'smtp not configured' };

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
    // F1: a plan with 2+ devices — one block per device, or one block + "use it on all devices".
    const logins = Array.isArray(a.logins) ? a.logins : [];
    if (logins.length > 1 && a.sameLogin) {
      rows += '<tr><td colspan="2" style="padding:8px 12px;color:#166534;font-weight:700;font-size:13px">✅ Use this same login on ' + (logins.length === 2 ? 'both devices' : 'all ' + logins.length + ' devices') + '.</td></tr>';
    } else if (logins.length > 1) {
      rows = logins.map((x) =>
        '<tr><td colspan="2" style="padding:12px 12px 2px;font-weight:800;font-size:14px;color:#0f172a">📱 Device ' + escHtml(x.device) + '</td></tr>' +
        row('Login / Email', escHtml(x.user)) + row('Password', escHtml(x.pass)) + row('Profile', escHtml([x.profileName, x.profileNumber ? '#' + x.profileNumber : ''].filter(Boolean).join(' '))) + row('Profile PIN', escHtml(x.profilePin)) +
        row('Device', escHtml(x.deviceType === 'TV' ? 'TV' : x.deviceType === 'NON_TV' ? 'Mobile / laptop' : x.deviceType))).join('') +
        '<tr><td colspan="2" style="padding:10px 12px;color:#475569;font-size:13px">Each device has its own login — use Device 1\'s details on your first device, Device 2\'s on the second.</td></tr>';
    }
    // p.switched: 🔁 the owner moved this plan to another account (adminswitch.js) — same details block, new wording.
    subject = p.switched ? '🔁 Your FluxFilm ' + (p.service || '') + ' login was updated' : '🎬 Your FluxFilm ' + (p.service || '') + ' access — ' + (p.orderId || '');
    html =
      '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' +
      (p.switched
        ? '<h2 style="color:#1d4ed8;margin-bottom:4px">🔁 Your ' + escHtml(p.service || 'FluxFilm') + ' login was updated</h2>' +
          '<p style="color:#475569;margin-top:0">Hi ' + escHtml(p.name || 'there') + ', here are your new login details.</p>'
        : '<h2 style="color:#16a34a;margin-bottom:4px">🎬 Your FluxFilm access is ready!</h2>' +
          '<p style="color:#475569;margin-top:0">Hi ' + (p.name || 'there') + ', thanks for your order.</p>') +
      '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:8px 4px;margin:14px 0">' +
      '<table style="width:100%;border-collapse:collapse">' +
      row('Service', p.service) + row('Plan', p.plan) + row('Order ID', p.orderId) + row('Valid till', p.expiry) + rows +
      '</table></div>' +
      (p.loginNotice ? '<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:10px;padding:12px;font-size:13px;color:#9a3412;margin-bottom:10px">ℹ️ ' + escHtml(p.loginNotice) + '</div>' : '') +
      // 🎁 Renewal: why the new date is what it is — how many late days were counted and how many were gifted.
      // The sentence arrives with WhatsApp's *bold* markers (watext.js); here they become <b>, escaped.
      (p.renewNote ? '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:12px;font-size:13px;color:#166534;margin-bottom:10px">' + require('./watext').html(p.renewNote) + '</div>' : '') +
      (p.postPaymentMessage ? '<div style="background:#fef9c3;border-radius:10px;padding:12px;white-space:pre-line;font-size:13px">' + p.postPaymentMessage + '</div>' : '') +
      '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';
  }
  return smtp.sendMail({ to, subject, html });
}

const escHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SITE = () => process.env.SITE_URL || 'https://shop.fluxfilm.in';
const wrap = (inner) => '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' + inner +
  '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp. 💚</p></div>';

async function send(to, subject, html) {
  const addr = String(to || '').trim();
  if (!addr || addr.indexOf('@') < 0) return { ok: false, skipped: 'no email' };
  if (!smtp.status().configured) return { ok: false, skipped: 'smtp not configured' };
  return smtp.sendMail({ to: addr, subject, html });
}

// payload: { email, name, service, plan, expiryText, daysLeft }  (daysLeft < 0 = already ended)
async function sendRenewalReminder(p) {
  p = p || {};
  const ended = Number(p.daysLeft) < 0;
  const when = ended ? 'ended on ' + p.expiryText : (Number(p.daysLeft) === 0 ? 'ends today' : 'ends on ' + p.expiryText + (p.daysLeft != null ? ' (' + p.daysLeft + ' day' + (Number(p.daysLeft) === 1 ? '' : 's') + ' left)' : ''));
  const subject = (ended ? '⏰ Your FluxFilm ' : '⏳ Your FluxFilm ') + (p.service || '') + ' ' + (ended ? 'has ended — renew now' : 'is ending soon');
  const html = wrap(
    '<h2 style="color:' + (ended ? '#dc2626' : '#b45309') + ';margin-bottom:4px">' + (ended ? '⏰ Your plan has ended' : '⏳ Your plan is ending soon') + '</h2>' +
    '<p style="color:#475569;margin-top:0">Hi ' + escHtml(p.name || 'there') + ',</p>' +
    '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px">' +
    '<b>' + escHtml(p.service) + '</b> — ' + escHtml(p.plan) + '<br>' + escHtml(when) + '</div>' +
    '<p style="color:#475569;font-size:14px">' + (ended ? 'Renew in a minute to get back to watching — ' : 'Renew early and keep watching without a break — ') +
    'open FluxFilm, enter your phone number and tap <b>Renew</b>.</p>' +
    '<p><a href="' + escHtml(SITE()) + '" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Renew now</a></p>');
  return send(p.email, subject, html);
}

// payload: { email, name, service, plan, login, password, profileName, profilePin }
async function sendPasswordChanged(p) {
  p = p || {};
  const rows = row('Service', escHtml(p.service)) + row('Plan', escHtml(p.plan)) + row('Login / Email', escHtml(p.login)) + row('New password', escHtml(p.password)) +
    row('Profile', escHtml(p.profileName)) + row('Profile PIN', escHtml(p.profilePin));
  const html = wrap(
    '<h2 style="color:#1d4ed8;margin-bottom:4px">🔑 Your login details changed</h2>' +
    '<p style="color:#475569;margin-top:0">Hi ' + escHtml(p.name || 'there') + ', we updated the password of your FluxFilm ' + escHtml(p.service) + ' account. Please log in again with:</p>' +
    '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:8px 4px;margin:14px 0"><table style="width:100%;border-collapse:collapse">' + rows + '</table></div>' +
    '<p style="color:#475569;font-size:13px">Your plan and expiry date are unchanged.</p>');
  return send(p.email, '🔑 New password for your FluxFilm ' + (p.service || '') + ' account', html);
}

module.exports = { send, sendAccessEmail, sendRenewalReminder, sendPasswordChanged };
