/**
 * FluxFilm - Olivia's Netflix household auto-fix: fetch the Netflix TRAVEL / "Watch temporarily" CODE for a
 * customer's own active Netflix plan, so she can show it in chat instead of the customer chasing the email.
 *
 * How the code is reached (the same path a human does by hand, but server-side, GET only):
 *   1. Find the customer's active Netflix sub  ->  its inventory_ref  ->  the Netflix login email (inventory_accounts.login_id).
 *   2. Get the Netflix "travel/verify?nftoken=..." link for that email:
 *        - NFLX-D...  (darkflix accounts): POST darkflix set_household_email.php (type Travel) -> GET household.php -> read the link.
 *        - NFLX-H...  (FluxFilm's own):    read the shared Netflix inbox (ffnetflixhub) for the newest travel/household mail
 *                                          that PROVES it is for this login email, and read the link from it.
 *   3. GET that Netflix link and read the 4-digit code off the page.
 *
 * Hard rules:
 *   - Only ever for a Netflix plan that THIS phone actively owns (checked by the caller).
 *   - Read-only everywhere: it never presses "Update household", never signs in, never solves a CAPTCHA. If the Netflix
 *     page is a sign-in / reCAPTCHA / expired page, it returns { ok:false, manual:true } and Olivia shows the manual Helper.
 *   - The code is never written to logs; Olivia logs the card as "[code shown]".
 *
 * Secrets (Hostinger env only, never committed): NETFLIX_IMAP_USER / NETFLIX_IMAP_PASS (the ffnetflixhub inbox).
 * Config: OLIVIA_DARKFLIX_BASE (default https://darkflix.shop), NETFLIX_HH_INBOX_FOLDER (default [Gmail]/All Mail).
 */
const db = require('./db');

const DARKFLIX_BASE = () => String(process.env.OLIVIA_DARKFLIX_BASE || 'https://darkflix.shop').replace(/\/+$/, '');
const HH_FOLDER = () => process.env.NETFLIX_HH_INBOX_FOLDER || '[Gmail]/All Mail';
const HH_HOST = () => process.env.NETFLIX_IMAP_HOST || 'imap.gmail.com';
const LINK_FRESH_MS = Number(process.env.NETFLIX_HH_FRESH_MIN || 14) * 60 * 1000; // Netflix links expire ~15 min
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Mobile Safari/537.36';

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const famNetflix = (svc) => /netflix/i.test(String(svc || ''));
/** "NFLX-H01#2" -> "NFLX-H01" (the account id; a sub's ref may carry a #profile suffix). */
const accountIdOf = (ref) => s(ref).split('#')[0];
/** 'H' = FluxFilm's own accounts (shared inbox), 'D' = darkflix accounts (darkflix page), '' = unknown. */
function kindOfRef(ref) {
  const up = accountIdOf(ref).toUpperCase();
  if (/^NFLX-?H/.test(up)) return 'H';
  if (/^NFLX-?D/.test(up)) return 'D';
  return '';
}

/**
 * The customer's active Netflix accounts (login email + kind), from their own subscriptions only.
 * Returns { ok, accounts: [{ subId, service, ref, email, kind }] }. `email` is '' when the account has no login saved.
 */
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
    "SELECT account_id, login_id FROM inventory_accounts WHERE LOWER(service) LIKE '%netflix%' AND account_id IN (" +
    ids.map(() => '?').join(',') + ')', ids);
  const emailOf = new Map((accs || []).map((a) => [s(a.account_id), s(a.login_id)]));
  const out = [];
  const seen = new Set();
  for (const x of netflix) {
    const acc = accountIdOf(x.inventory_ref);
    if (seen.has(acc)) continue; seen.add(acc);
    out.push({ subId: s(x.sub_id), service: s(x.service), ref: acc, email: s(emailOf.get(acc)), kind: kindOfRef(acc) });
  }
  return { ok: true, accounts: out };
}

/** The Netflix travel-code page's 4-digit code, or '' — and it refuses a sign-in / reCAPTCHA / expired page. */
function readTravelPage(html) {
  const h = String(html || '');
  if (/recaptcha|g-recaptcha|Enter your info to sign in|type=["']password["']|id=["']id_password["']/i.test(h)) {
    return { blocked: true, code: '' };
  }
  const text = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
  // "Enter this code on the requesting device ...  4 1 6 2" (digits can be spaced apart).
  const near = text.match(/(?:temporary access|enter this code|requesting device)[\s\S]{0,120}?((?:\d\s*){4,8})/i);
  const digits = near ? near[1].replace(/\D/g, '') : '';
  if (digits.length === 4) return { blocked: false, code: digits };
  const any = text.match(/\b(\d{4})\b(?=[\s\S]{0,60}(?:expires|temporary|minutes))/i);
  return { blocked: false, code: any ? any[1] : '' };
}

/** Follow a Netflix travel/verify link (GET only) and read the code. Never presses a button, never signs in. */
async function codeFromNetflixLink(url, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (!/^https:\/\/(www\.)?netflix\.com\//i.test(String(url || ''))) return { ok: false, manual: true };
  const jar = new Map();
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const r = await doFetch(cur, { redirect: 'manual', headers: {
      'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9',
      Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; '),
    } });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const loc = r.headers.get('location');
    if (loc && r.status >= 300 && r.status < 400) { cur = new URL(loc, cur).toString(); continue; }
    const body = await r.text();
    const page = readTravelPage(body);
    if (page.blocked) return { ok: false, manual: true };
    if (page.code) return { ok: true, code: page.code };
    return { ok: false, manual: true };
  }
  return { ok: false, manual: true };
}

/** darkflix (NFLX-D): POST the email (type Travel), then read the Netflix link off household.php. */
async function darkflixTravelLink(email, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const base = DARKFLIX_BASE();
  const jar = new Map();
  const take = (r) => { for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
  const r1 = await doFetch(base + '/set_household_email.php', {
    method: 'POST', redirect: 'manual',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie() },
    body: new URLSearchParams({ action: 'set_household_email', household_mail: email, type: 'Travel' }).toString(),
  });
  take(r1);
  const r2 = await doFetch(base + '/household.php', { headers: { 'User-Agent': UA, Cookie: cookie() } });
  const html = await r2.text();
  const m = html.match(/https:\/\/www\.netflix\.com\/account\/travel\/verify\?[^"'\s]+/i);
  return m ? m[0].replace(/&amp;/g, '&') : '';
}

/** FluxFilm's own inbox (NFLX-H): the newest travel/household mail that PROVES it is for this login email. */
async function inboxTravelLink(email, deps) {
  const user = process.env.NETFLIX_IMAP_USER, pass = (process.env.NETFLIX_IMAP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return '';
  const key = s(email).toLowerCase();
  if (!key) return '';
  const imap = (deps && deps.imap) || require('imapflow');
  const { simpleParser } = (deps && deps.mailparser) || require('mailparser');
  const client = new imap.ImapFlow({ host: HH_HOST(), port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock(HH_FOLDER(), { readOnly: true });
  try {
    const since = new Date(Date.now() - LINK_FRESH_MS);
    const uids = await client.search({ subject: 'household', since }, { uid: true });
    const items = [];
    for (const uid of (uids || []).slice(-15).reverse()) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (msg && msg.source) items.push(msg.source);
    }
    for (const src of items) {
      const p = await simpleParser(src);
      if (Date.now() - new Date(p.date || 0).getTime() > LINK_FRESH_MS) continue;
      // Safety: only use this mail if it verifiably belongs to THIS account's login email (never another customer's).
      if (String(src).toLowerCase().indexOf(key) === -1) continue;
      const html = String(p.html || p.textAsHtml || p.text || '');
      const m = html.match(/https:\/\/www\.netflix\.com\/account\/travel\/verify\?[^"'\s<]+/i);
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    return '';
  } finally { lock.release(); try { await client.logout(); } catch (_) {} }
}

/**
 * The travel code for one Netflix account. Returns { ok, code } or { ok:false, manual:true } (fall back to the Helper).
 * `acc` is one item from netflixAccounts(). Network / IMAP are injectable for tests (deps.fetch, deps.imap, deps.mailparser).
 */
async function travelCode(acc, deps) {
  const a = acc || {};
  if (!famNetflix(a.service) || !s(a.email) || !a.kind) return { ok: false, manual: true };
  const fetchImpl = deps && deps.fetch;
  let link = '';
  try {
    link = a.kind === 'D' ? await darkflixTravelLink(a.email, fetchImpl) : await inboxTravelLink(a.email, deps);
  } catch (e) { console.log('[olivia-hh] link fetch failed:', e.message); return { ok: false, manual: true }; }
  if (!link) return { ok: false, manual: true };
  try { return await codeFromNetflixLink(link, fetchImpl); }
  catch (e) { console.log('[olivia-hh] code read failed:', e.message); return { ok: false, manual: true }; }
}

module.exports = { netflixAccounts, travelCode, _internal: { kindOfRef, accountIdOf, readTravelPage, codeFromNetflixLink } };
