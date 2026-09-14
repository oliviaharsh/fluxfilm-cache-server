/* Storefront layout checks (index.html is one big browser script). Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let parsed = true;
for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
ok('storefront script parses', parsed && scripts.length > 0);

// Floating WhatsApp bar used to cover Continue / Pay buttons: help now lives in the header + phone bottom menu.
ok('no floating WhatsApp bar', !/function WABar\(|createElement\(WABar/.test(html));
ok('header has WhatsApp support button + desktop menu', /className: "ff-help/.test(html) && /className: "ff-desk-nav"/.test(html));
ok('phone bottom menu only on home / plans / my plans / account', /function BottomNav\(/.test(html) && /showBnav && React.createElement\(BottomNav/.test(html) && /const BNAV_SCREENS = \{\s*home: 1,\s*dashboard: 1,\s*buy1: 1,\s*account: 1\s*\}/.test(html));
ok('checkout screens use the narrow centred column, lists use the wide one', /'ff-w-wide' : 'ff-w-flow'/.test(html) && /\.ff-w-flow \{ max-width: 620px; \}/.test(html));
ok('old phone-strip desktop layout removed', !/body::after/.test(html) && !/#root \{ max-width: 520px/.test(html));
ok('responsive grids for services and subscription cards', /className: "ff-grid-svc"/.test(html) && (html.match(/className: "ff-cards"/g) || []).length === 2);

// React hooks must never be called inside a loop (crashes when the plan list changes size).
const hookInLoop = /\.map\(\([^)]*\)\s*=>\s*\{\s*const \[[^\]]+\] = useState\(|\.map\(\w+\s*=>\s*\{[^{}]*const \[[^\]]+\] = useState\(/;
ok('service tiles are their own component (no useState inside .map)', /function ServiceTile\(/.test(html) && !hookInLoop.test(html.replace(/false && plans\.map[\s\S]*?\}\)\), React\.createElement\(Hint/, '')));

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
