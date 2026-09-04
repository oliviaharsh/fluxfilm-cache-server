/**
 * FluxFilm - Node/MySQL storefront.
 *   browser -> THIS app -> MySQL
 * Apps Script is not a storefront fallback. It is used only by the protected,
 * deliberate /admin/sync import before the eventual go -> shop cutover.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Kolkata'; // FluxFilm runs on India time
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// A missing DB is reported to the storefront; it must never redirect writes to Sheets.
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
let recover = null; try { recover = require('./recover'); } catch (e) { console.log('[recover] not loaded:', e.message); }
let otptool = null; try { otptool = require('./otp'); } catch (e) { console.log('[otp] not loaded:', e.message); }
let catalog = null; try { catalog = require('./catalog'); } catch (e) { console.log('[catalog] not loaded:', e.message); }
let account = null; try { account = require('./account'); } catch (e) { console.log('[account] not loaded:', e.message); }
// Self-contained Node actions (recover + Get-OTP tool) — MySQL/IMAP, no Apps Script.
const DB_RECOVER = Object.assign(
  recover ? {
    recoverSendOtp: (a) => recover.sendOtp(a[0], a[1]),
    recoverVerifyOtp: (a) => recover.verifyOtp(a[0], a[1], a[2]),
    recoverListSubscriptionsSafe: (a) => recover.listSubscriptions(a[0], a[1], a[2]),
    recoverGetAccess: (a) => recover.getAccess(a[0], a[1], a[2], a[3]),
  } : {},
  otptool ? {
    getLatestOtp: (a) => otptool.getLatestOtp(a[0], a[1]),
    getOtpQuota: (a) => otptool.getOtpQuota(a[0], a[1]),
  } : {}
);
const DB_READS = {
  getMySubscriptions: (a) => reads.getMySubscriptions(a[0]),
  getCustomerOrders: (a) => reads.getCustomerOrders(a[0], a[1]),
  getCustomerProfile: (a) => reads.getCustomerProfile(a[0]),
  getActiveCouponsForCustomer: (a) => reads.getActiveCouponsForCustomer(a[0]),
  getWalletByPhone: (a) => reads.getWalletByPhone(a[0]),
};
// Storefront actions backed by MySQL.
const DB_STOREFRONT = Object.assign(
  catalog ? {
    getBootstrap: () => catalog.getBootstrap(),
    getStockLevels: () => catalog.getStockLevels(),
    getTrendingItems: () => catalog.getTrendingItems(),
    getNetflixHouseholdLink: (a) => catalog.getNetflixHouseholdLink(a[0]),
  } : {},
  account ? {
    createOrUpdateCustomerProfile: (a) => account.createOrUpdateCustomerProfile(a[0]),
    createCustomerProfile: (a) => account.createCustomerProfile(a[0]),
    updateCustomerProfilePic: (a) => account.updateCustomerProfilePic(a[0], a[1]),
    getOrderStatus: (a) => account.getOrderStatus(a[0]),
    getResumePaymentByPhone: (a) => account.getResumePaymentByPhone(a[0]),
    submitRestockRequest: (a) => account.submitRestockRequest(a[0]),
  } : {}
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// -- Config --
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.CACHE_CLEAR_KEY || '';
const READ_FROM_DB = process.env.READ_FROM_DB === '1' || process.env.READ_FROM_DB === 'true';
const BUY_ON_DB = process.env.BUY_ON_DB === '1' || process.env.BUY_ON_DB === 'true';
const DB_WRITES = order ? {
  createOrder: (a) => order.createOrder(a[0]),
  createRenewOrder: (a) => order.createRenewOrder(a[0], a[1], a[2]),
  validateCoupon: (a) => order.validateCoupon(a[0], a[1]),
  verifyPayment: (a) => order.verifyPayment(a[0]),
  verifyPaymentByRef: (a) => order.verifyPaymentByRef(a[0], a[1]),
  fulfillAndGetAccess: (a) => {
    if (!fulfill) throw new Error('Fulfillment module is unavailable.');
    return fulfill.fulfillAndGetAccess(a[0]);
  },
} : {};
const DB_READ_ACTIONS = new Set(['getMySubscriptions', 'getCustomerOrders', 'getCustomerProfile', 'getActiveCouponsForCustomer', 'getWalletByPhone']);
const DB_STOREFRONT_ACTIONS = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems', 'getNetflixHouseholdLink', 'createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'getOrderStatus', 'getResumePaymentByPhone', 'submitRestockRequest']);
const DB_RECOVER_ACTIONS = new Set(['recoverSendOtp', 'recoverVerifyOtp', 'recoverListSubscriptionsSafe', 'recoverGetAccess', 'getLatestOtp', 'getOtpQuota']);
const DB_WRITE_ACTIONS = new Set(['createOrder', 'createRenewOrder', 'validateCoupon', 'verifyPayment', 'verifyPaymentByRef', 'fulfillAndGetAccess']);
const DB_NOT_YET_PORTED = new Set(['recoverReassignAccount']);

// -- Locate index.html wherever the deploy put it --
// ROOT WINS. index.html lives at the repo root (nested folders don't reliably
// deploy on Hostinger) — so the root copy is the canonical, current storefront.
// public/index.html is only kept as a last-resort fallback: the copy there is an
// old snapshot, and when it was searched first it silently shadowed the real
// storefront (no variant picker, no device picker) during local testing.
const CANDIDATES = [
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'index.html'),
  path.join(__dirname, 'public', 'index.html'),
  path.join(process.cwd(), 'public', 'index.html'),
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
function requireAdmin(req, res) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) { res.status(403).json({ ok: false, message: 'Unauthorized' }); return false; }
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fluxfilm-cache', storefrontMode: 'mysql-only', appsScriptProxy: false, indexFound: !!INDEX, dbConfigured: !!db.ENABLED, legacyReadFromDbFlag: READ_FROM_DB, legacyBuyOnDbFlag: BUY_ON_DB, cachedKeys: [...cache.keys()], lastSync: (typeof _lastSync !== 'undefined' ? _lastSync : null) });
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

app.get('/admin/fulfill', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const oid = String(req.query.order || '');
  try {
    const [rows] = await db.getPool().query('SELECT order_id, service, plan, status, fulfillment_status, source, extra_field_value, final_amount FROM orders WHERE order_id = ? LIMIT 1', [oid]);
    let result = null;
    try { result = fulfill ? await fulfill.fulfillAndGetAccess(oid) : { message: 'no fulfill module' }; }
    catch (e) { result = { threw: String(e && e.message || e) }; }
    res.json({ order: rows[0] || null, result });
  } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
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
  const a = Array.isArray(body.args) ? body.args : [];
  const dbUnavailable = () => res.status(503).json({ ok: false, message: 'The FluxFilm database is temporarily unavailable. No order or update was sent to the old system.' });
  const dbError = (label, e) => {
    console.log('[' + label + '] MySQL-only action failed:', action, e.message);
    return res.status(500).json({ ok: false, message: 'Something went wrong in the FluxFilm database. Nothing was sent to the old system. Please try again.', detail: process.env.NODE_ENV === 'production' ? undefined : e.message });
  };

  // Customer reads are always MySQL-only. The old READ_FROM_DB flag is retained
  // only in /health so a stale Hostinger environment cannot re-enable fallback.
  if (DB_READ_ACTIONS.has(action)) {
    if (!db.ENABLED || !reads || !DB_READS[action]) return dbUnavailable();
    try {
      const out = await DB_READS[action](a);
      res.set('X-Source', 'mysql');
      return res.type('application/json').send(JSON.stringify(out));
    } catch (e) { return dbError('reads', e); }
  }

  if (DB_STOREFRONT_ACTIONS.has(action)) {
    if (!db.ENABLED || !DB_STOREFRONT[action]) return dbUnavailable();
    try {
      const out = await DB_STOREFRONT[action](a);
      res.set('X-Source', 'mysql');
      return res.type('application/json').send(JSON.stringify(out));
    } catch (e) { return dbError('storefront', e); }
  }

  if (DB_RECOVER_ACTIONS.has(action)) {
    if (!db.ENABLED || !DB_RECOVER[action]) return dbUnavailable();
    try {
      const out = await DB_RECOVER[action](a);
      res.set('X-Source', 'mysql');
      return res.type('application/json').send(JSON.stringify(out));
    } catch (e) { return dbError('node-action', e); }
  }

  // Checkout, coupon validation, payment verification and fulfillment are
  // unconditionally MySQL-only. BUY_ON_DB/BUY_SERVICES can no longer divert a
  // customer to the Sheet-backed legacy checkout.
  if (DB_WRITE_ACTIONS.has(action)) {
    if (!db.ENABLED || !order || !DB_WRITES[action]) return dbUnavailable();
    try {
      const out = await DB_WRITES[action](a);
      res.set('X-Source', 'mysql');
      return res.type('application/json').send(JSON.stringify(out));
    } catch (e) { return dbError('buy', e); }
  }

  if (DB_NOT_YET_PORTED.has(action)) {
    return res.status(501).json({ ok: false, message: 'Account reassignment is temporarily unavailable while it is moved to the FluxFilm database. Nothing was sent to the old system.' });
  }

  // Strict deny-by-default: adding a frontend action without a MySQL handler
  // must be caught during development rather than silently reaching Sheets.
  return res.status(404).json({ ok: false, message: 'This action is not available in the database-only storefront.' });
});

// -- Admin panel (read-only) --
if (admin) admin.mountAdmin(app, { db, ADMIN_KEY, sync });

// -- Serve the storefront --
app.get('*', (_req, res) => {
  if (INDEX) return res.sendFile(INDEX);
  res.status(404).type('text/plain').send('index.html not found. Open /__debug.');
});

// -- Auto-sync: keep MySQL fresh from the Sheet --
// MySQL is the master now — the Sheet must NOT overwrite it. Auto-sync is OFF by
// default; set SYNC_INTERVAL_MIN>0 only for a deliberate one-off Sheet→MySQL refresh
// (e.g. a final data pull right before pointing go → the new stack).
const SYNC_INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN || 0);
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

app.listen(PORT, () => console.log('[FluxFilm] listening on :' + PORT + ' (MySQL-only storefront)'));
