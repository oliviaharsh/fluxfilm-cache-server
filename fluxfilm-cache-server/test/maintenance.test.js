/* Maintenance switch: pause new orders (admin → 🚧 Maintenance), storefront maintenance screen. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const settings = {};
let tableMissing = false; let dbDown = false;
const mockDb = {
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (dbDown) throw new Error('Connection lost');
    if (tableMissing) throw new Error("Table 'app_settings' doesn't exist");
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    return [];
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const store = require('../store');

(async () => {
  let st = await store.getStatus();
  ok('default: open, no message leaked', st.ok && st.paused === false && st.message === '');
  ok('guard lets orders through when open', (await store.guard()) === null);

  let r = await store.saveSettings({ paused: true, backText: 'in 30 minutes' });
  ok('pause saved, since stamped, change reported', r.ok && r.settings.paused === true && !!r.settings.since && r.changed.includes('paused'), r);
  st = await store.getStatus();
  ok('status shows paused + message + back time', st.paused && /upgrading/i.test(st.message) && st.backText === 'in 30 minutes');
  const g = await store.guard();
  ok('guard blocks new orders with a friendly message', g && g.ok === false && g.paused === true && /paused/.test(g.message) && /in 30 minutes/.test(g.message), g);

  r = await store.saveSettings({ message: 'Moving to a faster server <b>now</b>' });
  ok('message edit keeps pause on and strips < >', r.ok && r.settings.paused === true && r.settings.message === 'Moving to a faster server bnow/b' && r.changed.join() === 'message', r);
  r = await store.saveSettings({ message: 'x'.repeat(301) });
  ok('too long message refused', !r.ok && /300/.test(r.message));
  r = await store.saveSettings({ backText: 'y'.repeat(61) });
  ok('too long back time refused', !r.ok);
  ok('refused save changes nothing', (await store.getStatus()).paused === true);

  r = await store.saveSettings({ paused: false });
  ok('resume clears since + back text hidden from customers', r.ok && r.settings.paused === false && r.settings.since === '' && (await store.getStatus()).backText === '');
  ok('guard open again', (await store.guard()) === null);

  await store.saveSettings({ paused: 'true' });
  ok('"true" string from a form works', (await store.getStatus()).paused === true);
  await store.saveSettings({ paused: false });

  store._internal.reset(); tableMissing = true;
  ok('before schema-v15 (no app_settings): shop stays open', (await store.getStatus()).paused === false && (await store.guard()) === null);
  tableMissing = false;
  await store.saveSettings({ paused: true }); store._internal.reset(); dbDown = true;
  ok('database hiccup never blocks orders by itself (fails open)', (await store.guard()) === null);
  dbDown = false; store._internal.reset();
  await store.saveSettings({ paused: false, backText: '' });

  // Server wiring.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('createOrder + createRenewOrder check the switch first', /createOrder: async \(a\) => \(storeMod && await storeMod\.guard\(\)\) \|\| order\.createOrder\(a\[0\]\)/.test(srv) && /createRenewOrder: async \(a\) => \(storeMod && await storeMod\.guard\(\)\) \|\| order\.createRenewOrder/.test(srv));
  ok('paying / verifying / delivering existing orders is NOT blocked', !/verifyPayment: async \(a\) => \(storeMod/.test(srv) && !/fulfillAndGetAccess: async \(a\) => \(storeMod/.test(srv));
  ok('public getStoreStatus routed + rate-limited', /getStoreStatus: \(\) => storeMod\.getStatus\(\)/.test(srv) && /getStoreStatus: security\.rateLimiter/.test(srv) && /'getStoreStatus'[,\]]/.test(srv));
  ok('admin routes mounted', /require\('\.\/adminstore'\)\.mount/.test(fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')));

  // Admin routes (auth + audit).
  const routes = {}; const audits = [];
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  let authed = false;
  require('../adminstore').mount(app, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (req, a) => audits.push(a) } });
  const call = (m, p, body) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } }; routes[m + ' ' + p]({ body }, res); });
  let x = await call('POST', '/admin/api/store', { paused: true });
  ok('admin API needs sign-in', x.code === 403 && !(await store.getStatus()).paused);
  authed = true;
  x = await call('POST', '/admin/api/store', { paused: true, backText: 'by 6 pm' });
  ok('owner pauses from admin → live + change log', x.body.ok && (await store.getStatus()).paused && audits.some((a) => /PAUSED/.test(a.summary) && /by 6 pm/.test(a.summary)), audits);
  x = await call('POST', '/admin/api/store', { paused: false });
  ok('owner resumes → change log says RESUMED', x.body.ok && audits.some((a) => /RESUMED/.test(a.summary)));
  x = await call('GET', '/admin/api/store');
  ok('admin GET returns the settings', x.body.ok && x.body.settings.paused === false);

  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('hidden pause bar really hides (a display rule must not override [hidden])', /\[hidden\]\{display:none!important\}/.test(admin) && admin.indexOf('[hidden]{display:none!important}') < admin.indexOf('.pausebar{'));
  ok('admin menu + view + red "Shop is PAUSED" bar + confirm before pausing', /\['maintenance', '🚧', 'Maintenance'\]/.test(admin) && /maintenance: maintenanceView/.test(admin) && /id="pausebar"/.test(admin) && /confirm\('Pause new orders now\?/.test(admin));

  // Storefront.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('only the order-creating steps are blocked while paused', /const storeBlocked = storePaused && \(\['groupJoin', 'details', 'review', 'renewStart'\]\.includes\(screen\) \|\| screen === 'pay' && !!d\.creating\);/.test(html));
  ok('blocked steps render the maintenance screen instead', ['groupJoin', 'details', 'review', 'renewStart', 'pay'].every((n) => new RegExp("!storeBlocked && screen === '" + n + "' && React\\.createElement").test(html)) && /storeBlocked && React\.createElement\(MaintenanceScreen, \{/.test(html));
  ok('home, plans and My plans stay open with a banner', /storePaused && !storeBlocked && \['home', 'buy1', 'buy2', 'dashboard'\]\.includes\(screen\) && React\.createElement\(PauseBanner/.test(html) && !/!storeBlocked && screen === '(dashboard|buy1|buy2|account|recover|otpScreen|verify|done|payhelp)'/.test(html));
  ok('status polled on load + every minute', /API\.getStoreStatus\(r =>/.test(html) && /setInterval\(\(\) => refreshStore\(\), 60000\)/.test(html));
  ok('scene is transform/opacity only and stops for reduced motion', (() => { const kf = [...html.matchAll(/@keyframes (ffMt\w+) \{([\s\S]*?)\} \}/g)]; return kf.length >= 9 && kf.every((m) => (m[2].match(/([a-z-]+)\s*:/g) || []).every((q) => /^(transform|opacity)\s*:$/.test(q))); })() && /@media \(prefers-reduced-motion: reduce\) \{ \.ff-mt-scene, \.ff-mt-scene \* \{ animation: none !important; \} \}/.test(html));

  // Render the maintenance components with a tiny fake React (catches broken markup).
  const start = html.indexOf('function mtBox_('); const end = html.indexOf('function RestoringScreen(');
  const src = html.slice(start, end);
  const created = [];
  const React = { createElement: (type, props, ...kids) => { created.push(type); return { type, props, kids }; }, Fragment: 'Fragment' };
  const Btn = (p) => p; const useState = (d) => [d, () => {}];
  const mod = new Function('React', 'Btn', 'useState', src + '; return { MaintenanceScene, MaintenanceScreen, PauseBanner };')(React, Btn, useState);
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (typeof n.type === 'function') return walk(n.type(Object.assign({}, n.props, { children: n.kids }))); (n.kids || []).flat(Infinity).forEach(walk); };
  let threw = null;
  try { walk(mod.MaintenanceScreen({ status: { paused: true, message: 'Back soon', backText: 'in 20 minutes' }, nav: () => {}, phone: '9876543210' })); } catch (e) { threw = e.message; }
  ok('maintenance screen renders (scene with workers, crane, building)', !threw && created.filter((t) => t === 'svg').length === 1 && created.filter((t) => t === 'polygon').length >= 8, threw);
  ok('pause banner hidden when open, shown when paused', mod.PauseBanner({ status: { paused: false } }) === null && !!mod.PauseBanner({ status: { paused: true, backText: 'soon' } }));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
