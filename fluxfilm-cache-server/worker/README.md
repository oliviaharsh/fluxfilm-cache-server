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
node tvworker.js check PRI-13          # still signed in? what does the devices page say?
```

`check` prints the devices page back to you as lines of text rather than a count, on purpose. A count of
zero cannot tell you apart "this account has no devices" from "we could not read the page", and the worker
decides whether a registration worked by spotting a line that was not there before — so you should be able
to see the same thing it sees. An account with nothing on it says so in words.

## Signing itself back in (optional, off by default)

A profile can go stale. With this on, the worker signs the account back in by itself instead of handing
the job back to you.

```bash
copy accounts.example.json accounts.json     # then fill in the accounts you want covered
```

Set `FF_AUTO_LOGIN=on` in `.env`. Both files are git-ignored and neither is ever uploaded: **the shop
does not serve passwords and this worker never asks it for one**, so the admin key cannot be turned into
your inventory. Only the accounts you list are covered; anything else still comes back to you.

**What it will not do.** It stops dead at a one-time code, a CAPTCHA or a verification page, and says
which one it hit. It does not retry and does not look for a way round. 37 of 39 Prime logins are Outlook
or Hotmail and we cannot read those mailboxes, so a one-time code is a dead end rather than a puzzle.
That is the ceiling on this feature, and it is a real one.

It also ticks **Keep me signed in**, which is the part that actually makes sessions last. Tick it
yourself too when you sign in by hand.

Three attempts per account per day, counted in `profiles/logins.json`. More than that is not a bad minute,
it is a problem worth your eyes - repeated sign-ins are how an account with paying customers gets locked.

### Testing it before a customer does

```bash
node tvworker.js relogin PRI-13           # sign in now, if the profile is signed out
node tvworker.js relogin PRI-13 fresh     # put the profile aside first, so it starts from nothing
```

`fresh` **renames** the profile, it does not delete it - move the `.bak-…` folder back to undo. Starting
from nothing is the hardest case there is: a browser Amazon has never seen is the most likely to be
challenged, so if it gets through that, an expired session will be easier.

This command works whether or not `FF_AUTO_LOGIN` is on - the switch guards the unattended loop, and a
command you just typed is consent enough on its own. The three-a-day cap still applies.

### Check the file before a customer does

```bash
node tvworker.js accounts
```

Lists the accounts the worker can sign in by itself, and what is wrong with the file: broken JSON, a
missing password, leftover example text, or - the one worth having - **two accounts sharing the same
login**, which is how a profile ends up signed into somebody else's account. It prints ids and counts
only, never a login or a password.

`run` does the same check at startup and refuses to start on a broken file. Before, a stray comma made
every account look signed out, which looks exactly like a real problem and is not.

### Keeping the sessions alive

```bash
node tvworker.js touch
```

Opens every account's devices page, confirms it is still signed in, and names the ones that are not.
`run` does the same by itself every `FF_TOUCH_HOURS` hours (12 by default, 0 turns it off), between
jobs and never during one.

Two things at once. A session that gets used lasts longer than one that sits. And anything that HAS died
is found here, in a log, instead of by a customer whose television is waiting - you seed it again at a
civilised hour instead of at one in the morning.

**It never signs in.** Deliberately: this runs at three in the morning with nobody watching, and an
automatic sign-in there would spend attempts and walk into a one-time code wall only a person can
answer. Finding out is its job; fixing it is yours.

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
