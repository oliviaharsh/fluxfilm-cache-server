-- FluxFilm schema v18: push notifications (renewal reminders on the customer's phone). Safe to run more than once.
-- Run in phpMyAdmin on u339830006_fluxfilm (needs schema-v14 for reminder_log and schema-v15 for app_settings).
-- Until it is run, the shop works as before: the "Get renewal reminders" button says it is not available yet,
-- automatic reminders do nothing, and admin → 🔔 Notifications asks for this file.
-- Settings (on/off, days, hours, messages) and the VAPID key live in app_settings ('push_settings', 'push_vapid').

-- One row per browser / installed app that allowed notifications.
--   app: 'store' = customer device (phone set) · 'admin' = the owner's device for test / admin notifications
--   (the same browser can be both: then app = 'admin' and phone is the customer's phone).
--   Rows are deleted when the push service says the device is gone (404 / 410); disabled after 10 failures in a row.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone         VARCHAR(20)   NOT NULL DEFAULT '',
  phone_norm    VARCHAR(10)   NOT NULL DEFAULT '',
  endpoint      VARCHAR(700)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  p256dh        VARCHAR(120)  NOT NULL,
  auth          VARCHAR(40)   NOT NULL,
  user_agent    VARCHAR(200)  NULL,
  app           VARCHAR(10)   NOT NULL DEFAULT 'store',
  created_at    DATETIME      NOT NULL,
  last_ok_at    DATETIME      NULL,
  fail_count    INT           NOT NULL DEFAULT 0,
  disabled      TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_endpoint (endpoint),
  KEY idx_push_phone (phone_norm, disabled),
  KEY idx_push_app (app, disabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- "Already sent?" checks use reminder_log (channel 'PUSH') and its existing (sub_id, kind) index — no change needed.
