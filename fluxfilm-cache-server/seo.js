/**
 * FluxFilm - SEO: search engines and link previews (WhatsApp, Instagram, Google) see real content without JavaScript.
 *
 *   index head      decorateIndex(html): live "from ₹X" description + JSON-LD (Organization, WebSite, plan catalog)
 *   GET /plans                 all services with live prices + stock          (server-rendered HTML)
 *   GET /plans/:slug           one service: plan cards, benefits, FAQs, "Buy on FluxFilm" → /?buy=<slug>
 *   GET /faq                   general questions + FAQPage JSON-LD
 *   GET /whats-new             live feed posts → /?post=<id>
 *   GET /about                 short brand page
 *   GET /robots.txt, /sitemap.xml, /og-image.png (1200×630 link-preview picture)
 *
 * Everything shown comes from MySQL (catalog.getBootstrap / getStockLevels, feed.publicList), cached 5 minutes.
 * All database text is HTML-escaped; JSON-LD is escaped so it can never close its <script> tag.
 * No request input is ever printed: unknown service slugs 301 to /plans.
 */
const fs = require('fs');
const path = require('path');

const SITE = 'https://shop.fluxfilm.in';
const BRAND = 'FluxFilm';
const OG_IMAGE = SITE + '/og-image.png?v=1';
const OG_FILE = path.join(__dirname, 'og-image.png');
const CACHE_MS = 5 * 60e3;
const PAGE_CACHE = 'public, max-age=300';
const STARTED = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // deploy date (India) = lastmod of the static pages

// ---------- helpers ----------
function s(v) { return String(v == null ? '' : v).trim(); }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** JSON for a <script type="application/ld+json"> block: "<" never appears raw, so "</script>" can't end it early. */
function ldJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function inr(n) { const v = Math.round(Number(n) || 0); return '₹' + v.toLocaleString('en-IN'); }
/** Plain text without emoji / symbols at the start ("📅1 Month" → "1 Month"). */
function clean(v) { return s(v).replace(/^[^\p{L}\p{N}₹(]+/u, '').replace(/\s+/g, ' ').trim(); }

// Same rule as ffServiceSlug_ in index.html (test/seo.test.js checks they agree).
const SLUG_ALIAS = { 'sonyliv-premium': 'sonyliv', 'zee5-premium': 'zee5' };
function serviceSlug(name) {
  const x = String(name || '').toLowerCase().replace(/\+/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return SLUG_ALIAS[x] || x;
}
// Old / guessed addresses → the real page (only used when that page exists).
const OLD_SLUGS = {
  'amazon-prime': 'prime-video', 'amazon-prime-video': 'prime-video', prime: 'prime-video', primevideo: 'prime-video',
  hotstar: 'jiohotstar', 'jio-hotstar': 'jiohotstar', 'disney-hotstar': 'jiohotstar', 'disney-plus-hotstar': 'jiohotstar',
  'sony-liv': 'sonyliv', 'zee-5': 'zee5', youtube: 'youtube-premium', 'youtube-music': 'youtube-premium',
  'netflix-group': 'netflix-group-offer', 'netflix-sharing': 'netflix', 'netflix-private': 'netflix',
};

function durationLabel(days) {
  const d = Number(days) || 0;
  if (d >= 360 && d <= 370) return '1 year';
  const m = Math.round(d / 30);
  if (d >= 28 && Math.abs(d - m * 30) <= 3) return m + (m === 1 ? ' month' : ' months');
  return d + (d === 1 ? ' day' : ' days');
}
function monthly(p) { const d = Number(p.durationDays) || 30; return Math.round((Number(p.price) || 0) / Math.max(1, d / 30)); }
function devicesOf(p) {
  const m = s(p.plan).match(/(\d+)\s*devices?/i) || (p.benefits || []).join(' ').match(/(\d+)\s*devices?/i);
  return m ? Number(m[1]) : 1;
}
function typeOf(p) {
  const t = (s(p.plan) + ' ' + (p.benefits || []).join(' ')).toLowerCase();
  if (/sharing/.test(t)) return 'Sharing';
  if (/private/.test(t)) return 'Private';
  return '';
}

// ---------- data (cached 5 min; a DB error keeps the last good copy) ----------
let catalogMod = null;
let feedMod = null;
function mods() {
  if (!catalogMod) { try { catalogMod = require('./catalog'); } catch (_) { catalogMod = false; } }
  if (feedMod === null) { try { feedMod = require('./feed'); } catch (_) { feedMod = false; } }
}
const store = { catalog: null, catalogAt: 0, catalogP: null, feed: null, feedAt: 0, feedP: null };

async function loadCatalog() {
  mods();
  if (!catalogMod) return { plans: [], levels: {} };
  const boot = await catalogMod.getBootstrap();
  let levels = {};
  try { const st = await catalogMod.getStockLevels(); levels = (st && st.levels) || {}; } catch (_) {}
  return { plans: boot && boot.ok ? boot.plans || [] : [], levels };
}
/** { plans, levels }. wait=false: answer at once from cache (refresh in the background); first call waits up to waitMs. */
async function catalogData(opts) {
  const o = opts || {};
  const fresh = store.catalog && Date.now() - store.catalogAt < CACHE_MS;
  if (fresh) return store.catalog;
  if (!store.catalogP) {
    store.catalogP = loadCatalog().then((v) => { if (v.plans.length) { store.catalog = v; store.catalogAt = Date.now(); } else if (!store.catalog) store.catalog = v; return store.catalog; })
      .catch(() => store.catalog || { plans: [], levels: {} })
      .finally(() => { store.catalogP = null; });
  }
  if (store.catalog && o.wait === false) return store.catalog;
  if (o.waitMs) return Promise.race([store.catalogP, new Promise((r) => setTimeout(() => r(store.catalog || { plans: [], levels: {} }), o.waitMs))]);
  return store.catalogP;
}
async function feedData() {
  if (store.feed && Date.now() - store.feedAt < CACHE_MS) return store.feed;
  mods();
  if (!feedMod) return { posts: [] };
  try { const r = await feedMod.publicList(); store.feed = { posts: (r && r.posts) || [] }; store.feedAt = Date.now(); }
  catch (_) { if (!store.feed) return { posts: [] }; }
  return store.feed;
}
function clearCache() { store.catalog = null; store.catalogAt = 0; store.feed = null; store.feedAt = 0; }

/** Catalog → services: [{ name, slug, plans (sorted), minPrice, minMonthly, level, logoUrl, manual, otp, groupJoin, deviceRule }] */
function servicesOf(data) {
  const plans = (data && data.plans) || [];
  const levels = (data && data.levels) || {};
  const by = new Map();
  for (const p of plans) {
    const name = s(p.service);
    if (!name || !(Number(p.price) > 0)) continue;
    if (!by.has(name)) by.set(name, []);
    const lv = levels[name + '|||' + s(p.plan)];
    by.get(name).push(Object.assign({}, p, { stockLevel: lv ? s(lv.stockLevel).toUpperCase() : 'OK' }));
  }
  const out = [];
  for (const [name, list] of by) {
    list.sort((a, b) => devicesOf(a) - devicesOf(b) || typeOf(b).localeCompare(typeOf(a)) || a.durationDays - b.durationDays || a.price - b.price);
    const inStock = list.filter((p) => p.stockLevel !== 'OUT');
    const cheapest = list.reduce((a, b) => (b.price < a.price ? b : a));
    out.push({
      name, slug: serviceSlug(name), plans: list,
      minPrice: cheapest.price, minMonthly: Math.min(...list.map(monthly)),
      level: !inStock.length ? 'OUT' : inStock.some((p) => p.stockLevel === 'OK') ? 'OK' : 'LOW',
      logoUrl: (list.map((p) => s(p.logoUrl)).find((u) => /^https:\/\/[^\s"'<>]+$/i.test(u)) || ''),
      manual: list.every((p) => s(p.fulfillmentMode).toUpperCase() === 'MANUAL'),
      otp: list.some((p) => s(p.allocationPolicy).toUpperCase() === 'OTP_ACCOUNT'),
      groupJoin: list.some((p) => p.requiresGroupJoin),
      hasSharing: list.some((p) => typeOf(p) === 'Sharing'),
      hasPrivate: list.some((p) => typeOf(p) === 'Private'),
      deviceRule: [...new Set(list.map((p) => s(p.deviceRuleText).split(/\r?\n/)[0].trim()).filter(Boolean))].slice(0, 2).join(' '),
    });
  }
  // Popular first, the rest by name.
  const ORDER = ['netflix', 'prime-video', 'jiohotstar', 'sonyliv', 'zee5', 'crunchyroll', 'youtube-premium', 'netflix-group-offer', 'prime-video-shopping'];
  const rank = (x) => { const i = ORDER.indexOf(x.slug); return i < 0 ? 99 : i; };
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
function cheapestPrice(services) { return services.length ? Math.min(...services.map((x) => x.minPrice)) : 0; }

// ---------- shared JSON-LD ----------
function orgLd() {
  return { '@type': 'Organization', '@id': SITE + '/#org', name: BRAND, url: SITE + '/', logo: SITE + '/icons/icon-512.png', image: OG_IMAGE, areaServed: 'IN' };
}
function websiteLd() {
  return { '@type': 'WebSite', '@id': SITE + '/#website', name: BRAND, url: SITE + '/', inLanguage: 'en-IN', publisher: { '@id': SITE + '/#org' } };
}
function offerLd(p, url) {
  return {
    '@type': 'Offer', name: p.service + ' ' + p.plan + ' (' + durationLabel(p.durationDays) + ')',
    price: String(Math.round(Number(p.price) || 0)), priceCurrency: 'INR', url,
    availability: p.stockLevel === 'OUT' ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
    seller: { '@id': SITE + '/#org' },
    itemOffered: { '@type': 'Service', name: 'Subscription plan for ' + p.service + ' — ' + p.plan, provider: { '@id': SITE + '/#org' } },
  };
}
function catalogLd(services, name) {
  return {
    '@type': 'OfferCatalog', '@id': SITE + '/plans#catalog', name: name || 'FluxFilm subscription plans', url: SITE + '/plans',
    itemListElement: services.map((x) => ({ '@type': 'OfferCatalog', name: x.name + ' plans', url: SITE + '/plans/' + x.slug, itemListElement: x.plans.map((p) => offerLd(p, SITE + '/plans/' + x.slug)) })),
  };
}
function graph(items) { return { '@context': 'https://schema.org', '@graph': items }; }
function breadcrumbLd(trail) {
  return { '@type': 'BreadcrumbList', itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t[0], item: SITE + t[1] })) };
}

// ---------- storefront head ----------
function indexDescription(services) {
  const low = cheapestPrice(services);
  const names = services.map((x) => x.name).filter((n) => !/group offer|shopping/i.test(n)).slice(0, 5).join(', ').replace(/ Premium/g, '');
  const from = low ? ' from ' + inr(low) : '';
  let d = 'Buy ' + (names || 'Netflix, Prime Video, JioHotstar') + ' plans' + from + '. Pay by UPI and get your login instantly. India\'s easy subscription store.';
  if (d.length > 160) d = 'Buy Netflix, Prime Video, JioHotstar & more' + from + '. Pay by UPI, get your login instantly on FluxFilm.';
  return d;
}
/** The storefront page with a live description and JSON-LD. Never slow: uses the 5-min cache (first call waits ≤1.2 s). */
async function decorateIndex(html) {
  let data;
  try { data = await catalogData({ wait: false, waitMs: 1200 }); } catch (_) { data = null; }
  const services = servicesOf(data);
  if (!services.length) return html;
  const desc = esc(indexDescription(services));
  let out = String(html)
    .replace(/(<meta name="description" content=")[^"]*(")/, '$1' + desc + '$2')
    .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + desc + '$2')
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, '$1' + desc + '$2');
  const ld = '<script type="application/ld+json">' + ldJson(graph([orgLd(), websiteLd(), catalogLd(services)])) + '</script>\n';
  const at = out.indexOf('</head>');
  if (at > 0) out = out.slice(0, at) + ld + out.slice(at);
  return out;
}

// ---------- page layout ----------
const CSS = `*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f5f7fb;color:#0f172a;line-height:1.55;font-size:16px}
a{color:#15803d}img{max-width:100%;height:auto}.w{max-width:960px;margin:0 auto;padding:0 16px}
.top{background:#04140e;color:#fff}.top .w{display:flex;align-items:center;gap:6px 12px;min-height:60px;flex-wrap:wrap;padding-top:6px;padding-bottom:6px}
.brand{display:flex;align-items:center;gap:9px;color:#fff;text-decoration:none;font-weight:800;font-size:19px}.brand img{width:32px;height:32px;border-radius:8px}
.nav{display:flex;gap:2px;margin-left:auto;flex-wrap:nowrap;overflow-x:auto;max-width:100%}.nav a{color:#bbf7d0;text-decoration:none;font-weight:700;font-size:14px;padding:10px 9px;border-radius:10px;white-space:nowrap}
@media (max-width:600px){.nav{margin-left:-9px;width:calc(100% + 9px)}.nav a.app{display:none}}.nav a:hover,.nav a[aria-current]{background:rgba(255,255,255,.08);color:#fff}
.hero{background:linear-gradient(160deg,#0a2a1e,#04140e);color:#fff;padding:34px 0 30px}.hero h1{font-size:clamp(26px,5.5vw,40px);line-height:1.15;margin:0 0 10px}.hero p{color:#c7e9d9;margin:0 0 18px;max-width:680px;font-size:17px}
.crumbs{font-size:13px;color:#86efac;margin-bottom:10px}.crumbs a{color:#86efac}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:14px 26px;border-radius:16px;background:#22c55e;color:#04140e;font-weight:800;font-size:17px;text-decoration:none;box-shadow:0 8px 24px rgba(34,197,94,.3)}.btn:hover{background:#4ade80}
.btn.ghost{background:transparent;color:#15803d;border:2px solid #16a34a;box-shadow:none}
main{padding:24px 0 40px}h2{font-size:22px;margin:30px 0 12px;line-height:1.25}h3{font-size:17px;margin:0 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;padding:16px;box-shadow:0 2px 10px rgba(15,23,42,.05)}
a.card{display:block;color:inherit;text-decoration:none}a.card:hover{border-color:rgba(22,163,74,.35)}
.svc{display:flex;align-items:center;gap:12px;margin-bottom:8px}.svc img{width:48px;height:48px;object-fit:contain;border-radius:12px;background:#f1f5f9;flex-shrink:0}
.price{font-size:22px;font-weight:800;color:#15803d}.muted{color:#64748b;font-size:14px}
.badge{display:inline-block;font-size:12px;font-weight:800;padding:3px 9px;border-radius:999px;background:#dcfce7;color:#166534;vertical-align:middle}.badge.low{background:#fef3c7;color:#92400e}.badge.out{background:#fee2e2;color:#991b1b}
.grid.plans{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}.plan{padding:14px 16px}.plan .ph{display:flex;justify-content:space-between;align-items:center;gap:8px}.plan h3{margin:0}.plan .price{margin:4px 0 2px}
ul.ticks{padding:0;list-style:none;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}ul.ticks li{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:10px 12px}ul.ticks li::before{content:"✓ ";color:#16a34a;font-weight:800}
ol.steps{padding-left:22px;margin:0}ol.steps li{margin:6px 0}
details{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:0 16px;margin:10px 0}summary{cursor:pointer;font-weight:700;padding:14px 0;min-height:48px}details p{margin:0 0 14px;color:#334155}
.post{display:flex;gap:14px;align-items:flex-start}.post img{width:92px;height:138px;object-fit:cover;border-radius:12px;background:#e2e8f0;flex-shrink:0}.post p{margin:6px 0;color:#334155;font-size:15px}
.cta{margin:30px 0 0;text-align:center;background:#04140e;color:#fff;border-radius:22px;padding:26px 18px}.cta p{color:#c7e9d9;margin:0 0 16px}
footer{background:#04140e;color:#9fbfb1;padding:26px 0 36px;font-size:14px}footer a{color:#d1fae5;text-decoration:none}footer .links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:14px}footer p{margin:6px 0}`;

function layout(o) {
  const url = SITE + o.path;
  const navLink = (href, label) => '<a href="' + href + '"' + (o.path === href ? ' aria-current="page"' : '') + '>' + label + '</a>';
  const footServices = (o.services || []).map((x) => '<a href="/plans/' + x.slug + '">' + esc(x.name) + '</a>').join('');
  return '<!doctype html>\n<html lang="en-IN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(o.title) + '</title>\n' +
    '<meta name="description" content="' + esc(o.description) + '">\n' +
    '<meta name="robots" content="index, follow, max-image-preview:large">\n' +
    '<link rel="canonical" href="' + url + '">\n' +
    '<link rel="alternate" hreflang="en-IN" href="' + url + '">\n' +
    '<meta name="theme-color" content="#04140e">\n' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">\n<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">\n<link rel="manifest" href="/manifest.webmanifest">\n' +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="' + BRAND + '">\n<meta property="og:locale" content="en_IN">\n' +
    '<meta property="og:title" content="' + esc(o.title) + '">\n<meta property="og:description" content="' + esc(o.description) + '">\n' +
    '<meta property="og:url" content="' + url + '">\n<meta property="og:image" content="' + OG_IMAGE + '">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:image:alt" content="FluxFilm — streaming subscription plans at low prices">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="' + esc(o.title) + '">\n<meta name="twitter:description" content="' + esc(o.description) + '">\n<meta name="twitter:image" content="' + OG_IMAGE + '">\n' +
    '<script type="application/ld+json">' + ldJson(graph([orgLd(), websiteLd()].concat(o.ld || []))) + '</script>\n' +
    '<style>' + CSS + '</style>\n</head>\n<body>\n' +
    '<header class="top"><div class="w"><a class="brand" href="/"><img src="/icons/logo.svg" alt="" width="32" height="32">FluxFilm</a>' +
    '<nav class="nav" aria-label="Main">' + navLink('/plans', 'Plans &amp; prices') + navLink('/faq', 'FAQ') + navLink('/whats-new', 'What\'s new') + '<a class="app" href="/">Open app</a></nav></div></header>\n' +
    '<section class="hero"><div class="w">' + (o.crumbs ? '<div class="crumbs">' + o.crumbs + '</div>' : '') + '<h1>' + esc(o.h1) + '</h1>' + (o.lead ? '<p>' + esc(o.lead) + '</p>' : '') +
    (o.cta ? '<a class="btn" href="' + o.cta[0] + '">' + esc(o.cta[1]) + '</a>' : '') + '</div></section>\n' +
    '<main><div class="w">' + o.body + '</div></main>\n' +
    '<footer><div class="w"><div class="links"><a href="/plans">All plans &amp; prices</a>' + footServices + '<a href="/faq">FAQ</a><a href="/whats-new">What\'s new</a><a href="/about">About</a></div>' +
    '<p>FluxFilm is an independent Indian store for streaming subscription plans. We are not the official Netflix, Amazon, JioHotstar, Sony, ZEE, Crunchyroll or YouTube website, and not affiliated with them. Brand names belong to their owners.</p>' +
    '<p>Prices in Indian rupees (₹). © ' + new Date().getFullYear() + ' FluxFilm · <a href="https://shop.fluxfilm.in/">shop.fluxfilm.in</a></p></div></footer>\n</body>\n</html>\n';
}

function badge(level) {
  if (level === 'OUT') return '<span class="badge out">Out of stock</span>';
  if (level === 'LOW') return '<span class="badge low">Few left</span>';
  return '<span class="badge">In stock</span>';
}
function logo(x) { return x.logoUrl ? '<img src="' + esc(x.logoUrl) + '" alt="" width="48" height="48" loading="lazy" referrerpolicy="no-referrer">' : ''; }
function faqHtml(list) { return list.map((q) => '<details><summary>' + esc(q[0]) + '</summary><p>' + esc(q[1]) + '</p></details>').join(''); }
const HOW_STEPS = [
  'Pick a plan on FluxFilm and enter your phone number and email.',
  'Pay the exact amount with any UPI app (Google Pay, PhonePe, Paytm, BHIM and others).',
  'Your payment is checked automatically — usually within a minute or two.',
  'Your login details appear on screen right away, and a copy is sent to your email.',
];
function howHtml() { return '<h2>How delivery works</h2><div class="card"><ol class="steps">' + HOW_STEPS.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol></div>'; }

// ---------- pages ----------
async function plansPage() {
  const services = servicesOf(await catalogData({ waitMs: 4000 }));
  if (!services.length) return null; // DB down: 503, never a cached / indexed empty page
  const low = cheapestPrice(services);
  const cards = services.map((x) => '<a class="card" href="/plans/' + x.slug + '"><div class="svc">' + logo(x) + '<div><h3>' + esc(x.name) + '</h3>' + badge(x.level) + '</div></div>' +
    '<div class="price">from ' + inr(x.minPrice) + '</div><div class="muted">' + x.plans.length + ' plan' + (x.plans.length === 1 ? '' : 's') + ' · about ' + inr(x.minMonthly) + '/month on longer plans' + (x.manual ? ' · activated on your email' : ' · instant login') + '</div></a>').join('');
  const body = '<h2>Choose a service</h2><div class="grid">' + cards + '</div>' +
    howHtml() +
    '<h2>Sharing or private?</h2><div class="card"><p><b>Sharing</b> plans are the lowest price: you use a shared profile. <b>Private</b> plans give you your own profile that only you use (and on some services you can lock it with a PIN). Each plan lists how many devices you can use.</p></div>' +
    '<div class="cta"><h2 style="margin-top:0">Ready to watch?</h2><p>Pay by UPI and get your login in minutes.</p><a class="btn" href="/?buy=all">Buy on FluxFilm</a></div>';
  return layout({
    path: '/plans', services,
    title: 'Netflix, Prime Video & JioHotstar Plans & Prices | FluxFilm',
    description: 'Today\'s FluxFilm prices for Netflix, Prime Video, JioHotstar, SonyLiv, Zee5, Crunchyroll & YouTube Premium' + (low ? ' — from ' + inr(low) : '') + '. UPI payment, instant login.',
    h1: 'Subscription plans & prices', lead: 'Live prices for every streaming plan on FluxFilm' + (low ? ', starting at ' + inr(low) : '') + '. Pay by UPI, get your login instantly.',
    cta: ['/?buy=all', 'Buy on FluxFilm'], crumbs: '<a href="/">Home</a> › Plans',
    ld: [catalogLd(services), breadcrumbLd([['Home', '/'], ['Plans', '/plans']])], body,
  });
}

function serviceFaqs(x) {
  const q = [];
  q.push(['How fast do I get my ' + x.name + ' login?', x.manual
    ? 'This plan is activated by our team on the email address you give at checkout. We start as soon as your UPI payment is confirmed and send updates by WhatsApp or email.'
    : 'Right after your UPI payment is confirmed — usually within a minute or two. The login details are shown on screen and emailed to you.']);
  if (x.hasSharing && x.hasPrivate) q.push(['What is the difference between Sharing and Private?', 'Sharing is the cheapest: you watch on a shared profile. Private gives you your own profile that only you use. Both play in the same quality.']);
  if (x.otp) q.push(['How do I sign in if the app asks for an OTP?', 'You get a login phone number. When the ' + x.name + ' app asks for an OTP, open FluxFilm and use the Get OTP tool — it shows the code for your plan.']);
  if (x.deviceRule) q.push(['How many devices can I use?', x.deviceRule]);
  if (x.groupJoin) q.push(['Why do I need to join a WhatsApp group?', 'This offer is for FluxFilm group members. The app asks you to join our WhatsApp group before you pay.']);
  q.push(['Can I renew later?', 'Yes. Sign in to FluxFilm with your phone number and tap Renew on your plan. Some plans give a discount when you renew early.']);
  q.push(['What if something does not work?', 'Use Recover access in the FluxFilm app to see your details again, or contact FluxFilm support on WhatsApp from the Help button.']);
  return q;
}

async function servicePage(slug) {
  const services = servicesOf(await catalogData({ waitMs: 4000 }));
  const x = services.find((v) => v.slug === slug);
  if (!x) return null;
  const rows = x.plans.map((p) => {
    const dv = devicesOf(p);
    const facts = [durationLabel(p.durationDays), dv + (dv === 1 ? ' device' : ' devices'), typeOf(p) && typeOf(p).toLowerCase() + ' profile'].filter(Boolean).join(' · ');
    return '<div class="card plan"><div class="ph"><h3>' + esc(p.plan) + '</h3>' + badge(p.stockLevel) + '</div><div class="price">' + inr(p.price) + '</div>' +
      '<div class="muted">' + esc(facts) + (Number(p.durationDays) > 45 ? ' · ≈ ' + inr(monthly(p)) + '/month' : '') + '</div></div>';
  }).join('');
  const benefits = [...new Set(x.plans.flatMap((p) => (p.benefits || []).map(clean)).filter((b) => b && b.length < 60))].slice(0, 12);
  const others = services.filter((v) => v !== x);
  const related = x.slug === 'netflix' ? services.find((v) => v.slug === 'netflix-group-offer') : x.slug === 'netflix-group-offer' ? services.find((v) => v.slug === 'netflix') : null;
  const buy = '/?buy=' + x.slug;
  const body = '<h2>' + esc(x.name) + ' plans on FluxFilm</h2><div class="grid plans">' + rows + '</div>' +
    (related ? '<p class="muted">Also see <a href="/plans/' + related.slug + '">' + esc(related.name) + '</a> from ' + inr(related.minPrice) + '.</p>' : '') +
    (benefits.length ? '<h2>What you get</h2><ul class="ticks">' + benefits.map((b) => '<li>' + esc(b) + '</li>').join('') + '</ul>' : '') +
    (x.manual ? '<h2>How activation works</h2><div class="card"><ol class="steps"><li>Pick a plan and enter the email you want it on.</li><li>Pay with any UPI app.</li><li>Our team activates it on your email and keeps you updated.</li></ol></div>' : howHtml()) +
    (x.hasSharing || x.hasPrivate ? '<h2>Sharing vs private, simply</h2><div class="card"><p>' + (x.hasSharing ? '<b>Sharing:</b> lowest price, you watch on a shared profile. ' : '') + (x.hasPrivate ? '<b>Private:</b> your own profile that only you use.' : '') + (x.deviceRule ? ' ' + esc(x.deviceRule) : '') + '</p></div>' : '') +
    '<h2>' + esc(x.name) + ' questions</h2>' + faqHtml(serviceFaqs(x)) +
    '<div class="cta"><h2 style="margin-top:0">Get ' + esc(x.name) + ' from ' + inr(x.minPrice) + '</h2><p>Opens the FluxFilm app on the ' + esc(x.name) + ' plans.</p><a class="btn" href="' + buy + '">Buy on FluxFilm</a></div>' +
    (others.length ? '<h2>Other services</h2><div class="grid">' + others.map((v) => '<a class="card" href="/plans/' + v.slug + '"><h3>' + esc(v.name) + '</h3><div class="muted">from ' + inr(v.minPrice) + '</div></a>').join('') + '</div>' : '');
  let title = x.name + ' Subscription Plans from ' + inr(x.minPrice) + ' | FluxFilm';
  if (title.length > 65) title = x.name + ' Plans from ' + inr(x.minPrice) + ' | FluxFilm';
  let description = 'Buy ' + x.name + ' plans from ' + inr(x.minPrice) + ' on FluxFilm. ' + x.plans.length + ' plan' + (x.plans.length === 1 ? '' : 's') + ', pay by UPI, ' + (x.manual ? 'activated on your email.' : 'instant login on screen & email.') + (x.hasSharing && x.hasPrivate ? ' Sharing & private options.' : '');
  if (description.length > 160) description = description.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  return layout({
    path: '/plans/' + x.slug, services, title, description,
    h1: x.name + ' subscription plans', lead: 'From ' + inr(x.minPrice) + ' · pay by UPI · ' + (x.manual ? 'activated on your email' : 'instant login') + '. Subscription plans for ' + x.name + ' sold by FluxFilm.',
    cta: [buy, 'Buy ' + x.name + ' on FluxFilm'], crumbs: '<a href="/">Home</a> › <a href="/plans">Plans</a> › ' + esc(x.name),
    ld: [{ '@type': 'OfferCatalog', name: x.name + ' plans on FluxFilm', url: SITE + '/plans/' + x.slug, itemListElement: x.plans.map((p) => offerLd(p, SITE + '/plans/' + x.slug)) }, breadcrumbLd([['Home', '/'], ['Plans', '/plans'], [x.name, '/plans/' + x.slug]])],
    body,
  });
}

const GENERAL_FAQ = [
  ['What is FluxFilm?', 'FluxFilm is an Indian online store for streaming subscription plans — Netflix, Prime Video, JioHotstar, SonyLiv, Zee5, Crunchyroll, YouTube Premium and more — at lower prices, with prices in rupees.'],
  ['How does it work?', 'Choose a plan, enter your phone number and email, and pay by UPI. When the payment is confirmed you see your login details on screen, and we email you a copy.'],
  ['How do I pay?', 'With UPI, using any UPI app such as Google Pay, PhonePe, Paytm or BHIM. Pay the exact amount shown so the payment is matched to your order automatically.'],
  ['How long does delivery take?', 'Most plans are delivered instantly — usually within a minute or two of paying. A few plans (for example YouTube Premium) are activated by our team on your email.'],
  ['What is the difference between Sharing and Private plans?', 'Sharing plans cost the least and use a shared profile. Private plans give you your own profile that only you use. Each plan shows how many devices you can use.'],
  ['Do I need to create an account?', 'No password is needed. FluxFilm uses your phone number, so you can sign in later to see your plans, renew, or get an OTP.'],
  ['How do I renew?', 'Sign in with your phone number and tap Renew on your plan. On many plans renewing early gives a discount, shown on the Renew screen.'],
  ['The app asks me for an OTP. What do I do?', 'For plans that sign in with a phone number, open FluxFilm and use the Get OTP tool. It shows the code for your plan.'],
  ['I lost my login details. Can I get them again?', 'Yes. Use Recover access in the FluxFilm app — we verify you by email and show your details again.'],
  ['What about refunds or problems with my plan?', 'Contact FluxFilm support on WhatsApp using the Help button in the app. Share your order details and we will help you.'],
  ['Is FluxFilm the official Netflix or Amazon website?', 'No. FluxFilm is an independent store that sells subscription plans. It is not run by or affiliated with Netflix, Amazon or the other streaming services.'],
];
async function faqPage() {
  const services = servicesOf(await catalogData({ waitMs: 4000 }));
  const body = faqHtml(GENERAL_FAQ) + '<h2>Service questions</h2><div class="grid">' + services.map((x) => '<a class="card" href="/plans/' + x.slug + '"><h3>' + esc(x.name) + '</h3><div class="muted">Plans, prices &amp; questions</div></a>').join('') + '</div>' +
    '<div class="cta"><h2 style="margin-top:0">Still have a question?</h2><p>Open the app and tap Help to chat with us on WhatsApp.</p><a class="btn" href="/">Open FluxFilm</a></div>';
  return layout({
    path: '/faq', services,
    title: 'FAQ — Payment, Delivery, Sharing vs Private | FluxFilm',
    description: 'How FluxFilm works: pay by UPI, instant login delivery, sharing vs private profiles, renewals, Get OTP and support on WhatsApp.',
    h1: 'Frequently asked questions', lead: 'Quick answers about buying, paying, delivery and renewals on FluxFilm.', crumbs: '<a href="/">Home</a> › FAQ',
    ld: [{ '@type': 'FAQPage', mainEntity: GENERAL_FAQ.map((q) => ({ '@type': 'Question', name: q[0], acceptedAnswer: { '@type': 'Answer', text: q[1] } })) }, breadcrumbLd([['Home', '/'], ['FAQ', '/faq']])],
    body,
  });
}

function postImage(src) {
  const v = s(src);
  return /^\/((?:poster|tmdb-img\/t\/p)\/w\d+\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)|feed-img\/fp[0-9a-f]{10}(\?v=[\w%.:-]*)?)$/.test(v) ? v.replace(/^\/(?:poster|tmdb-img\/t\/p)\/w\d+\//, '/poster/w185/') : '';
}
// Post with a video (Instagram Reel, or a YouTube trailer that plays in the app): a plain "Watch" link to the post — no embeds here.
function postVideoLabel(p) {
  if (/^https:\/\/www\.instagram\.com\/(reel|p)\/[A-Za-z0-9_-]{5,40}\/$/.test(s(p && p.instagramUrl))) return 'the video';
  return /^https:\/\/((www\.|m\.)?youtube\.com\/(watch\?(.*&)?v=|shorts\/|embed\/)|youtu\.be\/)[A-Za-z0-9_-]{11}([&?#/]|$)/.test(s(p && p.trailerUrl)) ? 'the trailer' : '';
}
async function whatsNewPage() {
  const [data, feed] = await Promise.all([catalogData({ waitMs: 4000 }), feedData()]);
  const services = servicesOf(data);
  const posts = (feed.posts || []).filter((p) => /^fp[0-9a-f]{10}$/.test(s(p.id))).slice(0, 40);
  const svcFor = (name) => { const n = s(name).toLowerCase(); return n ? services.find((x) => x.name.toLowerCase() === n) || services.find((x) => x.name.toLowerCase().startsWith(n)) : null; };
  const items = posts.map((p) => {
    const img = postImage(p.image);
    const svc = svcFor(p.service);
    const cap = s(p.caption).replace(/\s+/g, ' ');
    return '<article class="card post">' + (img ? '<img src="' + esc(img) + '" alt="' + esc(p.title) + ' poster" width="92" height="138" loading="lazy">' : '') +
      '<div><h3><a href="/?post=' + p.id + '">' + esc(p.title) + '</a></h3><div class="muted">' + esc([p.type === 'series' ? 'Series' : p.type === 'movie' ? 'Movie' : 'News', s(p.service) && 'on ' + s(p.service)].filter(Boolean).join(' ')) + '</div>' +
      (cap ? '<p>' + esc(cap.length > 180 ? cap.slice(0, 177).replace(/\s+\S*$/, '') + '…' : cap) + '</p>' : '') +
      (postVideoLabel(p) ? '<p class="watch"><a href="/?post=' + p.id + '">▶ Watch ' + postVideoLabel(p) + '</a></p>' : '') +
      (svc ? '<a href="/plans/' + svc.slug + '">' + esc(svc.name) + ' plans from ' + inr(svc.minPrice) + '</a>' : '') + '</div></article>';
  }).join('');
  // Data-source credit lives on /about (Credits), not on this page (owner 2026-09-15).
  const body = (items ? '<div class="grid">' + items + '</div>' : '<div class="card"><p>No new posts right now. <a href="/plans">See all plans &amp; prices</a>.</p></div>');
  return layout({
    path: '/whats-new', services,
    title: 'What\'s New on Netflix, Prime Video & JioHotstar | FluxFilm',
    description: 'New movies and series to watch this week on Netflix, Prime Video, JioHotstar and more — with FluxFilm plan prices to start watching today.',
    h1: 'What\'s new to watch', lead: 'Fresh movies and shows on the services you can get through FluxFilm.', crumbs: '<a href="/">Home</a> › What\'s new',
    ld: [{ '@type': 'ItemList', name: 'What\'s new on FluxFilm', itemListElement: posts.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: s(p.title), url: SITE + '/?post=' + p.id })) }, breadcrumbLd([['Home', '/'], ['What\'s new', '/whats-new']])],
    body,
  });
}

async function aboutPage() {
  const services = servicesOf(await catalogData({ waitMs: 4000 }));
  const body = '<div class="card"><p>FluxFilm helps people in India watch more for less. We sell subscription plans for ' + esc(services.map((x) => x.name).join(', ') || 'popular streaming services') + ', priced in rupees and paid by UPI.</p>' +
    '<p>Most plans are delivered instantly: your login appears on screen as soon as the payment is confirmed, with a copy by email. Your phone number is your account — sign in any time to renew, recover your details or get an OTP.</p>' +
    '<p>Need help? Tap Help in the app to reach FluxFilm support on WhatsApp.</p></div>' +
    '<p style="margin-top:20px"><a class="btn" href="/plans">See plans &amp; prices</a> <a class="btn ghost" href="/faq">Read the FAQ</a></p>' +
    // Credits (required by the movie data provider's terms; kept here instead of on the feed).
    '<p class="muted" style="margin-top:28px;font-size:12px">Credits: some movie and show information and images are provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>';
  return layout({
    path: '/about', services,
    title: 'About FluxFilm — Streaming Subscriptions for Less in India',
    description: 'FluxFilm is an Indian store for Netflix, Prime Video, JioHotstar and other streaming subscription plans. UPI payment, instant delivery, WhatsApp support.',
    h1: 'About FluxFilm', lead: 'Stream more. Pay less.', crumbs: '<a href="/">Home</a> › About',
    ld: [breadcrumbLd([['Home', '/'], ['About', '/about']])], body,
  });
}

function robotsTxt() {
  return ['User-agent: *', 'Allow: /', 'Disallow: /panel', 'Disallow: /admin', 'Disallow: /api', 'Disallow: /profile-photo', 'Disallow: /version', 'Disallow: /__debug', 'Disallow: /clearcache', '', 'Sitemap: ' + SITE + '/sitemap.xml', ''].join('\n');
}
async function sitemapXml() {
  const [data, feed] = await Promise.all([catalogData({ waitMs: 4000 }), feedData().catch(() => ({ posts: [] }))]);
  const services = servicesOf(data);
  const newest = (feed.posts || []).map((p) => s(p.date).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
  const urls = [['/', STARTED, '1.0'], ['/plans', STARTED, '0.9']]
    .concat(services.map((x) => ['/plans/' + x.slug, STARTED, '0.8']))
    .concat([['/faq', STARTED, '0.6'], ['/whats-new', newest && newest > STARTED ? newest : STARTED, '0.6'], ['/about', STARTED, '0.4']]);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + SITE + esc(u[0]) + '</loc><lastmod>' + u[1] + '</lastmod><priority>' + u[2] + '</priority></url>').join('\n') + '\n</urlset>\n';
}

// ---------- routes ----------
function sendPage(res, html) {
  res.set('Cache-Control', PAGE_CACHE);
  res.type('html').send(html);
}
function mount(app) {
  app.get('/robots.txt', (_req, res) => { res.set('Cache-Control', 'public, max-age=3600'); res.type('text/plain').send(robotsTxt()); });
  app.get('/sitemap.xml', async (_req, res) => {
    try { const x = await sitemapXml(); res.set('Cache-Control', PAGE_CACHE); res.type('application/xml').send(x); }
    catch (_) { res.status(500).type('text/plain').send('sitemap unavailable'); }
  });
  app.get('/og-image.png', (_req, res) => {
    if (!fs.existsSync(OG_FILE)) return res.status(404).type('text/plain').send('not found');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('image/png').sendFile(OG_FILE);
  });
  const wrap = (fn) => async (req, res) => {
    try {
      const html = await fn(req);
      if (!html) return res.status(503).set('Retry-After', '120').set('Cache-Control', 'no-store').type('text/plain').send('Plans are temporarily unavailable. Please try again soon, or open https://shop.fluxfilm.in/');
      sendPage(res, html);
    }
    catch (e) { console.log('[seo] page error:', e && e.message); res.status(500).set('Cache-Control', 'no-store').type('text/plain').send('Something went wrong. Please open https://shop.fluxfilm.in/'); }
  };
  // Trailing slashes / capitals → the one canonical address.
  app.use((req, res, next) => {
    const m = req.method === 'GET' || req.method === 'HEAD' ? req.path.match(/^\/(plans|faq|whats-new|about)(\/|\.html)$/i) : null;
    if (!m) return next();
    res.redirect(301, '/' + m[1].toLowerCase());
  });
  app.get('/plans', wrap(plansPage));
  app.get('/faq', wrap(faqPage));
  app.get('/whats-new', wrap(whatsNewPage));
  app.get('/about', wrap(aboutPage));
  app.get('/plans/:slug', async (req, res) => {
    const raw = String(req.params.slug || '');
    const slug = serviceSlug(raw);
    try {
      const services = servicesOf(await catalogData({ waitMs: 4000 }));
      const known = new Set(services.map((x) => x.slug));
      if (raw !== slug && known.has(slug)) return res.redirect(301, '/plans/' + slug);
      if (!known.has(slug)) {
        const to = OLD_SLUGS[slug];
        // No catalog at all (DB down): answer 503 rather than redirecting real pages away.
        if (!services.length) return res.status(503).set('Retry-After', '120').set('Cache-Control', 'no-store').type('text/plain').send('Plans are temporarily unavailable. Please try again soon.');
        return res.redirect(301, to && known.has(to) ? '/plans/' + to : '/plans');
      }
      const html = await servicePage(slug);
      if (!html) return res.redirect(301, '/plans');
      sendPage(res, html);
    } catch (e) { console.log('[seo] service page error:', e && e.message); res.status(500).set('Cache-Control', 'no-store').type('text/plain').send('Something went wrong.'); }
  });
}

module.exports = {
  mount, decorateIndex, serviceSlug, servicesOf, indexDescription, robotsTxt, sitemapXml,
  plansPage, servicePage, faqPage, whatsNewPage, aboutPage, clearCache, esc, ldJson, durationLabel, catalogData,
  SITE, GENERAL_FAQ, _internal: { store, postImage, devicesOf, typeOf, monthly },
};
