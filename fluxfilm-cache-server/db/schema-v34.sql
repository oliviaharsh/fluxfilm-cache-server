-- FluxFilm schema v34 — ⭐ customer reviews, with the owner's reply underneath (owner request, 1 Oct 2026).
--
-- One review per customer (UNIQUE on phone_norm): they can rewrite theirs, they cannot stack five of them.
-- Only a customer with a PAID order may write one — that check lives in reviews.js, because phone columns are
-- never compared across tables in SQL (orders and this table do not share a collation).
--
-- Collation matches the other new tables (feed_*, refund_*, bank_credit_links): utf8mb4_unicode_ci.
-- Until this file is run, reviews.js answers { ready: false } and the storefront simply shows no reviews.

CREATE TABLE IF NOT EXISTS reviews (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  phone_norm  VARCHAR(10)  NOT NULL,
  name        VARCHAR(40)  NOT NULL,              -- "Harsh W." — first name + last initial, never the phone
  avatar_url  VARCHAR(512) NULL,
  rating      TINYINT      NOT NULL,              -- 1..5
  service     VARCHAR(80)  NULL,                  -- which plan it is about, optional
  text        VARCHAR(400) NOT NULL,
  status      VARCHAR(10)  NOT NULL DEFAULT 'visible',   -- visible | pending | hidden
  reason      VARCHAR(40)  NULL,                  -- why the moderator held it
  reply       VARCHAR(400) NULL,                  -- the owner's answer, shown under the review
  replied_at  DATETIME     NULL,
  ip_hash     CHAR(64)     NULL,                  -- salted hash only, never the address
  created_at  DATETIME     NOT NULL,
  updated_at  DATETIME     NULL,
  UNIQUE KEY uq_reviews_phone (phone_norm),
  KEY ix_reviews_status (status, id),
  KEY ix_reviews_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
