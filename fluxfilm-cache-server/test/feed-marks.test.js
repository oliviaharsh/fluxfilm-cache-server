/* ❤️ 🔖 Liked / saved posts per customer account (feedmarks.js + db/schema-v25.sql), the server wiring, the admin note,
   share preview for /?reel=, and the storefront overlay back-stack (ffMakeLayers_ in index.html) with a fake history.
   DB and feed are mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- in-memory DB: customers + feed_likes + feed_saves + feed_comments ----------
const T = { tables: true, comments: true, customers: new Set(['9876543210', '9123456789']), rows: { feed_likes: [], feed_saves: [] }, comm: [], sql: [] };
const missing = (name) => { const e = new Error("Table 'u.fx." + name + "' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; e.errno = 1146; return e; };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    T.sql.push({ sql, p });
    let m;
    if ((m = sql.match(/^SELECT post_id FROM (feed_likes|feed_saves) LIMIT 1$/))) { if (!T.tables) throw missing(m[1]); return T.rows[m[1]].slice(0, 1); }
    if (sql === 'SELECT phone_norm FROM customers WHERE phone_norm = ? LIMIT 1') return T.customers.has(p[0]) ? [{ phone_norm: p[0] }] : [];
    if (sql === 'SELECT post_id, COUNT(*) AS n FROM feed_likes GROUP BY post_id') { if (!T.tables) throw missing('feed_likes'); const o = {}; T.rows.feed_likes.forEach((x) => { o[x.post_id] = (o[x.post_id] || 0) + 1; }); return Object.entries(o).map(([post_id, n]) => ({ post_id, n })); }
    if ((m = sql.match(/^SELECT COUNT\(\*\) AS n FROM (feed_likes|feed_saves) WHERE phone_norm = \?$/))) return [{ n: T.rows[m[1]].filter((r) => r.phone_norm === p[0]).length }];
    if ((m = sql.match(/^SELECT COUNT\(\*\) AS n FROM (feed_likes|feed_saves)$/))) { if (!T.tables) throw missing(m[1]); return [{ n: T.rows[m[1]].length }]; }
    if ((m = sql.match(/^SELECT post_id FROM (feed_likes|feed_saves) WHERE phone_norm = \? AND post_id = \? LIMIT 1$/))) return T.rows[m[1]].filter((r) => r.phone_norm === p[0] && r.post_id === p[1]);
    if ((m = sql.match(/^INSERT IGNORE INTO (feed_likes|feed_saves) \(phone_norm, post_id, created_at\) VALUES (\(\?, \?, \?\)(, \(\?, \?, \?\))*)$/))) {
      let n = 0;
      for (let i = 0; i < p.length; i += 3) { if (!T.rows[m[1]].some((r) => r.phone_norm === p[i] && r.post_id === p[i + 1])) { T.rows[m[1]].push({ phone_norm: p[i], post_id: p[i + 1], created_at: p[i + 2], seq: T.sql.length + i }); n++; } }
      return { affectedRows: n };
    }
    if ((m = sql.match(/^DELETE FROM (feed_likes|feed_saves) WHERE phone_norm = \? AND post_id = \?$/))) {
      const before = T.rows[m[1]].length; T.rows[m[1]] = T.rows[m[1]].filter((r) => !(r.phone_norm === p[0] && r.post_id === p[1]));
      return { affectedRows: before - T.rows[m[1]].length };
    }
    if ((m = sql.match(/^SELECT post_id FROM (feed_likes|feed_saves) WHERE phone_norm = \? ORDER BY created_at DESC, post_id LIMIT (\d+)$/))) {
      return T.rows[m[1]].filter((r) => r.phone_norm === p[0]).sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : b.seq - a.seq)).slice(0, Number(m[2]));
    }
    if (/^SELECT post_id, MAX\(id\) AS last_id FROM feed_comments WHERE phone_norm = \? AND status <> \? GROUP BY post_id ORDER BY last_id DESC LIMIT \d+$/.test(sql)) {
      if (!T.comments) throw missing('feed_comments');
      const by = {}; T.comm.filter((c) => c.phone_norm === p[0] && c.status !== p[1]).forEach((c) => { by[c.post_id] = Math.max(by[c.post_id] || 0, c.id); });
      return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([post_id, last_id]) => ({ post_id, last_id }));
    }
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const marks = require('../feedmarks');

// ---------- fake feed ----------
const LIVE = ['fp000000000a', 'fp000000000b', 'fp000000000c', 'fp000000000d'];
const posts = LIVE.map((id) => ({ id, active: true })).concat([{ id: 'fp00000000ff', active: false }]);
const likeCounts = [];
marks._internal.setFeed({ list: async () => posts, statusOf: (p) => (p.active ? 'LIVE' : 'OFF'), countLike: (id, d) => likeCounts.push([id, d]) });
const ME = '9876543210';
const OTHER = '9123456789';

(async () => {
  // ================= 1. before schema-v25 =================
  T.tables = false; marks._internal.reset();
  let r = await marks.list(ME);
  ok('no schema-v25: list answers ready:false with empty lists (storefront keeps device saves)', r.ok === true && r.ready === false && r.saved.length === 0 && r.liked.length === 0 && /this phone/.test(r.message), r);
  r = await marks.set(ME, LIVE[0], 'save', true);
  ok('no schema-v25: save answers notReady (no insert tried)', r.ok === false && r.notReady === true && !T.sql.some((x) => /^INSERT/.test(x.sql)), r);
  r = await marks.importLocal(ME, { saved: [LIVE[0]] });
  ok('no schema-v25: import answers ready:false, imports nothing', r.ok && r.ready === false && r.imported.saved === 0, r);
  let info = await marks.adminInfo();
  ok('admin info: ready false before schema-v25', info.ready === false, info);
  const adminHtml = read('admin.html');
  ok('admin 🍿 What\'s new shows the "run db/schema-v25.sql" note when not ready (and totals when ready)', /FD\.marksReady = r\.marksReady !== false;/.test(adminHtml) && /Run <b>db\/schema-v25\.sql<\/b> in phpMyAdmin once/.test(adminHtml) && /account likes · 🔖 ' \+ \(FD\.marksCounts\.saves \|\| 0\)/.test(adminHtml));
  ok('admin feed API returns marksReady + marksCounts from feedmarks.adminInfo()', /marksReady: !!mk\.ready, marksCounts:/.test(read('adminfeed.js')) && /marks\.adminInfo\(\)\.catch\(/.test(read('adminfeed.js')));

  // ================= 2. validation =================
  T.tables = true; marks._internal.reset(); T.sql = [];
  ok('schema-v25: plain CREATE TABLE IF NOT EXISTS for both tables, primary key (phone, post), no information_schema / PREPARE', (() => { const q = read('db/schema-v25.sql').replace(/^--.*$/gm, ''); return /CREATE TABLE IF NOT EXISTS feed_likes \(/.test(q) && /CREATE TABLE IF NOT EXISTS feed_saves \(/.test(q) && (q.match(/PRIMARY KEY \(phone_norm, post_id\)/g) || []).length === 2 && !/information_schema|PREPARE|EXECUTE/i.test(q); })());
  r = await marks.set('12345', LIVE[0], 'save', true);
  ok('short phone → needsLogin', r.ok === false && r.needsLogin === true, r);
  r = await marks.set('', LIVE[0], 'like', true);
  ok('no phone → needsLogin', r.needsLogin === true);
  r = await marks.set('5550001111', LIVE[0], 'save', true);
  ok('phone that is not a customer → needsLogin, nothing written', r.needsLogin === true && !T.rows.feed_saves.length, r);
  for (const bad of ['fp1', 'FP000000000A', 'fp000000000a;DROP', "fp000000000a' OR 1=1", '../fp000000000a', null, 42, { id: LIVE[0] }]) {
    r = await marks.set(ME, bad, 'save', true);
    ok('bad post id rejected: ' + JSON.stringify(bad), r.ok === false && /Post not found/.test(r.message), r);
  }
  for (const bad of ['comment', 'LIKE', '', 'feed_saves', '__proto__', 'constructor', 'toString']) {
    r = await marks.set(ME, LIVE[0], bad, true);
    ok('unknown kind rejected (no table name from input): ' + JSON.stringify(bad), r.ok === false && /Unknown action/.test(r.message), r);
  }
  ok('no SQL ever built with a table name other than the two known ones', T.sql.every((x) => !/FROM (?!feed_likes|feed_saves|customers|feed_comments)\w+|INTO (?!feed_likes|feed_saves)\w+/.test(x.sql)));
  r = await marks.set(ME, 'fp00000000ff', 'save', true);
  ok('saving a post that is not LIVE is refused', r.ok === false && /not available/.test(r.message), r);

  // ================= 3. save / unsave / like, phone scoping =================
  r = await marks.set('+91 98765-43210', LIVE[0], 'save', true);
  ok('save: +91 / spaces / dashes normalised to the last 10 digits, row written', r.ok && r.on === true && r.changed === true && T.rows.feed_saves.length === 1 && T.rows.feed_saves[0].phone_norm === ME, r);
  r = await marks.set(ME, LIVE[0], 'save', 'true');
  ok('save twice → ok, not changed (INSERT IGNORE)', r.ok && r.on && r.changed === false && T.rows.feed_saves.length === 1, r);
  await marks.set(ME, LIVE[1], 'save', true);
  await marks.set(OTHER, LIVE[2], 'save', true);
  r = await marks.list(ME);
  ok('list: only MY saves, newest first', r.ok && r.ready && JSON.stringify(r.saved) === JSON.stringify([LIVE[1], LIVE[0]]) && !r.saved.includes(LIVE[2]), r);
  r = await marks.list(OTHER);
  ok('other phone sees only its own', JSON.stringify(r.saved) === JSON.stringify([LIVE[2]]), r);
  r = await marks.set(OTHER, LIVE[0], 'save', false);
  ok('unsave by another phone does not touch my row', r.ok && r.changed === false && T.rows.feed_saves.some((x) => x.phone_norm === ME && x.post_id === LIVE[0]), r);
  ok('every feed_saves / feed_likes query is scoped by phone_norm (except the admin totals)', T.sql.filter((x) => /(feed_saves|feed_likes)/.test(x.sql) && !/LIMIT 1$/.test(x.sql) && !/^SELECT COUNT\(\*\) AS n FROM feed_(likes|saves)$/.test(x.sql)).every((x) => /phone_norm = \?|^INSERT IGNORE/.test(x.sql)));
  r = await marks.set(ME, LIVE[0], 'save', false);
  ok('unsave: row removed', r.ok && r.on === false && r.changed === true && !T.rows.feed_saves.some((x) => x.phone_norm === ME && x.post_id === LIVE[0]), r);
  r = await marks.set(ME, 'fp00000000ff', 'save', false);
  ok('unsave of a hidden post is allowed (clean-up)', r.ok && r.on === false, r);

  likeCounts.length = 0;
  r = await marks.set(ME, LIVE[3], 'like', true);
  const second = await marks.set(ME, LIVE[3], 'like', true);
  let lc = await marks.likeCounts();
  ok('like: liking twice counts ONCE (count = unique rows; second tap changes nothing)', r.changed && second.changed === false && lc[LIVE[3]] === 1 && T.rows.feed_likes.filter((x) => x.post_id === LIVE[3]).length === 1, lc);
  marks._internal.reset(); // server restart / redeploy: every in-memory cache gone
  await marks.set('+91 ' + ME, LIVE[3], 'like', 'true');
  lc = await marks.likeCounts();
  ok('after a restart the same phone still cannot like again (row already there) — count stays 1', lc[LIVE[3]] === 1, lc);
  await marks.set(OTHER, LIVE[3], 'like', true);
  lc = await marks.likeCounts();
  ok('two phones = two likes', lc[LIVE[3]] === 2, lc);
  await marks.set(ME, LIVE[3], 'like', false);
  await marks.set(ME, LIVE[3], 'like', false);
  await marks.set(OTHER, LIVE[3], 'like', false);
  lc = await marks.likeCounts();
  ok('unlike is idempotent too; count back to 0 (never negative); old per-device counter not used', !lc[LIVE[3]] && likeCounts.length === 0, { lc, likeCounts });
  await marks.set(ME, LIVE[2], 'like', 1);
  r = await marks.list(ME);
  ok('list: liked separate from saved', JSON.stringify(r.liked) === JSON.stringify([LIVE[2]]) && !r.saved.includes(LIVE[2]), r);
  ok('on flag: only true / 1 / "1" / "true" mean on', (await marks.set(ME, LIVE[2], 'like', 'yes')).on === false && (await marks.set(ME, LIVE[2], 'like', '1')).on === true);

  // ================= 4. commented posts =================
  T.comm = [{ id: 5, phone_norm: ME, post_id: LIVE[1], status: 'visible' }, { id: 9, phone_norm: ME, post_id: LIVE[3], status: 'pending' }, { id: 7, phone_norm: ME, post_id: LIVE[0], status: 'hidden' }, { id: 8, phone_norm: OTHER, post_id: LIVE[2], status: 'visible' }];
  r = await marks.list(ME);
  ok('💬 my comments: posts I commented on (not hidden ones), newest first, only mine', JSON.stringify(r.commented) === JSON.stringify([LIVE[3], LIVE[1]]), r);
  T.comments = false;
  r = await marks.list(ME);
  ok('comments table missing → commented [] and the rest still works', r.ok && r.ready && r.commented.length === 0 && r.liked.length === 1, r);
  T.comments = true;

  // ================= 5. limits =================
  marks._internal.reset();
  let limited = null;
  for (let i = 0; i < marks.PER_PHONE + 3; i++) { const x = await marks.set(OTHER, LIVE[i % 4], 'save', i % 2 === 0); if (x.rateLimited) { limited = { i, x }; break; } }
  ok('per-phone tap limit (' + marks.PER_PHONE + ' per 10 min) → rateLimited', limited && limited.i === marks.PER_PHONE && /wait/.test(limited.x.message), limited);
  r = await marks.set(ME, LIVE[0], 'save', true);
  ok('…another phone is not limited', r.ok, r);
  marks._internal.reset();
  const saved0 = T.rows.feed_saves.slice();
  T.rows.feed_saves = T.rows.feed_saves.filter((x) => x.phone_norm !== ME);
  for (let i = 0; i < marks.MAX_PER_KIND; i++) T.rows.feed_saves.push({ phone_norm: ME, post_id: 'fp' + (0x100000 + i).toString(16).padStart(10, '0'), created_at: '2026-09-01 10:00:00', seq: i });
  r = await marks.set(ME, LIVE[1], 'save', true);
  ok('max ' + marks.MAX_PER_KIND + ' saves per account → full message, nothing added', r.ok === false && r.full === true && T.rows.feed_saves.filter((x) => x.phone_norm === ME).length === marks.MAX_PER_KIND, r);
  T.rows.feed_saves.push({ phone_norm: ME, post_id: LIVE[2], created_at: '2026-09-01 10:00:00', seq: 999 });
  r = await marks.set(ME, LIVE[2], 'save', true);
  ok('…re-saving one that is already saved still answers ok', r.ok && r.changed === false, r);
  r = await marks.list(ME);
  ok('list is capped at 500 ids', r.saved.length === 500, r.saved.length);
  T.rows.feed_saves = saved0;

  // ================= 6. import local saves on first login =================
  marks._internal.reset();
  T.rows.feed_likes = []; T.rows.feed_saves = [];
  likeCounts.length = 0;
  const many = Array.from({ length: 300 }, (_, i) => 'fp' + String(i).padStart(10, '0'));
  r = await marks.importLocal(ME, { saved: [LIVE[0], LIVE[0], 'bad', LIVE[1], 'fp00000000ff'].concat(many), liked: [LIVE[2], "x' OR 1"] });
  ok('import: valid LIVE ids only (dupes / bad / hidden / unknown dropped), likes NOT counted again', r.ok && r.imported.saved === 2 && r.imported.liked === 1 && likeCounts.length === 0 && T.rows.feed_saves.length === 2, r);
  ok('import: answers the fresh lists', r.ready && r.saved.length === 2 && r.liked.length === 1 && r.saved.includes(LIVE[0]), r);
  r = await marks.importLocal(ME, { saved: [LIVE[0], LIVE[3]] });
  ok('import again: already there is ignored, new one added', r.imported.saved === 1 && T.rows.feed_saves.length === 3, r);
  ok('import: one multi-row INSERT IGNORE per kind, capped at ' + marks.IMPORT_MAX + ' ids read', T.sql.filter((x) => /^INSERT IGNORE INTO feed_saves/.test(x.sql)).every((x) => x.p.length / 3 <= marks.IMPORT_MAX));
  r = await marks.importLocal('5550001111', { saved: [LIVE[0]] });
  ok('import for a non-customer phone → needsLogin', r.needsLogin === true, r);
  r = await marks.importLocal(ME, 'nonsense');
  ok('import with junk input → ok, nothing imported', r.ok && r.imported.saved === 0 && r.imported.liked === 0, r);
  info = await marks.adminInfo();
  ok('admin info: ready + totals', info.ready === true && info.saves === 3 && info.likes === 1, info);

  // ================= 7. feed.js countLike + server wiring =================
  const feedSrc = read('feed.js');
  ok('feed.countLike exported, ±1 into the pending likes (written with the other stats)', /function countLike\(id, delta\)/.test(feedSrc) && /record, countLike, flushStats/.test(feedSrc) && /cur\.likes \+= d;/.test(feedSrc));
  const srv = read('server.js');
  ok('server: setFeedMark / getFeedMarks / importFeedMarks are storefront actions with IP + phone limits', /setFeedMark: \(a\) => feedMarksMod\.set\(a\[0\], a\[1\], a\[2\], a\[3\]\)/.test(srv) && /getFeedMarks: \(a\) => feedMarksMod\.list\(a\[0\]\)/.test(srv) && /importFeedMarks: \(a\) => feedMarksMod\.importLocal\(a\[0\], a\[1\]\)/.test(srv) && /DB_STOREFRONT_ACTIONS\.add\('setFeedMark'\)/.test(srv) && /PHONE_LIMITS\.setFeedMark = /.test(srv) && /PHONE_LIMITS\.importFeedMarks = /.test(srv) && /LIMITS\.getFeedMarks = /.test(srv));
  ok('npm test runs this suite', /node test\/feed-marks\.test\.js/.test(require('../package.json').scripts.test));

  // ================= 8. share preview for /?reel= =================
  const share = require('../share');
  const pid = share._internal.postIdOf;
  ok('share card: /?reel=<id> maps to the post card; post wins; bad values ignored', pid({ reel: LIVE[0] }) === LIVE[0] && pid({ post: LIVE[1], reel: LIVE[0] }) === LIVE[1] && pid({ post: 'bad', reel: LIVE[0] }) === LIVE[0] && pid({ reel: ['fp000000000a'] }) === '' && pid({ reel: 'fp000000000a<' }) === '' && pid({}) === '');

  // ================= 9. storefront: overlay back-stack with a fake history =================
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((x) => !/application\/(ld\+)?json/.test(x[0]));
  let parseErr = ''; for (const sc of scripts) { try { new Function(sc[1]); } catch (e) { parseErr = e.message; } }
  ok('index.html: all inline <script> blocks parse', !parseErr, parseErr);
  const a0 = html.indexOf('function ffMakeLayers_('); const a1 = html.indexOf('// ffMakeLayers_ end');
  ok('ffMakeLayers_ found', a0 > 0 && a1 > a0);
  const make = new Function(html.slice(a0, a1) + '; return ffMakeLayers_;')();
  function fakeWin(initialState) {
    const w = { entries: [{ state: initialState === undefined ? null : initialState }], i: 0, listeners: [], queue: [], exits: 0 };
    w.history = {
      get state() { return w.entries[w.i].state; },
      pushState(st) { w.entries = w.entries.slice(0, w.i + 1); w.entries.push({ state: JSON.parse(JSON.stringify(st)) }); w.i++; },
      replaceState(st) { w.entries[w.i] = { state: JSON.parse(JSON.stringify(st)) }; },
      go(n) { w.queue.push(n); },
      back() { w.queue.push(-1); },
    };
    w.addEventListener = (ev, fn) => { if (ev === 'popstate') w.listeners.push(fn); };
    // Deliver queued traversals like a browser: async, one popstate each.
    w.flush = () => { let guard = 0; while (w.queue.length && guard++ < 50) { const n = w.queue.shift(); const to = w.i + n; if (to < 0) { w.exits++; w.i = 0; } else w.i = Math.min(to, w.entries.length - 1); w.listeners.forEach((f) => f({ state: w.entries[w.i].state })); } };
    w.back = () => { w.history.back(); w.flush(); };
    return w;
  }
  const tick = [];
  const later = (f) => tick.push(f);
  const run = (w) => { let g = 0; while ((tick.length || w.queue.length) && g++ < 50) { while (tick.length) tick.shift()(); w.flush(); } };

  let w = fakeWin(); let L = make(w, later); let closed = [];
  const reels = L.push(() => closed.push('reels')); run(w);
  ok('stack: opening Reels pushes ONE history entry', w.entries.length === 2 && w.i === 1 && w.history.state.ffLayer === 1, w.entries);
  L.push(() => closed.push('comments')); run(w);
  ok('stack: comments on top → second entry (depth 2)', w.i === 2 && w.history.state.ffLayer === 2);
  w.back(); run(w);
  ok('Back #1 closes only the comments sheet', JSON.stringify(closed) === '["comments"]' && L.depth() === 1 && w.i === 1, closed);
  w.back(); run(w);
  ok('Back #2 closes Reels → back on the feed entry, site not left', JSON.stringify(closed) === '["comments","reels"]' && L.depth() === 0 && w.i === 0 && w.exits === 0, closed);
  ok('closing an already closed layer is a no-op', L.close(reels) === false);

  // feed → menu → grid (same layer) → post → Back, Back
  w = fakeWin(); L = make(w, later); closed = [];
  L.push(() => closed.push('library')); run(w);
  L.push(() => closed.push('post')); run(w);
  const cm = L.push(() => closed.push('comments')); run(w);
  ok('library → post → comments = 3 entries', w.i === 3 && L.depth() === 3);
  L.close(cm); run(w);
  ok('✕ on comments (programmatic close) removes its entry: history back once, nothing else closed', w.i === 2 && L.depth() === 2 && closed.length === 0, { i: w.i, closed });
  w.back(); run(w);
  ok('Back closes the opened post → the grid is on top again', JSON.stringify(closed) === '["post"]' && w.i === 1);
  w.back(); run(w);
  ok('Back closes the library → feed; one press each, never leaves the site', JSON.stringify(closed) === '["post","library"]' && w.i === 0 && w.exits === 0 && L.depth() === 0);

  // Unmount of a parent + child in the same tick (CTA inside Reels while comments open) → ONE go(-2), then a new layer works.
  w = fakeWin(); L = make(w, later); closed = [];
  const r1 = L.push(() => closed.push('reels')); run(w);
  const c1 = L.push(() => closed.push('comments')); run(w);
  const goes = []; const og = w.history.go; w.history.go = (n) => { goes.push(n); og(n); };
  L.close(c1); L.close(r1); run(w);
  ok('child + parent closed together → a single history.go(-2), back on the feed entry', JSON.stringify(goes) === '[-2]' && w.i === 0 && closed.length === 0, goes);
  L.close(r1); L.push(() => closed.push('menu')); run(w);
  ok('a layer opened right after closing waits for the back to finish (no lost entry)', w.i === 1 && w.history.state.ffLayer === 1 && w.entries.length === 2);
  w.back(); run(w);
  ok('…and Back closes it', JSON.stringify(closed) === '["menu"]' && w.i === 0);

  // Close + open in the SAME tick (grid → open post replaces nothing; close menu then open reels)
  w = fakeWin(); L = make(w, later); closed = [];
  const m1 = L.push(() => closed.push('menu')); run(w);
  L.close(m1); L.push(() => closed.push('reels'));
  run(w);
  ok('close + open in one tick: net ONE entry for the new layer', w.i === 1 && w.entries[1].state.ffLayer === 1 && L.depth() === 1, { i: w.i, e: w.entries });
  w.back(); run(w);
  ok('…Back closes the new layer in one press', JSON.stringify(closed) === '["reels"]' && w.i === 0 && w.exits === 0);

  // Open + close before the entry was even pushed → no history change at all
  w = fakeWin(); L = make(w, later);
  const q1 = L.push(() => {}); L.close(q1); run(w);
  ok('open + close in the same tick → history untouched', w.entries.length === 1 && w.i === 0 && w.queue.length === 0);

  // Stale entries after a reload (state still says ffLayer 2) → cleaned so the next Back is not wasted
  w = fakeWin({ ffLayer: 2, other: 'x' }); L = make(w, later); closed = [];
  ok('reload on a stale layer entry: state cleaned (other keys kept)', w.history.state.ffLayer === undefined && w.history.state.other === 'x');
  L.push(() => closed.push('sheet')); run(w);
  w.back(); run(w);
  ok('…first Back after reload closes the new sheet', JSON.stringify(closed) === '["sheet"]' && w.i === 0);
  // An old entry with ffLayer below the page (from before a reload) is skipped automatically
  w = fakeWin(); w.entries = [{ state: null }, { state: { ffLayer: 1 } }, { state: null }]; w.i = 2; L = make(w, later);
  w.back(); run(w);
  ok('Back onto a stale ffLayer entry with nothing open → skipped to the page below (no dead press)', w.i === 0, w.i);
  // Forward after closing → sent back (a closed layer never comes back empty)
  w = fakeWin(); L = make(w, later); closed = [];
  L.push(() => closed.push('x')); run(w); w.back(); run(w);
  w.history.go(1); w.flush(); run(w);
  ok('Forward onto a closed layer entry → returned to the feed entry', w.i === 0 && L.depth() === 0);
  // A layer whose close handler throws does not break the stack
  w = fakeWin(); L = make(w, later);
  L.push(() => { throw new Error('boom'); }); run(w); w.back(); run(w);
  ok('a throwing onBack still closes the layer', L.depth() === 0 && w.i === 0);

  // ================= 10. storefront wiring (source checks) =================
  ok('comments sheet uses the shared back-stack (no own ffSheet pushState any more)', /function useFFLayer_\(onBack\)/.test(html) && !/ffSheet: 1/.test(html) && /const layerClose = useFFLayer_\(\(\) => close\(true\)\);/.test(html));
  ok('one global stack on window', /const ffLayers_ = typeof window !== 'undefined' && window\.history && window\.addEventListener \? ffMakeLayers_\(window\) :/.test(html));
  ok('Reels, library (menu / grid), opened post each hold a layer', /function FeedReels\(\{[\s\S]{0,1600}useFFLayer_\(/.test(html) && /function FeedLibrary\(\{[\s\S]{0,1600}useFFLayer_\(/.test(html) && /function FeedPostView\(\{[\s\S]{0,900}useFFLayer_\(/.test(html));
  ok('API: setFeedMark / getFeedMarks / importFeedMarks', /apiCall_\('setFeedMark', \[phone, postId, kind, on\]/.test(html) && /apiCall_\('getFeedMarks', \[phone\]/.test(html) && /apiCall_\('importFeedMarks', \[phone, lists\]/.test(html));
  ok('local saves migrate once per phone (flag in localStorage), device copy kept as the fallback', /'ff_feed_marks_moved_' \+ phone/.test(html) && /API\.importFeedMarks\(phone,/.test(html) && /localStorage\.setItem\('ff_feed_saved'/.test(html));
  ok('deep link /?reel=<id> opens Reels; share from a reel uses ?reel=', /function feedReelFromUrl_\(search\)/.test(html) && /nav\('feed', \{\s*reelId: id\s*\}\)/.test(html) && /'\/\?' \+ \(reel \? 'reel' : 'post'\) \+ '=' \+ encodeURIComponent\(p\.id\)/.test(html));
  ok('Reels: scroll-snap one per screen, YouTube nocookie + playsinline, one embed at a time (active only), next one pre-warmed', /\.ff-reels-list \{[^}]*scroll-snap-type: y mandatory/.test(html) && /\.ff-reel \{[^}]*scroll-snap-align: start/.test(html) && /youtube-nocookie\.com\/embed\/' \+ id \+ '\?autoplay=1&playsinline=1/.test(html) && /const near = Math\.abs\(i - idx\) <= 1;/.test(html) && /i === idx && playing/.test(html) && /feedPrewarm_\(/.test(html));
  ok('own icon set: share = arrow out of a box, all outline SVG with currentColor and one stroke width', /share: 'M12 3\.6v11\.2/.test(html) && /stroke: "currentColor",\s*strokeWidth: 1\.9/.test(html) && !/M21 3\.5 10\.4 14\.1/.test(html));
  ok('double tap to like with a heart burst on posts and in Reels', /function feedTaps_\(/.test(html) && /className: "ff-feed-burst"/.test(html) && /className: "ff-reel-burst"/.test(html));
  ok('reduced motion + ff-lite cover the new animations', /@media \(prefers-reduced-motion: reduce\) \{ \.ff-reels, \.ff-lib, \.ff-lib-sheet/.test(html) && /html\.ff-lite \.ff-reels/.test(html));
  ok('no TMDB mention in the new feed code', !/tmdb/i.test(html.slice(html.indexOf('function ffMakeLayers_('), html.indexOf('function RestoringScreen(')).replace(/^\s*\/\/.*$/gm, '')));

  console.log('\n---------------------------------------');
  console.log('feed-marks: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
