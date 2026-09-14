-- FluxFilm schema v19: multiple devices — same login or a separate login per device (F1). Safe to run more than once.
-- Run in phpMyAdmin on u339830006_fluxfilm. Works on MySQL 8 and MariaDB: every column / index is added only when
-- it is missing (information_schema check + prepared statement = "ADD COLUMN IF NOT EXISTS" on both).
--
-- Until it is run the shop works exactly as before: 2+ device plans are delivered on ONE login (today's behaviour)
-- and the "Same login or separate logins?" question is hidden.
--
-- subscriptions: one row = one login. A purchase with separate logins has one row per account used, all with the
--   same order_id and group_id. group_size = how many rows the purchase has, group_index = 1..group_size
--   ("Device 1", "Device 2"). A same-login purchase is one row (group_size 1, device_count N).
--   Existing rows keep NULL = a normal single-login subscription (their meaning does not change).
-- orders.login_mode: 'same' | 'separate' — what the customer chose (raw_json LoginMode holds the same value).
SET NAMES utf8mb4;

SET @db := DATABASE();

SET @q := IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'subscriptions' AND column_name = 'group_id') = 0,
  'ALTER TABLE subscriptions ADD COLUMN group_id VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;

SET @q := IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'subscriptions' AND column_name = 'group_size') = 0,
  'ALTER TABLE subscriptions ADD COLUMN group_size INT NULL', 'SELECT 1');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;

SET @q := IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'subscriptions' AND column_name = 'group_index') = 0,
  'ALTER TABLE subscriptions ADD COLUMN group_index INT NULL', 'SELECT 1');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;

SET @q := IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = @db AND table_name = 'subscriptions' AND index_name = 'idx_sub_group') = 0,
  'ALTER TABLE subscriptions ADD INDEX idx_sub_group (group_id)', 'SELECT 1');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;

SET @q := IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'orders' AND column_name = 'login_mode') = 0,
  'ALTER TABLE orders ADD COLUMN login_mode VARCHAR(10) NULL', 'SELECT 1');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;

-- Check: should show 4.
SELECT COUNT(*) AS columns_ready FROM information_schema.columns
 WHERE table_schema = @db AND ((table_name = 'subscriptions' AND column_name IN ('group_id', 'group_size', 'group_index')) OR (table_name = 'orders' AND column_name = 'login_mode'));
