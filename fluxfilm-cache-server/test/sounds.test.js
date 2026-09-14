/* Sounds + vibration: storefront ffSound module, event wiring, Account switches, admin new-order bell.
   Runs the browser code against a fake AudioContext. No browser needed. Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const inline = (h) => [...h.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());

section('parse');
for (const [name, h] of [['index.html', html], ['admin.html', admin]]) {
  let parsed = true;
  for (const s of inline(h)) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', name, e.message); } }
  ok(name + ': every inline script parses', parsed);
}
const storeScript = inline(html).find((s) => /window\.ffSound = play/.test(s));
const bellScript = inline(admin).find((s) => /window\.ffBell = /.test(s));
ok('store sound module is its own script in <head>', storeScript && html.indexOf(storeScript) < html.indexOf('</head>') && !/ff-lite|ff-splash|React/.test(storeScript));
ok('admin bell is its own script in <head>', bellScript && admin.indexOf(bellScript) < admin.indexOf('</head>'));
ok('no audio files, no new requests', !/\.(mp3|wav|ogg|m4a)\b/.test(storeScript + bellScript) && !/fetch\(|XMLHttpRequest|https?:/.test(storeScript + bellScript));
const pkg = require('../package.json');
ok('no new npm dependency', Object.keys(pkg.dependencies).sort().join() === 'cors,dotenv,express,imapflow,mailparser,mysql2,nodemailer');
ok('test suite is in npm test', /node test\/sounds\.test\.js/.test(pkg.scripts.test));

// ---- fake Web Audio ----
function fakeAudio(opts) {
  opts = opts || {};
  const A = { made: 0, oscs: [], sources: [], gains: [], resumed: 0 };
  class Param { constructor(v) { this.value = v; this.events = []; } setValueAtTime(v, t) { this.events.push(['set', v, t]); } exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); } }
  class Node { connect(n) { (this.to = this.to || []).push(n); return n; } }
  class Ctx {
    constructor() { if (opts.ctorThrows) throw new Error('no audio'); A.made++; A.ctx = this; this.state = opts.startState || 'running'; this.currentTime = 10; this.sampleRate = 8000; this.destination = new Node(); }
    resume() { A.resumed++; if (opts.resumeWorks !== false) this.state = 'running'; return Promise.resolve(); }
    createGain() { const g = new Node(); g.gain = new Param(1); A.gains.push(g); return g; }
    createDelay() { const d = new Node(); d.delayTime = new Param(0); return d; }
    createBiquadFilter() { const f = new Node(); f.frequency = new Param(0); return f; }
    createOscillator() { const o = new Node(); o.frequency = new Param(440); o.start = (t) => { o.t0 = t; }; o.stop = (t) => { o.t1 = t; }; A.oscs.push(o); return o; }
    createBuffer(ch, len) { const d = new Float32Array(len); return { getChannelData: () => d }; }
    createBufferSource() { const s = new Node(); s.start = (t) => { s.t0 = t; }; A.sources.push(s); return s; }
  }
  A.Ctx = Ctx;
  return A;
}
function mkStorage(throwing, init) {
  const m = Object.assign({}, init || {});
  return throwing ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m };
}
function runStore(o) {
  o = o || {};
  const A = fakeAudio(o.audio);
  const listeners = {};
  const vib = [];
  const window = { addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); } };
  if (!o.noAudio) window.AudioContext = A.Ctx;
  const document = { hidden: false };
  const navigator = o.noVibrate ? {} : { vibrate: (p) => { vib.push(p); return true; } };
  const localStorage = mkStorage(o.storageThrows, o.prefs);
  const sessionStorage = mkStorage(o.storageThrows);
  new Function('window', 'document', 'navigator', 'localStorage', 'sessionStorage', storeScript)(window, document, navigator, localStorage, sessionStorage);
  const fire = (k, e) => (listeners[k] || []).forEach((f) => f(Object.assign({ type: k }, e || {})));
  return { A, window, document, vib, fire, localStorage, sessionStorage, listeners };
}
const span = (A, from) => { const os = A.oscs.slice(from || 0); if (!os.length) return 0; return Math.max(...os.map((x) => x.t1)) - Math.min(...os.map((x) => x.t0)); };

section('store: autoplay rules');
let W = runStore();
ok('no AudioContext before any tap (no autoplay warning)', W.A.made === 0);
ok('a sound before the first tap is skipped silently', W.window.ffSound('delivered') === false && W.A.oscs.length === 0);
ok('unlock listens to pointerdown / touchend / keydown (capture)', ['pointerdown', 'touchend', 'keydown'].every((k) => W.listeners[k] && W.listeners[k].length === 1));
W.fire('pointerdown', { target: { closest: () => ({}) } });
ok('first tap creates one AudioContext', W.A.made === 1);
W.fire('touchend'); W.fire('keydown');
ok('more taps reuse it', W.A.made === 1);
ok('master volume is quiet (0.35)', W.A.gains[0].gain.value === 0.35);
ok('tap sound is OFF by default', W.A.oscs.length === 0);

section('store: sounds');
const NAMES = ['delivered', 'paid', 'coupon', 'coins', 'copy', 'error', 'tap'];
for (const n of NAMES) {
  const from = W.A.oscs.length;
  const played = W.window.ffSound(n);
  ok(n + ': plays, ≤ 1.2 s', played === true && W.A.oscs.length > from && span(W.A, from) <= 1.2, [played, span(W.A, from)]);
}
ok('delivered is the richest (4-note chime + sparkle)', (() => { const from = W.A.oscs.length; W.window.ffSound('delivered'); return W.A.oscs.length - from >= 12; })());
ok('gain envelopes never jump straight to full volume (no clicks)', W.A.gains.slice(3).every((g) => !g.gain.events.length || (g.gain.events[0][0] === 'set' && g.gain.events[0][1] <= 0.001)));
ok('unknown sound name: false, no throw', W.window.ffSound('nope') === false);
W.document.hidden = true;
let before = W.A.oscs.length;
ok('page hidden: skipped (sound + vibration)', W.window.ffSound('delivered') === false && W.A.oscs.length === before);
W.document.hidden = false;

section('store: vibration');
W.vib.length = 0;
W.window.ffSound('delivered'); W.window.ffSound('error'); W.window.ffSound('copy');
ok('delivered [30,60,30], error [60], copy none', JSON.stringify(W.vib) === JSON.stringify([[30, 60, 30], [60]]), W.vib);
W = runStore({ prefs: { ff_vibe: '0' } }); W.fire('pointerdown');
W.window.ffSound('delivered');
ok('vibration switched off → no buzz, sound still plays', W.vib.length === 0 && W.A.oscs.length > 0);
W = runStore({ noVibrate: true }); W.fire('pointerdown');
ok('no navigator.vibrate (iPhone/desktop) → no-op', W.window.ffSound('error') === true);

section('store: preferences');
W = runStore({ prefs: { ff_sound: '0' } }); W.fire('pointerdown');
ok('sounds switched off → silent but vibration still works', W.window.ffSound('delivered') === false && W.A.oscs.length === 0 && W.vib.length === 1);
ok('preview can force a sound while turning it on', W.window.ffSound('coupon', { force: true }) === true);
ok('defaults: sound ON, vibration ON, tap OFF', (() => { const X = runStore(); return X.window.ffSoundPrefs.get('sound') && X.window.ffSoundPrefs.get('vibe') && !X.window.ffSoundPrefs.get('tap'); })());
W = runStore(); W.window.ffSoundPrefs.set('sound', false);
ok('set() stores "0"/"1" in localStorage', W.localStorage.m.ff_sound === '0');
W = runStore({ prefs: { ff_sound_tap: '1' } }); W.fire('pointerdown', { target: { closest: (s) => (s === 'button' ? {} : null) } });
ok('tap sound when enabled plays on button taps only', W.A.oscs.length === 1);
W.fire('touchend', { target: { closest: () => ({}) } });
ok('…once per tap (not again on touchend)', W.A.oscs.length === 1);
W = runStore({ storageThrows: true });
ok('storage blocked: defaults, set() does not throw', W.window.ffSoundPrefs.get('sound') === true && (() => { try { W.window.ffSoundPrefs.set('sound', false); return true; } catch (e) { return false; } })());
W.fire('pointerdown');
ok('storage blocked: sounds still play', W.window.ffSoundOnce('delivered', 'FF1') === true);

section('store: once per order');
W = runStore(); W.fire('pointerdown');
ok('delivered plays the first time for an order', W.window.ffSoundOnce('delivered', 'FF100') === true);
before = W.A.oscs.length;
ok('…not again for the same order (re-render / back)', W.window.ffSoundOnce('delivered', 'FF100') === false && W.A.oscs.length === before);
ok('…but does for another order', W.window.ffSoundOnce('delivered', 'FF101') === true);
ok('paid and delivered are tracked separately', W.window.ffSoundOnce('paid', 'FF100') === true);

section('store: audio unavailable / blocked');
W = runStore({ noAudio: true });
ok('no Web Audio: tap + play never throw', (() => { try { W.fire('pointerdown'); return W.window.ffSound('delivered') === false; } catch (e) { return false; } })());
W = runStore({ audio: { ctorThrows: true } });
ok('AudioContext constructor throws: silent', (() => { try { W.fire('pointerdown'); return W.window.ffSound('error') === false; } catch (e) { return false; } })());
(async () => {
  W = runStore({ audio: { startState: 'suspended', resumeWorks: false } }); W.fire('pointerdown');
  ok('context cannot start: skipped (false), resume attempted', W.window.ffSound('delivered') === false && W.A.resumed >= 1);
  await new Promise((r) => setImmediate(r));
  ok('…and nothing plays later', W.A.oscs.length === 0);
  W = runStore({ audio: { startState: 'suspended' } }); W.fire('pointerdown'); W.A.ctx.state = 'suspended';
  W.window.ffSound('coupon', { force: true });
  await new Promise((r) => setImmediate(r));
  ok('context resumes a moment later: the sound still plays (switch preview)', W.A.oscs.length > 0);

  section('store: wiring');
  const fnSrc = (name, next) => html.slice(html.indexOf('function ' + name + '({'), html.indexOf('function ' + next + '({'));
  const verify = fnSrc('VerifyScreen', 'RenewStartScreen');
  ok('goToDone passes the order id for the delivered chime', /found: true,\n\s*_soundOid: orderId/.test(verify));
  ok('payment verified screen → paid (once per order)', /if \(phase === 'found'\) window\.ffSoundOnce\?\.\('paid', orderId\)/.test(verify));
  ok('3-minute timeout (payment not found) → error', /if \(timedOut\) window\.ffSound\?\.\('error'\)/.test(verify));
  const done = fnSrc('DoneScreen', 'RecoverScreen');
  ok('credentials screen → delivered once per order, only FULFILLED/RENEWED after payment', /useEffect\(\(\) => \{ if \(r\.found && r\._soundOid && \/\^\(FULFILLED\|RENEWED\)\$\/\.test\(String\(r\.fulfillment \|\| ''\)\.toUpperCase\(\)\)\) window\.ffSoundOnce\?\.\('delivered', r\._soundOid\); \}, \[\]\);/.test(done));
  const recover = fnSrc('RecoverScreen', 'SoundRows');
  ok('Recover (reopening old credentials) never passes _soundOid', /nav\('done'/.test(recover) && !/_soundOid/.test(recover));
  ok('coupon applied (new + renew) → coupon; invalid → error', (html.match(/You save ₹\$\{disc\}`\n\s*\}\);\n\s*window\.ffSound\?\.\('coupon'\);/g) || []).length === 2 && (html.match(/'Coupon invalid'\)\n\s*\}\)\);\n\s*window\.ffSound\?\.\('error'\);/g) || []).length === 2);
  ok('invite discount → coupon sound', /friendDiscount\) > 0\) window\.ffSound\?\.\('coupon'\)/.test(html));
  ok('coins switched on at checkout → coins', /if \(!on\) window\.ffSound\?\.\('coins'\);\n\s*onChange && onChange\(!on, q\);/.test(fnSrc('CoinToggle', 'WalletPanel')));
  ok('copy tick in every copy handler (creds, copyText_, pay screen, pay help, coupons, OTP)', (html.match(/window\.ffSound\?\.\('copy'\)/g) || []).length === 6);
  ok('no sound calls anywhere else (keeps it calm)', (html.match(/window\.ffSound(Once)?\?\.\(/g) || []).length === 16, (html.match(/window\.ffSound(Once)?\?\.\(/g) || []).length);

  section('store: Account switches');
  const rowsSrc = html.slice(html.indexOf('function SoundRows()'), html.indexOf('function AccountScreen({'));
  ok('SoundRows rendered in the Account list', /"›"\)\)\)\), React\.createElement\(SoundRows, null\)\), section === 'profile'/.test(html));
  const el = (t, p, ...c) => ({ t, p: p || {}, c: c.flat(Infinity) });
  const texts = (n, out = []) => { if (n == null || n === false) return out; if (typeof n !== 'object') { out.push(String(n)); return out; } (n.c || []).forEach((x) => texts(x, out)); return out; };
  function renderRows(prefs) {
    const X = runStore({ prefs }); X.fire('pointerdown');
    let state; const sets = [];
    const useState = (d) => { if (state === undefined) state = typeof d === 'function' ? d() : d; return [state, (u) => { state = typeof u === 'function' ? u(state) : u; sets.push(state); }]; };
    const buzz = [];
    const w = X.window; w.navigator = null;
    const SR = new Function('React', 'useState', 'Card', 'window', 'navigator', rowsSrc + '; return SoundRows;')({ createElement: el }, useState, (p, ...c) => el('Card', p, c), w, { vibrate: (p) => buzz.push(p) });
    return { X, tree: () => SR(), buzz, get state() { return state; } };
  }
  let R = renderRows();
  let tree = R.tree();
  const rows = tree.c.filter((n) => n.t === 'button');
  ok('two rows: 🔊 Sounds + 📳 Vibration, both On by default', rows.length === 2 && /🔊 Sounds/.test(texts(rows[0]).join(' ')) && /📳 Vibration/.test(texts(rows[1]).join(' ')) && rows.every((r) => r.p['aria-checked'] === true && /On/.test(texts(r).join(' '))));
  rows[0].p.onClick();
  ok('turning Sounds off stores it and shows Off', R.X.localStorage.m.ff_sound === '0' && /Off/.test(texts(R.tree().c[0]).join(' ')));
  let n0 = R.X.A.oscs.length;
  R.tree().c[0].p.onClick();
  ok('turning Sounds on plays a tiny preview', R.X.localStorage.m.ff_sound === '1' && R.X.A.oscs.length > n0);
  R.tree().c[1].p.onClick();
  ok('Vibration off stored, no buzz', R.X.localStorage.m.ff_vibe === '0' && R.buzz.length === 0);
  R.tree().c[1].p.onClick();
  ok('Vibration on → short test buzz', R.X.localStorage.m.ff_vibe === '1' && R.buzz.length === 1);
  const noMod = new Function('React', 'useState', 'Card', 'window', 'navigator', rowsSrc + '; return SoundRows;')({ createElement: el }, (d) => [typeof d === 'function' ? d() : d, () => {}], () => null, {}, {});
  ok('module missing → row hidden, no crash', noMod() === null);

  section('admin: ka-ching');
  function runBell(o) {
    o = o || {};
    const A = fakeAudio(o.audio); const listeners = {};
    const window = { AudioContext: A.Ctx, addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); } };
    const document = { hidden: false }; const localStorage = mkStorage(o.storageThrows, o.prefs);
    new Function('window', 'document', 'localStorage', bellScript)(window, document, localStorage);
    return { A, window, document, localStorage, tap: () => (listeners.pointerdown || []).forEach((f) => f({})) };
  }
  let B = runBell();
  ok('silent before first tap', B.window.ffBell.play() === false && B.A.made === 0);
  B.tap();
  ok('plays after a tap, ≤ 1.2 s, quiet master', B.window.ffBell.play() === true && span(B.A) <= 1.2 && B.A.sources.length === 1 && B.A.gains[0].gain.value === 0.35);
  ok('default ON', B.window.ffBell.on() === true);
  B.window.ffBell.set(false);
  let o0 = B.A.oscs.length;
  ok('switched off: silent, stored; test button forces it', B.localStorage.m.ff_admin_bell === '0' && B.window.ffBell.play() === false && B.A.oscs.length === o0 && B.window.ffBell.play(true) === true);
  B = runBell(); B.tap(); B.document.hidden = true;
  ok('hidden tab: silent', B.window.ffBell.play() === false);
  B = runBell({ storageThrows: true }); B.tap();
  ok('storage blocked: default on, no throw', B.window.ffBell.on() === true && (() => { try { B.window.ffBell.set(false); return true; } catch (e) { return false; } })());

  section('admin: new paid order poll');
  const pollSrc = admin.slice(admin.indexOf('/* ---------- new-order bell'), admin.indexOf('function bellStart()'));
  const startSrc = admin.slice(admin.indexOf('function bellStart()'), admin.indexOf('\n}\n', admin.indexOf('function bellStart()')) + 3);
  ok('poll + start blocks found', pollSrc.length > 200 && /setInterval\(bellPoll, 60000\)/.test(startSrc));
  ok('bell starts with the signed-in shell', /refreshPauseBar\(\);\n\s*bellStart\(\);\n\s*adminInstallRefresh\(\);/.test(admin));
  ok('Today header has the toggle + test button', /id="tbell" role="switch"/.test(admin) && /id="tbelltest">▶ Test sound/.test(admin) && /\$\('#tref'\)\.onclick = loadToday;\n\s*bellWire\(\);/.test(admin));
  function runPoll(responses) {
    const calls = []; const toasts = []; const intervals = []; let cleared = 0; const docL = {};
    let dinged = 0;
    const doc = { hidden: false, addEventListener: (k, f) => { docL[k] = f; } };
    const fetch = (url, opt) => { calls.push([url, opt]); const r = responses.shift(); return r instanceof Error ? Promise.reject(r) : Promise.resolve({ json: () => Promise.resolve(r) }); };
    const els = {};
    const $ = (s) => els[s] || (els[s] = { textContent: '', setAttribute(k, v) { this[k] = v; } });
    const win = { ffBell: { on: () => true, set: () => {}, play: () => { dinged++; return true; } } };
    const api = new Function('fetch', 'document', 'toast', '$', 'setInterval', 'clearInterval', 'window', 'ffBell',
      pollSrc + startSrc + '; return { bellPoll, bellStart, bellWire, BELL };')(fetch, doc, (t) => toasts.push(t), $, (f, ms) => { intervals.push(ms); return 7; }, () => { cleared++; }, win, win.ffBell);
    return { api, calls, toasts, intervals, docL, doc, get dinged() { return dinged; }, get cleared() { return cleared; }, els, win };
  }
  const tick = () => new Promise((r) => setImmediate(r));
  const ord = (id, status) => ({ order_id: id, status, source: 'node' });
  let P = runPoll([
    { ok: true, orders: [ord('FF1', 'PAID'), ord('FF2', 'CREATED')] },
    { ok: true, orders: [ord('FF1', 'PAID'), ord('FF2', 'CREATED')] },
    { ok: true, orders: [ord('FF3', 'CREATED'), ord('FF1', 'PAID'), ord('FF2', 'PAID')] },
    { ok: true, orders: [ord('FF4', 'PAID'), ord('FF5', 'paid'), ord('FF1', 'PAID'), ord('FF2', 'PAID')] },
    new Error('offline'),
    { ok: false, needLogin: true },
  ]);
  P.api.bellStart(); await tick(); await tick();
  ok('one cheap existing endpoint (today, limit 50), same-origin cookie', P.calls.length === 1 && P.calls[0][0] === '/admin/api/orders/search?view=today&limit=50' && P.calls[0][1].credentials === 'same-origin' && !P.calls[0][1].method);
  ok('every 60 s', JSON.stringify(P.intervals) === '[60000]');
  ok('first look: remembers paid orders, no ding for old ones', P.dinged === 0 && P.toasts.length === 0);
  P.api.bellStart();
  ok('starting twice does not add a second timer', P.intervals.length === 1 && P.calls.length === 1);
  P.api.bellPoll(); await tick(); await tick();
  ok('nothing new → quiet', P.dinged === 0);
  P.api.bellPoll(); await tick(); await tick();
  ok('an order that became PAID → ka-ching + toast', P.dinged === 1 && /New paid order: FF2/.test(P.toasts[0]), P.toasts);
  P.api.bellPoll(); await tick(); await tick();
  ok('two new paid orders at once → one ding, count in toast', P.dinged === 2 && /New paid orders: 2/.test(P.toasts[1]), P.toasts);
  P.api.bellPoll(); await tick(); await tick();
  ok('network error: ignored quietly', P.dinged === 2);
  P.api.bellPoll(); await tick(); await tick();
  ok('session ended: stops polling (never bounces to sign-in)', P.cleared === 1 && P.api.BELL.timer === null && !/\bapi\('|handle\(/.test(pollSrc.slice(pollSrc.indexOf('function bellPoll'))));
  P.doc.hidden = true; const nCalls = P.calls.length; P.api.bellPoll();
  ok('hidden tab: no request', P.calls.length === nCalls);
  P = runPoll([{ ok: true, orders: [] }, { ok: true, orders: [ord('FF9', 'PAID')] }]);
  P.api.bellStart(); await tick(); await tick(); P.doc.hidden = true; P.doc.hidden = false; P.docL.visibilitychange(); await tick(); await tick();
  ok('coming back to the tab checks at once', P.calls.length === 2 && P.dinged === 1);
  P = runPoll([]);
  P.api.bellWire();
  ok('toggle label shows state', /Sound for new orders: On/.test(P.els['#tbell'].textContent) && P.els['#tbell']['aria-checked'] === 'true');
  let played = 0; P.win.ffBell.play = (f) => { played += f ? 1 : 0; return true; };
  P.els['#tbelltest'].onclick();
  ok('test button forces the sound', played === 1);

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
