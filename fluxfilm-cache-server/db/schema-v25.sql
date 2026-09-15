-- FluxFilm schema v25: ❤️ liked and 🔖 saved 🍿 What's new posts follow the customer's account (feedmarks.js),
-- plus 🎬 uploaded Reel videos (feedvideo.js, at the end of this file).
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

-- 🎬 Uploaded Reel videos (feedvideo.js; admin → 🍿 What's new → Post type: Reel → Upload video).
-- Stored in MySQL (owner's choice) because Hostinger rebuilds the app folder on every deploy (a file next to the code
-- would vanish). Raw binary, cut into 1 MB chunks (MEDIUMBLOB) so no single insert comes near max_allowed_packet.
-- The bytes count toward the Hostinger disk quota and the database size. Limits (admin setting): one video ≤ 25 MB
-- (max 50), all videos ≤ 2 GB, MP4 / WebM only (checked by the first bytes), ≤ 90 s.
-- sha256 = the file's SHA-256 from the admin browser; the server checks the chunks against it before status → ready.
-- status: uploading (parts still coming, removed after a day) | ready.
-- Until these two tables exist, Reels still work with YouTube Shorts / Instagram links; uploading says "run schema-v25".
CREATE TABLE IF NOT EXISTS feed_videos (
  id          VARCHAR(24)    NOT NULL,
  mime        VARCHAR(20)    NOT NULL,
  size_bytes  INT UNSIGNED   NOT NULL,
  chunks      INT UNSIGNED   NOT NULL,
  sha256      CHAR(64)       NOT NULL,
  duration_s  DECIMAL(6,1)   NULL,
  status      VARCHAR(10)    NOT NULL DEFAULT 'uploading',
  created_at  DATETIME       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_fv_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feed_video_chunks (
  video_id    VARCHAR(24)    NOT NULL,
  n           INT UNSIGNED   NOT NULL,
  data        MEDIUMBLOB     NOT NULL,
  PRIMARY KEY (video_id, n)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
