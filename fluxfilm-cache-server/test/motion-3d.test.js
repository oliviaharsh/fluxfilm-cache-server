/* Storefront 3D motion: credentials reveal, payment / order / coupon / coins / steps, button presses.
   Checks the CSS rules that keep it light and keep fixed pop-ups working. No browser needed. Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

section('parse');
let parsed = true;
for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
ok('all inline scripts parse', parsed && scripts.length >= 3, scripts.length);

section('keyframes are GPU friendly');
const NAMES = ['ffSlideIn', 'ffSlideBack', 'ffCredLift', 'ffRowFlip', 'ffShineSweep', 'ffCoinSpin', 'ffRing', 'ffRise3d', 'ffTumble', 'ffTicketDrop', 'ffFlipIn', 'ffFlipY', 'ffStepPop'];
const kf = {};
for (const m of css.matchAll(/@keyframes (\w+) \{([\s\S]*?)\} \}/g)) kf[m[1]] = m[2];
ok('all motion keyframes exist', NAMES.every((n) => kf[n]), NAMES.filter((n) => !kf[n]));
const badProps = NAMES.filter((n) => kf[n] && !(kf[n].match(/([a-z-]+)\s*:/g) || []).every((p) => /^(transform|opacity)\s*:$/.test(p)));
ok('they animate transform / opacity only', badProps.length === 0, badProps);
ok('3D is real (perspective() inside the transform, rotateX/Y)', NAMES.filter((n) => /^ff(Slide|Cred|Row|Coin|Rise|Tumble|Ticket|Flip|Step)/.test(n)).every((n) => /perspective\(\d+px\)/.test(kf[n]) && /rotate[XY]\(/.test(kf[n])));

section('no transform left behind on containers (fixed pop-ups)');
const motionCss = css.slice(css.indexOf('/* ── 3D motion'), css.indexOf('/* ── Mobile hardening')).replace(/\/\*[\s\S]*?\*\//g, '');
ok('motion block found', motionCss.length > 500 && /\.ff-3d-cred \{/.test(motionCss));
const uses = [...(css.slice(0, css.indexOf('/* ── Splash')) + motionCss).matchAll(/animation:\s*(ff(?:Slide|Cred|Row|Shine|Coin|Ring|Rise|Tumble|Ticket|Flip|Step)\w*)[^;]*;/g)];
ok('every use of these keyframes is fill "backwards" (never forwards / both)', uses.length >= 15 && uses.every((u) => /\bbackwards;$/.test(u[0]) && !/\b(forwards|both)\b/.test(u[0])), uses.filter((u) => !/\bbackwards;$/.test(u[0])).map((u) => u[0]));
ok('no perspective / preserve-3d / will-change properties outside the splash', !/(^|[;{\s])perspective\s*:/.test(motionCss) && !/preserve-3d|will-change/.test(motionCss) && !/\.ff-slide[^{]*\{[^}]*(perspective\s*:|will-change)/.test(css));
ok('inline React styles add no perspective / will-change', !/\bperspective: ['"]|willChange:|transformStyle:/.test(html));

section('reduced motion + low-end phones');
const rm = (motionCss.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
const classes = ['.ff-3d-cred', '.ff-3d-cred > *', '.ff-3d-cred::after', '.ff-3d-badge', '.ff-3d-badge::before', '.ff-3d-rise', '.ff-3d-tumble', '.ff-3d-ticket', '.ff-3d-ticket::after', '.ff-3d-flipin', '.ff-3d-flipy', '.ff-coin.on .ff-coin-box', '.ff-coin.on .ff-coin-amt', '.ff-step.on .ff-step-n', '.ff-step.done .ff-step-n'];
ok('reduced motion turns every 3D animation off', classes.every((c) => rm.includes(c)) && /animation: none !important;/.test(rm), classes.filter((c) => !rm.includes(c)));
ok('reduced motion: presses become a flat scale', /\.ff-btn:active:not\(:disabled\), \.ff-tool:active, \.ff-coin:active \{ transform: scale\(\.98\) !important; \}/.test(rm));
ok('screen slide still off for reduced motion', /@media \(prefers-reduced-motion: reduce\) \{ \.ff-slide \{ animation: none; \} \}/.test(css));
ok('html.ff-lite trims the flourishes', /html\.ff-lite \.ff-3d-cred > \*, html\.ff-lite \.ff-3d-cred::after, html\.ff-lite \.ff-3d-ticket::after,\nhtml\.ff-lite \.ff-3d-badge::before, html\.ff-lite \.ff-3d-tumble \{ animation: none; \}/.test(motionCss));
const liteScript = scripts.find((s) => /ff-lite/.test(s) && !/ff-splash/.test(s));
ok('ff-lite detector is its own tiny script in <head>', liteScript && html.indexOf(liteScript) < html.indexOf('</head>'));
function runLite(nav, throwing) {
  const added = [];
  const document = { documentElement: { classList: { add: (c) => added.push(c) } } };
  const navigator = throwing ? { get hardwareConcurrency() { throw new Error('x'); } } : nav;
  new Function('navigator', 'document', liteScript)(navigator, document);
  return added;
}
ok('2-core phone → ff-lite', runLite({ hardwareConcurrency: 2 }).includes('ff-lite'));
ok('2 GB phone → ff-lite', runLite({ hardwareConcurrency: 8, deviceMemory: 2 }).includes('ff-lite'));
ok('normal phone / unknown values → full motion', runLite({ hardwareConcurrency: 8, deviceMemory: 4 }).length === 0 && runLite({}).length === 0);
ok('detector never throws', (() => { try { runLite(null, true); return true; } catch (e) { return false; } })());

section('wiring');
const fnSrc = (name, next) => html.slice(html.indexOf('function ' + name + '({'), html.indexOf('function ' + next + '({'));
const cred = fnSrc('CredCard', 'AccountCreateModal');
ok('credentials card lifts + rows flip (ff-3d-cred)', /return React\.createElement\(Card, \{\s*className: "ff-3d-cred"\s*\}/.test(cred));
ok('Card passes className through', /function Card\(\{[\s\S]{0,80}className\n\}\) \{[\s\S]{0,80}className: className/.test(html));
ok('credentials card holds no fixed pop-up', !/position: 'fixed'|ff-sheet|Modal/.test(cred));
const verify = html.slice(html.indexOf("if (phase === 'found') {"), html.indexOf("if (phase === 'fulfilling') {"));
ok('payment verified: 3D badge spin + rising title + tumbling emoji', /className: "ff-3d-badge"[\s\S]*"✅"/.test(verify) && /className: "ff-3d-rise"[\s\S]*"Payment Verified!"/.test(verify) && /className: "ff-3d-tumble"/.test(verify));
ok('emoji row no longer split into broken halves (was .split(\'\'))', /\['🎉', '🍿', '🎬'\]\.map/.test(verify) && !/'🎉🍿🎬'\.split/.test(html));
const done = fnSrc('DoneScreen', 'App');
const doneHead = done.slice(0, done.indexOf('postMsg && React.createElement(Card'));
ok('done screen: badge + title animate only when found (error keeps popIn)', /className: r\.found \? 'ff-3d-badge' : undefined/.test(doneHead) && /className: r\.found \? 'ff-3d-rise' : undefined/.test(doneHead) && /animation: r\.found \? undefined : 'popIn \.35s ease both'/.test(doneHead));
ok('done screen shows CredCard (so access gets the reveal)', /React\.createElement\(CredCard, \{/.test(done));
const pay = fnSrc('PayScreen', 'PayHelpScreen');
const ticket = pay.slice(pay.indexOf('className: "ff-3d-ticket"'), pay.indexOf('React.createElement(Card, null', pay.indexOf('className: "ff-3d-ticket"')));
ok('order created: amount card drops in like a ticket', ticket.length > 50 && /Amount to Pay/.test(ticket) && !/position: 'fixed'/.test(ticket));
const couponBtn = (html.match(/couponState\.applied \? React\.createElement\("span", \{\s*className: "ff-3d-flipy"\s*\}, "✅"\) : 'Apply'\)\), couponState\.msg && React\.createElement\("div", \{\s*key: couponState\.msg,\s*className: couponState\.applied \? 'ff-3d-flipin' : undefined,/g) || []).length;
ok('coupon applied (buy + renew): ✅ flips, message flips in, re-runs for each new message', couponBtn === 2, couponBtn);
ok('no old plain ✅ coupon button left', !/couponState\.applied \? '✅' : 'Apply'/.test(html));
ok('coins ticked: box flips + amount spins (CSS on .ff-coin.on)', /\.ff-coin\.on \.ff-coin-box \{ animation: ffFlipY/.test(motionCss) && /\.ff-coin\.on \.ff-coin-amt \{ animation: ffCoinSpin/.test(motionCss) && /className: 'ff-coin' \+ \(on \? ' on' : ''\)/.test(html));
ok('checkout steps: current / done dot flips', /\.ff-step\.on \.ff-step-n, \.ff-step\.done \.ff-step-n \{ animation: ffStepPop/.test(motionCss));
ok('buttons: Btn has ff-btn and a 3D press', /return React\.createElement\("button", \{\s*type: type,\s*className: "ff-btn",/.test(html) && /\.ff-btn:active:not\(:disabled\) \{ transform: perspective\(600px\) translate3d\(0,2px,-10px\) scale\(\.975\) !important; \}/.test(motionCss));
ok('tool tiles tilt on press; global button press kept', /\.ff-tool:active \{ transform: perspective\(700px\) rotateX\(7deg\) scale\(\.97\) !important; \}/.test(motionCss) && /button:active \{ transform: scale\(\.96\) !important; \}/.test(css));
ok('screen slide is a light 3D swing, short (0.2 s; 0.16 s on low-end phones — run 1 speed pass)', /@keyframes ffSlideIn \{ from \{ transform: perspective\(1400px\) translate3d\(30px,0,-24px\) rotateY\(-7deg\); opacity: 0; \}/.test(css) && /\.ff-slide \{ animation: ffSlideIn \.2s cubic-bezier\(\.2,\.8,\.3,1\) backwards; transform-origin: 50% 30%; \}/.test(css) && /html\.ff-lite \.ff-slide \{ animation-duration: \.16s; \}/.test(css));

section('timing');
const durs = [...motionCss.matchAll(/animation: ff\w+ \.(\d+)s[^;]*?(?: \.(\d+)s)? backwards;/g)].map((m) => Number('0.' + m[1]) + (m[2] ? Number('0.' + m[2]) : 0));
ok('every effect finishes within ~1.4 s', durs.length >= 12 && durs.every((d) => d <= 1.4), durs);

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
