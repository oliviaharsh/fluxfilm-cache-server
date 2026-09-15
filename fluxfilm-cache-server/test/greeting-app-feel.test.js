/* Customer feedback run 2: sassy animated greeting on My plans, app-like background + presses, admin on/off switch.
   Runs the greeting rules for real (no browser) and checks the CSS stays light. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

section('parse');
const bad = (list) => list.filter((s) => { try { new Function(s); return false; } catch (e) { console.log('   parse error:', e.message); return true; } });
ok('all storefront inline scripts parse', scripts.length >= 4 && bad(scripts).length === 0, scripts.length);
const adminScripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok('all admin inline scripts parse', adminScripts.length >= 1 && bad(adminScripts).length === 0);

section('greeting rules');
const gSrc = scripts.find((s) => /FF_GREETING_LINES/.test(s));
ok('greeting is its own small script in <head>', gSrc && html.indexOf(gSrc) < html.indexOf('</head>') && gSrc.length < 12000, gSrc && gSrc.length);
function load(opts) {
  opts = opts || {};
  const store = (m, throwing) => ({ getItem: (k) => { if (throwing) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { if (throwing) throw new Error('blocked'); m.set(k, String(v)); } });
  const listeners = {}; const classes = new Set();
  const document = { hidden: false, addEventListener: (t, f, o) => { listeners[t] = { f, o }; }, documentElement: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } } };
  const window = {};
  const ls = opts.ls || new Map(); const ss = opts.ss || new Map();
  new Function('window', 'document', 'localStorage', 'sessionStorage', gSrc)(window, document, store(ls, opts.throwing), store(ss, opts.throwing));
  return { window, document, listeners, classes, ls, ss };
}
const W = load().window;
const g = (ctx) => W.ffGreeting(ctx);
const wed = (h) => new Date(2026, 8, 16, h, 10); // Wed 16 Sep 2026 (no festival)
const HOUR = 3600e3, DAY = 86400e3;
const recent = (d) => d.getTime() - HOUR;

let r = g({ name: 'Yahya Khan', now: wed(19), lastSeen: recent(wed(19)), subs: [{ service: 'Netflix', daysLeft: 2 }, { service: 'Prime Video', daysLeft: 20 }] });
ok('plan ending in ≤3 days → reminder with service + days + first name kept elsewhere', r.key === 'ending' && /Netflix/.test(r.text) && /\b2\b/.test(r.text) && r.kick === 'Heads up', r);
ok('customer example line exists: "don\'t leave me on read 👀"', W.FF_GREETING_LINES.ending.some((l) => /don't leave me on read/.test(l[0]) && l[1] === '👀'));
r = g({ name: 'Yahya', now: wed(19), lastSeen: recent(wed(19)), subs: [{ service: 'JioHotstar', daysLeft: 1 }, { service: 'Netflix', daysLeft: 3 }] });
ok('1 day left → "tomorrow" line for the soonest plan', r.key === 'ending1' && /JioHotstar/.test(r.text) && /tomorrow/.test(r.text), r);
r = g({ name: 'Yahya', now: wed(19), lastSeen: recent(wed(19)), subs: [{ service: 'Netflix', daysLeft: 5 }, { service: 'Zee5', daysLeft: -3 }, { service: 'Sony', daysLeft: 0 }] });
ok('5 days left / expired plans → no reminder', r.key === 'evening', r);
r = g({ name: 'Yahya', now: wed(10), lastSeen: recent(wed(10)), subs: [{ service: 'Netflix', daysLeft: 30, startDate: new Date(wed(10).getTime() - DAY).toISOString() }] });
ok('plan started in the last 2 days → just bought / renewed line', r.key === 'renewed' && r.kick === 'Nice one', r);
r = g({ name: 'Yahya', now: wed(10), lastSeen: recent(wed(10)), subs: [{ service: 'Netflix', daysLeft: 20, startDate: new Date(wed(10).getTime() - 10 * DAY).toISOString() }] });
ok('older plan → not "renewed"', r.key === 'morning', r);
r = g({ name: 'Yahya', now: wed(21), lastSeen: wed(21).getTime() - 5 * DAY, subs: [] });
ok('away 3+ days → "Missed me??" style line', r.key === 'away' && r.kick === 'Welcome back', r);
const awayTexts = [0, 1, 2].map((k) => g({ name: 'Yahya', now: wed(21), lastSeen: wed(21).getTime() - 5 * DAY, skip: k }).text);
ok('away lines rotate on tap and include the customer\'s example + days', awayTexts.includes('Missed me?? Here we go again!!') && awayTexts.some((t) => /^5 days without me, Yahya\?/.test(t)) && new Set(awayTexts).size === 3, awayTexts);
r = g({ name: 'Yahya', now: wed(21), lastSeen: wed(21).getTime() - 2 * DAY });
ok('away only 2 days → normal time-of-day line', r.key === 'evening', r);
r = g({ name: 'Yahya', now: wed(12), lastSeen: null });
ok('first visit on this phone → welcome line', r.key === 'first', r);
ok('time of day buckets', [[2, 'lateNight'], [4, 'lateNight'], [5, 'morning'], [11, 'morning'], [12, 'afternoon'], [16, 'afternoon'], [17, 'evening'], [21, 'evening'], [22, 'night'], [23, 'night']].every(([h, k]) => g({ name: 'A', now: wed(h), lastSeen: recent(wed(h)) }).key === k));
ok('late night line: "Binge o\'clock 🌙"', g({ name: 'A', now: wed(1), lastSeen: recent(wed(1)) }).kick === "Binge o'clock" && W.FF_GREETING_LINES.lateNight.some((l) => /Binge o'clock/.test(l[0]) && l[1] === '🌙'));
const sat = new Date(2026, 8, 19, 19, 0); // Saturday
const satKeys = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((seed) => g({ name: 'A', now: sat, lastSeen: recent(sat), seed }).key));
ok('weekend evening → weekend line for some customers, evening for others', satKeys.has('weekend') && satKeys.has('evening') && satKeys.size === 2, [...satKeys]);
ok('weekend never replaces the late-night line', ['1', '2', '3', '4', '5', '6'].every((seed) => g({ name: 'A', now: new Date(2026, 8, 19, 2, 0), lastSeen: recent(new Date(2026, 8, 19, 2, 0)), seed }).key === 'lateNight'));
r = g({ name: 'Yahya', now: new Date(2026, 7, 15, 9, 0), lastSeen: recent(new Date(2026, 7, 15, 9, 0)) });
ok('festival every year (15 Aug)', r.key === 'festival' && /Independence Day, Yahya/.test(r.text) && r.emoji === '🇮🇳', r);
r = g({ name: 'Yahya', now: new Date(2026, 10, 8, 20, 0), lastSeen: null });
ok('festival with a fixed year (Diwali 2026) beats first visit', r.key === 'festival' && /Diwali/.test(r.text), r);
ok('Diwali 2027 not guessed from 2026', g({ name: 'Y', now: new Date(2027, 10, 8, 20, 0), lastSeen: recent(new Date(2027, 10, 8, 20, 0)) }).key !== 'festival');
r = g({ name: 'Yahya', now: new Date(2026, 7, 15, 9, 0), lastSeen: recent(new Date(2026, 7, 15, 9, 0)), subs: [{ service: 'Netflix', daysLeft: 2 }] });
ok('plan reminder beats a festival', r.key === 'ending', r);

section('stable, safe, owner switch');
const ctx = { name: 'Yahya', now: wed(19), lastSeen: recent(wed(19)), seed: '9876543210' };
ok('same customer + same day → same line (no flicker on re-render)', g(ctx).text === g(Object.assign({}, ctx)).text);
const pool = W.FF_GREETING_LINES.evening.length;
ok('tapping cycles through every line of the bucket', new Set(Array.from({ length: pool }, (_, k) => g(Object.assign({}, ctx, { skip: k })).text)).size === pool && g(Object.assign({}, ctx, { skip: pool })).text === g(ctx).text);
r = g({ name: 'Yahya', now: wed(19), lastSeen: wed(19).getTime() - 9 * DAY, subs: [{ service: 'Netflix', daysLeft: 1 }], sassy: false });
ok('sassy OFF (admin) → plain "Welcome back, Yahya 👋" even with a plan ending', r.key === 'plain' && r.text === 'Welcome back, Yahya' && r.emoji === '👋', r);
ok('names: first word, capitalised; empty / "User" → friend; markup stripped; long names cut', g({ name: 'yahya khan', now: wed(9), lastSeen: null }).text.includes('Yahya') && g({ name: '', sassy: false }).text === 'Welcome back, friend' && g({ name: 'User', sassy: false }).text === 'Welcome back, friend' && g({ name: '<b>Ravi', sassy: false }).text === 'Welcome back, BRavi' && g({ name: 'Abcdefghijklmnopqrst', sassy: false }).text === 'Welcome back, Abcdefghijklmn');
ok('never throws on bad input', ['plain', 'first', 'evening', 'morning', 'afternoon', 'night', 'lateNight', 'weekend', 'away', 'festival'].includes(g(null).key) && typeof g({ now: 'x', subs: 'no', lastSeen: 'abc' }).text === 'string' && typeof g(undefined).emoji === 'string');
const L = W.FF_GREETING_LINES;
const allLines = Object.keys(L).filter((k) => k !== 'festivals').flatMap((k) => L[k]).concat(Object.values(L.festivals));
ok('every line = [text, emoji], only {name}/{service}/{days} placeholders', allLines.length >= 30 && allLines.every((l) => Array.isArray(l) && typeof l[0] === 'string' && l[1] && !/\{(?!name\}|service\}|days\})/.test(l[0])), allLines.filter((l) => /\{(?!name\}|service\}|days\})/.test(l[0])));
ok('lines stay short enough for a phone card (≤ 60 chars before the name)', allLines.every((l) => l[0].replace(/\{name\}/g, '').length <= 60), allLines.filter((l) => l[0].replace(/\{name\}/g, '').length > 60));
ok('family friendly (no rude words)', allLines.every((l) => !/\b(damn|hell|stupid|idiot|shut up|sexy|kill|hate|bc|pagal|bewakoof)\b/i.test(l[0])));
ok('every bucket has a kicker', ['first', 'ending', 'ending1', 'renewed', 'away', 'lateNight', 'morning', 'afternoon', 'evening', 'night', 'weekend', 'festival', 'plain'].every((k) => typeof W.FF_GREETING_KICK[k] === 'string'));
ok('all placeholders replaced in real output', ['ending', 'away', 'renewed'].every(() => true) && [g({ name: 'A', now: wed(19), lastSeen: recent(wed(19)), subs: [{ service: 'Netflix', daysLeft: 2 }], skip: 1 }), g({ name: 'A', now: wed(19), lastSeen: wed(19).getTime() - 4 * DAY, skip: 1 })].every((x) => !/[{}]/.test(x.text)));

section('last visit memory');
const ls = new Map(); let ss = new Map();
let S = load({ ls, ss });
let v = S.window.ffGreetingVisit(1000);
ok('first ever visit → lastSeen null, remembers now', v.lastSeen === null && ls.get('ff_last_seen') === '1000');
v = S.window.ffGreetingVisit(5000);
ok('same browser session → still the visit before this session (no "first" → "normal" flip)', v.lastSeen === null && ls.get('ff_last_seen') === '5000');
ss = new Map(); S = load({ ls, ss });
v = S.window.ffGreetingVisit(9000);
ok('new session → lastSeen = the previous visit', v.lastSeen === 5000);
S = load({ throwing: true });
ok('blocked storage → never throws, never "first visit"', S.window.ffGreetingVisit(7).lastSeen === 7);
S = load();
ok('iOS press states: passive touchstart listener (never blocks scrolling)', S.listeners.touchstart && S.listeners.touchstart.o && S.listeners.touchstart.o.passive === true);
S.document.hidden = true; S.listeners.visibilitychange.f();
ok('hidden tab → html.ff-hidden (pauses the card shapes)', S.classes.has('ff-hidden'));
S.document.hidden = false; S.listeners.visibilitychange.f();
ok('visible again → class removed', !S.classes.has('ff-hidden'));

section('My plans greeting card wiring');
const dash = html.slice(html.indexOf('function DashboardScreen({'), html.indexOf('\nfunction ', html.indexOf('function DashboardScreen({')));
ok('old static "Welcome back, <br> Name 👋" is gone', !/"Welcome back,", React\.createElement\("br", null\), first, " 👋"/.test(html));
ok('card uses ffGreeting with name, plans, last visit, owner switch, phone seed, taps', /window\.ffGreeting\(\{\s*name,\s*subs: allSubs,\s*lastSeen: helloVisit\.lastSeen,\s*sassy,\s*seed: normPhone_\(phone \|\| ''\),\s*skip: helloTap\s*\}\)/.test(dash));
ok('last visit read once per mount (useState initializer)', /const \[helloVisit\] = useState\(\(\) => window\.ffGreetingVisit \?/.test(dash));
ok('tap on the line → next line (only when sassy)', /onClick: \(\) => sassy && setHelloTap\(n => n \+ 1\)/.test(dash) && /"aria-live": "polite"/.test(dash));
ok('words re-animate when the line changes (key = tap + text); last word + emoji kept together', /key: helloTap \+ '\|' \+ hello\.text/.test(dash) && /className: "ff-hello-end"/.test(dash) && /animationDelay: Math\.min\(i \* 45, 450\) \+ 'ms'/.test(dash));
ok('refresh button + avatar → Account kept', /className: "ff-hello-refresh",\s*onClick: handleRefresh,\s*disabled: refreshing/.test(dash) && /className: "ff-hello-av",[\s\S]{0,120}onClick: \(\) => nav\('account'/.test(dash));
ok('stats cards (Total / Active / Expiring) unchanged', /className: "ff-dash-stats",\s*style: \{\s*display: 'grid',\s*gridTemplateColumns: '1fr 1fr 1fr',\s*gap: 10,\s*marginBottom: 12\s*\}\s*\}, \[\{\s*label: 'Total',\s*val: allSubs\.length,/.test(dash) && /label: 'Active',\s*val: active,\s*color: C\.green,/.test(dash) && /label: 'Expiring',\s*val: expiring,\s*color: C\.amber,/.test(dash));
ok('App passes the admin switch (default ON when status unknown)', /screen === 'dashboard' && React\.createElement\(DashboardScreen, \{\s*nav: nav,\s*sassy: !\(storeStatus && storeStatus\.sassy === false\),/.test(html) && /autoOpenOtp,\s*sassy = true\s*\}\) \{/.test(html));
ok('section headers get the brand bar class', /function SectionHead\(\{[\s\S]{0,80}className: "ff-sechead"/.test(html));

section('CSS: light + app-like');
const block = css.slice(css.indexOf('/* ── 📱 App feel'));
ok('app feel block found at the end of the styles', block.length > 3000 && css.indexOf('/* ── 📱 App feel') > css.indexOf('/* ── Mobile hardening'));
const blockNoComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
ok('no backdrop blur / will-change / filter animations added', !/backdrop-filter|will-change/.test(blockNoComments));
const kf = {}; for (const m of block.matchAll(/@keyframes (\w+) \{([\s\S]*?)\} \}/g)) kf[m[1]] = m[2];
ok('new keyframes animate transform / opacity only', ['ffHelloFloat', 'ffHelloIn', 'ffHelloWord', 'ffHelloWave', 'ffNavPop'].every((n) => kf[n] && (kf[n].match(/([a-z-]+)\s*:/g) || []).every((p) => /^(transform|opacity)\s*:$/.test(p))), Object.keys(kf));
const dur = (sel) => { const m = block.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*animation: \\w+ ([.\\d]+)s[^;]*?(?: ([.\\d]+)s)?[^;]*;')); return m ? Number(m[1]) + Number(m[2] || 0) : 99; };
ok('greeting animation finishes within 0.9 s (words .34 s + ≤ .45 s stagger, emoji wave)', dur('.ff-hello-w') + 0.45 <= 0.9 && dur('.ff-hello-emo') <= 0.9 && dur('.ff-hello-kick') <= 0.9, [dur('.ff-hello-w'), dur('.ff-hello-emo')]);
ok('floating shapes: slow, a fixed number of loops (then rest), even count so they end where they started', /\.ff-hello-orb\.a \{[^}]*animation: ffHelloFloat 9s ease-in-out 4 alternate;/.test(block) && /\.ff-hello-orb\.b \{[^}]*animation: ffHelloFloat 11s ease-in-out 4 alternate-reverse;/.test(block) && !/ffHelloFloat[^;]*infinite/.test(block));
ok('paused while the tab is hidden', /html\.ff-hidden \.ff-hello-orb \{ animation-play-state: paused; \}/.test(block));
ok('low-end phones (ff-lite): card is still', /html\.ff-lite \.ff-hello-orb, html\.ff-lite \.ff-hello-kick, html\.ff-lite \.ff-hello-w, html\.ff-lite \.ff-hello-emo \{ animation: none; \}/.test(block));
const rm = (block.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
ok('reduced motion: all greeting + menu motion off', /\.ff-hello-orb, \.ff-hello-kick, \.ff-hello-w, \.ff-hello-emo, \.ff-bnav-btn\.on \.ff-bnav-ic \{ animation: none !important; \}/.test(rm) && /transition: none;/.test(rm));
ok('no layout jump: the line keeps room for two lines', /\.ff-hello-line \{[^}]*min-height: 2\.44em;/.test(block));
ok('page glow is a static background (no animation, no extra fixed layer)', /^html \{ background: radial-gradient\(/m.test(block) && /body \{ background: transparent; \}/.test(block) && !/^html \{[^}]*animation/m.test(block) && !/ff-bg/.test(html));
ok('bottom menu: active pill grows in, icon pops', /\.ff-bnav-btn::before \{[^}]*transform: scale\(\.7\);[^}]*transition: opacity \.18s ease, transform \.24s/.test(block) && /\.ff-bnav-btn\.on::before \{ opacity: 1; transform: none; \}/.test(block) && /\.ff-bnav-btn\.on \{ background: none; \}/.test(block));

section('presses: no blue flash, keyboard ring kept');
ok('tap highlight transparent on the page, buttons, links, roles', /html \{ -webkit-tap-highlight-color: transparent; \}/.test(block) && /a, button, input, select, textarea, label, summary, \[role="button"\], \[role="tab"\] \{ -webkit-tap-highlight-color: transparent; \}/.test(block));
ok('mouse / touch focus box hidden, keyboard :focus-visible ring kept', /:focus:not\(:focus-visible\) \{ outline: none; \}/.test(block) && /button:focus-visible[^{]*\{ outline: 3px solid rgba\(22,163,74,\.55\); outline-offset: 2px; \}/.test(block) && !/:focus-visible \{[^}]*outline: none/.test(block));
const noSel = (block.match(/\n([^\n{]*) \{ -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; \}/) || ['', ''])[1];
ok('no text selection on buttons / nav / tappable cards …', ['button', '[role="button"]', '.ff-bnav-btn', '.ff-tool', '.ff-acard', '.ff-feed-tile'].every((s) => noSel.split(', ').includes(s)), noSel);
ok('… but never on things customers copy (codes, logins, inputs)', !/ff-coupon-code|ff-ref-code|ff-3d-cred|input|textarea|\bspan\b|\bdiv\b|\bp\b|\*/.test(noSel));
ok('press-in: scale .96, 100 ms, transform-based; old .98 rule removed', /button \{ transition: transform \.1s ease, filter \.1s ease; \}/.test(block) && /button:active \{ transform: scale\(\.96\) !important; \}/.test(block) && !/button:active \{ transform: scale\(\.98\) !important; \}/.test(css));
ok('slight darken only on enabled buttons, low specificity so special presses win', /button:active:where\(:not\(:disabled\)\) \{ filter: brightness\(\.94\); \}/.test(block));
ok('3D presses from before still win (.ff-btn / .ff-tool)', /\.ff-btn:active:not\(:disabled\) \{ transform: perspective\(600px\)/.test(css) && /\.ff-tool:active \{ transform: perspective\(700px\) rotateX\(7deg\) scale\(\.97\) !important; \}/.test(css));
ok('centred search clear button keeps its position while pressed', /\.ff-feed-find button:active \{ transform: translateY\(-50%\) scale\(\.9\) !important; \}/.test(block));
ok('wide rows + bottom menu get gentler presses', /\.ff-arow:active, \.ff-feed-cta:active, \.ff-hello-line:active, \.ff-feed-play:active \{ transform: scale\(\.985\) !important; \}/.test(block) && /\.ff-bnav-btn:active \{ transform: scale\(\.92\) !important; filter: none; \}/.test(block));
ok('admin panel: same press feel, no blue flash, keyboard ring', /html\{-webkit-tap-highlight-color:transparent\}/.test(admin) && /:focus:not\(:focus-visible\)\{outline:none\}/.test(admin) && /\.btn:focus-visible[^{]*\{outline:3px solid/.test(admin) && /:where\(button,\.btn\):active:not\(:disabled\)\{transform:scale\(\.96\);filter:brightness\(\.94\)\}/.test(admin) && /button,\.btn,\[role="button"\]\{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none\}/.test(admin));

section('admin switch: Sassy greeting ON / OFF');
const settings = {};
const mockDb = { query: async (sql, p) => { sql = sql.replace(/\s+/g, ' ').trim(); if (/^SELECT value FROM app_settings/.test(sql)) return settings[p[0]] ? [{ value: settings[p[0]] }] : []; if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return {}; } return []; } };
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const store = require('../store');
(async () => {
  ok('default ON (public status says sassy: true)', (await store.getStatus()).sassy === true && store.DEFAULTS.sassyGreeting === true);
  settings.store = JSON.stringify({ paused: false, message: 'x', backText: '' }); store._internal.reset();
  ok('settings saved before this change → still ON', (await store.getStatus()).sassy === true);
  let r = await store.saveSettings({ sassyGreeting: false });
  ok('OFF saved, reported as the only change, pause untouched', r.ok && r.settings.sassyGreeting === false && r.changed.join() === 'sassyGreeting' && r.settings.paused === false, r);
  ok('public status → sassy: false (no other fields leak)', (await store.getStatus()).sassy === false && (await store.getStatus()).message === '');
  r = await store.saveSettings({ paused: true });
  ok('pausing keeps the greeting switch', r.settings.sassyGreeting === false && (await store.getStatus()).sassy === false);
  await store.saveSettings({ paused: false });
  ok('"true" / "off" strings from forms', (await store.saveSettings({ sassyGreeting: 'true' })).settings.sassyGreeting === true && (await store.saveSettings({ sassyGreeting: 'off' })).settings.sassyGreeting === false);

  const routes = {}; const audits = [];
  require('../adminstore').mount({ get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } }, { auth: () => true, store, audit: { record: (req, a) => audits.push(a) } });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } }; routes[m + ' ' + p]({ body }, res); });
  let x = await call('POST', '/admin/api/store', { sassyGreeting: true });
  ok('admin turns it ON → change log "Sassy greeting … ON" (not "maintenance")', x.body.ok && audits.length === 1 && audits[0].action === 'store.greeting' && /Sassy greeting on My plans ON/.test(audits[0].summary), audits);
  x = await call('POST', '/admin/api/store', { sassyGreeting: true });
  ok('no change → no log', audits.length === 1);
  x = await call('POST', '/admin/api/store', { paused: true });
  ok('pause still logged as before', audits.length === 2 && /PAUSED/.test(audits[1].summary));
  await call('POST', '/admin/api/store', { paused: false });
  ok('admin 🚧 Maintenance screen: checkbox saves at once + toast + reverts on error', /id="mtsass"' \+ \(s\.sassyGreeting !== false \? ' checked' : ''\)/.test(admin) && /post\('\/admin\/api\/store', \{ sassyGreeting: on \}\)/.test(admin) && /box\.checked = !on;/.test(admin));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
