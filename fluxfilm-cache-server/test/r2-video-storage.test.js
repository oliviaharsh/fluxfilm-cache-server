/* 🪣 Cloudflare R2 video storage (r2.js, feedvideo.js, db/schema-v27.sql) + 🧽 Erase older reels (feederase.js):
   SigV4 against AWS's published test vector, settings whose keys never come back out, uploads (single PUT vs
   multipart, retries, R2 down = a clear error and NO database fallback), playback (public URL vs Range proxy),
   delete, the move from MySQL to R2, the erase tool's counts / filters / typed confirm / change log, and the 75%
   warning in admin and in the owner's summary. DB mocked, S3 mocked — no network, no credentials. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

let pass = 0, fail = 0;
const realLog = console.log; // the run captures console.log to prove no secret is ever printed
const say = (...a) => realLog(...a);
const ok = (n, c, x) => { if (c) pass++; else { fail++; say('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x, (k, v) => (Buffer.isBuffer(v) ? '<buf ' + v.length + '>' : v)).slice(0, 700) : '')); } };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MB = 1024 * 1024;

// ---------------------------------------------------------------- in-memory MySQL
const T = { cols: true, settings: {}, videos: {}, chunks: {}, sql: [] };
const SEL = 'id, mime, size_bytes, chunks, sha256, duration_s, status, created_at';
const SEL_R2 = SEL + ', storage, r2_key, r2_etag, upload_ref';
const copy = (v) => Object.assign({}, v);
const mockDb = {
  ENABLED: true,
  query: async (sqlRaw, p) => {
    const sql = String(sqlRaw).replace(/\s+/g, ' ').trim(); p = p || [];
    T.sql.push(sql);
    // Live lesson: feed_* tables are utf8mb4_unicode_ci and the old tables are not — a JOIN across them blows up.
    if (/\bJOIN\b/i.test(sql)) throw new Error("Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT) for operation '='");
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return T.settings[p[0]] != null ? [{ value: T.settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { T.settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/^DELETE FROM app_settings/.test(sql)) { delete T.settings[p[0]]; return { affectedRows: 1 }; }
    if (sql === 'SELECT storage FROM feed_videos LIMIT 1') { if (!T.cols) { const e = new Error("Unknown column 'storage' in 'field list'"); e.code = 'ER_BAD_FIELD_ERROR'; e.errno = 1054; throw e; } return []; }
    if (sql === 'SELECT id FROM feed_videos LIMIT 1') return Object.keys(T.videos).slice(0, 1).map((id) => ({ id }));
    if (sql === 'SELECT video_id FROM feed_video_chunks LIMIT 1') return [];
    if (/^SELECT id FROM feed_videos WHERE status = \? AND created_at < \?$/.test(sql)) return Object.values(T.videos).filter((v) => v.status === p[0] && v.created_at < p[1]).map((v) => ({ id: v.id }));
    if (/^SELECT COALESCE\(SUM\(size_bytes\), 0\) AS n FROM feed_videos WHERE storage = \?$/.test(sql)) return [{ n: Object.values(T.videos).filter((v) => (v.storage || 'db') === p[0]).reduce((a, v) => a + v.size_bytes, 0) }];
    if (sql === 'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feed_videos') return [{ n: Object.values(T.videos).reduce((a, v) => a + v.size_bytes, 0) }];
    if (/^INSERT INTO feed_videos \(id, mime, size_bytes, chunks, sha256, duration_s, status, created_at, storage, r2_key\)/.test(sql)) { T.videos[p[0]] = { id: p[0], mime: p[1], size_bytes: p[2], chunks: p[3], sha256: p[4], duration_s: p[5], status: p[6], created_at: p[7], storage: p[8], r2_key: p[9], r2_etag: null, upload_ref: null, moved_at: null }; return { affectedRows: 1 }; }
    if (/^INSERT INTO feed_videos \(id, mime, size_bytes, chunks, sha256, duration_s, status, created_at\)/.test(sql)) { T.videos[p[0]] = { id: p[0], mime: p[1], size_bytes: p[2], chunks: p[3], sha256: p[4], duration_s: p[5], status: p[6], created_at: p[7], storage: 'db', r2_key: null, r2_etag: null, upload_ref: null }; return { affectedRows: 1 }; }
    if (sql === 'SELECT ' + SEL_R2 + ' FROM feed_videos WHERE id = ? LIMIT 1' || sql === 'SELECT ' + SEL + ' FROM feed_videos WHERE id = ? LIMIT 1') return T.videos[p[0]] ? [copy(T.videos[p[0]])] : [];
    if (/^SELECT .* FROM feed_videos WHERE id IN \(\?(, \?)*\)$/.test(sql)) return p.filter((x) => T.videos[x]).map((x) => copy(T.videos[x]));
    if (/^SELECT .* FROM feed_videos ORDER BY created_at DESC LIMIT 200$/.test(sql)) return Object.values(T.videos).map(copy).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (/^SELECT storage, COUNT\(\*\) AS c, COALESCE\(SUM\(size_bytes\), 0\) AS b FROM feed_videos WHERE status = 'ready' GROUP BY storage$/.test(sql)) {
      const g = {};
      for (const v of Object.values(T.videos)) { if (v.status !== 'ready') continue; const k = v.storage || 'db'; g[k] = g[k] || { storage: k, c: 0, b: 0 }; g[k].c++; g[k].b += v.size_bytes; }
      return Object.values(g);
    }
    if (/FROM feed_videos WHERE status = 'ready' AND storage = 'db' ORDER BY created_at ASC LIMIT 1$/.test(sql)) {
      const r = Object.values(T.videos).filter((v) => v.status === 'ready' && (v.storage || 'db') === 'db').sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
      return r ? [copy(r)] : [];
    }
    if (/^INSERT INTO feed_video_chunks/.test(sql)) { T.chunks[p[0] + '|' + p[1]] = Buffer.from(p[2]); return { affectedRows: 1 }; }
    if (/^SELECT COUNT\(\*\) AS c, COALESCE\(SUM\(LENGTH\(data\)\), 0\) AS b FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) { const ks = Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')); return [{ c: ks.length, b: ks.reduce((a, k) => a + T.chunks[k].length, 0) }]; }
    if (/^SELECT data FROM feed_video_chunks WHERE video_id = \? AND n = \? LIMIT 1$/.test(sql)) { const b = T.chunks[p[0] + '|' + p[1]]; return b ? [{ data: b }] : []; }
    if (/^UPDATE feed_videos SET status = \?, r2_etag = \?, upload_ref = NULL WHERE id = \?$/.test(sql)) { if (T.videos[p[2]]) { T.videos[p[2]].status = p[0]; T.videos[p[2]].r2_etag = p[1]; T.videos[p[2]].upload_ref = null; } return { affectedRows: 1 }; }
    if (/^UPDATE feed_videos SET status = \? WHERE id = \?$/.test(sql)) { if (T.videos[p[1]]) T.videos[p[1]].status = p[0]; return { affectedRows: 1 }; }
    if (/^UPDATE feed_videos SET storage = \?, r2_key = \?, r2_etag = \?, moved_at = \? WHERE id = \?$/.test(sql)) { const v = T.videos[p[4]]; if (v) { v.storage = p[0]; v.r2_key = p[1]; v.r2_etag = p[2]; v.moved_at = p[3]; } return { affectedRows: 1 }; }
    if (/^DELETE FROM feed_video_chunks WHERE video_id = \?$/.test(sql)) { const ks = Object.keys(T.chunks).filter((k) => k.startsWith(p[0] + '|')); ks.forEach((k) => delete T.chunks[k]); return { affectedRows: ks.length }; }
    if (/^DELETE FROM feed_videos WHERE id = \?$/.test(sql)) { delete T.videos[p[0]]; return { affectedRows: 1 }; }
    if (/feed_videos|feed_video_chunks/.test(sql)) throw new Error('unexpected video SQL: ' + sql);
    return []; // feed_likes / feed_comments / plans / …
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

const r2 = require('../r2');
const vid = require('../feedvideo');
const feed = require('../feed');
const erase = require('../feederase');
const reports = require('../reports');

// ---------------------------------------------------------------- a tiny fake S3 / R2 endpoint
const S3 = { objects: {}, uploads: {}, calls: [], down: false, failNext: 0, failDelete: false, nextId: 1 };
const xml = (s) => new Response(s, { status: 200, headers: { 'content-type': 'application/xml' } });
async function fakeFetch(url, opts) {
  const u = new URL(url);
  const o = opts || {};
  const method = o.method || 'GET';
  const body = o.body ? Buffer.from(o.body) : Buffer.alloc(0);
  const h = {}; for (const [k, v] of Object.entries(o.headers || {})) h[String(k).toLowerCase()] = String(v);
  const seg = u.pathname.replace(/^\//, '').split('/');
  const bucket = decodeURIComponent(seg.shift() || '');
  const key = seg.map(decodeURIComponent).join('/');
  S3.calls.push({ method, bucket, key, query: u.search, host: u.host });
  if (S3.down) throw new Error('fetch failed: ECONNREFUSED');
  // Every request must be signed, and the payload hash must really be the hash of the body.
  if (!/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=\S+, Signature=[0-9a-f]{64}$/.test(h.authorization || '')) return new Response('<Error><Code>AccessDenied</Code><Message>bad signature</Message></Error>', { status: 403 });
  if (h['x-amz-content-sha256'] !== crypto.createHash('sha256').update(body).digest('hex')) return new Response('<Error><Code>XAmzContentSHA256Mismatch</Code><Message>payload hash wrong</Message></Error>', { status: 400 });
  if (S3.failNext > 0) { S3.failNext -= 1; return new Response('<Error><Code>InternalError</Code><Message>try again</Message></Error>', { status: 500 }); }
  const q = u.searchParams;
  if (method === 'HEAD' && !key) return new Response(null, { status: 200 });
  if (method === 'POST' && q.has('uploads')) { const id = 'up' + (S3.nextId++); S3.uploads[id] = { key, parts: {} }; return xml('<InitiateMultipartUploadResult><UploadId>' + id + '</UploadId></InitiateMultipartUploadResult>'); }
  if (method === 'PUT' && q.get('uploadId')) {
    const up = S3.uploads[q.get('uploadId')]; if (!up) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
    up.parts[Number(q.get('partNumber'))] = body;
    return new Response(null, { status: 200, headers: { etag: '"p' + q.get('partNumber') + '"' } });
  }
  if (method === 'POST' && q.get('uploadId')) {
    const up = S3.uploads[q.get('uploadId')]; if (!up) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
    const nums = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
    S3.objects[up.key] = Buffer.concat(nums.map((n) => up.parts[n] || Buffer.alloc(0)));
    delete S3.uploads[q.get('uploadId')];
    return xml('<CompleteMultipartUploadResult><ETag>&quot;multi-' + nums.length + '&quot;</ETag></CompleteMultipartUploadResult>');
  }
  if (method === 'DELETE' && q.get('uploadId')) { delete S3.uploads[q.get('uploadId')]; return new Response(null, { status: 204 }); }
  if (method === 'PUT') { S3.objects[key] = body; return new Response(null, { status: 200, headers: { etag: '"' + crypto.createHash('md5').update(body).digest('hex') + '"' } }); }
  if (method === 'DELETE') { if (S3.failDelete) return new Response('<Error><Code>AccessDenied</Code><Message>no delete rights</Message></Error>', { status: 403 }); delete S3.objects[key]; return new Response(null, { status: 204 }); }
  const obj = S3.objects[key];
  if (!obj) return new Response('<Error><Code>NoSuchKey</Code><Message>not there</Message></Error>', { status: 404 });
  if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(obj.length), etag: '"x"' } });
  const rg = (h.range || '').match(/^bytes=(\d+)-(\d*)$/);
  if (rg) {
    const a = Number(rg[1]); const b = rg[2] === '' ? obj.length - 1 : Math.min(Number(rg[2]), obj.length - 1);
    if (a >= obj.length) return new Response('<Error><Code>InvalidRange</Code></Error>', { status: 416 });
    const part = obj.slice(a, b + 1);
    return new Response(part, { status: 206, headers: { 'content-length': String(part.length), 'content-range': 'bytes ' + a + '-' + b + '/' + obj.length } });
  }
  return new Response(obj, { status: 200, headers: { 'content-length': String(obj.length) } });
}
r2._internal.setFetch(fakeFetch);
r2._internal.setSleep(async () => {});

// ---------------------------------------------------------------- helpers
const ACCOUNT = 'abc123def456abc123def456abc12345';
const AKID = 'AKIDR2EXAMPLE0001';
const SECRET = 'r2SeCrEtKeY-nEvEr-LeAvEs-ThE-sErVeR-0001';
const mp4 = (size) => { const b = crypto.randomBytes(size); b.write('\0\0\0\x18ftypisom', 0, 'latin1'); return b; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function upload(file, extra) {
  const r = await vid.start(Object.assign({ mime: 'video/mp4', size: file.length, sha256: sha(file), duration: 30 }, extra || {}));
  if (!r.ok) return r;
  for (let n = 0; n < r.chunks; n++) { const c = await vid.chunk(r.id, n, file.slice(n * r.chunkSize, (n + 1) * r.chunkSize)); if (!c.ok) return c; }
  return vid.finish(r.id);
}
function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res.headers = {}; res.chunks = chunks;
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { if (typeof k === 'object') Object.assign(res.headers, k); else res.headers[k] = v; return res; };
  res.type = () => res;
  res.send = (x) => { chunks.push(Buffer.from(String(x))); res.end(); return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.headers.Location = url; res.end(); return res; };
  res.out = () => Buffer.concat(chunks);
  return res;
}
const LOGS = [];
console.log = function (...a) { LOGS.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
async function reset() {
  T.settings = {}; T.videos = {}; T.chunks = {}; T.sql = [];
  S3.objects = {}; S3.uploads = {}; S3.calls = []; S3.down = false; S3.failNext = 0; S3.failDelete = false;
  r2._internal.reset(); vid._internal.reset(); feed._internal.reset();
}
async function turnR2On(publicBase) {
  const r = await r2.saveConfig({ accountId: ACCOUNT, bucket: 'fluxfilm-reels', accessKeyId: AKID, secretAccessKey: SECRET, publicBase: publicBase || '' });
  if (!r.ok) throw new Error('config: ' + r.message);
  const on = await r2.saveConfig({ on: true });
  if (!on.ok) throw new Error('on: ' + on.message);
  vid._internal.reset();
  return { ok: on.ok, changed: r.changed.concat(on.changed), saved: r, on };
}

(async () => {
  // ================= 1. schema-v27 =================
  const schema = read('db/schema-v27.sql').replace(/^--.*$/gm, '');
  ok('schema-v27: plain ALTER TABLE adding storage / r2_key / r2_etag / upload_ref / moved_at, no information_schema or PREPARE',
    /ALTER TABLE feed_videos ADD COLUMN storage VARCHAR\(8\) NOT NULL DEFAULT 'db';/.test(schema) && /ADD COLUMN r2_key VARCHAR\(200\) NULL;/.test(schema)
    && /ADD COLUMN r2_etag /.test(schema) && /ADD COLUMN upload_ref /.test(schema) && /ADD COLUMN moved_at DATETIME NULL;/.test(schema)
    && !/information_schema|PREPARE|EXECUTE/i.test(schema));

  // ================= 2. SigV4 against AWS's published test vector =================
  // "get-vanilla" from the AWS Signature Version 4 test suite: the canonical request hash and the signature are the
  // numbers AWS prints, so a wrong header order / trim / payload hash here would show up at once.
  const v = r2._internal.sigv4({
    method: 'GET', path: '/', query: {}, headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    payloadHash: r2._internal.sha256Hex(''), amzDate: '20150830T123600Z', region: 'us-east-1', service: 'service',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  });
  ok('SigV4 canonical request = AWS get-vanilla (lower-case sorted headers, empty query, hash of an empty body)',
    v.canonicalRequest === 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', JSON.stringify(v.canonicalRequest));
  ok('SigV4 string to sign = AWS get-vanilla (canonical request hash bb579772…)',
    v.stringToSign === 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63', JSON.stringify(v.stringToSign));
  ok('SigV4 signature = AWS get-vanilla 5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', v.signature === '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', v.signature);
  ok('SigV4 Authorization header is built the way AWS wants it', v.authorization === 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', v.authorization);
  const v2 = r2._internal.sigv4({ method: 'PUT', path: '/b/k', query: { partNumber: '2', uploadId: 'a b' }, headers: { host: 'h', 'x-amz-date': '20260916T000000Z', 'x-amz-content-sha256': 'x' }, payloadHash: 'x', amzDate: '20260916T000000Z', accessKeyId: 'A', secretAccessKey: 'S' });
  ok('SigV4: the query is sorted and encoded, the scope is auto/s3 (what R2 wants)', /partNumber=2&uploadId=a%20b/.test(v2.canonicalRequest) && /auto\/s3\/aws4_request/.test(v2.credentialScope), v2.canonicalRequest.split('\n')[2]);
  ok('URI encoding keeps only A-Z a-z 0-9 - _ . ~ literal (space, /, + and ~ all correct)',
    r2._internal.uriEncode('a b/c+d~e') === 'a%20b%2Fc%2Bd~e' && r2._internal.encodePath('bucket/reels/fv01.mp4') === '/bucket/reels/fv01.mp4' && r2._internal.uriEncode('ü') === '%C3%BC',
    [r2._internal.uriEncode('a b/c+d~e'), r2._internal.encodePath('bucket/reels/fv01.mp4')]);

  // ================= 3. settings: the keys go in and never come back =================
  await reset();
  let r = await r2.saveConfig({ accountId: 'no spaces allowed!' });
  ok('bad Account ID refused in plain English', !r.ok && /Account ID/.test(r.message), r);
  r = await r2.saveConfig({ bucket: 'Not_A_Bucket' });
  ok('bad bucket name refused', !r.ok && /Bucket name/.test(r.message), r);
  r = await r2.saveConfig({ publicBase: 'http://pub.example.com' });
  ok('a public URL must be https with no ? or #', !r.ok && /https/.test(r.message), r);
  r = await r2.saveConfig({ on: true });
  ok('R2 cannot be switched on before the keys are in', !r.ok && /before turning Cloudflare R2 on/.test(r.message), r);
  r = await turnR2On('https://pub-abc.r2.dev');
  ok('saving works and the change log words never contain a key', r.ok && r.changed.join(' ').includes('Access Key ID saved') && !JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(AKID), r.changed);
  const pub = r2.publicConfig(await r2.getConfig(true));
  ok('publicConfig: only "set" / "not set", never the keys themselves', pub.keySet === true && pub.secretSet === true && pub.bucket === 'fluxfilm-reels' && pub.endpoint === 'https://' + ACCOUNT + '.r2.cloudflarestorage.com' && !JSON.stringify(pub).includes(SECRET) && !JSON.stringify(pub).includes(AKID), pub);
  ok('the keys ARE saved on the server (app_settings) so uploads can sign', JSON.parse(T.settings.r2_settings).secretAccessKey === SECRET);
  r = await r2.saveConfig({ bucket: 'other-bucket' });
  ok('changing one field leaves the keys alone', r.ok && (await r2.getConfig(true)).accessKeyId === AKID, r.changed);
  await r2.saveConfig({ bucket: 'fluxfilm-reels' });
  r = await r2.testConnection();
  ok('🔌 Test connection writes, reads back and deletes a tiny object, and says so', r.ok && r.steps.map((x) => x.step).join() === 'write,read,delete' && /works/.test(r.message) && !S3.objects[r2.TEST_KEY], r);
  S3.failDelete = true;
  r = await r2.testConnection();
  ok('🔌 Test connection names the exact step that failed (delete rights missing)', !r.ok && /could not delete/.test(r.message) && /Object Read & Write/.test(r.message), r.message);
  S3.failDelete = false;
  S3.down = true;
  r = await r2.testConnection();
  ok('🔌 Test connection with R2 unreachable → a clear error, never a stack trace', !r.ok && /Could not write/.test(r.message) && /did not answer/.test(r.message), r.message);
  S3.down = false;

  // ================= 4. upload with R2 on: only the key in MySQL, no chunks =================
  await reset(); await turnR2On('https://pub-abc.r2.dev');
  ok('storeMode() is r2 once it is configured and switched on', (await vid.storeMode()) === 'r2');
  const small = mp4(3 * MB);
  r = await upload(small);
  const id1 = r.id;
  ok('small video (3 MB) → ONE PUT, not multipart', r.ok && r.storage === 'r2' && S3.calls.filter((c) => c.method === 'PUT' && !/uploadId/.test(c.query)).length === 1 && !S3.calls.some((c) => /uploads/.test(c.query)), { r, calls: S3.calls.map((c) => c.method + c.query) });
  ok('the bytes are in R2 and byte-for-byte the same', S3.objects['reels/' + id1 + '.mp4'] && S3.objects['reels/' + id1 + '.mp4'].equals(small));
  ok('MySQL keeps ONLY the key, size, type, duration and etag — no chunks at all', Object.keys(T.chunks).length === 0 && T.videos[id1].storage === 'r2' && T.videos[id1].r2_key === 'reels/' + id1 + '.mp4' && T.videos[id1].r2_etag && T.videos[id1].size_bytes === small.length && T.videos[id1].duration_s === 30, T.videos[id1]);
  ok('the per-video cap with R2 on is 200 MB (the database default is still 60 MB)', (await vid.limitsFor('r2')).maxMb === 200 && (await vid.limitsFor('db')).maxMb === 60, [(await vid.limitsFor('r2')).maxMb, (await vid.limitsFor('db')).maxMb]);
  ok('the total cap with R2 on is 8 GB by default (the free tier is 10 GB)', (await vid.limitsFor('r2')).totalMb === 8192);
  r = await vid.saveLimits({ videoMaxMbR2: 500 });
  ok('an R2 per-video cap above 200 MB is refused', !r.ok && /1–200 MB/.test(r.message), r);
  r = await vid.start({ mime: 'video/mp4', size: 150 * MB, sha256: 'a'.repeat(64) });
  ok('a 150 MB video is fine with R2 on (it would be refused on the database)', r.ok === true, r);
  await vid.abortUpload(r.id);

  // multipart + retry
  S3.calls = [];
  const big = mp4(20 * MB);
  r = await upload(big);
  const idBig = r.id;
  const parts = S3.calls.filter((c) => c.method === 'PUT' && /partNumber/.test(c.query));
  ok('20 MB video → a multipart upload in 8 MB parts (S3 wants every part but the last ≥ 5 MB)', r.ok && parts.length === 3 && S3.calls.some((c) => /uploads/.test(c.query)) && S3.objects['reels/' + idBig + '.mp4'].equals(big), { parts: parts.length });
  ok('a multipart upload still stores no chunks in MySQL', Object.keys(T.chunks).filter((k) => k.startsWith(idBig)).length === 0);
  S3.calls = [];
  S3.failNext = 1; // R2 answers one 500 — the upload must retry, not fail
  const retryFile = mp4(2 * MB);
  r = await upload(retryFile);
  ok('a 500 from R2 is retried and the upload still finishes', r.ok && S3.objects['reels/' + r.id + '.mp4'].equals(retryFile), r);
  await vid.remove(r.id);

  // the SHA-256 the browser sent must match what went up
  r = await vid.start({ mime: 'video/mp4', size: 1000, sha256: sha(mp4(10)) });
  const badId = r.id;
  await vid.chunk(badId, 0, mp4(1000));
  r = await vid.finish(badId);
  ok('SHA-256 mismatch → refused, the row is gone and nothing is left in R2', !r.ok && /SHA-256/.test(r.message) && !T.videos[badId] && !S3.objects['reels/' + badId + '.mp4'], r);

  // ================= 5. R2 down: a clear error, NEVER a quiet database fallback =================
  S3.down = true;
  const before = Object.keys(T.videos).length;
  r = await vid.start({ mime: 'video/mp4', size: 2 * MB, sha256: 'a'.repeat(64) });
  ok('R2 unreachable at upload time → clear error, r2Down, and no half-made row', !r.ok && r.r2Down === true && /did not answer/.test(r.message) && /Test connection/.test(r.message) && Object.keys(T.videos).length === before, r);
  ok('…and nothing was written to the database instead (no silent fallback)', Object.keys(T.chunks).length === 0 && !/Nothing was saved in the database instead\.$/.test('') && /Nothing was saved in the database instead/.test(r.message));
  // Existing videos must still play while R2 is down for writes.
  S3.down = false;
  let res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: {}, method: 'GET' }, res);
  ok('playback of videos already uploaded still works', res.statusCode === 302 || res.statusCode === 200, res.statusCode);

  // ================= 6. serving =================
  // (a) a public URL is set → the feed hands out the R2 link and /v/<id>.mp4 redirects to it
  await feed.save({ title: 'R2 reel', brand: 'Netflix', ctaService: 'Netflix', format: 'reel', videoId: id1, active: true });
  feed._internal.reset();
  let plist = await feed.publicList(new Date());
  let post1 = plist.posts.find((p) => p.title === 'R2 reel');
  ok('public feed uses the R2 public URL when the owner set one', post1 && post1.video === 'https://pub-abc.r2.dev/reels/' + id1 + '.mp4', post1 && post1.video);
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: {}, method: 'GET' }, res);
  ok('/v/<id>.mp4 redirects to the public URL (old links keep working)', res.statusCode === 302 && res.headers.Location === 'https://pub-abc.r2.dev/reels/' + id1 + '.mp4', res.headers);
  // (b) no public URL → we proxy, and Range is honoured
  await r2.saveConfig({ publicBase: '' });
  vid._internal.reset(); feed._internal.reset();
  plist = await feed.publicList(new Date());
  post1 = plist.posts.find((p) => p.title === 'R2 reel');
  ok('with no public URL the feed falls back to our own /v/<id>.mp4', post1 && post1.video === '/v/' + id1 + '.mp4', post1 && post1.video);
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: { range: 'bytes=1000-1099' }, method: 'GET' }, res);
  ok('proxy honours Range: 206, right Content-Range / Content-Length, and exactly the right 100 bytes',
    res.statusCode === 206 && res.headers['Content-Range'] === 'bytes 1000-1099/' + small.length && res.headers['Content-Length'] === '100' && res.out().equals(small.slice(1000, 1100)),
    { code: res.statusCode, h: res.headers, got: res.out().length });
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: {}, method: 'GET' }, res);
  ok('proxy with no Range → 200 and the whole file, streamed', res.statusCode === 200 && res.out().equals(small));
  ok('proxy keeps our own headers (type, immutable cache, ETag from the SHA-256, nosniff)', res.headers['Content-Type'] === 'video/mp4' && /immutable/.test(res.headers['Cache-Control']) && res.headers.ETag === '"' + sha(small).slice(0, 32) + '"' && res.headers['X-Content-Type-Options'] === 'nosniff');
  S3.down = true;
  res = fakeRes();
  await vid.serve({ params: { file: id1 + '.mp4' }, headers: {}, method: 'GET' }, res);
  ok('R2 unreachable while playing → 502 and a logged reason, never a crash', res.statusCode === 502 && LOGS.some((l) => /R2 read failed/.test(l)));
  S3.down = false;

  // ================= 7. delete =================
  S3.calls = [];
  r = await feed.remove((await feed.list()).find((p) => p.title === 'R2 reel').id);
  ok('deleting the post deletes the R2 object and the row', r.ok && !S3.objects['reels/' + id1 + '.mp4'] && !T.videos[id1] && S3.calls.some((c) => c.method === 'DELETE' && c.key === 'reels/' + id1 + '.mp4'), S3.calls.map((c) => c.method + ' ' + c.key));
  // a failing R2 delete must not keep the post alive
  const keep = await upload(mp4(1.2 * MB));
  await feed.save({ title: 'Doomed reel', brand: 'Netflix', format: 'reel', videoId: keep.id, active: true });
  S3.failDelete = true; LOGS.length = 0;
  r = await feed.remove((await feed.list()).find((p) => p.title === 'Doomed reel').id);
  ok('R2 refuses the delete → the post and the row still go, and the problem is logged for the owner',
    r.ok && !T.videos[keep.id] && !(await feed.list()).some((p) => p.title === 'Doomed reel') && LOGS.some((l) => /could not delete .* from R2/.test(l)), LOGS.slice(0, 3));
  S3.failDelete = false;

  // ================= 8. ⬆️ move the database videos to R2 =================
  await reset();
  // two videos uploaded the old way (storage 'db', bytes in feed_video_chunks)
  const dbFile1 = mp4(2.5 * MB); const dbFile2 = mp4(12 * MB);
  let u1 = await upload(dbFile1); let u2 = await upload(dbFile2);
  ok('with R2 off the videos still go into MySQL chunks, exactly as before', u1.ok && u2.ok && T.videos[u1.id].storage === 'db' && Object.keys(T.chunks).length === 3 + 12, Object.keys(T.chunks).length);
  await turnR2On('');
  let st = await vid.migrateStatus();
  ok('migrate status: 2 videos waiting in the database', st.ready && st.pending === 2 && st.pendingBytes === dbFile1.length + dbFile2.length, st);
  r = await vid.migrateNext();
  ok('move #1: the small one goes up with one PUT, R2 confirms the size, the chunks are freed',
    r.ok && r.moved.id === u1.id && S3.objects['reels/' + u1.id + '.mp4'].equals(dbFile1) && T.videos[u1.id].storage === 'r2' && T.videos[u1.id].moved_at && !Object.keys(T.chunks).some((k) => k.startsWith(u1.id)) && r.left === 1, r);
  r = await vid.migrateNext();
  ok('move #2: the 12 MB one goes up as a multipart upload and matches byte for byte', r.ok && r.done && S3.objects['reels/' + u2.id + '.mp4'].equals(dbFile2) && !Object.keys(T.chunks).length, r);
  r = await vid.migrateNext();
  ok('running the move again when everything is there is safe and says so', r.ok && r.done && r.moved === null && /All Reel videos are in Cloudflare R2/.test(r.message), r);
  // resumable: put one back in the database and move it again
  T.videos[u1.id].storage = 'db'; T.videos[u1.id].r2_key = null;
  for (let n = 0; n < T.videos[u1.id].chunks; n++) T.chunks[u1.id + '|' + n] = dbFile1.slice(n * MB, (n + 1) * MB);
  r = await vid.migrateNext();
  ok('a move stopped half way just runs again next time (it overwrites and re-checks)', r.ok && r.moved.id === u1.id && T.videos[u1.id].storage === 'r2' && !Object.keys(T.chunks).length, r);
  res = fakeRes();
  await vid.serve({ params: { file: u1.id + '.mp4' }, headers: { range: 'bytes=0-9' }, method: 'GET' }, res);
  ok('a moved video plays from R2 straight away', res.statusCode === 206 && res.out().equals(dbFile1.slice(0, 10)));

  // ================= 9. the 75% warning =================
  await reset(); await turnR2On('');
  await vid.saveLimits({ videoTotalMbR2: 100 });
  T.videos.fvaaaaaaaaaaaaaaaa = { id: 'fvaaaaaaaaaaaaaaaa', mime: 'video/mp4', size_bytes: 80 * MB, chunks: 80, sha256: 'a'.repeat(64), duration_s: 60, status: 'ready', created_at: '2026-09-01 10:00:00', storage: 'r2', r2_key: 'reels/fvaaaaaaaaaaaaaaaa.mp4', r2_etag: 'x', upload_ref: null };
  let use = await vid.usage();
  ok('usage: 80 MB of 100 MB → ⚠️ warn at 75%, with the words the banner shows', use.ready && use.warn && use.warn.over === true && use.warn.pct === 80 && /R2 videos: 80 MB of 100 MB/.test(use.warn.text), use.warn);
  ok('usage also reports both stores, which one is in use, and how many still wait to be moved', use.mode === 'r2' && use.db && use.r2 && use.r2.pct === 80 && use.db.pct === 0 && use.migrate.pending === 0, { mode: use.mode, r2: use.r2.pct, db: use.db.pct });
  await r2.testConnection(); // one write + one read + one delete
  use = await vid.usage();
  ok('usage counts R2 operations for the month so the owner can see the free tier is nowhere near',
    use.r2.ops && use.r2.ops.freeClassA === 1000000 && use.r2.ops.freeClassB === 10000000 && use.r2.ops.classA >= 1 && use.r2.ops.classB >= 1, use.r2.ops);
  T.videos.fvaaaaaaaaaaaaaaaa.size_bytes = 40 * MB;
  use = await vid.usage();
  ok('under 75% there is no warning at all', use.ready && !use.warn && use.r2.pct === 40, use.r2);
  // the MySQL store is warned about too, even when R2 is the one in use
  T.videos.fvbbbbbbbbbbbbbbbb = { id: 'fvbbbbbbbbbbbbbbbb', mime: 'video/mp4', size_bytes: 90 * MB, chunks: 90, sha256: 'b'.repeat(64), duration_s: 60, status: 'ready', created_at: '2026-09-02 10:00:00', storage: 'db', r2_key: null, r2_etag: null, upload_ref: null };
  await vid.saveLimits({ videoTotalMb: 100 });
  use = await vid.usage();
  ok('the database store passing 75% is warned about as well (old videos still to move)', use.warn && (use.warn.all || []).some((x) => x.store === 'db' && /still in the database/.test(x.text)), use.warn);
  // the owner's daily summary gets a to-do line
  const sum = {
    relLabel: 'Today', kind: 'day', totals: { revenue: 0, orders: 0, newOrders: 0, newRevenue: 0, renewals: 0, renewRevenue: 0, avgOrder: 0, newCustomers: 0, services: [], plans: [], refunds: { count: 0, amount: 0, methods: {} }, daily: [] },
    prev: { revenue: 0, orders: 0, newCustomers: 0, refunds: { count: 0, amount: 0 } },
    videos: { store: 'Cloudflare R2', pct: 76.2, text: '6.1 GB of 8 GB', warn: { over: true, text: 'R2 videos: 6.1 GB of 8 GB (76.2%)' } },
  };
  const secs = reports.sections(sum);
  const vsec = secs.find((x) => x.title === '🎬 Reel videos');
  ok('owner summary: a "🎬 Reel videos" to-do line once the store passes 75%', !!vsec && /To do: erase older reels/.test(vsec.rows[0][0]) && vsec.rows[0][1] === '6.1 GB of 8 GB' && /Erase older reels/.test(vsec.rows[0][2]), vsec);
  ok('owner summary push line mentions it too', /🎬 Videos 76\.2% full/.test(reports.pushBody(sum)), reports.pushBody(sum));
  delete sum.videos;
  ok('…and says nothing at all when the store is fine', !reports.sections(sum).some((x) => x.title === '🎬 Reel videos') && !/Videos/.test(reports.pushBody(sum)));
  ok('reports asks feedvideo for the storage figures', /deps\.videos \|\| require\('\.\/feedvideo'\)\)\.usage\(\)/.test(read('reports.js')));

  // ================= 10. 🧽 Erase older reels =================
  await reset(); await turnR2On('');
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86400e3).toISOString();
  const made = {};
  async function makeReel(title, brand, daysAgo, sizeMb, hidden, views) {
    const f = mp4(Math.round(sizeMb * MB));
    const up = await upload(f);
    const sv = await feed.save({ title, brand, ctaService: brand, format: 'reel', videoId: up.id, active: true, publishAt: iso(daysAgo), hideAfter: hidden ? iso(daysAgo - 1) : '' });
    if (!sv.ok) throw new Error(title + ': ' + sv.message);
    made[title] = { post: sv.post, videoId: up.id, size: f.length };
    if (views) { for (let i = 0; i < views; i++) feed.record(sv.post.id, 'view', 'dev' + i); await feed.flushStats(); }
    return sv.post;
  }
  await makeReel('Old Netflix hidden', 'Netflix', 120, 4, true, 5);
  await makeReel('Old Prime hidden', 'Prime Video', 100, 6, true, 50);
  await makeReel('Old Netflix LIVE', 'Netflix', 110, 3, false, 2);
  await makeReel('New Netflix hidden', 'Netflix', 5, 2, true, 1);
  let pv = await erase.preview({ days: 90 }, { feed, video: vid });
  ok('counts: only posts older than 90 days AND hidden (the default) — the live one and the new one are safe',
    pv.ok && pv.counts.posts === 2 && pv.list.map((x) => x.title).sort().join(' | ') === 'Old Netflix hidden | Old Prime hidden' && pv.counts.bytes === made['Old Netflix hidden'].size + made['Old Prime hidden'].size, { n: pv.counts, list: pv.list.map((x) => x.title) });
  ok('the message says how much would go and what is left after', /2 reels · 10 MB would be erased/.test(pv.message) && /left after/.test(pv.message) && pv.store.afterBytes === pv.store.bytes - pv.counts.bytes, pv.message);
  ok('each row shows title, service, date, size and views', pv.list[0].title && pv.list[0].service && pv.list[0].date && pv.list[0].size > 0 && typeof pv.list[0].views === 'number' && pv.list[0].storage === 'r2', pv.list[0]);
  pv = await erase.preview({ days: 90, services: ['Netflix'] }, { feed, video: vid });
  ok('service filter: only Netflix', pv.counts.posts === 1 && pv.list[0].title === 'Old Netflix hidden', pv.list.map((x) => x.title));
  pv = await erase.preview({ days: 90, hiddenOnly: false }, { feed, video: vid });
  ok('"only hidden" off: the old LIVE reel is included too (3 posts)', pv.counts.posts === 3, pv.list.map((x) => x.title));
  pv = await erase.preview({ days: 200 }, { feed, video: vid });
  ok('older than 200 days: nothing matches', pv.counts.posts === 0 && /Nothing matches/.test(pv.message), pv.message);
  pv = await erase.preview({ days: 90, keepTop: 1 }, { feed, video: vid });
  ok('keep the top 1 most-watched: the 50-view Prime reel is kept, only the 5-view one goes', pv.counts.posts === 1 && pv.counts.kept === 1 && pv.list[0].title === 'Old Netflix hidden' && pv.kept[0].title === 'Old Prime hidden', { list: pv.list.map((x) => x.title), kept: pv.kept.map((x) => x.title) });
  ok('the services offered are the ones that really have reels', pv.services.join() === 'Netflix,Prime Video', pv.services);
  // erase the video only: the post survives without its reel
  const nfId = made['Old Netflix hidden'].post.id; const nfVid = made['Old Netflix hidden'].videoId;
  r = await erase.run({ days: 90, services: ['Netflix'], mode: 'video' }, { feed, video: vid });
  const after = (await feed.list()).find((p) => p.id === nfId);
  ok('erase video only: the video and the R2 object go, the post, its words and its picture stay',
    r.ok && r.erased === 1 && after && after.videoId === '' && after.format === 'post' && after.title === 'Old Netflix hidden' && !T.videos[nfVid] && !S3.objects['reels/' + nfVid + '.mp4'], { r: r.message, after: after && { videoId: after.videoId, format: after.format } });
  ok('the change-log summary says what happened in plain English', /Erased the video of 1 older reel \(4 MB freed, older than 90 days, Netflix, hidden posts only\)/.test(r.summary), r.summary);
  // delete the whole post
  const pmId = made['Old Prime hidden'].post.id;
  r = await erase.run({ days: 90, services: ['Prime Video'], mode: 'post' }, { feed, video: vid });
  ok('delete the whole post: post and video both gone', r.ok && r.erased === 1 && !(await feed.list()).some((p) => p.id === pmId) && !T.videos[made['Old Prime hidden'].videoId], r.message);
  // typed confirm over 10 posts
  for (let i = 0; i < 12; i++) await makeReel('Bulk ' + i, 'Netflix', 150 + i, 0.2, true, i);
  pv = await erase.preview({ days: 140 }, { feed, video: vid });
  ok('over 10 posts the preview asks for the typed word', pv.counts.posts === 12 && pv.needConfirm === true && pv.confirmWord === 'ERASE' && pv.confirmOver === 10, { n: pv.counts.posts, c: pv.needConfirm });
  r = await erase.run({ days: 140 }, { feed, video: vid });
  ok('…and erasing without typing ERASE is refused, nothing touched', !r.ok && r.needConfirm && /type ERASE to confirm/.test(r.message) && (await feed.list()).filter((p) => /^Bulk /.test(p.title)).length === 12, r.message);
  r = await erase.run({ days: 140, confirm: 'erase' }, { feed, video: vid });
  ok('typing ERASE (any case) lets it through', r.ok && r.erased === 12, r.message);
  r = await erase.run({ days: 999 }, { feed, video: vid });
  ok('nothing to erase → a plain "nothing was erased"', !r.ok && /nothing was erased/.test(r.message), r.message);
  // the same tool works when the bytes are in MySQL
  await reset();
  const dbReel = await upload(mp4(2 * MB));
  await feed.save({ title: 'Database reel', brand: 'Netflix', format: 'reel', videoId: dbReel.id, active: true, publishAt: iso(200), hideAfter: iso(199) });
  pv = await erase.preview({ days: 90 }, { feed, video: vid });
  ok('it works the same for videos still in the database', pv.counts.posts === 1 && pv.list[0].storage === 'db' && pv.store.mode === 'db', pv.list[0]);
  r = await erase.run({ days: 90 }, { feed, video: vid });
  ok('…and the MySQL chunks are freed', r.ok && r.erased === 1 && !Object.keys(T.chunks).length, r.message);

  // ================= 11. admin routes =================
  await reset();
  const express = require('express');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const AUDIT = [];
  const auth = (req, res) => { if (req.headers['x-admin-key'] === 'k') return true; res.status(403).json({ ok: false }); return false; };
  require('../adminfeed').mount(app, { db: mockDb, auth, audit: { record: (req, e) => AUDIT.push(e) } });
  const server = app.listen(0); await new Promise((x) => server.once('listening', x));
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' };
  const GET = async (p2) => { const x = await fetch(base + p2, { headers: H }); return { status: x.status, body: await x.json() }; };
  const POST = async (p2, b) => { const x = await fetch(base + p2, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }); return { status: x.status, body: await x.json() }; };
  let g = await fetch(base + '/admin/api/feed/video/storage');
  ok('the storage endpoints need the admin key', g.status === 403);
  g = await POST('/admin/api/feed/video/storage', { accountId: ACCOUNT, bucket: 'fluxfilm-reels', accessKeyId: AKID, secretAccessKey: SECRET });
  ok('admin can save the R2 settings, and the answer never contains a key', g.body.ok && !JSON.stringify(g.body).includes(SECRET) && !JSON.stringify(g.body).includes(AKID), g.body.changed);
  ok('the change log records only that a key was saved, never the key', AUDIT.some((e) => /Access Key ID saved/.test(e.summary)) && !JSON.stringify(AUDIT).includes(SECRET) && !JSON.stringify(AUDIT).includes(AKID));
  g = await GET('/admin/api/feed/video/storage');
  ok('GET storage: "set" flags only — no key anywhere in the answer', g.body.ok && g.body.r2.keySet === true && g.body.r2.secretSet === true && !JSON.stringify(g.body).includes(SECRET) && !JSON.stringify(g.body).includes(AKID), g.body.r2);
  g = await POST('/admin/api/feed/video/test', {});
  ok('🔌 Test connection from admin works and is written to the change log', g.body.ok && AUDIT.some((e) => e.action === 'feed.video.storage.test'), g.body.message);
  g = await POST('/admin/api/feed/video/storage', { on: true });
  ok('admin can switch the store to Cloudflare R2', g.body.ok && g.body.config.on === true, g.body.config);
  vid._internal.reset();
  const mreel = mp4(1.5 * MB); const mup = await upload(mreel);
  T.videos[mup.id].storage = 'db'; T.videos[mup.id].r2_key = null;
  for (let n = 0; n < T.videos[mup.id].chunks; n++) T.chunks[mup.id + '|' + n] = mreel.slice(n * MB, (n + 1) * MB);
  g = await POST('/admin/api/feed/video/migrate', {});
  ok('⬆️ admin move endpoint moves one video and logs it', g.body.ok && g.body.moved && T.videos[mup.id].storage === 'r2' && AUDIT.some((e) => e.action === 'feed.video.migrate'), g.body.message);
  await feed.save({ title: 'Panel reel', brand: 'Netflix', format: 'reel', videoId: mup.id, active: true, publishAt: iso(150), hideAfter: iso(149) });
  g = await POST('/admin/api/feed/erase/preview', { days: 90 });
  ok('🧽 preview endpoint answers counts and changes nothing', g.body.ok && g.body.counts.posts === 1 && T.videos[mup.id], g.body.counts);
  g = await POST('/admin/api/feed/erase', { days: 90, mode: 'video' });
  ok('🧽 erase endpoint erases and writes ONE change-log entry with the details', g.body.ok && g.body.erased === 1 && AUDIT.some((e) => e.action === 'feed.erase.videos' && /Panel reel/.test(e.summary) && e.details && e.details.criteria), AUDIT[AUDIT.length - 1]);
  const vsum = (await GET('/admin/api/feed')).body.video;
  ok('the posts screen gets the store, both bars, the warning and the move count', vsum && vsum.mode === 'r2' && vsum.db && vsum.r2 && 'warn' in vsum && vsum.migrate, vsum && { mode: vsum.mode, migrate: vsum.migrate });
  ok('…and never a key', !JSON.stringify(vsum).includes(SECRET) && !JSON.stringify(vsum).includes(AKID));
  server.close();

  // ================= 12. secrets are never printed =================
  ok('nothing logged in this whole run contains the Access Key ID or the Secret Access Key', !LOGS.join('\n').includes(SECRET) && !LOGS.join('\n').includes(AKID), LOGS.filter((l) => l.includes(SECRET) || l.includes(AKID)).slice(0, 2));
  ok('no SQL ever put a key in a statement (they go in as parameters inside one JSON value)', !T.sql.join(' ').includes(SECRET));

  // ================= 13. wiring + the pages still parse =================
  const af = read('adminfeed.js');
  ok('admin routes exist: storage GET + save, 🔌 test, ⬆️ migrate, 🧽 preview + erase — all behind auth',
    /app\.get\('\/admin\/api\/feed\/video\/storage'/.test(af) && /route\('\/admin\/api\/feed\/video\/storage'/.test(af) && /route\('\/admin\/api\/feed\/video\/test'/.test(af)
    && /route\('\/admin\/api\/feed\/video\/migrate'/.test(af) && /route\('\/admin\/api\/feed\/erase\/preview'/.test(af) && /route\('\/admin\/api\/feed\/erase'/.test(af)
    && /if \(!auth\(req, res\)\) return;/.test(af));
  ok('the R2 answer to the browser always goes through publicConfig (never the raw settings)', /r2\.publicConfig\(cfg\)/.test(af) && !/accessKeyId: cfg\./.test(af));
  const ad = read('admin.html');
  ok('admin ⚙️ Settings has the 🪣 Video storage box: Database / Cloudflare R2, the five fields, 🔌 Test connection',
    /🪣 Video storage — where Reel videos live/.test(ad) && /data-store="db"/.test(ad) && /data-store="r2"/.test(ad) && /id="fdr2acct"/.test(ad) && /id="fdr2bucket"/.test(ad) && /id="fdr2key"/.test(ad) && /id="fdr2secret"/.test(ad) && /id="fdr2pub"/.test(ad) && /🔌 Test connection/.test(ad));
  ok('admin shows "set" / "not set" for the keys and never a value in the input', /r\.keySet \? '✅ set' : 'not set'/.test(ad) && /r\.secretSet \? '✅ set' : 'not set'/.test(ad) && !/value="' \+ esc\(r\.accessKeyId/.test(ad));
  ok('admin has the exact Cloudflare steps (bucket, Object Read & Write token, Account ID, r2.dev, CORS)',
    /Create bucket/.test(ad) && /Manage R2 API Tokens/.test(ad) && /Object Read &amp; Write/.test(ad) && /Account ID/.test(ad) && /r2\.dev/.test(ad) && /CORS policy/.test(ad));
  ok('admin storage card: both bars, the R2 pill, the operation counts, ⬆️ move and 🧽 erase buttons',
    /<b>🎬 Videos: ' \+ fdMb\(v\.bytes\) \+ ' of ' \+ fdMb\(v\.totalBytes\) \+ ' used<\/b>/.test(ad) && /function fdBar\(label, box, inUse\)/.test(ad) && /🪣 Cloudflare R2/.test(ad)
    && /id="fdvidmig"/.test(ad) && /id="fderasebtn"/.test(ad) && /R2 this month: /.test(ad));
  ok('admin 75% banner: amber, says the figures, and its button opens 🧽 Erase older reels',
    /function fdVideoWarn\(\)/.test(ad) && /class="qnote warn" style="margin:0 0 12px" id="fdvidwarn"/.test(ad) && /erase older reels\?/.test(ad) && /var e2 = \$\('#fdvidwarnbtn'\); if \(e2\) e2\.onclick = fdErase;/.test(ad) && /p >= 75 \? '#f59e0b'/.test(ad));
  ok('admin 🧽 panel: days (30 / 60 / 90 / typed), services, only-hidden, keep top N, video-only vs whole post, live counts, typed confirm',
    /function fdErase\(\)/.test(ad) && /id="feday"/.test(ad) && /\[30, 60, 90\]\.map\(function \(d\) \{ return '<button type="button" class="btn sm ghost" data-eday="' \+ d/.test(ad) && /data-esvc=/.test(ad)
    && /id="fehid"/.test(ad) && /id="fekeep"/.test(ad) && /id="fekeepby"/.test(ad) && /Erase the video only — keep the post/.test(ad) && /Delete the whole post/.test(ad)
    && /function fePreview\(\)/.test(ad) && /id="feconfirm"/.test(ad) && /would be erased/.test(ad));
  let parseErr = '';
  for (const sc of [...ad.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]) { try { new Function(sc[1]); } catch (e) { parseErr = e.message; } }
  ok('admin.html inline scripts parse', !parseErr, parseErr);
  const html = read('index.html');
  parseErr = '';
  for (const sc of [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((x) => !/application\/(ld\+)?json/.test(x[0]))) { try { new Function(sc[1]); } catch (e) { parseErr = e.message; } }
  ok('index.html inline scripts parse', !parseErr, parseErr);
  const fn = (name) => { const i = html.indexOf('function ' + name + '('); const j = html.indexOf('\n}\n', i); return html.slice(i, j + 2); };
  const V = new Function(fn('feedVideoSrc_') + '; return feedVideoSrc_;')();
  ok('the storefront plays our /v/<id>.mp4 and a Cloudflare R2 public link, and nothing else',
    V({ video: '/v/fv0123456789abcdef.mp4' }) === '/v/fv0123456789abcdef.mp4'
    && V({ video: 'https://pub-abc.r2.dev/reels/fv0123456789abcdef.mp4' }) === 'https://pub-abc.r2.dev/reels/fv0123456789abcdef.mp4'
    && V({ video: 'https://videos.fluxfilm.in/reels/fv0123456789abcdef.webm' }) === 'https://videos.fluxfilm.in/reels/fv0123456789abcdef.webm'
    && V({ video: 'https://evil.example/x.mp4' }) === '' && V({ video: 'http://pub-abc.r2.dev/reels/fv0123456789abcdef.mp4' }) === ''
    && V({ video: 'https://pub-abc.r2.dev/reels/fv0123456789abcdef.mp4?x=1' }) === '' && V({}) === '',
    [V({ video: 'https://pub-abc.r2.dev/reels/fv0123456789abcdef.mp4' }), V({ video: 'https://evil.example/x.mp4' })]);
  ok('the feed asks feedvideo where each video plays from', /video\(\)\.urls\(live\.map/.test(read('feed.js')));
  ok('npm test runs this suite', /node test\/r2-video-storage\.test\.js/.test(require('../package.json').scripts.test));

  console.log = realLog;
  say('\n---------------------------------------');
  say('r2-video-storage: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log = realLog; console.error('THREW', e); process.exitCode = 1; });
