-- FluxFilm schema v17: payment fallback ("Payment not going through / limit reached?"). Safe to run more than once.
-- Run in phpMyAdmin on u339830006_fluxfilm (needs schema-v15 first: it uses app_settings).
-- Until it is run, checkout and normal auto-verify work as before; the "I've paid" form tells customers to use
-- WhatsApp support instead, and admin → 💸 Payments asks for this file.

-- The backup QR image is stored as a picture in app_settings ('payfallback_qr'), which needs more than TEXT (64 KB).
ALTER TABLE app_settings MODIFY value MEDIUMTEXT NOT NULL;

-- "I've paid" claims from customers who paid the backup UPI ID / QR (bank alert without the order id).
--   status: WAITING  = looking for the bank alert (re-checked when bank mail arrives + every minute)
--           REVIEW   = needs the owner (two candidates, partial name, nothing found after the review time…)
--           MATCHED  = matched automatically (UTR, or one strong name + amount + time match)
--           APPROVED / REJECTED = decided by the owner in admin → 💸 Payments
--           REPLACED = the customer sent corrected details (newer row)
--   source: CUSTOMER (form) · LEARNED (matched by a payer name this customer used before, no form)
CREATE TABLE IF NOT EXISTS payment_claims (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_id      VARCHAR(40)   NOT NULL,
  phone_norm    VARCHAR(10)   NOT NULL DEFAULT '',
  amount        DECIMAL(10,2) NOT NULL DEFAULT 0,
  payer_name    VARCHAR(80)   NOT NULL DEFAULT '',
  utr           VARCHAR(20)   NULL,
  status        VARCHAR(12)   NOT NULL DEFAULT 'WAITING',
  reason        VARCHAR(200)  NULL,
  credit_id     BIGINT        NULL,
  candidates    TEXT          NULL,
  source        VARCHAR(12)   NOT NULL DEFAULT 'CUSTOMER',
  admin_note    VARCHAR(200)  NULL,
  created_at    DATETIME      NOT NULL,
  updated_at    DATETIME      NULL,
  decided_at    DATETIME      NULL,
  PRIMARY KEY (id),
  KEY idx_claims_order (order_id),
  KEY idx_claims_status (status, created_at),
  KEY idx_claims_credit (credit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Payer names a customer has paid with (learned from confirmed payments), so a later plain-QR payment from the
-- same name + amount + time can be matched to their unpaid order without a form.
CREATE TABLE IF NOT EXISTS customer_payer_names (
  phone_norm    VARCHAR(10)  NOT NULL,
  name_norm     VARCHAR(80)  NOT NULL,
  name_display  VARCHAR(80)  NOT NULL DEFAULT '',
  first_seen    DATETIME     NOT NULL,
  last_used     DATETIME     NOT NULL,
  times_used    INT          NOT NULL DEFAULT 1,
  PRIMARY KEY (phone_norm, name_norm),
  KEY idx_payer_name (name_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
