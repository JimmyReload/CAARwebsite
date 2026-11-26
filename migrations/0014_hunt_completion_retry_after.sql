-- Add provider retry backoff separately from the short refresh lease created in 0013.
ALTER TABLE hunt_completion_cache ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0;
INSERT OR REPLACE INTO schema_migrations (version) VALUES ('0014_hunt_completion_retry_after');
