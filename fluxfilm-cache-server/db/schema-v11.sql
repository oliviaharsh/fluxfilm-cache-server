-- =====================================================================
-- FluxFilm — MySQL schema v11 (last Apps Script actions -> MySQL)
-- Restock ("notify me when back in stock") requests, previously the
-- RESTOCK_REQUESTS sheet tab. Written by submitRestockRequest in account.js.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS restock_requests (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts          DATETIME     NOT NULL,
  name        VARCHAR(120),
  phone       VARCHAR(20),
  phone_norm  VARCHAR(15),
  service     VARCHAR(60),
  plan        VARCHAR(80),
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  notes       VARCHAR(255),
  KEY idx_phone (phone_norm),
  KEY idx_pending (phone_norm, service, plan, status),
  KEY idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The CUSTOMERS sheet carried these; MySQL only synced a subset. The profile
-- editor (account.js) now writes them straight to MySQL, so add the two columns
-- that don't exist yet.
--
-- NOTE: `updated_at` is NOT here on purpose — the base schema already defines it
-- as TIMESTAMP ... ON UPDATE CURRENT_TIMESTAMP, so it exists and maintains itself.
-- `phone_norm` likewise already exists (schema-v2).
--
-- If you have already run this file once, MySQL will say "Duplicate column name"
-- — that's fine, it just means the column is there.
ALTER TABLE customers ADD COLUMN status VARCHAR(20) NULL;
ALTER TABLE customers ADD COLUMN customer_id VARCHAR(24) NULL;
