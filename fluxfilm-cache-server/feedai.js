/**
 * FluxFilm - ✨ AI fill for a 🍿 What's new post (admin editor button). Suggests; never saves.
 *
 * aiFill({ title, caption, sourceCaption, type, brand, ctaService }, deps) →
 *   { ok, fields: { title?, caption?, genres?, languages?, type?, releaseDate?, seasonLabel?, imageUrl?, trailerUrl? }, ai, tmdb, tokens, notes[], message }
 *
 * - Text = the Reel's own caption (sourceCaption, fetched with the thumbnail) → else the typed caption → else the title.
 * - The AI (the same DeepSeek adapter + DEEPSEEK_API_KEY Olivia uses, oliviawords.callModel) only WRITES: a clean title
 *   if the text clearly names one, a short caption (≤ 300 characters, Hinglish-friendly, no hashtags / links / numbers /
 *   personal data), genres from a fixed list, languages, movie / series.
 * - Facts come from TMDB (existing server-side TMDB code, feed.tmdbMatch): genres, release date, poster, trailer — a date
 *   is only filled when TMDB found the title.
 * - No AI key → TMDB-only fill + "Add an AI key in settings for captions". Nothing is logged except the token count.
 */
const mod = require('./feedmod');

const GENRES = ['Action', 'Adventure', 'Animation', 'Anime', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Music', 'Mystery', 'Reality', 'Romance', 'Sci-Fi', 'Sports', 'Thriller', 'War'];
// TMDB genre names → the fixed list ("Action & Adventure" → Action + Adventure).
const TMDB_GENRES = { 'action & adventure': ['Action', 'Adventure'], 'sci-fi & fantasy': ['Sci-Fi', 'Fantasy'], 'science fiction': ['Sci-Fi'], 'war & politics': ['War'], soap: ['Drama'], talk: [], news: [], 'tv movie': [], western: ['Action'] };
const CAPTION_MAX = 300;

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

function prompt(text, typed, languages) {
  const system = [
    'You write posts for the "What\'s new" feed of FluxFilm, an Indian shop selling streaming subscriptions (Netflix, Prime Video, JioHotstar…).',
    'From the text you get (often an Instagram Reel caption), work out which movie or show it is about and answer as JSON:',
    '{"title": "", "caption": "", "genres": [], "languages": [], "type": ""}',
    'title: the official movie / show title only if the text clearly names it (no year, no emojis), else "".',
    'caption: max 280 characters, warm and exciting, why to watch it; simple English or light Hinglish; at most 2 emojis;',
    'NO hashtags, NO @usernames, NO links, NO phone numbers, NO prices or offers, NO personal data, no spoilers, do not invent facts that are not in the text.',
    'genres: up to 3, ONLY from: ' + GENRES.join(', ') + '.',
    'languages: ONLY from: ' + languages.join(', ') + ' — only if the text says so, else [].',
    'type: "movie", "series" or "" if unsure.',
  ].join('\n');
  const user = 'Text:\n' + text.slice(0, 2500) + (typed ? '\n\nTitle typed by the shop owner: ' + typed.slice(0, 100) : '');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function aiFill(input, deps) {
  const i = input || {};
  const d = deps || {};
  const feed = d.feed || require('./feed');
  const langNames = Object.values(feed.LANGS || {});
  const model = d.model !== undefined ? d.model : (process.env.DEEPSEEK_API_KEY ? (msgs) => require('./oliviawords').callModel(msgs, { maxTokens: 450, temperature: 0.6, timeoutMs: 15000 }) : null);
  const title = cleanTitle(i.title);
  const text = s(i.sourceCaption) || s(i.caption) || title;
  if (!text) return { ok: false, message: 'Paste the Instagram link (and save) or type a title first.' };
  const fields = {}; const notes = [];
  let ai = false; let tokens = 0; let tmdb = false;

  if (model) {
    let res = null;
    try { res = await model(prompt(text, title, langNames)); } catch (_) { res = null; }
    if (res && res.json && typeof res.json === 'object') {
      ai = true; tokens = Number(res.tokens) || 0;
      const j = res.json;
      const t = cleanTitle(j.title); if (t) fields.title = t;
      const c = cleanCaption(j.caption); if (c) fields.caption = c; else if (s(j.caption)) notes.push('The AI caption was not safe to use — write one yourself.');
      const g = mapGenres(j.genres); if (g.length) fields.genres = g;
      const l = (Array.isArray(j.languages) ? j.languages : []).map(s).filter((x) => langNames.includes(x)).slice(0, 3); if (l.length) fields.languages = l;
      if (j.type === 'movie' || j.type === 'series') fields.type = j.type;
    } else notes.push('The AI did not answer — try again in a minute.');
  } else notes.push('Add an AI key in settings for captions (DEEPSEEK_API_KEY — the same key Olivia uses).');

  let st = {};
  try { st = await feed.getSettings(); } catch (_) {}
  if (st.tmdbKey) {
    const year = (text.match(/\((19|20)\d\d\)/) || [''])[0].replace(/\D/g, '');
    const query = fields.title || title || feed.searchTitle(text.split('\n')[0]).q;
    try {
      const m = query ? await feed.tmdbMatch(query + (year && !/\d{4}/.test(query) ? ' (' + year + ')' : ''), { type: fields.type || i.type, brand: i.brand, service: i.ctaService || i.service }) : null;
      if (m) {
        tmdb = true;
        fields.title = m.title || fields.title;
        const g = mapGenres(m.genres); if (g.length) fields.genres = g;
        // 📅 Only a sure match dates the post (several titles with this name and no clear winner → the owner types it).
        if (m.releaseDate && m.sure !== false) { fields.releaseDate = m.releaseDate; if (m.type === 'series' && m.seasonLabel) fields.seasonLabel = m.seasonLabel; }
        else notes.push(feed.NO_DATE || 'Couldn\'t find the date — type it');
        if (m.type) fields.type = m.type;
        if (m.languages && m.languages.length && !fields.languages) fields.languages = m.languages;
        if (m.imageUrl) fields.imageUrl = m.imageUrl;
        if (m.trailerUrl) fields.trailerUrl = m.trailerUrl;
        if (!fields.caption && !model && m.caption) fields.caption = cleanCaption(m.caption);
      } else notes.push('Could not find this title for genres / date — check the title.');
    } catch (e) { notes.push('Title lookup failed: ' + String((e && e.message) || e).slice(0, 80)); }
  } else notes.push('Add a TMDB key (⚙️ Settings) for genres, date and poster.');

  const got = Object.keys(fields);
  return {
    ok: true, fields, ai, tmdb, tokens, notes,
    message: got.length ? '✨ Filled ' + got.join(', ') + ' — check and 💾 Save' : 'Nothing found to fill.',
  };
}

module.exports = { aiFill, GENRES, mapGenres, cleanCaption, CAPTION_MAX, _internal: { prompt } };
