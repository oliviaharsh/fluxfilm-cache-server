/* 📺 Netflix helper (owner, 23 Sep 2026: move the ffnetflixhub Apps Script onto Hostinger, and forward the
   verification code too). Real oliviahousehold.js + adminnetflix.js against a fake IMAP server and a fake MySQL —
   no network, no inbox, no Netflix. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 700) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ACCOUNTS = [
  { account_id: 'NFLX-H5', service: 'Netflix', login_id: 'ininjathetriggerman@gmail.com', is_active: 'TRUE', raw_json: null },
  { account_id: 'NFLX-H1', service: 'Netflix', login_id: 'harshwalia8888@gmail.com', is_active: 'TRUE', raw_json: null },
  { account_id: 'NFLX-H9', service: 'Netflix', login_id: 'nobody@example.com', is_active: 'TRUE', raw_json: null },
];
const fakeDb = { ENABLED: true, query: async (sql) => (/FROM inventory_accounts/.test(sql) ? ACCOUNTS.map((a) => Object.assign({}, a)) : []) };
const origLoad = Module._load;
Module._load = function (req) { if (req === './db') return fakeDb; return origLoad.apply(this, arguments); };
const hh = require('../oliviahousehold');
const adminNetflix = require('../adminnetflix');
Module._load = origLoad;

// ---------------------------------------------------------------- a fake Gmail over IMAP
const CODE_HTML = '<h1>Verify with this code:</h1><p>0 6 8 0 9 7</p><p>Someone is trying to access your account.</p><p>Questions? Call 000-800-919-1743</p>';
const HH_HTML = '<p>Update your Netflix Household</p><a href="https://www.netflix.com/account/update-primary-location?nftoken=abc123">Confirm Update</a>';
const MAIL = {
  // the per-account Gmail labels the old Apps Script wrote into
  'NETFLIX/acc1': [
    { uid: 11, from: 'Netflix <info@account.netflix.com>', subject: '[FF][ACC1][HOUSEHOLD] Update your Netflix Household', html: HH_HTML, ageMin: 2 },
    { uid: 12, from: 'Netflix <info@account.netflix.com>', subject: '[FF][ACC1][CODE] Verification code. Expires in 15 mins.', html: CODE_HTML, ageMin: 1 },
    { uid: 13, from: 'Someone Else <hello@example.com>', subject: 'Update your Netflix Household', html: HH_HTML, ageMin: 1 },
  ],
  'NETFLIX/acc5': [],
  // What a FORWARDED mail really looks like in the hub: Gmail sends it as the account that forwarded it, so the
  // From is that Gmail address and not netflix.com. Our own [FF][TAG] prefix is what vouches for it.
  'NETFLIX/acc7': [
    { uid: 31, from: 'Stranger <hello@example.com>', subject: 'Update your Netflix Household', html: HH_HTML, ageMin: 1 },
    { uid: 32, from: 'FluxFilm Netflix 7 <ffnetflix7@gmail.com>', subject: '[FF][ACC7][HOUSEHOLD] Update your Netflix Household', html: HH_HTML, ageMin: 1 },
  ],
  // All Mail, where the only thing separating the accounts is the [TAG] in the subject
  '[Gmail]/All Mail': [
    { uid: 21, from: 'Netflix <info@account.netflix.com>', subject: '[FF][ACC5][HOUSEHOLD] Update your Netflix Household', html: HH_HTML, ageMin: 3 },
    { uid: 22, from: 'Netflix <info@account.netflix.com>', subject: '[FF][ACC1][HOUSEHOLD] Update your Netflix Household', html: HH_HTML, ageMin: 3 },
  ],
};
// A second fake Gmail for the DIRECT path: here the mailbox you are signed in to IS the account, so the mail is
// keyed by the user, not by a label. The mail is the original from Netflix, never a forward.
const DIRECT_MAIL = {
  'harshwalia8888@gmail.com': {
    INBOX: [
      { uid: 101, from: 'Netflix <info@account.netflix.com>', subject: 'Important: How to update your Netflix Household', html: HH_HTML, ageMin: 1 },
      { uid: 102, from: 'Netflix <info@account.netflix.com>', subject: 'Your Netflix verification code', html: CODE_HTML, ageMin: 0 },
      { uid: 103, from: 'Phisher <noreply@netflix-support.example>', subject: 'Update your Netflix Household now', html: HH_HTML, ageMin: 0 },
    ],
    '[Gmail]/All Mail': [],
  },
  'nobody@example.com': { INBOX: [], '[Gmail]/All Mail': [] },
};
const directOpened = [];
const directAuthUsed = [];
class FakeDirectImap {
  constructor(opts) { this.user = opts.auth.user; this.pass = opts.auth.pass; directAuthUsed.push({ user: this.user, pass: this.pass }); }
  async connect() { this.boxes = DIRECT_MAIL[this.user]; if (!this.boxes) throw new Error('Invalid credentials for ' + this.user); }
  async getMailboxLock(folder) {
    if (!this.boxes || !Object.prototype.hasOwnProperty.call(this.boxes, folder)) throw new Error('Mailbox does not exist: ' + folder);
    directOpened.push(folder); this.box = folder;
    return { release: () => { this.box = null; } };
  }
  async search(q) {
    const rows = (this.boxes && this.boxes[this.box]) || [];
    return rows.filter((m) => !q.subject || m.subject.toUpperCase().indexOf(String(q.subject).toUpperCase()) > -1).map((m) => m.uid);
  }
  async fetchOne(uid) {
    const all = [].concat(...Object.values(DIRECT_MAIL).map((b) => [].concat(...Object.values(b))));
    const m = all.find((x) => x.uid === uid);
    directLastFetched = m || null;
    return m ? { source: Buffer.from('x') } : null;
  }
  async logout() {}
}
let directLastFetched = null;
const directDeps = {
  imap: { ImapFlow: FakeDirectImap },
  mailparser: { simpleParser: async () => {
    const m = directLastFetched;
    return m ? { subject: m.subject, from: { text: m.from }, html: m.html, date: new Date(Date.now() - m.ageMin * 60e3) } : {};
  } },
};

const opened = [];
class FakeImap {
  constructor(opts) { this.opts = opts; this.box = null; }
  async connect() { this.connected = true; }
  async getMailboxLock(folder) {
    if (!Object.prototype.hasOwnProperty.call(MAIL, folder)) { const e = new Error('Mailbox does not exist: ' + folder); throw e; }
    opened.push(folder); this.box = folder;
    return { release: () => { this.box = null; } };
  }
  async search(q) {
    const rows = MAIL[this.box] || [];
    return rows.filter((m) => !q.subject || m.subject.toUpperCase().indexOf(String(q.subject).toUpperCase()) > -1).map((m) => m.uid);
  }
  async fetchOne(uid) { const all = [].concat(...Object.values(MAIL)); const m = all.find((x) => x.uid === uid); return m ? { source: Buffer.from('x'), _m: m } : null; }
  async logout() { this.connected = false; }
}
const fakeMailparser = { simpleParser: async (src, _o) => { const all = [].concat(...Object.values(MAIL)); const m = all.find((x) => Buffer.from('x').equals(src) ? false : false) || null; return m; } };
// simpleParser gets the raw source; the fake keeps the message on the fetch result instead, so wire it through.
const deps = {
  imap: { ImapFlow: FakeImap },
  mailparser: { simpleParser: null },
};
// Patch fetchOne to carry the message, and simpleParser to read it back.
let lastFetched = null;
const origFetchOne = FakeImap.prototype.fetchOne;
FakeImap.prototype.fetchOne = async function (uid) { const r = await origFetchOne.call(this, uid); lastFetched = r && r._m; return r; };
deps.mailparser.simpleParser = async () => {
  const m = lastFetched;
  if (!m) return {};
  return { subject: m.subject, from: { text: m.from }, html: m.html, date: new Date(Date.now() - m.ageMin * 60e3) };
};

(async () => {
  process.env.NETFLIX_IMAP_PASS = 'app password for the hub';
  process.env.OLIVIA_HH_ACC_MAP = JSON.stringify({ harshwalia8888: 'ACC1', ininjathetriggerman: 'ACC5' });

  // ── the label each account reads ──────────────────────────────────────────────────────────────────────────
  section('one Gmail label per account');
  ok('ACC1 reads NETFLIX/acc1 with nothing configured', hh._internal.labelFor('ACC1') === 'NETFLIX/acc1', hh._internal.labelFor('ACC1'));
  ok('an account with no tag reads no label — it is never guessed', hh._internal.labelFor('') === '');
  {
    process.env.NETFLIX_HH_LABEL_MAP = JSON.stringify({ ACC1: 'Netflix/one' });
    ok('a label can be named outright when the default does not fit', hh._internal.labelFor('ACC1') === 'Netflix/one');
    delete process.env.NETFLIX_HH_LABEL_MAP;
  }

  // ── reading the mail ──────────────────────────────────────────────────────────────────────────────────────
  section('the newest mail for one account');
  const acc1 = { service: 'Netflix', email: 'harshwalia8888@gmail.com', kind: 'H', tag: 'ACC1', ref: 'NFLX-H1' };
  opened.length = 0;
  let m = await hh.latestMail(acc1, 'household', deps);
  ok('household: found in the account\'s own label, not All Mail', !!m && m.foundBy === 'label' && opened[0] === 'NETFLIX/acc1', { m, opened });
  ok('…with the Netflix link to act on', !!m && /update-primary-location\?nftoken=abc123/.test(m.actionUrl), m && m.actionUrl);
  ok('…and mail from anyone but Netflix is ignored', !!m && m.subject.indexOf('[ACC1]') > -1, m && m.subject);

  section('the 6-digit verification code');
  m = await hh.latestMail(acc1, 'code', deps);
  ok('the code is read out of the mail, spaced-out digits and all', !!m && m.code === '068097', m);
  ok('…and there is no link to press — the code is the whole point', !!m && m.actionUrl === '', m && m.actionUrl);
  ok('the phone number in the footer is not mistaken for a code', hh._internal.verificationCodeFrom('Questions? Call 000-800-919-1743') === '');
  ok('a mail with no code in it is not offered as one', hh._internal.verificationCodeFrom('Verify with this code: soon') === '');
  ok('…and a household mail is never mistaken for a verification code', hh._internal.verificationCodeFrom('Update household. Your temporary access code is 1234') === '');

  section('an account whose mail is only in All Mail');
  const acc5 = { service: 'Netflix', email: 'ininjathetriggerman@gmail.com', kind: 'H', tag: 'ACC5', ref: 'NFLX-H5' };
  opened.length = 0;
  m = await hh.latestMail(acc5, 'household', deps);
  ok('its empty label is tried first, then All Mail by the subject tag', !!m && m.foundBy === 'subject' && opened.join(',') === 'NETFLIX/acc5,[Gmail]/All Mail', { m, opened });
  ok('…and it gets ACC5\'s mail, never ACC1\'s', !!m && m.subject.indexOf('[ACC5]') > -1, m && m.subject);
  {
    const noTag = { service: 'Netflix', email: 'nobody@example.com', kind: 'H', tag: '', ref: 'NFLX-H9' };
    ok('an account with no tag reads nothing at all rather than guessing', (await hh.latestMail(noTag, 'household', deps)) === null);
  }

  // ── the admin routes ──────────────────────────────────────────────────────────────────────────────────────
  section('the admin screen behind it');
  const routes = {}; const audits = [];
  adminNetflix.mount(
    { get: (p, fn) => { routes['GET ' + p] = fn; }, post: (p, fn) => { routes['POST ' + p] = fn; } },
    { auth: () => true, audit: { record: (req, o) => audits.push(o) }, household: hh, hhDeps: deps });
  ok('five routes — the three lookups plus the example pictures', Object.keys(routes).length === 5 && routes['GET /admin/api/netflix/accounts'] && routes['POST /admin/api/netflix/mail'] && routes['POST /admin/api/netflix/code'] && routes['GET /admin/api/netflix/pictures'] && routes['POST /admin/api/netflix/pictures'], Object.keys(routes));
  const call = async (key, body) => { let out = null; const res = { json: (o) => { out = o; }, status: () => ({ json: (o) => { out = o; } }) }; await routes[key]({ body: body || {} }, res); return out; };
  {
    const r = await call('GET /admin/api/netflix/accounts');
    ok('the accounts come from the shop, with the label each one reads', r.ok && r.accounts.length === 3 && r.accounts.find((a) => a.accountId === 'NFLX-H1').label === 'NETFLIX/acc1', r.accounts);
    ok('…and it says which have no tag, so they can be fixed', r.untagged.join() === 'NFLX-H9' && r.mailReady === true, { untagged: r.untagged, mailReady: r.mailReady });
  }
  {
    const r = await call('POST /admin/api/netflix/mail', { accountId: 'nflx-h1', mode: 'code' });
    ok('the screen gets the code', r.ok && r.mail && r.mail.code === '068097', r);
    ok('⚠️ the code is NEVER written to the change log', audits.length > 0 && !JSON.stringify(audits).includes('068097'), audits);
  }
  {
    const r = await call('POST /admin/api/netflix/mail', { accountId: 'NFLX-H9', mode: 'household' });
    ok('an untagged account is refused with a reason, not a wrong answer', r.ok === false && /no household tag/i.test(r.message), r);
  }
  {
    const r = await call('POST /admin/api/netflix/mail', { accountId: 'NOPE-1' });
    ok('an account we do not have → 404, nothing read', r.ok === false && /No Netflix account/.test(r.message), r);
  }
  {
    const keep = process.env.NETFLIX_IMAP_PASS; delete process.env.NETFLIX_IMAP_PASS;
    const r = await call('POST /admin/api/netflix/mail', { accountId: 'NFLX-H1' });
    ok('no app password set → says so plainly instead of failing oddly', r.ok === false && /NETFLIX_IMAP_PASS/.test(r.message), r);
    process.env.NETFLIX_IMAP_PASS = keep;
  }
  {
    let checked = 0, answered = false;
    const h = {};
    adminNetflix.mount({ get: (p, fn) => { h[p] = fn; }, post: (p, fn) => { h[p] = fn; } }, { auth: () => { checked++; return false; } });
    await h['/admin/api/netflix/mail']({ body: { accountId: 'NFLX-H1' } }, { json: () => { answered = true; }, status: () => ({ json: () => { answered = true; } }) });
    ok('every route is behind the admin sign-in', checked === 1 && answered === false, { checked, answered });
  }

  // ── reading each account's own inbox ──────────────────────────────────────────────────────────────────────
  section('direct: each account read from its own Gmail, no forwarding at all');
  {
    process.env.NETFLIX_ACC_PASS = JSON.stringify({ ACC1: 'abcd efgh ijkl mnop' });
    directOpened.length = 0; directAuthUsed.length = 0;
    const d = await hh.latestMail(acc1, 'household', directDeps);
    ok('read straight from the account\'s own INBOX', !!d && d.foundBy === 'inbox' && directOpened[0] === 'INBOX', { d, directOpened });
    ok('…signed in as that account, with its own app password (spaces stripped)',
      directAuthUsed[0] && directAuthUsed[0].user === 'harshwalia8888@gmail.com' && directAuthUsed[0].pass === 'abcdefghijklmnop', directAuthUsed[0]);
    ok('…and the mail is Netflix\'s own, not a forward', !!d && d.subject.indexOf('[FF]') === -1, d && d.subject);
    const c = await hh.latestMail(acc1, 'code', directDeps);
    ok('the verification code is read the same way', !!c && c.code === '068097', c);
    ok('a look-alike sender is still ignored', !!d && !/netflix-support/.test(JSON.stringify(d)));

    // No tag needed any more: in your own mailbox there is no other account to be confused with. An untagged
    // account just has to be named in the map by something it does have - its account id or its login email.
    process.env.NETFLIX_ACC_PASS = JSON.stringify({ 'NFLX-H1': 'abcd efgh ijkl mnop' });
    const noTag = { service: 'Netflix', email: 'harshwalia8888@gmail.com', kind: 'H', tag: '', ref: 'NFLX-H1' };
    const n = await hh.latestMail(noTag, 'household', directDeps);
    ok('an account with NO household tag still works — the mailbox is the account', !!n, n);

    ok('the password can be keyed by account id, email or name', (() => {
      const by = (k, acc) => { process.env.NETFLIX_ACC_PASS = JSON.stringify({ [k]: 'p' }); return !!hh._internal.directAuth(acc); };
      const a = { tag: 'ACC1', ref: 'NFLX-H1', email: 'harshwalia8888@gmail.com' };
      return by('NFLX-H1', a) && by('harshwalia8888@gmail.com', a) && by('harshwalia8888', a) && by('ACC1', a);
    })());
    ok('…and an account that is not in the map has none', (() => {
      process.env.NETFLIX_ACC_PASS = JSON.stringify({ ACC1: 'p' });
      return hh._internal.directAuth({ tag: 'ACC5', ref: 'NFLX-H5', email: 'ininjathetriggerman@gmail.com' }) === null;
    })());
    ok('a blank password is not a password', (() => {
      process.env.NETFLIX_ACC_PASS = JSON.stringify({ ACC1: '' });
      return hh._internal.directAuth({ tag: 'ACC1', email: 'a@b.com' }) === null;
    })());
    ok('rubbish in NETFLIX_ACC_PASS does not throw', (() => {
      process.env.NETFLIX_ACC_PASS = 'not json';
      return hh._internal.directAuth({ tag: 'ACC1', email: 'a@b.com' }) === null;
    })());

    // The migration must be safe one account at a time.
    process.env.NETFLIX_ACC_PASS = JSON.stringify({ ACC1: 'abcd efgh ijkl mnop' });
    opened.length = 0;
    const hub = await hh.latestMail(acc5, 'household', deps);
    ok('an account with no app password still reads the shared hub', !!hub && hub.foundBy === 'subject', { hub, opened });
    delete process.env.NETFLIX_ACC_PASS;
  }

  section('the hub fallback: a forwarded mail is not "from" Netflix');
  {
    // Gmail sends a forward as the account that forwarded it, so From is ffnetflix7@gmail.com, not netflix.com.
    const acc7 = { service: 'Netflix', email: 'seven@gmail.com', kind: 'H', tag: 'ACC7', ref: 'NFLX-H7' };
    const m7 = await hh.latestMail(acc7, 'household', deps);
    ok('our own [FF][TAG] forward is accepted', !!m7 && m7.subject.indexOf('[FF][ACC7]') > -1, m7);
    ok('…but a stranger\'s mail in the same label is not', !!m7 && m7.subject.indexOf('Stranger') === -1);
  }

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
  section('wiring');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok('admin.js mounts it', /require\('\.\/adminnetflix'\)\.mount\(app,/.test(read('admin.js')));
  const html = read('admin.html');
  ok('📺 Netflix helper is in the menu and registered', /\['netflix', '📺', 'Netflix helper'\]/.test(html) && /m\.netflix = netflixView;/.test(html));
  ok('all three things to look for', /\['household', '🏠 Household'\], \['travel', '✈️ Travel code'\], \['code', '🔐 Verification code'\]/.test(html));
  ok('⚠️ the screen warns that the verification code signs in to the account', /This code signs in to the Netflix account itself/.test(html) && /never send it to a customer/i.test(html));
  ok('the Netflix link is opened by the owner, never pressed for them', /Nothing is pressed for you/.test(html) && /target="_blank" rel="noopener noreferrer"/.test(html));
  ok('the account list says where each one is read from', /via: H\._internal\.directAuth\(/.test(read('adminnetflix.js')));
  ok('a tag is only demanded when the shared hub is used', /a\.via !== 'direct' && !a\.tag/.test(read('adminnetflix.js')));
  ok('it never writes: no INSERT / UPDATE / DELETE in the module', !/\b(INSERT INTO|UPDATE \w|DELETE FROM)\b/.test(read('adminnetflix.js')));

  console.log('\n---------------------------------------\nPASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
