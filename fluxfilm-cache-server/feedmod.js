/**
 * FluxFilm - 🍿 feed comments auto-moderator (runs on the server BEFORE a comment is saved). Pure: no DB, no network.
 *
 * moderate(text) → { action: 'allow' | 'pending' | 'reject', text, reason, message }
 *   reject  — abusive words (English + Hindi / Hinglish, also "f u c k", "f.u.c.k", "ch*tiya", "sh1t", "fuuuck"),
 *             phone numbers (Indian 10-digit, spaced / dashed / +91 / 0-prefixed / written as words "nine eight …"),
 *             emails, UPI IDs (name@bank), links (https://, www., x.com, t.me, wa.me …),
 *             contact / selling requests ("DM me", "whatsapp karo", "call on", "sasta netflix", "telegram channel" …)
 *   pending — borderline: 7-9 digits in a row, a bare @handle, "whatsapp" / "telegram" / "sasta" / "cheap" alone,
 *             mild words like "bc" / "mc" / "stfu" → saved hidden until the owner approves it in admin
 *   allow   — everything else ("Season 2 kab aayega?", "2024 release", "4K me dekha", "10/10 must watch")
 * The customer only ever sees a friendly message, never which word matched.
 */
const MAX_LEN = 280;

const MESSAGES = {
  empty: 'Write something first.',
  long: 'Please keep it under ' + MAX_LEN + ' characters.',
  abuse: 'Please keep it friendly — that comment has words we don\'t allow.',
  contact: 'For everyone\'s safety, comments can\'t have phone numbers, emails, UPI IDs, links or "contact me" requests. Need help? Tap Help to chat with FluxFilm.',
  pending: 'Thanks! Your comment will show after a quick check.',
};

// ---- abusive words ----
// ANY: found anywhere inside a word (after repeated letters are squeezed: "fuuuck" → "fuck"). Only roots that never
// sit inside a normal English / Hinglish word.
const ANY = ['fuck', 'chutiya', 'chutiye', 'chutia', 'chutiyap', 'madarchod', 'maderchod', 'madarchot', 'maadarchod', 'behenchod', 'bhenchod', 'benchod', 'bhanchod',
  'bhosdike', 'bhosdi', 'bhosda', 'bhosadi', 'bakchod', 'gandu', 'bhadwa', 'bhadwe', 'bastard', 'asshole', 'dickhead', 'bitch', 'whore', 'faggot', 'jhaant', 'jhant', 'randwa', 'harami', 'haramkhor', 'lodu', 'motherchod'];
// EXACT: the whole word only ("shit" but not "Ishita", "chut" but not "chutney", "loda" but not "melody").
const EXACT = ['shit', 'shitty', 'bullshit', 'dick', 'dicks', 'cunt', 'cunts', 'pussy', 'cock', 'lund', 'chut', 'choot', 'gaand', 'gaandu', 'randi', 'randii', 'kutiya', 'chodu',
  'bsdk', 'bkl', 'mkc', 'bhosdk', 'loda', 'lauda', 'lawda', 'lavda', 'lodey', 'hijra', 'nigger', 'nigga', 'niggas', 'slut', 'sluts', 'retard', 'porn'];
// PREFIX: the word starts with it ("shitting", "cunty", "sluttish", "retarded", "niggaz").
const PREFIX = ['shit', 'cunt', 'slut', 'retard', 'nigg', 'pussi', 'bitch', 'chutiy', 'bhosd'];
const DEVANAGARI = ['चूतिया', 'चुतिया', 'मादरचोद', 'बहनचोद', 'भेनचोद', 'भोसडी', 'भोसड़ी', 'भोसड़ी', 'गांडू', 'गाँडू', 'लौड़ा', 'लौड़ा', 'लोड़ा', 'रंडी', 'हरामी', 'भड़वा', 'भड़वा', 'कुतिया', 'चोद'];
// Mild: not blocked, the owner decides.
const MILD = ['bc', 'mc', 'stfu', 'wtf', 'kutta', 'kutte', 'kamina', 'kamine', 'kaminey', 'saala', 'saale', 'tatti', 'suar'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e' };
const squeeze = (w) => w.replace(/(.)\1+/g, '$1');
const ANY_SQ = ANY.map(squeeze);
const EXACT_SET = new Set(EXACT);
const EXACT_SQ = new Set(EXACT.map(squeeze));
const MASK = /[*#%^~]/;

function norm(text) {
  // NFKC turns fancy / full-width letters into plain ones; zero-width characters are dropped.
  return String(text == null ? '' : text).normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').toLowerCase();
}

/** One word → its letters (leet undone), masks kept. "Sh1t!" → "shit", "ch*tiya" → "ch*tiya". */
function wordLetters(tok) {
  let out = '';
  for (const ch of tok) {
    if (/[a-z\u0900-\u097f]/.test(ch)) out += ch;
    else if (MASK.test(ch)) out += '*';
    else if (LEET[ch] != null) out += LEET[ch];
  }
  return out;
}
function abusiveWord(w) {
  if (!w) return false;
  const letters = w.replace(/\*/g, '');
  if (w.includes('*')) {
    if (letters.length < 2 || w.length < 4) return false;
    // Each mask = up to 2 hidden letters; the word must still match a listed word completely.
    const re = new RegExp('^' + w.split('').map((c) => (c === '*' ? '[a-z]{0,2}' : c)).join('') + '$');
    return EXACT.concat(ANY).some((x) => re.test(x));
  }
  if (DEVANAGARI.some((x) => w.includes(x))) return true;
  if (EXACT_SET.has(w) || PREFIX.some((p) => w.startsWith(p))) return true;
  const sq = squeeze(w);
  if (ANY_SQ.some((x) => sq.includes(x))) return true;
  // Stretched words ("shiiiit", "chuuuut"): only when a letter repeats 3+ times, so "choot" ≠ "chot" (injury).
  return /(.)\1\1/.test(w) && EXACT_SQ.has(sq);
}
function findAbuse(text) {
  const toks = norm(text).split(/[\s,;:?"'()[\]{}<>]+/).filter(Boolean);
  const words = toks.map(wordLetters);
  if (words.some(abusiveWord)) return 'abuse';
  // "f u c k", "b h o s d i k e": 3+ one-letter words in a row read as one word.
  let run = '';
  const flush = () => { const hit = run.length >= 3 && (abusiveWord(run) || ANY_SQ.some((x) => squeeze(run).includes(x))); run = ''; return hit; };
  for (const w of words) {
    if (w.length === 1) run += w;
    else if (flush()) return 'abuse';
  }
  if (flush()) return 'abuse';
  // "f.u.c.k" / "f-u-c-k" inside one token already became "fuck" above; "fu ck" (split word):
  const joined = words.join('');
  if (['fuck', 'chutiya', 'madarchod', 'behenchod', 'bhenchod', 'bhosdike'].some((x) => joined.includes(x)) && !words.some((w) => /fuck|chutiya|madarchod|behenchod|bhenchod|bhosdike/.test(w))) {
    // Only when the pieces are short (a real split), not two normal words that happen to meet.
    for (let i = 0; i < words.length - 1; i++) {
      const pair = words[i] + words[i + 1];
      if (words[i].length <= 6 && words[i + 1].length <= 6 && ANY_SQ.some((x) => squeeze(pair).includes(x))) return 'abuse';
    }
  }
  return '';
}
function mildWord(text) {
  return norm(text).split(/[^a-z0-9]+/).some((w) => MILD.includes(w)) ? 'mild word' : '';
}

// ---- numbers ----
const NUM_WORDS = { zero: 0, shunya: 0, sunya: 0, one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, panch: 5, six: 6, chhe: 6, chhah: 6, seven: 7, saat: 7, eight: 8, aath: 8, nine: 9, nau: 9 };
function digitText(text) {
  let t = norm(text);
  t = t.replace(/\b(double|triple)\s+([a-z]+|\d)\b/g, (m, k, d) => { const v = /\d/.test(d) ? d : NUM_WORDS[d]; return v == null ? m : String(v).repeat(k === 'double' ? 2 : 3); });
  t = t.replace(/\b[a-z]+\b/g, (w) => (NUM_WORDS[w] != null ? String(NUM_WORDS[w]) : w));
  // "98765 432l0", "9876-S43210": letters that look like digits inside a mostly-digit word.
  t = t.replace(/[a-z0-9]{5,}/g, (w) => ((w.match(/\d/g) || []).length >= w.length * 0.6 ? w.replace(/o/g, '0').replace(/[il]/g, '1').replace(/s/g, '5') : w));
  return t;
}
function findNumbers(text) {
  const t = digitText(text);
  let worst = '';
  // Digits with at most 2 separators (space . - / ( ) +) between them.
  for (const m of t.match(/\+?\d(?:[\s.\-/()+]{0,2}\d)+/g) || []) {
    let d = m.replace(/\D/g, '');
    if (d.length >= 10) {
      const core = d.length > 10 && /^(91|0|091)/.test(d) ? d.replace(/^(091|91|0)/, '') : d;
      if (/^[6-9]\d{9}$/.test(core) || /^[6-9]\d{9}$/.test(d.slice(-10))) return 'phone';
      worst = 'long number';
    } else if (d.length >= 7 && !worst) worst = 'number';
  }
  return worst;
}

// ---- emails, UPI, links, handles ----
function findContact(text) {
  const t = norm(text);
  // name@bank / a@b.com (no space before @), or "name @ okaxis" (spaces on both sides). "watch @home" is a handle, not this.
  if (/[a-z0-9._%+-](@|\(at\)|\[at\])\s?[a-z][a-z0-9-]{1,}/.test(t) || /[a-z0-9._%+-]\s(@|\(at\)|\[at\])\s[a-z][a-z0-9-]{1,}/.test(t)) return 'email/upi';
  if (/\b(at|@)\s*(gmail|yahoo|ymail|outlook|hotmail|icloud|rediffmail|protonmail)\b/.test(t) || /\b(gmail|yahoo|outlook|hotmail)\s*(dot|\.)\s*com\b/.test(t)) return 'email/upi';
  if (/\b(https?:\/\/|www\.)/.test(t) || /\b(t\.me|wa\.me|bit\.ly|tinyurl|linktr\.ee|chat\.whatsapp)\b/.test(t)) return 'link';
  if (/\b[a-z0-9-]{2,}\.(com|in|net|org|io|me|co|xyz|site|online|shop|store|link|ly|app|info|biz|live|tv|club|top|to|gg)\b/.test(t)) return 'link';
  if (/\b[a-z0-9-]{2,}\s*(\(dot\)|\[dot\]|\sdot\s)\s*(com|in|net|org|me|co)\b/.test(t)) return 'link';
  return '';
}
const STRONG_PHRASES = ['contact me', 'contact us at', 'contact karo', 'contact kro', 'contact kare', 'dm me', 'dm karo', 'dm kro', 'dm for', 'inbox me', 'inbox karo', 'msg me', 'message me', 'ping me',
  'call karo', 'call kro', 'call kare', 'whatsapp me', 'whatsapp karo', 'whatsapp kro', 'whatsapp kar', 'whatsapp on', 'whatsapp number', 'whatsapp no', 'whatsapp group', 'watsapp karo',
  'telegram channel', 'telegram group', 'telegram pe', 'telegram par', 'telegram id', 'tg channel', 'join my group', 'join my channel', 'join our group', 'join channel', 'link in bio', 'check my bio', 'bio me link',
  'sasta netflix', 'sasta prime', 'sasta hotstar', 'cheap netflix', 'cheap prime', 'netflix sasta', 'buy from me', 'i sell', 'we sell', 'selling netflix', 'selling prime', 'selling account',
  'my no is', 'number bhejo', 'number share', 'upi id', 'paytm number', 'gpay number', 'phonepe number',
  'free netflix account', 'earn money', 'paise kamao', 'work from home', 'insta id', 'snap id', 'mujhse lo', 'mujhse kharido', 'hamse kharido'];
const STRONG_SQUASHED = ['whatsappkaro', 'whatsappkro', 'whatsappme', 'watsappkaro', 'contactme', 'sastanetflix', 'cheapnetflix', 'dmkaro', 'callkaro', 'telegramchannel', 'joinmygroup', 'linkinbio'];
const WEAK_WORDS = ['whatsapp', 'watsapp', 'whatsap', 'telegram', 'sasta', 'saste', 'cheap', 'cheaper', 'contact', 'dm', 'reseller'];
// Could be innocent ("call me by your name", "my number 1 show") → the owner decides.
const WEAK_PHRASES = ['my number', 'mera number', 'mera no', 'apna number', 'number do', 'call on', 'call me', 'text me', 'join my'];
function findSolicitation(text) {
  const flat = ' ' + norm(text).replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const squashed = flat.replace(/\s+/g, '');
  if (STRONG_PHRASES.some((p) => flat.includes(' ' + p + ' ')) || STRONG_SQUASHED.some((p) => squashed.includes(p))) return 'contact';
  return '';
}
function findWeak(text) {
  const t = norm(text);
  if (/(^|\s)@[a-z0-9._]{3,}/.test(t)) return 'handle';
  const flat = t.replace(/[^a-z0-9]+/g, ' ').trim();
  const words = flat.split(' ');
  const padded = ' ' + flat + ' ';
  if (words.some((w) => WEAK_WORDS.includes(w)) || WEAK_PHRASES.some((p) => padded.includes(' ' + p + ' ')) || /whatsapp|watsapp|whatsap|telegram/.test(flat.replace(/\s+/g, ''))) return 'contact word';
  return '';
}

/** Storage form: one line, no markup / control characters, trimmed. */
function cleanText(v) {
  return String(v == null ? '' : v).normalize('NFC').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function moderate(input) {
  const text = cleanText(input);
  const out = (action, reason, message) => ({ action, text, reason, message: message || '' });
  if (!text) return out('reject', 'empty', MESSAGES.empty);
  if (text.length > MAX_LEN) return out('reject', 'too long', MESSAGES.long);
  const abuse = findAbuse(text);
  if (abuse) return out('reject', abuse, MESSAGES.abuse);
  const num = findNumbers(text);
  if (num === 'phone') return out('reject', 'phone', MESSAGES.contact);
  const contact = findContact(text) || findSolicitation(text);
  if (contact) return out('reject', contact, MESSAGES.contact);
  const border = num || findWeak(text) || mildWord(text);
  if (border) return out('pending', border, MESSAGES.pending);
  return out('allow', '', '');
}

/** Same text again? (spaces, case, punctuation and emoji ignored) */
function sameKey(text) { return norm(text).replace(/[^a-z0-9\u0900-\u097f]+/g, ''); }

module.exports = { moderate, cleanText, sameKey, MAX_LEN, MESSAGES, _internal: { findAbuse, findNumbers, findContact, findSolicitation, findWeak, digitText, abusiveWord, wordLetters } };
