/**
 * FluxFilm - 📸 Instagram Reel thumbnail + caption, fetched by the SERVER (customers never load Instagram before a tap).
 *
 * instagramInfo(permalink, { metaToken, http, budgetMs }) → { imageUrl, caption, source, reason }
 *   1. Meta Graph oEmbed  https://graph.facebook.com/v19.0/instagram_oembed?url=…&access_token=…   (only with a Meta token
 *      saved in admin → 🍿 What's new → ⚙️ Settings; the token never leaves the server). Gives `title` (the caption) and,
 *      where Meta still returns it, `thumbnail_url`.
 *   2. Instagram's public embed page  https://www.instagram.com/<reel|p>/<code>/embed/captioned/  → the cover picture
 *      (EmbeddedMediaImage) and the caption.
 *   3. The public post page (link-preview crawler) → og:image + og:description.
 *   Any step may be blocked (login wall, rate limit, redirect) → the next one; nothing found = { reason }.
 * downloadImage(url, { http }) → { ok, type, buf } — only https pictures from Instagram's / Facebook's CDNs, ≤ 330 KB, real
 * JPEG / PNG / WebP bytes. The whole job has a time budget (default 12 s) so saving a post never hangs.
 *
 * http(url, { headers, timeoutMs, maxBytes }) → { status, headers, body: Buffer } — default tmdbnet.getBuffer (public-DNS
 * retry when a network blocks the name; redirects are NOT followed, so a login redirect counts as blocked).
 */
const GRAPH = 'https://graph.facebook.com/v19.0/instagram_oembed';
const MAX_IMG = 330 * 1024;
// A plain (non-Chrome) agent gets the simple embed HTML with the cover picture; a Chrome agent gets a script-only page.
const BROWSER_UA = 'Mozilla/5.0 (compatible; FluxFilm-shop/1.0; +https://shop.fluxfilm.in)';
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const s = (v) => String(v == null ? '' : v).trim();
const defaultHttp = (url, opts) => require('./tmdbnet').getBuffer(url, opts);

function decodeEntities(v) {
  return s(v).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'"; if (k === 'nbsp') return ' ';
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
/** Only Instagram's / Facebook's picture CDNs (not an open fetcher). */
function imageHostOk(url) {
  let u; try { u = new URL(s(url)); } catch (_) { return false; }
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && (/(^|\.)cdninstagram\.com$/.test(u.hostname) || /(^|\.)fbcdn\.net$/.test(u.hostname));
}
function htmlToText(h) {
  return decodeEntities(s(h).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Embed page → { imageUrl, caption }. */
function parseEmbed(html) {
  const h = String(html || '');
  let imageUrl = '';
  const tag = h.match(/<img[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>/i);
  if (tag) { const m = tag[0].match(/\ssrc="([^"]+)"/i); if (m) imageUrl = decodeEntities(m[1]); }
  let caption = '';
  const at = h.search(/<div class="Caption"[^>]*>/i);
  if (at >= 0) {
    let part = h.slice(at).replace(/^<div class="Caption"[^>]*>/i, '');
    const end = part.search(/<div class="CaptionComments"|<\/div>/i);
    if (end >= 0) part = part.slice(0, end);
    part = part.replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/i, '');
    caption = htmlToText(part);
  }
  return { imageUrl: imageHostOk(imageUrl) ? imageUrl : '', caption };
}
/** Post page (link-preview HTML) → { imageUrl, caption } from og:image / og:description. */
function parsePage(html) {
  const h = String(html || '');
  const meta = (prop) => { const m = h.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', 'i')) || h.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + prop + '"', 'i')); return m ? decodeEntities(m[1]) : ''; };
  const imageUrl = meta('og:image');
  // "1,234 likes, 56 comments - user on September 1, 2026: "the caption"." / "User on Instagram: "the caption""
  const d = meta('og:description') || meta('description') || meta('og:title');
  const q = d.match(/:\s*["“]([\s\S]+)["”]\s*\.?\s*$/);
  return { imageUrl: imageHostOk(imageUrl) ? imageUrl : '', caption: q ? q[1].trim() : '' };
}

async function instagramInfo(permalink, opts) {
  const o = opts || {};
  const http = o.http || defaultHttp;
  const end = Date.now() + (o.budgetMs || 12000);
  const left = () => end - Date.now();
  const m = s(permalink).match(/^https:\/\/www\.instagram\.com\/(reel|p)\/([A-Za-z0-9_-]{5,40})\/$/);
  if (!m) return { imageUrl: '', caption: '', source: '', reason: 'not an Instagram link' };
  const out = { imageUrl: '', caption: '', source: '', reason: '' };
  const reasons = [];
  const get = async (url, headers, label) => {
    if (left() < 800) { reasons.push(label + ': no time'); return null; }
    try {
      const r = await http(url, { headers, timeoutMs: Math.min(6000, left()), maxBytes: 3 * 1024 * 1024 });
      if (!r || r.status !== 200) { reasons.push(label + ': ' + (r ? 'HTTP ' + r.status : 'no answer')); return null; }
      return r;
    } catch (e) { reasons.push(label + ': ' + String((e && (e.reason || e.code || e.message)) || 'error').slice(0, 40)); return null; }
  };
  out.images = [];
  const take = (x, source) => {
    if (x.imageUrl && !out.images.some((c) => c.url === x.imageUrl)) out.images.push({ url: x.imageUrl, source });
    if (x.imageUrl && !out.imageUrl) { out.imageUrl = x.imageUrl; out.source = source; }
    if (x.caption && !out.caption) out.caption = x.caption;
  };
  if (s(o.metaToken)) {
    const u = GRAPH + '?url=' + encodeURIComponent(permalink) + '&access_token=' + encodeURIComponent(s(o.metaToken));
    const r = await get(u, { Accept: 'application/json' }, 'oEmbed');
    if (r) {
      try {
        const j = JSON.parse(r.body.toString('utf8'));
        take({ imageUrl: imageHostOk(j.thumbnail_url) ? s(j.thumbnail_url) : '', caption: s(j.title) }, 'oembed');
        if (!j.thumbnail_url) reasons.push('oEmbed: no thumbnail');
      } catch (_) { reasons.push('oEmbed: bad answer'); }
    }
  }
  if (!out.imageUrl || !out.caption) {
    const r = await get(permalink + 'embed/captioned/', { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' }, 'embed');
    if (r) { const x = parseEmbed(r.body.toString('utf8')); take(x, 'embed'); if (!x.imageUrl) reasons.push('embed: no picture'); }
  }
  // The post page's preview picture is small (about 360×640, ~25 KB): asked for too, unless oEmbed already gave one.
  if (!out.images.some((c) => c.source === 'oembed')) {
    const r = await get(permalink, { 'User-Agent': CRAWLER_UA, Accept: 'text/html' }, 'page');
    if (r) { const x = parsePage(r.body.toString('utf8')); take(x, 'page'); if (!x.imageUrl) reasons.push('page: no picture'); }
  }
  // Smallest first: oEmbed thumbnail, page preview, then the embed's full-size cover.
  const rank = { oembed: 0, page: 1, embed: 2 };
  out.images.sort((a, b) => rank[a.source] - rank[b.source]);
  if (out.images.length) { out.imageUrl = out.images[0].url; out.source = out.images[0].source; }
  else out.reason = reasons.join('; ').slice(0, 200) || 'blocked';
  return out;
}

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}
async function downloadImage(url, opts) {
  const o = opts || {};
  if (!imageHostOk(url)) return { ok: false, reason: 'picture host not allowed' };
  const http = o.http || defaultHttp;
  let r;
  try { r = await http(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'image/jpeg,image/webp,image/png' }, timeoutMs: 8000, maxBytes: MAX_IMG }); }
  catch (e) { return { ok: false, reason: e && e.code === 'ETOOBIG' ? 'picture too big' : 'picture download failed' }; }
  if (!r || r.status !== 200) return { ok: false, reason: 'picture HTTP ' + (r ? r.status : '?') };
  const type = sniff(r.body);
  if (!type) return { ok: false, reason: 'not a picture' };
  if (r.body.length > MAX_IMG) return { ok: false, reason: 'picture too big' };
  return { ok: true, type, buf: r.body };
}

module.exports = { instagramInfo, downloadImage, parseEmbed, parsePage, imageHostOk, decodeEntities, MAX_IMG, GRAPH };
