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
let annivMod = null; try { annivMod = require('./anniversary'); } catch (e) { console.log('[anniversary] not loaded:', e.message); }
let hhMod = null; try { hhMod = require('./householdhelp'); } catch (e) { console.log('[household] not loaded:', e.message); }
let feedMod = null; try { feedMod = require('./feed'); } catch (e) { console.log('[feed] not loaded:', e.message); }
let oliviaMod = null; try { oliviaMod = require('./olivia'); } catch (e) { console.log('[olivia] not loaded:', e.message); }
let photosMod = null; try { photosMod = require('./photos'); } catch (e) { console.log('[photos] not loaded:', e.message); }
let avatarsMod = null; try { avatarsMod = require('./avatars'); } catch (e) { console.log('[avatars] not loaded:', e.message); }
// Self-contained Node actions (recover + Get-OTP tool) — MySQL/IMAP, no Apps Script.
const DB_RECOVER = Object.assign(
  recover ? {
    recoverSendOtp: (a) => recover.sendOtp(a[0], a[1]),
    recoverVerifyOtp: (a) => recover.verifyOtp(a[0], a[1], a[2]),
    recoverListSubscriptionsSafe: (a) => recover.listSubscriptions(a[0], a[1], a[2]),
    recoverGetAccess: (a) => recover.getAccess(a[0], a[1], a[2], a[3]),
  } : {},
  otptool ? {
    // a[2] = device token from otpVerifyCode (required - a phone number alone no longer unlocks OTPs),
    // a[3] = sub id / order id of the plan the customer tapped (only that purchase's login OTP is shown).
    getLatestOtp: (a) => otptool.getLatestOtp(a[0], a[1], typeof a[2] === 'string' ? a[2] : '', typeof a[3] === 'string' ? a[3] : ''),
    // Get OTP: [phone, email] - the code goes only to an email that belongs to an active plan on that phone.
    otpSendCode: (a) => require('./otpaccess').sendGetOtpCode(String(a[0] || ''), String(a[1] || '')),
    // [phone, code, email, kind]: kind 'games' / 'refund' check that tool's email rule; anything else = Get OTP.
    // The email is required (the old phone-only code to the profile email is gone).
    otpVerifyCode: (a) => {
      const ph = String(a[0] || ''); const code = String(a[1] || ''); const em = typeof a[2] === 'string' ? a[2] : '';
      if (!em) return { ok: false, expired: true, message: 'Please type your email and tap "Email me a code" again.' };
      if (a[3] === 'games' && gamesMod) return gamesMod.verifyCode(ph, em, code);
      if (a[3] === 'refund' && refundsMod) return refundsMod.verifyCode(ph, em, code);
      return require('./otpaccess').verifyGetOtpCode(ph, em, code);
    },
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
    // 🔒 Profile email lock (emaillock.js). a = [phone, subId?] / [phone, purpose, email, target] / [phone, purpose, code, email, target].
    emailLockStatus: (a) => require('./emaillock').status(a[0], a[1]),
    emailSendCode: (a) => require('./emaillock').sendCode(a[0], String(a[1] || ''), { email: a[2], target: a[3] }),
    emailVerifyCode: (a) => require('./emaillock').verifyCode(a[0], String(a[1] || ''), a[2], { email: a[3], target: a[4] }),
    // a = [{ phone, email, emailToken, oldEmailToken }] — only the email changes (name kept).
    changeProfileEmail: (a) => account.changeProfileEmail(a[0]),
  } : {},
  // Own profile photo (Account → Profile). a = [phone, dataUrl] / [phone, avatarUrlToGoBackTo].
  photosMod ? {
    setProfilePhoto: (a) => photosMod.setProfilePhoto(a[0], a[1]),
    removeProfilePhoto: (a) => photosMod.removeProfilePhoto(a[0], a[1]),
  } : {},
  // ✨ Avatar creator (avatars.js). a = [phone, config object] — checked strictly on the server.
  avatarsMod ? { setAvatar: (a) => avatarsMod.setAvatar(a[0], a[1]) } : {},
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
  } : {},
  // 🎉 Anniversary sale countdown (admin → 🎉 Anniversary). The bar is public; being told needs a session, because
  // it writes that customer's number down. a = [phone].
  annivMod ? {
    getAnniversary: () => annivMod.publicInfo(),
    anniversaryNotify: (a) => annivMod.notifyMe(a[0]),
  } : {},
  // 🏠 Netflix Household (Tools). The pictures are public — they are only example screenshots. Everything else
  // needs the customer's session, and householdhelp.js checks the account really is theirs before it acts.
  // a = [phone] / [phone, accountId, what].
  hhMod ? {
    householdPics: () => hhMod.pictures(),
    // req is passed on so the change log can record where the request came from.
    householdStart: (a, req) => hhMod.start(a[0], null, req),
    householdFix: (a, req) => hhMod.fix(a[0], a[1], a[2], null, req),
  } : {}
);

const security = require('./security');
// 🔐 Email login + signed customer sessions. Every storefront action is listed in customerAuth.POLICY.
let customerAuth = null; try { customerAuth = require('./customerauth'); } catch (e) { console.log('[email-login] not loaded:', e.message); }
const AUTH_DEPS = { required: () => (storeMod ? storeMod.emailLoginRequired() : Promise.resolve(true)) };

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
  getAnniversary: security.rateLimiter(200, TEN_MIN),
  anniversaryNotify: security.rateLimiter(20, TEN_MIN),
  householdPics: security.rateLimiter(200, TEN_MIN),
  householdStart: security.rateLimiter(60, TEN_MIN),
  householdFix: security.rateLimiter(20, TEN_MIN),
  promoEvent: security.rateLimiter(120, TEN_MIN),
  getPushKey: security.rateLimiter(60, TEN_MIN),
  pushSubscribe: security.rateLimiter(20, TEN_MIN),
  pushUnsubscribe: security.rateLimiter(20, TEN_MIN),
  setProfilePhoto: security.rateLimiter(10, TEN_MIN),
  // Email lock: the real caps (per phone + per email per hour, 5 tries per code, 30 s resend) live in emaillock.js /
  // app_settings so they survive a restart; these per-IP limits only stop floods.
  emailLockStatus: security.rateLimiter(120, TEN_MIN),
  emailSendCode: security.rateLimiter(12, 60 * 60e3),
  emailVerifyCode: security.rateLimiter(40, 15 * 60e3),
  changeProfileEmail: security.rateLimiter(20, TEN_MIN),
  // 🔐 Email login: real caps (per phone + per email per hour, 5 tries, 30 s resend) are in emaillock.js / app_settings.
  loginStatus: security.rateLimiter(300, TEN_MIN),
  loginStart: security.rateLimiter(20, 60 * 60e3),
  loginSignup: security.rateLimiter(10, 60 * 60e3),
  loginVerify: security.rateLimiter(40, 15 * 60e3),
  logout: security.rateLimiter(60, TEN_MIN),
  logoutAll: security.rateLimiter(20, TEN_MIN),
  any: security.rateLimiter(3000, TEN_MIN),
};
const PROFILE_WRITES = new Set(['createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'setAvatar', 'removeProfilePhoto', 'submitRestockRequest']);
// Per-phone limits (independent of IP) for actions that email or reveal codes.
const PHONE_LIMITS = {
  // 🔐 A code request is the powerful one: at most 10 per number per hour, whichever account.
  householdFix: security.rateLimiter(10, 60 * 60e3),
  // 6 (was 3): a wrong-email try also counts, and recover.js already waits 30 s between real code emails.
  recoverSendOtp: security.rateLimiter(6, 15 * 60e3),
  getLatestOtp: security.rateLimiter(15, TEN_MIN),
  otpSendCode: security.rateLimiter(4, 60 * 60e3),
  otpVerifyCode: security.rateLimiter(12, 15 * 60e3),
  pushSubscribe: security.rateLimiter(10, 60 * 60e3),
  setProfilePhoto: security.rateLimiter(6, 60 * 60e3),
  removeProfilePhoto: security.rateLimiter(10, 60 * 60e3),
  setAvatar: security.rateLimiter(20, 60 * 60e3),
  emailSendCode: security.rateLimiter(8, 60 * 60e3),
  emailVerifyCode: security.rateLimiter(20, 15 * 60e3),
  loginStart: security.rateLimiter(10, 60 * 60e3),
  loginSignup: security.rateLimiter(6, 60 * 60e3),
  loginVerify: security.rateLimiter(20, 15 * 60e3),
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
const DB_STOREFRONT_ACTIONS = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems', 'getNetflixHouseholdLink', 'createOrUpdateCustomerProfile', 'createCustomerProfile', 'updateCustomerProfilePic', 'setProfilePhoto', 'removeProfilePhoto', 'setAvatar', 'getOrderStatus', 'getResumePaymentByPhone', 'submitRestockRequest', 'getReferralInfo', 'checkReferral', 'getCoinQuote', 'getCoinHistory', 'getBackupPayment', 'claimManualPayment', 'getClaimStatus', 'getStoreStatus', 'getPromos', 'promoEvent', 'getPushKey', 'pushSubscribe', 'pushUnsubscribe', 'getAnniversary', 'anniversaryNotify', 'householdPics', 'householdStart', 'householdFix']);
// 🔒 Profile email lock (emaillock.js): status, email codes, change email.
['emailLockStatus', 'emailSendCode', 'emailVerifyCode', 'changeProfileEmail'].forEach((a) => DB_STOREFRONT_ACTIONS.add(a));
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
    // a = [[postId, …]] → newest 3 visible comments per post (posts near the screen, ≤ 12, cached 30 s).
    getFeedCommentPreviews: (a) => feedCommentsMod.previews(a[0]),
  });
  DB_STOREFRONT_ACTIONS.add('getFeedComments'); DB_STOREFRONT_ACTIONS.add('addFeedComment'); DB_STOREFRONT_ACTIONS.add('getFeedCommentPreviews');
  LIMITS.getFeedComments = security.rateLimiter(300, TEN_MIN);
  LIMITS.getFeedCommentPreviews = security.rateLimiter(300, TEN_MIN);
  LIMITS.addFeedComment = security.rateLimiter(40, TEN_MIN);
  PHONE_LIMITS.addFeedComment = security.rateLimiter(10, TEN_MIN);
}
// ❤️ 🔖 Liked / saved posts follow the customer's account (feedmarks.js, db/schema-v25.sql). Same phone session as comments.
// a = [phone, postId, 'like' | 'save', on] / [phone] / [phone, { liked: [ids], saved: [ids] }]. Before schema-v25: ready false.
let feedMarksMod = null; try { feedMarksMod = require('./feedmarks'); } catch (e) { console.log('[feed marks] not loaded:', e.message); }
if (feedMod && feedMarksMod) {
  Object.assign(DB_STOREFRONT, {
    setFeedMark: (a) => feedMarksMod.set(a[0], a[1], a[2], a[3]),
    getFeedMarks: (a) => feedMarksMod.list(a[0]),
    importFeedMarks: (a) => feedMarksMod.importLocal(a[0], a[1]),
  });
  DB_STOREFRONT_ACTIONS.add('setFeedMark'); DB_STOREFRONT_ACTIONS.add('getFeedMarks'); DB_STOREFRONT_ACTIONS.add('importFeedMarks');
  LIMITS.setFeedMark = security.rateLimiter(400, TEN_MIN);
  LIMITS.getFeedMarks = security.rateLimiter(200, TEN_MIN);
  LIMITS.importFeedMarks = security.rateLimiter(20, TEN_MIN);
  PHONE_LIMITS.setFeedMark = security.rateLimiter(120, TEN_MIN);
  PHONE_LIMITS.getFeedMarks = security.rateLimiter(60, TEN_MIN);
  PHONE_LIMITS.importFeedMarks = security.rateLimiter(6, 60 * 60e3);
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
    gamesSendCode: (a) => gamesMod.sendCode(String(a[0] || ''), String(a[1] || '')), // [phone, email]
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
// 💸 Refunds v3 (refunds.js): the customer chooses how to get a refund — coins or a coupon (+bonus%, instant) or the
// exact amount to a UPI ID (email code → admin 💸 Refunds to send). Works for not-delivered refunds (id FF…) and refund
// offers on delivered plans (id RO…). Amounts always come from the server.
// a = [phone] / [phone, id] / [phone, id, method COINS|COUPON] / [phone, id, upiId, deviceToken] / [phone, orderId].
let refundsMod = null; try { refundsMod = require('./refunds'); } catch (e) { console.log('[refunds] not loaded:', e.message); }
if (refundsMod) {
  Object.assign(DB_STOREFRONT, {
    getPendingRefunds: (a) => refundsMod.getPendingRefunds(a[0]),
    convertRefundToCredit: (a) => refundsMod.convertToCredit(a[0], a[1]),
    chooseRefund: (a) => refundsMod.chooseRefund(a[0], a[1], typeof a[2] === 'string' ? a[2] : ''),
    refundSendCode: (a) => refundsMod.sendCode(String(a[0] || ''), String(a[1] || '')), // [phone, email]
    requestUpiRefund: (a) => refundsMod.requestUpi(a[0], a[1], a[2], a[3]),
    refundSentSeen: (a) => refundsMod.markSentSeen(a[0], a[1]),
  });
  ['getPendingRefunds', 'convertRefundToCredit', 'chooseRefund', 'refundSendCode', 'requestUpiRefund', 'refundSentSeen'].forEach((x) => DB_STOREFRONT_ACTIONS.add(x));
  Object.assign(LIMITS, {
    getPendingRefunds: security.rateLimiter(120, TEN_MIN), convertRefundToCredit: security.rateLimiter(20, TEN_MIN), chooseRefund: security.rateLimiter(20, TEN_MIN),
    refundSendCode: security.rateLimiter(10, 60 * 60e3), requestUpiRefund: security.rateLimiter(20, TEN_MIN), refundSentSeen: security.rateLimiter(60, TEN_MIN),
  });
  Object.assign(PHONE_LIMITS, {
    convertRefundToCredit: security.rateLimiter(10, TEN_MIN), chooseRefund: security.rateLimiter(10, TEN_MIN), refundSendCode: security.rateLimiter(4, 60 * 60e3), requestUpiRefund: security.rateLimiter(10, TEN_MIN),
  });
}
// 💸 Request refund (refundrequests.js): Account → Request refund. a = [phone] / [phone, { orderId | subId, reason, text }].
// The server decides what can be requested (48 h from payment for undelivered orders, India time); max 5 a day per phone.
let refundRequestsMod = null; try { refundRequestsMod = require('./refundrequests'); } catch (e) { console.log('[refund requests] not loaded:', e.message); }
if (refundRequestsMod) {
  Object.assign(DB_STOREFRONT, {
    getRefundRequestItems: (a) => refundRequestsMod.listItems(a[0]),
    createRefundRequest: (a) => refundRequestsMod.createRequest(a[0], a[1] && typeof a[1] === 'object' ? { orderId: a[1].orderId, subId: a[1].subId, reason: a[1].reason, text: a[1].text } : {}),
  });
  ['getRefundRequestItems', 'createRefundRequest'].forEach((x) => DB_STOREFRONT_ACTIONS.add(x));
  Object.assign(LIMITS, { getRefundRequestItems: security.rateLimiter(60, TEN_MIN), createRefundRequest: security.rateLimiter(20, TEN_MIN) });
  // Tries per phone (memory); refundrequests.js also allows at most 5 saved requests a day per phone (database).
  Object.assign(PHONE_LIMITS, { createRefundRequest: security.rateLimiter(10, 24 * 60 * 60e3) });
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
// 🔒 The go → shop import finished on 14 Sep 2026 and MySQL is the master, so pulling the Sheet over MySQL would
// undo real work. The route stays for a real emergency but refuses unless ALLOW_SHEET_SYNC=1 is set in Hostinger.
const SHEET_SYNC_ALLOWED = () => String(process.env.ALLOW_SHEET_SYNC || '') === '1';
app.get('/admin/sync', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!SHEET_SYNC_ALLOWED()) {
    return res.status(409).json({ ok: false, locked: true, message: 'The Sheet import is switched off: MySQL is the master and the one-time go-live import is done. If you really need it, set ALLOW_SHEET_SYNC=1 in Hostinger first.' });
  }
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
    return res.status(429).json({ ok: false, rateLimited: true, message: (action === 'recoverSendOtp' ? 'Too many tries for this number — please wait ' + Math.ceil(limited.retryAfterSec / 60) + ' min. A code we already emailed still works for 10 minutes.' : 'Too many requests — please wait ' + Math.ceil(limited.retryAfterSec / 60) + ' min and try again.') });
  }
  const dbUnavailable = () => res.status(503).json({ ok: false, message: 'The FluxFilm database is temporarily unavailable. No order or update was sent to the old system.' });
  const dbError = (label, e) => {
    console.log('[' + label + '] MySQL-only action failed:', action, e.message);
    return res.status(500).json({ ok: false, message: 'Something went wrong in the FluxFilm database. Nothing was sent to the old system. Please try again.', detail: process.env.NODE_ENV === 'production' ? undefined : e.message });
  };

  // 🔐 Email login (customerauth.js): the login actions themselves, then the session check for everything else.
  if (customerAuth && customerAuth.LOGIN_ACTIONS.has(action)) {
    if (!db.ENABLED) return dbUnavailable();
    try {
      const out = await customerAuth.handle(action, a, req, res, AUTH_DEPS);
      res.set('Cache-Control', 'no-store');
      return res.type('application/json').send(JSON.stringify(out));
    } catch (e) { return dbError('email-login', e); }
  }
  if (customerAuth && db.ENABLED && (DB_READ_ACTIONS.has(action) || DB_STOREFRONT_ACTIONS.has(action) || DB_RECOVER_ACTIONS.has(action) || DB_WRITE_ACTIONS.has(action))) {
    try {
      const g = await customerAuth.guard(action, a, req, AUTH_DEPS);
      if (!g.ok) return res.status(g.status || 401).json(g.body);
    } catch (e) { return dbError('email-login', e); }
  }

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
      // A right Recover code proves an email on this phone's plan: this browser is logged in too.
      if (action === 'recoverVerifyOtp' && customerAuth && out && out.ok && out.recoverToken) await customerAuth.afterRecoverVerified(a[0], req, res);
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
// The drawn pictures for 🧰 Tools → 🏠 Netflix Household (householdpics.js), loaded by index.html and the admin panel.
app.get('/household-pics.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('Content-Type', 'application/javascript; charset=utf-8').sendFile(path.join(__dirname, 'householdpics.js'));
});
// Olivia's photo for the chat header / Help sheet (AI-generated, 256 px). The widget asks for ?v=N, so it can be cached long.
app.get('/olivia-avatar.jpg', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('image/jpeg').sendFile(path.join(__dirname, 'olivia-avatar.jpg'));
});
// Olivia's full photo (900 px) for "tap the photo" in her profile.
app.get('/olivia-photo.jpg', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('image/jpeg').sendFile(path.join(__dirname, 'olivia-photo.jpg'));
});
// -- Installable app: manifests, service worker, icons (pwa.js) — before the storefront catch-all --
try { require('./pwa').mount(app); } catch (e) { console.log('[pwa] not mounted:', e.message); }
// 💳 /pay/<orderId>?t=… — the QR + UPI button we send a customer instead of marking the order paid by hand.
try { require('./paylink').mount(app, { db }); } catch (e) { console.log('[paylink] not mounted:', e.message); }
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

// 🎬 Uploaded Reel videos (feedvideo.js, MySQL chunks): /v/<id>.mp4 with HTTP Range (206), ETag, immutable cache.
let feedVideoMod = null; try { feedVideoMod = require('./feedvideo'); } catch (e) { console.log('[feed video] not loaded:', e.message); }
app.get('/v/:file', async (req, res) => {
  if (!feedVideoMod || !/^fv[0-9a-f]{16}\.(mp4|webm)$/.test(req.params.file)) return res.status(404).type('text/plain').send('not found');
  try { await feedVideoMod.serve(req, res); } catch (e) { if (!res.headersSent) res.status(500).type('text/plain').send('error'); else res.destroy(); }
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

// ✨ Creator avatars: the SVG is drawn by the server from the short code (avatars.js). Same code = same picture.
app.get('/avatar/:file', (req, res) => {
  const svg = avatarsMod && avatarsMod.render(req.params.file);
  if (!svg) return res.status(404).type('text/plain').send('not found');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.type('image/svg+xml').send(svg);
});
// The avatar creator's drawing code for the browser — loaded only when "✨ Create your avatar" opens.
app.get('/avatar-maker.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=0');
  res.set('Content-Type', 'application/javascript; charset=utf-8').sendFile(path.join(__dirname, 'avatarmaker.js'));
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

// 🔗 n8n (n8n.js): /n8n/api/* with its own X-N8N-Key (not a storefront /api action, not the admin key) + the customer
// /unsubscribe page. Before the storefront catch-all.
try { const n8nMod = require('./n8n'); n8nMod.setIndexPath(INDEX); n8nMod.mount(app, { audit: require('./audit').makeAudit(db) }); } catch (e) { console.log('[n8n] not mounted:', e.message); }

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
if (db.ENABLED && SYNC_INTERVAL_MIN > 0 && SHEET_SYNC_ALLOWED()) {
  setTimeout(autoSync, 30000); // first run 30s after boot
  setInterval(autoSync, SYNC_INTERVAL_MIN * 60 * 1000);
  console.log('[autosync] enabled every ' + SYNC_INTERVAL_MIN + ' min');
}

if (db.ENABLED && payments) { try { payments.startWatcher(); } catch (e) { console.log('[imap] start error', e.message); } }

const httpServer = app.listen(PORT, () => console.log('[FluxFilm] listening on :' + PORT + ' (MySQL-only storefront)'));
// Tests (test/email-login.test.js) start the real app on a free port with a fake database.
module.exports = { app, httpServer };
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
// 🎉 The sale announcement goes out by itself on the day — an hourly tick, so nothing has to be set up on Hostinger.
// A cron job hitting POST /cron/anniversary does the same work behind the same "never twice" guard.
if (annivMod && db.ENABLED) annivMod.startTimer();
// 📊 Owner business summaries: daily 23:30 / weekly Sunday 23:45 / monthly last day 23:50 IST (times in admin), checked
// every minute; a DB guard row per period stops double sends; missed by a restart → sent within 6 h, else skipped.
try { if (db.ENABLED) require('./reports').startTimer(); } catch (e) { console.log('[reports] scheduler not started:', e.message); }
// 📡 n8n webhooks (n8nhooks.js): order.paid / order.delivered / subscription.expired (00:05 IST) / post.published, every 60 s.
// Sends nothing until a webhook URL is saved in admin → 🔗 Integrations; never touches the order flow.
try { if (db.ENABLED) require('./n8nhooks').startTimer(); } catch (e) { console.log('[n8n hooks] not started:', e.message); }
