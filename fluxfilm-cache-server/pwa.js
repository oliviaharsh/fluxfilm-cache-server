/**
 * FluxFilm - installable app (PWA) for the storefront and the admin panel.
 *
 *   GET /manifest.webmanifest   storefront app ("FluxFilm", green)
 *   GET /panel.webmanifest      admin app ("FluxFilm Admin", pink) — separate app id, opens /panel
 *   GET /sw.js                  service worker: pages always come from the network (so an installed app always shows
 *                               the latest website, no app update needed); a friendly offline page when there's no
 *                               internet. /api, /admin and /panel are never cached.
 *   GET /icons/<file>           icons/ (the new logo, design/logo PR) first, else icons-default/ (placeholders)
 */
const fs = require('fs');
const path = require('path');

const ICON_DIRS = [path.join(__dirname, 'icons'), path.join(__dirname, 'icons-default')];
const ICON_NAME = /^[a-z0-9-]+\.(png|svg|ico)$/;
const TYPES = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon' };
// Changes on every deploy/restart, so the browser picks up the new service worker straight away.
const VERSION = process.env.APP_VERSION || String(Date.now());

function storeManifest() {
  return {
    id: '/?app=fluxfilm', name: 'FluxFilm', short_name: 'FluxFilm',
    description: 'Premium subscriptions at lower prices — Netflix, Prime Video, JioHotstar and more. Instant access, easy renewals.',
    start_url: '/?source=app', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#f5f7fb', theme_color: '#16a34a', lang: 'en-IN', categories: ['entertainment', 'shopping'],
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
    background_color: '#f3f5f9', theme_color: '#e11d48', lang: 'en-IN',
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
  return `/* FluxFilm service worker ${VERSION} — network first, never caches customer data */
const VERSION = ${JSON.stringify(VERSION)};
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
