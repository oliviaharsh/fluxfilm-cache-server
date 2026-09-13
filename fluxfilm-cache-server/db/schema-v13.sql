-- FluxFilm schema v13: who we removed from an account, and when (renewal rules F4).
-- Run once in phpMyAdmin BEFORE merging the renewal-rules code and before any /admin/sync.
SET NAMES utf8mb4;

ALTER TABLE subscriptions ADD COLUMN removed TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN removed_at DATETIME NULL;

-- Import the Sheet's "RemovedFromDevice" tick for legacy rows. removed_at stays
-- empty: a tick without a time is treated as "removed at expiry" (decided 2026-09-13).
UPDATE subscriptions
   SET removed = 1
 WHERE removed = 0
   AND raw_json IS NOT NULL
   AND UPPER(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.RemovedFromDevice'))) IN ('TRUE', '1', 'YES');
