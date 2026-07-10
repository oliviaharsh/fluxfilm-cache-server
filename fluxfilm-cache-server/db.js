/**
 * FluxFilm - MySQL connection pool.
 * Reads config from env vars. If DB env vars are missing, db is "disabled"
 * and callers should fall back to Apps Script (so nothing breaks pre-migration).
 */
const mysql = require('mysql2/promise');

const cfg = {
  host: process.env.DB_HOST || '',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || '',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',
};

const ENABLED = !!(cfg.host && cfg.user && cfg.database);

let pool = null;
function getPool() {
  if (!ENABLED) return null;
  if (!pool) {
    pool = mysql.createPool({
      ...cfg,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      // keep numbers/dates predictable
      dateStrings: true,
    });
  }
  return pool;
}

async function query(sql, params) {
  const p = getPool();
  if (!p) throw new Error('DB not configured');
  const [rows] = await p.execute(sql, params || []);
  return rows;
}

async function ping() {
  if (!ENABLED) return { ok: false, reason: 'DB env vars not set' };
  try {
    const rows = await query('SELECT 1 AS ok');
    return { ok: rows && rows[0] && rows[0].ok === 1 };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

module.exports = { ENABLED, getPool, query, ping, cfg };
