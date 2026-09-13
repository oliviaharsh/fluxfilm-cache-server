/**
 * FluxFilm - security helpers (no extra dependencies).
 *
 *  - Admin sign-in: password (ADMIN_PASSWORD) -> signed, HttpOnly session cookie.
 *    The admin key no longer travels in URLs, so it can't leak via browser
 *    history, screenshots, proxies or server logs.
 *  - In-memory rate limiter for login and the sensitive storefront actions.
 *  - CORS allow-list and basic security headers.
 */
const crypto = require('crypto');

const COOKIE = 'ff_admin';
const SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS || 12);

/** The admin password. Falls back to the old key so a deploy can't lock the owner out. */
function adminPassword(env) {
  const e = env || process.env;
  return String(e.ADMIN_PASSWORD || e.CACHE_CLEAR_KEY || '');
}
function usingFallbackPassword(env) {
  const e = env || process.env;
  return !e.ADMIN_PASSWORD;
}
/** Signing secret. Derived from the password when not set, so changing the password signs everyone out. */
function sessionSecret(env) {
  const e = env || process.env;
  return String(e.ADMIN_SESSION_SECRET || '') || crypto.createHash('sha256').update('ff-admin-session|' + adminPassword(e)).digest('hex');
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function makeSession(now, env) {
  const exp = (now || Date.now()) + SESSION_HOURS * 3600e3;
  const payload = 'v1.' + exp + '.' + crypto.randomBytes(9).toString('base64url');
  return payload + '.' + sign(payload, sessionSecret(env));
}
function verifySession(value, now, env) {
  const v = String(value || '');
  const i = v.lastIndexOf('.');
  if (i < 0 || !adminPassword(env)) return false;
  const payload = v.slice(0, i), sig = v.slice(i + 1);
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  if (!safeEqual(sig, sign(payload, sessionSecret(env)))) return false;
  return Number(parts[1]) > (now || Date.now());
}

function parseCookies(req) {
  const out = {};
  String((req.headers && req.headers.cookie) || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) { /* ignore bad cookie */ } }
  });
  return out;
}
function isLocal(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String((req.headers && req.headers.host) || '')); }
function sessionCookie(req, value, maxAgeSec) {
  return COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec + (isLocal(req) ? '' : '; Secure');
}

/** True when the request carries a valid admin session, or the admin key in the X-Admin-Key header (scripts). */
function isAdmin(req, env) {
  const e = env || process.env;
  if (verifySession(parseCookies(req)[COOKIE], Date.now(), e)) return true;
  const hdr = req.headers && req.headers['x-admin-key'];
  const key = String(e.CACHE_CLEAR_KEY || '');
  return !!(hdr && key && safeEqual(hdr, key));
}

/** Fixed-window limiter. hit(key) -> { ok, retryAfterSec }. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  let lastSweep = Date.now();
  return {
    hit(key, now) {
      const t = now || Date.now();
      if (t - lastSweep > windowMs) { for (const [k, v] of hits) if (t >= v.reset) hits.delete(k); lastSweep = t; }
      let h = hits.get(key);
      if (!h || t >= h.reset) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
      h.n += 1;
      return { ok: h.n <= max, retryAfterSec: Math.max(1, Math.ceil((h.reset - t) / 1000)) };
    },
    /** Hits so far in the current window (does not add one). */
    count(key, now) { const h = hits.get(key); return h && (now || Date.now()) < h.reset ? h.n : 0; },
    reset(key) { hits.delete(key); },
    _hits: hits,
  };
}

function clientIp(req) { return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'); }

const DEFAULT_ORIGINS = ['https://shop.fluxfilm.in', 'https://go.fluxfilm.in', 'https://fluxfilm.in', 'https://www.fluxfilm.in'];
function allowedOrigins(env) {
  const e = env || process.env;
  const extra = String(e.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return new Set(DEFAULT_ORIGINS.concat(extra));
}
/** cors() options: same-origin / server-to-server requests (no Origin) are fine; other sites are refused. */
function corsOptions(env) {
  const ok = allowedOrigins(env);
  return { origin: (origin, cb) => cb(null, !origin || ok.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) };
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path === '/panel' || req.path.startsWith('/admin')) {
    res.set('X-Frame-Options', 'DENY');
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
}

module.exports = {
  COOKIE, adminPassword, usingFallbackPassword, makeSession, verifySession, parseCookies, sessionCookie,
  isAdmin, safeEqual, rateLimiter, clientIp, corsOptions, allowedOrigins, securityHeaders, SESSION_HOURS,
};
