/* 🔎 SEO (seo.js, index.html head, /?buy= links, robots.txt, sitemap.xml). Catalog + feed mocked — no DB, no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const net = require('net');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('- ' + t);
const ROOT = path.join(__dirname, '..');

const P = (service, plan, days, price, o) => Object.assign({ service, plan, durationDays: days, price, fulfillmentMode: 'INSTANT', allocationPolicy: 'PROFILE', benefits: ['📅' + days + ' days', '🍿1 DEVICE'], badgeText: '', logoUrl: '', deviceRuleText: '', requiresGroupJoin: false }, o || {});
let plans = [
  P('Netflix', 'Sharing 1M', 30, 139, { benefits: ['📅1 Month', '🫂Sharing Profile', '🍿1 DEVICE'], deviceRuleText: 'Netflix: login up to 2 devices, watch 1 at a time.', logoUrl: 'https://img.example.com/n.png', badgeText: 'Most Popular' }),
  P('Netflix', 'Private 3M', 90, 499, { benefits: ['📅3 Months', '🤫Private Profile', '🍿1 DEVICE'] }),
  P('Netflix (Group Offer)', 'Sharing 1M', 30, 99, { requiresGroupJoin: true }),
  P('Prime Video', '1 Month', 30, 39, { allocationPolicy: 'CAPACITY' }),
  P('Prime Video', '2 Devices 1Y', 365, 499, { allocationPolicy: 'CAPACITY', benefits: ['📅1 Year', '🍿2 DEVICES'] }),
  P('JioHotstar', '1 Month', 30, 69, { allocationPolicy: 'OTP_ACCOUNT' }),
  P('SonyLiv Premium', '1 Month', 30, 69, { allocationPolicy: 'OTP_ACCOUNT' }),
  P('YouTube Premium', '1 Month', 30, 99, { fulfillmentMode: 'MANUAL', allocationPolicy: 'NONE' }),
  P('Evil <script>alert("x")</script> TV', '1 Month', 30, 50, { benefits: ['<img src=x onerror=alert(1)>'], logoUrl: 'javascript:alert(1)', deviceRuleText: '"><b>bad</b>' }),
];
let levels = { 'JioHotstar|||1 Month': { stockLevel: 'OUT' }, 'Prime Video|||1 Month': { stockLevel: 'LOW' } };
let dbDown = false;
let posts = [
  { id: 'fpa3a00152db', type: 'series', title: 'Harbour <Lights>', service: 'JioHotstar', caption: 'A '.repeat(150) + 'end', image: '/tmdb-img/t/p/w780/kPKAigYUlWRpnfo4Ptiwlz4FWXU.jpg', instagramUrl: 'https://www.instagram.com/reel/C9xYz_12-ab/', tmdb: true, date: '2026-09-14T20:32:16.110Z' },
  { id: 'fp0123456789', type: 'movie', title: 'Moonlit Heist', service: 'Netflix', caption: 'Heist.', image: 'https://evil.example.com/x.jpg', trailerUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', tmdb: false, date: '2026-09-10T10:00:00.000Z' },
  { id: '"><script>', type: 'movie', title: 'Bad id', service: 'Netflix', caption: '', image: '', date: '' },
  { id: 'fpbbbbbbbbbb', type: 'movie', title: 'Fake Clip', service: 'Netflix', caption: '', image: '', instagramUrl: 'https://instagram.com.evil/reel/C9xYz_12-ab/', trailerUrl: 'https://www.youtube.com.evil/watch?v=dQw4w9WgXcQ', date: '' },
];
const mockCatalog = {
  getBootstrap: async () => { if (dbDown) throw new Error('db down'); return { ok: true, plans: JSON.parse(JSON.stringify(plans)), currency: 'INR' }; },
  getStockLevels: async () => ({ ok: true, levels }),
};
const mockFeed = { publicList: async () => ({ ok: true, posts }) };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './catalog') return mockCatalog;
  if (req === './feed') return mockFeed;
  if (req === './db') return { ENABLED: false, query: async () => { throw new Error('no db in test'); } };
  return origLoad.apply(this, arguments);
};
const seo = require('../seo');

const tagAll = (html, re) => [...html.matchAll(re)];
const metaContent = (html, attr, name) => { const m = html.match(new RegExp('<meta ' + attr + '="' + name.replace(/[.:]/g, '\\$&') + '" content="([^"]*)"')); return m ? m[1] : null; };
const decode = (x) => String(x).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function ldBlocks(html) {
  return tagAll(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map((m) => { try { return JSON.parse(m[1]); } catch (e) { return { parseError: e.message }; } });
}
function types(ld) {
  const out = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v['@type']) out.push(v['@type']); Object.values(v).forEach(walk); } };
  walk(ld); return out;
}
function checkPage(name, html, pathName) {
  const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  const desc = decode(metaContent(html, 'name', 'description') || '');
  ok(name + ': one <h1>', tagAll(html, /<h1[\s>]/g).length === 1, tagAll(html, /<h1[\s>]/g).length);
  ok(name + ': title 30-70 chars', title.length >= 30 && title.length <= 70, title);
  ok(name + ': description 70-165 chars', desc.length >= 70 && desc.length <= 165, desc);
  ok(name + ': absolute canonical + og:url', (html.match(/<link rel="canonical" href="([^"]+)">/) || [])[1] === 'https://shop.fluxfilm.in' + pathName && metaContent(html, 'property', 'og:url') === 'https://shop.fluxfilm.in' + pathName);
  ok(name + ': Open Graph + Twitter card with an absolute 1200×630 image', /^https:\/\/shop\.fluxfilm\.in\/og-image\.png/.test(metaContent(html, 'property', 'og:image')) && metaContent(html, 'property', 'og:image:width') === '1200' && metaContent(html, 'property', 'og:locale') === 'en_IN' && metaContent(html, 'name', 'twitter:card') === 'summary_large_image');
  ok(name + ': lang en-IN, robots index', /<html lang="en-IN">/.test(html) && metaContent(html, 'name', 'robots') === 'index, follow, max-image-preview:large');
  const ld = ldBlocks(html);
  ok(name + ': JSON-LD parses and has Organization + WebSite', ld.length === 1 && !ld[0].parseError && types(ld).includes('Organization') && types(ld).includes('WebSite'), ld);
  ok(name + ': no raw HTML injection from DB text', !/<script>alert|<img src=x|<b>bad<\/b>|<Lights>/.test(html));
  return { title, desc, ld: ld[0] || {} };
}

(async () => {
  section('slugs (seo.js and index.html agree)');
  ok('service slugs', seo.serviceSlug('Netflix') === 'netflix' && seo.serviceSlug('Netflix (Group Offer)') === 'netflix-group-offer' && seo.serviceSlug('Prime Video') === 'prime-video' && seo.serviceSlug('Prime Video + Shopping') === 'prime-video-shopping' && seo.serviceSlug('SonyLiv Premium') === 'sonyliv' && seo.serviceSlug('Zee5 Premium') === 'zee5' && seo.serviceSlug('YouTube Premium') === 'youtube-premium' && seo.serviceSlug('JioHotstar') === 'jiohotstar');
  const store = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fnSrc = (name) => { const i = store.indexOf('function ' + name + '('); const j = store.indexOf('\n}\n', i); return i >= 0 && j > i ? store.slice(i, j + 2) : ''; };
  let browser = null;
  try {
    browser = new Function(fnSrc('ffServiceSlug_') + fnSrc('buyLinkFromUrl_') + fnSrc('buyLinkService_') + 'return { ffServiceSlug_, buyLinkFromUrl_, buyLinkService_ };')();
  } catch (e) { console.log('   ', e.message); }
  const names = ['Netflix', 'Netflix (Group Offer)', 'Prime Video', 'Prime Video + Shopping', 'SonyLiv Premium', 'Zee5 Premium', 'YouTube Premium', 'JioHotstar', 'Crunchyroll', 'A & B  Plus+', ''];
  ok('index.html ffServiceSlug_ = seo.serviceSlug for every name', browser && names.every((n) => browser.ffServiceSlug_(n) === seo.serviceSlug(n)));
  ok('?buy= read safely from the URL', browser && browser.buyLinkFromUrl_('?buy=Prime-Video') === 'prime-video' && browser.buyLinkFromUrl_('?buy=%3Cscript%3E') === '' && browser.buyLinkFromUrl_('?post=fp1') === '' && browser.buyLinkFromUrl_('?buy=all') === 'all');
  ok('?buy=<slug> finds the catalog service; unknown / all -> none (opens the Buy screen)', browser && browser.buyLinkService_('sonyliv', plans) === 'SonyLiv Premium' && browser.buyLinkService_('netflix', plans) === 'Netflix' && browser.buyLinkService_('all', plans) === '' && browser.buyLinkService_('netflix', null) === '');
  ok('App opens buy2 for the service / buy1 otherwise, once boot is loaded and after a saved login', /const buyLink = useRef\(buyLinkFromUrl_\(window\.location\.search\)\);/.test(store) && /if \(!slug \|\| !boot \|\| restoring \|\| getFFSession\(\)\.phone && screen === 'home'\) return;/.test(store) && /if \(service\) nav\('buy2', \{\s*service\s*\}\);else nav\('buy1', \{\}\);/.test(store) && /buyClearUrl_\(\);/.test(store));

  section('storefront head (index.html + decorateIndex)');
  const title = decode((store.match(/<title>([^<]*)<\/title>/) || [])[1]);
  ok('keyword title ≤ 70 chars', /Netflix/.test(title) && /Prime Video/.test(title) && /JioHotstar/.test(title) && title.length <= 70, title);
  ok('lang en-IN, canonical, robots, hreflang', /<html lang="en-IN">/.test(store) && /<link rel="canonical" href="https:\/\/shop\.fluxfilm\.in\/" \/>/.test(store) && /<meta name="robots" content="index, follow/.test(store) && /hreflang="en-IN"/.test(store));
  ok('Open Graph + Twitter tags with the 1200×630 image', /property="og:image" content="https:\/\/shop\.fluxfilm\.in\/og-image\.png\?v=1"/.test(store) && /property="og:locale" content="en_IN"/.test(store) && /name="twitter:card" content="summary_large_image"/.test(store) && /property="og:site_name" content="FluxFilm"/.test(store));
  ok('no JSON-LD in the file itself (added by the server; keeps the inline-script parse test valid)', !/application\/ld\+json/.test(store));
  ok('<noscript> with a description and links to /plans and /faq (one h1)', /<noscript>[\s\S]*<h1[\s\S]*href="\/plans"[\s\S]*href="\/faq"[\s\S]*<\/noscript>/.test(store));
  ok('Buy screen links to All plans & prices', /href: "\/plans",\s*className: "ff-all-plans"/.test(store));
  const decorated = await seo.decorateIndex(store);
  const desc = decode(metaContent(decorated, 'name', 'description'));
  ok('description uses the live cheapest price and stays ≤ 160 chars', /from ₹39\b/.test(desc) && desc.length <= 160 && desc.length >= 90 && /UPI/.test(desc) && /instantly/.test(desc), desc);
  ok('og:description and twitter:description follow', decode(metaContent(decorated, 'property', 'og:description')) === desc && decode(metaContent(decorated, 'name', 'twitter:description')) === desc);
  const ild = ldBlocks(decorated);
  ok('index JSON-LD: Organization, WebSite, OfferCatalog (parses, inside <head>)', ild.length === 1 && !ild[0].parseError && ['Organization', 'WebSite', 'OfferCatalog', 'Offer'].every((t) => types(ild).includes(t)) && decorated.indexOf('application/ld+json') < decorated.indexOf('</head>'));
  const offers = []; (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v['@type'] === 'Offer') offers.push(v); Object.values(v).forEach(walk); } })(ild);
  const jio = offers.find((o) => /JioHotstar/.test(o.name));
  ok('offers: INR prices, stock -> availability', offers.length === plans.length && offers.every((o) => o.priceCurrency === 'INR' && /^\d+$/.test(o.price)) && jio.availability === 'https://schema.org/OutOfStock' && offers.find((o) => /Prime Video 1 Month/.test(o.name)).availability === 'https://schema.org/InStock');
  ok('never claims to be the official service', offers.every((o) => /^Subscription plan for /.test(o.itemOffered.name)) && !types(ild).includes('Product') && ild[0]['@graph'][0].name === 'FluxFilm' && !('sameAs' in ild[0]['@graph'][0]));
  ok('JSON-LD escaped: "</script>" from DB text cannot end the block', !/<\/script>alert/.test(decorated) && /\\u003c\/script\\u003e/.test(decorated));
  ok('no FAQPage on the storefront', !types(ild).includes('FAQPage'));

  section('pages');
  const plansHtml = await seo.plansPage();
  let r = checkPage('/plans', plansHtml, '/plans');
  ok('/plans lists every service with "from ₹" + stock badges + service links', ['netflix', 'prime-video', 'jiohotstar', 'sonyliv', 'youtube-premium', 'netflix-group-offer'].every((x) => plansHtml.includes('href="/plans/' + x + '"')) && /from ₹39/.test(plansHtml) && /Out of stock/.test(plansHtml) && plansHtml.includes('href="/?buy=all"'));
  ok('/plans JSON-LD: OfferCatalog + BreadcrumbList, no FAQPage', types(r.ld).includes('OfferCatalog') && types(r.ld).includes('BreadcrumbList') && !types(r.ld).includes('FAQPage'));
  ok('/plans: unsafe logo URL dropped, https logo kept (lazy)', !/javascript:alert/.test(plansHtml) && /src="https:\/\/img\.example\.com\/n\.png" alt="" width="48" height="48" loading="lazy"/.test(plansHtml));

  const nf = await seo.servicePage('netflix');
  r = checkPage('/plans/netflix', nf, '/plans/netflix');
  ok('/plans/netflix: plan table with length, devices, type, price', /<div class="grid plans">/.test(nf) && /<h3>Sharing 1M<\/h3>/.test(nf) && /<h3>Private 3M<\/h3>/.test(nf) && /3 months · 1 device · private profile · ≈ ₹166\/month/.test(nf) && /1 month · 1 device · sharing profile</.test(nf));
  ok('/plans/netflix: benefits without emoji, sharing vs private, device rule, FAQs, CTA deep link, group offer link', /<li>Sharing Profile<\/li>/.test(nf) && /Sharing vs private, simply/.test(nf) && /login up to 2 devices/.test(nf) && /<details><summary>/.test(nf) && nf.includes('href="/?buy=netflix"') && nf.includes('href="/plans/netflix-group-offer"'));
  ok('/plans/netflix: title has live price; breadcrumb', /from ₹139/.test(r.title) && types(r.ld).includes('BreadcrumbList') && !types(r.ld).includes('FAQPage'));
  const jh = await seo.servicePage('jiohotstar');
  checkPage('/plans/jiohotstar', jh, '/plans/jiohotstar');
  ok('OTP service explains Get OTP; out-of-stock shown', /Get OTP/.test(jh) && /Out of stock/.test(jh));
  ok('per-plan "Few left" badge; 2-device plan shows 2 devices', /Few left/.test(await seo.servicePage('prime-video')) && /1 year · 2 devices · ≈ ₹41\/month/.test(await seo.servicePage('prime-video')));
  const yt = await seo.servicePage('youtube-premium');
  checkPage('/plans/youtube-premium', yt, '/plans/youtube-premium');
  ok('manual service says activated on your email (not instant)', /activated on your email/.test(yt) && !/How delivery works/.test(yt));
  const grp = await seo.servicePage('netflix-group-offer');
  ok('group offer explains the WhatsApp group', /join our WhatsApp group/.test(grp));
  const evil = await seo.servicePage(seo.serviceSlug('Evil <script>alert("x")</script> TV'));
  checkPage('evil service page', evil, '/plans/evil-script-alert-x-script-tv');
  ok('evil text escaped everywhere', /Evil &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; TV/.test(evil) && /&quot;&gt;&lt;b&gt;bad&lt;\/b&gt;/.test(evil));
  ok('unknown service -> null', (await seo.servicePage('nope')) === null);

  const faq = await seo.faqPage();
  r = checkPage('/faq', faq, '/faq');
  const fp = r.ld['@graph'].find((x) => x['@type'] === 'FAQPage');
  ok('/faq: FAQPage JSON-LD matches the visible questions', fp && fp.mainEntity.length === seo.GENERAL_FAQ.length && fp.mainEntity.every((q) => faq.includes('<summary>' + seo.esc(q.name) + '</summary>')) && fp.mainEntity.every((q) => q.acceptedAnswer.text.length > 20));
  ok('/faq: payment, delivery, sharing vs private, renewal, WhatsApp support, not official', /UPI/.test(faq) && /delivered instantly/.test(faq) && /Sharing and Private/.test(faq) && /How do I renew/.test(faq) && /WhatsApp/.test(faq) && /not run by or affiliated/.test(faq));

  const wn = await seo.whatsNewPage();
  r = checkPage('/whats-new', wn, '/whats-new');
  ok('/whats-new: live posts link to /?post=<id>, bad ids skipped', wn.includes('href="/?post=fpa3a00152db"') && wn.includes('href="/?post=fp0123456789"') && !/Bad id/.test(wn));
  ok('/whats-new: small TMDB poster via /tmdb-img, outside images dropped, TMDB attribution, caption shortened', wn.includes('src="/poster/w185/kPKAigYUlWRpnfo4Ptiwlz4FWXU.jpg"') && !/evil\.example/.test(wn) && !/TMDB/.test(wn) && /Harbour &lt;Lights&gt;/.test(wn) && /…<\/p>/.test(wn));
  ok('/whats-new: posts with a Reel / YouTube trailer get a plain "Watch" link to the post; no embeds, no scripts, lookalike links ignored', wn.includes('<p class="watch"><a href="/?post=fpa3a00152db">▶ Watch the video</a></p>') && wn.includes('<p class="watch"><a href="/?post=fp0123456789">▶ Watch the trailer</a></p>') && !wn.includes('href="/?post=fpbbbbbbbbbb">▶') && !/<iframe|instagram\.com|youtube\.com|youtu\.be|youtube-nocookie|instgrm/i.test(wn));
  ok('/whats-new: links to the plan page of the platform', wn.includes('href="/plans/jiohotstar">JioHotstar plans from ₹69'));
  checkPage('/about', await seo.aboutPage(), '/about');

  section('refund policy (/refund-policy, owner 15 Sep 2026)');
  const rp = await seo.refundPolicyPage();
  r = checkPage('/refund-policy', rp, '/refund-policy');
  ok('/refund-policy: title + BreadcrumbList + WebPage JSON-LD', /^Refund Policy/.test(r.title) && types(r.ld).includes('BreadcrumbList') && types(r.ld).includes('WebPage') && !types(r.ld).includes('FAQPage'));
  const rpText = decode(rp.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const heads = tagAll(rp, /<h2>([^<]+)<\/h2>/g).map((m) => decode(m[1]));
  ok('/refund-policy: sections in the owner\'s order', JSON.stringify(heads) === JSON.stringify(['In short', 'Instant delivery', 'Account not working? We replace it', 'Manual delivery (48 hours)', 'Refunds in the middle of a plan', 'Changes made by streaming services', 'Price changes', 'How refunds are paid', 'How to request a refund', 'Contact']), heads);
  ok('/refund-policy: summary box has 4 bullets', (rp.match(/<div class="card sum">[\s\S]*?<\/ul>/) || [''])[0].split('<li>').length - 1 === 4);
  ok('/refund-policy: owner\'s rules (no change-of-mind refund, replacement, 24 h, 48 h full refund, usage charge, price change only on renewal)',
    /no refund just because you changed your mind after delivery/.test(rpText) && /replacement account/.test(rpText) && /refund you within the next 24 hours/.test(rpText) &&
    /within 48 hours/.test(rpText) && /full refund with no charge/.test(rpText) && /usage charge/.test(rpText) && /tell you the amount before we refund/.test(rpText) &&
    /Netflix may lower Premium video quality/.test(rpText) && /not a reason for a full refund/.test(rpText) && /does not affect the period you have already paid for/.test(rpText) && /only when you renew, or when you buy again/.test(rpText));
  ok('/refund-policy: methods match refunds.js (coins +BONUS_PERCENT, 180-day coupon, UPI exact amount, email code)',
    rpText.includes(require('../refunds').BONUS_PERCENT + '% extra') && /180 days/.test(rpText) && /Account → Coupons/.test(rpText) && /exact refund amount/.test(rpText) && /No extra is added to cash refunds/.test(rpText) && /6-digit code/.test(rpText) && /UPI ID/.test(rpText));
  ok('/refund-policy: contact support@fluxfilm.in + Help, last updated 15 Sep 2026', /mailto:support@fluxfilm\.in/.test(rp) && /tap Help/.test(rpText) && /Last updated 15 Sep 2026/.test(rpText));
  ok('/refund-policy: no TMDB, no formulas, no invented promises', !/tmdb/i.test(rp) && !/\d+\s*%\s*(usage|charge|deduct)|per day|pro-?rata|guarantee|legal/i.test(rpText));
  ok('footer on every public page links the refund policy', [plansHtml, faq, wn, rp].every((h) => h.includes('<a href="/refund-policy">Refund policy</a>')));
  ok('/faq refund answer matches the policy and links the page', /replacement account/.test(faq) && /within 24 hours/.test(faq) && faq.includes('<a href="/refund-policy">Refund policy</a>') && seo.GENERAL_FAQ.some((q) => /refund/i.test(q[0]) && /support@fluxfilm\.in/.test(q[1])));
  ok('index.html: refund policy linked at checkout (Details + Renew), Account, refund choice and <noscript>',
    /"✅ Confirm & Pay ₹", payable\), React\.createElement\(RefundPolicyLink, \{\s*lead: String\(planObj\?\.fulfillmentMode \|\| ''\)\.toUpperCase\(\) === 'MANUAL' \? "Activated by our team within 48 hours" : "Instant delivery"\s*\}\)/.test(store) &&
    /'✅ Continue to Pay'\)\), React\.createElement\(RefundPolicyLink, \{\s*lead: "Instant delivery"\s*\}\)/.test(store) &&
    /function RefundPolicyLink\([\s\S]{0,700}href: "\/refund-policy",\s*target: "_blank",\s*rel: "noopener"/.test(store) &&
    /\['\/refund-policy', '📄 Refund policy'\], \['\/faq', '❓ FAQ'\], \['\/about', 'ℹ️ About FluxFilm'\]/.test(store) &&
    /"Decide later"\)\), React\.createElement\(RefundPolicyLink, \{\s*key: "rp"/.test(store) &&
    /<noscript>[\s\S]*href="\/refund-policy"[\s\S]*<\/noscript>/.test(store));
  ok('index.html: the checkout policy line is a link, not a blocking checkbox', !/type: "checkbox"[\s\S]{0,300}[Rr]efund/.test(store));

  section('robots.txt + sitemap.xml');
  const robots = seo.robotsTxt();
  ok('robots: allow all, block private areas, sitemap line', /^User-agent: \*\nAllow: \//.test(robots) && ['/panel', '/admin', '/api', '/profile-photo', '/version'].every((p) => robots.includes('Disallow: ' + p + '\n')) && robots.includes('Sitemap: https://shop.fluxfilm.in/sitemap.xml') && !/Disallow: \/plans|Disallow: \/\n/.test(robots));
  const sm = await seo.sitemapXml();
  const locs = tagAll(sm, /<loc>([^<]+)<\/loc>/g).map((m) => m[1]);
  ok('sitemap: home, /plans, each service, /faq, /whats-new, /about with lastmod', /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sm) && ['/', '/plans', '/plans/netflix', '/plans/prime-video', '/plans/sonyliv', '/faq', '/whats-new', '/about', '/refund-policy'].every((p) => locs.includes('https://shop.fluxfilm.in' + p)) && tagAll(sm, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g).length === locs.length && !locs.some((l) => /[<>"]/.test(l)), locs);

  section('routes (express)');
  const express = require('express');
  const app = express();
  seo.mount(app);
  app.get('*', (_req, res) => res.type('html').send('<html>storefront</html>'));
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const server = app.listen(port);
  const base = 'http://127.0.0.1:' + port;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  try {
    let res = await get('/robots.txt');
    ok('/robots.txt is text/plain (not the storefront)', res.status === 200 && /text\/plain/.test(res.headers.get('content-type')) && /Sitemap:/.test(await res.text()));
    res = await get('/sitemap.xml');
    ok('/sitemap.xml is application/xml', res.status === 200 && /application\/xml/.test(res.headers.get('content-type')) && /<urlset/.test(await res.text()));
    res = await get('/plans');
    ok('/plans: 200 html, 5-min cache', res.status === 200 && /text\/html/.test(res.headers.get('content-type')) && res.headers.get('cache-control') === 'public, max-age=300' && /<h1>/.test(await res.text()));
    res = await get('/plans/netflix');
    ok('/plans/netflix: 200', res.status === 200 && /Netflix subscription plans/.test(await res.text()));
    res = await get('/plans/Netflix');
    ok('/plans/Netflix -> 301 /plans/netflix', res.status === 301 && res.headers.get('location') === '/plans/netflix');
    res = await get('/plans/hotstar');
    ok('old slug /plans/hotstar -> 301 /plans/jiohotstar', res.status === 301 && res.headers.get('location') === '/plans/jiohotstar');
    res = await get('/plans/sonyliv-premium');
    ok('/plans/sonyliv-premium -> 301 /plans/sonyliv', res.status === 301 && res.headers.get('location') === '/plans/sonyliv');
    res = await get('/plans/%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    ok('unknown slug -> 301 /plans (input never echoed)', res.status === 301 && res.headers.get('location') === '/plans' && !/script/i.test(await res.text()));
    res = await get('/faq/');
    ok('/faq/ -> 301 /faq; /plans/ -> 301 /plans', res.status === 301 && res.headers.get('location') === '/faq' && (await get('/plans/')).headers.get('location') === '/plans');
    for (const p of ['/faq', '/whats-new', '/about', '/refund-policy']) { res = await get(p); ok(p + ': 200 html', res.status === 200 && /text\/html/.test(res.headers.get('content-type'))); }
    res = await get('/refund-policy');
    const rpBody = await res.text();
    ok('/refund-policy: 200, 5-min cache, canonical, no tmdb', res.status === 200 && res.headers.get('cache-control') === 'public, max-age=300' && rpBody.includes('<link rel="canonical" href="https://shop.fluxfilm.in/refund-policy">') && !/tmdb/i.test(rpBody));
    for (const p of ['/refunds', '/refunds/', '/refund', '/Refunds', '/refund-policy/', '/refund-policy.html', '/return-policy']) {
      res = await get(p);
      ok(p + ' -> 301 /refund-policy', res.status === 301 && res.headers.get('location') === '/refund-policy', [res.status, res.headers.get('location')]);
    }
    res = await get('/refunds/%3Cscript%3E');
    ok('/refunds/<junk> is not redirected with the input (reaches the storefront catch-all)', res.status === 200 && !/script/i.test(res.headers.get('location') || ''));
    res = await get('/sitemap.xml');
    ok('/sitemap.xml lists /refund-policy', (await res.text()).includes('<loc>https://shop.fluxfilm.in/refund-policy</loc>'));
    res = await get('/og-image.png');
    const buf = Buffer.from(await res.arrayBuffer());
    ok('/og-image.png: 1200×630 PNG, long cache, small file', res.status === 200 && res.headers.get('content-type') === 'image/png' && /max-age=2592000/.test(res.headers.get('cache-control')) && buf.slice(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630 && buf.length < 150000, buf.length);
    res = await get('/somewhere-else');
    ok('other paths still reach the storefront catch-all', res.status === 200 && /storefront/.test(await res.text()));

    seo.clearCache(); dbDown = true;
    res = await get('/plans/netflix');
    ok('DB down, no cache: service page 503 (not a redirect away)', res.status === 503);
    res = await get('/plans');
    ok('DB down: /plans 503 no-store (no empty page cached or indexed); /faq still works', res.status === 503 && res.headers.get('cache-control') === 'no-store' && (await get('/faq')).status === 200);
    ok('DB down: /refund-policy still works', (await get('/refund-policy')).status === 200);
    ok('DB down: storefront head left as it is', (await seo.decorateIndex(store)) === store);
    dbDown = false; seo.clearCache();
    ok('DB back: prices return', /from ₹39/.test(await seo.decorateIndex(store)));
  } finally { server.closeAllConnections(); server.close(); }

  section('wiring');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('seo mounted after pwa and before the storefront catch-all', srv.indexOf("seo = require('./seo'); seo.mount(app);") > srv.indexOf("require('./pwa').mount(app)") && srv.indexOf("seo.mount(app)") < srv.indexOf("app.get('*'"));
  ok('catch-all decorates the head, noindex on non-home paths, keeps version/ETag behaviour', /out = await seo\.decorateIndex\(html\)/.test(srv) && /if \(req\.path !== '\/' && req\.path !== '\/index\.html'\) res\.set\('X-Robots-Tag', 'noindex, follow'\);/.test(srv) && /return res\.type\('html'\)\.send\(out\);/.test(srv));
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const sec = fs.readFileSync(path.join(ROOT, 'security.js'), 'utf8');
  ok('/panel: noindex meta + X-Robots-Tag header', /<meta name="robots" content="noindex, nofollow"\/>/.test(admin) && /req\.path === '\/panel'[\s\S]{0,200}X-Robots-Tag', 'noindex, nofollow'/.test(sec));
  ok('npm test runs this suite', /node test\/seo\.test\.js/.test(require('../package.json').scripts.test));

  Module._load = origLoad;
  console.log('\nseo: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
