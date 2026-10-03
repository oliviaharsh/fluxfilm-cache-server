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
const { credentialsFor, loginsToday, noteLogin, redact, setAsideProfile, profileFor, CFG } = worker;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

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
