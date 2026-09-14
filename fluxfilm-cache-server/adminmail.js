/**
 * FluxFilm - admin ✉️ email sender check (admin-only; shown in 🔔 Notifications).
 *
 *   GET  /admin/api/email/status   → { sender, senderKind ('support' | 'gmail'), fallback, replyTo, supportHalfSet, lastError, lastOk }
 *   POST /admin/api/email/test     { to }   sends a short test email, answers which address actually sent it
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const smtp = deps.smtp || require('./smtp');
  const s = (v) => String(v == null ? '' : v).trim();

  app.get('/admin/api/email/status', (req, res) => {
    if (!auth(req, res)) return;
    res.json(Object.assign({ ok: true }, smtp.status()));
  });

  app.post('/admin/api/email/test', async (req, res) => {
    if (!auth(req, res)) return;
    const to = s((req.body || {}).to).slice(0, 120);
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(to)) return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    try {
      const r = await smtp.sendMail({
        to, subject: '✅ FluxFilm test email',
        html: '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:460px;margin:auto"><h2 style="color:#16a34a">✅ Email is working</h2>' +
          '<p style="color:#475569">This test was sent by the FluxFilm shop. Customers get their access details, recovery codes and reminders from this address.</p>' +
          '<p style="color:#94a3b8;font-size:12px">If this landed in Spam, mark it “Not spam” and check the DKIM / SPF records for your domain.</p></div>',
      });
      if (!r.ok) return res.status(400).json({ ok: false, message: 'Email is not set up on the server (SMTP_USER / SMTP_PASS or IMAP_USER / IMAP_PASS).' });
      audit.record(req, { action: 'email.test', entity: 'email', id: to, summary: 'Test email sent from ' + r.sender + (r.fellBack ? ' (support mailbox failed, used Gmail)' : '') });
      res.json(Object.assign({ ok: true }, r, { status: smtp.status() }));
    } catch (e) {
      res.status(500).json({ ok: false, message: s(e && (e.response || e.message)).slice(0, 200) || 'Sending failed', status: smtp.status() });
    }
  });
}

module.exports = { mount };
