/**
 * FluxFilm - Olivia's WORDS (the model writes words; code has already decided everything).
 *
 *   template(intent, facts, lang)        → the fixed, always-safe reply (English / Hinglish / Hindi)
 *   say(intent, facts, lang, settings)   → { text, ai } : DeepSeek rewrites the template warmly, and the rewrite is
 *                                          used ONLY if it passes check(); otherwise the template is used.
 *   classify(text, choices, lang, s)     → a choice id from `choices` or '' (model picks among buttons; never invents)
 *
 * The model never receives phone numbers, emails, passwords, order tokens or payment references. The customer's
 * first name goes in as the placeholder {NAME} and is put back afterwards. Every number in the rewrite must already
 * be in the template (so a price, amount or duration can never be invented), and a rewrite may not contain links,
 * '@', or the words password / OTP / UTR.
 *
 * Tone: settings.voice (admin → 🤖 Olivia) is the voice guide from the FluxFilm-AI tone work. Env (Hostinger only):
 * DEEPSEEK_API_KEY, optional DEEPSEEK_MODEL (deepseek-chat), DEEPSEEK_BASE_URL (https://api.deepseek.com).
 */
const s = (v) => String(v == null ? '' : v).trim();
const LANGS = ['en', 'hinglish', 'hi'];
const normLang = (l) => (LANGS.includes(s(l).toLowerCase()) ? s(l).toLowerCase() : 'en');
const rupees = (n) => '₹' + Math.round(Number(n) || 0);

function durationLabel(days, lang) {
  const d = Number(days) || 0;
  const L = normLang(lang);
  if (d >= 360) { const y = Math.round(d / 365) || 1; return L === 'hi' ? y + ' साल' : L === 'hinglish' ? y + ' saal' : y + (y === 1 ? ' year' : ' years'); }
  const m = Math.max(1, Math.round(d / 30));
  if (L === 'hi') return m + ' महीना';
  if (L === 'hinglish') return m + (m === 1 ? ' mahina' : ' mahine');
  return m + (m === 1 ? ' month' : ' months');
}

// Each intent: { en, hinglish, hi } — functions of facts (f). Keep them short: older customers read these on a phone.
const T = {
  CHOOSE_LANGUAGE: {
    en: () => 'Hi, I am Olivia from FluxFilm 👋 Which language is easy for you?',
    hinglish: () => 'Hi, main Olivia hoon FluxFilm se 👋 Aapko kaunsi language aasaan lagegi?',
    hi: () => 'नमस्ते, मैं FluxFilm से Olivia हूँ 👋 आपके लिए कौन सी भाषा आसान है?',
  },
  GREET_MENU: {
    en: (f) => 'Hello' + (f.name ? ' {NAME}' : '') + '! 😊 How can I help you today?',
    hinglish: (f) => 'Hello' + (f.name ? ' {NAME}' : '') + ' ji! 😊 Batayiye, aaj main aapki kya madad karoon?',
    hi: (f) => 'नमस्ते' + (f.name ? ' {NAME}' : '') + ' जी! 😊 बताइए, मैं आपकी क्या मदद करूँ?',
  },
  ASK_SERVICE: {
    en: () => 'Sure! Which one would you like?',
    hinglish: () => 'Zaroor! Aapko kaunsa chahiye?',
    hi: () => 'ज़रूर! आपको कौन सा चाहिए?',
  },
  ASK_SHARING_OR_PRIVATE: {
    en: (f) => f.service + ' comes in two types: Sharing or Private. Which one do you want? You can also ask me the difference.',
    hinglish: (f) => f.service + ' do tarah ka hai: Sharing ya Private. Aapko kaunsa chahiye? Fark poochna ho to bhi bataiye.',
    hi: (f) => f.service + ' दो तरह का है: Sharing या Private. आपको कौन सा चाहिए? फ़र्क पूछना हो तो भी बताइए।',
  },
  EXPLAIN_SHARING_VS_PRIVATE: {
    en: (f) => 'Here is the difference:\n\n🤝 Sharing' + bullets(f.sharing) + '\n\n🔒 Private' + bullets(f.private) + '\n\nWhich one do you want?',
    hinglish: (f) => 'Dono mein fark yeh hai:\n\n🤝 Sharing' + bullets(f.sharing) + '\n\n🔒 Private' + bullets(f.private) + '\n\nAapko kaunsa chahiye?',
    hi: (f) => 'दोनों में फ़र्क यह है:\n\n🤝 Sharing' + bullets(f.sharing) + '\n\n🔒 Private' + bullets(f.private) + '\n\nआपको कौन सा चाहिए?',
  },
  ASK_DURATION: {
    en: (f) => 'Here are the ' + f.title + ' plans. For how long do you want it?',
    hinglish: (f) => 'Yeh rahe ' + f.title + ' ke plans. Kitne time ke liye chahiye?',
    hi: (f) => 'ये रहे ' + f.title + ' के प्लान। कितने समय के लिए चाहिए?',
  },
  OUT_OF_STOCK: {
    en: (f) => 'Sorry, ' + f.title + ' is sold out right now 😔 Please pick another plan.',
    hinglish: (f) => 'Sorry, ' + f.title + ' abhi sold out hai 😔 Koi aur plan chun lijiye.',
    hi: (f) => 'माफ़ कीजिए, ' + f.title + ' अभी खत्म है 😔 कोई और प्लान चुन लीजिए।',
  },
  ASK_TV: {
    en: () => 'Will you watch on a TV?',
    hinglish: () => 'Kya aap TV par dekhenge?',
    hi: () => 'क्या आप TV पर देखेंगे?',
  },
  ASK_EXTRA_EMAIL: {
    en: (f) => 'Please type ' + (f.label || 'the email') + ' for this plan.',
    hinglish: (f) => 'Is plan ke liye ' + (f.label || 'email') + ' type kijiye.',
    hi: (f) => 'इस प्लान के लिए ' + (f.label || 'ईमेल') + ' टाइप कीजिए।',
  },
  ASK_OWN_EMAIL: {
    en: () => 'Please type your email address. Your login details are also sent there.',
    hinglish: () => 'Apna email address type kijiye. Login details wahan bhi bheji jaati hain.',
    hi: () => 'अपना ईमेल पता टाइप कीजिए। लॉगिन की जानकारी वहाँ भी भेजी जाती है।',
  },
  BAD_EMAIL: {
    en: () => 'That email does not look right. Please type it again (example: name@gmail.com).',
    hinglish: () => 'Yeh email sahi nahi lag raha. Dobara type kijiye (jaise: name@gmail.com).',
    hi: () => 'यह ईमेल सही नहीं लग रहा। दोबारा टाइप कीजिए (जैसे: name@gmail.com)।',
  },
  CONFIRM_PLAN: {
    en: (f) => 'You chose ' + f.title + ' for ' + rupees(f.price) + '. Shall I send the payment QR?',
    hinglish: (f) => 'Aapne ' + f.title + ' chuna hai, ' + rupees(f.price) + '. Payment QR bhej doon?',
    hi: (f) => 'आपने ' + f.title + ' चुना है, ' + rupees(f.price) + '। पेमेंट QR भेज दूँ?',
  },
  SEND_PAYMENT: {
    en: (f) => 'Please pay ' + rupees(f.amount) + ' by scanning this QR, or tap "Pay with UPI app". After paying, tap "I have paid".',
    hinglish: (f) => 'Is QR ko scan karke ' + rupees(f.amount) + ' pay kijiye, ya "Pay with UPI app" dabaiye. Pay karne ke baad "I have paid" dabaiye.',
    hi: (f) => 'इस QR को स्कैन करके ' + rupees(f.amount) + ' पे कीजिए, या "Pay with UPI app" दबाइए। पे करने के बाद "I have paid" दबाइए।',
  },
  PAYMENT_NOT_YET: {
    en: () => 'I have not received the payment yet. It can take a minute. I am checking automatically, so please wait here.',
    hinglish: () => 'Payment abhi tak nahi aaya. Kabhi kabhi ek minute lagta hai. Main khud check kar rahi hoon, yahin rukiye.',
    hi: () => 'पेमेंट अभी तक नहीं आया। कभी कभी एक मिनट लगता है। मैं खुद चेक कर रही हूँ, यहीं रुकिए।',
  },
  PAYMENT_RECEIVED_LOGIN_IN_CHAT: {
    en: (f) => 'Payment received ✅ Your ' + f.title + ' is ready! Your login is below, and it is also sent to your email.',
    hinglish: (f) => 'Payment mil gaya ✅ Aapka ' + f.title + ' ready hai! Login neeche hai, aur email par bhi bhej diya hai.',
    hi: (f) => 'पेमेंट मिल गया ✅ आपका ' + f.title + ' तैयार है! लॉगिन नीचे है, और ईमेल पर भी भेज दिया है।',
  },
  PAYMENT_RECEIVED_LOGIN_EMAILED: {
    en: (f) => 'Payment received ✅ Your ' + f.title + ' is ready! Your login details are sent to your email. You can also see them in My plans.',
    hinglish: (f) => 'Payment mil gaya ✅ Aapka ' + f.title + ' ready hai! Login details aapke email par bhej di hain. My plans mein bhi dikhengi.',
    hi: (f) => 'पेमेंट मिल गया ✅ आपका ' + f.title + ' तैयार है! लॉगिन की जानकारी आपके ईमेल पर भेज दी है। My plans में भी दिखेगी।',
  },
  DELIVERY_BEING_SET_UP: {
    en: (f) => 'Payment received ✅ Your ' + f.title + ' is being set up by our team. You will get it soon on your email.',
    hinglish: (f) => 'Payment mil gaya ✅ Aapka ' + f.title + ' hamari team set up kar rahi hai. Jaldi hi email par mil jayega.',
    hi: (f) => 'पेमेंट मिल गया ✅ आपका ' + f.title + ' हमारी टीम सेट कर रही है। जल्दी ही ईमेल पर मिल जाएगा।',
  },
  CANT_PAY_BACKUP_QR: {
    en: (f) => 'No problem! Please pay ' + rupees(f.amount) + ' using this QR instead (type the amount yourself).',
    hinglish: (f) => 'Koi baat nahi! Is QR se ' + rupees(f.amount) + ' pay kar dijiye (amount khud type karna hoga).',
    hi: (f) => 'कोई बात नहीं! इस QR से ' + rupees(f.amount) + ' पे कर दीजिए (अमाउंट खुद टाइप करना होगा)।',
  },
  ASK_PAYER_NAME: {
    en: (f) => f.knownName ? 'After paying, is the name in your UPI app "{PAYER}"? If not, type the name exactly as your UPI app shows.' : 'After paying, type your name exactly as it shows in your UPI app.',
    hinglish: (f) => f.knownName ? 'Pay karne ke baad, kya aapke UPI app mein naam "{PAYER}" hai? Nahi to UPI app wala naam type kijiye.' : 'Pay karne ke baad, UPI app mein jo naam dikhta hai woh type kijiye.',
    hi: (f) => f.knownName ? 'पे करने के बाद, क्या आपके UPI ऐप में नाम "{PAYER}" है? नहीं तो UPI ऐप वाला नाम टाइप कीजिए।' : 'पे करने के बाद, UPI ऐप में जो नाम दिखता है वह टाइप कीजिए।',
  },
  BACKUP_UNDER_REVIEW: {
    en: () => 'Thank you! I am matching your payment now. This usually takes a few minutes, please stay here.',
    hinglish: () => 'Thank you! Main aapka payment match kar rahi hoon. Thode minute lagte hain, yahin rukiye.',
    hi: () => 'धन्यवाद! मैं आपका पेमेंट मिला रही हूँ। थोड़े मिनट लगते हैं, यहीं रुकिए।',
  },
  BACKUP_REJECTED: {
    en: () => 'Sorry, I could not find this payment. If money was deducted, please send the screenshot to us on WhatsApp.',
    hinglish: () => 'Sorry, yeh payment nahi mila. Agar paise kat gaye hain to screenshot WhatsApp par bhej dijiye.',
    hi: () => 'माफ़ कीजिए, यह पेमेंट नहीं मिला। अगर पैसे कट गए हैं तो स्क्रीनशॉट WhatsApp पर भेज दीजिए।',
  },
  SHOP_PAUSED: {
    en: () => 'New orders are paused for a short maintenance 🚧 Please try again in a little while. Your plans are safe.',
    hinglish: () => 'Thodi der ke liye naye orders band hain 🚧 Thodi der baad try kijiye. Aapke plans safe hain.',
    hi: () => 'थोड़ी देर के लिए नए ऑर्डर बंद हैं 🚧 थोड़ी देर बाद कोशिश कीजिए। आपके प्लान सुरक्षित हैं।',
  },
  FINISH_ON_WEBSITE: {
    en: (f) => f.title + ' needs a few extra choices, so please buy it from the Buy page on the website. Or I can help you with another plan.',
    hinglish: (f) => f.title + ' mein kuch extra options hain, isliye ise website ke Buy page se lijiye. Ya main koi aur plan dilwa doon?',
    hi: (f) => f.title + ' में कुछ और विकल्प हैं, इसलिए इसे वेबसाइट के Buy पेज से लीजिए। या मैं कोई और प्लान दिलवा दूँ?',
  },
  RENEW_ON_SITE: {
    en: () => 'To renew, open My plans and tap Renew on your plan. Renewing in chat is coming soon.',
    hinglish: () => 'Renew karne ke liye My plans kholiye aur apne plan par Renew dabaiye. Chat se renew jaldi aayega.',
    hi: () => 'रिन्यू करने के लिए My plans खोलिए और अपने प्लान पर Renew दबाइए। चैट से रिन्यू जल्दी आएगा।',
  },
  HOUSEHOLD_HELPER: {
    en: () => 'Netflix says "not part of your household" or your TV asks for a code? Open the Household Helper and follow the steps. Automatic fixing in chat is coming soon.',
    hinglish: () => 'Netflix "not part of your household" bol raha hai ya TV code maang raha hai? Household Helper kholiye aur steps follow kijiye. Chat se automatic fix jaldi aayega.',
    hi: () => 'Netflix "not part of your household" बोल रहा है या TV कोड माँग रहा है? Household Helper खोलिए और स्टेप्स फॉलो कीजिए। चैट से अपने आप ठीक करना जल्दी आएगा।',
  },
  DIDNT_UNDERSTAND: {
    en: () => 'Sorry, I did not understand that 🙏 Please tap one of the options below.',
    hinglish: () => 'Sorry, samajh nahi aaya 🙏 Neeche diye options mein se ek dabaiye.',
    hi: () => 'माफ़ कीजिए, समझ नहीं आया 🙏 नीचे दिए विकल्पों में से एक दबाइए।',
  },
  HANDOFF_TO_HUMAN: {
    en: () => 'I will connect you with our team on WhatsApp. Tap the button below 👇',
    hinglish: () => 'Main aapko hamari team se WhatsApp par connect karti hoon. Neeche button dabaiye 👇',
    hi: () => 'मैं आपको हमारी टीम से WhatsApp पर जोड़ती हूँ। नीचे बटन दबाइए 👇',
  },
  SOMETHING_WENT_WRONG: {
    en: () => 'Sorry, something went wrong on my side. Please try again, or talk to our team on WhatsApp.',
    hinglish: () => 'Sorry, meri taraf se kuch gadbad ho gayi. Dobara try kijiye, ya WhatsApp par team se baat kijiye.',
    hi: () => 'माफ़ कीजिए, मेरी तरफ़ से कुछ गड़बड़ हो गई। दोबारा कोशिश कीजिए, या WhatsApp पर टीम से बात कीजिए।',
  },
};
function bullets(list) {
  const items = (Array.isArray(list) ? list : []).map(s).filter(Boolean).slice(0, 5);
  return items.length ? '\n' + items.map((x) => '• ' + x).join('\n') : '';
}

// Button labels (fixed text, never model-written).
const B = {
  'lang:en': { en: 'English', hinglish: 'English', hi: 'English' },
  'lang:hinglish': { en: 'Hinglish ⭐ suggested', hinglish: 'Hinglish ⭐ suggested', hi: 'Hinglish ⭐ suggested' },
  'lang:hi': { en: 'हिंदी', hinglish: 'हिंदी', hi: 'हिंदी' },
  buy: { en: '🛒 Buy a plan', hinglish: '🛒 Plan khareedna hai', hi: '🛒 प्लान खरीदना है' },
  renew: { en: '🔁 Renew my plan', hinglish: '🔁 Plan renew karna hai', hi: '🔁 प्लान रिन्यू करना है' },
  household: { en: '🏠 Netflix household problem', hinglish: '🏠 Netflix household problem', hi: '🏠 Netflix household समस्या' },
  other: { en: '💬 Something else', hinglish: '💬 Kuch aur', hi: '💬 कुछ और' },
  'variant:sharing': { en: '🤝 Sharing', hinglish: '🤝 Sharing', hi: '🤝 Sharing' },
  'variant:private': { en: '🔒 Private', hinglish: '🔒 Private', hi: '🔒 Private' },
  diff: { en: '❓ What is the difference?', hinglish: '❓ Dono mein fark kya hai?', hi: '❓ दोनों में फ़र्क क्या है?' },
  'tv:yes': { en: '📺 Yes, on TV', hinglish: '📺 Haan, TV par', hi: '📺 हाँ, TV पर' },
  'tv:no': { en: '📱 No, phone / laptop', hinglish: '📱 Nahi, phone / laptop', hi: '📱 नहीं, फ़ोन / लैपटॉप' },
  pay: { en: '✅ Yes, send QR', hinglish: '✅ Haan, QR bhejo', hi: '✅ हाँ, QR भेजो' },
  change: { en: '↩️ Change plan', hinglish: '↩️ Plan badlo', hi: '↩️ प्लान बदलो' },
  paid: { en: '✅ I have paid', hinglish: '✅ I have paid', hi: '✅ I have paid' },
  cantpay: { en: '⚠️ Payment not working', hinglish: '⚠️ Payment nahi ho raha', hi: '⚠️ पेमेंट नहीं हो रहा' },
  'payer:known': { en: '✅ Yes, that is my name', hinglish: '✅ Haan, yahi naam hai', hi: '✅ हाँ, यही नाम है' },
  menu: { en: '🏠 Main menu', hinglish: '🏠 Main menu', hi: '🏠 मेन मेन्यू' },
  whatsapp: { en: '💬 WhatsApp our team', hinglish: '💬 WhatsApp par team', hi: '💬 WhatsApp पर टीम' },
  helper: { en: '🏠 Open Household Helper', hinglish: '🏠 Household Helper kholo', hi: '🏠 Household Helper खोलो' },
};
function buttonLabel(id, lang, fallback) {
  const b = B[id];
  return b ? b[normLang(lang)] : (fallback || id);
}

function template(intent, facts, lang) {
  const t = T[intent];
  if (!t) return '';
  return t[normLang(lang)](facts || {});
}
function fill(text, facts) {
  return String(text).replace(/\{NAME\}/g, s(facts && facts.name)).replace(/\{PAYER\}/g, s(facts && facts.knownName));
}

const numbersIn = (t) => (String(t).match(/\d+/g) || []);
/** A rewrite is used only if it cannot have changed a fact. */
function check(rewrite, base) {
  const r = s(rewrite);
  if (!r || r.length > Math.max(400, base.length * 2 + 80)) return false;
  if (/https?:|www\.|@|password|passcode|\botp\b|\butr\b/i.test(r)) return false;
  const allowed = new Set(numbersIn(base));
  if (numbersIn(r).some((n) => !allowed.has(n))) return false;
  // Every rupee amount and every placeholder in the template must survive unchanged.
  for (const amt of (base.match(/₹\d+/g) || [])) if (!r.includes(amt)) return false;
  for (const ph of (base.match(/\{NAME\}|\{PAYER\}/g) || [])) if (!r.includes(ph)) return false;
  return true;
}

const LANG_NAME = { en: 'simple English', hinglish: 'Hinglish (Hindi written in English letters, the way Indians chat on WhatsApp)', hi: 'simple Hindi in Devanagari script' };

async function callModel(messages, opts) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 8000);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', temperature: 0.4, max_tokens: 300, response_format: { type: 'json_object' }, messages }),
    });
    if (!r.ok) { console.log('[olivia] model HTTP', r.status); return null; }
    const body = await r.json();
    const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    const usage = (body && body.usage) || {};
    try { return { json: JSON.parse(content || '{}'), tokens: Number(usage.total_tokens) || 0 }; } catch (_) { return null; }
  } catch (e) {
    console.log('[olivia] model call failed:', e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  } finally { clearTimeout(timer); }
}

/** deps.model(messages) can replace callModel in tests. */
async function say(intent, facts, lang, settings, deps) {
  const L = normLang(lang);
  const base = template(intent, facts, L);
  const out = { text: fill(base, facts), ai: false, tokens: 0 };
  const st = settings || {};
  if (!st.aiWords || !base) return out;
  const model = (deps && deps.model) || callModel;
  const system = [
    'You are Olivia, the friendly store manager of FluxFilm, an Indian streaming-subscription shop. Many customers are older and not good with technology.',
    'Rewrite the given reply so it sounds warm, simple and human, in ' + LANG_NAME[L] + '. Keep it short (at most 3 short sentences unless it is a list).',
    'STRICT RULES: keep every fact exactly. Do not add or change any number, price, amount, duration, plan name or promise. Keep ₹ amounts exactly as written.',
    'Keep placeholders like {NAME} and {PAYER} exactly as they are. Do not add links, emails, passwords, codes or new steps. Do not say payment is received unless the reply already says so.',
    st.voice ? 'Voice guide from the owner: ' + String(st.voice).slice(0, 2000) : '',
    'Answer as JSON: {"text": "..."}',
  ].filter(Boolean).join('\n');
  const res = await model([{ role: 'system', content: system }, { role: 'user', content: 'Reply type: ' + intent + '\nReply to rewrite:\n' + base }]);
  if (!res || !res.json) return out;
  out.tokens = res.tokens || 0;
  const rewrite = s(res.json.text);
  if (!check(rewrite, base)) return out;
  return { text: fill(rewrite, facts), ai: true, tokens: out.tokens };
}

/** Pick which button the customer meant. Returns one of the ids or ''. */
async function classify(text, choices, lang, settings, deps) {
  const st = settings || {};
  if (!st.aiWords || !s(text) || !Array.isArray(choices) || !choices.length) return { id: '', tokens: 0 };
  const model = (deps && deps.model) || callModel;
  const list = choices.map((c) => '- ' + c.id + ': ' + c.label).join('\n');
  const res = await model([
    { role: 'system', content: 'You map a customer message from an Indian streaming shop chat (English, Hindi or Hinglish) to ONE of the listed option ids. If none clearly fits, answer "". Answer as JSON: {"id": "..."}' },
    { role: 'user', content: 'Options:\n' + list + '\n\nCustomer message: ' + String(text).slice(0, 300) },
  ]);
  const id = res && res.json ? s(res.json.id) : '';
  return { id: choices.some((c) => c.id === id) ? id : '', tokens: (res && res.tokens) || 0 };
}

module.exports = { LANGS, normLang, template, say, classify, check, buttonLabel, durationLabel, rupees, INTENTS: Object.keys(T), _internal: { T, B, fill } };
