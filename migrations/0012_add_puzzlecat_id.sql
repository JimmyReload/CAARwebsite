-- Store the stable PuzzleCat userinfo.id so it can be used as the public /users/{profileKey}.
-- Existing users are linked on their next successful OAuth login; no ID is guessed/backfilled.
ALTER TABLE users ADD COLUMN puzzlecat_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_puzzlecat_id
  ON users(puzzlecat_id) WHERE puzzlecat_id IS NOT NULL;
INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0012_add_puzzlecat_id');
