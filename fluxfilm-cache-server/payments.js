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
                // New bank money: re-check "I've paid" claims right away (payment fallback).
                try { require('./paymatch').sweep().catch((e) => console.log('[paymatch] sweep failed:', e.message)); } catch (_) {}
              }
            } while (scanAgain && _watching);
          } catch (e) {
            console.log('[imap] event scan failed:', e.message);
          } finally { scanning = false; }
        };
        const onExists = () => { queueScan(); };
        client.on('exists', onExists);
        const safetyScan = setInterval(() => { if (_watching) queueScan(); }, 60000);

        try {
          await new Promise((resolve, reject) => {
            client.once('close', resolve);
            client.once('error', reject);
          });
        } finally {
          clearInterval(safetyScan);
          client.off('exists', onExists);
        }
      } catch (e) {
        console.log('[imap] error, reconnecting in 15s:', e.message);
        try { if (client) await client.logout(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  })();
}

module.exports = { parseEquitasCredit, ingestCredit, findByOrder, findByRef, startWatcher, manualScan, _internal: { fromBank, searchFrom, searchQuery, scanInbox, logSkipped, BANK_DOMAIN, REF_WINDOW_MIN } };
