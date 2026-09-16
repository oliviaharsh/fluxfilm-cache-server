-- FluxFilm schema v27: 🪣 keep 🎬 Reel videos in Cloudflare R2 instead of the MySQL database (r2.js, feedvideo.js).
-- Run ONCE in phpMyAdmin on u339830006_fluxfilm (plain ALTER TABLE, no information_schema / PREPARE —
-- Hostinger's phpMyAdmin refuses those with #1044). If a line says "Duplicate column name", that column is
-- already there — ignore it and run the rest.
--
-- Why: Hostinger gives the shop a 3 GB database and advises not to store video in SQL. Cloudflare R2's free tier
-- is 10 GB with no charge for downloads, so the bytes move out and the videos get faster.
--
-- Until this file is run everything keeps working exactly as today: videos stay in feed_video_chunks, and admin →
-- 🍿 What's new → ⚙️ Settings → 🪣 Video storage shows a note saying to run schema-v27.sql before R2 can be used.
-- After it is run, old videos still play from the database until the owner taps "⬆️ Move videos to R2".
--
--   storage    'db'  = the bytes are in feed_video_chunks (as before)
--              'r2'  = the bytes are in the Cloudflare R2 bucket, feed_video_chunks has nothing for this id
--   r2_key     the object name inside the bucket, e.g. reels/fv0123456789abcdef.mp4
--   r2_etag    what R2 answered after the upload (a fingerprint; handy when checking a move)
--   upload_ref the S3 multipart upload id while a big video is still going up (NULL once finished / given up on)
--   moved_at   when the video was moved from the database to R2 (India time), NULL if it was born in R2
ALTER TABLE feed_videos ADD COLUMN storage VARCHAR(8) NOT NULL DEFAULT 'db';
ALTER TABLE feed_videos ADD COLUMN r2_key VARCHAR(200) NULL;
ALTER TABLE feed_videos ADD COLUMN r2_etag VARCHAR(80) NULL;
ALTER TABLE feed_videos ADD COLUMN upload_ref VARCHAR(255) NULL;
ALTER TABLE feed_videos ADD COLUMN moved_at DATETIME NULL;
ALTER TABLE feed_videos ADD INDEX idx_fv_storage (storage);
