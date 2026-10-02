/* 🏆 The trophy that was not a trophy, and numbers that roll like a scoreboard.
 *
 * Owner, 2 Oct 2026: "there is some weird code U000 something" and "make the numbers better, dynamic and
 * animated ... change them in real time like a scorecard in sports".
 *
 * THE BUG, which was mine: the folded line shipped `"\U0001F3C6"`. JavaScript has no \U escape, so every
 * logged-in customer saw the literal text U0001F3C6 where the trophy should be. It got there because the
 * emoji was written as an escape inside a String.raw template in the patch script, where a backslash is kept
 * verbatim. The first test below is the one that would have caught it, and it is deliberately broad: ANY dead
 * escape anywhere in the storefront, not just this one.
 *
 * Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

(async () => {
  // ── the bug, and the general case of it ──────────────────────────────────────────────────────────────────
  section('a dead escape renders as its own source text');
  ok('🔒 the trophy is the character itself, not an escape', /\u{1F3C6}/u.test(HTML) && !/U0001F3C6/.test(HTML));
  for (const [name, src] of [['index.html', HTML], ['admin.html', ADMIN]]) {
    // \U is never valid JavaScript. A lone \u that is not followed by 4 hex digits or {…} is just as dead.
    // Both mean a character was written as an escape where it should have been written as itself.
    const dead = [...src.matchAll(/\\U[0-9a-fA-F]{4}|\\u(?![0-9a-fA-F]{4}|\{[0-9a-fA-F]{1,6}\})/g)].map((m) => m[0]);
    ok('🔒 ' + name + ' has no dead \\U or \\u escape anywhere', dead.length === 0, dead.slice(0, 6));
  }
  ok('…and the folded line still has a trophy on it',
    /\u{1F3C6}"\), React\.createElement\("span"/u.test(HTML), HTML.slice(HTML.indexOf('\u{1F3C6}') - 60, HTML.indexOf('\u{1F3C6}') + 40));

  // ── the scoreboard ───────────────────────────────────────────────────────────────────────────────────────
  section('the numbers roll');
  const src = HTML.slice(HTML.indexOf('function useCountUp('), HTML.indexOf('// \u{1F3C6} Why trust us'));
  ok('there is a count-up and a number that uses it', /function useCountUp\(/.test(HTML) && /function ScoreNum\(/.test(HTML));
  ok('it eases rather than running at a constant speed', /1 - Math\.pow\(1 - p, 3\)/.test(src));
  ok('it animates with requestAnimationFrame, not a timer per frame', /requestAnimationFrame\(step\)/.test(src));
  ok('🔒 and it cancels on unmount, so a screen left behind is not still animating',
    /cancelAnimationFrame\(raf\)/.test(src) && /clearTimeout\(flash\)/.test(src));
  ok('🔒 digits are tabular, so a rolling number does not make the row dance', /tabular-nums/.test(src));

  section('a change is news; being looked at is not');
  ok('coming into sight does NOT flash — the number is only arriving', /const inSight = lastView\.current !== view/.test(src) && /const news = !inSight && !pulse && prev !== to/.test(src));
  ok('…but a real change does, briefly', /setTimeout\(\(\) => setBumped\(false\), 1400\)/.test(src));
  ok('the flash is colour and scale, which needs no layout and cannot shift the page',
    /transform: bumped \? 'scale\(1\.06\)' : 'none'/.test(src) && /color: bumped \? C\.green2 : C\.green/.test(src));
  ok('the roll from nothing is slower than a later tick, because it has further to travel', /inSight \? 1100 : pulse \? 900 : 700/.test(src));
  ok('🔒 a heartbeat runs only the last stretch, so the figure is never left reading far below the truth '
    + 'on a panel whose whole job is to be believed',
    /const lastStretch = Math\.max\(1, Math\.round\(to \* 0\.03\)\)/.test(src)
    && /pulse \? Math\.max\(0, to - lastStretch\)/.test(src), src.slice(src.indexOf('const lastStretch'), src.indexOf('const lastStretch') + 160));
  ok('🔒 and it is driven by being SEEN, not by the data arriving — the board sits below the fold, so a roll '
    + 'tied to the fetch is over before anybody has scrolled to it', /function useInSight\(/.test(HTML)
    && /const \[view, beat\] = useInSight\(card, !!t\)/.test(HTML) && /\}, \[to, view, beat\]\);/.test(src));

  section('🔒 somebody who asked for no animation gets none');
  ok('prefers-reduced-motion is checked', /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/.test(src));
  ok('…and then the number is simply set, with no frames at all',
    /if \(still\) \{\s*setShown\(to\);\s*return undefined;/.test(src), src.slice(src.indexOf('if (still)'), src.indexOf('if (still)') + 90));
  ok('🔒 and matchMedia itself is wrapped — an old browser without it must not break the page',
    /try \{[\s\S]{0,160}matchMedia[\s\S]{0,120}catch \(e\) \{\}/.test(src));

  section('it keeps up with the shop');
  ok('🔒 the board refreshes every minute, which is the server\'s own cache window', /setInterval\(load, 60000\)/.test(HTML));
  ok('…and no longer every five', !/setInterval\(load, 5 \* 60000\)/.test(HTML.slice(HTML.indexOf('function TrustProof('), HTML.indexOf('function ReviewsWall'))));

  section('the figures themselves are unchanged');
  ok('still the three totals, still formatted for India',
    /value: T\.orders/.test(HTML) && /value: T\.customers/.test(HTML) && /value: T\.recurring/.test(HTML)
    && /toLocaleString\('en-IN'\)/.test(src));
  ok('🔒 a figure of zero is still left out rather than rolled up to nothing', /T\.orders > 0 \?/.test(HTML) && /T\.customers > 0 \?/.test(HTML));
  ok('package.json runs this test', /node test\/trust-scoreboard\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  // ── it still parses ──────────────────────────────────────────────────────────────────────────────────────
  section('the page still runs');
  let parsed = true, n = 0;
  for (const m of HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1].trim()) continue;
    n++;
    try { new Function(m[1]); } catch (e) { parsed = false; console.log('   parse error: ' + e.message); }
  }
  ok('every inline <script> parses', parsed && n > 0, { blocks: n });

  console.log('\n---------------------------------------');
  console.log('trust-scoreboard: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
