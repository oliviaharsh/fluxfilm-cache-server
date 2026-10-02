/**
 * FluxFilm — 📺 Activate my TV (owner, 2–3 Oct 2026).
 *
 * The customer reads the 6-character code off their TV and types it in here. We redeem it against the Prime
 * account THEY are already on, from a session we hold. They never sign in on a phone first, so one
 * registration is used instead of two, and they never hold a password they could change, share, or spend on
 * more devices than they bought.
 *
 * ⚠️ This is the QUEUE only. Something else redeems the code:
 *   today  — the owner, one tap in admin → 📺 TV activations.
 *   later  — a private Playwright worker with one persistent profile per account, polling the same queue.
 * The server never runs a browser. That is what lets the worker be replaced without touching the storefront,
 * and what stops a broken worker from affecting the shop.
 *
 * 🔒 The gate is Get OTP's, not a new one (otpaccess.js): logged in, this device confirmed by email, an
 * ACTIVE plan for this service that the email really belongs to, a quota, and a REASON on every refusal.
 * Reusing it matters — a second, slightly different gate is how a hole gets made.
 *
 * 🔒 The customer never names an account. It is derived from their own subscription row
 * (`subscriptions.inventory_ref`), which fulfilment wrote when they bought. Nothing they send chooses it.
 *
 * 🔒 The code is never logged, and is cleared from the row the moment it stops being PENDING. Amazon expires
 * it in about ten minutes anyway; a stale one in the database is a liability with no use.
 *
 * Fails soft everywhere: before db/schema-v35.sql has been run, every call answers { ok: true, ready: false }
 * and the storefront simply does not draw the tool.
 *
 * Storefront:  activateTv  [phone, token, code, subRef?]   ·  myTvActivation [phone, token]
 * Admin:       GET  /admin/api/prime-tv            the queue
 *              POST /admin/api/prime-tv/done       { id, deviceName }
 *              POST /admin/api/prime-tv/fail       { id, why }
 */
const db = require('./db');

// Amazon expires a registration code in roughly ten minutes. Fifteen gives the owner a little room and still
// guarantees we never hand the worker a code that cannot possibly work.
const STALE_MIN = 15;
// Per subscription per day. A TV slot is activated once and occasionally re-activated; anything more than
// this is somebody poking at it.
const PER_SUB_DAY = 6;
// The two reasons a row is expired, kept as constants because the quota has to tell them apart:
// one is the customer trying again, the other is us being slow, and only the first is their fault.
const WHY_STALE = 'the code expired before it was used';
const WHY_REPLACED = 'replaced by a newer code';
// A worker that dies mid-job leaves a CLAIMED row behind. Anything claimed and still unfinished after this
// goes back in the queue — a crashed worker should cost a minute, not a stuck customer at one in the morning.
const CLAIM_STUCK_MIN = 3;

const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();
const norm = (v) => s(v).replace(/\D/g, '').slice(-10);
/** Codes are short and alphanumeric; people type them with spaces and dashes they can see on the TV. */
const cleanCode = (v) => s(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE|Unknown column/i.test(String(e && e.message));

let readyCache = null;
/** Has schema-v35 been run? Cached, because the storefront asks on every screen draw. */
async function ready(fresh) {
  if (!fresh && readyCache !== null) return readyCache;
  try {
    await db.query('SELECT 1 FROM tv_activations LIMIT 1');
    readyCache = true;
  } catch (e) {
    if (!missingTable(e)) throw e;
    readyCache = false;
  }
  return readyCache;
}

const isPrime = (service) => /prime/i.test(s(service));
/** A TV slot: CAPACITY-policy Prime rows carry device_type TV or MIXED, or a tv_count above zero. */
const hasTv = (r) => ['TV', 'MIXED'].indexOf(up(r.device_type)) >= 0 || Number(r.tv_count || 0) > 0;

/**
 * The customer's own ACTIVE Prime rows, with the columns Get OTP's gate does not carry.
 * `subRowsFor` deliberately selects a narrow set, so rather than widen a shared security helper this reads
 * the extra columns for sub_ids the gate has ALREADY unlocked. The gate still decides who may ask.
 */
async function primeRowsFor(subIds) {
  if (!subIds.length) return [];
  const marks = subIds.map(() => '?').join(', ');
  const rows = await db.query(
    'SELECT sub_id, service, inventory_ref, device_type, device_count, tv_count FROM subscriptions WHERE sub_id IN (' + marks + ')',
    subIds);
  return (rows || []).filter((r) => isPrime(r.service));
}

/** Rows older than STALE_MIN that nobody got to: the code in them is dead, so say so and clear it. */
async function expireStale(now) {
  const cutoff = new Date((now || Date.now()) - STALE_MIN * 60e3);
  try {
    await db.query(
      "UPDATE tv_activations SET status = 'EXPIRED', code = '', why = ?, finished_at = ? WHERE status = 'PENDING' AND created_at < ?",
      [WHY_STALE, new Date(now || Date.now()), cutoff]);
  } catch (e) {
    if (!missingTable(e)) console.log('[primetv] could not expire stale codes:', e.message);
  }
}

/**
 * Put back anything a worker claimed and never finished. Called before every claim and before the admin
 * queue is drawn, so a dead worker heals itself without anybody noticing.
 */
async function reapClaims(now) {
  const at = now || Date.now();
  try {
    await db.query(
      "UPDATE tv_activations SET status = 'PENDING', claimed_at = NULL, claimed_by = NULL WHERE status = 'CLAIMED' AND claimed_at < ?",
      [new Date(at - CLAIM_STUCK_MIN * 60e3)]);
  } catch (e) {
    if (!missingTable(e)) console.log('[primetv] could not reap stale claims:', e.message);
  }
}

/**
 * Hand exactly one waiting job to a worker, atomically.
 *
 * 🔒 The UPDATE is the lock: the row is only ours if it was still PENDING at the moment we asked, so two
 * workers — or a worker and the owner tapping in admin — can never register the same code twice. Reading
 * first and writing second would be a race, and a race here means a customer's code burned twice.
 */
async function claim(who, deps) {
  const d = deps || {};
  const now = d.now || Date.now();
  if (!(await ready())) return { ok: true, ready: false };
  await expireStale(now);
  await reapClaims(now);
  const label = s(who).slice(0, 64) || 'worker';
  for (let tries = 0; tries < 5; tries++) {
    const next = await db.query("SELECT id FROM tv_activations WHERE status = 'PENDING' ORDER BY id ASC LIMIT 1");
    const id = next && next[0] && next[0].id;
    if (!id) return { ok: true, ready: true, job: null };
    const got = await db.query(
      "UPDATE tv_activations SET status = 'CLAIMED', claimed_at = ?, claimed_by = ? WHERE id = ? AND status = 'PENDING'",
      [new Date(now), label, id]);
    if (!got || !got.affectedRows) continue;            // somebody else got there first — try the next one
    const rows = await db.query('SELECT id, sub_id, account_id, service, code FROM tv_activations WHERE id = ? LIMIT 1', [id]);
    const r = rows && rows[0];
    if (!r) continue;
    return { ok: true, ready: true, job: { id: r.id, subId: s(r.sub_id), accountId: s(r.account_id), service: s(r.service), code: s(r.code) } };
  }
  return { ok: true, ready: true, job: null };
}

/**
 * 📺 The storefront action. Returns { ok: true, queued: true } or { ok: true, queued: false, why, message }.
 * Never throws at the customer and never says a thing happened that did not.
 */
async function submit(phone, token, code, subRef, deps) {
  const d = deps || {};
  const now = d.now || Date.now();
  if (!(await ready())) return { ok: true, ready: false };
  const ph = norm(phone);
  if (!ph || ph.length < 10) return { ok: true, queued: false, why: 'phone', message: 'Enter the phone number you bought with.' };
  const cd = cleanCode(code);
  if (cd.length < 4 || cd.length > 10) {
    return { ok: true, queued: false, why: 'badcode', message: 'That does not look like a TV code. It is the short code on your TV screen, usually 6 letters and numbers.' };
  }

  const accessMod = d.access || require('./otpaccess');
  // Same proof Get OTP demands: this device has confirmed an email that belongs to the plan.
  const access = await accessMod.checkGetOtp(ph, token);
  if (!access.ok) return Object.assign({ ok: true, queued: false, why: 'locked' }, access);

  let groups = await accessMod.unlockedForToken(ph, access.eh, new Date(now));
  const ref = s(subRef);
  if (ref) groups = groups.filter((g) => g.rows.some((r) => s(r.sub_id) === ref || s(r.order_id) === ref));
  const subIds = [...new Set(groups.flatMap((g) => g.rows.map((r) => s(r.sub_id))).filter(Boolean))];
  const rows = await primeRowsFor(subIds);
  if (!rows.length) {
    return { ok: true, queued: false, why: 'noplan', message: 'This number has no active Prime Video plan with us. If you have just bought one, give it a minute and try again.' };
  }
  const tvRows = rows.filter(hasTv);
  if (!tvRows.length) {
    return { ok: true, queued: false, why: 'notv', message: 'Your Prime plan is not a TV plan, so there is no TV to register. Message us and we will sort it out.' };
  }
  const row = tvRows.find((r) => s(r.inventory_ref)) || tvRows[0];
  const accountId = s(row.inventory_ref);
  if (!accountId) {
    return { ok: true, queued: false, why: 'noaccount', message: 'Your plan is still being set up. Give it a few minutes, or message us.' };
  }

  await expireStale(now);
  const since = new Date(now - 24 * 3600e3);
  // Every attempt counts EXCEPT one we expired through our own slowness — a customer should not lose their
  // tries because nobody got to the queue in time. (The first version counted `status <> 'EXPIRED'`, which
  // the "one code at a time" rule below quietly defeated: every earlier row was expired, so the count was
  // always 1 and the cap never tripped. Found by the test, not by reading.)
  const used = await db.query(
    "SELECT COUNT(*) n FROM tv_activations WHERE sub_id = ? AND created_at >= ? AND NOT (status = 'EXPIRED' AND why = ?)",
    [s(row.sub_id), since, WHY_STALE]);
  if (Number((used && used[0] && used[0].n) || 0) >= PER_SUB_DAY) {
    return { ok: true, queued: false, why: 'quota', message: 'That is a lot of tries today. Message us and we will finish it by hand.' };
  }
  // One at a time: a second code for the same plan replaces the first, because the first is already dead or
  // about to be. Two pending codes for one TV is only ever a confusing queue for the owner.
  await db.query("UPDATE tv_activations SET status = 'EXPIRED', code = '', why = ?, finished_at = ? WHERE sub_id = ? AND status = 'PENDING'", [WHY_REPLACED, new Date(now), s(row.sub_id)]);
  await db.query(
    'INSERT INTO tv_activations (sub_id, account_id, phone_norm, service, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [s(row.sub_id), accountId, ph, s(row.service), cd, 'PENDING', new Date(now)]);
  // 🔒 The code is not in this line, and must never be.
  console.log('[primetv] queued an activation for ' + s(row.sub_id) + ' on ' + accountId);
  if (d.notify) { try { await d.notify({ subId: s(row.sub_id), accountId, service: s(row.service) }); } catch (e) { console.log('[primetv] notify failed:', e.message); } }
  return {
    ok: true, queued: true,
    message: 'Got it — we are registering your TV now. Keep the code on screen; it usually takes a couple of minutes.',
  };
}

/** What the customer's screen polls: the state of their most recent request. */
async function mine(phone, token, deps) {
  const d = deps || {};
  const now = d.now || Date.now();
  if (!(await ready())) return { ok: true, ready: false };
  const ph = norm(phone);
  if (!ph) return { ok: true, ready: true, found: false };
  const accessMod = d.access || require('./otpaccess');
  const access = await accessMod.checkGetOtp(ph, token);
  if (!access.ok) return Object.assign({ ok: true, ready: true, found: false }, access);
  await expireStale(now);
  const rows = await db.query(
    'SELECT status, why, device_name, created_at, finished_at FROM tv_activations WHERE phone_norm = ? ORDER BY id DESC LIMIT 1', [ph]);
  const r = (rows || [])[0];
  if (!r) return { ok: true, ready: true, found: false };
  return {
    ok: true, ready: true, found: true,
    status: up(r.status),
    why: s(r.why) || '',
    deviceName: s(r.device_name) || '',
    at: r.created_at || null,
  };
}

function mount(app, deps) {
  const { auth } = deps;
  const audit = deps.audit || { record: () => {} };
  const fail = (res, e) => { console.log('[primetv]', e.message); res.status(500).json({ ok: false, message: e.message }); };

  // The queue. Pending first, then what happened recently, so the owner can see it worked.
  app.get('/admin/api/prime-tv', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!(await ready(true))) return res.json({ ok: true, ready: false, message: 'Run db/schema-v35.sql first.' });
      await expireStale(Date.now());
      await reapClaims(Date.now());
      const pending = await db.query(
        "SELECT t.id, t.sub_id, t.account_id, t.phone_norm, t.service, t.code, t.status, t.claimed_by, t.created_at, a.login_id, c.name " +
        'FROM tv_activations t ' +
        'LEFT JOIN inventory_accounts a ON a.account_id = t.account_id AND LOWER(a.service) LIKE \'%prime%\' ' +
        'LEFT JOIN customers c ON c.phone_norm = t.phone_norm ' +
        "WHERE t.status IN ('PENDING', 'CLAIMED') ORDER BY t.id ASC LIMIT 50");
      const recent = await db.query(
        "SELECT id, sub_id, account_id, service, status, why, device_name, created_at, finished_at FROM tv_activations WHERE status NOT IN ('PENDING', 'CLAIMED') ORDER BY id DESC LIMIT 25");
      res.json({ ok: true, ready: true, pending: pending || [], recent: recent || [] });
    } catch (e) { fail(res, e); }
  });

  // 📺 The worker asks for one job. Admin-key protected like every other /admin route — `who` is only a
  // label for the owner's eyes ("laptop", "vps"), never a credential, and grants nothing on its own.
  app.post('/admin/api/prime-tv/claim', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await claim((req.body && req.body.who) || 'worker');
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  // 🔒 Marked done only with the device name read back off Amazon. "It looked fine" is not a result: the name
  // is the handle the removal will need, and if it cannot be read the job is not finished.
  app.post('/admin/api/prime-tv/done', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!(await ready(true))) return res.status(409).json({ ok: false, message: 'Run db/schema-v35.sql first.' });
      const id = parseInt(req.body && req.body.id, 10);
      const name = s(req.body && req.body.deviceName).slice(0, 160);
      if (!id) return res.status(400).json({ ok: false, message: 'Which activation?' });
      if (!name) return res.status(400).json({ ok: false, message: 'Copy the new device\'s name from Prime Video first — it is what we will need to remove it later.' });
      // PENDING (the owner tapped) or CLAIMED (a worker is holding it) — both are legitimately in flight.
      const r = await db.query("UPDATE tv_activations SET status = 'DONE', code = '', device_name = ?, why = NULL, finished_at = ? WHERE id = ? AND status IN ('PENDING', 'CLAIMED')", [name, new Date(), id]);
      if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'That one is no longer waiting — it may have expired.' });
      audit.record(req, { action: 'primetv.done', entity: 'tv_activation', id: String(id), summary: ('📺 TV registered: ' + name).slice(0, 500), details: { deviceName: name } });
      res.json({ ok: true, message: '📺 Registered.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/prime-tv/fail', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!(await ready(true))) return res.status(409).json({ ok: false, message: 'Run db/schema-v35.sql first.' });
      const id = parseInt(req.body && req.body.id, 10);
      const why = s(req.body && req.body.why).slice(0, 160) || 'could not be registered';
      if (!id) return res.status(400).json({ ok: false, message: 'Which activation?' });
      const r = await db.query("UPDATE tv_activations SET status = 'FAILED', code = '', why = ?, finished_at = ? WHERE id = ? AND status IN ('PENDING', 'CLAIMED')", [why, new Date(), id]);
      if (!r || !r.affectedRows) return res.status(409).json({ ok: false, message: 'That one is no longer waiting.' });
      audit.record(req, { action: 'primetv.fail', entity: 'tv_activation', id: String(id), summary: ('📺 TV activation failed: ' + why).slice(0, 500), details: { why } });
      res.json({ ok: true, message: 'Noted.' });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  submit, mine, mount, ready, expireStale, claim, reapClaims,
  STALE_MIN, PER_SUB_DAY, WHY_STALE, WHY_REPLACED, CLAIM_STUCK_MIN,
  _internal: { cleanCode, hasTv, isPrime, primeRowsFor, reset: () => { readyCache = null; } },
};
