/* ✨ Ask — the admin assistant (owner request 23 Sep 2026: "add an AI in admin - it just need to call existing
   functions"). Real adminask.js on an in-memory MySQL; the model is a stub (no network, no key). The point of most
   of these tests is the promise the screen makes: **it never writes.** Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ask = require('../adminask');
const D = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------- in-memory MySQL (records every statement)
const SQL = [];
const CUSTOMERS = [
  { phone_norm: '9971430096', name: 'Swayam Kumar', email: 'swayam@example.com' },
  { phone_norm: '9000000002', name: 'Swati Rao', email: 'swati@example.com' },
  { phone_norm: '9000000003', name: 'Rahul Verma', email: '' },
];
const SUBS = [{ sub_id: 'SUB-77', phone_norm: '9971430096', service: 'Netflix', plan: 'Sharing 1M', expiry_date: D(9), status: 'ACTIVE' }];
const ACCOUNTS = [{ account_id: 'PRI-32', service: 'Prime Video', login_id: 'prime32@fluxfilm.in', password: 'TheRealOne#9', is_active: 'FALSE' }];
const CREDIT = [
  { order_id: 'FF5034938', name: 'Swayam Kumar', phone_norm: '9971430096', service: 'Netflix', plan: 'Sharing 1M', final_amount: 199, created_at_sheet: D(-3) },
  { order_id: 'FF5034939', name: 'Rahul Verma', phone_norm: '9000000003', service: 'Prime Video', plan: 'Private 3M', final_amount: 350, created_at_sheet: D(-1) },
];
const db = {
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    SQL.push(sql);
    if ((sql.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + sql);
    if (/\bJOIN\b/i.test(sql)) throw new Error('Illegal mix of collations — this fake refuses JOINs, like MariaDB does here');
    if (/FROM customers WHERE phone_norm = \?/.test(sql)) return CUSTOMERS.filter((c) => c.phone_norm === p[0]);
    if (/FROM customers WHERE name LIKE \?/.test(sql)) { const q = String(p[0]).replace(/%/g, '').toLowerCase(); return CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q)); }
    if (/FROM inventory_accounts WHERE account_id = \?/.test(sql)) return ACCOUNTS.filter((a) => a.account_id === p[0]);
    if (/FROM subscriptions WHERE phone_norm = \?/.test(sql)) return SUBS.filter((x) => x.phone_norm === p[0]);
    if (/COUNT\(\*\) n FROM subscriptions WHERE \(inventory_ref = \? OR inventory_ref LIKE \?\)/.test(sql)) return [{ n: 4 }];
    if (/FROM orders WHERE UPPER\(status\) = 'CREDIT'/.test(sql)) return CREDIT;
    if (/FROM plans/.test(sql)) return [{ service: 'Netflix', plan: 'Private 1M', duration_days: 30, price: 199, is_active: 1, raw_json: '{}' }];
    throw new Error('fake db: unhandled SQL: ' + sql);
  },
};
const stock = {
  computeStockLevels: async () => ({
    'Netflix|||Private 1M': { stockLevel: 'OUT', stock: 0 },
    'Prime Video|||1 Month': { stockLevel: 'LOW', stock: 2 },
    'Zee5|||1 Month': { stockLevel: 'OK', stock: 9 },
  }),
};
const modelCalls = [];
const model = async (messages, opts) => { modelCalls.push({ messages, opts }); return { json: { tool: 'stock.out' } }; };
const A = ask.make({ db, stock, model });

(async () => {
  // ── the sentences the owner actually types are handled without the model at all ───────────────────────────
  section('plain sentences, no AI needed');
  const RULES = [
    ['create a strong password for this account', 'password.suggest'],
    ['strong password for PRI-32', 'password.suggest'],
    ['create a renewal order for Swayam', 'order.renew'],
    ['renew Swayam', 'order.renew'],
    ['find 9971430096', 'customer.find'],
    ['who is rahul verma', 'customer.find'],
    ["what's out of stock", 'stock.out'],
    ['who owes money', 'money.due'],
    ['move everyone off PRI-32', 'account.moveOff'],
    ['open bank payments', 'open'],
    ['new order for Swati', 'order.new'],
  ];
  for (const row of RULES) {
    const r = ask.readRules(row[0]);
    ok('“' + row[0] + '” → ' + row[1], !!r && r.tool === row[1], r);
  }
  ok("the owner's own two examples both work with no key set",
    ask.readRules('create a strong password for this account').tool === 'password.suggest' &&
    ask.readRules('create a renewal order for this customer Swayam').tool === 'order.renew');
  ok('gibberish is not forced into a tool', ask.readRules('asdkjh qwe') === null, ask.readRules('asdkjh qwe'));
  ok('the name survives the command words', ask._internal.whoFrom("create a renewal order for Swayam's netflix") === 'Swayam', ask._internal.whoFrom("create a renewal order for Swayam's netflix"));

  // ── a strong password ─────────────────────────────────────────────────────────────────────────────────────
  section('the password it makes');
  const pws = []; for (let i = 0; i < 300; i++) pws.push(ask.strongPassword(14));
  ok('14 characters', pws.every((p) => p.length === 14));
  ok('never a character you can misread on a TV (l I 1 O 0)', pws.every((p) => !/[lI1O0]/.test(p)));
  ok('always has a capital, a small letter, a number and a mark', pws.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[2-9]/.test(p) && /[@#$%&*!?]/.test(p)));
  ok('300 in a row are all different', new Set(pws).size === 300);

  // ── password.suggest ──────────────────────────────────────────────────────────────────────────────────────
  section('“strong password for PRI-32”');
  let r = await A.ask('strong password for PRI-32', { noModel: true });
  ok('understood', r.ok && r.understood && r.tool === 'password.suggest', r);
  ok('hands over a password to copy', /^[^lI1O0]{14}$/.test(r.copy || ''), r.copy);
  ok('names the account and its login', r.title.indexOf('PRI-32') > -1 && r.lines.join(' ').indexOf('prime32@fluxfilm.in') > -1);
  ok('opens 🔑 Password change with it filled in', !!r.nav && r.nav.view === 'password' && r.nav.account.accountId === 'PRI-32' && r.nav.password === r.copy, r.nav);
  ok('says plainly that nothing is saved yet', /nothing is saved/i.test(r.note || ''), r.note);
  ok("⚠️ never prints the account's CURRENT password", JSON.stringify(r).indexOf('TheRealOne#9') === -1);
  const unknown = await A.ask('strong password for NOPE-1', { noModel: true });
  ok('an account we do not have still gets a password, and says so', /^[^lI1O0]{14}$/.test(unknown.copy || '') && /No account called NOPE-1/.test(unknown.lines.join(' ')) && !unknown.nav, unknown);

  // ── finding a customer ────────────────────────────────────────────────────────────────────────────────────
  section('finding a customer');
  r = await A.ask('find 9971430096', { noModel: true });
  ok('by number → one person, opens Customer 360', r.understood && r.nav.view === 'customer' && r.nav.phone === '9971430096', r);
  r = await A.ask('find Swa', { noModel: true });
  ok('by half a name → both are offered, and it does NOT guess one', r.people.length === 2 && !r.nav, r);
  r = await A.ask('find Zzz Nobody', { noModel: true });
  ok('nobody matches → says so, opens nothing', /No customer found/.test(r.title) && !r.nav, r);

  // ── renewals and new orders: prepared, never created ──────────────────────────────────────────────────────
  section('“renew Swayam”');
  r = await A.ask('create a renewal order for Swayam', { noModel: true });
  ok('finds him and shows the plan that is running', r.understood && r.lines.join(' ').indexOf('Sharing 1M') > -1, r);
  ok('opens ⚡ Quick order on the Renew tab, customer and subscription already picked',
    r.nav.view === 'quick' && r.nav.tab === 'renew' && r.nav.customer.phone === '9971430096' && r.nav.customer.name === 'Swayam Kumar' && r.nav.subId === 'SUB-77', r.nav);
  ok('says the order is not created yet', /Nothing is created until you press it there/.test(r.note || ''), r.note);
  r = await A.ask('renew Rahul Verma', { noModel: true });
  ok('a customer with nothing running is sent to New order instead', r.nav.view === 'quick' && r.nav.tab === 'new' && /no running plan/.test(r.title), r);

  // ── the read-only questions ───────────────────────────────────────────────────────────────────────────────
  section('stock, money, an account');
  r = await A.ask("what's out of stock", { noModel: true });
  ok('names the plan that is out and the one running low',
    /1 plan out of stock/.test(r.title) && r.lines.join(' ').indexOf('Netflix · Private 1M') > -1 && r.lines.join(' ').indexOf('Prime Video · 1 Month (2 left)') > -1, r);
  r = await A.ask('who owes money', { noModel: true });
  ok('adds the credit up and counts the people', /₹549 due from 2 customer/.test(r.title), r.title);
  ok('lists each one with the order id', r.lines.join(' ').indexOf('FF5034938') > -1 && r.nav.view === 'receivables', r.lines);
  r = await A.ask('move everyone off PRI-32', { noModel: true });
  ok('counts who is on it and says the account is switched off', /4 customers on it/.test(r.title) && /switched off/.test(r.lines.join(' ')), r);
  ok('takes the owner to the screen where that button lives — it does not press it', r.nav.view === 'password' && /Opens 🔑 Password change/.test(r.note), r);
  r = await A.ask('move everyone off', { noModel: true });
  ok('no account named → asks which one, does nothing', /Which account/.test(r.title) && !r.nav, r);
  r = await A.ask('open profit', { noModel: true });
  ok('“open profit” just opens it', r.nav.view === 'profit', r);

  // ── the model: only when the rules miss, and only ever a tool name ─────────────────────────────────────────
  section('the AI, and the fence around it');
  modelCalls.length = 0;
  r = await A.ask('renew Swayam');
  ok('a sentence the rules understand never reaches the model', modelCalls.length === 0 && r.source === 'rules', { calls: modelCalls.length, source: r.source });
  r = await A.ask('zara batao kitna bacha hai');
  ok("a sentence they miss does, and the answer is marked as the AI's", modelCalls.length === 1 && r.source === 'model' && r.tool === 'stock.out', { calls: modelCalls.length, source: r.source });
  const sent = JSON.stringify(modelCalls[0].messages);
  ok('the model is shown the sentence and the tool names — no customer, no login, no password',
    sent.indexOf('zara batao kitna bacha') > -1 && sent.indexOf('9971430096') === -1 && sent.indexOf('Swayam') === -1 && sent.indexOf('prime32@fluxfilm.in') === -1 && sent.indexOf('TheRealOne#9') === -1, sent.slice(0, 300));
  {
    const B = ask.make({ db, stock, model: async () => ({ json: { tool: 'orders.deleteEverything', who: 'x' } }) });
    const bad = await B.ask('do something clever');
    ok('a tool the model invents is thrown away, not run', bad.understood === false, bad);
  }
  {
    const B = ask.make({ db, stock, model: async () => { throw new Error('no key'); } });
    const down = await B.ask('something the rules do not know');
    ok('no key / model down → a helpful "I did not understand", never a crash', down.ok === true && down.understood === false && down.lines.length > 1, down);
  }
  r = await A.ask('');
  ok('an empty box shows the examples', r.ok && !r.understood && r.lines.length === ask.EXAMPLES.length);

  // ── the promise: it never writes ──────────────────────────────────────────────────────────────────────────
  section('⚠️ it never writes anything');
  const writes = SQL.filter((x) => !/^SELECT /i.test(x));
  ok('every statement it ran in this whole test is a SELECT', writes.length === 0, writes.slice(0, 5));
  const src = fs.readFileSync(path.join(__dirname, '..', 'adminask.js'), 'utf8');
  ok('the file contains no INSERT / UPDATE / DELETE at all', !/\b(INSERT INTO|UPDATE \w|DELETE FROM)\b/.test(src));
  ok('and it never sends an email or a WhatsApp', !/mailer|sendMail|whatsapp/i.test(src));

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok('admin.js mounts it', /require\('\.\/adminask'\)\.mount\(app,/.test(adminJs));
  const routes = [];
  ask.mount({ get: (p) => routes.push('GET ' + p), post: (p) => routes.push('POST ' + p) }, { db, auth: () => true });
  ok('two routes', routes.length === 2 && routes.indexOf('GET /admin/api/ask/examples') > -1 && routes.indexOf('POST /admin/api/ask') > -1, routes);
  {
    // The route must refuse before it does anything when the session check says no.
    const handlers = {};
    let checked = 0;
    ask.mount({ get: (p, h) => { handlers[p] = h; }, post: (p, h) => { handlers[p] = h; } }, { db, auth: () => { checked++; return false; } });
    let answered = false;
    const res = { json: () => { answered = true; }, status: () => ({ json: () => { answered = true; } }) };
    await handlers['/admin/api/ask']({ body: { text: 'renew Swayam' } }, res);
    ok('a caller without the session gets nothing back', checked === 1 && answered === false, { checked, answered });
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('the ✨ Ask item is in the menu', /\['ask', '✨', 'Ask'\]/.test(html));
  ok('and the screen is registered', /m\.ask = askView;/.test(html));
  ok('the screen says out loud that nothing is saved from here', /Nothing here saves anything/.test(html));
  ok('an answer worked out by the AI is labelled as such', /Worked out by the AI/.test(html));
  ok('opening 🔑 Password change carries the suggested password',
    /PW\.prefill = g\.password \|\| '';/.test(html) && /if \(PW\.prefill\) \{ \$\('#pwnew'\)\.value = PW\.prefill;/.test(html));
  ok('opening ⚡ Quick order carries the customer and the subscription',
    /Q\.cust = \{ customerId: '', name: g\.customer\.name/.test(html) && /if \(g\.subId\) Q\.subId = g\.subId;/.test(html));
  ok('every screen ✨ Ask can open really exists in the panel',
    Object.keys(ask.SCREENS).every((k) => html.indexOf("'" + k + "'") > -1), Object.keys(ask.SCREENS).filter((k) => html.indexOf("'" + k + "'") === -1));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
