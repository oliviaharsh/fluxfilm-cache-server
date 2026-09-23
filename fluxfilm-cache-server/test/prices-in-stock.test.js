/* 💸 Never quote a price for something we cannot sell today.
 *
 * Owner, 23 Sep 2026: "yes fix the tiles to check stock". Found while building the share card (PR 152), which
 * already refused to quote sold-out plans: the buy tiles said "JioHotstar From ₹69/mo" and "SonyLiv Premium
 * From ₹69/mo" while every plan at ₹69 was out of stock. The feed's "Get X from ₹Y" pill and the crawlable
 * /plans page had the same hole.
 *
 * The page's own helpers are lifted out of index.html and run here, so this tests the shop and not a copy.
 *
 * Run: npm test  (no database, no network, no DOM)
 */
process.env.TZ = 'Asia/Kolkata';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function lift(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('no ' + name);
  let i = src.indexOf('{', start), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1); } }
  throw new Error('unbalanced ' + name);
}
function liftConst(name) {
  const start = src.indexOf('const ' + name + ' = {');
  let i = src.indexOf('{', start), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1) + ';'; } }
  throw new Error('unbalanced ' + name);
}
const env = new Function([liftConst('shareText_'), lift("soldOut_"), lift('livePrice_'), lift('priceTerm_'), lift('feedServiceInfo_'),
  'return { shareText_, livePrice_, priceTerm_, feedServiceInfo_ };'].join('\n'))();
const { livePrice_, priceTerm_, feedServiceInfo_ } = env;

const P = (service, plan, price, days) => ({ service, plan, price, durationDays: days || 30 });
const OUT = (p) => ({ [p.service + '|||' + p.plan]: { stockLevel: 'OUT' } });
// The real shape on 23 Sep 2026: JioHotstar's monthlies were gone and only the year was sellable;
// SonyLiv Premium's single plan was gone entirely.
const PLANS = [
  P('JioHotstar', '1 Month', 69), P('JioHotstar', '3 Months', 199, 90), P('JioHotstar', '6 Months', 349, 180), P('JioHotstar', '1 Year', 499, 365),
  P('SonyLiv Premium', '1 Month', 69),
  P('Netflix', 'Sharing 1M', 139), P('Netflix', 'Private 1Y', 1849, 365),
];
const LEVELS = Object.assign({}, OUT(PLANS[0]), OUT(PLANS[1]), OUT(PLANS[2]), OUT(PLANS[4]));

section('the price a tile is allowed to promise');
{
  const jio = livePrice_('JioHotstar', PLANS, LEVELS);
  ok('a sold-out monthly is skipped for the next one that is actually sellable', jio.price === 499 && jio.durationDays === 365 && jio.soldOut === false, jio);
  ok('...and the tile says /yr, not /mo — it is a year of streaming, not a month', priceTerm_(jio.durationDays) === '/yr' && 'From ₹' + jio.price + priceTerm_(jio.durationDays) === 'From ₹499/yr');

  const sony = livePrice_('SonyLiv Premium', PLANS, LEVELS);
  ok('a service with nothing in stock is marked sold out', sony.soldOut === true, sony);
  ok('...and still knows what it normally costs, so the tile is not blank', sony.price === 69);

  const nf = livePrice_('Netflix', PLANS, LEVELS);
  ok('a service in stock is unchanged', nf.price === 139 && nf.soldOut === false && priceTerm_(nf.durationDays) === '/mo', nf);

  ok('before the stock data arrives, everything counts as in stock (no "sold out" flash)',
    livePrice_('SonyLiv Premium', PLANS, null).soldOut === false && livePrice_('JioHotstar', PLANS, null).price === 69);
  ok('a service we do not sell gives nothing rather than a wrong price', livePrice_('Nope', PLANS, LEVELS) === null);
  ok('a ₹0 row is never the quoted price', livePrice_('Free', [P('Free', 'x', 0)], null) === null);
}

section('how long the price buys');
{
  const cases = [[30, '/mo'], [31, '/mo'], [90, ' · 3 months'], [180, ' · 6 months'], [365, '/yr'], [730, ' · 2 yrs'], [45, ' · 45 days']];
  ok('the term matches the plan', cases.every(([d, t]) => priceTerm_(d) === t), cases.map(([d]) => d + '=' + priceTerm_(d)));
}

section('the feed pill');
{
  const jio = feedServiceInfo_('JioHotstar', PLANS, LEVELS);
  ok('"Get JioHotstar from ₹499" — the year, not the sold-out month', jio.price === 499 && jio.soldOut === false, jio);
  const sony = feedServiceInfo_('SonyLiv Premium', PLANS, LEVELS);
  ok('a sold-out service loses the price rather than advertising one', sony.price === 0 && sony.soldOut === true && sony.service === 'SonyLiv Premium', sony);
  ok('the pill drops "from ₹" when there is no price', (src.match(/info\.price \? ' from ₹' \+ [a-zA-Z[\]'.]*info\.price : ''/g) || []).length === 3,
    (src.match(/'Get ' \+ [^\n]{0,60}from ₹/g) || []));
  ok('it still names the service, so the post keeps its button', !!sony.service && !!sony.logoUrl === false);
}

section('wired into the page');
{
  ok('App hands the buy screen the stock it already has', /React\.createElement\(Buy1Screen, \{\s*nav: nav,\s*boot: boot,\s*stockLevels: stockLevels,\s*stockLoading: stockLoading\s*\}\)/.test(src));
  ok('the tile is given the levels, and null while they load', /levels: stockLoading \? null : stockLevels/.test(src));
  ok('the tile asks livePrice_ instead of the raw minimum', /const live = livePrice_\(svc, plans, levels\)/.test(src) && !/const minPrice = Math\.min/.test(src));
  ok('a sold-out tile says so and offers the bell', /soldOut \? 'Out of stock'/.test(src) && /soldOut \? '🔔 Notify me'/.test(src));
}

section('the crawlable /plans page');
{
  const seo = require('../seo');
  const svcs = seo.servicesOf({ plans: PLANS, levels: LEVELS });
  const by = (n) => svcs.find((x) => x.name === n);
  ok('"from ₹" quotes the cheapest plan in stock', by('JioHotstar').minPrice === 499 && by('JioHotstar').level === 'OK', by('JioHotstar'));
  ok('a fully sold-out service keeps its usual price and an OUT badge', by('SonyLiv Premium').minPrice === 69 && by('SonyLiv Premium').level === 'OUT', by('SonyLiv Premium'));
  ok('"about ₹X/month on longer plans" is also from what is sellable', by('JioHotstar').minMonthly === 41, by('JioHotstar').minMonthly);
  ok('the page headline price ignores services nobody can buy from', /const live = services\.filter\(\(x\) => x\.level !== 'OUT'\)/.test(fs.readFileSync(path.join(ROOT, 'seo.js'), 'utf8')));
}

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
