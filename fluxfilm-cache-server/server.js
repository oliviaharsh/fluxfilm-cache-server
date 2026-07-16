/**
 * FluxFilm - Node app (frontend + cache + MySQL sync)
 *   browser -> THIS app -> api.php -> Apps Script -> Sheets
 *   plus:    -> MySQL (Phase 2: mirror of the Sheet; admin/analytics)
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Kolkata'; // FluxFilm runs on India time
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// DB + sync are optional: if not configured, the app still runs normally.
let db = { ENABLED: false, ping: async () => ({ ok: false, reason: 'db module missing' }) };
let sync = { runSync: async () => ({ ok: false, error: 'sync module missing' }) };
try { db = require('./db'); } catch (e) { console.log('[db] not loaded:', e.message); }
try { sync = require('./sync'); } catch (e) { console.log('[sync] not loaded:', e.message); }
let reads = null;
try { reads = require('./reads'); } catch (e) { console.log('[reads] not loaded:', e.message); }
let admin = null;
try { admin = require('./admin'); } catch (e) { console.log('[admin] not loaded:', e.message); }
let order = null; try { order = require('./order'); } catch (e) { console.log('[order] not loaded:', e.message); }
let payments = null; try { payments = require('./payments'); } catch (e) { console.log('[payments] not loaded:', e.message); }
let fulfill = null; try { fulfill = require('./fulfill'); } catch (e) { console.log('[fulfill] not loaded:', e.message); }
const DB_READS = {
  getMySubscriptions: (a) => reads.getMySubscriptions(a[0]),
  getCustomerOrders: (a) => reads.getCustomerOrders(a[0], a[1]),
  getCustomerProfile: (a) => reads.getCustomerProfile(a[0]),
  getActiveCouponsForCustomer: (a) => reads.getActiveCouponsForCustomer(a[0]),
  getWalletByPhone: (a) => reads.getWalletByPhone(a[0]),
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// -- Config --
const PORT = process.env.PORT || 8080;
const API_PHP_URL = process.env.API_PHP_URL || 'https://go.fluxfilm.in/api.php';
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL = Number(process.env.CACHE_TTL || 60);
const ADMIN_KEY = process.env.CACHE_CLEAR_KEY || '';
const CACHEABLE = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems']);
const READ_FROM_DB = process.env.READ_FROM_DB === '1' || process.env.READ_FROM_DB === 'true';
const BUY_ON_DB = process.env.BUY_ON_DB === '1' || process.env.BUY_ON_DB === 'true';
const DB_WRITES = order ? {
  createOrder: (a) => order.createOrder(a[0]),
  verifyPayment: (a) => order.verifyPayment(a[0]),
  verifyPaymentByRef: (a) => order.verifyPaymentByRef(a[0], a[1]),
  fulfillAndGetAccess: (a) => (fulfill ? fulfill.fulfillAndGetAccess(a[0]) : Promise.resolve({ __fallback: true })),
} : {};

// -- Locate index.html wherever the deploy put it --
const CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'public', 'index.html'),
  path.join(process.cwd(), 'index.html'),
];
function rfind(dir, name, depth) {
  if (depth < 0) return null;
  let es = [];
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of es) { if (e.isFile() && e.name === name) return path.join(dir, e.name); }
  for (const e of es) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const f = rfind(path.join(dir, e.name), name, depth - 1); if (f) return f;
  }
  return null;
}
const INDEX = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } })
  || rfind(__dirname, 'index.html', 3);
console.log('[FluxFilm] index.html =', INDEX || 'NOT FOUND');

// -- API cache --
const cache = new Map();
const now = () => Date.now();
async function callApiPhp(payload) {
  const res = await fetch(API_PHP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': API_KEY },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) { res.status(403).json({ ok: false, message: 'Unauthorized' }); return false; }
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fluxfilm-cache', indexFound: !!INDEX, dbConfigured: !!db.ENABLED, readFromDb: READ_FROM_DB, cachedKeys: [...cache.keys()], lastSync: (typeof _lastSync !== 'undefined' ? _lastSync : null) });
});

app.get('/__debug', (_req, res) => {
  const info = { __dirname, cwd: process.cwd(), index: INDEX, dbConfigured: !!db.ENABLED, listings: {} };
  for (const d of [__dirname, process.cwd()]) { try { info.listings[d] = fs.readdirSync(d); } catch (e) { info.listings[d] = 'ERR ' + e.message; } }
  res.type('application/json').send(JSON.stringify(info, null, 2));
});

// -- Admin: DB ping + sync (protected by CACHE_CLEAR_KEY) --
app.get('/admin/db-ping', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await db.ping());
});
app.get('/admin/sync', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const dry = req.query.dry === '1' || req.query.dry === 'true';
  const tables = req.query.tables ? String(req.query.tables).split(',').map((x) => x.trim()).filter(Boolean) : [];
  try { res.json(await sync.runSync(tables, { dry })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) }); }
});

app.get('/admin/imap-scan', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(payments ? await payments.manualScan(Number(req.query.hours) || 24) : { ok: false, message: 'no payments module' }); }
  catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
});

app.get('/clearcache', (req, res) => {
  if (!requireAdmin(req, res)) return;
  cache.clear();
  res.json({ ok: true, message: 'Cache cleared' });
});

// -- Main proxy --
app.post('/api', async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || '');
  // Phase 3: fast reads from MySQL (flag-gated; any error falls back to Apps Script)
  if (READ_FROM_DB && db.ENABLED && reads && DB_READS[action]) {
    try {
      const a = Array.isArray(body.args) ? body.args : [];
      const out = await DB_READS[action](a);
      res.set('X-Source', 'mysql');
      return res.type('application/json').send(JSON.stringify(out));
    } catch (e) { console.log('[reads] fallback to Apps Script:', e.message); }
  }
  // Wave 2: buy flow on MySQL (flag-gated; any error falls back to Apps Script)
  if (BUY_ON_DB && db.ENABLED && order && DB_WRITES[action]) {
    try {
      const a = Array.isArray(body.args) ? body.args : [];
      const out = await DB_WRITES[action](a);
      if (!out || !out.__fallback) {
        res.set('X-Source', 'mysql');
        return res.type('application/json').send(JSON.stringify(out));
      }
    } catch (e) { console.log('[buy] fallback to Apps Script:', e.message); }
  }
  if (!CACHEABLE.has(action)) {
    try { const { status, text } = await callApiPhp(body); res.status(status).type('application/json').send(text); }
    catch (err) { res.status(502).json({ ok: false, message: 'Upstream error', detail: String(err) }); }
    return;
  }
  const hit = cache.get(action);
  if (hit && hit.expires > now()) { res.set('X-Cache', 'HIT'); return res.type('application/json').send(hit.body); }
  try {
    const { text } = await callApiPhp(body);
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) cache.set(action, { body: text, expires: now() + CACHE_TTL * 1000 });
    res.set('X-Cache', 'MISS'); res.type('application/json').send(text);
  } catch (err) {
    if (hit) { res.set('X-Cache', 'STALE'); return res.type('application/json').send(hit.body); }
    res.status(502).json({ ok: false, message: 'Upstream error', detail: String(err) });
  }
});

// -- Admin panel (read-only) --
if (admin) admin.mountAdmin(app, { db, ADMIN_KEY });

// -- Serve the storefront --
app.get('*', (_req, res) => {
  if (INDEX) return res.sendFile(INDEX);
  res.status(404).type('text/plain').send('index.html not found. Open /__debug.');
});

// -- Auto-sync: keep MySQL fresh from the Sheet --
const SYNC_INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN || 5);
let _syncing = false;
let _lastSync = null;
async function autoSync() {
  if (_syncing || !db.ENABLED) return;
  _syncing = true;
  try {
    const r = await sync.runSync([], { dry: false });
    _lastSync = { at: new Date().toISOString(), results: r.results || r.error || r };
    console.log('[autosync]', JSON.stringify(_lastSync.results));
  } catch (e) {
    _lastSync = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
    console.log('[autosync] error', _lastSync.error);
  } finally { _syncing = false; }
}
if (db.ENABLED && SYNC_INTERVAL_MIN > 0) {
  setTimeout(autoSync, 30000); // first run 30s after boot
  setInterval(autoSync, SYNC_INTERVAL_MIN * 60 * 1000);
  console.log('[autosync] enabled every ' + SYNC_INTERVAL_MIN + ' min');
}

if (db.ENABLED && payments) { try { payments.startWatcher(); } catch (e) { console.log('[imap] start error', e.message); } }

app.listen(PORT, () => console.log('[FluxFilm] listening on :' + PORT + ' -> ' + API_PHP_URL));
