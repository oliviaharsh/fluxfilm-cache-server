/* 🍿 Run 4 (15 Sep 2026): sharper ✨ AI captions (TMDB story facts, few-shot hooks, ✨ Rewrite, optional Gemini with
   mocked HTTP), latest-3 comment previews, comments bottom sheet, What's new redesign, 💬 Help bubble + admin switch.
   DB, TMDB and the AI providers are all mocked — no network. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- in-memory DB: app_settings + feed_comments ----------
const settings = {};
const T = { comments: [], sql: [] };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    T.sql.push(sql);
    if (/^SELECT value FROM app_settings WHERE setting_key = \?/.test(sql)) return settings[p[0]] != null ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (sql === 'SELECT id FROM feed_comments LIMIT 1') return T.comments.slice(0, 1);
    if (sql === 'SELECT post_id, COUNT(*) AS n FROM feed_comments WHERE status = ? GROUP BY post_id') { const o = {}; T.comments.filter((c) => c.status === p[0]).forEach((c) => { o[c.post_id] = (o[c.post_id] || 0) + 1; }); return Object.entries(o).map(([post_id, n]) => ({ post_id, n })); }
    if (/^\(SELECT id, post_id, name, avatar_url, text, created_at FROM feed_comments WHERE post_id = \? AND status = \? ORDER BY id DESC LIMIT 3\)( UNION ALL \(SELECT id, post_id, name, avatar_url, text, created_at FROM feed_comments WHERE post_id = \? AND status = \? ORDER BY id DESC LIMIT 3\))*$/.test(sql)) {
      const out = [];
      for (let i = 0; i < p.length; i += 2) out.push(...T.comments.filter((c) => c.post_id === p[i] && c.status === p[i + 1]).sort((a, b) => b.id - a.id).slice(0, 3));
      return out;
    }
    if (/feed_comments|plans/.test(sql)) return [];
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const feed = require('../feed');
const feedai = require('../feedai');
const gemini = require('../feedgemini');
const comments = require('../feedcomments');
const store = require('../store');

// ---------- fake TMDB: Off Campus (series, with credits + tagline) and Front of the Class ----------
const tmdbCalls = [];
feed._internal.setFetch(async (url) => {
  const u = new URL(url); tmdbCalls.push(u);
  const res = (body, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => body });
  const pth = u.pathname.replace('/3', '');
  if (pth === '/genre/movie/list') return res({ genres: [{ id: 18, name: 'Drama' }] });
  if (pth === '/genre/tv/list') return res({ genres: [{ id: 18, name: 'Drama' }, { id: 10749, name: 'Romance' }] });
  if (pth === '/search/multi') {
    const q = u.searchParams.get('query').toLowerCase();
    if (/off campus/.test(q)) return res({ results: [{ id: 700, media_type: 'tv', name: 'Off Campus', first_air_date: '2026-05-13', poster_path: '/off.jpg', genre_ids: [18], original_language: 'en', popularity: 80, overview: 'Short.' }] });
    if (/front of the class/.test(q)) return res({ results: [{ id: 901, media_type: 'movie', title: 'Front of the Class', release_date: '2008-12-07', poster_path: '/front.jpg', genre_ids: [18], original_language: 'en', popularity: 12, overview: 'Brad Cohen story.' }] });
    return res({ results: [] });
  }
  if (pth === '/tv/700') return res({ id: 700, name: 'Off Campus', first_air_date: '2026-05-13', poster_path: '/off.jpg', genres: [{ id: 18, name: 'Drama' }, { id: 10749, name: 'Romance' }], original_language: 'en', origin_country: ['US'], tagline: 'Rules are made to be broken.', number_of_seasons: 1, overview: 'At Briar University, hockey star Garrett Graham needs to pass ethics to stay on the team, and Hannah Wells needs help with her crush. So they make a deal.', created_by: [{ name: 'Louisa Levy' }], credits: { cast: [{ name: 'Ella Bright', character: 'Hannah Wells' }, { name: 'Belmont Cameli', character: 'Garrett Graham' }, { name: 'A', character: '' }, { name: 'B' }, { name: 'C (fifth)' }] }, seasons: [{ season_number: 1, air_date: '2026-05-13' }], videos: { results: [] } });
  if (pth === '/movie/901') return res({ id: 901, title: 'Front of the Class', release_date: '2008-12-07', poster_path: '/front.jpg', genres: [{ id: 18, name: 'Drama' }], original_language: 'en', tagline: 'Never let anyone stop you.', overview: 'The true story of Brad Cohen, who has Tourette syndrome and dreams of becoming a teacher.', credits: { cast: [{ name: 'James Wolk', character: 'Brad Cohen' }], crew: [{ job: 'Director', name: 'Peter Werner' }] }, videos: { results: [] } });
  return res({}, 404);
});

(async () => {
  await feed.saveSettings({ tmdbKey: 'a'.repeat(32) });
  const fakeFeed = { LANGS: feed.LANGS, getSettings: feed.getSettings, searchTitle: feed.searchTitle, tmdbMatch: feed.tmdbMatch, NO_DATE: feed.NO_DATE };

  // ================= 1. TMDB story facts (server-side only) =================
  const m = await feed.tmdbMatch('Off Campus', { type: 'series' });
  ok('TMDB details ask for credits (cast) with the videos', tmdbCalls.some((u) => /\/tv\/700$/.test(u.pathname) && u.searchParams.get('append_to_response') === 'videos,credits'));
  ok('story facts: overview, tagline, top 4 cast with characters, creator, genres, language', m.story && /Briar University/.test(m.story.overview) && m.story.tagline === 'Rules are made to be broken.' && m.story.cast.length === 4 && m.story.cast[0] === 'Ella Bright (as Hannah Wells)' && m.story.cast[3] === 'B' && m.story.director === 'Louisa Levy' && m.story.language === 'English', m.story);
  ok('story is not enumerable: never lands in JSON / a saved post / the storefront', !('story' in JSON.parse(JSON.stringify(m))) && !/Rules are made/.test(JSON.stringify(m)));

  // ================= 2. prompt: specific hook, facts, few-shot, rules =================
  let asked = [];
  const model = async (msgs, o) => { asked.push({ msgs, o }); return { json: { title: 'Off Campus', caption: 'Garrett is failing ethics — and Hannah only wants one thing: a fake date 😏🏒\nBelmont Cameli & Ella Bright star.\nHow long does fake stay fake? 👀', angle: 'premise', genres: ['Romance', 'Drama'], languages: ['English'], type: 'series' }, tokens: 400 }; };
  let r = await feedai.aiFill({ title: 'Off Campus', sourceCaption: 'College life, friendships, and all the fun drama that comes with it!', type: 'series', brand: 'Prime Video' }, { feed: fakeFeed, model });
  const sys = asked[0].msgs[0].content; const last = asked[0].msgs[asked[0].msgs.length - 1].content;
  ok('facts go to the AI: overview, tagline, cast, creator, release', /Overview: At Briar University/.test(last) && /Tagline: Rules are made to be broken\./.test(last) && /Top cast: Ella Bright \(as Hannah Wells\), Belmont Cameli/.test(last) && /Created by: Louisa Levy/.test(last) && /Release: 2026-05-13/.test(last), last);
  ok('prompt asks for an Instagram hook naming something SPECIFIC (character / twist / setting / cast / real story), ≤ 220 chars, curiosity line, 1–3 emojis', /Instagram-style hook, at most 220 characters/.test(sys) && /SPECIFIC/.test(sys) && /character by name, the twist or premise, the setting, a cast member, or the real-story angle/.test(sys) && /curiosity line/.test(sys) && /1 to 3 emojis/.test(sys));
  ok('prompt bans generic filler ("fresh and entertaining watch" …), invented facts and endings; keeps old safety rules', /NEVER generic filler such as "fresh and entertaining watch"/.test(sys) && /never reveal how it ends/.test(sys) && /NO hashtags/.test(sys) && /NO phone numbers/.test(sys) && /ONLY from: Action, Adventure/.test(sys) && /"caption"/.test(sys));
  ok('two hand-written few-shot examples (Front of the Class, Off Campus) as user/assistant turns', asked[0].msgs.length === 6 && asked[0].msgs[2].role === 'assistant' && /Brad Cohen/.test(asked[0].msgs[2].content) && /fake date/.test(asked[0].msgs[4].content) && feedai.EXAMPLES.every((e) => e.answer.caption.length <= 220 && !feedai.GENERIC.test(e.answer.caption)), feedai.EXAMPLES.map((e) => e.answer.caption.length));
  ok('fill result: caption kept, provider + angle returned, TMDB still decides title / genres / date', r.ok && r.ai && r.provider === 'DeepSeek' && r.angle === 'premise' && /fake date/.test(r.fields.caption) && r.fields.releaseDate === '2026-05-13' && r.tmdb === true, r);
  ok('Hinglish only encouraged for Indian titles', /light Hinglish only if it sounds natural/.test(sys) && feedai._internal.isIndian({ language: 'Hindi' }) && /Indian title, so light Hinglish is welcome/.test(feedai._internal.prompt('x', '', ['Hindi'], { language: 'Tamil' })[0].content));

  // ✨ Rewrite
  asked = [];
  r = await feedai.aiFill({ title: 'Off Campus', caption: 'Old caption here', type: 'series', rewrite: 2, previousCaption: 'Old caption here' }, { feed: fakeFeed, model });
  const rw = asked[0].msgs[asked[0].msgs.length - 1].content;
  ok('✨ Rewrite: asks for a NEW caption with the next hook angle, never reusing the old opening; higher temperature flag', /Write a NEW caption with a different hook: this time lead with the premise or the twist/.test(rw) && /Do not reuse the opening[\s\S]*Old caption here/.test(rw) && asked[0].o.rewrite === 2 && r.rewrite === 2, rw);
  ok('the two bland live captions (15 Sep) are caught as generic', feedai.GENERIC.test('A heartwarming true story of a teacher who never gave up on his dream. Watch this inspiring film with your family and feel the power of kindness and courage! 🎬✨') && feedai.GENERIC.test('College life, friendships, and all the fun drama that comes with it! Get ready for a fresh and entertaining watch that feels totally relatable 🎬✨'));
  ok('rewrite angles rotate', feedai.ANGLES.length >= 5 && /cast member/.test(feedai._internal.prompt('x', '', [], null, { rewrite: 3 }).pop().content));
  r = await feedai.aiFill({ title: 'Off Campus', type: 'series' }, { feed: fakeFeed, model: async () => ({ json: { caption: 'A fresh and entertaining watch with all the fun drama!' }, tokens: 5 }) });
  ok('a generic caption gets a "tap ✨ Rewrite" note', r.fields.caption && r.notes.some((n) => /generic — tap ✨ Rewrite/.test(n)), r.notes);

  // Title only known by the AI → facts looked up → caption written again WITH the facts
  asked = [];
  let n = 0;
  const twoStep = async (msgs) => { n++; asked.push(msgs); return { json: n === 1 ? { title: 'Front of the Class', caption: 'first try' } : { caption: 'His tics got him laughed out of class — so Brad decided to run one 🍎' }, tokens: 100 }; };
  r = await feedai.aiFill({ sourceCaption: '🎥 A must see biographical drama (2008) #hopecore' }, { feed: fakeFeed, model: twoStep });
  ok('AI found the title → TMDB facts → second write uses them (tokens added up, title kept)', n === 2 && /James Wolk \(as Brad Cohen\)/.test(asked[1][asked[1].length - 1].content) && /Director: Peter Werner/.test(asked[1][asked[1].length - 1].content) && /Brad decided/.test(r.fields.caption) && r.fields.title === 'Front of the Class' && r.tokens === 200, { n, r });

  // ================= 3. Gemini provider (mocked HTTP) =================
  const saved = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
  let bad = await feed.saveSettings({ geminiKey: 'not a key!' });
  ok('Gemini key: format checked', bad.ok === false && /AIza/.test(bad.message));
  const GKEY = 'AIzaSyTESTtestTESTtestTESTtest1234567';
  let sv = await feed.saveSettings({ geminiKey: GKEY });
  ok('Gemini key saved server-side, never in the admin settings answer (only hasGeminiKey / aiProvider)', sv.ok && sv.changed.includes('Gemini key saved') && sv.settings.hasGeminiKey === true && sv.settings.aiProvider === 'Gemini' && !JSON.stringify(sv.settings).includes(GKEY) && JSON.parse(settings.feed_settings).geminiKey === GKEY);
  const pub = JSON.stringify(await feed.publicList());
  ok('public feed never contains the Gemini key', !pub.includes(GKEY));

  const http = []; let reply = null;
  const fakeFetch = async (url, opts) => {
    http.push({ url, opts, body: JSON.parse(opts.body) });
    const x = typeof reply === 'function' ? reply(url, opts) : reply;
    return { ok: x.status < 400, status: x.status, json: async () => x.body };
  };
  reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: '```json\n{"title":"Front of the Class","caption":"His tics got him laughed out of class — so Brad Cohen decided to run one 🍎","angle":"real story","genres":["Drama"],"languages":["English"],"type":"movie"}\n```' }] } }], usageMetadata: { totalTokenCount: 812 } } };
  r = await feedai.aiFill({ title: 'Front of the Class', type: 'movie' }, { feed: fakeFeed, fetch: fakeFetch });
  const g = http[0];
  ok('Gemini used first when its key is set: gemini-2.5-flash generateContent, key in x-goog-api-key header (not the URL)', r.ai && r.provider === 'Gemini' && /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/.test(g.url) && g.opts.headers['x-goog-api-key'] === GKEY && !g.url.includes(GKEY) && r.tokens === 812, { url: g && g.url, r });
  ok('Gemini request: system instruction + few-shot as user/model turns, JSON mode, thinking off', /Instagram-style hook/.test(g.body.systemInstruction.parts[0].text) && g.body.contents.length === 5 && g.body.contents[1].role === 'model' && g.body.generationConfig.responseMimeType === 'application/json' && g.body.generationConfig.thinkingConfig.thinkingBudget === 0 && !g.body.tools);
  ok('old title (2008, long overview) → no Google Search; caption parsed out of a ```json fence', !r.grounded && /Brad Cohen decided/.test(r.fields.caption));
  http.length = 0;
  reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Here you go: {"caption":"Garrett needs a pass, Hannah needs a date — deal? 😏","genres":["Romance"]} hope it helps' }] }, groundingMetadata: { webSearchQueries: ['Off Campus series'] } }], usageMetadata: { totalTokenCount: 300 } } };
  r = await feedai.aiFill({ title: 'Off Campus', type: 'series' }, { feed: fakeFeed, fetch: fakeFetch, now: Date.parse('2026-06-01') });
  ok('very new title → Google Search grounding tool on (no JSON mode), JSON found inside plain text, grounded flag + message', http[0].body.tools && http[0].body.tools[0].google_search && !http[0].body.generationConfig.responseMimeType && r.grounded === true && /Google Search/.test(r.message) && /deal\?/.test(r.fields.caption), { body: http[0] && http[0].body.tools, r });
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  const oliviawords = require('../oliviawords');
  const realCall = oliviawords.callModel; let dsCalls = 0;
  oliviawords.callModel = async () => { dsCalls++; return { json: { caption: 'DeepSeek backup caption about Brad 🍎' }, tokens: 50 }; };
  http.length = 0; reply = { status: 503, body: {} };
  r = await feedai.aiFill({ title: 'Front of the Class', type: 'movie' }, { feed: fakeFeed, fetch: fakeFetch });
  ok('Gemini down (HTTP 503) → DeepSeek tried next', http.length === 1 && dsCalls === 1 && r.provider === 'DeepSeek' && /backup caption/.test(r.fields.caption), r);
  await feed.saveSettings({ clearGeminiKey: true });
  http.length = 0; dsCalls = 0;
  r = await feedai.aiFill({ title: 'Front of the Class', type: 'movie' }, { feed: fakeFeed, fetch: fakeFetch });
  ok('no Gemini key → DeepSeek only (no Gemini HTTP call)', http.length === 0 && dsCalls === 1 && r.provider === 'DeepSeek' && (await feed.getSettings()).geminiKey === '');
  oliviawords.callModel = realCall; if (saved) process.env.DEEPSEEK_API_KEY = saved; else delete process.env.DEEPSEEK_API_KEY;
  ok('gemini adapter: no key → null without any request; bad JSON → null; timeout / network error → null', (await gemini.callGemini([], { key: '', fetch: fakeFetch })) === null && (await gemini.callGemini([{ role: 'user', content: 'x' }], { key: GKEY, fetch: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'no json here' }] } }] }) }) })) === null && (await gemini.callGemini([{ role: 'user', content: 'x' }], { key: GKEY, fetch: async () => { throw new Error('ECONNRESET'); } })) === null);
  ok('gemini adapter parses fenced / embedded JSON', gemini.parseJsonText('```json\n{"a":1}\n```').a === 1 && gemini.parseJsonText('text {"b":2} text').b === 2 && gemini.parseJsonText('nope') === null);

  // ================= 4. admin: Gemini key + ✨ Rewrite =================
  const admin = read('admin.html');
  ok('admin feed settings: Gemini key box (password field, AI Studio steps, remove), order note', /id="fdgem" type="password" autocomplete="off"/.test(admin) && /aistudio\.google\.com/.test(admin) && /geminiKey: k/.test(admin) && /clearGeminiKey: true/.test(admin) && /Order: Gemini if a key is saved, else DeepSeek/.test(admin));
  ok('admin editor: ✨ Rewrite button sends rewrite count + previous caption, only replaces the caption', /id="fdairw"/.test(admin) && /rewrite: rewrite \? FD\.rewrites : 0, previousCaption: rewrite \? FD\.edit\.caption : ''/.test(admin) && /if \(rewrite\) \{\s*if \(f\.caption\) \{ ed\.caption = f\.caption;/.test(admin));
  const af = read('adminfeed.js');
  ok('ai-fill route passes rewrite + previousCaption', /rewrite: b\.rewrite, previousCaption: b\.previousCaption/.test(af));

  // ================= 5. comment previews: one bounded query, cached 30 s =================
  const at = '2026-09-15 10:00:00';
  const A = 'fp0000000001'; const B = 'fp0000000002'; const C0 = 'fp0000000003';
  for (let i = 1; i <= 5; i++) T.comments.push({ id: i, post_id: A, name: 'User ' + i, avatar_url: null, text: 'comment ' + i, status: i === 5 ? 'pending' : 'visible', created_at: at });
  T.comments.push({ id: 6, post_id: B, name: 'Priya S.', avatar_url: 'javascript:x', text: 'Season 2 when?', status: 'visible', created_at: at });
  T.comments.push({ id: 7, post_id: B, name: 'Hidden', avatar_url: null, text: 'bad', status: 'hidden', created_at: at });
  comments._internal.reset(); T.sql.length = 0;
  let pv = await comments.previews([A, B, C0, 'bad id', A]);
  const unions = T.sql.filter((q) => /UNION ALL/.test(q) || /^\(SELECT id, post_id/.test(q));
  ok('previews: newest 3 VISIBLE per post (pending / hidden never shown), totals from visible counts, empty posts total 0', pv.ok && pv.ready && pv.previews[A].comments.map((c) => c.id).join() === '4,3,2' && pv.previews[A].total === 4 && pv.previews[B].comments.length === 1 && pv.previews[B].total === 1 && pv.previews[C0].total === 0 && !pv.previews['bad id'], pv);
  ok('previews: ONE query for all posts (UNION ALL, LIMIT 3 each) — never a whole thread', unions.length === 1 && (unions[0].match(/LIMIT 3\)/g) || []).length === 3, unions);
  ok('previews: public fields only (no phone), unsafe avatar dropped', !/phone/.test(JSON.stringify(pv)) && pv.previews[B].comments[0].avatar === '' && pv.previews[B].comments[0].name === 'Priya S.');
  T.sql.length = 0;
  pv = await comments.previews([A, B]);
  ok('previews cached 30 s (no new query)', !T.sql.some((q) => /UNION ALL|^\(SELECT id, post_id/.test(q)) && pv.previews[A].comments.length === 3);
  ok('at most 12 posts per call', (await comments.previews(Array.from({ length: 20 }, (_, i) => 'fpb' + String(i).padStart(9, '0')))) && T.sql.filter((q) => /^\(SELECT id, post_id/.test(q)).pop().split('UNION ALL').length === 12);
  const srv = read('server.js');
  ok('server: getFeedCommentPreviews storefront action (a[0] = ids), rate limited', /getFeedCommentPreviews: \(a\) => feedCommentsMod\.previews\(a\[0\]\)/.test(srv) && /DB_STOREFRONT_ACTIONS\.add\('getFeedCommentPreviews'\)/.test(srv) && /LIMITS\.getFeedCommentPreviews = security\.rateLimiter/.test(srv));
  const fc = read('feedcomments.js');
  ok('previews cache cleared when a comment is added / hidden / deleted / blocked', /previewCache\.delete\(pid\);/.test(fc) && /if \(action === 'block'\) previewCache\.clear\(\); else previewCache\.delete\(s\(c\.post_id\)\);/.test(fc));

  // ================= 6. 💬 Help bubble switch (store settings) =================
  let st = await store.getStatus();
  ok('store status: helpBubble ON by default', st.helpBubble === true);
  let sr = await store.saveSettings({ helpBubble: false });
  st = await store.getStatus();
  ok('admin can turn the bubble off (saved, reported as changed, public status says false; pause untouched)', sr.ok && sr.changed.includes('helpBubble') && st.helpBubble === false && st.paused === false);
  await store.saveSettings({ helpBubble: 'true' });
  ok('…and back on', (await store.getStatus()).helpBubble === true);
  ok('admin 🚧 Maintenance: "Help bubble" checkbox saves at once + change log', /id="mthelp"/.test(admin) && /post\('\/admin\/api\/store', \{ helpBubble: on \}\)/.test(admin) && /store\.helpbubble/.test(read('adminstore.js')));

  // ================= 7. storefront =================
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((x) => !/application\/(ld\+)?json/.test(x[0]));
  let parseErr = ''; for (const sc of scripts) { try { new Function(sc[1]); } catch (e) { parseErr = e.message; } }
  ok('all inline <script> blocks parse', !parseErr, parseErr);
  ok('help: still ONE ffOpenHelp_ and the top-right HelpButton; bubble + "Need help?" card use it', (html.match(/function ffOpenHelp_\(\)/g) || []).length === 1 && /function HelpButton\(\)/.test(html) && /className: "ff-hb" \+ \(hidden \|\| kb \? ' hide' : ''\),[\s\S]{0,80}onClick: ffOpenHelp_/.test(html) && /function NeedHelpCard\(\)[\s\S]{0,700}onClick: ffOpenHelp_/.test(html));
  ok('bubble only on Home / My plans / Account (never Buy / New / checkout / pay), respects the admin switch, hidden while loading', /const HELP_BUBBLE_SCREENS = \{\s*home: 1,\s*dashboard: 1,\s*account: 1\s*\};/.test(html) && /const showHelpBubble = showBnav && !!HELP_BUBBLE_SCREENS\[screen\] && !restoring && !loadingMsg && !\(storeStatus && storeStatus\.helpBubble === false\);/.test(html) && /React\.createElement\(HelpBubble, \{\s*show: showHelpBubble\s*\}\)/.test(html));
  ok('bubble sits above the measured bottom menu, hides on scroll down / keyboard, page gets extra room, not on desktop', /\.ff-hb \{[^}]*bottom: calc\(max\(72px \+ env\(safe-area-inset-bottom\), var\(--ff-bnav-h, 0px\)\) \+ 12px\)/.test(html) && /\.ff-hb\.hide \{/.test(html) && /function useScrollHide_\(on\)/.test(html) && /setKb\(window\.innerHeight - vv\.height > 150\)/.test(html) && /\.ff-has-bnav\.ff-has-hb \{ padding-bottom:/.test(html) && /@media \(min-width: 900px\) \{ \.ff-hb \{ display: none; \}/.test(html) && /\(showHelpBubble \? ' ff-has-hb' : ''\)/.test(html));
  ok('"Need help?" card at the end of My plans', /\}\)\), React\.createElement\(NeedHelpCard, null\)\)\);\s*\}\s*function Buy1Screen\(/.test(html));
  ok('💬 tap opens the comments sheet with focus inside the same tap (hidden proxy input), sheet then focuses its box', /function openComments\(p, focus\) \{[\s\S]{0,200}proxyRef\.current\.focus\(\{\s*preventScroll: true\s*\}\)/.test(html) && /onClick: \(\) => onComments\(p, true\)/.test(html) && /React\.useLayoutEffect\(\(\) => \{\s*if \(focus && phone && taRef\.current\) try \{\s*taRef\.current\.focus/.test(html) && /className: "ff-cs-proxy"/.test(html) && /\.ff-cs-proxy \{[^}]*font-size: 16px/.test(html));
  ok('sheet: portal to <body>, keyboard handled with visualViewport (--ff-kb / --ff-vvh), Back button closes (history entry), swipe down / ✕ / Escape', /return ReactDOM\.createPortal\(/.test(html) && /vv\.addEventListener\('resize', upd\)/.test(html) && /setProperty\('--ff-kb'/.test(html) && /\.ff-cs \{[^}]*bottom: var\(--ff-kb, 0px\)/.test(html) && /pushState\(Object\.assign\(\{\}, window\.history\.state \|\| \{\}, \{\s*ffSheet: 1\s*\}\)/.test(html) && /window\.addEventListener\('popstate', onPop\)/.test(html) && /if \(d\.dy > 90\) close\(\)/.test(html) && /"aria-label": "Close comments"/.test(html) && /e\.key === 'Escape'/.test(html));
  ok('sheet: textarea 16px (no iOS zoom), newest first list, Post button, 280 max, log-in button for guests', /\.ff-cs-form textarea \{[^}]*font-size: 16px/.test(html) && /setItems\(x => \[r\.comment\]\.concat\(x \|\| \[\]\)\)/.test(html) && /className: "ff-cs-send"/.test(html) && /maxLength: 280/.test(html) && /"🔐 Log in to comment"/.test(html));
  ok('previews under posts: latest 3 + "View all N comments" + "Add a comment…", fetched in one batch only for posts near the screen', /'View all ' \+ ncomments \+ ' comments'/.test(html) && /"Add a comment…"/.test(html) && /rootMargin: '600px 0px'/.test(html) && /if \(onNear && Number\(p\.comments\) > 0\)/.test(html) && /const ids = \[\.\.\.s\.queue\]\.slice\(0, 12\);/.test(html) && /API\.getFeedCommentPreviews\(ids,/.test(html) && /apiCall_\('getFeedCommentPreviews', \[postIds\]/.test(html));
  ok('post UI: rounded 4:5 media, compact outline-icon actions (like / comments / share / save), CTA pill + floating copy while it is off screen, "Coming soon" badge', /\.ff-feed-media \{[^}]*aspect-ratio: 4 \/ 5;[^}]*border-radius: 18px/.test(html) && /className: 'ff-feed-save' \+ \(saved \? ' on' : ''\)/.test(html) && /function FeedIcon\(\{/.test(html) && /name: "heart",\s*on: liked/.test(html) && /\.ff-feed-float \{ position: fixed;[^}]*bottom: calc\(var\(--ff-bnav-h, 0px\) \+ 12px\)/.test(html) && /!talk && float && ctaOf\[float\] && React\.createElement\("button"/.test(html) && /if \(cr && ar && ar\.bottom < low - 16 && \(cr\.top > low \|\| cr\.bottom < 70\)\) id = /.test(html) && /"🗓️ Coming soon"/.test(html) && /localStorage\.setItem\('ff_feed_saved'/.test(html));
  ok('filters folded into a "Filters" button (count badge, active chips removable), sticky bar hides on scroll down', /className: "ff-feed-fbtn" \+ \(panel \? ' on' : ''\)/.test(html) && /"aria-expanded": panel/.test(html) && /inert: panel \? undefined : ''/.test(html) && /"aria-label": "Filters on"/.test(html) && /className: "ff-feed-top" \+ \(barHidden \? ' hide' : ''\)/.test(html) && /\.ff-feed-top \{ position: sticky; top: var\(--ff-top-h, 0px\)/.test(html));
  ok('pull to refresh: passive touch listeners, browser reload-on-pull off only on this screen, force reload', /html\.style\.overscrollBehaviorY = 'contain';/.test(html) && /el\.addEventListener\('touchmove', move, \{\s*passive: true\s*\}\)/.test(html) && /feedLoad_\(r => setTimeout\(\(\) => \{/.test(html) && /html\.style\.overscrollBehaviorY = prevOb;/.test(html));
  ok('skeletons: feed posts + strip tiles (no jump); reduced motion stops the new animations', /className: "ff-feed-tile skel"/.test(html) && /function FeedSkeleton\(\)/.test(html) && /@media \(prefers-reduced-motion: reduce\) \{ \.ff-feed-post, \.ff-feed-skel i/.test(html));
  ok('keeps: one video at a time, click-to-load embeds, no TMDB on the storefront', /function feedVideoStart_\(key, stop\)/.test(html) && !/<iframe/i.test(html) && !/not endorsed or certified by TMDB/.test(html) && !/tmdb/i.test(html.split('function feedSaved_()')[1].split('function RestoringScreen(')[0].replace(/^\s*\/\/.*$/gm, '')));

  console.log('\n---------------------------------------');
  console.log('feed-run4: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
