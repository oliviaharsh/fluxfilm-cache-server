/**
 * FluxFilm - reach TMDB from the server even where Indian networks block it.
 *
 * The shop runs in Hostinger Mumbai. TMDB (api.themoviedb.org / image.tmdb.org) is blocked by several Indian
 * networks at the DNS level, so the feed import said "Could not reach TMDB". This helper:
 *   1. connects with the normal DNS first;
 *   2. if that fails (no address, a block-page address like 0.0.0.0 / 127.x, connection reset, TLS error)
 *      it looks the name up again through public DNS (Cloudflare / Google / Quad9) and retries;
 * TLS still checks TMDB's real certificate (servername = the real host), so a wrong address can't pretend to be TMDB.
 * getBuffer(url, { headers, timeoutMs, maxBytes }) → { status, headers, body } — throws Error with a short .reason.
 */
const https = require('https');
const dns = require('dns');

const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
let resolver = null;
function publicResolver() {
  if (!resolver) { resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 }); resolver.setServers(PUBLIC_DNS); }
  return resolver;
}
// Addresses a blocking DNS hands out instead of the real one.
const bogus = (ip) => !ip || /^(0\.|127\.|10\.|192\.168\.|169\.254\.|::1$|::$)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

function lookupWith(usePublic) {
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const done = (addr) => (opts && opts.all ? cb(null, [{ address: addr, family: 4 }]) : cb(null, addr, 4));
    const viaPublic = (firstErr) => publicResolver().resolve4(host)
      .then((list) => { const a = (list || []).find((x) => !bogus(x)); if (!a) throw new Error('no address'); done(a); })
      .catch((e) => { const err = firstErr || e; err.code = err.code || 'ENOTFOUND'; cb(err); });
    if (usePublic) return viaPublic(null);
    dns.lookup(host, { family: 4 }, (err, addr) => {
      if (err || bogus(addr)) { const e = err || Object.assign(new Error('blocked address ' + addr), { code: 'EBLOCKED' }); return cb(e); }
      done(addr);
    });
  };
}

function once(url, opts, usePublic) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
    const req = https.request({
      protocol: 'https:', hostname: u.hostname, servername: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'FluxFilm-shop/1.0' }, opts.headers || {}), lookup: lookupWith(usePublic),
      timeout: opts.timeoutMs || 8000,
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(Object.assign(new Error('too big'), { code: 'ETOOBIG' })); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const reasonOf = (e) => String((e && (e.code || e.message)) || 'error').slice(0, 40);

async function getBuffer(url, opts) {
  opts = opts || {};
  try { return await once(url, opts, false); }
  catch (e1) {
    if (e1 && e1.code === 'ETOOBIG') throw e1;
    try { return await once(url, opts, true); }
    catch (e2) {
      const err = new Error('Could not reach ' + new URL(url).hostname);
      err.reason = reasonOf(e1) + (reasonOf(e2) !== reasonOf(e1) ? ' / public DNS: ' + reasonOf(e2) : '');
      throw err;
    }
  }
}

/** fetch-like wrapper used by feed.js: { status, ok, json() }. */
async function fetchJson(url, opts) {
  const r = await getBuffer(url, { headers: opts && opts.headers, timeoutMs: 8000, maxBytes: 3 * 1024 * 1024 });
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => JSON.parse(r.body.toString('utf8')) };
}

module.exports = { getBuffer, fetchJson, _internal: { bogus, lookupWith } };
