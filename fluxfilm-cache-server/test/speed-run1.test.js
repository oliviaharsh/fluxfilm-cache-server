/* Speed & smoothness pass (feedback run 1, 15 Sep 2026): nothing should feel laggy.
   - font CSS no longer blocks the page; early connection to the React CDN
   - tapped Reel / trailer: poster + spinner cover until the player is visible (no white flash); faster Instagram fallback
   - New tab warms the Instagram / YouTube connections; off-screen posts are not drawn (content-visibility)
   - no invisible blur on the bottom menu; low-end / Data Saver phones skip the header blur
   No browser needed. Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const head = html.slice(0, html.indexOf('</head>'));
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

section('first load');
let parsed = true;
for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
ok('all inline scripts parse', parsed && scripts.length >= 3, scripts.length);
const FONT = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';
const fontLinks = head.match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) || [];
ok('font CSS is not render/script blocking (print → all on load), still preloaded, noscript fallback', fontLinks.length === 3 &&
  fontLinks.some((l) => /rel="preload" as="style"/.test(l)) &&
  fontLinks.some((l) => /rel="stylesheet" media="print" onload="this\.media='all'"/.test(l)) &&
  new RegExp('<noscript><link href="' + FONT.replace(/[.?+]/g, '\\$&') + '" rel="stylesheet" /></noscript>').test(head) &&
  !fontLinks.some((l) => /rel="stylesheet" \/>/.test(l) && !/noscript/.test(head.slice(head.indexOf(l) - 10, head.indexOf(l)))), fontLinks);
ok('font preconnects kept; React CDN connection opened early (CORS, like the scripts)', /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin \/>/.test(head) && /<link rel="preconnect" href="https:\/\/unpkg\.com" crossorigin \/>/.test(head) && /<script src="https:\/\/unpkg\.com\/react@18\.3\.1\/umd\/react\.production\.min\.js" crossorigin="anonymous"><\/script>/.test(html));

section('smooth scrolling');
ok('bottom menu: no (invisible) backdrop blur any more, same look', /\.ff-bnav \{[^}]*background: rgba\(255,255,255,\.97\);/.test(css) && !/\.ff-bnav \{[^}]*backdrop-filter/.test(css));
ok('low-end phones: header + pop-up background without blur', /html\.ff-lite \.ff-topbar \{[^}]*backdrop-filter: none;/.test(css) && /html\.ff-lite \.ff-sheet-bg \{[^}]*backdrop-filter: none;/.test(css));
const liteScript = scripts.find((s) => /ff-lite/.test(s) && !/ff-splash/.test(s));
const runLite = (nav) => { const added = []; new Function('navigator', 'document', liteScript)(nav, { documentElement: { classList: { add: (c) => added.push(c) } } }); return added; };
ok('Data Saver on → ff-lite; normal phone stays full', runLite({ hardwareConcurrency: 8, deviceMemory: 8, connection: { saveData: true } }).includes('ff-lite') && runLite({ hardwareConcurrency: 8, deviceMemory: 4, connection: { saveData: false } }).length === 0);
ok('feed posts off screen are skipped (content-visibility + remembered size); skeletons always drawn', /\.ff-feed-post \{ content-visibility: auto; contain-intrinsic-size: auto 760px;/.test(css) && /\.ff-feed-post\.ff-feed-skel \{ content-visibility: visible; \}/.test(css));
ok('screen change ≤ 220 ms, transform/opacity only', /\.ff-slide \{ animation: ffSlideIn \.2s /.test(css) && !/@keyframes ffSlideIn \{[^\n]*(width|height|top|left|margin)\s*:/.test(css));

section('Instagram Reel: cover until visible');
const vs = html.indexOf('function feedYouTubeId_('); const ve = html.indexOf('function FeedMedia(');
const vidSrc = html.slice(vs, ve);
const mkDoc = () => {
  const d = { appended: [], head: [] };
  d.createElement = (tag) => {
    const el = { tagName: tag.toUpperCase(), attrs: {}, children: [], style: {}, listeners: {}, setAttribute(k, x) { this.attrs[k] = x; }, appendChild(c) { this.children.push(c); return c; }, remove() {}, addEventListener(k, f) { this.listeners[k] = f; } };
    Object.defineProperty(el, 'textContent', { set() { this.children = []; }, get() { return ''; } });
    Object.defineProperty(el, 'offsetHeight', { get() { return parseInt(this.style.height, 10) || 0; } });
    return el;
  };
  d.body = { appendChild: (c) => { d.appended.push(c); return c; } };
  d.head = { appendChild: (c) => c };
  return d;
};
function load(clock) {
  const win = { timers: [] };
  const doc = mkDoc();
  const st = (f, ms) => { win.timers.push({ f, ms, at: clock.now + ms }); return win.timers.length; };
  const V = new Function('window', 'document', 'setTimeout', 'clearTimeout', 'Date', vidSrc + '; return { feedIgMount_, feedWarm_ };')(win, doc, st, (id) => { if (win.timers[id - 1]) win.timers[id - 1].cancelled = true; }, { now: () => clock.now });
  // run due timers (in time order) up to clock.now
  const runTo = (t) => { for (;;) { const due = win.timers.filter((x) => !x.cancelled && !x.ran && x.at <= t).sort((a, b) => a.at - b.at)[0]; if (!due) break; clock.now = Math.max(clock.now, due.at); due.ran = true; due.f(); } clock.now = t; };
  return { win, doc, V, runTo };
}
{
  const clock = { now: 1000 };
  const { win, doc, V, runTo } = load(clock);
  win.instgrm = { Embeds: { process: () => {} } };
  const box = mkDoc().createElement('div');
  let embedFrame = null; box.querySelector = () => embedFrame;
  let ready = 0;
  V.feedIgMount_(box, 'https://www.instagram.com/reel/C9xYz_12-ab/', 480, () => ready++);
  ok('Reel mounted (blockquote) but not "ready" yet → cover stays', box.children[0].tagName === 'BLOCKQUOTE' && ready === 0);
  runTo(1300);
  embedFrame = { offsetHeight: 20, addEventListener(k, f) { this.onl = f; } };
  runTo(1600);
  ok('embed.js iframe without height → still loading', ready === 0 && typeof embedFrame.onl === 'function');
  embedFrame.offsetHeight = 640;
  runTo(1800);
  ok('iframe got its real height → ready once (cover fades)', ready === 1 && box.children[0].tagName === 'BLOCKQUOTE');
  runTo(12000);
  ok('no fallback and no second ready later', ready === 1 && box.children[0].tagName === 'BLOCKQUOTE');
}
{
  const clock = { now: 0 };
  const { win, V, runTo } = load(clock);
  win.instgrm = { Embeds: { process: () => {} } };
  const box = mkDoc().createElement('div');
  const embedFrame = { offsetHeight: 20, addEventListener(k, f) { this.onl = f; } };
  box.querySelector = () => (box.children[0] && box.children[0].tagName === 'IFRAME' ? box.children[0] : embedFrame);
  let ready = 0;
  V.feedIgMount_(box, 'https://www.instagram.com/p/DAbc123/', 500, () => ready++);
  runTo(400);
  embedFrame.onl(); // loaded at 400 ms but embed.js never sizes it (in-app browsers)
  runTo(2300);
  ok('loaded without height: no fallback before 2 s', box.children[0].tagName === 'BLOCKQUOTE' && ready === 0);
  runTo(2700);
  const fr = box.children[0];
  ok('2 s after load still no height → /embed/ iframe (was 8 s)', fr && fr.tagName === 'IFRAME' && fr.src === 'https://www.instagram.com/p/DAbc123/embed/' && fr.style.height === '660px' && ready === 0);
  fr.onload();
  ok('fixed iframe loaded → ready', ready === 1);
  runTo(20000);
  ok('safety timer / 8 s check do not fire ready twice or replace the iframe', ready === 1 && box.children[0] === fr);
}
{
  const clock = { now: 0 };
  const { V, runTo } = load(clock);
  const box = mkDoc().createElement('div'); box.querySelector = () => null;
  let ready = 0;
  const stop = V.feedIgMount_(box, 'https://www.instagram.com/p/DAbc123/', 0, () => ready++);
  stop();
  runTo(30000);
  ok('closed before it loaded → nothing fires', ready === 0);
}
{
  const clock = { now: 0 };
  const { doc, V } = load(clock);
  const heads = [];
  doc.head.appendChild = (c) => { heads.push(c); return c; };
  V.feedWarm_([{ title: 'plain' }]);
  ok('no video posts → no connections opened', heads.length === 0);
  V.feedWarm_([{ instagramUrl: 'https://www.instagram.com/reel/C9xYz_12-ab/' }, { trailerUrl: 'https://youtu.be/dQw4w9WgXcQ' }]);
  V.feedWarm_([{ instagramUrl: 'https://www.instagram.com/reel/C9xYz_12-ab/' }]);
  ok('video posts → preconnect (no crossorigin, nothing loaded) to Instagram + YouTube, once each', heads.length === 3 && heads.every((l) => l.rel === 'preconnect' && !l.crossOrigin) && heads.map((l) => l.href).join() === 'https://www.instagram.com,https://static.cdninstagram.com,https://www.youtube-nocookie.com', heads.map((l) => l.href));
  ok('bad links do not warm anything', (() => { const n = heads.length; V.feedWarm_([{ instagramUrl: 'https://instagram.com.evil/reel/C9xYz_12-ab/', trailerUrl: 'https://youtube.com/channel/x' }]); return heads.length === n; })());
  ok('the New tab warms connections when its posts arrive', /useEffect\(\(\) => \{\s*if \(data && data\.posts\) feedWarm_\(data\.posts\);\s*\}, \[data\]\);/.test(html));
}

section('FeedMedia cover (render harness)');
{
  const ms = html.indexOf('function FeedMedia('); const me = html.indexOf('function feedShare_(');
  const st = []; let i = 0; let mountArgs = null; const effects = [];
  const R = { createElement: (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat() }) };
  const hooks = { useState: (init) => { const k = i++; if (!(k in st)) st[k] = typeof init === 'function' ? init() : init; return [st[k], (x) => { st[k] = typeof x === 'function' ? x(st[k]) : x; }]; }, useRef: () => ({ current: { offsetHeight: 470 } }), useEffect: (f) => effects.push(f) };
  const noop = () => {};
  const FM = new Function('React', 'useState', 'useRef', 'useEffect', 'feedYouTubeId_', 'feedIgUrl_', 'feedTrailerSrc_', 'feedVideoStart_', 'feedVideoEnd_', 'feedIgMount_', 'feedEvent_', 'setTimeout', 'clearTimeout', html.slice(ms, me) + '; return FeedMedia;')(
    R, hooks.useState, hooks.useRef, hooks.useEffect, (u) => (/youtu/.test(u || '') ? 'dQw4w9WgXcQ' : ''), (u) => (/instagram/.test(u || '') ? 'https://www.instagram.com/reel/C9xYz_12-ab/' : ''), (id) => 'https://www.youtube-nocookie.com/embed/' + id, noop, noop,
    (...a) => { mountArgs = a; return noop; }, noop, () => 1, noop);
  const find = (n, f, out) => { out = out || []; if (n && typeof n === 'object') { if (f(n)) out.push(n); (n.kids || []).forEach((c) => find(c, f, out)); } return out; };
  const p = { id: 'fp1', title: 'T', image: '/feed-img/fp1?v=1', instagramUrl: 'https://www.instagram.com/reel/C9xYz_12-ab/', trailerUrl: 'https://youtu.be/dQw4w9WgXcQ' };
  const draw = () => { i = 0; effects.length = 0; return FM({ p, onLike: noop }); };
  let tree = draw();
  find(tree, (n) => n.type === 'button' && /ff-feed-play ig/.test(n.props.className || ''))[0].props.onClick();
  tree = draw();
  effects.forEach((f) => f());
  const cov = () => find(tree, (n) => /ff-feed-vload/.test(n.props.className || ''))[0];
  ok('Reel tapped: dark cover with the same poster + spinner + "Loading Reel…", as tall as the card was', cov() && !/off/.test(cov().props.className) && cov().props.style.height === 470 && cov().props.role === 'status' && find(cov(), (n) => n.type === 'img' && n.props.src === p.image).length === 1 && find(cov(), (n) => n.type === 'i').length === 1 && /Loading Reel/.test(JSON.stringify(cov())) && !/ on\b/.test(tree.props.className));
  ok('the mount is told how to lift the cover', mountArgs && typeof mountArgs[3] === 'function');
  mountArgs[3]();
  tree = draw();
  ok('ready → cover fades out (kept in place, hidden from screen readers), box turns white', /ff-feed-vload off/.test(cov().props.className) && cov().props['aria-hidden'] === 'true' && /ff-feed-media ig on/.test(tree.props.className));
  const close = find(tree, (n) => n.type === 'button' && /Close/.test(JSON.stringify(n.kids)))[0];
  close.props.onClick();
  tree = draw();
  find(tree, (n) => n.type === 'button' && /Play trailer/.test(JSON.stringify(n.kids)))[0].props.onClick();
  tree = draw();
  const yf = find(tree, (n) => n.type === 'iframe')[0];
  ok('trailer tapped: cover again (reset), "Loading trailer…"; lifted by the iframe load event', yf && cov() && !/off/.test(cov().props.className) && /Loading trailer/.test(JSON.stringify(cov())) && typeof yf.props.onLoad === 'function');
  yf.props.onLoad();
  tree = draw();
  ok('trailer loaded → cover off; close button stays on top', /off/.test(cov().props.className) && /\.ff-feed-vclose \{ position: absolute; z-index: 3;/.test(css) && /\.ff-feed-vbar \{ position: relative; z-index: 3;/.test(css) && /\.ff-feed-vload \{ position: absolute; inset: 0; z-index: 2;/.test(css));
  ok('cover animation: opacity only; spinner = rotate; slower with reduced motion', /\.ff-feed-vload \{[^}]*transition: opacity \.2s ease, visibility \.2s;/.test(css) && /@keyframes ffVSpin \{ to \{ transform: rotate\(360deg\); \} \}/.test(css) && /prefers-reduced-motion: reduce\) \{ \.ff-feed-vload i \{ animation-duration: 2\.4s; \} \}/.test(css));
}

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
