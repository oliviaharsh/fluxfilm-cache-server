/**
 * FluxFilm — 📺 Netflix helper (admin), the Apps Script that lived on the ffnetflixhub inbox, moved onto the server.
 *
 * The owner picks one of our Netflix accounts and sees the newest **household**, **travel** or **verification code**
 * mail Netflix sent it, with the link to act on. Same job as the old web app, with three differences that matter:
 *   · no PIN in a URL — it sits behind the ordinary admin sign-in;
 *   · the account list comes from `inventory_accounts`, so it cannot drift from the shop;
 *   · it reads the same Gmail labels the script read (NETFLIX/acc1 … acc4), through IMAP.
 *
 * ⚠️ Read-only. It opens nothing and presses nothing: the owner gets the link and decides. "Get the code" uses
 * oliviahousehold.travelCode, which the module documents as read-only and which never presses a button on a
 * sign-in / captcha / expired page.
 *
 *   GET  /admin/api/netflix/accounts            our Netflix accounts + the label each one reads
 *   POST /admin/api/netflix/mail  { accountId, mode }   newest household|travel|code mail: subject, date, link, code
 *   POST /admin/api/netflix/code  { accountId }         the 4-digit travel code, fetched the read-only way
 */
const db = require('./db');

const s = (v) => String(v == null ? '' : v).trim();

function mount(app, deps) {
  const { auth } = deps;
  const audit = (deps && deps.audit) || { record: () => {} };
  const hh = () => (deps && deps.household) || require('./oliviahousehold');
  const q = (sql, p) => ((deps && deps.query) || db.query)(sql, p || []);
  const fail = (res, e) => res.status((e && e.status) || 500).json({ ok: false, message: String((e && e.message) || e) });

  // What each lookup is called in the 🕘 Change log.
  const NF_LOOKED = {
    household: '🏠 Looked up the household mail',
    travel: '✈️ Looked up the travelling code',
    code: '🔐 Looked up the 6-digit VERIFICATION CODE',
  };

  /** Every Netflix account we own, with the tag and the Gmail label its mail is filed under. */
  async function accounts() {
    const rows = await q("SELECT account_id, service, login_id, is_active, raw_json FROM inventory_accounts WHERE LOWER(service) LIKE '%netflix%' ORDER BY account_id");
    const H = hh();
    return (rows || []).map((r) => {
      const tag = H._internal.tagOf(s(r.account_id), r.raw_json, s(r.login_id));
      return {
        accountId: s(r.account_id), service: s(r.service), email: s(r.login_id),
        isActive: s(r.is_active).toUpperCase() !== 'FALSE',
        kind: H._internal.kindOfRef(s(r.account_id)),
        tag, label: tag ? H._internal.labelFor(tag) : '',
        // Where this account's mail is read from: its own inbox, or the shared hub. Shown on the screen so a new
        // app password can be seen to have taken effect without reading any mail.
        via: H._internal.directAuth({ tag, ref: s(r.account_id), email: s(r.login_id) }) ? 'direct' : 'hub',
      };
    });
  }

  async function accountFor(accountId) {
    const id = s(accountId).toUpperCase();
    if (!id) { const e = new Error('Pick an account first.'); e.status = 400; throw e; }
    const all = await accounts();
    const a = all.find((x) => x.accountId.toUpperCase() === id);
    if (!a) { const e = new Error('No Netflix account called ' + id + '.'); e.status = 404; throw e; }
    return a;
  }

  app.get('/admin/api/netflix/accounts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const list = await accounts();
      res.json({
        ok: true, accounts: list,
        inbox: process.env.NETFLIX_IMAP_USER || 'ffnetflixhub@gmail.com',
        // Readable if the shared hub has a password, OR any one account can be read from its own inbox.
        mailReady: !!process.env.NETFLIX_IMAP_PASS || list.some((a) => a.via === 'direct'),
        hubReady: !!process.env.NETFLIX_IMAP_PASS,
        direct: list.filter((a) => a.via === 'direct').map((a) => a.accountId),
        // Only an account still read through the shared hub needs a tag to be told apart.
        untagged: list.filter((a) => a.via !== 'direct' && !a.tag).map((a) => a.accountId),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/netflix/mail', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const asked = s(b.mode).toLowerCase();
      const mode = asked === 'travel' || asked === 'code' ? asked : 'household';
      const a = await accountFor(b.accountId);
      if (!process.env.NETFLIX_IMAP_PASS) return res.status(409).json({ ok: false, message: 'NETFLIX_IMAP_PASS is not set on the server, so the inbox cannot be read.' });
      // A tag is only needed for the shared hub, where four accounts' mail is mixed together. An account read
      // directly from its own inbox needs nothing: the mailbox is the account.
      if (a.via !== 'direct' && !a.tag) return res.status(409).json({ ok: false, message: a.accountId + ' has no household tag, so its mail cannot be told apart from the other accounts in the shared inbox. Give it its own app password in NETFLIX_ACC_PASS, or set HouseholdTag on the account / add it to OLIVIA_HH_ACC_MAP.' });
      const mail = await hh().latestMail({ service: a.service, email: a.email, kind: a.kind, tag: a.tag, ref: a.accountId }, mode, deps && deps.hhDeps);
      // 🕘 Who looked, when, at which account — so the owner can prove only they ever did.
      // 🔐 The code is NOT written down: the line says one was shown, not what it was.
      audit.record(req, {
        action: 'netflix.' + (mode === 'code' ? 'code' : 'mail'), entity: 'inventory_account', id: a.accountId,
        summary: NF_LOOKED[mode === 'code' ? 'code' : mode] + ' · ' + a.accountId + ' · ' + (mail ? 'found, ' + (mail.date || '').slice(0, 16) : 'nothing in the inbox'),
        details: { accountId: a.accountId, email: a.email, mode, found: !!mail, subject: mail ? mail.subject : '', via: a.via },
      });
      res.json({ ok: true, accountId: a.accountId, email: a.email, label: a.label, mode, mail: mail || null });
    } catch (e) { fail(res, e); }
  });

  // The three example screenshots a customer points at in 🧰 Tools → Netflix Household ("this is what I see").
  app.get('/admin/api/netflix/pictures', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const r = await require('./householdhelp').pictures();
      const has = {}; for (const k of Object.keys(r.pictures || {})) has[k] = !!r.pictures[k];
      res.json({ ok: true, has, pictures: r.pictures });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/netflix/pictures', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const r = await require('./householdhelp').savePicture(b.kind, b.dataUrl);
      if (!r.ok) return res.status(400).json(r);
      audit.record(req, { action: r.has ? 'household.picture' : 'household.picture.remove', entity: 'settings', id: 'household_pics', summary: (r.has ? 'Uploaded' : 'Removed') + ' the ' + r.kind + ' example' + (r.has ? ' (' + Math.round(r.bytes / 1024) + ' KB)' : '') });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/netflix/code', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const a = await accountFor((req.body || {}).accountId);
      const r = await hh().travelCode({ service: a.service, email: a.email, kind: a.kind, tag: a.tag, ref: a.accountId }, deps && deps.hhDeps);
      audit.record(req, { action: 'netflix.code', entity: 'inventory_account', id: a.accountId, summary: r && r.ok ? 'travel code fetched' : 'travel code not available' });
      // ⚠️ The code itself goes to the screen only — never into the change log.
      res.json(r && r.ok ? { ok: true, accountId: a.accountId, code: r.code } : { ok: false, manual: true, message: 'No code could be read. Open the link above and do it by hand.' });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
