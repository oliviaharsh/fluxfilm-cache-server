-- FluxFilm schema v21: 🎮 Games (shop.fluxfilm.in/games) - plays, prizes and quiz / emoji questions.
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (same plain style as schema-v19/v20). Safe to run again (IF NOT EXISTS).
--
-- Until it is run the shop works exactly as before and /games says "Games are coming soon".
-- Settings (free plays, prices, prizes, difficulty) live in app_settings['games'] (admin → 🎮 Games) - no table needed.
-- Coins won / spent go through the normal wallet + coins_ledger (events GAME_WIN, GAME_STREAK, GAME_PLAY).
-- Coupons won are normal rows in `coupons` locked to the winner's phone (AllowedPhones, 1 use, expiry).

-- One row per game played.
--   kind:      FREE (the daily free play) · PAID (extra play bought with coins) · PRACTICE (no prize: not a customer /
--              not verified yet) · BONUS (streak reward row, game = 'streak')
--   free_slot: 1..N for FREE plays, so two taps at once can never give two free plays (unique key). NULL otherwise.
--   seed_json: server-only round data (right answers, ball plan, keeper moves) - never sent to the browser.
--   status:    STARTED → DONE (or EXPIRED when never finished)
CREATE TABLE IF NOT EXISTS game_plays (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone_norm    VARCHAR(10)      NOT NULL,
  game          VARCHAR(16)      NOT NULL,
  play_date     DATE             NOT NULL,
  kind          VARCHAR(8)       NOT NULL,
  free_slot     TINYINT UNSIGNED NULL,
  cost          INT              NOT NULL DEFAULT 0,
  status        VARCHAR(10)      NOT NULL DEFAULT 'STARTED',
  seed_json     MEDIUMTEXT       NULL,
  score         INT              NOT NULL DEFAULT 0,
  result_json   TEXT             NULL,
  coins_won     INT              NOT NULL DEFAULT 0,
  coupon_code   VARCHAR(20)      NULL,
  coupon_value  INT              NOT NULL DEFAULT 0,
  flagged       VARCHAR(120)     NULL,
  ip            VARCHAR(45)      NULL,
  started_ms    BIGINT           NOT NULL DEFAULT 0,
  started_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_free (phone_norm, game, play_date, free_slot),
  KEY idx_game_phone_date (phone_norm, play_date),
  KEY idx_game_date (play_date, game)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Movie Quiz (kind QUIZ) and Emoji Guess (kind EMOJI) questions, edited in admin → 🎮 Games.
-- answer = 0..3 (which option is right). For EMOJI, question = the emoji clue.
CREATE TABLE IF NOT EXISTS quiz_questions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind        VARCHAR(8)   NOT NULL DEFAULT 'QUIZ',
  question    VARCHAR(255) NOT NULL,
  opt_a       VARCHAR(120) NOT NULL,
  opt_b       VARCHAR(120) NOT NULL,
  opt_c       VARCHAR(120) NOT NULL,
  opt_d       VARCHAR(120) NOT NULL,
  answer      TINYINT      NOT NULL DEFAULT 0,
  category    VARCHAR(40)  NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  source      VARCHAR(80)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_quiz_question (kind, question),
  KEY idx_quiz_kind_active (kind, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
