-- FluxFilm schema v24: 💬 comments on 🍿 What's new posts (feedcomments.js). Safe to run more than once (IF NOT EXISTS).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (plain CREATE TABLE, no information_schema / PREPARE —
-- Hostinger's phpMyAdmin refuses those with #1044).
--
-- Until it is run the feed works exactly as before: posts show "💬 Comments coming soon" and nobody can comment.
--
-- feed_comments.status   visible (shown) | pending (auto-moderator unsure, waits for the owner) | hidden (owner hid it)
-- feed_comments.reason   why the moderator held it back ("number", "handle", "contact word", "mild word"), empty when clean
-- feed_comments.name     shown name at the time ("Harsh W.") — never the phone number
-- feed_comments.ip_hash  salted SHA-256 of the IP (first 24 hex), only to spot abuse — the IP itself is not stored
-- created_at / updated_at are India time (written by the app).
CREATE TABLE IF NOT EXISTS feed_comments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id     VARCHAR(20)   NOT NULL,
  phone_norm  VARCHAR(10)   NOT NULL,
  name        VARCHAR(40)   NOT NULL DEFAULT '',
  avatar_url  VARCHAR(300)  NULL,
  text        VARCHAR(600)  NOT NULL,
  status      VARCHAR(10)   NOT NULL DEFAULT 'visible',
  reason      VARCHAR(60)   NULL,
  ip_hash     CHAR(24)      NULL,
  created_at  DATETIME      NOT NULL,
  updated_at  DATETIME      NULL,
  PRIMARY KEY (id),
  KEY idx_fc_post (post_id, status, id),
  KEY idx_fc_phone (phone_norm, created_at),
  KEY idx_fc_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phones the owner blocked from commenting (admin → 💬 Comments → 🚫 Block commenter). Unblock deletes the row.
CREATE TABLE IF NOT EXISTS feed_bans (
  phone_norm  VARCHAR(10)   NOT NULL,
  reason      VARCHAR(200)  NULL,
  created_at  DATETIME      NOT NULL,
  PRIMARY KEY (phone_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
