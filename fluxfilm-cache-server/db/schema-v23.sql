-- FluxFilm schema v23: "Not a sale" on bank payments (admin 🏦 Bank payments).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (plain ALTER TABLE, no information_schema / PREPARE —
-- Hostinger's phpMyAdmin refuses those with #1044).
-- If you run it again, "Duplicate column name" / "Duplicate key name" = already done (harmless).
--
-- Until it is run the 🏦 Bank payments screen still works: "Not a sale" is kept in
-- app_settings['bank_credit_ignores'] instead, and both places are read.
--
-- bank_credits.ignored_at      when the owner marked this credit "Not a sale" (NULL = a normal payment)
-- bank_credits.ignored_reason  PERSONAL | PAYTM_SETTLEMENT | REFUND | TEST | OTHER
-- bank_credits.ignored_note    optional note (required for OTHER)
ALTER TABLE bank_credits ADD COLUMN ignored_at DATETIME NULL;
ALTER TABLE bank_credits ADD COLUMN ignored_reason VARCHAR(40) NULL;
ALTER TABLE bank_credits ADD COLUMN ignored_note VARCHAR(300) NULL;
ALTER TABLE bank_credits ADD INDEX idx_bc_received (received_at);
