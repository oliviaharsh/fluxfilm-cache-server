/* 📺 How the TV worker reads Prime Video's device list (worker/tvworker.js).
 *
 * Why this file exists, 3 Oct 2026: the first version of the reader kept only the rows whose text matched
 * "registration date". The real page never says those words. So the list came back empty for every account,
 * and an empty list is indistinguishable from an empty account — the worker would have registered the
 * customer's TV correctly and then told them "the code did not register", burning their code every time.
 * Exactly the mistake CLAUDE.md already records from the Netflix household tool: deciding by grepping for a
 * word. The reader now compares the TEXT a person would see, before and after.
 *
 * ⚠️ HONESTY NOTE ABOUT THE FIXTURES. The EMPTY page below is a real capture from PRI-13 on 3 Oct 2026.
 * The POPULATED one is NOT — no account we can reach has a device on it today, so it is written by hand.
 * It is built to look awkward on purpose (a name, a date on its own line, no helpful keyword), but it is
 * still a guess at the shape. These tests prove the DIFFING is right and that the old bug cannot come back.
 * They do NOT prove we can read a real populated page. That needs one signed-in account that has devices,
 * and until that is done the worker should be watched rather than trusted.
 *
 * Run: npm test */
const path = require('path');
const worker = require(path.join(__dirname, '..', 'worker', 'tvworker.js'));
const { contentLines, newLines, deviceLines, NOT_A_DEVICE } = worker;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ── the real empty page, captured from the account itself ───────────────────────────────────────────────
const EMPTY = [
  'Home', 'Movies', 'TV shows', 'Sports', 'Devices',
  "You don't have any registered devices.",
  'Register new device',
  'Watch your favorite movies, TV shows, live events, and premium add-on subscriptions on Prime Video with your devices.',
  'Register new device',
  'Terms and Privacy NoticeSend us feedbackHelpCookies Notice© 1996-2026, Amazon.com, Inc. or its affiliates',
].join('\n');

// ── a populated page. HAND-WRITTEN (see the note above), and deliberately unhelpful: the word "device"
//    never appears in a row, and the date sits on its own line, the way these pages usually render.
const ONE_DEVICE = [
  'Home', 'Movies', 'TV shows', 'Sports', 'Devices',
  'Living Room TV',
  'Registered on 3 October 2026',
  'Register new device',
  'Terms and Privacy NoticeSend us feedbackHelpCookies Notice© 1996-2026, Amazon.com, Inc. or its affiliates',
].join('\n');

const TWO_DEVICES = ONE_DEVICE.replace('Register new device',
  'Fire TV Stick\nRegistered on 3 October 2026\nRegister new device');

(function () {
  section('the real empty page');
  const empty = contentLines(EMPTY);
  ok('the navigation is not mistaken for devices', empty.indexOf('Home') < 0 && empty.indexOf('Sports') < 0, empty);
  ok('the run-together footer is dropped whole', !empty.some((l) => /Amazon.com, Inc/.test(l)), empty);
  ok('the Register button is not a device', !empty.some((l) => /^Register new device$/i.test(l)), empty);
  ok('what a person reads is still there', empty.some((l) => /any registered devices/.test(l)), empty);
  // 🔒 The guard in deviceList() treats zero lines as UNREADABLE, so a page that renders nothing can never
  // be reported as an empty account. An empty account must still leave something behind.
  ok('an empty account is not silent - it leaves lines, so it is told apart from a page that did not load',
    empty.length > 0, empty);

  section('a page that never says the magic words');
  const before = contentLines(EMPTY), after = contentLines(ONE_DEVICE);
  const fresh = deviceLines(before, after);
  ok('the new device is found although the page never says "registration date"',
    fresh.indexOf('Living Room TV') >= 0, fresh);
  ok('its date comes with it, because removal will need the handle',
    fresh.some((l) => /3 October 2026/.test(l)), fresh);
  ok('the OLD bug would have found nothing here - that is the whole point',
    !/registration date/i.test(ONE_DEVICE) && fresh.length > 0);

  section('it does not invent devices');
  ok('the same page twice is no change at all', newLines(after, after).length === 0, newLines(after, after));
  ok('nothing new on an unchanged empty account', newLines(before, before).length === 0);
  // A device going AWAY also changes the page: the empty-state sentence becomes a brand-new line. Without
  // the prose filter the worker would hand that sentence back as the device it had just registered.
  ok('the raw diff really does surface that sentence - this is the trap', newLines(after, before).length > 0);
  ok('a device REMOVED is not reported as one added', deviceLines(after, before).length === 0, deviceLines(after, before));
  ok('the empty-state sentence is never a device name', NOT_A_DEVICE.test("You don't have any registered devices."));
  ok('neither is the blurb underneath it',
    NOT_A_DEVICE.test('Watch your favorite movies, TV shows, live events, and premium add-on subscriptions on Prime Video with your devices.'));
  ok('but a real TV name passes straight through', !NOT_A_DEVICE.test('Living Room TV') && !NOT_A_DEVICE.test('Fire TV Stick'));

  section('two TVs');
  const two = contentLines(TWO_DEVICES);
  const second = newLines(after, two);
  ok('only the one that is actually new comes back', second.indexOf('Fire TV Stick') >= 0 && second.indexOf('Living Room TV') < 0, second);
  // A multiset, not a set: two devices sharing a name are two devices.
  const dupe = newLines(['Living Room TV'], ['Living Room TV', 'Living Room TV']);
  ok('two TVs with the same name both count', dupe.length === 1, dupe);

  section('rubbish in');
  ok('no text at all reads as unreadable, not as empty', contentLines('').length === 0);
  ok('furniture only reads as unreadable too', contentLines('Home\nMovies\nSports').length === 0);
  ok('a runaway blob of text is not treated as a device name',
    contentLines('x'.repeat(400)).length === 0);

  console.log('\n---------------------------------------');
  console.log('tvworker-devices: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
