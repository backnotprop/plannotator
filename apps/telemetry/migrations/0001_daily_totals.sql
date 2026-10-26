-- Daily totals across every computer that sent counts. One row per
-- (day, feature, rev, event, bucket); a batch adds 1 to `reports` and its
-- value to `total`. There is no column for an IP, a time, a request, a
-- country, a user agent or an install: nothing here can be tied to one.
--
-- event "_reports", bucket "": the number of batches (install-days) that day.
-- A count event's bucket is the range its value fell in (1, 2-3, 4-9, 10-29,
-- 30-100), so totals show the spread without any one install's number; a day
-- event and first_day file under "1"; days_last7 under its bucket (1, 2-3,
-- 4-5, 6-7) with total 0.
CREATE TABLE daily_totals (
  day TEXT NOT NULL,
  feature TEXT NOT NULL,
  rev INTEGER NOT NULL,
  event TEXT NOT NULL,
  bucket TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, feature, rev, event, bucket)
) WITHOUT ROWID;
