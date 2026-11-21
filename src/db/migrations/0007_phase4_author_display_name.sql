-- ISF Platform — Phase 4 migration: add author_display_name to articles
-- Adds a free-text display name for the article author.
-- The existing author_id column (FK to users) is preserved for access control;
-- this column is only for human-readable attribution on public article pages.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS author_display_name TEXT;

-- No NOT NULL constraint: NULL means "use the linked user's display_name as fallback"
-- Backfill: leave existing rows as NULL; the service layer will fall back gracefully.
