/* Storefront Tools tiles (home + My plans) and the splash intro. No browser needed. Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('// Tools (home + My plans)');
const end = html.indexOf('function HomeScreen({');
ok('ToolsGrid block found before HomeScreen', start > 0 && end > start);
const src = html.slice(start, end);

// ---- tiny fake React ----
const el = (t, p, ...c) => ({ t, p: p || {}, c: c.flat(Infinity) });
const Comp = (name) => { const f = function (props) { return el(name, props, props.children); }; f.compName = name; return f; };
function texts(node, out) { out = out || []; if (node == null || node === false) return out; if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; } if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; } if (typeof node === 'object') (node.c || []).forEach((n) => texts(n, out)); return out; }
const textOf = (tree) => texts(tree).join(' ');
function find(node, pred, out) { out = out || []; if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; } if (pred(node)) out.push(node); (node.c || []).forEach((n) => find(n, pred, out)); return out; }
// Expand child components (ToolsSheet) so their markup is visible.
function expand(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.t === 'function' && !node.t.compName) return expand(node.t(Object.assign({}, node.p, { children: node.c })));
  return Object.assign({}, node, { c: (node.c || []).map(expand) });
}
function harness(sheet) {
  const H = { sets: [], opened: [], effects: [], otp: 0, listeners: [] };
  const React = { createElement: el, Fragment: 'Fragment' };
  const useState = (d) => [sheet !== undefined ? sheet : d, (x) => H.sets.push(x)];
  const useEffect = (fn) => H.effects.push(fn);
  const win = { open: (u) => { H.opened.push(u); return { opener: 'x' }; }, addEventListener: (k, f) => H.listeners.push([k, f]), removeEventListener: () => {} };
  const mod = new Function('React', 'useState', 'useEffect', 'Btn', 'RocketArt', 'window', 'NETFLIX_HOUSEHOLD_LINK', src + '; return { ToolsGrid, ToolsSheet, openExternal_ };')(
    React, useState, useEffect, Comp('Btn'), Comp('RocketArt'), win, 'https://script.google.com/macros/s/LINK1/exec');
  H.render = (props) => expand(mod.ToolsGrid(Object.assign({ onOtp: () => H.otp++ }, props || {})));
  return H;
}
const byTool = (tree, id) => find(tree, (n) => n.p && n.p['data-tool'] === id)[0];
const btn = (tree, re) => find(tree, (n) => n.t && n.t.compName === 'Btn' && re.test(textOf(n)))[0];

section('tiles');
let H = harness('');
let tree = H.render();
const tiles = find(tree, (n) => n.p && String(n.p.className || '').split(' ').includes('ff-tool'));
ok('two big tiles: Get OTP + Netflix Household Helper', tiles.length === 2 && /Get OTP/.test(textOf(tiles[0])) && /Netflix Household Helper/.test(textOf(tiles[1])), tiles.length);
ok('tiles are real buttons with a clear action word', tiles.every((t) => t.t === 'button' && t.p.type === 'button') && /Get my OTP/.test(textOf(tiles[0])) && /Fix it/.test(textOf(tiles[1])));
ok('coming-soon chips for Movies & Series + Games', /Movies & Series/.test(textOf(byTool(tree, 'movies'))) && /Games/.test(textOf(byTool(tree, 'games'))) && /Soon/.test(textOf(byTool(tree, 'games'))));
ok('no sheet open at start', !find(tree, (n) => n.p && n.p.className === 'ff-sheet').length);
byTool(tree, 'otp').p.onClick();
ok('Get OTP tile calls onOtp', H.otp === 1);
byTool(tree, 'household').p.onClick();
ok('Household tile opens its sheet', H.sets.includes('household'));
byTool(tree, 'games').p.onClick();
ok('Soon chip opens its sheet', H.sets.includes('games'));
H = harness(''); tree = expand(harness('').render({ onOtp: undefined }));
byTool(tree, 'otp').p.onClick();
ok('missing onOtp does not crash', true);

section('household sheet');
H = harness('household');
tree = H.render();
const sheetT = textOf(find(tree, (n) => n.p && n.p.className === 'ff-sheet')[0]);
ok('explains when to use it and which link', /not part of your household/.test(sheetT) && /Which link should I use\?/.test(sheetT) && /harsh…, gunjan…, fluxfilm…/.test(sheetT) && /all other Netflix emails/.test(sheetT));
btn(tree, /Open Link 1/).p.onClick();
btn(tree, /Open Link 2/).p.onClick();
ok('Link 1 = NETFLIX_HOUSEHOLD_LINK, Link 2 = darkflix (unchanged URLs)', H.opened[0] === 'https://script.google.com/macros/s/LINK1/exec' && H.opened[1] === 'https://darkflix.shop', H.opened);
ok('real page keeps the same Link 1 URL constant', /const NETFLIX_HOUSEHOLD_LINK = "https:\/\/script\.google\.com\/macros\/s\/AKfycbwKHq3zwpz_xoSgXLwAUdfYSFa8wty2I3udACsWQO5OWpgmBXmhVHvCK_0e9XykhS7Nmw\/exec";/.test(html));
H.sets.length = 0;
btn(tree, /Close/).p.onClick();
ok('Close button closes', H.sets.includes(''));
H.sets.length = 0;
find(tree, (n) => n.p && n.p.className === 'ff-sheet-bg')[0].p.onClick();
ok('tap on the dark background closes', H.sets.includes(''));
let stopped = false;
find(tree, (n) => n.p && n.p.className === 'ff-sheet')[0].p.onClick({ stopPropagation: () => { stopped = true; } });
ok('tap inside the sheet does not close', stopped);
H.effects.forEach((f) => f());
H.sets.length = 0;
const keyL = H.listeners.find((l) => l[0] === 'keydown');
keyL[1]({ key: 'Escape' });
ok('Escape closes', H.sets.includes(''));

section('soon sheet');
H = harness('movies'); tree = H.render();
ok('movies sheet uses the old coming-soon text', /Latest Movies & Series/.test(textOf(tree)) && /Coming soon!/.test(textOf(tree)) && /working on it/.test(textOf(tree)));

section('wiring in the screens');
ok('home uses ToolsGrid (old Extra Tools card gone)', /React\.createElement\(ToolsGrid, \{\s*className: "ff-o5",\s*onOtp: openOtpFromHome\s*\}\)/.test(html) && !/Extra Tools/.test(html));
ok('My plans uses ToolsGrid with the OTP picker (old collapsible card gone)', /React\.createElement\(ToolsGrid, \{\s*onOtp: onOtpClick,/.test(html) && !/toolsOpen|setComingSoon/.test(html));
const home = html.slice(html.indexOf('function HomeScreen({'), html.indexOf('function SubCard({'));
ok('home OTP tile before login: hint + focus phone box', /function openOtpFromHome\(\)/.test(home) && /otpAfterLogin\.current = true;/.test(home) && /document\.querySelector\('#ff-login input'\)/.test(home) && /id: "ff-login",/.test(home) && /To get your OTP, enter your phone number/.test(home));
ok('after login the dashboard opens Get OTP (all 3 login paths); flag not saved in session', (home.match(/toDashboard\(payload\);/g) || []).length === 3 && !/nav\('dashboard', payload\)/.test(home) && /_openOtp: true/.test(home) && !/saveFFSession\(\{[^}]*_openOtp/.test(home));
ok('dashboard still auto-opens OTP from _openOtp', /autoOpenOtp: d\._openOtp/.test(html));

section('splash');
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
ok('splash markup is hidden by default and sits at the top of <body>', /<body>\n<div id="ff-splash" hidden aria-hidden="true">/.test(html) && html.indexOf('id="ff-splash"') < html.indexOf('<div id="root">'));
ok('reduced motion hides it in CSS too', /@media \(prefers-reduced-motion: reduce\) \{ #ff-splash \{ display: none !important; \} \}/.test(css));
const kf = [...css.matchAll(/@keyframes (ffSp\w+|ffSplashOut) \{([\s\S]*?)\} \}/g)];
ok('splash keyframes only animate transform / opacity / visibility (GPU friendly)', kf.length === 6 && kf.every((m) => (m[2].match(/([a-z-]+)\s*:/g) || []).every((p) => /^(transform|opacity|visibility)\s*:$/.test(p))), kf.map((m) => m[1]));
const outM = css.match(/#ff-splash \{[^}]*animation: ffSplashOut ([\d.]+)s ease-in ([\d.]+)s forwards;/);
ok('whole intro stays under 1.6 s (ribbon reveal, owner 2026-09-15)', outM && Number(outM[1]) + Number(outM[2]) <= 1.6, outM && outM.slice(1));
ok('ribbon reveal: 7 ribbons, inline logo, 18 light streaks', (html.match(/<div class="ff-sp-rib">((?:<span><\/span>)+)<\/div>/) || ['', ''])[1].length === 7 * 13 && /<div class="ff-sp-logo"><svg[^>]*>[\s\S]*?ffsp-bg/.test(html) && (html.match(/<div class="ff-sp-streaks">(.*?)<\/div><div class="ff-sp-stage">/) || ['', ''])[1].split('<i ').length - 1 === 18);
ok('React app still renders underneath (root after splash, no delay)', /<\/script>\n<div id="root"><\/div>/.test(html));
const spScript = (html.match(/<body>\n<div id="ff-splash"[^\n]*\n<script>([\s\S]*?)<\/script>/) || ['', ''])[1];
function runSplash({ reduce, seen, storageThrows }) {
  const S = { removed: false, hidden: true, listeners: {}, timers: [], store: seen ? { ff_splash: '1' } : {} };
  const node = { get hidden() { return S.hidden; }, set hidden(v) { S.hidden = v; }, addEventListener: (k, f) => { S.listeners[k] = f; }, parentNode: { removeChild: () => { S.removed = true; node.parentNode = null; } } };
  const sessionStorage = { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return S.store[k] || null; }, setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); S.store[k] = v; } };
  const window = { matchMedia: () => ({ matches: !!reduce }) };
  new Function('document', 'window', 'sessionStorage', 'setTimeout', spScript)({ getElementById: () => node }, window, sessionStorage, (f, ms) => S.timers.push([f, ms]));
  return S;
}
let S = runSplash({});
ok('first open: shown, remembered for the session, auto-removed by 1.8 s', !S.hidden && !S.removed && S.store.ff_splash === '1' && S.timers.length === 1 && S.timers[0][1] <= 1800);
S.timers[0][0]();
ok('timer removes it', S.removed);
S = runSplash({}); S.listeners.click();
ok('tap skips it', S.removed);
S = runSplash({}); S.listeners.animationend({ target: {} });
ok('a child animation ending does not remove it early', !S.removed);
S = runSplash({ seen: true });
ok('reload / page change in the same session: not shown again (owner 2026-09-15, replaces 09-14 every-load)', S.hidden && S.removed && S.timers.length === 0);
S = runSplash({ reduce: true });
ok('reduced motion: removed at once, never shown', S.removed && S.hidden && !S.store.ff_splash);
S = runSplash({ storageThrows: true });
ok('storage blocked: still works (shown, removed by timer)', !S.hidden && S.timers.length === 1);

section('admin panel splash (rose ribbon reveal)');
const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const aCss = (admin.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
ok('admin: splash hidden by default, right after <body>, before #app', /<body>\n<div id="ff-splash" hidden aria-hidden="true">/.test(admin) && admin.indexOf('id="ff-splash"') < admin.indexOf('<div id="app">'));
ok('admin: reduced motion hides it in CSS', /@media \(prefers-reduced-motion: reduce\) \{ #ff-splash \{ display: none !important; \} \}/.test(aCss));
const aKf = [...aCss.matchAll(/@keyframes (ffSp\w+|ffSplashOut) \{([\s\S]*?)\} \}/g)];
ok('admin: keyframes only animate transform / opacity / visibility', aKf.length === 6 && aKf.every((m) => (m[2].match(/([a-z-]+)\s*:/g) || []).every((p) => /^(transform|opacity|visibility)\s*:$/.test(p))), aKf.map((m) => m[1]));
const aOut = aCss.match(/#ff-splash \{[^}]*animation: ffSplashOut ([\d.]+)s ease-in ([\d.]+)s forwards;/);
ok('admin: whole intro under 1.6 s, wine background', aOut && Number(aOut[1]) + Number(aOut[2]) <= 1.6 && /#ff-splash \{[^}]*#12040a/.test(aCss));
ok('admin: 7 rose ribbons, inline admin logo (own ids), 18 streaks', (admin.match(/<div class="ff-sp-rib">((?:<span><\/span>)+)<\/div>/) || ['', ''])[1].length === 7 * 13 && /\.ff-sp-rib span:nth-child\(1\) \{ background: #be123c; \}/.test(aCss) && /<div class="ff-sp-logo"><svg[^>]*>[\s\S]*?ffasp-bg/.test(admin) && !/id="ffa-/.test(admin) && (admin.match(/<div class="ff-sp-streaks">(.*?)<\/div><div class="ff-sp-stage">/) || ['', ''])[1].split('<i ').length - 1 === 18);
const aScript = (admin.match(/<body>\n<div id="ff-splash"[^\n]*\n<script>([\s\S]*?)<\/script>\n<div id="app"><\/div>/) || ['', ''])[1];
function runAdminSplash({ reduce, seen, storageThrows }) {
  const S = { removed: false, hidden: true, listeners: {}, timers: [], store: seen ? { ff_admin_splash: '1' } : {} };
  const node = { get hidden() { return S.hidden; }, set hidden(v) { S.hidden = v; }, addEventListener: (k, f) => { S.listeners[k] = f; }, parentNode: { removeChild: () => { S.removed = true; node.parentNode = null; } } };
  const sessionStorage = { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return S.store[k] || null; }, setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); S.store[k] = v; } };
  new Function('document', 'window', 'sessionStorage', 'setTimeout', aScript)({ getElementById: () => node }, { matchMedia: () => ({ matches: !!reduce }) }, sessionStorage, (f, ms) => S.timers.push([f, ms]));
  return S;
}
S = runAdminSplash({});
ok('admin: first open shown, remembered (own key), removed by 1.8 s', aScript && !S.hidden && S.store.ff_admin_splash === '1' && !S.store.ff_splash && S.timers.length === 1 && S.timers[0][1] <= 1800);
S = runAdminSplash({}); S.listeners.click();
ok('admin: tap skips it', S.removed);
S = runAdminSplash({ seen: true });
ok('admin: not shown again in the same session', S.hidden && S.removed);
S = runAdminSplash({ reduce: true });
ok('admin: reduced motion never shows it', S.removed && S.hidden);
S = runAdminSplash({ storageThrows: true });
ok('admin: storage blocked still works', !S.hidden && S.timers.length === 1);

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
