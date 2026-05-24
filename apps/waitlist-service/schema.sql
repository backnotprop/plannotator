-- Plannotator Workspaces waitlist
--
-- Authoritative schema for from-scratch deploys. The current production
-- schema is this file PLUS the migrations under `migrations/` (already
-- applied). For a fresh database, this file alone is sufficient.
--
-- Run with: bun run db:migrate (remote) or db:migrate:local (local dev)

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- `name` is no longer collected by the form. Kept NOT NULL with an empty
  -- string default so the live D1 schema (which has NOT NULL with no default)
  -- can be brought into line via the 002 migration without losing rows.
  name TEXT NOT NULL DEFAULT '',
  company TEXT,
  company_inferred INTEGER NOT NULL DEFAULT 0,
  team_size TEXT,
  note TEXT,
  is_contributor INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  country TEXT,
  user_agent TEXT,
  referer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_company ON waitlist(company);

-- Per-IP daily rate-limit counter, prunable on a schedule.
CREATE TABLE IF NOT EXISTS rate_limit (
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
