-- Adds the `agents` column (the names of the agents the person has used,
-- "Claude Code, Codex") to a feedback table made before it existed. Additive:
-- every row stays as it is (agents NULL), and the append-only triggers in
-- schema.sql are untouched. Run once, before deploying the Worker that writes
-- the column: bun run db:migrate:agents. A second run fails with
-- "duplicate column name: agents" and changes nothing.
ALTER TABLE feedback ADD COLUMN agents TEXT;
