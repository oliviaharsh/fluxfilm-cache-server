/* Storefront layout checks (index.html is one big browser script). Run: npm test */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let parsed = true;
for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
ok('storefront script parses', parsed && scripts.length > 0);

// Floating WhatsApp bar used to cover Continue / Pay buttons: help now lives in the header (top-right, every screen).
ok('no floating WhatsApp bar', !/function WABar\(|createElement\(WABar/.test(html));
ok('header has WhatsApp support button + desktop menu', /className: "ff-help/.test(html) && /className: "ff-desk-nav"/.test(html));
ok('phone bottom menu only on home / plans / my plans / what\'s new / account', /function BottomNav\(/.test(html) && /showBnav && React.createElement\(BottomNav/.test(html) && /const BNAV_SCREENS = \{\s*home: 1,\s*dashboard: 1,\s*buy1: 1,\s*feed: 1,\s*account: 1\s*\}/.test(html));
ok('checkout screens use the narrow centred column, lists use the wide one', /'ff-w-wide' : 'ff-w-flow'/.test(html) && /\.ff-w-flow \{ max-width: 620px; \}/.test(html));
ok('old phone-strip desktop layout removed', !/body::after/.test(html) && !/#root \{ max-width: 520px/.test(html));
ok('responsive grids for services and subscription cards', /className: "ff-grid-svc"/.test(html) && (html.match(/className: "ff-cards"/g) || []).length === 3); // active subs, history, filtered list
// My plans: All / Active / Expired filter (owner 2026-09-14).
ok('My plans has All · Active · Expired chips with counts', /\[\['all', 'All', allSubs\.length\], \['active', 'Active', liveSubs\.length\], \['expired', 'Expired', expiredSubs\.length\]\]/.test(html) && /\.ff-subfilter button \{[^}]*min-height: 42px/.test(html));
ok('active = days left > 0, expired = the rest; choice remembered on the phone', /const isLiveSub = s => Number\(s\.daysLeft\) > 0;/.test(html) && /localStorage\.setItem\('ff_sub_filter', v\)/.test(html) && /const filteredSubs = subFilter === 'active' \? liveSubs : subFilter === 'expired' \? expiredSubs : null;/.test(html));
ok('filter chips fit small phones: one row, no wrap, CSS dots (no emoji), smaller text under 350 px', /\.ff-subfilter \{ display: flex; gap: 6px;/.test(html) && /\.ff-subfilter button \{[^}]*flex: 1 1 0; min-width: 0;[^}]*white-space: nowrap;/.test(html) && /@media \(max-width: 350px\) \{ \.ff-subfilter button/.test(html));
ok('rocket is drawn 3D art, not the 🚀 emoji (its pulse drew a box around it)', /function RocketArt\(/.test(html) && !/"🚀"/.test(html) && !/🚀 (Coming soon|We're working)/.test(html) && /React\.createElement\(RocketArt, \{\s*size: 112\s*\}\)/.test(html) && /@keyframes ffRkFloat \{[^}]*perspective\(300px\)/.test(html));
ok('"All" keeps the old Subscriptions + History layout', /!filteredSubs && React\.createElement\("div", \{\s*className: "ff-cards"\s*\}, actionable\.map/.test(html) && /!filteredSubs && history\.length > 0/.test(html));

// React hooks must never be called inside a loop (crashes when the plan list changes size).
const hookInLoop = /\.map\(\([^)]*\)\s*=>\s*\{\s*const \[[^\]]+\] = useState\(|\.map\(\w+\s*=>\s*\{[^{}]*const \[[^\]]+\] = useState\(/;
ok('service tiles are their own component (no useState inside .map)', /function ServiceTile\(/.test(html) && !hookInLoop.test(html.replace(/false && plans\.map[\s\S]*?\}\)\), React\.createElement\(Hint/, '')));

// Menu: My plans · Buy · New (🍿 What's new feed) · Recover · Account (dashboard tiles for these were removed).
// Help left the bottom menu (owner 2026-09-15: too crowded) — it is the header's top-right button on every screen.
const navBlock = (html.match(/const navItems = \[[\s\S]*?\}\];/) || [''])[0];
ok('menu order: home, buy, feed, recover, account (no help in the menu)', !/key: 'help'/.test(navBlock) && ['home', 'buy', 'feed', 'recover', 'account'].map((k) => navBlock.indexOf("key: '" + k + "'")).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), navBlock.slice(0, 80));
ok('bottom menu has 5 columns', /\.ff-bnav \{[^}]*repeat\(5, minmax\(0,1fr\)\)/.test(html));
ok('dashboard no longer has Buy / Recover / Account tiles', !/className: "ff-dash-actions"/.test(html) && /className: "ff-dash-stats"/.test(html));
ok('account is a list menu (Profile, Coupons, Refer & earn, Wallet) opening sub-pages', /className: "ff-arow"/.test(html) && /k: 'profile'[\s\S]*?k: 'coupons'[\s\S]*?k: 'referral'[\s\S]*?k: 'wallet'/.test(html) && /‹ Account/.test(html) && /function ComingSoonCard\(/.test(html) && !/className: "ff-tabs",/.test(html));
ok('coupons shown as cards with plain words (no raw ANY / NEW / RENEW)', /function CouponList\(/.test(html) && /ANY: '🛒 New plans & renewals'/.test(html) && !/Valid for \$\{c.scope/.test(html));
ok('screen slide-in leaves no transform behind (pop-ups were trapped under header/menu)', /\.ff-slide \{ animation: ffSlideIn [.\d]+s [^;{}]*\bbackwards;[^}]*\}/.test(html) && !/\.ff-slide \{[^}]*will-change/.test(html) && !/el\.style\.transform = .translateX\(0\)./.test(html));

// Numbered checkout: buy = Plan, Details, Review, Pay, Access; renew = Plan, Pay, Access.
ok('checkout steps: buy = Plan, Details (incl. review), Pay (incl. payment help), Access; renew = Plan, Pay, Access', /buy: \[\['Plan', \['buy2', 'groupJoin'\]\], \['Details', \['details', 'review'\]\], \['Pay', \['pay', 'payhelp'\]\], \['Access', \['verify', 'done'\]\]\]/.test(html) && /renew: \[\['Plan', \['renewStart'\]\], \['Pay', \['pay', 'payhelp'\]\], \['Access', \['verify', 'done'\]\]\]/.test(html));
ok('details goes straight to pay; failed order goes back to the filled-in details', /nav\('pay', \{\s*service,\s*planObj,\s*form,\s*couponState,\s*creating: true/.test(html) && !/nav\('review', \{\}\)/.test(html) && (html.match(/goBack \? goBack\(\) : nav\('home', \{\}\)/g) || []).length === 2);
ok('steps shown above every screen; flow tracked on nav + navReset', /React.createElement\(CheckoutSteps, \{\s*flow: storeBlocked \? '' : flow,\s*screen: screen\s*\}\)/.test(html) && (html.match(/    trackFlow\(s\);/g) || []).length === 2);

// Devices: checkout sends the plan's device count and how many are TVs (was never sent; a 2-device Prime
// order with "TV" reserved 2 TV slots even for TV + mobile).
const script = scripts.join('\n');
const fnSrc = (script.match(/function planDeviceCount_\(plan\) \{[\s\S]*?\n\}/) || [''])[0];
const planDeviceCount_ = fnSrc ? new Function(fnSrc + '; return planDeviceCount_;')() : () => NaN;
ok('device count read from the plan name like the server', planDeviceCount_('2 Devices 1Y') === 2 && planDeviceCount_('1 Month') === 1 && planDeviceCount_('3 devices') === 3);
ok('createOrder payload includes deviceCount + tvCount (and no discountOverride)', /deviceCount: planDeviceCount_\(planObj\?\.plan\),\s*tvCount: form\?\.tvCount != null \? form\.tvCount : ''/.test(html) && !/discountOverride: 0/.test(html));
ok('multi-device Prime asks how many are TVs; nothing picked by default', /How many will be a TV\?/.test(html) && /tvCount: n, deviceCount: devices, extraVal: n > 0 \? 'TV' : 'NON_TV'/.test(html) && /deviceCount: planDeviceCount_\(planObj\?\.plan\),\s*tvCount: null/.test(html));

// Refer & earn on the storefront.
ok('invite link ?ref= saved (30 days) and removed from the address bar', /function captureRefFromUrl_\(\)/.test(html) && /searchParams\.delete\('ref'\)/.test(html) && /30 \* 86400000/.test(html));
ok('new orders send the invite code; checkout shows the invite discount unless a coupon is applied', /referralCode: getRefCode_\(\),/.test(html) && /const refDiscount = !couponState\.applied && refState && refState\.ok/.test(html) && /'🎁 Invite discount'/.test(html));
ok('Account → Refer & earn and Wallet are real pages (not "coming soon")', /section === 'referral' && React\.createElement\(ReferralPanel/.test(html) && /section === 'wallet' && React\.createElement\(WalletPanel/.test(html) && /Share on WhatsApp/.test(html));
ok('only invalid codes are forgotten (an old number keeps the link for a new number on the same phone)', (html.match(/if \(r && r\.invalid\) clearRefCode_\(\);/g) || []).length === 2 && !/r\.notNew\)\) clearRefCode_/.test(html));
ok('invite banner re-checks when the signed-in number changes and hides for an existing customer', /\}, \[refPhone\]\);/.test(html) && /setRefInfo\(r && r\.ok \? r : null\);/.test(html) && /const refPhone = screenData && screenData\.phone \|\| getFFSession\(\)\.phone \|\| '';/.test(html));

// Paying with coins.
ok('coins toggle at checkout and on renew; totals subtract coins', /function CoinToggle\(/.test(html) && (html.match(/React\.createElement\(CoinToggle, \{/g) || []).length === 2 && /kind: 'NEW'/.test(html) && /kind: 'RENEW'/.test(html) && /\['🪙 Coins', `− ₹\$\{coinRupees\}`\]/.test(html) && /Math\.max\(0, finalPrice - coinRupees\)/.test(html));
ok('orders send useCoins (new: in the form, renew: 4th API arg)', /useCoins: form\?\.useCoins === true,/.test(html) && /useCoins: coinRupees > 0/.test(html) && /\[subId, plan, coupon, useCoins === true\]/.test(html) && /\}, coinRupees > 0\);/.test(html));
ok('wallet shows coin history + real rules', /API\.getCoinHistory\(phone/.test(html) && /Pay with coins at checkout: 1 coin = ₹/.test(html));
// Owner report 2026-09-15: in the installed app, Account → Logout was hidden under the bottom menu and could not be scrolled to.
const has = (s) => html.includes(s);
ok('bottom menu self-heal: at the end of the page it measures the last content against the menu / visible screen and adds exactly the missing room', has('var(--ff-bnav-h, 0px)) + 88px + var(--ff-bnav-extra, 0px))') && has('+ 96px + var(--ff-bnav-extra, 0px))') && has('const layoutH = Math.max(window.innerHeight, doc.clientHeight || 0);') && has('const atEnd = doc.scrollTop + layoutH >= doc.scrollHeight - 4;') && has('if (!atEnd || !last) return;') && !has('if (doc.scrollTop + visH < doc.scrollHeight - 4) return;') && has("if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') continue;") && has('ro2.observe(document.body)') && has("window.addEventListener('touchend', onScroll, { passive: true });") && has('const missing = Math.ceil(lastBottom - limit + 20);') && has('extra < 480') && has("window.removeEventListener('scroll', onScroll)"));
ok('?layout=1 shows the phone layout numbers box (for support screenshots), off by default', has('/[?&]layout=1\\b/.test(location.search)') && has('window.ffLayoutDebug = function (m)') && has('if (!on) return;'));
ok('bottom menu reserves its measured height + room (Logout never hidden)', /\.ff-has-bnav \{ padding-bottom: calc\(72px \+ env\(safe-area-inset-bottom\) \+ 88px\); padding-bottom: calc\(max\(72px \+ env\(safe-area-inset-bottom\), var\(--ff-bnav-h, 0px\)\) \+ 88px \+ var\(--ff-bnav-extra, 0px\)\); \}/.test(html) && /root\.style\.setProperty\('--ff-bnav-h', Math\.ceil\(r\.height\) \+ 'px'\)/.test(html) && /new ResizeObserver\(update\)/.test(html) && /ref: ref,\s*className: "ff-bnav"/.test(html));
ok('installed app (standalone) gets extra bottom room', /@media \(display-mode: standalone\) \{ \.ff-has-bnav \{ padding-bottom: calc\(max\(72px \+ env\(safe-area-inset-bottom\), var\(--ff-bnav-h, 0px\)\) \+ 96px \+ var\(--ff-bnav-extra, 0px\)\); \} \}/.test(html) && html.indexOf('@media (display-mode: standalone) { .ff-has-bnav') < html.indexOf('.ff-has-bnav { padding-bottom: 32px; }'));

console.log('\n---------------------------------------');
console.log('PASS ' + pass + '   FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
