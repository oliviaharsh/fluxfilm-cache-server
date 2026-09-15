/**
 * FluxFilm - "was this subscription delivered?" One shared rule for refunds.js (💸 Offer refund),
 * refundrequests.js (customer 💸 Request refund) and adminorderactions.js / adminrefunds.js (undelivered refund / erase).
 *
 * Bug 15 Sep 2026: the old rule was `fulfillment_status === 'FULFILLED' || login_id`, so plans with no login
 * (YouTube family invites, OTP-type services) and old-site imports (fulfillment_status empty) looked NOT delivered:
 * no Offer refund button, and the customer was told to wait 48 hours.
 *
 * Delivered when ANY of:
 *   - fulfillment_status is FULFILLED / DELIVERED / ACTIVE / COMPLETED (any case);
 *   - login_id, inventory_ref, account_id, profile_name or profile_number is set
 *     (YouTube invites keep their "MIG_YT"-style profile in profile_number);
 *   - an old-site row: fulfillment_status empty, not created by this app (source ≠ 'node'),
 *     status ACTIVE or EXPIRED and a start_date.
 * Never delivered otherwise — e.g. FAILED / MANUAL_PENDING / PENDING / CREATED with none of the fields above.
 *
 * SELECTs feeding this must load: fulfillment_status, status, start_date, source, login_id, inventory_ref,
 * account_id, profile_name, profile_number (DELIVERY_COLS below).
 */
const s = (v) => String(v == null ? '' : v).trim();
const up = (v) => s(v).toUpperCase();

const DELIVERED_STATES = ['FULFILLED', 'DELIVERED', 'ACTIVE', 'COMPLETED'];
const ACCESS_FIELDS = ['login_id', 'inventory_ref', 'account_id', 'profile_name', 'profile_number'];
const LEGACY_STATUSES = ['ACTIVE', 'EXPIRED'];
const DELIVERY_COLS = 'status, fulfillment_status, start_date, source, login_id, inventory_ref, account_id, profile_name, profile_number';

function isDeliveredSub(row) {
  const x = row || {};
  const fs = up(x.fulfillment_status);
  if (DELIVERED_STATES.includes(fs)) return true;
  if (ACCESS_FIELDS.some((f) => s(x[f]))) return true;
  if (!fs && s(x.source) !== 'node' && LEGACY_STATUSES.includes(up(x.status)) && s(x.start_date)) return true;
  return false;
}

module.exports = { isDeliveredSub, DELIVERY_COLS, DELIVERED_STATES, ACCESS_FIELDS };
