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

  // The Apps Script version threw if PLANS was missing headers. Here an empty
  // result is far more likely to mean "DB not populated yet" than "no plans",
  // and silently showing an empty shop is worse than falling back — so let
  // server.js hand this request to Apps Script instead.
  if (!plans.length) return { __fallback: true };

  return { ok: true, plans, currency: process.env.CURRENCY || 'INR' };
}

module.exports = { getBootstrap };
