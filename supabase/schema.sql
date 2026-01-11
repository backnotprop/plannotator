-- Plannotator Collaborative Sessions Schema
-- Run this in your Supabase SQL Editor to set up the database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sessions table: stores the plan markdown for each collaborative session
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Annotations table: stores annotations for each session
-- Note: id is TEXT (not UUID) because client generates IDs like "global-123" from web-highlighter
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('DELETION', 'INSERTION', 'REPLACEMENT', 'COMMENT', 'GLOBAL_COMMENT')),
  original_text TEXT NOT NULL,
  text TEXT, -- For comments/replacements/insertions
  author TEXT, -- Tater identity
  position_context TEXT, -- Text context for locating annotation
  image_paths TEXT[], -- Array of image paths/URLs
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ -- Soft delete
);

-- Index for faster session lookups
CREATE INDEX IF NOT EXISTS idx_annotations_session_id ON annotations(session_id);

-- Index for filtering non-deleted annotations
CREATE INDEX IF NOT EXISTS idx_annotations_deleted_at ON annotations(deleted_at) WHERE deleted_at IS NULL;

-- Trigger to auto-update updated_at on sessions
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;

-- Public access policies (anyone can read/write - no auth required)
-- Note: For production, you may want to add rate limiting or auth

-- Sessions: Allow all operations
CREATE POLICY "Sessions are publicly accessible"
  ON sessions FOR ALL
  USING (true)
  WITH CHECK (true);

-- Annotations: Allow all operations
CREATE POLICY "Annotations are publicly accessible"
  ON annotations FOR ALL
  USING (true)
  WITH CHECK (true);

-- Enable realtime for both tables
-- Run this in Supabase Dashboard > Database > Replication
-- Or via SQL:
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE annotations;

-- Grant permissions for anon key access
GRANT ALL ON sessions TO anon;
GRANT ALL ON annotations TO anon;
GRANT USAGE ON SCHEMA public TO anon;
