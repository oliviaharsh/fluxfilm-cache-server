/* Push notifications: VAPID + aes128gcm encryption, subscriptions, renewal reminders, admin, service worker, storefront. Run: npm test */
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---------------- fake database ----------------
const T = { settings: {}, pushSubs: [], subs: [], log: [], missing: new Set() };
let nextId = 1;
const phoneOf = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    p = p || [];
    sql = sql.replace(/\s+/g, ' ').trim();
    const need = (t) => { if (T.missing.has(t)) throw new Error("Table 'u.x." + t + "' doesn't exist"); };
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
    if (/^INSERT IGNORE INTO app_settings/.test(sql)) { if (T.settings[p[0]] == null) T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^SELECT 1 AS x FROM subscriptions WHERE phone_norm = \?/.test(sql)) return T.subs.some((s) => s.phone_norm === p[0]) ? [{ x: 1 }] : [];
    if (/^INSERT INTO push_subscriptions/.test(sql)) {
      need('push_subscriptions');
      const [phone, ph, endpoint, p256dh, auth, ua, app] = p;
      const ex = T.pushSubs.find((r) => r.endpoint === endpoint);
      if (ex) {
        Object.assign(ex, { p256dh, auth, user_agent: ua, fail_count: 0, disabled: 0 });
        if (app === 'store') Object.assign(ex, { phone, phone_norm: ph, app: ex.app === 'admin' ? 'admin' : 'store' }); else ex.app = 'admin';
      } else T.pushSubs.push({ id: nextId++, phone, phone_norm: ph, endpoint, p256dh, auth, user_agent: ua, app, created_at: nextId, fail_count: 0, disabled: 0 });
      return { affectedRows: 1 };
    }
    if (/^SELECT id FROM push_subscriptions WHERE phone_norm = \? AND app = 'store' ORDER BY/.test(sql)) return T.pushSubs.filter((r) => r.phone_norm === p[0] && r.app === 'store').sort((a, b) => b.id - a.id).map((r) => ({ id: r.id }));
    if (/^DELETE FROM push_subscriptions WHERE id = \?/.test(sql)) { T.pushSubs = T.pushSubs.filter((r) => r.id !== p[0]); return { affectedRows: 1 }; }
    if (/^UPDATE push_subscriptions SET last_ok_at = NOW\(\), fail_count = 0 WHERE id = \?/.test(sql)) { const r = T.pushSubs.find((x) => x.id === p[0]); if (r) { r.last_ok = true; r.fail_count = 0; } return {}; }
    if (/^UPDATE push_subscriptions SET fail_count = fail_count \+ 1, disabled = IF\(fail_count >= \?, 1, disabled\) WHERE id = \?/.test(sql)) { const r = T.pushSubs.find((x) => x.id === p[1]); if (r) { r.fail_count++; if (r.fail_count >= p[0]) r.disabled = 1; } return {}; }
    if (/^UPDATE push_subscriptions SET app = 'store' WHERE endpoint = \? AND phone_norm <> ''/.test(sql)) { T.pushSubs.filter((r) => r.endpoint === p[0] && r.phone_norm).forEach((r) => { r.app = 'store'; }); return {}; }
    if (/^DELETE FROM push_subscriptions WHERE endpoint = \? AND app = 'admin'/.test(sql)) { T.pushSubs = T.pushSubs.filter((r) => !(r.endpoint === p[0] && r.app === 'admin')); return {}; }
    if (/^UPDATE push_subscriptions SET phone = '', phone_norm = '' WHERE endpoint = \? AND app = 'admin'/.test(sql)) { T.pushSubs.filter((r) => r.endpoint === p[0] && r.app === 'admin').forEach((r) => { r.phone = ''; r.phone_norm = ''; }); return {}; }
    if (/^DELETE FROM push_subscriptions WHERE endpoint = \? AND app = 'store'/.test(sql)) { T.pushSubs = T.pushSubs.filter((r) => !(r.endpoint === p[0] && r.app === 'store')); return {}; }
    if (/^SELECT id, phone_norm, endpoint, p256dh, auth, app FROM push_subscriptions WHERE disabled = 0 AND /.test(sql)) {
      need('push_subscriptions');
      const live = T.pushSubs.filter((r) => !r.disabled);
      if (/AND phone_norm = \?/.test(sql)) return live.filter((r) => r.phone_norm === p[0]);
      if (/AND app = 'admin'/.test(sql)) return live.filter((r) => r.app === 'admin');
      if (/AND phone_norm <> ''/.test(sql)) return live.filter((r) => r.phone_norm);
    }
    if (/^SELECT COUNT\(DISTINCT CASE WHEN phone_norm/.test(sql)) {
      need('push_subscriptions');
      const live = T.pushSubs.filter((r) => !r.disabled);
      return [{ customers: new Set(live.filter((r) => r.phone_norm).map((r) => r.phone_norm)).size, devices: live.filter((r) => r.phone_norm).length, adminDevices: live.filter((r) => r.app === 'admin').length, disabledDevices: T.pushSubs.filter((r) => r.disabled).length }];
    }
    if (/^SELECT SUM\(CASE WHEN ok = 1 AND ts >= CURDATE\(\)/.test(sql)) return [{ sentToday: T.log.filter((l) => l.ok).length, sent7: T.log.filter((l) => l.ok).length, failed7: T.log.filter((l) => !l.ok).length }];
    if (/^SELECT s\.sub_id, s\.phone_norm, s\.service, s\.plan, s\.expiry_date, s\.status, EXISTS/.test(sql)) {
      need('push_subscriptions');
      const [from, to] = p;
      const subscribed = new Set(T.pushSubs.filter((r) => !r.disabled && r.phone_norm).map((r) => r.phone_norm));
      return T.subs.filter((s) => s.expiry_date >= from && s.expiry_date < to && ['ACTIVE', 'EXPIRED'].includes(String(s.status).toUpperCase()) && subscribed.has(s.phone_norm))
        .map((s) => Object.assign({}, s, { has_newer: T.subs.some((n) => n.phone_norm === s.phone_norm && n.service === s.service && n.sub_id !== s.sub_id && n.expiry_date > s.expiry_date && n.status === 'ACTIVE') ? 1 : 0 }));
    }
    if (/^SELECT 1 AS x FROM reminder_log WHERE sub_id = \? AND channel = 'PUSH' AND kind = \? AND expiry_date = \?/.test(sql)) { need('reminder_log'); return T.log.filter((l) => l.sub_id === p[0] && l.channel === 'PUSH' && l.kind === p[1] && l.expiry_date === p[2]).length ? [{ x: 1 }] : []; }
    if (/^INSERT INTO reminder_log/.test(sql)) { need('reminder_log'); T.log.push({ sub_id: p[0], channel: p[1], kind: p[2], expiry_date: p[3], ok: p[4], note: p[5] }); return {}; }
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const push = require('../push');
const reminders = require('../pushreminders');

// A real browser-like receiver: P-256 key pair + 16-byte auth secret.
function receiver() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}
// Independent RFC 8291 / RFC 8188 decryption (what the browser does).
function decrypt(body, rcv) {
  const salt = body.slice(0, 16); const rs = body.readUInt32BE(16); const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen); const ct = body.slice(21 + idlen);
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const uaPublic = rcv.ecdh.getPublicKey();
  const secret = rcv.ecdh.computeSecret(asPublic);
  const ikm = hm(hm(rcv.auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hm(salt, ikm);
  const cek = hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).slice(0, 16);
  const nonce = hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).slice(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.slice(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1; while (end >= 0 && plain[end] === 0) end--;
  return { rs, idlen, delimiter: plain[end], text: plain.slice(0, end).toString('utf8') };
}
const FCM = (n) => 'https://fcm.googleapis.com/fcm/send/device-' + n + '-' + 'x'.repeat(40);

(async () => {
  const I = push._internal;

  // ---------------- encryption ----------------
  const rcv = receiver();
  const text = JSON.stringify({ title: '⏰ Your Netflix plan ends in 3 days', body: 'Renew in 1 tap ₹' });
  const body = I.encrypt(text, rcv.keys.p256dh, rcv.keys.auth);
  const dec = decrypt(body, rcv);
  ok('aes128gcm round trip: the receiver\'s private key decrypts the exact message (emoji + ₹ too)', dec.text === text && dec.delimiter === 2, dec);
  ok('header: 4096 record size, 65-byte sender key id', dec.rs === 4096 && dec.idlen === 65 && body[21] === 4);
  const body2 = I.encrypt(text, rcv.keys.p256dh, rcv.keys.auth);
  ok('every message uses a fresh salt + sender key', !body.slice(0, 86).equals(body2.slice(0, 86)));
  let tampered = Buffer.from(body); tampered[tampered.length - 20] ^= 1; let threw = false;
  try { decrypt(tampered, rcv); } catch (_) { threw = true; }
  ok('tampered message fails authentication', threw);
  threw = false; try { decrypt(body, receiver()); } catch (_) { threw = true; }
  ok('another device cannot read it', threw);
  // RFC 8291 Appendix A test vector.
  const vec = I.encrypt('When I grow up, I want to be a watermelon', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', { asPrivate: unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw') });
  ok('matches the RFC 8291 test vector byte for byte', b64u(vec) === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', b64u(vec));

  // ---------------- VAPID ----------------
  const key = await push.publicKeyInfo();
  const stored = JSON.parse(T.settings.push_vapid);
  ok('VAPID key pair made on first use and stored in app_settings; public key is a 65-byte P-256 point', key.ok && stored.publicKey === key.publicKey && unb64u(key.publicKey).length === 65 && unb64u(key.publicKey)[0] === 4 && stored.privateJwk.d);
  I.reset();
  ok('same key after a restart (never regenerated)', (await push.publicKeyInfo()).publicKey === key.publicKey);
  ok('public key info never includes the private key', !JSON.stringify(await push.publicKeyInfo()).includes(stored.privateJwk.d));
  const now = Math.floor(Date.now() / 1000);
  const jwt = I.vapidJwt('https://fcm.googleapis.com', stored, now);
  const [h64, c64, s64] = jwt.split('.');
  const pub = unb64u(key.publicKey);
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)) }, format: 'jwk' });
  ok('JWT signature (ES256, raw r||s) verifies with the public key', crypto.verify('sha256', Buffer.from(h64 + '.' + c64), { key: pubKey, dsaEncoding: 'ieee-p1363' }, unb64u(s64)) && unb64u(s64).length === 64);
  const hdr = JSON.parse(unb64u(h64)); const cl = JSON.parse(unb64u(c64));
  ok('JWT header + claims: ES256, aud = push service origin, exp within 24 h, sub set', hdr.alg === 'ES256' && hdr.typ === 'JWT' && cl.aud === 'https://fcm.googleapis.com' && cl.exp > now && cl.exp <= now + 86400 && /^(https:|mailto:)/.test(cl.sub));
  ok('a changed JWT fails verification', !crypto.verify('sha256', Buffer.from(h64 + '.' + b64u(JSON.stringify(Object.assign(cl, { aud: 'https://evil.example' })))), { key: pubKey, dsaEncoding: 'ieee-p1363' }, unb64u(s64)));

  // ---------------- subscription checks ----------------
  const good = { endpoint: FCM(1), keys: rcv.keys };
  ok('accepts Chrome / Firefox / Edge / Safari push services', ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://web.push.apple.com/QK1abc'].every((e) => push.checkSubscription({ endpoint: e, keys: rcv.keys }).ok));
  ok('rejects http, unknown hosts, look-alikes, ports, internal addresses', ['http://fcm.googleapis.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'https://fcm.googleapis.com:8443/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'javascript:alert(1)'].every((e) => !push.checkSubscription({ endpoint: e, keys: rcv.keys }).ok));
  ok('rejects bad keys and very long endpoints', !push.checkSubscription({ endpoint: FCM(2), keys: { p256dh: 'abc', auth: rcv.keys.auth } }).ok && !push.checkSubscription({ endpoint: FCM(2), keys: { p256dh: rcv.keys.p256dh, auth: 'short' } }).ok && !push.checkSubscription({ endpoint: 'https://fcm.googleapis.com/' + 'a'.repeat(800), keys: rcv.keys }).ok && !push.checkSubscription(null).ok);

  // ---------------- subscribe / unsubscribe ----------------
  T.subs.push({ sub_id: 'S1', phone_norm: '9876543210', service: 'Netflix', plan: 'Premium', expiry_date: '2026-09-23 18:00:00', status: 'ACTIVE' });
  ok('store: must be a customer with a plan', !(await push.subscribe({ phone: '9000000000', subscription: good })).ok && !(await push.subscribe({ phone: '12', subscription: good })).ok);
  let r = await push.subscribe({ phone: '+91 98765 43210', subscription: good, userAgent: 'Chrome<script>' });
  ok('store: customer subscribes; phone normalised; user agent cleaned', r.ok && T.pushSubs.length === 1 && T.pushSubs[0].phone_norm === '9876543210' && T.pushSubs[0].app === 'store' && !/</.test(T.pushSubs[0].user_agent));
  await push.subscribe({ phone: '9876543210', subscription: good });
  ok('same device again = one row (endpoint is unique)', T.pushSubs.length === 1);
  const devices = [];
  for (let i = 0; i < 6; i++) { const d = receiver(); devices.push(d); await push.subscribe({ phone: '9876543210', subscription: { endpoint: FCM(10 + i), keys: d.keys } }); }
  ok('at most 5 devices per customer (oldest dropped)', T.pushSubs.filter((x) => x.phone_norm === '9876543210').length === 5 && !T.pushSubs.some((x) => x.endpoint === good.endpoint));
  const adminRcv = receiver(); const adminSub = { endpoint: FCM(99), keys: adminRcv.keys };
  await push.subscribe({ subscription: adminSub, app: 'admin' });
  T.subs.push({ sub_id: 'OWN', phone_norm: '9111111111', service: 'Prime', plan: 'x', expiry_date: '2030-01-01 00:00:00', status: 'ACTIVE' });
  await push.subscribe({ phone: '9111111111', subscription: adminSub });
  const adminRow = T.pushSubs.find((x) => x.endpoint === adminSub.endpoint);
  ok('the owner\'s browser can be admin AND customer (stays admin, phone attached)', adminRow.app === 'admin' && adminRow.phone_norm === '9111111111');
  await push.unsubscribe(adminSub.endpoint, 'store');
  ok('customer "turn off" on the admin browser only detaches the phone', T.pushSubs.some((x) => x.endpoint === adminSub.endpoint && x.app === 'admin' && !x.phone_norm));
  T.missing.add('push_subscriptions');
  r = await push.subscribe({ phone: '9876543210', subscription: { endpoint: FCM(50), keys: rcv.keys } });
  const st0 = await push.stats();
  ok('schema-v18 not run: friendly message, no crash (store + admin stats)', !r.ok && r.needSchema && /not available yet/.test(r.message) && st0.needSchema && /schema-v18/.test(st0.message));
  ok('schema-v18 not run: sending and reminders do nothing', (await push.sendToPhone('9876543210', { title: 'x' })).needSchema === true && (await reminders.run(new Date('2026-09-20T10:00:00+05:30'))).skipped === 'schema-v18 not run');
  T.missing.delete('push_subscriptions');

  // ---------------- sending ----------------
  const calls = [];
  let status = 201;
  I.setTransport(async (url, headers, bodyBuf) => { calls.push({ url, headers, body: bodyBuf }); return { status: typeof status === 'function' ? status(url) : status }; });
  r = await push.sendToPhone('9876543210', { title: 'Hello <b>', body: 'x', url: 'javascript:alert(1)' });
  const c0 = calls[0];
  const d0 = devices.find((d) => c0 && d.keys.p256dh === T.pushSubs.find((x) => x.endpoint === c0.url).p256dh);
  const msg0 = JSON.parse(decrypt(c0.body, d0).text);
  ok('sends to every device of the customer', r.ok && r.sent === 5 && r.devices === 5 && calls.length === 5);
  ok('push headers: vapid t=…, k=…, aes128gcm, TTL, Urgency', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/.test(c0.headers.Authorization) && c0.headers['Content-Encoding'] === 'aes128gcm' && Number(c0.headers.TTL) > 0 && c0.headers.Urgency === 'normal');
  ok('device decrypts the notification; bad links become the home page', msg0.title === 'Hello <b>' && msg0.url === '/' && msg0.icon === '/icons/icon-192.png');
  calls.length = 0;
  status = (url) => (url === FCM(12) ? 410 : url === FCM(13) ? 404 : url === FCM(14) ? 500 : 201);
  r = await push.sendToPhone('9876543210', { title: 'x' });
  ok('404 / 410 from the push service removes the device; 500 counts a failure', r.removed === 2 && r.failed === 1 && r.sent === 2 && !T.pushSubs.some((x) => x.endpoint === FCM(12) || x.endpoint === FCM(13)) && T.pushSubs.find((x) => x.endpoint === FCM(14)).fail_count === 1);
  status = (url) => (url === FCM(14) ? 500 : 201);
  for (let i = 0; i < 10; i++) await push.sendToPhone('9876543210', { title: 'x' });
  ok('a device failing 10 times in a row is switched off; working devices stay on', T.pushSubs.find((x) => x.endpoint === FCM(14)).disabled === 1 && T.pushSubs.filter((x) => x.phone_norm === '9876543210' && !x.disabled).length === 2);
  status = 201;

  // ---------------- renewal reminders ----------------
  T.log.length = 0; calls.length = 0;
  const at = (s) => new Date(s + '+05:30');
  T.subs.length = 0;
  T.subs.push(
    { sub_id: 'D3', phone_norm: '9876543210', service: 'Netflix', plan: 'Premium', expiry_date: '2026-09-23 18:00:00', status: 'ACTIVE' },
    { sub_id: 'D2', phone_norm: '9876543210', service: 'Zee5', plan: 'Yearly', expiry_date: '2026-09-22 10:00:00', status: 'ACTIVE' },
    { sub_id: 'D1', phone_norm: '9876543210', service: 'Prime Video', plan: '2 devices', expiry_date: '2026-09-21 09:00:00', status: 'ACTIVE' },
    { sub_id: 'D0', phone_norm: '9876543210', service: 'JioHotstar', plan: 'Super', expiry_date: '2026-09-20 23:00:00', status: 'ACTIVE' },
    { sub_id: 'A1', phone_norm: '9876543210', service: 'SonyLIV', plan: 'Premium', expiry_date: '2026-09-19 08:00:00', status: 'EXPIRED' },
    { sub_id: 'OLD', phone_norm: '9876543210', service: 'Crunchyroll', plan: 'x', expiry_date: '2026-09-21 12:00:00', status: 'ACTIVE' },
    { sub_id: 'NEW', phone_norm: '9876543210', service: 'Crunchyroll', plan: 'x', expiry_date: '2026-10-21 12:00:00', status: 'ACTIVE' },
    { sub_id: 'EXP3', phone_norm: '9876543210', service: 'Spotify', plan: 'x', expiry_date: '2026-09-23 12:00:00', status: 'EXPIRED' },
    { sub_id: 'NOPUSH', phone_norm: '9222222222', service: 'Netflix', plan: 'x', expiry_date: '2026-09-23 12:00:00', status: 'ACTIVE' },
  );
  const phoneDevices = () => T.pushSubs.filter((x) => x.phone_norm === '9876543210' && !x.disabled).length;
  let out = await reminders.run(at('2026-09-20T10:00:00'));
  const kinds = T.log.map((l) => l.sub_id + ':' + l.kind).sort().join(' ');
  ok('sends 3 and 1 days before, on the expiry day and the day after (default settings)', kinds === 'A1:AFTER_1 D0:EXPIRY_DAY D1:BEFORE_1 D3:BEFORE_3', kinds);
  ok('not for 2 days left, not for a plan already renewed with a newer one, not for customers without reminders', !T.log.some((l) => ['D2', 'OLD', 'NOPUSH'].includes(l.sub_id)) && out.renewed === 1);
  ok('"before" reminders only for ACTIVE plans', !T.log.some((l) => l.sub_id === 'EXP3'));
  ok('every send logged in reminder_log with channel PUSH + expiry date', T.log.every((l) => l.channel === 'PUSH' && l.ok === 1 && l.expiry_date) && out.sent === 4 && calls.length === 4 * phoneDevices());
  const byTag = {};
  for (const c of calls) { const row = T.pushSubs.find((x) => x.endpoint === c.url); const dv = devices.find((d) => d.keys.p256dh === row.p256dh); const m = JSON.parse(decrypt(c.body, dv).text); byTag[m.tag] = m; }
  ok('message: "⏰ Your Netflix plan ends in 3 days", tap opens the renewal for that plan', byTag['renew-D3'].title === '⏰ Your Netflix plan ends in 3 days' && byTag['renew-D3'].url === '/?source=push&renew=D3' && /23 Sep/.test(byTag['renew-D3'].body));
  ok('1 day / expiry day / day after wording', byTag['renew-D1'].title === '⏰ Your Prime Video plan ends in 1 day' && /ends today/.test(byTag['renew-D0'].title) && /ended yesterday/.test(byTag['renew-A1'].title) && /keep your profile/.test(byTag['renew-A1'].body));
  calls.length = 0;
  out = await reminders.run(at('2026-09-20T15:00:00'));
  ok('DEDUPE: the next hourly run sends nothing again', out.sent === 0 && out.alreadySent === 4 && calls.length === 0 && T.log.length === 4, out);
  T.log.length = 0;
  out = await reminders.run(at('2026-09-20T15:00:00'));
  ok('(dedupe really comes from reminder_log)', out.sent === 4);
  // Renewed: expiry moved → a new expiry date is a new reminder cycle, the old one is not repeated.
  T.subs.find((s) => s.sub_id === 'D3').expiry_date = '2026-10-23 18:00:00'; calls.length = 0;
  out = await reminders.run(at('2026-09-20T16:00:00'));
  ok('renewed plan (expiry moved) gets no reminder', calls.length === 0 && out.sent === 0);
  T.subs.find((s) => s.sub_id === 'D3').expiry_date = '2026-09-23 18:00:00';
  // Quiet hours.
  T.log.length = 0; calls.length = 0;
  for (const tm of ['2026-09-20T08:59:00', '2026-09-20T21:00:00', '2026-09-20T23:30:00', '2026-09-20T03:00:00']) {
    out = await reminders.run(at(tm));
    ok('QUIET HOURS: nothing sent at ' + tm.slice(11, 16) + ' IST', out.skipped === 'quiet hours' && calls.length === 0 && T.log.length === 0, out);
  }
  out = await reminders.run(at('2026-09-20T09:00:00'));
  ok('QUIET HOURS: sends from 09:00 IST', !out.skipped && out.sent === 4);
  T.log.length = 0;
  out = await reminders.run(new Date('2026-09-20T15:20:00Z')); // 20:50 IST, the server clock in UTC
  ok('quiet hours use India time whatever the server time zone (20:50 IST sends)', !out.skipped && out.sent === 4);
  T.log.length = 0;
  await reminders.saveSettings({ auto: false });
  ok('owner switch off → no automatic reminders', (await reminders.run(at('2026-09-20T10:00:00'))).skipped === 'off' && T.log.length === 0);
  await reminders.saveSettings({ auto: true, daysBefore: '2', onExpiryDay: false, afterExpiry: false, quietStart: 8, quietEnd: 22 });
  out = await reminders.run(at('2026-09-20T21:30:00'));
  ok('custom days (2 before) and hours (08–22) are used', T.log.map((l) => l.sub_id).join() === 'D2' && out.sent === 1);
  await reminders.saveSettings({ daysBefore: [3, 1], onExpiryDay: true, afterExpiry: true, quietStart: 9, quietEnd: 21 });
  T.missing.add('reminder_log'); T.log.length = 0;
  out = await reminders.run(at('2026-09-20T10:00:00'));
  ok('reminder_log missing: stops safely instead of sending without dedupe', out.sent === 0 && /schema-v14/.test(out.skipped));
  T.missing.delete('reminder_log');

  // ---------------- settings ----------------
  let v = reminders.validate({ daysBefore: '3, 1, 99, x, 3, 7', quietStart: 21, quietEnd: 9, templates: { beforeTitle: '<b>Hi</b> {service}', beforeBody: '' } });
  ok('settings: days cleaned (1–30, unique, sorted), hours must be start < end, < > stripped, empty title falls back', !v.ok && v.settings.daysBefore.join() === '7,3,1' && /Sending hours/.test(v.errors.join()) && v.settings.templates.beforeTitle === 'bHi/b {service}');
  v = reminders.validate({ templates: { beforeTitle: '' } });
  ok('empty title → default title', v.ok && v.settings.templates.beforeTitle === reminders.DEFAULTS.templates.beforeTitle);
  ok('placeholders {service} {plan} {days} {date}', reminders.render('{service} {plan} in {days} on {date} {nope}', { service: 'Netflix', plan: '4K', days: 3, date: '2026-09-30 10:00:00' }) === 'Netflix 4K in 3 days on 30 Sep {nope}');

  // ---------------- "access is ready" ----------------
  calls.length = 0;
  await reminders.notifyDelivered({ phone: '9876543210', service: 'Netflix', plan: 'Premium', orderId: 'FF1', manual: true });
  ok('manual (not yet delivered) plans: no "access ready" push', calls.length === 0);
  r = await reminders.notifyDelivered({ phone: '9876543210', service: 'Netflix', plan: 'Premium', orderId: 'FF1' });
  const dc = calls[0]; const drow = T.pushSubs.find((x) => x.endpoint === dc.url);
  const dmsg = JSON.parse(decrypt(dc.body, devices.find((d) => d.keys.p256dh === drow.p256dh)).text);
  ok('delivered: "🎬 Your Netflix access is ready", high urgency', dmsg.title === '🎬 Your Netflix access is ready' && dc.headers.Urgency === 'high' && r.sent > 0);
  I.setTransport(async () => { throw new Error('network down'); });
  r = await reminders.notifyDelivered({ phone: '9876543210', service: 'Netflix' });
  ok('delivered push never throws (network down)', r && typeof r === 'object');
  I.setTransport(async (url, headers, b) => { calls.push({ url, headers, body: b }); return { status: 201 }; });
  const fulfillSrc = fs.readFileSync(path.join(__dirname, '..', 'fulfill.js'), 'utf8');
  ok('fulfill.js: afterFulfillHook fires the push without waiting, skips manual plans', /if \(!p\.manual\) \{\s*try \{ require\('\.\/pushreminders'\)\.notifyDelivered\(p\)\.catch\(\(\) => \{\}\); \}/.test(fulfillSrc) && fulfillSrc.indexOf("notifyDelivered(p)") > fulfillSrc.indexOf('function afterFulfillHook'));

  // ---------------- admin API ----------------
  const routes = {}; const audits = []; let authed = false;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  require('../adminpush').mount(app, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (q, a) => audits.push(a) }, push, reminders });
  const call = (m, p, bodyIn) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; routes[m + ' ' + p]({ body: bodyIn, headers: { 'user-agent': 'test' } }, res); });
  ok('admin sign-in required on every push route', (await Promise.all(['GET /admin/api/push', 'POST /admin/api/push/settings', 'POST /admin/api/push/subscribe', 'POST /admin/api/push/unsubscribe', 'POST /admin/api/push/test', 'POST /admin/api/push/send', 'POST /admin/api/push/broadcast'].map((k) => call(k.split(' ')[0], k.split(' ')[1], {})))).every((x) => x.code === 403));
  authed = true;
  let x = await call('GET', '/admin/api/push');
  ok('admin overview: settings, stats, public key', x.body.ok && x.body.settings.daysBefore.join() === '3,1' && x.body.stats.customers === 1 && x.body.publicKey === key.publicKey);
  x = await call('POST', '/admin/api/push/settings', { quietStart: 22, quietEnd: 8 });
  ok('bad settings refused', x.code === 400);
  x = await call('POST', '/admin/api/push/settings', { daysBefore: '5,2', templates: { beforeTitle: '🔔 {service} ends in {days}' } });
  ok('settings saved + change log', x.body.ok && x.body.settings.daysBefore.join() === '5,2' && audits.some((a) => a.action === 'push.settings'));
  await call('POST', '/admin/api/push/settings', { daysBefore: '3,1', templates: reminders.DEFAULTS.templates });
  calls.length = 0;
  x = await call('POST', '/admin/api/push/test', {});
  ok('send test to me → admin devices only + change log', x.body.ok && x.body.sent === 1 && calls.length === 1 && calls[0].url === adminSub.endpoint && audits.some((a) => a.action === 'push.test'));
  ok('admin notification opens the panel with the admin icon', (() => { const m = JSON.parse(decrypt(calls[0].body, adminRcv).text); return m.url === '/panel' && m.icon === '/icons/admin-icon-192.png'; })());
  x = await call('POST', '/admin/api/push/send', { phone: '98765 43210', title: '🎁 Gift', body: 'hi', url: 'http://evil' });
  ok('send to one: link must be / or https', x.code === 400);
  calls.length = 0;
  x = await call('POST', '/admin/api/push/send', { phone: '98765 43210', title: '🎁 Gift', body: 'hi', url: '/' });
  ok('send to one customer + change log', x.body.ok && x.body.sent === phoneDevices() && audits.some((a) => a.action === 'push.send' && a.id === '9876543210'));
  x = await call('POST', '/admin/api/push/broadcast', { title: 'Sale', body: 'Till 30 Sep' });
  ok('broadcast needs confirm', x.code === 400 && /confirm/i.test(x.body.message));
  calls.length = 0;
  x = await call('POST', '/admin/api/push/broadcast', { title: '🎉 Anniversary', body: 'Till 30 Sep', url: '/', confirm: true });
  ok('broadcast to all customers with reminders on (not admin-only devices) + change log', x.body.ok && x.body.phones === 1 && calls.length === phoneDevices() && !calls.some((c) => c.url === adminSub.endpoint) && audits.some((a) => a.action === 'push.broadcast'));
  x = await call('POST', '/admin/api/push/broadcast', { title: 'again', body: 'x', confirm: true });
  ok('broadcast rate-limited (one every 2 minutes)', x.code === 429);
  x = await call('POST', '/admin/api/push/subscribe', { subscription: { endpoint: 'https://evil.com/x', keys: rcv.keys } });
  ok('admin subscribe validates the endpoint too', x.code === 400);

  // ---------------- urgency per kind (Android Doze: "normal" waits until the phone wakes) ----------------
  const D = push.deliveryFor;
  ok('urgency per kind: reminder / delivered / refund / admin / direct high 24 h; test high 10 min; broadcast normal', D({ kind: 'reminder' }).urgency === 'high' && D({ kind: 'reminder' }).ttl === 86400 && D({ kind: 'delivered' }).urgency === 'high' && D({ kind: 'refund' }).urgency === 'high' && D({ kind: 'admin' }).urgency === 'high' && D({ kind: 'direct' }).urgency === 'high' && D({ kind: 'test' }).urgency === 'high' && D({ kind: 'test' }).ttl === 600 && D({ kind: 'broadcast' }).urgency === 'normal' && D({}).urgency === 'normal');
  ok('explicit urgency / ttl win; junk urgency ignored', D({ kind: 'broadcast', urgency: 'high' }).urgency === 'high' && D({ kind: 'reminder', urgency: 'bogus' }).urgency === 'high' && D({ kind: 'test', ttl: 30 }).ttl === 30);
  const urgHdr = async (fn) => { calls.length = 0; await fn(); return calls.map((c) => c.headers); };
  let urgHs = await urgHdr(() => push.sendToPhone('9876543210', { title: 'x' }, { kind: 'reminder' }));
  ok('reminder push headers: Urgency high, TTL 24 h', urgHs.length > 0 && urgHs.every((h) => h.Urgency === 'high' && h.TTL === '86400'));
  urgHs = await urgHdr(() => push.sendToAdmins({ title: 'New order' }));
  ok('admin alerts (new order / UPI refund) are high by default', urgHs.length === 1 && urgHs[0].Urgency === 'high');
  urgHs = await urgHdr(() => push.broadcast({ title: 'Sale' }));
  ok('broadcast is normal by default', urgHs.length > 0 && urgHs.every((h) => h.Urgency === 'normal'));
  urgHs = await urgHdr(() => call('POST', '/admin/api/push/test', {}));
  ok('admin test notification: high, TTL 10 min', urgHs.length === 1 && urgHs[0].Urgency === 'high' && urgHs[0].TTL === '600');
  urgHs = await urgHdr(() => call('POST', '/admin/api/push/send', { phone: '98765 43210', title: 'Your login changed', body: 'hi', url: '/' }));
  ok('owner → one customer: high', urgHs.length > 0 && urgHs.every((h) => h.Urgency === 'high'));
  const routes2 = {};
  require('../adminpush').mount({ get: (p, f) => { routes2['GET ' + p] = f; }, post: (p, f) => { routes2['POST ' + p] = f; } }, { auth: () => true, audit: { record: (q, a) => audits.push(a) }, push, reminders, broadcastGapMs: 0 });
  const call2 = (p, bodyIn) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(v2) { resolve({ code: this.code, body: v2 }); } }; routes2['POST ' + p]({ body: bodyIn, headers: {} }, res); });
  urgHs = await urgHdr(() => call2('/admin/api/push/broadcast', { title: 'Promo', body: 'x', confirm: true }));
  ok('admin broadcast: normal unless picked', urgHs.length > 0 && urgHs.every((h) => h.Urgency === 'normal'));
  urgHs = await urgHdr(() => call2('/admin/api/push/broadcast', { title: 'Service down', body: 'x', urgency: 'high', confirm: true }));
  ok('admin broadcast with urgency high → high + logged', urgHs.length > 0 && urgHs.every((h) => h.Urgency === 'high') && audits.some((a) => a.action === 'push.broadcast' && /high urgency/.test(a.summary)));
  urgHs = await urgHdr(() => call2('/admin/api/push/broadcast', { title: 'Odd', body: 'x', urgency: 'very-low', confirm: true }));
  ok('admin broadcast: anything but "high" is normal', urgHs.length > 0 && urgHs.every((h) => h.Urgency === 'normal'));
  const refundsSrc = fs.readFileSync(path.join(__dirname, '..', 'refunds.js'), 'utf8');
  const remindSrc = fs.readFileSync(path.join(__dirname, '..', 'pushreminders.js'), 'utf8');
  ok('callers name their kind: refund notices, UPI-refund admin alert, reminders, delivered', /sendToPhone\(o\.phone_norm, \{ title, body, url: '\/\?source=push', tag \}, \{ kind: 'refund' \}\)/.test(refundsSrc) && /tag: 'upi-refund-' \+ oid \}, \{ kind: 'admin' \}\)/.test(refundsSrc) && /messageFor\(kind, sub, settings\), \{ kind: 'reminder' \}\)/.test(remindSrc) && /\{ kind: 'delivered' \}\)/.test(remindSrc) && !/urgency: 'normal'/.test(refundsSrc));
  const tsRow = T.pushSubs.find((q) => q.endpoint === calls[0].url);
  const msgTs = JSON.parse(decrypt(calls[0].body, devices.find((d) => d.keys.p256dh === tsRow.p256dh)).text).ts;
  ok('payload carries the send time (ts) for the notification timestamp', typeof msgTs === 'number' && Math.abs(msgTs - Date.now()) < 60e3);
  const adminHtmlPn = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('🔔 Notifications page: Android battery note + broadcast urgency picker (default normal)', adminHtmlPn.includes('On Android phones with battery saver (OnePlus/Xiaomi/Realme), set Chrome → Battery → Unrestricted so notifications arrive when the screen is off.') && /id="pnburg"><option value="normal" selected>/.test(adminHtmlPn) && /urgency: \$\('#pnburg'\)\.value === 'high' \? 'high' : 'normal'/.test(adminHtmlPn));

  // ---------------- service worker ----------------
  const pwa = require('../pwa');
  const handlers = {}; const shown = []; const opened = []; const navigated = [];
  let clientList = [];
  const self = {
    addEventListener: (k, f) => { handlers[k] = f; }, location: { origin: 'https://shop.fluxfilm.in' }, skipWaiting: () => {},
    registration: { showNotification: async (t, o) => { shown.push({ t, o }); } },
    clients: { claim: async () => {}, matchAll: async () => clientList, openWindow: async (u) => { opened.push(u); } },
  };
  new Function('self', 'caches', 'fetch', 'Response', 'URL', pwa.serviceWorker())(self, {}, async () => ({}), function () {}, URL);
  const wait = async (fn) => { let p; fn({ waitUntil: (x) => { p = x; } }); await p; };
  await wait((ext) => handlers.push(Object.assign(ext, { data: { json: () => ({ title: '⏰ Netflix ends in 3 days', body: 'Renew', url: '/?source=push&renew=D3', tag: 'renew-D3', icon: 'https://evil/x.png' }) } })));
  ok('service worker shows the notification (title, body, tag, our icon only)', shown[0].t === '⏰ Netflix ends in 3 days' && shown[0].o.body === 'Renew' && shown[0].o.tag === 'renew-D3' && shown[0].o.icon === '/icons/icon-192.png' && shown[0].o.data.url === '/?source=push&renew=D3');
  await wait((ext) => handlers.push(Object.assign(ext, { data: { json: () => { throw new Error('not json'); }, text: () => 'plain text' } })));
  ok('non-JSON push still shows something', shown[1].t === 'FluxFilm' && shown[1].o.body === 'plain text');
  ok('notification options: requireInteraction false, renotify with tag, timestamp', shown[0].o.requireInteraction === false && shown[0].o.renotify === true && typeof shown[0].o.timestamp === 'number' && shown[0].o.timestamp > 0 && shown[1].o.renotify === undefined);
  await wait((ext) => handlers.push(Object.assign(ext, { data: { json: () => ({ title: 'Slept', ts: 1757900000000, tag: 'renew-X' }) } })));
  ok('timestamp = the send time from the payload (not when the sleeping phone woke up)', shown[2].o.timestamp === 1757900000000);
  // showNotification must be inside event.waitUntil, or Android stops the worker before it shows.
  let waited = null; const before = shown.length;
  handlers.push({ waitUntil: (p2) => { waited = p2; }, data: { json: () => ({ title: 'W' }) } });
  ok('push handler passes the showNotification promise to event.waitUntil', !!waited && typeof waited.then === 'function' && shown.length === before + 1 && /e\.waitUntil\(self\.registration\.showNotification\(/.test(pwa.serviceWorker()));
  await waited;
  let closed = false;
  await wait((ext) => handlers.notificationclick(Object.assign(ext, { notification: { close: () => { closed = true; }, data: { url: '/?source=push&renew=D3' } } })));
  ok('tap with the app closed opens /?source=push&renew=<sub>', closed && opened[0] === 'https://shop.fluxfilm.in/?source=push&renew=D3');
  clientList = [{ url: 'https://shop.fluxfilm.in/', navigate: async (u) => { navigated.push(u); return null; }, focus: async () => {} }];
  await wait((ext) => handlers.notificationclick(Object.assign(ext, { notification: { close: () => {}, data: { url: '/?source=push&renew=D1' } } })));
  ok('tap with the app open reuses that window', navigated[0] === 'https://shop.fluxfilm.in/?source=push&renew=D1' && opened.length === 1);
  ok('service worker keeps its fetch / install / activate handlers', ['fetch', 'install', 'activate', 'push', 'notificationclick'].every((k) => typeof handlers[k] === 'function'));

  // ---------------- storefront ----------------
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('// ── Push notifications: renewal reminders'); const end = html.indexOf('function PushPrompt(');
  const ls = {}; const ss = {};
  const lsFake = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, val) => { ls[k] = String(val); }, removeItem: (k) => { delete ls[k]; } };
  const ssFake = { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, val) => { ss[k] = String(val); } };
  const helpers = new Function('localStorage', 'sessionStorage', 'window', 'navigator', 'atob', 'isIos_', 'isStandalone_', 'normPhone_', 'API', html.slice(start, end) + '; return { pushEligible_, pushRenewTarget_, pushSnooze_, pushSnoozedUntil_, pushB64ToBytes_, pushState_, pushAskedThisVisit_, pushMarkAsked_ };')(lsFake, ssFake, {}, {}, (s) => Buffer.from(s, 'base64').toString('latin1'), () => true, () => false, (p) => String(p).replace(/\D/g, '').slice(-10), {});
  const manage = { actionable: [{ subId: 'D3', daysLeft: 3 }], history: [{ subId: 'A1', daysLeft: -1 }, { subId: 'OLD9', daysLeft: -90, showRenewButton: false }] };
  ok('tapped reminder → renew that plan only if it is in the logged-in phone\'s plans', helpers.pushRenewTarget_('?source=push&renew=D3', manage).subId === 'D3' && helpers.pushRenewTarget_('?source=push&renew=A1', manage).subId === 'A1' && helpers.pushRenewTarget_('?source=push&renew=SOMEONE_ELSE', manage) === null && helpers.pushRenewTarget_('?renew=D3', manage) === null && helpers.pushRenewTarget_('?source=push&renew=OLD9', manage) === null);
  ok('offered to customers with a running plan or one ended in the last 15 days', helpers.pushEligible_([{ daysLeft: 20 }]) && helpers.pushEligible_([{ daysLeft: -15 }]) && !helpers.pushEligible_([{ daysLeft: -16 }]) && !helpers.pushEligible_([]));
  helpers.pushSnooze_();
  ok('"Not now" snoozes 7 days (localStorage)', Math.abs(helpers.pushSnoozedUntil_() - (Date.now() + 7 * 86400000)) < 5000);
  helpers.pushMarkAsked_();
  ok('once per visit (sessionStorage)', helpers.pushAskedThisVisit_() === true);
  ok('storage blocked (private mode) never breaks the page', new Function('localStorage', 'sessionStorage', 'window', 'navigator', 'atob', 'isIos_', 'isStandalone_', 'normPhone_', 'API', html.slice(start, end) + '; return pushSnoozedUntil_() === 0 && pushAskedThisVisit_() === false;')({ getItem: () => { throw new Error('blocked'); } }, { getItem: () => { throw new Error('blocked'); } }, {}, {}, null, () => false, () => false, null, {}));
  ok('VAPID key decoded for the browser (65 bytes)', helpers.pushB64ToBytes_(key.publicKey).length === 65);
  ok('iPhone in Safari (not added to Home Screen) → install steps instead of asking', (await helpers.pushState_()) === 'ios-install');
  const promptSrc = html.slice(end, html.indexOf('// ── Offers: announcement bar'));
  ok('permission asked only from the "Yes, remind me" tap (never automatically)', (html.match(/Notification\.requestPermission/g) || []).length === 1 && html.slice(start, end).includes('Notification.requestPermission') && (html.match(/pushEnable_\(/g) || []).length === 2 && /const turnOn = \(\) => \{[\s\S]*?pushEnable_\(phone\)/.test(promptSrc) && /onClick: turnOn/.test(promptSrc));
  ok('pop-up after a successful purchase / renewal: once per visit, waits for offer pop-ups, "Not now" = snooze', /if \(screen !== 'done' \|\| !success \|\| !phone\) return;/.test(promptSrc) && /pushAskedThisVisit_\(\) \|\| pushSnoozedUntil_\(\) > Date\.now\(\)/.test(promptSrc) && /if \(window\.ffPromoOpen \|\| window\.ffPushOpen \|\| window\.ffRenewPopOpen\) return;/.test(promptSrc) && /if \(!manual\) pushSnooze_\(\);/.test(promptSrc));
  ok('iPhone explanation mentions Home Screen + iOS 16.4', /iOS 16\.4 or newer/.test(promptSrc) && /Add to Home Screen/.test(promptSrc));
  ok('install pop-up waits while the reminders pop-up is open', /if \(window\.ffPushOpen\) return;/.test(html));
  ok('rendered at the app root with the success flag from the done screen', /React\.createElement\(PushPrompt, \{\s*screen: screen,\s*phone: sessionPhone,\s*success: !!\(d\.verifyResult && d\.verifyResult\.found && d\.verifyResult\.fulfillment !== 'NO_STOCK'\)\s*\}\)/.test(html));
  ok('Account → Notifications row (on/off), only for eligible customers', /concat\(pushEligible_\(allSubs\) \? \[\{\s*k: 'push',\s*icon: '🔔',[\s\S]*?title: 'Notifications'/.test(html) && /r\.k === 'push' \? window\.dispatchEvent\(new Event\('ff-push-open'\)\)/.test(html) && /mode === 'on' && h\("div"[\s\S]*?Turn off reminders/.test(promptSrc));
  ok('opened from a reminder: after login restore go to renewStart for that sub; logged out → home, URL cleaned', /const pushSub = pushRenewTarget_\(window\.location\.search, manageResp\);\s*pushClearUrl_\(\);\s*if \(pushSub\) \{\s*trackFlow\('renewStart'\);/.test(html) && /setScreen\('renewStart'\);/.test(html) && /if \(saved\.phone\) setRestoring\(true\);else pushClearUrl_\(\);/.test(html));
  ok('storefront API: getPushKey, pushSubscribe, pushUnsubscribe', /apiCall_\('getPushKey', \[\]/.test(html) && /apiCall_\('pushSubscribe', \[phone, subscription\]/.test(html) && /apiCall_\('pushUnsubscribe', \[endpoint\]/.test(html));

  // ---------------- server + admin page wiring ----------------
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server: public push actions are MySQL storefront actions and rate-limited (per IP + per phone)', /'getPushKey', 'pushSubscribe', 'pushUnsubscribe'\]\);/.test(srv) && /getPushKey: security\.rateLimiter/.test(srv) && /pushSubscribe: security\.rateLimiter\(20, TEN_MIN\)/.test(srv) && /pushUnsubscribe: security\.rateLimiter/.test(srv) && /PHONE_LIMITS = \{[\s\S]*?pushSubscribe: security\.rateLimiter\(10, 60 \* 60e3\)/.test(srv));
  ok('server: customers can only subscribe as store devices; reminders timer started', /pushMod\.subscribe\(\{ phone: a\[0\], subscription: a\[1\], userAgent: [^}]*app: 'store' \}\)/.test(srv) && /require\('\.\/pushreminders'\)\.startTimer\(\)/.test(srv) && /DB_STOREFRONT\[action\]\(a, req\)/.test(srv));
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok('admin.js mounts adminpush', /require\('\.\/adminpush'\)\.mount\(app, Object\.assign\(\{ db, auth, audit \}, deps\.push \|\| \{\}\)\)/.test(adminJs));
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin page: menu, view, settings / test / send / broadcast with confirm', /\['push', '🔔', 'Notifications'\]/.test(adminHtml) && /push: pushView/.test(adminHtml) && /\/admin\/api\/push\/settings/.test(adminHtml) && /\/admin\/api\/push\/test/.test(adminHtml) && /\/admin\/api\/push\/send/.test(adminHtml) && /if \(!confirm\('Send this notification to ALL/.test(adminHtml) && /\/admin\/api\/push\/subscribe/.test(adminHtml));
  const timer = fs.readFileSync(path.join(__dirname, '..', 'pushreminders.js'), 'utf8');
  ok('reminders timer: 60 s after start + hourly, unref\'d', /setTimeout\(tick, 60e3\)/.test(timer) && /setInterval\(tick, 60 \* 60e3\)/.test(timer) && /first\.unref/.test(timer) && /timer\.unref/.test(timer));
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v18.sql'), 'utf8');
  ok('schema-v18: push_subscriptions with unique endpoint and all columns', /CREATE TABLE IF NOT EXISTS push_subscriptions/.test(schema) && /UNIQUE KEY uq_push_endpoint \(endpoint\)/.test(schema) && ['phone', 'phone_norm', 'endpoint', 'p256dh', 'auth', 'user_agent', 'app', 'created_at', 'last_ok_at', 'fail_count', 'disabled'].every((c) => new RegExp('^\\s+' + c + '\\s', 'm').test(schema)));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  ok('no new npm dependencies', Object.keys(pkg.dependencies).sort().join() === 'cors,dotenv,express,imapflow,mailparser,mysql2,nodemailer');

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
