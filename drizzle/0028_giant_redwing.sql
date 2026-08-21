-- NOTE ON THIS MIGRATION'S TIMESTAMP
--
-- This started life as 0027_fat_mongoose. Merging origin/main brought a
-- different 0027 (the van_* tables), so this one was regenerated as 0028 — with
-- a new `when` in _journal.json.
--
-- That broke re-running it. Drizzle decides what to apply with
-- `lastApplied.created_at < migration.when`, and the theme_tokens column had
-- ALREADY been applied under the old timestamp (1787210506934). The new, later
-- timestamp made it look unapplied, so migrate retried it and died on
-- "duplicate column name: theme_tokens" — which then blocked every migration
-- behind it.
--
-- `when` in _journal.json is therefore pinned back to 1787210506934. A database
-- that already ran this SQL skips it (equal, not less); one that hasn't still
-- applies it normally. Do not "fix" that number to the file's mtime.

ALTER TABLE `app_config` ADD `theme_tokens` text;
