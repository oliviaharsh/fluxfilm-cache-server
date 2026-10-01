/* ⭐ Customer reviews, with the owner's reply underneath.
 *
 * Owner, 1 Oct 2026: "can we also reviews function where we also reply to them".
 *
 * The two rules that make a review wall worth reading, and which this file exists to hold in place:
 *   1. only somebody who has actually PAID us can write one
 *   2. one review per customer — they may rewrite theirs, they may not stack five
 * Plus: moderation is the same feedmod.js the feed comments use, the public payload never carries a phone or an
 * email, and a rewritten review drops the owner's old reply (an answer to different words must never sit under
 * new ones).
 *
 * Real reviews.js on a fake MySQL with a fixed clock. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const NOW = Date.parse('2026-10-01T22:30:00+05:30');

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────
let ROWS, CUSTOMERS, ORDERS, nextId, noTable;
const reset = () => {
  ROWS = [];
  nextId = 1;
  noTable = false;
  CUSTOMERS = {
    9000000001: { name: 'Harsh Walia', profile_pic_url: '/avatar/1.png' },
    9000000002: { name: 'Keshav', profile_pic_url: null },
    9000000003: { name: 'Never Bought', profile_pic_url: null },
  };
  ORDERS = [
    { phone_norm: '9000000001', status: 'PAID' },
    { phone_norm: '9000000002', status: 'PAID' },
    { phone_norm: '9000000003', status: 'CREATED' },   // opened a cart, never paid
  ];
};

const mockDb = {
  ENABLED: true,
  query: async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); const p = params || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    const gone = () => { const e = new Error("Table 'x.reviews' doesn't exist"); e.errno = 1146; throw e; };
    if (/FROM reviews|INTO reviews|UPDATE reviews|DELETE FROM reviews/.test(q) && noTable) gone();

    if (/^SELECT id FROM reviews LIMIT 1$/.test(q)) return ROWS.slice(0, 1);
    if (/^SELECT name, profile_pic_url FROM customers WHERE phone_norm = \?/.test(q)) {
      const c = CUSTOMERS[p[0]]; return c ? [Object.assign({}, c)] : [];
    }
    if (/^SELECT COUNT\(\*\) n FROM orders WHERE phone_norm = \? AND UPPER\(COALESCE\(status, ''\)\) = 'PAID'$/.test(q)) {
      return [{ n: ORDERS.filter((o) => o.phone_norm === p[0] && o.status === 'PAID').length }];
    }
    if (/^SELECT id, name, avatar_url, rating, service, text, reply, replied_at, created_at FROM reviews WHERE status = 'visible'/.test(q)) {
      return ROWS.filter((r) => r.status === 'visible').sort((a, b) => b.id - a.id).map((r) => Object.assign({}, r));
    }
    if (/^SELECT COUNT\(\*\) n, AVG\(rating\) avg FROM reviews WHERE status = 'visible'$/.test(q)) {
      const v = ROWS.filter((r) => r.status === 'visible');
      return [{ n: v.length, avg: v.length ? v.reduce((a, r) => a + r.rating, 0) / v.length : null }];
    }
    if (/^SELECT id, rating, service, text, status, reply, replied_at, created_at FROM reviews WHERE phone_norm = \?/.test(q)) {
      const r = ROWS.find((x) => x.phone_norm === p[0]); return r ? [Object.assign({}, r)] : [];
    }
    if (/^INSERT INTO reviews/.test(q)) {
      const [phone_norm, name, avatar_url, rating, service, text, status, reason, ip_hash, created_at] = p;
      const existing = ROWS.find((r) => r.phone_norm === phone_norm);
      if (existing) {
        // ON DUPLICATE KEY UPDATE — note the reply is cleared, exactly as the SQL says.
        Object.assign(existing, { name, avatar_url, rating, service, text, status, reason, reply: null, replied_at: null, updated_at: created_at });
        return { affectedRows: 2 };
      }
      ROWS.push({ id: nextId++, phone_norm, name, avatar_url, rating, service, text, status, reason, ip_hash, created_at, reply: null, replied_at: null, updated_at: null });
      return { affectedRows: 1, insertId: nextId - 1 };
    }
    if (/^SELECT \* FROM reviews WHERE status = \?/.test(q)) return ROWS.filter((r) => r.status === p[0]).sort((a, b) => b.id - a.id).map((r) => Object.assign({}, r));
    if (/^SELECT \* FROM reviews ORDER BY id DESC/.test(q)) return ROWS.slice().sort((a, b) => b.id - a.id).map((r) => Object.assign({}, r));
    if (/^SELECT status, COUNT\(\*\) n FROM reviews GROUP BY status$/.test(q)) {
      const by = {}; for (const r of ROWS) by[r.status] = (by[r.status] || 0) + 1;
      return Object.entries(by).map(([status, n]) => ({ status, n }));
    }
    if (/^UPDATE reviews SET reply = \?, replied_at = \? WHERE id = \?/.test(q)) {
      const r = ROWS.find((x) => x.id === p[2]); if (!r) return { affectedRows: 0 };
      r.reply = p[0]; r.replied_at = p[1]; return { affectedRows: 1 };
    }
    if (/^UPDATE reviews SET reply = NULL, replied_at = NULL WHERE id = \?/.test(q)) {
      const r = ROWS.find((x) => x.id === p[0]); if (!r) return { affectedRows: 0 };
      r.reply = null; r.replied_at = null; return { affectedRows: 1 };
    }
    if (/^UPDATE reviews SET status = \? WHERE id = \?/.test(q)) {
      const r = ROWS.find((x) => x.id === p[1]); if (!r) return { affectedRows: 0 };
      r.status = p[0]; return { affectedRows: 1 };
    }
    if (/^DELETE FROM reviews WHERE id = \?/.test(q)) {
      const i = ROWS.findIndex((x) => x.id === p[0]); if (i < 0) return { affectedRows: 0 };
      ROWS.splice(i, 1); return { affectedRows: 1 };
    }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 160));
  },
  getPool: () => null,
};

const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
const reviews = require('../reviews');
Module._load = origLoad;
reviews._internal.deps.now = () => NOW;

const fresh = () => { reset(); reviews._internal.reset(); };

(async () => {
  // ── who may write one ────────────────────────────────────────────────────────────────────────────────────
  section('only a paying customer can review us');
  fresh();
  let r = await reviews.add('9000000001', 5, 'The login arrived in under a minute.', '');
  ok('a customer who has paid can', r.ok && r.status === 'visible', r);
  fresh();
  r = await reviews.add('9000000003', 5, 'Best service ever, totally genuine.', '');
  ok('🔒 somebody who opened a cart and never paid CANNOT', r.ok === false && r.notACustomer === true, r);
  ok('…and nothing was written', ROWS.length === 0);
  r = await reviews.add('9999999999', 5, 'I am a stranger and this is great.', '');
  ok('🔒 a phone we have never seen cannot', r.ok === false && r.needsLogin === true, r);
  r = await reviews.add('', 5, 'No login at all.', '');
  ok('🔒 no phone at all cannot', r.ok === false && r.needsLogin === true, r);

  section('one review per customer');
  fresh();
  await reviews.add('9000000001', 5, 'Really good, no problems at all.', '');
  await reviews.add('9000000001', 4, 'Changed my mind, it is good not perfect.', '');
  ok('🔒 writing again REPLACES, it never stacks', ROWS.length === 1 && ROWS[0].rating === 4, ROWS);
  ok('…and the new words are the ones kept', /Changed my mind/.test(ROWS[0].text));
  await reviews.add('9000000002', 5, 'Renewed three times now, always smooth.', '');
  ok('a different customer gets their own', ROWS.length === 2);

  // ── what the public sees ─────────────────────────────────────────────────────────────────────────────────
  section('what a visitor is shown');
  fresh();
  await reviews.add('9000000001', 5, 'Netflix arrived in under a minute.', 'Netflix');
  await reviews.add('9000000002', 4, 'Good price and renewals are easy.', '');
  let pub = await reviews.list({ fresh: true });
  ok('the reviews are listed, newest first', pub.ok && pub.ready && pub.reviews.length === 2 && pub.reviews[0].name === 'Keshav', pub.reviews.map((x) => x.name));
  ok('the average is rounded to one place', pub.count === 2 && pub.average === 4.5, pub);
  ok('the name is first name + last initial, never the whole name', pub.reviews[1].name === 'Harsh W.', pub.reviews[1].name);
  const blob = JSON.stringify(pub);
  ok('🔒 no phone number in what the storefront is sent', !/9000000\d{3}/.test(blob), blob.slice(0, 200));
  ok('🔒 no IP hash leaks out either', !/ip_hash|ipHash/.test(blob));
  ok('the row carries only what a review needs', Object.keys(pub.reviews[0]).sort().join() === 'at,avatar,id,name,rating,repliedAt,reply,service,text', Object.keys(pub.reviews[0]).sort());

  // ── moderation ───────────────────────────────────────────────────────────────────────────────────────────
  section('moderation is the same one the feed comments use');
  fresh();
  r = await reviews.add('9000000001', 5, 'Great service, ping me on 9876543210 for cheaper', '');
  ok('🔒 a phone number in the text is refused, not published', r.ok === false && r.blocked === true, r);
  ok('…and nothing was stored', ROWS.length === 0);
  r = await reviews.add('9000000001', 5, 'Message me on whatsapp for a better deal', '');
  ok('🔒 someone touting their own selling is refused', r.ok === false, r);
  r = await reviews.add('9000000001', 5, '', '');
  ok('an empty review is refused gently', r.ok === false && r.blocked !== true, r);
  r = await reviews.add('9000000001', 5, 'x'.repeat(400), '');
  ok('🔒 an over-long review is refused rather than silently cut', r.ok === false, r);
  // Known and deliberate: feedmod treats "cheap" as a selling signal, because on the 🍿 feed it usually is.
  // In a review it is usually a compliment, so the review is HELD for the owner, never thrown away.
  fresh();
  r = await reviews.add('9000000001', 5, 'Cheap and it arrived in a minute.', '');
  ok('a review saying "cheap" is HELD for the owner, not refused', r.ok === true && r.status === 'pending', r);
  ok('🔒 and it is not on the site until the owner lets it through', (await reviews.list({ fresh: true })).reviews.length === 0);
  ok('🔒 the customer is told about their REVIEW, not their "comment"', /review/i.test(r.message) && !/comment/i.test(r.message), r.message);
  r = await reviews.setStatus(ROWS[0].id, 'visible');
  ok('one tap publishes it', r.ok && (await reviews.list({ fresh: true })).reviews.length === 1);

  section('stars');
  fresh();
  ok('0 stars is not a rating', (await reviews.add('9000000001', 0, 'Fine.', '')).ok === false);
  ok('6 stars is not a rating', (await reviews.add('9000000001', 6, 'Fine.', '')).ok === false);
  ok('nonsense is not a rating', (await reviews.add('9000000001', 'five', 'Fine.', '')).ok === false);
  ok('1 to 5 are', (await reviews.add('9000000001', 1, 'Took a while to arrive honestly.', '')).ok === true);
  ok('🔒 a one-star review is published like any other — a wall of only fives is not proof',
    ROWS[0].status === 'visible' && ROWS[0].rating === 1, ROWS[0]);

  // ── the owner's reply ────────────────────────────────────────────────────────────────────────────────────
  section('the owner replies underneath');
  fresh();
  await reviews.add('9000000001', 2, 'My plan took two days to arrive.', '');
  const id = ROWS[0].id;
  r = await reviews.reply(id, 'Sorry about that — we were out of stock that week. Fixed now.');
  ok('the reply is saved', r.ok && /Sorry about that/.test(ROWS[0].reply), r);
  pub = await reviews.list({ fresh: true });
  ok('…and the visitor sees it under the review', pub.reviews[0].reply === 'Sorry about that — we were out of stock that week. Fixed now.' && pub.reviews[0].repliedAt === '2026-10-01', pub.reviews[0]);
  r = await reviews.reply(id, '');
  ok('an empty reply removes it', r.ok && ROWS[0].reply === null && ROWS[0].replied_at === null);
  await reviews.reply(id, 'We fixed the stock problem.');
  await reviews.add('9000000001', 5, 'They sorted it out, all good now.', '');
  ok('🔒 REWRITING the review drops the old reply — an answer to different words must not sit under new ones',
    ROWS[0].reply === null && /sorted it out/.test(ROWS[0].text), ROWS[0]);
  ok('a reply to a review that is gone says so', (await reviews.reply(9999, 'hello')).ok === false);
  ok('a reply with no id is refused', (await reviews.reply(0, 'hello')).ok === false);

  // ── admin ────────────────────────────────────────────────────────────────────────────────────────────────
  section('the owner can hold, hide and delete');
  fresh();
  await reviews.add('9000000001', 5, 'All good here.', '');
  await reviews.add('9000000002', 3, 'It is okay.', '');
  r = await reviews.setStatus(ROWS[0].id, 'hidden');
  ok('hiding one takes it off the site', r.ok && (await reviews.list({ fresh: true })).reviews.length === 1, r);
  ok('🔒 and the average is recomputed from what is actually shown', (await reviews.list({ fresh: true })).average === 3);
  ok('a made-up status is refused', (await reviews.setStatus(ROWS[0].id, 'lovely')).ok === false);
  let a = await reviews.adminList({ status: 'all' });
  ok('admin sees everything, hidden ones too', a.ok && a.reviews.length === 2 && a.counts.hidden === 1, a.counts);
  ok('admin DOES see the phone — it is their own panel', a.reviews.some((x) => x.phone === '9000000001'), a.reviews[0]);
  r = await reviews.remove(ROWS[0].id);
  ok('deleting works and says the customer may write again', r.ok && /write a new one/.test(r.message), r);
  ok('deleting something that is gone says so', (await reviews.remove(99999)).ok === false);

  section('what the customer sees of their own');
  fresh();
  await reviews.add('9000000001', 4, 'Pretty good overall.', '');
  let m = await reviews.mine('9000000001');
  ok('their own review comes back so the box can be pre-filled', m.ok && m.review.rating === 4 && m.canWrite === true, m);
  m = await reviews.mine('9000000003');
  ok('🔒 somebody who never paid is told they cannot write one', m.ok && m.review === null && m.canWrite === false, m);
  ok('no phone, no answer', (await reviews.mine('')).needsLogin === true);

  // ── before the schema is run ─────────────────────────────────────────────────────────────────────────────
  section('before db/schema-v34.sql has been run');
  fresh(); noTable = true;
  pub = await reviews.list({ fresh: true });
  ok('🔒 reading says "not ready" instead of throwing at the home screen', pub.ok === true && pub.ready === false && pub.reviews.length === 0, pub);
  r = await reviews.add('9000000001', 5, 'Great.', '');
  ok('writing says so plainly', r.ok === false && r.notReady === true, r);
  a = await reviews.adminList({});
  ok('admin is told WHICH file to run', a.ok && a.ready === false && a.schemaFile === 'db/schema-v34.sql', a);

  // ── promises in the code ─────────────────────────────────────────────────────────────────────────────────
  section('the code');
  const src = fs.readFileSync(path.join(__dirname, '..', 'reviews.js'), 'utf8');
  const nocomment = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('🔒 no query joins reviews to orders or customers — they do not share a collation',
    !/FROM reviews[\s\S]{0,200}JOIN (orders|customers)|FROM (orders|customers)[\s\S]{0,200}JOIN reviews/i.test(nocomment));
  ok('🔒 the public row is built by one function, so a new column cannot leak by accident',
    (nocomment.match(/function publicRow/g) || []).length === 1 && !/phone_norm/.test(nocomment.split('function publicRow')[1].split('}')[0]));
  ok('🔒 the IP is only ever stored as a salted hash', /createHash\('sha256'\)\.update\(SALT/.test(nocomment) && !/ip_hash.{0,40}=.{0,20}ip\b/.test(nocomment));
  ok('rewriting a review clears the reply in the SQL itself', /reply = NULL, replied_at = NULL/.test(nocomment));
  ok('moderation is the shared module, not a copy', /require\('\.\/feedmod'\)/.test(nocomment) && !/ABUSE|BAD_WORDS/.test(nocomment));
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v34.sql'), 'utf8');
  ok('🔒 the table itself enforces one review per customer', /UNIQUE KEY uq_reviews_phone \(phone_norm\)/.test(schema));
  ok('…and uses the collation the other new tables use', /utf8mb4_unicode_ci/.test(schema));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('the block is drawn on Home and on the dashboard', (html.match(/React\.createElement\(ReviewsWall, \{/g) || []).length === 2);
  ok('…and draws nothing until the server answers', /if \(!data \|\| !rows\.length && !canWrite\) return null;/.test(html));
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('every new action has a rate limit', /getReviews: security\.rateLimiter/.test(sv) && /addReview: security\.rateLimiter/.test(sv));
  const ca = fs.readFileSync(path.join(__dirname, '..', 'customerauth.js'), 'utf8');
  ok('🔒 reading is public, writing needs the caller\'s own phone session', /getReviews: P/.test(ca) && /addReview: S\(0\)/.test(ca));
  ok('package.json runs this test', /node test\/customer-reviews\.test\.js/.test(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')));

  console.log('\n---------------------------------------');
  console.log('customer-reviews: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
