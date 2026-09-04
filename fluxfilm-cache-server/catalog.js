/**
 * FluxFilm - storefront catalog from MySQL.
 *
 * Faithful port of the Apps Script getBootstrap() (Orders.gs), producing the
 * SAME response shape so index.html is unchanged.
 *
 * WHY THIS EXISTS: the storefront used to read its plan list from the Sheet via
 * Apps Script while createOrder priced from MySQL. With Sheet->MySQL sync off
 * (MySQL is master) those two drifted apart — a price edited in the admin panel
 * showed the old Sheet price but charged the MySQL one, and MySQL-only columns
 * (ExtraDevicePrice, new multi-device plans) were invisible to the storefront.
 * Reading the catalog from MySQL makes the shown price and the charged price the
 * same row.
 */
const db = require('./db');

function s(v) { return String(v == null ? '' : v).trim(); }
function up(v) { return s(v).toUpperCase(); }
function isTrue(v) { return up(v) === 'TRUE'; }
function asNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function rawOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } }

/**
 * Active plans + currency, shaped exactly like the Apps Script version.
 * Typed MySQL columns win where they exist (they're what createOrder prices
 * from); everything else comes out of raw_json, which keeps every original
 * PLANS column from the Sheet.
 */
async function getBootstrap() {
  const rows = await db.query(
    'SELECT service, plan, duration_days, price, early_renew_discount, logo_url, is_active, raw_json FROM plans', []);

  const plans = [];
  for (const r of rows) {
    const raw = rawOf(r.raw_json);
    // is_active may live in either place depending on how the row was created
    // (synced from the Sheet vs. added in the admin panel).
    const activeRaw = (r.is_active != null && r.is_active !== '') ? r.is_active : raw.IsActive;
    if (!isTrue(activeRaw)) continue;

    const benefitsRaw = s(raw.Benefits);
    plans.push({
      service: s(r.service || raw.Service),
      plan: s(r.plan || raw.Plan),
      durationDays: asNum(r.duration_days != null ? r.duration_days : raw.DurationDays),
      price: asNum(r.price != null ? r.price : raw.Price),
      fulfillmentMode: up(raw.FulfillmentMode),
      allocationPolicy: up(raw.AllocationPolicy),
      needsExtraField: isTrue(raw.NeedsExtraField),
      extraFieldKey: s(raw.ExtraFieldKey),
      extraFieldLabel: s(raw.ExtraFieldLabel),
      deviceRuleText: s(raw.DeviceRuleText),
      postPaymentMessage: s(raw.PostPaymentMessage),
      earlyRenewDiscount: asNum(r.early_renew_discount != null ? r.early_renew_discount : raw.EarlyRenewDiscount),
      requiresGroupJoin: isTrue(raw.RequiresGroupJoin),
      groupJoinLink: s(raw.GroupJoinLink),
      groupSuspendWarningDays: asNum(raw.GroupSuspendWarningDays),
      benefits: benefitsRaw ? benefitsRaw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [],
      badgeText: s(raw.BadgeText),
      logoUrl: s(r.logo_url || raw.LogoUrl),
      // MySQL-only column that the Sheet never had — the storefront needs it to
      // price extra devices without a round-trip.
      extraDevicePrice: asNum(raw.ExtraDevicePrice),
    });
  }

  if (!plans.length) return { ok: false, plans: [], message: 'No active plans are configured in the FluxFilm database.' };

  return { ok: true, plans, currency: process.env.CURRENCY || 'INR' };
}

/** Stock badges are derived from the MySQL PLANS raw_json Stock field. */
async function getStockLevels() {
  const rows = await db.query('SELECT service, plan, is_active, raw_json FROM plans', []);
  const low = Math.max(1, Number(process.env.STOCK_LOW_THRESHOLD || 3) || 3);
  const levels = {};
  for (const r of rows) {
    const raw = rawOf(r.raw_json);
    const activeRaw = (r.is_active != null && r.is_active !== '') ? r.is_active : raw.IsActive;
    if (!isTrue(activeRaw)) continue;
    const service = s(r.service || raw.Service);
    const plan = s(r.plan || raw.Plan);
    if (!service || !plan) continue;
    const stockText = s(raw.Stock);
    const stock = stockText === '' ? null : Math.max(0, Math.floor(asNum(raw.Stock)));
    const stockLevel = stock == null ? 'OK' : (stock <= 0 ? 'OUT' : (stock < low ? 'LOW' : 'OK'));
    levels[service + '|||' + plan] = { stock, stockLevel };
  }
  return { ok: true, levels };
}

/** Trending ticker rows are stored in MySQL and loaded by the final manual sync. */
async function getTrendingItems() {
  const rows = await db.query(
    "SELECT title, platform, line FROM trending_items WHERE UPPER(COALESCE(active, 'TRUE')) = 'TRUE' ORDER BY sort_order ASC, item_key ASC LIMIT 8", []);
  const items = rows.map((r) => s(r.line) || ('🔥 ' + s(r.title) + (s(r.platform) ? ' on ' + s(r.platform) : '')))
    .filter((x) => x && x !== '🔥 ');
  return { ok: true, items };
}

/** Netflix household links now come from INVENTORY_ACCOUNTS.raw_json in MySQL. */
async function getNetflixHouseholdLink(email) {
  const em = s(email).toLowerCase();
  if (!em || !em.includes('@')) return { ok: false, message: 'Valid email is required.' };
  const rows = await db.query('SELECT login_id, raw_json FROM inventory_accounts WHERE LOWER(login_id) = ? LIMIT 1', [em]);
  if (!rows.length) return { ok: false, message: 'No Netflix account found with that email. Enter the account login email, not your personal email.' };
  const link = s(rawOf(rows[0].raw_json).HouseholdLink);
  if (!link) return { ok: false, message: 'Household link is not set for this account. Contact support.' };
  return { ok: true, link };
}

module.exports = { getBootstrap, getStockLevels, getTrendingItems, getNetflixHouseholdLink };
