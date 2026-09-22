/* 🎁 Renewal days: whatever the late-renewal rule decides has to reach the customer.
 *
 * The bug (owner, 22 Sep 2026, Swayam's renewal): renewing from admin on credit produced a "Valid till" date
 * with the late days already deducted, but the copied WhatsApp message never said that we had counted only
 * some of those days and gifted the rest — so the date just looked short.
 *
 * Run: npm test  (no database, no network: the admin page's own qWaText is pulled out of admin.html and run).
 */
process.env.TZ = 'Asia/Kolkata';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const mailer = fs.readFileSync(path.join(root, 'mailer.js'), 'utf8');
const fulfil = fs.readFileSync(path.join(root, 'fulfill.js'), 'utf8');

/** Lift one top-level `function name(...) { … }` out of the page, braces balanced. */
function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('no function ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// qWaText needs prettyDate and the little WhatsApp-text helpers from the rest of the page.
const qWaText = new Function('prettyDate',
  [lift(admin, 'waClean'), lift(admin, 'waName'), lift(admin, 'waJoin'), lift(admin, 'qWaText'), 'return qWaText;'].join('\n'))(
  (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1] + ' ' + m[1] : String(v || ''); });

const renewal = require('../renewal');
const DAY = 86400000;

section('the copied WhatsApp message');
{
  // The real shape: an 8-day-late renewal where we removed the customer, so 5 days are counted and 3 gifted.
  const rn = renewal.computeRenewal({
    expiry: new Date(Date.now() - 14.2 * DAY), removed: true, removedAt: new Date(Date.now() - 6 * DAY),
    now: new Date(), durationDays: 30,
  });
  ok('the rule itself counts some days and gifts the rest', rn.counted === 5 && rn.gifted === 3, { counted: rn.counted, gifted: rn.gifted, case: rn.case });

  const result = {
    name: 'Swayam Garg', phone: '9971430096', service: 'Netflix (Group Offer)', plan: 'Sharing 1M',
    orderId: 'FF5034938', amount: 99, status: 'CREDIT', mode: 'RENEW', creditDueDate: '2026-09-30',
    fulfillment: { fulfillment: 'FULFILLED', access: { user: 'a@b.c', pass: 'p' }, newExpiryText: rn.newExpiryText, renewMessage: rn.message, renewMessageWa: rn.messageWa },
  };
  const text = qWaText(result);
  ok('it still gives the new date', text.includes('*Valid till:* ' + rn.newExpiryText), text);
  ok('it now says what was counted and what was gifted', /counted only \*5 days\*/.test(text) && /gifted you \*3 days\* free/.test(text), text);
  ok('the gift sits with the date, not at the end after the payment ask', text.indexOf('gifted you') > 0 && text.indexOf('gifted you') < text.indexOf('is due'), text);
  ok('a credit renewal still asks for the money', /💳 \*₹99\* is due/.test(text) && text.includes('FF5034938'), text);
}

{
  // Renewed early / on time: the message is reassurance rather than a gift, and must not be dropped.
  const rn = renewal.computeRenewal({ expiry: new Date(Date.now() + 3 * DAY), removed: false, now: new Date(), durationDays: 30 });
  const text = qWaText({ name: 'A', service: 'Prime Video', plan: '1 Month', orderId: 'FF1', amount: 39, status: 'PAID', mode: 'RENEW',
    fulfillment: { fulfillment: 'FULFILLED', access: {}, newExpiryText: rn.newExpiryText, renewMessage: rn.message, renewMessageWa: rn.messageWa } });
  ok('on-time renewal says nothing was lost', /added \*on top\* of your current plan/.test(text), text);
}

{
  // A new order has no renewal message at all — nothing extra should appear.
  const text = qWaText({ name: 'A', service: 'Prime Video', plan: '1 Month', orderId: 'FF2', amount: 39, status: 'PAID',
    fulfillment: { fulfillment: 'FULFILLED', access: { user: 'x@y' }, newExpiryText: '22 Oct 2026' } });
  ok('a new purchase gains no stray line', !/gifted|counted/.test(text) && /\*Valid till:\* 22 Oct 2026/.test(text), text);
}

section('the same sentence follows the renewal everywhere else');
ok('fulfil hands it to the email', /renewNote: rn\.messageWa/.test(fulfil), false);
ok('fulfil stores it on the order so it can be read back', /\$\.RenewNote/.test(fulfil) && /RenewCounted/.test(fulfil) && /RenewGifted/.test(fulfil), false);
ok('storing the note can never undo the renewal', /catch \(e\) \{ console\.log\('\[renew\] could not store the days note/.test(fulfil), false);
ok('the credentials email prints it', /p\.renewNote \?/.test(mailer), false);
ok('the admin order card shows it', /kv\('Renewal days'/.test(admin), false);
ok('the WhatsApp text prefers the bold version, the card keeps the plain one', /f\.renewMessageWa \|\| f\.renewMessage/.test(admin) && /esc\(m\.renewNote\)/.test(admin), false);

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
