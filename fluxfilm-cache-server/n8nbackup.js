/**
 * FluxFilm - 🔐 encrypted database backup for n8n → Google Drive (GET /n8n/api/backup, mounted by n8n.js).
 *
 * File (fluxfilm-backup-YYYY-MM-DD.ffbak, India date):
 *   line 1  header JSON + "\n"  { format, version, createdAt, tables: { name: rows }, excluded, cipher: { alg, kdf, N, r, p, salt, iv } }
 *   then    AES-256-GCM( gzip( NDJSON ) ) followed by the 16-byte GCM tag. The header line is the GCM "additional data",
 *           so changing the header breaks decryption too.
 *   NDJSON  {"t":"<table>","r":{row}} per row … and a last line {"end":true,"rows":{name: n}} (a cut-off download is
 *           detected: no end line / wrong tag).
 *   Binary columns become {"$b64":"…"}.
 *
 * Key: scrypt(passphrase, salt) — worked out once when the owner saves the passphrase (admin → 🔗 Integrations), and
 * only the derived key + salt are stored (app_settings n8n_secrets). The passphrase itself is not kept on the server.
 * No passphrase set → refused. scripts/restore-backup.js decrypts a file locally (not a route).
 *
 * Tables are read in pages of 500 (ordered by primary key), written straight into the gzip → cipher → HTTP stream with
 * back-pressure, never all in memory. The gzip is flushed after every page so bytes keep flowing through Hostinger's
 * proxy. Missing tables (a schema file not run) are skipped and listed in the header.
 * Excluded: feed_video_chunks bytes (only video_id, n, size), app_settings login / code / session keys (gotp_, sess_,
 * csess_, emlk_, rcv_) and n8n_secrets. Inventory passwords ARE included (needed to restore) — that is why it is encrypted.
 * ?table=<name> = the same format with one table (for n8n to loop if the full file ever gets too slow).
 */
const crypto = require('crypto');
const zlib = require('zlib');
const { Transform, pipeline } = require('stream');
const db = require('./db');

const TABLES = [
  'customers', 'orders', 'subscriptions', 'plans', 'coupons', 'coupon_usage', 'wallet', 'coins_ledger', 'coin_spends',
  'inventory_accounts', 'inventory_profiles', 'inventory_capacity', 'bank_credits', 'payment_claims', 'customer_payer_names',
  'app_settings', 'refund_offers', 'refund_requests',
  'feed_comments', 'feed_bans', 'feed_likes', 'feed_saves', 'feed_videos', 'feed_video_chunks',
  'referral_codes', 'referrals', 'referral_rewards', 'restock_requests', 'trending_items',
  'push_subscriptions', 'reminder_log', 'audit_log', 'account_costs', 'admin_todos', 'customer_photos',
  'game_plays', 'quiz_questions', 'olivia_conversations', 'olivia_messages', 'sms_otp_log', 'sync_log',
];
const SETTINGS_EXCLUDE_LIKE = ['gotp\\_%', 'sess\\_%', 'csess\\_%', 'emlk\\_%', 'rcv\\_%', 'n8n\\_secrets'];
const PAGE = 500;
const KDF = { N: 16384, r: 8, p: 1 };
const FORMAT = 'fluxfilm-backup';
const VERSION = 1;

const s = (v) => String(v == null ? '' : v).trim();
const missingTable = (e) => /doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, Object.assign({ maxmem: 64 * 1024 * 1024 }, KDF));
}
/** Saves the derived key (never the passphrase). */
async function setPassphrase(passphrase) {
  const p = String(passphrase == null ? '' : passphrase);
  if (p.length < 12) return { ok: false, message: 'Use at least 12 characters (a short sentence is easy to remember).' };
  if (p.length > 200) return { ok: false, message: 'Too long (max 200 characters).' };
  const n8n = require('./n8n');
  const salt = crypto.randomBytes(16);
  const key = deriveKey(p, salt);
  const sec = await n8n.getSecrets();
  sec.backup = { salt: salt.toString('base64'), key: key.toString('base64'), kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, setAt: new Date().toISOString(), check: crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) };
  await n8n.saveSecrets(sec);
  return { ok: true, setAt: sec.backup.setAt, check: sec.backup.check };
}
async function clearPassphrase() { const n8n = require('./n8n'); const sec = await n8n.getSecrets(); const had = !!sec.backup; delete sec.backup; await n8n.saveSecrets(sec); return { ok: true, cleared: had }; }
async function passphraseInfo() { const sec = await require('./n8n').getSecrets(); return sec.backup ? { set: true, setAt: sec.backup.setAt, check: sec.backup.check } : { set: false }; }

function whereFor(table) {
  if (table !== 'app_settings') return { where: '', params: [] };
  return { where: ' WHERE ' + SETTINGS_EXCLUDE_LIKE.map(() => 'setting_key NOT LIKE ?').join(' AND '), params: SETTINGS_EXCLUDE_LIKE.slice() };
}
function selectCols(table) { return table === 'feed_video_chunks' ? 'video_id, n, LENGTH(data) AS size_bytes' : '*'; }

async function countRows(table) {
  const w = whereFor(table);
  const r = await db.query('SELECT COUNT(*) AS n FROM `' + table + '`' + w.where, w.params);
  return Number((r[0] || {}).n) || 0;
}
async function primaryKey(table) {
  if (table === 'feed_video_chunks') return ['video_id', 'n'];
  try {
    const rows = await db.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [table]);
    return rows.map((r) => s(r.c || r.COLUMN_NAME)).filter((c) => /^[A-Za-z0-9_]+$/.test(c));
  } catch (_) { return []; }
}

async function tableList(only) {
  const names = only ? [only] : TABLES;
  const tables = []; const missing = [];
  for (const t of names) {
    try { tables.push({ name: t, rows: await countRows(t) }); } catch (e) { if (missingTable(e)) missing.push(t); else throw e; }
  }
  const info = await passphraseInfo();
  return { ok: true, passphraseSet: info.set, tables, missing, totalRows: tables.reduce((a, x) => a + x.rows, 0) };
}

function istDate(ms) { return new Date((ms == null ? Date.now() : ms) + 5.5 * 3600e3).toISOString().slice(0, 10); }

/** Checks + counts before any byte is sent (so a refusal is a clean JSON error). */
async function prepare(opts) {
  const o = opts || {};
  const table = s(o.table);
  if (table && !TABLES.includes(table)) return { ok: false, status: 400, message: 'Unknown table. See GET /n8n/api/backup/tables.' };
  const sec = await require('./n8n').getSecrets();
  if (!sec.backup || !sec.backup.key) return { ok: false, status: 409, message: 'No backup passphrase is set. Set one in admin → 🔗 Integrations first (backups are always encrypted).' };
  const list = await tableList(table || null);
  const now = o.now || Date.now();
  const iv = crypto.randomBytes(12);
  const header = {
    format: FORMAT, version: VERSION, createdAt: new Date(now).toISOString(), createdAtIst: new Date(now + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    scope: table ? 'table' : 'full', tables: Object.fromEntries(list.tables.map((x) => [x.name, x.rows])), missingTables: list.missing,
    excluded: { app_settings: SETTINGS_EXCLUDE_LIKE.map((x) => x.replace(/\\_/g, '_')), feed_video_chunks: 'video bytes (only video_id, n, size_bytes)' },
    cipher: { alg: 'aes-256-gcm', kdf: 'scrypt', N: sec.backup.N || KDF.N, r: sec.backup.r || KDF.r, p: sec.backup.p || KDF.p, salt: sec.backup.salt, iv: iv.toString('base64'), tagBytes: 16, check: sec.backup.check },
    note: 'Encrypted. Open with: node scripts/restore-backup.js <file> <out-folder> (asks for the backup passphrase).',
  };
  try { header.app = require('./appversion').version(); } catch (_) {}
  return {
    ok: true, header, key: Buffer.from(sec.backup.key, 'base64'), iv, tables: list.tables.map((x) => x.name), totalRows: list.totalRows,
    filename: 'fluxfilm-backup-' + istDate(now) + (table ? '-' + table : '') + '.ffbak',
  };
}

function encodeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v instanceof Date ? v.toISOString() : v;
  return out;
}

/** Streams the prepared backup into `out` (an HTTP response or any writable). Resolves { rows, bytes }. */
function stream(prep, out) {
  return new Promise((resolve, reject) => {
    const headerLine = Buffer.from(JSON.stringify(prep.header) + '\n', 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', prep.key, prep.iv);
    cipher.setAAD(headerLine);
    let bytes = headerLine.length;
    const enc = new Transform({
      transform(chunk, _e, cb) { const b = cipher.update(chunk); bytes += b.length; cb(null, b); },
      flush(cb) { const f = cipher.final(); const tag = cipher.getAuthTag(); bytes += f.length + tag.length; this.push(f); cb(null, tag); },
    });
    const gz = zlib.createGzip({ level: 6 });
    out.write(headerLine);
    let failed = null;
    pipeline(gz, enc, out, (err) => { if (err || failed) reject(err || failed); else resolve({ rows: written, bytes }); });
    let written = 0;
    const counts = {};
    const put = (line) => (gz.write(line) ? Promise.resolve() : new Promise((r) => gz.once('drain', r)));
    const flush = () => new Promise((r) => gz.flush(zlib.constants.Z_SYNC_FLUSH, r));
    (async () => {
      for (const t of prep.tables) {
        counts[t] = 0;
        const pk = await primaryKey(t);
        const w = whereFor(t);
        const order = pk.length ? ' ORDER BY ' + pk.map((c) => '`' + c + '`').join(', ') : '';
        for (let off = 0; ; off += PAGE) {
          let rows;
          try { rows = await db.query('SELECT ' + selectCols(t) + ' FROM `' + t + '`' + w.where + order + ' LIMIT ' + PAGE + ' OFFSET ' + off, w.params); }
          catch (e) { if (missingTable(e)) break; throw e; }
          for (const r of rows) { await put(JSON.stringify({ t, r: encodeRow(r) }) + '\n'); counts[t]++; written++; }
          await flush();
          if (rows.length < PAGE) break;
        }
      }
      await put(JSON.stringify({ end: true, rows: counts, total: written }) + '\n');
      gz.end();
    })().catch((e) => { failed = e; gz.destroy(e); });
  });
}

module.exports = { TABLES, SETTINGS_EXCLUDE_LIKE, KDF, FORMAT, VERSION, deriveKey, setPassphrase, clearPassphrase, passphraseInfo, tableList, prepare, stream, _internal: { whereFor, encodeRow, primaryKey } };
