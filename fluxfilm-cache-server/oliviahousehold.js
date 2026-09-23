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
 * Reading the mail, best first:
 *   1. DIRECT - each Netflix account's own Gmail, over IMAP, with its own app password (NETFLIX_ACC_PASS). The
 *      mailbox IS the account, so there is no forwarding, no shared hub, no label and no subject tag to get wrong,
 *      and the mail is read the second Netflix sends it instead of up to a minute later.
 *   2. HUB - the old path: a per-inbox Apps Script forwards to ffnetflixhub and we read that one mailbox. Kept as
 *      a fallback for any account with no app password yet, so nothing stops working mid-migration.
 *
 * Secrets (Hostinger env only): NETFLIX_ACC_PASS (JSON, the app password per account - the direct path),
 *   NETFLIX_IMAP_USER (default ffnetflixhub@gmail.com), NETFLIX_IMAP_PASS (the hub fallback).
 * Config: OLIVIA_DARKFLIX_BASE (default https://darkflix.shop), OLIVIA_HH_OURS_BASE, OLIVIA_HH_ACC_MAP (JSON
 *   {"NFLX-H01":"ACC1",...}), OLIVIA_HH_UPDATE (on = allow the permanent update press), NETFLIX_HH_INBOX_FOLDER.
 */
const db = require('./db');

const DARKFLIX_BASE = () => String(process.env.OLIVIA_DARKFLIX_BASE || 'https://darkflix.shop').replace(/\/+$/, '');
const OURS_BASE = () => String(process.env.OLIVIA_HH_OURS_BASE || '').replace(/\/+$/, '');
const HH_FOLDER = () => process.env.NETFLIX_HH_INBOX_FOLDER || '[Gmail]/All Mail';
const HH_HOST = () => process.env.NETFLIX_IMAP_HOST || 'imap.gmail.com';
const IMAP_USER = () => process.env.NETFLIX_IMAP_USER || 'ffnetflixhub@gmail.com';
// Each account's Netflix mail is filed under its own Gmail label in the shared inbox (NETFLIX/acc1 … acc4 — what
// the old Apps Script searched). Gmail shows a label to IMAP as a folder, so we can read it straight.
// Default: the tag lower-cased under the prefix, so ACC1 → NETFLIX/acc1 with nothing to configure.
const HH_LABEL_PREFIX = () => String(process.env.NETFLIX_HH_LABEL_PREFIX == null ? 'NETFLIX/' : process.env.NETFLIX_HH_LABEL_PREFIX);
function labelMap() {
  try { const m = JSON.parse(process.env.NETFLIX_HH_LABEL_MAP || '{}'); if (!m || typeof m !== 'object') return {}; const o = {}; for (const [k, v] of Object.entries(m)) o[String(k).toUpperCase()] = String(v); return o; } catch (_) { return {}; }
}
/** The Gmail label (IMAP folder) that holds this account's Netflix mail, or '' when there is no tag to go on. */
function labelFor(tag) {
  const up = s(tag).toUpperCase();
  if (!up) return '';
  const m = labelMap();
  if (m[up]) return m[up];
  const prefix = HH_LABEL_PREFIX();
  return prefix ? prefix + up.toLowerCase() : '';
}
/**
 * The direct path: each Netflix account's OWN Gmail.
 *   NETFLIX_ACC_PASS = {"ACC1":"abcdefghijklmnop", "ACC2":"…"}
 * A key may be the tag (ACC1), the account id (NFLX-H1), the login email, or just the name part of it. The value is
 * that account's 16-character Gmail app password - or {"user":"…","pass":"…"} when the mailbox is not the login email.
 * An account that is not in the map falls back to the shared hub, so this can be filled in one account at a time.
 */
function accPassMap() {
  try {
    const m = JSON.parse(process.env.NETFLIX_ACC_PASS || '{}');
    if (!m || typeof m !== 'object') return {};
    const o = {};
    for (const [k, v] of Object.entries(m)) o[String(k).toLowerCase()] = v;
    return o;
  } catch (_) { return {}; }
}
/** { user, pass } for this account's own inbox, or null when it has no app password (-> use the hub). */
function directAuth(acc) {
  const a = acc || {};
  const m = accPassMap();
  const keys = [a.tag, a.ref, a.email, localPart(a.email)].map((k) => s(k).toLowerCase()).filter(Boolean);
  let v = null;
  for (const k of keys) { if (m[k] != null && m[k] !== '') { v = m[k]; break; } }
  if (!v) return null;
  const obj = typeof v === 'object';
  const user = s(obj ? v.user : '') || s(a.email);
  const pass = String((obj ? v.pass : v) || '').replace(/\s+/g, '');
  return (user && pass) ? { user, pass } : null;
}
const ACC_FOLDER = () => process.env.NETFLIX_ACC_FOLDER || 'INBOX';

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

/**
 * Find this account's newest Netflix mail. Where it looks depends on how the account is set up:
 *
 *   DIRECT (it has its own app password) — its OWN mailbox, INBOX then All Mail. Nothing separates accounts
 *     because nothing is shared: we are signed in to that one Netflix account's Gmail.
 *   HUB (no app password) — the shared ffnetflixhub inbox, where the mail of four accounts is mixed together and
 *     something must tell them apart:
 *       1. its own Gmail LABEL — NETFLIX/acc1 … acc4, exactly what the old Apps Script searched;
 *       2. a [<tag>] in the subject, in All Mail — how this worked before; kept so nothing that works today stops.
 */
async function inboxSearch(acc, pick, deps, opts) {
  const direct = directAuth(acc);
  const tag = s(acc.tag).toUpperCase();
  const pass = direct ? direct.pass : (process.env.NETFLIX_IMAP_PASS || '').replace(/\s+/g, '');
  if (!pass) return null;
  // In the shared hub there is nothing but the tag to tell this account's mail from another account's -> never guess.
  if (!direct && !tag) return null;
  const freshMs = (opts && opts.freshMs) || LINK_FRESH_MS;
  const imap = (deps && deps.imap) || require('imapflow');
  const { simpleParser } = (deps && deps.mailparser) || require('mailparser');
  const user = direct ? direct.user : IMAP_USER();
  const client = new imap.ImapFlow({ host: HH_HOST(), port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    const since = new Date(Date.now() - freshMs);
    const tries = [];
    if (direct) {
      tries.push({ folder: ACC_FOLDER(), by: 'inbox' });
      tries.push({ folder: HH_FOLDER(), by: 'inbox' });   // in case the mail was archived out of the inbox
    } else {
      const label = labelFor(tag);
      if (label) tries.push({ folder: label, by: 'label' });
      tries.push({ folder: HH_FOLDER(), by: 'subject' });
    }
    for (const tr of tries) {
      let lock = null;
      try { lock = await client.getMailboxLock(tr.folder, { readOnly: true }); } catch (_) { continue; } // no such label
      try {
        // Only the All Mail fallback needs the [TAG]: a label folder and your own inbox are already one account.
        const q = tr.by === 'subject' ? { subject: '[' + tag + ']', since } : { since };
        const uids = await client.search(q, { uid: true });
        for (const uid of (uids || []).slice(-15).reverse()) {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const p = await simpleParser(msg.source);
          if (Date.now() - new Date(p.date || 0).getTime() > freshMs) continue;
          const from = String((p.from && p.from.text) || '').toLowerCase();
          const subj = String(p.subject || '');
          // Only Netflix's own mail. In the hub the mail was FORWARDED, so its From is the account that forwarded
          // it, not Netflix — there the [FF][TAG] our own forwarder writes is what vouches for it instead.
          const fromNetflix = from.indexOf('netflix.com') > -1;
          const ours = tr.by !== 'inbox' && /^\s*(re:|fwd:)?\s*\[FF\]\[/i.test(subj);
          if (!fromNetflix && !ours) continue;
          // In All Mail the subject tag is the ONLY thing separating the accounts, so it must really be there.
          if (tr.by === 'subject' && subj.toUpperCase().indexOf('[' + tag + ']') === -1) continue;
          const hit = pick(p, tr.by);
          if (hit) return hit;
        }
      } finally { lock.release(); }
    }
    return null;
  } finally { try { await client.logout(); } catch (_) {} }
}

/** The newest household / travel link for this account. */
async function inboxLink(acc, re, deps) {
  const hit = await inboxSearch(acc, (p) => {
    const m = String(p.html || p.textAsHtml || p.text || '').match(re);
    return m ? m[0].replace(/&amp;/g, '&') : null;
  }, deps);
  return hit || '';
}

function verificationCodeFrom(html) {
  if (isBlocked(html)) return '';
  const text = visible(html);
  if (/temporary access|requesting device|watch temporarily|update household/i.test(text)) return ''; // that is a household email, not a verification code
  const m = text.match(/verify with this code[:\s]*((?:\d\s*){4,8})/i)
    || text.match(/your (?:netflix )?(?:verification|sign.?in|access) code(?: is)?[:\s]*((?:\d\s*){4,8})/i)
    || text.match(/((?:\d\s*){6})\s*is your (?:netflix )?(?:verification|sign.?in) code/i)
    || (/verification code|sign.?in code|access your account/i.test(text) && text.match(/(?:^|[^\d])((?:\d\s*){6})(?:[^\d]|$)/));
  const d = m ? String(m[1]).replace(/\D/g, '') : '';
  return (d.length >= 4 && d.length <= 8) ? d : '';
}

/** The newest recent verification code for this account. */
async function inboxCode(acc, deps) {
  const hit = await inboxSearch(acc, (p) => verificationCodeFrom(String(p.html || p.textAsHtml || p.text || '')) || null, deps);
  return hit || '';
}

const MAIL_WORDS = {
  household: ['household', 'update your netflix household', 'reset your household'],
  travel: ['temporary access code', 'travel', 'device code', 'watch temporarily'],
  // 🔐 The 6-digit verification code. Whoever holds it can sign in to the Netflix account itself.
  code: ['verify with this code', 'verification code', 'verification code', 'verification code', 'code requested'],
};

/**
 * For the owner's own 📺 Netflix helper screen: the newest Netflix mail for this account, and the link to act on.
 * Read-only — it opens nothing and presses nothing. A wider window than the auto-fix, because the owner is looking
 * things up by hand rather than answering a customer standing at their TV.
 */
async function latestMail(acc, mode, deps) {
  const re = /https?:\/\/[^"'\s>]*netflix\.com[^"'\s>]*/i;
  const kind = MAIL_WORDS[String(mode)] ? String(mode) : 'household';
  const words = MAIL_WORDS[kind];
  const freshMs = Number(process.env.NETFLIX_HH_LOOKUP_DAYS || 7) * 86400e3;
  const hit = await inboxSearch(acc, (p, by) => {
    const subject = String(p.subject || '');
    const body = String(p.html || p.textAsHtml || p.text || '');
    // The forwarder puts [FF][ACC1][CODE] in the subject, but the body is matched too: a mail forwarded by hand, or
    // a subject Netflix words differently, should still be found.
    const hay = (subject + ' ' + body).toLowerCase();
    if (!words.some((w) => hay.indexOf(w) > -1)) return null;
    const m = body.match(re);
    const out = { subject, date: p.date ? new Date(p.date).toISOString() : '', actionUrl: m ? m[0].replace(/&amp;/g, '&') : '', foundBy: by, mode: kind };
    if (kind === 'code') {
      const code = verificationCodeFrom(body);   // the same reader Olivia uses — one extractor, not two
      if (!code) return null;              // a code mail with no code in it is no use — keep looking at older ones
      out.code = code;
      out.actionUrl = '';                  // there is nothing to press: the code is the whole point
    }
    return out;
  }, deps, { freshMs });
  return hit || null;
}

/** The Netflix verification code for a customer's own active account. From our shared inbox (NFLX-H); darkflix has no such page. */
async function verificationCode(acc, deps) {
  const a = acc || {};
  if (!famNetflix(a.service) || !s(a.email) || !a.kind) return { ok: false, manual: true };
  if (a.kind !== 'H') return { ok: false, manual: true }; // verification codes come by email; only our own inbox has them
  let code = '';
  try { code = await inboxCode(a, deps); } catch (e) { console.log('[olivia-hh] verification code failed:', e.message); return { ok: false, manual: true }; }
  return code ? { ok: true, code } : { ok: false, manual: true };
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

module.exports = { netflixAccounts, travelCode, updateHousehold, verificationCode, updateEnabled, latestMail, _internal: { kindOfRef, accountIdOf, tagOf, readTravelPage, isBlocked, codeFromNetflixLink, verificationCodeFrom, labelFor, inboxSearch, MAIL_WORDS, directAuth } };
