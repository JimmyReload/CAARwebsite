-- Cached publicly visible completed Hunt keys for profile-linked local users.
-- One bounded snapshot row; no OAuth tokens, email or private profile contents.
-- retry_after is deliberately added and registered by the next migration (0014).
CREATE TABLE IF NOT EXISTS hunt_completion_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0013_hunt_completion_cache');
