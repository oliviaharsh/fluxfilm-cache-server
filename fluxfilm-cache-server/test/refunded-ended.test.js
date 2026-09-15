/* A refunded / cancelled plan shows as ended (History, "Refunded", no renew) even when its expiry date is ahead;
 * the admin card says Refunded (no "Nd left", no Extend); the new-order bell is a louder ~3 s ka-ching.
 * node test/refunded-ended.test.js */
process.env.TZ = 'Asia/Kolkata';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

const day = 86400e3;
const dt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const PH = '9000000001';
const subs = [
  { sub_id: 'SUB-LIVE', order_id: 'FF1', service: 'Prime Video', plan: '1 Year', status: 'ACTIVE', fulfillment_status: 'FULFILLED', start_date: dt(Date.now() - 30 * day), expiry_date: dt(Date.now() + 200 * day) },
  { sub_id: 'SUB-REF', order_id: 'FF2', service: 'YouTube Premium', plan: '1 Month', status: 'REFUNDED', fulfillment_status: 'REFUNDED', profile_number: 'MIG_YT', start_date: dt(Date.now() - 10 * day), expiry_date: dt(Date.now() + 50 * day) },
  { sub_id: 'SUB-CAN', order_id: 'FF3', service: 'Netflix', plan: 'Sharing 1M', status: 'CANCELLED', fulfillment_status: null, start_date: dt(Date.now() - 5 * day), expiry_date: dt(Date.now() + 25 * day) },
  { sub_id: 'SUB-FAIL', order_id: 'FF4', service: 'Zee5', plan: '1 Month', status: 'ACTIVE', fulfillment_status: 'FAILED', start_date: dt(Date.now()), expiry_date: dt(Date.now() + 30 * day) },
];
const mockDb = {
  ENABLED: true,
  query: async (sql) => {
    if (/information_schema/.test(sql)) return [{ n: 0 }];
    if (/FROM plans/.test(sql)) return [];
    if (/FROM subscriptions WHERE phone_norm = \?/.test(sql)) return subs.map((x) => Object.assign({ phone_norm: PH }, x));
    throw new Error('unhandled SQL: ' + sql);
  },
};
const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return mockDb; return origLoad.apply(this, arguments); };

(async () => {
  const reads = require('../reads');
  const r = await reads.getMySubscriptions(PH);
  const act = r.actionable.map((x) => x.subId); const hist = r.history.map((x) => x.subId);
  const ref = r.history.find((x) => x.subId === 'SUB-REF') || {};
  const can = r.history.find((x) => x.subId === 'SUB-CAN') || {};
  ok('refunded + cancelled plans are NOT in actionable (not counted active)', !act.includes('SUB-REF') && !act.includes('SUB-CAN') && act.includes('SUB-LIVE'), { act, hist });
  ok('they are listed first in History', hist[0] === 'SUB-REF' || hist[0] === 'SUB-CAN', hist);
  ok('refunded: marked, no renew, "Refunded", no early discount, no profile shown', ref.refunded === true && ref.showRenewButton === false && ref.renewEligibility === 'REFUNDED' && ref.moodText === 'Refunded' && ref.earlyRenewDiscountEligible === 0 && ref.profileNumber === '', ref);
  ok('cancelled: "Cancelled"', can.refunded === true && can.endedReason === 'CANCELLED' && can.moodText === 'Cancelled' && can.showRenewButton === false, can);
  const failRow = r.actionable.find((x) => x.subId === 'SUB-FAIL') || {};
  ok('undelivered FAILED row is not "stopped" (stays actionable, renew still hidden as before)', !failRow.refunded && failRow.showRenewButton === false, failRow);
  ok('stoppedRow helper', reads._internal.stoppedRow({ status: 'ACTIVE', fulfillment_status: 'REFUNDED' }) === 'REFUNDED' && reads._internal.stoppedRow({ status: 'CANCELED' }) === 'CANCELLED' && reads._internal.stoppedRow({ status: 'ACTIVE', fulfillment_status: 'FULFILLED' }) === '');

  const store = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('My plans card: refunded → "↩️ Refunded" badge, no Renew / Reactivate buttons, explains it ended', /const stopped = !!sub\.refunded;/.test(store) && /stopped \? '↩️ ' \+ \(sub\.endedReason === 'CANCELLED' \? 'Cancelled' : 'Refunded'\)/.test(store) && /This plan was refunded, so it has ended and can’t be renewed/.test(store));
  ok('My plans filter + greeting ignore refunded plans', /const isLiveSub = s => !s\.refunded &&/.test(store) && /subs: allSubs\.filter\(s => !s\.refunded\)/.test(store));

  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  ok('admin card: refunded → Refunded pill (no "Nd left"), no Extend / Remind / Offer refund', /var stopped = \/REFUNDED\|CANCEL\/i\.test\(s\.status \|\| ''\)/.test(admin) && /var pill = stopped \?/.test(admin) && /\(stopped \? '' : /.test(admin));
  ok('bell: louder master + compressor, ~3 s ka-ching (two ka-chings, sparkle, ringing chord)', /out\.gain\.value = 0\.9/.test(admin) && /createDynamicsCompressor/.test(admin) && /tone\(t \+ 1\.7, f, 1\.5, 0\.22\)/.test(admin) && (admin.match(/^\s+drawer\(t/gm) || []).length === 2);

  for (const file of ['index.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    let bad = 0; let n = 0;
    for (const m of html.matchAll(/<script(?![^>]*src=)(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)) { n++; try { new Function(m[1]); } catch (e) { bad++; console.log(file, e.message); } }
    ok(file + ': every inline script parses (' + n + ')', bad === 0);
  }
  Module._load = origLoad;
  console.log('refunded-ended: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
