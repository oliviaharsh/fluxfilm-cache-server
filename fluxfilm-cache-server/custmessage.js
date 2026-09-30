/**
 * FluxFilm — ✉️ Message a customer (admin only).
 *
 * Owner, 30 Sep 2026, mid-anniversary-sale: three customers had abandoned carts and he wanted to tell them
 * about the 40% off. Push reached ONE of the three (18 of ~300 customers have notifications on). There was
 * no way to email the other two: the only customer-email endpoint is `/admin/api/reminders/email`, which
 * sends a FIXED "your plan is ending" template keyed on a subscription id — the wrong message, and two of
 * the three had no subscription to key it on. So the answer was WhatsApp, by hand, one at a time.
 *
 * This is the missing piece: type a subject and a message, see exactly who it reaches and what it will look
 * like, send it. Email always; push as well when that customer has a device.
 *
 *   GET  /admin/api/message/who?phone=   → who it would reach (reads only, sends nothing)
 *   POST /admin/api/message/preview      → the exact rendered email (sends nothing)
 *   POST /admin/api/message/send         → sends it
 *
 * 🔒 These are REAL messages to REAL people, so:
 *   · ONE customer per call. There is no list, no "all customers", no import. Reaching everybody is what
 *     the broadcast on 🔔 Notifications is for, and it has its own guard rails.
 *   · the body is ESCAPED before it goes into the HTML — the owner types text, never markup.
 *   · every send is written to reminder_log (kind MESSAGE, sub_id = the phone), the same habit as every
 *     other sender here, so "did I already message them?" has an answer.
 *   · a second message to the same person inside QUIET_MIN is refused unless the owner says again.
 *   · nothing is sent by preview, and `who` touches nothing at all.
 */
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e && e.message));

const SUBJECT_MAX = 120;
const BODY_MAX = 2000;
const QUIET_MIN = 10;          // don't let a double-tap send twice
const PUSH_BODY_MAX = 240;     // what a notification can actually show

// Tests replace these.
const deps = {
  now: () => new Date(),
  mailer: () => require('./mailer'),
  push: () => require('./push'),
};

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

/** Who this phone number belongs to, and how we can actually reach them. Reads only. */
async function who(phone, query) {
  const q = query || ((sql, p) => db.query(sql, p));
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Enter a 10-digit phone number.' };
  const rows = await q('SELECT name, email, phone_norm FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
  const c = rows[0];
  let devices = 0;
  try { devices = ((await q("SELECT COUNT(*) n FROM push_subscriptions WHERE phone_norm = ? AND disabled = 0", [ph]))[0] || {}).n || 0; }
  catch (e) { if (!missingTable(e)) throw e; }
  let plans = [];
  try { plans = await q("SELECT service, plan, expiry_date FROM subscriptions WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' ORDER BY expiry_date LIMIT 6", [ph]); }
  catch (e) { if (!missingTable(e)) throw e; }
  let last = null;
  try {
    const r = await q("SELECT ts FROM reminder_log WHERE channel = 'MESSAGE' AND sub_id = ? ORDER BY ts DESC LIMIT 1", [ph]);
    last = r[0] ? s(r[0].ts) : null;
  } catch (e) { if (!missingTable(e)) throw e; }
  return {
    ok: true,
    found: !!c,
    phone: ph,
    name: c ? s(c.name) : '',
    email: c ? s(c.email) : '',
    devices: Number(devices) || 0,
    plans: (plans || []).map((p) => ({ service: s(p.service), plan: s(p.plan), expiry: s(p.expiry_date).slice(0, 10) })),
    lastMessagedAt: last,
    // What will actually happen, said plainly, before anything is typed.
    reach: [c && s(c.email) ? 'email' : null, Number(devices) > 0 ? 'push' : null].filter(Boolean),
  };
}

/** Validate what the owner typed. Returns { subject, body } or throws a 400. */
function clean(input) {
  const i = input || {};
  const subject = s(i.subject).slice(0, SUBJECT_MAX);
  const body = s(i.body).slice(0, BODY_MAX);
  if (!subject) throw Object.assign(new Error('Write a subject.'), { status: 400 });
  if (!body) throw Object.assign(new Error('Write a message.'), { status: 400 });
  return { subject, body };
}

/** The email, exactly as it will arrive. Escaping happens in mailer.ownerMessage. */
function render(p) {
  return deps.mailer().ownerMessage({ email: p.email, name: p.name, subject: p.subject, body: p.body });
}

async function send(input, query) {
  const q = query || ((sql, p) => db.query(sql, p));
  const { subject, body } = clean(input);
  const force = !!(input && input.force);
  const w = await who(input && input.phone, q);
  if (!w.ok) return w;
  if (!w.found) return { ok: false, message: 'No customer with that number.' };
  if (!w.reach.length) return { ok: false, message: 'No way to reach them — this customer has no email on file and no notifications switched on.' };
  if (w.lastMessagedAt && !force) {
    const mins = Math.round((deps.now().getTime() - new Date(s(w.lastMessagedAt).replace(' ', 'T')).getTime()) / 60000);
    if (mins >= 0 && mins < QUIET_MIN) {
      return { ok: false, tooSoon: true, minutes: mins, message: 'You messaged them ' + mins + ' minute(s) ago. Send again?' };
    }
  }

  const out = { ok: true, phone: w.phone, name: w.name, email: '', emailSent: false, pushSent: 0, devices: w.devices, skipped: [] };
  // ── email ──
  if (w.email) {
    try {
      const r = await render({ email: w.email, name: w.name, subject, body });
      out.emailSent = !!(r && r.ok);
      out.email = w.email;
      if (!out.emailSent) out.skipped.push('email: ' + ((r && (r.skipped || r.message)) || 'not sent'));
    } catch (e) { out.skipped.push('email: ' + e.message); }
  } else out.skipped.push('email: none on file');

  // ── push, only if they have a device. The first line of the message is the notification. ──
  if (w.devices > 0 && input.alsoPush !== false) {
    try {
      const first = body.split('\n').map((x) => x.trim()).filter(Boolean)[0] || body;
      const r = await deps.push().sendToPhone(w.phone, {
        title: subject.slice(0, 80),
        body: first.slice(0, PUSH_BODY_MAX),
        url: '/',
      }, { kind: 'direct' });
      out.pushSent = Number(r && r.sent) || 0;
      if (!out.pushSent) out.skipped.push('push: nothing delivered');
    } catch (e) { out.skipped.push('push: ' + e.message); }
  }

  if (!out.emailSent && !out.pushSent) return { ok: false, message: 'Nothing was sent. ' + out.skipped.join(' · ') };

  // Written down the same way every other sender here writes it down.
  try {
    await q('INSERT INTO reminder_log (ts, sub_id, channel, kind, ok, note) VALUES (?, ?, ?, ?, ?, ?)',
      [fmt(deps.now()), w.phone, 'MESSAGE', 'OWNER', 1,
        (out.emailSent ? 'email' : '') + (out.emailSent && out.pushSent ? ' + ' : '') + (out.pushSent ? 'push' : '') + ' · ' + subject.slice(0, 60)]);
  } catch (e) { console.log('[custmessage] could not log the send:', e.message); }

  out.message = '✅ Sent' + (out.emailSent ? ' by email to ' + w.email : '') + (out.pushSent ? (out.emailSent ? ' and ' : ' ') + out.pushSent + ' notification' : '') + '.';
  return out;
}

function mount(app, depsIn) {
  const { auth } = depsIn;
  const audit = (depsIn && depsIn.audit) || { record: () => {} };
  const query = (depsIn && depsIn.db && depsIn.db.query) ? (sql, p) => depsIn.db.query(sql, p) : (sql, p) => db.query(sql, p);
  const fail = (res, e) => res.status((e && e.status) || 500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/message/who', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await who(req.query.phone, query)); } catch (e) { fail(res, e); }
  });

  // Exactly what will arrive, without sending it.
  app.post('/admin/api/message/preview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { subject, body } = clean(req.body || {});
      const w = await who((req.body || {}).phone, query);
      if (!w.ok) return res.status(400).json(w);
      res.json({
        ok: true, to: w.email, name: w.name, devices: w.devices, reach: w.reach, subject,
        html: deps.mailer().ownerMessageHtml({ name: w.name, body }),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/message/send', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await send(req.body || {}, query);
      if (!r.ok) return res.status(r.tooSoon ? 409 : 400).json(r);
      audit.record(req, {
        action: 'customer.message', entity: 'customer', id: r.phone,
        summary: 'Messaged ' + (r.name || r.phone) + ' — "' + s((req.body || {}).subject).slice(0, 60) + '"'
          + (r.emailSent ? ' · email' : '') + (r.pushSent ? ' · push' : ''),
        details: { subject: s((req.body || {}).subject), body: s((req.body || {}).body).slice(0, 500) },
      });
      res.json(r);
    } catch (e) { fail(res, e); }
  });
}

// deps is exported so a test can hand this module a FIXED clock and fake senders. A fake must never
// read the real clock while the code under test reads another one — that is how reminder-jobs.test.js
// once passed or failed depending on the hour of the day.
module.exports = { mount, who, send, _internal: { clean, render, deps, SUBJECT_MAX, BODY_MAX, QUIET_MIN } };
