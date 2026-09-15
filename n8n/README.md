# FluxFilm + n8n — setup guide (simple steps)

Your own n8n does 5 jobs for the shop. **Nothing runs until you import a workflow and switch it on.**
The shop never sends these messages by itself.

| File | What it does | Runs |
|---|---|---|
| `01-expiry-reminders.json` | Emails customers whose plan ends in 3 days, today, or ended 1–2 days ago. Never twice. | Every day 10:00 |
| `02-winback.json` | Emails customers who left 15 and 30 days ago with a personal coupon. | Every day 11:00 |
| `03-daily-backup.json` | Encrypted backup of the whole database → Google Drive folder "FluxFilm Backups", keeps 30 days. Emails you if it fails. | Every day 02:30 |
| `04-uptime-deploy-watch.json` | (a) Alerts you if the shop is down, slow (over 5 s) or the database is down, and again when it is back. (b) After every GitHub push to `main`, checks that Hostinger really deployed it. | Every 5 min + on push |
| `05-social-autopost.json` | When a What's new post goes live, posts it to your Telegram channel (Instagram / Facebook ready but switched off). | When you publish |

All times are India time (each workflow has timezone `Asia/Kolkata`).

---

## Step 1 — Make the n8n key in the admin panel

1. Open `https://shop.fluxfilm.in/panel` → menu **DATA → 🔗 Integrations**.
2. **🔑 n8n API key → ✨ Create key.** Copy it now — it is shown **only once**.
   - It is not the admin password. The shop stores only a hash of it.
   - Lost it or shared it by mistake? Press **🔄 Rotate key** (the old one stops at once) and update n8n.
   - "Last used" shows when n8n last called the shop.
3. **🔐 Backup passphrase:** type a long sentence you will remember (12+ characters) → **Set passphrase**.
   **Write it down on paper / in your password manager.** Without it a backup can never be opened. The shop does not keep the passphrase itself.

## Step 2 — Add credentials in n8n

In n8n → **Credentials → Add credential**. Use exactly these names (the workflows look for them):

| Name in n8n | Type | What to fill in |
|---|---|---|
| `FluxFilm n8n key` | **Header Auth** | Name: `X-N8N-Key` · Value: the key from Step 1 |
| `SMTP FluxFilm (Gmail app password)` | **SMTP** | Host `smtp.gmail.com`, port `465`, SSL on, user = your Gmail, password = a Gmail **app password** (Google Account → Security → 2-Step Verification → App passwords). You can use the support@ mailbox SMTP instead. |
| `Google Drive FluxFilm` | **Google Drive OAuth2 API** | Click "Sign in with Google" (n8n Cloud does the rest). |
| `Telegram FluxFilm bot` | **Telegram API** | Talk to **@BotFather** → `/newbot` → copy the token. For a channel, add the bot as an **admin** of the channel. |
| `GitHub FluxFilm` | **GitHub API** | A GitHub token (Settings → Developer settings → Fine-grained token) for `oliviaharsh/fluxfilm-cache-server` with **Contents: read** and **Webhooks: read & write**. |
| `Meta Graph token (access_token)` | **Query Auth** (only for Instagram / Facebook later) | Name: `access_token` · Value: the long-lived token (see the Instagram part below). |

Never paste keys or tokens straight into a workflow node — always use a credential.

## Step 3 — Import, test, switch on

For each file in this folder:

1. n8n → **Workflows → Add workflow → ⋯ → Import from file** → choose the `.json`.
2. Read the yellow **SETUP** note on the canvas.
3. Open every node with a red warning and pick the credential with the matching name.
4. Replace the `REPLACE_...` texts (your email, your Telegram chat id / channel, the Drive folder id).
5. Click **Execute workflow** and look at the result of each node.
   - Workflows 01 and 02 send **real emails to real customers** and 02 makes **real coupons**. For a safe first test, temporarily change the *To* of the Send Email node to your own address.
6. When it looks right: switch **Active** on (top right).

The files are imported with `"active": false`, so nothing starts by itself.

## Step 4 — Webhooks (needed for the social post workflow)

1. Import `05-social-autopost.json`, open **Webhook: post.published**, copy the **Production URL**,
   e.g. `https://you.app.n8n.cloud/webhook/fluxfilm/post-published`.
2. In admin → 🔗 Integrations → **📡 Webhooks to n8n** paste it **without** the last part:
   `https://you.app.n8n.cloud/webhook/fluxfilm` → **Save webhooks**.
3. Press **✨ Create signing secret**, copy it (shown once) and paste it into the n8n node **Expected signature → Secret**.
4. Switch the workflow **Active**, then press **📡 Send test webhook** in admin. The table "Last 20 deliveries" shows the result (the test goes to `…/test-ping`; a 404 there is fine if you have no test-ping workflow — it proves the shop can reach n8n).

What the shop sends (each can be switched off in admin):

| Event | Address | When | Data |
|---|---|---|---|
| `order.paid` | `…/order-paid` | Once per order, a few seconds after it becomes paid | orderId, service, plan, amount, NEW/RENEWAL, first name |
| `order.delivered` | `…/order-delivered` | Once per order, when the login is delivered | same + deliveredAt |
| `subscription.expired` | `…/subscription-expired` | 00:05 every night, plans that ended yesterday | subId, service, plan, expiredOn, first name, renew link |
| `post.published` | `…/post-published` | A What's new post goes live | title, caption, genres, picture link, "from ₹X", share link |

Every call has `X-FF-Signature: sha256=<HMAC of the body with your secret>`, `X-FF-Timestamp` and a unique `eventId`.
No phone numbers or emails are put in webhooks. Failed calls are retried 3 times (5 s, 30 s, 2 min).

## Backups — how to open / restore one

- Files are called `fluxfilm-backup-2026-09-17.ffbak`. They are **encrypted** (AES-256-GCM, key made from your passphrase with scrypt), because they contain customer details and account passwords (needed to restore).
- Not included: login codes / sessions, the n8n secrets, and uploaded video bytes (video ids only).
- **Size today:** about 300 customers, 1,200 orders, 650 subscriptions → roughly **1–3 MB** per file. 30 files ≈ 100 MB of Drive space.
- To open one on your computer (needs Node.js, no install):

```
node scripts/restore-backup.js fluxfilm-backup-2026-09-17.ffbak my-backup
```

  It asks for the passphrase, checks the whole file (a wrong passphrase or a half-downloaded file is reported), and writes one JSON file per table into `my-backup/`. To put data back into MySQL, import the table you need in phpMyAdmin (or ask for a restore script for those tables).
- If the database ever gets so big that one download is too slow for Hostinger: call `GET /n8n/api/backup/tables` to get the table list, then loop `GET /n8n/api/backup?table=<name>` (same file format, one table per file).

## WhatsApp — later

Right now reminders and win-back go by **email** (Telegram is optional). The WhatsApp nodes are in the files but **switched off**. Before you switch them on, know this:

- The **WhatsApp Cloud API** normally needs a number that is **not** being used in the WhatsApp Business app. Moving your current number to the API usually means you can no longer use it in the Business app on your phone.
- Meta now has a **"coexistence"** onboarding (through some approved providers / Tech Providers) that can keep the WhatsApp Business app working on the same number while the API sends messages. Rules and limits change — **ask the provider** before moving your main number.
- The safest choice: use a **second number** only for automatic messages, keep your main number in the Business app.
- Messages outside a 24-hour chat window must use **approved templates** (e.g. `renewal_reminder` with name / service / date / link). Marketing templates (win-back) cost money per message and need the customer's opt-in.
- When ready: add the credential **WhatsApp Cloud API (later)**, set the Phone Number ID and template name in the node, then enable the WhatsApp node **and** the "Tell shop: WhatsApp sent" node together.

**WhatsApp Channels have no API** — post there by hand.

## Instagram / Facebook auto-post — later

1. Your Instagram must be a **Business or Creator** account, linked to a **Facebook Page** (Instagram app → Settings → Account type; Page → Settings → Linked accounts).
2. Go to **developers.facebook.com → My Apps → Create app → Business**. Add the product **Instagram** (Instagram API with Facebook Login).
3. Best token (does not expire): **business.facebook.com → Settings → Users → System users → Add** → give it the Page and the Instagram account → **Generate token** with `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
   (Other way: Graph API Explorer → user token with the same permissions → exchange it for a **long-lived** token (60 days) → remember to renew it.)
4. Find your Instagram user id: Graph API Explorer → `GET /me/accounts` (copy the Page id) → `GET /<page-id>?fields=instagram_business_account`.
5. In n8n add credential **Query Auth** named `Meta Graph token (access_token)`: name `access_token`, value = the token.
6. In workflow 05 replace `REPLACE_WITH_IG_USER_ID` / `REPLACE_WITH_PAGE_ID`, then enable **Instagram: create media**, **Wait 20 s**, **Instagram: publish** and (if you want) **Facebook Page: photo post**.
7. Instagram only accepts **JPEG** pictures from a public link. TMDB posters (`/poster/...`) are JPEG; uploaded WebP pictures will be refused by Instagram.

## Customers who don't want emails

Every reminder and win-back email has an **Unsubscribe** link → a small page with 2 buttons:
- **Stop offer emails** → no more win-back emails.
- **Stop offers AND renewal reminder emails** → the reminder list still shows the plan but without the email.
Order and login emails always still go out. Their choice is saved on the customer (`MarketingOptOut` / `ReminderEmailOptOut`).

## For developers — the shop API

Base `https://shop.fluxfilm.in`, header `X-N8N-Key` (a key in the URL is refused). Rate limited; every call is in the admin Change log.

| Call | Notes |
|---|---|
| `GET /n8n/api/expiring?when=before&days=3` | `when` = `before` (days 1–14) · `today` · `after` (ended 1..days ago, max 6). Optional `channel=email` + `unsent=1`. Items: subId, kind, firstName, service, plan, expiry, daysLeft, renewUrl (`/?source=push&renew=<subId>`), email, phone (+91…), lastReminderAt, unsubscribeUrl. Same skip rules as the renewal pop-up. |
| `POST /n8n/api/reminder-sent` | `{ subId, kind, channel }` — safe to call twice. |
| `GET /n8n/api/winback?afterDays=15` | Last plan ended 15–17 days ago (`windowDays`, default 3). Creates or returns a personal coupon. Items: name, email, phone, lastService/Plan, couponCode, couponExpiry, offer, shopUrl (`/?coupon=CODE`), buyUrl (`/?buy=<service>&coupon=CODE`), unsubscribeUrl. |
| `POST /n8n/api/winback-sent` | `{ phone, campaign }` — not listed again for 60 days. |
| `GET /n8n/api/posts/new?since=<iso>` | Live posts published since then. |
| `GET /n8n/api/health` | DB ping ms, IMAP watcher, last paid order, pending manual deliveries, last business summary, build fingerprint (sha256 of `server.js` / `index.html`, 12 chars), version, uptime. |
| `GET /n8n/api/backup` · `GET /n8n/api/backup/tables` · `GET /n8n/api/backup?table=` | Encrypted backup (see above). |
