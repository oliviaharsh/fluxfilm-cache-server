/**
 * FluxFilm - Node app (frontend + caching layer)
 * ------------------------------------------------
 * Serves the storefront AND sits in front of api.php:
 *
 *   browser -> THIS app (serves site + /api cache) -> api.php -> Apps Script -> Sheets
 *
 * - Static site is served from ./public (index.html). The frontend calls the
 *   same-origin "/api" endpoint below.
 * - Read-only actions (getBootstrap, getStockLevels, getTrendingItems) are cached
 *   in memory so the site feels instant. Everything else (orders, payments, OTP,
 *   admin...) is passed straight through untouched - never cached.
 *
 * Safe by design: if anything goes wrong, requests still fall through to api.php.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// -- Config (from .env) --
const PORT = process.env.PORT || 8080;
const API_PHP_URL = process.env.API_PHP_URL || 'https://go.fluxfilm.in/api.php';
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL = Number(process.env.CACHE_TTL || 60);

// Only these read-only actions are cached.
const CACHEABLE = new Set(['getBootstrap', 'getStockLevels', 'getTrendingItems']);

// -- Simple in-memory cache: action -> { body, expires } --
const cache = new Map();
const now = () => Date.now();

async function callApiPhp(payload) {
  const res = await fetch(API_PHP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': API_KEY },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fluxfilm-cache', cachedKeys: [...cache.keys()] });
});

// Manual cache clear: GET /clearcache?key=YOUR_CACHE_CLEAR_KEY
app.get('/clearcache', (req, res) => {
  if (req.query.key !== process.env.CACHE_CLEAR_KEY) {
    return res.status(403).json({ ok: false, message: 'Unauthorized' });
  }
  cache.clear();
  res.json({ ok: true, message: 'Cache cleared' });
});

// Main proxy endpoint - the frontend posts here instead of api.php
app.post('/api', async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || '');

  // Non-cacheable -> straight passthrough, never stored
  if (!CACHEABLE.has(action)) {
    try {
      const { status, text } = await callApiPhp(body);
      res.status(status).type('application/json').send(text);
    } catch (err) {
      res.status(502).json({ ok: false, message: 'Upstream error', detail: String(err) });
    }
    return;
  }

  // Cacheable -> serve fresh copy from memory if we have one
  const hit = cache.get(action);
  if (hit && hit.expires > now()) {
    res.set('X-Cache', 'HIT');
    return res.type('application/json').send(hit.body);
  }

  // Miss/expired -> fetch, store, serve. On error, fall back to stale copy if any.
  try {
    const { text } = await callApiPhp(body);
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      cache.set(action, { body: text, expires: now() + CACHE_TTL * 1000 });
    }
    res.set('X-Cache', 'MISS');
    res.type('application/json').send(text);
  } catch (err) {
    if (hit) {
      res.set('X-Cache', 'STALE');
      return res.type('application/json').send(hit.body);
    }
    res.status(502).json({ ok: false, message: 'Upstream error', detail: String(err) });
  }
});

// -- Serve the storefront (static files from ./public) --
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: any non-API GET returns the app shell
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('FluxFilm app on :' + PORT + ' - serving ./public, proxying /api -> ' + API_PHP_URL + ' (TTL ' + CACHE_TTL + 's)');
});
