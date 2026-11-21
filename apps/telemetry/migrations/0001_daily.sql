-- The daily ping's totals. Nothing here points to anyone: there is no column
-- for an IP, a time, a header, a country or an ID.
--
-- daily: one row per (UTC day, version, install-age bucket, tool), and `n`,
-- how many computers used that tool that day.
CREATE TABLE daily (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  age_week INTEGER NOT NULL,
  tool TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, age_week, tool)
) WITHOUT ROWID;

-- daily_total: one row per (UTC day, version, install-age bucket), and `n`,
-- how many computers used Plannotator at all that day (their first ping of
-- the day carries `first: 1`).
CREATE TABLE daily_total (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  age_week INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, age_week)
) WITHOUT ROWID;
