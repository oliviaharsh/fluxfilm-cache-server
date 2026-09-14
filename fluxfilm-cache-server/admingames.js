/**
 * FluxFilm - admin 🎮 Games screen (admin-only). Everything about the games is controlled here.
 *
 *   GET  /admin/api/games/settings           → { settings, defaults, fields, needsSchema }
 *   POST /admin/api/games/settings           { ...settings }  (validated, saved to app_settings, change log)
 *   GET  /admin/api/games/overview           → today / month numbers, per game, top players, recent + flagged plays
 *   GET  /admin/api/games/questions?kind=    → QUIZ or EMOJI questions (+ starter pack size)
 *   POST /admin/api/games/question           { id?, kind, question, options[4], answer, category, active }
 *   POST /admin/api/games/question/delete    { id }
 *   POST /admin/api/games/questions/starter  { kind }  → adds the starter pack (skips ones already there)
 */
const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const clean = (v, max) => s(v).replace(/[<>]/g, '').slice(0, max);

function mount(app, deps) {
  const { db, auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const games = deps.games || require('./games');
  const questions = deps.questions || require('./gamequestions');
  const needsSchema = (res) => res.status(409).json({ ok: false, needsSchema: true, message: 'Run db/schema-v21.sql in phpMyAdmin first.' });

  // Flatten { a, games: { spin: { b } } } → { a, 'spin.b' } to list what changed in the change log.
  const flat = (o) => {
    const out = {};
    Object.keys(o).forEach((k) => { if (k !== 'games' && k !== 'settingsReady') out[k] = o[k]; });
    Object.keys(o.games || {}).forEach((g) => Object.keys(o.games[g]).forEach((k) => { out[g + '.' + k] = k === 'slices' ? JSON.stringify(o.games[g][k]) : o.games[g][k]; }));
    return out;
  };

  app.get('/admin/api/games/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const cfg = await games.getSettings(true);
      let ready = true; try { ready = await games.schemaReady(); } catch (_) { ready = false; }
      const settings = JSON.parse(JSON.stringify(cfg)); delete settings.settingsReady;
      res.json({ ok: true, settings, defaults: games.defaults(), needsSchema: !ready,
        fields: { global: games.GLOBAL_FIELDS, common: games.COMMON_FIELDS, games: games.GAME_FIELDS, meta: games.GAMES } });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/games/settings', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const before = flat(await games.getSettings(true));
      const r = await games.saveSettings(req.body || {});
      if (!r.ok) return r.needsSchema ? res.status(409).json(r) : res.status(400).json(r);
      const after = flat(r.settings);
      const changed = Object.keys(after).filter((k) => String(before[k]) !== String(after[k]));
      audit.record(req, { action: 'games.settings', entity: 'settings', id: 'games', summary: changed.length ? 'Changed: ' + changed.map((k) => k + ' ' + before[k] + ' → ' + after[k]).join(', ').slice(0, 900) : 'Saved (no changes)', details: { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) } });
      res.json({ ok: true, settings: r.settings, changed });
    } catch (e) { res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.get('/admin/api/games/overview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const today = games.istDate(); const month = today.slice(0, 8) + '01';
      const [day, mon, perGame, spent, top, recent, flagged] = await Promise.all([
        db.query("SELECT COUNT(DISTINCT phone_norm) players, COUNT(*) plays, COALESCE(SUM(coins_won), 0) coins, COALESCE(SUM(coupon_code IS NOT NULL), 0) coupons FROM game_plays WHERE play_date = ? AND game <> 'streak'", [today]),
        db.query("SELECT COUNT(DISTINCT phone_norm) players, COUNT(*) plays, COALESCE(SUM(coins_won), 0) coins, COALESCE(SUM(coupon_code IS NOT NULL), 0) coupons, COALESCE(SUM(coupon_value), 0) couponRupees, COALESCE(SUM(cost), 0) spent FROM game_plays WHERE play_date >= ?", [month]),
        db.query("SELECT game, COUNT(*) plays, SUM(kind = 'FREE') free, SUM(kind = 'PAID') paid, SUM(kind = 'PRACTICE') practice, COALESCE(SUM(coins_won), 0) coins, COALESCE(SUM(cost), 0) spent, COALESCE(SUM(coupon_code IS NOT NULL), 0) coupons FROM game_plays WHERE play_date >= ? GROUP BY game", [month]),
        db.query("SELECT COALESCE(SUM(-coins_delta), 0) coins FROM coins_ledger WHERE event = 'GAME_PLAY' AND ts >= ?", [month + ' 00:00:00']),
        db.query("SELECT gp.phone_norm phone, c.name, COUNT(*) plays, COALESCE(SUM(gp.coins_won), 0) coins, COALESCE(SUM(gp.cost), 0) spent FROM game_plays gp LEFT JOIN customers c ON c.phone_norm = gp.phone_norm WHERE gp.play_date >= ? AND gp.kind IN ('FREE', 'PAID') GROUP BY gp.phone_norm, c.name ORDER BY plays DESC LIMIT 10", [month]),
        db.query("SELECT id, phone_norm phone, game, kind, status, score, coins_won coins, cost, coupon_code, coupon_value, flagged, started_at FROM game_plays ORDER BY id DESC LIMIT 30", []),
        db.query("SELECT id, phone_norm phone, game, kind, score, flagged, started_at FROM game_plays WHERE flagged IS NOT NULL ORDER BY id DESC LIMIT 20", []),
      ]);
      res.json({ ok: true, today: day[0] || {}, month: Object.assign({}, mon[0] || {}, { spentLedger: num((spent[0] || {}).coins) }), perGame, top, recent, flagged });
    } catch (e) {
      if (missingTable(e)) return res.json({ ok: true, needsSchema: true, today: {}, month: {}, perGame: [], top: [], recent: [], flagged: [] });
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  app.get('/admin/api/games/questions', async (req, res) => {
    if (!auth(req, res)) return;
    const kind = s(req.query.kind).toUpperCase() === 'EMOJI' ? 'EMOJI' : 'QUIZ';
    try {
      const rows = await db.query('SELECT id, kind, question, opt_a, opt_b, opt_c, opt_d, answer, category, active, source, updated_at FROM quiz_questions WHERE kind = ? ORDER BY id DESC', [kind]);
      res.json({ ok: true, kind, starterCount: questions.starterRows(kind).length, questions: rows.map((r) => ({ id: r.id, kind: r.kind, question: r.question, options: [r.opt_a, r.opt_b, r.opt_c, r.opt_d], answer: Number(r.answer), category: r.category || '', active: Number(r.active) === 1, source: r.source || '' })) });
    } catch (e) {
      if (missingTable(e)) return res.json({ ok: true, needsSchema: true, kind, starterCount: questions.starterRows(kind).length, questions: [] });
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  app.post('/admin/api/games/question', async (req, res) => {
    if (!auth(req, res)) return;
    const p = req.body || {};
    const kind = s(p.kind).toUpperCase() === 'EMOJI' ? 'EMOJI' : 'QUIZ';
    const question = clean(p.question, 255);
    const opts = (Array.isArray(p.options) ? p.options : []).map((x) => clean(x, 120));
    const answer = Math.round(num(p.answer));
    if (!question) return res.status(400).json({ ok: false, message: kind === 'EMOJI' ? 'Type the emoji clue.' : 'Type the question.' });
    if (opts.length !== 4 || opts.some((x) => !x)) return res.status(400).json({ ok: false, message: 'Fill in all 4 answers.' });
    if (new Set(opts.map((x) => x.toLowerCase())).size !== 4) return res.status(400).json({ ok: false, message: 'The 4 answers must be different.' });
    if (!(answer >= 0 && answer <= 3)) return res.status(400).json({ ok: false, message: 'Pick which answer is right.' });
    const active = p.active === false || p.active === 0 || s(p.active).toLowerCase() === 'false' ? 0 : 1;
    const category = clean(p.category, 40);
    try {
      const id = Math.round(num(p.id));
      if (id > 0) {
        await db.query('UPDATE quiz_questions SET question = ?, opt_a = ?, opt_b = ?, opt_c = ?, opt_d = ?, answer = ?, category = ?, active = ?, updated_at = NOW() WHERE id = ? AND kind = ?', [question, opts[0], opts[1], opts[2], opts[3], answer, category, active, id, kind]);
        audit.record(req, { action: 'games.question.save', entity: 'quiz_question', id: String(id), summary: kind + ' · ' + question.slice(0, 80) + (active ? '' : ' (off)') });
        return res.json({ ok: true, id });
      }
      const r = await db.query('INSERT INTO quiz_questions (kind, question, opt_a, opt_b, opt_c, opt_d, answer, category, active, source) VALUES (?,?,?,?,?,?,?,?,?,?)', [kind, question, opts[0], opts[1], opts[2], opts[3], answer, category, active, 'Admin']);
      audit.record(req, { action: 'games.question.add', entity: 'quiz_question', id: String(r.insertId), summary: kind + ' · ' + question.slice(0, 80) });
      res.json({ ok: true, id: r.insertId });
    } catch (e) {
      if (missingTable(e)) return needsSchema(res);
      if (/Duplicate|ER_DUP_ENTRY/i.test(e.message)) return res.status(400).json({ ok: false, message: 'This question is already in the list.' });
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  app.post('/admin/api/games/question/delete', async (req, res) => {
    if (!auth(req, res)) return;
    const id = Math.round(num((req.body || {}).id));
    if (!(id > 0)) return res.status(400).json({ ok: false, message: 'Which question?' });
    try {
      const rows = await db.query('SELECT kind, question FROM quiz_questions WHERE id = ? LIMIT 1', [id]);
      if (!rows.length) return res.status(404).json({ ok: false, message: 'Question not found.' });
      await db.query('DELETE FROM quiz_questions WHERE id = ?', [id]);
      audit.record(req, { action: 'games.question.delete', entity: 'quiz_question', id: String(id), summary: rows[0].kind + ' · ' + s(rows[0].question).slice(0, 80), details: rows[0] });
      res.json({ ok: true });
    } catch (e) { if (missingTable(e)) return needsSchema(res); res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });

  app.post('/admin/api/games/questions/starter', async (req, res) => {
    if (!auth(req, res)) return;
    const kind = s((req.body || {}).kind).toUpperCase() === 'EMOJI' ? 'EMOJI' : 'QUIZ';
    try {
      let added = 0;
      for (const q of questions.starterRows(kind)) {
        const r = await db.query('INSERT IGNORE INTO quiz_questions (kind, question, opt_a, opt_b, opt_c, opt_d, answer, category, active, source) VALUES (?,?,?,?,?,?,?,?,1,?)', [kind, q.question, q.options[0], q.options[1], q.options[2], q.options[3], q.answer, q.category, q.source]);
        if (r && r.affectedRows) added++;
      }
      audit.record(req, { action: 'games.question.starter', entity: 'quiz_question', id: kind, summary: 'Added ' + added + ' starter ' + kind.toLowerCase() + ' questions' });
      res.json({ ok: true, added });
    } catch (e) { if (missingTable(e)) return needsSchema(res); res.status(500).json({ ok: false, message: String(e.message || e) }); }
  });
}

module.exports = { mount };
