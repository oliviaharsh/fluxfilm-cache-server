/**
 * FluxFilm - 📡 webhooks to the owner's n8n (admin → 🔗 Integrations).
 *
 * Events (each switch in admin; nothing is sent until a webhook URL is saved):
 *   order.paid            once per order, when it became PAID (any path: UPI match, ₹0 / credit checkout, admin mark paid,
 *                         credit settled) — found by a sweep of orders.verified_at every 60 s
 *   order.delivered       once per order, when fulfillment_status became FULFILLED (orders.fulfilled_at)
 *   subscription.expired  daily at 00:05 India time for plans that ended yesterday (guarded in app_settings, so a
 *                         restart never sends the day twice; a missed 00:05 is caught up later that day)
 *   post.published        a What's new post became LIVE (published now, scheduled time reached, or TMDB auto-publish)
 *
 * Why a sweep and not a line inside every PAID update: there are five places that set PAID (order.js verify / free
 * checkout, credit.js, quickorders, admin order actions). One read-only sweep sees all of them and can never slow down,
 * block or break checkout. Overlap note: feat/owner-notifications-reports (admin push on paid orders) is not on main
 * yet; if it lands, both can keep their own "once" guards.
 *
 * Delivery: POST <webhook URL>/<event with - instead of .> (e.g. …/webhook/fluxfilm/order-paid), JSON body
 *   { eventId, event, createdAt, data }, headers X-FF-Event, X-FF-Event-Id, X-FF-Timestamp (unix s),
 *   X-FF-Signature: sha256=<HMAC-SHA256(secret, raw body)>. Fire-and-forget, 10 s timeout, 3 retries (5 s, 30 s, 2 min).
 *   Failures are logged; admin shows the last 20 deliveries. No phone numbers or emails in webhook bodies (n8n can ask
 *   the /n8n/api endpoints when it needs them).
 *
 * The first sweep after this code is deployed only sets the starting point (no flood of old orders / posts).
 * State: app_settings n8n_hook_state { init, paidCursor, deliveredCursor, expiredDay, postsSeen[], sent{} } and
 * n8n_hook_log (last 20 deliveries). SQL: one table per statement.
 */
const crypto = require('crypto');
const db = require('./db');

const STATE_KEY = 'n8n_hook_state';
const LOG_KEY = 'n8n_hook_log';
const RETRY_MS = [5e3, 30e3, 120e3];
const OVERLAP_MS = 10 * 60e3;
const IST_MS = 5.5 * 3600e3;

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function parseJson(v, dflt) { try { const x = JSON.parse(v || ''); return x && typeof x === 'object' ? x : dflt; } catch (_) { return dflt; } }
const istStamp = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 19).replace('T', ' ');
const istYmd = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const addDaysYmd = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function dbMs(v) { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - IST_MS : null; }
const n8n = () => require('./n8n');

let T = { fetch: (...a) => fetch(...a), setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; }, now: () => Date.now() };

// ------------------------------------------------------------------ signing + delivery
function sign(secret, body) { return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex'); }
function eventUrl(base, event) { return s(base).replace(/\/+$/, '') + '/' + String(event).replace(/\./g, '-'); }

let log = null; let logDirty = false; let logTimer = null;
async function loadLog() {
  if (log) return log;
  try { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [LOG_KEY]); log = r.length ? parseJson(r[0].value, []) : []; } catch (_) { log = []; }
  if (!Array.isArray(log)) log = [];
  return log;
}
function saveLogSoon() {
  logDirty = true;
  if (logTimer) return;
  logTimer = T.setTimeout(async () => {
    logTimer = null; if (!logDirty) return; logDirty = false;
    try { await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [LOG_KEY, JSON.stringify((log || []).slice(0, 20))]); }
    catch (e) { console.log('[n8n hooks] delivery log not saved:', e.message); }
  }, 2000);
}
async function record(entry) {
  await loadLog();
  const i = log.findIndex((x) => x.eventId === entry.eventId);
  if (i >= 0) log.splice(i, 1);
  log.unshift(entry);
  log = log.slice(0, 20);
  saveLogSoon();
}

async function attempt(url, secret, event, eventId, body) {
  const ts = Math.floor(T.now() / 1000);
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? T.setTimeout(() => ctrl.abort(), 10e3) : null;
  const t0 = T.now();
  try {
    const r = await T.fetch(url, {
      method: 'POST', body, signal: ctrl ? ctrl.signal : undefined, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'FluxFilm-Webhooks/1', 'X-FF-Event': event, 'X-FF-Event-Id': eventId, 'X-FF-Timestamp': String(ts), 'X-FF-Signature': sign(secret, body) },
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, ms: T.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: T.now() - t0, error: String((e && e.name === 'AbortError') ? 'timeout after 10 s' : (e && e.message) || e).slice(0, 160) };
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Sends one event. Never throws. opts.wait = resolve after the whole retry chain (tests / admin test button uses
 * opts.retries = 0). Resolves { ok, skipped?, status, attempts }.
 */
async function send(event, data, opts) {
  const o = opts || {};
  try {
    const st = await n8n().getSettings();
    if (!st.webhookUrl) return { ok: false, skipped: 'no webhook URL' };
    if (!o.force && st.events && st.events[event] === false) return { ok: false, skipped: 'event switched off' };
    const sec = await n8n().getSecrets();
    if (!sec.webhookSecret) return { ok: false, skipped: 'no signing secret' };
    const eventId = s(o.eventId) || ('evt_' + crypto.randomBytes(12).toString('hex'));
    const body = JSON.stringify({ eventId, event, createdAt: new Date(T.now()).toISOString(), data: data || {} });
    const url = eventUrl(st.webhookUrl, event);
    const retries = o.retries == null ? RETRY_MS.length : o.retries;
    const chain = (async () => {
      let res = null; let n = 0;
      for (;;) {
        n++;
        res = await attempt(url, sec.webhookSecret, event, eventId, body);
        if (res.ok || n > retries) break;
        await new Promise((r) => T.setTimeout(r, RETRY_MS[n - 1] || 120e3));
      }
      const entry = { at: new Date(T.now()).toISOString(), eventId, event, ok: res.ok, status: res.status, attempts: n, ms: res.ms, error: res.error || (res.ok ? '' : 'HTTP ' + res.status) };
      await record(entry).catch(() => {});
      if (!res.ok) console.log('[n8n hooks] ' + event + ' ' + eventId + ' failed after ' + n + ' attempt(s): ' + entry.error);
      return Object.assign({ eventId }, entry);
    })().catch((e) => { console.log('[n8n hooks] send crashed:', e.message); return { ok: false, error: e.message }; });
    return o.wait ? await chain : { ok: true, queued: true, eventId };
  } catch (e) {
    console.log('[n8n hooks] ' + event + ' not sent:', e.message);
    return { ok: false, error: e.message };
  }
}
async function sendTest() {
  return send('test.ping', { message: 'FluxFilm test webhook ✅', site: process.env.SITE_URL || 'https://shop.fluxfilm.in' }, { force: true, retries: 0, wait: true });
}
async function deliveries() { return (await loadLog()).slice(0, 20); }

// ------------------------------------------------------------------ sweep
async function readState() { const r = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [STATE_KEY]); return r.length ? parseJson(r[0].value, {}) : {}; }
async function writeState(st) { await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [STATE_KEY, JSON.stringify(st)]); }

const lastSweep = { at: null, error: '', sent: 0 };
let running = false;
function orderData(o) {
  const renewal = up(o.order_type) === 'RENEW';
  return { orderId: s(o.order_id), service: s(o.service), plan: s(o.plan), amount: num(o.final_amount), currency: 'INR', type: renewal ? 'RENEWAL' : 'NEW', isRenewal: renewal, firstName: n8n().firstName(o.name) };
}

async function sweep(opts) {
  if (running) return { ok: true, skipped: 'already running' };
  running = true;
  const now = (opts && opts.now) || T.now();
  const out = { ok: true, paid: 0, delivered: 0, expired: 0, posts: 0 };
  try {
    const st = await readState();
    const nowIst = istStamp(now);
    const today = istYmd(now);
    const livePosts = async () => n8n().livePosts(now);
    if (!st.init) {
      let ids = [];
      try { ids = (await livePosts()).posts.map((p) => s(p.id)); } catch (_) {}
      const minuteOfDay = Math.floor(((now + IST_MS) % 86400e3) / 60e3);
      Object.assign(st, { init: nowIst, paidCursor: nowIst, deliveredCursor: nowIst, postsSeen: ids, expiredDay: minuteOfDay >= 5 ? today : '', sent: {} });
      await writeState(st);
      return Object.assign(out, { initialised: true });
    }
    st.sent = st.sent && typeof st.sent === 'object' ? st.sent : {};
    for (const [k, v] of Object.entries(st.sent)) if (now - v > 3 * 86400e3) delete st.sent[k];
    // No webhook URL yet: only move the starting point forward (switching webhooks on later never replays old events).
    const cfg = await n8n().getSettings();
    if (!cfg.webhookUrl) {
      const minute = Math.floor(((now + IST_MS) % 86400e3) / 60e3);
      Object.assign(st, { paidCursor: nowIst, deliveredCursor: nowIst });
      if (minute >= 5) st.expiredDay = today;
      if (!st.postsAt || now - st.postsAt > 10 * 60e3) { try { st.postsSeen = (await livePosts()).posts.map((p) => s(p.id)).slice(-500); st.postsAt = now; } catch (_) {} }
      await writeState(st);
      lastSweep.at = new Date(now).toISOString(); lastSweep.error = '';
      return Object.assign(out, { idle: 'no webhook URL' });
    }
    const fire = async (key, event, data) => { if (st.sent[key]) return false; st.sent[key] = now; await send(event, data, { eventId: key.replace(/[^\w.:-]/g, '_') }); return true; };

    // order.paid
    const paidFrom = istStamp((dbMs(st.paidCursor) || now) - OVERLAP_MS);
    const paid = await db.query("SELECT order_id, service, plan, final_amount, order_type, name, verified_at FROM orders WHERE UPPER(status) = 'PAID' AND verified_at >= ? ORDER BY verified_at ASC LIMIT 300", [paidFrom]);
    for (const o of paid) {
      if (await fire('order.paid:' + s(o.order_id), 'order.paid', Object.assign(orderData(o), { paidAt: s(o.verified_at) }))) out.paid++;
      if (s(o.verified_at) > s(st.paidCursor)) st.paidCursor = s(o.verified_at).slice(0, 19);
    }
    // order.delivered
    const delFrom = istStamp((dbMs(st.deliveredCursor) || now) - OVERLAP_MS);
    const del = await db.query("SELECT order_id, service, plan, final_amount, order_type, name, fulfilled_at FROM orders WHERE UPPER(fulfillment_status) = 'FULFILLED' AND fulfilled_at >= ? ORDER BY fulfilled_at ASC LIMIT 300", [delFrom]);
    for (const o of del) {
      if (await fire('order.delivered:' + s(o.order_id), 'order.delivered', Object.assign(orderData(o), { deliveredAt: s(o.fulfilled_at) }))) out.delivered++;
      if (s(o.fulfilled_at) > s(st.deliveredCursor)) st.deliveredCursor = s(o.fulfilled_at).slice(0, 19);
    }
    // subscription.expired — 00:05 India time, once per day
    const minuteOfDay = Math.floor(((now + IST_MS) % 86400e3) / 60e3);
    if (minuteOfDay >= 5 && st.expiredDay !== today) {
      st.expiredDay = today;
      await writeState(st); // guard first: a crash below never sends the day twice
      const yesterday = addDaysYmd(today, -1);
      const groupsOn = await require('./devicelogins').groupsReady(db.query);
      const subs = await db.query('SELECT sub_id, order_id, phone_norm, service, plan, expiry_date, status, fulfillment_status' + (groupsOn ? ', group_index' : '') +
        ' FROM subscriptions WHERE expiry_date >= ? AND expiry_date < ? ORDER BY expiry_date ASC LIMIT 2000', [yesterday + ' 00:00:00', today + ' 00:00:00']);
      const stopped = require('./reads')._internal.stoppedRow;
      const keep = subs.filter((r) => !stopped(r) && !(groupsOn && Number(r.group_index) > 1) && !['FAILED', 'NO_STOCK'].includes(up(r.fulfillment_status)));
      const phones = [...new Set(keep.map((r) => s(r.phone_norm)).filter(Boolean))];
      const names = new Map();
      for (let i = 0; i < phones.length; i += 200) {
        const part = phones.slice(i, i + 200);
        const rows = await db.query('SELECT phone_norm, name FROM customers WHERE phone_norm IN (' + part.map(() => '?').join(', ') + ')', part);
        for (const c of rows) names.set(s(c.phone_norm), c.name);
      }
      const site = String(process.env.SITE_URL || 'https://shop.fluxfilm.in').replace(/\/+$/, '');
      for (const r of keep) {
        const data = { subId: s(r.sub_id), orderId: s(r.order_id), service: s(r.service), plan: s(r.plan), expiredOn: s(r.expiry_date).slice(0, 10), expiry: s(r.expiry_date).slice(0, 16), firstName: n8n().firstName(names.get(s(r.phone_norm))), renewUrl: site + '/?source=push&renew=' + encodeURIComponent(s(r.sub_id)) };
        if (await fire('subscription.expired:' + s(r.sub_id) + ':' + yesterday, 'subscription.expired', data)) out.expired++;
      }
    }
    // post.published
    try {
      const { posts, info } = await livePosts();
      const seen = new Set((st.postsSeen || []).map(s));
      for (const p of posts) {
        if (seen.has(s(p.id))) continue;
        seen.add(s(p.id));
        if (await fire('post.published:' + s(p.id), 'post.published', n8n().postItem(p, info))) out.posts++;
      }
      st.postsSeen = [...seen].slice(-500);
    } catch (e) { console.log('[n8n hooks] posts check skipped:', e.message); }
    await writeState(st);
    lastSweep.at = new Date(now).toISOString(); lastSweep.error = ''; lastSweep.sent += out.paid + out.delivered + out.expired + out.posts;
    return out;
  } catch (e) {
    lastSweep.at = new Date(now).toISOString(); lastSweep.error = String(e.message).slice(0, 200);
    if (!/doesn't exist|ER_NO_SUCH_TABLE/i.test(e.message)) console.log('[n8n hooks] sweep failed:', e.message);
    return { ok: false, message: e.message };
  } finally { running = false; }
}

function status() { return { lastSweepAt: lastSweep.at, lastSweepError: lastSweep.error || undefined, eventsQueuedSinceStart: lastSweep.sent }; }

let timer = null;
function startTimer() {
  if (timer) return;
  const tick = () => sweep().catch((e) => console.log('[n8n hooks] tick failed:', e.message));
  T.setTimeout(tick, 45e3);
  timer = setInterval(tick, 60e3);
  if (timer.unref) timer.unref();
}

module.exports = {
  send, sendTest, sweep, deliveries, status, startTimer, sign, eventUrl, STATE_KEY, LOG_KEY, RETRY_MS,
  _internal: { setTransport: (x) => { T = Object.assign({}, T, x); }, reset: () => { log = null; logDirty = false; logTimer = null; running = false; lastSweep.at = null; lastSweep.sent = 0; } },
};
