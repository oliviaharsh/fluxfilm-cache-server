/* 💬 Feed comments (feedcomments.js, feedmod.js auto-moderator, admin queue, storefront). In-memory DB — no MySQL, no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const ROOT = path.join(__dirname, '..');

// ---------- in-memory tables ----------
const T = { ready: false, comments: [], bans: [], customers: { 9876543210: { name: 'harsh walia', profile_pic_url: '/profile-photo/0123456789abcdef01234567?v=k1' }, 9123456780: { name: '9123456780', profile_pic_url: 'javascript:alert(1)' }, 9000000001: { name: 'Priya', profile_pic_url: '' } }, nextId: 1, sql: [] };
const noTable = () => Object.assign(new Error("Table 'u.feed_comments' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    T.sql.push(sql);
    if (/feed_comments|feed_bans/.test(sql) && !T.ready) throw noTable();
    let m;
    if (sql === 'SELECT id FROM feed_comments LIMIT 1') return T.comments.slice(0, 1).map((c) => ({ id: c.id }));
    if ((m = sql.match(/^SELECT id, name, avatar_url, text, created_at FROM feed_comments WHERE post_id = \? AND status = \?( AND id < \?)? ORDER BY id DESC LIMIT (\d+)$/))) {
      return T.comments.filter((c) => c.post_id === p[0] && c.status === p[1] && (!m[1] || c.id < p[2])).sort((a, b) => b.id - a.id).slice(0, +m[2]);
    }
    if (sql === 'SELECT post_id, COUNT(*) AS n FROM feed_comments WHERE status = ? GROUP BY post_id') { const o = {}; T.comments.filter((c) => c.status === p[0]).forEach((c) => { o[c.post_id] = (o[c.post_id] || 0) + 1; }); return Object.entries(o).map(([post_id, n]) => ({ post_id, n })); }
    if (sql === 'SELECT name, profile_pic_url FROM customers WHERE phone_norm = ? LIMIT 1') return T.customers[p[0]] ? [T.customers[p[0]]] : [];
    if (sql === 'SELECT phone_norm FROM feed_bans WHERE phone_norm = ? LIMIT 1') return T.bans.filter((b) => b.phone_norm === p[0]);
    if (sql === 'SELECT text FROM feed_comments WHERE phone_norm = ? AND created_at >= ? ORDER BY id DESC LIMIT 30') return T.comments.filter((c) => c.phone_norm === p[0] && c.created_at >= p[1]);
    if (/^INSERT INTO feed_comments \(post_id, phone_norm, name, avatar_url, text, status, reason, ip_hash, created_at\) VALUES/.test(sql)) {
      const row = { id: T.nextId++, post_id: p[0], phone_norm: p[1], name: p[2], avatar_url: p[3], text: p[4], status: p[5], reason: p[6], ip_hash: p[7], created_at: p[8], updated_at: null };
      T.comments.push(row); return { insertId: row.id };
    }
    if ((m = sql.match(/^SELECT id, post_id, phone_norm, name, text, status, reason, created_at, updated_at FROM feed_comments( WHERE (.+))? ORDER BY id DESC LIMIT (\d+)$/))) {
      let rows = T.comments.slice(); let i = 0;
      if (m[2]) for (const part of m[2].split(' AND ')) { const col = part.split(' ')[0]; const v = p[i++]; rows = rows.filter((c) => c[col] === v); }
      return rows.sort((a, b) => b.id - a.id).slice(0, +m[3]);
    }
    if (sql === 'SELECT status, COUNT(*) AS n FROM feed_comments GROUP BY status') { const o = {}; T.comments.forEach((c) => { o[c.status] = (o[c.status] || 0) + 1; }); return Object.entries(o).map(([status, n]) => ({ status, n })); }
    if (sql === 'SELECT post_id, status, COUNT(*) AS n FROM feed_comments GROUP BY post_id, status') { const o = {}; T.comments.forEach((c) => { const k = c.post_id + '|' + c.status; o[k] = (o[k] || 0) + 1; }); return Object.entries(o).map(([k, n]) => ({ post_id: k.split('|')[0], status: k.split('|')[1], n })); }
    if (sql === 'SELECT phone_norm FROM feed_bans') return T.bans.slice();
    if (sql === 'SELECT id, post_id, phone_norm, name, text, status FROM feed_comments WHERE id = ? LIMIT 1') return T.comments.filter((c) => c.id === p[0]);
    if (sql === 'UPDATE feed_comments SET status = ?, updated_at = ? WHERE id = ?') { T.comments.filter((c) => c.id === p[2]).forEach((c) => { c.status = p[0]; c.updated_at = p[1]; }); return {}; }
    if (sql === 'DELETE FROM feed_comments WHERE id = ?') { T.comments = T.comments.filter((c) => c.id !== p[0]); return {}; }
    if (/^INSERT INTO feed_bans \(phone_norm, reason, created_at\) VALUES/.test(sql)) { if (!T.bans.some((b) => b.phone_norm === p[0])) T.bans.push({ phone_norm: p[0], reason: p[1] }); return {}; }
    if (sql === 'UPDATE feed_comments SET status = ?, updated_at = ? WHERE phone_norm = ? AND status <> ?') { T.comments.filter((c) => c.phone_norm === p[2] && c.status !== p[3]).forEach((c) => { c.status = p[0]; }); return {}; }
    if (sql === 'DELETE FROM feed_bans WHERE phone_norm = ?') { T.bans = T.bans.filter((b) => b.phone_norm !== p[0]); return {}; }
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

const mod = require('../feedmod');
const comments = require('../feedcomments');
const LIVE = 'fp0123456789'; const OFF = 'fpabcdefabcd';
const fakeFeed = { list: async () => [{ id: LIVE, title: 'Front of the Class', active: true }, { id: OFF, title: 'Draft', active: false }], statusOf: (p) => (p.active ? 'LIVE' : 'OFF') };
comments._internal.setFeed(fakeFeed);

(async () => {
  // ================= auto-moderator =================
  const act = (t) => mod.moderate(t).action;
  const reason = (t) => mod.moderate(t).reason;
  const abuse = ['fuck this show', 'F U C K', 'f.u.c.k', 'f-u-c-k you', 'fuuuuck', 'Ｆｕｃｋ', 'f**k', 'f*ck off', 'motherfucker', 'what a bitch', 'b i t c h', 'sh1t movie', 'S**t film', 'bullshit', 'asshole director', 'ch*tiya show', 'chutiya', 'chutiye log', 'CHUTIYAAA', 'madarchod', 'maderchod', 'Bhenchod kya bakwas', 'behen chod', 'bhosdike', 'bh0sdike', 'gandu', 'gaandu', 'randi', 'lund', 'l@wda', 'harami', 'bakchod', 'चूतिया है', 'मादरचोद', 'bsdk', 'fu ck off', 'b.h.e.n.c.h.o.d'];
  const abuseMiss = abuse.filter((t) => reason(t) !== 'abuse');
  ok('abuse: English + Hindi / Hinglish + Devanagari, spaced / dotted / leet / masked / stretched / full-width variants all refused', abuseMiss.length === 0, abuseMiss);
  const phones = ['call 9876543210', 'call 98765 43210', '+91-98765-43210', '+91 98765 43210', '0 98765 43210', '09876543210', '98 76 54 32 10', '9 8 7 6 5 4 3 2 1 0', '98765.43210', '(987) 654-3210', 'nine eight seven six five four three two one zero', 'nau aath saat chhe paanch chaar teen do ek shunya', 'double nine eight seven six five four three two one', '98765 432l0', 'mera no 7788990011 hai'];
  const phoneMiss = phones.filter((t) => reason(t) !== 'phone');
  ok('phone numbers: plain / spaced / dashed / dotted / +91 / 0 / brackets / words (English + Hindi) / "double" / l-for-1 refused', phoneMiss.length === 0, phoneMiss.map((t) => [t, reason(t)]));
  const contact = ['mail me rahul@gmail.com', 'rahul.k@yahoo.co.in', 'rahul at gmail dot com', 'rahul (at) gmail', 'pay on rahul@okaxis', 'upi: 98765@ybl', 'rahul @ ybl', 'visit www.cheapflix.in', 'https://bit.ly/xyz', 'http://192.168.1.5/offer', 'www.sastaott', 'https://sasta-ott.web/deal', 'netflix.com pe dekho', 't.me/sastaott', 'wa.me/919876543210', 'cheapott dot com', 'DM me for sasta netflix', 'dm karo', 'whatsapp karo', 'Whatsapp kro bhai', 'w h a t s a p p karo', 'contact me for accounts', 'telegram channel join karo', 'sasta netflix chahiye to', 'cheap netflix here', 'i sell netflix accounts', 'link in bio', 'upi id bhejo', 'earn money from home', 'msg me'];
  const contactMiss = contact.filter((t) => act(t) !== 'reject' || !/email|link|contact|phone/.test(reason(t)));
  ok('emails, UPI IDs, links, "DM me / whatsapp karo / sasta netflix" solicitations refused', contactMiss.length === 0, contactMiss.map((t) => [t, mod.moderate(t).action, reason(t)]));
  const fine = ['Season 2 kab aayega?', '2024 release hai', '4K me dekha, mast', '10/10 must watch', 'Best show of 2023, episode 5 was crazy', 'Rs 199 for 3 months is a steal', 'Paisa vasool 💯🔥', 'Ishita loved it', 'chutney jaisa tasty show', 'chod do yaar ye sab', 'chot lagi thi fir bhi dekha', 'Assassin creed vibes', 'Mr. India is back', 'Dr. In the end it was great', 'grandiose scene', 'Scunthorpe United fans?', 'Class act 👏', 'melody ekdum mast', 'Passion ho to aisa', 'Nigeria based film', 'Episode 1080p quality', 'Front of the Class (2008) ❤️', 'kitne episodes hai? 8?', 'Can I watch this on 2 devices?', 'Netflix pe kab aayega', 'Hindi dub hai kya', 'S3 E4 was 🔥', 'mujhe 1 month ka plan chahiye'];
  const fineMiss = fine.filter((t) => act(t) !== 'allow');
  ok('normal comments allowed (season 2, 2024 release, 4K, 10/10, prices, names like Ishita, "chod do", "chot", Mr./Dr., Scunthorpe, Nigeria…)', fineMiss.length === 0, fineMiss.map((t) => [t, mod.moderate(t).action, reason(t)]));
  const borderline = [['1 2 3 4 5 6 7 8', 'number'], ['order 12345678', 'number'], ['watch @home', 'handle'], ['@itisfluxfilm please add Loki', 'handle'], ['this is on telegram?', 'contact word'], ['yahan sasta hai', 'contact word'], ['call me by your name is great', 'contact word'], ['bc kya scene hai', 'mild word'], ['stfu this is good', 'mild word']];
  const borderMiss = borderline.filter(([t, r]) => act(t) !== 'pending' || reason(t) !== r);
  ok('borderline → pending for the owner (7-9 digits, bare @handle, lone "telegram" / "sasta", "call me", mild words)', borderMiss.length === 0, borderMiss.map(([t]) => [t, mod.moderate(t).action, reason(t)]));
  ok('empty / too long refused with friendly messages; customer never told which word matched', act('   ') === 'reject' && mod.moderate('x'.repeat(281)).message === 'Please keep it under 280 characters.' && act('x'.repeat(280)) === 'allow' && !/fuck|chutiya/i.test(mod.moderate('fuck').message) && /friendly/.test(mod.moderate('fuck').message) && /phone numbers, emails, UPI IDs, links/.test(mod.moderate('call 9876543210').message));
  ok('stored text: one line, no markup / control characters', mod.cleanText('  hi\n\n<b>there</b>\t ') === 'hi b there /b' && mod.moderate('great <script>show').text === 'great script show');
  ok('duplicate key ignores case, spaces, punctuation, emoji', mod.sameKey('Great show!! 🔥') === mod.sameKey('great   SHOW'));

  // ================= fail soft before schema-v24 =================
  T.ready = false; comments._internal.reset();
  let r = await comments.list(LIVE);
  ok('before schema: reading answers ready:false ("Comments coming soon"), no error', r.ok && r.ready === false && r.comments.length === 0 && /coming soon/.test(r.message));
  r = await comments.add('9876543210', LIVE, 'Nice show');
  ok('before schema: writing answers notReady, nothing saved', !r.ok && r.notReady === true && T.comments.length === 0);
  ok('before schema: counts {} and admin list ready:false', JSON.stringify(await comments.counts()) === '{}' && (await comments.adminList({})).ready === false);
  ok('before schema: admin action explains to run schema-v24', /schema-v24/.test((await comments.adminAction(1, 'approve')).message));

  // ================= auth + writes =================
  T.ready = true; comments._internal.reset();
  r = await comments.add('', LIVE, 'hello');
  ok('no phone (not logged in) → needsLogin, nothing saved', !r.ok && r.needsLogin && T.comments.length === 0);
  r = await comments.add('9999999999', LIVE, 'hello');
  ok('a phone that is not a customer → needsLogin (same check as profile writes)', !r.ok && r.needsLogin && T.comments.length === 0);
  r = await comments.add('9876543210', OFF, 'hello');
  ok('post that is not LIVE / unknown / bad id → refused', !r.ok && !(await comments.add('9876543210', 'fpffffffffff', 'x')).ok && !(await comments.add('9876543210', '../etc', 'x')).ok && T.comments.length === 0);
  r = await comments.add('+91 98765-43210', LIVE, 'Loved it, must watch 🍿', { ip: '1.2.3.4' });
  const saved = T.comments[0];
  ok('logged-in customer comments: visible at once, first name + last initial, avatar kept, phone normalised', r.ok && r.status === 'visible' && r.comment.name === 'Harsh W.' && r.comment.avatar === '/profile-photo/0123456789abcdef01234567?v=k1' && saved.phone_norm === '9876543210' && saved.status === 'visible');
  ok('IP stored only as a salted hash', saved.ip_hash && saved.ip_hash.length === 24 && saved.ip_hash !== '1.2.3.4' && !/1\.2\.3\.4/.test(JSON.stringify(saved)));
  ok('public comment never has the phone number', !/9876543210/.test(JSON.stringify(r.comment)) && !/9876543210/.test(JSON.stringify(await comments.list(LIVE))));
  r = await comments.add('9876543210', LIVE, 'call me 9876543210');
  ok('moderator runs before saving: phone number refused, not saved', !r.ok && r.blocked && T.comments.length === 1);
  r = await comments.add('9876543210', LIVE, 'this is on telegram?');
  ok('borderline saved as pending (hidden from customers) with a "quick check" message', r.ok && r.status === 'pending' && !r.comment && /quick check/.test(r.message) && T.comments[1].status === 'pending' && T.comments[1].reason === 'contact word' && (await comments.list(LIVE)).comments.length === 1);
  r = await comments.add('9876543210', LIVE, 'LOVED it, must watch!!');
  ok('same text again (case / punctuation changed) refused as duplicate', !r.ok && r.duplicate === true && T.comments.length === 2);
  r = await comments.add('9876543210', LIVE, 'one more thought');
  ok('5th try in 10 minutes still allowed', r.ok);
  r = await comments.add('9876543210', LIVE, 'and another');
  ok('rate limit: 6th try in 10 minutes (refused tries count too) → "please wait"', !r.ok && r.rateLimited === true && T.comments.length === 3);
  ok('limit is per phone: another customer can still comment; odd names shown as "FluxFilm member", bad avatar dropped', await (async () => { const x = await comments.add('9123456780', LIVE, 'Great picks this week'); return x.ok && x.comment.name === 'FluxFilm member' && x.comment.avatar === ''; })());
  const x2 = await comments.add('9123456780', LIVE, 'Great picks this week again');
  ok('display name rules', comments.displayName('priya') === 'Priya' && comments.displayName('  amit   kumar  sharma ') === 'Amit S.' && comments.displayName('a@b.com') === 'FluxFilm member' && comments.displayName('') === 'FluxFilm member' && x2.ok);
  ok('text over 280 characters refused', !(await comments.add('9000000001', LIVE, 'x'.repeat(281))).ok);

  // pagination
  comments._internal.recent.clear(); comments._internal.lastTexts.clear();
  for (let i = 0; i < 12; i++) { T.comments.push({ id: T.nextId++, post_id: LIVE, phone_norm: '9000000001', name: 'Priya', avatar_url: null, text: 'old comment ' + i, status: 'visible', reason: null, ip_hash: 'x', created_at: '2026-09-14 10:00:00', updated_at: null }); }
  const p1 = await comments.list(LIVE);
  const p2 = await comments.list(LIVE, p1.next);
  ok('newest first, 10 per page, "Load more" cursor continues without repeats', p1.comments.length === 10 && p1.next && p1.comments[0].id > p1.comments[9].id && p2.comments.length > 0 && p2.comments.every((c) => c.id < p1.next) && !p2.comments.some((c) => p1.comments.some((d) => d.id === c.id)));
  ok('comment time read as India time', p2.comments.some((c) => c.at === '2026-09-14T04:30:00.000Z'));
  comments._internal.reset();
  ok('counts for the feed list = visible comments only', (await comments.counts())[LIVE] === T.comments.filter((c) => c.status === 'visible').length);

  // ================= admin =================
  const pendingRow = T.comments.find((c) => c.status === 'pending');
  let a = await comments.adminList({ status: 'pending' });
  ok('admin queue: pending only, with phone for the owner, counts per status and per post', a.ready && a.comments.length === 1 && a.comments[0].phone === '9876543210' && a.counts.pending === 1 && a.byPost[LIVE].pending === 1 && a.blocked.phone >= 1);
  const allPublic = async () => { const out = []; let cur = 0; for (let i = 0; i < 10; i++) { const pg = await comments.list(LIVE, cur); out.push(...pg.comments); if (!pg.next) break; cur = pg.next; } return out; };
  ok('approve → visible to customers', (await comments.adminAction(pendingRow.id, 'approve')).ok && pendingRow.status === 'visible' && (await allPublic()).some((c) => c.id === pendingRow.id));
  ok('hide → gone for customers', (await comments.adminAction(pendingRow.id, 'hide')).ok && pendingRow.status === 'hidden' && !(await allPublic()).some((c) => c.id === pendingRow.id));
  const del = T.comments.find((c) => c.phone_norm === '9123456780');
  ok('delete removes the row', (await comments.adminAction(del.id, 'delete')).ok && !T.comments.some((c) => c.id === del.id));
  const harsh = T.comments.find((c) => c.phone_norm === '9876543210' && c.status === 'visible');
  r = await comments.adminAction(harsh.id, 'block');
  ok('block commenter → banned + all their comments hidden', r.ok && T.bans.length === 1 && T.comments.filter((c) => c.phone_norm === '9876543210').every((c) => c.status === 'hidden'));
  comments._internal.recent.clear(); comments._internal.lastTexts.clear();
  r = await comments.add('9876543210', LIVE, 'I am back with a new comment');
  ok('blocked commenter cannot comment', !r.ok && r.blocked === true && /can't comment/.test(r.message));
  a = await comments.adminList({ status: '' });
  ok('admin list marks blocked commenters; unblock works', a.comments.some((c) => c.banned) && a.bans === 1 && (await comments.adminAction(harsh.id, 'unblock')).ok && T.bans.length === 0);
  ok('unknown action / id refused', !(await comments.adminAction(harsh.id, 'explode')).ok && !(await comments.adminAction(99999, 'approve')).ok);

  // admin routes + audit log
  const routes = {}; const audits = []; let authed = false;
  const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
  const feedStub = Object.assign({}, fakeFeed, { BRANDS: [] });
  require('../adminfeed').mount(app, { auth: (req, res) => { if (!authed) { res.status(403).json({ ok: false }); return false; } return true; }, audit: { record: (q, x) => audits.push(x) }, feed: feedStub, comments });
  const call = (m, p, body, query) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { resolve({ code: this.code, body: x }); } }; Promise.resolve(routes[m + ' ' + p]({ body, query: query || {} }, res)); });
  let x = await call('GET', '/admin/api/feed/comments', null, { status: 'hidden' });
  ok('admin comments route needs sign-in', x.code === 403);
  authed = true;
  x = await call('GET', '/admin/api/feed/comments', null, { status: 'hidden', post: LIVE });
  ok('admin comments route: filtered list', x.body.ok && x.body.comments.length > 0 && x.body.comments.every((c) => c.status === 'hidden' && c.postId === LIVE));
  x = await call('POST', '/admin/api/feed/comments/action', { id: harsh.id, action: 'approve' });
  ok('admin action route + change log (phone shown as last 4 digits only)', x.body.ok && audits.length === 1 && audits[0].action === 'feed.comment.approve' && /Approved comment #\d+ by Harsh W\./.test(audits[0].summary) && !/9876543210/.test(JSON.stringify(audits)));
  x = await call('POST', '/admin/api/feed/comments/action', { id: harsh.id, action: 'block' });
  ok('block logged with …3210 only', x.body.ok && /…3210/.test(audits[1].summary) && !/98765/.test(audits[1].summary));

  // ================= wiring / schema / storefront / admin page =================
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('server: getFeedComments (anyone) + addFeedComment (phone first arg) wired, per-IP and per-phone limits', /getFeedComments: \(a\) => feedCommentsMod\.list\(a\[0\], a\[1\]\)/.test(srv) && /addFeedComment: \(a, req\) => feedCommentsMod\.add\(a\[0\], a\[1\], a\[2\], \{ ip: security\.clientIp\(req\) \}\)/.test(srv) && /DB_STOREFRONT_ACTIONS\.add\('getFeedComments'\); DB_STOREFRONT_ACTIONS\.add\('addFeedComment'\);/.test(srv) && /LIMITS\.addFeedComment = security\.rateLimiter/.test(srv) && /PHONE_LIMITS\.addFeedComment = security\.rateLimiter/.test(srv));
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema-v24.sql'), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  ok('schema-v24: plain CREATE TABLE IF NOT EXISTS feed_comments + feed_bans (utf8mb4), no information_schema / PREPARE', /CREATE TABLE IF NOT EXISTS feed_comments \(/.test(schema) && /CREATE TABLE IF NOT EXISTS feed_bans \(/.test(schema) && /utf8mb4/.test(schema) && !/information_schema|PREPARE|EXECUTE|DELIMITER/i.test(schema) && ['post_id', 'phone_norm', 'name', 'text', 'status', 'reason', 'created_at', 'ip_hash'].every((c) => new RegExp('\\n  ' + c + ' ').test(schema)));
  ok('schema: v24 follows v23 (no gap)', fs.existsSync(path.join(ROOT, 'db', 'schema-v23.sql')) && fs.existsSync(path.join(ROOT, 'db', 'schema-v24.sql')));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]);
  let parsed = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('storefront script parses', parsed);
  ok('storefront: 💬 button opens comments (loaded only when opened), logged-in form (280 max) else "Log in to comment", Load more, coming soon', /function FeedComments\(/.test(html) && /talk && React\.createElement\(FeedComments, \{/.test(html) && /maxLength: 280/.test(html) && /"🔐 Log in to comment"/.test(html) && /'Load more comments'/.test(html) && /"💬 Comments coming soon"/.test(html) && /apiCall_\('getFeedComments', \[postId, cursor\]/.test(html) && /apiCall_\('addFeedComment', \[phone, postId, text\]/.test(html) && /const phone = \(getFFSession\(\) \|\| \{\}\)\.phone \|\| '';/.test(html));
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const aScripts = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]);
  let aParsed = true; for (const sc of aScripts) { try { new Function(sc); } catch (e) { aParsed = false; console.log('   admin parse error:', e.message); } }
  ok('admin: parses; 💬 Comments queue with To check / Visible / Hidden tabs, per-post filter, approve / hide / delete / block, schema hint', aParsed && /function fdComments\(/.test(admin) && /\['pending', '🕒 To check'\]/.test(admin) && /id="fdcmpost"/.test(admin) && /data-cmact="approve"/.test(admin) && /data-cmact="hide"/.test(admin) && /data-cmact="delete"/.test(admin) && /data-cmact="block"/.test(admin) && /schema-v24\.sql/.test(admin) && /\/admin\/api\/feed\/comments\/action/.test(admin));

  console.log('\n---------------------------------------');
  console.log('feed-comments: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
