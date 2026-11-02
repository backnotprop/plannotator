-- The daily ping's totals: one row per (UTC day, version, age bucket), and
-- `n`, how many computers sent a ping in it that day. There is no column for
-- an IP, a time, a header, a country or an ID: nothing here points to anyone.
CREATE TABLE daily (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  age INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, age)
) WITHOUT ROWID;
