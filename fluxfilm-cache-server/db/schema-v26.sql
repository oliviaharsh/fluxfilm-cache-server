-- FluxFilm schema v26: 💸 refund offers for DELIVERED plans (refunds.js / adminrefunds.js). Safe to run more than once.
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (plain CREATE TABLE, no information_schema / PREPARE —
-- Hostinger's phpMyAdmin refuses those with #1044).
--
-- Until it is run: the "💸 Offer refund" button says to run this file; everything else (the not-delivered refund,
-- the customer's coins / coupon / UPI choice for it, the UPI queue) keeps working.
--
-- One row = one refund the owner offered on a delivered order. The customer picks how they want it in the app.
--   status        OFFERED (waiting for the customer) | UPI_REQUESTED (customer gave a UPI ID, owner must send it)
--                 | DONE (coins / coupon added, or UPI sent) | CANCELLED (owner) | EXPIRED (not chosen in time)
--   reason        NO_REPLACEMENT (no charge) | MID_PERIOD (usage charge)
--   paid_amount   what the customer paid for that order (server value, never from the browser)
--   charge_amount usage charge the owner set (0 for NO_REPLACEMENT); refund_amount = paid − charge, never below 0
--   method        COINS | COUPON | UPI once the customer chose
--   credit_amount coins / coupon value given (refund + bonus_percent%); UPI = the exact refund_amount
--   live_order    = order_id while the offer is open or used, NULL once cancelled / expired → one live offer per order
--   sub_ids       subscriptions whose access ends when the offer is accepted (comma separated)
-- Dates are India time (written by the app).
CREATE TABLE IF NOT EXISTS refund_offers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id         VARCHAR(16)   NOT NULL,
  order_id         VARCHAR(40)   NOT NULL,
  live_order       VARCHAR(40)   NULL,
  sub_ids          VARCHAR(400)  NULL,
  phone_norm       VARCHAR(10)   NOT NULL,
  service          VARCHAR(120)  NULL,
  plan             VARCHAR(120)  NULL,
  reason           VARCHAR(20)   NOT NULL,
  paid_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  charge_amount    DECIMAL(10,2) NOT NULL DEFAULT 0,
  suggested_charge DECIMAL(10,2) NULL,
  refund_amount    DECIMAL(10,2) NOT NULL DEFAULT 0,
  days_used        INT           NULL,
  total_days       INT           NULL,
  bonus_percent    INT           NOT NULL DEFAULT 10,
  note             VARCHAR(300)  NULL,
  status           VARCHAR(20)   NOT NULL DEFAULT 'OFFERED',
  method           VARCHAR(10)   NULL,
  credit_amount    INT           NULL,
  coupon_code      VARCHAR(20)   NULL,
  upi_id           VARCHAR(120)  NULL,
  upi_ref          VARCHAR(120)  NULL,
  cancel_reason    VARCHAR(200)  NULL,
  email_sent       TINYINT(1)    NOT NULL DEFAULT 0,
  expires_at       DATETIME      NOT NULL,
  created_at       DATETIME      NOT NULL,
  accepted_at      DATETIME      NULL,
  paid_at          DATETIME      NULL,
  cancelled_at     DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ro_offer (offer_id),
  UNIQUE KEY uq_ro_live_order (live_order),
  KEY idx_ro_phone (phone_norm, status),
  KEY idx_ro_status (status, created_at),
  KEY idx_ro_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
