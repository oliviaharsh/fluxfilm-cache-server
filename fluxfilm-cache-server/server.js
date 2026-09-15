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
let coinsMod = null; try { coinsMod = require('./coins'); } catch (e) { console.log('[coins] not loaded:', e.message); }
let paymatch = null; try { paymatch = require('./paymatch'); } catch (e) { console.log('[paymatch] not loaded:', e.message); }
let storeMod = null; try { storeMod = require('./store'); } catch (e) { console.log('[store] not loaded:', e.message); }
let promosMod = null; try { promosMod = require('./promos'); } catch (e) { console.log('[promos] not loaded:', e.message); }
let pushMod = null; try { pushMod = require('./push'); } catch (e) { console.log('[push] not loaded:', e.message); }
let feedMod = null; try { feedMod = require('./feed'); } catch (e) { console.log('[feed] not loaded:', e.message); }
let oliviaMod = null; try { oliviaMod = require('./olivia'); } catch (e) { console.log('[olivia] not loaded:', e.message); }
let photosMod = null; try { photosMod = require('./photos'); } catch (e) { console.log('[photos] not loaded:', e.message); }
// Self-contained Node actions (recover + Get-OTP tool) — MySQL/IMAP, no Apps Script.
const DB_RECOVER = Object.assign(
  recover ? {
    recoverSendOtp: (a) => recover.sendOtp(a[0], a[1]),
    recoverVerifyOtp: (a) => recover.verifyOtp(a[0], a[1], a[2]),
    recoverListSubscriptionsSafe: (a) => recover.listSubscriptions(a[0], a[1], a[2]),
    recoverGetAccess: (a) => recover.getAccess(a[0], a[1], a[2], a[3]),
  } : {},
  otptool ? {
    // a[2] = device token from otpVerifyCode (required - a phone number alone no longer unlocks OTPs).
    getLatestOtp: (a) => otptool.getLatestOtp(a[0], a[1], a[2]),
    otpSendCode: (a) => require('./otpaccess').sendCode(a[0]),
    otpVerifyCode: (a) => require('./otpaccess').verifyCode(a[0], a[1]),
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
  coinsMod ? {
    getCoinQuote: (a) => coinsMod.quoteSpend(a[0], a[1], a[2]),
    getCoinHistory: (a) => coinsMod.history(a[0]),
  } : {},
  account ? {
    createOrUpdateCustomerProfile: (a) => account.createOrUpdateCustomerProfile(a[0]),
    createCustomerProfile: (a) => account.createCustomerProfile(a[0]),
    updateCustomerProfilePic: (a) => account.updateCustomerProfilePic(a[0], a[1]),
    getOrderStatus: (a) => account.getOrderStatus(a[0]),
    getResumePaymentByPhone: (a) => account.getResumePaymentByPhone(a[0]),
    submitRestockRequest: (a) => account.submitRestockRequest(a[0]),
  } : {},
  // Own profile photo (Account → Profile). a = [phone, dataUrl] / [phone, avatarUrlToGoBackTo].
  photosMod ? {
    setProfilePhoto: (a) => photosMod.setProfilePhoto(a[0], a[1]),
    removeProfilePhoto: (a) => photosMod.removeProfilePhoto(a[0], a[1]),
  } : {},
  paymatch ? {
    // Payment fallback. a[1] = { token, phone } proving the order is theirs (same proof as fulfillAndGetAccess).
    getBackupPayment: (a) => paymatch.getBackupPayment(a[0], a[1]),
    claimManualPayment: (a) => paymatch.claimPayment(a[0], a[1], a[2], a[3]),
    getClaimStatus: (a) => paymatch.getClaimStatus(a[0], a[1]),
  } : {},
  // Maintenance switch (admin → 🚧 Maintenance): the storefront polls this.
  storeMod ? { getStoreStatus: () => storeMod.getStatus() } : {},
  // Offers, banners, pop-ups (admin → 📣 Offers).
  promosMod ? { getPromos: () => promosMod.publicList(), promoEvent: (a) => promosMod.record(a[0], a[1]) } : {},
  // Renewal reminders by push notification (admin → 🔔 Notifications). a = [phone, subscription] / [endpoint].
  pushMod ? {
    getPushKey: () => pushMod.publicKeyInfo(),
    pushSubscribe: (a, req) => pushMod.subscribe({ phone: a[0], subscription: a[1], userAgent: req && req.headers ? req.headers['user-agent'] : '', app: 'store' }),
    pushUnsubscribe: (a) => pushMod.unsubscribe(a[0], 'store'),
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
  otpSendCode: security.rateLimiter(10, 60 * 60e3),
  otpVerifyCode: security.rateLimiter(30, 15 * 60e3),
  validateCoupon: security.rateLimiter(60, TEN_MIN),
  verifyPaymentByRef: security.rateLimiter(20, TEN_MIN),
  createOrder: security.rateLimiter(30, TEN_MIN),
  createRenewOrder: security.rateLimiter(30, TEN_MIN),
  fulfillAndGetAccess: security.rateLimiter(90, TEN_MIN),
  profileWrite: security.rateLimiter(30, TEN_MIN),
  checkReferral: security.rateLimiter(60, TEN_MIN),
  getReferralInfo: security.rateLimiter(60, TEN_MIN),
  getCoinQuote: security.rateLimiter(120, TEN_MIN),
  getCoinHistory: security.rateLimiter(60, TEN_MIN),
  getBackupPayment: security.rateLimiter(60, TEN_MIN),
  claimManualPayment: security.rateLimiter(10, TEN_MIN),
  getClaimStatus: security.rateLimiter(400, TEN_MIN),
  getStoreStatus: security.rateLimiter(200, TEN_MIN),
  getPromos: security.rateLimiter(200, TEN_MIN),
  promoEvent: security.rateLimiter(120, TEN_MIN),
  getPushKey: security.rateLimiter(60, TEN_MIN),
  pushSubscribe: security.rateLimiter(20, TEN_MIN),
  pushUnsubscribe: security.rateLimiter(20, TEN_MIN),
  setProfilePhoto: security.rateLimiter(10, TEN_MIN),
  any: security.rateLimiter(3000, TEN_MIN),
};
const PROFILE_WRITES = new Set(['createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'removeProfilePhoto', 'submitRestockRequest']);
// Per-phone limits (independent of IP) for actions that email or reveal codes.
const PHONE_LIMITS = {
  recoverSendOtp: security.rateLimiter(3, 15 * 60e3),
  getLatestOtp: security.rateLimiter(15, TEN_MIN),
  otpSendCode: security.rateLimiter(4, 60 * 60e3),
  otpVerifyCode: security.rateLimiter(12, 15 * 60e3),
  pushSubscribe: security.rateLimiter(10, 60 * 60e3),
  setProfilePhoto: security.rateLimiter(6, 60 * 60e3),
  removeProfilePhoto: security.rateLimiter(10, 60 * 60e3),
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
  // Maintenance: no new orders / renewals while the owner has paused the shop (existing orders still pay + deliver).
  createOrder: async (a) => (storeMod && await storeMod.guard()) || order.createOrder(a[0]),
  // a[3] = "use my coins" (the only option the public may set; the rest of opts is server-only).
  createRenewOrder: async (a) => (storeMod && await storeMod.guard()) || order.createRenewOrder(a[0], a[1], a[2], { useCoins: a[3] === true }),
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
const DB_STOREFRONT_ACTIONS = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems', 'getNetflixHouseholdLink', 'createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'setProfilePhoto', 'removeProfilePhoto', 'getOrderStatus', 'getResumePaymentByPhone', 'submitRestockRequest', 'getReferralInfo', 'checkReferral', 'getCoinQuote', 'getCoinHistory', 'getBackupPayment', 'claimManualPayment', 'getClaimStatus', 'getStoreStatus', 'getPromos', 'promoEvent', 'getPushKey', 'pushSubscribe', 'pushUnsubscribe']);
const DB_RECOVER_ACTIONS = new Set(['recoverSendOtp', 'recoverVerifyOtp', 'recoverListSubscriptionsSafe', 'recoverGetAccess', 'getLatestOtp', 'getOtpQuota', 'otpSendCode', 'otpVerifyCode']);
const DB_WRITE_ACTIONS = new Set(['createOrder', 'createRenewOrder', 'validateCoupon', 'verifyPayment', 'verifyPaymentByRef', 'fulfillAndGetAccess']);
const DB_NOT_YET_PORTED = new Set(['recoverReassignAccount']);
// 🍿 What's new feed (admin → 🍿 Feed): public posts + view / like / click counts. Viewing works in maintenance too.
if (feedMod) {
  Object.assign(DB_STOREFRONT, { getFeed: () => feedMod.publicList(), feedEvent: (a) => feedMod.record(a[0], a[1], a[2]) });
  // Ticker: when no trending rows are set, show the newest feed titles instead.
  if (DB_STOREFRONT.getTrendingItems) {
    const trendingFromDb = DB_STOREFRONT.getTrendingItems;
    DB_STOREFRONT.getTrendingItems = async () => { const r = await trendingFromDb(); if (r && r.ok && !(r.items || []).length) r.items = await feedMod.trendingLines(); return r; };
  }
  DB_STOREFRONT_ACTIONS.add('getFeed'); DB_STOREFRONT_ACTIONS.add('feedEvent');
  LIMITS.getFeed = security.rateLimiter(200, TEN_MIN);
  LIMITS.feedEvent = security.rateLimiter(300, TEN_MIN);
}
// 💬 Feed comments (feedcomments.js): anyone reads; a logged-in customer writes (a = [phone, postId, text]), moderated
// before saving. Until db/schema-v24.sql is run: "Comments coming soon".
let feedCommentsMod = null; try { feedCommentsMod = require('./feedcomments'); } catch (e) { console.log('[feed comments] not loaded:', e.message); }
if (feedMod && feedCommentsMod) {
  Object.assign(DB_STOREFRONT, {
    getFeedComments: (a) => feedCommentsMod.list(a[0], a[1]),
    addFeedComment: (a, req) => feedCommentsMod.add(a[0], a[1], a[2], { ip: security.clientIp(req) }),
  });
  DB_STOREFRONT_ACTIONS.add('getFeedComments'); DB_STOREFRONT_ACTIONS.add('addFeedComment');
  LIMITS.getFeedComments = security.rateLimiter(300, TEN_MIN);
  LIMITS.addFeedComment = security.rateLimiter(40, TEN_MIN);
  PHONE_LIMITS.addFeedComment = security.rateLimiter(10, TEN_MIN);
}

// 🎮 Games (/games page, admin → 🎮 Games). a = [phone, deviceToken, ...]. The server decides and scores every game.
let gamesMod = null; try { gamesMod = require('./games'); } catch (e) { console.log('[games] not loaded:', e.message); }
if (gamesMod) {
  Object.assign(DB_STOREFRONT, {
    getGamesStatus: () => gamesMod.getStatus(),
    getGamesHome: (a) => gamesMod.getHome(a[0], a[1]),
    // a[3] = { paid: true } only after the customer confirmed "play again for N coins".
    gameStart: (a, req) => gamesMod.start(a[0], a[1], a[2], { paid: !!(a[3] && a[3].paid === true) }, { ip: security.clientIp(req) }),
    gameStep: (a) => gamesMod.step(a[0], a[1], a[2], a[3]),
    gameFinish: (a) => gamesMod.finish(a[0], a[1], a[2], a[3]),
    gamesSendCode: (a) => gamesMod.sendCode(a[0]),
  });
  ['getGamesStatus', 'getGamesHome', 'gameStart', 'gameStep', 'gameFinish', 'gamesSendCode'].forEach((x) => DB_STOREFRONT_ACTIONS.add(x));
  Object.assign(LIMITS, {
    getGamesStatus: security.rateLimiter(200, TEN_MIN), getGamesHome: security.rateLimiter(150, TEN_MIN),
    gameStart: security.rateLimiter(120, TEN_MIN), gameStep: security.rateLimiter(400, TEN_MIN), gameFinish: security.rateLimiter(120, TEN_MIN),
    gamesSendCode: security.rateLimiter(10, 60 * 60e3),
  });
  Object.assign(PHONE_LIMITS, {
    gameStart: security.rateLimiter(60, TEN_MIN), gameStep: security.rateLimiter(250, TEN_MIN), gameFinish: security.rateLimiter(60, TEN_MIN),
    gamesSendCode: security.rateLimiter(4, 60 * 60e3),
  });
}
// 🤖 Olivia, the AI store manager (olivia.js): Help → "Chat with Olivia". Off until admin → 🤖 Olivia switches it on.
// a = [phone] / [phone, { conversationId, choice, text, lang, installedApp }].
if (oliviaMod) {
  Object.assign(DB_STOREFRONT, { oliviaStatus: (a) => oliviaMod.status(a[0]), oliviaChat: (a) => oliviaMod.handle(a[0], a[1]), oliviaHistory: (a) => oliviaMod.history(a[0]), oliviaTranscript: (a) => oliviaMod.transcript(a[0], a[1]) });
  DB_STOREFRONT_ACTIONS.add('oliviaStatus'); DB_STOREFRONT_ACTIONS.add('oliviaChat'); DB_STOREFRONT_ACTIONS.add('oliviaHistory'); DB_STOREFRONT_ACTIONS.add('oliviaTranscript');
  LIMITS.oliviaHistory = security.rateLimiter(60, TEN_MIN);
  LIMITS.oliviaTranscript = security.rateLimiter(120, TEN_MIN);
  LIMITS.oliviaStatus = security.rateLimiter(120, TEN_MIN);
  LIMITS.oliviaChat = security.rateLimiter(400, TEN_MIN); // the payment screen polls every 6-8 s
  PHONE_LIMITS.oliviaChat = security.rateLimiter(300, TEN_MIN);
}
// 💸 Refunds (refunds.js): the home-screen choice for a cash refund (refund credit +10%, or a UPI ID → admin Today
// to-do). a = [phone] / [phone, orderId] / [phone, orderId, upiId, deviceToken]. The UPI ID needs the email code.
let refundsMod = null; try { refundsMod = require('./refunds'); } catch (e) { console.log('[refunds] not loaded:', e.message); }
if (refundsMod) {
  Object.assign(DB_STOREFRONT, {
    getPendingRefunds: (a) => refundsMod.getPendingRefunds(a[0]),
    convertRefundToCredit: (a) => refundsMod.convertToCredit(a[0], a[1]),
    refundSendCode: (a) => refundsMod.sendCode(a[0]),
    requestUpiRefund: (a) => refundsMod.requestUpi(a[0], a[1], a[2], a[3]),
  });
  ['getPendingRefunds', 'convertRefundToCredit', 'refundSendCode', 'requestUpiRefund'].forEach((x) => DB_STOREFRONT_ACTIONS.add(x));
  Object.assign(LIMITS, {
    getPendingRefunds: security.rateLimiter(120, TEN_MIN), convertRefundToCredit: security.rateLimiter(20, TEN_MIN),
    refundSendCode: security.rateLimiter(10, 60 * 60e3), requestUpiRefund: security.rateLimiter(20, TEN_MIN),
  });
  Object.assign(PHONE_LIMITS, {
    convertRefundToCredit: security.rateLimiter(10, TEN_MIN), refundSendCode: security.rateLimiter(4, 60 * 60e3), requestUpiRefund: security.rateLimiter(10, TEN_MIN),
  });
}
// ₹0 checkout (order.js confirmFreeOrder): a = [orderId, { token, phone }]. The server re-checks the total and the holds.
if (order) {
  DB_WRITES.confirmFreeOrder = (a) => order.confirmFreeOrder(a[0], a[1]);
  DB_WRITE_ACTIONS.add('confirmFreeOrder');
  LIMITS.confirmFreeOrder = security.rateLimiter(30, TEN_MIN);
}

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
      const out = await DB_STOREFRONT[action](a, req);
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

// Olivia's chat window script (oliviawidget.js), loaded by index.html — before the storefront catch-all.
app.get('/olivia.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=0');
  res.set('Content-Type', 'application/javascript; charset=utf-8').sendFile(path.join(__dirname, 'oliviawidget.js'));
});
// Olivia's photo for the chat header / Help sheet (AI-generated, 256 px). The widget asks for ?v=N, so it can be cached long.
app.get('/olivia-avatar.jpg', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('image/jpeg').sendFile(path.join(__dirname, 'olivia-avatar.jpg'));
});
// -- Installable app: manifests, service worker, icons (pwa.js) — before the storefront catch-all --
try { require('./pwa').mount(app); } catch (e) { console.log('[pwa] not mounted:', e.message); }
// SEO (seo.js): /robots.txt, /sitemap.xml, /og-image.png and the crawlable /plans, /plans/<service>, /faq, /whats-new, /about pages.
let seo = null;
try { seo = require('./seo'); seo.mount(app); } catch (e) { console.log('[seo] not mounted:', e.message); }
// Share previews (share.js): /og-referral.png + per-link cards for /?post=<id> and /?ref=<CODE> (added in the catch-all below).
let share = null;
try { share = require('./share'); share.mount(app); } catch (e) { console.log('[share] not mounted:', e.message); }
// Offer pictures (stored in app_settings) — before the storefront catch-all.
app.get('/promo-img/:id', async (req, res) => {
  try {
    const img = promosMod && await promosMod.image(req.params.id);
    if (!img) return res.status(404).type('text/plain').send('not found');
    res.set('Cache-Control', 'public, max-age=604800');
    res.type(img.type).send(img.buf);
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

// TMDB posters for the feed, fetched by the server (Indian networks often block image.tmdb.org) and cached.
app.get(['/poster/:size/:file', '/tmdb-img/t/p/:size/:file'], async (req, res) => {
  try {
    const img = feedMod && await feedMod.posterImage(req.params.size, req.params.file);
    if (!img) return res.status(404).type('text/plain').send('not found');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.type(img.type).send(img.buf);
  } catch (e) { res.status(502).type('text/plain').send('poster unavailable'); }
});

// Feed pictures (stored in app_settings) — before the storefront catch-all. The URL carries ?v=<updatedAt>.
app.get('/feed-img/:id', async (req, res) => {
  try {
    const img = feedMod && await feedMod.image(req.params.id);
    if (!img) return res.status(404).type('text/plain').send('not found');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(img.type).send(img.buf);
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

// Customers' own profile photos (photos.js). The id is random per upload (never the phone); a new upload = a new URL.
app.get('/profile-photo/:id', async (req, res) => {
  try {
    const img = photosMod && await photosMod.image(req.params.id);
    if (!img) return res.status(404).type('text/plain').send('not found');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(img.type).send(img.buf);
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

// 🎮 Games page: its own small file (the shop page stays as light as before). Same site = same saved login.
const GAMES_HTML = path.join(__dirname, 'games.html');
app.get(['/games', '/games/'], (_req, res) => {
  if (!fs.existsSync(GAMES_HTML)) return res.status(404).type('text/plain').send('games.html not found');
  res.set('Cache-Control', 'public, max-age=0');
  res.set('X-Robots-Tag', 'noindex, follow');
  res.sendFile(GAMES_HTML);
});

// -- Admin panel (read-only) --
if (admin) admin.mountAdmin(app, { db, ADMIN_KEY, sync });

// -- Serve the storefront --
// The page carries window.FF_VERSION (appversion.js) so an installed app left open can spot a new version.
// res.send keeps the ETag / 304 behaviour sendFile had; max-age=0 = always revalidated.
const appversion = require('./appversion');
appversion.setIndexPath(INDEX);
// seo.decorateIndex adds the live "from ₹X" description + JSON-LD (5-min cache). Other paths show the same app, so they
// are kept out of search results (the page's canonical is always https://shop.fluxfilm.in/).
app.get('*', async (req, res) => {
  const html = INDEX && appversion.page(INDEX);
  if (html) {
    res.set('Cache-Control', 'public, max-age=0');
    if (req.path !== '/' && req.path !== '/index.html') res.set('X-Robots-Tag', 'noindex, follow');
    let out = html;
    if (seo) { try { out = await seo.decorateIndex(html); } catch (_) { out = html; } }
    // Shared links (/?post=<id>, /?ref=<CODE>) get their own title / description / picture; anything invalid keeps the normal head.
    if (share && (req.path === '/' || req.path === '/index.html')) { try { out = await share.decorate(out, req.query); } catch (_) {} }
    return res.type('html').send(out);
  }
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
// Refer & earn: every 30 min pay any referral reward that failed or was missed (e.g. a restart right after a payment).
if (referrals && db.ENABLED) referrals.startReconcileTimer();
// Coins: give back coins held on orders never paid, and settle paid orders (every 10 min).
if (coinsMod && db.ENABLED) coinsMod.startTimer();
// Payment fallback: re-check "I've paid" claims every minute (bank mail also triggers a check, see payments.js).
if (paymatch && db.ENABLED) paymatch.startTimer();
// Offers: save view / click counts once a minute.
if (promosMod && db.ENABLED) promosMod.startTimer();
// Feed: save view / like / click counts once a minute; TMDB auto-publish only if the owner switched it on.
try { if (feedMod && db.ENABLED) feedMod.startTimer({ audit: require('./audit').makeAudit(db) }); } catch (e) { console.log('[feed] timer not started:', e.message); }
// Mark plans EXPIRED once expiry + release date have passed (every hour; replaces the old Apps Script job).
try { if (db.ENABLED) require('./subexpiry').startTimer(); } catch (e) { console.log('[subexpiry] not started:', e.message); }
// Push renewal reminders (3 / 1 days before, expiry day, day after; 09:00-21:00 IST): every hour + 60 s after start.
try { if (pushMod && db.ENABLED) require('./pushreminders').startTimer(); } catch (e) { console.log('[push] reminders not started:', e.message); }
