-- FluxFilm schema v30 — a ▶️ YouTube family place for somebody who has no subscription.
--
-- Vishal R Vipin is an old customer the owner gives YouTube to for nothing, so there is no subscription row to
-- hang a place on. Before this, flixfilm157 read 4/5 when it was really full — and "how many places are free" is
-- the one number that screen exists to get right, so a place that cannot be recorded is a bug, not a gap.
--
-- After this a seat is one of two things:
--   sub_id filled  → an ordinary customer; the name, email and expiry come from the subscription
--   sub_id NULL    → a guest; the name and email live on the seat itself and there is no expiry to show
--
-- Until this file is run: everything on the ▶️ YouTube families screen keeps working exactly as it does now;
-- only "＋ Someone with no plan" says to run it. Nothing is lost and no existing row changes.

ALTER TABLE yt_seats MODIFY COLUMN sub_id VARCHAR(64) NULL DEFAULT NULL;
ALTER TABLE yt_seats ADD COLUMN person VARCHAR(120) NOT NULL DEFAULT '' AFTER sub_id;
