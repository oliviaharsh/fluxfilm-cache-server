/* Olivia, the AI store manager: settings, decisions (buy → pay → verify → deliver), safe words, widget hooks. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
delete process.env.DEEPSEEK_API_KEY;
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 600) : '')); } };

// ── in-memory DB: app_settings + olivia tables ──
const settings = {}; const convs = {}; const msgs = []; let schema = true;
const mockDb = {
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT value FROM app_settings/.test(sql)) return settings[p[0]] ? [{ value: settings[p[0]] }] : [];
    if (/^INSERT INTO app_settings/.test(sql)) { settings[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/olivia_/.test(sql) && !schema) throw new Error("Table 'olivia_conversations' doesn't exist");
    if (/^SELECT id FROM olivia_conversations LIMIT 1/.test(sql)) return [];
    if (/^SELECT id, phone_norm, lang, step, state_json/.test(sql)) return convs[p[0]] ? [convs[p[0]]] : [];
    if (/^INSERT INTO olivia_conversations/.test(sql)) { convs[p[0]] = { id: p[0], phone_norm: p[1], lang: p[2], step: p[3], state_json: p[4], status: p[5], order_id: p[6], turns: p[7], ai_calls: p[8], ai_tokens: p[9] }; return {}; }
    if (/^UPDATE olivia_conversations/.test(sql)) { const c = convs[p[9]]; Object.assign(c, { lang: p[0], step: p[1], state_json: p[2], status: p[3], order_id: p[4], turns: p[5], ai_calls: p[6], ai_tokens: p[7] }); return {}; }
    if (/^INSERT INTO olivia_messages/.test(sql)) { msgs.push({ conversation_id: p[0], role: p[1], intent: p[2], body: p[3], meta_json: p[4], ai: p[5] }); return {}; }
    if (/^SELECT id, phone_norm, lang, step, status, order_id/.test(sql)) return Object.values(convs);
    if (/^SELECT role, intent, body, ai, created_at FROM olivia_messages/.test(sql)) return msgs.filter((m) => m.conversation_id === p[0]);
    throw new Error('unexpected SQL: ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);

const olivia = require('../olivia');
const words = require('../oliviawords');

// ── fake shop (the tools layer) ──
const PLANS = [
  { service: 'Netflix', plan: 'Sharing 1M', durationDays: 30, price: 139, benefits: ['Your own profile on a shared account', '1 device'] },
  { service: 'Netflix', plan: 'Sharing 3M', durationDays: 90, price: 399, benefits: ['Your own profile on a shared account'] },
  { service: 'Netflix', plan: 'Private 1M', durationDays: 30, price: 169, benefits: ['Only you use the profile', '4K'] },
  { service: 'Netflix', plan: 'Private 3M', durationDays: 90, price: 499, benefits: ['Only you use the profile'] },
  { service: 'Netflix (Group Offer)', plan: 'Sharing 1M', durationDays: 30, price: 99, requiresGroupJoin: true, groupJoinLink: 'https://chat.whatsapp.com/TESTGROUP1' },
  { service: 'Netflix (Group Offer)', plan: 'Private 1M', durationDays: 30, price: 149, requiresGroupJoin: true, groupJoinLink: 'javascript:alert(1)' },
  { service: 'Prime Video', plan: '1 Month', durationDays: 30, price: 39, needsExtraField: true, extraFieldKey: 'PRIME_DEVICE_TYPE' },
  { service: 'Prime Video', plan: '2 Devices 1M', durationDays: 30, price: 59, needsExtraField: true, extraFieldKey: 'PRIME_DEVICE_TYPE', loginChoice: true },
  { service: 'JioHotstar', plan: '1 Month', durationDays: 30, price: 69 },
  { service: 'JioHotstar', plan: '3 Months', durationDays: 90, price: 199 },
  { service: 'YouTube Premium', plan: '1 Month', durationDays: 30, price: 99, needsExtraField: true, extraFieldKey: 'YT_EMAIL', extraFieldLabel: 'your YouTube email' },
];
const STOCK = { 'JioHotstar|||1 Month': { stockLevel: 'OUT' } };
const calls = [];
const shop = { subs: [], renewMode: 'SAME', paid: false, paused: false, fulfillment: 'FULFILLED', profile: { ok: true, name: 'Ramesh Kumar', email: 'ramesh@example.com' }, claim: 'WAITING', backupOk: true };
const tools = {
  catalogFor: async () => ({ plans: PLANS, stock: STOCK }),
  profile: async (ph) => (ph === '9876543210' || ph === '9000000001' ? shop.profile : { ok: false }),
  createOrder: async (phone, p, extra) => {
    calls.push(['createOrder', phone, p, extra]);
    if (shop.paused) return { ok: false, paused: true, message: 'paused' };
    return { ok: true, orderId: 'FF' + (1234567 + calls.filter((c) => c[0] === 'createOrder').length), amount: PLANS.find((x) => x.service === p.service && x.plan === p.plan).price - (extra.couponCode === 'FLUX20' ? 20 : 0), upiLink: 'upi://pay?pa=x@upi&am=139&tn=FF1234567' };
  },
  validateCoupon: async (phone, code, p, scope) => {
    calls.push(['validateCoupon', phone, code, p.service, p.plan, p.price, scope]);
    if (code === 'FLUX20') return { ok: true, code, discount: 20, finalAmount: p.price - 20 };
    if (code === 'OLD5') return { ok: false, message: 'Coupon expired.' };
    return { ok: false, message: 'Invalid coupon.' };
  },
  mySubscriptions: async (phone) => {
    calls.push(['mySubscriptions', phone]);
    return { ok: true, actionable: shop.subs.map((x) => Object.assign({}, x)) };
  },
  renewQuote: async (subId, plan) => {
    calls.push(['renewQuote', subId, plan]);
    const sub = shop.subs.find((x) => x.subId === subId);
    const pl = PLANS.find((x) => x.service === sub.service && x.plan === (plan || sub.plan));
    const early = sub.daysLeft >= 8 ? 15 : 0;
    return { ok: true, price: pl.price, earlyDiscount: early, amount: pl.price - early, renewal: { mode: shop.renewMode, preview: { newExpiryText: '20 Oct 2026' } } };
  },
  createRenewOrder: async (subId, planOverride, couponCode) => {
    calls.push(['createRenewOrder', subId, planOverride, couponCode]);
    if (shop.renewMode === 'NONE') return { ok: false, renewBlocked: true, message: 'blocked' };
    const sub = shop.subs.find((x) => x.subId === subId);
    const pl = PLANS.find((x) => x.service === sub.service && x.plan === (planOverride || sub.plan));
    const early = sub.daysLeft >= 8 ? 15 : 0;
    return { ok: true, orderId: 'FFR' + calls.length, amount: couponCode === 'FLUX20' ? pl.price - 20 : pl.price - early, upiLink: 'upi://pay?pa=x@upi', renew: true, accountChange: shop.renewMode === 'MOVE' };
  },
  checkPayment: async (id) => { calls.push(['checkPayment', id]); return { ok: true, paid: shop.paid }; },
  deliver: async (id, phone) => {
    calls.push(['deliver', id, phone]);
    if (shop.fulfillment === 'MANUAL_PENDING') return { ok: true, fulfillment: 'MANUAL_PENDING' };
    return { ok: true, fulfillment: shop.fulfillment, access: { user: 'acc1@netflixmail.com', pass: 'SuperSecret#77', profileName: 'Ramesh', profilePin: '4321' } };
  },
  backupPayment: async (id, phone) => { calls.push(['backupPayment', id, phone]); return shop.backupOk ? { ok: true, amount: 139, vpa: 'backup@upi', payee: 'FluxFilm', qrImage: 'data:image/png;base64,AAA', upiLink: 'upi://pay?pa=backup@upi', knownName: '' } : { ok: false }; },
  claimBackup: async (id, phone, name) => { calls.push(['claimBackup', id, phone, name]); return { ok: true, status: 'WAITING' }; },
  claimStatus: async (id, phone) => { calls.push(['claimStatus', id, phone]); return shop.claim === 'MATCHED' ? { ok: true, status: 'MATCHED', paid: true } : { ok: true, status: shop.claim }; },
};
olivia._internal.setDeps({ tools });

const PH = '9876543210';
const last = (r) => r.messages[r.messages.length - 1];
const ids = (m) => (m.buttons || []).map((b) => b.id);
const findBtn = (m, re) => (m.buttons || []).find((b) => re.test(b.label));

(async () => {
  // ── settings ──
  let st = await olivia.status(PH);
  ok('default: Olivia is OFF (Help stays WhatsApp)', st.ok && st.enabled === false && /wa\.me/.test(st.whatsappLink), st);
  let r = await olivia.handle(PH, { choice: 'start' });
  ok('chat refused while off', r.ok === false && r.disabled === true);

  let sv = await olivia.saveSettings({ enabled: true, testOnly: true, testPhones: '' });
  ok('test mode without phones is refused', !sv.ok && /test phone/i.test(sv.message), sv);
  sv = await olivia.saveSettings({ whatsappLink: 'https://evil.example.com/x' });
  ok('WhatsApp link must be a WhatsApp link', !sv.ok);
  sv = await olivia.saveSettings({ voice: 'x'.repeat(2001) });
  ok('voice guide max 2000', !sv.ok);
  sv = await olivia.saveSettings({ enabled: 'true', testOnly: true, testPhones: '+91 98765-43210, 12345' });
  ok('switch on in test mode; phones cleaned to 10 digits', sv.ok && sv.settings.enabled === true && sv.settings.testPhones === '9876543210' && sv.changed.includes('enabled'), sv);
  olivia._internal.reset();
  ok('test phone sees Olivia', (await olivia.status(PH)).enabled === true);
  ok('other phone does not (test mode)', (await olivia.status('9000000001')).enabled === false);
  ok('no phone (not logged in) → off', (await olivia.status('')).enabled === false);
  schema = false; olivia._internal.reset();
  ok('before schema-v21: off even when switched on', (await olivia.status(PH)).enabled === false);
  schema = true; olivia._internal.reset();
  await olivia.saveSettings({ testOnly: false });
  olivia._internal.reset();
  ok('test mode off: every logged-in customer', (await olivia.status('9000000001')).enabled === true);
  ok('a phone that is not a FluxFilm customer never gets Olivia', (await olivia.status('9111111111')).enabled === false);
  r = await olivia.handle('9111111111', { choice: 'start' });
  ok('non-customer chat refused ("please log in")', r.ok === false && /log in/i.test(r.message), r);
  await olivia.saveSettings({ aiWords: false }); olivia._internal.reset();

  // ── language + menu ──
  r = await olivia.handle(PH, { choice: 'start', installedApp: false });
  const conv = r.conversationId;
  ok('first open asks the language, Hinglish first + suggested', r.ok && last(r).intent === 'CHOOSE_LANGUAGE' && ids(last(r))[0] === 'lang:hinglish' && /suggested/.test(last(r).buttons[0].label) && ids(last(r)).includes('lang:en') && ids(last(r)).includes('lang:hi'), r);
  ok('conversation id is 32 hex', /^[a-f0-9]{32}$/.test(conv));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'lang:hinglish' });
  ok('Hinglish greeting with first name + 4 options', last(r).intent === 'GREET_MENU' && /Ramesh ji/.test(last(r).text) && !/Kumar/.test(last(r).text) && ids(last(r)).join() === 'buy,renew,household,other', last(r));
  ok('lang remembered on the conversation', r.lang === 'hinglish');
  const other = await olivia.handle('9000000001', { conversationId: conv, choice: 'buy' });
  ok('another phone cannot continue this conversation (gets a new one)', other.conversationId !== conv);

  // ── buy: Netflix → Sharing/Private → difference → duration → confirm ──
  r = await olivia.handle(PH, { conversationId: conv, choice: 'buy' });
  const svc = last(r);
  ok('buy → which service; Group Offer shown as its own option with 👥', svc.intent === 'ASK_SERVICE' && svc.buttons.some((b) => b.label === 'Netflix') && svc.buttons.some((b) => b.label === 'Netflix (Group Offer) 👥'), svc);
  r = await olivia.handle(PH, { conversationId: conv, choice: findBtn(svc, /^Netflix$/).id });
  ok('Netflix → Sharing or Private + difference', last(r).intent === 'ASK_SHARING_OR_PRIVATE' && ids(last(r)).includes('variant:sharing') && ids(last(r)).includes('diff'));
  r = await olivia.handle(PH, { conversationId: conv, text: 'dono mein fark kya hai?' });
  ok('"fark kya hai" → explains from the plans\' own benefits', last(r).intent === 'EXPLAIN_SHARING_VS_PRIVATE' && /shared account/.test(last(r).text) && /Only you use/.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'variant:sharing' });
  const dur = last(r);
  ok('Sharing → durations with LIVE prices', dur.intent === 'ASK_DURATION' && dur.buttons.some((b) => /1 mahina · ₹139/.test(b.label)) && dur.buttons.some((b) => /3 mahine · ₹399/.test(b.label)) && !dur.buttons.some((b) => /169/.test(b.label)), dur);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'plan:99' });
  ok('a button that was not offered is not obeyed', last(r).intent === 'DIDNT_UNDERSTAND', last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: findBtn(dur, /₹139/).id });
  ok('plan → confirm with price (email already on profile)', last(r).intent === 'CONFIRM_PLAN' && /₹139/.test(last(r).text) && ids(last(r))[0] === 'pay', last(r));
  ok('no order before the customer says yes', !calls.some((c) => c[0] === 'createOrder'));

  // ── pay → not yet → paid → deliver (browser = emailed) ──
  r = await olivia.handle(PH, { conversationId: conv, text: 'haan' });
  const payMsg = last(r);
  const co = calls.find((c) => c[0] === 'createOrder');
  ok('"haan" → order created by the shop\'s own createOrder, with profile name + email', co && co[1] === PH && co[2].plan === 'Sharing 1M' && co[3].email === 'ramesh@example.com' && co[3].name === 'Ramesh Kumar' && co[3].extraFieldKey === '', co);
  ok('payment card: amount + QR of the shop\'s UPI link + I have paid / not working', payMsg.intent === 'SEND_PAYMENT' && payMsg.card.type === 'pay' && payMsg.card.amount === 139 && /qrserver/.test(payMsg.card.qr) && ids(payMsg).includes('paid') && ids(payMsg).includes('cantpay') && r.poll && r.poll.afterSec > 0, payMsg);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'poll' });
  ok('silent poll, not paid → no message, keeps polling', r.ok && r.messages.length === 0 && r.poll && calls.filter((c) => c[0] === 'checkPayment').length === 1);
  r = await olivia.handle(PH, { conversationId: conv, text: 'payment ho gaya' });
  ok('"ho gaya" but bank has nothing → NOT received (never trusts the customer)', last(r).intent === 'PAYMENT_NOT_YET' && !calls.some((c) => c[0] === 'deliver'), last(r));
  shop.paid = true;
  r = await olivia.handle(PH, { conversationId: conv, choice: 'poll', installedApp: false });
  ok('paid (bank) in a browser tab → delivered, login EMAILED, not shown', last(r).intent === 'PAYMENT_RECEIVED_LOGIN_EMAILED' && !last(r).card && calls.some((c) => c[0] === 'deliver' && /^FF\d+$/.test(c[1]) && c[2] === PH), last(r));
  ok('response never carries the password in a browser tab', !JSON.stringify(r).includes('SuperSecret'));

  // ── same again inside the installed app: login card ──
  shop.paid = false;
  r = await olivia.handle(PH, { conversationId: conv, text: 'hi' });
  ok('"hi" → main menu again', last(r).intent === 'GREET_MENU');
  r = await olivia.handle(PH, { conversationId: conv, text: 'mujhe netflix private 3 mahine chahiye' });
  ok('one sentence fills service + type + duration → confirm Private 3M ₹499', last(r).intent === 'CONFIRM_PLAN' && /Private 3 mahine/.test(last(r).text) && /₹499/.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  shop.paid = true;
  r = await olivia.handle(PH, { conversationId: conv, choice: 'paid', installedApp: true });
  const acc = last(r);
  ok('installed app → login card in chat + "also emailed"', acc.intent === 'PAYMENT_RECEIVED_LOGIN_IN_CHAT' && acc.card && acc.card.type === 'access' && acc.card.logins[0].pass === 'SuperSecret#77' && /email/.test(acc.text), acc);
  ok('login never stored in the chat log or conversation state', !msgs.some((m) => String(m.body).includes('SuperSecret') || String(m.meta_json).includes('SuperSecret')) && !Object.values(convs).some((c) => String(c.state_json).includes('SuperSecret')) && msgs.some((m) => /\[login shown in app\]/.test(m.body)));
  ok('no customer email in the chat log', !msgs.some((m) => /ramesh@example\.com/.test(m.body)));

  // ── Prime asks TV; 2-device plans stay on the website; sold out; YouTube email ──
  shop.paid = false; calls.length = 0;
  r = await olivia.handle(PH, { conversationId: conv, text: 'amazon prime 1 month' });
  ok('Prime 1 month → "watch on TV?" (2-device plan not in chat)', last(r).intent === 'ASK_TV', last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'tv:yes' });
  ok('TV answer → confirm ₹39', last(r).intent === 'CONFIRM_PLAN' && /₹39/.test(last(r).text), last(r));
  await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  const pc = calls.find((c) => c[0] === 'createOrder');
  ok('Prime order carries PRIME_DEVICE_TYPE = TV', pc && pc[3].extraFieldKey === 'PRIME_DEVICE_TYPE' && pc[3].extraFieldValue === 'TV', pc);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'menu' });
  r = await olivia.handle(PH, { conversationId: conv, text: 'hotstar 1 month' });
  ok('sold-out plan → says sold out and shows other durations', r.messages.some((m) => m.intent === 'OUT_OF_STOCK') && last(r).intent === 'ASK_DURATION' && last(r).buttons.some((b) => /sold out/.test(b.label)), r.messages);
  r = await olivia.handle(PH, { conversationId: conv, text: 'youtube 1 month' });
  ok('YouTube → asks the YouTube email', last(r).intent === 'ASK_EXTRA_EMAIL' && last(r).input === 'email', last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'my email is abc' });
  ok('bad email not accepted', last(r).intent === 'DIDNT_UNDERSTAND');
  r = await olivia.handle(PH, { conversationId: conv, text: 'Yt.User@Gmail.com' });
  ok('good email → confirm', last(r).intent === 'CONFIRM_PLAN', last(r));

  // ── shop paused ──
  shop.paused = true;
  r = await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  ok('maintenance on → "orders paused", no payment card', last(r).intent === 'SHOP_PAUSED' && !r.messages.some((m) => m.card), last(r));
  shop.paused = false;

  // ── customer without email on profile ──
  shop.profile = { ok: true, name: '', email: '' };
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix sharing 1 month' });
  ok('no email on profile → asks for it before the order', last(r).intent === 'ASK_OWN_EMAIL', last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'new.buyer@gmail.com' });
  ok('email typed → confirm', last(r).intent === 'CONFIRM_PLAN');
  calls.length = 0;
  await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  ok('typed email used for the order', calls[0] && calls[0][3].email === 'new.buyer@gmail.com', calls[0]);
  shop.profile = { ok: true, name: 'Ramesh Kumar', email: 'ramesh@example.com' };

  // ── payment not working → backup QR + payer name → review → matched ──
  r = await olivia.handle(PH, { conversationId: conv, text: "payment nahi ho raha" });
  ok('"payment nahi ho raha" → backup QR card + asks payer name', r.messages[0].intent === 'CANT_PAY_BACKUP_QR' && r.messages[0].card.type === 'backup' && r.messages[0].card.vpa === 'backup@upi' && last(r).intent === 'ASK_PAYER_NAME' && last(r).input === 'name', r.messages);
  r = await olivia.handle(PH, { conversationId: conv, text: 'RAMESH KUMAR' });
  const cl = calls.find((c) => c[0] === 'claimBackup');
  ok('typed name → the shop\'s claimManualPayment → "matching your payment"', cl && cl[3] === 'RAMESH KUMAR' && last(r).intent === 'BACKUP_UNDER_REVIEW' && r.poll, last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'poll' });
  ok('poll while waiting → nothing new', r.messages.length === 0 && calls.some((c) => c[0] === 'claimStatus'));
  shop.claim = 'MATCHED';
  r = await olivia.handle(PH, { conversationId: conv, choice: 'poll', installedApp: false });
  ok('claim matched → delivered (emailed)', last(r).intent === 'PAYMENT_RECEIVED_LOGIN_EMAILED', last(r));
  shop.claim = 'WAITING';

  // ── manual plans + after-payment stock problem ──
  shop.fulfillment = 'MANUAL_PENDING'; shop.paid = true;
  await olivia.handle(PH, { conversationId: conv, text: 'netflix sharing 1 month' });
  await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  r = await olivia.handle(PH, { conversationId: conv, choice: 'paid' });
  ok('manual plan → "being set up"', last(r).intent === 'DELIVERY_BEING_SET_UP', last(r));
  shop.fulfillment = 'NO_STOCK';
  await olivia.handle(PH, { conversationId: conv, text: 'netflix sharing 1 month' });
  await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  r = await olivia.handle(PH, { conversationId: conv, choice: 'paid' });
  ok('paid but no stock → hands over to WhatsApp (link button)', last(r).intent === 'HANDOFF_TO_HUMAN' && last(r).buttons.some((b) => b.id === 'whatsapp' && b.link === 'whatsapp'), last(r));
  shop.fulfillment = 'FULFILLED'; shop.paid = false;

  // ── other menu items ──
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix household problem hai' });
  ok('household → Household Helper link (auto-fix comes in the next PR)', last(r).intent === 'HOUSEHOLD_HELPER' && last(r).buttons.some((b) => b.link === 'helper'), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'renew karna hai' });
  ok('renew with no renewable plan → "none found", offers buying', last(r).intent === 'RENEW_NONE' && ids(last(r)).includes('buy') && calls.some((c) => c[0] === 'mySubscriptions' && c[1] === PH), last(r));

  // ── renew in chat ──
  shop.subs = [{ subId: 'S1', service: 'Netflix', plan: 'Sharing 1M', daysLeft: 12 }, { subId: 'S2', service: 'JioHotstar', plan: '1 Month', daysLeft: -2 }];
  calls.length = 0; shop.paid = false; shop.renewMode = 'SAME';
  r = await olivia.handle(PH, { conversationId: conv, choice: 'menu' });
  r = await olivia.handle(PH, { conversationId: conv, choice: 'renew' });
  ok('renew → lists ONLY this phone\'s plans with days left', last(r).intent === 'RENEW_PICK' && last(r).buttons.some((b) => /Netflix Sharing 1M · 12 din baaki/.test(b.label)) && last(r).buttons.some((b) => /JioHotstar 1 Month · 2 din pehle khatam/.test(b.label)), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix wala' });
  const rd = last(r);
  ok('"netflix wala" → that plan; lengths of the SAME kind (Sharing) with ✓ on current', rd.intent === 'RENEW_DURATION' && rd.buttons.some((b) => /1 mahina · ₹139 ✓/.test(b.label)) && rd.buttons.some((b) => /3 mahine · ₹399/.test(b.label)) && !rd.buttons.some((b) => /169|499/.test(b.label)), rd);
  r = await olivia.handle(PH, { conversationId: conv, text: '3 months' });
  const rc = last(r);
  ok('"3 months" → the shop\'s renewQuote for S1 → Sharing 3M', calls.some((c) => c[0] === 'renewQuote' && c[1] === 'S1' && c[2] === 'Sharing 3M'));
  ok('confirm shows price, early-renew discount, amount, new expiry, same login', rc.intent === 'RENEW_CONFIRM' && /₹399/.test(rc.text) && /₹15/.test(rc.text) && /₹384/.test(rc.text) && /20 Oct 2026/.test(rc.text) && /Login wahi/.test(rc.text), rc);
  r = await olivia.handle(PH, { conversationId: conv, text: 'coupon FLUX20' });
  ok('renew coupon checked with scope RENEW; FLUX20 (₹20) beats early discount (₹15) → confirm with coupon', calls.some((c) => c[0] === 'validateCoupon' && c[2] === 'FLUX20' && c[4] === 'Sharing 3M') && last(r).intent === 'RENEW_CONFIRM_COUPON' && /₹379/.test(last(r).text), r.messages);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'nocoupon' });
  ok('without coupon → back to the early-discount confirm', last(r).intent === 'RENEW_CONFIRM' && /₹384/.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'yes' });
  const cro = calls.find((c) => c[0] === 'createRenewOrder');
  ok('"yes" → the shop\'s createRenewOrder(S1, Sharing 3M, no coupon) → QR', cro && cro[1] === 'S1' && cro[2] === 'Sharing 3M' && cro[3] === '' && last(r).intent === 'SEND_PAYMENT' && last(r).card.amount === 384, last(r));
  ok('no normal createOrder for a renewal', !calls.some((c) => c[0] === 'createOrder'));
  shop.paid = true;
  r = await olivia.handle(PH, { conversationId: conv, choice: 'poll', installedApp: true });
  ok('paid, same account → "renewed until…, keep the same login" (no login card needed)', last(r).intent === 'RENEW_DONE' && /20 Oct 2026/.test(last(r).text) && !last(r).card, last(r));
  shop.paid = false;

  // account moved → new login; blocked renewal; same plan = no override
  shop.renewMode = 'MOVE'; calls.length = 0;
  r = await olivia.handle(PH, { conversationId: conv, text: 'renew hotstar' });
  ok('"renew hotstar" goes straight to that plan', last(r).intent === 'RENEW_DURATION' && /JioHotstar/.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: findBtn(last(r), /✓/).id });
  ok('account no longer available → confirm says a NEW login comes after payment', last(r).intent === 'RENEW_CONFIRM' && /naya login/i.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  ok('same plan renewed without a plan override', calls.some((c) => c[0] === 'createRenewOrder' && c[1] === 'S2' && c[2] === ''));
  shop.paid = true;
  r = await olivia.handle(PH, { conversationId: conv, choice: 'paid', installedApp: true });
  ok('new login after renewal → login card in the installed app', last(r).intent === 'RENEW_DONE_NEW_LOGIN_IN_CHAT' && last(r).card && last(r).card.type === 'access', last(r));
  shop.paid = false;
  shop.renewMode = 'NONE';
  r = await olivia.handle(PH, { conversationId: conv, text: 'renew netflix' });
  r = await olivia.handle(PH, { conversationId: conv, choice: findBtn(last(r), /✓/).id });
  ok('no account can take the renewal → blocked BEFORE any payment, WhatsApp', last(r).intent === 'RENEW_BLOCKED' && !r.messages.some((m) => m.card) && ids(last(r)).includes('whatsapp'), last(r));
  shop.renewMode = 'SAME';
  const early2 = await olivia.handle(PH, { conversationId: conv, text: 'renew netflix' });
  await olivia.handle(PH, { conversationId: conv, choice: findBtn(last(early2), /✓/).id });
  r = await olivia.handle(PH, { conversationId: conv, text: 'coupon SMALL' });
  ok('a renewal coupon is never worse than the early discount (unknown code → invalid)', last(r).intent === 'COUPON_INVALID', last(r));
  await olivia.handle(PH, { conversationId: conv, choice: 'nocoupon' }); // while a code is awaited, any word is tried as a code
  shop.subs = [];
  r = await olivia.handle(PH, { conversationId: conv, text: 'asdfgh' });
  ok('gibberish → did not understand, same buttons again', last(r).intent === 'DIDNT_UNDERSTAND' && last(r).buttons.length > 0);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'lang:hi' });
  ok('language can change any time (Hindi)', r.lang === 'hi' && /नमस्ते/.test(last(r).text));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'lang:en' });
  ok('English greeting', /^Hello Ramesh!/.test(last(r).text), last(r).text);


  // ── Harsh's live test (15 Sep): side requests in the middle of a flow ──
  shop.paid = false; shop.fulfillment = 'FULFILLED'; calls.length = 0;
  r = await olivia.handle(PH, { conversationId: conv, choice: 'menu' });
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix sharing' });
  ok('replay: Netflix Sharing → durations', last(r).intent === 'ASK_DURATION', last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'But I purchased for ₹99 earlier' });
  ok('"I purchased for ₹99 earlier" is a price question, NOT a restart', last(r).intent === 'PRICE_HELP' && !r.messages.some((m) => m.intent === 'ASK_SERVICE'), r.messages);
  ok('price help offers the Group Offer and a coupon', last(r).buttons.some((b) => /Group Offer/.test(b.label)) && ids(last(r)).includes('coupon'), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix sharing 1 month' });
  r = await olivia.handle(PH, { conversationId: conv, text: 'why is it so costly, it was cheaper before' });
  ok('price question on a chosen plan → live price + same plan in Group Offer ₹99', last(r).intent === 'PRICE_HELP_PLAN' && /₹139/.test(last(r).text) && /₹99/.test(last(r).text) && last(r).buttons.some((b) => b.id === 'twin' && /₹99/.test(b.label)), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'twin' });
  const gj = last(r);
  ok('Group Offer → join the WhatsApp group first (link button) + "I have joined"', gj.intent === 'GROUP_JOIN' && gj.buttons.some((b) => b.id === 'groupjoin' && b.url === 'https://chat.whatsapp.com/TESTGROUP1') && ids(gj).includes('joined'), gj);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'joined' });
  ok('joined → straight to confirm of the SAME plan (Sharing 1 month ₹99)', last(r).intent === 'CONFIRM_PLAN' && /₹99/.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  const firstOrder = calls.filter((c) => c[0] === 'createOrder').length;
  ok('group order created for the Group Offer plan', calls.some((c) => c[0] === 'createOrder' && c[2].service === 'Netflix (Group Offer)'));
  r = await olivia.handle(PH, { conversationId: conv, text: 'I want to use coupon code' });
  ok('replay: "I want to use coupon code" while paying → asks the code (payment paused, no polling)', last(r).intent === 'ASK_COUPON' && last(r).input === 'coupon' && !r.poll && ids(last(r)).includes('backpay'), last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'poll' });
  ok('no silent payment checks while a side question is open', r.messages.length === 0);
  r = await olivia.handle(PH, { conversationId: conv, text: 'NOPE1' });
  ok('wrong code → not valid, can try again / continue / back to payment', last(r).intent === 'COUPON_INVALID' && /NOPE1/.test(last(r).text) && ids(last(r)).includes('nocoupon') && ids(last(r)).includes('backpay'), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'OLD5' });
  ok('expired code → says expired', last(r).intent === 'COUPON_INVALID' && /expire/.test(last(r).text), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'flux20' });
  ok('good code checked by the shop\'s own validateCoupon at the plan\'s live price', calls.some((c) => c[0] === 'validateCoupon' && c[2] === 'FLUX20' && c[3] === 'Netflix (Group Offer)' && c[5] === 99));
  ok('→ "applied, do NOT pay the old QR" + confirm with the new price', r.messages[0].intent === 'COUPON_APPLIED_NEW_QR' && last(r).intent === 'CONFIRM_PLAN_COUPON' && /₹79/.test(last(r).text) && /FLUX20/.test(last(r).text), r.messages);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  const couponOrder = calls.filter((c) => c[0] === 'createOrder').pop();
  ok('new order carries the coupon; QR for ₹79', calls.filter((c) => c[0] === 'createOrder').length === firstOrder + 1 && couponOrder[3].couponCode === 'FLUX20' && last(r).card && last(r).card.amount === 79, last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix household problem' });
  ok('side question while paying keeps the order: household help + "back to payment"', last(r).intent === 'HOUSEHOLD_HELPER' && ids(last(r))[0] === 'backpay', last(r));
  r = await olivia.handle(PH, { conversationId: conv, choice: 'backpay' });
  ok('back to payment → the SAME QR again, polling resumes', last(r).intent === 'SEND_PAYMENT' && last(r).card.amount === 79 && r.poll, last(r));
  shop.paid = true;
  r = await olivia.handle(PH, { conversationId: conv, text: 'use coupon FLUX20' });
  ok('coupon after the money arrived → "too late" + delivered (never a second order)', r.messages[0].intent === 'COUPON_TOO_LATE' && last(r).intent === 'PAYMENT_RECEIVED_LOGIN_EMAILED' && calls.filter((c) => c[0] === 'createOrder').length === firstOrder + 1, r.messages);
  ok('Group Offer delivery repeats the group link', last(r).buttons.some((b) => b.id === 'groupjoin'), last(r));
  shop.paid = false;

  // change plan while paying (not paid) / coupon before a plan / tries limit / bad group link
  await olivia.handle(PH, { conversationId: conv, text: 'jiohotstar 3 months' });
  await olivia.handle(PH, { conversationId: conv, choice: 'pay' });
  r = await olivia.handle(PH, { conversationId: conv, text: 'wrong plan, I want to change plan' });
  ok('"change plan" while paying → old QR cancelled + choose again', r.messages[0].intent === 'OLD_QR_CANCELLED' && last(r).intent === 'ASK_SERVICE', r.messages);
  r = await olivia.handle(PH, { conversationId: conv, text: 'coupon code FLUX20' });
  ok('coupon before a plan → "pick the plan first", code remembered', r.messages[0].intent === 'COUPON_PICK_PLAN_FIRST', r.messages);
  r = await olivia.handle(PH, { conversationId: conv, text: 'jiohotstar' });
  r = await olivia.handle(PH, { conversationId: conv, choice: findBtn(last(r), /3 months/).id });
  ok('remembered coupon applied as soon as the plan is picked', r.messages.some((m) => m.intent === 'COUPON_APPLIED') && last(r).intent === 'CONFIRM_PLAN_COUPON' && /₹179/.test(last(r).text), r.messages);
  r = await olivia.handle(PH, { conversationId: conv, choice: 'nocoupon' });
  ok('continue without coupon → normal confirm', last(r).intent === 'CONFIRM_PLAN' && /₹199/.test(last(r).text), last(r));
  for (let i = 0; i < 5; i++) await olivia.handle(PH, { conversationId: conv, text: 'coupon BAD' + i });
  r = await olivia.handle(PH, { conversationId: conv, text: 'coupon BAD9' });
  ok('more than 5 coupon tries → stop guessing', last(r).intent === 'COUPON_TOO_MANY' && calls.filter((c) => c[0] === 'validateCoupon' && /^BAD/.test(c[2])).length < 6, last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'netflix group offer private 1 month' });
  ok('a group plan with a bad link falls back to the FluxFilm group link (never javascript:)', last(r).intent === 'GROUP_JOIN' && last(r).buttons.some((b) => b.id === 'groupjoin' && /^https:\/\/chat\.whatsapp\.com\//.test(b.url)), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'hindi mein baat karo' });
  ok('"hindi mein baat karo" switches language', r.lang === 'hi', r);
  await olivia.handle(PH, { conversationId: conv, choice: 'lang:hinglish' });
  ok('"I purchased earlier" is not a buy command', olivia._internal.intentOf('I purchased netflix earlier') === '');
  ok('coupon code picked from a sentence, not the word "code"', olivia._internal.couponCodeIn('mere paas coupon code hai', false) === '' && olivia._internal.couponCodeIn('coupon code is NEW10', false) === 'NEW10' && olivia._internal.couponCodeIn('new10', true) === 'NEW10');

  // off-script question → answer only from facts
  await olivia.saveSettings({ aiWords: true, knowledge: 'Sharing plans work on 1 device at a time. Do not change the profile PIN.' }); olivia._internal.reset();
  const seenQ = [];
  olivia._internal.setDeps({ words: Object.assign({}, words, {
    say: (i, f, l, s2) => words.say(i, f, l, Object.assign({}, s2, { aiWords: false })),
    classify: async () => ({ id: '', tokens: 0 }),
    answer: (q, facts, k, l, s2) => words.answer(q, facts, k, l, s2, { model: async (m) => { seenQ.push(m); return /tv/i.test(q) ? { json: { text: 'Sharing works on 1 device at a time, TV too 😊', handoff: false }, tokens: 30 } : { json: { text: 'Sure, you get 3 months free!', handoff: false }, tokens: 30 }; } }),
  }) });
  r = await olivia.handle(PH, { conversationId: conv, text: 'does sharing work on my tv?' });
  ok('off-script question → answer from owner knowledge, same buttons kept', last(r).intent === 'FREE_ANSWER' && /1 device/.test(last(r).text) && last(r).buttons.length > 0, last(r));
  ok('the model got live prices + owner knowledge, but no phone / email / name', JSON.stringify(seenQ).includes('Sharing plans work on 1 device') && JSON.stringify(seenQ).includes('₹') && !JSON.stringify(seenQ).includes('9876543210') && !JSON.stringify(seenQ).includes('ramesh@example.com') && !JSON.stringify(seenQ).includes('Ramesh'));
  r = await olivia.handle(PH, { conversationId: conv, text: 'any free months offer for me?' });
  ok('an unsafe answer ("3 months free") is thrown away → handed to the team on WhatsApp', last(r).intent === 'QUESTION_TO_TEAM' && !/free/i.test(last(r).text) && last(r).buttons.some((b) => b.id === 'whatsapp'), last(r));
  r = await olivia.handle(PH, { conversationId: conv, text: 'asdf' });
  ok('gibberish (not a question) still → "did not understand"', last(r).intent === 'DIDNT_UNDERSTAND', last(r));
  olivia._internal.setDeps({ words });
  await olivia.saveSettings({ aiWords: false }); olivia._internal.reset();

  // ── words: AI rewrite only when it keeps the facts ──
  const base = words.template('CONFIRM_PLAN', { title: 'Netflix Sharing 1 month', price: 139 }, 'en');
  ok('check: faithful rewrite accepted', words.check('Great choice! Netflix Sharing 1 month is ₹139. Shall I send you the payment QR?', base));
  ok('check: changed price rejected', !words.check('Netflix Sharing 1 month is just ₹129! Send QR?', base));
  ok('check: new number rejected', !words.check('Netflix Sharing 1 month for ₹139, valid 45 days!', base));
  ok('check: a rewrite with a dropped word ("renew, ?") rejected', !words.check('Which plan would you like to renew, ?', words.template('RENEW_PICK', {}, 'en')));
  ok('check: link / email / password rejected', !words.check('Pay ₹139 at https://x.co', base) && !words.check('₹139, mail help@x.com', base) && !words.check('₹139 and your password', base));
  const seen = [];
  const good = { model: async (m) => { seen.push(m); return { json: { text: 'Hello {NAME} ji 😊 Bataiye, kya madad karoon?' }, tokens: 42 }; } };
  let w = await words.say('GREET_MENU', { name: 'Ramesh' }, 'hinglish', { aiWords: true, voice: 'warm' }, good);
  ok('say: AI words used when safe, name filled back in after', w.ai === true && w.text === 'Hello Ramesh ji 😊 Bataiye, kya madad karoon?' && w.tokens === 42, w);
  ok('model never receives the customer name (only {NAME}) and gets the voice guide', !JSON.stringify(seen).includes('Ramesh') && JSON.stringify(seen).includes('{NAME}') && JSON.stringify(seen).includes('warm'));
  const bad = { model: async () => ({ json: { text: 'Aapka payment ₹100 mil gaya!' }, tokens: 9 }) };
  w = await words.say('SEND_PAYMENT', { amount: 139 }, 'en', { aiWords: true }, bad);
  ok('say: unsafe AI words thrown away → template', w.ai === false && /₹139/.test(w.text) && !/100/.test(w.text), w);
  w = await words.say('SEND_PAYMENT', { amount: 139 }, 'en', { aiWords: true }, { model: async () => null });
  ok('say: model down → template', w.ai === false && /₹139/.test(w.text));
  let cls = await words.classify('bhai sasta wala', [{ id: 'plan:0', label: '1 month · ₹139' }], 'hinglish', { aiWords: true }, { model: async () => ({ json: { id: 'plan:7' }, tokens: 5 }) });
  ok('classify: an id the model invented is ignored', cls.id === '');
  cls = await words.classify('pehla wala', [{ id: 'plan:0', label: '1 month · ₹139' }], 'hinglish', { aiWords: true }, { model: async () => ({ json: { id: 'plan:0' }, tokens: 5 }) });
  ok('classify: a listed id is accepted', cls.id === 'plan:0');
  ok('every intent has English, Hinglish and Hindi', words.INTENTS.every((i) => ['en', 'hinglish', 'hi'].every((l) => typeof words._internal.T[i][l] === 'function')));

  // ── admin reads ──
  const rec = await olivia.recent(10);
  ok('admin: recent chats listed', rec.ok && rec.conversations.length >= 1);
  const mm = await olivia.messagesOf(conv);
  ok('admin: messages of a chat', mm.ok && mm.messages.length > 10);
  ok('admin: bad id refused', (await olivia.messagesOf('../x')).ok === false);

  // ── wiring: server, admin, storefront, widget ──
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  ok('server: oliviaStatus + oliviaChat actions, rate limited, /olivia.js served', /oliviaStatus: \(a\) => oliviaMod\.status\(a\[0\]\)/.test(server) && /oliviaChat: \(a\) => oliviaMod\.handle\(a\[0\], a\[1\]\)/.test(server) && /LIMITS\.oliviaChat/.test(server) && /app\.get\('\/olivia\.js'/.test(server));
  ok('server: /olivia.js route is before the storefront catch-all', server.indexOf("app.get('/olivia.js'") < server.indexOf("app.get('*'"));
  ok('admin.js mounts adminolivia', /require\('\.\/adminolivia'\)\.mount/.test(fs.readFileSync(path.join(root, 'admin.js'), 'utf8')));
  const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  ok('admin.html: 🤖 Olivia AI menu + screen', /\['olivia', '🤖', 'Olivia AI'\]/.test(adminHtml) && /olivia: oliviaView/.test(adminHtml) && /function oliviaView\(\)/.test(adminHtml) && /schema-v21\.sql/.test(adminHtml));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const help = html.slice(html.indexOf('function ffOpenHelp_()'), html.indexOf('function HelpButton()'));
  ok('Help: asks Olivia first, WhatsApp otherwise', /window\.ffOlivia && window\.ffOlivia\.open\(\)/.test(help) && help.indexOf('ffOlivia') < help.indexOf('API.openWhatsApp()'));
  ok('storefront loads /olivia.js', /<script src="\/olivia\.js" defer><\/script>/.test(html));
  const widget = fs.readFileSync(path.join(root, 'oliviawidget.js'), 'utf8');
  ok('widget parses', (() => { try { new Function(widget); return true; } catch (e) { return false; } })());
  ok('widget: login card never saved to sessionStorage; sends installedApp; draws server buttons only', /access-hidden/.test(widget) && /installedApp: installed\(\)/.test(widget) && /display-mode: standalone/.test(widget) && /textContent = text/.test(widget) && !/innerHTML = [^'']/.test(widget.replace("list.innerHTML = ''", '')));
  ok('widget: 2 choices — Chat with Olivia / WhatsApp our team', /Chat with Olivia/.test(widget) && /WhatsApp our team/.test(widget));
  const schemaSql = fs.readFileSync(path.join(root, 'db', 'schema-v21.sql'), 'utf8');
  ok('schema-v21: both tables, IF NOT EXISTS', /CREATE TABLE IF NOT EXISTS olivia_conversations/.test(schemaSql) && /CREATE TABLE IF NOT EXISTS olivia_messages/.test(schemaSql));

  console.log('\nolivia: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
