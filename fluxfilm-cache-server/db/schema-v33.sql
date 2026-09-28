-- FluxFilm schema v33 — one person, two FluxFilm accounts.
--
-- Found on 27 Sep 2026 while checking Yash: 16 customers have two rows with the SAME email and two different
-- phone numbers, and 20 have two rows with the same name. No two rows share a number, so the number is always
-- what splits them. It costs money twice over:
--   · a customer who signs in on the number with no plan sees an empty My plans and BUYS AGAIN instead of
--     renewing — which is exactly what Yash did;
--   · and on 29 Sep it stopped ten people being found in the WhatsApp group, because a name that two customer
--     rows share cannot be matched to either of them.
--
-- This records that two accounts are one person. It does NOT merge them: nothing is moved, nothing is deleted,
-- no order and no subscription is touched, and unlinking puts it back exactly as it was. A merge would have to
-- rewrite money rows to be worth anything, and that is not a thing to do on a hunch about an email address.
--
--   phone_norm     the duplicate account
--   primary_phone  the account to treat as the real one
--
-- ⚠️ Never joined against customers / subscriptions in SQL: this database has tables in two collations and
-- MariaDB refuses the comparison. Read separately, matched on the 10-digit phone in JavaScript.

CREATE TABLE IF NOT EXISTS customer_links (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  phone_norm     VARCHAR(10)  NOT NULL,
  primary_phone  VARCHAR(10)  NOT NULL,
  linked_at      DATETIME     NOT NULL,
  linked_by      VARCHAR(16)  NOT NULL DEFAULT 'admin',
  note           VARCHAR(200) NOT NULL DEFAULT '',
  UNIQUE KEY uq_cl_phone (phone_norm),
  KEY ix_cl_primary (primary_phone)
) ENGINE=InnoDB;
