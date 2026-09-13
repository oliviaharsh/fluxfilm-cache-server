-- FluxFilm schema v14: admin tools (to-dos, change log, reminders, profit).
-- Run once in phpMyAdmin (database u339830006_fluxfilm) before merging the admin-tools PRs.
-- Safe to run twice: every table uses IF NOT EXISTS.
SET NAMES utf8mb4;

-- Owner's own to-do items on the Today screen.
CREATE TABLE IF NOT EXISTS admin_todos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  note TEXT NULL,
  due_date DATE NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  done_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_todos_open (done, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Change log: every admin action that changes data (who = the admin panel, from which IP).
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NULL,
  entity_id VARCHAR(120) NULL,
  summary VARCHAR(500) NULL,
  details TEXT NULL,
  ip VARCHAR(64) NULL,
  KEY idx_audit_ts (ts),
  KEY idx_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Renewal reminders and password-change emails that were sent (so nobody is emailed twice).
CREATE TABLE IF NOT EXISTS reminder_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sub_id VARCHAR(40) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  kind VARCHAR(30) NOT NULL,
  expiry_date DATETIME NULL,
  ok TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(300) NULL,
  KEY idx_reminder_sub (sub_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- What each account costs per month (profit view).
CREATE TABLE IF NOT EXISTS account_costs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  service VARCHAR(80) NOT NULL,
  account_id VARCHAR(80) NOT NULL,
  monthly_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  note VARCHAR(300) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_account_cost (service, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
