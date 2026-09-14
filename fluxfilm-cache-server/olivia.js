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

const DEFAULTS = Object.freeze({ enabled: false, testOnly: true, testPhones: '', aiWords: true, whatsappLink: WA_DEFAULT, voice: '' });

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
/** Plans Olivia sells in chat. Group-offer plans and 2+ device plans (extra choices) stay on the website. */
function chatPlans(plans) {
  return (plans || []).filter((p) => p && p.service && p.plan && !p.requiresGroupJoin && !p.loginChoice && devicesOf(p.plan) === 1);
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
  [/netflix|netflik|नेटफ्लिक्स/i, /^netflix$/i], [/prime|amazon/i, /^prime video$/i], [/hotstar|jio/i, /hotstar/i],
  [/sony/i, /sony/i], [/zee/i, /zee/i], [/crunchy|anime/i, /crunchy/i], [/youtube|\byt\b/i, /youtube/i],
];
function entities(text, plans) {
  const t = String(text || '').toLowerCase();
  const e = {};
  const services = servicesOf(plans);
  for (const [word, svc] of SERVICE_WORDS) {
    if (!word.test(t)) continue;
    const hit = services.find((x) => svc.test(x)) || services.find((x) => word.test(x));
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
function intentOf(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(hi+|hello+|hey+|hlo|helo|namaste|namaskar|नमस्ते|good (morning|afternoon|evening))\b/.test(t) && t.length < 30) return 'menu';
  if (/(can.?t|cannot|unable to|not able to) pay|payment (not|nahi|nhi) (working|ho|going)|nahi ho raha|nhi ho rha|failed|limit|error/.test(t)) return 'cantpay';
  if (/\b(paid|done)\b|ho gaya|hogaya|ho gya|kar diya|kr diya|bhej diya|payment (kar|kr) (di|diya)|pay kar diya/.test(t)) return 'paid';
  if (/differen|\bfark|farak|antar|फ़र्क|फर्क/.test(t)) return 'diff';
  if (/renew|रिन्यू/.test(t)) return 'renew';
  if (/household|house hold|tv code|not part of|घर/.test(t)) return 'household';
  if (/human|agent|real person|call me|whatsapp|talk to|baat karni|team/.test(t)) return 'other';
  if (/^(main )?menu$|start over|restart|shuru se/.test(t)) return 'menu';
  if (/^(yes|yeah|yup|haan|ha|han|haa|ok|okay|theek|thik|sure|ji)\b/.test(t)) return 'yes';
  if (/^(no|nahi|nahin|nhi|na)\b/.test(t)) return 'no';
  if (/\b(buy|purchase|chahiye|chaiye|want|lena|leni|kharid)/.test(t)) return 'buy';
  return '';
}
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

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
      [c.id, c.phone, c.lang || '', st.step || '', JSON.stringify(st), c.status || 'OPEN', st.orderId || null, c.turns, c.aiCalls, c.aiTokens, now, now]);
    c.isNew = false;
  } else {
    await db.query('UPDATE olivia_conversations SET lang = ?, step = ?, state_json = ?, status = ?, order_id = ?, turns = ?, ai_calls = ?, ai_tokens = ?, updated_at = ? WHERE id = ?',
      [c.lang || '', st.step || '', JSON.stringify(st), c.status || 'OPEN', st.orderId || null, c.turns, c.aiCalls, c.aiTokens, now, c.id]);
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
const LINK_BUTTONS = { whatsapp: 'whatsapp', helper: 'helper' };

/** Moves the purchase forward as far as the known slots allow. Returns replies and sets state.step. */
function advance(st, cat, lang, profile) {
  const out = [];
  const services = servicesOf(cat.plans);
  st.services = services;
  if (!st.service || !services.includes(st.service)) {
    st.service = ''; st.step = 'service';
    out.push({ intent: 'ASK_SERVICE', buttons: services.map((x, i) => btn('service:' + i, lang, x)).concat([btn('menu', lang)]) });
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
    st.plan = null; st.step = 'duration';
    st.options = opts.map((p) => ({ service: p.service, plan: p.plan }));
    const title = st.service + (st.variant ? ' ' + (st.variant === 'sharing' ? 'Sharing' : 'Private') : '');
    out.push({
      intent: 'ASK_DURATION', facts: { title },
      buttons: opts.map((p, i) => btn('plan:' + i, lang, words.durationLabel(p.durationDays, lang) + ' · ' + words.rupees(p.price) + (stockOf(cat.stock, p) === 'OUT' ? ' (sold out)' : '')))
        .concat([btn('change', lang), btn('menu', lang)]),
    });
    return out;
  }
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
  out.push({ intent: 'CONFIRM_PLAN', facts: { title: titleOf(chosen, lang), price: chosen.price }, buttons: [btn('pay', lang), btn('change', lang), btn('menu', lang)] });
  return out;
}

function menuReply(st, lang, name) {
  st.step = 'menu';
  return { intent: 'GREET_MENU', facts: { name: firstName(name) }, buttons: ['buy', 'renew', 'household', 'other'].map((id) => btn(id, lang)) };
}
const firstName = (n) => s(n).split(/\s+/)[0].replace(/[^\p{L}.'-]/gu, '').slice(0, 20);
function resetPurchase(st) { for (const k of ['service', 'variant', 'days', 'plan', 'extraValue', 'options', 'title', 'price']) delete st[k]; }

const PAY_STEPS = new Set(['paying', 'backup_name', 'backup_review', 'delivering']);

async function deliverReplies(c, ctx) {
  const st = c.state; const lang = c.lang;
  const r = await tools().deliver(st.orderId, c.phone);
  const f = s(r && r.fulfillment).toUpperCase();
  const title = st.title || '';
  ctx.meta.push({ tool: 'deliver', fulfillment: f || 'NONE' });
  if (f === 'PENDING') { st.step = 'delivering'; ctx.poll = 4; return []; }
  if (f === 'FULFILLED') {
    st.step = 'done'; c.status = 'DONE';
    const a = r.access || {};
    const hasLogin = !!(s(a.user) || s(a.pass) || (Array.isArray(a.logins) && a.logins.length));
    if (ctx.installedApp && hasLogin && !r.accessWithheld) {
      const logins = Array.isArray(a.logins) && a.logins.length > 1 ? a.logins : [a];
      const card = { type: 'access', title, logins: logins.map((x, i) => ({ device: Number(x.device) || i + 1, user: s(x.user), pass: s(x.pass), profileName: s(x.profileName), profileNumber: s(x.profileNumber), profilePin: s(x.profilePin) })), postPaymentMessage: s(r.postPaymentMessage) };
      return [{ intent: 'PAYMENT_RECEIVED_LOGIN_IN_CHAT', facts: { title }, card, buttons: [btn('menu', lang), btn('whatsapp', lang)] }];
    }
    return [{ intent: 'PAYMENT_RECEIVED_LOGIN_EMAILED', facts: { title }, buttons: [btn('menu', lang), btn('whatsapp', lang)] }];
  }
  if (f === 'MANUAL_PENDING') { st.step = 'done'; c.status = 'DONE'; return [{ intent: 'DELIVERY_BEING_SET_UP', facts: { title }, buttons: [btn('menu', lang), btn('whatsapp', lang)] }]; }
  // NO_STOCK / ERROR after payment: a person must help. The customer's money is safe and the order is PAID.
  st.step = 'handoff'; c.status = 'HANDOFF';
  return [{ intent: 'HANDOFF_TO_HUMAN', buttons: [btn('whatsapp', lang), btn('menu', lang)] }];
}

async function turn(c, input, ctx) {
  const st = c.state; const lang = c.lang;
  const choice = s(input.choice);
  const text = s(input.text).slice(0, 500);
  const replies = [];

  // Language first (and any time a language button is pressed).
  if (/^lang:(en|hinglish|hi)$/.test(choice)) {
    c.lang = choice.slice(5);
    replies.push(menuReply(st, c.lang, ctx.profile.name));
    return replies;
  }
  if (!c.lang) {
    if (input.lang && words.LANGS.includes(input.lang)) { c.lang = input.lang; replies.push(menuReply(st, c.lang, ctx.profile.name)); return replies; }
    st.step = 'lang';
    return [{ intent: 'CHOOSE_LANGUAGE', buttons: [btn('lang:hinglish', 'en'), btn('lang:en', 'en'), btn('lang:hi', 'en')] }];
  }
  if (choice === 'start') return [menuReply(st, lang, ctx.profile.name)];

  const allowed = new Set(st.allowed || []);
  let action = '';
  let ents = {};
  if (choice === 'poll') action = PAY_STEPS.has(st.step) ? 'poll' : '';
  else if (choice) action = (allowed.has(choice) || choice === 'menu') ? choice : '';
  else if (text) {
    // Typed answers the current step is waiting for.
    if (st.step === 'own_email' || st.step === 'extra_email') {
      if (EMAIL_RE.test(text)) action = 'email:' + text.toLowerCase();
    } else if (st.step === 'backup_name' && intentOf(text) !== 'menu' && !/^(paid|done)$/i.test(text)) {
      action = 'payer:' + text;
    }
    if (!action) {
      const it = intentOf(text);
      ents = PAY_STEPS.has(st.step) ? {} : entities(text, ctx.cat.plans);
      if (it === 'paid' && PAY_STEPS.has(st.step)) action = 'paid';
      else if (it === 'cantpay' && st.step === 'paying') action = 'cantpay';
      else if (it === 'diff' && (st.step === 'variant' || (st.service && needsVariant(ctx.cat.plans, st.service)) || ents.service)) action = 'diff';
      else if (['renew', 'household', 'other'].includes(it) && !PAY_STEPS.has(st.step)) action = it; // "netflix household problem" is not a purchase
      else if (ents.service || ents.variant || ents.days) action = 'slots';
      else if (it === 'yes' && st.step === 'confirm') action = 'pay';
      else if (it === 'yes' && st.step === 'tv') action = 'tv:yes';
      else if (it === 'no' && st.step === 'tv') action = 'tv:no';
      else if (it === 'menu' || (it === 'buy' && st.step === 'menu')) action = it === 'buy' ? 'buy' : 'menu';
      else if (it === 'buy' && !PAY_STEPS.has(st.step)) action = 'buy';
      if (!action && (st.lastButtons || []).length) {
        const pick = await deps.words.classify(text, (st.lastButtons || []).filter((b) => !LINK_BUTTONS[b.id]), lang, ctx.settings);
        if (pick.tokens) { c.aiCalls++; c.aiTokens += pick.tokens; }
        if (pick.id && allowed.has(pick.id)) action = pick.id;
      }
    }
  }
  ctx.meta.push({ action: action || 'unknown' });

  if (!action) {
    return [{ intent: 'DIDNT_UNDERSTAND', buttons: (st.lastButtons || []).length ? st.lastButtons : menuReply({}, lang).buttons, input: st.lastInput || undefined, keepStep: true }];
  }
  if (action === 'menu') { if (!PAY_STEPS.has(st.step)) resetPurchase(st); return [menuReply(st, lang, ctx.profile.name)]; }
  if (action === 'buy') { resetPurchase(st); return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'renew') { st.step = 'info'; return [{ intent: 'RENEW_ON_SITE', buttons: [btn('menu', lang), btn('whatsapp', lang)] }]; }
  if (action === 'household') { st.step = 'info'; return [{ intent: 'HOUSEHOLD_HELPER', buttons: [btn('helper', lang), btn('whatsapp', lang), btn('menu', lang)] }]; }
  if (action === 'other') { st.step = 'handoff'; return [{ intent: 'HANDOFF_TO_HUMAN', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
  if (action === 'change') { resetPurchase(st); return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'slots') {
    if (ents.service && ents.service !== st.service) { resetPurchase(st); st.service = ents.service; }
    if (ents.variant) { st.variant = ents.variant; st.plan = null; }
    if (ents.days) { st.days = ents.days; st.plan = null; }
    return advance(st, ctx.cat, lang, ctx.profile);
  }
  if (action.startsWith('service:')) { resetPurchase(st); st.service = (st.services || [])[Number(action.slice(8))] || ''; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action.startsWith('variant:')) { st.variant = action.slice(8); st.plan = null; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'diff') {
    const svc = ents.service || st.service;
    const one = (v) => { const o = optionsFor(ctx.cat.plans, svc, v)[0]; return o ? o.benefits : []; };
    st.service = svc; st.step = 'variant';
    return [{ intent: 'EXPLAIN_SHARING_VS_PRIVATE', facts: { sharing: one('sharing'), private: one('private') }, buttons: [btn('variant:sharing', lang), btn('variant:private', lang), btn('menu', lang)] }];
  }
  if (action.startsWith('plan:')) { const o = (st.options || [])[Number(action.slice(5))]; st.plan = o || null; st.extraValue = ''; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action === 'tv:yes' || action === 'tv:no') { st.extraValue = action === 'tv:yes' ? 'TV' : 'NON_TV'; return advance(st, ctx.cat, lang, ctx.profile); }
  if (action.startsWith('email:')) {
    if (st.step === 'extra_email') st.extraValue = action.slice(6); else st.email = action.slice(6);
    return advance(st, ctx.cat, lang, ctx.profile);
  }

  if (action === 'pay') {
    if (st.step !== 'confirm' || !st.plan) return advance(st, ctx.cat, lang, ctx.profile);
    const p = ctx.cat.plans.find((x) => x.service === st.plan.service && x.plan === st.plan.plan);
    if (!p) { resetPurchase(st); return advance(st, ctx.cat, lang, ctx.profile); }
    const key = s(p.extraFieldKey).toUpperCase();
    const r = await tools().createOrder(c.phone, st.plan, {
      name: s(ctx.profile.name) || 'FluxFilm customer', email: st.email || ctx.profile.email,
      extraFieldKey: p.needsExtraField ? key : '', extraFieldValue: p.needsExtraField ? st.extraValue : '',
    });
    ctx.meta.push({ tool: 'createOrder', ok: !!(r && r.ok), orderId: r && r.orderId, paused: !!(r && r.paused), outOfStock: !!(r && r.outOfStock) });
    if (!r || !r.ok) {
      if (r && r.paused) { st.step = 'menu'; return [{ intent: 'SHOP_PAUSED', buttons: [btn('menu', lang), btn('whatsapp', lang)] }]; }
      if (r && r.outOfStock) { st.plan = null; st.days = 0; return [{ intent: 'OUT_OF_STOCK', facts: { title: titleOf(p, lang) } }].concat(advance(st, ctx.cat, lang, ctx.profile)); }
      st.step = 'confirm';
      return [{ intent: 'SOMETHING_WENT_WRONG', buttons: [btn('pay', lang), btn('whatsapp', lang), btn('menu', lang)] }];
    }
    st.orderId = r.orderId; st.amount = r.amount; st.step = 'paying'; st.orderAt = deps.now().getTime();
    ctx.poll = 6;
    return [{
      intent: 'SEND_PAYMENT', facts: { amount: r.amount },
      card: { type: 'pay', orderId: r.orderId, amount: r.amount, upiLink: r.upiLink, qr: 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=' + encodeURIComponent(r.upiLink || '') },
      buttons: [btn('paid', lang), btn('cantpay', lang), btn('menu', lang)],
    }];
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
    return [{ intent: 'PAYMENT_NOT_YET', buttons: [btn('paid', lang), btn('cantpay', lang), btn('whatsapp', lang)], keepStep: true }];
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
    if (r && r.ok === false && r.field === 'name') return [{ intent: 'ASK_PAYER_NAME', facts: { knownName: '' }, input: 'name', buttons: [btn('whatsapp', lang)], keepStep: true }];
    if (!r || (r.ok === false && !r.tooMany)) { st.step = 'handoff'; return [{ intent: 'HANDOFF_TO_HUMAN', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
    if (r.status === 'REJECTED') { st.step = 'handoff'; return [{ intent: 'BACKUP_REJECTED', buttons: [btn('whatsapp', lang), btn('menu', lang)] }]; }
    st.step = 'backup_review'; ctx.poll = 8;
    return [{ intent: 'BACKUP_UNDER_REVIEW', buttons: [btn('whatsapp', lang), btn('menu', lang)] }];
  }
  return [{ intent: 'DIDNT_UNDERSTAND', buttons: st.lastButtons || [], keepStep: true }];
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
    const needsCatalog = !isPoll && !(c.state.step && PAY_STEPS.has(c.state.step) && !s(inp.text));
    if (needsCatalog) ctx.cat = await t.catalogFor();
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
    const w = await deps.words.say(r.intent, facts, c.lang || 'en', ctx.settings);
    if (w.tokens) { c.aiCalls++; c.aiTokens += w.tokens; }
    const buttons = (r.buttons || []).map((b) => (LINK_BUTTONS[b.id] ? Object.assign({ link: LINK_BUTTONS[b.id] }, b) : b));
    const msg = { role: 'olivia', intent: r.intent, text: w.text, buttons };
    if (r.input) msg.input = r.input;
    if (r.card) msg.card = r.card;
    messages.push(msg);
    // Logged for the owner; a login card is recorded only as "[login shown]".
    await logMsg(c.id, 'olivia', r.intent, w.text + (r.card ? (r.card.type === 'access' ? ' [login shown in app]' : ' [' + r.card.type + ' card]') : ''), ctx.meta.length ? ctx.meta : null, w.ai);
  }
  const last = messages[messages.length - 1];
  if (last) {
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
  DEFAULTS, validateSettings, getSettings, saveSettings, status, handle, recent, messagesOf, schemaReady,
  _internal: { setDeps: (d) => { deps = Object.assign({}, deps, d); }, reset: () => { cache = null; schemaOk = null; }, entities, intentOf, chatPlans, needsVariant, optionsFor, titleOf, phoneList },
};
