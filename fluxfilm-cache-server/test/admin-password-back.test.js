/* 🔑 Going back from a picked account on the Password change screen.
 *
 * Owner, 3 Oct 2026: *"when i click on password change, search acc , select it, i cant go back to list of
 * accs, it throws me at today"*.
 *
 * The panel has had the mechanism all along. `hSub(name, close)` marks a drill-in: it pushes a history entry
 * so Back returns to the list, and `hSubDone(name)` drops that entry when the list is shown again. Offers and
 * Plans use it. The password screen did not — picking an account was a bare state change, so Back had nothing
 * to return to inside the screen and fell out to Today.
 *
 * These run the REAL view code out of admin.html against a small fake DOM, the same way
 * admin-reviews-trust.test.js does, because a regex over the source can only tell you what somebody meant to
 * write. Run: npm test */
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

// ── the real password block, lifted out of the panel ──────────────────────────────────────────────────────
const START = "var PW = { q: '', accounts: null";
const END = '/* ================= renewal reminders ================= */';
const a = HTML.indexOf(START), b = HTML.indexOf(END);
if (a < 0 || b < 0 || b < a) { console.log('CRASH: could not find the password block in admin.html'); process.exit(1); }
const SRC = HTML.slice(a, b);

// ── the smallest DOM and the smallest history stack these functions use ───────────────────────────────────
let EL, SUBS, DONES, STACK;
function makeEl(id) {
  const el = { id, innerHTML: '', value: '', onclick: null, textContent: '', type: 'text', focus() {}, addEventListener() {}, getAttribute: () => null, querySelectorAll: () => [] };
  // The picked-account screen wires its back button with el.querySelector('[data-back]'); hand back a stub so
  // the real code runs to the end instead of throwing on a missing DOM.
  el.querySelector = () => makeEl('stub');
  return el;
}
const reset = () => {
  EL = { '#view': makeEl('view'), '#pwbody': makeEl('pwbody') };
  SUBS = []; DONES = []; STACK = ['today'];
  IMPACT_REPLY = IMPACT;
};
const $ = (sel) => {
  if (!EL[sel] && /^#pw/.test(sel)) EL[sel] = makeEl(sel.slice(1));
  return EL[sel] || null;
};
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The real panel's drill-in bookkeeping, reduced to what it does to the history stack. */
const hSub = (name, close) => { SUBS.push({ name, close }); STACK.push('sub:' + name); };
const hSubDone = (name) => {
  DONES.push(name);
  if (STACK[STACK.length - 1] === 'sub:' + name) STACK.pop();
};
/** What the ← arrow / phone Back actually does: pop one entry and run the sub's close if that is what it was. */
const goBack = () => {
  const top = STACK[STACK.length - 1];
  if (top && top.indexOf('sub:') === 0) {
    STACK.pop();
    const s = SUBS[SUBS.length - 1];
    if (s) s.close();
    return 'stayed on the password screen';
  }
  STACK.pop();
  return 'left for ' + (STACK[STACK.length - 1] || 'today');
};

const noop = () => {};
let IMPACT_REPLY;
const api = (p) => Promise.resolve(
  /impact/.test(p) ? IMPACT_REPLY : { ok: true, accounts: ACCOUNTS });
const post = () => Promise.resolve({ ok: true });
const prettyDate = (d) => String(d || '');
const svcIcon = () => '';
const toast = noop;
const nav = noop;
const confirm = () => true;

const P = new Function('$', 'esc', 'hSub', 'hSubDone', 'api', 'post', 'prettyDate', 'svcIcon', 'toast', 'nav', 'confirm',
  SRC + '\nreturn { PW: PW, renderPassword: renderPassword, passwordView: passwordView };')(
  $, esc, hSub, hSubDone, api, post, prettyDate, svcIcon, toast, nav, confirm);

const ACCOUNTS = [
  { service: 'Prime', account_id: 'PRI-13', login_id: 'a@example.com', is_active: 'FALSE' },
  { service: 'Prime', account_id: 'PRI-31', login_id: 'b@example.com', is_active: 'FALSE' },
];
const IMPACT = {
  ok: true,
  account: { service: 'Prime', accountId: 'PRI-13', login: 'a@example.com', password: 'secret', isActive: true, passwordChangedAt: null },
  sameLogin: [{ account_id: 'PRI-13' }], active: [], expired: [], older: [], totalSubs: 0, olderCount: 0,
};

/** Draw the list, then click the Nth account on it — the real handler the panel wires up. */
const pickAccount = (i) => {
  P.PW.accounts = ACCOUNTS;
  P.PW.pick = null; P.PW.impact = null; P.PW.result = null;
  P.renderPassword();                                   // list
  const handler = EL['#pwlist'] && EL['#pwlist'].onclick;
  if (!handler) throw new Error('the account list has no click handler');
  handler({ target: { closest: () => ({ getAttribute: () => String(i) }) } });
  P.PW.impact = IMPACT;
  P.renderPassword();                                   // the picked-account screen
};

(async () => {
  // ── the bug ───────────────────────────────────────────────────────────────────────────────────────────────
  section('🔒 the bug: Back from a picked account must return to the list, not to Today');
  reset();
  pickAccount(0);
  ok('picking an account registers a drill-in', SUBS.length === 1 && SUBS[0].name === 'pwacct', { subs: SUBS.map((s) => s.name) });
  ok('…so there is a history entry to come back to', STACK[STACK.length - 1] === 'sub:pwacct', STACK);

  const where = goBack();
  ok('🔒 Back keeps you on the password screen', where === 'stayed on the password screen', where);
  ok('🔒 …and you are on the LIST again, not still staring at the account', P.PW.pick === null, P.PW.pick);
  ok('the stale impact is cleared with it, so the next account cannot show the last one\'s people',
    P.PW.impact === null, P.PW.impact);

  section('the entry is not left behind');
  reset();
  pickAccount(0);
  P.renderPassword();                 // close is what re-renders the list in the real thing
  P.PW.pick = null; P.renderPassword();
  ok('showing the list ends the drill-in', DONES.indexOf('pwacct') >= 0, DONES);
  ok('🔒 and the history entry is gone, so a second Back does not land on a dead step',
    STACK[STACK.length - 1] === 'today', STACK);

  section('a second pick does not stack entries for ever');
  reset();
  pickAccount(0);
  goBack();
  pickAccount(1);
  ok('one entry at a time', STACK.filter((x) => x === 'sub:pwacct').length === 1, STACK);
  ok('and it is the newly picked account', P.PW.pick && P.PW.pick.accountId === 'PRI-31', P.PW.pick);

  // ── the thing that made it hard to find ───────────────────────────────────────────────────────────────────
  section('the way back says what it does');
  reset();
  pickAccount(0);
  const drawn = EL['#pwbody'].innerHTML;
  ok('🔒 the in-page button is no longer labelled just "Change", which on a Password change screen reads as '
    + '"change the password"', !/>Change</.test(drawn), (drawn.match(/data-back="1">[^<]*</) || [''])[0]);
  ok('…it says what it actually does', /data-back="1">← Pick another account</.test(drawn),
    (drawn.match(/data-back="1">[^<]*</) || [''])[0]);
  ok('🔒 and it matches the wording the error branch has always used',
    (HTML.match(/← Pick another account/g) || []).length === 2, (HTML.match(/← Pick another account/g) || []).length);

  // ── the other way in must be unaffected ───────────────────────────────────────────────────────────────────
  section('🔒 arriving from 🚪 Remove users is a different journey and must not change');
  reset();
  // That path sets the pick itself and calls nav('password') — it is a new screen, not a drill-in, so Back
  // should return to Remove users. It must not register a sub entry.
  P.PW.pick = { service: 'Prime', accountId: 'PRI-13' }; P.PW.impact = IMPACT; P.PW.result = null;
  STACK = ['today', 'removeusers'];
  P.renderPassword();
  ok('no drill-in is registered for that route', SUBS.length === 0, SUBS.map((s) => s.name));
  ok('…so Back still leaves for the screen you came from', goBack() === 'left for today', STACK);
  ok('the code still has the Remove-users jump', /PW\.pick = \{ service: pw\.getAttribute\('data-rusvc'\)/.test(HTML));

  section('the panel still runs');
  let parsed = true, n = 0;
  for (const m of HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1].trim()) continue;
    n++;
    try { new Function(m[1]); } catch (e) { parsed = false; console.log('   parse error: ' + e.message); }
  }
  ok('every inline <script> parses', parsed && n > 0, { blocks: n });
  ok('package.json runs this test', /node test\/admin-password-back\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  console.log('\n---------------------------------------');
  console.log('admin-password-back: PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('CRASH', e); process.exitCode = 1; });
