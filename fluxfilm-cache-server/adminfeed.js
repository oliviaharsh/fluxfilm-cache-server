/**
 * FluxFilm - admin 🍿 Feed (admin-only). See feed.js.
 *
 *   GET  /admin/api/feed                   → { posts (status, views, likes, clicks), services, settings (no key), job }
 *   POST /admin/api/feed/save              { ...post }          create / update (pin, on/off = save)
 *   POST /admin/api/feed/delete            { id }
 *   POST /admin/api/feed/image             { id, dataUrl }      '' removes the picture
 *   POST /admin/api/feed/settings          { tmdbKey?, clearKey?, autoPublish?, platforms?, languages?, minPopularity?, minVotes?, maxPerDay?, autoHideDays?, releasedDays?, upcomingDays?, seriesNewOnly?, providerMap? }
 *   POST /admin/api/feed/tmdb/search       { q }
 *   POST /admin/api/feed/tmdb/create       { tmdbKey, service, publish }
 *   POST /admin/api/feed/tmdb/suggest      { services[], days }  drafts only
 *   POST /admin/api/feed/tmdb/providers    {}                    TMDB's current India provider ids
 *   POST /admin/api/feed/run               {}                    run the TMDB import now (daily cap still applies)
 *   GET  /admin/api/feed/cleanup/not-new                         🧹 LIVE imported posts that are not new / have no new season
 *   POST /admin/api/feed/dates/refresh     {}                    📅 dates + "Season N" of imported posts from TMDB now (edited: empty fields only)
 *   POST /admin/api/feed/cleanup/hide      { ids[] }            hide those (hideAfter = now; never deleted; change log)
 *   POST /admin/api/feed/video/start       { mime, size, sha256, duration } → { id, chunks, chunkSize, maxBytes, maxSeconds }
 *   POST /admin/api/feed/video/chunk       ?id=&n=  raw ~1 MB octet-stream body
 *   GET  /admin/api/feed/video/status      ?id=                  📶 resume: { chunks, have[], missing[], next }
 *   POST /admin/api/feed/video/finish      { id }
 *   POST /admin/api/feed/video/settings    { videoMaxMb?, videoTotalMb?, videoMaxSeconds?, videoMaxMbR2?, videoTotalMbR2? }
 *   POST /admin/api/feed/thumb/refresh     { id }                📸 fetch the Instagram thumbnail + Reel caption again (server-side)
 *   POST /admin/api/feed/thumb             { id, dataUrl }       the admin page's shrunk copy of a big thumbnail ('' removes it)
 *   POST /admin/api/feed/ai-fill           { title, caption, sourceCaption, type, rewrite?, previousCaption? }   ✨ suggestions only (nothing saved); rewrite = ✨ Rewrite count
 *   GET  /admin/api/feed/comments          ?status=pending|visible|hidden|all&post=<id>   💬 list + counts
 *   POST /admin/api/feed/comments/action   { id, action: approve|hide|delete|block|unblock }
 *   🪣 Cloudflare R2 video storage (r2.js) — the two keys are write-only: they go in, they never come back out.
 *   GET  /admin/api/feed/video/storage                           → { video: usage, r2: { on, bucket, keySet, secretSet, … } }
 *   POST /admin/api/feed/video/storage     { on?, accountId?, bucket?, accessKeyId?, secretAccessKey?, publicBase?, clearKeys? }
 *   POST /admin/api/feed/video/test        {}                    🔌 write + read + delete a tiny test object
 *   POST /admin/api/feed/video/migrate     {}                    ⬆️ move ONE database video to R2 (call again for the next)
 *   🧽 Erase older reels (feederase.js)
 *   POST /admin/api/feed/erase/preview     { days, services[], hiddenOnly, keepTop, keepBy, mode }   counts only, changes nothing
 *   POST /admin/api/feed/erase             { …the same + confirm: 'ERASE' (over 10 posts), ids[]? }
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const feed = deps.feed || require('./feed');
  const comments = deps.comments || require('./feedcomments');
  // ❤️ 🔖 account likes / saves (feedmarks.js): only "is schema-v25 in?" + totals for the note in the list.
  let marks = deps.marks || null; if (!marks) { try { marks = require('./feedmarks'); } catch (_) { marks = null; } }
  let videos = deps.videos || null; if (!videos) { try { videos = require('./feedvideo'); } catch (_) { videos = null; } }
  // 🪣 Cloudflare R2 video storage (r2.js) and 🧽 Erase older reels (feederase.js).
  let r2 = deps.r2 || null; if (!r2) { try { r2 = require('./r2'); } catch (_) { r2 = null; } }
  let erase = deps.erase || null; if (!erase) { try { erase = require('./feederase'); } catch (_) { erase = null; } }
  const ai = deps.ai || require('./feedai');
  // ✨ AI fill costs AI tokens: 20 per 10 minutes for the whole admin.
  let aiLimit = null; try { aiLimit = require('./security').rateLimiter(20, 10 * 60e3); } catch (_) {}
  const THUMB_BUDGET_MS = deps.thumbBudgetMs || 12000;
  const fail = (res, e) => res.status(e && e.code === 'NOKEY' ? 400 : 500).json({ ok: false, message: String((e && e.message) || e) });
  const route = (p, fn) => app.post(p, async (req, res) => { if (!auth(req, res)) return; try { await fn(req, res, req.body || {}); } catch (e) { fail(res, e); } });

  app.get('/admin/api/feed', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [items, st, settings, info, job, cm, mk] = await Promise.all([feed.list(), feed.stats(), feed.getSettings(), feed.catalogServiceInfo(), feed.jobStatus().catch(() => null),
        comments.adminList({ status: 'pending', limit: 1 }).catch(() => ({ ready: false, counts: {}, byPost: {} })),
        marks ? marks.adminInfo().catch(() => ({ ready: false })) : Promise.resolve({ ready: false })]);
      const vu = videos ? await videos.usage().catch(() => ({ ready: false })) : { ready: false };
      const al = marks && marks.likeCounts ? await marks.likeCounts().catch(() => null) : null;
      const byPost = cm.byPost || {};
      const posts = feed.sortPosts(items).map((p) => Object.assign({}, p, { status: feed.statusOf(p), views: (st[p.id] || {}).views || 0, likes: al ? (al[p.id] || 0) : (st[p.id] || {}).likes || 0, clicks: (st[p.id] || {}).clicks || 0, shares: (st[p.id] || {}).shares || 0, plays: (st[p.id] || {}).plays || 0, comments: byPost[p.id] || { visible: 0, pending: 0, hidden: 0 } }));
      res.json({ ok: true, posts, services: info.map((x) => x.service), serviceInfo: info, brands: feed.BRANDS.map((b) => ({ name: b.name, emoji: b.emoji })), settings: feed.publicSettings(settings), job, max: feed.MAX_POSTS, now: new Date().toISOString(), commentsReady: !!cm.ready, commentCounts: cm.counts || {}, marksReady: !!mk.ready, marksCounts: { likes: Number(mk.likes) || 0, saves: Number(mk.saves) || 0 }, video: videoSummary(vu, items) });
    } catch (e) { fail(res, e); }
  });

  // 🎬 Storage card: "Videos: 312 MB of 2 GB used", each video with its size and the post using it.
  function videoSummary(vu, items) {
    const used = {}; (items || []).forEach((p) => { if (p.videoId) used[p.videoId] = { id: p.id, title: p.title }; });
    return {
      ready: !!vu.ready, videos: Number(vu.videos) || 0, bytes: Number(vu.bytes) || 0, freeBytes: Number(vu.freeBytes) || 0, maxBytes: Number(vu.maxBytes) || 0, totalBytes: Number(vu.totalBytes) || 0,
      maxSeconds: Number(vu.maxSeconds) || 300, limits: vu.limits || {}, caps: vu.caps || {},
      // 🪣 which store is in use, both storage bars, the ⚠️ 75% warning and how many videos still wait to be moved.
      mode: vu.mode || 'db', schemaV27: !!vu.schemaV27, db: vu.db || null, r2: vu.r2 || null, warn: vu.warn || null, migrate: vu.migrate || null,
      list: (vu.list || []).map((x) => Object.assign({}, x, { post: used[x.id] || null })),
    };
  }

  // 🎬 Reel video upload (feedvideo.js): start → chunks (raw ~1 MB bodies, never base64) → finish (size + SHA-256) → the
  // editor puts the video id on the post and 💾 Save links it (feed.save checks the upload is complete).
  route('/admin/api/feed/video/start', async (req, res, b) => {
    if (!videos) return res.status(400).json({ ok: false, message: 'Video upload is not available.' });
    const r = await videos.start({ mime: b.mime, size: b.size, sha256: b.sha256, duration: b.duration });
    res.status(r.ok ? 200 : 400).json(r);
  });
  const rawBody = require('express').raw({ type: 'application/octet-stream', limit: '1100kb' });
  app.post('/admin/api/feed/video/chunk', rawBody, async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!videos) return res.status(400).json({ ok: false, message: 'Video upload is not available.' });
      const r = await videos.chunk(String(req.query.id || ''), Number(req.query.n), Buffer.isBuffer(req.body) ? req.body : null);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { fail(res, e); }
  });
  // 📶 Resume an interrupted upload: which parts are already in, so the page carries on from the first missing one.
  app.get('/admin/api/feed/video/status', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!videos) return res.status(400).json({ ok: false, message: 'Video upload is not available.' });
      const r = await videos.status(String((req.query && req.query.id) || ''));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { fail(res, e); }
  });
  route('/admin/api/feed/video/finish', async (req, res, b) => {
    if (!videos) return res.status(400).json({ ok: false, message: 'Video upload is not available.' });
    const r = await videos.finish(String(b.id || ''));
    if (r.ok) audit.record(req, { action: 'feed.video', entity: 'feed', id: r.id, summary: 'Uploaded a Reel video (' + Math.round(r.size / 1048576 * 10) / 10 + ' MB)' });
    res.status(r.ok ? 200 : 400).json(r);
  });
  app.get('/admin/api/feed/videos', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(Object.assign({ ok: true }, videoSummary(videos ? await videos.usage() : { ready: false }, await feed.list()))); } catch (e) { fail(res, e); }
  });
  // Delete frees the chunks. A video still on a post is refused (remove it in the post, or delete the post).
  route('/admin/api/feed/video/delete', async (req, res, b) => {
    if (!videos) return res.json({ ok: true });
    const id = String(b.id || '');
    const p = (await feed.list()).find((x) => x.videoId === id);
    if (p) return res.status(400).json({ ok: false, inUse: true, message: 'This video is on the post "' + p.title + '" — remove it there and 💾 Save, or delete the post.' });
    const r = await videos.remove(id);
    if (r.ok) audit.record(req, { action: 'feed.video.delete', entity: 'feed', id, summary: 'Deleted a Reel video (' + (r.freedChunks || 0) + ' MB freed)' });
    res.status(r.ok ? 200 : 400).json(r);
  });
  route('/admin/api/feed/video/settings', async (req, res, b) => {
    if (!videos) return res.status(400).json({ ok: false, message: 'Video upload is not available.' });
    const r = await videos.saveLimits({ videoMaxMb: b.videoMaxMb, videoTotalMb: b.videoTotalMb, videoMaxSeconds: b.videoMaxSeconds, videoMaxMbR2: b.videoMaxMbR2, videoTotalMbR2: b.videoTotalMbR2 });
    if (r.ok) audit.record(req, { action: 'feed.video.settings', entity: 'feed', id: 'videos', summary: 'Reel video limits: ' + r.limits.videoMaxMb + ' MB per video, ' + r.limits.videoMaxSeconds + ' s long, ' + r.limits.videoTotalMb + ' MB total · Cloudflare R2: ' + r.limits.videoMaxMbR2 + ' MB per video, ' + r.limits.videoTotalMbR2 + ' MB total' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  // ---------------------------------------------------------------- 🪣 Cloudflare R2 video storage
  // The Access Key ID and the Secret Access Key are WRITE-ONLY: they are saved on the server and never sent back,
  // never logged and never written to the change log (the log only says a key was saved / removed).
  const noR2 = (res) => res.status(400).json({ ok: false, message: 'Cloudflare R2 storage is not available on this server.' });
  app.get('/admin/api/feed/video/storage', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!videos || !r2) return noR2(res);
      const [vu, cfg, mig] = await Promise.all([videos.usage(), r2.getConfig(true), videos.migrateStatus().catch(() => null)]);
      res.json({ ok: true, video: videoSummary(vu, await feed.list()), r2: r2.publicConfig(cfg), migrate: mig, ops: cfg.ready ? await r2.getOps().catch(() => null) : null });
    } catch (e) { fail(res, e); }
  });
  route('/admin/api/feed/video/storage', async (req, res, b) => {
    if (!videos || !r2) return noR2(res);
    if (b.on === true && !(await videos.hasR2Cols(true))) return res.status(400).json({ ok: false, notReady: true, message: videos.NOT_READY_R2 });
    const r = await r2.saveConfig({ on: b.on, accountId: b.accountId, bucket: b.bucket, accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, publicBase: b.publicBase, clearKeys: b.clearKeys });
    if (!r.ok) return res.status(400).json(r);
    if (r.changed.length) audit.record(req, { action: 'feed.video.storage', entity: 'feed', id: 'r2', summary: '🪣 Video storage: ' + r.changed.join(', ') });
    res.json(r);
  });
  route('/admin/api/feed/video/test', async (req, res, b) => {
    if (!r2) return noR2(res);
    // Test what is on the screen RIGHT NOW, laid over what is saved (r2.mergeConfig) — the two key boxes are blank
    // once a key is saved, so a blank box means "use the saved key". Nothing is written, no key is logged.
    const r = await r2.testConnection({ accountId: b.accountId, bucket: b.bucket, accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, publicBase: b.publicBase });
    audit.record(req, { action: 'feed.video.storage.test', entity: 'feed', id: 'r2', summary: '🔌 Tested Cloudflare R2: ' + (r.ok ? 'works' : 'failed') });
    res.status(r.ok ? 200 : 400).json(r);
  });
  // ⬆️ One video per call so the admin page can show progress and the owner can stop at any time.
  route('/admin/api/feed/video/migrate', async (req, res) => {
    if (!videos) return noR2(res);
    const r = await videos.migrateNext();
    if (!r.ok) return res.status(400).json(r);
    if (r.moved) audit.record(req, { action: 'feed.video.migrate', entity: 'feed', id: r.moved.id, summary: '⬆️ Moved Reel video ' + r.moved.id + ' (' + Math.round(r.moved.size / 1048576 * 10) / 10 + ' MB) to Cloudflare R2; ' + r.left + ' left in the database' });
    res.json(r);
  });

  // ---------------------------------------------------------------- 🧽 Erase older reels
  route('/admin/api/feed/erase/preview', async (req, res, b) => {
    if (!erase) return res.status(400).json({ ok: false, message: '🧽 Erase older reels is not available on this server.' });
    res.json(await erase.preview(b, { feed, video: videos }));
  });
  route('/admin/api/feed/erase', async (req, res, b) => {
    if (!erase) return res.status(400).json({ ok: false, message: '🧽 Erase older reels is not available on this server.' });
    const r = await erase.run(b, { feed, video: videos });
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, {
      action: r.mode === 'post' ? 'feed.erase.posts' : 'feed.erase.videos', entity: 'feed',
      id: r.list.map((x) => x.id).join(',').slice(0, 190), summary: '🧽 ' + r.summary + ': ' + r.list.map((x) => '"' + x.title + '"').join(', ').slice(0, 380),
      details: { criteria: r.criteria, erased: r.list, failed: r.failed },
    });
    res.json(r);
  });

  route('/admin/api/feed/save', async (req, res, body) => {
    // 📅 A movie / series saved without a release date (not an imported post): look the date up by title now.
    let b = body; let autoDate = null;
    if (feed.autoDate && (b.type === 'movie' || b.type === 'series') && !String(b.releaseDate || '').trim() && b.source !== 'tmdb' && b.autoDate !== false && String(b.title || '').trim()) {
      try { autoDate = await feed.autoDate(b); } catch (_) { autoDate = { found: false, message: feed.NO_DATE || '' }; }
      if (autoDate && autoDate.found) b = Object.assign({}, b, { releaseDate: autoDate.releaseDate, dateAuto: true, releaseRegion: autoDate.releaseRegion || '', seasonLabel: String(b.seasonLabel || '') || autoDate.seasonLabel || '' });
      if (autoDate && !autoDate.message) autoDate = null;
    }
    const r = await feed.save(b);
    if (autoDate) r.autoDate = { found: !!autoDate.found, releaseDate: autoDate.releaseDate || '', seasonLabel: autoDate.seasonLabel || '', message: autoDate.message };
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, { action: r.created ? 'feed.create' : 'feed.update', entity: 'feed', id: r.post.id, summary: (r.created ? 'Created' : 'Updated') + ' feed post "' + r.post.title + '" (' + (r.post.brand && r.post.brand !== r.post.service ? r.post.brand + ' → ' : '') + (r.post.service || r.post.type) + ', ' + (r.post.active ? 'on' : 'off') + (r.post.pinned ? ', pinned' : '') + ')' });
    // New / changed Reel link: fetch its thumbnail + caption now (server-side, time-boxed; the post is already saved).
    if (r.igChanged && r.post.instagramUrl && feed.refreshThumb) {
      try { r.thumb = await feed.refreshThumb(r.post.id, { budgetMs: THUMB_BUDGET_MS }); if (r.thumb && r.thumb.post) { r.post = r.thumb.post; delete r.thumb.post; } }
      catch (e) { r.thumb = { ok: false, message: '⚠️ Thumbnail not fetched: ' + String((e && e.message) || e).slice(0, 80) }; }
    }
    res.json(Object.assign(r, { status: feed.statusOf(r.post) }));
  });

  route('/admin/api/feed/thumb/refresh', async (req, res, b) => {
    const r = await feed.refreshThumb(String(b.id || ''), { budgetMs: THUMB_BUDGET_MS });
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, { action: 'feed.thumb', entity: 'feed', id: r.post.id, summary: 'Refreshed Instagram thumbnail of "' + r.post.title + '": ' + (r.thumb ? 'saved (' + r.source + ')' : r.poster ? 'blocked, poster used' : 'not found (' + (r.reason || 'blocked') + ')') });
    const post = r.post; delete r.post;
    res.json(Object.assign(r, { post, status: feed.statusOf(post) }));
  });

  route('/admin/api/feed/thumb', async (req, res, b) => {
    const r = await feed.setThumb(String(b.id || ''), b.dataUrl);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, hasThumb: r.hasThumb, updatedAt: r.post.updatedAt, thumbAt: r.post.thumbAt });
  });

  route('/admin/api/feed/ai-fill', async (req, res, b) => {
    if (aiLimit && !aiLimit.hit('admin').ok) return res.status(429).json({ ok: false, message: 'Too many ✨ AI fills — wait a few minutes.' });
    const r = await ai.aiFill({ title: b.title, caption: b.caption, sourceCaption: b.sourceCaption, type: b.type, brand: b.brand, ctaService: b.ctaService, rewrite: b.rewrite, previousCaption: b.previousCaption });
    if (r.ok && r.tokens) console.log('[feed] AI ' + (b.rewrite ? 'rewrite' : 'fill') + ' used ' + r.tokens + ' tokens' + (r.provider ? ' (' + r.provider + ')' : ''));
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.get('/admin/api/feed/comments', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await comments.adminList({ status: String((req.query && req.query.status) || ''), postId: String((req.query && req.query.post) || ''), limit: 150 })); }
    catch (e) { fail(res, e); }
  });

  route('/admin/api/feed/comments/action', async (req, res, b) => {
    const action = String(b.action || '');
    const r = await comments.adminAction(b.id, action);
    if (!r.ok) return res.status(400).json(r);
    const c = r.comment;
    const words = { approve: 'Approved', hide: 'Hid', delete: 'Deleted', block: 'Blocked commenter …' + c.phone.slice(-4) + ' (all their comments hidden) for', unblock: 'Unblocked commenter …' + c.phone.slice(-4) + ' for' };
    audit.record(req, { action: 'feed.comment.' + action, entity: 'feed', id: c.postId, summary: words[action] + ' comment #' + c.id + ' by ' + c.name + ' on post ' + c.postId });
    res.json(r);
  });

  route('/admin/api/feed/delete', async (req, res, b) => {
    const r = await feed.remove(String(b.id || ''));
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, { action: 'feed.delete', entity: 'feed', id: r.post.id, summary: 'Deleted feed post "' + r.post.title + '"' });
    res.json({ ok: true });
  });

  route('/admin/api/feed/image', async (req, res, b) => {
    const r = await feed.setImage(String(b.id || ''), b.dataUrl);
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, { action: 'feed.image', entity: 'feed', id: String(b.id || ''), summary: (r.hasImage ? 'Uploaded picture for' : 'Removed picture from') + ' feed post "' + r.post.title + '"' });
    res.json({ ok: true, hasImage: r.hasImage, updatedAt: r.post.updatedAt });
  });

  route('/admin/api/feed/settings', async (req, res, b) => {
    const r = await feed.saveSettings(b);
    if (!r.ok) return res.status(400).json(r);
    // Only what changed, never the key itself.
    if (r.changed.length) audit.record(req, { action: 'feed.settings', entity: 'feed', summary: 'Feed settings: ' + r.changed.join(', ') });
    // A new key starts the automatic feed straight away (in the background; the page shows the result).
    if (r.changed.includes('TMDB key saved') && feed.runImport) feed.runImport({ force: true, audit }).catch(() => {});
    res.json(r);
  });

  route('/admin/api/feed/tmdb/search', async (req, res, b) => {
    const r = await feed.tmdbSearch(b.q);
    res.status(r.ok ? 200 : 400).json(r);
  });

  route('/admin/api/feed/tmdb/create', async (req, res, b) => {
    const r = await feed.tmdbCreate(String(b.tmdbKey || ''), String(b.service || ''), b.publish === true);
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, { action: 'feed.create', entity: 'feed', id: r.post.id, summary: 'Created feed post "' + r.post.title + '" from TMDB (' + r.post.service + ', ' + (r.post.active ? 'published' : 'draft') + ')' });
    res.json(Object.assign(r, { status: feed.statusOf(r.post) }));
  });

  route('/admin/api/feed/tmdb/suggest', async (req, res, b) => {
    // No platform picked = the platforms chosen in Settings (or every active catalog service).
    const r = await feed.tmdbSuggest(Array.isArray(b.services) ? b.services : [], b.days);
    res.status(r.ok ? 200 : 400).json(r);
  });

  route('/admin/api/feed/run', async (req, res) => {
    const r = await feed.runImport({ force: true, audit, req });
    if (r.skipped === 'no-key') return res.status(400).json({ ok: false, message: 'Add your TMDB key in Settings first.' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  // 🧹 Old titles imported by mistake: list (read-only, asks TMDB about seasons) → hide the ticked ones (never delete).
  app.get('/admin/api/feed/cleanup/not-new', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await feed.notNewCandidates()); } catch (e) { fail(res, e); }
  });
  // 📅 Dates + season labels of imported posts from TMDB now (edited posts: empty fields only). Change log lists them.
  route('/admin/api/feed/dates/refresh', async (req, res) => {
    const r = await feed.refreshDates({ force: true });
    if (!r.ok) return res.status(400).json(r);
    if (r.updated.length) audit.record(req, { action: 'feed.dates.refresh', entity: 'feed', id: r.updated.map((x) => x.id).join(',').slice(0, 190), summary: 'Refreshed dates of ' + r.updated.length + ' imported post(s): ' + r.updated.map((x) => '"' + x.title + '" ' + (x.from || '—') + ' → ' + x.to + (x.seasonLabel ? ' (' + x.seasonLabel + ')' : '')).join(', ').slice(0, 400), details: { updated: r.updated } });
    res.json(Object.assign(r, { message: '📅 Checked ' + r.checked + ' · updated ' + r.updated.length + (r.notNew ? ' · ' + r.notNew + ' no longer new (use 🧹)' : '') + (r.failed ? ' · ' + r.failed + ' could not be checked' : '') }));
  });
  route('/admin/api/feed/cleanup/hide', async (req, res, b) => {
    const r = await feed.hideNotNew(b.ids);
    if (!r.ok) return res.status(400).json(r);
    if (r.hidden.length) audit.record(req, { action: 'feed.cleanup.hide', entity: 'feed', id: r.hidden.map((x) => x.id).join(',').slice(0, 190), summary: 'Hid ' + r.hidden.length + ' old imported title(s) (not new / no new season): ' + r.hidden.map((x) => '"' + x.title + '"').join(', ').slice(0, 400), details: { ids: r.hidden.map((x) => x.id) } });
    res.json(Object.assign(r, { message: r.hidden.length ? '🙈 Hid ' + r.hidden.length + ' post(s)' : 'Nothing to hide (already hidden?)' }));
  });

  route('/admin/api/feed/tmdb/providers', async (req, res) => {
    res.json(await feed.tmdbProviders());
  });
}

module.exports = { mount };
