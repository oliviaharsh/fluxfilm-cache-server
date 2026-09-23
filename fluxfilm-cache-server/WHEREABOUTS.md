# WHEREABOUTS — where everything lives

A map of the FluxFilm shop, so nobody has to read every file again to find one thing.
**Part 1 = the frontend** (a screen or a block → the file and the piece of code that draws it).
**Part 2 = the backend** (a job or a rule → the file that does it).

Written 21 Sep 2026 against `main`. **Names are the reliable thing; line numbers are only a hint** — if a number is
off, search for the name (`function FeedReels(`, `feedView`, …). Every server file starts with its own comment
block saying what it does — this map tells you *which* file to open; that header tells you the detail.

Sizes today: `index.html` 18,821 lines · `admin.html` 6,692 · `games.html` 1,068 · 102 server modules ≈ 31,400 lines ·
77 test files.

---

# PART 1 — FRONTEND

Three pages, no build step. Everything is plain JavaScript that runs as-is in the browser; React comes from a CDN.

| Page | File | Who sees it | URL |
|---|---|---|---|
| The shop | `index.html` | customers | `shop.fluxfilm.in` |
| Admin panel | `admin.html` | owner only | `/panel` |
| Games | `games.html` | customers | `/games` |
| Customer payment page | **server-drawn**, `paylink.js` | one customer, by link | `/pay/<orderId>?t=…` |
| Olivia chat window | `oliviawidget.js` | customers | injected into the shop |

> ⚠️ `index.html` and `admin.html` are **served as text** — a syntax error inside a `<script>` will not be caught by
> `node --check`. That is why the tests pull every inline `<script>` out and run `new Function()` on it. Never skip it.

## 1.1 `index.html` — the shop, top to bottom

| Lines | What is there |
|---|---|
| 1–36 | `<head>`: title + SEO tags (`seo.js` rewrites some of them per page), app icons, the manifest link, fonts |
| **37–962** | **All the CSS** (one `<style>`). Section comments inside mark each block — see the table below |
| 963–1059 | Small `<head>` scripts: low-end-phone flag (`html.ff-lite`), install prompt + service worker, 🔔 the bell / chime **sounds** (Web Audio, no files) |
| 1060–1192 | 😏 **Greeting lines** on My plans — `FF_GREETING_LINES`. *This is the block to edit for the cheeky one-liners*, plus the India-time date helpers and the festival list |
| 1196–1266 | ✨ **Splash** (ribbon intro, once per browser session) |
| 1269–1270 | React + ReactDOM from the CDN |
| **1271–18821** | The whole app: helpers → small building blocks → screens → `App` → the API client |
| 18529 | `ReactDOM.createRoot(...).render(App)` — the app starts here |
| 18531–18821 | `apiCall_()` and `API = { … }` — **every call the shop makes to the server** |

### The screens (what `nav('…')` switches between)

`App` (line ~17561) holds `screen` in state; `nav('x')` changes it.

| Screen | Component | ~Line | What it is |
|---|---|---|---|
| `home` | `HomeScreen` | 3603 | Landing: log in with phone, plan strip, What's-new strip |
| `dashboard` | `DashboardScreen` | 4195 | **My plans** — sub cards, greeting card, renew buttons, filter chips |
| `buy1` | `Buy1Screen` | 4779 | Pick the service (`ServiceTile`, 4841) |
| `buy2` | `Buy2Screen` | 5180 | Pick the plan (`PlanVariantPicker`, 5138) |
| `details` | `DetailsScreen` | 5648 | Name / email / devices (`DeviceSelect` 5597, `LoginModeSelect` 5629) |
| `review` | `ReviewScreen` | 6224 | Coupon, coins, the total |
| `pay` | `PayScreen` | 6308 | UPI QR + link, auto-check for the payment |
| `payhelp` | `PayHelpScreen` | 6834 | "Payment not going through" → backup QR → "I've paid" |
| `verify` | `VerifyScreen` | 7340 | Waiting for the payment to be seen |
| `done` | `DoneScreen` | 8689 | The login is shown and emailed |
| `recover` | `RecoverScreen` | 8863 | Recover access by email code |
| `account` | `AccountScreen` | 9724 | Profile, photo/avatar, coins, referrals, refunds, Get OTP |
| `feed` | `FeedScreen` | 15829 | 🍿 **What's new** — Feed and Reels tabs |
| (renewal) | `RenewStartScreen` | 7876 | Renew an existing plan |
| (group) | `GroupJoinScreen` | 5516 | Netflix household / group join step |
| (maintenance) | `MaintenanceScreen` | 11250 | Shown when the shop is paused |
| (restoring) | `RestoringScreen` | 16436 | Coming back after the app was swapped out |

### Blocks and widgets (the bits inside screens)

| Block | Where |
|---|---|
| Header bar, help button | `Topbar` 1929, `HelpButton` 1917 |
| Bottom menu (phone) | `BottomNav` 2631 |
| A plan card on My plans | `SubCard` 3961 |
| The login / password card | `CredCard` 2691, `DeviceLoginsCard` 2670 |
| Checkout step dots | `CheckoutSteps` 2020 |
| Coins toggle / wallet | `CoinToggle` 2455, `WalletPanel` 2514 |
| Refer & earn | `RefBanner` 2078, `ReferralPanel` 2295 |
| Coupons list | `CouponList` 10542 |
| Log in with email code | `EmailLoginSheet` 3015, `EmailLockSheet` 3162 |
| Recover picker sheet | `RecoverPickerModal` 3286 |
| Tools sheet (Get OTP etc.) | `ToolsSheet` 3445, `ToolsGrid` 3469 |
| Out of stock | `OutOfStockModal` 4914 |
| Avatar creator | `AvatarCreator` 9545 (drawing = `/avatar-maker.js`) |
| Offers bar / card / pop-up | `PromoBar` 11948, `PromoCard` 11977, `PromoPopup` 13314 |
| Install-the-app pop-up | `InstallPrompt` 11406 |
| Renewal-reminder pop-up | `RenewReminder` 13081 |
| Push permission prompt | `PushPrompt` 11659 |
| "New version ready" bar | `UpdateBar` 11352 |
| Paused-shop banner | `PauseBanner` 11291 |
| Refunds (customer side) | `RefundChoice` 12018, `RefundRequestButton` 12420, `RefundRequestSheet` 12448 |
| Help bubble / need-help card | `HelpBubble` 13818, `NeedHelpCard` 13844 |
| What's-new strip on Home | `FeedStrip` 13885 |
| A feed post | `FeedPost` 14677, media inside it `FeedMedia` 13661 |
| Comments | `FeedComments` 14393, `FeedAvatar` 14361 |
| **Reels (full screen)** | `FeedReels` 14959 |
| Liked / saved grids | `FeedLibrary` 15643 |
| Get OTP | `OtpScreen` 17037, `OtpPickerModal` 16619, `OtpVerifyCard` 16902 |
| Icons (our own set) | `FeedIcon` 14656 |

### CSS: which block styles what (line = where the block starts in the `<style>`)

| ~Line | Block |
|---|---|
| 41 | Layout shell (phone · tablet · computer) |
| 110 | Avatar creator |
| 275 | Bottom sheets — *the sheet scrolls, the page behind must not* |
| 325 / 359 | Maintenance 3D scene · rocket art |
| 369 | My plans filter chips (All · Active · Expired) |
| 379 | Splash |
| 405 | 3D motion (cards, presses, steps) |
| 450 | Offers themes |
| 490 | Renewal-reminder pop-up |
| 533 | 🍿 Feed posts (the app-like look, 4:5 media, action row) |
| 646 | "Get <service> from ₹X" pill |
| 725 | Feed / Reels tabs, ☰ activity menu, full-screen Reels |
| 820 | Players inside a reel (`.ff-reel-crop`, the Shorts crop) |
| 826 | Instagram panel in Reels *(why Instagram is not embedded — see the note there)* |
| 833 | **The drag bar** under a reel (how much has played) |
| 854 | Floating help bubble |
| 870 / 886 | Install pop-up · push pop-up |
| 903 | 📱 "App feel": brand glow, greeting card, section headers, bottom menu, presses |

(`html.ff-lite` — the low-end-phone trim — is not one block: the flag is set by the script at **963** and the
rules are sprinkled through the style block next to what they trim.)

## 1.2 `admin.html` — the owner's panel

One file, no framework. `MENU` (line **619**) is the list of screens; `viewMap()` (line **687**) maps each one to the
function that draws it; `route()` calls it. Add a screen = add to `MENU` + `viewMap()` + write `xxxView()`.

| Menu item | Function | ~Line | Backend module |
|---|---|---|---|
| ✅ Today | `todayView` | 2542 | `adminhome.js` |
| 📊 Dashboard | `dashboard` | 1008 | `admin.js` |
| ⚡ Quick order | `quickView` | 1533 | `quickorders.js` (+ `paylink.js`) |
| 💳 Receivables | `receivablesView` | 6380 | `credit.js` |
| 🧾 Orders | `ordersView` | 1955 | `adminlookup.js`, `adminorderactions.js` |
| ↩️ Refunds | `refundsView` | 2373 | `adminrefunds.js`, `refunds.js`, `refundrequests.js`, `adminrefundnow.js` |
| 💸 Payments | `paymentsView` | 4987 | `adminpayments.js`, `paymatch.js` |
| 🏦 Bank payments | `bankView` | 5104 | `adminbankcredits.js`, `banklinks.js` |
| 📣 Offers | `promosView` | 3407 | `adminpromos.js`, `promos.js` |
| 🍿 What's new | `feedView` | 3571 | `adminfeed.js`, `feed.js`, `feedvideo.js`, `feederase.js` |
| 🚧 Maintenance | `maintenanceView` | 4827 | `adminstore.js`, `store.js` |
| 🤖 Olivia AI | `oliviaView` | 4914 | `adminolivia.js`, `olivia.js` |
| 📦 Stock | `stockView` | 2475 | `stock.js`, `adminlookup.js` |
| 🚪 Remove users | `removeUsersView` | 5295 | `adminexpired.js`, `expiredusers.js` |
| 📱 OTP devices | `otpDevicesView` | 5499 | `adminotpdevices.js`, `otpdevices.js`, `otp.js` |
| 🔑 Password change | `passwordView` | 2708 | `accounttools.js`, `accesspassword.js`, `passwordage.js` |
| 💰 Profit | `profitView` | 2857 | `profit.js`, `accountgroups.js`, `accountid.js` |
| 📈 Reports | `reportsView` | 3320 | `adminreports.js`, `reports.js` |
| 🔍 Customer 360 | `customerView` | 1029 | `admin.js`, `paidvia.js` |
| 🔔 Reminders | `remindersView` | 2793 | `accounttools.js` |
| 🔔 Notifications | `pushView` | 3144 | `adminpush.js`, `push.js`, `pushreminders.js`, `ownernotify.js` |
| 🎁 Referrals | `referralsView` | 5912 | `adminreferrals.js`, `referrals.js` |
| 🪙 Coins | `coinsView` | 5847 | `admincoins.js`, `coins.js` |
| 🎮 Games | `gamesView` | 5998 | `admingames.js`, `games.js` |
| 📋 Sheets | `dataView` | 1172 | `admin.js` (the generic table grid) |
| 🧾 Plans | `plansView` | 4512 | `adminplans.js` |
| 🎟️ Coupons | `couponsView` | 1457 | `admin.js` |
| 🕘 Change log | `auditView` | 2679 | `audit.js` |
| 🔗 Integrations | `integrationsView` | 6410 | `adminn8n.js`, `n8n.js` |
| 📤 Exports | `exportsView` | 6536 | `adminexports.js`, `xlsx.js` |
| (sign in) | `loginView` | 611 | `security.js` |

**Two screens are added to `MENU` at the bottom of the file, not in the list at line 619:** 📈 Reports (after
💰 Profit) and 📤 Exports — so a search for `'reports'` in `MENU` finds nothing; look for `MENU.splice(`.

**Shared admin helpers:** `api()` / `post()` (589–590, every call), `modal()`, `toast()`, `money()`, `prettyDate()`,
`statusPill()`, `esc()`, `copy()`, draft-saving (`draftWatchForm`), and the phone Back-button handling.
The order pop-up is `openOrder()` → used by Orders, Today, Customer 360 and Bank payments alike.

## 1.3 Quick "I want to change…" table

| Change | Open |
|---|---|
| Wording on a customer screen | `index.html`, that screen's component (table above) |
| Colours, spacing, an animation | `index.html` CSS block 37–962 |
| The cheeky greeting lines | `index.html` ~1060 (`FF_GREETING_LINES`) |
| The bell / chime sounds | `index.html` ~975 (`SOUNDS`) and `admin.html` (new-order bell) |
| A price, a plan, a duration | **admin → 🧾 Plans** (never code) |
| Coins / referral / refund rules | **admin** → 🪙 Coins · 🎁 Referrals · ↩️ Refunds settings |
| What a customer can ask the server | `server.js` action lists + `customerauth.js` POLICY |
| An admin screen | `admin.html` `xxxView()` + its `admin*.js` module |
| The payment page a customer gets by link | `paylink.js` (HTML is inside that file) |
| An email's wording | `mailer.js` (access / reminders), `refunds.js`, `credit.js`, `quickorders.js` (payment link) |
| The WhatsApp message admin copies after an order | `admin.html` `qWaText()` (the renewal days line comes from `fulfill.js` `renewMessage`) |
| The 📤 shared price card (picture + text) | `index.html` `priceCard_` (the SVG, and SVG → JPEG) + `shareText_.prices` (the message) |
| The "From ₹X" a tile / feed pill / `/plans` promises | `index.html` `livePrice_` + `priceTerm_` (and `feedServiceInfo_`), `seo.js` `servicesOf` — all of them skip sold-out plans |
| The feed's look | `index.html` CSS 533–853 + `FeedPost` / `FeedReels` |

---

# PART 2 — BACKEND

## 2.1 How a request flows

```
browser ──► server.js ──► the module for that job ──► MySQL
                │
                ├── POST /api            → the storefront actions (table 2.2)
                ├── GET  /panel          → admin.html          (admin.js)
                ├── /admin/api/*         → the admin modules    (table 2.3)
                ├── /pay/<order>?t=…     → paylink.js           (customer payment page)
                ├── /games, /olivia.js, /sw.js, /manifest.webmanifest, /v/<id>.mp4, /poster/*, /feed-img/*
                └── /n8n/api/*           → n8n.js (key-protected)
```

`server.js` (703 lines) is the only entry point. It does the routing, the rate limits, and nothing else of substance.
**MySQL is the master** — the storefront never falls back to Apps Script.

## 2.2 Storefront API actions → the module that answers

Every action is listed in `server.js` in one of four sets (`DB_READ_ACTIONS`, `DB_STOREFRONT_ACTIONS`,
`DB_RECOVER_ACTIONS`, `DB_WRITE_ACTIONS`) and, for who is allowed to call it, in **`customerauth.js` POLICY**.

| Area | Actions | Module |
|---|---|---|
| My plans / orders / profile / coupons / wallet | `getMySubscriptions`, `getCustomerOrders`, `getCustomerProfile`, `getActiveCouponsForCustomer`, `getWalletByPhone` | `reads.js` |
| The plan catalogue, stock, trending, household link | `getBootstrap`, `getStockLevels`, `getTrendingItems`, `getNetflixHouseholdLink` | `catalog.js` |
| Buying | `createOrder`, `createRenewOrder`, `validateCoupon`, `verifyPayment`, `verifyPaymentByRef` | `order.js` |
| Handing out the account | `fulfillAndGetAccess` | `fulfill.js` |
| Profile, photo, avatar, restock, order status | `createOrUpdateCustomerProfile`, `updateCustomerProfilePic`, `getOrderStatus`, `getResumePaymentByPhone`, `submitRestockRequest`, `changeProfileEmail` | `account.js`, `photos.js`, `avatars.js` |
| Email login + the email lock | `emailLockStatus`, `emailSendCode`, `emailVerifyCode` | `emaillock.js`, `customerauth.js` |
| Recover access | `recoverSendOtp`, `recoverVerifyOtp`, `recoverListSubscriptionsSafe`, `recoverGetAccess` | `recover.js` |
| Get OTP tool | `getLatestOtp`, `getOtpQuota`, `otpSendCode`, `otpVerifyCode` | `otp.js`, `otpaccess.js` |
| Backup QR / "I've paid" | `getBackupPayment`, `claimManualPayment`, `getClaimStatus` | `paymatch.js` |
| Coins | `getCoinQuote`, `getCoinHistory` | `coins.js` |
| Refer & earn | `getReferralInfo`, `checkReferral` | `referrals.js` |
| Offers | `getPromos`, `promoEvent` | `promos.js` |
| Push notifications | `getPushKey`, `pushSubscribe`, `pushUnsubscribe` | `push.js` |
| 🍿 Feed | `getFeed`, `feedEvent` | `feed.js` |
| Feed comments | `getFeedComments`, `addFeedComment`, `getFeedCommentPreviews` | `feedcomments.js` (+ `feedmod.js` moderator) |
| ❤️ 🔖 marks | `setFeedMark`, `getFeedMarks`, `importFeedMarks` | `feedmarks.js` |
| Games | `getGamesStatus`, `getGamesHome`, `gameStart`, `gameStep`, `gameFinish`, `gamesSendCode` | `games.js` |
| Olivia | `oliviaStatus`, `oliviaChat`, `oliviaHistory`, `oliviaTranscript` | `olivia.js` |
| Refunds (customer) | `getPendingRefunds`, `chooseRefund`, `refundSendCode`, `requestUpiRefund`, `refundSentSeen`, `convertRefundToCredit` | `refunds.js` |
| Request a refund | `getRefundRequestItems`, `createRefundRequest` | `refundrequests.js` |
| Shop paused? | `getStoreStatus` | `store.js` |

## 2.3 Admin routes → module

All under `/admin/api/…`, all key- or session-protected (`security.js`). 28 of them are mounted by `admin.js`;
the two exceptions are `adminrefundnow.js` (mounted by `adminorderactions.js`) and the **public** `/pay` page
(`paylink.js`, mounted by `server.js`).

| Screen / job | Module | Notes |
|---|---|---|
| Today, to-dos, global search, change log | `adminhome.js` + `audit.js` | |
| Orders search / detail / retry | `adminlookup.js` | |
| Stuck orders: fulfil, deliver by hand, refund, erase | `adminorderactions.js` | erase keeps a backup in `app_settings` |
| ⚡ Quick order, mark paid, unpaid list, **payment link** | `quickorders.js` + `paylink.js` | |
| 💳 Credit renewals, receivables, reminders | `credit.js` | |
| ↩️ Refunds: offers, requests, settings | `adminrefunds.js`, `refunds.js`, `refundrequests.js` | "⚡ Refund now" = `adminrefundnow.js` |
| 💸 Backup-UPI claims | `adminpayments.js`, `paymatch.js` | |
| 🏦 Bank payments, link / split a payment | `adminbankcredits.js`, `banklinks.js` | |
| 🍿 Feed, reels, erase old reels, AI fill | `adminfeed.js`, `feed.js`, `feedvideo.js`, `feederase.js`, `feedai.js`, `feedthumb.js`, `feedgemini.js` | videos → `r2.js` |
| 📦 Stock, 📱 OTP devices | `stock.js`, `otpdevices.js`, `adminotpdevices.js` | |
| 🚪 Remove users | `adminexpired.js`, `expiredusers.js` | |
| 🔑 Password change | `accounttools.js`, `accesspassword.js`, `passwordage.js` | |
| 🔁 Switch account | `adminswitch.js` | |
| 💰 Profit, costs, rename/split an account id | `profit.js`, `accountgroups.js`, `accountid.js`, `logins.js` | |
| 📈 Reports + owner alerts | `adminreports.js`, `reports.js`, `ownernotify.js` | |
| 🔔 Notifications | `adminpush.js`, `push.js`, `pushreminders.js` | |
| 🎁 Referrals · 🪙 Coins · 🎮 Games · 📣 Offers · 🚧 Maintenance · 🤖 Olivia | `adminreferrals.js` · `admincoins.js` · `admingames.js` · `adminpromos.js` · `adminstore.js` · `adminolivia.js` | each has a matching engine module |
| 🧾 Plans editor | `adminplans.js` | |
| 📤 Exports | `adminexports.js` + `xlsx.js` | |
| 🔗 n8n | `adminn8n.js`, `n8n.js`, `n8nhooks.js`, `n8nbackup.js` | |
| ✉️ Email sender check | `adminmail.js` | |

## 2.4 The rules that live in their own file (open these, not the screens)

| Question | File |
|---|---|
| Which password does the customer actually get? | **`accesspassword.js`** (the account is the truth, the sub row is a copy) |
| Was this subscription delivered? | **`delivered.js`** |
| How many days does a late renewal cost? | `renewal.js`, `renewrules.js` |
| Which plans may a customer renew into? | `renewrules.js` `renewPlanMoves` / `renewNeedsNewPlace` — any plan of the same service; a kind or device change gets a NEW place (`fulfill.js`) |
| How is a customer message written? | **`watext.js`** — one wording with `*bold*` markers, rendered as WhatsApp / plain text / email HTML |
| The renewal reminder (expired / today / soon / ₹ due) | `credit.js whatsappText()` **and** `admin.html waRemindText()` — the same text, pinned together by `test/message-style.test.js` |
| What was the customer told about those days? | `fulfill.js` `renewMessage` → the WhatsApp text (`admin.html qWaText`), the credentials email (`mailer.js renewNote`) and the order's `raw_json.RenewNote` / `RenewCounted` / `RenewGifted` |
| One real login = one account (Zee5 listed 4×) | `logins.js`, `accountgroups.js` |
| Same login for every device, or one each? | `devicelogins.js` |
| How was this paid, and who paid it? | `paidvia.js` |
| One payment, two orders | `banklinks.js` |
| Who is allowed to call which action? | `customerauth.js` (POLICY) |
| Is the shop paused? | `store.js` |
| Is this person really the customer? | `customerauth.js`, `emaillock.js`, `otpaccess.js` |
| When did this account's password last change? | `passwordage.js` |

## 2.5 Database

Tables and **who writes them** (readers are many; the writer is who to blame):

| Table | Written by |
|---|---|
| `orders` | `order.js`, `fulfill.js`, `adminorderactions.js`, `refunds.js`, `credit.js`, `quickorders.js` |
| `subscriptions` | `fulfill.js` (+ `accesspassword.js`, `adminswitch.js`, `accountid.js`, `subexpiry.js`, `refunds.js`) |
| `customers` | `account.js`, `emaillock.js`, `photos.js`, `avatars.js`, `paidvia.js`, `quickorders.js` |
| `plans` | `adminplans.js` only |
| `coupons`, `coupon_usage` | `admin.js`, `order.js`, `games.js`, `refunds.js` |
| `wallet`, `coins_ledger`, `coin_spends` | `coins.js` (+ `games.js`) |
| `inventory_accounts` / `_profiles` / `_capacity` | `accounttools.js`, `accountid.js` |
| `bank_credits` | `payments.js` (writes them), `adminbankcredits.js`, `paymatch.js` (consume) |
| `bank_credit_links` | `banklinks.js` (schema-v28) |
| `payment_claims`, `customer_payer_names` | `paymatch.js` |
| `refund_offers`, `refund_requests` | `refunds.js`, `refundrequests.js`, `adminrefundnow.js` |
| `referrals`, `referral_codes`, `referral_rewards` | `referrals.js` |
| `feed_comments` | `feedcomments.js` · `feed_likes`/`feed_saves` → `feedmarks.js` · `feed_videos`/`_chunks` → `feedvideo.js` |
| `game_plays` | `games.js` |
| `account_costs` | `profit.js`, `accountid.js` |
| `push_subscriptions` | `push.js` |
| `sms_otp_log` | `otp.js` |
| `audit_log` | `audit.js` (every admin write) |
| `app_settings` | **everything** — it is the settings drawer (feed posts, offers, refund settings, OTP window, n8n keys, R2 keys…) |
| `trending_items`, `sync_log` | `sync.js` (the one-time import; see the note below) |

> 🔒 **The Sheet import is retired (21 Sep 2026).** `cutover.js` / `cleanup.js` / the 🚚 Go-live import screen are
> gone — the import ran on 14 Sep and both it and the cleanup were locked afterwards (kept in
> `_deleted-old-code/2026-09-21_go-live-machinery/`). `sync.js` **stays**, because the 📋 Sheets grid uses its
> `TABLES` column map; its `/admin/sync` route now refuses unless `ALLOW_SHEET_SYNC=1` is set in Hostinger, so the
> Sheet can never be pulled over MySQL by accident.

Schema files: `db/schema-v11.sql` … **`schema-v28.sql`** (v28 = one payment, several orders). Run them once each in
phpMyAdmin; every module that needs a new table fails soft and says which file to run.

> ⚠️ **Two traps that have bitten us.**
> 1. **Collation.** New tables (`feed_*`, `refund_*`, `bank_credit_links`) are `utf8mb4_unicode_ci`; the old ones are
>    `utf8mb4_general_ci`. **Never JOIN a new table with an old one** — live MariaDB throws "Illegal mix of collations".
>    Query each table separately and match them up in JavaScript.
> 2. **`raw_json` is not an archive.** Several paths read it as the truth (coupons at checkout, plan policies,
>    credit fields, payer names). A write must update the typed column **and** `raw_json`, or the row looks right in
>    admin and misbehaves at checkout.

## 2.6 Things that run by themselves

| Job | Where | How often |
|---|---|---|
| Bank-mail watcher (payment detection) | `payments.js` `startWatcher()` | on new mail, + a 60 s safety scan |
| Backup-QR claim sweep | `paymatch.js` | 1 min |
| Feed stats flush + auto-import | `feed.js` | 1 min / its own schedule |
| Offers stats flush | `promos.js` | 1 min |
| Coins housekeeping | `coins.js` | 10 min |
| Referral rewards | `referrals.js` | 30 min |
| Renewal reminder pushes | `pushreminders.js` | 1 h |
| Owner summaries (day / week / month) | `reports.js` | 1 min tick, fires on the hour |
| n8n webhooks | `n8nhooks.js` | 1 min |
| Sheet → MySQL sync | `server.js` | **off** (`SYNC_INTERVAL_MIN=0`, MySQL is master) |

## 2.7 Tests — 81 files, `npm test` runs them all

One file per area, named after it: `feed*.test.js`, `refunds-v3`, `bank-credits`, `quick-orders`, `payment-flows`,
`getotp-security`, `zee5-otp-matching`, `credit-renewals`, `renew-days-message`, `message-style`, `price-card`, `prices-in-stock`, `paid-via`, `r2-video-storage`, `games`, `olivia`, … Each
starts with a comment saying what it covers. They use fake in-memory databases — **no test ever touches live data or
the network.** Several also read `index.html` / `admin.html` and check the markup, so a UI change can fail a test.

## 2.8 Settings: where a value comes from

1. **Admin panel first** — prices, coins, referrals, refunds, offers, OTP window, feed, games, maintenance. Stored in
   `app_settings`. The owner can change these on a phone.
2. **Hostinger env vars** — only secrets and connections: `DB_*`, `IMAP_USER/PASS`, `SMTP_*`, `UPI_VPA`, `UPI_PAYEE`,
   `CACHE_CLEAR_KEY` (the admin key), `ADMIN_PASSWORD`, `TG_*`, `SITE_URL`, `PAYLINK_SECRET`, R2 and AI keys.
   One switch is a safety catch rather than a secret: `ALLOW_SHEET_SYNC=1` (off) unlocks the retired Sheet import.
3. **Code** — only the things that are not settings (the rules in 2.4).

If you are about to add a "constant" the owner might want to change, it belongs in 1, not 3.


## 2.9 Every server file, A–Z

All 102 modules with the first line of their own header comment. Open the file for the rest — each one explains its
own rules, and most list their routes at the top.

| File | Lines | What it is |
|---|---|---|
| `accesspassword.js` | 107 | ONE rule for "which password does the customer actually get?" |
| `account.js` | 285 | the last customer-facing Apps Script actions, ported to MySQL. |
| `accountgroups.js` | 221 | "one real login = one account" for the 💰 Profit page. |
| `accountid.js` | 258 | rename / split an inventory AccountID (admin only). |
| `accounttools.js` | 219 | admin account tools: password change (F5) and renewal reminders. |
| `admin.js` | 525 | Admin panel v3: Customer 360 cards, Sheets-style grid, coupons, expiring. GET /panel serves the dashboard… |
| `adminbankcredits.js` | 464 | admin 🏦 Bank payments (admin-only): every UPI credit the bank-mail watcher stored (bank_credits). |
| `admincoins.js` | 80 | admin 🪙 Coins screen (admin-only). |
| `adminexpired.js` | 120 | admin "🚪 Expired customers still on accounts" + one-tap cleanup (admin-only, mounted by admin.js). |
| `adminexports.js` | 605 | 📤 admin exports: orders list and customer profiles to Excel (.xlsx) or CSV… |
| `adminfeed.js` | 316 | admin 🍿 Feed (admin-only). See feed.js. |
| `admingames.js` | 147 | admin 🎮 Games screen (admin-only). Everything about the games is controlled here. |
| `adminhome.js` | 239 | admin "Today" screen, to-dos, global search and change log (admin-only). |
| `adminlookup.js` | 238 | admin order lookup + stock levels (mounted by admin.js, admin-only). |
| `adminmail.js` | 39 | admin ✉️ email sender check (admin-only; shown in 🔔 Notifications). |
| `adminn8n.js` | 128 | admin → 🔗 Integrations → n8n (admin-only; mounted by admin.js). Settings live in app_settings (n8n.js). |
| `adminolivia.js` | 49 | admin 🤖 Olivia screen (admin-only): switch the AI store manager on/off, test phones, AI words, voice guide, and read… |
| `adminorderactions.js` | 506 | admin actions for stuck orders (paid but not delivered). Mounted by admin.js, admin-only. |
| `adminotpdevices.js` | 132 | admin "📱 OTP devices" (admin-only, mounted by admin.js). See otpdevices.js. |
| `adminpayments.js` | 86 | admin 💸 Payments screen (admin-only): backup UPI settings + the "I've paid" review queue. |
| `adminplans.js` | 404 | admin 🧾 Plans editor (admin-only). |
| `adminpromos.js` | 59 | admin 📣 Offers (admin-only). |
| `adminpush.js` | 103 | admin 🔔 Notifications (admin-only). Every send is written to the change log. |
| `adminreferrals.js` | 91 | admin 🎁 Referrals screen (admin-only). |
| `adminrefundnow.js` | 341 | admin "⚡ Refund now" (owner request 15 Sep 2026): "instantly issue a refund without sending a request — in case I alre… |
| `adminrefunds.js` | 131 | admin 💸 Refunds (Refunds v3, owner decisions 15 Sep 2026). Mounted by admin.js, admin-only. |
| `adminreports.js` | 108 | admin 📈 Reports + 🔔 owner alert settings (admin-only, mounted by admin.js). Every change → change log. |
| `adminstore.js` | 70 | admin 🚧 Maintenance screen (admin-only): pause / resume new orders. |
| `adminswitch.js` | 559 | 🔁 Switch account (admin, owner request 15 Sep 2026). Mounted by admin.js, admin key / session only. |
| `appversion.js` | 100 | "new version" id for the website and the installed apps. |
| `audit.js` | 39 | admin change log (table audit_log, schema-v14). |
| `avatarmaker.js` | 304 | FluxFilm avatar creator — our own cartoon avatars, drawn as SVG from a tiny config. |
| `avatars.js` | 62 | "✨ Create your avatar" (Account → Profile). The drawing code is avatarmaker.js (shared with the browser). |
| `banklinks.js` | 127 | 🧾 ONE bank payment split across SEVERAL orders (schema-v28, table `bank_credit_links`). |
| `catalog.js` | 120 | storefront catalog from MySQL. |
| `coins.js` | 452 | loyalty coins on MySQL: earning (on fulfilment + Refer & earn), and spending at checkout… |
| `credit.js` | 400 | 💳 admin credit renewals, receivables and ✉️/💬 renewal reminders (owner request 16 Sep 2026). |
| `customerauth.js` | 376 | 🔐 customer login with an email code + signed sessions (15 Sep 2026, owner: "Send OTP to email for first time login"). |
| `db.js` | 60 | MySQL connection pool. Reads config from env vars. If DB env vars are missing, db is "disabled" and callers should fal… |
| `delivered.js` | 38 | "was this subscription delivered?" One shared rule for refunds.js (💸 Offer refund), refundrequests.js… |
| `devicelogins.js` | 137 | multiple devices: same login or a separate login for each device (F1, decided 2026-09-14). |
| `emaillock.js` | 485 | profile email lock (15 Sep 2026). |
| `expiredusers.js` | 341 | "Expired customers still on accounts" (admin Today, 🚪 Remove users, 📦 Stock per-account badge)… |
| `feed.js` | 1351 | 🍿 "What's new" feed: Instagram-style posts about new movies and shows (admin → 🍿 Feed). No schema change… |
| `feedai.js` | 274 | ✨ AI fill for a 🍿 What's new post (admin editor button). Suggests; never saves. |
| `feedcomments.js` | 273 | 💬 comments on 🍿 What's new posts. |
| `feederase.js` | 145 | 🧽 "Erase older reels" (admin → 🍿 What's new → 🧽 Erase older reels). |
| `feedgemini.js` | 73 | optional Google Gemini adapter for the 🍿 feed ✨ AI fill (feedai.js). Same answer shape as Olivia's DeepSeek adapter… |
| `feedmarks.js` | 174 | ❤️ liked and 🔖 saved 🍿 What's new posts, per customer account (phone login). |
| `feedmod.js` | 190 | 🍿 feed comments auto-moderator (runs on the server BEFORE a comment is saved). Pure: no DB, no network. |
| `feedthumb.js` | 145 | 📸 Instagram Reel thumbnail + caption, fetched by the SERVER (customers never load Instagram before a tap). |
| `feedvideo.js` | 650 | 🎬 uploaded Reel videos (admin → 🍿 What's new → Post type: Reel → Upload video). |
| `fulfill.js` | 1151 | fulfillment (Wave 2). Prime capacity allocation first. Uses a MySQL advisory lock… |
| `gamequestions.js` | 158 | FluxFilm Games - starter questions drafted by Claude (2026-09-15) for the owner to review in admin → 🎮 Games… |
| `games.js` | 760 | 🎮 Games (shop.fluxfilm.in/games): free daily mini-games that win coins or coupons. Everything the owner controls… |
| `logins.js` | 68 | one physical account per login. |
| `mailer.js` | 111 | transactional email from Node. Sending goes through smtp.js (support@ mailbox when SMTP_USER/SMTP_PASS are set, else t… |
| `n8n.js` | 826 | 🔗 n8n integration: the shop side (owner decision 16 Sep 2026). |
| `n8nbackup.js` | 167 | 🔐 encrypted database backup for n8n → Google Drive (GET /n8n/api/backup, mounted by n8n.js). |
| `n8nhooks.js` | 263 | 📡 webhooks to the owner's n8n (admin → 🔗 Integrations). |
| `olivia.js` | 1546 | OLIVIA, the AI store manager (chat on the website). "The decision is code, the words are the model." |
| `oliviahousehold.js` | 235 | Olivia's Netflix household auto-fix. |
| `oliviatools.js` | 79 | Olivia's TOOLS: the only website functions Olivia may call. Each one is the SAME function the storefront uses, with th… |
| `oliviawidget.js` | 664 | Olivia chat window (served at /olivia.js, loaded by index.html). Plain JS, no build step. |
| `oliviawords.js` | 774 | Olivia's WORDS (the model writes words; code has already decided everything). |
| `order.js` | 752 | MySQL-only buy flow: createOrder + payment verification. Every new order and renewal stays on MySQL… |
| `otp.js` | 417 | Get OTP tool on Node (login-OTP for JioHotstar / Zee5 / SonyLIV)… |
| `otpaccess.js` | 331 | proof that the person asking for a login OTP is the customer (Get OTP tool). |
| `otpdevices.js` | 778 | 📱 OTP accounts & devices (admin). The owner's old JioHotstar Sheet table, now from MySQL: per OTP login account… |
| `ownernotify.js` | 260 | 🔔 owner alerts: "💸 New order ₹299" the moment an order becomes PAID, "✅ Credit paid ₹X", and the settings for them +… |
| `paidvia.js` | 357 | "how was this paid" (PaidVia) + the payer's UPI name. |
| `passwordage.js` | 135 | "when was the password last changed" for each streaming account (admin 🔑 Password change + 🚪 Remove users). |
| `paylink.js` | 174 | 💳 a payment link + QR for ONE order. |
| `paymatch.js` | 523 | payment fallback: "Payment not going through / limit reached?" (schema-v17). |
| `payments.js` | 240 | payment verification (Wave 2, Path B). IMAP watcher reads the bank inbox… |
| `photos.js` | 150 | customers' own profile photos (Account → Profile → 📷 Upload your photo). |
| `profit.js` | 328 | admin profit view + extend a subscription (admin-only). |
| `promos.js` | 200 | offers, banners and pop-ups (admin → 📣 Offers). No schema change: app_settings 'promos' (list), 'promo_img_<id>'… |
| `push.js` | 291 | Web Push (phone / desktop notifications) with NO extra npm packages. |
| `pushreminders.js` | 205 | automatic renewal reminders by push notification (admin → 🔔 Notifications). |
| `pwa.js` | 144 | installable app (PWA) for the storefront and the admin panel. |
| `quickorders.js` | 374 | admin quick orders (sales made on WhatsApp / phone). |
| `r2.js` | 437 | 🪣 Cloudflare R2 object storage for 🎬 Reel videos (feedvideo.js). |
| `reads.js` | 363 | fast reads from MySQL (Phase 3). Faithful ports of Apps Script getMySubscriptions / getCustomerOrders / getCustomerPro… |
| `recover.js` | 333 | Recover access on MySQL (fully self-contained; no Apps Script). Flow: sendOtp (email a code) -> verifyOtp… |
| `referrals.js` | 416 | referral system ("Refer & earn", schema-v15). All settings are edited in the admin panel… |
| `refundrequests.js` | 325 | customer "💸 Request refund" (Refunds v3, owner addition 15 Sep 2026)… |
| `refunds.js` | 847 | customer-friendly refunds. Used by the admin Refund dialog (adminorderactions.js), the admin 💸 Refunds screen… |
| `renewal.js` | 168 | how many days a late renewal costs (agreed with the owner 2026-09-14). |
| `watext.js` | 48 | one wording, three channels: `*bold*` for WhatsApp, stripped for a screen, `<b>` for an email. |
| `renewrules.js` | 91 | shared renewal rules (PR 101 follow-up, 2026-09-15). |
| `reports.js` | 506 | 📊 business summaries (end of day / week / month) + the numbers for admin → 📈 Reports. Owner request 16 Sep 2026. |
| `security.js` | 126 | security helpers (no extra dependencies). |
| `seo.js` | 580 | SEO: search engines and link previews (WhatsApp, Instagram, Google) see real content without JavaScript. |
| `server.js` | 703 | Node/MySQL storefront. browser -> THIS app -> MySQL Apps Script is not a storefront fallback… |
| `share.js` | 224 | link previews for links customers share (WhatsApp / Instagram / Telegram cards). |
| `smtp.js` | 83 | one place that sends customer email (access, recovery code, reminders, password change). |
| `stock.js` | 254 | live stock levels, derived from real inventory. |
| `store.js` | 120 | maintenance / pause switch (admin → 🚧 Maintenance, stored in app_settings 'store'). |
| `subexpiry.js` | 32 | mark subscriptions EXPIRED once they have really ended (replaces the old Apps Script release job). |
| `sync.js` | 257 | Sheet -> MySQL sync (Phase 2/3). |
| `tmdbnet.js` | 82 | reach TMDB from the server even where Indian networks block it. |
| `xlsx.js` | 245 | tiny dependency-free .xlsx + CSV writer (admin exports, owner request 16 Sep 2026). |

Not modules: `index.html`, `admin.html`, `games.html` (Part 1) · `db/schema-v*.sql` (the migrations) ·
`test/` (79 test files) · `icons/`, `icons-default/` (app icons) · `scripts/` (one-off helpers) ·
 `n8n/` at the repo root (the owner's 5 automations).

---

## Keeping this file honest

When a file is added or a screen moves, update the one line here that mentions it. If a line number is wrong, the name
still finds it — but fix the number when you notice. The related docs: `CLAUDE.md` (orientation), `STATUS.md` (the
running history of every change), `docs/README.md` (where the other documents live).
