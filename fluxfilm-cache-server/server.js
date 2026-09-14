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
let referrals = null; try { referrals = require('./referrals'); } catch (e) { console.log('[referrals] not loaded:', e.message); }
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
  referrals ? {
    getReferralInfo: (a) => referrals.getReferralInfo(a[0]),
    // Public: (code, phone). Never returns the referrer's phone.
    checkReferral: async (a) => { const r = await referrals.checkReferral(a[0], a[1]); delete r.referrerPhone; return r; },
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

const security = require('./security');

const app = express();
// Hostinger terminates HTTPS in front of the app: trust one proxy hop for req.ip / req.secure.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(security.securityHeaders);
// Only FluxFilm's own sites may call the API from a browser (was: any website).
app.use(cors(security.corsOptions()));
app.use(express.json({ limit: '1mb' }));

// Per-IP limits on the storefront actions worth abusing. Generous: many Indian mobile
// customers share one carrier IP, and payment screens poll every 2-4 seconds.
const TEN_MIN = 10 * 60e3;
const LIMITS = {
  recoverSendOtp: security.rateLimiter(10, 60 * 60e3),
  recoverVerifyOtp: security.rateLimiter(30, 15 * 60e3),
  getLatestOtp: security.rateLimiter(40, TEN_MIN),
  validateCoupon: security.rateLimiter(60, TEN_MIN),
  verifyPaymentByRef: security.rateLimiter(20, TEN_MIN),
  createOrder: security.rateLimiter(30, TEN_MIN),
  createRenewOrder: security.rateLimiter(30, TEN_MIN),
  fulfillAndGetAccess: security.rateLimiter(90, TEN_MIN),
  profileWrite: security.rateLimiter(30, TEN_MIN),
  checkReferral: security.rateLimiter(60, TEN_MIN),
  getReferralInfo: security.rateLimiter(60, TEN_MIN),
  any: security.rateLimiter(3000, TEN_MIN),
};
const PROFILE_WRITES = new Set(['createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'submitRestockRequest']);
// Per-phone limits (independent of IP) for actions that email or reveal codes.
const PHONE_LIMITS = {
  recoverSendOtp: security.rateLimiter(3, 15 * 60e3),
  getLatestOtp: security.rateLimiter(15, TEN_MIN),
};
function rateLimited(req, action, args) {
  const ip = security.clientIp(req);
  const checks = [[LIMITS.any, 'any'], [LIMITS[action] || (PROFILE_WRITES.has(action) && LIMITS.profileWrite), action]];
  const phoneArg = action === 'getLatestOtp' ? args[1] : args[0];
  const ph = String(phoneArg == null ? '' : phoneArg).replace(/\D/g, '').slice(-10);
  for (const [lim, name] of checks) {
    if (!lim) continue;
    const r = lim.hit(name + '|' + ip);
    if (!r.ok) return r;
  }
  if (PHONE_LIMITS[action] && ph) {
    const r = PHONE_LIMITS[action].hit(ph);
    if (!r.ok) return r;
  }
  return null;
}

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
    // a[1] = { token, phone } proving who may see the credentials (see fulfill.js).
    return fulfill.fulfillAndGetAccess(a[0], a[1]);
  },
} : {};
const DB_READ_ACTIONS = new Set(['getMySubscriptions', 'getCustomerOrders', 'getCustomerProfile', 'getActiveCouponsForCustomer', 'getWalletByPhone']);
const DB_STOREFRONT_ACTIONS = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems', 'getNetflixHouseholdLink', 'createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'getOrderStatus', 'getResumePaymentByPhone', 'submitRestockRequest', 'getReferralInfo', 'checkReferral']);
const DB_RECOVER_ACTIONS = new Set(['recoverSendOtp', 'recoverVerifyOtp', 'recoverListSubscriptionsSafe', 'recoverGetAccess', 'getLatestOtp', 'getOtpQuota']);
const DB_WRITE_ACTIONS = new Set(['createOrder', 'createRenewOrder', 'validateCoupon', 'verifyPayment', 'verifyPaymentByRef', 'fulfillAndGetAccess']);
const DB_NOT_YET_PORTED = new Set(['recoverReassignAccount']);

// -- Locate the canonical root index.html --
// Nested storefront fallbacks are deliberately unsupported: an old public/
// snapshot previously shadowed the current UI. If the root file is missing,
// fail visibly instead of serving stale checkout code.
const CANDIDATES = [
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'index.html'),
];
const INDEX = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
console.log('[FluxFilm] index.html =', INDEX || 'NOT FOUND');

// -- API cache --
const cache = new Map();
// Admin = signed in at /panel (session cookie), or a script sending the key in the
// X-Admin-Key header. The key is no longer accepted in the URL (?key=), where it
// leaked into browser history, screenshots and logs.
function requireAdmin(req, res) {
  if (!security.isAdmin(req)) {
    res.status(403).json({ ok: false, message: req.query.key ? 'Keys in the URL are no longer accepted. Sign in at /panel first, then open this link again.' : 'Unauthorized — sign in at /panel first.' });
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fluxfilm-cache', storefrontMode: 'mysql-only', appsScriptProxy: false, indexFound: !!INDEX, dbConfigured: !!db.ENABLED, legacyReadFromDbFlag: READ_FROM_DB, legacyBuyOnDbFlag: BUY_ON_DB, cachedKeys: [...cache.keys()], lastSync: (typeof _lastSync !== 'undefined' ? _lastSync : null) });
});

app.get('/__debug', (req, res) => {
  if (!requireAdmin(req, res)) return; // lists server folders: admins only
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
    try { result = fulfill ? await fulfill.fulfillForAdmin(oid) : { message: 'no fulfill module' }; }
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
  const limited = rateLimited(req, action, a);
  if (limited) {
    res.set('Retry-After', String(limited.retryAfterSec));
    return res.status(429).json({ ok: false, rateLimited: true, message: 'Too many requests — please wait ' + Math.ceil(limited.retryAfterSec / 60) + ' min and try again.' });
  }
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
