/* 📵 OTP monthly limits in the panel + 🕘 a change-log line per Get OTP request (owner, 24 Sep 2026:
   "from where can i edit quoto of otps - also add option ... quoto was specific to subscriptions type zee or jio"
   and "add logs for get otp also - who requested when and was given just like netflix").
   Real otp.js + customerlog.js against a fake MySQL. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

let SETTINGS = {};
let LOG = [];
let USED = 0;
const CUSTOMERS = [{ phone_norm: '9000000001', name: 'Keerthan Reddy', email: 'k@example.com' }];

const fakeDb = {
  ENABLED: true,
  query: async (sql, p) => {
    const q = String(sql).replace(/\s+/g, ' ').trim(); p = p || [];
    if (/SELECT value FROM app_settings/.test(q)) return SETTINGS[p[0]] === undefined ? [] : [{ value: SETTINGS[p[0]] }];
    if (/^INSERT INTO app_settings/.test(q)) { SETTINGS[p[0]] = p[1]; return { affectedRows: 1 }; }
    if (/COUNT\(\*\) n FROM sms_otp_log/.test(q)) return [{ n: USED }];
    if (/^INSERT INTO audit_log/.test(q)) { LOG.push({ action: p[0], entity: p[1], id: p[2], summary: p[3], details: p[4], ip: p[5] }); return { affectedRows: 1 }; }
    if (/SELECT name FROM customers WHERE phone_norm/.test(q)) { const c = CUSTOMERS.find((x) => x.phone_norm === p[0]); return c ? [{ name: c.name }] : []; }
    throw new Error('fake db: unhandled SQL: ' + q.slice(0, 110));
  },
};
const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return fakeDb; return origLoad.apply(this, arguments); };
const otp = require('../otp');
const customerlog = require('../customerlog');
Module._load = origLoad;

const reset = () => { SETTINGS = {}; LOG = []; USED = 0; delete process.env.OTP_QUOTA_JIOHOTSTAR; delete process.env.OTP_QUOTA_DEFAULT; };
const save = (o) => otp.saveSettings(Object.assign({ windowMin: 10 }, o));

(async () => {
  // ── the monthly limit, per service ──────────────────────────────────────────────────────────────────────────
  section('📵 the monthly OTP limit is per service, and editable');
  reset();
  let q = await otp.getOtpQuota('9000000001', 'JioHotstar');
  ok('with nothing set it is still 60, exactly as before', q.limit === 60 && q.source === 'default', q);

  process.env.OTP_QUOTA_JIOHOTSTAR = '25';
  q = await otp.getOtpQuota('9000000001', 'JioHotstar');
  ok('the Hostinger env var still works', q.limit === 25 && q.source === 'env', q);

  let r = await save({ quotas: { JIOHOTSTAR: 12, ZEE5: 40 } });
  ok('the panel saves a limit per service', r.ok && r.settings.quotas.JIOHOTSTAR === 12 && r.settings.quotas.ZEE5 === 40, r.settings);
  q = await otp.getOtpQuota('9000000001', 'JioHotstar');
  ok('...and the panel beats the env var', q.limit === 12 && q.source === 'panel', q);
  q = await otp.getOtpQuota('9000000001', 'Zee5');
  ok('...each service has its own', q.limit === 40, q);
  q = await otp.getOtpQuota('9000000001', 'SonyLiv');
  ok('...and one nobody has touched is untouched', q.limit === 60 && q.source === 'default', q);

  USED = 5;
  q = await otp.getOtpQuota('9000000001', 'JioHotstar');
  ok('what is left counts this month\'s use', q.used === 5 && q.remaining === 7, q);
  USED = 0;

  await save({ quotas: { JIOHOTSTAR: '' } });
  q = await otp.getOtpQuota('9000000001', 'JioHotstar');
  ok('clearing the box hands it back to the env var', q.limit === 25 && q.source === 'env', q);
  delete process.env.OTP_QUOTA_JIOHOTSTAR;

  ok('0 is a real answer — it means nobody gets one', (await save({ quotas: { ZEE5: 0 } })).settings.quotas.ZEE5 === 0
    && (await otp.getOtpQuota('9000000001', 'Zee5')).remaining === 0);
  ok('rubbish is refused rather than silently stored', (await save({ quotas: { ZEE5: 'lots' } })).ok === false);
  ok('...and so is a silly number', (await save({ quotas: { ZEE5: 99999 } })).ok === false);
  ok('the time window still saves, and does not lose the limits', (await save({ windowMin: 14, quotas: { ZEE5: 7 } })).settings.windowMin === 14
    && (await otp.getSettings(true)).quotas.ZEE5 === 7);
  ok('a service typed with spaces is stored the same way as the env name', otp._internal.quotaKey('Jio Hotstar') === 'JIOHOTSTAR');

  // ── the change log ──────────────────────────────────────────────────────────────────────────────────────────
  section('🕘 every Get OTP request is written down');
  reset();
  const outcomes = otp._internal.OTP_OUTCOME;
  ok('there is a line for every way it can end', ['given', 'none', 'noplan', 'quota', 'locked'].every((k) => !!outcomes[k]), Object.keys(outcomes));

  LOG = [];
  otp._internal.noteOtp(null, { ip: '203.0.113.7' }, '9000000001', 'JioHotstar', 'given', { left: 11, limit: 12 });
  await new Promise((r2) => setTimeout(r2, 20));
  const line = LOG[0] || {};
  ok('the line names the customer and the number', /^Keerthan Reddy · 9000000001 · JioHotstar/.test(line.summary), line.summary);
  ok('...says a code was given', /code given/.test(line.summary), line.summary);
  ok('...is filed against the customer, with where it came from', line.entity === 'customer' && line.id === '9000000001' && line.ip === '203.0.113.7', line);
  ok('...and says how many are left this month', /"left":11/.test(line.details) && /"limit":12/.test(line.details), line.details);

  LOG = [];
  otp._internal.noteOtp(null, null, '9000000001', 'Zee5', 'quota', { used: 40, limit: 40 });
  await new Promise((r2) => setTimeout(r2, 20));
  ok('a refusal is written down too, with the reason', /limit used up/.test((LOG[0] || {}).summary), (LOG[0] || {}).summary);

  section('🔐 the code itself is never written down');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'otp.js'), 'utf8');
    const calls = src.match(/noteOtp\(deps, req, ph,[^;]*\);/g) || [];   // the calls, not the declaration
    ok('every log call is in the file and none of them is handed the code', calls.length === 5
      && !calls.some((c) => /hit\.otp|\botp\b\s*:/.test(c)), calls.map((c) => c.slice(0, 60)));
    ok('the one place the code IS stored is the quota log, which is separate', /_logOtp\(svcKey, hit\.otp/.test(src));
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok('the shared logger is now customerlog.js, and both tools use it',
    fs.existsSync(path.join(__dirname, '..', 'customerlog.js'))
    && /require\('\.\/customerlog'\)/.test(read('householdhelp.js'))
    && /require\('\.\/customerlog'\)/.test(read('olivia.js'))
    && /require\('\.\/customerlog'\)/.test(read('otp.js')));
  ok('server.js hands the request through, so the log has an IP', /getLatestOtp: \(a, req\) =>/.test(read('server.js')) && /null, req\)/.test(read('server.js')));
  ok('the panel has a limit box per service and saves them', /data-odquota/.test(read('admin.html')) && /odQuotaCard/.test(read('admin.html')) && /quotas: quotas/.test(read('admin.html')));

  // 📵 The limits used to render inside the collapsed 🔎 Get OTP check fold, whose summary says nothing about
  // limits — so the owner could not find them at all (24 Sep 2026: "i cant see the option").
  ok('…on the MAIN screen, not hidden inside the 🔎 diagnostics fold',
    /<div id="odquota"><\/div>/.test(read('admin.html')) && /quotaEl.innerHTML = odQuotaCard\(\)/.test(read('admin.html')));
  ok('…each service shows what it falls back to when the box is left empty',
    /quotaDefaults/.test(read('admin.html')) && /quotaDefaults/.test(read('adminotpdevices.js')) && /function quotaDefaults/.test(read('otp.js')));
  ok('…and the list route sends the limits down with the list, so the card needs no second call',
    /settings, quotaDefaults: OTP\(\)\.quotaDefaults/.test(read('adminotpdevices.js')));

  // 🐛 $ is querySelector (ONE element); $$ is querySelectorAll as an array. Eight save handlers called
  // $(...).forEach, which throws every time — so those buttons silently did nothing, including 💾 Save on
  // ✉️ Email jobs and 💾 Save limits here. A whole class of bug, so it gets a guard rather than eight fixes.
  ok('🖱 no save handler calls .forEach on a single element', (() => {
    const bad = read('admin.html').split('\n')
      .map((l, i) => ({ n: i + 1, l }))
      .filter((x) => /(^|[^$\w.])\$\([^)]*\)\.forEach/.test(x.l));
    if (bad.length) console.log('    ' + bad.map((x) => x.n + ': ' + x.l.trim().slice(0, 70)).join('\n    '));
    return bad.length === 0;
  })());
  // The ⏱️ window box still lives in the 🔎 fold, so with that fold closed the card has no element to read.
  // The card now sends the stored window explicitly instead of resting on two behaviours lining up.
  ok('…and saving limits does not depend on the time-window box being on screen',
    /var winNow = \(\$\('#odwin'\) && \$\('#odwin'\)\.value\)/.test(read('admin.html'))
    && /post\('\/admin\/api\/otp-settings', \{ windowMin: winNow, quotas: quotas \}\)/.test(read('admin.html')));
  ok('…and the window survives a limits-only save either way, because the server merges over what is stored', (async () => {
    await otp.saveSettings({ windowMin: 14, quotas: {} });
    const r = await otp.saveSettings({ quotas: { ZEE5: 5 } });          // no windowMin at all, as JSON would send it
    return r.ok === true && r.settings.windowMin === 14 && r.settings.quotas.ZEE5 === 5;
  })());
  ok('…the quota boxes are found wherever they are drawn, not by the card they sit in',
    /\$\$\('\.odq'\)/.test(read('admin.html')) && !/#odchkbody \.odq/.test(read('admin.html')));
  ok('saving the time window no longer wipes the limits', /post\('\/admin\/api\/otp-settings', \{ windowMin: inp\.value, quotas: keep \}\)/.test(read('admin.html')));
  ok('the change log can read the new lines and filter to them', /'otp\.given': '🔑 OTP given \(customer\)'/.test(read('admin.html')) && /\['otp', '🔑 Get OTP'\]/.test(read('admin.html')));
  ok('the route saves the limits and says so in the change log', /quotas: b\.quotas/.test(read('adminotpdevices.js')) && /monthly limits: /.test(read('adminotpdevices.js')));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
