/* 💬 How every customer message is written.
 *
 * Owner, 23 Sep 2026: "improve all the messages or texts — for example when we want to remind, and the one of
 * swayam — use bold words and some emojis".
 *
 * One wording, three channels (watext.js): WhatsApp gets *bold*, a plain screen gets the markers stripped, an
 * email gets <b>. This file checks that the rules hold, that nothing the owner typed can break the formatting,
 * and — the important one — that the reminder in the admin page and the reminder on the server are the SAME
 * text. Those two have always been separate copies; now they are compared character for character.
 *
 * Run: npm test  (no database, no network)
 */
process.env.TZ = 'Asia/Kolkata';
process.env.SITE_URL = 'https://shop.fluxfilm.in';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
// The admin page's own prettyDate, in miniature: '2026-09-25' -> '25 Sep 2026'.
const ymdPretty = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1] + ' ' + m[1] : String(v || ''); };
const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const watext = require('../watext');
const credit = require('../credit');
const renewal = require('../renewal');
const paylink = require('../paylink');

section('one wording, three channels (watext.js)');
{
  const src = 'Pay *₹99* by *25 Sep* & keep <watching>';
  ok('WhatsApp keeps the markers', watext.wa(src) === src);
  ok('a plain screen loses them', watext.plain(src) === 'Pay ₹99 by 25 Sep & keep <watching>');
  ok('an email gets <b>, and is escaped', watext.html(src) === 'Pay <b>₹99</b> by <b>25 Sep</b> &amp; keep &lt;watching&gt;', watext.html(src));
  ok('newlines survive into the email', watext.html('a\nb') === 'a<br>b');
  ok('a lone star is left alone, not turned into half a tag', watext.plain('5 * 3') === '5 * 3' && watext.html('5 * 3') === '5 * 3');
  ok('markers never span a line break', watext.plain('*a\nb*') === '*a\nb*');
  // Plan names are typed by the owner in the admin panel.
  ok('owner-typed text is stripped of markers before it goes in', watext.clean('Netflix *Special* _2_') === 'Netflix Special 2');
  ok('a first name is a name, never a number or an email', watext.firstName('Swayam Garg') === 'Swayam' && watext.firstName('9971430096') === '' && watext.firstName('a@b.com') === '');
  ok('join drops the empty bits and never doubles a blank line', watext.join(['a', '', '', null, false, 'b', '']) === 'a\n\nb');
}

section('the renewal sentence (the one from Swayam\'s order)');
{
  const DAY = 86400000, now = Date.now();
  const r = renewal.computeRenewal({ expiry: new Date(now - 14.2 * DAY), removed: true, removedAt: new Date(now - 6 * DAY), now: new Date(now), durationDays: 30 });
  ok('the rule still counts 5 and gifts 3', r.counted === 5 && r.gifted === 3, r);
  ok('WhatsApp: the numbers are bold and it opens with an emoji', /^⏳ /.test(r.messageWa) && /counted only \*5 days\*/.test(r.messageWa) && /gifted you \*3 days\* free/.test(r.messageWa) && /🎁/.test(r.messageWa), r.messageWa);
  ok('the shop screen gets the same sentence without the stars', r.message === watext.plain(r.messageWa) && !r.message.includes('*'), r.message);
  ok('the email turns them into <b>', /counted only <b>5 days<\/b>/.test(watext.html(r.messageWa)));

  const early = renewal.computeRenewal({ expiry: new Date(now + 3 * DAY), removed: false, now: new Date(now), durationDays: 30 });
  ok('renewing early still reads as good news', /^✅ /.test(early.messageWa) && /\*on top\*/.test(early.messageWa), early.messageWa);
  const admin1 = renewal.computeAdminRenewal({ base: 'TODAY', expiry: new Date(now + 5 * DAY), now: new Date(now), durationDays: 30 });
  ok('the admin "start from today" choice is worded for the customer too', /^🎬 Starts fresh from \*today\*/.test(admin1.messageWa), admin1.messageWa);
  ok('every renewal case comes with both versions', ['NO_EXPIRY', 'ON_TIME'].every((c) => {
    const x = c === 'ON_TIME' ? early : renewal.computeRenewal({ expiry: null, now: new Date(now), durationDays: 30 });
    return typeof x.messageWa === 'string' && x.message === watext.plain(x.messageWa);
  }));
}

section('the reminder — the page and the server must say the same thing');
{
  // Lift the admin page's own builder out of admin.html and run it against credit.js.
  function lift(name) {
    const start = admin.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('no ' + name);
    let i = admin.indexOf('{', start), d = 0;
    for (; i < admin.length; i++) { if (admin[i] === '{') d++; else if (admin[i] === '}') { d--; if (!d) return admin.slice(start, i + 1); } }
    throw new Error('unbalanced ' + name);
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const waRemindText = new Function('MON', 'crRenewLink',
    [lift('waClean'), lift('waName'), lift('waJoin'), lift('waYmd'), lift('waRemindText'), 'return waRemindText;'].join('\n'))(
    MON, (id) => 'https://shop.fluxfilm.in/?source=push&renew=' + encodeURIComponent(id || ''));

  const CASES = [
    ['renewed on credit, money due', { name: 'Swayam Garg', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', expiry: '2026-10-17', subId: 'SUB-895347435', due: 99, dueDate: '2026-09-25', daysLeft: 24 }],
    ['expired', { name: 'Mohammad', service: 'Prime Video', plan: '1 Month', expiry: '2026-09-06', subId: 'SUB-X', daysLeft: -17 }],
    ['expires today', { name: 'Asha', service: 'Zee5 Premium', plan: '1 Month', expiry: '2026-09-23', subId: 'SUB-Y', daysLeft: 0 }],
    ['expires in one day', { name: 'Asha', service: 'Zee5', plan: '', expiry: '2026-09-24', subId: 'SUB-Y', daysLeft: 1 }],
    ['expires in 13 days', { name: 'Ravi', service: 'Netflix', plan: 'Sharing 1M', expiry: '2026-10-06', subId: 'SUB-Z', daysLeft: 13 }],
    ['no expiry on the row at all', { name: '', service: 'SonyLiv Premium', plan: '1 Month', expiry: '', subId: 'SUB-W', daysLeft: null }],
    ['a plan name with markers in it', { name: 'Ravi', service: 'Netflix *Special*', plan: '_Sharing_ 1M', expiry: '2026-10-06', subId: 'SUB-Z', daysLeft: 13 }],
  ];
  let same = 0;
  for (const [label, p] of CASES) {
    const fromServer = credit.whatsappText(Object.assign({}, p, { now: new Date('2026-09-23T10:00:00+05:30') }));
    const fromPage = waRemindText(p);
    if (fromServer === fromPage) same++;
    else { fail++; console.log('  FAIL page and server differ: ' + label + '\n    server: ' + JSON.stringify(fromServer) + '\n    page:   ' + JSON.stringify(fromPage)); }
  }
  ok('all ' + CASES.length + ' reminders are identical in the page and on the server', same === CASES.length, { same, of: CASES.length });

  const due = credit.whatsappText(Object.assign({}, CASES[0][1], { now: new Date('2026-09-23T10:00:00+05:30') }));
  ok('the amount and the date stand out', /💳 \*₹99\* is due by \*25 Sep 2026\*\./.test(due), due);
  ok('it still says the plan is renewed and till when', /✅ Your FluxFilm \*Netflix \(Group Offer\)\* \(Sharing 1M\) is renewed — valid till \*17 Oct 2026\*\./.test(due), due);
  ok('it is short lines, not one long sentence', due.split('\n').length >= 7 && !due.split('\n').some((l) => l.length > 110), due.split('\n').map((l) => l.length));

  const expired = credit.whatsappText(Object.assign({}, CASES[1][1], { now: new Date('2026-09-23T10:00:00+05:30') }));
  ok('an expired plan leads with ⏰ and the renew link is on its own line', /^⏰/m.test(expired) && expired.includes('\nhttps://shop.fluxfilm.in/?source=push&renew=SUB-X\n'), expired);

  const nasty = credit.whatsappText(Object.assign({}, CASES[6][1], { now: new Date('2026-09-23T10:00:00+05:30') }));
  ok('a plan name with its own * cannot break the bold', nasty.includes('*Netflix Special* (Sharing 1M)') && (nasty.match(/\*/g) || []).length % 2 === 0, nasty.split('\n')[2]);
}

section('the payment link message');
{
  const m = paylink.messageFor({ name: 'Swayam Garg', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', final_amount: 99 }, 'https://shop.fluxfilm.in/pay/FF5034938?t=abc');
  ok('the amount is bold and the link sits alone so the phone makes it tappable', /💳 Amount: \*₹99\*/.test(m) && m.includes('\nhttps://shop.fluxfilm.in/pay/FF5034938?t=abc'), m);
  ok('it explains why the order number matters', /order number is already inside the payment/.test(m), m);
  ok('no stray markers', (m.match(/\*/g) || []).length % 2 === 0, m);
}

section('the message the owner copies after an order');
{
  const qWaText = (() => {
    const start = admin.indexOf('function qWaText(');
    let i = admin.indexOf('{', start), d = 0, end = -1;
    for (; i < admin.length; i++) { if (admin[i] === '{') d++; else if (admin[i] === '}') { d--; if (!d) { end = i + 1; break; } } }
    function lift(name) {
      const s2 = admin.indexOf('function ' + name + '(');
      let j = admin.indexOf('{', s2), k = 0;
      for (; j < admin.length; j++) { if (admin[j] === '{') k++; else if (admin[j] === '}') { k--; if (!k) return admin.slice(s2, j + 1); } }
    }
    return new Function('prettyDate', [lift('waClean'), lift('waName'), lift('waJoin'), admin.slice(start, end), 'return qWaText;'].join('\n'))(ymdPretty);
  })();

  const r = renewal.computeRenewal({ expiry: new Date(Date.now() - 14.2 * 86400000), removed: true, removedAt: new Date(Date.now() - 6 * 86400000), now: new Date(), durationDays: 30 });
  const text = qWaText({
    name: 'Swayam Garg', service: 'Netflix (Group Offer)', plan: 'Sharing 1M', orderId: 'FF5034938', amount: 99,
    status: 'CREDIT', mode: 'RENEW', creditDueDate: '2026-09-25',
    fulfillment: { fulfillment: 'FULFILLED', access: { user: 'a@b.c', pass: 'Pa*ss', profilePin: '3333' }, newExpiryText: r.newExpiryText, renewMessage: r.message, renewMessageWa: r.messageWa },
  });
  ok('the labels are bold, the date and the amount are bold', /🔑 \*Login:\* a@b\.c/.test(text) && /📅 \*Valid till:\*/.test(text) && /💳 \*₹99\* is due by \*25 Sep 2026\*/.test(text), text);
  // A password can contain a * of its own — bolding the value would break the message AND the password.
  ok('the password is NOT bold, so a * inside it stays a * ', text.includes('🔒 *Password:* Pa*ss') && !text.includes('*Pa*ss*'), text);
  ok('the gifted days come through in bold', /gifted you \*3 days\* free/.test(text), text);
  ok('it still carries the order number', /🧾 Order: \*FF5034938\*/.test(text));
  ok('no blank line is doubled or left hanging', !/\n\n\n/.test(text) && !/^\n|\n$/.test(text));

  const plain = qWaText({ name: 'Ravi', service: 'Prime Video', plan: '1 Month', orderId: 'FF1', amount: 39, status: 'PAID', fulfillment: { fulfillment: 'FULFILLED', access: { user: 'x@y' }, newExpiryText: '22 Oct 2026' } });
  ok('a plain paid order gains no renewal line', !/gifted|counted/.test(plain) && /✅ Your FluxFilm \*Prime Video\* \(1 Month\) is \*ready\*/.test(plain), plain);
}

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
