/**
 * FluxFilm - admin 📈 Reports + 🔔 owner alert settings (admin-only, mounted by admin.js). Every change → change log.
 *
 *   GET  /admin/api/reports?kind=day|week|month&date=YYYY-MM-DD      one period (week = Monday–Sunday)
 *   GET  /admin/api/reports?kind=custom&from=YYYY-MM-DD&to=YYYY-MM-DD both days included, at most 400 days
 *   GET  /admin/api/reports/history                                  past sent summaries (snapshots, newest first)
 *   GET  /admin/api/reports/snapshot?id=day:2026-09-16               one snapshot
 *   POST /admin/api/reports/send-now      { kind: day|week|month }   📨 send the current period's summary now (test)
 *   GET  /admin/api/owner-alerts                                     settings + where email goes + next send times
 *   POST /admin/api/owner-alerts/settings { orderPush, creditPush, orderEmail, dailyOn, dailyTime, …, emails }
 *   POST /admin/api/owner-alerts/test-order                          🔔 test new-order push (creates nothing)
 */
function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const reports = deps.reports || require('./reports');
  const notify = deps.ownernotify || require('./ownernotify');
  const now = () => (deps.now ? deps.now() : Date.now());
  const s = (v) => String(v == null ? '' : v).trim();
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const SEND_GAP_MS = deps.sendGapMs != null ? deps.sendGapMs : 60e3;
  let lastSend = 0; let lastTest = 0;

  function rangeOf(qs) {
    const kind = ['day', 'week', 'month', 'custom'].includes(s(qs.kind)) ? s(qs.kind) : 'day';
    const today = reports._internal.istYmd(now());
    if (kind === 'custom') return reports.rangeFor('custom', s(qs.from), s(qs.to));
    return reports.rangeFor(kind, s(qs.date) || today);
  }

  app.get('/admin/api/reports', async (req, res) => {
    if (!auth(req, res)) return;
    const range = rangeOf(req.query || {});
    if (!range) return res.status(400).json({ ok: false, message: s((req.query || {}).kind) === 'custom' ? 'Pick a from and to date (to on or after from, at most ' + reports.MAX_CUSTOM_DAYS + ' days).' : 'Pick a valid date.' });
    try {
      const sum = await reports.computeSummary(db, range, { now: now(), deps: deps.summaryDeps });
      res.json(Object.assign(sum, { sections: reports.sections(sum), line: reports.pushLine(sum), today: reports._internal.istYmd(now()) }));
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/api/reports/history', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json({ ok: true, list: await reports.listSnapshots(db) }); }
    catch (e) { if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e.message))) return res.json({ ok: true, list: [] }); fail(res, e); }
  });

  app.get('/admin/api/reports/snapshot', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const snap = await reports.getSnapshot(db, s((req.query || {}).id));
      if (!snap) return res.status(404).json({ ok: false, message: 'Summary not found (older ones are removed after ' + reports.MAX_SNAPSHOTS + ').' });
      res.json({ ok: true, snapshot: snap });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/reports/send-now', async (req, res) => {
    if (!auth(req, res)) return;
    const kind = ['day', 'week', 'month'].includes(s((req.body || {}).kind)) ? s(req.body.kind) : 'day';
    const wait = lastSend + SEND_GAP_MS - Date.now();
    if (wait > 0) return res.status(429).json({ ok: false, message: 'A summary was just sent — please wait ' + Math.ceil(wait / 1000) + ' seconds.' });
    lastSend = Date.now();
    try {
      const t = now();
      const range = reports.rangeFor(kind, reports._internal.istYmd(t));
      const r = await reports.sendSummary(range, { key: reports.manualKey(range, t), manual: true, now: t, deps: Object.assign({ db, summaryDeps: deps.summaryDeps }, deps.sendDeps || {}) });
      const d = r.delivery;
      const parts = [d.push ? '📱 push ' + d.push.sent + ' of ' + d.push.devices + ' device(s)' : '📱 push off', d.email ? (d.email.ok ? '✉️ email sent' : '✉️ email not sent (' + s(d.email.skipped || d.email.error) + ')') : '✉️ email off'];
      audit.record(req, { action: 'reports.sendNow', entity: 'report', id: r.id, summary: 'Sent ' + kind + ' summary now: ' + r.line + ' · ' + parts.join(' · ') });
      res.json({ ok: true, id: r.id, line: r.line, delivery: d, message: r.line + ' — ' + parts.join(' · ') });
    } catch (e) { lastSend = 0; fail(res, e); }
  });

  app.get('/admin/api/owner-alerts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const settings = await notify.getSettings(true);
      let adminDevices = null;
      try { const st = await (deps.push || require('./push')).stats(); adminDevices = st && st.ok ? st.adminDevices : null; } catch (_) {}
      res.json({ ok: true, settings, defaultEmails: notify.recipients(Object.assign({}, settings, { emails: [] })), recipients: notify.recipients(settings), next: reports.nextTimes(now(), settings), adminDevices });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/owner-alerts/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await notify.saveSettings(req.body || {});
      if (!r.ok) return res.status(400).json(r);
      if (r.changed.length) audit.record(req, { action: 'ownerAlerts.settings', entity: 'settings', id: notify.KEY, summary: 'Owner alerts / summaries changed: ' + r.changed.join(', ') + ' (new-order push ' + (r.settings.orderPush ? 'ON' : 'OFF') + ', daily ' + (r.settings.dailyOn ? r.settings.dailyTime : 'OFF') + ')' });
      res.json(Object.assign(r, { recipients: notify.recipients(r.settings), next: reports.nextTimes(now(), r.settings) }));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/owner-alerts/test-order', async (req, res) => {
    if (!auth(req, res)) return;
    if (Date.now() - lastTest < 5e3) return res.status(429).json({ ok: false, message: 'Just sent — wait a few seconds.' });
    lastTest = Date.now();
    try {
      const r = await notify.testOrderAlert();
      if (r.push && r.push.needSchema) return res.status(400).json({ ok: false, message: r.push.message });
      const p = r.push || {};
      audit.record(req, { action: 'ownerAlerts.test', entity: 'push', summary: 'Test new-order alert: ' + (p.sent || 0) + ' of ' + (p.devices || 0) + ' admin device(s)' });
      res.json({ ok: true, title: r.message.title, body: r.message.body, sent: p.sent || 0, devices: p.devices || 0, message: p.devices ? '🧪 Test sent to ' + p.sent + ' of ' + p.devices + ' admin device(s)' : 'No admin device yet — tap "Turn on for this device" first. (The sound below still plays here.)' });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
