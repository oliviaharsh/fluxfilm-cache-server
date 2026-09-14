-- FluxFilm schema v15: referral system ("Refer & earn") + admin-editable settings. Safe to run more than once.
-- Run in phpMyAdmin on u339830006_fluxfilm. Until it is run, checkout works normally and
-- the Refer & earn page says the feature is coming soon.

-- Settings the owner changes from the admin panel (no Hostinger env edits). value = JSON.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key  VARCHAR(64) NOT NULL,
  value        TEXT        NOT NULL,
  updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One invite code per customer (created the first time they open Refer & earn).
CREATE TABLE IF NOT EXISTS referral_codes (
  phone_norm  VARCHAR(10) NOT NULL,
  code        VARCHAR(16) NOT NULL,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_norm),
  UNIQUE KEY uq_referral_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who invited whom (a friend can only ever be invited once).
--   status: PENDING  = friend ordered with the code, first order not paid yet
--           REWARDED = friend's first order was paid (rewards are in referral_rewards)
--           NOT_NEW  = friend had already paid before using the code, no rewards
--           CAPPED   = referrer hit the monthly limit for first-order rewards
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

-- Every reward decision for a paid order - one row per (order, person, kind), so nothing is paid twice
-- and anything that failed can be retried by the "Fix missed rewards" check.
--   kind:   FIRST (friend's 1st paid order) · REPEAT (friend's next orders) · LEVEL2 (friend-of-friend's 1st order)
--           NONE  (order checked, nothing due - stops re-checking)
--   status: PENDING (being paid) · PAID · FAILED (will be retried) · SKIPPED (not due; see reason)
CREATE TABLE IF NOT EXISTS referral_rewards (
  id                 INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_id           VARCHAR(40)   NOT NULL,
  friend_phone       VARCHAR(10)   NOT NULL,
  beneficiary_phone  VARCHAR(10)   NOT NULL DEFAULT '',
  kind               VARCHAR(10)   NOT NULL,
  order_amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  percent            DECIMAL(5,2)  NOT NULL DEFAULT 0,
  coins              INT           NOT NULL DEFAULT 0,
  status             VARCHAR(10)   NOT NULL DEFAULT 'PENDING',
  reason             VARCHAR(200)  NULL,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at            DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reward (order_id, beneficiary_phone, kind),
  KEY idx_reward_beneficiary (beneficiary_phone, status),
  KEY idx_reward_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
