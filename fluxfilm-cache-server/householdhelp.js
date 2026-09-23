/**
 * FluxFilm — 🏠 Netflix Household, the customer's own tool (storefront → 🧰 Tools).
 *
 * It replaces "here are two links, work out which one is yours", which is the thing customers got wrong. Now the
 * shop works it out: it knows which Netflix account the customer is actually on, so it opens the right path.
 *
 *   start(phone)            → { ok, needPlan? , accounts: [ { accountId, email, kind, service, plan, expiry } ] }
 *   fix(phone, accountId, what)   what = 'household' | 'travel' | 'signin'
 *   pictures() · savePicture(kind, dataUrl)   the example screenshots the customer points at
 *
 * 🔒 The rule that matters: `fix` NEVER trusts the account id it is given. It asks the database which Netflix
 * accounts this phone has an ACTIVE subscription on, and refuses anything else. A customer can only ever act on an
 * account they are paying for today.
 *
 * 🕘 Every use is written to the change log (audit_log, the same table the admin panel uses), with the customer's
 * NAME and number, which account, what they asked for and how it ended — including the refusals. The 6-digit codes
 * themselves are never written down: the log says one was given, not what it was. Admin → 🕘 Change log → 🏠 Household.
 *
 * 🔐 'signin' is the 6-digit code that finishes a Netflix LOGIN. Customers already hold the login and password for
 * their account, so this lets them finish a sign-in they are entitled to — but it is still the most powerful thing
 * here, so: active sub only, our own accounts only, a short freshness window inside oliviahousehold, a per-phone
 * rate limit in server.js, every request written to the audit log, and the code itself never logged.
 *
 * Settings (app_settings): 'household_pics' — { household, travel, signin } as data: URLs, uploaded in admin.
 */
const db = require('./db');
const hhlog = require('./customerlog');

const PIC_KEY = 'household_pics';
const PIC_KINDS = ['household', 'travel', 'signin'];
const PIC_MAX_CHARS = Number(process.env.HH_PIC_MAX_CHARS || 700000); // ~500 KB per picture
const DARKFLIX_BASE = () => String(process.env.OLIVIA_DARKFLIX_BASE || 'https://darkflix.shop').replace(/\/+$/, '');

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const hh = (deps) => (deps && deps.household) || require('./oliviahousehold');
const q = (deps, sql, p) => ((deps && deps.query) || db.query)(sql, p || []);

// One line per use, in customerlog.js — shared with Olivia (chat) and 🔎 Get OTP.
// ⚠️ details is built by hand at every call site on purpose: a code must never be passed in.
const note = (deps, req, e) => hhlog.record(deps, req, e);

/**
 * The Netflix accounts this phone is actively paying for, with the plan and end date to show on the card.
 * The plain lookup, with no log line — fix() uses this so that acting on an account does not also record an "opened".
 */
async function listAccounts(ph, deps) {
  const r = await hh(deps).netflixAccounts(ph, deps);
  const accounts = (r && r.accounts) || [];
  if (!accounts.length) return { ok: true, needPlan: true, accounts: [] };
  // The plan name and end date come from the subscription, so the customer recognises which one is which.
  const subs = await q(deps,
    "SELECT sub_id, plan, expiry_date, inventory_ref FROM subscriptions WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' " +
    'AND (expiry_date IS NULL OR expiry_date > NOW())', [ph]);
  const byAccount = new Map();
  for (const x of (subs || [])) {
    const id = s(x.inventory_ref).split('#')[0].toUpperCase();
    const seen = byAccount.get(id);
    if (!seen || String(x.expiry_date || '') > String(seen.expiry_date || '')) byAccount.set(id, x);
  }
  return {
    ok: true,
    accounts: accounts.map((a) => {
      const sub = byAccount.get(s(a.ref).toUpperCase()) || {};
      return {
        accountId: s(a.ref), email: s(a.email), kind: s(a.kind), service: s(a.service),
        plan: s(sub.plan), expiry: sub.expiry_date ? String(sub.expiry_date).slice(0, 10) : '',
        ours: s(a.kind) === 'H',
      };
    }),
  };
}

/** What the customer sees when they open 🏠 Netflix Household — and the line that records that they opened it. */
async function start(phone, deps, req) {
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false, message: 'Please log in first.' };
  const out = await listAccounts(ph, deps);
  await note(deps, req, {
    action: 'household.open', phone: ph,
    summary: out.needPlan ? 'opened the household tool — no active Netflix plan' : 'opened the household tool — ' + out.accounts.length + ' account(s)',
    details: { accounts: (out.accounts || []).map((a) => a.accountId), needPlan: !!out.needPlan },
  });
  return out;
}

/** Everything the customer may do, and what each one is. */
const WHAT = {
  household: { needs: 'update', label: 'make this TV the home' },
  travel: { needs: 'travel', label: 'get the TV code' },
  signin: { needs: 'signin', label: 'get the sign-in code' },
};

/**
 * Do the one thing the customer picked, for one of THEIR accounts.
 * → { ok, code } · { ok, done } · { ok, openLink } (not our account) · { ok:false, manual:true } (do it by hand)
 */
async function fix(phone, accountId, what, deps, req) {
  const ph = norm(phone);
  const kind = WHAT[s(what)] ? s(what) : '';
  if (ph.length !== 10) return { ok: false, message: 'Please log in first.' };
  if (!kind) return { ok: false, message: 'Pick what you are seeing on the TV first.' };
  const label = WHAT[kind].label;

  // 🔒 The account must be one this phone is actively paying for — the id from the browser is only a hint.
  const mine = await listAccounts(ph, deps);
  if (!mine.ok) return mine;
  if (mine.needPlan) {
    await note(deps, req, { action: 'household.refused', phone: ph, summary: 'asked to ' + label + ' with no active Netflix plan', details: { what: kind, asked: s(accountId) } });
    return { ok: false, needPlan: true, message: 'You do not have an active Netflix plan right now.' };
  }
  const want = s(accountId).toUpperCase();
  const acc = want
    ? mine.accounts.find((a) => a.accountId.toUpperCase() === want) || null
    : (mine.accounts.length === 1 ? mine.accounts[0] : null);
  if (!acc) {
    // Either they asked for an account that is not theirs, or they have several and picked none.
    await note(deps, req, {
      action: 'household.refused', phone: ph,
      summary: want ? 'asked to ' + label + ' on ' + want + ', which is not theirs' : 'asked to ' + label + ' without saying which account',
      details: { what: kind, asked: want, theirs: mine.accounts.map((a) => a.accountId) },
    });
    return { ok: false, message: 'Please choose which Netflix account you need help with.' };
  }

  const H = hh(deps);
  const target = { service: acc.service, email: acc.email, kind: acc.kind, tag: '', ref: acc.accountId };
  // netflixAccounts() worked the tag out already; take it from there rather than working it out twice.
  const full = ((await H.netflixAccounts(ph, deps)).accounts || []).find((a) => s(a.ref).toUpperCase() === acc.accountId.toUpperCase());
  if (full) target.tag = s(full.tag);

  // Every exit below writes one line. end() keeps the code out of it: it records THAT a code was given, never which.
  const end = async (action, outcome, out, extra) => {
    await note(deps, req, {
      action, phone: ph,
      summary: acc.accountId + ' · ' + label + ' · ' + outcome,
      details: Object.assign({ what: kind, accountId: acc.accountId, email: acc.email, kind: acc.kind }, extra || {}),
    });
    return out;
  };

  /**
   * A PARTNER (darkflix) account. Two of the three still work here, because oliviahousehold.netflixLink() asks
   * darkflix for the Netflix link the same way a person would, then reads the page itself — it never needed our
   * inbox for those. Only the 6-digit verification code genuinely cannot work: that mail goes to the partner's
   * mailbox, not ours, so there is nothing for us to read. Owner asked, 24 Sep 2026: "can our AI do the dark
   * netflix account updates? just like ours can we not do that also in just 3 buttons".
   */
  if (acc.kind !== 'H') {
    if (kind === 'signin') {
      return end('household.link', 'sign-in code is not ours to read on a partner account',
        { ok: true, openLink: DARKFLIX_BASE() + '/household.php', notOurs: true, partnerSignin: true, email: acc.email, accountId: acc.accountId });
    }
    // Same two buttons as our own accounts. The link is the fallback, not the first answer.
    const rp = kind === 'travel' ? await H.travelCode(target, deps)
      : H.updateEnabled() ? await H.updateHousehold(target, deps) : null;
    if (rp && rp.ok && kind === 'travel' && rp.code) return end('household.travel', '✅ TV code given (partner account)', { ok: true, code: rp.code, accountId: acc.accountId });
    if (rp && rp.ok && kind !== 'travel') return end('household.update', '🏠 this TV made the home (partner account)', { ok: true, done: true, accountId: acc.accountId });
    return end('household.link', 'partner account — could not do it, sent to their page',
      { ok: true, openLink: DARKFLIX_BASE() + '/household.php', notOurs: true, email: acc.email, accountId: acc.accountId });
  }

  if (kind === 'travel') {
    const r = await H.travelCode(target, deps);
    return r && r.ok
      ? end('household.travel', '✅ TV code given', { ok: true, code: r.code, accountId: acc.accountId })
      : end('household.travel', '⚠️ no code — needs doing by hand', { ok: false, manual: true });
  }
  if (kind === 'signin') {
    const r = await H.verificationCode(target, deps);
    return r && r.ok
      ? end('household.signin', '🔐 sign-in code given', { ok: true, code: r.code, accountId: acc.accountId })
      : end('household.signin', '⚠️ no code — needs doing by hand', { ok: false, manual: true });
  }
  // household: make this TV the home. Only when the owner has switched that on (OLIVIA_HH_UPDATE).
  if (!H.updateEnabled()) return end('household.update', '⏸ turned off (OLIVIA_HH_UPDATE)', { ok: false, manual: true, updateOff: true });
  const r = await H.updateHousehold(target, deps);
  return r && r.ok
    ? end('household.update', '🏠 this TV made the home', { ok: true, done: true, accountId: acc.accountId })
    : end('household.update', '⚠️ could not — needs doing by hand', { ok: false, manual: true });
}

// ── the example pictures the customer points at ───────────────────────────────────────────────────────────────
let picCache = null;
async function pictures(deps) {
  if (picCache) return picCache;
  let v = null;
  try {
    const r = await q(deps, 'SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [PIC_KEY]);
    v = r && r[0] ? JSON.parse(r[0].value || 'null') : null;
  } catch (_) { v = null; }
  const out = {};
  for (const k of PIC_KINDS) out[k] = s(v && v[k]);
  picCache = { ok: true, pictures: out };
  return picCache;
}

async function savePicture(kind, dataUrl, deps) {
  const k = s(kind).toLowerCase();
  if (PIC_KINDS.indexOf(k) === -1) return { ok: false, message: 'Unknown picture.' };
  const v = s(dataUrl);
  if (v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { ok: false, message: 'Please upload a PNG, JPG or WebP image.' };
  if (v.length > PIC_MAX_CHARS) return { ok: false, message: 'That picture is too big — please use one under 500 KB.' };
  const cur = (await pictures(deps)).pictures;
  const next = Object.assign({}, cur, { [k]: v });
  for (const key of Object.keys(next)) if (!next[key]) delete next[key];
  try {
    await q(deps, 'INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [PIC_KEY, JSON.stringify(next)]);
  } catch (e) {
    if (/Data too long/i.test(String(e && e.message))) return { ok: false, message: 'Run db/schema-v17.sql in phpMyAdmin first (it makes room for pictures).' };
    throw e;
  }
  picCache = null;
  return { ok: true, kind: k, has: !!v, bytes: v.length };
}

module.exports = { start, fix, pictures, savePicture, PIC_KEY, PIC_KINDS, WHAT, _internal: { reset: () => { picCache = null; }, listAccounts, note } };
