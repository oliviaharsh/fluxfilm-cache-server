/* 🔢 The count-up, RUN rather than read.
 *
 * Owner, 2 Oct 2026: *"numbers are still not animating as you can see in side panel also"*. They were not.
 * On the live page the glow was running and the figure read 4,807 before a two-second watch and 4,807 after
 * it. It had never counted — not slowly, not once.
 *
 * The bug: `shown` started AT the target and the effect returned early whenever `start === to`. TrustProof
 * renders nothing until the figures arrive, so the component only ever mounted with the final number already
 * in hand, which made that true on every single mount. The whole rolling branch was unreachable.
 *
 * WHY THREE TEST FILES MISSED IT, which matters more than the bug:
 *   · trust-scoreboard asserted on the SOURCE — regexes over index.html. It proved the easing and the frame
 *     loop were WRITTEN. It could not notice that they never ran.
 *   · trust-fold and trust-neon both hand the component `matchMedia: () => ({ matches: true })`, so both take
 *     the reduced-motion branch that simply sets the number and returns.
 * Three files over this code and not one of them ever executed it. A test that reads the source can only
 * ever tell you what somebody intended.
 *
 * So this one runs it: a fake clock, a fake frame loop, a fake timer, and a small React that honours an
 * effect's dependency array — because without that the effect re-fires on every render and the animation
 * restarts for ever, which would make the whole harness lie.
 *
 * 🔒 The fake never reads the real clock (CLAUDE.md, bought twice). Nothing here can pass or fail by the hour.
 *
 * Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = HTML.indexOf('function useCountUp(');
const b = HTML.indexOf('// A single rolling figure');
if (a < 0 || b < 0 || b < a) { console.log('CRASH: could not find useCountUp / useInSight in index.html'); process.exit(1); }
const SRC = HTML.slice(a, b);

// ── a clock that is ours, a frame loop that is ours ──────────────────────────────────────────────────────
let CLOCK = 1000;
const Date_ = { now: () => CLOCK };
let RID = 0;
const FRAMES = new Map();
const requestAnimationFrame = (fn) => { const id = ++RID; FRAMES.set(id, fn); return id; };
const cancelAnimationFrame = (id) => { FRAMES.delete(id); };
let TID = 0;
const TIMERS = new Map();
const setTimeout_ = (fn, ms) => { const id = ++TID; TIMERS.set(id, { fn, at: CLOCK + ms }); return id; };
const clearTimeout_ = (id) => { TIMERS.delete(id); };
let REDUCED = false;
const matchMedia = () => ({ matches: REDUCED });
/** Advance time by ms and run whatever was waiting for it. */
const tick = (ms) => {
  CLOCK += ms;
  const due = [...FRAMES.entries()];
  FRAMES.clear();
  due.forEach(([, fn]) => fn());
  [...TIMERS.entries()].forEach(([id, t]) => { if (t.at <= CLOCK) { TIMERS.delete(id); t.fn(); } });
};

// ── the smallest React that still honours a dependency array ─────────────────────────────────────────────
let CELLS, CI, EFFECTS, EI, PENDING;
const useState = (init) => {
  const i = CI++;
  if (!(i in CELLS)) CELLS[i] = typeof init === 'function' ? init() : init;
  return [CELLS[i], (v) => { CELLS[i] = typeof v === 'function' ? v(CELLS[i]) : v; }];
};
const useRef = (init) => { const i = CI++; if (!(i in CELLS)) CELLS[i] = { current: init }; return CELLS[i]; };
const useEffect = (fn, deps) => {
  const i = EI++;
  const prev = EFFECTS[i];
  // No deps array means "every render", same as React. With one, only a changed entry re-runs it — get this
  // wrong and the effect refires on every read, restarting the roll for ever and proving nothing.
  const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k]);
  EFFECTS[i] = { fn, deps, cleanup: prev ? prev.cleanup : null };
  if (changed) PENDING.push(i);
};

// IntersectionObserver, swappable: one that works, and none at all.
let OBSERVED = null;
class FakeIO {
  constructor(cb) { this.cb = cb; OBSERVED = this; }
  observe() {}
  disconnect() { this.gone = true; }
  /** The browser telling us the card is on screen. */
  enter() { this.cb([{ isIntersecting: true }]); }
  leave() { this.cb([{ isIntersecting: false }]); }
}

const build = (IO) => new Function('useState', 'useEffect', 'useRef', 'Date', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'IntersectionObserver',
  SRC + '\nreturn { useCountUp: useCountUp, useInSight: useInSight };')(
  useState, useEffect, useRef, Date_, matchMedia, requestAnimationFrame, cancelAnimationFrame,
  setTimeout_, clearTimeout_, IO);

/** A component that is nothing but one useCountUp, so the hook can be driven directly. */
function harness(IO) {
  const { useCountUp, useInSight } = build(IO);
  CELLS = {}; EFFECTS = {}; CI = 0; EI = 0; PENDING = []; FRAMES.clear(); TIMERS.clear();
  let out = null;
  const draw = (value, view) => {
    CI = 0; EI = 0; PENDING = [];
    out = useCountUp(value, view);
    PENDING.forEach((i) => {
      const e = EFFECTS[i];
      if (e.cleanup) e.cleanup();
      const c = e.fn();
      e.cleanup = typeof c === 'function' ? c : null;
    });
    return out;
  };
  return {
    draw,
    shown: () => out[0],
    bumped: () => out[1],
    frames: () => FRAMES.size,
    unmount: () => Object.values(EFFECTS).forEach((e) => { if (e.cleanup) e.cleanup(); }),
    useInSight,
  };
}

(async () => {
  // ── the regression itself ────────────────────────────────────────────────────────────────────────────────
  section('🔒 the bug: a figure that arrives already final must still count up');
  REDUCED = false;
  let h = harness(FakeIO);
  h.draw(4807, 0);
  ok('the very first paint shows the real figure, not a zero — if anything stops the effect, the number on '
    + 'screen is still right', h.shown() === 4807, h.shown());
  ok('🔒 …and a frame is queued: the roll is RUNNING. This is the assertion that was missing, and the reason '
    + 'the numbers sat still on the live site for a day', h.frames() === 1, { frames: h.frames() });

  tick(0);
  h.draw(4807, 0);
  ok('the first frame puts it back at the start of the climb', h.shown() === 0, h.shown());

  tick(550);
  h.draw(4807, 0);
  const mid = h.shown();
  ok('halfway it is somewhere in between, and moving', mid > 0 && mid < 4807, mid);

  let last = mid, backwards = false, over = false;
  for (let i = 0; i < 40; i++) { tick(50); h.draw(4807, 0); if (h.shown() < last) backwards = true; if (h.shown() > 4807) over = true; last = h.shown(); }
  ok('🔒 it never goes backwards and never overshoots — a trust figure may be dull but it may not be wrong',
    !backwards && !over, { backwards, over });
  ok('🔒 it lands EXACTLY on the figure, not on whatever the easing rounded to', h.shown() === 4807, h.shown());
  ok('…and then stops asking for frames', h.frames() === 0, h.frames());
  ok('arriving is not news, so it does not flash', h.bumped() === false);

  // ── a figure that moves while somebody is looking ────────────────────────────────────────────────────────
  section('somebody pays while the board is on screen');
  h.draw(4808, 0);
  ok('it carries on from where it was rather than dropping back to zero — the one thing worth showing is '
    + 'that it went UP', h.frames() === 1 && h.shown() === 4807, { frames: h.frames(), shown: h.shown() });
  // The flash is set INSIDE the effect, so it is only readable on the render that the set causes — same as
  // React. Reading it off the render that scheduled the effect would always say false.
  h.draw(4808, 0);
  ok('🔒 and THAT flashes, because it is news', h.bumped() === true);
  for (let i = 0; i < 30; i++) { tick(50); h.draw(4808, 0); }
  ok('it reaches the new figure', h.shown() === 4808, h.shown());
  tick(1500);
  h.draw(4808, 0);
  ok('the flash is brief, not permanent', h.bumped() === false);

  // ── scrolled away and back ───────────────────────────────────────────────────────────────────────────────
  section('the board comes back into sight');
  h.draw(4808, 1);
  ok('it counts up again from nothing', h.frames() === 1);
  tick(0); h.draw(4808, 1);
  ok('…from zero', h.shown() === 0, h.shown());
  ok('🔒 being looked at again is not news either, so no flash', h.bumped() === false);
  for (let i = 0; i < 40; i++) { tick(50); h.draw(4808, 1); }
  ok('and lands on the figure', h.shown() === 4808, h.shown());

  section('a redraw that changes nothing changes nothing');
  const before = h.shown();
  h.draw(4808, 1); h.draw(4808, 1); h.draw(4808, 1);
  ok('🔒 no new frames, no restart — otherwise the number would twitch on every poll for ever',
    h.frames() === 0 && h.shown() === before, { frames: h.frames(), shown: h.shown() });

  // ── the people who asked for stillness ───────────────────────────────────────────────────────────────────
  section('🔒 prefers-reduced-motion gets the number, not a performance');
  REDUCED = true;
  h = harness(FakeIO);
  h.draw(4807, 0);
  ok('no frames are ever asked for', h.frames() === 0, h.frames());
  h.draw(4807, 0);
  ok('and the figure is simply there, in full', h.shown() === 4807, h.shown());
  h.draw(4900, 0);
  h.draw(4900, 0);
  ok('a change lands too, still without animating', h.shown() === 4900 && h.frames() === 0, { shown: h.shown(), frames: h.frames() });
  REDUCED = false;

  // ── leaving the screen ───────────────────────────────────────────────────────────────────────────────────
  section('🔒 a board left behind is not still animating');
  h = harness(FakeIO);
  h.draw(4807, 0);
  tick(100);
  h.draw(4807, 0);
  ok('mid-roll there is a frame pending', h.frames() === 1);
  h.unmount();
  ok('unmounting cancels it', h.frames() === 0, h.frames());
  h.draw(5000, 0);
  h.unmount();
  ok('…and cancels the flash timer too, so nothing fires into a screen that has gone', TIMERS.size === 0, TIMERS.size);

  // ── the watcher ──────────────────────────────────────────────────────────────────────────────────────────
  section('the board notices when it is looked at');
  {
    const g = harness(FakeIO);
    CELLS = {}; EFFECTS = {}; CI = 0; EI = 0; PENDING = [];
    const ref = { current: { tag: 'the card' } };
    const run = () => {
      CI = 0; EI = 0; PENDING = [];
      const n = g.useInSight(ref, true);
      PENDING.forEach((i) => { const e = EFFECTS[i]; if (e.cleanup) e.cleanup(); const c = e.fn(); e.cleanup = typeof c === 'function' ? c : null; });
      return n;
    };
    ok('nothing has been seen yet', run() === 0);
    OBSERVED.enter();
    ok('coming into sight counts', run() === 1);
    OBSERVED.leave();
    ok('🔒 leaving does NOT count, or the figures would re-roll on the way past', run() === 1);
    OBSERVED.enter();
    ok('coming back counts again', run() === 2);
  }

  section('🔒 the card does not exist on the first render, and the watcher has to wait for it');
  {
    // THE SECOND BUG — and the first version of this test could not see it, because it handed the hook a ref
    // that was already full. The real first render has an EMPTY one: TrustProof draws nothing until the
    // figures arrive. With [] for dependencies the effect ran exactly then, took its early exit, and never
    // ran again, so the observer was never created on any page, ever. Found by reading the code; the browser
    // could not have shown it, because a hidden pane fires no intersection callbacks at all.
    const g = harness(FakeIO);
    CELLS = {}; EFFECTS = {}; CI = 0; EI = 0; PENDING = [];
    OBSERVED = null;
    const ref = { current: null };
    const run = (ready) => {
      CI = 0; EI = 0; PENDING = [];
      const n = g.useInSight(ref, ready);
      PENDING.forEach((i) => { const e = EFFECTS[i]; if (e.cleanup) e.cleanup(); const c = e.fn(); e.cleanup = typeof c === 'function' ? c : null; });
      return n;
    };
    ok('first render, no figures, no card: there is nothing to observe yet',
      run(false) === 0 && OBSERVED === null, { observed: !!OBSERVED });
    ref.current = { tag: 'the card, now drawn' };
    run(true);
    ok('🔒 and when the card is finally on the page, the watcher attaches to it', OBSERVED !== null, { observed: !!OBSERVED });
    OBSERVED.enter();
    ok('…and counts from then on', run(true) === 1);
  }

  section('🔒 a browser with no IntersectionObserver still works');
  {
    const g = harness(undefined);
    CELLS = {}; EFFECTS = {}; CI = 0; EI = 0; PENDING = [];
    const ref = { current: {} };
    let threw = false, n = -1;
    try {
      CI = 0; EI = 0; PENDING = [];
      n = g.useInSight(ref, true);
      PENDING.forEach((i) => { const e = EFFECTS[i]; const c = e.fn(); e.cleanup = typeof c === 'function' ? c : null; });
    } catch (e) { threw = true; }
    ok('it does not throw', !threw);
    ok('…it just never counts, and the figures sit there reading correctly', n === 0, n);
  }
  {
    // A ref that has not been attached to anything yet, which is every first render.
    const g = harness(FakeIO);
    CELLS = {}; EFFECTS = {}; CI = 0; EI = 0; PENDING = [];
    let threw = false;
    try {
      CI = 0; EI = 0; PENDING = [];
      g.useInSight({ current: null }, true);
      PENDING.forEach((i) => { const e = EFFECTS[i]; const c = e.fn(); e.cleanup = typeof c === 'function' ? c : null; });
    } catch (e) { threw = true; }
    ok('🔒 an empty ref does not throw either', !threw);
  }

  // ── wiring ───────────────────────────────────────────────────────────────────────────────────────────────
  section('it is actually wired into the board');
  ok('TrustProof watches its own card', /const card = useRef\(null\);/.test(HTML) && /const view = useInSight\(card, !!t\)/.test(HTML));
  ok('🔒 …and the watcher is told WHEN the card exists, or it attaches to nothing and never retries',
    /function useInSight\(ref, ready\)/.test(HTML) && /\}, \[ready\]\);/.test(HTML));
  ok('🔒 and the ref is on a real element — Card is a plain function and cannot hold one',
    /const watched = el => React\.createElement\("div", \{\s*ref: card\s*\}, el\)/.test(HTML));
  ok('both shapes of the board are watched, including the dashboard fold',
    (HTML.match(/watched\(React\.createElement\(Card, \{/g) || []).length === 2,
    (HTML.match(/watched\(React\.createElement\(Card, \{/g) || []).length);
  ok('every figure is handed the counter', (HTML.match(/view: view/g) || []).length === 4,
    (HTML.match(/view: view/g) || []).length);
  ok('package.json runs this test', /node test\/trust-countup\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  section('the page still runs');
  let parsed = true, n = 0;
  for (const m of HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1].trim()) continue;
    n++;
    try { new Function(m[1]); } catch (e) { parsed = false; console.log('   parse error: ' + e.message); }
  }
  ok('every inline <script> parses', parsed && n > 0, { blocks: n });

  console.log('\n---------------------------------------');
  console.log('trust-countup: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
