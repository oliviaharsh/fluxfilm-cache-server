#!/usr/bin/env node
/**
 * 📺 FluxFilm TV worker — registers customers' TVs on Prime Video, unattended.
 *
 * It does NOT run on Hostinger. It runs wherever the owner keeps a machine on: a laptop to begin with, a
 * small always-on box or a VPS later. **Nothing here is tied to a particular machine** — every path and
 * address is configuration — so moving it is an .env change, not a rewrite.
 *
 *   node tvworker.js login PRI-13     open a real browser so the owner signs that account in, ONCE
 *   node tvworker.js run              the loop: claim a job, register the code, report back
 *   node tvworker.js check PRI-13     is that profile still signed in?
 *
 * HOW IT STAYS SAFE — these are not preferences, they are the rules this thing lives by:
 *
 *   1. It never signs in. A profile is seeded by a human once, and if the session dies the job is handed
 *      back with NEEDS_OWNER. Automatic re-login stays off until the whole path is proven; every extra
 *      automated authentication is another chance to trip a control on an account with four paying
 *      customers behind it.
 *   2. It never touches a CAPTCHA, a recovery page or a suspicious-login prompt. It stops and says so.
 *   3. It never reports success it has not SEEN. "No error" is not success — the device has to appear in
 *      the account's device list, and its name is read back and stored, because that name is the handle
 *      the removal will need later.
 *   4. One job at a time, one profile at a time, and a per-account circuit breaker. After repeated failures
 *      on an account it stops touching that account entirely rather than hammering it.
 *   5. The code, the cookies and the profile never reach a log.
 */
const fs = require('fs');
const path = require('path');

const CFG = {
  base: process.env.FF_BASE || 'https://shop.fluxfilm.in',
  key: process.env.FF_ADMIN_KEY || '',
  who: process.env.FF_WORKER_NAME || 'worker',
  profiles: process.env.FF_PROFILE_DIR || path.join(__dirname, 'profiles'),
  // India. The marketplace is decided by the exit IP unless we say otherwise, so we always say otherwise.
  registerUrl: process.env.FF_TV_REGISTER_URL || 'https://www.primevideo.com/region/in/ontv/devices',
  devicesUrl: process.env.FF_TV_DEVICES_URL || 'https://www.primevideo.com/settings/devices',
  pollMs: Number(process.env.FF_POLL_MS || 15000),
  headless: process.env.FF_HEADLESS !== 'off',
  maxFailsPerAccount: Number(process.env.FF_MAX_FAILS || 3),
  // 🔒 Signing in by itself is OFF unless this says on. See signIn() for why that default is not timidity.
  autoLogin: String(process.env.FF_AUTO_LOGIN || '').trim().toLowerCase() === 'on',
  // Where the logins live. THIS FILE NEVER LEAVES THIS MACHINE: the shop does not serve passwords and this
  // worker never asks it for one, so a stolen admin key cannot be turned into the inventory.
  accountsFile: process.env.FF_ACCOUNTS_FILE || path.join(__dirname, 'accounts.json'),
  // Sign-in attempts per account per day. More than this is not a bad minute, it is a problem, and
  // hammering Amazon with sign-ins is how an account with paying customers behind it gets locked.
  maxLoginsPerDay: Number(process.env.FF_MAX_LOGINS_DAY || 3),
};

// 🔒 Never let a login or a password reach a log line, an error message or a screenshot caption. Anything
// that passes through here is safe to print; anything that does not go through here must not be printed.
const SECRETS = [];
const redact = (text) => {
  let out = String(text == null ? '' : text);
  SECRETS.forEach((v) => { if (v && v.length > 3) out = out.split(v).join('***'); });
  return out;
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Only for what this worker prints on screen. The customer's wording lives in primetv.js, deliberately in
// one place, so the two can never drift into saying different things.
const WORKER_SAYS = {
  'worker:signedout': 'signed out of this account - run `login` again',
  'worker:security': 'Amazon put a security check in the way',
  'worker:unreadable': 'the device list did not load',
  'worker:noform': 'the registration box was not where we expected it',
  'worker:stuck': 'this account keeps failing - leaving it alone',
  'worker:crashed': 'the worker could not finish it',
  'worker:notregistered': 'no new device appeared - the code had probably expired',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function playwright() {
  try { return require('playwright'); } catch (e) {
    console.error('\nPlaywright is not installed. From this folder:\n\n  npm install\n  npx playwright install chromium\n');
    process.exit(1);
  }
}

async function api(route, body) {
  if (!CFG.key) { console.error('FF_ADMIN_KEY is not set. Copy .env.example to .env and fill it in.'); process.exit(1); }
  const res = await fetch(CFG.base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': CFG.key },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, message: 'server said: ' + text.slice(0, 120) }; }
}

const profileFor = (accountId) => path.join(CFG.profiles, String(accountId).replace(/[^A-Za-z0-9_-]/g, '_'));

/**
 * The logins, read from a local file the owner fills in by hand. Shape:
 *   { "PRI-13": { "login": "someone@example.com", "password": "…" } }
 *
 * 🔒 Deliberately NOT fetched from the shop. An endpoint that serves account passwords to whoever holds the
 * admin key is a far bigger thing than the problem it solves, and the owner's own rule is that secrets stay
 * on the server. So they stay here instead, on one machine, in a file git ignores.
 */
function credentialsFor(accountId) {
  let raw = null;
  try { raw = fs.readFileSync(CFG.accountsFile, 'utf8'); } catch (e) { return null; }
  let all = null;
  try { all = JSON.parse(raw); } catch (e) { throw new Error('accounts.json is not valid JSON - fix the file'); }
  const row = all && all[accountId];
  if (!row || !row.login || !row.password) return null;
  if (SECRETS.indexOf(row.password) < 0) SECRETS.push(row.password);
  if (SECRETS.indexOf(row.login) < 0) SECRETS.push(row.login);
  return { login: String(row.login), password: String(row.password) };
}

/** Sign-ins today, per account, kept beside the profiles so a restart does not forget them. */
const countsFile = () => path.join(CFG.profiles, 'logins.json');
function loginsToday(accountId) {
  const day = new Date().toISOString().slice(0, 10);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(countsFile(), 'utf8')); } catch (e) { all = {}; }
  if (all.day !== day) all = { day: day, counts: {} };
  return { all: all, n: Number((all.counts || {})[accountId] || 0) };
}
function noteLogin(accountId) {
  const { all } = loginsToday(accountId);
  all.counts = all.counts || {};
  all.counts[accountId] = Number(all.counts[accountId] || 0) + 1;
  try { fs.mkdirSync(CFG.profiles, { recursive: true }); fs.writeFileSync(countsFile(), JSON.stringify(all)); } catch (e) {
    log('could not record the sign-in count:', e.message);
  }
}

async function openProfile(accountId, headless) {
  const dir = profileFor(accountId);
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = playwright();
  return chromium.launchPersistentContext(dir, {
    headless: headless === undefined ? CFG.headless : headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/**
 * What is this page? Decided from real ELEMENTS and visible text, never by grepping the raw HTML for a word
 * — every ordinary page carries words like "signin" in a script somewhere, and that mistake once made the
 * Netflix household tool fail 33 times out of 33 (CLAUDE.md).
 */
async function pageKind(page) {
  if (await page.locator('input[type="password"], input[name="password"]').count()) return 'signin';
  if (await page.locator('#ap_email, input[name="email"]').count()) return 'signin';
  if (await page.locator('.g-recaptcha, iframe[src*="recaptcha"], img[src*="captcha"], #auth-captcha-image').count()) return 'captcha';
  if (/account.{0,12}(locked|hold)|verify your identity|suspicious/i.test(await page.title())) return 'challenge';
  return 'ok';
}

/**
 * The furniture that is on every Prime Video page. Taken from what the real page prints, not guessed.
 * The footer arrives as one run-together line, so it is matched by shape below rather than listed here.
 */
const CHROME = ['home', 'movies', 'tv shows', 'sports', 'devices', 'register new device', 'register a device',
  'search', 'help', 'send us feedback', 'cookies notice', 'registration code:', 'register device',
  // Every device row carries these three controls and a Prime badge, so each registration adds one more of
  // each. Without them here they land in the stored device name: "…Registration date: … · Sign out".
  'sign out', 'signed out', 'remove', 'prime'];

/**
 * The lines a person would actually read on the devices page, with the furniture taken out.
 *
 * 🔒 Deliberately TEXT, not markup. The first version of this filtered rows by the words "registration
 * date" — which that page never says — so it returned an empty list for every account, and an empty list
 * is indistinguishable from an empty account. A selector that quietly matches nothing is the same bug that
 * made the Netflix household tool fail 33 times out of 33 (CLAUDE.md). Markup is Amazon's to change;
 * whatever a device is called, its name is a line of text that was not on the page before.
 */
function contentLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && l.length < 200)
    .filter((l) => CHROME.indexOf(l.toLowerCase()) < 0)
    .filter((l) => !/©|^terms and privacy notice/i.test(l));
}

/**
 * Prose that appears on the devices page but is plainly not the name of anybody's television.
 *
 * 🔒 This exists because a device going AWAY also changes the page: the empty-state sentence turns up as a
 * brand-new line, and without this the worker would hand that sentence back as the device it had just
 * registered — a success it never saw, which rule 3 at the top of this file forbids. The owner sees the
 * device name in admin, so a nonsense name is also caught by eye; this is the belt, that is the braces.
 */
const NOT_A_DEVICE = /don.?t have any registered devices|no registered devices|^watch your favou?rite|premium add-on subscriptions|^these are the devices registered|reached the device limit/i;

/** What is on the page now that was not before. A multiset, so two TVs with the same name both count. */
function newLines(before, after) {
  const was = Object.create(null);
  (before || []).forEach((l) => { was[l] = (was[l] || 0) + 1; });
  const fresh = [];
  (after || []).forEach((l) => { if (was[l] > 0) was[l] -= 1; else fresh.push(l); });
  return fresh;
}

/** The lines that are new AND could actually be a device. This is what decides whether a job worked. */
const deviceLines = (before, after) => newLines(before, after).filter((l) => !NOT_A_DEVICE.test(l));

/** The device list as readable lines. */
async function deviceList(page) {
  await page.goto(CFG.devicesUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const kind = await pageKind(page);
  if (kind !== 'ok') return { ok: false, kind };
  const text = await page.evaluate(() => document.body.innerText || '');
  const lines = contentLines(text);
  // 🔒 A page we could not read is NOT an empty account. Reporting "no devices" when we simply did not see
  // is how a silent zero becomes a wrong answer, and here it would become a wrongly-failed customer.
  if (!lines.length) return { ok: false, kind: 'unreadable' };
  return { ok: true, lines, empty: /don.?t have any registered devices|no registered devices/i.test(text) };
}

/** Why we had to stop, in words the owner can act on. */
// A CODE, not a sentence: the shop turns it into one line for the owner and a different one for the
// customer, because `why` is handed straight to the customer's screen. See WORKER_WHY in primetv.js.
const whyKind = (kind) => kind === 'signin' ? 'worker:signedout'
  : kind === 'unreadable' ? 'worker:unreadable'
  : 'worker:security';

/**
 * 📺 Sign one account back in.
 *
 * 🔒 This is the most dangerous thing in the program, so read the rules before changing it:
 *   1. It is OFF unless FF_AUTO_LOGIN=on. Every automated sign-in is another chance to trip a control on an
 *      account with paying customers behind it.
 *   2. It gives up the moment Amazon wants anything it cannot honestly supply - a one-time code, a CAPTCHA,
 *      a verification page. It does not retry, does not look for another way round, and says which it was.
 *      37 of 39 Prime logins are Outlook or Hotmail and we cannot read those mailboxes, so a one-time code
 *      is a dead end, not a puzzle.
 *   3. Every element is checked before it is used. If Amazon has changed the page, that is a clear refusal,
 *      not a guess at what the fields might be now.
 *   4. Nothing it touches is ever logged. See redact().
 *
 * Returns 'ok' | 'otp' | 'captcha' | 'badpassword' | 'noform'.
 */
async function signIn(page, creds) {
  await page.goto(CFG.devicesUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Step one: the email. Amazon splits this across two pages.
  const email = page.locator('#ap_email, input[name="email"]').first();
  if (!(await email.count())) return 'noform';
  await email.fill(creds.login);
  const go = page.locator('#continue, input[type="submit"]').first();
  if (await go.count()) { await go.click(); } else { await email.press('Enter'); }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  if (await isCaptcha(page)) return 'captcha';

  // Step two: the password.
  const pass = page.locator('#ap_password, input[type="password"]').first();
  if (!(await pass.count())) return (await isOtp(page)) ? 'otp' : 'noform';
  // Ask to be remembered. A session that lasts is the whole point of signing in at all, and if this box is
  // not ticked we are back here tomorrow - which is itself a way to get an account noticed.
  const keep = page.locator('#rememberMe, input[name="rememberMe"]').first();
  if (await keep.count()) { await keep.check().catch(() => {}); }
  await pass.fill(creds.password);
  const submit = page.locator('#signInSubmit, input[type="submit"]').first();
  if (!(await submit.count())) return 'noform';
  await submit.click();
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // What did we land on? Elements and visible text, never a grep of the raw HTML.
  if (await isCaptcha(page)) return 'captcha';
  if (await isOtp(page)) return 'otp';
  if (await page.locator('#ap_password, input[type="password"]').count()) return 'badpassword';
  const check = await deviceList(page);
  return check.ok ? 'ok' : (check.kind === 'signin' ? 'badpassword' : 'captcha');
}

const isCaptcha = async (page) =>
  (await page.locator('.g-recaptcha, iframe[src*="recaptcha"], #auth-captcha-image, img[src*="captcha"]').count()) > 0;

// A one-time code page. Amazon has several; all of them carry a short numeric field that is not a password.
const isOtp = async (page) =>
  (await page.locator('#auth-mfa-otpcode, input[name="otpCode"], input[name="code"], #cvf-input-code').count()) > 0;

/**
 * Make sure we are signed in before a job, signing in only if we are allowed to and it is worth trying.
 * Returns null when all is well, or the reason to hand back.
 */
async function ensureSignedIn(page, accountId) {
  const before = await deviceList(page);
  if (before.ok) return { ok: true, list: before };
  if (before.kind !== 'signin') return { ok: false, why: whyKind(before.kind) };
  if (!CFG.autoLogin) return { ok: false, why: 'worker:signedout' };

  let creds = null;
  try { creds = credentialsFor(accountId); } catch (e) { log('   ' + e.message); return { ok: false, why: 'worker:signedout' }; }
  if (!creds) return { ok: false, why: 'worker:signedout' };     // nothing saved for this one: owner's job

  const { n } = loginsToday(accountId);
  if (n >= CFG.maxLoginsPerDay) {
    log('   ⛔ ' + accountId + ' has been signed in ' + n + ' times today - not trying again');
    return { ok: false, why: 'worker:signedout' };
  }
  noteLogin(accountId);                                           // count the ATTEMPT, not the success
  log('   🔑 signing ' + accountId + ' back in (' + (n + 1) + ' today)');
  let how = 'noform';
  try { how = await signIn(page, creds); } catch (e) { log('   sign-in failed: ' + redact(e.message)); how = 'noform'; }
  if (how !== 'ok') {
    log('   ❌ could not sign in: ' + how);
    return { ok: false, why: how === 'otp' ? 'worker:needsotp' : how === 'captcha' ? 'worker:security' : how === 'badpassword' ? 'worker:badpassword' : 'worker:noform' };
  }
  const after = await deviceList(page);
  if (!after.ok) return { ok: false, why: whyKind(after.kind) };
  log('   ✅ signed back in');
  return { ok: true, list: after };
}

async function doJob(ctx, job) {
  const page = await ctx.newPage();
  try {
    const ready = await ensureSignedIn(page, job.accountId);
    if (!ready.ok) return { ok: false, why: ready.why, needsOwner: true };
    const before = ready.list;

    await page.goto(CFG.registerUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const kind = await pageKind(page);
    if (kind !== 'ok') return { ok: false, why: whyKind(kind), needsOwner: true };

    // The real box is #av-cbl-code / name="code"; the loose selector is only a fallback, and it comes
    // second because the page also carries a hidden Search field that could open and match first.
    let box = page.locator('#av-cbl-code, input[name="code"]:visible').first();
    if (!(await box.count())) box = page.locator('input[type="text"]:visible').first();
    if (!(await box.count())) return { ok: false, why: 'worker:noform', needsOwner: true };
    // 🔒 That box carries maxlength=6. A longer code would be silently CLIPPED by the browser and we would
    // register something the customer never typed, so refuse and say why instead.
    const max = await box.evaluate((el) => (el.maxLength > 0 ? el.maxLength : 0)).catch(() => 0);
    if (max && job.code.length > max) {
      return { ok: false, why: 'That code is ' + job.code.length + ' characters long - the box on Prime Video takes ' + max + '. Check the code on your TV and send it again.' };
    }
    await box.fill(job.code);
    const btn = page.getByRole('button', { name: /register/i }).first();
    if (!(await btn.count())) return { ok: false, why: 'the Register button was not where we expected it', needsOwner: true };
    await btn.click();
    await page.waitForTimeout(4000);

    // 🔒 The only thing that counts as success: a device that was not there before, is there now.
    const after = await deviceList(page);
    if (!after.ok) return { ok: false, why: 'worker:unreadable', needsOwner: true };
    // If the account itself still says it has nothing registered, nothing was registered. No diff needed.
    if (after.empty) return { ok: false, why: 'worker:notregistered' };
    const fresh = deviceLines(before.lines, after.lines);
    if (!fresh.length) return { ok: false, why: 'worker:notregistered' };
    // Everything new, joined: usually the device's name and the date it was registered, which is exactly
    // the handle we will need in order to take it off again when the plan ends.
    return { ok: true, deviceName: fresh.join(' · ').slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function run() {
  const fails = new Map();
  log('worker "' + CFG.who + '" watching ' + CFG.base + ' every ' + Math.round(CFG.pollMs / 1000) + 's');
  log('profiles in ' + CFG.profiles);
  log(CFG.autoLogin
    ? 'automatic sign-in is ON - it will stop at a one-time code or a CAPTCHA, never push past one'
    : 'automatic sign-in is off - a signed-out account comes back to you');
  for (;;) {
    let job = null;
    try {
      const r = await api('/admin/api/prime-tv/claim', { who: CFG.who });
      if (r && r.ready === false) { log('the shop has no tv_activations table yet — run db/schema-v35.sql and v36'); await sleep(60000); continue; }
      job = r && r.job;
    } catch (e) { log('could not reach the shop:', e.message); }
    if (!job) { await sleep(CFG.pollMs); continue; }

    const n = fails.get(job.accountId) || 0;
    if (n >= CFG.maxFailsPerAccount) {
      log('⛔ circuit open on ' + job.accountId + ' — not touching it again until this worker restarts');
      await api('/admin/api/prime-tv/fail', { id: job.id, why: 'worker:stuck' });
      continue;
    }

    // 🔒 The code is deliberately absent from this line.
    log('job #' + job.id + ' · ' + job.accountId + ' · ' + job.subId);
    let ctx = null;
    try {
      ctx = await openProfile(job.accountId);
      const out = await doJob(ctx, job);
      if (out.ok) {
        fails.delete(job.accountId);
        await api('/admin/api/prime-tv/done', { id: job.id, deviceName: out.deviceName });
        log('   ✅ registered: ' + out.deviceName);
      } else {
        fails.set(job.accountId, n + 1);
        await api('/admin/api/prime-tv/fail', { id: job.id, why: out.why });
        log('   ❌ ' + (WORKER_SAYS[out.why] || out.why) + (out.needsOwner ? '  ← needs the owner' : ''));
      }
    } catch (e) {
      fails.set(job.accountId, n + 1);
      await api('/admin/api/prime-tv/fail', { id: job.id, why: 'worker:crashed' });
      log('   ❌ ' + e.message);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }
}

async function login(accountId) {
  if (!accountId) { console.error('Which account? e.g. node tvworker.js login PRI-13'); process.exit(1); }
  const ctx = await openProfile(accountId, false);
  const page = await ctx.newPage();
  await page.goto(CFG.devicesUrl, { waitUntil: 'domcontentloaded' });
  console.log('\n  A browser has opened for ' + accountId + '.');
  console.log('  Sign in by hand, get to the Devices page, then close the browser window.');
  console.log('  The session is kept in ' + profileFor(accountId) + ' and should last months.\n');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await ctx.close().catch(() => {});
}

async function check(accountId) {
  const ctx = await openProfile(accountId, true);
  const page = await ctx.newPage();
  const list = await deviceList(page);
  if (!list.ok) console.log('❌ ' + accountId + ': ' + (list.kind === 'signin' ? 'signed out — run `login` again' : whyKind(list.kind)));
  else if (list.empty) console.log('✅ ' + accountId + ': signed in — the account says it has no registered devices');
  else {
    console.log('✅ ' + accountId + ': signed in, this is what the devices page says:');
    list.lines.forEach((r) => console.log('   · ' + r));
  }
  await ctx.close().catch(() => {});
}

// The reading rules are exported so the suite can hold them to a real page with no browser anywhere near
// it. Playwright is only ever loaded inside playwright(), so requiring this file costs nothing.
module.exports = { contentLines, newLines, deviceLines, CHROME, NOT_A_DEVICE, credentialsFor, loginsToday, noteLogin, redact, CFG };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'run') run();
  else if (cmd === 'login') login(arg);
  else if (cmd === 'check') check(arg);
  else {
    console.log('\n📺 FluxFilm TV worker\n');
    console.log('  node tvworker.js login PRI-13    sign an account in, once, by hand');
    console.log('  node tvworker.js check PRI-13    is that profile still signed in?');
    console.log('  node tvworker.js run             the loop\n');
  }
}
