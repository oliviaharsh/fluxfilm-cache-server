-- FluxFilm schema v21: Olivia, the AI store manager (chat on the website). Safe to run more than once (IF NOT EXISTS).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (needs schema-v15 for app_settings).
--
-- Until it is run, the shop works exactly as before: Help opens WhatsApp, and admin → 🤖 Olivia asks for this file.
-- Settings (on/off, test phones, AI words, WhatsApp link, voice guide) live in app_settings ('olivia').
-- Login details are NEVER stored here: a login shown in the chat is logged only as "[login shown in app]".

-- One row per chat. state_json = which step the chat is on + the chosen plan / order id (no tokens, no logins).
CREATE TABLE IF NOT EXISTS olivia_conversations (
  id          CHAR(32)      NOT NULL,
  phone_norm  VARCHAR(10)   NOT NULL,
  lang        VARCHAR(10)   NOT NULL DEFAULT '',
  step        VARCHAR(40)   NOT NULL DEFAULT '',
  state_json  TEXT          NULL,
  status      VARCHAR(16)   NOT NULL DEFAULT 'OPEN',
  order_id    VARCHAR(40)   NULL,
  turns       INT           NOT NULL DEFAULT 0,
  ai_calls    INT           NOT NULL DEFAULT 0,
  ai_tokens   INT           NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL,
  updated_at  DATETIME      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_olivia_phone (phone_norm, updated_at),
  KEY idx_olivia_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every message in and out (the audit trail). role: customer | olivia. ai = 1 when DeepSeek wrote the words.
-- meta_json = what Olivia checked (e.g. {"tool":"checkPayment","paid":false}) — never a login, token or password.
CREATE TABLE IF NOT EXISTS olivia_messages (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id  CHAR(32)      NOT NULL,
  role             VARCHAR(10)   NOT NULL,
  intent           VARCHAR(40)   NOT NULL DEFAULT '',
  body             TEXT          NULL,
  meta_json        TEXT          NULL,
  ai               TINYINT(1)    NOT NULL DEFAULT 0,
  created_at       DATETIME      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_olivia_msg_conv (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SELECT COUNT(*) AS olivia_tables_ready FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_name IN ('olivia_conversations', 'olivia_messages');
