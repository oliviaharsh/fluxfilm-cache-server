/* Installable app (PWA): manifests, service worker, icons, install pop-up. Run: npm test */
const fs = require('fs');
const path = require('path');
const pwa = require('../pwa');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const pngSize = (p) => { const b = fs.readFileSync(p); return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };

(async () => {
  // Manifests + icons.
  for (const [name, m, color] of [['store', pwa.storeManifest(), '#16a34a'], ['admin', pwa.adminManifest(), '#e11d48']]) {
    ok(name + ': standalone app with name, start_url inside scope, theme colour', m.display === 'standalone' && m.name && m.start_url.startsWith(m.scope) && m.theme_color === color);
    const sizes = m.icons.map((i) => i.sizes + ':' + i.purpose);
    ok(name + ': 192 + 512 + maskable icons (what Chrome needs to offer Install)', sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'), sizes);
    for (const i of m.icons) {
      const file = i.src.replace('/icons/', '');
      const p = pwa.iconPath(file);
      const want = i.sizes.split('x').map(Number);
      ok(name + ': ' + file + ' exists with the right pixel size', p && JSON.stringify(pngSize(p)) === JSON.stringify(want), [p, p && pngSize(p)]);
    }
  }
  ok('store and admin are two different apps (own id, name, icon)', pwa.storeManifest().id !== pwa.adminManifest().id && pwa.adminManifest().scope === '/panel' && pwa.adminManifest().icons[0].src.includes('admin-'));
  ok('apple touch icons + favicon exist', ['apple-touch-icon-180.png', 'admin-apple-touch-icon-180.png', 'favicon-32.png'].every((f) => { const p = pwa.iconPath(f); return p && pngSize(p)[0] === Number(f.match(/(\d+)\.png$/)[1]); }));
  ok('icon names are whitelisted (no path tricks)', pwa.iconPath('../server.js') === null && pwa.iconPath('..%2Fserver.js') === null && pwa.iconPath('icon-192.png.js') === null);

  // New logo (design/logo PR) wins over the placeholder without code changes.
  const dir = path.join(__dirname, '..', 'icons');
  const existed = fs.existsSync(dir); const probe = path.join(dir, 'zz-probe-test.png');
  fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.join(__dirname, '..', 'icons-default', 'icon-192.png'), probe);
  fs.copyFileSync(path.join(__dirname, '..', 'icons-default', 'icon-192.png'), path.join(__dirname, '..', 'icons-default', 'zz-probe-test.png'));
  ok('icons/ (new logo) is used before icons-default/ (placeholder)', pwa.iconPath('zz-probe-test.png') === probe);
  fs.unlinkSync(probe); fs.unlinkSync(path.join(__dirname, '..', 'icons-default', 'zz-probe-test.png')); if (!existed) fs.rmdirSync(dir);

  // Service worker behaviour, run in a fake worker.
  const handlers = {}; const cached = new Map(); let deleted = [];
  const self = { addEventListener: (k, f) => { handlers[k] = f; }, location: { origin: 'https://shop.fluxfilm.in' }, skipWaiting: () => {}, clients: { claim: async () => {} } };
  const caches = { keys: async () => ['ff-assets-old', 'other-app'], delete: async (k) => { deleted.push(k); return true; }, open: async () => ({ match: async (r) => cached.get(r.url), put: async (r, res) => cached.set(r.url, res) }) };
  let net = 'up'; const fetched = [];
  const fetch = async (req) => { fetched.push(req.url); if (net === 'down') throw new Error('offline'); return { ok: true, body: 'fresh ' + req.url, clone() { return this; } }; };
  class Response { constructor(body, init) { this.body = body; this.headers = (init || {}).headers; } }
  new Function('self', 'caches', 'fetch', 'Response', 'URL', pwa.serviceWorker())(self, caches, fetch, Response, URL);
  const run = async (url, mode, method) => { let out; const ev = { request: { url, mode: mode || 'no-cors', method: method || 'GET' }, respondWith: (p) => { out = p; } }; handlers.fetch(ev); return out ? await out : undefined; };
  let r = await run('https://shop.fluxfilm.in/', 'navigate');
  ok('pages always come fresh from the network (so the app is always the latest website)', r && r.body === 'fresh https://shop.fluxfilm.in/');
  net = 'down'; r = await run('https://shop.fluxfilm.in/', 'navigate');
  ok('no internet → friendly offline page', r && /No internet right now/.test(r.body) && /Try again/.test(r.body));
  net = 'up'; fetched.length = 0;
  ok('API calls, admin API and POSTs are never touched', (await run('https://shop.fluxfilm.in/api')) === undefined && (await run('https://shop.fluxfilm.in/admin/api/today')) === undefined && (await run('https://shop.fluxfilm.in/api', 'cors', 'POST')) === undefined && fetched.length === 0);
  ok('other sites (fonts, React CDN) are not intercepted', (await run('https://unpkg.com/react.js')) === undefined);
  await run('https://shop.fluxfilm.in/icons/icon-192.png'); fetched.length = 0; net = 'down';
  r = await run('https://shop.fluxfilm.in/icons/icon-192.png');
  ok('icons are cached (app icon shows even offline)', r && fetched.length === 0);
  net = 'up';
  const ev = { waitUntil: (p) => { ev.p = p; } }; handlers.activate(ev); await ev.p;
  ok('old FluxFilm caches removed on update, other caches left alone', deleted.includes('ff-assets-old') && !deleted.includes('other-app'));
  ok('new service worker takes over at once (no "close the app to update")', /self\.skipWaiting\(\)/.test(pwa.serviceWorker()) && /clients\.claim\(\)/.test(pwa.serviceWorker()));

  // Wiring.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('routes mounted before the storefront catch-all', srv.indexOf("require('./pwa').mount(app)") > 0 && srv.indexOf("require('./pwa').mount(app)") < srv.indexOf("app.get('*'"));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('storefront head: manifest, theme colour, apple icon, service worker', /<link rel="manifest" href="\/manifest\.webmanifest" \/>/.test(html) && /name="theme-color" content="#16a34a"/.test(html) && /apple-touch-icon-180\.png/.test(html) && /navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(html));
  ok('install prompt kept for our own buttons', /addEventListener\('beforeinstallprompt', function \(e\) \{ e\.preventDefault\(\); window\.ffInstall\.evt = e;/.test(html));
  ok('pop-up: not when already installed, only on home / my plans / buy, once per visit, "don\'t show again" = 30 days', /if \(isStandalone_\(\) \|\| !\['home', 'dashboard', 'buy1'\]\.includes\(screen\)\) return;/.test(html) && /sessionStorage\.setItem\('ff_install_asked', '1'\)/.test(html) && /Date\.now\(\) \+ 30 \* 86400000/.test(html));
  ok('iPhone gets Add to Home Screen steps; other browsers get Chrome menu steps', /Add to Home Screen/.test(html) && /mode === 'manual'/.test(html));
  ok('Account → Install the app (hidden inside the installed app)', /k: 'install',\s*icon: '📲'/.test(html) && /concat\(isStandalone_\(\) \? \[\] :/.test(html) && /r\.k === 'install' \? window\.dispatchEvent\(new Event\('ff-install-open'\)\)/.test(html));
  ok('pop-up rendered at the app root (fixed layer, not inside an animated screen) and never on the maintenance screen', /!storeBlocked && React\.createElement\(InstallPrompt, \{\s*screen: screen\s*\}\)/.test(html) && /\.ff-install-bg \{ position: fixed;/.test(html));
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin: own manifest, icon, service worker, Install admin app button', /<link rel="manifest" href="\/panel\.webmanifest"\/>/.test(admin) && /admin-apple-touch-icon-180\.png/.test(admin) && /navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(admin) && /id="adminInstall"/.test(admin) && /function adminInstall\(\)/.test(admin));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
