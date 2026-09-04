-- FluxFilm schema v12: MySQL-backed TRENDING storefront ticker.
-- Run once in phpMyAdmin before deploying the database-only storefront.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS trending_items (
  item_key   VARCHAR(255) NOT NULL,
  active     VARCHAR(8)   DEFAULT 'TRUE',
  title      VARCHAR(255) DEFAULT NULL,
  platform   VARCHAR(120) DEFAULT NULL,
  line       VARCHAR(500) DEFAULT NULL,
  sort_order INT          DEFAULT 0,
  raw_json   JSON         DEFAULT NULL,
  synced_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (item_key),
  KEY idx_trending_active_sort (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
