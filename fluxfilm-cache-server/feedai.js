/**
 * FluxFilm - ✨ AI fill for a 🍿 What's new post (admin editor button). Suggests; never saves.
 *
 * aiFill({ title, caption, sourceCaption, type, brand, ctaService, rewrite?, previousCaption? }, deps) →
 *   { ok, fields: { title?, caption?, genres?, languages?, type?, releaseDate?, seasonLabel?, imageUrl?, trailerUrl? },
 *     ai, provider, angle, grounded, rewrite, tmdb, tokens, season, notes[], message }
 *
 * - Facts first: the title is looked up in the movie database (existing server-side TMDB code, feed.tmdbMatch) →
 *   overview, tagline, top cast, director, genres, release / season. These facts (never shown publicly) + the Reel's
 *   own caption go to the AI, so the caption can name something SPECIFIC (a character, the twist, the setting,
 *   a cast member, the real-story angle) instead of "a fresh and entertaining watch".
 * - 🆕 SERIES = the LATEST season (owner, 16 Sep 2026). feed.latestSeason() picks the highest season that has aired
 *   (a season starting within 30 days wins and is flagged "coming"), and its number, name, episode count, air date
 *   and overview go into the Facts with a rule: write about THAT season, never season 1 unless it is the latest.
 *   The same season fills the post's "🆕 Season N" badge and release date.
 * - The AI only WRITES: a clean title if the text clearly names one, an Instagram-style hook caption (≤ 220 characters
 *   asked, 300 hard cap; Hinglish welcome for Indian titles; no hashtags / links / numbers / personal data / endings),
 *   genres from a fixed list, languages, movie / series. Dates, poster and trailer only ever come from TMDB.
 * - Provider: Gemini (key in admin → 🍿 What's new → ⚙️ Settings, with Google Search for very new titles) → else the
 *   same DeepSeek adapter + DEEPSEEK_API_KEY Olivia uses (oliviawords.callModel). Gemini failing → DeepSeek is tried.
 * - ✨ Rewrite: rewrite = 1, 2, 3… + previousCaption → a different hook angle each time.
 * - No AI key → TMDB-only fill + "Add an AI key in settings for captions". Nothing is logged except the token count.
 */
const mod = require('./feedmod');

const GENRES = ['Action', 'Adventure', 'Animation', 'Anime', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Music', 'Mystery', 'Reality', 'Romance', 'Sci-Fi', 'Sports', 'Thriller', 'War'];
// TMDB genre names → the fixed list ("Action & Adventure" → Action + Adventure).
const TMDB_GENRES = { 'action & adventure': ['Action', 'Adventure'], 'sci-fi & fantasy': ['Sci-Fi', 'Fantasy'], 'science fiction': ['Sci-Fi'], 'war & politics': ['War'], soap: ['Drama'], talk: [], news: [], 'tv movie': [], western: ['Action'] };
const CAPTION_MAX = 300;
const CAPTION_ASK = 220;
// Hook angles for ✨ Rewrite (one per try, in this order).
const ANGLES = ['a character and what they want', 'the premise or the twist (no ending)', 'a cast member or the director', 'the setting or the world', 'the real story / the book or show it comes from', 'what is new this season', 'a question that makes people curious'];
// Filler that could describe any title: the prompt forbids it, and a caption using it gets a "try ✨ Rewrite" note.
const GENERIC = /fresh and entertaining|entertaining watch|heart-?warming (true )?story|must[- ]watch|don'?t miss (it|this|out)|get ready for|all the fun|fun drama|with your family|edge of your seat|roller-?coaster|a treat for|power of kindness|you won'?t want to miss|binge-?worthy/i;
const INDIAN_LANGS = ['Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Marathi', 'Punjabi', 'Gujarati'];

const s = (v) => String(v == null ? '' : v).trim();

function mapGenres(list) {
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    const k = s(g).toLowerCase();
    const mapped = TMDB_GENRES[k] || GENRES.filter((x) => x.toLowerCase() === k || (k === 'scifi' && x === 'Sci-Fi'));
    for (const m of mapped) if (!out.includes(m)) out.push(m);
  }
  return out.slice(0, 4);
}

/** AI caption → safe: no hashtags, @handles, links, emails, long numbers; moderated; ≤ 300 characters cut at a word. */
function cleanCaption(v) {
  let t = s(v).replace(/\r\n?/g, '\n')
    .replace(/(^|\s)#[^\s#]+/g, ' ').replace(/(^|\s)@[A-Za-z0-9._]+/g, ' ')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ').replace(/\S+@\S+/g, ' ')
    .replace(/\+?\d[\d\s-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? ' ' : m))
    .replace(/[<>*_~`]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > CAPTION_MAX) {
    const cut = t.slice(0, CAPTION_MAX - 1);
    t = cut.slice(0, cut.lastIndexOf(' ') > CAPTION_MAX * 0.6 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:.!?-]+$/, '') + '…';
  }
  if (!t) return '';
  const m = mod.moderate(t.replace(/\n/g, ' '));
  return m.action === 'reject' ? '' : t;
}
function cleanTitle(v) {
  return s(v).replace(/[<>#*_~`"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Story facts → short "Facts:" lines for the prompt ('' when there are none). */
function factLines(st) {
  const x = st || {};
  const L = [];
  if (x.title) L.push('Title: ' + x.title + (x.type ? ' (' + x.type + ')' : ''));
  if (x.tagline) L.push('Tagline: ' + x.tagline);
  if (x.overview) L.push('Overview: ' + s(x.overview).slice(0, 700));
  if (x.cast && x.cast.length) L.push('Top cast: ' + x.cast.slice(0, 4).join(', '));
  if (x.director) L.push((x.type === 'series' ? 'Created by: ' : 'Director: ') + x.director);
  if (x.genres && x.genres.length) L.push('Genres: ' + x.genres.join(', '));
  if (x.releaseDate) L.push('Release: ' + x.releaseDate + (x.seasonLabel ? ' — ' + x.seasonLabel + ' (new season)' : ''));
  else if (x.seasonLabel) L.push('New: ' + x.seasonLabel);
  if (x.seasons > 1) L.push('Seasons so far: ' + x.seasons);
  // 🆕 The latest season (owner, 16 Sep 2026: "when AI fills about series ask it to pick the latest season").
  const sn = x.season;
  if (sn && sn.number) {
    L.push('LATEST SEASON: Season ' + sn.number + (sn.name && sn.name !== 'Season ' + sn.number ? ' — "' + sn.name + '"' : '') +
      (sn.episodes ? ' · ' + sn.episodes + ' episode' + (sn.episodes === 1 ? '' : 's') : '') +
      (sn.airDate ? (sn.coming ? ' · starts ' + sn.airDate + ' (in ' + Math.max(0, Number(sn.days) || 0) + ' day' + (Number(sn.days) === 1 ? '' : 's') + ' — COMING SOON)' : ' · started ' + sn.airDate) : ''));
    if (sn.overview) L.push('Season ' + sn.number + ' story: ' + s(sn.overview).slice(0, 500));
  }
  if (x.language) L.push('Original language: ' + x.language + (x.country ? ' · country: ' + x.country : ''));
  return L.join('\n');
}
/** The extra prompt line for a series: write about the LATEST season, and say "coming" when it has not started yet. */
function seasonRule(story) {
  const sn = story && story.season;
  if (!sn || !sn.number) return '';
  const label = 'Season ' + sn.number;
  return 'This is a SERIES and the newest season is ' + label + (sn.name && sn.name !== label ? ' ("' + sn.name + '")' : '') + '. Write about THAT season' +
    (sn.coming
      ? ' as something COMING: say it starts on ' + sn.airDate + (Number(sn.days) >= 0 ? ' (in ' + Math.max(0, Number(sn.days) || 0) + ' days)' : '') + ', e.g. "' + label + ' lands ' + sn.airDate + '".'
      : ', e.g. "' + label + ' is here". Do not write about Season 1 unless ' + label + ' IS season 1.') +
    ' Never call an older season the new one, and never invent what happens in it.';
}
const isIndian = (st) => !!st && (INDIAN_LANGS.includes(s(st.language)) || /\bIN\b/.test(s(st.country)));

// Two hand-written examples (facts as the movie database has them) so the model sees the tone we want.
const EXAMPLES = [
  {
    facts: 'Title: Front of the Class (movie)\nOverview: The true story of Brad Cohen, who has Tourette syndrome. Laughed at as a kid and turned down by school after school, he refuses to give up on becoming a teacher.\nTop cast: James Wolk (as Brad Cohen), Treat Williams (as Norman Cohen), Patricia Heaton (as Ellen Cohen)\nGenres: Drama, History\nRelease: 2008-12-07\nOriginal language: English',
    reel: '🎥: Front of the Class (2008) is a biographical drama based on a true story. #inspiring',
    answer: { title: 'Front of the Class', caption: 'His tics got him laughed out of class — so Brad Cohen decided to run one 🍎\nJames Wolk plays the real teacher who lives with Tourette syndrome.\nHow many schools say no before one says yes? 👀', angle: 'real story', genres: ['Drama', 'Biography'], languages: ['English'], type: 'movie' },
  },
  {
    facts: 'Title: Off Campus (series)\nOverview: At Briar University, hockey star Garrett Graham needs to pass his ethics class to stay on the team, and Hannah Wells, who aces it, needs help getting her crush to notice her. So they make a deal.\nTop cast: Ella Bright (as Hannah Wells), Belmont Cameli (as Garrett Graham)\nGenres: Drama, Romance\nRelease: 2026-05-13\nOriginal language: English',
    reel: 'Off Campus is finally here 😍 who is watching?',
    answer: { title: 'Off Campus', caption: 'Briar\'s hockey star is failing ethics — and the girl who can save him only wants one thing: a fake date 😏🏒\nBelmont Cameli & Ella Bright make "The Deal" official.\nHow long does fake stay fake? 👀', angle: 'premise', genres: ['Drama', 'Romance'], languages: ['English'], type: 'series' },
  },
];

function prompt(text, typed, languages, story, opts) {
  const o = opts || {};
  const system = [
    'You write posts for the "What\'s new" feed of FluxFilm, an Indian shop selling streaming subscriptions (Netflix, Prime Video, JioHotstar…). People scroll it like Instagram, so every caption must stop the thumb.',
    'From the Facts (from a movie database) and the text you get (often an Instagram Reel caption), work out which movie or show it is about and answer as JSON:',
    '{"title": "", "caption": "", "angle": "", "genres": [], "languages": [], "type": ""}',
    'title: the official movie / show title only if the text or facts clearly name it (no year, no emojis), else "".',
    'caption: an Instagram-style hook, at most ' + CAPTION_ASK + ' characters, 2 or 3 short lines:',
    '  line 1 = a punchy hook that mentions something SPECIFIC from the facts: a character by name, the twist or premise, the setting, a cast member, or the real-story angle;',
    '  then 1 short line of context (who is in it / what it is / new season);',
    '  last = a curiosity line or question that makes people want to watch.',
    '  1 to 3 emojis. Simple English' + (isIndian(story) ? '; this is an Indian title, so light Hinglish is welcome' : '; light Hinglish only if it sounds natural') + '.',
    '  NEVER generic filler such as "fresh and entertaining watch", "heartwarming story", "must watch", "don\'t miss", "get ready", "fun drama", "watch with your family", "edge of your seat". If a line could describe any other film, rewrite it.',
    '  Use only the facts you are given: do not invent names, awards or plot points, and never reveal how it ends.',
    '  NO hashtags, NO @usernames, NO links, NO phone numbers, NO prices or offers, NO personal data.',
    'angle: 2 to 4 words naming the hook you used.',
    'genres: up to 3, ONLY from: ' + GENRES.join(', ') + '.',
    'languages: ONLY from: ' + languages.join(', ') + ' — only if the text or facts say so, else [].',
    'type: "movie", "series" or "" if unsure.',
    seasonRule(story),
    o.search ? 'The movie database knows little about this title: use Google Search to find what it is about, but keep to the rules above and answer with the JSON only.' : '',
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: system }];
  for (const ex of EXAMPLES) {
    msgs.push({ role: 'user', content: 'Facts:\n' + ex.facts + '\n\nText:\n' + ex.reel });
    msgs.push({ role: 'assistant', content: JSON.stringify(ex.answer) });
  }
  const facts = factLines(story);
  let user = (facts ? 'Facts:\n' + facts + '\n\n' : 'Facts: none found — rely on the text.\n\n') + 'Text:\n' + text.slice(0, 2500) + (typed ? '\n\nTitle typed by the shop owner: ' + typed.slice(0, 100) : '');
  if (o.rewrite) {
    user += '\n\nWrite a NEW caption with a different hook: this time lead with ' + ANGLES[(Number(o.rewrite) - 1) % ANGLES.length] + '.';
    if (s(o.previous)) user += ' Do not reuse the opening or the question of this earlier caption:\n' + s(o.previous).slice(0, 400);
  }
  msgs.push({ role: 'user', content: user });
  return msgs;
}

/** Barely known, or released / coming within ±90 days → worth a Google Search (Gemini only). */
function needsSearch(story, now) {
  if (!story || s(story.overview).length < 40) return true;
  const t = Date.parse(s(story.releaseDate) + 'T00:00:00Z');
  return !isNaN(t) && Math.abs((now || Date.now()) - t) < 90 * 86400e3;
}

/** The model(s) to try, in order: deps.model (tests) → Gemini (settings key) → DeepSeek (env key). */
function models(settings, d) {
  if (d.model !== undefined) return d.model ? [{ name: d.modelName || 'DeepSeek', call: d.model }] : [];
  const list = [];
  if (s(settings && settings.geminiKey)) {
    const gem = d.gemini || require('./feedgemini').callGemini;
    list.push({ name: 'Gemini', gemini: true, call: (msgs, o) => gem(msgs, { key: settings.geminiKey, maxTokens: 700, temperature: o.rewrite ? 1 : 0.8, timeoutMs: 20000, search: !!o.search, fetch: d.fetch }) });
  }
  if (process.env.DEEPSEEK_API_KEY) list.push({ name: 'DeepSeek', call: (msgs, o) => require('./oliviawords').callModel(msgs, { maxTokens: 450, temperature: o.rewrite ? 1 : 0.7, timeoutMs: 15000 }) });
  return list;
}

async function aiFill(input, deps) {
  const i = input || {};
  const d = deps || {};
  const feed = d.feed || require('./feed');
  const langNames = Object.values(feed.LANGS || {});
  const title = cleanTitle(i.title);
  const text = s(i.sourceCaption) || s(i.caption) || title;
  if (!text) return { ok: false, message: 'Paste the Instagram link (and save) or type a title first.' };
  const rewrite = Math.max(0, Math.min(50, Math.floor(Number(i.rewrite) || 0)));
  const fields = {}; const notes = [];
  let ai = false; let tokens = 0; let tmdb = false; let provider = ''; let angle = ''; let grounded = false; let season = null;

  let st = {};
  try { st = await feed.getSettings(); } catch (_) {}
  const chain = models(st, d);
  const year = (text.match(/\((19|20)\d\d\)/) || [''])[0].replace(/\D/g, '');

  // 1) Facts from the movie database (needs a TMDB key).
  let lookupError = '';
  const lookup = async (q) => {
    if (!st.tmdbKey || !q) return null;
    try { return await feed.tmdbMatch(q + (year && !/\d{4}/.test(q) ? ' (' + year + ')' : ''), { type: fields.type || i.type, brand: i.brand, service: i.ctaService || i.service }); }
    catch (e) { lookupError = String((e && e.message) || e).slice(0, 80); return null; }
  };
  let match = await lookup(title || feed.searchTitle(text.split('\n')[0]).q);

  // 2) The AI writes (with the facts when there are any).
  const write = async (story) => {
    const search = needsSearch(story, d.now);
    for (const m of chain) {
      const o = { rewrite, previous: i.previousCaption, search: !!m.gemini && search };
      let res = null;
      try { res = await m.call(prompt(text, title, langNames, story, o), o); } catch (_) { res = null; }
      if (res && res.json && typeof res.json === 'object') return Object.assign({ name: m.name }, res);
    }
    return null;
  };
  if (chain.length) {
    let res = await write(match && match.story);
    // Title only found by the AI → look it up now and, when that brings real facts, write the caption again with them.
    if (res && !match && cleanTitle(res.json.title) && st.tmdbKey) {
      match = await lookup(cleanTitle(res.json.title));
      if (match && match.story && s(match.story.overview)) {
        const again = await write(match.story);
        if (again) { again.tokens = (Number(again.tokens) || 0) + (Number(res.tokens) || 0); if (!cleanTitle(again.json.title)) again.json.title = res.json.title; res = again; }
      }
    }
    if (res) {
      ai = true; tokens = Number(res.tokens) || 0; provider = res.name; grounded = !!res.grounded;
      const j = res.json;
      const t = cleanTitle(j.title); if (t) fields.title = t;
      const c = cleanCaption(j.caption);
      if (c) {
        fields.caption = c;
        if (GENERIC.test(c)) notes.push('This caption still sounds a bit generic — tap ✨ Rewrite for another angle.');
        else if (s(i.previousCaption) && c === s(i.previousCaption)) notes.push('Same caption as before — tap ✨ Rewrite again.');
      } else if (s(j.caption)) notes.push('The AI caption was not safe to use — write one yourself.');
      angle = s(j.angle).replace(/[<>]/g, '').slice(0, 40);
      const g = mapGenres(j.genres); if (g.length) fields.genres = g;
      const l = (Array.isArray(j.languages) ? j.languages : []).map(s).filter((x) => langNames.includes(x)).slice(0, 3); if (l.length) fields.languages = l;
      if (j.type === 'movie' || j.type === 'series') fields.type = j.type;
    } else notes.push('The AI did not answer — try again in a minute.');
  } else notes.push('Add an AI key in settings for captions (Gemini key in ⚙️ Settings, or DEEPSEEK_API_KEY — the same key Olivia uses).');

  // 3) Facts decide title, genres, date, poster, trailer.
  if (st.tmdbKey) {
    if (match) {
      const m = match;
      tmdb = true;
      fields.title = m.title || fields.title;
      const g = mapGenres(m.genres); if (g.length) fields.genres = g;
      // 📅 Only a sure match dates the post (several titles with this name and no clear winner → the owner types it).
      if (m.releaseDate && m.sure !== false) { fields.releaseDate = m.releaseDate; if (m.type === 'series' && m.seasonLabel) fields.seasonLabel = m.seasonLabel; }
      // 🆕 Say which season the caption is about, so the owner can see it is the newest one and not season 1.
      const sn = m.story && m.story.season;
      if (m.type === 'series' && sn && sn.number) {
        season = { number: sn.number, name: sn.name, episodes: sn.episodes, airDate: sn.airDate, coming: !!sn.coming, days: Number(sn.days) || 0 };
        notes.push(sn.coming
          ? '🆕 Newest season: Season ' + sn.number + ' — coming ' + sn.airDate + (sn.days > 0 ? ' (in ' + sn.days + ' day' + (sn.days === 1 ? '' : 's') + ')' : '') + '.'
          : '🆕 Written about Season ' + sn.number + (sn.episodes ? ' (' + sn.episodes + ' episodes' + (sn.airDate ? ', from ' + sn.airDate : '') + ')' : sn.airDate ? ' (from ' + sn.airDate + ')' : '') + ' — the newest one.');
      }
      else notes.push(feed.NO_DATE || 'Couldn\'t find the date — type it');
      if (m.type) fields.type = m.type;
      if (m.languages && m.languages.length && !fields.languages) fields.languages = m.languages;
      if (m.imageUrl) fields.imageUrl = m.imageUrl;
      if (m.trailerUrl) fields.trailerUrl = m.trailerUrl;
      if (!fields.caption && !chain.length && m.caption) fields.caption = cleanCaption(m.caption);
    } else if (lookupError) notes.push('Title lookup failed: ' + lookupError);
    else notes.push('Could not find this title for genres / date — check the title.');
  } else notes.push('Add a TMDB key (⚙️ Settings) for genres, date and poster.');

  const got = Object.keys(fields);
  return {
    ok: true, fields, ai, provider, angle, grounded, rewrite, tmdb, tokens, notes, season,
    message: got.length ? '✨ Filled ' + got.join(', ') + (provider ? ' (' + provider + (grounded ? ' + Google Search' : '') + ')' : '') + ' — check and 💾 Save' : 'Nothing found to fill.',
  };
}

module.exports = { aiFill, GENRES, mapGenres, cleanCaption, CAPTION_MAX, CAPTION_ASK, ANGLES, GENERIC, EXAMPLES, _internal: { prompt, factLines, seasonRule, needsSearch, models, isIndian } };
