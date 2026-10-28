-- Plannotator product feedback (apps/feedback-service).
--
-- One append-only table. The Worker only ever INSERTs into it; it holds the
-- words the person typed, an optional contact they typed, the Plannotator
-- version, the OS and where it was sent from. No IP, user agent, country,
-- machine id or anything else that identifies a person.
--
-- Apply with: bun run db:migrate (remote) or db:migrate:local (wrangler's local SQLite).

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  category TEXT,
  contact TEXT,
  version TEXT,
  os TEXT,
  surface TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

-- Append-only at the database too: a row, once written, is never changed or
-- removed by anything that reaches this database. To delete spam on purpose,
-- the owner drops a trigger first (README.md, "Removing a row").
CREATE TRIGGER IF NOT EXISTS feedback_append_only_update
BEFORE UPDATE ON feedback
BEGIN
  SELECT RAISE(ABORT, 'feedback is append-only');
END;

CREATE TRIGGER IF NOT EXISTS feedback_append_only_delete
BEFORE DELETE ON feedback
BEGIN
  SELECT RAISE(ABORT, 'feedback is append-only');
END;
