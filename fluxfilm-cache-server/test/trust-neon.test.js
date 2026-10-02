/* 🟢 The trust section as a live scoreboard: neon figures, a typing ticker, flickering status lights.
 *
 * Owner, 2 Oct 2026: "can you animate the numbers every moment, also when we click see - animate the 3 bullet
 * points and just now on fluxfilm like typwriter, flicker the green color points and each subs wise numbers,
 * also show them in neon the 5000 orders, 1438 served besides hide".
 *
 * None of this carries information — every figure is already written out in plain text underneath it. That is
 * the thing most worth protecting here, and most of the locked tests below are about it: switch every
 * animation off and the section must still say exactly the same thing, in full. An animation that is the only
 * way to read a number is not decoration any more, it is a requirement, and this section is shown to people on
 * three-year-old phones who have asked them to stop moving.
 *
 * The real index.html source, run against a small fake React. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = HTML.slice(HTML.indexOf('<style'), HTML.indexOf('</style>'));
// Same slice the other two trust tests take: from the count-up helper, which ScoreNum and ScoreBit need.
const a = HTML.indexOf('function useCountUp(');
const b = HTML.indexOf('// \u{2B50} Reviews (reviews.js).');
if (a < 0 || b < 0 || b < a) { console.log('CRASH: could not find the trust block in index.html'); process.exit(1); }
const SRC = HTML.slice(a, b);

// ── the smallest React these components use ───────────────────────────────────────────────────────────────
let HOOKS, HOOK_I, EFFECTS, STORAGE_THROWS;
const useState = (init) => {
  const i = HOOK_I++;
  if (!(i in HOOKS)) HOOKS[i] = typeof init === 'function' ? init() : init;
  return [HOOKS[i], (v) => { HOOKS[i] = typeof v === 'function' ? v(HOOKS[i]) : v; }];
};
const useEffect = (fn) => { EFFECTS.push(fn); };
const REFS = [];
let REF_I = 0;
const useRef = (init) => { const i = REF_I++; if (!(i in REFS)) REFS[i] = { current: init }; return REFS[i]; };
// The roll-up is trust-scoreboard's subject, not this one's: tell it there is no motion to run so it simply
// sets each figure, and what is left to look at here is the dressing.
const matchMedia = () => ({ matches: true });
const requestAnimationFrame = () => 0;
const cancelAnimationFrame = () => {};

/** The rendered tree, flattened to its text and to every element a human would see. */
const flat = (n, out) => {
  out = out || { text: '', nodes: [], clicks: [] };
  if (n == null || n === false) return out;
  if (Array.isArray(n)) { n.forEach((x) => flat(x, out)); return out; }
  if (typeof n !== 'object') { out.text += String(n); return out; }
  if (n.props) {
    out.nodes.push(n.props);
    if (n.props.onClick) out.clicks.push(n.props.onClick);
    if (typeof n.type === 'function') { flat(n.type(n.props), out); return out; }
    flat(n.props.children, out);
  }
  return out;
};
/** Every rendered element carrying this class. */
const withClass = (r, c) => r.nodes.filter((p) => String(p.className || '').split(' ').indexOf(c) >= 0);

const React = { createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props, { children }) }) };
const C = { text: '#0f172a', muted: '#64748b', subtle: '#94a3b8', border: 'x', chip: 'y', green: 'g', green2: 'g2', amber: 'a' };
const PJS = 'font';
const R = { badge: 999 };
const Card = 'Card';
const localStorage = {
  _v: {},
  getItem(k) { if (STORAGE_THROWS) throw new Error('blocked'); return k in this._v ? this._v[k] : null; },
  setItem(k, v) { if (STORAGE_THROWS) throw new Error('blocked'); this._v[k] = String(v); },
};
let API_REPLY;
const API = { getTrust: (okFn) => { okFn(API_REPLY); } };
const setInterval = () => 0, clearInterval = () => {};

const make = new Function('React', 'useState', 'useEffect', 'useRef', 'C', 'PJS', 'R', 'Card', 'API',
  'localStorage', 'setInterval', 'clearInterval', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
  SRC + '\nreturn TrustProof;')(React, useState, useEffect, useRef, C, PJS, R, Card, API,
  localStorage, setInterval, clearInterval, matchMedia, requestAnimationFrame, cancelAnimationFrame);

const DATA = {
  ok: true, on: true, since: '2022',
  totals: { orders: 4806, customers: 1438, recurring: 884, renewals: 1825, recurringPct: 61 },
  live: { running: 186, renewals: 349, customersWithPlan: 123, comeBackPct: 61 },
  services: [{ service: 'Netflix', n: 49 }, { service: 'Prime', n: 31 }],
  recent: [
    { service: 'Netflix', plan: '1M', kind: 'renewed', ago: '4 min ago' },
    { service: 'Prime', plan: '3M', kind: 'bought', ago: '18 min ago' },
    { service: 'Hotstar', plan: '', kind: 'bought', ago: '1 hr ago' },
  ],
  journey: [],
};

function render(props) {
  HOOKS = {}; EFFECTS = []; HOOK_I = 0; REFS.length = 0; REF_I = 0;
  make(props || {});
  EFFECTS.forEach((fn) => { const c = fn(); if (typeof c === 'function') c(); });
  HOOK_I = 0; REF_I = 0;
  return flat(make(props || {}));
}

(async () => {
  API_REPLY = DATA; STORAGE_THROWS = false;
  localStorage._v = {};
  const open = render({});

  // ── the point of all of it ───────────────────────────────────────────────────────────────────────────────
  section('🔒 every figure is readable with the animation switched off');
  ok('the words and the numbers are in the text, not in the motion',
    /4,806/.test(open.text) && /orders delivered/.test(open.text) && /1,438/.test(open.text)
    && /customers served/.test(open.text) && /Someone renewed/.test(open.text) && /Netflix/.test(open.text)
    && /49/.test(open.text) && /plans running right now/.test(open.text), open.text.slice(0, 200));
  ok('🔒 reduced motion switches the lot off with !important — the per-line timings are INLINE, and an '
    + 'inline style beats an ordinary rule, so without it somebody who asked for stillness still gets typing',
    /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.ff-ts-neon, \.ff-ts-dot, \.ff-ts-typed, \.ff-ts-bullet \{ animation: none !important; \}/.test(CSS),
    (CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[^}]*ff-ts[^}]*\}/) || ['none'])[0]);
  ok('🔒 and the caret is hidden rather than frozen mid-line', /\.ff-ts-caret \{ display: none; \}/.test(CSS));
  ok('🔒 the RESTING state is the finished state: nothing is hidden outside a keyframe, so stopping the '
    + 'animation leaves the section complete rather than blank',
    !/\.ff-ts-typed \{[^}]*clip-path/.test(CSS) && !/\.ff-ts-bullet \{[^}]*opacity: 0/.test(CSS)
    && /\.ff-ts-caret \{[^}]*opacity: 0/.test(CSS),
    (CSS.match(/\.ff-ts-typed \{[^}]*\}/) || [''])[0] + ' | ' + (CSS.match(/\.ff-ts-bullet \{[^}]*\}/) || [''])[0]);

  // ── neon ─────────────────────────────────────────────────────────────────────────────────────────────────
  section('neon, and it breathes rather than sitting still');
  ok('the glow is a loop, not a one-off', /@keyframes ffTsGlow \{/.test(CSS) && /\.ff-ts-neon \{ animation: ffTsGlow [\d.]+s ease-in-out infinite; \}/.test(CSS));
  ok('🔒 the faster burn is defined AFTER the glow, or it would never win and a change would never show',
    CSS.indexOf('.ff-ts-hot {') > CSS.indexOf('.ff-ts-neon {'), { hot: CSS.indexOf('.ff-ts-hot {'), neon: CSS.indexOf('.ff-ts-neon {') });
  ok('…and it only changes the speed, so the glow does not jump when a figure moves',
    /\.ff-ts-hot \{ animation-duration: \.5s; \}/.test(CSS));
  ok('all three headline figures glow', withClass(open, 'ff-ts-neon').length >= 3, withClass(open, 'ff-ts-neon').length);
  ok('a figure that has not moved is not burning', withClass(open, 'ff-ts-hot').length === 0);

  section('the folded line: the two numbers in neon, beside Hide');
  localStorage._v = {};
  const shut = render({ fold: true });
  ok('it still reads as a sentence', /4,806 orders/.test(shut.text) && /1,438 customers served/.test(shut.text) && /See ▾/.test(shut.text), shut.text);
  ok('and both numbers are lit', withClass(shut, 'ff-ts-neon').length === 2, withClass(shut, 'ff-ts-neon').map((p) => p.children));

  // ── the ticker ───────────────────────────────────────────────────────────────────────────────────────────
  section('Just now on FluxFilm types itself on');
  const typed = withClass(open, 'ff-ts-typed');
  const carets = withClass(open, 'ff-ts-caret');
  ok('one typed line and one caret per event', typed.length === 3 && carets.length === 3, { typed: typed.length, carets: carets.length });
  ok('it reveals by clipping, which cannot reflow the row while it writes',
    /@keyframes ffTsType \{ from \{ clip-path: inset\(0 100% 0 0\); \} to \{ clip-path: inset\(0 0 0 0\); \} \}/.test(CSS));
  ok('🔒 the caret and its line share ONE timing string — two timings drift apart and the caret ends up '
    + 'somewhere the text is not',
    typed.every((p, i) => String(p.style.animation).replace('ffTsType', '') === String(carets[i].style.animation).replace('ffTsRun', '')),
    typed.map((p, i) => [p.style.animation, carets[i].style.animation]));
  ok('it is stepped, like keys, not a smooth wipe', typed.every((p) => /steps\(\d+, end\)/.test(p.style.animation)), typed.map((p) => p.style.animation));
  ok('a longer line takes longer to type than a short one',
    parseFloat(typed[1].style.animation.split(' ')[1]) > parseFloat(typed[2].style.animation.split(' ')[1]),
    typed.map((p) => p.style.animation));
  const delayOf = (s) => parseFloat((String(s).match(/\) ([\d.]+)s both$/) || [0, 'x'])[1]);
  ok('each line waits its turn', typed.map((p) => delayOf(p.style.animation)).every((d, i, arr) => i === 0 ? d === 0 : d > arr[i - 1]),
    typed.map((p) => p.style.animation));
  ok('🔒 the caret leaves when the line is finished, rather than four of them blinking at once',
    /@keyframes ffTsRun \{[\s\S]*?100% \{ left: 100%; opacity: 0; \}/.test(CSS));
  ok('🔒 a row is keyed by what it SAYS, so a new event types itself on and an unchanged one is left alone '
    + 'instead of being replayed every minute',
    /key: x\.service \+ '\|' \+ x\.kind \+ '\|' \+ x\.ago \+ '\|' \+ i/.test(HTML));

  section('the green points flicker');
  const dots = withClass(open, 'ff-ts-dot');
  ok('every event has one', dots.length === 3, dots.length);
  ok('it is a status light, not a pulse: mostly steady with a stutter', /@keyframes ffTsFlick \{ 0%, 6%, 13%, 60%, 100% \{ opacity: 1;/.test(CSS));
  ok('…and it glows', /\.ff-ts-dot \{ box-shadow: 0 0 5px rgba\(34,197,94,\.85\)/.test(CSS));
  ok('🔒 each on its own beat, or four dots blinking together read as one thing rather than four',
    new Set(dots.map((p) => p.style.animationDelay)).size === 3, dots.map((p) => p.style.animationDelay));

  section('the three bullets arrive in turn');
  const bullets = withClass(open, 'ff-ts-bullet');
  ok('all three are there', bullets.length === 3, bullets.length);
  ok('one after another', bullets.map((p) => parseFloat(p.style.animationDelay)).every((d, i, arr) => i === 0 ? d === 0 : d > arr[i - 1]),
    bullets.map((p) => p.style.animationDelay));
  ok('🔒 keyed by their words, so a bullet whose number changed arrives again and the other two do not',
    /key: x,\s*className: "ff-ts-bullet"/.test(HTML));
  ok('they slide in and are not left transparent', /@keyframes ffTsBul \{ from \{ opacity: 0; transform: translateY\(6px\); \} to \{ opacity: 1; transform: none; \} \}/.test(CSS));

  section('each service count rolls and glows');
  ok('the badge count is its own rolling figure', /function ScoreBit\(/.test(HTML) && /React\.createElement\(ScoreBit, \{\s*value: sv\.n,\s*view: view\s*\}\)/.test(HTML));
  ok('both badges are drawn, with their counts', /Netflix/.test(open.text) && /49/.test(open.text) && /Prime/.test(open.text) && /31/.test(open.text));
  ok('🔒 digits are tabular here too, so a rolling count cannot make the badge change width',
    /function ScoreBit\(\{[\s\S]{0,420}fontVariantNumeric: 'tabular-nums'/.test(HTML));

  // ── the stylesheet is whole ──────────────────────────────────────────────────────────────────────────────
  section('nothing refers to an animation that does not exist');
  const used = new Set([...HTML.matchAll(/animation: (ffTs[A-Za-z]+)/g)].map((m) => m[1]));
  used.add('ffTsType'); used.add('ffTsRun');
  const missing = [...used].filter((k) => CSS.indexOf('@keyframes ' + k + ' {') < 0);
  ok('every ffTs… animation named is defined', missing.length === 0, missing);
  ok('package.json runs this test', /node test\/trust-neon\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  section('the page still runs');
  let parsed = true, n = 0;
  for (const m of HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1].trim()) continue;
    n++;
    try { new Function(m[1]); } catch (e) { parsed = false; console.log('   parse error: ' + e.message); }
  }
  ok('every inline <script> parses', parsed && n > 0, { blocks: n });

  console.log('\n---------------------------------------');
  console.log('trust-neon: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
