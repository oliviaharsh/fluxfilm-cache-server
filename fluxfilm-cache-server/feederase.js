/**
 * FluxFilm - 🧽 "Erase older reels" (admin → 🍿 What's new → 🧽 Erase older reels).
 *
 * Owner, 16 Sep 2026: "add a function in admin to erase older reels as per our preference — we can choose how much
 * older — it shows counts also — and which categories we want to erase, like Netflix or Prime Video. When our storage
 * hits 75% then we can erase, otherwise 10 GB is a lot."
 *
 * Only posts with an UPLOADED video (feedvideo.js) are ever touched — that is where the storage goes. YouTube Shorts
 * and Instagram reels are just links, so there is nothing to free.
 *
 * Choices (all shown as live counts BEFORE anything happens):
 *   days        older than 30 / 60 / 90 days, or any number you type — judged by the post's published date
 *               ("Publish at" when it has one, otherwise the day it was created)
 *   services    Netflix, Prime Video, … (none ticked = every service)
 *   hiddenOnly  ON by default: only posts already hidden (the 🧹 cleanup sets "Hide after"), so a live reel is never
 *               erased by accident
 *   keepTop     keep the N most-watched (or most-liked) of the ones that matched — default 0
 *   mode        'video' (default) erases the VIDEO and keeps the post, its words and its picture, so the page still
 *               works without the reel · 'post' deletes the whole post
 *
 * Erasing more than 10 posts asks the owner to type ERASE. Every run writes one change-log entry (adminfeed.js).
 * Works the same whether the bytes are in MySQL or in Cloudflare R2 — feedvideo.remove() knows which.
 */
const VIDEO_ID = /^fv[0-9a-f]{16}$/;
const CONFIRM_WORD = 'ERASE';
const CONFIRM_OVER = 10;
const DEFAULT_DAYS = 90;
const MAX_KEEP = 50;
const MODES = ['video', 'post'];
const BYS = ['views', 'likes'];

const s = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const MB = 1024 * 1024;
const mb = (b) => { const m = num(b) / MB; return m >= 1024 ? (Math.round(m / 102.4) / 10) + ' GB' : (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + ' MB'; };

function mods(deps) {
  const d = deps || {};
  return { feed: d.feed || require('./feed'), video: d.video || require('./feedvideo') };
}

/** Everything the browser sends, cleaned. Nothing here can widen the search by accident. */
function cleanOpts(input) {
  const i = input || {};
  const days = Math.floor(num(i.days));
  const keep = Math.floor(num(i.keepTop));
  return {
    days: days >= 1 && days <= 3650 ? days : DEFAULT_DAYS,
    services: (Array.isArray(i.services) ? i.services : s(i.services) ? s(i.services).split(',') : []).map((x) => s(x)).filter(Boolean).slice(0, 20),
    hiddenOnly: !(i.hiddenOnly === false || i.hiddenOnly === 'false' || i.hiddenOnly === 0 || i.hiddenOnly === '0'),
    keepTop: keep >= 1 ? Math.min(MAX_KEEP, keep) : 0,
    keepBy: BYS.includes(s(i.keepBy)) ? s(i.keepBy) : 'views',
    mode: MODES.includes(s(i.mode)) ? s(i.mode) : 'video',
  };
}

/**
 * Who would be erased, how much that frees, and what is left afterwards. Reads only — nothing is changed.
 * → { ok, criteria, counts, list, kept, store, services, needConfirm, confirmWord, message }
 */
async function preview(input, deps) {
  const { feed, video } = mods(deps);
  const o = cleanOpts(input);
  const items = await feed.list();
  const st = await feed.stats().catch(() => ({}));
  const reels = items.filter((p) => VIDEO_ID.test(s(p.videoId)));
  const sizes = await video.infoMany(reels.map((p) => s(p.videoId))).catch(() => ({}));
  const use = await video.usage().catch(() => null);
  const cutoff = new Date(Date.now() - o.days * 86400e3).toISOString();
  const brandOf = (p) => s(p.brand) || (feed.brandOf ? feed.brandOf(p.service) : s(p.service));
  const wanted = o.services.map((x) => x.toLowerCase());
  const rowOf = (p) => {
    const m = sizes[s(p.videoId)] || {};
    const k = st[p.id] || {};
    return {
      id: p.id, title: s(p.title), service: brandOf(p), status: feed.statusOf(p), date: feed.sortDate ? feed.sortDate(p) : (p.publishAt || p.createdAt || ''),
      videoId: s(p.videoId), size: num(m.size), storage: s(m.storage) || 'db', duration: m.duration == null ? null : num(m.duration),
      views: num(k.views), likes: num(k.likes), format: p.format === 'reel' ? 'reel' : 'post',
    };
  };
  const all = reels.map(rowOf);
  const matched = all.filter((r) => {
    if (!r.date || r.date >= cutoff) return false;
    if (o.hiddenOnly && r.status !== 'HIDDEN') return false;
    if (wanted.length && !wanted.includes(r.service.toLowerCase())) return false;
    return true;
  });
  // Keep the best N of the ones that matched (the owner's favourites survive the clean-up).
  const ranked = matched.slice().sort((a, b) => (o.keepBy === 'likes' ? b.likes - a.likes || b.views - a.views : b.views - a.views || b.likes - a.likes) || (a.date < b.date ? 1 : -1));
  const kept = o.keepTop ? ranked.slice(0, o.keepTop) : [];
  const keptIds = new Set(kept.map((x) => x.id));
  const list = matched.filter((r) => !keptIds.has(r.id)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const bytes = list.reduce((a, x) => a + x.size, 0);
  const mode = (use && use.mode) || 'db';
  const now = use ? num(use.bytes) : 0; const total = use ? num(use.totalBytes) : 0;
  const after = Math.max(0, now - bytes);
  const pctOf = (b) => (total > 0 ? Math.round((b / total) * 1000) / 10 : 0);
  const store = { mode, bytes: now, totalBytes: total, pct: pctOf(now), afterBytes: after, afterPct: pctOf(after), text: mb(now) + ' of ' + mb(total), afterText: mb(after) + ' of ' + mb(total), warn: !!(use && use.warn) };
  return {
    ok: true, criteria: o, confirmWord: CONFIRM_WORD, needConfirm: list.length > CONFIRM_OVER, confirmOver: CONFIRM_OVER,
    counts: { reels: all.length, matched: matched.length, kept: kept.length, posts: list.length, bytes },
    list, kept, store,
    services: [...new Set(all.map((x) => x.service).filter(Boolean))].sort(),
    message: list.length
      ? list.length + ' reel' + (list.length === 1 ? '' : 's') + ' · ' + mb(bytes) + ' would be erased — ' + mb(after) + ' of ' + mb(total) + ' left after'
      : 'Nothing matches those choices — nothing would be erased.',
  };
}

/**
 * Do it. Same choices as preview() plus { confirm } (the word ERASE, needed above 10 posts) and an optional
 * { ids } the owner un-ticked down to — ids are always checked against the preview, so nothing outside it can go.
 */
async function run(input, deps) {
  const { feed } = mods(deps);
  const o = cleanOpts(input);
  const pv = await preview(input, deps);
  let list = pv.list;
  const only = Array.isArray(input && input.ids) ? new Set((input.ids || []).map((x) => s(x))) : null;
  if (only) list = list.filter((x) => only.has(x.id));
  if (!list.length) return { ok: false, message: 'Nothing matches those choices — nothing was erased.' };
  if (list.length > CONFIRM_OVER && s(input && input.confirm).toUpperCase() !== CONFIRM_WORD) {
    return { ok: false, needConfirm: true, confirmWord: CONFIRM_WORD, count: list.length, message: 'That would erase ' + list.length + ' posts — type ' + CONFIRM_WORD + ' to confirm.' };
  }
  const done = []; const failed = [];
  for (const r of list) {
    try {
      const x = o.mode === 'post' ? await feed.remove(r.id) : await feed.dropVideo(r.id);
      if (x && x.ok) done.push(r); else failed.push({ id: r.id, title: r.title, message: s(x && x.message) || 'could not erase' });
    } catch (e) { failed.push({ id: r.id, title: r.title, message: s(e && e.message).slice(0, 160) }); }
  }
  const bytes = done.reduce((a, x) => a + x.size, 0);
  return {
    ok: true, mode: o.mode, criteria: o, erased: done.length, bytes, failed,
    list: done.map((x) => ({ id: x.id, title: x.title, service: x.service, date: x.date, size: x.size, views: x.views })),
    summary: (o.mode === 'post' ? 'Deleted ' : 'Erased the video of ') + done.length + ' older reel' + (done.length === 1 ? '' : 's') + ' (' + mb(bytes) + ' freed'
      + ', older than ' + o.days + ' days, ' + (o.services.length ? o.services.join(', ') : 'all services')
      + (o.hiddenOnly ? ', hidden posts only' : ', live posts included') + (o.keepTop ? ', kept the top ' + o.keepTop + ' by ' + o.keepBy : '') + ')',
    message: '🧽 ' + (o.mode === 'post' ? 'Deleted ' : 'Erased ') + done.length + ' reel' + (done.length === 1 ? '' : 's') + ' · ' + mb(bytes) + ' freed'
      + (failed.length ? ' · ⚠️ ' + failed.length + ' could not be erased' : ''),
  };
}

module.exports = { preview, run, cleanOpts, CONFIRM_WORD, CONFIRM_OVER, DEFAULT_DAYS, mb };
