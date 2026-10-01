/**
 * FluxFilm - payment verification (Wave 2, Path B).
 * IMAP watcher reads the bank inbox (default [Gmail]/All Mail so it catches
 * emails even if a filter archives them), parses Equitas UPI credit alerts, and
 * saves each into bank_credits. verifyPayment matches by OrderID or UPI ref.
 * Env: IMAP_USER, IMAP_PASS, IMAP_HOST (imap.gmail.com), IMAP_FOLDER ([Gmail]/All Mail),
 *      BANK_SENDER (esfb-alerts@equitas.bank.in)
 */
const db = require('./db');

function parseEquitasCredit(body) {
  const text = String(body || '').replace(/\s+/g, ' ');
  const m = text.match(/An amount of INR\s+([\d,]+(?:\.\d+)?)\s+has been credited/i);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  const refM = text.match(/UPI REF NO\s+(\d+)/i);
  const upiRef = refM ? refM[1] : '';
  const orderIds = (text.match(/\bFF\d{6,}\b/gi) || []).map((x) => x.toUpperCase());
  if (!upiRef) return null;
  return { type: 'CREDIT', amount, upiRef, orderIds, raw: text.slice(0, 380) };
}

async function ingestCredit(c, receivedAt) {
  if (!c || !c.upiRef) return false;
  const r = await db.query(
    'INSERT IGNORE INTO bank_credits (upi_ref, amount, order_ids, raw, received_at) VALUES (?,?,?,?,?)',
    [c.upiRef, c.amount, (c.orderIds || []).join(','), c.raw || '', receivedAt || new Date()]);
  return !!(r && r.affectedRows);
}

// Everything creditState / markPaidNow / afterPaid read off the order row.
const CREDIT_ORDER_COLS = 'order_id, created_at_sheet, name, phone_norm, email, service, plan, final_amount, status, source, order_type, renew_sub_id, txn_ref, raw_json';

/**
 * 💳 A credit renewal (status CREDIT - the 💳 Receivables list) that the customer has now actually paid.
 *
 * verifyPayment() refuses status CREDIT on purpose: the plan is already running and the money is a receivable,
 * so the checkout page must never "confirm" one. But that refusal also meant the one kind of order with NOBODY
 * polling for it was the one kind a bank alert could never settle - the owner creates it, there is no checkout
 * page at all. Amit Sharma, 1 Oct 2026: paid at 21:35, the alert named FF6638684 and carried the right ₹99,
 * and it still sat in Receivables until it was settled by hand.
 *
 * Narrow on purpose:
 *   - only an OPEN credit with nothing paid against it yet; part-paid ones stay the owner's to finish
 *   - only for the exact amount still due (findByOrder matches ROUND(amount) and the order id in the note)
 *   - the credit is taken by findByOrder - the same atomic UPDATE ... WHERE consumed_order_id IS NULL every other
 *     match uses, so two sweeps can never spend one payment twice - and is put straight back if settling fails
 * Nothing is delivered here: a credit renewal was delivered when it was put on credit (credit.startCredit).
 */
async function settleCreditOrder(orderId) {
  const oid = String(orderId || '').toUpperCase();
  if (!oid) return false;
  const credit = require('./credit');
  const rows = await db.query('SELECT ' + CREDIT_ORDER_COLS + ' FROM orders WHERE order_id = ? LIMIT 1', [oid]);
  const o = (rows || [])[0];
  if (!o || String(o.source || '') !== 'node') return false;
  const st = credit.creditState(o, new Date());
  if (!st.open || st.paid > 0 || !(st.due > 0)) return false;
  const c = await findByOrder(oid, st.due);
  if (!c) return false;
  const giveBack = async (why) => {
    await db.query('UPDATE bank_credits SET consumed_order_id = NULL WHERE consumed_order_id = ?' + (c.id ? ' AND id = ?' : ''), c.id ? [oid, c.id] : [oid]).catch(() => {});
    console.log('[settle] ' + oid + ' credit renewal NOT settled (' + why + ') - the payment is back in the list');
    return false;
  };
  if (!c.id) return giveBack('the matched payment could not be read back');
  let r;
  try {
    r = await credit.markPaidNow({ db }, o, {
      amount: st.due, method: 'UPI', ref: String(c.upi_ref || ''), key: 'bank-' + c.id,
      note: 'Matched automatically: the bank alert named this order (UPI ref ' + String(c.upi_ref || '') + ', bank payment #' + c.id + ').',
    }, new Date());
  } catch (e) { return giveBack(e.message); }
  if (!r || (r.action !== 'PAID' && r.action !== 'ALREADY')) return giveBack(String((r && r.message) || r && r.action || '?'));
  console.log('[settle] ' + oid + ' credit renewal settled from bank credit ' + c.id + ' (₹' + st.due + ')');
  return true;
}

/**
 * Pay ONE order from a bank credit that already names it, and deliver it.
 *
 * Until 28 Sep 2026 the only thing that ever consumed such a credit was verifyPayment(), and the only thing that
 * called verifyPayment() was the storefront checkout page WHILE THE CUSTOMER SAT ON IT. So a customer who paid
 * from the 💳 payment link (whose page polls a status route that only reads the order) — or who simply closed the
 * tab — left the money sitting in bank_credits with their order id written on it, and the order stuck on CREATED.
 * The bank alert had everything needed; nothing was listening.
 *
 * verifyPayment() marks it PAID but does not deliver — the storefront calls fulfilment separately — so this does
 * both, or the order just moves from "unpaid" to "paid but not delivered".
 *
 * 💳 A credit renewal goes to settleCreditOrder() instead: verifyPayment refuses status CREDIT by design, which
 * until 1 Oct 2026 left the one kind of order nobody polls for as the one kind this could never settle.
 */
async function settleOne(orderId) {
  const oid = String(orderId || '').toUpperCase();
  if (!oid) return false;
  const r = await require('./order').verifyPayment(oid);
  // 💳 A credit renewal: verifyPayment will never mark one paid, so settle the receivable instead.
  if (r && r.credit) return settleCreditOrder(oid);
  if (!(r && r.paid)) return false;
  // Delivery is best-effort: the money is recorded either way, and a failed delivery is already a Today card.
  try { await require('./fulfill').fulfillForAdmin(oid); }
  catch (e) { console.log('[settle] ' + oid + ' paid but delivery failed:', e.message); }
  return true;
}

/**
 * Sweep: every unused credit whose bank note named an order. Runs whenever new mail lands and on the 60-second
 * safety scan, so nobody has to be looking at a screen for a payment to count.
 *
 * The order ids are split in JavaScript and each one looked up by parameter — never joined against
 * bank_credits.order_ids in SQL. That comparison is exactly what broke the ▶️ Today count on 27 Sep: the tables
 * do not share a collation and MariaDB refuses it.
 */
async function settleNamedOrders(hours) {
  const out = { checked: 0, paid: 0 };
  let rows;
  try {
    rows = await db.query(
      'SELECT id, order_ids, amount FROM bank_credits WHERE consumed_order_id IS NULL AND order_ids <> ? ' +
      'AND received_at > NOW() - INTERVAL ? HOUR ORDER BY received_at DESC LIMIT 100', ['', Math.max(1, Number(hours) || 72)]);
  } catch (e) { console.log('[settle] sweep could not read credits:', e.message); return out; }
  const seen = new Set();
  for (const c of rows) {
    for (const oid of String(c.order_ids || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      out.checked++;
      try { if (await settleOne(oid)) { out.paid++; console.log('[settle] ' + oid + ' paid from bank credit ' + c.id); } }
      catch (e) { console.log('[settle] ' + oid + ' failed:', e.message); }
    }
  }
  return out;
}

async function findByOrder(orderId, amount) {
  const oid = String(orderId || '').toUpperCase();
  const r = await db.query(
    `UPDATE bank_credits SET consumed_order_id = ?
     WHERE consumed_order_id IS NULL AND ROUND(amount) = ROUND(?) AND FIND_IN_SET(?, order_ids) > 0
     ORDER BY received_at DESC LIMIT 1`, [oid, amount, oid]);
  if (r && r.affectedRows > 0) {
    const rows = await db.query('SELECT * FROM bank_credits WHERE consumed_order_id = ? ORDER BY id DESC LIMIT 1', [oid]);
    return rows[0] || { ok: true };
  }
  return null;
}
async function findByRef(orderId, ref, amount) {
  const oid = String(orderId || '').toUpperCase();
  const cleanRef = String(ref || '').replace(/\D/g, '');
  if (!cleanRef) return null;
  // A typed UTR may only pay THIS order with a payment made for it: not one whose bank note names another
  // order, and not an old one (received more than REF_WINDOW_MIN before the order was created). Before, any
  // unused credit with the same UTR + amount worked — e.g. an old go-site payment, or a UTR from someone
  // else's screenshot — so a customer could get a new order marked PAID without paying again.
  // An order with no created_at_sheet (NULL) skips the time check (COALESCE) instead of blocking a valid UTR.
  // The admin "link bank payment" (adminbankcredits.js) and the backup-UPI claims (paymatch.js) do not use this.
  const r = await db.query(
    `UPDATE bank_credits SET consumed_order_id = ?
     WHERE consumed_order_id IS NULL AND upi_ref = ? AND ROUND(amount) = ROUND(?)
       AND (COALESCE(order_ids, '') = '' OR FIND_IN_SET(?, order_ids) > 0)
       AND received_at >= COALESCE((SELECT DATE_SUB(o.created_at_sheet, INTERVAL ? MINUTE) FROM orders o WHERE o.order_id = ? LIMIT 1), '1000-01-01 00:00:00')
     LIMIT 1`,
    [oid, cleanRef, amount, oid, REF_WINDOW_MIN, oid]);
  if (r && r.affectedRows > 0) {
    const rows = await db.query('SELECT * FROM bank_credits WHERE upi_ref = ? LIMIT 1', [cleanRef]);
    return rows[0] || { ok: true };
  }
  return null;
}

// Minutes a bank credit may arrive BEFORE its order was created and still be claimed by typing its UTR (clock skew).
const REF_WINDOW_MIN = 10;

const HOST = () => process.env.IMAP_HOST || 'imap.gmail.com';
const FOLDER = () => process.env.IMAP_FOLDER || '[Gmail]/All Mail';
const SENDER = () => process.env.BANK_SENDER || 'esfb-alerts@equitas.bank.in';

// The bank's own mail domain. Its alerts are trusted from this domain or a subdomain of it, whatever BANK_SENDER says.
const BANK_DOMAIN = 'equitas.bank.in';
// Domains anyone can get an address on (or bare suffixes): BANK_SENDER on one of these is trusted only as an exact address.
const OPEN_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'zoho.com', 'aol.com', 'gmx.com', 'mail.com',
  'bank.in', 'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'com', 'in', 'net', 'org']);

const domainOf = (addr) => { const a = String(addr || ''); const i = a.lastIndexOf('@'); return i > 0 ? a.slice(i + 1) : ''; };
/** domain is base itself or a subdomain of it ("alerts.equitas.bank.in"), never "equitas.bank.in.evil.com" / "xequitas.bank.in". */
const inDomain = (domain, base) => !!domain && !!base && (domain === base || domain.endsWith('.' + base));
const cleanDomain = (d) => (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !OPEN_DOMAINS.has(d) ? d : '');

/**
 * Is this parsed mail really from the bank? Uses the parsed From ADDRESS (mailparser's from.value[0].address),
 * never the display name, and exactly one From address. Accepted when the address:
 *   - equals BANK_SENDER (case-insensitive, trimmed), or
 *   - is on the domain of BANK_SENDER (BANK_SENDER may be a bare domain, e.g. "equitas.bank.in", or "@equitas.bank.in"), or
 *   - is on equitas.bank.in or a subdomain of it.
 * So a partial / different Equitas BANK_SENDER in Hostinger no longer makes every bank email get skipped.
 */
function fromBank(parsed, senderSetting) {
  const list = (parsed && parsed.from && parsed.from.value) || [];
  if (list.length !== 1) return false;
  const addr = String(list[0].address || '').trim().toLowerCase();
  if (!/^[^@\s<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(addr)) return false;
  const want = String(senderSetting == null ? SENDER() : senderSetting).trim().toLowerCase().replace(/^@/, '');
  if (want && addr === want) return true;
  const dom = domainOf(addr);
  const wantDomain = cleanDomain(want.includes('@') ? domainOf(want) : want);
  if (wantDomain && inDomain(dom, wantDomain)) return true;
  return inDomain(dom, BANK_DOMAIN);
}
/** What to ask IMAP for: the domain, so a slightly different bank address is still fetched (fromBank then decides). */
function searchFrom() {
  const want = String(SENDER()).trim().toLowerCase().replace(/^@/, '');
  const d = cleanDomain(want.includes('@') ? domainOf(want) : want);
  return d || want || BANK_DOMAIN;
}
/** IMAP search: mail from the BANK_SENDER domain, and always from equitas.bank.in too (IMAP FROM is a substring match). */
function searchQuery(since) {
  const term = searchFrom();
  if (term === BANK_DOMAIN) return { from: BANK_DOMAIN, since };
  return { or: [{ from: term }, { from: BANK_DOMAIN }], since };
}
// Skipped senders are logged once per address (the safety scan re-reads the same mails every minute).
const _skippedLogged = new Set();
function logSkipped(parsed) {
  const list = (parsed && parsed.from && parsed.from.value) || [];
  const who = list.map((x) => String(x.address || '').trim().toLowerCase()).join(',') || '(no From address)';
  if (_skippedLogged.has(who)) return false;
  if (_skippedLogged.size > 200) _skippedLogged.clear();
  _skippedLogged.add(who);
  console.log('[imap] skipped a credit-like mail from', who, '— not the bank (BANK_SENDER=' + SENDER() + '). Logged once per sender.');
  return true;
}

// 🔗 n8n deep health (GET /n8n/api/health): when the watcher last connected, scanned and saved a bank credit. Memory only.
const _imap = { connected: false, lastConnectAt: null, lastScanAt: null, lastIngestAt: null, lastError: '' };
function status() { return Object.assign({ configured: !!(process.env.IMAP_USER && process.env.IMAP_PASS), watching: _watching }, _imap); }

async function scanInbox(client, hours) {
  const { simpleParser } = require('mailparser');
  const lock = await client.getMailboxLock(FOLDER());
  let found = 0, ingested = 0;
  try {
    const since = new Date(Date.now() - (hours || 6) * 3600 * 1000);
    const uids = await client.search(searchQuery(since));
    if (uids && uids.length) {
      for await (const msg of client.fetch(uids.slice(-60), { source: true, envelope: true, internalDate: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          // IMAP "from" search is a substring match (display names, look-alike domains), so check the real
          // parsed sender address before trusting a "credited" email.
          if (!fromBank(parsed)) { if (parseEquitasCredit(parsed.text || parsed.html || '')) logSkipped(parsed); continue; }
          const c = parseEquitasCredit(parsed.text || parsed.html || '');
          // Time = when Gmail received it (the Date header is written by the sender and can be faked).
          if (c) { found++; if (await ingestCredit(c, msg.internalDate || (msg.envelope && msg.envelope.date) || new Date())) ingested++; }
        } catch (_) {}
      }
    }
  } finally { lock.release(); }
  _imap.lastScanAt = new Date().toISOString();
  if (ingested) _imap.lastIngestAt = _imap.lastScanAt;
  return { found, ingested };
}

// One-shot scan (for the /admin/imap-scan button)
async function manualScan(hours) {
  const user = process.env.IMAP_USER, pass = process.env.IMAP_PASS;
  if (!user || !pass) return { ok: false, message: 'IMAP not configured' };
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: HOST(), port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const r = await scanInbox(client, hours || 24);
    return { ok: true, folder: FOLDER(), ...r };
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) };
  } finally { try { await client.logout(); } catch (_) {} }
}

let _watching = false;
async function startWatcher() {
  const user = process.env.IMAP_USER, pass = process.env.IMAP_PASS;
  if (!user || !pass) { console.log('[imap] IMAP_USER/IMAP_PASS not set — watcher disabled'); return; }
  if (_watching) return; _watching = true;
  const { ImapFlow } = require('imapflow');
  (async function loop() {
    while (_watching) {
      let client;
      try {
        client = new ImapFlow({ host: HOST(), port: 993, secure: true, auth: { user, pass }, logger: false });
        await client.connect();
        console.log('[imap] connected, watching', FOLDER(), 'for', SENDER());
        Object.assign(_imap, { connected: true, lastConnectAt: new Date().toISOString(), lastError: '' });
        const r0 = await scanInbox(client, 6);
        console.log('[imap] initial scan:', JSON.stringify(r0));

        // ImapFlow's manually awaited idle() does not necessarily return when a
        // new message arrives. That previously delayed ingestion (and therefore
        // verifyPayment) until IDLE ended. Let ImapFlow auto-idle and react to
        // mailbox count changes immediately. The timer is a safety net for a
        // missed provider event, not the primary polling path.
        let scanning = false;
        let scanAgain = false;
        const queueScan = async () => {
          if (scanning) { scanAgain = true; return; }
          scanning = true;
          try {
            do {
              scanAgain = false;
              const r = await scanInbox(client, 1);
              if (r.ingested) {
                console.log('[imap] ingested', r.ingested, 'new credit(s)');
                // New bank money: pay any order the alert NAMED (the customer may have closed the page, or
                // paid from the 💳 link, which has nobody polling verifyPayment for them).
                try { settleNamedOrders(72).then((r) => { if (r.paid) console.log('[settle]', JSON.stringify(r)); }).catch((e) => console.log('[settle] sweep failed:', e.message)); } catch (_) {}
                // …and re-check "I've paid" claims, for money paid to the plain backup QR (payment fallback).
                try { require('./paymatch').sweep().catch((e) => console.log('[paymatch] sweep failed:', e.message)); } catch (_) {}
              }
            } while (scanAgain && _watching);
          } catch (e) {
            console.log('[imap] event scan failed:', e.message);
          } finally { scanning = false; }
        };
        const onExists = () => { queueScan(); };
        client.on('exists', onExists);
        const safetyScan = setInterval(() => {
          if (!_watching) return;
          queueScan();
          // Belt and braces: a credit already in the table that nothing has claimed yet (a mail event missed, or
          // the app restarted between the alert arriving and anybody looking at the order).
          settleNamedOrders(72).then((r) => { if (r.paid) console.log('[settle]', JSON.stringify(r)); }).catch((e) => console.log('[settle] sweep failed:', e.message));
        }, 60000);

        try {
          await new Promise((resolve, reject) => {
            client.once('close', () => { _imap.connected = false; resolve(); });
            client.once('error', reject);
          });
        } finally {
          clearInterval(safetyScan);
          client.off('exists', onExists);
        }
      } catch (e) {
        console.log('[imap] error, reconnecting in 15s:', e.message);
        Object.assign(_imap, { connected: false, lastError: String(e && e.message || e).slice(0, 160) });
        try { if (client) await client.logout(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  })();
}

module.exports = { parseEquitasCredit, ingestCredit, findByOrder, findByRef, settleOne, settleCreditOrder, settleNamedOrders, startWatcher, manualScan, status, _internal: { fromBank, searchFrom, searchQuery, scanInbox, logSkipped, BANK_DOMAIN, REF_WINDOW_MIN } };
