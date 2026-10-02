-- FluxFilm schema v35 — 📺 Activate my TV (primetv.js)
--
-- A customer reads the 6-character code off their TV and types it into FluxFilm; we redeem it against THEIR
-- assigned Prime account, so they never need the password and never register a device we have not counted.
--
-- One table. It is a QUEUE, not a record of devices: the owner (and later the worker) claims a row, does the
-- registration, and writes back what happened. The device ledger that tracks what is registered and when it
-- must be removed is schema-v36, after the activation path is proven.
--
-- 🔒 `code` is short-lived by nature (Amazon expires it in ~10 minutes) and is cleared the moment the row
-- stops being PENDING. It is never written to a log.
--
-- Safe to run twice.

CREATE TABLE IF NOT EXISTS tv_activations (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  sub_id       VARCHAR(64)  NOT NULL,          -- whose TV slot this is
  account_id   VARCHAR(64)  NOT NULL,          -- which Prime account must redeem it (from subscriptions.inventory_ref)
  phone_norm   VARCHAR(16)  NOT NULL,
  service      VARCHAR(64)  NOT NULL DEFAULT '',
  code         VARCHAR(16)  NOT NULL DEFAULT '',
  -- PENDING → DONE | FAILED | EXPIRED
  status       VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  why          VARCHAR(160) NULL,              -- the reason it failed. Never a guess.
  device_name  VARCHAR(160) NULL,              -- read back from Amazon after it registers: the handle for removal
  created_at   DATETIME     NOT NULL,
  finished_at  DATETIME     NULL,
  KEY k_status (status, created_at),
  KEY k_sub (sub_id),
  KEY k_phone (phone_norm, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
