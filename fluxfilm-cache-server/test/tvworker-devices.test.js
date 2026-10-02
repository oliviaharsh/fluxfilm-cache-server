/* 📺 How the TV worker reads Prime Video's device list (worker/tvworker.js).
 *
 * Why this file exists, 3 Oct 2026. The first reader kept only the rows whose text matched "registration
 * date". Held against a REAL populated page it turned out to match exactly one thing: the container holding
 * the whole devices section. So `check` reported "1 device" for an account with four, and a registration
 * would have stored that entire blob of page text as the device's name — and that name is the only handle
 * we will have when the plan ends and the TV has to come off again. The reader now compares the TEXT a
 * person would see, line by line, before and after.
 *
 * ✅ BOTH fixtures below are real captures, not inventions:
 *   · EMPTY — PRI-13 on 3 Oct 2026, an account with nothing registered.
 *   · FOUR  — PRI-27 on 3 Oct 2026, four devices, three of them signed out.
 * The only edit is the device name in FOUR, changed from a customer's to a neutral one, because this repo
 * is not private yet. The FIFTH device in justRegistered() is assembled from the exact row shape the real
 * page uses (name · Registration date: … · Sign out · Prime · Remove), since no TV was registered today.
 *
 * Worth knowing, read straight off the real page: "Your Prime membership allows streaming on 5 devices,
 * including 2 TVs", and signed-out devices are STILL LISTED. The page says to click Remove, not Sign out,
 * to free a slot.
 *
 * Run: npm test */
const path = require('path');
const { contentLines, newLines, deviceLines, NOT_A_DEVICE } = require(path.join(__dirname, '..', 'worker', 'tvworker.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const FOOTER = 'Terms and Privacy NoticeSend us feedbackHelp© 1996-2026, Amazon.com, Inc. or its affiliates';

// ── PRI-13, nothing registered ──────────────────────────────────────────────────────────────────────────
const EMPTY = [
  'Home', 'Movies', 'TV shows', 'Sports', 'Devices',
  "You don't have any registered devices.",
  'Register new device',
  'Watch your favorite movies, TV shows, live events, and premium add-on subscriptions on Prime Video with your devices.',
  'Register new device',
  FOOTER,
].join('\n');

// ── PRI-27, four devices, three signed out ──────────────────────────────────────────────────────────────
const FOUR = [
  'Home', 'Movies', 'TV shows', 'Devices',
  'These are the devices registered to your account.Your Prime membership allows streaming on 5 devices, including 2 TVs.',
  "If you've reached the device limit and want to watch on more devices, remove a device by clicking Remove or buy another Prime membership. If you don't recognize a device, click Sign out.",
  'Register new device',
  'Watch your favorite movies, TV shows, live events, and premium add-on subscriptions on Prime Video with your devices.',
  'Register new device',
  'Prime Video App for Android (Android Phone 2)', 'Registration date: September 28, 2026', 'Sign out', 'Prime', 'Remove',
  'iPhone', 'iPhone', 'Signed out', 'Prime', 'Remove',
  'iPhone', 'iPhone', 'Signed out', 'Prime', 'Remove',
  'Prime Video App for Android', 'Prime Video App for Android', 'Signed out', 'Prime', 'Remove',
  FOOTER,
].join('\n');

/** A fifth device, in the row shape the real page uses. */
const justRegistered = (name, date) =>
  FOUR.replace('Prime Video App for Android (Android Phone 2)',
    [name, 'Registration date: ' + date, 'Sign out', 'Prime', 'Remove', 'Prime Video App for Android (Android Phone 2)'].join('\n'));

(function () {
  section('the real empty page (PRI-13)');
  const empty = contentLines(EMPTY);
  ok('navigation is not mistaken for devices', empty.indexOf('Home') < 0 && empty.indexOf('Sports') < 0, empty);
  ok('the run-together footer is dropped whole', !empty.some((l) => /Amazon.com, Inc/.test(l)), empty);
  ok('the Register button is not a device', !empty.some((l) => /^Register new device$/i.test(l)), empty);
  // 🔒 deviceList() calls zero lines UNREADABLE, so a page that did not load can never read as "no devices".
  ok('an empty account still leaves lines, so it is told apart from a page that did not load', empty.length > 0, empty);

  section('the real populated page (PRI-27)');
  const four = contentLines(FOUR);
  ok('the active device is there, name intact', four.indexOf('Prime Video App for Android (Android Phone 2)') >= 0, four);
  ok('its registration date is there - that is half the removal handle', four.indexOf('Registration date: September 28, 2026') >= 0, four);
  // Each row carries these; one more device means one more of each, which would otherwise read as new.
  ok('the row buttons are not devices', ['Sign out', 'Signed out', 'Remove', 'Prime'].every((b) => four.indexOf(b) < 0), four);
  ok('signed-out devices are still listed, because they still occupy a slot',
    four.filter((l) => l === 'iPhone').length === 4, four);

  section('a fifth device arrives');
  const five = contentLines(justRegistered('Fire TV Stick', 'October 3, 2026'));
  const fresh = deviceLines(four, five);
  ok('exactly the new device and its date come back, nothing else', fresh.length === 2, fresh);
  ok('the name is the name', fresh.indexOf('Fire TV Stick') >= 0, fresh);
  ok('the date rides along', fresh.indexOf('Registration date: October 3, 2026') >= 0, fresh);
  const stored = fresh.join(' · ');
  ok('what we store is a usable handle, not a paragraph of Amazon prose',
    stored === 'Fire TV Stick · Registration date: October 3, 2026', stored);
  ok('the stored name can never swallow the page instructions', !/reached the device limit|These are the devices/.test(stored), stored);
  ok('nor a button', !/Sign out|Remove/.test(stored), stored);

  section('the first device on an empty account');
  const firstOne = deviceLines(contentLines(EMPTY), four);
  ok('registering onto an empty account is seen', firstOne.indexOf('Prime Video App for Android (Android Phone 2)') >= 0, firstOne);
  ok('and the empty-state sentence vanishing is not reported as a device',
    !firstOne.some((l) => /registered devices/.test(l)), firstOne);

  section('it does not invent devices');
  ok('the same page twice is no change at all', deviceLines(five, five).length === 0);
  ok('nothing new on an unchanged empty account', deviceLines(contentLines(EMPTY), contentLines(EMPTY)).length === 0);
  // A device going AWAY also changes the page: the empty-state sentence becomes a brand-new line.
  ok('the raw diff really does surface that sentence - this is the trap', newLines(four, contentLines(EMPTY)).length > 0);
  ok('a device REMOVED is not reported as one added', deviceLines(four, contentLines(EMPTY)).length === 0, deviceLines(four, contentLines(EMPTY)));
  ok('the empty-state sentence is never a device name', NOT_A_DEVICE.test("You don't have any registered devices."));
  ok('neither is the page instructions', NOT_A_DEVICE.test('These are the devices registered to your account.Your Prime membership allows streaming on 5 devices, including 2 TVs.'));
  ok('but real TV names pass straight through', !NOT_A_DEVICE.test('Fire TV Stick') && !NOT_A_DEVICE.test('Living Room TV'));

  section('two TVs with one name');
  const dupe = newLines(['Living Room TV'], ['Living Room TV', 'Living Room TV']);
  ok('a multiset, not a set - both count', dupe.length === 1, dupe);

  section('rubbish in');
  ok('no text at all reads as unreadable, not as empty', contentLines('').length === 0);
  ok('furniture only reads as unreadable too', contentLines('Home\nMovies\nSports').length === 0);
  ok('a runaway blob of text is not treated as a device name', contentLines('x'.repeat(400)).length === 0);

  console.log('\n---------------------------------------');
  console.log('tvworker-devices: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
