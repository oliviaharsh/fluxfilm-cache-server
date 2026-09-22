/* 💸 Share the prices: the WhatsApp text (shareText_.prices) and the picture (priceCard_).
 *
 * Owner, 23 Sep 2026: "add a share button on plans on website … is it possible that it creates a SVG card
 * which we can share on whatsapp".
 *
 * Both are lifted straight out of index.html and run here, so this tests the page and not a copy. The parts
 * that touch the browser (canvas, share sheet, clipboard) are not run — only the pure string building, which
 * is where anything can actually go wrong.
 *
 * Run: npm test  (no database, no network, no DOM)
 */
process.env.TZ = 'Asia/Kolkata';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** Lift `const <name> = { … };` out of the page, braces balanced. */
function liftConst(name) {
  const start = src.indexOf('const ' + name + ' = {');
  if (start < 0) throw new Error('no const ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1) + ';'; }
  }
  throw new Error('unbalanced ' + name);
}
const { shareText_, priceCard_ } = new Function(liftConst('shareText_') + liftConst('priceCard_') + 'return { shareText_, priceCard_ };')();

const P = (service, plan, price, days, level) => ({ service, plan, price, durationDays: days || 30, _level: level });
const catalogOf = (...plans) => {
  const levels = {};
  for (const p of plans) if (p._level) levels[p.service + '|||' + p.plan] = { stockLevel: p._level };
  return { plans, levels };
};
const CAT = catalogOf(
  P('Netflix', 'Sharing 1M', 139), P('Netflix', 'Private 1M', 169), P('Netflix', 'Private 3M', 449, 90),
  P('Netflix', 'Private 1Y', 1599, 365), P('Netflix', 'Sharing 6M', 749, 180, 'OUT'),
  P('Prime Video', '1 Month', 39), P('JioHotstar', '1 Month', 69), P('Zee5 Premium', '1 Month', 89, 30, 'OUT'),
);

section('what goes on the card');
{
  const all = priceCard_.rows(CAT, '');
  ok('one line per service, cheapest live plan, popular first', all.kind === 'services' &&
    JSON.stringify(all.rows.map(r => r.name + ' ' + r.price)) === JSON.stringify(['Netflix 139', 'Prime Video 39', 'JioHotstar 69']), all.rows);
  ok('a service whose only plan is sold out is left off', !all.rows.some(r => /Zee5/.test(r.name)), all.rows.map(r => r.name));
  ok('every service line carries its emoji', all.rows.every(r => r.icon && r.icon.length), all.rows);

  const nf = priceCard_.rows(CAT, 'Netflix');
  ok('one service: its own plans, cheapest first', nf.kind === 'plans' &&
    JSON.stringify(nf.rows.map(r => r.name)) === JSON.stringify(['Sharing 1M', 'Private 1M', 'Private 3M', 'Private 1Y']), nf.rows);
  ok('a sold-out plan is never offered', !nf.rows.some(r => /Sharing 6M/.test(r.name)), nf.rows.map(r => r.name));
  ok('the length is spelled out', nf.rows.map(r => r.note).join('|') === '1 month|1 month|3 months|1 year', nf.rows.map(r => r.note));
  ok('an unknown service gives nothing rather than everything', priceCard_.rows(CAT, 'Nope').rows.length === 0);
  ok('no catalog yet → nothing to show, no crash', priceCard_.rows({ plans: [], levels: {} }, '').rows.length === 0 && priceCard_.rows(null, '').rows.length === 0);
}

section('the picture');
{
  const got = priceCard_.rows(CAT, '');
  const card = priceCard_.svg(got, { service: '', now: Date.parse('2026-09-23T10:00:00+05:30') });
  ok('it is an SVG of the declared size', /^<svg /.test(card.svg) && card.svg.endsWith('</svg>') &&
    card.svg.includes('width="' + card.w + '" height="' + card.h + '"'), { w: card.w, h: card.h });
  ok('every tag is closed', (card.svg.match(/</g) || []).length === (card.svg.match(/>/g) || []).length &&
    (card.svg.match(/<[a-zA-Z]/g) || []).length === (card.svg.match(/<\/[a-zA-Z]|\/>/g) || []).length, {
      open: (card.svg.match(/<[a-zA-Z]/g) || []).length, close: (card.svg.match(/<\/[a-zA-Z]|\/>/g) || []).length });
  ok('the prices are on it', ['₹139', '₹39', '₹69'].every(p => card.svg.includes(p)), card.svg.slice(0, 80));
  ok('the sold-out service is not', !card.svg.includes('Zee5'));
  ok('it says where to buy and when the prices are from', card.svg.includes('shop.fluxfilm.in') && card.svg.includes('23 Sep 2026'));
  // The whole reason the card can be turned into a PNG at all: nothing in it is fetched.
  ok('nothing is loaded from outside — no image, no link, no web font', !/<image|xlink:href|href=|@font-face|url\((?!#)/i.test(card.svg) && !/https?:\/\//.test(card.svg.replace('http://www.w3.org/2000/svg', '')), card.svg.match(/https?:\/\/\S{0,40}/g));
  ok('the FluxFilm mark is drawn in, not linked', card.svg.includes('id="pc-lmk"') && card.svg.includes('M170 128V384L392 256Z'));

  const tall = priceCard_.svg(priceCard_.rows(CAT, 'Netflix'), { service: 'Netflix' });
  ok('the card grows with the list', tall.h === priceCard_.TOP + 4 * (priceCard_.ROW + priceCard_.GAP) + 196 && tall.h > card.h, { four: tall.h, three: card.h });
  ok('one service is titled with its own name and emoji', tall.svg.includes('🔴 Netflix') && !tall.svg.includes('Prime Video'));

  // A long list in one column is a 1080×2644 strip; WhatsApp shows that as an unreadable sliver.
  const many = { kind: 'plans', rows: Array.from({ length: 16 }, (_, i) => ({ icon: '', name: 'Plan ' + (i + 1), note: '1 month', price: 100 + i })) };
  const wide = priceCard_.svg(many, { service: 'Netflix' });
  ok('past 8 rows it goes to two columns and stays sendable', wide.h === priceCard_.TOP + 8 * (104 + 12) + 196 && wide.h / wide.w < 1.6, { h: wide.h, ratio: +(wide.h / wide.w).toFixed(2) });
  ok('both columns are on it, none dropped', Array.from({ length: 16 }, (_, i) => 'Plan ' + (i + 1)).every(n => wide.svg.includes('>' + n + '<')));
  ok('the second column starts to the right, not below', wide.svg.includes('x="' + (priceCard_.PAD + (priceCard_.W - priceCard_.PAD * 2 - 24) / 2 + 24) + '"'));
  ok('an empty list still makes a valid card', /^<svg [\s\S]*<\/svg>$/.test(priceCard_.svg({ kind: 'plans', rows: [] }, {}).svg));

  // A plan name is owner-typed text from the admin panel — it must never be able to break the card.
  const nasty = catalogOf(P('Netflix', 'Sharing <b>"1M"</b> & co', 139));
  const x = priceCard_.svg(priceCard_.rows(nasty, 'Netflix'), { service: 'Netflix' });
  ok('a plan name with markup in it is escaped', x.svg.includes('Sharing &lt;b&gt;&quot;1M&quot;&lt;/b&gt; &amp; co') && !x.svg.includes('<b>'), x.svg.slice(x.svg.indexOf('Sharing') - 40, x.svg.indexOf('Sharing') + 70));
}

section('the message that goes with it');
{
  const all = shareText_.prices(CAT, '', 'https://shop.fluxfilm.in');
  ok('bold prices, one service per line, emoji each', /🔴 \*Netflix\* from \*₹139\*/.test(all) && /📦 \*Prime Video\* from \*₹39\*/.test(all), all);
  ok('it names FluxFilm, the perks and where to go', /\*FluxFilm\*/.test(all) && all.includes(shareText_.PERKS) && all.includes('👉 https://shop.fluxfilm.in'), all);
  ok('sold-out services stay out of the message too', !/Zee5/.test(all), all);

  const nf = shareText_.prices(CAT, 'Netflix', 'https://shop.fluxfilm.in');
  ok('one service: its plans, with the length and a bold price', /• \*Sharing 1M\*  ·  1 month — \*₹139\*/.test(nf) && /\*Private 1Y\*  ·  1 year — \*₹1,599\*/.test(nf), nf);
  ok('headed with that service', /^🔴 \*Netflix\* on \*FluxFilm\*/.test(nf), nf.split('\n')[0]);
  ok('no catalog → still a sendable message, never an empty one', /Message us/.test(shareText_.prices({ plans: [] }, '', 'https://shop.fluxfilm.in')));
  ok('no blank line is left doubled', !/\n\n\n/.test(all) && !/^\n|\n$/.test(all));
}

section('wired into the page');
{
  ok('the button exists', /function SharePricesBtn\(/.test(src));
  ok('it is on the service list (all prices)', /React\.createElement\(SharePricesBtn, null\)/.test(src));
  ok('and on one service (its plans)', /React\.createElement\(SharePricesBtn, \{\s*service: service\s*\}\)/.test(src));
  ok('the share sheet is only opened when the phone accepts a file', /navigator\.canShare\(\{ files: \[file\] \}\)/.test(src) && /navigator\.share\(\{ files: \[file\], text \}\)/.test(src));
  ok('a desktop saves the picture and copies the text instead', /priceCard_\.save\(file \|\| blob, name\)/.test(src) && /copyText_\(text, \(\) => fin\('saved'\)\)/.test(src));
  // 1080×1524 is ~1.2 MB as a PNG and ~195 KB as a JPEG, and WhatsApp recompresses to JPEG anyway.
  ok('the card is sent as a JPEG, not a megabyte of PNG', /'image\/jpeg', 0\.92\)/.test(src) && /'\.jpg'/.test(src) && !/image\/png/.test(src.slice(src.indexOf('const priceCard_'), src.indexOf('function SharePricesBtn'))));
}

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
