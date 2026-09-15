/**
 * FluxFilm - Olivia's Netflix household auto-fix.
 *
 *   travelCode(acc)   -> the "Watch temporarily" 4-digit TRAVEL code (read-only; verified live)
 *   updateHousehold(acc) -> makes this TV the permanent household (state-changing; OFF unless OLIVIA_HH_UPDATE=on)
 *
 * From a customer's own ACTIVE Netflix sub: inventory_ref -> the Netflix login email (inventory_accounts.login_id) and
 * whether it is ours (NFLX-H...) or a darkflix account (NFLX-D...).
 *
 * Getting the Netflix link for that email (the same path a human does by hand, server-side, no browser):
 *   - NFLX-D (darkflix):  POST darkflix set_household_email.php (type Travel|Household) -> GET household.php -> read the link.
 *   - NFLX-H (ours):      OLIVIA_HH_OURS_BASE, a darkflix-style page keyed by the email, if set; otherwise the shared
 *                         ffnetflixhub inbox, matched by the account's [FF][<tag>] label (its own emails don't carry the
 *                         login email, only the tag) - the tag comes from inventory_accounts.raw_json or OLIVIA_HH_ACC_MAP.
 * Then GET the Netflix link:
 *   - travel:  read the 4-digit code off the page.
 *   - update:  the page auto-logs-in and shows a "Update household" button; follow it once and confirm success.
 *
 * Hard rules (unchanged): only for a Netflix plan THIS phone actively owns; travel is read-only; nothing ever presses a
 * button on a sign-in / reCAPTCHA / expired page (-> { ok:false, manual:true }); the code / update is never written to logs.
 *
 * Secrets (Hostinger env only): NETFLIX_IMAP_USER (default ffnetflixhub@gmail.com), NETFLIX_IMAP_PASS.
 * Config: OLIVIA_DARKFLIX_BASE (default https://darkflix.shop), OLIVIA_HH_OURS_BASE, OLIVIA_HH_ACC_MAP (JSON
 *   {"NFLX-H01":"ACC1",...}), OLIVIA_HH_UPDATE (on = allow the permanent update press), NETFLIX_HH_INBOX_FOLDER.
 */
const db = require('./db');

const DARKFLIX_BASE = () => String(process.env.OLIVIA_DARKFLIX_BASE || 'https://darkflix.shop').replace(/\/+$/, '');
const OURS_BASE = () => String(process.env.OLIVIA_HH_OURS_BASE || '').replace(/\/+$/, '');
const HH_FOLDER = () => process.env.NETFLIX_HH_INBOX_FOLDER || '[Gmail]/All Mail';
const HH_HOST = () => process.env.NETFLIX_IMAP_HOST || 'imap.gmail.com';
const IMAP_USER = () => process.env.NETFLIX_IMAP_USER || 'ffnetflixhub@gmail.com';
const UPDATE_ON = () => /^(on|1|true|yes)$/i.test(String(process.env.OLIVIA_HH_UPDATE || ''));
const LINK_FRESH_MS = Number(process.env.NETFLIX_HH_FRESH_MIN || 14) * 60 * 1000;
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Mobile Safari/537.36';
const DARKFLIX_TYPE = { travel: 'Travel', update: 'Household' };
const NFLX_PATH = { travel: 'travel/verify', update: 'update-primary-location' };

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const famNetflix = (svc) => /netflix/i.test(String(svc || ''));
const accountIdOf = (ref) => s(ref).split('#')[0];
function kindOfRef(ref) {
  const up = accountIdOf(ref).toUpperCase();
  if (/^NFLX-?H/.test(up)) return 'H';
  if (/^NFLX-?D/.test(up)) return 'D';
  return '';
}
function accMap() {
  // OLIVIA_HH_ACC_MAP keys may be the account id (NFLX-H01), the login email, or just its name part (harshwalia8888).
  try { const m = JSON.parse(process.env.OLIVIA_HH_ACC_MAP || '{}'); if (!m || typeof m !== 'object') return {}; const out = {}; for (const [k, v] of Object.entries(m)) out[String(k).toLowerCase()] = v; return out; } catch (_) { return {}; }
}
const localPart = (email) => s(email).toLowerCase().split('@')[0];
/** The [FF][<tag>] household label for an account: from its raw_json, or OLIVIA_HH_ACC_MAP keyed by id / email / name. */
function tagOf(accountId, rawJson, email) {
  let raw = {}; try { raw = rawJson ? (typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson) : {}; } catch (_) { raw = {}; }
  const m = accMap();
  const t = s(raw.HouseholdTag || raw.HH || raw.ACC || raw.Acc
    || m[String(accountId).toLowerCase()] || (email && (m[s(email).toLowerCase()] || m[localPart(email)])));
  return t ? t.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

/** The customer's active Netflix accounts (login email, kind, and household tag), from their own subscriptions only. */
async function netflixAccounts(phone, deps) {
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: false, message: 'phone required' };
  const q = (deps && deps.query) || db.query;
  const subs = await q(
    "SELECT sub_id, service, inventory_ref FROM subscriptions " +
    "WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' AND (expiry_date IS NULL OR expiry_date > NOW())", [ph]);
  const netflix = (subs || []).filter((x) => famNetflix(x.service) && s(x.inventory_ref));
  if (!netflix.length) return { ok: true, accounts: [] };
  const ids = [...new Set(netflix.map((x) => accountIdOf(x.inventory_ref)))];
  const accs = await q(
    "SELECT account_id, login_id, raw_json FROM inventory_accounts WHERE LOWER(service) LIKE '%netflix%' AND account_id IN (" +
    ids.map(() => '?').join(',') + ')', ids);
  const byId = new Map((accs || []).map((a) => [s(a.account_id), a]));
  const out = []; const seen = new Set();
  for (const x of netflix) {
    const acc = accountIdOf(x.inventory_ref);
    if (seen.has(acc)) continue; seen.add(acc);
    const row = byId.get(acc) || {};
    out.push({ subId: s(x.sub_id), service: s(x.service), ref: acc, email: s(row.login_id), kind: kindOfRef(acc), tag: tagOf(acc, row.raw_json, s(row.login_id)) });
  }
  return { ok: true, accounts: out };
}

/** A Netflix page is a sign-in / reCAPTCHA / expired page we must never act on. */
function isBlocked(html) {
  return /recaptcha|g-recaptcha|Enter your info to sign in|type=["']password["']|id=["']id_password["']|link (has )?expired|no longer valid/i.test(String(html || ''));
}
const visible = (html) => String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

function readTravelPage(html) {
  if (isBlocked(html)) return { blocked: true, code: '' };
  const text = visible(html);
  const near = text.match(/(?:temporary access|enter this code|requesting device)[\s\S]{0,120}?((?:\d\s*){4,8})/i);
  const digits = near ? near[1].replace(/\D/g, '') : '';
  if (digits.length === 4) return { blocked: false, code: digits };
  const any = text.match(/\b(\d{4})\b(?=[\s\S]{0,60}(?:expires|temporary|minutes))/i);
  return { blocked: false, code: any ? any[1] : '' };
}

function cookieJar() {
  const jar = new Map();
  return {
    take: (r) => { for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1)); } },
    header: () => [...jar].map(([k, v]) => k + '=' + v).join('; '),
  };
}

/** Follow Netflix links (GET), keeping cookies, up to `hops`. Returns { status, url, html, jar } of the final page. */
async function followNetflix(url, doFetch, jar, hops) {
  let cur = url;
  for (let i = 0; i < (hops || 6); i++) {
    const r = await doFetch(cur, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9', Cookie: jar.header() } });
    jar.take(r);
    const loc = r.headers.get('location');
    if (loc && r.status >= 300 && r.status < 400) { cur = new URL(loc, cur).toString(); continue; }
    const html = await r.text();
    return { status: r.status, url: cur, html };
  }
  return { status: 0, url: cur, html: '' };
}

/** travel: read the code. */
async function codeFromNetflixLink(url, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (!/^https:\/\/(www\.)?netflix\.com\//i.test(String(url || ''))) return { ok: false, manual: true };
  const page = await followNetflix(url, doFetch, cookieJar());
  if (isBlocked(page.html)) return { ok: false, manual: true };
  const r = readTravelPage(page.html);
  return r.code ? { ok: true, code: r.code } : { ok: false, manual: true };
}

/**
 * update: the link auto-signs-in and shows a black "Update household" button; follow it once and confirm.
 * Never runs unless OLIVIA_HH_UPDATE=on. Any sign-in / reCAPTCHA / uncertainty -> manual (nothing pressed).
 */
async function confirmUpdateFromNetflixLink(url, fetchImpl) {
  if (!UPDATE_ON()) return { ok: false, manual: true, disabled: true };
  const doFetch = fetchImpl || fetch;
  if (!/^https:\/\/(www\.)?netflix\.com\//i.test(String(url || ''))) return { ok: false, manual: true };
  const jar = cookieJar();
  const page = await followNetflix(url, doFetch, jar);
  if (isBlocked(page.html)) return { ok: false, manual: true };
  const html = page.html;
  if (/household (has been )?(updated|confirmed)|now your household/i.test(visible(html))) return { ok: true, updated: true };
  // The confirm control: a form posting to update-primary-location, or a link/button to confirm it.
  const form = html.match(/<form[^>]*action=["']([^"']*update-primary-location[^"']*)["'][^>]*>/i);
  const link = html.match(/https:\/\/www\.netflix\.com\/account\/update-primary-location[^"'\s<]*confirm[^"'\s<]*/i)
    || html.match(/href=["'](https:\/\/www\.netflix\.com\/account\/update-primary-location[^"']+)["']/i);
  let after = null;
  if (form) {
    const action = new URL(form[1], page.url).toString();
    const fields = {};
    for (const m of html.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi)) fields[m[1]] = m[2];
    const r = await doFetch(action, { method: 'POST', redirect: 'manual', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() }, body: new URLSearchParams(fields).toString() });
    jar.take(r);
    const loc = r.headers.get('location');
    after = loc ? await followNetflix(new URL(loc, action).toString(), doFetch, jar) : { html: await r.text() };
  } else if (link) {
    after = await followNetflix(new URL(link[1] || link[0], page.url).toString(), doFetch, jar);
  } else {
    return { ok: false, manual: true }; // could not find the button -> leave it to the person
  }
  if (after && !isBlocked(after.html) && /household (has been )?(updated|confirmed)|now your household/i.test(visible(after.html))) return { ok: true, updated: true };
  return { ok: false, manual: true };
}

/** Get the Netflix link for this account + mode, from darkflix / our page / the shared inbox. */
async function netflixLink(acc, mode, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const want = NFLX_PATH[mode] || NFLX_PATH.travel;
  const re = new RegExp('https:\\/\\/www\\.netflix\\.com\\/account\\/' + want.replace('/', '\\/') + '[^"\'\\s<]+', 'i');
  if (acc.kind === 'D' || (acc.kind === 'H' && OURS_BASE())) {
    const base = acc.kind === 'D' ? DARKFLIX_BASE() : OURS_BASE();
    const jar = cookieJar();
    const r1 = await fetchImpl(base + '/set_household_email.php', {
      method: 'POST', redirect: 'manual',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
      body: new URLSearchParams({ action: 'set_household_email', household_mail: acc.email, type: DARKFLIX_TYPE[mode] || 'Travel' }).toString(),
    });
    jar.take(r1);
    const r2 = await fetchImpl(base + '/household.php', { headers: { 'User-Agent': UA, Cookie: jar.header() } });
    const m = (await r2.text()).match(re);
    return m ? m[0].replace(/&amp;/g, '&') : '';
  }
  if (acc.kind === 'H') return inboxLink(acc, re, deps);
  return '';
}

/** FluxFilm's own inbox (NFLX-H): the newest household mail for this account's [FF][<tag>] label. */
async function inboxLink(acc, re, deps) {
  const pass = (process.env.NETFLIX_IMAP_PASS || '').replace(/\s+/g, '');
  if (!pass) return '';
  const tag = s(acc.tag);
  if (!tag) return ''; // no way to tell this account's mail apart from other accounts' -> never guess
  const imap = (deps && deps.imap) || require('imapflow');
  const { simpleParser } = (deps && deps.mailparser) || require('mailparser');
  const client = new imap.ImapFlow({ host: HH_HOST(), port: 993, secure: true, auth: { user: IMAP_USER(), pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock(HH_FOLDER(), { readOnly: true });
  try {
    const since = new Date(Date.now() - LINK_FRESH_MS);
    const uids = await client.search({ subject: '[' + tag + ']', since }, { uid: true });
    for (const uid of (uids || []).slice(-15).reverse()) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const p = await simpleParser(msg.source);
      if (Date.now() - new Date(p.date || 0).getTime() > LINK_FRESH_MS) continue;
      if (String(p.subject || '').toUpperCase().indexOf('[' + tag + ']') === -1) continue; // the tag must really be this account's
      const m = String(p.html || p.textAsHtml || p.text || '').match(re);
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    return '';
  } finally { lock.release(); try { await client.logout(); } catch (_) {} }
}

async function run(acc, mode, deps) {
  const a = acc || {};
  if (!famNetflix(a.service) || !s(a.email) || !a.kind) return { ok: false, manual: true };
  let link = '';
  try { link = await netflixLink(a, mode, deps); } catch (e) { console.log('[olivia-hh] link fetch failed:', e.message); return { ok: false, manual: true }; }
  if (!link) return { ok: false, manual: true };
  try { return mode === 'update' ? await confirmUpdateFromNetflixLink(link, deps && deps.fetch) : await codeFromNetflixLink(link, deps && deps.fetch); }
  catch (e) { console.log('[olivia-hh] ' + mode + ' failed:', e.message); return { ok: false, manual: true }; }
}

const travelCode = (acc, deps) => run(acc, 'travel', deps);
const updateHousehold = (acc, deps) => run(acc, 'update', deps);
const updateEnabled = () => UPDATE_ON();

module.exports = { netflixAccounts, travelCode, updateHousehold, updateEnabled, _internal: { kindOfRef, accountIdOf, tagOf, readTravelPage, isBlocked, codeFromNetflixLink } };
