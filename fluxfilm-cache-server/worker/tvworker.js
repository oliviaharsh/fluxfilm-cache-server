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
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
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

/** The device list, as names and dates. Used to tell what is new after a registration. */
async function deviceList(page) {
  await page.goto(CFG.devicesUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const kind = await pageKind(page);
  if (kind !== 'ok') return { ok: false, kind };
  const names = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length) return;
      const t = (el.textContent || '').trim();
      if (t && t.length < 120 && /registration date/i.test(el.parentElement ? el.parentElement.textContent || '' : '')) out.push(t);
    });
    return out;
  });
  // Belt and braces: the shape of this page is Amazon's to change, so also take every row's whole text.
  const rows = await page.locator('li, .pv-device, [data-automation-id*="device"]').allTextContents().catch(() => []);
  return { ok: true, names, rows: rows.filter((r) => /registration date/i.test(r)).map((r) => r.replace(/\s+/g, ' ').trim()) };
}

async function doJob(ctx, job) {
  const page = await ctx.newPage();
  try {
    const before = await deviceList(page);
    if (!before.ok) return { ok: false, why: before.kind === 'signin' ? 'the browser is signed out of this account' : 'the page asked for a security check', needsOwner: true };

    await page.goto(CFG.registerUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const kind = await pageKind(page);
    if (kind !== 'ok') return { ok: false, why: kind === 'signin' ? 'the browser is signed out of this account' : 'the page asked for a security check', needsOwner: true };

    const box = page.locator('input[type="text"]:visible, input[name*="code" i]:visible').first();
    if (!(await box.count())) return { ok: false, why: 'the registration box was not where we expected it' , needsOwner: true };
    await box.fill(job.code);
    const btn = page.getByRole('button', { name: /register/i }).first();
    if (!(await btn.count())) return { ok: false, why: 'the Register button was not where we expected it', needsOwner: true };
    await btn.click();
    await page.waitForTimeout(4000);

    // 🔒 The only thing that counts as success: a device that was not there before, is there now.
    const after = await deviceList(page);
    if (!after.ok) return { ok: false, why: 'could not read the device list back', needsOwner: true };
    const fresh = after.rows.filter((r) => before.rows.indexOf(r) < 0);
    if (!fresh.length) return { ok: false, why: 'the code did not register — it may have expired' };
    return { ok: true, deviceName: fresh[0].slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function run() {
  const fails = new Map();
  log('worker "' + CFG.who + '" watching ' + CFG.base + ' every ' + Math.round(CFG.pollMs / 1000) + 's');
  log('profiles in ' + CFG.profiles);
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
      await api('/admin/api/prime-tv/fail', { id: job.id, why: 'this account needs the owner to look at it' });
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
        log('   ❌ ' + out.why + (out.needsOwner ? '  ← needs the owner' : ''));
      }
    } catch (e) {
      fails.set(job.accountId, n + 1);
      await api('/admin/api/prime-tv/fail', { id: job.id, why: 'the worker could not finish it' });
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
  if (!list.ok) console.log('❌ ' + accountId + ': ' + (list.kind === 'signin' ? 'signed out — run `login` again' : 'a security check is in the way'));
  else {
    console.log('✅ ' + accountId + ': signed in, ' + list.rows.length + ' device(s)');
    list.rows.forEach((r) => console.log('   · ' + r));
  }
  await ctx.close().catch(() => {});
}

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
