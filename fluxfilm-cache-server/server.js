/**
 * FluxFilm - Node app (frontend + caching layer)
 *   browser -> THIS app (serves site + /api cache) -> api.php -> Apps Script -> Sheets
 *
 * Robust: finds index.html wherever it landed in the deploy, and exposes a
 * /__debug page showing the real file layout on the server.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// -- Config --
const PORT = process.env.PORT || 8080;
const API_PHP_URL = process.env.API_PHP_URL || 'https://go.fluxfilm.in/api.php';
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL = Number(process.env.CACHE_TTL || 60);
const CACHEABLE = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems']);

// -- Locate index.html no matter where the deploy put it --
const CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'public', 'index.html'),
  path.join(process.cwd(), 'index.html'),
  path.join(__dirname, 'fluxfilm-cache-server', 'public', 'index.html'),
];
function recursiveFind(dir, name, depth) {
  if (depth < 0) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const found = recursiveFind(path.join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}
function findIndex() {
  for (const p of CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return recursiveFind(__dirname, 'index.html', 3) || recursiveFind(process.cwd(), 'index.html', 3);
}
const INDEX = findIndex();
const STATIC_DIR = INDEX ? path.dirname(INDEX) : path.join(__dirname, 'public');
console.log('[FluxFilm] index.html =', INDEX || 'NOT FOUND', '| static dir =', STATIC_DIR);

// -- API helpers --
const cache = new Map();
const now = () => Date.now();
async function callApiPhp(payload) {
  const res = await fetch(API_PHP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': API_KEY },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fluxfilm-cache', indexFound: !!INDEX, cachedKeys: [...cache.keys()] });
});

// Diagnostic page — safe to remove later
app.get('/__debug', (_req, res) => {
  const info = { __dirname, cwd: process.cwd(), indexResolved: INDEX, staticDir: STATIC_DIR, listings: {} };
  for (const d of [__dirname, process.cwd(), path.join(__dirname, 'public')]) {
    try { info.listings[d] = fs.readdirSync(d); } catch (e) { info.listings[d] = 'ERR: ' + e.message; }
  }
  res.type('application/json').send(JSON.stringify(info, null, 2));
});

app.get('/clearcache', (req, res) => {
  if (req.query.key !== process.env.CACHE_CLEAR_KEY) return res.status(403).json({ ok: false, message: 'Unauthorized' });
  cache.clear();
  res.json({ ok: true, message: 'Cache cleared' });
});

app.post('/api', async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || '');
  if (!CACHEABLE.has(action)) {
    try { const { status, text } = await callApiPhp(body); res.status(status).type('application/json').send(text); }
    catch (err) { res.status(502).json({ ok: false, message: 'Upstream error', detail: String(err) }); }
    return;
  }
  const hit = cache.get(action);
  if (hit && hit.expires > now()) { res.set('X-Cache', 'HIT'); return res.type('application/json').send(hit.body); }
  try {
    const { text } = await callApiPhp(body);
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) cache.set(action, { body: text, expires: now() + CACHE_TTL * 1000 });
    res.set('X-Cache', 'MISS'); res.type('application/json').send(text);
  } catch (err) {
    if (hit) { res.set('X-Cache', 'STALE'); return res.type('application/json').send(hit.body); }
    res.status(502).json({ ok: false, message: 'Upstream error', detail: String(err) });
  }
});

// -- Serve the storefront (single self-contained index.html) --
app.get('*', (_req, res) => {
  if (INDEX) return res.sendFile(INDEX);
  res.status(404).type('text/plain').send('index.html not found. Open /__debug to see the server file layout.');
});

app.listen(PORT, () => console.log('[FluxFilm] listening on :' + PORT + ' -> ' + API_PHP_URL));
