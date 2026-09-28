-- FluxFilm schema v32 — how we know somebody is in the WhatsApp group.
--
-- Half the community is saved in the owner's contacts, so an exported chat writes the name he saved
-- ("FF - (YT) Alok Yadav joined using this community's invite link") and never a number. Measured on the real
-- export, 29 Sep 2026: 1129 join lines, 598 of them with no number in them at all. Twenty of the thirty-eight
-- customers being chased as "paying but not in the group" were in it the whole time, under a name.
--
-- Those can be matched to a customer by name — but a name is NOT a key. Only an exact, single match counts, and
-- a row that got there by name has to say so, so it can be disbelieved when it is wrong.
--
--   seen_by = 'number'  the export carried their phone number. Certain.
--   seen_by = 'name'    matched from a display name to exactly one customer. Good enough to act on, not certain.
--   seen_by = ''        an older row, from before this column existed.
--
-- Everything works without this column: the code falls back to writing rows without it and says on the screen
-- that the provenance is unknown until the migration is run.

ALTER TABLE wa_group_members
  ADD COLUMN seen_by VARCHAR(8) NOT NULL DEFAULT '' AFTER seen_at;
