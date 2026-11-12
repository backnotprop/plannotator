-- The favicon on the daily ping. Nothing here points to anyone either.
--
-- daily_favicon: one row per (UTC day, favicon), and `n`, how many computers
-- had that favicon set that day (counted on their first ping of the day,
-- `first: 1`). Kept on its own: never next to the version, the install-age
-- bucket or the tool, so no new combination of facts is stored.
CREATE TABLE daily_favicon (
  day TEXT NOT NULL,
  favicon TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, favicon)
) WITHOUT ROWID;
