-- FluxFilm schema v25: ❤️ liked and 🔖 saved 🍿 What's new posts follow the customer's account (feedmarks.js).
-- Safe to run more than once (IF NOT EXISTS). Run ONCE in phpMyAdmin on u339830006_fluxfilm (plain CREATE TABLE,
-- no information_schema / PREPARE — Hostinger's phpMyAdmin refuses those with #1044).
--
-- Until it is run the feed works exactly as before: likes and saves stay on that phone only (localStorage), and
-- admin → 🍿 What's new shows a note that schema-v25 is needed.
--
-- One row per (phone, post). phone_norm = last 10 digits, the same key every other table uses. No names, no IPs.
-- created_at is India time (written by the app) and orders the ❤️ Liked / 🔖 Saved grids (newest first).
-- The like COUNT shown under posts still lives in app_settings feed_stats (feed.js); this table only remembers WHO liked.
CREATE TABLE IF NOT EXISTS feed_likes (
  phone_norm  VARCHAR(10)   NOT NULL,
  post_id     VARCHAR(20)   NOT NULL,
  created_at  DATETIME      NOT NULL,
  PRIMARY KEY (phone_norm, post_id),
  KEY idx_fl_phone (phone_norm, created_at),
  KEY idx_fl_post (post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feed_saves (
  phone_norm  VARCHAR(10)   NOT NULL,
  post_id     VARCHAR(20)   NOT NULL,
  created_at  DATETIME      NOT NULL,
  PRIMARY KEY (phone_norm, post_id),
  KEY idx_fs_phone (phone_norm, created_at),
  KEY idx_fs_post (post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
