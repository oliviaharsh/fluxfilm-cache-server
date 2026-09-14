/**
 * FluxFilm - admin 🍿 Feed (admin-only). See feed.js.
 *
 *   GET  /admin/api/feed                   → { posts (status, views, likes, clicks), services, settings (no key), job }
 *   POST /admin/api/feed/save              { ...post }          create / update (pin, on/off = save)
 *   POST /admin/api/feed/delete            { id }
 *   POST /admin/api/feed/image             { id, dataUrl }      '' removes the picture
 *   POST /admin/api/feed/settings          { tmdbKey?, clearKey?, autoPublish?, platforms?, languages?, minPopularity?, minVotes?, maxPerDay?, autoHideDays?, providerMap? }
 *   POST /admin/api/feed/tmdb/search       { q }
 *   POST /admin/api/feed/tmdb/create       { tmdbKey, service, publish }
 *   POST /admin/api/feed/tmdb/suggest      { services[], days }  drafts only
 *   POST /admin/api/feed/tmdb/providers    {}                    TMDB's current India provider ids
 *   POST /admin/api/feed/run               {}                    run the TMDB import now (daily cap still applies)
 */
function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const feed = deps.feed || require('./feed');
  const fail = (res, e) => res.status(e && e.code === 'NOKEY' ? 400 : 500).json({ ok: false, message: String((e && e.message) || e) });
  const route = (p, fn) => app.post(p, async (req, res) => { if (!auth(req, res)) return; try { await fn(req, res, req.body || {}); } catch (e) { fail(res, e); } });

  app.get('/admin/api/feed', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [items, st, settings, services, job] = await Promise.all([feed.list(), feed.stats(), feed.getSettings(), feed.catalogServices(), feed.jobStatus().catch(() => null)]);
      const posts = feed.sortPosts(items).map((p) => Object.assign({}, p, { status: feed.statusOf(p), views: (st[p.id] || {}).views || 0, likes: (st[p.id] || {}).likes || 0, clicks: (st[p.id] || {}).clicks || 0, shares: (st[p.id] || {}).shares || 0, plays: (st[p.id] || {}).plays || 0 }));
      res.json({ ok: true, posts, services, settings: feed.publicSettings(settings), job, max: feed.MAX_POSTS, now: new Date().toISOString() });
    } catch (e) { fail(res, e); }
  });

  route('/admin/api/feed/save', async (req, res, b) => {
    const r = await feed.save(b);
    if (!r.ok) return res.status(400).json(r);
    audit.record(req, { action: r.created ? 'feed.create' : 'feed.update', entity: 'feed', id: r.post.id, summary: (r.created ? 'Created' : 'Updated') + ' feed post "' + r.post.title + '" (' + (r.post.service || r.post.type) + ', ' + (r.post.active ? 'on' : 'off') + (r.post.pinned ? ', pinned' : '') + ')' });
    res.json(Object.assign(r, { status: feed.statusOf(r.post) }));
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

  route('/admin/api/feed/tmdb/providers', async (req, res) => {
    res.json(await feed.tmdbProviders());
  });
}

module.exports = { mount };
