/**
 * FluxFilm - Web Push (phone / desktop notifications) with NO extra npm packages.
 *
 *   VAPID (RFC 8292): ES256 JWT signed with Node crypto. The key pair is made on first use and kept in
 *                     app_settings 'push_vapid' (never sent anywhere; only the public key goes to browsers).
 *   Encryption (RFC 8291 + RFC 8188 aes128gcm): ECDH P-256 + HKDF(HMAC-SHA-256) + AES-128-GCM, one record.
 *   Storage: table push_subscriptions (db/schema-v18.sql). Every function fails soft when the table is missing.
 *
 *   publicKeyInfo()                          → { ok, publicKey }
 *   subscribe({ phone, subscription, userAgent, app })   app 'store' (customer) | 'admin' (owner's phones)
 *   unsubscribe(endpoint, app)
 *   sendToPhone(phone, message) · sendToAdmins(message) · broadcast(message)   → { ok, sent, failed, removed, devices }
 *   stats()
 */
const crypto = require('crypto');
const https = require('https');
const db = require('./db');

const VAPID_KEY = 'push_vapid';
const SUBJECT = 'https://shop.fluxfilm.in';
const SCHEMA_MSG = 'Notifications need a database update — run db/schema-v18.sql in phpMyAdmin first.';
const MAX_PER_PHONE = 5;        // devices per customer; the oldest is dropped
const DISABLE_AFTER_FAILS = 10; // endpoint switched off after this many failures in a row
const PAYLOAD_MAX = 3000;       // bytes of JSON (a record is 4096 bytes including overhead)
// Only real browser push services (also stops the server being used to call arbitrary URLs).
const PUSH_HOST = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com)$/i;

const s = (v) => String(v == null ? '' : v).trim();
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (str) => Buffer.from(s(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const normPhone = (p) => s(p).replace(/\D/g, '').slice(-10);
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e && e.message));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ---------------- VAPID ----------------
function makeVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateJwk: jwk, subject: SUBJECT, createdAt: new Date().toISOString() };
}
let vapidCache = null;
async function getVapid() {
  if (vapidCache) return vapidCache;
  let rows = [];
  try { rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [VAPID_KEY]); } catch (e) { if (!missingTable(e)) throw e; }
  let v = null;
  try { v = rows.length ? JSON.parse(rows[0].value) : null; } catch (_) { v = null; }
  if (!v || !v.publicKey || !v.privateJwk) {
    v = makeVapid();
    // INSERT IGNORE: if two requests race, the first key wins and everyone re-reads it.
    await db.query('INSERT IGNORE INTO app_settings (setting_key, value) VALUES (?, ?)', [VAPID_KEY, JSON.stringify(v)]);
    const again = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [VAPID_KEY]);
    try { if (again.length) v = JSON.parse(again[0].value); } catch (_) {}
  }
  vapidCache = v;
  return v;
}
function vapidJwt(audience, vapid, nowSec) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: (nowSec || Math.floor(Date.now() / 1000)) + 12 * 3600, sub: vapid.subject || SUBJECT }));
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  return header + '.' + claims + '.' + b64u(sig);
}

// ---------------- RFC 8291 encryption ----------------
function encrypt(payload, p256dh, authSecret, opts) {
  const o = opts || {};
  const uaPublic = Buffer.isBuffer(p256dh) ? p256dh : unb64u(p256dh);
  const auth = Buffer.isBuffer(authSecret) ? authSecret : unb64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = o.salt || crypto.randomBytes(16);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).slice(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).slice(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// ---------------- subscriptions ----------------
function checkSubscription(sub) {
  const x = sub && typeof sub === 'object' ? sub : {};
  const endpoint = s(x.endpoint);
  const keys = x.keys || {};
  if (!endpoint || endpoint.length > 700) return { ok: false, message: 'Notification address is not valid.' };
  let u; try { u = new URL(endpoint); } catch (_) { return { ok: false, message: 'Notification address is not valid.' }; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !PUSH_HOST.test(u.hostname)) return { ok: false, message: 'This browser\'s notification service is not supported.' };
  const p = s(keys.p256dh); const a = s(keys.auth);
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p) || !/^[A-Za-z0-9_-]{16,32}$/.test(a)) return { ok: false, message: 'Notification keys are not valid.' };
  const pb = unb64u(p); const ab = unb64u(a);
  if (pb.length !== 65 || pb[0] !== 4 || ab.length !== 16) return { ok: false, message: 'Notification keys are not valid.' };
  return { ok: true, endpoint, p256dh: p, auth: a };
}

async function publicKeyInfo() { return { ok: true, publicKey: (await getVapid()).publicKey }; }

async function subscribe(input) {
  const i = input || {};
  const app = i.app === 'admin' ? 'admin' : 'store';
  const c = checkSubscription(i.subscription);
  if (!c.ok) return c;
  const phone = s(i.phone).replace(/[^\d+]/g, '').slice(0, 20);
  const ph = normPhone(phone);
  if (app === 'store' && ph.length !== 10) return { ok: false, message: 'Please log in with your phone number first.' };
  try {
    if (app === 'store') {
      const known = await db.query('SELECT 1 AS x FROM subscriptions WHERE phone_norm = ? LIMIT 1', [ph]);
      if (!known.length) return { ok: false, message: 'Reminders are for customers with a FluxFilm plan.' };
    }
    const ua = s(i.userAgent).replace(/[<>]/g, '').slice(0, 200) || null;
    // Same browser for the shop and the admin panel = one endpoint: an admin device stays an admin device.
    await db.query(
      'INSERT INTO push_subscriptions (phone, phone_norm, endpoint, p256dh, auth, user_agent, app, created_at, fail_count, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 0, 0) ' +
      "ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent), fail_count = 0, disabled = 0, " +
      (app === 'store' ? "phone = VALUES(phone), phone_norm = VALUES(phone_norm), app = IF(app = 'admin', 'admin', 'store')" : "app = 'admin'"),
      [app === 'store' ? phone : '', app === 'store' ? ph : '', c.endpoint, c.p256dh, c.auth, ua, app]);
    if (app === 'store') {
      const mine = await db.query("SELECT id FROM push_subscriptions WHERE phone_norm = ? AND app = 'store' ORDER BY created_at DESC, id DESC", [ph]);
      const extra = mine.slice(MAX_PER_PHONE).map((r) => Number(r.id)).filter(Boolean);
      for (const id of extra) await db.query('DELETE FROM push_subscriptions WHERE id = ?', [id]);
    }
    return { ok: true, message: app === 'store' ? '🔔 Renewal reminders are on for this device.' : '🔔 This device will get admin notifications.' };
  } catch (e) {
    if (missingTable(e)) return { ok: false, needSchema: true, message: app === 'store' ? 'Reminders are not available yet — please try again later.' : SCHEMA_MSG };
    throw e;
  }
}

async function unsubscribe(endpoint, app) {
  const ep = s(endpoint);
  if (!ep || ep.length > 700) return { ok: false, message: 'Notification address is not valid.' };
  try {
    if (app === 'admin') {
      // Keep it if a customer phone is also attached to this browser.
      await db.query("UPDATE push_subscriptions SET app = 'store' WHERE endpoint = ? AND phone_norm <> ''", [ep]);
      await db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND app = 'admin'", [ep]);
    } else {
      await db.query("UPDATE push_subscriptions SET phone = '', phone_norm = '' WHERE endpoint = ? AND app = 'admin'", [ep]);
      await db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND app = 'store'", [ep]);
    }
    return { ok: true, message: '🔕 Notifications are off for this device.' };
  } catch (e) {
    if (missingTable(e)) return { ok: true, message: '🔕 Notifications are off.' };
    throw e;
  }
}

// ---------------- sending ----------------
function httpsTransport(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { if (data.length < 2000) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('push service timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
let transport = httpsTransport;

function cleanMessage(m) {
  const x = m || {};
  let url = s(x.url);
  if (!/^\/[^\s<>"]*$/.test(url) && !/^https:\/\/[^\s<>"]+$/i.test(url)) url = '/';
  const ts = Number(x.ts);
  const out = { title: s(x.title).slice(0, 80) || 'FluxFilm', body: s(x.body).slice(0, 240), url: url.slice(0, 300), tag: s(x.tag).replace(/[^\w:-]/g, '').slice(0, 60) || undefined, icon: x.icon === 'admin' ? '/icons/admin-icon-192.png' : '/icons/icon-192.png', ts: isFinite(ts) && ts > 0 ? Math.round(ts) : Date.now() };
  return out;
}

/**
 * Urgency + TTL per kind of notification. Android puts a phone with the screen off into Doze: "normal" pushes then
 * wait until the phone wakes, "high" ones are delivered at once. Everything a customer / the owner is waiting for
 * is high; broadcasts / promos stay normal (unless the owner picks high for one broadcast).
 *   reminder  renewal reminders       high · 24 h
 *   delivered "your access is ready"  high · 24 h
 *   refund    refund / credit notices high · 24 h
 *   admin     owner alerts (new order, UPI refund to send) high · 24 h
 *   test      admin test              high · 10 min
 *   direct    owner → one customer    high · 24 h
 *   broadcast promos to everyone      normal · 24 h
 */
const URGENCIES = ['very-low', 'low', 'normal', 'high'];
const KINDS = {
  reminder: { urgency: 'high', ttl: 24 * 3600 },
  delivered: { urgency: 'high', ttl: 24 * 3600 },
  refund: { urgency: 'high', ttl: 24 * 3600 },
  admin: { urgency: 'high', ttl: 24 * 3600 },
  test: { urgency: 'high', ttl: 10 * 60 },
  direct: { urgency: 'high', ttl: 24 * 3600 },
  broadcast: { urgency: 'normal', ttl: 24 * 3600 },
};
/** opts { kind, urgency?, ttl? } → { urgency, ttl }. An explicit valid urgency / ttl wins over the kind's default. */
function deliveryFor(opts) {
  const o = opts || {};
  const k = KINDS[o.kind] || { urgency: 'normal', ttl: 24 * 3600 };
  const ttl = Math.round(Number(o.ttl));
  return { urgency: URGENCIES.includes(o.urgency) ? o.urgency : k.urgency, ttl: isFinite(ttl) && ttl > 0 ? Math.min(ttl, 28 * 86400) : k.ttl };
}

async function sendOne(row, message, opts) {
  const o = opts || {};
  const vapid = await getVapid();
  const json = JSON.stringify(cleanMessage(message));
  if (Buffer.byteLength(json) > PAYLOAD_MAX) return { ok: false, status: 0, error: 'message too long' };
  const u = new URL(row.endpoint);
  const dl = deliveryFor(o);
  const headers = {
    Authorization: 'vapid t=' + vapidJwt(u.origin, vapid) + ', k=' + vapid.publicKey,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(dl.ttl),
    Urgency: dl.urgency,
  };
  const body = encrypt(json, row.p256dh, row.auth);
  headers['Content-Length'] = String(body.length);
  let r;
  try { r = await transport(row.endpoint, headers, body); } catch (e) { r = { status: 0, body: e.message }; }
  const status = Number(r && r.status) || 0;
  try {
    if (status >= 200 && status < 300) { await db.query('UPDATE push_subscriptions SET last_ok_at = NOW(), fail_count = 0 WHERE id = ?', [row.id]); return { ok: true, status }; }
    if (status === 404 || status === 410) { await db.query('DELETE FROM push_subscriptions WHERE id = ?', [row.id]); return { ok: false, status, removed: true }; }
    await db.query('UPDATE push_subscriptions SET fail_count = fail_count + 1, disabled = IF(fail_count >= ?, 1, disabled) WHERE id = ?', [DISABLE_AFTER_FAILS, row.id]);
  } catch (_) { /* bookkeeping only */ }
  return { ok: false, status, error: s(r && r.body).slice(0, 120) };
}

async function sendToRows(rows, message, opts) {
  const out = { ok: true, devices: rows.length, sent: 0, failed: 0, removed: 0, phones: 0 };
  const phonesOk = new Set();
  const batch = (opts && opts.concurrency) || 10;
  for (let i = 0; i < rows.length; i += batch) {
    const res = await Promise.all(rows.slice(i, i + batch).map((r) => sendOne(r, message, opts).catch((e) => ({ ok: false, error: e.message }))));
    res.forEach((x, k) => { if (x.ok) { out.sent++; if (rows[i + k].phone_norm) phonesOk.add(rows[i + k].phone_norm); } else if (x.removed) out.removed++; else out.failed++; });
  }
  out.phones = phonesOk.size;
  return out;
}

const COLS = 'SELECT id, phone_norm, endpoint, p256dh, auth, app FROM push_subscriptions ';
async function rowsFor(where, params) {
  try { return { rows: await db.query(COLS + 'WHERE disabled = 0 AND ' + where + ' ORDER BY id LIMIT 5000', params || []) }; }
  catch (e) { if (missingTable(e)) return { needSchema: true, rows: [] }; throw e; }
}
async function sendWhere(where, params, message, opts) {
  const r = await rowsFor(where, params);
  if (r.needSchema) return { ok: false, needSchema: true, message: SCHEMA_MSG, devices: 0, sent: 0, failed: 0, removed: 0, phones: 0 };
  return sendToRows(r.rows, message, opts);
}
async function sendToPhone(phone, message, opts) {
  const ph = normPhone(phone);
  if (ph.length !== 10) return { ok: false, message: 'Enter a 10-digit phone number.', devices: 0, sent: 0, failed: 0, removed: 0, phones: 0 };
  return sendWhere('phone_norm = ?', [ph], message, opts);
}
// Owner alerts are high urgency by default (kind 'admin'); broadcasts normal (kind 'broadcast').
const sendToAdmins = (message, opts) => sendWhere("app = 'admin'", [], Object.assign({ icon: 'admin' }, message), Object.assign({ kind: 'admin' }, opts));
const broadcast = (message, opts) => sendWhere("phone_norm <> ''", [], message, Object.assign({ kind: 'broadcast' }, opts));
async function hasDevice(phone) {
  const r = await rowsFor('phone_norm = ?', [normPhone(phone)]);
  return r.rows.length > 0;
}

async function stats() {
  try {
    const q = async (sql) => ((await db.query(sql, []))[0] || {});
    const a = await q("SELECT COUNT(DISTINCT CASE WHEN phone_norm <> '' AND disabled = 0 THEN phone_norm END) AS customers, SUM(CASE WHEN phone_norm <> '' AND disabled = 0 THEN 1 ELSE 0 END) AS devices, SUM(CASE WHEN app = 'admin' AND disabled = 0 THEN 1 ELSE 0 END) AS adminDevices, SUM(disabled) AS disabledDevices FROM push_subscriptions");
    let b = {};
    try { b = await q("SELECT SUM(CASE WHEN ok = 1 AND ts >= CURDATE() THEN 1 ELSE 0 END) AS sentToday, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS sent7, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed7 FROM reminder_log WHERE channel = 'PUSH' AND ts >= NOW() - INTERVAL 7 DAY"); } catch (_) {}
    const n = (v) => Number(v) || 0;
    return { ok: true, customers: n(a.customers), devices: n(a.devices), adminDevices: n(a.adminDevices), disabledDevices: n(a.disabledDevices), sentToday: n(b.sentToday), sent7: n(b.sent7), failed7: n(b.failed7) };
  } catch (e) {
    if (missingTable(e)) return { ok: false, needSchema: true, message: SCHEMA_MSG };
    throw e;
  }
}

module.exports = {
  publicKeyInfo, subscribe, unsubscribe, sendToPhone, sendToAdmins, broadcast, hasDevice, stats, checkSubscription, cleanMessage,
  deliveryFor, KINDS, SCHEMA_MSG, PUSH_HOST,
  _internal: { encrypt, vapidJwt, makeVapid, getVapid, b64u, unb64u, sendOne, setTransport: (t) => { transport = t || httpsTransport; }, reset: () => { vapidCache = null; } },
};
