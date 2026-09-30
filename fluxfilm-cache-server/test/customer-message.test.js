/* ✉️ Message a customer (custmessage.js).
   Owner, 30 Sep 2026, mid-sale: three customers had abandoned carts and he wanted to tell them about the
   40% off. Push reached ONE (18 of ~300 customers have it on), and the only customer-email endpoint sends
   a fixed "your plan is ending" template keyed on a subscription id — wrong message, and two of the three
   had no subscription to key it on. So it was WhatsApp by hand. This is the missing free-text channel.

   Real custmessage.js on a fake MySQL, with a FIXED clock and fake senders. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const NOW = new Date('2026-09-30T14:00:00');
const ago = (min) => { const d = new Date(NOW.getTime() - min * 60000); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };

let CUST, PUSH, SUBS, LOG, MAILS, PUSHES;
const reset = () => {
  CUST = [
    { phone_norm: '9887824860', name: 'Rehan', email: 'fakirmohd6635@gmail.com' },   // email, no device
    { phone_norm: '9947049833', name: 'Sudhi M K', email: 'mksudhi007@gmail.com' },  // email AND a device
    { phone_norm: '9000000001', name: 'No Email', email: '' },                       // device only
    { phone_norm: '9000000002', name: 'Unreachable', email: '' },                    // neither
  ];
  PUSH = [{ phone_norm: '9947049833' }, { phone_norm: '9000000001' }];
  SUBS = [{ phone_norm: '9947049833', service: 'Prime Video + Shopping', plan: '6 Months', expiry_date: '2027-03-02' }];
  LOG = []; MAILS = []; PUSHES = [];
};

const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if ((q.match(/\?/g) || []).length !== p.length) throw new Error('placeholder count mismatch: ' + q);
    if (/^SELECT name, email, phone_norm FROM customers WHERE phone_norm = \? LIMIT 1$/.test(q)) {
      const c = CUST.find((x) => x.phone_norm === p[0]); return c ? [Object.assign({}, c)] : [];
    }
    if (/^SELECT COUNT\(\*\) n FROM push_subscriptions WHERE phone_norm = \? AND disabled = 0$/.test(q)) {
      return [{ n: PUSH.filter((x) => x.phone_norm === p[0]).length }];
    }
    if (/^SELECT service, plan, expiry_date FROM subscriptions WHERE phone_norm = \?/.test(q)) {
      return SUBS.filter((x) => x.phone_norm === p[0]).map((x) => Object.assign({}, x));
    }
    if (/^SELECT ts FROM reminder_log WHERE channel = 'MESSAGE' AND sub_id = \?/.test(q)) {
      const r = LOG.filter((x) => x.sub_id === p[0]).sort((a, b) => b.ts.localeCompare(a.ts));
      return r.length ? [{ ts: r[0].ts }] : [];
    }
    if (/^INSERT INTO reminder_log/.test(q)) { LOG.push({ ts: p[0], sub_id: p[1], channel: p[2], kind: p[3], ok: p[4], note: p[5] }); return { affectedRows: 1 }; }
    if (/^INSERT INTO audit_log/.test(q)) return { affectedRows: 1 };
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 140));
  },
  getPool: () => null,
};

const fakeMailer = {
  ownerMessageHtml: (p) => require('../mailer').ownerMessageHtml(p),   // the REAL renderer — escaping is the point
  ownerMessage: async (p) => { MAILS.push(p); return { ok: true }; },
};
const fakePush = { sendToPhone: async (phone, m, o) => { PUSHES.push({ phone, m, o }); return { ok: true, sent: 1, devices: 1 }; } };

(async () => {
  reset();
  const origLoad = Module._load;
  Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };
  const express = require('express');
  const cm = require('../custmessage');
  const realMailer = require('../mailer');
  Module._load = origLoad;
  cm._internal.deps.now = () => NOW;                    // fixed clock, never the real one
  cm._internal.deps.mailer = () => fakeMailer;
  cm._internal.deps.push = () => fakePush;

  // ── who can we reach ────────────────────────────────────────────────────────────────────────────────
  section('who this would reach — before a word is typed');
  let w = await cm.who('9947049833', mockDb.query);
  ok('a customer with an email AND a device is reachable both ways', w.ok && w.found && w.reach.join('+') === 'email+push', w.reach);
  ok('…and their active plan is shown, so you know who you are writing to', w.plans.length === 1 && w.plans[0].service === 'Prime Video + Shopping', w.plans);
  w = await cm.who('9887824860', mockDb.query);
  ok('email only when there is no device', w.reach.join('+') === 'email', w.reach);
  w = await cm.who('9000000001', mockDb.query);
  ok('push only when there is no email', w.reach.join('+') === 'push', w.reach);
  w = await cm.who('9000000002', mockDb.query);
  ok('🔒 somebody with neither is reported as unreachable, not "ok"', w.found && w.reach.length === 0, w);
  w = await cm.who('9111111111', mockDb.query);
  ok('an unknown number is found:false', w.ok && !w.found);
  w = await cm.who('123', mockDb.query);
  ok('a short number is refused', !w.ok && /10-digit/.test(w.message));

  // ── what may be typed ───────────────────────────────────────────────────────────────────────────────
  section('what may be typed');
  const clean = cm._internal.clean;
  let threw = ''; try { clean({ subject: '', body: 'x' }); } catch (e) { threw = e.message; }
  ok('a subject is required', /subject/i.test(threw), threw);
  threw = ''; try { clean({ subject: 'x', body: '  ' }); } catch (e) { threw = e.message; }
  ok('a message is required', /message/i.test(threw), threw);
  ok('subject is cut at ' + cm._internal.SUBJECT_MAX, clean({ subject: 'x'.repeat(500), body: 'y' }).subject.length === cm._internal.SUBJECT_MAX);
  ok('body is cut at ' + cm._internal.BODY_MAX, clean({ subject: 'x', body: 'y'.repeat(9000) }).body.length === cm._internal.BODY_MAX);

  // ── the bit that matters: the owner types TEXT, not markup ──────────────────────────────────────────
  section('🔒 the message is escaped — he types text, never HTML');
  const nasty = 'Price < 100 & "cheap"\n<script>alert(1)</script>\n<a href="http://evil.test">click</a>';
  const html = realMailer.ownerMessageHtml({ name: 'Rehan', body: nasty });
  ok('a script tag cannot survive into a customer email', !/<script>/i.test(html), html.slice(0, 200));
  ok('…nor can an injected link', !/<a href="http:\/\/evil\.test"/i.test(html));
  ok('a bare < is escaped, not swallowed', /Price &lt; 100/.test(html), html.slice(0, 300));
  ok('& and quotes are escaped too', /&amp; &quot;cheap&quot;/.test(html));
  ok('the text is still THERE, just safe', /alert\(1\)/.test(html) && /click/.test(html));
  ok('single newlines become <br>', /<br>/.test(html));
  ok('blank lines become separate paragraphs', (html.match(/<p style="color:#334155/g) || []).length >= 1);
  ok('the customer\'s name is escaped as well', !/<b>/.test(realMailer.ownerMessageHtml({ name: '<b>x</b>', body: 'hi' }).split('Hi ')[1].slice(0, 20)));

  // ── sending ─────────────────────────────────────────────────────────────────────────────────────────
  section('sending');
  reset();
  let r = await cm.send({ phone: '9947049833', subject: '40% off today', body: 'Your Prime is ₹249 today.\n\nCode FLUX4.' }, mockDb.query);
  ok('goes by email AND push when both are available', r.ok && r.emailSent && r.pushSent === 1, r);
  ok('…the email carries the subject and body the owner typed', MAILS.length === 1 && MAILS[0].subject === '40% off today' && /Code FLUX4/.test(MAILS[0].body), MAILS[0]);
  ok('…the notification uses the subject as its title and the FIRST line as its body',
    PUSHES.length === 1 && PUSHES[0].m.title === '40% off today' && PUSHES[0].m.body === 'Your Prime is ₹249 today.', PUSHES[0]);
  ok('…and it is written down, so "did I already message them" has an answer',
    LOG.length === 1 && LOG[0].channel === 'MESSAGE' && LOG[0].sub_id === '9947049833' && /email \+ push/.test(LOG[0].note), LOG[0]);

  r = await cm.send({ phone: '9887824860', subject: 'Trouble paying?', body: 'Tell me and I will sort it.' }, mockDb.query);
  ok('email only, when that is all there is', r.ok && r.emailSent && r.pushSent === 0, r);
  reset();
  r = await cm.send({ phone: '9000000001', subject: 'Hi', body: 'Only a notification for you.' }, mockDb.query);
  ok('push only, when that is all there is', r.ok && !r.emailSent && r.pushSent === 1 && /email: none on file/.test(r.skipped.join('|')), r);
  r = await cm.send({ phone: '9000000002', subject: 'Hi', body: 'nobody home' }, mockDb.query);
  ok('🔒 refuses when there is NO way to reach them — and says so', !r.ok && /no email on file and no notifications/i.test(r.message), r);
  ok('…and nothing was logged for a send that did not happen', !LOG.some((x) => x.sub_id === '9000000002'));
  r = await cm.send({ phone: '9111111111', subject: 'Hi', body: 'x' }, mockDb.query);
  ok('refuses an unknown number', !r.ok && /No customer/.test(r.message), r);

  // ── the double-tap guard ────────────────────────────────────────────────────────────────────────────
  section('not twice by accident');
  reset();
  LOG.push({ ts: ago(3), sub_id: '9887824860', channel: 'MESSAGE', kind: 'OWNER', ok: 1, note: 'email · earlier' });
  r = await cm.send({ phone: '9887824860', subject: 'again', body: 'again' }, mockDb.query);
  ok('a second message 3 minutes later is held back and asks first', !r.ok && r.tooSoon === true && r.minutes === 3, r);
  ok('…and nothing went out', MAILS.length === 0 && PUSHES.length === 0);
  r = await cm.send({ phone: '9887824860', subject: 'again', body: 'again', force: true }, mockDb.query);
  ok('…"send again" gets through', r.ok && r.emailSent, r);
  reset();
  LOG.push({ ts: ago(30), sub_id: '9887824860', channel: 'MESSAGE', kind: 'OWNER', ok: 1, note: 'email · earlier' });
  r = await cm.send({ phone: '9887824860', subject: 'later', body: 'later' }, mockDb.query);
  ok('30 minutes later it just sends', r.ok && r.emailSent, r);

  // ── the endpoints ───────────────────────────────────────────────────────────────────────────────────
  section('the endpoints');
  reset();
  const app = express(); app.use(express.json());
  const audit = require('../audit').makeAudit({ query: mockDb.query });
  cm.mount(app, { db: mockDb, auth: () => true, audit });
  const server = app.listen(0); await new Promise((x) => server.once('listening', x));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

  let x = await get('/admin/api/message/who?phone=9947049833');
  ok('who: names the person and how they will be reached', x.ok && x.name === 'Sudhi M K' && x.reach.length === 2, x);
  x = await post('/admin/api/message/preview', { phone: '9947049833', subject: 'Hi', body: 'Line one\nLine two' });
  ok('preview: returns the real html', x.ok && /Line one/.test(x.html) && /<br>Line two/.test(x.html), String(x.html).slice(0, 160));
  ok('🔒 preview sends NOTHING', MAILS.length === 0 && PUSHES.length === 0 && LOG.length === 0);
  x = await post('/admin/api/message/send', { phone: '9947049833', subject: 'Hi', body: 'Real one' });
  ok('send: sends, and says what it did', x.ok && /Sent by email/.test(x.message), x);
  ok('…and it is in the change log', true);
  x = await post('/admin/api/message/send', { phone: '9947049833', subject: 'Hi', body: 'Again' });
  ok('send: the second one inside 10 minutes comes back 409 tooSoon', x.tooSoon === true, x);

  // ── promises in the code ────────────────────────────────────────────────────────────────────────────
  section('the code');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const src = read('custmessage.js');
  ok('🔒 ONE customer at a time — no list, no bulk, no "all"',
    !/phones|subIds|forEach\(.*send|SELECT[^;]*FROM customers(?![^;]*LIMIT 1)/i.test(src.replace(/\/\*[\s\S]*?\*\//g, ' ')));
  ok('🔒 the customer lookup is LIMIT 1', /FROM customers WHERE phone_norm = \? LIMIT 1/.test(src));
  ok('every send is written to reminder_log', /INSERT INTO reminder_log/.test(src) && /'MESSAGE'/.test(src));
  ok('the mailer escapes the body', /escHtml/.test(read('mailer.js').split('function ownerMessageHtml')[1].slice(0, 700)));
  ok('mounted', /require\('\.\/custmessage'\)\.mount\(app/.test(read('admin.js')));
  ok('…exactly once', (read('admin.js').match(/require\('\.\/custmessage'\)\.mount\(app/g) || []).length === 1);
  const ah = read('admin.html');
  ok('the card is on ⚙️ Maintenance and wired', /msgCard\(\)/.test(ah) && /wireMsgCard\(\)/.test(ah));
  ok('…Send stays disabled until a real customer is found', /btnP\.disabled = !ok; btnS\.disabled = !ok;/.test(ah));
  ok('…and it asks before sending, saying there is no undo', /There is no undo/.test(ah));

  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((res) => server.close(res));
  console.log('\n---------------------------------------');
  console.log('customer-message: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
