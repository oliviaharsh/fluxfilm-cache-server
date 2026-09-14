-- FluxFilm schema v16: paying with coins at checkout. Safe to run more than once.
-- Run in phpMyAdmin on u339830006_fluxfilm (needs schema-v15 first: it uses app_settings).
-- Until it is run, checkout works normally and the "Use my coins" option is simply not shown.

-- Coins used on an order. They are taken from the wallet (HELD) when the order is created, kept (SPENT) when it
-- is paid, and given back (RELEASED) if it is never paid or the customer starts a new order with coins.
CREATE TABLE IF NOT EXISTS coin_spends (
  order_id     VARCHAR(40)   NOT NULL,
  phone_norm   VARCHAR(10)   NOT NULL,
  coins        INT           NOT NULL,
  rupees       DECIMAL(10,2) NOT NULL,
  status       VARCHAR(10)   NOT NULL DEFAULT 'HELD',
  note         VARCHAR(200)  NULL,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NULL,
  PRIMARY KEY (order_id),
  KEY idx_coin_spends_phone (phone_norm, status),
  KEY idx_coin_spends_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
