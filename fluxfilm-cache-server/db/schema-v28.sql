-- FluxFilm schema v28: 🧾 one bank payment that pays SEVERAL orders (admin 🏦 Bank payments → 🔗 Link).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (plain CREATE TABLE, no information_schema / PREPARE —
-- Hostinger's phpMyAdmin refuses those with #1044). Safe to run again: "table already exists" = already done.
--
-- Why: customers often pay for two plans in one UPI transfer (Netflix ₹139 + JioHotstar ₹66 = ₹205), but
-- bank_credits can only remember ONE order in consumed_order_id. The extra orders live here.
--   credit_id  bank_credits.id of the payment
--   order_id   one order it paid
--   amount     that order's share of the payment (the order's own amount)
-- The FIRST part is also written to bank_credits.consumed_order_id, so every older screen, export and report
-- keeps working unchanged. A payment with no rows here is an ordinary one-order payment.
--
-- Until this file is run: everything on the 🏦 Bank payments screen keeps working; only "this payment covers
-- more than one order" says to run it. Nothing is lost.
CREATE TABLE IF NOT EXISTS bank_credit_links (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credit_id  BIGINT UNSIGNED NOT NULL,
  order_id   VARCHAR(40)     NOT NULL,
  amount     DECIMAL(10,2)   NOT NULL DEFAULT 0,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bcl_pair (credit_id, order_id),
  UNIQUE KEY uq_bcl_order (order_id),
  KEY idx_bcl_credit (credit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
