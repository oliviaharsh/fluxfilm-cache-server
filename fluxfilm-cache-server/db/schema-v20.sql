-- FluxFilm schema v20: customers' own profile photos (Account → Profile → 📷 Upload your photo).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (same plain style as schema-v19). Safe to run again (IF NOT EXISTS).
--
-- Until it is run the shop works exactly as before: the avatars keep working and "Upload your photo" says
-- "coming soon". Nothing else reads this table.
--
-- One row per customer phone. photo_id is random and changes on every upload; the picture is served at
-- /profile-photo/<photo_id> so the phone number is never in a URL. customers.profile_pic_url then holds
-- '/profile-photo/<photo_id>?v=...' (raw_json ProfilePicUrl the same), exactly like a picked avatar URL.
-- Pictures are ~256x256 JPEGs, at most 80 KB each (checked by photos.js).
CREATE TABLE IF NOT EXISTS customer_photos (
  phone_norm  VARCHAR(10) NOT NULL,
  photo_id    CHAR(24)    NOT NULL,
  mime        VARCHAR(20) NOT NULL,
  data        MEDIUMBLOB  NOT NULL,
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_norm),
  UNIQUE KEY uq_customer_photo_id (photo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
