/* Admin phone Back button / ← arrows (History API) + "new version ready" for the installed apps. Run: npm test */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const tick = () => new Promise((r) => setTimeout(r, 5));
const ROOT = path.join(__dirname, '..');
// Line endings normalised: a Windows checkout (core.autocrlf) has CRLF, the server / GitHub copy LF.
const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const store = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const slice = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('not found: ' + from + ' … ' + to); return src.slice(a, b + to.length); };

(async () => {
  section('version id (appversion.js)');
  delete process.env.APP_VERSION;
  const av = require('../appversion');
  const v1 = av.version();
  ok('short hex id, stable between calls', /^[0-9a-f]{12}$/.test(v1) && av.version() === v1, v1);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffver-'));
  const tmpIndex = path.join(tmp, 'index.html');
  fs.copyFileSync(path.join(ROOT, 'index.html'), tmpIndex);
  av.setIndexPath(tmpIndex);
  ok('same page contents → same id', av.version() === v1);
  fs.appendFileSync(tmpIndex, '\n<!-- changed -->\n');
  const v2 = av.version();
  ok('page changed → new id (no restart needed)', /^[0-9a-f]{12}$/.test(v2) && v2 !== v1, [v1, v2]);
  const pg = av.page(tmpIndex);
  ok('served page carries window.FF_VERSION right after <head>, rest unchanged', pg.indexOf('<head>\n') < 0 && new RegExp('<head><script>window\\.FF_VERSION="' + v2 + '";</script>\\n<meta charset').test(pg) && pg.replace(/<script>window\.FF_VERSION="[^"]+";<\/script>/, '') === fs.readFileSync(tmpIndex, 'utf8'));
  ok('page() reuses the prepared page until something changes', av.page(tmpIndex) === pg);
  ok('missing file → null (server falls back to sendFile / 404)', av.page(path.join(tmp, 'nope.html')) === null);
  av.setIndexPath(path.join(ROOT, 'index.html'));
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('inject works without <head> and never breaks out of the script tag', /^<script>window\.FF_VERSION="abc";<\/script><p>/.test(av.inject('<p>x</p>', 'abc')));
  process.env.APP_VERSION = 'rel-42"</script>';
  ok('APP_VERSION env overrides (sanitised)', av.version() === 'rel-42script');
  delete process.env.APP_VERSION;

  const routes = {};
  const pwa = require('../pwa');
  pwa.mount({ get: (p, f) => { routes[p] = f; } });
  const res = { h: {}, set(k, v) { this.h[k] = v; return this; }, json(b) { this.body = b; return this; }, type() { return this; }, send() { return this; }, status() { return this; } };
  routes['/version']({}, res);
  ok('GET /version: JSON id, Cache-Control no-store', res.body.ok === true && res.body.version === av.version() && res.h['Cache-Control'] === 'no-store', res);
  ok('service worker cache name follows the version (icons + offline page refresh with each update)', pwa.serviceWorker().includes('const VERSION = ' + JSON.stringify(av.version()) + ';') && /const ASSETS = 'ff-assets-' \+ VERSION;/.test(pwa.serviceWorker()));
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
  ok('storefront catch-all serves the versioned page (ETag via res.send, max-age=0), sendFile kept as fallback', /const html = INDEX && appversion\.page\(INDEX\);/.test(srv) && /'Cache-Control', 'public, max-age=0'/.test(srv) && /if \(INDEX\) return res\.sendFile\(INDEX\);/.test(srv) && srv.indexOf('appversion.page(INDEX)') > srv.indexOf("require('./pwa').mount(app)"));
  ok('/panel serves admin.html with the version (old PAGE as fallback)', /app\.get\('\/panel', \(_req, res\) => res\.type\('html'\)\.send\(appversion\.page\(path\.join\(__dirname, 'admin\.html'\)\) \|\| PAGE\)\);/.test(adminJs));

  section('scripts parse');
  for (const [name, html] of [['admin.html', admin], ['index.html', store]]) {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim());
    let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   ' + name + ' parse error:', e.message); } }
    ok(name + ': every inline <script> parses', parsed && scripts.length > 0);
  }

  // ---------- admin: fake browser (history, DOM bits) running the real code ----------
  const histSrc = slice(admin, 'function nav(v) {', 'setInterval(updCheck, 10 * 60000);');
  const modalSrc = slice(admin, 'function modal(title, body, foot, size) {', "if (H.cur && H.cur.layer === 'modal') hDropTop(); }");
  const viewNames = [...slice(admin, 'function viewMap() {', '};').matchAll(/: (\w+)/g)].map((m) => m[1]);

  function makeEnv(opts) {
    opts = opts || {};
    const E = { renders: [], toasts: [], confirms: 0, confirmAnswer: true, viewDirty: false, reloads: 0, lookups: [], standalone: !!opts.standalone };
    const els = {};
    const el = (id) => {
      if (!els[id]) {
        const cls = new Set();
        els[id] = { id, hidden: false, attrs: {}, listeners: {}, value: '', textContent: '', innerHTML: '',
          classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : on; if (want) cls.add(c); else cls.delete(c); return want; } },
          setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
          addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
          remove() { delete els[this.id]; this.removed = true; } };
      }
      return els[id];
    };
    ['view', 'side', 'gback', 'cp'].forEach(el);
    const doc = { visibilityState: 'visible', listeners: {}, addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
      createElement: () => { const o = el('__new' + Math.random()); return o; }, body: { appendChild: (o) => { if (o.id && !o.id.startsWith('__new')) { els[o.id] = o; } } } };
    // createElement returns a temp element; appendChild re-registers it under the id the code gave it.
    doc.createElement = () => { const cls = new Set(); return { id: '', hidden: false, attrs: {}, listeners: {}, className: '', innerHTML: '',
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: () => {} },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
      addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); }, remove() { if (els[this.id] === this) delete els[this.id]; this.removed = true; } }; };
    const href0 = opts.href || 'https://shop.fluxfilm.in/panel?source=app';
    const loc = { href: href0 };
    const syncLoc = () => { const u = new URL(loc.href); loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash; };
    syncLoc();
    const win = { listeners: {}, addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); }, scrollTo() {} };
    const stack = [{ state: null, url: href0 }]; let idx = 0;
    const setUrl = (u) => { if (u) { loc.href = new URL(u, loc.href).href; syncLoc(); } };
    const hist = {
      get state() { return stack[idx].state; },
      get length() { return stack.length; },
      pushState(st, _t, u) { stack.splice(idx + 1); stack.push({ state: JSON.parse(JSON.stringify(st)), url: u }); idx++; setUrl(u); },
      replaceState(st, _t, u) { stack[idx] = { state: JSON.parse(JSON.stringify(st)), url: u }; setUrl(u); },
      back() { setTimeout(() => { if (idx === 0) { E.exited = true; return; } idx--; setUrl(stack[idx].url); (win.listeners.popstate || []).forEach((f) => f({ state: stack[idx].state })); }, 0); },
    };
    E.stack = stack; E.idx = () => idx; E.els = els; E.win = win; E.doc = doc; E.loc = loc;
    E.S = { view: opts.view || 'today' };
    const views = {}; viewNames.forEach((n) => { views[n] = () => E.renders.push(n); });
    const names = ['S', 'MENU', '$', '$$', 'store', 'toast', 'confirm', 'history', 'location', 'window', 'document', 'adminStandalone', 'lookup', 'fetch', 'navigator', 'setInterval', 'URL', 'URLSearchParams'].concat(viewNames);
    const $ = (s) => { const m = /^#([\w-]+)$/.exec(s); return m ? (els[m[1]] || null) : null; };
    const $$ = (s) => (s === '#view .rf-state.dirty' && E.viewDirty ? [{ textContent: '● Not saved yet' }] : []);
    E.fetchVersion = 'same';
    const args = [E.S, [], $, $$, () => null, (t) => E.toasts.push(t), () => { E.confirms++; return E.confirmAnswer; }, hist, loc, win, doc, () => E.standalone,
      (fromHistory) => E.lookups.push([els.cp.value, fromHistory]),
      () => Promise.resolve({ json: () => ({ ok: true, version: E.fetchVersion }) }), {}, () => 0, URL, URLSearchParams].concat(viewNames.map((n) => views[n]));
    const api = new Function(names.join(','), histSrc + '\n' + modalSrc + '\nreturn { nav, route, hInit, hBack, hSub, hSubDone, toggleSide, modal, closeModal, H, updCheck, updReload };').apply(null, args);
    E.api = api;
    E.back = async () => { hist.back(); await tick(); await tick(); };
    E.state = () => stack[idx].state;
    return E;
  }

  section('admin: phone Back goes to the previous screen');
  let E = makeEnv();
  E.api.hInit(); E.api.route();
  ok('first load: current screen stored in history (replace, no extra entry)', E.stack.length === 1 && E.state().ffv === 'today' && E.state().n === 0);
  ok('← arrow hidden on Today', E.els.gback.hidden === true);
  E.api.nav('orders'); E.api.nav('stock');
  ok('every screen change pushes an entry; URL shows #view', E.stack.length === 3 && E.state().ffv === 'stock' && E.loc.hash === '#stock' && /source=app/.test(E.loc.search));
  ok('← arrow shown on other screens', E.els.gback.hidden === false);
  E.api.nav('stock');
  ok('tapping the screen you are on adds no entry', E.stack.length === 3);
  E.renders.length = 0;
  await E.back();
  ok('Back → previous screen rendered (no new entry)', E.S.view === 'orders' && E.renders.join() === 'ordersView' && E.stack.length === 3 && E.idx() === 1);
  await E.back();
  ok('Back again → Today, arrow hidden', E.S.view === 'today' && E.els.gback.hidden === true && E.idx() === 0);
  E.api.nav('coupons');
  E.api.hBack(); await tick(); await tick();
  ok('← arrow = same as phone Back', E.S.view === 'today');

  section('admin: modals and the side menu close first');
  E = makeEnv(); E.api.hInit(); E.api.nav('orders');
  E.api.modal('Order FF1', '<p>x</p>', '');
  ok('opening a modal adds a light entry', E.stack.length === 3 && E.state().layer === 'modal' && E.state().ffv === 'orders' && !!E.els.modal);
  ok('modal has a ← back arrow (phones) and keeps ✕', /class="btn ghost sm mback" onclick="closeModal\(\)"/.test(E.els.modal.innerHTML) && /onclick="closeModal\(\)">✕<\/button>/.test(E.els.modal.innerHTML));
  E.api.modal('Order FF2', '<p>y</p>', '');
  ok('a modal replacing a modal reuses the entry', E.stack.length === 3);
  E.renders.length = 0;
  await E.back();
  ok('Back closes the modal, stays on the screen (no re-render)', !E.els.modal && E.S.view === 'orders' && E.renders.length === 0 && E.idx() === 1);
  E.api.modal('Order FF3', '<p>z</p>', '');
  E.api.closeModal(); E.api.nav('stock');
  await tick(); await tick();
  ok('✕ / Save closes the modal and removes its entry; a screen opened right after is still one entry', !E.els.modal && E.stack.length === 3 && E.idx() === 2 && E.state().ffv === 'stock' && E.stack[1].state.ffv === 'orders' && !E.stack[1].state.layer);
  await E.back();
  ok('...and Back from there goes to the screen before, not to a closed modal', E.S.view === 'orders');
  E.api.toggleSide();
  ok('opening the side menu adds an entry', E.els.side.classList.contains('open') && E.state().layer === 'side');
  await E.back();
  ok('Back closes the side menu', !E.els.side.classList.contains('open') && E.S.view === 'orders');
  E.api.toggleSide(); const len = E.stack.length; E.api.nav('payments');
  ok('choosing a screen from the side menu replaces the menu entry', E.stack.length === len && E.state().ffv === 'payments' && !E.els.side.classList.contains('open'));
  await E.back();
  ok('...so one Back returns to the screen before', E.S.view === 'orders');

  section('admin: unsaved changes are protected');
  E = makeEnv(); E.api.hInit(); E.api.nav('coupons');
  E.api.modal('New coupon', '<input id="c_code">', '');
  E.els.modal.listeners.input[0]({ target: { closest: (s) => (s === '.mbody' ? {} : null) } });
  ok('typing in a modal form marks it unsaved', E.els.modal.getAttribute('data-dirty') === '1');
  E.confirmAnswer = false;
  await E.back();
  ok('Back + "Cancel" → modal stays open, history entry put back', !!E.els.modal && E.confirms === 1 && E.state().layer === 'modal' && E.api.H.cur.layer === 'modal');
  E.confirmAnswer = true;
  await E.back();
  ok('Back + "OK" → modal closed', !E.els.modal && E.confirms === 2 && E.S.view === 'coupons');
  E = makeEnv(); E.api.hInit(); E.api.nav('plans');
  let closed = 0;
  E.api.hSub('plan', () => { closed++; });
  ok('opening an editor adds an entry; ← arrow shown', E.state().sub === 'plan' && E.stack.length === 3 && E.els.gback.hidden === false);
  E.api.hSub('plan', () => { closed++; });
  ok('re-drawing the same editor adds no entry', E.stack.length === 3);
  E.viewDirty = true; E.confirmAnswer = false;
  await E.back();
  ok('Back with "● Not saved yet" + Cancel → editor stays', closed === 0 && E.state().sub === 'plan' && E.confirms === 1);
  E.api.nav('orders');
  ok('menu / bottom bar with unsaved changes + Cancel → stays too', E.S.view === 'plans' && E.confirms === 2);
  E.confirmAnswer = true;
  await E.back();
  ok('Back + OK → editor closed back to its list', closed === 1 && E.S.view === 'plans' && !E.state().sub);
  E.viewDirty = false;
  E.api.hSub('plan', () => { closed++; });
  E.api.hSubDone('plan'); await tick(); await tick();
  ok('editor closed by itself (e.g. plan deleted) → its entry removed', E.idx() === 1 && !E.state().sub && closed === 1);
  E.api.hSub('plan', () => { closed++; }); E.api.nav('orders');
  await E.back();
  await tick(); await tick();
  ok('Back to a screen whose editor is gone skips the empty step', E.S.view === 'plans' && !E.state().sub && E.idx() === 1);

  section('admin: installed app — Today at the bottom, "press back again to exit"');
  E = makeEnv({ standalone: true }); E.api.hInit(); E.api.route();
  ok('installed app starts with a Today entry underneath', E.stack.length === 2 && E.stack[0].state.root === 1 && E.idx() === 1);
  await E.back();
  ok('Back on Today → toast, app not closed yet', E.toasts.includes('Press back again to exit') && !E.exited && E.idx() === 0);
  await E.back();
  ok('Back again → leaves (closes the app)', E.exited === true);
  E = makeEnv({ standalone: true, view: 'orders' }); E.api.hInit(); E.api.route();
  await E.back();
  ok('Back from another first screen → Today (not closing the app), then the exit hint works', E.S.view === 'today' && E.idx() === 1 && E.stack.length === 2 && !E.exited);

  section('admin: deep links + existing restore');
  for (const [href, want] of [['https://x/panel#payments', 'payments'], ['https://x/panel?v=coupons', 'coupons'], ['https://x/panel#nope', 'orders'], ['https://x/panel', 'orders']]) {
    const S = { view: 'orders' }; const saved = [];
    const init = slice(admin, 'function hDeepLink() {', "store('ff_view', dv); } })();");
    new Function('S', 'store', 'location', 'viewMap', 'URLSearchParams', init)(S, (k, v) => saved.push([k, v]), new URL(href), () => ({ today: 1, orders: 1, payments: 1, coupons: 1 }), URLSearchParams);
    ok('deep link ' + href.replace('https://x', '') + ' → ' + want, S.view === want && (want === 'orders' ? saved.length === 0 : saved[0][1] === want));
  }
  ok('ff_view restore + sign-in untouched; history starts after the shell is drawn', /var S = \{ view: store\('ff_view'\) \|\| 'today'/.test(admin) && /adminInstallRefresh\(\);\n  hInit\(\);\n\}/.test(admin) && /if \(r\.ok\) \{ S\.weak = r\.weakPassword; shell\(\); route\(\); \}/.test(admin));
  ok('header ← arrow (big tap target) + ☰ goes through toggleSide', /id="gback" hidden onclick="hBack\(\)" aria-label="Back"/.test(admin) && /\.gback\{min-width:44px;min-height:40px/.test(admin) && /onclick="toggleSide\(\)">☰/.test(admin));
  ok('Plans + Offers editors use history; their ← Back buttons act like phone Back', /hSub\('plan', function \(\) \{ PL\.edit = null; PL\.orig = null; plRenderList\(\); plLoad\(\); \}\);/.test(admin) && /\$\('#plback'\)\.onclick = function \(\) \{ hBack\(\); \};/.test(admin) && /hSub\('offer', function \(\) \{ PR\.edit = null; prLoad\(\); prRenderList\(\); \}\);/.test(admin) && /\$\('#prback'\)\.onclick = function \(\) \{ hBack\(\); \};/.test(admin) && /function plRenderList\(\) \{\n  hSubDone\('plan'\);/.test(admin) && /function prRenderList\(\) \{\n  hSubDone\('offer'\);/.test(admin));
  ok('Customer 360: looking up another customer = history entry (Back shows the previous one)', /function lookup\(fromHistory\) \{/.test(admin) && /if \(H\.cur\.phone && H\.cur\.phone !== p\) hPush\(\{ ffv: 'customer', phone: p \}\);/.test(admin));

  section('admin: new version bar (never reloads by itself)');
  E = makeEnv(); E.api.hInit();
  E.win.FF_VERSION = undefined;
  global.window = E.win;
  E.win.FF_VERSION = 'aaa'; E.fetchVersion = 'aaa';
  E.api.updCheck(); await tick();
  ok('same version → nothing shown', !E.els.updbar);
  E.fetchVersion = 'bbb';
  E.api.updCheck(); await tick(); await tick();
  ok('new version → "New version ready · Refresh" bar, no automatic reload', !!E.els.updbar && /New version ready/.test(E.els.updbar.innerHTML) && /onclick="updReload\(\)">Refresh/.test(E.els.updbar.innerHTML) && E.reloads === 0);
  ok('checks when the app comes back to the front and every 10 minutes', /document\.addEventListener\('visibilitychange', function \(\) \{ if \(document\.visibilityState === 'visible' && Date\.now\(\) - UPD\.last > 15000\) updCheck\(\); \}\);/.test(admin) && /setInterval\(updCheck, 10 \* 60000\);/.test(admin) && /reg\.update\(\)/.test(histSrc));
  ok('Refresh asks first when a form is not saved', /function updReload\(\) \{ if \(hLeaveBlocked\(\)\) return; location\.reload\(\); \}/.test(admin));
  delete global.window;

  // ---------- storefront ----------
  section('storefront: quiet reload only on safe screens');
  const safeSrc = slice(store, 'const FF_UPDATE_SAFE_SCREENS', "  return true;\n}");
  let active = null;
  const can = new Function('document', safeSrc + '; return ffCanQuietReload_;')({ get activeElement() { return active; } });
  ok('home / my plans / plans list / account → quiet reload', ['home', 'dashboard', 'buy1', 'account'].every((s) => can(s, false)));
  ok('checkout, pay, payment help, renew, details, credentials (done), recover, OTP → never', ['buy2', 'details', 'review', 'pay', 'payhelp', 'verify', 'done', 'renewStart', 'groupJoin', 'recover', 'otpScreen'].every((s) => !can(s, false)));
  ok('busy (loading, sign-in pop-up, modal) → never', !can('home', true));
  active = { tagName: 'INPUT' };
  ok('typing in any box → never', !can('home', false) && !can('dashboard', false));
  active = { tagName: 'BUTTON' };
  ok('a focused button is fine', can('home', false));

  section('storefront: UpdateBar behaviour (hooks harness)');
  const barSrc = slice(store, 'const FF_UPDATE_SAFE_SCREENS', 'function InstallPrompt({').replace(/function InstallPrompt\(\{$/, '');
  const runBar = async (screen, busy, remoteVersion) => {
    const H2 = { states: [], refs: [], effects: [], i: 0, j: 0, k: 0, out: null };
    const out = { reloads: 0, swUpdates: 0, session: {}, listeners: {} };
    const React = { createElement: (t, p, ...c) => ({ t, p, c }) };
    const useState = (init) => { const i = H2.i++; if (!(i in H2.states)) H2.states[i] = init; return [H2.states[i], (v) => { H2.states[i] = v; render(); }]; };
    const useRef = (init) => { const i = H2.j++; if (!(i in H2.refs)) H2.refs[i] = { current: init }; return H2.refs[i]; };
    const useEffect = (f) => { const i = H2.k++; if (!(i in H2.effects)) { H2.effects[i] = true; f(); } };
    const doc = { visibilityState: 'visible', activeElement: null, addEventListener: (k, f) => { out.listeners[k] = f; }, removeEventListener() {} };
    const win = { FF_VERSION: 'v1', fetch: true, location: { reload: () => { out.reloads++; } } };
    const nav = { serviceWorker: { getRegistration: () => Promise.resolve({ update: () => { out.swUpdates++; return Promise.resolve(); } }) } };
    const fetchFn = () => Promise.resolve({ json: () => ({ ok: true, version: remoteVersion }) });
    const ss = { setItem: (k, v) => { out.session[k] = v; }, getItem: (k) => out.session[k] };
    const intervals = [];
    const Bar = new Function('React', 'useState', 'useRef', 'useEffect', 'document', 'window', 'navigator', 'fetch', 'sessionStorage', 'setInterval', 'clearInterval', barSrc + '; return UpdateBar;')(
      React, useState, useRef, useEffect, doc, win, nav, fetchFn, ss, (f, ms) => { intervals.push(ms); return 1; }, () => {});
    let realNow = Date.now; let now = realNow();
    Date.now = () => now;
    const render = () => { H2.i = 0; H2.j = 0; H2.k = 0; H2.out = Bar({ screen, busy }); };
    render();
    out.intervalMs = intervals[0];
    out.initial = H2.out;
    now += 16000; doc.visibilityState = 'visible'; out.listeners.visibilitychange();
    for (let n = 0; n < 6; n++) await tick();
    Date.now = realNow;
    out.bar = H2.out;
    return out;
  };
  let r = await runBar('dashboard', false, 'v2');
  ok('back to the front on My plans with a new version → reload by itself, service worker updated first', r.initial === null && r.reloads === 1 && r.swUpdates === 1 && r.bar === null, r);
  ok('checks every 10 minutes too', r.intervalMs === 600000);
  r = await runBar('pay', false, 'v2');
  ok('on the payment screen → no reload, "New version ready · Refresh" bar instead', r.reloads === 0 && r.bar && r.bar.p.className === 'ff-upd' && JSON.stringify(r.bar).includes('New version ready') && JSON.stringify(r.bar).includes('Refresh'), r);
  r.bar.c[1].p.onClick(); await tick(); await tick();
  ok('tapping Refresh reloads', r.reloads === 1);
  r = await runBar('home', true, 'v2');
  ok('busy on a safe screen → bar, no reload', r.reloads === 0 && r.bar && r.bar.p.className === 'ff-upd');
  r = await runBar('home', false, 'v1');
  ok('same version → nothing happens', r.reloads === 0 && r.bar === null);
  ok('UpdateBar rendered at the app root with busy = loading / restoring / pop-ups', /React\.createElement\(UpdateBar, \{\n    screen: screen,\n    busy: !!\(loadingMsg \|\| restoring \|\| showRecoverModal \|\| showOtpModal \|\| accountModal\.open\)\n  \}\)/.test(store));
  ok('splash script untouched (owner: every reload shows the 3D logo)', !/ff_quiet_reload/.test(store));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
