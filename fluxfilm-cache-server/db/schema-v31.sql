-- FluxFilm schema v31 — 👥 who is actually in the WhatsApp group.
--
-- Group Offer plans are cheaper because the customer joins the FluxFilm WhatsApp group. Until now the shop asked
-- them to join, they tapped "I have joined", and that tap was thrown away: it lived in the browser's checkout state
-- and in Olivia's chat state, and neither outlives the session. So nothing anywhere recorded who had said yes, and
-- the only way to check the group was to scroll it by hand against a list of customers.
--
-- One row per phone number. A row is written when they CLAIM they joined, and again when a pasted participant list
-- SHOWS them — two different facts, kept apart on purpose, because the whole point is to find where they disagree.
--
-- ⚠️ phone_norm is never compared to customers.phone_norm / subscriptions.phone_norm IN SQL. This database has
-- tables in two different collations (utf8mb4_unicode_ci and the server default) and MariaDB refuses to compare
-- across them — that is exactly what silently broke the ▶️ Today count on 27 Sep 2026. Both sides are read
-- separately and matched in JavaScript. No CHARSET is declared here so the table follows the server default, the
-- same as customers / orders / subscriptions.

CREATE TABLE IF NOT EXISTS wa_group_members (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  phone_norm    VARCHAR(10)  NOT NULL,                 -- last 10 digits, the same key the rest of the app uses
  name          VARCHAR(120) NOT NULL DEFAULT '',      -- whatever we knew them as when the row was made
  claimed_at    DATETIME     NULL,                     -- when they tapped "I have joined"
  claimed_via   VARCHAR(16)  NOT NULL DEFAULT '',      -- 'shop' | 'olivia' | 'admin'
  claimed_for   VARCHAR(80)  NOT NULL DEFAULT '',      -- the service they were buying at the time
  seen_at       DATETIME     NULL,                     -- last pasted member list they appeared in
  missing_at    DATETIME     NULL,                     -- first list they were missing from AFTER being seen
  note          VARCHAR(200) NOT NULL DEFAULT '',
  UNIQUE KEY uq_wagm_phone (phone_norm),
  KEY ix_wagm_seen (seen_at)
) ENGINE=InnoDB;
