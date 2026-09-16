/**
 * FluxFilm - 🪣 Cloudflare R2 object storage for 🎬 Reel videos (feedvideo.js).
 *
 * WHY: until now a Reel video lived in MySQL (1 MB chunks, db/schema-v25.sql). Hostinger gives the shop a 3 GB
 * database and advises not to keep video in SQL. R2's free tier is 10 GB of storage, 1M class-A operations,
 * 10M class-B operations and ZERO egress, so the bytes move out of the database and the videos get faster.
 *
 * NO NEW npm PACKAGE: R2 speaks the S3 API, so the AWS "Signature Version 4" signature is worked out here with
 * node's own `crypto` (sigv4() below is checked in the tests against AWS's published get-vanilla test vector).
 *
 * Settings live in app_settings 'r2_settings' (admin → 🍿 What's new → ⚙️ Settings → 🪣 Video storage):
 *   on · accountId · bucket · accessKeyId · secretAccessKey · publicBase (optional r2.dev / custom domain)
 * The two keys NEVER leave the server: publicConfig() only says "set" / "not set", they are never logged, never
 * put in an error message, and the change log only records that they changed.
 *
 * Operations used (all signed with SigV4, payload hashed):
 *   PUT    /<bucket>/<key>                       one-shot upload (files up to ~8 MB)          class A
 *   POST   /<bucket>/<key>?uploads               start a multipart upload (bigger files)      class A
 *   PUT    /<bucket>/<key>?partNumber=&uploadId= one 8 MB part                                class A
 *   POST   /<bucket>/<key>?uploadId=             finish the multipart upload                  class A
 *   DELETE /<bucket>/<key>?uploadId=             give up on a broken multipart upload         free
 *   GET    /<bucket>/<key>  (+ Range)            playback when there is no public URL         class B
 *   HEAD   /<bucket>/<key>                       check the size after an upload / a move      class B
 *   DELETE /<bucket>/<key>                       delete                                       free
 * countOp() keeps a monthly tally in app_settings 'r2_ops' so admin can show how far the shop is from the
 * free-tier limits (1M class A / 10M class B a month).
 */
const crypto = require('crypto');
const db = require('./db');

const KEY = 'r2_settings';
const OPS_KEY = 'r2_ops';
const REGION = 'auto';
const SERVICE = 's3';
const ALGO = 'AWS4-HMAC-SHA256';
const TEST_KEY = '_fluxfilm/connection-test.txt';
const FREE_CLASS_A = 1000000;
const FREE_CLASS_B = 10000000;
const TIMEOUT_MS = 60000;
const TRIES = 3;

const s = (v) => String(v == null ? '' : v).trim();
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

// ---------------------------------------------------------------- SigV4 (pure, no network)
const sha256Hex = (b) => crypto.createHash('sha256').update(b == null ? '' : b).digest('hex');
const hmac = (key, str) => crypto.createHmac('sha256', key).update(str, 'utf8').digest();
/** 2015-08-30T12:36:00Z → 20150830T123600Z */
const amzDate = (d) => new Date(d).toISOString().replace(/[:-]|\.\d{3}/g, '');
/** AWS keeps only A–Z a–z 0–9 - _ . ~ literal; everything else is %XX (upper case). */
function uriEncode(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9\-_.~]/g, (c) => {
    const b = Buffer.from(c, 'utf8');
    let out = '';
    for (const x of b) out += '%' + x.toString(16).toUpperCase().padStart(2, '0');
    return out;
  });
}
/** An object key → the canonical path: every segment encoded, the "/" between segments kept. */
const encodePath = (p) => '/' + String(p || '').replace(/^\/+/, '').split('/').map(uriEncode).join('/');

/**
 * The AWS Signature Version 4 of one request. Pure: it signs exactly the headers it is given
 * (the caller adds host / x-amz-date / x-amz-content-sha256), so AWS's own test vectors can be run through it.
 * → { authorization, signature, canonicalRequest, stringToSign, credentialScope, signedHeaders, amzDate }
 */
function sigv4(o) {
  const date = o.date || new Date();
  const stamp = o.amzDate || amzDate(date);
  const day = stamp.slice(0, 8);
  const region = o.region || REGION;
  const service = o.service || SERVICE;
  const headers = {};
  for (const [k, v] of Object.entries(o.headers || {})) headers[String(k).toLowerCase()] = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => n + ':' + headers[n] + '\n').join('');
  const signedHeaders = names.join(';');
  const q = o.query || {};
  const canonicalQuery = Object.keys(q).sort().map((k) => uriEncode(k) + '=' + uriEncode(q[k] === true ? '' : q[k])).join('&');
  const canonicalRequest = [o.method || 'GET', o.path || '/', canonicalQuery, canonicalHeaders, signedHeaders, o.payloadHash].join('\n');
  const credentialScope = day + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = [ALGO, stamp, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + o.secretAccessKey, day);
  const signature = hmac(hmac(hmac(hmac(kDate, region), service), 'aws4_request'), stringToSign).toString('hex');
  return {
    signature, canonicalRequest, stringToSign, credentialScope, signedHeaders, amzDate: stamp,
    authorization: ALGO + ' Credential=' + o.accessKeyId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  };
}

// ---------------------------------------------------------------- settings
const ACCOUNT_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const truthy = (v) => v === true || v === 1 || /^(true|1|on|yes)$/i.test(s(v));

function cleanBase(v) {
  const t = s(v).replace(/\/+$/, '');
  if (!t) return '';
  try {
    const u = new URL(t);
    if (u.protocol !== 'https:' || u.search || u.hash) return null;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (_) { return null; }
}
function cleanConfig(x) {
  const o = x || {};
  return {
    on: o.on === true,
    accountId: s(o.accountId), bucket: s(o.bucket).toLowerCase(),
    accessKeyId: s(o.accessKeyId), secretAccessKey: s(o.secretAccessKey),
    publicBase: s(o.publicBase).replace(/\/+$/, ''),
  };
}
const hostOf = (cfg) => s(cfg.accountId) + '.r2.cloudflarestorage.com';
const endpointOf = (cfg) => 'https://' + hostOf(cfg);
const isReady = (cfg) => !!(cfg.accountId && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
/** The customer-facing link for an object, '' when the owner has not set a public URL (then /v/<id>.mp4 proxies). */
const publicUrl = (cfg, key) => (cfg && cfg.publicBase && key ? cfg.publicBase + '/' + String(key).replace(/^\/+/, '') : '');

let cache = null; let cacheAt = 0;
async function getConfig(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 15e3) return cache;
  let raw = {};
  try {
    const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]);
    if (r.length) { try { raw = JSON.parse(r[0].value || '{}') || {}; } catch (_) { raw = {}; } }
  } catch (e) { if (!missingTable(e)) throw e; }
  const cfg = cleanConfig(raw);
  cfg.ready = isReady(cfg);
  cfg.live = !!(cfg.on && cfg.ready);
  cache = cfg; cacheAt = Date.now();
  return cfg;
}
/** Everything the admin page may see — NEVER the keys themselves. */
function publicConfig(cfg) {
  const c = cfg || {};
  return {
    on: !!c.on, ready: !!c.ready, live: !!c.live,
    accountId: s(c.accountId), bucket: s(c.bucket), publicBase: s(c.publicBase),
    endpoint: c.accountId ? endpointOf(c) : '',
    keySet: !!c.accessKeyId, secretSet: !!c.secretAccessKey,
    freeClassA: FREE_CLASS_A, freeClassB: FREE_CLASS_B,
  };
}
/**
 * Save. A key field is only written when the owner typed something ('' = leave it alone);
 * clearKeys:true wipes both. Returns what changed (words only, never a key).
 */
async function saveConfig(input) {
  const i = input || {};
  const cur = await getConfig(true);
  const next = cleanConfig(cur);
  const errors = []; const changed = [];
  if (i.accountId !== undefined) {
    const a = s(i.accountId);
    if (a && !ACCOUNT_RE.test(a)) errors.push('Account ID looks wrong — copy it from the Cloudflare R2 page (letters and numbers).');
    else if (a !== next.accountId) { next.accountId = a; changed.push(a ? 'Account ID saved' : 'Account ID removed'); }
  }
  if (i.bucket !== undefined) {
    const b = s(i.bucket).toLowerCase();
    if (b && !BUCKET_RE.test(b)) errors.push('Bucket name can only have small letters, numbers and dashes.');
    else if (b !== next.bucket) { next.bucket = b; changed.push(b ? 'Bucket saved' : 'Bucket removed'); }
  }
  if (i.publicBase !== undefined) {
    const p = cleanBase(i.publicBase);
    if (p === null) errors.push('Public URL must be an https:// address with no ? or # — for example https://pub-xxxx.r2.dev');
    else if (p !== next.publicBase) { next.publicBase = p; changed.push(p ? 'Public URL saved' : 'Public URL removed'); }
  }
  if (truthy(i.clearKeys)) {
    if (next.accessKeyId || next.secretAccessKey) changed.push('R2 keys removed');
    next.accessKeyId = ''; next.secretAccessKey = '';
  } else {
    if (s(i.accessKeyId)) { next.accessKeyId = s(i.accessKeyId); changed.push('Access Key ID saved'); }
    if (s(i.secretAccessKey)) { next.secretAccessKey = s(i.secretAccessKey); changed.push('Secret Access Key saved'); }
  }
  if (i.on !== undefined) {
    const on = truthy(i.on);
    if (on && !isReady(Object.assign({}, next))) errors.push('Fill in the Account ID, bucket and both keys before turning Cloudflare R2 on.');
    else if (on !== next.on) { next.on = on; changed.push(on ? 'Video storage switched to Cloudflare R2' : 'Video storage switched back to the database'); }
  }
  if (errors.length) return { ok: false, message: errors.join(' '), errors };
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(next)]);
  cache = null; cacheAt = 0;
  return { ok: true, changed, config: publicConfig(await getConfig(true)) };
}

// ---------------------------------------------------------------- operation counter (free-tier watch)
const ops = { month: '', a: 0, b: 0, dirty: false, at: 0 };
const istMonth = (ms) => new Date((ms || Date.now()) + 330 * 60000).toISOString().slice(0, 7);
function countOp(cls, n) {
  const m = istMonth();
  if (ops.month !== m) { ops.month = m; ops.a = 0; ops.b = 0; }
  if (cls === 'A') ops.a += n || 1; else if (cls === 'B') ops.b += n || 1; else return;
  ops.dirty = true;
}
async function flushOps(force) {
  if (!ops.dirty || (!force && Date.now() - ops.at < 30e3)) return;
  ops.dirty = false; ops.at = Date.now();
  try { await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [OPS_KEY, JSON.stringify({ month: ops.month, a: ops.a, b: ops.b })]); } catch (_) {}
}
async function getOps() {
  const m = istMonth();
  let saved = { month: m, a: 0, b: 0 };
  try {
    const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [OPS_KEY]);
    if (r.length) { const x = JSON.parse(r[0].value || '{}') || {}; if (x.month === m) saved = { month: m, a: Number(x.a) || 0, b: Number(x.b) || 0 }; }
  } catch (_) {}
  const a = Math.max(saved.a, ops.month === m ? ops.a : 0);
  const b = Math.max(saved.b, ops.month === m ? ops.b : 0);
  return { month: m, classA: a, classB: b, freeClassA: FREE_CLASS_A, freeClassB: FREE_CLASS_B };
}

// ---------------------------------------------------------------- HTTP (S3 API)
let fetchImpl = (url, opts) => fetch(url, opts);
let sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));
const CLASS_A = /^(PUT|POST)$/;
const retryable = (status) => status === 429 || status >= 500;

/** R2 answers errors as XML: pull out something the owner can read (never our own headers / keys). */
function errText(status, body) {
  const t = s(body).slice(0, 2000);
  const code = (t.match(/<Code>([^<]{1,80})<\/Code>/) || [])[1] || '';
  const msg = (t.match(/<Message>([^<]{1,300})<\/Message>/) || [])[1] || '';
  if (code || msg) return (code ? code + ': ' : '') + (msg || '') + ' (HTTP ' + status + ')';
  return 'HTTP ' + status + (t ? ' — ' + t.replace(/\s+/g, ' ').slice(0, 160) : '');
}
const friendly = (status, body) => {
  if (status === 401 || status === 403) return 'Cloudflare refused the keys (HTTP ' + status + '). Check the Access Key ID / Secret and that the token can read AND write this bucket.';
  if (status === 404) return 'Cloudflare says that bucket or file is not there (HTTP 404). Check the bucket name.';
  return errText(status, body);
};

/**
 * One signed S3 request. opts: { method, key, query, headers, body (Buffer|''), raw (keep the Response for streaming),
 * tries }. Throws an Error with .status / .r2 on failure; never puts a key or the Authorization header in the message.
 */
async function request(cfg, opts) {
  const o = opts || {};
  if (!isReady(cfg)) { const e = new Error('Cloudflare R2 is not set up yet (Account ID, bucket and both keys).'); e.r2 = true; throw e; }
  const method = (o.method || 'GET').toUpperCase();
  const objectKey = s(o.key);
  const path = encodePath(cfg.bucket + (objectKey ? '/' + objectKey : ''));
  const body = o.body == null ? '' : o.body;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const host = hostOf(cfg);
  const tries = Math.max(1, o.tries === undefined ? TRIES : o.tries);
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const stamp = amzDate(new Date());
    const payloadHash = sha256Hex(buf);
    const headers = Object.assign({ host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp }, o.headers || {});
    if (buf.length) headers['content-length'] = String(buf.length);
    const signed = sigv4({
      method, path, query: o.query || {}, headers, payloadHash, amzDate: stamp,
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
    });
    const qs = Object.keys(o.query || {}).sort().map((k) => uriEncode(k) + '=' + uriEncode(o.query[k] === true ? '' : o.query[k])).join('&');
    const url = 'https://' + host + path + (qs ? '?' + qs : '');
    const send = Object.assign({}, headers, { Authorization: signed.authorization });
    delete send.host; // the runtime sets Host itself
    countOp(CLASS_A.test(method) ? 'A' : method === 'DELETE' ? '' : 'B');
    let res = null;
    try {
      res = await fetchImpl(url, { method, headers: send, body: buf.length ? buf : undefined, redirect: 'manual', signal: o.signal || AbortSignal.timeout(o.timeoutMs || TIMEOUT_MS) });
    } catch (err) {
      last = new Error('Cloudflare R2 did not answer: ' + s(err && err.message).slice(0, 160));
      last.r2 = true; last.offline = true;
      if (attempt < tries) { await sleepImpl(200 * attempt); continue; }
      throw last;
    }
    if (res.status >= 200 && res.status < 300) { flushOps().catch(() => {}); return res; }
    if (retryable(res.status) && attempt < tries) { try { await res.text(); } catch (_) {} await sleepImpl(200 * attempt); continue; }
    let text = '';
    try { text = await res.text(); } catch (_) {}
    const e = new Error(friendly(res.status, text));
    e.status = res.status; e.r2 = true;
    throw e;
  }
  throw last || new Error('Cloudflare R2 did not answer.');
}

const headerOf = (res, name) => {
  try { return s(res.headers && res.headers.get ? res.headers.get(name) : (res.headers || {})[name]); } catch (_) { return ''; }
};

/** One-shot upload (used below ~8 MB and for the tiny test object). */
async function putObject(cfg, key, buf, contentType) {
  const res = await request(cfg, { method: 'PUT', key, body: buf, headers: contentType ? { 'content-type': contentType } : {} });
  try { await res.text(); } catch (_) {}
  return { ok: true, etag: headerOf(res, 'etag').replace(/"/g, ''), size: Buffer.isBuffer(buf) ? buf.length : 0 };
}
async function getObject(cfg, key, range) {
  return request(cfg, { method: 'GET', key, headers: range ? { range } : {}, raw: true });
}
/** Is R2 there and does the token open this bucket? One cheap class-B call before an upload starts. */
async function headBucket(cfg) {
  const res = await request(cfg, { method: 'HEAD', key: '', tries: 2 });
  try { await res.text(); } catch (_) {}
  return { ok: true };
}
async function headObject(cfg, key) {
  const res = await request(cfg, { method: 'HEAD', key });
  try { await res.text(); } catch (_) {}
  return { ok: true, size: Number(headerOf(res, 'content-length')) || 0, etag: headerOf(res, 'etag').replace(/"/g, ''), type: headerOf(res, 'content-type') };
}
/** Delete. Missing objects are fine (R2 answers 204 either way). */
async function deleteObject(cfg, key) {
  const res = await request(cfg, { method: 'DELETE', key });
  try { await res.text(); } catch (_) {}
  return { ok: true };
}
async function createMultipart(cfg, key, contentType) {
  const res = await request(cfg, { method: 'POST', key, query: { uploads: true }, headers: contentType ? { 'content-type': contentType } : {} });
  const xml = await res.text();
  const id = (xml.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1] || '';
  if (!id) { const e = new Error('Cloudflare R2 did not give an upload id.'); e.r2 = true; throw e; }
  return { ok: true, uploadId: id };
}
async function uploadPart(cfg, key, uploadId, partNumber, buf) {
  const res = await request(cfg, { method: 'PUT', key, query: { partNumber: String(partNumber), uploadId }, body: buf });
  try { await res.text(); } catch (_) {}
  const etag = headerOf(res, 'etag');
  if (!etag) { const e = new Error('Cloudflare R2 did not confirm part ' + partNumber + '.'); e.r2 = true; throw e; }
  return { ok: true, partNumber, etag };
}
async function completeMultipart(cfg, key, uploadId, parts) {
  const xml = '<CompleteMultipartUpload>' + parts.slice().sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => '<Part><PartNumber>' + p.partNumber + '</PartNumber><ETag>' + s(p.etag).replace(/[<>&]/g, '') + '</ETag></Part>').join('') + '</CompleteMultipartUpload>';
  const res = await request(cfg, { method: 'POST', key, query: { uploadId }, body: Buffer.from(xml, 'utf8'), headers: { 'content-type': 'application/xml' } });
  const body = await res.text();
  // S3 can answer 200 with an error inside the body — treat that as a failure.
  if (/<Error>/.test(body)) { const e = new Error(errText(200, body)); e.r2 = true; throw e; }
  return { ok: true, etag: ((body.match(/<ETag>([^<]+)<\/ETag>/) || [])[1] || '').replace(/(&quot;|")/g, '') };
}
async function abortMultipart(cfg, key, uploadId) {
  try { const res = await request(cfg, { method: 'DELETE', key, query: { uploadId }, tries: 1 }); try { await res.text(); } catch (_) {} } catch (_) {}
  return { ok: true };
}

/** 🔌 Test connection: write a tiny object, read it back, delete it. Says exactly which step failed. */
async function testConnection(input) {
  const cfg = input && input.accountId ? Object.assign(cleanConfig(input), { on: true }) : await getConfig(true);
  const steps = [];
  if (!isReady(cfg)) return { ok: false, steps, message: 'Fill in the Account ID, bucket, Access Key ID and Secret Access Key first.' };
  const key = TEST_KEY;
  const body = Buffer.from('FluxFilm R2 check ' + new Date().toISOString(), 'utf8');
  try {
    await putObject(cfg, key, body, 'text/plain');
    steps.push({ step: 'write', ok: true });
  } catch (e) { steps.push({ step: 'write', ok: false, error: s(e.message) }); return { ok: false, steps, message: '❌ Could not write to the bucket. ' + s(e.message) }; }
  try {
    const res = await getObject(cfg, key);
    const back = Buffer.from(await res.arrayBuffer());
    if (!back.equals(body)) { steps.push({ step: 'read', ok: false, error: 'what came back is not what went in' }); return { ok: false, steps, message: '❌ The file read back from R2 does not match what was written.' }; }
    steps.push({ step: 'read', ok: true });
  } catch (e) { steps.push({ step: 'read', ok: false, error: s(e.message) }); return { ok: false, steps, message: '❌ Wrote the file but could not read it back. ' + s(e.message) }; }
  try { await deleteObject(cfg, key); steps.push({ step: 'delete', ok: true }); }
  catch (e) { steps.push({ step: 'delete', ok: false, error: s(e.message) }); return { ok: false, steps, message: '⚠️ Wrote and read the file, but could not delete it. Give the API token "Object Read & Write". ' + s(e.message) }; }
  const pub = publicUrl(cfg, 'reels/example.mp4');
  return { ok: true, steps, message: '✅ Cloudflare R2 works — wrote, read and deleted a test file in "' + cfg.bucket + '".' + (pub ? ' Videos will be served from ' + cfg.publicBase + '.' : ' No public URL set, so the shop will serve videos through /v/<id>.mp4.') };
}

module.exports = {
  getConfig, publicConfig, saveConfig, cleanConfig, cleanBase, testConnection,
  putObject, getObject, headObject, headBucket, deleteObject, createMultipart, uploadPart, completeMultipart, abortMultipart,
  publicUrl, endpointOf, hostOf, isReady, countOp, flushOps, getOps, headerOf,
  KEY, OPS_KEY, TEST_KEY, FREE_CLASS_A, FREE_CLASS_B,
  _internal: {
    sigv4, sha256Hex, uriEncode, encodePath, amzDate, request, errText, ops,
    setFetch: (f) => { fetchImpl = f || ((url, opts) => fetch(url, opts)); },
    setSleep: (f) => { sleepImpl = f || ((ms) => new Promise((r) => setTimeout(r, ms))); },
    reset: () => { cache = null; cacheAt = 0; ops.month = ''; ops.a = 0; ops.b = 0; ops.dirty = false; ops.at = 0; },
  },
};
