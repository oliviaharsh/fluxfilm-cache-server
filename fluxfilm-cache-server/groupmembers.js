/**
 * FluxFilm — 👥 the WhatsApp group: who said they joined, and who is actually in it.
 *
 * Group Offer plans are cheaper because the customer joins the FluxFilm WhatsApp group. Two things were missing:
 *
 *   1. The "I have joined" tap was thrown away. It lived in the checkout's React state and in Olivia's chat state,
 *      and neither outlives the session, so nothing recorded who had ever said yes. `claim()` writes it down.
 *   2. There is no WhatsApp API that will list a group's members — not officially, and nothing worth running the
 *      business on. So the owner pastes the list (or an exported chat) and this file reconciles it against who is
 *      paying. `reconcile()` reads, `applyList()` writes.
 *
 * What the screen is FOR — three questions, each with an action behind it:
 *   · who is paying for a Group Offer and is NOT in the group   → chase them, or stop the discount
 *   · who is in the group and is paying for nothing             → remove them
 *   · who said they joined and never showed up in a list        → the tap was a lie, or they left again
 *
 * ⚠️ phone_norm is NEVER compared with customers / subscriptions in SQL. Those tables and the newer ones are in
 * different collations and MariaDB refuses the comparison — the failure that silently emptied the ▶️ Today count
 * on 27 Sep 2026. Every side is read on its own and matched in JavaScript, here and everywhere below.
 *
 * 🔐 Read-only about people: it never messages anybody, never adds or removes anyone from the group, and never
 * touches a subscription. Removing someone from WhatsApp is still done by hand, on purpose.
 *
 *   GET  /admin/api/group              who claimed, who was last seen, and who is missing
 *   POST /admin/api/group/paste        paste a member list → what it would change (apply: true to save it)
 *   POST /admin/api/group/member       edit the note on one row, or forget it
 */
const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (v) => { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; };
const sqlNow = (at) => new Date((at == null ? Date.now() : at) + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

/** Whole days until this expiry, in IST — counted the same way accounttools.js and ytfamilies.js count them. */
function daysLeft(v, now) {
  const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const t = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00+05:30').getTime();
  return Math.ceil((t - (now == null ? Date.now() : now)) / 86400000);
}

// ── reading a pasted list ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Every phone number in a line of text.
 *
 * Deliberately fussy, because the thing most likely to be pasted is an exported chat and EVERY line of one starts
 * with a date and a time. "28/09/2026, 20:14" is nine digits with punctuation through it; a loose "find digits"
 * regex turns that into a phone number and quietly invents members. So: digits may be separated by spaces and
 * hyphens only — never by a slash, dot or colon — and the result has to be a plausible Indian mobile.
 */
/** An Indian mobile, and nothing else: 10 digits starting 6-9, optionally behind a trunk / country prefix. */
const isMobile = (d) => (d.length === 10 ? /^[6-9]/.test(d) : /^(0|91|091|0091)[6-9]\d{9}$/.test(d));
/** The "28/09/2026, 20:14 - " that starts every line of an exported chat, in the shapes WhatsApp writes it. */
const STAMP_RE = /^\s*\[?\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*\]?\s*[-–]?\s*/i;

function phonesIn(line) {
  const out = [];
  // Split on anything a phone number cannot contain. A date is broken up by its slashes and a time by its colon,
  // so neither survives as one run of digits — and a name or a word ends the run it is next to.
  for (const chunk of s(line).replace(STAMP_RE, ' ').split(/[^\d+\s-]+/)) {
    let toks = chunk.split(/[\s-]+/).filter((x) => /\d/.test(x));
    const here = [];
    // Take the LONGEST trailing group of tokens that reads as one number, then keep going on what is left of it.
    // Reading left to right and stopping at the first match instead is what loses numbers: a greedy match that
    // swallows "20 14 - +91 98765 43210" fails the mobile test as a whole and takes the real number down with it.
    while (toks.length) {
      let hit = -1;
      for (let i = 0; i < toks.length; i++) {
        if (isMobile(toks.slice(i).join('').replace(/\D/g, ''))) { hit = i; break; }
      }
      if (hit < 0) break;
      here.unshift(toks.slice(hit).join('').replace(/\D/g, '').slice(-10));
      toks = toks.slice(0, hit);
    }
    for (const p of here) out.push(p);
  }
  return out;
}

const JOINED_RE = /joined using this group|was added|added (you|\+?\d)|joined the group/i;
// "left" only at the very end of the line, because that is where WhatsApp puts it ("+91 98765 43210 left") and
// because a member typing "I left my phone at home" must not remove themselves from the group.
const LEFT_RE = /\bleft\s*$|was removed\s*$|removed (\+?\d)/i;

/**
 * Turn whatever was pasted into a set of numbers that are in the group now.
 *
 * Two shapes, told apart by what is in the text rather than by a switch the owner has to understand:
 *   · an EXPORTED CHAT — has "joined using this group's invite link" / "left" lines. Replayed in order, so
 *     somebody who joined in June and left in August is correctly OUT. This is the only shape a phone can
 *     actually produce: WhatsApp will not let you select the participants list, but it will export the chat.
 *   · a plain LIST — anything else. Every number in it is a member. What you get from WhatsApp Web, a
 *     screenshot typed out, or a list kept by hand.
 */
/** The date on an exported chat line, as yyyy-mm-dd, or '' — used only to say what the paste covered. */
function lineDate(line) {
  const m = s(line).match(/^\s*\[?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!m) return '';
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  // WhatsApp writes dd/mm in India. Only ever used to show the owner a range, never to decide membership.
  const d = Number(m[1]); const mo = Number(m[2]);
  if (!(y > 2000 && y < 2100) || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/**
 * The display name on a system line that carries no number, and whether they came or went.
 *
 * Half of this community is saved in the owner's contacts, so WhatsApp writes the name he saved instead of the
 * number: "FF - (YT) Alok Yadav joined using this community's invite link". Measured on the real export on
 * 29 Sep 2026 — 1129 join lines, 598 of them with no number anywhere in them. Ignoring those is what made the
 * chase list more than half wrong.
 *
 * Only the four system sentences WhatsApp actually writes are read. Anything else is somebody talking.
 */
function nameEvent(rest) {
  let m;
  if ((m = rest.match(/^(.+?) joined using this (?:group|community)'s invite link$/))) return { name: m[1], inGroup: true };
  if ((m = rest.match(/^(.+?) joined the (?:group|community)$/))) return { name: m[1], inGroup: true };
  if ((m = rest.match(/^(.+?) was added$/))) return { name: m[1], inGroup: true };
  if ((m = rest.match(/^(.+?) left$/))) return { name: m[1], inGroup: false };
  if ((m = rest.match(/^(.+?) was removed$/))) return { name: m[1], inGroup: false };
  // "<somebody> added <name>" / "<somebody> removed <name>" — the TARGET is the one joining or leaving.
  if ((m = rest.match(/^.+? added (.+)$/))) return { name: m[1], inGroup: true };
  if ((m = rest.match(/^.+? removed (.+)$/))) return { name: m[1], inGroup: false };
  return null;
}

/**
 * A display name reduced to something that can be compared with a customer's name.
 *
 * The prefixes stripped here are the owner's own filing system in his contacts — "FF - ", a service tag in
 * brackets, WhatsApp's "~" for a push name. Nothing clever: no nicknames, no initials, no fuzzy distance. A name
 * is not a key, and the only safe use of one is an exact match that is also the ONLY match.
 */
const nameKey = (v) => s(v)
  .replace(/^~\s*/, '')
  .replace(/^FF\s*[-–]\s*/i, '')
  .replace(/^\([^)]{1,12}\)\s*/, '')
  .replace(/^(?:YT|OTT|NF|PR|JH)\s+/i, '')
  .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

function parseList(text) {
  const lines = s(text).split(/\r?\n/);
  let events = 0;
  let firstDate = ''; let lastDate = '';
  const state = new Map(); // phone -> true (in) / false (out)
  const byName = new Map();          // display name -> true / false, replayed the same way
  const seenAnywhere = new Set();
  for (const line of lines) {
    const d = lineDate(line);
    if (d) { if (!firstDate || d < firstDate) firstDate = d; if (d > lastDate) lastDate = d; }
    const ph = phonesIn(line);
    if (!ph.length) {
      // No number on this line: it may still be a system line naming somebody saved in the owner's contacts.
      const rest = s(line).replace(STAMP_RE, '');
      const ev = rest && rest !== line ? nameEvent(rest) : null;
      if (ev && nameKey(ev.name) && nameKey(ev.name) !== 'you') { events++; byName.set(s(ev.name).replace(/^~\s*/, ''), ev.inGroup); }
      continue;
    }
    const joined = JOINED_RE.test(line);
    const left = LEFT_RE.test(line);
    for (const p of ph) seenAnywhere.add(p);
    if (joined && !left) { events++; for (const p of ph) state.set(p, true); }
    else if (left && !joined) { events++; for (const p of ph) state.set(p, false); }
  }
  const names = [...byName.entries()].filter(([, inGroup]) => inGroup).map(([nm]) => nm);
  const mode = events > 0 ? 'export' : 'list';
  const span = { lines: lines.length, firstDate, lastDate, names };
  if (mode === 'list') return Object.assign({ mode, events: 0, phones: [...seenAnywhere] }, span, { names: [] });
  // In an export, somebody who never has an event but does send messages is in the group too.
  for (const p of seenAnywhere) if (!state.has(p)) state.set(p, true);
  return Object.assign({ mode, events, phones: [...state.entries()].filter(([, inGroup]) => inGroup).map(([p]) => p) }, span);
}

// ── who is supposed to be in the group ────────────────────────────────────────────────────────────────────────
// subscriptions carries no name — the customer's name is on customers, keyed by the same 10-digit phone.
// Read as two statements and matched in JavaScript, never joined: this database has tables in two collations
// and MariaDB refuses the comparison. (It went live asking subscriptions for a name column it has never had, and
// every request 500'd — the fake in the test had the column because the fake was written from my own SQL.)
const SUBS_SQL =
  'SELECT sub_id, phone_norm, service, plan, expiry_date, status FROM subscriptions ' +
  "WHERE UPPER(COALESCE(status,'')) NOT IN ('REFUNDED','CANCELLED')";
const NAMES_SQL = 'SELECT phone_norm, name FROM customers';

const ALIAS_KEY = 'wa_group_aliases';
/**
 * What the owner has told us somebody is called in the group.
 *
 * Two things the matcher cannot work out on its own, both found by the owner on 29 Sep by reading the member
 * list against the screen:
 *   · a contact saved under a fuller name — "FF - Naresh Nani" in WhatsApp, "Naresh" in the customer record.
 *     One customer, not ambiguous, simply a DIFFERENT name, and no amount of cleverness makes them equal
 *     without also making wrong pairs equal.
 *   · a name two customer rows share — "Mohmadazaz Patel" is two accounts, so it matches neither, on purpose.
 * Both are answered the same way: he says it once, and it is remembered. Stored in app_settings rather than a
 * new table — it is a handful of corrections, not transactional data, and it needs no migration to start working.
 */
async function aliases(query) {
  try {
    const r = await query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [ALIAS_KEY]);
    const v = r && r[0] ? JSON.parse(r[0].value || '{}') : {};
    const m = new Map();
    for (const [k, ph] of Object.entries(v || {})) { const p = norm(ph); if (k && p) m.set(String(k), p); }
    return m;
  } catch (_) { return new Map(); }
}
async function saveAlias(query, key, phone) {
  const k = s(key); const p = norm(phone);
  if (!k) return false;
  const m = await aliases(query);
  if (p) m.set(k, p); else m.delete(k);
  const obj = {}; for (const [a, b] of m) obj[a] = b;
  await query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [ALIAS_KEY, JSON.stringify(obj)]);
  return true;
}

/**
 * Names from a pasted list, matched to customers.
 *
 * The rule that keeps this honest: a name counts ONLY when exactly one customer has it. Two customers called
 * "Sahil" means neither of them is matched — that is not a near miss to be resolved with a guess, it is an
 * unanswerable question, and answering it wrongly would remove a real person from the chase list.
 */
function matchNames(names, byName, alias) {
  const matched = []; const ambiguous = []; const unknown = [];
  const byHand = alias || new Map();
  for (const nm of (names || [])) {
    const key = nameKey(nm);
    // What the owner said wins over what the matcher can work out: he has read the member list, it has not.
    const told = byHand.get(key);
    if (told) { matched.push({ name: nm, phone: told, byHand: true }); continue; }
    const hit = byName.get(key);
    if (!hit) unknown.push(nm);
    else if (hit.length > 1) ambiguous.push(nm);
    else matched.push({ name: nm, phone: hit[0] });
  }
  return { matched, ambiguous, unknown };
}

/** phone -> name, and name-key -> [phones], from the customers table. Read on its own; never joined. */
async function customerNames(query) {
  const byPhone = new Map(); const byName = new Map();
  let rows = [];
  try { rows = await query(NAMES_SQL, []); } catch (e) { console.log('[group] names unavailable:', e.message); return { byPhone, byName }; }
  // 🧑‍🤝‍🧑 Two customer rows the owner has marked as one person count as ONE account here. Ten names were
  // ambiguous on 29 Sep only because the same customer exists twice — "Karan Sunder" is not two people, it is
  // one person with two numbers, and refusing to match him was right only while nobody had said so.
  let same = new Map();
  try { const d = require('./duplicates'); same = (await d.links(query)).map; } catch (e) { same = new Map(); }
  const primary = (ph) => { try { return require('./duplicates').primaryOf(same, ph); } catch (e) { return ph; } };
  for (const c of rows) {
    const ph = norm(c.phone_norm);
    if (!ph) continue;
    byPhone.set(ph, s(c.name));
    const k = nameKey(c.name);
    if (!k) continue;
    const list = byName.get(k) || [];
    const use = primary(ph);
    if (list.indexOf(use) === -1) list.push(use);
    byName.set(k, list);
  }
  return { byPhone, byName };
}

/**
 * The services sold on the "join the group" deal. Taken from the plans themselves (RequiresGroupJoin in
 * raw_json, which is what the storefront gates on) rather than guessed from a name — a plan renamed in admin
 * must not quietly drop out of this screen. The /group/i fallback only covers a plan whose flag was never set.
 */
async function groupServices(query) {
  const out = new Set();
  let rows = [];
  try { rows = await query('SELECT service, plan, raw_json FROM plans', []); } catch (_) { rows = []; }
  for (const r of rows) {
    let raw = {};
    try { raw = r.raw_json ? (typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json) : {}; } catch (_) { raw = {}; }
    const flag = s(raw.RequiresGroupJoin).toUpperCase();
    if (flag === 'TRUE' || flag === '1' || flag === 'YES' || /group/i.test(s(r.service))) out.add(s(r.service).toLowerCase());
  }
  return out;
}

const GROUP_FALLBACK = 'https://chat.whatsapp.com/IY67tbIr0zj0WfTFyYp3eB';
/**
 * The invite link to send THIS customer: the one on the plan they are actually paying for, so a second group
 * with its own link keeps working. Only a real WhatsApp invite link is ever sent — anything else in that field
 * is ignored rather than pasted into a customer's message.
 */
const GROUP_LINK_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/;
async function groupLinkFor(query, service) {
  let rows = [];
  try { rows = await query('SELECT service, plan, raw_json FROM plans', []); } catch (_) { rows = []; }
  const linkOf = (r) => { try { const raw = r.raw_json ? (typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json) : {}; return s(raw.GroupJoinLink); } catch (_) { return ''; } };
  const wanted = s(service).toLowerCase();
  const mine = rows.filter((r) => s(r.service).toLowerCase() === wanted).map(linkOf).filter((x) => GROUP_LINK_RE.test(x));
  if (mine.length) return mine[0];
  const any = rows.map(linkOf).filter((x) => GROUP_LINK_RE.test(x));
  return any.length ? any[0] : GROUP_FALLBACK;
}

const escHtml = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const firstName = (v) => { const w = s(v).split(/\s+/)[0] || ''; return /^[\p{L}\p{M}.'-]{2,20}$/u.test(w) ? w : ''; };

/**
 * "Please join the group" — the message the owner sends to somebody paying the Group Offer price who is not in
 * the group.
 *
 * It has to say what happens next, because that is the whole point of sending it, and it has to say it without
 * threatening anybody: the Group Offer is cheaper BECAUSE of the group, so not being in it means the plan moves
 * to the normal price or stops at the end of the term. That is a fact about the deal, not a punishment.
 *
 * 🔒 Nothing here sends anything. It writes the words; the owner reads them and presses send.
 */
function nudgeText(p) {
  const hi = 'Hi' + (firstName(p.name) ? ' ' + firstName(p.name) : '') + ',';
  return [hi, '',
    'Your FluxFilm *' + s(p.service).replace(/\s*\(.*\)$/, '') + '*' + (s(p.plan) ? ' (' + s(p.plan) + ')' : '') + ' is on our *Group Offer* price'
      + (s(p.expiryLabel) ? ', valid till *' + s(p.expiryLabel) + '*' : '') + '.',
    '',
    'That price is only for members of our WhatsApp group — and we cannot find your number in it 🙏',
    '',
    '👉 Please join here:', s(p.link), '',
    'If you are already in it with a different number, just tell us which one and we will fix it.',
    '',
    'If you would rather not join, that is completely fine — we will move you to the normal price at renewal instead. 💚',
  ].join('\n');
}

function nudgeEmail(p) {
  const subject = '🙏 Please join the FluxFilm group — your Group Offer price';
  const html = '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">' +
    '<h2 style="color:#0f766e;margin-bottom:4px">🙏 One small thing</h2>' +
    '<p style="color:#475569;margin-top:0">Hi ' + escHtml(firstName(p.name) || 'there') + ',</p>' +
    '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:14px">' +
    '<b>' + escHtml(s(p.service).replace(/\s*\(.*\)$/, '')) + '</b>' + (s(p.plan) ? ' — ' + escHtml(p.plan) : '') +
    (s(p.expiryLabel) ? '<br>valid till ' + escHtml(p.expiryLabel) : '') + '</div>' +
    '<p style="color:#475569;font-size:14px">You are on our <b>Group Offer</b> price, which is only for members of our WhatsApp group — and we cannot find your number in it.</p>' +
    '<p><a href="' + escHtml(p.link) + '" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Join the WhatsApp group</a></p>' +
    '<p style="color:#475569;font-size:14px">Already in it with a different number? Just reply and tell us which one, and we will fix it.</p>' +
    '<p style="color:#475569;font-size:14px">If you would rather not join, that is completely fine — we will simply move you to the normal price at renewal. 💚</p>' +
    '<p style="color:#94a3b8;font-size:12px;margin-top:18px">Need help? Just reply to this email or message us on WhatsApp.</p></div>';
  return { subject, html };
}

/** A wa.me link the panel re-points at whichever WhatsApp app the owner chose (waFix in admin.html). */
function waUrl(phone, text) { const d = norm(phone); return d.length === 10 ? 'https://wa.me/91' + d + '?text=' + encodeURIComponent(text) : ''; }

function stateOf(sub, now) {
  const d = daysLeft(sub && sub.expiry_date, now);
  if (d == null) return { state: 'UNKNOWN', days: null };
  if (d <= 0) return { state: 'EXPIRED', days: d };
  if (d <= 7) return { state: 'ENDING', days: d };
  return { state: 'ACTIVE', days: d };
}

/**
 * Everything the screen needs. Three reads, no joins, matched on the 10-digit phone in JavaScript.
 */
async function overview(query, now) {
  const at = now == null ? Date.now() : now;
  let rows; let provenanceOff = false;
  try {
    rows = await query('SELECT id, phone_norm, name, claimed_at, claimed_via, claimed_for, seen_at, seen_by, missing_at, note FROM wa_group_members', []);
  } catch (e) {
    // schema-v32 not run: the rows are all still there, we just cannot say HOW each one was found.
    if (/Unknown column .*seen_by/i.test(String(e && e.message))) {
      rows = (await query('SELECT id, phone_norm, name, claimed_at, claimed_via, claimed_for, seen_at, missing_at, note FROM wa_group_members', []))
        .map((x) => Object.assign({ seen_by: '' }, x));
      provenanceOff = true;
    } else
    if (/wa_group_members/i.test(String(e && e.message)) && /doesn't exist|Unknown table/i.test(String(e && e.message))) {
      return { ok: true, needsSchema: true, members: [], owe: [], strangers: [], totals: { claimed: 0, seen: 0, owe: 0, strangers: 0, neverSeen: 0 } };
    } else {
      throw e;   // NOT an else-less fall-through: the guard above returns rows, and this must not run when it did.
    }
  }
  const byPhone = new Map(rows.map((r) => [norm(r.phone_norm), r]));
  const services = await groupServices(query);
  const subs = (await query(SUBS_SQL, [])).filter((x) => services.has(s(x.service).toLowerCase()));
  const names = (await customerNames(query)).byPhone;
  const aliasMap = await aliases(query);

  // One line per person who is paying for a Group Offer plan today.
  const owed = new Map();
  for (const sub of subs) {
    const ph = norm(sub.phone_norm);
    if (!ph) continue;
    const st = stateOf(sub, at);
    const prev = owed.get(ph);
    // Somebody with two group subs is one person in the group; keep the one that runs longest.
    if (prev && s(prev.expiry) >= s(sub.expiry_date)) continue;
    owed.set(ph, {
      phone: ph, name: names.get(ph) || 'Unknown', service: s(sub.service), plan: s(sub.plan),
      subId: s(sub.sub_id), expiry: s(sub.expiry_date), expiryLabel: prettyDate(sub.expiry_date),
      state: st.state, days: st.days,
    });
  }

  const row = (r) => ({
    id: Number(r.id), phone: norm(r.phone_norm), name: s(r.name),
    claimedAt: s(r.claimed_at), claimedVia: s(r.claimed_via), claimedFor: s(r.claimed_for),
    seenAt: s(r.seen_at), seenBy: s(r.seen_by), missingAt: s(r.missing_at), note: s(r.note),
    // seen_at set and missing_at cleared, NOT 'the later of the two timestamps'. Both are written to the second,
    // so two lists checked inside the same second made a member who had left look present — a real ordering bug
    // that a slow afternoon would have hidden for months. applyList clears missing_at whenever it sees them.
    inGroup: !!s(r.seen_at) && !s(r.missing_at),
  });
  const members = rows.map(row);
  const inGroup = new Set(members.filter((m) => m.inGroup).map((m) => m.phone));
  const everChecked = members.some((m) => m.seenAt || m.missingAt);

  // Paying, not in the group. Only meaningful once a list has been pasted at least once — before that we do not
  // know who is in the group, and a screen full of red would be a lie, so it says "not checked yet" instead.
  const owe = (everChecked ? [...owed.values()] : [])
    .filter((p) => p.state !== 'EXPIRED' && !inGroup.has(p.phone))
    .map((p) => Object.assign({}, p, byPhone.has(p.phone) ? { claimedAt: s((byPhone.get(p.phone) || {}).claimed_at) } : {}))
    .sort((a, b) => s(a.expiry).localeCompare(s(b.expiry)));

  // In the group, paying for nothing. Expired group customers are named as such — they are the ones to remove.
  const strangers = members.filter((m) => m.inGroup && !owed.has(m.phone)).map((m) => Object.assign({}, m, { was: null }));
  const expiredIn = [...owed.values()].filter((p) => p.state === 'EXPIRED' && inGroup.has(p.phone));

  return {
    ok: true,
    everChecked, provenanceOff,
    lastList: await lastListSummary(query),
    // phone -> the name the owner said they go by in the group, so a row can show it…
    aliasOf: (() => { const o = {}; for (const [k, p] of aliasMap) o[p] = k; return o; })(),
    // …and the same list with the customer's real name on it, because once somebody is marked as in the group
    // they leave every list on this screen — and a decision you cannot see is a decision you cannot take back.
    aliased: [...aliasMap.entries()].map(([k, p]) => ({ phone: p, alias: k, name: names.get(p) || '' })),
    members: members.sort((a, b) => s(b.claimedAt || b.seenAt).localeCompare(s(a.claimedAt || a.seenAt))),
    owe, strangers, expiredIn,
    totals: {
      claimed: members.filter((m) => m.claimedAt).length,
      seen: inGroup.size,
      owe: owe.length,
      strangers: strangers.length,
      expiredIn: expiredIn.length,
      neverSeen: members.filter((m) => m.claimedAt && !m.seenAt).length,
    },
  };
}

const LAST_KEY = 'wa_group_last';
/** What the last saved list contained, so the screen can explain a community count it cannot otherwise see. */
async function lastListSummary(query) {
  try {
    const r = await query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [LAST_KEY]);
    return r && r[0] ? JSON.parse(r[0].value || 'null') : null;
  } catch (_) { return null; }
}

/**
 * What a pasted list says, without writing anything. The owner sees this before it is saved, because a bad paste
 * (the wrong group, half a screen, a list of order ids) would otherwise mark every real member as having left.
 */
async function reconcile(query, text, now) {
  const at = now == null ? Date.now() : now;
  const parsed = parseList(text);
  const view = await overview(query, at);
  if (view.needsSchema) return { ok: true, needsSchema: true };
  const nm = matchNames(parsed.names, (await customerNames(query)).byName, await aliases(query));
  const found = new Set(parsed.phones.concat(nm.matched.map((x) => x.phone)));
  const owed = new Map(view.owe.concat(view.expiredIn || []).map((p) => [p.phone, p]));
  for (const m of view.members) if (!owed.has(m.phone)) owed.set(m.phone, null);

  const known = new Map(view.members.map((m) => [m.phone, m]));
  const nowIn = [...found];
  const newRows = nowIn.filter((p) => !known.has(p));
  const goneAway = view.members.filter((m) => m.inGroup && !found.has(m.phone)).map((m) => ({ phone: m.phone, name: m.name }));
  // An export that stops months ago is a half-file, and a half-file saved as if it were the whole group marks
  // everybody it is missing as having left. The owner hit exactly this: 490 members in, 258 out, and nothing on
  // the screen said the paste had stopped in May. So the check now says what it covered, and how stale the end is.
  const staleDays = parsed.lastDate
    ? Math.floor((Date.parse(parsed.lastDate + 'T23:59:59+05:30') - at) / -86400000)
    : null;
  return {
    ok: true,
    mode: parsed.mode, events: parsed.events,
    lines: parsed.lines, firstDate: parsed.firstDate, lastDate: parsed.lastDate, staleDays,
    looksPartial: parsed.mode === 'export' && staleDays != null && staleDays > 2,
    // ⚠️ Three different counts, and mixing them up is how the ceiling became nonsense on the first live run
    // (it said 630 where the community has 488). Keep them apart:
    //   countFound   numbers actually read out of the file
    //   membersFound numbers + names we could turn into a customer — the rows a save would write
    //   memberTotal  numbers + ALL names, the ceiling on the community's size
    // The name-matched ones are in BOTH countFound's successor and namesFound, so they must not be added twice.
    countFound: parsed.phones.length,
    membersFound: nowIn.length,
    // Half a community can be saved in the owner's contacts, so the export names them and never numbers them.
    // Those only become members we can act on when the name matches exactly one customer.
    namesFound: (parsed.names || []).length,
    namesMatched: nm.matched.length,
    namesAmbiguous: nm.ambiguous.length,
    namesUnknown: nm.unknown.length,
    memberTotal: parsed.phones.length + (parsed.names || []).length,
    newRows: newRows.length,
    goneAway,
    // Named here so the owner can see the paste was understood before it is saved.
    sample: nowIn.slice(0, 5),
  };
}

/** Save a pasted list: everyone in it is seen now, everyone previously in it and absent from it has gone. */
async function applyList(query, text, now) {
  const at = now == null ? Date.now() : now;
  const stamp = sqlNow(at);
  // One probe, once: ask the table whether it has the column rather than finding out half way through a save.
  try { await query('SELECT seen_by FROM wa_group_members LIMIT 1', []); seenByOff = false; }
  catch (e) { if (/Unknown column .*seen_by/i.test(String(e && e.message))) seenByOff = true; else if (!/doesn't exist|Unknown table/i.test(String(e && e.message))) throw e; }
  const parsed = parseList(text);
  const cn = await customerNames(query);
  const nm = matchNames(parsed.names, cn.byName, await aliases(query));
  if (!parsed.phones.length && !nm.matched.length) return { ok: false, message: 'No phone numbers could be read out of that, and no name in it matched a customer. Paste the participant list, or an exported chat.' };
  const rows = await query('SELECT id, phone_norm, seen_at, missing_at FROM wa_group_members', []);
  const known = new Map(rows.map((r) => [norm(r.phone_norm), r]));
  // A number beats a name: if the export has both for the same person, the number is the one we are sure of.
  const how = new Map();
  for (const x of nm.matched) how.set(x.phone, 'name');
  for (const p of parsed.phones) how.set(p, 'number');
  const found = new Set(how.keys());
  let added = 0; let seen = 0; let gone = 0;
  for (const p of found) {
    const by = how.get(p) || '';
    if (known.has(p)) { await query(withSeenBy('UPDATE wa_group_members SET seen_at = ?, missing_at = NULL WHERE id = ?', 'update'), seenByArgs([stamp], by, [known.get(p).id])); seen++; }
    else { await query(withSeenBy('INSERT INTO wa_group_members (phone_norm, name, seen_at) VALUES (?, ?, ?)', 'insert'), seenByArgs([p, cn.byPhone.get(p) || '', stamp], by, [])); added++; }
  }
  for (const r of rows) {
    const p = norm(r.phone_norm);
    if (found.has(p)) continue;
    if (!s(r.seen_at)) continue;                       // never seen in a list: nothing to have left
    if (s(r.missing_at)) continue;                     // already marked gone by an earlier list
    await query('UPDATE wa_group_members SET missing_at = ? WHERE id = ?', [stamp, r.id]);
    gone++;
  }
  const summary = {
    at: stamp, numbered: parsed.phones.length, named: (parsed.names || []).length,
    namesMatched: nm.matched.length, namesAmbiguous: nm.ambiguous.length, namesUnknown: nm.unknown.length,
    memberTotal: parsed.phones.length + (parsed.names || []).length,
    membersFound: found.size,
    // The names nothing could be done with. Kept so the screen can OFFER them: the owner can see "FF - Naresh
    // Nani" in this list, recognise it as Naresh, and say so once. Capped so one paste cannot fill the row.
    spare: nm.ambiguous.concat(nm.unknown).slice(0, 600),
  };
  try {
    await query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [LAST_KEY, JSON.stringify(summary)]);
  } catch (e) { console.log('[group] could not record the list summary:', e.message); }
  return { ok: true, mode: parsed.mode, added, seen, gone, total: found.size, byName: nm.matched.length, summary };
}

/**
 * schema-v32 adds seen_by; everything works without it. Written as two tiny helpers rather than two copies of
 * each statement, because the last time this shape was needed (schema-v30, 26 Sep) the fallback branch fell
 * through to a throw that was written below it and the whole screen went dark.
 */
let seenByOff = false;
function withSeenBy(sql, kind) {
  if (seenByOff) return sql;
  return kind === 'insert'
    ? 'INSERT INTO wa_group_members (phone_norm, name, seen_at, seen_by) VALUES (?, ?, ?, ?)'
    : 'UPDATE wa_group_members SET seen_at = ?, seen_by = ?, missing_at = NULL WHERE id = ?';
}
function seenByArgs(head, by, tail) { return seenByOff ? head.concat(tail) : head.concat([by]).concat(tail); }

/**
 * Record that this person says they have joined the group. Called from the storefront checkout and from Olivia,
 * and it must never be able to stop either of them: a claim that does not save is a missing line on one screen,
 * an order that does not save is a customer with no plan.
 */
async function claim(phone, name, via, service, deps) {
  const ph = norm(phone);
  if (!ph) return { ok: false };
  const query = (deps && deps.query) || require('./db').query;
  const stamp = sqlNow(deps && deps.now ? deps.now() : null);
  try {
    // The name and the service are only worth writing when we have them; a later claim must not blank an earlier one.
    await query(
      'INSERT INTO wa_group_members (phone_norm, name, claimed_at, claimed_via, claimed_for) VALUES (?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE claimed_at = VALUES(claimed_at), claimed_via = VALUES(claimed_via), ' +
      'name = COALESCE(NULLIF(VALUES(name), \'\'), name), claimed_for = COALESCE(NULLIF(VALUES(claimed_for), \'\'), claimed_for)',
      [ph, s(name).slice(0, 120), stamp, s(via).slice(0, 16), s(service).slice(0, 80)]);
    return { ok: true };
  } catch (e) {
    // Includes "table doesn't exist" — schema-v31 not run yet. Says so once in the log and gets out of the way.
    console.log('[group] could not record the join claim for ...' + ph.slice(-4) + ':', e.message);
    return { ok: false };
  }
}

function mount(app, deps) {
  const { auth } = deps;
  const db = deps.db || require('./db');
  const query = (sql, p) => db.query(sql, p || []);
  const audit = deps.audit || { record: () => {} };
  const now = deps.now || (() => Date.now());
  const fail = (res, e) => {
    if (/wa_group_members/i.test(String(e && e.message)) && /doesn't exist|Unknown table/i.test(String(e && e.message))) {
      return res.json({ ok: false, needsSchema: true, message: 'Run db/schema-v31.sql in phpMyAdmin first — it makes the group table.' });
    }
    return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };

  app.get('/admin/api/group', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await overview(query, now())); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/group/paste', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const text = s(b.text);
    if (!text) return res.status(400).json({ ok: false, message: 'Paste the member list first.' });
    try {
      if (b.apply !== true) return res.json(await reconcile(query, text, now()));
      const r = await applyList(query, text, now());
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: 'group.list', entity: 'settings', id: 'wa_group', summary: 'group list checked — ' + r.total + ' in the group (' + r.added + ' new, ' + r.gone + ' gone)' });
      res.json(Object.assign(r, { view: await overview(query, now()) }));
    } catch (e) { fail(res, e); }
  });

  /**
   * Everything needed to nudge one customer, written but NOT sent. The owner reads it and presses send — the
   * standing rule is that a real customer message is never sent without them seeing it first.
   */
  const NUDGE_EVERY_HOURS = 24;
  async function nudgeFor(phone) {
    const ph = s(phone).replace(/\D/g, '').slice(-10);
    if (ph.length !== 10) return null;
    const view = await overview(query, now());
    if (view.needsSchema) return null;
    const p = (view.owe || []).find((x) => x.phone === ph) || (view.expiredIn || []).find((x) => x.phone === ph);
    if (!p) return null;
    const link = await groupLinkFor(query, p.service);
    const full = Object.assign({}, p, { link });
    let to = '';
    try {
      const r = await query('SELECT email FROM customers WHERE phone_norm = ? LIMIT 1', [ph]);
      to = s(r && r[0] && r[0].email);
    } catch (e) { console.log('[group] could not read the email for ...' + ph.slice(-4) + ':', e.message); }
    let lastSentAt = ''; let recent = 0;
    try {
      const r = await query("SELECT ts FROM reminder_log WHERE sub_id = ? AND kind = 'GROUP_JOIN' ORDER BY ts DESC LIMIT 1", [p.subId]);
      lastSentAt = s(r && r[0] && r[0].ts);
      if (lastSentAt) recent = (Date.now() - Date.parse(String(lastSentAt).replace(' ', 'T') + '+05:30')) < NUDGE_EVERY_HOURS * 3600e3 ? 1 : 0;
    } catch (_) { lastSentAt = ''; }
    const text = nudgeText(full);
    const mail = nudgeEmail(full);
    return { person: full, to, link, text, mail, waUrl: waUrl(ph, text), lastSentAt, rateLimited: !!recent };
  }

  app.get('/admin/api/group/nudge', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await nudgeFor(s(req.query.phone));
      if (!r) return res.status(404).json({ ok: false, message: 'That customer is not on the "paying, not in the group" list.' });
      res.json({
        ok: true, phone: r.person.phone, name: r.person.name, to: r.to, link: r.link,
        subject: r.mail.subject, html: r.mail.html, whatsapp: r.text, waUrl: r.waUrl,
        lastSentAt: r.lastSentAt, rateLimited: r.rateLimited, everyHours: NUDGE_EVERY_HOURS,
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/group/nudge', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    try {
      const r = await nudgeFor(s(b.phone));
      if (!r) return res.status(404).json({ ok: false, message: 'That customer is not on the "paying, not in the group" list.' });
      if (!r.to || r.to.indexOf('@') < 0) return res.status(400).json({ ok: false, message: 'No email address on this customer — use the 💬 WhatsApp button instead.' });
      if (r.rateLimited) return res.status(429).json({ ok: false, rateLimited: true, message: 'Already emailed at ' + s(r.lastSentAt).slice(0, 16) + ' — at most one every ' + NUDGE_EVERY_HOURS + ' hours.' });
      let sent;
      try { sent = await (deps.mailer || require('./mailer')).send(r.to, r.mail.subject, r.mail.html); }
      catch (e) { sent = { ok: false, error: e.message }; }
      const good = !!(sent && sent.ok);
      try {
        await query('INSERT INTO reminder_log (ts, sub_id, channel, kind, expiry_date, ok, note) VALUES (NOW(), ?, ?, ?, ?, ?, ?)',
          [r.person.subId, 'EMAIL', 'GROUP_JOIN', r.person.expiry || null, good ? 1 : 0, (good ? 'asked to join the group' : s(sent && (sent.error || sent.skipped))).slice(0, 300) || null]);
      } catch (e) { console.log('[group] reminder_log write failed:', e.message); }
      audit.record(req, {
        action: good ? 'group.nudge' : 'group.nudgeFailed', entity: 'subscription', id: r.person.subId,
        summary: (good ? '👥 Asked ' : '👥 Could NOT ask ') + r.person.name + ' to join the group (' + r.to + ')' + (good ? '' : ' — ' + s(sent && (sent.error || sent.skipped))),
      });
      if (!good) return res.status(502).json({ ok: false, message: 'Email not sent: ' + (s(sent && (sent.error || sent.skipped)) || 'unknown error') });
      res.json({ ok: true, to: r.to, message: '✉️ Sent to ' + r.to });
    } catch (e) { fail(res, e); }
  });

  /**
   * "This customer is in the group, under this name." Remembered, and applied at once so the screen agrees with
   * what the owner just saw with their own eyes — waiting for the next paste to confirm it would be absurd.
   */
  app.post('/admin/api/group/alias', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const phone = s(b.phone).replace(/\D/g, '').slice(-10);
    const name = s(b.name);
    const clear = s(b.action) === 'clear';
    if (phone.length !== 10) return res.status(400).json({ ok: false, message: 'Which customer?' });
    try {
      if (clear) {
        const m = await aliases(query);
        for (const [k, p] of m) if (p === phone) await saveAlias(query, k, '');
        await query('UPDATE wa_group_members SET missing_at = ?, seen_by = ? WHERE phone_norm = ?', [sqlNow(now()), 'name', phone])
          .catch(async (e) => { if (/Unknown column .*seen_by/i.test(String(e && e.message))) await query('UPDATE wa_group_members SET missing_at = ? WHERE phone_norm = ?', [sqlNow(now()), phone]); else throw e; });
        audit.record(req, { action: 'group.alias.clear', entity: 'customer', id: phone, summary: '👥 no longer treated as being in the group under another name' });
        return res.json(await overview(query, now()));
      }
      if (!name) return res.status(400).json({ ok: false, message: 'Which name are they in the group under?' });
      await saveAlias(query, nameKey(name), phone);
      // Mark them as in the group NOW: the owner has just read the member list, which is better evidence than
      // anything here. seen_by = name, because that is exactly what this is — a match on a name, not a number.
      const stamp = sqlNow(now());
      const existing = await query('SELECT id FROM wa_group_members WHERE phone_norm = ? LIMIT 1', [phone]);
      try {
        if (existing && existing[0]) await query('UPDATE wa_group_members SET seen_at = ?, seen_by = ?, missing_at = NULL WHERE id = ?', [stamp, 'name', existing[0].id]);
        else await query('INSERT INTO wa_group_members (phone_norm, name, seen_at, seen_by) VALUES (?, ?, ?, ?)', [phone, '', stamp, 'name']);
      } catch (e) {
        if (!/Unknown column .*seen_by/i.test(String(e && e.message))) throw e;
        if (existing && existing[0]) await query('UPDATE wa_group_members SET seen_at = ?, missing_at = NULL WHERE id = ?', [stamp, existing[0].id]);
        else await query('INSERT INTO wa_group_members (phone_norm, name, seen_at) VALUES (?, ?, ?)', [phone, '', stamp]);
      }
      audit.record(req, { action: 'group.alias', entity: 'customer', id: phone, summary: '👥 in the group as "' + name + '"', details: { phone, name } });
      res.json(await overview(query, now()));
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/group/member', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const id = n(b.id, 0);
    if (!id) return res.status(400).json({ ok: false, message: 'Which row?' });
    try {
      if (s(b.action) === 'forget') {
        await query('DELETE FROM wa_group_members WHERE id = ? LIMIT 1', [id]);
        audit.record(req, { action: 'group.forget', entity: 'settings', id: 'wa_group', summary: 'forgot one group row' });
      } else {
        await query('UPDATE wa_group_members SET note = ? WHERE id = ? LIMIT 1', [s(b.note).slice(0, 200), id]);
      }
      res.json(Object.assign({ ok: true }, await overview(query, now())));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, claim, nudgeText, nudgeEmail, _internal: { phonesIn, parseList, nameEvent, nameKey, matchNames, customerNames, overview, reconcile, applyList, groupServices, stateOf, daysLeft, prettyDate, sqlNow, groupLinkFor, waUrl, firstName, aliases, saveAlias, LAST_KEY, ALIAS_KEY, GROUP_LINK_RE } };
