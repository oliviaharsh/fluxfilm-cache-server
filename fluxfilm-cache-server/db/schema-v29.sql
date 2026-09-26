-- FluxFilm schema v29 — ▶️ YouTube families (the tracker the owner kept in a spreadsheet).
--
-- YouTube Premium is the one service that is NOT delivered on one of our logins: we INVITE the customer's own
-- Google address into one of our Google families. So there is no profile and no seat to point at, and until now
-- nothing in MySQL said which family a customer had been invited to — all 40 YouTube subscriptions have
-- inventory_ref NULL. The map lived only in a sheet, so "which family is this person in" and "how much room is
-- left" could not be answered by the shop at all.
--
-- Deliberately NOT stored in inventory_accounts / inventory_capacity: those tables feed allocation, stock and the
-- 🚪 Remove users grouping, and a Google family is not an account we hand over. Putting it there would change
-- live selling behaviour to gain nothing. YouTube stays a MANUAL service (fulfill.js), untouched.
--
-- Until this file is run: the ▶️ YouTube families screen says to run it, and nothing else in the panel changes.
--
--   yt_families  one of our Google family accounts, and how many invited members it holds
--   yt_seats     one invitation: which subscription sits in which family, and when it left
--
-- A seat with left_on NULL is a seat in use. Releasing a seat sets left_on and keeps the row, so the screen can
-- still say who used to be in a family (the same reason 🚪 Remove users keeps ticked rows).

CREATE TABLE IF NOT EXISTS yt_families (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  login      VARCHAR(190) NOT NULL,                  -- the family manager's Google address
  label      VARCHAR(120) NOT NULL DEFAULT '',       -- what the owner calls it, if anything
  slots      TINYINT UNSIGNED NOT NULL DEFAULT 5,    -- invited members Google allows besides the manager
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  notes      VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ytf_login (login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS yt_seats (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id     INT UNSIGNED NOT NULL,
  sub_id        VARCHAR(64)  NOT NULL,               -- subscriptions.sub_id
  invited_email VARCHAR(190) NOT NULL DEFAULT '',    -- the address actually invited (normally the sub's own)
  joined_on     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_on       DATETIME     NULL DEFAULT NULL,      -- NULL = still in the family
  note          VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY idx_yts_family (family_id, left_on),
  KEY idx_yts_sub (sub_id, left_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
