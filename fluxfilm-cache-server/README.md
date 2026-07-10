# FluxFilm Cache Server

A tiny Node.js service that sits **in front of** FluxFilm's `api.php` so read-only
calls (plans, stock, trending) are served instantly from memory. Orders, payments,
OTP, and admin calls are passed straight through and never cached.

```
index.html  ->  THIS cache server  ->  api.php  ->  Apps Script  ->  Google Sheets
```

If the upstream ever errors, cached routes fall back to the last good copy and
everything else returns the real error — so this layer can't break what's live.

## Environment variables

Set these in Hostinger (or a local `.env`, copied from `.env.example`):

| Variable          | Example                          | What it is                              |
|-------------------|----------------------------------|-----------------------------------------|
| `PORT`            | `8080`                           | Port the server listens on              |
| `API_PHP_URL`     | `https://YOURDOMAIN/api.php`      | Your existing api.php URL               |
| `API_KEY`         | `your-shared-secret`             | Must match config.php `API_KEY`         |
| `CACHE_TTL`       | `60`                             | Cache lifetime in seconds               |
| `CACHE_CLEAR_KEY` | `your-clear-key`                 | Key to flush the cache                  |

## Run locally

```bash
cp .env.example .env      # then edit .env
npm install
npm start
curl http://localhost:8080/health
```

## Endpoints

| Method | Path                  | Purpose                            |
|--------|-----------------------|------------------------------------|
| POST   | `/api`                | Main proxy (frontend posts here)   |
| GET    | `/health`             | Health check + cached keys         |
| GET    | `/clearcache?key=...` | Flush the in-memory cache          |

## Deploy on Hostinger (Node app)

1. hPanel → **Websites/Node.js app** → **Import from GitHub** → pick this repo.
2. Set the **environment variables** above in Hostinger's UI.
3. Start command: `npm start` (entry `server.js`).
4. Open the app URL + `/health` to confirm it's running.
5. Only when verified, point the frontend's API base at this app's `/api` URL.
