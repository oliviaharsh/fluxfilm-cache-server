/**
 * FluxFilm — ✨ Ask: the admin assistant (owner request 23 Sep 2026: "add an AI in admin - it just need to call
 * existing functions - sometimes i can ask normal que like create a strong password for this account, or create
 * a renewal order for this customer name or so").
 *
 * Same principle as Olivia: **the decision is code, the words are the model.** This file owns a short, fixed list
 * of things the panel can already do. A typed sentence is turned into one of them plus its arguments — first by
 * plain rules (free, instant, and they work with no API key), and only if those miss, by the model, which is
 * allowed to answer with nothing except one tool name from that list and its arguments. Whatever comes back is
 * re-checked here before anything runs.
 *
 * ⚠️ **It never writes anything.** It answers a question, or it takes the owner to the right screen with the right
 * thing already filled in — a renewal opens ⚡ Quick order on that customer's plan, ready for the owner to price
 * and confirm. Creating orders, changing passwords and moving customers stay a deliberate tap by a person; a
 * sentence typed into a box is not a good enough reason to take money or change someone's login.
 *
 * What the model is given: only the sentence the owner typed and the list of tool names. Never a customer list,
 * never a login, never a password. What it may return: one tool name and a few short strings.
 *
 * Routes (admin key / session, mounted by admin.js):
 *   GET  /admin/api/ask/examples     the chips under the box
 *   POST /admin/api/ask  { text }    → { ok, understood, tool, title, lines, copy?, nav?, note?, source }
 */
const crypto = require('crypto');

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const low = (v) => s(v).toLowerCase();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (v) => { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : s(v); };

/** Everything ✨ Ask can do. The model may answer with one of these names and nothing else. */
const TOOLS = [
  { name: 'password.suggest', what: 'Make a strong password, for an account if one is named' },
  { name: 'customer.find', what: 'Find a customer by name or phone number and open Customer 360' },
  { name: 'order.renew', what: 'Start a renewal for a customer: open Quick order on their running plan' },
  { name: 'order.new', what: 'Start a new order for a customer' },
  { name: 'stock.out', what: 'Which plans are out of stock or running low' },
  { name: 'money.due', what: 'Who still owes money (receivables)' },
  { name: 'account.moveOff', what: 'Move everyone off an account that is switched off' },
  { name: 'open', what: 'Open an admin screen by name' },
];
const TOOL_NAMES = TOOLS.map((t) => t.name);

const EXAMPLES = [
  'strong password for PRI-32',
  'renew Swayam',
  'find 9971430096',
  "what's out of stock",
  'who owes money',
  'open bank payments',
];

/** The admin screens ✨ Ask can send the owner to (the MENU keys admin.html knows). */
const SCREENS = {
  today: ['today', 'home', 'dashboard today'], dashboard: ['dashboard', 'charts'], quick: ['quick order', 'quick', 'new order'],
  receivables: ['receivables', 'credit', 'money due', 'owes'], orders: ['orders'], refunds: ['refunds'], payments: ['payments'],
  bank: ['bank payments', 'bank'], promos: ['offers', 'promos'], feed: ["what's new", 'whats new', 'feed'],
  maintenance: ['maintenance'], olivia: ['olivia'], stock: ['stock'], removeusers: ['remove users'],
  otpdevices: ['otp devices', 'otp'], password: ['password change', 'password'], profit: ['profit'],
  customer: ['customer 360', 'customer'], reminders: ['reminders'], push: ['notifications'], referrals: ['referrals'],
  coins: ['coins'], games: ['games'], data: ['sheets'], plans: ['plans'], coupons: ['coupons'], audit: ['change log', 'audit'],
  integrations: ['integrations'], reports: ['reports'], exports: ['exports', 'download'],
};

// ── a strong password ────────────────────────────────────────────────────────────────────────────────────────
// No l/I/1/O/0: the owner reads these out and types them into a TV. One of each kind, then shuffled.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const MARK = '@#$%&*!?';
function pick(set, n) { let o = ''; for (let i = 0; i < n; i++) o += set[crypto.randomInt(0, set.length)]; return o; }
function strongPassword(len) {
  const n = Math.max(12, Math.min(24, Number(len) || 14));
  const chars = (pick(UPPER, 2) + pick(LOWER, n - 6) + pick(DIGIT, 3) + pick(MARK, 1)).split('');
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); const t = chars[i]; chars[i] = chars[j]; chars[j] = t; }
  return chars.join('');
}

// ── reading the sentence ─────────────────────────────────────────────────────────────────────────────────────
const ACCOUNT_RE = /\b([A-Z]{2,6}-[A-Z0-9-]{1,12})\b/;
const PHONE_RE = /\b(\d{10})\b/;

/** Rules first: the sentences the owner actually types. → { tool, args } or null. */
function readRules(text) {
  const t = low(text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const acc = (s(text).toUpperCase().match(ACCOUNT_RE) || [])[1] || '';
  const phone = (t.match(PHONE_RE) || [])[1] || '';

  if (/\b(password|pwd)\b/.test(t) && /\b(strong|new|make|create|generate|suggest|give|random)\b/.test(t)) {
    return { tool: 'password.suggest', args: { accountId: acc } };
  }
  if (/\b(out of stock|no stock|sold out|stock)\b/.test(t) && !/\b(open|go to|show me the)\b/.test(t)) return { tool: 'stock.out', args: {} };
  if (/\b(owes|owing|due|receivable|receivables|pending payment|not paid)\b/.test(t)) return { tool: 'money.due', args: {} };
  if (/\b(move|transfer|shift)\b/.test(t) && /\b(everyone|everybody|all|customers)\b/.test(t)) return { tool: 'account.moveOff', args: { accountId: acc } };
  if (/\b(renew|renewal)\b/.test(t)) return { tool: 'order.renew', args: { who: whoFrom(text), phone } };
  if (/\b(new order|create order|buy|sell)\b/.test(t)) return { tool: 'order.new', args: { who: whoFrom(text), phone } };
  if (/\b(find|search|look up|lookup|show|who is|details of)\b/.test(t) || phone) return { tool: 'customer.find', args: { who: whoFrom(text), phone } };
  const screen = screenFrom(t);
  if (screen) return { tool: 'open', args: { screen } };
  return null;
}

/** "renew swayam's netflix" → "swayam". The words around the command are dropped, never the name. */
function whoFrom(text) {
  let t = s(text).replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/['’]s\b/gu, '');
  const drop = /\b(renew|renewal|for|the|of|a|an|order|create|make|start|new|plan|please|pls|customer|find|search|look|up|lookup|show|me|who|is|details|account|his|her|their|netflix|prime|video|jiohotstar|hotstar|zee5?|sonyliv|sony|crunchyroll|youtube|premium|sharing|private|month|months|year|years|device|devices)\b/gi;
  t = t.replace(drop, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').filter((w) => w.length > 1).slice(0, 3).join(' ');
}

function screenFrom(t) {
  const m = t.replace(/\b(open|go to|show|take me to|switch to)\b/g, ' ').replace(/\s+/g, ' ').trim();
  let best = '';
  for (const key of Object.keys(SCREENS)) {
    for (const word of SCREENS[key]) {
      if (m === word || (m.length > 2 && m.indexOf(word) > -1 && word.length > (best ? SCREENS[best][0].length : 0))) best = key;
    }
  }
  return /\b(open|go to|show|take me to|switch to)\b/.test(t) ? best : '';
}

/**
 * The model, only when the rules miss. It is given the sentence and the tool names — nothing else — and must
 * answer with JSON. Anything that is not one of our tools is thrown away.
 */
async function readModel(text, deps) {
  const call = (deps && deps.model) || require('./oliviawords').callModel;
  const sys = 'You route one sentence from a shop owner to exactly one tool of an admin panel. Answer ONLY with JSON: '
    + '{"tool":"<one of: ' + TOOL_NAMES.join(', ') + '>","who":"<a customer name if the sentence names one, else empty>",'
    + '"accountId":"<an inventory account id like PRI-32 if named, else empty>","screen":"<an admin screen name if the sentence asks to open one, else empty>"}. '
    + 'Tools: ' + TOOLS.map((x) => x.name + ' = ' + x.what).join('; ') + '. '
    + 'If nothing fits, answer {"tool":""}. Never invent a name or an id that is not in the sentence.';
  let out = null;
  try { out = await call([{ role: 'system', content: sys }, { role: 'user', content: s(text).slice(0, 300) }], { maxTokens: 120, temperature: 0 }); } catch (_) { out = null; }
  const j = out && out.json;
  if (!j || !TOOL_NAMES.includes(s(j.tool))) return null;
  return { tool: s(j.tool), args: { who: s(j.who).slice(0, 60), phone: norm(j.who), accountId: s(j.accountId).toUpperCase().slice(0, 24), screen: s(j.screen).toLowerCase().slice(0, 24) } };
}

// ── doing the (read-only) work ───────────────────────────────────────────────────────────────────────────────
function make(deps) {
  const d = deps || {};
  const db = d.db || require('./db');
  const q = (sql, p) => db.query(sql, p || []);

  async function findCustomers(who, phone) {
    const ph = norm(phone) || norm(who);
    if (ph.length === 10) return q('SELECT phone_norm, name, email FROM customers WHERE phone_norm = ? LIMIT 5', [ph]);
    const name = s(who);
    if (name.length < 2) return [];
    return q('SELECT phone_norm, name, email FROM customers WHERE name LIKE ? ORDER BY name LIMIT 5', ['%' + name + '%']);
  }

  const run = {
    async 'password.suggest'(args) {
      const pw = strongPassword(14);
      const acc = s(args.accountId).toUpperCase();
      let known = null;
      if (acc) { const r = await q('SELECT service, account_id, login_id FROM inventory_accounts WHERE account_id = ? LIMIT 1', [acc]); known = r[0] || null; }
      return {
        tool: 'password.suggest',
        title: '🔑 A strong password' + (known ? ' for ' + known.account_id : ''),
        lines: known
          ? [known.service + ' · ' + known.account_id + ' · ' + s(known.login_id), 'Change it on ' + known.service + ' itself, then save it here so every customer on it gets the new one.']
          : (acc ? ['No account called ' + acc + ' — the password is still yours to use.'] : ['14 characters, no letters you can mistake for numbers (no l, I, 1, O, 0).']),
        copy: pw,
        nav: known ? { view: 'password', account: { service: known.service, accountId: known.account_id }, password: pw } : null,
        note: known ? 'Opens 🔑 Password change on this account with the new password filled in — nothing is saved until you press it there.' : '',
      };
    },

    async 'customer.find'(args) {
      const rows = await findCustomers(args.who, args.phone);
      if (!rows.length) return { tool: 'customer.find', title: '🔍 No customer found', lines: [s(args.who) || s(args.phone) ? 'Nothing matches “' + (s(args.who) || s(args.phone)) + '”.' : 'Tell me a name or a 10-digit number.'] };
      return {
        tool: 'customer.find',
        title: rows.length === 1 ? '🔍 ' + s(rows[0].name || rows[0].phone_norm) : '🔍 ' + rows.length + ' customers match',
        lines: rows.map((r) => s(r.name || '—') + ' · ' + s(r.phone_norm) + (s(r.email) ? ' · ' + s(r.email) : '')),
        people: rows.map((r) => ({ name: s(r.name), phone: s(r.phone_norm) })),
        nav: rows.length === 1 ? { view: 'customer', phone: s(rows[0].phone_norm) } : null,
      };
    },

    async 'order.renew'(args) { return orderFor(args, 'renew'); },
    async 'order.new'(args) { return orderFor(args, 'new'); },

    async 'stock.out'() {
      const plans = await q('SELECT service, plan, duration_days, price, is_active, raw_json FROM plans', []);
      let levels = {};
      try { levels = await (d.stock || require('./stock')).computeStockLevels(plans); } catch (e) { return { tool: 'stock.out', title: '📦 Stock', lines: ['Live stock could not be counted: ' + s(e.message)] }; }
      const out = []; const lowStock = [];
      for (const k of Object.keys(levels)) {
        const lv = levels[k]; const nice = k.split('|||').join(' · ');
        if (s(lv.stockLevel).toUpperCase() === 'OUT') out.push(nice);
        else if (s(lv.stockLevel).toUpperCase() === 'LOW') lowStock.push(nice + (lv.stock != null ? ' (' + lv.stock + ' left)' : ''));
      }
      return {
        tool: 'stock.out',
        title: out.length ? '🔴 ' + out.length + ' plan' + (out.length === 1 ? '' : 's') + ' out of stock' : '✅ Nothing is out of stock',
        lines: out.concat(lowStock.length ? ['', '🟡 Running low:'].concat(lowStock) : []),
        nav: { view: 'stock' },
      };
    },

    async 'money.due'() {
      const rows = await q("SELECT order_id, name, phone_norm, service, plan, final_amount, created_at_sheet FROM orders WHERE UPPER(status) = 'CREDIT' ORDER BY created_at_sheet DESC LIMIT 20", []);
      const total = rows.reduce((n, r) => n + (Number(r.final_amount) || 0), 0);
      return {
        tool: 'money.due',
        title: rows.length ? '💳 ₹' + total + ' due from ' + new Set(rows.map((r) => s(r.phone_norm))).size + ' customer(s)' : '✅ Nobody owes anything',
        lines: rows.map((r) => s(r.name || '—') + ' · ' + s(r.service) + ' ' + s(r.plan) + ' · ₹' + (Number(r.final_amount) || 0) + ' · ' + s(r.order_id)),
        nav: rows.length ? { view: 'receivables' } : null,
      };
    },

    async 'account.moveOff'(args) {
      const acc = s(args.accountId).toUpperCase();
      if (!acc) return { tool: 'account.moveOff', title: '🔁 Which account?', lines: ['Say the account id, like "move everyone off PRI-32".'] };
      const r = await q('SELECT service, account_id, is_active FROM inventory_accounts WHERE account_id = ? LIMIT 1', [acc]);
      if (!r.length) return { tool: 'account.moveOff', title: '🔁 No account ' + acc, lines: ['Check the id on 📦 Stock or 🔑 Password change.'] };
      const on = await q("SELECT COUNT(*) n FROM subscriptions WHERE (inventory_ref = ? OR inventory_ref LIKE ?) AND UPPER(status) = 'ACTIVE' AND expiry_date > NOW()", [acc, acc + '#%']);
      const n = Number(on[0] && on[0].n) || 0;
      return {
        tool: 'account.moveOff',
        title: '🔁 ' + acc + ' · ' + n + ' customer' + (n === 1 ? '' : 's') + ' on it',
        lines: [s(r[0].service) + ' · ' + (s(r[0].is_active).toUpperCase() === 'TRUE' ? 'switched on' : '⏸ switched off')],
        nav: { view: 'password', account: { service: s(r[0].service), accountId: acc } },
        note: n ? 'Opens 🔑 Password change on this account, where 🔁 Move everyone to another account lives.' : 'Nobody is on it, so there is nobody to move.',
      };
    },

    async open(args) {
      const key = SCREENS[s(args.screen)] ? s(args.screen) : screenFrom('open ' + low(args.screen));
      if (!key) return { tool: 'open', title: '🧭 Which screen?', lines: ['Try "open bank payments", "open plans", "open profit".'] };
      return { tool: 'open', title: '🧭 Opening ' + key, lines: [], nav: { view: key } };
    },
  };

  async function orderFor(args, mode) {
    const people = await findCustomers(args.who, args.phone);
    if (!people.length) {
      return { tool: 'order.' + mode, title: '🔍 Which customer?', lines: [s(args.who) ? 'Nothing matches “' + s(args.who) + '”.' : 'Tell me the name or the 10-digit number.'], nav: { view: 'quick' } };
    }
    if (people.length > 1) {
      return { tool: 'order.' + mode, title: '🔍 ' + people.length + ' customers match', lines: people.map((r) => s(r.name) + ' · ' + s(r.phone_norm)), people: people.map((r) => ({ name: s(r.name), phone: s(r.phone_norm) })) };
    }
    const p = people[0];
    const subs = mode === 'renew'
      ? await q("SELECT sub_id, service, plan, expiry_date FROM subscriptions WHERE phone_norm = ? AND UPPER(status) = 'ACTIVE' ORDER BY expiry_date LIMIT 6", [s(p.phone_norm)])
      : [];
    if (mode === 'renew' && !subs.length) {
      return { tool: 'order.renew', title: '🔁 ' + s(p.name) + ' has no running plan', lines: ['Nothing active to renew — start a new order instead.'], nav: { view: 'quick', tab: 'new', phone: s(p.phone_norm), customer: { name: s(p.name), phone: s(p.phone_norm), email: s(p.email) } } };
    }
    return {
      tool: 'order.' + mode,
      title: (mode === 'renew' ? '🔁 Renew for ' : '🛒 New order for ') + s(p.name || p.phone_norm),
      lines: mode === 'renew'
        ? subs.map((x) => s(x.service) + ' · ' + s(x.plan) + ' · ends ' + prettyDate(x.expiry_date))
        : [s(p.phone_norm) + (s(p.email) ? ' · ' + s(p.email) : '')],
      nav: { view: 'quick', tab: mode === 'renew' ? 'renew' : 'new', phone: s(p.phone_norm), customer: { name: s(p.name), phone: s(p.phone_norm), email: s(p.email) }, subId: subs.length === 1 ? s(subs[0].sub_id) : '' },
      note: 'Opens ⚡ Quick order with this customer chosen. Nothing is created until you press it there.',
    };
  }

  /** The whole job: read the sentence, do the read-only work, hand back what to show. */
  async function ask(text, opts) {
    const t = s(text);
    if (!t) return { ok: true, understood: false, title: '✨ Ask me something', lines: EXAMPLES.map((x) => '“' + x + '”') };
    let plan = readRules(t);
    let source = 'rules';
    if (!plan && !(opts && opts.noModel)) { plan = await readModel(t, d); source = 'model'; }
    if (!plan) {
      return { ok: true, understood: false, source: 'rules', title: "✨ I did not understand that", lines: ['Try one of these:'].concat(EXAMPLES.map((x) => '“' + x + '”')) };
    }
    const fn = run[plan.tool];
    if (!fn) return { ok: true, understood: false, source, title: '✨ I cannot do that yet', lines: TOOLS.map((x) => x.what) };
    const out = await fn(plan.args || {});
    return Object.assign({ ok: true, understood: true, source }, out);
  }

  return { ask, run, readRules, readModel, strongPassword, TOOLS, EXAMPLES };
}

function mount(app, deps) {
  const { auth } = deps;
  const A = make(deps);
  const fail = (res, e) => res.status(500).json({ ok: false, message: String((e && e.message) || e) });

  app.get('/admin/api/ask/examples', (req, res) => {
    if (!auth(req, res)) return;
    res.json({ ok: true, examples: EXAMPLES, tools: TOOLS, aiKeySet: !!process.env.DEEPSEEK_API_KEY });
  });

  app.post('/admin/api/ask', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await A.ask(s((req.body || {}).text).slice(0, 300))); } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, make, strongPassword, readRules, TOOLS, EXAMPLES, SCREENS, _internal: { whoFrom, screenFrom, readModel } };
