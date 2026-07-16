/**
 * FluxFilm - payment verification (Wave 2, Path B).
 * A background IMAP watcher reads the bank inbox, parses Equitas UPI credit
 * alerts, and saves each credit into `bank_credits`. verifyPayment then matches
 * against that table by OrderID (auto note) or by UPI ref (customer-entered).
 *
 * Env: IMAP_USER, IMAP_PASS (Gmail app password), IMAP_HOST (default imap.gmail.com),
 *      BANK_SENDER (default esfb-alerts@equitas.bank.in)
 */
const db = require('./db');

// ---- parse one Equitas "UPI Credit Alert" body ----
function parseEquitasCredit(body) {
  const text = String(body || '').replace(/\s+/g, ' ');
  const m = text.match(/An amount of INR\s+([\d,]+(?:\.\d+)?)\s+has been credited/i);
  if (!m) return null; // not a credit alert
  const amount = parseFloat(m[1].replace(/,/g, ''));
  const refM = text.match(/UPI REF NO\s+(\d+)/i);
  const upiRef = refM ? refM[1] : '';
  const orderIds = (text.match(/\bFF\d{6,}\b/gi) || []).map((x) => x.toUpperCase());
  if (!upiRef) return null; // need a ref to dedupe
  return { type: 'CREDIT', amount, upiRef, orderIds, raw: text.slice(0, 380) };
}

// ---- store a credit (dedupe by upi_ref) ----
async function ingestCredit(c, receivedAt) {
  if (!c || !c.upiRef) return false;
  await db.query(
    'INSERT IGNORE INTO bank_credits (upi_ref, amount, order_ids, raw, received_at) VALUES (?,?,?,?,?)',
    [c.upiRef, c.amount, (c.orderIds || []).join(','), c.raw || '', receivedAt || new Date()]);
  return true;
}

// ---- match + atomically consume a credit (so it can verify only ONE order) ----
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
  const r = await db.query(
    `UPDATE bank_credits SET consumed_order_id = ?
     WHERE consumed_order_id IS NULL AND upi_ref = ? AND ROUND(amount) = ROUND(?) LIMIT 1`,
    [oid, cleanRef, amount]);
  if (r && r.affectedRows > 0) {
    const rows = await db.query('SELECT * FROM bank_credits WHERE upi_ref = ? LIMIT 1', [cleanRef]);
    return rows[0] || { ok: true };
  }
  return null;
}

// ---- IMAP watcher (imapflow + mailparser) ----
let _watching = false;
async function startWatcher() {
  const user = process.env.IMAP_USER, pass = process.env.IMAP_PASS;
  if (!user || !pass) { console.log('[imap] IMAP_USER/IMAP_PASS not set — watcher disabled'); return; }
  if (_watching) return; _watching = true;

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const host = process.env.IMAP_HOST || 'imap.gmail.com';
  const sender = process.env.BANK_SENDER || 'esfb-alerts@equitas.bank.in';

  async function scan(client) {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 2 * 60 * 60 * 1000); // last 2h
      const uids = await client.search({ from: sender, since });
      if (!uids || !uids.length) return;
      for await (const msg of client.fetch(uids.slice(-40), { source: true, envelope: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const c = parseEquitasCredit(parsed.text || parsed.html || '');
          if (c) await ingestCredit(c, (msg.envelope && msg.envelope.date) || new Date());
        } catch (_) {}
      }
    } finally { lock.release(); }
  }

  (async function loop() {
    while (_watching) {
      let client;
      try {
        client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false });
        await client.connect();
        console.log('[imap] connected, watching', sender);
        await scan(client);                                   // catch-up on start
        while (_watching) {
          await client.idle();                                // wakes on new mail
          await scan(client);
        }
      } catch (e) {
        console.log('[imap] error, reconnecting in 15s:', e.message);
        try { if (client) await client.logout(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  })();
}

module.exports = { parseEquitasCredit, ingestCredit, findByOrder, findByRef, startWatcher };
