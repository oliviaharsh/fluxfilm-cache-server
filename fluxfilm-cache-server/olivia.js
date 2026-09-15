/**
 * FluxFilm - OLIVIA, the AI store manager (chat on the website). "The decision is code, the words are the model."
 *
 * This file DECIDES: which step the chat is on, which buttons are allowed, which plan, whether payment arrived, what to
 * deliver. It only calls the website's own functions (oliviatools.js). oliviawords.js turns each decision into words.
 *
 * Public (server.js /api):
 *   status(phone)            → { ok, enabled, whatsappLink }       Help button: show "Chat with Olivia" or go to WhatsApp
 *   handle(phone, input)     → { ok, conversationId, lang, step, messages:[…], poll? }
 *     input = { conversationId?, choice?, text?, lang?, installedApp? }
 *     choice 'start' opens a chat; 'poll' is the widget's silent payment check.
 * Admin (adminolivia.js): getSettings / saveSettings / recent.
 *
 * Owner rules (15 Sep 2026): logged-in customers only (phone must be a FluxFilm customer); a login is shown in the chat only
 * inside the installed app, otherwise it is emailed (the usual email is always sent by fulfilment); language picker, default
 * English, Hinglish suggested; off by default; "test only for these phones" mode.
 * A login is only ever shown for the order created in THIS conversation, never for older subscriptions.
 * Login details are never stored in olivia_messages and never go to the model.
 *
 * Needs db/schema-v21.sql (olivia_conversations, olivia_messages). Before it is run Olivia reports disabled.
 */
const crypto = require('crypto');
const db = require('./db');
const words = require('./oliviawords');

const KEY = 'olivia';
const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
const WA_DEFAULT = 'https://wa.me/message/UWTAS2ZMVF4QJ1';

const DEFAULTS = Object.freeze({ enabled: false, testOnly: true, testPhones: '', aiWords: true, whatsappLink: WA_DEFAULT, voice: '', knowledge: '' });

let deps = { tools: null, words, now: () => new Date() };
function tools() { return deps.tools || (deps.tools = require('./oliviatools').make()); }

// ── settings (app_settings 'olivia') ──
function phoneList(v) { return [...new Set(String(v || '').split(/[\s,;]+/).map(norm).filter((x) => x.length === 10))]; }
function validateSettings(input, prev) {
  const inb = input || {}; const errors = [];
  const out = Object.assign({}, DEFAULTS, prev || {});
  const bool = (v) => v === true || v === 1 || s(v).toLowerCase() === 'true';
  if (inb.enabled !== undefined) out.enabled = bool(inb.enabled);
  if (inb.testOnly !== undefined) out.testOnly = bool(inb.testOnly);
  if (inb.aiWords !== undefined) out.aiWords = bool(inb.aiWords);
  if (inb.testPhones !== undefined) out.testPhones = phoneList(inb.testPhones).join(', ');
  if (inb.whatsappLink !== undefined) {
    const l = s(inb.whatsappLink);
    if (l && !/^https:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\//i.test(l)) errors.push('WhatsApp link must start with https://wa.me/ (or api.whatsapp.com).');
    else out.whatsappLink = l || WA_DEFAULT;
  }
  if (inb.voice !== undefined) {
    const v = s(inb.voice).replace(/[<>]/g, '');
    if (v.length > 2000) errors.push('Voice guide must be 2000 characters or less.');
    else out.voice = v;
  }
  if (inb.knowledge !== undefined) {
    const k = s(inb.knowledge).replace(/[<>]/g, '');
    if (k.length > 4000) errors.push('Knowledge must be 4000 characters or less.');
    else out.knowledge = k;
  }
  if (out.enabled && out.testOnly && !phoneList(out.testPhones).length) errors.push('Test mode is on: add at least one test phone number (10 digits), or turn test mode off.');
  return { ok: !errors.length, settings: out, errors };
}
let cache = null; let cacheAt = 0;
async function getSettings(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 10e3) return cache;
  let saved = {};
  try {
    const rows = await db.query('SELECT value FROM app_settings WHERE setting_key = ? LIMIT 1', [KEY]);
    if (rows.length) { try { saved = JSON.parse(rows[0].value) || {}; } catch (_) { saved = {}; } }
  } catch (e) { if (!missingTable(e)) throw e; }
  cache = Object.assign({}, DEFAULTS, saved); cacheAt = Date.now();
  return cache;
}
async function saveSettings(input) {
  const before = await getSettings(true);
  const v = validateSettings(input, before);
  if (!v.ok) return { ok: false, message: v.errors.join(' '), errors: v.errors };
  await db.query('INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [KEY, JSON.stringify(v.settings)]);
  cache = null;
  const changed = Object.keys(DEFAULTS).filter((k) => String(before[k]) !== String(v.settings[k]));
  return { ok: true, settings: v.settings, before, changed };
}

let schemaOk = null; let schemaAt = 0;
async function schemaReady() {
  if (schemaOk === true || (schemaOk === false && Date.now() - schemaAt < 60e3)) return schemaOk;
  try { await db.query('SELECT id FROM olivia_conversations LIMIT 1', []); schemaOk = true; }
  catch (e) { if (!missingTable(e)) throw e; schemaOk = false; }
  schemaAt = Date.now();
  return schemaOk;
}

async function allowedFor(phone) {
  const ph = norm(phone);
  if (ph.length !== 10) return { ok: false };
  const st = await getSettings();
  if (!st.enabled) return { ok: false, settings: st };
  if (st.testOnly && !phoneList(st.testPhones).includes(ph)) return { ok: false, settings: st };
  if (!(await schemaReady())) return { ok: false, settings: st };
  return { ok: true, settings: st, phone: ph };
}

async function status(phone) {
  let a;
  try { a = await allowedFor(phone); } catch (e) { console.log('[olivia] status failed:', e.message); a = { ok: false }; }
  const link = (a.settings && a.settings.whatsappLink) || WA_DEFAULT;
  if (!a.ok) return { ok: true, enabled: false, whatsappLink: link };
  const prof = await tools().profile(a.phone).catch(() => ({ ok: false }));
  return { ok: true, enabled: !!prof.ok, whatsappLink: link };
}

// ── catalogue helpers (pure) ──
const variantOf = (plan) => (/sharing|shared/i.test(plan) ? 'sharing' : /private/i.test(plan) ? 'private' : '');
const devicesOf = (plan) => Number((String(plan).match(/(\d+)\s*device/i) || [])[1]) || 1;
const SUPPORTED_EXTRA = new Set(['PRIME_DEVICE_TYPE', 'YT_EMAIL']);
/** Plans Olivia sells in chat. 2+ device plans (same/separate logins, extra choices) stay on the website. Group Offer plans are
 * sold like the website sells them: the customer is asked to join the WhatsApp group first. */
function chatPlans(plans) {
  return (plans || []).filter((p) => p && p.service && p.plan && !p.loginChoice && devicesOf(p.plan) === 1);
}
function servicesOf(plans) { return [...new Set(chatPlans(plans).map((p) => p.service))]; }
function needsVariant(plans, service) {
  const v = new Set(chatPlans(plans).filter((p) => p.service === service).map((p) => variantOf(p.plan)));
  return v.has('sharing') && v.has('private');
}
function optionsFor(plans, service, variant) {
  return chatPlans(plans).filter((p) => p.service === service && (!variant || variantOf(p.plan) === variant))
    .sort((a, b) => a.durationDays - b.durationDays || a.price - b.price);
}
const stockOf = (stock, p) => ((stock || {})[p.service + '|||' + p.plan] || {}).stockLevel || 'OK';
function titleOf(p, lang) {
  const v = variantOf(p.plan);
  return p.service + (v ? ' ' + (v === 'sharing' ? 'Sharing' : 'Private') : '') + ' ' + words.durationLabel(p.durationDays, lang);
}

// ── understanding free text (deterministic first) ──
const SERVICE_WORDS = [
  [/netflix|netflik|netfix|netflx|netlix|nteflix|\bnflx\b|\bnf\b|नेटफ्लिक्स/i, /^netflix$/i], [/prime|amazon|amzn|प्राइम/i, /^prime video$/i], [/hot\s?star|jio|हॉटस्टार/i, /hotstar/i],
  [/sony|soni\s?liv/i, /sony/i], [/zee|ze5/i, /zee/i], [/crunch|anime/i, /crunchy/i], [/you\s?tube|\byt\b|यूट्यूब/i, /youtube/i],
];
// Typos older customers make ("netfilx", "hotsar", "youtub"): a word within 2 letters of a service name counts.
const SERVICE_TYPO_WORDS = [['netflix', /^netflix$/i], ['amazon', /^prime video$/i], ['hotstar', /hotstar/i], ['jiohotstar', /hotstar/i], ['sonyliv', /sony/i], ['crunchyroll', /crunchy/i], ['youtube', /youtube/i]];
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function typoService(t) {
  for (const w of String(t).toLowerCase().match(/[a-z]{4,}/g) || []) {
    for (const [name, svc] of SERVICE_TYPO_WORDS) {
      if (editDistance(w, name) <= (name.length <= 5 ? 1 : 2)) return svc;
    }
  }
  return null;
}
function entities(text, plans) {
  const t = String(text || '').toLowerCase();
  const e = {};
  const services = servicesOf(plans);
  const typo = typoService(t);
  for (const [word, svc] of SERVICE_WORDS.concat(typo ? [[{ test: () => true }, typo]] : [])) {
    if (!word.test(t)) continue;
    const wantGroup = /group/.test(t);
    const hits = services.filter((x) => svc.test(x) || word.test(x));
    const hit = (wantGroup && hits.find((x) => isGroupService(plans, x))) || services.find((x) => svc.test(x)) || hits[0];
    if (hit) { e.service = hit; break; }
  }
  if (/\bshar|sharing|शेयर/.test(t)) e.variant = 'sharing';
  else if (/privat|personal|alag|प्राइवेट/.test(t)) e.variant = 'private';
  let m = t.match(/(\d{1,2})\s*(months?|mahin[ae]|mhine|mahine|m\b|महीन)/);
  if (m) e.days = Number(m[1]) * 30;
  else if (/(\d)?\s*(years?|saal|sal\b|yr|साल)/.test(t)) { m = t.match(/(\d)\s*(years?|saal|sal\b|yr|साल)/); e.days = (m ? Number(m[1]) : 1) * 365; }
  else if (/\bek mahin|one month|monthly/.test(t)) e.days = 30;
  return e;
}
/** Things a customer can ask at ANY moment, even in the middle of paying. Checked before the step's own answers. */
function globalIntentOf(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(in )?(english|hinglish|hindi|हिंदी)( (me|mein|please|pls|main))?( (baat|bolo|batao|karo))*$/.test(t)) return 'lang:' + (/hinglish/.test(t) ? 'hinglish' : /hindi|हिंदी/.test(t) ? 'hi' : 'en');
  if (/coupon|cupon|coupan|promo|voucher|discount code|offer code|\bcode\b.*(apply|lagao|lagana|use|dalna|daalna|hai)|(apply|use|lagao|lagana).*\bcode\b/.test(t)) return 'coupon';
  if (/(change|badal|badlo|dusra|doosra|another|different|wrong|galat).{0,12}(plan|pack)|cancel|nahi chahiye|don'?t want/.test(t)) return 'change';
  if (/renew|रिन्यू/.test(t)) return 'renew';
  if (/cheap|sasta|saste|kam (kar|price|daam)|discount|less price|best price|mehnga|mahanga|expensive|costly|earlier|pehle|before|last time|pichli baar|group offer|₹\s?\d+|\brs\.?\s?\d+|\d+\s?(rs|rupees|rupay)\b|kitne ka|kitna (hai|lagega)|price|rate|daam/.test(t)) return 'price';
  if (/\b(for|at|in|mein|me|mai|ka|ki|only|sirf|just)\s+\d{2,4}\b(?!\s*(months?|mahin|din|days?|years?|saal|device))/.test(t) || /\b\d{2,4}\s*(rs|rupees?|rupay|inr|ka|ki|mein|me|mai)\b/.test(t) || (/\b(bought|buy|liya|kharida|paid|mila)\b/.test(t) && /\b\d{2,4}\b(?!\s*(months?|mahin|din|days?|years?|saal|device))/.test(t))) return 'price';
  if (/\b(password|pasword|passwrd|passwod|pass|login|log in|id pass|sign in)\b|पासवर्ड|लॉगिन/.test(t) && /bhul|bhool|forgot|forget|yaad nahi|nahi mil|nhi mil|not (working|opening)|wrong|galat|incorrect|chahiye|chaiye|\bdo\b|de do|dedo|send|bhejo|kya hai|kaha|kahan|nahi chal|nhi chal|kaam nahi|khul nahi|reset|new|naya|nahi ho|nhi ho|not able|can.?t|भूल|नहीं/.test(t)) return 'login';
  if (/household|house hold|tv code|not part of|घर/.test(t)) return 'household';
  // Buying questions the team answers every day on WhatsApp (training run 1): when the login comes, how to pay, TV.
  if (/\b(login|log in|id|id pass(word)?|password|details|credentials?)\b.{0,25}\b(kab|when|kitni der|kitne (der|time|min))\b|\b(kab|when|how (long|soon|fast)|kitni der)\b.{0,25}\b(login|id|password|details|credentials?)\b|लॉगिन कब/.test(t)) return 'whenlogin';
  if (!/nahi|nhi|not|fail|error|problem|issue|kat gay|deduct/.test(t) && (/\b(gpay|g pay|google ?pay|phone ?pe|paytm|bhim|upi|scanner)\b.{0,25}(chalega|chalta|hoga|ho jayega|accept|works?|le lete|lete ho|\?)|\b(payment|pay)\b.{0,20}\b(kaise|how|method|mode|options?|kis se|kisse)\b|\b(credit|debit) card\b|\bcard se\b|net ?banking/.test(t))) return 'paymethod';
  if (/\b(tv|t\.v|television|smart ?tv|fire ?stick|firestick)\b|टीवी/.test(t) && (QUESTION_RE.test(t) || /chal(ega|egi|ta|ti| jayega| jaega)|hoga|ho jayega|work|support|dekh sakte|login ho|चलेगा|चलता/.test(t))) return 'tv';
  if (/human|agent|real person|call me|whatsapp|talk to|baat karni|baat karo|team se/.test(t)) return 'other';
  return '';
}
function intentOf(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(hi+|hello+|hey+|hlo|helo|namaste|namaskar|नमस्ते|good (morning|afternoon|evening))\b/.test(t) && t.length < 30) return 'menu';
  if (/(can.?t|cannot|unable to|not able to) pay|payment (not|nahi|nhi) (working|ho|going)|nahi ho raha|nhi ho rha|failed|limit|error/.test(t)) return 'cantpay';
  if (/\b(paid|done)\b|ho gaya|hogaya|ho gya|kar diya|kr diya|bhej diya|payment (kar|kr) (di|diya)|pay kar diya/.test(t)) return 'paid';
  if (/differen|\bfark|farak|antar|फ़र्क|फर्क/.test(t)) return 'diff';
  if (/^(main )?menu$|start over|restart|shuru se/.test(t)) return 'menu';
  if (/^(yes|yeah|yup|haan|ha|han|haa|ok|okay|theek|thik|sure|ji)\b/.test(t)) return 'yes';
  if (/^(no|nahi|nahin|nhi|na)\b/.test(t)) return 'no';
  if (/\b(buy|chahiye|chaiye|want|lena|leni|kharidna|kharidni)\b|\bpurchase (a|karna|krna)/.test(t)) return 'buy';
  return '';
}
const NOT_A_CODE = new Set(['code', 'coupon', 'promo', 'apply', 'use', 'lagao', 'lagana', 'hai', 'have', 'want', 'the', 'this', 'mera', 'mere', 'pass', 'please', 'plz', 'pls', 'voucher', 'discount', 'offer', 'is', 'my', 'and', 'with', 'wala', 'dalna', 'daalna', 'karna', 'krna', 'to']);
/** "use coupon FLUX50" / "code hai NEW10" → "FLUX50". Only a word right after coupon/code/promo, or a lone code-looking word. */
function couponCodeIn(text, awaiting) {
  const raw = String(text || '').trim();
  const m = raw.match(/(?:coupon|cupon|coupan|promo|voucher|code)\s*(?:code)?\s*(?:is|hai|:|-|=)?\s*([A-Za-z0-9][A-Za-z0-9_-]{2,19})\b/i);
  if (m && !NOT_A_CODE.has(m[1].toLowerCase())) return m[1].toUpperCase();
  if (awaiting && /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/.test(raw) && !NOT_A_CODE.has(raw.toLowerCase())) return raw.toUpperCase();
  return '';
}
function couponReason(message) {
  const m = String(message || '').toLowerCase();
  if (/expired/.test(m)) return 'expired';
  if (/not active|invalid/.test(m)) return 'invalid';
  if (/minimum/.test(m)) return 'minimum';
  if (/first-time/.test(m)) return 'firsttime';
  if (/limit|fully redeemed/.test(m)) return 'used';
  if (/number/.test(m)) return 'number';
  if (/service|plan|purchase|renewal/.test(m)) return 'plan';
  return 'invalid';
}
/** "99 wala chahiye" → the chat plans that cost exactly ₹99 (a number that is not a duration / device count). */
function plansByPrice(text, plans) {
  const nums = [...String(text || '').toLowerCase().matchAll(/(?:₹|rs\.?\s*)?\b(\d{2,5})\b(?!\s*(months?|mahin|din|days?|years?|saal|device|screen|%|gb))/g)].map((m) => Number(m[1]));
  if (!nums.length) return [];
  return chatPlans(plans).filter((p) => nums.includes(Math.round(Number(p.price))));
}
/** While choosing Netflix, \"99 wala\" means the Netflix ₹99 plan even if another service also costs ₹99. */
function narrowToFamily(list, st) {
  const cur = st.service || (st.plan && st.plan.service) || '';
  const fam = cur ? list.filter((p) => familyOf(p.service) === familyOf(cur)) : [];
  return fam.length ? fam : list;
}
const PICK_WORDS_RE = /wala|wali|wale|chahiye|chaiye|de do|dedo|dijiye|want|give me|lena|leni|that one|ye wala|yahi|le lo|lelo/i; // not "buy it for 99": that is about an old price
const familyOf = (service) => String(service || '').toLowerCase().split(' (')[0].trim();
// Words that only appear when someone writes Hindi in English letters (ambiguous ones like "to", "me", "do" are left out).
const HINGLISH_WORDS = new Set(['hai', 'hain', 'kya', 'nahi', 'nhi', 'nahin', 'chahiye', 'chaiye', 'chahie', 'mujhe', 'muje', 'aap', 'aapka', 'karo', 'kardo', 'krdo', 'dedo', 'wala', 'wali', 'wale', 'kaise', 'kitna', 'kitne', 'mein', 'mai', 'bhai', 'haan', 'ji', 'gaya', 'gya', 'raha', 'rha', 'rahi', 'batao', 'bataiye', 'dikhao', 'kyun', 'kyu', 'lena', 'bhi', 'toh', 'yeh', 'woh', 'abhi', 'accha', 'achha', 'acha', 'theek', 'thik', 'konsa', 'kaunsa', 'liya', 'kiya', 'hoon', 'hu', 'kab', 'kaha', 'kahan', 'paise', 'lagega', 'milega', 'chalega', 'bolo', 'samjha', 'samajh', 'krna', 'karna', 'hota', 'hoga', 'pehle', 'baad', 'sirf', 'sab', 'kuch', 'koi', 'apna', 'mera', 'meri', 'humko', 'hume', 'hamara', 'jaldi', 'kaisa', 'dijiye', 'kijiye', 'ruko']);
const ENGLISH_WORDS = new Set(['i', 'want', 'need', 'please', 'the', 'is', 'what', 'how', 'my', 'you', 'can', 'which', 'why', 'where', 'give', 'show', 'help', 'price', 'plan', 'thanks', 'thank', 'are', 'have', 'does', 'will', 'buy', 'bought', 'not', 'working', 'with', 'for', 'this', 'that', 'it', 'and', 'or', 'a', 'an']);
/** 'hi' for Devanagari, 'hinglish' / 'en' when the words make it clear, '' when unsure (then the language stays). */
function detectLang(text) {
  const t = String(text || '');
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  const w = t.toLowerCase().match(/[a-z]+/g) || [];
  if (!w.length) return '';
  const hing = w.filter((x) => HINGLISH_WORDS.has(x)).length;
  const eng = w.filter((x) => ENGLISH_WORDS.has(x)).length;
  if (hing >= 2 || (hing >= 1 && hing >= eng)) return 'hinglish';
  if (eng >= 2 && hing === 0) return 'en';
  return '';
}
const QUESTION_RE = /\?\s*$|^(does|do|is|are|can|will|how|what|why|when|which|kya|kaise|kyun|kyu|kab|kitna)\b/i;
const PLAIN_PRICE_RE = /kitne ka|kitne ki|kitna (hai|lagega|padega|hoga)|kitne (rupay|rupaye|paise)|\bprice\b|\brate\b|\bdaam\b|\bcost\b|how much|कितने का|कीमत/i;
const NOT_PLAIN_PRICE_RE = /cheap|sasta|saste|discount|\bkam\b|mehnga|mahanga|expensive|costly|earlier|pehle|before|last time|pichli|group|offer|\d/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
const GROUP_LINK_RE = /^https:\/\/(chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com)\/[\w?=&%./-]+$/i;
const GROUP_FALLBACK = 'https://chat.whatsapp.com/IY67tbIr0zj0WfTFyYp3eB';
const MAX_COUPON_TRIES = 5;

// ── conversation storage ──
const fmt = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
async function loadConv(id, phone) {
  if (!/^[a-f0-9]{32}$/.test(s(id))) return null;
  const rows = await db.query('SELECT id, phone_norm, lang, step, state_json, status, turns, ai_calls, ai_tokens FROM olivia_conversations WHERE id = ? LIMIT 1', [id]);
  const r = rows[0];
  if (!r || r.phone_norm !== phone) return null;
  let state = {}; try { state = JSON.parse(r.state_json || '{}') || {}; } catch (_) { state = {}; }
  return { id: r.id, phone, lang: r.lang || '', state, status: r.status, turns: Number(r.turns) || 0, aiCalls: Number(r.ai_calls) || 0, aiTokens: Number(r.ai_tokens) || 0, isNew: false };
}
async function saveConv(c) {
  const now = fmt(deps.now());
  const st = c.state || {};
  if (c.isNew) {
    await db.query("INSERT INTO olivia_conversations (id, phone_norm, lang, step, state_json, status, order_id, turns, ai_calls, ai_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [c.id, c.phone, c.lang || '', st.step || '', JSON.stringify(st), c.status || 'OPEN', st.orderId || st.lastOrderId || null, c.turns, c.aiCalls, c.aiTokens, now, now]);
    c.isNew = false;
  } else {
    await db.query('UPDATE olivia_conversations SET lang = ?, step = ?, state_json = ?, status = ?, order_id = ?, turns = ?, ai_calls = ?, ai_tokens = ?, updated_at = ? WHERE id = ?',
      [c.lang || '', st.step || '', JSON.stringify(st), c.status || 'OPEN', st.orderId || st.lastOrderId || null, c.turns, c.aiCalls, c.aiTokens, now, c.id]);
  }
}
async function logMsg(convId, role, intent, body, meta, ai) {
  try {
    await db.query('INSERT INTO olivia_messages (conversation_id, role, intent, body, meta_json, ai, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [convId, role, intent || '', String(body || '').slice(0, 2000), meta ? JSON.stringify(meta).slice(0, 2000) : null, ai ? 1 : 0, fmt(deps.now())]);
  } catch (e) { console.log('[olivia] message log failed:', e.message); }
}

// ── the decision: one turn ──
function btn(id, lang, label) { return { id, label: label || words.buttonLabel(id, lang) }; }
function urlBtn(id, lang, url) { return { id, label: words.buttonLabel(id, lang), url }; }
const LINK_BUTTONS = { whatsapp: 'whatsapp', helper: 'helper', myplans: 'myplans', buysite: 'buysite' };
/** "2 devices", "3 screens", "do phone" → 2. 0 when the customer did not ask for more than one device. */
function devicesWanted(text) {
  const DEV = '(devices?|dvices?|screens?|phones?|mobiles?|logins?|log ins?|डिवाइस|स्क्रीन|फ़ोन|फोन|मोबाइल)';
  const num = (re, d) => (x) => x.replace(new RegExp('(^|[^a-z\\u0900-\\u097F])(' + re + ')(?=\\s*' + DEV + ')', 'g'), (_, pre) => pre + d);
  const t = num('teen|three|तीन', '3')(num('do|two|दो', '2')(String(text || '').toLowerCase()));
  const m = t.match(new RegExp('(?:^|[^\\d])([2-9])\\s*' + DEV + '(?![a-z])'));
  return m ? Number(m[1]) : 0;
}
/** Every plan of this exact service with at least n devices (sold-out ones too; the caller checks stock). */
function devicePlansOf(plans, service, n) {
  return (plans || []).filter((p) => p && p.service === service && p.plan && devicesOf(p.plan) >= n)
    .sort((a, b) => devicesOf(a.plan) - devicesOf(b.plan) || (Number(a.durationDays) || 0) - (Number(b.durationDays) || 0) || a.price - b.price);
}
/** Services that really sell a plan with at least n devices (in stock), in catalogue order. */
function deviceServicesOf(cat, n) {
  return [...new Set((cat.plans || []).filter((p) => p && p.service && p.plan && devicesOf(p.plan) >= n && stockOf(cat.stock, p) !== 'OUT').map((p) => p.service))];
}
/** A service's own device rule (admin → plan → device rule), first line only. '' when the plan has none. */
function deviceRuleOf(plans, service, variant) {
  const list = (plans || []).filter((p) => p && p.service === service && devicesOf(p.plan) === 1 && s(p.deviceRuleText));
  const p = list.find((x) => !variant || variantOf(x.plan) === variant) || list[0];
  return p ? s(p.deviceRuleText).split(/\r?\n/)[0].trim().slice(0, 160) : '';
}
/**
 * "2 devices ke liye chahiye" — the way the team sells it on WhatsApp: say yes warmly, ask the ONE missing choice
 * (which service → Sharing or Private), then show the real N-device plans with live prices. Never invents a plan:
 * when a service has none, its own device rule is quoted and the 1-device plans are offered.
 * 2+ device plans are still bought on the Buy page (same/separate logins, TV slots are chosen there).
 */
function devicesReplies(st, ctx, lang) {
  const n = st.devices;
  const plans = ctx.cat.plans || [];
  if (!st.service) {
    const svcs = deviceServicesOf(ctx.cat, n);
    if (!svcs.length) { delete st.devices; return [{ intent: 'MULTI_DEVICE_NONE', facts: { n, service: '', max: 0, rule: '' } }].concat(advance(st, ctx.cat, lang, ctx.profile)); }
    st.step = 'devices_service'; st.deviceServices = svcs;
    return [{ intent: 'ASK_SERVICE_FOR_DEVICES', facts: { n }, buttons: svcs.map((x, i) => btn('dsvc:' + i, lang, serviceLabel(plans, x))).concat([btn('menu', lang)]) }];
  }
  const all = devicePlansOf(plans, st.service, n);
  if (!all.length) {
    const max = Math.max(1, ...plans.filter((p) => p && p.service === st.service && p.plan).map((p) => devicesOf(p.plan)));
    const svc = st.service;
    const rule = deviceRuleOf(plans, svc, st.variant);
    st.step = 'devices_none'; st.plan = null;
    const b = (max >= 2 ? [btn('dmax:' + max, lang, '📱 ' + words.devicesLabel(max, lang))] : []).concat([btn('d1', lang), btn('menu', lang)]);
    return [{ intent: 'MULTI_DEVICE_NONE', facts: { n, service: svc, max: max >= 2 ? max : 0, rule: /device|screen/i.test(rule) ? rule : '' }, buttons: b }];
  }
  const variants = new Set(all.map((p) => variantOf(p.plan)));
  const variant = st.variant && variants.has(st.variant) ? st.variant : '';
  if (!variant && variants.has('sharing') && variants.has('private')) {
    st.step = 'devices_variant';
    return [{ intent: 'ASK_DEVICES_SHARING_OR_PRIVATE', facts: { n, service: st.service }, buttons: [btn('dvar:sharing', lang), btn('dvar:private', lang), btn('ddiff', lang), btn('menu', lang)] }];
  }
  const list = all.filter((p) => !variant || variantOf(p.plan) === variant);
  const inStock = list.filter((p) => stockOf(ctx.cat.stock, p) !== 'OUT');
  const title = st.service + (variant ? ' ' + variantLabel(variant) : '');
  st.step = 'devices_list';
  if (!inStock.length) return [{ intent: 'OUT_OF_STOCK', facts: { title: title + ' (' + words.devicesLabel(n, lang) + ')' }, buttons: [btn('d1', lang), btn('menu', lang), btn('whatsapp', lang)] }];
  const go = Object.assign(btn('buysite', lang), { service: st.service });
  return [{
    intent: 'MULTI_DEVICE_ON_WEBSITE',
    facts: { n, title, group: isGroupService(plans, st.service), items: inStock.slice(0, 5).map((p) => words.durationLabel(p.durationDays, lang) + ' · ' + words.devicesLabel(devicesOf(p.plan), lang) + ' · ' + words.rupees(p.price)) },
    buttons: [go, btn('d1', lang), btn('menu', lang)],
  }];
}
const DEVICE_STEPS = new Set(['devices_service', 'devices_variant', 'devices_list', 'devices_none']);
const isGroupService = (plans, service) => (plans || []).some((p) => p.service === service && p.requiresGroupJoin);
function groupLinkOf(plans, service) {
  const p = (plans || []).find((x) => x.service === service && x.requiresGroupJoin && GROUP_LINK_RE.test(s(x.groupJoinLink)));
  return p ? s(p.groupJoinLink) : GROUP_FALLBACK;
}
const variantLabel = (v) => (v === 'sharing' ? 'Sharing' : v === 'private' ? 'Private' : '');
function serviceLabel(plans, service) { return isGroupService(plans, service) ? service + ' 👥' : service; }
/** The same plan in the other offer (normal ↔ group): same kind (sharing/private) and same length. */
function twinPlan(plans, p, wantGroup) {
  return chatPlans(plans).find((x) => !!x.requiresGroupJoin === wantGroup && x.service !== p.service && x.service.toLowerCase().startsWith(p.service.toLowerCase().split(' (')[0])
    && variantOf(x.plan) === variantOf(p.plan) && Math.abs(x.durationDays - p.durationDays) <= 5) || null;
}
const currentPlan = (st, cat) => (st.plan ? cat.plans.find((x) => x.service === st.plan.service && x.plan === st.plan.plan) : null);

/** Moves the purchase forward as far as the known slots allow. Returns replies and sets state.step. */
function advance(st, cat, lang, profile) {
  const out = [];
  const services = servicesOf(cat.plans);
  st.services = services;
  if (!st.service || !services.includes(st.service)) {
    st.service = ''; st.step = 'service';
    out.push({ intent: 'ASK_SERVICE', buttons: services.map((x, i) => btn('service:' + i, lang, serviceLabel(cat.plans, x))).concat([btn('menu', lang)]) });
    return out;
  }
  if (isGroupService(cat.plans, st.service) && !st.groupJoined) {
    st.step = 'group';
    const gp = st.plan && cat.plans.find((x) => x.service === st.plan.service && x.plan === st.plan.plan);
    const normal = gp && twinPlan(cat.plans, gp, false);
    out.push({ intent: 'GROUP_JOIN', facts: { service: st.service, title: gp ? titleOf(gp, lang) : '', price: gp ? gp.price : 0, normalPrice: normal && normal.price > gp.price ? normal.price : 0 },
      buttons: [urlBtn('groupjoin', lang, groupLinkOf(cat.plans, st.service)), btn('joined', lang)].concat(normal ? [btn('normal', lang, words.buttonLabel('normal', lang) + ' · ' + words.rupees(normal.price))] : [btn('change', lang)]) });
    if (normal) st.twin = { service: normal.service, plan: normal.plan };
    return out;
  }
  if (needsVariant(cat.plans, st.service) && !st.variant) {
    st.step = 'variant';
    out.push({ intent: 'ASK_SHARING_OR_PRIVATE', facts: { service: st.service }, buttons: [btn('variant:sharing', lang), btn('variant:private', lang), btn('diff', lang), btn('menu', lang)] });
    return out;
  }
  const opts = optionsFor(cat.plans, st.service, needsVariant(cat.plans, st.service) ? st.variant : '');
  let chosen = st.plan && opts.find((p) => p.plan === st.plan.plan);
  if (!chosen && st.days) {
    const hits = opts.filter((p) => Math.abs(p.durationDays - st.days) <= 5);
    if (hits.length === 1) chosen = hits[0];
  }
  if (chosen && stockOf(cat.stock, chosen) === 'OUT') {
    out.push({ intent: 'OUT_OF_STOCK', facts: { title: titleOf(chosen, lang) } });
    chosen = null; st.plan = null; st.days = 0;
  }
  if (!chosen) {
    st.plan = null; st.step = 'duration'; delete st.coupon;
    st.options = opts.map((p) => ({ service: p.service, plan: p.plan }));
    const title = st.service + (st.variant ? ' ' + variantLabel(st.variant) : '');
    out.push({
      intent: 'ASK_DURATION', facts: { title },
      buttons: opts.map((p, i) => btn('plan:' + i, lang, words.durationLabel(p.durationDays, lang) + ' · ' + words.rupees(p.price) + (stockOf(cat.stock, p) === 'OUT' ? ' (sold out)' : '')))
        .concat([btn('change', lang), btn('menu', lang)]),
    });
    return out;
  }
  if (st.coupon && (st.coupon.service !== chosen.service || st.coupon.plan !== chosen.plan)) delete st.coupon; // a coupon is checked for one plan
  st.plan = { service: chosen.service, plan: chosen.plan };
  st.title = titleOf(chosen, 'en');
  const key = s(chosen.extraFieldKey).toUpperCase();
  if (chosen.needsExtraField && !SUPPORTED_EXTRA.has(key)) {
    st.step = 'website';
    out.push({ intent: 'FINISH_ON_WEBSITE', facts: { title: titleOf(chosen, lang) }, buttons: [btn('change', lang), btn('menu', lang)] });
    return out;
  }
  if (chosen.needsExtraField && key === 'PRIME_DEVICE_TYPE' && !st.extraValue) {
    st.step = 'tv';
    out.push({ intent: 'ASK_TV', buttons: [btn('tv:yes', lang), btn('tv:no', lang), btn('change', lang)] });
    return out;
  }
  if (chosen.needsExtraField && key === 'YT_EMAIL' && !st.extraValue) {
    st.step = 'extra_email';
    out.push({ intent: 'ASK_EXTRA_EMAIL', facts: { label: s(chosen.extraFieldLabel) }, input: 'email', buttons: [btn('change', lang), btn('menu', lang)] });
    return out;
  }
  if (!st.email && !(profile && EMAIL_RE.test(profile.email))) {
    st.step = 'own_email';
    out.push({ intent: 'ASK_OWN_EMAIL', input: 'email', buttons: [btn('menu', lang)] });
    return out;
  }
  st.step = 'confirm';
  st.price = chosen.price;
  if (st.coupon) {
    out.push({ intent: 'CONFIRM_PLAN_COUPON', facts: { title: titleOf(chosen, lang), price: chosen.price, code: st.coupon.code, discount: st.coupon.discount, final: st.coupon.finalAmount }, buttons: [btn('pay', lang), btn('nocoupon', lang), btn('change', lang)] });
  } else {
    out.push({ intent: 'CONFIRM_PLAN', facts: { title: titleOf(chosen, lang), price: chosen.price }, buttons: [btn('pay', lang), btn('coupon', lang), btn('change', lang), btn('menu', lang)] });
  }
  return out;
}

function menuReply(st, lang, name) {
  st.step = 'menu';
  return { intent: 'GREET_MENU', facts: { name: firstName(name) }, buttons: ['buy', 'renew', 'household', 'other'].map((id) => btn(id, lang)) };
}
const firstName = (n) => s(n).split(/\s+/)[0].replace(/[^\p{L}.'-]/gu, '').slice(0, 20);
function resetPurchase(st) { for (const k of ['service', 'variant', 'days', 'plan', 'extraValue', 'options', 'title', 'price', 'coupon', 'groupJoined', 'flow', 'renew', 'renewSubs', 'renewOptions', 'devices', 'deviceServices']) delete st[k]; }

// Buttons that create, change or cancel an order: only an explicit tap or clear words, never an AI guess.
const MONEY_BUTTONS = new Set(['pay', 'paid', 'change', 'rchange', 'cantpay', 'nocoupon', 'switch', 'twin', 'joined', 'normal']);
const CHOOSING_STEPS = new Set(['service', 'variant', 'duration', 'tv', 'extra_email', 'own_email', 'group', 'confirm', 'coupon', 'renew_pick', 'renew_duration', 'renew_confirm', 'devices_service', 'devices_variant', 'devices_list', 'devices_none']);
const PAY_STEPS = new Set(['paying', 'backup_name', 'backup_review', 'delivering']);
const payButtons = (lang) => [btn('paid', lang), btn('cantpay', lang), btn('coupon', lang), btn('change', lang)];
function payCard(st) {
  return { type: 'pay', orderId: st.orderId, amount: st.amount, upiLink: st.upiLink, qr: 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=' + encodeURIComponent(st.upiLink || '') };
}
/** While a payment is open, side questions keep it: "back to payment" returns to the same QR. */
const withBackToPay = (st, lang, buttons) => (PAY_STEPS.has(st.step) || st.paused ? [btn('backpay', lang)] : []).concat(buttons);

async function deliverReplies(c, ctx) {
  const st = c.state; const lang = c.lang;
  const r = await tools().deliver(st.orderId, c.phone);
  const f = s(r && r.fulfillment).toUpperCase();
  const title = st.title || '';
  ctx.meta.push({ tool: 'deliver', fulfillment: f || 'NONE' });
  delete st.paused;
  if (f === 'PENDING') { st.step = 'delivering'; ctx.poll = 4; return []; }
  // Delivered or handed over: this order is finished in the chat (a new request starts a new order).
  st.lastOrderId = st.orderId; dropOrder(st);
  if (st.flow === 'renew' && st.renew && f === 'FULFILLED') {
    const rn = st.renew; resetPurchase(st);
    st.step = 'done'; c.status = 'DONE';
    const newExpiry = s(r.newExpiryText) || s(rn.quote && rn.quote.newExpiry);
    const a = r.access || {};
    const hasLogin = !!(s(a.user) || s(a.pass) || (Array.isArray(a.logins) && a.logins.length));
    if (!rn.accountChange) return [{ intent: 'RENEW_DONE', facts: { title, newExpiry }, buttons: [btn('menu', lang), btn('whatsapp', lang)] }];
    if (ctx.installedApp && hasLogin && !r.accessWithheld) {
      const logins = Array.isArray(a.logins) && a.logins.length > 1 ? a.logins : [a];
      const card = { type: 'access', title, logins: logins.map((x, i) => ({ device: Number(x.device) || i + 1, user: s(x.user), pass: s(x.pass), profileName: s(x.profileName), profileNumber: s(x.profileNumber), profilePin: s(x.profilePin) })) };
      return [{ intent: 'RENEW_DONE_NEW_LOGIN_IN_CHAT', facts: { title, newExpiry }, card, buttons: [btn('menu', lang), btn('whatsapp', lang)] }];
    }
    return [{ intent: 'RENEW_DONE_NEW_LOGIN_EMAILED', facts: { title, newExpiry }, buttons: [btn('menu', lang), btn('whatsapp', lang)] }];
  }
  const group = isGroupService(ctx.cat.plans, (st.plan || {}).service) ? [urlBtn('groupjoin', lang, groupLinkOf(ctx.cat.plans, st.plan.service))] : [];
  if (f === 'FULFILLED') {
    st.step = 'done'; c.status = 'DONE';
    const a = r.access || {};
    const hasLogin = !!(s(a.user) || s(a.pass) || (Array.isArray(a.logins) && a.logins.length));
    if (ctx.installedApp && hasLogin && !r.accessWithheld) {
      const logins = Array.isArray(a.logins) && a.logins.length > 1 ? a.logins : [a];
      const card = { type: 'access', title, logins: logins.map((x, i) => ({ device: Number(x.device) || i + 1, user: s(x.user), pass: s(x.pass), profileName: s(x.profileName), profileNumber: s(x.profileNumber), profilePin: s(x.profilePin) })), postPaymentMessage: s(r.postPaymentMessage) };
      return [{ intent: 'PAYMENT_RECEIVED_LOGIN_IN_CHAT', facts: { title }, card, buttons: group.concat([btn('menu', lang), btn('whatsapp', lang)]) }];
    }
    return [{ intent: 'PAYMENT_RECEIVED_LOGIN_EMAILED', facts: { title }, buttons: group.concat([btn('menu', lang), btn('whatsapp', lang)]) }];
  }
  if (f === 'MANUAL_PENDING') { st.step = 'done'; c.status = 'DONE'; return [{ intent: 'DELIVERY_BEING_SET_UP', facts: { title }, buttons: [btn('menu', lang), btn('whatsapp', lang)] }]; }
  // NO_STOCK / ERROR after payment: a person must help. The customer's money is safe and the order is PAID.
  st.step = 'handoff'; c.status = 'HANDOFF';
  return [{ intent: 'HANDOFF_TO_HUMAN', buttons: [btn('whatsapp', lang), btn('menu', lang)] }];
}

/** Before changing anything about an open order: if it is already paid, deliver it instead. Returns replies or null. */
async function paidAlready(c, ctx) {
  const st = c.state;
  if (!st.orderId || !PAY_STEPS.has(st.step)) return null;
  const pay = await tools().checkPayment(st.orderId);
  ctx.meta.push({ tool: 'checkPayment', paid: pay.paid, before: 'change' });
  return pay.paid ? deliverReplies(c, ctx) : null;
}
/** Drops the unpaid order from the chat (it simply stays unpaid in the shop, like an abandoned website checkout). */
function dropOrder(st) {
  const had = !!st.orderId;
  for (const k of ['orderId', 'amount', 'upiLink', 'orderAt', 'knownName', 'paused']) delete st[k];
  return had;
}

async function couponReplies(c, ctx, code) {
  const st = c.state; const lang = c.lang;
  if (st.orderId) {
    const done = await paidAlready(c, ctx);
    if (done) return [{ intent: 'COUPON_TOO_LATE' }].concat(done);
  }
  const renewing = st.flow === 'renew' && st.renew;
  const p = renewing ? (st.renew.toPlan ? (ctx.cat.plans || []).find((x) => x.service === st.renew.service && x.plan === st.renew.toPlan) : null) : currentPlan(st, ctx.cat);
  if (!p && renewing) return [{ intent: 'COUPON_PICK_PLAN_FIRST' }].concat(st.renew ? renewDurations(st, ctx, lang) : await renewStart(c, ctx));
  if (!p) {
    if (code) st.pendingCoupon = code;
    return [{ intent: 'COUPON_PICK_PLAN_FIRST' }].concat(advance(st, ctx.cat, lang, ctx.profile));
  }
  if (!code) {
    if (st.orderId) st.paused = true;
    st.step = st.orderId ? st.step : 'coupon';
    st.awaitCoupon = true;
    return [{ intent: 'ASK_COUPON', input: 'coupon', buttons: withBackToPay(st, lang, [btn('nocoupon', lang)]) }];
  }
  st.awaitCoupon = false;
  st.couponTries = (st.couponTries || 0) + 1;
  if (st.couponTries > MAX_COUPON_TRIES) return [{ intent: 'COUPON_TOO_MANY', buttons: withBackToPay(st, lang, [btn('nocoupon', lang), btn('whatsapp', lang)]) }];
  const v = await tools().validateCoupon(c.phone, code, p, renewing ? 'RENEW' : 'NEW');
  ctx.meta.push({ tool: 'validateCoupon', ok: !!(v && v.ok), reason: v && !v.ok ? couponReason(v.message) : '' });
  if (!v || !v.ok) {
    st.awaitCoupon = true;
    return [{ intent: 'COUPON_INVALID', facts: { code, reason: couponReason(v && v.message) }, input: 'coupon', buttons: withBackToPay(st, lang, [btn('nocoupon', lang), btn('whatsapp', lang)]) }];
  }
  // Renewal: a coupon replaces the early-renew discount (the shop never stacks them), so only use it if it saves more.
  if (renewing && st.renew.quote && v.discount <= (st.renew.quote.early || 0)) {
    return [{ intent: 'COUPON_NOT_BETTER', facts: { code: v.code || code, discount: v.discount, early: st.renew.quote.early } }].concat(st.orderId ? [{ intent: 'SEND_PAYMENT', facts: { amount: st.amount }, card: payCard(st), buttons: payButtons(lang) }] : await renewConfirm(c, ctx));
  }
  // A valid coupon on an open, unpaid order: that QR is replaced by a new, cheaper one when they tap Pay.
  const hadOrder = dropOrder(st);
  st.coupon = { code: v.code || code, discount: v.discount, finalAmount: v.finalAmount, service: p.service, plan: p.plan };
  const replies = [{ intent: hadOrder ? 'COUPON_APPLIED_NEW_QR' : 'COUPON_APPLIED', facts: { code: st.coupon.code, discount: v.discount, final: v.finalAmount } }];
  if (renewing) { delete st.paused; return replies.concat(await renewConfirm(c, ctx)); }
  return replies.concat(advance(st, ctx.cat, lang, ctx.profile));
}

function priceReplies(st, ctx, lang) {
  const p = currentPlan(st, ctx.cat);
  const services = servicesOf(ctx.cat.plans); st.services = services;
  const buttons = [];
  const facts = {};
  if (p) {
    facts.title = titleOf(p, lang); facts.price = p.price;
    const twin = twinPlan(ctx.cat.plans, p, true);
    if (twin && !p.requiresGroupJoin && twin.price < p.price) {
      facts.groupPrice = twin.price;
      st.twin = { service: twin.service, plan: twin.plan };
      buttons.push(btn('twin', lang, words.buttonLabel('twin', lang) + ' · ' + words.rupees(twin.price)));
    }
  } else {
    const g = services.findIndex((x) => isGroupService(ctx.cat.plans, x));
    if (g >= 0) { facts.groupService = services[g]; buttons.push(btn('service:' + g, lang, serviceLabel(ctx.cat.plans, services[g]))); }
  }
  buttons.push(btn('coupon', lang));
  return [{ intent: p ? 'PRICE_HELP_PLAN' : 'PRICE_HELP', facts, buttons: withBackToPay(st, lang, buttons.concat(PAY_STEPS.has(st.step) || st.paused ? [] : [btn(p ? 'keep' : 'buy', lang)])) }];
}

async function freeAnswer(c, ctx, text) {
  const st = c.state; const lang = c.lang;
  const facts = factPack(st, ctx, lang);
  const a = await deps.words.answer(text, facts, ctx.settings.knowledge, lang, ctx.settings);
  if (a.tokens) { c.aiCalls++; c.aiTokens += a.tokens; }
  ctx.meta.push({ tool: 'answer', ok: !!a.text, handoff: !!a.handoff });
  if (!a.text) return null;
  const again = (st.lastButtons || []).length ? st.lastButtons : menuReply({}, lang).buttons;
  const buttons = a.handoff && !again.some((b) => b.id === 'whatsapp') ? again.concat([btn('whatsapp', lang)]) : again;
  return [{ intent: 'FREE_ANSWER', text: a.text, ai: true, buttons, input: st.lastInput || undefined }];
}
/** What Olivia may tell a customer who asks something off-script: live prices + FluxFilm's fixed rules. No personal data. */
function factPack(st, ctx, lang) {
  const lines = [];
  const plans = chatPlans(ctx.cat.plans);
  const focus = st.service ? plans.filter((p) => p.service === st.service || p.service.split(' (')[0] === st.service.split(' (')[0]) : plans;
  // 2+ device plans too, so "kitne devices?" gets the real answer (they are bought on the Buy page).
  const multi = (ctx.cat.plans || []).filter((p) => p && p.service && p.plan && devicesOf(p.plan) >= 2 && (!st.service || familyOf(p.service) === familyOf(st.service)));
  for (const p of multi.slice(0, 20)) lines.push('- ' + titleOf(p, 'en') + ' for ' + devicesOf(p.plan) + ' devices: ' + words.rupees(p.price) + (stockOf(ctx.cat.stock, p) === 'OUT' ? ' (sold out)' : '') + ' (bought on the Buy page of the website)');
  for (const p of focus.slice(0, 40)) lines.push('- ' + titleOf(p, 'en') + ': ' + words.rupees(p.price) + (stockOf(ctx.cat.stock, p) === 'OUT' ? ' (sold out)' : '') + (p.requiresGroupJoin ? ' (Group Offer: join our WhatsApp group first)' : '') + (String(p.deviceRuleText || '').trim() ? ' — devices: ' + String(p.deviceRuleText).split(/\r?\n/)[0].trim().slice(0, 160) : ''));
  const where = PAY_STEPS.has(st.step) ? 'The customer has an unpaid order of ' + words.rupees(st.amount) + ' open and is on the payment step.' : st.plan ? 'The customer is choosing ' + st.title + '.' : 'The customer has not chosen a plan yet.';
  return [
    'Live plans and prices:', lines.join('\n') || '- (not loaded)', where,
    'Sharing = lowest price, you watch on a shared profile. Private = your own profile that only you use. Both play in the same quality. FluxFilm rules: payment is by UPI QR and is checked automatically from the bank; the login is delivered right after payment and emailed. Coupons can be applied before paying (tap "Apply coupon"). Group Offer plans are cheaper but need joining the FluxFilm WhatsApp group. Renewals: My plans → Renew. Netflix household or TV code problems: Household Helper. Olivia cannot see or share old passwords; use My plans or Recover. For anything else the FluxFilm team helps on WhatsApp.',
  ].join('\n');
}


// ── renew in chat (same functions as My plans → Renew) ──
const devicesInPlan = (plan) => Number((String(plan).match(/(\d+)\s*device/i) || [])[1]) || 1;
/** Step 1: which of the customer's own plans. Only plans returned for THIS phone can ever be renewed here. */
function renewTextAction(st, ents, ctx) {
  if (st.step === 'renew_pick' && ents.service) {
    const i = (st.renewSubs || []).findIndex((x) => x.service.toLowerCase().split(' (')[0] === ents.service.toLowerCase().split(' (')[0]);
    return i >= 0 ? 'rsub:' + i : '';
  }
  if (st.step === 'renew_duration' && ents.days) {
    const i = (st.renewOptions || []).findIndex((pl) => { const p = (ctx.cat.plans || []).find((x) => x.service === st.renew.service && x.plan === pl); return p && Math.abs(p.durationDays - ents.days) <= 5; });
    return i >= 0 ? 'rplan:' + i : '';
  }
  return '';
}
async function renewStart(c, ctx, serviceHint) {
  const st = c.state; const lang = c.lang;
  const r = await tools().mySubscriptions(c.phone);
  const list = ((r && r.actionable) || []).filter((x) => x && x.subId);
  ctx.meta.push({ tool: 'mySubscriptions', count: list.length });
  resetPurchase(st); dropOrder(st);
  if (!r || r.ok === false) { st.step = 'info'; return [{ intent: 'RENEW_ON_SITE', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
  const hinted = serviceHint ? list.filter((x) => x.service.toLowerCase().split(' (')[0] === serviceHint.toLowerCase().split(' (')[0]) : [];
  const subs = hinted.length ? hinted : list;
  if (!subs.length) { st.step = 'info'; return [{ intent: 'RENEW_NONE', buttons: [btn('buy', lang), btn('whatsapp', lang), btn('menu', lang)] }]; }
  st.flow = 'renew';
  st.renewSubs = subs.slice(0, 8).map((x) => ({ subId: x.subId, service: x.service, plan: x.plan, daysLeft: x.daysLeft }));
  if (st.renewSubs.length === 1) { st.renew = Object.assign({}, st.renewSubs[0]); return renewDurations(st, ctx, lang); }
  st.step = 'renew_pick';
  return [{ intent: 'RENEW_PICK', buttons: st.renewSubs.map((x, i) => btn('rsub:' + i, lang, x.service + ' ' + x.plan + ' · ' + words.daysLeftLabel(x.daysLeft, lang))).concat([btn('menu', lang)]) }];
}
/** Step 2: same length or another length of the same kind of plan (same Sharing/Private, same number of devices). */
function renewDurations(st, ctx, lang) {
  const r = st.renew;
  const opts = (ctx.cat.plans || []).filter((p) => p.service === r.service && variantOf(p.plan) === variantOf(r.plan) && devicesInPlan(p.plan) === devicesInPlan(r.plan))
    .sort((a, b) => a.durationDays - b.durationDays || a.price - b.price);
  if (!opts.length) { st.step = 'handoff'; return [{ intent: 'RENEW_PLAN_GONE', facts: { title: r.service + ' ' + r.plan }, buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
  st.renewOptions = opts.map((p) => p.plan);
  st.step = 'renew_duration';
  return [{
    intent: 'RENEW_DURATION', facts: { title: r.service + ' ' + r.plan, days: words.daysLeftLabel(r.daysLeft, lang) },
    buttons: opts.map((p, i) => btn('rplan:' + i, lang, words.durationLabel(p.durationDays, lang) + ' · ' + words.rupees(p.price) + (p.plan === r.plan ? ' ✓' : ''))).concat([btn('menu', lang)]),
  }];
}
/** Step 3: the shop's own renewQuote: early-renew discount, new expiry date, and whether the old account still has room. */
async function renewConfirm(c, ctx) {
  const st = c.state; const lang = c.lang; const r = st.renew;
  const q = await tools().renewQuote(r.subId, r.toPlan);
  const mode = q && q.renewal ? s(q.renewal.mode).toUpperCase() : '';
  ctx.meta.push({ tool: 'renewQuote', ok: !!(q && q.ok), mode });
  if (!q || !q.ok) { st.step = 'handoff'; return [{ intent: 'SOMETHING_WENT_WRONG', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
  if (mode === 'NONE') { st.step = 'handoff'; return [{ intent: 'RENEW_BLOCKED', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
  const p = (ctx.cat.plans || []).find((x) => x.service === r.service && x.plan === r.toPlan);
  r.quote = { price: q.price, early: q.earlyDiscount || 0, amount: q.amount, newExpiry: s(q.renewal && q.renewal.preview && q.renewal.preview.newExpiryText), accountChange: mode === 'MOVE' || mode === 'SPLIT' };
  st.title = r.service + ' ' + variantLabel(variantOf(r.toPlan)) + ' ' + words.durationLabel(p ? p.durationDays : 30, 'en');
  st.step = 'renew_confirm';
  const title = r.service + ' ' + r.toPlan;
  if (st.coupon && st.coupon.plan === r.toPlan) {
    return [{ intent: 'RENEW_CONFIRM_COUPON', facts: { title, price: q.price, code: st.coupon.code, discount: st.coupon.discount, final: st.coupon.finalAmount, newExpiry: r.quote.newExpiry, accountChange: r.quote.accountChange }, buttons: [btn('pay', lang), btn('nocoupon', lang), btn('rchange', lang)] }];
  }
  delete st.coupon;
  return [{ intent: 'RENEW_CONFIRM', facts: { title, price: q.price, early: r.quote.early, amount: q.amount, newExpiry: r.quote.newExpiry, accountChange: r.quote.accountChange }, buttons: [btn('pay', lang), btn('coupon', lang), btn('rchange', lang), btn('menu', lang)] }];
}

/** Customer named a plan by its price ("99 wala"): go straight to that plan (group join / TV / email steps still apply). */
async function pickPlan(c, ctx, p) {
  const st = c.state; const lang = c.lang;
  let pre = [];
  if (st.orderId && PAY_STEPS.has(st.step)) {
    const cur = currentPlan(st, ctx.cat);
    if (cur && cur.service === p.service && cur.plan === p.plan) { delete st.paused; st.step = 'paying'; ctx.poll = 6; return [{ intent: 'PAYMENT_REMINDER', facts: { title: titleOf(cur, lang), amount: st.amount }, card: payCard(st), buttons: payButtons(lang) }]; }
    const done = await paidAlready(c, ctx);
    if (done) return done;
    dropOrder(st); pre = [{ intent: 'OLD_QR_CANCELLED' }];
  }
  const joined = st.groupJoined && familyOf(st.service) === familyOf(p.service);
  resetPurchase(st);
  st.service = p.service; st.variant = variantOf(p.plan); st.plan = { service: p.service, plan: p.plan };
  if (joined) st.groupJoined = true;
  return pre.concat(advance(st, ctx.cat, lang, ctx.profile));
}

async function turn(c, input, ctx) {
  const choice = s(input.choice);
  const text = s(input.text).slice(0, 500);
  // She answers in the language the customer writes in: Hinglish in → Hinglish out (a clear message switches it).
  const written = text && !choice ? detectLang(text) : '';
  if (written && c.lang && written !== c.lang) { ctx.meta.push({ langSwitch: c.lang + '>' + written }); c.lang = written; }
  const st = c.state; const lang = c.lang;

  // Language first (and any time a language button is pressed or typed).
  const typedLang = text ? globalIntentOf(text) : '';
  if (/^lang:(en|hinglish|hi)$/.test(choice) || /^lang:/.test(typedLang)) {
    c.lang = (choice || typedLang).slice(5);
    if (PAY_STEPS.has(st.step) && st.orderId) return [{ intent: 'SEND_PAYMENT', facts: { amount: st.amount }, card: payCard(st), buttons: payButtons(c.lang) }];
    return [menuReply(st, c.lang, ctx.profile.name)];
  }
  if (!c.lang) {
    if (input.lang && words.LANGS.includes(input.lang)) { c.lang = input.lang; return [menuReply(st, c.lang, ctx.profile.name)]; }
    st.step = 'lang';
    return [{ intent: 'CHOOSE_LANGUAGE', buttons: [btn('lang:hinglish', 'en'), btn('lang:en', 'en'), btn('lang:hi', 'en')] }];
  }
  if (choice === 'start') return [menuReply(st, lang, ctx.profile.name)];

  const allowed = new Set(st.allowed || []);
  let action = '';
  let ents = {};
  let code = '';
  let priced = [];
  let multi = [];
  if (choice === 'poll') action = (PAY_STEPS.has(st.step) && !st.paused) ? 'poll' : '';
  else if (choice) action = (allowed.has(choice) || choice === 'menu') ? choice : '';
  else if (text) {
    const g = globalIntentOf(text);
    // 1. Typed answers the current step is waiting for.
    if ((st.step === 'own_email' || st.step === 'extra_email') && EMAIL_RE.test(text)) action = 'email:' + text.toLowerCase();
    else if (/(coupon|code).{0,15}(nahi|nhi|no|without|skip|chhodo|rehne do)|without (a )?coupon|no coupon/i.test(text)) action = 'nocoupon';
    else if (st.awaitCoupon && (code = couponCodeIn(text, true))) action = 'coupon';
    else if (st.step === 'backup_name' && !g && !intentOf(text) && /^[\p{L} .'-]{2,60}$/u.test(text)) action = 'payer:' + text;
    // 2. Things that can be asked at any moment.
    else if (g === 'coupon') { action = 'coupon'; code = couponCodeIn(text, false); }
    else if (!['change', 'renew', 'login', 'household'].includes(g) && !PAY_STEPS.has(st.step) && (multi = devicesWanted(text)) >= 2) action = 'devices';
    else if (g !== 'change' && g !== 'renew' && (priced = narrowToFamily(plansByPrice(text, ctx.cat.plans), st)).length) action = (priced.length === 1 && PICK_WORDS_RE.test(text) && !QUESTION_RE.test(text) && !/earlier|pehle|before|last time|bought|liya tha|kharida/i.test(text)) ? 'pricepick' : 'pricematch';
    else if (g === 'change') action = 'change';
    else if (g === 'price') {
      ents = entities(text, ctx.cat.plans);
      // "kitne ka hai?" / "netflix ka price?": the team just tells the price (or asks which service first).
      const plain = PLAIN_PRICE_RE.test(text) && !NOT_PLAIN_PRICE_RE.test(text) && !ents.days;
      if (PAY_STEPS.has(st.step)) action = 'price';
      else if (plain && (ents.service || !currentPlan(st, ctx.cat))) action = 'pricefrom';
      else action = ents.service ? 'slots' : 'price';
    }
    else if (g === 'renew' || g === 'household' || g === 'other' || g === 'login') { action = g; if (g === 'renew') ents = entities(text, ctx.cat.plans); }
    else if (g === 'whenlogin' || g === 'paymethod' || (g === 'tv' && st.step !== 'tv')) { action = g; ents = entities(text, ctx.cat.plans); }
    // 3. The step's own answers.
    if (!action) {
      const it = intentOf(text);
      const inPayment = PAY_STEPS.has(st.step) && !st.paused; // after Main menu / a side question, a new plan request is allowed
      ents = inPayment ? {} : entities(text, ctx.cat.plans);
      const payEnts = inPayment && st.orderId ? entities(text, ctx.cat.plans) : {};
      if (it === 'paid' && PAY_STEPS.has(st.step)) action = st.paused ? 'backpay_paid' : 'paid';
      else if (payEnts.service) { st.pendingSwitch = { service: payEnts.service, variant: payEnts.variant || '', days: payEnts.days || 0 }; action = 'switchask'; }
      else if (it === 'cantpay' && st.step === 'paying') action = 'cantpay';
      else if (it === 'diff' && st.devices && DEVICE_STEPS.has(st.step) && !ents.service) action = 'ddiff';
      else if (it === 'diff' && (st.step === 'variant' || (st.service && needsVariant(ctx.cat.plans, st.service)) || ents.service)) action = 'diff';
      // While choosing an N-device plan, a typed service / "sharing" / "3 months" stays in the N-device plans.
      else if (st.devices && DEVICE_STEPS.has(st.step) && (ents.service || ents.variant || ents.days)) action = 'devices_more';
      else if (st.flow === 'renew' && (st.step === 'renew_pick' || st.step === 'renew_duration') && (ents.service || ents.days) && renewTextAction(st, ents, ctx)) action = renewTextAction(st, ents, ctx);
      else if (ents.service || ents.days || (ents.variant && !QUESTION_RE.test(text))) action = 'slots'; // "does sharing work on TV?" is a question, not a choice
      else if (it === 'yes' && (st.step === 'confirm' || st.step === 'renew_confirm')) action = 'pay';
      else if (it === 'yes' && st.step === 'group') action = 'joined';
      else if (it === 'yes' && st.step === 'tv') action = 'tv:yes';
      else if (it === 'no' && st.step === 'tv') action = 'tv:no';
      else if (it === 'menu' && PAY_STEPS.has(st.step)) action = 'backpay';
      else if (it === 'menu') action = 'menu';
      else if (it === 'buy' && !inPayment && !CHOOSING_STEPS.has(st.step)) action = 'buy'; // "I want to buy" while already choosing: keep going
      // A question ("does it work on TV?") is answered, never mapped onto a button.
      if (!action && !QUESTION_RE.test(text) && (st.lastButtons || []).length) {
        const pick = await deps.words.classify(text, (st.lastButtons || []).filter((b) => !LINK_BUTTONS[b.id] && !/^group/.test(b.id) && !MONEY_BUTTONS.has(b.id)), lang, ctx.settings);
        if (pick.tokens) { c.aiCalls++; c.aiTokens += pick.tokens; }
        if (pick.id && allowed.has(pick.id)) action = pick.id;
      }
    }
  }
  ctx.meta.push({ action: action ? action.replace(/^(payer|email):.*/, '$1') : 'unknown' });

  if (!action) {
    if (choice === 'poll') return [];
    if (text) {
      const fa = await freeAnswer(c, ctx, text);
      if (fa) return fa;
      // A real question Olivia may not answer safely (refunds, special deals…): hand it to the team instead of "I did not understand".
      if (ctx.settings.aiWords && (QUESTION_RE.test(text) || text.split(/\s+/).length >= 4)) {
        const again = (st.lastButtons || []).length ? st.lastButtons : menuReply({}, lang).buttons;
        return [{ intent: 'QUESTION_TO_TEAM', buttons: again.some((b) => b.id === 'whatsapp') ? again : again.concat([btn('whatsapp', lang)]), input: st.lastInput || undefined }];
      }
    }
    return [{ intent: 'DIDNT_UNDERSTAND', buttons: (st.lastButtons || []).length ? st.lastButtons : menuReply({}, lang).buttons, input: st.lastInput || undefined }];
  }
  if (action === 'backpay' || action === 'backpay_paid') {
    delete st.paused; st.awaitCoupon = false;
    if (!st.orderId) return advance(st, ctx.cat, lang, ctx.profile);
    st.step = 'paying';
    if (action === 'backpay') { ctx.poll = 6; return [{ intent: 'SEND_PAYMENT', facts: { amount: st.amount }, card: payCard(st), buttons: payButtons(lang) }]; }
    action = 'paid'; // "I have paid" typed while a side question was open
  }
  if (action === 'menu') {
    if (st.orderId && PAY_STEPS.has(st.step)) { st.paused = true; return [Object.assign(menuReply({}, lang, ctx.profile.name), { buttons: withBackToPay(st, lang, menuReply({}, lang).buttons) })]; }
    resetPurchase(st); dropOrder(st); return [menuReply(st, lang, ctx.profile.name)];
  }
  if (action === 'buy') { resetPurchase(st); dropOrder(st); return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'renew') {
    if (st.orderId && PAY_STEPS.has(st.step)) {
      const done = await paidAlready(c, ctx);
      if (done) return done;
      dropOrder(st);
      return [{ intent: 'OLD_QR_CANCELLED' }].concat(await renewStart(c, ctx, ents.service));
    }
    return renewStart(c, ctx, ents.service);
  }
  if (action.startsWith('rsub:')) { const x = (st.renewSubs || [])[Number(action.slice(5))]; if (!x) return renewStart(c, ctx); st.renew = Object.assign({}, x); delete st.coupon; return renewDurations(st, ctx, lang); }
  if (action.startsWith('rplan:')) {
    const pl = (st.renewOptions || [])[Number(action.slice(6))];
    if (!pl || !st.renew) return renewStart(c, ctx);
    if (st.renew.toPlan !== pl) delete st.coupon;
    st.renew.toPlan = pl;
    return renewConfirm(c, ctx);
  }
  if (action === 'rchange' || (action === 'change' && st.flow === 'renew' && st.renew)) {
    const done = await paidAlready(c, ctx);
    if (done) return done;
    const hadOrder = dropOrder(st); delete st.coupon;
    return (hadOrder ? [{ intent: 'OLD_QR_CANCELLED' }] : []).concat(renewDurations(st, ctx, lang));
  }
  if (action === 'devices' || action === 'devices_more') {
    // "2 devices ke liye chahiye" / "do phone": remember N, keep the service + Sharing/Private already known in THIS purchase.
    const e = entities(text, ctx.cat.plans);
    const n = action === 'devices' ? multi : st.devices;
    const known = CHOOSING_STEPS.has(st.step) ? { service: st.service, variant: st.variant } : {};
    resetPurchase(st);
    st.devices = n;
    st.service = e.service || known.service || '';
    const variant = e.variant || (e.service && e.service !== known.service ? '' : known.variant);
    if (variant) st.variant = variant;
    return devicesReplies(st, ctx, lang);
  }
  if (action.startsWith('dsvc:')) {
    const next = (st.deviceServices || [])[Number(action.slice(5))];
    if (!next || !st.devices) return advance(st, ctx.cat, lang, ctx.profile);
    const n = st.devices; resetPurchase(st); st.devices = n; st.service = next;
    return devicesReplies(st, ctx, lang);
  }
  if (action.startsWith('dvar:')) { if (!st.devices) return advance(st, ctx.cat, lang, ctx.profile); st.variant = action.slice(5) === 'private' ? 'private' : 'sharing'; return devicesReplies(st, ctx, lang); }
  if (action.startsWith('dmax:')) { const m = Number(action.slice(5)); if (!st.service || !(m >= 2)) return advance(st, ctx.cat, lang, ctx.profile); st.devices = m; return devicesReplies(st, ctx, lang); }
  if (action === 'd1') { delete st.devices; delete st.deviceServices; st.plan = null; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'ddiff') {
    // The difference, told from the N-device plans' own benefits (not the 1-device ones).
    const all = devicePlansOf(ctx.cat.plans, st.service, st.devices || 2);
    const one = (v) => { const o = all.find((p) => variantOf(p.plan) === v); return o ? o.benefits : []; };
    st.step = 'devices_variant';
    return [{ intent: 'EXPLAIN_SHARING_VS_PRIVATE', facts: { sharing: one('sharing'), private: one('private') }, buttons: [btn('dvar:sharing', lang), btn('dvar:private', lang), btn('menu', lang)] }];
  }
  if (action === 'household' || action === 'other' || action === 'login') {
    if (st.orderId && PAY_STEPS.has(st.step)) st.paused = true;
    const intent = action === 'household' ? 'HOUSEHOLD_HELPER' : action === 'login' ? 'LOGIN_HELP' : 'HANDOFF_TO_HUMAN';
    const b = action === 'household' ? [btn('helper', lang), btn('whatsapp', lang)] : action === 'login' ? [btn('myplans', lang), btn('whatsapp', lang)] : [btn('whatsapp', lang)];
    if (!st.paused) st.step = action === 'other' ? 'handoff' : 'info';
    return [{ intent, buttons: withBackToPay(st, lang, b.concat([btn('menu', lang)])) }];
  }
  if (action === 'tv' || action === 'whenlogin' || action === 'paymethod') {
    // Answered from the catalogue (benefits, device rule, fulfilment); the step's own buttons stay, so buying continues.
    const plans = ctx.cat.plans || [];
    const again = (st.lastButtons || []).length ? st.lastButtons : menuReply({}, lang).buttons;
    const withWa = (b) => (b.some((x) => x.id === 'whatsapp') ? b : b.concat([btn('whatsapp', lang)]));
    const idle = !PAY_STEPS.has(st.step) && !CHOOSING_STEPS.has(st.step);
    if (idle && ents.service) { resetPurchase(st); st.service = ents.service; }
    const svc = ents.service || (st.plan && st.plan.service) || st.service || '';
    // Nothing being bought yet: after the answer, go on selling (which service → Sharing or Private …).
    const tail = idle ? advance(st, ctx.cat, lang, ctx.profile) : [];
    const keep = (r) => (tail.length ? [r].concat(tail) : [Object.assign(r, { buttons: r.buttons || again, input: st.lastInput || undefined })]);
    if (action === 'paymethod') {
      const card = /card|net ?banking/i.test(text);
      return keep({ intent: 'PAYMENT_METHOD', facts: { paying: PAY_STEPS.has(st.step), card }, buttons: card ? withWa(again) : undefined });
    }
    const rule = svc ? deviceRuleOf(plans, svc, st.variant) : '';
    if (action === 'whenlogin') {
      const sp = plans.filter((p) => p.service === svc);
      const manual = sp.length > 0 && sp.every((p) => /manual/i.test(s(p.fulfillmentMode)));
      return keep({ intent: manual ? 'WHEN_LOGIN_MANUAL' : 'WHEN_LOGIN', facts: { service: svc, rule: /otp|phone number/i.test(rule) ? rule : '' } });
    }
    const hasTv = (x) => plans.some((p) => p.service === x && (p.benefits || []).some((b) => /\bTV\b/i.test(b)));
    if (!svc) {
      const tvs = [...new Set(servicesOf(plans).filter(hasTv).map((x) => x.split(' (')[0]))];
      return keep({ intent: 'TV_ANSWER', facts: { services: tvs } });
    }
    if (!hasTv(svc)) return keep({ intent: 'TV_UNSURE', facts: { service: svc }, buttons: tail.length ? undefined : withWa(again) });
    return keep({ intent: 'TV_ANSWER_SERVICE', facts: { service: svc, rule: /\bTV\b/i.test(rule) ? rule : '' } });
  }
  if (action === 'pricefrom') {
    if (ents.service && ents.service !== st.service) { const keepJoin = st.groupJoined && familyOf(ents.service) === familyOf(st.service); resetPurchase(st); st.service = ents.service; if (keepJoin) st.groupJoined = true; }
    if (ents.variant) st.variant = ents.variant;
    st.plan = null;
    if (!st.service || !servicesOf(ctx.cat.plans).includes(st.service)) {
      const a = advance(st, ctx.cat, lang, ctx.profile);
      if (a[0] && a[0].intent === 'ASK_SERVICE') a[0].intent = 'PRICE_WHICH_SERVICE';
      return a;
    }
    const inStock = (p) => stockOf(ctx.cat.stock, p) !== 'OUT';
    const split = needsVariant(ctx.cat.plans, st.service) && !st.variant;
    const items = split
      ? ['sharing', 'private'].map((v) => { const o = optionsFor(ctx.cat.plans, st.service, v).filter(inStock)[0]; return o ? variantLabel(v) + ' ' + words.durationLabel(o.durationDays, lang) + ' · ' + words.rupees(o.price) : ''; }).filter(Boolean)
      : optionsFor(ctx.cat.plans, st.service, needsVariant(ctx.cat.plans, st.service) ? st.variant : '').filter(inStock).slice(0, 5).map((p) => words.durationLabel(p.durationDays, lang) + ' · ' + words.rupees(p.price));
    const title = st.service + (st.variant && !split ? ' ' + variantLabel(st.variant) : '');
    return (items.length ? [{ intent: 'PRICE_FROM', facts: { title, items, from: split } }] : []).concat(advance(st, ctx.cat, lang, ctx.profile));
  }
  if (action === 'change') {
    const done = await paidAlready(c, ctx);
    if (done) return done;
    const hadOrder = dropOrder(st);
    resetPurchase(st);
    return (hadOrder ? [{ intent: 'OLD_QR_CANCELLED' }] : []).concat(advance(st, ctx.cat, lang, ctx.profile));
  }
  if (action === 'keep') return advance(st, ctx.cat, lang, ctx.profile);
  if (action === 'price') return priceReplies(st, ctx, lang);
  if (action === 'pricematch' || action === 'pricepick') {
    const list = priced.slice(0, 4);
    if (action === 'pricepick' || (list.length === 1 && !PAY_STEPS.has(st.step) && !QUESTION_RE.test(text) && PICK_WORDS_RE.test(text))) return pickPlan(c, ctx, list[0]);
    st.priceOptions = list.map((p) => ({ service: p.service, plan: p.plan }));
    return [{ intent: 'PRICE_MATCH', facts: { price: list[0].price, titles: list.map((p) => titleOf(p, lang)) }, buttons: withBackToPay(st, lang, list.map((p, i) => btn('ppick:' + i, lang, titleOf(p, lang) + ' · ' + words.rupees(p.price))).concat([btn('coupon', lang)])) }];
  }
  if (action.startsWith('ppick:')) { const o = (st.priceOptions || [])[Number(action.slice(6))]; const p = o && ctx.cat.plans.find((x) => x.service === o.service && x.plan === o.plan); return p ? pickPlan(c, ctx, p) : advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'switchask') {
    const sw = st.pendingSwitch || {};
    const cur = currentPlan(st, ctx.cat);
    const same = cur && familyOf(sw.service) === familyOf(cur.service) && (!sw.variant || sw.variant === variantOf(cur.plan)) && (!sw.days || Math.abs(sw.days - cur.durationDays) <= 5);
    if (same) { delete st.pendingSwitch; st.step = 'paying'; ctx.poll = 6; return [{ intent: 'PAYMENT_REMINDER', facts: { title: titleOf(cur, lang), amount: st.amount }, card: payCard(st), buttons: payButtons(lang) }]; }
    st.paused = true;
    return [{ intent: 'SWITCH_CONFIRM', facts: { title: st.title || '', amount: st.amount, service: sw.service }, buttons: [btn('switch', lang), btn('backpay', lang)] }];
  }
  if (action === 'switch') {
    const sw = st.pendingSwitch; delete st.pendingSwitch;
    const done = await paidAlready(c, ctx);
    if (done) return done;
    dropOrder(st); resetPurchase(st);
    if (sw) { st.service = sw.service; if (sw.variant) st.variant = sw.variant; if (sw.days) st.days = sw.days; }
    return [{ intent: 'OLD_QR_CANCELLED' }].concat(advance(st, ctx.cat, lang, ctx.profile));
  }
  if (action === 'normal') action = 'twin'; // from the Group Offer explanation: the same plan without the group
  if (action === 'twin') {
    if (!st.twin) return priceReplies(st, ctx, lang);
    const done = await paidAlready(c, ctx);
    if (done) return done;
    const hadOrder = dropOrder(st);
    const tw = st.twin; const extra = st.extraValue; delete st.twin;
    resetPurchase(st);
    st.service = tw.service; st.variant = variantOf(tw.plan); st.plan = tw; st.extraValue = extra;
    return (hadOrder ? [{ intent: 'OLD_QR_CANCELLED' }] : []).concat(advance(st, ctx.cat, lang, ctx.profile));
  }
  if (action === 'coupon') return couponReplies(c, ctx, code);
  if (action === 'nocoupon') {
    st.awaitCoupon = false; delete st.coupon;
    if (st.orderId && st.paused) { delete st.paused; st.step = 'paying'; ctx.poll = 6; return [{ intent: 'SEND_PAYMENT', facts: { amount: st.amount }, card: payCard(st), buttons: payButtons(lang) }]; }
    if (st.flow === 'renew' && st.renew && st.renew.toPlan) return renewConfirm(c, ctx);
    return advance(st, ctx.cat, lang, ctx.profile);
  }
  if (action === 'joined') { st.groupJoined = true; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'slots') {
    if (st.orderId) { const done = await paidAlready(c, ctx); if (done) return done; dropOrder(st); }
    if (ents.service && ents.service !== st.service) { const keepJoin = st.groupJoined; resetPurchase(st); st.service = ents.service; if (keepJoin) st.groupJoined = true; }
    if (ents.variant) { st.variant = ents.variant; st.plan = null; }
    if (ents.days) { st.days = ents.days; st.plan = null; }
    return advance(st, ctx.cat, lang, ctx.profile);
  }
  if (action.startsWith('service:')) {
    const next = (st.services || [])[Number(action.slice(8))] || '';
    const keep = familyOf(next) === familyOf(st.service) ? { variant: st.variant, days: st.days || (currentPlan(st, ctx.cat) || {}).durationDays } : {};
    resetPurchase(st); dropOrder(st); st.service = next;
    if (keep.variant) st.variant = keep.variant;
    if (keep.days) st.days = keep.days;
    return advance(st, ctx.cat, lang, ctx.profile);
  }
  if (action.startsWith('variant:')) { st.variant = action.slice(8); st.plan = null; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'diff') {
    const svc = ents.service || st.service;
    const one = (v) => { const o = optionsFor(ctx.cat.plans, svc, v)[0]; return o ? o.benefits : []; };
    st.service = svc; st.step = 'variant';
    return [{ intent: 'EXPLAIN_SHARING_VS_PRIVATE', facts: { sharing: one('sharing'), private: one('private') }, buttons: [btn('variant:sharing', lang), btn('variant:private', lang), btn('menu', lang)] }];
  }
  if (action.startsWith('plan:')) {
    const o = (st.options || [])[Number(action.slice(5))]; st.plan = o || null; st.extraValue = '';
    const replies = advance(st, ctx.cat, lang, ctx.profile);
    if (st.pendingCoupon && st.step === 'confirm') { const pc = st.pendingCoupon; delete st.pendingCoupon; return couponReplies(c, ctx, pc); }
    return replies;
  }
  if (action === 'tv:yes' || action === 'tv:no') { st.extraValue = action === 'tv:yes' ? 'TV' : 'NON_TV'; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action.startsWith('email:')) {
    if (st.step === 'extra_email') st.extraValue = action.slice(6); else st.email = action.slice(6);
    return advance(st, ctx.cat, lang, ctx.profile);
  }

  if (action === 'pay' && st.step === 'renew_confirm' && st.renew && st.renew.toPlan) {
    const rn = st.renew;
    const r = await tools().createRenewOrder(rn.subId, rn.toPlan === rn.plan ? '' : rn.toPlan, st.coupon ? st.coupon.code : '');
    ctx.meta.push({ tool: 'createRenewOrder', ok: !!(r && r.ok), orderId: r && r.orderId, paused: !!(r && r.paused), blocked: !!(r && r.renewBlocked), coupon: !!st.coupon });
    if (!r || !r.ok) {
      if (r && r.paused) { st.step = 'menu'; return [{ intent: 'SHOP_PAUSED', buttons: [btn('menu', lang), btn('whatsapp', lang)] }]; }
      if (r && r.renewBlocked) { st.step = 'handoff'; return [{ intent: 'RENEW_BLOCKED', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
      if (st.coupon && /coupon/i.test(s(r && r.message))) { const bad = st.coupon.code; delete st.coupon; st.awaitCoupon = true; return [{ intent: 'COUPON_INVALID', facts: { code: bad, reason: couponReason(r.message) }, input: 'coupon', buttons: [btn('nocoupon', lang), btn('whatsapp', lang)] }]; }
      return [{ intent: 'SOMETHING_WENT_WRONG', buttons: [btn('pay', lang), btn('whatsapp', lang), btn('menu', lang)] }];
    }
    rn.accountChange = !!r.accountChange || !!(rn.quote && rn.quote.accountChange);
    st.orderId = r.orderId; st.amount = r.amount; st.upiLink = r.upiLink; st.step = 'paying'; st.orderAt = deps.now().getTime(); st.couponTries = 0;
    ctx.poll = 6;
    return [{ intent: 'SEND_PAYMENT', facts: { amount: r.amount }, card: payCard(st), buttons: payButtons(lang) }];
  }
  if (action === 'pay') {
    if (st.step !== 'confirm' || !st.plan) return st.flow === 'renew' && st.renew && st.renew.toPlan ? renewConfirm(c, ctx) : advance(st, ctx.cat, lang, ctx.profile);
    const p = currentPlan(st, ctx.cat);
    if (!p) { resetPurchase(st); return advance(st, ctx.cat, lang, ctx.profile); }
    const key = s(p.extraFieldKey).toUpperCase();
    const r = await tools().createOrder(c.phone, st.plan, {
      name: s(ctx.profile.name) || 'FluxFilm customer', email: st.email || ctx.profile.email,
      extraFieldKey: p.needsExtraField ? key : '', extraFieldValue: p.needsExtraField ? st.extraValue : '',
      couponCode: st.coupon ? st.coupon.code : '',
    });
    ctx.meta.push({ tool: 'createOrder', ok: !!(r && r.ok), orderId: r && r.orderId, paused: !!(r && r.paused), outOfStock: !!(r && r.outOfStock), coupon: !!st.coupon });
    if (!r || !r.ok) {
      if (r && r.paused) { st.step = 'menu'; return [{ intent: 'SHOP_PAUSED', buttons: [btn('menu', lang), btn('whatsapp', lang)] }]; }
      if (r && r.outOfStock) { st.plan = null; st.days = 0; return [{ intent: 'OUT_OF_STOCK', facts: { title: titleOf(p, lang) } }].concat(advance(st, ctx.cat, lang, ctx.profile)); }
      if (st.coupon && /coupon/i.test(s(r && r.message))) {
        const bad = st.coupon.code; delete st.coupon; st.awaitCoupon = true;
        return [{ intent: 'COUPON_INVALID', facts: { code: bad, reason: couponReason(r.message) }, input: 'coupon', buttons: [btn('nocoupon', lang), btn('whatsapp', lang)] }];
      }
      st.step = 'confirm';
      return [{ intent: 'SOMETHING_WENT_WRONG', buttons: [btn('pay', lang), btn('whatsapp', lang), btn('menu', lang)] }];
    }
    st.orderId = r.orderId; st.amount = r.amount; st.upiLink = r.upiLink; st.step = 'paying'; st.orderAt = deps.now().getTime(); st.couponTries = 0;
    ctx.poll = 6;
    return [{ intent: 'SEND_PAYMENT', facts: { amount: r.amount }, card: payCard(st), buttons: payButtons(lang) }];
  }

  if (action === 'poll' || action === 'paid') {
    if (!st.orderId) return advance(st, ctx.cat, lang, ctx.profile);
    const tooOld = deps.now().getTime() - (st.orderAt || 0) > 30 * 60e3;
    if (st.step === 'delivering') return deliverReplies(c, ctx);
    if (st.step === 'backup_review' || (st.step === 'backup_name' && action === 'poll')) {
      if (st.step === 'backup_name') { ctx.poll = tooOld ? 0 : 8; return []; }
      const cs = await tools().claimStatus(st.orderId, c.phone);
      ctx.meta.push({ tool: 'claimStatus', status: cs && cs.status });
      if (cs && cs.paid) return deliverReplies(c, ctx);
      if (cs && cs.status === 'REJECTED') { st.step = 'handoff'; return [{ intent: 'BACKUP_REJECTED', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
      ctx.poll = tooOld ? 0 : 8;
      return action === 'paid' ? [{ intent: 'BACKUP_UNDER_REVIEW', buttons: [btn('whatsapp', lang), btn('menu', lang)] }] : [];
    }
    const pay = await tools().checkPayment(st.orderId);
    ctx.meta.push({ tool: 'checkPayment', paid: pay.paid });
    if (pay.paid) return deliverReplies(c, ctx);
    ctx.poll = tooOld ? 0 : 6;
    if (action === 'poll') return [];
    return [{ intent: 'PAYMENT_NOT_YET', buttons: [btn('paid', lang), btn('cantpay', lang), btn('coupon', lang), btn('whatsapp', lang)] }];
  }

  if (action === 'cantpay') {
    if (!st.orderId) return advance(st, ctx.cat, lang, ctx.profile);
    const b = await tools().backupPayment(st.orderId, c.phone);
    ctx.meta.push({ tool: 'backupPayment', ok: !!(b && b.ok) });
    if (b && b.paid) return deliverReplies(c, ctx);
    if (!b || !b.ok) { st.step = 'handoff'; return [{ intent: 'HANDOFF_TO_HUMAN', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
    st.step = 'backup_name'; st.knownName = s(b.knownName);
    ctx.poll = 8;
    return [
      { intent: 'CANT_PAY_BACKUP_QR', facts: { amount: b.amount }, card: { type: 'backup', amount: b.amount, vpa: s(b.vpa), payee: s(b.payee), qr: s(b.qrImage) || 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=' + encodeURIComponent(b.upiLink || ''), upiLink: s(b.upiLink) } },
      { intent: 'ASK_PAYER_NAME', facts: { knownName: st.knownName }, input: 'name', buttons: (st.knownName ? [btn('payer:known', lang)] : []).concat([btn('whatsapp', lang)]) },
    ];
  }
  if (action === 'payer:known' || action.startsWith('payer:')) {
    if (!st.orderId) return advance(st, ctx.cat, lang, ctx.profile);
    const name = action === 'payer:known' ? st.knownName : action.slice(6);
    const r = await tools().claimBackup(st.orderId, c.phone, name);
    ctx.meta.push({ tool: 'claimBackup', status: r && r.status, ok: !!(r && r.ok) });
    if (r && r.paid) return deliverReplies(c, ctx);
    if (r && r.ok === false && r.field === 'name') return [{ intent: 'ASK_PAYER_NAME', facts: { knownName: '' }, input: 'name', buttons: [btn('whatsapp', lang)] }];
    if (!r || (r.ok === false && !r.tooMany)) { st.step = 'handoff'; return [{ intent: 'HANDOFF_TO_HUMAN', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
    if (r.status === 'REJECTED') { st.step = 'handoff'; return [{ intent: 'BACKUP_REJECTED', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
    st.step = 'backup_review'; ctx.poll = 8;
    return [{ intent: 'BACKUP_UNDER_REVIEW', buttons: [btn('whatsapp', lang), btn('menu', lang)] }];
  }
  return [{ intent: 'DIDNT_UNDERSTAND', buttons: st.lastButtons || [] }];
}

/** One customer message (or button, or silent poll) → Olivia's replies. */
async function handle(phone, input) {
  const inp = input || {};
  let a;
  try { a = await allowedFor(phone); } catch (e) { console.log('[olivia] settings failed:', e.message); return { ok: false, message: 'Olivia is not available right now.' }; }
  if (!a.ok) return { ok: false, disabled: true, whatsappLink: (a.settings && a.settings.whatsappLink) || WA_DEFAULT, message: 'Olivia is not available right now. Please WhatsApp our team.' };
  const t = tools();
  const profile = await t.profile(a.phone).catch(() => ({ ok: false }));
  if (!profile.ok) return { ok: false, disabled: true, whatsappLink: a.settings.whatsappLink, message: 'Please log in to chat with Olivia.' };

  let c = await loadConv(inp.conversationId, a.phone);
  if (!c) c = { id: crypto.randomBytes(16).toString('hex'), phone: a.phone, lang: '', state: {}, status: 'OPEN', turns: 0, aiCalls: 0, aiTokens: 0, isNew: true };
  const ctx = { settings: a.settings, profile, installedApp: inp.installedApp === true, meta: [], poll: 0, cat: { plans: [], stock: {} } };
  const choice = s(inp.choice);
  const isPoll = choice === 'poll';
  if (!isPoll) {
    c.turns++;
    const label = choice ? ((c.state.lastButtons || []).find((b) => b.id === choice) || {}).label || choice : s(inp.text);
    // Typed emails are not kept in the chat log (the order keeps the email the customer gave).
    if (choice !== 'start') await logMsg(c.id, 'customer', choice ? 'button' : 'text', String(label).replace(/[^\s@<>]+@[^\s@<>]+/g, '[email]'), null, false);
  }

  let replies;
  try {
    if (!isPoll) ctx.cat = await t.catalogFor();
    replies = await turn(c, inp, ctx);
  } catch (e) {
    console.log('[olivia] turn failed:', e.message);
    ctx.meta.push({ error: String(e.message || e).slice(0, 200) });
    replies = isPoll ? [] : [{ intent: 'SOMETHING_WENT_WRONG', buttons: [btn('menu', c.lang || 'en'), btn('whatsapp', c.lang || 'en')] }];
  }

  const messages = [];
  for (const r of replies) {
    const facts = r.facts || {};
    if (r.intent === 'GREET_MENU' || r.intent === 'ASK_PAYER_NAME') facts.name = facts.name || '';
    const w = r.text ? { text: r.text, ai: !!r.ai, tokens: 0 } : await deps.words.say(r.intent, facts, c.lang || 'en', ctx.settings);
    if (w.tokens) { c.aiCalls++; c.aiTokens += w.tokens; }
    const buttons = (r.buttons || []).map((b) => (LINK_BUTTONS[b.id] ? Object.assign({ link: LINK_BUTTONS[b.id] }, b) : b));
    w.text = words.format(w.text, facts, r.intent);
    const msg = { role: 'olivia', intent: r.intent, text: w.text, buttons };
    if (r.input) msg.input = r.input;
    if (r.card) msg.card = r.card;
    messages.push(msg);
    // Logged for the owner; a login card is recorded only as "[login shown]".
    await logMsg(c.id, 'olivia', r.intent, w.text + (r.card ? (r.card.type === 'access' ? ' [login shown in app]' : ' [' + r.card.type + ' card]') : ''), ctx.meta.length ? ctx.meta : null, w.ai);
  }
  const last = messages[messages.length - 1];
  if (last && last.intent !== 'FREE_ANSWER') {
    c.state.lastButtons = last.buttons.map((b) => ({ id: b.id, label: b.label }));
    c.state.lastInput = last.input || '';
    c.state.allowed = last.buttons.map((b) => b.id);
  }
  if (isPoll && !messages.length && !ctx.meta.some((m) => m.tool)) { /* nothing checked */ }
  try { await saveConv(c); } catch (e) { console.log('[olivia] save failed:', e.message); }
  const out = { ok: true, conversationId: c.id, lang: c.lang, step: c.state.step || '', messages };
  if (ctx.poll) out.poll = { afterSec: ctx.poll };
  if (c.state.orderId) out.orderId = c.state.orderId;
  return out;
}

/** Admin: latest conversations with their messages (no logins are ever stored). */
/** The customer's own past chats (newest first), for the "Past chats" menu. Logs never hold a login. */
async function history(phone) {
  const a = await allowedFor(phone);
  if (!a.ok) return { ok: false, disabled: true };
  const convs = await db.query('SELECT id, lang, status, order_id, turns, created_at, updated_at FROM olivia_conversations WHERE phone_norm = ? AND turns > 0 ORDER BY updated_at DESC LIMIT 20', [a.phone]);
  if (!convs.length) return { ok: true, chats: [] };
  const ids = convs.map((c) => c.id);
  const inList = ids.map(() => '?').join(',');
  // Preview: what was bought / being bought if anything, else the customer's last words.
  const key = await db.query('SELECT m.conversation_id, m.role, m.body FROM olivia_messages m JOIN (SELECT conversation_id, MAX(id) AS mx FROM olivia_messages WHERE conversation_id IN (' + inList + ") AND role = 'olivia' AND (intent LIKE 'PAYMENT_RECEIVED%' OR intent LIKE 'RENEW_DONE%' OR intent LIKE 'CONFIRM_PLAN%' OR intent = 'RENEW_CONFIRM' OR intent = 'DELIVERY_BEING_SET_UP') GROUP BY conversation_id) x ON m.id = x.mx", ids);
  const last = await db.query('SELECT m.conversation_id, m.role, m.body FROM olivia_messages m JOIN (SELECT conversation_id, MAX(id) AS mx FROM olivia_messages WHERE conversation_id IN (' + inList + ") AND role = 'customer' GROUP BY conversation_id) x ON m.id = x.mx", ids);
  const byId = new Map(last.map((m) => [m.conversation_id, m]));
  for (const m of key) byId.set(m.conversation_id, m);
  return {
    ok: true,
    chats: convs.map((c) => ({
      id: c.id, status: c.status, hasOrder: !!c.order_id, turns: Number(c.turns) || 0,
      startedAt: iso(c.created_at), updatedAt: iso(c.updated_at),
      preview: cleanBody((byId.get(c.id) || {}).body || '').split('\n')[0].slice(0, 90),
    })),
  };
}
/** One of the customer's own chats, read-only (the phone must match). */
async function transcript(phone, id) {
  const a = await allowedFor(phone);
  if (!a.ok) return { ok: false, disabled: true };
  const c = await loadConv(id, a.phone);
  if (!c) return { ok: false, message: 'Chat not found.' };
  const rows = await db.query('SELECT role, intent, body, created_at FROM olivia_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 300', [c.id]);
  return { ok: true, id: c.id, lang: c.lang, messages: rows.map((m) => ({ role: m.role === 'customer' ? 'customer' : 'olivia', text: cleanBody(m.body), at: iso(m.created_at), past: true })) };
}
function iso(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? m[1] + 'T' + m[2] + '+05:30' : String(v);
}
/** Chat-log markers → words a customer understands. */
function cleanBody(body) {
  return String(body || '')
    .replace(/\s*\[login shown in app\]/g, '\n(🔒 Your login was shown here — see My plans or your email)')
    .replace(/\s*\[(pay|backup) card\]/g, '\n(💳 Payment QR was shown)')
    .replace(/\s*\[[a-z]+ card\]/g, '');
}

async function recent(limit) {
  const n = Math.min(100, Math.max(1, Number(limit) || 30));
  try {
    const convs = await db.query('SELECT id, phone_norm, lang, step, status, order_id, turns, ai_calls, ai_tokens, created_at, updated_at FROM olivia_conversations ORDER BY updated_at DESC LIMIT ' + n, []);
    return { ok: true, conversations: convs };
  } catch (e) { if (missingTable(e)) return { ok: true, conversations: [], schemaMissing: true }; throw e; }
}
async function messagesOf(id) {
  if (!/^[a-f0-9]{32}$/.test(s(id))) return { ok: false, message: 'Bad id' };
  const rows = await db.query('SELECT role, intent, body, ai, created_at FROM olivia_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 400', [id]);
  return { ok: true, messages: rows };
}

module.exports = {
  DEFAULTS, validateSettings, getSettings, saveSettings, status, handle, history, transcript, recent, messagesOf, schemaReady,
  _internal: { devicesWanted, detectLang, cleanBody, typoService, plansByPrice, MONEY_BUTTONS, setDeps: (d) => { deps = Object.assign({}, deps, d); }, reset: () => { cache = null; schemaOk = null; }, entities, intentOf, globalIntentOf, couponCodeIn, couponReason, chatPlans, needsVariant, optionsFor, titleOf, phoneList },
};
