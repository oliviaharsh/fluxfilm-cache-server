/* 🎮 Games: settings, server-side scoring, free / paid / practice plays, caps, coupons, admin API, pages parse. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
process.env.OTP_ACCESS_SECRET = 'test-secret';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

// ---------------- in-memory MySQL stand-in (only the SQL games / coins / admin use) ----------------
const DB = { settings: {}, paid: new Set(['9876543210']), wallet: {}, ledger: [], plays: [], coupons: [], questions: [], audit: [], schema: true };
let nextId = 1;
const dupErr = () => { const e = new Error("Duplicate entry for key 'uq_game_free'"); e.code = 'ER_DUP_ENTRY'; return e; };
const noTable = () => new Error("Table 'u.game_plays' doesn't exist");
function run(sqlIn, p) {
  const sql = sqlIn.replace(/\s+/g, ' ').trim(); p = p || [];
  if (!DB.schema && /game_plays|quiz_questions/.test(sql)) throw noTable();
  if (/^SELECT value FROM app_settings/.test(sql)) return DB.settings[p[0]] ? [{ value: DB.settings[p[0]] }] : [];
  if (/^INSERT INTO app_settings/.test(sql)) { DB.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
  if (/^INSERT INTO audit_log/.test(sql)) { DB.audit.push(p); return { affectedRows: 1 }; }
  if (/^SELECT 1 FROM game_plays LIMIT 1/.test(sql)) return [];
  if (/^SELECT 1 FROM orders WHERE phone_norm = \? AND UPPER\(status\) = 'PAID'/.test(sql)) return DB.paid.has(p[0]) ? [{ 1: 1 }] : [];
  if (/FROM quiz_questions WHERE kind = \? AND active = 1/.test(sql)) return DB.questions.filter((q) => q.kind === p[0] && q.active);
  if (/^SELECT email FROM (customers|subscriptions)/.test(sql)) return [];
  if (/^SELECT game, kind, COUNT\(\*\) n FROM game_plays WHERE phone_norm = \? AND play_date = \?/.test(sql)) {
    const m = {}; DB.plays.filter((x) => x.phone_norm === p[0] && x.play_date === p[1]).forEach((x) => { const k = x.game + '|' + x.kind; m[k] = (m[k] || 0) + 1; });
    return Object.keys(m).map((k) => ({ game: k.split('|')[0], kind: k.split('|')[1], n: m[k] }));
  }
  if (/SUM\(CASE WHEN play_date = \? THEN coins_won ELSE 0 END\)/.test(sql)) {
    const rows = DB.plays.filter((x) => x.phone_norm === p[1] && x.play_date >= p[2]);
    return [{ day: rows.filter((x) => x.play_date === p[0]).reduce((a, x) => a + x.coins_won, 0), month: rows.reduce((a, x) => a + x.coins_won, 0), coupons: rows.filter((x) => x.coupon_code).length }];
  }
  if (/^SELECT DISTINCT DATE_FORMAT\(play_date/.test(sql)) return [...new Set(DB.plays.filter((x) => x.phone_norm === p[0] && (x.kind === 'FREE' || x.kind === 'PAID') && x.play_date >= p[1]).map((x) => x.play_date))].map((d) => ({ d }));
  if (/^SELECT coins_balance FROM wallet WHERE phone_norm = \?/.test(sql)) return DB.wallet[p[0]] != null ? [{ coins_balance: DB.wallet[p[0]] }] : [];
  if (/^SELECT gp.coupon_code code/.test(sql)) return DB.plays.filter((x) => x.phone_norm === p[0] && x.coupon_code).map((x) => ({ code: x.coupon_code, value: x.coupon_value, game: x.game, expiry: '2099-01-01', used: 0 }));
  if (/^INSERT INTO game_plays \(phone_norm, game, play_date, kind, free_slot, cost, status, seed_json, ip, started_ms\)/.test(sql)) {
    const row = { id: nextId++, phone_norm: p[0], game: p[1], play_date: p[2], kind: p[3], free_slot: p[4], cost: p[5], status: 'STARTED', seed_json: p[6], ip: p[7], started_ms: p[8], coins_won: 0, coupon_code: null, coupon_value: 0, score: 0 };
    if (row.free_slot != null && DB.plays.some((x) => x.phone_norm === row.phone_norm && x.game === row.game && x.play_date === row.play_date && x.free_slot === row.free_slot)) throw dupErr();
    DB.plays.push(row); return { insertId: row.id, affectedRows: 1 };
  }
  if (/^INSERT INTO game_plays \(phone_norm, game, play_date, kind, free_slot, status, score, started_ms, finished_at\) VALUES \(\?, 'streak'/.test(sql)) {
    if (DB.plays.some((x) => x.phone_norm === p[0] && x.game === 'streak' && x.play_date === p[1])) throw dupErr();
    const row = { id: nextId++, phone_norm: p[0], game: 'streak', play_date: p[1], kind: 'BONUS', free_slot: 1, status: 'DONE', score: p[2], started_ms: p[3], coins_won: 0, coupon_code: null, coupon_value: 0 };
    DB.plays.push(row); return { insertId: row.id, affectedRows: 1 };
  }
  if (/^SELECT 1 FROM game_plays WHERE phone_norm = \? AND game = 'streak' AND play_date > \?/.test(sql)) return DB.plays.filter((x) => x.phone_norm === p[0] && x.game === 'streak' && x.play_date > p[1]);
  if (/^SELECT id, phone_norm, game, DATE_FORMAT\(play_date/.test(sql)) return DB.plays.filter((x) => String(x.id) === String(p[0]) && x.phone_norm === p[1]).map((x) => Object.assign({}, x));
  const byId = (id) => DB.plays.find((x) => String(x.id) === String(id));
  if (/^UPDATE game_plays SET seed_json = \? WHERE id = \? AND status = 'STARTED' AND seed_json = \?/.test(sql)) { const r = byId(p[1]); if (r && r.status === 'STARTED' && r.seed_json === p[2]) { r.seed_json = p[0]; return { affectedRows: 1 }; } return { affectedRows: 0 }; }
  if (/^UPDATE game_plays SET status = 'DONE'/.test(sql)) { const r = byId(p[3]); if (r && r.status === 'STARTED') { Object.assign(r, { status: 'DONE', score: p[0], result_json: p[1], flagged: p[2] }); return { affectedRows: 1 }; } return { affectedRows: 0 }; }
  if (/^UPDATE game_plays SET status = 'EXPIRED'/.test(sql)) { const r = byId(p[0]); if (r && r.status === 'STARTED') { r.status = 'EXPIRED'; return { affectedRows: 1 }; } return { affectedRows: 0 }; }
  if (/^UPDATE game_plays SET coins_won = \? WHERE id = \?/.test(sql)) { byId(p[1]).coins_won = p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE game_plays SET coupon_code = \?, coupon_value = \? WHERE id = \?/.test(sql)) { Object.assign(byId(p[2]), { coupon_code: p[0], coupon_value: p[1] }); return { affectedRows: 1 }; }
  if (/^INSERT INTO coupons/.test(sql)) { DB.coupons.push({ code: p[0], value: p[4], expiry: p[7], allowed: p[12], raw: JSON.parse(p[14]) }); return { affectedRows: 1 }; }
  if (/^SELECT phone, coins_balance FROM wallet WHERE phone_norm = \?/.test(sql)) return DB.wallet[p[0]] != null ? [{ phone: p[0], coins_balance: DB.wallet[p[0]] }] : [];
  if (/^INSERT IGNORE INTO wallet/.test(sql)) { if (DB.wallet[p[1]] == null) DB.wallet[p[1]] = 0; return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance \+ \?/.test(sql)) { DB.wallet[p[p.length - 1]] += p[0]; return { affectedRows: 1 }; }
  if (/^UPDATE wallet SET coins_balance = coins_balance - \?/.test(sql)) { DB.wallet[p[p.length - 1]] -= p[0]; return { affectedRows: 1 }; }
  if (/^INSERT INTO coins_ledger/.test(sql)) { DB.ledger.push({ event: p[0], orderId: p[1], phone: p[2], delta: p[6], after: p[7] }); return { affectedRows: 1 }; }
  if (/^SELECT 1 FROM app_settings LIMIT 1/.test(sql)) return [];
  if (/^INSERT IGNORE INTO quiz_questions/.test(sql)) { if (DB.questions.some((q) => q.kind === p[0] && q.question === p[1])) return { affectedRows: 0 }; DB.questions.push({ id: nextId++, kind: p[0], question: p[1], opt_a: p[2], opt_b: p[3], opt_c: p[4], opt_d: p[5], answer: p[6], category: p[7], active: 1, source: p[8] }); return { affectedRows: 1 }; }
  if (/^SELECT id, kind, question, opt_a/.test(sql)) return DB.questions.filter((q) => q.kind === p[0]);
  if (/FROM game_plays|FROM coins_ledger/.test(sql)) return [];
  throw new Error('unmocked SQL: ' + sql);
}
const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query: async (sql, p) => [run(sql, p)] };
const mockDb = { ENABLED: true, query: async (sql, p) => run(sql, p), getPool: () => ({ getConnection: async () => conn }), ping: async () => ({ ok: true }) };
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

(async () => {
  const games = require('../games');
  const otpaccess = require('../otpaccess');
  const PH = '9876543210';
  const TOKEN = otpaccess.makeToken(PH).token;
  const save = async (patch) => { const s = games.defaults(); patch(s); const r = await games.saveSettings(s); games._internal.resetCache(); return r; };

  // ---- settings ----
  let v = games.validateSettings({});
  ok('defaults are valid: paid plays OFF, prizes need order + email code, 7 games', v.ok && v.settings.paidPlaysEnabled === false && v.settings.requirePaidOrder && v.settings.requireVerify && Object.keys(v.settings.games).length === 7);
  v = games.validateSettings({ monthlyCoinCap: -5, games: { cricket: { windowSix: 90, windowFour: 40 } } });
  ok('out-of-range + wrong window order are rejected with plain messages', !v.ok && v.errors.some((e) => /Max coins a customer can win per month/.test(e)) && v.errors.some((e) => /SIX ≤ FOUR/.test(e)), v.errors);
  v = games.validateSettings({ games: { spin: { slices: [{ label: 'x', coins: 5, weight: 0 }, { label: 'y', coins: 1, weight: 0 }] } } });
  ok('wheel needs a slice with a chance', !v.ok && v.errors.some((e) => /chance above 0/.test(e)));

  // ---- difficulty levels + sounds switch ----
  const allLevelsValid = Object.keys(games.PRESETS).every((g) => games.LEVELS.every((lv) => {
    const s = games.defaults(); Object.assign(s.games[g], games.PRESETS[g][lv]); const r = games.validateSettings(s);
    if (!r.ok) console.log('   level', g, lv, r.errors); return r.ok;
  }));
  ok('every difficulty level (easy / normal / hard / pro) passes validation', allLevelsValid);
  const dflt = games.defaults();
  ok('defaults = Normal level for every game; sounds on', Object.keys(games.PRESETS).every((g) => games.levelOf(g, dflt.games[g]) === 'normal') && dflt.soundsEnabled === true);
  const hardCricket = Object.assign({}, dflt.games.cricket, games.PRESETS.cricket.hard);
  ok('level detection: hard, and custom after one change', games.levelOf('cricket', hardCricket) === 'hard' && games.levelOf('cricket', Object.assign({}, hardCricket, { windowSix: 11 })) === 'custom');
  ok('Hard cricket really is harder than Easy (faster, smaller six window, bigger target)', games.PRESETS.cricket.hard.speedMax > games.PRESETS.cricket.easy.speedMax && games.PRESETS.cricket.hard.windowSix < games.PRESETS.cricket.easy.windowSix && games.PRESETS.cricket.hard.targetMin > games.PRESETS.cricket.easy.targetMax);

  // ---- pure rules ----
  const cc = games.defaults().games.cricket;
  ok('cricket timing: perfect = 6, edge = 1, early = dot, late / no tap = out',
    games.cricketBall(cc, 850).runs === 6 && games.cricketBall(cc, 850 + cc.windowFour).runs === 4 && games.cricketBall(cc, 850 - cc.windowOne).runs === 1 &&
    games.cricketBall(cc, 850 - cc.windowOne - 1).out === false && games.cricketBall(cc, 850 + cc.windowOne + 1).out === true && games.cricketBall(cc, null).out === true);
  const plan = Array.from({ length: 6 }, () => ({ speed: 900, swing: 0, slowAt: 0, slowFactor: 1 }));
  let r = games.scoreCricket({ cfg: cc, target: 12, plan }, { taps: [850, 850, 850, 850] }, 60000);
  ok('super over stops once the target is chased (2 balls × SIX = 12)', r.won && r.detail.balls === 2 && r.score === 12 && r.coins === cc.winCoins && !r.flag, r);
  r = games.scoreCricket({ cfg: cc, target: 20, plan }, { taps: [850, 850, 850, 850] }, 300);
  ok('super over finished faster than the balls travel → flagged', !!r.flag);
  r = games.scoreCricket({ cfg: Object.assign({}, cc, { couponSixes: 3 }), target: 18, plan }, { taps: [850, 850, 850] }, 60000);
  ok('3 sixes to win → coupon', r.won && r.coupon === cc.couponValue);
  const yc = games.defaults().games.yorker;
  ok('yorker: target zone = wicket, short = six, full = four, none = no ball', games.yorkerBall(yc, 880).wicket && games.yorkerBall(yc, 700).runs === 6 && games.yorkerBall(yc, 880 + yc.goodWindow / 2 + 5).runs === 4 && games.yorkerBall(yc, null).runs === 1);
  const pc = games.defaults().games.penalty;
  ok('penalty: weak = saved, too hard = miss, keeper zone = saved, next zone saved only if he reads it',
    games.penaltyKick(pc, 0, false, 2, 100).outcome === 'SAVED' && games.penaltyKick(pc, 0, false, 2, 990).outcome === 'MISS' && games.penaltyKick(pc, 2, false, 2, 700).outcome === 'SAVED' &&
    games.penaltyKick(pc, 1, true, 2, 700).outcome === 'SAVED' && games.penaltyKick(pc, 1, false, 2, 700).outcome === 'GOAL' && games.penaltyKick(pc, 3, true, 2, 700).outcome === 'GOAL');
  const popc = games.defaults().games.popcorn;
  ok('popcorn: impossible score flagged, normal score gives capped coins', !!games.scorePopcorn({ cfg: popc }, { score: 90000, durationMs: 20000 }, 20000).flag &&
    games.scorePopcorn({ cfg: popc }, { score: 400, durationMs: 50000 }, 50000).coins === 8 && !games.scorePopcorn({ cfg: popc }, { score: 400, durationMs: 50000 }, 50000).flag);

  // ---- browser rules = server rules (games.html animates with its own copy) ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'games.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   games.html parse error:', e.message); } }
  ok('games.html script parses', parsed);
  const grab = (name) => { const m = html.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}')); return m ? m[0] : ''; };
  const pageCricket = new Function('var SWEET = 850;' + grab('cricketBall') + '; return cricketBall;')();
  const pageYorker = new Function('var YTARGET = 880;' + grab('yorkerBall') + '; return yorkerBall;')();
  const same = [null, 0, 600, 739, 740, 812, 834, 850, 866, 888, 921, 960, 961, 999, 1000].every((pos) => { const a = pageCricket(cc, pos), b = games.cricketBall(cc, pos); return a.runs === b.runs && a.out === b.out; }) &&
    [null, 0, 700, 809, 810, 855, 880, 905, 950, 951, 1000].every((pos) => { const a = pageYorker(yc, pos), b = games.yorkerBall(yc, pos); return a.runs === b.runs && a.wicket === b.wicket; });
  ok('page and server score cricket + yorker taps the same', same);
  const pagePos = new Function(grab('posAt') + '; return posAt;')();
  const slowBall = { speed: 1000, slowAt: 400, slowFactor: 0.5 };
  ok('slower ball: page position ↔ server travel time agree', Math.abs(pagePos(slowBall, games.ballTimeMs(slowBall, 850)) - 850) < 0.5);

  ok('page sounds: Web Audio only (no sound files), mute button, admin switch respected',
    /var SND = \(function \(\)/.test(html) && /AudioContext/.test(html) && !/\.(mp3|wav|ogg)\b/i.test(html) && /id="sndBtn"/.test(html) && /soundsEnabled === false/.test(html) && /ff_games_sound/.test(html));
  ok('page sounds: crowd in cricket / yorker / penalty; six, four, out, wicket, goal, kick, whistle; win music on results',
    (html.match(/SND\.crowdStart\(/g) || []).length === 3 && ["'six'", "'four'", "'out'", "'wicket'", "'goal'", "'kick'", "'whistle'", "'bigwin'", "'win'", "'pop'", "'right'", "'wrong'"].every((x) => html.includes(x)) && /SND\.crowdStop\(\); if \(S\.current && S\.current\.stop\)/.test(html));
  ok('page shows the difficulty level on the start screen', /g\.level \? '<span class="lvl">'/.test(html));

  // ---- plays ----
  await save(() => {});
  let home = await games.getHome(PH, TOKEN);
  ok('home: logged in, can win, 1 free play per game, paid plays off', home.ok && home.enabled && home.eligibility.canWin && home.games.every((g) => g.freeLeft === 1 && g.extraLeft === 0), home.eligibility);
  let st = await games.start(PH, TOKEN, 'quiz', {}, { ip: '1.2.3.4' });
  ok('quiz starts as a FREE play; answers are not sent to the browser', st.ok && st.kind === 'FREE' && st.data.questions.length === 5 && !JSON.stringify(st.data).includes('"answer"'), st);
  const quizRow = DB.plays.find((x) => String(x.id) === st.playId);
  const answers = JSON.parse(quizRow.seed_json).a;
  let s1 = await games.step(PH, TOKEN, st.playId, { i: 1, choice: 0 });
  ok('answers must go in order', !s1.ok && s1.expected === 0);
  for (let i = 0; i < 5; i++) { s1 = await games.step(PH, TOKEN, st.playId, { i, choice: answers[i] }); if (!s1.right) break; }
  ok('each answer is checked on the server', s1.ok && s1.right && s1.done);
  let fin = await games.finish(PH, TOKEN, st.playId, {});
  ok('5/5 → 5×1 + 2 bonus = 7 coins in the wallet + ledger GAME_WIN', fin.ok && fin.coins === 7 && DB.wallet[PH] === 7 && DB.ledger.some((l) => l.event === 'GAME_WIN' && l.orderId === 'GP' + st.playId && l.delta === 7), fin);
  fin = await games.finish(PH, TOKEN, st.playId, {});
  ok('finishing twice never pays twice', !fin.ok && fin.already && DB.wallet[PH] === 7);
  st = await games.start(PH, TOKEN, 'quiz', {}, {});
  ok('second quiz today: free play used, extra plays are off', !st.ok && st.noFreeLeft, st);

  // paid plays
  await save((s) => { s.paidPlaysEnabled = true; s.games.quiz.extraCost = 5; s.dailyCoinCap = 10; });
  st = await games.start(PH, TOKEN, 'quiz', {}, {});
  ok('with extra plays ON the page must confirm the price first', !st.ok && st.needPay && st.cost === 5, st);
  st = await games.start(PH, '', 'quiz', { paid: true }, {});
  ok('no email-code token → practice play, no coins taken', st.ok && st.kind === 'PRACTICE' && DB.wallet[PH] === 7, st);
  await save((s) => { s.paidPlaysEnabled = true; s.games.quiz.extraCost = 5; s.dailyCoinCap = 10; s.requireVerify = false; });
  st = await games.start(PH, '', 'quiz', { paid: true }, {});
  ok('even with the email check off for prizes, spending coins needs the token', !st.ok && st.needsVerify, st);
  await save((s) => { s.paidPlaysEnabled = true; s.games.quiz.extraCost = 5; s.dailyCoinCap = 10; });
  st = await games.start(PH, TOKEN, 'quiz', { paid: true }, {});
  ok('paid play: 5 coins taken (wallet + ledger GAME_PLAY)', st.ok && st.kind === 'PAID' && st.balance === 2 && DB.wallet[PH] === 2 && DB.ledger.some((l) => l.event === 'GAME_PLAY' && l.delta === -5), st);
  const paidAnswers = JSON.parse(DB.plays.find((x) => String(x.id) === st.playId).seed_json).a;
  for (let i = 0; i < 5; i++) await games.step(PH, TOKEN, st.playId, { i, choice: paidAnswers[i] });
  fin = await games.finish(PH, TOKEN, st.playId, {});
  ok('daily cap: 7 already won today, cap 10 → only 3 more (capped: daily)', fin.ok && fin.coins === 3 && fin.capped === 'daily' && DB.wallet[PH] === 5, fin);
  DB.wallet[PH] = 3;
  st = await games.start(PH, TOKEN, 'quiz', { paid: true }, {});
  ok('not enough coins → clear message, nothing taken', !st.ok && st.notEnough && DB.wallet[PH] === 3, st);
  DB.wallet[PH] = 5;
  const st2 = await games.start(PH, TOKEN, 'emoji', { paid: true }, {});
  ok('emoji uses its own free play first even when paid is asked', st2.ok && st2.kind === 'FREE' && DB.wallet[PH] === 5, st2);

  // coupons
  await save((s) => { s.games.spin.slices = [{ label: '₹10 off', coins: 0, coupon: 10, weight: 1 }, { label: 'Try', coins: 0, coupon: 0, weight: 0 }]; });
  st = await games.start(PH, TOKEN, 'spin', {}, {});
  const cp = DB.coupons[0];
  ok('spin decides on the server and gives a coupon locked to the phone (1 use, expiry, raw_json)', st.ok && st.spin && st.spin.coupon && cp && cp.allowed === PH && cp.raw.PerUserLimit === 1 && cp.raw.GlobalLimit === 1 && cp.raw.Active === 'TRUE' && /^FG[A-Z2-9]{7}$/.test(cp.code) && /^\d{4}-\d{2}-\d{2} 23:59:59$/.test(cp.expiry), { st, cp });

  // practice + verification
  const NEW = '9000000001';
  st = await games.start(NEW, otpaccess.makeToken(NEW).token, 'cricket', {}, {});
  ok('no paid order → PRACTICE play', st.ok && st.kind === 'PRACTICE' && st.data.plan.length === 6 && typeof st.data.target === 'number');
  fin = await games.finish(NEW, otpaccess.makeToken(NEW).token, st.playId, { taps: [850, 850, 850, 850, 850, 850] });
  ok('practice: result + "would win", but no coins', fin.ok && fin.practice && fin.coins === 0 && !DB.wallet[NEW], fin);
  st = await games.start(PH, 'bad-token', 'penalty', {}, {});
  ok('customer without the email code → practice (no prize)', st.ok && st.kind === 'PRACTICE');

  // penalty steps
  const T2 = otpaccess.makeToken(PH).token;
  st = await games.start(PH, T2, 'yorker', {}, {});
  ok('yorker free play starts with a ball plan', st.ok && st.kind === 'FREE' && st.data.plan.length === yc.balls);
  const other = await games.finish('9111111111', T2, st.playId, { taps: [] });
  ok('someone else can\'t finish your game', !other.ok);

  // before schema-v22
  DB.schema = false; games._internal.resetCache();
  home = await games.getHome(PH, TOKEN);
  const stat = await games.getStatus();
  ok('before schema-v22: page says coming soon, shop tile hidden', home.ok && !home.enabled && home.comingSoon && stat.enabled === false);
  DB.schema = true; games._internal.resetCache();

  // ---- admin API ----
  const express = require('express');
  const admin = require('../admin');
  const app = express(); app.use(express.json());
  admin.mountAdmin(app, { db: mockDb, ADMIN_KEY: 'k', sync: require('../sync') });
  const server = app.listen(0); await new Promise((res) => server.once('listening', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const get = async (p, h) => { const x = await fetch(base + p, { headers: h || H }); return { status: x.status, body: await x.json() }; };
  const post = async (p, b) => { const x = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() }; };
  let a = await get('/admin/api/games/settings', { 'Content-Type': 'application/json' });
  ok('admin games settings need sign-in', a.status === 401 || a.status === 403);
  a = await get('/admin/api/games/settings');
  ok('admin settings: values + field list for the form', a.body.ok && a.body.fields.global.length > 5 && a.body.fields.games.cricket.some((f) => f.k === 'windowSix') && a.body.fields.meta.penalty.name === 'Penalty Shootout');
  const s2 = a.body.settings; s2.games.cricket.targetMin = 18; s2.monthlyCoinCap = 200;
  a = await post('/admin/api/games/settings', s2);
  await new Promise((res) => setTimeout(res, 20));
  ok('admin save: live + change log lists cricket.targetMin', a.body.ok && JSON.parse(DB.settings.games).games.cricket.targetMin === 18 && a.body.changed.includes('cricket.targetMin') && DB.audit.some((x) => x[0] === 'games.settings' && /cricket.targetMin 16 → 18/.test(x[3])), a.body);
  a = await post('/admin/api/games/settings', Object.assign({}, s2, { games: Object.assign({}, s2.games, { cricket: Object.assign({}, s2.games.cricket, { speedMin: 2000, speedMax: 500 }) }) }));
  ok('admin save refuses impossible difficulty', a.status === 400 && /slowest ball/.test(a.body.message));
  a = await post('/admin/api/games/questions/starter', { kind: 'EMOJI' });
  const again = await post('/admin/api/games/questions/starter', { kind: 'EMOJI' });
  ok('starter pack loads once (second time adds 0)', a.body.ok && a.body.added > 40 && again.body.added === 0, [a.body, again.body]);
  a = await post('/admin/api/games/question', { kind: 'QUIZ', question: 'Q?', options: ['A', 'B', 'B', 'D'], answer: 0 });
  ok('question form: 4 different answers required', a.status === 400 && /different/.test(a.body.message));
  a = await get('/admin/api/games/overview');
  ok('overview answers', a.body.ok);
  const panel = await (await fetch(base + '/panel')).text();
  const pscripts = [...panel.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  let pparsed = true; for (const sc of pscripts) { try { new Function(sc); } catch (e) { pparsed = false; console.log('   panel parse error:', e.message); } }
  ok('panel parses; 🎮 Games in the menu with settings, slices and questions', pparsed && /\['games', '🎮', 'Games'\]/.test(panel) && /games: gamesView/.test(panel) && /function gmSlices\(/.test(panel) && /\/admin\/api\/games\/questions\/starter/.test(panel));
  const gmSrc = (panel.match(/function gmChance\([\s\S]*?\n\}/) || [''])[0];
  const gmChance = new Function(gmSrc + '; return gmChance;')();
  ok('panel wheel chance % = server odds', gmChance([{ weight: 1 }, { weight: 3 }], 1) === 75);
  const lvSrc = (panel.match(/function gmLevelOf\([\s\S]*?\n\}/) || [''])[0];
  const GMx = { f: { presets: games.PRESETS, levels: games.LEVELS }, s: games.defaults() };
  const gmLevelOf = new Function('GM', lvSrc + '; return gmLevelOf;')(GMx);
  GMx.s.games.penalty = Object.assign(GMx.s.games.penalty, games.PRESETS.penalty.pro);
  ok('panel ⚡ Difficulty buttons + level detection = server', /data-gpre="/.test(panel) && gmLevelOf('penalty') === 'pro' && gmLevelOf('cricket') === 'normal' && a.body === a.body);
  a = await get('/admin/api/games/settings');
  ok('admin settings send the difficulty levels + sound switch', a.body.fields.presets.cricket.pro.windowSix === 7 && a.body.fields.levels.length === 4 && a.body.fields.global.some((f) => f.k === 'soundsEnabled'));
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));

  // ---- wiring ----
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server.js: /games page + storefront actions + limits', /app\.get\(\['\/games', '\/games\/'\]/.test(serverSrc) && /'getGamesStatus', 'getGamesHome', 'gameStart', 'gameStep', 'gameFinish', 'gamesSendCode'/.test(serverSrc) && /gameStart: security\.rateLimiter/.test(serverSrc));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('shop Tools: Games chip only when games are on, opens /games', /"data-tool": "games"/.test(idx) && /getGamesStatus/.test(idx) && /gamesOn && React\.createElement/.test(idx));
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v22.sql'), 'utf8');
  ok('schema-v22: plays (free slot unique) + questions', /CREATE TABLE IF NOT EXISTS game_plays/.test(sql) && /UNIQUE KEY uq_game_free \(phone_norm, game, play_date, free_slot\)/.test(sql) && /CREATE TABLE IF NOT EXISTS quiz_questions/.test(sql));
  const q = require('../gamequestions');
  ok('starter pack: 100+ quiz questions with 4 different answers, emoji categories have 4+ titles', q.QUIZ.length >= 100 && q.QUIZ.every((x) => new Set(x.slice(1, 5)).size === 4) && ['bollywood', 'series', 'hollywood', 'anime', 'sports'].every((c) => q.EMOJI.filter((e) => e[2] === c).length >= 4));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
