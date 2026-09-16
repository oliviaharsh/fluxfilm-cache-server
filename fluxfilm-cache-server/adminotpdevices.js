/**
 * FluxFilm - admin "📱 OTP devices" (admin-only, mounted by admin.js). See otpdevices.js.
 *
 *   GET  /admin/api/otp-devices?service=&q=&removed=1   login accounts of OTP services with their customers
 *   POST /admin/api/otp-devices/device                  { subId, device?, deviceName?, deviceType? }  (raw_json + device_type, change log)
 *   POST /admin/api/otp-devices/import/preview          { source: 'sheet', tab } | { source: 'paste', text }  → preview, writes NOTHING
 *   POST /admin/api/otp-devices/import/save             { items: [{ subId, device?, setDevices?, deviceName, deviceType }], overwrite }  (one change-log entry)
 *   GET  /admin/api/otp-diagnostics?service=            🔎 Get OTP check: time window + why the last run showed nothing
 *   POST /admin/api/otp-settings                        { windowMin 5-30 }  how long a forwarded mail stays usable
 *   POST /admin/api/otp-selftest                        { service?, subject?, text }  what the parser makes of a pasted mail
 *
 * 🚪 Remove uses the existing POST /admin/api/sub-removed (same write + change log as "Removed from account").
 * The old Sheet is only ever READ (sheetReader has no write method).
 */
const s = (v) => String(v == null ? '' : v).trim();

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const O = () => deps.otpdevices || require('./otpdevices');
  const reader = () => deps.sheetReader || O().sheetReader(process.env);
  const q = (sql, p) => db.query(sql, p);
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  const truthy = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(s(v));
  const policyOf = async () => {
    const out = {};
    const plans = await q('SELECT service, raw_json FROM plans', []).catch(() => []);
    for (const p of Array.isArray(plans) ? plans : []) { const k = s(p.service).toLowerCase(); const pol = s(O().rawOf(p.raw_json).AllocationPolicy).toUpperCase(); if (k && pol && !out[k]) out[k] = pol; }
    return out;
  };

  app.get('/admin/api/otp-devices', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await O().load(q, { service: s(req.query.service).slice(0, 40), q: s(req.query.q).slice(0, 80), showRemoved: truthy(req.query.removed) });
      res.json(Object.assign({ ok: true }, r));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/otp-devices/device', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const r = await O().saveDevice(q, { subId: b.subId, device: b.device, deviceName: b.deviceName, deviceType: b.deviceType }, { policyOf: await policyOf() });
      if (!r.ok) return res.status(r.status || 400).json({ ok: false, message: r.message });
      if (!r.unchanged) {
        const parts = [];
        if (r.devices > 1) parts.push('device ' + r.device + ' of ' + r.devices + ':');
        if (r.changed.includes('deviceName')) parts.push('device name ' + (r.before.deviceName ? '"' + r.before.deviceName + '"' : '(none)') + ' → ' + (r.after.deviceName ? '"' + r.after.deviceName + '"' : '(none)'));
        if (r.changed.includes('deviceType')) parts.push('type ' + (r.before.deviceType || '(none)') + ' → ' + (r.after.deviceType || '(none)'));
        audit.record(req, { action: 'sub.device', entity: 'subscription', id: s(b.subId), summary: '📱 ' + (parts.join(', ').replace(':,', ':') || 'device type kept in step'), details: { before: r.before, after: r.after } });
      }
      res.json({ ok: true, subId: s(b.subId), device: r.device || 1, devices: r.devices || 1, deviceName: r.after.deviceName, deviceType: r.after.deviceType, updatedAt: r.updatedAt || '', unchanged: !!r.unchanged });
    } catch (e) { fail(res, e); }
  });

  // Preview only: reads the Sheet (or the pasted text) and the database, matches, returns the lists. Writes nothing.
  app.post('/admin/api/otp-devices/import/preview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      let rows2d, tab = '';
      if (s(b.source) === 'paste') {
        const text = String(b.text == null ? '' : b.text);
        if (!text.trim()) return res.status(400).json({ ok: false, message: 'Paste the rows copied from the Sheet first.' });
        if (text.length > 300000) return res.status(400).json({ ok: false, message: 'Too much text (max 300 KB). Paste one account block at a time.' });
        rows2d = O().parsePaste(text);
      } else {
        const got = await reader().readTab(b.tab);
        if (!got || !got.ok) return res.json({ ok: false, sheetError: true, message: (got && got.message) || 'Could not read the Sheet.', help: (got && got.help) || '' });
        rows2d = got.rows2d; tab = got.tab || s(b.tab);
      }
      const parsed = O().parseRows(rows2d, { service: s(b.service) });
      const data = await O().loadForImport(q);
      const m = O().matchRows(parsed.rows, data);
      res.json({
        ok: true, source: s(b.source) === 'paste' ? 'paste' : 'sheet', tab, rowsRead: parsed.rows.length, skipped: parsed.skipped,
        counts: { matched: m.matched.length, alreadyNamed: m.alreadyNamed.length, same: m.same.length, ambiguous: m.ambiguous.length, unmatched: m.unmatched.length },
        matched: m.matched, alreadyNamed: m.alreadyNamed, same: m.same, ambiguous: m.ambiguous, unmatched: m.unmatched,
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/otp-devices/import/save', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return res.status(400).json({ ok: false, message: 'Nothing to save.' });
      if (items.length > 500) return res.status(400).json({ ok: false, message: 'At most 500 rows at a time.' });
      const overwrite = b.overwrite === true;
      const r = await O().saveImport(q, items, { overwrite, policyOf: await policyOf() });
      if (r.saved) {
        audit.record(req, { action: 'sub.deviceImport', entity: 'import', id: 'otp-devices', summary: '📥 Copied device names from the old Sheet: ' + r.names + ' name(s), ' + r.types + ' type(s) on ' + r.saved + ' subscription(s)' + (r.devices ? ' · ' + r.devices + ' plan(s) set to more devices' : '') + (r.unchanged ? ' · ' + r.unchanged + ' already the same' : '') + (r.errors.length ? ' · ' + r.errors.length + ' failed' : '') + (overwrite ? ' · overwrite on' : ''), details: { overwrite, saved: r.saved, names: r.names, types: r.types, devices: r.devices, unchanged: r.unchanged, skipped: r.skipped, errors: r.errors.slice(0, 50) } });
      }
      res.json(Object.assign({ ok: true, message: r.saved ? '📥 Saved ' + r.saved + ' device name' + (r.saved === 1 ? '' : 's') + '.' + (r.unchanged ? ' ' + r.unchanged + ' already the same.' : '') : 'Nothing new to save' + (r.unchanged ? ' (' + r.unchanged + ' already the same).' : '.') }, r));
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- 🔎 Get OTP check (otp.js)
  // Why a code was not shown (counts + masked numbers only), how long a mail stays usable, and a paste-a-mail self-test.
  const OTP = () => deps.otp || require('./otp');

  app.get('/admin/api/otp-diagnostics', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await OTP().adminDiagnostics(s(req.query.service).slice(0, 40))); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/otp-settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await OTP().saveSettings({ windowMin: (req.body || {}).windowMin });
      if (!r.ok) return res.status(r.status || 400).json(r);
      audit.record(req, { action: 'otp.settings', entity: 'settings', id: 'getotp_settings', summary: '🔎 Get OTP: a forwarded mail is used for ' + r.settings.windowMin + ' min (was ' + r.before.windowMin + ')', details: { before: r.before, after: r.settings } });
      res.json({ ok: true, settings: r.settings, message: '✅ Saved. Forwarded mails are used for ' + r.settings.windowMin + ' minutes.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/otp-selftest', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const text = String(b.text == null ? '' : b.text);
      if (!text.trim()) return res.status(400).json({ ok: false, message: 'Paste the forwarded mail first.' });
      if (text.length > 20000) return res.status(400).json({ ok: false, message: 'Too long (max 20 KB) — paste one mail.' });
      res.json(await OTP().adminSelfTest({ service: s(b.service).slice(0, 40), subject: String(b.subject == null ? '' : b.subject).slice(0, 300), text }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
