# FluxFilm Node/MySQL Storefront

The staging storefront and API for `shop.fluxfilm.in`. Customer reads, orders,
payments, fulfillment, coupons, recovery, OTP tools, and admin writes use MySQL/Node.

```
index.html  ->  THIS Node app  ->  MySQL
```

The storefront is fail-closed: there is no Apps Script fallback. If MySQL fails,
the API returns an error and nothing is written to the legacy Google Sheet.
`/admin/sync` is the sole intentional legacy contact; it reads Sheet data for a
protected, deliberate final import before cutover. Automatic sync stays disabled.

## Environment variables

Set these in Hostinger (or a local `.env`, copied from `.env.example`):

| Variable          | Example                          | What it is                              |
|-------------------|----------------------------------|-----------------------------------------|
| `PORT`            | `8080`                           | Port the server listens on              |
| `DB_HOST`         | `127.0.0.1`                      | MySQL host (`localhost` can fail grants) |
| `DB_PORT`         | `3306`                           | MySQL port                              |
| `DB_NAME`         | `your-database`                  | MySQL database                          |
| `DB_USER`         | `your-user`                      | MySQL user                              |
| `DB_PASS`         | `your-password`                  | MySQL password                          |
| `CACHE_CLEAR_KEY` | `your-admin-key`                 | Admin and manual-sync key               |
| `API_PHP_URL`     | `https://YOURDOMAIN/api.php`     | Legacy source for manual import only    |
| `API_KEY`         | `your-shared-secret`             | Legacy import authentication only       |
| `SYNC_INTERVAL_MIN` | `0`                            | Must remain 0 (no automatic import)     |

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
| POST   | `/api`                | MySQL-only storefront API          |
| GET    | `/health`             | Health and routing-mode check      |
| GET    | `/admin/sync?key=...` | Deliberate legacy-to-MySQL import  |

## Deploy on Hostinger (Node app)

1. hPanel → **Websites/Node.js app** → **Import from GitHub** → pick this repo.
2. Set the **environment variables** above in Hostinger's UI.
3. Start command: `npm start` (entry `server.js`).
4. Open the app URL + `/health` to confirm it's running.
5. Confirm `/health` reports `storefrontMode: mysql-only` and `appsScriptProxy: false`.
