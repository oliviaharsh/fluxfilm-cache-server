/* Payment fallback UI: storefront PayHelpScreen (every state, rendered with a tiny fake React) and the
 * admin 💸 Payments claim cards. No browser needed. Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function spacedName_(');
const end = html.indexOf('function VerifyScreen(');
ok('PayHelpScreen found in index.html', start > 0 && end > start);
const src = html.slice(start, end);

// ---- tiny fake React: elements are plain objects; hooks come from a script per render ----
const el = (t, p, ...c) => ({ t, p: p || {}, c: c.flat(Infinity) });
const Comp = (name) => { const f = function (props) { return el(name, props, props.children); }; f.compName = name; return f; };
function harness(initial) {
  const H = { effects: [], timers: [], sets: [], api: [], navs: [], opened: [] };
  let i = 0;
  const order = ['info', 'phase', 'name', 'knownName', 'utr', 'formMsg', 'busy', 'claim', 'copied'];
  const React = { createElement: el, Fragment: 'Fragment' };
  const useState = (d) => { const key = order[i++]; const v = key in initial ? initial[key] : d; return [v, (x) => H.sets.push([key, x])]; };
  const useEffect = (fn) => H.effects.push(fn);
  const useRef = (v) => ({ current: v });
  const API = new Proxy({}, { get: (_, name) => (...a) => H.api.push([name, a]) });
  const fakeWindow = { open: (u) => H.opened.push(u), location: {} }; H.window = fakeWindow;
  const factory = new Function('React', 'useState', 'useEffect', 'useRef', 'Card', 'Btn', 'Hint', 'Slide', 'C', 'PJS', 'WA_SUPPORT_LINK', 'getFFSession', 'localStorage', 'API', 'window', 'setTimeout', 'clearTimeout', 'navigator', 'document',
    src + '; return { PayHelpScreen, spacedName_ };');
  const mod = factory(React, useState, useEffect, useRef, Comp('Card'), Comp('Btn'), Comp('Hint'), Comp('Slide'), { text: '#000', muted: '#666', border: '#eee', borderMd: '#ddd', green: '#0a0' }, 'sans', 'https://wa.me/x',
    () => ({ phone: '9876543210' }), { getItem: () => '' }, API, fakeWindow, (fn, ms) => { H.timers.push([fn, ms]); return H.timers.length; }, () => {}, {}, {});
  H.mod = mod;
  H.render = (props) => mod.PayHelpScreen(Object.assign({ nav: (s, d) => H.navs.push([s, d]), goBack: () => H.navs.push(['back']), orderId: 'FF9123456', service: 'Netflix', accessToken: 'tok', phone: '' }, props || {}));
  return H;
}
// Render function components (Card/Btn/...) are kept as nodes; walk everything for text + handlers.
function texts(node, out) { out = out || []; if (node == null || node === false) return out; if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; } if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; } if (typeof node === 'object') { (node.c || []).forEach((n) => texts(n, out)); } return out; }
const textOf = (tree) => texts(tree).join(' ');
function find(node, pred, out) { out = out || []; if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; } if (pred(node)) out.push(node); (node.c || []).forEach((n) => find(n, pred, out)); return out; }
const buttonWith = (tree, re) => find(tree, (n) => ((n.t && n.t.compName === 'Btn') || n.t === 'button') && re.test(textOf(n)))[0];
const INFO = { ok: true, enabled: true, orderId: 'FF9123456', amount: 139, vpa: 'fluxfilm@upi', payee: 'FluxFilm', qrImage: 'data:image/png;base64,AAA', upiLink: 'upi://pay?pa=fluxfilm@upi&pn=FluxFilm&cu=INR', lastClaim: null };

(async () => {
  section('helpers');
  let H = harness({});
  ok('name shown back in capitals, dots/spaces cleaned', H.mod.spacedName_(' rahul  k. sharma ') === 'RAHUL K SHARMA');

  section('loading → pay');
  H = harness({ phase: 'loading' });
  let tree = H.render();
  ok('loading text', /Loading backup payment details/.test(textOf(tree)));
  H.effects[0]();
  const call = H.api.find((x) => x[0] === 'getBackupPayment');
  ok('asks for backup details with the order proof (token + phone)', call && call[1][0] === 'FF9123456' && call[1][1].token === 'tok' && call[1][1].phone === '9876543210', call);
  call[1][2](INFO);
  ok('→ pay phase', H.sets.some((s) => s[0] === 'phase' && s[1] === 'pay'));
  H = harness({ phase: 'loading' }); H.render(); H.effects[0]();
  H.api[0][1][2](Object.assign({}, INFO, { lastClaim: { ok: true, status: 'REVIEW', payerName: 'RAHUL SHARMA' } }));
  ok('coming back with an open claim → status phase', H.sets.some((s) => s[0] === 'phase' && s[1] === 'status') && H.sets.some((s) => s[0] === 'claim'));
  H = harness({ phase: 'loading' }); H.render(); H.effects[0]();
  H.api[0][1][2](Object.assign({}, INFO, { paid: true }));
  ok('already paid → goes to verify', H.navs[0] && H.navs[0][0] === 'verify' && H.navs[0][1].orderId === 'FF9123456');
  H = harness({ phase: 'loading' }); H.render(); H.effects[0]();
  H.api[0][1][2]({ ok: false, message: 'Please open this order on the phone number you used to buy.' });
  ok('refused → error phase', H.sets.some((s) => s[0] === 'phase' && s[1] === 'error'));

  section('pay phase');
  H = harness({ phase: 'pay', info: INFO });
  tree = H.render();
  const t = textOf(tree);
  ok('simple explanation', /Payment not going through\?/.test(t) && /limit reached/.test(t) && /Your money is safe/.test(t) && /No need to pay twice/.test(t));
  ok('amount, backup UPI ID, payee', /₹139/.test(t) && /fluxfilm@upi/.test(t) && /FluxFilm/.test(t));
  const img = find(tree, (n) => n.t === 'img')[0];
  ok('uploaded QR image is shown', img && img.p.src === INFO.qrImage);
  H = harness({ phase: 'pay', info: Object.assign({}, INFO, { qrImage: '' }) });
  ok('no uploaded QR → QR drawn from the UPI link', /create-qr-code.*upi%3A%2F%2Fpay/.test(find(H.render(), (n) => n.t === 'img')[0].p.src));
  H = harness({ phase: 'pay', info: INFO }); tree = H.render();
  const copyBtns = find(tree, (n) => n.t === 'button' && /Copy/.test(textOf(n)));
  ok('copy buttons for amount + UPI ID', copyBtns.length === 2);
  buttonWith(tree, /Open UPI app/).p.onClick();
  ok('Open UPI app uses the backup link (no amount/note)', H.window.location.href === INFO.upiLink);
  buttonWith(tree, /I've paid/).p.onClick();
  ok("I've paid → form", H.sets.some((s) => s[0] === 'phase' && s[1] === 'form'));

  section('form + name confirm');
  H = harness({ phase: 'form', info: INFO, name: '', utr: '' }); tree = H.render();
  ok('form asks for UPI-app name (required) and optional UTR', /Your name as shown in your UPI app/.test(textOf(tree)) && /optional/.test(textOf(tree)) && find(tree, (n) => n.p && n.p['data-ff'] === 'payer-name').length === 1);
  buttonWith(tree, /Continue/).p.onClick();
  ok('empty name → message, stays', H.sets.some((s) => s[0] === 'formMsg' && /exactly as it shows/.test(s[1])) && !H.sets.some((s) => s[0] === 'phase'));
  H = harness({ phase: 'form', info: INFO, name: 'Rahul Sharma', utr: '1234' }); buttonWith(H.render(), /Continue/).p.onClick();
  ok('short UTR → message', H.sets.some((s) => s[0] === 'formMsg' && /12 digits/.test(s[1])));
  H = harness({ phase: 'form', info: INFO, name: 'rahul sharma', utr: '' }); buttonWith(H.render(), /Continue/).p.onClick();
  ok('good name → confirm', H.sets.some((s) => s[0] === 'phase' && s[1] === 'confirm'));
  H = harness({ phase: 'confirm', info: INFO, name: 'rahul  k. sharma', utr: '4258 1234 5678' }); tree = H.render();
  const shown = find(tree, (n) => n.p && n.p['data-ff'] === 'name-confirm')[0];
  ok('asks "Is this exactly your name…" with the name in capitals', /Is this exactly your name in your UPI app\?/.test(textOf(tree)) && textOf(shown) === 'RAHUL K SHARMA' && /425812345678/.test(textOf(tree)));
  buttonWith(tree, /Yes, that's right/).p.onClick();
  const claim = H.api.find((x) => x[0] === 'claimManualPayment');
  ok('Yes → sends order, proof, name, digits-only UTR', claim && claim[1][0] === 'FF9123456' && claim[1][1].token === 'tok' && claim[1][2] === 'rahul  k. sharma' && claim[1][3] === '425812345678', claim);
  claim[1][4]({ ok: true, status: 'WAITING', message: 'Looking…', payerName: 'RAHUL K SHARMA' });
  ok('→ status phase', H.sets.some((s) => s[0] === 'phase' && s[1] === 'status'));
  H = harness({ phase: 'confirm', info: INFO, name: 'x y', utr: '' }); tree = H.render(); buttonWith(tree, /Yes, that's right/).p.onClick();
  H.api.find((x) => x[0] === 'claimManualPayment')[1][4]({ ok: false, field: 'name', message: 'Please type your name exactly as it shows in your UPI app.' });
  ok('server says name problem → back to form with message', H.sets.some((s) => s[0] === 'phase' && s[1] === 'form') && H.sets.some((s) => s[0] === 'formMsg'));
  H = harness({ phase: 'confirm', info: INFO, name: 'Rahul', utr: '' }); buttonWith(H.render(), /No, change it/).p.onClick();
  ok('No → form', H.sets.some((s) => s[0] === 'phase' && s[1] === 'form'));

  section('remembered name from the last payment');
  H = harness({ phase: 'loading', info: null }); H.render(); H.effects[0]();
  H.api.find((x) => x[0] === 'getBackupPayment')[1][2](Object.assign({}, INFO, { knownName: 'HARSH WALIA' }));
  ok('name pre-filled from the server', H.sets.some((s) => s[0] === 'knownName' && s[1] === 'HARSH WALIA') && H.sets.some((s) => s[0] === 'name' && s[1] === 'HARSH WALIA'));
  H = harness({ phase: 'pay', info: INFO, knownName: 'HARSH WALIA', name: 'HARSH WALIA' }); buttonWith(H.render(), /I've paid/).p.onClick();
  ok("I've paid → straight to the confirm step (no typing again)", H.sets.some((s) => s[0] === 'phase' && s[1] === 'confirm') && !H.sets.some((s) => s[0] === 'phase' && s[1] === 'form'));
  H = harness({ phase: 'confirm', info: INFO, knownName: 'HARSH WALIA', name: 'HARSH WALIA', utr: '' }); tree = H.render();
  ok('confirm says "same name as last time"', /Paying with the same name as last time\?/.test(textOf(tree)) && textOf(find(tree, (n) => n.p && n.p['data-ff'] === 'name-confirm')[0]) === 'HARSH WALIA');
  buttonWith(tree, /Change it \/ add UTR/).p.onClick();
  ok('Change it → form (name already filled in, can edit or add UTR)', H.sets.some((s) => s[0] === 'phase' && s[1] === 'form'));
  H = harness({ phase: 'confirm', info: INFO, knownName: 'HARSH WALIA', name: 'HARSH WALIA', utr: '' }); buttonWith(H.render(), /Yes, that's right/).p.onClick();
  ok('Yes → claim sent with the remembered name', (H.api.find((x) => x[0] === 'claimManualPayment') || [0, []])[1][2] === 'HARSH WALIA');
  H = harness({ phase: 'pay', info: INFO, knownName: '', name: '' }); buttonWith(H.render(), /I've paid/).p.onClick();
  ok('no remembered name → the normal form', H.sets.some((s) => s[0] === 'phase' && s[1] === 'form'));

  section('status states');
  const status = (st, extra) => { const h = harness({ phase: 'status', info: INFO, claim: Object.assign({ ok: true, status: st, payerName: 'RAHUL SHARMA', message: 'msg-' + st }, extra || {}) }); const tr = h.render(); return { h, tr, text: textOf(tr), node: find(tr, (n) => n.p && n.p['data-ff'] === 'claim-status')[0] }; };
  let S = status('WAITING');
  ok('waiting: looking + fix details + WhatsApp', S.node.p['data-status'] === 'WAITING' && /Looking for your payment/.test(S.text) && /Fix my name/.test(S.text) && /WhatsApp/.test(S.text));
  S.h.effects[1]();
  ok('waiting polls every 4 s', S.h.timers.length === 1 && S.h.timers[0][1] === 4000);
  S.h.timers[0][0]();
  const poll = S.h.api.find((x) => x[0] === 'getClaimStatus');
  ok('poll asks claim status with proof', poll && poll[1][0] === 'FF9123456' && poll[1][1].token === 'tok');
  poll[1][2]({ ok: true, status: 'MATCHED', paid: true });
  ok('poll result updates the claim', S.h.sets.some((s) => s[0] === 'claim' && s[1].status === 'MATCHED'));
  S = status('REVIEW');
  S.h.effects[1]();
  ok('review: calm message, WhatsApp, polls slowly', /FluxFilm will check your payment/.test(S.text) && /WhatsApp/.test(S.text) && S.h.timers[0][1] === 20000);
  S = status('MATCHED', { paid: true });
  S.h.effects[1]();
  ok('matched: payment found, then goes to verify/fulfil', /Payment found!/.test(S.text) && S.h.timers[0][1] === 1600 && (S.h.timers[0][0](), S.h.navs[0][0] === 'verify'));
  S = status('REJECTED');
  S.h.effects[1]();
  ok("rejected: can't find, send different details, no polling", /couldn't find this payment/.test(S.text) && /Send different details/.test(S.text) && S.h.timers.length === 0);
  buttonWith(S.tr, /WhatsApp/).p.onClick();
  ok('WhatsApp button opens support link', S.h.opened[0] === 'https://wa.me/x');

  section('wiring in index.html');
  ok('pay screen button → payhelp', /data-ff": "pay-help"[\s\S]{0,80}nav\('payhelp'/.test(html) && /Payment not going through \/ limit reached\?/.test(html));
  ok('verify screen offers it when slow', /data-ff": "verify-pay-help"/.test(html));
  ok('route + checkout step + API calls', /screen === 'payhelp' && React\.createElement\(PayHelpScreen/.test(html) && /\['Pay', \['pay', 'payhelp'\]\]/.test(html) && ['getBackupPayment', 'claimManualPayment', 'getClaimStatus'].every((a) => html.includes("apiCall_('" + a + "'")));
  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = true; for (const s of inline) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('storefront script parses', parsed);

  section('admin 💸 Payments');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const adminScripts = [...admin.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
  parsed = true; for (const s of adminScripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('admin script parses; menu + route', parsed && /\['payments', '💸', 'Payments'\]/.test(admin) && /payments: paymentsView/.test(admin));
  const pick = (re) => (admin.match(re) || [''])[0];
  const helpers = [/function esc\([\s\S]*?\n/, /function money\([\s\S]*?\n/, /var MON = [\s\S]*?\n/, /function prettyDate\([\s\S]*?\n/, /var PM = [\s\S]*?\n/, /var PM_STATUS = [\s\S]*?\n/, /var PM_SCORE = [\s\S]*?\n/, /function claimCard\([\s\S]*?\n\}/].map(pick).join('\n');
  const claimCard = new Function(helpers + '; return { claimCard: claimCard, PM: PM };')();
  const review = { id: 3, order_id: 'FF4410107', phone_norm: '9876543210', customer_name: 'Rahul <b>', amount: 139, payer_name: 'GOVIND <script>', status: 'REVIEW', reason: 'partly matches', created_at: '2026-09-14 12:40:00', service: 'Netflix', plan: 'Private 1M',
    options: [{ id: 51, upiRef: '515365837394', amount: 139, receivedAt: '2026-09-14 12:38:00', payerName: 'GOVIND KUMAR SHARMA', note: 'UPI', score: 'WEAK' }] };
  let card = claimCard.claimCard(review);
  ok('review card: name, amount, order, reason, bank option with score', /GOVIND &lt;script&gt;/.test(card) && !/<script>/.test(card) && /₹139/.test(card) && /FF4410107/.test(card) && /partly matches/.test(card) && /data-pick="51"/.test(card) && /name partly/.test(card));
  ok('approve-with-payment disabled until a payment is picked; manual + reject buttons', /data-act="approve" disabled/.test(card) && /data-act="manual"/.test(card) && /data-act="reject"/.test(card));
  claimCard.PM.pick[3] = 51; card = claimCard.claimCard(review);
  ok('picked payment enables approve', !/data-act="approve" disabled/.test(card) && /pmopt on/.test(card));
  card = claimCard.claimCard(Object.assign({}, review, { status: 'APPROVED', options: undefined, admin_note: 'seen in bank' }));
  ok('decided card has no action buttons', !/data-act=/.test(card) && /Approved/.test(card) && /seen in bank/.test(card));
  ok('settings: QR upload shrinks big photos, Save bar above bottom menu', /function uploadQr\(file\)/.test(admin) && /720 \/ Math\.max/.test(admin) && /id="pmsave"/.test(admin) && /class="rf-save"><button class="btn green" id="pmsave"/.test(admin));

  section('run 6 browser-walk fixes');
  ok('pay-help screen has its own header title', /payhelp: \['Backup Payment', /.test(html));
  const toastAt = html.indexOf('}, toast && React.createElement("div"');
  const toastSrc = html.slice(toastAt, toastAt + 900);
  ok('toast is centred without translateX (fadeSlide keyframes override transform)', toastAt > 0 && !/translateX/.test(toastSrc) && /margin: '0 auto'/.test(toastSrc) && /fadeSlide/.test(toastSrc));

  ok('admin claim filter chips size to their label (no "Approv" cut-off on phones)', /#pmseg button\{flex:1 1 auto;[^}]*white-space:nowrap\}/.test(admin));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
