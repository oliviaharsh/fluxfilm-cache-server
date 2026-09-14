-- FluxFilm schema v15: referral system ("Refer & earn"). Safe to run more than once.
-- Run in phpMyAdmin on u339830006_fluxfilm. Until it is run, checkout works normally and
-- the Refer & earn page says the feature is not switched on yet.

-- One invite code per customer (created the first time they open Refer & earn).
CREATE TABLE IF NOT EXISTS referral_codes (
  phone_norm  VARCHAR(10) NOT NULL,
  code        VARCHAR(16) NOT NULL,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_norm),
  UNIQUE KEY uq_referral_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per invited friend (a friend can only ever be referred once).
--   status: PENDING  = friend ordered with the code, not paid yet
--           REWARDED = friend's first order was paid, referrer got the coins
--           NOT_NEW  = friend already had a paid order, no reward
--           CAPPED   = referrer hit the monthly limit, no reward
CREATE TABLE IF NOT EXISTS referrals (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code             VARCHAR(16)  NOT NULL,
  referrer_phone   VARCHAR(10)  NOT NULL,
  friend_phone     VARCHAR(10)  NOT NULL,
  status           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  friend_order_id  VARCHAR(40)  NULL,
  discount         INT          NOT NULL DEFAULT 0,
  reward_coins     INT          NOT NULL DEFAULT 0,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NULL,
  rewarded_at      DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_friend (friend_phone),
  KEY idx_referral_referrer (referrer_phone, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
