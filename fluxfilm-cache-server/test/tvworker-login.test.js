/* 📺 Signing an account back in by itself (worker/tvworker.js).
 *
 * Owner, 3 Oct 2026: *"we created private browser so that it could login on its own incase its logged out"*.
 * So the worker can now do that — and this file is mostly about the limits on it, because an automated
 * sign-in on an account with four paying customers behind it is the riskiest thing in the program.
 *
 * What is locked here:
 *   · it is OFF unless the machine says otherwise — nobody turns this on by accident
 *   · the logins live in a local file; the shop never serves a password and the worker never asks for one
 *   · a missing file or a missing account is a quiet "not my job", not a crash at one in the morning
 *   · three attempts per account per day, and the day rolls over
 *   · a login or a password can never reach a log line
 *
 * Run: npm test */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fftv-'));
const ACCOUNTS = path.join(TMP, 'accounts.json');
// 🔒 Set BEFORE the worker is required: it reads its configuration once, at load.
process.env.FF_ACCOUNTS_FILE = ACCOUNTS;
process.env.FF_PROFILE_DIR = path.join(TMP, 'profiles');
delete process.env.FF_AUTO_LOGIN;

const worker = require(path.join(__dirname, '..', 'worker', 'tvworker.js'));
const { credentialsFor, loginsToday, noteLogin, redact, setAsideProfile, profileFor, CFG, SEL, PASSKEY_DECLINE, sameLogin, readOutcome, loadAccounts, loadEnvFile } = worker;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// 🔒 Source assertions must read CODE, not prose. Twice in one day a check passed because the phrase it
// looked for also appeared in the comment explaining it, while the code itself had been removed.
const codeOnly = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const PW = 'not-a-real-password-8812';
const LOGIN = 'someone@example.com';
const writeAccounts = (o) => fs.writeFileSync(ACCOUNTS, JSON.stringify(o));

(function () {
  section('it is off unless the machine says otherwise');
  ok('automatic sign-in is off by default', CFG.autoLogin === false, CFG.autoLogin);
  ok('three attempts a day unless told otherwise', CFG.maxLoginsPerDay === 3, CFG.maxLoginsPerDay);
  // 🔒 The worker must never go looking to the shop for a password. If this ever fetches, the admin key
  // becomes a key to the whole inventory, which is a far bigger thing than the problem it solves.
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'tvworker.js'), 'utf8');
  ok('the worker never asks the shop for credentials', src.indexOf('/credentials') < 0);
  ok('…and the shop has no route that would answer', fs.readFileSync(path.join(__dirname, '..', 'primetv.js'), 'utf8').indexOf('/credentials') < 0);

  section('no file, no account, bad file');
  try { fs.unlinkSync(ACCOUNTS); } catch (e) {}
  ok('no accounts file at all is a quiet no, not a crash', credentialsFor('PRI-13') === null);
  writeAccounts({ 'PRI-27': { login: LOGIN, password: PW } });
  ok('an account that is not listed is a quiet no', credentialsFor('PRI-13') === null);
  writeAccounts({ 'PRI-13': { login: LOGIN } });
  ok('half an entry is no entry', credentialsFor('PRI-13') === null);
  fs.writeFileSync(ACCOUNTS, '{ this is not json');
  let threw = '';
  try { credentialsFor('PRI-13'); } catch (e) { threw = e.message; }
  ok('a broken file says so in words the owner can act on', /valid JSON/i.test(threw), threw);

  section('a good entry');
  writeAccounts({ 'PRI-13': { login: LOGIN, password: PW } });
  const c = credentialsFor('PRI-13');
  ok('the login comes back', c && c.login === LOGIN, c && c.login);
  ok('the password comes back', c && c.password === PW);

  section('🔒 nothing it touches can reach a log');
  ok('the password is blanked', redact('sign-in failed for ' + PW).indexOf(PW) < 0, redact('x ' + PW));
  ok('so is the login', redact('tried ' + LOGIN).indexOf(LOGIN) < 0, redact('tried ' + LOGIN));
  ok('…and the sentence around it survives', /sign-in failed for/.test(redact('sign-in failed for ' + PW)));
  ok('ordinary text is left alone', redact('the device list did not load') === 'the device list did not load');

  section('three a day, and the day rolls over');
  ok('nothing counted yet', loginsToday('PRI-13').n === 0);
  noteLogin('PRI-13'); noteLogin('PRI-13');
  ok('two counted', loginsToday('PRI-13').n === 2, loginsToday('PRI-13'));
  ok('another account is counted separately', loginsToday('PRI-27').n === 0);
  noteLogin('PRI-13');
  ok('three counted - the cap is now reached', loginsToday('PRI-13').n === CFG.maxLoginsPerDay);
  // Yesterday's count must not hold today's job back.
  const f = path.join(CFG.profiles, 'logins.json');
  fs.writeFileSync(f, JSON.stringify({ day: '2020-01-01', counts: { 'PRI-13': 99 } }));
  ok('yesterday is not held against today', loginsToday('PRI-13').n === 0, loginsToday('PRI-13'));

  section('.env is actually read');
  // 4 Oct 2026: the README told the owner to copy .env.example to .env and fill it in, and NOTHING read
  // the file. FF_HEADLESS=off was ignored - he asked why no browser appeared and I gave him the wrong
  // reason - and FF_ADMIN_KEY stayed empty, which only surfaced when he started the worker with a real
  // customer waiting. A setting a program documents and then ignores is worse than one it never offered.
  const ENVF = path.join(TMP, 'dotenv');
  fs.writeFileSync(ENVF, [
    '# a comment',
    'FFT_PLAIN=one',
    'FFT_SPACED = two',
    'FFT_QUOTED="three"',
    "FFT_SINGLE='four'",
    'export FFT_EXPORTED=five',
    'FFT_EMPTY=',
    'not a line at all',
    'FFT_ALREADY=from-the-file',
  ].join('\n'));
  process.env.FFT_ALREADY = 'from-the-environment';
  const n = loadEnvFile(ENVF);
  ok('plain key=value is read', process.env.FFT_PLAIN === 'one');
  ok('spaces around the = are the owner being tidy, not part of it', process.env.FFT_SPACED === 'two');
  ok('double quotes are stripped', process.env.FFT_QUOTED === 'three');
  ok('single quotes too', process.env.FFT_SINGLE === 'four');
  ok('an export prefix is tolerated', process.env.FFT_EXPORTED === 'five');
  ok('an empty value is still a value', process.env.FFT_EMPTY === '');
  ok('comments and junk lines are skipped', process.env['not a line at all'] === undefined);
  // 🔒 So `FF_ADMIN_KEY=... node tvworker.js run` still beats the file.
  ok('something already in the environment WINS over the file', process.env.FFT_ALREADY === 'from-the-environment');
  ok('it reports how many it read', n >= 6, n);
  ok('a missing file is 0, not a crash', loadEnvFile(path.join(TMP, 'no-such-env')) === 0);

  // 🔒 The bug was not the parser - there was no parser. Order is what matters: the file has to be read
  // BEFORE CFG is built, or every setting in it is read too late to do anything.
  const envsrc = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'worker', 'tvworker.js'), 'utf8'));
  ok('.env is read before the settings are built',
    envsrc.indexOf('loadEnvFile(ENV_FILE)') > 0 && envsrc.indexOf('loadEnvFile(ENV_FILE)') < envsrc.indexOf('const CFG = {'));

  section('the accounts file is checked before a customer checks it for us');
  // Two things that actually happened: a broken file used to degrade SILENTLY (every account looked
  // signed out, which is indistinguishable from a real problem), and the same credentials were pasted
  // under two ids, which left a profile signed into somebody else's account.
  const good = { 'PRI-13': { login: 'a@x.com', password: 'p1' }, 'PRI-27': { login: 'b@y.com', password: 'p2' } };
  writeAccounts(good);
  let a = loadAccounts();
  ok('a good file is clean', a.ok === true, a.problems);
  ok('…and lists what it covers', a.ids.length === 2 && a.ids.indexOf('PRI-27') >= 0, a.ids);

  writeAccounts({ 'PRI-27': { login: 'b@y.com', password: 'p2' }, 'PRI-31': { login: 'B@Y.com', password: 'p2' } });
  a = loadAccounts();
  ok('the SAME login under two ids is caught', !a.ok && a.problems.some((x) => /SAME login/.test(x)), a.problems);
  ok('…even when the capitals differ, which is how it would really look', a.problems.join(' ').indexOf('PRI-31') >= 0);
  ok('…and it names BOTH ids, so the owner knows which two lines to open',
    a.problems.some((x) => x.indexOf('PRI-31') >= 0 && x.indexOf('PRI-27') >= 0), a.problems);

  fs.writeFileSync(ACCOUNTS, '{"PRI-13":{"login":"a@x.com","password":"p1"},}');
  a = loadAccounts();
  ok('a stray comma is caught and named', a.broken === true && /valid JSON/.test(a.problems[0]), a.problems);

  writeAccounts({ 'PRI-13': { login: 'a@x.com' } });
  ok('a missing password is caught', loadAccounts().problems.some((x) => /missing its password/.test(x)));
  writeAccounts({ 'PRI-13': { login: 'the account email', password: 'the account password' } });
  ok('leftover example text is caught', loadAccounts().problems.some((x) => /example text/.test(x)));
  writeAccounts({ '_README': 'ignore me', 'PRI-13': { login: 'a@x.com', password: 'p1' } });
  ok('the _README line is not treated as an account', loadAccounts().ids.length === 1, loadAccounts().ids);

  // 🔒 It reports ids and counts. Never a login, never a password - not even inside a complaint.
  writeAccounts({ 'PRI-13': { login: LOGIN, password: PW }, 'PRI-27': { login: LOGIN, password: PW } });
  const told = JSON.stringify(loadAccounts());
  ok('no login leaks into the report', told.indexOf(LOGIN) < 0, told.slice(0, 200));
  ok('no password leaks into the report', told.indexOf(PW) < 0, told.slice(0, 200));

  section('what Amazon says for itself');
  // Both strings are real, captured 4 Oct 2026: the owner's screenshot of a working registration, and the
  // dry run with a made-up code. Neither is invented.
  const REG = 'Success! Your device is registered to your Prime Video account.';
  const BAD = "That's an invalid code.";
  const PAGE = ['Register a device', 'Register your compatible TV or device', 'Register Device'];

  ok('a real success line is heard', readOutcome(PAGE, PAGE.concat([REG])).registered);
  ok('a real rejection line is heard', readOutcome(PAGE, PAGE.concat([BAD])).badcode);
  ok('a success is not mistaken for a rejection', !readOutcome(PAGE, PAGE.concat([REG])).badcode);
  ok('a rejection is not mistaken for a success', !readOutcome(PAGE, PAGE.concat([BAD])).registered);
  ok('an unchanged page says neither', !readOutcome(PAGE, PAGE).registered && !readOutcome(PAGE, PAGE).badcode);
  // 🔒 Before and after, exactly like the device list: a banner already on the page is not news. Without
  // this, a leftover success message from an earlier registration would read as this one succeeding.
  ok('a banner that was ALREADY there is not news', !readOutcome(PAGE.concat([REG]), PAGE.concat([REG])).registered);
  ok('…and the same for a leftover error', !readOutcome(PAGE.concat([BAD]), PAGE.concat([BAD])).badcode);
  ok('ordinary page furniture triggers nothing',
    !readOutcome([], PAGE).registered && !readOutcome([], PAGE).badcode, PAGE);
  // 🔒 The page text must never be able to MANUFACTURE a success on its own.
  const wsrc2 = fs.readFileSync(path.join(__dirname, '..', 'worker', 'tvworker.js'), 'utf8');
  // The invariant worth holding is not how `fresh` is declared, it is WHERE a real name comes from.
  ok('a real device name comes from the list diff and nowhere else',
    /deviceName: fresh\.join\(/.test(wsrc2) && /deviceLines\(before\.lines, after\.lines\)/.test(wsrc2));
  ok('the page text is never used as a device name',
    !/deviceName: said/.test(wsrc2) && !/deviceName: heard/.test(wsrc2));
  ok('when Amazon says it worked but we cannot see it, the name is marked unread',
    /unnamed: true/.test(wsrc2) && /name not read back/.test(wsrc2));
  // Not the wording - the behaviour. The device list is read TWICE inside registerCode: once normally,
  // and once more only when Amazon says it worked and we cannot see it yet.
  const clean2 = codeOnly(wsrc2);
  const reg = clean2.slice(clean2.indexOf('async function registerCode'), clean2.indexOf('async function doJob'));
  ok('the device list is read TWICE in registerCode - we look again before deciding',
    (reg.match(/await deviceList\(page\)/g) || []).length === 2, (reg.match(/await deviceList\(page\)/g) || []).length);
  ok('…and the second look is gated on Amazon having said it worked', /heard\.registered/.test(reg));

  section('the rehearsal runs the real registration, not a copy of it');
  // 🔒 The whole value of `dryrun` is that it exercises the REAL registration. A rehearsal with its own
  // copy of the steps proves only that the copy works, and this half of the worker had never executed
  // once before the rehearsal existed - so the one thing worth locking is that there is ONE path.
  const src0 = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'worker', 'tvworker.js'), 'utf8'));
  // Counting the string would count the comment that explains it too, so count the USE.
  ok('the code box is looked up in exactly one place - the steps are not duplicated',
    (src0.match(/locator\('#av-cbl-code/g) || []).length === 1,
    (src0.match(/locator\('#av-cbl-code/g) || []).length);
  ok('the Register button is found in exactly one place',
    (src0.match(/name: \/register\/i/g) || []).length === 1);
  ok('…and both the job and the rehearsal go through it',
    (src0.match(/await registerCode\(/g) || []).length >= 2, (src0.match(/await registerCode\(/g) || []).length);
  ok('registerCode is reachable from the suite', typeof worker.registerCode === 'function');
  // 🔒 A rehearsal must not touch the shop: no job claimed, nothing marked done or failed.
  const dry = src0.slice(src0.indexOf('async function dryrun'), src0.indexOf('async function check'));
  ok('the rehearsal exists', dry.length > 200);
  ok('the rehearsal never calls the shop', dry.indexOf('api(') < 0, dry.indexOf('api('));
  ok('…and never marks anything done or failed', !/prime-tv\/(done|fail|claim)/.test(dry));
  // The sentence that used to be posted here went straight to the customer's screen.
  ok('the Register-button failure is a code, not a sentence',
    src0.indexOf('the Register button was not where we expected it') < 0);

  section('🔒 the worker must be on the account it thinks it is on');
  // 4 Oct 2026, a real incident: a swapped id in accounts.json left profiles/PRI-31 signed into PRI-27's
  // Amazon account. A job on that profile would have registered a customer's TV on an account they never
  // bought, and nothing in the system would have noticed. The shop now sends a fingerprint of the login it
  // has on file and the worker checks its own against it.
  const primetv = require(path.join(__dirname, '..', 'primetv.js'));
  const H = primetv.loginHash;
  ok('the same login matches', sameLogin(H('someone@example.com'), 'someone@example.com') === 'ok');
  ok('case and spacing do not matter', sameLogin(H('Someone@Example.com'), '  someone@example.com ') === 'ok');
  ok('a DIFFERENT login is refused', sameLogin(H('someone@example.com'), 'other@example.com') === 'wrong');
  ok('…which is exactly the PRI-31 / PRI-27 mix-up', sameLogin(H('la@outlook.com'), 'wa@hotmail.com') === 'wrong');
  // A gap in the shop's records must not become a failed customer, so nothing to compare does NOT block.
  ok('nothing to compare against does not block the job', sameLogin('', 'someone@example.com') === 'unknown');
  ok('neither does a missing field', sameLogin(undefined, 'someone@example.com') === 'unknown');
  ok('…but a wrong login still blocks even if ours is blank', sameLogin(H('someone@example.com'), '') === 'wrong');
  // 🔒 The address itself never crosses the wire - only a fingerprint of it.
  ok('the fingerprint is not the address', H('someone@example.com').indexOf('@') < 0);
  ok('it is short and fixed-width', /^[0-9a-f]{16}$/.test(H('someone@example.com')), H('someone@example.com'));
  ok('different logins fingerprint differently', H('a@b.com') !== H('c@d.com'));
  const claimSrc = fs.readFileSync(path.join(__dirname, '..', 'primetv.js'), 'utf8');
  ok('the claim sends the fingerprint, never the login', /loginHash: hash/.test(claimSrc) && !/loginId: /.test(claimSrc));

  section('an invisible field is not a field');
  // 4 Oct 2026, from a real run: Amazon's sign-in page carries a HIDDEN password box for autofill hints,
  // <input type="password" class="hide" id="ap-credential-autofill-hint">, EARLIER in the document than
  // the real one. A comma-selector resolves in DOM order, so '#ap_password, input[type=password]' with
  // .first() picked the decoy: typing into it timed out, and COUNTING it reported a good password as
  // refused. Every selector that decides something must therefore be visible-scoped.
  ['password', 'anyPassword', 'email', 'otp', 'captcha'].forEach((k) => {
    ok('SEL.' + k + ' only matches what is actually on the screen', /:visible/.test(SEL[k]), SEL[k]);
  });
  ok('the real password box is asked for by its own id first', SEL.password.indexOf('#ap_password') === 0, SEL.password);
  ok('the autofill decoy is never named', JSON.stringify(SEL).indexOf('autofill-hint') < 0);

  section('a passkey prompt is declined, never guessed at');
  ['Not now', 'not now', 'Maybe later', 'Skip', 'Skip for now', 'No thanks'].forEach((w) => {
    ok('declines: ' + w, PASSKEY_DECLINE.test(w));
  });
  // 🔒 Accepting one, or cancelling the sign-in itself, must never be clicked by accident.
  ['Cancel', 'Continue', 'Sign in', 'Create a passkey', 'Set up', 'Use a passkey', 'Submit', 'Remove', 'Sign out'].forEach((w) => {
    ok('never clicks: ' + w, !PASSKEY_DECLINE.test(w));
  });
  ok('it is anchored, so "Skip the queue and continue" is not a decline', !PASSKEY_DECLINE.test('Skip the queue and continue'));

  section('WebAuthn is taken off the table before any page loads');
  // The Windows "Making sure it's you - scan your finger" box is an OPERATING SYSTEM dialog. Playwright
  // drives the page, not the desktop, so it cannot close it; the run just hangs behind it. A site cannot
  // offer what the browser does not advertise.
  const wsrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'tvworker.js'), 'utf8');
  ok('an init script runs before page scripts', /addInitScript/.test(wsrc));
  ok('PublicKeyCredential is removed', /delete window\.PublicKeyCredential/.test(wsrc));
  ok('navigator.credentials is removed', /navigator, 'credentials'/.test(wsrc));

  section('`fresh` puts a profile aside - it never deletes one');
  // 🔒 These folders ARE the signed-in sessions. Deleting one costs a sign-in on a live account, and a
  // sign-in is exactly the thing we are trying not to spend.
  ok('nothing to move is not an error', setAsideProfile('PRI-NOTHERE') === null);
  const live = profileFor('PRI-13');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'Cookies'), 'pretend-session');
  const bak = setAsideProfile('PRI-13');
  ok('the profile is gone from where it was', !fs.existsSync(live));
  ok('…because it was MOVED, not deleted', !!bak && fs.existsSync(bak), bak);
  ok('…and the session inside it is intact', fs.readFileSync(path.join(bak, 'Cookies'), 'utf8') === 'pretend-session');
  ok('the backup is named so it can be moved back', /\.bak-\d+$/.test(bak || ''), bak);

  section('the counter survives a restart');
  noteLogin('PRI-13');
  ok('it is written down, not just remembered', JSON.parse(fs.readFileSync(f, 'utf8')).counts['PRI-13'] === 1);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n---------------------------------------');
  console.log('tvworker-login: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
