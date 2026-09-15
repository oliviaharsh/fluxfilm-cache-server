/**
 * FluxFilm - installable app (PWA) for the storefront and the admin panel.
 *
 *   GET /manifest.webmanifest   storefront app ("FluxFilm", green)
 *   GET /panel.webmanifest      admin app ("FluxFilm Admin", pink) — separate app id, opens /panel
 *   GET /sw.js                  service worker: pages always come from the network (so an installed app always shows
 *                               the latest website, no app update needed); a friendly offline page when there's no
 *                               internet. /api, /admin and /panel are never cached.
 *                               Also shows push notifications and opens the right page when one is tapped.
 *   GET /icons/<file>           icons/ (the new logo, design/logo PR) first, else icons-default/ (placeholders)
 *   GET /version                current version id (appversion.js); the service worker cache name uses it too
 */
const fs = require('fs');
const path = require('path');

const ICON_DIRS = [path.join(__dirname, 'icons'), path.join(__dirname, 'icons-default')];
const ICON_NAME = /^[a-z0-9-]+\.(png|svg|ico)$/;
const TYPES = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon' };
// Same id as GET /version (appversion.js): changes whenever the pages, this file or the icons change, so the browser
// picks up the new service worker (and a fresh icon cache) with every real update.
const appversion = require('./appversion');
const VERSION = appversion.version();

function storeManifest() {
  return {
    id: '/?app=fluxfilm', name: 'FluxFilm', short_name: 'FluxFilm',
    description: 'Premium subscriptions at lower prices — Netflix, Prime Video, JioHotstar and more. Instant access, easy renewals.',
    start_url: '/?source=app', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#04140e', theme_color: '#04140e', lang: 'en-IN', categories: ['entertainment', 'shopping'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
function adminManifest() {
  return {
    id: '/panel?app=fluxfilm-admin', name: 'FluxFilm Admin', short_name: 'FF Admin',
    description: 'FluxFilm admin panel', start_url: '/panel?source=app', scope: '/panel', display: 'standalone',
    background_color: '#12040a', theme_color: '#12040a', lang: 'en-IN',
    icons: [
      { src: '/icons/admin-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/admin-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/admin-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

const OFFLINE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>FluxFilm — offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;font-family:system-ui,sans-serif;color:#0f172a;text-align:center;padding:24px}' +
  '.c{max-width:360px}.i{font-size:64px}h1{font-size:22px;margin:12px 0 6px}p{color:#475569;line-height:1.5;margin:0 0 18px}button{border:0;border-radius:14px;padding:14px 22px;font-size:16px;font-weight:800;color:#fff;background:#16a34a}</style></head>' +
  '<body><div class="c"><div class="i">📶</div><h1>No internet right now</h1><p>FluxFilm needs the internet. Your plans are safe — check your connection and try again.</p>' +
  '<button onclick="location.reload()">🔄 Try again</button></div></body></html>';

function serviceWorker() {
  const v = appversion.version();
  return `/* FluxFilm service worker ${v} — network first, never caches customer data */
const VERSION = ${JSON.stringify(v)};
const OFFLINE = ${JSON.stringify(OFFLINE_HTML)};
const ASSETS = 'ff-assets-' + VERSION;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ff-') && k !== ASSETS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/admin')) return;
  if (req.mode === 'navigate') {
    // Always the latest page; the offline page only when the network is down.
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.open(ASSETS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }))));
  }
});
// Push notifications (push.js): renewal reminders, "access is ready", admin tests / broadcasts.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const icon = d.icon === '/icons/admin-icon-192.png' ? d.icon : '/icons/icon-192.png';
  // requireInteraction false: goes to the tray like a normal message. timestamp = when it was sent (a push that waited
  // while the phone slept shows the real time). tag + renotify: a newer reminder replaces the old one AND buzzes again.
  const ts = Number(d.ts);
  const opts = { body: String(d.body || ''), icon, badge: icon, data: { url: String(d.url || '/') }, requireInteraction: false, timestamp: ts > 0 ? ts : Date.now() };
  if (d.tag) { opts.tag = String(d.tag); opts.renotify = true; }
  // waitUntil keeps the service worker alive until the notification is on screen (Android stops it otherwise).
  e.waitUntil(self.registration.showNotification(String(d.title || 'FluxFilm'), opts));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let target = self.location.origin + '/';
  try {
    const u = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
    if (u.origin === self.location.origin || u.protocol === 'https:') target = u.href;
  } catch (_) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const same = new URL(target).origin === self.location.origin;
    const win = same && list.find((c) => new URL(c.url).origin === self.location.origin && 'navigate' in c);
    if (win) return win.navigate(target).then((w) => (w || win).focus()).catch(() => self.clients.openWindow(target));
    return self.clients.openWindow(target);
  }));
});
`;
}

function iconPath(file) {
  if (!ICON_NAME.test(file)) return null;
  for (const dir of ICON_DIRS) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function mount(app) {
  appversion.mount(app); // GET /version — the installed apps check it to show "new version ready"
  app.get('/manifest.webmanifest', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/manifest+json').send(JSON.stringify(storeManifest())); });
  app.get('/panel.webmanifest', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/manifest+json').send(JSON.stringify(adminManifest())); });
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript').send(serviceWorker());
  });
  app.get('/icons/:file', (req, res) => {
    const p = iconPath(String(req.params.file || ''));
    if (!p) return res.status(404).type('text/plain').send('icon not found');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(TYPES[p.split('.').pop()]).sendFile(p);
  });
  app.get('/favicon.ico', (req, res) => {
    const p = iconPath('favicon-32.png');
    if (!p) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/png').sendFile(p);
  });
}

module.exports = { mount, storeManifest, adminManifest, serviceWorker, iconPath, OFFLINE_HTML, VERSION };
