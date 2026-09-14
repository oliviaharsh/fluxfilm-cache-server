/**
 * FluxFilm - 🎮 Games (shop.fluxfilm.in/games): free daily mini-games that win coins or coupons.
 * Everything the owner controls (on/off, free plays, extra-play price, prizes, difficulty, limits) is in
 * app_settings['games'], edited in admin → 🎮 Games. Tables: game_plays + quiz_questions (db/schema-v21.sql).
 *
 * Rules (GAMES-PLAN.md):
 *  - Each game has N free plays a day. Extra plays cost coins, only when "paidPlaysEnabled" is ON (default OFF until
 *    the owner's lawyer / CA has approved it). Coins are never sold for money.
 *  - The SERVER decides every result: spin slice, right answers, keeper dives, ball plan. The browser only animates
 *    and sends its taps; the server scores them again. Timing games are also checked for "too fast / too high".
 *  - Prizes need a customer with a paid order (requirePaidOrder) on a device that confirmed the email code
 *    (requireVerify; same signed token as Get OTP). Others play in PRACTICE mode (no prize, no cost).
 *    Spending coins on an extra play ALWAYS needs the verified device (a phone number alone can't spend coins).
 *  - Coins won are capped per day and per month; coupons per month. Coupons are normal `coupons` rows locked to
 *    the winner's phone (1 use, expiry), so they show in the shop account and work at checkout.
 *
 * Storefront actions (server.js): getGamesStatus, getGamesHome, gameStart, gameStep, gameFinish, gamesSendCode.
 */
const crypto = require('crypto');
const db = require('./db');
const coins = require('./coins');
const otpaccess = require('./otpaccess');
const QUESTIONS = require('./gamequestions');

const SETTINGS_KEY = 'games';
const s = (v) => String(v == null ? '' : v).trim();
const asNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const int = (v) => Math.round(asNum(v));
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const randInt = (lo, hi) => (hi <= lo ? lo : crypto.randomInt(lo, hi + 1));
const shuffle = (arr, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor((r || rnd)() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };

const PLAY_TTL_MS = 30 * 60e3; // a play must be finished within 30 minutes
// Track units shared with games.html (0 = bowler / top, 1000 = stumps / goal line).
const CRICKET_SWEET = 850;
const YORKER_TARGET = 880;
const PENALTY_CENTRE = 700;

const GAMES = {
  spin: { name: 'Daily Spin', icon: '🎡' },
  quiz: { name: 'Movie Quiz', icon: '🎬' },
  emoji: { name: 'Emoji Guess', icon: '🎭' },
  popcorn: { name: 'Popcorn Catch', icon: '🍿' },
  cricket: { name: 'Super Over', icon: '🏏' },
  yorker: { name: 'Yorker Challenge', icon: '🎯' },
  penalty: { name: 'Penalty Shootout', icon: '⚽' },
};
const GAME_KEYS = Object.keys(GAMES);

// ---------------- settings (fields drive both validation and the admin form) ----------------
// [key, label, default, min, max, step, help]; step 'bool' = on/off.
const F = (k, label, d, min, max, step, help) => ({ k, label, d, min, max, step: step == null ? 1 : step, help: help || '' });
const B = (k, label, d, help) => ({ k, label, d, step: 'bool', help: help || '' });
const GLOBAL_FIELDS = [
  B('enabled', 'Games page is ON', true, 'Off = the Games tile disappears from the shop and /games says "coming back soon".'),
  B('requirePaidOrder', 'Prizes only for paying customers', true, 'A customer needs at least one paid order to win coins or coupons. Others play for fun (practice).'),
  B('requireVerify', 'Confirm the phone by email code before prizes', true, 'Stops people typing someone else\'s number to collect coins. Same code as Get OTP (once per device, 30 days).'),
  B('practiceEnabled', 'Let non-customers play for fun (no prizes)', true),
  B('paidPlaysEnabled', 'Extra plays for coins (after the free play)', false, '⚖️ Keep OFF until your lawyer / CA says OK. Extra plays always need the email-code check.'),
  B('prizesOnPaidPlays', 'Extra (coin) plays can also win prizes', true, 'Off = extra plays are just for fun and score.'),
  F('dailyCoinCap', 'Max coins a customer can win per day', 40, 0, 10000, 1, '0 = no daily limit'),
  F('monthlyCoinCap', 'Max coins a customer can win per month', 150, 0, 100000, 1, '0 = no monthly limit'),
  F('monthlyCouponCap', 'Max coupons a customer can win per month', 2, 0, 100, 1, '0 = coupons are switched off'),
  F('couponDays', 'Coupons won are valid for', 14, 1, 365, 1, 'days'),
  F('couponMinOrder', 'Coupons need a minimum order of', 0, 0, 100000, 1, '₹ (0 = any order)'),
  F('streakDays', 'Streak bonus after playing this many days in a row', 7, 0, 60, 1, '0 = streak bonus off'),
  F('streakCoins', 'Streak bonus', 10, 0, 1000, 1, 'coins'),
];
const COMMON_FIELDS = [
  B('enabled', 'Game is ON', true),
  F('freePerDay', 'Free plays per day', 1, 0, 10),
  F('extraCost', 'Extra play costs', 10, 0, 10000, 1, 'coins'),
  F('maxExtraPerDay', 'Max extra plays per day', 5, 0, 100),
];
const GAME_FIELDS = {
  spin: [],
  quiz: [
    F('questions', 'Questions per play', 5, 3, 10), F('seconds', 'Seconds per question', 15, 5, 60),
    F('coinsPerRight', 'Coins per right answer', 1, 0, 100), F('perfectBonus', 'Bonus coins for all right', 2, 0, 1000),
    F('perfectCoupon', 'Coupon for all right', 0, 0, 500, 1, '₹ off (0 = no coupon)'),
  ],
  emoji: [
    F('rounds', 'Rounds per play', 8, 3, 15), F('seconds', 'Seconds per round', 8, 3, 30),
    F('coinsPerRight', 'Coins per right answer', 1, 0, 100), F('perfectBonus', 'Bonus coins for all right', 0, 0, 1000),
    F('perfectCoupon', 'Coupon for all right', 10, 0, 500, 1, '₹ off (0 = no coupon)'),
  ],
  popcorn: [
    F('seconds', 'Game length', 60, 15, 180, 1, 'seconds'), F('lives', 'Lives', 3, 1, 10),
    F('speed', 'Speed', 1, 0.5, 3, 0.1, '1 = normal, 2 = twice as fast'),
    F('pointsPerCoin', 'Points for 1 coin', 50, 1, 10000), F('maxCoins', 'Max coins per play', 10, 0, 1000),
    F('couponAt', 'Coupon when points reach', 1000, 0, 100000, 1, '0 = no coupon'), F('couponValue', 'Coupon value', 10, 0, 500, 1, '₹ off'),
  ],
  cricket: [
    F('balls', 'Balls', 6, 1, 12), F('wickets', 'Wickets', 2, 1, 10),
    F('targetMin', 'Target runs from', 16, 1, 72), F('targetMax', 'Target runs up to', 22, 1, 72),
    F('speedMin', 'Slowest ball', 750, 200, 3000, 10, 'bigger = faster'), F('speedMax', 'Fastest ball', 1150, 200, 3000, 10),
    F('slowerBallPct', 'Slower balls (change of pace)', 30, 0, 100, 1, '% of balls'), F('swing', 'Swing', 45, 0, 150, 1, '0 = straight'),
    F('windowSix', 'Timing window for a SIX', 16, 2, 140, 1, 'smaller = harder'), F('windowFour', 'Timing window for a FOUR', 38, 2, 140),
    F('windowTwo', 'Timing window for 2 runs', 70, 2, 140), F('windowOne', 'Timing window for 1 run (outside = out/miss)', 110, 2, 140),
    F('winCoins', 'Coins for chasing the target', 8, 0, 1000), F('runCoins', 'Coins per run', 0, 0, 100),
    F('couponSixes', 'Coupon if they win with this many sixes', 3, 0, 12, 1, '0 = no coupon'), F('couponValue', 'Coupon value', 15, 0, 500, 1, '₹ off'),
  ],
  yorker: [
    F('balls', 'Balls', 6, 1, 12), F('speedMin', 'Slowest delivery', 700, 200, 3000, 10), F('speedMax', 'Fastest delivery', 1100, 200, 3000, 10),
    F('yorkerWindow', 'Yorker (wicket) zone size', 50, 4, 240, 1, 'smaller = harder'), F('goodWindow', 'Dot-ball zone size', 140, 4, 240),
    F('winWickets', 'Wickets needed to win', 3, 1, 12), F('wicketCoins', 'Coins per wicket', 1, 0, 100), F('winCoins', 'Coins for a win', 5, 0, 1000),
    F('couponAllYorkers', 'Coupon if every ball is a wicket', 10, 0, 500, 1, '₹ off (0 = no coupon)'),
  ],
  penalty: [
    F('kicks', 'Penalty kicks', 5, 1, 10), F('keeperSkill', 'Goalkeeper skill', 35, 0, 100, 1, '% chance to reach a corner next to his dive'),
    F('meterSpeed', 'Power bar speed', 1.3, 0.3, 4, 0.1, 'bigger = harder'), F('powerBand', 'Good power zone size', 220, 20, 600, 10, 'smaller = harder'),
    F('winGoals', 'Goals needed to win', 4, 1, 10), F('goalCoins', 'Coins per goal', 1, 0, 100), F('winCoins', 'Coins for a win', 5, 0, 1000),
    F('couponAllGoals', 'Coupon if every kick is a goal', 10, 0, 500, 1, '₹ off (0 = no coupon)'),
  ],
};
const DEFAULT_SLICES = [
  { label: '5', coins: 5, coupon: 0, weight: 18 }, { label: '1', coins: 1, coupon: 0, weight: 20 },
  { label: '10', coins: 10, coupon: 0, weight: 8 }, { label: 'Try again', coins: 0, coupon: 0, weight: 18 },
  { label: '2', coins: 2, coupon: 0, weight: 18 }, { label: '₹10 off', coins: 0, coupon: 10, weight: 3 },
  { label: '3', coins: 3, coupon: 0, weight: 15 }, { label: 'Try again', coins: 0, coupon: 0, weight: 10 },
];

function defaults() {
  const out = {};
  for (const f of GLOBAL_FIELDS) out[f.k] = f.d;
  out.games = {};
  for (const g of GAME_KEYS) {
    const o = {};
    for (const f of COMMON_FIELDS.concat(GAME_FIELDS[g])) o[f.k] = f.d;
    if (g === 'spin') o.slices = DEFAULT_SLICES.map((x) => Object.assign({}, x));
    out.games[g] = o;
  }
  return out;
}

function readFields(fields, input, base, prefix, errors) {
  const out = {};
  for (const f of fields) {
    const v = input ? input[f.k] : undefined;
    if (f.step === 'bool') { out[f.k] = v === undefined || v === null || v === '' ? base[f.k] : (v === true || v === 1 || s(v).toLowerCase() === 'true' || v === '1'); continue; }
    if (v === undefined || v === null || v === '') { out[f.k] = base[f.k]; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < f.min || n > f.max) { errors.push(prefix + f.label + ' must be between ' + f.min + ' and ' + f.max + '.'); out[f.k] = base[f.k]; continue; }
    out[f.k] = f.step < 1 ? Math.round(n * 100) / 100 : Math.round(n);
  }
  return out;
}

function validateSettings(input) {
  const d = defaults(); const inb = input || {}; const errors = [];
  const out = readFields(GLOBAL_FIELDS, inb, d, '', errors);
  out.games = {};
  const ing = inb.games || {};
  for (const g of GAME_KEYS) {
    const pre = GAMES[g].name + ': ';
    const o = readFields(COMMON_FIELDS.concat(GAME_FIELDS[g]), ing[g] || {}, d.games[g], pre, errors);
    if (g === 'spin') {
      const raw = Array.isArray((ing.spin || {}).slices) ? ing.spin.slices : d.games.spin.slices;
      const slices = [];
      raw.forEach((x, i) => {
        const sl = { label: s(x && x.label).replace(/[<>]/g, '').slice(0, 14), coins: int(x && x.coins), coupon: int(x && x.coupon), weight: int(x && x.weight) };
        if (sl.coins < 0 || sl.coins > 1000 || sl.coupon < 0 || sl.coupon > 500 || sl.weight < 0 || sl.weight > 1000) errors.push(pre + 'slice ' + (i + 1) + ': coins 0–1000, coupon ₹0–500, chance 0–1000.');
        if (!sl.label) sl.label = sl.coupon ? '₹' + sl.coupon + ' off' : sl.coins ? String(sl.coins) : 'Try again';
        slices.push(sl);
      });
      if (slices.length < 2 || slices.length > 12) errors.push(pre + 'the wheel needs 2 to 12 slices.');
      if (!slices.some((x) => x.weight > 0)) errors.push(pre + 'at least one slice needs a chance above 0.');
      o.slices = slices;
    }
    if (g === 'cricket') {
      if (o.targetMin > o.targetMax) errors.push(pre + '"Target runs from" can\'t be more than "up to".');
      if (o.speedMin > o.speedMax) errors.push(pre + 'slowest ball can\'t be faster than the fastest ball.');
      if (!(o.windowSix <= o.windowFour && o.windowFour <= o.windowTwo && o.windowTwo <= o.windowOne)) errors.push(pre + 'timing windows must grow: SIX ≤ FOUR ≤ 2 runs ≤ 1 run.');
      if (o.couponSixes > o.balls) errors.push(pre + 'sixes for the coupon can\'t be more than the balls.');
    }
    if (g === 'yorker') {
      if (o.speedMin > o.speedMax) errors.push(pre + 'slowest delivery can\'t be faster than the fastest.');
      if (o.yorkerWindow > o.goodWindow) errors.push(pre + 'yorker zone must be smaller than the dot-ball zone.');
      if (o.winWickets > o.balls) errors.push(pre + 'wickets to win can\'t be more than the balls.');
    }
    if (g === 'penalty' && o.winGoals > o.kicks) errors.push(pre + 'goals to win can\'t be more than the kicks.');
    out.games[g] = o;
  }
  return { ok: !errors.length, settings: out, errors };
}

let cache = null; let cacheAt = 0;
async function getSettings(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 30e3) return cache;
  let saved = {}; let ready = true;
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [SETTINGS_KEY]);
    if (rows.length) { try { saved = JSON.parse(rows[0].value) || {}; } catch (_) { saved = {}; } }
  } catch (e) { if (!missingTable(e)) throw e; ready = false; }
  // Saved values that are now out of range fall back to the defaults instead of breaking the page.
  cache = Object.assign(validateSettings(saved).settings, { settingsReady: ready });
  cacheAt = Date.now();
  return cache;
}
async function saveSettings(input) {
  const v = validateSettings(input);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  try {
    await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [SETTINGS_KEY, JSON.stringify(v.settings)]);
  } catch (e) {
    if (missingTable(e)) return { ok: false, needsSchema: true, message: 'Run db/schema-v15.sql in phpMyAdmin first.' };
    throw e;
  }
  cache = null;
  return { ok: true, settings: v.settings };
}

// ---------------- dates (India time) ----------------
const istDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms || Date.now()));
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthStart = (ymd) => ymd.slice(0, 8) + '01';

let schemaOk = null; let schemaAt = 0;
async function schemaReady() {
  if (schemaOk && Date.now() - schemaAt < 5 * 60e3) return true;
  try { await db.query('SELECT 1 FROM game_plays LIMIT 1', []); schemaOk = true; schemaAt = Date.now(); return true; }
  catch (e) { if (missingTable(e)) { schemaOk = false; return false; } throw e; }
}

// ---------------- who may win ----------------
async function hasPaidOrder(ph) {
  const r = await db.query("SELECT 1 FROM orders WHERE phone_norm = ? AND UPPER(status) = 'PAID' LIMIT 1", [ph]);
  return r.length > 0;
}
async function eligibility(ph, token, cfg) {
  const tokenOk = !!(ph && otpaccess.verifyToken(token, ph));
  const verified = !cfg.requireVerify || tokenOk;
  const paidCustomer = cfg.requirePaidOrder ? await hasPaidOrder(ph) : true;
  return { verified, tokenOk, paidCustomer, canWin: verified && paidCustomer };
}

// ---------------- questions ----------------
async function pickQuestions(kind, n) {
  let rows = [];
  try { rows = await db.query('SELECT id, question, opt_a, opt_b, opt_c, opt_d, answer, category FROM quiz_questions WHERE kind = ? AND active = 1', [kind]); }
  catch (e) { if (!missingTable(e)) throw e; }
  let list = rows.map((r) => ({ id: r.id, q: r.question, options: [r.opt_a, r.opt_b, r.opt_c, r.opt_d], answer: int(r.answer) }));
  if (list.length < n) {
    // Not enough in the table yet: use the built-in starter pack.
    list = QUESTIONS.starterRows(kind).map((r, i) => ({ id: 'S' + i, q: r.question, options: r.options, answer: r.answer }));
  }
  return shuffle(list).slice(0, n).map((x) => {
    const order = shuffle([0, 1, 2, 3]);
    return { id: x.id, q: x.q, options: order.map((i) => x.options[i]), answer: order.indexOf(x.answer) };
  });
}

// ---------------- round plans (seed = server only, data = sent to the browser) ----------------
function pickSlice(slices) {
  const total = slices.reduce((a, x) => a + Math.max(0, x.weight), 0);
  let r = crypto.randomInt(0, Math.max(1, total));
  for (let i = 0; i < slices.length; i++) { r -= Math.max(0, slices[i].weight); if (r < 0) return i; }
  return 0;
}
async function makePlan(game, g) {
  const now = Date.now();
  if (game === 'spin') {
    const i = pickSlice(g.slices);
    return { seed: { index: i }, data: { slices: g.slices.map((x) => ({ label: x.label, coins: x.coins, coupon: x.coupon })) } };
  }
  if (game === 'quiz' || game === 'emoji') {
    const n = game === 'quiz' ? g.questions : g.rounds;
    const qs = await pickQuestions(game === 'quiz' ? 'QUIZ' : 'EMOJI', n);
    return {
      seed: { cfg: { n: qs.length, seconds: g.seconds, coinsPerRight: g.coinsPerRight, perfectBonus: g.perfectBonus, perfectCoupon: g.perfectCoupon }, a: qs.map((x) => x.answer), ids: qs.map((x) => x.id), got: [], lastMs: now },
      data: { seconds: g.seconds, questions: qs.map((x) => ({ q: x.q, options: x.options })) },
    };
  }
  if (game === 'popcorn') {
    const c = { seconds: g.seconds, lives: g.lives, speed: g.speed, pointsPerCoin: g.pointsPerCoin, maxCoins: g.maxCoins, couponAt: g.couponAt, couponValue: g.couponValue };
    return { seed: { cfg: c }, data: c };
  }
  if (game === 'cricket') {
    const plan = [];
    for (let i = 0; i < g.balls; i++) {
      const slow = rnd() * 100 < g.slowerBallPct;
      plan.push({ speed: randInt(g.speedMin, g.speedMax), swing: randInt(-g.swing, g.swing), slowAt: slow ? randInt(300, 600) : 0, slowFactor: slow ? Math.round((0.45 + rnd() * 0.2) * 100) / 100 : 1 });
    }
    const c = { balls: g.balls, wickets: g.wickets, windowSix: g.windowSix, windowFour: g.windowFour, windowTwo: g.windowTwo, windowOne: g.windowOne, winCoins: g.winCoins, runCoins: g.runCoins, couponSixes: g.couponSixes, couponValue: g.couponValue };
    const target = randInt(g.targetMin, g.targetMax);
    return { seed: { cfg: c, target, plan }, data: Object.assign({ target, plan, sweet: CRICKET_SWEET }, c) };
  }
  if (game === 'yorker') {
    const plan = [];
    for (let i = 0; i < g.balls; i++) plan.push({ speed: randInt(g.speedMin, g.speedMax) });
    const c = { balls: g.balls, yorkerWindow: g.yorkerWindow, goodWindow: g.goodWindow, winWickets: g.winWickets, wicketCoins: g.wicketCoins, winCoins: g.winCoins, couponAllYorkers: g.couponAllYorkers };
    return { seed: { cfg: c, plan }, data: Object.assign({ plan, target: YORKER_TARGET }, c) };
  }
  if (game === 'penalty') {
    const keeper = []; const reads = [];
    for (let i = 0; i < g.kicks; i++) { keeper.push(crypto.randomInt(0, 6)); reads.push(rnd() * 100 < g.keeperSkill); }
    const c = { kicks: g.kicks, meterSpeed: g.meterSpeed, powerBand: g.powerBand, winGoals: g.winGoals, goalCoins: g.goalCoins, winCoins: g.winCoins, couponAllGoals: g.couponAllGoals };
    return { seed: { cfg: c, keeper, reads, got: [], lastMs: now }, data: Object.assign({ centre: PENALTY_CENTRE }, c) };
  }
  throw new Error('unknown game ' + game);
}

// ---------------- scoring (pure; games.html uses the same rules to animate) ----------------
function cricketBall(c, pos) {
  if (pos == null || !Number.isFinite(Number(pos)) || Number(pos) >= 1000) return { runs: 0, out: true, text: 'BOWLED' };
  const d = Number(pos) - CRICKET_SWEET;
  if (d < -c.windowOne) return { runs: 0, out: false, text: 'Too early' };
  if (d > c.windowOne) return { runs: 0, out: true, text: 'Too late — BOWLED' };
  const ad = Math.abs(d);
  const runs = ad <= c.windowSix ? 6 : ad <= c.windowFour ? 4 : ad <= c.windowTwo ? 2 : 1;
  return { runs, out: false, text: runs === 6 ? 'SIX' : runs === 4 ? 'FOUR' : runs + (runs === 1 ? ' run' : ' runs') };
}
function ballTimeMs(b, p) {
  const at = b.slowAt > 0 ? b.slowAt : 2000; const sp = Math.max(1, b.speed);
  const sec = p <= at ? p / sp : at / sp + (p - at) / (sp * (b.slowFactor || 1));
  return sec * 1000;
}
function scoreCricket(seed, input, elapsedMs) {
  const c = seed.cfg; const taps = Array.isArray(input && input.taps) ? input.taps : [];
  let runs = 0, wkts = 0, sixes = 0, balls = 0, minMs = 0; const log = [];
  for (let i = 0; i < c.balls; i++) {
    if (runs >= seed.target || wkts >= c.wickets) break;
    const t = taps[i] == null ? null : Number(taps[i]);
    const r = cricketBall(c, t);
    balls++; runs += r.runs; if (r.out) wkts++; if (r.runs === 6) sixes++;
    log.push(r.out ? 'W' : r.runs);
    minMs += ballTimeMs(seed.plan[i], Math.max(0, Math.min(1000, t == null || !Number.isFinite(t) ? 1000 : t)));
  }
  const won = runs >= seed.target;
  const res = { score: runs, won, detail: { runs, wickets: wkts, balls, sixes, target: seed.target, log } };
  res.coins = runs * c.runCoins + (won ? c.winCoins : 0);
  res.coupon = won && c.couponSixes > 0 && sixes >= c.couponSixes ? c.couponValue : 0;
  if (elapsedMs < minMs * 0.8) res.flag = 'finished faster than the balls can travel';
  return res;
}
function yorkerBall(c, pos) {
  if (pos == null || !Number.isFinite(Number(pos)) || Number(pos) > 1000) return { wicket: false, runs: 1, text: 'No ball' };
  const d = Number(pos) - YORKER_TARGET; const ad = Math.abs(d);
  if (ad <= c.yorkerWindow / 2) return { wicket: true, runs: 0, text: 'YORKER — BOWLED' };
  if (ad <= c.goodWindow / 2) return { wicket: false, runs: 0, text: 'Dot ball' };
  return d < 0 ? { wicket: false, runs: 6, text: 'Too short — SIX' } : { wicket: false, runs: 4, text: 'Full toss — FOUR' };
}
function scoreYorker(seed, input, elapsedMs) {
  const c = seed.cfg; const taps = Array.isArray(input && input.taps) ? input.taps : [];
  let wickets = 0, runs = 0, minMs = 0; const log = [];
  for (let i = 0; i < c.balls; i++) {
    const t = taps[i] == null ? null : Number(taps[i]);
    const r = yorkerBall(c, t); if (r.wicket) wickets++; runs += r.runs; log.push(r.wicket ? 'W' : r.runs);
    minMs += (Math.max(0, Math.min(1000, t == null || !Number.isFinite(t) ? 1000 : t)) / Math.max(1, seed.plan[i].speed)) * 1000;
  }
  const won = wickets >= c.winWickets;
  const res = { score: wickets, won, detail: { wickets, runs, balls: c.balls, log } };
  res.coins = wickets * c.wicketCoins + (won ? c.winCoins : 0);
  res.coupon = c.couponAllYorkers > 0 && wickets === c.balls ? c.couponAllYorkers : 0;
  if (elapsedMs < minMs * 0.8) res.flag = 'finished faster than the balls can travel';
  return res;
}
const zoneRowCol = (z) => [z < 3 ? 0 : 1, z % 3];
function penaltyKick(c, keeperZone, reads, zone, power) {
  const lo = PENALTY_CENTRE - c.powerBand / 2; const hi = PENALTY_CENTRE + c.powerBand / 2;
  if (!(power >= lo)) return { outcome: 'SAVED', why: 'weak' };
  if (power > hi) return { outcome: 'MISS', why: 'over' };
  if (zone === keeperZone) return { outcome: 'SAVED', why: 'dive' };
  const [r1, c1] = zoneRowCol(zone); const [r2, c2] = zoneRowCol(keeperZone);
  const next = (r1 === r2 && Math.abs(c1 - c2) === 1) || (c1 === c2 && r1 !== r2);
  if (next && reads) return { outcome: 'SAVED', why: 'reach' };
  return { outcome: 'GOAL' };
}
function scorePenalty(seed) {
  const c = seed.cfg; const goals = seed.got.filter((k) => k.outcome === 'GOAL').length;
  const won = goals >= c.winGoals;
  const res = { score: goals, won, detail: { goals, kicks: c.kicks, taken: seed.got.length, log: seed.got.map((k) => k.outcome) } };
  res.coins = goals * c.goalCoins + (won ? c.winCoins : 0);
  res.coupon = c.couponAllGoals > 0 && goals === c.kicks ? c.couponAllGoals : 0;
  if (seed.fast) res.flag = 'kicks too fast';
  return res;
}
function scoreQuiz(seed) {
  const c = seed.cfg; const right = seed.got.reduce((a, x) => a + (x ? 1 : 0), 0);
  const perfect = right === c.n && seed.got.length === c.n;
  return { score: right, won: perfect, detail: { right, total: c.n }, coins: right * c.coinsPerRight + (perfect ? c.perfectBonus : 0), coupon: perfect && c.perfectCoupon > 0 ? c.perfectCoupon : 0 };
}
function scorePopcorn(seed, input, elapsedMs) {
  const c = seed.cfg; const score = Math.max(0, int(input && input.score));
  const played = Math.min(Math.max(0, int(input && input.durationMs)), elapsedMs + 2000, (c.seconds + 3) * 1000);
  const res = { score, won: c.couponAt > 0 && score >= c.couponAt, detail: { score, seconds: Math.round(played / 1000) } };
  res.coins = Math.min(c.maxCoins, Math.floor(score / Math.max(1, c.pointsPerCoin)));
  res.coupon = c.couponAt > 0 && score >= c.couponAt ? c.couponValue : 0;
  const maxScore = Math.ceil(played / 1000) * 70 * c.speed + 100;
  if (score % 10 !== 0 || score > maxScore) res.flag = 'score not possible in ' + Math.round(played / 1000) + 's';
  return res;
}

// ---------------- helpers on plays ----------------
async function todayCounts(ph, today) {
  const rows = await db.query("SELECT game, kind, COUNT(*) n FROM game_plays WHERE phone_norm = ? AND play_date = ? GROUP BY game, kind", [ph, today]);
  const out = {};
  for (const r of rows) { out[r.game] = out[r.game] || { FREE: 0, PAID: 0, PRACTICE: 0 }; out[r.game][r.kind] = int(r.n); }
  return out;
}
async function wonSoFar(conn, ph, today) {
  const q = "SELECT COALESCE(SUM(CASE WHEN play_date = ? THEN coins_won ELSE 0 END), 0) day, COALESCE(SUM(coins_won), 0) month, COALESCE(SUM(coupon_code IS NOT NULL), 0) coupons FROM game_plays WHERE phone_norm = ? AND play_date >= ?";
  const p = [today, ph, monthStart(today)];
  const rows = conn ? (await conn.query(q, p))[0] : await db.query(q, p);
  const r = rows[0] || {};
  return { day: int(r.day), month: int(r.month), coupons: int(r.coupons) };
}

// Give coins for a finished play, inside the wallet lock so the day / month limits can't be passed twice at once.
async function giveCoins(ph, playId, want, cfg, today, event, note) {
  if (want <= 0) return { coins: 0 };
  return coins.withWallet(ph, async (conn, w) => {
    const so = await wonSoFar(conn, ph, today);
    let give = want; let capped = '';
    if (cfg.dailyCoinCap > 0 && so.day + give > cfg.dailyCoinCap) { give = Math.max(0, cfg.dailyCoinCap - so.day); capped = 'daily'; }
    if (cfg.monthlyCoinCap > 0 && so.month + give > cfg.monthlyCoinCap) { give = Math.max(0, cfg.monthlyCoinCap - so.month); capped = 'monthly'; }
    await conn.query('UPDATE game_plays SET coins_won = ? WHERE id = ?', [give, playId]);
    if (give <= 0) return { coins: 0, capped, balanceAfter: w.balance };
    const after = w.balance + give;
    await conn.query('UPDATE wallet SET coins_balance = coins_balance + ?, coins_lifetime = coins_lifetime + ?, last_earned_at = NOW(), last_event = ? WHERE phone = ?', [give, give, (event + ':GP' + playId).slice(0, 150), w.phone]);
    await coins.writeLedger(conn, { event, orderId: 'GP' + playId, phone: ph, service: 'Games', plan: note, delta: give, balanceAfter: after, note: note + (capped ? ' (limit reached: ' + capped + ')' : '') });
    return { coins: give, capped, balanceAfter: after };
  });
}

const COUPON_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function giveCoupon(ph, playId, value, cfg, today, gameName) {
  if (value <= 0) return null;
  if (cfg.monthlyCouponCap <= 0) return { capped: 'off' };
  const so = await wonSoFar(null, ph, today);
  if (so.coupons >= cfg.monthlyCouponCap) return { capped: 'monthly' };
  let code = 'FG'; for (let i = 0; i < 7; i++) code += COUPON_CHARS[crypto.randomInt(0, COUPON_CHARS.length)];
  const expiry = addDays(today, cfg.couponDays) + ' 23:59:59';
  // Same shape as admin → Coupons (admin.js): typed columns AND raw_json, which checkout reads (couponDiscount).
  const raw = {
    Code: code, CouponCode: code, Description: '🎮 Won in ' + gameName + ' — ₹' + value + ' off', Scope: 'ANY', Type: 'FLAT', Value: value,
    MinAmount: cfg.couponMinOrder, MaxDiscount: 0, Expiry: expiry, PerUserLimit: 1, GlobalLimit: 1, Active: 'TRUE', ShowInProfile: 'TRUE',
    AllowedPhones: ph, FirstTimeOnly: 'FALSE', Source: 'GAMES', PlayId: playId,
  };
  await db.query(
    'INSERT INTO coupons (code, description, scope, type, value, min_amount, max_discount, expiry, per_user_limit, global_limit, active, show_in_profile, allowed_phones, first_time_only, raw_json)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [code, raw.Description, raw.Scope, raw.Type, raw.Value, raw.MinAmount, raw.MaxDiscount, expiry, raw.PerUserLimit, raw.GlobalLimit, raw.Active, raw.ShowInProfile, raw.AllowedPhones, raw.FirstTimeOnly, JSON.stringify(raw)]);
  await db.query('UPDATE game_plays SET coupon_code = ?, coupon_value = ? WHERE id = ?', [code, value, playId]);
  return { code, value, expiry, minOrder: cfg.couponMinOrder };
}

// Streak: days in a row (ending today) with at least one real play. Bonus once every `streakDays` days.
async function streakInfo(ph, today, cfg) {
  const look = Math.max(cfg.streakDays || 0, 30);
  const rows = await db.query("SELECT DISTINCT DATE_FORMAT(play_date, '%Y-%m-%d') d FROM game_plays WHERE phone_norm = ? AND kind IN ('FREE', 'PAID') AND play_date >= ?", [ph, addDays(today, -look)]);
  const days = new Set(rows.map((r) => s(r.d)));
  let n = 0; let d = days.has(today) ? today : addDays(today, -1);
  while (days.has(d) && n < look) { n++; d = addDays(d, -1); }
  return { days: n, playedToday: days.has(today), target: cfg.streakDays, bonus: cfg.streakCoins };
}
async function maybeStreakBonus(ph, today, cfg) {
  if (!(cfg.streakDays > 0 && cfg.streakCoins > 0)) return null;
  const st = await streakInfo(ph, today, cfg);
  if (st.days < cfg.streakDays) return null;
  const recent = await db.query("SELECT 1 FROM game_plays WHERE phone_norm = ? AND game = 'streak' AND play_date > ? LIMIT 1", [ph, addDays(today, -cfg.streakDays)]);
  if (recent.length) return null;
  let id;
  try {
    const r = await db.query("INSERT INTO game_plays (phone_norm, game, play_date, kind, free_slot, status, score, started_ms, finished_at) VALUES (?, 'streak', ?, 'BONUS', 1, 'DONE', ?, ?, NOW())", [ph, today, st.days, Date.now()]);
    id = r.insertId;
  } catch (e) { if (/Duplicate|ER_DUP_ENTRY/i.test(e.message)) return null; throw e; }
  const g = await giveCoins(ph, id, cfg.streakCoins, cfg, today, 'GAME_STREAK', st.days + '-day streak');
  return { days: st.days, coins: g.coins, capped: g.capped };
}

// ---------------- storefront actions ----------------
async function getStatus() {
  const cfg = await getSettings();
  let ready = false; try { ready = await schemaReady(); } catch (_) { ready = false; }
  return { ok: true, enabled: !!(cfg.enabled && ready) };
}

async function getHome(phone, token) {
  const cfg = await getSettings();
  const ready = await schemaReady();
  const ph = norm(phone);
  const base = {
    ok: true, enabled: !!(cfg.enabled && ready), comingSoon: !ready, paidPlaysEnabled: cfg.paidPlaysEnabled, prizesOnPaidPlays: cfg.prizesOnPaidPlays,
    limits: { dailyCoinCap: cfg.dailyCoinCap, monthlyCoinCap: cfg.monthlyCoinCap, monthlyCouponCap: cfg.monthlyCouponCap, couponDays: cfg.couponDays, couponMinOrder: cfg.couponMinOrder },
    games: GAME_KEYS.filter((k) => cfg.games[k].enabled).map((k) => {
      const g = cfg.games[k];
      const pub = { key: k, name: GAMES[k].name, icon: GAMES[k].icon, freePerDay: g.freePerDay, extraCost: g.extraCost, maxExtraPerDay: g.maxExtraPerDay };
      for (const f of GAME_FIELDS[k]) pub[f.k] = g[f.k];
      if (k === 'spin') { const tw = g.slices.reduce((a, x) => a + Math.max(0, x.weight), 0) || 1; pub.slices = g.slices.map((x) => ({ label: x.label, coins: x.coins, coupon: x.coupon, chance: Math.round((Math.max(0, x.weight) / tw) * 1000) / 10 })); }
      return pub;
    }),
  };
  if (!base.enabled || !ph || ph.length < 10) return Object.assign(base, { loggedIn: false });
  const today = istDate();
  const [elig, counts, so, streak, wallet, couponRows] = await Promise.all([
    eligibility(ph, token, cfg), todayCounts(ph, today), wonSoFar(null, ph, today), streakInfo(ph, today, cfg),
    db.query('SELECT coins_balance FROM wallet WHERE phone_norm = ? ' + coins.WALLET_ORDER + ' LIMIT 1', [ph]),
    db.query("SELECT gp.coupon_code code, gp.coupon_value value, gp.game, DATE_FORMAT(c.expiry, '%Y-%m-%d') expiry, (SELECT COUNT(*) FROM coupon_usage u WHERE UPPER(u.coupon_code) = gp.coupon_code AND UPPER(u.action) = 'USED') used " +
      "FROM game_plays gp LEFT JOIN coupons c ON c.code = gp.coupon_code WHERE gp.phone_norm = ? AND gp.coupon_code IS NOT NULL ORDER BY gp.id DESC LIMIT 10", [ph]),
  ]);
  let maskedEmail = '';
  if (!elig.tokenOk) { try { maskedEmail = (await otpaccess.check(ph, '')).maskedEmail || ''; } catch (_) {} }
  base.games.forEach((g) => {
    const c = counts[g.key] || { FREE: 0, PAID: 0, PRACTICE: 0 };
    g.freeLeft = Math.max(0, g.freePerDay - c.FREE);
    g.extraLeft = cfg.paidPlaysEnabled ? Math.max(0, g.maxExtraPerDay - c.PAID) : 0;
  });
  return Object.assign(base, {
    loggedIn: true, today,
    eligibility: { verified: elig.verified, tokenOk: elig.tokenOk, paidCustomer: elig.paidCustomer, canWin: elig.canWin, practice: !elig.canWin && cfg.practiceEnabled, maskedEmail, requireVerify: cfg.requireVerify },
    balance: Math.floor(asNum((wallet[0] || {}).coins_balance)),
    won: { today: so.day, month: so.month, couponsMonth: so.coupons },
    streak,
    coupons: couponRows.map((r) => ({ code: r.code, value: int(r.value), game: (GAMES[r.game] || {}).name || r.game, expiry: r.expiry || '', used: int(r.used) > 0, expired: !!(r.expiry && r.expiry < today) })),
  });
}

async function start(phone, token, game, opts, meta) {
  const cfg = await getSettings();
  if (!cfg.enabled || !(await schemaReady())) return { ok: false, closed: true, message: 'Games are taking a short break. Please come back soon!' };
  const g = cfg.games[s(game)];
  if (!GAMES[s(game)] || !g || !g.enabled) return { ok: false, message: 'This game is not available right now.' };
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, needsLogin: true, message: 'Log in with your phone number to play.' };
  const today = istDate();
  const elig = await eligibility(ph, token, cfg);
  const c = (await todayCounts(ph, today))[game] || { FREE: 0, PAID: 0, PRACTICE: 0 };
  const wantPaid = !!(opts && opts.paid === true);
  let kind;
  if (!elig.canWin) {
    if (!cfg.practiceEnabled) return { ok: false, needsVerify: !elig.verified, needsOrder: !elig.paidCustomer, message: !elig.paidCustomer ? 'Games prizes are for FluxFilm customers — buy any plan to start playing.' : 'Confirm it\'s you with the email code to play.' };
    kind = 'PRACTICE';
  } else if (c.FREE < g.freePerDay) {
    kind = 'FREE';
  } else {
    if (!cfg.paidPlaysEnabled) return { ok: false, noFreeLeft: true, message: 'You\'ve used today\'s free play. Come back tomorrow! 🌙' };
    if (c.PAID >= g.maxExtraPerDay) return { ok: false, noFreeLeft: true, message: 'That\'s all the plays for today. Come back tomorrow! 🌙' };
    if (!elig.tokenOk) return { ok: false, needsVerify: true, message: 'Confirm it\'s you with the email code to use your coins.' };
    if (!wantPaid) return { ok: false, needPay: true, cost: g.extraCost, message: 'Play again for ' + g.extraCost + ' coins?' };
    kind = 'PAID';
  }
  const plan = await makePlan(game, g);
  const now = Date.now();
  const ip = s(meta && meta.ip).slice(0, 45);
  const insertSql = 'INSERT INTO game_plays (phone_norm, game, play_date, kind, free_slot, cost, status, seed_json, ip, started_ms) VALUES (?, ?, ?, ?, ?, ?, \'STARTED\', ?, ?, ?)';
  let playId; let balance = null;
  if (kind === 'PAID') {
    const r = await coins.withWallet(ph, async (conn, w) => {
      if (w.balance < g.extraCost) return { ok: false, notEnough: true, balance: Math.floor(w.balance) };
      const [ins] = await conn.query(insertSql, [ph, game, today, 'PAID', null, g.extraCost, JSON.stringify(plan.seed), ip, now]);
      const after = w.balance - g.extraCost;
      if (g.extraCost > 0) {
        await conn.query('UPDATE wallet SET coins_balance = coins_balance - ?, last_spent_at = NOW(), last_event = ? WHERE phone = ?', [g.extraCost, ('GAME_PLAY:GP' + ins.insertId).slice(0, 150), w.phone]);
        await coins.writeLedger(conn, { event: 'GAME_PLAY', orderId: 'GP' + ins.insertId, phone: ph, service: 'Games', plan: GAMES[game].name, delta: -g.extraCost, balanceAfter: after, note: 'Extra play: ' + GAMES[game].name });
      }
      return { ok: true, id: ins.insertId, balance: Math.floor(after) };
    });
    if (!r.ok) return { ok: false, notEnough: true, balance: r.balance, message: 'You need ' + g.extraCost + ' coins for an extra play (you have ' + r.balance + ').' };
    playId = r.id; balance = r.balance;
  } else {
    try {
      const r = await db.query(insertSql, [ph, game, today, kind, kind === 'FREE' ? c.FREE + 1 : null, 0, JSON.stringify(plan.seed), ip, now]);
      playId = r.insertId;
    } catch (e) {
      if (/Duplicate|ER_DUP_ENTRY/i.test(e.message)) return { ok: false, retry: true, message: 'Your free play just started on another screen. Refresh and try again.' };
      throw e;
    }
  }
  const out = { ok: true, playId: String(playId), game, kind, cost: kind === 'PAID' ? g.extraCost : 0, balance, data: plan.data, prizes: kind === 'FREE' || (kind === 'PAID' && cfg.prizesOnPaidPlays) };
  if (game === 'spin') {
    // The wheel result is decided now; the page only animates to it.
    const sl = g.slices[plan.seed.index];
    const fin = await settle({ id: playId, phone_norm: ph, game, kind, play_date: today }, cfg, { score: sl.coins, won: !!(sl.coins || sl.coupon), coins: sl.coins, coupon: sl.coupon, detail: { index: plan.seed.index, label: sl.label } });
    out.spin = Object.assign({ index: plan.seed.index }, fin);
  }
  return out;
}

async function loadPlay(ph, playId) {
  const id = s(playId).replace(/\D/g, '');
  if (!id) return null;
  const rows = await db.query('SELECT id, phone_norm, game, DATE_FORMAT(play_date, \'%Y-%m-%d\') play_date, kind, status, seed_json, result_json, started_ms FROM game_plays WHERE id = ? AND phone_norm = ? LIMIT 1', [id, ph]);
  return rows[0] || null;
}

// Quiz / Emoji answer (the right answer is revealed only after answering) and Penalty kick (keeper dive revealed after the kick).
async function step(phone, token, playId, payload) {
  const ph = norm(phone);
  const row = await loadPlay(ph, playId);
  if (!row) return { ok: false, message: 'Game not found — please start again.' };
  if (row.status !== 'STARTED') return { ok: false, finished: true, message: 'This game has already finished.' };
  const seed = JSON.parse(row.seed_json || '{}');
  const p = payload || {}; const now = Date.now();
  const i = int(p.i);
  let out;
  if (row.game === 'quiz' || row.game === 'emoji') {
    if (i !== seed.got.length || i >= seed.cfg.n) return { ok: false, message: 'Answer the questions in order.', expected: seed.got.length };
    const late = now - seed.lastMs > (seed.cfg.seconds + 3) * 1000;
    const choice = p.choice == null ? -1 : int(p.choice);
    const right = !late && choice === seed.a[i];
    seed.got.push(right ? 1 : 0); seed.lastMs = now;
    out = { ok: true, correct: seed.a[i], right, late, done: seed.got.length >= seed.cfg.n };
  } else if (row.game === 'penalty') {
    if (i !== seed.got.length || i >= seed.cfg.kicks) return { ok: false, message: 'Take the kicks in order.', expected: seed.got.length };
    const zone = Math.max(0, Math.min(5, int(p.zone))); const power = Math.max(0, Math.min(1000, int(p.power)));
    if (now - seed.lastMs < 350) seed.fast = true;
    const k = penaltyKick(seed.cfg, seed.keeper[i], seed.reads[i], zone, power);
    seed.got.push({ zone, power, outcome: k.outcome }); seed.lastMs = now;
    out = { ok: true, outcome: k.outcome, why: k.why || '', keeperZone: seed.keeper[i], goals: seed.got.filter((x) => x.outcome === 'GOAL').length, done: seed.got.length >= seed.cfg.kicks };
  } else {
    return { ok: false, message: 'This game has no steps.' };
  }
  const r = await db.query("UPDATE game_plays SET seed_json = ? WHERE id = ? AND status = 'STARTED' AND seed_json = ?", [JSON.stringify(seed), row.id, row.seed_json]);
  if (!r || !r.affectedRows) return { ok: false, retry: true, message: 'Tap once and wait a moment.' };
  return out;
}

async function settle(row, cfg, r) {
  const today = row.play_date || istDate();
  const prizes = row.kind === 'FREE' || (row.kind === 'PAID' && cfg.prizesOnPaidPlays);
  const result = { score: r.score, won: !!r.won, detail: r.detail || {}, wouldWin: { coins: Math.max(0, int(r.coins)), coupon: Math.max(0, int(r.coupon)) } };
  const upd = await db.query("UPDATE game_plays SET status = 'DONE', score = ?, result_json = ?, flagged = ?, finished_at = NOW() WHERE id = ? AND status = 'STARTED'",
    [int(r.score), JSON.stringify(result), r.flag ? s(r.flag).slice(0, 120) : null, row.id]);
  if (!upd || !upd.affectedRows) return { ok: false, already: true, message: 'This game has already finished.' };
  const out = { ok: true, kind: row.kind, score: result.score, won: result.won, detail: result.detail, coins: 0, coupon: null, practice: row.kind === 'PRACTICE', wouldWin: result.wouldWin };
  if (r.flag) { out.flagged = true; out.message = 'We couldn\'t count this game. Please play normally and try again.'; return out; }
  if (!prizes) return out;
  const name = (GAMES[row.game] || {}).name || row.game;
  const ph = row.phone_norm;
  if (result.wouldWin.coins > 0) {
    const g = await giveCoins(ph, row.id, result.wouldWin.coins, cfg, today, 'GAME_WIN', name);
    out.coins = g.coins; if (g.capped) out.capped = g.capped; if (g.balanceAfter != null) out.balance = Math.floor(g.balanceAfter);
  }
  if (result.wouldWin.coupon > 0) {
    const cp = await giveCoupon(ph, row.id, result.wouldWin.coupon, cfg, today, name);
    if (cp && cp.code) out.coupon = cp; else if (cp && cp.capped) out.couponCapped = cp.capped;
  }
  try { const st = await maybeStreakBonus(ph, today, cfg); if (st && st.coins) out.streakBonus = st; } catch (e) { console.log('[games] streak bonus failed:', e.message); }
  return out;
}

async function finish(phone, token, playId, input) {
  const cfg = await getSettings();
  const ph = norm(phone);
  const row = await loadPlay(ph, playId);
  if (!row) return { ok: false, message: 'Game not found — please start again.' };
  if (row.status !== 'STARTED') {
    let prev = {}; try { prev = JSON.parse(row.result_json || '{}'); } catch (_) {}
    return Object.assign({ ok: false, already: true, message: 'This game has already finished.' }, prev);
  }
  const elapsed = Date.now() - Number(row.started_ms || 0);
  if (elapsed > PLAY_TTL_MS) {
    await db.query("UPDATE game_plays SET status = 'EXPIRED', finished_at = NOW() WHERE id = ? AND status = 'STARTED'", [row.id]);
    return { ok: false, expired: true, message: 'This game took too long and has ended. Start a new one!' };
  }
  // A prize needs the same checks as at the start (the device token may have been removed meanwhile).
  if (row.kind !== 'PRACTICE' && cfg.requireVerify && !otpaccess.verifyToken(token, ph)) return { ok: false, needsVerify: true, message: 'Confirm it\'s you with the email code to collect your prize.' };
  const seed = JSON.parse(row.seed_json || '{}');
  let r;
  if (row.game === 'quiz' || row.game === 'emoji') r = scoreQuiz(seed);
  else if (row.game === 'popcorn') r = scorePopcorn(seed, input, elapsed);
  else if (row.game === 'cricket') r = scoreCricket(seed, input, elapsed);
  else if (row.game === 'yorker') r = scoreYorker(seed, input, elapsed);
  else if (row.game === 'penalty') r = scorePenalty(seed);
  else return { ok: false, message: 'This game finishes by itself.' };
  return settle(row, cfg, r);
}

async function sendCode(phone) {
  const cfg = await getSettings();
  return otpaccess.sendCode(phone, {
    tool: 'FluxFilm Games',
    eligible: async (ph) => (cfg.requirePaidOrder ? hasPaidOrder(ph) : true),
    notEligibleMessage: 'Games prizes are for FluxFilm customers — buy any plan first, then come back to play and win.',
  });
}

module.exports = {
  GAMES, GAME_KEYS, GLOBAL_FIELDS, COMMON_FIELDS, GAME_FIELDS, DEFAULT_SLICES,
  defaults, validateSettings, getSettings, saveSettings, schemaReady,
  getStatus, getHome, start, step, finish, sendCode,
  // pure rules (tests + admin previews)
  cricketBall, scoreCricket, yorkerBall, scoreYorker, penaltyKick, scorePenalty, scoreQuiz, scorePopcorn, pickSlice, ballTimeMs, istDate, addDays,
  CRICKET_SWEET, YORKER_TARGET, PENALTY_CENTRE,
  _internal: { resetCache: () => { cache = null; schemaOk = null; } },
};
