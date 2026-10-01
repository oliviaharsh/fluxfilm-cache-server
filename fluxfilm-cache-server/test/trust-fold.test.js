/* 📂 The trust block folds away for people who are already customers.
 *
 * Owner, 2 Oct 2026: "can you make it a drop down when customer is already logged in because otherwise now it
 * has become a big page".
 *
 * The rule, and the reason it is a rule and not a preference: a visitor on the landing page has not bought yet
 * and is exactly who the numbers are for, so there it stays open. Somebody logged in has nothing left to be
 * convinced of and came for their plans, so there it is one line they can open if they care.
 *
 * The real TrustProof source, lifted out of index.html and run against a small fake React. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = HTML.indexOf('function TrustProof(');
const b = HTML.indexOf('// ⭐ Reviews (reviews.js).');
if (a < 0 || b < 0 || b < a) { console.log('CRASH: could not find TrustProof in index.html'); process.exit(1); }
const SRC = HTML.slice(a, b);

// ── the smallest React these components use ───────────────────────────────────────────────────────────────
let HOOKS, HOOK_I, EFFECTS, STORE, STORAGE_THROWS;
const useState = (init) => {
  const i = HOOK_I++;
  if (!(i in HOOKS)) HOOKS[i] = typeof init === 'function' ? init() : init;
  return [HOOKS[i], (v) => { HOOKS[i] = typeof v === 'function' ? v(HOOKS[i]) : v; }];
};
const useEffect = (fn) => { EFFECTS.push(fn); };
/** A rendered tree flattened to the text and the props a human would notice. */
const flat = (n, out) => {
  out = out || { text: '', clicks: [], props: [] };
  if (n == null || n === false) return out;
  if (Array.isArray(n)) { n.forEach((x) => flat(x, out)); return out; }
  if (typeof n !== 'object') { out.text += String(n); return out; }
  if (n.props) {
    out.props.push(n.props);
    if (n.props.onClick) out.clicks.push(n.props.onClick);
    flat(n.props.children, out);
  }
  return out;
};
const React = {
  createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props, { children }) }),
};
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

const make = new Function('React', 'useState', 'useEffect', 'C', 'PJS', 'R', 'Card', 'API', 'localStorage', 'setInterval', 'clearInterval',
  SRC + '\nreturn TrustProof;')(React, useState, useEffect, C, PJS, R, Card, API, localStorage, setInterval, clearInterval);

const DATA = {
  ok: true, on: true, since: '2022',
  totals: { orders: 5000, customers: 1438, recurring: 884, renewals: 1825, recurringPct: 61 },
  live: { running: 186, renewals: 349, customersWithPlan: 123, comeBackPct: 61 },
  services: [{ service: 'Netflix', n: 49 }], recent: [{ service: 'Netflix', plan: '1M', kind: 'renewed', ago: '4 min ago' }], journey: [],
};

/** Render once, run the effects (which load the data), render again. */
function render(props) {
  HOOKS = {}; EFFECTS = []; HOOK_I = 0;
  make(props || {});
  EFFECTS.forEach((fn) => { const c = fn(); if (typeof c === 'function') c(); });
  HOOK_I = 0;
  return flat(make(props || {}));
}

(async () => {
  API_REPLY = DATA; STORAGE_THROWS = false;

  section('logged out, on the landing page: the numbers are the whole point');
  localStorage._v = {};
  let r = render({});
  ok('everything is shown', /5,000/.test(r.text) && /orders delivered/.test(r.text) && /1,438/.test(r.text)
    && /Just now on FluxFilm/.test(r.text) && /Netflix/.test(r.text), r.text.slice(0, 160));
  ok('🔒 and there is nothing to tap open — a visitor must not have to ask for the reason to trust us',
    !/See ▾/.test(r.text) && !/Hide ▴/.test(r.text), r.text.slice(0, 120));

  section('logged in, on the dashboard: one line');
  localStorage._v = {};
  r = render({ fold: true });
  ok('it is collapsed by default', /See ▾/.test(r.text) && !/Just now on FluxFilm/.test(r.text), r.text);
  ok('🔒 but the line still SAYS the two numbers — a summary, not a mystery box',
    /5,000 orders/.test(r.text) && /1,438 customers served/.test(r.text), r.text);
  ok('it is a real button a screen reader can use', r.props.some((p) => p.type === 'button' || p['aria-expanded'] === 'false'), r.props.filter((p) => p['aria-expanded']));

  section('opening it');
  localStorage._v = { ff_trust_open: '1' };
  r = render({ fold: true });
  ok('a device that opened it before gets it open', /Just now on FluxFilm/.test(r.text) && /Hide ▴/.test(r.text));
  ok('…and the summary line stays on top, so it can be closed again', r.text.indexOf('5,000 orders') < r.text.indexOf('orders delivered'), r.text.slice(0, 200));

  section('the choice is remembered');
  localStorage._v = {};
  HOOKS = {}; EFFECTS = []; HOOK_I = 0;
  make({ fold: true });
  EFFECTS.forEach((fn) => fn());
  HOOK_I = 0;
  let tree = flat(make({ fold: true }));
  tree.clicks[0]();
  ok('tapping it writes the choice down', localStorage._v.ff_trust_open === '1', localStorage._v);
  HOOK_I = 0;
  tree = flat(make({ fold: true }));
  ok('…and it is now open', /Just now on FluxFilm/.test(tree.text));
  tree.clicks[0]();
  ok('tapping again closes it and remembers that too', localStorage._v.ff_trust_open === '0', localStorage._v);

  section('🔒 a private window must not break the screen');
  STORAGE_THROWS = true;
  localStorage._v = {};
  let threw = false;
  try { r = render({ fold: true }); } catch (e) { threw = true; }
  ok('reading the stored choice throws → still renders', !threw && /See ▾/.test(r.text), threw);
  threw = false;
  try { r.clicks[0](); } catch (e) { threw = true; }
  ok('writing it throws → the tap still works, it just is not remembered', !threw);
  STORAGE_THROWS = false;

  section('nothing to show, nothing drawn');
  API_REPLY = { ok: true, on: false };
  ok('section off → nothing, folded or not', render({ fold: true }).text === '' && render({}).text === '');
  API_REPLY = DATA;

  section('the code');
  ok('the landing page does NOT fold', /React\.createElement\(TrustProof, null\)/.test(HTML));
  ok('🔒 the dashboard does', /React\.createElement\(TrustProof, \{\s*fold: true\s*\}\)/.test(HTML));
  ok('every localStorage touch is guarded', (HTML.match(/localStorage\.(get|set)Item\('ff_trust_open'/g) || []).length === 2
    && /try \{[\s\S]{0,120}ff_trust_open[\s\S]{0,120}catch/.test(HTML));
  ok('package.json runs this test', /node test\/trust-fold\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  console.log('\n---------------------------------------');
  console.log('trust-fold: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
