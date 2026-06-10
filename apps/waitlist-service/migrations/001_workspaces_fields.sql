-- 001_workspaces_fields.sql
--
-- Aligns the schema with the prototype redesign of the workspaces page.
-- The form now collects `note` (free-text) and `is_contributor` (bool); the
-- old `role` / `tools` / `use_cases` fields were dropped from the form. We
-- leave the original columns in place so any existing rows are preserved
-- untouched — they simply stop being written to.
--
-- Apply with:
--   bunx wrangler d1 execute plannotator-waitlist --remote \
--     --file=./migrations/001_workspaces_fields.sql
--
-- NOT idempotent: SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so
-- re-running this errors with "duplicate column name". Run it exactly once.

ALTER TABLE waitlist ADD COLUMN note TEXT;
ALTER TABLE waitlist ADD COLUMN is_contributor INTEGER NOT NULL DEFAULT 0;
