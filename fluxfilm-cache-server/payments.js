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
  const r = await db.query(
    `UPDATE bank_credits SET consumed_order_id = ?
     WHERE consumed_order_id IS NULL AND upi_ref = ? AND ROUND(amount) = ROUND(?)
       AND (COALESCE(order_ids, '') = '' OR FIND_IN_SET(?, order_ids) > 0)
       AND received_at >= (SELECT DATE_SUB(o.created_at_sheet, INTERVAL ? MINUTE) FROM orders o WHERE o.order_id = ? LIMIT 1)
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

function fromBank(parsed) {
  const want = String(SENDER()).trim().toLowerCase();
  const list = (parsed && parsed.from && parsed.from.value) || [];
  return list.length === 1 && String(list[0].address || '').trim().toLowerCase() === want;
}

async function scanInbox(client, hours) {
  const { simpleParser } = require('mailparser');
  const lock = await client.getMailboxLock(FOLDER());
  let found = 0, ingested = 0;
  try {
    const since = new Date(Date.now() - (hours || 6) * 3600 * 1000);
    const uids = await client.search({ from: SENDER(), since });
    if (uids && uids.length) {
      for await (const msg of client.fetch(uids.slice(-60), { source: true, envelope: true, internalDate: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          // IMAP "from" search is a substring match (display names, look-alike domains), so check the real
          // sender address exactly before trusting a "credited" email.
          if (!fromBank(parsed)) { console.log('[imap] skipped a credit-like mail not from', SENDER()); continue; }
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

module.exports = { parseEquitasCredit, ingestCredit, findByOrder, findByRef, startWatcher, manualScan, _internal: { fromBank, REF_WINDOW_MIN } };
