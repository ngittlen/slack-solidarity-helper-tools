-- requests_email_unique is omitted: prod's `requests` table was created by the
-- old hand-written initDbSchema with inline `email TEXT UNIQUE`, which SQLite
-- implements via an auto-named index. Migration 0000 was baselined (never run),
-- so the named index drizzle-kit expects here doesn't exist. The inline UNIQUE
-- constraint still enforces uniqueness via sqlite_autoindex_requests_1.
DROP INDEX "slack_joins_slack_user_id_unique";--> statement-breakpoint
ALTER TABLE `slack_joins` ALTER COLUMN "joined_at" TO "joined_at" text;--> statement-breakpoint
CREATE UNIQUE INDEX `slack_joins_slack_user_id_unique` ON `slack_joins` (`slack_user_id`);