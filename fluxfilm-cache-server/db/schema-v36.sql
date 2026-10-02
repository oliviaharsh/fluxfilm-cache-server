-- FluxFilm schema v36 — the TV worker can claim a job (primetv.js + worker/)
--
-- v35 gave us the queue. This lets something take a job out of it safely.
--
-- A job goes PENDING → CLAIMED → DONE | FAILED, and the claim is an atomic UPDATE: the worker only gets the
-- row if it was still PENDING when it asked. Two workers, or a worker and the owner tapping in admin, can
-- never end up registering the same code twice.
--
-- `claimed_at` is what makes a crash survivable. A worker that dies mid-job leaves a CLAIMED row behind; the
-- server puts anything claimed and not finished back into the queue, so a dead worker costs a minute, not a
-- stuck customer at one in the morning.
--
-- `claimed_by` is only ever a label for the owner's eyes ("laptop", "vps") so he can see WHICH machine took
-- it. It is never a credential and grants nothing — the admin key is what authorises a claim.
--
-- Run this AFTER db/schema-v35.sql. Run once.

ALTER TABLE tv_activations
  ADD COLUMN claimed_at DATETIME     NULL AFTER status,
  ADD COLUMN claimed_by VARCHAR(64)  NULL AFTER claimed_at;

-- Claiming asks for the oldest PENDING row, and reaping asks for CLAIMED rows that have gone quiet.
CREATE INDEX idx_tv_claim ON tv_activations (status, claimed_at);
