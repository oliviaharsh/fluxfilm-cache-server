-- FluxFilm schema v19: multiple devices — same login or a separate login per device (F1).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (same plain style as schema-v13).
-- APPLIED LIVE 2026-09-15. If you run it again, "Duplicate column name" / "Duplicate key name" = already done (harmless).
--
-- The first version checked information_schema with PREPARE, which phpMyAdmin refused on Hostinger
-- (#1044 Access denied ... to database 'information_schema'); the original is kept in
-- _deleted-old-code/2026-09-15_schema-v19-information-schema/.
--
-- Until it is run the shop works exactly as before: 2+ device plans are delivered on ONE login (today's behaviour)
-- and the "Same login or separate logins?" question is hidden.
--
-- subscriptions: one row = one login. A purchase with separate logins has one row per account used, all with the
--   same order_id and group_id. group_size = how many rows the purchase has, group_index = 1..group_size
--   ("Device 1", "Device 2"). A same-login purchase is one row (group_size 1, device_count N).
--   Existing rows keep NULL = a normal single-login subscription (their meaning does not change).
-- orders.login_mode: 'same' | 'separate' — what the customer chose (raw_json LoginMode holds the same value).
ALTER TABLE subscriptions ADD COLUMN group_id VARCHAR(40) NULL;
ALTER TABLE subscriptions ADD COLUMN group_size INT NULL;
ALTER TABLE subscriptions ADD COLUMN group_index INT NULL;
ALTER TABLE subscriptions ADD INDEX idx_sub_group (group_id);
ALTER TABLE orders ADD COLUMN login_mode VARCHAR(10) NULL;
