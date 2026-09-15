-- FluxFilm schema v26: 💸 refund offers for DELIVERED plans + customer refund requests (refunds.js, refundrequests.js,
-- adminrefunds.js). Two tables: refund_offers, refund_requests. Safe to run more than once.
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

-- Customer "💸 Request refund" (Account → Request refund, refundrequests.js). A request refunds nothing by itself: the
-- owner answers it in admin → Refunds → 📨 Refund requests with Offer refund / Approve full refund / Reject.
--   kind            DELIVERED (active plan, mid-period) | UNDELIVERED (paid, not delivered, 48 h after payment)
--   delivery_state  what the server saw when the customer asked: ACTIVE | MANUAL_PENDING | NOT_DELIVERED
--   reason          NOT_WORKING | NOT_RECEIVED | NOT_NEEDED | QUALITY | OTHER (reason_text = the customer's words)
--   status          OPEN | OFFERED (a refund offer was sent) | APPROVED (full refund, customer chooses) | REJECTED
--   open_key        = order_id while OPEN, NULL once answered → one open request per order
--   estimated_charge the estimate shown to the customer (days used ÷ total days × paid); the team decides the real one
CREATE TABLE IF NOT EXISTS refund_requests (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id       VARCHAR(16)   NOT NULL,
  order_id         VARCHAR(40)   NOT NULL,
  sub_id           VARCHAR(40)   NULL,
  open_key         VARCHAR(40)   NULL,
  phone_norm       VARCHAR(10)   NOT NULL,
  service          VARCHAR(120)  NULL,
  plan             VARCHAR(120)  NULL,
  kind             VARCHAR(20)   NOT NULL,
  delivery_state   VARCHAR(30)   NULL,
  reason           VARCHAR(20)   NOT NULL,
  reason_text      VARCHAR(300)  NULL,
  paid_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  estimated_charge DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_at          DATETIME      NULL,
  status           VARCHAR(20)   NOT NULL DEFAULT 'OPEN',
  admin_message    VARCHAR(300)  NULL,
  offer_id         VARCHAR(16)   NULL,
  created_at       DATETIME      NOT NULL,
  decided_at       DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rq_request (request_id),
  UNIQUE KEY uq_rq_open (open_key),
  KEY idx_rq_phone (phone_norm, created_at),
  KEY idx_rq_status (status, created_at),
  KEY idx_rq_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
