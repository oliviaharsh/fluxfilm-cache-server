# 📺 The TV worker — setup

Registers customers' TVs on Prime Video without anybody being awake. Customers watch at night, "instant" is
a selling point, and a good number of them are older or disabled — this is the part that makes the promise
true at 1am.

**It does not run on Hostinger** and never will: Hostinger's Node hosting cannot run Chromium. It runs on a
machine you keep on. Start with your laptop; move it later without changing any code.

---

## One-time setup

```bash
cd fluxfilm-cache-server/worker
npm install
npx playwright install chromium        # ~300 MB, once
cp .env.example .env                   # then fill in FF_ADMIN_KEY
```

## Sign each account in — once

```bash
node tvworker.js login PRI-13
```

A real browser opens. **You** sign in — the worker never types a password, by design. Get to the Devices
page, then close the window. The session is kept in `profiles/PRI-13/` and should last months.

Repeat for each Prime account you want covered. Start with one.

```bash
node tvworker.js check PRI-13          # still signed in? how many devices?
```

## Run it

```bash
node tvworker.js run
```

It asks the shop for a waiting job every 15 seconds, registers the code, reads the new device's name back
and reports it. Leave it running.

The first few times, set `FF_HEADLESS=off` in `.env` and watch it work. It is worth seeing once.

---

## What it will not do

| | |
|---|---|
| **Sign in** | A human seeds each profile. If a session dies the job comes back as *needs the owner*. Automatic re-login stays off until the whole path is proven — every extra automated sign-in is another chance to trip a control on an account with four paying customers behind it. |
| **Touch a CAPTCHA** | Or a recovery page, or a suspicious-login prompt. It stops and says so. |
| **Claim success it has not seen** | "No error" is not success. The device must appear in the account's list; its name is read back and stored, because that name is what the removal will need later. |
| **Hammer a bad account** | Three failures on one account and it stops touching that account until restarted. |
| **Log anything secret** | Not the code, not a cookie, not a profile path's contents. |

## 🔒 The profiles folder IS the sessions

`worker/profiles/` holds live, signed-in Amazon sessions. It is gitignored. Do not commit it, do not email
it, do not copy it to a machine you do not control. Anyone holding that folder is signed into those
accounts.

## Moving it off the laptop later

Everything is configuration, so moving is a copy and an `.env` edit:

| where | always on | the IP Amazon sees | notes |
|---|---|---|---|
| **your laptop** | only when open | your UK home connection | right for now — free, and it is where these accounts have always been used from |
| **a mini PC at home** | yes, ~5W | the same UK home connection | the safest permanent answer; nothing about the accounts changes |
| **a VPS** (Hostinger offers one) | yes | **a datacenter IP** | no hardware to buy, but it is a connection these accounts have never been used from. Try it with ONE low-value account first and watch for a week before moving the rest. |

Either way: `npm install`, `npx playwright install chromium`, copy `.env`, and sign the accounts in again on
the new machine (or copy `profiles/` across, carefully).

## When something goes wrong

- **"signed out of this account"** → `node tvworker.js login PRI-xx` again. If this happens often, the
  session is not surviving and that changes the plan — tell Claude how often.
- **"the page asked for a security check"** → sign in by hand in a normal browser on that account, clear
  whatever Amazon is asking for, then `login` again. Never automate past it.
- **"the registration box was not where we expected it"** → Amazon changed the page. The two URLs are in
  `.env` (`FF_TV_REGISTER_URL`, `FF_TV_DEVICES_URL`); the selectors are in `tvworker.js`. This is unsupported
  integration surface and it will happen eventually.
- **The worker is off** → nothing breaks. Codes queue up and admin → 📺 TV activations still works by hand.
